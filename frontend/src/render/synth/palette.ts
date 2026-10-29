// The single-light-source bevel helper (SYNTH-05). A skin ramp is an ordered
// array of 0xRRGGBB steps darkest->lightest. The bevel light/shadow edges are
// picked by FIXED index into that ramp, so the light source (top-left) is
// globally consistent BY CONSTRUCTION. Nothing here computes `base * factor` or
// multiplies alpha: every returned color is an actual ramp entry (identity),
// which is exactly what makes "no brightness multiply" enforceable at the data
// layer rather than by convention.

import type { Skin } from './skin.ts';

/** The fixed bevel constants a generator consumes for one skin. */
export interface BakedRamp {
  /** Lightest step -> top + left edges (the single top-left light source). */
  tlLight: number;
  /** Darkest step -> bottom + right edges. */
  brShadow: number;
  /** A fixed mid step for the panel body fill. */
  fill: number;
  /** A fixed step for the glyph ink, chosen for contrast against `fill`. */
  ink: number;
}

/** Bounds-safe fixed-index read: clamps `i` into `[0, ramp.length-1]`. */
export function rampStep(ramp: number[], i: number): number {
  const last = ramp.length - 1;
  const clamped = i < 0 ? 0 : i > last ? last : i;
  return ramp[clamped];
}

/**
 * Integer relative luminance (0..255) via the standard Rec.601 weights, done in
 * pure integer math so the ink-contrast choice is deterministic and portable.
 * This selects an INDEX; it never scales the returned color.
 */
function luma(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return Math.floor((r * 299 + g * 587 + b * 114) / 1000);
}

/**
 * Bake the fixed bevel constants for a skin. `tlLight`/`brShadow` are the extreme
 * ramp steps by fixed index (last / 0); `fill` is the fixed middle step; `ink`
 * is whichever extreme contrasts with `fill` (index selection only). Pure:
 * identical skin in -> byte-equal result out.
 */
export function bakeRamp(skin: Skin): BakedRamp {
  const ramp = skin.palette.ramp;
  const last = ramp.length - 1;
  const tlLight = ramp[last];
  const brShadow = ramp[0];
  // Fixed middle index for the body fill (floor of the midpoint).
  const fill = rampStep(ramp, last >> 1);
  // Contrast the glyph against the fill by picking the lighter or darker extreme
  // step - a choice of index, not a brightness computation on the output color.
  const ink = luma(fill) < 128 ? tlLight : brShadow;
  return { tlLight, brShadow, fill, ink };
}
