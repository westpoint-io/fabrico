// THE BELT GEOMETRY MODULE (VEC-01, BELT-05, BELT-08 - plan 61-02).
//
// The belt's shape, DESCRIBED rather than drawn. This module emits path-command
// DATA; `beltPainter.ts` turns that data into a Pixi `GraphicsContext`. That is the
// same describe-then-draw split `layers/machineChassis.ts` uses (`chassisSpec` is
// the description, `drawChassis` and `chassisPathD` are two consumers of it), and it
// is here for the same reason: one declaration of the shape, many consumers, and a
// description that can be measured without a renderer.
//
// THIS FILE IMPORTS NOTHING FROM PIXI, NOT EVEN A TYPE, AND THAT IS LOAD-BEARING.
// It is what keeps the geometry digest-testable in the project's DEFAULT vitest
// environment - no GL context, no DOM, no environment pragma in the spec. A type-only
// Pixi import would be harmless at runtime and would still be wrong here: the moment
// this module names a Pixi type, the next edit reaches for a Pixi VALUE and the
// property is gone with nothing to catch it. `machineChassis.ts` takes the opposite
// (type-only) trade because it draws INTO a `Graphics`; this module hands its output
// to someone else, so it needs no Pixi vocabulary at all.
//
// NO NODE BUILTIN IMPORT HERE, EVER (T-61-06). This is a browser-bundle module: a
// Node builtin would break the Tauri build. Any digest helper a spec needs lives
// test-file-local, exactly as `svgAssets.ts` and `synth/beltPainter.digest.test.ts`
// each hold their own.
//
// THE FLOAT BOUNDARY IS ONE-WAY (T-61-05, T-14-FLOAT-LEAK, T-31-DET). Everything
// below is render-side geometry. It reads two value modules and NOTHING else - no
// decoder, no `GridCommand`, no protocol type - so there is no path by which a
// number computed here can reach the sim.
//
// ---------------------------------------------------------------------------
// THE UNIT STORY
// ---------------------------------------------------------------------------
//
// Every number this module emits is WORLD PX AT ZOOM 1 ON A 32 PX CELL, in
// TILE-LOCAL coordinates whose ORIGIN IS THE TILE CENTRE - because a belt tile's
// display object is positioned at its cell centre (`belts.ts` writes
// `position.set(centre)`) and rotated about that point. Every one of the four cardinals
// is a whole-quarter-turn ROTATION applied by the layer, never a second emitter.
//
// NATIVE FLOW RUNS ALONG -x, i.e. WEST, and this header said "+x" until Phase 62. The
// authority is `belts.ts`, whose `tileRotation` sends dir=W to ZERO quarter turns and
// whose own comment reads "the native tread chevron points WEST". The sign matters far
// more than a header usually does: a marching emitter has to know which end of its
// parameter is the exit, and this sentence being backwards is traceable to a shipped
// defect (the corner tread marched backwards from plan 61-03 to Phase 62).
//
// These are NOT chrome CSS px and this module never quotes a `--fab-space-*` token.
// The two ladders are different units over different surfaces (61-UI-SPEC, "Canvas
// spacing is a different unit and is NOT on this ladder"), and neither may borrow a
// number from the other.
//
// Every emitted coordinate is an INTEGER (61-UI-SPEC A2), which is what lets
// `antialias: false` stay honest: at zoom 1 / DPR 1 every belt edge lands on a
// device-pixel boundary rather than half-covering two of them.

import { BELT_DASH_PERIOD, BELT_GEOM, CELL } from '../../../shared/geometry';

/**
 * What one emitted path is FOR, so the painter can ink it.
 *
 * Colour is deliberately absent from the command itself: a colour is a skin lookup
 * and this module has no skin. The role is the minimum the painter needs to resolve
 * one - the painter's ink record carries `railRamp` and `inkRamp` as two fields, and a
 * variant is allowed to make them differ, so collapsing the two roles into one here
 * would quietly delete an axis the ink record still declares. (That record moved from
 * `generators.ts` to `beltPainter.ts` in plan 61-07, with the raster bakes it belonged
 * to; the two-field shape and the ramp-INDEX discipline moved with it unchanged.)
 */
export type BeltPathRole = 'rail' | 'tread';

/**
 * How one emitted path is realised: a filled area, or a stroked centreline.
 *
 * `alignment` is Pixi's stroke alignment (0 outer, 0.5 centred, 1 inner) and is
 * carried explicitly rather than left to the default, because the whole integer-edge
 * property depends on knowing which side of the centreline the ink lands on.
 *
 * THE STRAIGHT TILE EMITS FILLS ONLY, and that is forced rather than preferred: a
 * 1px rail expressed as a centred STROKE would put its centreline at a half-integer
 * coordinate, breaking the integer-edge contract on the very first tile. Expressed
 * as a FILLED 1px rectangle, both of its edges are integers. The stroke arm exists
 * for the corner (plan 61-03), whose rail arcs have no rectangular form.
 */
export type BeltPathStyle =
  | { readonly mode: 'fill' }
  | { readonly mode: 'stroke'; readonly width: number; readonly alignment: number };

/**
 * ONE path of a belt tile: an op tag, a flat point list, a close flag, what it is
 * for, and how it is realised.
 *
 * The point list is FLAT (`[x0, y0, x1, y1, ...]`) rather than an array of points so
 * that a digest over it is a digest over numbers in a fixed order, with no object
 * key ordering anywhere in the hash (plan 61-04's committed geometry table).
 */
export interface BeltPathCommand {
  /**
   * The ONLY op, on the straight AND on the corner (plan 61-03).
   *
   * The corner was expected to need an arc op and does not: its rails and its dash
   * sectors are SELF-SAMPLED point lists (see {@link ARC_SAMPLES}), so a curve never
   * reaches a Pixi tessellator and one fixed tessellation serves every zoom. That is
   * what retires the `buildAdaptiveBezier` stale-geometry risk BY CONSTRUCTION rather
   * than by a re-plot mechanism that has to fire correctly on every zoom transition.
   */
  readonly op: 'poly';
  /** Flat `[x0, y0, x1, y1, ...]` in tile-local world px, origin at tile centre. */
  readonly points: readonly number[];
  /** Whether the point list closes back to its first point. */
  readonly close: boolean;
  /** What the path is for; the painter resolves this to a ramp step. */
  readonly role: BeltPathRole;
  /** Fill or stroke. */
  readonly style: BeltPathStyle;
}

const FILL: BeltPathStyle = Object.freeze({ mode: 'fill' });

/** Half a cell: the tile-local extent along and across flow from the centre. */
const HALF = CELL / 2;

/** A quarter turn in radians - the sweep of one corner tile. */
const QUARTER = Math.PI / 2;

/** The lane's outer edge across flow. The lane spans `[-LANE, +LANE]`. */
const LANE = BELT_GEOM.laneHalf;

/** Half the dash band, across flow. The band spans `[-BAND, +BAND]`. */
const BAND = BELT_GEOM.band / 2;

/**
 * Half the low-zoom tick's run along flow.
 *
 * `CELL / 4` = the shipped raster tick's columns 8..24 (`generators.ts TICK_X0` /
 * `TICK_X1`) restated in centre-origin coordinates, so the LOD mark keeps exactly
 * the extent it has today. Derived from `CELL`, never re-typed as a column pair.
 */
const TICK_HALF = CELL / 4;

/**
 * One axis-aligned rectangle, as a closed 4-point polygon.
 *
 * Every straight-tile path goes through here, which is why every straight-tile
 * coordinate is an integer whenever `x`, `y`, `w` and `h` are: the four emitted
 * points are sums of the four arguments and nothing else.
 */
function rect(x: number, y: number, w: number, h: number, role: BeltPathRole): BeltPathCommand {
  return {
    op: 'poly',
    points: [x, y, x + w, y, x + w, y + h, x, y + h],
    close: true,
    role,
    style: FILL,
  };
}

// ---------------------------------------------------------------------------
// THE DEVICE-QUANTUM RAIL RULE (BELT-05, VEC-01 - plan 61-09)
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS EXISTS TO CLOSE, MEASURED RATHER THAN SUPPOSED. A band `w` DEVICE
// px wide, with `antialias: false`, is filled only where a whole pixel CENTRE falls
// inside it. When `w < 1` a band may contain no centre at all, and that is a property
// of the number `w` and not of where the band sits. The rail is 1 WORLD px, so at
// camera scale `s` on a display of device-pixel ratio `r` its device width is
// `q = r * s`, and the whole defect lives in `q < 1`.
//
// Measured on 2026-08-10 over a ten-tile straight run, `antialias: false`, DPR 1,
// pixels read back through Pixi's own extract path: the VECTOR belt lost a whole rail
// at four of the six camera scales 0.75/0.80/0.85/0.90/0.95/1.00, and the PRE-PHASE
// RASTER belt (tag `phase-60-final`) lost one at two of the same six. **The defect
// CLASS is inherited; this phase roughly doubled its frequency** by moving the rails
// off the tile boundary (world y 0 and 31, which survive downscaling by construction)
// onto the interior rows the 20 px lane puts them on (world y 6..7 and 25..26). At
// DPR 2 the LOD cut already floors `q` at 1.5, which is why this is a ratio-1 defect.
//
// TWO OTHER REMEDIES ARE OUT. Raising the LOD cut 24 -> 32 was MEASURED not to close
// it (the low-zoom tick emits the same rails and drops them identically at 0.50 and
// 0.70). Thickening the rail is `53-BELT-LOCK` axis 2, a locked cell with no signature.
//
// THE COST, PAID KNOWINGLY. Minimum DEVICE thickness is inherently scale-dependent, so
// the rails CANNOT stay inside the four cached TREAD contexts without making those
// scale-dependent too - which is precisely the property `61-RESEARCH.md` FINDING 1
// bought and the property that keeps the tread cache at `3K + 3` = 39 with no zoom
// term. So the rails LEAVE those contexts and become their own family, emitted at the
// live quantum and held at that quantum only. **The quantum is a cache LIFETIME term
// and never a cache KEY term** (`belts.ts` invalidates the rail cache on its existing
// `qChanged` trigger), which is what keeps `beltContextKey`'s three-segment contract
// literally true and keeps the rail cache from growing during a zoom gesture.

/**
 * The two DEVICE-space integers and the one WORLD-space overhang that drive every
 * rail this module emits, derived ONCE from the live quantum so the straight and the
 * corner cannot acquire different lanes.
 */
export interface RailBand {
  /** The quantum actually used - the caller's, sanitised (see {@link railBandAt}). */
  readonly quantum: number;
  /** The lane's outer half-width in DEVICE px. Applied as `-d` and `+d`. */
  readonly d: number;
  /** The rail band's DEVICE thickness, floored at ONE whole device pixel. */
  readonly t: number;
  /** The along-flow overhang in WORLD px that closes the seam gap columns. */
  readonly over: number;
}

/**
 * The device-snap of the rail band, from the live device quantum `q = DPR * zoom`.
 *
 * ITS PRECEDENT IS `items.ts snapToDevicePixel`, AND IT IS RESTATED HERE RATHER THAN
 * IMPORTED. That function is the same rounding discipline applied to a POSITION; this
 * is the same discipline applied to a BAND. It is not imported because this module
 * imports nothing from a render layer and nothing from Pixi, and that purity is what
 * keeps the geometry digest-testable in the project's default vitest environment with
 * no GL context and no DOM. Reaching into `render/layers/` for four lines would trade
 * that property away for a de-duplication nobody asked for.
 *
 * THE THREE TERMS:
 *
 *   - `d = round(laneHalf * q)` - derived once and applied as `-d` and `+d`, so the
 *     lane is symmetric BY CONSTRUCTION. Computing the two edges independently would
 *     break symmetry: rounding a negative half-integer does not mirror rounding a
 *     positive one (`Math.round(-7.5)` is -7 while `Math.round(7.5)` is 8).
 *   - `t = max(1, round(rail * q))` - **the `max(1, ...)` IS the whole fix.** The
 *     `round` keeps apparent weight within half a device pixel of the ideal at every
 *     quantum, rather than letting the rail fatten as it must not (axis 2 is locked)
 *     or thin as it must not (this defect).
 *   - `over = ceil(HALF * q) / q - HALF` - the along-flow overhang in WORLD px. Two
 *     snapped tile centres are `round(c * q)` apart, so they differ by `floor(CELL*q)`
 *     or `ceil(CELL*q)` device px, while the rail spans `2 * ceil(HALF*q)`. Since
 *     `2 * ceil(HALF*q) >= CELL*q` and is an integer, it is `>= ceil(CELL*q)` - so
 *     adjacent tiles abut or overlap at EVERY quantum and an interior gap column
 *     cannot exist. That is an identity over the arithmetic, not a pixel measurement.
 *
 * AT EVERY INTEGER QUANTUM ALL THREE TAKE THEIR IDENTITY VALUES (`d = laneHalf * q`,
 * `t = rail * q`, `over = 0`), so the emitted geometry is the PRE-FIX geometry exactly
 * and every committed pixel baseline in the tree - all captured at DPR 1 and zoom 1 -
 * is byte-unchanged by this rule.
 *
 * A DEGENERATE QUANTUM FALLS BACK TO 1 rather than dividing every coordinate to
 * Infinity. `belts.ts` reads the quantum from a live closure and a camera-init
 * transient can hand it 0; the same guard shape `snapToDevicePixel` already carries.
 */
export function railBandAt(quantum: number): RailBand {
  const q = quantum > 0 && Number.isFinite(quantum) ? quantum : 1;
  return {
    quantum: q,
    d: Math.round(LANE * q),
    t: Math.max(1, Math.round(BELT_GEOM.rail * q)),
    over: Math.ceil(HALF * q) / q - HALF,
  };
}

/**
 * The two flow-parallel side rails at the live device quantum, shared by the
 * full-detail straight tile and the low-zoom straight tick.
 *
 * Each rail is a band lying INSIDE the lane edge, so the rail OUTER edges are exactly
 * `2d` DEVICE px apart and the lane measures 20.00 world px rail-edge to rail-edge at
 * the identity quantum (BELT-05). The north band occupies device `[-d, -d + t]` and
 * the south band device `[d - t, d]`, expressed back in world units by dividing by
 * `q`; subtracting INWARD from the lane edges (rather than adding outward from a
 * centreline) is what keeps the lane width a property of `d` alone.
 *
 * BOTH DEVICE EDGES OF BOTH BANDS ARE WHOLE DEVICE ROWS, and that only works because
 * the tile CENTRE is already snapped: `belts.ts` runs every tile position through
 * `snapToDevicePixel` at the same quantum, so this band is snapped RELATIVE to a point
 * that is itself on a whole device pixel. Neither half of that pair is sufficient alone.
 */
export function railCommands(quantum: number): BeltPathCommand[] {
  const { quantum: q, d, t, over } = railBandAt(quantum);
  const x0 = -(HALF + over);
  const w = 2 * (HALF + over);
  return [
    rect(x0, -d / q, w, t / q, 'rail'),
    rect(x0, (d - t) / q, w, t / q, 'rail'),
  ];
}

/**
 * The dash phase, in px, that the pattern has advanced by at march bucket `bucket`
 * of `phases`.
 *
 * Euclidean, so a negative or pinned bucket still lands in `[0, period)` - the same
 * discipline {@link bucketOf} applies one level up, and for the same reason: a pinned
 * or rewound render clock must produce a drawn frame, not a gap.
 *
 * THE POINTER THIS SENTENCE USED TO CARRY IS RETIRED, and it is corrected rather than
 * deleted because a dangling one is worse than a named absence. It read *"the same
 * discipline `belts.ts marchPhaseOf` applies one level up"*, in the present tense.
 * `marchPhaseOf` is GONE from `belts.ts` rather than repurposed (`belts.ts:41-44`
 * records why, and `belts.test.ts` pins its absence twice), so this was the one
 * surviving live reference to it and it landed a reader nowhere. `bucketOf` is the
 * live consumer that holds the same property, and it is in THIS module.
 *
 * The buckets subdivide ONE DASH PERIOD, not one cell. That is the split-knob model
 * (`61-CONTEXT.md` section B): `phases` (K) is a rendering-budget quantization of the
 * pattern and no longer sets the speed. Plan 61-04 completed it - the painter's quantum
 * is 1 and its pitch is the dash period. **How MANY buckets a tick advances is now a
 * property of the BELT rather than of this module** (Phase 62, D-05): see
 * {@link marchPxPerTick}. This sentence used to close by naming an art-directed px/sec
 * constant, which no longer exists.
 */
function dashPhase(bucket: number, phases: number): number {
  return (eucMod(bucket, phases) * BELT_DASH_PERIOD) / phases;
}

// ---------------------------------------------------------------------------
// THE MARCH: TWO INDEPENDENT KNOBS (BELT-06 - plan 61-04)
// ---------------------------------------------------------------------------
//
// THE SHIPPED MODEL WELDED THEM AND THAT IS WHY BELT-06 COULD NOT BE FIXED IN PLACE.
// It derived the step from the bucket count - `step = tread pitch / phase count` =
// 32 / 4 = 8px per animation frame at 6 sim ticks per frame - so
// raising the bucket count FOR SMOOTHNESS necessarily SLOWED the belt. The two knobs
// below are independent: the SPEED is a per-belt derivation off the render packet
// ({@link marchPxPerTick}) and nothing else, `BELT_MARCH_BUCKETS` is a rendering-budget
// quantization and nothing else. Plan 61-04 made the speed knob an art-directed module
// constant; Phase 62 deleted that constant by derivation (D-05) without touching the
// split, because the split is what makes a per-belt speed cost nothing on screen.
//
// NOTHING HERE MAY EVER READ A WALL CLOCK (T-61-13). The march is a pure function of
// the sim render clock in TICK UNITS. `performance.now()` and `Date.now()` are the
// exact failure class MOTION-01 was created to kill - it replaced a `performance.now()`
// "rotating laser" - and a one-tick quantum is the most tempting place in this codebase
// to reach for one, because the temptation is precisely "the clock is coarse, borrow a
// finer one". The clock is not coarse; it is DESIGNATED, and replay determinism is what
// that buys.

// ---------------------------------------------------------------------------
// KNOB ONE WAS AN ART-DIRECTED px/sec FIGURE. IT IS DELETED BY DERIVATION (D-05).
// ---------------------------------------------------------------------------
//
// THREE CONSTANTS STOOD HERE AND ALL THREE ARE GONE, deleted rather than corrected:
// a sim tick rate, a march speed in world px per SECOND, and the per-tick advance the
// first two produced. Their only job was converting an art-directed px/sec figure into
// the px/tick the march actually consumes, and `62-CONTEXT.md` D-05 removes that job
// outright: the tread's advance is now `slotPitchPx / ticksPerSlot`, every input taken
// off the render packet (see {@link marchPxPerTick}), which needs no ticks-per-second
// term at all. **The painted surface carries at the speed of its cargo.**
//
// THIS SUPERSEDES A SIGNED ART AXIS, EXPLICITLY (D-07). `61-BELT-LOCK-SUPERSESSION.md`
// axis "march rate" locked the pace at 80 px/sec, and that lock is retired by name in
// `62-BELT-MARCH-RATE-SUPERSESSION.md` (internal design notes).
// WHAT THE AXIS FIXED, so the supersession is not read as a loss: the belt read at one
// deliberate pace on every board, independent of the sim, which is what let Phase 61
// tune smoothness without renegotiating speed. WHAT REPLACES IT: the tread's pace is a
// consequence of the sim rather than a taste, so a slow belt LOOKS slow and the surface
// can no longer lie about its cargo. WHAT IS NOT SUPERSEDED: the dash PERIOD (16 px)
// and the bucket architecture. Phase 61 built the tread for variable-speed belts on
// purpose - all belts share the same buckets and walk them at their own rate, and the
// asset cache is keyed by BUCKET only - so a per-belt rate changes WHICH bucket is
// selected and never adds one. See {@link BELT_MARCH_BUCKETS}.
//
// THE NYQUIST WALL IS NOW MACHINE-ENFORCED RATHER THAN NARRATED, and it is stated in
// px per SIM TICK because that is the unit the march has: see
// {@link MARCH_NYQUIST_CEILING_PX_PER_TICK}, which {@link marchPxPerTick} clamps to.
//
// `loop.ts`'s `SIM_TICK_MS` IS A DIFFERENT THING AND NEEDS NO CHANGE. It is the
// render-clock smoothing coefficient - how many tick-units the clock advances per
// millisecond of display time - not a claim about the host's cadence. The sim host
// actually runs at ~62.5 t/s (`crates/fabrico-host/src/sim_loop.rs`), and reconciling
// the two figures was the job the deleted constants made necessary. The deletion
// removes the reconciliation rather than performing it, which is why `loop.ts` is
// untouched. **Do not "finish the job" by re-pointing it.**
//
// THERE IS NO LONGER ANY EXCEPTION, AND THAT IS RECORDED RATHER THAN LEFT BLANK. Phase
// 62 kept ONE copy of the superseded px-per-second figure, under a different symbol
// name, inside a define-gated development panel absent from the shipped bundle - an
// appearance instrument, not a render-path constant. Plan 68-07 deleted that panel with
// the rest of the development pace switch (BELT-05 / D-68-12), so the figure now appears
// ZERO times in the tree and the exception this paragraph used to name is gone. Do not
// reintroduce it under any symbol name.

/**
 * THE ALIASING CEILING on the tread's advance, in world px per SIM TICK. **8 px.**
 *
 * A dash pattern cannot convey motion faster than HALF ITS PERIOD per drawn step
 * without becoming direction-ambiguous: a jump forward by half a period is
 * indistinguishable from a jump backward by half a period. At the locked 16 px period
 * that wall is 8 px per tick.
 *
 * IT USED TO BE NARRATED IN px/sec AND IS NOW A CLAMP. The retired prose said the wall
 * was "480 px/sec, which is EXACTLY the item speed", and drew the correct conclusion
 * that the tread could not honestly match its cargo at the locked period. Stating it
 * per SIM TICK says the same thing without a ticks-per-second term, and
 * {@link marchPxPerTick} now enforces it instead of describing it.
 *
 * **AT THE IDENTITY INTERVAL THE TREAD SITS EXACTLY ON THIS WALL, and that is a
 * transient of the tree rather than a shipped look.** An item advances one 8 px slot
 * per due tick, so a tread carrying at its cargo's speed advances 8 px per tick while
 * `ticks_per_slot` is 1. `62-CONTEXT.md` D-06 puts a hard floor under the shipped
 * interval for exactly this reason ("belt speed must be at most half today's",
 * comfortable band one half to one quarter), so at any interval this phase can ship the
 * tread is at or under half the wall. The identity is the pre-change value, not a
 * candidate pace, and plan 62-09 replaces it from `62-SITTING-VERDICT.md`.
 */
export const MARCH_NYQUIST_CEILING_PX_PER_TICK = BELT_DASH_PERIOD / 2;

/**
 * THIS BELT's tread advance per SIM TICK, in world px. **Derived from the sim, never
 * art-directed** (`62-CONTEXT.md` D-05, SLOT-03).
 *
 * `slotPitchPx` is how far one item slot sits from the next along flow, and
 * `ticksPerSlot` is how many sim ticks the belt takes to move an item across that gap.
 * Their quotient is the speed of the cargo, and the surface now carries at it. Both
 * inputs come off the render packet; nothing here re-types a core constant, which is
 * the rule `interp.ts` states (a render-side copy would be a second source of truth
 * that a core bump could silently desynchronise).
 *
 * TOTAL BY CONSTRUCTION, because a bad number here is a RENDER-HEALTH failure and not a
 * cosmetic one. A non-finite or zero advance makes `bucketOf`'s phase non-finite,
 * `Math.round(NaN)` is `NaN`, and a `NaN` bucket index misses the asset cache and
 * throws inside `Application.render` - which, running as a Ticker listener, stops the
 * render loop PERMANENTLY on a partial frame
 * (debug record "machines missing on WebKitGTK", internal design notes). So a non-finite or
 * non-positive input degrades to the ceiling rather than propagating.
 *
 * CLAMPED AT {@link MARCH_NYQUIST_CEILING_PX_PER_TICK}, which is a no-op at every
 * slot pitch the shipped model produces (32 px cell / 4 slots = 8 px, exactly the
 * ceiling, at an interval of 1) and becomes load-bearing only if a future slot pitch
 * exceeds half the dash period. The clamp is what makes D-06 a property of the code
 * instead of a paragraph.
 */
export function marchPxPerTick(slotPitchPx: number, ticksPerSlot: number): number {
  const pitch = Number.isFinite(slotPitchPx) && slotPitchPx > 0 ? slotPitchPx : BELT_DASH_PERIOD;
  const interval = Number.isFinite(ticksPerSlot) && ticksPerSlot >= 1 ? Math.floor(ticksPerSlot) : 1;
  return Math.min(pitch / interval, MARCH_NYQUIST_CEILING_PX_PER_TICK);
}

/**
 * How many SIM TICKS the tread takes to travel one whole dash period, at `pxPerTick`.
 *
 * It was a module constant reading 12, computed from the deleted px/sec figures in an
 * all-integer form (`period * ticksPerSec / rate`) chosen so the result was exact in
 * binary floating point rather than 12.000000000000002. With the rate now per belt it
 * is a function of that belt's advance, and the float hazard goes with the deleted
 * constants: `period / advance` is exact whenever the advance divides the period, which
 * every power-of-two slot pitch does.
 *
 * IT IS THE CEILING ON A USEFUL BUCKET COUNT and it RISES AS THE TREAD SLOWS - see
 * {@link BELT_MARCH_BUCKETS}, whose ladder argument this function is the subject of.
 */
export function ticksPerDashPeriod(pxPerTick: number): number {
  return BELT_DASH_PERIOD / marchPxPerTick(pxPerTick, 1);
}

/**
 * KNOB TWO: the number of distinct baked phase buckets, K. **12 by default.**
 *
 * A pure rendering-budget / smoothness quantization. It NO LONGER SETS THE SPEED, which
 * is the whole of this plan.
 *
 * **THE LADDER ARGUMENT IS UNCHANGED; ITS ANCHOR MOVED FROM A CONSTANT TO A BELT.**
 * The useful ceiling on K is the number of DISTINCT march positions a dash period can
 * hold, `min(K, PERIOD / advance)` = `min(K, ticksPerDashPeriod(advance))`, and it RISES
 * as the tread SLOWS. That sentence shipped with its direction INVERTED and was
 * corrected in place by plan 61-08 (D-61-2); it read *"the quality ladder above 12 earns
 * its keep only at HIGHER rates"*. A faster tread takes bigger steps and visits FEWER
 * buckets, so raising K buys a fast belt nothing.
 *
 * 12 WAS SIMULTANEOUSLY THE FLOOR AND THE OPTIMUM AT THE RETIRED ART-DIRECTED RATE,
 * which is why the default is not a power of two (`61-UI-SPEC` A6, `61-CONTEXT.md`
 * section B). At an advance of 1.333333 px/tick the ladder read:
 *
 *   K = 12  bucket size 16/12 = 1.333333px = the per-tick advance EXACTLY.
 *           One bucket per sim tick, every bucket visited, a perfectly even march.
 *   K = 16  bucket size 1.000px against a 1.333333px advance: the snapped march
 *           advances 1px on 8 ticks of 12 and 2px on the other 4 - a JUDDER, at MORE
 *           cache than 12.
 *   K = 24  bucket size 0.666667px: even again (exactly two buckets per tick), but only
 *           HALF its buckets are ever selected by the march, so it doubles the cache
 *           for a look that is identical to K = 12.
 *
 * **THAT ADVANCE IS NO LONGER A MODULE CONSTANT (Phase 62, D-05), so the ladder is now
 * read per belt.** The tread carries at the speed of its cargo, so the position count a
 * belt actually gets is `ticksPerDashPeriod` of ITS advance: a belt at the pre-change
 * identity interval advances 8 px per tick and therefore has just TWO distinct positions
 * in a period, and every legal K collapses to the same two. That is the aliasing ceiling
 * biting, not a bug in K, and it is exactly why `62-CONTEXT.md` D-06 puts a hard floor
 * under the shipped interval. As the interval rises the tread slows, the position count
 * climbs, and the ladder above 12 finally earns the keep the split-knob model was built
 * to give it. **The forward-compatibility Phase 61 designed for is what this phase
 * spends** - and the settings panel copy, which promises headroom for a slower belt and
 * no change to how fast belts run, becomes true of a real knob rather than a hypothetical
 * one. K remains a pure rendering-budget quantization and still sets no speed.
 */
export const BELT_MARCH_BUCKETS = 12;

/**
 * The bucket counts the settings panel offers (`61-UI-SPEC` B2). The default first.
 *
 * Every cache and distinctness invariant in the suite is swept over THIS list rather
 * than asserted at the default alone, so a knob move cannot quietly leave a legal value
 * ungated.
 */
export const BELT_MARCH_BUCKET_COUNTS: readonly number[] = Object.freeze([12, 16, 24]);

/**
 * Sim ticks per march step, T. **1** - the belt redraws its march every sim tick.
 *
 * Was 6 (the MOTION-01 10fps animation lattice). Moving it to 1 is the decoupling, and
 * `T` survives as a real field rather than a vestigial 1: at any `T > 1` the clock is
 * quantized to `T` ticks before the bucket is chosen, which is precisely what the
 * shipped strobe was.
 */
export const BELT_MARCH_QUANTUM_TICKS = 1;

/** Euclidean modulo: `[0, n)` for every finite input, including negatives. */
function eucMod(v: number, n: number): number {
  return ((v % n) + n) % n;
}

/**
 * The size of one march bucket in px: one dash period divided into `buckets` parts.
 *
 * THIS is the quantity that moves with K, and the per-tick advance is the quantity that
 * does not. Under the shipped welded model they were the same number, which is the
 * defect.
 */
export function bucketSizePx(buckets: number): number {
  return BELT_DASH_PERIOD / buckets;
}

/**
 * The worst-case error between the true continuous phase and the drawn bucket: half a
 * bucket, i.e. half the dash period divided by K. 0.666667px at the default.
 */
export function worstCaseQuantizationPx(buckets: number): number {
  return bucketSizePx(buckets) / 2;
}

/**
 * THE RESYNC LURCH, in px: how far the tread jumps in one frame when the render clock
 * snaps forward by `gapTicks` to track a live sim.
 *
 * **At the shipped rate and a 6-tick gap this is EXACTLY 8.00px, which is EXACTLY HALF
 * THE 16px DASH PERIOD - the maximally direction-ambiguous displacement a periodic
 * pattern can take.** `belts.ts` publishes the number beside the speed, as its own
 * comment demands of any painter proposing a sub-6 quantum. It is ACCEPTED, not fixed;
 * `belts.ts` records the two rejected fixes and why each was refused.
 *
 * PER BELT SINCE PHASE 62 (SLOT-03). The advance is no longer a module constant, so the
 * lurch is a function of the belt's own px-per-tick and is quoted per belt. It SHRINKS
 * at a slower tread, which is a strictly better story than the one above: the figure
 * documented here is the worst case, at today's rate.
 */
export function resyncLurchPx(gapTicks: number, pxPerTick: number): number {
  return gapTicks * pxPerTick;
}

/**
 * The ALONG-FLOW length of one belt tile, in world px. There are exactly two values.
 *
 * A corner is NOT a whole tile along flow: it is the quarter arc on the CENTRELINE
 * radius, 25.132741 at R = 16 (BELT-02). A straight is the cell, 32. That difference is
 * the entire reason the phase accumulator below exists - accumulating 32 through a bend
 * is how the shipped belt earned its 2px seam at every corner.
 */
export function tileFlowLength(isCorner: boolean): number {
  return isCorner ? CORNER_ARC_LENGTH : CELL;
}

/**
 * THE MARCH BUCKET for one tile: a pure function of the sim render clock in TICK units,
 * that tile's tail-relative offset along flow, and the bucket count. **No other input
 * exists, and no wall clock is reachable from here.**
 *
 * STATE THE INVARIANT IN TICKS, NEVER IN FRAMES. At the defaults this advances exactly
 * ONE BUCKET PER SIM TICK. The frame form of that sentence is a 60 Hz statement: on a
 * 120 Hz display each bucket dwells two frames and on 144 Hz three or four on an uneven
 * cadence, because `loop.ts` advances the clock by `deltaMs / SIM_TICK_MS` per DISPLAY
 * frame. None of that changes the march, and that robustness is the reason for the
 * phrasing.
 *
 * THE OFFSET IS SUBTRACTED because the dash marches WITH the flow: a tile further from
 * the tail has already been passed by that much pattern, so it draws a phase that much
 * further back. `offsetPx` accumulates per BELT from its tail (see `belts.ts`
 * `rebuildTiles`), restarting at 0 at each tail - so a run reads continuous end to end
 * through every corner, and a seam may appear only where two belts meet at a dock,
 * which is already a visual break (a machine).
 *
 * EUCLIDEAN, so a pinned, rewound or negative clock and a negative offset all produce a
 * drawn bucket in `[0, K)` rather than a gap. `Math.round` can return `buckets` when the
 * wrapped phase sits in the top half-bucket; the outer wrap folds that back to 0, which
 * is correct - the lattice is circular.
 *
 * THE ADVANCE IS A PARAMETER, NOT A MODULE CONSTANT (Phase 62, SLOT-03). Each belt walks
 * the shared buckets at ITS OWN rate, which is the variable-speed architecture Phase 61
 * deliberately built and never got to use: the asset cache is keyed by BUCKET only, so a
 * per-belt rate changes WHICH bucket is selected on a given tick and never introduces a
 * new one. The cache stays `K * 2` no matter how many distinct speeds are on the board.
 *
 * @param clockTicks The sim render clock in tick units (`effectiveClock` in `loop.ts`).
 * @param offsetPx   The tile's tail-relative distance along flow, in world px.
 * @param buckets    K.
 * @param pxPerTick  THIS BELT's march advance per sim tick, in world px. Must be finite;
 *                   the caller derives it and floors the divisor (see `belts.ts`).
 */
export function bucketOf(
  clockTicks: number,
  offsetPx: number,
  buckets: number,
  pxPerTick: number,
): number {
  const phasePx = clockTicks * pxPerTick - offsetPx;
  const wrapped = eucMod(phasePx, BELT_DASH_PERIOD);
  return eucMod(Math.round(wrapped / bucketSizePx(buckets)), buckets);
}

/**
 * THE FULL-DETAIL STRAIGHT TILE: two rails plus the marching centreline dash.
 *
 * The tile is the two rail rectangles plus N dash rectangles. There is NO interior
 * rectangle, and its absence is a decision rather than an omission: the belt's
 * interior is hollow `ramp[0]` (53-BELT-LOCK axis 2) and the board it sits on is the
 * SAME `ramp[0]` (61-UI-SPEC A7.1), so an interior fill would be an invisible
 * rectangle that spends tessellated vertices out of the VEC-04 budget to draw
 * nothing. The narrowing therefore reads purely as the rails moving inward.
 *
 * DASHES ARE CLIPPED TO THE TILE, NEVER DROPPED. The walk starts at the NEGATED
 * wrapped entry phase and steps by the full period, so a run that begins before the
 * tile's entry edge or ends past its exit edge is emitted as its own visible part
 * and the neighbouring tile emits the rest. Dropping a straddling run instead would
 * put a phase-dependent hole at every tile boundary - the defect that reads as a
 * seam, which is precisely what this phase exists to remove.
 *
 * THE NEGATION IS THIS TILE'S ALONE AND DOES NOT TRANSFER. `a = x + HALF` runs from 0
 * at the WEST edge, and native flow is WEST, so `a = 0` is the EXIT and ink advancing
 * along flow must walk `a` DOWNWARD - hence `-phase`. {@link cornerCommands} parametrizes
 * by arc length from its ENTRY tangent, so the identical expression there runs its ink
 * the wrong way; it carries `phase - dash` and a note saying why. Copying this line
 * across is exactly the mistake plan 61-03 made.
 *
 * @param bucket The march bucket (any integer; wrapped Euclidean).
 * @param phases K - how many buckets one dash period is drawn in.
 */
export function straightCommands(bucket: number, phases: number): BeltPathCommand[] {
  // TREAD ONLY as of plan 61-09: the rails left this emitter for their own
  // device-quantum-aware family (see {@link railCommands}). This context therefore
  // stays SCALE-FREE - one fixed tessellation for the entire zoom range, which is what
  // keeps its cache key three-segmented and its ceiling at `3K + 3`.
  const out: BeltPathCommand[] = [];
  const phase = dashPhase(bucket, phases);
  for (let start = -phase; start < CELL; start += BELT_DASH_PERIOD) {
    const from = Math.max(start, 0);
    const to = Math.min(start + BELT_GEOM.dash, CELL);
    if (to <= from) continue;
    out.push(rect(from - HALF, -BAND, to - from, BELT_GEOM.band, 'tread'));
  }
  return out;
}

/**
 * THE LOW-ZOOM STRAIGHT TICK (FLOW-03 / 61-UI-SPEC A10): the same two rails plus ONE
 * bold static mark on the tile centre, phase-INDEPENDENT.
 *
 * Kept as its own emitter rather than expressed as "the full tread at reduced
 * detail", because the LOD mark's whole purpose is that it is a DIFFERENT, bolder
 * mark that survives at 12-18 device px where a marching 10/6 rhythm smears. Its
 * phase-independence is also what keeps the cache at `3K + 3` entries rather than
 * `5K`.
 */
export function straightTickCommands(): BeltPathCommand[] {
  // TREAD ONLY as of plan 61-09, exactly like {@link straightCommands}. The tick and
  // the full tread now SHARE the one straight rail asset - the rails are a separate
  // child object that the LOD cut does not switch, so a zoom past the cut changes the
  // mark and leaves the lane alone.
  return [rect(-TICK_HALF, -BAND, TICK_HALF * 2, BELT_GEOM.band, 'tread')];
}

// ---------------------------------------------------------------------------
// THE CORNER TILE (BELT-01, BELT-02, BELT-03, BELT-04, BELT-05 - plan 61-03)
// ---------------------------------------------------------------------------

/**
 * How many samples ONE QUARTER ARC is drawn with. Fixed at 24, for every sampled
 * arc on the corner, at every zoom.
 *
 * THE MEASUREMENT THAT CHOSE IT (`61-RESEARCH.md` FINDING 1 and Pattern 6, both
 * measured against pixi.js 8.19.0 on 2026-08-10, not estimated):
 *
 *   - CHORD ERROR. The worst case is the outer rail at radius 26. At N = 24 its chord
 *     sagitta is 0.0139 world px, which is **0.11 DEVICE px at the maximum device
 *     scale the camera clamps allow** (zoom 4 x DPR 2 = 8). At N = 8 - roughly what
 *     Pixi's own `arc()` step formula would pick - it is 1.00 device px, which is
 *     visible faceting and is the defect this milestone was founded on.
 *   - BATCHING. 24 is the LARGEST sample count that stays inside the VEC-04 budget
 *     across EVERY phase bucket. **RE-MEASURED BY PLAN 61-09 AFTER THE RAIL SPLIT**,
 *     through the project's own `measureContext` path: the corner TREAD now measures
 *     64-84 tessellated vertices (it was 264-284 while it still carried the rail arcs,
 *     which were the bulk of it) and the corner RAIL family measures 200, both against
 *     the same 300 warn / 400 fail band. The old figure is quoted rather than deleted
 *     so the move is legible; before the split, 28 samples entered the warn band at
 *     304-332.
 *
 *     **THE HEADROOM IS RECORDED AND NOT SPENT.** 24 was chosen on chord error as much
 *     as on the budget, and a higher count would buy 0.11 device px of accuracy that is
 *     already invisible. Raising it now would move a look this phase has committed.
 *
 * ONE FIXED TESSELLATION SERVES THE WHOLE ZOOM RANGE, AND THAT IS WHY THE CACHE
 * CARRIES NO ZOOM-BUCKET TERM. The emitters below hand out SELF-SAMPLED POINT LISTS
 * and never a Pixi curve command - no `bezierCurveTo`, no `quadraticCurveTo`, no
 * `arcTo`, not even `arc()` - so the geometry module owns every point and Pixi's
 * `buildAdaptiveBezier` (which hardcodes `const scale = 1` and therefore serves stale
 * tessellation on zoom) is never reached at all. `61-UI-SPEC` A8 provisionally keyed a
 * `zoomBucket` term into the cache against that hazard and set the ceiling at 156;
 * retiring the hazard by construction TIGHTENS that ceiling to 39, which is the only
 * direction `beltPainter.metrics.test.ts` permits the boundedness invariant to move.
 */
export const ARC_SAMPLES = 24;

/**
 * The sample count for the LOW-ZOOM bend cue, which is a different asset drawn at a
 * different size and is therefore entitled to a different number.
 *
 * MEASURED, in the same terms as {@link ARC_SAMPLES} and for the same reasons.
 *
 *   - IT IS ONLY EVER DRAWN SMALL. The cue is selected below `LOD_MIN_TREAD_PX` = 24
 *     device px per tile (`belts.ts`), so its maximum device scale is 24/32 = 0.75 -
 *     the exact opposite end of the range the full-detail corner has to survive. At
 *     N = 12 the worst-case chord sagitta (outer band edge, r = 17) is 0.036 world px,
 *     which is **0.027 DEVICE px at that cut**. Sampling it at 24 would spend vertices
 *     on a curve error two orders of magnitude below one pixel.
 *   - IT IS THE LARGEST SINGLE SECTOR THE MODULE EMITS. The cue sweeps the WHOLE
 *     quarter arc as one closed annular band, where a marching dash sweeps at most a
 *     10px run - so it is the one asset whose sampling actually costs. At 24 it
 *     measured 300 tessellated vertices, which is exactly the VEC-04 WARN threshold;
 *     at 12 it is comfortably inside the ok band. The count was lowered rather than
 *     the assertion loosened, and this comment exists so that choice is legible.
 *
 * **RE-MEASURED BY PLAN 61-09 AFTER THE RAIL SPLIT**: the cue's TREAD is now 52
 * vertices and its RAIL family 104, so the whole low-zoom corner is 156 against the
 * 300 warn. **THAT HEADROOM IS DELIBERATELY NOT SPENT.** 12 was chosen on CHORD ERROR
 * at the LOD cut as well as on the budget - 0.027 device px at the 0.75 device scale
 * the cue is capped at - so there is nothing to buy by raising it, and raising it would
 * move a look this phase has already committed.
 *
 * The RAIL arcs of the cue take this count too: below the cut they are the same
 * hairlines at the same 0.75 scale, and holding them at 24 while the cue moved would
 * have been sampling the two halves of one small asset by two different standards.
 */
export const LOD_ARC_SAMPLES = 12;

/**
 * The corner's arc CENTRE in tile-local, centre-origin coordinates.
 *
 * Written as `-elbowR` and NEVER as `-HALF`, even though the two are the same number
 * at the shipped radius, because their coincidence IS the property this phase verifies.
 * The shipped raster bake computes its centre as `(CELL/2 - R, CELL/2 - R)` in
 * corner-origin coordinates; subtracting the half cell to reach centre-origin gives
 * exactly `(-R, -R)`. So the arc lands on the TILE CORNER only when `R === CELL/2`, and
 * its tangent points land on the TILE-EDGE MIDPOINTS only then too. Hardcoding `-HALF`
 * here would make that hold by fiat at every radius and delete the discriminator.
 */
const ARC_CX = -BELT_GEOM.elbowR;
const ARC_CY = -BELT_GEOM.elbowR;

/**
 * The along-flow length of ONE corner tile: the quarter arc on the CENTRELINE radius.
 *
 * `R * pi / 2` = 25.132741 at R = 16 (BELT-02). A corner is NOT a whole tile along
 * flow, and the raster bake's `u = dx - dy` parameter - which runs from `+R` to `-R`,
 * a span of `2R` = 32 - is exactly the wrong length as well as the wrong shape.
 */
export const CORNER_ARC_LENGTH = (BELT_GEOM.elbowR * Math.PI) / 2;

/**
 * Sample one circular arc as `n + 1` flat `[x0, y0, x1, y1, ...]` points, from `t0`
 * to `t1` at radius `r` about an ARBITRARY centre.
 *
 * EXPORTED FOR ONE REASON (plan 61-05 / BELT-07): the item path through a bend is
 * built by this exact function, at this exact sample count, on this exact radius, so
 * the drawn belt and the dot that rides it are the SAME CURVE BY CONSTRUCTION rather
 * than by two implementations agreeing. `interp.ts` cannot use {@link arcPoints}
 * below because it works in WORLD coordinates over eight `(from, to)` orientations,
 * while the tile emitters work in the one canonical tile-local frame - so the CENTRE
 * is the parameter that had to be lifted, and nothing else.
 *
 * Nothing else about the belt's sampling moved: `arcPoints` still binds the tile-local
 * centre and every emitted byte of every belt asset is unchanged (the 39-entry
 * `__digests__/belt.geometry.json` table is the proof, and it is not re-blessed by
 * this plan).
 */
export function sampleArcPoints(
  cx: number,
  cy: number,
  r: number,
  t0: number,
  t1: number,
  n: number,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    pts.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return pts;
}

/** Sample one arc as `n + 1` points from `t0` to `t1` at radius `r`, about the TILE's arc centre. */
function arcPoints(r: number, t0: number, t1: number, n: number): number[] {
  return sampleArcPoints(ARC_CX, ARC_CY, r, t0, t1, n);
}

/** Mirror one emitted path in x - the whole of what the `'ccw'` chirality is. */
function mirrorX(cmd: BeltPathCommand): BeltPathCommand {
  return { ...cmd, points: cmd.points.map((v, i) => (i % 2 === 0 ? -v : v)) };
}

/**
 * The corner's two flow-parallel RAIL ARCS at the live device quantum, shared by the
 * full-detail tile and the LOD bend cue.
 *
 * SAMPLED AT `laneEdge -/+ width/2`, NOT AT THE LANE EDGE ITSELF, and that half-band
 * inset is what makes the corner lane equal the straight's. A stroke with
 * `alignment: 0.5` inks `width/2` on EACH side of the sampled path, so a rail sampled
 * at radius `R - laneHalf` = 6 would ink 5.5..6.5 and its sibling at `R + laneHalf`
 * = 26 would ink 25.5..26.5 - a rail-outer-edge-to-rail-outer-edge lane of 21.00,
 * against the straight's 20.00. That is a 1px BULGE at every corner, which is the same
 * defect class as the 4px pinch BELT-05 exists to remove, only smaller and in the
 * other direction. Sampling at 6.5 and 25.5 inks 6..7 and 25..26 instead: the lane
 * measures exactly 20.00, and all four rail edges land on the INTEGER radii
 * `61-UI-SPEC` A2 lists for the corner (6, 7, 25, 26) at the identity quantum.
 *
 * This is the polar restatement of the straight's own rule - subtract INWARD from the
 * lane edge rather than adding outward from a centreline (see {@link railCommands}) -
 * and the two read the SAME derived `d`, so the corner cannot acquire its own lane at
 * any quantum rather than merely agreeing at 1.
 *
 * ---------------------------------------------------------------------------
 * THE CORNER TAKES THE THICKNESS HALF OF THE DEVICE RULE AND NOT THE POSITION HALF
 * ---------------------------------------------------------------------------
 *
 * Stated here rather than left to be read as an omission. The straight's band is
 * additionally SNAPPED so both of its device edges land on whole device rows; the
 * corner's cannot be, because **a circle has no rows to snap to** - every point of an
 * arc sits at a different fraction of a device pixel and no single offset fixes them
 * all. Thickness alone is sufficient there: a band at least one device pixel wide
 * across its normal covers a pixel centre wherever it crosses, which is exactly the
 * property the `max(1, ...)` floor buys. What the corner would gain from a position
 * snap is sub-pixel PHASE stability under a pan, and an arc has no stable phase to
 * preserve.
 */
export function cornerRailCommands(
  samples: number,
  quantum: number,
  chirality: 'cw' | 'ccw',
): BeltPathCommand[] {
  const { quantum: q, d, t, over } = railBandAt(quantum);
  // The rule's THICKNESS half, expressed back in world units. The band is at least one
  // whole device pixel across its NORMAL, which is what a rasteriser samples on a curve.
  const width = t / q;
  // The rule's LANE half, from the SAME derived `d` the straight uses - which is what
  // makes the corner lane equal the straight's at every quantum rather than only at 1.
  const half = d / q - width / 2;
  const radii = [BELT_GEOM.elbowR - half, BELT_GEOM.elbowR + half];
  // The sweep is extended at BOTH ends by the overhang divided by the CENTRELINE radius
  // - an arc length turned into an angle exactly once, the same discipline `dashSector`
  // applies to BELT-01 - so a corner overhangs its tile by the same world distance the
  // straight does and the two abut at every quantum.
  const dt = over / BELT_GEOM.elbowR;
  const out = radii.map((r) => ({
    op: 'poly' as const,
    points: arcPoints(r, -dt, QUARTER + dt, samples),
    close: false,
    role: 'rail' as const,
    style: {
      mode: 'stroke' as const,
      width,
      alignment: 0.5,
    },
  }));
  return chirality === 'ccw' ? out.map(mirrorX) : out;
}

/**
 * ONE dash run through the bend, as an ANNULAR SECTOR between arc lengths `a0` and
 * `a1` measured on the CENTRELINE radius.
 *
 * THE TWO LINES BELOW ARE BELT-01, AND THEY ARE THE WHOLE OF IT. Both bounding angles
 * are obtained by dividing an arc length by the CENTRELINE radius `R`, ONCE, BEFORE
 * either band radius is chosen. They are then swept at BOTH band radii. So no point's
 * own radius `r` ever enters the along-flow parameter, and the construction cannot
 * express the defect even by accident.
 *
 * WHY PER-POINT `r` IS FORBIDDEN, as the bound this replaces. Parameterising each
 * point by its own radius gives level sets that are hyperbolic spirals: the tread
 * shears by `w * pi/2` across a band of width `w`. At the drawn 2px band that is
 * 3.14px on a 10px dash - already a visible skew - and at the full 20px lane it is
 * 31.4px, nearly two whole dash periods. The shipped raster corner's `u = dx - dy` is
 * a different wrong answer to the same question and measures 1.411x at the bend
 * midpoint (`53-BELT-LOCK` supersession, the defect table).
 *
 * BELT-03 FALLS OUT BY CONSTRUCTION RATHER THAN BY MEASUREMENT. The sector's two end
 * caps are the segments from `(ri, t0)` to `(ro, t0)` and from `(ri, t1)` to
 * `(ro, t1)`. Both are exactly RADIAL, so the cap is perpendicular to the local flow
 * at every theta in the run - including both tangent points, where the flow is
 * axis-aligned and the cap therefore meets the neighbouring straight's dash square-on
 * at 0.00 degrees.
 */
function dashSector(a0: number, a1: number, samples: number): BeltPathCommand {
  const R = BELT_GEOM.elbowR;
  const t0 = a0 / R;
  const t1 = a1 / R;
  // The band is CENTRED on the centreline radius and is exactly `band` px across -
  // 2.00, equal to the straight's. The raster bake's 3px corner band was a property of
  // integer pixel ROWS (`tArm` is an absolute value, so a band centred on an integer
  // row can only be odd); vector geometry has no pixel rows and the artefact does not
  // survive VEC-01 (61-UI-SPEC A4).
  const ri = R - BAND;
  const ro = R + BAND;
  // Sample density follows the run's own share of the quarter arc, so a clipped stub
  // is not tessellated at the whole arc's density and a full dash is not under-sampled.
  const n = Math.max(2, Math.ceil(((t1 - t0) / QUARTER) * samples));
  const outer = arcPoints(ro, t0, t1, n);
  const innerForward = arcPoints(ri, t0, t1, n);
  const points = [...outer];
  for (let i = n; i >= 0; i--) points.push(innerForward[i * 2], innerForward[i * 2 + 1]);
  return { op: 'poly', points, close: true, role: 'tread', style: FILL };
}

/**
 * THE FULL-DETAIL CORNER TILE: two rail arcs plus the marching arc dash.
 *
 * The canonical `'cw'` chirality rounds the NORTH-in / WEST-out bend (native at
 * `from = S`, `to = W`), which is the SAME canonical orientation the raster bake used,
 * so `cornerChiralityOf` and `cornerQuarterTurns` in `belts.ts` are untouched by the
 * move to vector. Flow enters at the tile's north edge midpoint (`theta = 0`) and
 * leaves at its west edge midpoint (`theta = 90`), so the arc length `s = R * theta`
 * runs 0 AT ENTRY to {@link CORNER_ARC_LENGTH} AT EXIT.
 *
 * THIS IS THE OPPOSITE FRAME FROM THE STRAIGHT'S, AND THE TWO MUST NOT BE CONFLATED.
 * The straight's parameter is `a = x + HALF`, and its native flow is WEST (`belts.ts`
 * maps dir=W to zero quarter turns), so `a = 0` is that tile's EXIT edge: `a` runs
 * AGAINST flow while `s` runs WITH it. This comment claimed the two shared a convention
 * until Phase 62, and plan 61-03 duly copied the straight's `-phase` walk into the
 * corner, which marched every corner's tread BACKWARDS on the shipped build. The claim
 * was wrong, not merely imprecise: there is no coordinate in which both emitters put
 * along-flow zero at the entry edge.
 *
 * DASHES ARE CLIPPED TO THE TILE, NEVER DROPPED, exactly as on the straight: the walk
 * starts one whole dash before the wrapped entry phase and steps by the full period, so
 * a run that begins before the tangent point or ends past the far one is emitted as its
 * own visible part and the neighbouring tile emits the rest.
 *
 * THE OPPOSITE CHIRALITY IS THE X-MIRROR, exactly as today. A 90-degree whole-sprite
 * rotation reaches only 4 of the 8 `(from, to)` corners; the mirror covers the other 4.
 * Mirroring the EMITTED POINTS rather than re-deriving the geometry is what keeps the
 * two chiralities incapable of disagreeing on arc length, band width or cap angle.
 *
 * @param bucket The march bucket (any integer; wrapped Euclidean).
 * @param phases K - how many buckets one dash period is drawn in.
 * @param chirality Which handedness of bend; `'ccw'` is the x-mirror of `'cw'`.
 */
export function cornerCommands(
  bucket: number,
  phases: number,
  chirality: 'cw' | 'ccw',
): BeltPathCommand[] {
  // TREAD ONLY as of plan 61-09: the rail arcs left for the device-quantum-aware
  // family (see {@link cornerRailCommands}), so this context stays SCALE-FREE and one
  // fixed tessellation still serves the entire zoom range (`61-RESEARCH.md` FINDING 1).
  const out: BeltPathCommand[] = [];
  const phase = dashPhase(bucket, phases);
  // THE WALK RUNS THE OPPOSITE WAY FROM THE STRAIGHT'S, AND MUST. See the frame note in
  // this function's doc comment: `s` INCREASES along flow (s = 0 is the entry tangent)
  // where the straight's `a` DECREASES along flow (a = 0 is the exit edge). Writing the
  // straight's `-phase` here - which is what plan 61-03 did - marches the corner ink
  // backwards toward its own entry while every neighbouring straight advances.
  //
  // `- BELT_GEOM.dash` IS LOAD-BEARING AND IS NOT LOOP HYGIENE. It is what puts the
  // corner's dash BODY at the same along-flow residue as the straight's. Measure both
  // from the tile entry: the straight's dash occupies `[phase - dash, phase]` (mod the
  // period) once its `a` is turned around, so the corner must occupy that same window.
  // A bare `+phase` would occupy `[phase, phase + dash]` - the right DIRECTION at a
  // permanent 10px offset, which reads as a doubled-ink seam at every bend instead of a
  // reversed one. The two terms fix two different halves of the same defect.
  for (let start = phase - BELT_GEOM.dash; start < CORNER_ARC_LENGTH; start += BELT_DASH_PERIOD) {
    const from = Math.max(start, 0);
    const to = Math.min(start + BELT_GEOM.dash, CORNER_ARC_LENGTH);
    if (to <= from) continue;
    out.push(dashSector(from, to, ARC_SAMPLES));
  }
  return chirality === 'ccw' ? out.map(mirrorX) : out;
}

/**
 * THE LOW-ZOOM CORNER BEND CUE (RENDER-02 / 61-UI-SPEC A10): the same two rail arcs
 * plus ONE static mark that reads as a BEND, phase-INDEPENDENT.
 *
 * The mark is the WHOLE quarter arc, not a centred stub, and that is a transcription
 * of the shipped raster cue rather than a new choice: `bendCentreCue` inks the full
 * sweep of the `elbowR +/- 1` band, so the LOD corner has always been a continuous
 * hairline arc. Below the cut this single mark IS the corner, and a stub would read as
 * a straight run with a gap rather than as a turn - which is the exact failure
 * RENDER-02 introduced a separate corner tick to avoid (the straight tick would have
 * lied about the bend).
 *
 * Kept as its own emitter rather than as "the corner tread at reduced detail", for the
 * reason `straightTickCommands` records: the LOD mark exists BECAUSE it is a different
 * mark. Its phase-independence is also what keeps the cache at `3K + 3` entries.
 */
export function cornerTickCommands(chirality: 'cw' | 'ccw'): BeltPathCommand[] {
  // TREAD ONLY as of plan 61-09, exactly like {@link cornerCommands}.
  const out = [dashSector(0, CORNER_ARC_LENGTH, LOD_ARC_SAMPLES)];
  return chirality === 'ccw' ? out.map(mirrorX) : out;
}
