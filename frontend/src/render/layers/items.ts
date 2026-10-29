// The item layer (UI-SPEC "Belts & items" + VIS-02, SKIN-03) — the live events
// riding belts as glowing amber dots.
//
// This MUST be a ParticleContainer (NOT a Container of Sprites): only the particle
// batch path holds thousands of dots at 60fps. Every dot shares ONE dot texture: a
// crisp RINGLESS item-accent core (4.8px outer diameter, no glow ring at all;
// 53-BELT-LOCK.md axis 5) in `skin.palette.accents.item`, so the whole layer stays
// a single GPU batch.
//
// ===========================================================================
// THE DOT IS VECTOR AS OF PLAN 61-05 (VEC-01), AND ITS LOOK DID NOT CHANGE.
// ===========================================================================
//
// THE CLAIM THIS HEADER USED TO MAKE, QUOTED SO THE CORRECTION IS LEGIBLE: the dot
// was *"baked from `skin.palette.accents.item` through the Phase 23 synth pipeline
// (matrixToTexture, nearest-neighbor, rgba8unorm)"*, and further down, *"the item dot
// is baked ONCE into a PERSISTENT texture over a matrix buffer we retain"*. **Both
// became FALSE with this plan and are corrected in place rather than deleted**, per
// the falsified-comment discipline `beltPainter.ts` and `belts.ts` already apply.
//
// WHAT CHANGED IS THE REPRESENTATION, NOT THE LOOK, and the distinction is the maintainer's
// (61-CONTEXT.md H5, 2026-08-10). The dot is now RESOLUTION-INDEPENDENT VECTOR
// GEOMETRY: two concentric circles at two constant alphas, which is exactly what the
// retired `PixelMatrix` bake WAS (it selected between alpha 255 and `glowAlpha` by a
// radius threshold), rasterised into a `RenderTexture` per ZOOM BUCKET. The drawn
// diameter, the two alphas and the accent are unchanged and are pinned as such in
// `items.test.ts`; the tessellated geometry is pinned by a golden digest in
// `synth/beltPainter.digest.test.ts`, which is the same gate the old bake had, moved
// from RGBA bytes to tessellated bytes because there are no RGBA bytes any more.
//
// WHY THIS WAS WORTH DOING. The retired bake was 10 NATIVE px. At zoom 4 on a 2x
// display the same dot is drawn at 80 device px, an 8x UPSAMPLE, and a 4.8px core
// resampled at 177% zoom is precisely the soft-edge complaint milestone v7.0 was
// founded on. The per-bucket texture is rasterised at the device scale it will be
// drawn at, so the renderer downsamples or draws 1:1 and never upsamples.
//
// `61-UI-SPEC.md` A9 locks the item dot as "unchanged". That lock was written BEFORE
// the collision was known and is SUPERSEDED ON REPRESENTATION ONLY (H5). The LOOK
// half of it stands and is gated rather than assumed.
//
// **VEC-01 IS TICKED ON A STATED, NARROWER READING THAN ITS LITERAL TEXT.** See
// `render/vectorOnly.test.ts`, which carries the written exemption list. Do not read
// this file's conversion as VEC-01 unqualified.
//
// Positions are SLOT-TRUE (SKIN-03): the host ships each item's exact belt slot on
// the wire (`arrival_tick` = slot index, `latency` = slot count), so each dot is
// placed at `pointAlong(polyline, slotArcLength(slot, slotCount, polyline))` with no
// packet/schema change. Correct slot placement gives backpressure bunching for
// free: a full/backpressured belt fills its head slots, so its dots visibly bunch
// toward the delivery end (the VIS-04 buffer-fill bar successor deleted in 25-03).
//
// THE THIRD ARGUMENT IS THE WHOLE POLYLINE, NOT ITS `total`, AND THAT IS A FIX RATHER
// THAN A REFACTOR. A corner tile's flow length is its 25.132741px arc, not a cell, so
// on a belt mixing bends and straights there is no single pitch to divide `total` by;
// `slotArcLength` places each slot inside the TILE that owns it. Passing `pl.total`
// here put a dot up to 2.003px from its sim slot on a three-tile L and 33.91px out on
// a spiral, which is the SKIN-03 invariant this file's own header claims.
//
// The layer re-uploads positions EVERY frame (dynamicProperties.position), so the
// analytic per-frame recompute path is preserved for smooth motion.
//
// ===========================================================================
// THE RESERVED TEMPORAL HOOK IS SPENT (SLOT-04, plan 62-05).
// ===========================================================================
//
// THE CLAIM THIS HEADER USED TO MAKE, QUOTED SO THE CORRECTION IS LEGIBLE:
// *"`renderClock` is retained on `draw` as a reserved temporal hook; it stays unused
// because the MOTION-07 snap is SPATIAL, not temporal (research Open Question 3: do not
// over-engineer smoothing this phase)."* The second half still stands - the snap IS
// spatial - but the hook is no longer unused. Phase 62 makes each belt's advance
// interval its own serialized state (SLOT-03), and a longer interval means fewer, bigger
// dot jumps per second: an 8px hop at a low enough frequency reads as STEPPING rather
// than motion, and worse through a bend, where the slot pitch is 6.283185px against a
// straight's 8.000px. So `renderClock` now drives a TRAILING lerp from the slot a dot
// WAS in to the slot it IS in, behind a runtime toggle that DEFAULTS OFF.
//
// Trailing only, by the clamp and not by convention (D-11): the parameter is clamped
// into [0, 1], so a dot can never be drawn past its current slot and a blocked item
// cannot slide forward and snap back. The sourcing half - which previous slot belongs
// to which dot - lives on the packet path in `sceneState.ts` (`prevItemSlots` +
// `resolveFromSlots`), because `draw()` runs per display frame and the previous
// `BeltView` is destroyed before it could be read here.
//
// WHETHER IT SHIPS IS NOT DECIDED HERE. D-10 builds both motions so the maintainer can judge
// them back to back on identical geometry at the wave-5 sitting.
//
// MOTION-07 (this plan): each dot's interpolated world position is QUANTIZED to the
// whole-device-pixel grid at draw time via `snapToDevicePixel`, with the quantum
// `q = renderer.resolution (DPR) * camera zoom` threaded in live. This kills the
// sub-device-pixel shimmer/crawl on moving dots WITHOUT setting a global roundPixels
// (a global flip would quantize the whole scene and destroy the smooth analytic item
// glide - the trilemma resolution). Statics are untouched (they already snap at
// integer cell*CELL). The snap is a display-only transform: no snapped value flows
// back into a command or the sim (the fixed-point determinism boundary holds).

import {
  Graphics,
  GraphicsContext,
  Particle,
  ParticleContainer,
  RenderTexture,
} from 'pixi.js';
import { CELL } from '../../../shared/geometry';
import { beltItemPolyline, LAG_TICKS, pointAlong, slotArcLength } from '../interp';
import { resolveFromSlots, type SceneState } from '../sceneState';
import type { Skin } from '../synth/skin';

/**
 * THE TRAILING-INTERPOLATION TOGGLE'S DEFAULT, AND IT IS OFF (SLOT-04, D-10).
 *
 * OFF reproduces today's draw EXACTLY: the dot's arc length is the single
 * `slotArcLength(currentSlot, ...)` call it has always been, taken on the same
 * polyline, with no lerp arithmetic anywhere on the path. That is what makes the toggle
 * free rather than cheap - `dPrev + (dNow - dPrev) * 1` is NOT bit-identical to `dNow`
 * in floating point, so the off path BRANCHES around the lerp instead of feeding it a
 * `t` of 1. No pixel baseline may move because this landed.
 *
 * IT WAS JUDGED AT THE SITTING ON 2026-08-14 AND IT DOES NOT SHIP. D-10 built both
 * motions so the maintainer could judge them back to back on identical geometry, and did so
 * on the real self-contained WebKitGTK binary. The answer is recorded verbatim in
 * `62-SITTING-VERDICT.md` ("Trailing interpolation ships: NO - it stays built,
 * renderer-only and defaulted OFF"). So this `false` is no longer a placeholder awaiting
 * a decision: it is the decision, and the toggle now exists to turn the capability ON for
 * a future evaluation rather than to turn it on for shipping.
 *
 * **DO NOT DELETE THE LERP AS DEAD CODE.** A capability whose non-shipping is
 * undocumented gets rediscovered as unreachable code and removed by someone who does not
 * know it was built on purpose and judged on purpose. It was both.
 *
 * WHY IT DID NOT SHIP, MEASURED RATHER THAN TASTED. The maintainer reported it "looks increasingly
 * jerky" from 3 ticks per slot upward; the cause was then measured and written up in
 * `62-INTERP-VERDICT.md`. The lerp's origin is re-stamped on every
 * belt RE-EMISSION rather than on every belt ADVANCE (`render/sceneState.ts:309`), so at
 * an interval of `n` the lerp runs for one tick, gets yanked the remaining slot pitch in a
 * single frame, then freezes for `n - 2` ticks: jump, then pause, and the pause lengthens
 * as `n` grows. The maintainer's eye and the measurement agreed on where the line falls.
 *
 * **THE COMPLETE FIX IS NOT OWED BY PHASE 62 AND MUST NOT BE ATTEMPTED HERE.** It needs a
 * stable per-item id on the wire, which is protocol work plus a golden-corpus re-bless,
 * and it belongs in its own phase. Turning this default to `true` without that id ships
 * the jerk.
 */
export const ITEM_INTERPOLATION_DEFAULT = false;

/**
 * Device-pixel quantum snap (MOTION-07 - the per-layer snapping trilemma resolution).
 * Round a world-space coordinate onto the WHOLE-device-pixel grid so a moving dot
 * never straddles a fractional device pixel (the sub-device-pixel crawl of an
 * antialiased edge IS the shimmer). `q = renderer.resolution (DPR) * camera zoom`,
 * so the grid tracks BOTH the display density AND the continuous zoom - snap
 * alignment holds at every zoom, not only 1.0 (Pitfall 4: zoom MUST be in q).
 *
 * Pure and read-only: a render-time display transform on the interpolated position,
 * NOT a coarsening of the underlying analytic motion math (dots still glide slot to
 * slot; whole-device-pixel stepping is imperceptible). No snapped value flows back
 * into a GridCommand or the sim - the fixed-point determinism boundary is untouched
 * (threat T-26-07). The guard keeps the math NaN-free if a degenerate quantum
 * (q <= 0) ever reaches it; in practice resolution >= 1 and zoom in [0.25, 4].
 */
export function snapToDevicePixel(v: number, q: number): number {
  if (!(q > 0)) return v;
  return Math.round(v * q) / q;
}

/**
 * Item dot on-screen-size floor as a per-particle WORLD-scale grow factor (FLOW-03).
 * Dots are AUTHORED at a 2.4px core (`CORE_R`, the locked 4.8px outer); at
 * 0.25x the on-screen core is ~0.6px and vanishes (UI-SPEC C4, RESEARCH Pattern
 * 5). Mirror the ports.ts
 * `nubHitRadiusWorld` screen-px-floor shape (`1 / Math.min(1, scale)`): at zoom >= 1
 * `Math.min(1, scale) = 1` -> grow 1 (native size; NO ballooning at 4x); below zoom 1
 * the dot grows in world units so its on-screen size holds. Capped at
 * `(0.4 * CELL) / CORE_R` so the grown world core radius never exceeds `0.4 * CELL`
 * (the dot never balloons past the lane). Monotonic non-increasing over (0, 1].
 *
 * Pure and display-only: the grow factor is one-way (zoom -> particle scale); nothing
 * flows back into decode.ts, a GridCommand, or scene.tick (T-31-DET, the fixed-point
 * determinism boundary holds). Single-texture batch is preserved - only per-particle
 * scaleX/scaleY change, one texture, one batch.
 */
export function itemDotGrow(scale: number): number {
  return Math.min(1 / Math.min(1, scale), (0.4 * CELL) / CORE_R);
}

export const DOT_SIZE = 10; // WORLD px of the dot's square box (the locked ringless core,
// 53-BELT-LOCK.md axis 5). It used to be the NATIVE px of the dot's pixel matrix, and
// that reading is retired by plan 61-05: the box is now a LOGICAL extent and the number
// of native px behind it varies with the zoom bucket (see DOT_ZOOM_BUCKETS). The VALUE
// is unchanged and the drawn footprint is unchanged - a RenderTexture varies its
// `resolution`, never its `width`/`height`, so `orig` stays at DOT_SIZE and the quads
// never move on a bucket change.
const DOT_SCALE = 1; // 1:1 world px (scale unsnapped; the dot POSITION is
// device-pixel-quantized via snapToDevicePixel, MOTION-07)
export const CORE_R = 2.4; // opaque core radius (px) -> a crisp 4.8px-outer ringless dot
// (exported so the FLOW-03 itemDotGrow cap and its unit test read the SAME core
// radius, not a copy). Locked cell: 2.4, the airiest dot of the five. The perceived
// gap at full bunch is the slot pitch minus the 4.8px outer diameter, so it is now
// 8 - 4.8 = 3.20px. It was 5.87px when this cell was locked in Phase 53, because the
// pitch was then 32/3 = 10.667px; Phase 60 (SLOT-01) moved SLOTS_PER_TILE to 4 for an
// exact 8px pitch, which tightens the bunch. THE LOCKED CELL IS NOT RE-OPENED BY THAT:
// the dot size was never the lever on gap ALTERNATION (see the ItemDotSpec docblock
// below), and whether the tighter bunch reads right is FEEL row 60-a in
// the v7.0 FEEL kit (internal design notes), judged on the real binary, not decided here.
const GLOW_R = 0; // 0 = NO ring at all (locked cell; the dot's outer edge IS the core)
const GLOW_ALPHA = 110; // FIXED integer constant, INERT at radius 0 - carried so the
// locked record has the same four cells every direction had, not because it paints
// anything (53-BELT-LOCK.md axis 5). Never a runtime brightness/alpha multiply, so
// the bake stays byte-deterministic (SYNTH-05).

/**
 * The item dot's geometry - the four numbers an exploration direction may vary,
 * threaded as ONE record instead of four module constants read directly out of the
 * bake (Phase 53, 53-02 T3). `SHIPPED_DOTS` is the default and reproduces today's dot,
 * pinned by a golden digest in `synth/beltPainter.digest.test.ts` - the dot has NO
 * pixel baseline covering it, so that digest is its only gate (T-53-05-TAM).
 *
 * PLAN 61-05 RE-BLESSED THAT DIGEST, and the re-bless changed WHAT IS HASHED rather
 * than merely its value: the dot is vector now, so there are no RGBA bytes to hash and
 * the gate moved to the TESSELLATED vertex/index buffers - the same VEC-05 mechanism
 * `synth/beltGeometry.digest.test.ts` locks the belt with. It landed in the SAME commit
 * as the representation change, so the dot was never gateless.
 *
 * `glowAlpha` is a FIXED integer alpha, never a computed tint or a runtime
 * brightness multiply: the dot is exactly TWO CONSTANT ALPHAS (255 / glowAlpha)
 * selected by a radius threshold. That was true of the retired matrix bake (which is
 * why its output `Uint8ClampedArray` was byte-identical for a given accent, SYNTH-05)
 * and it is what makes the dot EXPRESSIBLE AS VECTOR at all: two constant alphas over
 * two radii is two filled circles, and nothing else. A dot carrying a real gradient
 * could not have made this trip.
 *
 * THE ONLY LEVER THIS TYPE PROVIDES IS PERCEIVED GAP, via the dot's outer diameter.
 * Slot spacing and item travel speed live in the core (`crates/fabrico-core/src/
 * belt_slots.rs`) and were out of scope for Phases 53 and 54. The reasoning below is
 * KEPT rather than deleted, because it records why the dot-size lever was the WRONG
 * lever for the alternating-gap defect, and a future reader who loses that will reach
 * for it again.
 *
 * The defect, in the past tense because it is history: the 11/10/11 px gap
 * ALTERNATION, caused by the then-value of `SLOTS_PER_TILE`, 3, not dividing
 * `CELL` = 32 (32/3 = 10.667 px, which device-pixel snapping rounded alternately up
 * and down). It was NOT reachable from here: shrinking or growing the dot changed how
 * large the gaps LOOKED, never that they alternated (RESEARCH Pitfall 6).
 *
 * FIXED IN PHASE 60 (SLOT-01), at the only lever that could fix it: `SLOTS_PER_TILE`
 * is 4, so the pitch is 32/4 = 8.000 px and divides the tile exactly at every belt
 * length. The alternation is GONE rather than disguised, and it was fixed in the core
 * rather than here precisely because this type never had the lever. `snapToDevicePixel`
 * was NOT removed to chase it (SEED-011: unsnapped dots trade an alternating gap for
 * blur at every position).
 */
export interface ItemDotSpec {
  /**
   * The side of the dot's square box, in WORLD px. Must be at least `2 * glowR + 1`.
   *
   * THE NAME IS KEPT AND ITS MEANING IS CORRECTED (plan 61-05). It used to be "native
   * px of the square dot matrix"; there is no matrix now, and this is the LOGICAL box
   * the vector geometry is authored inside and the `RenderTexture` is sized to. The
   * name survives because `53-BELT-LOCK.md` axis 5 records the locked cell as
   * "matrix 10" and a rename would make the lock unreadable against the code, which is
   * a worse cost than a slightly historical field name.
   */
  readonly matrix: number;
  /** Opaque core radius in px (alpha 255 inside it). */
  readonly coreR: number;
  /** Glow ring radius in px; 0 means no ring (core only). */
  readonly glowR: number;
  /** FIXED integer alpha of the glow ring (0..255) - never a computed tint. */
  readonly glowAlpha: number;
}

/**
 * THE LOCKED dot - the default of `paintItemDot` and `createItemLayer`
 * (53-BELT-LOCK.md axis 5: matrix 10, coreR 2.4, glowR 0 - no ring, glowAlpha
 * inert). The four shipped constants remain the single source; this record only
 * groups them.
 */
export const SHIPPED_DOTS: ItemDotSpec = Object.freeze({
  matrix: DOT_SIZE,
  coreR: CORE_R,
  glowR: GLOW_R,
  glowAlpha: GLOW_ALPHA,
});

/**
 * The item dot as RESOLUTION-INDEPENDENT VECTOR GEOMETRY (VEC-01, plan 61-05): two
 * concentric circles at two constant alphas, in the active skin's `item` accent,
 * authored inside a `spec.matrix` box with the circles on its centre.
 *
 * THIS IS A TRANSCRIPTION OF THE RETIRED BAKE, NOT A REDRAW. That bake wrote alpha
 * 255 inside `coreR` and `glowAlpha` inside `glowR`, selected by a radius threshold
 * (`d <= coreR ? 255 : d <= glowR ? glowAlpha : 0`). Two constant alphas over two
 * radii IS two filled circles - so the same four numbers produce the same picture,
 * only now at whatever resolution the renderer asks for.
 *
 * NOTE THE DRAW ORDER: THE RING FIRST, THE CORE OVER IT. The bake's `else if` gave the
 * core precedence at every radius it covered; painting the core LAST is how that
 * precedence is reproduced in vector. At the shipped spec `glowR` is 0, so the ring
 * branch never fires and the core's edge IS the dot's outer edge (53-BELT-LOCK.md
 * axis 5) - exactly as the bake's glow branch never fired. The branch is written
 * anyway because the whole point of {@link ItemDotSpec} is that those four numbers are
 * the levers, and a converter that silently dropped the ring would break any spec that
 * declares one.
 *
 * The item accent is reserved for item dots ONLY (style-bible section 1).
 *
 * ONE GUARD SURVIVED THE CONVERSION AND ONE DIED WITH ITS SUBJECT, stated so the
 * deletion is not read as an oversight. The spec-internal check
 * (`matrix >= 2 * glowR + 1`) SURVIVES: the box is now the `RenderTexture`'s frame, so
 * an over-large ring is still clipped by an edge, just a GPU one. The CR-01 guard -
 * "does this spec match the BUFFER it was handed" - is GONE because there is no buffer
 * to mismatch: it existed because a `Uint8ClampedArray` discards an out-of-range write
 * SILENTLY, and nothing on this path writes an array any more. The failure mode it
 * caught cannot occur, so keeping the guard would have meant keeping the buffer.
 */
export function dotVectorContext(skin: Skin, spec: ItemDotSpec = SHIPPED_DOTS): GraphicsContext {
  if (spec.matrix < 2 * spec.glowR + 1) {
    throw new Error(
      `ItemDotSpec: matrix ${spec.matrix} is too small for glowR ${spec.glowR} ` +
        `(needs at least ${2 * spec.glowR + 1}); the glow ring would be clipped by the box edge`,
    );
  }
  const ink = skin.palette.accents.item;
  const c = spec.matrix / 2; // the box centre, in the box's own coordinates
  const ctx = new GraphicsContext();
  if (spec.glowR > 0) {
    ctx.circle(c, c, spec.glowR).fill({ color: ink, alpha: spec.glowAlpha / 255 });
  }
  return ctx.circle(c, c, spec.coreR).fill({ color: ink, alpha: 1 });
}

/**
 * THE ZOOM BUCKETS the dot texture is rasterised at, as DEVICE SCALE (device px per
 * world px of the dot's box). Ceiling-selected, so the renderer DOWNSAMPLES or draws
 * 1:1 and never upsamples - which is the whole of what VEC-01 buys the dot.
 *
 * THE CEILING IS 8 AND IT IS DERIVED, NOT CHOSEN: `MAX_ZOOM` (4) times the highest
 * device-pixel ratio this milestone carries baselines for (2 - the `dpr-crispness`
 * buckets cover 1, 1.5, 2 and a fractional 1.77). At bucket 8 the dot's native extent
 * is `DOT_SIZE * 8` = 80 device px, which is exactly what it is DRAWN at at zoom 4 on
 * a 2x display. The retired bake was 10 native px there - an 8x upsample, and the
 * soft-edge complaint this milestone was founded on.
 *
 * THE FLOOR IS 1, not the 0.25 camera zoom floor, because `itemDotGrow` holds the
 * dot's ON-SCREEN size constant below zoom 1: at zoom 0.25 the grow factor is 4 and
 * the two cancel, so the dot is still drawn at ~`DOT_SIZE * DPR` device px. Bucketing
 * on the drawn device size rather than on raw zoom is what keeps the low-zoom dot from
 * being rasterised at a quarter of the size it is shown at.
 *
 * FOUR BUCKETS IS DELIBERATE. A rebind is cheap but not free, and powers of two over a
 * 32x span cost at most a 2x downsample - invisible - while a finer ladder would trade
 * rebinds for nothing a viewer can see.
 */
export const DOT_ZOOM_BUCKETS: readonly number[] = Object.freeze([1, 2, 4, 8]);

/**
 * The DEVICE SCALE one dot is drawn at: its per-particle world grow factor times the
 * live device-pixel quantum (`renderer.resolution * camera zoom`).
 *
 * Pure, one-way and display-only, exactly like the two inputs it composes: nothing
 * here flows back into a `GridCommand`, `decode.ts` or `scene.tick` (T-31-DET).
 */
export function dotDeviceScale(quantum: number, zoom: number): number {
  return itemDotGrow(zoom) * quantum;
}

/**
 * The smallest {@link DOT_ZOOM_BUCKETS} entry at or above `deviceScale` - a CEILING,
 * never a nearest, so the texture always has at least as many native pixels as the
 * screen will ask of it. A degenerate scale (0, negative, NaN) takes the floor bucket
 * rather than producing a NaN resolution the GPU would reject.
 */
export function dotZoomBucket(deviceScale: number): number {
  const last = DOT_ZOOM_BUCKETS[DOT_ZOOM_BUCKETS.length - 1];
  if (!(deviceScale > 0)) return DOT_ZOOM_BUCKETS[0];
  for (const b of DOT_ZOOM_BUCKETS) if (deviceScale <= b) return b;
  return last;
}

/**
 * The ONE renderer capability the item dot needs: rasterise a container into a render
 * target. Declared STRUCTURALLY rather than as Pixi's `Renderer`, so a spec can drive
 * the real baker with a recording stand-in and this module stays honest about how
 * little of a renderer it actually uses.
 */
export interface DotTextureRenderer {
  render(options: { container: Graphics; target: RenderTexture; clear: boolean }): void;
}

/**
 * Rasterise one dot spec INTO AN EXISTING render target at a stated device resolution.
 *
 * THE TARGET IS AN INPUT, NOT A RETURN VALUE, AND THAT IS THE WHOLE POINT (the
 * `machines-missing-webkitgtk` fix). This seam used to be a BAKER that MINTED a fresh
 * `Texture` per zoom bucket, which forced the layer to free the outgoing one - and
 * freeing it is what broke the renderer. The reasoning is on {@link pixiDotPainter}.
 */
export type DotTexturePainter = (
  target: RenderTexture,
  skin: Skin,
  spec: ItemDotSpec,
  resolution: number,
) => void;

/**
 * The shipped painter: resize `target` to `matrix x matrix` at `resolution`, then draw
 * {@link dotVectorContext} into it.
 *
 * THE SIZE IS LOGICAL AND THE RESOLUTION IS THE ONLY THING THAT MOVES, and that is
 * what makes "the LOOK must not change" cheap rather than something to police: a
 * `RenderTexture` varies its `resolution`, never its `width`/`height`, so `orig` stays
 * at `matrix` and the drawn quads do not move on a bucket change (measured by the Wave
 * 0 probe, `itemTextureRebind.test.ts` case 4). The dot simply gets more native pixels
 * behind the same world footprint. `TextureSource.resize` reallocates the GPU render
 * target - `Texture` subscribes `source.on('resize', this.update)` and `RenderTarget`
 * subscribes `colorTexture.source.on('resize', this.onSourceResize)` - so the resize
 * is the SUPPORTED way to change a live render target's density.
 *
 * ===========================================================================
 * WHY THIS REPAINTS ONE TARGET INSTEAD OF MINTING A TEXTURE PER BUCKET.
 * ===========================================================================
 *
 * Plan 61-05 shipped a BAKER that returned a NEW `RenderTexture` per bucket, so the
 * layer had to free the outgoing one, and it did: `outgoing.destroy(true)`. That call
 * is what killed the renderer, and the mechanism is entirely inside Pixi:
 *
 *   `TextureSource.destroy()` -> `unload()` -> `emit('change')`
 *     -> `BindGroup.onResourceChange(resource)`
 *        -> `if (resource.destroyed) this.destroy()`   // BindGroup.mjs
 *           -> `this.resources = null`
 *
 * A `BindGroup` DESTROYS ITSELF when a resource bound inside it is destroyed. The
 * outgoing dot source was bound in exactly one place that matters: the particle pipe's
 * `defaultShader`, where `GlParticleContainerAdaptor.execute` parks it every frame via
 * `shader.resources.uTexture = container.texture._source`. That shader is a
 * PER-RENDERER SINGLETON shared by every `ParticleContainer`, so freeing the outgoing
 * texture nulled the bind group behind ALL particle rendering. The next frame's
 * `shader.resources.uTexture = ...` then threw `TypeError: null is not an object
 * (evaluating 'this.resources[t]')` from inside `Application.render`, which is a Ticker
 * listener - and `Ticker._tick` only re-requests its animation frame AFTER `update()`
 * returns, so a throw there stops the render loop PERMANENTLY. The board froze on the
 * partial frame the exception interrupted: grid and belts composited, items, machines,
 * wires and overlay never reached.
 *
 * ORDERING COULD NOT HAVE FIXED IT, which is why the old "BUILD, BIND BOTH, FREE LAST"
 * three-step is gone rather than reordered. `layer.texture = fresh` and
 * `p.texture = fresh` are JS assignments; the SHADER's binding only moves during a real
 * render pass, and the whole rebind ran inside `draw()`, which the loop calls BEFORE
 * the renderer's own ticker listener. The outgoing source was therefore still the one
 * in the bind group at the instant it was freed, at every possible ordering of those
 * three statements.
 *
 * SO THE FIX IS TO NEVER FREE A BOUND SOURCE: there is now exactly ONE dot
 * `TextureSource` for the layer's whole life, its identity never changes, and no bind
 * group holding it can ever be invalidated. It also deletes the two-bindings-in-step
 * hazard `itemTextureRebind.test.ts` case 4 records, because neither binding moves.
 *
 * `antialias: false` is held OFF, matching the three shipped sites. The maintainer judged
 * antialias-on and rejected it (2026-07-31); STATE is explicit that byte-exactness
 * surviving the flip is NOT sufficient grounds to relax it.
 *
 * The `GraphicsContext` is destroyed with its holder (`destroy({ context: true })`):
 * `Graphics.destroy()` frees only an OWNED context, and this one was supplied
 * externally, so it must be freed explicitly or every repaint leaks a tessellation.
 * That destroy is SAFE where the texture one was not: a `GraphicsContext` is not a
 * `TextureSource` and is bound into no shader's bind group.
 */
export function pixiDotPainter(renderer: DotTextureRenderer): DotTexturePainter {
  return (target: RenderTexture, skin: Skin, spec: ItemDotSpec, resolution: number): void => {
    target.resize(spec.matrix, spec.matrix, resolution);
    const holder = new Graphics(dotVectorContext(skin, spec));
    renderer.render({ container: holder, target, clear: true });
    holder.destroy({ context: true });
  };
}

/**
 * The default {@link DotTexturePainter}, which THROWS.
 *
 * The layer cannot fabricate a rasteriser: the dot is vector as of plan 61-05, so
 * turning it into the `Texture` a `Particle` binds needs a renderer. The parameter is
 * defaulted only so the four arguments before it keep their positions; the default's
 * job is to fail LOUDLY at construction rather than to silently fall back to the
 * retired `PixelMatrix` bake, which is exactly the "reported VEC-01 as converted while
 * the layer still bakes a matrix" outcome 61-CONTEXT.md H5 forbids.
 */
const unwiredDotPainter: DotTexturePainter = (): never => {
  throw new Error(
    'createItemLayer: no DotTexturePainter was supplied. The item dot is VECTOR as of plan ' +
      '61-05 (VEC-01), so the layer needs a renderer to rasterise it into a RenderTexture - ' +
      'wire `pixiDotPainter(app.renderer)` at the call site. This throws rather than falling ' +
      'back to a pixel bake, because a silent fallback is how a requirement gets reported ' +
      'as met while the thing it names is still there.',
  );
};

export interface ItemLayer {
  /** The ParticleContainer (assigned to the scene's item layer). */
  layer: ParticleContainer;
  /**
   * Reposition one dot per in-flight item at its slot-true belt position.
   *
   * `renderClock` IS NOW READ (SLOT-04, plan 62-05). The claim that stood here -
   * *"`renderClock` is retained as the Phase-26 (MOTION-07) inter-slot smoothing hook;
   * slot-true placement itself is clock-independent"* - is corrected rather than
   * deleted (the falsified-comment discipline this file already applies): the hook was
   * reserved for exactly this and is now the interpolation parameter's numerator. The
   * second clause still holds whenever `interpolate` is false, which is the default.
   *
   * `interpolate` is the D-10 runtime toggle, defaulting to
   * {@link ITEM_INTERPOLATION_DEFAULT} (OFF) so an unedited caller gets today's draw.
   */
  draw(scene: SceneState, renderClock: number, interpolate?: boolean): void;
  /**
   * THE DRAWN ITEMS, read off the batch (plan 77-02, phase 77 D-04): the world-px position
   * of every particle the latest `draw` left in the ParticleContainer.
   *
   * WHY IT EXISTS. Every item claim in the composed walk (`77-one-board-all-five.live.spec.ts`)
   * reads `occupiedSlots` from the MODEL, the render packet echoed back. An item layer that
   * draws stale positions, or nothing at all, while the ticker runs passes those reads AND
   * both render-health helpers, which is this repository's recorded model-oracle blind spot.
   * This is the read that can see it: what the layer actually placed.
   *
   * WHAT IT READS. The ParticleContainer's own `particleChildren`, the particles `ensure`
   * added and has not released, so a particle released by a later draw is not reported.
   * Each entry is the particle's `x` and `y` as `draw` set them: world px, after the
   * device-pixel snap. Plain numbers in a fresh array; read-only, no setter, and no Pixi
   * object escapes (T-14-FABRICO-RO). `draw` is not changed by it.
   *
   * WHAT IT CANNOT SEE. The texture, the alpha, the scale and the rasterisation: a dot placed
   * at the right point with a blank texture reads the same. It answers "an item was placed
   * here", never "an item is visible here".
   */
  plottedDots(): Array<{ x: number; y: number }>;
  /**
   * THE DRAWN ITEMS AND THE TICK THEY WERE DRAWN FROM (plan 77-04, the 77-04 review blocker):
   * `dots` is exactly {@link plottedDots}, and `drawnAtTick` is the `scene.tick` the latest
   * `draw` pass read, `null` before the first draw.
   *
   * WHY IT CARRIES A TICK. The scene model is updated as each packet lands (`App.tsx`
   * `applyPacket`), while this layer places its dots only inside `draw`, once per display
   * frame. On a FLOWING belt a sampler that reads the model and the dots in one breath can pair
   * tick T's model with the dots drawn for T-1, and every item that crossed a tile edge in
   * between reads as a mismatch on a correct build. A grader keys the dots by `drawnAtTick` and
   * compares them with the model OF THAT TICK (`e2e-live/support/itemFrames.ts`). Plan 77-07
   * gave the load gauge the same tick for the same reason (`MachineLayer.loadGaugeFormOn`).
   *
   * Read-only: the tick is read from the scene, never written back to it, and the dots are
   * plain numbers in a fresh array (T-14-FABRICO-RO).
   */
  plottedDotsFrame(): { drawnAtTick: number | null; dots: Array<{ x: number; y: number }> };
}

/**
 * Build the item render layer against a single `activeSkin`. The layer owns ONE
 * dot texture at a time, NOT a SynthTextureCache - unlike the belt/machine layers,
 * its single dot is the whole texture inventory, so a cache would be dead weight.
 *
 * THE TEXTURE IS RE-BOUND ON A ZOOM-BUCKET CHANGE, AND THE ORDER IS LOAD-BEARING
 * (plan 61-05; route selected by the Wave 0 probe in `itemTextureRebind.test.ts`).
 * The claim that used to stand here - *"the texture is baked once and never
 * destroyed/rebaked, so the persistent ParticleContainer can never bind a freed
 * source"* - is superseded: the texture IS replaced now, and the invariant it was
 * protecting is preserved by ORDERING rather than by never moving. Three steps, in
 * this order and no other:
 *
 *   1. BUILD the new texture;
 *   2. BIND it to `layer.texture` AND to EVERY pooled `Particle.texture`, then
 *      `layer.update()`;
 *   3. only THEN free the outgoing texture with `destroy(true)`.
 *
 * **THERE ARE TWO BINDINGS, NOT ONE, AND STEP 2 EXISTS FOR THAT.**
 * `container.texture._source` is only the SAMPLER; the per-particle quad corners
 * (`aVertex`) are built from `p.texture.orig` into the STATIC attribute buffer. A
 * rebind that moved only the container would leave every dot drawn at the old logical
 * size while sampling the new texture. EVERY POOLED particle is re-bound, not only the
 * active ones: an inactive particle re-entering the batch later would otherwise carry a
 * freed texture into the next static upload.
 *
 * **FREEING FIRST IS THE RECORDED CRASH, REPRODUCED.** `items.ts:283` used to record
 * that "destroy+rebake was tried and crashes the particle adaptor"; the Wave 0 probe
 * reproduced it exactly - `TypeError: Cannot read properties of null (reading
 * 'alphaMode')` on the NEXT pass, from `getAdjustedBlendModeBlend` over a nulled
 * `_source`, plus a second `TypeError` from `p.texture.uvs` when a PARTICLE is left
 * holding a freed texture. Both failure modes throw LOUDLY, so a mistake here is a
 * TypeError in the item layer and not a silently wrong picture.
 *
 * There is still EXACTLY ONE dot texture live at any instant, and the single GPU batch
 * this layer exists to protect is untouched.
 *
 * `quantum` is the MOTION-07 live device-pixel quantum source: a closure returning
 * `renderer.resolution * camera zoom` (read fresh each draw so the snap tracks the
 * continuous zoom). It is renderer-only (no scene/command/schema coupling) - the
 * caller wires `() => app.renderer.resolution * cam.worldScale()`.
 *
 * `scale` is the live camera zoom ALONE (FLOW-03 item dot zoom-floor): a closure
 * returning `cam.worldScale()` (NOT multiplied by resolution). Deliberately separate
 * from `quantum` so the screen-px dot floor has a pure-zoom source. Same one-way
 * renderer-only discipline as `quantum` (read fresh each draw, never written back to
 * decode.ts, a GridCommand, or scene.tick - T-31-DET). Consumed each draw for the
 * FLOW-03 item dot on-screen-size floor (itemDotGrow). Defaulted so existing call
 * sites stay valid unedited.
 *
 * `dots` is the {@link ItemDotSpec} the ONE shared dot texture is built from (53-02
 * T3), defaulted to {@link SHIPPED_DOTS} so a caller gets today's exact dot. A caller
 * supplying a different spec still gets exactly ONE dot texture and ONE particle batch
 * - the spec varies what the dot LOOKS like, never how many textures exist. A per-item
 * texture would be a defect, not a variant: it would shatter the single batch this
 * whole layer exists to hold.
 *
 * `paint` is the {@link DotTexturePainter} - `pixiDotPainter(app.renderer)` on the
 * shipped path. It has no working default and {@link unwiredDotPainter} says why in the
 * error it throws.
 */
export function createItemLayer(
  activeSkin: Skin,
  quantum: () => number,
  scale: () => number = () => 1,
  dots: ItemDotSpec = SHIPPED_DOTS,
  paint: DotTexturePainter = unwiredDotPainter,
): ItemLayer {
  // dynamicProperties.position + scale are re-uploaded every frame; color/rotation
  // stay static. FLOW-03: `scale` is enabled so each Particle's scaleX/scaleY can be
  // set per draw to the itemDotGrow zoom-floor - still ONE texture, ONE batch (only a
  // per-frame vertex upload is added, RESEARCH Pattern 5 watch).
  const layer = new ParticleContainer({
    dynamicProperties: { position: true, color: false, rotation: false, scale: true },
  });
  const skin = activeSkin;

  // Pool of Particle objects, reused across frames; `active` are currently in the
  // container. Growing the pool allocates; shrinking just removes from the batch.
  const pool: Particle[] = [];
  let active = 0;

  // The item dot's vector geometry is rasterised into ONE texture, which the layer
  // holds for its WHOLE LIFE and re-rasterises in place when the zoom bucket changes.
  // Every Particle shares this one Texture, and it is also the container's shared
  // texture (the particle adaptor binds `container.texture._source` on every frame,
  // even at zero particles), so the ParticleContainer keeps a live GPU source/bind
  // group at all times.
  //
  // ONE TEXTURE FOR THE LIFE OF THE LAYER, AND THE IDENTITY IS THE SAFETY PROPERTY.
  // Plan 61-05 minted a fresh `RenderTexture` per bucket and freed the outgoing one;
  // freeing a `TextureSource` that is still bound in a `BindGroup` makes that bind
  // group destroy itself, which permanently bricked the particle pipe's shared shader
  // and killed the render loop. The full mechanism is on {@link pixiDotPainter}. Since
  // `dotTex` never changes identity there is nothing to re-bind and nothing to free,
  // so neither the crash nor the leak the free existed to prevent is reachable.
  //
  // `RenderTexture.create` is allocated HERE rather than inside the painter because it
  // is pure CPU allocation with no GL upload (`itemTextureRebind.test.ts` relies on
  // exactly that to construct one headlessly), so the layer can own the texture's
  // identity without owning a renderer - which is what keeps the painter seam as small
  // as {@link DotTextureRenderer} claims it is.
  //
  // The first paint reads the LIVE zoom, because the camera is already fitted by the
  // time layers are built and starting at bucket 1 would show one upsampled frame
  // before the first draw corrected it.
  let bucket = dotZoomBucket(dotDeviceScale(quantum(), scale()));
  const dotTex = RenderTexture.create({
    width: dots.matrix,
    height: dots.matrix,
    resolution: bucket,
    antialias: false,
  });
  paint(dotTex, skin, dots, bucket);
  layer.texture = dotTex;

  /**
   * Move to a new zoom bucket by RE-RASTERISING the one texture at the new device
   * resolution. `resolution` is the only thing that moves: `width`/`height` stay at
   * `spec.matrix`, so `orig` is unchanged and the drawn quads do not move
   * (`itemTextureRebind.test.ts` case 4). Nothing is bound and nothing is freed.
   */
  const repaintAt = (next: number): void => {
    paint(dotTex, skin, dots, next);
    bucket = next;
  };

  const ensure = (n: number): void => {
    while (pool.length < n) {
      pool.push(
        new Particle({
          texture: dotTex,
          anchorX: 0.5,
          anchorY: 0.5,
          scaleX: DOT_SCALE,
          scaleY: DOT_SCALE,
        }),
      );
    }
    while (active < n) {
      layer.addParticle(pool[active]);
      active++;
    }
    while (active > n) {
      active--;
      layer.removeParticle(pool[active]);
    }
  };

  // The scene tick the latest `draw` pass read (plan 77-04): the tick every placed dot was drawn
  // FROM. Read from the scene, never written back to it. `null` until the first draw.
  let drawnAtTick: number | null = null;
  const draw = (
    scene: SceneState,
    renderClock: number,
    interpolate: boolean = ITEM_INTERPOLATION_DEFAULT,
  ): void => {
    drawnAtTick = scene.tick;
    // First pass: count + grow so the pool is large enough, then position.
    // Count ONLY items we will actually place. Tile-less belts are skipped in the
    // positioning pass below, so they MUST be skipped here too, otherwise their
    // items get counted, their particles activate, but never receive a position and
    // render as phantom amber dots at world origin (WR-01). This mirrors the belt
    // layer's `if (belt.tiles.length === 0) continue;` guard so the two passes stay
    // in lockstep.
    let total = 0;
    for (const belt of scene.belts.values()) {
      if (belt.tiles.length === 0) continue;
      total += belt.items.length;
    }
    // MOTION-07: read the device-pixel quantum LIVE (resolution * current zoom) so
    // every dot snaps against the grid for THIS frame's zoom - alignment holds as
    // the camera zooms (Pitfall 4). One read per draw, shared across all dots.
    const q = quantum();
    // FLOW-03: read the pure camera zoom LIVE and derive the dot on-screen-size floor
    // once per frame (shared across all dots). At zoom >= 1 grow = 1 (native, no
    // ballooning at 4x); below zoom 1 it grows, capped so dots never balloon past the
    // lane. One-way display transform (T-31-DET); nothing flows back to the sim.
    const grow = itemDotGrow(scale());
    // VEC-01 (plan 61-05): re-rasterise the dot texture BEFORE the pool grows, so any
    // particle minted this frame is born holding a texture already at this frame's
    // density. A bucket change is rare (four buckets across a 32x device-scale span),
    // so this is a comparison per draw and nothing more. The ORDER is now a nicety
    // rather than a correctness rule: `dotTex` keeps its identity across a repaint, so
    // a particle minted before or after it holds the same object either way.
    const wanted = dotZoomBucket(grow * q);
    if (wanted !== bucket) repaintAt(wanted);
    ensure(total);
    let i = 0;
    for (const belt of scene.belts.values()) {
      // Empty-tiles belts draw no items — impossible post-P20 DrawBelt mint; the
      // belts layer already warned once, so no second warn here (REND-03).
      if (belt.tiles.length === 0) continue;
      // Slot-true placement (SKIN-03): map each item's wire slot index
      // (`arrival_tick`) to an arc-length position along the belt's tail->head
      // polyline via `slotArcLength`, then onto the drawn track via `pointAlong`.
      // A full belt fills its head slots, so its dots bunch toward the delivery end
      // — the backpressure cue that replaces the deleted VIS-04 buffer bar.
      // FLOW-04: the ITEM path spans the full admit-to-deliver cell extent (HALF
      // beyond each end), so a 1-2 tile belt spreads its slots across distinct
      // bands instead of stacking them at the single center point. The center-only
      // tilePolyline (total 0 on a 1-tile belt) is kept only for the belt preview.
      const pl = beltItemPolyline(belt.tiles);
      // ---------------------------------------------------------------------
      // THE TRAILING LERP'S PER-BELT SHARE, COMPUTED ONCE (SLOT-04, D-10/D-11).
      // ---------------------------------------------------------------------
      // The from-slots and the interpolation parameter are facts about the BELT, not
      // about a dot, so they are computed at this level and shared across the inner
      // item loop - the same "compute once, share" shape as `q` and `grow` above, one
      // level down. With the toggle OFF nothing here runs and nothing here allocates.
      //
      // `history` is the packet-path cache (`sceneState.prevItemSlots`). A belt with no
      // entry - first sight, or the first packet after a keyframe - takes the same
      // path as toggle-off, so a dot never slides in from off the belt.
      let fromSlots: number[] | null = null;
      let t = 1;
      const history = interpolate ? scene.prevItemSlots.get(belt.id) : undefined;
      if (history !== undefined) {
        fromSlots = resolveFromSlots(
          history.slots,
          belt.items.map((it) => it.arrival_tick),
        );
        // The interval is FLOORED off the untrusted wire exactly as `belts.ts`
        // floors it: a forged 0 or a non-finite `ticks_per_slot` would make `t`
        // non-finite, `pointAlong` return NaN, and a NaN particle position is the
        // 2026-08-11 mechanism that stops the Pixi Ticker permanently on a partial
        // frame (the machines-missing-on-WebKitGTK failure).
        const interval =
          Number.isFinite(belt.ticks_per_slot) && belt.ticks_per_slot >= 1
            ? Math.floor(belt.ticks_per_slot)
            : 1;
        // THE CLAMP IS LOAD-BEARING THREE TIMES OVER AND ONE CLAMP COVERS ALL THREE.
        // DO NOT WIDEN IT.
        //   (1) TRAILING-ONLY BY CONSTRUCTION (D-11). `t` can never exceed 1, so a dot
        //       can never be drawn PAST its current slot. A blocked item therefore
        //       cannot slide forward and snap back, and the bunching cue cannot lie
        //       about backpressure. Forward prediction is forbidden, not merely
        //       unimplemented.
        //   (2) THE PINNED-CLOCK PROBES. `06-fault-red-probe.spec.ts` pins the render
        //       clock to 0 while the sim keeps advancing, so `renderClock -
        //       history.atTick` is a large NEGATIVE. The clamp yields 0: the PREVIOUS
        //       slot, never a position behind the belt's tail and never a NaN.
        //   (3) THE RESYNC SNAP. `loop.ts` jumps the clock forward by more than
        //       `RESYNC_GAP_TICKS` in a single frame. The clamp saturates at 1,
        //       landing exactly on the current slot rather than past it.
        //
        // `+ LAG_TICKS` IS THE WHOLE OF THE 62-INTERP-FIX, AND IT IS NOT AN OFFSET
        // FUDGE. `advanceRenderClock` caps the render clock at
        // `latestSimTick - LAG_TICKS`, and `history.atTick` is stamped at the scene
        // tick the displaced slots were last valid at - which, because the host
        // suppresses an unchanged belt, is the tick immediately before the re-emit.
        // Without this term the CEILING and the ORIGIN are the same number, so the
        // numerator is at or below zero on every frame of every display and the clamp
        // makes it exactly 0: the interpolation was structurally incapable of
        // interpolating, and merely drew every advancing dot ONE SLOT UPSTREAM of the
        // truth. Adding the lag back re-expresses the numerator in the clock's own
        // frame, so `t` runs (0, 1] across an interval and ARRIVES on the current slot
        // instead of stopping a tick short of it forever.
        //
        // The residual limit is the clock's RESOLUTION, not this numerator. The clock
        // free-runs at 60 tick-units/sec against a ceiling that advances at the sim
        // rate, so on a panel in lockstep with the sim it saturates on the integer
        // every frame and motion still staircases; on a panel refreshing faster than
        // the sim ticks it walks the gap in fractions and the motion is genuinely
        // sub-tick. Re-timing the clock (an EWMA-measured packet period, or moving
        // `SIM_TICK_MS`) would change that, and is deliberately NOT taken here: it
        // re-times the belt tread and the machine sweep too.
        t = Math.min(Math.max((renderClock + LAG_TICKS - history.atTick) / interval, 0), 1);
      }
      let k = 0;
      for (const item of belt.items) {
        // Toggle OFF (and every belt with no history): the arc length is the single
        // `slotArcLength` call it has always been, bit-for-bit. The branch exists so
        // the off path never touches lerp arithmetic - see ITEM_INTERPOLATION_DEFAULT.
        const dNow = slotArcLength(item.arrival_tick, belt.latency, pl);
        let d = dNow;
        if (fromSlots !== null) {
          // BOTH ends are computed on the SAME polyline, so the dot glides ALONG the
          // drawn track through a bend and the ~21.46% corner speed dip is PRESERVED
          // rather than smoothed away (D-12: an interval change alters how OFTEN slots
          // advance, never WHERE a slot sits). `slotArcLength` is called twice and is
          // not edited, which is what leaves the mixed-belt pin in `interp.test.ts`
          // passing untouched.
          const dPrev = slotArcLength(fromSlots[k], belt.latency, pl);
          d = dPrev + (dNow - dPrev) * t;
        }
        k++;
        const pt = pointAlong(pl, d);
        const p = pool[i++];
        // Snap the analytic (sub-pixel) slot position onto the whole-device-pixel
        // grid - kills shimmer without coarsening the motion (MOTION-07). NO global
        // roundPixels: only these item positions are quantized, statics stay as-is.
        p.x = snapToDevicePixel(pt.x, q);
        p.y = snapToDevicePixel(pt.y, q);
        // FLOW-03: keep a minimum on-screen dot size at low zoom via the per-particle
        // world-scale floor (native at zoom >= 1, grown+capped below). One texture,
        // one batch - only scaleX/scaleY change per particle.
        p.scaleX = grow;
        p.scaleY = grow;
      }
    }
  };

  const plottedDots = (): Array<{ x: number; y: number }> =>
    layer.particleChildren.map((p) => ({ x: p.x, y: p.y }));

  const plottedDotsFrame = (): { drawnAtTick: number | null; dots: Array<{ x: number; y: number }> } => ({
    drawnAtTick,
    dots: plottedDots(),
  });

  return { layer, draw, plottedDots, plottedDotsFrame };
}
