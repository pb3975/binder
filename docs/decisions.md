# Decisions

Newest first. Each entry says what was decided and why. [design.md](design.md) has the full reasoning.

## 2026-11-21: Four auth modes: token, none, oidc, header

**Need:** a team with single sign-on can use Binder without a proxy in front, and one person on a laptop can use it without tokens. Agents keep working the same way everywhere.

- **`BINDER_AUTH` = `token` (default), `none`, `oidc`, or `header`.** Bearer tokens work in every mode, because agents always use tokens. Binder never stores a password; in oidc mode the identity provider owns passwords and MFA.
- **Built-in OIDC, reversing the 2026-11-20 rejection.** The proxy recipe needed a second service and three easy-to-miss rules. Binder does the authorization code flow with PKCE (S256), `state`, and `nonce`, and verifies the ID token itself with Web Crypto (RS256, PS256, ES256 only). No runtime dependency. CI signs in through a real Keycloak (`scripts/e2e-oidc.sh`).
- **SSO sessions last 8 hours,** so removing someone at the provider ends their access within a working day. Their MAC covers the provider, client, and allowlists, so changing those ends every SSO session at the next start. Token sessions keep 30 days.
- **A refused SSO sign-in redirects to `/?signin=<code>`,** and the UI shows fixed text for each code. A link cannot inject words, and the server log keeps the detail.
- **`none` replaces `BINDER_DEV_ANONYMOUS`** and answers only for loopback names and `BINDER_PUBLIC_URL`'s host (421 otherwise), against DNS rebinding. Binder refuses to start when it sees `BINDER_DEV_ANONYMOUS`.
- **Existing deployments keep working:** with `BINDER_AUTH` unset, `BINDER_AUTH_HEADER` alone still means header mode. `BINDER_AUTH_HEADER` with any other explicit mode stops startup, so auth never changes silently.
- **The token CLI reads only the data folder,** so a broken auth setting never stops an admin from making a token.
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
