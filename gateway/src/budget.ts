/**
 * Per-developer limits, all optional and independent:
 *   - dailyBudgetUsd / monthlyBudgetUsd     : estimated spend (price table)
 *   - dailyTokenLimit / monthlyTokenLimit   : total tokens = input + cache read + cache write + output
 * Days and months are UTC. Any one being exceeded puts the developer in the "exceeded" state; what
 * happens next (warn / downgrade / block) is the policy's BUDGET_ACTION.
 */
import type { DeveloperRecord, DailyTotals } from "./store/types.js";

export interface BudgetState {
  exceeded: boolean;
  /** Which cap tripped first; undefined when nothing is exceeded. */
  reason?: "usd" | "tokens" | "month_usd" | "month_tokens";
  spentUsd: number;
  limitUsd?: number;
  usedTokens: number;
  limitTokens?: number;
  /** Present when the developer has a monthly cap. */
  month?: { spentUsd: number; limitUsd?: number; usedTokens: number; limitTokens?: number };
}

export function totalTokens(t: DailyTotals): number {
  return t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;
}

export function hasMonthlyLimits(dev: DeveloperRecord): boolean {
  return (dev.monthlyBudgetUsd ?? 0) > 0 || (dev.monthlyTokenLimit ?? 0) > 0;
}

export function hasLimits(dev: DeveloperRecord): boolean {
  return (dev.dailyBudgetUsd !== undefined && dev.dailyBudgetUsd > 0) || (dev.dailyTokenLimit !== undefined && dev.dailyTokenLimit > 0) || hasMonthlyLimits(dev);
}

export function evaluateBudget(dev: DeveloperRecord, totals: DailyTotals, month?: DailyTotals): BudgetState {
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
  if (month && hasMonthlyLimits(dev)) {
    const m = {
      spentUsd: month.costUsd,
      limitUsd: (dev.monthlyBudgetUsd ?? 0) > 0 ? dev.monthlyBudgetUsd : undefined,
      usedTokens: totalTokens(month),
      limitTokens: (dev.monthlyTokenLimit ?? 0) > 0 ? dev.monthlyTokenLimit : undefined,
    };
    state.month = m;
    if (!state.exceeded && m.limitUsd !== undefined && m.spentUsd >= m.limitUsd) {
      state.exceeded = true;
      state.reason = "month_usd";
    } else if (!state.exceeded && m.limitTokens !== undefined && m.usedTokens >= m.limitTokens) {
      state.exceeded = true;
      state.reason = "month_tokens";
    }
  }
  return state;
}

/** Response headers that tell Claude Code (and curious developers) where they stand. */
export function budgetHeaders(b: BudgetState): Record<string, string> {
  const h: Record<string, string> = {
    "x-gateway-budget": b.limitUsd ? `${b.spentUsd.toFixed(2)}/${b.limitUsd.toFixed(2)}` : "none",
    "x-gateway-budget-tokens": b.limitTokens ? `${b.usedTokens}/${b.limitTokens}` : "none",
  };
  if (b.month?.limitUsd) h["x-gateway-budget-month"] = `${b.month.spentUsd.toFixed(2)}/${b.month.limitUsd.toFixed(2)}`;
  if (b.month?.limitTokens) h["x-gateway-budget-month-tokens"] = `${b.month.usedTokens}/${b.month.limitTokens}`;
  if (b.exceeded) h["x-gateway-budget-status"] = `exceeded:${b.reason}`;
  else {
    const warn = warningFor(b);
    if (warn) h["x-gateway-budget-status"] = `warning:${warn}`;
  }
  return h;
}

export const WARN_RATIO = 0.8;

/** Which cap passed WARN_RATIO without being exceeded. */
export function warningFor(b: BudgetState): "usd" | "tokens" | "month_usd" | "month_tokens" | undefined {
  if (b.limitUsd && b.spentUsd >= WARN_RATIO * b.limitUsd) return "usd";
  if (b.limitTokens && b.usedTokens >= WARN_RATIO * b.limitTokens) return "tokens";
  if (b.month?.limitUsd && b.month.spentUsd >= WARN_RATIO * b.month.limitUsd) return "month_usd";
  if (b.month?.limitTokens && b.month.usedTokens >= WARN_RATIO * b.month.limitTokens) return "month_tokens";
  return undefined;
}

/** Human message for the 429 body when BUDGET_ACTION=block. */
export function budgetMessage(b: BudgetState): string {
  const n = (v: number | undefined) => (v ?? 0).toLocaleString("en-US");
  const usd = (v: number | undefined) => "$" + (v ?? 0).toFixed(2);
  if (b.reason === "month_usd") return `Monthly gateway budget exceeded (${usd(b.month?.spentUsd)} of ${usd(b.month?.limitUsd)}). Resets on the 1st at 00:00 UTC.`;
  if (b.reason === "month_tokens") return `Monthly gateway token limit exceeded (${n(b.month?.usedTokens)} of ${n(b.month?.limitTokens)} tokens). Resets on the 1st at 00:00 UTC.`;
  const what =
    b.reason === "tokens"
      ? `Daily gateway token limit exceeded (${n(b.usedTokens)} of ${n(b.limitTokens)} tokens)`
      : `Daily gateway budget exceeded (${usd(b.spentUsd)} of ${usd(b.limitUsd)})`;
  return `${what}. Resets at 00:00 UTC.`;
}
