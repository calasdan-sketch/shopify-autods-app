import type Database from 'better-sqlite3';
import { getDb } from './db.js';

export interface ProductMapping {
  id: number;
  autods_product_id: string;
  autods_sku: string | null;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  status: string;
  cost?: number | null;
  sell_price?: number | null;
  stock?: number | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderRecord {
  id: number;
  shopify_order_id: string;
  autods_order_id: string | null;
  fulfillment_status: string;
  tracking_number: string | null;
  raw_payload: string | null;
  notes?: string | null;
  email?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderEvent {
  id: number;
  shopify_order_id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  at: string;
}

export interface TeamMemberRecord {
  id: number;
  name: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AiContentRecord {
  id: number;
  autods_product_id: string | null;
  content_type: string;
  prompt_hash: string | null;
  content: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

/**
 * Data-access layer over the SQLite datastore.
 *
 * Repositories keep SQL in one place and return typed rows so the rest of the
 * codebase never touches raw statements.
 */
export class Repository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
  }

  // ---- Product mappings ----

  upsertProductMapping(input: {
    autodsProductId: string;
    autodsSku?: string | null;
    shopifyProductId?: string | null;
    shopifyVariantId?: string | null;
    status?: string;
    cost?: number | null;
    sellPrice?: number | null;
    stock?: number | null;
    notes?: string | null;
  }): ProductMapping {
    this.db
      .prepare(
        `INSERT INTO product_mappings
           (autods_product_id, autods_sku, shopify_product_id, shopify_variant_id, status, cost, sell_price, stock, notes)
         VALUES (@autodsProductId, @autodsSku, @shopifyProductId, @shopifyVariantId, @status, @cost, @sellPrice, @stock, @notes)
         ON CONFLICT(autods_product_id) DO UPDATE SET
           cost = COALESCE(excluded.cost, product_mappings.cost),
           sell_price = COALESCE(excluded.sell_price, product_mappings.sell_price),
           stock = COALESCE(excluded.stock, product_mappings.stock),
           notes = excluded.notes,
           autods_sku = COALESCE(excluded.autods_sku, product_mappings.autods_sku),
           shopify_product_id = COALESCE(excluded.shopify_product_id, product_mappings.shopify_product_id),
           shopify_variant_id = COALESCE(excluded.shopify_variant_id, product_mappings.shopify_variant_id),
           status = excluded.status,
           updated_at = datetime('now')`,
      )
      .run({
        autodsProductId: input.autodsProductId,
        autodsSku: input.autodsSku ?? null,
        shopifyProductId: input.shopifyProductId ?? null,
        shopifyVariantId: input.shopifyVariantId ?? null,
        status: input.status ?? 'pending',
        cost: input.cost ?? null,
        sellPrice: input.sellPrice ?? null,
        stock: input.stock ?? null,
        notes: input.notes ?? null,
      });

    return this.getProductMapping(input.autodsProductId) as ProductMapping;
  }

  getProductMapping(autodsProductId: string): ProductMapping | undefined {
    return this.db
      .prepare('SELECT * FROM product_mappings WHERE autods_product_id = ?')
      .get(autodsProductId) as ProductMapping | undefined;
  }

  listProductMappings(): ProductMapping[] {
    return this.db
      .prepare('SELECT * FROM product_mappings ORDER BY id DESC')
      .all() as ProductMapping[];
  }

  // ---- Orders ----

  upsertOrder(input: {
    shopifyOrderId: string;
    autodsOrderId?: string | null;
    fulfillmentStatus?: string;
    trackingNumber?: string | null;
    rawPayload?: unknown;
  }): OrderRecord {
    const before = this.getOrder(input.shopifyOrderId)?.fulfillment_status;
    this.db
      .prepare(
        `INSERT INTO orders
           (shopify_order_id, autods_order_id, fulfillment_status, tracking_number, raw_payload)
         VALUES (@shopifyOrderId, @autodsOrderId, @fulfillmentStatus, @trackingNumber, @rawPayload)
         ON CONFLICT(shopify_order_id) DO UPDATE SET
           autods_order_id = COALESCE(excluded.autods_order_id, orders.autods_order_id),
           fulfillment_status = excluded.fulfillment_status,
           tracking_number = COALESCE(excluded.tracking_number, orders.tracking_number),
           raw_payload = COALESCE(excluded.raw_payload, orders.raw_payload),
           updated_at = datetime('now')`,
      )
      .run({
        shopifyOrderId: input.shopifyOrderId,
        autodsOrderId: input.autodsOrderId ?? null,
        fulfillmentStatus: input.fulfillmentStatus ?? 'pending',
        trackingNumber: input.trackingNumber ?? null,
        rawPayload:
          input.rawPayload === undefined
            ? null
            : JSON.stringify(input.rawPayload),
      });

    const after = input.fulfillmentStatus ?? 'pending';
    if (before !== after)
      this.logEvent(input.shopifyOrderId, before ?? null, after);
    return this.getOrder(input.shopifyOrderId) as OrderRecord;
  }

  /** Append-only audit trail of order status changes. */
  private logEvent(
    orderId: string,
    from: string | null,
    to: string,
    note?: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO order_events (shopify_order_id, from_status, to_status, note)
         VALUES (?, ?, ?, ?)`,
      )
      .run(orderId, from, to, note ?? null);
  }

  listOrderEvents(shopifyOrderId: string): OrderEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM order_events WHERE shopify_order_id = ? ORDER BY id',
      )
      .all(shopifyOrderId) as OrderEvent[];
  }

  /**
   * Insert an order in `received` state ONLY if it is new. Never touches an
   * existing row, so a replayed webhook cannot reset a forwarded/fulfilled
   * order back to `received`. Returns whether this call created the row.
   */
  insertOrderIfNew(input: {
    shopifyOrderId: string;
    rawPayload: unknown;
    email?: string | null;
  }): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO orders
           (shopify_order_id, fulfillment_status, raw_payload, email)
         VALUES (?, 'received', ?, ?)`,
      )
      .run(
        input.shopifyOrderId,
        JSON.stringify(input.rawPayload),
        input.email ?? null,
      );
    if (r.changes === 1) this.logEvent(input.shopifyOrderId, null, 'received');
    return r.changes === 1;
  }

  /**
   * Atomically move an order from one of `from` to `to`. Returns true for the
   * single caller that wins; concurrent/replayed callers get false.
   */
  transitionOrder(
    shopifyOrderId: string,
    from: string[],
    to: string,
    notes?: string | null,
  ): boolean {
    const marks = from.map(() => '?').join(',');
    return this.db.transaction(() => {
      const prev = this.getOrder(shopifyOrderId)?.fulfillment_status ?? null;
      const r = this.db
        .prepare(
          `UPDATE orders SET fulfillment_status = ?, notes = COALESCE(?, notes),
             updated_at = datetime('now')
           WHERE shopify_order_id = ? AND fulfillment_status IN (${marks})`,
        )
        .run(to, notes ?? null, shopifyOrderId, ...from);
      if (r.changes === 1) this.logEvent(shopifyOrderId, prev, to, notes);
      return r.changes === 1;
    })();
  }

  setOrderNotes(shopifyOrderId: string, notes: string | null): void {
    this.db
      .prepare(
        `UPDATE orders SET notes = ?, updated_at = datetime('now') WHERE shopify_order_id = ?`,
      )
      .run(notes, shopifyOrderId);
  }

  listOrdersByStatus(statuses: string[]): OrderRecord[] {
    const marks = statuses.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM orders WHERE fulfillment_status IN (${marks}) ORDER BY id ASC`,
      )
      .all(...statuses) as OrderRecord[];
  }

  /** Orders from this email in the last 24h, excluding `excludeOrderId`. */
  countRecentOrdersForEmail(email: string, excludeOrderId: string): number {
    if (!email) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
         WHERE email = ? AND shopify_order_id != ?
           AND created_at >= datetime('now', '-1 day')`,
      )
      .get(email, excludeOrderId) as { n: number };
    return row.n;
  }

  getOrder(shopifyOrderId: string): OrderRecord | undefined {
    return this.db
      .prepare('SELECT * FROM orders WHERE shopify_order_id = ?')
      .get(shopifyOrderId) as OrderRecord | undefined;
  }

  listOrders(opts: { limit?: number; offset?: number } = {}): OrderRecord[] {
    if (opts.limit === undefined) {
      return this.db
        .prepare('SELECT * FROM orders ORDER BY id DESC')
        .all() as OrderRecord[];
    }
    return this.db
      .prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(opts.limit, opts.offset ?? 0) as OrderRecord[];
  }

  /**
   * Orders stuck in `forwarding` (crash or hang between claiming the order
   * and recording the supplier's answer) are moved to `needs_review`: the
   * supplier may or may not have the order, so a human must check. Never
   * auto-retried (could double-buy). Returns the affected order ids.
   */
  recoverStuckForwarding(olderThanMinutes: number): string[] {
    const mins = Math.max(1, Math.floor(olderThanMinutes));
    const rows = this.db
      .prepare(
        `SELECT shopify_order_id FROM orders
         WHERE fulfillment_status = 'forwarding'
           AND updated_at < datetime('now', ?)`,
      )
      .all(`-${mins} minutes`) as Array<{ shopify_order_id: string }>;
    const done: string[] = [];
    for (const r of rows) {
      if (
        this.transitionOrder(
          r.shopify_order_id,
          ['forwarding'],
          'needs_review',
          'Stuck while forwarding (crash or hang): check AutoDS for this order before releasing',
        )
      ) {
        done.push(r.shopify_order_id);
      }
    }
    return done;
  }

  /** Known supplier costs by SKU (published/staged products only). */
  getCostsBySku(skus: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const sku of new Set(skus.filter(Boolean))) {
      const row = this.db
        .prepare(
          `SELECT cost FROM product_mappings
           WHERE autods_sku = ? AND cost IS NOT NULL AND status != 'blocked'
           ORDER BY id DESC LIMIT 1`,
        )
        .get(sku) as { cost: number } | undefined;
      if (row) out.set(sku, row.cost);
    }
    return out;
  }

  /**
   * Atomically claim a product for publishing so a double click or retry
   * cannot create two Shopify listings. Returns false if someone else holds
   * it or it is already published/blocked.
   */
  claimProductForPublish(autodsProductId: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE product_mappings SET status = 'publishing', updated_at = datetime('now')
         WHERE autods_product_id = ? AND status NOT IN ('published','publishing','blocked')`,
      )
      .run(autodsProductId);
    return r.changes === 1;
  }

  /** Create a mapping row only if none exists; never touches an existing one. */
  ensureProductMapping(input: {
    autodsProductId: string;
    autodsSku?: string | null;
    cost?: number | null;
    sellPrice?: number | null;
    stock?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO product_mappings
           (autods_product_id, autods_sku, status, cost, sell_price, stock)
         VALUES (?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        input.autodsProductId,
        input.autodsSku ?? null,
        input.cost ?? null,
        input.sellPrice ?? null,
        input.stock ?? null,
      );
  }

  setProductStatus(autodsProductId: string, status: string): void {
    this.db
      .prepare(
        `UPDATE product_mappings SET status = ?, updated_at = datetime('now')
         WHERE autods_product_id = ?`,
      )
      .run(status, autodsProductId);
  }

  // ---- Sync state ----

  setSyncState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now')`,
      )
      .run(key, value);
  }

  getSyncState(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  // ---- AI content ----

  insertAiContent(input: {
    autodsProductId?: string | null;
    contentType: string;
    promptHash?: string | null;
    content: string;
    status?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }): AiContentRecord {
    const result = this.db
      .prepare(
        `INSERT INTO ai_content
           (autods_product_id, content_type, prompt_hash, content, status, input_tokens, output_tokens)
         VALUES (@autodsProductId, @contentType, @promptHash, @content, @status, @inputTokens, @outputTokens)`,
      )
      .run({
        autodsProductId: input.autodsProductId ?? null,
        contentType: input.contentType,
        promptHash: input.promptHash ?? null,
        content: input.content,
        status: input.status ?? 'draft',
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
      });

    return this.db
      .prepare('SELECT * FROM ai_content WHERE id = ?')
      .get(result.lastInsertRowid) as AiContentRecord;
  }

  findAiContentByHash(promptHash: string): AiContentRecord | undefined {
    return this.db
      .prepare(
        'SELECT * FROM ai_content WHERE prompt_hash = ? ORDER BY id DESC LIMIT 1',
      )
      .get(promptHash) as AiContentRecord | undefined;
  }

  findLatestAiContentForProduct(
    autodsProductId: string,
    contentType = 'product_content',
  ): AiContentRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM ai_content WHERE autods_product_id = ? AND content_type = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(autodsProductId, contentType) as AiContentRecord | undefined;
  }

  updateAiContentStatus(id: number, status: string): void {
    this.db
      .prepare('UPDATE ai_content SET status = ? WHERE id = ?')
      .run(status, id);
  }

  getAiContent(id: number): AiContentRecord | undefined {
    return this.db.prepare('SELECT * FROM ai_content WHERE id = ?').get(id) as
      AiContentRecord | undefined;
  }

  listAiContent(): AiContentRecord[] {
    return this.db
      .prepare('SELECT * FROM ai_content ORDER BY id DESC')
      .all() as AiContentRecord[];
  }

  // ---- Team members ----

  addTeamMember(input: {
    name: string;
    email: string;
    role: string;
    status?: string;
  }): TeamMemberRecord {
    this.db
      .prepare(
        `INSERT INTO team_members (name, email, role, status)
         VALUES (@name, @email, @role, @status)
         ON CONFLICT(email) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           status = excluded.status,
           updated_at = datetime('now')`,
      )
      .run({
        name: input.name,
        email: input.email,
        role: input.role,
        status: input.status ?? 'active',
      });

    return this.db
      .prepare('SELECT * FROM team_members WHERE email = ?')
      .get(input.email) as TeamMemberRecord;
  }

  updateTeamMemberStatus(id: number, status: string): void {
    this.db
      .prepare(
        `UPDATE team_members SET status = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(status, id);
  }

  listTeamMembers(): TeamMemberRecord[] {
    return this.db
      .prepare('SELECT * FROM team_members ORDER BY id ASC')
      .all() as TeamMemberRecord[];
  }
}
