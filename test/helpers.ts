// Starts a Binder app on a random port with a throwaway data folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREVIEW_HOSTS, type Config, type HeaderAuth } from "../src/config";
import { createApp } from "../src/server";
import type { Replication } from "../src/replication";
import type { Storage } from "../src/storage";

export function startBinder(over: Partial<Config> = {}, opts: { now?: () => number; dataDir?: string; storage?: Storage; replication?: Replication } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "binder-test-"));
  const cfg: Config = {
    dataDir, host: "127.0.0.1", port: 0, publicUrl: null, chromium: null, previewHosts: DEFAULT_PREVIEW_HOSTS,
    // Default: Tailscale-style header mode, as on a tailnet behind `tailscale serve`.
    auth: headerAuth(), storage: { kind: "local" }, secretKey: null, litestreamSocket: null, ...over,
  };
  const app = createApp(cfg, { now: opts.now, storage: opts.storage, replication: opts.replication });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    app, base, dataDir,
    stop(keepData = false) {
      server.stop(true);
      app.db.close();
      if (!keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const headerAuth = (over: Partial<HeaderAuth> = {}): HeaderAuth => ({
  mode: "header", header: "Tailscale-User-Login", allowedUsers: ["owner@example.com"], trustedProxies: ["127.0.0.1", "::1"], ...over,
});

export const owner = { "tailscale-user-login": "owner@example.com" };
export const writer = { ...owner, "x-binder": "1" };

export function form(meta: object, files: [string, string][]) {
  const f = new FormData();
  f.set("meta", JSON.stringify(meta));
  for (const [name, body] of files) f.append("file", new File([body], name, { type: "text/html" }));
  return f;
}

export function publisher(base: string, headers: Record<string, string> = writer) {
  return (meta: object, files: [string, string][], h: Record<string, string> = headers) =>
    fetch(`${base}/api/artifacts`, { method: "POST", headers: h, body: form(meta, files) });
}
