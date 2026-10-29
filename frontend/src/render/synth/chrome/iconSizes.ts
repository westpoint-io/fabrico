// iconSizes.ts (CHROME-01, plan 59-01) - the ONE declaration of the chrome icon size
// ladder. Two numbers, and both are derived rather than chosen.
//
// THE FLOOR IS SET BY THE THINNEST STROKE REACHING ONE WHOLE CSS PIXEL. The pixel-era
// literals this module replaces (`TOOLBAR_ICON_PX = 8`, `PALETTE_GLYPH_PX = 11`,
// `LEGEND_GLYPH_PX = 11`) were sized for a bit matrix rendered at an integer number of
// CSS px per BIT. A vector glyph on the 32u grid has no bits; its legibility floor is
// `px / 32 * strokeU >= 1` over the locked two-weight {2u detail, 3u structural} pair:
//
//   |  box | 2u detail | 3u structural | verdict                        |
//   |------|-----------|---------------|--------------------------------|
//   |  8px |   0.50 px |       0.75 px | both sub-pixel - grey mush     |
//   | 11px |   0.69 px |       1.03 px | detail stroke sub-pixel        |
//   | 16px |   1.00 px |       1.50 px | 2u is EXACTLY one whole pixel  |
//   | 24px |   1.50 px |       2.25 px | comfortable                    |
//
// Plan 59-03 emits these two as `--fab-icon-md` and `--fab-icon-lg` from
// `skinToCssVars`; this module is where they are DECLARED once, so the CSS custom
// property and the React `px` prop cannot drift apart.

/**
 * The default chrome icon box: 16px.
 *
 * The SMALLEST LEGAL chrome icon, and it is legal for an exact reason rather than a
 * comfortable one: `32 / 16 = 2`, so the 2u detail stroke lands on exactly 1.00 CSS px.
 * Below this the icon set stops being crisp, which is the thing this phase exists to
 * fix, so 16 is a FLOOR and not a default to be tuned down under layout pressure. It is
 * the same number `LOD_MIN_MACHINE_PX = 16` rests on in Phase 58, arrived at from the
 * other direction.
 *
 * Consumers: the transport / warning family and the Legend machine key.
 */
export const ICON_MD_PX = 16;

/**
 * The Palette machine icon box: 24px.
 *
 * WHY THE PALETTE NEEDS THE LARGER STEP AND THE LEGEND DOES NOT. A palette icon draws
 * the CHASSIS as well as the glyph, and the chassis eats the outer 4u of centreline
 * inset plus half of its 3u stroke on every side, leaving a 24u interior for the motif.
 * A 1x1 subject's motif ink spans about 12u of its 32u box, so at box size `S` the motif
 * renders at `12/32 * S`:
 *
 *   - S = 24 -> motif 9.0 px, which is EXACTLY the size today's 11px bare bit-matrix
 *     glyph renders its 9x9 motif at. Identification legibility is held CONSTANT across
 *     the change rather than traded for crispness.
 *   - S = 16 -> motif 6.0 px, a one-third regression on the one surface whose whole job
 *     is identification before the label is read.
 *
 * The Legend is a different job: its glyph sits beside the kind's NAME, so the name
 * carries identification and the glyph carries recognition. It takes {@link ICON_MD_PX}.
 */
export const ICON_LG_PX = 24;
