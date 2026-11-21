// OpenID Connect sign-in: the authorization code flow with PKCE (S256), state, and nonce.
// Binder verifies the ID token itself with Web Crypto. The provider owns passwords and MFA.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { listed } from "./auth";
import type { OidcAuth } from "./config";
import type { Signer } from "./content";

export const LOGIN_COOKIE = "binder_login";
const LOGIN_TTL = 600; // seconds from "Sign in" to the provider's redirect back
const SKEW = 60; // seconds of clock difference allowed on exp and iat

/** The only signature algorithms accepted. `none` and HS* are absent on purpose. */
const ALGS = {
  RS256: { kty: "RSA", key: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  PS256: { kty: "RSA", key: { name: "RSA-PSS", hash: "SHA-256" }, verify: { name: "RSA-PSS", saltLength: 32 } },
  ES256: { kty: "EC", key: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
} as const;
type Alg = keyof typeof ALGS;

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
type Jwk = { kty?: string; kid?: string; alg?: string; use?: string; crv?: string; n?: string; e?: string; x?: string; y?: string };
type Login = { state: string; nonce: string; verifier: string; next: string; exp: number };
export type Claims = Record<string, unknown>;

/** Why a callback failed. The UI maps each reason to fixed text, so a link cannot put words on the page. */
export type CallbackResult =
  | { ok: true; user: string; next: string }
  | { ok: false; reason: "denied" | "failed" | "expired"; detail: string };

class Refused extends Error {}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const random = () => randomBytes(32).toString("base64url");
const sameString = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

/**
 * `next` must stay on Binder. Parsing (not only a prefix check) catches tricks such as
 * "/\t/evil.example", which a browser reads as "//evil.example", and "/a/..//evil.example".
 */
export function localPath(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  try {
    const u = new URL(raw, origin);
    // Dot segments can collapse "/a/..//evil.example" into "//evil.example", which a browser
    // reads as another host. Check the path after parsing, not only the raw input.
    if (u.origin !== origin || u.pathname.startsWith("//")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

export function oidcClient(cfg: OidcAuth, sign: Signer, now: () => number) {
  const origin = new URL(cfg.redirectUri).origin;
  const secure = origin.startsWith("https:");
  const nowSec = () => Math.floor(now() / 1000);
  let discovery: Promise<Discovery> | null = null;
  let jwks: Jwk[] | null = null;
  const used = new Map<string, number>(); // state -> expiry, so a login cookie works once

  async function getJson(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${url} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as Record<string, unknown>;
  }

  /** Cached on success only, so Binder can start before the provider does. */
  function discover(): Promise<Discovery> {
    discovery ??= (async () => {
      const d = await getJson(`${cfg.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
      if (d.issuer !== cfg.issuer) throw new Error(`the provider's issuer is ${d.issuer}, not BINDER_OIDC_ISSUER (${cfg.issuer})`);
      for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        const v = d[k];
        if (typeof v !== "string") throw new Error(`discovery has no ${k}`);
        if (cfg.issuer.startsWith("https:") && !v.startsWith("https:")) throw new Error(`${k} is not https: ${v}`);
      }
      return d as Discovery;
    })().catch((e) => {
      discovery = null;
      throw e;
    });
    return discovery;
  }

  async function signingKey(alg: Alg, kid: string | undefined, refresh: boolean): Promise<CryptoKey | null> {
    if (!jwks || refresh) {
      const { keys } = await getJson((await discover()).jwks_uri);
      if (!Array.isArray(keys)) throw new Error("JWKS has no keys");
      jwks = keys as Jwk[];
    }
    const spec = ALGS[alg];
    const fits = jwks.filter(
      (k) =>
        k.kty === spec.kty &&
        (spec.kty !== "EC" || k.crv === "P-256") &&
        (k.use === undefined || k.use === "sig") &&
        (k.alg === undefined || k.alg === alg),
    );
    // Without a kid, only an unambiguous key will do.
    const k = kid === undefined ? (fits.length === 1 ? fits[0] : undefined) : fits.find((x) => x.kid === kid);
    if (!k) return null;
    const pub = spec.kty === "RSA" ? { kty: "RSA", n: k.n, e: k.e } : { kty: "EC", crv: "P-256", x: k.x, y: k.y };
    return crypto.subtle.importKey("jwk", pub as JsonWebKey, spec.key, false, ["verify"]);
  }

  /** Checks the signature and every claim Binder relies on, and returns the claims. */
  async function verifyIdToken(jwt: string, nonce: string): Promise<Claims> {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("the ID token is not a JWS");
    let header: { alg?: unknown; kid?: unknown };
    let claims: Claims;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    } catch {
      throw new Error("the ID token is not valid JSON");
    }
    const alg = header.alg;
    if (typeof alg !== "string" || !Object.hasOwn(ALGS, alg)) throw new Error(`ID token algorithm ${String(alg)} is not allowed`);
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    // An unknown kid can mean the provider rotated its keys: fetch the JWKS again, once.
    const key = (await signingKey(alg as Alg, kid, false)) ?? (await signingKey(alg as Alg, kid, true));
    if (!key) throw new Error(`no ${alg} key with kid ${kid} in the provider's JWKS`);
    const ok = await crypto.subtle.verify(ALGS[alg as Alg].verify, key, fromB64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw new Error("the ID token signature is not valid");

    if (claims.iss !== cfg.issuer) throw new Error(`ID token issuer ${String(claims.iss)} is not ${cfg.issuer}`);
    const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!aud.includes(cfg.clientId)) throw new Error("the ID token is not for this client (aud)");
    if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== cfg.clientId) throw new Error("the ID token azp is not this client");
    const t = nowSec();
    if (typeof claims.exp !== "number" || claims.exp + SKEW <= t) throw new Error("the ID token has expired");
    if (typeof claims.iat !== "number" || claims.iat - SKEW > t) throw new Error("the ID token iat is in the future");
    if (typeof claims.nonce !== "string" || !sameString(claims.nonce, nonce)) throw new Error("the ID token nonce does not match");
    return claims;
  }

  /** The person's Binder name, if the allowlists let them in. */
  function admit(claims: Claims): string {
    if (claims.email_verified === false || claims.email_verified === "false") throw new Refused("the provider says the email is not verified");
    const raw = typeof claims.email === "string" && claims.email ? claims.email : claims.preferred_username;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("the ID token has no email or preferred_username");
    const user = raw.trim().toLowerCase();
    const g = claims[cfg.groupsClaim];
    const groups = typeof g === "string" ? [g] : Array.isArray(g) ? g.filter((x): x is string => typeof x === "string") : [];
    if (listed(cfg.allowedUsers, user) || groups.some((x) => cfg.allowedGroups.includes(x))) return user;
    throw new Refused(`${user} is not in BINDER_ALLOWED_USERS or BINDER_ALLOWED_GROUPS`);
  }

  function readLogin(cookie: string | null): Login | null {
    const m = cookie?.match(/^([\w-]+)\.([\w-]{43})$/);
    if (!m || !sameString(sign.mac(`oidc-login:${m[1]}`), m[2]!)) return null;
    try {
      const l = JSON.parse(Buffer.from(m[1]!, "base64url").toString()) as Login;
      return l.exp > nowSec() ? l : null;
    } catch {
      return null;
    }
  }

  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/auth/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  /** Set-Cookie that removes the login cookie. */
  const clearLogin = () => cookie(LOGIN_COOKIE, "", 0);

  /** Starts a sign-in: remembers state, nonce, and the PKCE verifier in a signed cookie, then sends the browser to the provider. */
  async function login(rawNext: string | null): Promise<{ location: string; setCookie: string }> {
    const d = await discover();
    const l: Login = { state: random(), nonce: random(), verifier: random(), next: localPath(rawNext, origin), exp: nowSec() + LOGIN_TTL };
    const payload = b64url(JSON.stringify(l));
    const u = new URL(d.authorization_endpoint);
    const p = u.searchParams;
    p.set("response_type", "code");
    p.set("client_id", cfg.clientId);
    p.set("redirect_uri", cfg.redirectUri);
    p.set("scope", cfg.scopes);
    p.set("state", l.state);
    p.set("nonce", l.nonce);
    p.set("code_challenge", createHash("sha256").update(l.verifier).digest("base64url"));
    p.set("code_challenge_method", "S256");
    return { location: u.href, setCookie: cookie(LOGIN_COOKIE, `${payload}.${sign.mac(`oidc-login:${payload}`)}`, LOGIN_TTL) };
  }

  /** Finishes a sign-in from the provider's redirect back to /auth/callback. */
  async function callback(params: URLSearchParams, loginCookie: string | null): Promise<CallbackResult> {
    const l = readLogin(loginCookie);
    if (!l) return { ok: false, reason: "expired", detail: "the login cookie is missing, expired, or not signed by Binder" };
    const state = params.get("state");
    if (!state || !sameString(state, l.state)) return { ok: false, reason: "failed", detail: "state does not match the login cookie" };
    for (const [s, exp] of used) if (exp <= nowSec()) used.delete(s);
    if (used.has(l.state)) return { ok: false, reason: "expired", detail: "this login cookie was already used" };
    used.set(l.state, l.exp);
    const error = params.get("error");
    if (error) return { ok: false, reason: error === "access_denied" ? "denied" : "failed", detail: `the provider answered ${error}: ${params.get("error_description") ?? ""}` };
    const code = params.get("code");
    if (!code) return { ok: false, reason: "failed", detail: "the callback has no code" };
    try {
      const d = await discover();
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: l.verifier });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      // A confidential client authenticates with client_secret_basic; a public client names itself and relies on PKCE.
      if (cfg.clientSecret) headers.authorization = `Basic ${Buffer.from(`${formEncode(cfg.clientId)}:${formEncode(cfg.clientSecret)}`).toString("base64")}`;
      else body.set("client_id", cfg.clientId);
      const tokens = await getJson(d.token_endpoint, { method: "POST", headers, body });
      if (typeof tokens.id_token !== "string") throw new Error("the token response has no id_token");
      return { ok: true, user: admit(await verifyIdToken(tokens.id_token, l.nonce)), next: l.next };
    } catch (e) {
      return { ok: false, reason: e instanceof Refused ? "denied" : "failed", detail: (e as Error).message };
    }
  }

  return { login, callback, clearLogin };
}

export type OidcClient = ReturnType<typeof oidcClient>;
