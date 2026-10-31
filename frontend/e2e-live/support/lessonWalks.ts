// lessonWalks.ts - the walk table. It imports no Playwright, so a vitest gate can read it.

import type { Gesture, LessonId } from '../../src/tutorial/types';

/** Where a walk's hand lands on each target, off centre. Offsets are screen pixels from the target's centre. */
export interface LessonWalk {
  pressOffset: { dx: number; dy: number };
  floorOffset: { dx: number; dy: number };
  dragFrom: { dx: number; dy: number };
  dragTo: { dx: number; dy: number };
}

export const LESSON_WALKS = {} as Record<LessonId, LessonWalk>;

export const DRIVABLE_GESTURES: ReadonlyArray<Gesture['do']> = [];
