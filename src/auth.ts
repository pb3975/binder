import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseAddress, type Config } from "./config";
import type { Signer } from "./content";
import type { Db, Token } from "./db";

/**
 * Who is making a request. Sources are checked in a fixed order (docs/design.md, "Authentication"):
 *   1. Authorization: Bearer <token>. If present it must be valid; there is no fallthrough.
 *   2. The binder_session cookie, signed: one naming a live token, or (oidc mode only) an SSO sign-in.
 *   3. Header mode: the trusted proxy header, only from a trusted peer.
 *   4. None mode: the anonymous writer.
 */
export type Principal = { name: string; scope: "read" | "write"; via: "token" | "session" | "oidc" | "header" | "none" };
export type AuthResult = { ok: true; who: Principal } | { ok: false; status: 401 | 403; error: string };

export const SESSION_COOKIE = "binder_session";
const SESSION_DAYS = 30;
// Short, so removing someone at the provider ends their access within a working day.
const OIDC_SESSION_HOURS = 8;
const TOKEN_RE = /^bnd_([0-9a-f]{12})_([\w-]{43})$/;

/** Logins on an allowlist: exact, `*@domain`, or `*`. Both sides are lowercase. */
export const listed = (list: string[], login: string) =>
  list.some((u) => u === "*" || u === login || (u.startsWith("*@") && login.endsWith(u.slice(1))));

const hashSecret = (token: string) => createHash("sha256").update(token).digest("hex");

/** Makes a new token. The plaintext is returned once and never stored. */
export function newToken(name: string, scope: "read" | "write", at: string): { token: string; row: Token } {
  const id = randomBytes(6).toString("hex");
  const token = `bnd_${id}_${randomBytes(32).toString("base64url")}`;
  return { token, row: { id, name, scope, hash: hashSecret(token), created_at: at, last_used_at: null, revoked_at: null } };
}

export function authenticator(cfg: Config, db: Db, sign: Signer, now: () => number) {
  const a = cfg.auth;
  const trusted = a.mode === "header" ? a.trustedProxies.map((p) => parseAddress(p)!) : [];
  // SSO sessions are signed over the provider and allowlist settings, so changing either ends them all.
  const oidcScope =
    a.mode === "oidc"
      ? hashSecret(JSON.stringify([a.issuer, a.clientId, a.allowedUsers, a.allowedGroups, a.groupsClaim])).slice(0, 16)
      : null;

  const live = (id: string) => {
    const t = db.tokens.get(id);
    return t && !t.revoked_at ? t : null;
  };
  function used(t: Token): Token {
    // Record use at most every 5 minutes, so reads do not write on every request.
    if (!t.last_used_at || now() - Date.parse(t.last_used_at) > 300_000) db.tokens.touch(t.id, new Date(now()).toISOString());
    return t;
  }

  /** Validates a plaintext token. */
  function checkToken(token: string): Token | null {
    const m = token.match(TOKEN_RE);
    const t = m ? live(m[1]!) : null;
    if (!t) return null;
    const ok = timingSafeEqual(Buffer.from(t.hash, "hex"), Buffer.from(hashSecret(token), "hex"));
    return ok ? used(t) : null;
  }

  function sessionValue(t: Token): { value: string; maxAge: number } {
    const exp = Math.floor(now() / 1000) + SESSION_DAYS * 86400;
    return { value: `${t.id}.${exp}.${sign.mac(`session:${t.id}:${exp}`)}`, maxAge: SESSION_DAYS * 86400 };
  }

  const macOk = (purpose: string, got: string) => {
    const want = Buffer.from(sign.mac(purpose));
    const g = Buffer.from(got);
    return want.length === g.length && timingSafeEqual(want, g);
  };

  /** An SSO session: `o.<base64url name>.<expiry>.<mac>`, a format a token session never has. */
  function oidcSessionValue(name: string): { value: string; maxAge: number } {
    const maxAge = OIDC_SESSION_HOURS * 3600;
    const n = Buffer.from(name).toString("base64url");
    const exp = Math.floor(now() / 1000) + maxAge;
    return { value: `o.${n}.${exp}.${sign.mac(`oidc-session:${oidcScope}:${n}:${exp}`)}`, maxAge };
  }

  function fromSession(cookie: string): Principal | null {
    const o = cookie.match(/^o\.([\w-]{1,400})\.(\d{1,12})\.([\w-]{43})$/);
    if (o) {
      if (!oidcScope || Number(o[2]) <= now() / 1000 || !macOk(`oidc-session:${oidcScope}:${o[1]}:${o[2]}`, o[3]!)) return null;
      return { name: Buffer.from(o[1]!, "base64url").toString(), scope: "write", via: "oidc" };
    }
    const m = cookie.match(/^([0-9a-f]{12})\.(\d{1,12})\.([\w-]{43})$/);
    if (!m || Number(m[2]) <= now() / 1000 || !macOk(`session:${m[1]}:${m[2]}`, m[3]!)) return null;
    const t = live(m[1]!);
    return t ? { name: used(t).name, scope: t.scope, via: "session" } : null;
  }

  function identify(req: Request, peer: string | null): AuthResult {
    const authz = req.headers.get("authorization");
    if (authz !== null) {
      const t = checkToken(authz.replace(/^Bearer\s+/i, "").trim());
      return t ? { ok: true, who: { name: t.name, scope: t.scope, via: "token" } } : { ok: false, status: 401, error: "invalid or revoked token" };
    }
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie) {
      const who = fromSession(cookie);
      if (who) return { ok: true, who };
    }
    if (a.mode === "header") {
      const login = req.headers.get(a.header)?.trim().toLowerCase();
      if (login) {
        if (!peer || !trusted.some((match) => match(peer))) {
          console.warn(`ignored ${a.header} from untrusted peer ${peer}; see BINDER_TRUSTED_PROXIES`);
        } else if (listed(a.allowedUsers, login)) {
          return { ok: true, who: { name: login, scope: "write", via: "header" } };
        } else {
          return { ok: false, status: 403, error: `${login} is not in BINDER_ALLOWED_USERS` };
        }
      }
    }
    if (a.mode === "none") return { ok: true, who: { name: "anonymous", scope: "write", via: "none" } };
    return { ok: false, status: 401, error: "sign in: send 'Authorization: Bearer <token>' or open Binder in a browser" };
  }

  return { identify, checkToken, sessionValue, oidcSessionValue };
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
