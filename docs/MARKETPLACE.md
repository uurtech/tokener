# tokener on AWS Marketplace — product and deployment guide

tokener is a gateway between Claude Code and Amazon Bedrock. It gives an engineering team one URL and
one personal token per developer, measures every request (developer, session, model, request class),
applies deterministic cost policies, and enforces per-developer daily budgets and token limits. Nothing
is installed on developer machines; conversations never leave the buyer's AWS account.

This document covers the Marketplace listing: what the buyer deploys, what it needs, how it is billed,
and how the seller builds and ships a release.

---

## 1. Product summary (listing copy)

**Title.** tokener — Claude Code cost gateway for Amazon Bedrock

**Short description.** Route Claude Code through your own AWS account with per-developer tokens,
budgets and token limits, live cost dashboards, model routing and prompt-cache-safe optimisations.
Supports both Bedrock APIs (Anthropic Messages API and classic InvokeModel).

**Highlights.**
- Per-developer tokens, daily USD budget and daily token limit; warn, downgrade or block on overrun.
- Admin console: cost and savings dashboard with 14-day trend, request log with filters and CSV export,
  per-session cost curves, developer management with token rotation, Bedrock model catalog with price
  editing, policy editor with live preview, diagnostics and audit log. Light and dark themes.
- Policies that never break the prompt cache: route subagent and background requests to cheaper
  models, fill effort defaults, cap oversized tool output, strip fields Bedrock rejects.
- Developers choose models from the gateway's live `/v1/models` list; the operator can restrict which
  models each developer may use and which Bedrock API carries their traffic.
- Runs entirely in your account: ECS Fargate in private subnets, DynamoDB, CloudWatch metrics,
  dashboard and alarms. No data leaves the account; the vendor has no access.

**Categories.** Developer tools · Cost management · Generative AI.

**Delivery method.** Container (Amazon ECS on AWS Fargate) deployed with a CloudFormation template.

**Pricing model.** Hourly per running task (RegisterUsage). A typical 10-developer team runs 2 tasks.

---

## 2. Buyer prerequisites

| Requirement | Why | How |
|---|---|---|
| Anthropic model access in Amazon Bedrock | Bedrock refuses inference until the account has accepted the use-case form | Bedrock console → Model catalog → Anthropic → Request access (once per account, per region) |
| ACM certificate for the gateway hostname | Developer tokens travel inside TLS; the template refuses HTTP | ACM → Request public certificate, validate via DNS |
| A hostname you control | Developers configure it as `ANTHROPIC_BASE_URL` | Any DNS provider; create a CNAME after deployment |
| IAM permission to create roles | The stack creates the task role that calls Bedrock | `CAPABILITY_IAM` when launching; or supply an existing role ARN |
| Bedrock service quotas | Default tokens-per-minute quotas suit ~10 developers | Raise in Service Quotas for larger teams |

---

## 3. Deployment (buyer)

1. **Subscribe** on the listing page and choose **Launch with CloudFormation**.
2. **Parameters** (grouped in the console):

   | Group | Parameter | Default | Notes |
   |---|---|---|---|
   | Endpoint | `CertificateArn` | — | Required. ACM certificate in the deployment region. |
   | Endpoint | `DomainName` | empty | Hostname shown in outputs; create the CNAME yourself. |
   | Endpoint | `AdminAllowedCidrs` | empty | Comma-separated CIDRs that may open `/admin`. Empty = admin UI disabled at the load balancer (403). |
   | Bedrock | `UpstreamMode` | `mantle` | Default Bedrock API. Changeable later per policy and per developer. |
   | Bedrock | `BedrockProfilePrefix` | `us` | Inference-profile prefix for runtime mode (`us`, `global`, `eu`, `apac`, `none`). |
   | Capacity | `DesiredCount` | 2 | Gateway tasks (1–6). |
   | Capacity | `NatGateways` | 1 | 2 for AZ resilience. |
   | Capacity | `TeamDailyAlertUsd` | 150 | Spend alarm threshold. |
   | Capacity | `AlertEmail` | empty | SNS e-mail for alarms. |
   | Security | `ExistingTaskRoleArn` | empty | Bring your own task role (see §5). |
   | Security | `PermissionsBoundaryArn` | empty | Applied to every role the stack creates. |
   | Marketplace | `ContainerImage`, `MarketplaceProductCode` | pre-filled | Do not change. |

3. **Create the stack** (~8 minutes). Outputs:
   `GatewayUrl`, `LoadBalancerDns`, `AdminUrl`, `AdminTokenSecretArn`, `AdminTokenCommand`,
   `KeysTableName`, `UsageTableName`, `DashboardName`, `LogGroupName`, `TaskRoleArn`.
4. **DNS.** Create a CNAME from your hostname to `LoadBalancerDns`.
5. **Admin token.** Run the `AdminTokenCommand` output (reads the generated secret from Secrets Manager).
6. **First developer.** Open `AdminUrl` from an allowed CIDR → Developers → New developer. Copy the token
   and the settings snippet; the developer pastes it into `~/.claude/settings.json`.
7. **Verify.** `curl https://<host>/health` returns `{"ok":true,...,"marketplace":"registered"}`. In Claude
   Code, `/status` shows the gateway as the Anthropic base URL and `/model` lists the models the gateway
   serves.

### Upgrades

Update the stack with the new template version from the listing. Tasks roll with the ECS circuit
breaker (automatic rollback on failed health checks). Data lives in DynamoDB and is retained across
updates and even after stack deletion (`RETAIN`).

### Removal

Delete the stack. The two DynamoDB tables and the Secrets Manager secret are retained on purpose;
delete them manually if you no longer need the usage history.

---

## 4. Architecture

```
developer (Claude Code) ──HTTPS──▶ ALB (public, TLS 1.3) ──▶ ECS Fargate tasks (private subnets)
                                        │ /admin* only from AdminAllowedCidrs          │
                                        │                                               ├─▶ Amazon Bedrock (Mantle Messages API or Runtime InvokeModel)
                                        │                                               ├─▶ DynamoDB: keys (hashed tokens, limits), usage (daily aggregates)
                                        │                                               ├─▶ CloudWatch Logs (EMF metrics) → dashboard, alarms → SNS
                                        │                                               └─▶ Marketplace Metering: RegisterUsage at task start
                                        └─▶ NAT gateway(s) for outbound to AWS APIs
```

- Request bodies are transformed in memory and forwarded; no prompt or completion content is persisted.
- Developer tokens are stored as SHA-256 hashes. The admin token is generated into Secrets Manager.
- CloudWatch metrics carry counts, model ids, developer ids and session ids only.

---

## 5. IAM

The stack creates a least-privilege **task role** (what the gateway code uses) and an **execution
role** (what ECS uses to pull the image, write logs and read the admin secret).

Task role statements:

| Sid | Actions | Resources |
|---|---|---|
| BedrockMantleMessagesApi | `bedrock-mantle:CreateInference`, `bedrock-mantle:CountTokens` | `arn:aws:bedrock-mantle:<region>:<account>:project/*` |
| BedrockRuntimeInvoke | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:CountTokens` | `arn:aws:bedrock:*::foundation-model/anthropic.*`, `arn:aws:bedrock:*:<account>:inference-profile/*` |
| BedrockModelCatalog | `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` | `*` (list APIs accept no resource) |
| AnthropicModelSubscriptionViaBedrock | `aws-marketplace:ViewSubscriptions`, `aws-marketplace:Subscribe` | `*`, condition `aws:CalledViaLast = bedrock.amazonaws.com` |
| (managed) AWSMarketplaceMeteringRegisterUsage | RegisterUsage for this product | — |
| DynamoDB grants | read/write | the two stack tables |

**Bring your own role.** Set `ExistingTaskRoleArn` to a role trusted by `ecs-tasks.amazonaws.com`
with the statements above; the tasks run with your role and the stack's own least-privilege role stays unused. The two table names are stack
outputs; grant them after the first deployment or use a wildcard on the stack prefix.

**Permissions boundary.** `PermissionsBoundaryArn` is attached to every role the stack creates.

No role trusts a principal outside the buyer's account. The template contains no access keys and
calls no vendor endpoint.

---

## 6. Billing and entitlement

Each task calls `RegisterUsage` at start-up with the product code baked into the template. Marketplace
bills hourly per running task for as long as the task lives. If the account is not subscribed the
call fails with `CustomerNotEntitledException`; the task logs `marketplace_exit` and stops, so the
service never serves unentitled traffic. Transient metering errors are retried five times with
backoff before the task exits and ECS restarts it.

Bedrock inference is billed by AWS to the buyer directly at Bedrock prices. tokener only estimates
cost for attribution; the AWS bill is authoritative.

---

## 7. Operations

- **Health.** `GET /health` → `{ ok, api, upstream, auth, store, marketplace }`.
- **Logs.** CloudWatch Logs group from the `LogGroupName` output; one JSON line per request with
  token counts, cost estimate, latency, status and applied transforms. No content.
- **Dashboard.** `DashboardName` output: cost per developer, tokens, cache hit %, latency, errors.
- **Alarms.** High error rate, daily spend threshold, unhealthy tasks → SNS topic (`AlertEmail`).
- **Policy changes** are made in the admin UI and take effect on the next request on every task.
- **Scaling.** 1–6 tasks on CPU 60 %. A 10-developer team runs comfortably on 2 tasks.

---

## 8. Seller runbook: building a release

Everything below is scripted. Set the two values the Marketplace Management Portal gives you and run:

```bash
export MARKETPLACE_ECR_REPO=709825985650.dkr.ecr.us-east-1.amazonaws.com/<seller>/tokener
export MARKETPLACE_PRODUCT_CODE=<product code>
./scripts/release.sh --bump minor --push        # omit --push for a local dry run
```

`release.sh` runs unit and smoke tests, audits production dependencies, builds the linux/amd64 image,
starts it once to prove `/health` and the console, pushes it to the Marketplace ECR repository,
synthesizes the template with that image URI and the product code baked in as parameter defaults,
runs the pre-flight script and `cfn-lint`, and writes `dist/release/<version>/` with the template,
checksums and release notes taken from `CHANGELOG.md`.

Then deploy it exactly like a buyer, in a clean account:

```bash
./scripts/deploy-test.sh dist/release/<version>/tokener-marketplace.template.json \
  --cert arn:aws:acm:us-east-1:<account>:certificate/<id> --domain claude-gw.example.com
# ... verifies /health, the admin API with the generated secret, diagnostics, /v1/models and count_tokens
./scripts/deploy-test.sh x --stack tokener-test --destroy
```

Finally upload `tokener-marketplace.template.json` to the listing's S3 bucket and add the version in the
Marketplace Management Portal. CI (`.github/workflows/ci.yml`) repeats the tests, image build and template
lint on every push.

The pre-flight script rejects templates that reference CDK assets, use Lambda-backed custom resources,
contain `Action: "*"`, plain-text secrets in container environment, HTTP listeners that do not
redirect, or world-open ingress on ports other than 80/443.

### Listing checklist

- [ ] Seller registration complete (tax, bank, public profile) in the Marketplace Management Portal.
- [ ] Container product created; ECR repository provisioned by Marketplace; image pushed and scanned clean.
- [ ] Product code copied into the template default for `MarketplaceProductCode`.
- [ ] CloudFormation template uploaded; "Deployment template" delivery option with usage instructions (§3).
- [ ] Pricing: hourly dimension per task; free trial optional.
- [ ] EULA (standard contract or custom), support contact, refund policy.
- [ ] Logo, screenshots (`docs/ui-*.png`: Dashboard, Requests, Sessions, Developers, Models, Policy, System), highlights, categories.
- [ ] Test deployment in a fresh account using the listing's own template; verify `marketplace: registered`.
