import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
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
  app.disable('x-powered-by');
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
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

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });
  app.use(jsonErrorHandler);

  return app;
}

/**
 * Last-resort handler: bad JSON, oversized bodies and bugs answer with a short
 * JSON error. Express's default would send an HTML page with a stack trace
 * (file paths and library versions) outside production.
 */
export function jsonErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const raw = (err as { status?: unknown; statusCode?: unknown } | null) ?? {};
  const code = Number(raw.status ?? raw.statusCode);
  const status = code >= 400 && code < 500 ? code : 500;
  res.status(status).json({
    error:
      status === 413
        ? 'payload too large'
        : status < 500
          ? 'bad request'
          : 'internal error',
  });
}
