// A board's captions: the strip under the stage and the ring around the machine a caption names.
//
// The strip shows only on a board whose file has captions. Before the first one it says how many
// notes the run has. When the clock holds the board on a caption's tick it shows
// `NOTE {i} OF {N} · TICK {t}` and the caption's sentence, with a 3 px rail on its left edge. After
// Continue the last caption stays, without the rail, so the reader can finish reading it. Restart
// puts the opening line back. Every word goes in with `textContent`: caption text comes from a
// board file anyone can edit.
//
// The ring is a DOM element in its own layer over the canvas, with the app's `.fab-hint` look. Each
// frame of the board's own ticker places it around the machine's footprint, the box the app's
// selection ring uses (the node's cell, and its width and height swapped on an odd rotation), 4
// world px out on each side, through this board's camera. A caption whose machine isn't in the
// scene shows its text with no ring, and the board records that so a test can fail on it.

import { CELL } from '../../shared/geometry';
import type { BoardCaption } from '../player/playerWasm';
import { effectiveBox } from '../protocol/footprint';
import type { CameraSnapshot, SceneHandle } from '../render/pixiApp';
import { formatTick } from './controls';
import type { ProbeRect } from './probe';

/** How far the ring sits outside the machine's footprint, in world px. */
export const RING_OFFSET_WORLD = 4;

/** The strip's opening line, before the first caption. */
export function introText(count: number): string {
  return count === 1
    ? '1 note on this run. The board stops when it comes up.'
    : `${count} notes on this run. The board stops at each one.`;
}

/** The heading over a caption: `NOTE 1 OF 3 · TICK 88`. */
export function noteHeading(index: number, count: number, tick: number): string {
  return `NOTE ${index + 1} OF ${count} · TICK ${formatTick(tick)}`;
}

/** The node fields the ring reads. */
export interface FootprintNode {
  cell_x: number;
  cell_y: number;
  w: number;
  h: number;
  rot: number;
}

/** A machine's footprint and its ring, in the stage's CSS px. */
export function ringBoxes(node: FootprintNode, cam: CameraSnapshot): { footprint: ProbeRect; ring: ProbeRect } {
  const { ew, eh } = effectiveBox(node.w, node.h, node.rot);
  const footprint = {
    x: node.cell_x * CELL * cam.scale + cam.x,
    y: node.cell_y * CELL * cam.scale + cam.y,
    width: ew * CELL * cam.scale,
    height: eh * CELL * cam.scale,
  };
  const pad = RING_OFFSET_WORLD * cam.scale;
  return {
    footprint,
    ring: {
      x: footprint.x - pad,
      y: footprint.y - pad,
      width: footprint.width + 2 * pad,
      height: footprint.height + 2 * pad,
    },
  };
}

/** What the strip and the ring need from the board, read fresh on each update. */
export interface CaptionState {
  /** The caption holding the board, or null. */
  held: number | null;
  /** The last caption the board reached since boot or Restart, or null. */
  last: number | null;
}

export interface CaptionStrip {
  root: HTMLDivElement;
  /** Set the board's captions once it has booted. An empty list hides the strip. */
  setCaptions(captions: readonly BoardCaption[]): void;
  update(state: CaptionState): void;
}

export function createCaptionStrip(): CaptionStrip {
  const root = document.createElement('div');
  root.className = 'captions';
  root.setAttribute('aria-live', 'polite');
  root.hidden = true;
  let captions: readonly BoardCaption[] = [];
  let shownKey = '';

  const update = (state: CaptionState): void => {
    if (captions.length === 0) return;
    const index = state.held ?? state.last;
    const key = index === null ? 'intro' : `${index}:${state.held === null ? 'after' : 'held'}`;
    if (key === shownKey) return;
    shownKey = key;
    root.classList.toggle('is-holding', state.held !== null);
    if (index === null) {
      const line = document.createElement('p');
      line.className = 'caption-intro';
      line.textContent = introText(captions.length);
      root.replaceChildren(line);
      return;
    }
    const caption = captions[index];
    const heading = document.createElement('p');
    heading.className = 'caption-heading';
    heading.textContent = noteHeading(index, captions.length, caption.tick);
    const text = document.createElement('p');
    text.className = 'caption-text';
    text.textContent = caption.text;
    root.replaceChildren(heading, text);
  };

  return {
    root,
    setCaptions(next): void {
      captions = [...next];
      root.hidden = captions.length === 0;
      shownKey = '';
      update({ held: null, last: null });
    },
    update,
  };
}

/** What a test reads about the caption holding the board. */
export interface CaptionProbe {
  index: number;
  tick: number;
  text: string;
  /** The ring's border box in viewport CSS px, or null when no ring shows. */
  ringRect: ProbeRect | null;
  /** The machine's footprint in viewport CSS px, or null when its node isn't in the scene. */
  footprintRect: ProbeRect | null;
}

export interface CaptionRing {
  root: HTMLDivElement;
  /** Place (or hide) the ring now, as the ticker does each frame. */
  sync(): void;
  /** The held caption as a test sees it, or null when no caption holds the board. */
  probe(): CaptionProbe | null;
  /** True once a held caption named a machine the scene didn't have. */
  missedRing(): boolean;
}

/** Build the ring layer inside `stage` and drive it from the board's ticker. */
export function createCaptionRing(
  stage: HTMLElement,
  handle: SceneHandle,
  captions: readonly BoardCaption[],
  held: () => number | null,
): CaptionRing {
  const root = document.createElement('div');
  root.className = 'caption-layer';
  root.setAttribute('aria-hidden', 'true');
  const ring = document.createElement('div');
  ring.className = 'fab-hint caption-ring';
  ring.hidden = true;
  root.append(ring);
  stage.append(root);
  let missed = false;

  const nodeFor = (index: number): FootprintNode | null => {
    const id = captions[index]?.renderHandle;
    if (id === null || id === undefined) return null;
    return (handle.sceneState.nodes.get(id) as FootprintNode | undefined) ?? null;
  };

  const sync = (): void => {
    const index = held();
    if (index === null) {
      if (!ring.hidden) ring.hidden = true;
      return;
    }
    const node = nodeFor(index);
    if (node === null) {
      missed = true;
      if (!ring.hidden) ring.hidden = true;
      return;
    }
    const { ring: box } = ringBoxes(node, handle.cameraSnapshot());
    ring.style.left = `${box.x}px`;
    ring.style.top = `${box.y}px`;
    ring.style.width = `${box.width}px`;
    ring.style.height = `${box.height}px`;
    if (ring.hidden) ring.hidden = false;
  };

  sync();
  handle.app.ticker.add(sync);

  const toViewport = (r: ProbeRect): ProbeRect => {
    const origin = root.getBoundingClientRect();
    return { x: origin.left + r.x, y: origin.top + r.y, width: r.width, height: r.height };
  };

  return {
    root,
    sync,
    probe(): CaptionProbe | null {
      const index = held();
      if (index === null) return null;
      sync();
      const caption = captions[index];
      const node = nodeFor(index);
      const footprint = node === null ? null : toViewport(ringBoxes(node, handle.cameraSnapshot()).footprint);
      let ringRect: ProbeRect | null = null;
      if (!ring.hidden) {
        const r = ring.getBoundingClientRect();
        ringRect = { x: r.left, y: r.top, width: r.width, height: r.height };
      }
      return { index, tick: caption.tick, text: caption.text, ringRect, footprintRect: footprint };
    },
    missedRing: () => missed,
  };
}
