import { describe, expect, it } from 'vitest';
import { beltTiles, TILE_INSET, type BeltTile, type CanvasBox, type ProbeRect, type TileScene } from './probe';

// World px to screen px at scale 0.5 with the board's origin at (10, 20) on the canvas, so a 32 px
// cell is 16 screen px.
const SCALE = 0.5;
const toScreen = (wx: number, wy: number): { x: number; y: number } => ({ x: wx * SCALE + 10, y: wy * SCALE + 20 });
const CANVAS: CanvasBox = { left: 100, top: 200, right: 900, bottom: 700 };
const VIEW: CanvasBox = { left: 0, top: 0, right: 1280, bottom: 900 };
const SIDE = 32 * SCALE;
const IN = SIDE * TILE_INSET;

/** The inset screen box of cell (x, y) on CANVAS. */
const tile = (x: number, y: number): BeltTile => ({
  x: 100 + 10 + x * SIDE + IN,
  y: 200 + 20 + y * SIDE + IN,
  width: SIDE - 2 * IN,
  height: SIDE - 2 * IN,
  cellX: x,
  cellY: y,
});

/** Boxes rounded to 1/1000 px, so float sums compare equal. */
const round = (rs: BeltTile[]): BeltTile[] =>
  rs.map((r) => ({
    ...r,
    x: Math.round(r.x * 1000) / 1000,
    y: Math.round(r.y * 1000) / 1000,
    width: Math.round(r.width * 1000) / 1000,
    height: Math.round(r.height * 1000) / 1000,
  }));

const row = (y: number, xs: number[]): { cell_x: number; cell_y: number }[] => xs.map((x) => ({ cell_x: x, cell_y: y }));

const scene = (over: Partial<TileScene> = {}): TileScene => ({
  belts: new Map(),
  nodes: new Map(),
  wires: new Map(),
  ...over,
});

describe('beltTiles', () => {
  it('is empty for a scene with no belt', () => {
    expect(round(beltTiles(scene(), toScreen, CANVAS, VIEW, []))).toEqual(round([]));
  });

  it('gives every tile of every belt, in handle order then path order, inset on each side', () => {
    const s = scene({
      belts: new Map([
        [7, { tiles: row(2, [5, 6]) }],
        [3, { tiles: row(0, [1, 2, 3]) }],
      ]),
    });
    expect(round(beltTiles(s, toScreen, CANVAS, VIEW, []))).toEqual(round([tile(1, 0), tile(2, 0), tile(3, 0), tile(5, 2), tile(6, 2)]));
  });

  it('leaves out cells under a machine footprint, with a rotated footprint swapping its sides', () => {
    const s = scene({
      belts: new Map([[1, { tiles: row(4, [0, 1, 2, 3, 4, 5]) }]]),
      // 1 wide and 2 tall at rot 1 covers cells (1,4) and (2,4).
      nodes: new Map([[2, { cell_x: 1, cell_y: 4, w: 1, h: 2, rot: 1 }]]),
    });
    expect(round(beltTiles(s, toScreen, CANVAS, VIEW, []))).toEqual(round([tile(0, 4), tile(3, 4), tile(4, 4), tile(5, 4)]));
  });

  it("leaves out cells on a cable's path", () => {
    const s = scene({
      belts: new Map([[1, { tiles: row(1, [0, 1, 2]) }]]),
      wires: new Map([[9, { path: [{ cell_x: 1, cell_y: 1 }, { cell_x: 1, cell_y: 2 }] }]]),
    });
    expect(round(beltTiles(s, toScreen, CANVAS, VIEW, []))).toEqual(round([tile(0, 1), tile(2, 1)]));
  });

  it('leaves out a tile whose whole box touches an overlay element, inset or not', () => {
    const s = scene({ belts: new Map([[1, { tiles: row(0, [0, 1, 2]) }]]) });
    // A chip that covers only the outer 1 px of cell 1's left edge still removes cell 1.
    const chip: ProbeRect = { x: 100 + 10 + SIDE, y: 200 + 20, width: 1, height: 4 };
    expect(round(beltTiles(s, toScreen, CANVAS, VIEW, [chip]))).toEqual(round([tile(0, 0), tile(2, 0)]));
  });

  it('clips a tile to the canvas and leaves out one with under 2 px left', () => {
    const s = scene({ belts: new Map([[1, { tiles: row(0, [0, 1]) }]]) });
    const right = 100 + 10 + SIDE + IN + 5;
    const narrow: CanvasBox = { ...CANVAS, right };
    expect(round(beltTiles(s, toScreen, narrow, VIEW, []))).toEqual(round([tile(0, 0), { ...tile(1, 0), width: 5 }]));
    const cut: CanvasBox = { ...CANVAS, right: 100 + 10 + SIDE + IN + 1 };
    expect(round(beltTiles(s, toScreen, cut, VIEW, []))).toEqual(round([tile(0, 0)]));
  });

  it('keeps the canvas as the origin when the canvas starts above the viewport, and drops tiles above it', () => {
    const s = scene({ belts: new Map([[1, { tiles: [{ cell_x: 0, cell_y: 0 }, { cell_x: 0, cell_y: 20 }, { cell_x: 0, cell_y: 40 }] }]]) });
    // The canvas's top is 300 px above the viewport. Row 0 is off screen, row 20 sits at
    // -300 + 20 + 20 * 16 = 40 px and row 40 at 360 px.
    const above: CanvasBox = { left: 100, top: -300, right: 900, bottom: 500 };
    const want = (y: number): BeltTile => ({ ...tile(0, y), y: -300 + 20 + y * SIDE + IN });
    expect(round(beltTiles(s, toScreen, above, VIEW, []))).toEqual(round([want(20), want(40)]));
    // A view whose bottom leaves 1 px of row 40's inner part drops that tile.
    const short: CanvasBox = { left: 0, top: 0, right: 1280, bottom: 360 + IN + 1 };
    expect(round(beltTiles(s, toScreen, above, short, []))).toEqual(round([want(20)]));
  });

  it('counts a cell two belts share once', () => {
    const s = scene({
      belts: new Map([
        [1, { tiles: row(0, [0, 1]) }],
        [2, { tiles: row(0, [1, 2]) }],
      ]),
    });
    expect(round(beltTiles(s, toScreen, CANVAS, VIEW, []))).toEqual(round([tile(0, 0), tile(1, 0), tile(2, 0)]));
  });
});
