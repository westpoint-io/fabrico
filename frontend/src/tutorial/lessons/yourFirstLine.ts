// yourFirstLine.ts - the first lesson: build one line on an empty board.
//
// The walk test plays this same data, so a stage added here is walked without touching the test.

import type { Lesson } from '../types';

/** The `machine_kind` byte that `KIND_NAMES` calls Source. */
const SOURCE_KIND = 0;
/** The `machine_kind` byte that `KIND_NAMES` calls Sink. */
const SINK_KIND = 7;

export const YOUR_FIRST_LINE: Lesson = {
  id: 'your-first-line',
  title: 'Your first line',
  steps: [
    {
      id: 'place-source',
      stages: [
        {
          id: 'source-tool',
          when: { is: 'toolNotArmed', machineKind: SOURCE_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: SOURCE_KIND } },
          gesture: { do: 'pressHint' },
        },
        {
          id: 'source-floor',
          when: { is: 'toolArmed', machineKind: SOURCE_KIND },
          hint: { on: 'floor', spot: 'source' },
          gesture: { do: 'pressHint' },
        },
      ],
      done: { is: 'nodeAppeared', kind: SOURCE_KIND, bind: 'source' },
    },
    {
      id: 'place-sink',
      stages: [
        {
          id: 'sink-tool',
          when: { is: 'toolNotArmed', machineKind: SINK_KIND },
          hint: { on: 'panel', target: { kind: 'placeMachine', machineKind: SINK_KIND } },
          gesture: { do: 'pressHint' },
        },
        {
          id: 'sink-floor',
          when: { is: 'toolArmed', machineKind: SINK_KIND },
          hint: { on: 'floor', spot: 'sink' },
          gesture: { do: 'pressHint' },
        },
      ],
      done: { is: 'nodeAppeared', kind: SINK_KIND, bind: 'sink' },
    },
  ],
};
