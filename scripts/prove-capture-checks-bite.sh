#!/usr/bin/env bash
#
# PLANTED-BREAK PROOF for the board capture set's grading checks.
#
# ---------------------------------------------------------------------------------
# WHAT THIS PROVES.
#
# `frontend/e2e-live/board-grade.capture.ts` grades six measured properties of the demo
# board, captured on the real host and the real Vite app (`board.capture.ts`). A check that
# fails at HEAD shows it can fail on a real defect; it does not show that the cells which
# pass are passing for the right reason. So this prover takes a cell that passes today,
# breaks the one thing that cell measures, and asserts that the cell's test turns red and
# that no test of another property changes its verdict.
#
# It runs the capture set for one boot (pixel ratio 1, antialiasing as shipped) once
# unmutated, which must be clean: every test passed or a declared expected failure. Then it
# applies each break below in turn, captures again, puts the file back from its kept bytes,
# and compares the two runs:
#
#   break               file (in the private worktree)          must turn red (dpr=1 aa=shipped)
#   outline-thin-side   layers/machines.ts: the Sink at cell     outline-sides zoom=1, naming
#                       (14,4), node 4, draws its right side     machine 4's right side
#                       2 px wide instead of 3
#   glyph-thin-leg      assets/factory.svg: the Factory glyph's  glyph-strokes zoom=1, naming
#                       top-left leg (leg-0) drawn 1 px wide     leg-0
#                       instead of 2, in a path of its own
#   ring-gap            layers/machines.ts: every fault port     fault-ring zoom=1, naming a gap
#                       ring drawn as an arc with 30 degrees     in a ring
#                       missing, centred on its outward normal
#   dash-hole           synth/beltGeometry.ts: one world px cut  belt-dash zoom=1, naming a gap
#                       out of the middle of every straight      in the dash
#                       tile's dash 3 px or longer
#   rail-wide           synth/beltGeometry.ts: every rail 3      rail-vs-outline zoom=1, naming a
#                       device px wider than shipped (4 at       rail wider than the outline
#                       zoom 1, against an outline of 3)
#   cap-wide            layers/belts.ts: the Factory's output    cap-in-cell zoom=1, naming belt
#                       cap (belt 19's Tail) drawn as an         19's Tail cap
#                       ellipse 48 px along the machine's side,
#                       about 35 px where the check scans, set
#                       outward of the box so it stays off the
#                       outline the outline check reads
#
# Every target is the zoom-1 cell of its property, and every one of them passes at HEAD. Each
# break is as narrow as it can be made: the cap is one belt end, because a cap wider than a
# cell at zoom 1 placed on its port would cover that machine's outline, and the outline check
# would change its verdict too.
#
# Every test whose verdict changed must belong to the break's property (a declared cell of
# that property may change too: its offenders then differ from its row). The two runs'
# manifests must list the same captures and the same machines in the same order, with equal
# outline-side and glyph-leg widths everywhere the break did not reach. A difference there
# means the measurement is not stable enough to grade, and fails the proof.
#
# One line per break: `MUT <break> verdict=RED test="<title>" changed=<n> rev=<40-hex>
# overlay=<stamp>`, then a `PROVEN:` line. `rev` is HEAD and `overlay` names what the run
# carried over it (`prover_overlay_stamp`): `none`, or the 16-hex name of the caller's
# tracked diff and untracked files. A line with an overlay other than `none` is evidence
# about that tree, not about the revision alone.
#
# IT NEVER WRITES THE SHARED TREE, ITS INDEX OR ITS node_modules. Every break is made in a
# private worktree (scripts/lib/prover-isolation.sh, Shape B): a detached worktree of HEAD
# plus the caller's uncommitted tracked diff and untracked files. Each file a break touches
# is kept with `prover_keep_bytes` first and put back from those bytes after the run. The
# worktree gets a real `frontend/node_modules` directory whose entries link to the caller's
# (`prover_link_node_modules`), so Vite's caches are written inside the worktree. Each run
# starts its own dev_render_server and its own Vite inside a private network namespace
# (`unshare -rn`), so ports 8787 and 5173 cannot collide with servers the caller runs.
#
# THE HOST BINARY comes from the caller's checkout, `FABRICO_CAPTURE_HOST_BIN`, by default
# `target/debug/examples/dev_render_server`: the breaks touch only frontend render code, and
# the worktree's private cargo target has no build. Build it first with
# `cargo build -p fabrico-host --example dev_render_server`.
#
# ONE BOOT PER RUN, IN TWO PLAYWRIGHT CALLS. The grading project depends on the capture
# project, and Playwright runs a dependency project in full whatever `--grep` says, which
# would capture all six boots every run. So each run calls the capture project alone, then
# the grading project with `--no-deps`, both filtered to `dpr=1 aa=shipped`, each with its
# own `--output` so neither call cleans `frontend/test-results/capture/` under the other.
#
# LINUX ONLY: the private namespace is `unshare`. On a host without `unshare`, `curl`, `node`
# or `ip`, the proof is not made (exit 2).
#
# HOW TO RUN: `bash scripts/prove-capture-checks-bite.sh` from anywhere in the checkout. It
# takes no arguments. The worktree and every run directory go under `$TMPDIR`; on a machine
# where /tmp is held in memory, point it at disk (`TMPDIR=$HOME/.cache/fabrico-tmp`). It
# makes one unmutated run and one run per break, seven in all, each booting the host and
# Vite. MEASURED: 202 s wall time for the seven runs on a developer machine at a load average
# under 5 (the PROVEN line prints each run's own figure); the worst case under the per-run
# limit is 7 x 900 s, about 1 h 45 min, reached only if every run hangs.
#
# EXIT CODES:
#   0  PROVEN: every break turned its cell red, changed no other property's verdict, and
#      the two runs agree outside the break.
#   1  A break did not turn its cell red, or changed another property's verdict, or the
#      manifests disagree outside the break. Every failing break is named.
#   2  The proof COULD NOT BE MADE. This is a FAILURE, not a pass: a missing tool, file or
#      host binary, a capture set that is not clean before any break, a break whose anchor
#      was not found or that changed no byte, servers that did not come up, a report that
#      could not be read, or a tree another writer moved.

set -euo pipefail

# Sourced before any change of directory: the helper records where this script lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source-path=SCRIPTDIR source=lib/prover-isolation.sh
. "${SCRIPT_DIR}/lib/prover-isolation.sh"

# Resolved before the change of directory, so a relative path means what the caller meant.
if [ -n "${FABRICO_CAPTURE_HOST_BIN:-}" ]; then
    case "$FABRICO_CAPTURE_HOST_BIN" in
        /*) ;;
        *) FABRICO_CAPTURE_HOST_BIN="$(pwd -P)/${FABRICO_CAPTURE_HOST_BIN}" ;;
    esac
fi

cd "$(git rev-parse --show-toplevel)"

BOOT_GREP="dpr=1 aa=shipped"
BOOT_DIR="dpr1-aa-shipped"
RUN_LIMIT=900

usage() {
    cat >&2 <<'USAGE'
usage: scripts/prove-capture-checks-bite.sh

Proves each board capture grading check turns red when the thing it measures is broken
in a cell that passes today, and that no other property's verdict changes. Every break
is made in a private worktree; each run has its own host and Vite in a private network
namespace.

  --help, -h     this message

Environment:
  FABRICO_CAPTURE_HOST_BIN   the dev_render_server binary (default: this checkout's
                             target/debug/examples/dev_render_server)

Exit codes:
  0  proven
  1  a break did not turn exactly its property red; every failure is named
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

for tool in unshare curl node ip timeout; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "FAIL: '${tool}' is not available, so the proof could not be made." >&2
        exit 2
    fi
done
for f in frontend/playwright.capture.config.ts frontend/e2e-live/board.capture.ts frontend/e2e-live/board-grade.capture.ts; do
    if [ ! -f "$f" ]; then
        echo "FAIL: ${f} is missing, so there is no capture set to prove." >&2
        exit 2
    fi
done
# The outer run fixes the binary from the caller's checkout; the inner run inherits it.
export FABRICO_CAPTURE_HOST_BIN="${FABRICO_CAPTURE_HOST_BIN:-$(pwd -P)/target/debug/examples/dev_render_server}"
if [ ! -x "$FABRICO_CAPTURE_HOST_BIN" ]; then
    echo "FAIL: the host binary ${FABRICO_CAPTURE_HOST_BIN} is missing." >&2
    echo "      Build it with: cargo build -p fabrico-host --example dev_render_server" >&2
    exit 2
fi

# --- Into the private worktree (Shape B) ---------------------------------------------
# In the caller this does not return; inside the worktree it returns and the proof goes
# on there.
prover_run_in_worktree ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}

START="$(date +%s)"
REV="$(git rev-parse HEAD)"
OVERLAY="$(prover_overlay_stamp)"
CALLER="$(prover_caller_root)"
HOST_BIN="$FABRICO_CAPTURE_HOST_BIN"
if [ ! -d "${CALLER}/frontend/node_modules/@playwright/test" ] || [ ! -f "${CALLER}/frontend/node_modules/vite/bin/vite.js" ]; then
    echo "FAIL: ${CALLER}/frontend/node_modules has no Playwright or Vite (run npm ci in frontend/)." >&2
    exit 2
fi
prover_link_node_modules "${CALLER}/frontend/node_modules" frontend/node_modules

RUNS="$(mktemp -d "${TMPDIR:-/tmp}/fabrico-capture-runs.XXXXXX")"
cleanup() {
    # A real directory of links and the private Vite cache: removing it removes links,
    # never what they point at.
    if [ -d frontend/node_modules ] && [ ! -L frontend/node_modules ]; then
        rm -rf -- frontend/node_modules
    fi
    rm -rf -- "$RUNS"
}
prover_on_exit cleanup

# run_capture <tag>: one capture run of the boot with its own host and Vite in a private
# network namespace. Writes into $RUNS/<tag>/: capture.json and grade.json (the two
# Playwright reports), manifest.json (the boot's manifest), rc (the worse Playwright exit
# code, 90 when the servers did not come up) and the server and runner output. Exits 2
# when the run could not be made at all.
run_capture() {
    local tag="$1" dir="${RUNS}/$1" rc
    mkdir -p "$dir"
    set +e
    timeout "$RUN_LIMIT" unshare -rn bash -c '
        set -u
        out="$1" host_bin="$2" grep_for="$3" boot_dir="$4"
        ip link set lo up || exit 91
        cd frontend || exit 92
        "$host_bin" >"$out/host.log" 2>&1 &
        host=$!
        node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort >"$out/vite.log" 2>&1 &
        vite=$!
        stop() {
            kill "$host" "$vite" 2>/dev/null
            wait "$host" 2>/dev/null
            wait "$vite" 2>/dev/null
        }
        up=0
        for _ in $(seq 240); do
            h="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/render)"
            v="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/)"
            if [ "$h" = 400 ] && [ "$v" = 200 ]; then up=1; break; fi
            sleep 0.5
        done
        if [ "$up" -ne 1 ]; then stop; exit 90; fi
        rm -f "test-results/capture/${boot_dir}/manifest.json"
        FABRICO_CAPTURE_REUSE=1 PLAYWRIGHT_JSON_OUTPUT_NAME="$out/capture.json" npx playwright test \
            --config=playwright.capture.config.ts --project=capture --grep "$grep_for" \
            --output="$out/pw-capture" --reporter=json --retries=0 >"$out/capture.out" 2>&1
        crc=$?
        if [ -f "test-results/capture/${boot_dir}/manifest.json" ]; then
            cp "test-results/capture/${boot_dir}/manifest.json" "$out/manifest.json"
        fi
        FABRICO_CAPTURE_REUSE=1 PLAYWRIGHT_JSON_OUTPUT_NAME="$out/grade.json" npx playwright test \
            --config=playwright.capture.config.ts --project=grade --no-deps --grep "$grep_for" \
            --output="$out/pw-grade" --reporter=json --retries=0 >"$out/grade.out" 2>&1
        grc=$?
        stop
        if [ "$crc" -ne 0 ]; then exit "$crc"; fi
        exit "$grc"
    ' _ "$dir" "$HOST_BIN" "$BOOT_GREP" "$BOOT_DIR" >"${dir}/run.out" 2>&1
    rc=$?
    set -e
    echo "$rc" >"${dir}/rc"
    if [ "$rc" -ge 90 ] || [ ! -s "${dir}/capture.json" ] || [ ! -s "${dir}/grade.json" ]; then
        echo "FAIL: the capture run '${tag}' could not be made (exit ${rc}):" >&2
        for log in run.out host.log vite.log capture.out grade.out; do
            if [ -f "${dir}/${log}" ]; then
                echo "  --- ${log} (last 20 lines)" >&2
                tail -n 20 "${dir}/${log}" | sed 's/^/  /' >&2
            fi
        done
        exit 2
    fi
}

# The comparison of two runs, in node: reads both runs' reports and manifests and prints
# `CHANGED <n>`, `TARGET <before> <after>`, `NAMED yes|no`, `ERROR <first line>`,
# `OFFENDER <the error line naming the subject>`, `PLANTED <what moved inside the break>` and one `PROBLEM <text>` per failed assertion.
# With only one run directory it checks that run is clean and prints `TESTS <n>` and any
# PROBLEM lines. Exit 3 when a report or manifest cannot be read.
read -r -d '' ANALYSE <<'JS' || true
const fs = require("fs");
const path = require("path");
const [mode, baseDir, breakDir, property, target, allowOutline, allowGlyph, needle] = process.argv.slice(1);
const load = (f) => {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { console.error(`cannot read ${f}: ${e.message}`); process.exit(3); }
};
const strip = (s) => (s || "").replace(/\x1b\[[0-9;]*m/g, "");
const tests = (dir) => {
    const out = new Map();
    for (const name of ["capture.json", "grade.json"]) {
        const walk = (s) => {
            for (const spec of s.specs || []) {
                for (const t of spec.tests || []) {
                    const rs = t.results || [];
                    const last = rs[rs.length - 1] || {};
                    const msg = strip((last.errors || []).map((e) => e.message || "").join("\n") || (last.error && last.error.message) || "");
                    out.set(spec.title, { status: last.status || "missing", outcome: t.status || "missing", error: msg });
                }
            }
            for (const c of s.suites || []) walk(c);
        };
        for (const s of load(path.join(dir, name)).suites || []) walk(s);
    }
    return out;
};
const problems = [];
const base = tests(baseDir);
if (mode === "baseline") {
    if (base.size === 0) problems.push("the reports name no test");
    for (const [title, t] of base) {
        if (t.outcome !== "expected") problems.push(`${title}: ${t.status} (${t.outcome}), ${t.error.split("\n")[0]}`);
    }
    console.log(`TESTS ${base.size}`);
    for (const p of problems) console.log(`PROBLEM ${p}`);
    process.exit(0);
}
const brk = tests(breakDir);
let changed = 0;
for (const [title, b] of base) {
    const a = brk.get(title);
    if (a === undefined) { problems.push(`${title}: missing from the break's run`); continue; }
    if (a.status === b.status && a.outcome === b.outcome) continue;
    changed++;
    if (!title.startsWith(`${property} `)) problems.push(`${title} (another property) changed: ${b.status}/${b.outcome} -> ${a.status}/${a.outcome}, ${a.error.split("\n")[0]}`);
}
for (const title of brk.keys()) if (!base.has(title)) problems.push(`${title}: only in the break's run`);
const tb = base.get(target), ta = brk.get(target);
console.log(`CHANGED ${changed}`);
console.log(`TARGET ${tb ? tb.status : "missing"} ${ta ? ta.status : "missing"}`);
if (!tb || tb.status !== "passed") problems.push(`${target} did not pass in the unmutated run`);
if (!ta || ta.status !== "failed") problems.push(`${target} did not fail with the break (${ta ? ta.status : "missing"})`);
const err = ta ? ta.error : "";
const named = needle === "" || err.includes(needle);
console.log(`NAMED ${named ? "yes" : "no"}`);
if (!named) problems.push(`${target}'s error does not name ${JSON.stringify(needle)}`);
console.log(`ERROR ${(err.split("\n").find((l) => l.trim() !== "") || "").trim()}`);
if (needle !== "") console.log(`OFFENDER ${(err.split("\n").find((l) => l.includes(needle)) || "").trim()}`);

// The manifests: same captures, same machines, same order; equal widths outside the break.
const mb = load(path.join(baseDir, "manifest.json")), ma = load(path.join(breakDir, "manifest.json"));
const okOutline = new Set(allowOutline.split(",").filter(Boolean));
const okGlyph = new Set(allowGlyph.split(",").filter(Boolean));
const capKey = (e) => `${e.zoomId}:t${e.tile}:${e.png}`;
const keysB = mb.entries.map(capKey), keysA = ma.entries.map(capKey);
const planted = new Set();
if (keysB.join("|") !== keysA.join("|")) {
    problems.push(`the captures differ: [${keysB.join(" ")}] against [${keysA.join(" ")}]`);
} else {
    const same = (x, y) => x.measured === y.measured && x.core === y.core && x.fringe === y.fringe && x.effective === y.effective;
    const fmt = (x) => (x.measured ? `core ${x.core} fringe ${x.fringe} effective ${x.effective}` : `not measured`);
    mb.entries.forEach((eb, i) => {
        const ea = ma.entries[i];
        const at = capKey(eb);
        const sceneB = eb.scene.map((m) => m.nodeId).join(","), sceneA = ea.scene.map((m) => m.nodeId).join(",");
        if (sceneB !== sceneA) problems.push(`${at}: the machines differ: [${sceneB}] against [${sceneA}]`);
        const ob = eb.measurements["outline-sides"], oa = ea.measurements["outline-sides"];
        const orderB = ob.map((r) => r.nodeId).join(","), orderA = oa.map((r) => r.nodeId).join(",");
        if (orderB !== orderA) problems.push(`${at}: the measured outlines differ: [${orderB}] against [${orderA}]`);
        else ob.forEach((rb, j) => {
            for (const side of Object.keys(rb.sides)) {
                const k = `${rb.nodeId}:${side}`, sb = rb.sides[side], sa = oa[j].sides[side];
                if (same(sb, sa)) continue;
                if (okOutline.has(k)) planted.add(`${k} at ${at}: ${fmt(sb)} -> ${fmt(sa)}`);
                else problems.push(`${at}: outline ${k} moved outside the break: ${fmt(sb)} -> ${fmt(sa)}`);
            }
        });
        const legKey = (r) => `${r.nodeId}:${r.leg}:${r.segment}`;
        const gb = eb.measurements["glyph-strokes"], ga = ea.measurements["glyph-strokes"];
        const gOrderB = gb.map(legKey).join(","), gOrderA = ga.map(legKey).join(",");
        if (gOrderB !== gOrderA) problems.push(`${at}: the measured glyph legs differ`);
        else gb.forEach((rb, j) => {
            const k = legKey(rb), sb = rb.width, sa = ga[j].width;
            if (same(sb, sa)) return;
            if (okGlyph.has(rb.leg)) planted.add(`${rb.nodeId}:${rb.leg} at ${at}: ${fmt(sb)} -> ${fmt(sa)}`);
            else problems.push(`${at}: glyph leg ${k} moved outside the break: ${fmt(sb)} -> ${fmt(sa)}`);
        });
    });
}
for (const p of planted) console.log(`PLANTED ${p}`);
for (const p of problems) console.log(`PROBLEM ${p}`);
JS

# replace_once <file> <old text> <new text>: the break's patch. Exit 2 when the old text is
# not found exactly once (the anchor moved, so the break would be planted somewhere else
# or nowhere).
replace_once() {
    node -e '
        const fs = require("fs");
        const [file, from, to] = process.argv.slice(1);
        const src = fs.readFileSync(file, "utf8");
        const n = src.split(from).length - 1;
        if (n !== 1) { console.error(`the anchor occurs ${n} times in ${file}, not once`); process.exit(1); }
        fs.writeFileSync(file, src.replace(from, () => to));
    ' "$1" "$2" "$3"
}

# --- The capture set is clean before any break -----------------------------------------
run_capture baseline
if ! BASE_READ="$(node -e "$ANALYSE" baseline "${RUNS}/baseline")"; then
    echo "FAIL: the unmutated run's reports could not be read." >&2
    exit 2
fi
base_tests="$(sed -n 's/^TESTS //p' <<<"$BASE_READ")"
if [ "$(cat "${RUNS}/baseline/rc")" -ne 0 ] || grep -q '^PROBLEM ' <<<"$BASE_READ" || [ "${base_tests:-0}" -lt 2 ] || [ ! -s "${RUNS}/baseline/manifest.json" ]; then
    echo "FAIL: the capture set isn't green before any break (exit $(cat "${RUNS}/baseline/rc"), ${base_tests:-0} tests):" >&2
    sed -n 's/^PROBLEM /  /p' <<<"$BASE_READ" >&2
    echo "This is exit 2, not exit 1: a break's redness measures nothing against a set" >&2
    echo "that was already red." >&2
    exit 2
fi
echo "baseline: ${base_tests} tests clean for ${BOOT_GREP} (passed or declared), at ${REV} overlay=${OVERLAY}"

# --- The files the breaks touch, kept once -------------------------------------------
L="frontend/src/render/layers"
A="frontend/src/render/assets"
S="frontend/src/render/synth"
KEPT=("$L/machines.ts" "$A/factory.svg" "$S/beltGeometry.ts" "$L/belts.ts")
prover_keep_bytes "${KEPT[@]}"

failures=()
mut_lines=()

# prove <break> <file> <property> <target title> <outline keys allowed to move> \
#       <glyph legs allowed to move> <text the error must contain> <old text> <new text>
prove() {
    local name="$1" file="$2" property="$3" target="$4" allow_outline="$5" allow_glyph="$6" needle="$7" from="$8" to="$9"
    local rep changed problems err
    if ! replace_once "$file" "$from" "$to"; then
        echo "FAIL: the break '${name}' could not be applied to ${file}." >&2
        exit 2
    fi
    if prover_same_as_kept "$file"; then
        echo "FAIL: the break '${name}' changed no byte of ${file}." >&2
        exit 2
    fi
    run_capture "$name"
    prover_put_back "$file"
    if ! rep="$(node -e "$ANALYSE" compare "${RUNS}/baseline" "${RUNS}/${name}" "$property" "$target" "$allow_outline" "$allow_glyph" "$needle")"; then
        echo "FAIL: the reports or manifests of '${name}' could not be read." >&2
        exit 2
    fi
    changed="$(sed -n 's/^CHANGED //p' <<<"$rep")"
    err="$(sed -n 's/^ERROR //p' <<<"$rep")"
    problems="$(sed -n 's/^PROBLEM //p' <<<"$rep")"
    if [ -n "$problems" ]; then
        failures+=("${name}: $(tr '\n' ';' <<<"$problems")")
        echo "MUT ${name} verdict=NOT-AS-PINNED test=\"${target}\" changed=${changed:-?} rev=${REV} overlay=${OVERLAY}"
        sed 's/^/  problem: /' <<<"$problems"
    else
        mut_lines+=("MUT ${name} verdict=RED test=\"${target}\" changed=${changed} rev=${REV} overlay=${OVERLAY}")
        echo "MUT ${name} verdict=RED test=\"${target}\" changed=${changed} rev=${REV} overlay=${OVERLAY}"
    fi
    echo "  error: ${err}"
    sed -n 's/^OFFENDER /  offender: /p' <<<"$rep"
    sed -n 's/^PLANTED /  moved inside the break: /p' <<<"$rep"
}

# outline-thin-side: the Sink at cell (14,4), node 4, keeps its left, top and bottom bands
# as shipped (3 px centred on a 4 px inset) and draws its right band 2 px wide with the
# inner edge where it was, so the outer pixel column is gone. At zoom 1 and ratio 1 a world
# pixel is a device pixel. Its right side has no port nub and no belt beside it.
prove outline-thin-side "$L/machines.ts" outline-sides "outline-sides ${BOOT_GREP} zoom=1" \
    "4:right" "" "machine 4 (kind 7) right" \
    "          drawChassis(entry.chassis, node.w, node.h, skin, node.state);
" \
    "          drawChassis(entry.chassis, node.w, node.h, skin, node.state);
          if (node.cell_x === 14 && node.cell_y === 4) {
            const ink = skin.palette.ramp[skin.palette.ramp.length - 1];
            const bw = node.w * CELL;
            const bh = node.h * CELL;
            entry.chassis.clear();
            entry.chassis.moveTo(bw - 4, 4).lineTo(4, 4).lineTo(4, bh - 4).lineTo(bw - 4, bh - 4).stroke({ width: 3, color: ink, alignment: 0.5 });
            entry.chassis.rect(bw - 5.5, 2.5, 2, bh - 5).fill(ink);
          }
"

# glyph-thin-leg: the left brace's first segment (H y=26, 44 to 32) moves into a path of its
# own with the same data-part and stroke-width 1, so its leg number and name are unchanged
# and the measurer, which reads the art from this file, reads it across a 1 px band. Both
# machines that draw the Factory glyph (nodes 1 and 30) carry the thin leg.
prove glyph-thin-leg "$A/factory.svg" glyph-strokes "glyph-strokes ${BOOT_GREP} zoom=1" \
    "" "leg-0" "glyph leg-0: core 1" \
    '  <path data-part="brace-left" d="M 44 26 H 32 V 44 H 24 V 52 H 32 V 70 H 44" fill="none" stroke="#b0bacb" stroke-width="2" />
' \
    '  <path data-part="brace-left" d="M 44 26 H 32" fill="none" stroke="#b0bacb" stroke-width="1" />
  <path data-part="brace-left" d="M 32 26 V 44 H 24 V 52 H 32 V 70 H 44" fill="none" stroke="#b0bacb" stroke-width="2" />
'

# ring-gap: the fault annulus's ring is stroked as an arc that leaves out 30 degrees centred
# on the port's outward normal, where the ring check's rays are not skipped (the rays that
# point into the machine are).
prove ring-gap "$L/machines.ts" fault-ring "fault-ring ${BOOT_GREP} zoom=1" \
    "" "" "a gap in the ring on" \
    "    g.circle(spec.x, spec.y, NUB_FAULT_RING_R).stroke({ width: NUB_STROKE, color });
" \
    "    const gapAt = Math.atan2(spec.ny, spec.nx);
    const a0 = gapAt + Math.PI / 12;
    const a1 = gapAt + 2 * Math.PI - Math.PI / 12;
    g.moveTo(spec.x + Math.cos(a0) * NUB_FAULT_RING_R, spec.y + Math.sin(a0) * NUB_FAULT_RING_R)
      .arc(spec.x, spec.y, NUB_FAULT_RING_R, a0, a1)
      .stroke({ width: NUB_STROKE, color });
"

# dash-hole: each dash run on a straight tile that is 3 world px or longer is emitted as two
# rects with one world px between them (at zoom 1 and ratio 1, one device px).
prove dash-hole "$S/beltGeometry.ts" belt-dash "belt-dash ${BOOT_GREP} zoom=1" \
    "" "" "in the dash, the longest" \
    "    out.push(rect(from - HALF, -BAND, to - from, BELT_GEOM.band, 'tread'));
" \
    "    if (to - from >= 3) {
      const cut = from + Math.floor((to - from) / 2);
      out.push(rect(from - HALF, -BAND, cut - from, BELT_GEOM.band, 'tread'));
      out.push(rect(cut + 1 - HALF, -BAND, to - cut - 1, BELT_GEOM.band, 'tread'));
    } else {
      out.push(rect(from - HALF, -BAND, to - from, BELT_GEOM.band, 'tread'));
    }
"

# rail-wide: the rail band's device thickness gains 3 px at every zoom. Rails grow inward
# from the lane edge, so the lane keeps its width and the dash band stays clear.
prove rail-wide "$S/beltGeometry.ts" rail-vs-outline "rail-vs-outline ${BOOT_GREP} zoom=1" \
    "" "" "wider than the outline's" \
    "    t: Math.max(1, Math.round(BELT_GEOM.rail * q)),
" \
    "    t: Math.max(1, Math.round(BELT_GEOM.rail * q)) + 3,
"

# cap-wide: the cap on the Factory's output port (anchor (224.5, 112), belt 19's Tail) is an
# ellipse 3 world px across and 24 along the side, centred 3 px outward of the anchor. Its
# inner edge sits on the anchor, 3 px outside the outline's outer edge, so the outline
# check's lines (which read 2 px past that edge) never reach it; the cap check scans along
# the side 1 px outward of the anchor, where the ellipse is about 35 px long in a 32 px cell.
prove cap-wide "$L/belts.ts" cap-in-cell "cap-in-cell ${BOOT_GREP} zoom=1" \
    "" "" "belt 19 Tail cap:" \
    "        g.circle(cx, cy, capR).fill(plugCapColor(anchor.role));
" \
    "        if (anchor.x === 224.5 && anchor.y === 112) {
          g.ellipse(anchor.x + 3, anchor.y, 3, 24).fill(plugCapColor(anchor.role));
        } else {
          g.circle(cx, cy, capR).fill(plugCapColor(anchor.role));
        }
"

# --- Every file is back to its kept bytes -----------------------------------------------
if ! prover_same_as_kept "${KEPT[@]}"; then
    echo "FAIL: a broken file was not put back to its kept bytes." >&2
    exit 2
fi

# --- Verdict ------------------------------------------------------------------------
WALL=$(($(date +%s) - START))
if [ "${#failures[@]}" -ne 0 ]; then
    echo "FAIL: the capture checks do not bite as pinned:" >&2
    for msg in "${failures[@]}"; do
        printf '  - %s\n' "$msg" >&2
    done
    exit 1
fi

echo "PROVEN: ${#mut_lines[@]} break(s) reddened exactly their checks, at ${REV} overlay=${OVERLAY}, ${WALL} s wall"
echo "  baseline  -> ${base_tests} tests clean for ${BOOT_GREP} before any break"
echo "  breaks    -> each turned its cell red and changed no other property's verdict; the"
echo "               manifests agree outside the break (MUT lines above)"
echo "  TRACKED   -> every break made in a private worktree and put back from kept bytes; the"
echo "               shared tree compared by scripts/lib/prover-isolation.sh at exit"
exit 0
