import cron, { type ScheduledTask } from 'node-cron';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { Orchestrator } from './orchestrator.js';

const log = createLogger('scheduler');

/**
 * Registers recurring background jobs (price/stock + tracking sync).
 *
 * Returns the created tasks so the caller can stop them during shutdown.
 */
export function startScheduler(
  orchestrator: Orchestrator = new Orchestrator(),
  config: AppConfig = loadConfig(),
): ScheduledTask[] {
  const { syncCron } = config.automation;

  if (!cron.validate(syncCron)) {
    log.error({ syncCron }, 'Invalid SYNC_CRON expression; scheduler disabled');
    return [];
  }

  const trackingTask = cron.schedule(
    syncCron,
    async () => {
      try {
        await orchestrator.processReceivedOrders();
        await orchestrator.syncOrderTracking();
      } catch (error) {
        log.error({ err: String(error) }, 'Order tracking sync failed');
      }
    },
    { name: 'order-tracking-sync' },
  );

  log.info({ syncCron }, 'Scheduler started');
  return [trackingTask];
}
