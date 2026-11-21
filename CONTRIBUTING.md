# Contributing

Thanks for helping. Binder is deliberately small, so the bar for new features is "does this belong in a library of agent-built pages?" Bug fixes, security hardening, docs, and self-hosting recipes are always welcome.

## Before you start

- Read [docs/design.md](docs/design.md). It lists the product invariants that every change must keep, and what Binder will not do.
- For anything larger than a bug fix, open an issue first and describe the problem. A short conversation saves a rewritten pull request.

## Make a change

1. `bun install`, then `bun run dev` for a local server with auth off and data in `./data`.
2. `bun scripts/demo.ts` fills it with synthetic artifacts that have version history.
3. Keep the change focused. One pull request, one idea.
4. Add or update tests for the behavior you changed:
   - `test/*.test.ts` for the server (`bun test`).
   - `test/e2e/` for anything a browser or the container must prove (`scripts/e2e.sh`).
5. Run `bun run check` and `scripts/e2e.sh`. CI runs both, plus the `slim` image.
6. For UI changes, attach before and after screenshots (`SHOTS=/tmp/shots scripts/e2e.sh` saves some).

## Rules that keep Binder safe

- Never weaken the artifact sandbox: the CSP `sandbox` header on `/c/`, the iframe `sandbox` without `allow-same-origin`, or the `X-Binder: 1` requirement on writes.
- Never render artifacts from `file://` or without the `/render` wrapper.
- Never hard-delete artifact data. Removal is a soft delete; version folders never change after publish.
- Keep the publish API backward compatible. Changes inside v1 are additive.
- No new runtime dependencies without a written reason in the pull request.
- Use synthetic data in tests and screenshots.

## Style

TypeScript with strict types, no build step, and small modules. Comments explain why, not what. Record material design decisions in [docs/decisions.md](docs/decisions.md).
