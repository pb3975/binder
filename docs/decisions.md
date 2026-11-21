# Decisions

Newest first. Each entry says what was decided and why. [design.md](design.md) has the full reasoning.

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
