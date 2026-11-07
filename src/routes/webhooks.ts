import express, { type Router, type Request, type Response } from 'express';
import { createLogger } from '../lib/logger.js';
import { VerificationError } from '../lib/errors.js';
import { createRateLimiter } from '../lib/rate-limit.js';
import { ShopifyService } from '../services/shopify.js';
import { Orchestrator } from '../jobs/orchestrator.js';

const log = createLogger('webhooks');

/**
 * Build the Shopify webhook router.
 *
 * Uses a raw body parser so the exact bytes are available for HMAC
 * verification; re-serialising JSON would break the signature check.
 */
export function createWebhookRouter(
  shopify: ShopifyService = new ShopifyService(),
  orchestrator: Orchestrator = new Orchestrator(),
): Router {
  const router = express.Router();

  // Webhooks are internet-facing; limit request rate to mitigate abuse.
  router.use(createRateLimiter({ max: 120 }));
  router.use(express.raw({ type: 'application/json', limit: '2mb' }));

  function verify(req: Request): Record<string, unknown> {
    const hmac = req.get('X-Shopify-Hmac-Sha256') ?? '';
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));

    if (!shopify.verifyWebhook(rawBody, hmac)) {
      throw new VerificationError('Invalid Shopify webhook signature');
    }
    return JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  }

  router.post('/orders/create', async (req: Request, res: Response) => {
    let payload: Record<string, unknown>;
    try {
      payload = verify(req);
    } catch (error) {
      log.warn({ err: String(error) }, 'Rejected webhook');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    if (
      (typeof payload.id !== 'number' && typeof payload.id !== 'string') ||
      String(payload.id) === ''
    ) {
      res.status(400).json({ error: 'order id missing' });
      return;
    }

    // Persist BEFORE acknowledging: if we crash after the 200, the order is
    // already stored and the scheduler's recovery pass will pick it up.
    // Storage failure -> 500, so Shopify retries the delivery.
    try {
      orchestrator.recordOrder(payload);
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to store order webhook');
      res.status(500).json({ error: 'storage failure' });
      return;
    }

    res.status(200).json({ received: true });
    // Idempotent: replays/retries of the same order never re-forward it.
    orchestrator.handleOrderCreated(payload).catch((error) => {
      log.error({ err: String(error) }, 'Failed to process order webhook');
    });
  });

  router.post('/products/update', (req: Request, res: Response) => {
    try {
      verify(req);
    } catch {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    res.status(200).json({ received: true });
  });

  router.post('/app/uninstalled', (req: Request, res: Response) => {
    try {
      verify(req);
    } catch {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    log.warn('App uninstalled webhook received');
    res.status(200).json({ received: true });
  });

  return router;
}
