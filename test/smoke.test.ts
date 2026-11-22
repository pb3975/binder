// The publish -> list -> view contract agents depend on (API v1).
import { afterAll, expect, test } from "bun:test";
import { owner, publisher, startBinder, writer } from "./helpers";

const b = startBinder();
const publish = publisher(b.base);
afterAll(() => b.stop());

test("rejects requests without an allowed Tailscale login", async () => {
  expect((await fetch(`${b.base}/api/artifacts`)).status).toBe(401);
  expect((await fetch(`${b.base}/api/artifacts`, { headers: { "tailscale-user-login": "stranger@example.com" } })).status).toBe(403);
  const h = await fetch(`${b.base}/healthz`);
  expect(h.status).toBe(200);
  expect(await h.json()).toEqual({ ok: true, version: (await import("../package.json")).version, build: null });
});

test("rejects writes without the X-Binder header (artifact pages cannot write)", async () => {
  const r = await publish({ title: "x" }, [["a.html", "<p>x</p>"]], owner);
  expect(r.status).toBe(403);
});

test("publishes, lists, serves sandboxed, and versions an artifact", async () => {
  const r = await publish(
    { title: "Agent Loops", project: "Research Notes", kind: "Explainer", tags: "Agents, AI" },
    [["explainer.html", "<h1>hi</h1>"]],
  );
  expect(r.status).toBe(201);
  const a = await r.json();
  expect(a).toMatchObject({ id: "agent-loops", project: "research-notes", kind: "explainer", entry: "index.html", tags: ["agents", "ai"], version: 1 });
  expect(a.url).toBe(`${b.base}/a/agent-loops`);

  const list = await (await fetch(`${b.base}/api/artifacts`, { headers: owner })).json();
  expect(list.artifacts.map((x: { id: string }) => x.id)).toContain("agent-loops");

  const raw = await fetch(a.content_url);
  expect(await raw.text()).toBe("<h1>hi</h1>");
  expect(raw.headers.get("content-security-policy")).toStartWith("sandbox allow-scripts");
  expect(raw.headers.get("referrer-policy")).toBe("no-referrer");

  const again = await publish({ id: "agent-loops", title: "Agent Loops v2" }, [["index.html", "<h1>v2</h1>"]]);
  expect(again.status).toBe(200);
  const v2 = await again.json();
  expect(v2.version).toBe(2);
  expect(await (await fetch(v2.content_url)).text()).toBe("<h1>v2</h1>");
});

test("old /raw links redirect a signed-in caller to the current version", async () => {
  const r = await fetch(`${b.base}/raw/agent-loops/index.html`, { headers: owner, redirect: "manual" });
  expect(r.status).toBe(302);
  const loc = r.headers.get("location")!;
  expect(loc).toMatch(/^\/c\/agent-loops\/2\/\d+\.[\w-]{43}\/index\.html$/);
  expect(await (await fetch(b.base + loc)).text()).toBe("<h1>v2</h1>");
  expect((await fetch(`${b.base}/raw/agent-loops/index.html`, { redirect: "manual" })).status).toBe(401);
});

test("keeps multi-file paths and blocks path traversal", async () => {
  const ok = await publish({ title: "Bundle" }, [["index.html", "<img src=img/a.svg>"], ["img/a.svg", "<svg/>"]]);
  expect(ok.status).toBe(201);
  const a = await ok.json();
  // A relative subresource URL inherits the signed prefix, with no cookie or header.
  expect((await fetch(new URL("img/a.svg", a.content_url))).status).toBe(200);
  const bad = await publish({ title: "Evil" }, [["../../etc/x.html", "x"]]);
  expect(bad.status).toBe(400);
});

test("source_url must be http(s), so a details link can never run script", async () => {
  const bad = await publish({ title: "Bad link", source_url: "javascript:alert(1)" }, [["index.html", "x"]]);
  expect(bad.status).toBe(400);
  const ok = await (await publish({ title: "Good link", source_url: "https://example.com/pr/1" }, [["index.html", "x"]])).json();
  expect(ok.source_url).toBe("https://example.com/pr/1");
  const patched = await fetch(`${b.base}/api/artifacts/${ok.id}`, { method: "PATCH", headers: writer, body: JSON.stringify({ source_url: "data:text/html,x" }) });
  expect(patched.status).toBe(400);
});

test("the UI shell carries a strict CSP; API responses are never cached", async () => {
  const csp = (await fetch(`${b.base}/`)).headers.get("content-security-policy")!;
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect((await fetch(`${b.base}/api/artifacts`, { headers: owner })).headers.get("cache-control")).toBe("no-store");
});

test("remove hides an artifact; publishing its id again brings it back", async () => {
  await publish({ title: "Temp" }, [["index.html", "x"]]);
  const before = await (await fetch(`${b.base}/api/artifacts/temp`, { headers: owner })).json();
  const d = await fetch(`${b.base}/api/artifacts/temp`, { method: "DELETE", headers: writer });
  expect(d.status).toBe(200);
  expect((await fetch(before.content_url)).status).toBe(404); // signed links die with the artifact
  expect((await fetch(`${b.base}/api/artifacts/temp`, { headers: owner })).status).toBe(404);
  // A new title without an id must not reuse the removed id.
  expect((await (await publish({ title: "Temp" }, [["index.html", "y"]])).json()).id).toBe("temp-2");
  const back = await (await publish({ id: "temp", title: "Temp" }, [["index.html", "z"]])).json();
  expect(back).toMatchObject({ id: "temp", version: 2 });
});
