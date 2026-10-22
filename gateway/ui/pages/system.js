import { $, $$, api, esc, fmtDur, fmtAgo, pill, toast, copy, settingsSnippet, getConfig, skeleton, emptyState } from "../lib.js";

export async function render(main) {
  main.innerHTML = `
    <div class="page-head"><div><h1>System</h1><p class="muted">Runtime status, connectivity checks, the Claude Code settings template and the audit trail of admin actions.</p></div>
      <div class="page-actions"><button id="diag">Run diagnostics</button></div></div>
    <div class="grid2">
      <div class="card"><h2>Status</h2><div id="facts" class="facts">${skeleton(4)}</div></div>
      <div class="card"><h2>Diagnostics <span class="muted small" id="diagNote">store · model catalog · Bedrock round trip · Marketplace</span></h2><div id="diagOut">${emptyState("Not run yet", "Runs a free count_tokens call through the active API to prove credentials, network and model access.")}</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h2>Claude Code settings template <button class="tiny ghost" id="copySnippet">Copy</button></h2>
        <p class="muted small">Developers paste this into <code>~/.claude/settings.json</code> and replace the token. <code>/model</code> lists what this gateway serves them.</p>
        <pre class="small" id="snippet"></pre></div>
      <div class="card"><h2>Audit log <span class="muted small">admin actions, newest first</span></h2><div class="scroll" id="audit">${skeleton(6)}</div></div>
    </div>`;
  $("#snippet").textContent = settingsSnippet();
  $("#copySnippet").addEventListener("click", () => copy(settingsSnippet()));

  const c = await getConfig(true);
  $("#facts").innerHTML = [
    ["Version", `tokener ${c.version}`], ["Uptime", fmtDur(c.uptimeSec)], ["Region", c.region], ["Store", c.store],
    ["Default API", c.upstreamMode === "runtime" ? `Runtime · ${c.runtimeEndpoint}` : `Mantle · ${c.upstreamBaseUrl}`],
    ["Credentials", c.authMode === "api-key" ? "Bedrock API key" : "IAM role / SigV4"],
    ["Marketplace", c.marketplace], ["Model catalog", c.catalog.enabled ? `${c.catalog.models} models${c.catalog.error ? ` · error: ${c.catalog.error}` : ""}` : "disabled"],
    ["Node", c.node], ["Started", `${c.startedAt.replace("T", " ").slice(0, 19)} UTC`],
  ].map(([k, v]) => `<div><small>${k}</small><b>${esc(v)}</b></div>`).join("");

  $("#diag").addEventListener("click", async () => {
    $("#diag").disabled = true; $("#diagOut").innerHTML = skeleton(4);
    try {
      const r = await api("/diagnostics", { method: "POST" });
      $("#diagOut").innerHTML = `<div class="checks-list">${Object.entries(r.checks).map(([k, v]) => `<div class="check-row"><span class="dot-status ${v.ok ? "ok" : "bad"}"></span><b>${esc(k)}</b><span class="muted small">${v.ms}ms</span><span class="detail-text ${v.ok ? "" : "bad"}">${esc(v.detail)}</span></div>`).join("")}</div>`;
      $("#diagNote").textContent = `${r.ok ? "all checks passed" : "some checks failed"} · ${r.ms}ms`;
      toast(r.ok ? "All checks passed" : "Diagnostics found problems", r.ok ? "ok" : "bad");
    } catch (e) { $("#diagOut").innerHTML = emptyState("Diagnostics failed", esc(e.message)); }
    $("#diag").disabled = false;
  });

  const au = await api("/audit?limit=200");
  $("#audit").innerHTML = au.length
    ? `<table class="data compact"><tr><th>When</th><th>Action</th><th>Target</th><th>Details</th></tr>${au.map((e) => `<tr><td title="${esc(e.ts)}">${esc(fmtAgo(e.ts))}</td><td>${pill(e.action, e.action.includes("revoke") ? "off" : e.action.includes("create") || e.action.includes("enable") ? "on" : "")}</td><td>${esc(e.target || "–")}</td><td class="muted small mono">${esc(summarize(e.details))}</td></tr>`).join("")}</table>`
    : emptyState("No admin actions yet");
  return {};
}
const summarize = (d) => (d ? Object.entries(d).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : typeof v === "object" && v !== null ? JSON.stringify(v) : v}`).join("  ").slice(0, 160) : "");
