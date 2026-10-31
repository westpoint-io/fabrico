// lessonWalks.ts - the walk table. `lessons.walk.ts` generates one test per entry, so a lesson with no
// entry gets no test, and `lessonCoverage.source.test.ts` is what fails by the lesson's name. It imports
// no Playwright, so that vitest gate can read it.

import type { Gesture, LessonId } from '../../src/tutorial/types';

/**
 * Where a walk's hand lands on each target, in screen pixels from the target's centre. A hand never
 * lands on an exact centre, so a hit area that only works there fails the walk.
 */
export interface LessonWalk {
  /** A press on a ring around a control or a machine. */
  pressOffset: { dx: number; dy: number };
  /** A press on a ring on the floor. */
  floorOffset: { dx: number; dy: number };
  /** Where a drag starts, inside its first ring. */
  dragFrom: { dx: number; dy: number };
  /** Where a drag lets go, inside its second ring. */
  dragTo: { dx: number; dy: number };
}

export const LESSON_WALKS: Record<LessonId, LessonWalk> = {
  'your-first-line': {
    pressOffset: { dx: 5, dy: -4 },
    floorOffset: { dx: 5, dy: -4 },
    dragFrom: { dx: 3, dy: -2 },
    dragTo: { dx: -2, dy: 3 },
  },
};

/** The gestures `walkStep` in `lessonRunner.ts` knows how to make. */
export const DRIVABLE_GESTURES: ReadonlyArray<Gesture['do']> = ['pressHint', 'dragHint', 'key', 'watch', 'none'];
