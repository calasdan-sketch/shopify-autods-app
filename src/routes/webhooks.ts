import express, { type Router, type Request, type Response } from 'express';
import { createLogger } from '../lib/logger.js';
import { ConfigError, VerificationError } from '../lib/errors.js';
import { createRateLimiter } from '../lib/rate-limit.js';
import { ShopifyService } from '../services/shopify.js';
import { Orchestrator } from '../jobs/orchestrator.js';
import { Repository } from '../models/repository.js';

const log = createLogger('webhooks');

function envRate(): number {
  const n = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MIN);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 600;
}

/**
 * Build the Shopify webhook router.
 *
 * Uses a raw body parser so the exact bytes are available for HMAC
 * verification; re-serialising JSON would break the signature check.
 */
export function createWebhookRouter(
  shopify: ShopifyService = new ShopifyService(),
  orchestrator: Orchestrator = new Orchestrator(),
  rateLimitPerMin: number = envRate(),
  repoArg?: Repository,
): Router {
  let lazyRepo = repoArg;
  const repo = {
    get r(): Repository {
      return (lazyRepo ??= new Repository());
    },
  };
  const router = express.Router();

  // Webhooks are internet-facing; limit request rate to mitigate abuse.
  // Shopify retries failed deliveries and eventually drops the subscription,
  // so the limit must sit well above a flash-sale burst (default 600/min).
  router.use(createRateLimiter({ max: rateLimitPerMin }));
  router.use(express.raw({ type: 'application/json', limit: '2mb' }));

  function verify(req: Request): Record<string, unknown> {
    const hmac = req.get('X-Shopify-Hmac-Sha256') ?? '';
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {}));

    if (!shopify.verifyWebhook(rawBody, hmac)) {
      throw new VerificationError('Invalid Shopify webhook signature');
    }
    if (!shopify.isOwnShop(req.get('X-Shopify-Shop-Domain'))) {
      throw new VerificationError('Webhook is for a different shop');
    }
    return JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  }

  router.post('/orders/create', async (req: Request, res: Response) => {
    let payload: Record<string, unknown>;
    try {
      payload = verify(req);
    } catch (error) {
      log.warn({ err: String(error) }, 'Rejected webhook');
      if (error instanceof VerificationError) {
        res.status(401).json({ error: 'invalid signature' });
      } else if (error instanceof ConfigError) {
        res.status(503).json({ error: 'webhook secret not configured' });
      } else {
        res.status(400).json({ error: 'malformed body' });
      }
      return;
    }

    // A validly signed body can still be `null`, an array or a scalar.
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload) ||
      (typeof payload.id !== 'number' && typeof payload.id !== 'string') ||
      String(payload.id).trim() === ''
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
    try {
      repo.r.setSyncState('app_uninstalled_at', new Date().toISOString());
    } catch {
      /* best effort */
    }
    res.status(200).json({ received: true });
  });

  /** Verify + parse, answering 401/503/400 itself. Returns null if it replied. */
  function verifiedBody(
    req: Request,
    res: Response,
  ): Record<string, unknown> | null {
    try {
      const body = verify(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).json({ error: 'malformed body' });
        return null;
      }
      return body;
    } catch (error) {
      log.warn({ err: String(error) }, 'Rejected webhook');
      if (error instanceof VerificationError) {
        res.status(401).json({ error: 'invalid signature' });
      } else if (error instanceof ConfigError) {
        res.status(503).json({ error: 'webhook secret not configured' });
      } else {
        res.status(400).json({ error: 'malformed body' });
      }
      return null;
    }
  }

  const idList = (v: unknown): string[] =>
    (Array.isArray(v) ? v : [])
      .filter((x) => typeof x === 'number' || typeof x === 'string')
      .map(String)
      .slice(0, 5000);
  const emailOf = (body: Record<string, unknown>): string | null => {
    const c = body.customer;
    const e =
      typeof c === 'object' && c !== null
        ? (c as Record<string, unknown>).email
        : undefined;
    return typeof e === 'string' && e.trim() ? e.trim().toLowerCase() : null;
  };
  const shopOf = (body: Record<string, unknown>): string | null =>
    typeof body.shop_domain === 'string'
      ? body.shop_domain.slice(0, 120)
      : null;

  // Shopify's mandatory privacy webhooks. Unverified against a live store.
  router.post('/orders/cancelled', (req: Request, res: Response) => {
    const body = verifiedBody(req, res);
    if (!body) return;
    if (
      (typeof body.id !== 'number' && typeof body.id !== 'string') ||
      String(body.id).trim() === ''
    ) {
      res.status(400).json({ error: 'order id missing' });
      return;
    }
    try {
      res
        .status(200)
        .json({ received: true, ...orchestrator.handleOrderCancelled(body) });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to store cancellation');
      res.status(500).json({ error: 'storage failure' });
    }
  });

  router.post('/customers/data_request', (req: Request, res: Response) => {
    const body = verifiedBody(req, res);
    if (!body) return;
    // We do not email data out automatically; the owner exports it from
    // GET /admin/privacy/export and replies to the customer.
    try {
      repo.r.logPrivacyRequest({
        kind: 'data_request',
        shopDomain: shopOf(body),
        subject: emailOf(body),
        note: 'Export with GET /admin/privacy/export?email=... and reply to the customer',
      });
      res.status(200).json({ received: true });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to log data request');
      res.status(500).json({ error: 'storage failure' });
    }
  });

  router.post('/customers/redact', (req: Request, res: Response) => {
    const body = verifiedBody(req, res);
    if (!body) return;
    try {
      const email = emailOf(body);
      const done = repo.r.scrubOrders({
        email,
        orderIds: idList(body.orders_to_redact),
      });
      repo.r.logPrivacyRequest({
        kind: 'customer_redact',
        shopDomain: shopOf(body),
        subject: email,
        ordersAffected: done.length,
      });
      res.status(200).json({ received: true, scrubbed: done.length });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to redact customer');
      res.status(500).json({ error: 'storage failure' });
    }
  });

  router.post('/shop/redact', (req: Request, res: Response) => {
    const body = verifiedBody(req, res);
    if (!body) return;
    try {
      const done = repo.r.scrubOrders({ all: true });
      repo.r.logPrivacyRequest({
        kind: 'shop_redact',
        shopDomain: shopOf(body),
        ordersAffected: done.length,
      });
      res.status(200).json({ received: true, scrubbed: done.length });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to redact shop');
      res.status(500).json({ error: 'storage failure' });
    }
  });

  return router;
}
