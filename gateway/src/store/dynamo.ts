/**
 * DynamoDB-backed store for the Fargate deployment. Per-request detail lives in
 * CloudWatch Logs (EMF lines); this store keeps daily aggregates for budgets and
 * reports, plus an in-memory ring buffer so the admin UI can show recent requests
 * and sessions seen by this task.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Policy } from "../policy-state.js";
import { aggregate, dayKey, hitPct, lastDays, monthKey, ZERO_TOTALS, type AuditEvent, type AuditStore, type BreakdownRow, type DailyTotals, type DeveloperRecord, type KeyStore, type Overview, type PolicyStore, type RequestRecord, type Store, type UsageStore } from "./types.js";

const POLICY_KEY = "POLICY#v1";

export class DynamoStore implements Store {
  readonly kind = "dynamo" as const;
  readonly keys: KeyStore;
  readonly usage: UsageStore;
  readonly policy: PolicyStore;
  readonly audit: AuditStore;
  private readonly ring: RequestRecord[] = [];
  private readonly ringMax = 2000;
  private readonly budgetCache = new Map<string, { totals: DailyTotals; expires: number }>();

  constructor(region: string, keysTable: string, usageTable: string) {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
    const ring = this.ring;
    const ringMax = this.ringMax;
    const budgetCache = this.budgetCache;

    const toDev = (item: Record<string, unknown>): DeveloperRecord => ({
      developerId: item.developerId as string,
      keyHash: item.keyHash as string,
      enabled: item.enabled !== false,
      team: typeof item.team === "string" ? item.team : undefined,
      dailyBudgetUsd: typeof item.dailyBudgetUsd === "number" ? item.dailyBudgetUsd : undefined,
      dailyTokenLimit: typeof item.dailyTokenLimit === "number" ? item.dailyTokenLimit : undefined,
      allowedModels: Array.isArray(item.allowedModels) && item.allowedModels.length ? (item.allowedModels as string[]) : undefined,
      upstreamMode: item.upstreamMode === "mantle" || item.upstreamMode === "runtime" ? item.upstreamMode : undefined,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
      revokedAt: typeof item.revokedAt === "string" ? item.revokedAt : undefined,
    });

    const hashesFor = async (developerId: string): Promise<string[]> => {
      const res = await ddb.send(
        new ScanCommand({ TableName: keysTable, FilterExpression: "developerId = :d", ExpressionAttributeValues: { ":d": developerId }, ProjectionExpression: "keyHash" }),
      );
      return (res.Items ?? []).map((i) => i.keyHash as string);
    };

    this.keys = {
      async lookupByHash(keyHash) {
        const res = await ddb.send(new GetCommand({ TableName: keysTable, Key: { keyHash } }));
        const item = res.Item as Record<string, unknown> | undefined;
        return item && typeof item.developerId === "string" ? toDev(item) : null;
      },
      async list() {
        const out: DeveloperRecord[] = [];
        let ExclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const res = await ddb.send(new ScanCommand({ TableName: keysTable, ExclusiveStartKey }));
          for (const it of res.Items ?? []) if (typeof it.developerId === "string") out.push(toDev(it as Record<string, unknown>));
          ExclusiveStartKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
        } while (ExclusiveStartKey);
        return out.sort((a, b) => a.developerId.localeCompare(b.developerId));
      },
      async create(rec) {
        await ddb.send(
          new PutCommand({
            TableName: keysTable,
            Item: { ...rec, createdAt: rec.createdAt ?? new Date().toISOString() },
            ConditionExpression: "attribute_not_exists(keyHash)",
          }),
        );
      },
      async setEnabled(developerId, enabled) {
        const hashes = await hashesFor(developerId);
        for (const keyHash of hashes) {
          await ddb.send(
            new UpdateCommand({
              TableName: keysTable,
              Key: { keyHash },
              UpdateExpression: enabled ? "SET enabled = :e REMOVE revokedAt" : "SET enabled = :e, revokedAt = :t",
              ExpressionAttributeValues: enabled ? { ":e": true } : { ":e": false, ":t": new Date().toISOString() },
            }),
          );
        }
        return hashes.length;
      },
      async disableOthers(developerId, keepHash) {
        const hashes = (await hashesFor(developerId)).filter((h) => h !== keepHash);
        for (const keyHash of hashes) {
          await ddb.send(new UpdateCommand({ TableName: keysTable, Key: { keyHash }, UpdateExpression: "SET enabled = :e, revokedAt = :t", ExpressionAttributeValues: { ":e": false, ":t": new Date().toISOString() } }));
        }
        return hashes.length;
      },
      async update(developerId, patch) {
        const hashes = await hashesFor(developerId);
        const sets: string[] = [];
        const vals: Record<string, unknown> = {};
        if (patch.dailyBudgetUsd !== undefined) {
          sets.push("dailyBudgetUsd = :b");
          vals[":b"] = patch.dailyBudgetUsd;
        }
        if (patch.dailyTokenLimit !== undefined) {
          sets.push("dailyTokenLimit = :tl");
          vals[":tl"] = patch.dailyTokenLimit;
        }
        if (patch.team !== undefined) {
          sets.push("team = :tm");
          vals[":tm"] = patch.team;
        }
        const removes: string[] = [];
        if (patch.allowedModels !== undefined) {
          if (patch.allowedModels.length) {
            sets.push("allowedModels = :am");
            vals[":am"] = patch.allowedModels;
          } else removes.push("allowedModels");
        }
        if (patch.upstreamMode !== undefined) {
          if (patch.upstreamMode) {
            sets.push("upstreamMode = :um");
            vals[":um"] = patch.upstreamMode;
          } else removes.push("upstreamMode");
        }
        if (!sets.length && !removes.length) return 0;
        const expr = `${sets.length ? `SET ${sets.join(", ")}` : ""}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`.trim();
        for (const keyHash of hashes) {
          await ddb.send(new UpdateCommand({ TableName: keysTable, Key: { keyHash }, UpdateExpression: expr, ExpressionAttributeValues: Object.keys(vals).length ? vals : undefined }));
        }
        return hashes.length;
      },
    };

    this.usage = {
      async record(r) {
        ring.push(r);
        if (ring.length > ringMax) ring.splice(0, ring.length - ringMax);
        const now = new Date(r.ts);
        const micros = Math.round(r.costUsd * 1_000_000);
        const savedMicros = Math.round((r.savedUsd ?? 0) * 1_000_000);
        const keys = [
          { pk: `DEV#${r.developerId}`, sk: `DAY#${dayKey(now)}` },
          { pk: `DEV#${r.developerId}`, sk: `MONTH#${monthKey(now)}` },
          { pk: `ALL`, sk: `DAY#${dayKey(now)}` },
          { pk: `DEV#${r.developerId}`, sk: `DAY#${dayKey(now)}#MODEL#${r.model}` },
          { pk: `MODEL#${r.model}`, sk: `DAY#${dayKey(now)}` },
        ];
        await Promise.all(
          keys.map((k) =>
            ddb.send(
              new UpdateCommand({
                TableName: usageTable,
                Key: k,
                UpdateExpression:
                  "ADD requests :r, costMicros :c, savedMicros :s, inputTokens :i, cacheReadTokens :cr, cacheWriteTokens :cw, outputTokens :o SET updatedAt = :t, developerId = :d, model = :m",
                ExpressionAttributeValues: {
                  ":r": 1,
                  ":c": micros,
                  ":s": savedMicros,
                  ":i": r.usage.inputTokens,
                  ":cr": r.usage.cacheReadTokens,
                  ":cw": r.usage.cacheWrite5mTokens + r.usage.cacheWrite1hTokens,
                  ":o": r.usage.outputTokens,
                  ":t": now.toISOString(),
                  ":d": r.developerId,
                  ":m": r.model,
                },
              }),
            ),
          ),
        );
        const c = budgetCache.get(r.developerId);
        if (c) c.totals.costUsd += r.costUsd;
      },
      async todayTotals(developerId) {
        const now = Date.now();
        const c = budgetCache.get(developerId);
        if (c && c.expires > now) return c.totals;
        const res = await ddb.send(new GetCommand({ TableName: usageTable, Key: { pk: `DEV#${developerId}`, sk: `DAY#${dayKey()}` } }));
        const it = (res.Item ?? {}) as Record<string, number>;
        const totals: DailyTotals = {
          requests: it.requests ?? 0,
          costUsd: (it.costMicros ?? 0) / 1_000_000,
          savedUsd: (it.savedMicros ?? 0) / 1_000_000,
          inputTokens: it.inputTokens ?? 0,
          cacheReadTokens: it.cacheReadTokens ?? 0,
          cacheWriteTokens: it.cacheWriteTokens ?? 0,
          outputTokens: it.outputTokens ?? 0,
        };
        budgetCache.set(developerId, { totals, expires: now + 30_000 });
        return totals;
      },
      async overview(day) {
        // Authoritative per-developer and per-model totals from DynamoDB; class/hour/session detail from this task's ring buffer.
        const scan = async (prefix: string, sk: string): Promise<BreakdownRow[]> => {
          const res = await ddb.send(
            new ScanCommand({
              TableName: usageTable,
              FilterExpression: "begins_with(pk, :p) AND sk = :sk",
              ExpressionAttributeValues: { ":p": prefix, ":sk": sk },
            }),
          );
          return (res.Items ?? [])
            .map((it) => {
              const t: DailyTotals = {
                requests: (it.requests as number) ?? 0,
                costUsd: ((it.costMicros as number) ?? 0) / 1_000_000,
                savedUsd: ((it.savedMicros as number) ?? 0) / 1_000_000,
                inputTokens: (it.inputTokens as number) ?? 0,
                cacheReadTokens: (it.cacheReadTokens as number) ?? 0,
                cacheWriteTokens: (it.cacheWriteTokens as number) ?? 0,
                outputTokens: (it.outputTokens as number) ?? 0,
              };
              return { key: (it.pk as string).slice(prefix.length), ...t, cacheHitPct: hitPct(t) };
            })
            .sort((a, b) => b.costUsd - a.costUsd);
        };
        const [byDeveloper, byModel] = await Promise.all([scan("DEV#", `DAY#${day}`), scan("MODEL#", `DAY#${day}`)]);
        const mem = aggregate(day, ring.filter((r) => r.ts.startsWith(day)), "dynamo+memory");
        const totals = byDeveloper.reduce<DailyTotals>(
          (a, r) => ({
            requests: a.requests + r.requests,
            costUsd: a.costUsd + r.costUsd,
            savedUsd: a.savedUsd + r.savedUsd,
            inputTokens: a.inputTokens + r.inputTokens,
            cacheReadTokens: a.cacheReadTokens + r.cacheReadTokens,
            cacheWriteTokens: a.cacheWriteTokens + r.cacheWriteTokens,
            outputTokens: a.outputTokens + r.outputTokens,
          }),
          ZERO_TOTALS(),
        );
        return { ...mem, byDeveloper, byModel, totals: { ...totals, cacheHitPct: hitPct(totals), developers: byDeveloper.length } } satisfies Overview;
      },
      async recentRequests(f) {
        const src = ring.filter(
          (r) =>
            (!f.developerId || r.developerId === f.developerId) &&
            (!f.sessionId || r.sessionId === f.sessionId) &&
            (!f.requestClass || r.requestClass === f.requestClass) &&
            (!f.model || r.model === f.model || r.requestedModel === f.model) &&
            (!f.errorsOnly || r.status >= 400 || !!r.errorType),
        );
        return src.slice(-Math.min(f.limit, ringMax)).reverse();
      },
      async trend(days) {
        const keys = lastDays(days);
        const res = await ddb.send(
          new QueryCommand({ TableName: usageTable, KeyConditionExpression: "pk = :p AND sk BETWEEN :a AND :b", ExpressionAttributeValues: { ":p": "ALL", ":a": `DAY#${keys[0]}`, ":b": `DAY#${keys.at(-1)}` } }),
        );
        const byDay = new Map((res.Items ?? []).map((it) => [String(it.sk).slice(4), it as Record<string, number>]));
        return keys.map((day) => {
          const it = byDay.get(day);
          if (!it) return { day, ...ZERO_TOTALS(), developers: 0 };
          return {
            day,
            requests: it.requests ?? 0,
            costUsd: (it.costMicros ?? 0) / 1_000_000,
            savedUsd: (it.savedMicros ?? 0) / 1_000_000,
            inputTokens: it.inputTokens ?? 0,
            cacheReadTokens: it.cacheReadTokens ?? 0,
            cacheWriteTokens: it.cacheWriteTokens ?? 0,
            outputTokens: it.outputTokens ?? 0,
            developers: 0, // not tracked in the ALL aggregate
          };
        });
      },
    };

    this.audit = {
      async record(e) {
        await ddb.send(new PutCommand({ TableName: usageTable, Item: { pk: "AUDIT", sk: `${e.ts}#${Math.random().toString(36).slice(2, 8)}`, ...e } }));
      },
      async list(limit) {
        const res = await ddb.send(new QueryCommand({ TableName: usageTable, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "AUDIT" }, ScanIndexForward: false, Limit: Math.max(1, Math.min(limit, 1000)) }));
        return (res.Items ?? []).map((it) => ({ ts: it.ts as string, action: it.action as string, target: it.target as string | undefined, details: it.details as Record<string, unknown> | undefined }) satisfies AuditEvent);
      },
    };

    this.policy = {
      async load() {
        const res = await ddb.send(new GetCommand({ TableName: keysTable, Key: { keyHash: POLICY_KEY } }));
        const it = res.Item as Record<string, unknown> | undefined;
        return it && typeof it.policyJson === "string" ? (JSON.parse(it.policyJson) as Policy) : null;
      },
      async save(p) {
        await ddb.send(new PutCommand({ TableName: keysTable, Item: { keyHash: POLICY_KEY, policyJson: JSON.stringify(p), updatedAt: new Date().toISOString() } }));
      },
    };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
