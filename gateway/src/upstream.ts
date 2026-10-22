/**
 * SigV4-signed forwarding to the Bedrock Messages endpoint
 * (https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages).
 * We deliberately use raw HTTP rather than an SDK client: a gateway must forward
 * unknown fields and beta headers byte-for-byte, which a typed client would drop.
 */
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const FORWARD_REQUEST_HEADERS = ["anthropic-version", "anthropic-beta", "accept"];
const FORWARD_REQUEST_PREFIXES = ["x-amzn-bedrock-"];

const FORWARD_RESPONSE_HEADERS = ["content-type", "retry-after", "x-should-retry", "request-id", "x-amzn-requestid", "x-amzn-errortype"];
const FORWARD_RESPONSE_PREFIXES = ["anthropic-ratelimit-"];

export class Upstream {
  private readonly signer: SignatureV4;
  private readonly base: URL;
  private readonly bearer?: string;

  /**
   * @param bearerToken Bedrock API key (AWS_BEARER_TOKEN_BEDROCK). When set, requests carry
   *   `Authorization: Bearer <key>` instead of a SigV4 signature; the AWS SDK clients used elsewhere
   *   honour the same variable automatically, so one key covers every upstream.
   */
  constructor(baseUrl: string, region: string, bearerToken?: string) {
    this.base = new URL(baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
    this.bearer = bearerToken?.trim() || undefined;
    this.signer = new SignatureV4({
      service: "bedrock-mantle",
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }

  get authMode(): "api-key" | "sigv4" {
    return this.bearer ? "api-key" : "sigv4";
  }

  /** Build the upstream URL for a Claude-Code path like "/v1/messages?beta=true". */
  url(pathWithQuery: string): URL {
    const rel = pathWithQuery.replace(/^\/+/, "");
    return new URL(rel, this.base);
  }

  pickRequestHeaders(incoming: Record<string, string | string[] | undefined>, betaOverride: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (v === undefined) continue;
      const lk = k.toLowerCase();
      const val = Array.isArray(v) ? v.join(",") : v;
      if (FORWARD_REQUEST_HEADERS.includes(lk) || FORWARD_REQUEST_PREFIXES.some((p) => lk.startsWith(p))) out[lk] = val;
    }
    if (betaOverride !== undefined) out["anthropic-beta"] = betaOverride;
    else delete out["anthropic-beta"];
    if (!out["anthropic-version"]) out["anthropic-version"] = "2023-06-01";
    return out;
  }

  /**
   * @param headersTimeoutMs Abort if upstream has not answered with headers within this time.
   *   Once headers arrive the timer is cleared, so long streaming turns are never cut.
   */
  async send(method: string, pathWithQuery: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal, headersTimeoutMs = 0): Promise<Response> {
    const url = this.url(pathWithQuery);
    const h: Record<string, string> = {};
    if (this.bearer) {
      Object.assign(h, { "content-type": "application/json", ...headers, authorization: `Bearer ${this.bearer}` });
    } else {
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const req = new HttpRequest({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        query,
        headers: { host: url.host, "content-type": "application/json", ...headers },
        body,
      });
      const signed = await this.signer.sign(req);
      for (const [k, v] of Object.entries(signed.headers)) if (k.toLowerCase() !== "host") h[k] = v;
    }
    if (headersTimeoutMs <= 0) return fetch(url, { method, headers: h, body, signal, redirect: "manual" });
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error(`upstream did not respond within ${headersTimeoutMs} ms`)), headersTimeoutMs);
    try {
      return await fetch(url, { method, headers: h, body, signal: AbortSignal.any([signal, timer.signal]), redirect: "manual" });
    } finally {
      clearTimeout(t);
    }
  }

  pickResponseHeaders(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (FORWARD_RESPONSE_HEADERS.includes(lk) || FORWARD_RESPONSE_PREFIXES.some((p) => lk.startsWith(p))) out[lk] = v;
    });
    return out;
  }
}
