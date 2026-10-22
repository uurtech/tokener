// Seed a demo SQLite db with a plausible day of traffic for UI review.
import { SqliteStore } from "../../dist/store/sqlite.js";
import { hashToken } from "../../dist/auth.js";
import { estimateCostUsd } from "../../dist/pricing.js";
const file = process.argv[2] ?? "data/demo.db";
const s = new SqliteStore(file);
const devs = [["ahmet", "backend", 25, 0], ["zeynep", "backend", 25, 3_000_000], ["mert", "frontend", 15, 0], ["elif", "frontend", 0, 1_500_000], ["can", "platform", 40, 0]];
for (const [id, team, b, tl] of devs) await s.keys.create({ developerId: id, keyHash: hashToken(`cgw_demo_${id}`), enabled: id !== "can", team, dailyBudgetUsd: b, dailyTokenLimit: tl, createdAt: "2026-10-01T09:00:00Z" });
const day = new Date().toISOString().slice(0, 10);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const models = { main: "anthropic.claude-opus-5-5", subagent: "anthropic.claude-sonnet-5-5", auxiliary: "anthropic.claude-haiku-4-5", compaction: "anthropic.claude-opus-5-5" };
for (const [id, team] of devs) {
  const sessions = 2 + Math.floor(rnd() * 4);
  for (let si = 0; si < sessions; si++) {
    const sid = `${id}-${si}-${Math.floor(rnd() * 1e6).toString(16)}`;
    const startH = 7 + Math.floor(rnd() * 9), turns = 10 + Math.floor(rnd() * 40);
    let ctx = 15000 + rnd() * 20000;
    for (let t = 0; t < turns; t++) {
      const cls = rnd() < 0.78 ? "main" : rnd() < 0.6 ? "subagent" : rnd() < 0.7 ? "auxiliary" : "compaction";
      const write = cls === "main" ? 2000 + rnd() * 8000 : 1000 + rnd() * 3000;
      ctx += write;
      const usage = { inputTokens: Math.round(300 + rnd() * 1500), cacheReadTokens: Math.round(cls === "auxiliary" ? 0 : ctx), cacheWrite5mTokens: Math.round(write), cacheWrite1hTokens: 0, outputTokens: Math.round(cls === "compaction" ? 3000 : 200 + rnd() * 1800) };
      if (rnd() < 0.08) usage.cacheReadTokens = 0, usage.cacheWrite5mTokens += Math.round(ctx); // occasional cache miss
      const model = models[cls];
      const ts = new Date(`${day}T${String(startH + Math.floor(t / 12)).padStart(2, "0")}:${String((t * 5) % 60).padStart(2, "0")}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}.000Z`);
      if (ts.getUTCHours() > 23) continue;
      await s.usage.record({ ts: ts.toISOString(), developerId: id, team, model, requestedModel: "claude-opus-5-5", requestClass: cls, sessionId: sid, status: rnd() < 0.02 ? 529 : 200, latencyMs: Math.round(1500 + rnd() * 20000), usage, costUsd: estimateCostUsd(model, usage), stream: true, notes: cls === "subagent" ? ["route:subagent->anthropic.claude-sonnet-5-5"] : cls === "auxiliary" ? ["route:auxiliary->anthropic.claude-haiku-4-5"] : [] });
    }
  }
}
await s.close();
console.log("seeded", file);
