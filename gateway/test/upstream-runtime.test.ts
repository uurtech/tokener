import { describe, it, expect } from "vitest";
import { BedrockRuntimeUpstream, mapRuntimeError, sseFromRuntimeEvents, toRuntimeBody, toRuntimeModelId, type RuntimeClientLike, type RuntimeStreamEvent } from "../src/upstream-runtime.js";
import { SseUsageTap } from "../src/sse.js";
import { Readable } from "node:stream";

const enc = (o: unknown) => ({ chunk: { bytes: new TextEncoder().encode(JSON.stringify(o)) } });
async function* gen(items: RuntimeStreamEvent[]) {
  for (const i of items) yield i;
}
async function collect(it: AsyncIterable<string>) {
  let s = "";
  for await (const c of it) s += c;
  return s;
}

describe("toRuntimeModelId", () => {
  const cat = [
    { id: "anthropic.claude-opus-5-5", name: "Opus 5.5", status: "ACTIVE", streaming: true, inferenceTypes: ["INFERENCE_PROFILE"], inputModalities: [], outputModalities: [], profiles: ["global.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5"] },
    { id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Haiku 4.5", status: "ACTIVE", streaming: true, inferenceTypes: ["INFERENCE_PROFILE"], inputModalities: [], outputModalities: [], profiles: ["global.anthropic.claude-haiku-4-5-20251001-v1:0", "us.anthropic.claude-haiku-4-5-20251001-v1:0"] },
    { id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Sonnet 4", status: "LEGACY", streaming: true, inferenceTypes: ["ON_DEMAND", "INFERENCE_PROFILE"], inputModalities: [], outputModalities: [], profiles: ["us.anthropic.claude-sonnet-4-20250514-v1:0"] },
  ];
  it("passes prefixed ids through", () => {
    expect(toRuntimeModelId("global.anthropic.claude-opus-5-5", "us", cat)).toBe("global.anthropic.claude-opus-5-5");
  });
  it("picks the profile with the operator prefix for exact catalog ids", () => {
    expect(toRuntimeModelId("anthropic.claude-opus-5-5", "us", cat)).toBe("us.anthropic.claude-opus-5-5");
    expect(toRuntimeModelId("anthropic.claude-opus-5-5", "global", cat)).toBe("global.anthropic.claude-opus-5-5");
  });
  it("maps short Mantle ids to the dated Runtime id and its profile", () => {
    expect(toRuntimeModelId("anthropic.claude-haiku-4-5", "us", cat)).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(toRuntimeModelId("anthropic.claude-haiku-4-5", "", cat)).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
  });
  it("falls back sensibly when the preferred prefix has no profile", () => {
    expect(toRuntimeModelId("anthropic.claude-opus-5-5", "eu", cat)).toBe("global.anthropic.claude-opus-5-5"); // first profile, sorted
    expect(toRuntimeModelId("anthropic.claude-sonnet-4", "eu", cat)).toBe("anthropic.claude-sonnet-4-20250514-v1:0"); // ON_DEMAND -> bare id
  });
  it("trusts the prefix when the catalog is empty or does not know the model", () => {
    expect(toRuntimeModelId("anthropic.claude-opus-5-5", "us")).toBe("us.anthropic.claude-opus-5-5");
    expect(toRuntimeModelId("anthropic.claude-future-9", "us", cat)).toBe("us.anthropic.claude-future-9");
    expect(toRuntimeModelId("anthropic.claude-future-9", "", cat)).toBe("anthropic.claude-future-9");
  });
});

describe("toRuntimeBody", () => {
  it("drops model/stream/metadata, adds anthropic_version and merges betas", () => {
    const b = toRuntimeBody(
      { model: "x", stream: true, metadata: { user_id: "u" }, max_tokens: 5, messages: [], anthropic_beta: ["a"] },
      "interleaved-thinking-2025-05-14, a",
    );
    expect(b).toEqual({ max_tokens: 5, messages: [], anthropic_version: "bedrock-2023-05-31", anthropic_beta: ["a", "interleaved-thinking-2025-05-14"] });
    expect(toRuntimeBody({ max_tokens: 1 }, undefined)).toEqual({ max_tokens: 1, anthropic_version: "bedrock-2023-05-31" });
  });
});

describe("mapRuntimeError", () => {
  it("maps SDK exception names to Anthropic error types", () => {
    expect(mapRuntimeError("ThrottlingException")).toEqual({ status: 429, type: "rate_limit_error" });
    expect(mapRuntimeError("ValidationException")).toEqual({ status: 400, type: "invalid_request_error" });
    expect(mapRuntimeError("AccessDeniedException")).toEqual({ status: 403, type: "permission_error" });
    expect(mapRuntimeError("ServiceUnavailableException")).toEqual({ status: 529, type: "overloaded_error" });
    expect(mapRuntimeError("Weird", 418)).toEqual({ status: 418, type: "api_error" });
    expect(mapRuntimeError(undefined)).toEqual({ status: 502, type: "api_error" });
  });
});

describe("sseFromRuntimeEvents", () => {
  it("re-serialises chunks as SSE that the usage tap understands", async () => {
    const events = [
      enc({ type: "message_start", message: { id: "m", model: "us.anthropic.claude-opus-5-5", usage: { input_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
      enc({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      enc({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
      enc({ type: "message_stop", "amazon-bedrock-invocationMetrics": { inputTokenCount: 100 } }),
    ];
    const text = await collect(sseFromRuntimeEvents(gen(events)));
    expect(text.startsWith("event: message_start\ndata: {")).toBe(true);
    expect(text.split("\n\n").filter(Boolean)).toHaveLength(4);
    const tap = new SseUsageTap();
    await new Promise<void>((r) => Readable.from([Buffer.from(text)]).pipe(tap).on("finish", r).resume());
    expect(tap.summary.usage).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 500, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });
    expect(tap.summary.sawMessageStop).toBe(true);
  });
  it("turns a mid-stream exception into a terminal error event", async () => {
    const text = await collect(sseFromRuntimeEvents(gen([enc({ type: "message_start", message: {} }), { modelStreamErrorException: { message: "boom", originalStatusCode: 503, originalMessage: "capacity" } } as RuntimeStreamEvent])));
    const last = text.trim().split("\n\n").at(-1)!;
    expect(last.startsWith("event: error\n")).toBe(true);
    expect(JSON.parse(last.split("\ndata: ")[1])).toMatchObject({ type: "error", error: { type: "api_error", message: "ModelStreamErrorException: capacity" } });
  });
});

describe("BedrockRuntimeUpstream", () => {
  const seen: { modelId: string; body: Record<string, unknown> }[] = [];
  const fake: RuntimeClientLike = {
    async invoke(modelId, body) {
      seen.push({ modelId, body: JSON.parse(new TextDecoder().decode(body)) });
      if (modelId.includes("denied")) {
        const e = Object.assign(new Error("not authorized"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403, requestId: "rq1" } });
        throw e;
      }
      return { body: new TextEncoder().encode(JSON.stringify({ id: "msg", type: "message", usage: { input_tokens: 3, output_tokens: 2 } })), requestId: "rq2" };
    },
    async invokeStream(modelId, body) {
      seen.push({ modelId, body: JSON.parse(new TextDecoder().decode(body)) });
      return { events: gen([enc({ type: "message_start", message: {} }), enc({ type: "message_stop" })]), requestId: "rq3" };
    },
    async countTokens() {
      return { inputTokens: 42, requestId: "rq4" };
    },
  };
  const up = new BedrockRuntimeUpstream(fake, "fake");

  it("non-stream: returns the JSON body with request id", async () => {
    const r = await up.messages("us.anthropic.claude-opus-5-5", { model: "anthropic.claude-opus-5-5", stream: false, max_tokens: 1, messages: [] }, "b1", false, new AbortController().signal);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-amzn-requestid")).toBe("rq2");
    expect((await r.json()).usage.output_tokens).toBe(2);
    expect(seen.at(-1)!.body).toMatchObject({ anthropic_version: "bedrock-2023-05-31", anthropic_beta: ["b1"] });
    expect(seen.at(-1)!.body.model).toBeUndefined();
  });
  it("stream: returns text/event-stream with converted events", async () => {
    const r = await up.messages("us.anthropic.claude-opus-5-5", { stream: true, max_tokens: 1, messages: [] }, undefined, true, new AbortController().signal);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain("event: message_start");
    expect(text.trim().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });
  it("service exceptions become Anthropic-shaped error responses", async () => {
    const r = await up.messages("us.anthropic.denied", { max_tokens: 1, messages: [] }, undefined, false, new AbortController().signal);
    expect(r.status).toBe(403);
    expect(r.headers.get("x-amzn-errortype")).toBe("AccessDeniedException");
    expect(await r.json()).toEqual({ type: "error", request_id: "rq1", error: { type: "permission_error", message: "not authorized" } });
  });
  it("count_tokens answers in Anthropic shape", async () => {
    const r = await up.countTokens("us.anthropic.claude-opus-5-5", { messages: [] }, undefined, new AbortController().signal);
    expect(await r.json()).toEqual({ input_tokens: 42 });
  });
});
