// @vitest-environment jsdom
//
// plotRead.ts, on REAL Pixi (no mock), and the overlay probe that reads through it (review fix
// IN-B-06). The last case is the red one: it was run at a pre-release revision, where `rejectFlashCell` cast its
// own way into the instructions and `continue`d past a fill it could not read, so a changed Pixi
// layout read as "no flash" (`89-REVIEW-DISPOSITION.md`, IN-B-06).

import { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { SceneState } from './sceneState';
import { createOverlay } from './layers/overlay';

/** A frozen, empty scene; the flash never reads it. */
const scene = (): (() => SceneState) => {
  const s = { tick: 0, nodes: new Map(), belts: new Map() } as unknown as SceneState;
  return () => s;
};

/** The reject flash's z-slot in `createOverlay`'s child list (overlay.plot.test.ts keeps the same). */
const REJECT_FLASH_IDX = 5;

/** Strip the shape path off every fill instruction, the shape a Pixi layout change takes. */
function dropFillPaths(g: Graphics): number {
  let n = 0;
  for (const ins of g.context.instructions) {
    if (ins.action === 'fill') {
      delete (ins.data as unknown as { path?: unknown }).path;
      n += 1;
    }
  }
  return n;
}

describe('plotRead on real Pixi', () => {
  it('reads circles, rectangles and a polyline back off the instructions', async () => {
    const { plottedCircles, plottedFilledRects, plottedInstructions, plottedPolylines } = await import('./plotRead');
    const g = new Graphics();
    g.circle(10, 20, 5).stroke({ width: 1, color: 0x112233 });
    g.circle(30, 40, 3).fill({ color: 0x445566 });
    g.roundRect(64, 96, 32, 32, 4).fill({ color: 0x778899 });
    g.rect(0, 0, 8, 8).fill({ color: 0xabcdef });
    g.moveTo(1, 2).lineTo(3, 4).lineTo(5, 6).stroke({ width: 2, color: 0x010203 });
    expect(plottedCircles(g)).toEqual([
      { x: 10, y: 20, action: 'stroke', color: 0x112233 },
      { x: 30, y: 40, action: 'fill', color: 0x445566 },
    ]);
    expect(plottedFilledRects(g)).toEqual([
      { x: 64, y: 96, w: 32, h: 32, color: 0x778899 },
      { x: 0, y: 0, w: 8, h: 8, color: 0xabcdef },
    ]);
    expect(plottedInstructions(g).map((i) => [i.action, i.color, i.primitives])).toEqual([
      ['stroke', 0x112233, 1],
      ['fill', 0x445566, 1],
      ['fill', 0x778899, 1],
      ['fill', 0xabcdef, 1],
      ['stroke', 0x010203, 1],
    ]);
    expect(plottedPolylines(g)).toEqual([
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
    ]);
  });

  it('reads nothing off an empty Graphics', async () => {
    const { plottedShapes } = await import('./plotRead');
    expect(plottedShapes(new Graphics())).toEqual([]);
  });

  it('throws on a fill instruction that does not carry the layout it reads', async () => {
    const { plottedShapes } = await import('./plotRead');
    const g = new Graphics();
    g.rect(0, 0, 8, 8).fill({ color: 0xff0000 });
    expect(dropFillPaths(g), 'PRECONDITION: one fill to break').toBe(1);
    expect(() => plottedShapes(g)).toThrow(/layout changed/);
  });
});

describe('an overlay probe fails loud when it cannot read the plot', () => {
  it('rejectFlashCell throws, never answers "no flash", on a flash whose layout it cannot read', () => {
    const api = createOverlay(scene());
    api.showRejectFlash({ cx: 4, cy: 4 }, { w: 1, h: 1, rot: 0 });
    expect(api.rejectFlashCell(), 'PRECONDITION: the flash is plotted and read').toEqual({ cx: 4, cy: 4 });
    const g = api.layer.children[REJECT_FLASH_IDX] as unknown as Graphics;
    expect(dropFillPaths(g), 'PRECONDITION: the flash has a fill to break').toBeGreaterThan(0);
    expect(() => api.rejectFlashCell()).toThrow(/layout changed/);
  });
});
