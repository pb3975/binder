// The landing page (site/), as scripts/build-site.sh publishes it to GitHub Pages.
// Checks the built output: every local link resolves, nothing loads from another origin,
// the CSP holds, and the commands and numbers on the page still match the docs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const build = (out: string) => Bun.spawnSync([join(root, "scripts/build-site.sh"), out], { stderr: "pipe", stdout: "pipe" });
const read = (path: string) => readFileSync(join(root, path), "utf8");
const CSP = "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'";

let tmp: string;
let out: string;
let html: string;
let css: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "binder-site-"));
  out = join(tmp, "site");
  const r = build(out);
  if (r.exitCode !== 0) throw new Error(`build-site.sh failed: ${r.stderr}`);
  html = readFileSync(join(out, "index.html"), "utf8");
  css = readFileSync(join(out, "site.css"), "utf8");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Every start tag with its attributes, so a check knows which element holds a URL. */
const tags = () =>
  [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map(([, name, attrs]) => ({
    name: name!.toLowerCase(),
    attrs: Object.fromEntries([...attrs!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k!.toLowerCase(), v ?? ""])),
  }));
const decode = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** The text of each <pre> that says which doc it is copied from. */
const sourced = () =>
  [...html.matchAll(/<pre ([^>]*data-source="([^"]+)"[^>]*)>([\s\S]*?)<\/pre>/g)].map(([, attrs, source, body]) => ({
    source: source!,
    lines: /data-match="lines"/.test(attrs!),
    count: Number(/data-lines="(\d+)"/.exec(attrs!)?.[1] ?? 0),
    text: decode(body!),
  }));

describe("build-site.sh", () => {
  test("copies the page, fonts, icon, and screenshots, and marks the folder for Pages", () => {
    for (const f of ["index.html", "site.css", "site.js", "icon.svg", ".nojekyll", "fonts/inter.woff2", "fonts/fraunces.woff2", "images/library.png", "images/library-dark.png"])
      expect(existsSync(join(out, f))).toBe(true);
  });

  test("a rerun gives the same files", () => {
    const list = (d: string): string[] => readdirSync(d, { recursive: true, encoding: "utf8" }).sort();
    const before = list(out);
    expect(build(out).exitCode).toBe(0);
    expect(list(out)).toEqual(before);
  });

  test("refuses the filesystem root, the repo root, an empty path, and a folder it did not make", () => {
    expect(build("/").exitCode).not.toBe(0);
    expect(build(root).exitCode).not.toBe(0);
    expect(build("").exitCode).not.toBe(0);
    const foreign = join(tmp, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.txt"), "not the site's");
    expect(build(foreign).exitCode).not.toBe(0);
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("not the site's");
  });
});

describe("landing page", () => {
  test("every attribute value is plain text, so no markup leaks into an attribute", () => {
    for (const t of tags()) for (const [k, v] of Object.entries(t.attrs)) expect(`${t.name} ${k}=${v}`).not.toMatch(/[<>]/);
    expect(html.match(/<head>[\s\S]*<\/head>/)?.[0]).not.toMatch(/<(span|div|p|a)\b/);
  });

  test("has the exact CSP, and no inline style or script to need an exception", () => {
    const meta = tags().find((t) => t.name === "meta" && t.attrs["http-equiv"] === "Content-Security-Policy");
    expect(meta?.attrs.content).toBe(CSP);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    for (const s of tags().filter((t) => t.name === "script")) expect(s.attrs.src).toBeTruthy();
  });

  test("loads nothing from another origin and uses no root-absolute path", () => {
    const loads = tags().flatMap((t) =>
      ["src", "srcset", "href"].filter((a) => a in t.attrs).map((a) => ({ tag: t.name, rel: t.attrs.rel, url: t.attrs[a]! })));
    for (const { tag, rel, url } of loads) {
      expect(url.startsWith("/")).toBe(false); // root-absolute or protocol-relative breaks under /binder/
      if (tag === "a" || (tag === "link" && rel === "canonical")) continue; // links, not loads
      expect(url).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
    for (const [, url] of css.matchAll(/url\(\s*["']?([^"')]+)/g)) {
      expect(url!.startsWith("/")).toBe(false);
      expect(url).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
    }
    expect(css).not.toMatch(/@import/);
    expect(readFileSync(join(out, "site.js"), "utf8")).not.toMatch(/:\/\//);
  });

  test("every local href, src, and url() resolves to a built file or an id on the page", () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const local = tags()
      .flatMap((t) => ["src", "srcset", "href"].filter((a) => a in t.attrs).map((a) => t.attrs[a]!))
      .concat([...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]!))
      .filter((u) => !/^[a-z][a-z0-9+.-]*:/i.test(u));
    expect(local.length).toBeGreaterThan(5);
    for (const url of local) {
      if (url.startsWith("#")) expect(ids.has(url.slice(1))).toBe(true);
      else if (url === "./") expect(existsSync(join(out, "index.html"))).toBe(true);
      else expect(existsSync(join(out, url.split(/[?#]/)[0]!))).toBe(true);
    }
  });

  test("shows the commands exactly as the docs have them", () => {
    const blocks = sourced();
    expect(blocks.map((b) => b.source)).toEqual(["README.md", "docs/design.md", "README.md"]);
    for (const b of blocks) {
      const doc = read(b.source);
      if (b.lines) for (const line of b.text.split("\n")) expect(doc).toContain(line);
      else expect(doc).toContain(b.text);
      if (b.count) expect(b.text.split("\n").length).toBe(b.count);
    }
  });

  test("the numbers it states still hold in the docs", () => {
    const claims = [...html.matchAll(/data-claim="([^"]+)"/g)].map((m) => m[1]!);
    expect(claims.length).toBeGreaterThan(0);
    const docs = read("README.md") + read("docs/design.md");
    for (const c of claims) expect(docs).toContain(c);
  });

  test("the history model uses the demo artifact's real notes", () => {
    const demo = read("scripts/demo.ts");
    const notes = [...html.matchAll(/<span class="note">([^<]+)<\/span>/g)].map((m) => decode(m[1]!));
    expect(notes).toEqual(["Fix the backoff numbers after review", "Add jitter and the dead-letter diagram", "First draft"]);
    for (const n of notes) expect(demo).toContain(`note: "${n}"`);
  });
});
