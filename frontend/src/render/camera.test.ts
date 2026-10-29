import { describe, expect, it, vi } from 'vitest';

// GPU-free camera input-contract suite (NAV-03/04/05). camera.ts imports pixi.js
// (Container) at module load and attaches native DOM listeners to `app.canvas`, so
// this suite mocks `pixi.js` with a tiny Container fake (mutable x/y + a scale
// object with .x/.set) and a fake HTMLCanvasElement that captures the event
// handlers into a map. We then drive synthetic WheelEvent / PointerEvent fixtures
// through the captured handlers and assert on container.position / container.scale
// / canvas.style.cursor - no renderer, no WebGL, no pixels.

vi.mock('pixi.js', () => {
  class Container {
    x = 0;
    y = 0;
    scale = {
      x: 1,
      y: 1,
      set(v: number): void {
        this.x = v;
        this.y = v;
      },
    };
    position = {
      set: (px: number, py: number): void => {
        // mirror into x/y so fit-style callers stay consistent
        (this as unknown as { x: number; y: number }).x = px;
        (this as unknown as { x: number; y: number }).y = py;
      },
    };
    children: unknown[] = [];
    addChild(...c: unknown[]): unknown {
      this.children.push(...c);
      return c[0];
    }
  }
  return { Container };
});

import { computeFitTransform, computeInspectorNudge, createCamera, MAX_ZOOM, MIN_ZOOM } from './camera.ts';
import { CELL } from '../../shared/geometry.ts';

// ---- Fakes --------------------------------------------------------------

interface FakeCanvas {
  handlers: Map<string, (e: unknown) => void>;
  style: { cursor: string };
  clientHeight: number;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
  releasePointerCapture(id: number): void;
}

function makeCanvas(): FakeCanvas {
  const handlers = new Map<string, (e: unknown) => void>();
  return {
    handlers,
    style: { cursor: '' },
    clientHeight: 600,
    addEventListener(type, fn): void {
      handlers.set(type, fn);
    },
    removeEventListener(type): void {
      handlers.delete(type);
    },
    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
      return { left: 0, top: 0, width: 800, height: 600 };
    },
    setPointerCapture(): void {},
    hasPointerCapture(): boolean {
      return true;
    },
    releasePointerCapture(): void {},
  };
}

function makeApp(canvas: FakeCanvas): {
  stage: { addChild: () => void };
  canvas: FakeCanvas;
} {
  return { stage: { addChild: (): void => {} }, canvas };
}

interface WheelFixture {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  ctrlKey?: boolean;
  clientX?: number;
  clientY?: number;
}
function wheel(f: WheelFixture): Record<string, unknown> {
  return {
    deltaX: f.deltaX ?? 0,
    deltaY: f.deltaY ?? 0,
    deltaMode: f.deltaMode ?? 0,
    ctrlKey: f.ctrlKey ?? false,
    clientX: f.clientX ?? 400,
    clientY: f.clientY ?? 300,
    preventDefault: vi.fn(),
  };
}

interface PointerFixture {
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
}
function pointer(f: PointerFixture): Record<string, unknown> {
  return {
    button: f.button ?? 0,
    ...(f.buttons !== undefined ? { buttons: f.buttons } : {}),
    clientX: f.clientX ?? 0,
    clientY: f.clientY ?? 0,
    pointerId: f.pointerId ?? 1,
    preventDefault: vi.fn(),
  };
}

function setup(): {
  cam: ReturnType<typeof createCamera>;
  canvas: FakeCanvas;
  onChange: ReturnType<typeof vi.fn>;
  fire(type: string, e: Record<string, unknown>): void;
} {
  const canvas = makeCanvas();
  const app = makeApp(canvas);
  const onChange = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cam = createCamera(app as any, onChange);
  const fire = (type: string, e: Record<string, unknown>): void => {
    const h = canvas.handlers.get(type);
    if (!h) throw new Error(`no handler captured for "${type}"`);
    h(e);
  };
  return { cam, canvas, onChange, fire };
}

// ---- Tests --------------------------------------------------------------

describe('camera wheel zoom clamp', () => {
  it('repeated zoom-in never exceeds MAX_ZOOM', () => {
    const { cam, fire } = setup();
    // Classic mouse wheel notch (large, integral, purely vertical) => ZOOM in.
    for (let i = 0; i < 200; i++) fire('wheel', wheel({ deltaY: -120 }));
    expect(cam.container.scale.x).toBeLessThanOrEqual(MAX_ZOOM);
    expect(cam.container.scale.x).toBeCloseTo(MAX_ZOOM, 10);
  });

  it('repeated zoom-out never drops below MIN_ZOOM', () => {
    const { cam, fire } = setup();
    for (let i = 0; i < 200; i++) fire('wheel', wheel({ deltaY: 120 }));
    expect(cam.container.scale.x).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(cam.container.scale.x).toBeCloseTo(MIN_ZOOM, 10);
  });
});

describe('camera deltaMode normalization (NAV-05)', () => {
  it('LINE-mode wheel matches an equivalent PIXEL-mode wheel (x16)', () => {
    const line = setup();
    line.fire('wheel', wheel({ deltaY: 5, deltaMode: 1 })); // 5 lines
    const px = setup();
    px.fire('wheel', wheel({ deltaY: 80 })); // 5 * 16 = 80 px
    expect(line.cam.container.scale.x).toBeCloseTo(px.cam.container.scale.x, 10);
    expect(line.cam.container.scale.x).not.toBe(1);
  });

  it('PAGE-mode wheel scales by canvas.clientHeight', () => {
    const page = setup();
    page.fire('wheel', wheel({ deltaY: 1, deltaMode: 2 })); // 1 page => 600 px
    const px = setup();
    px.fire('wheel', wheel({ deltaY: 600 }));
    expect(page.cam.container.scale.x).toBeCloseTo(px.cam.container.scale.x, 10);
  });
});

describe('camera wheel branch selection (NAV-03)', () => {
  it('(a) trackpad pinch (ctrlKey, small deltaY) => ZOOM', () => {
    const { cam, fire } = setup();
    fire('wheel', wheel({ deltaY: -10, ctrlKey: true }));
    expect(cam.container.scale.x).toBeGreaterThan(1); // zoomed in
  });

  it('(b) trackpad two-finger scroll (fractional, diagonal) => PAN', () => {
    const { cam, fire } = setup();
    fire('wheel', wheel({ deltaX: 3, deltaY: 4.5 }));
    expect(cam.container.scale.x).toBe(1); // no zoom
    expect(cam.container.x).toBeCloseTo(-3, 10);
    expect(cam.container.y).toBeCloseTo(-4.5, 10);
  });

  it('(c) classic mouse wheel (large integral vertical) => ZOOM', () => {
    const { cam, fire } = setup();
    fire('wheel', wheel({ deltaY: 120 }));
    expect(cam.container.scale.x).toBeLessThan(1); // zoomed out
    expect(cam.container.scale.x).not.toBe(1);
  });

  it('(d) Firefox mouse wheel (deltaMode LINE) => ZOOM', () => {
    const { cam, fire } = setup();
    fire('wheel', wheel({ deltaY: 3, deltaMode: 1 }));
    expect(cam.container.scale.x).not.toBe(1);
  });
});

describe('camera preventDefault (threat T-29-01-01)', () => {
  it('calls preventDefault on every wheel event, unconditionally', () => {
    const { fire } = setup();
    const e = wheel({ deltaX: 3, deltaY: 4.5 }); // pan branch
    fire('wheel', e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    const z = wheel({ deltaY: 120 }); // zoom branch
    fire('wheel', z);
    expect(z.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('camera middle-mouse unconditional pan (NAV-04)', () => {
  it('button-1 pointerdown pans even while setPanEnabled(false)', () => {
    const { cam, fire } = setup();
    cam.setPanEnabled(false);
    fire('pointerdown', pointer({ button: 1, clientX: 100, clientY: 100 }));
    fire('pointermove', pointer({ button: 1, clientX: 150, clientY: 130 }));
    expect(cam.container.x).toBeCloseTo(50, 10);
    expect(cam.container.y).toBeCloseTo(30, 10);
  });

  it('setPanEnabled(false) does NOT cancel an in-progress middle-drag', () => {
    const { cam, fire } = setup();
    fire('pointerdown', pointer({ button: 1, clientX: 100, clientY: 100 }));
    cam.setPanEnabled(false); // arm a tool mid middle-drag
    fire('pointermove', pointer({ button: 1, clientX: 140, clientY: 100 }));
    expect(cam.container.x).toBeCloseTo(40, 10);
  });

  it('left-button pointerdown while setPanEnabled(false) does NOT pan', () => {
    const { cam, fire } = setup();
    cam.setPanEnabled(false);
    fire('pointerdown', pointer({ button: 0, clientX: 100, clientY: 100 }));
    fire('pointermove', pointer({ button: 0, clientX: 150, clientY: 130 }));
    expect(cam.container.x).toBe(0);
    expect(cam.container.y).toBe(0);
  });
});

describe('camera pans on a middle press chorded into a drag (89 review UI-05, D-11)', () => {
  // The shape both engines send (measured on the WebKitGTK binary and in Chromium): the left is
  // down for a draw (the gesture layer owns it, pan disabled), the middle press arrives as a
  // pointermove with button 1 and buttons 5, its moves carry buttons 5, its release is a
  // pointermove with button 1 and buttons 1.
  it('pans while the middle bit is held, from the chord, and stops when it lifts', () => {
    const { cam, canvas, fire } = setup();
    cam.setPanEnabled(false); // the Belt tool is armed; the left press belongs to the draw
    fire('pointerdown', pointer({ button: 0, buttons: 1, clientX: 100, clientY: 100 }));
    fire('pointermove', pointer({ button: -1, buttons: 1, clientX: 120, clientY: 100 }));
    expect(cam.container.x, 'the left drag alone does not pan with a tool armed').toBe(0);
    fire('pointermove', pointer({ button: 1, buttons: 5, clientX: 120, clientY: 100 }));
    expect(canvas.style.cursor, 'the chord grabs the board').toBe('grabbing');
    fire('pointermove', pointer({ button: -1, buttons: 5, clientX: 160, clientY: 130 }));
    expect(cam.container.x).toBeCloseTo(40, 10);
    expect(cam.container.y).toBeCloseTo(30, 10);
    fire('pointermove', pointer({ button: 1, buttons: 1, clientX: 160, clientY: 130 }));
    fire('pointermove', pointer({ button: -1, buttons: 1, clientX: 200, clientY: 130 }));
    expect(cam.container.x, 'the pan ended with the middle bit').toBeCloseTo(40, 10);
    expect(canvas.style.cursor, 'and gave the cursor back').not.toBe('grabbing');
  });

  it('a chord pan that outlives the left release ends on the middle up', () => {
    const { cam, fire } = setup();
    cam.setPanEnabled(false);
    fire('pointerdown', pointer({ button: 0, buttons: 1, clientX: 100, clientY: 100 }));
    fire('pointermove', pointer({ button: 1, buttons: 5, clientX: 100, clientY: 100 }));
    fire('pointermove', pointer({ button: 0, buttons: 4, clientX: 110, clientY: 100 }));
    fire('pointermove', pointer({ button: -1, buttons: 4, clientX: 130, clientY: 100 }));
    expect(cam.container.x).toBeCloseTo(30, 10);
    fire('pointerup', pointer({ button: 1, buttons: 0, clientX: 130, clientY: 100 }));
    fire('pointermove', pointer({ button: -1, buttons: 0, clientX: 170, clientY: 100 }));
    expect(cam.container.x, 'no pan after the middle up').toBeCloseTo(30, 10);
  });

  it('a move that carries no buttons field never starts a pan', () => {
    const { cam, fire } = setup();
    fire('pointermove', pointer({ button: -1, clientX: 100, clientY: 100 }));
    fire('pointermove', pointer({ button: -1, clientX: 150, clientY: 100 }));
    expect(cam.container.x).toBe(0);
  });
});

describe('camera cursor arbitration (NAV-04)', () => {
  it('sets grabbing during an active pan and restores prior cursor on pointerup', () => {
    const { canvas, fire } = setup();
    const prior = canvas.style.cursor; // camera sets an idle affordance at init
    fire('pointerdown', pointer({ button: 0, clientX: 100, clientY: 100 }));
    expect(canvas.style.cursor).toBe('grabbing');
    fire('pointerup', pointer({ button: 0, clientX: 100, clientY: 100 }));
    expect(canvas.style.cursor).toBe(prior);
  });

  it('sets an idle grab affordance at camera init', () => {
    const { canvas } = setup();
    expect(canvas.style.cursor).toBe('grab');
  });
});

// ---- fit-to-factory math (NAV-01) --------------------------------------
//
// computeFitTransform is a PURE function (no pixi, no DOM), so it is tested
// directly with plain bbox/viewport/inset literals — no camera or canvas fake.
// The bbox is in CELL units {minX,minY,maxX,maxY}; empty init is Infinity/-Infinity.

const VIEWPORT = { screenW: 800, screenH: 600 };
const INSETS = { top: 72, left: 96, right: 24, bottom: 24 };

function allFinite(t: { scale: number; x: number; y: number }): boolean {
  return Number.isFinite(t.scale) && Number.isFinite(t.x) && Number.isFinite(t.y);
}

describe('computeFitTransform fit math (NAV-01)', () => {
  it('centers a known bbox in the inset rect at the per-axis min ratio', () => {
    // A 5x3-cell bbox (well inside the clamp band so scale is the raw ratio).
    const bbox = { minX: 10, minY: 10, maxX: 15, maxY: 13 };
    const t = computeFitTransform(bbox, VIEWPORT, INSETS);
    expect(allFinite(t)).toBe(true);

    const ww = (bbox.maxX - bbox.minX) * CELL; // 160 px
    const wh = (bbox.maxY - bbox.minY) * CELL; // 96 px
    const availW = VIEWPORT.screenW - INSETS.left - INSETS.right; // 680
    const availH = VIEWPORT.screenH - INSETS.top - INSETS.bottom; // 504
    const pad = 0.12;
    const expected = Math.min(availW / (ww * (1 + pad)), availH / (wh * (1 + pad)));
    expect(t.scale).toBeCloseTo(expected, 10);
    expect(t.scale).toBeGreaterThan(MIN_ZOOM);
    expect(t.scale).toBeLessThan(MAX_ZOOM);

    // The bbox centre lands at the centre of the AVAILABLE (inset) rect.
    const cxWorld = bbox.minX * CELL + ww / 2;
    const cyWorld = bbox.minY * CELL + wh / 2;
    const screenCx = cxWorld * t.scale + t.x;
    const screenCy = cyWorld * t.scale + t.y;
    expect(screenCx).toBeCloseTo(INSETS.left + availW / 2, 10);
    expect(screenCy).toBeCloseTo(INSETS.top + availH / 2, 10);
  });

  it('clamps a single-cell factory to MAX_ZOOM and still centers it', () => {
    // A 1x1 footprint: grow() yields maxX=minX+1, so ww=wh=CELL — the fit ratio
    // is huge and must clamp to MAX_ZOOM.
    const bbox = { minX: 4, minY: 4, maxX: 5, maxY: 5 };
    const t = computeFitTransform(bbox, VIEWPORT, INSETS);
    expect(allFinite(t)).toBe(true);
    expect(t.scale).toBe(MAX_ZOOM);

    const availW = VIEWPORT.screenW - INSETS.left - INSETS.right;
    const availH = VIEWPORT.screenH - INSETS.top - INSETS.bottom;
    const cxWorld = bbox.minX * CELL + CELL / 2;
    const cyWorld = bbox.minY * CELL + CELL / 2;
    expect(cxWorld * t.scale + t.x).toBeCloseTo(INSETS.left + availW / 2, 10);
    expect(cyWorld * t.scale + t.y).toBeCloseTo(INSETS.top + availH / 2, 10);
  });

  it('clamps a very large factory to MIN_ZOOM', () => {
    // A 2000x2000-cell bbox dwarfs the viewport — the fit ratio floors at MIN_ZOOM.
    const bbox = { minX: 0, minY: 0, maxX: 2000, maxY: 2000 };
    const t = computeFitTransform(bbox, VIEWPORT, INSETS);
    expect(allFinite(t)).toBe(true);
    expect(t.scale).toBe(MIN_ZOOM);
  });

  it('falls back to zoom 1.0 centered on the viewport for an empty bbox', () => {
    // Infinity-init bbox (no nodes/tiles grew it) => explicit NaN-proof fallback.
    const empty = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const t = computeFitTransform(empty, VIEWPORT, INSETS);
    expect(allFinite(t)).toBe(true);
    expect(t.scale).toBe(1);
    expect(t.x).toBe(VIEWPORT.screenW / 2);
    expect(t.y).toBe(VIEWPORT.screenH / 2);
  });

  it('per-axis: a wide-short factory fits within both axes (height-bound)', () => {
    // Wide + short: the WIDTH ratio would allow a big zoom, but the height (only
    // 1 cell tall vs many wide) is the binding axis — min() must pick it so the
    // full bbox fits both axes without overflow.
    const bbox = { minX: 0, minY: 0, maxX: 40, maxY: 1 };
    const t = computeFitTransform(bbox, VIEWPORT, INSETS);
    expect(allFinite(t)).toBe(true);

    const ww = (bbox.maxX - bbox.minX) * CELL;
    const wh = (bbox.maxY - bbox.minY) * CELL;
    const availW = VIEWPORT.screenW - INSETS.left - INSETS.right;
    const availH = VIEWPORT.screenH - INSETS.top - INSETS.bottom;
    const pad = 0.12;
    const expected = Math.min(availW / (ww * (1 + pad)), availH / (wh * (1 + pad)));
    expect(t.scale).toBeCloseTo(Math.max(expected, MIN_ZOOM), 10);
    // Both scaled dimensions fit inside the available rect (with padding room).
    expect(ww * t.scale).toBeLessThanOrEqual(availW + 1e-9);
    expect(wh * t.scale).toBeLessThanOrEqual(availH + 1e-9);
  });

  it('per-axis: a tall-narrow factory fits within both axes (width-bound)', () => {
    const bbox = { minX: 0, minY: 0, maxX: 1, maxY: 40 };
    const t = computeFitTransform(bbox, VIEWPORT, INSETS);
    expect(allFinite(t)).toBe(true);

    const ww = (bbox.maxX - bbox.minX) * CELL;
    const wh = (bbox.maxY - bbox.minY) * CELL;
    const availW = VIEWPORT.screenW - INSETS.left - INSETS.right;
    const availH = VIEWPORT.screenH - INSETS.top - INSETS.bottom;
    expect(ww * t.scale).toBeLessThanOrEqual(availW + 1e-9);
    expect(wh * t.scale).toBeLessThanOrEqual(availH + 1e-9);
  });
});

// ---------------------------------------------------------------------------
// screenToCellFrac (plan 74-14): the belt accumulator's cell-space walk
// ---------------------------------------------------------------------------
//
// The belt draw accumulator (`input/gestures.ts`) walks the cells a pointer
// SEGMENT crossed between two samples, and that walk runs in CELL space rather
// than in world px. `screenToCellFrac` is the accessor it reads, and
// `screenToCell` is now `Math.floor` of it, so the world-to-cell division lives
// in exactly one expression and the two cannot drift apart.
describe('camera screenToCellFrac (74-14)', () => {
  it('screenToCellFrac floors to screenToCell at every sample and every zoom', () => {
    const { cam } = setup();

    // The SUBJECT of this case is the RELATIONSHIP between the two accessors, not
    // the transform itself. No hand-computed `fx` constant appears below on
    // purpose: pinning the transform a second time here would duplicate what the
    // pan/zoom cases above already assert, and would not say the one thing this
    // case exists to say.
    //
    // The sample set crosses the origin on BOTH axes deliberately. At a negative
    // world coordinate `Math.floor` and truncation disagree (floor(-0.5) is -1,
    // trunc(-0.5) is 0), so an implementation written with `| 0` or `Math.trunc`
    // would satisfy this identity on positives alone and fail here.
    const zooms = [MIN_ZOOM, 0.5, 1, 1.7, 2, MAX_ZOOM];
    const pans: Array<[number, number]> = [
      [0, 0],
      [37, -91],
      [-160, 240],
      [CELL * 3.5, CELL * -2.25],
    ];
    const samples: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [-1, -1],
      [15.5, 0.5],
      [-15.5, -0.5],
      [CELL, CELL],
      [CELL - 0.001, CELL - 0.001],
      [-CELL, -CELL],
      [-CELL + 0.001, -CELL + 0.001],
      [123.75, 456.25],
      [-123.75, -456.25],
      [799, 599],
    ];

    let sawNegativeCell = false;
    let sawFractionalFrac = false;

    for (const z of zooms) {
      for (const [panX, panY] of pans) {
        cam.setCamera(z, panX, panY);
        for (const [sx, sy] of samples) {
          const frac = cam.screenToCellFrac(sx, sy);
          const cell = cam.screenToCell(sx, sy);
          const where = `zoom=${z} pan=(${panX},${panY}) sample=(${sx},${sy})`;
          expect(Math.floor(frac.fx), `fx floors to cx at ${where}`).toBe(cell.cx);
          expect(Math.floor(frac.fy), `fy floors to cy at ${where}`).toBe(cell.cy);
          if (cell.cx < 0 || cell.cy < 0) sawNegativeCell = true;
          if (!Number.isInteger(frac.fx) || !Number.isInteger(frac.fy)) sawFractionalFrac = true;
        }
      }
    }

    // NON-VACUITY, because the identity above is trivially true over a single cell
    // and over integer-only samples. This asserts the sample set actually reached
    // the two regions where a wrong implementation differs.
    expect(sawNegativeCell, 'the sample set reached a negative cell').toBe(true);
    expect(sawFractionalFrac, 'the sample set reached a sub-cell offset').toBe(true);

    // THE UNIT ARM, and it is the only thing here that can fail. MEASURED, not
    // argued: the floor identity above CANNOT fail on its own, because
    // `screenToCell` is implemented as `Math.floor` of `screenToCellFrac` - so an
    // implementation returning world px, or millimetres, satisfies it trivially.
    // Mutating the accessor to return world px reddened nothing in this file until
    // this arm existed, which is exactly the class of defect this repository keeps
    // catching in its own gates.
    //
    // What this asserts instead is the UNIT: `fx` counts CELLS. Moving the pointer
    // by one cell's worth of SCREEN distance (CELL world px through the live zoom)
    // must move `fx` by exactly 1. Derived from CELL and the live scale rather than
    // hand-computed, so it pins the unit without re-pinning the transform.
    for (const z of zooms) {
      cam.setCamera(z, 11, -23);
      const screenPerCell = CELL * z;
      const a0 = cam.screenToCellFrac(50, 70);
      const a1 = cam.screenToCellFrac(50 + screenPerCell, 70 + screenPerCell);
      expect(a1.fx - a0.fx, `fx counts CELLS at zoom ${z}`).toBeCloseTo(1, 9);
      expect(a1.fy - a0.fy, `fy counts CELLS at zoom ${z}`).toBeCloseTo(1, 9);
    }

    // THE ABSOLUTE ARM (WR-04, added 2026-09-10). The two arms above measure a
    // RELATIONSHIP and a UNIT, and the phase review measured that neither can see an
    // absolute error: the floor identity is self-derived, and the unit arm is a
    // DIFFERENCE of two calls, so any constant offset cancels exactly. Adding `+ 1` to
    // both components of `screenToCellFrac` - which would shift every cell hit test in
    // the app one cell diagonally - reddened NOTHING in the whole frontend unit suite.
    //
    // So this arm pins the transform at KNOWN POSITIONS, hand-computed from the camera
    // it sets and nothing else. At zoom 2 with pan (100,50): world x = (sx - 100) / 2,
    // and cell x = world x / CELL, CELL being 32.
    //   screen 164 -> world 32   -> cell 1.0 exactly
    //   screen 148 -> world 24   -> cell 0.75
    //   screen  84 -> world -8   -> cell -0.25, whose FLOOR is -1 (not 0)
    // The negative sample is here so an implementation using `| 0` or `Math.trunc`
    // cannot pass this arm either.
    cam.setCamera(2, 100, 50);
    expect(cam.screenToCellFrac(164, 50).fx, 'screen 164 at zoom 2, pan 100 is cell 1.0').toBeCloseTo(1, 9);
    expect(cam.screenToCellFrac(148, 50).fx, 'screen 148 is cell 0.75').toBeCloseTo(0.75, 9);
    expect(cam.screenToCell(148, 50).cx, 'and floors into cell 0').toBe(0);
    expect(cam.screenToCellFrac(84, 50).fx, 'screen 84 is cell -0.25').toBeCloseTo(-0.25, 9);
    expect(cam.screenToCell(84, 50).cx, 'and FLOORS to -1, where trunc would say 0').toBe(-1);
    // The y axis, independently: world y = (sy - 50) / 2.
    expect(cam.screenToCellFrac(100, 114).fy, 'screen 114 at pan 50 is cell 1.0').toBeCloseTo(1, 9);
    expect(cam.screenToCell(100, 114).cy).toBe(1);
  });
});

// ---- the inspector nudge (phase 91, plan 91-09, CHROME-07, D-06, UI-SPEC 2.4) ---------------
//
// computeInspectorNudge is pure, like computeFitTransform: screen rects in, a pan distance out.
// The fixtures are UI-SPEC 2.2's numbers at 1024 x 768: the inspector's left edge 618.08, its
// top 116, its max bottom 744, the palette's right edge 198 and the 24 px gap.

const COL_1024 = { left: 618.08, top: 116, maxBottom: 744 };
const PALETTE_RIGHT = 198;
const GAP = 24;

describe('computeInspectorNudge, the inspector nudge distance (CHROME-07)', () => {
  it('returns 0 for a footprint clear of the column', () => {
    expect(computeInspectorNudge({ left: 400, top: 300, right: 500, bottom: 340 }, COL_1024, PALETTE_RIGHT, GAP)).toBe(0);
    // Exactly on the clear line is clear (594.08).
    expect(computeInspectorNudge({ left: 560, top: 300, right: 594.08, bottom: 340 }, COL_1024, PALETTE_RIGHT, GAP)).toBe(0);
  });

  it('pans a covered footprint so its right edge lands on the clear line (the UI-SPEC worked example)', () => {
    // The Router at x 639..667 at 1024 x 768: d = min(667 - 594.08, 639 - 222) = 72.92.
    const d = computeInspectorNudge({ left: 639, top: 300, right: 667, bottom: 340 }, COL_1024, PALETTE_RIGHT, GAP);
    expect(d).toBeCloseTo(72.92, 10);
    // The far-right Sink at about x 928..960: d = 365.92, landing at 562.08..594.08.
    expect(computeInspectorNudge({ left: 928, top: 300, right: 960, bottom: 332 }, COL_1024, PALETTE_RIGHT, GAP)).toBeCloseTo(365.92, 10);
  });

  it('clamps at the palette for a footprint wider than the free band', () => {
    // 222..700 is wider than the 372.08 px band from 222 to 594.08: the clamp wins.
    const m = { left: 300, top: 300, right: 800, bottom: 340 };
    expect(computeInspectorNudge(m, COL_1024, PALETTE_RIGHT, GAP)).toBeCloseTo(300 - (PALETTE_RIGHT + GAP), 10);
    // Already at the clamp: nothing to move, never a pan right.
    expect(computeInspectorNudge({ left: 222, top: 300, right: 800, bottom: 340 }, COL_1024, PALETTE_RIGHT, GAP)).toBe(0);
    expect(computeInspectorNudge({ left: 210, top: 300, right: 800, bottom: 340 }, COL_1024, PALETTE_RIGHT, GAP)).toBe(0);
  });

  it('returns 0 for a footprint below the column or above its top', () => {
    expect(computeInspectorNudge({ left: 639, top: 744, right: 667, bottom: 770 }, COL_1024, PALETTE_RIGHT, GAP)).toBe(0);
    expect(computeInspectorNudge({ left: 639, top: 60, right: 667, bottom: 116 }, COL_1024, PALETTE_RIGHT, GAP)).toBe(0);
    // A footprint that reaches one pixel into the column is covered.
    expect(computeInspectorNudge({ left: 639, top: 60, right: 667, bottom: 117 }, COL_1024, PALETTE_RIGHT, GAP)).toBeGreaterThan(0);
  });

  it('returns 0, a finite number, for non-finite input', () => {
    const covered = { left: 639, top: 300, right: 667, bottom: 340 };
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const d of [
        computeInspectorNudge({ ...covered, right: bad }, COL_1024, PALETTE_RIGHT, GAP),
        computeInspectorNudge({ ...covered, left: bad }, COL_1024, PALETTE_RIGHT, GAP),
        computeInspectorNudge(covered, { ...COL_1024, left: bad }, PALETTE_RIGHT, GAP),
        computeInspectorNudge(covered, { ...COL_1024, maxBottom: bad }, PALETTE_RIGHT, GAP),
        computeInspectorNudge(covered, COL_1024, bad, GAP),
        computeInspectorNudge(covered, COL_1024, PALETTE_RIGHT, bad),
      ]) {
        expect(d).toBe(0);
        expect(Number.isFinite(d)).toBe(true);
      }
    }
  });
});
