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
 * First in each step: a paused board holds a Place in the host's queue, so steps 1 and 2 can't finish
 * until it runs, and the user has to be told why nothing happened.
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
};
