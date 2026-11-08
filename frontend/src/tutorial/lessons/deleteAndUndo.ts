// deleteAndUndo.ts - the lesson that builds a short line, deletes a belt and a Sink, and brings both back.
//
// The Source stays on Webhook, so nothing moves and the app's delete guard never opens: it only asks
// when items would go with the delete. Undo puts each thing back under a new handle, so the last step
// compares the board's shape and never a handle. Machine and key names are tokens, never typed words,
// and `auditLessonWords` fails on a typed one. Undo is the toolbar button's own label, typed like Timer.

import { BELT_KIND, BOARD_PAUSED, PLACE_ON_THE_FLOOR, SINK_KIND, SOURCE_KIND, TOOL_DOWN, beltStages } from '../commonStages';
import type { Lesson } from '../types';

export const DELETE_AND_UNDO: Lesson = {
  id: 'delete-and-undo',
  title: 'Delete and Undo',
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
          text: ['Build a short line first, so there is something to delete. Click ', { kind: SOURCE_KIND }, ' in the palette.'],
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
          text: ['Click ', { kind: SINK_KIND }, ' in the palette.'],
        },
        {
          id: 'sink-floor',
          when: { is: 'toolArmed', machineKind: SINK_KIND },
          hint: { on: 'floor', spot: 'sink' },
          gesture: { do: 'pressHint' },
          text: [PLACE_ON_THE_FLOOR],
          coach: {
            FootprintCollision: [
              'That cell holds the ',
              { kind: SOURCE_KIND },
              ', so the ',
              { kind: SINK_KIND },
              " wasn't placed. Click the free cell in the ring.",
            ],
          },
        },
      ],
      done: { is: 'nodeAppeared', kind: SINK_KIND, bind: 'sink' },
    },
    {
      id: 'draw-belt',
      stages: [BOARD_PAUSED, ...beltStages({ bind: 'source', kind: SOURCE_KIND }, { bind: 'sink', kind: SINK_KIND })],
      done: { is: 'beltJoins', a: 'source', b: 'sink', bind: 'belt' },
    },
    {
      id: 'delete-belt',
      // The tool goes down first: a press on a belt with the Belt tool armed starts a draw.
      stages: [
        BOARD_PAUSED,
        TOOL_DOWN,
        {
          id: 'select-belt',
          when: { is: 'notSelected', of: 'belt' },
          hint: { on: 'belt', of: 'belt' },
          gesture: { do: 'pressHint' },
          text: ['Now take the ', { kind: BELT_KIND }, ' off. Click it to select it.'],
        },
        {
          id: 'press-delete',
          when: { is: 'always' },
          hint: { on: 'belt', of: 'belt' },
          gesture: { do: 'key', shortcut: 'delete' },
          text: ['Press ', { key: 'delete' }, ' to take the ', { kind: BELT_KIND }, ' off the board.'],
        },
      ],
      done: { is: 'beltGone', of: 'belt' },
    },
    {
      id: 'delete-sink',
      stages: [
        BOARD_PAUSED,
        TOOL_DOWN,
        {
          id: 'select-sink',
          when: { is: 'notSelected', of: 'sink' },
          hint: { on: 'machine', of: 'sink' },
          gesture: { do: 'pressHint' },
          text: ['Next, the ', { kind: SINK_KIND }, '. Click it to select it.'],
        },
        {
          id: 'press-delete',
          when: { is: 'always' },
          hint: { on: 'machine', of: 'sink' },
          gesture: { do: 'key', shortcut: 'delete' },
          text: ['Press ', { key: 'delete' }, ' again to take the ', { kind: SINK_KIND }, ' off too.'],
        },
      ],
      done: { is: 'nodeGone', of: 'sink' },
    },
    {
      id: 'bring-back',
      // The first Undo brings the Sink back, and the second the belt with both docks. A paused host
      // queues an Undo as it queues a Place, so the paused stage comes first here too.
      stages: [
        BOARD_PAUSED,
        {
          id: 'undo-sink',
          when: { is: 'gone', of: 'sink' },
          hint: { on: 'panel', target: { kind: 'undoButton' } },
          gesture: { do: 'pressHint' },
          text: ['Both are gone. Press ', { key: 'undo' }, ', or Undo in the toolbar, to bring the ', { kind: SINK_KIND }, ' back.'],
        },
        {
          id: 'undo-belt',
          when: { is: 'gone', of: 'belt' },
          hint: { on: 'panel', target: { kind: 'undoButton' } },
          gesture: { do: 'key', shortcut: 'undo' },
          text: ['Press ', { key: 'undo' }, ' once more, and the ', { kind: BELT_KIND }, ' comes back joined at both ends.'],
        },
        // The board is back but the host's answers about the re-minted handles haven't come, or a query
        // failed. The card says so and marks nothing, so a user who did it right never reads too-far.
        {
          id: 'checking',
          when: { is: 'configsPending', since: 'delete-belt' },
          hint: null,
          gesture: { do: 'none' },
          text: ['The ', { kind: SINK_KIND }, ' and ', { kind: BELT_KIND }, ' are back. Checking them against the board from before the delete.'],
        },
        // Only shows once every answer has come and the board still differs from the capture, as when
        // Undo went past the delete into the draw.
        {
          id: 'too-far',
          when: { is: 'always' },
          hint: null,
          gesture: { do: 'none' },
          text: ['That went past the delete. Press ', { key: 'redo' }, ' until the ', { kind: SINK_KIND }, ' and ', { kind: BELT_KIND }, ' are back.'],
        },
      ],
      done: { is: 'restored', since: 'delete-belt' },
    },
  ],
  closing: [{ key: 'delete' }, ' takes a machine or a ', { kind: BELT_KIND }, ' off the board, and ', { key: 'undo' }, ' puts it back the way it was.'],
  // A Sink pressed on the Source's own cell, which the host refuses as a collision.
  refused: {
    atStep: 'place-sink',
    atStage: 'sink-floor',
    press: { on: 'machine', of: 'source' },
    tag: 'FootprintCollision',
  },
};
