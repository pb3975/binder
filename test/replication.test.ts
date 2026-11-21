// With S3 storage, writes wait for Litestream to copy the database, and /healthz fails when the copy lags.
// A fake Litestream control socket stands in for the real one; scripts/e2e-s3.sh runs the real one.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { litestream, MAX_LAG_MS } from "../src/replication";
import { owner, publisher, startBinder } from "./helpers";

const dir = mkdtempSync(join(tmpdir(), "binder-repl-"));
const socket = join(dir, "litestream.sock");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// What the fake answers: the local transaction id, how far S3 has it, and whether a wait succeeds.
const state = { txid: 7, replicated: 7, waitFails: false };
const calls: { path: string; wait: boolean }[] = [];
const fake = Bun.serve({
  unix: socket,
  async fetch(req) {
    const body = (await req.json()) as { path: string; wait: boolean };
    calls.push({ path: body.path, wait: body.wait });
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
