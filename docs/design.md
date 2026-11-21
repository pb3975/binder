# Binder design

Status: accepted 2026-11-20. This document records the design review done before Binder went open source. Three reviews shaped it: the author's own, an advisor model (Claude Fable 5.2), and an independent review from another model family (GPT-6.2 Sol), plus a code-review bot on the first PR. Decisions and their dates are in [decisions.md](decisions.md).

## What Binder is for

Agents build pages that are not code: interactive explainers, diagrams, dashboards, quizzes, design galleries. They come from many harnesses on many machines. Binder is one place where a person or a team keeps those pages, finds them again by project, and walks back through their versions.

Product invariants. Every choice below ties back to one of these.

1. **Publishing is one HTTP request** from any agent that can run `curl`. No install on the agent's machine.
2. **Artifact HTML is untrusted.** A page must never read or change Binder, its other artifacts, or its users' credentials.
3. **Nothing is lost.** Every published version stays readable. Removal is reversible.
4. **Small enough to read in an afternoon.** One process, one SQLite file, one data folder, no runtime dependencies.
5. **Runs anywhere a container or Bun runs**, with no assumption about Tailscale, Unraid, or a cloud vendor.

Non-goals: a user-management product, a CMS, comments, real-time collaboration, public sharing, horizontal scaling.

## Review of the original design

The first version (Nov 2026) was built for one person on one tailnet. The review kept most of it and changed four things.

| Original choice | Verdict | Why |
|---|---|---|
| Publish with one multipart `curl`, documented in an agent skill | **Keep** | Every harness can run a shell command. A skill is plain text that any agent reads. See "Agent integration". |
| Bun + SQLite + static UI, no build step | **Keep** | Fits invariant 4. The library is hundreds of items, so the UI filters client-side. |
| Files on disk, metadata in SQLite | **Keep** | Relative links in multi-file artifacts keep working. Backup is a folder copy. |
| CSP `sandbox` on artifact files, sandboxed iframe, `X-Binder: 1` on writes | **Keep, and extend** | The opaque origin is the core of invariant 2. The extension is below. |
| Auth is the `Tailscale-User-Login` header only | **Change** | A header is only safe when the proxy is the only way in. Teams and cloud hosts need tokens. |
| Old versions moved to `trash/` without metadata | **Change** | History was not browsable, and nothing recorded who published a version. |
| Removal moves files to `trash/` and deletes the row | **Change** | A soft delete keeps the history and is reversible with one column. |
| Previews render the artifact from `file://` in Chromium | **Change** | A page rendered from `file://` can show local files in the preview. It can also load internal services, such as a cloud metadata endpoint, into the screenshot. |
| The image always includes Chromium | **Change** | Chromium renders publisher HTML without its own sandbox. The default image is now `slim`; previews are an explicit opt-in. |

## Storage and history

```
data/
  binder.sqlite        artifacts, versions, tokens (schema version in PRAGMA user_version)
  secret.key           32 random bytes, created on first start, mode 0600
  versions/<id>/<n>/   the files of version n, immutable after publish
  thumbs/<id>.png      preview of the current version
  trash/               files from schema v1 and failed uploads; never read
```

- `artifacts` holds what is true of the artifact now: title, summary, project, domain, kind, tags, current version, `deleted_at`.
- `versions` holds one immutable row per publish: entry file, file list with SHA-256 per file, bytes, `published_by` (the authenticated identity), `agent` and `host` (self-reported by the publisher), `note` (a one-line change message), and the time.
- "What changed" between two versions is the note plus a file diff: added, removed, and changed files by hash. A text diff of generated HTML is noise, so Binder does not show one. A reader opens any old version in the viewer instead.
- **Restore** publishes a copy of an old version as a new version. History only grows.
- **Remove** sets `deleted_at`. Files stay where they are. Publishing the same `id` again brings the artifact back with a new version.
- Version numbers are allocated inside the same synchronous SQLite transaction that renames the staging folder into place, so two concurrent publishes to one `id` get different numbers.
- Binder is a single process. Two processes on one data folder are not supported.

Content-addressed storage (one blob per unique file) would remove duplicate bytes between versions. It was rejected for now: artifacts are small, and a plain folder per version keeps relative links working, keeps previews simple, and keeps the data folder readable by a person.

## Serving untrusted HTML

Artifact files are served only from capability URLs:

```
/c/<id>/<version>/<expiry>.<signature>/<path>
```

- The signature is HMAC-SHA256 over the id, version, mode, and expiry, keyed by `secret.key`. It grants read access to that one version and nothing else.
- Every response carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads` and `Referrer-Policy: no-referrer`. The page runs in an opaque origin. It cannot read Binder's pages, cookies, or storage, and the referrer policy keeps the URL out of requests to CDNs.
- The viewer iframe also has `sandbox` without `allow-same-origin`.
- Version files never change, so responses are cacheable. Expiry is rounded up to the hour and lives 8 to 9 hours: long enough for a working day in an open tab, short enough that a copied link (or one a page sends to a third party) dies soon. The UI refreshes URLs that are close to expiry.
- A removed artifact's signed URLs stop working at once.
- `/raw/<id>/<path>` stays for old links. It requires a login and redirects (302, `no-store`) to the signed URL of the current version.
- Known limit: a page can read its own URL and send it elsewhere. That grants read access to that one version, which its author already has, until the URL expires.

**Why a signature in the path and not a cookie.** A test in Chromium (the Binder image's Chromium, Nov 2026) showed that a sandboxed iframe's own navigation carries SameSite cookies, but requests for its images, scripts, and styles carry none, Lax or Strict. This is what the spec predicts, because an opaque origin is never same-site. So any cookie login, built in or from an SSO proxy, breaks every multi-file artifact. The Tailscale header worked only because the proxy adds it to every request. A signed path prefix is inherited by relative URLs and needs no cookie.

**Why not a separate content origin.** A second hostname (like `githubusercontent.com`) is the strongest isolation, but every self-hoster would need a second DNS name and TLS certificate. The opaque origin from CSP `sandbox` gives the same read isolation in current browsers. Capability URLs make a separate origin a configuration change later.

**Writes from artifacts.** A sandboxed page can still send simple requests to Binder. Every write requires the `X-Binder: 1` header. A cross-origin page can send a custom header only after a CORS preflight, and Binder never approves one. Session cookies are `SameSite=Strict`, and an opaque origin is never same-site, so its requests carry no session at all.

**The UI shell.** Binder's own pages carry a strict CSP: only Binder's scripts run, only Binder's content is framed, and Binder cannot be framed. Publisher metadata is rendered as text, and `source_url` must be http or https, so a details link can never run script. A browser test publishes hostile metadata and checks that no script runs and no CSP rule fires.

## Previews

Previews are off unless you choose the `full` image. Both reviews flagged the same risk: Chromium runs without its own process sandbox (an unprivileged container cannot give it one), so a Chromium bug in publisher HTML would reach the container's user and the data folder. Publishers are authenticated, but their agents may copy content from anywhere. The `slim` image shows a generated cover instead.

When previews are on, these layers keep a page from capturing anything it should not see:

1. **No `file://`.** Chromium loads a wrapper page from Binder over loopback http. Local files are never reachable.
2. **A pinned wrapper.** The wrapper's CSP allows one frame: this version's render URL. The frame is sandboxed with `allow-scripts` only, so it cannot open popups, navigate the top page, or navigate itself anywhere else.
3. **A render-mode CSP.** The artifact may load only from Binder and a short list of public CDNs (`BINDER_PREVIEW_HOSTS`), with no frames, objects, or workers. A nested document, even another artifact's view URL on Binder's origin, would not carry this policy, so none are allowed.
4. **A network allowlist.** Chromium sends everything to a dead proxy except Binder's own loopback address and the CDN list. This also stops connections that CSP never sees, such as speculative preconnects, which CI caught.

CI runs real Chromium against 21 attacks aimed at an internal http service, a raw TCP listener on loopback and on the container's own address, and other artifacts' view URLs. The pass condition is zero requests and zero TCP connections. A mutation test (render without the wrapper) makes it fail.

## Authentication

Binder answers one question per request: who is this, and may they read or write? Three sources can answer it. The order is fixed.

1. **`Authorization: Bearer <token>`.** If the header is present, it must be a valid token. Binder never falls through to another source.
2. **Session cookie.** A person pastes a token once on the sign-in page. Binder sets `binder_session`, an HMAC-signed `<token id>.<expiry>` value (`HttpOnly`, `SameSite=Strict`, `Secure` on https, 30 days). Revoking the token ends the session.
3. **Trusted proxy header**, only when `BINDER_AUTH_HEADER` is set. The header counts only when the request comes from an address in `BINDER_TRUSTED_PROXIES` (default `127.0.0.1,::1`), and its value must match `BINDER_ALLOWED_USERS` (exact logins, `*@domain`, or `*`). Otherwise it is ignored and logged. Tailscale is this mode with `BINDER_AUTH_HEADER=Tailscale-User-Login`.

The peer check stops other containers and other hosts from claiming an identity. It does not stop processes on the same host, which can reach the proxy's backend port anyway: through a Docker port mapping, every host process appears as the bridge gateway. The proxy must also overwrite the header on every request. `tailscale serve` does (reasoned from its documentation, not tested here).

With none of these, the API answers 401. `BINDER_DEV_ANONYMOUS=1` turns auth off for local development only.

- **Tokens** have a name (a person or an agent: `alice`, `ci-bot`) and a scope: `read` or `write`. Binder stores only the SHA-256 of the secret. The format is `bnd_<id>_<secret>`: lookup by id, then a constant-time hash compare.
- **Token management is a CLI on the server** (`binder token create|list|revoke`), not an HTTP API. Whoever can run commands where the data folder lives is the admin. That removes admin roles, an admin UI, and the most dangerous endpoints. A stranger gets the first token with one `docker compose exec` command.
- **What is public:** `/healthz` and the static UI shell (no data). Everything under `/api/`, `/thumb/`, and `/raw/` needs an identity. `/c/` needs a valid signature.
- **What the history records:** `published_by` is the authenticated name. `agent` and `host` are what the publisher says about itself.

**Why not built-in OIDC.** It is the most code and the most security surface. It also does not help agents, which need tokens anyway. A team with SSO can put an identity-aware proxy in front and use header mode. That path is documented as a recipe, not tested in CI. The proxy must let `/c/` through, because those requests carry no cookie, and it must overwrite the identity header on every route.

**Why not per-artifact permissions.** A Binder instance is one team's shelf. A team that needs a wall between groups runs two instances. Each is one container and one folder.

## Agent integration

Options considered, for agents in Claude Code, Codex, T3 Code, and anything else:

| Option | Install on agent host | Works in every harness | Verdict |
|---|---|---|---|
| Skill text + `curl` | None | Yes, any shell | **Chosen** |
| Tiny CLI (`binder publish`) | A binary or script on every host | Yes | Rejected. It wraps one `curl` call and adds an install and an update path. |
| MCP server | Config in each harness, a running process | Only where MCP is set up | Rejected. A remote MCP server cannot read the agent's local files, so the agent sends the whole page as a tool argument. A local one is an install on every host. |

The repo ships a generic skill (`skill/binder/SKILL.md`) that reads `BINDER_URL` and an optional `BINDER_TOKEN`. Anyone can drop it into their agent's skills folder.

## Publish contract

The API is version 1. Changes inside v1 are additive only: new optional request fields and new response fields. A breaking change gets a new path prefix.

Additions in this review, all optional: an `Authorization` header, a `note` field in `meta`, and `published_by`, `note`, and `content_url` in responses. Two behaviors tightened: `source_url` must be http or https (400 otherwise), and `/raw/` answers with a redirect instead of bytes. A caller with no credential now gets 401 instead of 403. Existing agents that publish with `curl` keep working unchanged.

## Configuration

All configuration comes from environment variables with safe defaults. See [self-hosting.md](self-hosting.md).

## Deployment targets

Docker and docker compose, bare Bun, and Fly.io as the documented cloud example. The image is built for `linux/amd64` and `linux/arm64`. CI boots the real `slim` and `full` images from a clean volume, makes the first token with the CLI, publishes, views, checks history, runs as a fixed `--user`, and runs the browser sandbox and UI tests.

The container starts as root only to give `/data` to the unprivileged `bun` user, then drops to it. A fresh cloud volume is root-owned, so an image that started as `bun` could not write to it.
