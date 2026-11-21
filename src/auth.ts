import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseAddress, type Config } from "./config";
import type { Signer } from "./content";
import type { Db, Token } from "./db";

/**
 * Who is making a request. Sources are checked in a fixed order (docs/design.md, "Authentication"):
 *   1. Authorization: Bearer <token>. If present it must be valid; there is no fallthrough.
 *   2. The binder_session cookie, signed, naming a live token.
 *   3. The trusted proxy header, only when configured and only from a trusted peer.
 */
export type Principal = { name: string; scope: "read" | "write"; via: "token" | "session" | "header" | "anonymous" };
export type AuthResult = { ok: true; who: Principal } | { ok: false; status: 401 | 403; error: string };

export const SESSION_COOKIE = "binder_session";
const SESSION_DAYS = 30;
const TOKEN_RE = /^bnd_([0-9a-f]{12})_([\w-]{43})$/;

const hashSecret = (token: string) => createHash("sha256").update(token).digest("hex");

/** Makes a new token. The plaintext is returned once and never stored. */
export function newToken(name: string, scope: "read" | "write", at: string): { token: string; row: Token } {
  const id = randomBytes(6).toString("hex");
  const token = `bnd_${id}_${randomBytes(32).toString("base64url")}`;
  return { token, row: { id, name, scope, hash: hashSecret(token), created_at: at, last_used_at: null, revoked_at: null } };
}

export function authenticator(cfg: Config, db: Db, sign: Signer, now: () => number) {
  const trusted = cfg.trustedProxies.map((p) => parseAddress(p)!);
  const allowed = (login: string) =>
    cfg.allowedUsers.some((u) => u === "*" || u === login || (u.startsWith("*@") && login.endsWith(u.slice(1))));

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

  function fromSession(cookie: string): Token | null {
    const m = cookie.match(/^([0-9a-f]{12})\.(\d{1,12})\.([\w-]{43})$/);
    if (!m || Number(m[2]) <= now() / 1000) return null;
    const want = Buffer.from(sign.mac(`session:${m[1]}:${m[2]}`));
    const got = Buffer.from(m[3]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const t = live(m[1]!);
    return t ? used(t) : null;
  }

  function identify(req: Request, peer: string | null): AuthResult {
    const authz = req.headers.get("authorization");
    if (authz !== null) {
      const t = checkToken(authz.replace(/^Bearer\s+/i, "").trim());
      return t ? { ok: true, who: { name: t.name, scope: t.scope, via: "token" } } : { ok: false, status: 401, error: "invalid or revoked token" };
    }
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie) {
      const t = fromSession(cookie);
      if (t) return { ok: true, who: { name: t.name, scope: t.scope, via: "session" } };
    }
    if (cfg.authHeader) {
      const login = req.headers.get(cfg.authHeader)?.trim().toLowerCase();
      if (login) {
        if (!peer || !trusted.some((match) => match(peer))) {
          console.warn(`ignored ${cfg.authHeader} from untrusted peer ${peer}; see BINDER_TRUSTED_PROXIES`);
        } else if (allowed(login)) {
          return { ok: true, who: { name: login, scope: "write", via: "header" } };
        } else {
          return { ok: false, status: 403, error: `${login} is not in BINDER_ALLOWED_USERS` };
        }
      }
    }
    if (cfg.devAnonymous) return { ok: true, who: { name: "anonymous", scope: "write", via: "anonymous" } };
    return { ok: false, status: 401, error: "sign in: send 'Authorization: Bearer <token>' or open Binder in a browser" };
  }

  return { identify, checkToken, sessionValue };
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
