// The /render wrapper Chromium screenshots: a publisher-chosen entry name never becomes markup.
import { afterAll, expect, test } from "bun:test";
import { loadSecret, signer } from "../src/content";
import { publisher, startBinder } from "./helpers";

const b = startBinder();
const publish = publisher(b.base);
afterAll(() => b.stop());
const sign = signer(loadSecret(b.dataDir), Date.now);

test("a hostile entry name stays inside the iframe src and still loads", async () => {
  const name = 'x"><meta http-equiv=refresh content="0;url=/">.html';
  expect((await publish({ id: "evil", title: "Evil", entry: name }, [[name, "<p>hi</p>"], ["b.css", "p{}"]])).status).toBe(201);
  const html = await (await fetch(b.base + sign.renderPath("evil", 1))).text();
  expect(html).not.toContain("<meta");
  const src = html.match(/<iframe sandbox="allow-scripts" src="([^"]*)"><\/iframe>$/)?.[1];
  expect(src).toBeDefined();
  const framed = await fetch(b.base + src!);
  expect(framed.status).toBe(200);
  expect(await framed.text()).toBe("<p>hi</p>");
});
