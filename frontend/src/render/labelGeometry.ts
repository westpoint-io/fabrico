// labelGeometry.ts - the pure geometry and naming rules behind the board's two word
// overlays: a label's words (`chrome/LabelWords.tsx`) and the machine name chips
// (`chrome/MachineLabels.tsx`).
//
// They live here, outside `chrome/`, so a read-only board on a page can draw the same
// words and chips in the same places without its bundle carrying any React chrome. Nothing
// in this file imports React, Pixi or a module under `src/chrome/`; `labelGeometry.test.ts`
// reads the import lines and fails if one appears. The chrome files re-export every name
// moved here, so their callers and tests import what they imported before.
//
// The kind names come from `shared/kindNames.ts`, the one name table, which
// `chrome/kindNames.ts` also re-exports.

import type { SceneHandle } from './pixiApp';
import { CELL } from '../../shared/geometry';
import { KIND_NAMES } from '../../shared/kindNames';
import { machine_kind } from '../protocol/kinds';

/**
 * The zoom below which the words hide (UI-SPEC U-3), INCLUSIVE: shown at exactly 0.75. At
 * 0.75 the 12 world px words are 9 screen px, the smallest Martian Mono size that still
 * reads; below it the box alone carries the note.
 */
export const LABEL_WORDS_MIN_ZOOM = 0.75;

/** The text area's inset from the label's cell edges, world px (UI-SPEC 4.2). */
export const LABEL_TEXT_INSET = 8;
/** One line of words, world px: `2h - 1` lines fit a label `h` cells deep. */
export const LABEL_LINE_HEIGHT = 16;
/** The words' size, world px (equals `--fab-font-size-base` at zoom 1). */
export const LABEL_WORDS_SIZE = 12;

/** Gap in px between a name chip's bottom edge and its machine's top edge. */
export const CHIP_GAP_PX = 4;

/** One label's words as the overlay draws them: its handle, committed text and box. */
export interface LabelWordsEntry {
  id: number;
  text: string;
  w: number;
  h: number;
}

/** A NodeView-shaped record, only the fields the words overlay reads. */
export interface WordsNode {
  id: number;
  kind: number;
  cell_x: number;
  cell_y: number;
  w: number;
  h: number;
  label?: { text: string; colour: number } | null;
}

/**
 * Does this handle still name a LABEL (CR-01, plan 76-14)? The per-frame loop shows a
 * words element only over a label. A keyframe (undo, redo, load, New, a resync after a
 * `RenderProducer::reset`) can hand a label's handle to a machine, and the element set
 * only follows on React's next commit; on the frames in between, the old words would sit
 * over the machine. This guard runs on every frame and checks the KIND only, so a label
 * whose words change on an Apply keeps its element shown and never blinks.
 */
export function wordsNodeIsLabel(node: WordsNode | undefined): node is WordsNode {
  return node !== undefined && node.kind === machine_kind.LABEL;
}

/**
 * Does this words element show THIS label's words in THIS label's box (CR-01, the 76-14
 * refuter round)? A keyframe can also hand a label's handle to ANOTHER label: the host's
 * `RenderProducer::reset` mints handles 0, 1, 2 ... in NodeId order, so deleting one label
 * and then any Undo or Redo moves every later label down a handle. The kind guard passes
 * such an element, and on the frames before React commits it would show the old label's
 * words, laid out for the old box, on the new label's cell. Read off the element itself
 * (what is painted), never the entry list (what React was asked for).
 *
 * The loop applies this only between a `SceneState.keyframes` move and the first frame on
 * which every element agrees with its label. An Apply is a diff, never a keyframe, so its
 * words still change in place without a blink.
 */
export function wordsElementShowsNode(el: HTMLElement, node: WordsNode): boolean {
  const area = textAreaOf(node.w, node.h);
  return (
    el.textContent === (node.label?.text ?? '') &&
    el.style.width === `${area.width}px` &&
    el.style.maxHeight === `${area.lines * LABEL_LINE_HEIGHT}px`
  );
}

/** Every label carrying words, by id, from the live handle. Empty text draws nothing. */
export function readLabelWords(handle: SceneHandle | null): LabelWordsEntry[] {
  const out: LabelWordsEntry[] = [];
  const nodes = handle?.sceneState.nodes as Map<number, WordsNode> | undefined;
  if (!nodes) return out;
  for (const n of nodes.values()) {
    if (n.kind !== machine_kind.LABEL) continue;
    const text = n.label?.text ?? '';
    if (text === '') continue;
    out.push({ id: n.id, text, w: n.w, h: n.h });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** The text area of a label `w` by `h` cells, in WORLD px relative to its top-left cell
 *  corner: inset 8 on every side, so `32w - 16` by `32h - 16`. */
export function textAreaOf(w: number, h: number): { width: number; height: number; lines: number } {
  return {
    width: CELL * w - 2 * LABEL_TEXT_INSET,
    height: CELL * h - 2 * LABEL_TEXT_INSET,
    lines: Math.max(1, 2 * h - 1),
  };
}

/**
 * Are a label's words shown at this camera? False below the zoom threshold (inclusive at
 * 0.75) and when the label's text area, projected to the screen, lies wholly outside the
 * `viewW` by `viewH` overlay.
 */
export function labelWordsShown(
  scale: number,
  screen: { x: number; y: number; width: number; height: number },
  viewW: number,
  viewH: number,
): boolean {
  if (scale < LABEL_WORDS_MIN_ZOOM) return false;
  return (
    screen.x < viewW && screen.y < viewH && screen.x + screen.width > 0 && screen.y + screen.height > 0
  );
}

/** Does a node of `kind` get a name chip? Every machine; never a belt or a label. */
export function namesChip(kind: number): boolean {
  return kind !== machine_kind.BELT && kind !== machine_kind.LABEL;
}

/**
 * Does this node still match a chip drawn for `kind` (CR-01, plan 76-14)? Present, a kind
 * that gets a chip, and the SAME kind the chip names. A keyframe (undo, redo, load, New, a
 * resync after a `RenderProducer::reset`) can hand a machine's handle to a label, to
 * another kind, or to nothing, and the chip set only follows on React's next commit. On
 * the frames in between a chip failing this is hidden, so no name ever sits over the
 * wrong node; an absent node fails it, so a deleted machine's chip hides on that frame too.
 */
export function chipMatchesNode<N extends { kind: number }>(kind: number, node: N | undefined): node is N {
  return node !== undefined && namesChip(node.kind) && node.kind === kind;
}

/**
 * The words a name chip shows for `kind`. `KIND_NAMES` names every kind a chip can meet;
 * the 'Machine' fallback catches WIRE (kind 8), a transport seam that should never reach a
 * chip list, so a stray one reads as a machine rather than as an empty box.
 */
export function chipName(kind: number): string {
  return KIND_NAMES[kind] ?? 'Machine';
}
