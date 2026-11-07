import express, { type Express, type Request, type Response } from 'express';
import { createWebhookRouter } from './routes/webhooks.js';
import { createAdminRouter } from './routes/admin.js';
import { loadConfig } from './config/index.js';
import { adminAuth } from './lib/admin-auth.js';

/**
 * Assemble the Express application.
 *
 * The webhook router is mounted first because it requires a raw body parser;
 * the admin router uses JSON parsing scoped to its own routes.
 */
export function createApp(): Express {
  const app = express();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use('/webhooks/shopify', createWebhookRouter());
  app.use('/admin', adminAuth(loadConfig().admin.token), createAdminRouter());

  return app;
}
