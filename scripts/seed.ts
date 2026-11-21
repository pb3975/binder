// Publishes every <seed-root>/<slug>/ folder that has a meta.json.
// All other files in the folder are uploaded at their relative paths.
// Usage: BINDER_TOKEN=bnd_... bun scripts/seed.ts <seed-root> [binder-url]
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
const base = (process.argv[3] ?? process.env.BINDER_URL ?? "http://127.0.0.1:8480").replace(/\/$/, "");
if (!root) throw new Error("usage: bun scripts/seed.ts <seed-root> [binder-url]");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const dirs = readdirSync(root).map((n) => join(root, n)).filter((d) => existsSync(join(d, "meta.json")));
let ok = 0;
for (const dir of dirs) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  if (meta.skip) continue;
  const form = new FormData();
  form.set("meta", JSON.stringify({ id: meta.slug, ...meta }));
  for (const f of walk(dir)) {
    const rel = relative(dir, f);
    if (rel === "meta.json") continue;
    form.append("file", new File([readFileSync(f)], rel));
  }
  const r = await fetch(`${base}/api/artifacts`, { method: "POST", headers: { "x-binder": "1", ...(process.env.BINDER_TOKEN ? { authorization: `Bearer ${process.env.BINDER_TOKEN}` } : {}) }, body: form });
  const body = await r.json();
  if (r.ok) ok++;
  console.log(r.ok ? `${r.status} ${body.id}` : `FAIL ${meta.slug}: ${body.error}`);
}
console.log(`${ok}/${dirs.length} published to ${base}`);
