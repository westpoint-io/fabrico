import { describe, expect, it } from 'vitest';
import { makeGenerators, tintColor, WORKING_TINT_PCT } from './generators.ts';
import { TEST_SKIN_A, TEST_SKIN_B } from './__fixtures__/testSkins.ts';
import { LOCKED_SKIN } from './skins/locked.ts';
import { bakeRamp, rampStep } from './palette.ts';
import { state_tag } from '../../protocol/kinds.ts';
import { type PixelMatrix } from './types.ts';
import { CELL } from '../../../shared/geometry.ts';

/**
 * The historical bevel band depth in px, as a LITERAL.
 *
 * It read the exported pixel-era band-depth constant until plan 61-07 deleted that
 * constant with the last pixel bake. The number stands because the thing it measures
 * still exists: the two glyph-isolation cases below need the margin past the bevel band
 * that `makeGenerators` still paints, and that band is still one pixel deep - it is now
 * an inline literal inside `makeGenerators` rather than an exported constant, precisely
 * because no caller outside that function should be reaching for it. If the band ever
 * moves, `generators - bezel edges are fixed ramp indices (SYNTH-05)` reddens first;
 * these two cases would then need this literal moved with it.
 */
const BEVEL_BAND_DEPTH = 1;

/** Read a pixel's RGB as a 0xRRGGBB int at (x,y). */
function px(m: PixelMatrix, x: number, y: number): number {
  const i = (y * m.width + x) * 4;
  return (m.data[i] << 16) | (m.data[i + 1] << 8) | m.data[i + 2];
}

/** Read a pixel's RGBA as a packed 0xRRGGBBAA int at (x,y) (alpha included). */
function rgba(m: PixelMatrix, x: number, y: number): number {
  const i = (y * m.width + x) * 4;
  // >>> 0 keeps it an unsigned 32-bit value (the top byte can set the sign bit).
  return ((m.data[i] << 24) | (m.data[i + 1] << 16) | (m.data[i + 2] << 8) | m.data[i + 3]) >>> 0;
}

describe('makeGenerators - closure injection + validation', () => {
  it('throws when handed a malformed skin (validate runs first, no bypass)', () => {
    expect(() => makeGenerators({} as never)).toThrow();
    expect(() =>
      makeGenerators({ ...TEST_SKIN_A, palette: { ...TEST_SKIN_A.palette, ramp: [0x111111] } }),
    ).toThrow(/ramp/);
  });

  it('exposes a frozen generator record (no raw generator escapes)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    expect(Object.isFrozen(gens)).toBe(true);
    expect(typeof gens.factory).toBe('function');
    expect(typeof gens.sink).toBe('function');
  });
});

describe('generators - explicit native cell size (SYNTH-01)', () => {
  it('defaults nativeCell to 32: FACTORY is 96x96, a 1x1 kind is 32x32', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const factory = gens.factory(state_tag.IDLE, 0);
    expect(factory.width).toBe(96);
    expect(factory.height).toBe(96);
    const sink = gens.sink(state_tag.IDLE, 0);
    expect(sink.width).toBe(32);
    expect(sink.height).toBe(32);
  });

  it('at nativeCell=48: FACTORY is 144x144, a 1x1 kind is 48x48 (a TRUE 48-native render)', () => {
    const gens = makeGenerators(TEST_SKIN_A, 48);
    const factory = gens.factory(state_tag.IDLE, 0);
    expect(factory.width).toBe(144);
    expect(factory.height).toBe(144);
    const sink = gens.sink(state_tag.IDLE, 0);
    expect(sink.width).toBe(48);
    expect(sink.height).toBe(48);
  });
});

// RENDER-01: the sprite box is sized PER-NODE from node.w/h, not the stale 1x1
// KIND_SPECS fallback. Multi-port operators bake at their real footprint (Tee/
// Balancer/Merge 2x2, Router 2x3), a per-node w/h overrides the default (a resized
// Router re-bakes larger), and NO operator ever bakes 1x1.
describe('generators - per-node operator footprint (RENDER-01)', () => {
  it('bakes multi-port operators at their real base footprint, never 1x1', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    // Tee / Balancer / Merge default to 2x2 = 64x64.
    for (const kind of ['tee', 'balancer', 'merge'] as const) {
      const m = gens[kind](state_tag.IDLE, 0);
      expect(m.width, `${kind} default width == 2x2`).toBe(64);
      expect(m.height, `${kind} default height == 2x2`).toBe(64);
      expect(
        m.width === 32 && m.height === 32,
        `${kind} must NEVER bake 1x1`,
      ).toBe(false);
    }
    // Router defaults to 2x3 = 64x96.
    const router = gens.router(state_tag.IDLE, 0);
    expect(router.width).toBe(64);
    expect(router.height).toBe(96);
    // Factory stays 3x3 = 96x96; the 1x1 kinds stay 32x32.
    const factory = gens.factory(state_tag.IDLE, 0);
    expect(factory.width).toBe(96);
    expect(factory.height).toBe(96);
    for (const kind of ['source', 'belt', 'sink'] as const) {
      const m = gens[kind](state_tag.IDLE, 0);
      expect(m.width, `${kind} stays 1x1`).toBe(32);
      expect(m.height).toBe(32);
    }
  });

  it('per-node w/h override the default footprint (a resized operator re-bakes)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    // An explicit 2x4 override wins over the 2x2 default: 64x128.
    const tee = gens.tee(state_tag.IDLE, 0, 2, 4);
    expect(tee.width).toBe(64);
    expect(tee.height).toBe(128);
    // A Router grown 2x3 -> 2x4 bakes the larger 64x128 box.
    const router = gens.router(state_tag.IDLE, 0, 2, 4);
    expect(router.width).toBe(64);
    expect(router.height).toBe(128);
  });

  // THE FAULT-OVERLAY DIMENSION CASE RETIRED WITH ITS SUBJECT (plan 61-07). It asserted
  // that the pulsing fault-marker bake matched the operator body box at the default AND
  // at a per-node override, so an anchor-0.5 child Sprite would overlay pixel-exact.
  // That bake and its set builder are DELETED: a re-run grep found no render-path
  // caller, and this case was their only consumer anywhere - a test whose subject has no
  // other reader is not coverage. The RENDER-01 claim it contributed (the per-node w/h
  // override actually resizes the bake) is unaffected: the case directly above asserts
  // it on the machine bodies themselves.
});

describe('generators - determinism (SYNTH-01)', () => {
  it('same (kind,state,frame,skin,nativeCell) yields a byte-identical matrix', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const a = gens.factory(state_tag.IDLE, 0);
    const b = gens.factory(state_tag.IDLE, 0);
    expect(a.data).toEqual(b.data);
    // Independent buffers (a fresh allocation each call, not a shared reference).
    expect(a.data).not.toBe(b.data);
  });

  it('is byte-identical at nativeCell=48 too', () => {
    const gens = makeGenerators(TEST_SKIN_A, 48);
    expect(gens.sink(state_tag.WORKING, 3).data).toEqual(gens.sink(state_tag.WORKING, 3).data);
  });

  // Data-driven proof (SKIN-02): the generators read the Skin schema rather than
  // hardcoding LOCKED_SKIN's values. Two synthetic fixtures differing in ramp and
  // structural axes must therefore bake byte-different matrices.
  it('two skins produce different matrices for the same inputs (data-driven)', () => {
    const a = makeGenerators(TEST_SKIN_A).factory(state_tag.IDLE, 0);
    const b = makeGenerators(TEST_SKIN_B).factory(state_tag.IDLE, 0);
    expect(a.data).not.toEqual(b.data);
  });
});

// READ-04: the identity glyph scales with the machine body inner-rect, so the
// multi-cell 3x3 FACTORY renders the STRONGEST (largest) glyph on the board and a
// 1x1 kind stays proportionally smaller but crisp and cropped-safe. The chrome
// MachineGlyphIcon path is unaffected (it calls stampGlyph without a scale arg).
describe('generators - body-scaled glyph (Factory hero, READ-04)', () => {
  // Read from the SHIPPED constant, never from a literal or from the fixture. It
  // was `TEST_SKIN_A.bevelDepth` until plan 58-05 deleted that axis; the band depth
  // is now a property of the bake, not of the skin, so the margin has to follow the
  // bake or this isolation silently stops isolating.
  const depth = BEVEL_BAND_DEPTH;
  // The top-left bevel light edge shares the ink colour on this skin, so isolate
  // the GLYPH by counting ink pixels strictly inside the padded inner interior
  // (a margin past the bevel band + the 1px stamp padding).
  const GLYPH_MARGIN = depth + 1;

  /** Count pixels of an exact RGB colour inside a symmetric interior margin. */
  function countColor(m: PixelMatrix, rgb: number, margin: number): number {
    let n = 0;
    for (let y = margin; y < m.height - margin; y++) {
      for (let x = margin; x < m.width - margin; x++) {
        if (px(m, x, y) === rgb) n++;
      }
    }
    return n;
  }

  it('the FACTORY glyph ink-pixel count strictly exceeds a 1x1 kind (multi-cell body reads strongest)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const ink = bakeRamp(TEST_SKIN_A).ink;
    const factory = gens.factory(state_tag.IDLE, 0); // 3x3 body -> 96x96
    const source = gens.source(state_tag.IDLE, 0); // 1x1 body -> 32x32
    const fInk = countColor(factory, ink, GLYPH_MARGIN);
    const sInk = countColor(source, ink, GLYPH_MARGIN);
    expect(sInk).toBeGreaterThan(0);
    expect(fInk, 'FACTORY glyph must be strictly larger than a 1x1 kind glyph').toBeGreaterThan(
      sInk,
    );
  });

  it('no kind stamps glyph ink outside its body inner-rect (crop discipline holds at scale)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const ink = bakeRamp(TEST_SKIN_A).ink;
    // Every generated machine kind (the belt is a track, not a bezel body).
    const kinds: Array<{ name: string; m: PixelMatrix }> = [
      { name: 'factory', m: gens.factory(state_tag.IDLE, 0) },
      { name: 'source', m: gens.source(state_tag.IDLE, 0) },
      { name: 'sink', m: gens.sink(state_tag.IDLE, 0) },
      { name: 'tee', m: gens.tee(state_tag.IDLE, 0) },
      { name: 'balancer', m: gens.balancer(state_tag.IDLE, 0) },
      { name: 'router', m: gens.router(state_tag.IDLE, 0) },
      { name: 'merge', m: gens.merge(state_tag.IDLE, 0) },
    ];
    for (const { name, m } of kinds) {
      // The stampGlyph clamp bounds: inner rect is inset by `depth`, then the glyph
      // is padded a further 1px, so no glyph ink may land at or past that boundary.
      const loX = depth + 1;
      const hiX = m.width - depth - 2;
      const loY = depth + 1;
      const hiY = m.height - depth - 2;
      for (let y = GLYPH_MARGIN; y < m.height - GLYPH_MARGIN; y++) {
        for (let x = GLYPH_MARGIN; x < m.width - GLYPH_MARGIN; x++) {
          if (px(m, x, y) !== ink) continue;
          expect(x >= loX && x <= hiX, `${name} glyph ink x=${x} inside inner`).toBe(true);
          expect(y >= loY && y <= hiY, `${name} glyph ink y=${y} inside inner`).toBe(true);
        }
      }
    }
  });

  it('the body-scaled generator stays a pure integer function (byte-identical repeats)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    expect(gens.factory(state_tag.IDLE, 0).data).toEqual(gens.factory(state_tag.IDLE, 0).data);
    expect(gens.source(state_tag.IDLE, 0).data).toEqual(gens.source(state_tag.IDLE, 0).data);
  });
});

describe('generators - state/frame cues are pure integer functions', () => {
  it('faulted differs from idle (a fault overlay, deterministic)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    expect(gens.factory(state_tag.FAULTED, 0).data).not.toEqual(
      gens.factory(state_tag.IDLE, 0).data,
    );
  });

  it('working frame N differs from frame N+1 (frame is an explicit integer input)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    expect(gens.factory(state_tag.WORKING, 0).data).not.toEqual(
      gens.factory(state_tag.WORKING, 1).data,
    );
  });
});

// READ-03: WORKING must be legible when the sim is PAUSED, on par with the static
// FAULTED marker. A steady emerald body tint (colour + whole-body shape) is baked
// into the body fill BEFORE the glyph is stamped, so the identity glyph ink
// survives ON the tint (Pitfall 1: a tint applied AFTER the stamp swallows the
// glyph). The existing MOTION-01 sweeping accent pixel stays on top as the liveness
// layer. Only the WORKING path gains the tint - IDLE and FAULTED bytes are unchanged.
describe('generators - baked WORKING body tint (paused-legible, READ-03)', () => {
  /** Integer Rec.601 luma (0..255), matching palette.ts's contrast-index math. */
  function lumaOf(rgb: number): number {
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = rgb & 0xff;
    return Math.floor((r * 299 + g * 587 + b * 114) / 1000);
  }

  it('bakes a steady body tint into the WORKING fill pixels at frame 0 (paused)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const ramp = bakeRamp(TEST_SKIN_A);
    const tinted = tintColor(ramp.fill, TEST_SKIN_A.palette.accents.working, WORKING_TINT_PCT);
    const idle = gens.factory(state_tag.IDLE, 0);
    const wrk = gens.factory(state_tag.WORKING, 0);
    let fillCount = 0;
    let tintedCount = 0;
    for (let y = 0; y < idle.height; y++) {
      for (let x = 0; x < idle.width; x++) {
        if (px(idle, x, y) === ramp.fill) {
          fillCount++;
          if (px(wrk, x, y) === tinted) tintedCount++;
        }
      }
    }
    expect(fillCount).toBeGreaterThan(0);
    // Every IDLE body-fill pixel is tinted in WORKING, except at most the single
    // sweeping motion pixel that overwrites one fill pixel at frame 0.
    expect(tintedCount).toBeGreaterThanOrEqual(fillCount - 1);
  });

  it('preserves the stamped glyph ink ON the tint (baked BEFORE stampGlyph - Pitfall 1 guard)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const ink = bakeRamp(TEST_SKIN_A).ink;
    // The top-left bevel LIGHT edge shares the ink colour on this skin, so isolate
    // the GLYPH by counting ink strictly inside the padded interior (past the bevel
    // band + the 1px stamp padding) - the same discipline as the READ-04 glyph test.
    const margin = BEVEL_BAND_DEPTH + 1;
    const idle = gens.factory(state_tag.IDLE, 0);
    const wrk = gens.factory(state_tag.WORKING, 0);
    let idleInk = 0;
    let matched = 0;
    for (let y = margin; y < idle.height - margin; y++) {
      for (let x = margin; x < idle.width - margin; x++) {
        const isIdleInk = px(idle, x, y) === ink;
        const isWrkInk = px(wrk, x, y) === ink;
        if (isIdleInk) idleInk++;
        // Inside the interior the glyph-ink membership must be IDENTICAL between
        // IDLE and WORKING: the tint neither erased a glyph pixel (baked BEFORE the
        // stamp, so the ink lands on top) nor turned a body pixel into ink.
        expect(isIdleInk).toBe(isWrkInk);
        if (isIdleInk && isWrkInk) matched++;
      }
    }
    expect(idleInk).toBeGreaterThan(0);
    expect(matched).toBe(idleInk);
  });

  it('keeps the tinted body -> glyph-ink contrast legible and never collapses into the ink', () => {
    const ramp = bakeRamp(TEST_SKIN_A);
    const tinted = tintColor(ramp.fill, TEST_SKIN_A.palette.accents.working, WORKING_TINT_PCT);
    expect(tinted).not.toBe(ramp.fill); // the tint is actually applied
    expect(tinted).not.toBe(ramp.ink); // the body never collapses into the glyph ink
    const delta = Math.abs(lumaOf(tinted) - lumaOf(ramp.ink));
    // A legibility floor: the glyph ink stays distinguishable from the tinted body.
    expect(delta).toBeGreaterThanOrEqual(12);
  });

  it('LOCKED_SKIN (shipped) keeps a high tinted-body -> ink contrast after the tint', () => {
    const ramp = bakeRamp(LOCKED_SKIN);
    const tinted = tintColor(ramp.fill, LOCKED_SKIN.palette.accents.working, WORKING_TINT_PCT);
    const idleDelta = Math.abs(lumaOf(ramp.fill) - lumaOf(ramp.ink));
    const tintDelta = Math.abs(lumaOf(tinted) - lumaOf(ramp.ink));
    // The shipped skin stays well above a comfortable contrast bar even tinted ...
    expect(tintDelta).toBeGreaterThan(60);
    // ... the mild expected reduction (tint nudges the fill toward the accent) holds.
    expect(idleDelta).toBeGreaterThan(tintDelta);
  });

  it('retains the sweeping motion pixel on top of a frame-independent tint', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const ramp = bakeRamp(TEST_SKIN_A);
    const tinted = tintColor(ramp.fill, TEST_SKIN_A.palette.accents.working, WORKING_TINT_PCT);
    const f0 = gens.factory(state_tag.WORKING, 0);
    const f1 = gens.factory(state_tag.WORKING, 1);
    // Motion: the two frames differ (the accent pixel swept one step).
    expect(f0.data).not.toEqual(f1.data);
    // Steady tint: the tinted body is frame-independent - the tinted-pixel SET is
    // identical across frames except at most the one moving accent pixel per frame.
    let tintedF0 = 0;
    let only0 = 0;
    let only1 = 0;
    for (let y = 0; y < f0.height; y++) {
      for (let x = 0; x < f0.width; x++) {
        const a = px(f0, x, y) === tinted;
        const b = px(f1, x, y) === tinted;
        if (a) tintedF0++;
        if (a && !b) only0++;
        if (b && !a) only1++;
      }
    }
    expect(tintedF0).toBeGreaterThan(0);
    expect(only0).toBeLessThanOrEqual(1);
    expect(only1).toBeLessThanOrEqual(1);
  });

  it('leaves IDLE and FAULTED body bytes untinted (WORKING-only tint)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const ramp = bakeRamp(TEST_SKIN_A);
    const tinted = tintColor(ramp.fill, TEST_SKIN_A.palette.accents.working, WORKING_TINT_PCT);
    const idle = gens.factory(state_tag.IDLE, 0);
    const faulted = gens.factory(state_tag.FAULTED, 0);
    let idleTint = 0;
    let faultTint = 0;
    let idleFill = 0;
    let faultFill = 0;
    for (let y = 0; y < idle.height; y++) {
      for (let x = 0; x < idle.width; x++) {
        if (px(idle, x, y) === tinted) idleTint++;
        if (px(faulted, x, y) === tinted) faultTint++;
        if (px(idle, x, y) === ramp.fill) idleFill++;
        if (px(faulted, x, y) === ramp.fill) faultFill++;
      }
    }
    // No tinted pixel exists in IDLE or FAULTED - the tint is WORKING-only.
    expect(idleTint).toBe(0);
    expect(faultTint).toBe(0);
    // The neutral body fill survives untouched in both.
    expect(idleFill).toBeGreaterThan(0);
    expect(faultFill).toBeGreaterThan(0);
  });

  it('writes only opaque (A=255) or transparent (A=0) WORKING bytes and is deterministic', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    const w = gens.factory(state_tag.WORKING, 3);
    for (let i = 3; i < w.data.length; i += 4) {
      expect(w.data[i] === 0 || w.data[i] === 255).toBe(true);
    }
    expect(gens.factory(state_tag.WORKING, 3).data).toEqual(
      gens.factory(state_tag.WORKING, 3).data,
    );
  });
});

// READ-03 parity guarantee, expressed as an OBJECTIVE automated check (the
// subjective WORKING-when-paused vs FAULTED FEEL judgment is deferred to the v5.0
// FEEL kit). At the paused frame (0) BOTH non-idle states must carry a steady,
// non-neutral body cue - WORKING via the baked emerald tint, FAULTED via the steady
// fault trim/marker - so neither collapses to look like IDLE when the sim is paused.
describe('generators - paused-state parity: WORKING & FAULTED both legible at frame 0 (READ-03)', () => {
  /** Count pixels whose RGB differs between two same-size matrices. */
  function countDiff(a: PixelMatrix, b: PixelMatrix): number {
    let n = 0;
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        if (px(a, x, y) !== px(b, x, y)) n++;
      }
    }
    return n;
  }

  it('WORKING@0 and FAULTED@0 each diverge from IDLE@0 with a steady non-neutral cue (shipped skin)', () => {
    const gens = makeGenerators(LOCKED_SKIN);
    const idle = gens.factory(state_tag.IDLE, 0);
    const working = gens.factory(state_tag.WORKING, 0);
    const faulted = gens.factory(state_tag.FAULTED, 0);
    // Neither paused state is byte-identical to the paused IDLE body.
    expect(working.data).not.toEqual(idle.data);
    expect(faulted.data).not.toEqual(idle.data);
    // FAULTED carries its steady trim + 2x2 marker (a multi-pixel shape cue).
    const faultDiff = countDiff(faulted, idle);
    expect(faultDiff).toBeGreaterThan(4);
    // WORKING now carries a WHOLE-BODY tint - at least on par with (in fact far
    // exceeding) the FAULTED steady marker, so paused WORKING can never read as IDLE.
    const workDiff = countDiff(working, idle);
    expect(workDiff).toBeGreaterThan(faultDiff);
  });
});

// THE `cornerStyle + outlineStyle render (STYLE-02)` DESCRIBE BLOCK WAS DELETED
// HERE BY PLAN 58-05, and deliberately not rewritten.
//
// Its four cases spread `TEST_SKIN_A` into pairs differing on ONE style axis and
// asserted the bake came out byte-different - a genuine data-driven proof while
// those axes were on the `Skin` schema. SKIN-01 removed them, so there is no pair
// to spread. Rewriting the block against the constants that replaced them would have
// produced a test that agrees with its own literal forever - the vacuous-pass class
// this repo refuses - so the coverage moved rather than being faked.
//
// THE GATING CLAUSE THAT USED TO STAND HERE IS RETIRED BY PLAN 61-07, AND IT WAS
// ALREADY STALE WHEN IT WAS WRITTEN DOWN. It said the corner branch was "still
// exercised" by a named unit spec, and that the shipped values were "gated by
// measurement ... the four `dpr-crispness` bezel PNGs and the `pixel-guard` belt-corner
// + operator PNGs". Both halves had expired: plan 59-03 re-pointed those four
// `dpr-crispness` baselines at a composed CSS ring, so they stopped reaching the bake
// two phases before this clause was read, and plan 58-06 re-pointed the operator PNG at
// the shipped VECTOR machine. Plan 61-07 then deleted the shared bezel painter, its
// options type and all three pixel-era holdover constants outright, and the spec the
// clause named retired with its subject - so it now names nothing that exists. It is
// deleted rather than corrected: a description of a gate that no longer has anything to
// gate is a trap for the next reader, and so is a comment spelling a symbol that cannot
// be resolved.
//
// WHAT ACTUALLY COVERS THE MACHINE BODY NOW: `generators - bezel edges are fixed ramp
// indices (SYNTH-05)` below, which reads the banding through `makeGenerators` (the
// only surface that still paints one), plus `generators - determinism (SYNTH-01)`
// above for byte-identical repeats.

// ---------------------------------------------------------------------------
// THE HISTORICAL BELT TILE (plan 61-07).
//
// The four raster belt bakes, the injectable tread/tick painter seam, the welded
// phase-count / tread-pitch pair and the raster geometry and ink records were all
// deleted together, so every case that measured a MARCH retired: a
// still cannot march, and the belt Fabrico draws is vector (gated by
// `synth/beltGeometry.test.ts` and the committed geometry digest table).
//
// WHAT SURVIVES, AND WHY IT IS NOT DEAD COVERAGE. `makeGenerators().belt` still paints
// one thing: the pixel-era belt at its RESTING phase, which is what the Phase 57 art
// board's TODAY column pins at 1.00x / 1.77x / 2.00x. That column is this milestone's
// central visual claim, so the tile it renders must not move silently. These two cases
// are its gate - the INVERTED rail-over-hollow body (the property that made a 90deg
// tile rotation byte-symmetric) and the 16px dash periodicity (the property that made
// abutting tiles phase-align).
// ---------------------------------------------------------------------------
describe('the historical belt tile - the art board TODAY column pixel reference', () => {
  it('is a 1x1-cell tread sprite with a symmetric INVERTED rail body (FLOW-02)', () => {
    const belt = makeGenerators(TEST_SKIN_A).belt;
    const m = belt(state_tag.IDLE, 0);
    expect(m.width).toBe(32);
    expect(m.height).toBe(32);
    // The belt body is a rotation-invariant side-rail lane, NOT a bezel. The top-mid
    // body pixel is the INVERTED locked rail step (rampStep(ramp, 4), rail LIGHTER
    // than the hollow ramp-0 interior; 53-BELT-LOCK.md axis 2), not the bezel's
    // tlLight - and the top-mid and bottom-mid rail pixels are the SAME colour
    // (symmetric rails), so a 90deg whole-sprite rotation leaves the tile identical
    // apart from tread direction: no per-cell lighting flip.
    const railStep = rampStep(TEST_SKIN_A.palette.ramp, 4);
    expect(px(m, m.width >> 1, 0)).toBe(railStep);
    expect(px(m, m.width >> 1, m.height - 1)).toBe(railStep);
    // ... and the inversion holds: the interior between the rails is a DIFFERENT
    // (darker) step than the rails.
    expect(px(m, m.width >> 1, 5)).toBe(rampStep(TEST_SKIN_A.palette.ramp, 0));
  });

  it('inks a dash that is x-periodic with period 16, so abutting tiles phase-align', () => {
    // A per-tile tile tiles seamlessly across the CELL = 32 border ONLY if the dash's
    // spatial period divides 32. The locked dash's x-period is 16 (10px dash + 6px
    // gap), so column x and column x + 16 carry the same ink status and tile A's
    // right-border column lands on the same dash offset as tile B's left-border one.
    // The FULL flow axis is probed, INCLUDING the border columns: the dead-band fix
    // (WINDOWS id 5) is exactly what makes the edge columns participate.
    expect(CELL % 16).toBe(0);
    const m = makeGenerators(TEST_SKIN_A).belt(state_tag.IDLE, 0);
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x + 16 < CELL; x++) {
        expect(rgba(m, x, y), `(${x},${y})`).toBe(rgba(m, x + 16, y));
      }
    }
  });

  it('is frame-INDEPENDENT: the still does not march (the welded march is deleted)', () => {
    // Stated positively rather than left to be inferred from a missing case. The
    // deleted model derived its step from the bucket count (`pitch / K` = 8px), which
    // is the welding BELT-06 could not be fixed around; the board bakes frame 0 and
    // only frame 0, so reproducing that arithmetic here would have kept it alive to
    // serve a caller that never varies the phase.
    const belt = makeGenerators(TEST_SKIN_A).belt;
    expect(belt(state_tag.IDLE, 0).data).toEqual(belt(state_tag.IDLE, 7).data);
  });

  it('does not leak into the sibling machine kinds (they keep their glyph bake)', () => {
    const gens = makeGenerators(TEST_SKIN_A);
    expect(gens.factory(state_tag.IDLE, 0).data).toEqual(gens.factory(state_tag.IDLE, 4).data);
  });
});


describe('generators - bezel edges are fixed ramp indices (SYNTH-05)', () => {
  for (const nativeCell of [32, 48]) {
    it(`lightest top-left / darkest bottom-right at nativeCell=${nativeCell}, no multiply`, () => {
      const gens = makeGenerators(TEST_SKIN_A, nativeCell);
      const ramp = bakeRamp(TEST_SKIN_A);
      const m = gens.sink(state_tag.IDLE, 0);
      const midX = m.width >> 1;
      const midY = m.height >> 1;
      // Top edge (mid-span, clear of the right shadow band) and left column: lightest.
      expect(px(m, midX, 0)).toBe(ramp.tlLight);
      expect(px(m, 0, midY)).toBe(ramp.tlLight);
      // Bottom edge and right column: darkest.
      expect(px(m, midX, m.height - 1)).toBe(ramp.brShadow);
      expect(px(m, m.width - 1, midY)).toBe(ramp.brShadow);
    });
  }
});

