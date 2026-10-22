/* tokener admin console — shell, auth, hash router, theme. Pages live in ./pages/*.js (ES modules, no build step). */
import { $, $$, api, auth, setUnauthorizedHandler, toast, getConfig, esc } from "./lib.js";
import * as dashboard from "./pages/dashboard.js";
import * as requests from "./pages/requests.js";
import * as sessions from "./pages/sessions.js";
import * as developers from "./pages/developers.js";
import * as models from "./pages/models.js";
import * as policy from "./pages/policy.js";
import * as system from "./pages/system.js";

const PAGES = { dashboard, requests, sessions, developers, models, policy, system };
const NAV = [
  ["dashboard", "Dashboard", "M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6Zm10-18v6h8V3h-8Z"],
  ["requests", "Requests", "M4 6h16M4 12h16M4 18h10"],
  ["sessions", "Sessions", "M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  ["developers", "Developers", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"],
  ["models", "Models", "M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5"],
  ["policy", "Policy", "M12 3l8 4v5c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V7l8-4Zm-3 9 2 2 4-4"],
  ["system", "System", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L14.8 3H9.2l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h5.6l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z"],
];

/* ---- route parsing: #/page?x=1  (legacy: #token=..&view=..) ---- */
function parseHash() {
  let hsh = location.hash.slice(1);
  if (!hsh.startsWith("/")) {
    const p = new URLSearchParams(hsh);
    if (p.get("token")) { auth.token = p.get("token"); p.delete("token"); }
    const view = p.get("view") || "dashboard";
    p.delete("view");
    const q = p.toString();
    history.replaceState(null, "", `#/${view === "overview" ? "dashboard" : view}${q ? `?${q}` : ""}`);
    hsh = location.hash.slice(1);
  }
  const [path, query = ""] = hsh.slice(1).split("?");
  const params = new URLSearchParams(query);
  if (params.get("theme")) theme.apply(params.get("theme")); // ?theme=dark|light|auto deep link (docs screenshots, demos)
  return { page: PAGES[path] ? path : "dashboard", params };
}
export const navigate = (page, params = {}) => {
  const q = new URLSearchParams(params).toString();
  location.hash = `#/${page}${q ? `?${q}` : ""}`;
};

/* ---- theme ---- */
const theme = {
  get() { return localStorage.getItem("tokenerTheme") || "auto"; },
  apply(v) { document.documentElement.dataset.theme = v; localStorage.setItem("tokenerTheme", v); $("#themeBtn").textContent = v === "dark" ? "☾" : v === "light" ? "☀" : "◐"; $("#themeBtn").title = `Theme: ${v}`; },
  cycle() { this.apply(this.get() === "auto" ? "light" : this.get() === "light" ? "dark" : "auto"); },
};

/* ---- shell ---- */
let current = null;
async function render() {
  const { page, params } = parseHash();
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  document.title = `${NAV.find((n) => n[0] === page)[1]} · tokener`;
  const main = $("#main");
  if (current?.destroy) current.destroy();
  main.innerHTML = "";
  main.scrollTop = 0;
  try {
    current = await PAGES[page].render(main, params, { navigate });
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="card error"><b>Failed to load ${esc(page)}</b><p class="muted">${esc(e.message)}</p></div>`;
  }
}

function buildNav() {
  $("#nav").innerHTML = NAV.map(([id, label, d]) => `<a href="#/${id}" data-page="${id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg><span>${label}</span></a>`).join("");
}

function showLogin(msg = "") {
  $("#login").classList.remove("hidden");
  $("#shell").classList.add("hidden");
  $("#loginErr").textContent = msg;
  $("#tokenInput").focus();
}
async function showShell() {
  $("#login").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  try {
    const c = await getConfig(true);
    $("#envBadge").innerHTML = `${esc(c.region)} · ${esc(c.store)} · <span title="${esc(c.upstreamMode === "runtime" ? c.runtimeEndpoint : c.upstreamBaseUrl)}">${c.upstreamMode === "runtime" ? "Runtime API" : "Mantle API"}</span>${c.marketplace === "registered" ? " · Marketplace" : ""}`;
    $("#versionBadge").textContent = `v${c.version}`;
  } catch { /* shown on the System page anyway */ }
  await render();
}

setUnauthorizedHandler(() => { auth.token = ""; showLogin("Session expired or token rejected."); });

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  auth.token = $("#tokenInput").value.trim();
  try { await api("/me"); showShell(); } catch { auth.token = ""; showLogin("Token was not accepted."); }
});
$("#logout").addEventListener("click", () => { auth.token = ""; showLogin(); });
$("#themeBtn").addEventListener("click", () => theme.cycle());
$("#refreshBtn").addEventListener("click", () => render());
$("#sidebarToggle").addEventListener("click", () => $("#shell").classList.toggle("collapsed"));
window.addEventListener("hashchange", () => { if (auth.token) render(); });
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const idx = Number(e.key);
  if (idx >= 1 && idx <= NAV.length) navigate(NAV[idx - 1][0]);
  if (e.key === "r") render();
});

buildNav();
theme.apply(theme.get());
(async () => {
  parseHash(); // consumes a legacy #token= deep link
  if (!auth.token) return showLogin();
  try { await api("/me"); await showShell(); } catch { showLogin(); }
})();
export { toast };
