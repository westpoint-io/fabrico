#!/usr/bin/env bash
#
# The development pace switch is ABSENT FROM THE TREE - five token spellings, zero
# occurrences, over every tracked file (Phase 68 plan 68-07, `68-CONTEXT.md` D-68-13 as
# AMENDED by D-68-18, BELT-05).
#
# WHAT THE SWITCH WAS, AND WHY ITS ABSENCE IS STILL WORTH ASSERTING. Phase 62 shipped a
# development-only capability that wrote EVERY belt's advance interval at runtime so a
# human could judge belt pace back to back on identical geometry. The interval is a
# per-belt SIM field, so that write was UNLOGGED: the same starting state plus the same
# ordered events would no longer replay to the same result, which attacks this project's
# core value directly. The capability was therefore built behind a cargo feature, a Vite
# build flag and a three-way absence proof over BUILT ARTIFACTS.
#
# Phase 68 shipped a LOGGED per-belt-run pace command that saves, loads, undoes and
# replays byte-identically (BELT-01/02/04). That dissolved the switch's entire
# justification - what remained was an unlogged write path with no user - so plan 68-07
# removed it outright (D-68-12, D-68-14, D-68-15). This script is the successor to the
# proof that guarded it, and BELT-05 requires that the guarantee survive whatever
# replaces the gate.
#
# ===================================================================================
# WHY THIS IS STRICTLY STRONGER THAN THE PROOF IT REPLACES
# ===================================================================================
#
# The earlier built-artifact check proved three things about BUILT ARTIFACTS: the
# cargo feature was not enabled on the default build, a `#[cfg(not(feature = ...))]`
# exhaustive match refused to compile if the control verb lost its gate, and the tokens
# did not appear in a release binary or a production bundle. All three are gone, for two
# different reasons:
#
#   - The compile-time check DIED WITH THE VARIANT IT GUARDED. An exhaustive match over
#     the control-message enum can only refuse a variant that the enum could still have.
#     That is D-68-13's stated reason for needing a successor at all.
#   - The artifact greps needed a RELEASE BINARY and a PRODUCTION FRONTEND BUNDLE, which
#     is why - by that workflow's own written admission - NO JOB IN CI EVER INVOKED THEM.
#     A proof nobody runs is a proof in name only.
#
# This asserts the tokens appear ZERO times ANYWHERE IN THE TREE, which is strictly
# stronger in two ways at once: it reddens on the REINTRODUCTION OF A NAME, before any
# build, and it needs no build at all - so it runs on every push. Converting a manual
# instrument into a running gate is the strongest form "the guarantee survives whatever
# replaces it" can take.
#
# ===================================================================================
# FIVE TOKENS, NOT THREE, AND THE TWO HOLES THE EXTRA TWO CLOSE
# ===================================================================================
#
# D-68-13 locked THREE tokens: the wire verb name, the panel's rendered identifier and
# the dev-only scene id. D-68-18 AMENDS that to FIVE. The reason is measured, not
# stylistic: a literal three-token grep would have left TWO holes ON THE DAY IT SHIPPED,
# guarding names the removal does delete while missing two it also deletes.
#
#   HOLE 1 - the cargo feature name. It spells the two words with a HYPHEN; the scene id
#   spells them with an UNDERSCORE. A literal grep for one does not match the other. Up
#   to this script the feature name was covered only by the `cargo tree` check that this
#   script's arrival deletes, so a manifest where the feature declaration survived while
#   everything else went would have passed a three-token gate cleanly.
#
#   HOLE 2 - the Rust enum variant. It is the UpperCamelCase spelling of the verb, and
#   it is not a substring of the snake_case Tauri command name. A reintroduced control
#   variant with no Tauri command in front of it would have passed all three tokens.
#
# The five are declared literally in TOKENS below, with the same reasons attached to each
# entry. A gate that silently searches five tokens while its docblock says three is the
# next reader's trap, so the count is stated in both places and `--print-tokens` emits
# the live list rather than a transcription of it.
#
# ===================================================================================
# THE FOUR HONESTY MECHANISMS. A GREEN RUN HAS TO MEAN SOMETHING.
# ===================================================================================
#
# The contract below is taken WHOLESALE from the gate this replaces; only its artifact
# mechanism is dropped. "A grep that finds nothing looks identical whether the token is
# absent or the search is broken" is that script's sentence, and it is the whole reason
# for mechanisms 2 and 3.
#
#   1. THE SCAN SET IS ENUMERATED FROM TRACKED FILES, its size is PRINTED on every run,
#      and the run REFUSES below a floor. Precedent: the golden-fixture floor of the
#      retired core-freeze gate, which existed "to catch a walk that discovers
#      NOTHING (wrong cwd, moved directory, broken find)". A scan of zero files greps
#      clean and would otherwise report green.
#
#      `git ls-files` rather than a recursive walk from the repository root is not a
#      convenience, it removes three whole classes of false positive for free: git
#      HISTORY is not a working-tree file (the tokens are all over it and always will
#      be), and build output, installed packages and the built frontend bundle are not
#      tracked. **Do NOT reimplement this as `grep -r .` from the root.**
#
#   2. A POSITIVE CONTROL TOKEN MUST BE FOUND in the scanned set. Below one hit the exit
#      is 2, never 0. The gate this replaces carried two such controls and called them
#      out as its own rule. The control here is a shipped, load-bearing host symbol
#      chosen because it is common enough that a broken search cannot miss it by luck and
#      central enough that it is not about to be renamed.
#
#   3. THE EXCLUSION LIST IS A LITERAL ARRAY, PRINTED ON EVERY RUN, AND EVERY ENTRY MUST
#      EXIST. An excluded path that no longer exists is a stale exclusion widening the
#      blind spot silently, so a missing entry is exit 2. Same shape as the
#      stale-allowlist guard of the retired phase-62 radius gate.
#
#   4. EXIT 2 FOR "COULD NOT ASSERT", NEVER 0. Kept verbatim from the predecessor's
#      contract: an assertion that measures nothing must never report green. Exit 1 means
#      a token was FOUND; exit 2 means the search could not be made. The distinction is
#      load-bearing and `scripts/prove-dev-pace-switch-absent-non-vacuous.sh` probes both.
#
# Every token is searched even after an earlier one is found and the exit is deferred to
# the end, so ONE run names everything that is wrong rather than the first thing.
#
# ===================================================================================
# THE EXCLUSION LIST IS EXACTLY ONE ENTRY, AND IT IS PRINCIPLED
# ===================================================================================
#
#   this script  - it names all five tokens by definition. Excluded BY EXACT PATH, not
#                  by directory: the rest of `scripts/` MUST be scanned, because the
#                  other gates live there and their comments are exactly the kind of
#                  prose that goes quietly false.
#
# WHAT IS DELIBERATELY **NOT** EXCLUDED, and this is the important half.
# `.github/workflows/ci.yml` and two sibling gate scripts (since retired) all carried
# these tokens in comments and allowlists on the day this script was written. They were EDITED, not excluded. Excluding them is
# precisely the narrow-the-search-set move the predecessor's own footer forbade, and it
# would have made this gate green by making it blind. If a future removal leaves a token
# in one of them, the answer is to fix the file.
#
# ===================================================================================
# WHAT THIS GATE CANNOT DO, STATED SO IT IS NOT ASSUMED
# ===================================================================================
#
# It is a literal, case-sensitive, fixed-string search. It CANNOT catch a reintroduction
# under a different name - which is exactly what the compile-time exhaustive match it
# replaces could do, and that capability is genuinely lost rather than replaced. The
# compensating cover is that the mechanism itself is gone: there is no longer an unlogged
# write path to rename, because the only write to a belt's advance interval is now the
# logged command. A renamed reintroduction would have to rebuild the whole path, which is
# a code review's job and not a grep's.

set -u

# ---------------------------------------------------------------------------------
# THE FIVE TOKENS. Each line is `spelling<TAB>what it is`.
# ---------------------------------------------------------------------------------
# Declared as a literal array so `--print-tokens` emits the LIVE list rather than a
# transcription that can drift from it. The non-vacuity prover reads its probe set from
# `--print-tokens` for exactly that reason, and so that the prover script does not have
# to contain the tokens literally and become a third exclusion.
TOKENS=(
    # 1. The cargo feature name (HYPHEN). D-68-18 hole 1: not matched by token 2's
    #    underscore spelling, and previously covered only by the deleted `cargo tree`
    #    check. A surviving `[features]` declaration would pass a three-token gate.
    "pace-sitting"
    # 2. The dev-only scene's wire id (UNDERSCORE). One of D-68-13's original three. It
    #    was a Rust string literal in the scene-id parse table and a frontend literal in
    #    the panel, so it is also the prefix of the deleted feature-gated test target and
    #    of both deleted conditional test modules.
    "pace_sitting"
    # 3. The Tauri command / host setter name (snake_case). One of D-68-13's original
    #    three: the wire verb. This is the name a webview could invoke.
    "set_belt_advance_interval"
    # 4. The Rust control-message variant (UpperCamelCase). D-68-18 hole 2: NOT a
    #    substring of token 3, so a reintroduced variant with no Tauri command in front
    #    of it would have passed a three-token gate cleanly.
    "SetBeltAdvanceInterval"
    # 5. The panel's component and rendered identifier. One of D-68-13's original three.
    #    It also covers the panel's deleted spec file by prefix.
    "SittingPanel"
)

# ---------------------------------------------------------------------------------
# THE EXCLUSION LIST. Exactly one entry; its existence is asserted below.
# ---------------------------------------------------------------------------------
EXCLUSIONS=(
    "scripts/check-dev-pace-switch-absent.sh"
)

# THE POSITIVE CONTROL. A token that MUST be found in the scanned set, so a search that
# is broken (wrong cwd, empty scan set, a `grep` that cannot read the files) is
# distinguishable from a genuine absence. `enqueue_action_group` is the live
# undo-coalescing seam on `Host` - shipped, load-bearing, named in decision D-68-16 as
# the seam the belt-run pace edit rides.
#
# ITS REACH, MEASURED RATHER THAN ESTIMATED, because the number the control is worth
# is the number inside THIS gate's scan set and not the number in the repository:
# when this was written `git grep -l` found it in 24 tracked files, but most of those
# were planning prose this gate did not scan. Within the scan set it appeared in 5. Five
# is the figure the floor below is judged against; a tree-wide count is the figure a
# reader would wrongly reassure themselves with.
# Overridable ONLY so the prover can demonstrate that this check actually fires; a run
# that overrides it is not asserting the control, which is why the override is printed.
POSITIVE_CONTROL="enqueue_action_group"
POSITIVE_CONTROL_OVERRIDDEN=0

# THE FLOOR. The scan set is ~730 tracked files today. The floor sits well below that on
# purpose: it exists to catch a walk that discovered NOTHING, not to pin the tree's size
# - which would turn this gate red on every ordinary commit and get it switched off.
MIN_SCAN_FILES=300

usage() {
    cat <<'USAGE'
usage: bash scripts/check-dev-pace-switch-absent.sh [options]

Asserts that the five token spellings of the retired development pace switch appear
ZERO times across every tracked file, excluding this script.

  --print-tokens            print the live token list, one per line, and exit 0.
                            The non-vacuity prover reads its probe set from here so it
                            does not have to contain the tokens literally.
  --positive-control <tok>  override the positive-control token. For the prover only:
                            it demonstrates that a control which cannot be found exits 2
                            rather than 0.
  --min-scan-files <n>      override the scan-set floor. For the prover only: it
                            demonstrates that a scan set below the floor exits 2.
  -h, --help                this message.

EXIT CODES
  0  every token appears zero times, and the run could make that assertion.
  1  at least one token was FOUND. The offending paths are named.
  2  the assertion COULD NOT BE MADE (no git tree, empty or below-floor scan set,
     positive control not found, a stale exclusion). Never a pass.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --print-tokens)
            printf '%s\n' "${TOKENS[@]}"
            exit 0
            ;;
        --positive-control)
            if [ $# -lt 2 ]; then
                echo "FAIL: --positive-control needs a value." >&2
                exit 2
            fi
            POSITIVE_CONTROL="$2"
            POSITIVE_CONTROL_OVERRIDDEN=1
            shift 2
            ;;
        --min-scan-files)
            if [ $# -lt 2 ]; then
                echo "FAIL: --min-scan-files needs a value." >&2
                exit 2
            fi
            MIN_SCAN_FILES="$2"
            shift 2
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

# Run from the repository root whatever the caller's cwd, so the excluded paths and the
# reported paths mean what they say.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
    echo "FAIL: not inside a git working tree, so the scan set cannot be enumerated." >&2
    echo "This assertion cannot be made." >&2
    exit 2
fi
cd "$REPO_ROOT" || exit 2

failed=0
cannot_assert=0

present_footer() {
    echo "The development pace switch must be ABSENT FROM THE TREE (BELT-05, D-68-12)." >&2
    echo "It wrote a per-belt SIM field at runtime, UNLOGGED, which breaks replay by" >&2
    echo "construction. The logged belt-run pace command replaced it; there is no" >&2
    echo "remaining reason for any of these names to exist." >&2
    echo "Do NOT add a path to this script's exclusion list to make this pass, and do" >&2
    echo "NOT narrow the scan set. Remove the name." >&2
    echo >&2
}

# --- Guard 1: the exclusion list is printed, and no entry may be stale ------------
echo "exclusions (${#EXCLUSIONS[@]} entries, each asserted to exist):"
stale=""
for ex in "${EXCLUSIONS[@]}"; do
    if [ -e "$ex" ]; then
        echo "  ${ex}"
    else
        echo "  ${ex}   <-- MISSING"
        stale="${stale}  ${ex}"$'\n'
    fi
done
if [ -n "$stale" ]; then
    echo "FAIL: an excluded path does not exist:" >&2
    printf '%s' "$stale" >&2
    echo "A stale exclusion widens this gate's blind spot silently: it keeps excluding" >&2
    echo "a path nobody has while the reader believes the exclusion is doing work." >&2
    echo "Remove the entry or restore the path - never leave it." >&2
    cannot_assert=1
fi

# --- Guard 2: enumerate the scan set from TRACKED FILES, print its size, floor it --
# NUL-delimited THROUGH FILES, never through a shell variable. `$(...)` silently drops
# NUL bytes, so holding a NUL-delimited path list in a variable collapses it to one
# unusable record - measured on the first run of this script, where it presented as a
# scan set of ZERO. The floor and the positive control both caught it, which is the whole
# reason they exist; a version of this gate without them would have printed a confident
# green over nothing. Both files are removed by an EXIT trap on every path out.
SCAN_TMPDIR="$(mktemp -d)" || {
    echo "FAIL: could not create a temporary directory for the scan set." >&2
    exit 2
}
trap 'rm -rf "$SCAN_TMPDIR"' EXIT
ALL_TRACKED_FILE="${SCAN_TMPDIR}/tracked.z"
SCAN_SET_FILE="${SCAN_TMPDIR}/scan.z"
: > "$SCAN_SET_FILE"

if ! git ls-files -z > "$ALL_TRACKED_FILE" 2>/dev/null; then
    echo "FAIL: 'git ls-files' failed, so there is no scan set to search." >&2
    cannot_assert=1
    : > "$ALL_TRACKED_FILE"
fi

scan_count=0
excluded_count=0
while IFS= read -r -d '' path; do
    [ -z "$path" ] && continue
    skip=0
    for ex in "${EXCLUSIONS[@]}"; do
        # Exact path, or anything under it (a directory entry would be excluded whole);
        # this script is excluded by exact path and `scripts/` is NOT.
        if [ "$path" = "$ex" ] || case "$path" in "${ex}/"*) true ;; *) false ;; esac; then
            skip=1
            break
        fi
    done
    if [ "$skip" -eq 1 ]; then
        excluded_count=$((excluded_count + 1))
        continue
    fi
    printf '%s\0' "$path" >> "$SCAN_SET_FILE"
    scan_count=$((scan_count + 1))
done < "$ALL_TRACKED_FILE"

echo "scan set: ${scan_count} tracked file(s) searched, ${excluded_count} excluded (floor ${MIN_SCAN_FILES})"
if [ "$scan_count" -lt "$MIN_SCAN_FILES" ]; then
    echo "FAIL: the scan set holds ${scan_count} file(s), below the floor of ${MIN_SCAN_FILES}." >&2
    echo "A scan of nothing greps clean. The floor exists to catch a walk that" >&2
    echo "discovered NOTHING - a wrong working directory, a moved tree, a broken" >&2
    echo "'git ls-files' - which would otherwise report a confident green over zero" >&2
    echo "files. This assertion cannot be made." >&2
    cannot_assert=1
fi

# --- Guard 3: the positive control MUST be found ----------------------------------
if [ "$scan_count" -gt 0 ]; then
    control_hits="$(xargs -0 -a "$SCAN_SET_FILE" grep -l -F -- "$POSITIVE_CONTROL" 2>/dev/null | grep -c . || true)"
else
    control_hits=0
fi
if [ "$POSITIVE_CONTROL_OVERRIDDEN" -eq 1 ]; then
    echo "positive control: '${POSITIVE_CONTROL}' found in ${control_hits} file(s)  [OVERRIDDEN from the default]"
else
    echo "positive control: '${POSITIVE_CONTROL}' found in ${control_hits} file(s)"
fi
if [ "$control_hits" -lt 1 ]; then
    echo "FAIL: the positive control '${POSITIVE_CONTROL}' - a token that MUST be" >&2
    echo "present in the scanned set - was not found in any of the ${scan_count} files." >&2
    echo "A grep that finds nothing looks identical whether the token is absent or the" >&2
    echo "search is broken. Without a control hit, a zero result for the five tokens" >&2
    echo "below would be meaningless. This assertion cannot be made." >&2
    cannot_assert=1
fi

# --- The assertion: five tokens, zero occurrences ---------------------------------
# Every token is searched even after an earlier one is found, so one run names
# everything that is wrong rather than the first thing.
echo "asserting ${#TOKENS[@]} token(s) appear ZERO times:"
for token in "${TOKENS[@]}"; do
    if [ "$scan_count" -eq 0 ]; then
        offenders=""
    else
        offenders="$(xargs -0 -a "$SCAN_SET_FILE" grep -l -F -- "$token" 2>/dev/null || true)"
    fi
    if [ -z "$offenders" ]; then
        echo "  '${token}': 0"
        continue
    fi
    hit_files="$(printf '%s\n' "$offenders" | grep -c . || true)"
    echo "  '${token}': ${hit_files} file(s)  <-- FOUND"
    echo "FAIL: '${token}' appears in the tree:" >&2
    while IFS= read -r off; do
        [ -z "$off" ] && continue
        echo "  ${off}" >&2
        grep -n -F -- "$token" "$off" 2>/dev/null | head -5 | sed 's/^/      /' >&2
    done <<< "$offenders"
    present_footer
    failed=1
done

if [ "$cannot_assert" -ne 0 ]; then
    echo >&2
    echo "EXIT 2: this run could not MAKE its assertion (see above). That is a FAILURE," >&2
    echo "not a pass: an assertion that measures nothing must never report green." >&2
    exit 2
fi
if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "OK: the development pace switch is absent from the tree - all ${#TOKENS[@]} token"
echo "spellings appear ZERO times across ${scan_count} tracked file(s), with the positive"
echo "control found in ${control_hits} of them."
exit 0
