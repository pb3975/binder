// Admin CLI. It works on the data folder directly, so whoever can run it on the server is the admin.
// Usage: binder token create --name <name> [--scope read|write] | binder token list | binder token revoke <name|id>
import { newToken } from "./auth";
import { loadConfig } from "./config";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { litestream } from "./replication";

const USAGE = `usage:
  binder token create --name <name> [--scope write|read]   print a new token (shown once)
  binder token list                                        list tokens (never shows secrets)
  binder token revoke <name|id>                            revoke a token and its browser sessions`;

export function run(argv: string[], env: Record<string, string | undefined> = process.env, out = console.log): number {
  const [group, cmd, ...rest] = argv;
  if (group !== "token" || !cmd) return (out(USAGE), 2);
  const flag = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  // Only the data folder matters here; skip auth checks that apply to the server.
  // With S3 storage the database is still local (Litestream copies it to S3), so storage settings do not matter.
  const cfg = loadConfig({ ...env, BINDER_AUTH_HEADER: undefined, BINDER_PREVIEWS: "off", BINDER_STORAGE: undefined, BINDER_SECRET_KEY: undefined });
  mkdirSync(cfg.dataDir, { recursive: true }); // a fresh install may run the CLI before the server
  const db = openDb(cfg.dataDir);
  const at = new Date().toISOString();
  try {
    if (cmd === "create") {
      const name = flag("--name")?.trim();
      const scope = (flag("--scope") ?? "write") as "read" | "write";
      if (!name || !/^[\w.@-]{1,64}$/.test(name)) return (out("--name is required: letters, digits, . _ @ -, up to 64"), 2);
      if (scope !== "read" && scope !== "write") return (out("--scope must be read or write"), 2);
      if (db.tokens.list().some((t) => t.name === name && !t.revoked_at)) return (out(`a live token named ${name} exists; revoke it first`), 1);
      const { token, row } = newToken(name, scope, at);
      db.tokens.insert(row);
      out(token);
      return 0;
    }
    if (cmd === "list") {
      const rows = db.tokens.list();
      if (!rows.length) out("no tokens");
      for (const t of rows)
        out([t.id, t.name.padEnd(20), t.scope.padEnd(5), `created ${t.created_at.slice(0, 10)}`,
          t.last_used_at ? `used ${t.last_used_at.slice(0, 16)}` : "never used", t.revoked_at ? `REVOKED ${t.revoked_at.slice(0, 10)}` : ""].join("  ").trimEnd());
      return 0;
    }
    if (cmd === "revoke") {
      const target = rest[0];
      if (!target) return (out(USAGE), 2);
      const n = db.tokens.revoke(target, at);
      out(n ? `revoked ${target}` : `no live token named ${target}`);
      return n ? 0 : 1;
    }
    out(USAGE);
    return 2;
  } finally {
    db.close();
  }
}

/**
 * With S3 storage, waits until Litestream has copied a token change to S3, so the token survives a
 * task stop right after this command (see src/replication.ts). Returns the exit code.
 */
export async function confirmCopied(argv: string[], env: Record<string, string | undefined>, code: number): Promise<number> {
  if (code !== 0 || !env.BINDER_STORAGE?.startsWith("s3://") || !["create", "revoke"].includes(argv[1] ?? "")) return code;
  if (!env.BINDER_LITESTREAM_SOCKET) {
    console.error("binder: BINDER_STORAGE is s3 but BINDER_LITESTREAM_SOCKET is not set, so this change was not copied to S3");
    return 1;
  }
  const dbPath = join(loadConfig({ BINDER_DATA_DIR: env.BINDER_DATA_DIR, DATA_DIR: env.DATA_DIR }).dataDir, "binder.sqlite");
  try {
    await litestream(env.BINDER_LITESTREAM_SOCKET, dbPath).flush();
    return 0;
  } catch (e) {
    console.error(`binder: the change is saved here but was not copied to S3, so it may be lost if the server stops: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  process.exit(await confirmCopied(argv, process.env, run(argv)));
}
