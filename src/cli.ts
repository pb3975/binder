// Admin CLI. It works on the data folder directly, so whoever can run it on the server is the admin.
// Usage: binder token create --name <name> [--scope read|write] | binder token list | binder token revoke <name|id>
import { newToken } from "./auth";
import { loadConfig, type Config } from "./config";
import { mkdirSync } from "node:fs";
import { openDb } from "./db";
import { openReplication } from "./replication";

const AUTH_ENV = /^(BINDER_AUTH|BINDER_AUTH_HEADER|BINDER_TRUSTED_PROXIES|BINDER_ALLOWED_USERS|BINDER_ALLOWED_GROUPS|BINDER_DEV_ANONYMOUS|BINDER_OIDC_\w+|ALLOWED_LOGINS|DEV_ALLOW_ANONYMOUS)$/;

const USAGE = `usage:
  binder token create --name <name> [--scope write|read]   print a new token (shown once)
  binder token list                                        list tokens (never shows secrets)
  binder token revoke <name|id>                            revoke a token and its browser sessions`;

export async function run(argv: string[], env: Record<string, string | undefined> = process.env, out = console.log): Promise<number> {
  const [group, cmd, ...rest] = argv;
  if (group !== "token" || !cmd) return (out(USAGE), 2);
  const flag = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  // The server's own parser, so storage and the Litestream socket mean the same thing here. Auth and
  // preview settings are dropped: they apply to the server, and auth settings must never stop an
  // admin from making a token.
  let cfg: Config;
  try {
    const kept = Object.entries(env).filter(([k]) => !AUTH_ENV.test(k));
    cfg = loadConfig({ ...Object.fromEntries(kept), BINDER_PREVIEWS: "off" });
  } catch (e) {
    console.error(`binder: ${(e as Error).message}`);
    return 2;
  }
  mkdirSync(cfg.dataDir, { recursive: true }); // a fresh install may run the CLI before the server
  const db = openDb(cfg.dataDir, { migrate: cfg.storage.kind === "local" });
  const replication = openReplication(cfg);
  /** With S3 storage, a token change counts only once Litestream has copied it to S3. */
  const copied = async (): Promise<string | null> => {
    try {
      await replication?.flush();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
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
      const failed = await copied();
      if (failed) {
        // Never hand out a token that a restart could forget: take it back and say so.
        db.tokens.revoke(row.id, at);
        console.error(`binder: token not created; copying it to S3 failed: ${failed}`);
        return 1;
      }
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
      // A retry after a failed copy finds the token already revoked here. It must still wait for the
      // copy, or a restore from S3 could bring the token back.
      const known = n > 0 || db.tokens.list().some((t) => (t.name === target || t.id === target) && t.revoked_at);
      if (!known) return (out(`no token named ${target}`), 1);
      const failed = await copied();
      if (failed) {
        console.error(`binder: ${target} is revoked on this server, but copying that to S3 failed, so a restart could bring the token back. Run the command again. ${failed}`);
        return 1;
      }
      out(`revoked ${target}`);
      return 0;
    }
    out(USAGE);
    return 2;
  } finally {
    db.close();
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
