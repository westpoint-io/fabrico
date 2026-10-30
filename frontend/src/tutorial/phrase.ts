// phrase.ts - lesson words, built from the app's own tables. Not written yet: every read answers
// empty, so the cases in phrase.test.ts fail on their assertions.

import type { ShortcutId } from '../input/shortcuts';
import type { Lesson, PhraseToken } from './types';

export interface WordTables {
  shortcuts: { readonly [K in ShortcutId]: { readonly label: string } };
  kinds: Record<number, string>;
}

export const REAL_TABLES = { shortcuts: {}, kinds: {} } as unknown as WordTables;

export interface PhraseSegment {
  text: string;
  strong: boolean;
}

export const MAX_INSTRUCTION_CHARS = 0;
export const MAX_NOTE_CHARS = 0;

export function phrase(_tokens: readonly PhraseToken[], _tables: WordTables = REAL_TABLES): PhraseSegment[] {
  return [];
}

export function phrasePlain(_tokens: readonly PhraseToken[], _tables: WordTables = REAL_TABLES): string {
  return '';
}

export function auditLessonWords(_lessons: readonly Lesson[], _tables: WordTables = REAL_TABLES): string[] {
  return [];
}
