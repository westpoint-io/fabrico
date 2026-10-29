// The pure sprite generators (SYNTH-01, SYNTH-05). The ONLY entry point is
// `makeGenerators(skin, nativeCell = 32)`: it validates the skin FIRST, bakes the
// ramp once, and closes over both so no sprite can bypass the schema (research
// Pattern 1). Each returned generator is a pure function `(state, frame) ->
// PixelMatrix`: identical inputs always yield a byte-identical Uint8ClampedArray
// (research Pitfall 5 - integer-only math, array iteration, no Math.random / no
// Date.now / no float accumulation into pixel bytes).
//
// `nativeCell` is the sprite's native px PER GRID CELL and is an EXPLICIT
// parameter, deliberately decoupled from the world CELL (48). Defaulting it to 32
// (the SYNTH-01 spec) while letting Plan 03 pass 48 is exactly what lets that plan
// generate a GENUINE 32-native FACTORY (96x96) AND a GENUINE 48-native FACTORY
// (144x144) for the SYNTH-06 comparison - each rendered pixel-exact 1:1, never a
// 32->48 upscale (research Pitfall 1: 32 does not divide 48 under integer
// scaling). This module does NOT change the world grid.

//
// WHAT IS LEFT HERE AFTER PLAN 61-07, AND WHY IT IS NOT THE CANVAS RENDER PATH.
// Plan 58-03 moved the machine body to vector and plans 61-02/61-03 moved the belt,
// so NOTHING in this module reaches the shipped canvas any more. It survives for ONE
// live consumer: the art board's slate module, in the dev-tooling directory
// `src/spike/`, which renders the Phase 57 art board's
// pinned historical TODAY pixel column through `makeGenerators` so the 1.77x
// degradation claim is produced by the resampler that actually produced it. `spike/`
// is developer tooling, not the render path, so VEC-01 does not reach it
// (`61-CONTEXT.md` section F). Every symbol VEC-01 DID reach - the shared bezel
// painter, its options type, the three pixel-era holdover constants, and the four
// belt bakes with their injectable painter seam - was deleted by plan 61-07; what
// remains of each is inlined at its single call site below, with no exported name
// for a future caller to reach for.

import { machine_kind, state_tag, type StateTag } from '../../protocol/kinds.ts';
import { effectiveBox } from '../../protocol/footprint.ts';
import { validate, type Skin } from './skin.ts';
import { bakeRamp, rampStep } from './palette.ts';
import { getGlyph, stampGlyph } from './glyphs.ts';
import { makeMatrix, type PixelMatrix, type Rect } from './types.ts';

// ============================================================================
// THE PIXEL-ERA HOLDOVER CONSTANTS ARE GONE (plan 61-07 - the deletion Phase 59
// deferred here, `WINDOWS.md` row 37, on the promise that this phase would take them).
// ----------------------------------------------------------------------------
// The bevel band depth, the inner outline thickness and the shipped corner-style enum
// used to be axes on the `Skin` interface, then named module constants held for two
// legacy pixel bakes. Both bakes are gone: the shared bezel painter and its options type
// left with them, and the four belt bakes left in the same plan. The two band
// thicknesses are now inline literals at the ONE place that still paints a historical
// machine body - `makeGenerators` below - carrying the values `LOCKED_SKIN` held, and
// the `'clipped'` corner treatment is deleted outright because no shipped surface could
// ever select it (only a spec could, and that spec retired with its subject).
//
// THE DELETED NAMES ARE DELIBERATELY NOT WRITTEN DOWN ANYWHERE IN THIS TREE, including
// here. A mutation-history comment that spells a symbol which no longer exists sends the
// next reader looking for it and reads as though the thing were merely moved; the
// deletion set lives in `61-07-SUMMARY.md`, which is the right place for a list of names
// nothing can resolve.
//
// PHASE 59'S OPEN GATE IS THEREFORE CLOSED BY DELETION, NOT BY A NEW BASELINE. Phase 59
// recorded that a wrong corner-style value reddened three unit cases in one spec and
// ZERO Playwright cases, and accepted that unit-only gate "for one more phase" because a
// canvas baseline written then would be blessed and deleted one phase later. That is
// what happened: the constant no longer exists, so there is nothing left to gate. The
// fallback that phase named - writing the canvas baseline here instead - is NOT owed,
// because it was owed only if this deletion slipped. `WINDOWS.md` row 37 closes here.
// ----------------------------------------------------------------------------

/**
 * A single pure per-kind generator. `w`/`h` are the PER-NODE footprint (from
 * `node.w/h` over the render packet); they default to the kind's KIND_SPECS base
 * so a 2-arg caller still bakes the honest default (RENDER-01). The sprite is baked
 * at NATIVE `w x h` (rot 0); rotation stays a `sprite.rotation` + a separate cache
 * term, never a baked rot-swap.
 */
export type Generator = (state: StateTag, frame: number, w?: number, h?: number) => PixelMatrix;

/** The named generator keys - one per machine_kind. */
export type GenKey =
  | 'source'
  | 'belt'
  | 'factory'
  | 'tee'
  | 'balancer'
  | 'router'
  | 'merge'
  | 'sink';

/** The frozen record of generators returned by `makeGenerators`. */
export type GeneratorSet = Readonly<Record<GenKey, Generator>>;

/** The default native cell size - the SYNTH-01 spec (32px per grid cell). */
export const DEFAULT_NATIVE_CELL = 32;


// Explicit, ordered kind spec: [key, machine_kind byte, DEFAULT footprint w, h].
// Ordered as an array (never object-key iteration) to keep construction
// deterministic. KIND_SPECS carries each kind's per-kind DEFAULT footprint and the
// kind/byte ORDERING; it is NOT the runtime sizing authority. Per-node `node.w/h`
// (which flow over the render packet) are the authority and OVERRIDE these defaults
// at call time (RENDER-01) - a Router that gains/loses a port resizes past its 2x3
// default. The defaults mirror `crates/fabrico-core` `base_footprint`: multi-port
// operators Tee/Balancer/Merge are 2x2, Router is 2x3, the FACTORY hero is 3x3, and
// Source/Belt/Sink are 1x1.
const KIND_SPECS: ReadonlyArray<readonly [GenKey, number, number, number]> = [
  ['source', machine_kind.SOURCE, 1, 1],
  ['belt', machine_kind.BELT, 1, 1],
  ['factory', machine_kind.FACTORY, 3, 3],
  ['tee', machine_kind.TEE, 2, 2],
  ['balancer', machine_kind.BALANCER, 2, 2],
  ['router', machine_kind.ROUTER, 2, 3],
  ['merge', machine_kind.MERGE, 2, 2],
  ['sink', machine_kind.SINK, 1, 1],
];

/** Paint a solid integer-color rectangle (full alpha), clamped to the matrix. */
function paintRect(m: PixelMatrix, x0: number, y0: number, w: number, h: number, color: number): void {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const yEnd = y0 + h;
  const xEnd = x0 + w;
  for (let y = y0; y < yEnd; y++) {
    if (y < 0 || y >= m.height) continue;
    for (let x = x0; x < xEnd; x++) {
      if (x < 0 || x >= m.width) continue;
      const idx = (y * m.width + x) * 4;
      m.data[idx] = r;
      m.data[idx + 1] = g;
      m.data[idx + 2] = b;
      m.data[idx + 3] = 255;
    }
  }
}

/**
 * Write one opaque pixel of an integer color, clamped to the matrix.
 *
 * UN-EXPORTED BY PLAN 61-07. It was exported for the Phase 53 direction modules
 * (`kit/variants/direction*.ts`), whose injected pattern painters wrote pixels through
 * one shared writer rather than hand-rolling their own byte-packing. Those modules were
 * deleted in 54-03, the injectable belt painter seam they fed left with the belt bakes
 * in 61-07, and a re-run consumer grep over `frontend/{src,shared,e2e,e2e-live}` found
 * ZERO importers outside this file - so the export was a door onto a room nobody enters.
 */
function putPixel(m: PixelMatrix, x: number, y: number, color: number): void {
  if (x < 0 || x >= m.width || y < 0 || y >= m.height) return;
  const idx = (y * m.width + x) * 4;
  m.data[idx] = (color >> 16) & 0xff;
  m.data[idx + 1] = (color >> 8) & 0xff;
  m.data[idx + 2] = color & 0xff;
  m.data[idx + 3] = 255;
}

/**
 * The steady WORKING body-tint blend strength (READ-03), in integer PERCENT
 * (`a ~= 0.20`). Tint alpha is a free choice; 20% covers the
 * whole body with a legible emerald cast while keeping the glyph-ink contrast above
 * the READ-06 floor on the shipped LOCKED_SKIN (idle 119 -> tinted 101 luma delta).
 */
export const WORKING_TINT_PCT = 20;

/**
 * Integer per-channel blend of `base` toward `accent` by `pct`% (0..100), returned
 * as a packed 0xRRGGBB int. Pure integer math (`round((base*(100-pct)+accent*pct)/100)`
 * per channel) - no float is ever written into a pixel byte, so the bake stays
 * deterministic and portable (the synth discipline, module header). The caller
 * writes the result at A=255, keeping the whole tint byte-lossless (MOTION-05).
 */
export function tintColor(base: number, accent: number, pct: number): number {
  const p = pct < 0 ? 0 : pct > 100 ? 100 : Math.floor(pct);
  const q = 100 - p;
  const br = (base >> 16) & 0xff;
  const bg = (base >> 8) & 0xff;
  const bb = base & 0xff;
  const ar = (accent >> 16) & 0xff;
  const ag = (accent >> 8) & 0xff;
  const ab = accent & 0xff;
  const r = ((br * q + ar * p + 50) / 100) | 0;
  const g = ((bg * q + ag * p + 50) / 100) | 0;
  const b = ((bb * q + ab * p + 50) / 100) | 0;
  return (r << 16) | (g << 8) | b;
}

/**
 * Bake the steady WORKING whole-body tint (READ-03) IN PLACE, BEFORE the glyph is
 * stamped. Every opaque (A=255) body pixel - fill, bevel, and inner outline - is
 * blended toward the working accent, so the machine carries a colour + whole-body
 * shape cue that is legible even when the sim is PAUSED (frame 0), on par with the
 * static FAULTED marker. Because this runs pre-stamp, the glyph ink (written after)
 * lands ON TOP and survives (Pitfall 1: a tint applied AFTER the stamp swallows the
 * glyph). Transparent/cleared corners (A=0) are skipped and the alpha byte is left
 * at 255 (byte-lossless). Pure and integer-only.
 */
function tintWorkingBody(m: PixelMatrix, working: number): void {
  const p = WORKING_TINT_PCT;
  const q = 100 - p;
  const ar = (working >> 16) & 0xff;
  const ag = (working >> 8) & 0xff;
  const ab = working & 0xff;
  const data = m.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) continue; // opaque body pixels only (skip cleared A=0)
    data[i] = ((data[i] * q + ar * p + 50) / 100) | 0;
    data[i + 1] = ((data[i + 1] * q + ag * p + 50) / 100) | 0;
    data[i + 2] = ((data[i + 2] * q + ab * p + 50) / 100) | 0;
    // Alpha stays 255 - byte-lossless, never a partial-alpha (MOTION-05).
  }
}

/**
 * Apply the per-state cue as a PURE integer function of `state` and `frame`
 * (never wall-clock). `frame` only modulates the WORKING sweep position; IDLE and
 * FAULTED ignore it. Overlays draw on top of the glyph so state is legible.
 */
function applyStateCue(
  m: PixelMatrix,
  state: StateTag,
  frame: number,
  inner: Rect,
  skin: Skin,
): void {
  if (state === state_tag.WORKING) {
    // The WORKING LIVENESS layer ONLY: a single accent pixel sweeping along the
    // inner top edge; its x is a pure integer function of `frame` so animation is
    // deterministic and replayable. The steady WHOLE-BODY tint (the paused/steady
    // signal) is baked PRE-STAMP in makeGenerators via tintWorkingBody, NOT here -
    // a whole-body tint at this LAST step would paint over the glyph (Pitfall 1).
    const span = inner.w - 2;
    if (span > 0) {
      const x = inner.x + 1 + (((frame % span) + span) % span);
      putPixel(m, x, inner.y + 1, skin.palette.accents.working);
    }
    return;
  }
  if (state === state_tag.FAULTED) {
    // MOTION-03: the STEADY fault TRIM - the always-on colour + shape floor baked
    // into the body. A 1px fault-accent bar along the inner top edge (the fault
    // sibling of the WORKING trim) plus a 2x2 corner marker for shape redundancy.
    // This survived the pulsing overlay's alpha trough and any paused/frozen frame
    // (VIS-03 colour-blind guarantee: the alarm can never become invisible). It is now
    // the WHOLE of the baked fault cue: the separately baked pulsing overlay that used
    // to carry the blink on top was deleted by plan 61-07 (see the banner below), and
    // the blink itself moved to the board-drawn alert ring in plan 58-03.
    const fault = skin.palette.accents.fault;
    paintRect(m, inner.x, inner.y, inner.w, 1, fault); // steady top trim bar
    paintRect(m, inner.x + 1, inner.y + 1, 2, 2, fault); // steady corner marker (shape)
  }
}

// ---------------------------------------------------------------------------
// THE PULSING FAULT-OVERLAY BAKE AND ITS SET BUILDER ARE DELETED (plan 61-07,
// 2026-08-11), ON A GREP AND NOT ON AN ASSUMPTION.
//
// They were flagged as UNDECIDED by `61-RESEARCH.md` Open Question 4 - dead canvas-bake
// code with a test but no caller - precisely because a previous pass had left them
// unremarked. Leaving them unremarked a second time was the failure mode, so the
// decision is recorded here rather than only in a summary.
//
// THE GREP, re-run over `frontend/{src,shared,e2e,e2e-live}` at deletion time:
//   - the per-kind bake: ZERO real code consumers outside this file (its only caller
//     WAS the set builder below), ONE test case in `generators.test.ts`, one comment;
//   - the set builder: ZERO consumers of any kind outside this file - four comment
//     mentions in `layers/lodTints.ts` and its spec, and one in `layers/machines.ts`
//     which already RECORDED that both were gone from the render path (plan 58-03,
//     when the fault marker's job moved to the board-drawn alert ring).
//
// So the render path had no caller, the only consumer was a test of the thing itself,
// and a test whose subject has no other reader is not coverage. The four sibling
// comments that claimed PARITY with the set builder are corrected in the same commit:
// parity with a deleted thing is not a contract.
//
// WHAT STILL CARRIES THE FAULT CUE, so this reads as a deletion rather than a loss: the
// STEADY fault trim baked into the FAULTED body by `applyStateCue` below (the always-on
// colour + shape floor, VIS-03), and the board-drawn alert ring the machine layer
// animates. Neither was ever this bake.
// ---------------------------------------------------------------------------

/**
 * The historical bevel band depth and inner-outline thickness, in px.
 *
 * INLINE LITERALS SINCE PLAN 61-07, not named exported constants, and the difference is
 * the whole point: as two exported pixel-era holdover constants they were reachable from
 * anywhere and read as live style axes; as two locals inside the one function that still
 * paints a historical body they are what they actually are - the values `LOCKED_SKIN`
 * held when the machine was pixels. Both were 1.
 */
const HISTORICAL_BAND_DEPTH = 1;
const HISTORICAL_OUTLINE_PX = 1;

/**
 * The historical belt tile's ramp INDICES, and the discipline that outlives the record
 * they used to live on.
 *
 * The raster bakes' frozen ink record (rail 4 INVERTED / interior 0 hollow / ink 4) was
 * deleted with them by plan 61-07. THE DISCIPLINE IT CARRIED IS NOT DELETED, AND MUST
 * NOT BE: every
 * belt colour is an INDEX into `skin.palette.ramp`, resolved through `rampStep` - never
 * a hex, never a computed tint, never a brightness multiply. That is what makes "no
 * brightness multiply" enforceable at the data layer rather than by convention (see the
 * `palette.ts` header). The SHIPPED vector belt carries the same three indices forward
 * in `beltPainter.ts buildBeltContext`, which resolves them exactly this way; these
 * three are the HISTORICAL copy, deliberately frozen here rather than imported from the
 * live painter, because a historical reference that moved when the shipped look moved
 * would stop being a reference.
 */
const HISTORICAL_BELT_RAIL_RAMP = 4;
const HISTORICAL_BELT_INTERIOR_RAMP = 0;
const HISTORICAL_BELT_INK_RAMP = 4;

/** The historical tread dash: 10px run, 6px gap, 16px repeat (53-BELT-LOCK.md axis 1). */
const HISTORICAL_DASH = 10;
const HISTORICAL_DASH_REPEAT = 16;

/**
 * Paint the HISTORICAL raster straight-belt tile at its RESTING phase.
 *
 * WHAT THIS IS AND IS NOT. It is not the belt Fabrico draws: plans 61-02/61-03 made
 * every belt asset resolution-independent vector geometry (`synth/beltGeometry.ts` +
 * `synth/beltPainter.ts`), and plan 61-07 deleted the four raster bakes, their
 * injectable painter seam and the welded march constants outright. What survives is the
 * single still that the Phase 57 art board's TODAY column pins - the pixel-era belt at
 * the resting phase, nearest-sampled at 1.00x / 1.77x / 2.00x, which is the evidence for
 * this milestone's central visual claim and cannot be produced by any other resampler.
 *
 * THE MARCH IS GONE, DELIBERATELY. The board bakes IDLE at frame 0 and only frame 0, so
 * reproducing `phase * step` here would have kept the welded `pitch / K` arithmetic
 * alive to serve a caller that never varies the phase. `frame` is therefore ignored for
 * the belt kind, which is stated here rather than left to be discovered from the
 * signature.
 *
 * Body: a flat hollow interior at ramp 0 flanked by two 1px INVERTED hairline rails at
 * ramp 4 - identical on BOTH edges with no light flip, which is why the belt never
 * delegated to the bezel body (a top-left light source FLIPS under a 90deg tile
 * rotation, producing a per-cell lighting seam). Then the centreline dash at ramp 4 on
 * the two rows straddling the tile's true centre, painted over the FULL flow axis (the
 * dead-band fix, WINDOWS id 5) so abutting tiles are dash-continuous.
 */
function paintHistoricalBeltTile(m: PixelMatrix, skin: Skin): void {
  const steps = skin.palette.ramp;
  const interior = rampStep(steps, HISTORICAL_BELT_INTERIOR_RAMP);
  const rail = rampStep(steps, HISTORICAL_BELT_RAIL_RAMP);
  const ink = rampStep(steps, HISTORICAL_BELT_INK_RAMP);
  const N = m.width;
  paintRect(m, 0, 0, N, m.height, interior); // flat interior (no gradient)
  paintRect(m, 0, 0, N, 1, rail); // top rail (flow-parallel edge)
  paintRect(m, 0, m.height - 1, N, 1, rail); // bottom rail (same INVERTED step)
  const lower = m.height >> 1;
  const upper = lower - 1;
  for (let x = 0; x < N; x++) {
    if (x % HISTORICAL_DASH_REPEAT < HISTORICAL_DASH) {
      putPixel(m, x, upper, ink);
      putPixel(m, x, lower, ink);
    }
  }
}

/**
 * Validate the skin, bake its ramp once, and return a FROZEN record of pure
 * per-kind generators sized to `nativeCell`. There is no way to obtain a
 * generator without passing (and thereby validating) a skin - the closure IS the
 * schema enforcement (SYNTH-04 / research Pattern 1).
 *
 * @param skin       The single styling input; validated before any pixel is made.
 * @param nativeCell Native px per grid cell (default 32). A 3x3 FACTORY emits a
 *                   `3*nativeCell` square; a 1x1 kind emits a `nativeCell` square.
 */
export function makeGenerators(skin: Skin, nativeCell: number = DEFAULT_NATIVE_CELL): GeneratorSet {
  validate(skin);
  const ramp = bakeRamp(skin);
  const depth = HISTORICAL_BAND_DEPTH;
  const outlineThickness = HISTORICAL_OUTLINE_PX;

  const set = {} as Record<GenKey, Generator>;
  for (let i = 0; i < KIND_SPECS.length; i++) {
    const [key, kind, baseW, baseH] = KIND_SPECS[i];
    const glyph = getGlyph(kind);
    const isBelt = key === 'belt';
    set[key] = (state: StateTag, frame: number, w: number = baseW, h: number = baseH): PixelMatrix => {
      // RENDER-01: size the bake PER CALL from the per-node footprint (defaulting to
      // this kind's KIND_SPECS base), so a resized operator (e.g. a Router growing
      // 2x3 -> 2x4) re-bakes at the new box instead of the stale default. Derive the
      // multi-cell extent from the shared footprint primitive at rot=0 (native
      // orientation) - rotation is a sprite transform + a separate cache term, never
      // a baked rot-swap.
      const { ew, eh } = effectiveBox(w, h, 0);
      const width = ew * nativeCell;
      const height = eh * nativeCell;
      if (isBelt) {
        // FLOW-02: the belt is a rotation-invariant TRACK, not a machine box, so it
        // never took the bezel body (whose top-left light source FLIPS under a 90deg
        // tile rotation). It used to delegate to a module-level straight-tile bake that
        // was literally the same function as `SHIPPED_PAINTER.straight`; plan 61-03 made
        // that painter vector and plan 61-07 deleted the bake, so the two paths CANNOT
        // drift for the simplest possible reason - only one of them still draws anything
        // the app shows.
        //
        // `width`/`height` are not passed because the tile is square in `nativeCell`
        // and the BELT kind is 1x1 in KIND_SPECS: `effectiveBox(1,1,0)` is the
        // identity, so `width === height === nativeCell` on every path (belt tiles
        // are drawn by `belts.ts`, never resized, and core's `base_footprint` for
        // BELT is 1x1). A multi-cell belt is not a thing this renderer or the core
        // can produce. `frame` is ignored - see `paintHistoricalBeltTile`.
        const tile = makeMatrix(nativeCell, nativeCell);
        paintHistoricalBeltTile(tile, skin);
        return tile;
      }
      // THE HISTORICAL MACHINE BODY, INLINED HERE BY PLAN 61-07 (it was the shared bezel
      // painter, deleted with its options type and the three holdover constants).
      // Banding order is byte-preserved from that painter, because the art board's
      // TODAY column is a pinned historical reference and a re-ordered band would move
      // it: body fill, then the light band on top + left, then the shadow band on
      // bottom + right painted AFTER so the bottom-right corners resolve to shadow (one
      // globally consistent top-left light source), then the inner definition outline.
      // No brightness or alpha multiply anywhere - every colour is an actual ramp entry
      // (SYNTH-05). The `hollow` and `'clipped'`-corner branches are NOT reproduced:
      // this call site always passed `hollow:false` and the square corner, and no other
      // caller survives to pass anything else.
      const m = makeMatrix(width, height);
      paintRect(m, 0, 0, width, height, ramp.fill);
      paintRect(m, 0, 0, width, depth, ramp.tlLight); // top edge
      paintRect(m, 0, 0, depth, height, ramp.tlLight); // left edge
      paintRect(m, 0, height - depth, width, depth, ramp.brShadow); // bottom edge
      paintRect(m, width - depth, 0, depth, height, ramp.brShadow); // right edge
      // Inner definition outline just inside the bevel ring (fixed brShadow index).
      // Four thin border strips only - the glyph area stays `ramp.fill`.
      const iw = width - 2 * depth;
      const ih = height - 2 * depth;
      if (iw > 0 && ih > 0) {
        paintRect(m, depth, depth, iw, outlineThickness, ramp.brShadow); // inner top
        paintRect(m, depth, depth + ih - outlineThickness, iw, outlineThickness, ramp.brShadow);
        paintRect(m, depth, depth, outlineThickness, ih, ramp.brShadow); // inner left
        paintRect(m, depth + iw - outlineThickness, depth, outlineThickness, ih, ramp.brShadow);
      }
      const inner: Rect = { x: depth, y: depth, w: width - 2 * depth, h: height - 2 * depth };
      // READ-03: bake the steady WORKING body tint BEFORE the glyph is stamped so
      // the glyph ink survives ON the tint (Pitfall 1 - a tint applied in the LAST
      // step, applyStateCue, would paint OVER the glyph and swallow the identity).
      // The tint carries the paused/steady WORKING signal (colour + whole-body
      // shape), on par with the static FAULTED marker; the sweeping motion pixel
      // stays in applyStateCue as the liveness layer on top. WORKING-only: IDLE and
      // FAULTED bytes are untouched. Cache key already separates WORKING (no new key).
      if (state === state_tag.WORKING) {
        tintWorkingBody(m, skin.palette.accents.working);
      }
      // READ-04: scale the identity glyph to the body inner-rect so a multi-cell
      // FACTORY (3x3) reads the strongest glyph on the board while a 1x1 kind stays
      // proportionally smaller. Integer nearest-neighbour only; the per-pixel crop
      // clamp in stampGlyph guarantees safety regardless of the target fraction, so
      // an over-eager scale can never overflow the body. ~0.7 of the inner min
      // dimension keeps a comfortable margin. gw/gh come from the resolved glyph.
      const gw = glyph[0].length;
      const gh = glyph.length;
      const bodyScale = Math.max(
        1,
        Math.floor((Math.min(inner.w, inner.h) * 0.7) / Math.max(gw, gh)),
      );
      stampGlyph(m, glyph, ramp.ink, inner, bodyScale);
      applyStateCue(m, state, frame, inner, skin);
      return m;
    };
  }
  return Object.freeze(set);
}
