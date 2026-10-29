// The art board's lane-width strip (BOARD-03, plan 57-08): 4 lane widths x 6
// columns - the four candidate directions, one magnified inset, one numbers cell.
//
// WHY THE BELT NEVER APPEARS ALONE HERE (57-CONTEXT.md D-10). Each artwork cell holds
// that direction's SOURCE, a straight belt tile, the corrected corner tile at that
// row's lane width, and that direction's FACTORY, on ONE baseline at 2x. A lane width
// judged in isolation is a width judged against nothing: it is chosen by how it reads
// beside the machine art it runs into, and SOURCE (1x1) and FACTORY (3x3) bracket the
// footprint range it has to sit between.
//
// WHY FOUR COLUMNS AND NOT TWENTY. The belt tiles are IDENTICAL in all four direction
// columns - belt art is locked by `53-BELT-LOCK.md` (Direction B) and only the machines
// beside it differ. The strip's axis is the lane width; the direction axis is here
// only so the width is seen against every candidate it might have to live with.
//
// THE CORNER IS DRAWN IN CORRECTED GEOMETRY (D-12), from `correctedCorner()`, never
// from the raster corner bake that shipped when this strip was built. That bake carried
// the four defects SEED-012 measured, and a width chosen against those would be a width
// chosen for art that was about to change. It has since changed: BELT-01..08 landed in
// Phase 61 and plan 61-07 deleted the bake, so the thing this comment warns against
// reaching for no longer exists. Nothing here touches the shipped belt painter, the
// shipped `ELBOW_R`, or any pixel baseline.
//
// THE INSET IS THE NEUTRALITY-CRITICAL PART. Identical crop, identical factor and
// identical canvas size in all four rows, with the factor printed. The smallest
// printed mark is below the threshold at which a reader notices anything unaided,
// which is exactly why BOARD-03 requires it SHOWN rather than stated - and a per-row
// "just enough to see it" magnification would make every row look equally readable,
// which is the opposite of the finding.
//
// NO FIGURE ON THIS STRIP IS TYPED. Every number comes from `artBoardGeometry.ts`'s
// `laneFigures` / `correctedCorner`, which compute at the board-local
// `BOARD_ELBOW_R`. A typed figure would survive a change of radius and the strip
// would stop being a derivation while still looking like one.
//
// AND NEITHER IS THE DRAWING (review CR-02, plan 57-11). Until this fix that claim was
// true of the printed TEXT and false of the DRAWING: this module carried its own
// `polar()`, re-derived the arc-length-to-angle mapping inline, and rebuilt the tread
// loop from scratch, so `cornerPoint`, `treads`, `treadAngle`, `innerMark`, `outerMark`,
// `entry`, `exit` and `endAngle` were read by no drawing code at all and the strip's
// strongest unit assertions proved properties of geometry the board did not draw with.
// Every point, every angle and every tread on this strip now comes out of
// `cornerPointAtAngle` / `angleAtArcLength` / `treadSpans`, and two gates keep it that
// way: `artBoardGeometry.test.ts` asserts `treadSpans` and `correctedCorner().treads`
// are the same schedule, and `artBoardLanes.source.test.ts` reddens on a second local
// implementation of either.
//
// ZERO CONTROLS. No slider, no stepper, no selector - four fixed rows. A control is
// how an instrument acquires a preference. The only record of a choice is
// 57-ART-LOCK.md, written by the maintainers.
//
// THE IMPORT CYCLE, INHERITED FROM artBoardSlate.ts AND artBoardPanel.ts. artBoard.ts
// imports this module and this module imports artBoard.ts back, so ESM hands us a
// live-but-partially-initialised namespace. EVERY read of an artBoard.ts binding below
// happens INSIDE A FUNCTION BODY. A top-level read throws `ReferenceError: Cannot
// access 'X' before initialization` and the board never boots - observed twice already
// in this phase (57-01 on SUBJECTS, 57-06 on hex), so it is a rule here.
//
// This module is never imported outside src/spike/ and exports nothing to the app.

import { Container, Graphics } from 'pixi.js';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import {
  BOARD_CELL,
  BOARD_DASH,
  BOARD_DASH_REPEAT,
  BOARD_ELBOW_R,
  INSET_MAGNIFICATION,
  INSET_WINDOW_U,
  LANE_WIDTHS,
  angleAtArcLength,
  cornerPointAtAngle,
  correctedCorner,
  formatDash,
  insetCrop,
  laneFigures,
  treadSpans,
  type CorrectedCorner,
} from './artBoardGeometry.ts';
import {
  CELL_BOX_W,
  CELL_U,
  SUBJECTS,
  candidateDirections,
  cellBox,
  hex,
  ink,
  rule,
  substrate,
  type Direction,
  type Subject,
} from './artBoard.ts';
import { buildSubjectRender, inkMuted, textLine, type SlateDeps } from './artBoardSlate.ts';

/* ------------------------------------------------------------------ *
 * Layout constants (57-UI-SPEC Part E.2 and the Spacing Scale)
 * ------------------------------------------------------------------ */

/**
 * The strip's zoom: 2x, and only 2x.
 *
 * The four widths differ by 8px at 1x; at 2x that difference is legible without
 * magnification, which is what leaves the inset to do the ONE job it exists for -
 * showing the inner-rail mark, which is not legible at any of these zooms.
 */
export const LANE_STRIP_ZOOM = 2;

/** The artwork cell's content, in grid cells: SOURCE + belt + corner + FACTORY. */
const LANE_CONTENT_W_CELLS = 6;

/** The artwork cell's content height, in grid cells: the FACTORY's own footprint. */
const LANE_CONTENT_H_CELLS = 3;

/** The 8px padding, the shared Spacing Scale value used by every cell on the board. */
const LANE_PAD = 8;

/** The row-label gutter. Identical to the slate's and the panel's, so grids line up. */
const LANE_GUTTER_W = 120;

/**
 * The inset cell box: the board's standard cell width, READ from `artBoard.ts` rather
 * than re-declared, so the strip cannot acquire a second cell-width contract.
 *
 * A FUNCTION for the import-cycle reason in the header. The 128px canvas needs only
 * 144px; the box is the board's standard 208 because the caption below the canvas is
 * printed in EVERY row (it is what makes the identical-magnification claim checkable),
 * and a box that clipped it would leave four rows asserting a factor a reader cannot
 * read.
 */
const insetBoxW = (): number => CELL_BOX_W;

/** The numbers cell box. Wide enough for the longest label plus a 3dp figure. */
const NUMBERS_BOX_W = 264;

/* ------------------------------------------------------------------ *
 * The shipped radius - carried ONLY to print the counter-check
 * ------------------------------------------------------------------ */

/**
 * `frontend/shared/geometry.ts`'s `ELBOW_R`, TRANSCRIBED rather than imported, and used
 * for exactly one thing: printing the radius the tree actually ships beside the radius
 * this strip computes at, so a reader can see the relationship rather than assume it.
 *
 * 16 SINCE PLAN 61-03. It was 15 for the whole of Phase 57, which is why this constant
 * and the caption that consumes it were built as a COUNTER-CHECK - "here is what these
 * four widths would give at the radius the tree actually ships, and none of BOARD-03's
 * published figures survives it". The signed `61-BELT-LOCK-SUPERSESSION.md` (signed
 * 2026-08-09) moved the shipped radius to 16, so the counter-check became a CONFIRMATION:
 * the two radii agree and the board's figures reproduce in the tree.
 *
 * IT IS STILL NEVER DRAWN WITH, AND IT IS STILL NOT IMPORTED. `artBoardGeometry.ts`
 * exports exactly ONE radius on purpose. The hazard that non-import originally guarded
 * (drawing at 15 while printing the 16 table, invisible because the drawing looks
 * plausible and the numbers look right) has ceased to exist along with the divergence -
 * but the rule is kept on a different reason: this board's figures are PUBLISHED in
 * `57-ART-LOCK.md` and were judged, so a future shipped radius change must not silently
 * move them. Plan 57-03's mutation M6 proved a value assertion does not catch an import
 * and the NON-IMPORT source check does, so the source form is preserved here too.
 *
 * AND SINCE 2026-08-11 THE COPY IS HELD TO THE ORIGINAL (v7.0 milestone audit, W-4).
 * The non-import rule's price is a second declaration feeding a caption that makes a
 * factual claim ABOUT THE TREE, and nothing asserted the two agreed - so a future
 * shipped-radius change would have left this board printing a sentence about
 * `shared/geometry.ts` that was simply false. `artBoardLanes.source.test.ts` now imports
 * the shipped `ELBOW_R` and asserts convergence with the literal below, in the shape the
 * sibling `artBoardGeometry.test.ts` has always used for `BOARD_ELBOW_R`. The strip still
 * owns its copy and still imports nothing; it just can no longer lie about the tree.
 */
const SHIPPED_ELBOW_R = 16;

/**
 * The inner-rail dash at an ARBITRARY radius - the counter-check helper, used ONLY to
 * build the dependency line's "at the shipped radius these four widths give ..." clause.
 *
 * The board's own four figures never come through here; they come from
 * `laneFigures()`, which computes at `BOARD_ELBOW_R` and nowhere else.
 */
const innerDashAtRadius = (lane: number, radius: number): number =>
  (BOARD_DASH * (radius - lane / 2)) / radius;

/* ------------------------------------------------------------------ *
 * Copy - every string pre-checked against D-14/D-17's banned-token list
 * ------------------------------------------------------------------ */

/** The strip's standing lines, above the grid. */
const LANE_NOTES = (): readonly string[] => [
  `Lane rows run ${LANE_WIDTHS.join(', ')} px, ascending. That order carries no ranking meaning, and no width here is a starting value, a baseline or a reference.`,
  'The belt is identical in all four direction columns - belt art is locked by 53-BELT-LOCK.md (Direction B) and only the machines beside it differ. That is why this strip is four direction columns and not twenty.',
  `Every artwork cell holds SOURCE, a straight belt tile, the corner tile at that row's width and FACTORY on one baseline at ${LANE_STRIP_ZOOM.toFixed(2)}x. The belt never stands alone here: a width is read against the machine art it runs into.`,
  "The corner is drawn in corrected geometry - true arc length, the arc centred on the tile corner, constant lane width by construction, the tread square to the flow - and not as the belt ships today. Judging a width against the defects measured on today's bend would choose a width for art that is about to change.",
  'Nothing on this strip changes a width, ranks one or endorses one. The only record of a choice is 57-ART-LOCK.md, in the internal design notes.',
];

/** 57-UI-SPEC Copywriting Contract - the lane-strip inset caption, in all four rows. */
const INSET_CAPTION = (): string =>
  `inner rail, ${INSET_WINDOW_U}u window at ${INSET_MAGNIFICATION}x, nearest - identical crop and magnification in all four rows`;

/**
 * The strip's caption: the rounding note, the two non-discriminator columns, and the
 * `R = 16` dependency.
 *
 * EVERY FIGURE IN IT IS COMPUTED, including the four counter-check values at the
 * shipped radius. Typing those would put four numbers on the board that no longer move
 * when the radius they describe does.
 */
const LANE_CAPTION = (): readonly string[] => {
  const twentySix = laneFigures(26);
  const atShipped = LANE_WIDTHS.map((w) => innerDashAtRadius(w, SHIPPED_ELBOW_R).toFixed(2)).join(' / ');
  return [
    `BOARD-03's text quotes ${twentySix.innerDash.toFixed(2)} for the ${twentySix.lane} px lane; the exact value is ${formatDash(twentySix.innerDash)}. Same number, rounded - recorded so a reader holding the two documents does not read them as disagreeing.`,
    '',
    "The corner pinch is 0 in all four rows BY CONSTRUCTION, not as four independent measurements: under the corrected geometry the swept corner lane is the region between two concentric arcs, so its width is the lane at every point of the bend. Today's shipped bake reports a 4 px pinch because it measures the corner lane across the tile-edge span rather than square to the flow.",
    `The elbowR - laneHalf column is the 53-BELT-LOCK.md axis-3 joint guard. All four widths satisfy it at this radius, so it separates none of them. Both columns are printed anyway: a column where all four rows agree is a column that is not a discriminator, and that is worth showing rather than omitting.`,
    '',
    `THE FIGURES ON THIS STRIP ASSUME BOARD_ELBOW_R = ${BOARD_ELBOW_R}. The tree now ships the same radius: frontend/shared/geometry.ts carries ELBOW_R = ${SHIPPED_ELBOW_R}, so recomputing the four widths against the SHIPPED constant returns inner-rail dashes of ${atShipped} px - this strip's own row, unchanged. BOARD-03's published figures reproduce in the shipped tree.`,
    `That was not true when this strip was built. Through Phase 57 the tree shipped a radius one px smaller, at which the same four widths gave four entirely different figures and none of BOARD-03's published values survived; this caption said so, and said the supersession behind the ${BOARD_ELBOW_R} value carried no signature. Both statements were retired on 2026-08-09, when the maintainers SIGNED 61-BELT-LOCK-SUPERSESSION.md - superseding 53-BELT-LOCK.md axis 3 - and Phase 61 moved the shipped constant to match. 57-ART-LOCK.md recorded the radius as a dependency and that dependency is now discharged by adoption rather than by refusal.`,
    `The strip keeps its OWN radius constant even so, and that is not left over from the divergence it used to mark. These figures are published in 57-ART-LOCK.md and a lane width was judged against them; a strip that read the shipped constant would let a future radius change silently move a number that has already been judged, while still looking correct. Owning its own copy is what keeps the published figures reproducible from this instrument alone.`,
    `The quarter-arc centreline runs ${formatDash(correctedCorner(LANE_WIDTHS[0] as number).arcLength)} px, which is ${correctedCorner(LANE_WIDTHS[0] as number).repeats.toFixed(4)} dash repeats through a bend. The divisor there is the dash repeat (${BOARD_DASH_REPEAT} px), not the radius; the two are the same integer for unrelated reasons.`,
  ];
};

/** The six printed consequences, in the order 57-UI-SPEC E.4 prints them. */
const FIGURE_ROWS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'inner-dash', label: 'inner-rail dash, px' },
  { key: 'outer-dash', label: 'outer-rail dash, px' },
  { key: 'outer-over-inner', label: 'outer : inner' },
  { key: 'inner-over-lane', label: 'inner : lane' },
  { key: 'corner-pinch', label: 'corner pinch, px' },
  { key: 'joint-guard', label: 'elbowR - laneHalf, px' },
];

/* ------------------------------------------------------------------ *
 * The board-local belt painter - corrected geometry, drawn once, used twice
 * ------------------------------------------------------------------ */

/**
 * The three inks the belt run is painted in, all read from LOCKED_SKIN's grey ramp.
 *
 * A FUNCTION for the import-cycle reason above, and read from the skin rather than
 * written as hex so the strip cannot introduce a colour the board's chrome does not
 * already use. There is no accent anywhere on this page (57-UI-SPEC Color).
 *
 * THREE SEPARATED STEPS, and the separation is what makes the printed figure readable
 * rather than decorative: the rails are drawn in ramp[3] between the ramp[1] body and
 * the ramp[4] tread, so the rail reads as a continuous hairline INTERRUPTED by each
 * tread - and the length of that interruption on the inner rail IS the inner-rail dash
 * this strip prints. At the two adjacent ramp steps the rail was indistinguishable from
 * the body and the figure had nothing on the drawing to correspond to.
 */
const beltInks = (): { readonly body: number; readonly rail: number; readonly tread: number } => ({
  body: LOCKED_SKIN.palette.ramp[1] as number,
  rail: LOCKED_SKIN.palette.ramp[3] as number,
  tread: LOCKED_SKIN.palette.ramp[4] as number,
});

/** The rail hairline, in belt-local px. One unit, at both lane edges. */
const RAIL_U = 1;

/**
 * The straight run drawn either side of the bend, in belt-local px: one tile each.
 *
 * THE RUN LEAVING THE BEND IS NOT DECORATION. Without it the corner terminates at the
 * tile boundary in mid-air and reads as a truncated wedge rather than as a belt turning
 * a corner, which is not a thing a lane width can be judged on. It also carries the
 * phase across the seam, which is the visible half of SEED-012 defect 2 being corrected:
 * the shipped bake treats the bend as a whole tile of flow and jumps an eighth of a
 * period at every corner, and here the tread pattern runs continuously through.
 */
const RUN_TILE_U = BOARD_CELL;

/**
 * Trace one annular sector of the bend: radius `r0..r1` over the angular span
 * `a0..a1`, where `a0 > a1` because flow runs from the west edge to the north edge.
 *
 * Traced rather than stroked. A stroked arc's width is a PEN property and would stay
 * constant while the lane it represents did not; a filled region between two concentric
 * arcs IS the swept lane, which is what makes the corner pinch 0 by construction rather
 * than by luck.
 */
function traceSector(
  g: Graphics,
  corner: CorrectedCorner,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
): void {
  const start = cornerPointAtAngle(corner, r0, a0);
  g.moveTo(start.x, start.y);
  // `true` = anticlockwise in canvas terms, which is DECREASING angle: the flow
  // direction here, from the west edge midpoint round to the north one.
  g.arc(corner.centre.x, corner.centre.y, r0, a0, a1, true);
  const cross = cornerPointAtAngle(corner, r1, a1);
  g.lineTo(cross.x, cross.y);
  g.arc(corner.centre.x, corner.centre.y, r1, a1, a0, false);
  g.closePath();
}

/**
 * Trace the band between radii `r0..r1` over the arc-length span `s0..s1`, ACROSS all
 * three segments of the run.
 *
 * ONE emitter for the lane body, for each rail and for every tread, so nothing on the
 * drawing can be laid out on a different arithmetic from anything else. `s` is arc
 * length along the CENTRELINE with `s = 0` at the entry tangent: negative on the run
 * feeding the bend, `0 .. arcLength` through it, and beyond `arcLength` on the run
 * leaving it. A span that straddles a seam is split rather than snapped, which is what
 * makes the phase continuous through the corner.
 */
function traceBand(
  g: Graphics,
  corner: CorrectedCorner,
  r0: number,
  r1: number,
  s0: number,
  s1: number,
): void {
  const end = corner.arcLength;
  // Radius maps to an OFFSET FROM THE CENTRELINE on both straights: at the entry
  // tangent a point at radius r sits at y = r, and at the exit tangent at x = r. The
  // band is therefore `r0..r1` from the tile edge on each, with no conversion.
  if (s0 < 0) {
    const e = Math.min(s1, 0);
    g.rect(s0, r0, e - s0, r1 - r0);
  }
  if (s1 > 0 && s0 < end) {
    // The arc-length-to-angle mapping comes from artBoardGeometry.ts, never re-derived
    // here: this expression used to be written inline and was a SECOND implementation of
    // the arithmetic the strip prints beside it (review CR-02).
    const a0 = angleAtArcLength(corner, Math.max(s0, 0));
    const a1 = angleAtArcLength(corner, Math.min(s1, end));
    traceSector(g, corner, r0, r1, a0, a1);
  }
  if (s1 > end) {
    const b = Math.max(s0, end);
    g.rect(r0, -(s1 - end), r1 - r0, s1 - b);
  }
}

/**
 * One belt run at `lane` px wide, in CORNER-TILE-LOCAL px: a straight tile feeding the
 * bend, the bend itself, and a straight tile leaving it.
 *
 * ONE drawing, used by the artwork cell at 2x and by the magnified inset at 1x. That is
 * not an optimisation - it is what makes the inset a magnification OF THE CELL rather
 * than a second rendering that could disagree with it.
 *
 * The corner tile occupies `[0, BOARD_CELL]` on both axes. Flow runs east into the bend
 * and leaves north, so the INNER rail is the upper edge of the entering straight, the
 * smaller radius through the bend, and the left edge of the leaving straight - one
 * continuous rail, which is what lets a reader follow the mark that collapses.
 */
function beltRun(lane: number): Container {
  const corner = correctedCorner(lane);
  const inks = beltInks();
  const holder = new Container();
  const g = new Graphics();

  const runStart = -RUN_TILE_U;
  const runEnd = corner.arcLength + RUN_TILE_U;

  // --- the swept lane -------------------------------------------------
  traceBand(g, corner, corner.rInner, corner.rOuter, runStart, runEnd);
  g.fill({ color: inks.body, alpha: 1 });

  // --- both rails, subtracted INWARD from the lane edges ---------------
  // Never added outward: at the widest candidate the inner radius is 2, and an outward
  // rail would fall at a negative radius and vanish under squaring. (The shipped
  // painter records the same rule, for the same reason.)
  traceBand(g, corner, corner.rInner, corner.rInner + RAIL_U, runStart, runEnd);
  traceBand(g, corner, corner.rOuter - RAIL_U, corner.rOuter, runStart, runEnd);
  g.fill({ color: inks.rail, alpha: 1 });

  // --- the treads ------------------------------------------------------
  // ONE phase for the whole run, and ONE schedule: `treadSpans` is the same function
  // `correctedCorner()` builds its own `treads` field from, called here over the wider
  // span the run covers. A tread begins at every multiple of the dash repeat, measured
  // along the CENTRELINE, and is clipped only by the ends of the run; one that straddles
  // the corner seam is drawn across it rather than restarted, which is the phase
  // continuity the shipped bake does not have.
  //
  // THIS LOOP USED TO BE REBUILT HERE (review CR-02), which made the printed figures and
  // the drawn treads two implementations that agreed only by coincidence of shared
  // constants. `artBoardGeometry.test.ts` now asserts the join.
  for (const tread of treadSpans(corner, runStart, runEnd)) {
    traceBand(g, corner, corner.rInner, corner.rOuter, tread.startS, tread.endS);
  }
  g.fill({ color: inks.tread, alpha: 1 });

  holder.addChild(g);
  return holder;
}

/* ------------------------------------------------------------------ *
 * The cell renderers
 * ------------------------------------------------------------------ */

/** The subject record for an id. Reads `SUBJECTS` inside a function body (TDZ). */
function laneSubject(id: string): Subject {
  const found = SUBJECTS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`artBoardLanes: ${id} is not a board subject`);
  return found;
}

/**
 * One artwork cell: SOURCE, the straight belt, the corner and FACTORY on one baseline.
 *
 * The machines come from `buildSubjectRender` - the SAME per-column branch the slate and
 * the channel panel use - so there is no second rendering path here that could disagree
 * with the rest of the board about what a direction looks like. The BELT is NOT taken
 * from that branch: it would return the shipped pixel bake, at the shipped lane width,
 * with the shipped corner defects, which is precisely the geometry this strip exists not
 * to decide against.
 */
export function renderLaneCell(
  box: HTMLDivElement,
  lane: number,
  direction: Direction,
  deps: SlateDeps,
): void {
  const zoom = LANE_STRIP_ZOOM;
  const composite = new Container();
  const bandH = LANE_CONTENT_H_CELLS * CELL_U * zoom;

  const source = laneSubject('SOURCE');
  const factory = laneSubject('FACTORY');

  const sourceRender = buildSubjectRender(source, direction, zoom, deps);
  if (sourceRender.node !== null) {
    sourceRender.node.x = 0;
    sourceRender.node.y = (bandH - source.h * CELL_U * zoom) / 2;
    composite.addChild(sourceRender.node);
  }

  // The belt run: its corner tile's own origin sits at the third cell column, and its
  // straight run therefore fills the second - one placement for both tiles, so the
  // straight and the bend can never be positioned inconsistently with each other.
  const run = beltRun(lane);
  run.scale.set(zoom);
  run.x = 2 * CELL_U * zoom;
  run.y = CELL_U * zoom;
  composite.addChild(run);

  const factoryRender = buildSubjectRender(factory, direction, zoom, deps);
  if (factoryRender.node !== null) {
    factoryRender.node.x = 3 * CELL_U * zoom;
    factoryRender.node.y = 0;
    composite.addChild(factoryRender.node);
  }

  box.appendChild(
    deps.extractCell({
      target: composite,
      footprintW: LANE_CONTENT_W_CELLS,
      footprintH: LANE_CONTENT_H_CELLS,
      zoom,
    }),
  );
}

/**
 * One magnified inset: the FIXED crop window, at the FIXED factor, at the FIXED size.
 *
 * Two properties are load-bearing and both are asserted by the strip's spec:
 *
 *   - the crop and the factor are identical in every row. `insetCrop()` takes no lane
 *     argument and `INSET_MAGNIFICATION` is one constant, so a per-row window cannot be
 *     written here without changing a signature.
 *   - the magnification is NEAREST, of the 1x render. It is not a re-render of the
 *     vector at 8x: that would show detail the reader will never see, and the whole
 *     point of this column is what the smallest mark looks like at the size it is
 *     actually drawn. `imageSmoothingEnabled = false` is what keeps it honest.
 */
export function renderInsetCell(box: HTMLDivElement, lane: number, deps: SlateDeps): void {
  const crop = insetCrop();
  const holder = new Container();
  const run = beltRun(lane);
  // The window straddles the tile boundary (its left half is the straight run), so the
  // content is translated by the crop origin rather than the tile origin.
  run.x = -crop.x;
  run.y = -crop.y;
  holder.addChild(run);

  const small = deps.extractCell({
    target: holder,
    footprintW: crop.w / CELL_U,
    footprintH: crop.h / CELL_U,
    zoom: 1,
  });

  const out = document.createElement('canvas');
  out.width = crop.w * INSET_MAGNIFICATION;
  out.height = crop.h * INSET_MAGNIFICATION;
  out.style.imageRendering = 'pixelated';
  const g = out.getContext('2d', { willReadFrequently: true });
  if (g === null) throw new Error(`artBoardLanes: the ${lane}px inset canvas has no 2d context`);
  // NEAREST ONLY. Smoothing would invent detail that is not in the render, and the
  // figure this column exists to show is exactly the one that does not survive
  // invention.
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, out.width, out.height);
  box.appendChild(out);

  const caption = textLine(INSET_CAPTION(), 11, 400, inkMuted());
  caption.setAttribute('data-inset-caption', '');
  caption.style.textAlign = 'left';
  caption.style.marginTop = `${LANE_PAD}px`;
  caption.style.whiteSpace = 'normal';
  box.appendChild(caption);
}

/** One printed consequence: a label and its computed figure, on one line. */
function figureLine(key: string, label: string, value: string): HTMLDivElement {
  const line = document.createElement('div');
  line.setAttribute('data-figure', key);
  line.style.display = 'flex';
  line.style.justifyContent = 'space-between';
  line.style.gap = `${LANE_PAD}px`;
  const name = textLine(label, 11, 400, inkMuted());
  const figure = textLine(value, 11, 400, ink);
  // Right-aligned decimals in a monospace family: the four rows align on the decimal
  // point, so no row can look more precise than another (57-UI-SPEC Typography).
  figure.style.textAlign = 'right';
  figure.setAttribute('data-value', key);
  if (key === 'inner-dash') figure.setAttribute('data-inner-dash', '');
  line.appendChild(name);
  line.appendChild(figure);
  return line;
}

/**
 * One numbers cell: the six printed consequences for that width (D-11).
 *
 * THE BINDING CONSEQUENCE IS PRINTED PER WIDTH, so the choice is informed or it is not a
 * choice. Same ink and same weight in every row, no colour: colour-grading a measurement
 * is how a table votes (N6).
 */
export function renderNumbersCell(box: HTMLDivElement, lane: number): void {
  const f = laneFigures(lane);
  const values: Readonly<Record<string, string>> = {
    'inner-dash': formatDash(f.innerDash),
    'outer-dash': formatDash(f.outerDash),
    'outer-over-inner': f.outerOverInner.toFixed(2),
    'inner-over-lane': f.innerOverLane.toFixed(3),
    'corner-pinch': formatDash(f.cornerPinch),
    'joint-guard': formatDash(f.elbowMinusLaneHalf),
  };
  for (const row of FIGURE_ROWS) {
    box.appendChild(figureLine(row.key, row.label, values[row.key] as string));
  }
}

/**
 * A width whose geometry did not build. Names the width in visible text.
 *
 * NEVER A BLANK CELL. A blank cell and a failed cell look identical and mean opposite
 * things, and on this strip a silently missing row would make the remaining widths look
 * like the whole comparison.
 */
export function renderLaneErrorCell(box: HTMLDivElement, lane: number, reason: string): void {
  box.setAttribute('data-error', 'geometry-failure');
  const strip = document.createElement('div');
  strip.style.textAlign = 'left';
  strip.style.whiteSpace = 'normal';
  for (const line of [
    `the ${lane} px lane failed to build`,
    `${reason} - the cell is blank because the geometry failed, not because the width has nothing to show`,
  ]) {
    strip.appendChild(textLine(line, 11, 400, inkMuted()));
  }
  box.appendChild(strip);
}

/* ------------------------------------------------------------------ *
 * The strip
 * ------------------------------------------------------------------ */

/**
 * The four candidate directions, READ from `artBoard.ts`'s one derivation.
 *
 * Derived rather than re-listed (N1): a second literal list of the column axis is a
 * second source of truth for the axis the board is comparing along, and two lists drift.
 * TODAY is dropped because it is the shipped pixel bake, and the shipped belt is the
 * geometry this strip deliberately does not draw.
 *
 * IT NO LONGER WRITES ITS OWN `.filter()` (review WR-04). This module derived the axis
 * while `artBoardSlate.ts`'s cost table carried a hardcoded `['A', 'B', 'C', 'D']`
 * literal - one axis, two mechanisms, which is the drift `DIRECTIONS`'s own docblock
 * names as the defect. Both now call `candidateDirections()`.
 */
const laneDirections = (): readonly Direction[] => candidateDirections();

/** One cell box in the strip. Same padding and substrate as every other cell (N8). */
function laneCellBox(attrs: Record<string, string>, width: number, height: number): HTMLDivElement {
  const box = cellBox(attrs);
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  box.style.textAlign = 'left';
  return box;
}

/**
 * Render the lane-width strip into `host`.
 *
 * Emits the DOM contract plan 57-08's spec depends on:
 *   [data-lane-row="20"]                       one row per candidate width
 *   [data-lane-cell][data-lane][data-direction] 16 artwork cells
 *   [data-inset][data-lane]                     4 magnified insets
 *   [data-inset-caption]                        the caption, character-identical x4
 *   [data-numbers][data-lane]                   4 numbers cells
 *   [data-figure][data-value]                   6 printed consequences per numbers cell
 *   [data-inner-dash]                           the headline figure, as rendered text
 *   [data-error="geometry-failure"]             a width whose geometry did not build
 *
 * Those attributes are LOCATORS, not reports: the board never publishes an attribute
 * describing its own correctness, and every assertion in the spec measures the DOM, the
 * pixels or the rendered text for itself.
 *
 * THE HORIZONTAL SCROLL IS A STATED ASSUMPTION, NOT A CLOSED QUESTION (57-UI-SPEC S3,
 * overflow). This is the one section permitted horizontal scroll, with a sticky lane
 * gutter. The cells are NOT shrunk to avoid it: shrinking them would take the machine
 * art out of the cell, and the width being judged beside the machine art it runs into is
 * the entire reason the strip is laid out this way. If the scroll reads badly on the
 * display it is judged on, that is recorded in 57-ART-LOCK.md section 5 rather than
 * fixed by reducing the cell content.
 */
export function buildLaneStrip(host: HTMLElement, deps: SlateDeps): void {
  const strip = document.createElement('div');
  strip.id = 'art-board-lanes';
  strip.style.marginTop = '32px';
  strip.style.paddingTop = '16px';
  strip.style.borderTop = `1px solid ${rule}`;

  const heading = textLine('Belt lane width', 13, 600, ink);
  heading.style.marginBottom = '8px';
  strip.appendChild(heading);

  const notes = document.createElement('div');
  notes.style.marginBottom = '16px';
  for (const line of LANE_NOTES()) notes.appendChild(textLine(line, 13, 400, ink));
  strip.appendChild(notes);

  const cellW = LANE_CONTENT_W_CELLS * CELL_U * LANE_STRIP_ZOOM + 2 * LANE_PAD;
  const cellH = LANE_CONTENT_H_CELLS * CELL_U * LANE_STRIP_ZOOM + 2 * LANE_PAD;

  // The scrolling region. Only the grid scrolls; the notes and the caption stay in the
  // page flow, so a reader who never scrolls still sees everything the strip claims.
  const scroller = document.createElement('div');
  scroller.setAttribute('data-lane-scroller', '');
  scroller.style.overflowX = 'auto';
  scroller.style.background = substrate;

  const grid = document.createElement('div');
  grid.style.minWidth = `${LANE_GUTTER_W + laneDirections().length * cellW + insetBoxW() + NUMBERS_BOX_W}px`;

  // The column headers. The four candidate directions, then the two columns that are
  // NOT artwork - named as such, so the strip is not read as six directions.
  const headerRow = document.createElement('div');
  headerRow.style.whiteSpace = 'nowrap';
  headerRow.style.marginBottom = '8px';
  const spacer = document.createElement('div');
  spacer.style.display = 'inline-block';
  spacer.style.width = `${LANE_GUTTER_W}px`;
  spacer.style.verticalAlign = 'top';
  spacer.style.position = 'sticky';
  spacer.style.left = '0';
  spacer.style.background = substrate;
  headerRow.appendChild(spacer);
  const columns: readonly { readonly label: string; readonly width: number }[] = [
    ...laneDirections().map((d) => ({ label: d as string, width: cellW })),
    { label: `inset ${INSET_MAGNIFICATION}x`, width: insetBoxW() },
    { label: 'printed consequence', width: NUMBERS_BOX_W },
  ];
  for (const column of columns) {
    const head = textLine(column.label, 11, 600, ink);
    head.setAttribute('data-lane-header', column.label);
    head.style.display = 'inline-block';
    head.style.boxSizing = 'border-box';
    head.style.width = `${column.width}px`;
    head.style.padding = `0 ${LANE_PAD}px`;
    head.style.verticalAlign = 'top';
    head.style.textAlign = 'left';
    headerRow.appendChild(head);
  }
  grid.appendChild(headerRow);

  for (const lane of LANE_WIDTHS) {
    const row = document.createElement('div');
    row.setAttribute('data-lane-row', String(lane));
    row.style.whiteSpace = 'nowrap';
    row.style.marginBottom = '16px';

    const gutter = textLine(`${lane} px`, 11, 600, ink);
    gutter.style.display = 'inline-block';
    gutter.style.width = `${LANE_GUTTER_W}px`;
    gutter.style.verticalAlign = 'top';
    gutter.style.position = 'sticky';
    gutter.style.left = '0';
    gutter.style.background = substrate;
    gutter.style.paddingTop = `${LANE_PAD}px`;
    row.appendChild(gutter);

    for (const direction of laneDirections()) {
      const box = laneCellBox(
        { 'data-lane-cell': '', 'data-lane': String(lane), 'data-direction': direction },
        cellW,
        cellH,
      );
      // NOTHING HERE THROWS PAST THIS POINT. A throw would blank the whole board, and a
      // blank page is the worst outcome for an instrument whose job is to show what is
      // missing - one failed width would take the other three with it.
      try {
        renderLaneCell(box, lane, direction, deps);
      } catch (err) {
        renderLaneErrorCell(box, lane, err instanceof Error ? err.message : String(err));
      }
      row.appendChild(box);
    }

    const insetBox = laneCellBox(
      { 'data-inset': '', 'data-lane': String(lane) },
      insetBoxW(),
      cellH,
    );
    try {
      renderInsetCell(insetBox, lane, deps);
    } catch (err) {
      renderLaneErrorCell(insetBox, lane, err instanceof Error ? err.message : String(err));
    }
    row.appendChild(insetBox);

    const numbersBox = laneCellBox(
      { 'data-numbers': '', 'data-lane': String(lane) },
      NUMBERS_BOX_W,
      cellH,
    );
    try {
      renderNumbersCell(numbersBox, lane);
    } catch (err) {
      renderLaneErrorCell(numbersBox, lane, err instanceof Error ? err.message : String(err));
    }
    row.appendChild(numbersBox);

    grid.appendChild(row);
  }

  scroller.appendChild(grid);
  strip.appendChild(scroller);

  const caption = document.createElement('div');
  caption.style.marginTop = '16px';
  caption.style.background = substrate;
  for (const line of LANE_CAPTION()) {
    caption.appendChild(textLine(line, 13, 400, inkMuted()));
  }
  strip.appendChild(caption);

  // The one bridge from LOCKED_SKIN to CSS, exercised so the import is used the same
  // way every other section uses it rather than through a second colour path.
  strip.style.color = hex(LOCKED_SKIN.palette.ramp[4] as number);

  host.appendChild(strip);
}
