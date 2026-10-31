// index.ts - every lesson, in teaching order. The list and the walk test both read this.
//
// A change to a gesture updates its lesson in the same commit. The walk plays each lesson the way a
// user does, so it fails by lesson and step until the lesson matches. A new lesson also needs an entry
// in `LESSON_WALKS`, in `e2e-live/support/lessonWalks.ts`, or `lessonCoverage.source.test.ts` fails.

import type { Lesson } from '../types';
import { YOUR_FIRST_LINE } from './yourFirstLine';

export const LESSONS: readonly Lesson[] = [YOUR_FIRST_LINE];
