#!/usr/bin/env bash
#
# prove-no-private-residue-bites.sh - the both-ways proof for
# scripts/check-no-private-residue.sh, the gate that keeps the maintainer's personal
# details and the private planning checkout out of every tracked file.
#
# WHY IT RUNS IN CI, BESIDE THE GATE. The gate asserts an ABSENCE, and an absence claim is
# worth exactly the proof that it can still fail. A pattern that has rotted (a typo, an
# escape that turned into a literal, an encoding that no longer decodes) matches nothing
# and prints the same green as a clean tree. Proving it once at authoring time does not
# survive the next edit to the pattern list, so this runs on every push.
#
# HOW IT PROBES WITHOUT TOUCHING THIS CHECKOUT. The gate scans `git ls-files`, so an
# untracked probe in this checkout would never be read. Every case therefore builds its
# own throwaway repository under `mktemp -d`: a copy of the gate and of this script (the
# two paths the gate excludes, which must exist), a `.gitignore` holding exactly the
# three allowed lines, one control file carrying the positive control, and one probe file,
# added to that repository's index. Nothing is written in this checkout, which is Shape A
# of scripts/lib/prover-isolation.sh with no probes: the helper compares this checkout's
# tracked tree before and after to prove it.
#
# WHAT EACH CASE GROUP PROVES.
#   B   MUST BITE. One tracked probe per pattern family: the owner's names and handle, a
#       gmail address, a home directory path, a private planning path, the assistant's
#       memory file name, the assistant, its vendor and the planning tool by name, the
#       desktop environment and the window manager, and the first name as a word in many
#       phrase shapes, including ones no list of verbs would hold. Then the byte cases: a
#       name in a file that also holds a Latin-1 byte, a name in a non-text file holding a
#       NUL (GNU grep classes both as binary and skips them), the first name after a
#       Latin-1 no-break space (a UTF-8 locale's bracket expression does not match that
#       byte, so only `LC_ALL=C` sees the word boundary), and UTF-16 files. Each must exit
#       EXACTLY 1 and NAME the probe file.
#   P   MUST PASS. The same first name as a product word, a verb, an id and a part of
#       longer words (the brand mark, a marker, a craft name, a sheet name, a requirement
#       id, Markdown, a trademark, the lowercase verb), plus a path that only looks like a
#       home path. Each must exit 0. These are what keep the first-name pattern from
#       turning into a ban on a product noun.
#   E   EXCLUSIONS AND ALLOWANCES. The gate's own text is excluded by exact path (the
#       baseline passes although both copied scripts spell every pattern); a COPY of the
#       gate under another name bites; the three allowed `.gitignore` lines pass, and a
#       comment line in `.gitignore` naming them bites; an UNTRACKED probe passes, because
#       the scan is tracked files only.
#   X   COULD NOT ASSERT. A scan set below the floor, a positive control that cannot be
#       found, and a missing exclusion must each exit EXACTLY 2, never 0.
#
# The names are never spelled out here: they are built from the same rot13 encoding the
# gate uses.
#
# NON-VACUITY. The number of executed cases must equal the declared total, and every one
# of exit 0, 1 and 2 must have been observed, or this exits 1.
#
# EXIT CODES (the repository's prover convention):
#   0  every case as expected.
#   1  one or more cases wrong; every wrong case is named in one run.
#   2  the proof could not be made: no git, the gate missing, or a throwaway-repository
#      or temp-dir failure.

set -u

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "prove-no-private-residue-bites: cannot cd to repo root" >&2; exit 2; }
ROOT="$(pwd)"
GATE_REL="scripts/check-no-private-residue.sh"
SELF_REL="scripts/prove-no-private-residue-bites.sh"

if ! command -v git >/dev/null 2>&1; then
    echo "prove-no-private-residue-bites: git not found; COULD NOT PROVE" >&2
    exit 2
fi
if [ ! -f "$ROOT/$GATE_REL" ] || [ ! -f "$ROOT/$SELF_REL" ]; then
    echo "prove-no-private-residue-bites: $GATE_REL or $SELF_REL missing; COULD NOT PROVE" >&2
    exit 2
fi

TMPROOT="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/prove-residue.XXXXXX")" || {
    echo "prove-no-private-residue-bites: mktemp failed; COULD NOT PROVE" >&2
    exit 2
}
# shellcheck disable=SC2329  # invoked by the helper's EXIT trap
remove_tmproot() {
    rm -rf -- "$TMPROOT"
}
prover_on_exit remove_tmproot
# shellcheck disable=SC2119  # no probes: this run writes only under mktemp -d
prover_isolate_untracked

rot13() {
    printf '%s' "$1" | tr 'A-Za-z' 'N-ZA-Mn-za-m'
}
FIRST="$(rot13 'Znex')"
LEGAL="$(rot13 'Zruqv')"
MIDDLE="$(rot13 'Funuv')"
FAMILY="$(rot13 'Niqv')"
HANDLE="$(rot13 'zniqv')"
FIRST_UP="$(printf '%s' "$FIRST" | tr 'a-z' 'A-Z')"
HOME_ROOT="/home"

DECLARED_TOTAL=52

# The gate runs under a UTF-8 locale when this machine has one, as it does on CI's ubuntu
# runners. That is the locale in which GNU grep classes a file holding one Latin-1 byte as
# binary, so the byte cases below prove the gate does not depend on the caller's locale.
PROBE_LOCALE=""
for candidate in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8; do
    if locale -a 2>/dev/null | grep -Fx -- "$candidate" >/dev/null; then
        PROBE_LOCALE="$candidate"
        break
    fi
done
echo "prove-no-private-residue-bites: the gate runs under LC_ALL='${PROBE_LOCALE:-<inherited>}'"
executed=0
saw_0=0
saw_1=0
saw_2=0
failures=()
case_n=0

REPO=""
g() {
    git -C "$REPO" -c user.name=prove -c user.email=prove@invalid -c commit.gpgsign=false \
        -c core.hooksPath=/dev/null -c init.defaultBranch=master "$@"
}

# A fresh throwaway repository holding the gate, this script, the allowed `.gitignore`
# and the control file, all in its index. Sets REPO.
new_repo() {
    case_n=$((case_n + 1))
    REPO="$TMPROOT/case-$case_n"
    mkdir -p "$REPO/scripts" || exit 2
    if ! g init -q; then
        echo "prove-no-private-residue-bites: git init failed; COULD NOT PROVE" >&2
        exit 2
    fi
    cp "$ROOT/$GATE_REL" "$REPO/$GATE_REL" || exit 2
    cp "$ROOT/$SELF_REL" "$REPO/$SELF_REL" || exit 2
    printf '%s\n' ".planning/" "CLAUDE.md" ".claude/" >"$REPO/.gitignore"
    printf 'fabrico control file\n' >"$REPO/control.txt"
    g add -A >/dev/null || exit 2
}

# Tracks one more file holding TEXT in the current throwaway repository.
track() {
    local rel="$1" text="$2"
    mkdir -p "$(dirname "$REPO/$rel")" || exit 2
    printf '%s\n' "$text" >"$REPO/$rel"
    g add -A >/dev/null || exit 2
}

# Tracks one more file holding the bytes printf makes of FORMAT and ARGS, for the probes
# that need a byte no text argument can carry.
track_bytes() {
    local rel="$1" format="$2"
    shift 2
    mkdir -p "$(dirname "$REPO/$rel")" || exit 2
    # shellcheck disable=SC2059  # the format is this script's own escape sequence
    printf "$format" "$@" >"$REPO/$rel"
    g add -A >/dev/null || exit 2
}

# The UTF-16LE encoding of an ASCII string, with its byte-order mark, as printf escapes.
utf16le_format() {
    local text="$1" out='\377\376' i
    for ((i = 0; i < ${#text}; i++)); do
        out="${out}${text:i:1}\000"
    done
    printf '%s' "$out"
}

# check ID EXPECTED_EXIT NAMED_PATH [GATE ARGS...]
#   NAMED_PATH, when not "-", must appear in the gate's output.
check() {
    local id="$1" want="$2" named="$3"
    shift 3
    local out rc
    executed=$((executed + 1))
    if [ -n "$PROBE_LOCALE" ]; then
        out="$(cd "$REPO" && LC_ALL="$PROBE_LOCALE" bash "$GATE_REL" --min-scan-files 1 "$@" 2>&1)"
    else
        out="$(cd "$REPO" && bash "$GATE_REL" --min-scan-files 1 "$@" 2>&1)"
    fi
    rc=$?
    case "$rc" in
        0) saw_0=1 ;;
        1) saw_1=1 ;;
        2) saw_2=1 ;;
    esac
    if [ "$rc" -ne "$want" ]; then
        echo "  $id: WRONG, exit $rc, expected $want"
        printf '%s\n' "$out" | sed 's/^/      /'
        failures+=("$id: exit $rc, expected $want")
    elif [ "$named" != "-" ] && ! printf '%s\n' "$out" | grep -F -- "$named" >/dev/null; then
        echo "  $id: WRONG, exit $rc but '$named' is not named"
        failures+=("$id: exit $rc as expected but the output does not name '$named'")
    else
        echo "  $id: exit $rc as expected"
    fi
}

# bite ID TEXT and pass ID TEXT: one fresh repository with one tracked probe.
bite() {
    new_repo
    track "notes/probe.md" "$2"
    check "$1" 1 "notes/probe.md"
}
pass() {
    new_repo
    track "notes/probe.md" "$2"
    check "$1" 0 "-"
}

echo "prove-no-private-residue-bites: baseline"
new_repo
check E1 0 "-"

echo "prove-no-private-residue-bites: must bite"
bite B1 "Written by ${LEGAL} on a Sunday."
bite B2 "Copyright the ${FAMILY} family."
bite B3 "Cloned from github.com/${HANDLE}/fabrico."
bite B4 "Contact: probe@gmail.com"
bite B5 "Built in ${HOME_ROOT}/probe-user/work/fabrico."
bite B6 "See .planning/ROADMAP.md for the plan."
bite B7 "Project rules live in CLAUDE.md."
bite B8 "Drafted with Claude."
bite B9 "A model from Anthropic."
bite B10 "Run it through the GSD workflow."
bite B11 "Tested on Omarchy."
bite B12 "Screenshot taken under Hyprland."
bite B13 "This was ${FIRST}'s call."
bite B14 "${FIRST} said the belt should stop."
bite B15 "${FIRST} decided to keep it."
bite B16 "${FIRST} chose the second option."
bite B17 "${FIRST} ruled it out."
bite B18 "${FIRST} walks the real app."
bite B19 "${FIRST} wants it smaller."
bite B20 "${FIRST} asked for a toggle."
bite B21 "Ask ${FIRST} before merging."
bite B22 "A walk sheet for ${FIRST}."
bite B23 "Approved by ${FIRST}."
bite B24 "This was ${FIRST}’s call."
bite B25 "${FIRST} can walk it later."
bite B26 "Signed off per ${FIRST}."
bite B27 "${FIRST}: keep the belt."
bite B28 "Paired with ${FIRST} on the layout."
bite B29 "${FIRST} and I settled it."
bite B30 "${FIRST} the fixture READY once fonts settle."
bite B31 "Signed: ${MIDDLE}."
new_repo
track_bytes "notes/probe.md" 'caf\351 owned by %s\n' "$LEGAL"
check B32 1 "notes/probe.md"
new_repo
track_bytes "notes/probe.dat" 'a\000 note from %s\n' "$FIRST"
check B33 1 "notes/probe.dat"
new_repo
track_bytes "notes/probe.md" 'Approved by\240%s.\n' "$FIRST"
check B34 1 "notes/probe.md"
new_repo
track_bytes "notes/probe.md" "$(utf16le_format "Written by ${FIRST}.")"
check B35 1 "notes/probe.md"
new_repo
track_bytes "notes/probe.md" "$(utf16le_format "plain words")"
check B36 1 "notes/probe.md"

echo "prove-no-private-residue-bites: must pass (the same word as a product noun or verb)"
pass P1 "The brand mark sits left of the title; LogoMark draws it."
pass P2 "A marker rides the belt."
pass P3 "${FIRST}Craft renders the mark at 16 px."
pass P4 "The ${FIRST}-sheet lists ${FIRST_UP}-01 to ${FIRST_UP}-09."
pass P5 "Raise the high-water mark, then mark the fixture READY."
pass P6 "Written in ${FIRST}down; a trademark; remarks."
pass P7 "The route for ${FIRST}Craft and the slot for ${FIRST}-02."
pass P8 "Served from /homepage/index and /var/home."

echo "prove-no-private-residue-bites: exclusions and allowances"
new_repo
cp "$ROOT/$GATE_REL" "$REPO/scripts/copy-of-gate.sh" || exit 2
g add -A >/dev/null || exit 2
check E2 1 "scripts/copy-of-gate.sh"
new_repo
printf '%s\n' "# the private checkout: .planning/ and CLAUDE.md" >>"$REPO/.gitignore"
g add -A >/dev/null || exit 2
check E3 1 ".gitignore"
new_repo
printf '%s\n' "/target" ".planning/" "CLAUDE.md" ".claude/" "node_modules" >"$REPO/.gitignore"
g add -A >/dev/null || exit 2
check E4 0 "-"
new_repo
printf '%s\n' "Drafted with Claude." >"$REPO/untracked-probe.md"
check E5 0 "-"

echo "prove-no-private-residue-bites: could not assert"
new_repo
check X1 2 "-" --min-scan-files 1000
new_repo
check X2 2 "-" --positive-control "token-that-no-file-holds-$$"
new_repo
g rm -q --cached "$SELF_REL" >/dev/null || exit 2
rm -f "$REPO/$SELF_REL"
check X3 2 "$SELF_REL"

echo
if [ "$executed" -ne "$DECLARED_TOTAL" ]; then
    failures+=("executed $executed case(s), declared $DECLARED_TOTAL")
fi
if [ "$saw_0" -ne 1 ] || [ "$saw_1" -ne 1 ] || [ "$saw_2" -ne 1 ]; then
    failures+=("exit 0, 1 and 2 must each be observed (saw 0: $saw_0, 1: $saw_1, 2: $saw_2)")
fi

if [ "${#failures[@]}" -gt 0 ]; then
    echo "NOT PROVEN: ${#failures[@]} problem(s):"
    for f in "${failures[@]}"; do
        echo "  - $f"
    done
    exit 1
fi
echo "PROVEN: $executed of $DECLARED_TOTAL cases as expected; exit 0, 1 and 2 all observed."
exit 0
