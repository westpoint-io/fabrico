// commonStages.ts - the stages and kind bytes more than one lesson uses.
//
// It sits outside `lessons/` on purpose: `lessonCoverage.source.test.ts` fails any file in that folder
// that `lessons/index.ts` doesn't hold in `LESSONS`, and this file holds no lesson. Machine and key names
// are tokens, never typed words, and `auditLessonWords` reads these stages through every lesson that uses them.

import type { BindingName, PhraseToken, Stage } from './types';

/** The `machine_kind` byte that `KIND_NAMES` calls Source. */
export const SOURCE_KIND = 0;
/** The `machine_kind` byte that `KIND_NAMES` calls Sink. */
export const SINK_KIND = 7;
/** The `machine_kind` byte that `KIND_NAMES` calls Belt. */
export const BELT_KIND = 1;
/** The `machine_kind` byte that `KIND_NAMES` calls Factory. */
export const FACTORY_KIND = 2;

/**
 * First in nearly every step: a paused board holds an edit in the host's queue and moves no item, so
 * the step can't finish until it runs, and the user has to be told why nothing happened.
 */
export const BOARD_PAUSED: Stage = {
  id: 'board-paused',
  when: { is: 'paused' },
  hint: { on: 'panel', target: { kind: 'playButton' } },
  gesture: { do: 'pressHint' },
  text: ['The board is paused, so your edits wait. Press Play in the toolbar, or press ', { key: 'playPause' }, '.'],
};

/** The floor stage's sentence, for any machine. */
export const PLACE_ON_THE_FLOOR = 'Click the floor to place it. The ring marks a free spot, but any free spot works.';

/**
 * Before a press on something already on the board: machine tools stay armed after a place, so a press
 * on a machine with a tool still armed sends another Place, and a press on a belt with the Belt tool
 * armed starts a draw.
 */
export const TOOL_DOWN: Stage = {
  id: 'tool-down',
  when: { is: 'anyToolArmed' },
  hint: { on: 'panel', target: { kind: 'armedTool' } },
  gesture: { do: 'key', shortcut: 'escape' },
  text: ['Press ', { key: 'escape' }, ' to put the tool down, or click it again in the palette.'],
};

/**
 * The stages that set the bound Source's trigger to Timer, after the paused stage: put the tool down,
 * select the Source, press Timer, press Apply. Four, because machine tools stay armed after a place, a
 * press on the Source with a tool still armed sends another Place, and a trigger change does nothing
 * until Apply.
 */
export const SET_TIMER_STAGES: readonly Stage[] = [
  TOOL_DOWN,
  {
    id: 'select-source',
    when: { is: 'notSelected', of: 'source' },
    hint: { on: 'machine', of: 'source' },
    gesture: { do: 'pressHint' },
    text: ['A new ', { kind: SOURCE_KIND }, ' waits for a web request, so it makes nothing yet. Click it to select it.'],
  },
  {
    id: 'press-timer',
    when: { is: 'triggerNotPressed', trigger: 'Timer' },
    hint: { on: 'panel', target: { kind: 'segment', group: 'Trigger', label: 'Timer' } },
    gesture: { do: 'pressHint' },
    text: ['Under Trigger, press Timer so it makes items on its own.'],
  },
  {
    id: 'apply-timer',
    when: { is: 'triggerNotApplied', trigger: 'Timer' },
    hint: { on: 'panel', target: { kind: 'applyButton' } },
    gesture: { do: 'pressHint' },
    text: ['Press Apply to put the change on the board.'],
  },
];

/** One end of a belt a lesson asks for: the machine's binding and its kind byte, which names it in the words. */
export interface BeltEnd {
  bind: BindingName;
  kind: number;
}

/** What a lesson may change in `beltStages`. Each one left out keeps lesson 1's. */
export interface BeltStageOptions {
  /** `free` starts the drag from the first output no belt holds yet, for a machine with more than one. */
  pick?: 'free';
  /** The plain drag's words. */
  draw?: readonly PhraseToken[];
  /** The carry-on stage's words. */
  carryOn?: readonly PhraseToken[];
  /** Coaching lines for the plain drag, keyed by refusal tag. */
  drawCoach?: Readonly<Record<string, readonly PhraseToken[]>>;
}

/**
 * The four stages that draw one belt from `from`'s output to `to`'s input: arm the Belt tool, undo a belt
 * that can't be carried on, carry a short line on, and the plain drag. Their ids, conditions, rings and
 * words are lesson 1's, with each machine named by its own end, unless `options` says otherwise.
 */
export function beltStages(from: BeltEnd, to: BeltEnd, options: BeltStageOptions = {}): readonly Stage[] {
  return [
    {
      id: 'belt-tool',
      when: { is: 'beltNotArmed' },
      hint: { on: 'panel', target: { kind: 'beltTool' } },
      gesture: { do: 'pressHint' },
      text: ['A ', { kind: BELT_KIND }, ' carries items between machines. Click ', { kind: BELT_KIND }, ' in the palette.'],
    },
    // Ahead of both drags, because each of them starts or ends on something this belt holds, and a
    // press can't carry it on. The user presses the key, and this stage sends nothing itself. It takes
    // more than one press, because Undo takes the belt's docks back before the belt.
    {
      id: 'belt-undo',
      when: { is: 'lineStuck', from: from.bind, to: to.bind },
      hint: null,
      gesture: { do: 'key', shortcut: 'undo' },
      text: ['That ', { kind: BELT_KIND }, " can't be carried on. Press ", { key: 'undo' }, " until it's gone, then draw it again."],
    },
    // Ahead of the plain drag, because that drag starts on an output this belt already holds and the
    // host refuses it. The app rings the belt's free end while the tool is armed, so this ring only
    // marks where the drag finishes.
    {
      id: 'belt-carry-on',
      when: { is: 'lineStopsShort', from: from.bind },
      hint: { on: 'port', of: to.bind, role: 'in' },
      gesture: { do: 'dragToHint' },
      text: options.carryOn ?? ['That ', { kind: BELT_KIND }, ' stops before the ', { kind: to.kind }, '. Drag from the ring at its end to the ', { kind: to.kind }, "'s input dot."],
    },
    {
      id: 'belt-draw',
      when: { is: 'beltArmed' },
      hint: { on: 'port', of: from.bind, role: 'out', ...(options.pick === undefined ? {} : { pick: options.pick }), to: { of: to.bind, role: 'in' } },
      gesture: { do: 'dragHint' },
      text: options.draw ?? ['Drag from the ', { kind: from.kind }, "'s output dot to the ", { kind: to.kind }, "'s input dot."],
      ...(options.drawCoach === undefined ? {} : { coach: options.drawCoach }),
    },
  ];
}
