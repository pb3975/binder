// Builds a schema v1 data folder (Binder before version history) from synthetic data.
// The DDL is copied verbatim from src/db.ts at commit 220c2ec.
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const V1_DDL = `
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT 'general',
    domain TEXT NOT NULL DEFAULT 'general',
    kind TEXT NOT NULL DEFAULT 'other',
    tags TEXT NOT NULL DEFAULT '[]',
    entry TEXT NOT NULL,
    files TEXT NOT NULL DEFAULT '[]',
    bytes INTEGER NOT NULL DEFAULT 0,
    source_url TEXT,
    agent TEXT,
    host TEXT,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    thumb INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1
  );
  PRAGMA user_version = 1;
`;

export type V1Artifact = { id: string; version: number; files: Record<string, string>; title?: string };

export function writeV1(dataDir: string, artifacts: V1Artifact[]) {
  mkdirSync(join(dataDir, "trash"), { recursive: true });
  const db = new Database(join(dataDir, "binder.sqlite"), { create: true });
  db.exec(V1_DDL);
  for (const a of artifacts) {
    const dir = join(dataDir, "artifacts", a.id);
    for (const [p, body] of Object.entries(a.files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    const files = Object.entries(a.files).map(([path, body]) => ({ path, size: body.length, type: "text/html;charset=utf-8" }));
    db.query(
      `INSERT INTO artifacts (id, title, summary, project, domain, kind, tags, entry, files, bytes, source_url, agent, host,
        published_at, created_at, updated_at, thumb, version)
       VALUES (?, ?, 'Synthetic fixture.', 'demo', 'general', 'explainer', '["fixture"]', 'index.html', ?, ?, NULL, 'test-agent', 'test-host',
        '2026-11-01T12:00:00.000Z', '2026-11-01T12:00:00.000Z', '2026-11-02T12:00:00.000Z', 1, ?)`,
    ).run(a.id, a.title ?? a.id, JSON.stringify(files), files.reduce((n, f) => n + f.size, 0), a.version);
  }
  db.close();
}
