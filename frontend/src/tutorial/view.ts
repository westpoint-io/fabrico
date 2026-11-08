// view.ts - is a lesson's ring in view, and where the camera has to go to bring it back.
//
// Pure: the layer reads the ring's rect and the free area from the page and passes them in, and it
// applies the camera this returns through `cameraRead.ts`. The camera's zoom floor comes in as a
// parameter, because this folder can't import `render/`.

import type { ChromeFacts } from './types';

type FreeArea = ChromeFacts['view']['freeArea'];

/**
 * Is the rect out of view? True when it shares no area of positive size with the free area, so a
 * ring that only touches an edge counts as out. The rule is the locked one from 103-CONTEXT,
 * "Off-screen target": the free area, not the window. A ring right of the inspector reserve reads as
 * out even with the inspector closed, and changing that is the owner's call.
 */
export function offScreen(rect: { x: number; y: number; width: number; height: number }, free: FreeArea): boolean {
  const overlapX = Math.min(rect.x + rect.width, free.right) - Math.max(rect.x, free.left);
  const overlapY = Math.min(rect.y + rect.height, free.bottom) - Math.max(rect.y, free.top);
  return !(overlapX > 0 && overlapY > 0);
}

/** What the off-screen flag reads on one frame. */
export interface OffScreenFlagInput {
  /**
   * The shown stage's key. The caller passes null with no shown stage, and for a stage whose ring marks
   * a panel or nothing, because neither can be out of view.
   */
  shownKey: string | null;
  /** The stage the ring was last placed for (`data-fab-hint-stage`), or null while the ring is hidden. */
  placedKey: string | null;
  /** The stage the ring last tried to resolve, whether it found a box or not (`data-fab-hint-tried`), or null with no target. */
  triedKey: string | null;
  /** The board rings as painted this frame (both, for a drag), or null with none. They count only when placed for the shown stage. */
  rects: readonly { x: number; y: number; width: number; height: number }[] | null;
  free: FreeArea;
  /** The flag the last frame read. */
  last: boolean;
}

/**
 * The off-screen flag for one frame (UI-SPEC "Off-screen flag when a ring stops resolving", 103 review
 * IN-01). Rings placed for the shown stage answer it: true when any of them is out of view. A stage
 * change reaches the ring a frame after the lesson, and until then the ring still names the previous
 * stage, so the flag keeps its last value. Once the ring has tried the shown stage and found no box, its
 * target is gone, and the flag is false: a row saying the ring is out of view, with a Show me that has
 * nothing to frame, would be wrong.
 */
export function offScreenFlag({ shownKey, placedKey, triedKey, rects, free, last }: OffScreenFlagInput): boolean {
  if (shownKey === null) return false;
  if (placedKey === shownKey && rects !== null) return rects.some((r) => offScreen(r, free));
  if (triedKey === shownKey) return false;
  return last;
}

/**
 * The camera that frames `box` (world px) in the free area: the box's centre on the free area's
 * centre, at the current zoom when the box plus `marginPx` a side fits, otherwise at the largest zoom
 * that fits, never below `minZoom` and never above the current zoom.
 *
 * Why 48 px is enough: below zoom 1 a drop disc doesn't shrink with the board. Its on-screen radius
 * stays 12 px plus a 2 px border, so after a zoom-out it covers more world px than the box this was
 * given. That growth is at most 14 px a side, inside the 48 px margin.
 */
export function frameTarget(
  box: { x: number; y: number; w: number; h: number },
  free: FreeArea,
  cam: { x: number; y: number; scale: number },
  minZoom: number,
  marginPx = 48,
): { x: number; y: number; scale: number } {
  const roomW = free.right - free.left - 2 * marginPx;
  const roomH = free.bottom - free.top - 2 * marginPx;
  const fits = box.w * cam.scale <= roomW && box.h * cam.scale <= roomH;
  let scale = cam.scale;
  if (!fits) {
    const byW = box.w > 0 ? roomW / box.w : Number.POSITIVE_INFINITY;
    const byH = box.h > 0 ? roomH / box.h : Number.POSITIVE_INFINITY;
    scale = Math.min(cam.scale, Math.max(minZoom, Math.min(byW, byH)));
  }
  const centreX = (free.left + free.right) / 2;
  const centreY = (free.top + free.bottom) / 2;
  return {
    x: centreX - (box.x + box.w / 2) * scale,
    y: centreY - (box.y + box.h / 2) * scale,
    scale,
  };
}
