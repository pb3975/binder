# Binder agent instructions

Read [README.md](README.md), [docs/design.md](docs/design.md), [docs/development.md](docs/development.md), and [docs/decisions.md](docs/decisions.md) first.

- Never weaken artifact sandboxing: the CSP `sandbox` header on `/c/`, the iframe `sandbox` without `allow-same-origin`, the `X-Binder: 1` requirement on writes, or the UI shell's CSP.
- Never render artifacts from `file://` or without the `/render` wrapper and its network allowlist. `scripts/e2e.sh` checks this.
- Never hard-delete artifact data. Removal is a soft delete (`deleted_at`); version folders never change after publish.
- Keep the publish API (`POST /api/artifacts`, `meta` fields, `X-Binder: 1`) backward compatible. Changes inside v1 are additive. Update `skill/binder/SKILL.md` in the same change.
- Never bind the server to a public interface in examples, and never add a way to expose it without auth.
- Use synthetic data in tests, fixtures, and screenshots. Never commit host names, logins, or tokens. Deployment settings live in `deploy/ssh/local.env`, which git ignores.
- Run `bun run check` and `scripts/e2e.sh` before a PR. Merging to `main` does not deploy; `deploy/ssh/ship.sh` does.
