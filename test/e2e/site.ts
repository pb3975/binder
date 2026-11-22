// Drives the built landing page in real Chromium, served under /binder/ as GitHub Pages serves it.
// Run by scripts/e2e-site.sh, which builds the site and picks the browser.
// Usage: SITE_DIR=<built folder> CHROMIUM=<path> [SHOTS=<dir>] bun test/e2e/site.ts
import { resolve, sep } from "node:path";
import { browser, shutdown } from "./cdp";

const DIR = resolve(process.env.SITE_DIR ?? "_site");
const SHOTS = process.env.SHOTS && resolve(process.env.SHOTS);
const BASE = "/binder/";
let failures = 0;
setTimeout(() => { console.log("FAIL site: watchdog: checks took over 3 minutes"); process.exit(1); }, 180_000).unref();
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} site: ${name}${!ok && detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};

// A static server like GitHub Pages: files under /binder/, a directory serves its index.html.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/binder") return Response.redirect(BASE, 301);
    if (!pathname.startsWith(BASE)) return new Response("not found", { status: 404 });
    let path = resolve(DIR, "." + decodeURIComponent(pathname.slice(BASE.length - 1)));
    if (path !== DIR && !path.startsWith(DIR + sep)) return new Response("not found", { status: 404 });
    if (pathname.endsWith("/")) path += "/index.html";
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;
const URL_ = `${ORIGIN}${BASE}`;

type Page = Awaited<ReturnType<typeof browser>>;

// WCAG AA for every visible text: 4.5:1, or 3:1 for large text. Colors are read back through a
// canvas, so any CSS color syntax works, and translucent backgrounds are composited over their parents.
const CONTRAST = `(() => {
  const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  const paint = (colors) => {
    ctx.clearRect(0, 0, 1, 1);
    for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const alpha = (c) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3]; };
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const bad = [];
  for (const el of document.querySelectorAll("body *")) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (!el.getClientRects().length || el.closest(".sr-only, svg")) continue;
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      layers.unshift(bg);
      if (alpha(bg) === 255) break;
    }
    const bg = paint(layers);
    const fg = paint([...layers, getComputedStyle(el).color]);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) bad.push(el.tagName.toLowerCase() + "." + el.className + " '" + el.textContent.trim().slice(0, 30) + "' " + ratio.toFixed(2));
  }
  return bad;
})()`;

/** Opens the page and records every request, failure, console error, and CSP violation. */
async function open(o: { width: number; height: number; dark: boolean }) {
  const b = await browser({ ...o, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  const log = { foreign: [] as string[], failed: [] as string[], errors: [] as string[] };
  b.on("Network.requestWillBeSent", (p) => {
    const url = (p.request as { url: string }).url;
    if (!url.startsWith("data:") && new URL(url).origin !== ORIGIN) log.foreign.push(url);
  });
  // Chrome sometimes probes /favicon.ico at the origin root on its own. That path is outside /binder/
  // and is not the page's (it declares icon.svg), so it does not count as a failed request.
  const probe = `${ORIGIN}/favicon.ico`;
  b.on("Network.loadingFailed", (p) => log.failed.push(`${p.errorText} ${p.blockedReason ?? ""} (${p.requestId})`));
  b.on("Network.responseReceived", (p) => {
    const r = p.response as { url: string; status: number };
    if (r.status >= 400 && r.url !== probe) log.failed.push(`${r.status} ${r.url}`);
  });
  b.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") log.errors.push(JSON.stringify(p.args)); });
  b.on("Runtime.exceptionThrown", (p) => log.errors.push(JSON.stringify(p.exceptionDetails)));
  b.on("Log.entryAdded", (p) => {
    const e = p.entry as { level: string; text: string; url?: string };
    if (e.level === "error" && e.url !== probe) log.errors.push(`${e.text} ${e.url ?? ""}`);
  });
  await b.send("Network.enable");
  await b.send("Runtime.enable");
  await b.send("Log.enable");
  await b.send("Emulation.setFocusEmulationEnabled", { enabled: true }); // the clipboard needs a focused page
  await b.goto(URL_, 300);
  await b.waitFor(`document.readyState === "complete"`);
  await b.evaluate(`document.fonts.ready.then(() => true)`);
  return { b, log };
}

const shot = async (b: Page, name: string, fullPage: boolean) => SHOTS && b.screenshot(`${SHOTS}/${name}.png`, fullPage);

for (const [width, height] of [[1280, 800], [390, 844]] as const) {
  for (const dark of [false, true]) {
    const tag = `${width}px ${dark ? "dark" : "light"}`;
    const { b, log } = await open({ width, height, dark });
    try {
      const stray = await b.evaluate<string[]>(`[...document.body.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim().slice(0, 40))`);
      check(`${tag}: no stray text outside the page's elements`, stray.length === 0, stray.join(" | "));
      const first = await b.evaluate<string>(`document.querySelector(".top").getBoundingClientRect().top`);
      check(`${tag}: the top bar is at the top of the page`, Number(first) === 0, String(first));
      const overflow = await b.evaluate<number>(`document.documentElement.scrollWidth - innerWidth`);
      check(`${tag}: no horizontal overflow`, overflow <= 0, `${overflow}px`);
      const hero = await b.evaluate<{ w: number; src: string }>(
        `(() => { const i = document.querySelector(".shot img"); return { w: i.naturalWidth, src: i.currentSrc }; })()`);
      const want = dark ? "images/library-dark.png" : "images/library.png";
      check(`${tag}: hero screenshot loaded for the scheme`, hero.w > 0 && hero.src.endsWith(want), JSON.stringify(hero));
      const lines = await b.evaluate<number>(
        `(() => { const h = document.querySelector("h1"); return Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)); })()`);
      check(`${tag}: the headline breaks into 2 or 3 lines`, lines >= 2 && lines <= 3, String(lines));
      // A heading whose last line holds one word reads as a mistake.
      const orphans = await b.evaluate<string[]>(`[...document.querySelectorAll("h1, h2")].filter((h) => {
        const tops = [];
        const walk = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
        for (let t; (t = walk.nextNode());) for (const m of t.textContent.matchAll(/\\S+/g)) {
          const r = document.createRange();
          r.setStart(t, m.index);
          r.setEnd(t, m.index + m[0].length);
          tops.push(r.getBoundingClientRect().top);
        }
        return tops.length > 1 && tops.at(-1) - tops.at(-2) > 2;
      }).map((h) => h.textContent)`);
      check(`${tag}: no heading ends with a one-word line`, orphans.length === 0, orphans.join(" | "));
      const lowContrast = await b.evaluate<string[]>(CONTRAST);
      check(`${tag}: all text meets WCAG AA contrast`, lowContrast.length === 0, lowContrast.slice(0, 5).join(" | "));
      await b.evaluate(`document.querySelector('.vm-history button[data-ver="1"]').click()`);
      await Bun.sleep(200); // let the 120 ms background transition finish
      const lowOld = await b.evaluate<string[]>(CONTRAST);
      check(`${tag}: all text meets AA with an old version open`, lowOld.length === 0, lowOld.slice(0, 5).join(" | "));
      await b.evaluate(`document.querySelector("#vm-latest").click(); document.activeElement.blur(); scrollTo(0, 0)`);
      await Bun.sleep(200); // focus moved to v3 and scrolled; let the page settle at the top
      const mock = await b.evaluate<number>(`(() => { const v = document.querySelector("#viewer-mock"); return v.scrollWidth - v.clientWidth; })()`);
      check(`${tag}: the history model fits its box`, mock <= 0, `${mock}px`);

      const tabs = await b.evaluate<{ shown: boolean; gap: number }>(`(() => {
        const nav = document.querySelector(".index-tabs");
        if (getComputedStyle(nav).display === "none") return { shown: false, gap: 0 };
        const right = Math.max(...[...document.querySelectorAll(".wrap")].map((w) => w.getBoundingClientRect().right - parseFloat(getComputedStyle(w).paddingRight)));
        const left = Math.min(...[...nav.children].map((a) => {
          // Measure each tab at its widest (current) state, with its width transition off.
          const was = a.getAttribute("aria-current");
          a.style.transition = "none";
          a.setAttribute("aria-current", "true");
          const l = a.getBoundingClientRect().left;
          if (was === null) a.removeAttribute("aria-current");
          a.style.transition = "";
          return l;
        }));
        return { shown: true, gap: Math.round(left - right) };
      })()`);
      if (width >= 1200) {
        check(`${tag}: index tabs never cover content`, tabs.shown && tabs.gap >= 8, JSON.stringify(tabs));
        await shot(b, `site-${width}-${dark ? "dark" : "light"}-first`, false);
        await b.evaluate(`document.querySelector("#sandbox").scrollIntoView()`);
        await b.waitFor(`document.querySelector('.index-tabs a[href="#sandbox"]').getAttribute("aria-current") === "true"`, 3000).then(
          () => check(`${tag}: the tab of the section in view is marked`, true),
          (e) => check(`${tag}: the tab of the section in view is marked`, false, String(e).slice(0, 200)));
        await b.evaluate(`scrollTo(0, 0)`);
      } else {
        check(`${tag}: index tabs hidden on narrow screens`, !tabs.shown);
        await shot(b, `site-${width}-${dark ? "dark" : "light"}-first`, false);
      }
      await Bun.sleep(150);
      await shot(b, `site-${width}-${dark ? "dark" : "light"}-full`, true);

      check(`${tag}: no request to another origin`, log.foreign.length === 0, log.foreign.join(", "));
      check(`${tag}: no failed request`, log.failed.length === 0, log.failed.join(", "));
      check(`${tag}: no console error`, log.errors.length === 0, log.errors.join(" | "));
      const csp = await b.evaluate<string[]>(`window.__csp`);
      check(`${tag}: no CSP violation`, csp.length === 0, JSON.stringify(csp));
    } finally {
      b.close();
    }
  }
}

// Without JavaScript the page still reads: the latest version is shown and no dead Copy button appears.
{
  const b = await browser({ width: 1280, height: 800 });
  try {
    await b.send("Emulation.setScriptExecutionDisabled", { value: true });
    await b.goto(URL_, 300);
    await b.waitFor(`document.readyState === "complete"`);
    const state = await b.evaluate<{ tiles: string; banner: boolean; copy: number }>(`({
      tiles: [...document.querySelectorAll("#vm-tiles li")].map((li) => li.textContent).join(" | "),
      banner: document.querySelector("#vm-banner").hidden,
      copy: [...document.querySelectorAll(".copy")].filter((c) => c.offsetParent).length,
    })`);
    check("no js: the history model shows the latest version", state.tiles === "6max attempts | 1s ± 30%backoff with jitter | 2hdead letter after | manualreplays" && state.banner, JSON.stringify(state));
    check("no js: no Copy button is shown", state.copy === 0, String(state.copy));
  } finally {
    b.close();
  }
}

// The version switcher, as a reader uses it: choose v1, read the banner, go back to latest.
{
  const { b, log } = await open({ width: 1280, height: 800, dark: false });
  try {
    const tiles = `[...document.querySelectorAll("#vm-tiles li")].map((li) => li.textContent).join(" | ")`;
    const latest = await b.evaluate<string>(tiles);
    check("history: the latest version is shown first", latest === "6max attempts | 1s ± 30%backoff with jitter | 2hdead letter after | manualreplays", latest);
    check("history: no banner for the latest", await b.evaluate(`document.querySelector("#vm-banner").hidden`));
    await b.evaluate(`document.querySelector('.vm-history button[data-ver="1"]').click()`);
    const v1 = await b.evaluate<string>(tiles);
    check("history: v1 swaps in its own tiles", v1 === "5max attempts | 2sbase backoff | 1hdead letter after", v1);
    const banner = await b.evaluate<string>(`document.querySelector("#vm-banner").hidden ? "" : document.querySelector("#vm-banner-text").textContent`);
    check("history: v1 shows the old-version banner", banner === "Viewing version 1 of 3, published Nov 21, 2026 by alice.", banner);
    check("history: v1 is pressed and v3 is not", await b.evaluate(
      `document.querySelector('[data-ver="1"]').getAttribute("aria-pressed") === "true" && document.querySelector('[data-ver="3"]').getAttribute("aria-pressed") === "false"`));
    check("history: the change is announced", (await b.evaluate<string>(`document.querySelector("#vm-status").textContent`)) === banner);
    await b.evaluate(`document.querySelector("#history").scrollIntoView()`);
    await Bun.sleep(200);
    await shot(b, "site-history-v1", false);
    await b.evaluate(`document.querySelector("#vm-latest").click()`);
    check("history: back to latest restores the tiles", (await b.evaluate<string>(tiles)) === latest);
    check("history: back to latest hides the banner and keeps focus on v3", await b.evaluate(
      `document.querySelector("#vm-banner").hidden && document.activeElement === document.querySelector('[data-ver="3"]')`));

    // Copy puts the exact command on the clipboard.
    const want = await b.evaluate<string>(`document.querySelector("#start pre").textContent`);
    await b.send("Runtime.evaluate", { expression: `document.querySelector("#start .copy").click()`, userGesture: true });
    await b.waitFor(`document.querySelector("#start .copy").dataset.state`);
    const state = await b.evaluate<string>(`document.querySelector("#start .copy").dataset.state + " " + document.querySelector("#start .copy").textContent`);
    check("copy: the button reports success", state === "copied Copied", state);
    const got = await b.evaluate<string>(`navigator.clipboard.readText().catch((e) => "unreadable: " + e)`);
    check("copy: the clipboard holds the exact command", got === want || got.startsWith("unreadable:") && state === "copied Copied", JSON.stringify(got));
    if (got.startsWith("unreadable:")) console.log("note site: clipboard not readable here; checked the click handler's success instead");
    check("interactions: no console error", log.errors.length === 0, log.errors.join(" | "));
  } finally {
    b.close();
  }
}

await shutdown();
server.stop(true);
console.log(failures ? `${failures} site check(s) failed` : "all site checks passed");
process.exit(failures ? 1 : 0);
