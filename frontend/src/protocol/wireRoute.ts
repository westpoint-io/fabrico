// wireRoute.ts — the TS mirror of the Rust `wire_route`
// (crates/fabrico-command/src/wire_route.rs, frozen in 40-01).
//
// The belt `route()` normalizes a path the PLAYER drew; a wire is drawn
// differently — the player docks two electrical terminals and the cable
// AUTO-routes between them (there is no per-cell drag). `wireRoute` is that
// auto-router: given two resolved electrical endpoints (each a world CELL + the
// outward SIDE of its nub + the resolved BODY rectangle of its machine), it
// computes the deterministic orthogonal cell path between the two nub cells, then
// NORMALIZES that path through the existing parity-pinned `route()` so wire
// corners inherit the same proven 90-degree corner geometry belts use (BELT-01,
// 14-02 fixture). It also carries the two electrical terminal anchors (the
// wire-specific geometry `route()` does not cover), so the drawn cable == the
// model on BOTH ends.
//
// # FIVE CANDIDATES, tried in order (72-16, 75-01, 75-03)
//   1. `perimeterCells` — the union-box perimeter RING. Fires only when NEITHER
//      face can be honoured by any L or Z, i.e. all four admissibility booleans
//      false. Both terminal segments are on their port normal axes BY
//      CONSTRUCTION, which is what lets `wires.ts::clampEndToNub` apply at BOTH
//      ends. This is the J-7 ruling of 2026-09-04, "make it go around".
//   2. the GO-AROUND (75-01, `CAND_GO_AROUND`): fires only when the face-aligned
//      shape would honour EXACTLY ONE face and both stub cells are free of both
//      bodies and both docks; `goAroundSearch` finds the shortest, then
//      fewest-bend, path between the two stubs that keeps out of both bodies.
//   3. CLEAR OF BODIES (75-03, `CAND_CLEAR_OF_BODIES`): a port facing straight into
//      the neighbour's body; the shortest connection crossing neither machine, from any
//      free neighbour of one dock to any free neighbour of the other.
//   4. `faceAlignedCells`: receives every pair the three above decline.
//   5. `manhattanL`: unconditional last, still unreachable by proof.
//
// WHAT IS FIXED IS NARROWER THAN THE SENTENCE PEOPLE WILL USE FOR IT. Since 75-01
// the one-face class goes around, EXCEPT where a stub cell is blocked: two touching
// cells where one port faces straight at the other cell (the two-cell run stays), and
// a port facing straight into the neighbour's body, which candidate 4 draws clear of
// both machines since 75-03 unless a dock has no free neighbour at all. Two docks on one
// cell are refused as `'Coincident'` (75-03). "The cable plugs in at both ends" holds
// outside those named shapes, not universally.
//
// # NOT a TS-only router (the live-oracle drift lesson)
// The Rust `wire_route` is AUTHORITATIVE. This is a MIRROR: wireRoute.test.ts
// pins it, value-for-value, to the frozen cross-language golden (wire.bin +
// wire.expected.json). Any divergence fails CI (WUI-01 criterion 4).
//
// # Integer-only, deterministic, float-free
// Everything here is integer cell math. The render-side pixel nub anchor (the
// 2.5px outward push, `ports.ts::nubAnchor`) is derived canvas-side from the
// integer `(cell, side)` this pins — never on the wire, never in this golden.

import type { NodeView, TileView } from './decode.ts';
import { effectiveBox } from './footprint.ts';
import { machine_kind } from './kinds.ts';
import { type RouteError, route } from './route.ts';

/**
 * A resolved electrical wire endpoint: the port's world CELL plus the outward
 * SIDE of its electrical nub (`N=0, E=1, S=2, W=3` — the core side numbering).
 * Integer-only; the render-side pixel anchor (`ports.ts::nubAnchor`) is DERIVED
 * from this `(cell, side)` canvas-side and never rides the wire.
 */
export interface WireDock {
  /** The port's world cell `[x, y]`. */
  cell: [number, number];
  /** The outward side of the electrical nub (`N=0, E=1, S=2, W=3`). */
  side: number;
  /** The inclusive world cell bounds of the machine this port belongs to. */
  body: WireBody;
}

/**
 * The inclusive world cell bounds of the machine a `WireDock` belongs to,
 * ROTATION ALREADY APPLIED. A port with no machine behind it (the free-drag
 * pointer target) uses the degenerate `min === max ===` the pointer cell.
 *
 * A NAMED INTERFACE AND NOT A BARE FOUR-TUPLE: an argument-order transposition in
 * a `[number, number, number, number]` is invisible to the type checker, and this
 * rectangle is read by two languages. Mirrors Rust `WireBody`.
 */
export interface WireBody {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

/**
 * The DEGENERATE body of a dock with no machine behind it: the free-drag pointer
 * target, and a 1x1 machine, both of which occupy exactly their own cell.
 */
export function cellBody(x: number, y: number): WireBody {
  return { min_x: x, min_y: y, max_x: x, max_y: y };
}

/**
 * The resolved body rectangle of a scene node — THE ONE ROT DECODE IN THIS
 * LANGUAGE, and the only place any TS caller may derive a `WireBody` from a
 * `NodeView`.
 *
 * It exists as one exported function rather than four lines at each call site
 * because the whole reason the router is handed a RESOLVED rectangle (rather than
 * `{w, h, rot}`) is that a `rot` decode would otherwise be a drift surface the
 * parity corpus cannot see: the corpus supplies resolved rectangles as data, so a
 * transposed `w`/`h` at a call site would pass every row. This calls the existing
 * `effectiveBox` (`footprint.ts`), whose own header declares itself the SINGLE
 * source of the swap parity, so there is no second `rot & 1` anywhere in the
 * renderer or the gesture layer. `gestures.test.ts` asserts exactly ZERO
 * occurrences of `rot & 1` in the comment-stripped gesture layer.
 */
export function bodyOfNode(n: NodeView): WireBody {
  const { ew, eh } = effectiveBox(n.w, n.h, n.rot);
  return {
    min_x: n.cell_x,
    min_y: n.cell_y,
    max_x: n.cell_x + ew - 1,
    max_y: n.cell_y + eh - 1,
  };
}

/**
 * One electrical terminal anchor pinned by the golden: the nub's world CELL +
 * outward SIDE. The float pixel position is DERIVED from these integers via the
 * shared `nubAnchor` math (Don't-Hand-Roll), so this integer triple is the
 * cross-language parity contract. Mirrors Rust `WireAnchor`.
 */
export interface WireAnchor {
  cell_x: number;
  cell_y: number;
  side: number;
}

/**
 * The frozen wire geometry the cross-language golden pins: the two electrical
 * terminal anchors + the `route()`-normalized orthogonal cell path between them.
 * Mirrors Rust `WireGeometry`.
 */
export interface WireGeometry {
  from_anchor: WireAnchor;
  to_anchor: WireAnchor;
  /**
   * The auto-routed, `route()`-normalized orthogonal cell path connecting the
   * two anchors — wire corners inherit the parity-pinned belt corner geometry.
   */
  tiles: TileView[];
}

/**
 * The result of `wireRoute()` — a discriminated union mirroring `route()`'s, NOT
 * exceptions. A rejected path is an ordinary `{ ok: false }` value (unreachable
 * in practice for a monotone Manhattan path, but kept total rather than throwing
 * so a future non-L auto-route stays honest — mirrors the Rust `Result`).
 */
export type WireRouteResult =
  | { ok: true; geometry: WireGeometry }
  | { ok: false; error: WireRouteError };

/**
 * Why the router refused a dock pair. Mirrors `wire_route.rs::WireRouteError`:
 * `'Coincident'` for two docks on one cell (75-03, D-05), checked before the ladder,
 * or a `RouteError` from the shared normaliser (unreachable by proof). The Rust
 * docblock says why the coincident case is not a `RouteError` variant.
 */
export type WireRouteError = 'Coincident' | RouteError;

function anchorOf(dock: WireDock): WireAnchor {
  return { cell_x: dock.cell[0], cell_y: dock.cell[1], side: dock.side };
}

/**
 * The outward unit vector of a core side byte on the pinned **y-down** axis:
 * `N=0 -> (0,-1)`, `E=1 -> (1,0)`, `S=2 -> (0,1)`, `W=3 -> (-1,0)`.
 *
 * TOTAL over a forged or future byte, which is why the default returns `[0, 0]`
 * rather than throwing: `[0,0]` can equal neither `[sx,0]` nor `[0,sy]` under the
 * non-zero guards in `faceAlignedCells`, so an unknown side degrades to the plain
 * L instead of producing a wrong shape or killing the frame.
 *
 * Mirrors `wire_route.rs::normal`.
 */
function normal(side: number): [number, number] {
  switch (side) {
    case 0:
      return [0, -1];
    case 1:
      return [1, 0];
    case 2:
      return [0, 1];
    case 3:
      return [-1, 0];
    default:
      return [0, 0];
  }
}

/**
 * `+1`, `-1` or `0` toward `b` from `a`.
 *
 * An explicit three-way comparison and NOT `Math.sign`, so this is the same
 * literal expression as `wire_route.rs::step_toward` rather than a same-named
 * builtin in each language. `Math.sign` also returns `-0` for `-0`, which is a
 * value `i32::signum` has no analogue for; the comparison has no such corner.
 */
function stepToward(a: number, b: number): number {
  if (b > a) {
    return 1;
  }
  if (b < a) {
    return -1;
  }
  return 0;
}

/**
 * The lesser of two integers.
 *
 * Written out rather than `Math.min` for the reason `stepToward` is written out:
 * this is then the SAME LITERAL EXPRESSION as `wire_route.rs::lo2` rather than a
 * same-named builtin in each language. `i32::min` and `Math.min` agree today; one
 * shared comparison cannot start disagreeing, two same-named builtins can.
 */
function lo2(a: number, b: number): number {
  return a < b ? a : b;
}

/** The greater of two integers. See `lo2` for why this is not `Math.max`. */
function hi2(a: number, b: number): number {
  return a > b ? a : b;
}

/** Walk `x` to `toX` along the fixed row `y`, pushing each cell AFTER the move. */
function runX(cells: [number, number][], y: number, fromX: number, toX: number): void {
  const s = stepToward(fromX, toX);
  let x = fromX;
  while (x !== toX) {
    x += s;
    cells.push([x, y]);
  }
}

/** Walk `y` to `toY` along the fixed column `x`. See `runX`. */
function runY(cells: [number, number][], x: number, fromY: number, toY: number): void {
  const s = stepToward(fromY, toY);
  let y = fromY;
  while (y !== toY) {
    y += s;
    cells.push([x, y]);
  }
}

/**
 * Where a ray fired from `(x, y)` in unit direction `d` first meets the corridor
 * rectangle's boundary, in closed form. `d` is never `[0, 0]`: `perimeterCells`'s
 * D1 gate has already declined a forged side byte before this is reached.
 * Mirrors `wire_route.rs::ray_hit`.
 */
function rayHit(
  x: number,
  y: number,
  d: [number, number],
  cx0: number,
  cy0: number,
  cx1: number,
  cy1: number,
): [number, number] {
  if (d[0] === 1 && d[1] === 0) return [cx1, y];
  if (d[0] === -1 && d[1] === 0) return [cx0, y];
  if (d[0] === 0 && d[1] === -1) return [x, cy0];
  // [0, 1]. D1 already excluded [0, 0], so this arm is SOUTH and nothing else.
  return [x, cy1];
}

/**
 * The position of a boundary cell of the corridor rectangle along the canonical
 * ring traversal: start at `(cx0, cy0)` and run CLOCKWISE in screen space (y-down)
 * — east along the top, south down the right, west along the bottom, north up the
 * left. Exact inverse of `ringCell` on `0..=l-1`.
 * Mirrors `wire_route.rs::ring_index`.
 */
function ringIndex(
  cx0: number,
  cy0: number,
  cx1: number,
  cy1: number,
  x: number,
  y: number,
): number {
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  if (y === cy0) return x - cx0; // top,    0 ..= w
  if (x === cx1) return w + (y - cy0); // right,  w+1 ..= w+h
  if (y === cy1) return w + h + (cx1 - x); // bottom, w+h+1 ..= 2w+h
  return 2 * w + h + (cy1 - y); // left,   2w+h+1 ..= 2w+2h-1
}

/**
 * The boundary cell at ring position `i`. Exact inverse of `ringIndex` on
 * `0..=l-1`. Mirrors `wire_route.rs::ring_cell`.
 */
function ringCell(
  cx0: number,
  cy0: number,
  cx1: number,
  cy1: number,
  i: number,
): [number, number] {
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  if (i <= w) return [cx0 + i, cy0];
  if (i <= w + h) return [cx1, cy0 + (i - w)];
  if (i <= 2 * w + h) return [cx1 - (i - w - h), cy1];
  return [cx0, cy1 - (i - 2 * w - h)];
}

/**
 * The UNION-BOX PERIMETER RING candidate (72-16), a 1:1 mirror of
 * `wire_route.rs::perimeter_cells`, expression for expression. `null` means "not
 * my shape, hand this pair on" and mirrors the Rust `None`.
 *
 * IT RETURNS `null` AND NEVER THROWS, mirroring the Rust `Option`, for the reason
 * `cableLane.ts`'s header already states: an uncaught exception in a Pixi ticker
 * listener kills the renderer permanently while every model assertion stays green
 * (T-21-06 / T-66-08-01).
 *
 * THE SAFETY ARGUMENT IS THE RUST ONE and is not restated here, because a proof
 * maintained in two places is a proof maintained in neither. Read
 * `crates/fabrico-command/src/wire_route.rs::perimeter_cells` — its two lemmas
 * (interior/ring separation, and S1/S3 disjointness under D2) replace the
 * potential-function argument, which cannot be reused because the ring walk is
 * deliberately non-monotone. What holds THIS copy honest is not the comment but
 * `wire_corpus.expected.json`, whose `cand` column records which candidate won on
 * every row, so a mirror that silently declined where Rust fired is a diff rather
 * than a silence.
 *
 * EXPORTED FOR THAT GATE AND FOR NOTHING ELSE. `wireRoute.test.ts` calls it directly, on
 * every corpus row, to assert it returns non-null on exactly the `cand === 0` rows. Reached
 * only through `wireRoute`, a mirror that silently declined everywhere would be invisible:
 * the fall-through would serve the face-aligned shape, and if the Rust side ever fell
 * through the same way the two would agree on the wrong answer. No renderer or gesture code
 * may call this; they call `wireRoute`.
 */
export function perimeterCells(from: WireDock, to: WireDock): [number, number][] | null {
  const [ax, ay] = from.cell;
  const [bx, by] = to.cell;

  // D0: coincident docks.
  if (ax === bx && ay === by) {
    return null;
  }

  // D1: a forged or future side byte on either end.
  const f = normal(from.side);
  const t = normal(to.side);
  if ((f[0] === 0 && f[1] === 0) || (t[0] === 0 && t[1] === 0)) {
    return null;
  }

  // D2: the four admissibility booleans. THE IDENTICAL FOUR EXPRESSIONS AS
  // `faceAlignedCells` below, character for character. Any one of them true means
  // the ladder can honour at least one face, so the pair is handed on and keeps
  // today's bytes.
  const nt: [number, number] = [-t[0], -t[1]];
  const sx = stepToward(ax, bx);
  const sy = stepToward(ay, by);
  const leaveX = sx !== 0 && f[0] === sx && f[1] === 0;
  const leaveY = sy !== 0 && f[0] === 0 && f[1] === sy;
  const arriveX = sx !== 0 && nt[0] === sx && nt[1] === 0;
  const arriveY = sy !== 0 && nt[0] === 0 && nt[1] === sy;
  if (leaveX || leaveY || arriveX || arriveY) {
    return null;
  }

  // Step 1: the keep-out box K, then the corridor rectangle C = K inflated by one
  // cell. BOTH machine bodies AND BOTH DOCK CELLS are folded in; the dock-cell fold
  // is what makes `A in K` unconditional and what absorbs a forged box with
  // `x0 > x1` with no fifth decline gate.
  const px0 = from.body.min_x;
  const py0 = from.body.min_y;
  const px1 = from.body.max_x;
  const py1 = from.body.max_y;
  const qx0 = to.body.min_x;
  const qy0 = to.body.min_y;
  const qx1 = to.body.max_x;
  const qy1 = to.body.max_y;
  const kx0 = lo2(lo2(px0, px1), lo2(lo2(qx0, qx1), lo2(ax, bx)));
  const kx1 = hi2(hi2(px0, px1), hi2(hi2(qx0, qx1), hi2(ax, bx)));
  const ky0 = lo2(lo2(py0, py1), lo2(lo2(qy0, qy1), lo2(ay, by)));
  const ky1 = hi2(hi2(py0, py1), hi2(hi2(qy0, qy1), hi2(ay, by)));
  const cx0 = kx0 - 1;
  const cy0 = ky0 - 1;
  const cx1 = kx1 + 1;
  const cy1 = ky1 + 1;
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  // w, h >= 2 because C is K inflated on all four sides, so l >= 8.
  const l = 2 * (w + h);

  // Step 2: the two landing cells. Both land STRICTLY INSIDE an edge, never on a
  // corner.
  const p = rayHit(ax, ay, f, cx0, cy0, cx1, cy1);
  const q = rayHit(bx, by, t, cx0, cy0, cx1, cy1);

  // Step 3: ring positions and the shorter direction.
  const i = ringIndex(cx0, cy0, cx1, cy1, p[0], p[1]);
  const j = ringIndex(cx0, cy0, cx1, cy1, q[0], q[1]);
  // BOTH MODULO NUMERATORS ARE PROVABLY IN `[1, 2l-1]` AND NEVER NEGATIVE. `i` and
  // `j` are in `0..=l-1`, so `j - i + l` is in `[1, 2l-1]`; and below, `i - k + l`
  // for `k` in `1..=l-1` is in `[1, 2l-1]` likewise. This is the ONE place Rust `%`
  // and JS `%` could have disagreed (they differ only on a negative dividend) and
  // it is closed BY RANGE rather than by convention.
  const dCw = (j - i + l) % l;

  // Step 4: emit.
  const cells: [number, number][] = [[ax, ay]];
  // S1: A -> P* along f.
  if (f[0] !== 0) {
    runX(cells, ay, ax, p[0]);
  } else {
    runY(cells, ax, ay, p[1]);
  }
  // S2: the ring, the shorter way. An exact tie goes clockwise.
  if (2 * dCw <= l) {
    let k = 1;
    while (k <= dCw) {
      cells.push(ringCell(cx0, cy0, cx1, cy1, (i + k) % l));
      k += 1;
    }
  } else {
    const dCcw = l - dCw;
    let k = 1;
    while (k <= dCcw) {
      cells.push(ringCell(cx0, cy0, cx1, cy1, (i - k + l) % l));
      k += 1;
    }
  }
  // S3: Q* -> B along nt = -t.
  if (t[0] !== 0) {
    runX(cells, by, q[0], bx);
  } else {
    runY(cells, bx, q[1], by);
  }
  return cells;
}

/**
 * The deterministic FACE-ALIGNED cell path from `from` to `to`. A 1:1 mirror of
 * `wire_route.rs::face_aligned_cells`, expression for expression.
 *
 * Leaves along the source port's outward normal and arrives against the target
 * port's outward normal wherever a monotone A->B walk travels that way; falls
 * back per face to the plain X-first L otherwise.
 *
 * THE SAFETY ARGUMENT IS THE RUST ONE and is not restated here, because a proof
 * maintained in two places is a proof maintained in neither. Read
 * `crates/fabrico-command/src/wire_route.rs::face_aligned_cells`. What holds this
 * copy honest is not the comment but `wire_corpus.expected.json`: 784 dock pairs
 * frozen from the Rust side and asserted tile-for-tile by wireRoute.test.ts. The
 * OLD frozen golden pins one dock pair that lands on the plain-L arm and can see
 * neither the Z branch nor the selector, which is why the corpus had to exist
 * before this function could ship.
 */
function faceAlignedCells(from: WireDock, to: WireDock): [number, number][] {
  const [ax, ay] = from.cell;
  const [bx, by] = to.cell;
  const cells: [number, number][] = [[ax, ay]];
  if (ax === bx && ay === by) {
    return cells;
  }

  // The two directions a monotone A -> B walk actually travels.
  const sx = stepToward(ax, bx);
  const sy = stepToward(ay, by);

  const f = normal(from.side); // the direction that LEAVES the source
  const t = normal(to.side);
  const nt: [number, number] = [-t[0], -t[1]]; // the direction that ARRIVES at the target

  // "Admissible" = this face's direction is one the walk travels.
  const leaveX = sx !== 0 && f[0] === sx && f[1] === 0;
  const leaveY = sy !== 0 && f[0] === 0 && f[1] === sy;
  const arriveX = sx !== 0 && nt[0] === sx && nt[1] === 0;
  const arriveY = sy !== 0 && nt[0] === 0 && nt[1] === sy;

  // (1) Both faces admissible ON THE SAME AXIS. One L cannot both start and end on
  //     the same axis, so this needs a Z: three runs, two corners. The turn line is
  //     the TARGET's stub line, one cell outside its port face.
  if (leaveX && arriveX) {
    const turn = bx - sx;
    if (turn !== ax) {
      // turn === ax means |dx| === 1: the machines abut and there is no free column
      // to jog in. Fall through to (2), which keeps the ARRIVAL face.
      runX(cells, ay, ax, turn);
      runY(cells, turn, ay, by);
      runX(cells, by, turn, bx);
      return cells;
    }
  }
  if (leaveY && arriveY) {
    const turn = by - sy;
    if (turn !== ay) {
      runY(cells, ax, ay, turn);
      runX(cells, turn, ax, bx);
      runY(cells, bx, turn, by);
      return cells;
    }
  }

  // (2) Otherwise ONE L, bend order chosen by which face it can serve. ARRIVAL WINS
  //     TIES, deliberately: a wrong departure is ugly, but a wrong ARRIVAL is a lie
  //     about which port the cable is plugged into, and that lie is the reported
  //     defect. The final `true` is the pre-72 behaviour.
  const xFirst = arriveY ? true : arriveX ? false : leaveX ? true : leaveY ? false : true;
  if (xFirst) {
    runX(cells, ay, ax, bx);
    runY(cells, bx, ay, by);
  } else {
    runY(cells, ax, ay, by);
    runX(cells, by, ax, bx);
  }
  return cells;
}

/**
 * THE ONE-FACE GATE (75-01): true exactly when `faceAlignedCells` would honour ONE
 * of the two faces and not the other. A 1:1 mirror of
 * `wire_route.rs::face_aligned_honours_exactly_one_face`, expression for expression:
 * the same four booleans, the two Z room guards and the `xFirst` ladder. The argument
 * for why this equals the emitted shape is the Rust one and is not restated here.
 */
function faceAlignedHonoursExactlyOneFace(from: WireDock, to: WireDock): boolean {
  const [ax, ay] = from.cell;
  const [bx, by] = to.cell;
  if (ax === bx && ay === by) {
    return false;
  }
  const f = normal(from.side);
  const t = normal(to.side);
  if ((f[0] === 0 && f[1] === 0) || (t[0] === 0 && t[1] === 0)) {
    return false;
  }

  // THE IDENTICAL FOUR EXPRESSIONS AS `faceAlignedCells`, character for character.
  const sx = stepToward(ax, bx);
  const sy = stepToward(ay, by);
  const nt: [number, number] = [-t[0], -t[1]];
  const leaveX = sx !== 0 && f[0] === sx && f[1] === 0;
  const leaveY = sy !== 0 && f[0] === 0 && f[1] === sy;
  const arriveX = sx !== 0 && nt[0] === sx && nt[1] === 0;
  const arriveY = sy !== 0 && nt[0] === 0 && nt[1] === sy;

  // The ring's class: the face-aligned shape honours neither face.
  if (!leaveX && !leaveY && !arriveX && !arriveY) {
    return false;
  }
  // The two Z branches, with their room guards: a Z that fires honours both faces.
  if (leaveX && arriveX && bx - sx !== ax) {
    return false;
  }
  if (leaveY && arriveY && by - sy !== ay) {
    return false;
  }

  const xFirst = arriveY ? true : arriveX ? false : leaveX ? true : leaveY ? false : true;
  const honoursBoth = xFirst
    ? (leaveX || (sx === 0 && leaveY)) && (arriveY || (sy === 0 && arriveX))
    : (leaveY || (sy === 0 && leaveX)) && (arriveX || (sx === 0 && arriveY));
  return !honoursBoth;
}

/** An inclusive rectangle `[x0, y0, x1, y1]` with `x0 <= x1`, `y0 <= y1`. */
export type Box = [number, number, number, number];

/** A body normalised the way the ring's Step 1 folds a forged box. Mirrors `norm_body`. */
function normBody(b: WireBody): Box {
  return [lo2(b.min_x, b.max_x), lo2(b.min_y, b.max_y), hi2(b.min_x, b.max_x), hi2(b.min_y, b.max_y)];
}

/** Both bodies and both dock cells. Mirrors `go_around_blocks`. */
function goAroundBlocks(from: WireDock, to: WireDock): Box[] {
  const [ax, ay] = from.cell;
  const [bx, by] = to.cell;
  return [normBody(from.body), normBody(to.body), [ax, ay, ax, ay], [bx, by, bx, by]];
}

/** Whether the closed box `(x0, y0)..(x1, y1)` touches any block. Mirrors `box_blocked`. */
function boxBlocked(blocks: Box[], x0: number, y0: number, x1: number, y1: number): boolean {
  for (const [rx0, ry0, rx1, ry1] of blocks) {
    if (x0 <= rx1 && x1 >= rx0 && y0 <= ry1 && y1 >= ry0) {
      return true;
    }
  }
  return false;
}

/** Ascending, deduplicated. */
function sortedUnique(v: number[]): number[] {
  const s = [...v].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) {
    if (out.length === 0 || out[out.length - 1] !== x) {
      out.push(x);
    }
  }
  return out;
}

/**
 * The compressed line set: on each axis every start's and every finish's coordinate
 * plus the lines one cell outside each body (at most six per axis for the go-around,
 * ten for candidate 4). Mirrors `go_around_lines`.
 */
function goAroundLines(
  from: WireDock,
  to: WireDock,
  starts: SearchEnd[],
  finishes: SearchEnd[],
): [number[], number[]] {
  const [px0, py0, px1, py1] = normBody(from.body);
  const [qx0, qy0, qx1, qy1] = normBody(to.body);
  const xs = [px0 - 1, px1 + 1, qx0 - 1, qx1 + 1];
  const ys = [py0 - 1, py1 + 1, qy0 - 1, qy1 + 1];
  for (const e of [...starts, ...finishes]) {
    xs.push(e.cell[0]);
    ys.push(e.cell[1]);
  }
  return [sortedUnique(xs), sortedUnique(ys)];
}

/** The side index of a unit step (`N=0, E=1, S=2, W=3`), or -1. Mirrors `heading_of`. */
function headingOf(v: [number, number]): number {
  if (v[0] === 0 && v[1] === -1) return 0;
  if (v[0] === 1 && v[1] === 0) return 1;
  if (v[0] === 0 && v[1] === 1) return 2;
  if (v[0] === -1 && v[1] === 0) return 3;
  return -1;
}

/** A search cost `(length, arrival missed, bends)`, compared lexicographically. */
type Cost = [number, number, number];

/** Lexicographic compare of two equal-length tuples: `a` strictly before `b`. */
function costLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Equal tuples. */
function costEq(a: readonly number[], b: readonly number[]): boolean {
  return !costLess(a, b) && !costLess(b, a);
}

/** One queue entry: cost, node, heading. */
type QEntry = { c: Cost; n: number; h: number };

/** `a` pops before `b`: cost, then node, then heading (the Rust tuple order). */
function entryLess(a: QEntry, b: QEntry): boolean {
  if (!costEq(a.c, b.c)) return costLess(a.c, b.c);
  if (a.n !== b.n) return a.n < b.n;
  return a.h < b.h;
}

/**
 * A minimal binary min-heap for the go-around search. Its tie order need not match
 * Rust's `BinaryHeap`: the cost-to-go table it fills is unique whatever order ties pop
 * in, and the forward walk reads only that table, so the cells cannot depend on it
 * (the parity corpus is what proves it, row by row).
 */
class MinHeap {
  private a: QEntry[] = [];
  push(e: QEntry): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!entryLess(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): QEntry | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as QEntry;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && entryLess(a[l], a[m])) m = l;
        if (r < a.length && entryLess(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * One end of `searchBetweenEnds`: a cell next to a dock, the unit step between the dock
 * and it along the cable, and whether that step misses the port's face. Mirrors
 * `wire_route.rs::SearchEnd`.
 */
export interface SearchEnd {
  cell: [number, number];
  dir: [number, number];
  missed: boolean;
}

/**
 * THE GO-AROUND SEARCH (75-01), a thin entry over `searchBetweenEnds` with one start,
 * one finish and no penalties. Mirrors `wire_route.rs::go_around_search`.
 */
function goAroundSearch(
  from: WireDock,
  to: WireDock,
  start: [number, number],
  first: [number, number],
  finish: [number, number],
  last: [number, number],
): [number, number][] | null {
  return searchBetweenEnds(
    from,
    to,
    [{ cell: start, dir: first, missed: false }],
    [{ cell: finish, dir: last, missed: false }],
  );
}

/**
 * THE ONE SEARCH ROUTINE (75-01, generalised at 75-03), a 1:1 mirror of
 * `wire_route.rs::search_between_ends`: the walk from one of `starts` to one of
 * `finishes` that keeps every cell outside both bodies and off both docks, least
 * `(length, arrival missed, departure missed, bends)` first, or `null`. Backward
 * Dijkstra from every free finish over the compressed line set, the first start in the
 * order given whose total is least, then the canonical forward walk (straight, N, E, S,
 * W). The validity and bound arguments are the Rust ones and are not restated here.
 * Returns `null` and never throws (a throw in a Pixi ticker listener kills the
 * renderer).
 */
function searchBetweenEnds(
  from: WireDock,
  to: WireDock,
  startsIn: SearchEnd[],
  finishesIn: SearchEnd[],
): [number, number][] | null {
  const blocks = goAroundBlocks(from, to);
  const starts = freeEnds(blocks, startsIn);
  const finishes = freeEnds(blocks, finishesIn);
  if (starts.length === 0 || finishes.length === 0) {
    return null;
  }
  const [xs, ys] = goAroundLines(from, to, starts, finishes);
  return searchOnLines(blocks, xs, ys, starts, finishes);
}

/**
 * The ends a search may use: a unit-step `dir` and a cell outside every block, in the order
 * given. Mirrors `wire_route.rs::free_ends`.
 */
function freeEnds(blocks: Box[], ends: SearchEnd[]): SearchEnd[] {
  return ends.filter(
    (e) => headingOf(e.dir) >= 0 && !boxBlocked(blocks, e.cell[0], e.cell[1], e.cell[0], e.cell[1]),
  );
}

/**
 * The node index of cell `c` on the line set `xs` by `ys`, or -1 when either coordinate is
 * not a line. TOTAL (todo `2026-10-06-wireroute-ts-nodeof-not-total.md`, phase 92): the bare
 * `ys.indexOf(y) * nx + xs.indexOf(x)` it replaced turned a miss on one axis into a VALID
 * index of another node (a missing x on row 1 read as the last node of row 0), so a search
 * handed an end off the line set would have walked from the wrong place instead of finding
 * no path. Mirrors the Rust `node_of` closure, whose `binary_search(..).ok()?` is total.
 * Exported for `wireRoute.test.ts`.
 */
export function nodeIndexOf(xs: readonly number[], ys: readonly number[], c: [number, number]): number {
  const xi = xs.indexOf(c[0]);
  const yi = ys.indexOf(c[1]);
  return xi < 0 || yi < 0 ? -1 : yi * xs.length + xi;
}

/** The first index whose value is at least `t` in the ascending `v`. */
function lowerBound(v: readonly number[], t: number): number {
  let lo = 0;
  let hi = v.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (v[m] < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** The first index whose value is above `t` in the ascending `v`. */
function upperBound(v: readonly number[], t: number): number {
  let lo = 0;
  let hi = v.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (v[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * A `w` by `h` table, 1 where any of `rects` (`[i0, i1, j0, j1]`, half-open) lies, through a
 * two-dimensional difference array.
 */
function coverTable(w: number, h: number, rects: [number, number, number, number][]): Uint8Array {
  const diff = new Int32Array((w + 1) * (h + 1));
  for (const [i0, i1, j0, j1] of rects) {
    if (i0 < i1 && j0 < j1) {
      diff[j0 * (w + 1) + i0] += 1;
      diff[j0 * (w + 1) + i1] -= 1;
      diff[j1 * (w + 1) + i0] -= 1;
      diff[j1 * (w + 1) + i1] += 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const up = j > 0 ? diff[(j - 1) * (w + 1) + i] : 0;
      const left = i > 0 ? diff[j * (w + 1) + i - 1] : 0;
      const corner = i > 0 && j > 0 ? diff[(j - 1) * (w + 1) + i - 1] : 0;
      diff[j * (w + 1) + i] += up + left - corner;
      out[j * w + i] = diff[j * (w + 1) + i] > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Which segments of the line set touch a block: `[row, col]`, `row[j * (nx - 1) + i]` for the
 * segment from `(xs[i], ys[j])` to `(xs[i + 1], ys[j])`, `col[j * nx + i]` for the one from
 * `(xs[i], ys[j])` to `(xs[i], ys[j + 1])`, each exactly `boxBlocked` for its segment. Mirrors
 * `wire_route.rs::edge_tables`, whose docblock carries the argument.
 */
function edgeTables(blocks: Box[], xs: readonly number[], ys: readonly number[]): [Uint8Array, Uint8Array] {
  const nx = xs.length;
  const ny = ys.length;
  const row = coverTable(
    Math.max(nx - 1, 0),
    ny,
    blocks.map(([rx0, ry0, rx1, ry1]) => [
      Math.max(lowerBound(xs, rx0) - 1, 0),
      Math.min(upperBound(xs, rx1), Math.max(nx - 1, 0)),
      lowerBound(ys, ry0),
      upperBound(ys, ry1),
    ]),
  );
  const col = coverTable(
    nx,
    Math.max(ny - 1, 0),
    blocks.map(([rx0, ry0, rx1, ry1]) => [
      lowerBound(xs, rx0),
      upperBound(xs, rx1),
      Math.max(lowerBound(ys, ry0) - 1, 0),
      Math.min(upperBound(ys, ry1), Math.max(ny - 1, 0)),
    ]),
  );
  return [row, col];
}

/**
 * The body of `searchBetweenEnds`, split out at phase 92 so the obstacle stage drives the
 * same routine with a wider blocked set and line set. Mirrors
 * `wire_route.rs::search_on_lines`. `xs` and `ys` are ascending and deduplicated; `starts`
 * and `finishes` are already free and on the line set (an end that is not is no node, so no
 * path). Returns `null` and never throws. Exported for `wireRoute.test.ts`.
 */
export function searchOnLines(
  blocks: Box[],
  xs: number[],
  ys: number[],
  starts: SearchEnd[],
  finishes: SearchEnd[],
): [number, number][] | null {
  const nx = xs.length;
  const ny = ys.length;
  const nodeOf = (c: [number, number]): number => nodeIndexOf(xs, ys, c);
  const [rowBlocked, colBlocked] = edgeTables(blocks, xs, ys);

  // One table read per segment, the answer `boxBlocked` gives for it (see `edgeTables`).
  const next = (n: number, h: number): [number, number] | null => {
    const xi = n % nx;
    const yi = (n - xi) / nx;
    let mx: number;
    let my: number;
    let blocked: number;
    if (h === 0 && yi > 0) {
      mx = xi;
      my = yi - 1;
      blocked = colBlocked[(yi - 1) * nx + xi];
    } else if (h === 1 && xi + 1 < nx) {
      mx = xi + 1;
      my = yi;
      blocked = rowBlocked[yi * (nx - 1) + xi];
    } else if (h === 2 && yi + 1 < ny) {
      mx = xi;
      my = yi + 1;
      blocked = colBlocked[yi * nx + xi];
    } else if (h === 3 && xi > 0) {
      mx = xi - 1;
      my = yi;
      blocked = rowBlocked[yi * (nx - 1) + xi - 1];
    } else {
      return null;
    }
    if (blocked !== 0) {
      return null;
    }
    const x0 = lo2(xs[xi], xs[mx]);
    const x1 = hi2(xs[xi], xs[mx]);
    const y0 = lo2(ys[yi], ys[my]);
    const y1 = hi2(ys[yi], ys[my]);
    return [my * nx + mx, x1 - x0 + (y1 - y0)];
  };
  const bend = (h: number, d: number): number => (h !== d ? 1 : 0);

  const cost: (Cost | null)[] = new Array(nx * ny * 4).fill(null);
  const heap = new MinHeap();
  for (const e of finishes) {
    const fin = nodeOf(e.cell);
    if (fin < 0) {
      // An end off the line set is no node, so there is no path (the Rust `node_of(..)?`).
      return null;
    }
    const hLast = headingOf(e.dir);
    for (let h = 0; h < 4; h++) {
      const c: Cost = [0, e.missed ? 1 : 0, bend(h, hLast)];
      const old = cost[fin * 4 + h];
      if (old === null || costLess(c, old)) {
        cost[fin * 4 + h] = c;
        heap.push({ c, n: fin, h });
      }
    }
  }
  for (let e = heap.pop(); e !== undefined; e = heap.pop()) {
    const cur = cost[e.n * 4 + e.h];
    if (cur === null || !costEq(cur, e.c)) {
      continue;
    }
    const p = next(e.n, (e.h + 2) % 4);
    if (p === null) {
      continue;
    }
    for (let h = 0; h < 4; h++) {
      const nc: Cost = [e.c[0] + p[1], e.c[1], e.c[2] + bend(h, e.h)];
      const old = cost[p[0] * 4 + h];
      if (old === null || costLess(nc, old)) {
        cost[p[0] * 4 + h] = nc;
        heap.push({ c: nc, n: p[0], h });
      }
    }
  }

  // The start: the first, in the order given, whose total (length, arrival missed,
  // departure missed, bends) is the least.
  const total = (e: SearchEnd): number[] | null => {
    const n = nodeOf(e.cell);
    if (n < 0) {
      return null;
    }
    const c = cost[n * 4 + headingOf(e.dir)] ?? null;
    return c === null ? null : [c[0], c[1], e.missed ? 1 : 0, c[2]];
  };
  let start: SearchEnd | null = null;
  let best: number[] | null = null;
  for (const e of starts) {
    const t = total(e);
    if (t !== null && (best === null || costLess(t, best))) {
      best = t;
      start = e;
    }
  }
  if (start === null) {
    return null;
  }

  let cur = nodeOf(start.cell);
  if (cur < 0) {
    return null;
  }
  let h = headingOf(start.dir);
  let c = cost[cur * 4 + h] ?? null;
  if (c === null) {
    return null;
  }
  const cells: [number, number][] = [[start.cell[0], start.cell[1]]];
  while (c[0] !== 0) {
    let moved = false;
    for (const d of [h, 0, 1, 2, 3]) {
      const q = next(cur, d);
      if (q === null) {
        continue;
      }
      const qc: Cost | null = cost[q[0] * 4 + d];
      if (qc === null) {
        continue;
      }
      if (q[1] + qc[0] === c[0] && qc[1] === c[1] && bend(h, d) + qc[2] === c[2]) {
        const cx = xs[cur % nx];
        const cy = ys[(cur - (cur % nx)) / nx];
        const qx = xs[q[0] % nx];
        const qy = ys[(q[0] - (q[0] % nx)) / nx];
        if (cy === qy) {
          runX(cells, cy, cx, qx);
        } else {
          runY(cells, cx, cy, qy);
        }
        cur = q[0];
        h = d;
        c = qc;
        moved = true;
        break;
      }
    }
    if (!moved) {
      // Unreachable: `c` is a table entry, so some move or a finish achieves it.
      return null;
    }
  }
  return cells;
}

/**
 * The go-around candidate's cells, `[A] ++ walk ++ [B]`, or `null` when the one-face
 * gate does not fire or the search declines. Mirrors `go_around_cells`.
 */
function goAroundCells(from: WireDock, to: WireDock): [number, number][] | null {
  if (!faceAlignedHonoursExactlyOneFace(from, to)) {
    return null;
  }
  const [ax, ay] = from.cell;
  const [bx, by] = to.cell;
  const f = normal(from.side);
  const t = normal(to.side);
  const walk = goAroundSearch(from, to, [ax + f[0], ay + f[1]], f, [bx + t[0], by + t[1]], [-t[0], -t[1]]);
  if (walk === null) {
    return null;
  }
  return [[ax, ay], ...walk, [bx, by]];
}

/**
 * Every orthogonal neighbour of `dock` as a `SearchEnd`, the face-honouring one first,
 * then N, E, S, W. `outward` at the source (dock to neighbour), not at the target.
 * Mirrors `wire_route.rs::dock_neighbours`.
 */
function dockNeighbours(dock: WireDock, outward: boolean): SearchEnd[] {
  const n = normal(dock.side);
  const out: SearchEnd[] = [];
  for (const side of [dock.side, 0, 1, 2, 3]) {
    const d = normal(side);
    if (d[0] === 0 && d[1] === 0) continue;
    const cell: [number, number] = [dock.cell[0] + d[0], dock.cell[1] + d[1]];
    if (out.some((e) => e.cell[0] === cell[0] && e.cell[1] === cell[1])) continue;
    out.push({
      cell,
      dir: outward ? d : [0 - d[0], 0 - d[1]],
      missed: d[0] !== n[0] || d[1] !== n[1],
    });
  }
  return out;
}

/**
 * Candidate 4's cells WITHOUT its gate: the shortest connection from any free neighbour
 * of the source dock to any free neighbour of the target dock crossing neither machine,
 * or `null`. Mirrors `wire_route.rs::clear_of_bodies_search`.
 */
function clearOfBodiesSearch(from: WireDock, to: WireDock): [number, number][] | null {
  if (from.cell[0] === to.cell[0] && from.cell[1] === to.cell[1]) {
    return null;
  }
  const walk = searchBetweenEnds(from, to, dockNeighbours(from, true), dockNeighbours(to, false));
  if (walk === null) {
    return null;
  }
  return [[from.cell[0], from.cell[1]], ...walk, [to.cell[0], to.cell[1]]];
}

/**
 * Candidate 4's gate and cells (75-03, D-04): the one-face gate holds, the docks do not
 * touch, and a stub cell lies inside the OTHER machine's body off its dock. Mirrors
 * `wire_route.rs::clear_of_bodies_cells`; why it fires and where it declines is written
 * on the Rust `CAND_CLEAR_OF_BODIES`.
 */
function clearOfBodiesCells(from: WireDock, to: WireDock): [number, number][] | null {
  if (!faceAlignedHonoursExactlyOneFace(from, to)) {
    return null;
  }
  const [ax, ay] = from.cell;
  const [bx, by] = to.cell;
  if (Math.abs(ax - bx) + Math.abs(ay - by) === 1) {
    return null;
  }
  const inside = (c: [number, number], b: WireBody): boolean => {
    const [x0, y0, x1, y1] = normBody(b);
    return c[0] >= x0 && c[0] <= x1 && c[1] >= y0 && c[1] <= y1;
  };
  const f = normal(from.side);
  const t = normal(to.side);
  const a1: [number, number] = [ax + f[0], ay + f[1]];
  const b1: [number, number] = [bx + t[0], by + t[1]];
  const facesInto =
    (inside(a1, to.body) && !(a1[0] === bx && a1[1] === by)) ||
    (inside(b1, from.body) && !(b1[0] === ax && b1[1] === ay));
  if (!facesInto) {
    return null;
  }
  return clearOfBodiesSearch(from, to);
}

/**
 * The deterministic single-L (X-first) Manhattan cell path from `from` to `to`.
 *
 * KEPT as `wireRoute`'s unconditional LAST CANDIDATE, and as the per-face
 * fallback inside `faceAlignedCells`. It was the whole router from Phase 40 to
 * Phase 72. Mirrors `wire_route.rs::manhattan_l`.
 */
function manhattanL(from: [number, number], to: [number, number]): [number, number][] {
  const [fx, fy] = from;
  const [tx, ty] = to;
  const cells: [number, number][] = [[fx, fy]];
  // Horizontal leg: fx -> tx along y = fy.
  let x = fx;
  while (x !== tx) {
    x += Math.sign(tx - x);
    cells.push([x, fy]);
  }
  // Vertical leg: fy -> ty along x = tx.
  let y = fy;
  while (y !== ty) {
    y += Math.sign(ty - y);
    cells.push([tx, y]);
  }
  return cells;
}

/**
 * Auto-route an electrical wire between two resolved endpoint terminals,
 * normalized through the belt `route()` so wire corners inherit proven parity.
 * PURE + deterministic + integer-only (no float, no RNG, no clock). A 1:1 mirror
 * of the Rust `wire_route`, pinned to the frozen golden in wireRoute.test.ts.
 */
export function wireRoute(from: WireDock, to: WireDock): WireRouteResult {
  const r = wireRouteTraced(from, to);
  return r.ok ? { ok: true, geometry: r.geometry } : r;
}

/** The perimeter ring won. Mirrors `wire_route.rs::CAND_PERIMETER`. */
export const CAND_PERIMETER = 0;
/** The face-aligned L/Z won. Mirrors `CAND_FACE_ALIGNED`. */
export const CAND_FACE_ALIGNED = 1;
/** The plain Manhattan L won, unreachable by proof. Mirrors `CAND_MANHATTAN`. */
export const CAND_MANHATTAN = 2;
/** The go-around won (75-01). Mirrors `CAND_GO_AROUND`. */
export const CAND_GO_AROUND = 3;
/**
 * Clear of bodies won (75-03, D-04): a port facing into the neighbour's body, drawn as
 * the shortest connection crossing neither machine. Mirrors `CAND_CLEAR_OF_BODIES`.
 */
export const CAND_CLEAR_OF_BODIES = 4;
/**
 * NO candidate won: what a corpus row records in `cand` when the router refused the
 * pair (75-03, the coincident rows). Never returned by `wireRouteTraced`. Mirrors
 * `wire_route.rs::CAND_NONE`.
 */
export const CAND_NONE = 255;

/** `wireRoute`'s result plus WHICH candidate drew the geometry. */
export type WireRouteTracedResult =
  | { ok: true; geometry: WireGeometry; cand: number }
  | { ok: false; error: WireRouteError };

/**
 * `wireRoute`, plus which candidate produced the geometry. A 1:1 mirror of
 * `wire_route.rs::wire_route_traced`. It exists so the TS ladder is written once and
 * `wireRoute.test.ts` can pin the candidate on every corpus row against the Rust `cand`
 * column: a ladder that served the right tiles from the wrong arm is otherwise invisible.
 */
export function wireRouteTraced(from: WireDock, to: WireDock): WireRouteTracedResult {
  // THE COINCIDENT CHECK COMES FIRST (75-03, D-05), as in the Rust original: a one-cell
  // path plugs into nothing. `ghostLeg` returns null on `!ok`, so the free drag over the
  // source's own cell still draws no corridor (UI-SPEC 2.3; the one-cell path it got
  // before this also drew nothing, `overlay.ts` bails below two points).
  if (from.cell[0] === to.cell[0] && from.cell[1] === to.cell[1]) {
    return { ok: false, error: 'Coincident' };
  }
  // FIVE CANDIDATES, and `route()` is the ONLY judge of any of them. No second
  // distinctness or adjacency predicate exists here or in the Rust original.
  const ring = perimeterCells(from, to);
  if (ring !== null) {
    // THIS BRANCH SWALLOWS THE REJECTION, exactly as the Rust `if let Ok` does, and
    // the only thing that can see it is G1 in `wireRoute.test.ts` / `wire_corpus.rs`:
    // the `cand` column frozen into the corpus records WHICH candidate won, so a
    // silent fall-through is a diff instead of a silence. Read this as safe and you
    // will be wrong.
    const rr = route(ring);
    if (rr.ok) {
      return {
        ok: true,
        geometry: {
          from_anchor: anchorOf(from),
          to_anchor: anchorOf(to),
          tiles: rr.tiles,
        },
        cand: CAND_PERIMETER,
      };
    }
  }
  // The go-around (75-01). This branch swallows a rejection exactly as the ring's
  // does; the `cand` column and the candidate-equality test are what see it.
  const around = goAroundCells(from, to);
  if (around !== null) {
    const rr = route(around);
    if (rr.ok) {
      return {
        ok: true,
        geometry: {
          from_anchor: anchorOf(from),
          to_anchor: anchorOf(to),
          tiles: rr.tiles,
        },
        cand: CAND_GO_AROUND,
      };
    }
  }
  // Candidate 4 (75-03). Swallows a rejection like the two arms above; the `cand`
  // column and the candidate-equality test see it.
  const clear = clearOfBodiesCells(from, to);
  if (clear !== null) {
    const rr = route(clear);
    if (rr.ok) {
      return {
        ok: true,
        geometry: {
          from_anchor: anchorOf(from),
          to_anchor: anchorOf(to),
          tiles: rr.tiles,
        },
        cand: CAND_CLEAR_OF_BODIES,
      };
    }
  }
  // THE `manhattanL` ARM IS UNREACHABLE TODAY, BY PROOF (see the Rust
  // `face_aligned_cells` docblock), and is deliberately counted as coverage
  // nowhere. It is kept so a future shape can be slotted in as a new FIRST
  // candidate carrying no new proof obligation — which is exactly what
  // `perimeterCells` above just did.
  let r = route(faceAlignedCells(from, to));
  let cand = CAND_FACE_ALIGNED;
  if (!r.ok) {
    r = route(manhattanL(from.cell, to.cell));
    cand = CAND_MANHATTAN;
  }
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  return {
    ok: true,
    geometry: {
      from_anchor: anchorOf(from),
      to_anchor: anchorOf(to),
      tiles: r.tiles,
    },
    cand,
  };
}

// ---------------------------------------------------------------------------------------
// THE OBSTACLE STAGE (phase 92, D-09, CHROME-19). A 1:1 mirror of the Rust stage in
// `wire_route.rs` (`wire_route_avoiding_traced` and the functions above it), decision for
// decision: the same endpoint filter, sort and dedup, the same closed window (the same
// four-sweep fixed point), the same lines and line guard, the same node cap, the same
// relaxed search, the same crowded cell walk, the same exception and the same candidates.
// The steps, the soundness argument and the exception are written once, in the Rust module
// docblock, and not restated here. `wireRoute` and `wireRouteTraced` above are unchanged:
// they are the ladder this stage runs first.
// ---------------------------------------------------------------------------------------

/**
 * The obstacle stage won: the ladder's path entered a third machine and the stage drew the
 * shortest cable around every machine in its window. Mirrors
 * `wire_route.rs::CAND_AROUND_MACHINES`.
 */
export const CAND_AROUND_MACHINES = 5;

/**
 * The crowded window won: the window's line set held more than `MAX_AROUND_NODES` nodes and
 * the stage walked the cable cell by cell round every machine in it. Mirrors
 * `wire_route.rs::CAND_AROUND_CROWDED`.
 */
export const CAND_AROUND_CROWDED = 6;

/**
 * The most nodes (`xs.length * ys.length`) the line search runs on; a larger window is walked
 * cell by cell, never left to cross a machine. Mirrors `wire_route.rs::MAX_AROUND_NODES`,
 * locked by `crates/fabrico-command/tests/ts_wire_obstacle_mirror.rs`.
 */
export const MAX_AROUND_NODES = 2048;

/**
 * The most cells the crowded walk holds (the window inflated by one). Mirrors
 * `wire_route.rs::MAX_CROWDED_CELLS`, locked by `ts_wire_obstacle_mirror.rs`.
 */
export const MAX_CROWDED_CELLS = 2097152;

/**
 * The bounds the stage clamps its extra lines to: the grid (`GRID_MIN` and `GRID_MAX` in
 * `crates/fabrico-command/src/command.rs`, -512 and 512) widened by `WIRE_LINE_GUARD` (128),
 * an overflow guard no buildable board reaches. Mirrors `wire_route.rs::clamped_line`; locked
 * by `crates/fabrico-command/tests/ts_wire_obstacle_mirror.rs`.
 */
const WIRE_LINE_MIN = -640;
const WIRE_LINE_MAX = 640;

/**
 * The kinds a cable may cross: a belt, a wire and a label. Every other kind byte, a forged
 * or future one included, is in the way. Mirrors `wire_route.rs::is_wire_obstacle`, locked
 * over every kind byte by `crates/fabrico-command/tests/ts_wire_obstacle_mirror.rs`.
 */
const WIRE_CROSSABLE_KINDS: readonly number[] = [machine_kind.BELT, machine_kind.WIRE, machine_kind.LABEL];

/**
 * Whether a node of kind byte `kind` is in a cable's way. THE ONE RULE IN THIS LANGUAGE:
 * the drag preview's machine list reads it. Mirrors `wire_route.rs::is_wire_obstacle`.
 */
export function isWireObstacle(kind: number): boolean {
  return !WIRE_CROSSABLE_KINDS.includes(kind);
}

/** `a` sorts before `b` by `(x0, y0, x1, y1)`; the Rust tuple order. */
function boxCompare(a: Box, b: Box): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The obstacles between `from` and `to`: each rectangle normalised, every one holding either
 * dock cell dropped, sorted and deduplicated. No hashing. Mirrors `wire_route.rs::obstacles_of`.
 */
function obstaclesOf(from: WireDock, to: WireDock, machines: readonly WireBody[]): Box[] {
  const holds = (b: Box, c: [number, number]): boolean =>
    c[0] >= b[0] && c[0] <= b[2] && c[1] >= b[1] && c[1] <= b[3];
  const sorted = machines
    .map((m) => normBody(m))
    .filter((b) => !holds(b, from.cell) && !holds(b, to.cell))
    .sort(boxCompare);
  const out: Box[] = [];
  for (const b of sorted) {
    if (out.length === 0 || boxCompare(out[out.length - 1], b) !== 0) {
      out.push(b);
    }
  }
  return out;
}

/** The closed window and the obstacles inside it. Mirrors `wire_route.rs::AroundWindow`. */
interface AroundWindow {
  frame: Box;
  obstacles: Box[];
}

/**
 * The closed window over `obstacles` (already filtered): the four-sweep least fixed point.
 * Mirrors `wire_route.rs::window_of`, whose docblock carries the argument.
 */
function windowOf(from: WireDock, to: WireDock, obstacles: Box[]): AroundWindow {
  const [px0, py0, px1, py1] = normBody(from.body);
  const [qx0, qy0, qx1, qy1] = normBody(to.body);
  const [ax, ay] = from.cell;
  const [bx, by] = to.cell;
  let w: Box = [
    lo2(lo2(px0, qx0), lo2(ax, bx)),
    lo2(lo2(py0, qy0), lo2(ay, by)),
    hi2(hi2(px1, qx1), hi2(ax, bx)),
    hi2(hi2(py1, qy1), hi2(ay, by)),
  ];
  const n = obstacles.length;
  const sweep = (key: (o: Box) => number): number[] => {
    const order = obstacles.map((_, i) => i);
    order.sort((a, b) => key(obstacles[a]) - key(obstacles[b]) || a - b);
    return order;
  };
  // Ascending min_x, descending max_x, ascending min_y, descending max_y.
  const sweeps = [sweep((o) => o[0]), sweep((o) => -o[2]), sweep((o) => o[1]), sweep((o) => -o[3])];
  const at = [0, 0, 0, 0];
  const count = new Uint8Array(n);
  const joined = new Uint8Array(n);
  for (;;) {
    const ix0 = w[0] - 1;
    const iy0 = w[1] - 1;
    const ix1 = w[2] + 1;
    const iy1 = w[3] + 1;
    const holds = (s: number, o: Box): boolean =>
      s === 0 ? o[0] <= ix1 : s === 1 ? o[2] >= ix0 : s === 2 ? o[1] <= iy1 : o[3] >= iy0;
    const fresh: number[] = [];
    for (let s = 0; s < 4; s++) {
      const order = sweeps[s];
      while (at[s] < n && holds(s, obstacles[order[at[s]]])) {
        const i = order[at[s]];
        at[s] += 1;
        count[i] += 1;
        if (count[i] === 4) fresh.push(i);
      }
    }
    if (fresh.length === 0) break;
    for (const i of fresh) {
      const o = obstacles[i];
      joined[i] = 1;
      w = [lo2(w[0], o[0]), lo2(w[1], o[1]), hi2(w[2], o[2]), hi2(w[3], o[3])];
    }
  }
  return { frame: w, obstacles: obstacles.filter((_, i) => joined[i] === 1) };
}

/** A line one cell outside a rectangle edge, clamped to the line guard. Mirrors `clamped_line`. */
function clampedLine(v: number, d: number): number {
  const l = d < 0 ? v - 1 : v + 1;
  return l < WIRE_LINE_MIN ? WIRE_LINE_MIN : l > WIRE_LINE_MAX ? WIRE_LINE_MAX : l;
}

/** Everything the around-machines search runs on. Mirrors `wire_route.rs::AroundSetup`. */
interface AroundSetup {
  blocks: Box[];
  starts: SearchEnd[];
  finishes: SearchEnd[];
  xs: number[];
  ys: number[];
}

/** Mirrors `wire_route.rs::around_setup`. */
function aroundSetup(from: WireDock, to: WireDock, window: AroundWindow): AroundSetup {
  const blocks: Box[] = [...goAroundBlocks(from, to), ...window.obstacles];
  const starts = freeEnds(blocks, dockNeighbours(from, true));
  const finishes = freeEnds(blocks, dockNeighbours(to, false));
  const [xs0, ys0] = goAroundLines(from, to, starts, finishes);
  const xs = [...xs0];
  const ys = [...ys0];
  for (const o of window.obstacles) {
    xs.push(clampedLine(o[0], -1), clampedLine(o[2], 1));
    ys.push(clampedLine(o[1], -1), clampedLine(o[3], 1));
  }
  return { blocks, starts, finishes, xs: sortedUnique(xs), ys: sortedUnique(ys) };
}

/**
 * The crowded walk `start ..= finish` over single cells inside the window inflated by one, or
 * `null`. Mirrors `wire_route.rs::crowded_walk`, whose docblock carries the argument.
 */
function crowdedWalk(window: AroundWindow, setup: AroundSetup): [number, number][] | null {
  const [fx0, fy0, fx1, fy1] = window.frame;
  const x0 = fx0 - 1;
  const y0 = fy0 - 1;
  const x1 = fx1 + 1;
  const y1 = fy1 + 1;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w * h > MAX_CROWDED_CELLS) {
    return null;
  }
  const index = (c: [number, number]): number =>
    c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1 ? -1 : (c[1] - y0) * w + (c[0] - x0);

  const rects: [number, number, number, number][] = [];
  for (const [bx0, by0, bx1, by1] of setup.blocks) {
    const cx0 = hi2(bx0, x0);
    const cy0 = hi2(by0, y0);
    const cx1 = lo2(bx1, x1);
    const cy1 = lo2(by1, y1);
    if (cx0 <= cx1 && cy0 <= cy1) rects.push([cx0 - x0, cx1 - x0 + 1, cy0 - y0, cy1 - y0 + 1]);
  }
  const blocked = coverTable(w, h, rects);

  const step = (i: number, d: number): number => {
    const cx = i % w;
    const cy = (i - cx) / w;
    if (d === 0) return cy > 0 ? i - w : -1;
    if (d === 1) return cx + 1 < w ? i + 1 : -1;
    if (d === 2) return cy + 1 < h ? i + w : -1;
    return cx > 0 ? i - 1 : -1;
  };

  const len = new Int32Array(w * h).fill(-1);
  const arr = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  for (const e of setup.finishes) {
    const i = index(e.cell);
    if (i < 0) return null;
    len[i] = 0;
    arr[i] = e.missed ? 1 : 0;
    queue[tail++] = i;
  }
  for (let head = 0; head < tail; head++) {
    const c = queue[head];
    for (let d = 0; d < 4; d++) {
      const q = step(c, d);
      if (q < 0 || blocked[q] === 1) continue;
      if (len[q] < 0) {
        len[q] = len[c] + 1;
        arr[q] = arr[c];
        queue[tail++] = q;
      }
    }
  }

  let start: SearchEnd | null = null;
  let best: number[] | null = null;
  for (const e of setup.starts) {
    const i = index(e.cell);
    if (i < 0 || len[i] < 0) continue;
    const t = [len[i], arr[i]];
    if (best === null || costLess(t, best)) {
      best = t;
      start = e;
    }
  }
  if (start === null) {
    return null;
  }
  let cur = index(start.cell);
  let hCur = headingOf(start.dir);
  const cells: [number, number][] = [[start.cell[0], start.cell[1]]];
  while (len[cur] > 0) {
    let moved = false;
    for (const d of [hCur, 0, 1, 2, 3]) {
      const q = step(cur, d);
      if (q >= 0 && len[q] === len[cur] - 1 && arr[q] === arr[cur]) {
        cells.push([x0 + (q % w), y0 + (q - (q % w)) / w]);
        cur = q;
        hCur = d;
        moved = true;
        break;
      }
    }
    if (!moved) {
      // Unreachable: a cell of length L > 0 was reached from one of length L - 1.
      return null;
    }
  }
  return cells;
}

/**
 * `wireRoute` for a board with other machines on it: the cable goes around every machine in
 * `machines` whenever a way round exists, and is today's path whenever today's path enters
 * none of them. Callers pass every machine rectangle on the board (the kinds
 * `isWireObstacle` says are in the way); the router drops the two endpoint machines itself.
 * PURE, deterministic, integer-only, independent of the order of `machines`, and it never
 * throws. Mirrors `wire_route.rs::wire_route_avoiding`.
 */
export function wireRouteAvoiding(
  from: WireDock,
  to: WireDock,
  machines: readonly WireBody[],
): WireRouteResult {
  const r = wireRouteAvoidingTraced(from, to, machines);
  return r.ok ? { ok: true, geometry: r.geometry } : r;
}

/**
 * `wireRouteAvoiding`, plus which candidate drew the geometry: the ladder's own when its path
 * was kept, `CAND_AROUND_MACHINES` or `CAND_AROUND_CROWDED`. Mirrors
 * `wire_route.rs::wire_route_avoiding_traced`.
 */
export function wireRouteAvoidingTraced(
  from: WireDock,
  to: WireDock,
  machines: readonly WireBody[],
): WireRouteTracedResult {
  // 1. Today's ladder, unchanged.
  const ladder = wireRouteTraced(from, to);
  if (!ladder.ok) {
    return ladder;
  }
  // 2. The obstacles.
  const obstacles = obstaclesOf(from, to, machines);
  // 3. D-09: today's path whenever it enters no machine; only an obstacle meeting the path's
  // bounding box can hold one of its cells.
  const tiles = ladder.geometry.tiles;
  let px0 = Infinity;
  let py0 = Infinity;
  let px1 = -Infinity;
  let py1 = -Infinity;
  for (const t of tiles) {
    px0 = lo2(px0, t.cell_x);
    py0 = lo2(py0, t.cell_y);
    px1 = hi2(px1, t.cell_x);
    py1 = hi2(py1, t.cell_y);
  }
  const near = obstacles.filter((o) => o[0] <= px1 && o[2] >= px0 && o[1] <= py1 && o[3] >= py0);
  const enters = tiles.some((t) =>
    near.some((o) => t.cell_x >= o[0] && t.cell_x <= o[2] && t.cell_y >= o[1] && t.cell_y <= o[3]),
  );
  if (!enters) {
    return ladder;
  }
  // 4. The closed window, and what the search runs on.
  const window = windowOf(from, to, obstacles);
  const setup = aroundSetup(from, to, window);
  // 5 and 6. The line search, or the cell walk on a crowded window; the walled-in dock keeps
  // today's path.
  let walk: [number, number][] | null = null;
  let around = CAND_AROUND_MACHINES;
  if (setup.starts.length > 0 && setup.finishes.length > 0) {
    if (setup.xs.length * setup.ys.length <= MAX_AROUND_NODES) {
      walk = searchOnLines(setup.blocks, setup.xs, setup.ys, setup.starts, setup.finishes);
    } else {
      walk = crowdedWalk(window, setup);
      around = CAND_AROUND_CROWDED;
    }
  }
  if (walk === null) {
    return ladder;
  }
  // 7. `route()` is the only judge.
  const rr = route([[from.cell[0], from.cell[1]], ...walk, [to.cell[0], to.cell[1]]]);
  if (!rr.ok) {
    return ladder;
  }
  return {
    ok: true,
    geometry: { from_anchor: anchorOf(from), to_anchor: anchorOf(to), tiles: rr.tiles },
    cand: around,
  };
}
