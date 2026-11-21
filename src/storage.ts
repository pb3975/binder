// Where version files and previews live: the data folder (default) or an S3 bucket.
// Keys are the same on both: versions/<id>/<n>/<path> and thumbs/<id>.png.
// The SQLite database is not here. It always stays on local disk (see docs/design.md, "Storage").
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { credentialProvider, s3Clients, type Credentials } from "./aws";
import type { StorageConfig } from "./config";

export const versionKey = (id: string, n: number, path = "") => `versions/${id}/${n}/${path}`;
export const thumbKey = (id: string) => `thumbs/${id}.png`;
/** The content type for a stored path, from its extension. Both backends use it, so headers match. */
export const typeOf = (path: string) => Bun.file(path).type;

export type NewFile = { path: string; data: Blob | Uint8Array };

/** How a backend records a new version once its files are in place. Both calls are synchronous. */
export type Ledger = {
  /** The lowest free version number. */
  next(): number;
  /** Records version n. `place` runs inside the database transaction. Throws when n is taken. */
  commit(n: number, place?: () => void): void;
};

export interface Storage {
  /** For logs, such as "s3://bucket/prefix". */
  readonly location: string;
  /**
   * A stored file, or null when it is missing. The Blob is never an S3File: a Response built from one
   * answers with a redirect to a presigned URL, which would drop Binder's sandbox headers.
   */
  read(key: string): Promise<Blob | null>;
  write(key: string, data: Blob | Uint8Array): Promise<void>;
  /** Removes one key. Only for derived data (previews); version files are never deleted. */
  delete(key: string): Promise<void>;
  /**
   * Stores the files of a new version of `id`, then records it with `ledger.commit`. A failure before
   * the commit leaves no recorded version, and files of a recorded version are never overwritten.
   */
  addVersion(id: string, files: NewFile[], ledger: Ledger): Promise<number>;
  /** Fails when the store cannot be reached with the current settings (startup check). */
  check(): Promise<void>;
}

export function openStorage(cfg: StorageConfig, dataDir: string, env: Record<string, string | undefined> = process.env): Storage {
  return cfg.kind === "local" ? localStorage(dataDir) : s3Storage(cfg, credentialProvider(env));
}

/** Files under the data folder. Staged in tmp/ and renamed into place inside the commit transaction. */
export function localStorage(dataDir: string): Storage {
  const full = (key: string) => join(dataDir, key);
  return {
    location: dataDir,
    async read(key) {
      const f = Bun.file(full(key));
      return (await f.exists()) ? f : null;
    },
    async write(key, data) {
      await Bun.write(full(key), data);
    },
    async delete(key) {
      rmSync(full(key), { force: true });
    },
    async addVersion(id, files, ledger) {
      const staging = join(dataDir, "tmp", crypto.randomUUID());
      try {
        for (const f of files) await Bun.write(join(staging, f.path), f.data);
        // No await from here on: the number and the rename happen in one synchronous step.
        const n = ledger.next();
        ledger.commit(n, () => {
          const dir = join(dataDir, "versions", id, String(n));
          mkdirSync(dirname(dir), { recursive: true });
          // A folder left by a crash between rename and commit is an orphan; keep it in trash.
          if (existsSync(dir)) renameSync(dir, join(dataDir, "trash", `${id}-v${n}-orphan-${Date.now()}`));
          renameSync(staging, dir);
        });
        return n;
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
    async check() {},
  };
}

const UPLOADS_AT_ONCE = 4;

/** Objects in one bucket under one prefix. Binder must be the only writer of that prefix. */
export function s3Storage(cfg: Extract<StorageConfig, { kind: "s3" }>, credentials: () => Promise<Credentials>): Storage {
  const client = s3Clients(cfg, credentials);
  const full = (key: string) => (cfg.prefix ? `${cfg.prefix}/${key}` : key);
  const has = async (prefix: string) => ((await (await client()).list({ prefix: full(prefix), maxKeys: 1 })).keyCount ?? 0) > 0;
  const put = async (key: string, data: Blob | Uint8Array) => {
    await (await client()).write(full(key), data, { type: typeOf(key) || "application/octet-stream" });
  };
  /**
   * Writes a key only if it does not exist yet (a conditional PUT with If-None-Match: *). Version files
   * are written this way, so a second Binder on the same prefix fails loudly instead of overwriting them.
   * Bun.S3Client cannot send that header, so this signs a short-lived URL and sends the PUT itself.
   */
  const putNew = async (key: string, data: Blob | Uint8Array) => {
    const type = typeOf(key) || "application/octet-stream";
    const url = (await client()).presign(full(key), { method: "PUT", expiresIn: 300 });
    const r = await fetch(url, { method: "PUT", body: data as BodyInit, headers: { "if-none-match": "*", "content-type": type } });
    if (r.status === 412 || r.status === 409)
      throw new Error(`${full(key)} already exists: another Binder is writing to this prefix. Run one Binder per prefix.`);
    if (!r.ok) throw new Error(`S3 PUT ${full(key)} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  };

  return {
    location: `s3://${cfg.bucket}/${cfg.prefix}`,
    async read(key) {
      try {
        // Whole files (64 MB at most per artifact), so a missing or failed read is known before any header is sent.
        return new Blob([await (await client()).file(full(key)).bytes()]);
      } catch (e) {
        if ((e as { code?: string }).code === "NoSuchKey") return null;
        throw e;
      }
    },
    write: put,
    async delete(key) {
      await (await client()).delete(full(key));
    },
    async addVersion(id, files, ledger) {
      // A number with objects but no database row belongs to an upload that never committed, or to a
      // version the database lost in a crash before Litestream copied it. Skip it, so those files stay.
      let n = ledger.next();
      while (await has(versionKey(id, n))) {
        console.warn(`storage: ${full(versionKey(id, n))} has objects but no version row; using the next number`);
        n++;
      }
      const done: string[] = [];
      for (let i = 0; i < files.length; i += UPLOADS_AT_ONCE) {
        // allSettled, not all: every upload of the batch has finished before any cleanup starts.
        const batch = await Promise.allSettled(
          files.slice(i, i + UPLOADS_AT_ONCE).map(async (f) => {
            const key = versionKey(id, n, f.path);
            await putNew(key, f.data);
            done.push(key);
          }),
        );
        const failed = batch.find((r) => r.status === "rejected");
        if (failed) {
          // Nothing points at these yet. Remove them, so the number stays free.
          await Promise.allSettled(done.map(async (k) => (await client()).delete(full(k))));
          throw failed.reason;
        }
      }
      ledger.commit(n);
      return n;
    },
    async check() {
      await (await client()).list({ prefix: full(""), maxKeys: 1 });
    },
  };
}
