/* Developer self-service page: reads GET /v1/me with the developer's own gateway token. */
import { $, esc, fmtUsd, fmtK, fmtInt, fmtPct, progress, barChart, chip, shortModel } from "/admin/lib.js";

const KEY = "tokenerDevToken";
const store = {
  get: () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } },
  set: (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* private mode */ } },
};
const theme = (() => { try { return localStorage.getItem("tokenerTheme") || "auto"; } catch { return "auto"; } })();
document.documentElement.dataset.theme = theme;

function showLogin(msg = "") {
  $("#page").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#loginErr").textContent = msg;
  $("#tokenInput").focus();
}

const until = (iso) => {
  const ms = new Date(iso).getTime() - Date.now();
  const h = Math.floor(ms / 3600_000);
  return h >= 48 ? `resets in ${Math.round(h / 24)} days` : h >= 1 ? `resets in ${h}h ${Math.floor((ms % 3600_000) / 60_000)}m` : `resets in ${Math.max(1, Math.floor(ms / 60_000))}m`;
};

async function load() {
  const token = store.get();
  if (!token) return showLogin();
  const r = await fetch("/v1/me", { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 401) { store.set(""); return showLogin("That token was not accepted. Check settings.json or ask your admin."); }
  if (!r.ok) return showLogin(`Gateway error ${r.status}`);
  const me = await r.json();
  $("#login").classList.add("hidden");
  $("#page").classList.remove("hidden");
  $("#who").textContent = me.developerId;
  $("#whoSub").textContent = `${me.team ? `team ${me.team} · ` : ""}${me.day} (UTC)`;
  $("#tToday").textContent = fmtUsd(me.today.costUsd);
  $("#tTodaySub").textContent = `${fmtInt(me.today.requests)} requests${me.today.savedUsd ? ` · ${fmtUsd(me.today.savedUsd)} saved by policy` : ""}`;
  $("#tTok").textContent = fmtK(me.today.tokens);
  $("#tTokSub").textContent = `${fmtK(me.today.outputTokens)} output`;
  $("#tMonth").textContent = fmtUsd(me.month.costUsd);
  $("#tMonthSub").textContent = `${fmtK(me.month.tokens)} tokens · ${fmtInt(me.month.requests)} requests`;
  $("#tHit").textContent = fmtPct(me.today.cacheHitPct);
  const L = me.limits;
  $("#dayLimits").innerHTML = progress(me.today.costUsd, L.dailyBudgetUsd, fmtUsd) + progress(me.today.tokens, L.dailyTokenLimit, fmtK);
  $("#monthLimits").innerHTML = progress(me.month.costUsd, L.monthlyBudgetUsd, fmtUsd) + progress(me.month.tokens, L.monthlyTokenLimit, fmtK);
  $("#dayReset").textContent = `· ${until(me.resetsAt)}`;
  $("#monthReset").textContent = `· ${until(me.monthResetsAt)}`;
  const what = { block: "requests are blocked", downgrade: "new conversations use a cheaper model", warn: "you are over the limit (warning only)" }[L.action] || "";
  $("#exceeded").classList.toggle("hidden", !me.exceeded);
  if (me.exceeded) $("#exceeded").innerHTML = `<b>You reached your ${me.exceededReason?.startsWith("month") ? "monthly" : "daily"} ${me.exceededReason?.includes("tokens") ? "token" : "budget"} limit</b>: ${esc(what)}. It ${esc(until(me.exceededReason?.startsWith("month") ? me.monthResetsAt : me.resetsAt))}.`;
  barChart($("#trend"), me.trend, {
    value: (p) => p.costUsd,
    label: (p, i) => (i % 2 === me.trend.length % 2 ? p.day.slice(5) : ""),
    tooltip: (p) => `<strong>${p.day}</strong><br>${fmtUsd(p.costUsd)} · ${fmtInt(p.requests)} requests · ${fmtK(p.tokens)} tokens`,
  });
  $("#models").innerHTML = me.allowedModels ? me.allowedModels.map((m) => chip(shortModel(m), "mono")).join("") : chip("All models served by the gateway", "soft");
}

$("#loginForm").addEventListener("submit", (e) => { e.preventDefault(); store.set($("#tokenInput").value.trim()); load(); });
$("#logout").addEventListener("click", () => { store.set(""); showLogin(); });
$("#refresh").addEventListener("click", () => load());
// Deep link from the admin console: /me/#token=cgw_... (removed from the address bar right away).
if (location.hash.startsWith("#token=")) { store.set(decodeURIComponent(location.hash.slice(7))); history.replaceState(null, "", location.pathname); }
load();
