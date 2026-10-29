// oracle-sync.test.ts (28-01, GATE-02a) - the drift guard the UI-SPEC audit
// assertion implies ("oracle/skin drift fails CI"). The shared E2E values module
// (frontend/shared/geometry.ts) COPIES the semantic accents and substrate ramps
// by hand from the built-in skins so it can stay pure/product-free; that copy is
// only safe if a test proves the copy never diverges from the source. This file
// is that proof: colorOracles/rampOracles must mirror LOCKED_SKIN.palette exactly,
// or the whole matrix goes red. SKIN-02 (v7.0) deleted the second built-in skin, so
// the shipped skin is the only subject and rampOracles has a single entry.

import { describe, expect, it } from 'vitest';
import { LOCKED_SKIN } from './locked.ts';
import { colorOracles, rampOracles } from '../../../../shared/geometry.ts';

describe('oracle/skin drift guard - accents (colorOracles)', () => {
  it('colorOracles mirrors LOCKED_SKIN.palette.accents exactly', () => {
    expect(colorOracles.working).toBe(LOCKED_SKIN.palette.accents.working);
    expect(colorOracles.fault).toBe(LOCKED_SKIN.palette.accents.fault);
    expect(colorOracles.build).toBe(LOCKED_SKIN.palette.accents.build);
    // The shared oracle names the item accent `itemHalo` (reskin paints core AND
    // glow from the one `item` accent); it must equal the skin's `item`.
    expect(colorOracles.itemHalo).toBe(LOCKED_SKIN.palette.accents.item);
  });
});

describe('oracle/skin drift guard - ramps (rampOracles)', () => {
  it('rampOracles.locked deep-equals LOCKED_SKIN.palette.ramp', () => {
    expect(rampOracles.locked).toEqual(LOCKED_SKIN.palette.ramp);
  });

  it('rampOracles has exactly one entry (one shipped skin, SKIN-02)', () => {
    expect(Object.keys(rampOracles)).toEqual(['locked']);
  });
});
