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
    await d.store.audit.record({ ts: new Date().toISOString(), action, target, details });
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

function authed(req: http.IncomingMessage, token: string): boolean {
  const h = req.headers["authorization"];
  const m = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h) : null;
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns true if the request was handled. */
export async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, query: URLSearchParams, d: AdminDeps): Promise<boolean> {
  if (!pathname.startsWith("/admin")) return false;

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

  if (!authed(req, d.adminToken)) {
    json(res, 401, { error: "admin token required" });
    return true;
  }

  const route = `${req.method} ${pathname.slice("/admin/api".length)}`;
  try {
    switch (true) {
      case route === "GET /me":
        return json(res, 200, { ok: true }), true;

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
        const today = await Promise.all(list.map((x) => d.store.usage.todayTotals(x.developerId)));
        return (
          json(
            res,
            200,
            list.map((x, i) => ({ ...x, keyHash: x.keyHash.slice(0, 12), todayCostUsd: today[i].costUsd, todayRequests: today[i].requests, todayTokens: totalTokens(today[i]) })),
          ),
          true
        );
      }

      case route === "POST /developers": {
        const b = (await body(req)) as { developerId?: string; team?: string; dailyBudgetUsd?: number; dailyTokenLimit?: number; allowedModels?: unknown; upstreamMode?: unknown };
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
        const b = (await body(req)) as { dailyBudgetUsd?: number; dailyTokenLimit?: number; team?: string; allowedModels?: unknown; upstreamMode?: unknown };
        const n = await d.store.keys.update(id, {
          dailyBudgetUsd: b.dailyBudgetUsd === undefined ? undefined : nonNegative(b.dailyBudgetUsd, "dailyBudgetUsd"),
          dailyTokenLimit: b.dailyTokenLimit === undefined ? undefined : nonNegative(b.dailyTokenLimit, "dailyTokenLimit"),
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
