import type {
  AutoDSClient,
  AutoDSOrderInput,
  AutoDSOrderResult,
  AutoDSProduct,
} from './autods.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('autods:mock');

/**
 * Sample catalogue served by the mock. Deterministic so tests and dry-runs
 * produce the same output every time. Prices are in the store's currency.
 */
export const MOCK_CATALOGUE: AutoDSProduct[] = [
  {
    id: 'mock-1001',
    title: 'Wireless Earbuds with Charging Case',
    description: 'Bluetooth 5.3 earbuds, 30h total battery, IPX5.',
    price: 29.99,
    sku: 'MOCK-EARBUDS-01',
    images: ['https://example.com/mock/earbuds.jpg'],
    stock: 120,
  },
  {
    id: 'mock-1002',
    title: 'Magnetic Phone Mount for Car',
    description: 'Vent-clip magnetic mount, 360° rotation.',
    price: 14.5,
    sku: 'MOCK-MOUNT-02',
    images: ['https://example.com/mock/mount.jpg'],
    stock: 340,
  },
  {
    id: 'mock-1003',
    title: 'LED Desk Lamp with USB Port',
    description: 'Dimmable, 3 colour temperatures, foldable arm.',
    price: 24.0,
    sku: 'MOCK-LAMP-03',
    images: ['https://example.com/mock/lamp.jpg'],
    stock: 0,
  },
];

interface MockOrder extends AutoDSOrderResult {
  input: AutoDSOrderInput;
  polls: number;
}

export interface MockAutoDSOptions {
  /** Products to serve. Defaults to {@link MOCK_CATALOGUE}. */
  catalogue?: AutoDSProduct[];
  /**
   * How many `getOrderStatus` polls an order needs before it reports
   * `shipped` with a tracking number. Simulates real fulfillment latency.
   * Default 1 (ships on the first poll after creation).
   */
  pollsUntilShipped?: number;
}

/**
 * In-memory stand-in for the real AutoDS API.
 *
 * Use it (via `AUTODS_MODE=mock`) to exercise the full source → publish →
 * fulfill → track pipeline before the real AutoDS API docs/credentials are
 * available. Nothing leaves the process; all state lives in this object.
 */
export class MockAutoDSService implements AutoDSClient {
  readonly mode = 'mock' as const;
  private readonly catalogue: Map<string, AutoDSProduct>;
  private readonly orders = new Map<string, MockOrder>();
  private readonly pollsUntilShipped: number;
  private orderSeq = 0;

  constructor(options: MockAutoDSOptions = {}) {
    this.catalogue = new Map(
      (options.catalogue ?? MOCK_CATALOGUE).map((p) => [p.id, { ...p }]),
    );
    this.pollsUntilShipped = Math.max(0, options.pollsUntilShipped ?? 1);
    log.warn('AutoDS is running in MOCK mode — no real orders will be placed');
  }

  async listProducts(limit = 50): Promise<AutoDSProduct[]> {
    return [...this.catalogue.values()].slice(0, limit);
  }

  async getProduct(productId: string): Promise<AutoDSProduct> {
    const product = this.catalogue.get(productId);
    if (!product) {
      throw new Error(`[mock autods] product not found: ${productId}`);
    }
    return { ...product };
  }

  async createOrder(input: AutoDSOrderInput): Promise<AutoDSOrderResult> {
    if (!input.items.length) {
      throw new Error('[mock autods] order has no items');
    }
    for (const item of input.items) {
      const product = [...this.catalogue.values()].find(
        (p) => p.sku === item.sku,
      );
      if (product && (product.stock ?? 0) < item.quantity) {
        throw new Error(
          `[mock autods] insufficient stock for ${item.sku}: have ${product.stock ?? 0}, need ${item.quantity}`,
        );
      }
    }
    this.orderSeq += 1;
    const autodsOrderId = `mock-order-${this.orderSeq}`;
    const order: MockOrder = {
      autodsOrderId,
      status: 'processing',
      input,
      polls: 0,
    };
    this.orders.set(autodsOrderId, order);
    log.info(
      { autodsOrderId, shopifyOrderId: input.shopifyOrderId },
      '[mock] order accepted',
    );
    return { autodsOrderId, status: order.status };
  }

  async getOrderStatus(autodsOrderId: string): Promise<AutoDSOrderResult> {
    const order = this.orders.get(autodsOrderId);
    if (!order) {
      throw new Error(`[mock autods] order not found: ${autodsOrderId}`);
    }
    order.polls += 1;
    if (order.status !== 'shipped' && order.polls >= this.pollsUntilShipped) {
      order.status = 'shipped';
      order.trackingNumber = `MOCKTRK${String(this.orderSeq).padStart(6, '0')}`;
    }
    return {
      autodsOrderId,
      status: order.status,
      trackingNumber: order.trackingNumber,
    };
  }

  /** Test/inspection helper: every order the mock has accepted. */
  listOrders(): AutoDSOrderResult[] {
    return [...this.orders.values()].map(({ input: _i, polls: _p, ...o }) => o);
  }
}
