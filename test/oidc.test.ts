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
  groupsClaim: "groups", redirectUri: `${PUBLIC}/auth/callback`, ...over,
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
const pair = (setCookie: string | undefined) => setCookie!.split(";")[0]!;

/** Step 1: the browser asks Binder to sign in and is sent to the provider. */
async function begin(next = "/a/report", base = b.base) {
  const r = await fetch(`${base}/auth/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get("location")!);
  const p = to.searchParams;
  return { r, to, cookie: pair(cookieOf(r, "binder_login")), state: p.get("state")!, nonce: p.get("nonce")!, challenge: p.get("code_challenge")! };
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
    const c = cookieOf(l.r, "binder_login")!;
    for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/auth/", "Max-Age=600", "Secure"]) expect(c).toContain(attr);
  });

  test("a valid RS256 ID token signs alice in for 8 hours and returns her to where she was", async () => {
    const r = await signIn();
    expect(r.status).toBe(302);
    expect(outcome(r)).toBe("/a/report");
    const s = cookieOf(r, "binder_session")!;
    for (const attr of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=28800"]) expect(s).toContain(attr);
    expect(s).toMatch(/^binder_session=o\./); // never mistaken for a token session
    expect(cookieOf(r, "binder_login")).toContain("Max-Age=0"); // the login cookie is spent
    expect(cookieOf(r, "binder_login")).toContain("Path=/auth/");
    expect(idp.state.lastToken!.authorization).toStartWith("Basic "); // client_secret_basic
    expect(idp.state.lastToken!.form.get("client_secret")).toBeNull();

    const cookie = pair(s);
    expect(await session(cookie)).toEqual({ name: "alice@example.com", scope: "write", via: "oidc" });
    const pub = await fetch(`${b.base}/api/artifacts`, { method: "POST", headers: { cookie, "x-binder": "1" }, body: form({ id: "sso-1" }, [["index.html", "x"]]) });
    expect(pub.status).toBe(201);
    expect(await pub.json()).toMatchObject({ published_by: "alice@example.com" });
  });

  test("PS256 and ES256 tokens work too, and so does a token without a kid when only one key fits", async () => {
    expect(outcome(await signIn({}, { key: "ps" }))).toBe("/a/report");
    expect(outcome(await signIn({}, { key: "es" }))).toBe("/a/report");
    expect(outcome(await signIn({}, { kid: null }))).toBe("/a/report");
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
    expect(outcome(await finish(l, await idp.sign(claimsFor(l)), { state: "x".repeat(43) }))).toBe("/?signin=failed");
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
    const [payload, mac] = t.cookie.slice("binder_login=".length).split(".");
    const forged = JSON.parse(Buffer.from(payload!, "base64url").toString());
    forged.next = "https://evil.example/";
    const bad = `binder_login=${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`;
    expect(outcome(await finish(t, await idp.sign(claimsFor(t)), { cookie: bad }))).toBe("/?signin=expired");
    expect(outcome(await finish(t, await idp.sign(claimsFor(t)), { cookie: "" }))).toBe("/?signin=expired");
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
    ["an azp for another client", { azp: "another-client" }],
    ["a wrong issuer", { iss: "https://evil.example" }],
    ["an issuer that differs only by a trailing slash", { iss: `${idp.issuer}/` }],
    ["a token expired beyond the 60 s skew", { exp: Math.floor(Date.parse("2026-11-21T09:00:00Z") / 1000) - 61 }],
    ["an iat beyond the 60 s skew in the future", { iat: Math.floor(Date.parse("2026-11-21T09:00:00Z") / 1000) + 120 }],
    ["alg none", {}, { alg: "none" }],
    ["HS256 signed with the client secret", {}, { alg: "HS256" }],
    ["an RS256 header on an EC key's signature", {}, { key: "es", alg: "RS256", kid: "es-1" }],
  ];
  for (const [name, over, signOpts] of cases)
    test(`${name}`, async () => {
      const r = await signIn(over, signOpts);
      expect(outcome(r)).toBe("/?signin=failed");
      expect(cookieOf(r, "binder_session")).toBeUndefined();
    });

  test("several audiences with azp for this client, and exp within the skew, are accepted", async () => {
    expect(outcome(await signIn({ aud: [CLIENT, "api"], azp: CLIENT, exp: sec() - 30 }))).toBe("/a/report");
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
    for (const next of ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "/\n/evil.example/x", "https://evil.example/x", "evil"]) {
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
      const l = { cookie: pair(cookieOf(r, "binder_login")), state: to.searchParams.get("state")!, nonce: to.searchParams.get("nonce")!, challenge: to.searchParams.get("code_challenge")! };
      const code = pubIdp.issue(l.challenge, `${PUBLIC}/auth/callback`, await pubIdp.sign({ iss: pubIdp.issuer, aud: CLIENT, email: "alice@example.com", iat: sec(), exp: sec() + 60, nonce: l.nonce }));
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
      expect(cookieOf(r, "binder_login")).toBeUndefined();
    } finally {
      p.stop();
      other.stop();
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
