// The read-only board's label overlay: a name chip over every machine and the words of every
// label, as DOM over the canvas inside the stage. It draws what the app's two overlays draw
// (`chrome/MachineLabels.tsx`, `chrome/LabelWords.tsx`) with the same pure rules from
// `render/labelGeometry.ts`, without React, and reads the camera of the board it sits on.
//
// It runs on the board's own `app.ticker`, so it stops when the board's Pixi application is
// destroyed. The element set is rebuilt in the same frame a keyframe lands (a restart sends one),
// so no chip ever sits over a node whose handle changed. The stage clips the layer, so a chip at
// the edge never spills onto the control bar. Text goes in with `textContent` only.

import { CELL, INSET } from '../../shared/geometry';
import { effectiveBox } from '../protocol/footprint';
import { machine_kind } from '../protocol/kinds';
import {
  CHIP_GAP_PX,
  chipName,
  labelWordsShown,
  LABEL_LINE_HEIGHT,
  LABEL_TEXT_INSET,
  namesChip,
  textAreaOf,
} from '../render/labelGeometry';
import type { CameraSnapshot, SceneHandle } from '../render/pixiApp';

/**
 * The zoom below which the name chips hide. At 0.4 a 32 px cell is under 13 screen px, so a
 * 12 px chip is wider than most machines it names and the chips pile on top of each other; a
 * board in a phone-width column reads better without them. Label words already hide below 0.75.
 */
export const CHIP_MIN_ZOOM = 0.4;

/** The node fields the overlay reads. */
interface OverlayNode {
  id: number;
  kind: number;
  cell_x: number;
  cell_y: number;
  w: number;
  h: number;
  rot: number;
  label?: { text: string; colour: number } | null;
}

export interface LabelOverlay {
  root: HTMLDivElement;
  /** How many chips and label word blocks the overlay holds. */
  counts(): { chips: number; words: number };
}

interface Entry {
  el: HTMLDivElement;
  id: number;
  words: boolean;
}

/** Build the overlay inside `stage` and drive it from the board's ticker. */
export function createLabelOverlay(stage: HTMLElement, handle: SceneHandle): LabelOverlay {
  const root = document.createElement('div');
  root.className = 'labels';
  root.setAttribute('aria-hidden', 'true');
  stage.append(root);

  let entries: Entry[] = [];
  let builtFor = -1;
  let builtNodes = -1;
  let last: { cam: CameraSnapshot; w: number; h: number } | null = null;

  const nodes = (): Map<number, OverlayNode> => handle.sceneState.nodes as unknown as Map<number, OverlayNode>;

  const rebuild = (): void => {
    const next: Entry[] = [];
    const sorted = [...nodes().values()].sort((a, b) => a.id - b.id);
    for (const n of sorted) {
      if (namesChip(n.kind)) {
        const el = document.createElement('div');
        el.className = 'chip';
        el.dataset.id = String(n.id);
        el.textContent = chipName(n.kind);
        next.push({ el, id: n.id, words: false });
      } else if (n.kind === machine_kind.LABEL && (n.label?.text ?? '') !== '') {
        const area = textAreaOf(n.w, n.h);
        const el = document.createElement('div');
        el.className = 'words';
        el.dataset.id = String(n.id);
        el.textContent = n.label?.text ?? '';
        el.style.width = `${area.width}px`;
        el.style.maxHeight = `${area.lines * LABEL_LINE_HEIGHT}px`;
        el.style.setProperty('-webkit-line-clamp', String(area.lines));
        next.push({ el, id: n.id, words: true });
      }
    }
    root.replaceChildren(...next.map((e) => e.el));
    entries = next;
    builtFor = handle.sceneState.keyframes;
    builtNodes = nodes().size;
    last = null;
  };

  const project = (): void => {
    if (handle.sceneState.keyframes !== builtFor || nodes().size !== builtNodes) rebuild();
    const cam = handle.cameraSnapshot();
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (last !== null && last.w === w && last.h === h && last.cam.x === cam.x && last.cam.y === cam.y && last.cam.scale === cam.scale) {
      return;
    }
    last = { cam, w, h };
    const map = nodes();
    for (const e of entries) {
      const n = map.get(e.id);
      if (n === undefined) {
        e.el.style.visibility = 'hidden';
        continue;
      }
      if (e.words) {
        const area = textAreaOf(n.w, n.h);
        const sx = (n.cell_x * CELL + LABEL_TEXT_INSET) * cam.scale + cam.x;
        const sy = (n.cell_y * CELL + LABEL_TEXT_INSET) * cam.scale + cam.y;
        e.el.style.transform = `translate(${sx}px, ${sy}px) scale(${cam.scale})`;
        const shown = labelWordsShown(cam.scale, { x: sx, y: sy, width: area.width * cam.scale, height: area.height * cam.scale }, w, h);
        e.el.style.visibility = shown ? 'visible' : 'hidden';
      } else {
        const { ew } = effectiveBox(n.w, n.h, n.rot);
        const sx = (n.cell_x + ew / 2) * CELL * cam.scale + cam.x;
        const sy = (n.cell_y * CELL + INSET) * cam.scale + cam.y;
        e.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, calc(-100% - ${CHIP_GAP_PX}px))`;
        e.el.style.visibility = cam.scale >= CHIP_MIN_ZOOM ? 'visible' : 'hidden';
      }
    }
  };

  project();
  handle.app.ticker.add(project);

  return {
    root,
    counts: () => ({
      chips: entries.filter((e) => !e.words).length,
      words: entries.filter((e) => e.words).length,
    }),
  };
}
