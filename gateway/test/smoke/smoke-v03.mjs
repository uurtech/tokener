// End-to-end checks for alerts, team key groups, monthly budgets, persisted key state, the /me page and
// admin SSO (OIDC). Fake Anthropic upstream + fake identity provider + fake webhook receiver, real gateway.
// Run: node test/smoke/smoke-v03.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const UP_PORT = Number(process.env.SMOKE_V3_UP_PORT ?? 19531), GW_PORT = Number(process.env.SMOKE_V3_GW_PORT ?? 18521);
const UP = `http://127.0.0.1:${UP_PORT}`;
const behaviour = {}; // secret -> ok | 429 | credit
const hooks = [];
const hits = [];

// ---- fake identity provider
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const codes = {}; // code -> { email, nonce }
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims) => {
  const data = `${b64u({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64u(claims)}`;
  return `${data}.${sign("sha256", Buffer.from(data), privateKey).toString("base64url")}`;
};

const upstream = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const json = (status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
  // identity provider
  if (req.url === "/idp/.well-known/openid-configuration") return json(200, { issuer: `${UP}/idp`, authorization_endpoint: `${UP}/idp/authorize`, token_endpoint: `${UP}/idp/token`, jwks_uri: `${UP}/idp/jwks` });
  if (req.url === "/idp/jwks") return json(200, { keys: [jwk] });
  if (req.url === "/idp/token") {
    const form = new URLSearchParams(raw);
    const c = codes[form.get("code")];
    if (!c || !form.get("code_verifier") || form.get("client_secret") !== "idp-secret") return json(400, { error: "invalid_grant" });
    return json(200, { id_token: idToken({ iss: `${UP}/idp`, aud: "tokener-admin", exp: Math.floor(Date.now() / 1000) + 300, email: c.email, email_verified: true, nonce: c.nonce, name: "Test User" }) });
  }
  // webhook receiver
  if (req.url === "/hook") { hooks.push(JSON.parse(raw)); return json(200, { ok: true }); }
  // Anthropic API
  const body = raw ? JSON.parse(raw) : {};
  const secret = req.headers["x-api-key"];
  hits.push({ secret, url: req.url });
  const mode = behaviour[secret] ?? "ok";
  if (mode === "429") return json(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { "retry-after": "120" });
  if (mode === "credit") return json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
  if (req.url.includes("count_tokens")) return json(200, { input_tokens: 3 });
  json(200, { id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 500 } });
});
await new Promise((r) => upstream.listen(UP_PORT, "127.0.0.1", r));

const dir = mkdtempSync(path.join(tmpdir(), "tokener-v03-"));
const { AWS_BEARER_TOKEN_BEDROCK: _k, ...inheritedEnv } = process.env;
let gwOut = "";

// Watchdog: never hang CI. Dump the gateway log and fail if the suite takes longer than 2 minutes.
setTimeout(() => { console.log("\nTIMEOUT: smoke suite did not finish in 120 s\nGateway log tail:\n" + gwOut.split("\n").slice(-40).join("\n")); process.exit(1); }, 120_000).unref();
let gw;
const startGateway = async () => {
  gw = spawn("npx", ["tsx", "src/server.ts"], {
    env: {
      ...inheritedEnv, PORT: String(GW_PORT), AWS_REGION: "us-east-1", STORE: "sqlite", SQLITE_PATH: path.join(dir, "gw.db"),
      ADMIN_TOKEN: "adm", KEY_POOL_SECRET: "pool-secret", MODEL_CATALOG_ENABLED: "0", UPSTREAM_BASE_URL: `${UP}/env`,
      OIDC_ISSUER: `${UP}/idp`, OIDC_CLIENT_ID: "tokener-admin", OIDC_CLIENT_SECRET: "idp-secret", OIDC_ALLOWED_DOMAINS: "archeon.dev", OIDC_LABEL: "Archeon SSO",
      ALERT_SOURCE: "smoke",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gw.stdout.on("data", (d) => (gwOut += d));
  gw.stderr.on("data", (d) => (gwOut += d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${GW_PORT}/health`)).ok) return; } catch {} await sleep(100); }
};
const stopGateway = async () => { gw.kill("SIGTERM"); await new Promise((r) => gw.once("exit", r)); };
await startGateway();

const base = `http://127.0.0.1:${GW_PORT}`;
const failures = [];
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!cond) failures.push(name); };
const A = { authorization: "Bearer adm", "content-type": "application/json" };
const admin = async (method, p, body) => { const r = await fetch(`${base}/admin/api${p}`, { method, headers: A, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const ask = (token, session = "s1", model = "claude-opus-5-5") => fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-claude-code-session-id": session }, body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });

// ---------- setup
let r = await admin("GET", "/policy");
r = await admin("PUT", "/policy", { ...r.j, alertWebhookUrl: `${UP}/hook`, alertOnBudget: true, budgetAction: "block" });
check("policy accepts alert webhook", r.status === 200 && r.j.alertWebhookUrl === `${UP}/hook`);
r = await admin("PUT", "/policy", { ...r.j, alertWebhookUrl: "javascript:alert(1)" });
check("invalid webhook URL rejected", r.status === 400);
await admin("PUT", "/keys/settings", { envFallback: false, strategy: "fill-first" });
const mk = async (label, extra = {}) => (await admin("POST", "/keys?test=0", { label, kind: "anthropic", secret: `sk-ant-${label}-0123456789`, baseUrl: UP, ...extra })).j.key;
const shared = await mk("shared", { priority: 1 });
const backend = await mk("backend", { teams: "backend, data", priority: 2 });
check("key with teams saved", backend.teams?.join(",") === "backend,data", JSON.stringify(backend.teams));
const devB = (await admin("POST", "/developers", { developerId: "bea", team: "backend", dailyBudgetUsd: 0 })).j.token;
const devF = (await admin("POST", "/developers", { developerId: "fred", team: "frontend", dailyBudgetUsd: 0 })).j.token;

// ---------- alerts: test delivery
r = await admin("POST", "/alerts/test");
await sleep(100);
check("test alert delivered (Slack text + Discord content + event)", r.status === 200 && r.j.delivered && hooks.some((h) => h.event?.kind === "test" && h.text.includes("Test alert") && h.content));

// ---------- team key groups
r = await ask(devB); await r.text();
check("backend developer served by the backend-reserved key first", r.headers.get("x-gateway-key") === backend.id, r.headers.get("x-gateway-key"));
r = await ask(devF); await r.text();
check("frontend developer never gets the backend key", r.headers.get("x-gateway-key") === shared.id);
behaviour["sk-ant-backend-0123456789"] = "429";
r = await ask(devB, "s2"); await r.text();
check("backend overflows to the shared key when its key is limited", r.status === 200 && r.headers.get("x-gateway-key") === shared.id);

// ---------- key alerts
hooks.length = 0;
behaviour["sk-ant-shared-0123456789"] = "credit";
r = await ask(devF, "s3"); await r.text();
await sleep(150);
const down = hooks.find((h) => h.event?.kind === "key.down");
check("out-of-credit key -> critical key.down alert", !!down && down.event.severity === "critical" && down.text.includes("shared") && !JSON.stringify(down).includes("sk-ant-"), JSON.stringify(down?.event?.title));
check("last key failing -> its real upstream error is forwarded", r.status === 400);
r = await ask(devF, "s4"); await r.text();
await sleep(150);
check("no key left -> 429 + critical pool.exhausted alert", r.status === 429 && hooks.some((h) => h.event?.kind === "pool.exhausted" && h.event.severity === "critical"));
const before = hooks.length;
for (const s of ["s5", "s6", "s7"]) { r = await ask(devF, s); await r.text(); }
await sleep(150);
check("alerts are throttled (no repeat flood)", hooks.length === before, `${before} -> ${hooks.length}`);
r = await admin("GET", "/alerts");
check("alert history visible to admins", r.j.history.some((a) => a.kind === "key.down") && r.j.webhookConfigured === true);

// ---------- persisted key state survives a restart
r = await admin("GET", "/keys");
const cooling = r.j.keys.filter((k) => k.status === "cooling").map((k) => k.id).sort();
await stopGateway();
await startGateway();
r = await admin("GET", "/keys");
const after = r.j.keys.filter((k) => k.status === "cooling").map((k) => k.id).sort();
check("cooldowns survive a gateway restart", cooling.length === 2 && JSON.stringify(after) === JSON.stringify(cooling), `${cooling} -> ${after}`);
check("encrypted keys still readable after restart", r.j.keys.every((k) => k.status !== "error"));

// ---------- monthly budget
for (const id of [shared.id, backend.id]) await admin("POST", `/keys/${id}/reset`);
for (const k of Object.keys(behaviour)) delete behaviour[k];
const devM = (await admin("POST", "/developers", { developerId: "mona", dailyBudgetUsd: 0, monthlyBudgetUsd: 0.01 })).j.token;
r = await ask(devM); await r.text();
check("monthly cap reported in headers", r.status === 200 && /^0\.00\/0\.01$/.test(r.headers.get("x-gateway-budget-month") ?? ""), r.headers.get("x-gateway-budget-month"));
await sleep(200);
hooks.length = 0;
r = await ask(devM);
const blocked = await r.json();
await sleep(150);
check("monthly cap exceeded -> 429 with monthly message", r.status === 429 && /Monthly gateway budget exceeded/.test(blocked.error?.message) && r.headers.get("x-gateway-budget-status") === "exceeded:month_usd", blocked.error?.message);
check("budget alert sent once", hooks.filter((h) => h.event?.kind === "budget.exceeded" && h.event.fields?.developer === "mona").length === 1);
r = await admin("PATCH", "/developers/mona", { monthlyBudgetUsd: 0 });
r = await ask(devM); await r.text();
check("monthly cap removable via PATCH", r.status === 200);
r = await admin("GET", "/developers");
check("developer list includes month totals", r.j.find((d) => d.developerId === "mona")?.monthCostUsd > 0);

// ---------- developer self-service
r = await fetch(`${base}/me/`);
check("/me page served without admin rights", r.status === 200 && (await r.text()).includes("My usage"));
r = await fetch(`${base}/me/me.js`);
check("/me script served", r.status === 200 && (r.headers.get("content-type") ?? "").includes("javascript"));
r = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${devM}` } });
const me = await r.json();
check("/v1/me has month, 14-day trend and limits", me.month.costUsd > 0 && me.trend.length === 14 && me.limits.monthlyBudgetUsd === null && typeof me.monthResetsAt === "string");

// ---------- admin SSO
r = await fetch(`${base}/admin/api/auth-config`);
const ac = await r.json();
check("auth-config advertises SSO", ac.sso === true && ac.ssoLabel === "Archeon SSO" && ac.tokenLogin === true);
const ssoLogin = async (email) => {
  const lr = await fetch(`${base}/admin/sso/login`, { redirect: "manual" });
  const loc = new URL(lr.headers.get("location"));
  const flowCookie = lr.headers.get("set-cookie").split(";")[0];
  const code = `code-${Math.random().toString(36).slice(2)}`;
  codes[code] = { email, nonce: loc.searchParams.get("nonce") };
  const cb = await fetch(`${base}/admin/sso/callback?state=${loc.searchParams.get("state")}&code=${code}`, { redirect: "manual", headers: { cookie: flowCookie } });
  return { lr, loc, cb };
};
let { lr, loc, cb } = await ssoLogin("ugur@archeon.dev");
check("SSO login redirects to the IdP with PKCE", lr.status === 302 && loc.pathname === "/idp/authorize" && loc.searchParams.get("code_challenge_method") === "S256");
const sessionCookie = (cb.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("tk_admin="))?.split(";")[0];
check("callback sets an HttpOnly session cookie and returns to the console", cb.status === 302 && cb.headers.get("location") === "/admin/" && !!sessionCookie);
r = await fetch(`${base}/admin/api/me`, { headers: { cookie: sessionCookie } });
const meAdmin = await r.json();
check("session cookie authenticates admin API", r.status === 200 && meAdmin.via === "sso" && meAdmin.email === "ugur@archeon.dev");
r = await fetch(`${base}/admin/api/keys/settings`, { method: "PUT", headers: { cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ softLimitPct: 7 }) });
check("cookie write without X-Requested-With is refused (CSRF guard)", r.status === 403);
r = await fetch(`${base}/admin/api/keys/settings`, { method: "PUT", headers: { cookie: sessionCookie, "content-type": "application/json", "x-requested-with": "tokener" }, body: JSON.stringify({ softLimitPct: 7 }) });
check("cookie write with the header works", r.status === 200);
r = await admin("GET", "/audit?limit=20");
check("audit log records the SSO user as actor", r.j.some((e) => e.action === "keys.settings" && e.details?.actor === "ugur@archeon.dev") && r.j.some((e) => e.action === "admin.sso.login"));
({ cb } = await ssoLogin("mallory@evil.com"));
check("e-mail outside allowed domains is refused", cb.status === 403 && (await cb.text()).includes("not allowed"));
r = await fetch(`${base}/admin/api/me`, { headers: { cookie: "tk_admin=forged.value" } });
check("forged session cookie rejected", r.status === 401);
r = await fetch(`${base}/admin/sso/logout`, { redirect: "manual", headers: { cookie: sessionCookie } });
check("logout clears the session cookie", r.status === 302 && /tk_admin=;/.test(r.headers.get("set-cookie") ?? ""));
r = await admin("GET", "/config");
check("config reports encryption + SSO", r.j.keyEncryption === "secret" && r.j.sso?.issuer === `${UP}/idp`);

check("no secrets in gateway log", !/sk-ant-\w+-0123456789|idp-secret|pool-secret/.test(gwOut));

await stopGateway();
upstream.close();
rmSync(dir, { recursive: true, force: true });
if (failures.length) { console.log("\nGateway log tail:\n" + gwOut.split("\n").slice(-25).join("\n")); process.exit(1); }
console.log("\nALL v0.3 CHECKS PASSED");
