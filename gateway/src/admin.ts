/**
 * Admin API + static UI under /admin. Protected by a single bearer token
 * (ADMIN_TOKEN). If ADMIN_TOKEN is unset the whole /admin surface is 404.
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Store } from "./store/types.js";
import { type Policy, validatePolicy } from "./policy-state.js";
import { generateToken, hashToken, type DeveloperAuth } from "./auth.js";
import { DEFAULT_MODEL_MAP } from "./config.js";
import { totalTokens } from "./budget.js";
import { annotateCatalog, type ModelCatalog } from "./models.js";
import { pricingTable, priceFor, priceKey } from "./pricing.js";
import { validatePricing } from "./policy-state.js";
import { fingerprint, validateSettings, type KeyPool, type ProviderKind } from "./keypool.js";
import type { Alerter } from "./alerts.js";
import { requestOrigin, type Oidc } from "./oidc.js";

export interface AdminDeps {
  cfg: Config;
  store: Store;
  auth: DeveloperAuth;
  adminToken: string;
  getPolicy: () => Policy;
  setPolicy: (p: Policy) => Promise<void>;
  startedAt: number;
  catalog: ModelCatalog;
  runtimeEndpoint: string;
  version: string;
  authMode: "api-key" | "sigv4";
  marketplace: () => string;
  diagnose: () => Promise<unknown>;
  previewPolicy: (draft: Policy) => unknown;
  pool: KeyPool;
  savePool: () => Promise<void>;
  testKey: (id: string) => Promise<{ ok: boolean; ms: number; status?: number; detail: string }>;
  alerter: Alerter;
  oidc: Oidc | null;
  /** Who is calling: "admin-token" or the SSO e-mail. Set per request. */
  actor?: string;
}

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** Shared validation for key create / patch. `partial` skips required checks. */
function keyInput(b: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || b.label !== undefined) {
    const label = String(b.label ?? "").trim();
    if (!label || label.length > 64) throw new BadRequest("label: 1-64 characters");
    out.label = label;
  }
  if (!partial) {
    if (b.kind !== "anthropic" && b.kind !== "bedrock") throw new BadRequest("kind must be anthropic or bedrock");
    out.kind = b.kind as ProviderKind;
  }
  if (!partial || (b.secret !== undefined && b.secret !== "")) {
    const secret = String(b.secret ?? "").trim();
    if (secret.length < 8 || secret.length > 8192 || /\s/.test(secret)) throw new BadRequest("secret: paste the full API key (no spaces)");
    out.secret = secret;
  }
  if (b.region !== undefined && b.region !== null && b.region !== "") {
    if (typeof b.region !== "string" || !REGION_RE.test(b.region)) throw new BadRequest("region must look like us-east-1");
    out.region = b.region;
  } else if (b.region === "" || b.region === null) out.region = "";
  if (b.api !== undefined) {
    if (b.api !== null && b.api !== "" && b.api !== "mantle" && b.api !== "runtime") throw new BadRequest("api must be mantle, runtime or empty");
    out.api = b.api || undefined;
    if (!out.api && partial) out.api = "";
  }
  if (b.baseUrl !== undefined && b.baseUrl !== null && b.baseUrl !== "") {
    try {
      const u = new URL(String(b.baseUrl));
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      throw new BadRequest("baseUrl must be an http(s) URL");
    }
    out.baseUrl = String(b.baseUrl).replace(/\/+$/, "");
  } else if (b.baseUrl === "" || b.baseUrl === null) out.baseUrl = "";
  for (const f of ["dailyTokenLimit", "dailyBudgetUsd"] as const) if (b[f] !== undefined && b[f] !== null && b[f] !== "") out[f] = nonNegative(b[f], f);
  if (b.teams !== undefined) {
    const raw = Array.isArray(b.teams) ? b.teams : typeof b.teams === "string" ? b.teams.split(",") : null;
    if (!raw || raw.some((x) => typeof x !== "string")) throw new BadRequest("teams must be a list of team names");
    out.teams = [...new Set((raw as string[]).map((x) => x.trim()).filter(Boolean))];
  }
  for (const f of ["tpmLimit", "rpmLimit"] as const) if (b[f] !== undefined && b[f] !== null && b[f] !== "") out[f] = nonNegative(b[f], f);
  if (b.priority !== undefined && b.priority !== null && b.priority !== "") {
    const n = Number(b.priority);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new BadRequest("priority must be an integer 0-100000");
    out.priority = n;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new BadRequest("enabled must be a boolean");
    out.enabled = b.enabled;
  }
  return out;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = [path.join(here, "..", "ui"), path.join(here, "..", "..", "ui")].find((p) => existsSync(path.join(p, "index.html"))) ?? path.join(here, "..", "ui");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

const MAX_ADMIN_BODY = 1024 * 1024;

class BadRequest extends Error {}

/** Developer-level model allowlist: array of non-empty strings, deduplicated; [] clears. */
function modelList(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new BadRequest(`${name} must be an array of model ids`);
  return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))];
}

/** Per-developer API override: "mantle" | "runtime" | null (follow policy). */
function modeOverride(v: unknown): "mantle" | "runtime" | null {
  if (v === undefined || v === null || v === "") return null;
  if (v === "mantle" || v === "runtime") return v;
  throw new BadRequest("upstreamMode must be mantle, runtime or empty");
}

async function audit(d: AdminDeps, action: string, target: string | undefined, details?: Record<string, unknown>): Promise<void> {
  try {
    await d.store.audit.record({ ts: new Date().toISOString(), action, target, details: d.actor ? { ...(details ?? {}), actor: d.actor } : details });
  } catch {
    /* audit must never fail the request */
  }
}

/** Coerce a user-supplied limit; 0 means "no cap". */
function nonNegative(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(`${name} must be a number >= 0`);
  return n;
}

async function body(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_ADMIN_BODY) throw new BadRequest("request body too large");
    chunks.push(c as Buffer);
  }
  const t = Buffer.concat(chunks).toString("utf8");
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new BadRequest("request body is not valid JSON");
  }
}

function tokenAuthed(req: http.IncomingMessage, token: string): boolean {
  if (!token) return false;
  const h = req.headers["authorization"];
  const m = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h) : null;
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Admin token (Authorization: Bearer) or SSO session cookie. Cookie-authenticated writes must carry
 * `X-Requested-With: tokener`: a cross-site form or image cannot set that header, so CSRF is blocked
 * without tokens or CORS.
 */
function whoIs(req: http.IncomingMessage, d: AdminDeps): { actor: string; via: "token" | "sso"; email?: string } | { error: string } | null {
  if (tokenAuthed(req, d.adminToken)) return { actor: "admin-token", via: "token" };
  const s = d.oidc?.session(req.headers.cookie);
  if (!s) return null;
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-requested-with"] !== "tokener") return { error: "missing X-Requested-With header" };
  return { actor: s.email, via: "sso", email: s.email };
}

const sendHtml = (res: http.ServerResponse, status: number, html: string, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(html);
};

/** Static files of the developer self-service page (/me). */
export function serveMePage(res: http.ServerResponse, pathname: string): void {
  if (pathname === "/me") {
    res.writeHead(302, { location: "/me/" });
    res.end();
    return;
  }
  const rel = pathname === "/me/" ? "index.html" : pathname.slice("/me/".length);
  const dir = path.join(UI_DIR, "me");
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(dir + path.sep) || !existsSync(file)) {
    json(res, 404, { error: "not found" });
    return;
  }
  const data = readFileSync(file);
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", "content-length": data.length });
  res.end(data);
}

/** Returns true if the request was handled. */
export async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, query: URLSearchParams, d: AdminDeps): Promise<boolean> {
  if (!pathname.startsWith("/admin")) return false;

  // ---- single sign-on (OIDC) ----
  if (pathname.startsWith("/admin/sso/")) {
    const origin = requestOrigin(req.headers);
    if (!d.oidc) return json(res, 404, { error: "SSO is not configured" }), true;
    try {
      if (pathname === "/admin/sso/login") {
        const r = await d.oidc.loginRedirect(origin);
        res.writeHead(302, { location: r.location, "set-cookie": r.cookie, "cache-control": "no-store" });
        res.end();
        return true;
      }
      if (pathname === "/admin/sso/callback") {
        const r = await d.oidc.callback(query, req.headers.cookie, origin);
        if (!r.ok) {
          await audit({ ...d, actor: undefined }, "admin.sso.denied", undefined, { error: r.error });
          sendHtml(res, 403, `<!doctype html><meta charset="utf-8"><title>tokener · sign-in failed</title><body style="font-family:system-ui;max-width:560px;margin:80px auto;padding:0 16px"><h1>Sign-in failed</h1><p>${r.error.replace(/[<>&"]/g, "")}</p><p><a href="/admin/">Back to the console</a></p>`);
          return true;
        }
        await audit({ ...d, actor: r.session.email }, "admin.sso.login", r.session.email);
        res.writeHead(302, { location: "/admin/", "set-cookie": r.cookies, "cache-control": "no-store" });
        res.end();
        return true;
      }
      if (pathname === "/admin/sso/logout") {
        res.writeHead(302, { location: "/admin/", "set-cookie": d.oidc.logoutCookie(origin.startsWith("https:")), "cache-control": "no-store" });
        res.end();
        return true;
      }
    } catch (e) {
      return json(res, 502, { error: `SSO error: ${(e as Error).message}` }), true;
    }
    return json(res, 404, { error: "not found" }), true;
  }
  if (pathname === "/admin/api/auth-config") return json(res, 200, { sso: !!d.oidc, ssoLabel: d.oidc?.cfg.label ?? null, tokenLogin: !!d.adminToken }), true;

  // Static UI (no auth: it only contains the login form and client code)
  if (!pathname.startsWith("/admin/api")) {
    const rel = pathname === "/admin" || pathname === "/admin/" ? "index.html" : pathname.slice("/admin/".length);
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR + path.sep) || !existsSync(file)) {
      json(res, 404, { error: "not found" });
      return true;
    }
    const data = readFileSync(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", "content-length": data.length });
    res.end(data);
    return true;
  }

  const who = whoIs(req, d);
  if (!who) {
    json(res, 401, { error: "admin token or SSO session required" });
    return true;
  }
  if ("error" in who) {
    json(res, 403, { error: who.error });
    return true;
  }
  d = { ...d, actor: who.actor };

  const route = `${req.method} ${pathname.slice("/admin/api".length)}`;
  try {
    switch (true) {
      case route === "GET /me":
        return json(res, 200, { ok: true, via: who.via, email: who.email ?? null }), true;

      case route === "GET /alerts":
        return json(res, 200, { webhookConfigured: !!d.getPolicy().alertWebhookUrl, history: d.alerter.history() }), true;

      case route === "POST /alerts/test": {
        const r = await d.alerter.deliver({ kind: "test", severity: "info", title: "Test alert from the admin console", detail: "If you can read this, tokener alerts reach this channel.", fields: { by: who.actor } });
        return json(res, r.delivered ? 200 : 400, r), true;
      }

      case route === "GET /config":
        return (
          json(res, 200, {
            upstreamMode: d.getPolicy().upstreamMode,
            upstreamBaseUrl: d.cfg.upstreamBaseUrl,
            runtimeEndpoint: d.runtimeEndpoint,
            region: d.cfg.awsRegion,
            store: d.store.kind,
            port: d.cfg.port,
            startedAt: new Date(d.startedAt).toISOString(),
            uptimeSec: Math.round((Date.now() - d.startedAt) / 1000),
            defaultModelMap: DEFAULT_MODEL_MAP,
            version: d.version,
            node: process.version,
            authMode: d.authMode,
            keyEncryption: d.pool.encryption,
            sso: d.oidc ? { issuer: d.oidc.cfg.issuer, label: d.oidc.cfg.label, domains: d.oidc.cfg.allowedDomains, emails: d.oidc.cfg.allowedEmails.length } : null,
            marketplace: d.marketplace(),
            catalog: (() => {
              const c = d.catalog.peek();
              return { enabled: !c.disabled, models: c.models.length, fetchedAt: c.fetchedAt, error: c.error };
            })(),
          }),
          true
        );

      case route === "GET /overview": {
        const day = query.get("day") ?? new Date().toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { error: "day must be YYYY-MM-DD" }), true;
        return json(res, 200, await d.store.usage.overview(day)), true;
      }

      case route === "GET /requests": {
        const parsed = Number.parseInt(query.get("limit") ?? "200", 10);
        const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 1000)) : 200;
        const opt = (k: string) => query.get(k)?.trim() || undefined;
        return json(res, 200, await d.store.usage.recentRequests({ limit, developerId: opt("developer"), sessionId: opt("session"), requestClass: opt("class"), model: opt("model"), errorsOnly: query.get("errors") === "1" })), true;
      }

      case route === "GET /trend": {
        const days = Math.max(1, Math.min(Number.parseInt(query.get("days") ?? "14", 10) || 14, 90));
        return json(res, 200, { days, points: await d.store.usage.trend(days) }), true;
      }

      case route === "GET /audit": {
        const limit = Math.max(1, Math.min(Number.parseInt(query.get("limit") ?? "100", 10) || 100, 1000));
        return json(res, 200, await d.store.audit.list(limit)), true;
      }

      case route === "POST /diagnostics":
        return json(res, 200, await d.diagnose()), true;

      case route === "POST /policy/preview": {
        const v = validatePolicy(await body(req));
        if (!v.ok) return json(res, 400, { error: "invalid policy", details: v.errors }), true;
        return json(res, 200, d.previewPolicy(v.policy)), true;
      }

      case route === "GET /pricing":
        return json(res, 200, { effective: pricingTable(), overrides: d.getPolicy().pricing }), true;

      case route === "PUT /pricing": {
        // Merge: { "<model>": ModelPrice } sets, { "<model>": null } removes the override.
        const b = (await body(req)) as Record<string, unknown>;
        if (!b || typeof b !== "object" || Array.isArray(b)) throw new BadRequest("body must be an object of model -> price | null");
        const next = { ...d.getPolicy().pricing };
        const errors: string[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (v === null) delete next[priceKey(k)];
          else Object.assign(next, validatePricing({ [k]: v }, errors));
        }
        if (errors.length) return json(res, 400, { error: "invalid pricing", details: errors }), true;
        await d.setPolicy({ ...d.getPolicy(), pricing: next, updatedAt: new Date().toISOString() });
        await audit(d, "pricing.update", undefined, { models: Object.keys(b) });
        return json(res, 200, { effective: pricingTable(), overrides: next }), true;
      }

      case route === "GET /developers": {
        const list = await d.store.keys.list();
        const [today, month] = await Promise.all([Promise.all(list.map((x) => d.store.usage.todayTotals(x.developerId))), Promise.all(list.map((x) => d.store.usage.monthTotals(x.developerId)))]);
        return (
          json(
            res,
            200,
            list.map((x, i) => ({ ...x, keyHash: x.keyHash.slice(0, 12), todayCostUsd: today[i].costUsd, todayRequests: today[i].requests, todayTokens: totalTokens(today[i]), monthCostUsd: month[i].costUsd, monthTokens: totalTokens(month[i]) })),
          ),
          true
        );
      }

      case route === "POST /developers": {
        const b = (await body(req)) as { developerId?: string; team?: string; dailyBudgetUsd?: number; dailyTokenLimit?: number; monthlyBudgetUsd?: number; monthlyTokenLimit?: number; allowedModels?: unknown; upstreamMode?: unknown };
        const id = (b.developerId ?? "").trim();
        if (!/^[a-zA-Z0-9._@-]{2,64}$/.test(id)) return json(res, 400, { error: "developerId: 2-64 chars, letters/digits/._@-" }), true;
        const budget = b.dailyBudgetUsd === undefined ? d.getPolicy().defaultDailyBudgetUsd : nonNegative(b.dailyBudgetUsd, "dailyBudgetUsd");
        const tokens = b.dailyTokenLimit === undefined ? d.getPolicy().defaultDailyTokenLimit : nonNegative(b.dailyTokenLimit, "dailyTokenLimit");
        const token = generateToken();
        await d.store.keys.create({
          developerId: id,
          keyHash: hashToken(token),
          enabled: true,
          team: (b.team ?? "").trim() || undefined,
          dailyBudgetUsd: budget,
          dailyTokenLimit: tokens,
          monthlyBudgetUsd: b.monthlyBudgetUsd === undefined ? undefined : nonNegative(b.monthlyBudgetUsd, "monthlyBudgetUsd"),
          monthlyTokenLimit: b.monthlyTokenLimit === undefined ? undefined : nonNegative(b.monthlyTokenLimit, "monthlyTokenLimit"),
          allowedModels: modelList(b.allowedModels, "allowedModels"),
          upstreamMode: modeOverride(b.upstreamMode) ?? undefined,
          createdAt: new Date().toISOString(),
        });
        await audit(d, "developer.create", id, { team: b.team, dailyBudgetUsd: budget, dailyTokenLimit: tokens, upstreamMode: modeOverride(b.upstreamMode), allowedModels: modelList(b.allowedModels, "allowedModels") });
        return json(res, 201, { developerId: id, token }), true;
      }

      case /^POST \/developers\/[^/]+\/rotate$/.test(route): {
        // New token with the developer's current settings; every older token is revoked at once.
        const id = decodeURIComponent(pathname.slice("/admin/api".length).split("/")[2]);
        const current = (await d.store.keys.list()).filter((x) => x.developerId === id).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
        if (!current) return json(res, 404, { error: `no developer ${id}` }), true;
        const token = generateToken();
        const keyHash = hashToken(token);
        await d.store.keys.create({ ...current, keyHash, enabled: true, revokedAt: undefined, createdAt: new Date().toISOString() });
        const revoked = await d.store.keys.disableOthers(id, keyHash);
        d.auth.invalidate();
        await audit(d, "developer.rotate", id, { revoked });
        return json(res, 200, { developerId: id, token, revoked }), true;
      }

      case /^POST \/developers\/[^/]+\/(revoke|enable)$/.test(route): {
        const [, , id, action] = pathname.slice("/admin/api".length).split("/");
        const n = await d.store.keys.setEnabled(decodeURIComponent(id), action === "enable");
        d.auth.invalidate();
        await audit(d, action === "enable" ? "developer.enable" : "developer.revoke", decodeURIComponent(id), { keys: n });
        return json(res, 200, { updated: n }), true;
      }

      case /^PATCH \/developers\/[^/]+$/.test(route): {
        const id = decodeURIComponent(pathname.split("/").pop()!);
        const b = (await body(req)) as { dailyBudgetUsd?: number; dailyTokenLimit?: number; monthlyBudgetUsd?: number; monthlyTokenLimit?: number; team?: string; allowedModels?: unknown; upstreamMode?: unknown };
        const n = await d.store.keys.update(id, {
          dailyBudgetUsd: b.dailyBudgetUsd === undefined ? undefined : nonNegative(b.dailyBudgetUsd, "dailyBudgetUsd"),
          dailyTokenLimit: b.dailyTokenLimit === undefined ? undefined : nonNegative(b.dailyTokenLimit, "dailyTokenLimit"),
          monthlyBudgetUsd: b.monthlyBudgetUsd === undefined ? undefined : nonNegative(b.monthlyBudgetUsd, "monthlyBudgetUsd"),
          monthlyTokenLimit: b.monthlyTokenLimit === undefined ? undefined : nonNegative(b.monthlyTokenLimit, "monthlyTokenLimit"),
          team: typeof b.team === "string" ? b.team.trim() : undefined,
          allowedModels: "allowedModels" in b ? modelList(b.allowedModels, "allowedModels") : undefined,
          upstreamMode: "upstreamMode" in b ? modeOverride(b.upstreamMode) : undefined,
        });
        d.auth.invalidate();
        await audit(d, "developer.update", id, b as Record<string, unknown>);
        return json(res, 200, { updated: n }), true;
      }

      case route === "GET /models": {
        const snap = await d.catalog.get(query.get("refresh") === "1");
        return json(res, 200, { ...snap, models: annotateCatalog(snap.models, d.getPolicy().modelMap).map((m) => ({ ...m, priceKey: priceKey(m.id), price: priceFor(m.id) ?? null, priceOverridden: priceKey(m.id) in d.getPolicy().pricing })) }), true;
      }

      case route === "GET /keys":
        return json(res, 200, d.pool.view()), true;

      case route === "PUT /keys/settings": {
        const v = validateSettings((await body(req)) as Record<string, unknown>);
        if (!v.ok) return json(res, 400, { error: v.error }), true;
        d.pool.setSettings(v.value);
        await d.savePool();
        await audit(d, "keys.settings", undefined, v.value as Record<string, unknown>);
        return json(res, 200, d.pool.view()), true;
      }

      case route === "POST /keys": {
        if (!d.pool.canStoreSecrets) return json(res, 400, { error: "Set KEY_POOL_SECRET (or ADMIN_TOKEN) so keys can be encrypted at rest." }), true;
        const inp = keyInput((await body(req)) as Record<string, unknown>, false) as Parameters<KeyPool["addKey"]>[0];
        const dup = d.pool.allKeys().find((k) => k.fingerprint === fingerprint(inp.secret));
        if (dup) return json(res, 409, { error: `this key is already in the pool as "${dup.label}"` }), true;
        const k = d.pool.addKey(inp);
        await d.savePool();
        await audit(d, "key.create", k.id, { label: k.label, kind: k.kind, last4: k.last4, region: k.region, api: k.api });
        const test = query.get("test") === "0" ? null : await d.testKey(k.id);
        return json(res, 201, { key: d.pool.view().keys.find((x) => x.id === k.id), test }), true;
      }

      case /^POST \/keys\/[^/]+\/(test|reset)$/.test(route): {
        const [, , id, action] = pathname.slice("/admin/api".length).split("/");
        if (action === "reset") {
          d.pool.resetCooldown(decodeURIComponent(id));
          await audit(d, "key.reset", decodeURIComponent(id));
          return json(res, 200, d.pool.view()), true;
        }
        return json(res, 200, await d.testKey(decodeURIComponent(id))), true;
      }

      case /^PATCH \/keys\/[^/]+$/.test(route): {
        const id = decodeURIComponent(pathname.split("/").pop()!);
        const k = d.pool.updateKey(id, keyInput((await body(req)) as Record<string, unknown>, true) as Parameters<KeyPool["updateKey"]>[1]);
        if (!k) return json(res, 404, { error: `no stored key ${id} (keys from PROVIDER_KEYS_JSON are read-only)` }), true;
        await d.savePool();
        await audit(d, "key.update", id, { label: k.label, enabled: k.enabled, priority: k.priority, teams: k.teams, tpmLimit: k.tpmLimit, rpmLimit: k.rpmLimit });
        return json(res, 200, { key: d.pool.view().keys.find((x) => x.id === id) }), true;
      }

      case /^DELETE \/keys\/[^/]+$/.test(route): {
        const id = decodeURIComponent(pathname.split("/").pop()!);
        if (!d.pool.removeKey(id)) return json(res, 404, { error: `no stored key ${id}` }), true;
        await d.savePool();
        await audit(d, "key.delete", id);
        return json(res, 200, { deleted: id }), true;
      }

      case route === "GET /policy":
        return json(res, 200, d.getPolicy()), true;

      case route === "PUT /policy": {
        const v = validatePolicy(await body(req));
        if (!v.ok) return json(res, 400, { error: "invalid policy", details: v.errors }), true;
        const before = d.getPolicy();
        await d.setPolicy(v.policy);
        const changed = Object.keys(v.policy).filter((k) => k !== "updatedAt" && JSON.stringify((before as unknown as Record<string, unknown>)[k]) !== JSON.stringify((v.policy as unknown as Record<string, unknown>)[k]));
        await audit(d, "policy.update", undefined, { changed });
        return json(res, 200, v.policy), true;
      }

      default:
        return json(res, 404, { error: `no admin route ${route}` }), true;
    }
  } catch (e) {
    json(res, e instanceof BadRequest ? 400 : 500, { error: String((e as Error).message ?? e) });
    return true;
  }
}
