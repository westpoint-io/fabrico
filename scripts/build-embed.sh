#!/usr/bin/env bash
#
# Builds the read-only board bundle, its posters, and the self-contained test pages from it.
#
# It runs the Vite library build in frontend/ (vite.embed.config.ts), which inlines the player
# module, every example board and the hash manifest into frontend/dist-embed/fabrico-board.js and
# refuses a bundle that would carry editor, React or Tauri code. Then it runs
# frontend/scripts/capture-posters.ts, which opens that bundle in headless Chromium, runs each
# board to its end tick and saves its stage as frontend/dist-embed/posters/<board id>.png. Then it
# builds the bundle again with the posters inlined, and with FABRICO_EMBED_REQUIRE_POSTERS=1, so a
# board without a poster fails the build. Last, it wraps the bundle into each page under
# frontend/e2e-embed/pages/ and writes the results to frontend/dist-embed/pages/. Both output
# folders are gitignored.
#
# The poster step needs Playwright's Chromium (`npx playwright install chromium`).
#
# OUTPUT, exactly one line on stdout after the build's own output:
#   EMBED_BUILD bundle=<bytes> boards=<n> pages=<n> posters=<n>
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the player module is. Defaults to target/wasm-out under the repo root.
#                     Build it with scripts/build-wasm.sh.
#
# EXIT CODES
#   0  the bundle, the posters and the pages were built and the line was printed.
#   2  no build: the player module is missing or empty.
#   Any other non-zero code is Vite's, the poster capture's or the page wrapper's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
WASM="$(cd "$OUT" 2>/dev/null && pwd -P)/fabrico_player.wasm" || WASM="$OUT/fabrico_player.wasm"

if [ ! -s "$WASM" ]; then
  echo "build-embed: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

cd "$ROOT/frontend"

# Build, capture the posters from that build, then build again with them.
FABRICO_PLAYER_WASM="$WASM" node node_modules/vite/bin/vite.js build --config vite.embed.config.ts
node scripts/capture-posters.ts

# The second build empties dist-embed/, so the posters wait in a folder of their own meanwhile.
POSTER_STAGING="$(mktemp -d)"
trap 'rm -rf "$POSTER_STAGING"' EXIT
cp dist-embed/posters/*.png "$POSTER_STAGING"/
FABRICO_PLAYER_WASM="$WASM" FABRICO_EMBED_POSTERS="$POSTER_STAGING" FABRICO_EMBED_REQUIRE_POSTERS=1 \
  node node_modules/vite/bin/vite.js build --config vite.embed.config.ts
mkdir -p dist-embed/posters
cp "$POSTER_STAGING"/*.png dist-embed/posters/

node scripts/build-offline.ts --pages e2e-embed/pages dist-embed/pages

BUNDLE_BYTES="$(wc -c <dist-embed/fabrico-board.js)"
BOARDS="$(find "$ROOT/examples/boards" -name '*.board.ron' -type f | wc -l)"
PAGES="$(find dist-embed/pages -maxdepth 1 -name '*.html' -type f | wc -l)"
POSTERS="$(find dist-embed/posters -maxdepth 1 -name '*.png' -type f | wc -l)"
echo "EMBED_BUILD bundle=$((BUNDLE_BYTES)) boards=$((BOARDS)) pages=$((PAGES)) posters=$((POSTERS))"
