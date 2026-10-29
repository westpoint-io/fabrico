#!/usr/bin/env bash
#
# SC#5 negative-lint gate.
#
# Proves *mechanically* that the determinism build gate actually bites: it is not
# enough that the clippy lints exist in clippy.toml — the build must FAIL the
# moment a determinism-killer appears in fabrico-core, and recover once it is
# removed. The gate is proven for BOTH disallowed-lint families:
#   * disallowed-TYPES   (a float + an unordered HashMap), and
#   * disallowed-METHODS (an ambient `std::env::var` read).
#
# Why both families matter: tests/regen.rs carries a file-scoped
# `#![allow(clippy::disallowed_methods)]` so the corpus generator can use std::fs.
# That allow is only SAFE if the disallowed-METHODS lint is independently proven to
# bite elsewhere — otherwise a mis-configured methods list (typo'd path, wrong
# entry) would stay green and the regen allow could silently mask a determinism
# killer. A types-only probe never exercises the methods family, so this script
# now plants a methods killer too. `std::env::var` is a disallowed-METHOD that is
# NOT a disallowed-TYPE, so it trips the methods gate SPECIFICALLY.
#
# Acceptance is THIS SCRIPT'S EXIT CODE, never a source grep — so the banned
# tokens written into the probes below can never become a self-invalidating grep
# gate. The script exits 0 only when:
#   (1) the clean tree passes  `cargo clippy --all-targets --all-features -- -D warnings`
#   (2) injecting an f64 + std::collections::HashMap probe makes that command FAIL, on
#       clippy::disallowed_types at the probe file
#   (3) removing the probe restores the green gate
#   (4) injecting a std::env::var probe makes that command FAIL on
#       clippy::disallowed_methods at the probe file (methods family)
#   (5) removing the probe restores the green gate
#
# Each probe is a NEW, untracked throwaway integration-test file. The isolation is
# scripts/lib/prover-isolation.sh's Shape A (plan 84-04, GATE-03): it refuses to start if
# either probe path already exists or is tracked, removes both in its EXIT trap even if the
# script aborts midway, and compares the tracked tree before and after.
#
# WHILE THIS RUNS, OTHER CARGO GATES IN THE SAME CHECKOUT ARE RED (review 84 WR-11). The
# probes sit in crates/fabrico-core/tests/, so any `cargo test --workspace` or `cargo
# clippy --all-targets` started in this checkout during the run (about a minute on a
# desktop) compiles them and fails for a reason that is not its own. Do not run this
# locally while other gates are running in the same checkout; a red that overlaps a run of
# this script is unproven until re-run. It stays Shape A on purpose: Shape B would rebuild
# fabrico-core cold in a private target on all three determinism legs of every push, and
# the macOS leg bills ten times its minutes (D-01). In CI the runner is the only writer.

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

# Resolve repo root so the script works from any cwd.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PROBE_TYPES="crates/fabrico-core/tests/_determinism_probe.rs"
PROBE_METHODS="crates/fabrico-core/tests/_determinism_method_probe.rs"
CLIPPY=(cargo clippy --all-targets --all-features -- -D warnings)

prover_isolate_untracked "$PROBE_TYPES" "$PROBE_METHODS"

cleanup() {
    rm -f "$PROBE_TYPES" "$PROBE_METHODS"
}
prover_on_exit cleanup

# names_probe OUT PROBE: OUT names PROBE. Rustc prints a workspace member's path with the
# host's separator, so on the Windows determinism leg the probe reads
# `crates\fabrico-core\tests\_determinism_probe.rs` (review 84 iteration 2 CR-01). Every
# backslash is turned into a slash before the fixed-string match, so one PROBE path (always
# written with `/`) is found on all three legs.
names_probe() {
    # shellcheck disable=SC1003  # '\\' is tr's escaped backslash, not a quote escape
    printf '%s\n' "$1" | tr '\\' '/' | grep -F -- "$2" >/dev/null
}

# The Windows form is checked on EVERY leg before any probe is written, so the separator
# handling is proven on Linux and macOS too, where clippy never prints a backslash. The
# sample is a diagnostic location line as rustc prints it on Windows.
if ! names_probe '   --> crates\fabrico-core\tests\_determinism_probe.rs:11:23' "$PROBE_TYPES"; then
    echo "FAIL: names_probe cannot find ${PROBE_TYPES} in a Windows-style diagnostic line;" >&2
    echo "      the Windows determinism leg would refuse every real bite. NOT MEASURED." >&2
    exit 2
fi

# expect_bite LINT PROBE WHAT: with PROBE present, clippy must FAIL, and fail on LINT at
# PROBE (review 84 WR-13). Any other failure (a compile error, a toolchain download, a
# cargo lock, another writer's half-saved edit) is not this gate biting: exit 2, with the
# tail of clippy's output, never counted as proof. Clippy names the lint as
# `clippy::disallowed_types` in its help line and `clippy::disallowed-types` in its note.
expect_bite() {
    local lint="$1" probe="$2" what="$3" out rc=0 pat
    out="$("${CLIPPY[@]}" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
        echo "FAIL: the gate did NOT bite: clippy passed with ${what} present." >&2
        return 1
    fi
    pat="clippy::$(printf '%s' "$lint" | sed 's/_/[-_]/g')"
    if ! printf '%s\n' "$out" | grep -E "$pat" >/dev/null; then
        echo "FAIL: clippy exited ${rc} with ${what} present, but not on ${lint}; the proof" >&2
        echo "      could not be made. The last lines of its output:" >&2
        printf '%s\n' "$out" | tail -20 | sed 's/^/        /' >&2
        exit 2
    fi
    if ! names_probe "$out" "$probe"; then
        echo "FAIL: clippy reported ${lint}, but not at ${probe}; something else in the tree" >&2
        echo "      tripped it, so the proof could not be made. The last lines of its output:" >&2
        printf '%s\n' "$out" | tail -20 | sed 's/^/        /' >&2
        exit 2
    fi
    return 0
}

echo "[1/5] asserting the CLEAN tree passes the determinism gate ..."
if ! "${CLIPPY[@]}"; then
    echo "FAIL: clean tree does not pass the determinism gate (it must)." >&2
    exit 1
fi
echo "      clean tree: GREEN"

echo "[2/5] injecting a disallowed-TYPES killer probe and asserting the gate BITES ..."
cat > "$PROBE_TYPES" <<'PROBE_EOF'
//! THROWAWAY probe for the SC#5 negative-lint gate (disallowed-TYPES family).
//! Created and deleted by scripts/determinism-gate-negative-test.sh. If you are
//! seeing this committed, something went wrong — delete it.
#[test]
fn determinism_killer_probe() {
    // Banned by clippy.toml disallowed-types (CORE-04): floats are non-deterministic.
    let killer_float: f64 = 1.0;
    // Banned by clippy.toml disallowed-types (CORE-06): randomized iteration order.
    let killer_map: std::collections::HashMap<u8, u8> = std::collections::HashMap::new();
    let _ = (killer_float, killer_map);
}
PROBE_EOF

if ! expect_bite disallowed_types "$PROBE_TYPES" "an f64 + HashMap"; then
    echo "      The determinism disallowed-TYPES lints are not enforcing. SC#5 NOT satisfied." >&2
    exit 1
fi
echo "      types probe present: gate correctly EXITS NON-ZERO on disallowed_types at the probe"

echo "[3/5] removing the types probe and asserting the gate is GREEN again ..."
rm -f "$PROBE_TYPES"
if ! "${CLIPPY[@]}"; then
    echo "FAIL: gate still failing after types-probe removal — tree not restored." >&2
    exit 1
fi
echo "      types probe removed: GREEN restored"

echo "[4/5] injecting a disallowed-METHODS killer probe and asserting the gate BITES ..."
cat > "$PROBE_METHODS" <<'PROBE_EOF'
//! THROWAWAY probe for the SC#5 negative-lint gate (disallowed-METHODS family).
//! Created and deleted by scripts/determinism-gate-negative-test.sh. If you are
//! seeing this committed, something went wrong — delete it.
#[test]
fn determinism_method_killer_probe() {
    // Banned by clippy.toml disallowed-METHODS (CORE-03/05): ambient environment
    // read. `std::env` is NOT a disallowed TYPE, so this trips the METHODS gate
    // SPECIFICALLY — the exact lint family tests/regen.rs is allowed to bypass via
    // `#![allow(clippy::disallowed_methods)]`. Proving the methods gate bites here
    // is what makes that regen allow safe (it cannot mask a determinism-killer).
    let _ = std::env::var("FABRICO_DETERMINISM_PROBE");
}
PROBE_EOF

if ! expect_bite disallowed_methods "$PROBE_METHODS" "std::env::var"; then
    echo "      The determinism disallowed-METHODS list is not enforcing; the" >&2
    echo "      regen.rs #![allow(clippy::disallowed_methods)] could mask a killer." >&2
    exit 1
fi
echo "      methods probe present: gate correctly EXITS NON-ZERO on disallowed_methods at the probe"

echo "[5/5] removing the methods probe and asserting the gate is GREEN again ..."
rm -f "$PROBE_METHODS"
if ! "${CLIPPY[@]}"; then
    echo "FAIL: gate still failing after methods-probe removal — tree not restored." >&2
    exit 1
fi
echo "      methods probe removed: GREEN restored"

echo
echo "SC#5 PROVEN: the determinism gate bites on BOTH a disallowed-TYPE and a"
echo "             disallowed-METHOD killer, and recovers cleanly after each."
exit 0
