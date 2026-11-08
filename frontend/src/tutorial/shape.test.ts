import { describe, expect, it } from 'vitest';
import { beltTilesIn, boardShape, sameShape, stableJson } from './shape.ts';
import type { BoardBelt, BoardFacts, BoardNode } from './types.ts';

const SOURCE = 0;
const SINK = 7;
const STRAIGHT = { Straight: { axis: 0 } };

function source(id: number): BoardNode {
  return { id, kind: SOURCE, cells: [[2, 2]], ports: [{ index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1 }] };
}

/** A Sink at (8, 2): its fault on the south side and its input on the west, or turned, on the north and east. */
function sink(id: number, turned = false): BoardNode {
  return {
    id,
    kind: SINK,
    cells: [[8, 2]],
    ports: [
      { index: 0, cell_x: 8, cell_y: 2, side: turned ? 0 : 2, role: 2 },
      { index: 1, cell_x: 8, cell_y: 2, side: turned ? 1 : 3, role: 0 },
    ],
  };
}

function belt(id: number, from: number, to: number, over: Partial<BoardBelt> = {}): BoardBelt {
  return {
    id,
    items: 0,
    occupiedSlots: [],
    tiles: [3, 4, 5, 6, 7].map((x) => ({ cell_x: x, cell_y: 2, kind: STRAIGHT })),
    docks: [
      { end: 'Tail', node: from, port: 0 },
      { end: 'Head', node: to, port: 1 },
    ],
    ...over,
  };
}

function line(ids: { source: number; sink: number; belt: number }, over: Partial<BoardBelt> = {}, turned = false): Pick<BoardFacts, 'nodes' | 'belts'> {
  return { nodes: [source(ids.source), sink(ids.sink, turned)], belts: [belt(ids.belt, ids.source, ids.sink, over)] };
}

const BEFORE = line({ source: 4, sink: 5, belt: 9 });

describe('boardShape', () => {
  it('reads the same for the same line under re-minted handles, so Undo can match it', () => {
    const after = line({ source: 40, sink: 41, belt: 42 });
    expect(sameShape(boardShape(after), boardShape(BEFORE))).toBe(true);
    // Handles in a different order on the board change nothing either.
    const shuffled = { nodes: [...after.nodes].reverse(), belts: after.belts };
    expect(sameShape(boardShape(shuffled), boardShape(BEFORE))).toBe(true);
  });

  it('holds no handle anywhere', () => {
    const text = stableJson(boardShape(line({ source: 1234, sink: 5678, belt: 9012 })));
    for (const handle of ['1234', '5678', '9012']) expect(text).not.toContain(handle);
  });

  it('reads a different shape for a turned Sink, whose ports sit on other sides', () => {
    const turned = line({ source: 40, sink: 41, belt: 42 }, {}, true);
    expect(sameShape(boardShape(turned), boardShape(BEFORE))).toBe(false);
  });

  it("reads a different shape for a belt whose Head docks another port", () => {
    const other = line({ source: 40, sink: 41, belt: 42 }, {
      docks: [
        { end: 'Tail', node: 40, port: 0 },
        { end: 'Head', node: 41, port: 0 },
      ],
    });
    expect(sameShape(boardShape(other), boardShape(BEFORE))).toBe(false);
  });

  it('reads a different shape for a belt with its Head dock missing', () => {
    const loose = line({ source: 40, sink: 41, belt: 42 }, { docks: [{ end: 'Tail', node: 40, port: 0 }] });
    expect(sameShape(boardShape(loose), boardShape(BEFORE))).toBe(false);
  });

  it('reads a different shape for a tile of another kind', () => {
    const tiles = BEFORE.belts[0]!.tiles.map((t, i) => (i === 4 ? { ...t, kind: { Corner: { from: 0, to: 1 } } } : t));
    expect(sameShape(boardShape(line({ source: 4, sink: 5, belt: 9 }, { tiles })), boardShape(BEFORE))).toBe(false);
  });

  it('reads the same shape for a belt carrying items as for an empty one', () => {
    const full = line({ source: 40, sink: 41, belt: 42 }, { items: 3, occupiedSlots: [0, 2, 4] });
    expect(sameShape(boardShape(full), boardShape(BEFORE))).toBe(true);
  });

  it('writes a tile kind the same whatever order its keys came in', () => {
    expect(stableJson({ Corner: { to: 1, from: 0 } })).toBe(stableJson({ Corner: { from: 0, to: 1 } }));
  });
});

describe('beltTilesIn', () => {
  it("finds the belt docked to both machines by their keys, and nothing for a pair it doesn't join", () => {
    const shape = boardShape(BEFORE);
    expect(beltTilesIn(shape, '0@2,2', '7@8,2')?.map((t) => t.cell_x)).toEqual([3, 4, 5, 6, 7]);
    expect(beltTilesIn(shape, '0@2,2', '7@9,9')).toBeNull();
  });
});
