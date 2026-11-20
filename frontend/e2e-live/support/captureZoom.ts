import type { Page } from '@playwright/test';
import { CELL } from '../../shared/geometry';
import { MAX_ZOOM, MIN_ZOOM } from '../../src/render/camera';
import type { CaptureFacts } from './captureFacts';
import { cameraOf, readScene, resetZoomToActualSize, waitForCameraSettle, type CameraSnapshot } from './oracle';

// captureZoom.ts - exact zooms and pans for the board capture set, through the app's own wheel
// handler (`camera.ts` `onWheel`).
//
// `window.__fabrico` is read-only by design, so the harness sets the camera the way a user does:
// a ctrl+wheel zooms about the cursor by `factor = Math.exp(-dy * 0.0015)`, and a wheel without
// ctrl whose deltaX is not zero pans by exactly (dx, dy). From the shipped reset to exactly 100%,
// one ctrl+wheel of `wheelDeltaFor(target)` lands the scale on the target to the last bit or
// close to it, and one correcting wheel takes up whatever rounding is left.
//
// The in-page functions here are self-contained (no imports, no outer variables), so the same
// code can be sent to the real app through an inspector socket as well as through
// `page.evaluate`. They dispatch the event on the board canvas without moving the real pointer,
// so no hover ring appears in a capture.

/** The wheel's zoom constant, `camera.ts` `zoomAboutCursor`: `factor = Math.exp(-dy * 0.0015)`. */
const ZOOM_PER_DELTA = 0.0015;

/** How far past a zoom clamp the wheel aims, so the clamp itself lands the scale exactly. */
const CLAMP_OVERSHOOT = 1.01;

/** How close a read scale must be to the target. The wheel's own rounding is far below this. */
export const ZOOM_TOLERANCE = 1e-9;

/** The vertical wheel delta that takes the scale from `from` to `target`, aimed past a clamp. */
export function wheelDeltaFor(target: number, from = 1): number {
  const aim = target >= MAX_ZOOM ? MAX_ZOOM * CLAMP_OVERSHOOT : target <= MIN_ZOOM ? MIN_ZOOM / CLAMP_OVERSHOOT : target;
  return -Math.log(aim / from) / ZOOM_PER_DELTA;
}

/** A ctrl+wheel on the board canvas at canvas-relative (x, y): the zoom branch, always. */
export function ctrlWheelInPage(args: { x: number; y: number; dy: number }): void {
  let canvas: HTMLCanvasElement | null = null;
  for (const c of Array.from(document.querySelectorAll('canvas'))) {
    if (canvas === null || c.clientWidth * c.clientHeight > canvas.clientWidth * canvas.clientHeight) canvas = c;
  }
  if (canvas === null) throw new Error('ctrlWheelInPage: no canvas on the page');
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new WheelEvent('wheel', {
      deltaX: 0,
      deltaY: args.dy,
      deltaMode: 0,
      ctrlKey: true,
      clientX: r.left + args.x,
      clientY: r.top + args.y,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/**
 * A wheel without ctrl on the board canvas: the pan branch. A purely vertical, whole-number
 * wheel of 50 or more reads as a mouse-wheel notch and zooms instead, so a zero `dx` is sent as
 * the smallest positive double: it keeps the event off that branch and moves the pan by nothing
 * a double can hold.
 */
export function panWheelInPage(args: { dx: number; dy: number }): void {
  let canvas: HTMLCanvasElement | null = null;
  for (const c of Array.from(document.querySelectorAll('canvas'))) {
    if (canvas === null || c.clientWidth * c.clientHeight > canvas.clientWidth * canvas.clientHeight) canvas = c;
  }
  if (canvas === null) throw new Error('panWheelInPage: no canvas on the page');
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new WheelEvent('wheel', {
      deltaX: args.dx === 0 ? Number.MIN_VALUE : args.dx,
      deltaY: args.dy,
      deltaMode: 0,
      ctrlKey: false,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Press the shipped "Reset zoom to 100%" control through the DOM. */
export function resetZoomInPage(): void {
  const button = document.querySelector('[title="Reset zoom to 100%"]');
  if (!(button instanceof HTMLElement)) throw new Error('resetZoomInPage: no control titled "Reset zoom to 100%"');
  button.click();
}

/** The canvas-relative screen point of the board's bounding-box centre, from the scene's node cells. */
async function boardCentreOnScreen(page: Page, cam: CameraSnapshot): Promise<{ x: number; y: number }> {
  const scene = await readScene(page);
  const cells = scene.nodes.flatMap((n) => n.cells);
  if (cells.length === 0) throw new Error('zoomTo: the board has no node to centre the zoom on');
  const xs = cells.map(([x]) => x);
  const ys = cells.map(([, y]) => y);
  const wx = ((Math.min(...xs) + Math.max(...xs) + 1) * CELL) / 2;
  const wy = ((Math.min(...ys) + Math.max(...ys) + 1) * CELL) / 2;
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

/**
 * Set the camera to exactly `target` through the shipped controls: reset to 100%, one ctrl+wheel
 * about the board's centre, and one correcting wheel if the read scale is off. Answers the camera
 * read back after it settles, which is what every later step uses. Throws when the scale is still
 * off after the correction.
 */
export async function zoomTo(page: Page, target: number): Promise<CameraSnapshot> {
  await resetZoomToActualSize(page);
  let cam = await cameraOf(page);
  const at = await boardCentreOnScreen(page, cam);
  for (let wheel = 0; wheel < 2 && Math.abs(cam.scale - target) > ZOOM_TOLERANCE; wheel++) {
    await page.evaluate(ctrlWheelInPage, { x: at.x, y: at.y, dy: wheelDeltaFor(target, cam.scale) });
    await waitForCameraSettle(page);
    cam = await cameraOf(page);
  }
  if (Math.abs(cam.scale - target) > ZOOM_TOLERANCE) {
    throw new Error(`zoomTo: asked for zoom ${target}, the camera reads ${cam.scale} after a reset and two wheels`);
  }
  return cam;
}

/** Pan the camera by (dx, dy) screen px through the shipped wheel handler and answer the camera read after. */
export async function panBy(page: Page, dx: number, dy: number): Promise<CameraSnapshot> {
  await page.evaluate(panWheelInPage, { dx, dy });
  await waitForCameraSettle(page);
  return cameraOf(page);
}

// ---------------------------------------------------------------------------
// Tiles: covering a board that overflows the viewport
// ---------------------------------------------------------------------------

/** One tile: how far the board moves on screen from the zoom's camera, in CSS px. */
export interface TileOffset {
  dx: number;
  dy: number;
}

/**
 * Room kept around the board and around each machine, in CSS px, past the chassis band: enough
 * for the sample margin the measurer reads past a band at any zoom and ratio here.
 */
const TILE_MARGIN_CSS = 12;

/** The canvas area chrome leaves free, in canvas-relative CSS px. */
export interface FreeArea {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The canvas area left once every chrome panel is cut off along one canvas edge: for each panel,
 * largest first, the cut (everything left of its right edge, above its bottom, right of its left
 * or below its top) that keeps the most area. So the toolbar takes the top, the palette the left,
 * and a corner cluster whichever cut costs less. Canvas-relative CSS px. A machine wholly inside
 * this area is clear of every panel.
 */
export function freeCanvasArea(facts: CaptureFacts, viewport: { width: number; height: number }): FreeArea {
  const w = Math.min(facts.clientRect.width, viewport.width);
  const h = Math.min(facts.clientRect.height, viewport.height);
  let area: FreeArea = { x0: 0, y0: 0, x1: w, y1: h };
  const size = (a: FreeArea) => Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0);
  const panels = facts.panels
    .map((p) => ({ l: p.left - facts.clientRect.left, t: p.top - facts.clientRect.top, r: p.left - facts.clientRect.left + p.width, b: p.top - facts.clientRect.top + p.height }))
    .filter((p) => p.r > p.l && p.b > p.t)
    .sort((a, b) => (b.r - b.l) * (b.b - b.t) - (a.r - a.l) * (a.b - a.t));
  for (const p of panels) {
    if (p.r <= area.x0 || p.b <= area.y0 || p.l >= area.x1 || p.t >= area.y1) continue;
    const cuts: FreeArea[] = [
      { ...area, x0: Math.max(area.x0, p.r) },
      { ...area, y0: Math.max(area.y0, p.b) },
      { ...area, x1: Math.min(area.x1, p.l) },
      { ...area, y1: Math.min(area.y1, p.t) },
    ];
    area = cuts.reduce((best, c) => (size(c) > size(best) ? c : best));
  }
  return area;
}

/** Positions along one axis that cover [lo, hi] with windows of `size`, stepping by `size - overlap`. */
function axisStarts(lo: number, hi: number, size: number, overlap: number): number[] {
  if (hi - lo <= size) return [lo];
  const step = size - overlap;
  if (step <= 0) throw new Error(`tilePlan: the free canvas (${size} CSS px) is no wider than the largest machine plus margins (${overlap} CSS px)`);
  const starts: number[] = [];
  for (let s = lo; ; s += step) {
    if (s + size >= hi) {
      starts.push(hi - size);
      break;
    }
    starts.push(s);
  }
  return starts;
}

/**
 * The pans that cover the whole board at the current camera, as screen offsets of the board from
 * where the zoom left it. The first is always `{ dx: 0, dy: 0 }`: tile 0 is the zoom's own camera.
 * When the board (with a margin) fits in the canvas area chrome leaves free, that is the only
 * tile. Otherwise a grid of tiles follows, each placing a window of the free area over the board,
 * neighbours overlapping by the largest machine's on-screen size plus margins, so every machine
 * lies wholly inside at least one tile.
 */
export function tilePlan(facts: CaptureFacts, viewport: { width: number; height: number }): TileOffset[] {
  const cam = facts.camera;
  const nodes = facts.nodes.filter((n) => n.cells.length > 0);
  if (nodes.length === 0) return [{ dx: 0, dy: 0 }];
  const box = (cells: readonly (readonly [number, number])[]) => {
    const xs = cells.map(([x]) => x);
    const ys = cells.map(([, y]) => y);
    return { x0: Math.min(...xs) * CELL, y0: Math.min(...ys) * CELL, x1: (Math.max(...xs) + 1) * CELL, y1: (Math.max(...ys) + 1) * CELL };
  };
  const board = box(nodes.flatMap((n) => n.cells));
  const sx0 = board.x0 * cam.scale + cam.x - TILE_MARGIN_CSS;
  const sy0 = board.y0 * cam.scale + cam.y - TILE_MARGIN_CSS;
  const sx1 = board.x1 * cam.scale + cam.x + TILE_MARGIN_CSS;
  const sy1 = board.y1 * cam.scale + cam.y + TILE_MARGIN_CSS;
  const free = freeCanvasArea(facts, viewport);
  const fw = free.x1 - free.x0;
  const fh = free.y1 - free.y0;
  if (sx0 >= free.x0 && sy0 >= free.y0 && sx1 <= free.x1 && sy1 <= free.y1) return [{ dx: 0, dy: 0 }];
  let maxW = 0;
  let maxH = 0;
  for (const n of nodes) {
    const b = box(n.cells);
    maxW = Math.max(maxW, (b.x1 - b.x0) * cam.scale);
    maxH = Math.max(maxH, (b.y1 - b.y0) * cam.scale);
  }
  const where = () =>
    `free area ${JSON.stringify(free)} from canvas ${JSON.stringify(facts.clientRect)} and panels ${JSON.stringify(facts.panels)}`;
  let xs: number[];
  let ys: number[];
  try {
    xs = axisStarts(sx0, sx1, fw, maxW + 2 * TILE_MARGIN_CSS);
    ys = axisStarts(sy0, sy1, fh, maxH + 2 * TILE_MARGIN_CSS);
  } catch (e) {
    throw new Error(`${(e as Error).message}; ${where()}`);
  }
  const out: TileOffset[] = [{ dx: 0, dy: 0 }];
  for (const y of ys) {
    for (const x of xs) out.push({ dx: Math.round(free.x0 - x), dy: Math.round(free.y0 - y) });
  }
  return out;
}
