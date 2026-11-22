// AWS credentials for S3 storage: static keys, and the ECS container endpoint with refresh.
// A fake endpoint on loopback hands out short-lived credentials; the clock is injected.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialProvider, REFRESH_BEFORE_MS } from "../src/aws";
import { storageConfig } from "../src/config";

let clock = Date.parse("2026-11-21T12:00:00Z");
const now = () => clock;
const TTL = 15 * 60_000; // what the fake endpoint grants, like a short ECS role session

type Seen = { path: string; auth: string | null };
const seen: Seen[] = [];
let issued = 0;
let answer: "ok" | "500" | "html" | "no-keys" | "expired" = "ok";
const endpoint = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    seen.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
    if (answer === "500") return new Response("boom", { status: 500 });
    if (answer === "html") return new Response("<html>", { headers: { "content-type": "text/html" } });
    if (answer === "no-keys") return Response.json({ Expiration: new Date(clock + TTL).toISOString() });
    if (answer === "expired")
      return Response.json({ AccessKeyId: "ASIA-FAKE-STALE", SecretAccessKey: "fake-stale", Token: "fake-stale", Expiration: new Date(clock - 1000).toISOString() });
    issued++;
    return Response.json({
      AccessKeyId: `ASIA-FAKE-${issued}`,
      SecretAccessKey: `fake-secret-${issued}`,
      Token: `fake-session-${issued}`,
      Expiration: new Date(clock + TTL).toISOString(),
    });
  },
});
afterAll(() => endpoint.stop(true));
const FULL = `http://127.0.0.1:${endpoint.port}/creds`;
const reset = () => {
  seen.length = 0;
  answer = "ok";
};

test("static keys from the environment win, with an optional session token", async () => {
  const get = credentialProvider({
    AWS_ACCESS_KEY_ID: "AKIA-FAKE", AWS_SECRET_ACCESS_KEY: "fake-secret", AWS_SESSION_TOKEN: "fake-token",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL,
  });
  expect(await get()).toEqual({ accessKeyId: "AKIA-FAKE", secretAccessKey: "fake-secret", sessionToken: "fake-token" });
});

test("no credential source is a clear error at startup", () => {
  expect(() => credentialProvider({})).toThrow(/No AWS credentials/);
});

test("the relative URI goes to the ECS endpoint at 169.254.170.2", async () => {
  const urls: string[] = [];
  const fakeFetch = (async (u: string) => {
    urls.push(String(u));
    return Response.json({ AccessKeyId: "ASIA-FAKE", SecretAccessKey: "fake", Token: "t", Expiration: new Date(clock + TTL).toISOString() });
  }) as unknown as typeof fetch;
  const get = credentialProvider({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/fake-id" }, { now, fetch: fakeFetch });
  expect((await get()).accessKeyId).toBe("ASIA-FAKE");
  expect(urls).toEqual(["http://169.254.170.2/v2/credentials/fake-id"]);
});

test("the full URI sends the authorization token", async () => {
  reset();
  const get = credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL, AWS_CONTAINER_AUTHORIZATION_TOKEN: "fake-auth" }, { now });
  const c = await get();
  expect(c.sessionToken).toStartWith("fake-session-");
  expect(seen).toEqual([{ path: "/creds", auth: "fake-auth" }]);
});

test("the token file wins over the variable and is read again on each refresh", async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), "binder-aws-"));
  const file = join(dir, "token");
  writeFileSync(file, "fake-from-file-1\n");
  const get = credentialProvider(
    { AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL, AWS_CONTAINER_AUTHORIZATION_TOKEN: "ignored", AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: file },
    { now },
  );
  await get();
  writeFileSync(file, "fake-from-file-2");
  clock += TTL; // expired: the next call must refresh
  await get();
  expect(seen.map((s) => s.auth)).toEqual(["fake-from-file-1", "fake-from-file-2"]);
});

test("credentials are cached, then refreshed 5 minutes before they expire", async () => {
  reset();
  const get = credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL }, { now });
  const first = await get();
  clock += TTL - REFRESH_BEFORE_MS - 1000; // just outside the refresh window
  expect(await get()).toBe(first);
  expect(seen.length).toBe(1);
  clock += 2000; // inside it: refresh, although the old credentials still work
  const second = await get();
  expect(second.accessKeyId).not.toBe(first.accessKeyId);
  expect(seen.length).toBe(2);
});

test("concurrent callers share one refresh", async () => {
  reset();
  const get = credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL }, { now });
  const all = await Promise.all([get(), get(), get(), get()]);
  expect(new Set(all.map((c) => c.accessKeyId)).size).toBe(1);
  expect(seen.length).toBe(1);
});

test("a failed early refresh keeps the current credentials until they expire, then fails", async () => {
  reset();
  const get = credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL }, { now });
  const first = await get();
  answer = "500";
  clock += TTL - 60_000; // inside the refresh window, not yet expired
  expect(await get()).toBe(first);
  clock += 120_000; // expired
  await expect(get()).rejects.toThrow(/answered 500/);
});

test("bad answers are errors", async () => {
  for (const [kind, msg] of [["500", /answered 500/], ["html", /JSON/], ["no-keys", /AccessKeyId/]] as const) {
    reset();
    answer = kind;
    await expect(credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL }, { now })()).rejects.toThrow(msg);
  }
});

test("the full URI must be https, or http to loopback or an ECS address", () => {
  expect(() => credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://example.com/creds" })).toThrow(/must be https/);
  expect(() => credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://example.com/creds" })).not.toThrow();
  expect(() => credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials" })).not.toThrow();
});

test("BINDER_STORAGE parses s3 URLs and the standard AWS settings", () => {
  expect(storageConfig({})).toEqual({ kind: "local" });
  expect(storageConfig({ BINDER_STORAGE: "local" })).toEqual({ kind: "local" });
  expect(storageConfig({ BINDER_STORAGE: "s3://binder-data/team-a/", AWS_REGION: "eu-west-1" })).toEqual({
    kind: "s3", bucket: "binder-data", prefix: "team-a", region: "eu-west-1", endpoint: null,
  });
  expect(
    storageConfig({ BINDER_STORAGE: "s3://binder-data", AWS_DEFAULT_REGION: "us-east-1", AWS_ENDPOINT_URL: "http://minio:9000/", AWS_ENDPOINT_URL_S3: "http://s3.local:9000" }),
  ).toMatchObject({ prefix: "", endpoint: "http://s3.local:9000" });
  expect(() => storageConfig({ BINDER_STORAGE: "s3://binder-data/x" })).toThrow(/AWS_REGION/);
  expect(() => storageConfig({ BINDER_STORAGE: "gs://x/y", AWS_REGION: "us-east-1" })).toThrow(/local or s3/);
  expect(() => storageConfig({ BINDER_STORAGE: "s3://Bad_Bucket/x", AWS_REGION: "us-east-1" })).toThrow(/bucket/);
  expect(() => storageConfig({ BINDER_STORAGE: "s3://binder-data/a//b", AWS_REGION: "us-east-1" })).toThrow(/prefix/);
  for (const bad of ["s3://binder-data//a", "s3://binder-data/a/../b", "s3://binder-data/./a", "s3://binder-data/a b", "s3://binder-data/a/.."])
    expect(() => storageConfig({ BINDER_STORAGE: bad, AWS_REGION: "us-east-1" })).toThrow(/prefix/);
  expect(storageConfig({ BINDER_STORAGE: "s3://binder-data/team.a/binder_1-x/", AWS_REGION: "us-east-1" })).toMatchObject({ prefix: "team.a/binder_1-x" });
  expect(() => storageConfig({ BINDER_STORAGE: "s3://binder-data/x", AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: "ftp://x" })).toThrow(/http or https/);
});

test("S3 storage needs BINDER_SECRET_KEY, strict base64 of 32 bytes or more", async () => {
  const { loadConfig } = await import("../src/config");
  const s3 = { BINDER_STORAGE: "s3://binder-data/x", AWS_REGION: "us-east-1", BINDER_LITESTREAM_SOCKET: "/tmp/fake.sock" };
  const key = Buffer.alloc(32, 7).toString("base64");
  expect(() => loadConfig(s3)).toThrow(/BINDER_SECRET_KEY is required/);
  expect(loadConfig({ ...s3, BINDER_SECRET_KEY: key }).secretKey).toEqual(Buffer.alloc(32, 7));
  expect(() => loadConfig({ BINDER_SECRET_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/at least 32 bytes/);
  expect(() => loadConfig({ BINDER_SECRET_KEY: `${key}!` })).toThrow(/must be base64/);
  expect(loadConfig({}).secretKey).toBeNull(); // local storage keeps using data/secret.key
  // S3 storage without Litestream would never copy the database to S3.
  expect(() => loadConfig({ ...s3, BINDER_SECRET_KEY: key, BINDER_LITESTREAM_SOCKET: undefined })).toThrow(/run under Litestream/);
});

test("the S3 client is replaced when the credentials refresh, and reused until then", async () => {
  const { s3Clients } = await import("../src/aws");
  reset();
  const get = credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL }, { now });
  const client = s3Clients({ kind: "s3", bucket: "binder-data", prefix: "", region: "us-east-1", endpoint: null }, get);
  const first = await client();
  expect(await client()).toBe(first);
  clock += TTL - REFRESH_BEFORE_MS + 1000; // inside the refresh window
  const second = await client();
  expect(second).not.toBe(first);
  expect(seen.length).toBe(2);
  // The new client signs with the new credentials.
  expect(second.presign("k")).toContain(encodeURIComponent((await get()).sessionToken!));
});

test("AWS gets virtual-hosted addresses; a custom endpoint or a dotted bucket name gets path style", async () => {
  const { s3Clients } = await import("../src/aws");
  const creds = async () => ({ accessKeyId: "ASIA-FAKE", secretAccessKey: "fake", sessionToken: "fake-session" });
  const url = async (bucket: string, endpoint: string | null) => {
    const u = new URL((await s3Clients({ kind: "s3", bucket, prefix: "", region: "eu-west-2", endpoint }, creds)()).presign("p/k"));
    return u.origin + u.pathname;
  };
  expect(await url("binder-data", null)).toBe("https://binder-data.s3.eu-west-2.amazonaws.com/p/k");
  expect(await url("binder.data", null)).toBe("https://s3.eu-west-2.amazonaws.com/binder.data/p/k");
  expect(await url("binder-data", "http://minio:9000")).toBe("http://minio:9000/binder-data/p/k");
});

test("an early refresh that answers already-expired credentials keeps the cached ones", async () => {
  reset();
  const get = credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL }, { now });
  const first = await get();
  answer = "expired";
  clock += TTL - 60_000; // inside the refresh window; the cached credentials still work
  expect(await get()).toBe(first);
  // With nothing valid cached, expired credentials are an error, never used.
  await expect(credentialProvider({ AWS_CONTAINER_CREDENTIALS_FULL_URI: FULL }, { now })()).rejects.toThrow(/expired/);
});
