// The auth boundary: tokens, sessions, the trusted header, and scopes.
import { afterAll, describe, expect, test } from "bun:test";
import { run } from "../src/cli";
import { loadConfig } from "../src/config";
import { form, startBinder } from "./helpers";

function token(dataDir: string, name: string, scope = "write") {
  const out: string[] = [];
  expect(run(["token", "create", "--name", name, "--scope", scope], { BINDER_DATA_DIR: dataDir }, (s) => out.push(s))).toBe(0);
  return out[0]!;
}
const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });

describe("token mode (no proxy header configured)", () => {
  const b = startBinder({ authHeader: null, allowedUsers: [] });
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
    const b = startBinder({ allowedUsers: ["owner@example.com", "*@team.example"] });
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
    const b = startBinder({ trustedProxies: ["10.9.9.9", "172.17.0.0/16"] });
    try {
      const r = await fetch(`${b.base}/api/artifacts`, { headers: { "tailscale-user-login": "owner@example.com" } });
      expect(r.status).toBe(401);
    } finally {
      b.stop();
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
  test("header mode needs an allowlist, and proxies must parse", () => {
    expect(() => loadConfig({ BINDER_AUTH_HEADER: "Remote-User" })).toThrow(/BINDER_ALLOWED_USERS/);
    expect(() => loadConfig({ BINDER_TRUSTED_PROXIES: "not-an-ip" })).toThrow(/TRUSTED_PROXIES/);
    expect(loadConfig({ BINDER_AUTH_HEADER: "Remote-User", BINDER_ALLOWED_USERS: "*", BINDER_TRUSTED_PROXIES: "172.17.0.1" })).toMatchObject({
      authHeader: "Remote-User", allowedUsers: ["*"], trustedProxies: ["172.17.0.1"],
    });
  });
});
