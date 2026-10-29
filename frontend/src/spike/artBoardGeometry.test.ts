// The spec for the board's belt-corner arithmetic (BOARD-03, plan 57-03).
//
// Default node environment - pure arithmetic, no DOM.
//
// THE ASSERTION THIS FILE WAS BUILT FOR WAS THE DIVERGENCE ONE, AND PLAN 61-03
// INVERTED IT INTO A CONVERGENCE. When this file was written `frontend/shared/
// geometry.ts` shipped `ELBOW_R = 15` while the board computed at `BOARD_ELBOW_R = 16`,
// because BOARD-03's four published figures reproduce at 16 and at nothing else. The
// signed `61-BELT-LOCK-SUPERSESSION.md` (signed 2026-08-09) moved the shipped radius to
// 16, so the two agree and the board's published figures now REPRODUCE in the shipped
// tree. That is a good outcome and it is recorded as one: the gap this apparatus existed
// to make visible is closed rather than papered over.
//
// THE SOURCE-LEVEL IMPORT BAN SURVIVES THE CONVERGENCE, and its reason is REWRITTEN
// rather than kept. The hazard it originally named - the board DRAWING at 15 while
// PRINTING the 16 table, invisible because the drawing looks plausible and the numbers
// look right - has ceased to exist, so repeating it would be stating a false reason for
// a rule that is still worth having. The reason that remains is FIGURE STABILITY: the
// board is a published instrument whose numbers appear in `57-ART-LOCK.md`, and a
// future shipped radius change must NOT silently move a figure the maintainers already judged
// against. The board owning its own copy is what guarantees that; convergence today is
// a fact about today.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The shipped constant, imported IN THE TEST ONLY. The module under test must
// never import it - see 'the board geometry module imports nothing from
// shared/geometry' below.
import { CELL, ELBOW_R } from '../../shared/geometry.ts';
import {
  BOARD_CELL,
  BOARD_DASH,
  BOARD_DASH_REPEAT,
  BOARD_ELBOW_R,
  BOARD_GAP,
  INSET_MAGNIFICATION,
  INSET_WINDOW_U,
  LANE_WIDTHS,
  angleAtArcLength,
  centrelineTangentPoint,
  cornerPoint,
  cornerPointAtAngle,
  correctedCorner,
  dashAt,
  formatDash,
  insetCrop,
  laneFigures,
  quarterArcLength,
  treadSpans,
} from './artBoardGeometry.ts';

const SOURCE = readFileSync(new URL('./artBoardGeometry.ts', import.meta.url), 'utf8');

/** Round to n decimal places for an exact (not tolerant) comparison. */
const at = (v: number, n: number): number => Number(v.toFixed(n));

describe('artBoardGeometry - the constants', () => {
  it('declares the four candidate lane widths once, ascending, carrying no ranking', () => {
    expect(LANE_WIDTHS).toEqual([20, 24, 26, 28]);
  });

  it('pins the locked centreline dash geometry from 53-BELT-LOCK.md axis 1', () => {
    expect(BOARD_DASH).toBe(10);
    expect(BOARD_GAP).toBe(6);
    expect(BOARD_DASH_REPEAT).toBe(BOARD_DASH + BOARD_GAP);
  });

  it('keeps the cell size IDENTICAL to the shipped one - only the elbow radius diverges', () => {
    // The module declares its own CELL rather than importing it (it imports
    // nothing from shared/geometry at all). This asserts the non-import did not
    // quietly become a second, drifting source of truth: exactly ONE constant on
    // this board differs from the shipped tree, and it is BOARD_ELBOW_R.
    expect(BOARD_CELL).toBe(CELL);
  });

  it('fixes one magnification and one crop window for all four rows', () => {
    // E.3: the magnification is the neutrality-critical parameter. A per-row
    // "just enough to see it" factor would make every row look equally readable,
    // which is the opposite of the finding.
    expect(INSET_WINDOW_U).toBe(16);
    expect(INSET_MAGNIFICATION).toBe(8);
    expect(INSET_WINDOW_U * INSET_MAGNIFICATION).toBe(128); // the printed output size, every row
  });
});

describe('artBoardGeometry - BOARD_ELBOW_R and the shipped ELBOW_R', () => {
  it('BOARD_ELBOW_R and the shipped ELBOW_R now CONVERGE (plan 61-03)', () => {
    // THE PREDICTION THIS CASE MADE CAME TRUE, and it is worth recording that the
    // reddening did its job. It used to read "BOARD_ELBOW_R diverges from the shipped
    // ELBOW_R deliberately" and carried the note: "THIS ASSERTION REDDENS THE DAY PHASE
    // 61 ADOPTS 16, and that reddening is exactly the moment a human should look at this
    // again." Phase 61 adopted 16 on the signed `61-BELT-LOCK-SUPERSESSION.md`, the
    // assertion reddened, and plan 61-03 is the look. The outcome of looking:
    //
    //   - The board's figures are no longer a projection of an UNSIGNED proposal. They
    //     are a restatement of SHIPPED geometry, and they reproduce in the tree.
    //   - `57-ART-LOCK.md` section 3's "recorded dependency" framing is DISCHARGED, not
    //     merely satisfied: it said a Phase 61 refusal would invalidate these figures.
    //     Phase 61 did not refuse. It adopted.
    //   - The board keeps its own constant anyway - see the source case below for the
    //     reason, which is no longer divergence.
    expect(BOARD_ELBOW_R).toBe(16);
    expect(ELBOW_R).toBe(16);
    expect(BOARD_ELBOW_R).toBe(ELBOW_R);
  });

  it('the board geometry module STILL imports nothing from shared/geometry', () => {
    // THE RULE SURVIVES THE CONVERGENCE; ITS REASON IS REWRITTEN (plan 61-03).
    //
    // The reason this ban USED to give was that importing `ELBOW_R` would draw the
    // board at 15 while printing the 16 table - a divergence invisible in the output.
    // That hazard is GONE: the two values agree today, so an import could not produce
    // it. Repeating the old reason would leave a live rule standing on a dead fact.
    //
    // The reason that remains is PUBLISHED-FIGURE STABILITY. `57-ART-LOCK.md` quotes
    // this board's numbers, and a lane width was chosen against them. If the board read
    // the shipped constant, a future shipped radius change would silently move a figure
    // that has already been judged - and the board would keep looking correct while
    // saying something different from what it said when the decision was made. The
    // board owning its own copy is what makes the published figures reproducible from
    // the board alone. Plan 57-03's mutation M6 proved the VALUE assertion does not
    // catch an import and the NON-IMPORT source check does, so the source form is kept.
    //
    // Checked as MODULE SPECIFIERS, not as a substring: the module's docblock is
    // REQUIRED to name `frontend/shared/geometry.ts` in prose (that is how a reader
    // learns the separate constant is deliberate), so a bare `not.toContain` would
    // forbid the very documentation the rule depends on.
    const imports = SOURCE.split('\n').filter((l) => /^\s*import\s/.test(l));
    expect(imports).toEqual([]);
    expect(SOURCE).not.toMatch(/from\s*['"][^'"]*shared\/geometry/);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/); // no dynamic import either
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  it('does not confuse BOARD_DASH_REPEAT with BOARD_ELBOW_R even though both are 16', () => {
    // The 16/16 collision (RESEARCH F6.2). The quarter-arc carries 1.5708 DASH
    // REPEATS - the divisor is the dash repeat, NOT the radius. They are the same
    // integer for entirely unrelated reasons, so any expression writing
    // `arcLen / R` here is coincidentally correct today and wrong the moment
    // either constant moves.
    expect(BOARD_DASH_REPEAT).toBe(BOARD_ELBOW_R); // the coincidence, stated
    expect(at(quarterArcLength() / BOARD_DASH_REPEAT, 4)).toBe(1.5708);
  });
});

describe('artBoardGeometry - the four lane widths (BOARD-03)', () => {
  it('the four inner-rail dashes are computed from BOARD_ELBOW_R and equal 3.750 / 2.500 / 1.875 / 1.250', () => {
    expect(LANE_WIDTHS.map((w) => at(laneFigures(w).innerDash, 3))).toEqual([3.75, 2.5, 1.875, 1.25]);
    // And as the board prints them, fixed-format to 3 dp.
    expect(LANE_WIDTHS.map((w) => formatDash(laneFigures(w).innerDash))).toEqual([
      '3.750',
      '2.500',
      '1.875',
      '1.250',
    ]);
  });

  it('derives the inner radii and the outer rail from the same radius', () => {
    expect(LANE_WIDTHS.map((w) => laneFigures(w).laneHalf)).toEqual([10, 12, 13, 14]);
    expect(LANE_WIDTHS.map((w) => laneFigures(w).rInner)).toEqual([6, 4, 3, 2]);
    expect(LANE_WIDTHS.map((w) => laneFigures(w).rOuter)).toEqual([26, 28, 29, 30]);
    expect(LANE_WIDTHS.map((w) => at(laneFigures(w).outerDash, 3))).toEqual([16.25, 17.5, 18.125, 18.75]);
  });

  it('prints both ratio columns at the precision the board shows', () => {
    expect(LANE_WIDTHS.map((w) => at(laneFigures(w).outerOverInner, 2))).toEqual([4.33, 7, 9.67, 15]);
    expect(LANE_WIDTHS.map((w) => at(laneFigures(w).innerOverLane, 3))).toEqual([0.3, 0.167, 0.115, 0.071]);
  });

  it('shows the axis-3 joint guard as a NON-discriminator: all four widths satisfy it', () => {
    // 53-BELT-LOCK.md axis 3's guard is `rail < laneHalf <= elbowR`, asserted on
    // the SHIPPED record at beltPainter.metrics.test.ts:235 with
    // `elbowR - laneHalf === 1` exactly. At R = 16 the four candidates give
    // 6 / 4 / 3 / 2 - all >= 1, so all four are legal and the guard separates
    // none of them. Printed anyway: a column where all four agree is worth
    // showing as a non-discriminator rather than omitting.
    const margins = LANE_WIDTHS.map((w) => laneFigures(w).elbowMinusLaneHalf);
    expect(margins).toEqual([6, 4, 3, 2]);
    for (const m of margins) expect(m).toBeGreaterThanOrEqual(1);
    expect(new Set(margins).size).toBeGreaterThan(1); // they differ, but none is disqualified
  });

  it('reports a zero corner pinch for all four widths, by construction', () => {
    expect(LANE_WIDTHS.map((w) => laneFigures(w).cornerPinch)).toEqual([0, 0, 0, 0]);
  });

  it('states UI-SPEC E.3s GEOMETRY-SPACE row: the four dashes scaled by the magnification', () => {
    // RE-SCOPED (review WR-11). This test used to be called "renders the inset dashes
    // at 8x as 30 / 20 / 15 / 10 px" and its comment claimed the figures were "how
    // 1.250 px is made visible at all". BOTH HALVES OF THAT WERE WRONG.
    //
    // It is not a rendering claim. `renderInsetCell` extracts at ZOOM 1 into a 16x16
    // backing store and then upscales 8x with `imageSmoothingEnabled = false`
    // (artBoardLanes.ts). A 1.250 px arc mark rasterised into a 1 px/unit buffer
    // occupies one or two WHOLE pixels and magnifies to an 8 or 16 px block - never
    // 10 px. The number 10 does not appear anywhere in the output, so nothing in the
    // rendered inset corresponds to this figure.
    //
    // And it is not independent coverage: it multiplies `innerDash`, pinned four tests
    // above, by `INSET_MAGNIFICATION`, pinned two tests before that. It cannot fail
    // unless one of those already fails.
    //
    // What it IS: E.3's printed row, in geometry space, derived rather than
    // transcribed. Kept at that scope and named as it, so the next reader does not take
    // it for a measurement of the inset. THE RENDERING CLAIM IS ASSERTED IN THE E2E, by
    // `art board: every lane inset is opaque, in-palette, non-empty and DIFFERENT from
    // the other three`, which reads the actual inset pixels (WR-02).
    expect(LANE_WIDTHS.map((w) => at(laneFigures(w).innerDash * INSET_MAGNIFICATION, 3))).toEqual([
      30, 20, 15, 10,
    ]);
  });

  it('freezes each figure record so a consumer cannot edit a printed number', () => {
    const f = laneFigures(20);
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('rejects a lane width that is not one of the four candidates', () => {
    expect(() => laneFigures(22)).toThrow();
  });
});

describe('artBoardGeometry - the arc', () => {
  it('carries a 25.133 px quarter-arc centreline at BOARD_ELBOW_R', () => {
    expect(at(quarterArcLength(), 3)).toBe(25.133);
  });

  it('scales the dash linearly with radius about the centreline rate', () => {
    // Phase advances at the CENTRELINE rate, so a point at radius r shows a dash
    // of DASH * r / R. At the centreline itself the dash is the locked 10.
    expect(dashAt(BOARD_ELBOW_R)).toBe(BOARD_DASH);
    expect(dashAt(0)).toBe(0);
    expect(at(dashAt(6), 3)).toBe(3.75);
  });

  it('puts the arc tangent point exactly on the tile-edge midpoint at BOARD_ELBOW_R', () => {
    // At R = CELL / 2 the arc centres on the tile CORNER, so its tangent points
    // fall exactly at the tile-edge midpoints and no straight stub is required.
    expect(centrelineTangentPoint()).toEqual({ x: 0, y: 16 });
  });

  it('would move the crop window off the tile edge at the shipped 15', () => {
    // The same construction at R = 15 (local recompute - the module exports one
    // radius only). The tangent point sits 1 px INSIDE the tile, so the 16u
    // window is not the same crop, and the 1 px gap is the straight stub that is
    // the geometric root of SEED-012's defects.
    const tangentAt = (r: number): { x: number; y: number } => ({ x: BOARD_CELL / 2 - r, y: BOARD_CELL / 2 });
    expect(tangentAt(15)).toEqual({ x: 1, y: 16 });
    expect(tangentAt(BOARD_ELBOW_R)).toEqual(centrelineTangentPoint());
  });
});

describe('artBoardGeometry - the corrected quarter arc (D-12)', () => {
  /** Euclidean distance, for the lane-width-constancy sweep. */
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    Math.hypot(a.x - b.x, a.y - b.y);

  /** Nine parameter samples across the bend, endpoints included. */
  const SAMPLES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

  it('centres the arc on the tile corner and derives every radius from BOARD_ELBOW_R', () => {
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      const f = laneFigures(lane);
      // The arc centre is the TILE CORNER at this radius - that is the whole of
      // SEED-012's construction. At the shipped 15 it would sit 1px inside the tile.
      expect(c.centre).toEqual({ x: BOARD_CELL / 2 - BOARD_ELBOW_R, y: BOARD_CELL / 2 - BOARD_ELBOW_R });
      expect(c.rCentre).toBe(BOARD_ELBOW_R);
      expect(c.rInner).toBe(f.rInner);
      expect(c.rOuter).toBe(f.rOuter);
    }
  });

  it('freezes the description so a consumer cannot edit the drawn geometry', () => {
    const c = correctedCorner(20);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.treads)).toBe(true);
  });

  it('rejects a lane width that is not one of the four candidates', () => {
    expect(() => correctedCorner(22)).toThrow();
  });

  it('holds the lane width CONSTANT along the whole arc, for every candidate', () => {
    // D-12's defining property, and the reason the corner pinch is 0 by
    // construction rather than by four independent measurements: the swept lane is
    // the region between two CONCENTRIC arcs, so outer-minus-inner is the lane at
    // every parameter value. Today's shipped bake measures the corner lane across
    // the tile-edge span instead and reports a 4px pinch.
    const divergence: string[] = [];
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      for (const t of SAMPLES) {
        const width = dist(cornerPoint(c, c.rOuter, t), cornerPoint(c, c.rInner, t));
        if (Math.abs(width - lane) > 1e-9) divergence.push(`lane ${lane} at t=${t}: ${width}`);
      }
    }
    expect(divergence).toEqual([]);
  });

  it('lands its tangent points exactly on the tile-edge midpoints, so no straight stub is needed', () => {
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      // The CENTRELINE enters at the west edge midpoint and leaves at the north one.
      expect(c.entry.x).toBeCloseTo(0, 9);
      expect(c.entry.y).toBeCloseTo(BOARD_CELL / 2, 9);
      expect(c.exit.x).toBeCloseTo(BOARD_CELL / 2, 9);
      expect(c.exit.y).toBeCloseTo(0, 9);
      // And the entry point is the SAME point the inset crop is centred on.
      expect(c.entry.x).toBeCloseTo(centrelineTangentPoint().x, 9);
      expect(c.entry.y).toBeCloseTo(centrelineTangentPoint().y, 9);

      // THE STRONGER FORM: at t=0 the WHOLE lane cross-section lies on the tile's
      // west edge (x = 0), spanning exactly the entering straight lane, and at t=1
      // on the north edge (y = 0). That is what "no straight stub" actually means -
      // every concentric arc, inner rail included, is tangent to its own straight
      // lane edge at the tile boundary.
      for (const r of [c.rInner, c.rCentre, c.rOuter]) {
        expect(cornerPoint(c, r, 0).x).toBeCloseTo(0, 9);
        expect(cornerPoint(c, r, 1).y).toBeCloseTo(0, 9);
      }
      expect(cornerPoint(c, c.rInner, 0).y).toBeCloseTo(BOARD_CELL / 2 - lane / 2, 9);
      expect(cornerPoint(c, c.rOuter, 0).y).toBeCloseTo(BOARD_CELL / 2 + lane / 2, 9);
    }
  });

  it('carries quarterArcLength() of centreline and 1.5708 DASH REPEATS through the bend', () => {
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      expect(c.arcLength).toBe(quarterArcLength());
      // THE DIVISOR IS BOARD_DASH_REPEAT, NOT BOARD_ELBOW_R. Both are 16, for
      // entirely unrelated reasons (RESEARCH F6.2) - one is a dash period, the
      // other a radius.
      expect(at(c.repeats, 4)).toBe(at(quarterArcLength() / BOARD_DASH_REPEAT, 4));
      expect(at(c.repeats, 4)).toBe(1.5708);
    }
  });

  it('advances the tread schedule at the CENTRELINE rate, starting at the entry tangent', () => {
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      // Two treads fall inside a quarter bend at the locked 10/6 dash: one at the
      // entry tangent and one a full DASH REPEAT later, the second clipped by the
      // end of the arc.
      expect(c.treads.length).toBe(2);
      expect(c.treads.map((t) => t.startS)).toEqual([0, BOARD_DASH_REPEAT]);
      expect(c.treads[0]?.endS).toBe(BOARD_DASH);
      // Clipped, never running past the tile boundary into the next tile's phase.
      expect(c.treads[1]?.endS).toBe(c.arcLength);
      // Phase advances at the centreline rate: one full tread subtends DASH of
      // CENTRELINE arc, so its angular extent is DASH / R.
      expect(c.treadAngle).toBeCloseTo(BOARD_DASH / BOARD_ELBOW_R, 12);
      const first = c.treads[0] as { startAngle: number; endAngle: number };
      expect(first.startAngle - first.endAngle).toBeCloseTo(c.treadAngle, 12);
    }
  });

  it('collapses the mark to DASH * r / R at every radius - the arithmetic the strip prints', () => {
    // THIS is D-11 at its source. The tread is square to the flow and its angular
    // extent is fixed, so the arc length it subtends at radius r is treadAngle * r,
    // which is exactly dashAt(r). The four printed inner-rail figures are read out
    // of this one schedule; none is typed.
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      for (const r of [c.rInner, c.rCentre, c.rOuter]) {
        expect(c.treadAngle * r).toBeCloseTo(dashAt(r), 12);
      }
      expect(c.innerMark).toBeCloseTo(laneFigures(lane).innerDash, 12);
      expect(c.outerMark).toBeCloseTo(laneFigures(lane).outerDash, 12);
    }
    expect(LANE_WIDTHS.map((w) => formatDash(correctedCorner(w).innerMark))).toEqual([
      '3.750',
      '2.500',
      '1.875',
      '1.250',
    ]);
  });
});

describe('artBoardGeometry - ONE parameterisation, drawn from and asserted on (CR-02)', () => {
  // THE JOIN ASSERTIONS. Every test above this block proves a property of
  // `cornerPoint` / `correctedCorner`, and every one of them is only worth its
  // reading if the STRIP DRAWS through the same functions. Until plan 57-11 it did
  // not: `artBoardLanes.ts` carried a duplicate `polar()`, an inline copy of the
  // arc-length-to-angle mapping and a second tread loop, so the assertions above
  // proved properties of code the board did not draw with. They agreed by coincidence
  // of shared constants and nothing reddened if they diverged.
  //
  // These tests pin the shared primitives the drawing now calls. `artBoardLanes.source
  // .test.ts` carries the other half: that no second local implementation comes back.

  it('resolves cornerPoint(t) through cornerPointAtAngle - one polar primitive', () => {
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const angle = c.startAngle + (c.endAngle - c.startAngle) * t;
        for (const r of [c.rInner, c.rCentre, c.rOuter]) {
          expect(cornerPoint(c, r, t)).toEqual(cornerPointAtAngle(c, r, angle));
        }
      }
    }
  });

  it('maps arc length to angle about rCentre, and agrees with the t parameterisation', () => {
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      // s = 0 is the entry tangent; s = arcLength is the exit.
      expect(angleAtArcLength(c, 0)).toBe(c.startAngle);
      expect(angleAtArcLength(c, c.arcLength)).toBeCloseTo(c.endAngle, 12);
      // THE DIVISOR IS THE RADIUS, NOT BOARD_DASH_REPEAT. Both are 16 for unrelated
      // reasons, so this asserts which one is meant: at s = rCentre the angle has
      // fallen by exactly one radian.
      expect(c.startAngle - angleAtArcLength(c, c.rCentre)).toBeCloseTo(1, 12);
      expect(c.rCentre).toBe(BOARD_ELBOW_R);
      // The two parameterisations are one geometry: arc length s corresponds to
      // t = s / arcLength.
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const viaS = cornerPointAtAngle(c, c.rInner, angleAtArcLength(c, t * c.arcLength));
        const viaT = cornerPoint(c, c.rInner, t);
        expect(viaS.x).toBeCloseTo(viaT.x, 12);
        expect(viaS.y).toBeCloseTo(viaT.y, 12);
      }
    }
  });

  it('builds correctedCorner().treads from treadSpans - ONE schedule, not two', () => {
    // THE ASSERTION THE STRIP'S DIVERGENCE HAZARD ACTUALLY NEEDED. The printed
    // figures read `treads`; the drawing calls `treadSpans` over the wider span its
    // straight runs cover. This proves they are the same function, so the two cannot
    // drift silently.
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      expect(treadSpans(c, 0, c.arcLength)).toEqual(c.treads);
    }
  });

  it('carries the tread phase CONTINUOUSLY across both corner seams', () => {
    // The span the strip actually draws: one tile of straight run either side of the
    // bend. The schedule is keyed to s = 0 at the entry tangent with an ABSOLUTE
    // phase, which is what carries the pattern through the seam instead of restarting
    // it there (SEED-012 defect 2). Six treads at the locked 10/6 dash.
    const c = correctedCorner(LANE_WIDTHS[0] as number);
    const spans = treadSpans(c, -BOARD_CELL, c.arcLength + BOARD_CELL);
    expect(spans.map((t) => t.startS)).toEqual([-32, -16, 0, 16, 32, 48]);
    // Every tread is a full BOARD_DASH except the last, which the end of the run clips.
    for (const t of spans.slice(0, -1)) expect(t.endS - t.startS).toBe(BOARD_DASH);
    expect(spans[spans.length - 1]?.endS).toBeCloseTo(c.arcLength + BOARD_CELL, 12);
    // Every start is a whole multiple of the dash repeat - the absolute phase.
    // `Math.abs` because `-32 % 16` is `-0`, which `toBe(0)` refuses under Object.is.
    for (const t of spans) expect(Math.abs(t.startS % BOARD_DASH_REPEAT)).toBe(0);
  });

  it('clips a tread to the requested span rather than letting it overrun', () => {
    const c = correctedCorner(LANE_WIDTHS[0] as number);
    // A span that begins mid-tread and ends mid-tread: both ends are cut, never
    // extended past what was asked for. THE LEADING EDGE IS THE TRAP - the tread that
    // began at s = 0 runs into this span and is kept, clipped to [4, 10]. A schedule
    // built with `Math.ceil` drops it silently and leaves a hole no caller can see.
    expect(treadSpans(c, 4, 20).map((t) => [t.startS, t.endS])).toEqual([
      [4, 10],
      [16, 20],
    ]);
    // A span falling entirely in a GAP is empty, never a zero-length artefact.
    expect(treadSpans(c, 11, 15)).toEqual([]);
  });

  it('is unchanged at the two spans this board actually draws', () => {
    // The floor-vs-ceil correction above is a no-op for both real callers, because both
    // pass an s0 that is an exact multiple of the dash repeat. Pinned so the correction
    // cannot be read as having moved a drawn pixel.
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      for (const s0 of [0, -BOARD_CELL]) {
        expect(Math.floor(s0 / BOARD_DASH_REPEAT)).toBe(Math.ceil(s0 / BOARD_DASH_REPEAT));
      }
      // The bend's own schedule: two treads, the second clipped by the end of the arc.
      expect(c.treads.map((t) => [t.startS, t.endS])).toEqual([
        [0, BOARD_DASH],
        [BOARD_DASH_REPEAT, c.arcLength],
      ]);
    }
  });

  it('freezes the spans so a caller cannot edit the drawn schedule', () => {
    const c = correctedCorner(LANE_WIDTHS[0] as number);
    const spans = treadSpans(c, 0, c.arcLength);
    expect(Object.isFrozen(spans)).toBe(true);
    expect(Object.isFrozen(spans[0])).toBe(true);
  });
});

describe('artBoardGeometry - the fixed inset crop (E.3)', () => {
  it('returns ONE window, square, INSET_WINDOW_U on a side', () => {
    const crop = insetCrop();
    expect(crop.w).toBe(INSET_WINDOW_U);
    expect(crop.h).toBe(INSET_WINDOW_U);
    expect(crop.w * INSET_MAGNIFICATION).toBe(128); // the printed output size, every row
  });

  it('contains EVERY candidate inner rail, on the straight and through the bend', () => {
    // THE PROPERTY THE INSET COLUMN EXISTS FOR, asserted directly rather than through
    // the anchor point it happens to be built from. If the window does not contain the
    // inner rail, the inset shows flat lane interior and the smallest mark is exactly
    // as invisible in the magnified column as it is in the artwork cell.
    const crop = insetCrop();
    const inside = (p: { x: number; y: number }): boolean =>
      p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h;

    // Half the window lies WEST of the tile boundary, which is what puts the
    // straight-to-bend transition inside it rather than only the bend.
    expect(crop.x).toBeLessThan(0);

    const outside: string[] = [];
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      // The inner rail on the straight approach. It is a horizontal line at
      // `BOARD_CELL / 2 - lane / 2` running west out of the tile, so the window
      // contains part of it exactly when that ordinate is inside the window's y span -
      // sampled here at the window's own west edge.
      const straight = { x: crop.x, y: BOARD_CELL / 2 - lane / 2 };
      if (!inside(straight)) outside.push(`lane ${lane}: straight inner rail at y=${straight.y}`);
      // And the inner rail at three points through the bend.
      for (const t of [0, 0.5, 1]) {
        const p = cornerPoint(c, c.rInner, t);
        if (!inside(p)) outside.push(`lane ${lane}: bend inner rail at t=${t}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('would contain NO inner rail if it were centred on the centreline tangent point', () => {
    // THE COUNTER-CHECK, recorded so the correction cannot be quietly undone. A window
    // centred on `centrelineTangentPoint()` - which is the CENTRELINE's tangent point -
    // spans the middle of the lane and misses all four inner rails, on the straight and
    // through the bend alike. That window makes every row look identical, which is the
    // "every row is equally readable" failure in its other form.
    const p = centrelineTangentPoint();
    const centred = { x: p.x - INSET_WINDOW_U / 2, y: p.y - INSET_WINDOW_U / 2 };
    const insideCentred = (q: { x: number; y: number }): boolean =>
      q.x >= centred.x &&
      q.x <= centred.x + INSET_WINDOW_U &&
      q.y >= centred.y &&
      q.y <= centred.y + INSET_WINDOW_U;

    const contained: string[] = [];
    for (const lane of LANE_WIDTHS) {
      const c = correctedCorner(lane);
      if (insideCentred({ x: centred.x, y: BOARD_CELL / 2 - lane / 2 })) {
        contained.push(`lane ${lane}: straight`);
      }
      for (const t of [0, 0.5, 1]) {
        if (insideCentred(cornerPoint(c, c.rInner, t))) contained.push(`lane ${lane}: bend t=${t}`);
      }
    }
    expect(contained).toEqual([]);
  });

  it('is IDENTICAL for all four lanes - the neutrality-critical property', () => {
    // The function takes no lane argument at all, which is stronger than four
    // equal results: a per-row crop cannot be written without changing the
    // signature. A per-row "just enough to see it" window would make every row
    // look equally readable, which is the opposite of the finding.
    const crops = LANE_WIDTHS.map(() => insetCrop());
    for (const crop of crops) expect(crop).toEqual(crops[0]);
    expect(insetCrop.length).toBe(0);
  });
});

describe('artBoardGeometry - the R = 15 counter-check', () => {
  it('at R = 15 the same formula reproduces none of BOARD-03s published figures', () => {
    // A LOCAL pure helper, never a second export: the module has exactly one
    // radius. This is what proves 16 is the assumption in play - the published
    // figures are not a property of the formula, they are a property of R = 16.
    const innerDashAt = (lane: number, r: number): number => (BOARD_DASH * (r - lane / 2)) / r;

    const atFifteen = LANE_WIDTHS.map((w) => at(innerDashAt(w, 15), 3));
    expect(atFifteen).toEqual([3.333, 2, 1.333, 0.667]);

    const published = [3.75, 2.5, 1.875, 1.25];
    for (const v of atFifteen) expect(published).not.toContain(v);

    // And the same helper at 16 DOES reproduce them, so the divergence is the
    // radius and not the formula.
    expect(LANE_WIDTHS.map((w) => at(innerDashAt(w, 16), 3))).toEqual(published);

    // 0.667 is the MEASURED DEFECTIVE value on the tree as it stands today
    // (SEED-012 defect 3: ELBOW_R - LANE_HALF = 15 - 14 = 1 at the shipped lane 28).
    expect(atFifteen[3]).toBe(0.667);
  });
});

describe('artBoardGeometry - the four figures are computed, never typed', () => {
  it('does not carry any of the four published dash figures as a source literal', () => {
    // The prohibition, asserted rather than left to a shell grep: a typed literal
    // would survive mutation M1 (BOARD_ELBOW_R 16 -> 15) and the figures would
    // stop being derived without anything reddening.
    //
    // `2\.5` AND NOT `2\.50` (review WR-10). The natural hardcode of the lane-24 figure
    // is `2.5` - it only becomes `2.500` after `formatDash`'s `toFixed(3)` - so
    // `const LANE_24_INNER = 2.5;` satisfied the old alternative and one of the four
    // figures was ungated. `2\.5` still matches `2.500`, so nothing is lost by
    // dropping the trailing zero.
    //
    // `16\.25` joins them: the lane-20 OUTER dash is a published figure too, and the
    // same mutation argument applies to it. Verified against the committed module: zero
    // hits, so this tightening reddens on nothing that is there today.
    expect(SOURCE).not.toMatch(/3\.75|2\.5|1\.875|1\.25|16\.25/);
  });

  it('records BOARD-03s rounded 1.88 against the exact value it prints', () => {
    // BOARD-03's text quotes 1.88 for lane 26; the exact value is 1.875. The board
    // prints the exact figure, so the rounding is recorded here and in the module
    // and a reader comparing the two documents does not think they disagree.
    expect(Number(formatDash(laneFigures(26).innerDash))).toBeCloseTo(1.88, 2);
    expect(formatDash(laneFigures(26).innerDash)).toBe('1.875');
  });
});
