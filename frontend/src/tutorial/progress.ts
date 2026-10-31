// progress.ts - which lessons a user has started and finished.
//
// Pure: the storage is a parameter, so a node test passes a fake and this module touches no DOM global
// when it loads. The stored value is something any page script or the user can edit, so the parse only
// ever rejects: a value it doesn't fully recognise reads as no progress, and the app still boots.

import type { LessonId } from './types';

export const PROGRESS_KEY = 'fab.tutorial.v1';

type StoredStatus = 'inProgress' | 'done';

export interface Progress {
  version: 1;
  lessons: Partial<Record<LessonId, StoredStatus>>;
}

export const EMPTY_PROGRESS: Progress = Object.freeze({ version: 1, lessons: Object.freeze({}) });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is StoredStatus {
  return value === 'inProgress' || value === 'done';
}

/**
 * Read a stored value. A wrong shape anywhere reads as empty. A lesson id this build doesn't know is
 * dropped and the known ones survive, because a lesson can be removed in a later version.
 */
export function parseProgress(raw: string | null, knownIds: readonly string[]): Progress {
  if (raw === null) return EMPTY_PROGRESS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_PROGRESS;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.lessons)) return EMPTY_PROGRESS;
  const stored = parsed.lessons;
  const lessons: Progress['lessons'] = {};
  for (const id of knownIds) {
    if (!Object.hasOwn(stored, id)) continue;
    const status = stored[id];
    if (!isStatus(status)) return EMPTY_PROGRESS;
    lessons[id as LessonId] = status;
  }
  return { version: 1, lessons };
}

export interface ProgressStore {
  read(): Progress;
  write(p: Progress): void;
}

/**
 * A store over `Storage`. A locked-down webview can throw on either call, and neither may reach the app.
 * The last write is also kept in memory, so a lesson the user finished still reads Done for the rest of
 * this run when storage fails. It's gone after a relaunch, which costs a status word.
 */
export function localStorageProgress(storage: Pick<Storage, 'getItem' | 'setItem'> | null, knownIds: readonly string[]): ProgressStore {
  let lastWritten: Progress | null = null;
  let stored = storage !== null;
  return {
    read: () => {
      if (!stored) return lastWritten ?? EMPTY_PROGRESS;
      try {
        return parseProgress(storage?.getItem(PROGRESS_KEY) ?? null, knownIds);
      } catch {
        return lastWritten ?? EMPTY_PROGRESS;
      }
    },
    write: (p) => {
      lastWritten = p;
      if (storage === null) return;
      try {
        storage.setItem(PROGRESS_KEY, JSON.stringify(p));
        stored = true;
      } catch {
        stored = false;
      }
    },
  };
}

/** Record a lesson as started. Done sticks: a finished lesson that runs again goes back to Done once that run is gone. */
export function withLessonStarted(p: Progress, id: LessonId): Progress {
  if (p.lessons[id] === 'done') return p;
  return { version: 1, lessons: { ...p.lessons, [id]: 'inProgress' } };
}

export function withLessonDone(p: Progress, id: LessonId): Progress {
  return { version: 1, lessons: { ...p.lessons, [id]: 'done' } };
}
