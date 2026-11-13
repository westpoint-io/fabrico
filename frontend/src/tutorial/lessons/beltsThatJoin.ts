// beltsThatJoin.ts - the lesson on a prepared board: a Source whose belt stops short of a Sink. The user
// carries the belt on from the ring past its end, down into the Sink, so it turns a corner on that cell.
//
// The board's machines are declared by their node keys, read off the Place lines in the board file
// (`lessonBoard.source.test.ts` holds the two together), so the lesson starts only on that board and the
// prepared Source and Sink finish no step. The join step reads the tile kind the host ships on the ring
// cell, so a line that joins without turning there keeps the step open. Machine and key names are tokens.

import { BELT_KIND, BOARD_PAUSED, PRESS_PLAY_STAGES, SINK_KIND, SOURCE_KIND, beltStages, watchStage } from '../commonStages';
import type { Lesson, Stage } from '../types';

/**
 * Ahead of the belt-tool stage, so it shows with the tool down too. "Where the ring was", because once a
 * tile covers the ring cell the app stops painting that ring. The board's history is sealed at the stub,
 * so Undo always gets back to a belt that stops short.
 */
const BELT_NO_CORNER: Stage = {
  id: 'belt-no-corner',
  when: { is: 'lineNoCorner', a: 'source', b: 'sink' },
  hint: { on: 'panel', target: { kind: 'undoButton' } },
  gesture: { do: 'key', shortcut: 'undo' },
  text: ['That ', { kind: BELT_KIND }, " doesn't turn where the ring was. Press ", { key: 'undo' }, ' until it stops short, then draw straight down from the ring.'],
};

export const BELTS_THAT_JOIN: Lesson = {
  id: 'belts-that-join',
  title: 'Belts that join',
  board: {
    id: 'belts_that_join',
    machines: [
      { nodeKey: `${SOURCE_KIND}@1,2`, bind: 'source' },
      { nodeKey: `${SINK_KIND}@6,6`, bind: 'sink' },
    ],
  },
  steps: [
    {
      id: 'join-belt',
      stages: [
        BOARD_PAUSED,
        BELT_NO_CORNER,
        ...beltStages(
          { bind: 'source', kind: SOURCE_KIND },
          { bind: 'sink', kind: SINK_KIND },
          {
            tool: ['A ', { kind: BELT_KIND }, ' can carry on from its free end. Click ', { kind: BELT_KIND }, ' in the palette.'],
            carryOn: ['That ', { kind: BELT_KIND }, ' stops short of the ', { kind: SINK_KIND }, '. Drag from the ring past its end down to the ', { kind: SINK_KIND }, "'s input dot."],
            // The shipped words say "until it's gone", which a sealed stub never is.
            undo: ['That ', { kind: BELT_KIND }, " can't be carried on from its end. Press ", { key: 'undo' }, ' until it stops short of the ', { kind: SINK_KIND }, ' again.'],
            carryOnCoach: {
              // A press on the stub's last tile, one cell short of the ring.
              BeltEndTile: ['The ring is one cell past the ', { kind: BELT_KIND }, "'s last tile. Press there and drag down to the ", { kind: SINK_KIND }, '.'],
            },
          },
        ),
      ],
      done: { is: 'lineTurnsAt', a: 'source', b: 'sink', bind: 'belt' },
    },
    {
      id: 'press-play',
      stages: PRESS_PLAY_STAGES,
      done: { is: 'tickRose' },
    },
    {
      id: 'watch',
      stages: [BOARD_PAUSED, watchStage(['Watch the dots ride round the corner into the ', { kind: SINK_KIND }, '.'])],
      done: { is: 'itemArrived', at: 'sink' },
    },
  ],
  closing: ['A ', { kind: BELT_KIND }, ' can carry on from its end, and the tile where it turns becomes a corner.'],
  // A press on the stub's last tile with the Belt tool armed, one cell short of the ring.
  refused: {
    atStep: 'join-belt',
    atStage: 'belt-carry-on',
    press: { on: 'lineEnd', from: 'source' },
    tag: 'BeltEndTile',
  },
};
