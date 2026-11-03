// note.test.ts - the running card's two message places, and the coaching lookup.
//
// The six rows are the table in 103-UI-SPEC.md, "Refusal note": refusal over off-screen over the
// lesson notes. The budget case reads every coaching line in the real lessons.

import { describe, expect, it } from 'vitest';
import { LESSONS } from './lessons/index.ts';
import { YOUR_FIRST_LINE } from './lessons/yourFirstLine.ts';
import { coachLine, noteFor } from './note.ts';
import { MAX_NOTE_CHARS, REAL_TABLES, phrasePlain } from './phrase.ts';
import type { PhraseToken, Stage } from './types.ts';

const REFUSAL: readonly PhraseToken[] = ['That cell is taken.'];
const LESSON_NOTE = { kind: 'skippedOne' as const, tokens: ['Step 1 was already done, so the lesson moved on.'] as readonly PhraseToken[] };

function stageOf(stepId: string, stageId: string): Stage {
  const stage = YOUR_FIRST_LINE.steps.find((s) => s.id === stepId)?.stages.find((s) => s.id === stageId);
  if (stage === undefined) throw new Error(`no stage ${stepId}/${stageId} in the lesson`);
  return stage;
}

describe('noteFor: refusal over off-screen over the lesson notes', () => {
  it('row 1: a refusal with the target out of view fills the slot and shows the row', () => {
    expect(noteFor({ refusal: REFUSAL, offScreen: true, lessonNote: LESSON_NOTE })).toEqual({
      slot: { kind: 'refusal', tokens: REFUSAL, hidden: false },
      row: true,
    });
  });

  it('row 2: a refusal with the target in view fills the slot and hides the row', () => {
    expect(noteFor({ refusal: REFUSAL, offScreen: false, lessonNote: LESSON_NOTE })).toEqual({
      slot: { kind: 'refusal', tokens: REFUSAL, hidden: false },
      row: false,
    });
  });

  it('row 3: no refusal, target out of view, a lesson note: the note stays in layout, hidden, and the row shows', () => {
    expect(noteFor({ refusal: null, offScreen: true, lessonNote: LESSON_NOTE })).toEqual({
      slot: { kind: 'skippedOne', tokens: LESSON_NOTE.tokens, hidden: true },
      row: true,
    });
  });

  it('row 4: no refusal, target out of view, no lesson note: the slot is empty and the row shows', () => {
    expect(noteFor({ refusal: null, offScreen: true, lessonNote: null })).toEqual({ slot: null, row: true });
  });

  it('row 5: no refusal, target in view, a lesson note: the note shows and the row hides', () => {
    expect(noteFor({ refusal: null, offScreen: false, lessonNote: LESSON_NOTE })).toEqual({
      slot: { kind: 'skippedOne', tokens: LESSON_NOTE.tokens, hidden: false },
      row: false,
    });
  });

  it('row 6: nothing gives an empty slot and a hidden row', () => {
    expect(noteFor({ refusal: null, offScreen: false, lessonNote: null })).toEqual({ slot: null, row: false });
  });
});

describe('coachLine', () => {
  const sinkFloor = stageOf('place-sink', 'sink-floor');

  it("returns the stage's line for a tag it holds", () => {
    expect(coachLine(sinkFloor, 'FootprintCollision')).toBe(sinkFloor.coach?.FootprintCollision);
    expect(coachLine(sinkFloor, 'FootprintCollision')).not.toBeNull();
  });

  it('returns null for a tag the stage has no line for, and for an inherited name', () => {
    expect(coachLine(sinkFloor, 'InvalidDock')).toBeNull();
    expect(coachLine(sinkFloor, 'toString')).toBeNull();
  });

  it('returns null at a stage with no coach map', () => {
    expect(coachLine(stageOf('place-sink', 'sink-tool'), 'FootprintCollision')).toBeNull();
  });
});

describe('the note budget', () => {
  it(`holds every coaching line in the lessons to ${MAX_NOTE_CHARS} characters`, () => {
    let seen = 0;
    for (const lesson of LESSONS) {
      for (const step of lesson.steps) {
        for (const stage of step.stages) {
          for (const [tag, line] of Object.entries(stage.coach ?? {})) {
            seen += 1;
            const text = phrasePlain(line, REAL_TABLES);
            expect(text.length, `${lesson.id} ${step.id} ${stage.id} ${tag}: "${text}"`).toBeLessThanOrEqual(MAX_NOTE_CHARS);
          }
        }
      }
    }
    expect(seen, 'the scan reached at least one coaching line').toBeGreaterThan(0);
  });
});
