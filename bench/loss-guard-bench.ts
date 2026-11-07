/**
 * Round 3 benchmark: loss from discounted/free orders, and duplicate
 * listings from repeated publish clicks. Deterministic, no network.
 *
 *   npm run bench:r3
 *
 * "Guard off" = RISK_HOLD_BELOW_COST=false, which reproduces 0.2.0 gate
 * behaviour for this case. The duplicate-listing 0.2.0 figure was measured by
 * running the 0.2.0 commit on the same scenario (10 concurrent publish clicks
 * produced 10 Shopify createProduct calls) and is a recorded constant.
 */
import { Orchestrator } from '../src/jobs/orchestrator.js';
import { loadConfig } from '../src/config/index.js';
import { createDatabase } from '../src/models/db.js';
import { Repository } from '../src/models/repository.js';

const COST = 14.5;
const N = 1000;
let seed = 99;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
// 10% of orders use a 100% code, 10% a 60% code, rest pay full 30.00 goods.
const orders = Array.from({ length: N }, (_, i) => {
  const r = rnd();
  const sub = r < 0.1 ? 0 : r < 0.2 ? 12 : 30;
  return {
    id: i + 1,
    email: `u${i}@x.test`,
    financial_status: 'paid',
    total_price: String(sub + 5),
    subtotal_price: String(sub),
    line_items: [{ sku: 'SKU-A', quantity: 1 }],
    shipping_address: {
      address1: '1 Main',
      city: 'Winnipeg',
      zip: 'R3C0A1',
      country_code: 'CA',
    },
  };
});

async function run(guard: boolean) {
  const base = loadConfig();
  const repo = new Repository(createDatabase(':memory:'));
  repo.upsertProductMapping({
    autodsProductId: 'a',
    autodsSku: 'SKU-A',
    status: 'published',
    cost: COST,
  });
  let placed = 0;
  let lossOrders = 0;
  const orch = new Orchestrator({
    config: {
      ...base,
      risk: {
        ...base.risk,
        enabled: true,
        maxOrdersPerEmailPerDay: 0,
        holdBelowCost: guard,
      },
      automation: { ...base.automation, autoFulfill: true },
    },
    repo,
    autods: {
      createOrder: async (i: { shopifyOrderId: string }) => {
        placed += 1;
        const o = orders[Number(i.shopifyOrderId) - 1];
        if (Number(o.subtotal_price) < COST) lossOrders += 1;
        return { autodsOrderId: 'x', status: 'processing' };
      },
    } as never,
    shopify: {} as never,
    claude: {} as never,
  });
  for (const o of orders) await orch.handleOrderCreated(o);
  return { placed, lossOrders };
}

async function dupes() {
  const base = loadConfig();
  const repo = new Repository(createDatabase(':memory:'));
  let created = 0;
  repo.upsertProductMapping({
    autodsProductId: 'p',
    status: 'pending_review',
    cost: 10,
    sellPrice: 15,
  });
  repo.insertAiContent({
    autodsProductId: 'p',
    contentType: 'staged_listing',
    content: JSON.stringify({
      content: { title: 't', description: 'd', tags: [] },
      cost: 10,
      sellPrice: 15,
      sku: 's',
    }),
    status: 'approved',
  });
  const orch = new Orchestrator({
    config: base,
    repo,
    shopify: {
      createProduct: async () => {
        created += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { id: 1, variants: [{ id: 1 }] };
      },
    } as never,
    autods: {} as never,
    claude: {} as never,
  });
  await Promise.allSettled(
    Array.from({ length: 10 }, () => orch.publishApproved('p')),
  );
  return created;
}

const off = await run(false);
const on = await run(true);
const OLD_DUPES = 10; // measured on 0.2.0 code, see header
const now = await dupes();
const loss = (r: { lossOrders: number }) => (r.lossOrders * COST).toFixed(2);
console.log(
  `\n${N} paid orders; 10% 100%-discount, 10% 60%-discount; supplier cost ${COST}\n`,
);
console.log('| Metric | 0.2.0 behaviour | CURRENT |');
console.log('| --- | ---: | ---: |');
console.log(`| Supplier orders placed | ${off.placed} | ${on.placed} |`);
console.log(
  `| Orders bought below cost | ${off.lossOrders} | ${on.lossOrders} |`,
);
console.log(
  `| Supplier spend on below-cost orders | ${loss(off)} | ${loss(on)} |`,
);
console.log(
  `| Shopify listings from 10 concurrent publish clicks | ${OLD_DUPES} | ${now} |`,
);
if (on.lossOrders !== 0 || now !== 1) {
  console.error('FAIL');
  process.exit(1);
}
process.exit(0);
