#!/usr/bin/env bash
#
# Builds the read-only board bundle and the self-contained test pages from it.
#
# It runs the Vite library build in frontend/ (vite.embed.config.ts), which inlines the player
# module, every example board and the hash manifest into frontend/dist-embed/fabrico-board.js and
# refuses a bundle that would carry editor, React or Tauri code. Then it wraps the bundle into each
# page under frontend/e2e-embed/pages/ and writes the results to frontend/dist-embed/pages/. Both
# output folders are gitignored.
#
# OUTPUT, exactly one line on stdout after the build's own output:
#   EMBED_BUILD bundle=<bytes> boards=<n> pages=<n>
#
# ENVIRONMENT
#   FABRICO_WASM_OUT  where the player module is. Defaults to target/wasm-out under the repo root.
#                     Build it with scripts/build-wasm.sh.
#
# EXIT CODES
#   0  the bundle and the pages were built and the line was printed.
#   2  no build: the player module is missing or empty.
#   Any other non-zero code is Vite's or the page wrapper's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"
WASM="$(cd "$OUT" 2>/dev/null && pwd -P)/fabrico_player.wasm" || WASM="$OUT/fabrico_player.wasm"

if [ ! -s "$WASM" ]; then
  echo "build-embed: $WASM is missing or empty. Run scripts/build-wasm.sh first." >&2
  exit 2
fi

cd "$ROOT/frontend"
FABRICO_PLAYER_WASM="$WASM" node node_modules/vite/bin/vite.js build --config vite.embed.config.ts
node scripts/build-offline.ts --pages e2e-embed/pages dist-embed/pages

BUNDLE_BYTES="$(wc -c <dist-embed/fabrico-board.js)"
BOARDS="$(find "$ROOT/examples/boards" -name '*.board.ron' -type f | wc -l)"
PAGES="$(find dist-embed/pages -maxdepth 1 -name '*.html' -type f | wc -l)"
echo "EMBED_BUILD bundle=$((BUNDLE_BYTES)) boards=$((BOARDS)) pages=$((PAGES))"
