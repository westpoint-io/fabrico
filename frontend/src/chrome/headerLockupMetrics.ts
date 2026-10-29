// headerLockupMetrics.ts - the ONE declaration of the header lockup's shipped height
// (MARK-17, phase 80.1, code review WR-01).
//
// WHY A MODULE FOR ONE NUMBER. `HEADER_PX` was declared twice, once in
// `scripts/build-lockup.ts` and once in `src/chrome/HeaderLockup.tsx`, with no import
// between them and no gate comparing them. Only the component's copy renders. The
// generator's copy is used to compute the CSS-px figures baked into the shipped asset's
// provenance header: the dropped tagline's band, the D-04 plate radius in CSS px and the
// device-px numbers beside them. So changing the header height in the component left the
// committed SVG asserting "2.831 CSS px at the shipped height" and "the tagline band is
// 1.536 CSS px", both false, with every gate green. That is drift inside the one file whose
// own docblock promises "a change to a size, a padding or a radius moves the artwork and its
// own documentation together".
//
// WHY IT IS THE COMPONENT THAT MOVED AND NOT THE GENERATOR. `HeaderLockup.tsx` cannot import
// `scripts/build-lockup.ts`: that module pulls in `fontkit`, `wawoff2` and `node:fs`, none of
// which may reach the browser bundle (D-07). The direction that works is the other
// one, and it is already the house pattern: `scripts/mark-craft.ts` and
// `scripts/build-mark-sheet.ts` both import `LOCKED_SKIN` and `skinToCssVars` out of `src/`.
//
// PURE VALUES, NO DEPENDENCIES, ERASURE-ONLY TYPESCRIPT. It is imported by app code under
// Vite, by specs under vitest, and by a generator that node runs directly through native type
// stripping. Anything with an import in it would have to work in all three.

/**
 * The header lockup's rendered HEIGHT in CSS px, and the height the generator reports its
 * drawing at.
 *
 * 32, the height of the 32 px square the cut replaced (`LOGOMARK_PX` in the retired
 * LogoMark component, removed 2026-10-11), so the header row's height, its padding and the
 * vertical centring of every other cluster did not move when the lockup landed.
 *
 * THE WIDTH IS NOT HERE AND MUST NOT BE. It is derived at render time from this and the
 * asset's parsed crop aspect (`HEADER_PX * (w / h)`, 145.807 CSS px at the committed crop).
 * A second constant for the width would be a transcription that has to agree with a
 * measurement, and it would distort the drawing the moment the crop moved.
 *
 * IF THIS NUMBER MOVES, the emitted provenance in `frontend/src/chrome/brand/fabrico-header.svg`
 * moves with it, so `npm run build:header-cut` must be re-run in the same commit and
 * `headerCut.test.ts` D-1 reddens until it is. That coupling is the point of this module.
 */
export const HEADER_PX = 32;
