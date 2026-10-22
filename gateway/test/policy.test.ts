import { describe, it, expect } from "vitest";
import {
  resolveModel,
  routeByClass,
  applyEffort,
  appendOperatorPrompt,
  applyCacheTtl1h,
  truncateToolResults,
  bridgeForBedrock,
  filterBetas,
  transformRequest,
  isConversationStart,
  type Json,
} from "../src/policy.js";
import { DEFAULT_MODEL_MAP, type Config } from "../src/config.js";

const base: Config = {
  port: 0,
  awsRegion: "us-east-1",
  upstreamBaseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
  keysTable: "k",
  usageTable: "u",
  metricsNamespace: "T",
  keyCacheTtlMs: 0,
  maxBodyBytes: 1e6,
  upstreamTimeoutMs: 0, upstreamMode: "mantle", bedrockProfilePrefix: "us", bedrockRuntimeEndpoint: "",
  modelCatalogEnabled: false,
  modelCatalogTtlMs: 0,
  modelMap: DEFAULT_MODEL_MAP,
  effortMode: "off",
  cacheTtl1h: false,
  cacheTtlBeta: "extended-cache-ttl-2025-04-11",
  toolResultMaxChars: 0,
  bridgeBedrock: true,
  bridgeStripBetas: ["context-management", "structured-outputs", "task-budgets"],
  budgetAction: "warn",
};

describe("resolveModel", () => {
  it("maps Anthropic ids to Bedrock ids", () => {
    expect(resolveModel("claude-opus-5-5", DEFAULT_MODEL_MAP)).toBe("anthropic.claude-opus-5-5");
    expect(resolveModel("claude-opus-5-5[1m]", DEFAULT_MODEL_MAP)).toBe("anthropic.claude-opus-5-5");
    expect(resolveModel("claude-haiku-4-5-20251001", DEFAULT_MODEL_MAP)).toBe("anthropic.claude-haiku-4-5");
  });
  it("passes Bedrock ids through", () => {
    expect(resolveModel("anthropic.claude-sonnet-5-5", DEFAULT_MODEL_MAP)).toBe("anthropic.claude-sonnet-5-5");
    expect(resolveModel("global.anthropic.claude-sonnet-5-5", DEFAULT_MODEL_MAP)).toBe("global.anthropic.claude-sonnet-5-5");
  });
  it("prefixes unknown claude ids", () => {
    expect(resolveModel("claude-future-9", DEFAULT_MODEL_MAP)).toBe("anthropic.claude-future-9");
  });
});

describe("routeByClass", () => {
  const cfg = { ...base, routeSubagentModel: "anthropic.claude-sonnet-5-5", routeAuxiliaryModel: "anthropic.claude-haiku-4-5" };
  it("routes subagent and auxiliary, leaves main", () => {
    expect(routeByClass("anthropic.claude-opus-5-5", { requestClass: "subagent" }, cfg)).toBe("anthropic.claude-sonnet-5-5");
    expect(routeByClass("anthropic.claude-opus-5-5", { requestClass: "auxiliary" }, cfg)).toBe("anthropic.claude-haiku-4-5");
    expect(routeByClass("anthropic.claude-opus-5-5", { requestClass: "main" }, cfg)).toBe("anthropic.claude-opus-5-5");
    expect(routeByClass("anthropic.claude-opus-5-5", {}, cfg)).toBe("anthropic.claude-opus-5-5");
  });
});

describe("applyEffort", () => {
  it("fill only sets when absent", () => {
    const cfg = { ...base, effortMode: "fill" as const, defaultEffort: "high" };
    const a: Json = {};
    applyEffort(a, cfg);
    expect(a.output_config).toEqual({ effort: "high" });
    const b: Json = { output_config: { effort: "xhigh" } };
    applyEffort(b, cfg);
    expect((b.output_config as Json).effort).toBe("xhigh");
  });
  it("override always sets and keeps other keys", () => {
    const cfg = { ...base, effortMode: "override" as const, defaultEffort: "medium" };
    const b: Json = { output_config: { effort: "xhigh", other: 1 } };
    applyEffort(b, cfg);
    expect(b.output_config).toEqual({ effort: "medium", other: 1 });
  });
});

describe("appendOperatorPrompt", () => {
  it("appends last, never first, and preserves array form", () => {
    const b: Json = { system: [{ type: "text", text: "attribution" }, { type: "text", text: "main", cache_control: { type: "ephemeral" } }] };
    appendOperatorPrompt(b, "policy");
    const sys = b.system as Json[];
    expect(sys).toHaveLength(3);
    expect(sys[0].text).toBe("attribution");
    expect(sys[2]).toEqual({ type: "text", text: "policy" });
  });
  it("wraps string system into blocks", () => {
    const b: Json = { system: "hi" };
    appendOperatorPrompt(b, "policy");
    expect(b.system).toEqual([{ type: "text", text: "hi" }, { type: "text", text: "policy" }]);
  });
  it("is deterministic across turns", () => {
    const mk = () => ({ system: [{ type: "text", text: "s" }] }) as Json;
    const a = mk();
    const b = mk();
    appendOperatorPrompt(a, "p");
    appendOperatorPrompt(b, "p");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("applyCacheTtl1h", () => {
  it("promotes every ephemeral breakpoint without ttl", () => {
    const b: Json = {
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "t", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "u", cache_control: { type: "ephemeral", ttl: "5m" } }] }],
    };
    expect(applyCacheTtl1h(b)).toBe(true);
    expect(((b.system as Json[])[0].cache_control as Json).ttl).toBe("1h");
    expect(((b.tools as Json[])[0].cache_control as Json).ttl).toBe("1h");
    const msgBlock = ((b.messages as Json[])[0].content as Json[])[0];
    expect((msgBlock.cache_control as Json).ttl).toBe("5m"); // explicit ttl respected
  });
});

describe("truncateToolResults", () => {
  it("shortens only oversized tool_result text deterministically", () => {
    const big = "x".repeat(10_000);
    const mk = (): Json => ({
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: big }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: [{ type: "text", text: "small" }] }] },
        { role: "user", content: "plain user text " + big },
      ],
    });
    const a = mk();
    const n = truncateToolResults(a, 1000);
    expect(n).toBe(1);
    const t = ((a.messages as Json[])[0].content as Json[])[0].content as string;
    expect(t.length).toBeLessThan(1200);
    expect(t).toContain("gateway truncated");
    expect((a.messages as Json[])[2].content).toBe("plain user text " + big); // user text untouched
    const b = mk();
    truncateToolResults(b, 1000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("bridgeForBedrock", () => {
  it("removes unsupported fields and advisor tool, keeps the rest", () => {
    const b: Json = {
      context_management: { edits: [] },
      output_config: { effort: "high", format: { type: "json_schema" }, task_budget: { type: "tokens", total: 20000 } },
      tools: [
        { name: "Bash", input_schema: {}, strict: true },
        { type: "advisor_20260301", name: "advisor" },
      ],
      thinking: { type: "adaptive" },
    };
    const removed = bridgeForBedrock(b);
    expect(b.context_management).toBeUndefined();
    expect(b.output_config).toEqual({ effort: "high" });
    expect(b.tools).toEqual([{ name: "Bash", input_schema: {} }]);
    expect(b.thinking).toEqual({ type: "adaptive" });
    expect(removed).toEqual(expect.arrayContaining(["context_management", "output_config.format", "output_config.task_budget", "tools[].strict", "tools[advisor_20260301]"]));
  });
  it("drops output_config entirely when it becomes empty", () => {
    const b: Json = { output_config: { format: {} } };
    bridgeForBedrock(b);
    expect(b.output_config).toBeUndefined();
  });
});

describe("filterBetas", () => {
  it("strips matching values and keeps the rest verbatim", () => {
    const h = "interleaved-thinking-2025-05-14,context-management-2025-06-27,context-1m-2025-08-07,structured-outputs-2025-11-13";
    expect(filterBetas(h, ["context-management", "structured-outputs"])).toBe("interleaved-thinking-2025-05-14,context-1m-2025-08-07");
    expect(filterBetas("context-management-2025-06-27", ["context-management"])).toBeUndefined();
    expect(filterBetas(undefined, ["x"])).toBeUndefined();
  });
});

describe("transformRequest pipeline", () => {
  it("applies routing, bridge, effort fill, operator prompt and reports notes", () => {
    const cfg: Config = {
      ...base,
      routeSubagentModel: "anthropic.claude-sonnet-5-5",
      effortMode: "fill",
      defaultEffort: "high",
      operatorPrompt: "Keep tool output short.",
    };
    const body: Json = {
      model: "claude-opus-5-5",
      stream: true,
      context_management: {},
      system: [{ type: "text", text: "attr" }],
      messages: [{ role: "user", content: "hi" }],
    };
    const r = transformRequest(body, "context-management-2025-06-27,interleaved-thinking-2025-05-14", { requestClass: "subagent" }, cfg);
    expect(r.upstreamModel).toBe("anthropic.claude-sonnet-5-5");
    expect(body.model).toBe("anthropic.claude-sonnet-5-5");
    expect(r.betaHeader).toBe("interleaved-thinking-2025-05-14");
    expect(body.output_config).toEqual({ effort: "high" });
    expect((body.system as Json[]).at(-1)).toEqual({ type: "text", text: "Keep tool output short." });
    expect(r.notes.join(" ")).toContain("route:subagent");
  });
  it("budget downgrade forces the model", () => {
    const body: Json = { model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }] };
    const r = transformRequest(body, undefined, {}, base, { forceModel: "anthropic.claude-sonnet-5-5" });
    expect(r.upstreamModel).toBe("anthropic.claude-sonnet-5-5");
  });
});

describe("isConversationStart", () => {
  it("detects first turn", () => {
    expect(isConversationStart({ messages: [{ role: "user", content: "x" }] })).toBe(true);
    expect(isConversationStart({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }, { role: "user", content: "z" }] })).toBe(false);
  });
});
