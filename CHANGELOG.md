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
- `BINDER_AUTH` picks how people sign in: `token` (default), `none`, `oidc`, or `header`. Bearer tokens work in every mode, so agents publish the same way everywhere.
- Single sign-on with OpenID Connect (`BINDER_AUTH=oidc`): Keycloak, Okta, Entra ID, Google, Authentik, and others. Authorization code flow with PKCE, `state`, and `nonce`; Binder verifies the ID token itself, with one configured algorithm (`BINDER_OIDC_SIGNING_ALG`: RS256, PS256, or ES256). Allow people by email (`BINDER_ALLOWED_USERS`), group (`BINDER_ALLOWED_GROUPS`), or Google Workspace domain (`BINDER_OIDC_HOSTED_DOMAIN`, checked against the signed `hd` claim). SSO sessions last 8 hours. The issuer, its endpoints, and `BINDER_PUBLIC_URL` must be https except on loopback (`BINDER_OIDC_ALLOW_HTTP=true` is for test networks only). CI signs in through a real Keycloak.
- `BINDER_AUTH=none` for one person on a laptop. It answers only requests addressed to `localhost`, `127.0.0.1`, `[::1]`, or the host of `BINDER_PUBLIC_URL` (421 otherwise), against DNS rebinding.
- A signed-out `GET /api/session` says which sign-in is on (`auth`, and `label` in oidc mode).

### Changed

- `BINDER_AUTH_HEADER` with an explicit `BINDER_AUTH` other than `header` stops startup. With `BINDER_AUTH` unset, `BINDER_AUTH_HEADER` alone still means header mode.
- The `binder token` CLI reads only the data folder, so auth settings never stop an admin from making a token.
- Configuration that Binder would ignore now stops startup: a blank `BINDER_AUTH`, a setting that belongs to another auth mode (such as `BINDER_ALLOWED_GROUPS` with `BINDER_AUTH=none`, or `BINDER_TRUSTED_PROXIES` outside header mode), and a `BINDER_PUBLIC_URL` that is not an `http` or `https` origin. Hosting under a subpath is not supported.

- Artifact content is served from signed, expiring URLs (`/c/...`), because sandboxed pages send no cookies. `/raw/...` links redirect there.
- Previews render through a pinned wrapper with a CDN-only CSP and a network allowlist.
- The UI shell has a strict CSP. `source_url` must be `http` or `https`.
- Database schema v2. Binder 0.1 data upgrades on first start. Back up first: an older Binder cannot read the new schema.

### Removed

- `BINDER_DEV_ANONYMOUS`. Use `BINDER_AUTH=none`. Binder refuses to start when it sees the old name.

- `ALLOWED_LOGINS` and `DEV_ALLOW_ANONYMOUS`. Binder refuses to start when it sees them, so auth never changes silently. See [docs/self-hosting.md](docs/self-hosting.md).

## [0.1.0] - 2026-11-14

Initial private version: one library of agent-built pages behind Tailscale, with previews, filters, and a publish API.

[Unreleased]: https://github.com/pb3975/binder/commits/main
[0.1.0]: https://github.com/pb3975/binder
