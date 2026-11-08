// yourFirstLine.ts - the first lesson: build one line on an empty board.
//
// The walk test plays this same data, so a stage added here is walked without touching the test.
// Machine and key names are tokens, never typed words, and `auditLessonWords` fails on a typed one.

import { BELT_KIND, BOARD_PAUSED, PLACE_ON_THE_FLOOR, SET_TIMER_STAGES, SINK_KIND, SOURCE_KIND, beltStages } from '../commonStages';
import type { Lesson } from '../types';

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
          coach: {
            FootprintCollision: [
              'That cell is taken, so the ',
              { kind: SINK_KIND },
              " wasn't placed. Click a free cell, like the one in the ring.",
            ],
          },
        },
      ],
      done: { is: 'nodeAppeared', kind: SINK_KIND, bind: 'sink' },
    },
    {
      id: 'set-timer',
      stages: [BOARD_PAUSED, ...SET_TIMER_STAGES],
      done: { is: 'triggerApplied', of: 'source', trigger: 'Timer' },
    },
    {
      id: 'draw-belt',
      stages: [
        BOARD_PAUSED,
        ...beltStages({ bind: 'source', kind: SOURCE_KIND }, { bind: 'sink', kind: SINK_KIND }),
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
  refused: {
    atStep: 'place-sink',
    atStage: 'sink-floor',
    press: { on: 'machine', of: 'source' },
    tag: 'FootprintCollision',
  },
};
