export {};
// A stand-in for the ECS container credentials endpoint (169.254.170.2 on Fargate), for scripts/e2e-s3.sh.
// It hands out the MinIO test keys as short-lived credentials, only to callers that send the token.
// Binder (src/aws.ts) and Litestream (the AWS SDK) both have to find it through
// AWS_CONTAINER_CREDENTIALS_FULL_URI and AWS_CONTAINER_AUTHORIZATION_TOKEN. Synthetic keys only.
const { FAKE_ECS_TOKEN, FAKE_ECS_KEY, FAKE_ECS_SECRET } = process.env;
const hits: Record<string, number> = {};
Bun.serve({
  port: 9911,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/hits") return Response.json(hits);
    const ua = (req.headers.get("user-agent") ?? "").toLowerCase();
    // Bun's fetch says "Bun/<version>". The AWS SDK for Go, inside Litestream, uses Go's default client here.
    const caller = ua.startsWith("bun/") ? "binder" : ua.startsWith("go-http-client/") ? "litestream" : ua || "unknown";
    if (req.headers.get("authorization") !== FAKE_ECS_TOKEN) return new Response("forbidden", { status: 403 });
    hits[caller] = (hits[caller] ?? 0) + 1;
    return Response.json({
      AccessKeyId: FAKE_ECS_KEY,
      SecretAccessKey: FAKE_ECS_SECRET,
      Expiration: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  },
});
console.log("fake ECS credentials endpoint on 127.0.0.1:9911");
