// The read-only test probe on each `<fabrico-board>`. It returns a fresh plain-data snapshot per
// call: no setters and no live references, so a test can't change the board through it.
//
// `frames` counts Pixi ticker callbacks and `beltRegion` gives coordinates only. A test reads the
// pixels itself, from outside the page, because a board whose WebGL context was taken keeps its
// ticker (and this frame count) running while it draws nothing.

import { CELL } from '../../shared/geometry';
import type { Camera } from '../render/camera';
import type { CameraSnapshot } from '../render/pixiApp';
import type { SceneState } from '../render/sceneState';
import type { Verdict } from './badge';

/** A rectangle in CSS pixels relative to the viewport. */
export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the stage shows: the loading line, the running board, or an error card. */
export type ProbeState = 'loading' | 'running' | 'error';

export interface BoardProbe {
  id: string;
  mounted: boolean;
  state: ProbeState;
  tick: number;
  endTick: number;
  /** The tick the player reported right after create (or after the last restart). */
  bootTick: number;
  playing: boolean;
  frames: number;
  endHash: string | null;
  /** The selected speed, 0.25 to 4. */
  speed: number;
  /** The badge's verdict once the board has reached its end tick, else null. */
  verdict: Verdict | null;
  /** The hash badge's text, as a reader sees it. */
  badgeText: string;
  /** A copy of this board's camera, or null with no renderer. */
  cameraSnapshot: CameraSnapshot | null;
  /** The longest belt's tiles, projected through this board's camera, or null with no belt. */
  beltRegion: ProbeRect | null;
  /** The error card's heading and body, or null when no card shows. */
  error: { heading: string; body: string } | null;
}

/** A copy of a trace: every tick and its hash, as plain pairs. */
export function tickHashes(trace: readonly (readonly [number, string])[]): [number, string][] {
  return trace.map(([tick, hash]) => [tick, hash]);
}

/**
 * The screen box of the longest belt's tiles, clipped to the canvas, in viewport CSS pixels.
 * Null when the scene has no belt with tiles or the box falls outside the canvas.
 */
export function beltRegion(scene: SceneState, cam: Camera, canvas: HTMLCanvasElement): ProbeRect | null {
  let longest: { cell_x: number; cell_y: number }[] = [];
  for (const belt of scene.belts.values()) {
    if (belt.tiles.length > longest.length) longest = belt.tiles;
  }
  if (longest.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of longest) {
    minX = Math.min(minX, t.cell_x);
    minY = Math.min(minY, t.cell_y);
    maxX = Math.max(maxX, t.cell_x + 1);
    maxY = Math.max(maxY, t.cell_y + 1);
  }
  const a = cam.worldToScreen(minX * CELL, minY * CELL);
  const b = cam.worldToScreen(maxX * CELL, maxY * CELL);
  const r = canvas.getBoundingClientRect();
  const left = Math.max(r.left, r.left + Math.min(a.x, b.x));
  const top = Math.max(r.top, r.top + Math.min(a.y, b.y));
  const right = Math.min(r.right, r.left + Math.max(a.x, b.x));
  const bottom = Math.min(r.bottom, r.top + Math.max(a.y, b.y));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
