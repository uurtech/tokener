import { $, $$, api, esc, pill, toast, getCatalog, invalidate, skeleton, emptyState } from "../lib.js";

const FIELDS = [["input", "Input"], ["output", "Output"], ["cacheWrite5m", "Cache write 5m"], ["cacheWrite1h", "Cache write 1h"], ["cacheRead", "Cache read"]];

export async function render(main) {
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Models</h1><p class="muted">Anthropic models Bedrock serves in this region, straight from the control plane. This is what developers see in <code>/model</code>. Prices drive the cost estimates; edit them if your contract differs.</p></div>
      <div class="page-actions"><span class="muted small" id="note"></span><button id="refresh" class="ghost">Refresh from Bedrock</button></div>
    </div>
    <div class="card table-card"><div class="scroll" id="tbl">${skeleton(8)}</div></div>
    <p class="muted small">USD per million tokens. Alias ids, dated ids and <code>us.</code>/<code>global.</code> profiles share one price entry per model. A model without a price shows up as $0 in every report until you set one.</p>`;
  const load = async (refresh = false) => {
    const c = await getCatalog(refresh);
    const note = $("#note");
    note.textContent = c.disabled ? "Catalog disabled (MODEL_CATALOG_ENABLED=false)" : c.error ? `Bedrock listing failed: ${c.error}` : `${c.models.length} models · ${c.region} · fetched ${(c.fetchedAt || "").replace("T", " ").slice(0, 19)} UTC`;
    note.style.color = c.error ? "var(--bad)" : "";
    if (!c.models.length) { $("#tbl").innerHTML = emptyState(c.disabled ? "Catalog disabled" : "No Anthropic models visible", c.error || "Check that the task role may call bedrock:ListFoundationModels."); return; }
    $("#tbl").innerHTML = `<table class="data compact"><thead><tr><th>Model</th><th>Status</th><th>Aliases</th><th>Inference profiles</th><th>I/O</th>${FIELDS.map(([, l]) => `<th class="num">${l}</th>`).join("")}<th></th></tr></thead><tbody>
      ${c.models.map((m, i) => `<tr data-i="${i}" class="${m.priceOverridden ? "overridden" : ""}">
        <td><b>${esc(m.name)}</b><br><span class="mono muted small">${esc(m.id)}</span></td>
        <td>${pill(m.status.toLowerCase(), m.status === "ACTIVE" ? "on" : m.status === "LEGACY" ? "" : "off")}</td>
        <td class="mono small">${m.aliases.map(esc).join("<br>") || '<span class="muted">–</span>'}</td>
        <td class="mono small">${m.profiles.map((p) => esc(p.split(".")[0])).join(", ") || '<span class="muted">–</span>'}${m.profiles.length ? ` <span class="muted">(${m.profiles.length})</span>` : ""}</td>
        <td class="muted small">${esc(m.inputModalities.join("+").toLowerCase())}→${esc(m.outputModalities.join("+").toLowerCase())}${m.streaming ? "" : " · no stream"}</td>
        ${FIELDS.map(([k]) => `<td class="num"><input class="price" data-k="${k}" type="number" min="0" step="0.01" value="${m.price ? m.price[k] : ""}" placeholder="–"></td>`).join("")}
        <td class="actions-cell"><button class="tiny save" title="Save price">Save</button>${m.priceOverridden ? `<button class="tiny ghost reset" title="Back to built-in price">Reset</button>` : ""}</td>
      </tr>`).join("")}</tbody></table>`;
    $$("#tbl tbody tr").forEach((tr) => {
      const m = c.models[Number(tr.dataset.i)];
      $(".save", tr).addEventListener("click", async () => {
        const price = {};
        for (const inp of $$(".price", tr)) { if (inp.value === "") return toast("Fill in all five prices", "bad"); price[inp.dataset.k] = Number(inp.value); }
        try { await api("/pricing", { method: "PUT", body: { [m.priceKey]: price } }); toast(`${m.name}: price saved`, "ok"); invalidate("catalog", "policy"); load(); }
        catch (e) { toast(e.message, "bad"); }
      });
      $(".reset", tr)?.addEventListener("click", async () => {
        try { await api("/pricing", { method: "PUT", body: { [m.priceKey]: null } }); toast(`${m.name}: built-in price restored`); invalidate("catalog", "policy"); load(); }
        catch (e) { toast(e.message, "bad"); }
      });
      $$(".price", tr).forEach((inp) => inp.addEventListener("input", () => tr.classList.add("dirty")));
    });
  };
  $("#refresh").addEventListener("click", () => { $("#note").textContent = "refreshing…"; load(true); });
  await load();
  return {};
}
