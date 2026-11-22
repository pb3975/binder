// Edits and removals that arrive while a restore awaits storage are never overwritten by it.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localStorage, type Storage } from "../src/storage";
import { owner, publisher, startBinder, writer } from "./helpers";

// Local storage whose reads wait while the gate is shut, like a slow S3 GET.
const dataDir = mkdtempSync(join(tmpdir(), "binder-race-"));
const inner = localStorage(dataDir);
let gate: Promise<void> | null = null;
let open = () => {};
let reading = () => {};
const readStarted = () => new Promise<void>((r) => (reading = r));
const slow: Storage = Object.assign(Object.create(inner), {
  async read(key: string) {
    reading();
    if (gate) await gate;
    return inner.read(key);
  },
});
const shut = () => (gate = new Promise((r) => (open = () => { gate = null; r(); })));

const b = startBinder({}, { dataDir, storage: slow });
const publish = publisher(b.base);
afterAll(() => b.stop());
const api = (path: string, init: RequestInit = {}) => fetch(`${b.base}/api/artifacts/${path}`, { headers: writer, ...init });

async function restoreWhile(id: string, during: () => Promise<Response>) {
  shut();
  const started = readStarted();
  const restore = api(`${id}/versions/1/restore`, { method: "POST" });
  await started; // the restore holds the old row and is waiting on storage
  const other = during();
  await Bun.sleep(20); // give the other request every chance to finish first
  open();
  return Promise.all([restore, other]);
}

test("a removal during a restore stays removed", async () => {
  await publish({ id: "gone", title: "Gone" }, [["index.html", "<p>1</p>"]]);
  await publish({ id: "gone", title: "Gone" }, [["index.html", "<p>2</p>"]]);
  const [, del] = await restoreWhile("gone", () => api("gone", { method: "DELETE" }));
  expect(del.status).toBe(200);
  expect((await fetch(`${b.base}/api/artifacts/gone`, { headers: owner })).status).toBe(404);
});

test("an edit during a restore is kept", async () => {
  await publish({ id: "kept", title: "Kept" }, [["index.html", "<p>1</p>"]]);
  await publish({ id: "kept", title: "Kept" }, [["index.html", "<p>2</p>"]]);
  const [, edit] = await restoreWhile("kept", () =>
    api("kept", { method: "PATCH", headers: { ...writer, "content-type": "application/json" }, body: JSON.stringify({ summary: "edited" }) }),
  );
  expect(edit.status).toBe(200);
  const a = await (await fetch(`${b.base}/api/artifacts/kept`, { headers: owner })).json();
  expect(a.summary).toBe("edited");
  expect(a.version).toBe(3);
});
