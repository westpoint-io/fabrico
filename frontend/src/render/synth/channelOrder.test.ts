import { describe, expect, it, vi } from 'vitest';

// Re-homed rgba8unorm / BGRA channel-order guard (was the spikeOverlay.sample()
// readback in the retired e2e/synth-leak.spec.ts). The spike overlay is gone, but
// the pitfall it guarded is structural to the synth pipeline and must not be lost:
//
//   1. The generator matrix is the AUTHORITATIVE artifact. A locked body-fill
//      pixel must carry the ramp's fixed mid step in R,G,B byte order. An RGBA
//      authoring bug (writing B where R belongs) would surface here as a swap.
//      We assert the MATRIX bytes directly and never read a texture back for
//      equality (research Pitfall 6: the texture is a write-only downstream copy).
//   2. matrixToTexture MUST construct its BufferImageSource with
//      `format: 'rgba8unorm'`. BufferImageSource auto-detects a Uint8ClampedArray
//      as `bgra8unorm` (channel-swapped) unless the format is passed explicitly,
//      so dropping it silently exchanges R and B on the GPU upload. We spy on the
//      Pixi constructor to assert the format is passed (GPU-free, node env).

// Capture every BufferImageSource construction so we can assert the upload format
// without a live GPU. Hoisted so the vi.mock factory can reference it.
const { bufferCalls } = vi.hoisted(() => ({
  bufferCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('pixi.js', () => ({
  BufferImageSource: class {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      bufferCalls.push(options);
      this.options = options;
    }
  },
  Texture: class {
    source: unknown;
    constructor(opts: { source: unknown }) {
      this.source = opts?.source;
    }
  },
}));

import { makeGenerators } from './generators.ts';
import { bakeRamp } from './palette.ts';
import { matrixToTexture } from './textureCache.ts';
import { LOCKED_SKIN } from './skins/locked.ts';
import { state_tag } from '../../protocol/kinds.ts';

describe('channel order — the generator matrix carries R,G,B in order (BGRA guard)', () => {
  it('a locked body-fill pixel reads the ramp mid step as R,G,B (never swapped)', () => {
    const ramp = bakeRamp(LOCKED_SKIN);
    const fillR = (ramp.fill >> 16) & 0xff;
    const fillG = (ramp.fill >> 8) & 0xff;
    const fillB = ramp.fill & 0xff;
    // The locked skin is not R==B, so an R/B exchange is detectable.
    expect(fillR).not.toBe(fillB);

    // Bake a 32-native 1x1 machine (SINK) at IDLE so no state cue overlays the body.
    const gen = makeGenerators(LOCKED_SKIN, 32);
    const m = gen.sink(state_tag.IDLE, 0);

    // A guaranteed body-fill pixel: past the 1px bevel + 1px inner outline (x=4),
    // vertically centered (y=16), and left of the centered monogram glyph.
    const x = 4;
    const y = 16;
    const i = (y * m.width + x) * 4;
    expect(m.data[i], `red channel (BGRA swap would read ${fillB})`).toBe(fillR);
    expect(m.data[i + 1], 'green channel').toBe(fillG);
    expect(m.data[i + 2], `blue channel (BGRA swap would read ${fillR})`).toBe(fillB);
    expect(m.data[i + 3], 'alpha (opaque body)').toBe(255);
  });
});

describe('channel order — matrixToTexture pins the rgba8unorm upload format', () => {
  it('constructs BufferImageSource with format rgba8unorm over the matrix bytes', () => {
    bufferCalls.length = 0;
    const gen = makeGenerators(LOCKED_SKIN, 32);
    const m = gen.factory(state_tag.IDLE, 0);
    matrixToTexture(m);

    expect(bufferCalls).toHaveLength(1);
    const opts = bufferCalls[0];
    // The explicit format is the exact bgra8unorm auto-detect pitfall guard.
    expect(opts.format).toBe('rgba8unorm');
    expect(opts.scaleMode).toBe('nearest');
    expect(opts.resource).toBe(m.data);
    expect(opts.width).toBe(m.width);
    expect(opts.height).toBe(m.height);
  });
});
