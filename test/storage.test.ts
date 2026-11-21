// The storage interface on both backends, directly and through the HTTP API.
// Local always runs. S3 runs when BINDER_TEST_S3=s3://<bucket>/<prefix> and the AWS_* variables point at
// an S3-compatible store; scripts/e2e-s3.sh runs it against MinIO, in CI too. Synthetic data only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialProvider, type Credentials } from "../src/aws";
import { storageConfig } from "../src/config";
import { localStorage, s3Storage, versionKey, type Ledger, type Storage } from "../src/storage";
import { owner, publisher, startBinder, writer } from "./helpers";

type Backend = {
  name: string;
  /** A fresh, empty store. `failAt` makes the n-th storage operation fail (S3) or a write fail (local). */
  make(failAt?: number): { storage: Storage; dataDir: string };
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "binder-storage-"));
  for (const sub of ["tmp", "trash", "versions"]) mkdirSync(join(d, sub));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const backends: Backend[] = [{ name: "local", make: () => ({ storage: localStorage(tmp()), dataDir: dirs.at(-1)! }) }];
const S3 = process.env.BINDER_TEST_S3;
if (S3) {
  backends.push({
    name: "s3",
    make(failAt) {
      // A new prefix per store, so tests never see each other's objects.
      const base = storageConfig({ ...process.env, BINDER_STORAGE: S3 });
      if (base.kind !== "s3") throw new Error("BINDER_TEST_S3 must be an s3:// URL");
      const cfg = { ...base, prefix: [base.prefix, `t-${crypto.randomUUID()}`].filter(Boolean).join("/") };
      const real = credentialProvider(process.env);
      let calls = 0;
      const creds = async (): Promise<Credentials> => {
        if (++calls === failAt) throw new Error("injected storage failure");
        return real();
      };
      return { storage: s3Storage(cfg, creds), dataDir: tmp() };
    },
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);
/** A ledger over an in-memory list of recorded numbers, like db.nextVersion and db.commit. */
function ledger(recorded: number[] = []): Ledger & { recorded: number[] } {
  return {
    recorded,
    next: () => Math.max(0, ...recorded) + 1,
    commit(n, place) {
      if (n < Math.max(0, ...recorded) + 1) throw new Error(`version ${n} exists`);
      place?.();
      recorded.push(n);
    },
  };
}

for (const backend of backends) {
  describe(`${backend.name} storage`, () => {
    test("write, read, and delete a key; a missing key reads as null", async () => {
      const { storage } = backend.make();
      await storage.write("thumbs/a.png", bytes("PNG"));
      const got = await storage.read("thumbs/a.png");
      expect(got).toBeInstanceOf(Blob);
      expect(await got!.text()).toBe("PNG");
      expect(await storage.read("thumbs/missing.png")).toBeNull();
      await storage.delete("thumbs/a.png");
      expect(await storage.read("thumbs/a.png")).toBeNull();
      await storage.delete("thumbs/a.png"); // deleting twice is fine
      await storage.check();
    });

    test("a Response built from a read is the file itself, never a redirect", async () => {
      const { storage } = backend.make();
      await storage.write("versions/x/1/index.html", bytes("<p>x</p>"));
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async () => new Response(await storage.read("versions/x/1/index.html")) });
      const r = await fetch(`http://127.0.0.1:${server.port}/`, { redirect: "manual" });
      server.stop(true);
      expect(r.status).toBe(200);
      expect(r.headers.get("location")).toBeNull();
      expect(await r.text()).toBe("<p>x</p>");
    });

    test("addVersion stores every file, then records the next number", async () => {
      const { storage } = backend.make();
      const l = ledger();
      const files = [{ path: "index.html", data: bytes("<p>1</p>") }, { path: "img/a.svg", data: new Blob(["<svg/>"]) }];
      expect(await storage.addVersion("doc", files, l)).toBe(1);
      expect(await storage.addVersion("doc", [{ path: "index.html", data: bytes("<p>2</p>") }], l)).toBe(2);
      expect(l.recorded).toEqual([1, 2]);
      expect(await (await storage.read(versionKey("doc", 1, "img/a.svg")))!.text()).toBe("<svg/>");
      expect(await (await storage.read(versionKey("doc", 2, "index.html")))!.text()).toBe("<p>2</p>");
      expect(await storage.read(versionKey("doc", 2, "img/a.svg"))).toBeNull();
    });

    test("a failed upload records nothing and leaves no files behind", async () => {
      // S3: operation 1 checks the number, 2 to 4 upload the files; the third file's upload fails.
      const { storage, dataDir } = backend.make(4);
      const l = ledger();
      const files = ["a.html", "b.html", "c.html"].map((p) => ({ path: p, data: bytes(p) }));
      // Local: a file and a folder with the same name cannot both be written.
      if (backend.name === "local") files.push({ path: "a.html/x", data: bytes("x") });
      await expect(storage.addVersion("doc", files, l)).rejects.toThrow();
      expect(l.recorded).toEqual([]);
      for (const f of files) expect(await storage.read(versionKey("doc", 1, f.path))).toBeNull();
      if (backend.name === "local") expect(readdirSync(join(dataDir, "tmp"))).toEqual([]);
      // The number is still free for the next publish.
      expect(await storage.addVersion("doc", [{ path: "index.html", data: bytes("ok") }], l)).toBe(1);
    });

    test("files under a number with no database row are kept, never overwritten", async () => {
      const { storage, dataDir } = backend.make();
      // As if a crash lost version 1's row (Litestream's loss window) after its files were stored.
      const orphan = versionKey("doc", 1, "index.html");
      if (backend.name === "local") {
        mkdirSync(join(dataDir, "versions/doc/1"), { recursive: true });
        writeFileSync(join(dataDir, orphan), "lost");
      } else await storage.write(orphan, bytes("lost"));
      const l = ledger();
      const n = await storage.addVersion("doc", [{ path: "index.html", data: bytes("new") }], l);
      if (backend.name === "local") {
        // Local storage moves the orphan folder to trash/ (behavior since schema v2).
        expect(n).toBe(1);
        expect(readdirSync(join(dataDir, "trash")).some((d) => d.startsWith("doc-v1-orphan-"))).toBe(true);
      } else {
        // S3 has no rename, so it skips the number and leaves the orphan where it is.
        expect(n).toBe(2);
        expect(await (await storage.read(orphan))!.text()).toBe("lost");
      }
      expect(await (await storage.read(versionKey("doc", n, "index.html")))!.text()).toBe("new");
    });
  });

  describe(`${backend.name} storage through the API`, () => {
    const { storage, dataDir } = backend.make();
    const b = startBinder({}, { storage, dataDir, now: () => Date.parse("2026-11-21T12:00:00Z") });
    const publish = publisher(b.base);
    afterAll(() => b.stop(true));
    const get = (path: string) => fetch(b.base + path, { headers: owner, redirect: "manual" });

    test("publish, view, history, restore, and download read and write this store", async () => {
      const v1 = await (await publish({ id: "deck", title: "Deck", note: "one" }, [["index.html", "<p>1</p><img src='img/a.svg'>"], ["img/a.svg", "<svg/>"]])).json();
      await publish({ id: "deck", title: "Deck", note: "two" }, [["index.html", "<p>2</p>"]]);
      if (backend.name === "local") expect(existsSync(join(dataDir, "versions/deck/1/img/a.svg"))).toBe(true);
      else expect(await storage.read("versions/deck/1/img/a.svg")).not.toBeNull();

      const page = await fetch(v1.content_url, { redirect: "manual" });
      expect(page.status).toBe(200);
      expect(page.headers.get("location")).toBeNull();
      expect(page.headers.get("content-type")).toStartWith("text/html");
      expect(page.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      expect(page.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(await page.text()).toBe("<p>1</p><img src='img/a.svg'>");
      const svg = await fetch(new URL("img/a.svg", v1.content_url), { redirect: "manual" });
      expect(svg.headers.get("content-type")).toBe("image/svg+xml");
      expect(await svg.text()).toBe("<svg/>");

      const restored = await (await fetch(`${b.base}/api/artifacts/deck/versions/1/restore`, { method: "POST", headers: writer })).json();
      expect(restored).toMatchObject({ version: 3, note: "Restored version 1" });
      expect(await (await fetch(restored.content_url)).text()).toBe("<p>1</p><img src='img/a.svg'>");

      const one = await get("/api/artifacts/deck/versions/2/download");
      expect(one.status).toBe(200);
      expect(one.headers.get("content-disposition")).toBe('attachment; filename="deck-v2.html"');
      expect(await one.text()).toBe("<p>2</p>");
      const zip = await get("/api/artifacts/deck/versions/3/download");
      expect(zip.headers.get("content-type")).toBe("application/zip");
      const z = new Uint8Array(await zip.arrayBuffer());
      expect([z[0], z[1], z[2], z[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });

    test("concurrent publishes never share an id or a version number", async () => {
      const results = await Promise.all([
        ...Array.from({ length: 4 }, (_, i) => publish({ title: "Same title", note: `t${i}` }, [["index.html", `<p>${i}</p>`]])),
        ...Array.from({ length: 4 }, (_, i) => publish({ id: "busy", title: "Busy", note: `b${i}` }, [["index.html", `<p>busy ${i}</p>`]])),
      ]);
      const bodies = await Promise.all(results.map((r) => r.json()));
      expect(new Set(bodies.slice(0, 4).map((a) => a.id))).toEqual(new Set(["same-title", "same-title-2", "same-title-3", "same-title-4"]));
      expect(bodies.slice(4).map((a) => a.version).sort()).toEqual([1, 2, 3, 4]);
      // Each version serves the content its own publish sent.
      for (const a of bodies.slice(4)) expect(await (await fetch(a.content_url)).text()).toBe(`<p>busy ${a.note.slice(1)}</p>`);
    });

    test("a missing file is a 404, not a broken 200", async () => {
      await publish({ id: "gone", title: "Gone" }, [["index.html", "<p>x</p>"]]);
      const a = await (await get("/api/artifacts/gone")).json();
      await storage.delete(versionKey("gone", 1, "index.html")); // simulates a store that lost an object
      expect((await fetch(a.content_url, { redirect: "manual" })).status).toBe(404);
      expect((await get("/api/artifacts/gone/download")).status).toBe(404);
    });
  });
}
