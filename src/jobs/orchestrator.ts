import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { Repository } from '../models/repository.js';
import { createAutoDSService, type AutoDSClient } from '../services/autods.js';
import { ClaudeService } from '../services/claude.js';
import { ShopifyService } from '../services/shopify.js';

const log = createLogger('orchestrator');

export interface OrchestratorDeps {
  config?: AppConfig;
  repo?: Repository;
  shopify?: ShopifyService;
  autods?: AutoDSClient;
  claude?: ClaudeService;
}

/**
 * Coordinates the end-to-end automation flows across Shopify, AutoDS and Claude.
 *
 * Honours the human-in-the-loop configuration (`autoPublish` / `autoFulfill`):
 * when disabled, AI content and fulfillment are staged for manual approval
 * rather than pushed automatically.
 */
export class Orchestrator {
  private readonly config: AppConfig;
  private readonly repo: Repository;
  private readonly shopify: ShopifyService;
  private readonly autods: AutoDSClient;
  private readonly claude: ClaudeService;

  constructor(deps: OrchestratorDeps = {}) {
    this.config = deps.config ?? loadConfig();
    this.repo = deps.repo ?? new Repository();
    this.shopify = deps.shopify ?? new ShopifyService(this.config);
    this.autods = deps.autods ?? createAutoDSService(this.config);
    this.claude =
      deps.claude ??
      new ClaudeService({ config: this.config, repo: this.repo });
  }

  /**
   * Source a product from AutoDS, generate content with Claude, and either
   * publish it to Shopify (auto mode) or stage it for review.
   */
  async importAndPublishProduct(autodsProductId: string): Promise<{
    autodsProductId: string;
    published: boolean;
    shopifyProductId?: string;
  }> {
    log.info({ autodsProductId }, 'Importing product');
    const product = await this.autods.getProduct(autodsProductId);
    const content = await this.claude.generateProductContent(product);

    if (!this.config.automation.autoPublish) {
      this.repo.upsertProductMapping({
        autodsProductId: product.id,
        autodsSku: product.sku ?? null,
        status: 'pending_review',
      });
      log.info(
        { autodsProductId },
        'Auto-publish disabled; product staged for review',
      );
      return { autodsProductId, published: false };
    }

    const created = await this.shopify.createProduct({
      title: content.title,
      bodyHtml: content.description,
      tags: content.tags,
      status: 'active',
      variants: [{ price: String(product.price), sku: product.sku }],
    });

    this.repo.upsertProductMapping({
      autodsProductId: product.id,
      autodsSku: product.sku ?? null,
      shopifyProductId: String(created.id),
      shopifyVariantId: created.variants?.[0]
        ? String(created.variants[0].id)
        : null,
      status: 'published',
    });

    log.info(
      { autodsProductId, shopifyProductId: created.id },
      'Product published to Shopify',
    );
    return {
      autodsProductId,
      published: true,
      shopifyProductId: String(created.id),
    };
  }

  /**
   * Handle a Shopify "order created" webhook payload: persist it and, when
   * auto-fulfill is enabled, forward it to AutoDS for fulfillment.
   */
  async handleOrderCreated(
    order: Record<string, unknown>,
  ): Promise<{ forwarded: boolean; autodsOrderId?: string }> {
    const shopifyOrderId = String(order.id);
    this.repo.upsertOrder({
      shopifyOrderId,
      fulfillmentStatus: 'received',
      rawPayload: order,
    });

    if (!this.config.automation.autoFulfill) {
      log.info(
        { shopifyOrderId },
        'Auto-fulfill disabled; order staged for review',
      );
      return { forwarded: false };
    }

    const lineItems = Array.isArray(order.line_items)
      ? (order.line_items as Array<Record<string, unknown>>)
      : [];

    const result = await this.autods.createOrder({
      shopifyOrderId,
      items: lineItems.map((item) => ({
        sku: String(item.sku ?? ''),
        quantity: Number(item.quantity ?? 1),
      })),
      shippingAddress:
        (order.shipping_address as Record<string, unknown>) ?? {},
    });

    this.repo.upsertOrder({
      shopifyOrderId,
      autodsOrderId: result.autodsOrderId,
      fulfillmentStatus: result.status,
      trackingNumber: result.trackingNumber ?? null,
    });

    log.info(
      { shopifyOrderId, autodsOrderId: result.autodsOrderId },
      'Order forwarded to AutoDS',
    );
    return { forwarded: true, autodsOrderId: result.autodsOrderId };
  }

  /**
   * Poll AutoDS for any pending orders and sync tracking numbers back to
   * Shopify once fulfilled.
   */
  async syncOrderTracking(): Promise<number> {
    const orders = this.repo
      .listOrders()
      .filter((o) => o.autods_order_id && o.fulfillment_status !== 'fulfilled');

    let updated = 0;
    for (const order of orders) {
      const status = await this.autods.getOrderStatus(
        order.autods_order_id as string,
      );
      if (status.trackingNumber) {
        await this.shopify.createFulfillment(order.shopify_order_id, {
          trackingNumber: status.trackingNumber,
        });
        this.repo.upsertOrder({
          shopifyOrderId: order.shopify_order_id,
          fulfillmentStatus: 'fulfilled',
          trackingNumber: status.trackingNumber,
        });
        updated += 1;
      }
    }
    log.info({ updated }, 'Synced order tracking');
    return updated;
  }
}
