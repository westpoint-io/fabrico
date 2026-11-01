// yourFirstLine.ts - the first lesson: build one line on an empty board.
//
// The walk test plays this same data, so a stage added here is walked without touching the test.
// Machine and key names are tokens, never typed words, and `auditLessonWords` fails on a typed one.

import type { Lesson, Stage } from '../types';

/** The `machine_kind` byte that `KIND_NAMES` calls Source. */
const SOURCE_KIND = 0;
/** The `machine_kind` byte that `KIND_NAMES` calls Sink. */
const SINK_KIND = 7;
/** The `machine_kind` byte that `KIND_NAMES` calls Belt. */
const BELT_KIND = 1;

/**
 * First in steps 1 to 4 and 6: a paused board holds an edit in the host's queue and moves no item, so
 * the step can't finish until it runs, and the user has to be told why nothing happened.
 */
const BOARD_PAUSED: Stage = {
  id: 'board-paused',
  when: { is: 'paused' },
  hint: { on: 'panel', target: { kind: 'playButton' } },
  gesture: { do: 'pressHint' },
  text: ['The board is paused, so your edits wait. Press Play in the toolbar, or press ', { key: 'playPause' }, '.'],
};

const PLACE_ON_THE_FLOOR = 'Click the floor to place it. The ring marks a free spot, but any free spot works.';

export const YOUR_FIRST_LINE: Lesson = {
  id: 'your-first-line',
  title: 'Your first line',
  steps: [
    {
      id: 'place-source',
      stages: [
        BOARD_PAUSED,
        {
          id: 'source-tool',
          when: { is: 'toolNotArmed', machineKind: SOURCE_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: SOURCE_KIND } },
          gesture: { do: 'pressHint' },
          text: ['A ', { kind: SOURCE_KIND }, ' makes items. Click ', { kind: SOURCE_KIND }, ' in the palette.'],
        },
        {
          id: 'source-floor',
          when: { is: 'toolArmed', machineKind: SOURCE_KIND },
          hint: { on: 'floor', spot: 'source' },
          gesture: { do: 'pressHint' },
          text: [PLACE_ON_THE_FLOOR],
        },
      ],
      done: { is: 'nodeAppeared', kind: SOURCE_KIND, bind: 'source' },
    },
    {
      id: 'place-sink',
      stages: [
        BOARD_PAUSED,
        {
          id: 'sink-tool',
          when: { is: 'toolNotArmed', machineKind: SINK_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: SINK_KIND } },
          gesture: { do: 'pressHint' },
          text: ['A ', { kind: SINK_KIND }, ' takes items in at the end of a line. Click ', { kind: SINK_KIND }, ' in the palette.'],
        },
        {
          id: 'sink-floor',
          when: { is: 'toolArmed', machineKind: SINK_KIND },
          hint: { on: 'floor', spot: 'sink' },
          gesture: { do: 'pressHint' },
          text: [PLACE_ON_THE_FLOOR],
        },
      ],
      done: { is: 'nodeAppeared', kind: SINK_KIND, bind: 'sink' },
    },
    {
      id: 'set-timer',
      // Four stages, because machine tools stay armed after a place, a press on the Source with a tool
      // still armed sends another Place, and a trigger change does nothing until Apply.
      stages: [
        BOARD_PAUSED,
        {
          id: 'tool-down',
          when: { is: 'anyToolArmed' },
          hint: { on: 'panel', target: { kind: 'armedTool' } },
          gesture: { do: 'key', shortcut: 'escape' },
          text: ['Press ', { key: 'escape' }, ' to put the tool down, or click it again in the palette.'],
        },
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
      ],
      done: { is: 'triggerApplied', of: 'source', trigger: 'Timer' },
    },
    {
      id: 'draw-belt',
      stages: [
        BOARD_PAUSED,
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
          when: { is: 'lineStuck', from: 'source', to: 'sink' },
          hint: null,
          gesture: { do: 'key', shortcut: 'undo' },
          text: ['That ', { kind: BELT_KIND }, " can't be carried on. Press ", { key: 'undo' }, " until it's gone, then draw it again."],
        },
        // Ahead of the plain drag, because that drag starts on an output this belt already holds and the
        // host refuses it. The app rings the belt's free end while the tool is armed, so this ring only
        // marks where the drag finishes.
        {
          id: 'belt-carry-on',
          when: { is: 'lineStopsShort', from: 'source' },
          hint: { on: 'port', of: 'sink', role: 'in' },
          gesture: { do: 'dragToHint' },
          text: ['That ', { kind: BELT_KIND }, ' stops before the ', { kind: SINK_KIND }, '. Drag from the ring at its end to the ', { kind: SINK_KIND }, "'s input dot."],
        },
        {
          id: 'belt-draw',
          when: { is: 'beltArmed' },
          hint: { on: 'port', of: 'source', role: 'out', to: { of: 'sink', role: 'in' } },
          gesture: { do: 'dragHint' },
          text: ['Drag from the ', { kind: SOURCE_KIND }, "'s output dot to the ", { kind: SINK_KIND }, "'s input dot."],
        },
      ],
      done: { is: 'beltJoins', a: 'source', b: 'sink', bind: 'belt' },
    },
    {
      id: 'press-play',
      // A running board finishes this on its next higher tick, about one drawn frame, so it needs a
      // stage of its own for that frame, with nothing to ask for.
      stages: [
        {
          id: 'board-paused',
          when: { is: 'paused' },
          hint: { on: 'panel', target: { kind: 'playButton' } },
          gesture: { do: 'pressHint' },
          text: ['Press Play in the toolbar, or press ', { key: 'playPause' }, '.'],
        },
        {
          id: 'board-running',
          when: { is: 'always' },
          hint: null,
          gesture: { do: 'none' },
          text: ['The board is running.'],
        },
      ],
      done: { is: 'tickRose' },
    },
    {
      id: 'watch-items',
      stages: [
        BOARD_PAUSED,
        {
          id: 'watch',
          when: { is: 'always' },
          hint: { on: 'machine', of: 'sink' },
          gesture: { do: 'watch' },
          text: ['Watch the dots ride the ', { kind: BELT_KIND }, ' into the ', { kind: SINK_KIND }, '.'],
        },
      ],
      done: { is: 'itemArrived', at: 'sink' },
    },
  ],
  closing: [
    'A ',
    { kind: SOURCE_KIND },
    ' makes items, a ',
    { kind: BELT_KIND },
    ' carries them and a ',
    { kind: SINK_KIND },
    ' takes them in. The board is yours, so keep building.',
  ],
  // A Sink pressed on the Source's own cell, which the host refuses as a collision.
  refused: { atStep: 'place-sink', atStage: 'sink-floor', press: { on: 'machine', of: 'source' } },
};
