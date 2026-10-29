// The pure belt-path normalizer (BELT-01..03) — a 1:1 TypeScript port of the
// Rust `route()` in crates/fabrico-command/src/route.rs.
//
// `route()` turns a player-ordered, orthogonally-adjacent list of drawn cells
// into typed/oriented tiles with auto-inferred 90 deg corners. It is PURE,
// deterministic, integer-only (no floats), and search-free — there is NO
// A*/auto-routing (BELT-02): it normalizes the path the player drew, it never
// invents one.
//
// # One shared primitive (preview == commit, BELT-03)
// The host commit path (`validate_normalize`) calls the Rust `route()`; this TS
// port is the SAME algorithm for the draw-belt live preview (14-07). It is
// golden-pinned to the cross-language `route` fixture (14-02) in route.test.ts,
// so the build-blue preview equals the committed belt STRUCTURALLY. Any
// corner-inference divergence fails CI.
//
// # Atomic typed rejection (never a guess)
// An empty / non-adjacent (diagonal or >1 jump) / self-crossing path is rejected
// ATOMICALLY with a typed RouteError before any tile is produced. `route()`
// never throws and never partially applies — a rejected path is an ORDINARY
// result the caller renders red (and emits NO command).
//
// # Boundary: geometry only, NOT occupancy
// `route()` does NOT check grid occupancy or extent — it is reusable pure
// geometry. The red "crosses an existing belt/machine" preview is an ADDITIONAL
// local check against sceneState occupancy in the gesture layer (14-07); the
// host `validate_normalize` remains the authority, so a local false-positive
// only means no echo (SC5-tolerant).

import type { TileKindView, TileView } from './decode.ts';

/**
 * Why a drawn belt path was rejected — a typed, non-throwing, atomic outcome.
 * `route()` produces NOTHING on any of these (never a partial path, never a
 * guess). Mirrors Rust `RouteError`.
 */
export type RouteError = 'Empty' | 'NonAdjacent' | 'SelfCrossing';

/**
 * The result of `route()` — a discriminated union, NOT exceptions. A rejected
 * path is an ordinary `{ ok: false }` value the caller renders red.
 */
export type RouteResult =
  | { ok: true; tiles: TileView[] }
  | { ok: false; error: RouteError };

// Dir on the pinned y-down axis convention (mirrors route.rs `dir_of_step` and
// fabrico_core unit_delta): N=0, E=1, S=2, W=3.
const DIR_N = 0;
const DIR_E = 1;
const DIR_S = 2;
const DIR_W = 3;

// Axis: X=0, Y=1 (mirrors route.rs `axis_of_dir` / the wire TileKindView).
const AXIS_X = 0;
const AXIS_Y = 1;

/**
 * Map an orthogonal unit step `(dx, dy)` to its Dir on the y-down convention:
 * `N=(0,-1)`, `E=(+1,0)`, `S=(0,+1)`, `W=(-1,0)`. The adjacency check runs
 * first, so the non-unit arm is unreachable — kept total and returns `null`
 * rather than throwing (mirrors the Rust `Option`).
 */
function dirOfStep(dx: number, dy: number): number | null {
  if (dx === 0 && dy === -1) return DIR_N;
  if (dx === 1 && dy === 0) return DIR_E;
  if (dx === 0 && dy === 1) return DIR_S;
  if (dx === -1 && dy === 0) return DIR_W;
  return null;
}

/**
 * The straight-run Axis a flow Dir travels along: `N`/`S` run on the vertical
 * `Axis::Y`; `E`/`W` run on the horizontal `Axis::X` (mirrors route.rs
 * `axis_of_dir`).
 */
function axisOfDir(dir: number): number {
  return dir === DIR_N || dir === DIR_S ? AXIS_Y : AXIS_X;
}

/**
 * Normalize a player-ordered, orthogonally-adjacent list of drawn `cells` into
 * typed/oriented tiles with auto-inferred 90 deg corners (BELT-01).
 *
 * PURE, deterministic, integer-only, search-free (NO A-star/auto-routing, BELT-02).
 * A 1:1 port of the Rust commit-path `route()`, so preview == commit holds
 * structurally (BELT-03).
 *
 * - A length-1 path is a single `Straight{X}` tile (no drawn direction).
 * - An endpoint carries its single direction as a `Straight` along that axis.
 * - An interior tile whose in-dir equals its out-dir is a `Straight` along that
 *   axis; a perpendicular bend is an auto-inferred `Corner{from,to}`. A 180 deg
 *   reversal is impossible (rejected by the distinct-cells check).
 *
 * Returns `{ ok: false, error }` (Empty / NonAdjacent / SelfCrossing) for a
 * rejected path — the WHOLE path is rejected atomically; `route()` never throws.
 */
export function route(cells: readonly [number, number][]): RouteResult {
  if (cells.length === 0) {
    return { ok: false, error: 'Empty' };
  }

  // (a) Self-crossing / overlap-with-self: every cell must be distinct. A Set of
  //     "x,y" string keys is the deterministic, integer-only analog of the
  //     Rust ordered BTreeSet (insertion order is irrelevant to the boolean).
  const seen = new Set<string>();
  for (const [x, y] of cells) {
    const key = `${x},${y}`;
    if (seen.has(key)) {
      return { ok: false, error: 'SelfCrossing' };
    }
    seen.add(key);
  }

  // (b) Every consecutive step must be orthogonally adjacent (|dx| + |dy| == 1).
  //     This rejects diagonal steps AND >1-cell jumps in one check.
  for (let i = 1; i < cells.length; i++) {
    const dx = cells[i][0] - cells[i - 1][0];
    const dy = cells[i][1] - cells[i - 1][1];
    if (Math.abs(dx) + Math.abs(dy) !== 1) {
      return { ok: false, error: 'NonAdjacent' };
    }
  }

  // (c) Per-tile direction + corner inference. After (a)+(b) every interior cell
  //     has exactly one in-direction and one out-direction (both unit steps),
  //     equal (straight) or perpendicular (corner) — no ambiguity remains.
  const n = cells.length;
  const tiles: TileView[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [cx, cy] = cells[i];
    // in_dir = step INTO this cell (null at the tail/admit end).
    const inDir =
      i > 0 ? dirOfStep(cx - cells[i - 1][0], cy - cells[i - 1][1]) : null;
    // out_dir = step OUT of this cell (null at the head/deliver end).
    const outDir =
      i + 1 < n ? dirOfStep(cells[i + 1][0] - cx, cells[i + 1][1] - cy) : null;

    let kind: TileKindView;
    if (inDir !== null && outDir !== null) {
      // Interior tile: equal dirs => straight; perpendicular => corner.
      kind =
        inDir === outDir
          ? { Straight: { axis: axisOfDir(inDir) } }
          : { Corner: { from: inDir, to: outDir } };
    } else if (inDir === null && outDir !== null) {
      // Tail/admit end (longer path): single out-direction.
      kind = { Straight: { axis: axisOfDir(outDir) } };
    } else if (inDir !== null && outDir === null) {
      // Head/deliver end (longer path): single in-direction.
      kind = { Straight: { axis: axisOfDir(inDir) } };
    } else {
      // Length-1 path: no drawn direction — default to the X axis.
      kind = { Straight: { axis: AXIS_X } };
    }

    tiles[i] = { cell_x: cx, cell_y: cy, kind };
  }

  return { ok: true, tiles };
}
