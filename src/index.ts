import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { startScheduler } from './jobs/scheduler.js';
import { closeDb, getDb } from './models/db.js';
import { logger } from './lib/logger.js';

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

  // Initialise the database (creates the file/schema if needed).
  getDb();

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
