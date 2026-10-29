import { describe, expect, it } from 'vitest';
import { LABEL_COLOURS, validate, type Skin } from './skin.ts';
import { LOCKED_SKIN } from './skins/locked.ts';
import { TEST_SKIN_A, TEST_SKIN_B } from './__fixtures__/testSkins.ts';

// A structurally-valid skin we can mutate per-case to exercise each guard axis.
function makeValid(): Skin {
  return {
    id: 'probe',
    palette: {
      ramp: [0x101418, 0x2e3744, 0x3a4453, 0x4a5566, 0x5a6678],
      accents: { working: 0x34d399, fault: 0xf0506e, item: 0xffb454, build: 0x4fa8ff, electric: 0x4ee0ff },
      // A legal label palette, deliberately NOT the locked six (phase 76).
      labels: { sand: 0x111111, stone: 0x222222, moss: 0x333333, lilac: 0x444444, rose: 0x555555, clay: 0x666666 },
      // A legal cable colour, deliberately NOT the locked one (phase 92).
      cable: 0x777777,
    },
    // The five vector axes (SKIN-01). A legal set, deliberately NOT the locked
    // 3/2/0/0/1: every guard case below mutates one field of this literal, so a
    // probe that already held the shipped values would make "rejects X" cases pass
    // against a skin the app also ships.
    strokeStructural: 3,
    strokeDetail: 1,
    cornerRadius: 1,
    shadowOffset: 1,
    fillCeiling: 2,
    treadPattern: 'chevron',
  };
}

describe('validate - accepts well-formed skins', () => {
  it('accepts LOCKED_SKIN, the one shipped skin, without throwing', () => {
    expect(() => validate(LOCKED_SKIN)).not.toThrow();
  });
  it('accepts the synthetic test fixtures without throwing', () => {
    expect(() => validate(TEST_SKIN_A)).not.toThrow();
    expect(() => validate(TEST_SKIN_B)).not.toThrow();
  });
  it('accepts a freshly-built valid probe skin', () => {
    expect(() => validate(makeValid())).not.toThrow();
  });
});

describe('validate - throws a named Error per malformed axis', () => {
  it('rejects an empty id', () => {
    const s = makeValid();
    s.id = '';
    expect(() => validate(s)).toThrow(/skin\.id/);
  });

  it('rejects a ramp with fewer than 3 steps', () => {
    const s = makeValid();
    s.palette.ramp = [0x111111, 0x222222];
    expect(() => validate(s)).toThrow(/skin\.palette\.ramp/);
  });

  it('rejects a non-integer ramp step', () => {
    const s = makeValid();
    s.palette.ramp = [0x111111, 1.5, 0x333333];
    expect(() => validate(s)).toThrow(/skin\.palette\.ramp/);
  });

  // FIVE CASES WERE DELETED HERE BY PLAN 58-05, not lost. They asserted
  // `validate`'s guards for `bevelDepth` (x2), `cornerStyle`, `outlineStyle` and
  // `glyphFont` BY NAME - the four pixel-era axes SKIN-01 removed from the schema.
  // A guard cannot be tested after the field it guards no longer exists, and
  // rewriting them against the `generators.ts` holdover constants would be a test
  // asserting a literal against itself. What replaced them as the gate on those
  // values is a MEASUREMENT: the four `dpr-crispness` bezel PNGs and the
  // `pixel-guard` belt-corner PNG, all at `maxDiffPixels: 0`.

  it('rejects an unknown treadPattern', () => {
    const s = makeValid();
    (s as { treadPattern: string }).treadPattern = 'dots';
    expect(() => validate(s)).toThrow(/skin\.treadPattern/);
  });

  it('rejects a missing accent role', () => {
    const s = makeValid();
    delete (s.palette.accents as Record<string, number>).fault;
    expect(() => validate(s)).toThrow(/skin\.palette\.accents/);
  });

  // Phase 76 (D-05): the label palette is checked exactly like the accents, one named
  // Error per missing or non-integer entry.
  it('rejects a missing label colour, naming it', () => {
    const s = makeValid();
    delete (s.palette.labels as Record<string, number>).moss;
    expect(() => validate(s)).toThrow(/skin\.palette\.labels: colour 'moss'/);
  });

  it('rejects a non-integer label colour, naming it', () => {
    const s = makeValid();
    (s.palette.labels as Record<string, number>).clay = 1.5;
    expect(() => validate(s)).toThrow(/skin\.palette\.labels: colour 'clay'/);
  });

  it('rejects a skin with no label palette at all', () => {
    const s = makeValid();
    delete (s.palette as { labels?: unknown }).labels;
    expect(() => validate(s)).toThrow(/skin\.palette\.labels/);
  });

  it('rejects a skin with no cable colour, naming it (phase 92, D-10)', () => {
    const s = makeValid();
    delete (s.palette as { cable?: unknown }).cable;
    expect(() => validate(s)).toThrow(/skin\.palette\.cable: required colour int/);
  });

  it('rejects a non-integer cable colour, naming it', () => {
    const s = makeValid();
    (s.palette as { cable: number }).cable = 0.5;
    expect(() => validate(s)).toThrow(/skin\.palette\.cable/);
  });
});

// Phase 76 (D-05, UI-SPEC 3.1/3.2): the shipped label palette. A label has no state, so
// no label colour may equal a state accent: green, red and blue mean working, fault and
// build, and a label tinted one of them would read as a machine in that state.
describe('LOCKED_SKIN label palette (phase 76)', () => {
  it('carries the six UI-SPEC colours in LABEL_COLOURS byte order', () => {
    expect(LABEL_COLOURS.map((n) => LOCKED_SKIN.palette.labels[n])).toEqual([
      0xe0d388, 0xa19d95, 0xa3c27f, 0xbea2ea, 0xe39ac0, 0xd68c6c,
    ]);
  });

  it('every label colour differs from every accent', () => {
    const accents = Object.values(LOCKED_SKIN.palette.accents);
    expect(accents.length, 'the five accents').toBe(5);
    for (const name of LABEL_COLOURS) {
      const c = LOCKED_SKIN.palette.labels[name];
      expect(accents, `label colour '${name}' must not be a state accent`).not.toContain(c);
    }
  });

  it('the six label colours are pairwise distinct', () => {
    const values = LABEL_COLOURS.map((n) => LOCKED_SKIN.palette.labels[n]);
    expect(new Set(values).size).toBe(LABEL_COLOURS.length);
  });
});

// SKIN-01's five vector axes. Each is an INTEGER IN `u` on the 32u grid, so each
// gets the two failures an integer range admits (a fractional value and an
// out-of-range value), plus - for the stroke pair - the ordering failure that
// neither per-field check can see because both operands are individually legal.
describe('validate - the five vector axes (SKIN-01)', () => {
  it('accepts the locked 3/2/0/0/1 set', () => {
    expect(LOCKED_SKIN.strokeStructural).toBe(3);
    expect(LOCKED_SKIN.strokeDetail).toBe(2);
    expect(LOCKED_SKIN.cornerRadius).toBe(0);
    expect(LOCKED_SKIN.shadowOffset).toBe(0);
    expect(LOCKED_SKIN.fillCeiling).toBe(1);
    expect(() => validate(LOCKED_SKIN)).not.toThrow();
  });

  it('rejects a non-integer strokeStructural', () => {
    const s = makeValid();
    s.strokeStructural = 3.5;
    expect(() => validate(s)).toThrow(/skin\.strokeStructural/);
  });

  it('rejects a zero/negative strokeStructural', () => {
    const s = makeValid();
    s.strokeStructural = 0;
    expect(() => validate(s)).toThrow(/skin\.strokeStructural/);
  });

  it('rejects a non-integer strokeDetail', () => {
    const s = makeValid();
    s.strokeDetail = 1.5;
    expect(() => validate(s)).toThrow(/skin\.strokeDetail/);
  });

  it('rejects a zero/negative strokeDetail', () => {
    const s = makeValid();
    s.strokeDetail = -1;
    expect(() => validate(s)).toThrow(/skin\.strokeDetail/);
  });

  it('rejects strokeDetail >= strokeStructural, with BOTH values individually legal', () => {
    // The inversion case: 4 and 4 are each a perfectly good positive integer, so
    // only a comparison between them can reject this. Lock axis 2's two-weight
    // hierarchy is the thing being protected.
    const s = makeValid();
    s.strokeStructural = 4;
    s.strokeDetail = 4;
    expect(() => validate(s)).toThrow(/skin\.strokeDetail/);

    // ...and strictly heavier is rejected too, not only the equal case.
    s.strokeDetail = 5;
    expect(() => validate(s)).toThrow(/skin\.strokeDetail/);
  });

  it('rejects a non-integer cornerRadius', () => {
    const s = makeValid();
    s.cornerRadius = 0.5;
    expect(() => validate(s)).toThrow(/skin\.cornerRadius/);
  });

  it('rejects a negative cornerRadius, and ACCEPTS zero (the locked value)', () => {
    const s = makeValid();
    s.cornerRadius = -1;
    expect(() => validate(s)).toThrow(/skin\.cornerRadius/);
    s.cornerRadius = 0;
    expect(() => validate(s)).not.toThrow();
  });

  it('rejects a non-integer shadowOffset', () => {
    const s = makeValid();
    s.shadowOffset = 1.25;
    expect(() => validate(s)).toThrow(/skin\.shadowOffset/);
  });

  it('rejects a negative shadowOffset, and ACCEPTS zero (the locked value)', () => {
    const s = makeValid();
    s.shadowOffset = -2;
    expect(() => validate(s)).toThrow(/skin\.shadowOffset/);
    s.shadowOffset = 0;
    expect(() => validate(s)).not.toThrow();
  });

  it('rejects a non-integer fillCeiling', () => {
    const s = makeValid();
    s.fillCeiling = 1.5;
    expect(() => validate(s)).toThrow(/skin\.fillCeiling/);
  });

  it('rejects a negative fillCeiling, and ACCEPTS zero (a no-fill skin is legal)', () => {
    const s = makeValid();
    s.fillCeiling = -1;
    expect(() => validate(s)).toThrow(/skin\.fillCeiling/);
    s.fillCeiling = 0;
    expect(() => validate(s)).not.toThrow();
  });
});

// This is where plan 58-01's holdover case lived - "the pixel-era axes survive plan
// 58-01 (deleted by 58-05, not here)", pinning all four axes on `LOCKED_SKIN`. It
// was written to REDDEN when 58-05 landed, and it did exactly that. 58-05 is this
// commit, so the case is gone rather than updated: the schema is vector-native and
// there is nothing left for it to pin.
//
// A NEGATIVE ASSERTION REPLACES IT, because "the field is absent" is a claim a
// reader can check and a future edit can violate. `tsc --noEmit` already refuses a
// re-added axis at every call site, but tsc does not run over a hand-built object
// literal cast to `Skin`, and this does.
describe('the pixel-era axes are GONE from the schema (SKIN-01, plan 58-05)', () => {
  it('LOCKED_SKIN carries no bevelDepth / cornerStyle / glyphFont / outlineStyle key', () => {
    const keys = Object.keys(LOCKED_SKIN);
    expect(keys).not.toContain('bevelDepth');
    expect(keys).not.toContain('cornerStyle');
    expect(keys).not.toContain('glyphFont');
    expect(keys).not.toContain('outlineStyle');
    // ...and the five that DID survive are still all present, so this case cannot
    // pass by the literal having quietly lost everything.
    expect(keys).toEqual(
      expect.arrayContaining([
        'strokeStructural',
        'strokeDetail',
        'cornerRadius',
        'shadowOffset',
        'fillCeiling',
        'treadPattern',
      ]),
    );
  });

  it('validate() ignores a stale pixel-era axis rather than throwing on it', () => {
    // The honest scope of the deletion: `validate` is a POSITIVE guard - it checks
    // the axes that exist and says nothing about extra keys. A `Skin` literal left
    // over from before this commit still validates; what refuses it is `tsc`, via
    // excess-property checking at the literal. Stating that here stops a later
    // reader assuming `validate` is the mechanism when it is not.
    const stale = { ...LOCKED_SKIN, bevelDepth: 1, cornerStyle: 'square' } as Skin;
    expect(() => validate(stale)).not.toThrow();
  });
});

// SKIN-02 (v7.0) deleted the theme system, so the old "the two built-in skins are
// a real, visible swap" describe lost its premise: there is exactly ONE built-in
// skin and no way to change it. What survives is the schema invariant the swap
// tests happened to also cover - the ramp is authored darkest-first - which is
// load-bearing for bakeRamp's fixed-index selection (SYNTH-05).
describe('ramp ordering invariant (darkest-first)', () => {
  it('the one shipped skin orders its ramp darkest-first, lightest-last', () => {
    const ramp = LOCKED_SKIN.palette.ramp;
    expect(ramp[0]).toBeLessThan(ramp[ramp.length - 1]);
  });
});
