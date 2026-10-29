// In-code glyph bit matrices (SYNTH-03). Each machine_kind maps to a hand-defined
// matrix of 0/1 rows, in the spirit of a CC0 monogram pixel aesthetic so the
// canvas glyphs read as one world with the Phase 27 chrome text. The motif
// vocabulary mirrors the current vector renderer (machines.ts drawGlyph): braces
// for FACTORY (the hero), an eye for SOURCE, a bullseye for SINK, a fork for TEE,
// and so on. There is exactly ONE stamping function; every generator writes
// glyphs through it, which is what makes the "1px padding, one code path"
// discipline enforceable rather than conventional.

import { machine_kind } from '../../protocol/kinds.ts';
import type { PixelMatrix, Rect } from './types.ts';

// Motifs are authored on a 9-wide grid (odd, so a single-pixel spine centers).
// 1 = ink pixel, 0 = background (left untouched by stampGlyph).

// FACTORY - code braces { }, the hero machine.
const FACTORY: number[][] = [
  [0, 0, 1, 0, 0, 0, 1, 0, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [1, 0, 0, 0, 0, 0, 0, 0, 1],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 0],
];

// SOURCE - spawn eye with a filled pupil.
const SOURCE: number[][] = [
  [0, 0, 1, 1, 1, 1, 1, 0, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [1, 0, 0, 1, 1, 1, 0, 0, 1],
  [1, 0, 1, 1, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 1, 1, 0, 1],
  [1, 0, 0, 1, 1, 1, 0, 0, 1],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 1, 1, 1, 1, 1, 0, 0],
];

// SINK - bullseye (launch the rocket / terminal).
const SINK: number[][] = [
  [0, 0, 1, 1, 1, 1, 1, 0, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [1, 0, 0, 1, 1, 1, 0, 0, 1],
  [1, 0, 1, 0, 0, 0, 1, 0, 1],
  [1, 0, 1, 0, 1, 0, 1, 0, 1],
  [1, 0, 1, 0, 0, 0, 1, 0, 1],
  [1, 0, 0, 1, 1, 1, 0, 0, 1],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 1, 1, 1, 1, 1, 0, 0],
];

// TEE - one-IN / two-OUT fork. A single horizontal input spine enters from the
// left and forks into two divergent outputs (upper-right + lower-right tips).
// Silhouette reads as an opening "<": clearly not a funnel or a diamond.
const TEE: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0, 1, 0, 0, 0],
  [1, 1, 1, 1, 1, 1, 0, 0, 0],
  [0, 0, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1],
];

// BALANCER - parallel even split: two full-width horizontal bars joined by a
// central spine (an "I"). The two opposed bars are the even-split motif; the
// silhouette is unmistakably a pair of rails, never a fork or a diamond.
const BALANCER: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
];

// ROUTER - decision diamond with a central switch cell. A clean diamond OUTLINE
// (single-cell top/bottom apex, widest equator touching both edges) with an
// inner dot on the equator - the "decide which way" motif.
const ROUTER: number[][] = [
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 0],
  [0, 0, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
];

// MERGE - many-to-one funnel: a wide top mouth converges down diagonal walls to
// a single 1-wide centered neck. The strong top-heavy taper is the inverse of
// TEE's fork and cannot be confused with the balancer's twin bars.
const MERGE: number[][] = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 0],
  [0, 0, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
];

// BELT - directional chevrons (a track, not a machine box; present so every
// machine_kind resolves to a matrix).
const BELT: number[][] = [
  [0, 0, 1, 0, 0, 1, 0, 0, 1],
  [0, 1, 0, 0, 1, 0, 0, 1, 0],
  [1, 0, 0, 1, 0, 0, 1, 0, 0],
  [0, 1, 0, 0, 1, 0, 0, 1, 0],
  [0, 0, 1, 0, 0, 1, 0, 0, 1],
];

/** Fallback for an unknown kind - a single ink dot. Never null, never throws. */
export const DEFAULT_GLYPH: number[][] = [[1]];

/** Bit matrices keyed strictly off machine_kind (never magic numbers). */
export const GLYPHS: Record<number, number[][]> = {
  [machine_kind.SOURCE]: SOURCE,
  [machine_kind.BELT]: BELT,
  [machine_kind.FACTORY]: FACTORY,
  [machine_kind.TEE]: TEE,
  [machine_kind.BALANCER]: BALANCER,
  [machine_kind.ROUTER]: ROUTER,
  [machine_kind.MERGE]: MERGE,
  [machine_kind.SINK]: SINK,
};

/** Resolve a kind to its matrix, falling back to the default dot (never throws). */
export function getGlyph(kind: number): number[][] {
  return GLYPHS[kind] ?? DEFAULT_GLYPH;
}

/**
 * Stamp a bit-matrix glyph into `innerRect`, centered, with at least 1px padding
 * from the inner border on every side. Each set bit writes a `scale x scale`
 * opaque ink block via integer nearest-neighbour expansion (the 1px-stroke
 * aesthetic preserved: `scale = 1` writes one pixel per bit, the default);
 * background bits are untouched. The glyph is re-centered on its SCALED extent
 * (`gw*scale` / `gh*scale`) and every write is clamped strictly inside the padded
 * interior of innerRect AND the matrix, so an oversized (scaled) glyph is cropped
 * rather than overflowing. Pure and integer-only: iterates the row/col arrays
 * (never object keys), no wall-clock, no RNG.
 *
 * `scale` defaults to 1 so callers that omit it (e.g. the chrome
 * MachineGlyphIcon mask) produce byte-identical output to the pre-scale stamp.
 * Only the machine generator passes a computed body scale (READ-04).
 */
export function stampGlyph(
  m: PixelMatrix,
  glyph: number[][],
  ink: number,
  innerRect: Rect,
  scale = 1,
): void {
  const gh = glyph.length;
  if (gh === 0) return;
  const gw = glyph[0].length;
  // Integer nearest-neighbour only; never below 1 (a 0/float scale would blur or
  // erase the glyph, violating the pixel aesthetic).
  const s = scale < 1 ? 1 : Math.floor(scale);

  const r = (ink >> 16) & 0xff;
  const g = (ink >> 8) & 0xff;
  const b = ink & 0xff;

  // Padded interior bounds (inclusive) - the only region we are allowed to touch.
  const minX = innerRect.x + 1;
  const maxX = innerRect.x + innerRect.w - 2;
  const minY = innerRect.y + 1;
  const maxY = innerRect.y + innerRect.h - 2;

  const availW = innerRect.w - 2;
  const availH = innerRect.h - 2;
  // Centre on the SCALED extent so the block grid stays centred in the inner rect.
  const startX = minX + ((availW - gw * s) >> 1);
  const startY = minY + ((availH - gh * s) >> 1);

  for (let row = 0; row < gh; row++) {
    const cols = glyph[row];
    const baseY = startY + row * s;
    for (let col = 0; col < cols.length; col++) {
      if (cols[col] !== 1) continue;
      const baseX = startX + col * s;
      // Expand this set bit into a scale x scale opaque block, clamping each pixel
      // (crop, never overflow the padded interior or the matrix bounds).
      for (let dy = 0; dy < s; dy++) {
        const py = baseY + dy;
        if (py < minY || py > maxY || py < 0 || py >= m.height) continue;
        for (let dx = 0; dx < s; dx++) {
          const px = baseX + dx;
          if (px < minX || px > maxX || px < 0 || px >= m.width) continue;
          const idx = (py * m.width + px) * 4;
          m.data[idx] = r;
          m.data[idx + 1] = g;
          m.data[idx + 2] = b;
          m.data[idx + 3] = 255;
        }
      }
    }
  }
}
