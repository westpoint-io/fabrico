// The BeltPainter record - the primary representation of "how a belt is painted".
//
// PROMOTION (Phase 53 assumption delta). Before this file there was ONE way a belt
// was painted: the generator set's `.belt` closure bound once at layer construction,
// plus three sibling bakes hardwired as direct module imports in `belts.ts`. Phase 53 explores
// five looks simultaneously (shipped + directions A/B/C/D), so "how a belt is
// painted" is now a first-class noun: one frozen `BeltPainter` record carrying all
// four bakes plus the three integers that define the march.
//
// `SHIPPED_PAINTER` is ONE MEMBER of that set, not a privileged special case that
// variants are bolted beside. It is injected as the DEFAULT value of
// `createBeltLayer`'s 5th parameter, so the shipped path and every variant path are
// the same code path with a different record. One representation, one drift surface,
// one digest table pinning it (`beltPainter.digest.test.ts`).
//
// The alternative (`add-alongside`: keep the four direct module imports as the real
// path and give variants a parallel one) was refused: two paths drift, which is the
// same class of defect that made the Phase 24 style board expensive (board-private
// painters that duplicated the shipped ones and then diverged).
//
// THE MARCH MODEL - TWO INDEPENDENT KNOBS AS OF PLAN 61-04 (BELT-06).
//
// `phases` (K) is the number of distinct baked phase buckets. `quantum` (T) is how
// many SIM TICKS the march holds one bucket for. `pitch` is the pattern period in px
// along flow. The speed is NEITHER of them: it is the BELT's own advance in px per sim
// tick (`beltGeometry.ts marchPxPerTick`, derived from that belt's slot pitch and
// interval since Phase 62's D-05 - it was an art-directed module constant until plan
// 62-04 deleted it by derivation), and the bucket is that continuous phase snapped to
// the K lattice:
//
//     phase_px(clock, offset) = clock * pxPerTick - offset        (Euclidean, mod pitch)
//     bucket                  = round(phase_px / (pitch / K)) mod K
//
// WHAT THIS REPLACED, AND WHY THE OLD PROOF IS GONE RATHER THAN EDITED. Until this
// plan the step was DERIVED from the bucket count - `step = pitch / K` = 32 / 4 = 8px
// per animation frame at T = 6 - so raising K for smoothness necessarily SLOWED the
// belt. That welding is the whole reason BELT-06 could not be fixed in place. The
// header used to carry a byte-identity proof that the painter's march form equalled
// `marchPhaseOf(quantizedFrame(clock))`, resting on 4 dividing 24. **That proof is
// FALSE from this plan on and is deleted rather than adjusted**: the belt no longer
// derives its phase from the MOTION-01 frame index at all, so there is no composition
// left for it to equal. `beltPainter.test.ts` states the replacement property - the
// SPEED is unchanged across the change - which is the claim that actually matters.
//
// THE DECOUPLING IS DELIBERATE AND APPROVED (`61-CONTEXT.md` section B, the maintainers'
// call on 2026-08-10): **belts march at the sim tick rate while machine sprite
// animation stays deliberately chunky at 10fps.** The two clocks are ALLOWED to differ
// now; the previous rule that they must not drift apart described a belt this project
// no longer draws. Determinism is untouched by the split - the phase is a pure function
// of the sim render clock in tick units at T = 1 exactly as it was at T = 6, and no
// wall clock is reachable from any of it.
//
// D-08: variants are exploration-local paint functions. NOTHING about a variant ever
// reaches `skin.ts` - its schema and validator stay byte-untouched this phase.

import { GraphicsContext } from 'pixi.js';
import { BELT_DASH_PERIOD } from '../../../shared/geometry.ts';
import { assertVertexBudget, measureContext } from '../svgAssets.ts';
import {
  ARC_SAMPLES,
  BELT_MARCH_BUCKETS,
  BELT_MARCH_BUCKET_COUNTS,
  BELT_MARCH_QUANTUM_TICKS,
  LOD_ARC_SAMPLES,
  cornerCommands,
  cornerRailCommands,
  cornerTickCommands,
  railCommands,
  straightCommands,
  straightTickCommands,
  type BeltPathCommand,
} from './beltGeometry.ts';
import { rampStep } from './palette.ts';
import type { Skin } from './skin.ts';

/**
 * THE LOCKED BELT INK - the ramp INDICES every belt asset resolves its colours through.
 *
 * MOVED HERE BY PLAN 61-07, AND THE DISCIPLINE MOVED WITH IT RATHER THAN BEING LEFT
 * BEHIND. These three numbers lived on a frozen ink record in `generators.ts` that
 * belonged to the four raster bakes and was deleted with them. Every member is an INDEX
 * into `skin.palette.ramp`, resolved through `rampStep` (which clamps out of range): it
 * is never a hex, never a computed tint and never a brightness multiply, which is what
 * makes "no brightness multiply" enforceable at the data layer rather than by convention
 * (see the `palette.ts` header). A skin whose ramp is not 5 steps gets `rampStep`'s
 * clamp semantics on the locked indices - the locked coordinates, never a per-skin
 * re-derivation.
 *
 * The values are transcribed verbatim from 53-BELT-LOCK.md (axis 2: rail ramp 4
 * INVERTED over interior ramp 0; axis 6: ink ramp 4 = accent ramp 4, single-ink). The
 * interior index has no consumer on the vector path - a vector tread strokes and fills
 * only what it draws and never floods a hollow interior - so it is recorded here as the
 * third coordinate of the locked look rather than exported as a live colour.
 */
export const BELT_INK = Object.freeze({
  /** Ramp index of both side rails / both corner rail arcs. Locked: 4 (inverted). */
  railRamp: 4,
  /** Ramp index of the flat lane interior. Locked: 0 (hollow darkest step). */
  interiorRamp: 0,
  /** Ramp index of the tread ink. Locked: 4 (maximum line contrast, 8.44:1). */
  inkRamp: 4,
});

/**
 * Turn a list of {@link BeltPathCommand}s into ONE tessellated `GraphicsContext`.
 *
 * THE COLOUR RESOLUTION LIVES HERE AND NOT IN THE GEOMETRY MODULE, because a colour
 * is a skin lookup and `beltGeometry.ts` has no skin - that is the whole point of its
 * Pixi-free, product-free purity. The two roles resolve through the {@link BELT_INK}
 * ramp indices, which are the same three the deleted raster bakes resolved through, so
 * the vector belt did not silently re-pick its own colours when the record moved.
 *
 * THE DEV VERTEX-BUDGET NET (VEC-04, T-61-07) is wired exactly as
 * `svgAssets.ts getAssetContext` wires it, and for the same reason: a procedural
 * builder can fail SILENTLY by producing a context with zero geometry, which sails
 * under every threshold by drawing nothing. `assertVertexBudget` THROWS on zero
 * rather than reporting the cleanest green in the suite. DEV-gated so a shipped Tauri
 * build carries no measurement cost.
 */
function buildBeltContext(
  label: string,
  commands: readonly BeltPathCommand[],
  skin: Skin,
): GraphicsContext {
  const steps = skin.palette.ramp;
  const railColor = rampStep(steps, BELT_INK.railRamp);
  const treadColor = rampStep(steps, BELT_INK.inkRamp);
  const ctx = new GraphicsContext();
  for (const cmd of commands) {
    const color = cmd.role === 'rail' ? railColor : treadColor;
    ctx.poly(cmd.points as number[], cmd.close);
    if (cmd.style.mode === 'fill') {
      ctx.fill({ color });
    } else {
      ctx.stroke({ width: cmd.style.width, color, alignment: cmd.style.alignment });
    }
  }
  if (import.meta.env.DEV) {
    assertVertexBudget(label, measureContext(ctx));
  }
  return ctx;
}

/**
 * One belt look, complete. Every field an exploration variant may vary lives here;
 * nothing about a variant leaks into `skin.ts`.
 *
 * The four bake methods mirror the four asset families the belt layer caches:
 * the marching straight tread, the marching corner elbow (per chirality), and the
 * two phase-independent low-zoom LOD ticks (straight + corner bend cue).
 *
 * VEC-01 MIGRATION STATE: COMPLETE FOR THE BELT (plan 61-02 straights, plan 61-03
 * corners). All FOUR families now return resolution-independent `GraphicsContext`
 * values built from `beltGeometry.ts` path commands, so no belt asset is a
 * `PixelMatrix` any more and nothing on the belt path is resampled at a fractional
 * zoom. The corner conversion landed in the SAME commit that moved `elbowR` to 16, so
 * the corner digests and the corner pixel baseline broke exactly ONCE rather than
 * twice. `generators.ts`'s raster belt bakes still EXIST and are still pinned by their
 * own specs, but the layer no longer reaches any of them; plan 61-07 deletes them.
 *
 * The record and its injection seam are byte-unchanged in SHAPE across both
 * conversions - which is precisely what the seam was promoted for.
 */
export interface BeltPainter {
  /** Cache-key term. `'shipped'` for the default; a closed allow-list id otherwise. */
  readonly id: string;
  /**
   * K - the number of distinct baked march buckets. A rendering-budget quantization
   * ONLY: as of plan 61-04 it does NOT set the speed (see the header).
   */
  readonly phases: number;
  /**
   * T - sim ticks the march holds one bucket for. **1 as of plan 61-04**, i.e. the
   * march is re-evaluated every sim tick; it was 6, the MOTION-01 10fps lattice.
   * A T above 1 quantizes the clock to T ticks before the bucket is chosen, which is
   * precisely what the shipped strobe was - so the field stays meaningful at 1 rather
   * than becoming vestigial.
   */
  readonly quantum: number;
  /**
   * px - the PATTERN PERIOD along flow: the dash run plus its gap. MUST divide `CELL`
   * (32) so a per-tile asset tiles seamlessly across a cell border (FLOW-02).
   *
   * **This is a DIFFERENT number from the retired raster tread pitch (32)** and the
   * difference is not cosmetic. 32 was the MARCH pitch of the welded model - the
   * distance K buckets covered - while the pattern's own repeat has always been 16
   * (10px dash + 6px gap, `53-BELT-LOCK.md` axis 1). Under the split model the buckets
   * partition the PATTERN period, which is what makes every bucket byte-distinct
   * instead of collapsing in pairs.
   */
  readonly pitch: number;
  /**
   * The marching straight tread at march bucket `phase`, as vector geometry.
   *
   * `cell` is accepted for signature compatibility with the raster siblings and is
   * NOT read: a `GraphicsContext` is resolution-independent, so "the same tread at a
   * different cell size" is a transform on the display object, never a re-plot. The
   * geometry is authored at the shared `CELL` and nowhere else.
   */
  straight(skin: Skin, phase: number, cell: number): GraphicsContext;
  /** The marching rounded-elbow corner tread at `phase` in one chirality, as vector. */
  corner(skin: Skin, phase: number, chirality: 'cw' | 'ccw', cell: number): GraphicsContext;
  /** The phase-INDEPENDENT bold straight LOD tick (FLOW-03 low-zoom asset). */
  straightTick(skin: Skin, cell: number): GraphicsContext;
  /**
   * THE STRAIGHT SIDE RAILS AT THE LIVE DEVICE QUANTUM (plan 61-09) - one asset
   * shared by the full-detail tile AND the low-zoom tick.
   *
   * `quantum` is `DPR * zoom`, and it is the ONE argument on this record that is not
   * phase or chirality. The rails left the four tread bakes because a minimum DEVICE
   * thickness is inherently scale-dependent and the tread contexts must stay
   * scale-FREE (`61-RESEARCH.md` FINDING 1). See `beltGeometry.ts railBandAt`.
   *
   * **THE LAYER MUST REACH RAIL GEOMETRY ONLY THROUGH THIS SEAM.** A direct geometry
   * import in `belts.ts` would give the shipped look and every variant look two
   * different drift surfaces - which is the defect the seam was promoted to remove.
   */
  rails(skin: Skin, quantum: number): GraphicsContext;
  /** The corner's two rail ARCS at the live quantum, per chirality (full detail). */
  cornerRails(skin: Skin, quantum: number, chirality: 'cw' | 'ccw'): GraphicsContext;
  /**
   * The corner rails at the LOW-ZOOM sample count, per chirality.
   *
   * A separate method rather than a sample-count parameter, because the LOD cut is the
   * layer's decision and the record's job is to enumerate the asset families - the same
   * shape `cornerTick` already takes beside `corner`.
   */
  cornerRailTick(skin: Skin, quantum: number, chirality: 'cw' | 'ccw'): GraphicsContext;
  /** The phase-INDEPENDENT bold corner bend-cue tick, per chirality (RENDER-02). */
  cornerTick(skin: Skin, chirality: 'cw' | 'ccw', cell: number): GraphicsContext;
}

/**
 * THE DEFAULT - the LOCKED belt look (53-BELT-LOCK.md, Direction B) on the split-knob
 * march (plan 61-04): pattern period 16, K 12, quantum 1.
 *
 * THE RECORD'S PACE DID NOT MOVE, AND THAT IS THE POINT OF IT READING THIS WAY. The
 * shipped record was pitch 32 / K 4 / quantum 6, i.e. 8px every 6 sim ticks. This one
 * is period 16 / K 12 / quantum 1, i.e. 1.333333px every sim tick. Same per-tick pace,
 * sixty small steps instead of ten big ones - `beltPainter.metrics.test.ts` pins the
 * px-per-TICK figure across the change so the claim is gated rather than asserted in
 * prose.
 *
 * **THIS RECORD IS NOT THE BELT'S SPEED, AND SAYS NOTHING IN px/sec.** Phase 62 (D-05)
 * deleted every px/sec term from the render path: the tread now carries at the speed of
 * its cargo, so the ADVANCE is the per-belt derivation `marchPxPerTick(slotPitch,
 * ticks_per_slot)` and is not in this record at all. At the shipped 8px slot pitch and
 * `DEFAULT_TICKS_PER_SLOT = 2` that advance is 4px per tick; the record's 1.333333 is
 * the `ticks_per_slot == 6` case of the same model, which is where the retired
 * art-directed constant sat. What this record states is how the pattern is QUANTIZED
 * and HELD, not how fast a belt runs.
 *
 * NO FIELD IS A RE-TYPED LITERAL. `phases` and `quantum` read the two `beltGeometry.ts`
 * knobs; `pitch` reads the shared `BELT_DASH_PERIOD` record (BELT-08), so the record
 * cannot state a period the emitter does not draw. `quantum` deliberately no longer
 * reads `SIM_TICKS_PER_FRAME`: that coupling said "the march clock IS the animation
 * clock", which this plan makes false on purpose.
 */
/**
 * The locked belt look at ONE bucket count. `SHIPPED_PAINTER` is this at the default.
 *
 * EXTRACTED IN PLAN 61-06 SO THE SETTINGS PANEL HAS SOMETHING TO SWAP IN, and extracted
 * as a FACTORY rather than as a second hand-written record for the reason this file's
 * header already gives about `add-alongside`: two records drift. There is one body of
 * painter behaviour and `K` is a parameter of it, which is precisely what the split-knob
 * model (plan 61-04) says `K` is.
 *
 * THE `id` IS A CACHE KEY TERM, so it MUST vary with the bucket count. `belts.ts` appends
 * `painter.id` to every one of its four context keys; two painters sharing an id would
 * serve each other's geometry out of the cache at the wrong bucket count. The default
 * keeps the bare `'shipped'` id it has always had, so no committed digest label moves.
 */
function shippedPainterAt(buckets: number, id: string): BeltPainter {
  return Object.freeze({
    id,
    phases: buckets, // the K this painter marches on
    quantum: BELT_MARCH_QUANTUM_TICKS, // 1 - one sim tick per march step
    pitch: BELT_DASH_PERIOD, // 16 - the PATTERN period (10 + 6), never a re-typed literal
    // VEC-01 (plan 61-02): the straight family is VECTOR. It reads its path commands
    // from `beltGeometry.ts` (which knows nothing of Pixi or of a skin) and inks them
    // here. `K` is the factory's parameter rather than a re-typed literal, for the same
    // reason `phases` above is: the emitter's bucket count and the record's bucket count
    // are the SAME number and must not be able to drift.
    //
    // The `cell` parameter is deliberately unused (see the interface docblock): vector
    // geometry is authored once at the shared `CELL` and scaled by transform.
    straight: (skin: Skin, phase: number, _cell: number): GraphicsContext =>
      buildBeltContext(`belt|straight|none|${phase}`, straightCommands(phase, buckets), skin),
    // VEC-01 (plan 61-03): the CORNER family is VECTOR too, on the superseded radius.
    // Its label carries kind, chirality and bucket so a DEV budget failure names the
    // exact asset, which matters more here than on the straight: the corner is the only
    // belt asset with real sample-count sensitivity. RE-MEASURED BY PLAN 61-09 after the
    // rail split - the corner TREAD is 64-84 vertices (it was 264-284 while it carried
    // the rail arcs) and the corner RAIL family is 200, both against a 300 warn / 400
    // fail band.
    corner: (skin: Skin, phase: number, chirality: 'cw' | 'ccw', _cell: number): GraphicsContext =>
      buildBeltContext(
        `belt|corner|${chirality}|${phase}`,
        cornerCommands(phase, buckets, chirality),
        skin,
      ),
    straightTick: (skin: Skin, _cell: number): GraphicsContext =>
      buildBeltContext('belt|straight-tick|none|0', straightTickCommands(), skin),
    // Plan 61-09: the RAIL family, built through the SAME `buildBeltContext` as the
    // four tread families so the DEV vertex-budget net covers it identically. The
    // label carries the QUANTUM, because a budget failure on this family is a failure
    // at one particular device scale and naming the family alone would not locate it.
    rails: (skin: Skin, quantum: number): GraphicsContext =>
      buildBeltContext(`belt|rail|none|q=${quantum}`, railCommands(quantum), skin),
    cornerRails: (skin: Skin, quantum: number, chirality: 'cw' | 'ccw'): GraphicsContext =>
      buildBeltContext(
        `belt|corner-rail|${chirality}|q=${quantum}`,
        cornerRailCommands(ARC_SAMPLES, quantum, chirality),
        skin,
      ),
    cornerRailTick: (skin: Skin, quantum: number, chirality: 'cw' | 'ccw'): GraphicsContext =>
      buildBeltContext(
        `belt|corner-rail-tick|${chirality}|q=${quantum}`,
        cornerRailCommands(LOD_ARC_SAMPLES, quantum, chirality),
        skin,
      ),
    cornerTick: (skin: Skin, chirality: 'cw' | 'ccw', _cell: number): GraphicsContext =>
      buildBeltContext(`belt|corner-tick|${chirality}|0`, cornerTickCommands(chirality), skin),
  } satisfies BeltPainter);
}

export const SHIPPED_PAINTER: BeltPainter = shippedPainterAt(BELT_MARCH_BUCKETS, 'shipped');

/**
 * The painter for one of the THREE gated bucket counts (the Graphics panel that offered
 * them was deleted in plan 91-03, CHROME-03; the shipped default is `BELT_MARCH_BUCKETS`).
 *
 * NO SHIPPED CALLER (phase 91 review IN-A-02). Its only production caller went with that
 * panel (`setBeltSteps` in `pixiApp.ts`), so the shipped app always paints with
 * `SHIPPED_PAINTER`. It is kept as a TEST SEAM: `beltPainter.metrics.test.ts` measures the
 * other two gated counts through it, and `belts.test.ts` drives `belts.setPainter` with it to
 * keep the swap's teardown order graded (roots first, caches second). Delete it with
 * `setPainter` if those measurements are no longer wanted.
 *
 * IT REFUSES ANYTHING OFF THE GATED LATTICE, rather than building it. `belts.ts` bounds
 * its cache at `3K + 3` per painter and `beltGeometry.digest.test.ts` sweeps its
 * distinctness equality over exactly `BELT_MARCH_BUCKET_COUNTS`, so a fourth count would
 * be a cache size that no invariant in the suite has ever measured. No client state reaches
 * it now; the allowlist stays so a future caller meets the fence in one place.
 *
 * The default returns `SHIPPED_PAINTER` BY IDENTITY, so the shipped path is the same
 * object it has always been rather than an equal-looking rebuild.
 */
export function beltPainterForBuckets(buckets: number): BeltPainter {
  if (!BELT_MARCH_BUCKET_COUNTS.includes(buckets)) {
    throw new Error(
      `beltPainterForBuckets: ${buckets} is not one of the gated bucket counts ` +
        `(${BELT_MARCH_BUCKET_COUNTS.join(', ')}). The cache bound and the geometry ` +
        'distinctness sweep are stated over that list; a count outside it ships unmeasured.',
    );
  }
  return buckets === BELT_MARCH_BUCKETS ? SHIPPED_PAINTER : shippedPainterAt(buckets, `k${buckets}`);
}
