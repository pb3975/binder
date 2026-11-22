# Binder agent instructions

Read [README.md](README.md), [docs/design.md](docs/design.md), [docs/development.md](docs/development.md), and [docs/decisions.md](docs/decisions.md) first.

- Never weaken artifact sandboxing: the CSP `sandbox` header on `/c/`, the iframe `sandbox` without `allow-same-origin`, the `X-Binder: 1` requirement on writes, or the UI shell's CSP.
- Never render artifacts from `file://` or without the `/render` wrapper and its network allowlist. `scripts/e2e.sh` checks this.
- Never hard-delete artifact data. Removal is a soft delete (`deleted_at`); version folders never change after publish.
- Keep the publish API (`POST /api/artifacts`, `meta` fields, `X-Binder: 1`) backward compatible. Changes inside v1 are additive. Update `skill/binder/SKILL.md` in the same change.
- Never bind the server to a public interface in examples, and never add a way to expose it without auth. `BINDER_AUTH=none` is the one exception: an explicit opt-in, guarded by the `Host` check (421 for any name but loopback and `BINDER_PUBLIC_URL`'s host). Examples never pair it with a public bind (`HOST=0.0.0.0`) or an internet-facing deployment.
- Use synthetic data in tests, fixtures, and screenshots. Never commit host names, logins, or tokens. Deployment settings live in `deploy/ssh/local.env`, which git ignores.
- Workflows run on GitHub-hosted runners only (`runs-on: ubuntu-latest` or another GitHub label). Never read `runs-on` from a variable or use `self-hosted`: this repo is public, so a fork's pull request must never reach a private machine.
- Never weaken OIDC sign-in: PKCE, `state`, `nonce`, the redirect URI from `BINDER_PUBLIC_URL` only, the RS256/PS256/ES256 allowlist, and exact `iss` and `aud` checks. `test/oidc.test.ts` and `scripts/e2e-oidc.sh` check this.
- Run `bun run check` and `scripts/e2e.sh` before a PR, and `scripts/e2e-oidc.sh` when auth changes. Merging to `main` does not deploy; `deploy/ssh/ship.sh` does.
