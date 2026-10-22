/**
 * Local single-process store on Node's built-in SQLite (node:sqlite, Node >= 22.13).
 * Used for `npm run local` and for small single-task deployments. No extra dependency.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Policy } from "../policy-state.js";
import { hitPct, lastDays, ZERO_TOTALS, type AuditStore, type BreakdownRow, type DailyTotals, type DeveloperRecord, type KeyStore, type Overview, type PolicyStore, type RequestRecord, type Store, type UsageStore } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS developers (
  key_hash TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  team TEXT,
  daily_budget_usd REAL,
  daily_token_limit REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_models TEXT,
  upstream_mode TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS developers_dev ON developers(developer_id);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  team TEXT,
  session_id TEXT,
  request_class TEXT NOT NULL,
  requested_model TEXT,
  model TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_5m_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  saved_usd REAL NOT NULL DEFAULT 0,
  stream INTEGER NOT NULL,
  notes TEXT,
  error_type TEXT
);
CREATE INDEX IF NOT EXISTS requests_day_dev ON requests(day, developer_id);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_session ON requests(session_id);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, action TEXT NOT NULL, target TEXT, details TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

function toDev(r: Row): DeveloperRecord {
  return {
    developerId: r.developer_id as string,
    keyHash: r.key_hash as string,
    enabled: Number(r.enabled) === 1,
    team: (r.team as string | null) ?? undefined,
    dailyBudgetUsd: r.daily_budget_usd === null ? undefined : Number(r.daily_budget_usd),
    dailyTokenLimit: r.daily_token_limit === null || r.daily_token_limit === undefined ? undefined : Number(r.daily_token_limit),
    allowedModels: r.allowed_models ? (JSON.parse(r.allowed_models as string) as string[]) : undefined,
    upstreamMode: r.upstream_mode === "mantle" || r.upstream_mode === "runtime" ? r.upstream_mode : undefined,
    createdAt: (r.created_at as string | null) ?? undefined,
    revokedAt: (r.revoked_at as string | null) ?? undefined,
  };
}

function toReq(r: Row): RequestRecord {
  return {
    ts: r.ts as string,
    developerId: r.developer_id as string,
    team: (r.team as string | null) ?? undefined,
    sessionId: (r.session_id as string | null) ?? undefined,
    requestClass: r.request_class as string,
    requestedModel: (r.requested_model as string | null) ?? "",
    model: r.model as string,
    status: Number(r.status),
    latencyMs: Number(r.latency_ms),
    usage: {
      inputTokens: Number(r.input_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWrite5mTokens: Number(r.cache_write_5m_tokens),
      cacheWrite1hTokens: Number(r.cache_write_1h_tokens),
      outputTokens: Number(r.output_tokens),
    },
    costUsd: Number(r.cost_usd),
    savedUsd: Number(r.saved_usd ?? 0),
    stream: Number(r.stream) === 1,
    notes: r.notes ? (r.notes as string).split(" ").filter(Boolean) : [],
    errorType: (r.error_type as string | null) ?? undefined,
  };
}

const TOTALS_SQL = `COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(SUM(saved_usd),0) AS savedUsd, COALESCE(SUM(input_tokens),0) AS inputTokens,
  COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens, COALESCE(SUM(cache_write_5m_tokens + cache_write_1h_tokens),0) AS cacheWriteTokens,
  COALESCE(SUM(output_tokens),0) AS outputTokens`;

function totals(r: Row): DailyTotals {
  return {
    requests: Number(r.requests),
    costUsd: Number(r.costUsd),
    savedUsd: Number(r.savedUsd ?? 0),
    inputTokens: Number(r.inputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheWriteTokens: Number(r.cacheWriteTokens),
    outputTokens: Number(r.outputTokens),
  };
}

export class SqliteStore implements Store {
  readonly kind = "sqlite" as const;
  private readonly db: DatabaseSync;
  readonly keys: KeyStore;
  readonly usage: UsageStore;
  readonly policy: PolicyStore;
  readonly audit: AuditStore;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    const db = this.db;
    // Migrations for databases created before a column existed.
    const cols = new Set((db.prepare("PRAGMA table_info(developers)").all() as Row[]).map((r) => String(r.name)));
    if (!cols.has("daily_token_limit")) db.exec("ALTER TABLE developers ADD COLUMN daily_token_limit REAL");
    if (!cols.has("upstream_mode")) db.exec("ALTER TABLE developers ADD COLUMN upstream_mode TEXT");
    const rcols = new Set((db.prepare("PRAGMA table_info(requests)").all() as Row[]).map((r) => String(r.name)));
    if (!rcols.has("saved_usd")) db.exec("ALTER TABLE requests ADD COLUMN saved_usd REAL NOT NULL DEFAULT 0");

    this.keys = {
      async lookupByHash(keyHash) {
        const r = db.prepare("SELECT * FROM developers WHERE key_hash = ?").get(keyHash) as Row | undefined;
        return r ? toDev(r) : null;
      },
      async list() {
        return (db.prepare("SELECT * FROM developers ORDER BY developer_id, created_at").all() as Row[]).map(toDev);
      },
      async create(rec) {
        db.prepare(
          "INSERT INTO developers (key_hash, developer_id, team, daily_budget_usd, daily_token_limit, enabled, allowed_models, upstream_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(rec.keyHash, rec.developerId, rec.team ?? null, rec.dailyBudgetUsd ?? null, rec.dailyTokenLimit ?? null, rec.enabled ? 1 : 0, rec.allowedModels?.length ? JSON.stringify(rec.allowedModels) : null, rec.upstreamMode ?? null, rec.createdAt ?? new Date().toISOString());
      },
      async setEnabled(developerId, enabled) {
        const r = db.prepare("UPDATE developers SET enabled = ?, revoked_at = ? WHERE developer_id = ?").run(enabled ? 1 : 0, enabled ? null : new Date().toISOString(), developerId);
        return Number(r.changes);
      },
      async disableOthers(developerId, keepHash) {
        const r = db.prepare("UPDATE developers SET enabled = 0, revoked_at = ? WHERE developer_id = ? AND key_hash <> ? AND enabled = 1").run(new Date().toISOString(), developerId, keepHash);
        return Number(r.changes);
      },
      async update(developerId, patch) {
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (patch.dailyBudgetUsd !== undefined) {
          sets.push("daily_budget_usd = ?");
          vals.push(patch.dailyBudgetUsd);
        }
        if (patch.dailyTokenLimit !== undefined) {
          sets.push("daily_token_limit = ?");
          vals.push(patch.dailyTokenLimit);
        }
        if (patch.team !== undefined) {
          sets.push("team = ?");
          vals.push(patch.team);
        }
        if (patch.allowedModels !== undefined) {
          sets.push("allowed_models = ?");
          vals.push(patch.allowedModels.length ? JSON.stringify(patch.allowedModels) : null);
        }
        if (patch.upstreamMode !== undefined) {
          sets.push("upstream_mode = ?");
          vals.push(patch.upstreamMode);
        }
        if (!sets.length) return 0;
        vals.push(developerId);
        return Number(db.prepare(`UPDATE developers SET ${sets.join(", ")} WHERE developer_id = ?`).run(...(vals as never[])).changes);
      },
    };

    const insert = db.prepare(`INSERT INTO requests (ts, day, developer_id, team, session_id, request_class, requested_model, model, status, latency_ms,
      input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, cost_usd, saved_usd, stream, notes, error_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    this.usage = {
      async record(r) {
        insert.run(r.ts, r.ts.slice(0, 10), r.developerId, r.team ?? null, r.sessionId ?? null, r.requestClass, r.requestedModel, r.model, r.status, r.latencyMs,
          r.usage.inputTokens, r.usage.cacheReadTokens, r.usage.cacheWrite5mTokens, r.usage.cacheWrite1hTokens, r.usage.outputTokens, r.costUsd, r.savedUsd ?? 0, r.stream ? 1 : 0, r.notes.join(" "), r.errorType ?? null);
      },
      async todayTotals(developerId) {
        const day = new Date().toISOString().slice(0, 10);
        return totals(db.prepare(`SELECT ${TOTALS_SQL} FROM requests WHERE day = ? AND developer_id = ?`).get(day, developerId) as Row);
      },
      async overview(day) {
        const group = (col: string): BreakdownRow[] =>
          (db.prepare(`SELECT ${col} AS key, ${TOTALS_SQL} FROM requests WHERE day = ? GROUP BY ${col} ORDER BY costUsd DESC`).all(day) as Row[]).map((r) => {
            const t = totals(r);
            return { key: String(r.key ?? "-"), ...t, cacheHitPct: hitPct(t) };
          });
        const t = totals(db.prepare(`SELECT ${TOTALS_SQL} FROM requests WHERE day = ?`).get(day) as Row);
        const devs = db.prepare("SELECT COUNT(DISTINCT developer_id) AS n FROM requests WHERE day = ?").get(day) as Row;
        const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, costUsd: 0, requests: 0 }));
        for (const r of db.prepare("SELECT CAST(substr(ts, 12, 2) AS INTEGER) AS h, SUM(cost_usd) AS c, COUNT(*) AS n FROM requests WHERE day = ? GROUP BY h").all(day) as Row[]) {
          const h = Number(r.h);
          if (h >= 0 && h < 24) hours[h] = { hour: h, costUsd: Number(r.c), requests: Number(r.n) };
        }
        const sessions = (db.prepare(`SELECT COALESCE(session_id,'-') AS sessionId, developer_id AS developerId, SUM(cost_usd) AS costUsd, COUNT(*) AS requests, SUM(output_tokens) AS outputTokens
          FROM requests WHERE day = ? GROUP BY session_id, developer_id ORDER BY costUsd DESC LIMIT 20`).all(day) as Row[]).map((r) => ({
          sessionId: String(r.sessionId),
          developerId: String(r.developerId),
          costUsd: Number(r.costUsd),
          requests: Number(r.requests),
          outputTokens: Number(r.outputTokens),
        }));
        return {
          day,
          totals: { ...t, cacheHitPct: hitPct(t), developers: Number(devs.n) },
          byDeveloper: group("developer_id"),
          byModel: group("model"),
          byClass: group("request_class"),
          byHour: hours,
          topSessions: sessions,
          source: "sqlite",
        } satisfies Overview;
      },
      async recentRequests(f) {
        const lim = Math.max(1, Math.min(f.limit, 1000));
        const where: string[] = [];
        const vals: unknown[] = [];
        if (f.developerId) (where.push("developer_id = ?"), vals.push(f.developerId));
        if (f.sessionId) (where.push("session_id = ?"), vals.push(f.sessionId));
        if (f.requestClass) (where.push("request_class = ?"), vals.push(f.requestClass));
        if (f.model) (where.push("(model = ? OR requested_model = ?)"), vals.push(f.model, f.model));
        if (f.errorsOnly) where.push("(status >= 400 OR error_type IS NOT NULL)");
        vals.push(lim);
        const rows = db.prepare(`SELECT * FROM requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...(vals as never[])) as Row[];
        return rows.map(toReq);
      },
      async trend(days) {
        const keys = lastDays(days);
        const rows = db.prepare(`SELECT day, ${TOTALS_SQL}, COUNT(DISTINCT developer_id) AS developers FROM requests WHERE day >= ? GROUP BY day`).all(keys[0]) as Row[];
        const byDay = new Map(rows.map((r) => [String(r.day), r]));
        return keys.map((day) => {
          const r = byDay.get(day);
          return r ? { day, ...totals(r), developers: Number(r.developers) } : { day, ...ZERO_TOTALS(), developers: 0 };
        });
      },
    };

    this.audit = {
      async record(e) {
        db.prepare("INSERT INTO audit (ts, action, target, details) VALUES (?,?,?,?)").run(e.ts, e.action, e.target ?? null, e.details ? JSON.stringify(e.details) : null);
      },
      async list(limit) {
        return (db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(limit, 1000))) as Row[]).map((r) => ({
          ts: r.ts as string,
          action: r.action as string,
          target: (r.target as string | null) ?? undefined,
          details: r.details ? (JSON.parse(r.details as string) as Record<string, unknown>) : undefined,
        }));
      },
    };

    this.policy = {
      async load() {
        const r = db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as Row | undefined;
        return r ? (JSON.parse(r.value as string) as Policy) : null;
      },
      async save(p) {
        db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify(p), new Date().toISOString());
      },
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
