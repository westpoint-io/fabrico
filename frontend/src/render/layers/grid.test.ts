import { describe, expect, it, vi } from 'vitest';

// NAV-06 grid level-of-detail (LOD) contract. This suite is GPU-free: it mocks
// `pixi.js` with tiny counting Container/Graphics fakes (the grid layer only needs
// Container + Graphics) so the minor stroke pass (width 1/scale) can be told apart
// from the major stroke pass (width 1.5/scale) with no real renderer, canvas, or
// WebGL. It pins the contract Task 2 implements: minor guide lines are omitted when
// an on-screen cell shrinks below 10px (scale * CELL < 10), while major orientation
// lines are always drawn.

vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = [];
    constructor(_opts?: unknown) {}
    addChild(...c: unknown[]): unknown {
      this.children.push(...c);
      return c[0];
    }
  }
  // Records every stroke (width + colour) and counts the point-plotting calls, so a
  // test can distinguish the minor pass from the major pass and confirm nothing is
  // plotted when a pass is skipped.
  class Graphics {
    strokes: Array<{ width: number; color: number }> = [];
    moveToCount = 0;
    lineToCount = 0;
    clear(): this {
      return this;
    }
    rect(): this {
      return this;
    }
    fill(): this {
      return this;
    }
    moveTo(): this {
      this.moveToCount++;
      return this;
    }
    lineTo(): this {
      this.lineToCount++;
      return this;
    }
    stroke(opts: { width: number; color: number }): this {
      this.strokes.push(opts);
      return this;
    }
  }
  return { Container, Graphics };
});

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is safe).
const { createGridLayer } = await import('./grid.ts');

// CELL=32 (shared/geometry). Thresholds below are on-screen cell pixels = scale*CELL.

/** A minimal fake Camera exposing just what grid.redraw reads: a mutable
 *  container.scale.x and a linear screenToWorld inverse (pan 0) so the visible
 *  cell loop covers a small, deterministic column/row range. */
function fakeCam(scale: number): unknown {
  return {
    container: { scale: { x: scale } },
    screenToWorld: (sx: number, sy: number): { x: number; y: number } => ({
      x: sx / scale,
      y: sy / scale,
    }),
  };
}

/** The `lines` Graphics is the second child of the layer Container (floor is first). */
function recordedStrokes(scale: number): Array<{ width: number; color: number }> {
  const g = createGridLayer();
  const lines = (g.layer as unknown as { children: unknown[] }).children[1] as {
    strokes: Array<{ width: number; color: number }>;
    moveToCount: number;
  };
  g.redraw(fakeCam(scale) as never, 320, 320);
  return lines.strokes;
}

const EPS = 1e-9;
const hasMinor = (
  strokes: Array<{ width: number }>,
  scale: number,
): boolean => strokes.some((s) => Math.abs(s.width - 1 / scale) < EPS);
const hasMajor = (
  strokes: Array<{ width: number }>,
  scale: number,
): boolean => strokes.some((s) => Math.abs(s.width - 1.5 / scale) < EPS);

describe('grid LOD - minor-line hard cut (NAV-06)', () => {
  it('draws minors AND majors when a cell is >= 10px on screen (scale 0.5 -> 16px)', () => {
    const strokes = recordedStrokes(0.5);
    expect(hasMinor(strokes, 0.5)).toBe(true);
    expect(hasMajor(strokes, 0.5)).toBe(true);
  });

  it('omits minors but keeps majors when a cell is < 10px on screen (scale 0.25 -> 8px)', () => {
    const strokes = recordedStrokes(0.25);
    expect(hasMinor(strokes, 0.25)).toBe(false);
    expect(hasMajor(strokes, 0.25)).toBe(true);
  });

  it('draws minors at the exact threshold (scale 0.3125 -> 10px, >= is inclusive)', () => {
    const strokes = recordedStrokes(0.3125);
    expect(hasMinor(strokes, 0.3125)).toBe(true);
    expect(hasMajor(strokes, 0.3125)).toBe(true);
  });
});
