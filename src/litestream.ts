// Writes the Litestream config for S3 storage and prints the database path.
// Usage: bun src/litestream.ts <config-path>     (docker/entrypoint.sh runs it before Litestream)
//
// It reads the same environment as the server, through the same parser, so a bad setting stops the
// container here with the server's message. The replica lives under <prefix>/db in the bucket.
// Credentials are not written: Litestream's AWS SDK reads AWS_ACCESS_KEY_ID, AWS_SESSION_TOKEN, and the
// ECS container endpoint itself (Litestream ignores env keys only when the config names keys, which this never does).
import { join } from "node:path";
import { loadConfig, type Config } from "./config";

export function litestreamConfig(cfg: Config) {
  if (cfg.storage.kind !== "s3") throw new Error("BINDER_STORAGE is not s3; Litestream is only used with S3 storage");
  const s = cfg.storage;
  return {
    dbs: [
      {
        path: join(cfg.dataDir, "binder.sqlite"),
        replica: {
          type: "s3",
          bucket: s.bucket,
          path: s.prefix ? `${s.prefix}/db` : "db",
          region: s.region,
          // MinIO and other S3-compatible stores: the bucket goes in the path, as in src/aws.ts.
          ...(s.endpoint ? { endpoint: s.endpoint, "force-path-style": true } : {}),
        },
      },
    ],
  };
}

if (import.meta.main) {
  const out = process.argv[2];
  try {
    if (!out) throw new Error("usage: bun src/litestream.ts <config-path>");
    const cfg = loadConfig();
    // JSON is valid YAML, and it needs no escaping rules of its own.
    await Bun.write(out, JSON.stringify(litestreamConfig(cfg), null, 2) + "\n");
    console.log(join(cfg.dataDir, "binder.sqlite"));
  } catch (e) {
    console.error(`binder: cannot start: ${(e as Error).message}`);
    process.exit(1);
  }
}
