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
import type { CaptionProbe } from './captions';

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
  /** True while the board holds a Pixi app (a WebGL context); false while it waits or is away. */
  mounted: boolean;
  /** Whether the board was playing when it last left the margin, or null if it never left. */
  wasPlaying: boolean | null;
  /** True when this browser gave the board no WebGL renderer, so its poster stands in for it. */
  noWebGL: boolean;
  /** True while the stage shows the board's poster image. */
  posterShown: boolean;
  /** The poster's alt text while the poster layer shows, else null. */
  posterAlt: string | null;
  state: ProbeState;
  tick: number;
  endTick: number;
  /** The tick the player reported right after create (or after the last restart). */
  bootTick: number;
  playing: boolean;
  /** Pixi ticker callbacks, summed over every mount since connect. */
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
  /** The caption holding the board, with its ring and the machine's footprint on screen, or null. */
  caption: CaptionProbe | null;
  /** True once a held caption named a machine the scene didn't have, so no ring could show. */
  captionWithoutRing: boolean;
  /** The code view's tab labels, in order; empty with one machine or no code column. */
  codeTabs: string[];
  /** The source the code view shows, or null when the column is hidden. */
  codeText: string | null;
  /** Each effect log row: its four cells (tick, method, target, outcome) and its title. */
  effectRows: { cells: string[]; title: string }[];
  /** How far the effect log well is scrolled, in CSS px. */
  logScrollTop: number;
  /** The order strip's text, or null when the element has no `order` attribute. */
  orderStrip: string | null;
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
