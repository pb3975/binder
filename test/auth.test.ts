// The auth boundary: tokens, sessions, the trusted header, and scopes.
import { afterAll, describe, expect, test } from "bun:test";
import { run } from "../src/cli";
import { loadConfig } from "../src/config";
import { form, headerAuth, startBinder } from "./helpers";

function token(dataDir: string, name: string, scope = "write") {
  const out: string[] = [];
  expect(run(["token", "create", "--name", name, "--scope", scope], { BINDER_DATA_DIR: dataDir }, (s) => out.push(s))).toBe(0);
  return out[0]!;
}
const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });

describe("token mode (no proxy header configured)", () => {
  const b = startBinder({ auth: { mode: "token" } });
  afterAll(() => b.stop());
  const api = (path: string, init: RequestInit = {}) => fetch(b.base + path, init);
  const alice = token(b.dataDir, "alice");
  const reader = token(b.dataDir, "viewer", "read");

  test("tokens are bnd_<id>_<secret> and only their hash is stored", async () => {
    expect(alice).toMatch(/^bnd_[0-9a-f]{12}_[\w-]{43}$/);
    const { Database } = await import("bun:sqlite");
    const raw = new Database(`${b.dataDir}/binder.sqlite`, { readonly: true });
    const dump = JSON.stringify(raw.query("SELECT * FROM tokens").all());
    raw.close();
    // The secret is everything after the fixed "bnd_<12 hex>_" prefix; it may itself contain "_".
    const secret = alice.slice("bnd_000000000000_".length);
    expect(secret).toHaveLength(43);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(alice);
  });

  test("no credential is 401; the UI shell and health check stay public", async () => {
    expect((await api("/api/artifacts")).status).toBe(401);
    expect((await api("/thumb/x.png")).status).toBe(401);
    expect((await api("/")).status).toBe(200);
    expect((await api("/app.js")).status).toBe(200);
    expect((await api("/healthz")).status).toBe(200);
  });

  test("the proxy header is ignored when header mode is off", async () => {
    expect((await api("/api/artifacts", { headers: { "tailscale-user-login": "owner@example.com" } })).status).toBe(401);
  });

  test("a write token publishes, and history records its name", async () => {
    const r = await api("/api/artifacts", { method: "POST", headers: bearer(alice, { "x-binder": "1" }), body: form({ id: "t1", title: "T1" }, [["index.html", "x"]]) });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ published_by: "alice" });
    const { versions } = await (await api("/api/artifacts/t1/versions", { headers: bearer(reader) })).json();
    expect(versions[0].published_by).toBe("alice");
  });

  test("a read token reads but cannot write", async () => {
    expect((await api("/api/artifacts", { headers: bearer(reader) })).status).toBe(200);
    const r = await api("/api/artifacts/t1", { method: "DELETE", headers: bearer(reader, { "x-binder": "1" }) });
    expect(r.status).toBe(403);
  });

  test("writes still need X-Binder, even with a valid token", async () => {
    const r = await api("/api/artifacts/t1", { method: "DELETE", headers: bearer(alice) });
    expect(r.status).toBe(403);
  });

  test("a bad bearer token never falls through to another source", async () => {
    expect((await api("/api/artifacts", { headers: bearer("bnd_000000000000_" + "a".repeat(43)) })).status).toBe(401);
    expect((await api("/api/artifacts", { headers: bearer(alice.slice(0, -1) + (alice.endsWith("A") ? "B" : "A")) })).status).toBe(401);
  });

  test("sign-in sets a strict, HttpOnly session cookie that works until the token is revoked", async () => {
    expect((await api("/api/session", { method: "POST", body: JSON.stringify({ token: alice }) })).status).toBe(403); // no X-Binder
    expect((await api("/api/session", { method: "POST", headers: { "x-binder": "1" }, body: JSON.stringify({ token: "nope" }) })).status).toBe(401);
    const s = await api("/api/session", { method: "POST", headers: { "x-binder": "1" }, body: JSON.stringify({ token: alice }) });
    expect(s.status).toBe(200);
    const setCookie = s.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(alice);
    const cookie = setCookie.split(";")[0]!;
    expect(await (await api("/api/session", { headers: { cookie } })).json()).toMatchObject({ name: "alice", via: "session" });

    const tampered = cookie.replace(/\.(\d+)\./, (_, e) => `.${Number(e) + 1}.`);
    expect((await api("/api/session", { headers: { cookie: tampered } })).status).toBe(401);

    expect(run(["token", "revoke", "alice"], { BINDER_DATA_DIR: b.dataDir }, () => {})).toBe(0);
    expect((await api("/api/session", { headers: { cookie } })).status).toBe(401);
    expect((await api("/api/artifacts", { headers: bearer(alice) })).status).toBe(401);
  });

  test("the CLI lists tokens without secrets and refuses duplicate live names", () => {
    const lines: string[] = [];
    run(["token", "list"], { BINDER_DATA_DIR: b.dataDir }, (s) => lines.push(s));
    expect(lines.join("\n")).toContain("alice");
    expect(lines.join("\n")).toContain("REVOKED");
    expect(lines.join("\n")).not.toContain("bnd_");
    expect(run(["token", "create", "--name", "viewer"], { BINDER_DATA_DIR: b.dataDir }, () => {})).toBe(1);
    // A revoked name can be reused.
    expect(run(["token", "create", "--name", "alice"], { BINDER_DATA_DIR: b.dataDir }, () => {})).toBe(0);
  });
});

describe("header mode (Tailscale or an identity-aware proxy)", () => {
  test("accepts allowed logins and *@domain from a trusted peer", async () => {
    const b = startBinder({ auth: headerAuth({ allowedUsers: ["owner@example.com", "*@team.example"] }) });
    try {
      const as = (login: string) => fetch(`${b.base}/api/artifacts`, { headers: { "tailscale-user-login": login } });
      expect((await as("owner@example.com")).status).toBe(200);
      expect((await as("Owner@Example.com")).status).toBe(200);
      expect((await as("bob@team.example")).status).toBe(200);
      expect((await as("bob@evilteam.example")).status).toBe(403);
      expect((await as("mallory@example.org")).status).toBe(403);
    } finally {
      b.stop();
    }
  });

  test("ignores the header from a peer that is not a trusted proxy", async () => {
    const b = startBinder({ auth: headerAuth({ trustedProxies: ["10.9.9.9", "172.17.0.0/16"] }) });
    try {
      const r = await fetch(`${b.base}/api/artifacts`, { headers: { "tailscale-user-login": "owner@example.com" } });
      expect(r.status).toBe(401);
    } finally {
      b.stop();
    }
  });
});

describe("none mode (BINDER_AUTH=none, a laptop)", () => {
  const b = startBinder({ auth: { mode: "none" }, publicUrl: "http://binder.example.com:8480" });
  afterAll(() => b.stop());
  const as = (host: string, path: string, init: RequestInit = {}) =>
    fetch(b.base + path, { ...init, headers: { host, ...(init.headers as Record<string, string>) }, redirect: "manual" });
  const agent = token(b.dataDir, "agent");

  test("everyone is the anonymous writer, and writes still need X-Binder", async () => {
    expect(await (await fetch(`${b.base}/api/session`)).json()).toEqual({ name: "anonymous", scope: "write", via: "none" });
    const r = await fetch(`${b.base}/api/artifacts`, { method: "POST", headers: { "x-binder": "1" }, body: form({ id: "n1" }, [["index.html", "x"]]) });
    expect(await r.json()).toMatchObject({ published_by: "anonymous" });
    expect((await fetch(`${b.base}/api/artifacts/n1`, { method: "DELETE" })).status).toBe(403);
  });

  test("a token still names the publisher, and a bad one is still refused", async () => {
    const r = await fetch(`${b.base}/api/artifacts`, { method: "POST", headers: bearer(agent, { "x-binder": "1" }), body: form({ id: "n2" }, [["index.html", "x"]]) });
    expect(await r.json()).toMatchObject({ published_by: "agent" });
    expect((await fetch(`${b.base}/api/artifacts`, { headers: bearer("bnd_nope") })).status).toBe(401);
  });

  test("loopback names and BINDER_PUBLIC_URL's host are served, on any port", async () => {
    for (const host of ["localhost:8480", "127.0.0.1", "[::1]:9999", "LOCALHOST", "binder.example.com", "binder.example.com:8480"])
      expect([host, (await as(host, "/api/artifacts")).status]).toEqual([host, 200]);
  });

  test("any other Host is refused with 421 on the API, the UI shell, and /c/ content (DNS rebinding)", async () => {
    const { content_url } = await (await fetch(`${b.base}/api/artifacts/n1`)).json();
    const contentPath = new URL(content_url).pathname;
    expect((await as("127.0.0.1", contentPath)).status).toBe(200);
    for (const host of ["evil.example", "evil.example:8480", "127.0.0.1.evil.example", "binder.example.com.evil.example", "192.0.2.20:8480"])
      for (const path of ["/api/artifacts", "/", "/a/n1", "/app.js", contentPath, "/llms.txt"]) {
        const r = await as(host, path);
        expect([host, path, r.status]).toEqual([host, path, 421]);
        expect((await r.json()).error).toContain("BINDER_PUBLIC_URL");
      }
    const w = await as("evil.example", "/api/artifacts", { method: "POST", headers: { "x-binder": "1" }, body: form({ id: "rebound" }, [["index.html", "x"]]) });
    expect(w.status).toBe(421);
    expect((await fetch(`${b.base}/api/artifacts/rebound`)).status).toBe(404);
  });

  test("the health check answers whatever the Host", async () => {
    expect((await as("evil.example", "/healthz")).status).toBe(200);
  });
});

describe("the signed-out session check names the mode", () => {
  test("token and header modes", async () => {
    for (const auth of [{ mode: "token" } as const, headerAuth()]) {
      const b = startBinder({ auth });
      try {
        const r = await fetch(`${b.base}/api/session`);
        expect(r.status).toBe(401);
        expect((await r.json()).auth).toBe(auth.mode);
      } finally {
        b.stop();
      }
    }
  });
});

describe("upgrades and fresh installs", () => {
  test("a v2 database from before tokens existed gains the tokens table", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { Database } = await import("bun:sqlite");
    const dir = mkdtempSync(`${tmpdir()}/binder-v2-notokens-`);
    const { openDb } = await import("../src/db");
    openDb(dir).close();
    const raw = new Database(`${dir}/binder.sqlite`);
    raw.exec("DROP TABLE tokens"); // the shape main had after #1
    raw.close();
    expect(run(["token", "create", "--name", "after-upgrade"], { BINDER_DATA_DIR: dir }, () => {})).toBe(0);
  });

  test("the CLI works before the server has ever created the data folder", async () => {
    const { mkdtempSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = `${mkdtempSync(`${tmpdir()}/binder-fresh-`)}/not/yet/here`;
    expect(existsSync(dir)).toBe(false);
    expect(run(["token", "create", "--name", "first"], { BINDER_DATA_DIR: dir }, () => {})).toBe(0);
  });
});

describe("configuration", () => {
  test("old variable names fail loudly instead of silently changing auth", () => {
    expect(() => loadConfig({ ALLOWED_LOGINS: "a@b.c" })).toThrow(/renamed/);
    expect(() => loadConfig({ DEV_ALLOW_ANONYMOUS: "1" })).toThrow(/renamed/);
  });
  test("BINDER_DEV_ANONYMOUS stops startup with a rename to BINDER_AUTH=none", () => {
    expect(() => loadConfig({ BINDER_DEV_ANONYMOUS: "1" })).toThrow(/BINDER_AUTH=none/);
    expect(() => loadConfig({ BINDER_DEV_ANONYMOUS: "0" })).toThrow(/BINDER_AUTH=none/);
  });
  test("the mode defaults to token, and an unknown mode fails", () => {
    expect(loadConfig({}).auth).toEqual({ mode: "token" });
    expect(loadConfig({ BINDER_AUTH: "none" }).auth).toEqual({ mode: "none" });
    expect(() => loadConfig({ BINDER_AUTH: "open" })).toThrow(/BINDER_AUTH must be one of token, none, header, oidc/);
  });
  test("BINDER_AUTH=header needs the header; the header with another mode is a conflict, not a silent change", () => {
    expect(() => loadConfig({ BINDER_AUTH: "header", BINDER_ALLOWED_USERS: "*" })).toThrow(/needs BINDER_AUTH_HEADER/);
    expect(() => loadConfig({ BINDER_AUTH: "token", BINDER_AUTH_HEADER: "Remote-User", BINDER_ALLOWED_USERS: "*" })).toThrow(/BINDER_AUTH=token/);
    expect(loadConfig({ BINDER_AUTH: "header", BINDER_AUTH_HEADER: "Remote-User", BINDER_ALLOWED_USERS: "*" }).auth.mode).toBe("header");
  });
  test("oidc mode names every missing setting and fills defaults", () => {
    const ok = { BINDER_AUTH: "oidc", BINDER_OIDC_ISSUER: "https://id.example.com/realms/team", BINDER_OIDC_CLIENT_ID: "binder", BINDER_PUBLIC_URL: "https://binder.example.com/", BINDER_ALLOWED_GROUPS: "binder-users" };
    expect(() => loadConfig({ BINDER_AUTH: "oidc", BINDER_ALLOWED_USERS: "*" })).toThrow(/BINDER_OIDC_ISSUER, BINDER_OIDC_CLIENT_ID, BINDER_PUBLIC_URL/);
    expect(() => loadConfig({ ...ok, BINDER_PUBLIC_URL: undefined })).toThrow(/needs BINDER_PUBLIC_URL/);
    expect(() => loadConfig({ ...ok, BINDER_ALLOWED_GROUPS: undefined })).toThrow(/BINDER_ALLOWED_USERS .* or BINDER_ALLOWED_GROUPS/);
    expect(() => loadConfig({ ...ok, BINDER_OIDC_ISSUER: "id.example.com" })).toThrow(/not a URL/);
    expect(() => loadConfig({ ...ok, BINDER_OIDC_SCOPES: "email profile" })).toThrow(/must include openid/);
    expect(loadConfig(ok).auth).toEqual({
      mode: "oidc", issuer: "https://id.example.com/realms/team", clientId: "binder", clientSecret: null,
      scopes: "openid email profile", label: "Sign in with SSO", allowedUsers: [], allowedGroups: ["binder-users"],
      groupsClaim: "groups", redirectUri: "https://binder.example.com/auth/callback",
    });
    expect(loadConfig({ ...ok, BINDER_OIDC_CLIENT_SECRET: "s", BINDER_OIDC_LABEL: "Sign in with Example", BINDER_OIDC_GROUPS_CLAIM: "roles", BINDER_ALLOWED_USERS: "A@Example.com" }).auth)
      .toMatchObject({ clientSecret: "s", label: "Sign in with Example", groupsClaim: "roles", allowedUsers: ["a@example.com"] });
  });
  test("the token CLI ignores auth settings, so an admin can always make a token", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/binder-cli-`);
    expect(run(["token", "create", "--name", "x"], { BINDER_DATA_DIR: dir, BINDER_AUTH: "oidc" }, () => {})).toBe(0);
  });
  test("header mode needs an allowlist, and proxies must parse", () => {
    expect(() => loadConfig({ BINDER_AUTH_HEADER: "Remote-User" })).toThrow(/BINDER_ALLOWED_USERS/);
    expect(() => loadConfig({ BINDER_TRUSTED_PROXIES: "not-an-ip" })).toThrow(/TRUSTED_PROXIES/);
    expect(loadConfig({ BINDER_AUTH_HEADER: "Remote-User", BINDER_ALLOWED_USERS: "*", BINDER_TRUSTED_PROXIES: "172.17.0.1" }).auth).toEqual({
      mode: "header", header: "Remote-User", allowedUsers: ["*"], trustedProxies: ["172.17.0.1"],
    });
  });
});
