import express, { type Router, type Request, type Response } from 'express';
import { createLogger } from '../lib/logger.js';
import { createRateLimiter } from '../lib/rate-limit.js';
import { Repository } from '../models/repository.js';
import { Orchestrator } from '../jobs/orchestrator.js';
import { ShopifyService } from '../services/shopify.js';
import { businessPlan } from '../system/business-plan.js';

const log = createLogger('admin');

/**
 * Build the admin API router.
 *
 * Provides read access to mappings/orders/AI content and endpoints to trigger
 * workflows and approve staged (human-in-the-loop) items.
 */
export function createAdminRouter(
  repo: Repository = new Repository(),
  orchestrator: Orchestrator = new Orchestrator(),
  shopify: ShopifyService = new ShopifyService(),
): Router {
  const router = express.Router();
  router.use(createRateLimiter({ max: 100 }));
  router.use(express.json());

  // Display the connected Shopify store details.
  router.get('/store', async (_req: Request, res: Response) => {
    try {
      const store = await shopify.getShop();
      res.json({ store });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to fetch store');
      res.status(502).json({ error: 'failed to fetch store' });
    }
  });

  router.get('/products', (_req: Request, res: Response) => {
    res.json({ products: repo.listProductMappings() });
  });

  // Customer PII (raw webhook payload) is omitted unless ?raw=1 is asked for.
  router.get('/orders', (req: Request, res: Response) => {
    const raw = req.query.raw === '1';
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || 200, 1),
      1000,
    );
    const offset = Math.max(
      Number.parseInt(String(req.query.offset ?? ''), 10) || 0,
      0,
    );
    const orders = repo
      .listOrders({ limit, offset })
      .map((o) => (raw ? o : { ...o, raw_payload: undefined }));
    res.json({ orders });
  });

  // Append-only status history for one order (audit trail).
  router.get('/orders/:id/events', (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!repo.getOrder(id)) {
      res.status(404).json({ error: 'order not found' });
      return;
    }
    res.json({ events: repo.listOrderEvents(id) });
  });

  // Orders the risk gate or a supplier failure parked for a human.
  router.get('/orders/held', (_req: Request, res: Response) => {
    const orders = repo
      .listOrdersByStatus([
        'held',
        'forward_failed',
        'needs_review',
        'supplier_issue',
      ])
      .map((o) => ({ ...o, raw_payload: undefined }));
    res.json({ orders });
  });

  // Human override: forward a held/failed order to the supplier.
  router.post('/orders/:id/release', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const order = repo.getOrder(id);
    if (!order) {
      res.status(404).json({ error: 'order not found' });
      return;
    }
    if (
      order.fulfillment_status === 'needs_review' &&
      req.body?.confirmNotOrdered !== true
    ) {
      res.status(409).json({
        error:
          'AutoDS outcome was unknown. Check AutoDS first, then repeat with {"confirmNotOrdered": true}',
      });
      return;
    }
    if (order.fulfillment_status === 'needs_review') {
      repo.transitionOrder(id, ['needs_review'], 'forward_failed');
    }
    try {
      res.json(await orchestrator.releaseOrder(id));
    } catch (error) {
      log.error({ err: String(error) }, 'Release failed');
      res.status(502).json({ error: 'release failed' });
    }
  });

  // Publish a staged product after its staged_listing content was approved.
  router.post(
    '/products/:autodsProductId/publish',
    async (req: Request, res: Response) => {
      try {
        res.json(
          await orchestrator.publishApproved(
            String(req.params.autodsProductId),
          ),
        );
      } catch (error) {
        res.status(409).json({
          error: String(error instanceof Error ? error.message : error),
        });
      }
    },
  );

  // Unstick a product left in `publishing` by an unknown outcome. Check
  // Shopify first: if the product exists there, publishing again duplicates it.
  router.post(
    '/products/:autodsProductId/reset-publish',
    (req: Request, res: Response) => {
      if (req.body?.confirmNotListed !== true) {
        res.status(409).json({
          error:
            'Check Shopify for this product first, then repeat with {"confirmNotListed": true}',
        });
        return;
      }
      const ok = orchestrator.resetPublishing(
        String(req.params.autodsProductId),
      );
      res.status(ok ? 200 : 404).json({ reset: ok });
    },
  );

  // ---- Privacy: answer a customer's access / erasure request ----
  const emailParam = (v: unknown): string | null => {
    const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
  };

  // Everything stored about one customer email (contains personal data).
  router.get('/privacy/export', (req: Request, res: Response) => {
    const email = emailParam(req.query.email);
    if (!email) {
      res.status(400).json({ error: 'email query parameter required' });
      return;
    }
    const orders = repo.exportCustomer(email);
    repo.logPrivacyRequest({
      kind: 'admin_export',
      subject: email,
      ordersAffected: orders.length,
    });
    res.json({ orders });
  });

  // Erase one customer's personal data from stored orders.
  router.post('/privacy/erase', (req: Request, res: Response) => {
    const email = emailParam(req.body?.email);
    if (!email) {
      res.status(400).json({ error: 'a valid email is required' });
      return;
    }
    const done = repo.scrubOrders({ email });
    repo.logPrivacyRequest({
      kind: 'admin_erase',
      subject: email,
      ordersAffected: done.length,
    });
    res.json({ scrubbed: done.length });
  });

  // Retention: scrub customer data from orders older than N days.
  router.post('/privacy/purge', (req: Request, res: Response) => {
    const days: unknown = req.body?.olderThanDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 30) {
      res
        .status(400)
        .json({ error: 'olderThanDays must be a whole number, at least 30' });
      return;
    }
    const done = repo.scrubOrders({ all: true, olderThanDays: days });
    repo.logPrivacyRequest({
      kind: 'retention_purge',
      ordersAffected: done.length,
      note: `older than ${days} days`,
    });
    res.json({ scrubbed: done.length });
  });

  router.get('/privacy/requests', (_req: Request, res: Response) => {
    res.json({ requests: repo.listPrivacyRequests() });
  });

  router.get('/ai-content', (_req: Request, res: Response) => {
    res.json({ content: repo.listAiContent() });
  });

  router.get('/system-plan', (_req: Request, res: Response) => {
    res.json({ plan: businessPlan });
  });

  router.get('/team', (_req: Request, res: Response) => {
    res.json({ team: repo.listTeamMembers() });
  });

  // Add a member to the development team, or update them by email.
  router.post('/team', (req: Request, res: Response) => {
    const { name, email, role, status } = req.body ?? {};
    if (!name || !email || !role) {
      res.status(400).json({ error: 'name, email, and role are required' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      res.status(400).json({ error: 'email looks invalid' });
      return;
    }
    const member = repo.addTeamMember({
      name: String(name),
      email: String(email),
      role: String(role),
      status: status ? String(status) : undefined,
    });
    res.status(201).json({ member });
  });

  // Deactivate a development team member.
  router.post('/team/:id/deactivate', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    repo.updateTeamMemberStatus(id, 'inactive');
    res.json({ id, status: 'inactive' });
  });

  // Trigger sourcing + content generation for a specific AutoDS product.
  router.post('/products/import', async (req: Request, res: Response) => {
    const { autodsProductId } = req.body ?? {};
    if (!autodsProductId) {
      res.status(400).json({ error: 'autodsProductId is required' });
      return;
    }
    try {
      const result = await orchestrator.importAndPublishProduct(
        String(autodsProductId),
      );
      res.json(result);
    } catch (error) {
      log.error({ err: String(error) }, 'Import failed');
      res.status(502).json({ error: 'import failed' });
    }
  });

  // Approve a piece of staged AI content (human-in-the-loop).
  router.post('/ai-content/:id/approve', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    if (!repo.getAiContent(id)) {
      res.status(404).json({ error: 'content not found' });
      return;
    }
    repo.updateAiContentStatus(id, 'approved');
    res.json({ id, status: 'approved' });
  });

  return router;
}
