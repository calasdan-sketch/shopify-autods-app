/**
 * Re-runnable benchmark: what does a store lose to bad/duplicate orders and
 * zero-margin listings, with the OLD behaviour vs the CURRENT code?
 *
 *   npm run bench
 *
 * Deterministic (seeded). No network, no credentials. The OLD column
 * re-implements the behaviour of main@152c061 (every webhook delivery is
 * forwarded; listings priced at supplier cost) in a few lines so the two
 * can be compared on identical traffic. Numbers are a SIMULATION of the
 * traffic mix below, not measurements of a live store.
 */
import { Orchestrator } from '../src/jobs/orchestrator.js';
import { loadConfig } from '../src/config/index.js';
import { createDatabase } from '../src/models/db.js';
import { Repository } from '../src/models/repository.js';
import { MockAutoDSService } from '../src/services/autods-mock.js';
import { computeSellPrice, unitEconomics } from '../src/services/pricing.js';

let seed = 42;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

const N = 2000;
const DUP_RATE = 0.3; // share of orders delivered twice (webhook retries)
const UNPAID_RATE = 0.08;
const CANCELLED_RATE = 0.04;
const TEST_RATE = 0.01;
const COST = 14.5;

interface O {
  id: number;
  email: string;
  financial_status: string;
  cancelled_at: string | null;
  test: boolean;
  total_price: string;
  line_items: Array<{ sku: string; quantity: number }>;
  shipping_address: Record<string, string>;
}
const orders: O[] = [];
const deliveries: O[] = [];
for (let i = 1; i <= N; i++) {
  const r = rnd();
  const o: O = {
    id: i,
    email: `u${i}@x.test`,
    financial_status: r < UNPAID_RATE ? 'pending' : 'paid',
    cancelled_at: rnd() < CANCELLED_RATE ? '2026-01-01' : null,
    test: rnd() < TEST_RATE,
    total_price: '40.00',
    line_items: [{ sku: 'MOCK-MOUNT-02', quantity: 1 }],
    shipping_address: {
      address1: '1 Main',
      city: 'Winnipeg',
      zip: 'R3C0A1',
      country_code: 'CA',
    },
  };
  orders.push(o);
  deliveries.push(o);
  if (rnd() < DUP_RATE) deliveries.push(o);
}
const isGood = (o: O): boolean =>
  o.financial_status === 'paid' && !o.cancelled_at && !o.test;
const good = orders.filter(isGood).length;

async function run(mode: 'old' | 'current') {
  const autods = new MockAutoDSService({ catalogue: undefined });
  let placed = 0;
  const seen = new Map<number, number>();
  const counting = {
    ...autods,
    mode: 'mock' as const,
    listProducts: autods.listProducts.bind(autods),
    getProduct: autods.getProduct.bind(autods),
    getOrderStatus: autods.getOrderStatus.bind(autods),
    createOrder: async (input: Parameters<typeof autods.createOrder>[0]) => {
      placed += 1;
      seen.set(
        Number(input.shopifyOrderId),
        (seen.get(Number(input.shopifyOrderId)) ?? 0) + 1,
      );
      return autods.createOrder(input);
    },
  };
  if (mode === 'old') {
    for (const d of deliveries) {
      await counting.createOrder({
        shopifyOrderId: String(d.id),
        items: d.line_items,
        shippingAddress: d.shipping_address,
      });
    }
  } else {
    const base = loadConfig();
    const orch = new Orchestrator({
      config: {
        ...base,
        risk: { ...base.risk, enabled: true, maxOrdersPerEmailPerDay: 0 },
        automation: { ...base.automation, autoFulfill: true },
      },
      repo: new Repository(createDatabase(':memory:')),
      autods: counting as never,
      shopify: {} as never,
      claude: {} as never,
    });
    await Promise.all(
      deliveries.map((d) =>
        orch.handleOrderCreated(d as unknown as Record<string, unknown>),
      ),
    );
  }
  const dupes = [...seen.values()].reduce((a, c) => a + Math.max(0, c - 1), 0);
  const bad = orders.filter((o) => !isGood(o) && seen.has(o.id)).length;
  // 'old' placed an order per delivery regardless of validity.
  const oldSeenCount = mode === 'old' ? deliveries.length : placed;
  const wrong = mode === 'old' ? deliveries.length - good : dupes + bad;
  return {
    placed: oldSeenCount,
    wrong,
    wrongSpend: Math.round(wrong * COST * 100) / 100,
  };
}

const old = await run('old');
const cur = await run('current');

const p = { ...loadConfig().pricing };
const sell = computeSellPrice(COST, p);
const rows = [
  ['Valid paid orders in traffic', String(good), String(good)],
  ['Supplier orders placed', String(old.placed), String(cur.placed)],
  [
    'Wrong supplier orders (dupes + unpaid + cancelled + test)',
    String(old.wrong),
    String(cur.wrong),
  ],
  [
    `Money spent on wrong orders (at ${COST} each, currency units)`,
    old.wrongSpend.toFixed(2),
    cur.wrongSpend.toFixed(2),
  ],
  ['Listing price for a 14.50 item', COST.toFixed(2), sell.toFixed(2)],
  [
    'Listing margin before fees (%)',
    '0.00',
    String(
      unitEconomics(sell, COST, { ...p, paymentFeePct: 0, paymentFixedFee: 0 })
        .marginPct,
    ),
  ],
];
console.log(
  `\nTraffic: ${orders.length} orders, ${deliveries.length} webhook deliveries (${(DUP_RATE * 100).toFixed(0)}% duplicated), unpaid ${UNPAID_RATE * 100}%, cancelled ${CANCELLED_RATE * 100}%, test ${TEST_RATE * 100}%\n`,
);
console.log('| Metric | OLD (main@152c061 behaviour) | CURRENT |');
console.log('| --- | ---: | ---: |');
for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} |`);
if (cur.wrong !== 0) {
  console.error('FAIL: current code placed wrong orders');
  process.exit(1);
}
process.exit(0);
