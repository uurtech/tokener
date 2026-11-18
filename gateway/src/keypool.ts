/**
 * Upstream key pool: several Anthropic API keys and/or Bedrock API keys behind the single
 * gateway endpoint. Developers keep one URL and one personal token; the gateway decides which
 * upstream key serves each request and moves to the next one before (or the moment) a key runs
 * out of rate limit, credit or daily cap.
 *
 * - Selection: `session` (default) spreads new Claude Code sessions round-robin and keeps each
 *   session on its key, so the prompt cache stays warm; `round-robin` rotates every request;
 *   `fill-first` drains keys in priority order; `least-used` picks the key with the fewest tokens today.
 * - Failover: a 429 / 529 / 5xx / 401 / 403 / credit-exhausted answer (or a network error) puts the
 *   key on cooldown and the same request is retried on the next key. Nothing has been streamed to
 *   the client at that point, so the retry is invisible to the developer.
 * - Proactive switch: Anthropic sends `anthropic-ratelimit-*-remaining` headers. When a key drops
 *   under `softLimitPct` of any limit it is parked until the reset time; new work goes elsewhere
 *   and the key is only used if nothing healthier is left.
 * - Secrets are AES-256-GCM encrypted at rest with KEY_POOL_SECRET (or ADMIN_TOKEN) and are never
 *   returned by the admin API; only the last four characters are shown.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type ProviderKind = "anthropic" | "bedrock";
export type PoolStrategy = "session" | "round-robin" | "fill-first" | "least-used";
export const POOL_STRATEGIES: readonly PoolStrategy[] = ["session", "round-robin", "fill-first", "least-used"];
export const ENV_KEY_ID = "env";

export interface StoredKey {
  id: string;
  label: string;
  kind: ProviderKind;
  /** v1:<iv>:<tag>:<ciphertext>, base64url. Plaintext only for keys loaded from PROVIDER_KEYS_JSON (source = env). */
  secretEnc: string;
  last4: string;
  /** sha256(secret), first 16 hex chars: duplicate detection without decrypting. */
  fingerprint?: string;
  enabled: boolean;
  /** Lower = preferred (fill-first order, tie-break elsewhere). */
  priority: number;
  /** Bedrock only: region of the key's account. Empty = gateway region. */
  region?: string;
  /** Bedrock only: Mantle or Runtime. Empty = follow the policy / developer setting. */
  api?: "mantle" | "runtime";
  /** Anthropic only: override for https://api.anthropic.com. */
  baseUrl?: string;
  /** Optional self-imposed caps per UTC day. 0 / undefined = none. */
  dailyTokenLimit?: number;
  dailyBudgetUsd?: number;
  createdAt: string;
  source?: "store" | "env";
}

export interface PoolSettings {
  strategy: PoolStrategy;
  /** Use the gateway's own AWS credentials (task role / AWS_BEARER_TOKEN_BEDROCK) when every pool key is unavailable. */
  envFallback: boolean;
  /** Park an Anthropic key when any rate-limit bucket falls below this % remaining. 0 disables. */
  softLimitPct: number;
  /** Upper bound on upstream attempts per request (first try + failovers). */
  maxAttempts: number;
}

export interface PoolDoc {
  settings: PoolSettings;
  keys: StoredKey[];
  updatedAt?: string;
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = { strategy: "session", envFallback: true, softLimitPct: 5, maxAttempts: 4 };

export interface RateSnapshot {
  /** Lowest remaining fraction across buckets, 0..1. */
  minRemainingPct: number;
  bucket: string;
  resetAt?: number;
  at: number;
}

interface KeyState {
  cooldownUntil: number;
  /** soft = parked by the proactive rate-limit check; still usable as a last resort. */
  soft: boolean;
  reason?: string;
  lastStatus?: number;
  lastError?: string;
  lastUsedAt?: number;
  lastOkAt?: number;
  failures: number;
  day: string;
  requests: number;
  tokens: number;
  costUsd: number;
  failovers: number;
  rate?: RateSnapshot;
}

/** What the dispatcher needs to call one key. `secret` is undefined for the env credential. */
export interface Selected {
  id: string;
  label: string;
  kind: ProviderKind;
  secret?: string;
  region?: string;
  api?: "mantle" | "runtime";
  baseUrl?: string;
  /** Changes whenever the key's settings change; lets callers cache clients per key. */
  version: string;
}

export interface FailureVerdict {
  retry: boolean;
  cooldownMs: number;
  reason: string;
}

export interface KeyView {
  id: string;
  label: string;
  kind: ProviderKind;
  last4: string;
  enabled: boolean;
  priority: number;
  region?: string;
  api?: "mantle" | "runtime";
  baseUrl?: string;
  dailyTokenLimit?: number;
  dailyBudgetUsd?: number;
  createdAt: string;
  source: "store" | "env";
  status: "active" | "cooling" | "parked" | "capped" | "disabled" | "error";
  reason?: string;
  cooldownSec: number;
  lastStatus?: number;
  lastError?: string;
  lastUsedAt?: string;
  lastOkAt?: string;
  today: { requests: number; tokens: number; costUsd: number; failovers: number };
  rate?: { minRemainingPct: number; bucket: string; resetAt?: string; at: string };
  activeSessions: number;
}

const today = () => new Date().toISOString().slice(0, 10);
export const fingerprint = (secret: string) => createHash("sha256").update(secret).digest("hex").slice(0, 16);

/* ------------------------------ secrets ------------------------------ */

export class SecretBox {
  private readonly key: Buffer | null;
  constructor(secret: string | undefined) {
    this.key = secret ? createHash("sha256").update(`tokener-keypool:${secret}`).digest() : null;
  }
  get available(): boolean {
    return this.key !== null;
  }
  seal(plain: string): string {
    if (!this.key) throw new Error("KEY_POOL_SECRET (or ADMIN_TOKEN) must be set to store upstream keys");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
  }
  open(sealed: string): string {
    if (!this.key) throw new Error("no KEY_POOL_SECRET");
    const [v, iv, tag, ct] = sealed.split(":");
    if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("unrecognised secret format");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }
}

/* ------------------------------ helpers ------------------------------ */

/**
 * Bedrock / alias id -> Anthropic API id. "us.anthropic.claude-haiku-4-5-20251001-v1:0" -> "claude-haiku-4-5-20251001",
 * "anthropic.claude-opus-5-5" -> "claude-opus-5-5". Non-Claude ids are returned unchanged.
 */
export function toAnthropicModelId(model: string): string {
  return model
    .replace(/\[1m\]$/i, "")
    .replace(/^([a-z-]+\.)?anthropic\./, "")
    .replace(/-v\d+(:\d+)?$/, "");
}

function headerNum(h: Headers, name: string): number | undefined {
  const v = h.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Lowest remaining fraction across Anthropic's rate-limit buckets, from response headers. */
export function rateFromHeaders(h: Headers, now = Date.now()): RateSnapshot | undefined {
  let best: RateSnapshot | undefined;
  for (const bucket of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    const limit = headerNum(h, `anthropic-ratelimit-${bucket}-limit`);
    const remaining = headerNum(h, `anthropic-ratelimit-${bucket}-remaining`);
    if (!limit || remaining === undefined) continue;
    const pct = Math.max(0, Math.min(1, remaining / limit));
    if (!best || pct < best.minRemainingPct) {
      const reset = h.get(`anthropic-ratelimit-${bucket}-reset`);
      const resetAt = reset ? Date.parse(reset) : NaN;
      best = { minRemainingPct: pct, bucket, resetAt: Number.isFinite(resetAt) ? resetAt : undefined, at: now };
    }
  }
  return best;
}

/** How long a 429 says to wait: retry-after (seconds or HTTP date), else the earliest ratelimit reset, else 30 s. */
export function retryAfterMs(h: Headers, now = Date.now()): number {
  const ra = h.get("retry-after");
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.max(1000, s * 1000);
    const t = Date.parse(ra);
    if (Number.isFinite(t)) return Math.max(1000, t - now);
  }
  const resets: number[] = [];
  h.forEach((v, k) => {
    if (/^anthropic-ratelimit-.*-reset$/.test(k)) {
      const t = Date.parse(v);
      if (Number.isFinite(t) && t > now) resets.push(t - now);
    }
  });
  return resets.length ? Math.max(1000, Math.min(...resets)) : 30_000;
}

/**
 * Decide whether an upstream error is the key's fault (try another key) or the request's
 * fault (forward to the client as-is). Error bodies are matched loosely on wording because
 * Anthropic and Bedrock report credit / spend-limit exhaustion as 400s.
 */
export function classifyFailure(status: number, body: string, headers: Headers, now = Date.now()): FailureVerdict {
  if (status === 429) return { retry: true, cooldownMs: retryAfterMs(headers, now), reason: "rate_limited" };
  if (status === 529 || status === 503) return { retry: true, cooldownMs: 15_000, reason: "overloaded" };
  if (status === 401) return { retry: true, cooldownMs: 10 * 60_000, reason: "auth_failed" };
  if (status === 403) return { retry: true, cooldownMs: 60_000, reason: "forbidden" };
  if (status === 402 || (status === 400 && /credit balance|usage limit|spend(ing)? limit|billing|quota/i.test(body)))
    return { retry: true, cooldownMs: 60 * 60_000, reason: "credit_exhausted" };
  if (status === 500 || status === 502 || status === 504) return { retry: true, cooldownMs: 5_000, reason: "upstream_error" };
  return { retry: false, cooldownMs: 0, reason: "client_error" };
}

/* ------------------------------ the pool ------------------------------ */

export class KeyPool {
  private doc: PoolDoc = { settings: { ...DEFAULT_POOL_SETTINGS }, keys: [] };
  private envKeys: StoredKey[] = [];
  private readonly state = new Map<string, KeyState>();
  private readonly sticky = new Map<string, { id: string; at: number }>();
  private readonly secrets = new Map<string, { v: string; plain?: string; error?: string }>();
  private rr = 0;

  constructor(
    private readonly box: SecretBox,
    /** Whether the gateway has its own AWS credentials to fall back on. */
    private readonly envCredential: { label: string } | null,
    private readonly now: () => number = Date.now,
  ) {}

  get settings(): PoolSettings {
    return this.doc.settings;
  }
  get canStoreSecrets(): boolean {
    return this.box.available;
  }

  /** Replace the stored document (startup, admin save, periodic reload on multi-task deployments). */
  load(doc: PoolDoc | null): void {
    this.doc = { settings: { ...DEFAULT_POOL_SETTINGS, ...(doc?.settings ?? {}) }, keys: (doc?.keys ?? []).map((k) => ({ ...k, source: "store" as const })), updatedAt: doc?.updatedAt };
  }

  /** Read-only keys from PROVIDER_KEYS_JSON: [{"label":"a","kind":"anthropic","key":"sk-ant-..."}]. */
  loadEnvKeys(json: string | undefined): void {
    if (!json) return;
    const arr = JSON.parse(json) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) throw new Error("PROVIDER_KEYS_JSON must be a JSON array");
    this.envKeys = arr.map((o, i) => {
      const kind = o.kind === "bedrock" ? "bedrock" : "anthropic";
      const key = String(o.key ?? o.secret ?? "");
      if (!key) throw new Error(`PROVIDER_KEYS_JSON[${i}] needs "key"`);
      return {
        id: `env-${i + 1}`,
        label: String(o.label ?? `${kind}-${i + 1}`),
        kind,
        secretEnc: `plain:${key}`,
        last4: key.slice(-4),
        fingerprint: fingerprint(key),
        enabled: o.enabled !== false,
        priority: Number(o.priority ?? 100 + i),
        region: typeof o.region === "string" ? o.region : undefined,
        api: o.api === "mantle" || o.api === "runtime" ? o.api : undefined,
        baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : undefined,
        dailyTokenLimit: Number(o.dailyTokenLimit ?? 0) || undefined,
        dailyBudgetUsd: Number(o.dailyBudgetUsd ?? 0) || undefined,
        createdAt: new Date(0).toISOString(),
        source: "env" as const,
      };
    });
  }

  /** Persistable copy (store keys only; env keys never get written). */
  toDoc(): PoolDoc {
    return { settings: { ...this.doc.settings }, keys: this.doc.keys.map(({ source: _s, ...k }) => k), updatedAt: this.doc.updatedAt };
  }

  allKeys(): StoredKey[] {
    return [...this.doc.keys, ...this.envKeys];
  }

  /** True when at least one upstream key (not counting the env credential) is configured. */
  get configured(): boolean {
    return this.allKeys().length > 0;
  }

  private st(id: string): KeyState {
    let s = this.state.get(id);
    const d = today();
    if (!s) {
      s = { cooldownUntil: 0, soft: false, failures: 0, day: d, requests: 0, tokens: 0, costUsd: 0, failovers: 0 };
      this.state.set(id, s);
    }
    if (s.day !== d) Object.assign(s, { day: d, requests: 0, tokens: 0, costUsd: 0, failovers: 0 });
    return s;
  }

  private secretOf(k: StoredKey): { plain?: string; error?: string } {
    if (k.secretEnc.startsWith("plain:")) return { plain: k.secretEnc.slice(6) };
    const cached = this.secrets.get(k.id);
    if (cached && cached.v === k.secretEnc) return cached;
    let entry: { v: string; plain?: string; error?: string };
    try {
      entry = { v: k.secretEnc, plain: this.box.open(k.secretEnc) };
    } catch (e) {
      entry = { v: k.secretEnc, error: `cannot decrypt (${(e as Error).message}); KEY_POOL_SECRET / ADMIN_TOKEN changed? Re-enter the key.` };
    }
    this.secrets.set(k.id, entry);
    return entry;
  }

  private capped(k: StoredKey, s: KeyState): boolean {
    return (!!k.dailyTokenLimit && s.tokens >= k.dailyTokenLimit) || (!!k.dailyBudgetUsd && s.costUsd >= k.dailyBudgetUsd);
  }

  /** 0 = healthy, 1 = parked near its rate limit, 2 = env fallback, Infinity = unusable. */
  private tier(k: StoredKey, model: string): number {
    if (!k.enabled) return Infinity;
    if (k.kind === "anthropic" && !/claude/i.test(model)) return Infinity;
    const s = this.st(k.id);
    if (this.secretOf(k).error) return Infinity;
    if (this.capped(k, s)) return Infinity;
    if (s.cooldownUntil > this.now()) return s.soft ? 1 : Infinity;
    return 0;
  }

  private toSelected(k: StoredKey): Selected {
    return { id: k.id, label: k.label, kind: k.kind, secret: this.secretOf(k).plain, region: k.region || undefined, api: k.api, baseUrl: k.baseUrl || undefined, version: `${k.id}:${k.secretEnc.slice(0, 40)}:${k.region ?? ""}:${k.api ?? ""}:${k.baseUrl ?? ""}` };
  }

  private envSelected(): Selected {
    return { id: ENV_KEY_ID, label: this.envCredential?.label ?? "gateway credentials", kind: "bedrock", version: ENV_KEY_ID };
  }

  /**
   * Pick the key for the next attempt. Returns null when nothing is usable; `retryInMs` then says when the
   * first cooled-down key comes back so the gateway can answer with an honest retry-after.
   */
  select(ctx: { sessionKey?: string; model: string; exclude: Set<string> }): Selected | null {
    const keys = this.allKeys();
    if (!keys.length) return ctx.exclude.has(ENV_KEY_ID) ? null : this.envSelected();
    const ranked = keys.filter((k) => !ctx.exclude.has(k.id)).map((k) => ({ k, t: this.tier(k, ctx.model) })).filter((x) => x.t !== Infinity);
    const bestTier = Math.min(...ranked.map((x) => x.t));
    const pool = ranked.filter((x) => x.t === bestTier).map((x) => x.k).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (!pool.length) {
      if (this.doc.settings.envFallback && this.envCredential && !ctx.exclude.has(ENV_KEY_ID)) return this.envSelected();
      return null;
    }
    let pick: StoredKey;
    const strategy = this.doc.settings.strategy;
    if (strategy === "fill-first") pick = pool[0];
    else if (strategy === "least-used") pick = [...pool].sort((a, b) => this.st(a.id).tokens - this.st(b.id).tokens)[0];
    else if (strategy === "session" && ctx.sessionKey) {
      const stuck = this.sticky.get(ctx.sessionKey);
      const still = stuck && pool.find((k) => k.id === stuck.id);
      pick = still ?? this.leastSticky(pool);
      this.sticky.set(ctx.sessionKey, { id: pick.id, at: this.now() });
      this.pruneSticky();
    } else pick = pool[this.rr++ % pool.length];
    return this.toSelected(pick);
  }

  /** New sessions go to the key with the fewest live sessions (ties: round-robin) so load spreads evenly. */
  private leastSticky(pool: StoredKey[]): StoredKey {
    const counts = new Map(pool.map((k) => [k.id, 0]));
    const cutoff = this.now() - 60 * 60_000;
    for (const v of this.sticky.values()) if (v.at >= cutoff && counts.has(v.id)) counts.set(v.id, counts.get(v.id)! + 1);
    const min = Math.min(...counts.values());
    const tied = pool.filter((k) => counts.get(k.id) === min);
    return tied[this.rr++ % tied.length];
  }

  private pruneSticky(): void {
    if (this.sticky.size < 5000) return;
    const cutoff = this.now() - 2 * 60 * 60_000;
    for (const [k, v] of this.sticky) if (v.at < cutoff) this.sticky.delete(k);
  }

  /** Earliest time a currently unusable key becomes available again (for retry-after). */
  nextAvailableInMs(): number {
    const now = this.now();
    const waits = this.allKeys()
      .filter((k) => k.enabled && !this.secretOf(k).error && !this.capped(k, this.st(k.id)))
      .map((k) => this.st(k.id).cooldownUntil - now)
      .filter((w) => w > 0);
    return waits.length ? Math.min(...waits) : 60_000;
  }

  markSuccess(id: string, headers?: Headers): void {
    if (id === ENV_KEY_ID) return;
    const s = this.st(id);
    const now = this.now();
    s.lastUsedAt = now;
    s.lastOkAt = now;
    s.lastStatus = 200;
    s.failures = 0;
    if (!s.soft) s.cooldownUntil = 0;
    s.reason = undefined;
    const rate = headers ? rateFromHeaders(headers, now) : undefined;
    if (rate) {
      s.rate = rate;
      const threshold = this.doc.settings.softLimitPct / 100;
      if (threshold > 0 && rate.minRemainingPct < threshold) {
        s.soft = true;
        s.cooldownUntil = Math.max(now + 5_000, Math.min(rate.resetAt ?? now + 60_000, now + 10 * 60_000));
        s.reason = `near_limit:${rate.bucket}`;
      } else if (s.soft) {
        s.soft = false;
        s.cooldownUntil = 0;
      }
    }
  }

  markFailure(id: string, v: FailureVerdict & { status?: number; error?: string }): void {
    if (id === ENV_KEY_ID) return;
    const s = this.st(id);
    const now = this.now();
    s.lastUsedAt = now;
    s.lastStatus = v.status;
    s.lastError = v.error?.slice(0, 300);
    s.failures++;
    if (v.retry) {
      s.failovers++;
      // Repeated hard failures back off further (capped at 1 h) so a dead key stops costing a round trip.
      const factor = v.reason === "rate_limited" || v.reason === "credit_exhausted" ? 1 : Math.min(8, 2 ** Math.max(0, s.failures - 1));
      s.cooldownUntil = now + Math.min(60 * 60_000, v.cooldownMs * factor);
      s.soft = false;
      s.reason = v.reason;
    }
  }

  recordUsage(id: string | undefined, tokens: number, costUsd: number): void {
    if (!id || id === ENV_KEY_ID) return;
    const s = this.st(id);
    s.requests++;
    s.tokens += tokens;
    s.costUsd += costUsd;
  }

  /** Seed today's counters from the store after a restart (or refresh them on multi-task deployments). */
  seedUsage(id: string, totals: { requests: number; tokens: number; costUsd: number }): void {
    const s = this.st(id);
    s.requests = Math.max(s.requests, totals.requests);
    s.tokens = Math.max(s.tokens, totals.tokens);
    s.costUsd = Math.max(s.costUsd, totals.costUsd);
  }

  resetCooldown(id: string): void {
    const s = this.st(id);
    Object.assign(s, { cooldownUntil: 0, soft: false, failures: 0, reason: undefined });
  }

  /* -------- admin mutations (callers persist toDoc() afterwards) -------- */

  addKey(input: { label: string; kind: ProviderKind; secret: string; priority?: number; region?: string; api?: "mantle" | "runtime"; baseUrl?: string; dailyTokenLimit?: number; dailyBudgetUsd?: number }): StoredKey {
    const id = `k_${randomBytes(4).toString("hex")}`;
    const k: StoredKey = {
      id,
      label: input.label,
      kind: input.kind,
      secretEnc: this.box.seal(input.secret),
      last4: input.secret.slice(-4),
      fingerprint: fingerprint(input.secret),
      enabled: true,
      priority: input.priority ?? (Math.max(0, ...this.doc.keys.map((x) => x.priority)) + 10),
      region: input.region || undefined,
      api: input.api,
      baseUrl: input.baseUrl || undefined,
      dailyTokenLimit: input.dailyTokenLimit || undefined,
      dailyBudgetUsd: input.dailyBudgetUsd || undefined,
      createdAt: new Date(this.now()).toISOString(),
      source: "store",
    };
    this.doc.keys.push(k);
    this.doc.updatedAt = k.createdAt;
    return k;
  }

  updateKey(id: string, patch: Partial<Pick<StoredKey, "label" | "enabled" | "priority" | "region" | "api" | "baseUrl" | "dailyTokenLimit" | "dailyBudgetUsd">> & { secret?: string }): StoredKey | null {
    const k = this.doc.keys.find((x) => x.id === id);
    if (!k) return null;
    const { secret, ...rest } = patch;
    for (const [f, v] of Object.entries(rest)) {
      if (v === undefined) continue;
      (k as unknown as Record<string, unknown>)[f] = v === "" || v === null || v === 0 ? (f === "enabled" || f === "priority" ? v : undefined) : v;
    }
    if (secret) {
      k.secretEnc = this.box.seal(secret);
      k.last4 = secret.slice(-4);
      k.fingerprint = fingerprint(secret);
      this.secrets.delete(id);
      this.resetCooldown(id);
    }
    if (patch.enabled === true) this.resetCooldown(id);
    this.doc.updatedAt = new Date(this.now()).toISOString();
    return k;
  }

  removeKey(id: string): boolean {
    const n = this.doc.keys.length;
    this.doc.keys = this.doc.keys.filter((k) => k.id !== id);
    this.state.delete(id);
    this.secrets.delete(id);
    for (const [s, v] of this.sticky) if (v.id === id) this.sticky.delete(s);
    this.doc.updatedAt = new Date(this.now()).toISOString();
    return this.doc.keys.length !== n;
  }

  setSettings(p: Partial<PoolSettings>): PoolSettings {
    this.doc.settings = { ...this.doc.settings, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) };
    this.doc.updatedAt = new Date(this.now()).toISOString();
    return this.doc.settings;
  }

  /** Selected handle for an explicit key (admin "test" button), ignoring cooldowns. */
  handle(id: string): Selected | null {
    if (id === ENV_KEY_ID) return this.envCredential ? this.envSelected() : null;
    const k = this.allKeys().find((x) => x.id === id);
    if (!k) return null;
    const sec = this.secretOf(k);
    if (sec.error) throw new Error(sec.error);
    return this.toSelected(k);
  }

  view(): { settings: PoolSettings; keys: KeyView[]; envCredential: string | null; canStoreSecrets: boolean; summary: { total: number; available: number } } {
    const now = this.now();
    const live = new Map<string, number>();
    const cutoff = now - 60 * 60_000;
    for (const v of this.sticky.values()) if (v.at >= cutoff) live.set(v.id, (live.get(v.id) ?? 0) + 1);
    const keys = this.allKeys()
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
      .map((k): KeyView => {
        const s = this.st(k.id);
        const sec = this.secretOf(k);
        const cooling = s.cooldownUntil > now;
        const status: KeyView["status"] = !k.enabled ? "disabled" : sec.error ? "error" : this.capped(k, s) ? "capped" : cooling ? (s.soft ? "parked" : "cooling") : "active";
        return {
          id: k.id,
          label: k.label,
          kind: k.kind,
          last4: k.last4,
          enabled: k.enabled,
          priority: k.priority,
          region: k.region,
          api: k.api,
          baseUrl: k.baseUrl,
          dailyTokenLimit: k.dailyTokenLimit,
          dailyBudgetUsd: k.dailyBudgetUsd,
          createdAt: k.createdAt,
          source: k.source ?? "store",
          status,
          reason: sec.error ? "decrypt_failed" : s.reason,
          cooldownSec: cooling ? Math.ceil((s.cooldownUntil - now) / 1000) : 0,
          lastStatus: s.lastStatus,
          lastError: sec.error ?? s.lastError,
          lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt).toISOString() : undefined,
          lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : undefined,
          today: { requests: s.requests, tokens: s.tokens, costUsd: Math.round(s.costUsd * 1e6) / 1e6, failovers: s.failovers },
          rate: s.rate ? { minRemainingPct: Math.round(s.rate.minRemainingPct * 1000) / 10, bucket: s.rate.bucket, resetAt: s.rate.resetAt ? new Date(s.rate.resetAt).toISOString() : undefined, at: new Date(s.rate.at).toISOString() } : undefined,
          activeSessions: live.get(k.id) ?? 0,
        };
      });
    return {
      settings: { ...this.doc.settings },
      keys,
      envCredential: this.envCredential?.label ?? null,
      canStoreSecrets: this.box.available,
      summary: { total: keys.length, available: keys.filter((k) => k.status === "active" || k.status === "parked").length },
    };
  }
}

/** Validate admin input for pool settings. */
export function validateSettings(o: Record<string, unknown>): { ok: true; value: Partial<PoolSettings> } | { ok: false; error: string } {
  const out: Partial<PoolSettings> = {};
  if (o.strategy !== undefined) {
    if (!POOL_STRATEGIES.includes(o.strategy as PoolStrategy)) return { ok: false, error: `strategy must be one of ${POOL_STRATEGIES.join(", ")}` };
    out.strategy = o.strategy as PoolStrategy;
  }
  if (o.envFallback !== undefined) {
    if (typeof o.envFallback !== "boolean") return { ok: false, error: "envFallback must be a boolean" };
    out.envFallback = o.envFallback;
  }
  if (o.softLimitPct !== undefined) {
    const n = Number(o.softLimitPct);
    if (!Number.isFinite(n) || n < 0 || n > 50) return { ok: false, error: "softLimitPct must be between 0 and 50" };
    out.softLimitPct = n;
  }
  if (o.maxAttempts !== undefined) {
    const n = Number(o.maxAttempts);
    if (!Number.isInteger(n) || n < 1 || n > 20) return { ok: false, error: "maxAttempts must be an integer between 1 and 20" };
    out.maxAttempts = n;
  }
  return { ok: true, value: out };
}
