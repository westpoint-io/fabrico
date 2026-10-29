// The art board's belt-corner arithmetic (BOARD-03, plan 57-03): the ONE source
// of the four dash figures the lane-width strip prints, and of the crop window its
// magnified inset uses.
//
// THIS MODULE IMPORTS NOTHING. Not from `frontend/shared/geometry.ts`, not from
// anywhere - and that is the entire point of it existing as a separate module
// rather than as arithmetic inside the strip. See BOARD_ELBOW_R below.
//
// WHAT THIS MODULE IS NOT. It is not shipped geometry and nothing outside
// `src/spike/` may import it. It records an arithmetic consequence of an UNSIGNED
// proposal so a human can judge it; it does not adopt that proposal.

/* ------------------------------------------------------------------ *
 * The board-local geometry constants
 * ------------------------------------------------------------------ */

/**
 * The grid cell size, in px at zoom 1.
 *
 * Declared here rather than imported because this module imports nothing at all
 * (see BOARD_ELBOW_R). It is NOT a divergence: `artBoardGeometry.test.ts` asserts
 * `BOARD_CELL === CELL` against the shipped constant, so the non-import cannot
 * quietly become a second, drifting source of truth. As of plan 61-03 NO constant on
 * this board differs from the shipped tree - the elbow radius, which was the one
 * exception, converged when the shipped value moved to 16.
 */
export const BOARD_CELL = 32;

/**
 * The corner-elbow rounding radius THE BOARD COMPUTES AT. It was the sharpest edge in
 * Phase 57; Phase 61 settled it.
 *
 * WHAT THIS DOCBLOCK USED TO SAY, AND WHY IT NO LONGER SAYS IT. Through Phase 57 and
 * Phase 60 this paragraph read "**NOT SIGNED**" of SEED-012's proposed
 * supersession of `53-BELT-LOCK.md` axis 3, and named the shipped constant as
 * `ELBOW_R = 15`. Both statements are now FALSE, and leaving them would be the exact
 * failure SEED-012's gate exists to prevent, only inverted: a signed record described
 * in shipped source as unsigned.
 *
 * **IT WAS SIGNED ON 2026-08-09** (`61-BELT-LOCK-SUPERSESSION.md`). The proposal was
 * `R = CELL / 2`: the arc centred on the tile CORNER, so its tangent points fall
 * exactly at the tile-edge midpoints and no straight stub is required. Plan 61-03
 * moved `frontend/shared/geometry.ts`'s `ELBOW_R` to 16 accordingly, and verified the
 * tangent-midpoint property executably (`beltGeometry.test.ts`) rather than citing it.
 * So the shipped tree and this board now agree, and BOARD-03's four published figures
 * REPRODUCE in the tree instead of describing a belt it did not draw.
 *
 * THIS MODULE STILL DOES NOT IMPORT THE SHIPPED CONSTANT, and the reason has changed
 * with the fact. The old reason was that importing it would DRAW the corner at 15 while
 * PRINTING the 16 table - a divergence invisible in the output. That hazard is gone
 * with the divergence. The reason that remains is PUBLISHED-FIGURE STABILITY: this
 * board is a decision instrument whose numbers `57-ART-LOCK.md` quotes and the maintainers chose a
 * lane width against, so a future shipped radius change must not silently move a figure
 * that has already been judged. The board owning its own copy is what guarantees the
 * published figures stay reproducible from the board alone. `artBoardGeometry.test.ts`
 * asserts both halves: the two values CONVERGE today, and the source carries no import.
 *
 * `shared/geometry.ts`'s own docblock no longer contradicts this value. It used to
 * argue "15 < CELL/2 = 16, so the rounded arc's tangent points fall inside the tile";
 * plan 61-03 recorded that reasoning as INVERTED (the tangents fall inside at 16 too,
 * so the strict bound never discriminated) and rewrote it around the constraint that
 * actually binds.
 */
export const BOARD_ELBOW_R = 16;

/**
 * The locked centreline dash, px (`53-BELT-LOCK.md` axis 1, the locked 10/6 dash).
 * Mirrored at `beltPainter.metrics.test.ts:108`. Transcribed, never re-derived.
 */
export const BOARD_DASH = 10;

/** The locked centreline gap, px (`53-BELT-LOCK.md` axis 1). */
export const BOARD_GAP = 6;

/**
 * The dash repeat, px: `BOARD_DASH + BOARD_GAP`.
 *
 * AN AMBIGUITY TRAP, NAMED. This is the same integer as `BOARD_ELBOW_R`, for
 * entirely unrelated reasons - one is a dash period, the other a radius. The
 * quarter-arc carries `quarterArcLength() / BOARD_DASH_REPEAT` repeats through a
 * bend, and that divisor is THE DASH REPEAT, not the radius. Any expression that
 * writes `arcLen / R` here is coincidentally correct today and wrong the moment
 * either constant moves, so every expression names which constant it means.
 */
export const BOARD_DASH_REPEAT = BOARD_DASH + BOARD_GAP;

/**
 * The four candidate lane widths, px, ascending (57-CONTEXT.md D-09).
 *
 * ASCENDING ORDER CARRIES NO RANKING - it is the only order a reader can scan. A
 * continuous slider was rejected: it invites fiddling and produces no lockable
 * number, and the board's output has to be a value a human can write into
 * `57-ART-LOCK.md`.
 */
export const LANE_WIDTHS = [20, 24, 26, 28] as const;

/** The inset crop window, in belt-local units, square. Identical in all four rows. */
export const INSET_WINDOW_U = 16;

/**
 * The inset magnification, nearest-neighbour.
 *
 * THIS IS THE NEUTRALITY-CRITICAL PARAMETER. Identical factor, identical crop and
 * identical canvas size in all four rows, and the factor is printed on the board.
 * A per-row "just enough to see it" magnification would make every row look
 * equally readable, which is the exact opposite of the finding the strip exists to
 * show. Nearest-neighbour only: smoothing would invent detail that is not in the
 * render.
 */
export const INSET_MAGNIFICATION = 8;

/* ------------------------------------------------------------------ *
 * The arithmetic
 * ------------------------------------------------------------------ */

/**
 * The dash length visible at radius `r` through a bend, px.
 *
 * Phase advances at the CENTRELINE rate, so a point at radius `r` shows a dash
 * scaled by `r / BOARD_ELBOW_R`. At the centreline this is the locked dash itself.
 */
export function dashAt(r: number): number {
  return (BOARD_DASH * r) / BOARD_ELBOW_R;
}

/** The quarter-arc centreline length through one corner tile, px. */
export function quarterArcLength(): number {
  return (Math.PI / 2) * BOARD_ELBOW_R;
}

/**
 * The centre of the magnified inset's crop window, in tile-local px.
 *
 * The tile spans `[0, BOARD_CELL]` on both axes; flow enters at the WEST edge
 * midpoint and leaves at the NORTH edge midpoint, so the arc centre sits at
 * `(BOARD_CELL / 2 - R, BOARD_CELL / 2 - R)` and the arc is tangent to the
 * entering straight run at abscissa `BOARD_CELL / 2 - R`.
 *
 * EVERY concentric arc - the centreline and both rails, inner included - is
 * tangent to its own straight lane edge at THAT SAME abscissa, which is why one
 * lane-independent window contains the inner-rail transition for all four
 * candidate widths. That lane-independence is required: E.3's crop must be
 * identical in every row or the rows stop being comparable.
 *
 * IT MOVES WITH THE RADIUS, which is the reason it lives here rather than in the
 * strip. At `BOARD_ELBOW_R = BOARD_CELL / 2` the point is exactly the tile-edge
 * midpoint and the arc needs no straight stub. At the shipped 15 it sits 1 px
 * inside the tile, the two windows are not the same crop, and that 1 px stub is
 * the geometric root of SEED-012's reported defects.
 *
 * CORRECTION (plan 57-08, measured): this point is the CENTRELINE's tangent point,
 * and the tangency fact above is right - but a `INSET_WINDOW_U` window CENTRED on
 * it contains no rail at all. Its span is the middle of the lane, while the four
 * candidates put their inner rails at radii 6 / 4 / 3 / 2 about the arc centre,
 * every one of them outside such a window. An inset cropped there shows flat lane
 * interior in all four rows, identically - which is the "every row looks equally
 * readable" failure in its other form. `insetCrop()` therefore anchors on the ARC
 * CENTRE, and its spec carries this counter-check so an edit back to this point
 * reddens.
 *
 * RENAMED FROM `innerRailTangentPoint` (review WR-03). It returns
 * `{ x: CELL/2 - R, y: CELL/2 }`, which is the CENTRELINE's tangent point and not the
 * inner rail's - the docblock above already said so, and the misnaming is what produced
 * the measured 57-08 crop defect in the first place. Leaving an exported
 * `innerRailTangentPoint()` in the module after that is a trap for the next reader:
 * Phase 61 authors would find it and reasonably use it for an inner rail. The name now
 * says what the function returns.
 */
export function centrelineTangentPoint(): { readonly x: number; readonly y: number } {
  return { x: BOARD_CELL / 2 - BOARD_ELBOW_R, y: BOARD_CELL / 2 };
}

/** One printed row of the lane-width strip. Every field is COMPUTED. */
export interface LaneFigures {
  /** The candidate lane width, px. */
  readonly lane: number;
  /** Half the lane, px - the rail offset from the centreline. */
  readonly laneHalf: number;
  /** The inner-rail radius, px. */
  readonly rInner: number;
  /** The dash visible on the inner rail through a bend, px. THE headline figure. */
  readonly innerDash: number;
  /** The outer-rail radius, px. */
  readonly rOuter: number;
  /** The dash visible on the outer rail through a bend, px. */
  readonly outerDash: number;
  /** Outer dash : inner dash. How far apart the two rails read through one bend. */
  readonly outerOverInner: number;
  /** Inner radius : lane width. */
  readonly innerOverLane: number;
  /** The `53-BELT-LOCK.md` axis-3 joint margin, `elbowR - laneHalf`. */
  readonly elbowMinusLaneHalf: number;
  /** The corner pinch, px. Definitional - see `laneFigures`. */
  readonly cornerPinch: number;
}

/**
 * The full printed row for one candidate lane width.
 *
 * EVERY FIELD IS COMPUTED FROM `BOARD_ELBOW_R` AND `BOARD_DASH`. None is
 * transcribed: a typed figure would survive a change of radius and the strip would
 * stop being a derivation while still looking like one.
 */
export function laneFigures(lane: number): LaneFigures {
  if (!(LANE_WIDTHS as readonly number[]).includes(lane)) {
    throw new RangeError(
      `laneFigures: ${lane} is not one of the four candidate widths (${LANE_WIDTHS.join(', ')})`,
    );
  }

  const laneHalf = lane / 2;
  const rInner = BOARD_ELBOW_R - laneHalf;
  const rOuter = BOARD_ELBOW_R + laneHalf;
  const innerDash = dashAt(rInner);
  const outerDash = dashAt(rOuter);

  return Object.freeze({
    lane,
    laneHalf,
    rInner,
    innerDash,
    rOuter,
    outerDash,
    outerOverInner: outerDash / innerDash,
    innerOverLane: rInner / lane,

    // The axis-3 joint guard is `rail < laneHalf <= elbowR`, asserted on the
    // SHIPPED record at `beltPainter.metrics.test.ts:235` with a margin of exactly
    // +1. At this radius all four candidates clear it, so the guard is NOT a
    // discriminator between them. Printed anyway: a column where all four agree is
    // worth showing as a non-discriminator rather than quietly omitting.
    elbowMinusLaneHalf: BOARD_ELBOW_R - laneHalf,

    // DEFINITIONAL, NOT MEASURED. Under the corrected geometry the swept corner
    // lane has constant width equal to the lane BY CONSTRUCTION, so the pinch is
    // zero for every width - one consequence of one construction, not four
    // independent measurements, and it must not read on the board as the latter.
    // (Today's shipped bake reports a 4 px pinch because it measures the corner
    // lane ACROSS the tile-edge span rather than perpendicular to the flow.)
    cornerPinch: 0,
  });
}

/* ------------------------------------------------------------------ *
 * The corrected quarter arc (D-12, plan 57-08)
 * ------------------------------------------------------------------ */

/** A point in TILE-LOCAL px: the corner tile spans `[0, BOARD_CELL]` on both axes. */
export interface CornerPoint {
  readonly x: number;
  readonly y: number;
}

/** One tread through the bend, as arc-length offsets AND as angles. */
export interface CorrectedTread {
  /** Where the tread begins, as CENTRELINE arc length from the entry tangent. */
  readonly startS: number;
  /** Where it ends. Clipped to the end of the quarter arc, never past the tile. */
  readonly endS: number;
  /** The same start, as an angle about `centre`. */
  readonly startAngle: number;
  /** The same end, as an angle about `centre`. */
  readonly endAngle: number;
}

/** The whole drawn corner, as pure geometry. Every field is derived. */
export interface CorrectedCorner {
  /** The candidate lane width this description was built for, px. */
  readonly lane: number;
  /** The arc centre, tile-local px. The TILE CORNER at this radius. */
  readonly centre: CornerPoint;
  /** The centreline radius: `BOARD_ELBOW_R`, always. */
  readonly rCentre: number;
  /** The inner rail's radius, px. */
  readonly rInner: number;
  /** The outer rail's radius, px. */
  readonly rOuter: number;
  /** The angle at which flow enters (the west edge midpoint). */
  readonly startAngle: number;
  /** The angle at which flow leaves (the north edge midpoint). */
  readonly endAngle: number;
  /** The centreline arc length through the bend, px. */
  readonly arcLength: number;
  /** `arcLength / BOARD_DASH_REPEAT` - dash repeats through a bend. See below. */
  readonly repeats: number;
  /** The angular extent of ONE full tread: `BOARD_DASH / rCentre`. */
  readonly treadAngle: number;
  /** The treads that fall inside this bend, in flow order. */
  readonly treads: readonly CorrectedTread[];
  /** The mark one tread leaves on the INNER rail, px. THE headline figure. */
  readonly innerMark: number;
  /** The mark one tread leaves on the outer rail, px. */
  readonly outerMark: number;
  /** The centreline's entry tangent point, tile-local px. */
  readonly entry: CornerPoint;
  /** The centreline's exit tangent point, tile-local px. */
  readonly exit: CornerPoint;
}

/**
 * The bend's arc centre, tile-local px - the TILE CORNER at this radius.
 *
 * LANE-INDEPENDENT, and that is what makes one crop window serve all four rows: every
 * candidate's rails are concentric arcs about THIS point, so a window anchored here
 * contains all four of them (see `insetCrop`). Shared by the drawing and by the crop so
 * the two cannot disagree about where the bend actually is.
 *
 * At the shipped 15 it would sit 1px inside the tile on both axes, which is the
 * straight stub SEED-012 measured as the root of its defects.
 */
export function arcCentre(): CornerPoint {
  return Object.freeze({
    x: BOARD_CELL / 2 - BOARD_ELBOW_R,
    y: BOARD_CELL / 2 - BOARD_ELBOW_R,
  });
}

/**
 * The corrected quarter bend, as pure geometry - D-12, DRAWN FOR THE BOARD ONLY.
 *
 * WHAT IS CORRECTED, against the four defects SEED-012 measured on the raster corner
 * bake that shipped when this board was built (deleted by plan 61-07, which landed the
 * corrected geometry as the shipped vector corner - so this board's "corrected" column
 * and the shipped renderer now agree, which is the convergence plan 61-03 recorded):
 *   - the tread advances along TRUE ARC LENGTH (`s = R * angle`), not along the
 *     shipped `u = dx - dy`, which sweeps 41% faster mid-bend;
 *   - the bend's flow length is the quarter arc `(pi/2) * R`, not one whole tile,
 *     so there is no phase jump at the corner seam;
 *   - the arc centres on the TILE CORNER, so its tangent points fall exactly on the
 *     tile-edge midpoints and no straight stub is required;
 *   - the swept lane is the region between two CONCENTRIC arcs, so its width is the
 *     lane at every parameter value and the corner pinch is 0 BY CONSTRUCTION.
 *
 * THIS IS NOT AN IMPLEMENTATION. `BELT-01..08` build the corrected painter in Phase
 * 61; nothing here touches the shipped belt bake, the shipped `ELBOW_R` or any pixel
 * baseline. It exists so the lane-width decision is made against the geometry Phase
 * 61 will ACTUALLY build - deciding a width against today's five measured defects
 * would pick a width for art that is about to change, which is the one way this
 * board could produce a confidently wrong number.
 *
 * THE DIVISOR IN `repeats` IS `BOARD_DASH_REPEAT`, NOT `BOARD_ELBOW_R`. Both are 16,
 * for entirely unrelated reasons - one is a dash period, the other a radius (RESEARCH
 * F6.2). Any expression here that wrote `arcLength / R` would be coincidentally
 * correct today and wrong the moment either constant moved, so the constant is named.
 *
 * Flow enters at the WEST edge midpoint and leaves at the NORTH one, so the angle
 * runs from `pi/2` down to `0` about a centre at the tile's top-left corner.
 */
export function correctedCorner(lane: number): CorrectedCorner {
  // Reuse laneFigures' own guard rather than restating the membership test: the two
  // must never disagree about which widths exist.
  const figures = laneFigures(lane);

  const centre = arcCentre();
  const startAngle = Math.PI / 2;
  const endAngle = 0;
  const arcLength = quarterArcLength();

  // One tread subtends BOARD_DASH of CENTRELINE arc. Its angular extent is therefore
  // fixed, and the mark it leaves at radius r is `treadAngle * r` = `dashAt(r)`.
  // That collapse is D-11's whole arithmetic: it is why the inner rail of a wide lane
  // shows a mark far shorter than the locked dash.
  const treadAngle = BOARD_DASH / BOARD_ELBOW_R;

  // The bend's OWN treads are the general schedule clipped to the quarter arc. Built
  // through `buildTreadSpans` rather than through a second loop here, so the field this
  // module PRINTS from and the schedule the strip DRAWS from are one function called
  // twice with different bounds - see `treadSpans`.
  const treads = buildTreadSpans(startAngle, BOARD_ELBOW_R, 0, arcLength);

  return Object.freeze({
    lane,
    centre,
    rCentre: BOARD_ELBOW_R,
    rInner: figures.rInner,
    rOuter: figures.rOuter,
    startAngle,
    endAngle,
    arcLength,
    repeats: arcLength / BOARD_DASH_REPEAT,
    treadAngle,
    treads,
    innerMark: treadAngle * figures.rInner,
    outerMark: treadAngle * figures.rOuter,
    entry: Object.freeze({
      x: centre.x + BOARD_ELBOW_R * Math.cos(startAngle),
      y: centre.y + BOARD_ELBOW_R * Math.sin(startAngle),
    }),
    exit: Object.freeze({
      x: centre.x + BOARD_ELBOW_R * Math.cos(endAngle),
      y: centre.y + BOARD_ELBOW_R * Math.sin(endAngle),
    }),
  });
}

/* ------------------------------------------------------------------ *
 * The shared parameterisation - ONE implementation, drawn from and asserted on
 * ------------------------------------------------------------------ */

/**
 * A point on the bend at `radius`, at `angle` about the arc centre. THE polar
 * primitive: every point on every drawn arc and every point in every assertion comes
 * out of this one function.
 *
 * WHY IT IS EXPORTED (plan 57-11, review CR-02). `artBoardLanes.ts` used to carry its
 * own local `polar()` with the identical body, so the strip's spec proved properties of
 * geometry the board did not draw with. The two agreed by coincidence of shared
 * constants rather than by shared code, and nothing reddened if they diverged - which is
 * the hazard `BOARD_ELBOW_R`'s own docblock names: "the drawing looks plausible and the
 * numbers look right, and nobody would think to compare them." The duplicate is gone and
 * `artBoardLanes.source.test.ts` asserts it cannot come back.
 */
export function cornerPointAtAngle(
  corner: CorrectedCorner,
  radius: number,
  angle: number,
): CornerPoint {
  return {
    x: corner.centre.x + radius * Math.cos(angle),
    y: corner.centre.y + radius * Math.sin(angle),
  };
}

/**
 * The angle about the arc centre at CENTRELINE arc length `s`, with `s = 0` at the
 * entry tangent. THE arc-length-to-angle mapping, for the drawing and the assertions
 * alike.
 *
 * THE DIVISOR IS `corner.rCentre`, THE RADIUS - not `BOARD_DASH_REPEAT`. The two are the
 * same integer for entirely unrelated reasons (RESEARCH F6.2), so the constant is named
 * rather than written as a bare 16. This is an arc-length-to-angle conversion
 * (`s = r * theta`), which is a property of the radius.
 *
 * It is defined for `s` OUTSIDE `[0, arcLength]` and that is deliberate: the strip draws
 * a straight tile either side of the bend and needs one continuous parameter across all
 * three segments. Callers clamp to the arc before drawing a sector.
 */
export function angleAtArcLength(corner: CorrectedCorner, s: number): number {
  return corner.startAngle - s / corner.rCentre;
}

/**
 * A point on the bend at `radius`, at parameter `t` in `[0, 1]` along the flow.
 *
 * ONE parameterisation for the drawing and for the assertions, so a spec that proves
 * the lane width constant is proving it about the geometry that is actually drawn. That
 * is true because this function and the strip's own emitter both bottom out in
 * `cornerPointAtAngle`: `t` is the convenient parameter for a sweep in a spec, arc
 * length is the convenient one for a drawing that runs through the corner seam, and both
 * resolve to an angle and then to the same three lines of trigonometry.
 */
export function cornerPoint(corner: CorrectedCorner, radius: number, t: number): CornerPoint {
  const angle = corner.startAngle + (corner.endAngle - corner.startAngle) * t;
  return cornerPointAtAngle(corner, radius, angle);
}

/**
 * The tread schedule over an arbitrary CENTRELINE arc-length span, in flow order.
 *
 * THE ONE SCHEDULE. `correctedCorner().treads` is this function clipped to the quarter
 * arc, and the strip's belt run is this function over `[-tile, arcLength + tile]`, so
 * the printed figures and the drawn treads cannot fall out of step. Before plan 57-11
 * the strip rebuilt this loop from scratch and `treads`, `treadAngle`, `innerMark`,
 * `outerMark`, `entry`, `exit` and `endAngle` were read by no drawing code at all.
 *
 * A tread begins at every multiple of `BOARD_DASH_REPEAT` measured along the CENTRELINE
 * and runs for `BOARD_DASH`, and both ends are CLIPPED to `[s0, s1]` rather than allowed
 * to overrun - a tread that ran past the requested span would draw outside it and
 * whatever comes next would restate it. The phase is absolute, keyed to `s = 0` at the
 * entry tangent, which is what carries the tread pattern continuously across the corner
 * seam instead of restarting it there (SEED-012 defect 2).
 */
export function treadSpans(
  corner: CorrectedCorner,
  s0: number,
  s1: number,
): readonly CorrectedTread[] {
  return buildTreadSpans(corner.startAngle, corner.rCentre, s0, s1);
}

/**
 * `treadSpans`' body, taking the two scalars it needs rather than a whole
 * `CorrectedCorner`, so `correctedCorner()` can call it while still building the object
 * `treadSpans()` takes. One loop, two callers, no second copy.
 */
function buildTreadSpans(
  startAngle: number,
  rCentre: number,
  s0: number,
  s1: number,
): readonly CorrectedTread[] {
  const angleAt = (s: number): number => startAngle - s / rCentre;
  const spans: CorrectedTread[] = [];
  // FLOOR, NOT CEIL, and the difference is a trap rather than a nicety. The loop has to
  // begin one repeat BEFORE `s0` so a tread that STARTED earlier and runs into the span
  // is clipped and kept rather than dropped. With `ceil` it is dropped silently, and the
  // caller sees a schedule with a hole at its leading edge.
  //
  // IT CHANGES NOTHING THIS BOARD DRAWS. Both real callers pass an `s0` that is an exact
  // multiple of `BOARD_DASH_REPEAT` (0 for the bend's own treads, `-BOARD_CELL` = -32 for
  // the strip's run), where floor and ceil are the same number - the strip's spec pins
  // both schedules. It matters for any later caller that does not, which is precisely
  // the reader this module is being written for.
  for (let k = Math.floor(s0 / BOARD_DASH_REPEAT); k * BOARD_DASH_REPEAT < s1; k += 1) {
    const startS = Math.max(k * BOARD_DASH_REPEAT, s0);
    const endS = Math.min(k * BOARD_DASH_REPEAT + BOARD_DASH, s1);
    // A tread that ended before `s0` produces an inverted span here. Skipped, never
    // emitted as a zero-length artefact the drawing would fill as nothing.
    if (endS <= startS) continue;
    spans.push(
      Object.freeze({ startS, endS, startAngle: angleAt(startS), endAngle: angleAt(endS) }),
    );
  }
  return Object.freeze(spans) as readonly CorrectedTread[];
}

/** The magnified inset's crop window, tile-local px. Square, and lane-independent. */
export interface InsetCrop {
  /** Left edge, tile-local px. NEGATIVE at this radius - see `insetCrop`. */
  readonly x: number;
  /** Top edge, tile-local px. */
  readonly y: number;
  /** Width, px. `INSET_WINDOW_U`. */
  readonly w: number;
  /** Height, px. `INSET_WINDOW_U`. */
  readonly h: number;
}

/**
 * The ONE crop window the magnified inset shows, in every row.
 *
 * IT TAKES NO LANE ARGUMENT, and that signature is the guard rather than a
 * convention: a per-row window cannot be written without changing it. E.3's crop must
 * be identical in every row or the rows stop being comparable, and a per-row "just
 * enough to see it" window would make every row look equally readable - the exact
 * opposite of the finding the strip exists to show.
 *
 * IT IS ANCHORED ON THE ARC CENTRE, NOT ON `centrelineTangentPoint()`, AND THAT IS A
 * MEASURED CORRECTION rather than a preference (plan 57-08). The four candidates put
 * their inner rails at radii 6 / 4 / 3 / 2 about the arc centre, and their straight
 * approaches put that same rail at those same distances from the tile's top edge. A
 * window CENTRED on the centreline tangent point spans the middle of the lane and
 * contains NONE of them - measured, all four, on both the straight and the bend. The
 * inset would then show flat lane interior in every row, identically, and the one
 * column that exists to make the smallest mark visible would be the one column showing
 * nothing. The spec carries that counter-check, so an edit back to the centreline
 * reddens.
 *
 * The window's top edge is the arc centre's own row and it extends downward into the
 * tile, because that is where the bend is; it straddles the tile's west edge, because
 * half of what matters is the straight-to-bend transition and a window wholly inside
 * the corner tile could not show it.
 *
 * IT IS STILL A FUNCTION OF THE RADIUS, which is why it lives in this module: the arc
 * centre is `BOARD_CELL / 2 - BOARD_ELBOW_R` on both axes, so at the shipped 15 the
 * window shifts by one px on both axes and IS NOT THE SAME CROP.
 */
export function insetCrop(): InsetCrop {
  const centre = arcCentre();
  return Object.freeze({
    x: centre.x - INSET_WINDOW_U / 2,
    y: centre.y,
    w: INSET_WINDOW_U,
    h: INSET_WINDOW_U,
  });
}

/**
 * The fixed-format string the board prints for a dash figure: always 3 decimal
 * places, so the four rows align on the decimal point and a row never looks more
 * precise than another.
 *
 * BOARD-03's own text quotes lane 26's inner dash rounded to 2 dp. The board prints
 * the exact 3 dp value, and the rounding is recorded here and in the lock file, so
 * a reader holding the two documents side by side does not conclude they disagree.
 */
export function formatDash(n: number): string {
  return n.toFixed(3);
}
