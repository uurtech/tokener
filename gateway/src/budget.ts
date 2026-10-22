/**
 * Per-developer daily limits. Two independent caps, both optional:
 *   - dailyBudgetUsd   : estimated spend (price table)
 *   - dailyTokenLimit  : total tokens = input + cache read + cache write + output
 * Either one being exceeded puts the developer in the "exceeded" state; what
 * happens next (warn / downgrade / block) is the policy's BUDGET_ACTION.
 */
import type { DeveloperRecord, DailyTotals } from "./store/types.js";

export interface BudgetState {
  exceeded: boolean;
  /** Which cap tripped first; undefined when nothing is exceeded. */
  reason?: "usd" | "tokens";
  spentUsd: number;
  limitUsd?: number;
  usedTokens: number;
  limitTokens?: number;
}

export function totalTokens(t: DailyTotals): number {
  return t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;
}

export function hasLimits(dev: DeveloperRecord): boolean {
  return (dev.dailyBudgetUsd !== undefined && dev.dailyBudgetUsd > 0) || (dev.dailyTokenLimit !== undefined && dev.dailyTokenLimit > 0);
}

export function evaluateBudget(dev: DeveloperRecord, totals: DailyTotals): BudgetState {
  const limitUsd = dev.dailyBudgetUsd && dev.dailyBudgetUsd > 0 ? dev.dailyBudgetUsd : undefined;
  const limitTokens = dev.dailyTokenLimit && dev.dailyTokenLimit > 0 ? dev.dailyTokenLimit : undefined;
  const usedTokens = totalTokens(totals);
  const state: BudgetState = { exceeded: false, spentUsd: totals.costUsd, limitUsd, usedTokens, limitTokens };
  if (limitUsd !== undefined && totals.costUsd >= limitUsd) {
    state.exceeded = true;
    state.reason = "usd";
  } else if (limitTokens !== undefined && usedTokens >= limitTokens) {
    state.exceeded = true;
    state.reason = "tokens";
  }
  return state;
}

/** Response headers that tell Claude Code (and curious developers) where they stand. */
export function budgetHeaders(b: BudgetState): Record<string, string> {
  const h: Record<string, string> = {
    "x-gateway-budget": b.limitUsd ? `${b.spentUsd.toFixed(2)}/${b.limitUsd.toFixed(2)}` : "none",
    "x-gateway-budget-tokens": b.limitTokens ? `${b.usedTokens}/${b.limitTokens}` : "none",
  };
  if (b.exceeded) h["x-gateway-budget-status"] = `exceeded:${b.reason}`;
  else {
    const warn = warningFor(b);
    if (warn) h["x-gateway-budget-status"] = `warning:${warn}`;
  }
  return h;
}

export const WARN_RATIO = 0.8;

/** "usd" | "tokens" when usage passed WARN_RATIO of a cap without exceeding it. */
export function warningFor(b: BudgetState): "usd" | "tokens" | undefined {
  if (b.limitUsd && b.spentUsd >= WARN_RATIO * b.limitUsd) return "usd";
  if (b.limitTokens && b.usedTokens >= WARN_RATIO * b.limitTokens) return "tokens";
  return undefined;
}

/** Human message for the 429 body when BUDGET_ACTION=block. */
export function budgetMessage(b: BudgetState): string {
  const what =
    b.reason === "tokens"
      ? `Daily gateway token limit exceeded (${b.usedTokens.toLocaleString("en-US")} of ${(b.limitTokens ?? 0).toLocaleString("en-US")} tokens)`
      : `Daily gateway budget exceeded ($${b.spentUsd.toFixed(2)} of $${(b.limitUsd ?? 0).toFixed(2)})`;
  return `${what}. Resets at 00:00 UTC.`;
}
