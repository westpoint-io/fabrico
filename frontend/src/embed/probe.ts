// The read-only test probe on each `<fabrico-board>`. It returns a fresh plain-data snapshot per
// call: no setters and no live references, so a test can't change the board through it.
//
// `frames` counts Pixi ticker callbacks and `beltTiles` gives coordinates only. A test reads the
// pixels itself, from outside the page, because a board whose WebGL context was taken keeps its
// ticker (and this frame count) running while it draws nothing.

import { CELL } from '../../shared/geometry';
import { effectiveBox } from '../protocol/footprint';
import { uToPx } from '../render/layers/machineChassis';
import { GAUGE_OUTSET_U, GAUGE_THICK_U, MAX_NUB_REACH_PX } from '../render/layers/machineState';
import type { Point } from '../render/camera';
import type { CameraSnapshot } from '../render/pixiApp';
import type { Verdict } from './badge';
import type { CaptionProbe } from './captions';

/** A rectangle in CSS pixels relative to the viewport. */
export interface ProbeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The inner part of one belt tile on screen, and the grid cell it belongs to. */
export interface BeltTile extends ProbeRect {
  cellX: number;
  cellY: number;
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
  /** True while the board waits for one of the page's 8 renderer slots. */
  capped: boolean;
  /** True while the stage shows the lost-context line over the poster. */
  lostShown: boolean;
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
  /** Render packets the board's scene applied since connect, the keyframe at create included. */
  packetsApplied: number;
  /**
   * Render packets the decoder refused since connect. Any dropped packet stops the board, so a
   * healthy board reads 0.
   */
  decodeErrors: number;
  endHash: string | null;
  /** The selected speed, 0.25 to 4. */
  speed: number;
  /** The badge's verdict once the board has reached its end tick, else null. */
  verdict: Verdict | null;
  /** The hash badge's text, as a reader sees it. */
  badgeText: string;
  /** A copy of this board's camera, or null with no renderer. */
  cameraSnapshot: CameraSnapshot | null;
  /**
   * The inner part of every belt tile on the canvas, in viewport CSS px. Tiles under a machine
   * footprint or a cable, and tiles that a visible overlay element (a name chip, label words, the
   * caption ring) touches, are left out, so these pixels change only when a belt or an item draws.
   * Empty with no renderer or no belt.
   */
  beltTiles: BeltTile[];
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
 * How much of a tile's width is cut from each side before sampling it. A machine's port nub and
 * the chassis edge can reach a few px into the tile next to it; the belt's tread and the item dot
 * sit in the middle.
 */
export const TILE_INSET = 0.2;

/**
 * How far a machine draws outside its footprint, in world px, plus 1 px for anti-aliasing: the
 * larger of the port nubs' reach and the load gauge's outer edge (12 px). Both change with the
 * machine's state, so a tile whose sampled part comes this close to a machine is left out.
 */
export const MACHINE_REACH_PX = Math.max(MAX_NUB_REACH_PX, uToPx(GAUGE_OUTSET_U + GAUGE_THICK_U)) + 1;

interface Cell {
  cell_x: number;
  cell_y: number;
}

/** The scene fields {@link beltTiles} reads. */
export interface TileScene {
  belts: ReadonlyMap<number, { tiles: readonly Cell[] }>;
  nodes: ReadonlyMap<number, Cell & { w: number; h: number; rot: number }>;
  wires: ReadonlyMap<number, { path: readonly Cell[] }>;
}

/** A canvas's box in viewport CSS px, as `getBoundingClientRect` gives it. */
export interface CanvasBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: ProbeRect, b: ProbeRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * The inner part of every belt tile, in viewport CSS px, for a render check to sample.
 *
 * Items move along a board's belts, so these pixels change while the board carries items. Other
 * things that change are kept out: a tile whose inner part comes within {@link MACHINE_REACH_PX} of
 * a machine footprint (its glyph, nubs, gauge and state colours) or that lies on a cable's path (its
 * pulse) is skipped, and so is a tile that touches any of `cutouts`, the
 * overlay elements drawn over the canvas. Each tile is inset by {@link TILE_INSET} of its size on
 * every side and clipped to the part of `canvas` inside `view` (the viewport, so a screenshot can
 * see every tile); a tile with less than 2 px left is skipped. Belts go in handle order and tiles
 * in path order. `worldToScreen` gives canvas px, so the canvas's own top-left is the origin.
 */
export function beltTiles(
  scene: TileScene,
  worldToScreen: (wx: number, wy: number) => Point,
  canvas: CanvasBox,
  view: CanvasBox,
  cutouts: readonly ProbeRect[],
): BeltTile[] {
  const clip: CanvasBox = {
    left: Math.max(canvas.left, view.left),
    top: Math.max(canvas.top, view.top),
    right: Math.min(canvas.right, view.right),
    bottom: Math.min(canvas.bottom, view.bottom),
  };
  // Each machine's footprint grown by MACHINE_REACH_PX, in world px.
  const machines: ProbeRect[] = [...scene.nodes.values()].map((n) => {
    const { ew, eh } = effectiveBox(n.w, n.h, n.rot);
    return {
      x: n.cell_x * CELL - MACHINE_REACH_PX,
      y: n.cell_y * CELL - MACHINE_REACH_PX,
      width: ew * CELL + 2 * MACHINE_REACH_PX,
      height: eh * CELL + 2 * MACHINE_REACH_PX,
    };
  });
  const blocked = new Set<string>();
  const key = (x: number, y: number): string => `${x},${y}`;
  for (const w of scene.wires.values()) for (const t of w.path) blocked.add(key(t.cell_x, t.cell_y));
  const inner = CELL * TILE_INSET;

  const out: BeltTile[] = [];
  const ids = [...scene.belts.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    for (const t of scene.belts.get(id)?.tiles ?? []) {
      const k = key(t.cell_x, t.cell_y);
      if (blocked.has(k)) continue;
      blocked.add(k);
      const sampled: ProbeRect = {
        x: t.cell_x * CELL + inner,
        y: t.cell_y * CELL + inner,
        width: CELL - 2 * inner,
        height: CELL - 2 * inner,
      };
      if (machines.some((m) => overlaps(sampled, m))) continue;
      const a = worldToScreen(t.cell_x * CELL, t.cell_y * CELL);
      const b = worldToScreen((t.cell_x + 1) * CELL, (t.cell_y + 1) * CELL);
      const whole: ProbeRect = {
        x: canvas.left + Math.min(a.x, b.x),
        y: canvas.top + Math.min(a.y, b.y),
        width: Math.abs(b.x - a.x),
        height: Math.abs(b.y - a.y),
      };
      if (cutouts.some((c) => overlaps(whole, c))) continue;
      const left = Math.max(clip.left, whole.x + whole.width * TILE_INSET);
      const top = Math.max(clip.top, whole.y + whole.height * TILE_INSET);
      const right = Math.min(clip.right, whole.x + whole.width * (1 - TILE_INSET));
      const bottom = Math.min(clip.bottom, whole.y + whole.height * (1 - TILE_INSET));
      if (right - left < 2 || bottom - top < 2) continue;
      out.push({ x: left, y: top, width: right - left, height: bottom - top, cellX: t.cell_x, cellY: t.cell_y });
    }
  }
  return out;
}

/**
 * The boxes of the elements drawn over a board's canvas: every visible element inside `stage`
 * with no child element, other than the canvas. The layers that hold them span the whole stage
 * and paint nothing themselves, so they're skipped by the no-child rule.
 */
export function overlayBoxes(stage: HTMLElement): ProbeRect[] {
  const out: ProbeRect[] = [];
  for (const el of stage.querySelectorAll('*')) {
    if (el instanceof HTMLCanvasElement || el.childElementCount > 0) continue;
    if (el.closest('[hidden]') !== null) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  return out;
}
