// stubMotion.ts - the grade of lesson 2's stub-motion read, pure: plain data in, sentences out.
//
// The walk's lesson runner takes the samples (a model read, a clip capture and the Pixi ticker's frame
// time each) and counts the pixels that changed between consecutive captures. This module applies every
// rule to those numbers, so `src/gates/stubMotion.test.ts` can pin each rule on traces written by hand.
// No Playwright and no PNG here.
//
// Only pairs taken before the stub fills are graded. The sim clock runs in real time, so a slow runner
// takes the same samples later and may reach the fill, where the stub's items stop and a hidden-layer
// control would pass on frozen items. Pairs at or past the fill are counted as late and named in each
// sentence, so a slow run fails with a pair count that says why, not on a ceiling.

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
  /** Consecutive pairs where both samples carry items and both ticks fall before the fill. */
  pairs: number;
  /** Of those, the pairs whose captures differ by more than `MOTION_DELTA_MIN` pixels. */
  changed: number;
  /** The largest pixel count over the graded pairs. */
  largest: number;
  /** Carrying pairs with a tick at or past the fill. Not graded. */
  late: number;
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
  let late = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (!a.carrying || !b.carrying) continue;
    if (a.tick >= fillTick || b.tick >= fillTick) {
      late++;
      continue;
    }
    pairs++;
    const n = changedPixels[i - 1] ?? 0;
    largest = Math.max(largest, n);
    if (n > MOTION_DELTA_MIN) changed++;
  }
  return { samples: samples.length, pairs, changed, largest, late, lastTick: samples[samples.length - 1]?.tick ?? null, fillTick };
}

/**
 * The failure sentences for the two windows, the item layer shown and hidden. Empty for a pass. Over
 * pre-fill pairs only: at least one shown pair and one changed shown pair, at least
 * `MOTION_CONTROL_PAIRS_MIN` control pairs, and no changed control pair.
 */
export function stubMotionFindings(shown: WindowGrade, control: WindowGrade): string[] {
  const out: string[] = [];
  const after = (g: WindowGrade) => `${g.late} came after and aren't graded`;
  if (shown.pairs < 1) {
    out.push(`the shown window saw ${shown.pairs} carrying pairs before the stub filled at tick ${shown.fillTick} (1 needed; ${after(shown)})`);
  }
  if (shown.changed < 1) {
    out.push(
      `under pinned treads, the stub's pixels changed on ${shown.changed} of ${shown.pairs} carrying pairs before the stub filled at tick ${shown.fillTick} ` +
        `(1 needed, largest change ${shown.largest} pixels; ${after(shown)})`,
    );
  }
  if (control.pairs < MOTION_CONTROL_PAIRS_MIN) {
    out.push(`the control saw ${control.pairs} carrying pairs before the stub filled at tick ${control.fillTick} (${MOTION_CONTROL_PAIRS_MIN} needed; ${after(control)})`);
  }
  if (control.changed !== 0) {
    out.push(
      `with the item layer hidden and the treads pinned, the stub's pixels changed on ${control.changed} of ${control.pairs} carrying pairs before the stub filled ` +
        `at tick ${control.fillTick}, so something other than items passes the read (${after(control)})`,
    );
  }
  return out;
}
