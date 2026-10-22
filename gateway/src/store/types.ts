import type { Usage } from "../pricing.js";
import type { Policy } from "../policy-state.js";

export interface DeveloperRecord {
  developerId: string;
  keyHash: string;
  enabled: boolean;
  team?: string;
  /** Estimated USD per UTC day. 0 / undefined = no cap. */
  dailyBudgetUsd?: number;
  /** Total tokens (input + cache read + cache write + output) per UTC day. 0 / undefined = no cap. */
  dailyTokenLimit?: number;
  /** Bedrock/alias ids this developer may request. Empty / undefined = every model. Operator routing is exempt. */
  allowedModels?: string[];
  /** Per-developer API override; undefined = follow the policy's upstreamMode. */
  upstreamMode?: "mantle" | "runtime";
  createdAt?: string;
  revokedAt?: string;
}

export interface DeveloperPatch {
  dailyBudgetUsd?: number;
  dailyTokenLimit?: number;
  team?: string;
  /** Empty array clears the restriction. */
  allowedModels?: string[];
  /** null clears the override. */
  upstreamMode?: "mantle" | "runtime" | null;
}

export interface KeyStore {
  lookupByHash(keyHash: string): Promise<DeveloperRecord | null>;
  list(): Promise<DeveloperRecord[]>;
  create(rec: DeveloperRecord): Promise<void>;
  setEnabled(developerId: string, enabled: boolean): Promise<number>;
  update(developerId: string, patch: DeveloperPatch): Promise<number>;
  /** Disable every key of the developer except `keepHash` (token rotation). Returns the number disabled. */
  disableOthers(developerId: string, keepHash: string): Promise<number>;
}

export interface RequestRecord {
  ts: string; // ISO
  developerId: string;
  team?: string;
  model: string;
  requestedModel: string;
  requestClass: string;
  sessionId?: string;
  status: number;
  latencyMs: number;
  usage: Usage;
  costUsd: number;
  /** Estimated cost avoided by serving a cheaper model than requested (routing / downgrade). 0 when unchanged. */
  savedUsd?: number;
  stream: boolean;
  notes: string[];
  errorType?: string;
}

export interface DailyTotals {
  requests: number;
  costUsd: number;
  savedUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface BreakdownRow extends DailyTotals {
  key: string;
  cacheHitPct: number;
}

export interface Overview {
  day: string;
  totals: DailyTotals & { cacheHitPct: number; developers: number };
  byDeveloper: BreakdownRow[];
  byModel: BreakdownRow[];
  byClass: BreakdownRow[];
  byHour: { hour: number; costUsd: number; requests: number }[];
  topSessions: { sessionId: string; developerId: string; costUsd: number; requests: number; outputTokens: number }[];
  source: "sqlite" | "dynamo+memory";
}

export interface UsageStore {
  record(rec: RequestRecord): Promise<void>;
  todayTotals(developerId: string): Promise<DailyTotals>;
  overview(day: string): Promise<Overview>;
  recentRequests(opts: RequestFilter): Promise<RequestRecord[]>;
  /** Daily totals for the last `days` UTC days (oldest first, missing days filled with zeros). */
  trend(days: number): Promise<TrendPoint[]>;
}

export interface RequestFilter {
  limit: number;
  developerId?: string;
  sessionId?: string;
  requestClass?: string;
  model?: string;
  errorsOnly?: boolean;
}

export interface TrendPoint extends DailyTotals {
  day: string;
  developers: number;
}

export interface AuditEvent {
  ts: string;
  action: string; // developer.create | developer.revoke | developer.enable | developer.update | developer.rotate | policy.update | pricing.update
  target?: string;
  details?: Record<string, unknown>;
}

export interface AuditStore {
  record(e: AuditEvent): Promise<void>;
  list(limit: number): Promise<AuditEvent[]>;
}

export interface PolicyStore {
  load(): Promise<Policy | null>;
  save(p: Policy): Promise<void>;
}

export interface Store {
  kind: "sqlite" | "dynamo";
  keys: KeyStore;
  usage: UsageStore;
  policy: PolicyStore;
  audit: AuditStore;
  close(): Promise<void>;
}

export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export function hitPct(t: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const denom = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return denom ? Math.round((1000 * t.cacheReadTokens) / denom) / 10 : 0;
}

/** Aggregate request records into an Overview (used by the memory-backed dynamo mode). */
export function aggregate(day: string, recs: RequestRecord[], source: Overview["source"]): Overview {
  const mk = (): DailyTotals => ({ requests: 0, costUsd: 0, savedUsd: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  const add = (t: DailyTotals, r: RequestRecord) => {
    t.requests++;
    t.costUsd += r.costUsd;
    t.savedUsd += r.savedUsd ?? 0;
    t.inputTokens += r.usage.inputTokens;
    t.cacheReadTokens += r.usage.cacheReadTokens;
    t.cacheWriteTokens += r.usage.cacheWrite5mTokens + r.usage.cacheWrite1hTokens;
    t.outputTokens += r.usage.outputTokens;
  };
  const group = (keyOf: (r: RequestRecord) => string): BreakdownRow[] => {
    const m = new Map<string, DailyTotals>();
    for (const r of recs) {
      const k = keyOf(r);
      if (!m.has(k)) m.set(k, mk());
      add(m.get(k)!, r);
    }
    return [...m.entries()].map(([key, t]) => ({ key, ...t, cacheHitPct: hitPct(t) })).sort((a, b) => b.costUsd - a.costUsd);
  };
  const totals = mk();
  recs.forEach((r) => add(totals, r));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, costUsd: 0, requests: 0 }));
  for (const r of recs) {
    const h = new Date(r.ts).getUTCHours();
    hours[h].costUsd += r.costUsd;
    hours[h].requests++;
  }
  const sess = new Map<string, Overview["topSessions"][number]>();
  for (const r of recs) {
    const id = r.sessionId ?? "-";
    const s = sess.get(id) ?? { sessionId: id, developerId: r.developerId, costUsd: 0, requests: 0, outputTokens: 0 };
    s.costUsd += r.costUsd;
    s.requests++;
    s.outputTokens += r.usage.outputTokens;
    sess.set(id, s);
  }
  return {
    day,
    totals: { ...totals, cacheHitPct: hitPct(totals), developers: new Set(recs.map((r) => r.developerId)).size },
    byDeveloper: group((r) => r.developerId),
    byModel: group((r) => r.model),
    byClass: group((r) => r.requestClass),
    byHour: hours,
    topSessions: [...sess.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 20),
    source,
  };
}

export const ZERO_TOTALS = (): DailyTotals => ({ requests: 0, costUsd: 0, savedUsd: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

/** The last `days` UTC day keys ending today, oldest first. */
export function lastDays(days: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}
