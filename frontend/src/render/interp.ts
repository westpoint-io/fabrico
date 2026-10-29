// Analytic item interpolation + render clock — the motion model that decouples
// belt animation from the 60-tick sim (VIS-01/VIS-02).
//
// All floating-point math lives HERE, render-side only. The wire is integer-only
// (ticks, cells, fill); the renderer converts to float when drawing. The item
// position is a pure analytic function of data already in the packet
// (arrival_tick + belt latency), so:
//   - no prev/next snapshot diffing is needed to interpolate belt travel, and
//   - backpressure bunching (VIS-04) emerges for free: a full belt has clustered
//     arrival ticks, so its dots render bunched at the downstream end.
// Snap (don't lerp) across a discontinuity — a route change, teleport or packet
// gap — to avoid interpolating across a seam (UI-SPEC interp/determinism rule).

import type { TileView } from '../protocol/decode';
import { BELT_GEOM, CELL } from '../../shared/geometry';
import {
  ARC_SAMPLES,
  CORNER_ARC_LENGTH,
  sampleArcPoints,
  tileFlowLength,
} from './synth/beltGeometry';

const HALF = CELL / 2;

/**
 * Render lag, in sim ticks, kept behind the newest received packet so a late
 * packet doesn't stall motion (Pattern 5: render ~1 tick behind the freshest
 * sim tick). The render clock chases `latestSimTick - LAG_TICKS`.
 */
export const LAG_TICKS = 1;

/**
 * MOTION-01 machine animation clock (docs/style-bible.md section 4): machine
 * state cycles run at 10fps over a bounded 24-frame loop. With the sim at ~60
 * ticks/s, one animation frame spans `60 / 10 = 6` sim ticks.
 */
export const FPS = 10;
export const FRAMES = 24;
export const SIM_TICKS_PER_FRAME = 60 / FPS; // 6 sim ticks per animation frame

/**
 * The quantized MOTION-01 frame index — a PURE function of the designated render
 * clock (in sim-tick units), never a wall clock. Advances by one every
 * `SIM_TICKS_PER_FRAME` (6) sim ticks and wraps modulo `FRAMES` (24), so frame 23
 * rolls back to 0 at clock 144. Fractional inputs floor; negative inputs floor
 * and wrap into `[0, FRAMES)` (Euclidean modulo) without throwing.
 *
 * Feeding this (rather than `performance.now()`) into the machine layer makes the
 * WORKING sweep a deterministic, replayable function of the sim clock — the
 * MOTION-01 contract that the retired wall-clock "rotating laser" violated.
 */
export function quantizedFrame(clock: number): number {
  const q = Math.floor(clock / SIM_TICKS_PER_FRAME);
  return ((q % FRAMES) + FRAMES) % FRAMES;
}

/** World-space center of a belt tile's cell. */
export function tileCenter(t: TileView): { x: number; y: number } {
  return { x: t.cell_x * CELL + HALF, y: t.cell_y * CELL + HALF };
}

/** Cumulative-length description of a tile cell-center polyline (tail->head). */
export interface BeltPolyline {
  pts: { x: number; y: number }[];
  segLen: number[]; // length of segment i -> i+1
  total: number;
}

/**
 * A {@link BeltPolyline} that also carries its PER-TILE arc-length decomposition.
 *
 * WHY THIS EXISTS, AND WHY `total` ALONE IS NOT ENOUGH ANY MORE. Until plan 61-05
 * every tile contributed exactly `CELL` to the item path, so `total` and the tile
 * count between them determined where every slot sat: a uniform division of `total`
 * WAS per-tile-true. Plan 61-05 gave a corner its real quarter-arc flow length
 * (25.132741, not 32), and from that moment a run that mixes bends and straights has
 * no single pitch. Slot placement therefore needs the per-tile lengths themselves,
 * not their sum - see {@link slotArcLength}.
 *
 * Both arrays are index-aligned with the `tiles` array the polyline was built from,
 * and the identity `tileStart[i] + tileFlow[i] === tileStart[i + 1]` holds by
 * construction, with `tileStart[0] === 0` and the last tile ending at `total` (to
 * within float accumulation noise, since `total` is summed segment by segment while
 * these are summed tile by tile).
 */
export interface BeltItemPolyline extends BeltPolyline {
  /** Tail-relative arc length at the ENTRY EDGE of each tile. `tileStart[0]` is 0. */
  tileStart: number[];
  /** Each tile's OWN flow length: `CELL` for a straight, `CORNER_ARC_LENGTH` for a bend. */
  tileFlow: number[];
}

/**
 * Build the ordered waypoint polyline from the belt's tile cell centers, in
 * TAIL->HEAD order (first tile = tail/admit, last tile = head/deliver — matching
 * the core slot direction so arc-length 0 is the tail and `total` the delivery end).
 * This is the center-only path primitive; item dots ride the full admit-to-deliver
 * `beltItemPolyline` (below), while this collapsed form is kept as the FLOW-04 test
 * baseline (a 1-tile belt has `total === 0` here) and any center-to-center sampler.
 */
export function tilePolyline(tiles: TileView[]): BeltPolyline {
  const pts = tiles.map(tileCenter);
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segLen.push(len);
    total += len;
  }
  return { pts, segLen, total };
}

/** Unit vector of a travel cardinal (N=0, E=1, S=2, W=3). */
function cardinalUnit(dir: number): { x: number; y: number } {
  switch (dir) {
    case 1:
      return { x: 1, y: 0 }; // E
    case 2:
      return { x: 0, y: 1 }; // S
    case 3:
      return { x: -1, y: 0 }; // W
    default:
      return { x: 0, y: -1 }; // N (0)
  }
}

/**
 * Two world points are the SAME point when a corner's exit tangent meets the next
 * tile's entry tangent. Below this they are joined rather than emitted twice, so no
 * zero-length segment ever enters `segLen`.
 */
const COINCIDENT_EPS = 1e-9;

/** Cross-product magnitude of two unit cardinals: 1 when perpendicular, 0 when colinear. */
function isPerpendicular(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x * b.y - a.y * b.x) > 0.5;
}

/**
 * Build the ITEM path polyline: the tile waypoints extended by HALF (= CELL/2) at
 * each STRAIGHT end so items span the belt's FULL admit-to-deliver cell extent, not
 * just center-to-center (FLOW-04, RESEARCH Pattern 6 / Pitfall 5), with every
 * CORNER tile contributing THE ARC THE BELT DRAWS rather than an L-shaped vertex
 * (BELT-07, plan 61-05).
 *
 * ---------------------------------------------------------------------------
 * THE CORNER IS THE SAME CURVE AS THE DRAWN BELT, BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * A corner used to contribute two perpendicular HALF-cell stubs through its centre,
 * so an item CUT the bend: it left the drawn lane centreline by up to
 * `R * (1 - cos 45°)` and travelled a whole CELL (32) where the belt draws
 * `R * pi / 2` (25.132741). The fix is not a correction term. The corner now emits
 * the sample points of its own quarter arc through {@link sampleArcPoints}: the
 * SAME function, the SAME {@link ARC_SAMPLES} count and the SAME
 * `BELT_GEOM.elbowR` radius that `beltGeometry.ts` draws the tread with, so there
 * is no second implementation left to disagree with the first.
 *
 * The arc runs from the tile's ENTRY EDGE MIDPOINT to its EXIT EDGE MIDPOINT and is
 * extended by nothing at either end. That is the `R === CELL / 2` property
 * (`shared/geometry.ts` {@link ELBOW_R}): the arc centre lands on the tile corner
 * `c - u_from * R + u_to * R`, so both tangent points land exactly where a
 * neighbouring straight tile's centreline arrives.
 *
 * ---------------------------------------------------------------------------
 * THE ACCEPTED CONSEQUENCE: AN ITEM SLOWS ~21% THROUGH A BEND
 * ---------------------------------------------------------------------------
 *
 * Slot spacing is SIM-TRUE (the maintainer's call): a corner tile's
 * four slots spread over its real 25.132741px arc, so the pitch is 6.283185px
 * against a straight's 8.000px and an item's WORLD SPEED dips
 * `1 - 6.283185 / 8` = 21.46% through the bend. **That is arithmetic given a frozen
 * sim, not a defect** (the sim advances a belt's slots one step per DUE tick, at that
 * belt's own interval, whatever shape the tile is) and it is what preserves the
 * shipped slot-true SKIN-03 invariant.
 *
 * **THAT INVARIANT IS EXPLICITLY SUPERSEDED BY PLAN 62-05 (D-12), AND HERE IS THE
 * SENTENCE THAT STOOD HERE:** *"a rendered dot always sits where the sim says it is."*
 * It is false BETWEEN ADVANCES whenever the trailing-interpolation toggle
 * (`ITEM_INTERPOLATION_DEFAULT`, `layers/items.ts`) is ON. What replaces it: a rendered
 * dot sits where the sim SAID it was and catches up within one advance interval, never
 * ahead of its current slot (the parameter is clamped into `[0, 1]`, so the placement is
 * trailing-only BY CONSTRUCTION, D-11). With the toggle OFF - the default, and today's
 * shipped behaviour - the original sentence holds unchanged and unqualified.
 *
 * **THE 2026-08-10 SIM-TRUE PLACEMENT RULING IS NOT REOPENED BY THIS.** An advance
 * interval alters how OFTEN slots advance; it never alters WHERE a slot sits. The lerp
 * runs between two `slotArcLength` results computed on the SAME polyline, so a gliding
 * dot stays ON the drawn track and the 21.46% corner dip above is preserved rather than
 * smoothed away. The rejected alternative below (constant px/sec through a bend) is
 * rejected exactly as hard as it was before.
 *
 * The pure-function gates survive untouched: {@link slotArcLength} is not edited, and
 * the MIXED-belt pin in `interp.test.ts` passes unchanged.
 *
 * THE REJECTED ALTERNATIVE, recorded so nobody reaches for it: constant px/sec
 * through the bend. It would make the rendered dot diverge from its sim slot by up
 * to ~7px per corner (the 32 − 25.132741 the corner does not travel), ACCUMULATING
 * along a run with several bends. Smooth speed is not worth a dot that is in the
 * wrong slot.
 *
 * **AND IT WAS SHIPPED ANYWAY, FOR ONE REVIEW CYCLE. That is recorded here rather
 * than quietly repaired, because a paragraph naming a failure mode did not stop the
 * tree from having it.** This function was made arc-aware by plan 61-05 while
 * `slotArcLength` was left dividing `total` UNIFORMLY, which is constant px/sec by
 * another name: on `[S, C, S]` a slot sat up to 2.003px from where the sim put it,
 * and on a 20-tile spiral 33.91px, more than a whole tile. The repair is the
 * {@link BeltItemPolyline} decomposition below (`tileStart` / `tileFlow`), which is
 * what makes {@link slotArcLength} place a slot inside the tile that OWNS it. The
 * gate is the MIXED-belt case in `interp.test.ts`; the single-kind cases that were
 * there before could not fail, because on a homogeneous belt uniform division and
 * per-tile division are the same number.
 *
 * ---------------------------------------------------------------------------
 * THE PER-TILE DECOMPOSITION IS PART OF THE RETURN VALUE, NOT A DERIVATION
 * ---------------------------------------------------------------------------
 *
 * `tileStart[i]` / `tileFlow[i]` are emitted from THIS loop, off the same branch
 * that decides whether tile `i` sweeps an arc, and the flow length itself comes from
 * {@link tileFlowLength} - the same function `beltGeometry.ts` uses. A consumer
 * therefore cannot re-derive the tile kinds from the point list and disagree with
 * the walker about which tile a slot belongs to. The DEGENERATE "corner" whose
 * `from` and `to` are not perpendicular is classified by the branch it actually
 * takes (straight, `CELL`), not by the presence of the `Corner` tag.
 *
 * ---------------------------------------------------------------------------
 * LENGTHS ARE TRUE ARC LENGTHS, NOT CHORD LENGTHS
 * ---------------------------------------------------------------------------
 *
 * The 24 chords of a sampled quarter arc sum to 25.132190, 0.00055px short of the
 * true 25.132741. `segLen` therefore carries the TRUE per-step arc length
 * (`CORNER_ARC_LENGTH / ARC_SAMPLES`) for arc steps rather than the chord's own
 * hypotenuse, so `slotArcLength` places a slot at the arc length the SIM means and
 * `pointAlong` walks in that same unit. The emitted POINTS still lie exactly on the
 * centreline circle; only the interpolation BETWEEN two samples runs along a chord,
 * whose worst deviation is the sagitta `R * (1 - cos(pi / 96))` = 0.0086px.
 *
 * ---------------------------------------------------------------------------
 * THE SINGLE-TILE BRANCH, AND THE CLAIM THIS PLAN FALSIFIED
 * ---------------------------------------------------------------------------
 *
 * The center-only `tilePolyline` collapses a 1-tile belt to a SINGLE point
 * (`total = 0`), so `pointAlong`'s `total === 0` guard parks every slot at pts[0]:
 * the stacked-dot bug. A one-tile STRAIGHT still gets a tail stub HALF beyond its
 * centre opposite the entry travel and a head stub HALF beyond it along the exit
 * travel, giving `total === CELL` and honest, distinct slot bands.
 *
 * A one-tile CORNER no longer does. The old comment here read, of the two stubs:
 * *"For a straight these are colinear -> total === CELL; for a corner they are
 * perpendicular half-segments that still sum to CELL."* **The second half of that
 * became FALSE the moment a corner's flow length stopped being a cell.** It is
 * corrected in place rather than deleted (the falsified-comment discipline this tree
 * applies at `beltPainter.ts` and `belts.ts`): a lone corner's flow length is its
 * quarter arc, 25.132741, and the arc already spans edge midpoint to edge midpoint,
 * so it is extended by NOTHING at either end and carries no stub at all.
 *
 * PER-BELT PHASE ACCUMULATION IS DEGENERATE ON A ONE-TILE BELT, and that is handled
 * rather than overlooked: the belt's tail and its head are the same tile, so its
 * tail-relative offset is 0 by definition and there is nothing to accumulate. (The
 * accumulator itself lives in `belts.ts rebuildTiles`; it is named here because a
 * reader of this branch will wonder where the one-tile case of it went.)
 *
 * Direction source: multi-tile belts read the first/last SEGMENT direction (the
 * same tail->head adjacency `tilePolyline` uses); a single-tile belt has no
 * segment, so the travel axis is derived from the tile kind — a Straight's `axis`
 * (0 -> x/E, 1 -> y/S) or a Corner's `from` (entry travel) and `to` (exit travel).
 * The absolute sign is not load-bearing on a 1-tile straight (both stubs sit inside
 * the one cell); only the CELL of extent and the tail->head ordering matter.
 *
 * A "corner" whose `from` and `to` are NOT perpendicular is not a bend at all
 * (there is no arc to sweep), so it falls back to the straight treatment rather
 * than emitting NaN from a degenerate sweep.
 *
 * `tilePolyline` is intentionally UNTOUCHED (center-based) so the FLOW-04 baseline
 * tests keep their exact geometry. Pure
 * render-side float, one-way: nothing here flows into a GridCommand or the sim
 * (T-14-FLOAT-LEAK / T-31-DET). The arc math added by plan 61-05 reads two value
 * modules and nothing else (no decoder, no `GridCommand`, no protocol type), so it
 * opens no new path by which a number computed here could reach the sim.
 */
export function beltItemPolyline(tiles: TileView[]): BeltItemPolyline {
  const centers = tiles.map(tileCenter);
  const n = centers.length;
  if (n === 0) {
    return { pts: [], segLen: [], total: 0, tileStart: [], tileFlow: [] };
  }

  const R = BELT_GEOM.elbowR;
  const ARC_STEP = CORNER_ARC_LENGTH / ARC_SAMPLES;

  const pts: { x: number; y: number }[] = [];
  const segLen: number[] = [];
  let total = 0;
  // The per-tile decomposition (see BeltItemPolyline). `flowCursor` walks the tile
  // BOUNDARIES, which is a different accumulation from `total`: `total` sums the
  // emitted SEGMENTS (a straight's cell arrives as a HALF stub plus a HALF join, an
  // arc as 24 equal steps), while this sums whole tiles. The two agree to float noise
  // and the boundaries are the ones slot placement must use.
  const tileStart: number[] = [];
  const tileFlow: number[] = [];
  let flowCursor = 0;

  /**
   * Append one point. `arcLen`, when given, is the TRUE arc length of the step that
   * reaches it (see the "true arc lengths" section above); otherwise the step's own
   * straight-line length is used, which is what every straight segment wants.
   */
  const push = (x: number, y: number, arcLen?: number): void => {
    const prev = pts[pts.length - 1];
    if (prev !== undefined) {
      const chord = Math.hypot(x - prev.x, y - prev.y);
      if (chord <= COINCIDENT_EPS) return; // a shared tangent point, emitted once
      const len = arcLen ?? chord;
      segLen.push(len);
      total += len;
    }
    pts.push({ x, y });
  };

  /** The travel unit a NON-CORNER tile at index `i` runs along (tail->head). */
  const straightUnit = (i: number): { x: number; y: number } => {
    if (n === 1) {
      const kind = tiles[0].kind;
      // Straight: axis 0 -> horizontal (E), axis 1 -> vertical (S). A degenerate
      // corner (from === to) lands here too and takes its entry travel.
      return 'Corner' in kind
        ? cardinalUnit(kind.Corner.from)
        : cardinalUnit(kind.Straight.axis === 1 ? 2 : 1);
    }
    const a = i === 0 ? centers[0] : centers[i - 1];
    const b = i === 0 ? centers[1] : centers[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };

  for (let i = 0; i < n; i++) {
    const c = centers[i];
    const kind = tiles[i].kind;
    const bend = 'Corner' in kind ? kind.Corner : null;
    const entry = bend === null ? null : cardinalUnit(bend.from);
    const exit = bend === null ? null : cardinalUnit(bend.to);
    // Classified by the branch this tile ACTUALLY takes below, never by the `Corner`
    // tag alone: a non-perpendicular "corner" sweeps no arc and flows a whole CELL.
    const sweepsArc = entry !== null && exit !== null && isPerpendicular(entry, exit);
    const flow = tileFlowLength(sweepsArc);
    tileStart.push(flowCursor);
    tileFlow.push(flow);
    flowCursor += flow;

    if (sweepsArc && entry !== null && exit !== null) {
      // The arc centre is the tile CORNER the bend rounds: `R` back along the entry
      // travel from the centre, then `R` forward along the exit travel. Both tangent
      // points are then exactly `R` from it, and at `R === CELL / 2` they are the
      // tile-edge midpoints.
      const ox = c.x - entry.x * R + exit.x * R;
      const oy = c.y - entry.y * R + exit.y * R;
      const p0x = c.x - entry.x * R;
      const p0y = c.y - entry.y * R;
      const p1x = c.x + exit.x * R;
      const p1y = c.y + exit.y * R;
      const t0 = Math.atan2(p0y - oy, p0x - ox);
      // Sweep the SHORT way round (a quarter turn, signed by chirality): wrap the
      // angular difference into (-pi, pi] so a bend never takes the 270-degree route.
      const raw = Math.atan2(p1y - oy, p1x - ox) - t0;
      const sweep = raw - 2 * Math.PI * Math.round(raw / (2 * Math.PI));
      const arc = sampleArcPoints(ox, oy, R, t0, t0 + sweep, ARC_SAMPLES);
      for (let s = 0; s <= ARC_SAMPLES; s++) {
        // The first sample joins whatever preceded it by a straight step (the HALF
        // from an upstream straight's centre, or nothing at all when this corner is
        // the tail); every later sample is one true arc step further along.
        push(arc[s * 2], arc[s * 2 + 1], s === 0 ? undefined : ARC_STEP);
      }
      continue;
    }

    if (i === 0) {
      const u = straightUnit(0);
      push(c.x - u.x * HALF, c.y - u.y * HALF); // admit edge
    }
    push(c.x, c.y);
    if (i === n - 1) {
      const u = straightUnit(i);
      push(c.x + u.x * HALF, c.y + u.y * HALF); // deliver edge
    }
  }

  return { pts, segLen, total, tileStart, tileFlow };
}

/** Point + unit tangent at arc-length `d` along the polyline (clamped to ends). */
export function pointAlong(
  pl: BeltPolyline,
  d: number,
): { x: number; y: number; ux: number; uy: number } {
  const { pts, segLen, total } = pl;
  if (pts.length === 0) return { x: 0, y: 0, ux: 1, uy: 0 };
  if (pts.length === 1 || total === 0) {
    return { x: pts[0].x, y: pts[0].y, ux: 1, uy: 0 };
  }
  let rem = Math.min(Math.max(d, 0), total);
  for (let i = 0; i < segLen.length; i++) {
    const len = segLen[i];
    if (rem <= len || i === segLen.length - 1) {
      const t = len === 0 ? 0 : rem / len;
      const a = pts[i];
      const b = pts[i + 1];
      const ux = (b.x - a.x) / (len || 1);
      const uy = (b.y - a.y) / (len || 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ux, uy };
    }
    rem -= len;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y, ux: 1, uy: 0 };
}

/**
 * Slot-true arc-length placement for one in-flight item (SKIN-03).
 *
 * The host ships each item's exact belt slot on the wire: `arrival_tick` IS the
 * slot index (slot 0 = the head/deliver end) and `latency` IS the total slot
 * count (`SLOTS_PER_TILE * tiles`). {@link beltItemPolyline} runs tail->head (d=0
 * at the tail, d=`total` at the head).
 *
 * ---------------------------------------------------------------------------
 * A SLOT BELONGS TO A TILE, AND SITS IN ITS OWN TILE'S BAND
 * ---------------------------------------------------------------------------
 *
 * The core's slot array is flat, `SLOTS_PER_TILE` slots per tile, with index 0 at
 * the HEAD and `M-1` at the TAIL (`crates/fabrico-core/src/belt_slots.rs`). Counting
 * from the tail, `fromTail = slotCount - 1 - slotIndex`, slot `fromTail` belongs to
 * tile `floor(fromTail / slotsPerTile)` and is the `m`th slot inside it. It sits in
 * a CENTERED band across THAT TILE'S OWN flow length:
 *
 *   d = tileStart[t] + tileFlow[t] * (m + 0.5) / slotsPerTile
 *
 * So a straight tile spreads its four slots over 32.000 (an 8.000px pitch) and a
 * corner spreads its four over 25.132741 (a 6.283185px pitch), which is the maintainer's
 * SIM-TRUE ruling (61-CONTEXT.md section D) expressed as arithmetic.
 *
 * **THE FORMULA THIS REPLACES, QUOTED SO THE CORRECTION IS LEGIBLE.** It read
 * `d = total * (slotCount - slotIndex - 0.5) / slotCount` - a UNIFORM division of
 * the whole polyline - and it is corrected rather than deleted because it was RIGHT
 * until plan 61-05 and a future reader will otherwise re-derive it as the obvious
 * thing. Before that plan every tile contributed exactly `CELL`, so `total /
 * slotCount` WAS the per-tile pitch on every belt. Once a corner's flow became its
 * real 25.132741 arc, the uniform division became constant px/sec by another name -
 * the alternative {@link beltItemPolyline}'s docblock names and rejects - and put a
 * dot up to 2.003px from its sim slot on `[S, C, S]` and 33.91px out on a 20-tile
 * spiral. On a HOMOGENEOUS belt the two formulas still agree exactly, which is why
 * the single-kind cases in `interp.test.ts` stayed green through the whole defect
 * and why the gate is now a MIXED belt.
 *
 * `slotsPerTile` is DERIVED from the wire (`slotCount / tiles`), never re-typed from
 * the Rust constant: a render-side copy of `SLOTS_PER_TILE` would be a second source
 * of truth that a core bump could silently desynchronise.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DEGENERATE INPUTS
 * ---------------------------------------------------------------------------
 *
 * - `slotCount <= 1` is a single-slot (or empty) belt: the one slot parks at the
 *   head (`total`), exactly as before.
 * - A `slotCount` that is NOT a whole multiple of the tile count has no slot-to-tile
 *   map at all, so there is nothing to place per tile and the uniform division is
 *   the only available answer. **That branch is a degrade, NOT the model**: the host
 *   ships `latency = SLOTS_PER_TILE * tiles` (`belt_slots.rs slot_count`), so it is
 *   unreachable from a well-formed packet, and it must never be read as sanction for
 *   dividing `total` uniformly on a belt that DOES decompose.
 *
 * Pure float arithmetic, render-side only; nothing here flows back into a logged
 * command or the sim (T-14-FLOAT-LEAK). The returned `d` is never clamped here (the
 * centered band cannot reach the raw extremes); {@link pointAlong} clamps.
 */
export function slotArcLength(
  slotIndex: number,
  slotCount: number,
  pl: BeltItemPolyline,
): number {
  const { total, tileStart, tileFlow } = pl;
  if (slotCount <= 1) return total; // single slot sits at the head
  const tiles = tileFlow.length;
  const slotsPerTile = tiles > 0 ? slotCount / tiles : 0;
  if (!Number.isInteger(slotsPerTile) || slotsPerTile < 1) {
    return (total * (slotCount - slotIndex - 0.5)) / slotCount; // the degrade, see above
  }
  const fromTail = slotCount - 1 - slotIndex;
  const t = Math.min(Math.max(Math.floor(fromTail / slotsPerTile), 0), tiles - 1);
  const m = fromTail - t * slotsPerTile;
  return tileStart[t] + (tileFlow[t] * (m + 0.5)) / slotsPerTile;
}

/**
 * Advance the render clock one display frame toward the latest received sim
 * tick, keeping a ~1-tick lag buffer (`LAG_TICKS`).
 *
 * @param prev        the render clock last frame (in sim-tick units)
 * @param latestSimTick the newest tick received over the transport
 * @param deltaMs     this frame's wall-clock delta (e.g. Ticker.deltaMS)
 * @param simTickMs   ms per sim tick (e.g. 1000/60)
 *
 * Chases `latestSimTick - LAG_TICKS`, capped so it never overshoots forward.
 * A large backward collapse of `latestSimTick` (seek / replay rewind) makes the
 * target drop below `prev`, so the `Math.min` snaps the clock back rather than
 * lerping across the seam.
 */
export function advanceRenderClock(
  prev: number,
  latestSimTick: number,
  deltaMs: number,
  simTickMs: number,
): number {
  const target = latestSimTick - LAG_TICKS;
  const advanced = prev + deltaMs / simTickMs;
  // Forward: never overshoot the lagged target. Backward (target < prev):
  // Math.min collapses to the target, snapping back on a rewind.
  return Math.min(target, advanced);
}
