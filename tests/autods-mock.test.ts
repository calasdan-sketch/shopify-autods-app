import { describe, expect, it } from 'vitest';
import {
  MockAutoDSService,
  MOCK_CATALOGUE,
} from '../src/services/autods-mock.js';
import { AutoDSService, createAutoDSService } from '../src/services/autods.js';
import { Orchestrator } from '../src/jobs/orchestrator.js';
import { createDatabase } from '../src/models/db.js';
import { Repository } from '../src/models/repository.js';
import { makeTestConfig } from './helpers.js';
import type { ShopifyService } from '../src/services/shopify.js';
import type { ClaudeService } from '../src/services/claude.js';

describe('MockAutoDSService', () => {
  it('serves the sample catalogue and single products', async () => {
    const mock = new MockAutoDSService();
    expect(mock.mode).toBe('mock');
    expect(await mock.listProducts()).toHaveLength(MOCK_CATALOGUE.length);
    expect(await mock.listProducts(1)).toHaveLength(1);
    const p = await mock.getProduct('mock-1001');
    expect(p.sku).toBe('MOCK-EARBUDS-01');
    await expect(mock.getProduct('nope')).rejects.toThrow(/not found/);
  });

  it('accepts an order and ships it after the configured number of polls', async () => {
    const mock = new MockAutoDSService({ pollsUntilShipped: 2 });
    const created = await mock.createOrder({
      shopifyOrderId: 'so-1',
      items: [{ sku: 'MOCK-EARBUDS-01', quantity: 1 }],
      shippingAddress: {},
    });
    expect(created.status).toBe('processing');

    const first = await mock.getOrderStatus(created.autodsOrderId);
    expect(first.status).toBe('processing');
    expect(first.trackingNumber).toBeUndefined();

    const second = await mock.getOrderStatus(created.autodsOrderId);
    expect(second.status).toBe('shipped');
    expect(second.trackingNumber).toMatch(/^MOCKTRK\d{6}$/);
    expect(mock.listOrders()).toHaveLength(1);
  });

  it('rejects empty orders and out-of-stock items', async () => {
    const mock = new MockAutoDSService();
    await expect(
      mock.createOrder({ shopifyOrderId: 'x', items: [], shippingAddress: {} }),
    ).rejects.toThrow(/no items/);
    await expect(
      mock.createOrder({
        shopifyOrderId: 'x',
        items: [{ sku: 'MOCK-LAMP-03', quantity: 1 }], // stock 0
        shippingAddress: {},
      }),
    ).rejects.toThrow(/insufficient stock/);
  });
});

describe('createAutoDSService', () => {
  it('returns the mock when AUTODS_MODE=mock and the live client otherwise', () => {
    const live = createAutoDSService(makeTestConfig());
    expect(live).toBeInstanceOf(AutoDSService);
    expect(live.mode).toBe('live');

    const mock = createAutoDSService(
      makeTestConfig({
        autods: { mode: 'mock', apiBase: '', apiToken: '', storeId: '' },
      }),
    );
    expect(mock).toBeInstanceOf(MockAutoDSService);
    expect(mock.mode).toBe('mock');
  });
});

describe('Orchestrator in mock mode', () => {
  it('runs source → publish → fulfill → track end-to-end with no AutoDS creds', async () => {
    const repo = new Repository(createDatabase(':memory:'));
    const config = makeTestConfig({
      autods: { mode: 'mock', apiBase: '', apiToken: '', storeId: '' },
      automation: {
        autoPublish: true,
        autoFulfill: true,
        syncCron: '* * * * *',
      },
    });
    const shopify = {
      createProduct: async () => ({
        id: 1,
        title: 't',
        handle: 't',
        status: 'active',
        variants: [{ id: 2, sku: 'MOCK-EARBUDS-01', price: '29.99' }],
      }),
      createFulfillment: async () => ({}),
    } as unknown as ShopifyService;
    const claude = {
      generateProductContent: async () => ({
        title: 't',
        description: 'd',
        bullets: [],
        tags: [],
      }),
    } as unknown as ClaudeService;

    // No `autods` passed in: the orchestrator must pick the mock from config.
    const orchestrator = new Orchestrator({ config, repo, shopify, claude });

    const imported = await orchestrator.importAndPublishProduct('mock-1001');
    expect(imported.published).toBe(true);

    const forwarded = await orchestrator.handleOrderCreated({
      id: 500,
      line_items: [{ sku: 'MOCK-EARBUDS-01', quantity: 1 }],
      shipping_address: {},
    });
    expect(forwarded.forwarded).toBe(true);
    expect(forwarded.autodsOrderId).toBe('mock-order-1');

    expect(await orchestrator.syncOrderTracking()).toBe(1);
    const [order] = repo.listOrders();
    expect(order.fulfillment_status).toBe('fulfilled');
    expect(order.tracking_number).toMatch(/^MOCKTRK/);
  });
});
