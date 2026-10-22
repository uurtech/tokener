# tokener 0.1.0

- Image: `tokener:0.1.0`
- Template: `tokener-marketplace.template.json` (sha256 in SHA256SUMS)
- Product code: <not baked; set MARKETPLACE_PRODUCT_CODE>
- Built: 2026-10-08T06:54:44Z

## Changes

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
