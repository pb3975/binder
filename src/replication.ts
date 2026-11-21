// Talks to Litestream's control socket when the database is copied to S3 (BINDER_STORAGE=s3://...).
//
// Litestream copies the database about once a second, on its own schedule. That leaves two gaps:
// a write in the first second after start is not copied by Litestream's final sync if the task stops
// first (measured with 0.5.18: its shutdown skips a database it has not picked up yet), and a copy that
// keeps failing is invisible while writes still succeed. So Binder asks Litestream to copy and wait
// (POST /sync with wait) before it answers a write, and /healthz fails when the copy falls behind.

/** How long the copy may lag before /healthz fails. Long enough to ride out a slow S3 request or two. */
export const MAX_LAG_MS = 60_000;
const HEALTH_CACHE_MS = 5_000;

export type Health = { ok: boolean; detail: string };
export type Replication = {
  /** Resolves once every committed change is in S3. Throws when Litestream cannot confirm it. */
  flush(): Promise<void>;
  health(): Promise<Health>;
};

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
    const body = (await r.json().catch(() => ({}))) as SyncAnswer;
    if (!r.ok) throw new Error(`Litestream answered ${r.status}: ${body.error ?? "no detail"}`);
    return { txid: Number(body.txid ?? 0), replicated: Number(body.replicated_txid ?? 0) };
  }

  let lagSince: number | null = null;
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
        if (replicated >= txid) {
          lagSince = null;
          value = { ok: true, detail: `copied to S3 up to transaction ${txid}` };
        } else {
          lagSince ??= now();
          const lag = now() - lagSince;
          value = {
            ok: lag <= MAX_LAG_MS,
            detail: `S3 has transaction ${replicated} of ${txid}, behind for ${Math.round(lag / 1000)}s`,
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
