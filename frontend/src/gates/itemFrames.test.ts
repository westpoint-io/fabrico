// itemFrames.test.ts - the pure grader of the DRAWN items against the model AT THE TICK THEY WERE
// DRAWN FROM (plan 77-04, phase 77 D-04, the 77-04 review blocker).
//
// Leg 4 grades "items running past the label" on the canvas as well as on the model. On a flowing
// belt the model runs ahead of the canvas: the recorder copies the model at tick T while the item
// layer last drew the scene of T-1 (or earlier), and an item that crossed a tile edge in between
// reads as a mismatch on a correct build. So every drawn frame is compared with the RECORD of the
// tick it was drawn from, never with the record that carried it. These cases pin that, its
// refusals, and the counts the leg's assertion reads.
//
// Lives under `src/` because `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}` only.

import { describe, expect, it } from 'vitest';
import {
  drawnItemsLine,
  drawnItemsPerCell,
  gradeDrawnItems,
  modelItemsPerCell,
  type ItemFrameRecord,
  type WatchedBelt,
} from '../../e2e-live/support/itemFrames';

const CELL = 32;
/** One three-tile belt, tail (2,5) to head (4,5): twelve slots, slot 0 at the head. */
const BELT: WatchedBelt = {
  id: 7,
  cells: [
    [2, 5],
    [3, 5],
    [4, 5],
  ],
};

/** A dot inside cell (cx, cy), off the tile edges. */
function dotIn(cx: number, cy: number, dx = 0): [number, number] {
  return [cx * CELL + 10 + dx, cy * CELL + 16];
}

/** A record at tick `t` holding `slots` on the belt, optionally carrying a drawn frame. */
function rec(t: number, slots: number[], d?: ItemFrameRecord['d']): ItemFrameRecord {
  return { t, belts: [[BELT.id, 2, slots, []]], ...(d === undefined ? {} : { d }) };
}

describe('the drawn items graded by the tick they were drawn from (plan 77-04)', () => {
  it('modelItemsPerCell: occupied slots land in their tiles, counted from the tail', () => {
    // Slots 0 and 1 are in the head tile (4,5); slot 11 is in the tail tile (2,5).
    expect(modelItemsPerCell(rec(1, [0, 1, 11]), [BELT])).toEqual({ '2,5': 1, '3,5': 0, '4,5': 2 });
  });

  it('drawnItemsPerCell: every watched cell present, dots outside the watched cells ignored', () => {
    expect(drawnItemsPerCell([dotIn(3, 5), dotIn(3, 5, 6), dotIn(9, 9)], [BELT], CELL)).toEqual({
      '2,5': 0,
      '3,5': 2,
      '4,5': 0,
    });
  });

  it('ALIGNS a frame drawn from the tick before the record that carried it', () => {
    // Tick 10: slot 4, in the middle tile (3,5). Tick 11: slot 3, in the head tile (4,5). The
    // record of tick 11 carries the frame drawn from tick 10, which plots the dot in (3,5).
    const records = [rec(10, [4]), rec(11, [3], { drawnAtTick: 10, dots: [dotIn(3, 5)] })];
    const g = gradeDrawnItems(records, [BELT], CELL);
    expect(g).toMatchObject({ frames: 1, aligned: 1, unaligned: 0, matched: 1, matchedWithItems: 1 });
    expect(g.mismatches).toEqual([]);
  });

  it('REFUSES a frame whose dots disagree with the model of its own drawn tick', () => {
    // The frame claims tick 10, whose model holds the item in (3,5), but plots it in (4,5).
    const records = [rec(10, [4]), rec(11, [3], { drawnAtTick: 10, dots: [dotIn(4, 5)] })];
    const g = gradeDrawnItems(records, [BELT], CELL);
    expect(g).toMatchObject({ aligned: 1, matched: 0, matchedWithItems: 0 });
    expect(g.mismatches).toEqual([
      {
        drawnAtTick: 10,
        drawn: { '2,5': 0, '3,5': 0, '4,5': 1 },
        model: { '2,5': 0, '3,5': 1, '4,5': 0 },
      },
    ]);
  });

  it('REFUSES a blank item layer over a model that holds items', () => {
    const records = [
      rec(10, [0, 4, 8], { drawnAtTick: 10, dots: [] }),
      rec(11, [0, 3, 7], { drawnAtTick: 11, dots: [] }),
    ];
    const g = gradeDrawnItems(records, [BELT], CELL);
    expect(g).toMatchObject({ frames: 2, aligned: 2, matched: 0, matchedWithItems: 0, distinctDrawn: 1 });
  });

  it('does not grade a frame whose drawn tick the recorder missed (unaligned), and never against the carrying record', () => {
    // Tick 10 was never recorded. Graded against the carrying record (tick 11) the frame would
    // match by accident; it must be set aside instead.
    const records = [rec(11, [3], { drawnAtTick: 10, dots: [dotIn(4, 5)] })];
    const g = gradeDrawnItems(records, [BELT], CELL);
    expect(g).toMatchObject({ frames: 1, aligned: 0, unaligned: 1, matched: 0 });
  });

  it('counts each drawn tick once, and sets aside a record with no frame or a frame never drawn', () => {
    const f = { drawnAtTick: 10, dots: [dotIn(3, 5)] };
    const records = [
      rec(9, [8]),
      rec(10, [4], f),
      rec(11, [3], f),
      rec(12, [2]),
      rec(13, [1], { drawnAtTick: null, dots: [] }),
    ];
    const g = gradeDrawnItems(records, [BELT], CELL);
    expect(g).toMatchObject({ frames: 1, aligned: 1, matched: 1 });
  });

  it('a frame matching an EMPTY model counts as matched but not as matched with items', () => {
    const records = [rec(10, [], { drawnAtTick: 10, dots: [] })];
    expect(gradeDrawnItems(records, [BELT], CELL)).toMatchObject({ matched: 1, matchedWithItems: 0 });
  });

  it('distinctDrawn counts the distinct drawn dot sets on the watched cells, rounded to 1 px', () => {
    const records = [
      rec(10, [8], { drawnAtTick: 10, dots: [dotIn(3, 5)] }),
      rec(11, [7], { drawnAtTick: 11, dots: [[3 * CELL + 10.2, 5 * CELL + 16]] }),
      rec(12, [4], { drawnAtTick: 12, dots: [dotIn(3, 5, 8)] }),
      rec(13, [3], { drawnAtTick: 13, dots: [dotIn(4, 5)] }),
    ];
    // Ticks 10 and 11 round to the same set; 12 and 13 are new.
    expect(gradeDrawnItems(records, [BELT], CELL).distinctDrawn).toBe(3);
  });

  it('drawnItemsLine names every count the leg logs', () => {
    const records = [rec(10, [4]), rec(11, [3], { drawnAtTick: 10, dots: [dotIn(3, 5)] })];
    expect(drawnItemsLine(gradeDrawnItems(records, [BELT], CELL))).toBe(
      'ITEM_FRAMES frames=1 aligned=1 unaligned=0 matched=1 matchedWithItems=1 distinct=1 rate=1.000',
    );
  });
});
