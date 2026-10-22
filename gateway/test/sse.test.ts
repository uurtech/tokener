import { describe, it, expect } from "vitest";
import { SseUsageTap, applyEvent, summaryFromMessage } from "../src/sse.js";
import { estimateCostUsd, priceKey, usageFromApi } from "../src/pricing.js";

const events = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"anthropic.claude-opus-5-5","usage":{"input_tokens":1200,"cache_read_input_tokens":54000,"cache_creation_input_tokens":5000,"cache_creation":{"ephemeral_5m_input_tokens":5000,"ephemeral_1h_input_tokens":0},"output_tokens":1}}}\n\n`,
  `event: ping\ndata: {"type":"ping"}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":812}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

describe("SseUsageTap", () => {
  it("passes bytes through untouched and extracts usage even when chunks split events", async () => {
    const tap = new SseUsageTap();
    const out: Buffer[] = [];
    tap.on("data", (c: Buffer) => out.push(c));
    const whole = events.join("");
    // feed in awkward 7-byte chunks
    for (let i = 0; i < whole.length; i += 7) tap.write(Buffer.from(whole.slice(i, i + 7)));
    tap.end();
    await new Promise((r) => tap.on("end", r));
    expect(Buffer.concat(out).toString()).toBe(whole);
    expect(tap.summary.usage).toEqual({ inputTokens: 1200, outputTokens: 812, cacheReadTokens: 54000, cacheWrite5mTokens: 5000, cacheWrite1hTokens: 0 });
    expect(tap.summary.model).toBe("anthropic.claude-opus-5-5");
    expect(tap.summary.stopReason).toBe("end_turn");
    expect(tap.summary.sawMessageStop).toBe(true);
  });
  it("records error events", () => {
    const s = { usage: usageFromApi(undefined), sawMessageStop: false };
    applyEvent(s, { type: "error", error: { type: "overloaded_error", message: "x" } });
    expect(s.errorType).toBe("overloaded_error");
  });
});

describe("pricing", () => {
  it("normalises model ids", () => {
    expect(priceKey("anthropic.claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(priceKey("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4-5");
    expect(priceKey("claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5");
  });
  it("prices a typical Opus 5.5 agent turn", () => {
    const u = { inputTokens: 1000, outputTokens: 800, cacheReadTokens: 54000, cacheWrite5mTokens: 5000, cacheWrite1hTokens: 0 };
    // 1000*4 + 800*20 + 54000*0.2 + 5000*5 = 4000+16000+10800+25000 = 55800 / 1e6
    expect(estimateCostUsd("anthropic.claude-opus-5-5", u)).toBeCloseTo(0.0558, 6);
    expect(estimateCostUsd("anthropic.claude-unknown", u)).toBe(0);
  });
  it("reads non-streaming usage", () => {
    const s = summaryFromMessage({ model: "anthropic.claude-haiku-4-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
    expect(s.usage.inputTokens).toBe(10);
    expect(s.usage.outputTokens).toBe(5);
  });
});
