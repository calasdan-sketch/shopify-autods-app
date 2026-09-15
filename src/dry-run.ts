/**
 * End-to-end DRY RUN of the whole pipeline with zero external credentials.
 *
 *   npm run dry-run
 *
 * What it does, in order:
 *   1. source   — list the mock AutoDS catalogue
 *   2. generate — produce product content (stubbed Claude, no API call)
 *   3. publish  — "create" the product in a stubbed Shopify (no API call)
 *   4. fulfill  — a fake Shopify order-created webhook is forwarded to mock AutoDS
 *   5. track    — the tracking sync pulls a tracking number back and "fulfills"
 *
 * Every step prints what it did. Nothing is written outside an in-memory
 * SQLite database. Swap AUTODS_MODE=live (and real Shopify/Claude keys) to
 * run the same code against real services.
 */
import { Orchestrator } from './jobs/orchestrator.js';
import { createDatabase } from './models/db.js';
import { Repository } from './models/repository.js';
import { MockAutoDSService } from './services/autods-mock.js';
import type { AutoDSProduct } from './services/autods.js';
import type { ClaudeService } from './services/claude.js';
import type { ShopifyService } from './services/shopify.js';
import { loadConfig } from './config/index.js';

function step(n: number, label: string, detail?: unknown): void {
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
  // eslint-disable-next-line no-console
  console.log(`[dry-run] ${n}. ${label}${suffix}`);
}

/** Shopify stand-in: records what would have been sent, returns fake ids. */
function stubShopify(): ShopifyService {
  let nextId = 7000;
  return {
    createProduct: async (input: { title: string; variants?: unknown[] }) => {
      nextId += 1;
      step(3, 'publish → Shopify createProduct (stub)', { title: input.title });
      return {
        id: nextId,
        title: input.title,
        handle: input.title.toLowerCase().replace(/\s+/g, '-'),
        status: 'active',
        variants: [{ id: nextId * 10, sku: 'MOCK-EARBUDS-01', price: '29.99' }],
      };
    },
    createFulfillment: async (
      orderId: string,
      input: { trackingNumber: string },
    ) => {
      step(5, 'track → Shopify createFulfillment (stub)', {
        orderId,
        trackingNumber: input.trackingNumber,
      });
      return {};
    },
  } as unknown as ShopifyService;
}

/** Claude stand-in: deterministic content, no tokens spent. */
function stubClaude(): ClaudeService {
  return {
    generateProductContent: async (product: AutoDSProduct) => {
      const content = {
        title: `${product.title} — Fast Canadian Shipping`,
        description: `<p>${product.description ?? product.title}</p>`,
        bullets: ['Ships from local partner', '30-day returns'],
        tags: ['dropship', 'mock'],
      };
      step(2, 'generate → Claude content (stub)', { title: content.title });
      return content;
    },
  } as unknown as ClaudeService;
}

async function main(): Promise<void> {
  // Force the automation flags on for the walkthrough regardless of .env —
  // the point is to prove every step runs, not to respect review gates.
  const base = loadConfig();
  const config = {
    ...base,
    autods: { ...base.autods, mode: 'mock' as const },
    automation: { ...base.automation, autoPublish: true, autoFulfill: true },
  };

  const repo = new Repository(createDatabase(':memory:'));
  const autods = new MockAutoDSService({ pollsUntilShipped: 1 });
  const orchestrator = new Orchestrator({
    config,
    repo,
    autods,
    shopify: stubShopify(),
    claude: stubClaude(),
  });

  const catalogue = await autods.listProducts();
  step(1, 'source → AutoDS listProducts (mock)', {
    count: catalogue.length,
    first: catalogue[0]?.title,
  });

  const imported = await orchestrator.importAndPublishProduct(catalogue[0].id);
  step(3, 'publish result', imported);

  const fakeOrder = {
    id: 90001,
    line_items: [{ sku: catalogue[0].sku, quantity: 2 }],
    shipping_address: { city: 'Winnipeg', province: 'MB', country: 'CA' },
  };
  const forwarded = await orchestrator.handleOrderCreated(fakeOrder);
  step(4, 'fulfill → order forwarded to AutoDS (mock)', forwarded);

  const synced = await orchestrator.syncOrderTracking();
  step(5, 'track → syncOrderTracking updated orders', { synced });

  const orders = repo.listOrders();
  step(6, 'final datastore state', {
    products: repo.listProductMappings().length,
    orders: orders.map((o) => ({
      shopify: o.shopify_order_id,
      autods: o.autods_order_id,
      status: o.fulfillment_status,
      tracking: o.tracking_number,
    })),
  });

  const ok =
    imported.published &&
    forwarded.forwarded &&
    synced === 1 &&
    orders[0]?.fulfillment_status === 'fulfilled';
  // eslint-disable-next-line no-console
  console.log(
    ok ? '[dry-run] PASS — pipeline ran end-to-end' : '[dry-run] FAIL',
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[dry-run] crashed:', err);
  process.exit(1);
});
