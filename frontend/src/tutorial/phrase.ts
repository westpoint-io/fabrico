// phrase.ts - lesson words, built from the app's own tables.
//
// A lesson names a machine or a key by a token, and the token resolves through `KIND_NAMES` or
// `SHORTCUTS`, so renaming either one changes the sentence with no edit to a lesson. The tables are a
// parameter because `shortcutTable` returns fixed data, and a test has to be able to change an entry
// and read what comes out. A token with no table entry throws by name, so a sentence can't print
// "undefined".

import { KIND_NAMES } from '../../shared/kindNames';
import { SHORTCUTS, type ShortcutId } from '../input/shortcuts';
import type { Lesson, PhraseToken } from './types';

export interface WordTables {
  shortcuts: { readonly [K in ShortcutId]: { readonly label: string } };
  kinds: Record<number, string>;
}

export const REAL_TABLES: WordTables = { shortcuts: SHORTCUTS, kinds: KIND_NAMES };

export interface PhraseSegment {
  text: string;
  strong: boolean;
}

/**
 * The card's text budget, in characters of the resolved plain string. Its left column holds about 47
 * characters a line at the 8 px advance Martian Mono has at 12 px, so 141 is 3 lines and 94 is 2. That
 * arithmetic holds only for printable ASCII, which `phrase.test.ts` asserts alongside the length.
 */
export const MAX_INSTRUCTION_CHARS = 141;
export const MAX_NOTE_CHARS = 94;

function wordOf(token: Exclude<PhraseToken, string>, tables: WordTables): string {
  if ('kind' in token) {
    if (!Object.hasOwn(tables.kinds, token.kind)) {
      throw new Error(`lesson text names kind ${token.kind}, and the kind table has no such entry`);
    }
    return tables.kinds[token.kind] as string;
  }
  // Destructured, so the keyboard gate in `shortcuts.test.ts` doesn't read this as a key event.
  const { key: id } = token;
  if (!Object.hasOwn(tables.shortcuts, id)) {
    throw new Error(`lesson text names key "${id}", and the shortcut table has no such entry`);
  }
  return tables.shortcuts[id].label;
}

export function phrase(tokens: readonly PhraseToken[], tables: WordTables = REAL_TABLES): PhraseSegment[] {
  return tokens.map((token) =>
    typeof token === 'string' ? { text: token, strong: false } : { text: wordOf(token, tables), strong: true },
  );
}

export function phrasePlain(tokens: readonly PhraseToken[], tables: WordTables = REAL_TABLES): string {
  return phrase(tokens, tables)
    .map((segment) => segment.text)
    .join('');
}

/** Stands in for a table token in the audit: not a letter, a digit or a space. */
const TOKEN_MARKER = '\u0001';
const LETTER_OR_DIGIT = /[A-Za-z0-9]/;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The match for a label typed as text, built from its two edges. A letter or digit edge must not
 * touch another letter or digit, which is a whole-word match. A punctuation edge must touch a space
 * or the end of the string: the Step key's label is `.`, and every sentence ends in one, so
 * `items.` is clean and `Press . to step once.` is not.
 */
function labelPattern(label: string): RegExp {
  const before = LETTER_OR_DIGIT.test(label.charAt(0)) ? '(?<![A-Za-z0-9])' : '(?<![^\\s])';
  const after = LETTER_OR_DIGIT.test(label.charAt(label.length - 1)) ? '(?![A-Za-z0-9])' : '(?![^\\s])';
  return new RegExp(`${before}${escapeForRegExp(label)}${after}`);
}

/**
 * One finding for each table word a lesson types as text. The words on the Timer, Trigger, Apply and
 * Play controls aren't in either table, so they're allowed: they're the controls' own labels, which
 * the walk test reads off the real controls.
 */
export function auditLessonWords(lessons: readonly Lesson[], tables: WordTables = REAL_TABLES): string[] {
  const words = [...Object.values(tables.kinds), ...Object.values(tables.shortcuts).map((s) => s.label)];
  const patterns = words.map((word) => ({ word, pattern: labelPattern(word) }));
  const findings: string[] = [];
  const audit = (where: string, tokens: readonly PhraseToken[]): void => {
    // One string, so a lone `.` token after a machine name reads as the end of its sentence.
    const joined = tokens.map((token) => (typeof token === 'string' ? token : TOKEN_MARKER)).join('');
    for (const { word, pattern } of patterns) {
      if (pattern.test(joined)) findings.push(`${where}: "${word}" is typed as text, so a rename can't reach it`);
    }
  };
  for (const lesson of lessons) {
    for (const step of lesson.steps) {
      for (const stage of step.stages) audit(`${lesson.id} step ${step.id} stage ${stage.id}`, stage.text);
    }
    audit(`${lesson.id} closing`, lesson.closing);
  }
  return findings;
}
