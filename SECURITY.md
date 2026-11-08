# Security Policy

This is a private-use automation app (version 0.2.0, not published to any
registry). Only the latest commit is supported.

## Reporting a vulnerability

Email the maintainer, Calas Automations Inc., using the contact on the
account that gave you access to this repository. Do not open a public issue
with exploit details. No response time is promised.

## What the app protects

- `/admin` needs `ADMIN_TOKEN` (16+ characters) and refuses all calls without it.
- Webhooks are verified with HMAC-SHA256 on the raw body.
- Customer data can be exported and erased (`/admin/privacy/*`).
- Secrets come from environment variables only; never commit `.env`.
