// LabelWords.tsx - the words on the board, a DOM overlay over the canvas (phase 76, plan
// 76-02, SHAPE-10, D-06, 76-UI-SPEC section 4).
//
// A label's BOX is canvas art (machines.ts); its WORDS are this overlay. Text in the DOM
// is what lets a live spec read the words that are actually on screen, so "the words are
// on screen" is a claim that can fail (memory fabrico-model-oracle-blindspot), and it
// gets the browser's text shaping, wrapping and font for free.
//
// Built the way `MachineLabels.tsx` is: ONE batched requestAnimationFrame reads the
// READ-ONLY `window.__fabrico.camera()` snapshot (consumed one-way, never set) and the
// live `sceneState.nodes`, and writes each label's CSS `transform` imperatively. Positions
// are NEVER React state (that would re-render the tree at 60fps); the only React state is
// the low-frequency id, text and size LIST, which changes on edits. The words are a React
// TEXT CHILD and never inner HTML, so markup a user types reads back as the characters
// they typed (threat T-76-04).
//
// Differences from `MachineLabels`, each a UI-SPEC rule:
//   - ALWAYS MOUNTED (a label's words are not an alt-mode reveal);
//   - `z-index: 1`, under the Alt-hold chips and the panels at 2;
//   - laid out at WORLD size and scaled by the camera, so line breaks are fixed in world
//     units and the same words break at the same places at every zoom (UI-SPEC 4.2);
//   - HIDDEN (`visibility: hidden`) below `LABEL_WORDS_MIN_ZOOM`, while the box is wholly
//     off screen, and before its first transform (the no-origin-flash rule);
//   - NO element at all for a label with empty text.
//
// The board shows the COMMITTED words only (U-7): the text comes off the render packet,
// which carries what the host folded, never the panel's buffer.

import { useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react';
import type { SceneHandle } from '../render/pixiApp';
import { CELL } from '../../shared/geometry';
import { machine_kind } from '../protocol/kinds';

export interface LabelWordsProps {
  /** The live scene handle ref (App's handleRef) - the authoritative NodeView map. */
  handleRef: RefObject<SceneHandle | null>;
}

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

/** One label's words as the overlay draws them: its handle, committed text and box. */
export interface LabelWordsEntry {
  id: number;
  text: string;
  w: number;
  h: number;
}

/** A NodeView-shaped record, only the fields this overlay reads. */
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

/** A stable signature so React state moves only when an id, a text or a size changes. */
function wordsSig(list: readonly LabelWordsEntry[]): string {
  return JSON.stringify(list);
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

/** The per-label style that changes only with its size: world-px box, clamp, wrapping. */
function wordsStyle(e: LabelWordsEntry): CSSProperties {
  const area = textAreaOf(e.w, e.h);
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    transformOrigin: '0 0',
    willChange: 'transform',
    pointerEvents: 'none',
    // Hidden until the first transform is written (the MachineLabels no-origin-flash rule).
    visibility: 'hidden',
    width: area.width,
    maxHeight: area.lines * LABEL_LINE_HEIGHT,
    overflow: 'hidden',
    fontFamily: 'var(--fab-font)',
    fontSize: LABEL_WORDS_SIZE,
    lineHeight: `${LABEL_LINE_HEIGHT}px`,
    color: 'var(--fab-ink)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: area.lines,
  };
}

export function LabelWords({ handleRef }: LabelWordsProps): JSX.Element {
  // The LOW-FREQUENCY list, seeded synchronously from the live handle so the first paint
  // already has its elements (positioned pre-paint by the layout effect below).
  const [entries, setEntries] = useState<LabelWordsEntry[]>(() => readLabelWords(handleRef.current));
  const elRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    let raf = 0;
    let lastSig = wordsSig(entries);
    // CR-01 (76-14 refuter round): the last `SceneState.keyframes` seen, and whether a
    // keyframe has landed whose remints React has not yet caught up with. Read
    // defensively: a fixture scene carries no count, which reads as 0 and never moves.
    const keyframesOf = (): number =>
      (handleRef.current?.sceneState as { keyframes?: number } | undefined)?.keyframes ?? 0;
    let lastKeyframes = keyframesOf();
    let unsettled = false;
    const project = (): void => {
      const cam = window.__fabrico?.camera();
      const nodes = handleRef.current?.sceneState.nodes as Map<number, WordsNode> | undefined;
      const root = rootRef.current;
      if (cam && nodes && root) {
        // Re-sync the element set only when a label's id, words or size change.
        const list = readLabelWords(handleRef.current);
        const sig = wordsSig(list);
        if (sig !== lastSig) {
          lastSig = sig;
          setEntries(list);
        }
        const keyframes = keyframesOf();
        if (keyframes !== lastKeyframes) {
          lastKeyframes = keyframes;
          unsettled = true;
        }
        let disagree = false;
        const viewW = root.clientWidth;
        const viewH = root.clientHeight;
        for (const [id, el] of elRefs.current) {
          const n = nodes.get(id);
          // CR-01: hidden on the very frame its handle stops naming a label (gone, or
          // reminted to a machine by a keyframe), before React drops the element.
          if (!wordsNodeIsLabel(n)) {
            el.style.visibility = 'hidden';
            continue;
          }
          // CR-01, label to label: after a keyframe, hidden while it shows another
          // label's words or box, until React's commit makes them this label's.
          if (unsettled && !wordsElementShowsNode(el, n)) {
            disagree = true;
            el.style.visibility = 'hidden';
            continue;
          }
          const area = textAreaOf(n.w, n.h);
          const wx = n.cell_x * CELL + LABEL_TEXT_INSET;
          const wy = n.cell_y * CELL + LABEL_TEXT_INSET;
          const sx = wx * cam.scale + cam.x;
          const sy = wy * cam.scale + cam.y;
          el.style.transform = `translate(${sx}px, ${sy}px) scale(${cam.scale})`;
          const shown = labelWordsShown(
            cam.scale,
            { x: sx, y: sy, width: area.width * cam.scale, height: area.height * cam.scale },
            viewW,
            viewH,
          );
          el.style.visibility = shown ? 'visible' : 'hidden';
        }
        // Settled: every element now shows its own label, so later Applies go unguarded.
        if (!disagree) unsettled = false;
      }
      raf = requestAnimationFrame(project);
    };
    project();
    return () => cancelAnimationFrame(raf);
    // Mount-once: the loop reads the live handle and camera every frame. `entries` is
    // intentionally excluded (positions are imperative; the list re-syncs in the loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleRef]);

  return (
    <div
      ref={rootRef}
      aria-hidden
      style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {entries.map((e) => (
        <div
          key={e.id}
          data-testid="label-words"
          data-node={e.id}
          ref={(el) => {
            if (el) elRefs.current.set(e.id, el);
            else elRefs.current.delete(e.id);
          }}
          style={wordsStyle(e)}
        >
          {e.text}
        </div>
      ))}
    </div>
  );
}
