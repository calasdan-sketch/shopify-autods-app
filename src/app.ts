import express, { type Express, type Request, type Response } from 'express';
import { createWebhookRouter } from './routes/webhooks.js';
import { createAdminRouter } from './routes/admin.js';
import { loadConfig } from './config/index.js';
import { adminAuth } from './lib/admin-auth.js';
import { createAuthFailureLimiter } from './lib/rate-limit.js';

/**
 * Assemble the Express application.
 *
 * The webhook router is mounted first because it requires a raw body parser;
 * the admin router uses JSON parsing scoped to its own routes.
 */
export function createApp(): Express {
  const app = express();
  // Behind a reverse proxy, set TRUST_PROXY_HOPS (e.g. 1) so rate limits see
  // the real client IP instead of the proxy's.
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (Number.isInteger(hops) && hops > 0) app.set('trust proxy', hops);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use('/webhooks/shopify', createWebhookRouter());
  app.use(
    '/admin',
    createAuthFailureLimiter(),
    adminAuth(loadConfig().admin.token),
    createAdminRouter(),
  );

  return app;
}
