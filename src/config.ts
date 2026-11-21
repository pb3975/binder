import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** All configuration comes from the environment. docs/self-hosting.md lists every variable. */
export type Config = {
  dataDir: string;
  host: string;
  port: number;
  /** Origin used in links Binder returns, such as https://binder.example.com. Defaults to the request's origin. */
  publicUrl: string | null;
  /** Chromium binary for previews, or null when previews are off or Chromium is missing. */
  chromium: string | null;
  /** The only external hosts a page may load from while its preview renders (https only). */
  previewHosts: string[];
  /** Trusted proxy header that names the user, such as Tailscale-User-Login. Null turns header auth off. */
  authHeader: string | null;
  /** Logins the header may name: exact, `*@domain`, or `*`. */
  allowedUsers: string[];
  /** Peer addresses (IPs or IPv4 CIDRs) the header is accepted from. */
  trustedProxies: string[];
  /** Local development only: every request is the anonymous writer. */
  devAnonymous: boolean;
  /** Where version files and previews live. The database always stays in `dataDir`. */
  storage: StorageConfig;
  /** The key that signs content URLs and sessions, from BINDER_SECRET_KEY. Null means data/secret.key. */
  secretKey: Buffer | null;
};

/**
 * `local` keeps files under the data folder. `s3` keeps them in a bucket, under `prefix`:
 * versions/<id>/<n>/<path>, thumbs/<id>.png, and db/ for the Litestream replica of the database.
 */
export type StorageConfig =
  | { kind: "local" }
  | { kind: "s3"; bucket: string; prefix: string; region: string; endpoint: string | null };

/** Public CDNs that agent-built pages commonly load scripts, styles, and fonts from. */
export const DEFAULT_PREVIEW_HOSTS = [
  "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "esm.sh", "cdn.tailwindcss.com", "code.jquery.com",
  "fonts.googleapis.com", "fonts.gstatic.com",
];

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const previews = (env.BINDER_PREVIEWS ?? "auto").toLowerCase();
  if (!["auto", "on", "off"].includes(previews)) throw new Error("BINDER_PREVIEWS must be auto, on, or off");
  const chromium =
    previews === "off"
      ? null
      : ([env.CHROMIUM, "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => p && existsSync(p)) ?? null);
  if (previews === "on" && !chromium) throw new Error("BINDER_PREVIEWS=on but no Chromium was found; set CHROMIUM");

  const previewHosts = env.BINDER_PREVIEW_HOSTS !== undefined ? list(env.BINDER_PREVIEW_HOSTS) : DEFAULT_PREVIEW_HOSTS;
  for (const h of previewHosts)
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h)) throw new Error(`BINDER_PREVIEW_HOSTS: not a host name: ${h}`);

  const publicUrl = env.BINDER_PUBLIC_URL ? new URL(env.BINDER_PUBLIC_URL).origin : null;
  const port = Number(env.PORT ?? 8480);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a port number: ${env.PORT}`);

  if (env.ALLOWED_LOGINS || env.DEV_ALLOW_ANONYMOUS)
    throw new Error(
      "ALLOWED_LOGINS and DEV_ALLOW_ANONYMOUS were renamed. Use BINDER_AUTH_HEADER=Tailscale-User-Login with " +
        "BINDER_ALLOWED_USERS, or BINDER_DEV_ANONYMOUS=1. See docs/self-hosting.md.",
    );
  const authHeader = env.BINDER_AUTH_HEADER?.trim() || null;
  const allowedUsers = list(env.BINDER_ALLOWED_USERS).map((u) => u.toLowerCase());
  if (authHeader && !allowedUsers.length)
    throw new Error("BINDER_AUTH_HEADER is set, so BINDER_ALLOWED_USERS must list who may sign in (logins, *@domain, or *)");
  const trustedProxies = env.BINDER_TRUSTED_PROXIES ? list(env.BINDER_TRUSTED_PROXIES) : ["127.0.0.1", "::1"];
  for (const p of trustedProxies) if (!parseAddress(p)) throw new Error(`BINDER_TRUSTED_PROXIES: not an IP or IPv4 CIDR: ${p}`);

  const storage = storageConfig(env);
  const secretKey = env.BINDER_SECRET_KEY ? secretKeyFrom(env.BINDER_SECRET_KEY) : null;
  // The task's disk is gone after every restart, so a generated key would end every session and link.
  if (storage.kind === "s3" && !secretKey)
    throw new Error("BINDER_STORAGE is s3, so BINDER_SECRET_KEY is required: base64 of at least 32 random bytes (openssl rand -base64 32)");

  return {
    dataDir: resolve(env.BINDER_DATA_DIR ?? env.DATA_DIR ?? "./data"),
    host: env.HOST ?? "127.0.0.1",
    port,
    publicUrl,
    chromium,
    previewHosts,
    authHeader,
    allowedUsers,
    trustedProxies,
    devAnonymous: env.BINDER_DEV_ANONYMOUS === "1",
    storage,
    secretKey,
  };
}

/** Parses BINDER_STORAGE: unset or `local`, or `s3://<bucket>/<prefix>` with the standard AWS variables. */
export function storageConfig(env: Record<string, string | undefined>): StorageConfig {
  const raw = env.BINDER_STORAGE?.trim() || "local";
  if (raw === "local") return { kind: "local" };
  const m = raw.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!m) throw new Error(`BINDER_STORAGE must be local or s3://<bucket>/<prefix>, not ${raw}`);
  const bucket = m[1]!;
  const prefix = m[2]!.replace(/\/+$/, "");
  // Bucket naming rules, and a conservative key prefix, so both are safe in the Litestream config too.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error(`BINDER_STORAGE: not an S3 bucket name: ${bucket}`);
  if (prefix && !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix))
    throw new Error(`BINDER_STORAGE: the prefix may use letters, digits, . _ - and single slashes: ${prefix}`);
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (!region || !/^[a-z0-9-]+$/.test(region)) throw new Error("BINDER_STORAGE is s3, so AWS_REGION (or AWS_DEFAULT_REGION) must name a region");
  const rawEndpoint = env.AWS_ENDPOINT_URL_S3?.trim() || env.AWS_ENDPOINT_URL?.trim() || null;
  let endpoint: string | null = null;
  if (rawEndpoint) {
    const u = URL.parse(rawEndpoint);
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.search || u.hash || u.username)
      throw new Error(`AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL must be an http or https URL: ${rawEndpoint}`);
    endpoint = u.href.replace(/\/+$/, "");
  }
  return { kind: "s3", bucket, prefix, region, endpoint };
}

/** BINDER_SECRET_KEY: strict base64 (standard or url-safe) of at least 32 bytes. */
function secretKeyFrom(s: string): Buffer {
  const t = s.trim();
  // Buffer.from(_, "base64") skips characters it does not know, so check the alphabet first.
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) throw new Error("BINDER_SECRET_KEY must be base64");
  const key = Buffer.from(t, "base64");
  if (key.length < 32) throw new Error(`BINDER_SECRET_KEY must decode to at least 32 bytes, not ${key.length}`);
  return key;
}

/** Parses an IP or an IPv4 CIDR into a matcher. IPv4-mapped IPv6 peers (::ffff:a.b.c.d) match their IPv4 form. */
export function parseAddress(spec: string): ((ip: string) => boolean) | null {
  const v4 = (ip: string) => {
    const m = ip.replace(/^::ffff:/i, "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.every((n) => n <= 255) ? parts.reduce((a, n) => (a << 8) + n, 0) >>> 0 : null;
  };
  const [addr, bits] = spec.split("/");
  if (bits !== undefined) {
    const base = v4(addr!);
    const n = Number(bits);
    if (base === null || !Number.isInteger(n) || n < 0 || n > 32) return null;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (ip) => {
      const x = v4(ip);
      return x !== null && (x & mask) >>> 0 === (base & mask) >>> 0;
    };
  }
  if (v4(addr!) !== null) return (ip) => v4(ip) === v4(addr!);
  if (/^[0-9a-f:]+$/i.test(addr!) && addr!.includes(":")) return (ip) => ip.toLowerCase() === addr!.toLowerCase();
  return null;
}
