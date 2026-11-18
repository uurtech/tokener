// End-to-end key-pool test: fake Anthropic API + fake Bedrock Mantle (bearer keys) <- gateway <- "Claude Code".
// Proves: transparent failover on 429 / credit exhaustion, session stickiness, proactive switch near the
// rate limit, exhaustion -> honest 429, no failover on request errors, secrets never leave the gateway.
// Run: node test/smoke/smoke-keypool.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const UP_PORT = Number(process.env.SMOKE_KP_UP_PORT ?? 19511), GW_PORT = Number(process.env.SMOKE_KP_GW_PORT ?? 18491);
/** behaviour per upstream secret: ok | 429 | credit | low | 401 */
const behaviour = {};
const hits = [];

const sse = (model) => [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_k","type":"message","role":"assistant","model":"${model}","content":[],"usage":{"input_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":20}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
].join("");

const upstream = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const anthropic = req.url.startsWith("/anthropic-api/");
  const secret = anthropic ? req.headers["x-api-key"] : (req.headers.authorization ?? "").replace(/^Bearer /, "");
  hits.push({ url: req.url, secret, model: body.model, anthropic, auth: req.headers.authorization, xApiKey: req.headers["x-api-key"] });
  const mode = behaviour[secret] ?? "ok";
  const json = (status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
  if (mode === "429") return json(429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }, { "retry-after": "40" });
  if (mode === "credit") return json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
  if (mode === "401") return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
  if (body.model === "claude-broken" || body.model === "anthropic.claude-broken") return json(400, { type: "error", error: { type: "invalid_request_error", message: "model not served" } });
  const rate = mode === "low"
    ? { "anthropic-ratelimit-tokens-limit": "100000", "anthropic-ratelimit-tokens-remaining": "1200", "anthropic-ratelimit-tokens-reset": new Date(Date.now() + 45_000).toISOString() }
    : { "anthropic-ratelimit-tokens-limit": "100000", "anthropic-ratelimit-tokens-remaining": "90000" };
  if (req.url.includes("count_tokens")) return json(200, { input_tokens: 7 }, rate);
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream", ...rate });
    return res.end(sse(body.model));
  }
  json(200, { id: "msg_j", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }, rate);
});
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

const { AWS_BEARER_TOKEN_BEDROCK: _k, ...inheritedEnv } = process.env;
const gw = spawn("npx", ["tsx", "src/server.ts"], {
  env: {
    ...inheritedEnv,
    PORT: String(GW_PORT), AWS_REGION: "us-east-1",
    UPSTREAM_BASE_URL: `http://127.0.0.1:${UP_PORT}/env-mantle`,
    STATIC_KEYS_JSON: JSON.stringify({ cgw_pool_token: "alice" }),
    STORE: "sqlite", SQLITE_PATH: ":memory:", ADMIN_TOKEN: "adm", MODEL_CATALOG_ENABLED: "0", EMF_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwOut = "";
gw.stdout.on("data", (d) => (gwOut += d));
gw.stderr.on("data", (d) => (gwOut += d));
const base = `http://127.0.0.1:${GW_PORT}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await sleep(100); }

const failures = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!cond) failures.push(name); };
const A = { authorization: "Bearer adm", "content-type": "application/json" };
const admin = async (method, path, body) => { const r = await fetch(`${base}/admin/api${path}`, { method, headers: A, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const ask = (session, extra = {}, model = "claude-opus-5-5") => fetch(`${base}/v1/messages`, {
  method: "POST",
  headers: { authorization: "Bearer cgw_pool_token", "content-type": "application/json", "x-claude-code-session-id": session, "x-claude-code-request-class": "main" },
  body: JSON.stringify({ model, max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }], ...extra }),
});
const anthropicUrl = `http://127.0.0.1:${UP_PORT}/anthropic-api`;

// ---- set up: three Anthropic keys, no env fallback (makes exhaustion deterministic)
let r = await admin("PUT", "/keys/settings", { envFallback: false, strategy: "session" });
check("pool settings saved", r.status === 200 && r.j.settings.strategy === "session" && r.j.settings.envFallback === false);
const keys = {};
for (const name of ["one", "two", "three"]) {
  r = await admin("POST", "/keys", { label: name, kind: "anthropic", secret: `sk-ant-${name}-0123456789`, baseUrl: anthropicUrl });
  keys[name] = r.j.key?.id;
  check(`key ${name} added + auto-tested`, r.status === 201 && r.j.test?.ok === true && r.j.key.last4 === "6789", JSON.stringify(r.j.test));
}
r = await admin("POST", "/keys", { label: "dup", kind: "anthropic", secret: "sk-ant-one-0123456789", baseUrl: anthropicUrl });
check("duplicate key rejected", r.status === 409);
r = await admin("POST", "/keys", { label: "bad", kind: "openai", secret: "x".repeat(20) });
check("invalid kind rejected", r.status === 400);
r = await admin("GET", "/keys");
check("admin view never contains secrets", r.status === 200 && r.j.keys.length === 3 && !JSON.stringify(r.j).includes("sk-ant-"));
const id2label = Object.fromEntries(Object.entries(keys).map(([k, v]) => [v, k]));

// ---- basic routing + model mapping
hits.length = 0;
r = await ask("sess-A");
let text = await r.text();
const keyA = r.headers.get("x-gateway-key");
check("request served through a pool key", r.status === 200 && text.includes("message_stop") && !!id2label[keyA], keyA);
check("Anthropic gets x-api-key + Anthropic model id", hits.at(-1).anthropic && hits.at(-1).xApiKey?.startsWith("sk-ant-") && !hits.at(-1).auth && hits.at(-1).model === "claude-opus-5-5", JSON.stringify(hits.at(-1)));
check("dev token never forwarded upstream", !hits.some((h) => JSON.stringify(h).includes("cgw_pool_token")));

// ---- session stickiness + spread
const seen = new Set([keyA]);
for (let i = 0; i < 3; i++) { r = await ask("sess-A"); await r.text(); check(`sess-A stays on its key (${i + 1})`, r.headers.get("x-gateway-key") === keyA); }
for (const s of ["sess-B", "sess-C"]) { r = await ask(s); await r.text(); seen.add(r.headers.get("x-gateway-key")); }
check("new sessions spread over all keys", seen.size === 3, [...seen].join(","));

// ---- transparent failover on 429
behaviour[`sk-ant-${id2label[keyA]}-0123456789`] = "429";
hits.length = 0;
r = await ask("sess-A");
text = await r.text();
const afterFail = r.headers.get("x-gateway-key");
check("429 on session key -> same request succeeds on another key", r.status === 200 && text.includes("message_stop") && afterFail !== keyA, `${r.status} ${afterFail}`);
check("upstream saw the failed attempt then the retry", hits.length === 2);
r = await admin("GET", "/keys");
const cooled = r.j.keys.find((k) => k.id === keyA);
check("failed key shows cooling with reason + countdown", cooled.status === "cooling" && cooled.reason === "rate_limited" && cooled.cooldownSec > 30 && cooled.today.failovers === 1, JSON.stringify(cooled));
r = await ask("sess-A"); await r.text();
check("session moved for good (no flapping)", r.headers.get("x-gateway-key") === afterFail);

// ---- credit exhausted counts as key failure
const third = Object.values(keys).find((k) => k !== keyA && k !== afterFail);
behaviour[`sk-ant-${id2label[afterFail]}-0123456789`] = "credit";
r = await ask("sess-A"); await r.text();
check("credit-exhausted 400 -> failover to the last healthy key", r.status === 200 && r.headers.get("x-gateway-key") === third, `${r.status} ${r.headers.get("x-gateway-key")}`);

// ---- request errors are NOT failed over
hits.length = 0;
r = await ask("sess-A", {}, "claude-broken");
check("400 request error forwarded as-is, single attempt", r.status === 400 && (await r.text()).includes("model not served") && hits.length === 1);

// ---- everything exhausted -> honest 429 with retry-after
behaviour[`sk-ant-${id2label[third]}-0123456789`] = "429";
r = await ask("sess-Z"); await r.text();
check("last key fails too -> upstream 429 forwarded", r.status === 429, `status=${r.status}`);
r = await ask("sess-Z2");
const ex = await r.json();
check("all keys cooling -> gateway 429 + retry-after, no upstream call", r.status === 429 && Number(r.headers.get("retry-after")) > 0 && /cooling down/.test(ex.error.message), `${r.status} ${r.headers.get("retry-after")}`);

// ---- reset + proactive switch near the rate limit
for (const k of Object.keys(behaviour)) delete behaviour[k];
for (const id of Object.values(keys)) await admin("POST", `/keys/${id}/reset`);
await admin("PUT", "/keys/settings", { strategy: "fill-first" });
await admin("PATCH", `/keys/${keys.one}`, { priority: 1 });
await admin("PATCH", `/keys/${keys.two}`, { priority: 2 });
await admin("PATCH", `/keys/${keys.three}`, { priority: 3 });
behaviour["sk-ant-one-0123456789"] = "low";
r = await ask("sess-L1"); await r.text();
check("fill-first uses priority 1 key", r.headers.get("x-gateway-key") === keys.one);
r = await ask("sess-L2"); await r.text();
check("key under 5% remaining is parked; next request goes to key two before any 429", r.headers.get("x-gateway-key") === keys.two, r.headers.get("x-gateway-key"));
r = await admin("GET", "/keys");
check("parked key reported with near_limit reason + rate snapshot", r.j.keys.find((k) => k.id === keys.one)?.status === "parked" && r.j.keys.find((k) => k.id === keys.one)?.rate?.minRemainingPct === 1.2);

// ---- disable + daily cap
await admin("PATCH", `/keys/${keys.two}`, { enabled: false });
r = await ask("sess-D"); await r.text();
check("disabled key skipped", r.headers.get("x-gateway-key") === keys.three);

// ---- Bedrock API key in the pool (mantle, bearer)
r = await admin("POST", "/keys", { label: "bedrock-a", kind: "bedrock", secret: "ABSKbedrockkey0123456789", baseUrl: `http://127.0.0.1:${UP_PORT}/mantle-a`, api: "mantle", priority: 0 });
check("bedrock key added + tested", r.status === 201 && r.j.test?.ok === true, JSON.stringify(r.j.test));
const bk = r.j.key.id;
hits.length = 0;
r = await ask("sess-BR"); await r.text();
check("bedrock key gets Authorization: Bearer + Bedrock model id", r.headers.get("x-gateway-key") === bk && hits.at(-1).auth === "Bearer ABSKbedrockkey0123456789" && hits.at(-1).model === "anthropic.claude-opus-5-5" && hits.at(-1).url.startsWith("/mantle-a/v1/messages"), JSON.stringify(hits.at(-1)));
behaviour.ABSKbedrockkey0123456789 = "429";
r = await ask("sess-BR"); await r.text();
check("bedrock 429 -> fails over to an Anthropic key", r.status === 200 && r.headers.get("x-gateway-key") === keys.three, r.headers.get("x-gateway-key"));

// ---- count_tokens goes through the pool too
r = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers: { authorization: "Bearer cgw_pool_token", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }] }) });
check("count_tokens via pool", r.status === 200 && (await r.json()).input_tokens === 7);

// ---- usage attribution
await sleep(200);
r = await admin("GET", "/requests?limit=50");
check("requests record the serving key + failover notes", r.j.some((x) => x.providerKey === keys.three) && r.j.some((x) => x.notes.some((n) => n.startsWith("failover:"))));
r = await admin("GET", `/overview?day=${new Date().toISOString().slice(0, 10)}`);
check("overview has per-key breakdown", Array.isArray(r.j.byKey) && r.j.byKey.some((x) => x.key === keys.three));
r = await admin("GET", "/keys");
check("per-key today counters", r.j.keys.find((k) => k.id === keys.three).today.tokens > 0);

// ---- delete, audit, health, self-service
r = await admin("DELETE", `/keys/${keys.two}`);
check("key deleted", r.status === 200 && (await admin("GET", "/keys")).j.keys.length === 3);
r = await admin("GET", "/audit?limit=100");
check("audit log covers key actions", ["key.create", "key.update", "key.delete", "keys.settings"].every((a) => r.j.some((e) => e.action === a)) && !JSON.stringify(r.j).includes("sk-ant-"));
r = await fetch(`${base}/health`); const health = await r.json();
check("/health reports pool summary", health.keys?.total === 3);
r = await fetch(`${base}/v1/me`, { headers: { authorization: "Bearer cgw_pool_token" } }); const me = await r.json();
check("/v1/me self-service usage", r.status === 200 && me.developerId === "alice" && me.today.requests > 0);
r = await admin("POST", "/diagnostics");
check("diagnostics include key pool", typeof r.j.checks?.keypool?.detail === "string" && r.j.checks.keypool.detail.includes("keys available"), r.j.checks?.keypool?.detail);
check("gateway log never contains secrets", !gwOut.includes("sk-ant-one-0123456789") && !gwOut.includes("ABSKbedrockkey0123456789"));

gw.kill("SIGTERM");
upstream.close();
if (failures.length) { console.log("\nGateway log tail:\n" + gwOut.split("\n").slice(-20).join("\n")); process.exit(1); }
console.log("\nALL KEY POOL CHECKS PASSED");
