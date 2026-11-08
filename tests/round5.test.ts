import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createApp, jsonErrorHandler } from '../src/app.js';
import { Orchestrator } from '../src/jobs/orchestrator.js';
import { adminAuth } from '../src/lib/admin-auth.js';
import { cleanLine, sanitizeHtml } from '../src/lib/sanitize.js';
import { createDatabase } from '../src/models/db.js';
import { Repository } from '../src/models/repository.js';
import { createAdminRouter } from '../src/routes/admin.js';
import { createWebhookRouter } from '../src/routes/webhooks.js';
import { AutoDSService } from '../src/services/autods.js';
import { computeSellPrice, meetsMarginFloor } from '../src/services/pricing.js';
import { ShopifyService, isValidShopDomain } from '../src/services/shopify.js';
import { makeTestConfig } from './helpers.js';

const read = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** Small seeded generator so property tests are repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('author, licence and version pins', () => {
  const pkg = JSON.parse(read('package.json'));
  it('names Calas Automations Inc. as author and copyright holder', () => {
    expect(pkg.author).toBe('Calas Automations Inc.');
    expect(read('LICENSE')).toContain(
      'Copyright (c) 2026 Calas Automations Inc.',
    );
    expect(pkg.license).toBe('MIT');
  });
  it('is private (an app, not a library) and ships only the listed files', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.files).toEqual(
      expect.arrayContaining(['dist', 'LICENSE', 'README.md']),
    );
    expect(pkg.files).not.toContain('tests');
  });
  it('keeps one version everywhere', () => {
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    expect(read('CHANGELOG.md')).toContain(`## ${pkg.version}`);
  });
  it('has no stale author/owner labels or false "Python" stack claim', () => {
    expect(read('CLAUDE.md')).not.toMatch(/Python/);
    expect(read('CLAUDE.md')).toContain('Calas Automations Inc.');
    expect(read('README.md')).not.toMatch(
      /\|\s*`calasdan-sketch\/[^`]+`\s*\|\s*Public/,
    );
  });
});

describe('README quick start', () => {
  it('npm run dry-run ends with PASS and exit code 0', () => {
    const tsx = fileURLToPath(
      new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
    );
    const r = spawnSync(process.execPath, [tsx, 'src/dry-run.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env, LOG_LEVEL: 'silent', NODE_ENV: 'test' },
    });
    expect(r.stdout).toContain('[dry-run] PASS');
    expect(r.status).toBe(0);
  }, 100_000);
});

describe('shop domain and supplier URL checks', () => {
  it('accepts only plain myshopify.com hosts', () => {
    expect(isValidShopDomain('my-store.myshopify.com')).toBe(true);
    for (const bad of [
      '',
      'evil.com',
      'my-store.myshopify.com.evil.com',
      'https://my-store.myshopify.com',
      'my-store.myshopify.com/x',
      'my-store.myshopify.com:8080',
      'a@my-store.myshopify.com',
      'my store.myshopify.com',
      '-x.myshopify.com',
      'x.myshopify.com\n',
      'x.myshopify.com#',
    ]) {
      expect(isValidShopDomain(bad), JSON.stringify(bad)).toBe(false);
    }
  });
  it('never sends the token to a bad SHOPIFY_SHOP', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    const base = makeTestConfig();
    const svc = new ShopifyService({
      ...base,
      shopify: { ...base.shopify, shop: 'evil.com/#' },
    });
    await expect(svc.getShop()).rejects.toThrow(/SHOPIFY_SHOP must look like/);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
  it('refuses a plain-http AutoDS base', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    const base = makeTestConfig();
    const svc = new AutoDSService({
      ...base,
      autods: { ...base.autods, apiBase: 'http://api.example.test' },
    });
    await expect(svc.getProduct('x')).rejects.toThrow(/https/);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
  it('checks the shop header only when present', () => {
    const svc = new ShopifyService(makeTestConfig());
    expect(svc.isOwnShop(undefined)).toBe(true);
    expect(svc.isOwnShop('TEST.myshopify.com')).toBe(true);
    expect(svc.isOwnShop('other.myshopify.com')).toBe(false);
  });
});

describe('admin auth and error shape', () => {
  async function serve(app: express.Express) {
    const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
      const s = app.listen(0, () => r(s));
    });
    return {
      server,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
  }
  it('requires the Bearer scheme, not just the token text', async () => {
    const app = express();
    app.use(adminAuth('0123456789abcdef'), (_q, r) => r.json({ ok: 1 }));
    const { server, url } = await serve(app);
    const call = (h?: string) =>
      fetch(url, { headers: h ? { authorization: h } : {} });
    expect((await call('0123456789abcdef')).status).toBe(401);
    expect((await call('Basic 0123456789abcdef')).status).toBe(401);
    expect((await call('Bearer')).status).toBe(401);
    expect((await call('bearer 0123456789abcdef')).status).toBe(200);
    expect((await call('Bearer  0123456789abcdef ')).status).toBe(200);
    server.close();
  });
  it('answers bad JSON and oversized bodies with short JSON, no stack', async () => {
    const app = express();
    app.use(express.json({ limit: '10b' }));
    app.post('/x', (_q, r) => r.json({ ok: 1 }));
    app.use(jsonErrorHandler);
    const { server, url } = await serve(app);
    const bad = await fetch(`${url}/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad request' });
    const big = await fetch(`${url}/x`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 'x'.repeat(100) }),
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'payload too large' });
    server.close();
  });
  it('real app: hides Express, sets nosniff/no-store', async () => {
    const { server, url } = await serve(createApp());
    const r = await fetch(`${url}/health`);
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');
    server.close();
  });
  it('real app: unknown path is JSON 404', async () => {
    const { server, url } = await serve(createApp());
    const r = await fetch(`${url}/nope`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not found' });
    server.close();
  });
});

function setup() {
  const repo = new Repository(createDatabase(':memory:'));
  const config = makeTestConfig();
  const autods = {
    getProduct: vi.fn(),
    createOrder: vi
      .fn()
      .mockResolvedValue({ autodsOrderId: 'A1', status: 'processing' }),
    getOrderStatus: vi.fn(),
  };
  const orch = new Orchestrator({
    config: {
      ...config,
      automation: { ...config.automation, autoFulfill: false },
    },
    repo,
    shopify: {} as never,
    autods: autods as never,
    claude: {} as never,
  });
  return { repo, orch, config, autods };
}

const order = (id: number, email: string) => ({
  id,
  email,
  phone: '+1 204 555 0100',
  note: 'leave with neighbour Zed',
  currency: 'CAD',
  subtotal_price: '35.00',
  total_price: '40.00',
  customer: { first_name: 'Quentin', last_name: 'Zzyzx', email },
  shipping_address: {
    name: 'Quentin Zzyzx',
    address1: '9 Hidden Lane',
    city: 'Winnipeg',
  },
  line_items: [
    { sku: 'S1', quantity: 2, price: '17.50', title: 'Quentin special' },
  ],
});
const PII = ['Quentin', 'Zzyzx', 'Hidden Lane', '555 0100', 'neighbour'];

describe('privacy: erase, export, retention', () => {
  it('scrubs customer data, keeps money and SKU, and is idempotent', () => {
    const { repo } = setup();
    repo.insertOrderIfNew({
      shopifyOrderId: '1',
      rawPayload: order(1, 'q@x.test'),
      email: 'q@x.test',
    });
    repo.insertOrderIfNew({
      shopifyOrderId: '2',
      rawPayload: order(2, 'other@x.test'),
      email: 'other@x.test',
    });
    expect(repo.scrubOrders({ email: 'Q@X.test' })).toEqual(['1']);
    const row = repo.getOrder('1')!;
    for (const w of PII) expect(row.raw_payload).not.toContain(w);
    expect(row.email).toBeNull();
    expect(JSON.parse(row.raw_payload!)).toMatchObject({
      id: '1',
      scrubbed: true,
      total_price: '40.00',
      line_items: [{ sku: 'S1', quantity: 2 }],
    });
    expect(repo.getOrder('2')!.raw_payload).toContain('Hidden Lane');
    expect(repo.scrubOrders({ email: 'q@x.test' })).toEqual([]);
  });

  it('parks an erased, not-yet-sent order and refuses to ship it', async () => {
    const { repo, orch, autods } = setup();
    repo.insertOrderIfNew({
      shopifyOrderId: '1',
      rawPayload: order(1, 'q@x.test'),
      email: 'q@x.test',
    });
    repo.scrubOrders({ email: 'q@x.test' });
    expect(repo.getOrder('1')!.fulfillment_status).toBe('needs_review');
    await orch.releaseOrder('1');
    expect(autods.createOrder).not.toHaveBeenCalled();
  });

  it('never ships a scrubbed order even if forced back to held', async () => {
    const { repo, orch, autods } = setup();
    repo.insertOrderIfNew({
      shopifyOrderId: '1',
      rawPayload: order(1, 'q@x.test'),
      email: 'q@x.test',
    });
    repo.scrubOrders({ email: 'q@x.test' });
    repo.transitionOrder('1', ['needs_review'], 'held');
    await orch.releaseOrder('1');
    expect(autods.createOrder).not.toHaveBeenCalled();
    expect(repo.getOrder('1')!.fulfillment_status).toBe('held');
  });

  it('retention only touches old orders', () => {
    const { repo } = setup();
    repo.insertOrderIfNew({
      shopifyOrderId: '1',
      rawPayload: order(1, 'a@x.test'),
      email: 'a@x.test',
    });
    repo.insertOrderIfNew({
      shopifyOrderId: '2',
      rawPayload: order(2, 'b@x.test'),
      email: 'b@x.test',
    });
    repo['db']
      .prepare(
        "UPDATE orders SET created_at = datetime('now','-400 days') WHERE shopify_order_id='1'",
      )
      .run();
    expect(repo.scrubOrders({ all: true, olderThanDays: 365 })).toEqual(['1']);
    expect(repo.getOrder('2')!.email).toBe('b@x.test');
  });

  it('privacy log keeps a hash, never the email', () => {
    const { repo } = setup();
    repo.logPrivacyRequest({ kind: 'customer_redact', subject: 'Q@X.test' });
    const rows = repo.listPrivacyRequests();
    expect(JSON.stringify(rows)).not.toContain('x.test');
    expect(String(rows[0].subject_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('property: random payloads never leak seeded personal strings after a scrub', () => {
    const { repo } = setup();
    const r = rng(42);
    for (let i = 1; i <= 150; i++) {
      const o: Record<string, unknown> = order(i, `u${i}@x.test`);
      if (r() < 0.3) o.line_items = 'not-an-array';
      if (r() < 0.2) o.customer = null;
      if (r() < 0.1) o.shipping_address = ['Hidden Lane'];
      repo.insertOrderIfNew({
        shopifyOrderId: String(i),
        rawPayload: o,
        email: `u${i}@x.test`,
      });
    }
    repo['db']
      .prepare(
        "UPDATE orders SET raw_payload = '{broken' WHERE shopify_order_id = '7'",
      )
      .run();
    expect(repo.scrubOrders({ all: true })).toHaveLength(150);
    for (const o of repo.listOrders()) {
      for (const w of PII) expect(o.raw_payload ?? '').not.toContain(w);
      expect(o.email).toBeNull();
    }
  });
});

describe('webhooks: cancel + mandatory privacy topics', () => {
  async function app(secret = makeTestConfig().shopify.webhookSecret) {
    const t = setup();
    const a = express();
    a.use(
      '/w',
      createWebhookRouter(new ShopifyService(t.config), t.orch, 100, t.repo),
    );
    const server = await new Promise<ReturnType<typeof a.listen>>((r) => {
      const s = a.listen(0, () => r(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (
      path: string,
      body: unknown,
      extra: Record<string, string> = {},
    ) => {
      const text = JSON.stringify(body);
      return fetch(`${url}/w${path}`, {
        method: 'POST',
        body: text,
        headers: {
          'content-type': 'application/json',
          'x-shopify-hmac-sha256': createHmac('sha256', secret)
            .update(text)
            .digest('base64'),
          ...extra,
        },
      });
    };
    return { ...t, server, post, url };
  }

  it('rejects unsigned privacy and cancel calls, and other shops', async () => {
    const t = await app();
    for (const p of [
      '/orders/cancelled',
      '/customers/redact',
      '/customers/data_request',
      '/shop/redact',
    ]) {
      const r = await fetch(`${t.url}/w${p}`, {
        method: 'POST',
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'x-shopify-hmac-sha256': 'AAAA',
        },
      });
      expect(r.status, p).toBe(401);
    }
    const wrong = await t.post(
      '/customers/redact',
      { customer: { email: 'q@x.test' } },
      { 'x-shopify-shop-domain': 'evil.myshopify.com' },
    );
    expect(wrong.status).toBe(401);
    t.server.close();
  });

  it('customers/redact scrubs that customer only and logs a hash', async () => {
    const t = await app();
    t.repo.insertOrderIfNew({
      shopifyOrderId: '1',
      rawPayload: order(1, 'q@x.test'),
      email: 'q@x.test',
    });
    t.repo.insertOrderIfNew({
      shopifyOrderId: '2',
      rawPayload: order(2, 'o@x.test'),
      email: 'o@x.test',
    });
    const r = await t.post('/customers/redact', {
      shop_domain: 'test.myshopify.com',
      customer: { email: 'Q@x.test' },
      orders_to_redact: [],
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ scrubbed: 1 });
    expect(t.repo.getOrder('1')!.email).toBeNull();
    expect(t.repo.getOrder('2')!.email).toBe('o@x.test');
    expect(JSON.stringify(t.repo.listPrivacyRequests())).not.toContain(
      'q@x.test',
    );
    t.server.close();
  });

  it('shop/redact scrubs everything; data_request is logged for the owner', async () => {
    const t = await app();
    t.repo.insertOrderIfNew({
      shopifyOrderId: '1',
      rawPayload: order(1, 'q@x.test'),
      email: 'q@x.test',
    });
    expect(
      (
        await t.post('/customers/data_request', {
          customer: { email: 'q@x.test' },
        })
      ).status,
    ).toBe(200);
    expect(t.repo.listPrivacyRequests()[0].kind).toBe('data_request');
    expect(t.repo.getOrder('1')!.email).toBe('q@x.test');
    expect(
      (await t.post('/shop/redact', { shop_domain: 'test.myshopify.com' }))
        .status,
    ).toBe(200);
    expect(t.repo.getOrder('1')!.email).toBeNull();
    t.server.close();
  });

  it('orders/cancelled closes an unsent order; a late create cannot revive it', async () => {
    const t = await app();
    t.repo.insertOrderIfNew({
      shopifyOrderId: '5',
      rawPayload: order(5, 'a@x.test'),
      email: 'a@x.test',
    });
    const r = await t.post('/orders/cancelled', { id: 5 });
    expect(await r.json()).toMatchObject({ action: 'closed' });
    expect(t.repo.getOrder('5')!.fulfillment_status).toBe(
      'cancelled_by_customer',
    );
    await t.orch.forwardOrder('5', { skipGate: false });
    expect(t.autods.createOrder).not.toHaveBeenCalled();
    // cancelled before we ever saw the create webhook
    await t.post('/orders/cancelled', { id: 6 });
    await t.orch.handleOrderCreated(order(6, 'a@x.test'));
    expect(t.repo.getOrder('6')!.fulfillment_status).toBe(
      'cancelled_by_customer',
    );
    expect(t.autods.createOrder).not.toHaveBeenCalled();
    t.server.close();
  });

  it('orders/cancelled after the supplier order flags it for a human', async () => {
    const t = await app();
    t.repo.insertOrderIfNew({
      shopifyOrderId: '8',
      rawPayload: order(8, 'a@x.test'),
      email: 'a@x.test',
    });
    await t.orch.forwardOrder('8', { skipGate: true });
    expect(t.repo.getOrder('8')!.autods_order_id).toBe('A1');
    const r = await t.post('/orders/cancelled', { id: 8 });
    expect(await r.json()).toMatchObject({ action: 'needs_supplier_cancel' });
    const row = t.repo.getOrder('8')!;
    expect(row.fulfillment_status).toBe('supplier_issue');
    expect(row.notes).toMatch(/cancel it at AutoDS/);
    expect(
      await (await t.post('/orders/cancelled', { id: 8 })).json(),
    ).toMatchObject({ action: 'ignored' });
    expect((await t.post('/orders/cancelled', { nope: 1 })).status).toBe(400);
    t.server.close();
  });
});

describe('admin privacy endpoints', () => {
  async function adm() {
    const t = setup();
    const a = express();
    a.use('/admin', createAdminRouter(t.repo, t.orch, {} as never));
    a.use(jsonErrorHandler);
    const server = await new Promise<ReturnType<typeof a.listen>>((r) => {
      const s = a.listen(0, () => r(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin`;
    return { ...t, server, url };
  }
  it('export, erase and purge validate input and work', async () => {
    const t = await adm();
    t.repo.insertOrderIfNew({
      shopifyOrderId: '1',
      rawPayload: order(1, 'q@x.test'),
      email: 'q@x.test',
    });
    expect((await fetch(`${t.url}/privacy/export`)).status).toBe(400);
    const ex = (await (
      await fetch(`${t.url}/privacy/export?email=Q@x.test`)
    ).json()) as {
      orders: Array<{ raw_payload: { shipping_address: { city: string } } }>;
    };
    expect(ex.orders).toHaveLength(1);
    expect(ex.orders[0].raw_payload.shipping_address.city).toBe('Winnipeg');
    const post = (p: string, b: unknown) =>
      fetch(`${t.url}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
    expect((await post('/privacy/erase', { email: 'nope' })).status).toBe(400);
    expect((await post('/privacy/purge', { olderThanDays: 3 })).status).toBe(
      400,
    );
    expect((await post('/privacy/purge', { olderThanDays: '90' })).status).toBe(
      400,
    );
    expect(
      await (await post('/privacy/erase', { email: 'q@x.test' })).json(),
    ).toEqual({ scrubbed: 1 });
    expect(
      (
        (await (await fetch(`${t.url}/privacy/requests`)).json()) as {
          requests: Array<{ kind: string }>;
        }
      ).requests.map((r: { kind: string }) => r.kind),
    ).toEqual(['admin_erase', 'admin_export']);
    t.server.close();
  });
});

/* eslint-disable no-control-regex */
const BAD_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
);
/* eslint-enable no-control-regex */

describe('property tests: sanitisers and pricing', () => {
  const alphabet = [
    '<',
    '>',
    'a',
    ' ',
    '\u202e',
    '\u0000',
    '\u200b',
    '&',
    'script',
    '"',
    '\n',
    'é',
    '😀',
    '\ufeff',
    "'",
    '=',
    '/',
  ];
  it('cleanLine output is single-line, bounded, tag- and bidi-free', () => {
    const r = rng(7);
    for (let i = 0; i < 400; i++) {
      let s = '';
      const n = Math.floor(r() * 80);
      for (let j = 0; j < n; j++)
        s += alphabet[Math.floor(r() * alphabet.length)];
      const max = 1 + Math.floor(r() * 40);
      const out = cleanLine(s, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(BAD_CHARS);
      expect(out).not.toMatch(/<[^>]*>/);
    }
  });
  it('sanitizeHtml never emits script/handlers/javascript: for random fragments', () => {
    const r = rng(9);
    const bits = [
      '<script>x()</script>',
      '<img src=x onerror=a()>',
      '<a href="javascript:a()">k</a>',
      '<p onclick="a()">t</p>',
      '<svg/onload=a()>',
      '<<p>>',
      'plain',
      '&lt;b&gt;',
      '<iframe src=x>',
      '</p>',
    ];
    for (let i = 0; i < 300; i++) {
      let s = '';
      for (let j = 0; j < 1 + Math.floor(r() * 8); j++)
        s += bits[Math.floor(r() * bits.length)];
      const out = sanitizeHtml(s);
      expect(out).not.toMatch(/<\s*(script|iframe|svg|img|a)\b/i);
      expect(out).not.toMatch(/\son\w+\s*=/i);
      expect(out).not.toMatch(/javascript:/i);
    }
  });
  it('listed price always clears the margin floor and never undercuts cost', () => {
    const r = rng(3);
    for (let i = 0; i < 1000; i++) {
      const target = Math.floor(r() * 60);
      const p = {
        targetMarginPct: target,
        minMarginPct: target, // tightest case: floor == target
        paymentFeePct: Math.floor(r() * 10),
        paymentFixedFee: Math.round(r() * 100) / 100,
        charmPricing: r() < 0.5,
      };
      const cost = Math.round((0.01 + r() * 500) * 100) / 100;
      const price = computeSellPrice(cost, p);
      expect(price, JSON.stringify({ cost, p })).toBeGreaterThan(cost);
      expect(
        meetsMarginFloor(price, cost, p),
        JSON.stringify({ cost, p, price }),
      ).toBe(true);
    }
  });
});
