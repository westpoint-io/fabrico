// pulsePin.test.ts - the pinned reply-comet grader on traces written by hand.
//
// `e2e-live/support/pulsePin.ts` grades lesson 5's reply-comet read: the walk pins the render clock
// before the POST, waits for the return wire's reply count to rise, then steps the pin one render-clock
// unit at a time and reads the four return-cable tiles after each step. Each step carries the pixels that
// changed against the step-0 frame, the amber pixels on the four tiles, and the amber per tile in the
// order the return wire's path lists them, from the Handler's end. Every trace below is small enough to
// check by eye: the steps that hold comet ink and the amber each tile shows there.
//
// Lives under `src/` because `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}` only.

import { describe, expect, it } from 'vitest';
import {
  PULSE_DELTA_MIN,
  PULSE_LIT_STEPS_MIN,
  PULSE_PIN_STEPS,
  PULSE_SWEEP_UNITS,
  PULSE_TILE_WARM_MIN,
  PULSE_WARM_MIN,
  pinnedPulseFindings,
  pinnedPulseSummary,
  type PinnedStep,
} from '../../e2e-live/support/pulsePin';

/** A dark step: nothing changed against step 0 and no amber on any tile. */
function dark(k: number): PinnedStep {
  return { k, flat: false, delta: 0, warm: 0, tileWarm: [0, 0, 0, 0] };
}

/** A step with `tileWarm` amber per tile, its delta a little over the amber it holds. */
function inked(k: number, tileWarm: readonly number[]): PinnedStep {
  const warm = tileWarm.reduce((n, w) => n + w, 0);
  return { k, flat: false, delta: warm + 30, warm, tileWarm: [...tileWarm] };
}

/** Steps 0 to PULSE_PIN_STEPS, dark except where `lit` names a step's per-tile amber. */
function sweep(lit: Readonly<Record<number, readonly number[]>>): PinnedStep[] {
  const out: PinnedStep[] = [];
  for (let k = 0; k <= PULSE_PIN_STEPS; k++) out.push(lit[k] === undefined ? dark(k) : inked(k, lit[k]!));
  return out;
}

/**
 * The comet heading home: the head crosses tile 0 (6,2) at steps 15 to 17, tile 1 at 17 to 19, tile 2 at
 * 19 to 21 and tile 3 (3,2) at 21 to 23, with its glow on the tile behind until step 25.
 */
const HOME_BOUND: Readonly<Record<number, readonly number[]>> = {
  15: [80, 0, 0, 0],
  16: [106, 0, 0, 0],
  17: [60, 70, 0, 0],
  18: [20, 106, 0, 0],
  19: [0, 60, 70, 0],
  20: [0, 20, 106, 0],
  21: [0, 0, 60, 70],
  22: [0, 0, 20, 106],
  23: [0, 0, 0, 80],
  24: [0, 0, 0, 40],
  25: [0, 0, 0, 25],
};

describe('the pinned reply-comet grader', () => {
  it('pins the sweep, the steps and the floors it grades against', () => {
    expect(PULSE_SWEEP_UNITS).toBe(28);
    expect(PULSE_PIN_STEPS).toBe(32);
    expect(PULSE_DELTA_MIN).toBe(20);
    expect(PULSE_WARM_MIN).toBe(50);
    expect(PULSE_LIT_STEPS_MIN).toBe(3);
    expect(PULSE_TILE_WARM_MIN).toBe(20);
  });

  it('passes a sweep that lights the tiles in path order', () => {
    const steps = sweep(HOME_BOUND);
    expect(pinnedPulseFindings(steps, 0)).toEqual([]);
    const s = pinnedPulseSummary(steps, 0);
    // Steps 24 and 25 hold only the glow's 40 and 25 amber pixels, under the step floor of 50.
    expect(s.lit).toBe(9);
    expect(s.firstLit).toBe(15);
    expect(s.lastLit).toBe(23);
    expect(s.tileFirst).toEqual([15, 17, 19, 21]);
    expect(s.maxWarm).toBe(130);
  });

  it('fails when no step lights', () => {
    const findings = pinnedPulseFindings(sweep({}), 0);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]).toContain(`0 of steps 1 to ${PULSE_SWEEP_UNITS} held comet ink`);
    expect(findings[0]).toContain(`at least ${PULSE_LIT_STEPS_MIN}`);
  });

  it('fails when the comet is drawn without amber', () => {
    // The same sweep in the electric accent: every step changes by over 100 pixels, none of them amber.
    const cyan: Record<number, readonly number[]> = {};
    for (const [k, tiles] of Object.entries(HOME_BOUND)) cyan[Number(k)] = tiles;
    const steps = sweep(cyan).map((s) => (s.delta > 0 ? { ...s, warm: 0, tileWarm: [0, 0, 0, 0] } : s));
    const findings = pinnedPulseFindings(steps, 0);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]).toContain('11 steps changed by more than 20 pixels');
    expect(findings[0]).toContain(`more than ${PULSE_WARM_MIN} amber pixels`);
  });

  it('fails on comet ink at step 0', () => {
    const steps = sweep({ ...HOME_BOUND, 0: [0, 0, 0, 106] });
    const findings = pinnedPulseFindings(steps, 0);
    expect(findings.some((f) => f.startsWith('step 0 '))).toBe(true);
  });

  it('fails when the last tile lights first', () => {
    // Drawn from the Route's end: (3,2) at steps 5 to 7, (6,2) at steps 11 to 13.
    const reversed: Record<number, readonly number[]> = {
      5: [0, 0, 0, 80],
      6: [0, 0, 0, 106],
      7: [0, 0, 70, 60],
      8: [0, 0, 106, 20],
      9: [0, 70, 60, 0],
      10: [0, 106, 20, 0],
      11: [70, 60, 0, 0],
      12: [106, 20, 0, 0],
      13: [80, 0, 0, 0],
    };
    const findings = pinnedPulseFindings(sweep(reversed), 0);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('the last tile lit at step 5');
    expect(findings[0]).toContain('the first tile at step 11');
  });

  it('fails when a step after the sweep still lights', () => {
    const steps = sweep({ ...HOME_BOUND, 30: [0, 0, 0, 106] });
    const findings = pinnedPulseFindings(steps, 0);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('step 30');
    expect(findings[0]).toContain(`past the ${PULSE_SWEEP_UNITS}-unit sweep`);
  });

  it('fails on a cleared buffer', () => {
    const steps = sweep(HOME_BOUND);
    steps[18] = { ...steps[18]!, flat: true };
    const findings = pinnedPulseFindings(steps, 0);
    expect(findings.some((f) => f.includes('step 18') && f.includes('cleared buffer'))).toBe(true);
  });
});
