import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, normalize } from "node:path";
import { authenticator, SESSION_COOKIE, type Principal } from "./auth";
import { loadConfig, type Config } from "./config";
import { loadSecret, signer } from "./content";
import { openDb, sha256, versionDir, type Artifact, type ArtifactRow, type FileEntry, type Version } from "./db";
import { thumbnailer } from "./thumbs";

const MAX_BYTES = 64 * 1024 * 1024;
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

// Opaque-origin sandbox for artifact documents: scripts run, but the page can
// never read Binder's origin, cookies, or storage. Same header on every content file.
const VIEW_CSP =
  "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

const kebab = (s: unknown, fallback: string) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64) || fallback;

const text = (s: unknown, max: number) => (s == null ? "" : String(s).trim().slice(0, max));
const opt = (s: unknown, max: number) => text(s, max) || null;
const tagList = (t: unknown): string[] | null => {
  const raw = Array.isArray(t) ? t : typeof t === "string" ? t.split(",") : null;
  return raw && [...new Set(raw.map((x) => kebab(x, "")).filter(Boolean))].slice(0, 12);
};

function isoDate(s: unknown, fallback: string): string {
  if (!s) return fallback;
  // A bare date means that calendar day; noon UTC keeps it on the same day in every US/EU time zone.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? `${s}T12:00:00Z` : String(s));
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function safePath(p: string): string | null {
  const clean = normalize(p.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
  if (!clean || clean.startsWith("/") || clean.startsWith("..") || clean.includes("/../") || clean.includes("\0"))
    return null;
  return clean;
}

/** Files added, removed, or changed (by hash) from one version to the next. */
export function diffFiles(prev: FileEntry[] | undefined, next: FileEntry[]) {
  if (!prev) return { added: next.map((f) => f.path), removed: [], changed: [] };
  const before = new Map(prev.map((f) => [f.path, f.sha256]));
  const after = new Map(next.map((f) => [f.path, f.sha256]));
  return {
    added: next.filter((f) => !before.has(f.path)).map((f) => f.path),
    removed: prev.filter((f) => !after.has(f.path)).map((f) => f.path),
    changed: next.filter((f) => before.has(f.path) && before.get(f.path) !== f.sha256).map((f) => f.path),
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

// The UI shell may only run its own scripts and frame Binder's own content.
// Artifact pages never run here: they load from /c/ in a sandboxed frame with an opaque origin.
const SHELL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "frame-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'";

/** Only http(s) links are kept, so a link in the details panel can never run script. */
function httpUrl(s: unknown): string | null | undefined {
  const t = text(s, 500);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
const fail = (status: number, error: string) => json({ error }, status);

export function createApp(cfg: Config, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  for (const d of ["versions", "trash"]) mkdirSync(join(cfg.dataDir, d), { recursive: true });
  // Staged uploads that never committed are not artifact data; clear them on start.
  rmSync(join(cfg.dataDir, "tmp"), { recursive: true, force: true });
  mkdirSync(join(cfg.dataDir, "tmp"), { recursive: true });
  const db = openDb(cfg.dataDir);
  const sign = signer(loadSecret(cfg.dataDir), now);
  const thumbs = thumbnailer({ db, dataDir: cfg.dataDir, signer: sign, chromium: cfg.chromium, hosts: cfg.previewHosts });
  let renderOrigin = "http://127.0.0.1"; // set by started()
  const hostSources = cfg.previewHosts.map((h) => `https://${h}`).join(" ");
  let renderSources = `${renderOrigin} ${hostSources}`;

  // Backfill previews that are missing (first boot, or Chromium added later).
  for (const a of db.list()) if (!a.thumb) thumbs.enqueue(a.id);

  const auth = authenticator(cfg, db, sign, now);

  // Mutations need a custom header. A browser only sends one after a CORS
  // preflight, which Binder never approves, so artifact pages cannot write.
  const mutationAllowed = (req: Request) => req.headers.get("x-binder") === "1";

  const originOf = (req: Request) => cfg.publicUrl ?? new URL(req.url).origin;

  function view(a: Artifact, origin: string) {
    return {
      ...a,
      url: `${origin}/a/${a.id}`,
      content_url: `${origin}${sign.contentPath(a.id, a.version)}/${a.entry}`,
      raw_url: `${origin}/raw/${a.id}/${a.entry}`,
    };
  }

  function uniqueId(base: string): string {
    let id = base;
    for (let n = 2; db.row(id); n++) id = `${base}-${n}`;
    return id;
  }

  /** Records staged files as the next version of `next.id`. Synchronous from here on. */
  function commitVersion(
    staging: string,
    next: Omit<ArtifactRow, "version">,
    v: Omit<Version, "version" | "artifact_id">,
  ): number {
    const n = db.commit(next, v, (n) => {
      const dir = versionDir(cfg.dataDir, next.id, n);
      mkdirSync(join(dir, ".."), { recursive: true });
      // A folder left by a crash between rename and commit is an orphan; keep it in trash.
      if (existsSync(dir)) renameSync(dir, join(cfg.dataDir, "trash", `${next.id}-v${n}-orphan-${now()}`));
      renameSync(staging, dir);
    });
    rmSync(thumbs.path(next.id), { force: true });
    thumbs.enqueue(next.id);
    return n;
  }

  async function publish(req: Request, who: Principal): Promise<Response> {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, "expected multipart/form-data with a 'meta' JSON field and one or more 'file' parts");
    }
    let meta: Record<string, unknown> = {};
    const rawMeta = form.get("meta");
    if (typeof rawMeta === "string" && rawMeta.trim()) {
      try {
        meta = JSON.parse(rawMeta);
      } catch {
        return fail(400, "'meta' is not valid JSON");
      }
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) return fail(400, "'meta' must be a JSON object");
    }
    const uploads = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!uploads.length) return fail(400, "at least one 'file' part is required");

    const files: { path: string; file: File }[] = [];
    let bytes = 0;
    for (const f of uploads) {
      const path = safePath(f.name || "index.html");
      if (!path) return fail(400, `unsafe file path: ${f.name}`);
      if (files.some((x) => x.path === path)) return fail(400, `duplicate file path: ${path}`);
      bytes += f.size;
      files.push({ path, file: f });
    }
    if (bytes > MAX_BYTES) return fail(413, `artifact exceeds ${MAX_BYTES / 1024 / 1024} MB`);

    // A lone HTML upload becomes index.html, so every page has a predictable entry.
    if (files.length === 1 && /\.html?$/i.test(files[0]!.path)) files[0]!.path = "index.html";
    const paths = files.map((f) => f.path);
    const requested = meta.entry ? safePath(String(meta.entry)) : null;
    const entry =
      (requested && paths.includes(requested) && requested) ||
      paths.find((p) => p === "index.html") ||
      paths.find((p) => /\.html?$/i.test(p)) ||
      paths[0]!;

    // Stage the upload first, so a failed request never leaves half a version.
    const staging = join(cfg.dataDir, "tmp", crypto.randomUUID());
    const entries: FileEntry[] = [];
    for (const f of files) {
      const buf = await f.file.arrayBuffer();
      const dest = join(staging, f.path);
      await Bun.write(dest, buf);
      entries.push({ path: f.path, size: f.file.size, type: Bun.file(dest).type, sha256: sha256(buf) });
    }

    const source = meta.source_url === undefined ? null : httpUrl(meta.source_url);
    if (source === undefined) return fail(400, "'source_url' must be an http or https URL");
    const title = text(meta.title, 200) || entry;
    const wanted = meta.id ? kebab(meta.id, "") : "";
    const existing = wanted ? db.row(wanted) : null;
    const id = existing ? existing.id : uniqueId(wanted || kebab(title, "artifact"));
    const t = iso();
    const next: Omit<ArtifactRow, "version"> = {
      id,
      title,
      summary: text(meta.summary, 600) || existing?.summary || "",
      project: kebab(meta.project ?? existing?.project, "general"),
      domain: kebab(meta.domain ?? existing?.domain, "general"),
      kind: kebab(meta.kind ?? existing?.kind, "other"),
      tags: tagList(meta.tags) ?? existing?.tags ?? [],
      source_url: source ?? existing?.source_url ?? null,
      published_at: isoDate(meta.published_at, existing?.published_at ?? t),
      created_at: existing?.created_at ?? t,
      updated_at: t,
      thumb: false,
      deleted_at: null, // publishing a removed id brings it back
    };
    commitVersion(staging, next, {
      title,
      entry,
      files: entries,
      bytes,
      note: text(meta.note, 300),
      published_by: who.name,
      agent: opt(meta.agent, 80),
      host: opt(meta.host, 80),
      created_at: t,
    });
    const a = db.get(id)!;
    return json({ ...view(a, originOf(req)), updated: Boolean(existing) }, existing ? 200 : 201);
  }

  function restore(id: string, n: number, who: Principal, req: Request): Response {
    const row = db.row(id);
    const old = db.version(id, n);
    if (!row || row.deleted_at || !old) return fail(404, "not found");
    const staging = join(cfg.dataDir, "tmp", crypto.randomUUID());
    cpSync(versionDir(cfg.dataDir, id, n), staging, { recursive: true });
    const t = iso();
    const { version: _, ...rest } = row;
    commitVersion(staging, { ...rest, title: old.title, updated_at: t, thumb: false }, {
      ...old,
      note: `Restored version ${n}`,
      published_by: who.name,
      created_at: t,
    });
    return json(view(db.get(id)!, originOf(req)));
  }

  function history(id: string, req: Request): Response {
    if (!db.get(id)) return fail(404, "not found");
    const origin = originOf(req);
    const vs = db.versions(id); // newest first
    return json({
      versions: vs.map((v, i) => ({
        ...v,
        content_url: `${origin}${sign.contentPath(id, v.version)}/${v.entry}`,
        changes: diffFiles(vs[i + 1]?.files, v.files),
      })),
    });
  }

  async function patch(id: string, req: Request): Promise<Response> {
    const row = db.row(id);
    if (!row || row.deleted_at) return fail(404, "not found");
    let m: Record<string, unknown>;
    try {
      m = (await req.json()) as Record<string, unknown>;
    } catch {
      return fail(400, "expected a JSON body");
    }
    if (m.title !== undefined) row.title = text(m.title, 200) || row.title;
    if (m.summary !== undefined) row.summary = text(m.summary, 600);
    if (m.project !== undefined) row.project = kebab(m.project, "general");
    if (m.domain !== undefined) row.domain = kebab(m.domain, "general");
    if (m.kind !== undefined) row.kind = kebab(m.kind, "other");
    const tags = tagList(m.tags);
    if (tags) row.tags = tags;
    if (m.source_url !== undefined) {
      const source = httpUrl(m.source_url);
      if (source === undefined) return fail(400, "'source_url' must be an http or https URL");
      row.source_url = source;
    }
    if (m.published_at !== undefined) row.published_at = isoDate(m.published_at, row.published_at);
    row.updated_at = iso();
    db.saveArtifact(row);
    return json(view(db.get(id)!, originOf(req)));
  }

  function remove(id: string): Response {
    if (!db.get(id)) return fail(404, "not found");
    // A soft delete: every version stays on disk, and publishing the id again restores it.
    db.softDelete(id, iso());
    return json({ deleted: id });
  }

  /** Serves one file of one version. The token in the path is the only credential. */
  async function content(id: string, n: number, tok: string, rest: string): Promise<Response> {
    const mode = sign.verify(id, n, tok);
    if (!mode) return new Response("link expired or invalid; reopen it from Binder", { status: 403 });
    const v = db.version(id, n);
    if (!v || db.row(id)?.deleted_at) return new Response("not found", { status: 404 });
    const path = safePath(rest || v.entry);
    if (!path || !v.files.some((f) => f.path === path)) return new Response("not found", { status: 404 });
    const file = Bun.file(join(versionDir(cfg.dataDir, id, n), path));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": file.type,
        // Render mode also limits every fetch to Binder and a few public CDNs, so a preview
        // cannot capture a private http or https service. Frames may only come from Binder.
        "content-security-policy":
          mode === "render"
            ? `sandbox allow-scripts; default-src ${renderSources} data: blob: 'unsafe-inline' 'unsafe-eval'; ` +
              // No frames, objects, or workers: a nested document (even another artifact's
              // view-mode URL on Binder's own origin) would not carry this policy.
              `frame-src 'none'; object-src 'none'; worker-src 'none'`
            : VIEW_CSP,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600", // a version never changes; the URL rotates hourly
        "referrer-policy": "no-referrer",
      },
    });
  }

  /** The page Chromium screenshots for previews. Frames are limited to Binder's own content path. */
  function renderWrapper(id: string, n: number, tok: string): Response {
    if (sign.verify(id, n, tok) !== "render") return new Response("forbidden", { status: 403 });
    const v = db.version(id, n);
    if (!v) return new Response("not found", { status: 404 });
    const prefix = `/c/${id}/${n}/${tok}/`;
    const src = prefix + v.entry;
    return new Response(
      `<!doctype html><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style>` +
        `<iframe sandbox="allow-scripts" src="${src}"></iframe>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Pinned to this render grant, so the frame cannot navigate itself to any other /c/ URL.
          "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-src ${renderOrigin}${prefix}`,
          "referrer-policy": "no-referrer",
        },
      },
    );
  }
  async function staticFile(path: string): Promise<Response> {
    const p = safePath(path);
    const file = p ? Bun.file(join(PUBLIC_DIR, p)) : null;
    if (!file || !(await file.exists())) return new Response("not found", { status: 404 });
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    if (p!.endsWith(".html")) headers["content-security-policy"] = SHELL_CSP;
    return new Response(file, { headers });
  }

  const secureCookie = (req: Request) =>
    originOf(req).startsWith("https:") || req.headers.get("x-forwarded-proto") === "https";

  /** Trades a token for a browser session cookie. The cookie never reaches artifact pages (SameSite=Strict). */
  async function signIn(req: Request): Promise<Response> {
    let body: { token?: unknown };
    try {
      body = (await req.json()) as { token?: unknown };
    } catch {
      return fail(400, "expected a JSON body with a 'token' field");
    }
    const t = typeof body.token === "string" ? auth.checkToken(body.token.trim()) : null;
    if (!t) return fail(401, "invalid or revoked token");
    const { value, maxAge } = auth.sessionValue(t);
    const attrs = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie(req) ? "; Secure" : ""}`;
    return json({ name: t.name, scope: t.scope, via: "session" }, 200, { "set-cookie": `${SESSION_COOKIE}=${value}; ${attrs}` });
  }
  const signOut = (req: Request) =>
    json({ signed_out: true }, 200, {
      "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie(req) ? "; Secure" : ""}`,
    });

  async function fetch(req: Request, server?: { requestIP(r: Request): { address: string } | null }): Promise<Response> {
    const url = new URL(req.url);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return fail(400, "bad url");
    }
    const method = req.method;
    let m: RegExpMatchArray | null;

    if (path === "/healthz") return new Response("ok");
    if (method === "GET" || method === "HEAD") {
      // The UI shell is public. It holds no data, so a signed-out browser can show the sign-in screen.
      if (path === "/" || path.startsWith("/a/")) return staticFile("index.html");
      if (!/^\/(api|raw|thumb|c|render)\//.test(path)) return staticFile(path.slice(1));
      if ((m = path.match(/^\/c\/([\w-]+)\/(\d+)\/([\w.-]+)\/?(.*)$/))) return content(m[1]!, Number(m[2]), m[3]!, m[4]!);
      if ((m = path.match(/^\/render\/([\w-]+)\/(\d+)\/([\w.-]+)$/))) return renderWrapper(m[1]!, Number(m[2]), m[3]!);
    }

    const isWrite = method !== "GET" && method !== "HEAD";
    if (isWrite && !mutationAllowed(req)) return fail(403, "mutations need the header 'X-Binder: 1'");
    if (path === "/api/session" && method === "POST") return signIn(req);
    if (path === "/api/session" && method === "DELETE") return signOut(req);

    const result = auth.identify(req, server?.requestIP(req)?.address ?? null);
    if (!result.ok) return fail(result.status, result.error);
    const who = result.who;
    if (path === "/api/session" && method === "GET") return json(who);
    if (isWrite && who.scope !== "write") return fail(403, "this identity can read but not write");

    if (path === "/api/artifacts") {
      if (method === "GET") return json({ artifacts: db.list().map((a) => view(a, originOf(req))) });
      if (method === "POST") return publish(req, who);
    }
    if ((m = path.match(/^\/api\/artifacts\/([\w-]+)$/))) {
      const id = m[1]!;
      if (method === "GET") {
        const a = db.get(id);
        return a ? json(view(a, originOf(req))) : fail(404, "not found");
      }
      if (method === "PATCH") return patch(id, req);
      if (method === "DELETE") return remove(id);
    }
    if ((m = path.match(/^\/api\/artifacts\/([\w-]+)\/versions$/)) && method === "GET") return history(m[1]!, req);
    if ((m = path.match(/^\/api\/artifacts\/([\w-]+)\/versions\/(\d+)\/restore$/)) && method === "POST")
      return restore(m[1]!, Number(m[2]), who, req);
    if ((m = path.match(/^\/api\/artifacts\/([\w-]+)\/thumbnail$/)) && method === "POST") {
      if (!db.get(m[1]!)) return fail(404, "not found");
      rmSync(thumbs.path(m[1]!), { force: true });
      db.setThumb(m[1]!, false);
      thumbs.enqueue(m[1]!);
      return json({ queued: m[1] }, 202);
    }
    // Old links: send the caller to the signed URL of the current version.
    if ((m = path.match(/^\/raw\/([\w-]+)\/?(.*)$/))) {
      const a = db.get(m[1]!);
      if (!a) return new Response("not found", { status: 404 });
      const rest = safePath(m[2] || a.entry) ?? a.entry;
      return new Response(null, {
        status: 302,
        headers: { location: `${sign.contentPath(a.id, a.version)}/${rest}`, "cache-control": "no-store" },
      });
    }
    if ((m = path.match(/^\/thumb\/([\w-]+)\.png$/))) {
      const f = Bun.file(thumbs.path(m[1]!));
      return (await f.exists())
        ? new Response(f, { headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" } })
        : new Response("not found", { status: 404 });
    }
    if (path.startsWith("/api/")) return fail(404, "no such route");
    return method === "GET" ? new Response("not found", { status: 404 }) : fail(405, "method not allowed");
  }

  /** Call once the server listens, with an http origin on loopback that Chromium can reach. */
  function started(loopbackOrigin: string) {
    renderOrigin = loopbackOrigin;
    renderSources = `${renderOrigin} ${hostSources}`;
    thumbs.start(loopbackOrigin);
  }

  return { fetch, started, db, thumbs };
}

if (import.meta.main) {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(String((e as Error).message));
    process.exit(1);
  }
  const app = createApp(cfg);
  if (cfg.devAnonymous) console.warn("BINDER_DEV_ANONYMOUS=1: authentication is OFF. Never use this outside local development.");
  else if (!cfg.authHeader && !app.db.tokens.list().some((t) => !t.revoked_at))
    console.log("No tokens yet. Create one with: binder token create --name <you>   (in Docker: docker compose exec binder binder token create --name <you>)");
  const server = Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    maxRequestBodySize: 80 * 1024 * 1024,
    fetch: app.fetch,
  });
  const loopback = ["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(cfg.host) ? "127.0.0.1" : cfg.host;
  app.started(`http://${loopback}:${server.port}`);
  console.log(`binder on http://${server.hostname}:${server.port} (data ${cfg.dataDir}, previews ${app.thumbs.available ? "on" : "off"})`);
}
