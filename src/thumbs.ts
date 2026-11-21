import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Signer } from "./content";
import type { Db } from "./db";
import { thumbKey, type Storage } from "./storage";

/**
 * Renders a 640x400 preview of an artifact's current version with headless Chromium.
 *
 * Chromium never opens the artifact from file://. It loads Binder's /render wrapper
 * over loopback http, which frames the artifact in a sandbox and limits frames to
 * Binder's own /c/ path. See docs/design.md, "Previews", and test/e2e/previews.test.ts.
 * One render at a time: a home server is not a render farm.
 */
export function thumbnailer(opts: {
  db: Db;
  storage: Storage;
  /** Local scratch folder; Chromium writes the screenshot here before it is stored. */
  tmpDir: string;
  signer: Signer;
  chromium: string | null;
  hosts: string[];
}) {
  const { db, storage, tmpDir, signer, chromium: bin } = opts;
  const queue: string[] = [];
  let origin: string | null = null;
  let running = false;

  async function render(id: string) {
    const a = db.get(id);
    if (!a || !bin || !origin) return;
    if (!/\.html?$/i.test(a.entry)) return; // images and SVGs preview themselves; other files get a cover
    const out = join(tmpDir, `thumb-${id}-${crypto.randomUUID()}.png`);
    const profile = join(process.env.TMPDIR ?? "/tmp", `binder-chrome-${id}-${Date.now()}`);
    const proc = Bun.spawn(
      [
        bin, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
        "--no-first-run", "--disable-crash-reporter", "--disable-extensions", "--disable-background-networking",
        `--user-data-dir=${profile}`, "--window-size=1280,800", "--force-device-scale-factor=0.5",
        // Docker gives /dev/shm only 64 MB; Chromium stalls when it runs out (measured in CI).
        "--disable-dev-shm-usage", "--virtual-time-budget=4000", "--disable-quic", "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        // Network allowlist under the CSP: everything goes to a dead proxy except Binder itself and the
        // preview hosts. This also stops connections that CSP never sees, such as speculative preconnects.
        "--proxy-server=http://127.0.0.1:9", `--proxy-bypass-list=<-loopback>;${new URL(origin).host};${opts.hosts.join(";")}`,
        `--screenshot=${out}`, origin + signer.renderPath(id, a.version),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    const timer = setTimeout(() => proc.kill(), 30_000);
    await proc.exited;
    clearTimeout(timer);
    rmSync(profile, { recursive: true, force: true });
    // Only record the preview if the artifact was not republished while rendering.
    try {
      if (existsSync(out) && db.get(id)?.version === a.version) {
        await storage.write(thumbKey(id), Bun.file(out));
        // A publish during the upload queued a new render, which replaces this preview.
        if (db.get(id)?.version === a.version) db.setThumb(id, true);
      } else if (db.get(id)?.version === a.version) console.warn(`thumbnail failed for ${id}`);
    } finally {
      rmSync(out, { force: true });
    }
  }

  async function drain() {
    if (running || !origin) return;
    running = true;
    while (queue.length) {
      const id = queue.shift()!;
      try {
        await render(id);
      } catch (e) {
        console.warn(`thumbnail error for ${id}:`, e);
      }
    }
    running = false;
  }

  return {
    available: Boolean(bin),
    enqueue(id: string) {
      if (!bin || queue.includes(id)) return;
      queue.push(id);
      void drain();
    },
    /** Starts rendering once the server is listening. `base` is a loopback URL Chromium can reach. */
    start(base: string) {
      origin = base;
      void drain();
    },
    /** Resolves when the queue is empty (tests). */
    async idle() {
      while (origin && (running || queue.length)) await Bun.sleep(50);
    },
  };
}
