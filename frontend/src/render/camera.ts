// The pan/zoom camera (UI-SPEC "Grid & camera") — a single root Container whose
// position is the pan and whose uniform scale is the zoom (Pattern 2). All scene
// layers (grid/belts/machines/items/overlay) are children of `container`, so they
// live in WORLD space and the camera transform applies to every one of them.
//
// This module also owns the screen<->world<->cell coordinate helpers that the
// overlay (07-07) and 07-09's gesture controller reuse — one source of truth for
// "which cell is under the cursor" so placement, hover and routing all agree.

import type { Application } from 'pixi.js';
import { Container } from 'pixi.js';
import { CELL } from '../../shared/geometry';
import { cellsOfFootprint } from '../protocol/footprint';
import type { SceneState } from './sceneState';

/** Zoom clamp — never invert or zoom past a readable cell size. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/**
 * DOM_DELTA_LINE (deltaMode 1) px approximation. Firefox mouse wheels report
 * deltas in LINES, not pixels; ~16px is a text line height and gives wheel-zoom
 * sensitivity parity with Chrome/WebKit PIXEL deltas (NAV-05). Cosmetic/tunable
 * (RESEARCH A2). DOM_DELTA_PAGE (2) instead scales each axis by the matching
 * canvas client extent (horizontal by width, vertical by height).
 */
export const LINE_HEIGHT_PX = 16;

/** Cursor affordances — the camera owns grab/grabbing while it owns the pan. */
export const CURSOR_PAN_IDLE = 'grab';
export const CURSOR_PAN_ACTIVE = 'grabbing';

export interface CellCoord {
  cx: number;
  cy: number;
}
/**
 * A grid cell with its sub-cell offset kept (74-14): `fx` of 3.25 is a quarter of
 * a cell east of cell 3's left edge. `Math.floor` of this pair is a `CellCoord`.
 */
export interface FracCell {
  fx: number;
  fy: number;
}
export interface Point {
  x: number;
  y: number;
}

export interface Camera {
  /** The root world Container (pan = position, zoom = scale). */
  container: Container;
  /**
   * The live uniform zoom (`container.scale.x`) - MOTION-07 device-pixel quantum
   * source. The item layer folds this into `q = renderer.resolution * worldScale()`
   * so its per-dot snap tracks the CONTINUOUS zoom (alignment holds at every zoom,
   * not only 1.0). Read-only: mirrors the read-only oracle discipline, mutates
   * nothing and emits no command (threat T-26-07-RO).
   */
  worldScale(): number;
  /** Screen (canvas-relative px) → world px. */
  screenToWorld(sx: number, sy: number): Point;
  /** World px → screen (canvas-relative px). */
  worldToScreen(wx: number, wy: number): Point;
  /** Screen px → integer grid cell. `Math.floor` of `screenToCellFrac`. */
  screenToCell(sx: number, sy: number): CellCoord;
  /**
   * Screen px → FRACTIONAL grid cell (the cell coordinate with its sub-cell
   * offset kept), plan 74-14.
   *
   * ONE caller: the belt draw accumulator in `input/gestures.ts`, which walks the
   * cells a pointer SEGMENT crossed between two samples so a fast or diagonal drag
   * lands the belt the hand drew. That walk needs the sub-cell position of both
   * endpoints to know where the segment crosses each column and row line, and it
   * has to run in CELL space rather than world px: the vitest rig's legacy shim
   * maps `cell = floor(screen)`, so a world-px walk would put both ends of every
   * legacy segment inside cell (0,0).
   *
   * `screenToCell` is implemented as `Math.floor` of this pair rather than
   * carrying its own copy of the world-to-cell division, so the two cannot drift:
   * an edit to one is an edit to both.
   */
  screenToCellFrac(sx: number, sy: number): FracCell;
  /** Cell (its top-left corner) → screen px. */
  cellToScreen(cx: number, cy: number): Point;
  /** Suspend/resume pan (07-09 disables it while a place/wire gesture is live). */
  setPanEnabled(on: boolean): void;
  /**
   * Set the whole camera transform at once (NAV-01 fit-to-factory / Home): apply
   * `zoom` to the container scale and `(panX, panY)` to its position, then fire
   * onChange so the grid re-tiles and the read-only e2e `camera()` reflects the
   * new transform. This is the single WRITE seam that mirrors the read-only
   * worldScale() discipline — every fit/recenter mutation goes through here so
   * the onChange side-effect can never be forgotten.
   */
  setCamera(zoom: number, panX: number, panY: number): void;
  /** Detach the DOM listeners (the canvas itself is destroyed by app.destroy). */
  destroy(): void;
}

/** Chrome insets (px) that shrink the usable fit viewport (toolbar/palette/cluster). */
export interface Insets {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** A world bounding box in CELL units; empty is Infinity-initialised (min > max). */
export interface CellBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Create the camera and wire pointer-drag pan + wheel zoom directly on the Pixi
 * canvas. Pointer capture keeps a drag alive even when the cursor leaves the
 * canvas, and means every listener lives on `app.canvas` — so they are GC'd with
 * the canvas on `app.destroy(true)` (no window-level leak across StrictMode).
 *
 * @param onChange invoked after every pan/zoom so the grid layer can re-tile to
 *                 cover the newly-visible world rectangle.
 */
export function createCamera(app: Application, onChange: () => void): Camera {
  const container = new Container();
  app.stage.addChild(container);

  const canvas = app.canvas as HTMLCanvasElement;
  let panEnabled = true;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  // Which button owns the live pan. A middle-drag (NAV-04) must survive a tool
  // arming (setPanEnabled(false)); a left-drag must not. Kept separate so the
  // suppress-pan arbitration only ever cancels a LEFT pan.
  let panningVia: 'left' | 'middle' | null = null;
  // Cursor captured at pan start so pointerup restores exactly what was there
  // before the camera set 'grabbing' (even if a gesture had set it).
  let prevCursor = '';
  // A MIDDLE PRESS CHORDED INTO A DRAG ALREADY IN FLIGHT (phase 89 review UI-05, D-11, UI-SPEC
  // section 5: "a mid-draw pan"). The Pointer Events spec delivers a second button pressed while
  // the first is down as a `pointermove` whose `buttons` gains its bit, never as a `pointerdown`,
  // and that is what both engines send: measured on WebKitGTK (the shipped binary on Xvfb, review
  // pass 2) and on Chromium (89-07 research A5), a middle press inside a left drag is a
  // `pointermove` with button 1 and buttons 5, its release a `pointermove` with button 1 and
  // buttons 1. So `onPointerDown` never saw it and the camera never panned mid-draw. The chord
  // pans on its own: it starts on the first move that carries the middle bit while no pan runs,
  // and ends on the first move without it, or on the pointer's up. The gesture layer freezes a
  // draw's path under the same bit (`gestures.ts` `middleChorded`), so the path and the board
  // move together and the hand comes back to the cell it left.
  let chordPan = false;

  // Resting affordance: the empty floor is pannable, so signal 'grab' on boot.
  canvas.style.cursor = CURSOR_PAN_IDLE;

  const localPoint = (e: PointerEvent | WheelEvent): Point => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const screenToWorld = (sx: number, sy: number): Point => ({
    x: (sx - container.x) / container.scale.x,
    y: (sy - container.y) / container.scale.y,
  });
  const worldToScreen = (wx: number, wy: number): Point => ({
    x: wx * container.scale.x + container.x,
    y: wy * container.scale.y + container.y,
  });
  const screenToCellFrac = (sx: number, sy: number): FracCell => {
    const w = screenToWorld(sx, sy);
    return { fx: w.x / CELL, fy: w.y / CELL };
  };
  // The world-to-cell division appears ONCE, in screenToCellFrac above. This is
  // its floor, so the integer answer and the fractional answer cannot drift apart
  // (74-14).
  //
  // What gates it, corrected 2026-09-10 after the phase review measured the claim
  // that used to stand here ("gates that by derivation over every zoom and both
  // sides of the origin"). Derivation alone gates NOTHING absolute: the floor
  // identity in `camera.test.ts` is self-derived (this function IS Math.floor of
  // that one) and its unit arm is a difference of two calls, so a `+ 1` added to
  // both components of screenToCellFrac - one cell of skew on every hit test in
  // the app - reddened nothing repo-wide. The suite now carries a third arm that
  // pins screenToCellFrac at hand-computed ABSOLUTE positions, including a
  // negative one where floor and truncation disagree. That arm is the gate.
  //
  // `screenToCell` and `screenToCellFrac` are ALSO the accessors the belt draw
  // accumulator walks in (`input/gestures.ts`), so an offset here moves the drawn
  // path as well as the hit test.
  const screenToCell = (sx: number, sy: number): CellCoord => {
    const f = screenToCellFrac(sx, sy);
    return { cx: Math.floor(f.fx), cy: Math.floor(f.fy) };
  };
  const cellToScreen = (cx: number, cy: number): Point =>
    worldToScreen(cx * CELL, cy * CELL);

  // Cursor-precedence contract (Open Question 1, RESEARCH Finding 5):
  //   - The GESTURE layer (input/gestures.ts) owns the cursor while a tool or
  //     selection owns the pointer: it sets 'pointer'/'grabbing'/'' for docks
  //     and handle hovers. A tool armed sets panEnabled=false, and the camera
  //     stays SILENT then so it never clobbers a gesture affordance.
  //   - The CAMERA owns 'grab'/'grabbing' only while the floor is pannable
  //     (panEnabled) or a pan (left OR middle) is actively running.
  //   Residual Phase-30 seam: a gesture that restores the cursor to '' over a
  //   machine will flip back to 'grab' on the next move here. Noted, NOT solved
  //   this phase (would require coordinating gestures.ts, which this plan must
  //   not touch - CONTEXT boundary).
  const onPointerDown = (e: PointerEvent): void => {
    // NAV-04: middle-button (button 1) pans UNCONDITIONALLY - it overrides an
    // armed tool and whatever is under the cursor, bypassing panEnabled. A left
    // drag still pans only while pan is enabled.
    const middle = e.button === 1;
    if (!middle && (!panEnabled || e.button !== 0)) return;
    if (middle) e.preventDefault(); // suppress the Chromium/WebView2 autoscroll anchor
    dragging = true;
    panningVia = middle ? 'middle' : 'left';
    const p = localPoint(e);
    lastX = p.x;
    lastY = p.y;
    canvas.setPointerCapture(e.pointerId);
    prevCursor = canvas.style.cursor;
    canvas.style.cursor = CURSOR_PAN_ACTIVE;
  };
  const onPointerMove = (e: PointerEvent): void => {
    const middleHeld = typeof e.buttons === 'number' && (e.buttons & 4) !== 0;
    if (!dragging && middleHeld) {
      dragging = true;
      panningVia = 'middle';
      chordPan = true;
      const p = localPoint(e);
      lastX = p.x;
      lastY = p.y;
      prevCursor = canvas.style.cursor;
      canvas.style.cursor = CURSOR_PAN_ACTIVE;
      return;
    }
    if (chordPan && !middleHeld) {
      dragging = false;
      panningVia = null;
      chordPan = false;
      canvas.style.cursor = prevCursor;
      return;
    }
    if (!dragging) {
      // Re-assert the resting grab affordance only while the camera owns the
      // pointer (panEnabled) and no gesture cursor is present - fill an empty or
      // own cursor, never overwrite a gesture-set 'pointer'/'grabbing'.
      if (
        panEnabled &&
        (canvas.style.cursor === '' || canvas.style.cursor === CURSOR_PAN_IDLE)
      ) {
        canvas.style.cursor = CURSOR_PAN_IDLE;
      }
      return;
    }
    const p = localPoint(e);
    container.x += p.x - lastX;
    container.y += p.y - lastY;
    lastX = p.x;
    lastY = p.y;
    onChange();
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    panningVia = null;
    chordPan = false;
    // Restore whatever the cursor was before this pan grabbed it, even if the
    // pointer left the canvas mid-drag (pointer capture kept events on us).
    canvas.style.cursor = prevCursor;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  // Zoom about the cursor (extracted from the old onWheel). `dy` is the already
  // deltaMode-normalized vertical delta. Preserves the exact feel constant.
  const zoomAboutCursor = (p: Point, dy: number): void => {
    const worldBefore = screenToWorld(p.x, p.y);
    // Exponential zoom feels linear to the hand; negative dy = zoom in.
    const factor = Math.exp(-dy * 0.0015);
    const next = clamp(container.scale.x * factor, MIN_ZOOM, MAX_ZOOM);
    container.scale.set(next);
    // Keep the world point under the cursor pinned (zoom about the cursor).
    container.x = p.x - worldBefore.x * next;
    container.y = p.y - worldBefore.y * next;
    onChange();
  };

  // Best-effort mouse-wheel-vs-trackpad-scroll heuristic (RESEARCH Finding 1 / A1).
  // The browser gives NO authoritative signal to separate a two-finger trackpad
  // SCROLL from a classic MOUSE WHEEL; only pinch (ctrlKey) is authoritative. This
  // is the CONTEXT-locked shipping default: a non-PIXEL deltaMode is a strong wheel
  // signal (esp. Firefox LINE); in PIXEL mode a large, integral, purely-vertical
  // step is a wheel notch, while small/fractional/diagonal deltas are trackpad
  // scroll. A future "scroll wheel: zoom | pan" toggle is a FUT item, not built here.
  const isMouseWheel = (e: WheelEvent, dxNorm: number, dyNorm: number): boolean => {
    if (e.deltaMode !== 0) return true;
    const purelyVertical = dxNorm === 0;
    const large = Math.abs(dyNorm) >= 50;
    const integral = Number.isInteger(e.deltaY);
    return purelyVertical && large && integral;
  };

  const onWheel = (e: WheelEvent): void => {
    // First and unconditional: stop the Tauri webview from zooming (Ctrl+wheel)
    // or triggering history back-swipe on horizontal scroll (threat T-29-01-01).
    e.preventDefault();
    const p = localPoint(e);

    // deltaMode normalization (NAV-05) BEFORE branching: LINE -> ~px, PAGE ->
    // viewport-height px, PIXEL -> as-is. Consistent sensitivity across browsers.
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1 /* DOM_DELTA_LINE */) {
      dx *= LINE_HEIGHT_PX;
      dy *= LINE_HEIGHT_PX;
    } else if (e.deltaMode === 2 /* DOM_DELTA_PAGE */) {
      // A page-worth of scroll scales per-axis by that axis's viewport extent
      // (WR-02): horizontal by width, vertical by height. Using height for both
      // pans a horizontal PAGE delta by the wrong magnitude on a non-square canvas.
      dx *= canvas.clientWidth;
      dy *= canvas.clientHeight;
    }

    // Branch 1: pinch or explicit Ctrl+wheel -> ZOOM (only authoritative signal).
    if (e.ctrlKey) {
      zoomAboutCursor(p, dy);
      return;
    }
    // Branch 2: classic mouse wheel -> ZOOM (Factorio expectation; heuristic).
    if (isMouseWheel(e, dx, dy)) {
      zoomAboutCursor(p, dy);
      return;
    }
    // Branch 3: trackpad two-finger scroll -> PAN (NAV-03, scroll != zoom).
    container.x -= dx;
    container.y -= dy;
    onChange();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return {
    container,
    worldScale: (): number => container.scale.x,
    screenToWorld,
    worldToScreen,
    screenToCell,
    screenToCellFrac,
    cellToScreen,
    setPanEnabled: (on: boolean): void => {
      panEnabled = on;
      // Disabling pan (a tool armed) cancels a LEFT drag, but must NOT kill a
      // live middle-drag (NAV-04) - panningVia keeps them distinct.
      if (!on && panningVia !== 'middle') {
        if (dragging) canvas.style.cursor = prevCursor;
        dragging = false;
        panningVia = null;
      }
    },
    setCamera: (zoom: number, panX: number, panY: number): void => {
      // Uniform scale (both axes) + absolute pan, then the single onChange so the
      // grid re-tiles and the e2e camera() reflects the moved transform exactly
      // once per call (no double redraw). Mirrors the pan/zoom handlers' contract.
      container.scale.set(zoom);
      container.position.set(panX, panY);
      onChange();
    },
    destroy: (): void => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}

// ---------------------------------------------------------------------------
// Fit-to-factory (NAV-01) — pure geometry + a thin scene-reading wrapper.
//
// `computeFitTransform` is DELIBERATELY pure (no pixi, no DOM, no camera): it
// takes a CELL-unit bbox, the CSS-px viewport, and the chrome insets, and returns
// the {scale, x, y} that frames the bbox centred in the inset rect. It is the
// unit-tested core (RESEARCH Finding 3 / Pattern 3). `fitToFactory` reads the
// already-decoded sceneState (no command, no packet, no schema touch) to derive
// the bbox, then routes through the camera's single setCamera write seam.
// ---------------------------------------------------------------------------

/** Padding around the bbox — ~12% breathing room so it is never edge-jammed. */
const FIT_PAD = 0.12;

/**
 * Frame a world `bbox` (CELL units) centred inside the `viewport` after removing
 * the chrome `insets`, returning the camera {scale, x, y}. Uniform scale, no
 * rotation, so the transform is per-axis linear and separable.
 *
 * Guarantees (T-29-04-01, DoS): EVERY returned number is finite. A non-finite
 * (empty, Infinity-init) bbox falls back to zoom 1.0 centred on the raw viewport;
 * the scale is the per-axis MIN ratio clamped to [MIN_ZOOM, MAX_ZOOM] so a tiny
 * factory centres at MAX_ZOOM and a huge one at MIN_ZOOM (never NaN/Infinity).
 */
export function computeFitTransform(
  bbox: CellBBox,
  viewport: { screenW: number; screenH: number },
  insets: Insets,
): { scale: number; x: number; y: number } {
  const { screenW, screenH } = viewport;
  // Empty-scene fallback (Pitfall 3): a non-finite bbox never reaches the divide.
  if (
    !Number.isFinite(bbox.minX) ||
    !Number.isFinite(bbox.minY) ||
    !Number.isFinite(bbox.maxX) ||
    !Number.isFinite(bbox.maxY)
  ) {
    return { scale: 1, x: screenW / 2, y: screenH / 2 };
  }

  const wx0 = bbox.minX * CELL;
  const wy0 = bbox.minY * CELL;
  const ww = (bbox.maxX - bbox.minX) * CELL;
  const wh = (bbox.maxY - bbox.minY) * CELL;

  // Usable viewport after the chrome insets (top toolbar, left palette, cluster).
  const availW = screenW - insets.left - insets.right;
  const availH = screenH - insets.top - insets.bottom;

  // Per-axis ratio; a zero-size axis (degenerate) yields MAX_ZOOM instead of a
  // divide-by-zero, and the min() then frames whichever axis actually binds.
  const scaleW = ww > 0 ? availW / (ww * (1 + FIT_PAD)) : MAX_ZOOM;
  const scaleH = wh > 0 ? availH / (wh * (1 + FIT_PAD)) : MAX_ZOOM;
  const scale = clamp(Math.min(scaleW, scaleH), MIN_ZOOM, MAX_ZOOM);

  // Land the bbox centre at the centre of the AVAILABLE (inset) rect so the
  // factory is not jammed under the toolbar / behind the palette.
  const cxWorld = wx0 + ww / 2;
  const cyWorld = wy0 + wh / 2;
  const x = insets.left + availW / 2 - cxWorld * scale;
  const y = insets.top + availH / 2 - cyWorld * scale;
  return { scale, x, y };
}

/** A screen rectangle in CSS px (the `getBoundingClientRect` space): left, top, right, bottom. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The column the inspector can occupy (phase 91, plan 91-09, CHROME-07, UI-SPEC 2.4): its left
 * edge, its top (the shared dock offset) and the bottom its border box can grow to (the window's
 * bottom less 24). The column, not the panel's current height, so a panel that grows after its
 * config loads cannot cover the machine later (UI-SPEC A4).
 */
export interface InspectorColumn {
  left: number;
  top: number;
  maxBottom: number;
}

/**
 * How far to pan the board LEFT so the selected machine sits clear of the inspector (phase 91,
 * plan 91-09, CHROME-07, D-06, UI-SPEC 2.4). Pure: no pixi, no DOM, no camera, the
 * `computeFitTransform` discipline; App reads the boxes and applies the answer through
 * `cam.setCamera(zoom, panX - d, panY)`.
 *
 * The machine is covered when its footprint `m` reaches past the clear line (the column's left
 * edge less `gap`) and overlaps the column vertically. Then the distance is
 * `min(m.right - (column.left - gap), m.left - (paletteRight + gap))`: enough to bring the
 * machine's right edge to the clear line, but never so far that its left edge passes under the
 * palette (UI-SPEC A5, the only limit; the camera has no pan bounds). A machine wider than the
 * free band lands with its left edge at the palette clamp and its right part still covered.
 *
 * Returns 0 when nothing needs to move, and 0 for any non-finite input; every result is finite
 * and never negative (a pan RIGHT would move the machine toward the panel).
 */
export function computeInspectorNudge(
  m: ScreenRect,
  column: InspectorColumn,
  paletteRight: number,
  gap: number,
): number {
  const inputs = [m.left, m.top, m.right, m.bottom, column.left, column.top, column.maxBottom, paletteRight, gap];
  if (!inputs.every(Number.isFinite)) {
    return 0;
  }
  const clearLine = column.left - gap;
  const covered = m.right > clearLine && m.bottom > column.top && m.top < column.maxBottom;
  if (!covered) {
    return 0;
  }
  const d = Math.min(m.right - clearLine, m.left - (paletteRight + gap));
  return d > 0 ? d : 0;
}

/**
 * Fit the whole factory into the inset viewport and apply it to `cam`.
 *
 * Grows a CELL-unit bbox from every node footprint cell (via the core-mirrored
 * `cellsOfFootprint`, so the rot dim-swap matches the sim) and every belt tile,
 * then applies `computeFitTransform` through `cam.setCamera`. Reads `scene`
 * only (no mutation, no command, no packet); the empty-scene case flows through
 * computeFitTransform's fallback (no zero-size divide).
 *
 * `screenW`/`screenH` MUST be the CSS-px `app.screen` dimensions (NOT the device
 * -px `app.renderer.width`), to match the camera's getBoundingClientRect space.
 */
export function fitToFactory(
  cam: Camera,
  scene: SceneState,
  screenW: number,
  screenH: number,
  insets: Insets,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (cx: number, cy: number): void => {
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx + 1 > maxX) maxX = cx + 1;
    if (cy + 1 > maxY) maxY = cy + 1;
  };
  for (const n of scene.nodes.values()) {
    for (const [cx, cy] of cellsOfFootprint(n.cell_x, n.cell_y, n.w, n.h, n.rot)) {
      grow(cx, cy);
    }
  }
  for (const b of scene.belts.values()) {
    for (const t of b.tiles) grow(t.cell_x, t.cell_y);
  }
  const t = computeFitTransform({ minX, minY, maxX, maxY }, { screenW, screenH }, insets);
  cam.setCamera(t.scale, t.x, t.y);
}
