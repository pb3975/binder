// Talks to Litestream's control socket when the database is copied to S3 (BINDER_STORAGE=s3://...).
//
// Litestream copies the database about once a second, on its own schedule. That leaves two gaps:
// a write in the first second after start is not copied by Litestream's final sync if the task stops
// first (measured with 0.5.18: its shutdown skips a database it has not picked up yet), and a copy that
// keeps failing is invisible while writes still succeed. So Binder asks Litestream to copy and wait
// (POST /sync with wait) before it answers a write, and /healthz fails when the copy falls behind.

import { join } from "node:path";
import type { Config } from "./config";

/** How long the copy may lag before /healthz fails. Long enough to ride out a slow S3 request or two. */
export const MAX_LAG_MS = 60_000;
const HEALTH_CACHE_MS = 5_000;

export type Health = { ok: boolean; detail: string };
export type Replication = {
  /** Resolves once every committed change is in S3. Throws when Litestream cannot confirm it. */
  flush(): Promise<void>;
  health(): Promise<Health>;
};

/** Litestream for S3 storage, or null for local storage. Shared by the server and the CLI. */
export function openReplication(cfg: Config): Replication | null {
  return cfg.storage.kind === "s3" ? litestream(cfg.litestreamSocket!, join(cfg.dataDir, "binder.sqlite")) : null;
}

type SyncAnswer = { status?: string; txid?: number; replicated_txid?: number; error?: string };

export function litestream(socket: string, dbPath: string, opts: { now?: () => number } = {}): Replication {
  const now = opts.now ?? Date.now;
  async function sync(wait: boolean, timeoutSec: number): Promise<{ txid: number; replicated: number }> {
    let r: Response;
    try {
      r = await fetch("http://litestream/sync", {
        unix: socket,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: dbPath, wait, timeout: timeoutSec }),
        signal: AbortSignal.timeout((timeoutSec + 5) * 1000),
      });
    } catch (e) {
      throw new Error(`cannot reach Litestream at ${socket}: ${(e as Error).message}`);
    }
    const body = (await r.json().catch(() => null)) as SyncAnswer | null;
    if (!r.ok) throw new Error(`Litestream answered ${r.status}: ${body?.error ?? "no detail"}`);
    // A reply that is cut short or malformed must never read as "everything is copied".
    // Binder creates its tables before it asks, so a real database is always at transaction 1 or later.
    const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
    const known = wait ? ["synced", "no_change"] : ["synced", "synced_local", "no_change"];
    if (!body || !known.includes(body.status ?? "") || !valid(body.txid) || !(valid(body.replicated_txid) || body.replicated_txid === 0))
      throw new Error(`Litestream answered something Binder cannot read: ${JSON.stringify(body).slice(0, 200)}`);
    return { txid: body.txid, replicated: body.replicated_txid as number };
  }

  // Local transactions that S3 did not have yet, oldest first, with when a probe first saw each one.
  // The lag is the age of the oldest of them, so a copy that keeps up (even one transaction behind,
  // under steady writes) stays healthy, and only a copy that stops moving fails.
  const outstanding: { txid: number; seen: number }[] = [];
  let cached: { at: number; value: Health } | null = null;

  return {
    async flush() {
      const { txid, replicated } = await sync(true, 15);
      if (replicated < txid) throw new Error(`Litestream copied up to transaction ${replicated} of ${txid}`);
    },
    async health() {
      if (cached && now() - cached.at < HEALTH_CACHE_MS) return cached.value;
      let value: Health;
      try {
        // Without wait, this only folds new local changes into Litestream's log; it uploads nothing.
        const { txid, replicated } = await sync(false, 5);
        while (outstanding.length && outstanding[0]!.txid <= replicated) outstanding.shift();
        if (replicated >= txid) outstanding.length = 0;
        // Capped, keeping the oldest: the lag only needs the oldest entry.
        else if ((!outstanding.length || outstanding.at(-1)!.txid < txid) && outstanding.length < 10_000)
          outstanding.push({ txid, seen: now() });
        if (!outstanding.length) value = { ok: true, detail: `copied to S3 up to transaction ${txid}` };
        else {
          const lag = now() - outstanding[0]!.seen;
          value = {
            ok: lag <= MAX_LAG_MS,
            detail: `S3 has transaction ${replicated} of ${txid}; the oldest change it lacks is ${Math.round(lag / 1000)}s old`,
          };
        }
      } catch (e) {
        value = { ok: false, detail: (e as Error).message };
      }
      cached = { at: now(), value };
      return value;
    },
  };
}

/** Runs `fn` until it succeeds or `ms` pass, then throws its last error. */
export async function retry(fn: () => Promise<void>, ms: number, every = 250): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() >= until) throw e;
      await Bun.sleep(every);
    }
  }
}
