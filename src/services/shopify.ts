import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { AppError, ConfigError } from '../lib/errors.js';
import { requestJson } from '../lib/http.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('shopify');

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** True for a plain `name.myshopify.com` host (no scheme, path or port). */
export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN.test(shop);
}

/** Nothing left to fulfil for this order in Shopify. */
export class NoOpenFulfillmentOrderError extends AppError {}

export interface ShopifyProductInput {
  title: string;
  bodyHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: 'active' | 'draft' | 'archived';
  variants?: Array<{
    price: string;
    sku?: string;
    inventoryQuantity?: number;
  }>;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  variants: Array<{ id: number; sku: string | null; price: string }>;
}

export interface ShopifyShop {
  id: number;
  name: string;
  email: string;
  domain: string;
  myshopifyDomain: string;
  currency: string;
  planName: string;
}

/**
 * Thin wrapper over the Shopify Admin REST API.
 *
 * Handles authentication, base-URL construction, retry/backoff (via the shared
 * HTTP helper) and webhook HMAC verification. Only the operations needed by the
 * automation flows are exposed.
 */
export class ShopifyService {
  private readonly config: AppConfig['shopify'];

  constructor(config: AppConfig = loadConfig()) {
    this.config = config.shopify;
  }

  private baseUrl(): string {
    if (!this.config.shop) {
      throw new ConfigError('SHOPIFY_SHOP is not configured');
    }
    // The access token is sent to this host, so it must be a Shopify host.
    if (!isValidShopDomain(this.config.shop)) {
      throw new ConfigError(
        'SHOPIFY_SHOP must look like my-store.myshopify.com (no https://, no path)',
      );
    }
    return `https://${this.config.shop}/admin/api/${this.config.apiVersion}`;
  }

  private headers(): Record<string, string> {
    if (!this.config.accessToken) {
      throw new ConfigError('SHOPIFY_ACCESS_TOKEN is not configured');
    }
    return {
      'X-Shopify-Access-Token': this.config.accessToken,
    };
  }

  /**
   * Verify the HMAC signature of an incoming Shopify webhook.
   *
   * @param rawBody The exact raw request body bytes (not re-serialised JSON).
   * @param hmacHeader The value of the `X-Shopify-Hmac-Sha256` header.
   */
  verifyWebhook(rawBody: Buffer | string, hmacHeader: string): boolean {
    if (!this.config.webhookSecret) {
      throw new ConfigError('SHOPIFY_WEBHOOK_SECRET is not configured');
    }
    if (!hmacHeader) {
      return false;
    }

    const digest = createHmac('sha256', this.config.webhookSecret)
      .update(rawBody)
      .digest('base64');

    const expected = Buffer.from(digest);
    const received = Buffer.from(hmacHeader);

    if (expected.length !== received.length) {
      return false;
    }
    return timingSafeEqual(expected, received);
  }

  /**
   * Cheap extra check: if Shopify names the shop in the request header and it
   * is not ours, refuse. A missing header is allowed (older senders).
   */
  isOwnShop(shopDomainHeader: string | undefined): boolean {
    if (!shopDomainHeader) return true;
    return (
      shopDomainHeader.trim().toLowerCase() === this.config.shop.toLowerCase()
    );
  }

  /**
   * Fetch the Shopify store (shop) details for display.
   */
  async getShop(): Promise<ShopifyShop> {
    log.info('Fetching Shopify shop details');
    const response = await requestJson<{
      shop: {
        id: number;
        name: string;
        email: string;
        domain: string;
        myshopify_domain: string;
        currency: string;
        plan_name: string;
      };
    }>(`${this.baseUrl()}/shop.json`, { headers: this.headers() });

    const { shop } = response;
    return {
      id: shop.id,
      name: shop.name,
      email: shop.email,
      domain: shop.domain,
      myshopifyDomain: shop.myshopify_domain,
      currency: shop.currency,
      planName: shop.plan_name,
    };
  }

  async createProduct(input: ShopifyProductInput): Promise<ShopifyProduct> {
    const payload = {
      product: {
        title: input.title,
        body_html: input.bodyHtml,
        vendor: input.vendor,
        product_type: input.productType,
        tags: input.tags?.join(', '),
        status: input.status ?? 'draft',
        variants: input.variants?.map((v) => ({
          price: v.price,
          sku: v.sku,
          inventory_quantity: v.inventoryQuantity,
        })),
      },
    };

    log.info({ title: input.title }, 'Creating Shopify product');
    const response = await requestJson<{ product: ShopifyProduct }>(
      `${this.baseUrl()}/products.json`,
      {
        method: 'POST',
        headers: this.headers(),
        body: payload,
        // A timed-out create may have succeeded; repeating would list twice.
        idempotent: false,
      },
    );
    return response.product;
  }

  async updateProduct(
    productId: string | number,
    input: Partial<ShopifyProductInput>,
  ): Promise<ShopifyProduct> {
    const payload = {
      product: {
        id: productId,
        title: input.title,
        body_html: input.bodyHtml,
        tags: input.tags?.join(', '),
        status: input.status,
      },
    };

    log.info({ productId }, 'Updating Shopify product');
    const response = await requestJson<{ product: ShopifyProduct }>(
      `${this.baseUrl()}/products/${productId}.json`,
      { method: 'PUT', headers: this.headers(), body: payload },
    );
    return response.product;
  }

  async updateInventory(
    inventoryItemId: string | number,
    locationId: string | number,
    available: number,
  ): Promise<void> {
    log.info({ inventoryItemId, available }, 'Updating inventory level');
    await requestJson(`${this.baseUrl()}/inventory_levels/set.json`, {
      method: 'POST',
      headers: this.headers(),
      body: {
        inventory_item_id: inventoryItemId,
        location_id: locationId,
        available,
      },
    });
  }

  async getOrder(orderId: string | number): Promise<Record<string, unknown>> {
    const response = await requestJson<{ order: Record<string, unknown> }>(
      `${this.baseUrl()}/orders/${orderId}.json`,
      { headers: this.headers() },
    );
    return response.order;
  }

  /**
   * Mark an order shipped with tracking.
   *
   * Uses the FulfillmentOrder flow (list the order's fulfillment orders, then
   * POST /fulfillments.json) because the older
   * POST /orders/{id}/fulfillments.json endpoint was retired in newer Admin
   * API versions. UNVERIFIED against a live store: no store calls were made
   * when this was written; test on a development store first.
   *
   * Throws {@link NoOpenFulfillmentOrderError} when nothing is left to
   * fulfil (already shipped, cancelled, or handled elsewhere).
   */
  async createFulfillment(
    orderId: string | number,
    input: {
      trackingNumber?: string;
      trackingCompany?: string;
      notifyCustomer?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    log.info({ orderId }, 'Creating fulfillment');
    const fo = await requestJson<{
      fulfillment_orders: Array<{ id: number; status: string }>;
    }>(`${this.baseUrl()}/orders/${orderId}/fulfillment_orders.json`, {
      headers: this.headers(),
    });
    const open = (fo.fulfillment_orders ?? []).filter(
      (f) => f.status === 'open' || f.status === 'in_progress',
    );
    if (open.length === 0) {
      throw new NoOpenFulfillmentOrderError(
        `Order ${orderId} has no open fulfillment orders`,
      );
    }
    const response = await requestJson<{
      fulfillment: Record<string, unknown>;
    }>(`${this.baseUrl()}/fulfillments.json`, {
      method: 'POST',
      headers: this.headers(),
      idempotent: false,
      body: {
        fulfillment: {
          line_items_by_fulfillment_order: open.map((f) => ({
            fulfillment_order_id: f.id,
          })),
          notify_customer: input.notifyCustomer ?? true,
          tracking_info: {
            number: input.trackingNumber,
            company: input.trackingCompany,
          },
        },
      },
    });
    return response.fulfillment;
  }
}
