import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Capability URLs for artifact content: /c/<id>/<version>/<token>/<path>.
 *
 * Content is served this way because a sandboxed (opaque-origin) page sends no
 * SameSite cookies on its subresource requests, so a cookie login cannot load a
 * multi-file artifact. A signature in the path is inherited by relative URLs.
 * Each token grants read access to one version only.
 */
export type Mode = "view" | "render";

// Expiry is rounded up to the hour, so a URL stays stable (and cacheable) for an hour,
// and lives 8 to 9 hours: a working day in an open tab, and not much longer once copied.
const BUCKET = 3600;
const MIN_TTL = 8 * 3600;

/** Reads data/secret.key, or creates it (32 random bytes, mode 0600) on first start. */
export function loadSecret(dataDir: string): Buffer {
  const path = join(dataDir, "secret.key");
  if (!existsSync(path)) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, randomBytes(32));
      closeSync(fd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const key = readFileSync(path);
  if (key.length < 32) throw new Error(`${path} is shorter than 32 bytes`);
  return key;
}

export function signer(secret: Buffer, now: () => number) {
  const mac = (purpose: string) => createHmac("sha256", secret).update(purpose).digest("base64url");
  const nowSec = () => Math.floor(now() / 1000);

  function token(id: string, version: number, mode: Mode): string {
    const exp = (Math.floor((nowSec() + MIN_TTL) / BUCKET) + 1) * BUCKET;
    return `${mode === "render" ? "r" : ""}${exp}.${mac(`content:${mode}:${id}:${version}:${exp}`)}`;
  }

  return {
    /** Path prefix (no trailing slash) for one version's files. */
    contentPath: (id: string, version: number, mode: Mode = "view") => `/c/${id}/${version}/${token(id, version, mode)}`,
    renderPath: (id: string, version: number) => `/render/${id}/${version}/${token(id, version, "render")}`,
    /** The token's mode when it is valid for this id and version, otherwise null. */
    verify(id: string, version: number, tok: string): Mode | null {
      const m = tok.match(/^(r?)(\d{1,12})\.([\w-]{43})$/);
      if (!m) return null;
      const mode: Mode = m[1] ? "render" : "view";
      const exp = Number(m[2]);
      if (exp <= nowSec()) return null;
      const want = Buffer.from(mac(`content:${mode}:${id}:${version}:${exp}`));
      const got = Buffer.from(m[3]!);
      return want.length === got.length && timingSafeEqual(want, got) ? mode : null;
    },
    /** A general-purpose MAC for other signed values, such as session cookies. */
    mac,
  };
}

export type Signer = ReturnType<typeof signer>;
