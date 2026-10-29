#!/usr/bin/env bash
#
# No tracked file carries PRIVATE RESIDUE: the maintainer's personal details, paths from
# the maintainer's own machine, or pointers into the private planning checkout that lives
# beside this repository and is ignored by it.
#
# WHY. This repository was published from a private one. The planning notes, the
# assistant tooling that wrote many of them and the maintainer's own machine stayed
# behind, and every reference to them was removed from the code before the first public
# commit. A reference that comes back is either a broken pointer (a path nobody outside
# can open) or personal data. Both are cheap to reintroduce by accident, because the
# private checkout sits inside this working tree and a comment can cite it in passing.
# This gate makes the removal permanent: it runs on every push.
#
# WHAT IT LOOKS FOR, as extended regular expressions over every TRACKED text file:
#   - the maintainer's legal names (first, middle and family) and handle, and any gmail
#     address;
#   - a home directory path, `/home/<user>/`;
#   - a path into the private planning directory, or the assistant's memory file name;
#   - the assistant, its vendor, or the planning tool, by name;
#   - the desktop environment and window manager of the maintainer's machine;
#   - the maintainer's first name as written in English, as a capitalised word of its
#     own. The match is case-sensitive and a hyphen or a digit counts as part of the
#     word, so the product nouns and verbs that share the spelling still pass: the brand
#     mark, LogoMark, a marker, the MARK-nn requirement ids, a `<name>-sheet`, the
#     lowercase verb ("mark the job required"). A sentence that starts with the verb is
#     the one shape that also matches; reword it ("Flag the fixture READY"). An earlier
#     version matched only a list of person-shaped phrases (the possessive, "<name> said",
#     "ask <name>"), and the private notes used far more wording than any list held.
#   - a tracked file whose name says text but which holds a NUL byte. That is UTF-16 or a
#     smuggled binary, and the byte search below cannot read either reliably.
#
# The names are stored rot13-encoded and decoded when the script starts, so this file
# does not itself spell them out. The encoding hides nothing from a reader; it only keeps
# a plain-text search of the tree from finding them here.
#
# WHAT IS NOT SCANNED, AND WHY. Untracked and ignored files are not scanned: the private
# checkout lives in the working tree on purpose, and `git ls-files` is what separates it
# from the repository.
#
# BINARY FILES ARE SEARCHED TOO (`grep -a`, under `LC_ALL=C`). GNU grep's `-I`, or its
# default under a UTF-8 locale such as CI's, treats a file as binary once it holds one
# invalid UTF-8 byte (a Latin-1 accented letter) or one NUL, and then reports no match
# at all: a single stray byte would hide every name in the file. Searching bytes under
# the C locale removes that classification. The binary fixtures, images and fonts in
# the tree hold none of the patterns, so this costs no false finding.
#
# THE EXCLUSION LIST IS EXACTLY TWO EXACT PATHS: this script and its prover, which spell
# out every pattern by definition. Both must exist (a stale exclusion is exit 2). Every
# other file in scripts/ IS scanned.
#
# THE ALLOWANCE LIST IS EXACT LINES OF ONE FILE. `.gitignore` must name the private
# checkout's three paths to keep them out of the repository, so exactly those three whole
# lines are allowed there. Any other line in `.gitignore` that matches, including a
# comment that names them, is a finding.
#
# HONESTY MECHANISMS, the same contract as scripts/check-dev-pace-switch-absent.sh:
#   1. the scan set comes from `git ls-files`, its size is printed, and below a floor the
#      run is exit 2;
#   2. a positive control token must be found in the scan set, or the run is exit 2 (a
#      search that finds nothing looks identical whether the tree is clean or the search
#      is broken);
#   3. every exclusion must exist;
#   4. exit 2 means "could not assert", never a pass.
# Every pattern is searched even after an earlier one is found, so one run names every
# offending line.
#
# PROOF IT BITES: scripts/prove-no-private-residue-bites.sh, which runs beside this in CI.
#
# EXIT CODES
#   0  no tracked file carries residue, and the run could make that assertion.
#   1  at least one match; every offending file and line is named.
#   2  the assertion could not be made (no git tree, a scan set below the floor, the
#      positive control not found, a stale exclusion, a search that reported an error).
#      Never a pass.

set -u

# Byte semantics for every grep and character class below: no locale can decide that a
# file is binary or that a byte sequence is not a character. See BINARY FILES above.
export LC_ALL=C

rot13() {
    printf '%s' "$1" | tr 'A-Za-z' 'N-ZA-Mn-za-m'
}

# The encoded names: the maintainer's first name as written in English, the legal first
# and middle names, the family name and the handle.
P_FIRST="$(rot13 'Znex')"
P_LEGAL="$(rot13 'zruqv')"
P_MIDDLE="$(rot13 'funuv')"
P_FAMILY="$(rot13 'niqv')"
P_HANDLE="$(rot13 'zniqv')"

# The character classes that start and end a word for the first-name pattern. A hyphen
# and a digit do not, so `<name>-sheet`, `<NAME>-01` and `<name>Craft` never match.
WB='(^|[^A-Za-z0-9_-])'
NB='([^A-Za-z0-9_-]|$)'

# Each entry is `label<TAB>flags<TAB>ERE`. Flags: `i` for case-insensitive, `-` for
# case-sensitive.
PATTERNS=(
    "legal first name	i	${P_LEGAL}"
    "legal middle name	i	${P_MIDDLE}"
    "family name	i	${P_FAMILY}"
    "handle	i	${P_HANDLE}"
    "gmail address	i	@gmail[.]"
    "home directory path	-	/home/[^/[:space:]\"'\`]+/"
    "private planning path	i	[.]planning/"
    "assistant memory file	i	claude[.]md"
    "assistant name	i	claude"
    "assistant vendor	i	anthropic"
    "planning tool	i	(^|[^A-Za-z0-9])gsd([^A-Za-z0-9]|$)"
    "desktop environment	i	omarchy"
    "window manager	i	hyprland"
    "first name, as a word	-	${WB}${P_FIRST}${NB}"
)

EXCLUSIONS=(
    "scripts/check-no-private-residue.sh"
    "scripts/prove-no-private-residue-bites.sh"
)

ALLOWED_FILE=".gitignore"
ALLOWED_LINES=(
    ".planning/"
    "CLAUDE.md"
    ".claude/"
)

# The project's own name, which every scanned tree carries many times over.
POSITIVE_CONTROL="fabrico"
POSITIVE_CONTROL_OVERRIDDEN=0

# The tree holds well over a thousand tracked files. The floor catches a walk that found
# nothing, not the tree's size.
MIN_SCAN_FILES=300

usage() {
    cat <<'USAGE'
usage: bash scripts/check-no-private-residue.sh [options]

Asserts that no tracked text file names the maintainer, a home directory path, the
private planning checkout, or the tooling and machine behind it. See the header of this
script for the full pattern list.

  --positive-control <tok>  override the positive-control token. For the prover only.
  --min-scan-files <n>      override the scan-set floor. For the prover only.
  -h, --help                this message.

EXIT CODES
  0  no residue, and the run could make that assertion.
  1  residue FOUND; every offending file and line is named.
  2  the assertion COULD NOT BE MADE. Never a pass.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
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

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
    echo "FAIL: not inside a git working tree, so the scan set cannot be enumerated." >&2
    exit 2
fi
cd "$REPO_ROOT" || exit 2

failed=0
cannot_assert=0

# --- Guard 1: every exclusion exists ------------------------------------------------
echo "exclusions (${#EXCLUSIONS[@]} exact paths, each asserted to exist):"
for ex in "${EXCLUSIONS[@]}"; do
    if [ -e "$ex" ]; then
        echo "  ${ex}"
    else
        echo "  ${ex}   <-- MISSING"
        echo "FAIL: the excluded path '${ex}' does not exist. A stale exclusion keeps a" >&2
        echo "      blind spot nobody needs; remove the entry or restore the file." >&2
        cannot_assert=1
    fi
done

# --- Guard 2: the scan set, from tracked files, floored -----------------------------
# NUL-delimited through a file, never through a shell variable, which would drop the NULs.
SCAN_TMPDIR="$(mktemp -d)" || {
    echo "FAIL: could not create a temporary directory for the scan set." >&2
    exit 2
}
trap 'rm -rf "$SCAN_TMPDIR"' EXIT
ALL_TRACKED="${SCAN_TMPDIR}/tracked.z"
SCAN_SET="${SCAN_TMPDIR}/scan.z"
: >"$SCAN_SET"

if ! git ls-files -z >"$ALL_TRACKED" 2>/dev/null; then
    echo "FAIL: 'git ls-files' failed, so there is no scan set to search." >&2
    cannot_assert=1
    : >"$ALL_TRACKED"
fi

scan_count=0
excluded_count=0
while IFS= read -r -d '' path; do
    [ -z "$path" ] && continue
    skip=0
    for ex in "${EXCLUSIONS[@]}"; do
        if [ "$path" = "$ex" ]; then
            skip=1
            break
        fi
    done
    if [ "$skip" -eq 1 ]; then
        excluded_count=$((excluded_count + 1))
        continue
    fi
    # A tracked path deleted from the working tree is not there to read.
    [ -f "$path" ] || continue
    printf '%s\0' "$path" >>"$SCAN_SET"
    scan_count=$((scan_count + 1))
done <"$ALL_TRACKED"

echo "scan set: ${scan_count} tracked file(s) searched, ${excluded_count} excluded (floor ${MIN_SCAN_FILES})"
if [ "$scan_count" -lt "$MIN_SCAN_FILES" ]; then
    echo "FAIL: the scan set holds ${scan_count} file(s), below the floor of ${MIN_SCAN_FILES}." >&2
    echo "      A scan of nothing greps clean. This assertion cannot be made." >&2
    cannot_assert=1
fi

# --- Guard 3: the positive control is found ------------------------------------------
control_hits=0
if [ "$scan_count" -gt 0 ]; then
    control_hits="$(xargs -0 grep -a -l -i -F -- "$POSITIVE_CONTROL" <"$SCAN_SET" 2>/dev/null | grep -c . || true)"
fi
if [ "$POSITIVE_CONTROL_OVERRIDDEN" -eq 1 ]; then
    echo "positive control: '${POSITIVE_CONTROL}' found in ${control_hits} file(s)  [OVERRIDDEN from the default]"
else
    echo "positive control: '${POSITIVE_CONTROL}' found in ${control_hits} file(s)"
fi
if [ "$control_hits" -lt 1 ]; then
    echo "FAIL: the positive control '${POSITIVE_CONTROL}' was not found in any of the" >&2
    echo "      ${scan_count} scanned files, so a zero below would mean nothing. This" >&2
    echo "      assertion cannot be made." >&2
    cannot_assert=1
fi

# True when a hit is one of the exact allowed lines of the allowed file.
is_allowed() {
    local file="$1" text="$2" ok
    [ "$file" = "$ALLOWED_FILE" ] || return 1
    for ok in "${ALLOWED_LINES[@]}"; do
        if [ "$text" = "$ok" ]; then
            return 0
        fi
    done
    return 1
}

# --- The assertion -------------------------------------------------------------------
GREP_ERR="${SCAN_TMPDIR}/grep.err"
echo "asserting ${#PATTERNS[@]} pattern(s) match nothing:"
for entry in "${PATTERNS[@]}"; do
    IFS='	' read -r label flags regex <<<"$entry"
    case_flag=()
    if [ "$flags" = "i" ]; then
        case_flag=(-i)
    fi
    hits=""
    if [ "$scan_count" -gt 0 ]; then
        # grep exits 1 for "no match" and 2 for an error, and xargs folds both into 123, so
        # an error is told apart by its message: any message means a file went unread.
        # A NUL in a matched line is printed as `?`; bash would drop it with a warning.
        hits="$(xargs -0 grep -a -H -n -E ${case_flag[@]+"${case_flag[@]}"} -e "$regex" -- <"$SCAN_SET" 2>"$GREP_ERR" | tr '\000' '?')"
        if [ -s "$GREP_ERR" ]; then
            echo "FAIL: searching for the ${label} pattern reported an error, so a file may" >&2
            echo "      have gone unread:" >&2
            sed 's/^/      /' "$GREP_ERR" >&2
            cannot_assert=1
        fi
    fi
    found=0
    if [ -n "$hits" ]; then
        while IFS= read -r hit; do
            [ -z "$hit" ] && continue
            hit_file="${hit%%:*}"
            rest="${hit#*:}"
            hit_line="${rest%%:*}"
            hit_text="${rest#*:}"
            hit_text="${hit_text%$'\r'}"
            if is_allowed "$hit_file" "$hit_text"; then
                continue
            fi
            if [ "$found" -eq 0 ]; then
                echo "FAIL: ${label}:" >&2
            fi
            found=$((found + 1))
            printf '  %s:%s: %s\n' "$hit_file" "$hit_line" "$(printf '%s' "$hit_text" | cut -c1-160)" >&2
        done <<<"$hits"
    fi
    if [ "$found" -gt 0 ]; then
        echo "  ${label}: ${found} line(s)  <-- FOUND"
        failed=1
    else
        echo "  ${label}: 0"
    fi
done

# --- Text files that hold a NUL -------------------------------------------------------
# A file named as text that holds a NUL is UTF-16 (every ASCII letter followed by a NUL,
# so no pattern above can match it) or binary data under a text name. Neither belongs
# in this tree.
nul_found=0
while IFS= read -r -d '' path; do
    case "$path" in
        *.md | *.txt | *.rs | *.ts | *.tsx | *.js | *.mjs | *.cjs | *.sh | *.toml | *.yml | *.yaml | *.json | *.html | *.css | *.svg) ;;
        *) continue ;;
    esac
    nuls="$(tr -cd '\000' <"$path" | wc -c | tr -d ' ')"
    if [ "$nuls" != "0" ]; then
        if [ "$nul_found" -eq 0 ]; then
            echo "FAIL: text file holding NUL bytes (UTF-16 or binary under a text name):" >&2
        fi
        nul_found=$((nul_found + 1))
        printf '  %s: %s NUL byte(s)\n' "$path" "$nuls" >&2
    fi
done <"$SCAN_SET"
if [ "$nul_found" -gt 0 ]; then
    echo "  text file holding NUL bytes: ${nul_found} file(s)  <-- FOUND"
    failed=1
else
    echo "  text file holding NUL bytes: 0"
fi

if [ "$cannot_assert" -ne 0 ]; then
    echo >&2
    echo "EXIT 2: this run could not MAKE its assertion (see above). That is a FAILURE," >&2
    echo "not a pass." >&2
    exit 2
fi
if [ "$failed" -ne 0 ]; then
    echo >&2
    echo "Remove the reference, or reword it so it describes the code rather than the" >&2
    echo "person or the private notes behind it. Do NOT add an exclusion or an allowed" >&2
    echo "line to make this pass." >&2
    exit 1
fi

echo "OK: no private residue in ${scan_count} tracked file(s); positive control found in ${control_hits}."
exit 0
