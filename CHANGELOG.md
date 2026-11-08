# Changelog

## 0.2.0 (unreleased)

Round 5 (privacy, cancellations, hardening, tests 112 -> 140)
- Fixed: `npm run dry-run` ended in FAIL (demo order lacked `subtotal_price`).
- Fixed: computed price could be 1 cent under its own margin floor.
- Added: `orders/cancelled` handling; Shopify privacy webhooks; admin export/erase/purge; optional `DATA_RETENTION_DAYS` (default off); `privacy_requests` table (additive).
- Security: `SHOPIFY_SHOP` must be `*.myshopify.com`; `AUTODS_API_BASE` must be https; shop-domain header check; JSON errors without stack; Bearer scheme required; log redaction; Docker non-root with health check.
- Author/maintainer and copyright: Calas Automations Inc.; added LICENSE; package marked `private` with a `files` list; SECURITY.md rewritten.
- Behaviour change: scrubbed orders cannot be forwarded; a bare token without `Bearer` is now refused.

Round 3 (hardening, tests 86 -> 112)
- Webhook: signed non-object body no longer hangs/crashes (400); 400 vs 401 vs 503 distinguished; limit default 600/min, `WEBHOOK_RATE_LIMIT_PER_MIN`.
- Publish and auto-import are exactly-once (`publishing` claim); `reset-publish` admin override; margin floor re-checked at publish; blocked products can be re-imported.
- Gate: below-cost (discount) hold, gift card / non-shipping / over-25-line holds, optional known-SKU rule, reasons sanitised, line scan capped.
- `forwarding` orders stuck over 15 min go to `needs_review`.
- Admin: failed-auth throttle, order paging (`limit`/`offset`), `/orders/:id/events` audit trail, 404 on unknown content approve, email check on team add.
- Sanitisers: bounded and linear on hostile input; tracking numbers cleaned before Shopify.
- `TRUST_PROXY_HOPS`; unhandled-rejection logging; startup warnings for missing admin token / webhook secret.
- New `npm run bench:r3`. Additive migration: `order_events` table.
- Behaviour change: orders for known products with `subtotal_price` below cost are now held (disable with `RISK_HOLD_BELOW_COST=false`).

Added
- Margin engine (`src/services/pricing.ts`): price from cost, fees, target margin; margin floor; unit economics and break-even ad spend.
- Order risk gate (`src/services/order-gate.ts`) and held-order admin endpoints.
- Exactly-once supplier order claim, crash recovery, `needs_review` for unknown outcomes.
- `ADMIN_TOKEN` bearer auth for `/admin` (fails closed).
- `POST /admin/products/:id/publish`; staged listings are stored for approval.
- HTML/bidi/control sanitising for published content; supplier text fenced in prompts.
- Stock and blocked-term checks at import; `npm run bench`.
- Additive DB migrations (order notes/email, product cost/price/stock).

Changed (behaviour)
- Listings are priced from cost with a margin (was: price = supplier cost).
- Shopify fulfilment uses the FulfillmentOrder endpoints (unverified live).
- Supplier-order, product-create and fulfilment POSTs are no longer retried on timeout/5xx; Retry-After is capped at 60s.
- `/admin` now requires `ADMIN_TOKEN`; `/admin/orders` omits raw payloads unless `?raw=1`.
- Claude content prompt no longer includes the supplier price.
- Order webhooks are stored before the 200 acknowledgement; body limit 2mb.
- Tracking sync continues past a failing order.
- Test fixture `tests/helpers.ts` gained the new config sections (risk gate off there).

Tests: 44 -> 86. Lint, format, typecheck, build clean.
