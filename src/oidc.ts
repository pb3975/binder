// OpenID Connect sign-in: the authorization code flow with PKCE (S256), state, and nonce.
// Binder verifies the ID token itself with Web Crypto. The provider owns passwords and MFA.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { listed } from "./auth";
import { secureEnough, type OidcAuth } from "./config";
import type { Signer } from "./content";

// One login cookie per sign-in, named after its state, so two tabs signing in at once never
// overwrite each other's. 16 base64url characters are 96 bits: names never collide.
const loginCookieName = (state: string) => `binder_login_${state.slice(0, 16)}`;
const LOGIN_TTL = 600; // seconds from "Sign in" to the provider's redirect back
const SKEW = 60; // seconds of clock difference allowed on exp and iat
const JWKS_TTL = 3600_000; // a key the provider dropped stops working within an hour
const JWKS_RETRY = 60_000; // after a bad signature, refetch the JWKS at most once a minute

/** The signature algorithms BINDER_OIDC_SIGNING_ALG may pick. `none` and HS* are absent on purpose. */
const ALGS = {
  RS256: { kty: "RSA", key: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  PS256: { kty: "RSA", key: { name: "RSA-PSS", hash: "SHA-256" }, verify: { name: "RSA-PSS", saltLength: 32 } },
  ES256: { kty: "EC", key: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
} as const;

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
  const redirect = new URL(cfg.redirectUri);
  const origin = redirect.origin;
  const secure = redirect.protocol === "https:";
  const nowSec = () => Math.floor(now() / 1000);
  let discovery: Promise<Discovery> | null = null;
  let jwks: Jwk[] | null = null;
  let jwksAt = 0;
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
        if (typeof v !== "string" || !URL.canParse(v)) throw new Error(`discovery has no usable ${k}`);
        if (!secureEnough(new URL(v), cfg.allowHttp)) throw new Error(`${k} is not https: ${v}`);
      }
      return d as Discovery;
    })().catch((e) => {
      discovery = null;
      throw e;
    });
    return discovery;
  }

  async function signingKey(kid: string | undefined, refresh: boolean): Promise<CryptoKey | null> {
    if (!jwks || refresh || now() - jwksAt >= JWKS_TTL) {
      const { keys } = await getJson((await discover()).jwks_uri);
      if (!Array.isArray(keys)) throw new Error("JWKS has no keys");
      jwks = keys as Jwk[];
      jwksAt = now();
    }
    const alg = cfg.signingAlg;
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
    let header: { alg?: unknown; kid?: unknown; crit?: unknown };
    let claims: Claims;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    } catch {
      throw new Error("the ID token is not valid JSON");
    }
    if (header.alg !== cfg.signingAlg) throw new Error(`ID token algorithm ${String(header.alg)} is not BINDER_OIDC_SIGNING_ALG (${cfg.signingAlg})`);
    // RFC 7515 4.1.11: a crit header names extensions Binder must understand. It understands none.
    if (header.crit !== undefined) throw new Error("the ID token has a crit header Binder does not support");
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const sig = fromB64url(parts[2]!);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = (key: CryptoKey) => crypto.subtle.verify(ALGS[cfg.signingAlg].verify, key, sig, signed);
    // An unknown kid can mean the provider rotated its keys: fetch the JWKS again, once.
    const key = (await signingKey(kid, false)) ?? (await signingKey(kid, true));
    if (!key) throw new Error(`no ${cfg.signingAlg} key with kid ${kid} in the provider's JWKS`);
    if (!(await valid(key))) {
      // A provider can also replace a key and keep its kid. Refetch, at most once a minute.
      const fresh = now() - jwksAt >= JWKS_RETRY ? await signingKey(kid, true) : null;
      if (!fresh || !(await valid(fresh))) throw new Error("the ID token signature is not valid");
    }

    if (claims.iss !== cfg.issuer) throw new Error(`ID token issuer ${String(claims.iss)} is not ${cfg.issuer}`);
    // OIDC Core 3.1.3.7: refuse audiences Binder does not trust. Binder trusts only itself.
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (aud.length !== 1 || aud[0] !== cfg.clientId) throw new Error("the ID token audience is not exactly this client (aud)");
    if (claims.azp !== undefined && claims.azp !== cfg.clientId) throw new Error("the ID token azp is not this client");
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("the ID token has no sub");
    const t = nowSec();
    if (!Number.isFinite(claims.exp) || (claims.exp as number) + SKEW <= t) throw new Error("the ID token has expired, or its exp is not a number");
    if (!Number.isFinite(claims.iat) || (claims.iat as number) - SKEW > t) throw new Error("the ID token iat is in the future, or not a number");
    if (typeof claims.nonce !== "string" || !sameString(claims.nonce, nonce)) throw new Error("the ID token nonce does not match");
    return claims;
  }

  /** The person's Binder name, if the allowlists let them in. */
  function admit(claims: Claims): string {
    if (claims.email_verified === false || claims.email_verified === "false") throw new Refused("the provider says the email is not verified");
    // Google Workspace signs the account's domain into `hd`. An email suffix alone proves nothing.
    if (cfg.hostedDomain && (typeof claims.hd !== "string" || claims.hd.toLowerCase() !== cfg.hostedDomain))
      throw new Refused(`the ID token hd (${String(claims.hd)}) is not BINDER_OIDC_HOSTED_DOMAIN`);
    const raw = typeof claims.email === "string" && claims.email ? claims.email : claims.preferred_username;
    if (typeof raw !== "string" || !raw.trim()) throw new Error("the ID token has no email or preferred_username");
    const user = raw.trim().toLowerCase();
    const g = claims[cfg.groupsClaim];
    const groups = typeof g === "string" ? [g] : Array.isArray(g) ? g.filter((x): x is string => typeof x === "string") : [];
    if (listed(cfg.allowedUsers, user) || groups.some((x) => cfg.allowedGroups.includes(x))) return user;
    throw new Refused(`${user} is not in BINDER_ALLOWED_USERS or BINDER_ALLOWED_GROUPS`);
  }

  function readLogin(cookie: string | null | undefined): Login | null {
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
    `${name}=${value}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

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
    if (cfg.hostedDomain) p.set("hd", cfg.hostedDomain); // Google's account chooser hint; the hd claim is what counts
    return { location: u.href, setCookie: cookie(loginCookieName(l.state), `${payload}.${sign.mac(`oidc-login:${payload}`)}`, LOGIN_TTL) };
  }

  /**
   * Finishes a sign-in from the provider's redirect back to /auth/callback. `cookies` reads the
   * request's cookies by name. The result says which login cookie to clear; other tabs' stay.
   */
  async function callback(params: URLSearchParams, cookies: (name: string) => string | null): Promise<CallbackResult & { clear?: string }> {
    const state = params.get("state");
    if (!state || !/^[\w-]{16,}$/.test(state)) return { ok: false, reason: "failed", detail: "the callback has no usable state" };
    const clear = cookie(loginCookieName(state), "", 0);
    const l = readLogin(cookies(loginCookieName(state)));
    if (!l) return { ok: false, reason: "expired", detail: "the login cookie is missing, expired, or not signed by Binder", clear };
    if (!sameString(state, l.state)) return { ok: false, reason: "failed", detail: "state does not match the login cookie", clear };
    return { ...(await finish(params, l)), clear };
  }

  async function finish(params: URLSearchParams, l: Login): Promise<CallbackResult> {
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
      // RFC 6749 5.1: a successful response has an access token and its type.
      if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("the token response has no access_token");
      if (typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer") throw new Error(`the token type is ${String(tokens.token_type)}, not Bearer`);
      return { ok: true, user: admit(await verifyIdToken(tokens.id_token, l.nonce)), next: l.next };
    } catch (e) {
      return { ok: false, reason: e instanceof Refused ? "denied" : "failed", detail: (e as Error).message };
    }
  }

  return { login, callback };
}

export type OidcClient = ReturnType<typeof oidcClient>;
