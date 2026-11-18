# Changelog

## 0.3.0 — 2026-11-18

Deploy in five minutes, and the key pool grows up.

- **One-command deploy:** `deploy/install.sh` (Docker + Caddy with automatic HTTPS + generated secrets),
  `deploy/docker-compose.yml`, multi-arch images on `ghcr.io/uurtech/tokener`, CI on every push.
- **Alerts:** Slack / Discord / Teams / generic webhook for keys that are rejected, out of credit or keep failing,
  pool exhaustion, recoveries and developer limits; throttled, test button and history in the console.
- **Team key groups:** keys reserved for developer teams, used first by that team, invisible to others.
- **Bedrock quotas:** per-key tokens/requests per minute tracked locally; keys are parked before throttling.
- **Shared key state:** cooldowns persisted in the store, shared across tasks (DynamoDB) and kept across restarts;
  rendezvous hashing assigns sessions consistently across tasks.
- **Monthly budgets** (USD and tokens) per developer, with headers, 429 message and alert.
- **Developer page `/me`** and a richer `/v1/me` (month totals, 14-day trend, reset times).
- **Admin SSO** with OpenID Connect (PKCE, JWKS verification, domain / e-mail allowlist, signed cookies, CSRF guard,
  actor in the audit log).
- **KMS envelope encryption** for pool keys (`KEY_POOL_KMS_KEY_ID`), created by the CDK and Marketplace stacks;
  automatic re-encryption when switching.
- Fixed: Dockerfile license label (MIT), `KEY_POOL_SECRET` passed through the local compose file.

## 0.2.0 — 2026-11-18

Key pool: many upstream keys, one endpoint.

- Add several Anthropic API keys and/or Bedrock API keys (any account, region, Mantle or Runtime) from the new
  **Keys** page or `PROVIDER_KEYS_JSON`. Developers keep one URL and token.
- Rotation strategies: per session (default, cache-friendly), round-robin, fill-first, least-used.
- Transparent failover: 429 / 529 / 5xx / 401 / 403 / out-of-credit answers and network errors retry the same request on
  the next key before anything is streamed; cooldowns follow `retry-after` and rate-limit reset headers.
- Proactive switching from Anthropic `anthropic-ratelimit-*` headers; optional per-key daily token / USD caps;
  optional fallback to the gateway's own AWS credentials.
- Secrets encrypted at rest (AES-256-GCM, `KEY_POOL_SECRET`), tested on save, never returned or logged.
- Per-key usage: `x-gateway-key` header, key column and CSV field on Requests, "By upstream key" on the Dashboard,
  key pool check in Diagnostics and `/health`.
- Developer self-service endpoint `GET /v1/me`.
- New smoke suite `test/smoke/smoke-keypool.mjs`; `npm run smoke` runs both suites.

## 0.1.0 — 2026-10-08

First Marketplace candidate.

- Gateway: Anthropic Messages API pass-through to Amazon Bedrock with SigV4 or Bedrock API key; both
  Bedrock APIs (Mantle Messages endpoint and classic Runtime InvokeModel) selectable per policy and per
  developer; live model catalog served to Claude Code via `/v1/models`.
- Cost control: per-developer daily USD budget and daily token limit with warn / downgrade / block, 80 %
  warning header, estimated savings per request, 14-day trend.
- Policies: request-class routing, effort fill/override, operator instruction, tool_result truncation,
  1-hour cache TTL, Bedrock bridging; editable live with preview before saving.
- Admin console: Dashboard, Requests (filters, live, CSV), Sessions, Developers (limits, API override,
  model allowlist, token rotation), Models (catalog + price editing), Policy, System (diagnostics, audit log).
- Marketplace packaging: parameterised CloudFormation template (HTTPS only, private subnets, admin CIDR
  gate, Secrets Manager admin token, BYO role / permissions boundary), RegisterUsage metering with
  entitlement gating, registration-failure alarm, release and deploy-test scripts, CI workflow.
