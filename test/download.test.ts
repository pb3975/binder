// Downloading a version: one file as itself, several files as a zip that standard tools open.
import { afterAll, expect, test } from "bun:test";
import { owner, publisher, startBinder, writer } from "./helpers";

const b = startBinder({}, { now: () => Date.parse("2026-11-21T09:30:00Z") });
const publish = publisher(b.base);
afterAll(() => b.stop());
const download = (path: string, headers: Record<string, string> = owner) => fetch(`${b.base}/api/artifacts/${path}`, { headers });

// Python's zipfile is an independent reader: it checks every CRC and the central directory.
const python = Bun.which("python3");
function readZip(bytes: Uint8Array): { names: string[]; files: Record<string, string>; bad: string | null } {
  const script = `import sys, zipfile, io, json
z = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
print(json.dumps({"names": z.namelist(), "files": {n: z.read(n).decode() for n in z.namelist()}, "bad": z.testzip()}))`;
  const r = Bun.spawnSync([python!, "-c", script], { stdin: bytes });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

test("a one-file version downloads as that file, never rendered by the browser", async () => {
  await publish({ id: "solo", title: "Solo" }, [["index.html", "<p>solo</p>"]]);
  const r = await download("solo/download");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-disposition")).toBe('attachment; filename="solo-v1.html"');
  expect(r.headers.get("content-security-policy")).toBe("sandbox");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await r.text()).toBe("<p>solo</p>");
});

test("an odd file name never breaks the download header", async () => {
  await publish({ id: "odd", title: "Odd" }, [['say "hi" é.ht ml', "x"]]);
  const r = await download("odd/download");
  expect(r.status).toBe(200);
  expect(r.headers.get("content-disposition")).toBe('attachment; filename="odd-v1"');
});

test.skipIf(!python)("a multi-file version downloads as a valid zip with a top folder", async () => {
  const big = "<p>" + "repeat ".repeat(2000) + "</p>"; // deflated
  await publish({ id: "deck", title: "Deck" }, [["index.html", big], ["img/a.svg", "<svg/>"], ["notes é.txt", "é"]]);
  const r = await download("deck/download");
  expect(r.headers.get("content-type")).toBe("application/zip");
  expect(r.headers.get("content-disposition")).toBe('attachment; filename="deck-v1.zip"');
  const bytes = new Uint8Array(await r.arrayBuffer());
  expect(bytes.length).toBeLessThan(big.length); // compression ran
  const z = readZip(bytes);
  expect(z.bad).toBeNull();
  expect(z.names.sort()).toEqual(["deck-v1/img/a.svg", "deck-v1/index.html", "deck-v1/notes é.txt"]);
  expect(z.files["deck-v1/index.html"]).toBe(big);
  expect(z.files["deck-v1/notes é.txt"]).toBe("é");
});

test.skipIf(!python)("an old version downloads by number; latest is the default", async () => {
  await publish({ id: "deck", title: "Deck", note: "v2" }, [["index.html", "<p>2</p>"], ["b.css", "p{}"]]);
  expect(readZip(new Uint8Array(await (await download("deck/download")).arrayBuffer())).names.sort()).toEqual(["deck-v2/b.css", "deck-v2/index.html"]);
  const old = await download("deck/versions/1/download");
  expect(old.headers.get("content-disposition")).toBe('attachment; filename="deck-v1.zip"');
  expect(readZip(new Uint8Array(await old.arrayBuffer())).names).toContain("deck-v1/img/a.svg");
  expect((await download("deck/versions/9/download")).status).toBe(404);
});

test("download needs an identity, and removed artifacts are gone", async () => {
  expect((await download("solo/download", {})).status).toBe(401);
  await fetch(`${b.base}/api/artifacts/solo`, { method: "DELETE", headers: writer });
  expect((await download("solo/download")).status).toBe(404);
  expect((await download("solo/versions/1/download")).status).toBe(404);
});
