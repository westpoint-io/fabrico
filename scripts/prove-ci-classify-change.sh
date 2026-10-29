#!/usr/bin/env bash
#
# prove-ci-classify-change.sh - the both-ways proof for scripts/ci-classify-change.sh, the
# script that lets a docs-only change skip the heavy CI jobs (2026-09-30).
#
# WHY IT RUNS IN CI, BEFORE THE CLASSIFIER. The classifier is the one script in this
# repository whose verdict can switch other gates OFF. A classifier that has drifted
# towards "true" skips real verification silently. So the `changes` job in
# .github/workflows/ci.yml runs this prover first, in the same job; if it fails, the job
# fails, the classifier never runs, the job's output stays empty, and every heavy job
# runs (the workflow skips only on the exact string `true`).
#
# WHAT EACH CASE GROUP PROVES.
#   R1-R9  HISTORY SHAPES built in a throwaway repository (a master line with a merged
#          feature branch), so the proof needs no particular history in this checkout.
#          R1/R7 (a commit that changed only root markdown, as a push and as a
#          pull_request) must be true; code, non-markdown evidence beside a root markdown
#          file (R3), a PR merge commit, a multi-commit push and a code PR must be false;
#          a push whose base is not an ancestor of its head (R8, force push) and an empty
#          range (R9) must be false.
#   F1-F9  FAIL-SAFE paths. Each holds R1's docs-only SHAs in every variable it does not
#          vary, so its expected false can only come from the one field under test:
#          workflow_dispatch, schedule, an empty event, an empty / all-zero / missing /
#          revision-expression push base, an empty pull_request base. F9 unsets
#          GITHUB_OUTPUT and requires a non-zero exit.
#   S1-S5  SHAPES built in a second throwaway repository: a rename out of code into a
#          root markdown file (false, only visible with --no-renames), a root README change (true), a
#          docs/ markdown change (false), a markdown change under crates/ (false), and a
#          depth-2 shallow clone over a root-README-only range (false, the shallow rule
#          alone decides it).
#
# Every case except F9 must exit 0 and leave EXACTLY ONE `docs_only=` line in its own
# fresh GITHUB_OUTPUT file. All five CLASSIFY_* variables are unset before each case and
# only the ones that case names are set, so nothing leaks from the previous case.
#
# NON-VACUITY. The number of executed cases must equal the declared total, and at least
# one true and one false outcome must have been observed, or this exits 1.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected.
#   1  one or more cases wrong; every wrong case is named in one run.
#   2  the proof could not be made: no git, a throwaway-repository git failure, or a
#      temp-dir failure.

set -u

# Sourced before any change of directory: the helper records where this script lives. Its
# Shape A with no probes (plan 84-04, GATE-03): every write here is under `mktemp -d`, and
# the helper compares this checkout's tracked tree before and after to prove it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "prove-ci-classify-change: cannot cd to repo root" >&2; exit 2; }
ROOT="$(pwd)"
CLASSIFIER="$ROOT/scripts/ci-classify-change.sh"

if ! command -v git >/dev/null 2>&1; then
    echo "prove-ci-classify-change: git not found; COULD NOT PROVE" >&2
    exit 2
fi
if [ ! -f "$CLASSIFIER" ]; then
    echo "prove-ci-classify-change: $CLASSIFIER missing; COULD NOT PROVE" >&2
    exit 2
fi

MISSING_SHA=0123456789abcdef0123456789abcdef01234567
ZERO_SHA=0000000000000000000000000000000000000000

TMPROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-ci-classify.XXXXXX")" || {
    echo "prove-ci-classify-change: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmproot() {
    rm -rf -- "$TMPROOT"
}
prover_on_exit remove_tmproot
# shellcheck disable=SC2119  # no probes: this run writes only under mktemp -d
prover_isolate_untracked

DECLARED_TOTAL=23
executed=0
saw_true=0
saw_false=0
failures=()

# run_case ID EXPECTED DIR [NAME=VALUE ...]
#   EXPECTED is true, false, or nonzero (the classifier must exit non-zero, F9).
#   DIR is the working directory the classifier runs in.
run_case() {
    local id="$1" expected="$2" dir="$3"
    shift 3
    local out rc lines value
    executed=$((executed + 1))

    local -a envargs=(-u CLASSIFY_EVENT -u CLASSIFY_PR_BASE -u CLASSIFY_PR_HEAD
        -u CLASSIFY_PUSH_BEFORE -u CLASSIFY_PUSH_AFTER -u GITHUB_OUTPUT)
    if [ "$expected" = "nonzero" ]; then
        (cd "$dir" && env "${envargs[@]}" "$@" bash "$CLASSIFIER") >/dev/null 2>&1
        rc=$?
        if [ "$rc" -ne 0 ]; then
            echo "  $id: exit $rc as required (GITHUB_OUTPUT unset)"
        else
            echo "  $id: WRONG, exit 0 with GITHUB_OUTPUT unset"
            failures+=("$id: exit 0 with GITHUB_OUTPUT unset, expected non-zero")
        fi
        return
    fi

    out="$(mktemp "$TMPROOT/out.XXXXXX")" || {
        echo "prove-ci-classify-change: mktemp failed; COULD NOT PROVE" >&2
        exit 2
    }
    (cd "$dir" && env "${envargs[@]}" GITHUB_OUTPUT="$out" "$@" bash "$CLASSIFIER") >"$out.log" 2>&1
    rc=$?
    lines="$(grep -c '^docs_only=' "$out")"
    value="$(sed -n 's/^docs_only=//p' "$out")"

    if [ "$value" = "true" ]; then saw_true=1; fi
    if [ "$value" = "false" ]; then saw_false=1; fi

    if [ "$rc" -ne 0 ]; then
        echo "  $id: WRONG, classifier exit $rc"
        failures+=("$id: classifier exited $rc, expected 0 ($(head -n 1 "$out.log"))")
    elif [ "$lines" != "1" ] || [ "$(wc -l <"$out" | tr -d ' ')" != "1" ]; then
        echo "  $id: WRONG, GITHUB_OUTPUT holds $(wc -l <"$out" | tr -d ' ') line(s), $lines docs_only= line(s)"
        failures+=("$id: GITHUB_OUTPUT must hold exactly one docs_only= line")
    elif [ "$value" != "$expected" ]; then
        echo "  $id: WRONG, docs_only=$value, expected $expected ($(head -n 1 "$out.log"))"
        failures+=("$id: docs_only=$value, expected $expected")
    else
        echo "  $id: docs_only=$value as expected"
    fi
}

# The history shapes, built in a throwaway repository: a base commit, a code commit (R2),
# an evidence commit (R3), a feature branch with a code change merged with --no-ff (R4, the
# branch tip is R6's code PR head), then a root-markdown-only commit (R1).
HIST="$TMPROOT/history"
h() {
    git -C "$HIST" -c user.name=prove -c user.email=prove@invalid -c commit.gpgsign=false \
        -c core.hooksPath=/dev/null -c init.defaultBranch=master "$@"
}
mkdir -p "$HIST/crates" "$HIST/frontend" "$HIST/docs" || exit 2
if ! h init -q; then
    echo "prove-ci-classify-change: git init failed; COULD NOT PROVE" >&2
    exit 2
fi
printf 'fn a() {}\n' >"$HIST/crates/a.rs"
printf 'export const g = 1;\n' >"$HIST/frontend/g.ts"
printf '# readme\n' >"$HIST/README.md"
printf '# status\n' >"$HIST/STATUS.md"
printf '# docs\n' >"$HIST/docs/x.md"
hist_commit() {
    h add -A >/dev/null && h commit -q -m "$1" >/dev/null && h rev-parse HEAD
}
if ! H0="$(hist_commit h0-base)"; then echo "prove-ci-classify-change: throwaway commit failed; COULD NOT PROVE" >&2; exit 2; fi
printf 'export const g = 2;\n' >"$HIST/frontend/g.ts"
if ! H1="$(hist_commit h1-code)"; then exit 2; fi
printf 'PNG' >"$HIST/evidence.png"
printf 'measured\n' >"$HIST/evidence.txt"
printf '# status\nmeasured\n' >"$HIST/STATUS.md"
if ! H2="$(hist_commit h2-evidence)"; then exit 2; fi
h checkout -q -b feature || exit 2
printf 'fn a() { let _ = 1; }\n' >"$HIST/crates/a.rs"
if ! FEATURE_HEAD="$(hist_commit h3-feature-code)"; then exit 2; fi
h checkout -q master || exit 2
h merge -q --no-ff -m h4-merge feature >/dev/null || exit 2
if ! H4="$(h rev-parse HEAD)"; then exit 2; fi
printf '# readme\nmore\n' >"$HIST/README.md"
printf '# status\nmeasured\nmore\n' >"$HIST/STATUS.md"
if ! H5="$(hist_commit h5-root-markdown)"; then exit 2; fi
if h cat-file -e "${MISSING_SHA}^{commit}" 2>/dev/null; then
    echo "prove-ci-classify-change: the missing-SHA probe $MISSING_SHA exists here; COULD NOT PROVE" >&2
    exit 2
fi

R1_BEFORE="$H4"          # parent of the root-markdown-only commit
R1_AFTER="$H5"           # README.md and STATUS.md only
R2_BEFORE="$H0"
R2_AFTER="$H1"           # frontend/g.ts
R3_BEFORE="$H1"
R3_AFTER="$H2"           # evidence: png, txt, one root md
R4_BEFORE="$H2"
R4_AFTER="$H4"           # a PR merge commit
R6_HEAD="$FEATURE_HEAD"  # a code PR head

echo "prove-ci-classify-change: history shapes"
run_case R1 true "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R1_BEFORE" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case R2 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R2_BEFORE" CLASSIFY_PUSH_AFTER="$R2_AFTER"
run_case R3 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R3_BEFORE" CLASSIFY_PUSH_AFTER="$R3_AFTER"
run_case R4 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R4_BEFORE" CLASSIFY_PUSH_AFTER="$R4_AFTER"
run_case R5 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R4_BEFORE" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case R6 false "$HIST" CLASSIFY_EVENT=pull_request CLASSIFY_PR_BASE="$R4_BEFORE" CLASSIFY_PR_HEAD="$R6_HEAD"
run_case R7 true "$HIST" CLASSIFY_EVENT=pull_request CLASSIFY_PR_BASE="$R1_BEFORE" CLASSIFY_PR_HEAD="$R1_AFTER"
run_case R8 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R1_AFTER" CLASSIFY_PUSH_AFTER="$R1_BEFORE"
run_case R9 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$R1_AFTER" CLASSIFY_PUSH_AFTER="$R1_AFTER"

echo "prove-ci-classify-change: fail-safe paths (R1's docs-only SHAs held everywhere else)"
DOCS_ENV=(CLASSIFY_PR_BASE="$R1_BEFORE" CLASSIFY_PR_HEAD="$R1_AFTER"
    CLASSIFY_PUSH_BEFORE="$R1_BEFORE" CLASSIFY_PUSH_AFTER="$R1_AFTER")
run_case F1 false "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=workflow_dispatch
run_case F2 false "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=schedule
run_case F3 false "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=
run_case F4 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE= CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F5 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$ZERO_SHA" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F6 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$MISSING_SHA" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F7 false "$HIST" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="${R1_AFTER}^" CLASSIFY_PUSH_AFTER="$R1_AFTER"
run_case F8 false "$HIST" CLASSIFY_EVENT=pull_request CLASSIFY_PR_BASE= CLASSIFY_PR_HEAD="$R1_AFTER"
run_case F9 nonzero "$HIST" "${DOCS_ENV[@]}" CLASSIFY_EVENT=push

echo "prove-ci-classify-change: shapes in a second throwaway repository"
REPO="$TMPROOT/repo"
g() {
    git -C "$REPO" -c user.name=prove -c user.email=prove@invalid -c commit.gpgsign=false \
        -c core.hooksPath=/dev/null -c init.defaultBranch=master "$@"
}
mkdir -p "$REPO" || exit 2
if ! g init -q; then
    echo "prove-ci-classify-change: git init failed; COULD NOT PROVE" >&2
    exit 2
fi
mkdir -p "$REPO/crates/x" "$REPO/docs"
printf 'fn a() {}\n' >"$REPO/crates/a.rs"
printf '# readme\n' >"$REPO/README.md"
printf '# docs\n' >"$REPO/docs/x.md"
printf '# crate readme\n' >"$REPO/crates/x/README.md"
commit_all() {
    g add -A >/dev/null && g commit -q -m "$1" >/dev/null && g rev-parse HEAD
}
if ! C0="$(commit_all c0)"; then echo "prove-ci-classify-change: throwaway commit failed; COULD NOT PROVE" >&2; exit 2; fi
g mv crates/a.rs a.md || exit 2
if ! C1="$(commit_all c1-rename-code-into-root-markdown)"; then exit 2; fi
printf '# readme\nmore\n' >"$REPO/README.md"
if ! C2="$(commit_all c2-root-readme)"; then exit 2; fi
printf '# docs\nmore\n' >"$REPO/docs/x.md"
if ! C3="$(commit_all c3-docs-dir)"; then exit 2; fi
printf '# crate readme\nmore\n' >"$REPO/crates/x/README.md"
if ! C4="$(commit_all c4-crate-readme)"; then exit 2; fi
printf '# readme\nmore\nagain\n' >"$REPO/README.md"
if ! C5="$(commit_all c5-root-readme-again)"; then exit 2; fi

run_case S1 false "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C0" CLASSIFY_PUSH_AFTER="$C1"
run_case S2 true "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C1" CLASSIFY_PUSH_AFTER="$C2"
run_case S3 false "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C2" CLASSIFY_PUSH_AFTER="$C3"
run_case S4 false "$REPO" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C3" CLASSIFY_PUSH_AFTER="$C4"

SHALLOW="$TMPROOT/shallow"
if ! git -c core.hooksPath=/dev/null clone -q --depth 2 "file://$REPO" "$SHALLOW" 2>/dev/null; then
    echo "prove-ci-classify-change: shallow clone failed; COULD NOT PROVE" >&2
    exit 2
fi
if [ "$(git -C "$SHALLOW" rev-parse --is-shallow-repository)" != "true" ]; then
    echo "prove-ci-classify-change: the depth-2 clone is not shallow; COULD NOT PROVE" >&2
    exit 2
fi
run_case S5 false "$SHALLOW" CLASSIFY_EVENT=push CLASSIFY_PUSH_BEFORE="$C4" CLASSIFY_PUSH_AFTER="$C5"

echo
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("executed $executed case(s), declared $DECLARED_TOTAL")
fi
if [ "$saw_true" -ne 1 ] || [ "$saw_false" -ne 1 ]; then
    failures+=("both outcomes must be observed (saw true: $saw_true, saw false: $saw_false)")
fi

if [ "${#failures[@]}" -gt 0 ]; then
    echo "NOT PROVEN: ${#failures[@]} problem(s):"
    for f in "${failures[@]}"; do
        echo "  - $f"
    done
    exit 1
fi
echo "PROVEN: $executed of $DECLARED_TOTAL cases as expected; both outcomes observed (true and false)."
exit 0
