import { describe, it, expect } from "vitest";
import http from "node:http";
import { Upstream } from "../src/upstream.js";

async function capture(up: Upstream): Promise<http.IncomingHttpHeaders> {
  let seen: http.IncomingHttpHeaders = {};
  const srv = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const target = new Upstream(`http://127.0.0.1:${port}/anthropic`, "us-east-1", up.authMode === "api-key" ? "ABSKtestkey" : undefined);
  await target.send("POST", "/v1/messages", { "anthropic-version": "2023-06-01" }, "{}", new AbortController().signal);
  srv.close();
  return seen;
}

describe("Upstream auth modes", () => {
  it("uses a Bedrock API key as bearer when provided", async () => {
    const h = await capture(new Upstream("http://x/anthropic", "us-east-1", "ABSKtestkey"));
    expect(h.authorization).toBe("Bearer ABSKtestkey");
    expect(h["x-amz-date"]).toBeUndefined();
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });
  it("falls back to SigV4 without a key", async () => {
    process.env.AWS_ACCESS_KEY_ID ||= "AKIATEST";
    process.env.AWS_SECRET_ACCESS_KEY ||= "secret";
    const h = await capture(new Upstream("http://x/anthropic", "us-east-1"));
    expect(String(h.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=.*\/bedrock-mantle\/aws4_request/);
    expect(h["x-amz-date"]).toBeDefined();
  });
  it("reports its mode", () => {
    expect(new Upstream("http://x/", "r", "k").authMode).toBe("api-key");
    expect(new Upstream("http://x/", "r", "  ").authMode).toBe("sigv4");
  });
});
