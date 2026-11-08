// view.test.ts - the off-screen test, the off-screen flag's rule and the Show me camera, as plain
// arithmetic (HINT-03, 103 review IN-01).

import { describe, expect, it } from 'vitest';
import { frameTarget, offScreen, offScreenFlag } from './view.ts';

const FREE = { left: 200, right: 800, top: 100, bottom: 500 };
const MIN_ZOOM = 0.25;

describe('offScreen: no shared area with the free area', () => {
  it('is false for a rect fully inside', () => {
    expect(offScreen({ x: 300, y: 200, width: 72, height: 72 }, FREE)).toBe(false);
  });

  it('is false for a rect that overlaps partly, on each side', () => {
    expect(offScreen({ x: 170, y: 200, width: 72, height: 72 }, FREE)).toBe(false);
    expect(offScreen({ x: 760, y: 200, width: 72, height: 72 }, FREE)).toBe(false);
    expect(offScreen({ x: 300, y: 70, width: 72, height: 72 }, FREE)).toBe(false);
    expect(offScreen({ x: 300, y: 460, width: 72, height: 72 }, FREE)).toBe(false);
  });

  it('is true for a rect wholly left, right, above or below', () => {
    expect(offScreen({ x: 40, y: 200, width: 72, height: 72 }, FREE)).toBe(true);
    expect(offScreen({ x: 900, y: 200, width: 72, height: 72 }, FREE)).toBe(true);
    expect(offScreen({ x: 300, y: 0, width: 72, height: 72 }, FREE)).toBe(true);
    expect(offScreen({ x: 300, y: 600, width: 72, height: 72 }, FREE)).toBe(true);
  });

  it('is true for a rect that only touches an edge', () => {
    expect(offScreen({ x: 128, y: 200, width: 72, height: 72 }, FREE)).toBe(true);
    expect(offScreen({ x: 800, y: 200, width: 72, height: 72 }, FREE)).toBe(true);
    expect(offScreen({ x: 300, y: 28, width: 72, height: 72 }, FREE)).toBe(true);
    expect(offScreen({ x: 300, y: 500, width: 72, height: 72 }, FREE)).toBe(true);
  });
});

describe('offScreenFlag: one frame of the flag, from the ring\'s two stage keys', () => {
  const SHOWN = '8:belt-draw';
  const BEFORE = '8:belt-tool';
  const IN_VIEW = { x: 300, y: 200, width: 72, height: 72 };
  const OUT = { x: 900, y: 200, width: 72, height: 72 };
  const flag = (over: Partial<Parameters<typeof offScreenFlag>[0]>): boolean =>
    offScreenFlag({ shownKey: SHOWN, placedKey: SHOWN, triedKey: SHOWN, rects: [IN_VIEW], free: FREE, last: false, ...over });

  it('is false with no shown stage, or a panel stage the caller passes as none, whatever the ring and the last frame say', () => {
    expect(flag({ shownKey: null, rects: [OUT], last: true })).toBe(false);
    expect(flag({ shownKey: null, placedKey: null, triedKey: null, rects: null, last: true })).toBe(false);
  });

  it('reads the rings placed for the shown stage, whatever the last frame said', () => {
    expect(flag({ rects: [IN_VIEW], last: true })).toBe(false);
    expect(flag({ rects: [OUT], last: false })).toBe(true);
    // A drag: one ring out of view is enough for the row.
    expect(flag({ rects: [IN_VIEW, OUT], last: false })).toBe(true);
  });

  it('is false once the ring has tried the shown stage and found no box, even after a frame that said true', () => {
    expect(flag({ placedKey: null, triedKey: SHOWN, rects: null, last: true })).toBe(false);
  });

  it('keeps the last value while the ring still names the previous stage', () => {
    for (const last of [true, false]) {
      expect(flag({ placedKey: BEFORE, triedKey: BEFORE, rects: null, last })).toBe(last);
      // Hidden for the previous stage, or never painted yet.
      expect(flag({ placedKey: null, triedKey: BEFORE, rects: null, last })).toBe(last);
      expect(flag({ placedKey: null, triedKey: null, rects: null, last })).toBe(last);
    }
  });

  it('never reads a rect placed for an older stage, which belongs to that stage', () => {
    for (const last of [true, false]) expect(flag({ placedKey: BEFORE, triedKey: BEFORE, rects: [last ? IN_VIEW : OUT], last })).toBe(last);
  });
});

/** Where the box's centre lands on screen under `cam`. */
function centreOnScreen(box: { x: number; y: number; w: number; h: number }, cam: { x: number; y: number; scale: number }): { x: number; y: number } {
  return { x: (box.x + box.w / 2) * cam.scale + cam.x, y: (box.y + box.h / 2) * cam.scale + cam.y };
}

describe('frameTarget: centre the box in the free area, zoom out only when it must', () => {
  for (const scale of [0.5, 2]) {
    it(`keeps the zoom at ${scale} when the box plus the margin fits, and centres it`, () => {
      const box = { x: 1000, y: -400, w: 64, h: 40 };
      const cam = frameTarget(box, FREE, { x: -3000, y: 900, scale }, MIN_ZOOM);
      expect(cam.scale).toBe(scale);
      expect(centreOnScreen(box, cam)).toEqual({ x: 500, y: 300 });
    });
  }

  it('fits exactly at the margin without zooming', () => {
    // 600 - 96 = 504 wide and 400 - 96 = 304 tall at scale 2.
    const box = { x: 0, y: 0, w: 252, h: 152 };
    expect(frameTarget(box, FREE, { x: 0, y: 0, scale: 2 }, MIN_ZOOM).scale).toBe(2);
  });

  it('zooms out to the largest scale that fits when the box does not', () => {
    const box = { x: 0, y: 0, w: 400, h: 100 };
    const cam = frameTarget(box, FREE, { x: 0, y: 0, scale: 4 }, MIN_ZOOM);
    expect(cam.scale).toBeCloseTo(504 / 400, 10);
    expect(box.w * cam.scale).toBeLessThanOrEqual(FREE.right - FREE.left - 96 + 1e-9);
    const c = centreOnScreen(box, cam);
    expect(c.x).toBeCloseTo(500, 9);
    expect(c.y).toBeCloseTo(300, 9);
  });

  it('takes the tighter of width and height', () => {
    const box = { x: 0, y: 0, w: 100, h: 608 };
    expect(frameTarget(box, FREE, { x: 0, y: 0, scale: 2 }, MIN_ZOOM).scale).toBeCloseTo(304 / 608, 10);
  });

  it('never goes below the minimum zoom it is given', () => {
    const box = { x: 0, y: 0, w: 100_000, h: 50 };
    const cam = frameTarget(box, FREE, { x: 0, y: 0, scale: 1 }, MIN_ZOOM);
    expect(cam.scale).toBe(MIN_ZOOM);
    expect(centreOnScreen(box, cam).x).toBeCloseTo(500, 9);
  });

  it('never zooms in above the current zoom', () => {
    const box = { x: 0, y: 0, w: 4000, h: 40 };
    // At 0.1 it already fits: the clamp keeps 0.1 rather than lifting it to the floor of 0.25.
    expect(frameTarget(box, FREE, { x: 0, y: 0, scale: 0.1 }, MIN_ZOOM).scale).toBe(0.1);
  });
});
