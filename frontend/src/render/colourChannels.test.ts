// The spec for the four colour-vision channel transforms (BOARD-01, plan 57-03).
//
// It moved here with its subject. The transforms were written for the art board and
// lived beside it in `src/spike/`; the ART-03 gate over the SHIPPED palette
// (`render/assets/colourVision.test.ts`) imports them too, so they belong on the
// shipped side. This spec owns the transforms themselves - the measured bytes, the
// contract and the linear-light proof - and that gate owns what the shipped colours
// do when they are put through them.
//
// It runs on the project's DEFAULT node environment - no `@vitest-environment`
// docblock, no jsdom, no canvas - because `transformRgba` takes a flat RGBA byte
// array rather than an `ImageData`. That is the whole reason for the signature:
// the arithmetic the board's honesty rests on is settled here, under bare node,
// before either surface that consumes it exists.
//
// EVERY expected byte below was MEASURED on `LOCKED_SKIN.palette.accents.build`
// (`0x4fa8ff` -> `[79, 168, 255]`) and is recorded in 57-RESEARCH.md § F4.4. The
// assertions are exact, never tolerances: a tolerance here would pass for the
// gamma-space implementation this file exists to rule out.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANNELS, MACHADO_1_0, transformRgba, type ChannelKind } from './colourChannels.ts';

const SOURCE = readFileSync(new URL('./colourChannels.ts', import.meta.url), 'utf8');

/** The reference pixel: LOCKED_SKIN.palette.accents.build, opaque. */
const BUILD = (): Uint8ClampedArray => new Uint8ClampedArray([79, 168, 255, 255]);

/** The measured outputs, 57-RESEARCH.md § F4.4. */
const MEASURED: Readonly<Record<ChannelKind, readonly [number, number, number, number]>> = {
  greyscale: [164, 164, 164, 255],
  protan: [129, 173, 255, 255],
  deutan: [104, 156, 253, 255],
  tritan: [0, 189, 200, 255],
};

const bytes = (a: Uint8ClampedArray): number[] => Array.from(a);

describe('colourChannels - the presented channel set', () => {
  it('declares the five channels in one fixed, unranked presentation order', () => {
    // N1: the board reads its column order from HERE and nowhere else. The order
    // is fixed and printed as fixed; it carries no ranking.
    expect(CHANNELS).toEqual(['colour', 'greyscale', 'deutan', 'protan', 'tritan']);
  });
});

describe('colourChannels - the transforms on the reference accent', () => {
  it('greyscale is Rec.709 luminance in linear light and satisfies R == G == B', () => {
    const out = transformRgba(BUILD(), 'greyscale');
    expect(bytes(out)).toEqual([...MEASURED.greyscale]);
    // The UI-SPEC S2 checker property, asserted rather than assumed.
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
  });

  it('protan reproduces the measured bytes exactly', () => {
    expect(bytes(transformRgba(BUILD(), 'protan'))).toEqual([...MEASURED.protan]);
  });

  it('deutan reproduces the measured bytes exactly', () => {
    expect(bytes(transformRgba(BUILD(), 'deutan'))).toEqual([...MEASURED.deutan]);
  });

  it('tritan reproduces the measured bytes exactly', () => {
    expect(bytes(transformRgba(BUILD(), 'tritan'))).toEqual([...MEASURED.tritan]);
  });

  it('each CVD channel differs from both the input and the greyscale rendering', () => {
    // BOTH halves are load-bearing. Without the second, a channel that was never
    // transformed at all still "differs from the input" the moment it is greyed,
    // and an untransformed channel would pass.
    const input = bytes(BUILD());
    const grey = bytes(transformRgba(BUILD(), 'greyscale'));
    for (const kind of ['protan', 'deutan', 'tritan'] as const) {
      const out = bytes(transformRgba(BUILD(), kind));
      expect(out, `${kind} must differ from the input`).not.toEqual(input);
      expect(out, `${kind} must differ from greyscale`).not.toEqual(grey);
    }
  });
});

describe('colourChannels - the transform contract', () => {
  it('alpha passes through untouched', () => {
    const src = new Uint8ClampedArray([79, 168, 255, 128]);
    for (const kind of ['greyscale', 'protan', 'deutan', 'tritan'] as const) {
      expect(transformRgba(src, kind)[3], `${kind} must not touch alpha`).toBe(128);
    }
  });

  it('transforms every pixel of a multi-pixel buffer independently', () => {
    // Two pixels, different alphas: proves the loop strides by 4 and that the
    // alpha copy is per-pixel rather than a single trailing write.
    const src = new Uint8ClampedArray([79, 168, 255, 255, 79, 168, 255, 7]);
    const out = transformRgba(src, 'deutan');
    expect(bytes(out).slice(0, 4)).toEqual([...MEASURED.deutan]);
    expect(bytes(out).slice(4)).toEqual([MEASURED.deutan[0], MEASURED.deutan[1], MEASURED.deutan[2], 7]);
  });

  it('the transform is byte-deterministic across runs', () => {
    for (const kind of ['greyscale', 'protan', 'deutan', 'tritan'] as const) {
      expect(bytes(transformRgba(BUILD(), kind))).toEqual(bytes(transformRgba(BUILD(), kind)));
    }
  });

  it('does not mutate its input', () => {
    const src = BUILD();
    transformRgba(src, 'tritan');
    expect(bytes(src)).toEqual([79, 168, 255, 255]);
  });
});

describe('colourChannels - MACHADO_1_0 drift canary', () => {
  it('carries exactly three severity-1.0 matrices of nine row-major values each', () => {
    expect(Object.keys(MACHADO_1_0).sort()).toEqual(['deutan', 'protan', 'tritan']);
    for (const kind of ['protan', 'deutan', 'tritan'] as const) {
      expect(MACHADO_1_0[kind], `${kind} must be 3x3 row-major`).toHaveLength(9);
    }
  });

  it('pins one spot value per matrix against Machado, Oliveira & Fernandes (2009) Table 1', () => {
    // The VALUE, not just its existence (56-LEARNINGS: a gate that only proves a
    // thing is present has proven nothing about what it is).
    expect(MACHADO_1_0.protan[0]).toBe(0.152286);
    expect(MACHADO_1_0.deutan[4]).toBe(0.672501);
    expect(MACHADO_1_0.tritan[8]).toBe(0.3039);
  });
});

describe('colourChannels - source assertions', () => {
  it('imports nothing at all, and pulls in no node builtin', () => {
    // A browser-bundle module (render/svgAssets.ts states the constraint). Asserted
    // here rather than left to a shell grep in a plan nobody re-runs.
    expect(SOURCE.split('\n').filter((l) => /^\s*import\s/.test(l))).toEqual([]);
    expect(SOURCE).not.toContain('node:');
  });

  it('names the NTSC luma trap in a comment and uses the weights nowhere else', () => {
    // The plan's shell criterion for this was `grep -cE "0\.299|0\.587|0\.114"` is
    // at most 1. It cannot be: the protan matrix's SECOND ROW opens with the
    // Machado coefficient 0.114503, which the pattern `0\.114` matches. So the
    // real property is asserted directly instead - the trap is named in a comment,
    // and the NTSC triple appears in no arithmetic anywhere in the module.
    const trap = SOURCE.split('\n').filter((l) => /0\.299|0\.587/.test(l));
    expect(trap).toHaveLength(1);
    expect(trap[0]!.trim().startsWith('//')).toBe(true);
    // The NTSC weights never appear as an expression - only inside that comment.
    expect(SOURCE.replace(trap[0]!, '')).not.toMatch(/0\.299|0\.587/);
    // And every other line matching `0.114` is a Machado coefficient, not a weight.
    for (const line of SOURCE.split('\n').filter((l) => /0\.114/.test(l) && l !== trap[0])) {
      expect(line).toContain('0.114503');
    }
  });
});

describe('colourChannels - the linear-light proof', () => {
  it('a gamma-space application of the same matrix produces a different answer', () => {
    // THIS IS THE ASSERTION THAT KILLS MUTATION M2. Applying the Machado matrix
    // to gamma-encoded bytes is the single most common implementation of this
    // transform, and it fails in the DANGEROUS direction: it preserves apparent
    // separation between colours a dichromat cannot separate, so a failing
    // direction would look passable on the board.
    //
    // Recomputed here from scratch - same matrix, no linearisation, no
    // re-encoding - so the spec proves the two answers are different rather than
    // trusting the module to have taken the right path.
    const m = MACHADO_1_0.deutan;
    const [r, g, b] = [79 / 255, 168 / 255, 255 / 255];
    const clampByte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
    const gammaSpace = [
      clampByte(m[0]! * r + m[1]! * g + m[2]! * b),
      clampByte(m[3]! * r + m[4]! * g + m[5]! * b),
      clampByte(m[6]! * r + m[7]! * g + m[8]! * b),
    ];

    expect(gammaSpace).not.toEqual([MEASURED.deutan[0], MEASURED.deutan[1], MEASURED.deutan[2]]);
    // And it is not a rounding-level difference either - it is visibly a
    // different colour, which is exactly why the shortcut is undetectable by eye.
    expect(Math.abs(gammaSpace[0]! - MEASURED.deutan[0])).toBeGreaterThan(4);
  });
});
