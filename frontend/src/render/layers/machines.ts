// The machine layer (UI-SPEC "Machine vocabulary" + "Machine state animation").
//
// ABOVE THE LOD CUT EVERY MACHINE IS VECTOR (ART-01, plan 58-03). One rotated
// `body` Container per node holding a parametric chassis outline drawn in code
// (`machineChassis.ts`) plus the kind's authored glyph, which SHARES one
// process-wide tessellated `GraphicsContext` with every other machine of that kind
// (VEC-04). No machine body is baked into a texture on this path: `machines.ts`
// imports no generator and no fault overlay, and a machine above the cut produces
// zero cache entries.
//
// BELOW THE CUT the pixel path survives, unchanged and deliberately: a solid
// kind-tinted, state-pipped `lodTints.ts` block on a Sprite, because a 2u vector
// stroke measures under one device pixel down there and DISAPPEARS rather than
// degrading (see LOD_MIN_MACHINE_PX). The ENDPOINT has no LOD tint, so since 66-03 it
// takes a separate PRESENCE BLOCK in the structural ink instead of a kind-tinted one -
// it drew nothing at all down there before; the reasoning is on LOD_MIN_MACHINE_PX.
//
// THE STATE CHANNEL (58-UI-SPEC "The State Contract on an Open Chassis"). Axis 3
// locks an OPEN chassis, so the pixel era's two state cues both lost their home:
// there is no body to tint and no body to hold a fault marker. State moves onto the
// chassis OUTLINE (`chassisInk`), and because colour alone cannot carry it there - a
// WORKING outline against an IDLE one measures 1.02 : 1 in greyscale - each non-idle
// state ALSO carries a mandatory non-colour cue, both drawn by `machineState.ts`:
//   WORKING  a dark `ramp[0]` notch travelling the chassis perimeter (an 8.4 : 1
//            substrate-versus-ink step that survives the colour channel being deleted).
//   FAULTED  a board-drawn alert ring at the style-bible section 4 cadence - shape
//            plus time, both colour-independent, which is the VIS-03 floor the
//            retired baked 2x2 corner marker used to hold inside the body.
//   BACKED_UP a still LOAD GAUGE floating 9.000 .. 12.000 px above the box top edge: a
//            run of up to four `ramp[4]` ticks that closes into ONE solid bar at full
//            load. THREE cues now, separated on plane, polarity and motion - the full
//            argument is in `machineState.ts`'s header, which this comment summarises.
//            The outline dims to `ramp[3]` underneath it (3.285 : 1 against idle).
//
// MOTION-05 holds by construction on every one of those paths: chassis and ring
// geometry are plotted ONLY inside the identity/state/footprint/orientation signature
// guard, and the notch is plotted ONCE at construction. Per frame the notch is MOVED
// by transform and the ring's `.alpha` changes - nothing clears and nothing
// re-tessellates, so the keyframe repaint flash (Load / Undo) is structurally
// impossible.
//
// The port-nub overlay is unchanged: nubs are drawn per-machine from the
// authoritative wire ports[] (localNubSpecs) and recolored to the active skin.

import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { CELL } from '../../../shared/geometry';
import { machine_kind, state_tag, type StateTag } from '../../protocol/kinds';
import { effectiveBox } from '../../protocol/footprint';
import {
  localNubSpecs,
  MEDIUM_ELECTRICAL,
  NUB_ELECTRICAL_HALF,
  NUB_FAULT_CORE_R,
  NUB_FAULT_RING_R,
  NUB_R,
  NUB_STEM,
  NUB_STROKE,
  type NubSpec,
  PORT_ROLE,
} from '../../protocol/ports';
import { type GenKey } from '../synth/generators';
import { makeEndpointPresenceBlock, makeLodBlocks } from './lodTints';
import { SynthTextureCache, cacheKey, matrixToTexture, type MakeTexture } from '../synth/textureCache';
import { getAssetBox, getAssetContext, peekAssetContext, type AssetName } from '../svgAssets';
import { CHASSIS_INSET_U, drawChassis, uToPx } from './machineChassis';
import { glyphFit } from './glyphFit';
import { MIN_CABLE_SCREEN_PX } from './wires';
import {
  alertRingAlpha,
  drawAlertRing,
  drawLoadGauge,
  gaugeInk,
  GAUGE_OUTSET_U,
  GAUGE_RUN_U,
  GAUGE_THICK_U,
  drawNotch,
  notchOffset,
  resolveNotch,
} from './machineState';
import { LABEL_COLOURS, type Skin } from '../synth/skin';
import type { SceneState } from '../sceneState';
import type { NodeView } from '../../protocol/decode';

// READ-05 LOD hard-cut (UI-SPEC "READ-05"). Below this many on-screen device px per
// cell (`worldScale() * CELL`) a machine swaps to a solid kind-tinted, state-pipped
// LOD block (lodTints.ts) instead of its full-detail body. A SINGLE inclusive
// threshold, no hysteresis, in the family of the 29-02 grid minor-line cut (10) and
// the 31-06 belt tread cut (16).
//
// 12 -> 16 IN PLAN 58-01, AND THE REASON IS A DIFFERENT REASON. 12 was calibrated for
// the pixel bake, where the failure below the cut was a body-scaled glyph going
// sub-pixel: a bit matrix DEGRADES, resampling into an undifferentiated grey smear.
// The vector body does not degrade - it DISAPPEARS. Device px per cell is
// `zoom * DPR * CELL`, and a `u` is `1/32` of a cell, so a 2u detail stroke measures
// `2 * P / 32 = P / 16` device px at `P` px per cell. That reaches exactly 1.0 device
// px at `P = 16`. Between 12 and 16 a 2u stroke is 0.75 to 1.0 px, and with
// `antialias: false` (the maintainer's stated visual judgement, 2026-07-31) a stroke that thin
// misses most pixel centres: it rasterises as a dotted line or vanishes entirely.
// A smear is bad art; a vanishing machine is a missing machine.
//
// The arithmetic is not restated as a literal anywhere. `machineVector.test.ts`
// DERIVES the detail-stroke device width at this cut from `LOCKED_SKIN.strokeDetail`
// and this exported constant and requires it to be at least 1.0, so the cut and the
// stroke weight can never drift apart again - a later change to EITHER one reddens.
//
// ENDPOINT BELOW THE CUT DRAWS A PRESENCE BLOCK, AND THE ROUTE AROUND THE ALTERNATIVE
// IS THE WHOLE POINT (66-03, WIRE-03). It drew NOTHING here from 58-03 until then, which
// was a stated decision at the time and stopped being tenable the moment Phase 66 made
// endpoints placeable by hand: a machine the user just placed vanishing on zoom-out is
// not a narrowed absence, it is a missing machine.
//
// IT IS STILL NOT A NINTH KIND, and both halves of that cost are measured. `LOD_TINTS`
// holds exactly EIGHT entries and kind 9 is not among the keys they serve. (`GEN_KEY_OF`
// held eight too until plan 72-09 added HANDLER as a declared FACTORY alias; the alias
// takes an existing hue, so the count below is the LOD table's, not the keyspace's.)
// They stay at eight deliberately: those eight tints are the eight hues the maintainer was shown and gated on
// 2026-08-01 (three re-hued by the phase 92 review, `lodTints.ts`), and minting a ninth would put an
// unjudged colour on the board.
// And `LOD_KIND_CODES` is a SATURATED three-bit space - all eight code points taken, the
// top-left corner reserved for the state pip - so there is no ninth code and no fourth
// corner to widen into. A ninth kind sharing a code is not a cosmetic compromise: it
// defeats the one cue `lodTints.ts` measured to survive the colour-vision transforms.
//
// So the endpoint takes `ramp[4]`, the structural ink its own outline already draws in
// above the cut, at the same block geometry, with the same state pip, and with NO corner
// code (an uncut square). A host bridge is not one of the eight machine families and the
// neutral ink says so. THIS DOES NOT REOPEN ART-02 OR AXIS 9 and must not be cited as
// though it did: a sub-pixel presence fallback is not a kind-hue encoding. The block is
// baked by `makeEndpointPresenceBlock`, which carries the same warning.
//
// The two-keyspace fact below is unchanged by any of this: `SUBJECT_OF` and `GEN_KEY_OF`
// are two different keyspaces, and the endpoint is precisely the node that is in one and
// not the other. It is now drawn at BOTH zooms without either table growing.
//
// EXPORTED (plan 58-01) so a spec reads the SHIPPED constant rather than a copy of
// it. A mirrored literal in a test agrees with itself forever.
export const LOD_MIN_MACHINE_PX = 16;

// TWO KEYSPACES, DELIBERATELY NOT ONE - and the matching count is a trap, so read this
// before "simplifying" either table into the other.
//
//   GEN_KEY_OF   9 kinds -> GenKey.    INCLUDES belt (1).   EXCLUDES endpoint (9).
//   SUBJECT_OF   9 kinds -> AssetName. EXCLUDES belt (1).   INCLUDES endpoint (9).
//
// The OVERLAP is the eight machine kinds that both draw a vector body above the cut
// and bake an LOD block below it: SOURCE, FACTORY, TEE, BALANCER, ROUTER, MERGE, SINK
// and HANDLER. Each table has exactly one member the other lacks, which is why they are
// the same SIZE and not the same SET.
//
// THE COUNTS ARE 9 AND THE TWO LOD TABLES ARE STILL 8. That is not a discrepancy, it is
// the whole shape of plan 72-09: HANDLER entered both KEYSPACES as a declared alias of
// the FACTORY (see ART_ALIAS_OF below), so `LOD_TINTS` and `LOD_KIND_CODES` did not grow
// and this phase minted no hue and took no corner code. `machineVector.test.ts` pins
// both LOD tables at EIGHT, deliberately and separately from the keyspace counts.
//
// Growing `GenKey` to nine to "unify" them is a type error the moment you try it:
// `LOD_TINTS` is `Readonly<Record<GenKey, number>>`, so a ninth key demands a ninth
// authored hue, and the eight that exist are the eight the maintainer was shown and gated on
// 2026-08-01 (three re-hued by the phase 92 review). Shrinking `SUBJECT_OF` to exclude the endpoint would undo the
// one thing plan 58-03 exists to add. They stay separate. And the way an ELEVENTH kind
// got art without a ninth hue is the ALIAS below, not a widened GenKey.

/**
 * Map the `machine_kind` wire byte to its `GenKey` - the LOD-BLOCK selector. Since
 * plan 58-03 removed the machine bakes from this layer this table has exactly one
 * remaining consumer: `lodBlocks[genKey]` BELOW the LOD cut. Nothing above the cut
 * reads it.
 *
 * The byte order mirrors KIND_SPECS in generators.ts (source=0..sink=7). BELT (1) is
 * never drawn here (belts.ts owns it under `53-BELT-LOCK.md`) but is mapped for
 * totality, exactly as it always was.
 *
 * Exported so `machineVector.test.ts` asserts the two-keyspace relationship above
 * against the SHIPPED tables rather than against a mirrored pair of literals.
 */
export const GEN_KEY_OF: Readonly<Record<number, GenKey>> = {
  [machine_kind.SOURCE]: 'source',
  [machine_kind.BELT]: 'belt',
  [machine_kind.FACTORY]: 'factory',
  [machine_kind.TEE]: 'tee',
  [machine_kind.BALANCER]: 'balancer',
  [machine_kind.ROUTER]: 'router',
  [machine_kind.MERGE]: 'merge',
  [machine_kind.SINK]: 'sink',
  // HANDLER (10) DELIBERATELY SHARES THE FACTORY'S KEY. It is not a ninth GenKey: see
  // ART_ALIAS_OF below, which declares the sharing as DATA rather than leaving it as
  // an accident the tests were loosened around.
  [machine_kind.HANDLER]: 'factory',
};

/**
 * The kinds that DRAW A MACHINE BODY, mapped to their authored glyph asset. This is
 * the layer's SUBJECT keyspace and, since plan 58-03, its draw-loop guard: a kind in
 * this table gets a root, a chassis and a glyph; a kind absent from it is skipped
 * before any table is indexed.
 *
 * All eight subjects, keyed by the `machine_kind` wire byte:
 *
 *   SOURCE 0, FACTORY 2, TEE 3, BALANCER 4, ROUTER 5, MERGE 6, SINK 7, ENDPOINT 9.
 *
 * BELT (1) and WIRE (8) are ABSENT BY DESIGN, and they are absent for two different
 * reasons rather than one: a belt is drawn by `belts.ts` under `53-BELT-LOCK.md` (it
 * has art, just not here, and it appears in no art-lock axis table), while a wire is
 * the request/response TRANSPORT drawn by `wires.ts` and has no body to draw at all.
 *
 * ENDPOINT (9) IS IN THIS TABLE AND THAT IS THE NEW FACT. Until plan 58-03 the draw
 * loop guarded on `GEN_KEY_OF`, and kind 9 has never had a generator, so an endpoint
 * node produced no machine root at any zoom - its only visual was (and still is) the
 * wire-terminal inlet glyph `wires.ts` stamps at its port. It now gets the same
 * parametric chassis every other subject gets. The socket-at-the-port and the
 * socket-on-the-box have never been seen together on a real board; that is FEEL row
 * 58-c for plan 58-06 to capture, not a verdict to assert here.
 *
 * Exported for the two-keyspace assertion on `GEN_KEY_OF` above.
 */
export const SUBJECT_OF: Readonly<Record<number, AssetName>> = {
  [machine_kind.SOURCE]: 'source',
  [machine_kind.FACTORY]: 'factory',
  [machine_kind.TEE]: 'tee',
  [machine_kind.BALANCER]: 'balancer',
  [machine_kind.ROUTER]: 'router',
  [machine_kind.MERGE]: 'merge',
  [machine_kind.SINK]: 'sink',
  [machine_kind.ENDPOINT]: 'endpoint',
  // HANDLER (10) DELIBERATELY SHARES THE FACTORY'S ART. See ART_ALIAS_OF below.
  [machine_kind.HANDLER]: 'factory',
};

/**
 * THE DECLARED ART ALIASES: a kind that deliberately DRAWS AND BAKES AS ANOTHER KIND.
 *
 * `HANDLER (10) -> FACTORY (2)`, and it is the only row. An HTTP Handler IS a Factory
 * that runs user JS; it takes the Factory's chassis, the Factory's glyph, the Factory's
 * LOD tint and the Factory's corner code, at both zooms.
 *
 * WHY IT IS AN ALIAS RATHER THAN A NINTH KIND, and both halves of the cost are measured
 * rather than asserted (72-09 R-58, settled at plan 72-01's R-5):
 *
 *   - A ninth `GenKey` is a TYPE ERROR the moment you try it. `LOD_TINTS` is
 *     `Readonly<Record<GenKey, number>>`, so a ninth key demands a ninth AUTHORED HUE,
 *     and the eight that exist are the eight the maintainer was shown and gated on 2026-08-01
 *     (three re-hued by the phase 92 review). A ninth would put an unjudged colour on the board.
 *   - `LOD_KIND_CODES` is a SATURATED three-bit space. All eight code points are taken
 *     and the last slack, the top-left corner, was spent by phase 71's stacked
 *     BACKED_UP pip. There is no ninth code and no fourth corner to widen into.
 *
 * WHY IT IS DATA AND NOT A COMMENT. `machineVector.test.ts` and `icons.test.tsx` carry
 * four assertions that a naive reading of this change would have satisfied by moving an
 * 8 to a 9. They are BIJECTIONS, not counts: "no two kinds share a GenKey", "the eight
 * blocks are pairwise distinct", "the subjects draw distinct glyph contexts", and the
 * icons vacuity refusal's derived source count. A literal bump leaves all four green
 * while none of them still asserts the thing it was named for.
 *
 * So each of the four now reads as TWO clauses: (a) the CANONICAL kinds - those absent
 * from this table - keep every property the bijection asserted before, unweakened; and
 * (b) each ALIASED kind's key, digest and glyph context EQUALS its alias's, which is a
 * positive assertion nothing in this repository made before and which reddens on a
 * drift the old collision test could not express.
 *
 * **APPENDING A ROW HERE IS THE ONLY WAY TO WEAKEN THOSE FOUR ASSERTIONS.** That is the
 * point of the table: an ACCIDENTAL collision still reddens exactly as it always did,
 * because a kind absent from here is in the canonical set and collides there. A
 * DELIBERATE one costs a source edit a reviewer sees in a diff, next to this paragraph.
 */
export const ART_ALIAS_OF: Readonly<Record<number, number>> = {
  [machine_kind.HANDLER]: machine_kind.FACTORY,
};

/**
 * The nub fill for one port, recolored to the active skin (the generator no
 * longer owns nub color). Role is the primary silhouette discriminator (drawn by
 * `drawRoleNub`); color reinforces machine STATE per the bible state matrix:
 *   - a WORKING machine's role 0/1 nubs go the working accent,
 *   - an IDLE machine rests on a neutral ramp step (Out a touch brighter than In),
 *   - a `role===2` fault port reads DIM/OUTLINE (`ramp[3]`) in EVERY state; its
 *     "danger exit" annulus is what carries the role (VIS-03), never its colour, so
 *     it never reads as a stuck alarm either (RENDER-04's actual guarantee).
 * An UNKNOWN role byte (>2) is treated as In (the open role keyspace never throws).
 * Exported so `machines.test.ts` can pin the token map symbolically (GPU-free).
 *
 * NO NUB IS EVER `accents.fault`, AND THAT IS THE DELIBERATE CHANGE. Until
 * 2026-08-02 a FAULTED machine painted every nub `accents.fault`, and role 2 filled
 * solid fault on a live fault. It was removed by the maintainer's call on the 58 code review's
 * CR-01, taken on a REAL RENDER of all three candidate treatments (the "Option A"
 * cell). The board fact behind it: `machineState.ts drawAlertRing` strokes
 * `accents.fault` in a band 2.000..4.000 px outside the effective-box edge, and all
 * three nub silhouettes cross that band (role 0 reaches 4.000 px out, role 2 6.125,
 * role 1 7.625 - see `machineState.ts MAX_NUB_REACH_PX`). Halo and port were the
 * same INK on top of being geometrically fused, and the pair read as one smeared red
 * mass rather than as an alarm ring around a machine with ports.
 *
 * BE CLEAR ABOUT WHAT THIS DID NOT DO: it did not remove the OVERLAP. The nubs still
 * cross the ring band at exactly the same extents, `ALERT_RING_OUTSET_U` is still 3,
 * and no geometry moved. What it removes is the INK collision - of the elements that
 * share that band, only the ring is in the fault accent, so the overlap reads as two
 * distinct objects. Both alternatives were rejected on measurement: pushing the ring
 * to 9u makes the halo the dominant element in the cell AND leaves the role-1 stem
 * tip clearing the ring's inner edge by 0.375 px (under one device pixel, which with
 * `antialias: false` may snap to touching anyway); putting the ring inside the band
 * was already rejected by 58-03 (0.5u of substrate does not survive a raster). Do not
 * re-derive either one.
 *
 * The machine's own state cues are untouched by this: the chassis OUTLINE still
 * strokes `accents.fault` when faulted (`machineChassis.ts chassisInk`) and it is
 * 2.5..5.5 px INSIDE the box edge, so it never enters the ring's band.
 */
export function nubColor(role: number, state: number, skin: Skin): number {
  const { accents, ramp } = skin.palette;
  // The fault EXIT is a ROLE, not a state: the annulus says "output leaves here when
  // this machine faults" whether or not the fault is live right now. There is no
  // per-port fault byte to say otherwise, and the live fault is announced by the
  // alert ring. ramp[3] is the dim/outline step (one below the highlight).
  if (role === PORT_ROLE.FAULT) return ramp[3];
  if (state === state_tag.WORKING) return accents.working;
  return role === PORT_ROLE.OUT ? ramp[ramp.length - 1] : ramp[ramp.length - 2];
}

/**
 * One role-styled port nub (UI-SPEC section 1). The non-color discriminator is
 * the silhouette shape, on TWO axes:
 *
 * ROLE, the shape of the thing:
 *   role 0 (In)    plain body
 *   role 1 (Out)   the same body + outward stem (NUB_R -> NUB_STEM along the normal)
 *   role 2 (Fault) a SMALL core (NUB_FAULT_CORE_R) inside a ring at a LARGER
 *                  radius (NUB_FAULT_RING_R) - a true annulus, the heaviest
 *                  "danger exit" silhouette
 *
 * MEDIUM, what the body is (UI-SPEC 1.2, plan 72-09, SERVE-03):
 *   MECHANICAL   a disc of radius NUB_R
 *   ELECTRICAL   a SQUARE of side 2 * NUB_ELECTRICAL_HALF - the SAME square
 *                `wires.ts` stamps at a docked terminal, at the same half-extent,
 *                so a connected and an unconnected electrical port are one object
 *   anything else  the mechanical disc, and NEVER a throw
 *
 * WHY THE SECOND AXIS EXISTS. Until this function had it, an unwired Handler's ports
 * were pixel-identical to a Factory's and two 3x3 machines side by side were the same
 * machine to a reader. `wires.ts` drew the electric square only at a DOCKED terminal,
 * so the medium became visible only once you had already wired it up - which is the
 * board failing to show what it is running.
 *
 * AN UNKNOWN MEDIUM DRAWS THE MECHANICAL DISC AND NEVER THROWS (T-72-09-01).
 * `chrome/portLabels.ts` already reads an unknown medium as `Item`; this matches that
 * conservatism. A throw inside the Pixi ticker kills the renderer permanently while
 * every model assertion stays green.
 *
 * Color comes from {@link nubColor} (skin accent / neutral ramp), never a hue-only cue,
 * and MEDIUM DOES NOT TOUCH IT: an electrical In is `ramp[3]` and an electrical Out is
 * `ramp[4]`, exactly as their mechanical siblings. The bible reserves `accents.electric`
 * for wire ENERGY and a resting nub carries none; `nubColor` already carries the
 * machine-STATE channel and a medium-keyed hue would collide with it head on.
 *
 * The geometry lives in `protocol/ports.ts` because the config panel's
 * `PortIndicator` draws the SAME three silhouettes at 12px and a reader is meant
 * to map a panel row onto a nub. It used to be duplicated as literals on both
 * sides, and the role-2 shape drifted into a non-shape as a result: the ring was
 * stroked at the SAME radius as the fill in the SAME colour, so it composited
 * into a slightly fatter disc rather than a ring (51-UI-REVIEW fix 3 - the full
 * reasoning is on the constants).
 *
 * Exported so `machines.test.ts` can assert the role-2 silhouette is drawn in BOTH
 * idle and faulted states (the shape does not disappear when the fill dims).
 */
export function drawRoleNub(g: Graphics, spec: NubSpec, state: number, skin: Skin): void {
  const color = nubColor(spec.role, state, skin);
  // The MEDIUM axis. It applies to the BODY of roles 0 and 1 only: role 2's annulus is
  // a ROLE cue ("output leaves here when this machine faults") and stays an annulus at
  // every medium. An unknown or absent byte is NOT electrical, so it falls through to
  // the mechanical disc without a branch of its own and without a throw.
  const electrical = spec.medium === MEDIUM_ELECTRICAL;
  /** The role-0/1 body: a square for an electrical port, a disc for a mechanical one. */
  const body = (): void => {
    if (electrical) {
      g.rect(
        spec.x - NUB_ELECTRICAL_HALF,
        spec.y - NUB_ELECTRICAL_HALF,
        NUB_ELECTRICAL_HALF * 2,
        NUB_ELECTRICAL_HALF * 2,
      ).fill({ color });
    } else {
      g.circle(spec.x, spec.y, NUB_R).fill({ color });
    }
  };
  if (spec.role === PORT_ROLE.OUT) {
    body();
    // The stem geometry is UNCHANGED by medium, and that is deliberate: it is what
    // holds `MAX_NUB_REACH_PX` at 7.625 and keeps the role modifier one thing rather
    // than two. On an electrical Out the square (half-extent 5) simply covers more of
    // its inner run than the disc (radius 3.5) did.
    g.moveTo(spec.x + spec.nx * NUB_R, spec.y + spec.ny * NUB_R)
      .lineTo(spec.x + spec.nx * NUB_STEM, spec.y + spec.ny * NUB_STEM)
      .stroke({ width: NUB_STROKE, color });
  } else if (spec.role === PORT_ROLE.FAULT) {
    g.circle(spec.x, spec.y, NUB_FAULT_CORE_R).fill({ color });
    g.circle(spec.x, spec.y, NUB_FAULT_RING_R).stroke({ width: NUB_STROKE, color });
  } else {
    body();
  }
}

/**
 * Unsubscribe a glyph `Graphics` from the SHARED asset `GraphicsContext` it borrows.
 *
 * WHY THIS IS NOT `destroy()`'s JOB, and it genuinely is not. Pixi 8.19's `Graphics`
 * subscribes in its `context` SETTER (`Graphics.mjs:34-42`: `.on('update', ...)` and
 * `.on('unload', ...)`), but `Graphics.destroy()` (`:145-154`) only tears down a
 * context the Graphics OWNS - for a borrowed one it just sets `this._context = null`
 * and never calls `.off()`. On every prior phase that was harmless, because every
 * `Graphics` owned its own context and died with it. Phase 58 is the first to put
 * SHORT-LIVED, per-node `Graphics` on the PROCESS-WIDE, deliberately never-evicted
 * asset contexts (`svgAssets.ts:83` "Populated lazily, never evicted"), which turns
 * the missing `.off()` into an unbounded leak: measured, 100 create/destroy cycles on
 * one TEE handle took the shared context from 0 to 100 `update` listeners and left
 * them there for the process lifetime.
 *
 * It is exercised by every delete, every undo of a place, and every board load in a
 * long-running desktop app, and it directly defeats the "nothing to tear down between
 * scenes" claim `svgAssets.ts:20-26` rests its module-global exemption on.
 *
 * The two handler identities below are the ones the SETTER registers, so passing the
 * same `(fn, context)` triple is what makes `EventEmitter.off` actually match.
 */
function detachSharedContext(glyph: Graphics | undefined): void {
  if (glyph === undefined) return;
  const g = glyph as Graphics & {
    onViewUpdate: () => void;
    unload: () => void;
  };
  g.context.off('update', g.onViewUpdate, g);
  g.context.off('unload', g.unload, g);
}

/**
 * One machine: root Container holding the LOD-block Sprite, the vector body and the
 * port-nub overlay.
 */
interface MachineEntry {
  root: Container;
  /**
   * The BELOW-THE-CUT LOD block. Since plan 58-03 removed the machine bakes this
   * Sprite carries a `lodTints.ts` block and nothing else; above the cut it is
   * `.visible = false` and holds whatever block it last showed. An ENDPOINT has no
   * LOD tint, so its Sprite stays empty and hidden at every zoom.
   */
  sprite: Sprite;
  nubs: Graphics;
  /**
   * The BACKED_UP load gauge (71-06): a run of up to four `ramp[4]` ticks in a band
   * 9.000 .. 12.000 px above the effective box's top edge, closing into ONE solid bar at
   * full load.
   *
   * A CHILD OF `root`, NOT OF `body`, AND THAT PARENTING IS THE DESIGN. `machines.ts`
   * rotates exactly two things - `sprite.rotation` and `body.rotation` - so a `body`
   * child rotates with the machine and a cue keyed to one edge would read as a different
   * state once rotated (`machineState.ts` header, reason 2). `nubs` already sets the
   * precedent for the other legal answer: live on `root`, in unrotated node-root
   * coordinates. A rotated machine therefore keeps its gauge horizontal over its head,
   * filling left to right at every `rot`.
   *
   * Genuinely PLOTTED AND UNPLOTTED inside the `sig` guard, the ring's form rather than
   * the notch's visibility flag, so "a gauge exists exactly when a machine is filling"
   * is true of the GEOMETRY and not merely of a flag a later reader could flip.
   */
  gauge: Graphics;
  /**
   * The VECTOR body, built lazily on the first draw at or above the LOD cut. A
   * Container placed and rotated exactly as `sprite` is (same position, same
   * rotation, same pivot-at-the-unrotated-box-centre), holding four children:
   *
   *   `chassis` - the parametric outline, rebuilt ONLY on a `sig` change (MOTION-05),
   *               which is the same guard `rebuildNubs` already sits behind.
   *   `notch`   - the WORKING liveness cue. Plotted ONCE at construction, because its
   *               geometry never changes; per frame only its transform moves. Above
   *               the chassis in z so it reads as the outline being CUT.
   *   `glyph`   - `new Graphics(getAssetContext(subject))`. It SHARES the one
   *               process-wide tessellated context, so N TEEs on the board are ONE
   *               tessellation (VEC-04) and this Graphics is NEVER redrawn: there is
   *               no per-instance geometry to redraw.
   *   `ring`    - the FAULTED alert ring, plotted inside the same `sig` guard and
   *               EMPTY unless the node is faulted; per frame only its `.alpha` moves.
   *
   * `body` and `sprite` are mutually exclusive by `.visible`, never both drawn.
   */
  body?: Container;
  glyph?: Graphics;
  chassis?: Graphics;
  notch?: Graphics;
  ring?: Graphics;
  /** (kind|state|load|w|h|rot|lod) - a change rebuilds the recolored nub overlay. */
  signature: string;
}

export interface MachineLayer {
  layer: Container;
  /** Redraw machines for the current scene; `frame` is the MOTION-01 clock-derived index. */
  draw(scene: SceneState, frame: number): void;
  /**
   * How many machines currently have a load gauge that HOLDS GEOMETRY (71-06, PILE-08
   * acceptance check 3). The read-only paint probe `window.__fabrico.backedUpMarksPainted`
   * delegates to, in the position `overlay.alertRingsActive()` already occupies.
   *
   * IT READS THE PLOT, NEVER `node.load`, AND THAT IS THE WHOLE POINT. This project has a
   * recorded model-oracle blind spot: everything the live oracle exposes is model-only, so
   * a build whose Pixi paint regressed entirely leaves every model assertion passing over
   * a canvas that drew nothing (`oracle.ts:alertRingsPainted` states it in full). A hook
   * that answered from the scene model would return a happy non-zero count for exactly
   * that build, which is the blind spot verbatim rather than a fix for it. The membership
   * test is `gauge.context.instructions.length > 0` at the `drawLoadGauge` call site, so
   * making the drawing function a no-op takes this to 0.
   *
   * Backed by a `Set<number>` of node ids maintained at exactly two places: the draw call
   * inside the `sig` guard (added when the plot produced geometry, removed when it did
   * not), and the entry-destruction sweep at the top of `draw`. There is no layer-level
   * `clear()` on this interface for it to be maintained on; destruction is the only exit
   * a machine has.
   */
  loadGaugesPainted(): number;
  /**
   * Is the load gauge painted on THIS node (71-review WR-05)?
   *
   * The board-wide count above cannot carry a per-machine message. `gaugesPainted`
   * gains a member for ANY node whose gauge plotted geometry, and `drawLoadGauge`
   * plots at levels 1, 2 and 3 as well as at the merged full bar - so a regression in
   * the `level >= GAUGE_SLOTS` branch ALONE leaves the named machine drawing nothing
   * while the mid-band gauges elsewhere on the board keep the count non-zero. That is
   * a whole class of mutation the count is structurally blind to, and the merged full
   * bar IS the BACKED_UP cue.
   *
   * Same set, same membership rule (`gauge.context.instructions.length > 0` read back
   * off the Graphics), asked about one id. The count is kept because other callers use
   * it; what changes is that a spec naming a machine can now probe that machine.
   */
  loadGaugePaintedOn(id: number): boolean;
  /**
   * The FORM the load gauge on `id` is drawn in, and the tick of the scene it was drawn FROM
   * (plan 77-07, phase 77 D-04, research Pitfall 2 and A2). `null` for an id the layer holds no
   * entry for (never drawn, or swept on destruction).
   *
   * WHY IT EXISTS. {@link loadGaugePaintedOn} is true at levels 1, 2 and 3 as well as at the
   * merged full bar, so it stays true for as long as ANY tick is plotted: it cannot see the
   * backed-up mark CLEAR, which is the moment a release is about. And an instruction count alone
   * cannot tell level 1 (ONE short tick) from level 4 (ONE merged bar): both are one rect. So
   * this reads the count AND the drawn width, and `merged` is true only for exactly one filled
   * rectangle in the gauge ink, the full run long and the band thick, on a Graphics shown up its
   * parent chain ({@link readLoadGaugeForm}; the 77-07 refuter round: one instruction is one
   * fill CALL, so four open ticks under one fill used to read merged).
   *
   * WHY IT CARRIES A TICK. The scene model is updated as each packet lands (`App.tsx`
   * `applyPacket`), while the gauge is plotted only inside the render loop's `machines.draw`
   * (`loop.ts`), once per display frame. A sampler that reads the model and this form in one
   * breath can therefore pair tick T's model with the gauge drawn for T-1. `drawnAtTick` is the
   * `scene.tick` of the latest `draw` pass, so a grader keys a form by the tick it was drawn
   * from and never by the tick of the record that carried it. A node whose signature did not
   * change keeps its last plot, which is still what that pass put on screen for its tick.
   *
   * IT READS THE GAUGE GRAPHICS' OWN CONTEXT (`context.instructions` and `context.bounds`),
   * NEVER `node.load`: a hook that answered from the byte would report a merged bar over a
   * canvas that drew none (memory fabrico-model-oracle-blindspot). Read-only, no setter, no Pixi
   * object escapes (T-14-FABRICO-RO): three numbers and a boolean.
   */
  loadGaugeFormOn(id: number): LoadGaugeForm | null;
  /**
   * How many path instructions the PORT-NUB overlay on `id` currently holds (73-10).
   * `0` for a node that plotted nothing, and `0` for an id the layer has never seen.
   *
   * A COUNT, NOT A BOOLEAN, and that is the whole reason it is worth having. The
   * defect this probe exists to catch does not take the nubs to zero - it leaves the
   * overlay holding a STALE plot from before a port edit, which any "is anything
   * painted" question answers `true` on both builds. An Out is a disc plus a stem and
   * an In is a disc, so a port ADD moves this number and a live spec can require it to
   * move. (A same-count RE-SEAT does not move it; that case is covered at the layer,
   * where the plotted coordinates are readable.)
   *
   * IT READS THE GRAPHICS DIRECTLY rather than a maintained Set, which is where it
   * departs from `loadGaugesPainted` above. The gauge probe needs a Set because it
   * answers a BOARD-WIDE question and there is nothing to iterate; this one is scoped
   * to one id and the `entries` map already holds that node's `Graphics`, so reading
   * `nubs.context.instructions.length` on demand is strictly more honest - there is no
   * bookkeeping that could drift from the plot, because there is no bookkeeping.
   *
   * Read-only, no setter, no Pixi ref (T-14-FABRICO-RO): a number off a context.
   */
  portNubInstructionsOn(id: number): number;
  /**
   * What ONE label's box PLOTTED (phase 76, SHAPE-10), read back off the `label-box`
   * Graphics' own `context.instructions`: the instruction count, the fill colour and
   * alpha, the stroke colour, alpha and width, and the rectangle in WORLD px (the
   * rectangle primitive the instructions carry, offset by the Graphics' position). Never
   * the values handed to the draw call: a draw that plotted nothing, or plotted something
   * else, reads as exactly that (memory fabrico-model-oracle-blindspot). `null` for an id
   * the layer holds no box for. Read-only, no Pixi ref escapes (T-14-FABRICO-RO).
   */
  labelBoxOn(id: number): LabelBoxReadback | null;
  /**
   * THE CENSUS OF WHAT THIS LAYER DRAWS (plan 76-08, verification truth 7, review CR-01),
   * read off the DISPLAY LIST, never off the scene.
   *
   * WHY IT EXISTS. `RenderProducer::reset` restarts render handles at 0 on every keyframe
   * (Undo, Redo, Load, New, LoadDemo), so a handle that named a label can name a machine
   * after it. The scene model was right after such a keyframe and the canvas was wrong: a
   * deleted label's tinted box stayed drawn on the handle a machine now held, and every
   * live check, reading the model, passed over it (memory fabrico-model-oracle-blindspot).
   * A census lets a spec require that the canvas holds exactly what the scene holds.
   *
   * `machines`: every handle whose machine root is a child of the layer, ascending.
   * `labels`: every handle whose `label-box` Graphics is a child of the layer, ascending.
   * `strays`: layer children neither map accounts for (a root or box orphaned from its
   * map would show here rather than nowhere).
   *
   * Read-only, plain arrays and a count, no Pixi ref escapes (T-14-FABRICO-RO).
   */
  drawnNodes(): DrawnNodesReadback;
  /**
   * WHICH ART THE MACHINE ROOT ON `id` IS DRAWING (plan 76-08), read off the glyph
   * Graphics' CURRENT context by identity against the shared asset contexts, never off a
   * field the layer writes beside it, so deleting the WR-07 glyph re-point in `draw()`
   * changes this answer. Returns the art subject (`'source'`, `'sink'`, ...; a HANDLER
   * reads `'factory'`, its declared alias).
   *
   * WHY IT EXISTS. After a keyframe remints handles, a root kept on a handle that now
   * names another machine kind can go on drawing the old kind's glyph while the model
   * names the new kind. The census cannot see that (the root is rightly present); this
   * can.
   *
   * `null` when the handle has no root, when the root has no glyph (first drawn below the
   * LOD cut), and WHENEVER THE BODY IS NOT VISIBLE: below the cut the glyph Graphics is
   * kept but hidden, and it is re-pointed only on a vector frame, so a handle reminted to
   * another kind while zoomed out keeps the OLD kind's context on a hidden glyph until the
   * next zoom in. Answering from that glyph would report art that is not on screen, and
   * the wrong art at that. Also `null` when no built shared context matches.
   *
   * THE LOOKUP NEVER BUILDS A CONTEXT: it compares through `peekAssetContext`, so asking
   * leaves the process-wide context cache exactly as it was. Read-only, a string or null,
   * no Pixi ref escapes (T-14-FABRICO-RO).
   */
  glyphSubjectOn(id: number): AssetName | null;
  /**
   * WHERE THE GLYPH ON `id` IS DRAWN, AND HOW BIG (plan 85-02, D-24), read off the live Pixi
   * objects, never off the placement formula: `x`/`y` are the glyph Graphics' `position`,
   * `w`/`h` are the drawn art's author box (`getAssetBox` of the subject the glyph's CURRENT
   * context is, matched as {@link glyphSubjectOn} matches it) times the glyph's current
   * `scale.x`/`scale.y`, and `footW`/`footH` are the machine's footprint in px, read off the
   * body's pivot (set at the unrotated box centre, so twice the pivot is `w * CELL` by
   * `h * CELL`). All five are in the body's unrotated frame, so "the glyph is inside its
   * machine" is `0 <= x`, `0 <= y`, `x + w <= footW` and `y + h <= footH`.
   *
   * WHY IT EXISTS. A glyph whose author box is larger than its machine's footprint (the
   * shipped demo's 1x1 HTTP Handler drawing the 96u Factory art) spills over its neighbours,
   * and a check that recomputed the placement formula would agree with any formula at all.
   *
   * `null` exactly when {@link glyphSubjectOn} is: no root, no glyph, the body hidden below the
   * LOD cut, or no built shared context matching. Never builds a context; plain numbers, no
   * Pixi ref escapes (T-14-FABRICO-RO).
   */
  glyphBoxOn(id: number): GlyphBoxReadback | null;
}

/** The plain-data read-back {@link MachineLayer.glyphBoxOn} returns, all in px. */
export interface GlyphBoxReadback {
  x: number;
  y: number;
  w: number;
  h: number;
  footW: number;
  footH: number;
}

/** The plain-data read-back {@link MachineLayer.loadGaugeFormOn} returns. */
export interface LoadGaugeForm {
  /** How many instructions the gauge Graphics holds: 0 at load 0, one per tick at 1 to 3, one at 4. */
  instructions: number;
  /** The drawn bounds' width in px, 0 when nothing is plotted. */
  width: number;
  /** ONE filled rect in the gauge ink, the full run long and the band thick, on a shown Graphics:
   *  the backed-up mark (see {@link readLoadGaugeForm}). */
  merged: boolean;
  /** The `scene.tick` of the latest `draw` pass, the tick this form was drawn FROM. */
  drawnAtTick: number;
}

/** The merged bar's tolerance on its drawn length, thickness and height, in px. */
const GAUGE_MERGED_TOLERANCE_PX = 0.5;

/**
 * Is `g` shown on screen as far as the display list can say: visible, renderable and above alpha
 * 0, it and every parent up the chain (the 77-07 refuter round, refuters 2 and 5).
 */
function shownUpTheChain(g: Graphics): boolean {
  for (let c: Container | null = g; c !== null; c = c.parent) {
    if (!c.visible || !c.renderable || c.alpha <= 0) return false;
  }
  return true;
}

/**
 * The art subject a machine entry's glyph is DRAWING right now, matched by identity of the
 * glyph's current context against the shared asset contexts (plan 76-08), or `null` with no
 * entry, no glyph, a hidden body or no match. The one lookup behind `glyphSubjectOn` and
 * `glyphBoxOn`. Peeks, never builds a context.
 */
function drawnGlyphSubject(entry: MachineEntry | undefined): AssetName | null {
  if (entry?.glyph === undefined || entry.body === undefined || !entry.body.visible) return null;
  const held = entry.glyph.context;
  for (const subject of new Set(Object.values(SUBJECT_OF))) {
    const ctx = peekAssetContext(subject);
    if (ctx !== undefined && ctx === held) return subject;
  }
  return null;
}

/**
 * Read a gauge's form back off its Graphics. Exported for the layer and its unit tests only;
 * the live probe reaches it through {@link MachineLayer.loadGaugeFormOn}.
 *
 * `merged` READS THE BAR AS DRAWN (the 77-07 refuter round). Pixi counts one instruction per
 * fill CALL, not per shape, so "one instruction spanning the run" also held for four ticks with
 * their gaps open plotted as one path under one fill, the very defect the merged form exists to
 * expose; and it held for a bar filled transparent or on a Graphics nobody can see. So `merged`
 * now requires the instructions to carry exactly ONE rectangle primitive, filled (a stroke
 * instruction refuses it), in `ink` at an alpha above 0, the run's length and the band's
 * thickness at the band's height (`drawLoadGauge`'s geometry), on a Graphics shown up its whole
 * parent chain. Where along the head the bar sits is graded live, on screen pixels.
 */
export function readLoadGaugeForm(g: Graphics, drawnAtTick: number, ink: number): LoadGaugeForm {
  const instructions = g.context.instructions.length;
  const width = instructions === 0 ? 0 : g.context.bounds.width;
  const rects: { y: number; w: number; h: number }[] = [];
  let otherShapes = 0;
  let painted = instructions > 0;
  for (const ins of g.context.instructions) {
    if (ins.action !== 'fill') {
      painted = false;
      continue;
    }
    const data = ins.data as {
      style?: { color?: number; alpha?: number };
      path?: { shapePath: { shapePrimitives: unknown[] } };
    };
    if (data.style?.color !== ink || !((data.style?.alpha ?? 0) > 0)) painted = false;
    for (const prim of (data.path?.shapePath.shapePrimitives ?? []) as Array<{
      shape: { type: string; x: number; y: number; width: number; height: number };
      transform?: { apply(p: { x: number; y: number }): { x: number; y: number } };
    }>) {
      if (prim.shape.type !== 'rectangle') {
        otherShapes += 1;
        continue;
      }
      const tl = { x: prim.shape.x, y: prim.shape.y };
      const p = prim.transform ? prim.transform.apply(tl) : tl;
      rects.push({ y: p.y, w: prim.shape.width, h: prim.shape.height });
    }
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= GAUGE_MERGED_TOLERANCE_PX;
  const bar = rects.length === 1 && otherShapes === 0 ? rects[0] : null;
  const merged =
    painted &&
    bar !== null &&
    near(bar.w, uToPx(GAUGE_RUN_U)) &&
    near(bar.h, uToPx(GAUGE_THICK_U)) &&
    near(bar.y, -uToPx(GAUGE_OUTSET_U + GAUGE_THICK_U)) &&
    shownUpTheChain(g);
  return { instructions, width, merged, drawnAtTick };
}

/** The plain-data census {@link MachineLayer.drawnNodes} returns. */
export interface DrawnNodesReadback {
  machines: number[];
  labels: number[];
  strays: number;
}

/** The plain-data read-back {@link MachineLayer.labelBoxOn} returns. */
export interface LabelBoxReadback {
  instructions: number;
  fill: { color: number; alpha: number } | null;
  stroke: { color: number; alpha: number; width: number } | null;
  rect: { x: number; y: number; w: number; h: number } | null;
}

/**
 * The alpha a label's box is FILLED at (phase 76, UI-SPEC 3.4). The fill is the cue that
 * does most of the work: every machine is an open outline (lock axis 3), so the only
 * filled rectangle on the board is a label. 0.16 keeps the words above 4.5 : 1 on every
 * label colour (style-bible section 1c).
 */
export const LABEL_FILL_ALPHA = 0.16;

/**
 * The world-px stroke width of a label's outline at camera zoom `scale`: the skin's 2u
 * detail weight (lighter than a machine's 3u chassis on purpose), never under
 * `MIN_CABLE_SCREEN_PX` screen px, which is the plan 75-10 cable rule, imported rather
 * than copied. 2 at zoom 0.5 and above, 4 at the 0.25 floor.
 */
export function labelStrokeWidth(skin: Skin, scale: number): number {
  return Math.max(uToPx(skin.strokeDetail), MIN_CABLE_SCREEN_PX / scale);
}

/**
 * Read a label box back off its Graphics. Exported for the layer and its unit tests only;
 * the live probe reaches it through {@link MachineLayer.labelBoxOn}.
 */
export function readLabelBox(g: Graphics): LabelBoxReadback {
  let fill: LabelBoxReadback['fill'] = null;
  let stroke: LabelBoxReadback['stroke'] = null;
  let rect: LabelBoxReadback['rect'] = null;
  for (const ins of g.context.instructions) {
    if (ins.action !== 'fill' && ins.action !== 'stroke') continue;
    const data = ins.data as {
      style?: { color?: number; alpha?: number; width?: number };
      path?: { shapePath: { shapePrimitives: unknown[] } };
    };
    const color = data.style?.color ?? -1;
    const alpha = data.style?.alpha ?? -1;
    if (ins.action === 'fill' && fill === null) fill = { color, alpha };
    if (ins.action === 'stroke' && stroke === null) {
      stroke = { color, alpha, width: data.style?.width ?? -1 };
    }
    if (rect === null && data.path) {
      for (const prim of data.path.shapePath.shapePrimitives as Array<{
        shape: { type: string; x: number; y: number; width: number; height: number };
        transform?: { apply(p: { x: number; y: number }): { x: number; y: number } };
      }>) {
        if (prim.shape.type !== 'rectangle') continue;
        const tl = { x: prim.shape.x, y: prim.shape.y };
        const p = prim.transform ? prim.transform.apply(tl) : tl;
        rect = { x: p.x + g.position.x, y: p.y + g.position.y, w: prim.shape.width, h: prim.shape.height };
        break;
      }
    }
  }
  return { instructions: g.context.instructions.length, fill, stroke, rect };
}

/**
 * Does the label box held on a handle STAY this frame? Only when the handle is still in the
 * scene AND still names a LABEL (plan 76-08, review CR-01, verification truth 7).
 *
 * WHY PRESENCE ALONE WAS WRONG. `RenderProducer::reset` (crates/fabrico-host
 * render_packet.rs) builds a fresh packet builder on every keyframe (Undo, Redo, Load, New,
 * LoadDemo), so handles restart at 0 and become the nodes' rank in NodeId order. Place a
 * Label, place a Source, delete the label, Ctrl+Z, Ctrl+Shift+Z: after the Undo the label is
 * handle 0, after the Redo the Source alone is handle 0. The loop used to drop a box only
 * when its handle disappeared, and handle 0 never did, so the deleted label's tinted box
 * stayed drawn at its old cells under the Source while the scene model was right
 * (`machineVector.test.ts` `a_label_handle_reused_by_a_machine_drops_the_label_box`, live
 * `76-label-handle-reuse.live.spec.ts` leg 1). A handle that comes back as a label in the
 * same frame keeps its box and is re-plotted by `drawLabelBox` on the new node's signature.
 */
export function labelBoxStays(node: NodeView | undefined): boolean {
  return node !== undefined && node.kind === machine_kind.LABEL;
}

/**
 * Does the machine entry (root, chassis, glyph, nubs, gauge, LOD block) held on a handle
 * STAY this frame? Only when the handle is still in the scene AND names a kind the machine
 * branch of `draw()` draws, which is exactly a kind with a `SUBJECT_OF` row (so never a
 * LABEL, a BELT or a WIRE). The mirror of {@link labelBoxStays} (CR-01, the machine half):
 * place a Source, place a Label, delete the Source, Ctrl+Z, Ctrl+Shift+Z, and after the
 * Redo the label alone is handle 0, the handle the Source held after the Undo. The label
 * branch `continue`s before the machine code, so a loop that removed by presence alone
 * left the deleted Source's root drawn beside the label's box
 * (`machineVector.test.ts` `a_machine_handle_reused_by_a_label_drops_the_machine_root`,
 * live `76-label-handle-reuse.live.spec.ts` legs 2 and 3). A handle that changes between
 * two machine kinds keeps its entry; the WR-07 re-point below gives it the new kind's art.
 */
export function machineEntryStays(node: NodeView | undefined): boolean {
  return node !== undefined && SUBJECT_OF[node.kind] !== undefined;
}

/**
 * Build the machine render layer against a single `activeSkin`. The layer owns an
 * instance-scoped SynthTextureCache and the LOD block bakers at native CELL (native
 * scale 1), so every below-the-cut block is pixel-exact 1:1. Above the cut nothing
 * is baked at all.
 */
export function createMachineLayer(
  activeSkin: Skin,
  // Live camera zoom source (READ-05 LOD selection): a closure returning
  // `cam.worldScale()`, read FRESH each draw so the glyph-vs-block LOD cut tracks the
  // continuous zoom. One-way display-only, mirroring the belts.ts `scale` param
  // (T-33-DET / T-31-DET): read here, NEVER assigned back into the camera, scene,
  // a GridCommand, or scene.tick. Defaulted so the untouched machines.test.ts call
  // sites stay valid.
  scale: () => number = () => 1,
  // The texture baker the instance-scoped SynthTextureCache uses. DEFAULTED to the
  // real Pixi bake, so every existing call site stays valid unchanged - the same
  // precedent the `scale` parameter above set.
  //
  // It is threaded here as a COUNTING SEAM, and the distinction matters because the
  // obvious reading is wrong. The real bake works fine headless: `matrixToTexture` ->
  // `BufferImageSource` is pure CPU, and plan 58-01 verified a full
  // `createMachineLayer(...).draw()` over a FACTORY node baking a real `Texture`
  // under jsdom with no GPU and no error. So this is NOT a jsdom workaround.
  //
  // What it buys is the ability to assert that a VECTOR subject above the LOD cut
  // bakes NOTHING - the whole point of the vector move - by counting calls. Doing
  // that with `vi.mock('pixi.js', ...)` instead would also stub `GraphicsContext`
  // away and make `machineVector.test.ts`'s shared-context identity assertion
  // vacuous, which is the one claim that spec exists to make.
  makeTexture: MakeTexture = matrixToTexture,
): MachineLayer {
  const layer = new Container();
  const entries = new Map<number, MachineEntry>();
  // The node ids whose gauge Graphics HOLDS GEOMETRY right now. See
  // `MachineLayer.loadGaugesPainted` for why this is a property of the PLOT and never of
  // the scene model's load byte.
  const gaugesPainted = new Set<number>();
  // Phase 76 (SHAPE-10): one `label-box` Graphics per label node, keyed by handle, with
  // the signature it was last plotted on. Labels are NOT in `entries`: they have no
  // body, glyph, nubs, notch, ring, gauge or LOD block, so they share none of that
  // machinery and are drawn by their own branch below at every zoom. A box goes when its
  // handle goes OR its handle stops naming a label (plan 76-08, CR-01, `labelBoxStays`):
  // a keyframe remints handles, so the same handle can name a machine next frame.
  const labelBoxes = new Map<number, { g: Graphics; sig: string }>();
  const skin = activeSkin;
  const cache = new SynthTextureCache(makeTexture);
  // THE ONLY BAKER LEFT IN THIS LAYER (plan 58-03). The generator set and the
  // fault-overlay set builder went from the render path here: the body is vector above
  // the cut and the fault marker's job moved to the board-drawn alert ring. Plan 61-07
  // finished that job by DELETING the fault-overlay bake and its set builder outright,
  // on a grep that found this comment was the closest thing either had to a caller.
  //
  // `synth/generators.ts` ITSELF IS NOT DELETED and must not be, but its reason
  // NARROWED to one consumer in plan 61-07. That plan deleted the four raster belt
  // bakes, the shared bezel painter and the pixel-era holdover constants, and
  // re-pointed `spike/pixelGuard.tsx`'s belt surface at the shipped vector corner - so
  // neither the belt layer nor the pixel guard reaches a generator any more. The ONE
  // remaining consumer is the art board's slate module, in the dev-tooling directory
  // `src/spike/`, which renders the Phase 57 board's pinned historical TODAY pixel
  // column through `makeGenerators`, including a
  // historical still of the pixel-era belt tile. That board stays live until the locked
  // direction has been judged on the real binary.
  //
  // READ-05: per-kind solid LOD block bakers (kind tint + state corner pip), baked at
  // native CELL. Baked once from the ONE locked skin, so the state pip tracks that
  // skin's accents. Cached as a distinct `|lod` texture variant (T-33-BAKE).
  const lodBlocks = makeLodBlocks(skin, CELL);
  // The ENDPOINT's below-the-cut block (66-03). Kept SEPARATE from `lodBlocks` rather
  // than added to it as a ninth entry, because `lodBlocks` is keyed by `GenKey` and a
  // ninth key would demand both a ninth authored hue and a ninth corner code - neither of
  // which exists. The full reasoning is on `makeEndpointPresenceBlock`.
  const endpointBlock = makeEndpointPresenceBlock(skin, CELL);

  /**
   * The port-list half of the nub-overlay invalidation key (73-10).
   *
   * WHAT IT FIXES, measured on the real WebKitGTK binary on the phase-73 walk. The key
   * used to be `kind|state|load|w|h|rot|lod` and carried NO port token. A
   * `+ Add output` on a Factory moves none of those seven: `grow_to_fit` on
   * 1 In / 2 Out / 1 Fault gives min 2x2, floored up by the Factory's own 3x3 base, so
   * neither `w` nor `h` moves. The signature came out byte-identical, `rebuildNubs`
   * never ran, and the overlay kept the geometry it was plotted with when the node
   * first appeared. `RemovePort` has the identical hole.
   *
   * AND THE SURVIVING NUBS WERE STALE TOO, which was the worse half until plan
   * 74.1-14. `reseat_ports` (core state.rs) then seated a port by its index AMONG ITS
   * ROLE, so one add moved the Factory from its catalog seats In (0,1) / Out (2,1) /
   * Fault (1,2) to the corners. Since the maintainer's ruling of 2026-10-04 ("Edits keep middle
   * layout") it seats each role centre-out from the CATALOG box (middle, then below,
   * then above, then grown rows), so an add keeps every existing In and Out and the
   * new Out takes (2,2); the Fault row moves only when the box grows taller. A
   * removal still moves every later Out into the previous slot, so surviving nubs CAN
   * move, and a stale plot would leave a belt pointing at a vacated cell.
   *
   * A BARE COUNT IS NOT ENOUGH and must not be substituted for this. A re-seat moves
   * nubs without changing arity, and a medium or side change moves the silhouette
   * without moving anything at all. The key covers exactly what `rebuildNubs` consumes
   * and nothing more: `localNubSpecs` reads role, side, medium and the NODE-LOCAL cell,
   * so those four are fingerprinted per port, in list order - the order is itself
   * load-bearing, because it is what `reseat_ports` keys on.
   *
   * THE CELL IS LOCAL ON PURPOSE. Fingerprinting the absolute `p.cell_x/y` would make a
   * node MOVE invalidate the overlay, and a move is already handled correctly by
   * repositioning `entry.root` - it needs no re-plot at all. Local cells are what the
   * plot is a function of, so they are what the key is a function of.
   *
   * COST: one string per node per draw, on a layer that already builds one per node per
   * draw for `sig` itself. Folding four small tokens per port into a string that was
   * being built anyway is a constant-factor change to an existing cost, not a new one,
   * so it is left unmemoised - nothing has measured a cost real enough to pay for a
   * cache and the state a cache would add.
   */
  const portFingerprint = (node: NodeView): string => {
    let s = '';
    for (const p of node.ports) {
      s += `${p.role}.${p.side}.${p.cell_x - node.cell_x}.${p.cell_y - node.cell_y}.${p.medium};`;
    }
    return s;
  };

  const rebuildNubs = (g: Graphics, node: NodeView): void => {
    g.clear();
    // Nubs come EXCLUSIVELY from the authoritative wire ports[] (D-01):
    // localNubSpecs is node-root-local, and this overlay lives at node.cell*CELL,
    // so each nub lands on its declared perimeter cell/side. `rot` is in the
    // signature, so a Rotate rebuilds and the nubs visibly move (REND-06).
    for (const spec of localNubSpecs(node)) {
      drawRoleNub(g, spec, node.state, skin);
    }
  };

  /**
   * Plot one label's box: the cell rect of its `w x h` cells inset on the centreline by
   * `CHASSIS_INSET_U` (exactly where a machine chassis would sit, so two neighbouring
   * labels show the same gap two machines do), filled with the label colour at
   * `LABEL_FILL_ALPHA` and outlined in it at alpha 1 and `labelStrokeWidth`. No glyph,
   * nubs, prongs, state pip, alert ring or LOD block. Re-plotted ONLY when its box,
   * colour or stroke width changes (MOTION-05); per frame only its position is set.
   *
   * THE COLOUR IS THE HOST'S (plan 76-03, D-05): `NodeView.label.colour`, the byte the
   * host holds, through `LABEL_COLOURS` into `skin.palette.labels`. An absent label view
   * or a byte past the closed set draws Sand, the default the host mints. The resolved
   * colour is IN THE SIGNATURE, so a colour change alone re-plots the box: without it a
   * recolour that moved nothing else would keep the old fill on the canvas while the model
   * reported the new one (memory fabrico-model-oracle-blindspot;
   * `machineVector.test.ts` `a_colour_change_alone_replots_the_label_box`).
   */
  const drawLabelBox = (node: NodeView): void => {
    let box = labelBoxes.get(node.id);
    if (!box) {
      const g = new Graphics();
      // LABELLED so a spec and a live Pixi devtools tree address it by NAME.
      g.label = 'label-box';
      // Under every machine root: a label is context, never on top of a machine.
      layer.addChildAt(g, 0);
      box = { g, sig: '' };
      labelBoxes.set(node.id, box);
    }
    box.g.position.set(node.cell_x * CELL, node.cell_y * CELL);
    const { ew, eh } = effectiveBox(node.w, node.h, node.rot);
    const colour = skin.palette.labels[LABEL_COLOURS[node.label?.colour ?? 0] ?? 'sand'];
    const width = labelStrokeWidth(skin, scale());
    const sig = `${ew}|${eh}|${colour}|${width}`;
    if (sig === box.sig) return;
    const inset = uToPx(CHASSIS_INSET_U);
    box.g.clear();
    box.g
      .rect(inset, inset, ew * CELL - 2 * inset, eh * CELL - 2 * inset)
      .fill({ color: colour, alpha: LABEL_FILL_ALPHA })
      .stroke({ color: colour, alpha: 1, width });
    box.sig = sig;
  };

  // The scene tick the latest `draw` pass read (plan 77-07): the tick every gauge form on the
  // layer was drawn FROM. Read from the scene, never written back to it.
  let drawnAtTick = 0;
  const draw = (scene: SceneState, frame: number): void => {
    drawnAtTick = scene.tick;
    // A machine goes when its handle goes OR now names a node this branch does not draw
    // (CR-01): see `machineEntryStays`. Destroy frees the sprite.
    for (const [handle, entry] of entries) {
      if (!machineEntryStays(scene.nodes.get(handle))) {
        detachSharedContext(entry.glyph);
        layer.removeChild(entry.root);
        entry.root.destroy({ children: true });
        entries.delete(handle);
        // The gauge Graphics went with the root. A Set that only ever grew would report
        // a mark over a machine that no longer exists, which is the same untruth in the
        // other direction.
        gaugesPainted.delete(handle);
      }
    }
    // A label box goes when its handle goes OR STOPS NAMING A LABEL (CR-01): see
    // `labelBoxStays` for why presence alone was wrong after a keyframe.
    for (const [handle, box] of labelBoxes) {
      if (!labelBoxStays(scene.nodes.get(handle))) {
        layer.removeChild(box.g);
        box.g.destroy();
        labelBoxes.delete(handle);
      }
    }

    for (const node of scene.nodes.values()) {
      // THE LABEL BRANCH (phase 76, SHAPE-10, UI-SPEC 3.4), BEFORE the subject guard on
      // purpose: a label is in neither LOD table, and the guard below would skip it and
      // draw NOTHING at any zoom (the silent-nothing class `machineVector.test.ts`
      // guards). It is drawn at EVERY zoom, the same box above and below the LOD cut.
      if (node.kind === machine_kind.LABEL) {
        drawLabelBox(node);
        continue;
      }
      // THE SUBJECT GUARD (T-58-11). ONE explicit skip over ONE table, and it is the
      // line that gated the endpoint out until plan 58-03. A kind absent from
      // SUBJECT_OF is drawn elsewhere or not at all - BELT (1) by belts.ts, WIRE (8)
      // by wires.ts - and is skipped BEFORE any table is indexed, so an unmapped kind
      // byte can never index a lookup with `undefined` (the defect that threw
      // `generators[undefined] is not a function` every frame once the demo headline
      // wire put a real Endpoint node in the packet).
      const subject = SUBJECT_OF[node.kind];
      if (subject === undefined) continue;

      let entry = entries.get(node.id);
      if (!entry) {
        const root = new Container();
        const sprite = new Sprite();
        sprite.anchor.set(0.5);
        const nubs = new Graphics();
        // LABELLED (73-10). It was the ONE unlabelled child on this root while every
        // sibling - `machine-body`, `machine-chassis`, `machine-glyph`,
        // `machine-alert-ring`, `machine-load-gauge` - carried a name that a spec reads
        // back by. Being unaddressable is why no layer-level test ever asserted about
        // the nub PLOT, which is how the stale-signature defect below reached the real
        // binary. Same reason as the gauge's label: name it, do not index it.
        nubs.label = 'machine-port-nubs';
        // Built EAGERLY beside the nubs rather than lazily beside the body, because it
        // is a `root` child like the nubs and shares their unrotated frame. Labelled so a
        // spec and a live Pixi devtools tree address it by NAME rather than by child
        // index (an index assertion silently follows a z-order change).
        const gauge = new Graphics();
        gauge.label = 'machine-load-gauge';
        root.addChild(sprite, nubs, gauge);
        entry = { root, sprite, nubs, gauge, signature: '' };
        entries.set(node.id, entry);
        layer.addChild(root);
      }

      const { ew, eh } = effectiveBox(node.w, node.h, node.rot);
      entry.root.position.set(node.cell_x * CELL, node.cell_y * CELL);
      // Anchor 0.5 + effective-box center: whole-sprite rotation about the centroid.
      entry.sprite.position.set((ew * CELL) / 2, (eh * CELL) / 2);
      entry.sprite.rotation = node.rot * (Math.PI / 2);

      // READ-05: read the live zoom ONCE per node (one-way display-only, T-33-DET) and
      // pick the family by a SINGLE inclusive threshold. At/above the cut the bezel
      // glyph body; below it the solid kind-tinted LOD block (the glyph would be
      // sub-pixel). No hysteresis - one cut, exactly like the belt/grid LOD.
      const lod = scale() * CELL < LOD_MIN_MACHINE_PX;

      // ART-01: EVERY subject is vector at or above the cut - there is no per-kind
      // condition left here, which is the whole content of plan 58-03 task 1. Below
      // the cut every subject that HAS an LOD tint keeps the lodBlocks Sprite (a
      // vector chassis is exactly what disappears down there - see LOD_MIN_MACHINE_PX).
      const vector = !lod;
      if (vector && entry.body === undefined) {
        const body = new Container();
        // The glyph SHARES the one process-wide tessellated context (VEC-04): this
        // Graphics owns no geometry of its own and is never redrawn for any reason.
        const glyph = new Graphics(getAssetContext(subject));
        const chassis = new Graphics();
        const notch = new Graphics();
        const ring = new Graphics();
        // Labelled so a spec (and a live Pixi devtools tree) addresses these by NAME
        // rather than by child index - an index assertion silently follows a
        // z-order change instead of reddening on it.
        body.label = 'machine-body';
        chassis.label = 'machine-chassis';
        notch.label = 'machine-notch';
        glyph.label = 'machine-glyph';
        ring.label = 'machine-alert-ring';
        // THE NOTCH IS PLOTTED EXACTLY HERE, ONCE, and never again: a 6u x
        // strokeStructural mark centred on its own origin. Everything the animation
        // does afterwards is a transform, which is what makes MOTION-05 a structural
        // property of this layer rather than a discipline someone has to remember.
        drawNotch(notch, skin);
        notch.visible = false;
        // Chassis, then the notch that cuts it, then the glyph, then the alarm over
        // everything. The notch must sit ABOVE the chassis or it does not cut it.
        body.addChild(chassis, notch, glyph, ring);
        entry.body = body;
        entry.glyph = glyph;
        entry.chassis = chassis;
        entry.notch = notch;
        entry.ring = ring;
        // Under the nubs, exactly where the sprite sat.
        entry.root.addChildAt(body, 0);
      }
      if (entry.body !== undefined) {
        entry.body.visible = vector;
        // Placed and rotated EXACTLY as the sprite is: same centre position, same
        // quarter-turn, and `pivot` at the UNROTATED box centre - which is what
        // `sprite.anchor.set(0.5)` means on a texture baked at native (w, h). The two
        // paths therefore land on the same device pixels for the same node.
        entry.body.position.set((ew * CELL) / 2, (eh * CELL) / 2);
        entry.body.rotation = node.rot * (Math.PI / 2);
        entry.body.pivot.set((node.w * CELL) / 2, (node.h * CELL) / 2);
      }

      // ---- THE ONLY PER-FRAME WORK IN THIS LAYER (MOTION-05) ------------------
      // Two transforms and one alpha. No `clear()`, no re-plot, no `cache.get`, no
      // new GraphicsContext. Everything else about a machine changes only when its
      // signature does, which is the guard further down.
      //
      // Both cues are gated on `vector` as well as on state: below the LOD cut the
      // block's corner pip carries state, and a sub-pixel notch or blink would read as
      // speckle rather than as information (READ-05, the same reasoning that gates the
      // port nubs off down there).
      if (vector && entry.notch !== undefined && node.state === state_tag.WORKING) {
        // MOTION-01: the ONE pinned quantized frame, shared with the belt tread and
        // the item slide. A pure integer function of it (T-58-12: read, never written
        // back into the camera, the scene, a GridCommand or scene.tick).
        const place = resolveNotch(notchOffset(frame, node.w, node.h), node.w, node.h);
        entry.notch.position.set(place.x, place.y);
        entry.notch.rotation = place.rotation;
      }
      if (vector && entry.ring !== undefined && node.state === state_tag.FAULTED) {
        // The SHIPPED cadence, phase-desynced on the STABLE origin cell so a grid full
        // of faults never reads as one synchronized pulse and a machine that stays put
        // keeps its phase across undo / redo / load.
        entry.ring.alpha = alertRingAlpha(frame, node.cell_x, node.cell_y);
      }

      // BELOW THE CUT ONLY. The block is state-static (its corner pip carries the
      // state, not a sweep) so the frame term is pinned to 0 and a WORKING machine
      // never spawns 24 per-frame block textures.
      //
      // The `|lod` marker keeps the block a DISTINCT cached texture variant (T-33-BAKE)
      // rather than a live sprite.alpha/tint mutation, and it is kept even though the
      // full-detail key it used to disambiguate from no longer exists: the cache is
      // shared with any future variant and an unmarked key would read as "the machine
      // texture" to the next author. RENDER-01: the `|WxH` footprint token makes a
      // resize (Router port add, 2x3 -> 2x4) a distinct entry so it re-bakes at the new
      // box instead of returning a stale sprite. `|rot` keeps rotated variants apart,
      // so a Rotate is a cached-texture SWAP and never a re-plot (MOTION-05).
      //
      // THE ENDPOINT HAS NO `GenKey` (see the two keyspaces above), SO IT TAKES THE
      // SECOND BAKER. It drew NOTHING down here until 66-03, which meant a hand-placed
      // HTTP Endpoint simply vanished the moment you zoomed out - on the phase that makes
      // endpoints placeable. It is a PRESENCE BLOCK in the structural ink (`ramp[4]`)
      // with the same state pip and NO kind corner code, and it is emphatically NOT a
      // ninth kind: `makeEndpointPresenceBlock` carries the measured reason, which is
      // that both the hue set and the three-bit code space are full. A later reader must
      // not cite this branch as evidence that a ninth hue or a ninth code was approved.
      //
      // The branch is still written as an explicit `undefined` check rather than left to
      // `lodBlocks[undefined]`, which is the shape of the crash T-58-11 records.
      const genKey = GEN_KEY_OF[node.kind];
      const isEndpoint = node.kind === machine_kind.ENDPOINT;
      if (lod && (genKey !== undefined || isEndpoint)) {
        const key = `${cacheKey(node.kind, node.state, 0)}|${node.w}x${node.h}|${node.rot}|lod`;
        const bake =
          genKey !== undefined
            ? () => lodBlocks[genKey](node.state as StateTag, node.w, node.h)
            : () => endpointBlock(node.state as StateTag, node.w, node.h);
        entry.sprite.texture = cache.get(key, bake) as unknown as Texture;
      }
      // ...and a Sprite with no block at all stays textureless, so `!vector` alone would
      // show an empty white Pixi default. Gate on the block actually existing. Kind 8
      // (WIRE) is the remaining case: it is a transport seam, never a node here.
      entry.sprite.visible = lod && (genKey !== undefined || isEndpoint);

      // Recolor the nub overlay only when identity/state/orientation/PORT LIST/LOD
      // changes. `lod`
      // is folded into the signature so a zoom PAST the cut gates the nubs off (the
      // block carries state - thin port nubs would be sub-pixel speckle) and a zoom
      // BACK IN re-runs rebuildNubs (the signature flips 'full'->'lod'->'full'), keeping
      // the bookkeeping honest.
      // `node.load` is folded in (71-06) so a machine filling from 2 to 3 re-plots its
      // gauge. Without it the gauge would be plotted on a stale signature and a load
      // change would draw nothing at all, which is the whole cue silently dead.
      // `portFingerprint(node)` is folded in (73-10) for that same failure shape one cue
      // over, found on the real binary on the phase-73 walk: see that function's own
      // comment for the measurement and for why a bare port COUNT is not enough.
      // 73-12 (73-REVIEW WR-06): the fingerprint is SKIPPED on an LOD frame, where its
      // value decides nothing - the branch below clears the nubs whatever the ports say.
      // It was being built per node per draw at 60 fps for a decision that had already
      // been made, which on a dense board is thousands of short-lived strings a second in
      // the render hot path. The `'lod'`/`'full'` token still forces a rebuild on the
      // zoom-back-in transition, so the LOD-exit re-plot is unaffected: the signature
      // changes shape at the boundary, not merely in its tail.
      const base = `${node.kind}|${node.state}|${node.load}|${node.w}|${node.h}|${node.rot}`;
      const sig = lod ? `${base}|lod` : `${base}|full|${portFingerprint(node)}`;
      if (sig !== entry.signature) {
        if (lod) {
          entry.nubs.clear(); // gate off at LOD - the block carries state
        } else {
          rebuildNubs(entry.nubs, node);
        }
        // MOTION-05: the chassis is re-plotted ONLY here, behind the same identity/
        // state/footprint/orientation guard the nubs sit behind - never per frame.
        if (vector && entry.chassis !== undefined && entry.glyph !== undefined) {
          drawChassis(entry.chassis, node.w, node.h, skin, node.state);

          // THE GLYPH FOLLOWS A KIND CHANGE (WR-07). `kind` is the first token of `sig`
          // and everything else keyed on it is rebuilt here, but the glyph used to be
          // created once from `getAssetContext(subject)` and never re-pointed - so
          // drawing handle 1 as a TEE and then as a MERGE left the TEE artwork on the
          // board. This IS reachable in production: `RenderProducer::reset`
          // (crates/fabrico-host/src/render_packet.rs) builds a fresh packet builder whose
          // handles restart at 0 on every Load, New, LoadDemo and every tick that folds an
          // Undo or Redo (sim_loop.rs), after which handles are the nodes' rank in NodeId
          // order, so one handle can name a Source before a keyframe and a Sink after it.
          // A change across the machine and label boundary is handled by the removal
          // loops at the top of `draw()` (CR-01, `machineEntryStays` and `labelBoxStays`);
          // a change between two machine kinds keeps the entry and lands HERE (live leg 4
          // of 76-label-handle-reuse.live.spec.ts grades it through `glyphSubjectOn`, a
          // Source's handle handed to a Sink by a Redo; plan 76-13's mutation G, this
          // statement deleted, is what reddens that leg). Assigning
          // through the SETTER is what makes this safe: it is the one Pixi path that
          // `off()`s the previous context, so it composes with `detachSharedContext`
          // rather than fighting it.
          const wantContext = getAssetContext(subject);
          if (entry.glyph.context !== wantContext) entry.glyph.context = wantContext;

          // CENTRE THE AUTHOR BOX, not the ink. The glyph is deliberately asymmetric
          // (TEE is east-heavy - that is the gated discriminator), so centring its
          // tessellated bounds would slide it off the position it was authored at and
          // quietly undo the composition. The author box comes from the file's own
          // `viewBox` (`getAssetBox`), in `u`.
          //
          // THE UNITS ARE CONVERTED, NOT ASSUMED EQUAL (WR-08). `box` is in `u` and
          // `node.w * CELL` is in px; this used to subtract one from the other directly
          // and was correct only because `CELL === U_PER_CELL === 32`. That is exactly
          // the coincidence `machineChassis.ts` introduced `uToPx()` to stop relying on.
          // The glyph's own tessellated geometry is in unscaled user units too, so the
          // scale is the other half of the same conversion: without it a `CELL` change
          // would scale the chassis and leave the glyph behind. `glyphFit` does both
          // halves: its scale is `U_TO_PX` times a fit factor, and its position is in px.
          //
          // NO GLYPH IS DRAWN PAST ITS MACHINE (plan 85-02, D-24). `glyphFit` shrinks a
          // glyph whose author box is larger than the footprint (`node.w`/`node.h` are the
          // UNROTATED box, the body is rotated about its centre above) and never grows one;
          // at catalog size it is exactly `U_TO_PX` and the old centring, so nothing moves.
          const fit = glyphFit(node.w, node.h, getAssetBox(subject));
          entry.glyph.scale.set(fit.scale);
          entry.glyph.position.set(fit.x, fit.y);
        }
        // THE TWO STATE CUES, gated here rather than per frame. The notch's geometry
        // was plotted once at construction so it only needs showing or hiding; the
        // ring is genuinely PLOTTED AND UNPLOTTED, so "a ring exists when and only
        // when a node is FAULTED" is true of the geometry and not merely of a
        // visibility flag that a later reader could flip by accident.
        if (vector && entry.notch !== undefined && entry.ring !== undefined) {
          entry.notch.visible = node.state === state_tag.WORKING;
          if (node.state === state_tag.FAULTED) {
            drawAlertRing(entry.ring, node.w, node.h, skin);
          } else {
            entry.ring.clear();
          }
        }
        // THE THIRD CUE (71-06), on the RING's plot/unplot form. `drawLoadGauge` is total
        // over the byte and plots nothing at `load <= 0`, so the vector branch hands it
        // the raw wire byte and lets it decide; below the cut the gauge is gated off with
        // the other vector cues and the block's pip stack carries the state instead.
        if (vector) {
          drawLoadGauge(entry.gauge, node.load, node.w, node.h, skin);
        } else {
          entry.gauge.clear();
        }
        // MEMBERSHIP IS READ BACK OFF THE GRAPHICS, not inferred from the byte that was
        // just passed in. `node.load > 0` here would make the probe agree with the model
        // for any drawing function whatsoever, including one that draws nothing - the
        // vacuous shape the whole hook exists to avoid.
        if (entry.gauge.context.instructions.length > 0) {
          gaugesPainted.add(node.id);
        } else {
          gaugesPainted.delete(node.id);
        }
        entry.signature = sig;
      }
    }
  };

  return {
    layer,
    draw,
    loadGaugesPainted: () => gaugesPainted.size,
    loadGaugePaintedOn: (id: number) => gaugesPainted.has(id),
    // Straight off the live Graphics - see the interface docblock for why this one
    // keeps no set. A node with no entry (never drawn, or swept on destruction)
    // answers 0, which is the same answer as "drew nothing" and is the truthful one:
    // in both cases there are no nubs on the screen.
    portNubInstructionsOn: (id: number) => entries.get(id)?.nubs.context.instructions.length ?? 0,
    // Plan 77-07: the gauge's drawn form and the tick it was drawn from, straight off the
    // live Graphics. See the interface docblock.
    loadGaugeFormOn: (id: number) => {
      const entry = entries.get(id);
      return entry === undefined ? null : readLoadGaugeForm(entry.gauge, drawnAtTick, gaugeInk(skin));
    },
    labelBoxOn: (id: number) => {
      const box = labelBoxes.get(id);
      return box ? readLabelBox(box.g) : null;
    },
    // Plan 76-08: the census, off the display list. See the interface docblock.
    drawnNodes: () => {
      const machines = [...entries]
        .filter(([, e]) => e.root.parent === layer)
        .map(([h]) => h)
        .sort((a, b) => a - b);
      const labels = [...labelBoxes]
        .filter(([, b]) => b.g.parent === layer)
        .map(([h]) => h)
        .sort((a, b) => a - b);
      return { machines, labels, strays: layer.children.length - machines.length - labels.length };
    },
    // Plan 76-08: the art a root draws, off the glyph's current context. See the
    // interface docblock for why a hidden body answers null and why it peeks.
    glyphSubjectOn: (id: number) => drawnGlyphSubject(entries.get(id)),
    // Plan 85-02: the glyph's drawn box and the machine's footprint, off the Pixi objects.
    // See the interface docblock.
    glyphBoxOn: (id: number) => {
      const entry = entries.get(id);
      const subject = drawnGlyphSubject(entry);
      if (subject === null || entry?.glyph === undefined || entry.body === undefined) return null;
      const box = getAssetBox(subject);
      return {
        x: entry.glyph.position.x,
        y: entry.glyph.position.y,
        w: box.w * entry.glyph.scale.x,
        h: box.h * entry.glyph.scale.y,
        footW: entry.body.pivot.x * 2,
        footH: entry.body.pivot.y * 2,
      };
    },
  };
}
