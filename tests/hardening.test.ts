import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/jobs/orchestrator.js';
import { adminAuth } from '../src/lib/admin-auth.js';
import { ExternalApiError } from '../src/lib/errors.js';
import { requestJson } from '../src/lib/http.js';
import { cleanLine, sanitizeHtml } from '../src/lib/sanitize.js';
import { createDatabase } from '../src/models/db.js';
import { Repository } from '../src/models/repository.js';
import { createWebhookRouter } from '../src/routes/webhooks.js';
import { evaluateOrder, type RiskConfig } from '../src/services/order-gate.js';
import {
  computeSellPrice,
  meetsMarginFloor,
  unitEconomics,
  type PricingConfig,
} from '../src/services/pricing.js';
import {
  NoOpenFulfillmentOrderError,
  ShopifyService,
} from '../src/services/shopify.js';
import { makeTestConfig } from './helpers.js';

const RISK: RiskConfig = {
  enabled: true,
  requirePaid: true,
  maxQuantityPerLine: 5,
  maxOrderValue: 500,
  allowedCountries: [],
  maxOrdersPerEmailPerDay: 3,
  maxOrderAgeDays: 7,
};
const goodOrder = (id: number | string = 1) => ({
  id,
  email: 'a@b.test',
  financial_status: 'paid',
  total_price: '40.00',
  line_items: [{ sku: 'S1', quantity: 1 }],
  shipping_address: {
    address1: '1 Main St',
    city: 'Winnipeg',
    zip: 'R3C 0A1',
    country_code: 'CA',
  },
});

describe('sanitize', () => {
  it('strips bidi, zero-width and control chars', () => {
    expect(cleanLine('a‮b​c\u0007d', 50)).toBe('abcd');
  });
  it('removes script/handlers/links but keeps formatting', () => {
    const out = sanitizeHtml(
      '<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:1">l</a><img src=x onerror=1><ul><li>ok</li></ul>',
    );
    expect(out).toBe('<p>Hi</p>l<ul><li>ok</li></ul>');
  });
  it('escapes stray angle brackets and survives huge input', () => {
    expect(sanitizeHtml('1 < 2 > 0')).toBe('1 &lt; 2 &gt; 0');
    const t = Date.now();
    sanitizeHtml('<'.repeat(200_000));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('pricing', () => {
  const p: PricingConfig = {
    targetMarginPct: 30,
    minMarginPct: 15,
    paymentFeePct: 3,
    paymentFixedFee: 0.3,
    charmPricing: false,
  };
  it('hits the target margin after fees (never sells at cost)', () => {
    const price = computeSellPrice(20, p);
    const e = unitEconomics(price, 20, p);
    expect(price).toBeGreaterThan(20);
    expect(e.marginPct).toBeGreaterThanOrEqual(29.9);
    expect(meetsMarginFloor(price, 20, p)).toBe(true);
    expect(meetsMarginFloor(20, 20, p)).toBe(false);
  });
  it('charm pricing never lowers the margin', () => {
    const c = { ...p, charmPricing: true };
    const price = computeSellPrice(20, c);
    expect(price % 1).toBeCloseTo(0.99, 2);
    expect(price).toBeGreaterThanOrEqual(computeSellPrice(20, p));
  });
  it('rejects bad inputs', () => {
    expect(() => computeSellPrice(0, p)).toThrow();
    expect(() => computeSellPrice(NaN, p)).toThrow();
    expect(() => computeSellPrice(5, { ...p, targetMarginPct: 98 })).toThrow();
  });
  it('break-even ad spend accounts for refunds', () => {
    const e = unitEconomics(40, 20, p, {
      adCostPerOrder: 5,
      refundRatePct: 10,
    });
    expect(e.breakEvenAdCostPerOrder).toBeLessThan(e.grossProfit);
    expect(e.netProfitAfterAdsAndRefunds).toBeLessThan(e.grossProfit);
  });
});

describe('order gate', () => {
  it('allows a clean paid order', () => {
    expect(evaluateOrder(goodOrder(), RISK).allow).toBe(true);
  });
  it.each([
    ['unpaid', { financial_status: 'pending' }],
    ['cancelled', { cancelled_at: '2026-01-01' }],
    ['test', { test: true }],
    ['no sku', { line_items: [{ quantity: 1 }] }],
    ['huge qty', { line_items: [{ sku: 'S', quantity: 999 }] }],
    ['neg qty', { line_items: [{ sku: 'S', quantity: -1 }] }],
    ['no address', { shipping_address: undefined }],
    ['high value', { total_price: '9999' }],
    ['country mismatch', { billing_address: { country_code: 'NG' } }],
  ])('holds: %s', (_n, patch) => {
    const r = evaluateOrder({ ...goodOrder(), ...patch }, RISK);
    expect(r.allow).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
  it('holds on velocity, country allow-list and age; fails closed on junk', () => {
    expect(
      evaluateOrder(goodOrder(), RISK, { recentOrdersForEmail: 3 }).allow,
    ).toBe(false);
    expect(
      evaluateOrder(goodOrder(), { ...RISK, allowedCountries: ['US'] }).allow,
    ).toBe(false);
    const old = { ...goodOrder(), created_at: '2020-01-01T00:00:00Z' };
    expect(evaluateOrder(old, RISK).allow).toBe(false);
    expect(
      evaluateOrder({ line_items: 'x', shipping_address: [] }, RISK).allow,
    ).toBe(false);
  });
});

function build(
  opts: {
    fulfill?: boolean;
    publish?: boolean;
    risk?: boolean;
    autods?: Record<string, unknown>;
    product?: Record<string, unknown>;
  } = {},
) {
  const repo = new Repository(createDatabase(':memory:'));
  const base = makeTestConfig();
  const config = {
    ...base,
    risk: { ...base.risk, enabled: opts.risk ?? true },
    automation: {
      ...base.automation,
      autoFulfill: opts.fulfill ?? true,
      autoPublish: opts.publish ?? false,
    },
  };
  const shopify = {
    createProduct: vi.fn().mockResolvedValue({ id: 9, variants: [{ id: 99 }] }),
    createFulfillment: vi.fn().mockResolvedValue({}),
  };
  const autods = {
    getProduct: vi.fn().mockResolvedValue({
      id: 'p1',
      title: 'Pen',
      price: 10,
      sku: 'S1',
      stock: 5,
      ...opts.product,
    }),
    createOrder: vi
      .fn()
      .mockResolvedValue({ autodsOrderId: 'A1', status: 'processing' }),
    getOrderStatus: vi.fn().mockResolvedValue({
      autodsOrderId: 'A1',
      status: 'shipped',
      trackingNumber: 'T1',
    }),
    ...opts.autods,
  };
  const claude = {
    generateProductContent: vi.fn().mockResolvedValue({
      title: 'Nice Pen‮',
      description: '<p>x</p><script>1</script>',
      bullets: [],
      tags: ['a,b'],
    }),
  };
  const orchestrator = new Orchestrator({
    config,
    repo,
    shopify: shopify as never,
    autods: autods as never,
    claude: claude as never,
  });
  return { orchestrator, repo, shopify, autods, claude };
}

describe('order idempotency and safety', () => {
  it('a replayed webhook forwards to the supplier exactly once', async () => {
    const { orchestrator, autods } = build();
    for (let i = 0; i < 5; i++)
      await orchestrator.handleOrderCreated(goodOrder(7));
    expect(autods.createOrder).toHaveBeenCalledTimes(1);
  });
  it('concurrent deliveries forward exactly once', async () => {
    const { orchestrator, autods } = build();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        orchestrator.handleOrderCreated(goodOrder(8)),
      ),
    );
    expect(autods.createOrder).toHaveBeenCalledTimes(1);
  });
  it('a replay never resets a fulfilled order', async () => {
    const { orchestrator, repo } = build();
    await orchestrator.handleOrderCreated(goodOrder(9));
    await orchestrator.syncOrderTracking();
    expect(repo.getOrder('9')?.fulfillment_status).toBe('fulfilled');
    await orchestrator.handleOrderCreated(goodOrder(9));
    expect(repo.getOrder('9')?.fulfillment_status).toBe('fulfilled');
  });
  it('holds an unpaid order and lets a human release it', async () => {
    const { orchestrator, repo, autods } = build();
    const r = await orchestrator.handleOrderCreated({
      ...goodOrder(10),
      financial_status: 'pending',
    });
    expect(r.forwarded).toBe(false);
    expect(repo.getOrder('10')?.fulfillment_status).toBe('held');
    expect(autods.createOrder).not.toHaveBeenCalled();
    const rel = await orchestrator.releaseOrder('10');
    expect(rel.forwarded).toBe(true);
    expect(autods.createOrder).toHaveBeenCalledTimes(1);
  });
  it('unknown outcome (5xx/timeout) parks the order instead of retrying', async () => {
    const { orchestrator, repo, autods } = build({
      autods: {
        createOrder: vi.fn().mockRejectedValue(new ExternalApiError('x', 503)),
      },
    });
    await orchestrator.handleOrderCreated(goodOrder(11));
    await orchestrator.handleOrderCreated(goodOrder(11));
    expect(repo.getOrder('11')?.fulfillment_status).toBe('needs_review');
    expect(autods.createOrder).toHaveBeenCalledTimes(1);
  });
  it('a definite 4xx rejection is marked forward_failed', async () => {
    const { orchestrator, repo } = build({
      autods: {
        createOrder: vi.fn().mockRejectedValue(new ExternalApiError('x', 422)),
      },
    });
    await orchestrator.handleOrderCreated(goodOrder(12));
    expect(repo.getOrder('12')?.fulfillment_status).toBe('forward_failed');
  });
  it('recovers orders stuck in received after a crash', async () => {
    const { orchestrator, repo, autods } = build();
    orchestrator.recordOrder(goodOrder(13));
    expect(repo.getOrder('13')?.fulfillment_status).toBe('received');
    expect(await orchestrator.processReceivedOrders()).toBe(1);
    expect(autods.createOrder).toHaveBeenCalledTimes(1);
  });
  it('one failing order does not block tracking sync for the rest', async () => {
    const { orchestrator, repo, shopify } = build();
    repo.upsertOrder({
      shopifyOrderId: 'a',
      autodsOrderId: 'A1',
      fulfillmentStatus: 'processing',
    });
    repo.upsertOrder({
      shopifyOrderId: 'b',
      autodsOrderId: 'A1',
      fulfillmentStatus: 'processing',
    });
    shopify.createFulfillment.mockRejectedValueOnce(new Error('boom'));
    expect(await orchestrator.syncOrderTracking()).toBe(1);
  });
  it('flags supplier cancellations and already-closed Shopify orders', async () => {
    const { orchestrator, repo, shopify, autods } = build();
    repo.upsertOrder({
      shopifyOrderId: 'c',
      autodsOrderId: 'A1',
      fulfillmentStatus: 'processing',
    });
    (autods.getOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      autodsOrderId: 'A1',
      status: 'cancelled',
    });
    await orchestrator.syncOrderTracking();
    expect(repo.getOrder('c')?.fulfillment_status).toBe('supplier_issue');
    repo.upsertOrder({
      shopifyOrderId: 'd',
      autodsOrderId: 'A1',
      fulfillmentStatus: 'processing',
    });
    shopify.createFulfillment.mockRejectedValueOnce(
      new NoOpenFulfillmentOrderError('none'),
    );
    await orchestrator.syncOrderTracking();
    expect(repo.getOrder('d')?.fulfillment_status).toBe('closed_in_shopify');
  });
});

describe('listing safety', () => {
  it('never lists a product at cost: price comes from the margin engine', async () => {
    const { orchestrator, shopify } = build({ publish: true });
    const r = await orchestrator.importAndPublishProduct('p1');
    expect(r.sellPrice).toBeGreaterThan(10);
    const arg = shopify.createProduct.mock.calls[0][0];
    expect(Number(arg.variants[0].price)).toBeGreaterThan(10);
    expect(arg.title).toBe('Nice Pen');
    expect(arg.bodyHtml).toBe('<p>x</p>');
    expect(arg.tags).toEqual(['a b']);
  });
  it.each([
    ['out of stock', { stock: 0 }],
    ['zero cost', { price: 0 }],
    ['blocked term', { title: 'Replica watch' }],
  ])('blocks: %s', async (_n, product) => {
    const { orchestrator, shopify, repo } = build({ publish: true, product });
    const r = await orchestrator.importAndPublishProduct('p1');
    expect(r.published).toBe(false);
    expect(r.blocked?.length).toBeGreaterThan(0);
    expect(shopify.createProduct).not.toHaveBeenCalled();
    expect(repo.getProductMapping('p1')?.status).toBe('blocked');
  });
  it('human-in-the-loop completes: stage -> approve -> publish', async () => {
    const { orchestrator, repo, shopify } = build({ publish: false });
    await orchestrator.importAndPublishProduct('p1');
    await expect(orchestrator.publishApproved('p1')).rejects.toThrow(
      /approved/,
    );
    const staged = repo.findLatestAiContentForProduct('p1', 'staged_listing');
    repo.updateAiContentStatus(staged!.id, 'approved');
    const r = await orchestrator.publishApproved('p1');
    expect(r.published).toBe(true);
    expect(shopify.createProduct).toHaveBeenCalledTimes(1);
    await orchestrator.publishApproved('p1');
    expect(shopify.createProduct).toHaveBeenCalledTimes(1);
  });
});

describe('http: non-idempotent calls', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('does not retry a POST after 5xx', async () => {
    const f = vi.fn().mockResolvedValue(new Response('e', { status: 502 }));
    vi.stubGlobal('fetch', f);
    await expect(
      requestJson('https://x.test', {
        method: 'POST',
        idempotent: false,
        baseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(ExternalApiError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('does not retry a POST after a network error', async () => {
    const f = vi.fn().mockRejectedValue(new Error('reset'));
    vi.stubGlobal('fetch', f);
    await expect(
      requestJson('https://x.test', {
        method: 'POST',
        idempotent: false,
        baseDelayMs: 1,
      }),
    ).rejects.toBeInstanceOf(ExternalApiError);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('still retries a POST on 429', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(new Response('{"ok":1}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    await requestJson('https://x.test', { method: 'POST', idempotent: false });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('caps a hostile Retry-After', async () => {
    vi.useFakeTimers();
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '999999' } }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    const p = requestJson('https://x.test');
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    vi.useRealTimers();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('shopify fulfillment orders', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('lists fulfillment orders then posts /fulfillments.json', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fulfillment_orders: [
              { id: 5, status: 'open' },
              { id: 6, status: 'closed' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ fulfillment: { id: 1 } }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', f);
    await new ShopifyService(makeTestConfig()).createFulfillment(1, {
      trackingNumber: 'T',
    });
    expect(String(f.mock.calls[0][0])).toContain(
      '/orders/1/fulfillment_orders.json',
    );
    expect(String(f.mock.calls[1][0])).toContain('/fulfillments.json');
    const body = JSON.parse(f.mock.calls[1][1].body);
    expect(body.fulfillment.line_items_by_fulfillment_order).toEqual([
      { fulfillment_order_id: 5 },
    ]);
  });
  it('throws a typed error when nothing is open', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"fulfillment_orders":[]}', { status: 200 }),
        ),
    );
    await expect(
      new ShopifyService(makeTestConfig()).createFulfillment(1, {}),
    ).rejects.toBeInstanceOf(NoOpenFulfillmentOrderError);
  });
});

describe('admin auth (fail closed)', () => {
  async function call(token: string, header?: string) {
    const app = express();
    app.use('/admin', adminAuth(token), (_q, r) => r.json({ ok: 1 }));
    const server = await new Promise<ReturnType<typeof app.listen>>((res) => {
      const s = app.listen(0, () => res(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
    const r = await fetch(url, {
      headers: header ? { authorization: header } : {},
    });
    server.close();
    return r.status;
  }
  it('refuses everything when no/short token is configured', async () => {
    expect(await call('')).toBe(503);
    expect(await call('short', 'Bearer short')).toBe(503);
  });
  it('rejects missing/wrong and accepts correct token', async () => {
    const t = 'x'.repeat(20);
    expect(await call(t)).toBe(401);
    expect(await call(t, 'Bearer wrong')).toBe(401);
    expect(await call(t, `Bearer ${t}`)).toBe(200);
  });
});

describe('webhook stores before acknowledging', () => {
  it('persists the order, 401s a bad signature, and survives replays', async () => {
    const { orchestrator, repo, autods } = build({ fulfill: false });
    const config = makeTestConfig();
    const app = express();
    app.use(
      '/w',
      createWebhookRouter(new ShopifyService(config), orchestrator),
    );
    const server = await new Promise<ReturnType<typeof app.listen>>((res) => {
      const s = app.listen(0, () => res(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/w/orders/create`;
    const body = JSON.stringify(goodOrder(77));
    const sig = createHmac('sha256', config.shopify.webhookSecret)
      .update(body)
      .digest('base64');
    const headers = {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sig,
    };
    expect(
      (
        await fetch(url, {
          method: 'POST',
          body,
          headers: { ...headers, 'x-shopify-hmac-sha256': 'bad' },
        })
      ).status,
    ).toBe(401);
    expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(
      200,
    );
    expect((await fetch(url, { method: 'POST', body, headers })).status).toBe(
      200,
    );
    server.close();
    expect(repo.listOrders()).toHaveLength(1);
    expect(autods.createOrder).not.toHaveBeenCalled();
  });
});

describe('migration', () => {
  it('upgrades a pre-existing database file without data loss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autods-mig-'));
    const file = join(dir, 'old.sqlite');
    const raw = new Database(file);
    raw.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shopify_order_id TEXT NOT NULL, autods_order_id TEXT, fulfillment_status TEXT NOT NULL DEFAULT 'pending', tracking_number TEXT, raw_payload TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (shopify_order_id));
      CREATE TABLE product_mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, autods_product_id TEXT NOT NULL, autods_sku TEXT, shopify_product_id TEXT, shopify_variant_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (autods_product_id));
      INSERT INTO orders (shopify_order_id) VALUES ('old');`);
    raw.close();
    const db = createDatabase(file);
    const again = createDatabase(file); // idempotent second run
    expect(
      db.prepare('SELECT shopify_order_id, notes, email FROM orders').get(),
    ).toEqual({
      shopify_order_id: 'old',
      notes: null,
      email: null,
    });
    expect(() =>
      again.exec('SELECT cost, sell_price, stock FROM product_mappings'),
    ).not.toThrow();
    db.close();
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
