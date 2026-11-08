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
  /**
   * The words the card shows for the lesson's refused gesture: the refused stage's coaching line for
   * the tag, or the band's own sentence when the lesson has no line for it. Transcribed, not read from
   * the lesson, so a line deleted from the lesson data puts the band's sentence on the card and fails
   * the walk. `lessonCoverage.source.test.ts` compares it with the lesson data and the app's tables.
   */
  refusedCardNote: string;
}

export const LESSON_WALKS: Record<LessonId, LessonWalk> = {
  'your-first-line': {
    pressOffset: { dx: 5, dy: -4 },
    floorOffset: { dx: 5, dy: -4 },
    dragFrom: { dx: 3, dy: -2 },
    dragTo: { dx: -2, dy: 3 },
    refusedCardNote: "That cell is taken, so the Sink wasn't placed. Click a free cell, like the one in the ring.",
  },
  'delete-and-undo': {
    pressOffset: { dx: -4, dy: 5 },
    floorOffset: { dx: -5, dy: 3 },
    dragFrom: { dx: -2, dy: 3 },
    dragTo: { dx: 3, dy: -2 },
    refusedCardNote: "That cell holds the Source, so the Sink wasn't placed. Click the free cell in the ring.",
  },
};

/** The gestures `walkStep` in `lessonRunner.ts` knows how to make. */
export const DRIVABLE_GESTURES: ReadonlyArray<Gesture['do']> = ['pressHint', 'dragHint', 'dragToHint', 'key', 'watch', 'none'];

/**
 * The app's sentence for a footprint collision, transcribed because `RefusalMessage.tsx` pulls in the
 * render assets, which Playwright can't load. `lessonCoverage.source.test.ts` compares it with
 * `REFUSAL_COPY`, so it can't drift from what the app says.
 */
export const REFUSED_SENTENCE = 'That space is taken. Clear it or try elsewhere.';
