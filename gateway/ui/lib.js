/* Shared helpers for the tokener admin console: DOM, formatting, API client, toasts, drawer/modal, charts. */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const fmtUsd = (v, d) => {
  v = Number(v) || 0;
  if (d !== undefined) return `$${v.toFixed(d)}`;
  return v === 0 ? "$0" : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
};
export const fmtInt = (v) => Number(v || 0).toLocaleString("en-US");
export const fmtK = (v) => { v = Number(v) || 0; return v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(v); };
export const fmtPct = (v, d = 1) => `${(Number(v) || 0).toFixed(d)}%`;
export const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
export const fmtAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
export const fmtDur = (sec) => { const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`; };
export const shortModel = (id) => String(id || "").replace(/^([a-z-]+\.)?anthropic\./, "").replace(/-\d{8}(-v\d+(:\d+)?)?$/, "");
export const pct = (used, limit) => (limit ? Math.min(100, (100 * used) / limit) : 0);
export const tone = (p, hasLimit) => (!hasLimit ? "" : p >= 100 ? "bad" : p >= 80 ? "warn" : "ok");
export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- auth + api ---------- */
export const auth = {
  get token() { return localStorage.getItem("tokenerAdminToken") || ""; },
  set token(v) { v ? localStorage.setItem("tokenerAdminToken", v) : localStorage.removeItem("tokenerAdminToken"); },
};
export class ApiError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);
export async function api(path, opts = {}) {
  const r = await fetch(`/admin/api${path}`, {
    method: opts.method || "GET",
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { onUnauthorized(); throw new ApiError(401, "Unauthorized"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error || `HTTP ${r.status}`, j.details);
  return j;
}

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2800);
}

/* ---------- confirm dialog ---------- */
export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const root = $("#modalRoot");
    root.innerHTML = `<div class="modal"><div class="modal-card narrow" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2><p class="muted">${body}</p>
      <div class="actions end"><button class="ghost" data-x="0">Cancel</button><button class="${danger ? "danger-solid" : ""}" data-x="1">${esc(confirmLabel)}</button></div></div></div>`;
    root.classList.remove("hidden");
    const done = (v) => { root.classList.add("hidden"); root.innerHTML = ""; resolve(v); };
    $$("[data-x]", root).forEach((b) => b.addEventListener("click", () => done(b.dataset.x === "1")));
    root.firstElementChild.addEventListener("click", (e) => { if (e.target === root.firstElementChild) done(false); });
    $("[data-x='1']", root).focus();
  });
}

/* ---------- modal ---------- */
export function openModal(html) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal"><div class="modal-card" role="dialog" aria-modal="true">${html}</div></div>`;
  root.classList.remove("hidden");
  const close = () => { root.classList.add("hidden"); root.innerHTML = ""; };
  root.firstElementChild.addEventListener("click", (e) => { if (e.target === root.firstElementChild) close(); });
  $$("[data-close]", root).forEach((b) => b.addEventListener("click", close));
  return { el: root.firstElementChild, close };
}

/* ---------- drawer ---------- */
export function openDrawer({ title, subtitle = "", body, footer = "", wide = false }) {
  const d = $("#drawer"), bd = $("#drawerBackdrop");
  d.classList.toggle("wide", wide);
  d.innerHTML = `<div class="drawer-body">
    <header class="drawer-head"><div><h2 id="drawerTitle">${esc(title)}</h2><p class="muted small" id="drawerSub">${subtitle}</p></div><button type="button" class="icon" data-close aria-label="Close">✕</button></header>
    <div class="drawer-scroll">${body}</div>
    ${footer ? `<footer class="drawer-foot">${footer}</footer>` : ""}
  </div>`;
  d.classList.remove("hidden"); bd.classList.remove("hidden");
  d.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => d.classList.add("open"));
  const close = () => {
    d.classList.remove("open"); d.setAttribute("aria-hidden", "true");
    setTimeout(() => { d.classList.add("hidden"); bd.classList.add("hidden"); d.innerHTML = ""; }, 180);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  $$("[data-close]", d).forEach((b) => b.addEventListener("click", close));
  bd.onclick = close;
  return { el: d, close };
}

/* ---------- tiny SVG charts ---------- */
export function barChart(el, points, { value, label, format = fmtUsd, secondary, height = 200, tooltip }) {
  const W = 640, H = height, padL = 46, padB = 24, padT = 10;
  const max = Math.max(...points.map((p) => value(p) + (secondary ? secondary(p) : 0)), 1e-9);
  const n = points.length;
  const x = (i) => padL + (i * (W - padL)) / n;
  const bw = Math.max(2, (W - padL) / n - 3);
  const y = (v) => padT + (H - padB - padT) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const svg = [`<svg viewBox="0 0 ${W} ${H}" role="img">`];
  for (const t of ticks) svg.push(`<line class="grid" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${format(t)}</text>`);
  points.forEach((p, i) => {
    const v = value(p), s = secondary ? secondary(p) : 0;
    const y0 = H - padB, yv = y(v), ys = y(v + s);
    if (v > 0) svg.push(`<rect class="b" x="${x(i) + 1.5}" y="${yv}" width="${bw}" height="${y0 - yv}" rx="3"/>`);
    if (s > 0) svg.push(`<rect class="b2" x="${x(i) + 1.5}" y="${ys}" width="${bw}" height="${yv - ys}" rx="3"/>`);
    svg.push(`<rect class="hit" data-i="${i}" x="${x(i)}" y="${padT}" width="${bw + 3}" height="${H - padB - padT}"/>`);
    const lbl = label(p, i);
    if (lbl) svg.push(`<text x="${x(i) + bw / 2}" y="${H - 7}" text-anchor="middle">${esc(lbl)}</text>`);
  });
  svg.push("</svg>");
  el.innerHTML = svg.join("");
  if (tooltip) attachTip(el, (i) => tooltip(points[i], i));
}
export function lineChart(el, points, { value, label, format = fmtUsd, height = 160, tooltip }) {
  const W = 640, H = height, padL = 46, padB = 24, padT = 10, padR = 10;
  const max = Math.max(...points.map(value), 1e-9);
  const n = Math.max(points.length, 2);
  const x = (i) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => padT + (H - padB - padT) * (1 - v / max);
  const svg = [`<svg viewBox="0 0 ${W} ${H}" role="img">`];
  for (const t of [0, max / 2, max]) svg.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${format(t)}</text>`);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i)} ${y(value(p))}`).join(" ");
  svg.push(`<path class="area" d="${d} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z"/><path class="line" d="${d}"/>`);
  points.forEach((p, i) => {
    svg.push(`<circle class="dot" cx="${x(i)}" cy="${y(value(p))}" r="3"/>`);
    svg.push(`<rect class="hit" data-i="${i}" x="${x(i) - (W - padL) / n / 2}" y="${padT}" width="${(W - padL) / n}" height="${H - padB - padT}"/>`);
    const lbl = label(p, i);
    if (lbl) svg.push(`<text x="${x(i)}" y="${H - 7}" text-anchor="middle">${esc(lbl)}</text>`);
  });
  svg.push("</svg>");
  el.innerHTML = svg.join("");
  if (tooltip) attachTip(el, (i) => tooltip(points[i], i));
}
function attachTip(el, render) {
  const tip = $("#tip");
  $$("rect.hit", el).forEach((r) => {
    r.addEventListener("mousemove", (e) => {
      tip.innerHTML = render(Number(r.dataset.i));
      tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 220)}px`;
      tip.style.top = `${e.clientY - 10}px`;
      tip.classList.remove("hidden");
    });
    r.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  });
}

/* ---------- small components ---------- */
export const chip = (text, cls = "") => `<span class="chip ${cls}">${esc(text)}</span>`;
export const pill = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;
export const progress = (used, limit, fmt) => {
  const p = pct(used, limit), t = tone(p, !!limit);
  return `<div class="usage ${t}"><div class="usage-txt"><span>${fmt(used)}</span><span class="muted">${limit ? `/ ${fmt(limit)}` : "no cap"}</span></div><div class="progress"><i style="width:${limit ? p : 0}%"></i></div></div>`;
};
export const kpi = (id, label, sub = "") => `<div class="tile"><span class="label">${esc(label)}</span><span class="value" id="${id}">–</span><span class="sub" id="${id}Sub">${sub}</span></div>`;
export const emptyState = (title, body = "") => `<div class="empty"><p><b>${esc(title)}</b></p>${body ? `<p class="muted">${body}</p>` : ""}</div>`;
export const skeleton = (rows = 4) => `<div class="skeleton">${Array.from({ length: rows }, () => `<div></div>`).join("")}</div>`;
export const copy = (text, msg = "Copied") => navigator.clipboard.writeText(text).then(() => toast(msg)).catch(() => toast("Copy failed", "bad"));
export const downloadCsv = (name, rows) => {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
};
export const initials = (id) => String(id).replace(/[^a-zA-Z0-9]/g, " ").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
export const settingsSnippet = (tok = "<TOKEN>") => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: location.origin,
    ANTHROPIC_AUTH_TOKEN: tok,
    CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
  },
}, null, 2);

/* ---------- shared data caches ---------- */
export const cache = { config: null, policy: null, catalog: null, pricing: null };
export async function getConfig(force = false) { if (!cache.config || force) cache.config = await api("/config"); return cache.config; }
export async function getPolicy(force = false) { if (!cache.policy || force) cache.policy = await api("/policy"); return cache.policy; }
export async function getCatalog(force = false) { if (!cache.catalog || force) cache.catalog = await api(`/models${force ? "?refresh=1" : ""}`); return cache.catalog; }
export const invalidate = (...keys) => keys.forEach((k) => (cache[k] = null));
