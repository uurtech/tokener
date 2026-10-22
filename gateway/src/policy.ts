/**
 * Request transforms. Every function here is pure and DETERMINISTIC: given the
 * same input it produces the same output. That property matters because Claude
 * Code resends the whole conversation on every turn; a transform that produced
 * different bytes for the same history would break the prompt-cache prefix and
 * trip the preserved-thinking check ("bound to a different conversation").
 */
import type { Config } from "./config.js";

export type Json = Record<string, unknown>;

export interface RequestMeta {
  requestClass?: string; // main | subagent | compaction | auxiliary | workflow
  agentType?: string;
  sessionId?: string;
  agentId?: string;
}

/** Strip "[1m]" and map an Anthropic id to the Bedrock Messages id. */
export function resolveModel(requested: string, modelMap: Record<string, string>): string {
  const bare = requested.replace(/\[1m\]$/i, "").trim();
  if (modelMap[bare]) return modelMap[bare];
  if (/(^|\.)anthropic\./.test(bare)) return bare; // already a Bedrock id
  // claude-foo-1-2-20260101 -> claude-foo-1-2
  const noDate = bare.replace(/-\d{8}$/, "");
  if (modelMap[noDate]) return modelMap[noDate];
  if (noDate.startsWith("claude-")) return `anthropic.${noDate}`;
  return bare;
}

/** Route by request class. Only applies when the operator configured a target. */
export function routeByClass(model: string, meta: RequestMeta, cfg: Config): string {
  switch (meta.requestClass) {
    case "subagent":
      return cfg.routeSubagentModel ?? model;
    case "auxiliary":
      return cfg.routeAuxiliaryModel ?? model;
    case "compaction":
      return cfg.routeCompactionModel ?? model;
    default:
      return model;
  }
}

export function applyEffort(body: Json, cfg: Config): void {
  if (cfg.effortMode === "off" || !cfg.defaultEffort) return;
  const oc = (body.output_config as Json | undefined) ?? {};
  if (cfg.effortMode === "fill" && oc.effort !== undefined) return;
  body.output_config = { ...oc, effort: cfg.defaultEffort };
}

/**
 * Append an operator instruction as the LAST system block. Never prepend: Claude
 * Code's first system block is an attribution header the upstream matches
 * positionally. Never convert an array `system` to a string.
 */
export function appendOperatorPrompt(body: Json, text: string | undefined): void {
  if (!text) return;
  const block = { type: "text", text };
  const sys = body.system;
  if (sys === undefined || sys === null) {
    body.system = [block];
  } else if (typeof sys === "string") {
    body.system = [{ type: "text", text: sys }, block];
  } else if (Array.isArray(sys)) {
    body.system = [...sys, block];
  }
}

function forEachBlock(body: Json, fn: (block: Json) => void): void {
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach((b) => b && typeof b === "object" && fn(b as Json));
  };
  visit(body.system);
  visit(body.tools);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages as Json[]) {
      if (m && typeof m === "object") {
        fn(m);
        visit(m.content);
      }
    }
  }
}

/** Promote every 5m cache breakpoint to 1h. All-or-nothing keeps TTL ordering valid. */
export function applyCacheTtl1h(body: Json): boolean {
  let changed = false;
  forEachBlock(body, (b) => {
    const cc = b.cache_control as Json | undefined;
    if (cc && cc.type === "ephemeral" && cc.ttl === undefined) {
      b.cache_control = { ...cc, ttl: "1h" };
      changed = true;
    }
  });
  return changed;
}

export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... gateway truncated ${dropped} characters of tool output ...]\n\n${text.slice(text.length - tail)}`;
}

/** Deterministically shorten oversized tool_result text. Returns number of blocks touched. */
export function truncateToolResults(body: Json, maxChars: number): number {
  if (maxChars <= 0 || !Array.isArray(body.messages)) return 0;
  let touched = 0;
  for (const m of body.messages as Json[]) {
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const block of m.content as Json[]) {
      if (!block || block.type !== "tool_result") continue;
      const c = block.content;
      if (typeof c === "string") {
        if (c.length > maxChars) {
          block.content = truncateText(c, maxChars);
          touched++;
        }
      } else if (Array.isArray(c)) {
        for (const inner of c as Json[]) {
          if (inner && inner.type === "text" && typeof inner.text === "string" && inner.text.length > maxChars) {
            inner.text = truncateText(inner.text, maxChars);
            touched++;
          }
        }
      }
    }
  }
  return touched;
}

/**
 * Remove request features that the Bedrock Messages endpoint does not accept
 * when Claude Code talks "full Anthropic format" through ANTHROPIC_BASE_URL.
 * Returns the list of removed items for logging.
 */
export function bridgeForBedrock(body: Json): string[] {
  const removed: string[] = [];
  if (body.context_management !== undefined) {
    delete body.context_management;
    removed.push("context_management");
  }
  const oc = body.output_config as Json | undefined;
  if (oc) {
    if (oc.format !== undefined) {
      delete oc.format;
      removed.push("output_config.format");
    }
    if (oc.task_budget !== undefined) {
      delete oc.task_budget;
      removed.push("output_config.task_budget");
    }
    if (Object.keys(oc).length === 0) delete body.output_config;
  }
  if (Array.isArray(body.tools)) {
    const kept: Json[] = [];
    for (const t of body.tools as Json[]) {
      if (!t) continue;
      if (typeof t.type === "string" && /^advisor_/.test(t.type as string)) {
        removed.push(`tools[${t.type}]`);
        continue;
      }
      if (t.strict !== undefined) {
        delete t.strict;
        if (!removed.includes("tools[].strict")) removed.push("tools[].strict");
      }
      kept.push(t);
    }
    body.tools = kept;
  }
  if (body.fallbacks !== undefined) {
    delete body.fallbacks;
    removed.push("fallbacks");
  }
  if (body.speed !== undefined) {
    delete body.speed;
    removed.push("speed");
  }
  return removed;
}

/** Filter comma-separated anthropic-beta values. */
export function filterBetas(header: string | undefined, stripPatterns: string[]): string | undefined {
  if (!header) return header;
  const kept = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((b) => !stripPatterns.some((p) => b.includes(p)));
  return kept.length ? kept.join(",") : undefined;
}

export function addBeta(header: string | undefined, beta: string): string {
  const set = new Set((header ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  set.add(beta);
  return [...set].join(",");
}

export interface TransformResult {
  upstreamModel: string;
  betaHeader: string | undefined;
  notes: string[];
}

/** Apply the full policy pipeline in a fixed order. Mutates `body`. */
export function transformRequest(
  body: Json,
  betaHeader: string | undefined,
  meta: RequestMeta,
  cfg: Config,
  opts: { forceModel?: string } = {},
): TransformResult {
  const notes: string[] = [];
  const requested = typeof body.model === "string" ? body.model : "";
  let model = resolveModel(requested, cfg.modelMap);
  const routed = routeByClass(model, meta, cfg);
  if (routed !== model) {
    notes.push(`route:${meta.requestClass}->${routed}`);
    model = routed;
  }
  if (opts.forceModel && opts.forceModel !== model) {
    notes.push(`budget-downgrade->${opts.forceModel}`);
    model = opts.forceModel;
  }
  body.model = model;

  if (cfg.bridgeBedrock) {
    const removed = bridgeForBedrock(body);
    if (removed.length) notes.push(`bridge:${removed.join("|")}`);
    const before = betaHeader;
    betaHeader = filterBetas(betaHeader, cfg.bridgeStripBetas);
    if (before !== betaHeader) notes.push("bridge:betas");
  }

  applyEffort(body, cfg);
  appendOperatorPrompt(body, cfg.operatorPrompt);

  if (cfg.cacheTtl1h && applyCacheTtl1h(body)) {
    betaHeader = addBeta(betaHeader, cfg.cacheTtlBeta);
    notes.push("cache:1h");
  }

  const truncated = truncateToolResults(body, cfg.toolResultMaxChars);
  if (truncated) notes.push(`truncate:${truncated}`);

  return { upstreamModel: model, betaHeader, notes };
}

/** True when the conversation has no assistant turn yet (safe point to change model). */
export function isConversationStart(body: Json): boolean {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return true;
  return !msgs.some((m) => m && (m as Json).role === "assistant");
}
