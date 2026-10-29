#!/usr/bin/env bash
#
# Golden-corpus regen / re-bless wrapper (criterion 4 / REPLAY-03).
#
# EXPLICIT only — this script NEVER runs on a test failure and NEVER overwrites a
# fixture without a subcommand. Freezing or re-blessing a golden hash manifest is a
# deliberate, reviewed act (the corpus is asserted forever — threat T-3-BLESS).
#
#   regen-golden.sh new   <id>   # freeze a brand-new scenario (gen_<id> must exist)
#   regen-golden.sh bless <id>   # re-freeze an EXISTING scenario after a reviewed,
#                                #   deliberate behavior change — then REVIEW the diff.
#
# Both modes simply run the matching #[ignore]d generator, which (re)writes the
# fixture's five files (genesis.snapshot, edit-log.postcard, log.postcard,
# hashes.txt, meta.toml):
#   cargo test -p fabrico-core --test regen -- --ignored --exact gen_<id>

set -euo pipefail

# Resolve repo root so the script works from any cwd.
cd "$(git rev-parse --show-toplevel)"

usage() {
    cat >&2 <<'USAGE'
usage: scripts/regen-golden.sh <new|bless> <scenario-id>

  new   <id>   freeze a brand-new scenario  (the generator gen_<id> must exist in tests/regen.rs)
  bless <id>   re-freeze an EXISTING scenario after a reviewed, deliberate behavior change

  <id> is the fixture directory name, e.g. 0001-source-belt-collector
       (the generator is gen_<id with dashes kept>, e.g. gen_0001_source_belt_collector)

examples:
  scripts/regen-golden.sh new   0005-my-new-scenario
  scripts/regen-golden.sh bless 0001-source-belt-collector
USAGE
    exit 2
}

[ "$#" -eq 2 ] || usage
MODE="$1"
ID="$2"

# Map the fixture id (dashed) to its generator fn name: gen_<id with '-' -> '_'>.
GEN="gen_${ID//-/_}"

# Fixture directory the generator (re)writes.
DIR="crates/fabrico-core/tests/golden/${ID}"

# Guard the new/bless distinction so it is no longer cosmetic (T-3-BLESS):
#   `new`   MUST NOT overwrite an existing frozen fixture — re-freezing the corpus
#           is the louder, reviewed `bless` act (which prints the hash-diff warning).
#   `bless` MUST target an existing fixture — there is nothing to RE-bless otherwise.
case "$MODE" in
    new)
        if [ -e "$DIR" ]; then
            echo "error: fixture '${ID}' already exists at ${DIR}." >&2
            echo "       Re-freezing an existing corpus is a reviewed act: use" >&2
            echo "         scripts/regen-golden.sh bless ${ID}" >&2
            echo "       (and then REVIEW the hash diff)." >&2
            exit 2
        fi
        ;;
    bless)
        if [ ! -e "$DIR" ]; then
            echo "error: fixture '${ID}' does not exist at ${DIR}." >&2
            echo "       Nothing to re-bless; freeze a brand-new scenario with" >&2
            echo "         scripts/regen-golden.sh new ${ID}" >&2
            exit 2
        fi
        ;;
esac

run_generator() {
    echo "[regen-golden] freezing fixture '${ID}' via ${GEN} ..."
    cargo test -p fabrico-core --test regen -- --ignored --exact "${GEN}"
    echo "[regen-golden] wrote crates/fabrico-core/tests/golden/${ID}/ (genesis.snapshot, edit-log.postcard, log.postcard, hashes.txt, meta.toml)"
}

case "$MODE" in
    new)
        run_generator
        echo
        echo "[regen-golden] NEW fixture frozen. Next steps:"
        echo "  1. Register it in tests/cert_cross_platform.rs (add one CORPUS record)."
        echo "  2. Run: cargo test -p fabrico-core --test cert_cross_platform"
        echo "  3. Commit all five data files + the runner/generator edits."
        ;;
    bless)
        run_generator
        echo
        echo "[regen-golden] RE-BLESSED. The corpus is asserted FOREVER — REVIEW the hash diff:"
        echo "    git diff -- crates/fabrico-core/tests/golden/${ID}/hashes.txt"
        echo "  A changed hash means the simulation's deterministic output moved."
        echo "  Only commit if that behavior change is intended and reviewed."
        ;;
    *)
        echo "error: unknown subcommand '${MODE}'" >&2
        usage
        ;;
esac
