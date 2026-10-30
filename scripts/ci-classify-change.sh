#!/usr/bin/env bash
#
# ci-classify-change.sh - decide whether a CI run's change is DOCS-ONLY, so the heavy
# jobs in .github/workflows/ci.yml (determinism, golden-corpus, e2e, e2e-live, unit,
# headless-build) can be skipped (2026-09-30).
#
# WHY. The heavy jobs cost thousands of Linux-equivalent CI minutes a day, and many
# pushes change only markdown notes, which no heavy job reads.
#
# WHAT DOCS-ONLY MEANS. The changed-path list is NON-EMPTY and every path is at the
# repository root (no `/` in it) and ends in `.md` (README.md, STATUS.md).
# Case-sensitive: `.MD` is not docs. NOT docs: anything under `docs/`, any markdown under
# `crates/` or `frontend/`, any non-markdown file (PNG, SVG, JSON evidence), and every
# other path.
#
# THE MEASURED INVARIANT THIS RESTS ON (2026-09-30). No heavy job reads a markdown file
# at the repository root; every hit of a search for such reads was a display string or a
# test title. The one gate that DID read a markdown note (`check-neutrality.sh`) was moved
# out of `unit` into its own always-on `neutrality` job in the same change.
#
# THE RESIDUAL, stated plainly. If a heavy job ever starts reading such a file, a
# docs-only push that edits it skips that job. The next code push re-runs every heavy job
# over the whole tree and surfaces the red then, one push late.
#
# FAIL-SAFE DIRECTION. Every path through this script that is not a positive, complete
# proof of docs-only decides `docs_only=false`, which runs everything:
# workflow_dispatch and every event other than push and pull_request, an empty,
# malformed, all-zero or missing SHA, a push whose base is not an ancestor of its head
# (force push), a failed merge-base, a shallow checkout, a git error, and an empty diff.
# Renames are listed as a delete plus an add (`--no-renames`), so moving a file OUT of a
# code path to a root markdown file still lists the code path.
#
# CONTRACT.
#   inputs  env CLASSIFY_EVENT, CLASSIFY_PR_BASE, CLASSIFY_PR_HEAD, CLASSIFY_PUSH_BEFORE,
#           CLASSIFY_PUSH_AFTER (any may be empty). git runs in the CURRENT working
#           directory, which in CI is the checkout root; the prover relies on this to run
#           it inside a throwaway repository.
#   output  exactly one line, `docs_only=true` or `docs_only=false`, appended to the file
#           named by GITHUB_OUTPUT, plus a human-readable reason on stdout.
#   exit    0 when a decision was written (either value); 2 when GITHUB_OUTPUT is unset or
#           not writable. On exit 2 the job goes red and its output stays empty, which the
#           workflow's gate reads as "not docs-only", so the heavy jobs run.
#
# Event values arrive through env only; the workflow never interpolates them into a
# command line. Each SHA must match ^[0-9a-f]{40}$ before it reaches any git call.
#
# Proved by scripts/prove-ci-classify-change.sh, which CI runs immediately before this.

set -u

if [ -z "${GITHUB_OUTPUT:-}" ]; then
    echo "ci-classify-change: GITHUB_OUTPUT is not set; no decision can be recorded" >&2
    exit 2
fi
if ! { : >>"$GITHUB_OUTPUT"; } 2>/dev/null; then
    echo "ci-classify-change: GITHUB_OUTPUT ($GITHUB_OUTPUT) is not writable" >&2
    exit 2
fi

PATHS_FILE=""
cleanup() {
    if [ -n "$PATHS_FILE" ]; then
        rm -f -- "$PATHS_FILE"
    fi
}
trap cleanup EXIT

# The single place a decision is written. Every call is followed by `exit 0`.
decide() {
    local value="$1" reason="$2"
    if ! printf 'docs_only=%s\n' "$value" >>"$GITHUB_OUTPUT"; then
        echo "ci-classify-change: could not append to GITHUB_OUTPUT" >&2
        exit 2
    fi
    echo "docs_only=${value}: ${reason}"
}

is_sha() {
    [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

is_commit() {
    git cat-file -e "$1^{commit}" 2>/dev/null
}

is_docs_path() {
    local path="$1"
    if [[ "$path" != */* && "$path" == *.md ]]; then
        return 0
    fi
    return 1
}

EVENT="${CLASSIFY_EVENT:-}"

# (1) A shallow checkout cannot be trusted to hold both ends of the diff.
shallow="$(git rev-parse --is-shallow-repository 2>/dev/null)"
if [ "$shallow" != "false" ]; then
    decide false "shallow checkout or git error (is-shallow-repository printed '${shallow}')"
    exit 0
fi

# (2) Pick the two ends from the event. Anything else runs everything.
case "$EVENT" in
    pull_request)
        FROM="${CLASSIFY_PR_BASE:-}"
        TO="${CLASSIFY_PR_HEAD:-}"
        ;;
    push)
        FROM="${CLASSIFY_PUSH_BEFORE:-}"
        TO="${CLASSIFY_PUSH_AFTER:-}"
        ;;
    *)
        decide false "event '${EVENT}' always runs every job"
        exit 0
        ;;
esac

# (3) Shape, then existence.
if ! is_sha "$FROM" || ! is_sha "$TO"; then
    decide false "a SHA is empty or not 40 lowercase hex characters (from='${FROM}' to='${TO}')"
    exit 0
fi
if [ "$FROM" = "0000000000000000000000000000000000000000" ]; then
    decide false "no previous commit (base is all zeros)"
    exit 0
fi
if ! is_commit "$FROM" || ! is_commit "$TO"; then
    decide false "a SHA is not a commit in this checkout (from=${FROM} to=${TO})"
    exit 0
fi

# (4) The diff base.
if [ "$EVENT" = "push" ]; then
    if ! git merge-base --is-ancestor "$FROM" "$TO" 2>/dev/null; then
        decide false "force push or rewritten history (${FROM} is not an ancestor of ${TO})"
        exit 0
    fi
    DIFF_FROM="$FROM"
else
    if ! DIFF_FROM="$(git merge-base "$FROM" "$TO" 2>/dev/null)" || ! is_sha "$DIFF_FROM"; then
        decide false "no merge base between ${FROM} and ${TO}"
        exit 0
    fi
fi

# (5) The changed paths, renames split into delete plus add.
if ! PATHS_FILE="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ci-classify.XXXXXX")"; then
    PATHS_FILE=""
    decide false "could not create a temp file"
    exit 0
fi
if ! git diff --no-renames --name-only -z "$DIFF_FROM" "$TO" >"$PATHS_FILE" 2>/dev/null; then
    decide false "git diff failed for ${DIFF_FROM}..${TO}"
    exit 0
fi

# (6) and (7) Classify every path; the first non-docs path decides false.
count=0
first_non_docs=""
listed=()
while IFS= read -r -d '' path; do
    count=$((count + 1))
    if [ "${#listed[@]}" -lt 20 ]; then
        listed+=("$path")
    fi
    if [ -z "$first_non_docs" ] && ! is_docs_path "$path"; then
        first_non_docs="$path"
    fi
done <"$PATHS_FILE"

print_paths() {
    echo "changed paths: ${count}"
    local p
    for p in "${listed[@]+"${listed[@]}"}"; do
        echo "  ${p}"
    done
    if [ "$count" -gt 20 ]; then
        echo "  ... and $((count - 20)) more"
    fi
}

if [ "$count" -eq 0 ]; then
    decide false "nothing to classify (empty diff ${DIFF_FROM}..${TO})"
    print_paths
    exit 0
fi
if [ -n "$first_non_docs" ]; then
    decide false "'${first_non_docs}' is not a markdown file at the repository root"
    print_paths
    exit 0
fi

decide true "every changed path is markdown at the repository root"
print_paths
exit 0
