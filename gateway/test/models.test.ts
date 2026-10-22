import { describe, it, expect } from "vitest";
import { ModelCatalog, annotateCatalog, buildCatalog, modelsForClients, type BedrockLister, type RawModelSummary, type RawProfileSummary } from "../src/models.js";
import { DEFAULT_MODEL_MAP } from "../src/config.js";

const arn = (id: string) => `arn:aws:bedrock:us-east-1::foundation-model/${id}`;
const models: RawModelSummary[] = [
  { modelId: "anthropic.claude-opus-5-5", modelName: "Claude Opus 5.5", providerName: "Anthropic", responseStreamingSupported: true, inferenceTypesSupported: ["INFERENCE_PROFILE"], inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"], modelLifecycle: { status: "ACTIVE" } },
  { modelId: "anthropic.claude-sonnet-4-20250514-v1:0", modelName: "Claude Sonnet 4", providerName: "Anthropic", responseStreamingSupported: true, inferenceTypesSupported: ["INFERENCE_PROFILE"], modelLifecycle: { status: "LEGACY" } },
  { modelId: "amazon.nova-pro-v1:0", modelName: "Nova Pro", providerName: "Amazon", modelLifecycle: { status: "ACTIVE" } },
];
const profiles: RawProfileSummary[] = [
  { inferenceProfileId: "us.anthropic.claude-opus-5-5", status: "ACTIVE", type: "SYSTEM_DEFINED", models: [{ modelArn: arn("anthropic.claude-opus-5-5") }] },
  { inferenceProfileId: "global.anthropic.claude-opus-5-5", status: "ACTIVE", type: "SYSTEM_DEFINED", models: [{ modelArn: arn("anthropic.claude-opus-5-5") }] },
  { inferenceProfileId: "us.anthropic.claude-sonnet-4-20250514-v1:0", status: "ACTIVE", type: "SYSTEM_DEFINED", models: [] },
  { inferenceProfileId: "us.amazon.nova-pro-v1:0", status: "ACTIVE", type: "SYSTEM_DEFINED", models: [{ modelArn: arn("amazon.nova-pro-v1:0") }] },
  { inferenceProfileId: "us.anthropic.claude-opus-5-5-old", status: "INACTIVE", type: "SYSTEM_DEFINED", models: [{ modelArn: arn("anthropic.claude-opus-5-5") }] },
];

describe("buildCatalog", () => {
  it("keeps Anthropic models only, links active profiles, sorts ACTIVE first", () => {
    const c = buildCatalog(models, profiles);
    expect(c.map((m) => m.id)).toEqual(["anthropic.claude-opus-5-5", "anthropic.claude-sonnet-4-20250514-v1:0"]);
    expect(c[0].profiles).toEqual(["global.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5"]);
    expect(c[0]).toMatchObject({ streaming: true, status: "ACTIVE", inputModalities: ["TEXT", "IMAGE"] });
    // profile without model ARNs falls back to id-prefix matching
    expect(c[1].profiles).toEqual(["us.anthropic.claude-sonnet-4-20250514-v1:0"]);
  });
});

describe("annotateCatalog / modelsForClients", () => {
  const c = buildCatalog(models, profiles);
  it("joins aliases and price knowledge", () => {
    const a = annotateCatalog(c, DEFAULT_MODEL_MAP);
    expect(a[0].aliases).toEqual(["claude-opus-5-5"]);
    expect(a[0].priceKnown).toBe(true);
    expect(a[1].aliases).toEqual([]);
    expect(a[1].priceKnown).toBe(true); // dated id normalises to claude-sonnet-4, which is priced
    expect(annotateCatalog(buildCatalog([{ modelId: "anthropic.claude-mystery-9", providerName: "Anthropic" }], []), {})[0].priceKnown).toBe(false);
  });
  it("lists aliases first, then active Bedrock ids and profiles, without duplicates or legacy models", () => {
    const list = modelsForClients({ "claude-opus-5-5": "anthropic.claude-opus-5-5" }, c);
    expect(list.map((m) => m.id)).toEqual(["claude-opus-5-5", "anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5"]);
    expect(list.every((m) => m.type === "model")).toBe(true);
    expect(modelsForClients({ "claude-opus-5-5": "anthropic.claude-opus-5-5" }, []).map((m) => m.id)).toEqual(["claude-opus-5-5"]);
  });
});

describe("ModelCatalog", () => {
  const fake = (opts: { fail?: boolean } = {}) => {
    let calls = 0;
    const lister: BedrockLister = {
      async listFoundationModels() {
        calls++;
        if (opts.fail) throw new Error("AccessDeniedException: no bedrock:ListFoundationModels");
        return { modelSummaries: models };
      },
      async listInferenceProfiles(token) {
        // two pages to exercise pagination
        return token ? { inferenceProfileSummaries: profiles.slice(2) } : { inferenceProfileSummaries: profiles.slice(0, 2), nextToken: "p2" };
      },
    };
    return { lister, calls: () => calls };
  };

  it("caches within the TTL, paginates profiles and refreshes on demand", async () => {
    const f = fake();
    const cat = new ModelCatalog(f.lister, 60_000, "us-east-1");
    const a = await cat.get();
    expect(a.models).toHaveLength(2);
    expect(a.models[0].profiles).toHaveLength(2);
    expect(a.fetchedAt).toBeDefined();
    await cat.get();
    expect(f.calls()).toBe(1);
    await cat.get(true);
    expect(f.calls()).toBe(2);
  });

  it("never throws: reports the error and keeps the previous list", async () => {
    const cat = new ModelCatalog(fake({ fail: true }).lister, 60_000, "us-east-1");
    const s = await cat.get();
    expect(s.models).toEqual([]);
    expect(s.error).toContain("AccessDenied");
  });

  it("is inert when disabled", async () => {
    const cat = new ModelCatalog(null, 60_000, "us-east-1");
    expect(await cat.get(true)).toMatchObject({ models: [], disabled: true, region: "us-east-1" });
  });
});
