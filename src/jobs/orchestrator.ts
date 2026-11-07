import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { Repository } from '../models/repository.js';
import { createAutoDSService, type AutoDSClient } from '../services/autods.js';
import { ClaudeService } from '../services/claude.js';
import { cleanLine, sanitizeHtml } from '../lib/sanitize.js';
import { ExternalApiError } from '../lib/errors.js';
import { evaluateOrder } from '../services/order-gate.js';
import { computeSellPrice, meetsMarginFloor } from '../services/pricing.js';
import {
  NoOpenFulfillmentOrderError,
  ShopifyService,
} from '../services/shopify.js';
import type { GeneratedProductContent } from '../services/claude.js';

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

  /** Words in a supplier listing that need a human look (IP / restricted). */
  private blockedTermHits(text: string): string[] {
    const hay = text.toLowerCase();
    return this.config.compliance.blockedTerms.filter((t) =>
      new RegExp(
        `(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`,
      ).test(hay),
    );
  }

  /**
   * Source a product from AutoDS, generate content with Claude, price it from
   * cost, and either publish it to Shopify (auto mode) or stage it for review.
   *
   * Never lists a product that is out of stock, has an invalid cost, matches
   * a blocked term, or cannot reach the configured margin floor.
   */
  async importAndPublishProduct(autodsProductId: string): Promise<{
    autodsProductId: string;
    published: boolean;
    shopifyProductId?: string;
    sellPrice?: number;
    blocked?: string[];
  }> {
    log.info({ autodsProductId }, 'Importing product');
    const product = await this.autods.getProduct(autodsProductId);
    const blocked: string[] = [];

    if (typeof product.stock === 'number' && product.stock <= 0) {
      blocked.push('out of stock at supplier');
    }
    const hits = this.blockedTermHits(
      `${product.title} ${product.description ?? ''}`,
    );
    if (hits.length) {
      blocked.push(`blocked terms: ${hits.join(', ')}`);
    }
    let sellPrice: number | undefined;
    try {
      sellPrice = computeSellPrice(product.price, this.config.pricing);
      if (!meetsMarginFloor(sellPrice, product.price, this.config.pricing)) {
        blocked.push('cannot reach minimum margin');
      }
    } catch (error) {
      blocked.push(
        `pricing: ${String(error instanceof Error ? error.message : error)}`,
      );
    }

    if (blocked.length) {
      this.repo.upsertProductMapping({
        autodsProductId: product.id,
        autodsSku: product.sku ?? null,
        status: 'blocked',
        cost: Number.isFinite(product.price) ? product.price : null,
        stock: product.stock ?? null,
        notes: blocked.join('; '),
      });
      log.warn({ autodsProductId, blocked }, 'Product blocked from listing');
      return { autodsProductId, published: false, blocked };
    }

    const content = await this.claude.generateProductContent(product);
    const price = sellPrice as number;

    if (!this.config.automation.autoPublish) {
      this.repo.upsertProductMapping({
        autodsProductId: product.id,
        autodsSku: product.sku ?? null,
        status: 'pending_review',
        cost: product.price,
        sellPrice: price,
        stock: product.stock ?? null,
      });
      this.repo.insertAiContent({
        autodsProductId: product.id,
        contentType: 'staged_listing',
        content: JSON.stringify({
          content,
          cost: product.price,
          sellPrice: price,
          sku: product.sku ?? null,
        }),
        status: 'draft',
      });
      log.info(
        { autodsProductId },
        'Auto-publish disabled; product staged for review',
      );
      return { autodsProductId, published: false, sellPrice: price };
    }

    return this.publish(product.id, product.sku, product.price, price, content);
  }

  /**
   * Publish a previously staged product once a human has approved its
   * `staged_listing` content (POST /admin/ai-content/:id/approve).
   */
  async publishApproved(autodsProductId: string): Promise<{
    autodsProductId: string;
    published: boolean;
    shopifyProductId?: string;
    sellPrice?: number;
  }> {
    const mapping = this.repo.getProductMapping(autodsProductId);
    if (!mapping || mapping.status === 'blocked') {
      throw new Error('product is not staged for publishing');
    }
    if (mapping.status === 'published') {
      return {
        autodsProductId,
        published: true,
        shopifyProductId: mapping.shopify_product_id ?? undefined,
        sellPrice: mapping.sell_price ?? undefined,
      };
    }
    const staged = this.repo.findLatestAiContentForProduct(
      autodsProductId,
      'staged_listing',
    );
    if (!staged || staged.status !== 'approved') {
      throw new Error('staged listing has not been approved');
    }
    const parsed = JSON.parse(staged.content) as {
      content: GeneratedProductContent;
      cost: number;
      sellPrice: number;
      sku: string | null;
    };
    return this.publish(
      autodsProductId,
      parsed.sku ?? undefined,
      parsed.cost,
      parsed.sellPrice,
      parsed.content,
    );
  }

  private async publish(
    autodsProductId: string,
    sku: string | undefined,
    cost: number,
    sellPrice: number,
    content: GeneratedProductContent,
  ) {
    // LLM output derived from untrusted supplier text: sanitise before it
    // reaches a public storefront (Shopify limits: title 255, tag 255).
    const created = await this.shopify.createProduct({
      title: cleanLine(content.title, 255),
      bodyHtml: sanitizeHtml(content.description),
      tags: (content.tags ?? [])
        .map((t) => cleanLine(String(t).replace(/,/g, ' '), 255))
        .filter(Boolean)
        .slice(0, 250),
      status: 'active',
      variants: [{ price: sellPrice.toFixed(2), sku }],
    });

    this.repo.upsertProductMapping({
      autodsProductId,
      autodsSku: sku ?? null,
      shopifyProductId: String(created.id),
      shopifyVariantId: created.variants?.[0]
        ? String(created.variants[0].id)
        : null,
      status: 'published',
      cost,
      sellPrice,
    });

    log.info(
      { autodsProductId, shopifyProductId: created.id, sellPrice },
      'Product published to Shopify',
    );
    return {
      autodsProductId,
      published: true,
      shopifyProductId: String(created.id),
      sellPrice,
    };
  }

  /**
   * Persist an order-created webhook payload. Synchronous and idempotent: a
   * replayed webhook never changes an order that already exists. Call this
   * BEFORE acknowledging the webhook so nothing is lost if we crash after.
   */
  recordOrder(order: Record<string, unknown>): { id: string; isNew: boolean } {
    const shopifyOrderId = String(order.id);
    const email =
      typeof order.email === 'string' ? order.email.trim().toLowerCase() : null;
    const isNew = this.repo.insertOrderIfNew({
      shopifyOrderId,
      rawPayload: order,
      email,
    });
    return { id: shopifyOrderId, isNew };
  }

  /**
   * Handle a Shopify "order created" webhook payload: persist it and, when
   * auto-fulfill is enabled, run the risk gate and forward it to AutoDS.
   * Safe to call repeatedly for the same order (webhook retries/replays).
   */
  async handleOrderCreated(order: Record<string, unknown>): Promise<{
    forwarded: boolean;
    autodsOrderId?: string;
    held?: string[];
    duplicate?: boolean;
  }> {
    const { id, isNew } = this.recordOrder(order);
    if (!this.config.automation.autoFulfill) {
      log.info(
        { shopifyOrderId: id },
        'Auto-fulfill disabled; order staged for review',
      );
      return { forwarded: false, duplicate: !isNew };
    }
    const outcome = await this.forwardOrder(id, { skipGate: false });
    return isNew ? outcome : { ...outcome, duplicate: true };
  }

  /**
   * Forward one stored order to AutoDS exactly once. The `received` ->
   * `forwarding` transition is atomic, so concurrent or replayed calls cannot
   * both reach the supplier. An unknown outcome (timeout / 5xx) parks the
   * order in `needs_review` instead of retrying: a blind retry could buy the
   * same goods twice.
   */
  async forwardOrder(
    shopifyOrderId: string,
    opts: { skipGate: boolean },
  ): Promise<{ forwarded: boolean; autodsOrderId?: string; held?: string[] }> {
    const row = this.repo.getOrder(shopifyOrderId);
    if (!row?.raw_payload) return { forwarded: false };
    const order = JSON.parse(row.raw_payload) as Record<string, unknown>;

    if (!opts.skipGate) {
      const gate = evaluateOrder(order, this.config.risk, {
        recentOrdersForEmail: row.email
          ? this.repo.countRecentOrdersForEmail(row.email, shopifyOrderId)
          : 0,
      });
      if (!gate.allow) {
        if (
          this.repo.transitionOrder(
            shopifyOrderId,
            ['received'],
            'held',
            gate.reasons.join('; '),
          )
        ) {
          log.warn(
            { shopifyOrderId, reasons: gate.reasons },
            'Order held for review',
          );
        }
        return { forwarded: false, held: gate.reasons };
      }
    }

    // Claim: only one caller wins the right to talk to the supplier.
    const from = opts.skipGate
      ? ['received', 'held', 'forward_failed']
      : ['received'];
    if (!this.repo.transitionOrder(shopifyOrderId, from, 'forwarding')) {
      const cur = this.repo.getOrder(shopifyOrderId);
      return {
        forwarded: Boolean(cur?.autods_order_id),
        autodsOrderId: cur?.autods_order_id ?? undefined,
      };
    }

    const lineItems = Array.isArray(order.line_items)
      ? (order.line_items as Array<Record<string, unknown>>)
      : [];

    try {
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
    } catch (error) {
      const status = error instanceof ExternalApiError ? error.status : 0;
      const definiteReject = status >= 400 && status < 500;
      this.repo.transitionOrder(
        shopifyOrderId,
        ['forwarding'],
        definiteReject ? 'forward_failed' : 'needs_review',
        definiteReject
          ? `AutoDS rejected the order (HTTP ${status})`
          : 'AutoDS outcome unknown: check AutoDS for this order before releasing',
      );
      log.error({ shopifyOrderId, err: String(error) }, 'Forwarding failed');
      return { forwarded: false };
    }
  }

  /** Human override: forward a held/failed order, skipping the risk gate. */
  async releaseOrder(shopifyOrderId: string) {
    return this.forwardOrder(shopifyOrderId, { skipGate: true });
  }

  /** Crash recovery: re-run orders stuck in `received` (flag is on). */
  async processReceivedOrders(): Promise<number> {
    if (!this.config.automation.autoFulfill) return 0;
    let n = 0;
    for (const o of this.repo.listOrdersByStatus(['received'])) {
      const r = await this.forwardOrder(o.shopify_order_id, {
        skipGate: false,
      });
      if (r.forwarded) n += 1;
    }
    return n;
  }

  /**
   * Poll AutoDS for any pending orders and sync tracking numbers back to
   * Shopify once fulfilled. One failing order never blocks the rest.
   */
  async syncOrderTracking(): Promise<number> {
    const terminal = new Set([
      'fulfilled',
      'closed_in_shopify',
      'supplier_issue',
    ]);
    const orders = this.repo
      .listOrders()
      .filter((o) => o.autods_order_id && !terminal.has(o.fulfillment_status));

    let updated = 0;
    for (const order of orders) {
      try {
        const status = await this.autods.getOrderStatus(
          order.autods_order_id as string,
        );
        if (
          ['cancelled', 'canceled', 'failed', 'refunded'].includes(
            String(status.status).toLowerCase(),
          )
        ) {
          this.repo.upsertOrder({
            shopifyOrderId: order.shopify_order_id,
            fulfillmentStatus: 'supplier_issue',
          });
          this.repo.setOrderNotes(
            order.shopify_order_id,
            `Supplier reported "${status.status}"`,
          );
          continue;
        }
        if (!status.trackingNumber) continue;
        try {
          await this.shopify.createFulfillment(order.shopify_order_id, {
            trackingNumber: status.trackingNumber,
          });
          this.repo.upsertOrder({
            shopifyOrderId: order.shopify_order_id,
            fulfillmentStatus: 'fulfilled',
            trackingNumber: status.trackingNumber,
          });
          updated += 1;
        } catch (error) {
          if (!(error instanceof NoOpenFulfillmentOrderError)) throw error;
          this.repo.upsertOrder({
            shopifyOrderId: order.shopify_order_id,
            fulfillmentStatus: 'closed_in_shopify',
            trackingNumber: status.trackingNumber,
          });
          this.repo.setOrderNotes(
            order.shopify_order_id,
            'Shopify has no open fulfillment order (already shipped or cancelled)',
          );
        }
      } catch (error) {
        log.error(
          { shopifyOrderId: order.shopify_order_id, err: String(error) },
          'Tracking sync failed for order; continuing',
        );
      }
    }
    log.info({ updated }, 'Synced order tracking');
    return updated;
  }
}
