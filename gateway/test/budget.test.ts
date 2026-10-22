import { describe, it, expect } from "vitest";
import { evaluateBudget, budgetHeaders, budgetMessage, hasLimits, totalTokens, warningFor } from "../src/budget.js";
import type { DailyTotals, DeveloperRecord } from "../src/store/types.js";

const dev = (over: Partial<DeveloperRecord> = {}): DeveloperRecord => ({ developerId: "alice", keyHash: "h", enabled: true, ...over });
const totals = (over: Partial<DailyTotals> = {}): DailyTotals => ({ requests: 10, costUsd: 0, savedUsd: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...over });

describe("budget", () => {
  it("has no limits when both caps are unset or zero", () => {
    expect(hasLimits(dev())).toBe(false);
    expect(hasLimits(dev({ dailyBudgetUsd: 0, dailyTokenLimit: 0 }))).toBe(false);
    expect(hasLimits(dev({ dailyTokenLimit: 1 }))).toBe(true);
  });

  it("sums all four token counters", () => {
    expect(totalTokens(totals({ inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4 }))).toBe(10);
  });

  it("trips on USD first, then on tokens", () => {
    const d = dev({ dailyBudgetUsd: 10, dailyTokenLimit: 1_000_000 });
    expect(evaluateBudget(d, totals({ costUsd: 9.99, inputTokens: 999_999 })).exceeded).toBe(false);
    const usd = evaluateBudget(d, totals({ costUsd: 10 }));
    expect(usd).toMatchObject({ exceeded: true, reason: "usd", spentUsd: 10, limitUsd: 10 });
    const tok = evaluateBudget(d, totals({ costUsd: 1, cacheReadTokens: 1_000_000 }));
    expect(tok).toMatchObject({ exceeded: true, reason: "tokens", usedTokens: 1_000_000, limitTokens: 1_000_000 });
    expect(budgetMessage(tok)).toContain("token limit exceeded (1,000,000 of 1,000,000 tokens)");
    expect(budgetMessage(usd)).toContain("budget exceeded ($10.00 of $10.00)");
  });

  it("token-only developers ignore cost", () => {
    const b = evaluateBudget(dev({ dailyTokenLimit: 500 }), totals({ costUsd: 999, outputTokens: 100 }));
    expect(b.exceeded).toBe(false);
    expect(b.limitUsd).toBeUndefined();
    expect(budgetHeaders(b)).toMatchObject({ "x-gateway-budget": "none", "x-gateway-budget-tokens": "100/500" });
  });

  it("emits a warning header at 80% and an exceeded header past the cap", () => {
    const d = dev({ dailyBudgetUsd: 10, dailyTokenLimit: 1000 });
    expect(warningFor(evaluateBudget(d, totals({ costUsd: 7.9 })))).toBeUndefined();
    expect(budgetHeaders(evaluateBudget(d, totals({ costUsd: 8 })))["x-gateway-budget-status"]).toBe("warning:usd");
    expect(budgetHeaders(evaluateBudget(d, totals({ inputTokens: 800 })))["x-gateway-budget-status"]).toBe("warning:tokens");
    expect(budgetHeaders(evaluateBudget(d, totals({ inputTokens: 1000 })))["x-gateway-budget-status"]).toBe("exceeded:tokens");
    expect(budgetHeaders(evaluateBudget(d, totals()))["x-gateway-budget-status"]).toBeUndefined();
  });
});
