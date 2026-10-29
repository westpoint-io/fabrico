// Module-load + unit proof for the LOCKED styling source of truth. Importing the
// module runs the module-load `validate(...)` call in `locked.ts`; if the shipped
// skin drifts from the schema, that import throws and this whole file fails to
// load - so the mere fact these tests run is itself the module-load guarantee.
// The explicit assertions below re-run `validate` and pin the id invariants.
// SKIN-02 (v7.0) deleted the second built-in, so there is exactly one subject.

import { describe, expect, it } from 'vitest';
import { LOCKED_SKIN } from './locked.ts';
import { validate } from '../skin.ts';

describe('the locked skin - schema validity', () => {
  it('imports the module without throwing (module-load validate passed)', () => {
    // If the import at the top of this file had thrown, vitest would never reach
    // here. This test documents that guarantee explicitly.
    expect(LOCKED_SKIN).toBeDefined();
  });

  it('LOCKED_SKIN passes validate', () => {
    expect(() => validate(LOCKED_SKIN)).not.toThrow();
  });
});

describe('the locked skin - id invariants', () => {
  it('has a non-empty id', () => {
    expect(LOCKED_SKIN.id.length).toBeGreaterThan(0);
  });

  it('LOCKED_SKIN has the finalized id (not the provisional placeholder)', () => {
    // Task 3 promoted the maintainers' live pick: the id is the locked style name, and the
    // Task 1 scaffold's 'locked-provisional' placeholder id no longer appears.
    expect(LOCKED_SKIN.id).toBe('clean-slate');
    expect(LOCKED_SKIN.id).not.toBe('locked-provisional');
  });
});

// Phase 92 (D-10, UI-SPEC 4.2): the resting cable's colour is one ADDITIVE token. The ramp
// and the five accents are the 2026-07-06 lock, unchanged.
describe('the locked skin - the cable token (phase 92, D-10)', () => {
  it('carries palette.cable 0x2e8f99', () => {
    expect(LOCKED_SKIN.palette.cable).toBe(0x2e8f99);
  });

  it('moved no ramp step and no accent to make room', () => {
    expect(LOCKED_SKIN.palette.ramp).toEqual([0x1b1f27, 0x2a2f3a, 0x3b4250, 0x565f70, 0xb0bacb]);
    expect(LOCKED_SKIN.palette.accents).toEqual({
      working: 0x34d399,
      fault: 0xf0506e,
      item: 0xffb454,
      build: 0x4fa8ff,
      electric: 0x4ee0ff,
    });
  });

  it('the cable is no accent and no ramp step', () => {
    expect(Object.values(LOCKED_SKIN.palette.accents)).not.toContain(LOCKED_SKIN.palette.cable);
    expect(LOCKED_SKIN.palette.ramp).not.toContain(LOCKED_SKIN.palette.cable);
  });
});
