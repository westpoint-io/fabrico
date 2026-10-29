// The colour-vision channel transforms (BOARD-01, plan 57-03): greyscale plus the
// three dichromat simulations, hand-rolled, in LINEAR LIGHT, over a flat RGBA byte
// array.
//
// WHERE THIS LIVES, AND WHY IT MOVED. It was written in Phase 57 as a module of the
// art board and lived in `src/spike/` with the rest of that instrument. It has two
// consumers now, and only one of them is the board: `render/assets/colourVision.test.ts`
// is the ART-03 gate over the colours that actually SHIP, and it imports these
// transforms rather than re-authoring the matrices, so that the shipped palette and
// the board can never quietly disagree about what a dichromat sees. A SHIPPED gate
// resting on a module inside the tree's dev-tooling directory is the wrong way round -
// `src/spike/` is explicitly not the render path (`61-CONTEXT.md` section F), and the
// board's structural gate asserts that nothing outside it imports a board module. So
// the transforms live here, on the shipped side, and the board imports them like any
// other consumer. Nothing about the arithmetic changed in the move.
//
// WHY LINEAR LIGHT IS THE WHOLE POINT. The Machado, Oliveira & Fernandes (2009)
// model is derived through LMS from LINEAR RGB, so the matrices below must be
// applied to the linearised triple - sRGB EOTF in, matrix, sRGB OETF out. The
// common implementation skips both encode steps and multiplies gamma-encoded
// bytes directly, and it fails in the DANGEROUS direction: it preserves apparent
// separation between colours a dichromat cannot actually separate, so the panel
// would report a pass on a direction that fails. The authors' page does not state
// the space; the R `colorspace` package's `simulate_cvd` does, and changed its
// default TO linear for exactly this reason ("a new argument `linear = TRUE` ...
// because Machado et al. (2009) implicitly relies on a linear RGB space").
// `colourChannels.test.ts` recomputes the deutan result the gamma way and
// asserts the two answers differ, so the claim in this paragraph is enforced
// rather than merely written down.
//
// WHY HAND-ROLLED RATHER THAN A PACKAGE. About forty lines, against five candidate
// npm packages (`color-blind`, `colorblind`, `daltonize`, `culori`, `chroma-js`)
// that would each need a legitimacy audit and each carry a transitive tail - for a
// function whose 27 constants are already verified value-by-value against the
// authors' own publication (57-RESEARCH.md § F4.1). This follows the tree's
// established no-new-deps precedent (`render/synth/skin.ts`'s hand-rolled
// `validate()`, chosen over zod for the same reason).
//
// WHY THE TRANSFORM IS APPLIED TO EXTRACTED PIXELS IN JS, and not through a CSS
// `filter: url(#...)` with `<feColorMatrix>`. NOT because `linearRGB` is the wrong
// filter default - it is the right one, and setting it to `sRGB` would be the bug.
// It is rejected because the transform would then happen inside the browser's
// filter/compositing path: renderer-dependent, and the completeness gate would get
// no pixels to measure. The JS path yields bytes a spec can assert on.
//
// SIGNATURE NOTE. `transformRgba` takes a flat `Uint8ClampedArray`, NOT an
// `ImageData`, so this module and its spec run under the project's default node
// vitest environment with no jsdom and no canvas. The board's channel panel (plan
// 57-07) hands it `imageData.data` and wraps the result back up; the ART-03 gate
// hands it a one-pixel buffer built from a palette int.
//
// This module has ZERO imports of any kind - no DOM type, and in particular no
// node builtin (it is a browser-bundle module, the constraint
// `render/svgAssets.ts` states in its header).

/* ------------------------------------------------------------------ *
 * The presented channel set
 * ------------------------------------------------------------------ */

/**
 * The five channels, in ONE fixed presentation order.
 *
 * The order is fixed, is printed on the art board as fixed, and CARRIES NO RANKING -
 * `deutan` leads the three simulations because deuteranomaly is the most common
 * deficiency, not because it matters most to the judgement. `colour` is the
 * untransformed rendering and is therefore NOT a member of `ChannelKind`: there is
 * nothing to transform.
 *
 * Both consumers read the order from here and nowhere else (N1): the art board's
 * channel panel lays its rows out in this order, and the ART-03 gate reports its
 * tables in it.
 */
export const CHANNELS = ['colour', 'greyscale', 'deutan', 'protan', 'tritan'] as const;

/** The four channels that are DERIVED from the colour rendering by a transform. */
export type ChannelKind = Exclude<(typeof CHANNELS)[number], 'colour'>;

/* ------------------------------------------------------------------ *
 * sRGB transfer functions
 * ------------------------------------------------------------------ */

/**
 * sRGB EOTF as a 256-entry lookup: byte -> linear-light float in [0, 1].
 *
 * Built once at module load. Only the INVERSE needs a live `Math.pow`, which is
 * what keeps a full cell cheap (measured: 0.08 ms for a 192x192 cell, so all 100
 * channel images cost 8 ms - no optimisation pressure at all).
 */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * sRGB OETF: linear-light float -> 8-bit byte.
 *
 * Clamps to [0, 1] BEFORE encoding. That order matters: the CVD matrices have
 * negative coefficients and routinely produce out-of-gamut values, and
 * `Math.pow(negative, 1/2.4)` is `NaN`, which would write 0 through the
 * `Uint8ClampedArray` and silently blacken pixels rather than clipping them.
 */
function encode(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
}

/* ------------------------------------------------------------------ *
 * The Machado severity-1.0 matrices
 * ------------------------------------------------------------------ */

/**
 * Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for
 * Simulation of Color Vision Deficiency", IEEE TVCG 15(6) - Table 1, SEVERITY 1.0
 * (full dichromacy). Published on the authors' own page:
 * https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/CVD_Simulation.html
 *
 * ALL 27 VALUES WERE VERIFIED VERBATIM against that publication
 * (57-RESEARCH.md § F4.1). They are transcribed, never re-derived and never
 * rounded.
 *
 * Row-major: each group of three dots the LINEAR (R, G, B) triple to produce one
 * output channel. The matrices operate on the LINEAR triple because the model
 * implicitly relies on a linearised RGB space - see the module header for the
 * independent confirmation and for why the gamma-space shortcut is the dangerous
 * one.
 */
export const MACHADO_1_0 = Object.freeze({
  protan: Object.freeze([
    0.152286, 1.052583, -0.204868,
    0.114503, 0.786281, 0.099216,
    -0.003882, -0.048116, 1.051998,
  ]),
  deutan: Object.freeze([
    0.367322, 0.860646, -0.227968,
    0.280085, 0.672501, 0.047413,
    -0.01182, 0.04294, 0.968881,
  ]),
  tritan: Object.freeze([
    1.255528, -0.076749, -0.178779,
    -0.078411, 0.930809, 0.147602,
    0.004733, 0.691367, 0.3039,
  ]),
}) as Readonly<Record<Exclude<ChannelKind, 'greyscale'>, readonly number[]>>;

/* ------------------------------------------------------------------ *
 * The transform
 * ------------------------------------------------------------------ */

/**
 * Transform a flat RGBA byte buffer into one channel rendering.
 *
 * Pure: the input is never mutated and the output is a fresh array of the same
 * length, so two calls on the same input are byte-identical.
 *
 * THE SUBSTRATE IS INSIDE THE TRANSFORM (UI-SPEC D.2). The caller extracts each
 * cell INCLUDING its background and hands the whole thing here; a greyscale
 * silhouette judged against an untransformed background would show a contrast
 * that does not exist.
 */
export function transformRgba(src: Uint8ClampedArray, kind: ChannelKind): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const m = kind === 'greyscale' ? null : MACHADO_1_0[kind];

  for (let p = 0; p + 3 < src.length; p += 4) {
    const r = LIN[src[p]!]!;
    const g = LIN[src[p + 1]!]!;
    const b = LIN[src[p + 2]!]!;

    if (m === null) {
      // Rec.709 / sRGB LUMINANCE weights (IEC 61966-2-1), applied in LINEAR light.
      // THE TRAP: 0.299 / 0.587 / 0.114 is NTSC *luma* on gamma-encoded bytes - a
      // different quantity entirely, and the one every casual greyscale
      // implementation reaches for. ART-01's bar is about luminance.
      const y = encode(0.2126 * r + 0.7152 * g + 0.0722 * b);
      out[p] = y;
      out[p + 1] = y;
      out[p + 2] = y;
    } else {
      out[p] = encode(m[0]! * r + m[1]! * g + m[2]! * b);
      out[p + 1] = encode(m[3]! * r + m[4]! * g + m[5]! * b);
      out[p + 2] = encode(m[6]! * r + m[7]! * g + m[8]! * b);
    }

    out[p + 3] = src[p + 3]!; // alpha passes through untouched
  }

  return out;
}
