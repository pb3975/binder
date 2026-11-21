// Drives the real UI in Chromium: sign-in, library, viewer, history, old versions, restore, read-only.
// Run inside the container after scripts/demo.ts. Saves screenshots when SHOTS is a folder path.
// Usage: BINDER_TOKEN=<write token> BINDER_READ_TOKEN=<read token> bun /e2e/ui.ts
import { browser as open, shutdown } from "./cdp";

const browser = async (o?: Parameters<typeof open>[0]) => {
  const b = await open(o);
  opened.push(b);
  return b;
};

const B = process.env.BINDER_URL ?? "http://127.0.0.1:8480";
const SHOTS = process.env.SHOTS;
let failures = 0;
setTimeout(() => { console.log("FAIL ui: watchdog: checks took over 5 minutes"); process.exit(1); }, 300_000).unref();
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ui: ${name}${!ok && detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};
const opened: { dialogs: string[] }[] = [];
const shot = async (b: Awaited<ReturnType<typeof browser>>, name: string) => SHOTS && b.screenshot(`${SHOTS}/${name}.png`);

async function signIn(b: Awaited<ReturnType<typeof browser>>, token: string) {
  await b.goto(`${B}/`);
  await b.waitFor(`!document.querySelector("#signin").hidden`);
  await b.evaluate(`document.querySelector("#signin-token").value = ${JSON.stringify(token)}; document.querySelector("#signin-form").requestSubmit()`);
  await b.waitFor(`document.querySelectorAll(".card").length > 0`);
}

for (const dark of [false, true]) {
  const b = await browser({ dark });
  const sfx = dark ? "-dark" : "";
  try {
    await b.goto(`${B}/`);
    await b.waitFor(`!document.querySelector("#signin").hidden`);
    check(`signed-out browser sees the sign-in screen${sfx}`, await b.evaluate(`document.querySelector(".shell").hidden`));
    const visibleButtons = await b.evaluate<string[]>(`[...document.querySelectorAll(".top button")].filter(e => e.offsetParent).map(e => e.id)`);
    check(`signed-out header shows only the theme toggle${sfx}`, visibleButtons.join() === "theme-btn", visibleButtons.join());
    await b.evaluate(`document.querySelector("#signin-token").value = "bnd_nope"; document.querySelector("#signin-form").requestSubmit()`);
    await b.waitFor(`document.querySelector("#signin-error").textContent.length > 0`);
    await shot(b, `signin-error${sfx}`);
    await b.goto(`${B}/`);
    await b.waitFor(`!document.querySelector("#signin").hidden`);
    await shot(b, `signin${sfx}`);

    await signIn(b, process.env.BINDER_TOKEN!);
    await Bun.sleep(600); // let preview images load
    check(`library lists the demo artifacts${sfx}`, (await b.evaluate<number>(`document.querySelectorAll(".card").length`)) >= 5);
    await shot(b, `library${sfx}`);

    await b.evaluate(`document.querySelector('[data-id="queue-explainer"]').click()`);
    await b.waitFor(`!document.querySelector("#viewer").hidden`);
    if (await b.evaluate<boolean>(`document.querySelector("#v-panel").hidden`)) await b.evaluate(`document.querySelector("#v-info").click()`);
    await b.waitFor(`document.querySelectorAll("#v-history button").length === 3`);
    const notes = await b.evaluate<string[]>(`[...document.querySelectorAll("#v-history .note")].map(e => e.textContent)`);
    check(`history shows three versions, newest first${sfx}`, notes[0] === "Fix the backoff numbers after review" && notes[2] === "First draft", JSON.stringify(notes));
    const me = await b.evaluate<string>(`fetch("/api/session").then(r => r.json()).then(j => j.name)`);
    check(`history shows who published${sfx}`, (await b.evaluate<string>(`document.querySelector("#v-history .meta").textContent`)).includes(me), me);
    await Bun.sleep(500);
    await shot(b, `viewer-history${sfx}`);

    await b.evaluate(`document.querySelector('#v-history button[data-ver="1"]').click()`);
    await b.waitFor(`!document.querySelector("#v-version").hidden`);
    check(`old version opens with a banner${sfx}`, (await b.evaluate<string>(`document.querySelector("#v-version").textContent`)).includes("Viewing version 1 of 3"));
    check(`old version loads its own content URL${sfx}`, (await b.evaluate<string>(`document.querySelector("#v-frame").src`)).includes("/c/queue-explainer/1/"));
    await Bun.sleep(500);
    await shot(b, `viewer-old-version${sfx}`);
    await b.evaluate(`document.querySelector('[data-act="latest"]').click()`);
    check(`back to latest hides the banner${sfx}`, await b.evaluate(`document.querySelector("#v-version").hidden`));
    check(`the UI trips no CSP rule${sfx}`, (await b.evaluate<string[]>(`window.__csp`)).length === 0, JSON.stringify(await b.evaluate(`window.__csp`)));
  } finally {
    b.close();
  }
}

// An open tab outlives its signed URLs: opening an artifact then fetches fresh ones first.
{
  const b = await browser();
  try {
    await signIn(b, process.env.BINDER_TOKEN!);
    const before = await b.evaluate<number>(`performance.getEntriesByName(location.origin + "/api/artifacts").length`);
    await b.evaluate(`{ const real = Date.now; Date.now = () => real() + 8.75 * 3600_000; }`);
    await b.evaluate(`document.querySelector('[data-id="queue-explainer"]').click()`);
    await b.waitFor(`!document.querySelector("#viewer").hidden`);
    const after = await b.evaluate<number>(`performance.getEntriesByName(location.origin + "/api/artifacts").length`);
    check("opening an artifact near URL expiry refreshes the library once", after === before + 1, `${before} -> ${after}`);
  } finally {
    b.close();
  }
}

// An agent publishes while the library is open. The viewer must treat the new version as latest.
{
  const b = await browser();
  try {
    await signIn(b, process.env.BINDER_TOKEN!);
    await b.evaluate(`(async () => {
      const f = new FormData();
      f.set("meta", JSON.stringify({ id: "pricing-options", title: "Pricing Page Options", note: "Published while the library was open" }));
      f.append("file", new File(["<!doctype html><title>v2</title><p>v2"], "index.html", { type: "text/html" }));
      const r = await fetch("/api/artifacts", { method: "POST", headers: { "X-Binder": "1", Authorization: "Bearer ${process.env.BINDER_TOKEN}" }, body: f });
      if (!r.ok) throw new Error("publish failed: " + r.status);
    })()`);
    await b.evaluate(`document.querySelector('[data-id="pricing-options"]').click()`);
    await b.waitFor(`!document.querySelector("#viewer").hidden`);
    if (await b.evaluate<boolean>(`document.querySelector("#v-panel").hidden`)) await b.evaluate(`document.querySelector("#v-info").click()`);
    await b.waitFor(`document.querySelectorAll("#v-history button").length === 2`);
    check("history newer than the library loads the new version as latest", (await b.evaluate<string>(`document.querySelector("#v-frame").src`)).includes("/c/pricing-options/2/"));
    check("the new version is marked current", await b.evaluate(`document.querySelector('#v-history button[data-ver="2"]').getAttribute("aria-current") === "true"`));
    check("no old-version banner for the latest", await b.evaluate(`document.querySelector("#v-version").hidden`));
  } finally {
    b.close();
  }
}

// Restore, then a read-only user sees no write actions. Restore mutates data, so run it last and once.
{
  const b = await browser();
  try {
    await signIn(b, process.env.BINDER_TOKEN!);
    await b.goto(`${B}/a/onboarding-quiz`);
    await b.waitFor(`!document.querySelector("#viewer").hidden`);
    if (await b.evaluate<boolean>(`document.querySelector("#v-panel").hidden`)) await b.evaluate(`document.querySelector("#v-info").click()`);
    await b.waitFor(`document.querySelectorAll("#v-history button").length === 2`);
    await b.evaluate(`window.confirm = () => true; document.querySelector('#v-history button[data-ver="1"]').click()`);
    await b.waitFor(`document.querySelector('[data-act="restore"]')`);
    await b.evaluate(`document.querySelector('[data-act="restore"]').click()`);
    await b.waitFor(`document.querySelectorAll("#v-history button").length === 3`);
    check("restore adds a new version", (await b.evaluate<string>(`document.querySelector("#v-history .note").textContent`)) === "Restored version 1");
  } finally {
    b.close();
  }
}
{
  const b = await browser();
  try {
    await signIn(b, process.env.BINDER_READ_TOKEN!);
    await b.goto(`${B}/a/queue-explainer`);
    await b.waitFor(`!document.querySelector("#viewer").hidden`);
    if (await b.evaluate<boolean>(`document.querySelector("#v-panel").hidden`)) await b.evaluate(`document.querySelector("#v-info").click()`);
    await b.waitFor(`document.querySelectorAll("#v-history button").length === 3`);
    check("read-only user sees no remove or refresh", !(await b.evaluate<boolean>(`Boolean(document.querySelector('[data-act="delete"], [data-act="rethumb"]'))`)));
    await b.evaluate(`document.querySelector('#v-history button[data-ver="2"]').click()`);
    check("read-only user sees no restore", !(await b.evaluate<boolean>(`Boolean(document.querySelector('[data-act="restore"]'))`)));
  } finally {
    b.close();
  }
}
{
  const b = await browser({ width: 390, height: 844 });
  try {
    await signIn(b, process.env.BINDER_TOKEN!);
    await Bun.sleep(400);
    const overflow = await b.evaluate<number>(`document.documentElement.scrollWidth - innerWidth`);
    check("phone width has no horizontal scroll", overflow <= 0, String(overflow));
    await shot(b, "library-phone");
    await b.goto(`${B}/a/queue-explainer`);
    await b.waitFor(`!document.querySelector("#viewer").hidden`);
    if (await b.evaluate<boolean>(`document.querySelector("#v-panel").hidden`)) await b.evaluate(`document.querySelector("#v-info").click()`);
    await b.waitFor(`document.querySelectorAll("#v-history button").length >= 3`);
    await shot(b, "viewer-history-phone");
  } finally {
    b.close();
  }
}

// Last, so screenshots never show it. Hostile metadata: every field a publisher controls is rendered as text, never as markup.
{
  const f = new FormData();
  const evil = `"><img src=x onerror="window.__xss=1">`;
  f.set("meta", JSON.stringify({ id: "hostile", title: `Hostile ${evil}`, summary: evil, project: "e2e", tags: [evil], note: evil, agent: evil, host: evil }));
  f.append("file", new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], `a${evil}.svg`, { type: "image/svg+xml" }));
  const r = await fetch(`${B}/api/artifacts`, { method: "POST", headers: { authorization: `Bearer ${process.env.BINDER_TOKEN}`, "x-binder": "1" }, body: f });
  check("hostile publish accepted (names are data)", r.status === 201, String(r.status));
  const b = await browser();
  try {
    await signIn(b, process.env.BINDER_TOKEN!);
    await b.goto(`${B}/a/hostile`);
    await b.waitFor(`!document.querySelector("#viewer").hidden`);
    if (await b.evaluate<boolean>(`document.querySelector("#v-panel").hidden`)) await b.evaluate(`document.querySelector("#v-info").click()`);
    await b.waitFor(`document.querySelectorAll("#v-history button").length === 1`);
    await b.evaluate(`document.querySelector("#v-back").click()`);
    await Bun.sleep(500);
    check("hostile metadata runs no script in Binder", (await b.evaluate<unknown>(`window.__xss`)) === undefined);
    check("hostile metadata trips no CSP rule (so the CSP is not hiding a bug)", (await b.evaluate<string[]>(`window.__csp`)).length === 0, JSON.stringify(await b.evaluate(`window.__csp`)));
  } finally {
    b.close();
  }
}

const dialogs = opened.flatMap((b) => b.dialogs);
check("no unexpected alert or confirm dialogs", dialogs.length === 0, dialogs.join(" | "));
await shutdown();
console.log(failures ? `${failures} ui check(s) failed` : "all ui checks passed");
process.exit(failures ? 1 : 0);
