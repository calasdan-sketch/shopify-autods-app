# Shopify + AutoDS Dropshipping Automation with Claude AI

An automation layer that connects a **Shopify** store to **AutoDS** (automated
dropshipping) and uses **Claude** (Anthropic API) to generate SEO product
content and score products for viability.

> **Status:** foundational scaffold. Core flows are implemented end-to-end with
> mocked-API tests. AutoDS endpoint paths are placeholders (its public API
> varies by plan) and should be confirmed against your account before going
> live.

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
```

## HTTP endpoints

| Method | Path                             | Purpose                             |
| ------ | -------------------------------- | ----------------------------------- |
| GET    | `/health`                        | Liveness probe                      |
| POST   | `/webhooks/shopify/orders/create`| Shopify order webhook (HMAC-verified) |
| POST   | `/webhooks/shopify/products/update` | Shopify product webhook           |
| POST   | `/webhooks/shopify/app/uninstalled` | App uninstall webhook             |
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

## Three-repository operating model

This repository is part of a larger agent-assisted business system spanning
three repositories in the `calasdan-sketch` account:

| Repository | Intended role |
| ---------- | ------------- |
| `calasdan-sketch/Repository-1` | Private operations control plane for sourcing, merchandising, fulfillment, and human review |
| `calasdan-sketch/repository1` | Public AI gateway/product surface used for external adoption and AI provider access |
| `calasdan-sketch/new-repository-` | Public business-ops hub for shared templates, onboarding, and lightweight runbooks |

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
