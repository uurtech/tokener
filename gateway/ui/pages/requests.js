import { $, $$, api, esc, fmtUsd, fmtInt, fmtMs, shortModel, pill, downloadCsv, emptyState, skeleton } from "../lib.js";

export async function render(main, params, { navigate }) {
  const f = { developer: params.get("developer") || "", class: params.get("class") || "", model: params.get("model") || "", session: params.get("session") || "", errors: params.get("errors") === "1", limit: params.get("limit") || "200" };
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Requests</h1><p class="muted">Every call that passed through the gateway: who, which model, what the policy changed, what it cost. Content is never stored.</p></div>
      <div class="page-actions">
        <label class="switch-row small"><input type="checkbox" id="live" class="switch"><span>Live (10s)</span></label>
        <button id="csv" class="ghost">Export CSV</button>
      </div>
    </div>
    <div class="card filterbar">
      <input id="fDev" class="search" placeholder="developer" value="${esc(f.developer)}">
      <select id="fClass"><option value="">any class</option>${["main", "subagent", "auxiliary", "compaction", "unknown"].map((c) => `<option ${f.class === c ? "selected" : ""}>${c}</option>`).join("")}</select>
      <input id="fModel" class="search" placeholder="model id or alias" value="${esc(f.model)}">
      <input id="fSess" class="search mono" placeholder="session id" value="${esc(f.session)}">
      <label class="check"><input type="checkbox" id="fErr" ${f.errors ? "checked" : ""}> errors only</label>
      <select id="fLimit">${["100", "200", "500", "1000"].map((n) => `<option ${f.limit === n ? "selected" : ""}>${n}</option>`).join("")}</select>
      <button id="apply">Apply</button>
      <button id="clear" class="ghost">Clear</button>
    </div>
    <div class="card table-card"><div class="scroll" id="tbl">${skeleton(6)}</div></div>`;

  const apply = () => navigate("requests", Object.fromEntries(Object.entries({
    developer: $("#fDev").value.trim(), class: $("#fClass").value, model: $("#fModel").value.trim(), session: $("#fSess").value.trim(), errors: $("#fErr").checked ? "1" : "", limit: $("#fLimit").value,
  }).filter(([, v]) => v)));
  $("#apply").addEventListener("click", apply);
  $$(".filterbar input").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); }));
  $("#clear").addEventListener("click", () => navigate("requests"));

  let rows = [];
  const load = async () => {
    const q = new URLSearchParams({ limit: f.limit });
    if (f.developer) q.set("developer", f.developer);
    if (f.class) q.set("class", f.class);
    if (f.model) q.set("model", f.model);
    if (f.session) q.set("session", f.session);
    if (f.errors) q.set("errors", "1");
    rows = await api(`/requests?${q}`);
    draw();
  };
  const draw = () => {
    if (!rows.length) { $("#tbl").innerHTML = emptyState("No requests match", "Loosen the filters or wait for traffic."); return; }
    const sum = rows.reduce((a, r) => ({ cost: a.cost + r.costUsd, saved: a.saved + (r.savedUsd || 0), out: a.out + r.usage.outputTokens }), { cost: 0, saved: 0, out: 0 });
    $("#tbl").innerHTML = `<table class="data mono compact">
      <thead><tr><th>Time (UTC)</th><th>Developer</th><th>Class</th><th>Model</th><th>Session</th><th class="num">Input</th><th class="num">Cache rd</th><th class="num">Cache wr</th><th class="num">Output</th><th class="num">Cost</th><th class="num">Saved</th><th class="num">Latency</th><th>Status</th><th>Policy</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="clickable" data-i="${i}">
        <td>${r.ts.slice(11, 19)}</td><td>${esc(r.developerId)}</td><td>${esc(r.requestClass)}</td>
        <td title="requested ${esc(r.requestedModel)}">${esc(shortModel(r.model))}${r.requestedModel && shortModel(r.requestedModel) !== shortModel(r.model) ? ` <span class="muted">← ${esc(shortModel(r.requestedModel))}</span>` : ""}</td>
        <td title="${esc(r.sessionId || "")}">${esc((r.sessionId || "-").slice(0, 8))}</td>
        <td class="num">${fmtInt(r.usage.inputTokens)}</td><td class="num">${fmtInt(r.usage.cacheReadTokens)}</td><td class="num">${fmtInt(r.usage.cacheWrite5mTokens + r.usage.cacheWrite1hTokens)}</td><td class="num">${fmtInt(r.usage.outputTokens)}</td>
        <td class="num">${fmtUsd(r.costUsd)}</td><td class="num ${r.savedUsd ? "good" : "muted"}">${r.savedUsd ? fmtUsd(r.savedUsd) : "–"}</td><td class="num">${fmtMs(r.latencyMs)}</td>
        <td>${pill(r.status + (r.errorType ? ` ${r.errorType}` : ""), r.status < 400 && !r.errorType ? "on" : "off")}</td>
        <td class="muted">${r.notes.map((n) => `<span class="note">${esc(n)}</span>`).join(" ")}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="9">${rows.length} requests</td><td class="num">${fmtUsd(sum.cost)}</td><td class="num good">${sum.saved ? fmtUsd(sum.saved) : "–"}</td><td colspan="3" class="muted">${fmtInt(sum.out)} output tokens</td></tr></tfoot></table>`;
    $$("#tbl tbody tr").forEach((tr) => tr.addEventListener("click", () => {
      const r = rows[Number(tr.dataset.i)];
      const open = tr.nextElementSibling?.classList.contains("detail");
      $$("#tbl tr.detail").forEach((d) => d.remove());
      if (open) return;
      const d = document.createElement("tr"); d.className = "detail";
      d.innerHTML = `<td colspan="14"><div class="detail-grid">
        <div><small>Requested → served</small><b>${esc(r.requestedModel || "-")} → ${esc(r.model)}</b></div>
        <div><small>Stream</small><b>${r.stream ? "SSE" : "JSON"}</b></div>
        <div><small>Team</small><b>${esc(r.team || "-")}</b></div>
        <div><small>Session</small><b class="mono">${esc(r.sessionId || "-")}</b> <a class="link-btn" href="#/sessions?session=${encodeURIComponent(r.sessionId || "")}&day=${r.ts.slice(0, 10)}">open →</a></div>
        <div><small>Transforms</small><b>${r.notes.length ? r.notes.map(esc).join(", ") : "none"}</b></div>
        <div><small>Tokens</small><b>${fmtInt(r.usage.inputTokens)} in · ${fmtInt(r.usage.cacheReadTokens)} cache rd · ${fmtInt(r.usage.cacheWrite5mTokens + r.usage.cacheWrite1hTokens)} cache wr · ${fmtInt(r.usage.outputTokens)} out</b></div>
      </div></td>`;
      tr.after(d);
    }));
  };
  $("#csv").addEventListener("click", () => downloadCsv(`tokener-requests-${new Date().toISOString().slice(0, 10)}.csv`, [
    ["ts", "developer", "team", "class", "requestedModel", "model", "session", "status", "errorType", "latencyMs", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "costUsd", "savedUsd", "notes"],
    ...rows.map((r) => [r.ts, r.developerId, r.team, r.requestClass, r.requestedModel, r.model, r.sessionId, r.status, r.errorType, r.latencyMs, r.usage.inputTokens, r.usage.cacheReadTokens, r.usage.cacheWrite5mTokens + r.usage.cacheWrite1hTokens, r.usage.outputTokens, r.costUsd, r.savedUsd || 0, r.notes.join(" ")]),
  ]));
  let timer;
  $("#live").addEventListener("change", (e) => { clearInterval(timer); if (e.target.checked) timer = setInterval(load, 10_000); });
  await load();
  return { destroy: () => clearInterval(timer) };
}
