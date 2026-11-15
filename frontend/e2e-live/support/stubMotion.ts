// stubMotion.ts - the grade of lesson 2's stub-motion read, pure: plain data in, sentences out.
//
// The walk's lesson runner takes the samples (a model read, a clip capture and the Pixi ticker's frame
// time each) and counts the pixels that changed between consecutive captures. This module applies every
// rule to those numbers, so `src/gates/stubMotion.test.ts` can pin each rule on traces written by hand.
// No Playwright and no PNG here.

/** The lesson board's boot ends on this tick, so its clock reads ticks since it arrived as tick minus this. */
export const LESSON_BOARD_BOOT_TICK = 7;
/** The stub fills this many ticks after the board arrives, and the items on it stop (the lesson board's own measure). */
export const LESSON_BOARD_FILL_TICKS = 955;
/** The host's sim clock, ticks a second. */
export const BOARD_TICKS_PER_S = 62.5;
/**
 * A sample differs from the one before when more than this many pixels changed in any channel. Zero, as
 * `93-boards-load.live.spec.ts` grades its first belt: under pinned treads any change counts, which is
 * what makes the hidden-layer control strict.
 */
export const MOTION_DELTA_MIN = 0;
/** Consecutive carrying samples the control must see with the item layer hidden, so it can't pass on none. */
export const MOTION_CONTROL_PAIRS_MIN = 4;

/** One sample of the stub's clip, without its capture. */
export interface MotionSample {
  /** The model reported items on the stub just before or just after the capture. */
  carrying: boolean;
  tick: number;
  /** `window.__fabrico.tickerTime()`: when the Pixi ticker last finished a frame. */
  frameAt: number;
}

/** One window's grade. */
export interface WindowGrade {
  samples: number;
  /** Consecutive pairs where both samples carry items. */
  pairs: number;
  /** Of those, the pairs whose captures differ by more than `MOTION_DELTA_MIN` pixels. */
  changed: number;
  /** The largest pixel count over the graded pairs. */
  largest: number;
  /** The tick of the window's last sample, or null with no samples. */
  lastTick: number | null;
  /** The absolute tick the stub fills on. */
  fillTick: number;
}

/**
 * Grade one window. `changedPixels[i]` is the pixel count that differs between samples i and i+1, and
 * `fillTick` is the absolute tick the stub fills on, `LESSON_BOARD_BOOT_TICK + LESSON_BOARD_FILL_TICKS`.
 */
export function gradeWindow(samples: readonly MotionSample[], changedPixels: readonly number[], fillTick: number): WindowGrade {
  let pairs = 0;
  let changed = 0;
  let largest = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (!a.carrying || !b.carrying) continue;
    pairs++;
    const n = changedPixels[i - 1] ?? 0;
    largest = Math.max(largest, n);
    if (n > MOTION_DELTA_MIN) changed++;
  }
  return { samples: samples.length, pairs, changed, largest, lastTick: samples[samples.length - 1]?.tick ?? null, fillTick };
}

/** The failure sentences for the two windows, the item layer shown and hidden. Empty for a pass. */
export function stubMotionFindings(shown: WindowGrade, control: WindowGrade): string[] {
  const out: string[] = [];
  if (shown.pairs <= 0) out.push('the model reported items on the stub around at least two consecutive samples');
  if (shown.changed <= 0) {
    out.push(
      `under pinned treads, the stub's pixels changed between consecutive samples with items on it (${shown.changed} of ${shown.pairs} pairs, largest change ${shown.largest} pixels)`,
    );
  }
  if (control.pairs < MOTION_CONTROL_PAIRS_MIN) out.push(`the control saw items on the stub around at least ${MOTION_CONTROL_PAIRS_MIN} consecutive pairs`);
  if (control.changed !== 0) {
    out.push(
      `with the item layer hidden and the treads pinned, the stub's pixels changed on ${control.changed} of ${control.pairs} pairs, so something other than items passes the read`,
    );
  }
  const lastTick = Math.max(shown.lastTick ?? 0, control.lastTick ?? 0);
  if (!(lastTick - LESSON_BOARD_BOOT_TICK < LESSON_BOARD_FILL_TICKS)) {
    out.push(`both windows ran before the stub filled, ${LESSON_BOARD_FILL_TICKS} ticks after the board arrived (last sample at tick ${lastTick})`);
  }
  return out;
}
