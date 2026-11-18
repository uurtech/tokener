import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, randomBytes, createHash } from "node:crypto";
import { KeyPool, SecretBox, rendezvous, type PoolEvent, type SharedKeyState } from "../src/keypool.js";
import { evaluateBudget, budgetHeaders, budgetMessage, warningFor } from "../src/budget.js";
import { Alerter, formatAlert, validWebhookUrl } from "../src/alerts.js";
import { Oidc, parseCookies, requestOrigin, type OidcConfig } from "../src/oidc.js";
import { resolveDataKey, type KmsLike } from "../src/kms.js";
import type { DailyTotals } from "../src/store/types.js";

const MODEL = "anthropic.claude-opus-5-5";
const pool = (now?: () => number, opts = {}) => new KeyPool(new SecretBox("s"), null, now, opts);
const add = (p: KeyPool, label: string, extra: Record<string, unknown> = {}) => p.addKey({ label, kind: "anthropic", secret: `sk-ant-${label}-123456789`, ...extra });
const sel = (p: KeyPool, x: { session?: string; team?: string; exclude?: string[] } = {}) => p.select({ sessionKey: x.session, team: x.team, model: MODEL, exclude: new Set(x.exclude ?? []) });

describe("team key groups", () => {
  it("reserves dedicated keys for their team and prefers them over shared keys", () => {
    const p = pool();
    p.setSettings({ envFallback: false });
    const shared = add(p, "shared");
    const backend = add(p, "backend", { teams: ["backend"] });
    for (let i = 0; i < 5; i++) expect(sel(p, { session: `b${i}`, team: "backend" })!.id).toBe(backend.id);
    for (let i = 0; i < 5; i++) expect(sel(p, { session: `f${i}`, team: "frontend" })!.id).toBe(shared.id);
    expect(sel(p, { session: "n" })!.id).toBe(shared.id); // no team -> shared only
  });

  it("overflows to shared keys when the team's keys are unavailable", () => {
    const p = pool();
    p.setSettings({ envFallback: false });
    const shared = add(p, "shared");
    const backend = add(p, "backend", { teams: ["backend"] });
    p.markFailure(backend.id, { retry: true, cooldownMs: 60_000, reason: "rate_limited" });
    expect(sel(p, { session: "x", team: "backend" })!.id).toBe(shared.id);
  });

  it("never gives another team's dedicated key", () => {
    const p = pool();
    p.setSettings({ envFallback: false });
    add(p, "backend", { teams: ["backend"] });
    expect(sel(p, { session: "x", team: "frontend" })).toBeNull();
  });
});

describe("local TPM / RPM limits (Bedrock has no rate-limit headers)", () => {
  it("parks a key near its RPM and spills to the next one", () => {
    let t = 1_000_000;
    const p = pool(() => t);
    p.setSettings({ strategy: "fill-first", envFallback: false, softLimitPct: 10 });
    const a = add(p, "a", { rpmLimit: 10, priority: 1 });
    const b = add(p, "b", { priority: 2 });
    const ids = Array.from({ length: 12 }, () => sel(p)!.id);
    expect(ids.slice(0, 9).every((id) => id === a.id)).toBe(true); // 90% of 10
    expect(ids[9]).toBe(b.id);
    expect(p.view().keys.find((k) => k.id === a.id)).toMatchObject({ status: "parked", reason: "near_limit:rpm" });
    t += 61_000; // window slides
    expect(sel(p)!.id).toBe(a.id);
  });

  it("parks a key near its TPM", () => {
    const p = pool();
    p.setSettings({ strategy: "fill-first", envFallback: false });
    const a = add(p, "a", { tpmLimit: 1000, priority: 1 });
    const b = add(p, "b", { priority: 2 });
    p.recordUsage(a.id, 960, 0);
    expect(sel(p)!.id).toBe(b.id);
    expect(p.view().keys.find((k) => k.id === a.id)!.rate).toMatchObject({ bucket: "tpm (local)", minRemainingPct: 4 });
  });
});

describe("alert events", () => {
  it("emits key.down for keys a human must fix, and key.recovered afterwards", () => {
    const p = pool();
    const events: PoolEvent[] = [];
    p.onEvent = (e) => events.push(e);
    const a = add(p, "a");
    p.markFailure(a.id, { retry: true, cooldownMs: 1000, reason: "credit_exhausted", status: 400 });
    p.markFailure(a.id, { retry: true, cooldownMs: 1000, reason: "credit_exhausted", status: 400 }); // no duplicate
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "key.down", reason: "credit_exhausted", label: "a" });
    p.markSuccess(a.id);
    expect(events[1]).toMatchObject({ type: "key.recovered", downReason: "credit_exhausted" });
  });

  it("does not alert on a single 429, only on repeated ones", () => {
    const p = pool();
    const events: PoolEvent[] = [];
    p.onEvent = (e) => events.push(e);
    const a = add(p, "a");
    p.markFailure(a.id, { retry: true, cooldownMs: 1000, reason: "rate_limited" });
    p.markFailure(a.id, { retry: true, cooldownMs: 1000, reason: "rate_limited" });
    expect(events).toHaveLength(0);
    p.markFailure(a.id, { retry: true, cooldownMs: 1000, reason: "rate_limited" });
    expect(events).toHaveLength(1);
  });
});

describe("shared key state", () => {
  it("publishes cooldowns and applies newer ones from other tasks", () => {
    let t = 1_000_000;
    const a1 = pool(() => t), a2 = pool(() => t);
    const k = add(a1, "a");
    a2.load(a1.toDoc());
    const saved: Record<string, SharedKeyState> = {};
    a1.onState = (id, st) => (saved[id] = st);
    a1.markFailure(k.id, { retry: true, cooldownMs: 60_000, reason: "rate_limited" });
    expect(saved[k.id]).toMatchObject({ reason: "rate_limited", soft: false });
    a2.setSettings({ envFallback: false });
    expect(sel(a2)!.id).toBe(k.id);
    a2.applyShared(saved);
    expect(sel(a2)).toBeNull(); // task 2 now knows the key is cooling
    t += 1000;
    a2.applyShared({ [k.id]: { cooldownUntil: 0, soft: false, updatedAt: saved[k.id].updatedAt - 5 } }); // older -> ignored
    expect(sel(a2)).toBeNull();
  });

  it("does not write state on every successful request", () => {
    const p = pool();
    const k = add(p, "a");
    const writes = vi.fn();
    p.onState = writes;
    for (let i = 0; i < 10; i++) p.markSuccess(k.id);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe("distributed session assignment", () => {
  it("rendezvous hashing is stable and spreads sessions", () => {
    const keys = ["k1", "k2", "k3"].map((id) => ({ id }));
    expect(rendezvous(keys, "sess-1")).toBe(rendezvous([...keys].reverse(), "sess-1"));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 300; i++) counts[rendezvous(keys, `s${i}`).id] = (counts[rendezvous(keys, `s${i}`).id] ?? 0) + 1;
    expect(Object.values(counts).every((n) => n > 60)).toBe(true);
  });

  it("two tasks put the same new session on the same key", () => {
    const t1 = pool(undefined, { distributed: true });
    ["a", "b", "c", "d"].forEach((l) => add(t1, l));
    const t2 = pool(undefined, { distributed: true });
    t2.load(t1.toDoc());
    for (let i = 0; i < 20; i++) expect(sel(t1, { session: `s${i}` })!.id).toBe(sel(t2, { session: `s${i}` })!.id);
  });
});

describe("rekey", () => {
  it("moves stored keys to a new box", () => {
    const p = pool();
    const k = add(p, "a");
    const next = new SecretBox(undefined, randomBytes(32));
    expect(p.rekey(next)).toBe(1);
    expect(p.encryption).toBe("kms");
    expect(p.handle(k.id)!.secret).toBe("sk-ant-a-123456789");
    expect(next.open(p.toDoc().keys[0].secretEnc)).toBe("sk-ant-a-123456789");
  });
});

describe("monthly budgets", () => {
  const T = (costUsd: number, tokens = 0): DailyTotals => ({ requests: 1, costUsd, savedUsd: 0, inputTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  const dev = { developerId: "a", keyHash: "h", enabled: true, monthlyBudgetUsd: 100, monthlyTokenLimit: 1_000_000 };
  it("trips on the monthly cap even when the day is fine", () => {
    const b = evaluateBudget(dev, T(5), T(101));
    expect(b).toMatchObject({ exceeded: true, reason: "month_usd" });
    expect(budgetMessage(b)).toMatch(/Monthly gateway budget exceeded \(\$101\.00 of \$100\.00\)/);
    expect(budgetHeaders(b)["x-gateway-budget-month"]).toBe("101.00/100.00");
  });
  it("warns at 80% of the month and reports month tokens", () => {
    const b = evaluateBudget(dev, T(1), T(10, 850_000));
    expect(b.exceeded).toBe(false);
    expect(warningFor(b)).toBe("month_tokens");
    expect(budgetHeaders(b)["x-gateway-budget-status"]).toBe("warning:month_tokens");
  });
});

describe("alerter", () => {
  it("throttles per dedup key and posts Slack + Discord compatible JSON", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let t = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const a = new Alerter(() => "https://hooks.example/x", "gw-1", () => {}, { fetchImpl, now: () => t, throttleMs: 1000 });
    expect(a.emit({ kind: "key.down", severity: "critical", title: "Key down" }, "k1")).toBe(true);
    expect(a.emit({ kind: "key.down", severity: "critical", title: "Key down" }, "k1")).toBe(false);
    t = 2000;
    expect(a.emit({ kind: "key.down", severity: "critical", title: "Key down" }, "k1")).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2);
    expect(calls[0].body.text).toContain("Key down");
    expect(calls[0].body.content).toContain("Key down");
    expect((calls[0].body.event as Record<string, unknown>).kind).toBe("key.down");
    expect(a.history()[0].delivered).toBe(true);
  });
  it("formats and validates", () => {
    expect(formatAlert({ kind: "x", severity: "warning", title: "T", fields: { a: 1, b: undefined } }, "src")).toBe("🟠 *tokener* (src) T\na: 1");
    expect(validWebhookUrl("")).toBe(true);
    expect(validWebhookUrl("https://hooks.slack.com/x")).toBe(true);
    expect(validWebhookUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("OIDC", () => {
  const cfg: OidcConfig = { issuer: "https://idp.example", clientId: "tokener", clientSecret: "s3cret", allowedDomains: ["archeon.dev"], allowedEmails: ["boss@gmail.com"], scopes: "openid email", label: "Test", sessionHours: 12 };
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwks = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "r1", alg: "RS256", use: "sig" }, { ...ec.publicKey.export({ format: "jwk" }), kid: "e1", alg: "ES256", use: "sig" }] };
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = (claims: Record<string, unknown>, kid = "r1") => {
    const alg = kid === "e1" ? "ES256" : "RS256";
    const data = `${b64u({ alg, kid, typ: "JWT" })}.${b64u(claims)}`;
    const sig = kid === "e1" ? cryptoSign("sha256", Buffer.from(data), { key: ec.privateKey, dsaEncoding: "ieee-p1363" }) : cryptoSign("sha256", Buffer.from(data), rsa.privateKey);
    return `${data}.${sig.toString("base64url")}`;
  };
  let tokenResponse: Record<string, unknown> = {};
  let lastTokenForm: URLSearchParams | undefined;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: cfg.issuer, authorization_endpoint: `${cfg.issuer}/authorize`, token_endpoint: `${cfg.issuer}/token`, jwks_uri: `${cfg.issuer}/jwks` });
    if (url.endsWith("/jwks")) return Response.json(jwks);
    if (url.endsWith("/token")) {
      lastTokenForm = new URLSearchParams(String(init?.body));
      return Response.json(tokenResponse);
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  const secret = createHash("sha256").update("x").digest();
  const now = () => Date.now();
  const claims = (o: Record<string, unknown> = {}) => ({ iss: cfg.issuer, aud: "tokener", exp: Math.floor(Date.now() / 1000) + 300, email: "ugur@archeon.dev", email_verified: true, ...o });

  const login = async (o: Oidc) => {
    const r = await o.loginRedirect("https://gw.example");
    const u = new URL(r.location);
    const cookie = r.cookie.split(";")[0];
    return { state: u.searchParams.get("state")!, nonce: u.searchParams.get("nonce")!, cookie, u };
  };

  it("builds a PKCE authorization request", async () => {
    const o = new Oidc(cfg, secret, fetchImpl, now);
    const { u } = await login(o);
    expect(u.origin + u.pathname).toBe("https://idp.example/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://gw.example/admin/sso/callback");
  });

  it("completes the flow for an allowed domain (RS256) and issues a session cookie", async () => {
    const o = new Oidc(cfg, secret, fetchImpl, now);
    const { state, nonce, cookie } = await login(o);
    tokenResponse = { id_token: jwt(claims({ nonce })) };
    const r = await o.callback(new URLSearchParams({ state, code: "c1" }), cookie, "https://gw.example");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lastTokenForm!.get("code_verifier")).toBeTruthy();
    const sessionCookie = r.cookies.find((c) => c.startsWith("tk_admin="))!;
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(o.session(sessionCookie.split(";")[0])?.email).toBe("ugur@archeon.dev");
  });

  it("accepts an explicitly allowed e-mail with an ES256 token", async () => {
    const o = new Oidc(cfg, secret, fetchImpl, now);
    const { state, nonce, cookie } = await login(o);
    tokenResponse = { id_token: jwt(claims({ nonce, email: "boss@gmail.com" }), "e1") };
    const r = await o.callback(new URLSearchParams({ state, code: "c" }), cookie, "https://gw.example");
    expect(r.ok).toBe(true);
  });

  it.each([
    ["other domain", { email: "x@evil.com" }, /not allowed/],
    ["unverified e-mail", { email_verified: false }, /not verified/],
    ["wrong audience", { aud: "someone-else" }, /audience/],
    ["expired", { exp: 1000 }, /expired/],
    ["wrong issuer", { iss: "https://evil.example" }, /issuer/],
  ])("rejects %s", async (_n, extra, err) => {
    const o = new Oidc(cfg, secret, fetchImpl, now);
    const { state, nonce, cookie } = await login(o);
    tokenResponse = { id_token: jwt(claims({ nonce, ...extra })) };
    const r = await o.callback(new URLSearchParams({ state, code: "c" }), cookie, "https://gw.example");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(err);
  });

  it("rejects a forged signature, wrong nonce and wrong state", async () => {
    const o = new Oidc(cfg, secret, fetchImpl, now);
    const { state, nonce, cookie } = await login(o);
    const good = jwt(claims({ nonce }));
    tokenResponse = { id_token: good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA") };
    let r = await o.callback(new URLSearchParams({ state, code: "c" }), cookie, "https://gw.example");
    expect(r.ok).toBe(false);
    tokenResponse = { id_token: jwt(claims({ nonce: "other" })) };
    r = await o.callback(new URLSearchParams({ state, code: "c" }), cookie, "https://gw.example");
    expect(!r.ok && r.error).toMatch(/nonce/);
    r = await o.callback(new URLSearchParams({ state: "x", code: "c" }), cookie, "https://gw.example");
    expect(!r.ok && r.error).toMatch(/state/);
  });

  it("rejects tampered or expired session cookies", () => {
    const o = new Oidc(cfg, secret, fetchImpl, now);
    const v = o.sign({ email: "a@archeon.dev", exp: Date.now() + 1000 });
    expect(o.session(`tk_admin=${v}`)?.email).toBe("a@archeon.dev");
    expect(o.session(`tk_admin=${v.replace(/.$/, "x")}`)).toBeNull();
    expect(o.session(`tk_admin=${o.sign({ email: "a", exp: Date.now() - 1 })}`)).toBeNull();
    expect(new Oidc(cfg, randomBytes(32), fetchImpl, now).session(`tk_admin=${v}`)).toBeNull();
  });

  it("helpers", () => {
    expect(parseCookies("a=1; b=x%20y")).toEqual({ a: "1", b: "x y" });
    expect(requestOrigin({ host: "gw:8080" })).toBe("http://gw:8080");
    expect(requestOrigin({ host: "gw", "x-forwarded-proto": "https" })).toBe("https://gw");
  });
});

describe("KMS data key", () => {
  it("creates once, then decrypts the stored one", async () => {
    const plain = randomBytes(32);
    const kms: KmsLike = { generateDataKey: vi.fn(async () => ({ plaintext: plain, ciphertext: Buffer.from("wrapped") })), decrypt: vi.fn(async () => plain) };
    const first = await resolveDataKey(kms, "alias/x", undefined);
    expect(first.created).toBe(true);
    const again = await resolveDataKey(kms, "alias/x", first.wrapped);
    expect(again.created).toBe(false);
    expect(again.key.equals(plain)).toBe(true);
    expect(kms.generateDataKey).toHaveBeenCalledTimes(1);
  });
});
