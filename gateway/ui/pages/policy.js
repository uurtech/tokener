/* Policy editor: sectioned form with sticky section nav, live preview of the effect on real request shapes, and an unsaved-changes bar. */
import { $, $$, api, esc, fmtUsd, fmtK, shortModel, toast, debounce, getPolicy, getCatalog, invalidate, skeleton } from "../lib.js";

const SECTIONS = [["api", "Bedrock API"], ["routing", "Model routing"], ["effort", "Effort"], ["limits", "Daily limits"], ["hygiene", "Context hygiene"], ["operator", "Operator instruction"], ["map", "Model map"]];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export async function render(main) {
  main.innerHTML = `<div class="page-head"><div><h1>Policy</h1><p class="muted">How every request is shaped before it reaches Bedrock. Changes apply to the next request on every task; the preview on the right shows the effect before you save.</p></div></div>
    <div class="policy-layout">
      <nav class="section-nav" id="snav">${SECTIONS.map(([id, l]) => `<a href="#/policy" data-s="${id}">${l}</a>`).join("")}</nav>
      <form id="pf" class="policy-form">${skeleton(8)}</form>
      <aside class="preview" id="preview"><h2>Live preview <span class="muted small">what happens to a Claude Code request</span></h2>${skeleton(5)}</aside>
    </div>
    <div class="savebar hidden" id="savebar"><span id="diff" class="muted small"></span><div class="spacer"></div><button type="button" class="ghost" id="discard">Discard</button><button type="button" id="save">Save and apply</button></div>`;

  let saved = await getPolicy(true);
  let catalog = null;
  try { catalog = await getCatalog(); } catch { /* optional */ }
  const modelOptions = catalog?.models?.filter((m) => m.status === "ACTIVE").flatMap((m) => [m.id, ...m.profiles]) ?? Object.values(saved.modelMap);
  const priceOf = (id) => catalog?.models?.find((m) => m.id === id || m.profiles.includes(id) || m.aliases.includes(id))?.price ?? null;
  const main5 = priceOf(saved.modelMap["claude-opus-5-5"] ?? "anthropic.claude-opus-5-5");
  const ratio = (id) => { const p = priceOf(id); return p && main5 ? `${(main5.output / p.output).toFixed(1)}× cheaper output than Opus 5.5` : ""; };

  const form = $("#pf");
  const seg = (name, opts, cur) => `<div class="segmented" style="grid-template-columns:repeat(${opts.length},1fr)">${opts.map(([v, b, s]) => `<label><input type="radio" name="${name}" value="${v}" ${cur === v ? "checked" : ""}><span><b>${b}</b>${s ? `<small>${s}</small>` : ""}</span></label>`).join("")}</div>`;
  const modelInput = (name, value, placeholder, hint) => `<label>${hint}<input name="${name}" list="modelList" value="${esc(value)}" placeholder="${placeholder}" spellcheck="false"><small class="muted ratio" data-for="${name}">${esc(ratio(value))}</small></label>`;
  form.innerHTML = `
    <datalist id="modelList">${modelOptions.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
    <section class="card psec" id="s-api"><h2>Bedrock API</h2><p class="muted small">Developers can override this individually.</p>
      ${seg("upstreamMode", [["mantle", "Mantle", "Anthropic Messages API on Bedrock · byte-for-byte pass-through"], ["runtime", "Runtime", "classic InvokeModel · body translated, event stream → SSE"]], saved.upstreamMode)}
      <div id="prefixRow" class="${saved.upstreamMode === "runtime" ? "" : "dim"}"><label class="lbl">Inference-profile prefix <span class="muted">(runtime only)</span></label>
      ${seg("bedrockProfilePrefix", [["us", "us.", "US cross-region"], ["global", "global.", "global"], ["eu", "eu.", "EU"], ["apac", "apac.", "APAC"], ["", "none", "bare id"]], saved.bedrockProfilePrefix)}</div></section>
    <section class="card psec" id="s-routing"><h2>Model routing <span class="muted small">by request class · needs <code>CLAUDE_CODE_GATEWAY_HINT_HEADERS=1</code> on the client</span></h2>
      <div class="row3">
        ${modelInput("routeSubagentModel", saved.routeSubagentModel, "keep developer's model", "Subagent <span class='muted'>(Explore, Plan…)</span>")}
        ${modelInput("routeAuxiliaryModel", saved.routeAuxiliaryModel, "keep developer's model", "Auxiliary <span class='muted'>(titles, summaries)</span>")}
        ${modelInput("routeCompactionModel", saved.routeCompactionModel, "keep developer's model", "Compaction")}
      </div><p class="muted small">Routing is deterministic and never changes the model mid-conversation, so prompt caches and preserved thinking stay valid.</p></section>
    <section class="card psec" id="s-effort"><h2>Effort</h2>
      <div class="row2">${seg("effortMode", [["off", "Off", "leave untouched"], ["fill", "Fill", "only when absent"], ["override", "Override", "always set"]], saved.effortMode)}
      <div><label class="lbl">Default effort</label><div class="segmented" style="grid-template-columns:repeat(5,1fr)">${EFFORTS.map((e) => `<label><input type="radio" name="defaultEffort" value="${e}" ${saved.defaultEffort === e ? "checked" : ""}><span><b>${e}</b></span></label>`).join("")}</div></div></div></section>
    <section class="card psec" id="s-limits"><h2>Daily limits</h2>
      <label class="lbl">When a developer exceeds a limit</label>
      ${seg("budgetAction", [["warn", "Warn", "response header only"], ["downgrade", "Downgrade", "new conversations → fallback model"], ["block", "Block", "429 until 00:00 UTC"]], saved.budgetAction)}
      <div class="row3" style="margin-top:12px">
        ${modelInput("downgradeModel", saved.downgradeModel, "anthropic.claude-sonnet-5-5", "Fallback model")}
        <label>Default daily budget for new developers <span class="muted">(USD, 0 = none)</span><input name="defaultDailyBudgetUsd" type="number" min="0" step="1" value="${saved.defaultDailyBudgetUsd}"></label>
        <label>Default daily token limit <span class="muted">(0 = none)</span><input name="defaultDailyTokenLimit" type="number" min="0" step="100000" value="${saved.defaultDailyTokenLimit}"></label>
      </div></section>
    <section class="card psec" id="s-hygiene"><h2>Context hygiene</h2>
      <div class="row3">
        <label>tool_result cap <span class="muted">(characters, 0 = off)</span><input name="toolResultMaxChars" type="number" min="0" step="1000" value="${saved.toolResultMaxChars}"><small class="muted">20000 recommended · head and tail kept</small></label>
        <label class="switch-row big"><input type="checkbox" name="cacheTtl1h" class="switch" ${saved.cacheTtl1h ? "checked" : ""}><span><b>1-hour cache TTL</b><small>writes cost 2×; only if gaps over 5 min are common</small></span></label>
        <label class="switch-row big"><input type="checkbox" name="bridgeBedrock" class="switch" ${saved.bridgeBedrock ? "checked" : ""}><span><b>Bedrock bridging</b><small>strip fields Bedrock rejects · keep on</small></span></label>
      </div></section>
    <section class="card psec" id="s-operator"><h2>Operator instruction <span class="muted small">appended as the last system block · <span id="opCount"></span>/4000</span></h2>
      <textarea name="operatorPrompt" rows="4" placeholder="e.g. When running tests or builds, limit output with \`| tail -50\`. Use the Explore subagent for codebase discovery.">${esc(saved.operatorPrompt)}</textarea></section>
    <section class="card psec" id="s-map"><h2>Model map <span class="muted small">alias Claude Code sends → Bedrock id</span> <button type="button" class="tiny ghost" id="addRow">+ Add alias</button></h2>
      <table class="data compact map" id="mapTbl"></table></section>`;

  /* ---- model map table ---- */
  let map = Object.entries(saved.modelMap);
  const drawMap = () => {
    $("#mapTbl").innerHTML = `<tr><th>Alias</th><th>Bedrock model id</th><th></th></tr>${map.map(([a, b], i) => `<tr><td><input data-i="${i}" data-k="0" value="${esc(a)}" class="mono" spellcheck="false"></td><td><input data-i="${i}" data-k="1" value="${esc(b)}" list="modelList" class="mono" spellcheck="false"></td><td><button type="button" class="tiny ghost del" data-i="${i}">✕</button></td></tr>`).join("")}`;
    $$("#mapTbl input").forEach((inp) => inp.addEventListener("input", () => { map[Number(inp.dataset.i)][Number(inp.dataset.k)] = inp.value.trim(); onChange(); }));
    $$("#mapTbl .del").forEach((b) => b.addEventListener("click", () => { map.splice(Number(b.dataset.i), 1); drawMap(); onChange(); }));
  };
  drawMap();
  $("#addRow").addEventListener("click", () => { map.push(["", ""]); drawMap(); $$("#mapTbl input").at(-2).focus(); });

  /* ---- read form -> draft ---- */
  const F = (n) => form.elements[n];
  const draft = () => ({
    upstreamMode: F("upstreamMode").value, bedrockProfilePrefix: F("bedrockProfilePrefix").value,
    modelMap: Object.fromEntries(map.filter(([a, b]) => a && b)),
    routeSubagentModel: F("routeSubagentModel").value.trim(), routeAuxiliaryModel: F("routeAuxiliaryModel").value.trim(), routeCompactionModel: F("routeCompactionModel").value.trim(),
    effortMode: F("effortMode").value, defaultEffort: F("defaultEffort").value, operatorPrompt: F("operatorPrompt").value,
    cacheTtl1h: F("cacheTtl1h").checked, toolResultMaxChars: Number(F("toolResultMaxChars").value || 0), bridgeBedrock: F("bridgeBedrock").checked,
    budgetAction: F("budgetAction").value, downgradeModel: F("downgradeModel").value.trim(),
    defaultDailyBudgetUsd: Number(F("defaultDailyBudgetUsd").value || 0), defaultDailyTokenLimit: Number(F("defaultDailyTokenLimit").value || 0),
    pricing: saved.pricing,
  });
  const LABELS = { upstreamMode: "API", bedrockProfilePrefix: "profile prefix", modelMap: "model map", routeSubagentModel: "subagent routing", routeAuxiliaryModel: "auxiliary routing", routeCompactionModel: "compaction routing", effortMode: "effort mode", defaultEffort: "default effort", operatorPrompt: "operator instruction", cacheTtl1h: "cache TTL", toolResultMaxChars: "tool_result cap", bridgeBedrock: "bridging", budgetAction: "limit action", downgradeModel: "fallback model", defaultDailyBudgetUsd: "default budget", defaultDailyTokenLimit: "default token limit" };
  const changedKeys = (d) => Object.keys(LABELS).filter((k) => JSON.stringify(d[k]) !== JSON.stringify(saved[k]));

  /* ---- preview ---- */
  const renderPreview = (pv, d) => {
    const cls = (c) => pv.classes.find((x) => x.requestClass === c);
    $("#preview").innerHTML = `<h2>Live preview <span class="muted small">what happens to a Claude Code request</span></h2>
      <div class="pv-grid">${pv.classes.map((c) => `<div class="pv-card">
        <div class="pv-head"><b>${esc(c.requestClass)}</b>${c.servedModel !== c.requestedModel.replace(/^claude-/, "anthropic.claude-") && !c.servedModel.endsWith(c.requestedModel.replace(/^claude/, "anthropic.claude")) ? `<span class="chip soft">routed</span>` : ""}</div>
        <div class="pv-model"><span class="muted">${esc(c.requestedModel)}</span> → <b class="mono">${esc(shortModel(c.servedModel))}</b>${/^(us|global|eu|apac)\./.test(c.servedModel) ? `<small class="muted"> ${esc(c.servedModel.split(".")[0])}. profile</small>` : ""}</div>
        <ul class="pv-facts">
          <li><span>API</span><b>${esc(c.api)}</b></li>
          <li><span>effort</span><b>${c.effort ? esc(c.effort) : "untouched"}</b></li>
          <li><span>cache TTL</span><b>${esc(c.cacheTtl)}</b></li>
          <li><span>tool_result (60k chars)</span><b>${c.toolResultChars < 60000 ? `→ ${fmtK(c.toolResultChars)} chars` : "unchanged"}</b></li>
          <li><span>operator prompt</span><b>${c.operatorPromptAppended ? "appended" : "none"}</b></li>
          <li><span>betas</span><b class="mono small" title="${esc(c.betaHeader)}">${esc(c.betaHeader || "none")}</b></li>
        </ul></div>`).join("")}</div>
      <p class="muted small">Sample request: Opus 5.5, adaptive thinking, context-management + structured-output betas, a 60k-char tool result. Notes: ${esc([...new Set(pv.classes.flatMap((c) => c.notes))].join(" · ") || "no transforms")}</p>
      <div class="pv-costs"><small class="muted">Cheapest routing targets in this region:</small> ${["routeAuxiliaryModel", "routeSubagentModel"].map((k) => d[k] ? `<span class="chip mono">${esc(shortModel(d[k]))}${ratio(d[k]) ? ` <small>${esc(ratio(d[k]))}</small>` : ""}</span>` : "").join(" ")}</div>`;
  };
  const preview = debounce(async () => {
    try { renderPreview(await api("/policy/preview", { method: "POST", body: draft() }), draft()); $("#preview").classList.remove("invalid"); }
    catch (e) { $("#preview").classList.add("invalid"); $("#preview").innerHTML = `<h2>Live preview</h2><div class="card error"><b>Draft is not valid</b><p class="muted">${esc(e.details ? e.details.join("; ") : e.message)}</p></div>`; }
  }, 250);

  /* ---- change tracking ---- */
  const onChange = () => {
    const d = draft(), ch = changedKeys(d);
    $("#savebar").classList.toggle("hidden", !ch.length);
    $("#diff").textContent = ch.length ? `Unsaved: ${ch.map((k) => LABELS[k]).join(", ")}` : "";
    $("#prefixRow").classList.toggle("dim", d.upstreamMode !== "runtime");
    $("#opCount").textContent = d.operatorPrompt.length;
    $("#opCount").style.color = d.operatorPrompt.length > 4000 ? "var(--bad)" : "";
    $$(".ratio").forEach((s) => (s.textContent = ratio(F(s.dataset.for).value.trim())));
    preview();
  };
  form.addEventListener("input", onChange);
  form.addEventListener("change", onChange);
  $("#opCount").textContent = saved.operatorPrompt.length;
  preview();

  $("#discard").addEventListener("click", () => render(main));
  $("#save").addEventListener("click", async () => {
    const d = draft();
    $("#save").disabled = true;
    try {
      saved = await api("/policy", { method: "PUT", body: d });
      invalidate("policy", "config");
      toast("Policy saved and applied", "ok");
      onChange();
    } catch (e) { toast(e.details ? e.details.join("; ") : e.message, "bad"); }
    finally { $("#save").disabled = false; }
  });

  /* ---- section nav + scroll spy ---- */
  $$("#snav a").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); $(`#s-${a.dataset.s}`).scrollIntoView({ behavior: "smooth", block: "start" }); }));
  const spy = () => {
    const y = main.scrollTop + 120;
    let cur = SECTIONS[0][0];
    for (const [id] of SECTIONS) if ($(`#s-${id}`).offsetTop <= y) cur = id;
    $$("#snav a").forEach((a) => a.classList.toggle("active", a.dataset.s === cur));
  };
  main.addEventListener("scroll", spy, { passive: true });
  spy();
  return { destroy: () => main.removeEventListener("scroll", spy) };
}
