import { describe, it, expect, afterEach } from "vitest";
import { estimateCostUsd, isModelPrice, priceFor, pricingTable, setPolicyPricing } from "../src/pricing.js";
import { validatePricing } from "../src/policy-state.js";

afterEach(() => setPolicyPricing(undefined));

describe("pricing overrides", () => {
  it("policy overrides layer on top of the base table and can be cleared", () => {
    expect(priceFor("anthropic.claude-mystery-9")).toBeUndefined();
    setPolicyPricing({ "claude-mystery-9": { input: 1, output: 2, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 } });
    expect(priceFor("us.anthropic.claude-mystery-9-20260101-v1:0")?.output).toBe(2);
    expect(estimateCostUsd("anthropic.claude-mystery-9", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 })).toBe(1);
    setPolicyPricing({ "claude-opus-5-5": { input: 99, output: 99, cacheWrite5m: 99, cacheWrite1h: 99, cacheRead: 99 } });
    expect(priceFor("anthropic.claude-opus-5-5")?.input).toBe(99);
    expect(priceFor("anthropic.claude-mystery-9")).toBeUndefined(); // previous layer replaced
    setPolicyPricing(undefined);
    expect(priceFor("anthropic.claude-opus-5-5")?.input).toBe(4);
    expect(Object.keys(pricingTable()).length).toBeGreaterThan(5);
  });
  it("validates shapes and normalises keys", () => {
    const errors: string[] = [];
    const out = validatePricing({ "us.anthropic.claude-x-1-20260101-v1:0": { input: 1, output: 2, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 0 }, bad: { input: -1 } }, errors);
    expect(Object.keys(out)).toEqual(["claude-x-1"]);
    expect(errors).toHaveLength(1);
    expect(isModelPrice({ input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 })).toBe(true);
    expect(isModelPrice({ input: 1 })).toBe(false);
    expect(validatePricing([], errors)).toEqual({});
  });
});
