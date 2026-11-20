import type { Page } from '@playwright/test';
import { CELL } from '../../shared/geometry';
import { MAX_ZOOM, MIN_ZOOM } from '../../src/render/camera';
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
