import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/store/sqlite.js";
import { aggregate, type RequestRecord } from "../src/store/types.js";
import { policyFromConfig, validatePolicy, effectiveConfig } from "../src/policy-state.js";
import { DEFAULT_MODEL_MAP, type Config } from "../src/config.js";

const rec = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  ts: "2026-10-07T10:15:00.000Z",
  developerId: "alice",
  team: "backend",
  model: "anthropic.claude-opus-5-5",
  requestedModel: "claude-opus-5-5",
  requestClass: "main",
  sessionId: "s1",
  status: 200,
  latencyMs: 1200,
  usage: { inputTokens: 1000, outputTokens: 800, cacheReadTokens: 54000, cacheWrite5mTokens: 5000, cacheWrite1hTokens: 0 },
  costUsd: 0.0558,
  stream: true,
  notes: ["route:x"],
  ...over,
});

describe("SqliteStore", () => {
  it("stores developers, requests, policy and aggregates an overview", async () => {
    const s = new SqliteStore(":memory:");
    await s.keys.create({ developerId: "alice", keyHash: "h1", enabled: true, team: "backend", dailyBudgetUsd: 25, createdAt: "2026-10-01T00:00:00Z" });
    await s.keys.create({ developerId: "bob", keyHash: "h2", enabled: true, dailyBudgetUsd: 10 });
    expect((await s.keys.lookupByHash("h1"))?.developerId).toBe("alice");
    expect(await s.keys.lookupByHash("nope")).toBeNull();
    expect((await s.keys.list()).map((d) => d.developerId)).toEqual(["alice", "bob"]);
    expect(await s.keys.setEnabled("bob", false)).toBe(1);
    expect((await s.keys.lookupByHash("h2"))?.enabled).toBe(false);
    expect(await s.keys.update("alice", { dailyBudgetUsd: 40 })).toBe(1);
    expect((await s.keys.lookupByHash("h1"))?.dailyBudgetUsd).toBe(40);
    expect((await s.keys.lookupByHash("h1"))?.dailyTokenLimit).toBeUndefined();
    expect(await s.keys.update("alice", { dailyTokenLimit: 2_000_000 })).toBe(1);
    expect((await s.keys.lookupByHash("h1"))?.dailyTokenLimit).toBe(2_000_000);
    await s.keys.create({ developerId: "cem", keyHash: "h3", enabled: true, dailyTokenLimit: 500_000 });
    expect((await s.keys.lookupByHash("h3"))?.dailyTokenLimit).toBe(500_000);

    const today = new Date().toISOString();
    await s.usage.record(rec({ ts: today }));
    await s.usage.record(rec({ ts: today, requestClass: "subagent", model: "anthropic.claude-sonnet-5-5", costUsd: 0.02, sessionId: "s2" }));
    await s.usage.record(rec({ ts: today, developerId: "bob", costUsd: 0.1, sessionId: "s3" }));
    await s.usage.record(rec({ ts: "2026-01-01T00:00:00.000Z", costUsd: 99 })); // other day, excluded

    const tt = await s.usage.todayTotals("alice");
    expect(tt.requests).toBe(2);
    expect(tt.costUsd).toBeCloseTo(0.0758, 6);

    const o = await s.usage.overview(today.slice(0, 10));
    expect(o.totals.requests).toBe(3);
    expect(o.totals.developers).toBe(2);
    expect(o.byDeveloper[0].key).toBe("bob");
    expect(o.byClass.map((r) => r.key).sort()).toEqual(["main", "subagent"]);
    expect(o.byHour.reduce((a, h) => a + h.requests, 0)).toBe(3);
    expect(o.topSessions[0].sessionId).toBe("s3");
    expect(o.totals.cacheHitPct).toBeCloseTo(90, 0);

    const recent = await s.usage.recentRequests({ limit: 10, developerId: "alice" });
    expect(recent).toHaveLength(3);
    expect(recent[0].notes).toEqual(["route:x"]);

    expect(await s.policy.load()).toBeNull();
    const p = policyFromConfig(baseCfg());
    p.routeSubagentModel = "anthropic.claude-sonnet-5-5";
    await s.policy.save(p);
    expect((await s.policy.load())?.routeSubagentModel).toBe("anthropic.claude-sonnet-5-5");
    await s.close();
  });
});

describe("SqliteStore migration", () => {
  it("adds daily_token_limit to a database created before the column existed", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "gw-")), "legacy.db");
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE developers (key_hash TEXT PRIMARY KEY, developer_id TEXT NOT NULL, team TEXT, daily_budget_usd REAL,
      enabled INTEGER NOT NULL DEFAULT 1, allowed_models TEXT, created_at TEXT NOT NULL, revoked_at TEXT);
      INSERT INTO developers (key_hash, developer_id, daily_budget_usd, created_at) VALUES ('old', 'legacy', 5, '2026-01-01T00:00:00Z');`);
    raw.close();
    const s = new SqliteStore(file);
    const d = await s.keys.lookupByHash("old");
    expect(d?.developerId).toBe("legacy");
    expect(d?.dailyTokenLimit).toBeUndefined();
    expect(await s.keys.update("legacy", { dailyTokenLimit: 1000 })).toBe(1);
    expect((await s.keys.lookupByHash("old"))?.dailyTokenLimit).toBe(1000);
    await s.close();
  });
});

describe("aggregate (memory mode)", () => {
  it("groups by developer/model/class/hour/session", () => {
    const o = aggregate("2026-10-07", [rec(), rec({ developerId: "bob", ts: "2026-10-07T11:00:00.000Z", sessionId: "s9" })], "dynamo+memory");
    expect(o.totals.requests).toBe(2);
    expect(o.byHour[10].requests).toBe(1);
    expect(o.byHour[11].requests).toBe(1);
    expect(o.topSessions).toHaveLength(2);
  });
});

function baseCfg(): Config {
  return {
    port: 0, awsRegion: "us-east-1", upstreamBaseUrl: "https://x", keysTable: "k", usageTable: "u", metricsNamespace: "T", keyCacheTtlMs: 0, maxBodyBytes: 1, upstreamTimeoutMs: 0, upstreamMode: "mantle", bedrockProfilePrefix: "us", bedrockRuntimeEndpoint: "", modelCatalogEnabled: false, modelCatalogTtlMs: 0,
    modelMap: DEFAULT_MODEL_MAP, effortMode: "off", cacheTtl1h: false, cacheTtlBeta: "b", toolResultMaxChars: 0, bridgeBedrock: true, bridgeStripBetas: [], budgetAction: "warn",
  };
}

describe("policy-state", () => {
  it("validates and applies a policy over the base config", () => {
    const p = policyFromConfig(baseCfg());
    const v = validatePolicy({ ...p, effortMode: "fill", defaultEffort: "high", routeSubagentModel: " anthropic.claude-sonnet-5-5 " });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const eff = effectiveConfig(baseCfg(), v.policy);
    expect(eff.effortMode).toBe("fill");
    expect(eff.routeSubagentModel).toBe("anthropic.claude-sonnet-5-5");
    expect(eff.routeAuxiliaryModel).toBeUndefined();
  });
  it("rejects bad values", () => {
    const p = policyFromConfig(baseCfg());
    const v = validatePolicy({ ...p, effortMode: "turbo", defaultEffort: "ultra", toolResultMaxChars: -1, modelMap: [] });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("SqliteStore extras", () => {
  it("filters requests, builds a trend, rotates keys and records audit events", async () => {
    const s = new SqliteStore(":memory:");
    await s.keys.create({ developerId: "alice", keyHash: "old", enabled: true });
    await s.keys.create({ developerId: "alice", keyHash: "new", enabled: true });
    expect(await s.keys.disableOthers("alice", "new")).toBe(1);
    expect((await s.keys.lookupByHash("old"))?.enabled).toBe(false);
    expect((await s.keys.lookupByHash("new"))?.enabled).toBe(true);

    const today = new Date().toISOString();
    await s.usage.record(rec({ ts: today, savedUsd: 0.01 }));
    await s.usage.record(rec({ ts: today, requestClass: "subagent", sessionId: "s2", status: 500, errorType: "upstream_error" }));
    expect((await s.usage.recentRequests({ limit: 10, requestClass: "subagent" })).map((r) => r.sessionId)).toEqual(["s2"]);
    expect((await s.usage.recentRequests({ limit: 10, sessionId: "s1" }))).toHaveLength(1);
    expect((await s.usage.recentRequests({ limit: 10, errorsOnly: true })).map((r) => r.status)).toEqual([500]);
    expect((await s.usage.recentRequests({ limit: 10, model: "claude-opus-5-5" }))).toHaveLength(2); // matches requestedModel

    const trend = await s.usage.trend(3);
    expect(trend).toHaveLength(3);
    expect(trend.at(-1)).toMatchObject({ requests: 2, developers: 1 });
    expect(trend.at(-1)!.savedUsd).toBeCloseTo(0.01, 6);
    expect(trend[0].requests).toBe(0);
    expect((await s.usage.todayTotals("alice")).savedUsd).toBeCloseTo(0.01, 6);

    await s.audit.record({ ts: "2026-10-07T10:00:00.000Z", action: "policy.update", details: { changed: ["effortMode"] } });
    await s.audit.record({ ts: "2026-10-07T10:01:00.000Z", action: "developer.revoke", target: "bob" });
    const au = await s.audit.list(10);
    expect(au.map((e) => e.action)).toEqual(["developer.revoke", "policy.update"]);
    expect(au[1].details).toEqual({ changed: ["effortMode"] });
    await s.close();
  });
});
