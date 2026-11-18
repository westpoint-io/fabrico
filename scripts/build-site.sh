#!/usr/bin/env bash
#
# The one command that builds the docs site in site/.
#
# It builds the WebAssembly player (scripts/build-wasm.sh), then the read-only board bundle and its
# posters from that player (scripts/build-embed.sh), then the README's animated hero from that
# bundle (frontend/scripts/capture-hero.ts, which checks the hero and fails the build on a blank,
# still or wrong one), then the site itself (`npm run build` in site/). The site's build first runs
# frontend/scripts/build-site-assets.ts, which copies the bundle, the posters and the hero into
# site/public/ and writes site/src/generated/boards.json, then runs `astro build`, which writes the
# static site to site/dist/. Building all of them every time keeps the site's player, renderer,
# boards and hero from one commit. The hero is never committed: each site build makes it again.
#
# Then it builds the site a second time with `npm run build:fixtures`, which also takes the test
# pages whose file name starts with _ and writes to site/dist-fixtures/. The docs suite serves that
# folder on a second port. site/dist/, the folder that gets published, never holds a test page.
#
# OUTPUT, exactly one line on stdout after the builds' own output (which includes capture-hero's
# HERO line):
#   SITE_BUILD pages=<n> boards=<n> bytes=<n> fixtures=<n>
# pages counts the index.html files under site/dist, boards counts the <fabrico-board openings
# across them, bytes is the total size of site/dist, and fixtures counts the test pages built into
# site/dist-fixtures (its index.html files that site/dist doesn't have).
#
# ENVIRONMENT
#   WASM_OPT          the wasm-opt binary, from scripts/install-wasm-opt.sh. Required.
#   FABRICO_WASM_OUT  where the player module goes. Defaults to target/wasm-out under the repo root.
#   CARGO_TARGET_DIR  cargo's build folder for the player, passed through to scripts/build-wasm.sh.
#
# EXIT CODES
#   0  the site was built and the line was printed.
#   2  no build: site/node_modules is missing (run `npm ci --ignore-scripts` in site/), or WASM_OPT
#      is unset. scripts/build-wasm.sh, scripts/build-embed.sh and frontend/scripts/capture-hero.ts
#      also exit 2 on their own missing pieces, and that code comes through.
#   Any other non-zero code is a build step's own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [ ! -d "$ROOT/site/node_modules" ]; then
  echo "build-site: site/node_modules is missing. Run npm ci --ignore-scripts in site/ first." >&2
  exit 2
fi
if [ -z "${WASM_OPT:-}" ]; then
  echo "build-site: WASM_OPT is unset. Set it to the path scripts/install-wasm-opt.sh prints." >&2
  exit 2
fi

OUT="${FABRICO_WASM_OUT:-$ROOT/target/wasm-out}"

bash "$ROOT/scripts/build-wasm.sh"
bash "$ROOT/scripts/build-embed.sh"
(cd "$ROOT/frontend" && node scripts/capture-hero.ts)

WASM="$(cd "$OUT" && pwd -P)/fabrico_player.wasm"
(cd "$ROOT/site" && FABRICO_PLAYER_WASM="$WASM" npm run build)
(cd "$ROOT/site" && FABRICO_PLAYER_WASM="$WASM" npm run build:fixtures)

DIST="$ROOT/site/dist"
PAGES="$(find "$DIST" -name index.html -type f | wc -l)"
BOARDS="$( (find "$DIST" -name index.html -type f -print0 | xargs -0 grep -o '<fabrico-board' || true) | wc -l)"
BYTES="$(du -sb "$DIST" | cut -f1)"
FIXTURE_DIST="$ROOT/site/dist-fixtures"
FIXTURES=0
while IFS= read -r -d '' page; do
  if [ ! -f "$DIST/${page#"$FIXTURE_DIST"/}" ]; then FIXTURES=$((FIXTURES + 1)); fi
done < <(find "$FIXTURE_DIST" -name index.html -type f -print0)
echo "SITE_BUILD pages=$((PAGES)) boards=$((BOARDS)) bytes=$((BYTES)) fixtures=$((FIXTURES))"
