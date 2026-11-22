#!/usr/bin/env bash
# Assembles the landing page (site/) into a folder that GitHub Pages serves as is.
# Fonts, the icon, and screenshots come from their one owner in the repo, so git holds one copy.
# Usage: scripts/build-site.sh [outdir]        (default _site/). Safe to rerun: it replaces what it built before.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -gt 0 ]; then out=$1; else out=$root/_site; fi
case "$out" in "" | / | "$root" | "$root/") echo "build-site: refusing to write to '$out'" >&2; exit 1 ;; esac
mkdir -p "$out"
out=$(cd "$out" && pwd)
if [ "$out" = / ] || [ "$out" = "$root" ]; then echo "build-site: refusing to write to '$out'" >&2; exit 1; fi
# Only ever clear a folder this script made (it holds .nojekyll) or an empty one.
if [ -n "$(ls -A "$out")" ] && [ ! -e "$out/.nojekyll" ]; then
  echo "build-site: $out is not empty and was not made by this script; refusing to clear it" >&2; exit 1
fi

# The screenshots the page uses. Add one here when the page shows a new one.
images=(library.png library-dark.png)

rm -rf "${out:?}"/* "$out/.nojekyll"
cp "$root"/site/* "$out/"
mkdir -p "$out/fonts" "$out/images"
cp "$root"/public/fonts/*.woff2 "$out/fonts/"
cp "$root/public/icon.svg" "$out/"
for f in "${images[@]}"; do cp "$root/docs/images/$f" "$out/images/"; done
touch "$out/.nojekyll"
echo "built $out"
