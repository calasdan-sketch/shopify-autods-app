# Shopify + AutoDS Dropshipping Automation with Claude AI

An automation layer that connects a **Shopify** store to **AutoDS** (automated
dropshipping) and uses **Claude** (Anthropic API) to generate SEO product
content and score products for viability.

> **Status:** foundational scaffold. Core flows are implemented end-to-end with
> mocked-API tests. AutoDS endpoint paths are placeholders (its public API
> varies by plan) and should be confirmed against your account before going
> live.

**In one line:** the Shopify + AutoDS glue that refuses to lose money: no
duplicate or unpaid supplier orders, no listings at cost, no open admin API.

## Round 5 additions (still 0.2.0, unreleased)

Found by a Shopify app developer, a dropshipping operator, an application
security reviewer and a GDPR/PIPEDA reviewer (details and the commands that
proved each: `docs/ROUND5.md`):

| Problem found | Fix |
| --- | --- |
| `npm run dry-run` (the quick start) ended in **FAIL** since round 3 | Demo order now carries `subtotal_price`; a test runs it |
| A customer cancelling in Shopify after the order arrived was ignored: the app could still buy it from the supplier | `orders/cancelled` webhook closes unsent orders; after the supplier order it parks the order in `supplier_issue` ("cancel it at AutoDS") |
| Customer names, addresses, phones were kept forever in `raw_payload` | Shopify's three privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`), `GET /admin/privacy/export`, `POST /admin/privacy/erase`, `POST /admin/privacy/purge`, optional `DATA_RETENTION_DAYS`. Totals, SKUs and quantities are kept |
| A mistyped `SHOPIFY_SHOP` (e.g. `evil.com/x#`) would receive your Shopify access token | Must be `name.myshopify.com`, else refused (and the app will not start) |
| `AUTODS_API_BASE` over plain `http://` would send the AutoDS token in clear | Refused; must be `https://` |
| Webhooks for another shop (header mismatch) were accepted if signed | Rejected when `X-Shopify-Shop-Domain` is present and not yours |
| Bad JSON / oversize bodies returned an HTML page with a stack trace | Short JSON errors; unknown paths give JSON 404; `X-Powered-By` removed; `nosniff`, `no-store` |
| Admin accepted the bare token without `Bearer` | `Bearer` required |
| Computed price could land one cent under its own margin floor (726 of 20,000 random cases) | Price rounds up and is re-checked |
| Logs could carry tokens or customer contact fields | pino redaction |
| Docker ran as root | Runs as `node`, health check, `/app/data` volume |
| No LICENSE file; stale Python description in `CLAUDE.md`; boilerplate `SECURITY.md` | Fixed. Author and copyright: Calas Automations Inc. |

Register the extra Shopify webhooks (HTTPS) for `orders/cancelled`,
`customers/data_request`, `customers/redact` and `shop/redact` at
`/webhooks/shopify/<topic>`. Re-run `npm run bench:r5`.

## Round 3 additions (still 0.2.0, unreleased)

Found by a webhook attacker, a Shopify app reviewer, a finance auditor, a
reliability engineer, a docs reviewer and a hostile-input fuzzer:

| Problem found | Fix |
| --- | --- |
| A validly signed webhook body of `null` hung the request and raised an unhandled rejection | Non-object bodies get 400; bad JSON is 400 (not 401); missing secret is 503; process logs stray rejections |
| Clicking publish twice (or re-importing in auto mode) created **two Shopify products** (measured: 10 clicks, 10 products) | Atomic `publishing` claim; 4xx releases it, unknown outcome keeps it; `POST /admin/products/:id/reset-publish` after you check Shopify |
| Orders with a 100% discount code were bought from the supplier at a loss (measured: 204 of 1000 in the bench) | Gate holds orders whose `subtotal_price` is below known supplier cost; fails closed if the field is missing |
| Gift cards, non-shipping lines and 1000-line orders were forwarded | Held; line scan capped at 200 lines |
| Order stuck in `forwarding` after a crash was never looked at | Moved to `needs_review` after 15 min (never auto-retried) |
| Unlimited guesses at `ADMIN_TOKEN` | 10 failed attempts per 15 min per IP, then 429 |
| Webhook limit 120/min could 429 a flash sale (Shopify then retries and may drop the subscription) | Default 600/min, `WEBHOOK_RATE_LIMIT_PER_MIN` |
| Staged price approved days ago ignored a raised margin floor | Re-checked at publish |
| No history of why an order was held/released | Append-only `order_events`, `GET /admin/orders/:id/events` |
| Multi-megabyte supplier text stalled the sanitiser (quadratic regexes, 1.4 s on 2 MB) | Bounded and linear (8 ms) |

New settings: `RISK_MAX_LINE_ITEMS` (25), `RISK_HOLD_BELOW_COST` (on),
`RISK_REQUIRE_KNOWN_SKU` (off), `WEBHOOK_RATE_LIMIT_PER_MIN`,
`TRUST_PROXY_HOPS` (set to 1 behind one reverse proxy so limits see real IPs).
Re-run `npm run bench:r3`.

## What 0.2 adds (expert-review round)

Found by testing as a dropshipping operator, a Shopify app developer, a
margin analyst, a fraud/compliance reviewer and a first-time merchant:

| Problem found in 0.1 | Fix in 0.2 |
| --- | --- |
| Products were listed at the **supplier cost** (0% margin) | Margin engine: price from cost, fees and target margin; refuses to list below the margin floor |
| A replayed or concurrent order webhook placed the **supplier order again** and reset fulfilled orders to `received` | Atomic claim per order: exactly one supplier order, replays are no-ops |
| Unpaid, cancelled, test, address-less or oversized orders were forwarded to the supplier | Risk gate holds them for a human (`/admin/orders/held`, `/release`) |
| A timed-out supplier POST was retried blindly (could double-buy) | Non-idempotent calls retry only on HTTP 429; unknown outcome parks the order in `needs_review` |
| `/admin` (orders, customer addresses, import) had **no authentication** | Bearer `ADMIN_TOKEN`; unset means every admin call is refused (fail closed) |
| "Approve" never published anything (dead-end human-in-the-loop) | `POST /admin/products/:id/publish` publishes approved listings |
| Order stored only after the 200 was sent (lost on crash) | Stored first; scheduler recovers stuck orders |
| One failed order aborted the whole tracking sync | Per-order isolation; supplier cancellations flagged |
| LLM/supplier text published unsanitised (HTML/bidi/prompt injection) | Allow-list HTML sanitiser, control/bidi stripping, supplier text fenced in the prompt |
| Out-of-stock and brand/restricted-term products could be listed | Stock check and configurable blocked terms (starter list; tune it) |
| Fulfilment used the retired order-level endpoint | FulfillmentOrder flow (`/fulfillment_orders.json` then `/fulfillments.json`), **untested against a live store** |

### Benchmark (re-run: `npm run bench`)

Simulated traffic: 2,000 orders, 2,608 webhook deliveries (30% duplicated),
8% unpaid, 4% cancelled, 1% test. The OLD column re-implements 0.1 behaviour.

| Metric | 0.1 behaviour | 0.2 |
| --- | ---: | ---: |
| Supplier orders placed | 2608 | 1748 |
| Wrong supplier orders | 860 | 0 |
| Money spent on wrong orders (14.50 each) | 12470.00 | 0.00 |
| Listing price of a 14.50 item | 14.50 | 20.99 |
| Margin before fees | 0% | 30.9% |

This is a simulation of the stated mix, not a measurement of a real store.

### How it compares (read from vendor pricing pages, re-checked 2026-11-07)

| | This repo | AutoDS | DSers |
| --- | --- | --- | --- |
| Cost | Free (MIT); you pay for Claude API use | Paid; page advertises a 3-day trial at $0.99/$1 (inconsistent on the page), auto-ordering add-on $9.90/mo, plan prices not shown to us ([pricing](https://www.autods.com/pricing/)) | Free Basic; Advanced $19.9/mo, Pro $49.90/mo, Enterprise $499.9/mo ([pricing](https://www.dsers.com/pricing)) |
| AI listing text | Yes (Claude) | Yes, plus a "Claude AI chat-to-sell" feature (per pricing page) | AI image tools; AI optimisations on paid plans |
| Auto order forwarding | Yes, with risk gate and exactly-once claim | Yes (vendor feature; internal safeguards unverified) | Bulk order automation, address auto-fix |
| Tracking sync | Yes | Yes | Yes (14 to 21 day sync windows by plan) |
| Auto pricing / stock sync | Pricing from margin engine; stock check at import only (no live stock sync yet) | Yes | Yes |
| Duplicate / below-cost order protection | Yes (exactly-once claim, loss guard) | Not mentioned on pricing page; internal safeguards unverified | Not mentioned on pricing page |
| Supplier/product research, ad spy | No | Yes | Trending products |
| Self-hosted, auditable, your data | Yes | No | No |
| Needs your own Shopify custom app and webhooks | Yes | No | No |

Zendrop, Spocket, Shopify Flow and Sidekick were **not** reviewed this round
(unverified). Honest summary: the commercial tools win on product research,
supplier networks and polish. This repo wins on being free, inspectable and
safe-by-default for order handling, and on the margin/fraud rules being yours.

### Limits (be honest with yourself)

- Round 5 additions that were **not run against a live store**: the privacy
  and cancel webhook payload shapes follow Shopify's documentation as we
  recall it (unverified). Erasure runs inside the request and takes roughly
  0.5 ms per order on the test machine (2.3 s for 5,000 orders).
- Erasing keeps order totals, SKUs and quantities. How long you must keep
  sales records is a tax question for your accountant (unverified here); set
  `DATA_RETENTION_DAYS` only after asking. Backups and Shopify itself keep their own copies.
- A cancel that arrives in the few milliseconds while an order is being sent
  to the supplier can be overwritten by the send result; check `needs_review` orders.
- `SHOPIFY_API_VERSION` defaults to `2024-10`; the app warns when the value is
  over 12 months old (Shopify's support window is from memory, unverified).
- Not tested on Windows. Windows needs build tools for `better-sqlite3`.

- The below-cost check uses `subtotal_price` and the cost stored when the
  product was imported; it assumes both are in the same currency (store
  currency) and ignores payment fees. Field names follow Shopify's REST order
  payload as we understand it and were not run against a live store.
- A product left in `publishing` after a timeout needs a human: check Shopify,
  then call `reset-publish`. There is no automatic reconciliation with Shopify.
- Rate limits are per IP and in memory (reset on restart, not shared across
  several instances). Auth-failure throttling needs `TRUST_PROXY_HOPS` behind a proxy.
- `order_events` records status changes only, not who made them (one shared admin token).

- The AutoDS client paths are still placeholders; use `AUTODS_MODE=mock`
  until you have API access. Whether AutoDS de-duplicates on
  `external_order_id` is unverified, so the app does not rely on it.
- The risk gate sees only the webhook payload. Shopify's own fraud analysis
  is not consulted; keep reviewing flagged orders in Shopify.
- Fulfilment and product calls were not run against a live store.
- Shopify's REST Admin API is legacy since 2024-10-01 and new public apps
  must use GraphQL ([Shopify docs](https://shopify.dev/docs/api/admin-rest)).
  A private custom app on REST still works but plan a GraphQL move.
- Fee rates are yours to set (`PRICING_*`); defaults are 0 and a 30% margin
  target is a policy choice, not advice. Blocked-terms list is a starter.
- Compliance (customs, product safety, sales tax, supplier terms) is your
  responsibility; nothing here is legal advice.

## Features

- **Shopify integration** — create/update products, manage inventory, read
  orders, create fulfillments, and verify inbound webhooks via HMAC.
- **AutoDS integration** — source products, forward orders for fulfillment, and
  poll for tracking numbers.
- **Claude AI** — generate SEO titles/descriptions/bullets/tags and score
  candidate products, with prompt-hash caching and token accounting.
- **Orchestration** — end-to-end "source → generate → publish → fulfill → sync"
  flow with a **human-in-the-loop** toggle (`AUTO_PUBLISH` / `AUTO_FULFILL`).
- **Scheduler** — recurring tracking-sync job (cron).
- **Admin API** — inspect mappings/orders/AI content, trigger imports, and
  approve staged content.
- **System plan endpoint** — expose a machine-readable three-repository business
  operating plan for future agents and maintainers.

## Architecture

```
Shopify  ──webhooks──▶  /webhooks/shopify ──▶  Orchestrator ──▶  AutoDS
   ▲                                              │   │
   │ Admin API / fulfillment                      │   └─▶ Claude (content/scoring)
   └──────────────────────────────────────────────┘
                         SQLite datastore (mappings, orders, sync state, AI content)
```

| Layer            | Location            |
| ---------------- | ------------------- |
| Config (env)     | `src/config`        |
| Services         | `src/services`      |
| HTTP routes      | `src/routes`        |
| Jobs / workflows | `src/jobs`          |
| Datastore        | `src/models`        |
| Shared utilities | `src/lib`           |
| Tests            | `tests`             |

## Requirements

- Node.js >= 20
- npm

## Run it now, with no AutoDS account (mock / dry-run mode)

AutoDS only hands out its API docs after activation, so the real client is
still a placeholder. Until then the app has a built-in **mock AutoDS** so the
whole pipeline can run today:

```bash
npm install
npm run dry-run
```

`dry-run` walks source → generate → publish → fulfill → track in one go with
zero credentials (mock AutoDS, stubbed Shopify and Claude, in-memory SQLite)
and prints each step. It ends with `PASS` when every stage completed.

To run the real server against **real Shopify + Claude** but a **fake AutoDS**,
set in `.env`:

```
AUTODS_MODE=mock
```

The mock serves a small sample catalogue (`mock-1001`, `mock-1002`,
`mock-1003` — the last one is out of stock on purpose), accepts orders, and
reports `shipped` with a `MOCKTRK…` tracking number on the next sync. Switch
to `AUTODS_MODE=live` once the token and confirmed endpoint paths arrive;
nothing else changes.

## Setup

```bash
npm install
cp .env.example .env   # then fill in credentials
```

### Required credentials

| Variable                 | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `SHOPIFY_SHOP`           | Store domain, e.g. `my-store.myshopify.com`              |
| `SHOPIFY_ACCESS_TOKEN`   | Admin API access token from your custom app              |
| `SHOPIFY_WEBHOOK_SECRET` | Secret used to verify inbound webhook HMAC signatures    |
| `AUTODS_API_TOKEN`       | AutoDS API token (plan-dependent)                        |
| `AUTODS_STORE_ID`        | AutoDS store id                                          |
| `ANTHROPIC_API_KEY`      | Anthropic API key for Claude                             |
| `ADMIN_TOKEN`            | Secret for `/admin` (min 16 chars); unset = admin disabled |

Secrets are read from environment variables only and must never be committed.

### Claude cost controls

- Every Claude call sends its system prompt as an ephemeral **prompt-cache**
  breakpoint, so repeat calls reuse cached input tokens instead of paying full
  price for the (unchanged) instructions on every request. Identical prompts
  are also deduplicated at the application layer via a prompt-hash cache in
  the datastore.
- `CLAUDE_PROVIDER` can be set to `openrouter` to route requests through
  [OpenRouter](https://openrouter.ai) instead of calling Anthropic directly —
  useful for price-shopping across providers/models. Requires
  `OPENROUTER_API_KEY` and, optionally, `OPENROUTER_MODEL` (see
  `.env.example`). Prompt caching currently only applies to the direct
  `anthropic` provider.

### Automation behaviour

- `AUTO_PUBLISH=false` — AI content is staged for manual approval (recommended).
- `AUTO_FULFILL=false` — orders are recorded but not auto-forwarded to AutoDS.
- `SYNC_CRON` — cron expression for the recurring tracking-sync job.

## Scripts

```bash
npm run dev          # run in watch mode (tsx)
npm run build        # compile TypeScript to dist/
npm start            # run the compiled server
npm test             # run the test suite (vitest)
npm run lint         # eslint
npm run format       # prettier --write
npm run typecheck    # tsc --noEmit
npm run bench        # order-safety + pricing benchmark (no network)
```

## HTTP endpoints

| Method | Path                             | Purpose                             |
| ------ | -------------------------------- | ----------------------------------- |
| GET    | `/health`                        | Liveness probe                      |
| POST   | `/webhooks/shopify/orders/create`| Shopify order webhook (HMAC-verified) |
| POST   | `/webhooks/shopify/products/update` | Shopify product webhook           |
| POST   | `/webhooks/shopify/app/uninstalled` | App uninstall webhook             |
| POST   | `/webhooks/shopify/orders/cancelled` | Order cancelled in Shopify        |
| POST   | `/webhooks/shopify/customers/data_request`, `/customers/redact`, `/shop/redact` | Shopify privacy webhooks |
| GET    | `/admin/privacy/export?email=`   | Everything stored about one customer |
| POST   | `/admin/privacy/erase`, `/admin/privacy/purge` | Erase one customer / scrub orders older than N days (>= 30) |
| GET    | `/admin/privacy/requests`        | Log of privacy requests (emails stored only as hashes) |
| GET    | `/admin/store`                   | Display the connected Shopify store |
| GET    | `/admin/products`                | List product mappings               |
| GET    | `/admin/orders`                  | List orders                         |
| GET    | `/admin/ai-content`              | List generated AI content           |
| GET    | `/admin/system-plan`             | Inspect the multi-repo operating plan |
| GET    | `/admin/team`                    | List development team members       |
| POST   | `/admin/team`                    | Add (or update, by email) a development team member |
| POST   | `/admin/team/:id/deactivate`     | Deactivate a development team member |
| POST   | `/admin/products/import`         | Import + generate content for a product |
| POST   | `/admin/ai-content/:id/approve`  | Approve staged AI content           |
| POST   | `/admin/products/:id/publish`    | Publish an approved staged listing  |
| GET    | `/admin/orders/held`             | Orders held by the risk gate / failures |
| POST   | `/admin/orders/:id/release`      | Human override: forward a held order |

All `/admin` calls need `Authorization: Bearer $ADMIN_TOKEN` (min 16 chars).

## Three-repository operating model

This repository is part of a larger agent-assisted business system spanning
three repositories in the `calasdan-sketch` account:

| Repository | Intended role |
| ---------- | ------------- |
| `calasdan-sketch/Repository-1` | Operations control plane for sourcing, merchandising, fulfillment, and human review (intended to stay private) |
| `calasdan-sketch/repository1` | AI gateway/product surface used for external adoption and AI provider access (intended visibility: public; not checked here) |
| `calasdan-sketch/new-repository-` | Business-ops hub for shared templates, onboarding, and lightweight runbooks (intended visibility: public; not checked here) |

The admin endpoint `GET /admin/system-plan` returns this split as JSON so future
agents can discover the intended handoffs programmatically before making
changes. The same response includes a `developmentTeam` roster describing the
roles (human and agent) that maintain the system:

| Role                        | Focus                                            | Primary repository |
| ---------------------------- | ------------------------------------------------ | ------------------- |
| Operations Lead              | Human-in-the-loop review and go-live readiness   | `Repository-1`      |
| Automation Engineer          | Orchestration, scheduler, and admin API surface  | `Repository-1`      |
| AI Gateway Engineer          | Multi-provider AI routing and public tool access | `repository1`       |
| Docs & Onboarding Maintainer | Cross-repository runbooks and onboarding         | `new-repository-`   |
| Coding Agent (Claude)        | Implementation, content generation, scoring      | `Repository-1`      |
| Copywriter Agent             | Product/brand copy for listings                 | `Repository-1`      |
| Marketing Agent              | Product viability and go-to-market messaging     | `Repository-1`      |
| Design Agent                 | Visual presentation of products and storefront   | `Repository-1`      |

Actual people/agents filling these roles are tracked at runtime via the
`/admin/team` endpoints (backed by the `team_members` table), so the roster
above stays as role definitions while membership can change without a code
change.

## Docker

```bash
docker build -t shopify-autods-claude .
docker run --env-file .env -p 3000:3000 shopify-autods-claude
```

## Notes & next steps

- Confirm AutoDS API endpoints/authentication for your plan and adjust
  `src/services/autods.ts` accordingly.
- Add a UI on top of the admin API if a dashboard is desired.
- Register Shopify webhooks pointing at the `/webhooks/shopify/*` endpoints over
  HTTPS.
