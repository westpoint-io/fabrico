// THE DRAWN-CABLE GRADER ON REAL POLYLINES (the 77-01 refuter round, phase 77 D-04).
//
// `e2e-live/support/cableTrace.ts` says whether each cable the wire layer drew lies on the cells
// the model routed it on. Leg 1 of the composed walk (`TWO CABLES DRAWN`) and leg 5 (`CABLE DRAWN
// ON THE CANVAS`) read it. The ACCEPTS cases use the exact cells and drawn polylines a live run of
// the walk logged at a pre-release revision (`COMP_LEG1_CABLES` and `COMP_LEG1_DRAWN`, leg 1's Route at (8,8)
// and HTTP Handler at (12,7)), so the slack is proved against the real lane offset and the real
// nub overhang, not a drawing written to fit. The REFUSES cases are the defects the grader exists
// to see, the first of them refuter 1's: every cable stroked 96 px (three cells) below its route,
// which the count and leg 5's drawn-against-drawn compare both passed.
//
// Lives under `src/` because `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}` only.

import { describe, expect, it } from 'vitest';
import {
  followsCells,
  gradeDrawnCables,
  samplePolyline,
  type ModelCable,
  type WorldPoint,
} from '../../e2e-live/support/cableTrace';

const CELL = 32;

/** `COMP_LEG1_CABLES`, logged by leg 1 on an unmodified build. */
const FORWARD: ModelCable = {
  key: '8,8:1 -> 12,7:0',
  cells: [
    [8, 8],
    [9, 8],
    [10, 8],
    [11, 8],
    [12, 8],
  ],
};
const RETURN: ModelCable = {
  key: '12,7:1 -> 8,8:0',
  cells: [
    [14, 8],
    [15, 8],
    [15, 9],
    [15, 10],
    [14, 10],
    [13, 10],
    [12, 10],
    [11, 10],
    [10, 10],
    [9, 10],
    [8, 10],
    [7, 10],
    [7, 9],
    [7, 8],
    [8, 8],
  ],
};

/** Parse one `COMP_LEG1_DRAWN` entry, `x,y x,y ...`. */
const parse = (s: string): WorldPoint[] =>
  s.split(' ').map((p) => {
    const [x, y] = p.split(',').map(Number);
    return { x, y };
  });

/** `COMP_LEG1_DRAWN`, logged in the same run: the forward and the return leg as stroked. */
const DRAWN_FORWARD = parse('288.5,274 304,274 336,274 368,274 383.5,274');
const DRAWN_RETURN = parse(
  '480.5,270 494,270 494,304 494,334 464,334 432,334 400,334 368,334 336,334 304,334 272,334 238,334 238,304 238,270 255.5,270',
);

const shift = (pl: readonly WorldPoint[], dx: number, dy: number): WorldPoint[] =>
  pl.map((p) => ({ x: p.x + dx, y: p.y + dy }));

const CLEAN = { drawn: 2, model: 2, unmatchedModel: [], strayDrawn: 0 };

describe('cableTrace - the drawn cables graded against the routed cells', () => {
  it('samples a polyline at most one world pixel apart, vertices included', () => {
    const s = samplePolyline([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2 },
    ]);
    expect(s.map((p) => `${p.x},${p.y}`)).toEqual(['0,0', '1,0', '2,0', '3,0', '3,1', '3,2']);
  });

  it('ACCEPTS the two cables leg 1 drew on a correct build, in either order', () => {
    expect(followsCells(DRAWN_FORWARD, FORWARD.cells, CELL)).toBe(true);
    expect(followsCells(DRAWN_RETURN, RETURN.cells, CELL)).toBe(true);
    expect(gradeDrawnCables([DRAWN_FORWARD, DRAWN_RETURN], [FORWARD, RETURN], CELL)).toEqual(CLEAN);
    expect(gradeDrawnCables([DRAWN_RETURN, DRAWN_FORWARD], [FORWARD, RETURN], CELL)).toEqual(CLEAN);
  });

  it('REFUSES every cable drawn three cells below its route (refuter 1, +96 on each stroked y)', () => {
    const grade = gradeDrawnCables(
      [shift(DRAWN_FORWARD, 0, 96), shift(DRAWN_RETURN, 0, 96)],
      [FORWARD, RETURN],
      CELL,
    );
    expect(grade).toEqual({ drawn: 2, model: 2, unmatchedModel: [FORWARD.key, RETURN.key].sort(), strayDrawn: 2 });
  });

  it('REFUSES a cable drawn ONE cell off its route, on either axis', () => {
    for (const [dx, dy] of [
      [0, CELL],
      [0, -CELL],
      [CELL, 0],
      [-CELL, 0],
    ]) {
      expect(followsCells(shift(DRAWN_FORWARD, dx, dy), FORWARD.cells, CELL), `${dx},${dy}`).toBe(false);
    }
  });

  it('REFUSES a cable cut short: the return leg stopping at the bottom corner', () => {
    const half = DRAWN_RETURN.slice(0, 5);
    expect(followsCells(half, RETURN.cells, CELL)).toBe(false);
    expect(gradeDrawnCables([DRAWN_FORWARD, half], [FORWARD, RETURN], CELL)).toEqual({
      drawn: 2,
      model: 2,
      unmatchedModel: [RETURN.key],
      strayDrawn: 1,
    });
  });

  it('REFUSES a cable that visits every one of its cells but detours three cells off its route', () => {
    // Every routed cell is still visited (rule 2 holds); the excursion leaves the cells (rule 1).
    const detour = [
      { x: 288.5, y: 274 },
      { x: 336, y: 274 },
      { x: 336, y: 370 },
      { x: 336, y: 274 },
      { x: 383.5, y: 274 },
    ];
    expect(followsCells(detour, FORWARD.cells, CELL)).toBe(false);
  });

  it('REFUSES one drawing standing in for both cables (two strokes, one route)', () => {
    expect(gradeDrawnCables([DRAWN_FORWARD, DRAWN_FORWARD], [FORWARD, RETURN], CELL)).toEqual({
      drawn: 2,
      model: 2,
      unmatchedModel: [RETURN.key],
      strayDrawn: 1,
    });
  });

  it('REFUSES a wire layer that drew nothing, and a stray stroke beside a correct pair', () => {
    expect(gradeDrawnCables([], [FORWARD, RETURN], CELL)).toEqual({
      drawn: 0,
      model: 2,
      unmatchedModel: [FORWARD.key, RETURN.key].sort(),
      strayDrawn: 0,
    });
    expect(
      gradeDrawnCables([DRAWN_FORWARD, DRAWN_RETURN, shift(DRAWN_FORWARD, 0, 3 * CELL)], [FORWARD, RETURN], CELL),
    ).toEqual({ drawn: 3, model: 2, unmatchedModel: [], strayDrawn: 1 });
  });

  it('follows nothing with a single point or no cells', () => {
    expect(followsCells([DRAWN_FORWARD[0]], FORWARD.cells, CELL)).toBe(false);
    expect(followsCells(DRAWN_FORWARD, [], CELL)).toBe(false);
  });
});
