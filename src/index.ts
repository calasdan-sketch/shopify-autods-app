import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { startScheduler } from './jobs/scheduler.js';
import { closeDb, getDb } from './models/db.js';
import { logger } from './lib/logger.js';
import { isValidShopDomain } from './services/shopify.js';

/**
 * Application entrypoint: initialise the datastore, start the HTTP server and
 * background scheduler, and wire up graceful shutdown.
 */
function main(): void {
  const config = loadConfig();

  // A stray rejected promise must be logged, not silently kill an order run.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'Unhandled promise rejection');
  });
  if (config.admin.token.length < 16) {
    logger.warn('ADMIN_TOKEN unset or too short: /admin refuses all calls');
  }
  if (!config.shopify.webhookSecret) {
    logger.warn('SHOPIFY_WEBHOOK_SECRET unset: every webhook will be refused');
  }

  if (config.shopify.shop && !isValidShopDomain(config.shopify.shop)) {
    logger.error(
      'SHOPIFY_SHOP must look like my-store.myshopify.com (no https://, no path). Refusing to start.',
    );
    process.exit(1);
  }
  const v = /^(\d{4})-(\d{2})$/.exec(config.shopify.apiVersion);
  if (v) {
    const ageMonths =
      (new Date().getUTCFullYear() - Number(v[1])) * 12 +
      (new Date().getUTCMonth() + 1 - Number(v[2]));
    // Shopify supports each API version for about a year (verify at
    // shopify.dev/docs/api/usage/versioning); older ones are forced forward.
    if (ageMonths > 12) {
      logger.warn(
        { apiVersion: config.shopify.apiVersion },
        'SHOPIFY_API_VERSION is more than 12 months old and may be retired: pick a current one',
      );
    }
  } else if (config.shopify.apiVersion !== 'unstable') {
    logger.warn('SHOPIFY_API_VERSION should look like 2025-10');
  }

  // Initialise the database (creates the file/schema if needed).
  try {
    getDb();
  } catch (error) {
    logger.error(
      { err: String(error) },
      'Cannot open the database. Check DATABASE_PATH exists, is writable, and is not on a read-only disk. Refusing to start.',
    );
    process.exit(1);
  }

  const app = createApp();
  const scheduledTasks = startScheduler();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'Server listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    for (const task of scheduledTasks) {
      void task.stop();
    }
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
