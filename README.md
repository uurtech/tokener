<div align="center">

<img src="docs/assets/banner.svg" alt="tokener — Claude Code on Amazon Bedrock, without the token bill shock" width="100%">

<br>

[![License: MIT](https://img.shields.io/badge/license-MIT-2b7de9.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Amazon Bedrock](https://img.shields.io/badge/Amazon%20Bedrock-Mantle%20%7C%20Runtime-ff9900?logo=amazonwebservices&logoColor=white)
![AWS CDK](https://img.shields.io/badge/AWS%20CDK-v2-232f3e?logo=amazonwebservices&logoColor=white)
![Version](https://img.shields.io/badge/version-0.3.0-6b7280)

**A drop-in API gateway for Claude Code: many Anthropic / Amazon Bedrock keys behind one endpoint, with automatic failover, plus cost visibility and control.**<br>
Developers install nothing. They get a URL and a personal token, and the gateway handles the rest.

[Quick start](#-quick-start-local-5-minutes) ·
[Deploy in 5 minutes](#-deploy-in-5-minutes) ·
[Key pool](#-key-pool-many-keys-one-endpoint) ·
[Features](#-features) ·
[Admin console](#-admin-console) ·
[Deploy to AWS](#-deploy-to-aws) ·
[Configuration](#%EF%B8%8F-configuration) ·
[Türkçe](README.tr.md)

</div>

---

## 💡 Why

In its agent loop, Claude Code resends the whole conversation on every turn. A 10-person team
can easily spend **$2,000–3,000 a month** on tokens, and nobody can see who spent it on what.

tokener sits between Claude Code and Bedrock and implements Claude Code's official gateway protocol.
It does three jobs:

<table>
<tr>
<td width="33%" valign="top">

### 👀 Visibility
Logs every request by developer, session, model and **request class** (main, subagent,
background, compaction). Shows cost, cache hit rate and the most expensive sessions.

</td>
<td width="33%" valign="top">

### 🧭 Policy
Applies deterministic rewrites to the request body: routes subagent and background traffic to
cheaper models, fills in a default effort, adds a team instruction, trims oversized tool output, and strips fields Bedrock rejects.

</td>
<td width="33%" valign="top">

### 🛑 Control
Sets a daily **USD budget** and/or **token limit** per developer. At 80% it sends a warning
header; once the limit is passed it can warn, downgrade to a cheaper model, or block.

</td>
</tr>
</table>

> [!IMPORTANT]
> **What tokener never does:** summarize history, drop messages, or switch models mid-conversation.
> Any of those breaks the prompt cache and invalidates thinking blocks on Opus 5.5 / Sonnet 5.5.
> Every rewrite is deterministic (the same input always gives the same output), so the prompt cache and preserved thinking keep working.

**Expected impact:** 15–20% lower cost with the safe policies, and 30–35% with effort tuning on top.
Infrastructure costs about **$75/month**. Assumptions and math are in [docs/COST_MODEL.md](docs/COST_MODEL.md) (Turkish).

## ⚡ Deploy in 5 minutes

**One server, automatic HTTPS.** On a fresh Linux VM (any cloud, 1 vCPU / 1 GB is plenty for a team), point a DNS
record at it and run:

```bash
curl -fsSL https://raw.githubusercontent.com/uurtech/tokener/master/deploy/install.sh | sudo bash -s -- claude-gw.example.com
```

It installs Docker if needed, generates the admin token and `KEY_POOL_SECRET`, starts tokener behind Caddy with a
Let's Encrypt certificate, and prints the admin link. Then: **Keys** → add your Anthropic / Bedrock API keys,
**Developers** → create people and send them the `settings.json` snippet. No AWS account needed when you only use
pool keys. Pass `:80` instead of a domain for a quick plain-HTTP trial. Update later with
`cd /opt/tokener && docker compose pull && docker compose up -d`.

**Just the container:**

```bash
docker run -d -p 8080:8080 -v tokener:/app/data -e ADMIN_TOKEN=change-me -e KEY_POOL_SECRET=change-me-too \
  -e STORE=sqlite -e SQLITE_PATH=/app/data/gateway.db ghcr.io/uurtech/tokener:latest
```

Images are published for `linux/amd64` and `linux/arm64` on every release (`:latest`, `:0.3`, `:0.3.0`).
The compose files are in [`deploy/`](deploy/).

**Your AWS account (Fargate + DynamoDB + ALB + KMS):** `cd infra && npm ci && npx cdk deploy`, see
[Deploy to AWS](#%EF%B8%8F-deploy-to-aws). **AWS Marketplace:** [docs/MARKETPLACE.md](docs/MARKETPLACE.md).

## 🔁 Key pool: many keys, one endpoint

Put several **Anthropic API keys** (`sk-ant-…`) and/or **Bedrock API keys** behind the gateway. Developers keep one
`ANTHROPIC_BASE_URL` and one personal token. The gateway decides which key serves each request, and when a key runs out
it moves on before the developer notices.

<div align="center"><img src="docs/ui-keys.png" alt="Upstream keys" width="92%"></div>

| | |
|---|---|
| 🔁 **Rotation** | `session` (default): new sessions are spread over the keys and each session stays on its key, so the prompt cache stays warm. Also `round-robin`, `fill-first` (by priority) and `least-used`. |
| 🛟 **Transparent failover** | 429, 529/503, 5xx, 401/403 and "credit balance too low" put the key on cooldown, and the **same request** is retried on the next key. Nothing has been streamed yet, so Claude Code only sees the successful answer. Request errors (bad body, unknown model) are forwarded unchanged. |
| 📉 **Proactive switching** | `anthropic-ratelimit-*-remaining` headers are tracked per key. Below `softLimitPct` (5%) the key is parked until its reset time and used only as a last resort. |
| ⏱ **Honest cooldowns** | Cooldowns follow `retry-after` and the reset headers. Repeated failures back off exponentially. When every key is out, the client gets a 429 with a real `retry-after`, or the gateway's own AWS credentials take over if `envFallback` is on. |
| 🎯 **Per-key caps** | Optional daily token / USD caps per key. |
| 👥 **Team key groups** | Reserve keys for teams (`backend`, `data`…). A team uses its own keys first and overflows to shared keys; other teams never touch them. Keeps each team on its own organization or AWS account. |
| ⏲ **Bedrock quotas** | Bedrock sends no rate-limit headers, so give a key its tokens-per-minute / requests-per-minute quota. The gateway counts usage in a sliding minute and parks the key before throttling starts. |
| 🌐 **Several tasks** | On AWS (DynamoDB store) cooldowns are shared between tasks within seconds and survive restarts, and new sessions are mapped to keys by rendezvous hashing, so every task puts a session on the same key and the prompt cache stays warm. |
| 🔔 **Alerts** | Slack / Discord / Microsoft Teams / any JSON webhook: a key is rejected, out of credit or keeps failing, every key is unavailable, a key recovers, a developer reaches a limit. Throttled, never blocks a request. |
| 📊 **Per-key analytics** | Requests, tokens, cost, failovers, live sessions and remaining rate limit per key. Every request records the key that served it (`x-gateway-key` header, Requests page, Dashboard "By upstream key"). |
| 🔐 **Secrets** | AES-256-GCM at rest under an AWS KMS data key (`KEY_POOL_KMS_KEY_ID`, set up by the CDK and Marketplace stacks) or `KEY_POOL_SECRET` (defaults to `ADMIN_TOKEN`); switching re-encrypts automatically. Tested with a free `count_tokens` call on save, shown only as their last four characters, never logged. |

> [!NOTE]
> Anthropic applies rate and spend limits **per organization**, and Bedrock quotas are **per AWS account and region**.
> Keys from the same organization share one limit. To add headroom, use keys from separate organizations or accounts,
> and check that your provider agreements allow how you combine them.

Keys can also come from config (read-only in the UI):

```bash
PROVIDER_KEYS_JSON='[{"label":"org-a","kind":"anthropic","key":"sk-ant-..."},
                     {"label":"acct-2","kind":"bedrock","key":"ABSK...","region":"us-west-2","api":"mantle"}]'
```

Admin API: `GET/POST /admin/api/keys`, `PATCH/DELETE /admin/api/keys/:id`, `POST /admin/api/keys/:id/test|reset`,
`PUT /admin/api/keys/settings` (`strategy`, `envFallback`, `softLimitPct`, `maxAttempts`).

## 🏗 Architecture

```mermaid
flowchart LR
    subgraph Dev["Developer laptop"]
        CC["Claude Code<br/><code>ANTHROPIC_BASE_URL</code><br/><code>ANTHROPIC_AUTH_TOKEN</code>"]
    end

    subgraph AWS["Your AWS account"]
        ALB["Application<br/>Load Balancer"]
        subgraph ECS["ECS Fargate · tokener"]
            direction TB
            A["auth"] --> P["policy"] --> B["budget"] --> S["SigV4 / API key"] --> M["metering"]
        end
        BR[("Amazon Bedrock<br/>Mantle Messages API<br/>or Runtime InvokeModel")]
        DDB[("DynamoDB<br/>keys · usage · policy")]
        CW["CloudWatch<br/>EMF · dashboard · alarms"]
        SNS["SNS<br/>e-mail alerts"]
    end

    CC -- "HTTPS" --> ALB --> ECS
    ECS -- "SSE stream" --> CC
    ECS --> BR
    ECS --> DDB
    ECS --> CW --> SNS
```

There are **two run modes** with the same code and the same UI:

| | Local | AWS |
|---|---|---|
| Storage | SQLite (`gateway/data/gateway.db`) | DynamoDB |
| Credentials | Your own AWS credentials or a Bedrock API key | ECS task role |
| Start | `npm run local` | `npx cdk deploy` |

There are also **two Bedrock APIs**, and you can switch between them live from the console:

- **Mantle**: the Anthropic Messages API endpoint on Bedrock. Requests are forwarded byte for byte.
- **Runtime**: classic `InvokeModel` / `InvokeModelWithResponseStream`. The gateway translates the body,
  converts the AWS event stream into SSE, and calls the model through its `us.` / `global.` inference profile id.

Nothing changes for developers either way.

## ✨ Features

| | |
|---|---|
| 🔌 **Zero install** | Two lines in `~/.claude/settings.json`. Developers need no AWS credentials. |
| 🧠 **Request-class routing** | Sends `subagent`, `auxiliary` and `compaction` traffic to its own model (e.g. Sonnet or Haiku). |
| 🎚 **Effort control** | `fill` sets a default effort when the request has none. `override` always sets it. |
| ✂️ **Tool-output trimming** | Shortens huge `tool_result` text but keeps its head and tail. |
| 🧷 **Bedrock bridging** | Strips beta fields and headers that Bedrock rejects, so you avoid `400 Extra inputs are not permitted`. |
| 💸 **Budgets & token limits** | Daily per-developer limits with `warn` / `downgrade` / `block`, reported in `x-gateway-budget*` headers. |
| 📚 **Live model catalog** | Builds `/v1/models` from Bedrock (`ListFoundationModels` + `ListInferenceProfiles`), so `/model` just works. |
| 🔁 **Key pool** | Several Anthropic / Bedrock keys behind one URL with rotation, transparent failover and per-key caps ([details](#-key-pool-many-keys-one-endpoint)). |
| 🙋 **Self-service** | Developers open `/me` (or call `GET /v1/me`) with their own token: today's and this month's spend, tokens, cache hit rate, limits with reset times, 14-day trend, allowed models. |
| 📆 **Monthly budgets** | Monthly USD and token caps per developer, next to the daily ones, with an 80% warning header and an alert. |
| 🔑 **Admin SSO** | OpenID Connect sign-in (Google Workspace, Okta, Entra ID, Auth0, Keycloak…) restricted to listed domains / e-mails, with the admin's e-mail in the audit log. The admin token keeps working for automation. |
| 🔔 **Alerts** | Webhook alerts for key failures, pool exhaustion and developer limits (Policy → Alerts). |
| 📊 **Observability** | CloudWatch EMF metrics, a dashboard and alarms, plus an in-app dashboard with a 14-day trend. |
| 🔐 **Privacy by design** | Conversation content is never stored. Tokens are kept only as hashes, and logs contain numbers only. |
| 🛒 **Marketplace-ready** | A hardened CloudFormation template with HTTPS only, private subnets, Secrets Manager and `RegisterUsage` metering. |

## 🖥 Admin console

A built-in console at `/admin` with a sidebar, light and dark themes, and keyboard shortcuts. Policy changes
take effect immediately, with no redeploy.

<div align="center">
<img src="docs/ui-dashboard.png" alt="Dashboard" width="92%">
<br><sub><b>Dashboard</b>: estimated cost, policy savings, cache hit rate, 14-day trend, cost by developer, model and request class</sub>
</div>

<br>

<table>
<tr>
<td width="50%" align="center"><img src="docs/ui-requests.png" alt="Requests"><br><sub><b>Requests</b>: filters, live refresh, CSV export</sub></td>
<td width="50%" align="center"><img src="docs/ui-sessions.png" alt="Sessions"><br><sub><b>Sessions</b>: turns and context growth per session</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/ui-developers.png" alt="Developers"><br><sub><b>Developers</b>: tokens, limits, token rotation</sub></td>
<td width="50%" align="center"><img src="docs/ui-developer-drawer.png" alt="Developer drawer"><br><sub><b>New developer</b>: API override and model allowlist</sub></td>
</tr>
<tr>
<td width="50%" align="center"><img src="docs/ui-models.png" alt="Models"><br><sub><b>Models</b>: live Bedrock catalog and price editing</sub></td>
<td width="50%" align="center"><img src="docs/ui-policy.png" alt="Policy"><br><sub><b>Policy</b>: editor with a live preview</sub></td>
</tr>
<tr>
<td colspan="2" align="center"><img src="docs/ui-system.png" alt="System" width="50%"><br><sub><b>System</b>: diagnostics, settings template, audit log</sub></td>
</tr>
</table>

## 🚀 Quick start (local, 5 minutes)

Nothing is deployed to AWS. It runs on your machine with your own credentials: Claude Code talks to `localhost`, and the gateway talks to Bedrock.

**Prerequisites:** Node 22.13+ and AWS credentials with access to the Anthropic models on Bedrock
(if `aws sts get-caller-identity` works, you're set). The identity needs `bedrock-mantle:CreateInference`, plus
`bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` for the model list.

```bash
git clone https://github.com/uurtech/tokener.git && cd tokener/gateway
npm ci && npm run build
cp .env.example .env        # fill in AWS_BEARER_TOKEN_BEDROCK (or IAM keys), AWS_REGION, ADMIN_TOKEN
npm run local
```

The output prints a one-click login link: `http://localhost:8080/admin/#token=<ADMIN_TOKEN>`.
If you leave `ADMIN_TOKEN` empty, a random one is generated and printed.

> [!TIP]
> The easiest credential is a **Bedrock API key** (`AWS_BEARER_TOKEN_BEDROCK`, from Bedrock console → API keys).
> One key works for Mantle, Runtime and the model catalog, with no SigV4 needed. IAM access keys work too; in that case
> the gateway signs requests with SigV4. The `auth` field in `/health` shows which one is in use.
> Shell variables override `.env` (`AWS_PROFILE=myprofile ADMIN_TOKEN=secret npm run local`).

1. Open **Developers** and create a developer. The token is shown once, together with a ready-made settings block.
2. Paste the block into `~/.claude/settings.json`. The local URL is `http://localhost:8080`.
3. Start `claude`. Check that `/status` shows the `Anthropic base URL`, then send a message.
4. Requests, tokens and cost appear on the **Dashboard** right away.

Or with Docker:

```bash
cd gateway && ADMIN_TOKEN=secret AWS_PROFILE=myprofile docker compose up --build
```

## 👩‍💻 Developer setup

Each developer adds this to `~/.claude/settings.json` (or exports the same variables in their shell):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://claude-gw.example.com",
    "ANTHROPIC_AUTH_TOKEN": "cgw_...",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"
  }
}
```

<details>
<summary><b>What each line does</b></summary>

- `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are required. The token is sent as `Authorization: Bearer`.
- `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`: Claude Code reports each request's class (`main`, `subagent`,
  `auxiliary`, `compaction`) in a header. Routing depends on this; without it, every request counts as the main conversation.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`: turns off pre-release fields that Bedrock rejects, at the source.
  The gateway strips them anyway, so this is a second safety net.
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`: makes `/model` read the gateway's `/v1/models`. The list is built
  live from Bedrock and cached for 10 minutes. It contains short aliases first, then every active Anthropic model id and
  inference profile id in the region.
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`: sends background jobs (titles, summaries) to Haiku. `ROUTE_AUXILIARY_MODEL`
  has the same effect on the gateway side, and setting both is harmless.
- Optional: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off traffic that doesn't go through the gateway, such as telemetry and version checks (this also disables auto-update).

</details>

## ☁️ Deploy to AWS

**Prerequisites:** AWS CLI v2 with an active session and Anthropic model access enabled on Bedrock
(Bedrock console → Model catalog → use-case form, once per account), Node.js 22+, Docker, and AWS CDK v2 (`npm i -g aws-cdk`).
A domain and an ACM certificate are optional. Without them the ALB serves HTTP, which is acceptable for a POC only.

```bash
cd gateway && npm ci && npm test           # unit tests
cd ../infra && npm ci
npx cdk bootstrap                          # first time per account/region
npx cdk deploy                             # ~8 min; builds the image and pushes it to ECR
```

Outputs: `GatewayUrl`, `KeysTableName`, `UsageTableName`, `DashboardName`.

```bash
curl -s "$GATEWAY_URL/health"
# {"ok":true,"upstream":"https://bedrock-mantle.us-east-1.api.aws/anthropic"}

./scripts/create-dev-key.sh <KeysTableName> alice 25 backend 5000000
#                                          name  USD/day team tokens/day (0 = none)
```

The token is printed once. DynamoDB stores only its SHA-256 hash. The USD and token limits are independent,
and `BUDGET_ACTION` kicks in when either one is reached first.

> [!NOTE]
> For production and **AWS Marketplace**, use the hardened `tokener-marketplace` template. It enforces HTTPS, uses private subnets,
> restricts the admin console to listed CIDRs, keeps the admin token in Secrets Manager, and meters usage with `RegisterUsage`.
> See [docs/MARKETPLACE.md](docs/MARKETPLACE.md).
>
> ```bash
> cd infra && npm ci && npm run synth:marketplace   # → dist/tokener-marketplace.template.json
> ```

## ⚙️ Configuration

The `env` block in `infra/gateway.config.json` sets the **initial** behavior. Policy saved from the console overrides it
and is persisted. If `adminToken` is empty, `/admin` returns 404. For the first week, **measurement mode** is
recommended: every policy off, bridging on.

<details>
<summary><b>All environment variables</b></summary>

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_BEDROCK` | `true` | Strips fields Bedrock rejects (`context_management`, `output_config.format`, `task_budget`, `strict`, advisor tool) and their beta headers. Keep it on. |
| `ROUTE_SUBAGENT_MODEL` | empty | Model for `subagent` requests, e.g. `anthropic.claude-sonnet-5-5`. |
| `ROUTE_AUXILIARY_MODEL` | empty | Model for background requests such as titles and summaries, e.g. `anthropic.claude-haiku-4-5`. |
| `ROUTE_COMPACTION_MODEL` | empty | Model for compaction summaries. Leaving it on the main model is usually best for quality. |
| `EFFORT_MODE` | `off` | `fill`: set `DEFAULT_EFFORT` when the request has none. `override`: always set it. |
| `DEFAULT_EFFORT` | `high` | `low` `medium` `high` `xhigh` `max` |
| `OPERATOR_PROMPT` | empty | Appended as the **last** system block of every request. |
| `CACHE_TTL_1H` | `false` | Extends all cache breakpoints to 1 hour. Cache writes cost 2×, so enable it only if gaps between turns often exceed 5 minutes. |
| `TOOL_RESULT_MAX_CHARS` | `0` | `0` disables trimming; `20000` is recommended. Trims `tool_result` text but keeps its head and tail. |
| `BUDGET_ACTION` | `warn` | `warn`: report in a header. `downgrade`: start new conversations on `DOWNGRADE_MODEL`. `block`: return 429. |
| `DOWNGRADE_MODEL` | `anthropic.claude-sonnet-5-5` | |
| `MODEL_MAP_JSON` | built-in | Extra Anthropic id → Bedrock id mappings. |
| `PRICING_JSON` | built-in | Overrides the price table used for cost estimates. |
| `TEAM_DAILY_ALERT_USD` | `150` | Threshold for the team-wide daily spend alarm. |
| `AWS_BEARER_TOKEN_BEDROCK` | empty | Bedrock API key. If empty, the gateway uses the task role / IAM credentials with SigV4. |
| `UPSTREAM_MODE` | `mantle` | `mantle` (Messages API) or `runtime` (`InvokeModel`). Can be switched live. |
| `BEDROCK_PROFILE_PREFIX` | `us` | Inference profile prefix added to bare model ids in runtime mode (`us`, `global`, `eu`, `apac`, `none`). |
| `MODEL_CATALOG_ENABLED` | `true` | Builds the model list live from Bedrock. When off, only `MODEL_MAP_JSON` aliases are listed. |
| `MODEL_CATALOG_TTL_MS` | `600000` | How long the catalog is cached (10 min). |
| `KEY_POOL_SECRET` | `ADMIN_TOKEN` | Encrypts upstream pool keys stored from the console. Changing it makes stored keys unreadable (they show as `error`). `npm run local` keeps one in `data/keypool.secret`. |
| `PROVIDER_KEYS_JSON` | empty | Read-only pool keys: `[{"label","kind":"anthropic"\|"bedrock","key","region?","api?","priority?","dailyTokenLimit?","dailyBudgetUsd?"}]`. |
| `ANTHROPIC_API_URL` | `https://api.anthropic.com` | Default base URL for Anthropic pool keys. |
| `KEY_POOL_KMS_KEY_ID` | empty | KMS key (id / ARN / alias) for envelope encryption of pool keys. The CDK and Marketplace stacks create one. |
| `ALERT_WEBHOOK_URL` | empty | Initial alert webhook (editable on the Policy page). |
| `ALERT_SOURCE` | hostname | Name shown in alerts, e.g. `tokener-prod`. |
| `OIDC_ISSUER` | empty | Enables admin SSO, e.g. `https://accounts.google.com`, `https://<tenant>.okta.com`, `https://login.microsoftonline.com/<tenant>/v2.0`. Callback URL: `https://<gateway>/admin/sso/callback`. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | empty | The OIDC app's credentials. |
| `OIDC_ALLOWED_DOMAINS` / `OIDC_ALLOWED_EMAILS` | empty | Who may sign in (comma separated). Both empty = nobody. |
| `OIDC_LABEL` | `SSO` | Button text: "Sign in with …". |
| `SESSION_SECRET` | derived | Signs admin session cookies (12 h). Set it when running several tasks without `KEY_POOL_SECRET`. |
| `UPSTREAM_TIMEOUT_MS` | `120000` | How long to wait for Bedrock's response headers before returning 504. There is no limit once streaming starts. |

Setting `alertEmail` sends alarms by e-mail. Setting `domainName` + `certificateArn` adds an HTTPS listener and an HTTP→HTTPS redirect.

</details>

## 📈 Operating it

<details>
<summary><b>Weekly 30-minute review</b></summary>

1. **Top 5 most expensive sessions.** Find out why each one cost so much: a long session, huge log output, the same retry over and over?
2. **Cache hit rate below 80%.** Something is breaking the prompt prefix. Usual causes: `OPERATOR_PROMPT` edited mid-week, MCP servers
   added mid-session, or breaks longer than 5 minutes. If none of those explain it, consider `CACHE_TTL_1H`.
3. **High output/input ratio.** Look at effort. Try `EFFORT_MODE=fill` + `DEFAULT_EFFORT=high` with two developers for a week.
4. **If everything looks healthy, enable the next lever**, in this order: auxiliary → Haiku, subagent → Sonnet, tool_result trimming, effort, budget downgrade.

```bash
./scripts/usage-report.sh <UsageTableName>              # today, per developer
./scripts/usage-report.sh <UsageTableName> 2026-10-06   # a given day
./scripts/list-dev-keys.sh <KeysTableName>
./scripts/revoke-dev-key.sh <KeysTableName> alice        # access revoked within 60 s
```

Policy changes apply immediately. Other Fargate tasks pick them up within 30 seconds. Changing the operator instruction, effort or routing
invalidates the cache of open conversations once, so make those changes at the end of the day.

</details>

<details>
<summary><b>Scale</b></summary>

Two tasks are plenty for 10 developers: the gateway is I/O-bound, not CPU-bound. Auto-scaling adds tasks at 60% CPU, up to 6.
The default Bedrock quota of 2M input tokens per minute is not a constraint at that size.

</details>

## 🔐 Security

- The ECS task role is the only identity that can call Bedrock. Developers hold no AWS credentials.
- Admin sign-in with SSO (OIDC + PKCE, signed HttpOnly session cookies, CSRF guard on cookie writes) or the admin token.
- Upstream API keys are encrypted at rest (KMS envelope or `KEY_POOL_SECRET`), never returned by the API, never logged.
- Tokens are stored as SHA-256 hashes. Logs contain counts, the model and the session id, never prompt content.
- Conversation content is never persisted. It is transformed in memory and forwarded.
- `allowedModels` on a key restricts which models that developer can use.
- In production: require an ACM certificate, put WAF in front of the ALB (but turn off body-inspection rules for `/v1/messages`, because prompts that contain code trip the XSS rules),
  and restrict `/admin*` to your office IPs or VPN, or leave `adminToken` empty and manage keys with `scripts/`.

## ⚠️ Limitations

- **Bridging needs ongoing maintenance.** New Claude Code releases may add beta fields that Bedrock rejects. To fix one, add it to `BRIDGE_STRIP_BETAS` or update `bridgeForBedrock`.
- **Prices are estimates.** Cost Explorer is the source of truth; gateway numbers are for ranking and comparison. Use `PRICING_JSON` if your contract prices differ.
- **tool_result trimming** can make the model ask again for the part that was cut. The 20K threshold and the head+tail rule reduce this.
- **Budgets reset daily at UTC midnight.** The token limit counts input, cache read, cache write and output together. A heavy Opus day can reach 20–40M tokens.
- **Structured outputs and server-side tools** (web search, code execution) are not available on Bedrock.

## 🗂 Repository layout

```
gateway/      Node 22.13+ / TypeScript gateway (AWS SDK v3 only; no framework)
  src/        config, auth, policy, policy-state, sse, upstream, usage, admin, server
  src/store/  SQLite (local) and DynamoDB (AWS) storage
  ui/         admin console (static HTML/JS, no build step)
  test/       vitest unit tests + test/smoke/ end-to-end tests against a fake upstream
infra/        AWS CDK: VPC, ECS Fargate, ALB, DynamoDB, CloudWatch, SNS + Marketplace stack
scripts/      create/revoke/list tokens, usage report, release, deploy test
deploy/       one-command server install: docker-compose + Caddy (automatic HTTPS) + install.sh
docs/         cost model, Marketplace guide, screenshots
```

## 🧪 Testing

```bash
cd gateway
npm test          # unit tests (vitest)
npm run smoke     # end-to-end checks against a fake Bedrock upstream: no AWS calls
```

The smoke suites check key-pool rotation, failover, parking and secret handling against fake Anthropic and Bedrock upstreams, and that SSE is passed through byte for byte, along with model mapping, bridging, effort fill, operator prompt placement,
tool_result trimming, error passthrough and EMF metric output.

## 🗺 Roadmap

- [ ] A separate model per subagent type (`x-claude-code-agent-type`)
- [ ] Prompt-cache pre-warming after compaction
- [x] Several upstream keys behind one endpoint with failover (v0.2)
- [x] Developer self-service usage endpoint `/v1/me` (v0.2)
- [x] Self-service page `/me`, monthly budgets, alerts, team key groups, Bedrock TPM/RPM, admin SSO, KMS, one-command deploy (v0.3)

## 🤝 Contributing

Issues and PRs are welcome. Before opening a PR, run `npm run typecheck && npm test && npm run smoke` in `gateway/`.

## 📄 License

[MIT](LICENSE) © uurtech

<div align="center">
<sub>Not affiliated with Anthropic or Amazon Web Services. "Claude" is a trademark of Anthropic; "Amazon Bedrock" is a trademark of Amazon.com, Inc.</sub>
</div>
