import { $, $$, api, esc, fmtUsd, fmtInt, fmtK, fmtAgo, pill, chip, kpi, toast, confirmDialog, openDrawer, emptyState, skeleton } from "../lib.js";

const STRATEGIES = [
  ["session", "Per session", "new sessions rotate, each stays on its key: prompt cache stays warm"],
  ["round-robin", "Round-robin", "every request goes to the next key"],
  ["fill-first", "Fill first", "use keys in priority order, spill over when one runs out"],
  ["least-used", "Least used", "the key with the fewest tokens today"],
];
const STATUS = {
  active: ["active", "on"], parked: ["near limit", "warn"], cooling: ["cooling down", "off"], capped: ["daily cap hit", "warn"], disabled: ["disabled", ""], error: ["error", "off"],
};
const REASONS_EXTRA = { "near_limit:rpm": "near its requests/min quota", "near_limit:tpm": "near its tokens/min quota" };
const REASONS = { rate_limited: "rate limited (429)", overloaded: "overloaded", auth_failed: "key rejected (401)", forbidden: "forbidden (403)", credit_exhausted: "out of credit", upstream_error: "upstream 5xx", network: "network error", decrypt_failed: "cannot decrypt" };
const reasonText = (r) => (!r ? "" : REASONS_EXTRA[r] || (r.startsWith("near_limit:") ? `${r.slice(11)} bucket under threshold` : REASONS[r] || r));
const fmtSec = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

let data = null;

export async function render(main, params) {
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Upstream keys</h1><p class="muted">Put several Anthropic and/or Amazon Bedrock API keys behind this one gateway. Developers keep a single URL and token; when a key hits its rate limit, runs out of credit or reaches its daily cap, the next request (and the failed one) moves to another key without the developer noticing.</p></div>
      <div class="page-actions"><button id="new">+ Add key</button></div>
    </div>
    <div class="tiles tiles-4">${kpi("kAvail", "Keys available", "active or near limit")}${kpi("kReq", "Requests today", "served by pool keys")}${kpi("kFail", "Failovers today", "retried on another key")}${kpi("kTok", "Tokens today", "all pool keys")}</div>
    <div class="card pool-card"><h2>Rotation</h2><form id="poolForm" class="pool-form">
      <div class="segmented cols-4" role="radiogroup">${STRATEGIES.map(([v, t, d]) => `<label><input type="radio" name="strategy" value="${v}"><span><b>${t}</b><small>${d}</small></span></label>`).join("")}</div>
      <div class="pool-row">
        <label>Park a key below <input name="softLimitPct" type="number" min="0" max="50" step="1"> % remaining <small class="muted">Anthropic rate-limit headers; 0 = only react to 429s</small></label>
        <label>Max attempts per request <input name="maxAttempts" type="number" min="1" max="20" step="1"> <small class="muted">first try + failovers</small></label>
        <label class="switch-row"><input type="checkbox" name="envFallback" class="switch"><span><b>Fall back to gateway credentials</b><small id="envLabel"></small></span></label>
        <button type="submit" id="savePool">Save</button>
      </div></form></div>
    <div class="card table-card"><div class="scroll" id="tbl">${skeleton(4)}</div></div>
    <p class="muted small">Keys are encrypted at rest (AES-256-GCM<span id="encMode"></span>) and never shown again after saving. Request errors such as a malformed body are not retried; only key-level failures are. A request that has already started streaming is never switched. Rate and spend limits apply per Anthropic organization and per AWS account and region: keys from the same org share one limit, keys from separate orgs or accounts add up.</p>`;

  $("#new").addEventListener("click", () => openEditor(null));
  $("#poolForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      data = await api("/keys/settings", { method: "PUT", body: { strategy: f.strategy.value, softLimitPct: Number(f.softLimitPct.value), maxAttempts: Number(f.maxAttempts.value), envFallback: f.envFallback.checked } });
      toast("Rotation settings saved", "ok"); draw(true);
    } catch (err) { toast(err.message, "bad"); }
  });
  await load(true);
  if (params.get("new") === "1") openEditor(null);
  const timer = setInterval(() => load(false).catch(() => {}), 5000);
  return { destroy: () => clearInterval(timer) };
}

async function load(withForm) {
  data = await api("/keys");
  draw(withForm);
}

function draw(withForm) {
  const { keys, settings, summary, envCredential } = data;
  $("#kAvail").textContent = `${summary.available} / ${summary.total}`;
  $("#kAvailSub").textContent = summary.total ? (summary.available ? "active or near limit" : "all keys unavailable") : envCredential ? `no keys: using ${envCredential}` : "no keys yet";
  $("#kReq").textContent = fmtInt(keys.reduce((a, k) => a + k.today.requests, 0));
  $("#kFail").textContent = fmtInt(keys.reduce((a, k) => a + k.today.failovers, 0));
  $("#kTok").textContent = fmtK(keys.reduce((a, k) => a + k.today.tokens, 0));
  $("#kTokSub").textContent = `${fmtUsd(keys.reduce((a, k) => a + k.today.costUsd, 0))} estimated`;
  if (withForm) {
    const f = $("#poolForm").elements;
    f.strategy.value = settings.strategy; f.softLimitPct.value = settings.softLimitPct; f.maxAttempts.value = settings.maxAttempts; f.envFallback.checked = settings.envFallback;
    $("#envLabel").textContent = envCredential ? `${envCredential}, used only when every key is unavailable` : "none configured";
    const enc = $("#encMode"); if (enc) enc.innerHTML = data.encryption === "kms" ? " under an AWS KMS data key" : data.encryption === "secret" ? " with <code>KEY_POOL_SECRET</code>" : ", but no secret is configured";
  }
  if (!keys.length) {
    $("#tbl").innerHTML = emptyState("No upstream keys yet", `Requests use ${esc(envCredential || "the gateway's own AWS credentials")}. Add two or more Anthropic or Bedrock API keys to rotate between them and fail over automatically.`);
    return;
  }
  $("#tbl").innerHTML = `<table class="data keys-table">
    <thead><tr><th>Key</th><th>Status</th><th>Rate limit left</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Sessions</th><th class="num">Priority</th><th></th></tr></thead>
    <tbody>${keys.map((k) => {
      const [label, tone] = STATUS[k.status] || [k.status, ""];
      const cap = k.dailyTokenLimit ? ` / ${fmtK(k.dailyTokenLimit)}` : "";
      const rate = k.rate ? `<div class="usage ${k.rate.minRemainingPct < 10 ? "bad" : k.rate.minRemainingPct < 30 ? "warn" : "ok"}"><div class="usage-txt"><span>${k.rate.minRemainingPct}%</span><span class="muted">${esc(k.rate.bucket)}</span></div><div class="progress"><i style="width:${k.rate.minRemainingPct}%"></i></div></div>` : `<span class="muted small">${k.kind === "bedrock" ? "reacts to 429s" : "no data yet"}</span>`;
      return `<tr data-id="${esc(k.id)}" class="${k.enabled ? "" : "dim-row"}">
        <td><div class="key-id"><b>${esc(k.label)}</b><small>${chip(k.kind === "anthropic" ? "Anthropic" : "Bedrock", `kind ${k.kind}`)}${(k.teams || []).map((t) => chip(t, "soft")).join("")} <span class="mono">…${esc(k.last4)}</span>${k.kind === "bedrock" ? ` · ${esc(k.region || "gateway region")} · ${esc(k.api || "policy API")}` : ""}${k.source === "env" ? " · env" : ""}</small></div></td>
        <td>${pill(label, tone)}${k.cooldownSec ? ` <span class="muted small">${fmtSec(k.cooldownSec)}</span>` : ""}<small class="block muted" title="${esc(k.lastError || "")}">${esc(reasonText(k.reason))}${k.lastUsedAt ? `${k.reason ? " · " : ""}used ${fmtAgo(k.lastUsedAt)}` : ""}</small></td>
        <td style="min-width:130px">${rate}</td>
        <td class="num">${fmtInt(k.today.requests)}${k.today.failovers ? `<small class="block muted">${k.today.failovers} failover${k.today.failovers > 1 ? "s" : ""}</small>` : ""}</td>
        <td class="num">${fmtK(k.today.tokens)}<span class="muted">${cap}</span></td>
        <td class="num">${fmtUsd(k.today.costUsd)}${k.dailyBudgetUsd ? `<span class="muted"> / ${fmtUsd(k.dailyBudgetUsd)}</span>` : ""}</td>
        <td class="num">${k.activeSessions}</td>
        <td class="num">${k.priority}</td>
        <td class="actions-cell"><button class="tiny ghost" data-act="test">Test</button>${k.cooldownSec ? `<button class="tiny ghost" data-act="reset">Reset</button>` : ""}${k.source === "env" ? "" : `<button class="tiny ghost" data-act="edit">Edit</button>`}</td></tr>`;
    }).join("")}</tbody></table>`;
  $$("#tbl button[data-act]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const id = b.closest("tr").dataset.id;
    const k = keys.find((x) => x.id === id);
    if (b.dataset.act === "edit") return openEditor(k);
    b.disabled = true;
    try {
      if (b.dataset.act === "reset") { data = await api(`/keys/${encodeURIComponent(id)}/reset`, { method: "POST" }); toast(`${k.label} is back in rotation`, "ok"); draw(false); }
      else { const r = await api(`/keys/${encodeURIComponent(id)}/test`, { method: "POST" }); toast(r.ok ? `${k.label}: OK in ${r.ms}ms` : `${k.label}: ${r.status ?? ""} ${r.detail}`.slice(0, 160), r.ok ? "ok" : "bad"); await load(false); }
    } catch (err) { toast(err.message, "bad"); }
    b.disabled = false;
  }));
}

function openEditor(k) {
  const isEdit = !!k;
  const kind = k?.kind || "anthropic";
  const drawer = openDrawer({
    title: isEdit ? k.label : "Add upstream key",
    subtitle: isEdit ? `${k.kind === "anthropic" ? "Anthropic" : "Bedrock"} · …${esc(k.last4)} · added ${esc(k.createdAt.slice(0, 10))}` : "The key is tested with a free count_tokens call before it joins the rotation.",
    body: `<form id="keyForm" autocomplete="off">
      <section class="fs"><h3>Provider</h3>
        <div class="segmented cols-2" role="radiogroup">
          <label><input type="radio" name="kind" value="anthropic" ${kind === "anthropic" ? "checked" : ""} ${isEdit ? "disabled" : ""}><span><b>Anthropic API</b><small>sk-ant-… key from console.anthropic.com</small></span></label>
          <label><input type="radio" name="kind" value="bedrock" ${kind === "bedrock" ? "checked" : ""} ${isEdit ? "disabled" : ""}><span><b>Amazon Bedrock</b><small>Bedrock API key (ABSK…) from any AWS account</small></span></label>
        </div></section>
      <section class="fs"><h3>Key</h3>
        <div class="row2"><label>Label <input name="label" required maxlength="64" placeholder="team-a, account-2…" value="${esc(k?.label || "")}"></label>
        <label>Priority <input name="priority" type="number" min="0" step="1" placeholder="auto" value="${k ? k.priority : ""}"></label></div>
        <label>${isEdit ? "Replace secret (leave empty to keep)" : "Secret"} <input name="secret" type="password" ${isEdit ? "" : "required"} placeholder="${isEdit ? `…${esc(k.last4)}` : "paste the API key"}" spellcheck="false" autocomplete="new-password"></label>
        <p class="muted small">Lower priority numbers are used first by <b>Fill first</b> and win ties elsewhere.</p></section>
      <section class="fs bedrock-only"><h3>Bedrock</h3>
        <div class="row2"><label>Region <input name="region" placeholder="gateway region" value="${esc(k?.region || "")}"></label>
        <label>API <select name="api"><option value="">Policy default</option><option value="mantle" ${k?.api === "mantle" ? "selected" : ""}>Mantle (Messages API)</option><option value="runtime" ${k?.api === "runtime" ? "selected" : ""}>Runtime (InvokeModel)</option></select></label></div>
        <p class="muted small">Keys from different AWS accounts each bring their own Bedrock quota, so N accounts ≈ N× the tokens per minute.</p></section>
      <section class="fs"><h3>Teams <span class="muted small">optional</span></h3>
        <label>Reserved for teams <input name="teams" placeholder="all developers (shared key)" value="${esc((k?.teams || []).join(", "))}"></label>
        <p class="muted small">Comma separated, matching the developer's team. A reserved key serves only those teams; they use it before shared keys and overflow to shared keys when it is busy. Handy to keep each team on its own organization or AWS account.</p></section>
      <section class="fs"><h3>Provider quota per minute <span class="muted small">optional · recommended for Bedrock keys</span></h3>
        <div class="row2"><label>Tokens per minute <input name="tpmLimit" type="number" min="0" step="10000" placeholder="unknown" value="${k?.tpmLimit || ""}"></label>
        <label>Requests per minute <input name="rpmLimit" type="number" min="0" step="1" placeholder="unknown" value="${k?.rpmLimit || ""}"></label></div>
        <p class="muted small">Bedrock sends no rate-limit headers. With your account's quota here, the gateway counts usage itself and moves new work elsewhere before throttling starts.</p></section>
      <section class="fs"><h3>Daily caps <span class="muted small">optional, UTC day; the key leaves the rotation when one is reached</span></h3>
        <div class="row2"><label>Tokens <input name="dailyTokenLimit" type="number" min="0" step="100000" placeholder="no cap" value="${k?.dailyTokenLimit || ""}"></label>
        <label>Budget (USD) <input name="dailyBudgetUsd" type="number" min="0" step="1" placeholder="no cap" value="${k?.dailyBudgetUsd || ""}"></label></div></section>
      <section class="fs"><details><summary class="muted small">Advanced</summary>
        <label>Base URL <input name="baseUrl" placeholder="${kind === "anthropic" ? "https://api.anthropic.com" : "https://bedrock-mantle.<region>.api.aws/anthropic"}" value="${esc(k?.baseUrl || "")}"></label>
        <p class="muted small">Only for proxies, PrivateLink or testing.</p></details></section>
      ${isEdit ? `<section class="fs"><label class="switch-row big"><input type="checkbox" name="enabled" class="switch" ${k.enabled ? "checked" : ""}><span><b>In rotation</b><small>switch off to pause this key without deleting it</small></span></label></section>` : ""}
    </form>`,
    footer: `<div class="danger-zone">${isEdit ? `<button type="button" class="tiny danger" id="del">Delete</button>` : ""}</div><div class="spacer"></div><span id="msg" class="muted small"></span><button type="button" class="ghost" data-close>Cancel</button><button type="submit" form="keyForm" id="save">${isEdit ? "Save changes" : "Add and test"}</button>`,
  });
  const el = drawer.el;
  const form = $("#keyForm", el);
  const F = (n) => form.elements[n];
  const sync = () => { const v = form.elements.kind.value; $(".bedrock-only", el).classList.toggle("hidden", v !== "bedrock"); F("baseUrl").placeholder = v === "anthropic" ? "https://api.anthropic.com" : "https://bedrock-mantle.<region>.api.aws/anthropic"; };
  $$("input[name=kind]", el).forEach((r) => r.addEventListener("change", sync));
  sync();

  $("#del", el)?.addEventListener("click", async () => {
    if (!(await confirmDialog({ title: `Delete ${esc(k.label)}?`, body: "The key is removed from the rotation and its encrypted secret is deleted. Usage history is kept.", confirmLabel: "Delete", danger: true }))) return;
    try { await api(`/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" }); toast(`${k.label} deleted`); drawer.close(); load(false); } catch (e) { toast(e.message, "bad"); }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#msg", el), save = $("#save", el);
    const num = (n) => (F(n).value === "" ? (isEdit ? 0 : undefined) : Number(F(n).value));
    const body = { label: F("label").value.trim(), dailyTokenLimit: num("dailyTokenLimit"), dailyBudgetUsd: num("dailyBudgetUsd"), tpmLimit: num("tpmLimit"), rpmLimit: num("rpmLimit"), teams: F("teams").value.split(",").map((x) => x.trim()).filter(Boolean), baseUrl: F("baseUrl").value.trim() };
    if (F("priority").value !== "") body.priority = Number(F("priority").value);
    if (F("secret").value.trim()) body.secret = F("secret").value.trim();
    const kindVal = isEdit ? k.kind : form.elements.kind.value;
    if (kindVal === "bedrock") { body.region = F("region").value.trim(); body.api = F("api").value; }
    if (isEdit) body.enabled = F("enabled").checked; else body.kind = kindVal;
    save.disabled = true; msg.textContent = isEdit ? "" : "Testing key…";
    try {
      if (isEdit) {
        await api(`/keys/${encodeURIComponent(k.id)}`, { method: "PATCH", body });
        toast(`${body.label} updated`, "ok"); drawer.close();
      } else {
        const r = await api("/keys", { method: "POST", body });
        if (r.test && !r.test.ok) toast(`Saved, but the test failed: ${r.test.status ?? ""} ${r.test.detail}`.slice(0, 200), "bad");
        else toast(`${body.label} added${r.test ? ` · test OK in ${r.test.ms}ms` : ""}`, "ok");
        drawer.close();
      }
      load(true);
    } catch (err) { msg.textContent = err.message; }
    finally { save.disabled = false; }
  });
  F(isEdit ? "label" : "label").focus();
}
