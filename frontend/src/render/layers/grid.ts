// The factory-floor grid layer (UI-SPEC "Grid & camera"): the buildable floor
// fill plus minor (every cell) and major (every 8 cells) guide lines.
//
// The layer is a child of the camera Container, so it draws in WORLD space. It
// re-tiles to cover exactly the currently-visible world rectangle on every
// camera pan/zoom (and on resize) — a quiet, infinite-feeling floor that costs
// nothing while idle (`isRenderGroup` promotes it to its own GPU group).

import { Container, Graphics } from 'pixi.js';
import { CELL, MAJOR_EVERY } from '../../../shared/geometry';
import { LOCKED_SKIN } from '../synth/skins/locked';
import type { Skin } from '../synth/skin';
import type { Camera } from '../camera';

// NAV-06 level-of-detail hard cut: minor guide lines are drawn only while an
// on-screen cell is at least this many pixels wide (scale * CELL). Below it the
// minor mesh would shrink into a muddy sub-pixel shimmer, so it is omitted
// entirely (a hard cut, not a fade) and only the major orientation lines remain.
// CELL=32 -> minors drawn iff scale >= 0.3125.
const MINOR_LOD_MIN_CELL_PX = 10;

export interface GridLayer {
  layer: Container;
  /** Re-tile the floor + lines to cover the visible viewport. */
  redraw(cam: Camera, screenW: number, screenH: number): void;
}

export function createGridLayer(): GridLayer {
  const layer = new Container({ isRenderGroup: true });
  const floor = new Graphics();
  const lines = new Graphics();
  layer.addChild(floor, lines);

  // The floor substrate is NOT an accent (style-bible section 1): it reads off the
  // neutral ramp so it belongs to the same world as the sprites. Darkest ramp step
  // (index 0) is the buildable floor; the next step is the quiet minor guide; a
  // touch brighter (index 2) is the major orientation line. All three derive from
  // the ONE locked skin (D-22), so they are fixed for the app lifetime.
  const skin: Skin = LOCKED_SKIN;
  const floorColor = skin.palette.ramp[0];
  const minorColor = skin.palette.ramp[1];
  const majorColor = skin.palette.ramp[2];

  const redraw = (cam: Camera, screenW: number, screenH: number): void => {
    // Visible world rectangle (one cell of bleed so a partial pan shows no seam).
    const tl = cam.screenToWorld(0, 0);
    const br = cam.screenToWorld(screenW, screenH);
    const cx0 = Math.floor(tl.x / CELL) - 1;
    const cy0 = Math.floor(tl.y / CELL) - 1;
    const cx1 = Math.ceil(br.x / CELL) + 1;
    const cy1 = Math.ceil(br.y / CELL) + 1;
    const wx0 = cx0 * CELL;
    const wy0 = cy0 * CELL;
    const wx1 = cx1 * CELL;
    const wy1 = cy1 * CELL;

    // Keep guide lines ~1px on screen at any zoom.
    const scale = cam.container.scale.x || 1;
    const minorW = 1 / scale;
    const majorW = 1.5 / scale;

    floor
      .clear()
      .rect(wx0, wy0, wx1 - wx0, wy1 - wy0)
      .fill({ color: floorColor });

    lines.clear();

    // Minor cell guides — present but never shouting (skip the major columns/rows).
    // NAV-06 LOD: only plotted while a cell is legible (>= 10px on screen); below
    // that the whole minor pass (loops + stroke) is omitted so the floor stays
    // clean when zoomed out. Majors below are always drawn for orientation.
    if (scale * CELL >= MINOR_LOD_MIN_CELL_PX) {
      for (let c = cx0; c <= cx1; c++) {
        if (c % MAJOR_EVERY === 0) continue;
        const x = c * CELL;
        lines.moveTo(x, wy0).lineTo(x, wy1);
      }
      for (let r = cy0; r <= cy1; r++) {
        if (r % MAJOR_EVERY === 0) continue;
        const y = r * CELL;
        lines.moveTo(wx0, y).lineTo(wx1, y);
      }
      lines.stroke({ width: minorW, color: minorColor });
    }

    // Major orientation lines, every MAJOR_EVERY cells — slightly brighter.
    for (let c = cx0; c <= cx1; c++) {
      if (c % MAJOR_EVERY !== 0) continue;
      const x = c * CELL;
      lines.moveTo(x, wy0).lineTo(x, wy1);
    }
    for (let r = cy0; r <= cy1; r++) {
      if (r % MAJOR_EVERY !== 0) continue;
      const y = r * CELL;
      lines.moveTo(wx0, y).lineTo(wx1, y);
    }
    lines.stroke({ width: majorW, color: majorColor });
  };

  return { layer, redraw };
}
