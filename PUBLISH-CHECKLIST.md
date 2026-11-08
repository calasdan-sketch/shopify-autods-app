# Release checklist (plain words)

This project is an app you run yourself, not a library on npm. It is marked
`"private": true`, so `npm publish` is refused on purpose. "Releasing" means
deploying it. Nothing below has been run for you.

**Version to release:** 0.2.0 (nothing has been tagged or deployed yet, so no
version bump is needed). Moving from the earlier 0.2.0 work is not breaking
for the database: one new table is added automatically.

## Check first (about 15 minutes)

1. In a terminal inside the project folder: `npm ci`, then `npm run lint`,
   `npm run typecheck`, `npm test`, `npm run dry-run`. The last line of
   dry-run must say `PASS`.
2. In `.env` set `SHOPIFY_SHOP` to `your-store.myshopify.com` exactly (no
   https://), `ADMIN_TOKEN` (16+ characters), `SHOPIFY_WEBHOOK_SECRET`.
   Keep `AUTODS_MODE=mock` until AutoDS gives you real API access.
3. Set `SHOPIFY_API_VERSION` to a version Shopify currently supports (look
   at shopify.dev, "API versioning"). The built-in default is old.
4. In Shopify, register webhooks to `https://YOUR-HOST/webhooks/shopify/...`
   for: `orders/create`, `orders/cancelled`, `app/uninstalled`,
   `customers/data_request`, `customers/redact`, `shop/redact`.
5. Decide `DATA_RETENTION_DAYS` with your accountant (0 = keep customer
   details forever).

## Deploy

    docker build -t shopify-autods-claude .
    docker run --env-file .env -p 3000:3000 -v autods-data:/app/data shopify-autods-claude

(Docker was not available where this was prepared, so the image is untested.)
Without Docker: `npm ci && npm run build && npm start`.

## After deploy

- `curl https://YOUR-HOST/health` should answer `{"status":"ok"}`.
- Leave `AUTO_FULFILL=false` until you have watched a few real test orders.
