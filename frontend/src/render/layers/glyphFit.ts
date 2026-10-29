// glyphFit.ts - where a machine's glyph is drawn, and at what scale (plan 85-02, D-24).
//
// ONE PLACEMENT FOR EVERY GLYPH. `machines.ts` sets a glyph's scale and position through this
// function and nowhere else. It is pure: a footprint in cells and an author box in `u` in, a
// scale and a position in px out.

import { CELL } from '../../../shared/geometry';
import { U_PER_CELL, U_TO_PX } from './machineChassis';

/** A glyph's placement inside its machine body: the scale (`u` to px) and the top-left in px. */
export interface GlyphFit {
  scale: number;
  x: number;
  y: number;
}

/**
 * Fit a glyph whose author box is `box` (in `u`, the asset's `viewBox`) into a machine whose
 * footprint is `nodeW` by `nodeH` cells, centred on the footprint.
 *
 * IT SHRINKS AND NEVER GROWS. The factor is `min(1, footprint / box)` on each axis, the smaller
 * of the two, so a glyph keeps its aspect and its authored size wherever it fits. A machine
 * whose footprint is smaller than its art (a forged snapshot, or the shipped demo's one-cell
 * HTTP Handler drawing the three-cell Factory art) gets its glyph shrunk until it fits; it is
 * never hidden, and nothing here can throw. A footprint larger than the art leaves the glyph at
 * its authored size, centred.
 *
 * THE BOX IT FITS IS THE FOOTPRINT (`nodeW * U_PER_CELL` by `nodeH * U_PER_CELL`), NOT THE
 * INSET CHASSIS DRAWING (85-RESEARCH correction 2). Every shipped glyph's author box equals its
 * kind's catalog footprint exactly, and the chassis is drawn `CHASSIS_INSET_U` inside it, so
 * fitting to the chassis would shrink every glyph on every normal board. Fitting to the
 * footprint keeps the scale at exactly `U_TO_PX` and the position at exactly the formula that
 * shipped before this function at catalog size, so no normal machine moves.
 *
 * CENTRE THE AUTHOR BOX, NOT THE INK. Glyphs are deliberately asymmetric (TEE is east-heavy),
 * so the box the file was authored in is what is centred.
 */
export function glyphFit(nodeW: number, nodeH: number, box: { w: number; h: number }): GlyphFit {
  const k = Math.min(1, (nodeW * U_PER_CELL) / box.w, (nodeH * U_PER_CELL) / box.h);
  const scale = U_TO_PX * k;
  return {
    scale,
    x: (nodeW * CELL - box.w * scale) / 2,
    y: (nodeH * CELL - box.h * scale) / 2,
  };
}
