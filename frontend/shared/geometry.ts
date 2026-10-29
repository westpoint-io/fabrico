// shared/geometry.ts (23-04, GATE-01) - the ONE source of truth for E2E grid
// geometry and the semantic color oracles, imported by BOTH the mock suite
// (frontend/e2e/) and the live suite (frontend/e2e-live/), and available to the
// app. This is a pure, dependency-free values module: NO Pixi, NO product
// source, NO product logic - only constants and the arithmetic that derives
// screen points from them. It lives OUTSIDE src/ on purpose so the zero-mock
// live suite can import it without coupling to product code (T-23-05): both
// suites asserting against the SAME values strengthens the audit rather than
// weakening it.
//
// VALUES ARE COPIED UNCHANGED from their historical sources (GATE-01 is a
// values-preserving extraction, not a value change - Phase 25 swaps CELL and
// Phase 28 swaps the palette, both as one-line edits here):
//   CELL / cellCentre point  <- frontend/e2e/support/wire.ts
//   CELL / INSET / NUB_PUSH / cellCentre scalar / nubAnchor
//                            <- frontend/e2e-live/support/oracle.ts
//   colorOracles             <- render/synth/skins/locked.ts (LOCKED_SKIN accents)
//
// All geometry assumes the IDENTITY camera (boot state: screen px == world px).

// ---------------------------------------------------------------------------
// Grid geometry constants
// ---------------------------------------------------------------------------

/** Grid cell size in px @ zoom 1.0 (GATE-01 single source); camera boots at identity. */
export const CELL = 32;

/** Machine body footprint within a cell (BODY < CELL, centered). */
export const BODY = 28;

/** Body inset from the cell edge: (CELL - BODY) / 2 = (32 - 28) / 2. Hardcoded literal. */
export const INSET = 2;

/** Outward push of the nub center past the body edge, along the outward normal. */
export const NUB_PUSH = 2.5;

/** Diagonal offset of the rotate handle past the selection outline's TR corner. */
export const HANDLE_OFFSET = 6;

/** A brighter grid orientation line every 8 cells (relocated here from theme.ts). */
export const MAJOR_EVERY = 8;

// ---------------------------------------------------------------------------
// The belt geometry record (BELT-08, plan 61-02)
// ---------------------------------------------------------------------------
//
// BELT-08 widens the FLOW-05 single source from ONE constant (`ELBOW_R`) to ONE
// RECORD. Before this record the lane half-width and the dash pattern lived as
// module-private literals inside `render/synth/generators.ts`, unreachable from
// the preview - which is exactly the drift surface FLOW-05 closed for the radius
// alone.
//
// EXACTLY WHAT THE PREVIEW SHARES WITH THE COMMITTED BELT, AND WHAT IT DOES NOT.
// This paragraph is deliberately narrow, because a wider version of it was FALSE
// for two years' worth of edits and the v7.0 milestone audit (2026-08-11) caught
// it. It read "the two cannot drift on lane width or dash rhythm"; neither half
// of that was held by anything.
//
//   - RADIUS: shared, by construction. `belts.ts drawBeltTilePath` defaults its
//     `cornerRadius` to {@link ELBOW_R}, the same value the committed corner
//     geometry is emitted on. Neither side can move without the other. This is
//     the original FLOW-05 property and it always held.
//   - LANE WIDTH: shared, by construction, SINCE 2026-08-11. The preview's stroke
//     width is `2 * BELT_GEOM.laneHalf` at its one call site
//     (`layers/overlay.ts` `showBeltPreview`); the committed tread spans
//     `laneHalf` either side of the same centreline. Until that date the call
//     site passed a module-private `10`, so the preview drew at HALF the lane and
//     an edit here would have moved the belt and left the preview behind.
//     `overlay.test.ts` ("draw-belt preview lane width") now gates the derivation.
//   - DASH RHYTHM: NOT shared, and it never was. The preview is a SOLID stroke -
//     `drawBeltTilePath` issues one `stroke()` with no dash - so `dash`, `gap` and
//     `band` have no preview side to drift from. They are single-sourced for the
//     committed surfaces that DO read them (the tread geometry and the chrome
//     glyph's proportions), not for preview == committed. Do not restate this as
//     a preview property; if the preview ever gains a dash, make it read these
//     fields and gate it before writing the claim back.
//
// Every field is an INTEGER in world px at zoom 1 on a 32 px cell, so every belt
// edge lands on a device-pixel boundary at zoom 1 / DPR 1 and `antialias: false`
// stays honest on the first live vector arc this project ships (61-UI-SPEC A2).
// A value here is never allowed to become fractional for convenience.
//
// This file's own header rule still holds: NO Pixi, NO product source, NO product
// logic. These are values and nothing else.

/** The belt geometry every belt surface reads. Frozen: the lock is not mutable. */
export interface BeltGeomRecord {
  /** Corner-elbow rounding radius, px. Provenance: 53-BELT-LOCK.md axis 3. */
  readonly elbowR: number;
  /** HALF the rail-outer-edge-to-rail-outer-edge lane, px. Lane = 2 * laneHalf. */
  readonly laneHalf: number;
  /** Side-rail thickness, px. Provenance: 53-BELT-LOCK.md axis 2 (1px hairline). */
  readonly rail: number;
  /** Inked run of one dash along flow, px. Provenance: 53-BELT-LOCK.md axis 1. */
  readonly dash: number;
  /** Clear run between two dashes along flow, px. Provenance: axis 1. */
  readonly gap: number;
  /** Dash thickness ACROSS flow, px, centred on the lane centreline. Axis 1. */
  readonly band: number;
}

/**
 * THE BELT GEOMETRY LOCK, as one record.
 *
 * Provenance, field by field (each value is transcribed from a signed source, never
 * re-derived here):
 *
 *   - `elbowR`   16 - `61-BELT-LOCK-SUPERSESSION.md`, SIGNED 2026-08-09,
 *                which supersedes 53-BELT-LOCK.md axis 3 and lifts its `<= 15`
 *                ceiling to 16. Moved here by plan 61-03, in the SAME commit that
 *                replaced the raster corner bake with vector geometry, so the corner
 *                digests and the corner pixel baseline broke exactly ONCE. See the
 *                {@link ELBOW_R} docblock below for the verification the supersession
 *                required and for the correction it produced.
 *   - `laneHalf` 10 - `61-BELT-LOCK-SUPERSESSION.md` (corner 28 -> 20) plus the maintainers'
 *                decision of 2026-08-10 (the STRAIGHT lane narrows 32 -> 20
 *                to match). 57-ART-LOCK section 3 / BOARD-03 lock the 20 px lane
 *                unconditionally. Lane = 20, leaving 6 px of board each side of the
 *                32 px cell - the same `ramp[0]` as the belt's own hollow interior,
 *                so the change reads as the rails moving inward and nothing else
 *                (61-UI-SPEC A7.1).
 *   - `rail`      1 - 53-BELT-LOCK.md axis 2, the INVERTED 1px hairline. Untouched.
 *   - `dash`     10 - 53-BELT-LOCK.md axis 1. Untouched.
 *   - `gap`       6 - 53-BELT-LOCK.md axis 1. Untouched.
 *   - `band`      2 - 53-BELT-LOCK.md axis 1: a 2.00px CENTRELINE dash, on the
 *                straight AND on the corner. The shipped raster corner draws 3px
 *                because `tArm` is an absolute value and a band centred on an
 *                integer pixel row can only be odd; vector geometry has no pixel
 *                rows, so that raster artefact does not survive VEC-01
 *                (61-UI-SPEC A4).
 *
 * THE OTHER `laneHalf` IN THE TREE IS GONE. `render/synth/generators.ts` carried a
 * second declaration of 14 - the CORNER lane half of the raster bake this phase
 * replaced - and the two coexisted only while the raster corner still shipped. Plan
 * 61-07 deleted those bakes and the record they read from, so this is now the ONE
 * lane-half in the tree and there is nothing left to read the raster one.
 */
export const BELT_GEOM: BeltGeomRecord = Object.freeze({
  elbowR: 16,
  laneHalf: 10,
  rail: 1,
  dash: 10,
  gap: 6,
  band: 2,
});

/**
 * The dash PERIOD along flow, px: one inked run plus one clear run.
 *
 * Derived, never re-typed, because the seam identity depends on it: `CELL` (32) is a
 * whole multiple of this period (32 = 2 x 16), so a straight tile's exit dash phase
 * equals its entry phase and every straight-to-straight tile boundary carries a
 * 0.00px seam EXACTLY - an identity over the record, not a measurement bounded by
 * the phase quantization (61-UI-SPEC A1 row 2).
 */
export const BELT_DASH_PERIOD = BELT_GEOM.dash + BELT_GEOM.gap;

/**
 * The corner-elbow rounding radius (px @ zoom 1.0), the SINGLE source of the belt
 * corner curve. It is the radius `drawBeltTilePath` strokes for the draw-belt
 * PREVIEW (belts.ts `arcTo`) AND the radius the committed corner tread is emitted on
 * (render/synth/beltGeometry.ts; it was a raster bake in `render/synth/generators.ts`
 * until plan 61-03 made it vector and 61-07 deleted it). Lifting it here (FLOW-05)
 * makes preview == committed by construction: neither side can drift because both
 * import this one constant. A pure geometry value (like CELL); no product logic.
 *
 * ---------------------------------------------------------------------------
 * 16, NOT 15 - AND PHASE 53'S STATED REASON FOR THE 15 CEILING WAS INVERTED
 * ---------------------------------------------------------------------------
 *
 * You are almost certainly reading this because you want to know why the radius is
 * exactly half a cell. It is written HERE, at the constant, because this docblock is
 * where a future reader lands - not only in the planning record.
 *
 * `53-BELT-LOCK.md` axis 3 locked 15 under a hard ceiling `elbowR <= 15`, and gave as
 * its reason that "the radius must be STRICTLY less than `CELL / 2` = 16 so the arc
 * tangents fall inside the tile". **That reasoning is backwards.** The tangents fall
 * inside the tile at 16 as well, so the constraint it stated never discriminated
 * between 15 and 16 at all:
 *
 *   - At R = 16 the arc centre is `CELL/2 - R` = 0 from the tile corner. The arc is
 *     `(16 cos t, 16 sin t)` for t in [0, 90], so every point has both coordinates in
 *     [0, 16] - inside the 0..32 tile. Even the OUTER rail, at `R + laneHalf` = 26,
 *     only reaches (26, 0) and (0, 26). NOTHING leaves the tile at 16.
 *   - The constraint that WAS load-bearing is that the tangent points land ON the
 *     tile-edge midpoints, which is where a neighbouring straight tile's centreline
 *     arrives. At R = 16 they are exactly (16, 0) and (0, 16) - the midpoints. At
 *     R = 15 the centre sits at (1, 1) and the tangents at (16, 1) and (1, 16): one
 *     pixel off the edge midpoint, so the corner's centreline met the straight's out
 *     of register AT EVERY JOIN.
 *   - `R === CELL / 2` satisfies the midpoint property UNIQUELY. 15 violated it.
 *
 * So the lock's NUMBER was wrong and its REASON was wrong in the opposite direction:
 * the ceiling excluded the only value that satisfies the constraint the ceiling was
 * trying to express. The signed `61-BELT-LOCK-SUPERSESSION.md` (2026-08-09)
 * lifts the ceiling to 16 and requires this to be VERIFIED rather than assumed - so it
 * is asserted executably, and asserted to FAIL at neighbouring radii, in
 * `src/render/synth/beltGeometry.test.ts`. Do not weaken that discriminator into a
 * derivation: a derivation-only assertion agrees with itself at any radius.
 *
 * The arithmetic above is `61-UI-SPEC.md` A3. The lane width that moves with it
 * (`laneHalf` 14 -> 10, a 20px lane) is the same supersession's only other cell.
 *
 * ONE EDIT, TWO CONSUMERS. Moving this constant moves the draw-belt preview arc AND
 * the committed corner tread together, which is the FLOW-05 single-source property
 * working as designed rather than a coincidence to be careful about.
 *
 * BELT-08: the value now lives in {@link BELT_GEOM} and this export READS it rather
 * than declaring a second copy. The name is kept because thirteen consumer files
 * import it, and a rename would be churn with no property behind it.
 */
export const ELBOW_R = BELT_GEOM.elbowR;

// ---------------------------------------------------------------------------
// Cell-centre helpers
// ---------------------------------------------------------------------------
//
// Two historical `cellCentre` signatures existed and clashed:
//   - live suite  (oracle.ts):  cellCentre(c) -> scalar (one axis)
//   - mock suite  (wire.ts):    cellCentre(cx, cy) -> { x, y } point
// The shared module exposes both cleanly: scalar per-axis (cellCentreX/Y) and
// the point form (cellCentrePt). Each caller re-exports under its historical
// name so no spec call site changes.

/** Screen-px centre of a grid cell along the X axis (identity camera). */
export function cellCentreX(c: number): number {
  return c * CELL + CELL / 2;
}

/** Screen-px centre of a grid cell along the Y axis (identical math to X). */
export function cellCentreY(c: number): number {
  return c * CELL + CELL / 2;
}

/** Screen-px centre POINT of grid cell (cx, cy). */
export function cellCentrePt(cx: number, cy: number): { x: number; y: number } {
  return { x: cellCentreX(cx), y: cellCentreY(cy) };
}

// ---------------------------------------------------------------------------
// Port nub + rotate-handle anchors
// ---------------------------------------------------------------------------

/**
 * The nub anchor for a port cell + side at the identity camera: the edge
 * midpoint of the cell, inset INSET px from the edge, pushed NUB_PUSH px along
 * the outward normal. Mirrors the renderer's authoritative anchor math
 * (src/protocol/ports.ts nubAnchor - cross-checked, NOT imported: geometry
 * stays product-free). Side keyspace is the core order N=0, E=1, S=2, W=3.
 * Proven constants: E-side x = cellX*32 + 30 + 2.5, W-side x = cellX*32 + 2 - 2.5.
 */
export function nubAnchor(cellX: number, cellY: number, side: number): { x: number; y: number } {
  switch (side & 3) {
    case 0: // N: y = cellY*32 + 2 - 2.5, x = cell midpoint
      return { x: cellCentreX(cellX), y: cellY * CELL + INSET - NUB_PUSH };
    case 1: // E: x = cellX*32 + 30 + 2.5, y = cell midpoint
      return { x: cellX * CELL + CELL - INSET + NUB_PUSH, y: cellCentreY(cellY) };
    case 2: // S: y = cellY*32 + 30 + 2.5, x = cell midpoint
      return { x: cellCentreX(cellX), y: cellY * CELL + CELL - INSET + NUB_PUSH };
    default: // W: x = cellX*32 + 2 - 2.5, y = cell midpoint
      return { x: cellX * CELL + INSET - NUB_PUSH, y: cellCentreY(cellY) };
  }
}

/**
 * The rotate handle's screen anchor for a selection whose min cell is
 * (minX, minY) and whose footprint width is `w` cells. The handle pins
 * diagonally outside the selection outline's top-right corner tick:
 *   outline right = minX*CELL + w*CELL - INSET, top = minY*CELL + INSET
 * offset by (+HANDLE_OFFSET, -HANDLE_OFFSET). Identity camera; the exact value
 * the specs previously computed inline (verified values-preserving).
 */
export function rotateHandle(minX: number, minY: number, w: number): { x: number; y: number } {
  return {
    x: minX * CELL + w * CELL - INSET + HANDLE_OFFSET,
    y: minY * CELL + INSET - HANDLE_OFFSET,
  };
}

// ---------------------------------------------------------------------------
// Color oracles - the four semantic accents, re-anchored to the live skin source
// of truth: render/synth/skins/locked.ts (LOCKED_SKIN.palette.accents). theme.ts
// deleted its numeric item/colour exports, so the old "copied from theme.ts:39-44"
// provenance no longer holds. Phase 28's coordinated re-bless swaps these values;
// ready for the Phase 28 fault-red probe.
// ---------------------------------------------------------------------------

/** Semantic-accent colors, mirroring LOCKED_SKIN.palette.accents (locked.ts). */
export const colorOracles = {
  /** live item dot accent (reskin paints core AND glow ring from this one accent) */
  itemHalo: 0xffb454,
  /** working / healthy / valid (emerald) */
  working: 0x34d399,
  /** fault / backpressure / invalid / destructive (red-pink) */
  fault: 0xf0506e,
  /** ghost / wire-preview / selection / primary CTA (build-blue) */
  build: 0x4fa8ff,
} as const;

// ---------------------------------------------------------------------------
// Ramp oracle - the five-step substrate ramp of the ONE shipped skin, mirroring
// render/synth/skins/locked.ts (LOCKED_SKIN.palette.ramp). SKIN-02 (v7.0) removed
// the theme system, so there is one entry here and there will never be a second
// while a single skin ships. Values are COPIED by hand from locked.ts (never
// imported - this module stays pure and product-free, exactly as colorOracles
// does); the oracle-sync vitest guard cross-checks each entry against the skin
// palette so any drift fails CI. Chrome specs source their ramp-step probes
// (panel fill = ramp[2], lit bezel edge = ramp[4]) from here rather than
// inlining hex.
// ---------------------------------------------------------------------------

/** The five-step substrate ramp, mirroring LOCKED_SKIN.palette.ramp. */
export const rampOracles = {
  /** LOCKED_SKIN.palette.ramp[0..4] (locked.ts) - "Clean Slate" grey-steel ramp. */
  locked: [0x1b1f27, 0x2a2f3a, 0x3b4250, 0x565f70, 0xb0bacb],
} as const;

// ---------------------------------------------------------------------------
// Numeric-color format helpers - pure, dependency-free conversions so a single
// oracle value can be compared against BOTH a computed --fab-* CSS custom
// property (string form) and a decoded PNG pixel (channel form).
// ---------------------------------------------------------------------------

/** Format a 0xRRGGBB numeric color as a lowercase `#rrggbb` CSS string. */
export function colorToCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Decode a 0xRRGGBB numeric color to 8-bit `{ r, g, b }` channels. */
export function colorToRgb(color: number): { r: number; g: number; b: number } {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}
