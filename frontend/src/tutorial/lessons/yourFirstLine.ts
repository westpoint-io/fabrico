// yourFirstLine.ts - the first lesson: build one line on an empty board.
//
// The walk test plays this same data, so a stage added here is walked without touching the test.
// Machine and key names are tokens, never typed words, and `auditLessonWords` fails on a typed one.

import { BELT_KIND, BOARD_PAUSED, PLACE_ON_THE_FLOOR, SINK_KIND, SOURCE_KIND, TOOL_DOWN, beltStages } from '../commonStages';
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
      // Four stages, because machine tools stay armed after a place, a press on the Source with a tool
      // still armed sends another Place, and a trigger change does nothing until Apply.
      stages: [
        BOARD_PAUSED,
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
      ],
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
