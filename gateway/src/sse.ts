/**
 * Pass-through Transform that observes an Anthropic SSE stream and extracts
 * `usage` without altering a single byte. Claude Code depends on receiving the
 * event sequence exactly as the upstream sent it, including `ping` events.
 */
import { Transform, type TransformCallback } from "node:stream";
import { EMPTY_USAGE, usageFromApi, type Usage } from "./pricing.js";

export interface StreamSummary {
  usage: Usage;
  model?: string;
  stopReason?: string;
  sawMessageStop: boolean;
  errorType?: string;
}

export class SseUsageTap extends Transform {
  private buf = "";
  readonly summary: StreamSummary = { usage: { ...EMPTY_USAGE }, sawMessageStop: false };

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.push(chunk);
    this.buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.handleEvent(raw);
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.buf.trim()) this.handleEvent(this.buf);
    this.buf = "";
    cb();
  }

  private handleEvent(raw: string): void {
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    applyEvent(this.summary, evt);
  }
}

export function applyEvent(s: StreamSummary, evt: Record<string, unknown>): void {
  switch (evt.type) {
    case "message_start": {
      const msg = evt.message as Record<string, unknown> | undefined;
      if (msg) {
        const u = usageFromApi(msg.usage as Record<string, unknown> | undefined);
        s.usage = { ...u, outputTokens: Math.max(u.outputTokens, s.usage.outputTokens) };
        if (typeof msg.model === "string") s.model = msg.model;
      }
      break;
    }
    case "message_delta": {
      const u = evt.usage as Record<string, unknown> | undefined;
      if (u && typeof u.output_tokens === "number") s.usage.outputTokens = u.output_tokens;
      // Some servers repeat cumulative input/cache counters in message_delta.
      if (u) {
        const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : undefined);
        const it = n("input_tokens");
        if (it !== undefined) s.usage.inputTokens = it;
        const cr = n("cache_read_input_tokens");
        if (cr !== undefined) s.usage.cacheReadTokens = cr;
        const cw = n("cache_creation_input_tokens");
        if (cw !== undefined && s.usage.cacheWrite1hTokens === 0) s.usage.cacheWrite5mTokens = cw;
      }
      const d = evt.delta as Record<string, unknown> | undefined;
      if (d && typeof d.stop_reason === "string") s.stopReason = d.stop_reason;
      break;
    }
    case "message_stop":
      s.sawMessageStop = true;
      break;
    case "error": {
      const e = evt.error as Record<string, unknown> | undefined;
      s.errorType = (e && typeof e.type === "string" ? e.type : "error") as string;
      break;
    }
    default:
      break;
  }
}

/** For non-streaming responses. */
export function summaryFromMessage(msg: Record<string, unknown>): StreamSummary {
  return {
    usage: usageFromApi(msg.usage as Record<string, unknown> | undefined),
    model: typeof msg.model === "string" ? msg.model : undefined,
    stopReason: typeof msg.stop_reason === "string" ? msg.stop_reason : undefined,
    sawMessageStop: true,
  };
}
