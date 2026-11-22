#!/usr/bin/env bash
# Builds the landing page and checks it in real Chromium, served under /binder/ as GitHub Pages serves it.
# Usage: scripts/e2e-site.sh
#   CHROMIUM=<path>   the browser to use (default: the first Chrome or Chromium found, then Playwright's)
#   SHOTS=<dir>       also save screenshots there, for each width and color scheme
set -euo pipefail
cd "$(dirname "$0")/.."
chromium=${CHROMIUM:-}
if [ -z "$chromium" ]; then
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null; then chromium=$(command -v "$c"); break; fi
  done
fi
if [ -z "$chromium" ]; then
  for c in "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome; do  # Playwright's; the newest sorts last
    if [ -x "$c" ]; then chromium=$c; fi
  done
fi
if [ -z "$chromium" ] || [ ! -x "$chromium" ]; then
  echo "e2e-site: no Chrome or Chromium found. Set CHROMIUM=/path/to/chrome." >&2
  exit 1
fi
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
scripts/build-site.sh "$out/binder" >/dev/null
[ -z "${SHOTS:-}" ] || mkdir -p "$SHOTS"
echo "e2e-site: $("$chromium" --version 2>/dev/null || echo "$chromium")"
CHROMIUM=$chromium SITE_DIR="$out/binder" bun test/e2e/site.ts
