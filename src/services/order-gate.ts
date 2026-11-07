import { cleanLine } from '../lib/sanitize.js';

/**
 * Pre-fulfilment checks. Forwarding an order to a supplier spends real money
 * that cannot be recovered from a fraudulent, unpaid or malformed order, so
 * anything doubtful is HELD for a human instead of auto-forwarded.
 *
 * Works only from the order-created webhook payload. Shopify's own fraud
 * analysis (order risk) is NOT in that payload; see README "Limits".
 */
export interface RiskConfig {
  enabled: boolean;
  requirePaid: boolean;
  maxQuantityPerLine: number;
  maxOrderValue: number;
  /** ISO-3166 alpha-2 codes; empty = no restriction. */
  allowedCountries: string[];
  /** Hold when this many orders from the same email arrived in the last 24h. */
  maxOrdersPerEmailPerDay: number;
  /** Hold unforwarded orders older than this many days (stale backlog). */
  maxOrderAgeDays: number;
  /** Hold orders with more line items than this (0 = no limit). */
  maxLineItems?: number;
  /** Hold when the paid goods total is below the known supplier cost. */
  holdBelowCost?: boolean;
  /** Hold when a line's SKU is not a product this app listed. */
  requireKnownSku?: boolean;
}

export interface GateResult {
  allow: boolean;
  reasons: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function evaluateOrder(
  order: Obj,
  risk: RiskConfig,
  ctx: {
    recentOrdersForEmail?: number;
    now?: Date;
    /** Supplier cost per SKU for products this app knows about. */
    costBySku?: Map<string, number>;
  } = {},
): GateResult {
  if (!risk.enabled) return { allow: true, reasons: [] };
  const reasons: string[] = [];

  if (order.cancelled_at) reasons.push('order is cancelled');
  if (order.test === true) reasons.push('test order');
  if (risk.requirePaid && str(order.financial_status) !== 'paid') {
    reasons.push(
      `financial_status is "${str(order.financial_status) || 'missing'}", not "paid"`,
    );
  }

  const items = Array.isArray(order.line_items) ? order.line_items : [];
  if (items.length === 0) reasons.push('no line items');
  const maxLines = risk.maxLineItems ?? 25;
  if (maxLines > 0 && items.length > maxLines) {
    reasons.push(`${items.length} line items > ${maxLines}`);
  }
  // Only inspect the first 200 lines: a hostile payload cannot make us loop
  // over millions of entries (the count above already holds the order).
  items.slice(0, 200).forEach((raw, i) => {
    const item = isObj(raw) ? raw : {};
    if (item.gift_card === true) reasons.push(`line ${i + 1}: gift card`);
    if (item.requires_shipping === false) {
      reasons.push(`line ${i + 1}: does not require shipping (digital?)`);
    }
    if (
      risk.requireKnownSku &&
      str(item.sku) &&
      ctx.costBySku &&
      !ctx.costBySku.has(str(item.sku))
    ) {
      reasons.push(`line ${i + 1}: SKU not listed by this app`);
    }
    if (!str(item.sku)) reasons.push(`line ${i + 1}: missing SKU`);
    const q = Number(item.quantity ?? 1);
    if (!Number.isInteger(q) || q < 1) {
      reasons.push(`line ${i + 1}: invalid quantity`);
    } else if (q > risk.maxQuantityPerLine) {
      reasons.push(`line ${i + 1}: quantity ${q} > ${risk.maxQuantityPerLine}`);
    }
  });

  const ship = isObj(order.shipping_address) ? order.shipping_address : null;
  if (!ship) {
    reasons.push('no shipping address');
  } else {
    for (const f of ['address1', 'city', 'zip']) {
      if (!str(ship[f])) reasons.push(`shipping address missing ${f}`);
    }
    const cc = str(ship.country_code).toUpperCase();
    if (!cc) reasons.push('shipping address missing country_code');
    else if (
      risk.allowedCountries.length > 0 &&
      !risk.allowedCountries.includes(cc)
    ) {
      reasons.push(`shipping country ${cc} not in allowed list`);
    }
    const bill = isObj(order.billing_address) ? order.billing_address : null;
    const bc = bill ? str(bill.country_code).toUpperCase() : '';
    if (cc && bc && cc !== bc) {
      reasons.push(`billing country ${bc} differs from shipping country ${cc}`);
    }
  }

  if (risk.holdBelowCost !== false && ctx.costBySku && ctx.costBySku.size) {
    let cost = 0;
    for (const raw of items.slice(0, 200)) {
      const item = isObj(raw) ? raw : {};
      const c = ctx.costBySku.get(str(item.sku));
      const q = Number(item.quantity ?? 1);
      if (c !== undefined && Number.isFinite(q) && q > 0) cost += c * q;
    }
    // subtotal_price = goods after discounts, before shipping and tax.
    const sub = Number(order.subtotal_price);
    if (cost > 0 && !Number.isFinite(sub)) {
      reasons.push(
        'subtotal_price missing: cannot check the order covers cost',
      );
    } else if (cost > 0 && sub < cost) {
      reasons.push(
        `goods total ${sub} is below supplier cost ${Math.round(cost * 100) / 100} (discount or free order)`,
      );
    }
  }

  const total = Number(order.total_price);
  if (Number.isFinite(total) && total > risk.maxOrderValue) {
    reasons.push(`order value ${total} exceeds ${risk.maxOrderValue}`);
  }

  if (
    risk.maxOrdersPerEmailPerDay > 0 &&
    (ctx.recentOrdersForEmail ?? 0) >= risk.maxOrdersPerEmailPerDay
  ) {
    reasons.push(
      `${ctx.recentOrdersForEmail} other orders from this email in 24h`,
    );
  }

  const created = Date.parse(str(order.created_at));
  if (Number.isFinite(created) && risk.maxOrderAgeDays > 0) {
    const ageDays = ((ctx.now ?? new Date()).getTime() - created) / 86_400_000;
    if (ageDays > risk.maxOrderAgeDays) {
      reasons.push(`order is ${Math.floor(ageDays)} days old`);
    }
  }

  // Reasons embed untrusted payload text (country codes, status): clean it.
  const clean = reasons.map((r) => cleanLine(r, 200));
  return { allow: clean.length === 0, reasons: clean };
}
