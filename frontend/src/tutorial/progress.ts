// progress.ts - which lessons a user has started and finished.

import type { LessonId } from './types';

export const PROGRESS_KEY = 'fab.tutorial.v1';

export interface Progress {
  version: 1;
  lessons: Partial<Record<LessonId, 'inProgress' | 'done'>>;
}

export const EMPTY_PROGRESS: Progress = { version: 1, lessons: {} };

export function parseProgress(_raw: string | null, _knownIds: readonly string[]): Progress {
  return EMPTY_PROGRESS;
}

export interface ProgressStore {
  read(): Progress;
  write(p: Progress): void;
}

export function localStorageProgress(_storage: Pick<Storage, 'getItem' | 'setItem'> | null, _knownIds: readonly string[]): ProgressStore {
  return { read: () => EMPTY_PROGRESS, write: () => {} };
}

export function withLessonStarted(p: Progress, _id: LessonId): Progress {
  return p;
}

export function withLessonDone(p: Progress, _id: LessonId): Progress {
  return p;
}
