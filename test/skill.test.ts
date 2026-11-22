// The agent skill in skill/binder/SKILL.md must match the publish contract it teaches.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli";
import { form, startBinder } from "./helpers";

const skill = readFileSync(join(import.meta.dir, "..", "skill", "binder", "SKILL.md"), "utf8");
const b = startBinder({ auth: { mode: "token" } });
afterAll(() => b.stop());

test("frontmatter names the skill and says to publish only when asked", () => {
  const front = skill.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
  expect(front?.[1]).toBe("binder");
  expect(front?.[2]).toContain("explicitly asks");
});

test("the publish command uses the documented URL, headers, and fields", () => {
  expect(skill).toContain(`"$BINDER_URL/api/artifacts"`);
  expect(skill).toContain("-H 'X-Binder: 1'");
  expect(skill).toContain(`\${BINDER_TOKEN:+-H "Authorization: Bearer $BINDER_TOKEN"}`);
  expect(skill).toContain("-F 'meta=<meta.json'");
});

test("the example meta.json publishes as written", async () => {
  const meta = JSON.parse(skill.match(/```json\n([\s\S]*?)\n\s*```/)![1]!);
  const out: string[] = [];
  await run(["token", "create", "--name", "agent"], { BINDER_DATA_DIR: b.dataDir }, (s) => out.push(s));
  const r = await fetch(`${b.base}/api/artifacts`, {
    method: "POST",
    headers: { authorization: `Bearer ${out[0]}`, "x-binder": "1" },
    body: form(meta, [["explainer.html", "<h1>x</h1>"]]),
  });
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({ id: meta.id, version: 1, note: meta.note, published_by: "agent" });
});

test("/llms.txt serves the skill to any agent, with this instance's URL and auth", async () => {
  const r = await fetch(`${b.base}/llms.txt`); // no credential: it holds nothing secret
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  const text = await r.text();
  expect(text.startsWith(`# Binder\n\n> A self-hosted library of agent-built pages, at ${b.base}. This instance needs a token`)).toBe(true);
  expect(text).toContain(`Set \`BINDER_URL=${b.base}\``);
  expect(text).not.toContain("name: binder"); // frontmatter stripped
  expect(text).toContain(`"$BINDER_URL/api/artifacts"`); // the same publish steps as the skill
  expect(text.match(/^# /gm)?.length).toBe(1); // one title, as llms.txt expects

  const open = startBinder({ auth: { mode: "none" } });
  try {
    expect(await (await fetch(`${open.base}/llms.txt`)).text()).toContain("authentication off. No token is needed.");
  } finally {
    open.stop();
  }
  const proxied = startBinder(); // header mode, as behind tailscale serve
  try {
    const t = await (await fetch(`${proxied.base}/llms.txt`)).text();
    expect(t).toContain("If you reach it through that proxy as an allowed user, no token is needed. Otherwise send `Authorization: Bearer <token>`");
  } finally {
    proxied.stop();
  }
});
