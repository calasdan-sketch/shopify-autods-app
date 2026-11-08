# Round 5 notes

Author and copyright: Calas Automations Inc. No sub-agents were available in
this run, so one reviewer played every specialist in turn; each finding names
the command that proved it. Nothing called a live Shopify or supplier service.

## Author line
`package.json` author, `LICENSE` (new), `CLAUDE.md`, `SECURITY.md` say
"Calas Automations Inc."; `tests/round5.test.ts` pins it. This is a private
app, so no GitHub URL is placed in package metadata and none is claimed public.
Proof: `npm pack --json` then `tar -xzOf *.tgz package/package.json | grep author`.

## Baseline (before)
112 tests passing (54 s), lint, typecheck, format clean.
`npm run bench`: 860 wrong supplier orders -> 0. `npm run bench:r3`: 204 below-cost orders -> 0.
Registry upgrade test skipped as instructed (the package is private and unpublished).

## Specialists and findings
| Specialist | Finding | Proving command |
| --- | --- | --- |
| First-time user | README quick start `npm run dry-run` ended in FAIL since round 3 (demo order had no `subtotal_price`, fail-closed gate held it) | `npm run dry-run` on the pre-change tree (stash) |
| Shopify app developer | No `orders/cancelled` handler: a cancelled order could still be bought | `tests/round5.test.ts` "orders/cancelled ..." |
| Shopify app developer | No customer-data-request/redact or shop/redact webhooks (Shopify requires them for apps it reviews; custom-app obligations unverified) | grep of `src/routes/webhooks.ts` before; new tests |
| Shopify app developer | Default API version 2024-10 is likely past Shopify's support window (unverified) | startup warning added; not changed |
| AppSec | `SHOPIFY_SHOP` interpolated into the URL that receives the access token | test "never sends the token to a bad SHOPIFY_SHOP" |
| AppSec | `AUTODS_API_BASE` allowed `http://` | test "refuses a plain-http AutoDS base" |
| AppSec | Malformed JSON gave Express's HTML error with stack | curl on built app: now `{"error":"bad request"}` |
| AppSec | Bare token accepted without `Bearer` (equivalent mutant: length check already blocks it, so the scheme check is defence in depth) | mutation run |
| AppSec | `X-Powered-By` leaked; no nosniff | test "hides Express" |
| Dropship operator | Price could be 1 cent under its own floor (726 of 20,000 random) | property test + `npm run bench:r5` |
| GDPR/PIPEDA reviewer | Full customer payload stored forever, no erase/export | `bench:r5`: 5000 orders hold details before, 0 after |
| Supply chain / packaging | No LICENSE; `npm pack` would have shipped tests and bench | `npm pack --json` file list: dist + docs files only |
| Release engineer | Docker ran as root, no health check | Dockerfile edited; image NOT built (no daemon) |
| Performance | Erasing 5,000 orders blocks the process ~2.3 s | `npm run bench:r5` |

## Quality methods
- Property tests (seeded generator, no extra dependency): scrub never leaks seeded personal strings (150 random shapes); `cleanLine` and `sanitizeHtml` invariants; price clears floor (1000 cases; this found the rounding defect).
- Mutation sanity: 10 hand-made mutants (shop header check, domain regex anchor, email clearing, scrubbed guard, cancel transitions, error handler status, pricing round-up, margin re-check loop, Bearer check, ...). 8 killed. 2 survivors are equivalent: the Bearer-scheme check (token length check already refuses) and round-up (the re-check loop compensates). One mutant survived at first (scrubbed guard) and led to a new test.
- Golden/format: JSON error bodies and privacy request log shapes asserted exactly. No file output formats exist.
- Built-package run: `npm pack`, extract, prod-only modules, run `dist/index.js` from a directory with spaces, hit `/health`, `/admin`, signed webhook with curl: all as documented.

## Results
Tests 112 -> 140. Lint, typecheck, format, build clean. `bench:r5`: customer-detail rows after erase 5000 -> 0; prices under floor 726 -> 0.

## Ideas (value / differentiation / effort / risk, 1-5 where 5 = high)
| # | Idea | Value | Diff. | Effort | Risk | Status |
| - | --- | - | - | - | - | --- |
| 1 | Fix broken dry-run | 5 | 1 | 1 | 1 | DONE |
| 2 | orders/cancelled handling | 5 | 4 | 2 | 2 | DONE |
| 3 | Shopify privacy webhooks | 5 | 4 | 3 | 2 | DONE |
| 4 | Admin export/erase/purge | 4 | 4 | 2 | 2 | DONE |
| 5 | Optional retention job | 3 | 3 | 2 | 2 | DONE (untested schedule) |
| 6 | Shop-domain validation | 5 | 2 | 1 | 1 | DONE |
| 7 | https-only supplier URL | 4 | 1 | 1 | 1 | DONE |
| 8 | Shop header check | 3 | 2 | 1 | 1 | DONE |
| 9 | JSON error handler / headers | 3 | 1 | 1 | 1 | DONE |
| 10 | Bearer-scheme strict | 2 | 1 | 1 | 1 | DONE |
| 11 | Log redaction | 3 | 2 | 1 | 1 | DONE |
| 12 | Price round-up fix | 4 | 3 | 1 | 1 | DONE |
| 13 | Docker non-root + healthcheck | 3 | 1 | 1 | 2 | DONE (not built) |
| 14 | LICENSE, private flag, files list | 3 | 1 | 1 | 1 | DONE |
| 15 | Property + mutation tests | 3 | 2 | 2 | 1 | DONE |
| 16 | Startup message on unwritable DB | 2 | 1 | 1 | 1 | DONE |
| 17 | Move REST calls to GraphQL | 4 | 3 | 5 | 4 | NOT-DONE |
| 18 | Live stock/price sync from supplier | 5 | 4 | 4 | 3 | NOT-DONE |
| 19 | `orders/paid` + `refunds/create` webhooks | 4 | 3 | 3 | 2 | NOT-DONE |
| 20 | Per-user admin identity in audit trail | 3 | 3 | 3 | 2 | NOT-DONE |
| 21 | Batched erase (non-blocking for large shops) | 2 | 1 | 2 | 2 | NOT-DONE |
| 22 | Auto-pick current Shopify API version | 3 | 2 | 2 | 3 | NOT-DONE (needs verified rule) |
| 23 | Persistent rate limits (shared store) | 2 | 2 | 3 | 2 | NOT-DONE |
| 24 | Shopify order-risk (fraud) lookup in gate | 4 | 4 | 3 | 3 | NOT-DONE |
| 25 | Salted hash for privacy log subject | 2 | 1 | 1 | 1 | NOT-DONE |

## Competitors
README comparison reused as checked 2026-11-07 (AutoDS, DSers pricing pages). Not re-fetched in this round: unverified for today.

## Could not test
Windows; Docker image build (no reachable daemon); any live Shopify/AutoDS call; real privacy webhook payload shapes; the scheduled retention cron firing; registry upgrade path (skipped by instruction); multi-process concurrency (single process only).
