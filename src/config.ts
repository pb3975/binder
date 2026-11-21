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
  /** How Binder knows who a person is. Bearer tokens work in every mode. */
  auth: AuthConfig;
};

/**
 * token:  people paste a token once; Binder keeps a session cookie.
 * none:   everyone without a token is the anonymous writer, on loopback (or BINDER_PUBLIC_URL's host) only.
 * header: a trusted proxy names the user in a header.
 * oidc:   people sign in with an OpenID Connect provider.
 */
export type AuthConfig = { mode: "token" } | { mode: "none" } | HeaderAuth | OidcAuth;
export type AuthMode = AuthConfig["mode"];
export type HeaderAuth = {
  mode: "header";
  /** Request header that names the user, such as Tailscale-User-Login. */
  header: string;
  /** Logins the header may name: exact, `*@domain`, or `*`. */
  allowedUsers: string[];
  /** Peer addresses (IPs or IPv4 CIDRs) the header is accepted from. */
  trustedProxies: string[];
};
export type OidcAuth = {
  mode: "oidc";
  /** Compared exactly with the discovered and the ID token's `iss`. */
  issuer: string;
  clientId: string;
  /** Null makes Binder a public client (PKCE only). */
  clientSecret: string | null;
  scopes: string;
  /** Text on the sign-in button. */
  label: string;
  /** Emails that may sign in: exact, `*@domain`, or `*`. */
  allowedUsers: string[];
  /** Members of any of these groups may sign in. */
  allowedGroups: string[];
  /** ID token claim that lists the user's groups. */
  groupsClaim: string;
  /** `${BINDER_PUBLIC_URL}/auth/callback`. */
  redirectUri: string;
  /** Tests only: allow plain http to a provider that is not on loopback. */
  allowHttp: boolean;
  /** The one ID token signature algorithm accepted. */
  signingAlg: SigningAlg;
  /** When set, the ID token's `hd` claim (Google Workspace) must equal it. */
  hostedDomain: string | null;
};
export const SIGNING_ALGS = ["RS256", "PS256", "ES256"] as const;
export type SigningAlg = (typeof SIGNING_ALGS)[number];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** https, or plain http only to loopback or when BINDER_OIDC_ALLOW_HTTP=true (an isolated test network). */
export const secureEnough = (u: URL, allowHttp: boolean) =>
  u.protocol === "https:" || (u.protocol === "http:" && (allowHttp || LOOPBACK_HOSTS.has(u.hostname)));

/** Public CDNs that agent-built pages commonly load scripts, styles, and fonts from. */
export const DEFAULT_PREVIEW_HOSTS = [
  "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "esm.sh", "cdn.tailwindcss.com", "code.jquery.com",
  "fonts.googleapis.com", "fonts.gstatic.com",
];

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const AUTH_MODES: AuthMode[] = ["token", "none", "header", "oidc"];

/** The data folder alone, for the admin CLI, which must work whatever the auth settings are. */
export const dataDirOf = (env: Record<string, string | undefined>) => resolve(env.BINDER_DATA_DIR ?? env.DATA_DIR ?? "./data");

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

  const publicUrl = env.BINDER_PUBLIC_URL?.trim() ? parsePublicUrl(env.BINDER_PUBLIC_URL.trim()) : null;
  const port = Number(env.PORT ?? 8480);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is not a port number: ${env.PORT}`);

  if (env.ALLOWED_LOGINS || env.DEV_ALLOW_ANONYMOUS)
    throw new Error(
      "ALLOWED_LOGINS and DEV_ALLOW_ANONYMOUS were renamed. Use BINDER_AUTH_HEADER=Tailscale-User-Login with " +
        "BINDER_ALLOWED_USERS, or BINDER_AUTH=none. See docs/self-hosting.md.",
    );
  if (env.BINDER_DEV_ANONYMOUS !== undefined)
    throw new Error("BINDER_DEV_ANONYMOUS was replaced by BINDER_AUTH=none. See docs/self-hosting.md.");
  const trustedProxies = env.BINDER_TRUSTED_PROXIES ? list(env.BINDER_TRUSTED_PROXIES) : ["127.0.0.1", "::1"];
  for (const p of trustedProxies) if (!parseAddress(p)) throw new Error(`BINDER_TRUSTED_PROXIES: not an IP or IPv4 CIDR: ${p}`);

  return {
    dataDir: dataDirOf(env),
    host: env.HOST ?? "127.0.0.1",
    port,
    publicUrl,
    chromium,
    previewHosts,
    auth: loadAuth(env, publicUrl, trustedProxies),
  };
}

/** BINDER_PUBLIC_URL must be an http(s) origin. Binder serves from the root, so a path would break every link. */
function parsePublicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`BINDER_PUBLIC_URL is not a URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`BINDER_PUBLIC_URL must be http or https, not ${u.protocol}`);
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    throw new Error(`BINDER_PUBLIC_URL must be an origin with no path, such as https://binder.example.com. Binder does not support a subpath: ${raw}`);
  return u.origin;
}

function loadAuth(env: Record<string, string | undefined>, publicUrl: string | null, trustedProxies: string[]): AuthConfig {
  if (env.BINDER_AUTH !== undefined && !env.BINDER_AUTH.trim())
    throw new Error(`BINDER_AUTH is set but empty. Set it to ${AUTH_MODES.join(", ")}, or unset it.`);
  const header = env.BINDER_AUTH_HEADER?.trim() || null;
  // Deployments from before BINDER_AUTH set only BINDER_AUTH_HEADER.
  const mode = (env.BINDER_AUTH?.trim().toLowerCase() || (header ? "header" : "token")) as AuthMode;
  if (!AUTH_MODES.includes(mode)) throw new Error(`BINDER_AUTH must be one of ${AUTH_MODES.join(", ")}, not ${env.BINDER_AUTH}`);
  // A setting for another mode would be silently ignored, and with it a policy someone meant to apply.
  const owners: [string, AuthMode[]][] = [
    ["BINDER_AUTH_HEADER", ["header"]],
    ["BINDER_TRUSTED_PROXIES", ["header"]],
    ["BINDER_ALLOWED_USERS", ["header", "oidc"]],
    ["BINDER_ALLOWED_GROUPS", ["oidc"]],
    ...Object.keys(env).filter((k) => k.startsWith("BINDER_OIDC_")).map((k): [string, AuthMode[]] => [k, ["oidc"]]),
  ];
  for (const [k, modes] of owners)
    if (env[k]?.trim() && !modes.includes(mode))
      throw new Error(`${k} applies only with BINDER_AUTH=${modes.join(" or ")}, but BINDER_AUTH=${mode}. Unset ${k}, or change BINDER_AUTH.`);
  const allowedUsers = list(env.BINDER_ALLOWED_USERS).map((u) => u.toLowerCase());

  if (mode === "token" || mode === "none") return { mode };
  if (mode === "header") {
    if (!header) throw new Error("BINDER_AUTH=header needs BINDER_AUTH_HEADER, such as Tailscale-User-Login");
    if (!allowedUsers.length)
      throw new Error("BINDER_AUTH_HEADER is set, so BINDER_ALLOWED_USERS must list who may sign in (logins, *@domain, or *)");
    return { mode, header, allowedUsers, trustedProxies };
  }

  const missing = ["BINDER_OIDC_ISSUER", "BINDER_OIDC_CLIENT_ID", "BINDER_PUBLIC_URL"].filter((k) => !env[k]?.trim());
  if (missing.length || !publicUrl) throw new Error(`BINDER_AUTH=oidc needs ${missing.join(", ")}. See docs/self-hosting.md.`);
  const issuer = env.BINDER_OIDC_ISSUER!.trim();
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error(`BINDER_OIDC_ISSUER is not a URL: ${issuer}`);
  }
  const allowHttp = (env.BINDER_OIDC_ALLOW_HTTP?.trim() || "false").toLowerCase();
  if (allowHttp !== "true" && allowHttp !== "false") throw new Error("BINDER_OIDC_ALLOW_HTTP must be true or false");
  const http = allowHttp === "true";
  const plain = "Plain http works only for localhost, or with BINDER_OIDC_ALLOW_HTTP=true on an isolated test network.";
  if (!secureEnough(issuerUrl, http)) throw new Error(`BINDER_OIDC_ISSUER must be https: ${issuer}. ${plain}`);
  if (!secureEnough(new URL(publicUrl), http)) throw new Error(`BINDER_AUTH=oidc needs an https BINDER_PUBLIC_URL, so cookies are Secure: ${publicUrl}. ${plain}`);
  const signingAlg = (env.BINDER_OIDC_SIGNING_ALG?.trim() || "RS256").toUpperCase() as SigningAlg;
  if (!SIGNING_ALGS.includes(signingAlg)) throw new Error(`BINDER_OIDC_SIGNING_ALG must be one of ${SIGNING_ALGS.join(", ")}`);
  const hostedDomain = env.BINDER_OIDC_HOSTED_DOMAIN?.trim().toLowerCase() || null;
  if (hostedDomain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostedDomain)) throw new Error(`BINDER_OIDC_HOSTED_DOMAIN is not a domain: ${hostedDomain}`);
  const allowedGroups = list(env.BINDER_ALLOWED_GROUPS);
  if (!allowedUsers.length && !allowedGroups.length)
    throw new Error("BINDER_AUTH=oidc needs BINDER_ALLOWED_USERS (emails, *@domain, or *) or BINDER_ALLOWED_GROUPS, or both");
  const scopes = (env.BINDER_OIDC_SCOPES?.trim() || "openid email profile").split(/\s+/);
  if (!scopes.includes("openid")) throw new Error("BINDER_OIDC_SCOPES must include openid");
  return {
    mode,
    issuer,
    clientId: env.BINDER_OIDC_CLIENT_ID!.trim(),
    clientSecret: env.BINDER_OIDC_CLIENT_SECRET?.trim() || null,
    scopes: scopes.join(" "),
    label: env.BINDER_OIDC_LABEL?.trim() || "Sign in with SSO",
    allowedUsers,
    allowedGroups,
    groupsClaim: env.BINDER_OIDC_GROUPS_CLAIM?.trim() || "groups",
    // Built from configuration only, never from a request's Host header.
    redirectUri: `${publicUrl}/auth/callback`,
    allowHttp: http,
    signingAlg,
    hostedDomain,
  };
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
