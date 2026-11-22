#!/usr/bin/env bash
# This repo is public, so a fork's pull request must never reach a private machine (AGENTS.md), and a
# moved tag in a third-party action must never change what CI runs. Fails on:
#   - a runs-on that is not a literal GitHub-hosted label (self-hosted, a variable, or an expression);
#   - a `uses:` that is not pinned to a full commit SHA (local ./ actions are fine).
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
while IFS= read -r line; do
  echo "not a GitHub-hosted runner: $line"; fail=1
done < <(grep -nE '^\s*runs-on:' .github/workflows/*.yml | grep -vE 'runs-on: (ubuntu|windows|macos)-[a-z0-9.]+(-arm)?(\s*#.*)?$' || true)
while IFS= read -r line; do
  echo "action not pinned to a commit SHA: $line"; fail=1
done < <(grep -nE '^\s*-?\s*uses:' .github/workflows/*.yml | grep -vE 'uses: (\./|[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}(\s*#.*)?$)' || true)
[ "$fail" = 0 ] && echo "workflows ok"
exit "$fail"
