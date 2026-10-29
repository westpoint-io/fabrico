#!/usr/bin/env bash
#
# THE CLIPPY VERDICT MUST COME FROM THE COMPILER THIS REPOSITORY PINS (THAW-10,
# `70-CONTEXT.md` D-08, ruling R-8 of plan 70-02).
#
# WHAT THIS IS FOR. `.github/workflows/ci.yml`'s determinism job runs
# `cargo clippy --all-targets --all-features -- -D warnings` and treats its exit code as
# the milestone's load-bearing determinism assertion. That verdict is only worth what the
# compiler behind it is worth: a different toolchain has a different lint set, a different
# set of lints promoted from allow to warn, and a different idea of what `-D warnings`
# denies. A green from an unpinned compiler is not the green the gate claims. This script
# runs as the step IMMEDIATELY BEFORE EVERY clippy invocation in that job - there are two,
# the workflow's own `cargo clippy` line and the one
# `scripts/determinism-gate-negative-test.sh` runs itself - and refuses to let a verdict be
# produced by a toolchain nobody pinned. The adjacency is asserted for both by
# `crates/fabrico-host/tests/ci_wiring_parity.rs`, not by a reader, because a presence-only
# assertion would pass with this step sitting at the bottom of the job doing nothing.
#
# ===================================================================================
# THE TWO NUMBERING SCHEMES, AND WHY A STRING COMPARISON IS WRONG
# ===================================================================================
#
# The toolchain and its clippy component are versioned on DIFFERENT scales:
#
#     $ cargo --version
#     cargo 1.98.0 (797e8a9bc 2026-08-05)
#     $ cargo clippy --version
#     clippy 0.1.98
#
# Those two lines describe the SAME toolchain. Clippy reports `0.1.<minor>` where the
# toolchain reports `1.<minor>.<patch>`, so `"0.1.98" = "1.98.0"` is FALSE for a matched
# pair and TRUE for nothing at all. A gate written as a direct string equality between
# them would therefore be red on every correct configuration - which is worse than
# useless, because the first person it inconvenienced would delete it.
#
# So the comparison is on the MINOR COMPONENT, and `clippy_minor_to_channel` performs the
# mapping explicitly rather than leaving it implicit in a regex. The patch level is
# deliberately NOT compared: `rust-toolchain.toml` pins `1.98.0`, a runner may install
# `1.98.1`, and refusing that would make the gate red for a reason nobody chose.
#
# ===================================================================================
# THE HONESTY MECHANISMS. A GREEN RUN HAS TO MEAN SOMETHING.
# ===================================================================================
#
#   1. THE PIN IS READ THROUGH A NAMED BLOCK, `PINNED_CHANNEL_BLOCK`, printed on demand
#      by `--print-block` and resolved on demand by `--print-pin`. The reason is the same
#      one behind `COVERED_CRATES` in `scripts/check-core-declared.sh`: THIS SCRIPT CANNOT
#      SEE AN EDIT TO ITS OWN READ.
#      A read narrowed to nothing returns the empty string, and a comparison between two
#      values nobody read is the vacuous green this whole script family refuses.
#      `scripts/prove-toolchain-pin-bites.sh` asserts the block from outside.
#
#   2. AN EMPTY OR UNPARSEABLE READ IS EXIT 2, NEVER 0 AND NEVER 1. Exit 1 means the two
#      toolchains genuinely DISAGREE, which is a finding about the machine. Exit 2 means
#      this script could not establish one of the two values, which is a finding about
#      this script or its environment. Collapsing them would tell the reader to go and
#      fix the wrong thing, and reporting either as 0 would be an assertion that measured
#      nothing.
#
#   3. BOTH VERSIONS ARE NAMED ON EVERY MISMATCH. An exit code cannot say which END
#      moved - the pin, or the machine - and those have opposite fixes.
#
#   4. THE EXIT IS DEFERRED. The active-toolchain arm, the installed-channel arm and the
#      clippy arm are all evaluated even after one has failed, so one run names everything
#      that is wrong rather than the first thing.
#
# ===================================================================================
# WHAT THIS GATE CANNOT DO, STATED SO IT IS NOT ASSUMED
# ===================================================================================
#
# ON A RUSTUP RUNNER THE VERSION COMPARISON CANNOT FAIL, AND SAYING SO IS THE POINT.
# `cargo` on such a machine is a rustup PROXY: it walks up from the cwd, finds
# `rust-toolchain.toml`, and selects - installing on demand - exactly the channel that
# file names. `cargo --version` therefore reports the pin BY CONSTRUCTION, and assertion 1
# below compares the pin against a value the pin itself produced. That is a tautology, it
# was reported as CR-03 in this phase's code review, and it is NOT repaired by rewording:
# on a correctly configured rustup machine there is no reading of "the compiler about to
# run" that can disagree with the pin, because rustup is what makes them agree.
#
# So the honest statement of what each assertion is worth, per machine:
#
#   ASSERTION 1 (the version comparison) IS REAL ON TWO ROUTES, NEITHER OF WHICH GOES
#   THROUGH THE PROXY. `RUSTUP_TOOLCHAIN` overrides the pin file and is honoured
#   explicitly below; and on a machine with NO rustup - which is the machine this was
#   written on - the pin file is INERT, nothing reads it to select a compiler, so whatever
#   cargo is on PATH runs and can be any version at all. Those two are what the assertion
#   measures for real, and `scripts/prove-toolchain-pin-bites.sh` exercises both.
#
#   ASSERTION 1b (the pinned channel is INSTALLED) IS THE ONE THAT CAN FAIL ON A RUSTUP
#   RUNNER. It reads `rustup toolchain list` - the set of toolchains present on the
#   machine, which the pin file does not steer - and fires when the pinned channel is not
#   among them. Reachable causes, all of them real: a job that loses or reorders its
#   `rustup show` install step below this one, a runner that cannot reach the toolchain
#   server, or a pin moved to a channel that does not exist. It cannot redden a correct
#   machine, because a pin rustup has honoured is a pin rustup has installed.
#
#   THE DEFAULT TOOLCHAIN IS REPORTED, NEVER COMPARED. `rustup toolchain list`'s
#   `(default)` entry is the toolchain rustup would use with the pin file out of the
#   picture, so printing it lets a reader see whether the pin is doing any work. It is
#   deliberately not asserted on: a default equal to the pin is a correct machine, and a
#   default different from the pin is also a correct machine as long as the pin steers.
#   An assertion either way would be red for a reason nobody chose, which is how a gate
#   gets deleted by the first person it inconveniences.
#
# It also cannot tell a genuinely-installed 1.98.0 from a 1.98.0 that lies about its own
# version. That is not a threat this repository models.

set -u

# ---------------------------------------------------------------------------------
# PINNED_CHANNEL_BLOCK - the read of the pin, declared as a named block.
# ---------------------------------------------------------------------------------
# Three entries, index-ordered, and `pinned_channel()` below uses NOTHING ELSE: the file
# path, the TOML key, and the expression that lifts the value out of `key = "value"`.
# Declaring them here rather than inlining them into the function is what gives the
# non-vacuity prover something to assert from outside (honesty mechanism 1). If you narrow
# this block, `--print-block` says so and the prover reddens.
PINNED_CHANNEL_BLOCK=(
    # 1. The file the pin lives in, relative to the repository root.
    "rust-toolchain.toml"
    # 2. The TOML key inside it. Named separately from the expression below so a reader
    #    can see WHAT is being read without parsing a sed program.
    "channel"
    # 3. The expression that lifts the value out. Tolerant of the surrounding whitespace
    #    the file actually uses (`channel    = "1.98.0"`), and anchored so a `channel`
    #    mentioned inside a comment cannot satisfy it.
    's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*$/\1/p'
)

TOOLCHAIN_FILE="${PINNED_CHANNEL_BLOCK[0]}"

# The shortest string that could be a channel is `1.9`. Anything shorter came from a
# broken parse rather than from a real version, and treating it as a version would let a
# one-character capture drive a comparison. Below this the answer is exit 2.
MIN_PARSE_LEN=3

usage() {
    cat <<'USAGE'
usage: bash scripts/check-toolchain-pin.sh [options]

Asserts that the toolchain producing this run's compiler verdicts is the one
rust-toolchain.toml pins. Runs as the step immediately before `cargo clippy` in CI's
determinism job (THAW-10): a clippy verdict from an unpinned compiler is not the verdict
that gate claims to have taken.

  --print-pin      print the pinned channel resolved through PINNED_CHANNEL_BLOCK, and
                   exit 0. The non-vacuity prover reads the live pin from here rather
                   than transcribing it, and mints its mismatch probe from it.
  --print-block    print the PINNED_CHANNEL_BLOCK entries, one per line, and exit 0.
                   This script cannot see an edit to its own read; the prover asserts
                   the block from outside.
  -h, --help       this message.

RUSTUP_TOOLCHAIN, when set, is taken as the ACTIVE toolchain. That is the route THAW-10
names for expressing a mismatch, and the only one that works on a machine with no rustup
installed at all.

EXIT CODES
  0  the active toolchain is the pinned one, and (on a rustup machine) the pinned channel
     is installed. Both versions are named.
  1  they DISAGREE, or rustup has no toolchain installed for the pinned channel. Both
     ends are named, so the reader can see which one moved.
  2  the assertion could not be made (no rust-toolchain.toml, no readable channel line,
     a channel that does not parse as a version, or no parseable `cargo --version`).
     Never a pass: an assertion that measures nothing must never report green.
USAGE
}

# ---------------------------------------------------------------------------------
# Readers. NONE of these calls `exit`.
# ---------------------------------------------------------------------------------
# They are invoked through `$( )` and an `exit` inside a command substitution kills only
# the subshell - the caller sails on and reports a verdict it has no basis for. That is a
# real defect found and fixed in this phase's plan 70-01 (see its summary, deviation 1),
# and this file is written so it cannot recur: every reader RETURNS a possibly-empty
# string and every could-not-assert decision is taken at the top level.

# The pinned channel, read through PINNED_CHANNEL_BLOCK and nothing else.
pinned_channel() {
    [ -f "${PINNED_CHANNEL_BLOCK[0]}" ] || return 0
    sed -n "${PINNED_CHANNEL_BLOCK[2]}" "${PINNED_CHANNEL_BLOCK[0]}" 2>/dev/null | head -1 | tr -d '[:space:]'
}

# The active toolchain version, plus where it came from, as `<version>|<source>`.
active_channel() {
    if [ -n "${RUSTUP_TOOLCHAIN:-}" ]; then
        printf '%s|%s' "$RUSTUP_TOOLCHAIN" 'the RUSTUP_TOOLCHAIN override'
        return 0
    fi
    local line version
    line="$(cargo --version 2>/dev/null | head -1)"
    version="$(printf '%s' "$line" | sed -E -n 's/^cargo ([0-9]+\.[0-9]+(\.[0-9]+)?).*$/\1/p')"
    printf '%s|%s' "$version" 'cargo --version'
}

# The NAMES of every toolchain rustup has INSTALLED, one per line. Empty when rustup is
# absent, and empty when the list cannot be read - both are reported by the caller as a
# SKIPPED check rather than as a finding, because an unreadable list is not evidence that
# the pin is missing from it.
#
# Only the first whitespace-delimited field of each line is taken, which makes this
# tolerant of both `rustup toolchain list` formats in the wild: rustup before 1.28 marks
# one entry ` (default)`, 1.28 and later mark entries ` (active, default)` / ` (active)`.
# Every such marker is dropped here.
rustup_installed_toolchains() {
    command -v rustup >/dev/null 2>&1 || return 0
    rustup toolchain list 2>/dev/null | awk 'NF { print $1 }'
}

# The NAME of rustup's DEFAULT toolchain: what it would use with the pin file out of the
# picture. Empty when rustup is absent or no entry carries a default marker. REPORTED by
# the caller, never compared - see the header for why an assertion here would be red for
# a reason nobody chose.
rustup_default_toolchain() {
    command -v rustup >/dev/null 2>&1 || return 0
    rustup toolchain list 2>/dev/null | awk '/default\)/ { print $1; exit }'
}

# Maps clippy's `0.1.<minor>` onto the toolchain's `1.<minor>` scale. Empty when the
# argument is not in clippy's numbering, which is how the caller tells a failed probe
# apart from a real disagreement.
clippy_minor_to_channel() {
    local minor
    minor="$(printf '%s' "$1" | sed -E -n 's/^0\.1\.([0-9]+).*$/\1/p')"
    [ -z "$minor" ] && return 0
    printf '1.%s' "$minor"
}

# The minor component of a `1.<minor>[.<patch>]` string. Empty for anything else -
# including `stable`, `nightly` and a bare toolchain-name channel, none of which name a
# numeric version this script can compare.
toolchain_minor() {
    printf '%s' "$1" | sed -E -n 's/^1\.([0-9]+)(\..*)?$/\1/p'
}

# ---------------------------------------------------------------------------------
# Arguments.
# ---------------------------------------------------------------------------------
PRINT_PIN=0
PRINT_BLOCK=0
while [ $# -gt 0 ]; do
    case "$1" in
        --print-pin)
            PRINT_PIN=1
            shift
            ;;
        --print-block)
            PRINT_BLOCK=1
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "FAIL: unknown argument '$1'." >&2
            usage >&2
            exit 2
            ;;
    esac
done

# Run from the repository root whatever the caller's cwd, so the pin file resolves and
# the reported path means what it says.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$REPO_ROOT" ]; then
    cd "$REPO_ROOT" || exit 2
fi

if [ "$PRINT_BLOCK" -eq 1 ]; then
    printf '%s\n' "${PINNED_CHANNEL_BLOCK[@]}"
    exit 0
fi

PINNED="$(pinned_channel)"

if [ "$PRINT_PIN" -eq 1 ]; then
    printf '%s\n' "$PINNED"
    exit 0
fi

# Deferred exit for the two ASSERTIONS below, so one run names everything that is wrong
# rather than the first thing. There is deliberately no matching `cannot_assert`
# accumulator: every could-not-assert condition here is a guard that exits 2 on the spot,
# and a flag that nothing can ever raise is itself a check that cannot fail.
failed=0

cannot_assert_footer() {
    echo >&2
    echo "EXIT 2: the assertion could not be made (see above). That is a FAILURE, not a" >&2
    echo "pass. Exit 1 would claim the pin and the active toolchain disagree; this run" >&2
    echo "could not establish one of the two, so it has no basis for that claim either." >&2
}

# --- Guard 1: the pin file exists --------------------------------------------------
if [ ! -f "$TOOLCHAIN_FILE" ]; then
    echo "FAIL: '${TOOLCHAIN_FILE}' does not exist, so there is no pinned channel to" >&2
    echo "compare against. A gate that reports green over a missing pin asserts nothing." >&2
    cannot_assert_footer
    exit 2
fi

# --- Guard 2: the channel line is readable through the named block ------------------
echo "pin file: ${TOOLCHAIN_FILE}  (read through PINNED_CHANNEL_BLOCK, ${#PINNED_CHANNEL_BLOCK[@]} entries)"
if [ -z "$PINNED" ] || [ "${#PINNED}" -lt "$MIN_PARSE_LEN" ]; then
    echo "FAIL: no readable '${PINNED_CHANNEL_BLOCK[1]}' value in '${TOOLCHAIN_FILE}'" >&2
    echo "(read '${PINNED}', shorter than the ${MIN_PARSE_LEN}-character floor)." >&2
    echo "An empty pin compares unequal to everything, so treating this as a mismatch" >&2
    echo "would name a disagreement that was never measured." >&2
    cannot_assert_footer
    exit 2
fi

PINNED_MINOR="$(toolchain_minor "$PINNED")"
if [ -z "$PINNED_MINOR" ]; then
    echo "FAIL: the pinned channel '${PINNED}' does not parse as 1.<minor>[.<patch>]." >&2
    echo "This gate compares numeric release channels. A named channel ('stable'," >&2
    echo "'nightly', a custom toolchain name) denotes a moving target this script cannot" >&2
    echo "resolve to a version, so it refuses rather than guessing." >&2
    cannot_assert_footer
    exit 2
fi

# --- Guard 3: the active toolchain reports a parseable version ----------------------
ACTIVE_RAW="$(active_channel)"
ACTIVE="${ACTIVE_RAW%%|*}"
ACTIVE_SOURCE="${ACTIVE_RAW#*|}"
if [ -z "$ACTIVE" ] || [ "${#ACTIVE}" -lt "$MIN_PARSE_LEN" ]; then
    echo "FAIL: could not read an active toolchain version from ${ACTIVE_SOURCE}." >&2
    echo "Without it there is nothing to compare the pin '${PINNED}' against." >&2
    cannot_assert_footer
    exit 2
fi

ACTIVE_MINOR="$(toolchain_minor "$ACTIVE")"
if [ -z "$ACTIVE_MINOR" ]; then
    echo "FAIL: the active toolchain '${ACTIVE}' (from ${ACTIVE_SOURCE}) does not parse" >&2
    echo "as 1.<minor>[.<patch>], so it cannot be compared with the pin '${PINNED}'." >&2
    cannot_assert_footer
    exit 2
fi

echo "pinned channel: ${PINNED}    active toolchain: ${ACTIVE}  (from ${ACTIVE_SOURCE})"

# --- Assertion 1: the active toolchain is the pinned one ---------------------------
if [ "$ACTIVE_MINOR" != "$PINNED_MINOR" ]; then
    echo "FAIL: the active toolchain is ${ACTIVE}, but ${TOOLCHAIN_FILE} pins ${PINNED}." >&2
    echo "A compiler verdict from an unpinned toolchain is not the verdict the gate" >&2
    echo "downstream of this step claims to have taken: a different release has a" >&2
    echo "different lint set and a different idea of what '-D warnings' denies." >&2
    echo "Both versions are named above so you can see which end moved. Either install" >&2
    echo "the pinned toolchain, or move the pin deliberately and say so - do NOT delete" >&2
    echo "this step to make the job green." >&2
    failed=1
fi

# --- Assertion 1b: the pinned channel is INSTALLED (rustup machines only) -----------
# THE ONLY READING HERE THAT THE PIN FILE DOES NOT STEER, and therefore the only one that
# can fail on a rustup runner - which is the only kind of machine CI has. See the header:
# assertion 1 above compares the pin against a value the rustup PROXY derived FROM the
# pin, so on such a runner it agrees by construction. This one asks a different question
# of a different source: is the channel the pin names actually on the machine?
#
# It is deliberately an EXACT-CHANNEL match rather than the minor-tolerant comparison
# assertion 1 uses. Those tolerate different things for different reasons: a runner may
# legitimately be RUNNING 1.98.1 against a 1.98.0 pin (patch drift, which the gate does
# not police), but rustup installs precisely the channel the file names, so a pin of
# 1.98.0 that rustup has honoured leaves a `1.98.0-<host>` entry in the list. A prefix
# match on `${PINNED}-` covers the host-triple suffix without loosening anything else.
if [ -n "${RUSTUP_TOOLCHAIN:-}" ]; then
    echo "installed-channel check: skipped - RUSTUP_TOOLCHAIN is in force, and assertion 1 above measured that override directly"
elif ! command -v rustup >/dev/null 2>&1; then
    echo "installed-channel check: skipped - no rustup on this machine, so the pin file is INERT here (nothing reads it to select a compiler) and there is no installed set to read"
else
    INSTALLED_TOOLCHAINS="$(rustup_installed_toolchains)"
    DEFAULT_TOOLCHAIN="$(rustup_default_toolchain)"
    echo "rustup default toolchain: ${DEFAULT_TOOLCHAIN:-<none marked default>}  (what rustup would use with ${TOOLCHAIN_FILE} out of the picture; REPORTED, not compared)"
    if [ -z "$INSTALLED_TOOLCHAINS" ]; then
        echo "installed-channel check: skipped - 'rustup toolchain list' emitted nothing readable. An unreadable list is not evidence that the pin is absent from it, so this is a skip and not a finding."
    elif printf '%s\n' "$INSTALLED_TOOLCHAINS" |
        awk -v pin="$PINNED" '$1 == pin || index($1, pin "-") == 1 { hit = 1 } END { exit !hit }'; then
        echo "installed channels: the pinned ${PINNED} IS installed"
    else
        echo "FAIL: ${TOOLCHAIN_FILE} pins ${PINNED}, but rustup has no ${PINNED} toolchain" >&2
        echo "installed. What it does have:" >&2
        printf '%s\n' "$INSTALLED_TOOLCHAINS" | sed 's/^/    /' >&2
        echo "The active toolchain this run measured is ${ACTIVE} (from ${ACTIVE_SOURCE})," >&2
        echo "so both ends are named above." >&2
        echo "This is the one comparison on a rustup machine that the pin file does not" >&2
        echo "steer: 'cargo --version' resolves THROUGH the pin and so agrees with it by" >&2
        echo "construction, while the installed set is a fact about the machine. A pin that" >&2
        echo "rustup has honoured is a pin rustup has installed; this one is not. Either the" >&2
        echo "toolchain install step never ran (or ran AFTER this gate), the runner could not" >&2
        echo "reach the toolchain server, or the pin names a channel that does not exist." >&2
        failed=1
    fi
fi

# --- Assertion 2: the clippy that will produce the verdict is on the same channel ---
# The clippy probe is a CORROBORATION, not the primary comparison, and a probe that
# cannot be run is reported rather than escalated to exit 2. Refusing to assert because a
# secondary reading was unavailable would turn a real mismatch (assertion 1, above) into a
# could-not-assert, and the reader would go looking for a missing component instead of a
# wrong compiler.
CLIPPY_RAW="$(cargo clippy --version 2>/dev/null | head -1)"
CLIPPY_VERSION="$(printf '%s' "$CLIPPY_RAW" | sed -E -n 's/^clippy ([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p')"
if [ -z "$CLIPPY_VERSION" ]; then
    echo "clippy: not readable ('cargo clippy --version' produced nothing parseable) - the corroborating check was skipped, assertion 1 above still stands"
else
    CLIPPY_CHANNEL="$(clippy_minor_to_channel "$CLIPPY_VERSION")"
    if [ -z "$CLIPPY_CHANNEL" ]; then
        echo "clippy: reports '${CLIPPY_VERSION}', which is not clippy's 0.1.<minor> numbering - the corroborating check was skipped"
    else
        echo "clippy: ${CLIPPY_VERSION}  ->  toolchain ${CLIPPY_CHANNEL}.x  (0.1.<minor> maps onto 1.<minor>.x; a direct string comparison of the two is false for a MATCHED pair)"
        CLIPPY_MINOR="$(toolchain_minor "${CLIPPY_CHANNEL}")"
        if [ "$CLIPPY_MINOR" != "$PINNED_MINOR" ]; then
            echo "FAIL: clippy reports ${CLIPPY_VERSION}, i.e. toolchain ${CLIPPY_CHANNEL}.x," >&2
            echo "but ${TOOLCHAIN_FILE} pins ${PINNED}. The clippy about to run is not the" >&2
            echo "one this repository pinned, so its verdict is not the pinned verdict." >&2
            failed=1
        fi
    fi
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "OK: the active toolchain ${ACTIVE} is the channel ${TOOLCHAIN_FILE} pins (${PINNED})."
exit 0
