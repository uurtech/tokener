import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig, type Config } from "./config.js";
import { DeveloperAuth, extractToken, type Developer } from "./auth.js";
import { Upstream } from "./upstream.js";
import { emitEmf } from "./usage.js";
import { loadPricingOverrides, setPolicyPricing, EMPTY_USAGE, estimateCostUsd } from "./pricing.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformRequest, isConversationStart, resolveModel, type Json, type RequestMeta } from "./policy.js";
import { SseUsageTap, summaryFromMessage, type StreamSummary } from "./sse.js";
import { createStore, type RequestRecord } from "./store/index.js";
import { effectiveConfig, policyFromConfig, type Policy } from "./policy-state.js";
import { handleAdmin } from "./admin.js";
import { budgetHeaders, budgetMessage, evaluateBudget, hasLimits, type BudgetState } from "./budget.js";
import { ModelCatalog, modelsForClients, sdkLister } from "./models.js";
import { BedrockRuntimeUpstream, sdkRuntimeClient, toRuntimeModelId } from "./upstream-runtime.js";
import { marketplaceSettingsFromEnv, registerWithMarketplace, sdkMeteringClient, type MarketplaceStatus } from "./marketplace.js";

const baseCfg: Config = loadConfig();
loadPricingOverrides(process.env.PRICING_JSON);

const store = createStore(baseCfg);
const auth = new DeveloperAuth(store.keys, baseCfg.keyCacheTtlMs, process.env.STATIC_KEYS_JSON);
// AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key) is honoured by the AWS SDK clients automatically; pass it to
// the raw Mantle forwarder too so both upstreams and the model catalog share one credential.
const upstream = new Upstream(baseCfg.upstreamBaseUrl, baseCfg.awsRegion, process.env.AWS_BEARER_TOKEN_BEDROCK);
const runtimeEndpoint = baseCfg.bedrockRuntimeEndpoint || `https://bedrock-runtime.${baseCfg.awsRegion}.amazonaws.com`;
const runtime = new BedrockRuntimeUpstream(sdkRuntimeClient(baseCfg.awsRegion, baseCfg.bedrockRuntimeEndpoint, baseCfg.upstreamTimeoutMs), runtimeEndpoint);
const upstreamLabel = () => (cfg.upstreamMode === "runtime" ? runtimeEndpoint : cfg.upstreamBaseUrl);
const catalog = new ModelCatalog(baseCfg.modelCatalogEnabled ? sdkLister(baseCfg.awsRegion) : null, baseCfg.modelCatalogTtlMs, baseCfg.awsRegion);
const adminToken = process.env.ADMIN_TOKEN ?? "";
const emfEnabled = (process.env.EMF_ENABLED ?? (store.kind === "dynamo" ? "1" : "0")) === "1";
const startedAt = Date.now();
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return process.env.npm_package_version ?? "dev";
  }
})();

// Runtime policy: env defaults, overridden by whatever the admin UI saved.
let policy: Policy = policyFromConfig(baseCfg);
let cfg: Config = effectiveConfig(baseCfg, policy);
async function reloadPolicy(): Promise<void> {
  try {
    const saved = await store.policy.load();
    if (saved) {
      policy = { ...policyFromConfig(baseCfg), ...saved };
      cfg = effectiveConfig(baseCfg, policy);
      setPolicyPricing(policy.pricing);
    }
  } catch (e) {
    log({ event: "policy_load_failed", error: String(e) });
  }
}
async function setPolicy(p: Policy): Promise<void> {
  await store.policy.save(p);
  policy = p;
  cfg = effectiveConfig(baseCfg, p);
  setPolicyPricing(p.pricing);
  log({ event: "policy_updated", api: p.upstreamMode, profilePrefix: p.bedrockProfilePrefix, effortMode: p.effortMode, routeSubagent: p.routeSubagentModel, routeAuxiliary: p.routeAuxiliaryModel, budgetAction: p.budgetAction });
}

function log(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function apiError(res: http.ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { type: "error", error: { type, message } }, headers);
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function headerStr(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function metaFrom(req: http.IncomingMessage): RequestMeta {
  return {
    requestClass: headerStr(req, "x-claude-code-request-class"),
    agentType: headerStr(req, "x-claude-code-agent-type"),
    sessionId: headerStr(req, "x-claude-code-session-id"),
    agentId: headerStr(req, "x-claude-code-agent-id"),
  };
}

/**
 * Canonical form for allowlist comparison: alias -> Bedrock id, profile prefix (us./global.) and
 * date / version suffixes (-20251001-v1:0) removed. "claude-haiku-4-5-20251001", "us.anthropic.claude-haiku-4-5-20251001-v1:0"
 * and "anthropic.claude-haiku-4-5" all become "anthropic.claude-haiku-4-5"; "claude-sonnet-5" stays distinct from "claude-sonnet-5-5".
 */
function canonicalModel(id: string, modelMap: Record<string, string>): string {
  return resolveModel(id, modelMap)
    .replace(/^[a-z-]+\.(?=anthropic\.)/, "")
    .replace(/-\d{8}(-v\d+(:\d+)?)?$/, "")
    .replace(/-v\d+(:\d+)?$/, "");
}

/** True when the developer has no allowlist or the requested model matches an entry. */
export function isModelAllowed(dev: Developer, requested: string, modelMap: Record<string, string>): boolean {
  if (!dev.allowedModels?.length) return true;
  const want = canonicalModel(requested, modelMap);
  return dev.allowedModels.some((a) => canonicalModel(a, modelMap) === want);
}

/**
 * Cost avoided by serving a different (cheaper) model than the developer asked for. Only routing and
 * budget downgrades change the model; a profile prefix or dated id for the same model is not a saving.
 */
function savingsUsd(requested: string, served: string, usage: typeof EMPTY_USAGE): number {
  if (!requested) return 0;
  const wanted = resolveModel(requested, cfg.modelMap);
  if (canonicalModel(wanted, cfg.modelMap) === canonicalModel(served, cfg.modelMap)) return 0;
  const diff = estimateCostUsd(wanted, usage) - estimateCostUsd(served, usage);
  return diff > 0 ? Math.round(diff * 1e8) / 1e8 : 0;
}

/** Accept both "/v1/messages" and "/anthropic/v1/messages" (Mantle-style base URL). */
function normalizePath(url: string): { path: string; query: string; params: URLSearchParams } {
  const [p, q = ""] = url.split("?", 2);
  const path = p.replace(/^\/anthropic(?=\/)/, "");
  return { path, query: q ? `?${q}` : "", params: new URLSearchParams(q) };
}

async function authenticate(req: http.IncomingMessage, res: http.ServerResponse): Promise<Developer | null> {
  const token = extractToken(req.headers);
  if (!token) {
    apiError(res, 401, "authentication_error", "Missing credential. Set ANTHROPIC_AUTH_TOKEN to your gateway token.");
    return null;
  }
  const dev = await auth.lookup(token);
  if (!dev || !dev.enabled) {
    apiError(res, 401, "authentication_error", "Invalid or revoked gateway token.");
    return null;
  }
  return dev;
}

async function budgetState(dev: Developer): Promise<BudgetState> {
  if (!hasLimits(dev)) return { exceeded: false, spentUsd: 0, usedTokens: 0 };
  return evaluateBudget(dev, await store.usage.todayTotals(dev.developerId));
}

async function recordUsage(rec: RequestRecord): Promise<void> {
  try {
    if (emfEnabled) emitEmf(baseCfg.metricsNamespace, rec);
    await store.usage.record(rec);
  } catch (e) {
    log({ event: "usage_record_failed", error: String(e) });
  }
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse, query: string): Promise<void> {
  const started = Date.now();
  const dev = await authenticate(req, res);
  if (!dev) return;

  let raw: Buffer;
  try {
    raw = await readBody(req, cfg.maxBodyBytes);
  } catch {
    return apiError(res, 413, "invalid_request_error", "Request body too large.");
  }
  let body: Json;
  try {
    body = JSON.parse(raw.toString("utf8")) as Json;
  } catch {
    return apiError(res, 400, "invalid_request_error", "Request body is not valid JSON.");
  }

  const meta = metaFrom(req);
  const requestedModel = typeof body.model === "string" ? body.model : "";
  const budget = await budgetState(dev);
  let forceModel: string | undefined;
  const extraHeaders: Record<string, string> = { "x-gateway-developer": dev.developerId, ...budgetHeaders(budget) };
  if (budget.exceeded) {
    if (cfg.budgetAction === "block") {
      log({ event: "budget_block", developer: dev.developerId, reason: budget.reason, spentUsd: budget.spentUsd, limitUsd: budget.limitUsd, usedTokens: budget.usedTokens, limitTokens: budget.limitTokens });
      return apiError(res, 429, "rate_limit_error", budgetMessage(budget), { ...extraHeaders, "retry-after": "3600", "x-should-retry": "false" });
    }
    if (cfg.budgetAction === "downgrade" && cfg.downgradeModel && isConversationStart(body)) {
      forceModel = cfg.downgradeModel;
    }
  }

  const incomingBeta = headerStr(req, "anthropic-beta");
  const tr = transformRequest(body, incomingBeta, meta, cfg, { forceModel });

  // The allowlist applies to what the developer asked for; operator routing (subagent -> Sonnet etc.) is exempt.
  if (!isModelAllowed(dev, requestedModel, cfg.modelMap)) {
    return apiError(res, 403, "permission_error", `Model ${requestedModel} is not allowed for this developer. Allowed: ${dev.allowedModels!.join(", ")}.`, extraHeaders);
  }

  const stream = body.stream === true;
  // Runtime mode addresses the model in the URL and usually needs an inference-profile id.
  const mode = dev.upstreamMode ?? cfg.upstreamMode;
  const invokedModel = mode === "runtime" ? toRuntimeModelId(tr.upstreamModel, cfg.bedrockProfilePrefix, catalog.peek().models) : tr.upstreamModel;
  if (mode === "runtime") tr.notes.push(invokedModel !== tr.upstreamModel ? `runtime:${invokedModel.split(".")[0]}` : "runtime");

  const ac = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  let upstreamRes: Response;
  try {
    if (mode === "runtime") {
      upstreamRes = await runtime.messages(invokedModel, body, tr.betaHeader, stream, ac.signal);
    } else {
      const upstreamHeaders = upstream.pickRequestHeaders(req.headers, tr.betaHeader);
      upstreamRes = await upstream.send("POST", `/v1/messages${query}`, upstreamHeaders, JSON.stringify(body), ac.signal, cfg.upstreamTimeoutMs);
    }
  } catch (e) {
    if (res.writableEnded || ac.signal.aborted) return; // client went away; nothing to answer
    const cause = (e as Error & { cause?: unknown }).cause;
    const msg = cause instanceof Error ? cause.message : (e as Error).message;
    const timedOut = /did not respond within/.test(msg);
    log({ event: timedOut ? "upstream_timeout" : "upstream_error", developer: dev.developerId, error: msg });
    return apiError(res, timedOut ? 504 : 502, "api_error", `Upstream request failed: ${msg}`, extraHeaders);
  }

  const resHeaders: Record<string, string> = { ...upstream.pickResponseHeaders(upstreamRes), ...extraHeaders, "x-gateway-model": invokedModel, "x-gateway-api": mode };
  let summary: StreamSummary = { usage: { ...EMPTY_USAGE }, sawMessageStop: false };

  const finish = (status: number, errorType?: string) => {
    const rec: RequestRecord = {
      ts: new Date(started).toISOString(),
      developerId: dev.developerId,
      team: dev.team,
      model: invokedModel,
      requestedModel,
      requestClass: meta.requestClass ?? "unknown",
      sessionId: meta.sessionId,
      status,
      latencyMs: Date.now() - started,
      usage: summary.usage,
      costUsd: estimateCostUsd(invokedModel, summary.usage),
      savedUsd: savingsUsd(requestedModel, invokedModel, summary.usage),
      stream,
      notes: tr.notes,
      errorType: errorType ?? summary.errorType,
    };
    void recordUsage(rec);
  };

  if (!upstreamRes.ok || !upstreamRes.body) {
    // Forward error bodies unmodified: Claude Code matches on upstream wording to decide retries.
    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, { ...resHeaders, "content-type": resHeaders["content-type"] ?? "application/json" });
    res.end(text);
    log({ event: "upstream_status", developer: dev.developerId, api: mode, status: upstreamRes.status, model: invokedModel, body: text.slice(0, 500) });
    finish(upstreamRes.status, "upstream_error");
    return;
  }

  const ct = upstreamRes.headers.get("content-type") ?? "";
  if (stream && ct.includes("text/event-stream")) {
    res.writeHead(upstreamRes.status, { ...resHeaders, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders();
    const tap = new SseUsageTap();
    try {
      await pipeline(Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream), tap, res);
    } catch (e) {
      log({ event: "stream_interrupted", developer: dev.developerId, error: String(e) });
    }
    summary = tap.summary;
    finish(upstreamRes.status, tap.summary.sawMessageStop ? undefined : "incomplete_stream");
    return;
  }

  const text = await upstreamRes.text();
  res.writeHead(upstreamRes.status, { ...resHeaders, "content-type": ct || "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
  try {
    summary = summaryFromMessage(JSON.parse(text) as Record<string, unknown>);
  } catch {
    /* non-JSON success body: leave usage empty */
  }
  finish(upstreamRes.status);
}

async function handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse, query: string): Promise<void> {
  const dev = await authenticate(req, res);
  if (!dev) return;
  let raw: Buffer;
  try {
    raw = await readBody(req, cfg.maxBodyBytes);
  } catch {
    return apiError(res, 413, "invalid_request_error", "Request body too large.");
  }
  let body: Json;
  try {
    body = JSON.parse(raw.toString("utf8")) as Json;
  } catch {
    return apiError(res, 400, "invalid_request_error", "Request body is not valid JSON.");
  }
  const tr = transformRequest(body, headerStr(req, "anthropic-beta"), metaFrom(req), { ...cfg, operatorPrompt: undefined, toolResultMaxChars: 0 });
  const ac = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const viaMantle = () => upstream.send("POST", `/v1/messages/count_tokens${query}`, upstream.pickRequestHeaders(req.headers, tr.betaHeader), JSON.stringify(body), ac.signal, cfg.upstreamTimeoutMs);
    let r: Response;
    if ((dev.upstreamMode ?? cfg.upstreamMode) === "runtime") {
      r = await runtime.countTokens(toRuntimeModelId(tr.upstreamModel, cfg.bedrockProfilePrefix, catalog.peek().models), body, tr.betaHeader, ac.signal);
      // Not every model supports Runtime CountTokens yet; the Mantle endpoint counts for all of them.
      if (r.status === 400 && /counting tokens/i.test(await r.clone().text())) r = await viaMantle();
    } else {
      r = await viaMantle();
    }
    const text = await r.text();
    res.writeHead(r.status, { ...upstream.pickResponseHeaders(r), "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(text);
  } catch (e) {
    apiError(res, 502, "api_error", `Upstream request failed: ${(e as Error).message}`);
  }
}

/** Anthropic-shaped model list: gateway aliases plus whatever Bedrock currently serves in this region. */
async function handleModels(res: http.ServerResponse, dev: Developer): Promise<void> {
  const snap = await catalog.get();
  const data = modelsForClients(cfg.modelMap, snap.models).filter((m) => isModelAllowed(dev, m.id, cfg.modelMap));
  sendJson(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
}

/** Dry-run a draft policy against canned Claude Code requests so the admin UI can show its effect before saving. */
function previewPolicy(draft: Policy) {
  const draftCfg = effectiveConfig(baseCfg, draft);
  const sample = (cls: string, model = "claude-opus-5-5") => {
    const body: Json = {
      model,
      max_tokens: 4096,
      stream: true,
      thinking: { type: "adaptive" },
      context_management: { edits: [] },
      output_config: { format: { type: "json_schema" } },
      system: [{ type: "text", text: "x-anthropic-attribution" }, { type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Bash", input_schema: { type: "object" }, strict: true }],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(60_000) }] }],
    };
    const beta = "interleaved-thinking-2025-05-14,context-management-2025-06-27,context-1m-2025-08-07";
    const tr = transformRequest(body, beta, { requestClass: cls }, draftCfg);
    const served = draftCfg.upstreamMode === "runtime" ? toRuntimeModelId(tr.upstreamModel, draftCfg.bedrockProfilePrefix, catalog.peek().models) : tr.upstreamModel;
    const sys = body.system as Json[];
    return {
      requestClass: cls,
      requestedModel: model,
      servedModel: served,
      api: draftCfg.upstreamMode,
      effort: (body.output_config as Json | undefined)?.effort ?? null,
      betaHeader: tr.betaHeader ?? "",
      systemBlocks: sys.length,
      operatorPromptAppended: sys.at(-1)?.text === draftCfg.operatorPrompt && !!draftCfg.operatorPrompt,
      toolResultChars: String((((body.messages as Json[])[0].content as Json[])[0] as Json).content).length,
      cacheTtl: (sys[1]?.cache_control as Json | undefined)?.ttl ?? "5m",
      notes: tr.notes,
    };
  };
  return { classes: ["main", "subagent", "auxiliary", "compaction"].map((c) => sample(c)), priceKnown: Object.keys(draft.pricing).length };
}

/** Connectivity self-test for the System page: store, model catalog, a free count_tokens round trip, Marketplace state. */
async function diagnose() {
  const t0 = Date.now();
  const out: Record<string, { ok: boolean; ms: number; detail: string }> = {};
  const timed = async (name: string, fn: () => Promise<string>) => {
    const s = Date.now();
    try {
      out[name] = { ok: true, ms: Date.now() - s, detail: await fn() };
    } catch (e) {
      out[name] = { ok: false, ms: Date.now() - s, detail: (e as Error).message };
    }
  };
  await timed("store", async () => `${store.kind}: ${(await store.keys.list()).length} developer records`);
  await timed("catalog", async () => {
    const snap = await catalog.get();
    if (snap.disabled) return "disabled";
    if (snap.error) throw new Error(snap.error);
    return `${snap.models.length} Anthropic models in ${snap.region}`;
  });
  await timed("bedrock", async () => {
    const model = cfg.modelMap["claude-haiku-4-5"] ?? Object.values(cfg.modelMap)[0] ?? "anthropic.claude-haiku-4-5";
    const body: Json = { model, messages: [{ role: "user", content: "ping" }] };
    const tr = transformRequest(body, undefined, {}, { ...cfg, operatorPrompt: undefined, toolResultMaxChars: 0 });
    const ac = new AbortController();
    const r =
      cfg.upstreamMode === "runtime"
        ? await runtime.countTokens(toRuntimeModelId(tr.upstreamModel, cfg.bedrockProfilePrefix, catalog.peek().models), body, undefined, ac.signal)
        : await upstream.send("POST", "/v1/messages/count_tokens", upstream.pickRequestHeaders({}, undefined), JSON.stringify(body), ac.signal, 15_000);
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
    return `${cfg.upstreamMode} count_tokens ok (${upstream.authMode}) -> ${text.slice(0, 60)}`;
  });
  out.marketplace = { ok: marketplace.state !== "failed", ms: 0, detail: marketplace.state };
  return { ok: Object.values(out).every((c) => c.ok), ms: Date.now() - t0, checks: out };
}

const server = http.createServer(async (req, res) => {
  const { path, query, params } = normalizePath(req.url ?? "/");
  try {
    if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true, api: cfg.upstreamMode, upstream: upstreamLabel(), auth: upstream.authMode, store: store.kind, marketplace: marketplace.state });
    if (req.method === "HEAD" && path === "/api/hello") {
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "GET" && (path === "/" || path === "")) {
      res.writeHead(302, { location: "/admin/" });
      return res.end();
    }
    if (adminToken && (await handleAdmin(req, res, path, params, { cfg: baseCfg, store, auth, adminToken, getPolicy: () => policy, setPolicy, startedAt, catalog, runtimeEndpoint, version: VERSION, authMode: upstream.authMode, marketplace: () => marketplace.state, diagnose, previewPolicy }))) return;
    if (req.method === "GET" && path === "/v1/models") {
      const dev = await authenticate(req, res);
      if (!dev) return;
      return await handleModels(res, dev);
    }
    if (req.method === "POST" && path === "/v1/messages") return await handleMessages(req, res, query);
    if (req.method === "POST" && path === "/v1/messages/count_tokens") return await handleCountTokens(req, res, query);
    return apiError(res, 404, "not_found_error", `No route for ${req.method} ${path}`);
  } catch (e) {
    log({ event: "unhandled", error: String((e as Error).stack ?? e) });
    if (!res.headersSent) apiError(res, 500, "api_error", "Gateway internal error.");
    else res.end();
  }
});

// Long model turns: do not let Node cut the connection while the upstream thinks.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

// AWS Marketplace container product: register this task before serving. Entitlement failures stop the task,
// which is what Marketplace requires; transient failures after retries are logged and the task still exits so
// ECS restarts it (a running task without a registration would not be billed).
const marketplaceSettings = marketplaceSettingsFromEnv();
let marketplace: MarketplaceStatus = { state: "disabled" };
if (marketplaceSettings.productCode) {
  marketplace = await registerWithMarketplace(sdkMeteringClient(baseCfg.awsRegion), marketplaceSettings);
  log({ event: "marketplace_register", ...marketplace });
  if (marketplace.state === "failed") {
    log({ event: "marketplace_exit", reason: marketplace.error, fatal: marketplace.fatal });
    process.exit(marketplace.fatal ? 78 : 1); // 78 = EX_CONFIG
  }
}

await reloadPolicy();
if (store.kind === "dynamo") setInterval(() => void reloadPolicy(), 30_000).unref();
// Warm the model catalog in the background so the first /v1/models or admin call is instant.
void catalog.get().then((s) => log({ event: "model_catalog", models: s.models.length, error: s.error, disabled: s.disabled }));

server.listen(cfg.port, () => {
  log({
    event: "listening",
    port: cfg.port,
    api: cfg.upstreamMode,
    upstream: upstreamLabel(),
    auth: upstream.authMode,
    region: cfg.awsRegion,
    store: store.kind,
    admin: adminToken ? `http://localhost:${cfg.port}/admin/` : "disabled (set ADMIN_TOKEN)",
    effortMode: cfg.effortMode,
    bridge: cfg.bridgeBedrock,
    budgetAction: cfg.budgetAction,
  });
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log({ event: "shutdown", signal: sig });
    server.close(() => void store.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
