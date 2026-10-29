import { describe, expect, it } from 'vitest';
import {
  type BeltItemPolyline,
  FRAMES,
  LAG_TICKS,
  SIM_TICKS_PER_FRAME,
  advanceRenderClock,
  beltItemPolyline,
  pointAlong,
  quantizedFrame,
  slotArcLength,
  tilePolyline,
} from './interp.ts';
import type { TileView } from '../protocol/decode.ts';
import { BELT_GEOM, CELL } from '../../shared/geometry.ts';
import { ARC_SAMPLES, CORNER_ARC_LENGTH } from './synth/beltGeometry.ts';
// The SHIPPED dot radius, read rather than copied: the two clearance bounds below
// are claims about the dot that actually rides this path, and a local literal would
// agree with itself after any future dot edit.
import { CORE_R } from './layers/items.ts';
import { seamEndTiles } from '../protocol/seam.ts';

const HALF_CELL = CELL / 2;

const straight = (cx: number, cy: number, axis: number): TileView => ({
  cell_x: cx,
  cell_y: cy,
  kind: { Straight: { axis } },
});

/** A corner tile: `from` is the travel cardinal on ENTRY, `to` the one on EXIT (N=0,E=1,S=2,W=3). */
const corner = (cx: number, cy: number, from: number, to: number): TileView => ({
  cell_x: cx,
  cell_y: cy,
  kind: { Corner: { from, to } },
});

// ---------------------------------------------------------------------------
// BELT-07: an item crosses a bend on the ARC THE BELT DRAWS (plan 61-05)
// ---------------------------------------------------------------------------
//
// WHAT THIS BLOCK IS FOR. Before this plan a corner contributed two perpendicular
// HALF-cell stubs through its centre - an L-shaped vertex - so an item cut the
// corner, left the drawn lane centreline, and travelled 32px where the belt draws
// 25.132741. The corner now contributes the sampled points of the SAME quarter arc
// `beltGeometry.ts` draws, at the SAME radius and the SAME sample count, so there is
// no drift left to correct.
//
// THE ONE-TILE STRAIGHT, THE ONE-TILE CORNER AND THE MULTI-TILE RUN ARE GATED IN ONE
// FILE ON PURPOSE (plan 61-05 behaviour 7). `beltItemPolyline`'s single-tile branch is
// a genuinely separate code path from its multi-tile branch, and the one-tile CORNER
// is the case whose old comment ("perpendicular half-segments that still sum to CELL")
// this plan falsifies. Split across two files, one could regress green.
//
// A RECORD CORRECTION, RAISED RATHER THAN ABSORBED. Plan 61-05's behaviour 3 states
// the three-tile L total as 121.132741, decomposed as "two cells plus the quarter arc
// plus the two half-cell end stubs". That decomposition DOUBLE-COUNTS the stubs: under
// FLOW-04 the tail stub and the head stub are already INSIDE the two straights' own
// cells (a straight tile spans entry edge to exit edge = CELL, and its half of that
// span on the outboard side IS the stub). The polyline total has always been exactly
// the sum of the per-tile FLOW LENGTHS - which is why an N-tile straight run measures
// N * CELL and not N * CELL + CELL - so the L measures 32 + 25.132741 + 32 =
// 89.132741. Measurement wins over the record, as plans 61-03 and 61-04 each ruled
// before this one. Nothing about the conclusion moves: the corner still contributes
// its true arc and nothing else.
describe('BELT-07: the item path through a bend is the arc the belt draws', () => {
  /** The true quarter arc on the CENTRELINE radius: `R * pi / 2` = 25.132741 at R = 16. */
  const ARC = CORNER_ARC_LENGTH;

  it('a one-tile STRAIGHT belt still measures 32.000 - the arc work moves nothing here', () => {
    const pl = beltItemPolyline([straight(3, 4, 0)]);
    expect(pl.total).toBeCloseTo(32.0, 9);
    expect(pl.total).toBeCloseTo(CELL, 9);
    // ... and the vertical axis reads the same, so the claim is about the FLOW LENGTH
    // and not about one orientation.
    expect(beltItemPolyline([straight(3, 4, 1)]).total).toBeCloseTo(32.0, 9);
  });

  it('a one-tile CORNER belt measures 25.132741, NOT 32 - the arc is extended by nothing', () => {
    // The arc already runs edge midpoint to edge midpoint (that is the property
    // `R === CELL / 2` uniquely satisfies), so there is no stub to add at either end:
    // the tile's admit edge IS the arc's first point and its deliver edge IS the last.
    const pl = beltItemPolyline([corner(3, 4, 1, 2)]); // travel E in, S out
    expect(pl.total).toBeCloseTo(25.132741, 6);
    expect(pl.total).toBeCloseTo(ARC, 9);
    expect(pl.total).not.toBeCloseTo(CELL, 3);
    // Every chirality and every entry cardinal measures the same arc - a bend is a
    // bend. All eight legal (from, to) pairs, so no orientation can drift.
    for (const [from, to] of [
      [0, 1], [0, 3], [1, 0], [1, 2], [2, 1], [2, 3], [3, 0], [3, 2],
    ] as const) {
      expect(beltItemPolyline([corner(7, 9, from, to)]).total, `corner ${from}->${to}`).toBeCloseTo(
        ARC,
        9,
      );
    }
  });

  it('a three-tile L of straight + corner + straight measures 32 + 25.132741 + 32', () => {
    // Cells (0,0) -> (1,0) -> (1,1): travel E into the bend, S out of it.
    const run: TileView[] = [straight(0, 0, 0), corner(1, 0, 1, 2), straight(1, 1, 1)];
    const pl = beltItemPolyline(run);
    expect(pl.total).toBeCloseTo(32 + 25.132741 + 32, 6);
    expect(pl.total).toBeCloseTo(89.132741, 6);
    // Stated as the flow-length identity as well, so the number above is not the only
    // thing holding the model: total === sum of per-tile flow lengths, always.
    expect(pl.total).toBeCloseTo(CELL + ARC + CELL, 9);
    // The plan's 121.132741 double-counts the two end stubs (see the block header).
    // Pinned as a NEGATIVE so the correction cannot be silently un-made.
    expect(pl.total).not.toBeCloseTo(121.132741, 3);
    // The corner cost the run exactly (CELL - ARC) against an all-straight L of the
    // same tile count - the drift this plan removes, stated as an equality.
    const allStraight = beltItemPolyline([straight(0, 0, 0), straight(1, 0, 0), straight(2, 0, 0)]);
    expect(allStraight.total - pl.total).toBeCloseTo(CELL - ARC, 9);
  });

  it('SLOT-TRUE, ACCEPTED: the corner slot pitch is 6.283185 against a straight 8.000', () => {
    // The maintainer's call: a corner tile's four slots spread over
    // its REAL arc, so a rendered dot always sits where the sim says it is. The
    // accepted consequence is that an item's WORLD SPEED dips ~21% through a bend.
    // That is arithmetic given a frozen sim, not a defect, and it is pinned here so
    // nobody later "fixes" it into constant px/sec (which would diverge the drawn dot
    // from its sim slot by up to ~7px per corner, accumulating along the run).
    const SLOTS_PER_TILE = 4; // hand-mirrored from crates/fabrico-core/src/belt_slots.rs
    const pitchOf = (tiles: TileView[]): number => {
      const pl = beltItemPolyline(tiles);
      const M = SLOTS_PER_TILE * tiles.length;
      return slotArcLength(0, M, pl) - slotArcLength(1, M, pl);
    };
    const cornerPitch = pitchOf([corner(3, 4, 1, 2)]);
    const straightPitch = pitchOf([straight(3, 4, 0)]);
    expect(cornerPitch).toBeCloseTo(6.283185, 6);
    expect(straightPitch).toBeCloseTo(8.0, 9);
    // The ratio itself, pinned, because it is the number the SUMMARY has to state.
    expect(1 - cornerPitch / straightPitch).toBeCloseTo(0.2146, 4);
  });

  // -------------------------------------------------------------------------
  // THE MIXED-BELT GATE. THIS IS THE CASE THE TWO ABOVE STRUCTURALLY CANNOT BE.
  // -------------------------------------------------------------------------
  //
  // A homogeneous belt cannot discriminate a slot model. Its `total` is `tiles *
  // flow` and its slot count is `tiles * SLOTS_PER_TILE`, so `total / slotCount`
  // IS the per-tile pitch by construction: a uniform division of the whole polyline
  // and a per-tile division agree at EVERY slot, exactly, at any flow length. The
  // single-tile corner and single-tile straight cases above therefore hold under the
  // sim-true model, under constant px/sec, and under anything else that divides
  // `total` evenly - which is precisely why they stayed green while the shipped code
  // did the thing their own comment says nobody should later "fix" it into.
  //
  // WATCHED RED BEFORE THE FIX, on 2026-08-11, against the then-shipped
  // `slotArcLength(slot, count, total)`: `expected 25.997049525042843 to be close to
  // 28`, a 2.0029504749571565px displacement of one dot from its sim slot. A gate
  // nobody watched fail is not a gate, so the number is written down here.
  it('MIXED [S, C, S]: every slot sits in its OWN tile, at that tile\'s own pitch', () => {
    const SLOTS_PER_TILE = 4; // hand-mirrored from crates/fabrico-core/src/belt_slots.rs
    // Cells (0,0) -> (1,0) -> (1,1): travel E into the bend, S out of it.
    const run: TileView[] = [straight(0, 0, 0), corner(1, 0, 1, 2), straight(1, 1, 1)];
    const pl = beltItemPolyline(run);
    const M = SLOTS_PER_TILE * run.length; // 12

    // (1) THE TILE BOUNDARIES, as literals. The bend starts where the first
    // straight's cell ends and is 25.132741 long, so the second straight starts at
    // 57.132741 - NOT at the 2/3 of `total` a uniform reading would put it at.
    expect(pl.tileStart.map((v) => Number(v.toFixed(6)))).toEqual([0, 32, 57.132741]);
    expect(pl.tileFlow.map((v) => Number(v.toFixed(6)))).toEqual([32, 25.132741, 32]);
    // The decomposition closes on the walked total, so no slot can fall outside it.
    const flowSum = pl.tileFlow.reduce((a, b) => a + b, 0);
    expect(flowSum).toBeCloseTo(pl.total, 9);

    // (2) EVERY SLOT, against its own tile's centered band. Slot indices are
    // HEAD-based (slot 0 = deliver end, slot 11 = admit end), so tile 0 owns slots
    // 11..8, the bend owns 7..4 and tile 2 owns 3..0.
    const d = (slot: number): number => slotArcLength(slot, M, pl);
    for (let m = 0; m < SLOTS_PER_TILE; m++) {
      expect(d(11 - m), `tile 0 slot ${m}`).toBeCloseTo((CELL * (m + 0.5)) / SLOTS_PER_TILE, 9);
      expect(d(7 - m), `bend slot ${m}`).toBeCloseTo(CELL + (ARC * (m + 0.5)) / SLOTS_PER_TILE, 9);
      expect(d(3 - m), `tile 2 slot ${m}`).toBeCloseTo(
        CELL + ARC + (CELL * (m + 0.5)) / SLOTS_PER_TILE,
        9,
      );
    }

    // (3) THE PITCHES, as the two numbers the SUMMARY states. 8.000 inside either
    // straight, 6.283185 inside the bend, on the SAME belt - which is the whole
    // claim, and the one a single-kind belt cannot make.
    expect(d(9) - d(10)).toBeCloseTo(8.0, 9);
    expect(d(1) - d(2)).toBeCloseTo(8.0, 9);
    expect(d(5) - d(6)).toBeCloseTo(6.283185, 6);

    // (4) THE REJECTED MODEL, PINNED AS A NEGATIVE so it cannot come back silently.
    // A uniform division of this belt has a single 7.427728 pitch everywhere and puts
    // tile 0's head slot 2.0029505px short of where the sim has it.
    const uniform = (slot: number): number => (pl.total * (M - slot - 0.5)) / M;
    expect(pl.total / M).toBeCloseTo(7.427728, 6);
    expect(d(9) - d(10)).not.toBeCloseTo(pl.total / M, 3);
    expect(d(8) - uniform(8)).toBeCloseTo(2.0029505, 6);
  });

  it('every emitted corner point lies EXACTLY on the centreline circle', () => {
    // The sample points carry no chord error by construction - they are cos/sin of the
    // centreline radius - so the identity is asserted at every one of them rather than
    // bounded. (Between samples the walker interpolates along a chord, whose sagitta at
    // ARC_SAMPLES = 24 is R*(1 - cos(pi/96)) = 0.0086 world px.)
    const R = BELT_GEOM.elbowR;
    const tile = corner(3, 4, 1, 2); // travel E in, S out
    const c = { x: 3 * CELL + HALF_CELL, y: 4 * CELL + HALF_CELL };
    // Entry travel E = (1,0), exit travel S = (0,1): centre = c - E*R + S*R.
    const o = { x: c.x - R, y: c.y + R };
    const pl = beltItemPolyline([tile]);
    expect(pl.pts).toHaveLength(ARC_SAMPLES + 1);
    for (const p of pl.pts) {
      expect(Math.hypot(p.x - o.x, p.y - o.y)).toBeCloseTo(R, 9);
    }
    // ... and the two ends are the TILE-EDGE MIDPOINTS, which is where a neighbouring
    // straight's centreline arrives. This is the `R === CELL / 2` property, measured on
    // the item path rather than assumed from the geometry module.
    expect(pl.pts[0]).toEqual({ x: c.x - HALF_CELL, y: c.y });
    const last = pl.pts[pl.pts.length - 1];
    expect(last.x).toBeCloseTo(c.x, 9);
    expect(last.y).toBeCloseTo(c.y + HALF_CELL, 9);
  });

  it('CLEARANCE: the dot leaves 6.6px to the nearest rail edge, on the bend AND the straight', () => {
    // The 20px lane (BELT-05) is the first lane narrow enough for either bound to be
    // worth asserting: at the retired 32px straight lane both were slack by a wide
    // margin and nobody had to look.
    //
    // The rails are 1px hairlines lying INSIDE the lane edge, so the rail edge NEAREST
    // the centreline sits `laneHalf - rail` = 9px off it - on the straight (rows +/-9)
    // and, at radius `R -/+ (laneHalf - rail)` = 7 and 25, on the bend. The two are
    // EQUAL, which is BELT-05's no-pinch promise stated as a number rather than as an
    // absence.
    const toNearestRailEdge = BELT_GEOM.laneHalf - BELT_GEOM.rail;
    expect(toNearestRailEdge).toBe(9);
    expect(BELT_GEOM.elbowR - toNearestRailEdge).toBe(7); // inner rail's inner edge
    expect(BELT_GEOM.elbowR + toNearestRailEdge).toBe(25); // outer rail's inner edge
    // Bound 1: a dot ON the centreline clears the nearest rail edge by 6.6px.
    expect(toNearestRailEdge - CORE_R).toBeCloseTo(6.6, 9);
    // Bound 2: the dot's OUTER DIAMETER fits inside the lane, with room to spare.
    expect(2 * CORE_R).toBeCloseTo(4.8, 9);
    expect(2 * CORE_R).toBeLessThanOrEqual(2 * BELT_GEOM.laneHalf);
  });
});

describe('beltItemPolyline - full admit-to-deliver extent (FLOW-04)', () => {
  // A 1-tile straight belt: center-only tilePolyline has ONE point -> total 0,
  // so every slot parks at pts[0] (the stacked-dot bug). beltItemPolyline extends
  // by HALF (= CELL/2) at each end so the whole cell is spanned (total === CELL).
  it('a 1-tile straight belt spans the whole cell (total === CELL, was 0)', () => {
    const one: TileView[] = [straight(3, 4, 0)];
    // Center-only baseline: a single center point -> zero length (the root bug).
    expect(tilePolyline(one).total).toBe(0);
    // Extended builder: HALF beyond each end -> a full cell of extent.
    const pl = beltItemPolyline(one);
    expect(pl.total).toBeCloseTo(CELL);
    expect(pl.pts.length).toBeGreaterThanOrEqual(2);
  });

  it('a 3-tile straight run is exactly CELL longer than the center-only polyline', () => {
    const run: TileView[] = [straight(0, 0, 0), straight(1, 0, 0), straight(2, 0, 0)];
    const centerTotal = tilePolyline(run).total; // 2 * CELL (2 center-to-center segs)
    const pl = beltItemPolyline(run);
    expect(centerTotal).toBeCloseTo(2 * CELL);
    expect(pl.total).toBeCloseTo(3 * CELL); // one extra CELL from the two HALF stubs
    expect(pl.total - centerTotal).toBeCloseTo(CELL);
  });

  it('places 3 slots in 3 DISTINCT bands across the cell (synthetic count)', () => {
    const one: TileView[] = [straight(3, 4, 0)];
    const pl = beltItemPolyline(one);
    // A SYNTHETIC slot count, not the core value. It was written as
    // `SLOTS_PER_TILE * 1 tile, core-locked` when SLOTS_PER_TILE was 3; Phase 60
    // (SLOT-01) moved it to 4, so this 3 no longer mirrors anything in the core.
    // It is left at 3 deliberately: `slotArcLength` is a pure function of
    // (index, count, total) and this case is about band DISTINCTNESS at an
    // arbitrary count, not about the belt model. The case that does pin the core
    // value is the SLOT-01 uniform-8px-pitch case at the bottom of this file,
    // which is the one that reddens if the constant moves.
    const M = 3;
    const ds = [0, 1, 2].map((s) => slotArcLength(s, M, pl));
    // Distinct arc-length values (not all collapsed to 0 / total).
    expect(new Set(ds).size).toBe(3);
    const pts = ds.map((d) => pointAlong(pl, d));
    // Distinct world coordinates — the dots are spread, not stacked at one point.
    const xs = pts.map((p) => Number(p.x.toFixed(4)));
    expect(new Set(xs).size).toBe(3);
    // Span at least a HALF-cell across the three occupied slots (honest spread).
    const spread = Math.max(...xs) - Math.min(...xs);
    expect(spread).toBeGreaterThan(HALF_CELL);
  });

  it('keeps tail->head direction: slot 0 near the head, last slot near the tail', () => {
    const one: TileView[] = [straight(3, 4, 0)];
    const pl = beltItemPolyline(one);
    const M = 3;
    const head = pl.pts[pl.pts.length - 1]; // deliver-end stub
    const tail = pl.pts[0]; // admit-end stub
    const p0 = pointAlong(pl, slotArcLength(0, M, pl)); // slot 0 = head band
    const p2 = pointAlong(pl, slotArcLength(2, M, pl)); // last slot = tail band
    // slot 0 sits closer to the head end than the last slot does.
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    expect(dist(p0, head)).toBeLessThan(dist(p2, head));
    expect(dist(p2, tail)).toBeLessThan(dist(p0, tail));
  });

  // Phase 89 red-first probe (plan 89-01, D-01), seen failing at PHASE89_START and turned on by
  // plan 89-03 (its gate and title suffix removed; the body is unchanged).

  it(
    'a_one_tile_west_belt_moves_its_items_west',
    () => {
      // BELT-10 (D-15): items on the one tile of a belt fed and drained West, in the kind the seam
      // table gives it, travel West: the polyline of cell (5,5) runs from x 192 to x 160.
      const tiles = seamEndTiles([straight(5, 5, 0)], [3], 3);
      const pl = beltItemPolyline(tiles);
      const first = pl.pts[0];
      const last = pl.pts[pl.pts.length - 1];
      console.log(`P89-BELT-10-items kind=${JSON.stringify(tiles[0].kind)} from_x=${first?.x} to_x=${last?.x} total=${pl.total}`);
      expect(first?.x, 'items enter at the East edge').toBeCloseTo(192);
      expect(last?.x, 'and leave at the West edge').toBeCloseTo(160);
    },
  );
});

describe('slotArcLength — slot-true item arc-length placement (SKIN-03)', () => {
  const TOTAL = 240; // e.g. a 240px belt polyline
  // A SYNTHETIC slot count, chosen because 240/6 divides evenly and the band
  // arithmetic below is readable at it. It was commented `SLOTS_PER_TILE * tiles`
  // when SLOTS_PER_TILE was 3 (6 = 3 * 2 tiles); Phase 60 (SLOT-01) moved the
  // constant to 4, so 6 is no longer any whole number of tiles. Left at 6 on
  // purpose: these cases test `slotArcLength`'s band placement as a pure
  // function, at a count that is deliberately NOT derived from the core.
  const M = 6;
  /**
   * A SYNTHETIC one-tile polyline of a stated flow length. These cases are about the
   * centered-BAND arithmetic, not about belt shape, so they hand `slotArcLength` the
   * simplest decomposition that exists: one tile owning the whole length, six slots
   * inside it. That is deliberately the configuration where per-tile and uniform
   * placement coincide - the case that DISCRIMINATES them is the mixed-belt gate in
   * the BELT-07 block above, and these cases must not be mistaken for it.
   */
  const onePiece = (total: number): BeltItemPolyline => ({
    pts: [],
    segLen: [],
    total,
    tileStart: [0],
    tileFlow: [total],
  });
  const PL = onePiece(TOTAL);

  it('single slot (count 1) parks at the head (d = total) for any index', () => {
    expect(slotArcLength(0, 1, PL)).toBe(TOTAL);
  });

  it('a zero-count belt degenerates to the head (guard, count <= 1 => total)', () => {
    expect(slotArcLength(0, 0, PL)).toBe(TOTAL);
  });

  it('a slot count that is no whole multiple of the tile count DEGRADES to uniform', () => {
    // Unreachable from a well-formed packet (the host ships `SLOTS_PER_TILE * tiles`),
    // and asserted so the degrade is a decision on the record rather than a surprise:
    // with no slot-to-tile map there is nothing to place per tile. A [S, C] belt at a
    // count of 5 has no 5/2 slots-per-tile, so the whole 57.132741 divides evenly.
    const pl = beltItemPolyline([straight(0, 0, 0), corner(1, 0, 1, 2)]);
    expect(pl.tileFlow).toHaveLength(2);
    expect(slotArcLength(0, 5, pl)).toBeCloseTo((pl.total * 4.5) / 5, 9);
  });

  it('slot 0 (head/deliver end) maps near the head (upper band, below total)', () => {
    const d = slotArcLength(0, M, PL);
    // centered band: (M - 0 - 0.5)/M = 5.5/6 => 220 of 240
    expect(d).toBeCloseTo((TOTAL * (M - 0.5)) / M); // 220
    expect(d).toBeLessThan(TOTAL); // never pinned exactly at the head
    expect(d).toBeGreaterThan(TOTAL / 2); // clearly in the head half
  });

  it('the last slot (M-1) maps near the tail (small d, above 0)', () => {
    const d = slotArcLength(M - 1, M, PL);
    // (M - (M-1) - 0.5)/M = 0.5/6 => 20 of 240
    expect(d).toBeCloseTo((TOTAL * 0.5) / M); // 20
    expect(d).toBeGreaterThan(0); // never pinned exactly at the tail
    expect(d).toBeLessThan(TOTAL / 2); // clearly in the tail half
  });

  it('is strictly monotonic decreasing from slot 0 (head) to slot M-1 (tail)', () => {
    let prev = Infinity;
    for (let i = 0; i < M; i++) {
      const d = slotArcLength(i, M, PL);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
  });

  it('uses centered per-slot bands, so consecutive slots are total/M apart', () => {
    const a = slotArcLength(2, M, PL);
    const b = slotArcLength(3, M, PL);
    expect(a - b).toBeCloseTo(TOTAL / M); // even spacing = one slot band
  });

  it('scales linearly with total (zero-length belt => 0)', () => {
    expect(slotArcLength(0, M, onePiece(0))).toBe(0);
    expect(slotArcLength(2, M, onePiece(480))).toBeCloseTo(
      2 * slotArcLength(2, M, onePiece(240)),
    );
  });
});

describe('SLOT-01: the rendered slot pitch (phase 60)', () => {
  // THIS IS THE ONE PIN A RUST RE-BLESS CANNOT REACH. Everything else that gates
  // SLOTS_PER_TILE lives in fabrico-core, where the golden corpus can be re-blessed
  // into agreeing with whatever value the constant happens to hold. This literal 8
  // sits on the far side of the IPC boundary and no corpus regeneration touches it.
  // A future reader will see a test of a pure function and be tempted to delete it
  // as redundant with the Rust-side pin. It is not redundant: it is the only
  // cross-boundary evidence that SLOT-01's stated goal of 8px was ACHIEVED rather
  // than merely intended.
  //
  // WHY SEVERAL BELT LENGTHS, AND WHY THAT IS NOT PADDING. beltItemPolyline's total
  // for an N-tile run is exactly N * CELL (the (N-1)*CELL centre span plus two HALF
  // stubs), and the slot count is SLOTS_PER_TILE * N, so
  //
  //     pitch = (N * CELL) / (SLOTS_PER_TILE * N) = CELL / SLOTS_PER_TILE
  //
  // The tile count CANCELS. Testing 1, 2, 3, 5 and 8 tiles is therefore the actual
  // claim being made (that the pitch is length-INVARIANT), not five copies of one
  // assertion. At the PRE-PHASE-60 value of 3 the pitch WAS 10.667px, which is what
  // produced the repeating 11/10/11 device-snap alternation SEED-011 recorded; at the
  // shipped value of 4 it is a uniform 8.000px because 4 divides CELL. The old value
  // is written in the past tense on purpose: it is history, not a fact about the tree.
  //
  // WHY THE 4 BELOW IS A LOCAL LITERAL AND MUST STAY ONE. It is deliberately NOT
  // imported from, nor generated out of, the Rust constant it checks. An expectation
  // derived from the thing it checks agrees with that thing at every value and can
  // never fail: the exact defect 60-VALIDATION.md's headline records for the core
  // belt suite, and the doctrine this repo already applies to the board-local elbow
  // radius and the legal-viewbox list. The source of truth it MIRRORS (by hand, on
  // purpose) is crates/fabrico-core/src/belt_slots.rs, `SLOTS_PER_TILE`.
  it('SLOT-01: places items at a uniform 8px pitch at every belt length', () => {
    const SLOTS_PER_TILE = 4; // hand-mirrored from crates/fabrico-core/src/belt_slots.rs
    for (const tiles of [1, 2, 3, 5, 8]) {
      const run: TileView[] = Array.from({ length: tiles }, (_, i) => straight(i, 0, 0));
      const pl = beltItemPolyline(run);
      const M = SLOTS_PER_TILE * tiles;
      const ds = Array.from({ length: M }, (_, s) => slotArcLength(s, M, pl));
      // EVERY consecutive pair, not merely the first two.
      for (let s = 1; s < M; s++) {
        expect(ds[s - 1] - ds[s]).toBeCloseTo(8, 6);
      }
    }
  });
});

describe('quantizedFrame — MOTION-01 10fps/24-frame index (pure fn of the render clock)', () => {
  it('exposes the bible motion constants (10fps -> 6 sim-ticks/frame, 24-frame loop)', () => {
    expect(SIM_TICKS_PER_FRAME).toBe(6);
    expect(FRAMES).toBe(24);
  });

  it('starts at frame 0 at clock 0', () => {
    expect(quantizedFrame(0)).toBe(0);
  });

  it('advances by one frame every 6 sim-ticks', () => {
    expect(quantizedFrame(5)).toBe(0);
    expect(quantizedFrame(6)).toBe(1);
    expect(quantizedFrame(11)).toBe(1);
    expect(quantizedFrame(12)).toBe(2);
  });

  it('wraps modulo 24 (frame 23 -> 0 at clock 144)', () => {
    expect(quantizedFrame(138)).toBe(23); // last frame of the loop
    expect(quantizedFrame(143)).toBe(23);
    expect(quantizedFrame(144)).toBe(0); // wrap back to the start
    expect(quantizedFrame(150)).toBe(1);
  });

  it('floors a fractional clock without throwing', () => {
    expect(quantizedFrame(6.9)).toBe(1);
    expect(quantizedFrame(11.99)).toBe(1);
    expect(quantizedFrame(0.4)).toBe(0);
  });

  it('floors and wraps a negative clock into [0,24) without throwing', () => {
    expect(() => quantizedFrame(-1)).not.toThrow();
    const f = quantizedFrame(-1);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(FRAMES);
    // floor(-1/6) = -1 -> ((-1 % 24) + 24) % 24 = 23
    expect(f).toBe(23);
  });

  it('is pure: same clock in, same frame out', () => {
    expect(quantizedFrame(37)).toBe(quantizedFrame(37));
  });
});

describe('advanceRenderClock — Ticker-driven clock chasing the sim', () => {
  const SIM_TICK_MS = 1000 / 60; // ~16.67ms per tick

  it('advances by deltaMs/simTickMs toward the lagged target', () => {
    // latest=100 -> target=100-LAG; from prev=50 a 1-tick frame advances ~1 tick.
    const next = advanceRenderClock(50, 100, SIM_TICK_MS, SIM_TICK_MS);
    expect(next).toBeCloseTo(51);
  });

  it('never overshoots the lagged target (latestSimTick - LAG_TICKS)', () => {
    // A huge frame delta would blow past; it must clamp to the target.
    const next = advanceRenderClock(98, 100, 10_000, SIM_TICK_MS);
    expect(next).toBe(100 - LAG_TICKS);
  });

  it('keeps a ~1-tick lag buffer behind the newest packet', () => {
    const next = advanceRenderClock(200, 100, 10_000, SIM_TICK_MS);
    expect(next).toBeLessThanOrEqual(100 - LAG_TICKS);
  });

  it('snaps backward on a large backward jump (seek / replay rewind)', () => {
    // latest collapses from far ahead to 30: clock must snap back, not lerp.
    const next = advanceRenderClock(500, 30, SIM_TICK_MS, SIM_TICK_MS);
    expect(next).toBe(30 - LAG_TICKS);
  });
});

// ---------------------------------------------------------------------------
// THE SEAM ITEM JUMP IS BOUNDED (plan 74.1-08, 74.1-SEAM-DESIGN.md risk 2)
// ---------------------------------------------------------------------------
//
// Since 74.1-07 a belt end's DRAWN kind follows its dock: tiles[0] flips Straight to
// Corner the moment a perpendicular dock lands, and back when it breaks, while the
// slots underneath do not move. The committed layer already places every slot on the
// tile it belongs to (`slotArcLength` over `beltItemPolyline`, which sweeps an arc for
// a Corner at either end and keys on kind), so the flip can only re-place items INSIDE
// the re-kinded tile and the tiles' flow offsets after it. This is a GUARD on that
// property, not a change: no slot may move by more than one tile (CELL world px).
describe('a dock that flips an end tile moves no item by more than one tile (74.1-08)', () => {
  const SLOTS_PER_TILE = 4; // hand-mirrored from crates/fabrico-core/src/belt_slots.rs
  const slotPoints = (tiles: TileView[]) => {
    const pl = beltItemPolyline(tiles);
    const m = SLOTS_PER_TILE * tiles.length;
    return Array.from({ length: m }, (_, s) => pointAlong(pl, slotArcLength(s, m, pl)));
  };
  const worstJump = (a: TileView[], b: TileView[]): number => {
    const pa = slotPoints(a);
    const pb = slotPoints(b);
    return Math.max(...pa.map((p, s) => Math.hypot(p.x - pb[s].x, p.y - pb[s].y)));
  };

  it('tiles[0] Straight{Y} <-> Corner{E,N} on a 4-tile belt running north', () => {
    const run = (k0: TileView['kind']): TileView[] => [
      { cell_x: 4, cell_y: 0, kind: k0 },
      straight(4, -1, 1),
      straight(4, -2, 1),
      straight(4, -3, 1),
    ];
    const jump = worstJump(run({ Straight: { axis: 1 } }), run({ Corner: { from: 1, to: 0 } }));
    expect(jump, 'NON-VACUITY: the flip re-placed something').toBeGreaterThan(0);
    expect(jump).toBeLessThanOrEqual(CELL);
  });

  it('tiles[n-1] Straight{Y} <-> Corner{S,E} on a 4-tile belt running south', () => {
    const run = (kn: TileView['kind']): TileView[] => [
      straight(7, 2, 1),
      straight(7, 3, 1),
      straight(7, 4, 1),
      { cell_x: 7, cell_y: 5, kind: kn },
    ];
    const jump = worstJump(run({ Straight: { axis: 1 } }), run({ Corner: { from: 2, to: 1 } }));
    expect(jump, 'NON-VACUITY: the flip re-placed something').toBeGreaterThan(0);
    expect(jump).toBeLessThanOrEqual(CELL);
  });
});
