// stubMotion.test.ts - the stub-motion grader on traces written by hand.
//
// `e2e-live/support/stubMotion.ts` grades lesson 2's stub-motion read: the walk takes a window of samples
// with the item layer hidden (the control) and a window with it shown, and counts the pixels that changed
// between consecutive captures of the stub. The grader counts a pair only when the model reported items
// around both samples and both ticks fall before the stub fills, because once the stub is full its items
// stop, and a control taken on frozen items would pass on nothing. Each trace is small enough to check by
// eye: the ticks, which samples carried items, and the pixel count between each pair.
//
// Lives under `src/` because `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}` only.

import { describe, expect, it } from 'vitest';
import {
  LESSON_BOARD_BOOT_TICK,
  LESSON_BOARD_FILL_TICKS,
  MOTION_CONTROL_PAIRS_MIN,
  gradeWindow,
  stubMotionFindings,
  type MotionSample,
  type WindowGrade,
} from '../../e2e-live/support/stubMotion';

/** The stub fills on this tick: 962. */
const FILL = LESSON_BOARD_BOOT_TICK + LESSON_BOARD_FILL_TICKS;

/** A window from its ticks, every sample carrying items unless `idle` names its index. */
function window(ticks: readonly number[], changed: readonly number[], idle: readonly number[] = []): WindowGrade {
  expect(changed.length, 'one pixel count per pair').toBe(ticks.length - 1);
  const samples: MotionSample[] = ticks.map((tick, i) => ({ tick, carrying: !idle.includes(i), frameAt: 1000 + i * 16 }));
  return gradeWindow(samples, changed, FILL);
}

/** A control that passes: six samples well before the fill, five carrying pairs, nothing changed. */
const EARLY_CONTROL = window([100, 115, 130, 145, 160, 175], [0, 0, 0, 0, 0]);
/** A shown window that passes: eight samples well before the fill, every pair changed. */
const EARLY_SHOWN = window([200, 215, 230, 245, 260, 275, 290, 305], [40, 38, 41, 39, 40, 42, 37]);

describe('the stub-motion grader', () => {
  it('reads the fill at tick 962 and needs four control pairs', () => {
    expect(FILL).toBe(962);
    expect(MOTION_CONTROL_PAIRS_MIN).toBe(4);
  });

  it('passes a slow run whose control has four pairs before the fill and a tail after it', () => {
    // The control first: five carrying pairs, all before tick 962.
    const control = window([870, 885, 900, 915, 930, 945], [0, 0, 0, 0, 0]);
    // Then the shown window, nearer the fill: four changing pairs before it, then three after it, where
    // the stub is full and its items have stopped.
    const shown = window([946, 948, 952, 956, 960, 975, 990, 1005], [30, 28, 31, 29, 0, 0, 0]);
    expect(stubMotionFindings(shown, control)).toEqual([]);
    expect([control.pairs, control.late, shown.pairs, shown.changed, shown.late]).toEqual([5, 0, 4, 4, 3]);
  });

  it('fails a control with fewer than four pairs before the fill, however many came after', () => {
    // Two carrying pairs before tick 962, then five past it, where frozen items would pass the control.
    const control = window([940, 950, 960, 970, 980, 990, 1000, 1010], [0, 0, 0, 0, 0, 0, 0]);
    const found = stubMotionFindings(EARLY_SHOWN, control).join('\n');
    expect(found).toMatch(/before the stub filled/);
    expect(found).toMatch(/the control saw 2 carrying pairs before the stub filled at tick 962 \(4 needed; 5 came after/);
    expect([control.pairs, control.late]).toEqual([2, 5]);
  });

  it('fails a shown window whose pairs before the fill never changed, whatever its late pairs show', () => {
    const shown = window([946, 948, 952, 956, 960, 975, 990, 1005], [0, 0, 0, 0, 50, 50, 50]);
    const found = stubMotionFindings(shown, EARLY_CONTROL).join('\n');
    expect(found).toMatch(/the stub's pixels changed on 0 of 4 carrying pairs before the stub filled at tick 962/);
    expect([shown.pairs, shown.changed, shown.late]).toEqual([4, 0, 3]);
  });

  it('fails a control with one changed pair before the fill', () => {
    const control = window([100, 115, 130, 145, 160, 175], [0, 0, 7, 0, 0]);
    expect(stubMotionFindings(EARLY_SHOWN, control).join('\n')).toMatch(/with the item layer hidden and the treads pinned, the stub's pixels changed on 1 of 5/);
  });

  it('passes a run with every sample before the fill, the shape of the last local walk (11 and 11 pairs)', () => {
    const ticks = (from: number) => Array.from({ length: 12 }, (_, i) => from + i * 16);
    const shown = window(ticks(74), [12, 0, 15, 14, 0, 13, 16, 0, 12, 15, 11]);
    const control = window(ticks(260), Array.from({ length: 11 }, () => 0));
    expect([shown.pairs, shown.changed, control.pairs, control.changed]).toEqual([11, 8, 11, 0]);
    expect(stubMotionFindings(shown, control)).toEqual([]);
  });

  it('counts no pair where either sample carried nothing', () => {
    const shown = window([100, 115, 130, 145], [9, 9, 9], [1]);
    expect([shown.pairs, shown.changed]).toEqual([1, 1]);
  });
});
