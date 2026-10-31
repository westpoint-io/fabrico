// phrase.test.ts - lesson words come from the app's own tables.
//
// The tables are a parameter, so these cases change an entry and read the sentence that comes out.
// A rename in `KIND_NAMES` or `SHORTCUTS` has to reach the lesson text with no edit to a lesson.

import { describe, expect, it } from 'vitest';
import { LESSONS } from './lessons/index.ts';
import { YOUR_FIRST_LINE } from './lessons/yourFirstLine.ts';
import {
  MAX_INSTRUCTION_CHARS,
  MAX_NOTE_CHARS,
  REAL_TABLES,
  auditLessonWords,
  phrase,
  phrasePlain,
  type WordTables,
} from './phrase.ts';
import type { Lesson, PhraseToken, Stage } from './types.ts';

const SOURCE = 0;
const SINK = 7;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function stageOf(stepId: string, stageId: string): Stage {
  const step = YOUR_FIRST_LINE.steps.find((s) => s.id === stepId);
  const stage = step?.stages.find((s) => s.id === stageId);
  if (stage === undefined) throw new Error(`no stage ${stepId}/${stageId} in the lesson`);
  return stage;
}

function withKind(kind: number, name: string): WordTables {
  return { ...REAL_TABLES, kinds: { ...REAL_TABLES.kinds, [kind]: name } };
}

function withLabel(id: 'escape' | 'playPause', label: string): WordTables {
  return { ...REAL_TABLES, shortcuts: { ...REAL_TABLES.shortcuts, [id]: { label } } };
}

/** A one-stage lesson holding `text`, with a closing that names nothing. */
function lessonWith(text: readonly PhraseToken[], closing: readonly PhraseToken[] = ['Well built.']): Lesson {
  return {
    id: 'your-first-line',
    title: 'A fixture lesson',
    closing,
    refused: { atStep: 'fixture-step', atStage: 'fixture-stage', press: { on: 'machine', of: 'source' } },
    steps: [
      {
        id: 'fixture-step',
        done: { is: 'nodeAppeared', kind: SOURCE, bind: 'source' },
        stages: [{ id: 'fixture-stage', when: { is: 'always' }, hint: null, gesture: { do: 'none' }, text }],
      },
    ],
  };
}

describe('phrase: sentences built through the word tables', () => {
  it('reads the first instruction with the real tables', () => {
    expect(phrasePlain(stageOf('place-source', 'source-tool').text)).toBe(
      'A Source makes items. Click Source in the palette.',
    );
  });

  it('follows a renamed machine: the new word appears and the old one is gone', () => {
    const plain = phrasePlain(stageOf('place-source', 'source-tool').text, withKind(SOURCE, 'Spawner'));
    expect(plain).toBe('A Spawner makes items. Click Spawner in the palette.');
    expect(plain).not.toContain('Source');
  });

  it('follows a renamed Sink through step 2', () => {
    const plain = phrasePlain(stageOf('place-sink', 'sink-tool').text, withKind(SINK, 'Drain'));
    expect(plain).toBe('A Drain takes items in at the end of a line. Click Drain in the palette.');
    expect(plain).not.toContain('Sink');
  });

  it('follows a renamed escape key: the new label appears and the old one is gone', () => {
    const tokens: PhraseToken[] = ['Press ', { key: 'escape' }, ' to put the tool down.'];
    expect(phrasePlain(tokens)).toBe('Press Esc to put the tool down.');
    const plain = phrasePlain(tokens, withLabel('escape', 'Cancel'));
    expect(plain).toBe('Press Cancel to put the tool down.');
    expect(plain).not.toContain('Esc');
  });

  it('follows a renamed play key through the paused stage', () => {
    const { text } = stageOf('place-source', 'board-paused');
    expect(phrasePlain(text)).toBe('The board is paused, so your edits wait. Press Play in the toolbar, or press Space.');
    const plain = phrasePlain(text, withLabel('playPause', 'Enter'));
    expect(plain).toBe('The board is paused, so your edits wait. Press Play in the toolbar, or press Enter.');
    expect(plain).not.toContain('Space');
  });

  it('gives the paused stage first place in both steps, under one id', () => {
    for (const step of YOUR_FIRST_LINE.steps) {
      expect(step.stages[0]?.id, `${step.id} starts on the paused stage`).toBe('board-paused');
      expect(step.stages[0]?.when).toEqual({ is: 'paused' });
      expect(step.stages[0]?.hint).toEqual({ on: 'panel', target: { kind: 'playButton' } });
      expect(step.stages[0]?.gesture).toEqual({ do: 'pressHint' });
    }
  });

  it('marks table words strong and plain text not', () => {
    expect(phrase(['Click ', { kind: SOURCE }, ' then ', { key: 'escape' }, '.'])).toEqual([
      { text: 'Click ', strong: false },
      { text: 'Source', strong: true },
      { text: ' then ', strong: false },
      { text: 'Esc', strong: true },
      { text: '.', strong: false },
    ]);
  });

  it('throws naming the kind when a machine has no table entry', () => {
    expect(() => phrase([{ kind: 99 }])).toThrow(/kind 99/);
    expect(() => phrasePlain(['Click ', { kind: 99 }])).toThrow(/kind 99/);
  });

  it('throws naming the key when a key has no table entry', () => {
    const unknown = { key: 'launch' } as unknown as PhraseToken;
    expect(() => phrase([unknown])).toThrow(/launch/);
    const inherited = { key: 'toString' } as unknown as PhraseToken;
    expect(() => phrase([inherited])).toThrow(/toString/);
  });

  it('closes the lesson with the finished sentence', () => {
    expect(phrasePlain(YOUR_FIRST_LINE.closing)).toBe(
      'A Source makes items, a Belt carries them and a Sink takes them in. The board is yours, so keep building.',
    );
  });
});

describe('auditLessonWords: a table word typed as text', () => {
  it('finds nothing in the real lessons', () => {
    expect(auditLessonWords(LESSONS)).toEqual([]);
  });

  it('finds a literal Sink in a string token, and names the word', () => {
    const findings = auditLessonWords([lessonWith(['Click the Sink now.'])]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('Sink');
  });

  it('finds a literal planted in a real stage of the real lesson', () => {
    const [step, ...rest] = YOUR_FIRST_LINE.steps;
    const [stage, ...stages] = step!.stages;
    const planted: Lesson = {
      ...YOUR_FIRST_LINE,
      steps: [{ ...step!, stages: [{ ...stage!, text: ['A Sink waits here.'] }, ...stages] }, ...rest],
    };
    expect(auditLessonWords([planted])).toHaveLength(1);
  });

  it('reads the closing text as well as the stages', () => {
    expect(auditLessonWords([lessonWith(['Well built.'], ['A Belt carries them.'])])).toHaveLength(1);
  });

  it('matches a whole word, in its own case', () => {
    expect(auditLessonWords([lessonWith(['The sink of a sinking Sinkhole.'])])).toEqual([]);
    expect(auditLessonWords([lessonWith(["The Sink's input."])])).toHaveLength(1);
  });

  it("lets a sentence end in a full stop, though the Step key's label is a full stop", () => {
    expect(auditLessonWords([lessonWith(['A ', { kind: SOURCE }, ' makes items.'])])).toEqual([]);
  });

  it('reads a string token holding only a full stop after a machine as the end of a sentence', () => {
    expect(auditLessonWords([lessonWith(['Click ', { kind: SOURCE }, '.'])])).toEqual([]);
    expect(auditLessonWords([lessonWith([{ kind: SOURCE }, '.'])])).toEqual([]);
  });

  it('finds the Step key written as punctuation', () => {
    const findings = auditLessonWords([lessonWith(['Press . to step once.'])]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"."');
  });

  it('treats a label with punctuation inside it like a word', () => {
    expect(auditLessonWords([lessonWith(['Press Ctrl+S to save.'])])).toHaveLength(1);
  });

  it("allows the words on the controls' own labels", () => {
    expect(auditLessonWords([lessonWith(['Under Trigger, press Timer, then Apply, then Play.'])])).toEqual([]);
  });
});

describe('the step text budget, counted on the resolved plain string', () => {
  const stages = LESSONS.flatMap((lesson) => lesson.steps.flatMap((step) => step.stages));

  it('states the two limits', () => {
    expect(MAX_INSTRUCTION_CHARS).toBe(141);
    expect(MAX_NOTE_CHARS).toBe(94);
  });

  it('holds every stage inside the instruction budget, in printable ASCII', () => {
    expect(stages.length, 'NON-VACUITY: the lessons hold stages to measure').toBeGreaterThanOrEqual(6);
    for (const stage of stages) {
      const plain = phrasePlain(stage.text);
      expect(plain.length, `${stage.id}: "${plain}" has words`).toBeGreaterThan(0);
      expect(plain.length, `${stage.id}: "${plain}"`).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
      expect(plain, `${stage.id} is printable ASCII`).toMatch(PRINTABLE_ASCII);
    }
  });

  it('holds the closing sentence inside the instruction budget, in printable ASCII', () => {
    for (const lesson of LESSONS) {
      const plain = phrasePlain(lesson.closing);
      expect(plain.length, `${lesson.id} closing`).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
      expect(plain, `${lesson.id} closing is printable ASCII`).toMatch(PRINTABLE_ASCII);
    }
  });

  it('counts a long label at its resolved length, not as one token', () => {
    const tokens: PhraseToken[] = ['Press ', { key: 'delete' }, '.'];
    expect(phrasePlain(tokens)).toBe('Press Delete or Backspace.');
    expect(phrasePlain(tokens).length).toBe(26);
  });

  it('leaves room for the longest key label in the longest note the copy table holds', () => {
    const note: PhraseToken[] = ['The board was already running, so step 5 is done. ', { key: 'delete' }, ' pauses it.'];
    expect(phrasePlain(note).length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
  });
});
