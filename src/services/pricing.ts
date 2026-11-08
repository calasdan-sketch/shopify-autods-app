/**
 * Pricing and unit-economics for dropshipped products.
 *
 * Margin is expressed as a share of the SELLING price (what accountants and
 * Shopify reports call "margin"), not as a markup on cost. All rates come from
 * configuration: card-processing fees differ by plan and country, so none are
 * hard-coded here. Look yours up in your Shopify admin and set them.
 */
export interface PricingConfig {
  /** Desired margin after fees, % of selling price. */
  targetMarginPct: number;
  /** Refuse to publish below this margin (after fees), % of selling price. */
  minMarginPct: number;
  /** Payment processing fee, % of selling price. */
  paymentFeePct: number;
  /** Fixed payment fee per order, in store currency. */
  paymentFixedFee: number;
  /** Round up to the next whole unit minus one cent (e.g. 24.31 -> 24.99). */
  charmPricing: boolean;
}

export interface UnitEconomics {
  price: number;
  cost: number;
  fees: number;
  /** price - cost - fees (before ads and refunds). */
  grossProfit: number;
  /** grossProfit / price * 100 */
  marginPct: number;
  /** Profit after the expected ad spend per order and refunds. */
  netProfitAfterAdsAndRefunds: number;
  /** Max ad spend per order that still breaks even. */
  breakEvenAdCostPerOrder: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Round UP to a whole cent (tiny epsilon absorbs float noise). */
const ceil2 = (n: number): number => Math.ceil(n * 100 - 1e-7) / 100;

export function validatePricingConfig(p: PricingConfig): void {
  const feeAndMargin = p.paymentFeePct + p.targetMarginPct;
  if (
    [
      p.targetMarginPct,
      p.minMarginPct,
      p.paymentFeePct,
      p.paymentFixedFee,
    ].some((n) => !Number.isFinite(n) || n < 0)
  ) {
    throw new Error('pricing config values must be finite and >= 0');
  }
  if (feeAndMargin >= 100) {
    throw new Error('paymentFeePct + targetMarginPct must be < 100');
  }
  if (p.minMarginPct > p.targetMarginPct) {
    throw new Error('minMarginPct must be <= targetMarginPct');
  }
}

/**
 * Smallest price that yields `targetMarginPct` after fees:
 *   price = (cost + fixedFee) / (1 - feePct - marginPct)
 */
export function computeSellPrice(cost: number, p: PricingConfig): number {
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error(`invalid supplier cost: ${cost}`);
  }
  validatePricingConfig(p);
  const denom = 1 - (p.paymentFeePct + p.targetMarginPct) / 100;
  let price = (cost + p.paymentFixedFee) / denom;
  if (p.charmPricing) {
    price = Math.ceil(price) - 0.01;
    if (price < (cost + p.paymentFixedFee) / denom) price += 1;
  }
  // Round up, never down: rounding down could land a hair under the margin
  // floor and make the app refuse its own price.
  let out = ceil2(price);
  // Fees are rounded to cents in unitEconomics, which can shave a hair off the
  // margin; step up a cent at a time (bounded) until the target is met.
  for (let i = 0; i < 5; i++) {
    if (unitEconomics(out, cost, p).marginPct + 1e-9 >= p.targetMarginPct)
      break;
    out = round2(out + 0.01);
  }
  return out;
}

export function unitEconomics(
  price: number,
  cost: number,
  p: PricingConfig,
  opts: { adCostPerOrder?: number; refundRatePct?: number } = {},
): UnitEconomics {
  const fees = round2((price * p.paymentFeePct) / 100 + p.paymentFixedFee);
  const grossProfit = round2(price - cost - fees);
  const marginPct = price > 0 ? round2((grossProfit / price) * 100) : 0;
  const refund = ((opts.refundRatePct ?? 0) / 100) * price;
  const ad = opts.adCostPerOrder ?? 0;
  return {
    price,
    cost,
    fees,
    grossProfit,
    marginPct,
    netProfitAfterAdsAndRefunds: round2(grossProfit - ad - refund),
    breakEvenAdCostPerOrder: Math.max(0, round2(grossProfit - refund)),
  };
}

/** True when the listing clears the configured margin floor. */
export function meetsMarginFloor(
  price: number,
  cost: number,
  p: PricingConfig,
): boolean {
  return unitEconomics(price, cost, p).marginPct + 1e-9 >= p.minMarginPct;
}
