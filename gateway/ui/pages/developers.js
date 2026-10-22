import { $, $$, api, esc, fmtUsd, fmtInt, fmtK, pct, shortModel, chip, pill, progress, kpi, initials, toast, copy, confirmDialog, openDrawer, settingsSnippet, getPolicy, getCatalog, invalidate, emptyState, skeleton } from "../lib.js";

const state = { list: [], models: [], policy: null, search: "", filter: "all" };
const apiLabel = (m) => (m === "runtime" ? "Runtime" : m === "mantle" ? "Mantle" : `Policy (${state.policy?.upstreamMode === "runtime" ? "Runtime" : "Mantle"})`);

async function loadModelChoices() {
  if (state.models.length) return state.models;
  let rows = [];
  try { rows = (await getCatalog()).models.filter((m) => m.status === "ACTIVE").map((m) => ({ id: m.id, name: m.name, alias: m.aliases[0] || "", priceKnown: m.price !== null })); } catch { /* fallback below */ }
  if (!rows.length && state.policy) rows = Object.entries(state.policy.modelMap).filter(([, v], i, a) => a.findIndex(([, x]) => x === v) === i).map(([alias, id]) => ({ id, name: alias, alias, priceKnown: true }));
  const family = (id) => (/fable/.test(id) ? "Fable" : /opus/.test(id) ? "Opus" : /sonnet/.test(id) ? "Sonnet" : /haiku/.test(id) ? "Haiku" : "Other");
  const order = ["Fable", "Opus", "Sonnet", "Haiku", "Other"];
  state.models = rows.map((r) => ({ ...r, family: family(r.id) })).sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family) || b.id.localeCompare(a.id));
  return state.models;
}

export async function render(main, params) {
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Developers</h1><p class="muted">One personal token per person. Limits, Bedrock API and model access are set per developer; everything else follows the policy.</p></div>
      <div class="page-actions">
        <input id="search" class="search" type="search" placeholder="Search developers… ( / )">
        <select id="filter"><option value="all">All</option><option value="active">Active</option><option value="revoked">Revoked</option><option value="near">Near a limit</option></select>
        <button id="new">+ New developer</button>
      </div>
    </div>
    <div class="tiles tiles-4">${kpi("dvTotal", "Developers")}${kpi("dvSpend", "Spent today", "estimated, UTC day")}${kpi("dvTokens", "Tokens today", "input + cache + output")}${kpi("dvWarn", "Near a limit", "≥ 80% of budget or tokens")}</div>
    <div class="card dev-list-card"><div id="list" class="dev-list">${skeleton(5)}</div></div>`;
  $("#search").addEventListener("input", (e) => { state.search = e.target.value.trim().toLowerCase(); drawList(); });
  $("#filter").addEventListener("change", (e) => { state.filter = e.target.value; drawList(); });
  $("#new").addEventListener("click", () => openEditor(null));
  const slash = (e) => { if (e.key === "/" && !e.target.matches("input, textarea")) { e.preventDefault(); $("#search").focus(); } };
  document.addEventListener("keydown", slash);
  await load();
  if (params.get("new") === "1") openEditor(null, params.get("pick") === "1");
  return { destroy: () => document.removeEventListener("keydown", slash) };
}

async function load() {
  const [list, policy] = await Promise.all([api("/developers"), getPolicy(true)]);
  state.list = list; state.policy = policy;
  await loadModelChoices();
  const active = list.filter((d) => d.enabled);
  $("#dvTotal").textContent = list.length;
  $("#dvTotalSub").textContent = `${active.length} active · ${list.length - active.length} revoked`;
  $("#dvSpend").textContent = fmtUsd(list.reduce((a, d) => a + d.todayCostUsd, 0));
  $("#dvTokens").textContent = fmtK(list.reduce((a, d) => a + d.todayTokens, 0));
  $("#dvWarn").textContent = list.filter(near).length;
  drawList();
}
const near = (d) => pct(d.todayCostUsd, d.dailyBudgetUsd) >= 80 || pct(d.todayTokens, d.dailyTokenLimit) >= 80;

function drawList() {
  const q = state.search;
  const rows = state.list.filter((d) => (!q || d.developerId.toLowerCase().includes(q) || (d.team || "").toLowerCase().includes(q)) && (state.filter === "all" || (state.filter === "active" && d.enabled) || (state.filter === "revoked" && !d.enabled) || (state.filter === "near" && near(d))));
  const modelChips = (d) => !d.allowedModels?.length ? chip("All models", "soft") : d.allowedModels.slice(0, 2).map((m) => chip(shortModel(m), "mono")).join("") + (d.allowedModels.length > 2 ? chip(`+${d.allowedModels.length - 2}`, "soft") : "");
  $("#list").innerHTML = rows.length
    ? `<div class="dev-row head"><span>Developer</span><span>Access</span><span>Budget today</span><span>Tokens today</span><span>Status</span><span></span></div>` +
      rows.map((d) => `<div class="dev-row clickable ${d.enabled ? "" : "revoked"}" data-id="${esc(d.developerId)}">
        <div class="dev-id"><span class="avatar">${esc(initials(d.developerId))}</span><div><b>${esc(d.developerId)}</b><small>${esc(d.team || "no team")} · ${d.todayRequests} req today${d.createdAt ? ` · since ${esc(d.createdAt.slice(0, 10))}` : ""}</small></div></div>
        <div class="dev-chips">${chip(apiLabel(d.upstreamMode), `api ${d.upstreamMode || "policy"}`)}${modelChips(d)}</div>
        ${progress(d.todayCostUsd, d.dailyBudgetUsd, fmtUsd)}${progress(d.todayTokens, d.dailyTokenLimit, fmtK)}
        <div>${pill(d.enabled ? "active" : "revoked", d.enabled ? "on" : "off")}</div>
        <div class="dev-actions"><button type="button" class="tiny ghost">Edit</button></div></div>`).join("")
    : emptyState(state.list.length ? "No developer matches" : "No developers yet", state.list.length ? "" : "Create one to get a personal token and the Claude Code settings snippet.");
  $$("#list .dev-row.clickable").forEach((row) => row.addEventListener("click", () => openEditor(state.list.find((d) => d.developerId === row.dataset.id))));
}

/* ---------------- editor drawer ---------------- */
function openEditor(d, startWithPicker = false) {
  const isEdit = !!d;
  const selected = new Set(d?.allowedModels || []);
  const p = state.policy;
  const policyApi = p?.upstreamMode === "runtime" ? "Runtime" : "Mantle";
  const limitField = (name, label, step, value) => `
    <div class="limit-field">
      <label>${label}<input name="${name}" type="number" min="0" step="${step}" value="${value === undefined || value === 0 ? "" : value}" placeholder="${value === 0 ? "unlimited" : isEdit ? "0" : "policy default"}" ${value === 0 ? "disabled" : ""}></label>
      <label class="switch-row"><input type="checkbox" name="${name}Unlimited" class="switch" ${value === 0 ? "checked" : ""}><span>Unlimited</span></label>
    </div>`;
  const drawer = openDrawer({
    title: isEdit ? d.developerId : "New developer",
    subtitle: isEdit ? `${esc(d.team || "no team")} · ${d.enabled ? "active" : "revoked"}${d.createdAt ? ` · created ${d.createdAt.slice(0, 10)}` : ""}` : "Create a personal gateway token.",
    body: `<form id="devForm" autocomplete="off">
      <section class="fs"><h3>Identity</h3>
        <div class="row2"><label>Developer id <input name="developerId" required pattern="[a-zA-Z0-9._@-]{2,64}" placeholder="alice" spellcheck="false" value="${esc(d?.developerId || "")}" ${isEdit ? "readonly" : ""}></label>
        <label>Team <input name="team" placeholder="backend" value="${esc(d?.team || "")}"></label></div></section>
      <section class="fs"><h3>Daily limits <span class="muted small">UTC day · either cap trips the policy action (${esc(p?.budgetAction || "warn")})</span></h3>
        <div class="row2">${limitField("dailyBudgetUsd", "Budget (USD)", 1, d?.dailyBudgetUsd)}${limitField("dailyTokenLimit", "Tokens", 100000, d?.dailyTokenLimit)}</div>
        <p class="muted small">${isEdit ? "Set a field to 0 or switch on Unlimited to remove a cap." : p ? `Empty = policy default: ${p.defaultDailyBudgetUsd ? fmtUsd(p.defaultDailyBudgetUsd) : "no"} budget, ${p.defaultDailyTokenLimit ? fmtK(p.defaultDailyTokenLimit) : "unlimited"} tokens.` : ""}</p></section>
      <section class="fs"><h3>Bedrock API</h3>
        <div class="segmented" role="radiogroup">
          <label><input type="radio" name="upstreamMode" value="" ${!d?.upstreamMode ? "checked" : ""}><span><b>Policy default</b><small>currently ${policyApi}</small></span></label>
          <label><input type="radio" name="upstreamMode" value="mantle" ${d?.upstreamMode === "mantle" ? "checked" : ""}><span><b>Mantle</b><small>Anthropic Messages API on Bedrock</small></span></label>
          <label><input type="radio" name="upstreamMode" value="runtime" ${d?.upstreamMode === "runtime" ? "checked" : ""}><span><b>Runtime</b><small>classic InvokeModel</small></span></label>
        </div></section>
      <section class="fs"><h3>Model access</h3>
        <label class="switch-row big"><input type="checkbox" name="allModels" class="switch" ${selected.size ? "" : "checked"}><span><b>All models</b><small>may request any model served by Bedrock in this region</small></span></label>
        <div id="picker" class="model-picker ${selected.size ? "" : "hidden"}">
          <div class="picker-head"><input id="modelSearch" class="search" type="search" placeholder="Filter models…"><span class="muted small" id="pickCount"></span></div>
          <div id="groups" class="model-groups"></div>
          <p class="muted small">Aliases (<code>claude-opus-5-5</code>), dated ids and <code>us.</code>/<code>global.</code> profiles map onto these entries. Operator routing (subagent → Sonnet) is never restricted. The developer's <code>/model</code> menu shows only these.</p>
        </div></section>
      ${isEdit ? `<section class="fs"><h3>Token</h3><p class="muted small">Tokens are stored hashed and cannot be shown again. Rotating issues a fresh token and revokes the old one immediately.</p>
        <div class="row-actions"><button type="button" class="ghost" id="rotate">Rotate token</button><a class="link-btn" href="#/requests?developer=${encodeURIComponent(d.developerId)}">View requests →</a></div></section>` : ""}
      <section class="fs hidden" id="reveal"><h3>Token</h3><div class="token-card"><p><strong>Shown once.</strong> Send both to the developer; only a hash is stored.</p>
        <div class="copy-row"><code id="tokenValue" class="mono"></code><button type="button" class="tiny ghost" id="copyToken">Copy token</button></div>
        <pre id="snippetReveal" class="small"></pre><button type="button" class="tiny ghost" id="copySnippet">Copy settings.json snippet</button></div></section>
    </form>`,
    footer: `<div class="danger-zone">${isEdit ? (d.enabled ? `<button type="button" class="tiny danger" id="revoke">Revoke</button>` : `<button type="button" class="tiny ghost" id="enable">Re-enable</button>`) : ""}</div>
      <div class="spacer"></div><span id="msg" class="muted small"></span><button type="button" class="ghost" data-close>Cancel</button><button type="submit" form="devForm" id="save">${isEdit ? "Save changes" : "Create developer"}</button>`,
  });
  const el = drawer.el;
  const form = $("#devForm", el);
  const F = (n) => form.elements[n];

  for (const name of ["dailyBudgetUsd", "dailyTokenLimit"]) {
    F(`${name}Unlimited`).addEventListener("change", (e) => { F(name).disabled = e.target.checked; if (e.target.checked) F(name).value = ""; F(name).placeholder = e.target.checked ? "unlimited" : isEdit ? "0" : "policy default"; });
  }
  const renderPicker = () => {
    const all = F("allModels").checked;
    $("#picker", el).classList.toggle("hidden", all);
    if (all) return;
    const q = $("#modelSearch", el).value.trim().toLowerCase();
    const groups = {};
    for (const m of state.models) { if (q && !`${m.id} ${m.name} ${m.alias}`.toLowerCase().includes(q)) continue; (groups[m.family] ||= []).push(m); }
    $("#pickCount", el).textContent = `${selected.size} selected${selected.size ? "" : " · pick at least one"}`;
    $("#groups", el).innerHTML = Object.entries(groups).map(([fam, ms]) => `<div class="model-group"><div class="model-group-head"><b>${esc(fam)}</b><button type="button" class="link" data-fam="${esc(fam)}">${ms.every((m) => selected.has(m.id)) ? "clear" : "select all"}</button></div>
      <div class="chips">${ms.map((m) => `<button type="button" class="chip pick ${selected.has(m.id) ? "on" : ""}" data-id="${esc(m.id)}" title="${esc(m.id)}${m.priceKnown ? "" : " · no price entry"}"><span class="mono">${esc(shortModel(m.id))}</span>${m.alias ? `<small>${esc(m.alias)}</small>` : ""}</button>`).join("")}</div></div>`).join("") || `<p class="muted small">No model matches.</p>`;
    $$("#groups .pick", el).forEach((b) => b.addEventListener("click", () => { selected.has(b.dataset.id) ? selected.delete(b.dataset.id) : selected.add(b.dataset.id); renderPicker(); }));
    $$("#groups .link", el).forEach((b) => b.addEventListener("click", () => { const ms = state.models.filter((m) => m.family === b.dataset.fam); const on = ms.every((m) => selected.has(m.id)); ms.forEach((m) => (on ? selected.delete(m.id) : selected.add(m.id))); renderPicker(); }));
  };
  F("allModels").addEventListener("change", () => { if (F("allModels").checked) selected.clear(); renderPicker(); });
  $("#modelSearch", el).addEventListener("input", renderPicker);
  renderPicker();
  if (startWithPicker) F("allModels").click();

  $("#revoke", el)?.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: `Revoke ${d.developerId}?`, body: "Every token of this developer stops working within a minute. Usage history is kept; you can re-enable later.", confirmLabel: "Revoke", danger: true }))) return;
    await api(`/developers/${encodeURIComponent(d.developerId)}/revoke`, { method: "POST" }); toast(`${d.developerId} revoked`); drawer.close(); load();
  });
  $("#enable", el)?.addEventListener("click", async () => { await api(`/developers/${encodeURIComponent(d.developerId)}/enable`, { method: "POST" }); toast(`${d.developerId} re-enabled`, "ok"); drawer.close(); load(); });
  $("#rotate", el)?.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: "Rotate token?", body: "A new token is issued with the same settings and the current token is revoked at once. The developer must update settings.json.", confirmLabel: "Rotate" }))) return;
    try { const r = await api(`/developers/${encodeURIComponent(d.developerId)}/rotate`, { method: "POST" }); reveal(r.token); toast("Token rotated", "ok"); load(); } catch (e) { toast(e.message, "bad"); }
  });
  const reveal = (tok) => {
    const snippet = settingsSnippet(tok);
    $("#tokenValue", el).textContent = tok; $("#snippetReveal", el).textContent = snippet;
    $("#copyToken", el).onclick = () => copy(tok, "Token copied"); $("#copySnippet", el).onclick = () => copy(snippet, "Snippet copied");
    $("#reveal", el).classList.remove("hidden"); $("#reveal", el).scrollIntoView({ behavior: "smooth", block: "start" });
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#msg", el), save = $("#save", el);
    const limit = (name) => (F(`${name}Unlimited`).checked ? 0 : F(name).value === "" ? undefined : Number(F(name).value));
    if (!F("allModels").checked && !selected.size) { msg.textContent = "Pick at least one model or allow all."; return; }
    const body = { team: F("team").value.trim(), upstreamMode: form.elements.upstreamMode.value || null, allowedModels: F("allModels").checked ? [] : [...selected] };
    const b = limit("dailyBudgetUsd"), t = limit("dailyTokenLimit");
    if (b !== undefined) body.dailyBudgetUsd = b;
    if (t !== undefined) body.dailyTokenLimit = t;
    save.disabled = true; msg.textContent = "";
    try {
      if (isEdit) {
        await api(`/developers/${encodeURIComponent(d.developerId)}`, { method: "PATCH", body }); toast(`${d.developerId} updated`, "ok"); drawer.close();
      } else {
        body.developerId = F("developerId").value.trim();
        const r = await api("/developers", { method: "POST", body });
        reveal(r.token);
        $("#drawerTitle", el).textContent = r.developerId; $("#drawerSub", el).textContent = "Created. Copy the token now; it will not be shown again.";
        save.textContent = "Done"; save.type = "button"; save.onclick = () => drawer.close();
        form.querySelectorAll("input, button.pick").forEach((i) => (i.disabled = true));
        toast(`${r.developerId} created`, "ok");
      }
      invalidate("policy"); load();
    } catch (err) { msg.textContent = err.details ? `${err.message}: ${err.details.join("; ")}` : err.message; }
    finally { save.disabled = false; }
  });
  if (!isEdit) F("developerId").focus();
}
