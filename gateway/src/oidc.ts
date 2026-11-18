/**
 * Single sign-on for the admin console with OpenID Connect (authorization code flow + PKCE).
 * Works with any standards-compliant provider: Google Workspace, Okta, Microsoft Entra ID, Auth0,
 * Keycloak, AWS IAM Identity Center (via an OIDC app), etc. No dependencies: discovery, JWKS and
 * ID-token verification (RS256 / PS256 / ES256) use node:crypto.
 *
 * Access is granted only to verified e-mail addresses listed in OIDC_ALLOWED_EMAILS or belonging to a
 * domain in OIDC_ALLOWED_DOMAINS. With both empty nobody gets in (secure default).
 *
 * Sessions are stateless HMAC-signed cookies (12 h), so they work across several gateway tasks.
 */
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  allowedDomains: string[];
  allowedEmails: string[];
  /** Fixed callback URL; default `<request origin>/admin/sso/callback`. */
  redirectUrl?: string;
  scopes: string;
  /** Button text, e.g. "Google" -> "Sign in with Google". */
  label: string;
  sessionHours: number;
}

export interface AdminSession {
  email: string;
  name?: string;
  exp: number;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function oidcConfigFromEnv(env = process.env): OidcConfig | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return null;
  return {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ""),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    allowedDomains: list(env.OIDC_ALLOWED_DOMAINS),
    allowedEmails: list(env.OIDC_ALLOWED_EMAILS),
    redirectUrl: env.OIDC_REDIRECT_URL || undefined,
    scopes: env.OIDC_SCOPES || "openid email profile",
    label: env.OIDC_LABEL || "SSO",
    sessionHours: Number(env.OIDC_SESSION_HOURS || 12) || 12,
  };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export class Oidc {
  private disc?: { doc: Discovery; at: number };
  private jwks?: { keys: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }>; at: number };

  constructor(
    readonly cfg: OidcConfig,
    private readonly secret: Buffer,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /* ---------- signed cookie values ---------- */

  sign(obj: object): string {
    const body = b64u(JSON.stringify(obj));
    return `${body}.${b64u(createHmac("sha256", this.secret).update(body).digest())}`;
  }

  unsign<T extends { exp: number }>(v: string | undefined): T | null {
    if (!v) return null;
    const [body, mac] = v.split(".");
    if (!body || !mac) return null;
    const want = createHmac("sha256", this.secret).update(body).digest();
    const got = fromB64u(mac);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const obj = JSON.parse(fromB64u(body).toString("utf8")) as T;
      return typeof obj.exp === "number" && obj.exp > this.now() ? obj : null;
    } catch {
      return null;
    }
  }

  private cookie(name: string, value: string, path: string, maxAgeSec: number, secure: boolean): string {
    return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }

  session(cookieHeader: string | undefined): AdminSession | null {
    return this.unsign<AdminSession>(parseCookies(cookieHeader).tk_admin);
  }

  logoutCookie(secure: boolean): string {
    return this.cookie("tk_admin", "", "/admin", 0, secure);
  }

  /* ---------- provider metadata ---------- */

  async discovery(): Promise<Discovery> {
    if (this.disc && this.now() - this.disc.at < 3600_000) return this.disc.doc;
    const r = await this.fetchImpl(`${this.cfg.issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw new Error(`OIDC discovery failed: HTTP ${r.status}`);
    const doc = (await r.json()) as Discovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error("OIDC discovery document is incomplete");
    this.disc = { doc, at: this.now() };
    return doc;
  }

  private async keyFor(kid: string | undefined, alg: string) {
    const load = async (force: boolean) => {
      if (!force && this.jwks && this.now() - this.jwks.at < 3600_000) return this.jwks.keys;
      const r = await this.fetchImpl((await this.discovery()).jwks_uri);
      if (!r.ok) throw new Error(`JWKS fetch failed: HTTP ${r.status}`);
      this.jwks = { keys: ((await r.json()) as { keys: NonNullable<Oidc["jwks"]>["keys"] }).keys ?? [], at: this.now() };
      return this.jwks.keys;
    };
    const pick = (keys: NonNullable<Oidc["jwks"]>["keys"]) => keys.find((k) => (kid ? k.kid === kid : true) && (!k.alg || k.alg === alg) && (!k.use || k.use === "sig"));
    const jwk = pick(await load(false)) ?? pick(await load(true)); // unknown kid: the provider rotated keys
    if (!jwk) throw new Error(`no signing key ${kid ?? ""} in JWKS`);
    return createPublicKey({ key: jwk, format: "jwk" });
  }

  /** Verify an ID token's signature and standard claims. Returns its payload. */
  async verifyIdToken(token: string, nonce: string): Promise<Record<string, unknown>> {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) throw new Error("malformed ID token");
    const header = JSON.parse(fromB64u(h).toString("utf8")) as { alg?: string; kid?: string };
    const alg = header.alg ?? "";
    if (!["RS256", "PS256", "ES256"].includes(alg)) throw new Error(`unsupported ID token alg ${alg}`);
    const key = await this.keyFor(header.kid, alg);
    const data = Buffer.from(`${h}.${p}`);
    const ok =
      alg === "ES256"
        ? verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, fromB64u(sig))
        : alg === "PS256"
          ? verify("sha256", data, { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }, fromB64u(sig))
          : verify("sha256", data, key, fromB64u(sig));
    if (!ok) throw new Error("ID token signature invalid");
    const c = JSON.parse(fromB64u(p).toString("utf8")) as Record<string, unknown>;
    const disc = await this.discovery();
    const iss = String(c.iss ?? "").replace(/\/+$/, "");
    if (iss !== disc.issuer.replace(/\/+$/, "") && iss !== this.cfg.issuer) throw new Error("ID token issuer mismatch");
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(this.cfg.clientId)) throw new Error("ID token audience mismatch");
    const nowSec = this.now() / 1000;
    if (typeof c.exp !== "number" || c.exp < nowSec - 60) throw new Error("ID token expired");
    if (c.nonce !== nonce) throw new Error("ID token nonce mismatch");
    return c;
  }

  /** Is this e-mail allowed into the console? */
  allowed(email: string): boolean {
    const e = email.toLowerCase();
    return this.cfg.allowedEmails.includes(e) || this.cfg.allowedDomains.includes(e.split("@")[1] ?? "");
  }

  /* ---------- flow ---------- */

  redirectUri(origin: string): string {
    return this.cfg.redirectUrl ?? `${origin}/admin/sso/callback`;
  }

  async loginRedirect(origin: string): Promise<{ location: string; cookie: string }> {
    const d = await this.discovery();
    const state = b64u(randomBytes(16));
    const nonce = b64u(randomBytes(16));
    const verifier = b64u(randomBytes(32));
    const challenge = b64u(createHash("sha256").update(verifier).digest());
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri(origin),
      scope: this.cfg.scopes,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    const flow = this.sign({ state, nonce, verifier, exp: this.now() + 10 * 60_000 });
    return { location: u.toString(), cookie: this.cookie("tk_oidc", flow, "/admin/sso", 600, origin.startsWith("https:")) };
  }

  async callback(query: URLSearchParams, cookieHeader: string | undefined, origin: string): Promise<{ ok: true; session: AdminSession; cookies: string[] } | { ok: false; error: string }> {
    const secure = origin.startsWith("https:");
    const clearFlow = this.cookie("tk_oidc", "", "/admin/sso", 0, secure);
    if (query.get("error")) return { ok: false, error: `${query.get("error")}: ${query.get("error_description") ?? ""}`.trim() };
    const flow = this.unsign<{ state: string; nonce: string; verifier: string; exp: number }>(parseCookies(cookieHeader).tk_oidc);
    if (!flow) return { ok: false, error: "login expired or cookie missing; start again" };
    if (!query.get("state") || query.get("state") !== flow.state) return { ok: false, error: "state mismatch" };
    const code = query.get("code");
    if (!code) return { ok: false, error: "no authorization code" };
    try {
      const d = await this.discovery();
      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri(origin), client_id: this.cfg.clientId, code_verifier: flow.verifier });
      if (this.cfg.clientSecret) form.set("client_secret", this.cfg.clientSecret);
      const r = await this.fetchImpl(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() });
      const tok = (await r.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
      if (!r.ok || !tok.id_token) return { ok: false, error: `token exchange failed: ${tok.error ?? r.status} ${tok.error_description ?? ""}`.trim() };
      const claims = await this.verifyIdToken(tok.id_token, flow.nonce);
      const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
      if (!email) return { ok: false, error: "the provider did not return an e-mail address (add the email scope)" };
      if (claims.email_verified === false) return { ok: false, error: `${email} is not verified at the provider` };
      if (!this.allowed(email)) return { ok: false, error: `${email} is not allowed. Ask an admin to add it to OIDC_ALLOWED_EMAILS or its domain to OIDC_ALLOWED_DOMAINS.` };
      const session: AdminSession = { email, name: typeof claims.name === "string" ? claims.name : undefined, exp: this.now() + this.cfg.sessionHours * 3600_000 };
      return { ok: true, session, cookies: [clearFlow, this.cookie("tk_admin", this.sign(session), "/admin", this.cfg.sessionHours * 3600, secure)] };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

/** Origin as the browser sees it (behind Caddy / ALB the scheme comes from X-Forwarded-Proto). */
export function requestOrigin(headers: Record<string, string | string[] | undefined>): string {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0].trim();
  const proto = one(headers["x-forwarded-proto"]) || "http";
  const host = one(headers["x-forwarded-host"]) || one(headers.host) || "localhost";
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
