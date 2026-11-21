# Changelog

All notable changes to Binder are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Binder uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). [docs/releasing.md](docs/releasing.md) says what each kind of version bump means for Binder.

## [Unreleased]

### Added

- Version history. Publishing the same `id` again makes a new version. The history shows who published each version, when, their note, and which files changed. Old versions open at their own URL, and restore copies one forward as a new version.
- Download any version: one file as itself, several files as a zip (`GET /api/artifacts/:id[/versions/:n]/download`).
- Named tokens with `read` or `write` scope, managed by the `binder token` CLI. Only a hash of each token is stored.
- Browser sign-in with a token. Binder sets a 30-day `HttpOnly`, `SameSite=Strict` session cookie.
- Header mode for Tailscale and other sign-in proxies (`BINDER_AUTH_HEADER`, `BINDER_ALLOWED_USERS`, `BINDER_TRUSTED_PROXIES`).
- The `slim` image (no Chromium) is the default. The `full` image renders previews.
- Docker Compose quick start, a Fly.io example, multi-arch images (amd64 and arm64), and a drop-in agent skill (`skill/binder/SKILL.md`).
- `/healthz` reports the version and build.
- `/llms.txt` serves the publish instructions to any agent, with the instance's URL and auth filled in.

### Changed

- Artifact content is served from signed, expiring URLs (`/c/...`), because sandboxed pages send no cookies. `/raw/...` links redirect there.
- Previews render through a pinned wrapper with a CDN-only CSP and a network allowlist.
- The UI shell has a strict CSP. `source_url` must be `http` or `https`.
- Database schema v2. Binder 0.1 data upgrades on first start. Back up first: an older Binder cannot read the new schema.

### Removed

- `ALLOWED_LOGINS` and `DEV_ALLOW_ANONYMOUS`. Binder refuses to start when it sees them, so auth never changes silently. See [docs/self-hosting.md](docs/self-hosting.md).

## [0.1.0] - 2026-11-14

Initial private version: one library of agent-built pages behind Tailscale, with previews, filters, and a publish API.

[Unreleased]: https://github.com/pb3975/binder/commits/main
[0.1.0]: https://github.com/pb3975/binder
