// Turns CDK context (`cdk deploy -c key=value`, always strings) into a checked BinderConfig.
// Every unsafe combination stops synth here, before any resource exists.

export type Auth =
  | { mode: "token" }
  | { mode: "none" }
  | {
      mode: "oidc";
      issuer: string;
      clientId: string;
      /** ARN of a Secrets Manager secret whose value is the client secret. */
      clientSecretArn: string;
      scopes?: string;
      label?: string;
      allowedUsers?: string;
      allowedGroups?: string;
      groupsClaim?: string;
    };

export interface BinderConfig {
  image: string;
  imageTag: string;
  previews: "slim" | "full";
  auth: Auth;
  /** HTTPS on this name, with an ACM certificate and an alias in the hosted zone. */
  domain?: { name: string; hostedZoneId: string };
  internetFacing: boolean;
  /** Source addresses the load balancer accepts. */
  allowedCidr: string;
  cpu: number;
  memory: number;
  /** Use this VPC instead of creating one. */
  vpcId?: string;
  /** Subnets for the load balancer (when internal) and the task. "private" needs an existing VPC with a NAT. */
  subnetType: "public" | "private";
  /** Key prefix in the bucket: BINDER_STORAGE=s3://<bucket>/<prefix>. */
  storagePrefix: string;
  /** Reuse a bucket a destroyed stack left behind, instead of creating one. */
  bucketName?: string;
}

export const CONTEXT_KEYS = [
  "image",
  "imageTag",
  "previews",
  "auth",
  "oidcIssuer",
  "oidcClientId",
  "oidcClientSecretArn",
  "oidcScopes",
  "oidcLabel",
  "allowedUsers",
  "allowedGroups",
  "oidcGroupsClaim",
  "domainName",
  "hostedZoneId",
  "internetFacing",
  "allowedCidr",
  "cpu",
  "memory",
  "vpcId",
  "subnetType",
  "storagePrefix",
  "bucketName",
] as const;

export type ContextKey = (typeof CONTEXT_KEYS)[number];
export type Context = Partial<Record<ContextKey, unknown>>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const fail = (msg: string): never => {
  throw new ConfigError(msg);
};

function text(ctx: Context, key: ContextKey): string | undefined {
  const v = ctx[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") fail(`${key} must be a string`);
  return String(v).trim() || undefined;
}

function oneOf<T extends string>(ctx: Context, key: ContextKey, allowed: readonly T[], fallback: T): T {
  const v = text(ctx, key) ?? fallback;
  return (allowed as readonly string[]).includes(v) ? (v as T) : fail(`${key} must be one of ${allowed.join(", ")}; got "${v}"`);
}

function bool(ctx: Context, key: ContextKey, fallback: boolean): boolean {
  const v = text(ctx, key);
  if (v === undefined) return fallback;
  if (v === "true") return true;
  if (v === "false") return false;
  return fail(`${key} must be true or false; got "${v}"`);
}

function int(ctx: Context, key: ContextKey, fallback: number): number {
  const v = text(ctx, key);
  if (v === undefined) return fallback;
  return /^\d+$/.test(v) ? Number(v) : fail(`${key} must be a whole number; got "${v}"`);
}

function parseAuth(ctx: Context): Auth {
  const mode = oneOf(ctx, "auth", ["token", "none", "oidc", "header"], "token");
  switch (mode) {
    case "token":
    case "none":
      return { mode };
    case "header":
      return fail(
        "auth=header is not offered on AWS: a load balancer alone does not sign people in or overwrite a user header, " +
          "so anyone who reaches it could claim any login. Use auth=token or auth=oidc.",
      );
    case "oidc": {
      const need = (key: ContextKey) => text(ctx, key) ?? fail(`auth=oidc needs ${key}`);
      const auth: Auth = {
        mode,
        issuer: need("oidcIssuer"),
        clientId: need("oidcClientId"),
        clientSecretArn: need("oidcClientSecretArn"),
        scopes: text(ctx, "oidcScopes"),
        label: text(ctx, "oidcLabel"),
        allowedUsers: text(ctx, "allowedUsers"),
        allowedGroups: text(ctx, "allowedGroups"),
        groupsClaim: text(ctx, "oidcGroupsClaim"),
      };
      if (!auth.issuer.startsWith("https://")) fail("oidcIssuer must be an https:// URL");
      if (!/^arn:aws[a-z-]*:secretsmanager:[^:]+:\d{12}:secret:.+-[A-Za-z0-9]{6}$/.test(auth.clientSecretArn))
        fail("oidcClientSecretArn must be the full ARN of a Secrets Manager secret (ends in -XXXXXX), not the secret itself");
      if (!auth.allowedUsers && !auth.allowedGroups)
        fail("auth=oidc needs allowedUsers or allowedGroups, so only your team can sign in (use allowedUsers=* to allow everyone the issuer accepts)");
      return auth;
    }
  }
}

/** The first Binder release with S3 storage. An older image ignores BINDER_STORAGE and keeps data on task storage, which Fargate deletes. */
export const MIN_VERSION = "0.2.0";

/** True when tag is a release older than MIN_VERSION. Tags that are not versions (a digest, a branch build) are the operator's call. */
function olderThanMin(tag: string): boolean {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:-full)?$/);
  if (!m) return false;
  const [a, b, c] = MIN_VERSION.split(".").map(Number) as [number, number, number];
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const [x, y] of [[v[0], a], [v[1], b], [v[2], c]] as const) if (x !== y) return x! < y;
  return Boolean(m[4]); // 0.2.0-rc.1 comes before 0.2.0
}

/** Parses and checks the stack's inputs. `defaults.imageTag` is the version in the repository's package.json. */
export function parseConfig(ctx: Context, defaults: { imageTag: string }): BinderConfig {
  const domainName = text(ctx, "domainName");
  const hostedZoneId = text(ctx, "hostedZoneId");
  if (Boolean(domainName) !== Boolean(hostedZoneId)) fail("set domainName and hostedZoneId together");

  const previews = oneOf(ctx, "previews", ["slim", "full"], "slim");
  const vpcId = text(ctx, "vpcId");
  const subnetType = oneOf(ctx, "subnetType", ["public", "private"], "public");
  if (subnetType === "private" && !vpcId) fail("subnetType=private needs vpcId: the VPC this stack creates has no NAT gateway");

  const config: BinderConfig = {
    image: text(ctx, "image") ?? "ghcr.io/pb3975/binder",
    imageTag: text(ctx, "imageTag") ?? defaults.imageTag,
    previews,
    auth: parseAuth(ctx),
    domain: domainName && hostedZoneId ? { name: domainName.replace(/\.$/, ""), hostedZoneId } : undefined,
    internetFacing: bool(ctx, "internetFacing", false),
    allowedCidr: text(ctx, "allowedCidr") ?? "0.0.0.0/0",
    // Chromium needs more room than the slim image.
    cpu: int(ctx, "cpu", previews === "full" ? 512 : 256),
    memory: int(ctx, "memory", previews === "full" ? 1024 : 512),
    vpcId,
    subnetType,
    storagePrefix: (text(ctx, "storagePrefix") ?? "binder").replace(/^\/+|\/+$/g, ""),
    bucketName: text(ctx, "bucketName"),
  };

  if (olderThanMin(config.imageTag))
    fail(
      `imageTag ${config.imageTag} has no S3 storage, so Fargate would delete every artifact when the task stops. ` +
        `Use Binder ${MIN_VERSION} or later: check out a release tag, or pass -c imageTag=<version>.`,
    );
  if (config.internetFacing && config.subnetType === "private") fail("internetFacing=true needs subnetType=public");
  if (config.internetFacing && config.auth.mode === "none") fail("refusing internetFacing=true with auth=none: anyone on the internet could publish and delete");
  if (config.internetFacing && !config.domain) fail("refusing internetFacing=true without HTTPS: set domainName and hostedZoneId");
  if (config.auth.mode === "oidc" && !config.domain) fail("auth=oidc needs HTTPS: set domainName and hostedZoneId");
  // The same rule Binder applies to the prefix in BINDER_STORAGE at startup (src/config.ts, storageConfig).
  if (
    !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(config.storagePrefix) ||
    config.storagePrefix.split("/").some((seg) => seg === "." || seg === "..")
  )
    fail(`storagePrefix may use letters, digits, '.', '_', '-' and single slashes between them, with no '.' or '..' segment; got "${config.storagePrefix}"`);
  if (config.bucketName && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucketName)) fail(`bucketName "${config.bucketName}" is not an S3 bucket name`);
  if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(config.allowedCidr)) fail(`allowedCidr must be an IPv4 CIDR; got "${config.allowedCidr}"`);
  return config;
}

/** The image reference the task runs. */
export const imageRef = (c: BinderConfig) => `${c.image}:${c.imageTag}${c.previews === "full" ? "-full" : ""}`;
