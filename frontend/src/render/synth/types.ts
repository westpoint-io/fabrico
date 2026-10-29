// Leaf types for the pure sprite-synthesis layer. No Pixi, no DOM: a PixelMatrix
// is a plain RGBA byte buffer plus integer dimensions, so generators stay pure
// and their output is byte-comparable (the Uint8ClampedArray is the authoritative
// artifact; a Pixi TextureSource is a write-only downstream copy, see 23-RESEARCH).

import type { StateTag } from '../../protocol/kinds.ts';

/** Re-export for local convenience so synth modules do not reach across the tree. */
export type { StateTag };

/**
 * An RGBA pixel buffer. `data` is row-major, 4 bytes (R,G,B,A) per pixel, length
 * exactly `width * height * 4`. Uint8ClampedArray so writes saturate at 0..255
 * without float rounding, keeping matrices deterministic and byte-stable.
 */
export interface PixelMatrix {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** An integer axis-aligned rectangle in matrix pixel space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Allocate a zeroed (fully transparent) matrix of integer dimensions. */
export function makeMatrix(width: number, height: number): PixelMatrix {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}
