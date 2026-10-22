/**
 * Gateway configuration. Everything comes from environment variables so the
 * same container image can be deployed with different policies.
 */

export type EffortMode = "off" | "fill" | "override";
export type BudgetAction = "warn" | "downgrade" | "block";
/** mantle = Anthropic Messages API on Bedrock (bedrock-mantle endpoint); runtime = classic Bedrock Runtime InvokeModel. */
export type UpstreamMode = "mantle" | "runtime";

export interface Config {
  port: number;
  awsRegion: string;
  /** Which Bedrock API carries requests. Runtime-editable from the admin UI. */
  upstreamMode: UpstreamMode;
  /** Base URL of the Bedrock Messages API endpoint, without the trailing /v1. */
  upstreamBaseUrl: string;
  /** Inference-profile prefix for runtime mode ("us", "global", "eu", "apac" or "" for bare ids). */
  bedrockProfilePrefix: string;
  /** Override for the Bedrock Runtime endpoint (tests / PrivateLink). Empty = SDK default. */
  bedrockRuntimeEndpoint: string;
  keysTable: string;
  usageTable: string;
  metricsNamespace: string;
  keyCacheTtlMs: number;
  maxBodyBytes: number;
  /** Max time to wait for upstream response headers (first byte). Streaming bodies are not limited. */
  upstreamTimeoutMs: number;
  /** Live Bedrock model catalog (ListFoundationModels + ListInferenceProfiles). */
  modelCatalogEnabled: boolean;
  modelCatalogTtlMs: number;

  /** Anthropic model id (as Claude Code sends it) -> Bedrock model id. */
  modelMap: Record<string, string>;
  /** Routing by `x-claude-code-request-class`. Values are Bedrock model ids. */
  routeSubagentModel?: string;
  routeAuxiliaryModel?: string;
  routeCompactionModel?: string;

  effortMode: EffortMode;
  defaultEffort?: string;

  /** Appended as the LAST system block of every request (never prepended). */
  operatorPrompt?: string;

  cacheTtl1h: boolean;
  cacheTtlBeta: string;

  /** 0 disables. Deterministic head/tail truncation of oversized tool_result text. */
  toolResultMaxChars: number;

  /** Remove fields/betas that Bedrock's Messages endpoint rejects. */
  bridgeBedrock: boolean;
  bridgeStripBetas: string[];

  budgetAction: BudgetAction;
  downgradeModel?: string;
}

export const DEFAULT_MODEL_MAP: Record<string, string> = {
  "claude-fable-5-1": "anthropic.claude-fable-5-1",
  "claude-fable-5": "anthropic.claude-fable-5",
  "claude-opus-5-5": "anthropic.claude-opus-5-5",
  "claude-opus-5": "anthropic.claude-opus-5",
  "claude-opus-4-8": "anthropic.claude-opus-4-8",
  "claude-opus-4-7": "anthropic.claude-opus-4-7",
  "claude-sonnet-5-5": "anthropic.claude-sonnet-5-5",
  "claude-sonnet-5": "anthropic.claude-sonnet-5",
  "claude-haiku-4-5": "anthropic.claude-haiku-4-5",
  "claude-haiku-4-5-20251001": "anthropic.claude-haiku-4-5",
};

const DEFAULT_STRIP_BETAS = [
  "context-management",
  "structured-outputs",
  "task-budgets",
  "advisor",
  "fast-mode",
  "files-api",
  "mcp-client",
  "code-execution",
  "web-search",
  "web-fetch",
  "skills",
  "cache-diagnosis",
  "fine-grained-tool-streaming",
];

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = env(name, fallback) as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${v}"`);
  return v;
}

function envJson<T>(name: string, fallback: T): T {
  const v = env(name);
  if (v === undefined) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch (e) {
    throw new Error(`${name} must be valid JSON: ${(e as Error).message}`);
  }
}

export function loadConfig(): Config {
  const awsRegion = env("AWS_REGION", env("AWS_DEFAULT_REGION", "us-east-1"))!;
  const modelMap = { ...DEFAULT_MODEL_MAP, ...envJson<Record<string, string>>("MODEL_MAP_JSON", {}) };
  return {
    port: envInt("PORT", 8080),
    awsRegion,
    upstreamMode: envEnum("UPSTREAM_MODE", ["mantle", "runtime"] as const, "mantle"),
    upstreamBaseUrl: env("UPSTREAM_BASE_URL", `https://bedrock-mantle.${awsRegion}.api.aws/anthropic`)!,
    bedrockProfilePrefix: env("BEDROCK_PROFILE_PREFIX", "us") === "none" ? "" : env("BEDROCK_PROFILE_PREFIX", "us")!,
    bedrockRuntimeEndpoint: env("BEDROCK_RUNTIME_ENDPOINT", "")!,
    keysTable: env("KEYS_TABLE", "claude-gateway-keys")!,
    usageTable: env("USAGE_TABLE", "claude-gateway-usage")!,
    metricsNamespace: env("METRICS_NAMESPACE", "ClaudeGateway")!,
    keyCacheTtlMs: envInt("KEY_CACHE_TTL_MS", 60_000),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 25 * 1024 * 1024),
    upstreamTimeoutMs: envInt("UPSTREAM_TIMEOUT_MS", 120_000),
    modelCatalogEnabled: envBool("MODEL_CATALOG_ENABLED", true),
    modelCatalogTtlMs: envInt("MODEL_CATALOG_TTL_MS", 10 * 60_000),

    modelMap,
    routeSubagentModel: env("ROUTE_SUBAGENT_MODEL"),
    routeAuxiliaryModel: env("ROUTE_AUXILIARY_MODEL"),
    routeCompactionModel: env("ROUTE_COMPACTION_MODEL"),

    effortMode: envEnum("EFFORT_MODE", ["off", "fill", "override"] as const, "off"),
    defaultEffort: env("DEFAULT_EFFORT"),

    operatorPrompt: env("OPERATOR_PROMPT"),

    cacheTtl1h: envBool("CACHE_TTL_1H", false),
    cacheTtlBeta: env("CACHE_TTL_BETA", "extended-cache-ttl-2025-04-11")!,

    toolResultMaxChars: envInt("TOOL_RESULT_MAX_CHARS", 0),

    bridgeBedrock: envBool("BRIDGE_BEDROCK", true),
    bridgeStripBetas: env("BRIDGE_STRIP_BETAS")
      ? env("BRIDGE_STRIP_BETAS")!.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_STRIP_BETAS,

    budgetAction: envEnum("BUDGET_ACTION", ["warn", "downgrade", "block"] as const, "warn"),
    downgradeModel: env("DOWNGRADE_MODEL"),
  };
}
