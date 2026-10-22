/**
 * Live model catalog from the Bedrock control plane. The Mantle Messages endpoint
 * has no GET /v1/models, so we combine two control-plane calls:
 *   - ListFoundationModels(byProvider=Anthropic) -> base ids (anthropic.claude-...)
 *   - ListInferenceProfiles                       -> regional / global ids (us.anthropic..., global.anthropic...)
 * Results are cached (MODEL_CATALOG_TTL_MS) because the list changes rarely and
 * both calls are rate-limited control-plane APIs.
 */
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import { priceFor } from "./pricing.js";

export interface CatalogModel {
  /** Bedrock model id usable in `model` (anthropic.claude-opus-5-5). */
  id: string;
  name: string;
  status: string; // ACTIVE | LEGACY | ...
  streaming: boolean;
  inferenceTypes: string[]; // ON_DEMAND | INFERENCE_PROFILE | PROVISIONED
  inputModalities: string[];
  outputModalities: string[];
  /** Inference-profile ids that front this model (us.anthropic..., global.anthropic...). */
  profiles: string[];
}

export interface CatalogSnapshot {
  models: CatalogModel[];
  fetchedAt?: string;
  /** Set when the last refresh failed; `models` then holds the previous good result (possibly empty). */
  error?: string;
  disabled?: boolean;
  region: string;
}

/** Minimal client surface so tests can inject a fake. */
export interface BedrockLister {
  listFoundationModels(): Promise<{ modelSummaries?: RawModelSummary[] }>;
  listInferenceProfiles(nextToken?: string): Promise<{ inferenceProfileSummaries?: RawProfileSummary[]; nextToken?: string }>;
}

export interface RawModelSummary {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  responseStreamingSupported?: boolean;
  inferenceTypesSupported?: string[];
  inputModalities?: string[];
  outputModalities?: string[];
  modelLifecycle?: { status?: string };
}

export interface RawProfileSummary {
  inferenceProfileId?: string;
  status?: string;
  type?: string;
  models?: { modelArn?: string }[];
}

export function sdkLister(region: string): BedrockLister {
  const client = new BedrockClient({ region });
  return {
    listFoundationModels: () => client.send(new ListFoundationModelsCommand({ byProvider: "Anthropic" })),
    listInferenceProfiles: (nextToken) => client.send(new ListInferenceProfilesCommand({ maxResults: 100, nextToken })),
  };
}

/** Pure merge of the two raw listings; exported for tests. */
export function buildCatalog(models: RawModelSummary[], profiles: RawProfileSummary[]): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const m of models) {
    if (!m.modelId || !/anthropic/i.test(m.providerName ?? m.modelId)) continue;
    byId.set(m.modelId, {
      id: m.modelId,
      name: m.modelName ?? m.modelId,
      status: m.modelLifecycle?.status ?? "UNKNOWN",
      streaming: m.responseStreamingSupported ?? false,
      inferenceTypes: m.inferenceTypesSupported ?? [],
      inputModalities: m.inputModalities ?? [],
      outputModalities: m.outputModalities ?? [],
      profiles: [],
    });
  }
  for (const p of profiles) {
    const pid = p.inferenceProfileId;
    if (!pid || !pid.includes("anthropic.") || p.status !== "ACTIVE") continue;
    // us.anthropic.claude-opus-5-5 -> anthropic.claude-opus-5-5 ; the ARN list is the authoritative link.
    const targets = new Set<string>();
    for (const m of p.models ?? []) {
      const arn = m.modelArn ?? "";
      const idx = arn.indexOf("foundation-model/");
      if (idx >= 0) targets.add(arn.slice(idx + "foundation-model/".length));
    }
    if (!targets.size) targets.add(pid.slice(pid.indexOf("anthropic.")));
    for (const t of targets) {
      const base = byId.get(t);
      if (base && !base.profiles.includes(pid)) base.profiles.push(pid);
    }
  }
  const rank = (s: string) => (s === "ACTIVE" ? 0 : s === "LEGACY" ? 1 : 2);
  return [...byId.values()]
    .map((m) => ({ ...m, profiles: m.profiles.sort() }))
    .sort((a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id));
}

export class ModelCatalog {
  private snapshot: CatalogSnapshot;
  private inflight?: Promise<CatalogSnapshot>;
  private expires = 0;

  constructor(
    private readonly lister: BedrockLister | null,
    private readonly ttlMs: number,
    region: string,
  ) {
    this.snapshot = { models: [], region, disabled: lister === null };
  }

  /** Whatever is cached right now, without triggering a fetch (hot path helper). */
  peek(): CatalogSnapshot {
    return this.snapshot;
  }

  /** Cached catalog; `refresh` forces a control-plane round trip. Never throws. */
  async get(refresh = false): Promise<CatalogSnapshot> {
    if (!this.lister) return this.snapshot;
    if (!refresh && Date.now() < this.expires) return this.snapshot;
    if (!this.inflight) {
      this.inflight = this.fetch().finally(() => (this.inflight = undefined));
    }
    return this.inflight;
  }

  private async fetch(): Promise<CatalogSnapshot> {
    const lister = this.lister!;
    try {
      const profiles: RawProfileSummary[] = [];
      const listProfiles = async () => {
        let token: string | undefined;
        do {
          const page = await lister.listInferenceProfiles(token);
          profiles.push(...(page.inferenceProfileSummaries ?? []));
          token = page.nextToken;
        } while (token);
      };
      // Run both concurrently; Promise.all keeps a rejection of either from going unhandled (which crashes Node).
      const [fm] = await Promise.all([lister.listFoundationModels(), listProfiles()]);
      const models = buildCatalog(fm.modelSummaries ?? [], profiles);
      this.snapshot = { models, fetchedAt: new Date().toISOString(), region: this.snapshot.region };
      this.expires = Date.now() + this.ttlMs;
    } catch (e) {
      // Keep the last good list, surface the error, retry sooner than the normal TTL.
      this.snapshot = { ...this.snapshot, error: (e as Error).message };
      this.expires = Date.now() + Math.min(this.ttlMs, 30_000);
    }
    return this.snapshot;
  }
}

/** Admin view: catalog rows joined with the gateway's alias map and price table. */
export function annotateCatalog(models: CatalogModel[], modelMap: Record<string, string>) {
  const aliasesFor = (id: string) =>
    Object.entries(modelMap)
      .filter(([, target]) => target === id || target.endsWith(`.${id}`))
      .map(([alias]) => alias)
      .sort();
  return models.map((m) => ({ ...m, aliases: aliasesFor(m.id), priceKnown: priceFor(m.id) !== undefined }));
}

/** Developer view (`GET /v1/models`): aliases first, then live Bedrock ids and their profiles. */
export function modelsForClients(modelMap: Record<string, string>, catalog: CatalogModel[]) {
  const seen = new Set<string>();
  const out: { id: string; type: "model"; display_name: string; description: string; created_at: string }[] = [];
  const push = (id: string, display: string, description: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, type: "model", display_name: display, description, created_at: "2026-01-01T00:00:00Z" });
  };
  for (const [alias, target] of Object.entries(modelMap)) push(alias, alias, `Gateway alias -> ${target}`);
  for (const m of catalog) {
    if (m.status !== "ACTIVE") continue;
    push(m.id, m.name, `Bedrock ${m.id}`);
    for (const p of m.profiles) push(p, `${m.name} (${p.split(".")[0]})`, `Bedrock inference profile for ${m.id}`);
  }
  return out;
}
