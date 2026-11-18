/**
 * Alerts to a webhook: Slack incoming webhooks, Discord webhooks, Microsoft Teams workflows, or any
 * HTTP endpoint that accepts JSON. One payload works for all of them: `text` (Slack, Teams, generic),
 * `content` (Discord) and a structured `event` object for custom receivers.
 *
 * Each alert has a dedup key; the same key is sent at most once per `throttleMs` so a flapping key or
 * a developer hammering a blocked budget does not flood the channel. Delivery is fire-and-forget with
 * a short timeout: alerting must never slow down or fail a request.
 */

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  kind: string; // key.down | key.recovered | pool.exhausted | budget.exceeded | budget.warning | test
  severity: AlertSeverity;
  title: string;
  detail?: string;
  fields?: Record<string, string | number | undefined>;
}

export interface AlertRecord extends Alert {
  ts: string;
  delivered: boolean;
  error?: string;
}

const ICON: Record<AlertSeverity, string> = { critical: "🔴", warning: "🟠", info: "🟢" };

export function formatAlert(a: Alert, source: string): string {
  const fields = Object.entries(a.fields ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  return `${ICON[a.severity]} *tokener* (${source}) ${a.title}${a.detail ? `\n${a.detail}` : ""}${fields ? `\n${fields}` : ""}`;
}

export class Alerter {
  private readonly sent = new Map<string, number>();
  private readonly recent: AlertRecord[] = [];

  constructor(
    private readonly getUrl: () => string,
    private readonly source: string,
    private readonly log: (o: Record<string, unknown>) => void,
    private readonly opts: { throttleMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {}

  /** Last alerts (newest first), for the admin UI. */
  history(): AlertRecord[] {
    return [...this.recent].reverse();
  }

  /** Send unless the same dedup key was sent within the throttle window. Returns whether it was attempted. */
  emit(a: Alert, dedupKey = `${a.kind}:${a.title}`, throttleMs = this.opts.throttleMs ?? 15 * 60_000): boolean {
    const now = (this.opts.now ?? Date.now)();
    const last = this.sent.get(dedupKey);
    if (last !== undefined && now - last < throttleMs) return false;
    this.sent.set(dedupKey, now);
    if (this.sent.size > 5000) for (const [k, t] of this.sent) if (now - t > 24 * 3600_000) this.sent.delete(k);
    void this.deliver(a);
    return true;
  }

  /** Deliver right away (admin "send test alert"), reporting the outcome. */
  async deliver(a: Alert): Promise<AlertRecord> {
    const rec: AlertRecord = { ...a, ts: new Date((this.opts.now ?? Date.now)()).toISOString(), delivered: false };
    this.log({ event: "alert", kind: a.kind, severity: a.severity, title: a.title, ...a.fields });
    const url = this.getUrl().trim();
    if (!url) {
      rec.error = "no webhook configured";
      return this.remember(rec);
    }
    const text = formatAlert(a, this.source);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 5000);
    try {
      const r = await (this.opts.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text.slice(0, 1900), event: { ...a, source: this.source, ts: rec.ts } }),
        signal: ac.signal,
      });
      rec.delivered = r.ok;
      if (!r.ok) rec.error = `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`;
    } catch (e) {
      rec.error = (e as Error).message;
    } finally {
      clearTimeout(t);
    }
    if (rec.error) this.log({ event: "alert_failed", kind: a.kind, error: rec.error });
    return this.remember(rec);
  }

  private remember(rec: AlertRecord): AlertRecord {
    this.recent.push(rec);
    if (this.recent.length > 100) this.recent.shift();
    return rec;
  }
}

/** Webhook URL validation for the policy editor: empty, or http(s). */
export function validWebhookUrl(v: string): boolean {
  if (!v) return true;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
