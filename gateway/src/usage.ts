/**
 * CloudWatch Embedded Metric Format: one JSON line per request on stdout. The
 * awslogs driver ships it to CloudWatch Logs, which extracts the metrics.
 */
import { priceFor } from "./pricing.js";
import type { RequestRecord } from "./store/types.js";

export function emitEmf(namespace: string, r: RequestRecord): void {
  const u = r.usage;
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: namespace,
          Dimensions: [["Developer"], ["Developer", "Model"], ["RequestClass"], ["Model"]],
          Metrics: [
            { Name: "Requests", Unit: "Count" },
            { Name: "InputTokens", Unit: "Count" },
            { Name: "CacheReadTokens", Unit: "Count" },
            { Name: "CacheWriteTokens", Unit: "Count" },
            { Name: "OutputTokens", Unit: "Count" },
            { Name: "EstimatedCostUsd", Unit: "None" },
            { Name: "LatencyMs", Unit: "Milliseconds" },
            { Name: "Errors", Unit: "Count" },
          ],
        },
      ],
    },
    Developer: r.developerId,
    Model: r.model,
    RequestClass: r.requestClass,
    Requests: 1,
    InputTokens: u.inputTokens,
    CacheReadTokens: u.cacheReadTokens,
    CacheWriteTokens: u.cacheWrite5mTokens + u.cacheWrite1hTokens,
    OutputTokens: u.outputTokens,
    EstimatedCostUsd: r.costUsd,
    LatencyMs: r.latencyMs,
    Errors: r.status >= 400 || r.errorType ? 1 : 0,
    Team: r.team ?? "-",
    RequestedModel: r.requestedModel,
    SessionId: r.sessionId ?? "-",
    Status: r.status,
    Stream: r.stream,
    Notes: r.notes.join(" "),
    ErrorType: r.errorType ?? "-",
    PriceKnown: priceFor(r.model) !== undefined,
  };
  process.stdout.write(JSON.stringify(line) + "\n");
}
