// A minimal Chrome DevTools Protocol client, so browser checks need no npm dependency.
// One Chromium process serves every check; each `browser()` call gets its own isolated
// browser context (separate cookies and storage), like a fresh incognito window.
const CHROMIUM = process.env.CHROMIUM ?? "/usr/bin/chromium-browser";
const debug = (m: string) => process.env.E2E_DEBUG && console.log(`  [cdp ${new Date().toISOString().slice(11, 23)}] ${m}`);

type Reply = { result?: Record<string, unknown>; error?: { message: string } };

/** One DevTools websocket with request/reply matching and a per-call timeout. */
async function connect(url: string) {
  const sock = new WebSocket(url);
  await Promise.race([
    new Promise((r) => (sock.onopen = r)),
    Bun.sleep(10_000).then(() => { throw new Error(`devtools socket did not open: ${url}`); }),
  ]);
  let n = 0;
  const pending = new Map<number, (m: Reply) => void>();
  const listeners = new Map<string, (params: Record<string, unknown>) => void>();
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) pending.get(m.id)?.(m);
    else listeners.get(m.method)?.(m.params);
  };
  return {
    async send(method: string, params: object = {}) {
      const id = ++n;
      const m = await Promise.race([
        new Promise<Reply>((r) => { pending.set(id, r); sock.send(JSON.stringify({ id, method, params })); }),
        Bun.sleep(20_000).then((): Reply => ({ error: { message: "no reply in 20 s (page hung?)" } })),
      ]);
      pending.delete(id);
      if (m.error) throw new Error(`${method}: ${m.error.message}`);
      return m.result ?? {};
    },
    on: (method: string, fn: (params: Record<string, unknown>) => void) => listeners.set(method, fn),
    close: () => sock.close(),
  };
}

let shared: Promise<{ port: string; root: Awaited<ReturnType<typeof connect>>; proc: ReturnType<typeof Bun.spawn> }> | null = null;

function launch() {
  shared ??= (async () => {
    // Port 0: Chromium picks a free port and writes it to DevToolsActivePort.
    const dir = `/tmp/cdp-${process.pid}-${Date.now()}`;
    const extra = (process.env.E2E_CHROME_FLAGS ?? "").split(" ").filter(Boolean);
    const proc = Bun.spawn([CHROMIUM, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
      // Docker's 64 MB /dev/shm made pages stop answering in about 40% of runs; 0 of 8 with this flag.
      "--disable-dev-shm-usage", `--user-data-dir=${dir}`, "--remote-debugging-port=0", ...extra, "about:blank"], { stdout: "ignore", stderr: "ignore" });
    process.on("exit", () => proc.kill());
    for (let i = 0; i < 150; i++) {
      await Bun.sleep(200);
      const port = (await Bun.file(`${dir}/DevToolsActivePort`).text().catch(() => "")).split("\n")[0];
      if (!port) continue;
      const info = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json(), () => null);
      if (info?.webSocketDebuggerUrl) {
        debug(`chromium up on ${port}`);
        return { port, root: await connect(info.webSocketDebuggerUrl), proc };
      }
    }
    proc.kill();
    throw new Error("chromium did not start");
  })();
  return shared;
}

export async function browser(opts: { width?: number; height?: number; dark?: boolean } = {}) {
  const { port, root } = await launch();
  const { browserContextId } = await root.send("Target.createBrowserContext", { disposeOnDetach: true });
  const { targetId } = await root.send("Target.createTarget", { url: "about:blank", browserContextId });
  const page = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  const send = page.send;
  debug(`page ${String(targetId).slice(0, 8)} in context ${String(browserContextId).slice(0, 8)}`);

  // A JavaScript dialog blocks the page, and every later call would time out. Record it and dismiss it.
  const dialogs: string[] = [];
  page.on("Page.javascriptDialogOpening", (p) => {
    dialogs.push(`${p.type}: ${p.message}`);
    debug(`dialog ${p.type}: ${p.message}`);
    void send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  // A crashed renderer looks like a page that never answers; record it so a timeout says why.
  page.on("Inspector.targetCrashed", () => { dialogs.push("RENDERER CRASHED"); debug("renderer crashed"); });
  await send("Inspector.enable");
  await send("Page.enable");
  // Record CSP violations on every page, so a check can assert the UI never trips its own policy.
  await send("Page.addScriptToEvaluateOnNewDocument", { source:
    `window.__csp = []; addEventListener("securitypolicyviolation", (e) => __csp.push(e.violatedDirective + " " + e.blockedURI), true);` });
  const width = opts.width ?? 1440;
  await send("Emulation.setDeviceMetricsOverride", { width, height: opts.height ?? 900, deviceScaleFactor: 1, mobile: width < 600 });
  if (opts.dark) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string } };
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text} in ${expression.slice(0, 80)}`);
    return r.result.value;
  };
  return {
    send,
    evaluate,
    dialogs,
    async goto(url: string, settle = 1200) {
      debug(`goto ${url}`);
      await send("Page.navigate", { url });
      await Bun.sleep(settle);
    },
    /** Waits until `expression` is truthy in the page. */
    async waitFor(expression: string, ms = 8000) {
      debug(`waitFor ${expression.slice(0, 60)}`);
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return true;
        await Bun.sleep(100);
      }
      const state = await evaluate<string>(
        `JSON.stringify({ url: location.href, text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 300), csp: window.__csp })`,
      ).catch((e) => `page unreadable: ${e}`);
      throw new Error(`timed out waiting for ${expression}; page: ${state}; dialogs: ${dialogs.join(" | ")}`);
    },
    async screenshot(path: string) {
      const r = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
      await Bun.write(path, Buffer.from(r.data, "base64"));
    },
    close() {
      page.close();
      void root.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    },
  };
}

/** Stops the shared Chromium (call once at the end of a script). */
export async function shutdown() {
  if (!shared) return;
  const { root, proc } = await shared;
  root.close();
  proc.kill();
  shared = null;
}
