import pino from 'pino';
import { loadConfig } from '../config/index.js';

const config = loadConfig();

/**
 * Application-wide structured logger.
 *
 * Uses pino for fast JSON logging. In development a human-friendly level label
 * is emitted; in production the raw JSON is preferable for log aggregation.
 */
export const logger = pino({
  level: config.logLevel,
  base: { service: 'shopify-autods-claude' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never write credentials or customer contact details to logs.
  redact: {
    paths: [
      '*.authorization',
      '*.headers.authorization',
      '*.headers["x-shopify-access-token"]',
      '*.accessToken',
      '*.apiToken',
      '*.apiKey',
      '*.email',
      '*.phone',
      '*.shipping_address',
      '*.billing_address',
    ],
    censor: '[redacted]',
  },
});

/**
 * Create a child logger scoped to a component/module.
 */
export function createLogger(component: string): pino.Logger {
  return logger.child({ component });
}
