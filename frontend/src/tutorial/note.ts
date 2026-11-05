// note.ts - what the running step card shows in its two message places.
//
// The card has a note slot (the first row of its left column) and an off-screen row. One rule decides
// both: refusal over off-screen over the lesson notes. Pure, so a unit test covers every row of the
// table in 103-UI-SPEC.md, "Refusal note". Refusal tags are plain strings here, because this folder
// can't import the transport's tag type; `lessonCoverage.source.test.ts` pins them to the app's tags.

import type { LessonNote } from './machine';
import type { PhraseToken, Stage } from './types';

/**
 * What the note slot holds. `hidden` keeps it in layout and out of sight (StepCard uses `opacity: 0`,
 * so a screen reader keeps it), so the card's height holds.
 */
export interface NoteSlot {
  /** `refusal`, or a lesson note's kind. */
  kind: string;
  tokens: readonly PhraseToken[];
  hidden: boolean;
}

export interface NoteArgs {
  /** The refusal's words for this stage, or null with no refusal pending. */
  refusal: readonly PhraseToken[] | null;
  /** Is the stage's target out of view? */
  offScreen: boolean;
  /** The lesson's own note (skipped, went back, already running), or null. */
  lessonNote: { kind: LessonNote['kind']; tokens: readonly PhraseToken[] } | null;
}

export interface NoteView {
  slot: NoteSlot | null;
  /** Does the off-screen row show? When false, the row keeps its height and hides. */
  row: boolean;
}

/**
 * Refusal over off-screen over the lesson notes. A refusal always fills the slot, visibly. The
 * off-screen row shows whenever the target is out of view, and with no refusal it holds a lesson note
 * back by hiding it in place, so the card doesn't jump as the user pans across the edge.
 */
export function noteFor({ refusal, offScreen, lessonNote }: NoteArgs): NoteView {
  if (refusal !== null) return { slot: { kind: 'refusal', tokens: refusal, hidden: false }, row: offScreen };
  if (lessonNote === null) return { slot: null, row: offScreen };
  return { slot: { kind: lessonNote.kind, tokens: lessonNote.tokens, hidden: offScreen }, row: offScreen };
}

/** The stage's coaching line for a refusal tag. Own keys only, so a tag can't match an inherited name. */
export function coachLine(stage: Stage, tag: string): readonly PhraseToken[] | null {
  const coach = stage.coach;
  if (coach === undefined || !Object.hasOwn(coach, tag)) return null;
  return coach[tag] ?? null;
}
