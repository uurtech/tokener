import { describe, expect, it } from "vitest";
import { KeyPool, SecretBox, classifyFailure, rateFromHeaders, retryAfterMs, toAnthropicModelId, validateSettings, ENV_KEY_ID } from "../src/keypool.js";

const MODEL = "anthropic.claude-opus-5-5";
const mk = (opts: { now?: () => number; env?: boolean } = {}) => new KeyPool(new SecretBox("test-secret"), opts.env === false ? null : { label: "env" }, opts.now);
const add = (p: KeyPool, label: string, extra: Record<string, unknown> = {}) => p.addKey({ label, kind: "anthropic", secret: `sk-ant-${label}-xxxxxxxx`, ...extra });
const pick = (p: KeyPool, sessionKey?: string, exclude: string[] = []) => p.select({ sessionKey, model: MODEL, exclude: new Set(exclude) });

describe("SecretBox", () => {
  it("round-trips and never stores plaintext", () => {
    const b = new SecretBox("s");
    const sealed = b.seal("sk-ant-api03-secret");
    expect(sealed).not.toContain("secret");
    expect(b.open(sealed)).toBe("sk-ant-api03-secret");
  });
  it("fails with a different secret", () => {
    const sealed = new SecretBox("a").seal("x");
    expect(() => new SecretBox("b").open(sealed)).toThrow();
  });
});

describe("toAnthropicModelId", () => {
  it("maps Bedrock ids to Anthropic API ids", () => {
    expect(toAnthropicModelId("anthropic.claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(toAnthropicModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5-20251001");
    expect(toAnthropicModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });
});

describe("classifyFailure", () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it("fails over on rate limits, overload, auth and credit exhaustion", () => {
    expect(classifyFailure(429, "", h({ "retry-after": "12" }))).toMatchObject({ retry: true, cooldownMs: 12_000, reason: "rate_limited" });
    expect(classifyFailure(529, "", h())).toMatchObject({ retry: true, reason: "overloaded" });
    expect(classifyFailure(401, "", h())).toMatchObject({ retry: true, reason: "auth_failed" });
    expect(classifyFailure(400, '{"error":{"message":"Your credit balance is too low"}}', h())).toMatchObject({ retry: true, reason: "credit_exhausted" });
  });
  it("does not fail over on request errors", () => {
    expect(classifyFailure(400, '{"error":{"message":"messages: field required"}}', h()).retry).toBe(false);
    expect(classifyFailure(404, "", h()).retry).toBe(false);
  });
  it("derives 429 wait from ratelimit reset when retry-after is missing", () => {
    const now = Date.parse("2026-11-18T10:00:00Z");
    expect(retryAfterMs(h({ "anthropic-ratelimit-tokens-reset": "2026-11-18T10:00:20Z" }), now)).toBe(20_000);
    expect(retryAfterMs(h(), now)).toBe(30_000);
  });
});

describe("rateFromHeaders", () => {
  it("returns the tightest bucket", () => {
    const r = rateFromHeaders(new Headers({
      "anthropic-ratelimit-requests-limit": "100", "anthropic-ratelimit-requests-remaining": "90",
      "anthropic-ratelimit-input-tokens-limit": "1000", "anthropic-ratelimit-input-tokens-remaining": "20",
    }));
    expect(r?.bucket).toBe("input-tokens");
    expect(r?.minRemainingPct).toBeCloseTo(0.02);
  });
});

describe("KeyPool selection", () => {
  it("uses the env credential when no keys are configured", () => {
    expect(pick(mk())?.id).toBe(ENV_KEY_ID);
    expect(pick(mk({ env: false }))?.id).toBe(ENV_KEY_ID); // legacy behaviour: always try the gateway's own credentials
  });

  it("session strategy keeps a session on one key and spreads new sessions", () => {
    const p = mk();
    const a = add(p, "a"), b = add(p, "b"), c = add(p, "c");
    const s1 = pick(p, "s1")!.id, s2 = pick(p, "s2")!.id, s3 = pick(p, "s3")!.id;
    expect(new Set([s1, s2, s3])).toEqual(new Set([a.id, b.id, c.id]));
    for (let i = 0; i < 5; i++) expect(pick(p, "s1")!.id).toBe(s1);
  });

  it("moves a session off a cooled-down key and back to healthy rotation", () => {
    let t = 1_000_000;
    const p = mk({ now: () => t });
    add(p, "a");
    add(p, "b");
    const first = pick(p, "s")!.id;
    p.markFailure(first, { retry: true, cooldownMs: 30_000, reason: "rate_limited", status: 429 });
    const second = pick(p, "s")!.id;
    expect(second).not.toBe(first);
    t += 31_000;
    expect(pick(p, "s")!.id).toBe(second); // sticky to the new key, no flapping back
  });

  it("round-robin rotates every request", () => {
    const p = mk();
    add(p, "a");
    add(p, "b");
    p.setSettings({ strategy: "round-robin" });
    const ids = [1, 2, 3, 4].map(() => pick(p, "same")!.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(ids[2]);
  });

  it("fill-first drains keys in priority order", () => {
    const p = mk();
    const lo = add(p, "lo", { priority: 1 });
    add(p, "hi", { priority: 5 });
    p.setSettings({ strategy: "fill-first" });
    expect(pick(p, "x")!.id).toBe(lo.id);
    expect(pick(p, "y")!.id).toBe(lo.id);
  });

  it("excludes keys already tried in this request, then falls back to env, then gives up", () => {
    const p = mk();
    const a = add(p, "a");
    expect(pick(p, "s", [a.id])!.id).toBe(ENV_KEY_ID);
    p.setSettings({ envFallback: false });
    expect(pick(p, "s", [a.id])).toBeNull();
  });

  it("parks a key near its rate limit but still uses it as a last resort", () => {
    const p = mk({ env: false });
    const a = add(p, "a");
    const b = add(p, "b");
    p.markSuccess(a.id, new Headers({ "anthropic-ratelimit-tokens-limit": "1000", "anthropic-ratelimit-tokens-remaining": "10" }));
    expect(p.view().keys.find((k) => k.id === a.id)!.status).toBe("parked");
    for (let i = 0; i < 3; i++) expect(pick(p, `s${i}`)!.id).toBe(b.id);
    p.markFailure(b.id, { retry: true, cooldownMs: 60_000, reason: "rate_limited" });
    expect(pick(p, "s9")!.id).toBe(a.id);
  });

  it("honours per-key daily caps", () => {
    const p = mk({ env: false });
    const a = add(p, "a", { dailyTokenLimit: 100 });
    const b = add(p, "b");
    p.setSettings({ strategy: "fill-first", envFallback: false });
    p.recordUsage(a.id, 150, 0.1);
    expect(pick(p, "s")!.id).toBe(b.id);
    expect(p.view().keys.find((k) => k.id === a.id)!.status).toBe("capped");
  });

  it("skips Anthropic keys for non-Claude models and disabled keys", () => {
    const p = mk();
    const a = add(p, "a");
    expect(p.select({ model: "amazon.nova-pro-v1:0", exclude: new Set() })!.id).toBe(ENV_KEY_ID);
    p.updateKey(a.id, { enabled: false });
    expect(pick(p)!.id).toBe(ENV_KEY_ID);
  });

  it("marks keys it cannot decrypt as errors instead of crashing", () => {
    const p1 = mk();
    add(p1, "a");
    const p2 = new KeyPool(new SecretBox("other"), null);
    p2.load(p1.toDoc());
    expect(p2.view().keys[0].status).toBe("error");
    p2.setSettings({ envFallback: false });
    expect(pick(p2)).toBeNull();
  });

  it("never exposes secrets in the admin view or persisted doc", () => {
    const p = mk();
    add(p, "a");
    expect(JSON.stringify(p.view())).not.toContain("sk-ant-a");
    expect(JSON.stringify(p.toDoc())).not.toContain("sk-ant-a");
  });

  it("reads PROVIDER_KEYS_JSON as read-only env keys", () => {
    const p = mk();
    p.loadEnvKeys(JSON.stringify([{ label: "ci", kind: "anthropic", key: "sk-ant-ci-123456789" }]));
    expect(pick(p, "s")!.secret).toBe("sk-ant-ci-123456789");
    expect(p.toDoc().keys).toHaveLength(0);
    expect(p.view().keys[0]).toMatchObject({ source: "env", last4: "6789" });
  });
});

describe("validateSettings", () => {
  it("accepts valid and rejects invalid input", () => {
    expect(validateSettings({ strategy: "least-used", softLimitPct: 10 }).ok).toBe(true);
    expect(validateSettings({ strategy: "random" }).ok).toBe(false);
    expect(validateSettings({ maxAttempts: 0 }).ok).toBe(false);
  });
});
