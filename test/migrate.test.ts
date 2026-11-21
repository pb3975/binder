// Schema v1 -> v2: existing data folders must keep working after an upgrade.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { writeV1, type V1Artifact } from "./fixtures/v1";
import { owner, startBinder } from "./helpers";

const fixture: V1Artifact[] = [
  { id: "loops", version: 3, files: { "index.html": "<h1>loops v3</h1>" } },
  { id: "bundle", version: 1, files: { "index.html": "<img src=img/a.svg>", "img/a.svg": "<svg/>" } },
];

test("migrates a v1 folder: every artifact keeps its files, metadata, and version number", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "binder-v1-"));
  writeV1(dataDir, fixture);
  const b = startBinder({}, { dataDir });
  try {
    const { artifacts } = await (await fetch(`${b.base}/api/artifacts`, { headers: owner })).json();
    expect(artifacts.map((a: { id: string }) => a.id).sort()).toEqual(["bundle", "loops"]);
    const loops = artifacts.find((a: { id: string }) => a.id === "loops");
    expect(loops).toMatchObject({ version: 3, project: "demo", tags: ["fixture"], agent: "test-agent", published_by: "" });
    expect(await (await fetch(loops.content_url)).text()).toBe("<h1>loops v3</h1>");
    const bundle = artifacts.find((a: { id: string }) => a.id === "bundle");
    expect((await fetch(new URL("img/a.svg", bundle.content_url))).status).toBe(200);
    expect(existsSync(join(dataDir, "artifacts", "loops"))).toBe(false);
    expect(existsSync(join(dataDir, "versions", "loops", "3", "index.html"))).toBe(true);

    // History starts at the migrated version, with file hashes for later diffs.
    const { versions } = await (await fetch(`${b.base}/api/artifacts/loops/versions`, { headers: owner })).json();
    expect(versions).toHaveLength(1);
    expect(versions[0].files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    b.stop();
  }
});

test("a crash between folder renames converges on the next start", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "binder-v1-crash-"));
  writeV1(dataDir, fixture);
  // Simulate a crash after the first rename, before the database was rewritten.
  mkdirSync(join(dataDir, "versions", "loops"), { recursive: true });
  renameSync(join(dataDir, "artifacts", "loops"), join(dataDir, "versions", "loops", "3"));
  const db = openDb(dataDir);
  expect(db.list().map((a) => [a.id, a.version])).toEqual(expect.arrayContaining([["loops", 3], ["bundle", 1]]));
  expect(existsSync(join(dataDir, "versions", "bundle", "1", "img", "a.svg"))).toBe(true);
  db.close();
  // Opening again is a no-op.
  const again = openDb(dataDir);
  expect(again.list()).toHaveLength(2);
  again.close();
});

test("refuses a data folder from a newer Binder", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "binder-future-"));
  const db = openDb(dataDir);
  db.close();
  const raw = new Database(join(dataDir, "binder.sqlite"));
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  expect(() => openDb(dataDir)).toThrow(/schema v99/);
});
