// TEST FIXTURE - NOT a shipped skin, and NOT skin-swap machinery.
//
// SKIN-02 (v7.0) deleted the theme system: the app has exactly ONE skin,
// `LOCKED_SKIN` (`skins/locked.ts`), and no way to change it. Nothing the app
// entry reaches imports this module - it is imported by specs only, and its ids
// are deliberately meaningless (`test-skin-a` / `test-skin-b`) so no future
// reader can mistake either literal for a shipped or previously-shipped palette.
//
// Purpose: prove the sprite generators are DATA-DRIVEN - that they read the
// `Skin` schema rather than hardcoding `LOCKED_SKIN`'s values. That is a real
// surviving property of `Skin` + `validate()` (D-19), and it is what the two
// "output differs per skin" assertions now test. A spec constructing a `Skin`
// literal is not a skin picker.
//
// The colours below are freshly authored for this file (a violet ramp and a
// teal ramp, obviously not Fabrico's grey-steel look). They are NOT copied from
// any deleted literal. The structural axes are chosen to keep the assertions
// that read them meaningful - each is annotated with the spec that depends on it.

import type { Skin } from '../skin.ts';

/**
 * Synthetic skin A - the default subject for the generator/palette/LOD/bezel
 * specs. Its ramp is a violet climb whose mid step (`fill`) is dark enough that
 * `bakeRamp` picks `tlLight` as the glyph `ink`, which is the arrangement
 * `generators.test.ts` documents when it isolates glyph ink past a bevel margin.
 */
export const TEST_SKIN_A: Skin = {
  id: 'test-skin-a',
  palette: {
    // 5 steps darkest->lightest. Length 5 is load-bearing: generators.test.ts
    // probes the belt rail at rampStep(ramp, 4) and the interior at index 0.
    ramp: [0x100020, 0x30104a, 0x502080, 0x8040c0, 0xc090ff],
    accents: { working: 0x00ffcc, fault: 0xff0066, item: 0xffee00, build: 0x0088ff, electric: 0xaa00ff },
    // A synthetic label palette (phase 76), distinct from the locked six and from B's.
    labels: { sand: 0xa08040, stone: 0x807060, moss: 0x60a040, lilac: 0x9070c0, rose: 0xc07090, clay: 0xb06040 },
    // A synthetic cable colour (phase 92), distinct from the locked one and from B's.
    cable: 0x208070,
  },
  // The five vector axes (SKIN-01). Chosen LEGAL-BUT-NOT-LOCKED on every one, for
  // the same reason the style axes below are: a fixture that happens to hold the
  // shipped numbers cannot distinguish "the painter read the skin" from "the
  // painter hardcoded LOCKED_SKIN's value". Locked is 3/2/0/0/1; none of these is.
  // 4/1: a WIDER structural weight over a THINNER detail weight, so the ordering
  // invariant (`strokeDetail < strokeStructural`) is satisfied by a different pair
  // than the locked one and a painter reading the wrong field is visible.
  strokeStructural: 4,
  strokeDetail: 1,
  // 2 (locked is 0): the only fixture in the tree carrying a NON-ZERO radius, so a
  // renderer that ignores cornerRadius and always squares its corners has somewhere
  // to be caught.
  cornerRadius: 2,
  // 1 (locked is 0): same reasoning - a non-zero offset is the only value that can
  // prove a shadow consumer reads the axis rather than never drawing one.
  shadowOffset: 1,
  // 3 (locked is 1): a ceiling loose enough that a fill-count gate written against
  // this fixture cannot be passing because the ceiling is 1 and the subject is 0.
  fillCeiling: 3,
  // 'chevron': keeps the legal-but-unused enum value exercised by a real Skin
  // value. SKIN-01 (plan 58-05) deleted the other four style axes and left this one
  // alone by the maintainers' call - PHASE 61 owns the belt tread. No paint dispatch reads
  // treadPattern; it is declarative/validation-only.
  treadPattern: 'chevron',
};

/**
 * Synthetic skin B - exists ONLY so the "output differs per skin" assertions in
 * `palette.test.ts` and `generators.test.ts` have a second, genuinely different
 * subject. Every axis that those assertions read differs from A: the ramp (so
 * `tlLight`/`brShadow` differ), the accents, and all five vector axes.
 *
 * NARROWED BY PLAN 58-05, and worth knowing before writing the next assertion
 * against this pair. A and B used to differ on `bevelDepth` and both style enums
 * too, so a PIXEL bake could come out byte-different on structure alone. Those axes
 * are gone from the schema and the surviving bakes now read module constants, so
 * `makeGenerators(A)` and `makeGenerators(B)` differ only in COLOUR. The five
 * vector axes still spread (4/1/2/1/3 against 5/3/0/0/0), but nothing in the pixel
 * pipeline reads them - they discriminate the VECTOR consumers
 * (`machineChassis.ts`, `machineState.ts`) instead.
 */
export const TEST_SKIN_B: Skin = {
  id: 'test-skin-b',
  palette: {
    // A teal ramp - no step shared with A, so bakeRamp's fixed-index selection
    // yields different edge constants (palette.test.ts asserts exactly that).
    ramp: [0x001a10, 0x0a4030, 0x1a7050, 0x40b080, 0x90ffd0],
    accents: { working: 0x66ff00, fault: 0xcc0033, item: 0xff9900, build: 0x3366ff, electric: 0x00ffff },
    // A second synthetic label palette (phase 76), distinct from A's.
    labels: { sand: 0xc0b070, stone: 0x908880, moss: 0x80b060, lilac: 0xa090d0, rose: 0xd090b0, clay: 0xc08060 },
    // A second synthetic cable colour (phase 92), distinct from A's.
    cable: 0x5060a0,
  },
  // The five vector axes (SKIN-01). Every one differs from BOTH A and LOCKED_SKIN,
  // which is what the fixture pair is for: an "output differs per skin" assertion
  // that reads any one of these axes has a genuinely different subject to compare.
  // 5/3: a third distinct legal (structural, detail) pair - A is 4/1, locked is 3/2.
  strokeStructural: 5,
  strokeDetail: 3,
  // 0 (vs A's 2): the square end of the radius axis, so the pair `{A, B}` spreads
  // cornerRadius across zero and non-zero rather than across two non-zero values.
  cornerRadius: 0,
  // 0 (vs A's 1): same spread reasoning as cornerRadius - the pair covers both the
  // "no shadow" and the "some shadow" branch of any consumer.
  shadowOffset: 0,
  // 0 (vs A's 3): the strictest legal ceiling. A gate asserting "fills <= ceiling"
  // has a fixture here that admits NO fills at all, so the comparison is exercised
  // at its boundary rather than only in its generous middle.
  fillCeiling: 0,
  treadPattern: 'chevron',
};
