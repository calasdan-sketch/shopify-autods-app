/**
 * Round 5 benchmark: customer-data erasure and pricing-floor rounding.
 * Deterministic, no network.   npm run bench:r5
 *
 * "Before" = what 0.2.0 stored (full webhook payload, forever) and its
 * round-to-nearest-cent price. "After" = current behaviour.
 */
import { createDatabase } from '../src/models/db.js';
import { Repository } from '../src/models/repository.js';
import { computeSellPrice, meetsMarginFloor } from '../src/services/pricing.js';

const N = 5000;
const repo = new Repository(createDatabase(':memory:'));
for (let i = 1; i <= N; i++) {
  repo.insertOrderIfNew({
    shopifyOrderId: String(i),
    email: `u${i}@x.test`,
    rawPayload: {
      id: i,
      email: `u${i}@x.test`,
      phone: '+15550100',
      total_price: '40.00',
      customer: { first_name: 'Pat', last_name: `Person${i}` },
      shipping_address: { address1: `${i} Example Street`, city: 'Town' },
      line_items: [{ sku: 'S1', quantity: 1, title: 'Thing' }],
    },
  });
}
const countWithPii = (): number =>
  repo
    .listOrders()
    .filter((o) =>
      /Example Street|Person\d|@x\.test|5550100/.test(
        `${o.raw_payload}${o.email}`,
      ),
    ).length;
const before = countWithPii();
const t0 = performance.now();
const scrubbed = repo.scrubOrders({ all: true }).length;
const ms = performance.now() - t0;
const after = countWithPii();

let seed = 3;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
let oldBelow = 0;
let newBelow = 0;
const TRIALS = 20000;
for (let i = 0; i < TRIALS; i++) {
  const t = Math.floor(rnd() * 60);
  const p = {
    targetMarginPct: t,
    minMarginPct: t,
    paymentFeePct: Math.floor(rnd() * 10),
    paymentFixedFee: Math.round(rnd() * 100) / 100,
    charmPricing: false,
  };
  const cost = Math.round((0.01 + rnd() * 500) * 100) / 100;
  const oldPrice =
    Math.round(
      ((cost + p.paymentFixedFee) /
        (1 - (p.paymentFeePct + p.targetMarginPct) / 100)) *
        100,
    ) / 100;
  if (!meetsMarginFloor(oldPrice, cost, p)) oldBelow++;
  if (!meetsMarginFloor(computeSellPrice(cost, p), cost, p)) newBelow++;
}

console.log(`${N} stored orders, erase-all request`);
console.log('');
console.log('| Metric | 0.2.0 behaviour | CURRENT |');
console.log('| --- | ---: | ---: |');
console.log(
  `| Orders still holding customer details after erase-all | ${before} | ${after} |`,
);
console.log(
  `| Time to erase ${scrubbed} orders (ms, this machine) | n/a (no erase) | ${ms.toFixed(0)} |`,
);
console.log(
  `| Prices under their own margin floor (${TRIALS} random, floor = target) | ${oldBelow} | ${newBelow} |`,
);
