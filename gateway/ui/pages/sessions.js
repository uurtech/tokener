import { $, $$, api, esc, fmtUsd, fmtInt, fmtK, fmtMs, shortModel, pill, todayUtc, emptyState, skeleton, barChart } from "../lib.js";

export async function render(main, params, { navigate }) {
  const day = params.get("day") || todayUtc();
  const selected = params.get("session") || "";
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Sessions</h1><p class="muted">A session is one Claude Code conversation. Long sessions resend their whole history every turn, so this is where cost concentrates.</p></div>
      <div class="page-actions"><label class="inline">Day (UTC) <input type="date" id="day" value="${day}"></label></div>
    </div>
    <div class="split">
      <div class="card list-card"><h2>Top sessions <span class="muted">${esc(day)}</span></h2><div id="list">${skeleton(8)}</div></div>
      <div class="card" id="detail">${selected ? skeleton(6) : emptyState("Pick a session", "Click a session on the left to see its turns, models and cost curve.")}</div>
    </div>`;
  $("#day").addEventListener("change", (e) => navigate("sessions", { day: e.target.value }));

  const o = await api(`/overview?day=${day}`);
  const sessions = o.topSessions;
  $("#list").innerHTML = sessions.length
    ? sessions.map((s) => `<div class="sess-row clickable ${s.sessionId === selected ? "active" : ""}" data-s="${esc(s.sessionId)}">
        <div><b class="mono">${esc(s.sessionId.slice(0, 12))}</b><small>${esc(s.developerId)} · ${s.requests} turns</small></div>
        <div class="num"><b>${fmtUsd(s.costUsd)}</b><small>${fmtK(s.outputTokens)} out</small></div></div>`).join("")
    : emptyState("No sessions on this day");
  $$("#list .sess-row").forEach((r) => r.addEventListener("click", () => navigate("sessions", { day, session: r.dataset.s })));

  if (selected) {
    const turns = (await api(`/requests?session=${encodeURIComponent(selected)}&limit=1000`)).reverse(); // chronological
    const el = $("#detail");
    if (!turns.length) { el.innerHTML = emptyState("Session not in the request log", "Request detail is kept for recent traffic only."); return {}; }
    const cost = turns.reduce((a, r) => a + r.costUsd, 0), saved = turns.reduce((a, r) => a + (r.savedUsd || 0), 0);
    const ctx = turns.map((r) => r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWrite5mTokens + r.usage.cacheWrite1hTokens);
    const models = [...new Set(turns.map((r) => shortModel(r.model)))];
    const classes = turns.reduce((a, r) => ((a[r.requestClass] = (a[r.requestClass] || 0) + 1), a), {});
    const first = turns[0], last = turns.at(-1);
    el.innerHTML = `
      <h2 class="mono">${esc(selected)} <button class="tiny ghost" id="copySess">copy</button></h2>
      <div class="facts">
        <div><small>Developer</small><b>${esc(first.developerId)}</b></div>
        <div><small>Turns</small><b>${turns.length}</b></div>
        <div><small>Duration</small><b>${fmtMs(new Date(last.ts) - new Date(first.ts))}</b></div>
        <div><small>Cost</small><b>${fmtUsd(cost)}</b></div>
        <div><small>Saved</small><b class="good">${saved ? fmtUsd(saved) : "–"}</b></div>
        <div><small>Context now</small><b>${fmtK(ctx.at(-1))} tokens</b></div>
        <div><small>Models</small><b>${models.map(esc).join(", ")}</b></div>
        <div><small>Classes</small><b>${Object.entries(classes).map(([k, v]) => `${k} ${v}`).join(" · ")}</b></div>
      </div>
      <h3>Context size per turn <span class="muted small">input + cache tokens sent each turn</span></h3>
      <div class="chart small" id="ctxChart"></div>
      <h3>Turns</h3>
      <div class="scroll"><table class="data mono compact"><tr><th>Time</th><th>Class</th><th>Model</th><th class="num">Context</th><th class="num">Cache hit</th><th class="num">Output</th><th class="num">Cost</th><th class="num">Latency</th><th>Status</th></tr>
      ${turns.map((r, i) => { const hit = ctx[i] ? (100 * r.usage.cacheReadTokens) / ctx[i] : 0; return `<tr><td>${r.ts.slice(11, 19)}</td><td>${esc(r.requestClass)}</td><td>${esc(shortModel(r.model))}</td><td class="num">${fmtK(ctx[i])}</td><td class="num ${hit >= 80 ? "good" : hit >= 50 ? "warn" : "bad"}">${hit.toFixed(0)}%</td><td class="num">${fmtInt(r.usage.outputTokens)}</td><td class="num">${fmtUsd(r.costUsd)}</td><td class="num">${fmtMs(r.latencyMs)}</td><td>${pill(String(r.status), r.status < 400 && !r.errorType ? "on" : "off")}</td></tr>`; }).join("")}</table></div>`;
    $("#copySess").addEventListener("click", () => navigator.clipboard.writeText(selected));
    barChart($("#ctxChart"), turns, { value: (r, i) => 0, label: () => "", height: 140 }); // placeholder sizing
    barChart($("#ctxChart"), turns.map((r, i) => ({ r, c: ctx[i], i })), {
      value: (p) => p.c, format: fmtK, height: 140, label: (p) => (turns.length <= 24 || p.i % Math.ceil(turns.length / 24) === 0 ? String(p.i + 1) : ""),
      tooltip: (p) => `<strong>turn ${p.i + 1}</strong> · ${p.r.requestClass}<br>${fmtK(p.c)} context · ${fmtInt(p.r.usage.outputTokens)} out · ${fmtUsd(p.r.costUsd)}`,
    });
  }
  return {};
}
