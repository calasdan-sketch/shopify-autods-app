# Changelog

## 0.2.0 (unreleased)

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
