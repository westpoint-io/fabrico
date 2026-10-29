// The LOCKED styling source of truth (STYLE-03). This module is the ONLY styling
// input the renderer consumes; it SURVIVES the style-board retirement (unlike
// `../board/`, which was deleted at style-lock exit). It exports exactly ONE pure
// `Skin` data literal conforming to the `../skin.ts` schema (no new fields, no new
// enums) and validates it at module load, so any schema drift throws a named Error
// before a single sprite is produced downstream.
//
// `LOCKED_SKIN` is the shipped skin, and the ONLY one. SKIN-02 (v7.0) removed the
// theme system: the second built-in skin authored here under SKIN-06 (the
// accessibility alternative) is deleted, there is no swap surface, and nothing in
// the app can change the skin.
// Where a spec needs a second `Skin` to prove a generator is data-driven it builds
// a synthetic literal in `../__fixtures__/testSkins.ts` - never a shipped one.

import { validate, type Skin } from '../skin.ts';

// ============================================================================
// LOCKED - "Clean Slate". The maintainers' art-direction pick, locked 2026-07-06 on the
// live style board (`?styleBoard=1`, Plan 24-05 Task 2 checkpoint).
// ----------------------------------------------------------------------------
// This is the finalized Fabrico style: a cool neutral grey-steel ramp, a two-weight
// 3u/2u stroke hierarchy on square (radius-0) shadowless geometry, and the
// centre-dash belt tread (re-locked to Direction B's 10/6 centreline dash by
// 53-BELT-LOCK.md, 2026-07-26).
//
// The palette is the `clean-slate` variant the maintainers judged on the 2026-07-06 style
// board; the numeric vector axes are Direction A, judged on the 2026-08-01 art
// board and transcribed from `57-ART-LOCK.md`. The FOUR PIXEL-ERA AXES this literal
// used to carry (a px bevel depth plus three enum style names) were deleted with the
// schema in plan 58-05 - they described a baked PixelMatrix machine box that the
// vector chassis replaced. Where a surviving legacy bake still needs one of those
// numbers, it holds its own named constant in `render/synth/generators.ts`.
//
// Any change here is a re-lock and must go through the maintainers, not an edit - it re-skins
// the whole app. The rationale lives in `docs/style-bible.md`.
// ============================================================================
export const LOCKED_SKIN: Skin = {
  id: 'clean-slate',
  palette: {
    ramp: [0x1b1f27, 0x2a2f3a, 0x3b4250, 0x565f70, 0xb0bacb],
    accents: { working: 0x34d399, fault: 0xf0506e, item: 0xffb454, build: 0x4fa8ff, electric: 0x4ee0ff },
    // The LABEL palette (phase 76, D-05, UI-SPEC 3.1), in byte order. ADDITIVE: no ramp
    // or accent above moved. These six are D-05's default, chosen clear of the five
    // accents and muted on purpose (a label is context, never the brightest thing on the
    // board), and they are judged on the phase 76 walk, where the maintainers can overturn them.
    // `docs/style-bible.md` section 1c carries the same table with its contrast ratios.
    labels: {
      sand: 0xe0d388,
      stone: 0xa19d95,
      moss: 0xa3c27f,
      lilac: 0xbea2ea,
      rose: 0xe39ac0,
      clay: 0xd68c6c,
    },
    // The resting CABLE (phase 92, D-10, UI-SPEC 4.2). ADDITIVE: no ramp or accent above
    // moved. A muted electric teal, 4.33:1 on the floor and 2.65:1 on a major grid line,
    // where the old `ramp[3]` at alpha 0.35 was a dimmer copy of the grid's own grey (1.35:1
    // and 1.22:1; walk-114 read the cables as stray rectangle outlines). D-10's default,
    // judged on the walk at the 1.18 text scale, where the maintainers can overturn it.
    // `docs/style-bible.md` section 1d carries the same row with its contrast ratios.
    cable: 0x2e8f99,
  },
  // ------------------------------------------------------------------------
  // The five VECTOR axes (SKIN-01), transcribed from `57-ART-LOCK.md`. Integer
  // `u` on the 32u grid, converted at render. Each line names the lock's axis
  // NUMBER and nothing else on purpose: the lock records "no reason stated" for
  // these cells, so a rationale written here would be a reconstruction, not the
  // decision. Read the cell, not a paraphrase of it.
  // ------------------------------------------------------------------------
  strokeStructural: 3, // 57-ART-LOCK.md axis 2
  strokeDetail: 2, // 57-ART-LOCK.md axis 2 / axis 8
  cornerRadius: 0, // 57-ART-LOCK.md axis 5
  shadowOffset: 0, // 57-ART-LOCK.md axis 7
  fillCeiling: 1, // 57-ART-LOCK.md axis 6 - a MAXIMUM, not a target
  treadPattern: 'centre-dash',
};

// Fail loud at module load if the shipped skin drifts from the schema. A unit test
// (`locked.test.ts`) also asserts this, but validating here means a bad edit
// breaks the first import rather than silently rendering a malformed skin.
validate(LOCKED_SKIN);
