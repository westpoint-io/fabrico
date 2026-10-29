#!/usr/bin/env bash
#
# prove-provers-isolated-bites.sh - the bite proof for scripts/check-provers-isolated.sh,
# the lint that every prover in scripts/ is kept off the shared working tree (phase 84,
# plan 84-07, GATE-03, decision D-08).
#
# WHY IT RUNS IN CI, RIGHT AFTER THE LINT. The lint is a text scan. A scan whose pattern
# has drifted, or whose file set has gone empty, prints the same green as a scan that
# looked and found nothing. So the `prover-isolation` job runs this proof after the lint:
# one planted prover per rule, each of which the lint must refuse BY NAME and BY RULE, and
# two planted provers it must accept.
#
# WHAT EACH CASE PROVES, and only that. Every plant is a new, untracked, nonce-named file
# `scripts/prove-zz-isolation-probe-<nonce>-<case>.sh`, written one at a time, linted,
# then removed. A plant is never executed; only its text matters.
#
#   T0  the tree as it is                                  -> exit 0
#   C1  a restore verb on a code line                      -> exit 1, the plant named, R1
#   C2  sources the helper, enters no shape                -> exit 1, the plant named, R2
#   C3  enters Shape A without sourcing the helper         -> exit 1, the plant named, R2
#   C4  enters both shapes                                 -> exit 1, the plant named, R2
#   C5  installs its own EXIT trap                         -> exit 1, the plant named, R3
#   C6  an in-place sed in a Shape A prover                -> exit 1, the plant named, R4
#   C7  the restore verb, the trap and the in-place sed
#       only in comments, with a valid Shape A             -> exit 0
#   C8  an in-place sed and kept bytes in a Shape B prover -> exit 0
#   C9  a hard reset in a Shape A prover                   -> exit 1, the plant named, R1
#   C10 a clean of untracked files in a Shape B prover     -> exit 1, the plant named, R1
#   C11 a git rm in a Shape A prover                       -> exit 1, the plant named, R1
#   C12 a git rm and an unstaging reset in Shape B         -> exit 0
#   C13 a git add of everything in a Shape A prover        -> exit 1, the plant named, R1
#   C14 a `-c commit.<key>=` config option, Shape A        -> exit 0
#   C15 a hard reset ABOVE the Shape B line                -> exit 1, the plant named, R1
#   C16 an in-place sed ABOVE the Shape B line             -> exit 1, the plant named, R4
#   C17 the Shape B line indented inside a function        -> exit 1, the plant named, R2
#   C18 the Shape B line indented inside an `if`           -> exit 1, the plant named, R2
#   C19 a valid Shape B line, plus an indented second call
#       inside a function                                  -> exit 1, the plant named, R2
#   C20 a whole node_modules linked into a Shape B worktree -> exit 1, the plant named, R5
#   C21 node_modules linked entry by entry, Shape B        -> exit 0
#   E1  PROVERS_DIR at an empty directory                  -> exit 2
#   E2  PROVERS_DIR holding the helper and three provers   -> exit 2 (below the floor)
#
# Every exit-1 case also requires that the plant is the ONLY file named and that every
# line naming it carries the expected rule and no other, so a lint that fires every rule
# at once, or names the wrong file, does not pass.
#
# THE HELPER'S RUNTIME HALF (review 84 iteration 3 WR-02). A shape line at column 0 that
# still sits inside an unindented function or `if` is beyond the lint's line scan, so the
# helper refuses those runs itself. These cases EXECUTE a small plant, but only in a
# scratch git repository under the private temp directory, never in this checkout, with a
# copy of the helper under test (PROVER_HELPER_UNDER_TEST, default the tracked one):
#   X1  a clean Shape A plant                              -> exit 0
#   X2  the same plant asked for --help, exiting 0 first   -> exit 0
#   X3  the shape line at column 0 inside a false `if`     -> exit 2, "without entering"
#   X4  the shape line at column 0 inside a function       -> exit 2, "inside a function"
#   X5  a tracked file written above the shape line        -> exit 2, "changed between"
#
# THIS FILE MUST PASS THE LINT IT PROVES, because it is itself a prover in scripts/. So no
# code line here holds a forbidden token literally: the restore verbs, the trap keyword
# and the in-place flag are assembled from pieces at run time, and the plant text is
# written through printf. The plant directory is the real scripts/ directory (that is the
# set the lint reads), so isolation is the helper's Shape A over every plant path: it
# refuses a path that exists or is tracked, removes every plant at exit whatever the
# outcome, and compares the tracked tree before and after.
#
# THE LINT UNDER TEST is `PROVERS_LINT_UNDER_TEST`, default the tracked
# scripts/check-provers-isolated.sh. The override exists so a deliberately broken copy can
# be run through this proof and seen to turn it red.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected
#   1  one or more cases wrong; every wrong case is named in one run
#   2  the proof could not be made: no lint, a plant path taken, a temp-dir failure

set -euo pipefail

# Sourced first: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
    echo "prove-provers-isolated-bites: not inside the repository; COULD NOT PROVE" >&2
    exit 2
}
cd "$ROOT"
LINT="${PROVERS_LINT_UNDER_TEST:-$ROOT/scripts/check-provers-isolated.sh}"
if [ ! -f "$LINT" ]; then
    echo "prove-provers-isolated-bites: lint $LINT missing; COULD NOT PROVE" >&2
    exit 2
fi
HELPER_UNDER_TEST="${PROVER_HELPER_UNDER_TEST:-$ROOT/scripts/lib/prover-isolation.sh}"
if [ ! -f "$HELPER_UNDER_TEST" ]; then
    echo "prove-provers-isolated-bites: helper $HELPER_UNDER_TEST missing; COULD NOT PROVE" >&2
    exit 2
fi

NONCE="$$-$(date +%s)"
CASES=(c1 c2 c3 c4 c5 c6 c7 c8 c9 c10 c11 c12 c13 c14 c15 c16 c17 c18 c19 c20 c21)
plant_of() {
    echo "scripts/prove-zz-isolation-probe-${NONCE}-$1.sh"
}
PLANTS=()
for c in "${CASES[@]}"; do
    PLANTS+=("$(plant_of "$c")")
done

TMP="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-provers-isolated.XXXXXX")" || {
    echo "prove-provers-isolated-bites: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmp() {
    rm -rf -- "$TMP"
}
prover_on_exit remove_tmp
prover_isolate_untracked "${PLANTS[@]}"

# --- The forbidden tokens, assembled from pieces ---------------------------------------
G="git"
V_CHECKOUT="check""out"
V_RESTORE="res""tore"
V_STASH="st""ash"
V_RESET="re""set"
V_CLEAN="cl""ean"
V_RM="r""m"
V_ADD="a""dd"
V_COMMIT="com""mit"
K_TRAP="tr""ap"
F_INPLACE="-""i"
K_EXIT="EX""IT"
K_KEEP="prover_keep""_bytes"
K_PUT="prover_put""_back"
K_LN="l""n"

# --- Plant text ------------------------------------------------------------------------
# Single quotes on purpose: these are the plant's own lines, expanded only if it ran.
L_SHEBANG='#!/usr/bin/env bash'
# shellcheck disable=SC2016
L_DIR='SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"'
# shellcheck disable=SC2016
L_SOURCE='. "${SCRIPT_DIR}/lib/prover-isolation.sh"'
L_SHAPE_A='prover_isolate_untracked'
# shellcheck disable=SC2016
L_SHAPE_B='prover_run_in_worktree "$@"'
L_BODY='echo "a planted prover; never executed"'

# write_plant CASE LINE... : the plant for CASE holds exactly these lines.
write_plant() {
    local p
    p="$(plant_of "$1")"
    shift
    printf '%s\n' "$@" > "$p"
}

remove_plant() {
    rm -f -- "$(plant_of "$1")"
}

failures=()
executed=0

# run_lint [PROVERS_DIR] : sets LINT_OUT and LINT_RC.
run_lint() {
    executed=$((executed + 1))
    set +e
    if [ $# -eq 1 ]; then
        LINT_OUT="$(PROVERS_DIR="$1" bash "$LINT" 2>&1)"
    else
        LINT_OUT="$(unset PROVERS_DIR; bash "$LINT" 2>&1)"
    fi
    LINT_RC=$?
    set -e
}

wrong() {
    echo "  $1: WRONG, $2"
    printf '%s\n' "$LINT_OUT" | sed 's/^/      /'
    failures+=("$1: $2")
}

# expect_clean ID : the lint must exit 0 with its OK line.
expect_clean() {
    local id="$1"
    if [ "$LINT_RC" -ne 0 ]; then
        wrong "$id" "exit ${LINT_RC}, expected 0"
        return
    fi
    if ! grep -qE '^OK: [0-9]+ provers' <<< "$LINT_OUT"; then
        wrong "$id" "exit 0 without the 'OK: <n> provers' line"
        return
    fi
    echo "  $id: exit 0 as required"
}

# expect_refused ID CASE RULE : exit 1, the plant the only file named, every line naming
# it carries RULE and nothing else.
expect_refused() {
    local id="$1" plant rule="$3" named others wrong_rule
    plant="$(plant_of "$2")"
    if [ "$LINT_RC" -ne 1 ]; then
        wrong "$id" "exit ${LINT_RC}, expected 1 naming ${plant} and ${rule}"
        return
    fi
    named="$(grep -cF -- "${plant}: ${rule} " <<< "$LINT_OUT" || true)"
    if [ "$named" -lt 1 ]; then
        wrong "$id" "exit 1, but no line names '${plant}: ${rule}'"
        return
    fi
    wrong_rule="$(grep -F -- "${plant}: R" <<< "$LINT_OUT" | grep -vcF -- "${plant}: ${rule} " || true)"
    if [ "$wrong_rule" -gt 0 ]; then
        wrong "$id" "the plant is also refused under a rule other than ${rule}"
        return
    fi
    others="$(grep -E '^[^ ]+: R[0-9] ' <<< "$LINT_OUT" | grep -vcF -- "${plant}: " || true)"
    if [ "$others" -gt 0 ]; then
        wrong "$id" "a file other than the plant is named"
        return
    fi
    echo "  $id: exit 1 naming the plant under ${rule}, as required"
}

# expect_unmeasured ID : exit 2.
expect_unmeasured() {
    local id="$1"
    if [ "$LINT_RC" -ne 2 ]; then
        wrong "$id" "exit ${LINT_RC}, expected 2"
        return
    fi
    echo "  $id: exit 2 as required"
}

echo "prove-provers-isolated-bites: lint under test: $LINT"

# T0 the tree as it is.
run_lint
expect_clean "T0 the tree as it is"

# C1 a restore verb on a code line, in an otherwise valid Shape A prover.
write_plant c1 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf '%s %s -- crates/fabrico-core/src/lib.rs' "$G" "$V_CHECKOUT")"
run_lint
expect_refused "C1 R1 a restore verb on a code line" c1 R1
remove_plant c1

# C2 sources the helper, enters no shape.
write_plant c2 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_BODY"
run_lint
expect_refused "C2 R2 no shape entered" c2 R2
remove_plant c2

# C3 enters Shape A without sourcing the helper.
write_plant c3 "$L_SHEBANG" "$L_DIR" "$L_SHAPE_A" "$L_BODY"
run_lint
expect_refused "C3 R2 the helper not sourced" c3 R2
remove_plant c3

# C4 enters both shapes.
write_plant c4 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_B" "$L_SHAPE_A"
run_lint
expect_refused "C4 R2 two shapes entered" c4 R2
remove_plant c4

# C5 its own EXIT trap.
write_plant c5 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf 'cleanup() { rm -f x; }\n%s cleanup %s' "$K_TRAP" "$K_EXIT")"
run_lint
expect_refused "C5 R3 an exit handler of its own" c5 R3
remove_plant c5

# C6 an in-place sed in a Shape A prover.
write_plant c6 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf 'sed %s "s/a/b/" crates/fabrico-core/src/lib.rs' "$F_INPLACE")"
run_lint
expect_refused "C6 R4 an in-place sed in Shape A" c6 R4
remove_plant c6

# C7 every forbidden form only in comments, with a valid Shape A.
write_plant c7 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf '# the old shape was: %s %s -- f, %s %s -- f, %s %s' \
        "$G" "$V_CHECKOUT" "$G" "$V_RESTORE" "$G" "$V_STASH")" \
    "$(printf '    # and %s cleanup %s, and sed %s "s/a/b/" f' "$K_TRAP" "$K_EXIT" "$F_INPLACE")" \
    "$L_BODY"
run_lint
expect_clean "C7 forbidden forms only in comments"
remove_plant c7

# C8 an in-place sed and kept bytes in a Shape B prover.
write_plant c8 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_B" \
    "${K_KEEP} crates/fabrico-core/src/lib.rs" \
    "$(printf 'sed %s "s/a/b/" crates/fabrico-core/src/lib.rs' "$F_INPLACE")" \
    "${K_PUT} crates/fabrico-core/src/lib.rs"
run_lint
expect_clean "C8 an in-place sed in Shape B"
remove_plant c8

# C9 a hard reset in a Shape A prover: it discards other writers' uncommitted edits.
write_plant c9 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf '%s %s --hard' "$G" "$V_RESET")"
run_lint
expect_refused "C9 R1 a hard reset in Shape A" c9 R1
remove_plant c9

# C10 a clean of untracked files, refused even in Shape B (R1 holds in every shape).
write_plant c10 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_B" \
    "$(printf '%s %s -fdx' "$G" "$V_CLEAN")"
run_lint
expect_refused "C10 R1 a clean of untracked files, even in Shape B" c10 R1
remove_plant c10

# C11 a git rm in a Shape A prover: it stages a deletion in the shared index.
write_plant c11 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf '%s %s -q crates/fabrico-core/src/lib.rs' "$G" "$V_RM")"
run_lint
expect_refused "C11 R1 a staged deletion in Shape A" c11 R1
remove_plant c11

# C12 the declared-moves prover's own shape: rm and an unstaging reset in Shape B.
write_plant c12 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_B" \
    "$(printf '%s %s -q crates/fabrico-core/src/lib.rs' "$G" "$V_RM")" \
    "$(printf '%s %s -q -- crates/fabrico-core/src/lib.rs' "$G" "$V_RESET")"
run_lint
expect_clean "C12 a staged deletion and an unstaging reset in Shape B"
remove_plant c12

# C13 staging everything in a Shape A prover: other writers' uncommitted work joins the index.
write_plant c13 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf '%s %s -A' "$G" "$V_ADD")"
run_lint
expect_refused "C13 R1 staging everything in Shape A" c13 R1
remove_plant c13

# C14 a config key that begins with a verb is not the verb.
write_plant c14 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_A" \
    "$(printf '%s -c %s.gpgsign=false log -1' "$G" "$V_COMMIT")"
run_lint
expect_clean "C14 a -c commit.<key> option is not a commit"
remove_plant c14

# C15 a Shape B prover whose hard reset sits above prover_run_in_worktree: the outer run
# executes it in the shared checkout, before the helper takes its snapshot (review 84
# iteration 2 WR-01).
write_plant c15 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" \
    "$(printf '%s %s --hard' "$G" "$V_RESET")" "$L_SHAPE_B"
run_lint
expect_refused "C15 R1 a hard reset above the Shape B line" c15 R1
remove_plant c15

# C16 the same placement for an in-place sed: above the Shape B line it edits the shared tree.
write_plant c16 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" \
    "$(printf 'sed %s "s/a/b/" crates/fabrico-core/src/lib.rs' "$F_INPLACE")" "$L_SHAPE_B"
run_lint
expect_refused "C16 R4 an in-place sed above the Shape B line" c16 R4
remove_plant c16

# C17 the Shape B line indented inside a function (review 84 iteration 3 WR-02): the outer
# run executes every line before the call, in the shared checkout, and the HEAD lint read
# the indented line as the shape and every line below it as safe.
write_plant c17 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "enter() {" "    ${L_SHAPE_B}" "}" \
    "$L_BODY" 'enter "$@"'
run_lint
expect_refused "C17 R2 the Shape B line indented inside a function" c17 R2
remove_plant c17

# C18 the Shape B line indented inside an `if` the outer run may never take.
write_plant c18 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" \
    'if [ "${FABRICO_PROVER_INNER:-}" = 1 ]; then' "    ${L_SHAPE_B}" "fi" "$L_BODY"
run_lint
expect_refused "C18 R2 the Shape B line indented inside an if" c18 R2
remove_plant c18

# C19 one shape line at column 0 is counted, and an indented call elsewhere is a second
# way in: a function holding it can run before the column-0 line is reached.
write_plant c19 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "early() {" "    ${L_SHAPE_B}" "}" \
    "$L_SHAPE_B" "$L_BODY"
run_lint
expect_refused "C19 R2 an indented second call beside a column-0 shape line" c19 R2
remove_plant c19

# C20 (review 92 WR-A-05): a Shape B prover that links the caller's WHOLE node_modules into
# its worktree. A Vite started there writes its dependency cache through the link into the
# shared `frontend/node_modules/.vite`, which the tracked comparison cannot see.
# shellcheck disable=SC2016
write_plant c20 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_B" \
    "${K_LN}"' -s "${CALLER}/frontend/node_modules" frontend/node_modules' "$L_BODY"
run_lint
expect_refused "C20 R5 a whole node_modules linked into the worktree" c20 R5
remove_plant c20

# C21 the sanctioned shape: the helper links entry by entry, every entry but the caches; a
# plain per-entry link names an entry, never a directory called node_modules.
# shellcheck disable=SC2016
write_plant c21 "$L_SHEBANG" "$L_DIR" "$L_SOURCE" "$L_SHAPE_B" \
    'prover_link_node_modules "${CALLER}/frontend/node_modules" frontend/node_modules' \
    "${K_LN}"' -s "${CALLER}/frontend/node_modules/vite" frontend/node_modules/vite' "$L_BODY"
run_lint
expect_clean "C21 node_modules linked entry by entry"
remove_plant c21

# --- The helper's runtime half, in a scratch repository (X1 to X5) ---------------------
RT="$TMP/rt"
mkdir -p "$RT/scripts/lib"
cp "$HELPER_UNDER_TEST" "$RT/scripts/lib/prover-isolation.sh"
printf 'tracked\n' >"$RT/README"
if ! { "$G" -C "$RT" init -q &&
    "$G" -C "$RT" "$V_ADD" README &&
    "$G" -C "$RT" -c user.name=prover -c user.email=prover@localhost -c commit.gpgsign=false \
        -c core.hooksPath=/dev/null "$V_COMMIT" -q -m scratch; } >/dev/null 2>&1; then
    echo "prove-provers-isolated-bites: could not make the scratch repository; COULD NOT PROVE" >&2
    exit 2
fi

# write_rt CASE LINE... : a runtime plant in the scratch repository, sourcing its helper.
write_rt() {
    local c="$1"
    shift
    printf '%s\n' "$L_SHEBANG" 'set -euo pipefail' "$L_DIR" "$L_SOURCE" "$@" >"$RT/scripts/rt-$c.sh"
}

# run_rt CASE [ARG...] : runs it from the scratch repository; sets RT_OUT and RT_RC.
run_rt() {
    local c="$1"
    shift
    executed=$((executed + 1))
    set +e
    RT_OUT="$(cd "$RT" && FABRICO_PROVER_INNER='' bash "scripts/rt-$c.sh" "$@" 2>&1)"
    RT_RC=$?
    set -e
}

# expect_rt ID RC [TEXT] : exit RC and, when given, TEXT in the output.
expect_rt() {
    local id="$1" want="$2" text="${3:-}"
    if [ "$RT_RC" -ne "$want" ]; then
        LINT_OUT="$RT_OUT"
        wrong "$id" "exit ${RT_RC}, expected ${want}"
        return
    fi
    if [ -n "$text" ] && ! grep -F -- "$text" >/dev/null <<<"$RT_OUT"; then
        LINT_OUT="$RT_OUT"
        wrong "$id" "exit ${want}, but the output does not say '${text}'"
        return
    fi
    echo "  $id: exit ${want} as required"
}

L_HELP='case "${1:-}" in -h | --help) echo usage; exit 0 ;; esac'

write_rt x1 "$L_SHAPE_A" "$L_BODY"
run_rt x1
expect_rt "X1 a clean Shape A plant runs" 0

write_rt x2 "$L_HELP" "$L_SHAPE_A" "$L_BODY"
run_rt x2 --help
expect_rt "X2 a usage print before the shape keeps its 0" 0 "usage"

write_rt x3 'if [ -n "${PROVE_NEVER_SET_X3:-}" ]; then' "$L_SHAPE_A" "fi" "$L_BODY"
run_rt x3
expect_rt "X3 a run that never entered its shape is exit 2" 2 "without entering an isolation shape"

write_rt x4 "enter() {" "$L_SHAPE_A" "}" "enter" "$L_BODY"
run_rt x4
expect_rt "X4 a shape called from a function is exit 2" 2 "from inside a function or a subshell"

write_rt x5 "printf 'x\\n' >>README" "$L_SHAPE_A" "$L_BODY"
run_rt x5
expect_rt "X5 a tracked write above the shape line is exit 2" 2 "changed between sourcing"

# E1 an empty directory.
mkdir "$TMP/empty"
run_lint "$TMP/empty"
expect_unmeasured "E1 PROVERS_DIR at an empty directory"

# E2 the helper and three valid provers: below the floor.
mkdir -p "$TMP/floor/lib"
cp scripts/lib/prover-isolation.sh "$TMP/floor/lib/"
cp scripts/prove-live-red-set-bites.sh scripts/measure-golden-corpus.sh \
    scripts/determinism-gate-negative-test.sh "$TMP/floor/"
run_lint "$TMP/floor"
expect_unmeasured "E2 PROVERS_DIR below the floor"

DECLARED_TOTAL=29
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("ran $executed cases, declared $DECLARED_TOTAL")
fi

if [ "${#failures[@]}" -gt 0 ]; then
    echo "prove-provers-isolated-bites: NOT PROVEN, ${#failures[@]} case(s) wrong:"
    for f in "${failures[@]}"; do
        echo "  - $f"
    done
    exit 1
fi
echo "prove-provers-isolated-bites: PROVEN, all ${executed} cases as required"
exit 0
