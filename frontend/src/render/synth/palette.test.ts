import { describe, expect, it } from 'vitest';
import { bakeRamp, rampStep } from './palette.ts';
import { TEST_SKIN_A, TEST_SKIN_B } from './__fixtures__/testSkins.ts';

describe('rampStep - bounds-safe fixed-index read', () => {
  const ramp = TEST_SKIN_A.palette.ramp;
  it('returns the exact entry for an in-range index', () => {
    expect(rampStep(ramp, 0)).toBe(ramp[0]);
    expect(rampStep(ramp, ramp.length - 1)).toBe(ramp[ramp.length - 1]);
  });
  it('clamps a negative index to the darkest step', () => {
    expect(rampStep(ramp, -5)).toBe(ramp[0]);
  });
  it('clamps an over-range index to the lightest step', () => {
    expect(rampStep(ramp, 999)).toBe(ramp[ramp.length - 1]);
  });
});

describe('bakeRamp - bevel constants selected by fixed index (SYNTH-05)', () => {
  it('tlLight is the lightest ramp step (identity, not a multiply)', () => {
    const ramp = TEST_SKIN_A.palette.ramp;
    expect(bakeRamp(TEST_SKIN_A).tlLight).toBe(ramp[ramp.length - 1]);
  });

  it('brShadow is the darkest ramp step (identity, not a multiply)', () => {
    const ramp = TEST_SKIN_A.palette.ramp;
    expect(bakeRamp(TEST_SKIN_A).brShadow).toBe(ramp[0]);
  });

  it('every baked constant is an actual ramp entry (index selection only)', () => {
    for (const skin of [TEST_SKIN_A, TEST_SKIN_B]) {
      const ramp = skin.palette.ramp;
      const baked = bakeRamp(skin);
      expect(ramp).toContain(baked.tlLight);
      expect(ramp).toContain(baked.brShadow);
      expect(ramp).toContain(baked.fill);
      expect(ramp).toContain(baked.ink);
    }
  });

  it('is deterministic: repeated calls yield an equal result', () => {
    const a = bakeRamp(TEST_SKIN_A);
    const b = bakeRamp(TEST_SKIN_A);
    expect(a).toEqual(b);
  });

  // Data-driven proof (SKIN-02): bakeRamp reads the schema rather than hardcoding
  // the one shipped skin's values. Two synthetic fixtures with different ramps
  // must bake different edge constants.
  it('two skins with different ramps bake different edge constants (data-driven)', () => {
    const a = bakeRamp(TEST_SKIN_A);
    const b = bakeRamp(TEST_SKIN_B);
    expect(a.tlLight).not.toBe(b.tlLight);
    expect(a.brShadow).not.toBe(b.brShadow);
  });
});
