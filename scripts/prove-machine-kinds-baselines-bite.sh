#!/usr/bin/env bash
#
# NON-VACUITY PROOF for the per-kind machine baselines (GATE-05, plan 92-06, decision D-12).
#
# ---------------------------------------------------------------------------------
# WHAT THIS PROVES.
#
# `frontend/e2e/machine-kinds-pixel.spec.ts` holds thirteen element-scoped pixel baselines,
# one per slot of `/pixel-guard.html` surface (g): every machine kind a user can place, a
# FAULTED Factory, a FAULTED Sink and a WORKING Factory, all drawn by the shipped machine
# layer. A baseline is worth exactly the proof that it fails when the art it pictures
# breaks, and that a break in one kind's art does not redden the others (a clip that
# missed its machine, or a frame with the alert ring at its floor, would pass forever).
#
# So this prover runs the spec once unmutated (all 14 tests must pass), then applies each
# break below in turn, runs the spec again, and asserts that EXACTLY the named PNGs fail,
# every other screenshot and the ring-alpha test pass, and records each failing PNG's
# differing pixel count, read from Playwright's JSON report:
#
#   break                                         must redden
#   one <path> deleted from assets/source.svg     kind-source
#   ... assets/sink.svg                           kind-sink, state-faulted-sink
#   ... assets/factory.svg                        kind-factory, kind-http-handler,
#                                                 state-faulted-factory, state-working-factory
#   ... assets/tee.svg                            kind-tee
#   ... assets/balancer.svg                       kind-balancer
#   ... assets/router.svg                         kind-router
#   ... assets/merge.svg                          kind-merge
#   ... assets/endpoint.svg                       kind-route
#   SUBJECT_OF[HANDLER] pointed at the router     kind-http-handler
#   LABEL_FILL_ALPHA 0.16 -> 0.5                  kind-label
#   drawAlertRing a no-op                         state-faulted-factory, state-faulted-sink
#   chassisInk's FAULTED branch -> idle ink       state-faulted-factory, state-faulted-sink
#   nubColor's role-2 return ramp[3] -> ramp[4]   every slot with a fault port: kind-factory,
#                                                 kind-http-handler, kind-router, kind-sink,
#                                                 both faulted, state-working-factory
#   notchOffset returning 0                       state-working-factory
#
# One line per break: `MUT <png set> verdict=RED by=<break> rev=<40-hex> overlay=<stamp>
# pixels=<n,...> green=<names>`, then a `PROVEN:` summary. `rev` is HEAD and `overlay` names
# what the run carried over it (review 92 WR-A-06): `none`, or the 16-hex name of the
# caller's tracked diff and untracked files (`prover_overlay_stamp`). A line with an overlay
# other than `none` is evidence about that tree, not about the revision alone.
#
# IT NEVER WRITES THE SHARED TREE, ITS INDEX OR ITS node_modules. Every break is made in a
# private worktree (scripts/lib/prover-isolation.sh, Shape B): a detached worktree of HEAD
# plus the caller's uncommitted tracked diff and untracked files. Each file is kept with
# `prover_keep_bytes` before the first break and put back from those bytes after each one.
# The worktree gets a REAL `frontend/node_modules` directory whose entries link to the
# invoking checkout's (`prover_link_node_modules`), every entry but `.vite` and `.vite-temp`,
# so the private Vite's dependency cache and bundled config are written inside the worktree
# and removed with it (review 92 WR-A-05: through a link to the whole directory, the first
# Vite start deleted and rewrote the shared `frontend/node_modules/.vite`, which the tracked
# comparison cannot see). Each spec run starts its OWN Vite on 127.0.0.1:5173 inside a
# private network namespace (`unshare -rn`), so the port cannot collide with a Vite the
# caller or another process runs, and runs Playwright through the webServer-less
# `playwright.mock.reuse.config.ts` (some sandboxed shells kill Playwright's own webServer child).
#
# LINUX ONLY: the baselines are chromium-linux PNGs and the private namespace is
# `unshare`. On a host without `unshare` or `curl` the proof is not made (exit 2).
#
# HOW TO RUN: `bash scripts/prove-machine-kinds-baselines-bite.sh` from anywhere in the
# checkout. It takes no arguments. It makes 15 spec runs (one unmutated, 14 breaks), each
# with its own Vite start: MEASURED at review fix pass 1, 52 s wall time on this machine
# from a clean worktree (`92-GATES.md` `## Review fix pass 1`); the worst case under the
# per-run timeout is 15 x 900 s, about 3 h 45 min, reached only if every run hangs.
#
# EXIT CODES:
#   0  PROVEN: every break reddened exactly its set and nothing else.
#   1  A break did not redden its whole set, or reddened a PNG outside it, or failed the
#      ring-alpha test. Every failing break is named.
#   2  The proof COULD NOT BE MADE. This is a FAILURE, not a pass: a missing tool or file,
#      a spec that is not green before any break, a break that changed no byte, a Vite that
#      did not come up, a report that could not be read, or a tree another writer moved.

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

cd "$(git rev-parse --show-toplevel)"

SPEC="e2e/machine-kinds-pixel.spec.ts"
SNAPS="frontend/${SPEC}-snapshots"
ALL_PNGS="kind-factory kind-http-handler state-faulted-factory state-working-factory kind-router kind-tee kind-balancer kind-merge kind-label kind-source kind-sink kind-route state-faulted-sink"
RING_TEST="both faulted rings are pictured at their peak"

usage() {
    cat >&2 <<'USAGE'
usage: scripts/prove-machine-kinds-baselines-bite.sh

Proves each per-kind machine baseline (frontend/e2e/machine-kinds-pixel.spec.ts) fails
when its own art is broken and stays green when another kind's is. Every break is made
in a private worktree; each spec run has its own Vite in a private network namespace.

  --help, -h     this message

Exit codes:
  0  proven
  1  a break did not redden exactly its set; every failure is named
  2  the proof could not be made. This is a FAILURE, not a pass.
USAGE
}

# --- Argument validation ------------------------------------------------------------
ORIG_ARGS=("$@")
for arg in "$@"; do
    case "$arg" in
        --help | -h)
            usage
            exit 0
            ;;
        *)
            echo "FAIL: unknown argument '${arg}' (this prover takes none)." >&2
            usage
            exit 2
            ;;
    esac
done

for tool in unshare curl node; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "FAIL: '${tool}' is not available, so the proof could not be made." >&2
        exit 2
    fi
done
if [ ! -f "frontend/${SPEC}" ]; then
    echo "FAIL: frontend/${SPEC} is missing, so there are no baselines to prove." >&2
    exit 2
fi
for png in $ALL_PNGS; do
    if [ ! -f "${SNAPS}/${png}-chromium-linux.png" ]; then
        echo "FAIL: the baseline ${SNAPS}/${png}-chromium-linux.png is missing." >&2
        exit 2
    fi
done

# --- Into the private worktree (Shape B) ---------------------------------------------
# In the caller this does not return; inside the worktree it returns and the proof goes
# on there.
prover_run_in_worktree ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}

REV="$(git rev-parse HEAD)"
OVERLAY="$(prover_overlay_stamp)"
# The checkout the prover was invoked from (a linked worktree when run from one), whose
# node_modules the private worktree borrows (review 92 WR-A-05: the parent of the shared
# git directory is always the main checkout).
CALLER="$(prover_caller_root)"
# Checked here, against the caller's checkout: the lines above the shape run again inside
# the worktree, where no node_modules exists until the links below.
if [ ! -d "${CALLER}/frontend/node_modules/@playwright/test" ] || [ ! -f "${CALLER}/frontend/node_modules/vite/bin/vite.js" ]; then
    echo "FAIL: ${CALLER}/frontend/node_modules has no Playwright or Vite (run npm ci in frontend/)." >&2
    exit 2
fi
prover_link_node_modules "${CALLER}/frontend/node_modules" frontend/node_modules

RUNS="$(mktemp -d "${TMPDIR:-/tmp}/fabrico-kinds-runs.XXXXXX")"
cleanup() {
    # A real directory of links and the private Vite cache: removing it removes links,
    # never what they point at.
    if [ -d frontend/node_modules ] && [ ! -L frontend/node_modules ]; then
        rm -rf -- frontend/node_modules
    fi
    rm -rf -- "$RUNS"
}
prover_on_exit cleanup

# run_spec <tag>: one spec run with its own Vite in a private network namespace. Writes
# $RUNS/<tag>.json (the report), <tag>.out (Vite and Playwright output) and <tag>.rc
# (Playwright's exit code, 90 when Vite did not come up). Returns 0 unless the run could
# not be made at all.
run_spec() {
    local tag="$1" rc
    set +e
    timeout 900 unshare -rn bash -c '
        set -u
        ip link set lo up || exit 91
        cd frontend || exit 92
        node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort >"$1.vite" 2>&1 &
        vite=$!
        up=0
        for _ in $(seq 120); do
            if curl -s -o /dev/null http://127.0.0.1:5173/pixel-guard.html; then up=1; break; fi
            sleep 0.5
        done
        if [ "$up" -ne 1 ]; then kill "$vite" 2>/dev/null; wait "$vite" 2>/dev/null; exit 90; fi
        PLAYWRIGHT_JSON_OUTPUT_NAME="$1.json" npx playwright test \
            --config=playwright.mock.reuse.config.ts "$2" --reporter=json --retries=0 >/dev/null 2>&1
        prc=$?
        kill "$vite" 2>/dev/null
        wait "$vite" 2>/dev/null
        exit "$prc"
    ' _ "${RUNS}/${tag}" "$SPEC" >"${RUNS}/${tag}.out" 2>&1
    rc=$?
    set -e
    echo "$rc" >"${RUNS}/${tag}.rc"
    if [ "$rc" -ge 90 ] || [ ! -s "${RUNS}/${tag}.json" ]; then
        echo "FAIL: the spec run '${tag}' could not be made (exit ${rc}):" >&2
        sed 's/^/  /' "${RUNS}/${tag}.out" "${RUNS}/${tag}.vite" 2>/dev/null >&2 || true
        exit 2
    fi
}

# read_report <tag>: prints one line per test, `<name> <passed|failed|...> <pixels|->`,
# where <name> is the PNG name (or `ring-alpha`) and <pixels> the differing pixel count
# Playwright reported. Exit 2 on a report that names no test.
read_report() {
    node -e '
        const fs = require("fs");
        const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const ring = process.argv[2];
        const out = [];
        const walk = (s) => {
            for (const spec of s.specs || []) {
                for (const t of spec.tests || []) {
                    const rs = t.results || [];
                    const last = rs[rs.length - 1] || {};
                    const status = last.status || "missing";
                    const msg = (last.errors || []).map((e) => e.message || "").join("\n") +
                        ((last.error && last.error.message) || "");
                    const m = msg.replace(/\x1b\[[0-9;]*m/g, "").match(/([0-9]+) pixels \(ratio/);
                    const name = spec.title.includes(ring)
                        ? "ring-alpha"
                        : spec.title.replace(/^machine kinds pixel: /, "");
                    out.push(`${name} ${status} ${m ? m[1] : "-"}`);
                }
            }
            for (const c of s.suites || []) walk(c);
        };
        for (const s of r.suites || []) walk(s);
        if (out.length === 0) process.exit(2);
        console.log(out.join("\n"));
    ' "${RUNS}/$1.json" "$RING_TEST"
}

# --- The spec is green before any break ------------------------------------------------
run_spec baseline
if ! BASE_READ="$(read_report baseline)"; then
    echo "FAIL: the unmutated run's report names no test." >&2
    exit 2
fi
base_pass="$(grep -c ' passed ' <<<"$BASE_READ" || true)"
base_all="$(grep -c . <<<"$BASE_READ" || true)"
if [ "$(cat "${RUNS}/baseline.rc")" -ne 0 ] || [ "$base_pass" -ne 14 ] || [ "$base_all" -ne 14 ]; then
    echo "FAIL: the spec is not green before any break (exit $(cat "${RUNS}/baseline.rc"), ${base_pass} of ${base_all} passed, 14 required):" >&2
    printf '%s\n' "$BASE_READ" | sed 's/^/  /' >&2
    echo "This is exit 2, not exit 1: a break's redness measures nothing against a suite" >&2
    echo "that was already red." >&2
    exit 2
fi

# --- The files the breaks touch, kept once -------------------------------------------
A="frontend/src/render/assets"
L="frontend/src/render/layers"
prover_keep_bytes "$A/source.svg" "$A/sink.svg" "$A/factory.svg" "$A/tee.svg" \
    "$A/balancer.svg" "$A/router.svg" "$A/merge.svg" "$A/endpoint.svg" \
    "$L/machines.ts" "$L/machineState.ts" "$L/machineChassis.ts"

# break_svg <file>: delete the first `<path data-part=...>` line.
break_svg() {
    local n
    n="$(grep -n -m1 '^[[:space:]]*<path data-part=' "$1" | cut -d: -f1)"
    [ -n "$n" ] || return 1
    sed -i "${n}d" "$1"
}

failures=()
mut_lines=()

# prove <break name> <file> <expected PNG set, comma-joined> <command...>
prove() {
    local name="$1" file="$2" want="$3" rep failed pixels green png st px bad
    shift 3
    if ! "$@"; then
        echo "FAIL: the break '${name}' could not be applied to ${file}." >&2
        exit 2
    fi
    if prover_same_as_kept "$file"; then
        echo "FAIL: the break '${name}' changed no byte of ${file}." >&2
        exit 2
    fi
    run_spec "$name"
    prover_put_back "$file"
    if ! rep="$(read_report "$name")"; then
        echo "FAIL: the report of '${name}' names no test." >&2
        exit 2
    fi
    failed=""
    pixels=""
    green=""
    bad=""
    while read -r png st px; do
        [ -n "$png" ] || continue
        if [ "$png" = "ring-alpha" ]; then
            [ "$st" = "passed" ] || bad="${bad} ring-alpha=${st}"
            continue
        fi
        case ",${want}," in
            *",${png},"*)
                if [ "$st" = "failed" ] && [ "$px" != "-" ]; then
                    failed="${failed:+${failed},}${png}"
                    pixels="${pixels:+${pixels},}${px}"
                else
                    bad="${bad} ${png}=${st}(must redden)"
                fi
                ;;
            *)
                if [ "$st" = "passed" ]; then
                    green="${green:+${green},}${png}"
                else
                    bad="${bad} ${png}=${st}(must stay green)"
                fi
                ;;
        esac
    done <<<"$rep"
    if [ "$(tr ',' '\n' <<<"$failed" | sort)" != "$(tr ',' '\n' <<<"$want" | sort)" ]; then
        bad="${bad} reddened=[${failed}] wanted=[${want}]"
    fi
    if [ -n "$bad" ]; then
        failures+=("${name}:${bad}")
        echo "MUT ${failed:-none} verdict=NOT-AS-PINNED by=${name} rev=${REV} overlay=${OVERLAY} pixels=${pixels:-none} green=${green:-none}"
    else
        mut_lines+=("MUT ${failed} verdict=RED by=${name} rev=${REV} overlay=${OVERLAY} pixels=${pixels} green=${green}")
        echo "MUT ${failed} verdict=RED by=${name} rev=${REV} overlay=${OVERLAY} pixels=${pixels} green=${green}"
    fi
}

prove svg-source-path "$A/source.svg" kind-source break_svg "$A/source.svg"
prove svg-sink-path "$A/sink.svg" kind-sink,state-faulted-sink break_svg "$A/sink.svg"
prove svg-factory-path "$A/factory.svg" \
    kind-factory,kind-http-handler,state-faulted-factory,state-working-factory break_svg "$A/factory.svg"
prove svg-tee-path "$A/tee.svg" kind-tee break_svg "$A/tee.svg"
prove svg-balancer-path "$A/balancer.svg" kind-balancer break_svg "$A/balancer.svg"
prove svg-router-path "$A/router.svg" kind-router break_svg "$A/router.svg"
prove svg-merge-path "$A/merge.svg" kind-merge break_svg "$A/merge.svg"
prove svg-endpoint-path "$A/endpoint.svg" kind-route break_svg "$A/endpoint.svg"
prove handler-subject-router "$L/machines.ts" kind-http-handler \
    sed -i "/^export const SUBJECT_OF/,/^};/ s/^  \[machine_kind\.HANDLER\]: 'factory',$/  [machine_kind.HANDLER]: 'router',/" "$L/machines.ts"
prove label-fill-alpha-0.5 "$L/machines.ts" kind-label \
    sed -i 's/^export const LABEL_FILL_ALPHA = 0\.16;$/export const LABEL_FILL_ALPHA = 0.5;/' "$L/machines.ts"
prove alert-ring-noop "$L/machineState.ts" state-faulted-factory,state-faulted-sink \
    sed -i 's/^export function drawAlertRing(g: Graphics, w: number, h: number, skin: Skin): void {$/&\n  if (g) return;/' "$L/machineState.ts"
prove chassis-faulted-ink-idle "$L/machineChassis.ts" state-faulted-factory,state-faulted-sink \
    sed -i 's/^  if (state === state_tag\.FAULTED) return skin\.palette\.accents\.fault;$/  if (state === state_tag.FAULTED) return skin.palette.ramp[skin.palette.ramp.length - 1];/' "$L/machineChassis.ts"
prove fault-nub-ramp4 "$L/machines.ts" \
    kind-factory,kind-http-handler,state-faulted-factory,state-working-factory,kind-router,kind-sink,state-faulted-sink \
    sed -i 's/^  if (role === PORT_ROLE\.FAULT) return ramp\[3\];$/  if (role === PORT_ROLE.FAULT) return ramp[4];/' "$L/machines.ts"
prove notch-offset-zero "$L/machineState.ts" state-working-factory \
    sed -i 's/^  return Math\.floor((f \* p) \/ FRAMES);$/  return 0;/' "$L/machineState.ts"

# --- Every file is back to its kept bytes -----------------------------------------------
if ! prover_same_as_kept "$A/source.svg" "$A/sink.svg" "$A/factory.svg" "$A/tee.svg" \
    "$A/balancer.svg" "$A/router.svg" "$A/merge.svg" "$A/endpoint.svg" \
    "$L/machines.ts" "$L/machineState.ts" "$L/machineChassis.ts"; then
    echo "FAIL: a broken file was not put back to its kept bytes." >&2
    exit 2
fi

# --- Verdict ------------------------------------------------------------------------
if [ "${#failures[@]}" -ne 0 ]; then
    echo "FAIL: the per-kind baselines do not bite as pinned:" >&2
    for msg in "${failures[@]}"; do
        printf '  - %s\n' "$msg" >&2
    done
    exit 1
fi

echo "PROVEN: every per-kind machine baseline reddens on its own broken art and on no other."
echo "  baseline  -> 14 of 14 tests green before any break, at ${REV} overlay=${OVERLAY}"
echo "  breaks    -> ${#mut_lines[@]} of 14 reddened exactly their PNG set; every other screenshot"
echo "               and the ring-alpha test stayed green; pixel counts in the MUT lines above"
echo "  TRACKED   -> every break made in a private worktree and put back from kept bytes; the"
echo "               shared tree compared by scripts/lib/prover-isolation.sh at exit; Vite's"
echo "               cache kept in the worktree's own node_modules"
exit 0
