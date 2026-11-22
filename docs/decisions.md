# Decisions

Newest first. Each entry says what was decided and why. [design.md](design.md) has the full reasoning.

## 2026-11-21: S3 storage for a container host with no disk (AWS Fargate)

**Need:** run Binder on AWS Fargate. A Fargate task has no persistent disk: everything on it is gone when the task stops or moves.

- **Version files and previews go to S3 when `BINDER_STORAGE=s3://<bucket>/<prefix>`.** S3 is the durable store. Keys: `versions/<id>/<n>/<path>`, `thumbs/<id>.png`, and `db/` for the database replica. Local disk stays the default and works as before.
- **The SQLite database stays on the task's local disk, and Litestream copies it to S3.** SQLite on EFS or another network file system is not safe: its locks depend on the file system, and NFS locks are not reliable. Litestream restores the database from S3 at start, then runs Binder as its child and copies every change. Invariant 4 ("one process") gets one exception in S3 mode: Litestream supervises Binder in the same container.
- **No answered write is lost.** Litestream copies asynchronously (`sync-interval` 1s). A cross-review measured a write lost after 201: with Litestream 0.5.18, a stop before the first tick skipped the final sync. So every API write and every `binder token` change waits for Litestream's `POST /sync` with `wait` on its control socket. A failed copy answers 503. `/healthz` fails when S3 is more than 60 seconds behind. Only background writes (last-used time, preview flag) can be lost in a crash.
- **A failed restore stops the container.** Only "no replica yet" may start an empty database. Otherwise an empty Binder with wrong credentials or a typo in the bucket could later replicate over the real data.
- **Content still goes through Binder, never a redirect to S3.** A presigned URL would drop the CSP `sandbox` header. Measured: `new Response(s3File)` in Bun answers 302 to a presigned URL, so the storage interface returns plain Blobs and never an S3File.
- **One writer per prefix, with a tripwire.** Version files are written with a conditional PUT (`If-None-Match: *`), so a second Binder on the prefix fails loudly instead of overwriting a file. Bun.S3Client cannot send the header, so Binder sends a presigned PUT. Binder must be the only process that uses a prefix. Inside the process, publishes and restores run one at a time, so ids and version numbers are decided together with the uploads. A version row is written only after every file is in S3. A number that has files but no row (an upload that never committed, or a row lost in the loss window) is skipped, so those files are never overwritten.
- **`BINDER_SECRET_KEY` is required with S3.** A key generated on an ephemeral disk would change on every restart and end every session and content URL.
- **Binder fetches ECS container credentials itself.** Measured: `Bun.S3Client` never calls the container credentials endpoint (with only `AWS_CONTAINER_CREDENTIALS_FULL_URI` set it throws "Missing S3 credentials"). `src/aws.ts` reads static keys first, then the endpoint, and refreshes 5 minutes before `Expiration`. Litestream uses the AWS SDK for Go, which reads the endpoint itself; CI checks both against a fake endpoint.
- **Litestream from upstream commit `a8e0472`, built from source, in both images.** No release has the fixes Binder needs yet; 0.5.18 is the newest. The commit holds three of them: issue 1580 (`bcd69ae`, PR 1581: a writer killed mid-commit gets uncommitted frames replicated, so a restore is corrupt), the sync target pinned before the upload (`93eba41`, PR 1562: without it, a write made during an upload can be counted as uploaded, and Binder answers 503 for a write that is durable), and snapshot WAL reads that stop at the advertised end (`a8e0472`, PR 1491). The two earlier commits are ancestors of `a8e0472` (checked with GitHub's compare API). The Dockerfile checks out the exact commit, builds with CGO off, `-trimpath`, and no VCS stamp, and checks the binary's sha256 for amd64 and arm64. The build is reproducible: a no-cache rebuild gives the same sums, and CI's native arm64 build matched the cross-built sum for the previous pin. Switch to the first release that has all three. The binary is static and adds about 55 MB to each image.
- **CI uses Bitnami's last free MinIO build, pinned by digest.** `minio/minio` is no longer on Docker Hub. MinIO is only a test fixture here; any S3-compatible store works.
- **S3 storage starts at schema v2.** The v1 migration moves folders on local disk, so Binder refuses a v1 database in S3 mode. Migrate with local storage first.

## 2026-11-21: Four auth modes: token, none, oidc, header

**Need:** a team with single sign-on can use Binder without a proxy in front, and one person on a laptop can use it without tokens. Agents keep working the same way everywhere.

- **`BINDER_AUTH` = `token` (default), `none`, `oidc`, or `header`.** Bearer tokens work in every mode, because agents always use tokens. Binder never stores a password; in oidc mode the identity provider owns passwords and MFA.
- **Built-in OIDC, reversing the 2026-11-20 rejection.** The proxy recipe needed a second service and three easy-to-miss rules. Binder does the authorization code flow with PKCE (S256), `state`, and `nonce`, and verifies the ID token itself with Web Crypto (RS256, PS256, ES256 only). No runtime dependency. CI signs in through a real Keycloak (`scripts/e2e-oidc.sh`).
- **SSO sessions last 8 hours,** so removing someone at the provider ends their Binder session within a working day. Signed content links they already hold last 8 to 9 hours on their own. The session MAC covers the provider, client, allowlists, and hosted domain, so changing those ends every SSO session at the next start. Token sessions keep 30 days.
- **Strict OIDC checks after a cross-model review against OIDC Core, RFC 6749, and RFC 7636:** the audience must be Binder's client ID alone; `sub`, `access_token`, and `token_type` Bearer are required; any `crit` header is refused; one configured signing algorithm (`BINDER_OIDC_SIGNING_ALG`, RS256 by default). The JWKS cache lasts an hour, with a rate-limited refetch after a bad signature.
- **https everywhere in oidc mode:** the issuer, discovered endpoints, and `BINDER_PUBLIC_URL`, except loopback. `BINDER_OIDC_ALLOW_HTTP=true` is the one escape hatch, for isolated test networks such as the Keycloak e2e.
- **Google Workspace by the signed `hd` claim** (`BINDER_OIDC_HOSTED_DOMAIN`), not by an email suffix. Entra ID by group, because its email claims are not verified.
- **One login cookie per sign-in,** named after its state, so concurrent tabs do not clobber each other.
- **Configuration that would be ignored stops startup:** a blank `BINDER_AUTH`, any setting that belongs to another mode, and a `BINDER_PUBLIC_URL` that is not an http(s) origin. Subpath hosting is not supported.
- **A refused SSO sign-in redirects to `/?signin=<code>`,** and the UI shows fixed text for each code. A link cannot inject words, and the server log keeps the detail.
- **`none` replaces `BINDER_DEV_ANONYMOUS`** and answers only for loopback names and `BINDER_PUBLIC_URL`'s host (421 otherwise), against DNS rebinding. Binder refuses to start when it sees `BINDER_DEV_ANONYMOUS`.
- **Existing deployments keep working:** with `BINDER_AUTH` unset, `BINDER_AUTH_HEADER` alone still means header mode. `BINDER_AUTH_HEADER` with any other explicit mode stops startup, so auth never changes silently.
- **The token CLI ignores every auth setting,** so a broken one never stops an admin from making a token. It still reads storage settings, so with S3 a token change waits for the copy to S3.
- Rejected: storing passwords in Binder (a second identity system to secure), and RP-initiated logout at the provider (sign-out ends the Binder session only; the provider's own session is the provider's to end).

## 2026-11-21: Go public as a new repository (Inbox: binder/go-public)

**Need:** publish Binder without its private history.

- **Publish a new public repository from one squashed commit of the scrubbed tree.** The old history has private host names, paths, and a personal email. GitHub keeps every pull request's commits under `refs/pull/N/head`, so a squash in place would still serve them. The private repository is renamed and kept as the archive.
- **The public repository takes the name `binder`,** so the clone URL in the docs stays the same.
- **Public CI runs on GitHub-hosted runners.** Fork pull requests must never run on self-hosted machines.

## 2026-11-21: MIT license (Inbox: binder/license)

**Need:** let anyone self-host, change, and build on Binder with the least friction.

- **MIT.** It is short and permissive, and it fits a small personal tool shared as an example. Rejected: Apache-2.0 (longer, and a patent grant matters little here) and AGPL-3.0 (copyleft deters the self-hosters this is for).

## 2026-11-20: Open-source and team mode review

**Need:** strangers can self-host Binder on any platform, and a team can share one instance with real auth and browsable version history, without weakening the artifact sandbox.

- **Keep the publish contract: one multipart `curl`, documented in a skill.** A CLI wraps one `curl` call and adds an install. An MCP server needs per-harness setup, and a remote one cannot read the agent's local files. The repo ships a generic skill (`skill/binder/SKILL.md`) that reads `BINDER_URL` and `BINDER_TOKEN`. API v1 changes are additive.
- **Serve artifact content from signed capability URLs** (`/c/<id>/<version>/<exp>.<hmac>/...`), not behind a cookie. Measured in Chromium: a sandboxed iframe's subresource requests carry no SameSite cookies, so any cookie login breaks multi-file artifacts. URLs live 8 to 9 hours and die with a removed artifact. Rejected for now: a separate content origin, which every self-hoster would need a second DNS name and certificate for.
- **Auth from three sources in a fixed order:** Bearer token (no fallthrough), signed session cookie, trusted proxy header. Header mode is explicit, needs an allowlist, and counts only from `BINDER_TRUSTED_PROXIES`. Tailscale is one header-mode setup. Rejected: built-in OIDC (large surface, does not help agents) and per-artifact permissions (run a second instance instead).
- **Tokens are managed only by a server-side CLI.** No HTTP admin API, so no admin role and no admin endpoints. Tokens are named, scoped `read` or `write`, and stored as SHA-256 hashes.
- **Immutable versions in `versions/<id>/<n>/` with who, when, note, and file hashes.** History shows a file diff, not a text diff of generated HTML. Restore copies an old version forward. Removal is a soft delete. Rejected for now: content-addressed blobs; the dedupe is not worth losing plain folders.
- **Previews are opt-in (`full` image); `slim` is the default.** Chromium cannot have its own sandbox in an unprivileged container. When on, previews render through a pinned wrapper, a render-mode CSP limited to Binder and public CDNs, and a proxy-based network allowlist. CI checks 21 attacks with zero requests and zero TCP connections.
- **Strict CSP on the UI shell; `source_url` must be http(s).** The v1 UI would have rendered a `javascript:` source link.
- **Old env names fail loudly.** `ALLOWED_LOGINS` and `DEV_ALLOW_ANONYMOUS` stop startup with a rename message, so auth never changes silently.
- **The container starts as root only to `chown /data`, then drops to `bun`.** Fresh cloud volumes are root-owned. `--user` still works for NAS folders with a fixed owner.
- **arm64 is built in CI only once the repo is public**, on GitHub's free arm runner. A `v*` tag publishes multi-arch images to GHCR; nothing publishes without a tag.

## 2026-11-14: Initial shape

**Need:** one private place to browse the canvas artifacts agents build, grouped and filterable by project, domain, date, and title, reachable from any device on a private network, publishable by any agent with no setup.

- **Bun + SQLite + vanilla frontend, no runtime dependencies.** The library is tens to hundreds of items, so one `GET /api/artifacts` and client-side filtering keep the UI instant and the server small. No build step.
- **Artifacts are files on disk, metadata in SQLite.** An artifact can be one HTML file or a folder of files; storing the files as-is keeps relative links working and makes backup a folder copy.
- **Sandbox every artifact.** Raw files carry a CSP `sandbox` header and the viewer iframe has the `sandbox` attribute without `allow-same-origin`. Writes need an `X-Binder: 1` header, which a sandboxed page cannot send without a preflight that Binder never approves.
- **Server-side previews with headless Chromium**, one render at a time.
