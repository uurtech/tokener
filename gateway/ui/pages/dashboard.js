import { $, api, esc, fmtUsd, fmtInt, fmtK, fmtPct, shortModel, barChart, lineChart, kpi, todayUtc, emptyState } from "../lib.js";

export async function render(main, params, { navigate }) {
  const day = params.get("day") || todayUtc();
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="muted">Estimated cost, savings and cache health for one UTC day, plus the two-week trend.</p></div>
      <div class="page-actions"><label class="inline">Day (UTC) <input type="date" id="day" value="${day}"></label></div>
    </div>
    <div class="tiles tiles-6">
      ${kpi("kCost", "Estimated cost")}${kpi("kSaved", "Saved by policy", "cheaper model than requested")}${kpi("kReq", "Requests")}
      ${kpi("kHit", "Cache hit", "cache read / all input")}${kpi("kOut", "Output / input", "effort footprint")}${kpi("kDev", "Active developers")}
    </div>
    <div class="grid2">
      <div class="card"><h2>Last 14 days <span class="muted">cost + savings, USD</span></h2><div class="chart" id="trend"></div><div class="legend"><span><i class="sw b"></i>cost</span><span><i class="sw b2"></i>saved</span></div></div>
      <div class="card"><h2>Hourly cost <span class="muted">${esc(day)} UTC</span></h2><div class="chart" id="hourly"></div></div>
    </div>
    <div class="grid3">
      <div class="card"><h2>By developer</h2><table id="tDev" class="data"></table></div>
      <div class="card"><h2>By model</h2><table id="tModel" class="data"></table></div>
      <div class="card"><h2>By request class</h2><table id="tClass" class="data"></table><p class="muted small">main = primary conversation · subagent · auxiliary = titles/summaries · compaction</p></div>
    </div>
    <div class="card">
      <h2>Most expensive sessions <a class="link-btn" href="#/sessions?day=${day}">all sessions →</a></h2>
      <table id="tSess" class="data"></table>
    </div>
    <p class="muted small" id="srcNote"></p>`;
  $("#day").addEventListener("change", (e) => navigate("dashboard", { day: e.target.value }));

  const [o, trend] = await Promise.all([api(`/overview?day=${day}`), api("/trend?days=14")]);
  const t = o.totals;
  const allIn = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  $("#kCost").textContent = fmtUsd(t.costUsd);
  $("#kCostSub").textContent = `${fmtK(allIn)} input · ${fmtK(t.outputTokens)} output tokens`;
  $("#kSaved").textContent = fmtUsd(t.savedUsd || 0);
  if (t.savedUsd && t.costUsd + t.savedUsd > 0) $("#kSavedSub").textContent = `${fmtPct((100 * t.savedUsd) / (t.costUsd + t.savedUsd), 0)} of what it would have cost`;
  $("#kReq").textContent = fmtInt(t.requests);
  $("#kReqSub").textContent = t.requests ? `${fmtUsd(t.costUsd / t.requests)} / request` : "";
  $("#kHit").textContent = fmtPct(t.cacheHitPct);
  $("#kHit").style.color = t.requests ? (t.cacheHitPct >= 80 ? "var(--good)" : t.cacheHitPct >= 60 ? "var(--warn)" : "var(--bad)") : "";
  $("#kOut").textContent = allIn ? fmtPct((100 * t.outputTokens) / allIn) : "–";
  $("#kDev").textContent = t.developers;
  $("#kDevSub").textContent = o.byDeveloper[0] ? `top: ${o.byDeveloper[0].key} ${fmtUsd(o.byDeveloper[0].costUsd)}` : "";

  barChart($("#trend"), trend.points, {
    value: (p) => p.costUsd, secondary: (p) => p.savedUsd,
    label: (p, i) => (i % 2 === trend.points.length % 2 ? p.day.slice(5) : ""),
    tooltip: (p) => `<strong>${p.day}</strong><br>${fmtUsd(p.costUsd)} cost · ${fmtUsd(p.savedUsd)} saved<br>${fmtInt(p.requests)} requests · ${fmtK(p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens + p.outputTokens)} tokens`,
  });
  barChart($("#hourly"), o.byHour, {
    value: (p) => p.costUsd, label: (p) => (p.hour % 3 === 0 ? String(p.hour).padStart(2, "0") : ""),
    tooltip: (p) => `<strong>${String(p.hour).padStart(2, "0")}:00 UTC</strong><br>${fmtUsd(p.costUsd)} · ${p.requests} requests`,
  });

  const breakdown = (table, head, rows, linkTo) => {
    const max = Math.max(...rows.map((r) => r.costUsd), 1e-9);
    table.innerHTML = `<tr><th>${head}</th><th>Cost</th><th class="num">Req</th><th class="num">Hit %</th><th class="num">Output</th></tr>` +
      (rows.map((r) => `<tr class="${linkTo ? "clickable" : ""}" data-key="${esc(r.key)}"><td>${esc(r.label ?? r.key)}</td><td><span class="bar" style="width:${Math.max(2, (90 * r.costUsd) / max)}px"></span>${fmtUsd(r.costUsd)}</td><td class="num">${fmtInt(r.requests)}</td><td class="num">${r.cacheHitPct.toFixed(0)}</td><td class="num">${fmtK(r.outputTokens)}</td></tr>`).join("") || `<tr><td class="muted" colspan="5">no data</td></tr>`);
    if (linkTo) table.querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => navigate("requests", linkTo(tr.dataset.key))));
  };
  breakdown($("#tDev"), "Developer", o.byDeveloper, (k) => ({ developer: k }));
  breakdown($("#tModel"), "Model", o.byModel.map((r) => ({ ...r, label: shortModel(r.key) })), (k) => ({ model: k }));
  breakdown($("#tClass"), "Class", o.byClass, (k) => ({ class: k }));

  $("#tSess").innerHTML = o.topSessions.length
    ? `<tr><th>Session</th><th>Developer</th><th class="num">Turns</th><th class="num">Output</th><th class="num">Cost</th></tr>` +
      o.topSessions.slice(0, 10).map((s) => `<tr class="clickable" data-s="${esc(s.sessionId)}"><td class="mono">${esc(s.sessionId.slice(0, 8))}</td><td>${esc(s.developerId)}</td><td class="num">${s.requests}</td><td class="num">${fmtK(s.outputTokens)}</td><td class="num">${fmtUsd(s.costUsd)}</td></tr>`).join("")
    : "";
  if (!o.topSessions.length) $("#tSess").outerHTML = emptyState("No traffic on this day", "Point a Claude Code at the gateway and requests will show up here within seconds.");
  else $("#tSess").querySelectorAll("tr.clickable").forEach((tr) => tr.addEventListener("click", () => navigate("sessions", { day, session: tr.dataset.s })));
  $("#srcNote").textContent = o.source === "dynamo+memory" ? "Developer and model totals come from DynamoDB; class, hour and session breakdowns come from this task's memory (last 2000 requests)." : "Source: local SQLite.";
  return {};
}
