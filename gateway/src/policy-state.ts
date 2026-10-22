/**
 * The runtime-editable part of the configuration. Persisted by the store so the
 * admin UI can change behaviour without a redeploy. Static infrastructure settings
 * (port, tables, upstream URL) stay in Config and are not editable at runtime.
 */
import type { Config, EffortMode, BudgetAction, UpstreamMode } from "./config.js";
import { isModelPrice, priceKey, type ModelPrice } from "./pricing.js";

export interface Policy {
  /** Which Bedrock API to call: Mantle Messages endpoint or classic Runtime InvokeModel. */
  upstreamMode: UpstreamMode;
  /** Inference-profile prefix used in runtime mode ("" = bare model ids). */
  bedrockProfilePrefix: string;
  modelMap: Record<string, string>;
  routeSubagentModel: string;
  routeAuxiliaryModel: string;
  routeCompactionModel: string;
  effortMode: EffortMode;
  defaultEffort: string;
  operatorPrompt: string;
  cacheTtl1h: boolean;
  toolResultMaxChars: number;
  bridgeBedrock: boolean;
  budgetAction: BudgetAction;
  downgradeModel: string;
  /** Applied to developers created from the admin UI without an explicit value. 0 = no cap. */
  defaultDailyBudgetUsd: number;
  defaultDailyTokenLimit: number;
  /** Price overrides edited in the admin UI, keyed by normalised model key (claude-opus-5-5). USD per million tokens. */
  pricing: Record<string, ModelPrice>;
  updatedAt?: string;
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const PROFILE_PREFIXES = ["us", "global", "eu", "apac", ""] as const;

export function policyFromConfig(cfg: Config): Policy {
  return {
    upstreamMode: cfg.upstreamMode,
    bedrockProfilePrefix: cfg.bedrockProfilePrefix,
    modelMap: { ...cfg.modelMap },
    routeSubagentModel: cfg.routeSubagentModel ?? "",
    routeAuxiliaryModel: cfg.routeAuxiliaryModel ?? "",
    routeCompactionModel: cfg.routeCompactionModel ?? "",
    effortMode: cfg.effortMode,
    defaultEffort: cfg.defaultEffort ?? "high",
    operatorPrompt: cfg.operatorPrompt ?? "",
    cacheTtl1h: cfg.cacheTtl1h,
    toolResultMaxChars: cfg.toolResultMaxChars,
    bridgeBedrock: cfg.bridgeBedrock,
    budgetAction: cfg.budgetAction,
    downgradeModel: cfg.downgradeModel ?? "anthropic.claude-sonnet-5-5",
    defaultDailyBudgetUsd: 25,
    defaultDailyTokenLimit: 0,
    pricing: {},
  };
}

/** Merge a policy over the static config to get the effective per-request config. */
export function effectiveConfig(cfg: Config, p: Policy): Config {
  const blank = (s: string) => (s.trim() === "" ? undefined : s.trim());
  return {
    ...cfg,
    upstreamMode: p.upstreamMode ?? cfg.upstreamMode,
    bedrockProfilePrefix: p.bedrockProfilePrefix ?? cfg.bedrockProfilePrefix,
    modelMap: p.modelMap,
    routeSubagentModel: blank(p.routeSubagentModel),
    routeAuxiliaryModel: blank(p.routeAuxiliaryModel),
    routeCompactionModel: blank(p.routeCompactionModel),
    effortMode: p.effortMode,
    defaultEffort: blank(p.defaultEffort),
    operatorPrompt: blank(p.operatorPrompt),
    cacheTtl1h: p.cacheTtl1h,
    toolResultMaxChars: p.toolResultMaxChars,
    bridgeBedrock: p.bridgeBedrock,
    budgetAction: p.budgetAction,
    downgradeModel: blank(p.downgradeModel),
  };
}

/** Validate a user-supplied policy (from the admin UI). Returns error messages. */
export function validatePolicy(p: unknown): { ok: true; policy: Policy } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["policy must be an object"] };
  const o = p as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : (errors.push(`${k} must be a string`), ""));
  const bool = (k: string) => (typeof o[k] === "boolean" ? (o[k] as boolean) : (errors.push(`${k} must be a boolean`), false));
  const num = (k: string, min: number, max: number) => {
    const v = Number(o[k]);
    if (!Number.isFinite(v) || v < min || v > max) errors.push(`${k} must be a number between ${min} and ${max}`);
    return v;
  };
  const effortMode = str("effortMode") as EffortMode;
  if (!["off", "fill", "override"].includes(effortMode)) errors.push("effortMode must be off|fill|override");
  const defaultEffort = str("defaultEffort");
  if (!(EFFORT_LEVELS as readonly string[]).includes(defaultEffort)) errors.push(`defaultEffort must be one of ${EFFORT_LEVELS.join("|")}`);
  const budgetAction = str("budgetAction") as BudgetAction;
  if (!["warn", "downgrade", "block"].includes(budgetAction)) errors.push("budgetAction must be warn|downgrade|block");
  const modelMap = o.modelMap;
  if (!modelMap || typeof modelMap !== "object" || Array.isArray(modelMap) || Object.values(modelMap as object).some((v) => typeof v !== "string"))
    errors.push("modelMap must be an object of string -> string");
  const upstreamMode = (o.upstreamMode === undefined ? "mantle" : str("upstreamMode")) as UpstreamMode;
  if (!["mantle", "runtime"].includes(upstreamMode)) errors.push("upstreamMode must be mantle|runtime");
  const bedrockProfilePrefix = o.bedrockProfilePrefix === undefined ? "us" : str("bedrockProfilePrefix").trim();
  if (!(PROFILE_PREFIXES as readonly string[]).includes(bedrockProfilePrefix)) errors.push(`bedrockProfilePrefix must be one of ${PROFILE_PREFIXES.filter(Boolean).join("|")} or empty`);
  const policy: Policy = {
    upstreamMode,
    bedrockProfilePrefix,
    modelMap: (modelMap as Record<string, string>) ?? {},
    routeSubagentModel: str("routeSubagentModel"),
    routeAuxiliaryModel: str("routeAuxiliaryModel"),
    routeCompactionModel: str("routeCompactionModel"),
    effortMode,
    defaultEffort,
    operatorPrompt: str("operatorPrompt"),
    cacheTtl1h: bool("cacheTtl1h"),
    toolResultMaxChars: num("toolResultMaxChars", 0, 10_000_000),
    bridgeBedrock: bool("bridgeBedrock"),
    budgetAction,
    downgradeModel: str("downgradeModel"),
    defaultDailyBudgetUsd: num("defaultDailyBudgetUsd", 0, 100_000),
    defaultDailyTokenLimit: o.defaultDailyTokenLimit === undefined ? 0 : num("defaultDailyTokenLimit", 0, 1e12),
    pricing: validatePricing(o.pricing, errors),
    updatedAt: new Date().toISOString(),
  };
  if (policy.operatorPrompt.length > 4000) errors.push("operatorPrompt must be under 4000 characters");
  return errors.length ? { ok: false, errors } : { ok: true, policy };
}

/** Pricing overrides: object of model key -> ModelPrice. Keys are normalised; invalid entries are reported. */
export function validatePricing(v: unknown, errors: string[]): Record<string, ModelPrice> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    errors.push("pricing must be an object of model -> {input, output, cacheWrite5m, cacheWrite1h, cacheRead}");
    return {};
  }
  const out: Record<string, ModelPrice> = {};
  for (const [k, price] of Object.entries(v as Record<string, unknown>)) {
    if (!isModelPrice(price)) {
      errors.push(`pricing.${k} must have non-negative numbers input, output, cacheWrite5m, cacheWrite1h, cacheRead`);
      continue;
    }
    out[priceKey(k)] = { input: price.input, output: price.output, cacheWrite5m: price.cacheWrite5m, cacheWrite1h: price.cacheWrite1h, cacheRead: price.cacheRead };
  }
  return out;
}
