import cron, { type ScheduledTask } from 'node-cron';
import type { AppConfig } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { Orchestrator } from './orchestrator.js';
import { Repository } from '../models/repository.js';

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

  const tasks = [trackingTask];
  const days = config.privacy.retentionDays;
  if (days >= 30) {
    // Daily at 03:17 server time.
    tasks.push(
      cron.schedule(
        '17 3 * * *',
        () => {
          try {
            const repo = new Repository();
            const done = repo.scrubOrders({ all: true, olderThanDays: days });
            if (done.length > 0) {
              repo.logPrivacyRequest({
                kind: 'retention_purge',
                ordersAffected: done.length,
                note: `scheduled, older than ${days} days`,
              });
            }
            log.info({ scrubbed: done.length }, 'Retention purge done');
          } catch (error) {
            log.error({ err: String(error) }, 'Retention purge failed');
          }
        },
        { name: 'privacy-retention' },
      ),
    );
  } else if (days > 0) {
    log.warn({ days }, 'DATA_RETENTION_DAYS below 30 is ignored');
  }

  log.info({ syncCron }, 'Scheduler started');
  return tasks;
}
