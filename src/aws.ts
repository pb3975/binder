// S3 credentials and clients from the standard AWS variables.
//
// Bun.S3Client reads static keys from the environment, but it never calls the ECS container
// credentials endpoint (measured with Bun 1.4.2: it throws "Missing S3 credentials"). Fargate tasks
// get their role only from that endpoint, so Binder fetches, caches, and refreshes them here.
import type { StorageConfig } from "./config";

export type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Epoch milliseconds. Undefined means the credentials do not expire (static keys). */
  expiration?: number;
};

type Env = Record<string, string | undefined>;
type Deps = { now?: () => number; fetch?: typeof fetch; readFile?: (path: string) => Promise<string> };

/** Credentials are refreshed this long before they expire, so a slow request never signs with dead ones. */
export const REFRESH_BEFORE_MS = 5 * 60_000;
const ECS_ENDPOINT = "http://169.254.170.2";
// Plain http is only safe to a local or link-local endpoint; anything else must be https (as in the AWS SDKs).
const HTTP_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "169.254.170.2", "169.254.170.23", "[fd00:ec2::23]"]);

/**
 * Returns a function that resolves the current credentials. The order follows the AWS SDKs:
 * AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY first, then the ECS container endpoint.
 * Throws at once when the environment names no source.
 */
export function credentialProvider(env: Env, deps: Deps = {}): () => Promise<Credentials> {
  const now = deps.now ?? Date.now;
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    const fixed: Credentials = {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN || undefined,
    };
    return async () => fixed;
  }
  const url = containerEndpoint(env);
  if (!url)
    throw new Error(
      "No AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run where " +
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI or AWS_CONTAINER_CREDENTIALS_FULL_URI is set (an ECS task role)",
    );
  const doFetch = deps.fetch ?? fetch;
  const readFile = deps.readFile ?? ((p: string) => Bun.file(p).text());

  async function load(): Promise<Credentials> {
    const headers: Record<string, string> = {};
    // The token file can rotate, so it is read on every refresh. It wins over the variable, as in the SDKs.
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
      ? (await readFile(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE)).trim()
      : env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim();
    if (token) {
      if (/[\r\n]/.test(token)) throw new Error("the container authorization token contains a line break");
      headers.authorization = token;
    }
    const r = await doFetch(url!, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`container credentials endpoint answered ${r.status}`);
    let body: Record<string, unknown>;
    try {
      body = (await r.json()) as Record<string, unknown>;
    } catch {
      throw new Error("container credentials endpoint did not answer with JSON");
    }
    const { AccessKeyId, SecretAccessKey, Token, Expiration } = body ?? {};
    if (typeof AccessKeyId !== "string" || !AccessKeyId || typeof SecretAccessKey !== "string" || !SecretAccessKey)
      throw new Error("container credentials endpoint answered without AccessKeyId and SecretAccessKey");
    const expiration = Expiration === undefined ? undefined : Date.parse(String(Expiration));
    if (expiration !== undefined && Number.isNaN(expiration))
      throw new Error(`container credentials endpoint answered a bad Expiration: ${String(Expiration)}`);
    // Refused before they can replace the cache, so still-valid cached credentials stay in use.
    if (expiration !== undefined && expiration <= now())
      throw new Error(`container credentials endpoint answered credentials that expired at ${String(Expiration)}`);
    return {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretAccessKey,
      sessionToken: typeof Token === "string" && Token ? Token : undefined,
      expiration,
    };
  }

  let cached: Credentials | null = null;
  let inflight: Promise<Credentials> | null = null;
  const fresh = (c: Credentials) => c.expiration === undefined || now() < c.expiration - REFRESH_BEFORE_MS;
  const alive = (c: Credentials) => c.expiration === undefined || now() < c.expiration;

  return async () => {
    if (cached && fresh(cached)) return cached;
    // One refresh at a time; every caller waiting on it gets the same result.
    inflight ??= load()
      .then((c) => (cached = c))
      .catch((e) => {
        // A failed early refresh is not fatal while the current credentials still work.
        if (cached && alive(cached)) {
          console.warn(`AWS credentials refresh failed; using the current ones until they expire: ${(e as Error).message}`);
          return cached;
        }
        throw e;
      })
      .finally(() => (inflight = null));
    return inflight;
  };
}

function containerEndpoint(env: Env): string | null {
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) return ECS_ENDPOINT + env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  if (!full) return null;
  const u = URL.parse(full);
  if (!u || !(u.protocol === "https:" || (u.protocol === "http:" && HTTP_HOSTS.has(u.hostname))))
    throw new Error(`AWS_CONTAINER_CREDENTIALS_FULL_URI must be https, or http to a loopback or ECS address: ${full}`);
  return u.href;
}

/**
 * Returns a function that resolves an S3 client with current credentials. A new client is made
 * whenever the credentials change, so callers must ask for it on every operation and never keep it.
 */
export function s3Clients(cfg: Extract<StorageConfig, { kind: "s3" }>, credentials: () => Promise<Credentials>) {
  let current: { creds: Credentials; client: Bun.S3Client } | null = null;
  return async (): Promise<Bun.S3Client> => {
    const creds = await credentials();
    if (current?.creds !== creds) {
      current = {
        creds,
        client: new Bun.S3Client({
          bucket: cfg.bucket,
          region: cfg.region,
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
          // A custom endpoint (MinIO and other S3-compatible stores) gets the bucket in the path. AWS gets
          // <bucket>.s3.<region>.amazonaws.com, except for a bucket name with dots, which would not match
          // the TLS certificate there (the AWS SDKs make the same exception).
          ...(cfg.endpoint ? { endpoint: cfg.endpoint, virtualHostedStyle: false } : { virtualHostedStyle: !cfg.bucket.includes(".") }),
        }),
      };
    }
    return current.client;
  };
}
