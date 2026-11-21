// With S3 storage, writes wait for Litestream to copy the database, and /healthz fails when the copy lags.
// A fake Litestream control socket stands in for the real one; scripts/e2e-s3.sh runs the real one.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { litestream, MAX_LAG_MS } from "../src/replication";
import { owner, publisher, startBinder } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "binder-repl-"));
const socket = join(dir, "litestream.sock");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// What the fake answers: the local transaction id, how far S3 has it, and whether a wait succeeds.
const state = { txid: 7, replicated: 7, waitFails: false, raw: null as string | null };
const calls: { path: string; wait: boolean }[] = [];
const fake = Bun.serve({
  unix: socket,
  async fetch(req) {
    const body = (await req.json()) as { path: string; wait: boolean };
    calls.push({ path: body.path, wait: body.wait });
    if (state.raw !== null) return new Response(state.raw, { headers: { "content-type": "application/json" } });
    if (body.wait && state.waitFails) return Response.json({ error: "sync database: fake S3 is down" }, { status: 500 });
    if (body.wait) state.replicated = state.txid;
    return Response.json({ status: "synced", txid: state.txid, replicated_txid: state.replicated });
  },
});
afterAll(() => fake.stop(true));

let clock = Date.parse("2026-11-21T12:00:00Z");
const repl = litestream(socket, "/data/binder.sqlite", { now: () => clock });
const b = startBinder({}, { replication: repl, now: () => clock });
const publish = publisher(b.base);
afterAll(() => b.stop());

test("a write is answered only after Litestream confirms it is in S3", async () => {
  calls.length = 0;
  state.waitFails = false;
  const r = await publish({ id: "doc", title: "Doc" }, [["index.html", "<p>1</p>"]]);
  expect(r.status).toBe(201);
  expect(calls).toEqual([{ path: "/data/binder.sqlite", wait: true }]);
  // Reads and sign-in never wait.
  calls.length = 0;
  await fetch(`${b.base}/api/artifacts`, { headers: owner });
  expect(calls).toEqual([]);
});

test("a write that cannot be confirmed in S3 answers 503, not a success", async () => {
  state.waitFails = true;
  const r = await publish({ id: "doc", title: "Doc" }, [["index.html", "<p>2</p>"]]);
  expect(r.status).toBe(503);
  expect((await r.json()).error).toMatch(/copying it to S3 failed.*fake S3 is down/);
  state.waitFails = false;
});

test("/healthz fails once the copy has lagged longer than the bound, and recovers", async () => {
  const health = async () => {
    clock += 10_000; // past the health cache
    const r = await fetch(`${b.base}/healthz`);
    return { status: r.status, body: await r.json() };
  };
  state.txid = 20;
  state.replicated = 20;
  expect((await health()).status).toBe(200);
  state.txid = 21; // a new write that S3 does not have yet
  const first = await health();
  expect(first.status).toBe(200);
  expect(first.body.replication).toMatch(/S3 has transaction 20 of 21/);
  // Stalled: S3 stays at 20 while the local database stays at 21.
  clock += MAX_LAG_MS; // still behind, beyond the bound
  const late = await health();
  expect(late.status).toBe(503);
  expect(late.body.ok).toBe(false);
  state.replicated = 21;
  expect((await health()).status).toBe(200);
});

test("/healthz fails when Litestream cannot be reached", async () => {
  const gone = litestream(join(dir, "missing.sock"), "/data/binder.sqlite", { now: () => clock });
  expect(await gone.health()).toMatchObject({ ok: false, detail: expect.stringMatching(/cannot reach Litestream/) });
  await expect(gone.flush()).rejects.toThrow(/cannot reach Litestream/);
});

test("local storage never asks Litestream", async () => {
  const local = startBinder();
  try {
    calls.length = 0;
    expect((await publisher(local.base)({ title: "x" }, [["index.html", "x"]])).status).toBe(201);
    expect((await (await fetch(`${local.base}/healthz`)).json()).replication).toBeUndefined();
    expect(calls).toEqual([]);
  } finally {
    local.stop();
  }
});

test("/healthz stays healthy when the copy keeps up one transaction behind under steady writes", async () => {
  // Every probe sees a new local transaction, and S3 has the one before it: the copy is moving.
  for (let i = 0; i < 20; i++) {
    state.txid = 100 + i;
    state.replicated = 99 + i;
    clock += 10_000; // 200 s in all, far past the 60 s bound
    const r = await fetch(`${b.base}/healthz`);
    expect(r.status).toBe(200);
  }
  state.replicated = state.txid;
});

test("a write reached through an encoded path still waits for the copy", async () => {
  state.waitFails = true;
  // /%61pi/artifacts decodes to /api/artifacts, which the router serves.
  const r = await fetch(`${b.base}/%61pi/artifacts`, {
    method: "POST",
    headers: { ...owner, "x-binder": "1" },
    body: (() => { const f = new FormData(); f.set("meta", JSON.stringify({ id: "enc", title: "Enc" })); f.append("file", new File(["<p>e</p>"], "index.html")); return f; })(),
  });
  expect(r.status).toBe(503);
  state.waitFails = false;
});

test("a malformed or cut-short reply from Litestream is never read as copied", async () => {
  for (const raw of ["{}", '{"status":"synced"}', '{"status":"synced","txid":0,"replicated_txid":0}', '{"status":"synced","txid":5,"repl', '{"status":"what","txid":5,"replicated_txid":5}']) {
    state.raw = raw;
    clock += 10_000;
    await expect(repl.flush()).rejects.toThrow(/cannot read/);
    expect((await repl.health()).ok).toBe(false);
  }
  state.raw = null;
});

describe("binder token with S3 storage", () => {
  const cliDir = mkdtempSync(join(tmpdir(), "binder-cli-"));
  afterAll(() => rmSync(cliDir, { recursive: true, force: true }));
  // The server trims BINDER_STORAGE, so the CLI must too: a stray space must not skip the copy.
  const env = {
    BINDER_DATA_DIR: cliDir, BINDER_STORAGE: " s3://binder-data/team-a ", AWS_REGION: "us-east-1",
    BINDER_SECRET_KEY: Buffer.alloc(32, 9).toString("base64"), BINDER_LITESTREAM_SOCKET: socket,
  };

  test("prints a token only after Litestream confirms it is in S3", async () => {
    calls.length = 0;
    state.waitFails = false;
    const out: string[] = [];
    expect(await run(["token", "create", "--name", "ci"], env, (s) => out.push(s))).toBe(0);
    expect(out[0]).toMatch(/^bnd_/);
    expect(calls).toEqual([{ path: join(cliDir, "binder.sqlite"), wait: true }]);
  });

  test("a token whose copy fails is never printed, and is taken back", async () => {
    state.waitFails = true;
    const out: string[] = [];
    expect(await run(["token", "create", "--name", "lost"], env, (s) => out.push(s))).toBe(1);
    expect(out).toEqual([]);
    state.waitFails = false;
    const list: string[] = [];
    await run(["token", "list"], env, (s) => list.push(s));
    expect(list.find((l) => l.includes("lost"))).toContain("REVOKED");
  });

  test("a revoke whose copy fails says so and exits 1", async () => {
    state.waitFails = true;
    const out: string[] = [];
    expect(await run(["token", "revoke", "ci"], env, (s) => out.push(s))).toBe(1);
    expect(out).toEqual([]);
    state.waitFails = false;
  });
});
