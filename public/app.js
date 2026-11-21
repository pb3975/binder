// Binder library UI. All filtering runs client-side over one /api/artifacts fetch.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { return localStorage.getItem("binder." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("binder." + k, v); } catch {} },
};

const FACETS = [
  { key: "project", label: "Project" },
  { key: "domain", label: "Domain" },
  { key: "kind", label: "Kind" },
  { key: "tags", label: "Tags", multi: true },
];
const GROUPS = [
  { key: "project", label: "Project" },
  { key: "domain", label: "Domain" },
  { key: "kind", label: "Kind" },
  { key: "month", label: "Date" },
  { key: "alpha", label: "A–Z" },
  { key: "none", label: "All" },
];
const ACRONYMS = new Set(["ai", "api", "pr", "rfp", "ui", "ux", "kb", "iot", "llm", "ci", "mcp", "aws"]);

const state = {
  all: [],
  q: "",
  sel: { project: new Set(), domain: new Set(), kind: new Set(), tags: new Set() },
  group: "project",
  sort: "newest",
  view: store.get("view", "grid"),
  expanded: new Set(),
  visible: [],
  current: null,
  me: null, // { name, scope, via } from /api/session
  versions: null, // history of the open artifact, newest first
  viewing: null, // version number shown in the viewer when it is not the latest
};
const canWrite = () => state.me?.scope === "write";

const pretty = (s) => String(s || "").split("-").map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const fmtDate = (iso, opts = { month: "short", day: "numeric", year: "numeric" }) => new Date(iso).toLocaleDateString(undefined, opts);
const monthKey = (iso) => iso.slice(0, 7);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const values = (a, key) => (key === "tags" ? a.tags : [a[key]]);
// Frame content by path, so the shell's CSP ('self') holds even when BINDER_PUBLIC_URL names another origin.
const localPath = (url) => { const u = new URL(url, location.href); return u.pathname + u.search; };
// Signed content URLs expire (/c/<id>/<n>/<exp>.<sig>/...). An open tab refreshes them before that.
const expiresAt = (url) => { const m = /\/c\/[\w-]+\/\d+\/r?(\d+)\./.exec(url ?? ""); return m ? Number(m[1]) * 1000 : Infinity; };
const stale = (url) => expiresAt(url) - Date.now() < 30 * 60_000;
async function refreshIfStale() {
  if (!state.all.some((a) => stale(a.content_url)) && !state.versions?.some((v) => stale(v.content_url))) return false;
  state.all = (await api("GET", "/api/artifacts")).artifacts;
  state.versions = null;
  return true;
}
const httpLink = (url) => /^https?:\/\//i.test(url ?? "");

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1800);
}

// ---------- URL state ----------
function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") ?? "";
  for (const f of FACETS) state.sel[f.key] = new Set((p.get(f.key) ?? "").split(",").filter(Boolean));
  state.group = GROUPS.some((g) => g.key === p.get("group")) ? p.get("group") : store.get("group", "project");
  state.sort = p.get("sort") ?? store.get("sort", "newest");
  $("#q").value = state.q;
  $("#sort").value = state.sort;
}
function writeUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  for (const f of FACETS) if (state.sel[f.key].size) p.set(f.key, [...state.sel[f.key]].join(","));
  if (state.group !== "project") p.set("group", state.group);
  if (state.sort !== "newest") p.set("sort", state.sort);
  const qs = p.toString();
  const path = state.current ? `/a/${state.current}` : "/";
  history.replaceState(history.state, "", path + (qs ? "?" + qs : ""));
}

// ---------- Filtering ----------
function matchesQuery(a, terms) {
  if (!terms.length) return true;
  const hay = `${a.title} ${a.summary} ${a.project} ${a.domain} ${a.kind} ${a.tags.join(" ")} ${a.agent ?? ""} ${a.host ?? ""}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}
function passes(a, terms, except) {
  if (!matchesQuery(a, terms)) return false;
  for (const f of FACETS) {
    if (f.key === except) continue;
    const s = state.sel[f.key];
    if (!s.size) continue;
    const v = values(a, f.key);
    // Tags narrow (must have all); single-valued facets widen (any of).
    if (f.multi ? ![...s].every((x) => v.includes(x)) : !v.some((x) => s.has(x))) return false;
  }
  return true;
}
function compute() {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.all.filter((a) => passes(a, terms, null));
  const cmp = {
    newest: (a, b) => b.published_at.localeCompare(a.published_at),
    oldest: (a, b) => a.published_at.localeCompare(b.published_at),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
  }[state.sort] ?? (() => 0);
  list.sort(cmp);
  // Facet counts ignore their own selection, so options stay discoverable.
  const counts = {};
  for (const f of FACETS) {
    const m = new Map();
    for (const a of state.all) if (passes(a, terms, f.key)) for (const v of values(a, f.key)) m.set(v, (m.get(v) ?? 0) + 1);
    for (const v of state.all.flatMap((a) => values(a, f.key))) if (!m.has(v)) m.set(v, 0);
    counts[f.key] = m;
  }
  return { list, counts };
}

function groupOf(a) {
  switch (state.group) {
    case "project": return [a.project, pretty(a.project)];
    case "domain": return [a.domain, pretty(a.domain)];
    case "kind": return [a.kind, pretty(a.kind)];
    case "month": return [monthKey(a.published_at), fmtDate(a.published_at, { month: "long", year: "numeric" })];
    case "alpha": { const c = a.title.trim().charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? [c, c] : ["#", "#"]; }
    default: return ["all", "Everything"];
  }
}
function buildGroups(list) {
  const groups = new Map();
  for (const a of list) {
    const [k, label] = groupOf(a);
    if (!groups.has(k)) groups.set(k, { key: k, label, items: [] });
    groups.get(k).items.push(a);
  }
  const arr = [...groups.values()];
  if (state.group === "month") arr.sort((a, b) => (state.sort === "oldest" ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key)));
  else if (state.group === "alpha") arr.sort((a, b) => a.key.localeCompare(b.key));
  else if (state.group !== "none") {
    // Order groups the way items are sorted: freshest group first, oldest first, or by name.
    const edge = (g) => g.items[0][state.sort === "updated" ? "updated_at" : "published_at"];
    arr.sort(state.sort === "title" ? (a, b) => a.label.localeCompare(b.label) : (a, b) => (state.sort === "oldest" ? 1 : -1) * edge(a).localeCompare(edge(b)) || a.label.localeCompare(b.label));
  }
  return arr;
}

// ---------- Rendering ----------
function thumbHtml(a) {
  const isImg = /\.(svg|png|jpe?g|webp|gif|avif)$/i.test(a.entry);
  const v = encodeURIComponent(a.updated_at);
  const img = isImg
    ? `<img class="contain" loading="lazy" alt="" src="${esc(localPath(a.content_url))}">`
    : a.thumb ? `<img loading="lazy" alt="" src="/thumb/${a.id}.png?v=${v}">` : "";
  return `<div class="thumb"><div class="cover"><span>${esc(a.title.trim().charAt(0))}</span></div>${img}</div>`;
}
function cardHtml(a) {
  return `<a class="card" href="/a/${a.id}" data-id="${a.id}" style="--hue:${hue(a.project)}">
    <div class="thumb-wrap" style="position:relative">${thumbHtml(a)}<span class="kind-badge">${esc(pretty(a.kind))}</span></div>
    <div class="body">
      <div class="eyebrow"><span class="dot"></span><span class="p">${esc(pretty(a.project))} · ${esc(pretty(a.domain))}</span></div>
      <h3>${esc(a.title)}</h3>
      ${a.summary ? `<p>${esc(a.summary)}</p>` : ""}
      <div class="foot"><span>${fmtDate(a.published_at)}</span>${a.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    </div></a>`;
}
function rowHtml(a) {
  return `<a class="row" href="/a/${a.id}" data-id="${a.id}" style="--hue:${hue(a.project)}">
    ${thumbHtml(a)}
    <div style="min-width:0"><h3>${esc(a.title)}</h3><p>${esc(a.summary)}</p></div>
    <span class="c proj"><span class="dot"></span>${esc(pretty(a.project))}</span>
    <span class="c kind">${esc(pretty(a.kind))}</span>
    <span class="d">${fmtDate(a.published_at, { month: "short", day: "numeric", year: "2-digit" })}</span></a>`;
}

function renderFilters(counts) {
  $("#filters").innerHTML = FACETS.map((f) => {
    const entries = [...counts[f.key].entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!entries.some(([, n]) => n > 0)) return "";
    const limit = state.expanded.has(f.key) ? Infinity : f.key === "tags" ? 10 : 8;
    const live = entries.filter(([v, n]) => n > 0 || state.sel[f.key].has(v));
    const shown = live.filter(([v], i) => i < limit || state.sel[f.key].has(v));
    return `<div class="facet"><h4>${f.label}</h4>${shown.map(([v, n]) => `
      <button class="opt" data-f="${f.key}" data-v="${esc(v)}" aria-pressed="${state.sel[f.key].has(v)}" ${n === 0 && !state.sel[f.key].has(v) ? "disabled" : ""}>
        ${f.key === "project" ? `<span class="swatch" style="--hue:${hue(v)}"></span>` : ""}
        <span class="lbl">${esc(f.key === "tags" ? v : pretty(v))}</span><span class="n">${n}</span></button>`).join("")}
      ${live.length > shown.length ? `<button class="more" data-more="${f.key}">Show all ${live.length}</button>` : ""}</div>`;
  }).join("");
}

function renderActive(list) {
  const chips = [];
  if (state.q) chips.push(`<button class="chip" data-clear="q"><span class="k">Search</span> ${esc(state.q)} <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`);
  for (const f of FACETS) for (const v of state.sel[f.key])
    chips.push(`<button class="chip" data-f="${f.key}" data-v="${esc(v)}"><span class="k">${f.label}</span> ${esc(f.key === "tags" ? v : pretty(v))} <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`);
  if (chips.length > 1) chips.push(`<button class="clear" data-clear="all">Clear all</button>`);
  const total = state.all.length;
  chips.push(`<span class="summary-line">${list.length === total ? `${total} artifact${total === 1 ? "" : "s"}` : `${list.length} of ${total}`}</span>`);
  $("#active").innerHTML = chips.join("");
}

function render() {
  const { list, counts } = compute();
  state.visible = list;
  renderFilters(counts);
  renderActive(list);
  $("#group").innerHTML = GROUPS.map((g) => `<button role="radio" data-g="${g.key}" aria-checked="${state.group === g.key}">${g.label}</button>`).join("");
  for (const b of $("#view").children) b.setAttribute("aria-checked", String(b.dataset.v === state.view));

  const out = $("#results");
  if (!state.all.length) {
    out.innerHTML = `<div class="empty"><h2>The binder is empty</h2><p>Ask an agent to put an artifact in the binder.</p><button class="btn" data-help>How agents publish</button></div>`;
    return;
  }
  if (!list.length) {
    out.innerHTML = `<div class="empty"><h2>No matches</h2><p>Nothing fits these filters.</p><button class="btn" data-clear="all">Clear filters</button></div>`;
    return;
  }
  const item = state.view === "list" ? rowHtml : cardHtml;
  out.innerHTML = buildGroups(list).map((g) => `
    <section class="group">
      ${state.group === "none" ? "" : `<div class="group-head"><h2>${state.group === "project" ? `<span class="tab" style="--hue:${hue(g.key)}"></span>` : ""}${esc(g.label)}</h2><span class="n">${g.items.length}</span></div>`}
      <div class="${state.view === "list" ? "list" : "grid"}">${g.items.map(item).join("")}</div>
    </section>`).join("");
  // Fall back to the generated cover when a preview image is missing.
  for (const img of out.querySelectorAll(".thumb img")) img.addEventListener("error", () => img.remove(), { once: true });
}

// ---------- Viewer ----------
function openViewer(id, push = true, refreshed = false) {
  const known = state.all.find((x) => x.id === id);
  if (known && !refreshed && stale(known.content_url)) {
    refreshIfStale().then(() => openViewer(id, push, true), (err) => toast(err.message));
    return;
  }
  const a = known;
  if (!a) { closeViewer(false); return; }
  if (state.current !== id) { state.versions = null; state.viewing = null; }
  state.current = id;
  const v = $("#viewer");
  v.hidden = false;
  v.style.setProperty("--hue", hue(a.project));
  document.body.style.overflow = "hidden";
  document.title = `${a.title} · Binder`;
  $("#v-title").textContent = a.title;
  $("#v-sub").innerHTML = `<span class="dot"></span>${esc(pretty(a.project))} · ${esc(pretty(a.kind))} · ${fmtDate(a.published_at)}`;
  if (state.current !== id || !state.versions || state.versions[0]?.artifact_id !== id) { state.versions = null; state.viewing = null; }
  showContent(localPath(state.viewing ? state.versions.find((v) => v.version === state.viewing).content_url : a.content_url));
  const idx = state.visible.findIndex((x) => x.id === id);
  $("#v-prev").disabled = idx <= 0;
  $("#v-next").disabled = idx < 0 || idx >= state.visible.length - 1;
  renderPanel(a);
  if (push) history.pushState({ viewer: true }, "", `/a/${id}${location.search}`);
}
function showContent(src) {
  const frame = $("#v-frame");
  if (frame.dataset.src !== src) { frame.src = src; frame.dataset.src = src; }
  $("#v-open").href = src;
}
function renderVersionBar(a) {
  const bar = $("#v-version");
  const v = state.viewing && state.versions?.find((x) => x.version === state.viewing);
  bar.hidden = !v;
  if (!v) return;
  bar.innerHTML = `<span class="grow">Viewing version ${v.version} of ${a.version}, published ${fmtDate(v.created_at)}${v.published_by ? ` by ${esc(v.published_by)}` : ""}.</span>
    ${canWrite() ? `<button class="btn" data-act="restore" data-ver="${v.version}">Restore this version</button>` : ""}
    <button class="btn primary" data-act="latest">Back to latest</button>`;
}
function viewVersion(n) {
  const a = state.all.find((x) => x.id === state.current);
  const v = state.versions?.find((x) => x.version === n);
  if (!a || !v) return;
  state.viewing = n === a.version ? null : n;
  showContent(localPath(state.viewing ? v.content_url : a.content_url));
  renderVersionBar(a);
  renderHistory(a);
}
function closeViewer(push = true) {
  state.current = null;
  state.versions = null;
  state.viewing = null;
  $("#v-version").hidden = true;
  $("#viewer").hidden = true;
  const frame = $("#v-frame");
  frame.src = "about:blank";
  frame.dataset.src = "";
  document.body.style.overflow = "";
  document.title = "Binder";
  if (push) history.pushState({}, "", "/" + location.search);
}
function step(d) {
  const idx = state.visible.findIndex((x) => x.id === state.current);
  const next = state.visible[idx + d];
  if (next) openViewer(next.id, false), history.replaceState({ viewer: true }, "", `/a/${next.id}${location.search}`);
}
function renderPanel(a) {
  const dd = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : "");
  const src = httpLink(a.source_url) ? `<a href="${esc(a.source_url)}" target="_blank" rel="noopener">${esc(a.source_url.replace(/^https?:\/\//, ""))}</a>` : "";
  $("#v-panel").innerHTML = `
    <h3>${esc(a.title)}</h3>
    ${a.summary ? `<p class="sum">${esc(a.summary)}</p>` : ""}
    <dl>
      ${dd("Project", esc(pretty(a.project)))}${dd("Domain", esc(pretty(a.domain)))}${dd("Kind", esc(pretty(a.kind)))}
      ${dd("Published", fmtDate(a.published_at))}${dd("Updated", `${fmtDate(a.updated_at)} · v${a.version}`)}
      ${dd("By", esc(a.published_by))}${dd("Agent", esc([a.agent, a.host].filter(Boolean).join(" on ")))}${dd("Source", src)}
      ${a.tags.length ? dd("Tags", `<div class="tags">${a.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>`) : ""}
      ${dd("Size", fmtBytes(a.bytes))}
    </dl>
    <h5>History</h5>
    <ul class="history" id="v-history"><li class="muted small">Loading…</li></ul>
    <h5>Files</h5>
    <ul class="files">${a.files.map((f) => `<li><span>${esc(f.path)}</span><span>${fmtBytes(f.size)}</span></li>`).join("")}</ul>
    ${canWrite() ? `<div class="panel-actions">
      <button class="btn" data-act="rethumb">Refresh preview</button>
      <button class="btn danger" data-act="delete">Remove</button>
    </div>` : ""}`;
  if (state.versions) renderHistory(a);
  else loadHistory(a.id);
}
async function loadHistory(id) {
  try {
    const { versions } = await api("GET", `/api/artifacts/${id}/versions`);
    if (state.current !== id) return;
    state.versions = versions;
    // An agent may have published since the library loaded. Then the history is newer
    // than the artifact we hold, so fetch the artifact again before deciding what is latest.
    if (versions[0] && versions[0].version > (state.all.find((x) => x.id === id)?.version ?? 0)) {
      const fresh = await api("GET", `/api/artifacts/${id}`);
      if (state.current !== id) return;
      state.all = state.all.map((x) => (x.id === id ? fresh : x));
      render();
      openViewer(id, false);
      return;
    }
    renderHistory(state.all.find((x) => x.id === id));
  } catch (err) {
    const el = $("#v-history");
    if (el) el.innerHTML = `<li class="muted small">History unavailable: ${esc(err.message)}</li>`;
  }
}
function changeSummary(c) {
  const parts = [];
  if (c.added.length) parts.push(`<b class="a">+${c.added.length}</b>`);
  if (c.removed.length) parts.push(`<b class="r">−${c.removed.length}</b>`);
  if (c.changed.length) parts.push(`<b>~${c.changed.length}</b>`);
  const names = [...c.changed, ...c.added, ...c.removed];
  return parts.length ? `${parts.join(" ")} ${esc(names.slice(0, 2).join(", "))}${names.length > 2 ? ` +${names.length - 2}` : ""}` : "no file changes";
}
function renderHistory(a) {
  const el = $("#v-history");
  if (!el || !state.versions) return;
  const shown = state.viewing ?? a.version;
  el.innerHTML = state.versions.map((v) => `<li><button data-ver="${v.version}" aria-current="${v.version === shown}" title="View version ${v.version}">
      <span class="vn">v${v.version}</span>
      <span class="meta">${fmtDate(v.created_at)}${v.published_by ? ` · ${esc(v.published_by)}` : ""}${v.agent ? ` · ${esc(v.agent)}` : ""}</span>
      ${v.note ? `<span class="note">${esc(v.note)}</span>` : ""}
      <span class="chg">${v.version === state.versions.at(-1).version && v.changes.removed.length === 0 && !v.note ? `${v.files.length} file${v.files.length === 1 ? "" : "s"}` : changeSummary(v.changes)}</span>
    </button></li>`).join("");
}

async function api(method, path, body) {
  const headers = method === "GET" ? {} : { "x-binder": "1" };
  if (body) headers["content-type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body && JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json();
}

// ---------- Events ----------
function toggle(f, v) {
  const s = state.sel[f];
  s.has(v) ? s.delete(v) : s.add(v);
  writeUrl();
  render();
}
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.matches(".card, .row")) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    openViewer(t.dataset.id);
  } else if (t.dataset.f) toggle(t.dataset.f, t.dataset.v);
  else if (t.dataset.more) { state.expanded.add(t.dataset.more); render(); }
  else if (t.dataset.g) { state.group = t.dataset.g; store.set("group", state.group); writeUrl(); render(); }
  else if (t.dataset.v && t.closest("#view")) { state.view = t.dataset.v; store.set("view", state.view); render(); }
  else if (t.dataset.clear) {
    if (t.dataset.clear === "q" || t.dataset.clear === "all") { state.q = ""; $("#q").value = ""; }
    if (t.dataset.clear === "all") for (const f of FACETS) state.sel[f.key].clear();
    writeUrl(); render();
  } else if (t.hasAttribute("data-help")) openHelp();
  else if (t.dataset.ver && t.closest("#v-history")) viewVersion(Number(t.dataset.ver));
  else if (t.dataset.act === "latest") viewVersion(state.all.find((x) => x.id === state.current)?.version);
  else if (t.dataset.act === "restore") {
    const n = Number(t.dataset.ver);
    if (!confirm(`Restore version ${n}? Binder publishes a copy of it as a new version. Nothing is lost.`)) return;
    api("POST", `/api/artifacts/${state.current}/versions/${n}/restore`).then((a) => {
      state.all = state.all.map((x) => (x.id === a.id ? a : x));
      state.versions = null;
      state.viewing = null;
      $("#v-version").hidden = true;
      openViewer(a.id, false);
      render();
      toast(`Restored as version ${a.version}`);
    }, (err) => toast(err.message));
  }
  else if (t.dataset.act === "rethumb") api("POST", `/api/artifacts/${state.current}/thumbnail`).then(() => toast("Preview queued"), (err) => toast(err.message));
  else if (t.dataset.act === "delete") {
    const a = state.all.find((x) => x.id === state.current);
    if (!a || !confirm(`Remove “${a.title}” from the binder? Its files move to the trash folder on the server.`)) return;
    api("DELETE", `/api/artifacts/${a.id}`).then(() => {
      state.all = state.all.filter((x) => x.id !== a.id);
      closeViewer(); render(); toast("Removed");
    }, (err) => toast(err.message));
  }
});

let qTimer;
$("#q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value.trim(); writeUrl(); render(); }, 80);
});
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; store.set("sort", state.sort); writeUrl(); render(); });
$("#v-back").addEventListener("click", () => (history.state?.viewer ? history.back() : closeViewer()));
$("#v-prev").addEventListener("click", () => step(-1));
$("#v-next").addEventListener("click", () => step(1));
$("#v-info").addEventListener("click", () => {
  const p = $("#v-panel");
  p.hidden = !p.hidden;
  $("#v-info").setAttribute("aria-expanded", String(!p.hidden));
  store.set("panel", p.hidden ? "0" : "1");
});
$("#v-copy").addEventListener("click", () => {
  navigator.clipboard?.writeText(location.origin + "/a/" + state.current).then(() => toast("Link copied"), () => toast("Copy failed"));
});
function setDrawer(open) {
  document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
  $("#filters").classList.toggle("open", open);
  $("#filters-toggle").setAttribute("aria-expanded", String(open));
  $(".scrim")?.remove();
  if (open) {
    const s = document.createElement("div");
    s.className = "scrim";
    s.addEventListener("click", () => setDrawer(false));
    document.body.append(s);
  }
}
$("#filters-toggle").addEventListener("click", () => setDrawer(!$("#filters").classList.contains("open")));
$("#theme-btn").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  store.set("theme", document.documentElement.dataset.theme);
});

function openHelp() {
  const lines = [
    `curl -fsS ${location.origin}/api/artifacts \\`,
    `  -H 'X-Binder: 1' \\`,
    ...(state.me?.via === "header" ? [] : [`  -H "Authorization: Bearer $BINDER_TOKEN" \\`]),
    `  -F 'meta={"id":"agent-loops","title":"Agent Loops vs Graphs",`,
    `           "project":"fleet","kind":"explainer",`,
    `           "summary":"One sentence on what it is.",`,
    `           "note":"What changed in this version."}' \\`,
    `  -F 'file=@explainer.html'`,
  ];
  $("#help-snippet").textContent = lines.join("\n");
  $("#help").showModal();
}
$("#help-btn").addEventListener("click", openHelp);
$("#help-copy").addEventListener("click", () => navigator.clipboard?.writeText($("#help-snippet").textContent).then(() => toast("Copied")));

document.addEventListener("keydown", (e) => {
  const typing = e.target.matches("input, textarea, select");
  if (!$("#viewer").hidden) {
    if (e.key === "Escape") { e.preventDefault(); $("#v-back").click(); }
    else if (!typing && e.key === "[") step(-1);
    else if (!typing && e.key === "]") step(1);
    else if (!typing && e.key === "i") $("#v-info").click();
    return;
  }
  if (e.key === "/" && !typing) { e.preventDefault(); $("#q").focus(); }
  else if (e.key === "Escape" && e.target === $("#q")) { $("#q").value = ""; state.q = ""; writeUrl(); render(); $("#q").blur(); }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !state.me) return;
  refreshIfStale().then((changed) => {
    if (!changed) return;
    render();
    if (state.current) { state.viewing = null; openViewer(state.current, false, true); }
  }, () => {});
});
window.addEventListener("popstate", () => {
  const m = location.pathname.match(/^\/a\/([\w-]+)/);
  m ? openViewer(m[1], false) : closeViewer(false);
});

// ---------- Boot ----------
// ---------- Sign in ----------
function showSignIn(show) {
  $("#signin").hidden = !show;
  $(".shell").hidden = show;
  $(".search").style.visibility = show ? "hidden" : "";
  for (const id of ["#filters-toggle", "#help-btn"]) $(id).hidden = show;
  if (show) setTimeout(() => $("#signin-token").focus(), 0);
}
$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#signin-error");
  err.textContent = "";
  try {
    state.me = await api("POST", "/api/session", { token: $("#signin-token").value.trim() });
    $("#signin-token").value = "";
    showSignIn(false);
    await load();
  } catch (x) {
    err.textContent = x.message === "invalid or revoked token" ? "That token is not valid. It may have been revoked." : x.message;
  }
});
function renderMe() {
  const b = $("#me-btn");
  b.hidden = !state.me || state.me.via === "anonymous";
  if (b.hidden) return;
  const how = { session: "Sign out", header: "Signed in by your proxy", token: "" }[state.me.via] ?? "";
  b.title = `Signed in as ${state.me.name}${state.me.scope === "read" ? " (read only)" : ""}. ${how}`.trim();
  b.setAttribute("aria-label", b.title);
}
$("#me-btn").addEventListener("click", async () => {
  if (state.me?.via !== "session") return toast(`Signed in as ${state.me?.name}`);
  if (!confirm(`Sign out ${state.me.name} on this browser?`)) return;
  await api("DELETE", "/api/session").catch(() => {});
  location.reload();
});

// ---------- Boot ----------
async function load() {
  renderMe();
  try {
    state.all = (await api("GET", "/api/artifacts")).artifacts;
  } catch (err) {
    $("#results").innerHTML = `<div class="empty"><h2>Could not load the binder</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  render();
  const m = location.pathname.match(/^\/a\/([\w-]+)/);
  if (m) openViewer(m[1], false);
}
async function boot() {
  readUrl();
  if (store.get("panel", "0") === "1") { $("#v-panel").hidden = false; $("#v-info").setAttribute("aria-expanded", "true"); }
  const r = await fetch("/api/session").catch(() => null);
  if (r?.status === 401) return showSignIn(true);
  if (!r?.ok) {
    $("#results").innerHTML = `<div class="empty"><h2>Could not reach Binder</h2><p>${esc(r ? (await r.json().catch(() => ({}))).error ?? r.statusText : "Network error")}</p></div>`;
    return;
  }
  state.me = await r.json();
  await load();
}
boot();
