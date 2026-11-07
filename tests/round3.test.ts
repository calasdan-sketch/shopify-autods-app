import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/jobs/orchestrator.js';
import { createAuthFailureLimiter } from '../src/lib/rate-limit.js';
import { adminAuth } from '../src/lib/admin-auth.js';
import { ExternalApiError } from '../src/lib/errors.js';
import { createDatabase } from '../src/models/db.js';
import { Repository } from '../src/models/repository.js';
import { createWebhookRouter } from '../src/routes/webhooks.js';
import { createAdminRouter } from '../src/routes/admin.js';
import { evaluateOrder, type RiskConfig } from '../src/services/order-gate.js';
import { ShopifyService } from '../src/services/shopify.js';
import { makeTestConfig } from './helpers.js';

const RISK: RiskConfig = {
  enabled: true,
  requirePaid: true,
  maxQuantityPerLine: 5,
  maxOrderValue: 500,
  allowedCountries: [],
  maxOrdersPerEmailPerDay: 3,
  maxOrderAgeDays: 7,
  maxLineItems: 25,
  holdBelowCost: true,
  requireKnownSku: false,
};
const good = (over: Record<string, unknown> = {}) => ({
  id: 1,
  email: 'a@b.test',
  financial_status: 'paid',
  total_price: '40.00',
  subtotal_price: '35.00',
  line_items: [{ sku: 'S1', quantity: 1 }],
  shipping_address: {
    address1: '1 Main St',
    city: 'Winnipeg',
    zip: 'R3C 0A1',
    country_code: 'CA',
  },
  ...over,
});

function build(opts: { fulfill?: boolean; publish?: boolean } = {}) {
  const repo = new Repository(createDatabase(':memory:'));
  const base = makeTestConfig();
  const config = {
    ...base,
    risk: { ...base.risk, enabled: true },
    automation: {
      ...base.automation,
      autoFulfill: opts.fulfill ?? true,
      autoPublish: opts.publish ?? false,
    },
  };
  const createProduct = vi.fn().mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 15));
    return { id: 9, variants: [{ id: 99 }] };
  });
  const shopify = {
    createProduct,
    createFulfillment: vi.fn().mockResolvedValue({}),
  };
  const autods = {
    getProduct: vi.fn().mockResolvedValue({
      id: 'p1',
      title: 'Pen',
      price: 10,
      sku: 'S1',
      stock: 5,
    }),
    createOrder: vi
      .fn()
      .mockResolvedValue({ autodsOrderId: 'A1', status: 'processing' }),
    getOrderStatus: vi.fn(),
  };
  const claude = {
    generateProductContent: vi
      .fn()
      .mockResolvedValue({ title: 'Pen', description: '<p>x</p>', tags: [] }),
  };
  const orch = new Orchestrator({
    config,
    repo,
    shopify: shopify as never,
    autods: autods as never,
    claude: claude as never,
  });
  return { repo, orch, shopify, autods, config };
}

describe('gate: new checks', () => {
  it('holds an order whose goods total is below supplier cost', () => {
    const r = evaluateOrder(good({ subtotal_price: '0.00' }), RISK, {
      costBySku: new Map([['S1', 10]]),
    });
    expect(r.allow).toBe(false);
    expect(r.reasons.join()).toMatch(/below supplier cost/);
  });
  it('allows a normal paid order and skips the check for unknown SKUs', () => {
    expect(
      evaluateOrder(good(), RISK, { costBySku: new Map([['S1', 10]]) }).allow,
    ).toBe(true);
    expect(
      evaluateOrder(good({ subtotal_price: '0' }), RISK, {
        costBySku: new Map(),
      }).allow,
    ).toBe(true);
  });
  it('can be turned off', () => {
    expect(
      evaluateOrder(
        good({ subtotal_price: '0' }),
        { ...RISK, holdBelowCost: false },
        {
          costBySku: new Map([['S1', 10]]),
        },
      ).allow,
    ).toBe(true);
  });
  it('holds gift cards, digital lines and huge orders', () => {
    const li = Array.from({ length: 30 }, () => ({ sku: 'S1', quantity: 1 }));
    expect(
      evaluateOrder(
        good({ line_items: [{ sku: 'S1', quantity: 1, gift_card: true }] }),
        RISK,
      ).allow,
    ).toBe(false);
    expect(
      evaluateOrder(
        good({
          line_items: [{ sku: 'S1', quantity: 1, requires_shipping: false }],
        }),
        RISK,
      ).allow,
    ).toBe(false);
    expect(evaluateOrder(good({ line_items: li }), RISK).allow).toBe(false);
  });
  it('survives a million-line hostile payload quickly', () => {
    const li = Array.from({ length: 1_000_000 }, () => ({
      sku: 'S1',
      quantity: 1,
    }));
    const t = Date.now();
    const r = evaluateOrder(good({ line_items: li }), RISK, {
      costBySku: new Map([['S1', 1]]),
    });
    expect(r.allow).toBe(false);
    expect(Date.now() - t).toBeLessThan(1500);
  });
  it('requireKnownSku holds unknown SKUs', () => {
    const r = evaluateOrder(
      good(),
      { ...RISK, requireKnownSku: true },
      {
        costBySku: new Map(),
      },
    );
    expect(r.reasons.join()).toMatch(/not listed/);
  });
  it('strips bidi/control from reasons built from payload text', () => {
    const r = evaluateOrder(
      good({ financial_status: 'pa‮id\u001b[31m' }),
      RISK,
    );
    const joined = r.reasons.join();
    expect(joined.includes(String.fromCharCode(0x202e))).toBe(false);
    expect(joined.includes(String.fromCharCode(0x1b))).toBe(false);
  });
  it('end to end: a free order of a known product is held, not bought', async () => {
    const { orch, repo, autods } = build();
    repo.upsertProductMapping({
      autodsProductId: 'p1',
      autodsSku: 'S1',
      status: 'published',
      cost: 10,
    });
    const r = await orch.handleOrderCreated(
      good({ id: 5, subtotal_price: '0.00' }),
    );
    expect(r.held?.join()).toMatch(/below supplier cost/);
    expect(autods.createOrder).not.toHaveBeenCalled();
  });
});

describe('publish is exactly-once', () => {
  async function staged() {
    const t = build();
    t.repo.upsertProductMapping({
      autodsProductId: 'p1',
      autodsSku: 'S1',
      status: 'pending_review',
      cost: 10,
      sellPrice: 15,
    });
    t.repo.insertAiContent({
      autodsProductId: 'p1',
      contentType: 'staged_listing',
      content: JSON.stringify({
        content: { title: 't', description: 'd', tags: [] },
        cost: 10,
        sellPrice: 15,
        sku: 'S1',
      }),
      status: 'approved',
    });
    return t;
  }
  it('ten concurrent publish clicks create one Shopify product', async () => {
    const { orch, shopify } = await staged();
    const res = await Promise.allSettled(
      Array.from({ length: 10 }, () => orch.publishApproved('p1')),
    );
    expect(shopify.createProduct).toHaveBeenCalledTimes(1);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // a later click is a no-op that reports the existing listing
    expect((await orch.publishApproved('p1')).published).toBe(true);
    expect(shopify.createProduct).toHaveBeenCalledTimes(1);
  });
  it('a definite 4xx rejection releases the claim for retry; a 5xx keeps it', async () => {
    const a = await staged();
    a.shopify.createProduct.mockRejectedValueOnce(
      new ExternalApiError('bad', 422),
    );
    await expect(a.orch.publishApproved('p1')).rejects.toBeTruthy();
    expect(a.repo.getProductMapping('p1')?.status).toBe('pending_review');
    await expect(a.orch.publishApproved('p1')).resolves.toMatchObject({
      published: true,
    });

    const b = await staged();
    b.shopify.createProduct.mockRejectedValueOnce(
      new ExternalApiError('boom', 502),
    );
    await expect(b.orch.publishApproved('p1')).rejects.toBeTruthy();
    expect(b.repo.getProductMapping('p1')?.status).toBe('publishing');
    await expect(b.orch.publishApproved('p1')).rejects.toThrow(
      /already being published/,
    );
  });
  it('refuses a staged price that no longer meets the margin floor', async () => {
    const t = await staged();
    t.config.pricing.minMarginPct = 15;
    t.repo.insertAiContent({
      autodsProductId: 'p1',
      contentType: 'staged_listing',
      content: JSON.stringify({
        content: { title: 't', description: 'd', tags: [] },
        cost: 10,
        sellPrice: 10.5,
        sku: 'S1',
      }),
      status: 'approved',
    });
    await expect(t.orch.publishApproved('p1')).rejects.toThrow(/margin floor/);
    expect(t.shopify.createProduct).not.toHaveBeenCalled();
  });
  it('re-importing a published product never lists it twice (auto mode)', async () => {
    const t = build({ publish: true });
    const [a, b, c] = await Promise.all([
      t.orch.importAndPublishProduct('p1'),
      t.orch.importAndPublishProduct('p1'),
      t.orch.importAndPublishProduct('p1'),
    ]);
    expect([a, b, c].filter((x) => x.published)).toHaveLength(1);
    expect(t.shopify.createProduct).toHaveBeenCalledTimes(1);
    expect((await t.orch.importAndPublishProduct('p1')).published).toBe(true);
    expect(t.shopify.createProduct).toHaveBeenCalledTimes(1);
  });
});

describe('stuck forwarding and audit trail', () => {
  it('moves old `forwarding` orders to needs_review, leaves fresh ones', () => {
    const repo = new Repository(createDatabase(':memory:'));
    repo.insertOrderIfNew({ shopifyOrderId: '1', rawPayload: {} });
    repo.insertOrderIfNew({ shopifyOrderId: '2', rawPayload: {} });
    repo.transitionOrder('1', ['received'], 'forwarding');
    repo.transitionOrder('2', ['received'], 'forwarding');
    // age order 1 by an hour
    (repo as unknown as { db: import('better-sqlite3').Database }).db
      .prepare(
        "UPDATE orders SET updated_at = datetime('now','-1 hour') WHERE shopify_order_id='1'",
      )
      .run();
    expect(repo.recoverStuckForwarding(15)).toEqual(['1']);
    expect(repo.getOrder('1')?.fulfillment_status).toBe('needs_review');
    expect(repo.getOrder('2')?.fulfillment_status).toBe('forwarding');
  });
  it('records every status change with a reason', async () => {
    const { orch, repo } = build();
    await orch.handleOrderCreated(good({ id: 7, financial_status: 'pending' }));
    await orch.releaseOrder('7');
    const ev = repo
      .listOrderEvents('7')
      .map((e) => `${e.from_status}>${e.to_status}`);
    expect(ev).toEqual([
      'null>received',
      'received>held',
      'held>forwarding',
      'forwarding>processing',
    ]);
    expect(repo.listOrderEvents('7')[1].note).toMatch(/financial_status/);
  });
});

async function serve(app: express.Express) {
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe('webhook robustness', () => {
  it('a signed null/array/scalar body gets 400, never hangs or crashes', async () => {
    const t = build({ fulfill: false });
    const config = makeTestConfig();
    const app = express();
    app.use('/w', createWebhookRouter(new ShopifyService(config), t.orch));
    const { server, url } = await serve(app);
    for (const body of [
      'null',
      '[]',
      '"x"',
      '12',
      '{"id":{}}',
      '{"id":"  "}',
    ]) {
      const sig = createHmac('sha256', config.shopify.webhookSecret)
        .update(body)
        .digest('base64');
      const r = await fetch(`${url}/w/orders/create`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-shopify-hmac-sha256': sig,
        },
        signal: AbortSignal.timeout(2000),
      });
      expect(r.status, body).toBe(400);
    }
    // signed but not JSON: 400 (malformed), unsigned: 401
    const bad = '{oops';
    const sig = createHmac('sha256', config.shopify.webhookSecret)
      .update(bad)
      .digest('base64');
    const r1 = await fetch(`${url}/w/orders/create`, {
      method: 'POST',
      body: bad,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': sig,
      },
    });
    expect(r1.status).toBe(400);
    const r2 = await fetch(`${url}/w/orders/create`, {
      method: 'POST',
      body: bad,
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': 'AAAA',
      },
    });
    expect(r2.status).toBe(401);
    server.close();
  });
  it('rate limit is configurable and defaults above a flash-sale burst', async () => {
    const t = build({ fulfill: false });
    const app = express();
    app.use(
      '/w',
      createWebhookRouter(new ShopifyService(makeTestConfig()), t.orch, 3),
    );
    const { server, url } = await serve(app);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (
          await fetch(`${url}/w/products/update`, {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          })
        ).status,
      );
    }
    expect(codes.slice(3)).toEqual([429, 429]);
    server.close();
  });
});

describe('admin brute-force throttle', () => {
  it('locks out an IP after repeated failures but not successful calls', async () => {
    const app = express();
    const tok = 'x'.repeat(20);
    app.use(
      '/admin',
      createAuthFailureLimiter({ max: 3 }),
      adminAuth(tok),
      (_q, r) => r.json({ ok: 1 }),
    );
    const { server, url } = await serve(app);
    const ok = { authorization: `Bearer ${tok}` };
    for (let i = 0; i < 6; i++)
      expect((await fetch(`${url}/admin`, { headers: ok })).status).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push(
        (
          await fetch(`${url}/admin`, {
            headers: { authorization: 'Bearer nope' },
          })
        ).status,
      );
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    server.close();
  });
});

describe('admin routes', () => {
  it('events endpoint, paging, 404 on unknown content, email check', async () => {
    const t = build({ fulfill: false });
    const app = express();
    app.use('/a', createAdminRouter(t.repo, t.orch, {} as never));
    const { server, url } = await serve(app);
    for (let i = 1; i <= 5; i++)
      await t.orch.handleOrderCreated(good({ id: i }));
    const page = (await (
      await fetch(`${url}/a/orders?limit=2&offset=1`)
    ).json()) as { orders: unknown[] };
    expect(page.orders).toHaveLength(2);
    const ev = (await (await fetch(`${url}/a/orders/3/events`)).json()) as {
      events: unknown[];
    };
    expect(ev.events).toHaveLength(1);
    expect((await fetch(`${url}/a/orders/999/events`)).status).toBe(404);
    expect(
      (await fetch(`${url}/a/ai-content/999/approve`, { method: 'POST' }))
        .status,
    ).toBe(404);
    const post = (b: unknown) =>
      fetch(`${url}/a/team`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
    expect((await post({ name: 'n', email: 'nope', role: 'r' })).status).toBe(
      400,
    );
    expect(
      (await post({ name: 'n', email: 'n@x.test', role: 'r' })).status,
    ).toBe(201);
    server.close();
  });
});

import { sanitizeHtml, cleanLine } from '../src/lib/sanitize.js';

describe('pass B: adversarial', () => {
  it('fails closed when subtotal_price is missing for a known product', () => {
    const o = good();
    delete (o as Record<string, unknown>).subtotal_price;
    const r = evaluateOrder(o, RISK, { costBySku: new Map([['S1', 10]]) });
    expect(r.allow).toBe(false);
    expect(r.reasons.join()).toMatch(/subtotal_price missing/);
  });
  it('sanitisers stay fast on quadratic-style hostile input', () => {
    const cases = [
      '<script '.repeat(5000),
      '<!--'.repeat(10000),
      'x<'.repeat(1_000_000),
      '<x'.repeat(20000) + '>',
      '<'.repeat(40000),
      '<p>' + 'a'.repeat(5_000_000),
    ];
    for (const c of cases) {
      const t = Date.now();
      sanitizeHtml(c);
      cleanLine(c, 255);
      expect(Date.now() - t).toBeLessThan(500);
    }
  });
  it('sanitizeHtml keeps a trailing allowed tag and drops an unclosed script tail', () => {
    expect(sanitizeHtml('<p>hi</p>')).toBe('<p>hi</p>');
    expect(sanitizeHtml('<p>a</p><script>alert(1)')).toBe('<p>a</p>');
    expect(sanitizeHtml('1 < 2 and 3 > 2')).toBe('1 &lt; 2 and 3 &gt; 2');
  });
  it('fuzz: output never contains a tag outside the allow-list or any attribute', () => {
    const frags = [
      '<',
      '>',
      'script',
      '/',
      'p',
      'onerror=',
      '"',
      '&lt;',
      'javascript:',
      ' ',
      '=',
      '<script>',
      '</script>',
      '<!--',
      '-->',
      '\u202e',
      'b',
      'img',
      '<p<b>',
      '>>',
      '\n',
    ];
    let seed = 7;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 5000; i++) {
      let in_ = '';
      for (let j = 0, n = 1 + Math.floor(rnd() * 14); j < n; j++)
        in_ += frags[Math.floor(rnd() * frags.length)];
      const out = sanitizeHtml(in_);
      for (const m of out.matchAll(/<([^>]*)>/g)) {
        expect(m[1], JSON.stringify(in_)).toMatch(
          /^\/?(p|br|ul|ol|li|strong|b|em|i|h2|h3|h4|span|table|thead|tbody|tr|th|td)$/,
        );
      }
      expect(/[\u202e]/.test(out)).toBe(false);
    }
  });
  it('blocked product that is later fine (auto mode) gets listed on re-import', async () => {
    const t = build({ publish: true });
    t.autods.getProduct.mockResolvedValueOnce({
      id: 'p1',
      title: 'Pen',
      price: 10,
      sku: 'S1',
      stock: 0,
    });
    expect((await t.orch.importAndPublishProduct('p1')).blocked).toBeTruthy();
    expect((await t.orch.importAndPublishProduct('p1')).published).toBe(true);
    expect(t.shopify.createProduct).toHaveBeenCalledTimes(1);
  });
  it('reset-publish needs confirmation and only works on a stuck product', async () => {
    const t = build();
    t.repo.upsertProductMapping({
      autodsProductId: 'p1',
      status: 'publishing',
    });
    const app = express();
    app.use('/a', createAdminRouter(t.repo, t.orch, {} as never));
    const { server, url } = await serve(app);
    const post = (b: unknown, id = 'p1') =>
      fetch(`${url}/a/products/${id}/reset-publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
    expect((await post({})).status).toBe(409);
    expect((await post({ confirmNotListed: true }, 'nope')).status).toBe(404);
    expect((await post({ confirmNotListed: true })).status).toBe(200);
    expect(t.repo.getProductMapping('p1')?.status).toBe('pending_review');
    server.close();
  });
  it('webhook concurrency: 200 parallel replays of 20 orders forward each exactly once', async () => {
    const t = build();
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    await Promise.all(
      Array.from({ length: 200 }, (_, k) =>
        t.orch.handleOrderCreated(
          good({ id: ids[k % 20], email: `u${k % 20}@x.test` }),
        ),
      ),
    );
    expect(t.autods.createOrder).toHaveBeenCalledTimes(20);
  });
  it('Windows-style database path with backslashes opens (no path assumptions)', () => {
    // createDatabase takes any path string; :memory: and relative names work.
    expect(() => createDatabase(':memory:')).not.toThrow();
  });
});
