// OIDC sign-in against a fake provider with real keys. Every check Binder makes on the
// login cookie and the ID token has a case here that must fail. Synthetic users only.
import { afterAll, describe, expect, test } from "bun:test";
import { run } from "../src/cli";
import type { OidcAuth } from "../src/config";
import { fakeProvider } from "./fake-oidc";
import { form, startBinder } from "./helpers";

const PUBLIC = "https://binder.example.com";
const CLIENT = "binder-test";
const SECRET = "synthetic-client-secret";
const idp = await fakeProvider({ clientId: CLIENT, clientSecret: SECRET });
const oidc = (over: Partial<OidcAuth> = {}): OidcAuth => ({
  mode: "oidc", issuer: idp.issuer, clientId: CLIENT, clientSecret: SECRET, scopes: "openid email profile",
  label: "Sign in with Example SSO", allowedUsers: ["alice@example.com", "*@team.example"], allowedGroups: ["binder-users"],
  groupsClaim: "groups", redirectUri: `${PUBLIC}/auth/callback`, allowHttp: false, signingAlg: "RS256", hostedDomain: null, ...over,
});

let clock = Date.parse("2026-11-21T09:00:00Z");
const now = () => clock;
const sec = () => Math.floor(clock / 1000);
const b = startBinder({ publicUrl: PUBLIC, auth: oidc() }, { now });
afterAll(() => {
  b.stop();
  idp.stop();
});

const cookieOf = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
/** Each sign-in has its own login cookie, named after its state. */
const loginCookieOf = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith("binder_login_"));
const pair = (setCookie: string | undefined) => setCookie!.split(";")[0]!;

/** Step 1: the browser asks Binder to sign in and is sent to the provider. */
async function begin(next = "/a/report", base = b.base) {
  const r = await fetch(`${base}/auth/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get("location")!);
  const p = to.searchParams;
  return { r, to, cookie: pair(loginCookieOf(r)), state: p.get("state")!, nonce: p.get("nonce")!, challenge: p.get("code_challenge")! };
}
type Begun = Awaited<ReturnType<typeof begin>>;

const claimsFor = (l: Begun, over: Record<string, unknown> = {}) => ({
  iss: idp.issuer, aud: CLIENT, sub: "user-1", email: "alice@example.com", email_verified: true,
  iat: sec(), exp: sec() + 300, nonce: l.nonce, ...over,
});

/** Step 2: the provider sends the browser back with a code for this ID token. */
async function finish(l: Begun, idToken: string, o: { state?: string; cookie?: string; base?: string } = {}) {
  const code = idp.issue(l.challenge, `${PUBLIC}/auth/callback`, idToken);
  const q = new URLSearchParams({ code, state: o.state ?? l.state });
  return fetch(`${o.base ?? b.base}/auth/callback?${q}`, { headers: { cookie: o.cookie ?? l.cookie }, redirect: "manual" });
}
async function signIn(over: Record<string, unknown> = {}, signOpts: Parameters<typeof idp.sign>[1] = {}) {
  const l = await begin();
  return finish(l, await idp.sign(claimsFor(l, over), signOpts));
}
const outcome = (r: Response) => r.headers.get("location");
const session = async (cookie: string, base = b.base) => {
  const r = await fetch(`${base}/api/session`, { headers: { cookie } });
  return r.ok ? ((await r.json()) as { name: string; via: string; scope: string }) : r.status;
};

describe("sign-in", () => {
  test("login sends the browser to the provider with PKCE, state, and nonce, and a short-lived Lax cookie", async () => {
    const l = await begin();
    const p = l.to.searchParams;
    expect(l.to.origin + l.to.pathname).toBe(`${idp.issuer}/authorize`);
    expect(p.get("prompt")).toBe("login"); // the endpoint's own query survives
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(CLIENT);
    expect(p.get("redirect_uri")).toBe(`${PUBLIC}/auth/callback`); // from BINDER_PUBLIC_URL, never Host
    expect(p.get("scope")).toBe("openid email profile");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(l.state.length).toBeGreaterThanOrEqual(43);
    expect(l.nonce.length).toBeGreaterThanOrEqual(43);
    const c = loginCookieOf(l.r)!;
    for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/auth/callback", "Max-Age=600", "Secure"]) expect(c).toContain(attr);
    expect(c.startsWith(`binder_login_${l.state.slice(0, 16)}=`)).toBe(true);
  });

  test("a valid RS256 ID token signs alice in for 8 hours and returns her to where she was", async () => {
    const r = await signIn();
    expect(r.status).toBe(302);
    expect(outcome(r)).toBe("/a/report");
    const s = cookieOf(r, "binder_session")!;
    for (const attr of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=28800"]) expect(s).toContain(attr);
    expect(s).toMatch(/^binder_session=o\./); // never mistaken for a token session
    expect(loginCookieOf(r)).toContain("Max-Age=0"); // the login cookie is spent
    expect(loginCookieOf(r)).toContain("Path=/auth/callback");
    expect(idp.state.lastToken!.authorization).toStartWith("Basic "); // client_secret_basic
    expect(idp.state.lastToken!.form.get("client_secret")).toBeNull();

    const cookie = pair(s);
    expect(await session(cookie)).toEqual({ name: "alice@example.com", scope: "write", via: "oidc" });
    const pub = await fetch(`${b.base}/api/artifacts`, { method: "POST", headers: { cookie, "x-binder": "1" }, body: form({ id: "sso-1" }, [["index.html", "x"]]) });
    expect(pub.status).toBe(201);
    expect(await pub.json()).toMatchObject({ published_by: "alice@example.com" });
  });

  test("a token without a kid works when only one key fits", async () => {
    expect(outcome(await signIn({}, { kid: null }))).toBe("/a/report");
  });

  test("BINDER_OIDC_SIGNING_ALG picks the one algorithm accepted: PS256 or ES256 instead of RS256", async () => {
    for (const [alg, key] of [["PS256", "ps"], ["ES256", "es"]] as const) {
      const other = startBinder({ publicUrl: PUBLIC, auth: oidc({ signingAlg: alg }) }, { now });
      try {
        const l = await begin("/", other.base);
        expect(outcome(await finish(l, await idp.sign(claimsFor(l), { key }), { base: other.base }))).toBe("/");
        const rs = await begin("/", other.base);
        expect(outcome(await finish(rs, await idp.sign(claimsFor(rs)), { base: other.base }))).toBe("/?signin=failed");
      } finally {
        other.stop();
      }
    }
    // The default instance takes RS256 only.
    expect(outcome(await signIn({}, { key: "es" }))).toBe("/?signin=failed");
    expect(outcome(await signIn({}, { key: "ps" }))).toBe("/?signin=failed");
  });

  test("two tabs signing in at once each keep their own login cookie", async () => {
    const a = await begin("/a/one");
    const b2 = await begin("/a/two");
    expect(a.cookie.split("=")[0]).not.toBe(b2.cookie.split("=")[0]);
    const rb = await finish(b2, await idp.sign(claimsFor(b2)), { cookie: `${a.cookie}; ${b2.cookie}` });
    expect(outcome(rb)).toBe("/a/two");
    const cleared = rb.headers.getSetCookie().filter((c) => c.startsWith("binder_login_"));
    expect(cleared).toEqual([expect.stringMatching(new RegExp(`^${b2.cookie.split("=")[0]}=;`))]); // only B's
    expect(outcome(await finish(a, await idp.sign(claimsFor(a)), { cookie: a.cookie }))).toBe("/a/one");
  });

  test("the session ends after 8 hours, by the injected clock", async () => {
    const cookie = pair(cookieOf(await signIn(), "binder_session"));
    const start = clock;
    try {
      clock = start + 8 * 3600_000 - 1000;
      expect(await session(cookie)).toMatchObject({ via: "oidc" });
      clock = start + 8 * 3600_000 + 1000;
      expect(await session(cookie)).toBe(401);
    } finally {
      clock = start;
    }
  });

  test("sign-out clears the session cookie", async () => {
    const r = await fetch(`${b.base}/api/session`, { method: "DELETE", headers: { "x-binder": "1" } });
    expect(cookieOf(r, "binder_session")).toMatch(/^binder_session=; .*Max-Age=0/);
  });

  test("a group in the groups claim admits someone not on the email list", async () => {
    expect(outcome(await signIn({ email: "carol@other.example", groups: ["staff", "binder-users"] }))).toBe("/a/report");
    expect(outcome(await signIn({ email: "carol@other.example", groups: ["staff"] }))).toBe("/?signin=denied");
  });

  test("*@domain admits the whole domain, and the email is matched lowercase", async () => {
    const r = await signIn({ email: "Dana@Team.Example" });
    expect(await session(pair(cookieOf(r, "binder_session")))).toMatchObject({ name: "dana@team.example" });
  });

  test("without an email, preferred_username is the name and is matched instead", async () => {
    expect(outcome(await signIn({ email: undefined, preferred_username: "alice@example.com" }))).toBe("/a/report");
    expect(outcome(await signIn({ email: undefined, preferred_username: "mallory" }))).toBe("/?signin=denied");
  });

  test("the signed-out session check tells the UI to offer SSO", async () => {
    const r = await fetch(`${b.base}/api/session`);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ auth: "oidc", label: "Sign in with Example SSO" });
  });

  test("tokens still work, for agents and for the paste-a-token sign-in", async () => {
    const out: string[] = [];
    expect(run(["token", "create", "--name", "agent"], { BINDER_DATA_DIR: b.dataDir }, (s) => out.push(s))).toBe(0);
    const pub = await fetch(`${b.base}/api/artifacts`, { method: "POST", headers: { authorization: `Bearer ${out[0]}`, "x-binder": "1" }, body: form({ id: "agent-1" }, [["index.html", "x"]]) });
    expect(await pub.json()).toMatchObject({ published_by: "agent" });
    const s = await fetch(`${b.base}/api/session`, { method: "POST", headers: { "x-binder": "1" }, body: JSON.stringify({ token: out[0] }) });
    expect(await session(pair(cookieOf(s, "binder_session")))).toMatchObject({ name: "agent", via: "session" });
  });
});

describe("refused sign-ins", () => {
  test("a state that does not match the login cookie", async () => {
    const l = await begin();
    // No login cookie carries this state's name.
    expect(outcome(await finish(l, await idp.sign(claimsFor(l)), { state: "x".repeat(43) }))).toBe("/?signin=expired");
    // The name matches, but the full state in the signed cookie does not.
    expect(outcome(await finish(l, await idp.sign(claimsFor(l)), { state: l.state.slice(0, 16) + "x".repeat(27) }))).toBe("/?signin=failed");
    expect(outcome(await finish(l, await idp.sign(claimsFor(l)), { state: "" }))).toBe("/?signin=failed");
  });

  test("a login cookie used twice, expired, tampered with, or missing", async () => {
    const l = await begin();
    expect(outcome(await finish(l, await idp.sign(claimsFor(l))))).toBe("/a/report");
    expect(outcome(await finish(l, await idp.sign(claimsFor(l))))).toBe("/?signin=expired");

    const late = await begin();
    clock += 601_000;
    try {
      expect(outcome(await finish(late, await idp.sign(claimsFor(late))))).toBe("/?signin=expired");
    } finally {
      clock -= 601_000;
    }

    const t = await begin();
    const [name, value] = t.cookie.split("=");
    const [payload, mac] = value!.split(".");
    const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
    forged.next = "https://evil.example/";
    const bad = `${name}=${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`;
    expect(outcome(await finish(t, await idp.sign(claimsFor(t)), { cookie: bad }))).toBe("/?signin=expired");
    expect(outcome(await finish(t, await idp.sign(claimsFor(t)), { cookie: "" }))).toBe("/?signin=expired");
    // Another tab's valid cookie does not stand in for this one.
    const other = await begin();
    expect(outcome(await finish(t, await idp.sign(claimsFor(t)), { cookie: other.cookie }))).toBe("/?signin=expired");
  });

  test("the provider's error=access_denied", async () => {
    const l = await begin();
    const r = await fetch(`${b.base}/auth/callback?error=access_denied&state=${l.state}`, { headers: { cookie: l.cookie }, redirect: "manual" });
    expect(outcome(r)).toBe("/?signin=denied");
    expect(cookieOf(r, "binder_session")).toBeUndefined();
  });

  const cases: [string, Record<string, unknown>, Parameters<typeof idp.sign>[1]?][] = [
    ["a wrong nonce", { nonce: "n".repeat(43) }],
    ["a wrong audience", { aud: "another-client" }],
    ["several audiences without azp", { aud: [CLIENT, "another-client"] }],
    ["several audiences even with azp for this client", { aud: [CLIENT, "api"], azp: CLIENT }],
    ["an aud entry that is not a string", { aud: [CLIENT, 7] }],
    ["no sub", { sub: undefined }],
    ["an empty sub", { sub: "" }],
    ["an exp that is not a number", { exp: String(Math.floor(Date.parse("2026-11-21T09:00:00Z") / 1000) + 300) }],
    ["an azp for another client", { azp: "another-client" }],
    ["a wrong issuer", { iss: "https://evil.example" }],
    ["an issuer that differs only by a trailing slash", { iss: `${idp.issuer}/` }],
    ["a token expired beyond the 60 s skew", { exp: Math.floor(Date.parse("2026-11-21T09:00:00Z") / 1000) - 61 }],
    ["an iat beyond the 60 s skew in the future", { iat: Math.floor(Date.parse("2026-11-21T09:00:00Z") / 1000) + 120 }],
    ["alg none", {}, { alg: "none" }],
    ["HS256 signed with the client secret", {}, { alg: "HS256" }],
    ["an RS256 header on an EC key's signature", {}, { key: "es", alg: "RS256", kid: "es-1" }],
    ["a crit header Binder does not understand", {}, { header: { crit: ["exp"] } }],
  ];
  for (const [name, over, signOpts] of cases)
    test(`${name}`, async () => {
      const r = await signIn(over, signOpts);
      expect(outcome(r)).toBe("/?signin=failed");
      expect(cookieOf(r, "binder_session")).toBeUndefined();
    });

  test("aud as a one-entry list, azp for this client, and exp within the skew are accepted", async () => {
    expect(outcome(await signIn({ aud: [CLIENT], azp: CLIENT, exp: sec() - 30 }))).toBe("/a/report");
  });

  test("an exp or iat that is not finite (1e400 parses as Infinity)", async () => {
    for (const field of ["exp", "iat"]) {
      const l = await begin();
      const raw = JSON.stringify(claimsFor(l, { [field]: 0 })).replace(`"${field}":0`, `"${field}":1e400`);
      expect(outcome(await finish(l, await idp.sign(raw)))).toBe("/?signin=failed");
    }
  });

  test("a token response without access_token or a Bearer token_type (RFC 6749 5.1)", async () => {
    const complete = idp.state.tokenResponse;
    try {
      for (const make of [
        (id: string) => ({ id_token: id }),
        (id: string) => ({ id_token: id, token_type: "Bearer" }),
        (id: string) => ({ id_token: id, access_token: "a" }),
        (id: string) => ({ id_token: id, access_token: "a", token_type: "MAC" }),
        (id: string) => ({ id_token: id, access_token: "", token_type: "Bearer" }),
      ]) {
        idp.state.tokenResponse = make;
        expect(outcome(await signIn())).toBe("/?signin=failed");
      }
      idp.state.tokenResponse = (id) => ({ id_token: id, access_token: "a", token_type: "bearer" }); // case-insensitive
      expect(outcome(await signIn())).toBe("/a/report");
    } finally {
      idp.state.tokenResponse = complete;
    }
  });

  test("a signature that does not cover the claims", async () => {
    const l = await begin();
    const real = await idp.sign(claimsFor(l, { email: "mallory@example.org" }));
    const [h, , sig] = real.split(".");
    const swapped = Buffer.from(JSON.stringify(claimsFor(l))).toString("base64url"); // alice's claims, mallory's signature
    const r = await finish(l, `${h}.${swapped}.${sig}`);
    expect(outcome(r)).toBe("/?signin=failed");
    expect(cookieOf(r, "binder_session")).toBeUndefined();
  });

  test("an email that is not allowed, or not verified", async () => {
    expect(outcome(await signIn({ email: "mallory@example.org" }))).toBe("/?signin=denied");
    expect(outcome(await signIn({ email_verified: false }))).toBe("/?signin=denied");
  });

  test("a next that leaves Binder becomes /", async () => {
    for (const next of ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "/\n/evil.example/x", "https://evil.example/x", "evil",
      "/a/..//evil.example/x", "/a/%2e%2e//evil.example/x", "/a/b/../..//evil.example/x", "/a/..\\/evil.example/x"]) {
      const l = await begin(next);
      expect(outcome(await finish(l, await idp.sign(claimsFor(l))))).toBe("/");
    }
    // Encoded line breaks stay encoded in the Location header.
    const l = await begin("/a/x%0d%0aSet-Cookie:%20y=1");
    const r = await finish(l, await idp.sign(claimsFor(l)));
    expect(outcome(r)).toBe("/a/x%0d%0aSet-Cookie:%20y=1");
    expect(r.headers.getSetCookie().some((c) => c.startsWith("y="))).toBe(false);
  });
});

describe("keys", () => {
  test("an unknown kid fetches the JWKS once more, then works after the provider rotates", async () => {
    const before = idp.state.jwksHits;
    expect(outcome(await signIn({}, { key: "rotated" }))).toBe("/?signin=failed");
    expect(idp.state.jwksHits).toBe(before + 1); // exactly one refetch, no loop
    idp.rotate();
    expect(outcome(await signIn({}, { key: "rotated" }))).toBe("/a/report");
    expect(idp.state.jwksHits).toBe(before + 2);
    expect(outcome(await signIn({}, { key: "rotated" }))).toBe("/a/report");
    expect(idp.state.jwksHits).toBe(before + 2); // cached again
    expect(outcome(await signIn({}, { kid: null }))).toBe("/?signin=failed"); // two RSA keys now: ambiguous
  });

  test("a key replaced under the same kid works after one rate-limited refetch", async () => {
    const start = clock;
    try {
      await idp.rekey();
      const before = idp.state.jwksHits;
      expect(outcome(await signIn())).toBe("/?signin=failed"); // the cached key no longer matches
      expect(idp.state.jwksHits).toBe(before); // fetched moments ago: no refetch yet
      clock += 61_000;
      expect(outcome(await signIn())).toBe("/a/report");
      expect(idp.state.jwksHits).toBe(before + 1);
      expect(outcome(await signIn())).toBe("/a/report");
      expect(idp.state.jwksHits).toBe(before + 1);
    } finally {
      clock = start;
    }
  });

  test("the JWKS cache expires after an hour", async () => {
    const start = clock;
    try {
      const before = idp.state.jwksHits;
      clock += 3700_000; // over an hour after the last fetch, which the test above made at +61 s
      expect(outcome(await signIn())).toBe("/a/report");
      expect(idp.state.jwksHits).toBe(before + 1);
    } finally {
      clock = start;
    }
  });
});

describe("configuration changes end SSO sessions", () => {
  test("a changed allowlist or another mode no longer accepts the old cookie", async () => {
    const one = startBinder({ publicUrl: PUBLIC, auth: oidc() }, { now });
    const l = await begin("/", one.base);
    const cookie = pair(cookieOf(await finish(l, await idp.sign(claimsFor(l)), { base: one.base }), "binder_session"));
    expect(await session(cookie, one.base)).toMatchObject({ via: "oidc" });
    one.stop(true);
    const narrower = startBinder({ publicUrl: PUBLIC, auth: oidc({ allowedUsers: ["someone@example.com"] }) }, { now, dataDir: one.dataDir });
    expect(await session(cookie, narrower.base)).toBe(401);
    narrower.stop(true);
    const tokenMode = startBinder({ publicUrl: PUBLIC, auth: { mode: "token" } }, { now, dataDir: one.dataDir });
    expect(await session(cookie, tokenMode.base)).toBe(401);
    tokenMode.stop();
  });
});

describe("other provider setups", () => {
  test("a public client sends client_id and the PKCE verifier, and no secret", async () => {
    const pubIdp = await fakeProvider({ clientId: CLIENT, clientSecret: null });
    const p = startBinder({ publicUrl: PUBLIC, auth: oidc({ issuer: pubIdp.issuer, clientSecret: null }) }, { now });
    try {
      const r = await fetch(`${p.base}/auth/login`, { redirect: "manual" });
      const to = new URL(r.headers.get("location")!);
      const l = { cookie: pair(loginCookieOf(r)), state: to.searchParams.get("state")!, nonce: to.searchParams.get("nonce")!, challenge: to.searchParams.get("code_challenge")! };
      const code = pubIdp.issue(l.challenge, `${PUBLIC}/auth/callback`, await pubIdp.sign({ iss: pubIdp.issuer, aud: CLIENT, sub: "user-1", email: "alice@example.com", iat: sec(), exp: sec() + 60, nonce: l.nonce }));
      const cb = await fetch(`${p.base}/auth/callback?code=${code}&state=${l.state}`, { headers: { cookie: l.cookie }, redirect: "manual" });
      expect(outcome(cb)).toBe("/");
      expect(pubIdp.state.lastToken!.authorization).toBeNull();
      expect(pubIdp.state.lastToken!.form.get("client_id")).toBe(CLIENT);
      expect(pubIdp.state.lastToken!.form.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
    } finally {
      p.stop();
      pubIdp.stop();
    }
  });

  test("a provider whose discovered issuer differs is refused before any redirect", async () => {
    const other = await fakeProvider({ clientId: CLIENT, clientSecret: SECRET });
    other.state.advertisedIssuer = "https://evil.example";
    const p = startBinder({ publicUrl: PUBLIC, auth: oidc({ issuer: other.issuer }) });
    try {
      const r = await fetch(`${p.base}/auth/login`, { redirect: "manual" });
      expect(r.headers.get("location")).toBe("/?signin=failed");
      expect(loginCookieOf(r)).toBeUndefined();
    } finally {
      p.stop();
      other.stop();
    }
  });

  test("discovered endpoints must be https, unless they are on loopback", async () => {
    const other = await fakeProvider({ clientId: CLIENT, clientSecret: SECRET });
    other.state.endpointBase = "http://idp.example";
    const p = startBinder({ publicUrl: PUBLIC, auth: oidc({ issuer: other.issuer }) });
    try {
      expect((await fetch(`${p.base}/auth/login`, { redirect: "manual" })).headers.get("location")).toBe("/?signin=failed");
    } finally {
      p.stop();
      other.stop();
    }
  });

  test("BINDER_OIDC_HOSTED_DOMAIN requires the signed hd claim, as Google Workspace sends it", async () => {
    const g = startBinder({ publicUrl: PUBLIC, auth: oidc({ allowedUsers: ["*"], allowedGroups: [], hostedDomain: "example.com" }) }, { now });
    try {
      const go = async (over: Record<string, unknown>) => {
        const l = await begin("/", g.base);
        expect(l.to.searchParams.get("hd")).toBe("example.com"); // a hint for Google's account chooser
        return outcome(await finish(l, await idp.sign(claimsFor(l, over)), { base: g.base }));
      };
      expect(await go({ hd: "example.com" })).toBe("/");
      expect(await go({ hd: "Example.COM" })).toBe("/");
      expect(await go({})).toBe("/?signin=denied"); // a personal account has no hd, whatever its email says
      expect(await go({ hd: "evil.example", email: "alice@example.com" })).toBe("/?signin=denied");
    } finally {
      g.stop();
    }
  });

  test("the /auth/ routes do not exist in other modes", async () => {
    const t = startBinder({ auth: { mode: "token" } });
    try {
      expect((await fetch(`${t.base}/auth/login`, { redirect: "manual" })).status).toBe(404);
    } finally {
      t.stop();
    }
  });
});
