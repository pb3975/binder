// Version history, file diffs, restore, and capability URLs.
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { owner, publisher, startBinder, writer } from "./helpers";

let clock = Date.parse("2026-11-20T12:00:00Z");
const b = startBinder({}, { now: () => clock });
const publish = publisher(b.base);
afterAll(() => b.stop());

const history = async (id: string) => (await (await fetch(`${b.base}/api/artifacts/${id}/versions`, { headers: owner })).json()).versions;

test("each publish is a version with who, when, note, and a file diff", async () => {
  await publish({ id: "deck", title: "Deck", note: "first cut", agent: "codex" }, [["index.html", "<p>1</p>"], ["a.png", "A"], ["b.png", "B"]]);
  clock += 60_000;
  await publish({ id: "deck", title: "Deck v2", note: "new chart" }, [["index.html", "<p>2</p>"], ["a.png", "A"], ["c.png", "C"]]);

  const vs = await history("deck");
  expect(vs.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  expect(vs[0]).toMatchObject({
    version: 2, title: "Deck v2", note: "new chart", published_by: "owner@example.com",
    created_at: "2026-11-20T12:01:00.000Z",
    changes: { added: ["c.png"], removed: ["b.png"], changed: ["index.html"] },
  });
  expect(vs[1]).toMatchObject({ version: 1, note: "first cut", agent: "codex", changes: { added: ["index.html", "a.png", "b.png"] } });

  // Old versions stay readable, each at its own URL.
  expect(await (await fetch(vs[1].content_url)).text()).toBe("<p>1</p>");
  expect(await (await fetch(vs[0].content_url)).text()).toBe("<p>2</p>");
  expect(existsSync(join(b.dataDir, "versions/deck/1/b.png"))).toBe(true);
});

test("restore publishes an old version as a new one", async () => {
  const r = await fetch(`${b.base}/api/artifacts/deck/versions/1/restore`, { method: "POST", headers: writer });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ version: 3, title: "Deck", note: "Restored version 1" });
  const vs = await history("deck");
  expect(vs[0].changes).toEqual({ added: ["b.png"], removed: ["c.png"], changed: ["index.html"] });
  expect(await (await fetch(vs[0].content_url)).text()).toBe("<p>1</p>");
});

test("a content URL grants one version only, and expires", async () => {
  const [v3, , v1] = await history("deck");
  // Swap the version in a valid URL: the signature no longer matches.
  expect((await fetch(v3.content_url.replace("/deck/3/", "/deck/1/"))).status).toBe(403);
  expect((await fetch(v1.content_url.replace("/deck/1/", "/deck/3/"))).status).toBe(403);
  // An encoded traversal out of the version folder is refused.
  expect((await fetch(v3.content_url.replace("index.html", "..%2F..%2F2%2Findex.html"))).status).toBe(404);
  // Stable inside an hour, so browsers can cache it; dead about 9 hours later.
  clock += 60_000;
  expect((await history("deck"))[0].content_url).toBe(v3.content_url);
  clock += 10 * 3600_000;
  expect((await fetch(v3.content_url)).status).toBe(403);
});

test("concurrent publishes to one id get distinct versions", async () => {
  const rs = await Promise.all(
    Array.from({ length: 5 }, (_, i) => publish({ id: "race", title: "Race" }, [["index.html", `<p>${i}</p>`]])),
  );
  const versions = (await Promise.all(rs.map((r) => r.json()))).map((a) => a.version).sort();
  expect(versions).toEqual([1, 2, 3, 4, 5]);
});
