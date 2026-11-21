#!/usr/bin/env bash
#
# rebreak.sh <id>: prove that the defect a ledger row names is still caught, by breaking the
# product on purpose in a throwaway worktree and watching both tests go red.
#
# WHY THIS EXISTS. A browser spec may be merged or deleted only after a patch re-creates each
# defect it was written for, the old spec fails on that patch, and the test that guards the
# defect now fails on it too. A revert can't stand in for the patch, because the public history
# starts at one squashed commit, so the patch file under frontend/rebreak/ is the evidence. This
# script turns a row of frontend/TEST-LEDGER.md into that evidence: two saved outputs, each
# ending in a "REBREAK verdict=RED" line, written only after the whole proof held.
#
# A red run proves something only if the same run was green without the patch. So each side
# runs twice: a control run on the unpatched commit, which must pass, then a patched run, which
# must fail. Both are graded from Playwright's JSON report, never from its exit code: "no tests
# found" also exits 1, and it must never count as a red proof.
#
# STEPS
#   1. Check <id> (lower-case letters, digits and hyphens) before it is used in any path, and
#      refuse to run from a checkout under ~/.cache/fabrico-rebreak/.
#   2. Read the ledger row whose id cell equals <id>. The patch and output cells must be exactly
#      rebreak/<id>.patch, .old.txt and .new.txt, and the spec cell must be e2e/<file> (mock),
#      e2e-live/<file>.walk.ts (walk) or e2e-live/<file> (live).
#   3. Find the commits. The old spec runs at HEAD while its row says kept, and at the parent of
#      the commit that deleted it once the row says deleted. The guarding test runs at HEAD.
#   4. Take the machine-wide lock on ports 8787 and 5173 (flock, REBREAK_LOCK_WAIT seconds,
#      default 1800).
#   5. For the old side, then the new side: make a fresh detached worktree at
#      ~/.cache/fabrico-rebreak/wt with hooks off, link frontend/node_modules entry by entry when
#      the lock file matches (npm ci otherwise), and build the host into
#      ~/.cache/fabrico-rebreak/target when the side needs it.
#   6. Run the control, apply the patch inside the worktree only, rebuild, run again. Each run
#      happens in a private network namespace (unshare -rn) with servers this script starts and
#      stops by PID, and filters with --test-list so it can't pick up a neighbour's tests.
#   7. Strip colour codes, the worktree path and the home path from each patched output, refuse
#      any home path left, and move both outputs into frontend/rebreak/ only after both sides
#      proved, so a failed proof leaves the committed outputs alone.
#
# EXIT CODES
#   0  proven: both control runs passed and both patched runs failed.
#   1  a patched run passed: the patch doesn't break what the row says, or the test misses it.
#   2  the proof couldn't be made (bad input, lock not taken, build or server failure, a control
#      run that isn't green, zero or unexpected tests, a skipped or interrupted test). Never a
#      pass.
#
# The script never runs a tree-writing git command on the checkout it was started from: every
# patch, build and test run happens in its own worktree. It stops only processes it started.

set -u -o pipefail

unproven() {
    echo "REBREAK verdict=UNPROVEN reason=$*" >&2
    exit 2
}
say() { echo "REBREAK step: $*"; }

[ "$#" -eq 1 ] || unproven "usage: rebreak.sh <id>"
ID="$1"
[[ "$ID" =~ ^[a-z0-9][a-z0-9-]*$ ]] || unproven "the id '$ID' must be lower-case letters, digits and hyphens, starting with a letter or digit"

for tool in git jq flock unshare ss ip curl sha256sum node; do
    command -v "$tool" >/dev/null 2>&1 || unproven "$tool is not on the PATH"
done

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || unproven "could not find the script's folder"
ROOT="$(git -C "$SELF_DIR" rev-parse --show-toplevel 2>/dev/null)" || unproven "the script is not inside a git checkout"
ROOT="$(cd "$ROOT" && pwd -P)" || unproven "could not resolve the checkout's top level"
BASE="$HOME/.cache/fabrico-rebreak"
case "$ROOT/" in
    "$BASE"/*) unproven "refusing to run from a checkout under $BASE, which this script deletes and recreates" ;;
esac
WT="$BASE/wt"
TARGET="$BASE/target"
FRONT="$ROOT/frontend"

# --- 2. The ledger row -------------------------------------------------------------------
LEDGER="$FRONT/TEST-LEDGER.md"
[ -f "$LEDGER" ] || unproven "no ledger at frontend/TEST-LEDGER.md"

trim() {
    local s="$1"
    s="${s#"${s%%[![:space:]]*}"}"
    s="${s%"${s##*[![:space:]]}"}"
    printf '%s' "$s"
}

matches=0
ROW=()
while IFS= read -r line || [ -n "$line" ]; do
    t="$(trim "$line")"
    [[ "$t" == '|'* ]] || continue
    body="${t#|}"
    body="${body%|}"
    IFS='|' read -r -a cells <<<"$body"
    first="$(trim "${cells[0]//\`/}")"
    [ "$first" = "$ID" ] || continue
    matches=$((matches + 1))
    ROW=()
    for c in "${cells[@]}"; do ROW+=("$(trim "${c//\`/}")"); done
done <"$LEDGER"
[ "$matches" -ge 1 ] || unproven "the ledger has no row with the id '$ID'"
[ "$matches" -eq 1 ] || unproven "the ledger has $matches rows with the id '$ID'; ids must be unique"
[ "${#ROW[@]}" -eq 8 ] || unproven "the row '$ID' has ${#ROW[@]} cells; it needs 8 (id, state, spec, defect, guarding test, patch, old output, new output)"

STATE="${ROW[1]}"
SPEC="${ROW[2]}"
GUARD_CELL="${ROW[4]}"
[ "${ROW[5]}" = "rebreak/$ID.patch" ] || unproven "the patch cell is '${ROW[5]}'; it must be rebreak/$ID.patch"
[ "${ROW[6]}" = "rebreak/$ID.old.txt" ] || unproven "the old output cell is '${ROW[6]}'; it must be rebreak/$ID.old.txt"
[ "${ROW[7]}" = "rebreak/$ID.new.txt" ] || unproven "the new output cell is '${ROW[7]}'; it must be rebreak/$ID.new.txt"
case "$STATE" in kept | deleted) ;; *) unproven "the state cell is '$STATE'; it must be kept or deleted" ;; esac
[ -n "${ROW[3]}" ] || unproven "the defect cell is empty"

[[ "$SPEC" =~ ^(e2e|e2e-live)/[A-Za-z0-9._-]+\.(spec|walk)\.ts$ ]] || unproven "the spec cell '$SPEC' must be e2e/<file>.spec.ts, e2e-live/<file>.spec.ts or e2e-live/<file>.walk.ts"
case "$SPEC" in
    e2e/*) OLD_SUITE=mock ;;
    e2e-live/*.walk.ts) OLD_SUITE=walk ;;
    *) OLD_SUITE=live ;;
esac
OLD_FILE="${SPEC#*/}"

# The guarding cell: "<suite>: [<project>] › <file> › <title> ...", with › or > between parts.
[[ "$GUARD_CELL" =~ ^(mock|live|walk):\ (.+)$ ]] || unproven "the guarding test '$GUARD_CELL' must start with mock:, live: or walk: and a space"
NEW_SUITE="${BASH_REMATCH[1]}"
GUARD_LINE="${BASH_REMATCH[2]}"
if [[ "$GUARD_LINE" == *"›"* ]]; then DELIM="›"; else DELIM=">"; fi
GTOK=()
rest="$GUARD_LINE"
while :; do
    case "$rest" in
        *"$DELIM"*)
            GTOK+=("$(trim "${rest%%"$DELIM"*}")")
            rest="${rest#*"$DELIM"}"
            ;;
        *)
            GTOK+=("$(trim "$rest")")
            break
            ;;
    esac
done
[ "${#GTOK[@]}" -ge 3 ] || unproven "the guarding test '$GUARD_LINE' needs [project], a file and at least one title"
[[ "${GTOK[0]}" =~ ^\[([A-Za-z0-9._-]+)\]$ ]] || unproven "the guarding test must start with [<project>], not '${GTOK[0]}'"
G_PROJECT="${BASH_REMATCH[1]}"
G_FILE="${GTOK[1]}"
[[ "$G_FILE" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.ts$ ]] || unproven "the guarding test's file '$G_FILE' must be a .ts path under its suite's folder with no part starting with a dot"
G_TITLES=""
for ((i = 2; i < ${#GTOK[@]}; i++)); do
    [ -n "${GTOK[$i]}" ] || unproven "the guarding test has an empty title part"
    G_TITLES+="${G_TITLES:+$'\x1f'}${GTOK[$i]}"
done
case "$NEW_SUITE" in mock) G_DIR=e2e ;; *) G_DIR=e2e-live ;; esac

PATCH="$FRONT/rebreak/$ID.patch"
[ -s "$PATCH" ] || unproven "the patch frontend/rebreak/$ID.patch is missing or empty"
PATCH_SHA="$(sha256sum "$PATCH" | cut -d' ' -f1)" || unproven "could not hash the patch"

# --- 3. The commits ----------------------------------------------------------------------
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)" || unproven "could not read HEAD"
if [ "$STATE" = kept ]; then
    OLD_COMMIT="$HEAD_SHA"
else
    del="$(git -C "$ROOT" log --diff-filter=D -n1 --format=%H -- "frontend/$SPEC")"
    [ -n "$del" ] || unproven "the row says deleted, but no commit deleted frontend/$SPEC"
    OLD_COMMIT="$(git -C "$ROOT" rev-parse "$del^")" || unproven "the commit that deleted frontend/$SPEC has no parent"
fi
git -C "$ROOT" cat-file -e "$OLD_COMMIT:frontend/$SPEC" 2>/dev/null || unproven "frontend/$SPEC does not exist at $OLD_COMMIT"
NEW_COMMIT="$HEAD_SHA"
git -C "$ROOT" cat-file -e "$NEW_COMMIT:frontend/$G_DIR/$G_FILE" 2>/dev/null || unproven "the guarding test's file frontend/$G_DIR/$G_FILE does not exist at HEAD"

# --- 4. The lock -------------------------------------------------------------------------
LOCK="${XDG_RUNTIME_DIR:-$HOME/.cache}/fabrico-live-ports.lock"
WAIT="${REBREAK_LOCK_WAIT:-1800}"
[[ "$WAIT" =~ ^[0-9]+$ ]] || unproven "REBREAK_LOCK_WAIT is '$WAIT'; it must be a whole number of seconds"
mkdir -p "$(dirname "$LOCK")" "$BASE" || unproven "could not create $BASE"
exec 9>>"$LOCK" || unproven "could not open the lock file $LOCK"
say "waiting up to ${WAIT}s for the lock $LOCK"
flock -w "$WAIT" 9 || unproven "could not take the lock $LOCK within ${WAIT}s; another proof or live run holds it"
LOCKED=1

RUN="$BASE/runs/$ID-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$RUN" || unproven "could not create the run folder $RUN"
PIDS="$RUN/pids"
: >"$PIDS"
say "run folder $RUN"

# kill_recorded: stop any server a run recorded that is still alive. The command line must
# still name the program, so a recycled PID belonging to something else is left alone.
kill_recorded() {
    local name pid n
    [ -f "$PIDS" ] || return 0
    while read -r name pid; do
        [ -n "$pid" ] || continue
        [ -r "/proc/$pid/cmdline" ] || continue
        tr '\0' ' ' <"/proc/$pid/cmdline" | grep -qF "$name" || continue
        kill "$pid" 2>/dev/null
        for n in 1 2 3 4 5 6 7 8 9 10; do
            [ -e "/proc/$pid" ] || break
            sleep 0.5
        done
        [ -e "/proc/$pid" ] && kill -9 "$pid" 2>/dev/null
    done <"$PIDS"
}

remove_wt() {
    if [ -e "$WT" ] || git -C "$ROOT" worktree list --porcelain | grep -qxF "worktree $WT"; then
        git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1
        git -C "$ROOT" worktree prune >/dev/null 2>&1
        case "$WT" in
            "$BASE"/wt) [ -e "$WT" ] && rm -rf -- "$WT" ;;
        esac
        git -C "$ROOT" worktree prune >/dev/null 2>&1
    fi
}

# shellcheck disable=SC2329 # called by the EXIT trap.
cleanup() {
    local rc=$?
    trap - EXIT
    if [ "${LOCKED:-0}" = 1 ]; then
        kill_recorded
        remove_wt
        flock -u 9 2>/dev/null
    fi
    exec 9>&-
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 2' INT TERM HUP

ROOT_STATE_BEFORE="$( (git -C "$ROOT" status --porcelain --untracked-files=no; git -C "$ROOT" diff HEAD) | sha256sum)"

# --- the run inside a private network namespace ------------------------------------------
# Exported so `unshare -rn bash -c` can call it. Reads R_* variables, writes R_STATUS.
# shellcheck disable=SC2329 # called by name through unshare -rn bash -c.
rebreak_inner() {
    set -u
    local rc
    # hp and vp stay global in this shell so the EXIT trap still sees them after a return.
    hp=""
    vp=""
    stop_servers() {
        local p
        for p in $vp $hp; do kill "$p" 2>/dev/null; done
        for p in $vp $hp; do wait "$p" 2>/dev/null; done
        vp=""
        hp=""
    }
    trap stop_servers EXIT
    ip link set lo up || { echo "env lo-up-failed" >"$R_STATUS"; return 0; }
    if ss -ltnH | grep -Eq ':(8787|5173)\b'; then
        echo "env ports-busy-before" >"$R_STATUS"
        return 0
    fi
    cd "$R_FRONT" || { echo "env no-frontend" >"$R_STATUS"; return 0; }
    if [ "$R_MODE" != mock ]; then
        "$R_HOSTBIN" >"$R_LOG.host.log" 2>&1 &
        hp=$!
        echo "dev_render_server $hp" >>"$R_PIDS"
    fi
    node node_modules/vite/bin/vite.js --port 5173 --strictPort --host 127.0.0.1 >"$R_LOG.vite.log" 2>&1 &
    vp=$!
    echo "vite $vp" >>"$R_PIDS"
    if [ -n "$hp" ]; then
        curl -s -o /dev/null --retry 60 --retry-connrefused --retry-delay 1 http://127.0.0.1:8787/render \
            || { echo "env host-not-ready" >"$R_STATUS"; return 0; }
    fi
    curl -s -o /dev/null --retry 60 --retry-connrefused --retry-delay 1 http://127.0.0.1:5173/ \
        || { echo "env vite-not-ready" >"$R_STATUS"; return 0; }
    rm -f "$R_REPORT"
    # FORCE_COLOR=0 turns colour off. NO_COLOR is left out on purpose: with both set, Node prints
    # a warning naming its PID into the output that gets committed.
    # shellcheck disable=SC2086 # R_ENV is a list of NAME=value words with no spaces.
    env -u NO_COLOR CI=1 FORCE_COLOR=0 PLAYWRIGHT_JSON_OUTPUT_FILE="$R_REPORT" $R_ENV \
        ./node_modules/.bin/playwright test --config="$R_CONFIG" --retries=0 \
        --reporter=list,json --test-list "$R_LIST" >"$R_OUT" 2>&1
    rc=$?
    stop_servers
    if ss -ltnH | grep -Eq ':(8787|5173)\b'; then
        echo "env ports-busy-after" >"$R_STATUS"
        return 0
    fi
    echo "ran $rc" >"$R_STATUS"
    return 0
}
export -f rebreak_inner

# report_rows REPORT: one tab-separated row per test: identity (spec id @ project), project,
# file, title path joined with the unit separator, last result status, test status.
report_rows() {
    jq -r '
      def clean: tostring | gsub("[\t\r\n]"; " ");
      def walk_tests(chain):
        ( (.specs // [])[] as $s
          | ($s.tests // [])[] as $t
          | [ ((($s.id // "") | clean) + " @ " + (($t.projectName // "") | clean)),
              (($t.projectName // "") | clean),
              (($s.file // "") | clean),
              ((chain + [$s.title]) | map(clean) | join("\u001f")),
              (((($t.results // []) | last | .status) // "none") | clean),
              (($t.status // "none") | clean) ]
          | join("\t") ),
        ( (.suites // [])[] as $su | $su | walk_tests(chain + [$su.title]) );
      (.suites // [])[] | walk_tests([])
    ' "$1"
}

# grade SIDE PHASE REPORT: prints "<tests> <failed>" for a usable run, exits the script otherwise.
grade() {
    local side="$1" phase="$2" report="$3" rows errs n=0 failed=0 other=0 id proj file titles last st
    [ -s "$report" ] || unproven "$side $phase run wrote no JSON report"
    errs="$(jq -r '(.errors // []) | length' "$report" 2>/dev/null)" || unproven "$side $phase JSON report is not readable"
    [ "$errs" = 0 ] || unproven "$side $phase JSON report has $errs run-level errors (see $RUN)"
    rows="$(report_rows "$report")" || unproven "$side $phase JSON report could not be walked"
    : >"$RUN/$side-$phase.ids"
    while IFS=$'\t' read -r id proj file titles last st; do
        [ -n "$id" ] || continue
        n=$((n + 1))
        echo "$id" >>"$RUN/$side-$phase.ids"
        if [ "$side" = old ]; then
            [ "$file" = "$OLD_FILE" ] || unproven "$side $phase run held a test from '$file', not only from $OLD_FILE"
        else
            [ "$proj" = "$G_PROJECT" ] && [ "$file" = "$G_FILE" ] && [ "$titles" = "$G_TITLES" ] \
                || unproven "$side $phase run held a test other than the guarding test: [$proj] $file ${titles//$'\x1f'/ › }"
        fi
        case "$phase:$last:$st" in
            control:passed:expected) ;;
            control:*) unproven "the control run isn't green ($side, ${titles//$'\x1f'/ › }: $last), so a red patched run would prove nothing" ;;
            patched:passed:*) ;;
            patched:failed:* | patched:timedOut:*) failed=$((failed + 1)) ;;
            *) other=$((other + 1)) ;;
        esac
    done <<<"$rows"
    [ "$n" -ge 1 ] || unproven "$side $phase run ran no test (no tests found, or the filter matched nothing)"
    if [ "$side" = new ] && [ "$n" -ne 1 ]; then unproven "$side $phase run ran $n tests; the guarding line must name exactly one"; fi
    sort -o "$RUN/$side-$phase.ids" "$RUN/$side-$phase.ids"
    if [ "$phase" = patched ]; then
        cmp -s "$RUN/$side-control.ids" "$RUN/$side-patched.ids" || unproven "$side patched run ran different tests from its control run"
        [ "$other" -eq 0 ] || unproven "$side patched run had $other tests that were skipped, interrupted or did not run"
    fi
    echo "$n $failed"
}

sed_escape() { printf '%s' "$1" | sed 's/[][\.*^$#]/\\&/g'; }

# --- one side ----------------------------------------------------------------------------
# prove_side SIDE SUITE COMMIT LISTLINE TARGET
prove_side() {
    local side="$1" suite="$2" commit="$3" listline="$4" target="$5"
    local config extra="" hostbin="" wtp got ctl_n pat_n pat_failed status build=()
    say "$side side: suite=$suite commit=$commit"
    remove_wt
    [ -e "$WT" ] && unproven "a stale worktree at $WT could not be removed"
    git -C "$ROOT" -c core.hooksPath=/dev/null worktree add --detach "$WT" "$commit" >"$RUN/$side-worktree.log" 2>&1 9>&- \
        || unproven "could not add the worktree at $WT (see $RUN/$side-worktree.log)"
    wtp="$(cd "$WT" && pwd -P)"
    if cmp -s "$WT/frontend/package-lock.json" "$FRONT/package-lock.json" && [ -d "$FRONT/node_modules" ]; then
        local from="$FRONT/node_modules" to="$WT/frontend/node_modules" e n
        mkdir "$to" || unproven "could not create $to"
        for e in "$from"/* "$from"/.[!.]* "$from"/..?*; do
            [ -e "$e" ] || [ -L "$e" ] || continue
            n="$(basename "$e")"
            case "$n" in .vite | .vite-temp) continue ;; esac
            ln -s "$e" "$to/$n" || unproven "could not link $n into the worktree's node_modules"
        done
    else
        say "$side side: the lock file differs from the checkout's, running npm ci"
        (cd "$WT/frontend" && npm ci) >"$RUN/$side-npm-ci.log" 2>&1 9>&- || unproven "npm ci failed in the worktree (see $RUN/$side-npm-ci.log)"
    fi

    case "$suite" in
        mock) config=playwright.mock.reuse.config.ts ;;
        live)
            config=playwright.live.reuse.config.ts
            [[ "$target" == *.terminal.spec.ts* ]] && extra="FABRICO_LIVE_TERMINAL=1"
            ;;
        walk)
            config=playwright.walk.config.ts
            extra="FABRICO_WALK_REUSE=1 FABRICO_REPLAY_HASH=$TARGET/debug/examples/replay_hash"
            ;;
    esac
    [ -f "$WT/frontend/$config" ] || unproven "$config does not exist at $commit"
    if [ "$suite" != mock ]; then
        hostbin="$TARGET/debug/examples/dev_render_server"
        build=(cargo build -p fabrico-host --example dev_render_server)
        [ "$suite" = walk ] && build+=(--example replay_hash)
        command -v cargo >/dev/null 2>&1 || unproven "cargo is not on the PATH"
    fi

    build_host() {
        local tag="$1" brc
        [ "${#build[@]}" -gt 0 ] || return 0
        say "$side side: building the host ($tag)"
        (cd "$WT" && CARGO_TARGET_DIR="$TARGET" "${build[@]}") >"$RUN/$side-build-$tag.log" 2>&1 9>&-
        brc=$?
        [ "$brc" = 0 ] || unproven "the host build failed with exit $brc ($side, $tag; see $RUN/$side-build-$tag.log)"
    }

    run_once() {
        local phase="$1"
        export R_MODE="$suite" R_FRONT="$WT/frontend" R_HOSTBIN="$hostbin" R_CONFIG="$config" \
            R_LIST="$RUN/$side.list" R_REPORT="$RUN/$side-$phase.json" R_OUT="$RUN/$side-$phase.out" \
            R_LOG="$RUN/$side-$phase" R_PIDS="$PIDS" R_STATUS="$RUN/$side-$phase.status" R_ENV="$extra"
        rm -f "$R_STATUS"
        say "$side side: $phase run"
        unshare -rn bash -c rebreak_inner 9>&-
        kill_recorded
        cat "$PIDS" >>"$RUN/pids.done"
        : >"$PIDS"
        status="$(cat "$RUN/$side-$phase.status" 2>/dev/null)"
        case "$status" in
            "ran "*) ;;
            "env "*) unproven "$side $phase run could not start: ${status#env } (see $RUN)" ;;
            *) unproven "$side $phase run ended without a status (see $RUN)" ;;
        esac
    }

    printf '%s\n' "$listline" >"$RUN/$side.list"
    build_host control
    run_once control
    got="$(grade "$side" control "$RUN/$side-control.json")" || exit $?
    ctl_n="${got%% *}"
    say "$side side: control passed, tests=$ctl_n"

    [ "$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null)" = "$wtp" ] || unproven "the worktree's top level is not $wtp"
    [ "$wtp" != "$ROOT" ] || unproven "the worktree is the invoking checkout; refusing to patch it"
    git -C "$WT" apply --check "$PATCH" >"$RUN/$side-apply.log" 2>&1 || unproven "the patch does not apply at $commit (see $RUN/$side-apply.log)"
    git -C "$WT" apply "$PATCH" >>"$RUN/$side-apply.log" 2>&1 || unproven "git apply failed at $commit (see $RUN/$side-apply.log)"
    build_host patched
    run_once patched
    got="$(grade "$side" patched "$RUN/$side-patched.json")" || exit $?
    pat_n="${got%% *}"
    pat_failed="${got##* }"
    if [ "$pat_failed" -eq 0 ]; then
        echo "REBREAK verdict=GREEN run=$side suite=$suite commit=$commit tests=$pat_n failed=0 target=$target" >&2
        echo "The patched run passed: the patch doesn't break what the row says, or the test misses it. Output: $RUN/$side-patched.out" >&2
        exit 1
    fi

    # The saved output: colour codes stripped, the worktree and home paths replaced.
    sed -e 's/\x1b\[[0-9;?]*[ -/]*[@-~]//g' -e 's/\r$//' \
        -e "s#$(sed_escape "$wtp")#<worktree>#g" -e "s#$(sed_escape "$WT")#<worktree>#g" \
        -e "s#$(sed_escape "$HOME")#~#g" "$RUN/$side-patched.out" >"$RUN/$ID.$side.txt" \
        || unproven "could not clean the $side output"
    if grep -q '/home/' "$RUN/$ID.$side.txt"; then
        unproven "a home path survived the cleaning of the $side output ($RUN/$ID.$side.txt)"
    fi
    {
        echo "REBREAK control=passed tests=$ctl_n"
        echo "REBREAK verdict=RED run=$side suite=$suite commit=$commit patch_sha256=$PATCH_SHA tests=$pat_n failed=$pat_failed target=$target"
    } >>"$RUN/$ID.$side.txt"
    say "$side side: proven, $pat_failed of $pat_n tests failed on the patch"
    remove_wt
}

prove_side old "$OLD_SUITE" "$OLD_COMMIT" "$OLD_FILE" "$SPEC"
prove_side new "$NEW_SUITE" "$NEW_COMMIT" "$GUARD_LINE" "$GUARD_CELL"

ROOT_STATE_AFTER="$( (git -C "$ROOT" status --porcelain --untracked-files=no; git -C "$ROOT" diff HEAD) | sha256sum)"
[ "$ROOT_STATE_BEFORE" = "$ROOT_STATE_AFTER" ] || unproven "the invoking checkout's tracked files changed during the proof; refusing to write outputs"

mv -f "$RUN/$ID.old.txt" "$FRONT/rebreak/$ID.old.txt" || unproven "could not write frontend/rebreak/$ID.old.txt"
mv -f "$RUN/$ID.new.txt" "$FRONT/rebreak/$ID.new.txt" || unproven "could not write frontend/rebreak/$ID.new.txt"
echo "REBREAK verdict=PROVEN id=$ID old=frontend/rebreak/$ID.old.txt new=frontend/rebreak/$ID.new.txt"
exit 0
