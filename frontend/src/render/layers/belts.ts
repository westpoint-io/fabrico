// The belt layer (UI-SPEC "Belts & items", SKIN-02).
//
// A belt is the TRACK itself: each belt tile is ONE synthesized chevron-tread
// Sprite baked through the Phase 23 synth pipeline (the same `makeGenerators`
// pipeline the machine layer uses), placed at its cell center and oriented by a
// whole-sprite 90-degree rotation. Straights orient off `TileView.Straight.axis`
// (X horizontal / Y vertical); corners orient toward `TileView.Corner.to` so the
// chevrons point the way flow turns. Rotation is ALWAYS a 90-degree multiple, so
// the pixel grid stays crisp (bible section 7: no non-90-degree sprite rotation,
// sub-pixel sampling breaks pixel integrity).
//
// The layer owns an instance-scoped SynthTextureCache and the belt generator: the
// tread is baked ONCE (rot=0) and every tile Sprite shares that one texture,
// rotated per tile - the bake-once/rotate-many discipline the machine layer
// proved (MOTION-05: a re-orient is a rotation, never a Graphics re-plot). The
// `setPainter` hook regenerates the cache leak-safely for the Phase 53 belt-look
// swap; there is no skin swap - styling resolves from the ONE locked skin (D-22).
//
// The dock-resolved endpoints are preserved: each docked end still plugs into the
// resolved port nub (resolveEndAnchor / beltEndCell / dockPort), coloured from the
// locked skin's palette. SHAPE carries the port role, not hue: a belt docked at a
// fault exit ends in a neutral ring cap (the fault nub's own `ramp[3]`, an annulus
// like the nub), and red on the board belongs to a faulted machine only (CHROME-18,
// phase 92 D-06).
//
// The old committed-track vector plotting (belt track rails, scrolling chevrons,
// the VIS-04 buffer-fill bar) is DELETED. Backpressure now reads from slot-true
// item bunching, delivered in plan 25-04; the style-independent scene oracle
// asserts topology (tiles / docks / item counts), never the buffer bar, so it
// stays green across the transient window. `drawBeltTilePath` is KEPT - the
// draw-belt preview overlay still strokes through it (restyled in plan 25-05).

// `Sprite` and `Texture` are GONE from this module as of plan 61-03, and that absence
// is the readable form of "the belt layer holds no raster asset". Every tile is a
// `Graphics` bound to a cached `GraphicsContext`; the layer's `SynthTextureCache`
// parameter survives only as a positional slot and a teardown path (see `setPainter`).
import { Container, Graphics, type GraphicsContext } from 'pixi.js';
import { CELL, ELBOW_R } from '../../../shared/geometry';
import { SIM_TICKS_PER_FRAME, tileCenter } from '../interp';
import { RESYNC_GAP_TICKS } from '../loop';
import {
  NUB_RING_R,
  NUB_RING_STROKE,
  beltEndCell,
  beltSeamPoint,
  dockPort,
  nubAnchor,
  PORT_ROLE,
} from '../../protocol/ports';
// BELT-06 (plan 61-04): the march arithmetic lives in the Pixi-free geometry module, so
// the layer selects a bucket rather than computing one. `marchPhaseOf` - the old
// integer frame wrap - is GONE from this module rather than repurposed: the new bucket
// function is neither integer-in nor offset-free, and a silent repurpose would have let
// new arithmetic be satisfied by an old name that several suites still pin.
import {
  MARCH_NYQUIST_CEILING_PX_PER_TICK,
  bucketOf,
  marchPxPerTick,
  resyncLurchPx,
  tileFlowLength,
} from '../synth/beltGeometry';
// Phase 53: the four belt bakes are no longer imported directly here. They are
// reached through the injected `BeltPainter` record (SHIPPED_PAINTER is the
// default), so the shipped look and every exploration variant travel the SAME code
// path. See beltPainter.ts for the promote decision and the byte-identity proof.
import { SHIPPED_PAINTER, type BeltPainter } from '../synth/beltPainter';
import { snapToDevicePixel } from './items';
import { SynthTextureCache } from '../synth/textureCache';
// VEC-01 (plan 61-02): the STRAIGHT tread is vector. Its tiles are `Graphics` bound
// to one shared `GraphicsContext` per (kind, chirality, bucket) out of this cache;
// the corner families are still raster Sprites out of the texture cache above until
// plan 61-03 converts them. Both caches are instance-scoped and both are torn down by
// the ONE `setPainter` path.
import { BeltContextCache, beltContextKey } from '../synth/beltContextCache';
import type { Skin } from '../synth/skin';
import type { SceneState } from '../sceneState';
import type { BeltEnd, BeltView, NodeView, TileView } from '../../protocol/decode';
import { pendingSeamTiles } from '../pendingSeams';
import { plottedCircles } from '../plotRead';

const HALF = CELL / 2;
// ELBOW_R is imported from shared/geometry (FLOW-05 single source): the preview
// `drawBeltTilePath` arc and the committed corner geometry share ONE constant, so
// preview == committed by construction and neither can drift. It said "the committed
// corner BAKE" until plan 61-07; there is no bake - the committed corner is vector
// geometry emitted by `synth/beltGeometry.ts` and inked by the shipped painter.

// FLOW-03 LOD hard-cut (UI-SPEC C4, RESEARCH Pattern 4): below this many on-screen
// device px per tread (scale * CELL) the fine marching chevron reads as a muddy
// smear, so each tile swaps to the bold single-tick LOD bake. A SINGLE inclusive
// threshold (no hysteresis), mirroring the Phase-29 grid minor-line hard-cut.
// RENDER-02: raised 16 -> 24 so the now full-width corner arc bands do not smear in
// the 0.5-1.0x zoom band (below the cut a corner falls back to the bold bend-cue
// tick). This is the BELT cut only; wires.ts keeps its own separate 16 (comet tails,
// not corner arcs) - do NOT couple them.
const LOD_MIN_TREAD_PX = 24;

// FLOW-07 dominant dock cap (UI-SPEC C7, RESEARCH Pattern 9): the native cap radius
// (px @ zoom 1), enlarged from the old 2.5px dot so the role colour is the DOMINANT
// belt-end element. Floored on-screen via `CAP_R / Math.min(1, scale)` so the read
// survives low zoom - the same screen-px-floor shape as ports.ts nubHitRadiusWorld.
const CAP_R = 6;

// FLOW-07 cap floor guard (WR-03): `CAP_R / Math.min(1, scale)` is otherwise unbounded
// and diverges to Infinity at scale 0 (camera-init transient, or if the min-zoom clamp
// is ever relaxed). Mirror the items.ts itemDotGrow discipline (an explicit upper cap):
// clamp the effective scale to the camera's minimum zoom and ceiling the radius at its
// value there, so the cap never balloons past the lane and is always finite.
const MIN_SCALE = 0.25; // mirrors the camera's minimum zoom clamp
const CAP_R_MAX = CAP_R / MIN_SCALE; // = 24: the on-lane cap radius at min zoom

// The JUNCTION COLLAR (Phase 74, LINK-03; 74-UI-SPEC 2.1). A filled disc with a ring
// stroked on its edge - a grommet - centred on the SEAM two joined belts share.
//
// BOTH RADII ARE DERIVED, and that is the whole reason `NUB_RING_R` / `NUB_RING_STROKE`
// moved into `ports.ts`. The disc must land exactly on the ring's INNER EDGE, so it is
// always `ringR - NUB_RING_STROKE / 2` (= 6 at zoom 1) - derived from the FLOORED ring
// radius rather than from the native one, so the two halves of the grommet stay welded
// at every zoom instead of the disc falling out of a ring that grew without it.
// Writing 6 anywhere here would be a third copy of a number three files now read.
const collarDiscR = (ringR: number): number => ringR - NUB_RING_STROKE / 2;
// The low-zoom ceiling, INHERITED one for one from `CAP_R_MAX` rather than minted: the
// collar takes the plug cap's floor formula verbatim, so the two marks grow together
// under a zoom-out instead of one of them quietly outrunning the other.
const COLLAR_R_MAX = NUB_RING_R / MIN_SCALE; // = 28: the collar ring radius at min zoom

// BELT-05 (plan 61-09): a belt tile is a `Container` holding exactly TWO `Graphics` -
// the TREAD, whose context is the scale-free marching asset, and the RAIL, whose
// context is the device-quantum-aware one. Named rather than written as 0 and 1 at four
// call sites, because a silent index swap would bind each half to the other's geometry
// and still draw something plausible at zoom 1.
export const TREAD_CHILD = 0;
export const RAIL_CHILD = 1;

/**
 * THE PUBLISHED RESYNC LURCH METRIC (plan 61-04), in world px, PER BELT since Phase 62.
 *
 * This is what a belt's tread jumps in one frame when `loop.ts` snaps the render clock
 * forward by `RESYNC_GAP_TICKS` to track a live sim (first connect to a running sim, a
 * restored background tab, or a sim advancing faster than the display refreshes).
 *
 * **IT SHRINKS AT A SLOWER TREAD, WHICH IS A STRICTLY BETTER STORY THAN THE ONE BELOW,
 * and the figure quoted in the rest of this docblock is now the WORST CASE.** It was a
 * module constant because the advance was one (`8.00px` at the retired art-directed
 * rate); D-05 makes the advance a per-belt derivation off the render packet, so the
 * lurch is a function of that belt's own px-per-tick. The worst case is the fastest
 * tread the aliasing ceiling permits, `RESYNC_GAP_TICKS * MARCH_NYQUIST_CEILING_PX_PER_TICK`,
 * and the ceiling clamp is what bounds it: no belt can lurch further than this,
 * whatever the packet says. At any interval this phase can ship (D-06 floors it at
 * twice today's) the real lurch is at most half the number below.
 *
 * IT IS PUBLISHED BECAUSE THIS LAYER'S OWN RULE DEMANDS IT. The draw path below has
 * required, since 53-03, that "any painter proposing a sub-6 quantum must publish a
 * lurch metric beside its speed, rather than presenting the speed gain alone". Plan
 * 61-04 proposes quantum 1, the hardest sub-6 quantum there is, so the metric is stated
 * here as a named constant rather than left to be discovered. It is DERIVED from
 * `RESYNC_GAP_TICKS` and the per-tick advance, never re-typed, so it cannot drift from
 * the gap it describes.
 *
 * **HALF A PERIOD IS THE WORST VALUE IT COULD TAKE**, not a middling one: in a periodic
 * pattern a jump forward by half a period is indistinguishable from a jump backward by
 * half a period, so the lurch is maximally direction-ambiguous. At the shipped 10fps
 * quantum the same snap moved exactly ONE bucket and was invisible; at quantum 1 it
 * moves six.
 *
 * **IT IS ACCEPTED, NOT FIXED**, and the two available fixes are both refused on the
 * record (`61-RESEARCH.md` Pitfall 6):
 *
 *   (a) RAISING `RESYNC_GAP_TICKS` - refused. It is a `loop.ts` global that the machine
 *       layer rides too, so softening the belt's lurch would slow every layer's
 *       resynchronisation to the live sim. A belt look is not entitled to move a
 *       loop-level constant.
 *   (b) RAMPING the belt phase over a few frames after a snap - refused. A ramp is
 *       state that lives outside the clock, so the drawn phase would stop being a pure
 *       function of the sim render clock. That reintroduces wall-clock-flavoured
 *       non-determinism and breaks the clock-purity the whole march model rests on -
 *       the exact failure class MOTION-01 was created to kill.
 *
 * What is left is the honest option: it is a one-off transient at an instant when the
 * WHOLE scene snaps anyway - the machine layer jumps a whole animation frame at the
 * same moment - so the belt is not the thing a player notices. Its subjective read goes
 * to the FEEL kit; this constant is its objective statement.
 */
export function marchResyncLurchPx(pxPerTick: number): number {
  return resyncLurchPx(RESYNC_GAP_TICKS, pxPerTick);
}

/** The worst lurch any belt can take: the gap at the aliasing ceiling. */
export const MARCH_RESYNC_LURCH_PX_WORST_CASE = marchResyncLurchPx(
  MARCH_NYQUIST_CEILING_PX_PER_TICK,
);

/**
 * THIS BELT's SLOT PITCH along flow, in world px - how far one item slot sits from the
 * next on a STRAIGHT tile. **Derived from the wire, never re-typed.**
 *
 * `interp.ts` states the rule: a render-side copy of `SLOTS_PER_TILE` would be a second
 * source of truth that a core bump could silently desynchronise. So slots-per-tile comes
 * off the packet as `latency / tiles.length` (the host ships `latency = SLOTS_PER_TILE *
 * tiles`), exactly as `slotArcLength` derives it, and the pitch is the cell divided by
 * it.
 *
 * THE STRAIGHT PITCH IS THE RIGHT ONE OF THE TWO, and the choice is deliberate. A corner
 * tile's four slots spread over its real 25.132741 px arc, so an item's pitch through a
 * bend is 6.283185 px against a straight's 8 (`interp.ts`: sim-true slot spacing, the maintainer's
 * call). The tread is ONE rate per belt walking a lattice shared by every tile, so it
 * cannot be both; the straight pitch is the belt's dominant case and the one a player
 * reads speed from. The consequence is that a tread through a bend runs ~21% fast
 * relative to its cargo there - the mirror image of the dip `interp.ts` documents and
 * accepts, and far inside the aliasing ceiling.
 *
 * TWO DEGENERATE INPUTS, both from an untrusted packet rather than from a well-formed
 * one. A `Wire`-minted belt carries an EMPTY `tiles` array, and the layer already draws
 * it through a degenerate one-cell guard, so one cell is what this reads too. A
 * non-finite or sub-one slots-per-tile has no slot-to-tile map at all; it degrades to
 * one slot per cell. Neither can reach a well-formed packet, and both must be total
 * because the alternative is a `NaN` that kills the render loop (see
 * {@link marchPxPerTick}).
 */
function beltSlotPitchPx(belt: BeltView): number {
  const drawn = belt.tiles.length > 0 ? belt.tiles.length : 1;
  const slotsPerTile = Number.isFinite(belt.latency) ? belt.latency / drawn : 0;
  if (!Number.isFinite(slotsPerTile) || slotsPerTile < 1) return CELL;
  return CELL / slotsPerTile;
}

/**
 * THIS BELT's march advance per sim tick, in world px (SLOT-03, `62-CONTEXT.md`
 * D-01/D-05).
 *
 * **The tread carries at the speed of its cargo.** An item crosses one slot pitch every
 * `ticks_per_slot` sim ticks, so that quotient IS the speed, and the painted surface
 * now runs at it. Both inputs are read off the WIRE and neither is re-typed from a core
 * constant.
 *
 * WHAT THIS REPLACED, so the supersession is legible rather than reconstructed. Until
 * this plan the base was a module constant carrying an art-directed 80 px/sec, divided
 * by the belt's interval. Plan 62-01 (the tracer) kept that base deliberately, so its
 * commit could change SHAPE without changing BEHAVIOUR; **plan 62-04 deletes it by
 * derivation** (D-05), which supersedes a signed art axis (D-07) and is recorded as such
 * at the deleted constants' own site in `beltGeometry.ts`. The shipped tread crawled at
 * roughly one sixth the speed of its cargo; it no longer does.
 *
 * THE DIVISOR IS FLOORED AND THE RESULT IS CLAMPED, NOT TRUSTED. `ticks_per_slot` is a
 * plain `u32` on the wire and the packet is untrusted input; the core's `NonZeroU32`
 * invariant does not travel. A forged or broken 0 would make `phasePx` non-finite,
 * `Math.round(NaN)` is `NaN`, and a `NaN` bucket index would miss the asset cache and
 * throw inside `Application.render` - which, as a Ticker listener, stops the render loop
 * PERMANENTLY on a partial frame. That is the exact failure mode
 * behind the 2026-08-11 machines-missing-on-WebKitGTK bug, and it is invisible
 * to every model-level oracle. So the guards are render HEALTH, not defensive
 * decoration; they mirror this file's own `Math.min(1, scale)` and `CAP_R_MAX` clamps.
 * Both live inside {@link marchPxPerTick} so no caller can forget them.
 *
 * THE OVERRIDE (SLOT-03, D-18) IS A RENDER-SIDE APPEARANCE SWITCH AND NOTHING ELSE.
 * `override` is `null` in every shipped build, in which case this is the wire-derived
 * rate above and the parameter costs one comparison. When it is a finite positive
 * number the tread paints at THAT advance, so an appearance anchor can be asked on a
 * board that still looks like the one the maintainer has been living with. Since plan 68-07
 * NOTHING in the tree supplies a number: the panel that used to is deleted and this is a
 * retained instrument hook (see `loop.ts`'s `setTreadAppearanceOverride` docblock). Two
 * things it deliberately is NOT:
 *
 *   - It is NOT a second derivation path. It replaces the result outright rather than
 *     feeding a parallel formula, so there is still exactly one place a march advance is
 *     computed from the wire.
 *   - It carries NO figure of its own, here or in `loop.ts`. The one copy of the
 *     superseded art rate was deleted with the panel that held it (plan 68-07), so there
 *     is no such figure anywhere in the tree today. Reinstating it in this file would
 *     undo plan 62-04's deletion-by-derivation under a new symbol name.
 *
 * It goes through the SAME Nyquist ceiling and the same non-finite guard as the derived
 * rate: an override is still a march advance, and the aliasing wall is a property of the
 * dash period, not of where the number came from.
 */
function beltPxPerTick(belt: BeltView, override?: number | null): number {
  if (override != null && Number.isFinite(override) && override > 0) {
    return Math.min(override, MARCH_NYQUIST_CEILING_PX_PER_TICK);
  }
  return marchPxPerTick(beltSlotPitchPx(belt), belt.ticks_per_slot);
}

/**
 * WHETHER A TILE TURNS (phase 89, plan 89-03, BELT-10, D-15): a `Corner` whose `from` and `to`
 * differ. The seam table answers the zero-turn `Corner{from: e, to: e}` for a one-tile belt,
 * so its flow direction survives the axis-only `Straight` (a one-tile belt flowing West was
 * drawn flowing East). Such a tile does not bend: it is a straight running along `from`.
 * `tileRotation`, `rebuildTiles`, `tailOffsets` and `drawBeltTilePath` (which also draws the
 * preview and the held pictures) all ask this ONE question, so the tread, the rail, the march
 * phase and the stroke cannot disagree about which tiles bend. `beltItemPolyline`
 * (`interp.ts`) already sweeps no arc on a non-perpendicular corner and takes its entry
 * travel, so the items agree with it. Pure, display-only.
 */
export function isTurningCorner(kind: TileView['kind']): boolean {
  return 'Corner' in kind && kind.Corner.from !== kind.Corner.to;
}

/**
 * THE PER-BELT PHASE ACCUMULATOR (BELT-02, plan 61-04): each tile's distance along
 * flow from its OWN belt's tail, index-aligned with `tiles`.
 *
 * `offsets[0]` is 0 by construction and `offsets[i]` is the running sum of the flow
 * lengths of every tile upstream of `i`. A straight contributes 32.000; a corner
 * contributes its quarter arc on the centreline radius, 25.132741 - **not** a whole
 * tile. Accumulating 32 through a bend is precisely how the shipped belt earned its 2px
 * jump at every corner, and correcting it is BELT-02.
 *
 * **PHASE RESTARTS AT 0 AT EVERY BELT'S TAIL, and that is a decision rather than a
 * simplification** (`61-CONTEXT.md` section B). A run reads continuous end to end
 * through every corner WITHIN one belt. A seam may appear where two belts meet at a
 * dock, which is accepted because a dock is already a visual break - there is a machine
 * standing there. Accumulating ACROSS docks would couple independently cached belts to
 * one another and re-phase everything downstream on any upstream topology edit.
 *
 * IT IS PURE TOPOLOGY, so the layer captures it ONCE on a geoKey rebuild, beside
 * `centers` and `kinds`, and never in the per-frame loop. A tile's offset cannot change
 * without its belt's tile run changing, and the tile run is a geoKey term.
 */
export function tailOffsets(tiles: TileView[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const t of tiles) {
    out.push(acc);
    // A zero-turn corner flows a whole cell, as a straight does (D-15).
    acc += tileFlowLength(isTurningCorner(t.kind));
  }
  return out;
}

/**
 * The true 1-of-4 travel cardinal (N=0, E=1, S=2, W=3) AT tile `i`, derived from
 * the tail->head `tiles[]` ordering ALONE - no packet field (FLOW-01, RESEARCH
 * Pattern 2). Flow points from `tiles[i]` toward `tiles[i+1]`; at the head tile it
 * reads `tiles[i-1] -> tiles[i]`. This is the SAME adjacency `tilePolyline` /
 * item-pathing consume, so treads and item dots agree by construction, and a
 * corner's derived cardinal here equals its own `Corner.to` (junction agreement).
 * Pure + display-only: reads tiles[], returns a cardinal; never writes back to the
 * decoder, a GridCommand, or the sim (the fixed-point determinism boundary holds).
 */
export function flowDirAt(tiles: TileView[], i: number): 0 | 1 | 2 | 3 {
  const last = tiles.length - 1;
  const src = i < last ? tiles[i] : tiles[Math.max(i - 1, 0)];
  const dst = i < last ? tiles[Math.min(i + 1, last)] : tiles[i];
  const dx = dst.cell_x - src.cell_x;
  const dy = dst.cell_y - src.cell_y;
  if (dx > 0) return 1; // E
  if (dx < 0) return 3; // W
  if (dy > 0) return 2; // S
  return 0; // N (also the degenerate single-tile default)
}

/**
 * The chirality of a 90-degree corner turn, derived purely from its two cardinals
 * (FLOW-05, RESEARCH Pattern 7). Flow enters heading `from` (N=0,E=1,S=2,W=3) and
 * exits heading `to`; a CLOCKWISE turn is `to === (from + 1) % 4` (the compass
 * order N->E->S->W), everything else is counterclockwise. This partitions the 8
 * valid turns 4/4, which is exactly what a single whole-sprite 90-degree rotation
 * CANNOT reach - the other chirality's elbow, the x-mirror of the canonical one,
 * covers the remaining 4. (It read "the other chirality's BAKED elbow" until plan
 * 61-07 deleted the raster corner; the mirror is emitted geometry now, and the 4/4
 * partition is unchanged by that.) Pure + display-only: reads two cardinals, returns a
 * handedness; never a cache key TERM beyond the two variants, never written back to the
 * decoder / a GridCommand / the sim (the determinism boundary holds, T-31-DET).
 */
export function cornerChiralityOf(from: number, to: number): 'cw' | 'ccw' {
  return to === (from + 1) % 4 ? 'cw' : 'ccw';
}

/**
 * The whole-sprite quarter-turn count for a 90-degree corner tile, branched by
 * chirality (D-01, the F2a fix). The cw bake is NATIVE (zero rotation) at to=W,
 * so cw corners rotate by ((to + 1) mod 4) quarter turns - the same cardinal
 * mapping straights use. The ccw bake is the cw bake's x-MIRROR, native at to=E:
 * a mirror cannot be reached by rotation, and rotating a mirrored shape composes
 * with opposite sign, so the ccw formula is ((to + 3) mod 4). Applying the cw
 * formula to both chiralities put every ccw corner exactly 180 degrees off (its
 * arc in the wrong cell quadrant) - the maintainer's live-FEEL finding F2a. Pure exported
 * heading math (N=0, E=1, S=2, W=3), consumed by BOTH `tileRotation` and the
 * layer tests so the quarter-turn formula has one source of truth.
 */
export function cornerQuarterTurns(from: number, to: number): number {
  return cornerChiralityOf(from, to) === 'cw' ? (to + 1) % 4 : (to + 3) % 4;
}

export interface BeltTilePathOpts {
  width: number;
  color: number;
  alpha?: number;
  /** Elbow rounding radius at corner tiles (defaults to ELBOW_R). */
  cornerRadius?: number;
}

/** The unit cell step of a travel cardinal, N=0 E=1 S=2 W=3 (y-down). */
const CARDINAL_STEP: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Stroke the full tiled belt lane (straights + rounded 90-degree corner elbows)
 * along the tile cell-center polyline, tail->head. Corner tiles round the vertex
 * with Pixi v8 `arcTo` (the inside-of-the-bend elbow); straight tiles are plain
 * segments. KEPT for the draw-belt PREVIEW overlay (14-07) - the committed belt
 * track is now synth tread tiles (below), but the preview affordance still strokes
 * a single tile-path line through this primitive (restyled to the build accent in
 * plan 25-05). Pure render-side float; consumes only the already-validated
 * `TileView[]` from the decoder (no untrusted parsing here).
 *
 * AN END CORNER BENDS (plan 74.1-08). Since 74.1-07 the host ships a Corner at a docked
 * end that turns, and the preview predicts that kind, so tiles[0] or tiles[n-1] can be a
 * Corner. A Corner at tiles[0] starts the stroke on its ENTRY edge midpoint (the edge
 * flow heading `from` crosses) and arcs through its centre toward the next point; a
 * Corner at tiles[n-1] arcs through its centre and ends on its EXIT edge midpoint (the
 * edge flow heading `to` crosses); a one-tile Corner draws its own quarter arc from one
 * to the other. Before, the stroke started and ended at a tile centre and skipped a
 * corner at either end, so an end corner drew as a straight stub. A straight end still
 * starts or ends at its centre, and the interior is unchanged. `ELBOW_R` stays the one
 * radius source.
 */
export function drawBeltTilePath(
  g: Graphics,
  tiles: TileView[],
  opts: BeltTilePathOpts,
): void {
  if (tiles.length === 0) return;
  const R = opts.cornerRadius ?? ELBOW_R;
  const pts = tiles.map(tileCenter);
  const n = pts.length;
  /** The midpoint of the edge a flow heading `dir` crosses, signed by `sign`. */
  const edge = (i: number, dir: number, sign: number): { x: number; y: number } => {
    const [dx, dy] = CARDINAL_STEP[dir & 3];
    return { x: pts[i].x + sign * dx * HALF, y: pts[i].y + sign * dy * HALF };
  };
  const first = tiles[0].kind;
  if ('Corner' in first && isTurningCorner(first)) {
    // Entry edge: back along the entry travel from the centre.
    const entry = edge(0, first.Corner.from, -1);
    const next = n > 1 ? pts[1] : edge(0, first.Corner.to, 1);
    g.moveTo(entry.x, entry.y);
    g.arcTo(pts[0].x, pts[0].y, next.x, next.y, R);
    if (n === 1) {
      g.lineTo(next.x, next.y);
    }
  } else if ('Corner' in first) {
    // A zero-turn corner (D-15) is a straight along `from`: a segment from its entry edge
    // through its centre (and on to its exit edge when it is the whole belt), never an
    // `arcTo` over three collinear points.
    const entry = edge(0, first.Corner.from, -1);
    g.moveTo(entry.x, entry.y);
    g.lineTo(pts[0].x, pts[0].y);
    if (n === 1) {
      const exit = edge(0, first.Corner.to, 1);
      g.lineTo(exit.x, exit.y);
    }
  } else {
    g.moveTo(pts[0].x, pts[0].y);
  }
  for (let i = 1; i < n; i++) {
    const kind = tiles[i].kind;
    if ('Corner' in kind && !isTurningCorner(kind)) {
      // A zero-turn corner at the head: a straight on to its exit edge (D-15). DEFENSIVE for
      // a tile after the first: `seamEndKind` ships one only on a single-tile belt today, and
      // the multi-tile case in belts.test.ts keeps this arm from reading as load-bearing dead
      // code (review IN-B-02).
      g.lineTo(pts[i].x, pts[i].y);
      if (i === n - 1) {
        const exit = edge(i, kind.Corner.to, 1);
        g.lineTo(exit.x, exit.y);
      }
    } else if ('Corner' in kind) {
      // An interior corner rounds toward the next centre; the head corner toward its
      // own exit edge, where the stroke then ends.
      const toward = i < n - 1 ? pts[i + 1] : edge(i, kind.Corner.to, 1);
      g.arcTo(pts[i].x, pts[i].y, toward.x, toward.y, R);
      if (i === n - 1) {
        g.lineTo(toward.x, toward.y);
      }
    } else {
      g.lineTo(pts[i].x, pts[i].y);
    }
  }
  g.stroke({
    width: opts.width,
    color: opts.color,
    alpha: opts.alpha ?? 1,
    cap: 'round',
    join: 'round',
  });
}

/**
 * A resolved docked-end anchor. DISCRIMINATED since Phase 74 (74-UI-SPEC 2.5), because
 * a belt end now docks to two structurally different things and they draw two different
 * marks: a machine PORT gets the shipped plug stem plus its role cap, and a BELT SEAM
 * gets the junction collar.
 *
 * THE SEAM VARIANT CARRIES NO `role`, DELIBERATELY. The collar's ink is fixed and does
 * not vary by role, so synthesising a role byte here would put a second port-role
 * source of truth into the render for a mark that never reads it.
 */
export type EndAnchor =
  | { kind: 'port'; x: number; y: number; role: number }
  | { kind: 'belt-seam'; x: number; y: number };

/**
 * Resolve one belt end's dock to its anchor (D-05 read side, D-08).
 *
 * TWO TARGET SHAPES, ONE FUNCTION, mirroring the way `command.rs`'s Dock arm resolves
 * a machine target through `port_world` and a belt target through `belt_end_world` and
 * then applies the SAME rule to whichever answered:
 *
 *   - a MACHINE target: the dock's node handle looked up in the scene, the dock
 *     keyspaces resolved via the single `dockPort` reader, and the port's world nub
 *     anchor via the shared `nubAnchor` math.
 *   - a BELT target: `beltSeamPoint`, the ONE seam definition in `ports.ts` that the
 *     grab dot and the gesture hit set also read. `dockPort` structurally cannot serve
 *     it - a belt has no `NodeView` and D-05 keeps `ports` off `BeltView` - which is
 *     why a joined pair used to draw as two bare ends facing each other (LINK-03).
 *
 * Undocked ends, unknown handles, and null-resolving docks (the non-spatial fault case)
 * all return `null` - that end renders undocked-style and never crashes (T-21-06
 * mitigated, and T-74-24: nothing here throws inside the ticker).
 */
function resolveEndAnchor(
  nodes: ReadonlyMap<number, NodeView>,
  belts: ReadonlyMap<number, BeltView>,
  belt: BeltView,
  end: BeltEnd,
): EndAnchor | null {
  const dock = belt.docks.find((d) => d.end === end);
  if (!dock) return null;
  const seam = beltSeamPoint(belts, belt, end);
  if (seam) return { kind: 'belt-seam', x: seam.x, y: seam.y };
  const node = nodes.get(dock.node);
  const port = node ? dockPort(node, dock) : null;
  if (!port) return null;
  const { x, y } = nubAnchor(port.cell_x, port.cell_y, port.side);
  return { kind: 'port', x, y, role: port.role };
}

/**
 * The machine plugs of a FAN-IN Tail past its first dock (walk finding, phase 89 review pass 2).
 * Since LINK-13 a belt's Tail holds one dock per upstream, but `resolveEndAnchor` answers the
 * first dock only, so a second machine feeding the same Tail was drawn with no stem and no cap:
 * its Out looked unconnected while its panel said connected. Every Tail dock after the first that
 * names a machine port answers its port anchor here; a dock naming a belt answers nothing, because
 * a belt-to-belt join is drawn by the upstream belt's Head (the collar ownership rule).
 */
function resolveExtraTailAnchors(nodes: ReadonlyMap<number, NodeView>, belt: BeltView): EndAnchor[] {
  const out: EndAnchor[] = [];
  const tails = belt.docks.filter((d) => d.end === 'Tail');
  for (const dock of tails.slice(1)) {
    const node = nodes.get(dock.node);
    const port = node ? dockPort(node, dock) : null;
    if (!port) continue;
    const { x, y } = nubAnchor(port.cell_x, port.cell_y, port.side);
    out.push({ kind: 'port', x, y, role: port.role });
  }
  return out;
}

/** The role term of an anchor key: a port's role byte, or a placeholder for a seam,
 *  which carries no role by design (see {@link EndAnchor}). */
const anchorRole = (a: EndAnchor): string => (a.kind === 'port' ? `${a.role}` : '-');

/**
 * One end anchor, folded into the geometry cache key.
 *
 * THE DISCRIMINANT IS FOLDED FIRST, AND THAT IS THE POINT. A seam anchor carries no
 * `role`, so the pre-Phase-74 key of `x,y,role` alone would make a port anchor and a
 * seam anchor at the same point key IDENTICALLY - and this key GATES the whole
 * `rebuildEnds`, so a belt whose end changed from a machine plug to a junction collar
 * without moving would keep drawing the plug. This file's own recorded lesson (the
 * geoKey comment in `draw`) is that keying on the dock TUPLES alone leaves a plug
 * pointing at a stale nub; a key that cannot tell the two anchor KINDS apart is the
 * same bug with a new cause.
 *
 * Exported for the suite that pins exactly that, alongside `tailOffsets` and
 * `cornerChiralityOf`: the collision it guards is unreachable through the public draw
 * path on any real board (a nub anchor is pushed 2.5px off a cell edge and a seam sits
 * exactly ON one), which is precisely why it needs a direct case rather than a hope.
 */
export const anchorKey = (a: EndAnchor | null): string => (a ? `${a.kind},${a.x},${a.y},${anchorRole(a)}` : 'none');

/** One belt: a root holding the per-tile tread Sprites + the docked-end plugs. */
interface BeltSprite {
  root: Container;
  tiles: Container; // one oriented chevron-tread Sprite per belt tile
  ends: Graphics; // docked-end plug connectors + role caps
  geoKey: string;
  // Unsnapped world-px tile centers, index-aligned with `tiles.children`, captured
  // on rebuild. The per-frame device-pixel snap (FLOW-06) reads these so it re-snaps
  // from the true center at each new quantum instead of compounding rounding.
  centers: Array<{ x: number; y: number }>;
  // Per-tile kind tags, index-aligned with `tiles.children`, captured on rebuild so
  // the per-frame texture swap (FLOW-05) picks the STRAIGHT chevron family for a
  // straight tile and the corner-chirality family for a corner tile without
  // re-reading `belt.tiles`. Chirality is null for a straight.
  kinds: Array<{ corner: boolean; chirality: 'cw' | 'ccw' | null }>;
  // BELT-02 (plan 61-04): each tile's along-flow distance from THIS belt's tail,
  // index-aligned with `tiles.children`, captured on rebuild. It sits here beside
  // `centers` and `kinds` for the same reason they do - it is pure TOPOLOGY, so it
  // belongs on the geoKey-gated record and NOT in the per-frame loop. See
  // `tailOffsets`.
  offsets: number[];
  // The tile run the current geometry was BUILT from (plan 74.1-20), captured on the
  // geoKey-gated rebuild beside `kinds`. Usually `belt.tiles`; while a just-drawn belt's
  // follow-up Dock is pending it is the predicted seam (`pendingSeams.ts`). Read only by
  // `drawnTilesOf`, the frame-stepping instrument.
  drawn: TileView[];
}

export interface BeltLayer {
  layer: Container;
  /**
   * Redraw belts for the current scene. Geometry is built ONCE via the frame-free
   * geoKey; every draw swaps each tile's bound `GraphicsContext` to its current march
   * bucket, so the tread marches with no display-object churn at all.
   *
   * **`clock` IS THE MARCH INPUT AS OF PLAN 61-04, AND `frame` IS NOT.** `clock` is the
   * render clock in SIM-TICK units (`effectiveClock` in `loop.ts`), defaulted to
   * `frame * SIM_TICKS_PER_FRAME` so every existing 2-argument caller keeps its exact
   * meaning. `frame` is the MOTION-01 10fps animation index and now selects nothing on
   * this layer: belts march at the sim tick rate while machine sprite animation stays
   * deliberately chunky at 10fps, which is the approved decoupling recorded in
   * `61-CONTEXT.md` section B. The two still FREEZE together, because both derive from
   * the one `effectiveClock` that `pinClock` overrides (SAFE-02).
   *
   * `painter.quantum` survives as a clock QUANTIZER rather than a phase divisor: at the
   * shipped 1 the clock passes through untouched; above 1 it is floored to whole
   * multiples of the quantum first, which is exactly what the retired 10fps strobe was.
   *
   * `treadPxPerTickOverride` is the SLOT-03 pre-Phase-62 tread-appearance override
   * (`loop.ts`'s `setTreadAppearanceOverride`), and it is `null`/absent in every shipped
   * build - a 2- or 3-argument caller therefore keeps its exact meaning. When it is a
   * number, every belt paints its tread at THAT advance instead of at the one derived
   * from its own wire fields, so an appearance anchor can be asked on a board that still
   * looks like today's. Only this file's own tests pass a number today. It carries no
   * figure into this file: see {@link beltPxPerTick}.
   */
  draw(
    scene: SceneState,
    frame: number,
    clock?: number,
    treadPxPerTickOverride?: number | null,
  ): void;
  /**
   * Painter-swap hook (Phase 53): tear the tread cache down leak-safely and rebind
   * the belt look to `next`, so every tile re-bakes lazily under the new painter.
   *
   * NO SHIPPED CALLER since plan 91-03 deleted the Graphics panel and `pixiApp.ts`'s
   * `setBeltSteps` with it (phase 91 review IN-A-02): only `belts.test.ts` swaps a painter,
   * to keep the teardown order graded. The shipped app keeps the painter it was built with.
   */
  setPainter(next: BeltPainter): void;
  /**
   * The PLOT READ for one belt's END marks: how many geometry instructions that
   * belt's `ends` Graphics currently holds (74-09, LINK-03).
   *
   * Same shape and same argument as `MachineLayer.portNubInstructionsOn`, on a
   * different cue. The live oracle reads only `window.__fabrico.scene()`, so a spec
   * that joins two belts and then reads `belts[].docks` has proved the MODEL holds a
   * link and NOTHING about whether the junction reached the screen. That is this
   * repository's recorded model-oracle blind spot rather than a hypothesis, and a
   * probe that read the model would BE the blind spot rather than an instrument for
   * it.
   *
   * A COUNT rather than a boolean, matching `portNubInstructionsOn` for the same
   * reason: a number can express both halves of the claim - non-zero while the
   * junction is joined, and back to ZERO after a Disconnect clears it - and a boolean
   * cannot express the second half as a number moving.
   *
   * WHAT IT COUNTS, said precisely so a reader does not over-read it. `rebuildEnds`
   * clears this Graphics and re-plots BOTH ends of the belt: a machine dock plots a
   * stem plus a role cap, a belt-to-belt junction plots the collar disc plus its ring,
   * and an UNDOCKED end plots nothing at all. So on a board whose only link is one
   * belt-to-belt junction, the upstream belt's count IS the collar and nothing else.
   * On a board where the same belt also docks a machine, it is the sum. A caller that
   * needs the collar isolated must build the board that isolates it.
   *
   * Read-only, no setter, no Pixi ref (T-14-FABRICO-RO): a number off a context.
   * A belt with no sprite (never drawn, or swept) answers 0, which is the truthful
   * answer - there is no end mark on the screen either way.
   */
  endInstructionsOn(id: number): number;
  /**
   * WHERE the junction collar of one belt is PLOTTED (review fix CR-C-01): the centres of the
   * stroked circles on the belt's `ends` Graphics, read back off its own instructions
   * (`plotRead.ts`), in world px. Only the collar ring is a stroked circle there (a machine plug is
   * a stroked line plus a filled cap), and the collar is drawn by the upstream belt's Head (the
   * ownership rule in `rebuildEnds`), so this is the seam the user sees between two joined belts,
   * read off the plot and never off the dock list. Empty for a belt with no sprite or no collar.
   * Read-only, plain numbers (T-14-FABRICO-RO).
   */
  collarCentresOn(id: number): Array<{ x: number; y: number }>;
  /**
   * THE DRAWN TILE RUN of one belt (plan 74.1-20, review WR-05): the tiles its current
   * geometry was built from, kinds included, or null for a belt with no sprite.
   *
   * The scene oracle reads the decoded packet, which is not what is drawn for the few
   * frames a just-drawn belt's seam is predicted (`pendingSeams.ts`), so "the seam was
   * drawn as a corner" needs a read of the layer's own record. A copy, no setter, no
   * Pixi ref.
   */
  drawnTilesOf(id: number): TileView[] | null;
  /**
   * THE DRAWN TREAD ROTATION at one cell (plan 89-03, BELT-10): the rotation, in radians, of
   * the tile display object the layer drew for the belt tile on `(cellX, cellY)`, read off
   * that object itself, or null when no drawn belt has a tile there. The native tread points
   * WEST, so 0 is a West-flowing tile, PI/2 North, PI East and 3PI/2 South (`tileRotation`).
   *
   * The scene oracle reads the decoded kind, and a kind can be right while the tile is drawn
   * the wrong way round; a live leg that grades which way a tile is DRAWN needs this. A
   * number, no setter, no Pixi ref.
   */
  treadRotationAt(cellX: number, cellY: number): number | null;
}

/**
 * Build the belt render layer against a single `activeSkin`. The layer owns an
 * instance-scoped `BeltContextCache` holding resolution-independent vector geometry,
 * so a tread tile is exact at ANY zoom rather than pixel-exact at one.
 */
export function createBeltLayer(
  activeSkin: Skin,
  // Instance-scoped texture cache.
  //
  // PLAN 61-03 EMPTIED IT: with the corner converted to vector, the belt layer bakes
  // NO texture and this cache never receives an entry. It is kept for two reasons and
  // neither is inertia. First, it is the SECOND positional parameter of a function
  // with six, and removing it would move every call site in the tree for a change with
  // no property behind it. Second, `setPainter` still routes a `destroyAll()` through
  // it, so a painter swap stays leak-safe for as long as the parameter can be handed a
  // populated cache by a caller this module does not control. `belts.test.ts` asserts
  // it stays at zero entries, which is a live statement rather than a dead one: a
  // reintroduced raster belt asset would redden it.
  cache: SynthTextureCache = new SynthTextureCache(),
  // Live camera zoom source (FLOW-03 LOD selection): a closure returning
  // `cam.worldScale()`, read fresh each draw so the chevron-vs-tick LOD cut tracks
  // the continuous zoom. Renderer-only - no scene/command/schema coupling; read
  // one-way, never written back to decode.ts, a GridCommand, or scene.tick
  // (T-31-DET). Defaulted so the untouched belts.test.ts call sites stay valid.
  scale: () => number = () => 1,
  // Live device-pixel quantum source (FLOW-06 tread snap): a closure returning
  // `renderer.resolution * cam.worldScale()` (DPR * zoom), read fresh each draw so
  // the tread's device-pixel snap tracks display density AND zoom. Same one-way
  // renderer-only discipline as `scale` and the item quantum.
  quantum: () => number = () => 1,
  // The belt LOOK (Phase 53): one frozen BeltPainter record carrying all four bakes
  // plus the three integers that define the march (phases K, quantum T, pitch).
  // This is the primary representation of "how a belt is painted"; SHIPPED_PAINTER
  // is one member of that set, not a privileged case. Defaulted so the untouched
  // belts.test.ts call sites stay valid, exactly like `scale` and `quantum` above.
  // Read one-way (painter -> texture bytes), never written back to decode.ts, a
  // GridCommand, or scene.tick (T-31-DET).
  initialPainter: BeltPainter = SHIPPED_PAINTER,
  // Instance-scoped belt GEOMETRY cache (VEC-01, plan 61-02): one shared
  // `GraphicsContext` per (kind, chirality, bucket), bound by every straight tile of
  // that key. Appended as the LAST parameter so no existing positional call site
  // moves. Defaulted to a real cache; injectable so a GPU-free unit test can read the
  // created / destroyed / live counters directly, exactly as `cache` above is.
  contexts: BeltContextCache = new BeltContextCache(),
  // Instance-scoped belt RAIL geometry cache (BELT-05, plan 61-09): one shared
  // `GraphicsContext` per rail family, plotted at the LIVE DEVICE QUANTUM and held at
  // that quantum only. Five entries per painter - 1 straight + 2 corner chiralities +
  // 2 corner LOD chiralities. Appended as the LAST parameter so no existing positional
  // call site moves, and injectable for the same reason `contexts` above is: a GPU-free
  // spec reads its created / destroyed / live counters directly.
  //
  // WHY A SECOND INSTANCE RATHER THAN A KEY PREFIX INSIDE `contexts`. **The two
  // families have different LIFETIMES.** A tread entry lives until the PAINTER changes;
  // a rail entry lives until the QUANTUM changes, which happens mid zoom gesture. One
  // store holding both would force a prefix scan on every zoom frame to find the
  // subset to evict, and would make `destroyAll` unable to express "free the rails and
  // keep the treads" at all. Two stores make each lifetime a whole-store operation.
  //
  // **THE QUANTUM IS A LIFETIME TERM AND NEVER A KEY TERM.** The rail keys are the same
  // three-segment `beltContextKey` join the tread keys are, with no quantum segment -
  // so the key contract stays literally true and the rail cache cannot GROW under a
  // zoom gesture, only be replaced. Keying the quantum in would make the key space
  // continuous and therefore unbounded (`beltContextCache.ts` records that arithmetic).
  railContexts: BeltContextCache = new BeltContextCache(),
): BeltLayer {
  const layer = new Container();
  const sprites = new Map<number, BeltSprite>();
  const skin = activeSkin;
  let painter = initialPainter;
  // The device-pixel quantum of the LAST draw. The per-frame tread snap (FLOW-06)
  // re-snaps every tile position only when `quantum()` changes, so a static zoom
  // costs nothing. Seeded NaN so the first draw always snaps (NaN !== any q).
  let lastQ = Number.NaN;

  // One tread CONTEXT per march bucket (MOTION-02, VEC-01): resolution-independent
  // vector geometry plotted at rot=0, the dash shifted along the flow axis by
  // `marchPhase`. Every straight tile of a given bucket binds one shared
  // `GraphicsContext` (adopted by IDENTITY - `61-SPIKE-FINDINGS.md` H7 case a2) and is
  // rotated per tile. The key is the three-segment `beltContextKey` join with the
  // painter id appended after it, per that function's own rule, so the cache saturates
  // at exactly `painter.phases` (K = 12) entries per painter - it NEVER grows on a static
  // scene, and it does NOT grow with belt count either (one context, many Graphics).
  const beltContext = (marchPhase: number): GraphicsContext =>
    contexts.get(`${beltContextKey('belt', 'none', marchPhase)}|${painter.id}`, () =>
      painter.straight(skin, marchPhase, CELL),
    ) as GraphicsContext;

  // FLOW-03 low-zoom LOD tick (SECOND context family): the bold static mark, selected
  // when scale*CELL < LOD_MIN_TREAD_PX. Its bucket segment is pinned at 0 because the
  // asset is phase-INDEPENDENT (one static mark, not animated) and direction stays a
  // per-tile ROTATION (never a cache key term), so the straight families cache at
  // exactly `painter.phases` + 1 entries per painter (Pitfall 6). A painter change
  // destroys the old entries via contexts.destroyAll first.
  const beltTickContext = (): GraphicsContext =>
    contexts.get(`${beltContextKey('belt-tick', 'none', 0)}|${painter.id}`, () =>
      painter.straightTick(skin, CELL),
    ) as GraphicsContext;

  // RENDER-02 low-zoom CORNER bend cue (plan 61-03: VECTOR, was a baked Texture):
  // below the raised LOD cut a corner tile falls back to this bent cue (a legible
  // bend) instead of the straight tick (which would lie about the turn). Chirality is
  // an ASSET variant (a mirror the per-tile 90deg rotation cannot reach), NOT the
  // per-tile orientation, so it is a cache key term here exactly like the full-zoom
  // corner family; phase-INDEPENDENT (one static asset per chirality), so its bucket
  // segment is pinned at 0. Adds at most 2 entries per painter.
  const beltCornerTickContext = (chirality: 'cw' | 'ccw'): GraphicsContext =>
    contexts.get(`${beltContextKey('belt-corner-tick', chirality, 0)}|${painter.id}`, () =>
      painter.cornerTick(skin, chirality, CELL),
    ) as GraphicsContext;

  // FLOW-05 corner family (THIRD/FOURTH context families; plan 61-03 moved it off the
  // texture cache): the rounded-elbow tread as arc-length vector geometry in one of two
  // chiralities, marching by `marchPhase` exactly like the straight. Keyed through the
  // SAME three-segment `beltContextKey` join with the painter id appended - chirality
  // is an asset variant, never the per-tile orientation (that stays a display-object
  // rotation). So the two chiralities add at most 2K entries per
  // painter; below the LOD cut corners reuse their chirality's single cue, keeping the
  // whole belt layer bounded at 3K + 3 = 39 entries per painter at the default K
  // (Pitfall 6). A setPainter destroys the old entries via contexts.destroyAll first.
  const beltCornerContext = (chirality: 'cw' | 'ccw', marchPhase: number): GraphicsContext =>
    contexts.get(`${beltContextKey('belt-corner', chirality, marchPhase)}|${painter.id}`, () =>
      painter.corner(skin, marchPhase, chirality, CELL),
    ) as GraphicsContext;

  // BELT-05 (plan 61-09): the RAIL family - the FIFTH cache family and the first one
  // that lives in `railContexts` rather than in `contexts`. One straight rail asset
  // serves the full-detail tile AND the LOD tick (the rails are a per-tile CHILD object
  // that the LOD cut does not switch), so this family adds exactly 1 entry per painter.
  //
  // The bucket segment is pinned at 0 because the rails are phase-INDEPENDENT, and
  // there is NO quantum segment: the live quantum is passed to the BUILD callback but
  // never to the KEY. What makes that sound is the eviction on `qChanged` below - the
  // whole rail cache is replaced when the quantum moves, so a key can never serve
  // geometry plotted at a stale quantum.
  const beltRailContext = (q: number): GraphicsContext =>
    railContexts.get(`${beltContextKey('belt-rail', 'none', 0)}|${painter.id}`, () =>
      painter.rails(skin, q),
    ) as GraphicsContext;

  // The CORNER rail families, one per chirality at each of the two sample counts - the
  // full-detail pair and the low-zoom pair. Chirality is an ASSET variant (a mirror the
  // per-tile quarter-turn cannot reach), so it is a key term here exactly as it is on
  // the corner tread; the LOD state is NOT a key term but a choice of family, which is
  // why these are two accessors rather than one with a boolean. **Together with the
  // straight rail that is 5 rail entries per painter - the whole rail ceiling.**
  const beltCornerRailContext = (chirality: 'cw' | 'ccw', q: number): GraphicsContext =>
    railContexts.get(`${beltContextKey('belt-corner-rail', chirality, 0)}|${painter.id}`, () =>
      painter.cornerRails(skin, q, chirality),
    ) as GraphicsContext;

  const beltCornerRailTickContext = (chirality: 'cw' | 'ccw', q: number): GraphicsContext =>
    railContexts.get(
      `${beltContextKey('belt-corner-rail-tick', chirality, 0)}|${painter.id}`,
      () => painter.cornerRailTick(skin, q, chirality),
    ) as GraphicsContext;

  /**
   * The whole-sprite rotation for one belt tile, ALWAYS a 90-degree multiple
   * (pixel-exact). The native tread chevron points WEST. STRAIGHTS share one
   * cardinal mapping - `dir` (N=0,E=1,S=2,W=3) -> ((dir + 1) mod 4) quarter-turns
   * from the native WEST (W->0, N->+90deg, E->+180deg, S->+270deg). CORNERS are
   * chirality-BRANCHED via `cornerQuarterTurns` (D-01): the cw bake keeps the
   * cardinal mapping ((to+1) mod 4), but the ccw bake is the cw bake's x-mirror
   * (native at to=E, not to=W), so its formula is ((to+3) mod 4) - the old
   * one-mapping-covers-everything claim put every ccw corner 180 degrees off (F2a).
   *   - Straight -> `dir = flowDirAt(tiles, i)`, the TRUE travel direction read
   *     from `tiles[]` adjacency. (FLOW-01: the old axis-only mapping dropped flow
   *     polarity, so an east-running belt showed WEST-pointing chevrons - the
   *     documented bug. Deriving from adjacency also makes straights and corners
   *     agree at every shared junction edge by construction.)
   *   - Corner -> `cornerQuarterTurns(from, to)` quarter turns (chirality branch).
   *     flowDirAt at a corner still equals its own `to`; for a cw corner the two
   *     paths are numerically identical, and a ccw corner legitimately differs
   *     from its neighbour straight by 180 degrees (mirrored texture) - junction
   *     agreement is visual (quadrant/flow), never raw rotation equality.
   *   - Lone straight (tiles.length === 1) -> `dir` from the tile's own `axis`, NOT
   *     flowDirAt: a single-tile belt has no adjacency, so `flowDirAt` returns its
   *     degenerate N(0) default and would point every 1-tile tread NORTH regardless
   *     of orientation. `beltItemPolyline` (interp.ts) derives the single-tile item
   *     flow from `Straight.axis` (axis 0 -> E, axis 1 -> S); mirror that exact
   *     convention here so the tread and the item dots agree on a lone straight
   *     (FLOW-01: treads and item dots agree by construction), fixing WR-01.
   */
  const tileRotation = (tile: TileView, i: number, tiles: TileView[]): number => {
    let dir: number;
    if ('Corner' in tile.kind && isTurningCorner(tile.kind)) {
      // D-01 chirality branch: cw keeps ((to+1)%4); ccw (the x-mirrored bake) needs
      // ((to+3)%4). Rotation stays a per-sprite transform - NEVER a bake variant or
      // cache-key term (cache boundedness, Pitfall 6).
      const { from, to } = tile.kind.Corner;
      return (cornerQuarterTurns(from, to) * Math.PI) / 2;
    } else if ('Corner' in tile.kind) {
      // A zero-turn corner (D-15) is a straight running along `from`: the seam table's way of
      // keeping a one-tile belt's flow direction, which `Straight.axis` cannot carry.
      dir = tile.kind.Corner.from;
    } else if (tiles.length === 1) {
      // No adjacency: axis 0 (horizontal) -> E(1), axis 1 (vertical) -> S(2), the
      // SAME mapping beltItemPolyline uses for its single-tile stub direction.
      dir = tile.kind.Straight.axis === 1 ? 2 : 1;
    } else {
      dir = flowDirAt(tiles, i);
    }
    return (((dir + 1) % 4) * Math.PI) / 2;
  };

  /**
   * Docked-end plug cap color, from the active skin (never a hue-only cue). A fault exit takes
   * the fault nub's own neutral (`machines.ts` `nubColor`, `ramp[3]`), so a docked fault exit
   * and a bare one read alike; its cap is told apart by its ring shape (CHROME-18, phase 92
   * D-06). Red on the board is a faulted machine's.
   */
  const plugCapColor = (role: number): number => {
    const { ramp } = skin.palette;
    if (role === PORT_ROLE.FAULT) return ramp[3]; // Fault exit - the fault nub's neutral
    if (role === PORT_ROLE.OUT) return ramp[ramp.length - 1]; // Out - brightest ramp step
    return ramp[ramp.length - 2]; // In / unknown - neutral ramp step
  };

  // Build the tile display objects ONCE per geometry change (geoKey-gated). The
  // per-frame swap in `draw` binds each of them to the current asset immediately
  // after, so nothing here needs a final asset - only the right TYPE.
  //
  // ONE TYPE, ONE CONTAINER (plan 61-03 completed the VEC-01 migration): EVERY tile -
  // straight and corner alike - is a `Graphics` bound to a shared `GraphicsContext`.
  // Plan 61-02 left corners as Sprites for exactly one wave so the corner digests and
  // the corner pixel baseline would break once rather than twice; they are vector now
  // and the belt layer constructs no `Sprite` at all. Each `Graphics` is constructed
  // WITH its context, so Pixi does not allocate an owned context for it and the cache
  // stays the sole owner of belt geometry.
  //
  // Each object keeps its own 90-degree rotation, so orientation (incl. corners)
  // survives every per-frame swap - the H7 spike measured `rotation` and `position`
  // byte-equal across a context assignment, which is what keeps MOTION-05
  // plot-once/rotate-many and the FLOW-06 snap from having to re-run on a bucket
  // change. Vector geometry is authored around the tile CENTRE, so no anchor is set on
  // either kind: the origin IS the centre (`beltGeometry.ts`, the unit story).
  //
  // `assetAt` is ONE callback rather than two (plan 61-04) because the march bucket is
  // a per-TILE quantity now: the caller owns the whole "which family at which bucket"
  // decision and this function owns only the display objects. Whatever it hands back is
  // replaced by the per-frame swap immediately afterwards, so its only real job is to
  // give Pixi a context at construction time - constructing a `Graphics` WITHOUT one
  // makes Pixi allocate an owned context and takes ownership of belt geometry away from
  // the cache.
  const rebuildTiles = (
    container: Container,
    tiles: TileView[],
    assetAt: (index: number, isCorner: boolean, chirality: 'cw' | 'ccw' | null) => GraphicsContext,
    // BELT-05 (plan 61-09): the tile's RAIL asset, resolved by the caller on exactly
    // the same terms as its tread. A separate callback rather than a second return
    // value from `assetAt`, so the tread call site is byte-unchanged.
    railAt: (index: number, isCorner: boolean, chirality: 'cw' | 'ccw' | null) => GraphicsContext,
  ): Pick<BeltSprite, 'centers' | 'kinds'> => {
    // DESTROY THE TILE'S CHILDREN WITH IT (plan 61-09). A bare `destroy()` used to be
    // right when a tile was one leaf object; a tile now carries a rail child, and a
    // bare call would ORPHAN it - a display object with no parent, no owner and no
    // counter watching it. `{ children: true }` and NOT `{ context: true }`: the
    // contexts belong to the two caches, which free them through their own teardown
    // paths (the H7 spike, case c2: a bare destroy spares an externally-supplied
    // context, which is exactly the property being relied on here).
    for (const child of container.removeChildren()) {
      (child as Container).destroy({ children: true });
    }
    const centers: BeltSprite['centers'] = [];
    const kinds: BeltSprite['kinds'] = [];
    tiles.forEach((t, i) => {
      // A zero-turn corner (D-15) takes the STRAIGHT tread and rail, not an elbow.
      const isCorner = isTurningCorner(t.kind);
      const chirality =
        'Corner' in t.kind && isCorner ? cornerChiralityOf(t.kind.Corner.from, t.kind.Corner.to) : null;
      // THE TILE IS A PLAIN `Container` HOLDING TWO `Graphics` (plan 61-09): the tread
      // at {@link TREAD_CHILD} and the rail at {@link RAIL_CHILD}. The OUTER object
      // keeps the rotation and the position, so the quarter-turn math and the FLOW-06
      // device-pixel position snap are untouched and do not re-run; both children
      // inherit them. Two display objects per tile, both batchable, both in the same
      // ink, and no `pixelLine` anywhere.
      //
      // **THE OUTER OBJECT IS A `Container` AND NOT A `Graphics`, AND PIXI REQUIRES
      // THAT.** Pixi 8 emits `addChild: Only Containers will be allowed to add children
      // in v8.0.0` when a view object (`Graphics` is one) is given children - a live
      // deprecation, found by reading the fixture's console rather than by assuming the
      // API. Hanging the rail off the tread `Graphics` would have shipped on a path
      // Pixi has announced it will remove.
      const node: Container = new Container();
      node.addChild(
        new Graphics(assetAt(i, isCorner, chirality)),
        new Graphics(railAt(i, isCorner, chirality)),
      );
      const c = tileCenter(t);
      node.position.set(c.x, c.y);
      centers.push({ x: c.x, y: c.y });
      // Tag the tile's kind (+ corner chirality) so the per-frame swap picks the
      // right asset family (FLOW-05) without re-reading belt.tiles.
      kinds.push({ corner: isCorner, chirality });
      // Index-aware: straights derive flow polarity from tiles[] adjacency (FLOW-01).
      node.rotation = tileRotation(t, i, tiles);
      container.addChild(node);
    });
    // Return the unsnapped centers + kind tags so the caller can device-pixel snap
    // (FLOW-06) and family-swap (FLOW-05) per frame without re-deriving geometry.
    return { centers, kinds };
  };

  const rebuildEnds = (
    g: Graphics,
    tiles: TileView[],
    head: EndAnchor | null,
    tail: EndAnchor | null,
    extraTails: readonly EndAnchor[] = [],
  ): void => {
    g.clear();
    // Docked-end termination (UI-SPEC section 2, REND-04): a plug connector from
    // the end tile center to the resolved nub center (a neutral ramp stem, cap
    // round) plus a role-colored end cap. Undocked or null-resolved ends draw
    // NOTHING extra - docked vs undocked stays visually distinct by contract.
    const stem = skin.palette.ramp[1]; // dark belt-body ramp step for the plug
    // FLOW-07 dominant role cap: the cap is now the belt-end's dominant element -
    // native radius CAP_R (6, was 2.5) so the role read (Out = the brightest ramp disc,
    // In = a neutral disc, Fault = a neutral RING around a core: shape carries the role,
    // and red belongs to a faulted machine) reads at a glance, floored to a MINIMUM on-screen
    // size via `CAP_R / Math.min(1, scale())` (the ports.ts nubHitRadiusWorld
    // screen-px-floor shape): at zoom >= 1 it stays 6 native (no ballooning at 4x),
    // below zoom 1 it grows in WORLD px so the on-screen role read survives 0.25x.
    const s = scale();
    // WR-03: guard scale 0 (Math.max floors it at MIN_SCALE) and ceiling the growth
    // (Math.min at CAP_R_MAX) so capR is always finite and never balloons past the lane,
    // the same cap discipline items.ts itemDotGrow uses. At/above zoom 1 -> CAP_R (6);
    // at the 0.25 min-zoom clamp -> CAP_R_MAX (24); below the clamp it stays at the ceiling.
    const capR = Math.min(CAP_R / Math.min(1, Math.max(s, MIN_SCALE)), CAP_R_MAX);
    // Device-pixel-snap the cap CENTER (FLOW-06 stability) with the live quantum, so
    // the dominant cap sits on the whole-device-pixel grid and never shimmers.
    const q = quantum();
    const ends: Array<[BeltEnd, EndAnchor | null]> = [
      ['Head', head],
      ['Tail', tail],
      // A fan-in Tail's further machine plugs, drawn the same way as its first.
      ...extraTails.map((a): [BeltEnd, EndAnchor | null] => ['Tail', a]),
    ];
    // The collar's ring radius, on the plug cap's OWN floor formula (74-UI-SPEC 2.1):
    // the same `Math.max(s, MIN_SCALE)` scale-0 guard and the same `Math.min` ceiling,
    // with the collar's derived numbers substituted for the cap's. No LOD: a junction
    // is a run-level fact and must survive zoom-out exactly as the plug cap does.
    const collarR = Math.min(NUB_RING_R / Math.min(1, Math.max(s, MIN_SCALE)), COLLAR_R_MAX);
    for (const [end, anchor] of ends) {
      if (!anchor) continue;
      if (anchor.kind === 'belt-seam') {
        // THE OWNERSHIP RULE (74-UI-SPEC 2.3), and it is a correctness requirement
        // rather than a preference. A belt-to-belt dock is drawn by the belt whose end
        // carries the `Out` ROLE - which is the Head - and the downstream belt's Tail
        // dock naming the same link draws NOTHING. `render_packet.rs` projects the dock
        // from BOTH sides and the loop below resolves both ends of both belts every
        // frame, so without this the seam gets two collars a whole cell apart, one in
        // each end tile centre. Stated as a property of the ROLE, not as a special case
        // for belts, so it stays true for whatever docks to a belt next.
        if (end !== 'Head') continue;
        // NO STEM. The plug stem exists to bridge the gap between a tile centre and a
        // machine nub; two abutting belt tiles have no gap to bridge.
        //
        // Snapped with the LIVE quantum through the same `snapToDevicePixel` the cap
        // uses, so the collar lands on the same physical pixel the cap would.
        const sx = snapToDevicePixel(anchor.x, q);
        const sy = snapToDevicePixel(anchor.y, q);
        // A grommet: the ground-coloured disc first, the bright ring stroked on its
        // edge second. The disc is the substrate an item dot crosses (items ride a
        // layer ABOVE belts), which is the whole reason it is `ramp[0]` and not the
        // cap's `ramp[4]`. Both colours are read off `skin`, never a hex, exactly as
        // the stem above reads `ramp[1]`.
        g.circle(sx, sy, collarDiscR(collarR)).fill(skin.palette.ramp[0]);
        g.circle(sx, sy, collarR).stroke({
          width: NUB_RING_STROKE,
          color: skin.palette.ramp[4],
          alpha: 1,
        });
        continue;
      }
      // A ONE-TILE BELT DRAWS NO STEM (phase 89 UI review UI-04, UI-SPEC section 7). The stem
      // runs from the end tile's centre to the nub; on a one-tile belt both ends share that one
      // tile, so the two 8 px stems covered its whole centreline and hid the tread, whose dashes
      // march the way the belt flows: a West and an East one-tile belt looked identical. The tile
      // itself reaches from nub to nub, so there is no gap for a stem to bridge; the role caps
      // stay, and the tread shows between them.
      if (tiles.length > 1) {
        const [cx, cy] = beltEndCell(tiles, end);
        g.moveTo(cx * CELL + HALF, cy * CELL + HALF)
          .lineTo(anchor.x, anchor.y)
          .stroke({ width: 8, color: stem, alpha: 1, cap: 'round' });
      }
      // Dominant role cap, colour STRICTLY from plugCapColor (never a hex), center
      // snapped to the device grid. Undocked ends already `continue`d above (neutral
      // terminus - no fabricated role). In and Out caps are solid discs; a fault-exit cap
      // is the fault nub's annulus at cap size: a ring at r = capR stroked capR / 3 around
      // a core disc of r = capR / 3, both the fault nub's neutral (UI-SPEC 3.1).
      const cx = snapToDevicePixel(anchor.x, q);
      const cy = snapToDevicePixel(anchor.y, q);
      if (anchor.role === PORT_ROLE.FAULT) {
        const ink = plugCapColor(anchor.role);
        g.circle(cx, cy, capR).stroke({ width: capR / 3, color: ink, alpha: 1 });
        g.circle(cx, cy, capR / 3).fill(ink);
      } else {
        g.circle(cx, cy, capR).fill(plugCapColor(anchor.role));
      }
    }
  };

  const tilesKey = (tiles: TileView[]): string =>
    tiles
      .map((t) =>
        'Corner' in t.kind
          ? `${t.cell_x},${t.cell_y}C${t.kind.Corner.from},${t.kind.Corner.to}`
          : `${t.cell_x},${t.cell_y}S${t.kind.Straight.axis}`,
      )
      .join(';');


  // Belts already warned for having no tiles (one warn per belt id, not per
  // frame) - a regression TRIPWIRE, not a code path (D-06, REND-03).
  const warnedEmpty = new Set<number>();

  const draw = (
    scene: SceneState,
    frame: number,
    // The RAW render clock in sim-tick units. Defaulted from `frame` so every
    // existing 2-argument caller is byte-exact.
    clock: number = frame * SIM_TICKS_PER_FRAME,
    // SLOT-03 (D-18): the pre-Phase-62 tread-appearance override. NULL in every shipped
    // build, so a 2- or 3-argument caller is byte-exact too. See `beltPxPerTick`.
    treadPxPerTickOverride: number | null = null,
  ): void => {
    // MOTION-02: one texture per draw, shared by every tile of every belt. `frame`
    // selects ONLY the march-phase chevron (via the frame-keyed cache); the geoKey
    // below stays frame-free so tiles are never destroyed/recreated per frame
    // (Pitfall 1 - the belt allocation/GC storm).
    //
    // FLOW-03 LOD hard-cut: read the live zoom and pick the family by a SINGLE
    // inclusive threshold. At scale*CELL >= 16 the marching chevron; below it the
    // bold single-tick bake (the fine chevron would smear at low zoom). No
    // hysteresis - one cut, exactly like the Phase-29 grid minor-line LOD.
    //
    // THE MARCH CLOCK (plan 61-04). The bucket is a pure function of the render clock
    // IN SIM-TICK UNITS, the tile's own tail-relative offset and the painter's bucket
    // count - and of nothing else. `frame` no longer selects the tread at all; it stays
    // in the signature because the layer's callers pass it and the machine layer still
    // rides it. NOTHING here may read `performance.now()` or `Date.now()`: the march is
    // replayable precisely because its only input is the designated clock (T-61-13).
    //
    // T IS A CLOCK QUANTIZER NOW, NOT A PHASE DIVISOR. At the shipped `quantum` of 1
    // the clock passes through untouched, so the march advances every sim tick. A
    // painter with T above 1 holds each bucket for T ticks - which is exactly what the
    // retired 10fps strobe was - so the field keeps a real meaning rather than
    // degenerating into a vestigial 1.
    //
    // THE RESYNC LURCH IS PUBLISHED, NOT DISCOVERED. This layer's own rule is that any
    // painter proposing a sub-6 quantum must publish a lurch metric beside its speed
    // (53-03), rather than presenting the speed gain alone. Quantum 1 is that painter
    // and `marchResyncLurchPx` is that metric, quoted PER BELT since Phase 62 (D-05):
    // it is the belt's own px-per-tick times the gap, so it SHRINKS at a slower tread.
    // `MARCH_RESYNC_LURCH_PX_WORST_CASE` is the bound the aliasing clamp puts on it -
    // 8.00px, exactly half the dash period, the maximally direction-ambiguous
    // displacement - accepted rather than fixed, with both rejected fixes named there.
    const clockTicks =
      painter.quantum > 1 ? Math.floor(clock / painter.quantum) * painter.quantum : clock;
    const full = scale() * CELL >= LOD_MIN_TREAD_PX;
    // FLOW-06 device-pixel tread snap: read the live quantum (DPR * zoom). Only when
    // it changes do we re-snap tile positions (per-frame reposition pass, gated on q
    // NOT on geoKey - Pitfall 3 - so it fires on zoom change even with static
    // geometry). A freshly rebuilt belt is also snapped below regardless of qChanged.
    //
    // READ BEFORE THE ASSET CLOSURES as of plan 61-09, because the RAIL family is a
    // function of this quantum. Seeded NaN, so the first draw always counts as a change.
    const q = quantum();
    const qChanged = q !== lastQ;
    // BELT-05 (plan 61-09) - THE RAIL GENERATION SWAP, AND ITS ORDER IS LOAD-BEARING.
    // On a quantum change the previous generation is TAKEN (removed from the cache,
    // NOT freed). The lazy `railAsset` below then plots the new generation and every
    // tile is rebound to it in the per-frame loop; only after all of that does the
    // `release` at the foot of this function free what was taken. Freeing first would
    // leave every live tile pointing at freed geometry for exactly one frame, which
    // surfaces as a null GPU resource and not as a thrown error. Both orderings leave
    // the same tidy end state, so `belts.test.ts` asserts this AT THE MOMENT OF THE
    // FREE - the same discipline it already applies to `setPainter`.
    const staleRails = qChanged ? railContexts.takeAll() : [];
    // THE STRAIGHT ASSET IS RESOLVED LAZILY, AND THAT IS THE EMPTY-STATE CONTRACT
    // (61-UI-SPEC UI Considerations, "canvas belt layer: a board with ZERO belts").
    // Resolving it here unconditionally - as the old texture line did - would plot a
    // context for a board that has no belts on it, so a first-run empty board would
    // silently carry belt geometry it never draws. Memoised per draw, so many belts
    // still share ONE plot and one cache lookup.
    //
    // MEMOISED PER (FAMILY, BUCKET) rather than per family, because the bucket is now a
    // per-TILE quantity: a belt whose run crosses a corner draws two different buckets
    // on the same frame. Below the LOD cut every tile of a family shares ONE
    // phase-independent asset, so the memo key collapses to a single slot there and the
    // whole lane still costs one plot.
    const straightMemo = new Map<number, GraphicsContext>();
    const straightAsset = (bucket: number): GraphicsContext => {
      const key = full ? bucket : -1;
      let ctx = straightMemo.get(key);
      if (ctx === undefined) {
        ctx = full ? beltContext(bucket) : beltTickContext();
        straightMemo.set(key, ctx);
      }
      return ctx;
    };
    // The corner asset is resolved lazily per chirality for the SAME empty-state
    // reason, and memoised per draw so a lane with twelve corners at one bucket still
    // costs one plot and one cache lookup per chirality. A board with no corner on it
    // plots no corner geometry at all - which a board of pure straights routinely is.
    const cornerMemo = new Map<string, GraphicsContext>();
    const cornerAsset = (chirality: 'cw' | 'ccw', bucket: number): GraphicsContext => {
      const key = `${chirality}|${full ? bucket : -1}`;
      let ctx = cornerMemo.get(key);
      if (ctx === undefined) {
        ctx = full ? beltCornerContext(chirality, bucket) : beltCornerTickContext(chirality);
        cornerMemo.set(key, ctx);
      }
      return ctx;
    };
    // The RAIL asset, memoised per draw exactly as the tread families are, and lazy for
    // the SAME empty-state reason: a board with no belts on it must plot no belt
    // geometry at all. One straight rail asset serves every straight tile at every
    // bucket and at both LOD states, so a whole lane costs one plot and one lookup.
    const railMemo = new Map<string, GraphicsContext>();
    const railAsset = (isCorner: boolean, chirality: 'cw' | 'ccw' | null): GraphicsContext => {
      const key = isCorner ? `corner|${chirality}|${full ? 1 : 0}` : 'straight';
      let ctx = railMemo.get(key);
      if (ctx === undefined) {
        // The corner rail follows the SAME LOD cut the corner tread reads, so a zoom
        // past the cut swaps both halves of the tile together and the lane can never be
        // drawn at one detail level while its tread is at the other.
        ctx = isCorner
          ? full
            ? beltCornerRailContext(chirality as 'cw' | 'ccw', q)
            : beltCornerRailTickContext(chirality as 'cw' | 'ccw', q)
          : beltRailContext(q);
        railMemo.set(key, ctx);
      }
      return ctx;
    };
    for (const [handle, sprite] of sprites) {
      if (!scene.belts.has(handle)) {
        layer.removeChild(sprite.root);
        sprite.root.destroy({ children: true });
        sprites.delete(handle);
      }
    }
    for (const belt of scene.belts.values()) {
      if (belt.tiles.length === 0) {
        // Post-P20 every belt is DrawBelt-minted with tiles >= 1, so this branch
        // surfaces future regressions instead of hiding them behind a degenerate
        // render (clean break - the one-cell-east fallback is gone).
        //
        // DROP THE SPRITE, DO NOT MERELY WARN (phase-61 review, IN-05). A belt still
        // present in `scene.belts` but with zero tiles used to keep its existing
        // `sprite.tiles.children`, neither rebound below nor destroyed - so on the next
        // quantum change their rail children still pointed at a `GraphicsContext` that
        // `release` had already destroyed. That turns this loud regression tripwire into
        // a silent GPU-level fault at exactly the moment it fires, which is the one
        // moment it needs to stay legible. The sprite is torn down the same way the
        // gone-from-scene pass above does it, so the belt simply has no geometry until
        // it has tiles again.
        const dead = sprites.get(belt.id);
        if (dead !== undefined) {
          layer.removeChild(dead.root);
          dead.root.destroy({ children: true });
          sprites.delete(belt.id);
        }
        if (!warnedEmpty.has(belt.id)) {
          warnedEmpty.add(belt.id);
          console.warn(
            `belt ${belt.id}: no tiles, skipping render (impossible post-P20 DrawBelt mint)`,
          );
        }
        continue;
      }
      let sprite = sprites.get(belt.id);
      if (!sprite) {
        const root = new Container();
        const tiles = new Container();
        const ends = new Graphics();
        root.addChild(tiles, ends);
        sprite = { root, tiles, ends, geoKey: '', centers: [], kinds: [], offsets: [], drawn: [] };
        sprites.set(belt.id, sprite);
        layer.addChild(root);
      }
      // Per-end dock anchors are resolved EVERY frame and folded into the geometry
      // cache key as resolved positions + roles - NOT merely the dock tuples.
      // Load-bearing: a Rotate that KEEPS a dock moves the port's world cell
      // without changing the BeltDockView values; keying on the docks alone would
      // leave the plug pointing at the stale nub. The key's terms are the tile run,
      // both resolved end anchors and the coarse zoom bucket - and nothing else.
      const head = resolveEndAnchor(scene.nodes, scene.belts, belt, 'Head');
      const tail = resolveEndAnchor(scene.nodes, scene.belts, belt, 'Tail');
      const extraTails = resolveExtraTailAnchors(scene.nodes, belt);
      // geoKey is deliberately frame-FREE (no marchPhase term): it gates the
      // destroy/recreate `rebuildTiles`, which must fire ONLY on a real geometry
      // change, never per animation frame. It folds a COARSE zoom bucket (FLOW-07)
      // so the floored dock cap re-draws when its on-screen radius would change
      // (`CAP_R / Math.min(1, scale)` only varies below zoom 1). Coarse (0.05 steps,
      // clamped at 1) so a static or above-1 zoom never re-runs rebuildEnds, and a
      // slow zoom-out redraws the cap in a bounded number of steps - NOT per frame.
      const capBucket = Math.round(Math.min(1, scale()) * 20);
      // THE TILES TO DRAW (plan 74.1-20, review WR-05). For the few frames between a
      // release and the echo of its follow-up Dock, the packet carries route()'s
      // stored Straight at the seam because the link does not exist yet; the preview
      // showed the corner, so the belt is drawn with the preview's seam kinds until the
      // dock lands, the follow-up TTL passes, a keyframe arrives or a later draw with
      // exactly the same cells replaces it (`pendingSeams.ts`, one record per belt since
      // plan 74.1-30). Read HERE, in the renderer, and nowhere on
      // the decode path: `belt` and the scene are never altered. It enters the geoKey
      // through `tilesKey`, so the geometry rebuilds the frame the prediction clears.
      const tilesToDraw = pendingSeamTiles(belt, scene.tick) ?? belt.tiles;
      const geoKey = `T:${tilesKey(tilesToDraw)}|H:${anchorKey(head)}|TL:${anchorKey(tail)}|TX:${extraTails.map(anchorKey).join(';')}|CB:${capBucket}`;
      let rebuilt = false;
      if (geoKey !== sprite.geoKey) {
        // BELT-02: the accumulator runs HERE, on the geoKey-gated rebuild, ONCE per
        // real geometry change - and nowhere else in this file. A tile's tail offset is
        // pure topology, so it cannot move without `belt.tiles` moving, and `belt.tiles`
        // is a geoKey term. Running it in the per-frame loop instead would re-derive an
        // unchanging array sixty times a second per belt on a completely static board.
        const offsets = tailOffsets(tilesToDraw);
        // SLOT-03: this belt's OWN march advance, off the wire (see beltPxPerTick).
        const pxPerTick = beltPxPerTick(belt, treadPxPerTickOverride);
        const built = rebuildTiles(
          sprite.tiles,
          tilesToDraw,
          (i, isCorner, chirality) => {
            const bucket = bucketOf(clockTicks, offsets[i], painter.phases, pxPerTick);
            return isCorner
              ? cornerAsset(chirality as 'cw' | 'ccw', bucket)
              : straightAsset(bucket);
          },
          (_i, isCorner, chirality) => railAsset(isCorner, chirality),
        );
        sprite.centers = built.centers;
        sprite.kinds = built.kinds;
        sprite.offsets = offsets;
        sprite.drawn = tilesToDraw;
        rebuildEnds(sprite.ends, tilesToDraw, head, tail, extraTails);
        sprite.geoKey = geoKey;
        rebuilt = true;
      } else if (qChanged) {
        // FLOW-06/WR-02 cap re-snap: the dominant dock cap center is device-pixel
        // snapped (with the live quantum) ONLY inside rebuildEnds, which runs on a
        // geoKey change. But geoKey folds `capBucket = round(min(1, scale)*20)`, pinned
        // at 20 for every zoom >= 1, so a zoom-IN past 1x never changes geoKey and the
        // cap would hold the quantum captured at the last rebuild and shimmer under a
        // zoom gesture. Redraw the ends here on a quantum change - cheap (two stems +
        // <=2 caps, NOT the tile destroy/recreate) - mirroring the per-frame tread
        // re-snap below so the cap stays device-pixel stable at ALL zoom levels.
        rebuildEnds(sprite.ends, sprite.drawn, head, tail, extraTails);
      }
      // Per-frame march: a cheap ASSET HANDLE swap on every EXISTING tile object (no
      // display object is created or destroyed here). Each tile keeps its own
      // rotation, so the tread marches = flow, correctly oriented through corners.
      //
      // ROTATION IS NECESSARY AND WAS NOT SUFFICIENT, which is what this line used to
      // imply. A whole-sprite quarter turn carries the ink's DIRECTION along with the
      // shape, so it can only be right if the emitter got the direction right in the
      // tile's own frame - and from plan 61-03 until Phase 62 `cornerCommands` did not,
      // so every corner on the shipped build marched its tread backwards under a
      // perfectly correct rotation. The direction now has a signed gate of its own in
      // `beltGeometry.test.ts`; this comment is about orientation only.
      // This is the exact machine-layer template (machines.ts per-frame
      // `sprite.texture =`), and on the vector half it is the one-for-one conversion
      // the H7 spike licensed: `sprite.texture = t` becomes `graphics.context = ctx`,
      // a LIVE swap that adopts by identity, preserves rotation/position byte-equal
      // and frees nothing (`61-SPIKE-FINDINGS.md`, VERDICT: LIVE-SWAP CONFIRMED).
      // Because no instance is constructed on this path, the frame-free `geoKey` gate
      // above keeps doing exactly the job it was built for and there is no churn
      // budget to find.
      //
      // The swap is PER-TILE-KIND (FLOW-05): a straight tile pulls the LOD-selected
      // straight context; a corner tile pulls its chirality's elbow context at this
      // phase, and below the LOD cut falls back to that chirality's BEND cue
      // (RENDER-02) - NOT the straight tick, which would read as a straight run
      // through the bend. Direction stays a per-tile rotation, so a zoom past the cut
      // swaps the whole lane's family with zero object churn. Both kinds take the same
      // `context =` setter now (plan 61-03), so there is one swap idiom on this path.
      const children = sprite.tiles.children;
      // SLOT-03: this belt's OWN march advance, off the wire (see beltPxPerTick). Hoisted
      // out of the tile loop - it is a property of the BELT, not of the tile, and every
      // tile on this belt walks the shared buckets at this one rate.
      const framePxPerTick = beltPxPerTick(belt, treadPxPerTickOverride);
      for (let i = 0; i < children.length; i++) {
        const kind = sprite.kinds[i];
        // BELT-02: the tile's OWN bucket, from the clock and its OWN tail offset. This
        // reads the offsets array; it does not build one. The accumulator ran on the
        // geoKey rebuild, because a tile's offset is pure topology and cannot move
        // without the tile run moving.
        const bucket = bucketOf(clockTicks, sprite.offsets[i], painter.phases, framePxPerTick);
        const parts = (children[i] as Container).children;
        (parts[TREAD_CHILD] as Graphics).context = kind.corner
          ? cornerAsset(kind.chirality as 'cw' | 'ccw', bucket)
          : straightAsset(bucket);
        // BELT-05 (plan 61-09): rebind the tile's RAIL child on the same per-frame
        // path, by the same live `context =` assignment. This IS the rebind half of
        // the plot-new / rebind / free-old order: by the time `release` runs at the
        // foot of this function, every holder in the scene has been moved onto the
        // new generation. Constructing and destroying nothing, exactly like the tread.
        (parts[RAIL_CHILD] as Graphics).context = railAsset(kind.corner, kind.chirality);
      }
      // FLOW-06 device-pixel tread snap pass: re-seat each tile object onto the
      // whole-device-pixel grid from its UNSNAPPED center. Runs when the quantum
      // changed (fractional pan/zoom) OR the belt was just rebuilt at this quantum,
      // so treads never crawl/beat and a fresh belt is snapped immediately. 90-degree
      // rotations are untouched (exact); this only moves positions (T-31-DET: one-way,
      // never written back to decode.ts / a GridCommand / scene.tick). Typed to
      // `Container` because a tile is now a Sprite OR a Graphics and `position` is a
      // property of neither in particular - it belongs to the display object.
      if (qChanged || rebuilt) {
        const children = sprite.tiles.children;
        for (let i = 0; i < children.length; i++) {
          const c = sprite.centers[i];
          (children[i] as Container).position.set(
            snapToDevicePixel(c.x, q),
            snapToDevicePixel(c.y, q),
          );
        }
      }
    }
    // FREE LAST. Every rail holder in the scene has been rebound above, so nothing
    // points at the previous generation any more. A no-op on every frame that did not
    // change the quantum, which is every frame of a static or paused camera.
    //
    // NOT IN A `finally`, AND THAT IS AN ACCEPTED GAP RATHER THAN AN OVERSIGHT (raised
    // by the phase-61 review, IN-04). A throw between the `takeAll` above and this line
    // would leave the taken generation unreferenced and undestroyed and leave `lastQ`
    // stale, so `live` would over-report from then on - the one number this cache exists
    // to keep honest. The only plausible thrower in between is `assertVertexBudget`
    // inside `buildBeltContext` (`beltPainter.ts`), which is DEV-gated, so the gap is
    // unreachable in a shipped build. It is left explicit rather than papered over with
    // a `try`/`finally` wrap of a ~200-line body: the wrap is the right fix and it wants
    // its own scoped change, because reindenting the whole draw path inside a review
    // sweep buys a diff nobody can read for a leak counter no user can reach.
    if (staleRails.length > 0) railContexts.release(staleRails);
    // Commit the quantum AFTER every belt has been snapped for this frame.
    lastQ = q;
  };

  /**
   * Phase 53 painter swap.
   *
   * The teardown order matters: drop every belt root FIRST
   * so no tread object still references an asset we are about to destroy, then
   * route the free through `cache.destroyAll()` / `contexts.destroyAll()` and NEVER a
   * bare `texture.destroy()` (which leaks the Pixi v8 GPU source - Pitfall 4).
   *
   * THE ORDER IS NOT RELAXED BY THE H7 SPIKE. Its case c2 found that a BARE
   * `Graphics.destroy()` spares an externally-supplied context - which is what makes
   * dropping the roots safe. It did NOT find that order stopped mattering:
   * `contexts.destroyAll()` frees the contexts EXPLICITLY, so a root still holding one
   * would be pointing at freed geometry on the very next frame. Roots first, caches
   * second, always. `belts.test.ts` asserts that ORDER, not merely the end state.
   *
   * The SAME cache instances are reused rather than replaced, so their
   * created/destroyed counters keep accumulating and stay honest across swaps; a fresh
   * cache per swap would silently reset the leak evidence. This covers ALL four belt
   * families at once, because the painter id is a term in every one of their keys. The
   * next draw re-plots lazily under `next`.
   */
  const setPainter = (next: BeltPainter): void => {
    for (const [, sprite] of sprites) {
      layer.removeChild(sprite.root);
      sprite.root.destroy({ children: true });
    }
    sprites.clear();
    cache.destroyAll();
    contexts.destroyAll();
    // BELT-05 (plan 61-09): the RAIL cache is torn down inside THIS one regeneration
    // path too. A bucket-count change routes through `setPainter`, and the painter id
    // is a term in every rail key as well as every tread key - so a swap that freed only
    // the tread contexts would leave five rail entries keyed to a painter that no longer
    // exists. One path, both caches.
    railContexts.destroyAll();
    painter = next;
  };

  return {
    layer,
    draw,
    setPainter,
    // Straight off the live Graphics, keeping no set - see the interface docblock.
    // `sprites` already holds the belt's `ends` object, so there is no bookkeeping
    // that could drift from the plot because there is no bookkeeping.
    endInstructionsOn: (id: number) => sprites.get(id)?.ends.context.instructions.length ?? 0,
    collarCentresOn: (id: number) => {
      const ends = sprites.get(id)?.ends;
      return ends ? plottedCircles(ends).filter((c) => c.action === 'stroke').map((c) => ({ x: c.x, y: c.y })) : [];
    },
    drawnTilesOf: (id: number) => {
      const sprite = sprites.get(id);
      return sprite ? sprite.drawn.map((t) => ({ ...t })) : null;
    },
    // Off the tile object `rebuildTiles` built, index-aligned with `drawn`: the rotation the
    // canvas shows, not a recomputation of it.
    treadRotationAt: (cellX: number, cellY: number) => {
      for (const sprite of sprites.values()) {
        const i = sprite.drawn.findIndex((t) => t.cell_x === cellX && t.cell_y === cellY);
        const node = i >= 0 ? sprite.tiles.children[i] : undefined;
        if (node !== undefined) return node.rotation;
      }
      return null;
    },
  };
}
