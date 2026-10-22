/**
 * Price table used for *estimated* cost attribution. Values are USD per
 * million tokens. Bedrock is partner-priced; global endpoints have matched
 * Anthropic list prices, regional endpoints carry a 10% premium. Override
 * with PRICING_JSON if your contract differs. The authoritative bill is
 * AWS Cost Explorer; this table only ranks developers and sessions.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

const BASE: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  // Older generations still listed by Bedrock (list prices; override via PRICING_JSON if your contract differs).
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
};

let envOverrides: Record<string, ModelPrice> = {};
let policyOverrides: Record<string, ModelPrice> = {};
let table: Record<string, ModelPrice> = { ...BASE };

function rebuild(): void {
  table = { ...BASE, ...envOverrides, ...policyOverrides };
}

/** PRICING_JSON from the environment (deploy-time). */
export function loadPricingOverrides(json: string | undefined): void {
  if (!json) return;
  envOverrides = JSON.parse(json) as Record<string, ModelPrice>;
  rebuild();
}

/** Prices edited in the admin UI (persisted with the policy). Replaces the previous policy layer. */
export function setPolicyPricing(overrides: Record<string, ModelPrice> | undefined): void {
  policyOverrides = overrides ? { ...overrides } : {};
  rebuild();
}

/** Full effective table (base + env + policy), keyed by normalised model key. */
export function pricingTable(): Record<string, ModelPrice> {
  return { ...table };
}

export function isModelPrice(v: unknown): v is ModelPrice {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k] as number) && (o[k] as number) >= 0);
}

/** Normalise "anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5", "claude-opus-5-5[1m]" -> "claude-opus-5-5". */
export function priceKey(modelId: string): string {
  let m = modelId.replace(/\[1m\]$/i, "");
  const idx = m.indexOf("anthropic.");
  if (idx >= 0) m = m.slice(idx + "anthropic.".length);
  m = m.replace(/-\d{8}(-v\d+(:\d+)?)?$/, "");
  m = m.replace(/-v\d+(:\d+)?$/, "");
  return m;
}

export function priceFor(modelId: string): ModelPrice | undefined {
  return table[priceKey(modelId)];
}

/** Estimated cost in USD. Unknown models return 0 and are flagged by the caller. */
export function estimateCostUsd(modelId: string, u: Usage): number {
  const p = priceFor(modelId);
  if (!p) return 0;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheReadTokens * p.cacheRead +
      u.cacheWrite5mTokens * p.cacheWrite5m +
      u.cacheWrite1hTokens * p.cacheWrite1h) /
    1_000_000
  );
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
};

/** Map an Anthropic `usage` object (message_start or final message) to our shape. */
export function usageFromApi(api: Record<string, unknown> | undefined): Usage {
  if (!api) return { ...EMPTY_USAGE };
  const n = (k: string) => (typeof api[k] === "number" ? (api[k] as number) : 0);
  const cc = api["cache_creation"] as Record<string, unknown> | undefined;
  const w5 = cc && typeof cc["ephemeral_5m_input_tokens"] === "number" ? (cc["ephemeral_5m_input_tokens"] as number) : undefined;
  const w1 = cc && typeof cc["ephemeral_1h_input_tokens"] === "number" ? (cc["ephemeral_1h_input_tokens"] as number) : 0;
  const totalWrite = n("cache_creation_input_tokens");
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cacheReadTokens: n("cache_read_input_tokens"),
    cacheWrite5mTokens: w5 !== undefined ? w5 : Math.max(0, totalWrite - w1),
    cacheWrite1hTokens: w1,
  };
}
