/**
 * Second upstream: the classic Bedrock Runtime API (InvokeModel /
 * InvokeModelWithResponseStream / CountTokens) instead of the Mantle Messages
 * endpoint. The request body is the same Anthropic Messages JSON, but:
 *   - the model goes in the URL, not the body; models served through inference
 *     profiles need a `us.` / `global.` prefix
 *   - `anthropic_version: "bedrock-2023-05-31"` is required, `stream` and
 *     `metadata` are not accepted, beta flags travel in `anthropic_beta: [...]`
 *   - streaming comes back as an AWS binary event stream whose chunks carry the
 *     Anthropic SSE events as base64 JSON; we re-serialise them as text/event-stream
 *     so Claude Code sees exactly what it would see from Anthropic.
 * Everything is wrapped into a standard `Response` so server.ts treats both
 * upstreams the same way.
 */
import {
  BedrockRuntimeClient,
  CountTokensCommand,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { Json } from "./policy.js";
import type { CatalogModel } from "./models.js";

export const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
export const PROFILE_PREFIXES = ["us", "global", "eu", "apac", ""] as const;

/** Stream member as yielded by the SDK: a payload chunk or a typed exception. */
export type RuntimeStreamEvent = { chunk?: { bytes?: Uint8Array } } & Record<string, { message?: string; originalStatusCode?: number; originalMessage?: string } | undefined>;

/** Minimal client surface so tests can inject a fake. */
export interface RuntimeClientLike {
  invoke(modelId: string, body: Uint8Array, signal: AbortSignal): Promise<{ body: Uint8Array; requestId?: string }>;
  invokeStream(modelId: string, body: Uint8Array, signal: AbortSignal): Promise<{ events: AsyncIterable<RuntimeStreamEvent>; requestId?: string }>;
  countTokens(modelId: string, body: Uint8Array, signal: AbortSignal): Promise<{ inputTokens?: number; requestId?: string }>;
}

export function sdkRuntimeClient(region: string, endpoint?: string, requestTimeoutMs = 0): RuntimeClientLike {
  // The SDK defaults this client to HTTP/2, which breaks behind HTTP/1.1-only proxies and test
  // endpoints. Plain HTTP/1.1 streams event streams just fine. requestTimeout covers the time to
  // first byte only; long streaming turns are not cut (socketTimeout is left at the SDK default).
  const client = new BedrockRuntimeClient({
    region,
    endpoint: endpoint || undefined,
    requestHandler: new NodeHttpHandler({ requestTimeout: requestTimeoutMs > 0 ? requestTimeoutMs : undefined, connectionTimeout: 10_000 }),
  });
  return {
    async invoke(modelId, body, signal) {
      const r = await client.send(new InvokeModelCommand({ modelId, body, contentType: "application/json", accept: "application/json" }), { abortSignal: signal });
      return { body: r.body ?? new Uint8Array(), requestId: r.$metadata.requestId };
    },
    async invokeStream(modelId, body, signal) {
      const r = await client.send(new InvokeModelWithResponseStreamCommand({ modelId, body, contentType: "application/json", accept: "application/json" }), { abortSignal: signal });
      return { events: (r.body ?? []) as AsyncIterable<RuntimeStreamEvent>, requestId: r.$metadata.requestId };
    },
    async countTokens(modelId, body, signal) {
      const r = await client.send(new CountTokensCommand({ modelId, input: { invokeModel: { body } } }), { abortSignal: signal });
      return { inputTokens: r.inputTokens, requestId: r.$metadata.requestId };
    },
  };
}

/**
 * Bedrock Runtime is stricter about ids than Mantle: it wants the exact catalog id
 * (`anthropic.claude-haiku-4-5-20251001-v1:0`, not `anthropic.claude-haiku-4-5`) and,
 * for models served through inference profiles, the profile id (`us.anthropic...`).
 * Resolution, deterministic for a given catalog snapshot:
 *   1. ids that already carry a profile prefix pass through untouched
 *   2. find the catalog entry: exact id, else the dated variant that starts with `<id>-` (ACTIVE first)
 *   3. prefer the profile with the operator's prefix; else bare id if ON_DEMAND; else first profile
 *   4. unknown to the catalog (or catalog empty): add the prefix blindly
 */
export function toRuntimeModelId(model: string, prefix: string, catalog: readonly CatalogModel[] = []): string {
  if (!model.startsWith("anthropic.")) return model;
  const rank = (s: string) => (s === "ACTIVE" ? 0 : s === "LEGACY" ? 1 : 2);
  const entry =
    catalog.find((m) => m.id === model) ??
    catalog
      .filter((m) => m.id.startsWith(`${model}-`))
      .sort((a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id))[0];
  if (!entry) return prefix ? `${prefix}.${model}` : model;
  if (prefix) {
    const preferred = entry.profiles.find((p) => p.startsWith(`${prefix}.`));
    if (preferred) return preferred;
  }
  if (!prefix || entry.inferenceTypes.includes("ON_DEMAND") || !entry.profiles.length) return entry.id;
  return [...entry.profiles].sort()[0];
}

/** Translate an Anthropic Messages body (already policy-transformed) into the Bedrock InvokeModel body. */
export function toRuntimeBody(body: Json, betaHeader: string | undefined): Json {
  const out: Json = { ...body };
  delete out.model;
  delete out.stream;
  delete out.metadata; // Bedrock rejects it; Claude Code only puts an opaque user_id there
  out.anthropic_version = BEDROCK_ANTHROPIC_VERSION;
  const betas = new Set<string>(Array.isArray(out.anthropic_beta) ? (out.anthropic_beta as string[]) : []);
  for (const b of (betaHeader ?? "").split(",").map((s) => s.trim()).filter(Boolean)) betas.add(b);
  if (betas.size) out.anthropic_beta = [...betas];
  else delete out.anthropic_beta;
  return out;
}

/** Map an SDK exception (by name) to an Anthropic-style error type and HTTP status. */
export function mapRuntimeError(name: string | undefined, httpStatus?: number): { status: number; type: string } {
  switch (name) {
    case "ValidationException":
      return { status: 400, type: "invalid_request_error" };
    case "AccessDeniedException":
      return { status: 403, type: "permission_error" };
    case "ResourceNotFoundException":
      return { status: 404, type: "not_found_error" };
    case "ThrottlingException":
    case "ServiceQuotaExceededException":
      return { status: 429, type: "rate_limit_error" };
    case "ModelNotReadyException":
    case "ServiceUnavailableException":
      return { status: 529, type: "overloaded_error" };
    case "ModelTimeoutException":
      return { status: 504, type: "api_error" };
    case "ModelErrorException":
    case "ModelStreamErrorException":
    case "InternalServerException":
      return { status: 500, type: "api_error" };
    default:
      return { status: httpStatus && httpStatus >= 400 ? httpStatus : 502, type: "api_error" };
  }
}

function errorBody(type: string, message: string, requestId?: string): string {
  return JSON.stringify({ type: "error", ...(requestId ? { request_id: requestId } : {}), error: { type, message } });
}

/** Is this a Bedrock service exception (as opposed to a network error or abort)? */
function isServiceError(e: unknown): e is Error & { name: string; $metadata?: { httpStatusCode?: number; requestId?: string }; $fault?: string } {
  return !!e && typeof e === "object" && "$metadata" in (e as object);
}

function errorResponse(e: Error & { name: string; $metadata?: { httpStatusCode?: number; requestId?: string } }, extra: Record<string, string> = {}): Response {
  const { status, type } = mapRuntimeError(e.name, e.$metadata?.httpStatusCode);
  const headers: Record<string, string> = { "content-type": "application/json", "x-amzn-errortype": e.name, ...extra };
  if (e.$metadata?.requestId) headers["x-amzn-requestid"] = e.$metadata.requestId;
  if (status === 429) headers["retry-after"] = "5";
  return new Response(errorBody(type, e.message, e.$metadata?.requestId), { status, headers });
}

const dec = new TextDecoder();

/** Re-serialise Bedrock stream members as Anthropic SSE text. Exception members become a terminal `error` event. */
export async function* sseFromRuntimeEvents(events: AsyncIterable<RuntimeStreamEvent>): AsyncGenerator<string> {
  for await (const ev of events) {
    if (ev.chunk?.bytes) {
      const text = dec.decode(ev.chunk.bytes);
      let type = "message";
      try {
        const t = (JSON.parse(text) as { type?: unknown }).type;
        if (typeof t === "string") type = t;
      } catch {
        /* forward as-is; Claude Code's parser will skip it */
      }
      yield `event: ${type}\ndata: ${text}\n\n`;
      continue;
    }
    const key = Object.keys(ev).find((k) => k !== "chunk" && ev[k] !== undefined);
    if (key) {
      const detail = ev[key]!;
      const name = key.charAt(0).toUpperCase() + key.slice(1); // modelStreamErrorException -> ModelStreamErrorException
      const { type } = mapRuntimeError(name, detail.originalStatusCode);
      const message = detail.originalMessage ?? detail.message ?? name;
      yield `event: error\ndata: ${errorBody(type, `${name}: ${message}`)}\n\n`;
      return;
    }
  }
}

export class BedrockRuntimeUpstream {
  constructor(
    private readonly client: RuntimeClientLike,
    readonly endpointLabel: string,
  ) {}

  /** POST /v1/messages equivalent. Service errors become error Responses; network errors and aborts throw. */
  async messages(modelId: string, body: Json, betaHeader: string | undefined, stream: boolean, signal: AbortSignal): Promise<Response> {
    const bytes = new TextEncoder().encode(JSON.stringify(toRuntimeBody(body, betaHeader)));
    try {
      if (!stream) {
        const r = await this.client.invoke(modelId, bytes, signal);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (r.requestId) headers["x-amzn-requestid"] = r.requestId;
        return new Response(Buffer.from(r.body), { status: 200, headers });
      }
      const r = await this.client.invokeStream(modelId, bytes, signal);
      const headers: Record<string, string> = { "content-type": "text/event-stream" };
      if (r.requestId) headers["x-amzn-requestid"] = r.requestId;
      const enc = new TextEncoder();
      const gen = sseFromRuntimeEvents(r.events);
      const web = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await gen.next();
          if (done) controller.close();
          else controller.enqueue(enc.encode(value));
        },
        cancel() {
          void gen.return(undefined);
        },
      });
      return new Response(web, { status: 200, headers });
    } catch (e) {
      if (isServiceError(e)) return errorResponse(e);
      throw e;
    }
  }

  /** POST /v1/messages/count_tokens equivalent. */
  async countTokens(modelId: string, body: Json, betaHeader: string | undefined, signal: AbortSignal): Promise<Response> {
    const bytes = new TextEncoder().encode(JSON.stringify(toRuntimeBody(body, betaHeader)));
    try {
      const r = await this.client.countTokens(modelId, bytes, signal);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (r.requestId) headers["x-amzn-requestid"] = r.requestId;
      return new Response(JSON.stringify({ input_tokens: r.inputTokens ?? 0 }), { status: 200, headers });
    } catch (e) {
      if (isServiceError(e)) return errorResponse(e);
      throw e;
    }
  }
}
