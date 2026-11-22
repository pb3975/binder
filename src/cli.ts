// Admin CLI. It works on the data folder directly, so whoever can run it on the server is the admin.
// Usage: binder token create --name <name> [--scope read|write] | binder token list | binder token revoke <name|id>
import { newToken } from "./auth";
import { dataDirOf } from "./config";
import { mkdirSync } from "node:fs";
import { openDb } from "./db";

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
  // Only the data folder matters here, so auth settings never stop an admin from making a token.
  const dataDir = dataDirOf(env);
  mkdirSync(dataDir, { recursive: true }); // a fresh install may run the CLI before the server
  const db = openDb(dataDir);
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

if (import.meta.main) process.exit(run(process.argv.slice(2)));
