import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export type FileEntry = { path: string; size: number; type: string; sha256: string };

/** What is true of an artifact now. Metadata is editable; content lives in versions. */
export type ArtifactRow = {
  id: string;
  title: string;
  summary: string;
  project: string;
  domain: string;
  kind: string;
  tags: string[];
  source_url: string | null;
  published_at: string;
  created_at: string;
  updated_at: string;
  version: number;
  thumb: boolean;
  deleted_at: string | null;
};

/** One immutable publish. */
export type Version = {
  artifact_id: string;
  version: number;
  title: string;
  entry: string;
  files: FileEntry[];
  bytes: number;
  note: string;
  published_by: string;
  agent: string | null;
  host: string | null;
  created_at: string;
};

/** A publish or read credential. Only the SHA-256 of the secret is stored. */
export type Token = {
  id: string;
  name: string;
  scope: "read" | "write";
  hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** The shape the API returns: the artifact plus its current version's content fields. */
export type Artifact = Omit<ArtifactRow, "deleted_at"> &
  Pick<Version, "entry" | "files" | "bytes" | "note" | "published_by" | "agent" | "host">;

export const SCHEMA_VERSION = 2;

const V2_DDL = `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT 'general',
    domain TEXT NOT NULL DEFAULT 'general',
    kind TEXT NOT NULL DEFAULT 'other',
    tags TEXT NOT NULL DEFAULT '[]',
    source_url TEXT,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL,
    thumb INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT
  );
  CREATE TABLE versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    entry TEXT NOT NULL,
    files TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    published_by TEXT NOT NULL DEFAULT '',
    agent TEXT,
    host TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );
`;

// Added after schema v2 first shipped, so it is created idempotently on every open
// instead of only in V2_DDL: a v2 database from before tokens existed gets it too.
const TOKENS_DDL = `
  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS tokens_live_name ON tokens (name) WHERE revoked_at IS NULL;
`;

export const versionDir = (dataDir: string, id: string, version: number) =>
  join(dataDir, "versions", id, String(version));

export function sha256(bytes: ArrayBuffer | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Schema v1 kept the current files in artifacts/<id>/ and one row per artifact.
 * v2 keeps every version in versions/<id>/<n>/. The folder renames run first and
 * are skipped when already done, so a crash at any point converges on rerun:
 * user_version only moves to 2 in the same transaction that rewrites the tables.
 */
function migrateV1(db: Database, dataDir: string) {
  type V1 = {
    id: string; title: string; summary: string; project: string; domain: string; kind: string; tags: string;
    entry: string; files: string; bytes: number; source_url: string | null; agent: string | null; host: string | null;
    published_at: string; created_at: string; updated_at: string; thumb: number; version: number;
  };
  const rows = db.query("SELECT * FROM artifacts").all() as V1[];
  const versions: Version[] = [];
  for (const r of rows) {
    const dst = versionDir(dataDir, r.id, r.version);
    const src = join(dataDir, "artifacts", r.id);
    if (!existsSync(dst) && existsSync(src)) {
      mkdirSync(join(dataDir, "versions", r.id), { recursive: true });
      renameSync(src, dst);
    }
    const old = JSON.parse(r.files) as { path: string; size: number; type: string }[];
    const files: FileEntry[] = old.map((f) => {
      const p = join(dst, f.path);
      return { ...f, sha256: existsSync(p) ? sha256(readFileSync(p)) : "" };
    });
    if (!existsSync(dst)) console.warn(`migrate: files for ${r.id} v${r.version} are missing`);
    versions.push({
      artifact_id: r.id, version: r.version, title: r.title, entry: r.entry, files, bytes: r.bytes,
      note: "", published_by: "", agent: r.agent, host: r.host, created_at: r.updated_at,
    });
  }
  db.transaction(() => {
    db.exec("ALTER TABLE artifacts RENAME TO artifacts_v1");
    db.exec(V2_DDL);
    db.exec(`INSERT INTO artifacts (id, title, summary, project, domain, kind, tags, source_url, published_at,
               created_at, updated_at, version, thumb)
             SELECT id, title, summary, project, domain, kind, tags, source_url, published_at,
               created_at, updated_at, version, thumb FROM artifacts_v1`);
    const ins = db.prepare(`INSERT INTO versions VALUES ($artifact_id, $version, $title, $entry, $files, $bytes,
      $note, $published_by, $agent, $host, $created_at)`);
    for (const v of versions) ins.run(versionParams(v));
    db.exec("DROP TABLE artifacts_v1");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
}

const versionParams = (v: Version) =>
  ({
    $artifact_id: v.artifact_id, $version: v.version, $title: v.title, $entry: v.entry,
    $files: JSON.stringify(v.files), $bytes: v.bytes, $note: v.note, $published_by: v.published_by,
    $agent: v.agent, $host: v.host, $created_at: v.created_at,
  }) as never;

type ArtifactDbRow = Omit<ArtifactRow, "tags" | "thumb"> & { tags: string; thumb: number };
type VersionDbRow = Omit<Version, "files"> & { files: string };

const toRow = (r: ArtifactDbRow): ArtifactRow => ({ ...r, tags: JSON.parse(r.tags), thumb: r.thumb === 1 });
const toVersion = (r: VersionDbRow): Version => ({ ...r, files: JSON.parse(r.files) });

export function openDb(dataDir: string) {
  const db = new Database(join(dataDir, "binder.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (user_version > SCHEMA_VERSION)
    throw new Error(`binder.sqlite has schema v${user_version}; this Binder reads up to v${SCHEMA_VERSION}. Upgrade Binder.`);
  if (user_version === 1) migrateV1(db, dataDir);
  else if (user_version === 0) db.transaction(() => db.exec(V2_DDL + `PRAGMA user_version = ${SCHEMA_VERSION};`))();
  db.exec(TOKENS_DDL);

  const artifactCols = [
    "id", "title", "summary", "project", "domain", "kind", "tags", "source_url", "published_at",
    "created_at", "updated_at", "version", "thumb", "deleted_at",
  ];
  const upsertArtifact = db.prepare(
    `INSERT OR REPLACE INTO artifacts (${artifactCols.join(",")}) VALUES (${artifactCols.map((c) => "$" + c).join(",")})`,
  );
  const insertVersion = db.prepare(`INSERT INTO versions VALUES ($artifact_id, $version, $title, $entry, $files,
    $bytes, $note, $published_by, $agent, $host, $created_at)`);

  function saveArtifact(a: ArtifactRow) {
    const params: Record<string, unknown> = {};
    for (const c of artifactCols) params["$" + c] = (a as Record<string, unknown>)[c];
    params.$tags = JSON.stringify(a.tags);
    params.$thumb = a.thumb ? 1 : 0;
    upsertArtifact.run(params as never);
  }

  const joined = `SELECT a.*, v.entry, v.files, v.bytes, v.note, v.published_by, v.agent, v.host
    FROM artifacts a JOIN versions v ON v.artifact_id = a.id AND v.version = a.version`;
  const toArtifact = (r: ArtifactDbRow & VersionDbRow): Artifact => {
    const { deleted_at: _, ...rest } = toRow(r);
    return { ...rest, entry: r.entry, files: JSON.parse(r.files), bytes: r.bytes, note: r.note,
      published_by: r.published_by, agent: r.agent, host: r.host };
  };

  return {
    list(): Artifact[] {
      return (db.query(`${joined} WHERE a.deleted_at IS NULL ORDER BY a.published_at DESC, a.title`).all() as never[]).map(toArtifact);
    },
    get(id: string): Artifact | null {
      const r = db.query(`${joined} WHERE a.id = ? AND a.deleted_at IS NULL`).get(id) as never;
      return r ? toArtifact(r) : null;
    },
    /** Includes removed artifacts, so ids are never reused. */
    row(id: string): ArtifactRow | null {
      const r = db.query("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactDbRow | null;
      return r ? toRow(r) : null;
    },
    versions(id: string): Version[] {
      return (db.query("SELECT * FROM versions WHERE artifact_id = ? ORDER BY version DESC").all(id) as VersionDbRow[]).map(toVersion);
    },
    version(id: string, n: number): Version | null {
      const r = db.query("SELECT * FROM versions WHERE artifact_id = ? AND version = ?").get(id, n) as VersionDbRow | null;
      return r ? toVersion(r) : null;
    },
    /**
     * Allocates the next version number and records it, in one transaction.
     * `place(n)` moves the staged files into the version folder. It runs inside the
     * transaction and is synchronous, so concurrent publishes never share a number.
     */
    commit(next: Omit<ArtifactRow, "version">, v: Omit<Version, "version" | "artifact_id">, place: (n: number) => void): number {
      return db.transaction(() => {
        const { n } = db.query("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM versions WHERE artifact_id = ?").get(next.id) as { n: number };
        place(n);
        saveArtifact({ ...next, version: n });
        insertVersion.run(versionParams({ ...v, artifact_id: next.id, version: n }));
        return n;
      })();
    },
    saveArtifact,
    setThumb(id: string, has: boolean) {
      db.query("UPDATE artifacts SET thumb = ? WHERE id = ?").run(has ? 1 : 0, id);
    },
    softDelete(id: string, at: string) {
      db.query("UPDATE artifacts SET deleted_at = ? WHERE id = ?").run(at, id);
    },
    tokens: {
      insert(t: Token) {
        db.query("INSERT INTO tokens VALUES ($id, $name, $scope, $hash, $created_at, $last_used_at, $revoked_at)").run({
          $id: t.id, $name: t.name, $scope: t.scope, $hash: t.hash, $created_at: t.created_at,
          $last_used_at: t.last_used_at, $revoked_at: t.revoked_at,
        } as never);
      },
      get: (id: string) => db.query("SELECT * FROM tokens WHERE id = ?").get(id) as Token | null,
      list: () => db.query("SELECT * FROM tokens ORDER BY revoked_at IS NOT NULL, name").all() as Token[],
      /** Revokes the live token with this name or id. Returns how many were revoked. */
      revoke: (nameOrId: string, at: string) =>
        db.query("UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL AND (name = ? OR id = ?)").run(at, nameOrId, nameOrId).changes,
      touch: (id: string, at: string) => db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(at, id),
    },
    close: () => db.close(),
  };
}

export type Db = ReturnType<typeof openDb>;
