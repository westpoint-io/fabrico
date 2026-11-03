// LabelWords.tsx - the words on the board, a DOM overlay over the canvas (phase 76, plan
// 76-02, SHAPE-10, D-06, 76-UI-SPEC section 4).
//
// A label's BOX is canvas art (machines.ts); its WORDS are this overlay. Text in the DOM
// is what lets a live spec read the words that are actually on screen, so "the words are
// on screen" is a claim that can fail (memory fabrico-model-oracle-blindspot), and it
// gets the browser's text shaping, wrapping and font for free.
//
// Built the way `MachineLabels.tsx` is: ONE batched requestAnimationFrame reads the
// READ-ONLY camera snapshot from the `readCamera` prop (consumed one-way, never set) and the
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
import type { CameraSnapshot, SceneHandle } from '../render/pixiApp';
import { CELL } from '../../shared/geometry';
import {
  LABEL_LINE_HEIGHT,
  LABEL_TEXT_INSET,
  LABEL_WORDS_SIZE,
  labelWordsShown,
  readLabelWords,
  textAreaOf,
  wordsElementShowsNode,
  wordsNodeIsLabel,
  type LabelWordsEntry,
  type WordsNode,
} from '../render/labelGeometry';

// The pure rules moved to `render/labelGeometry.ts` so a read-only board can use them
// without importing chrome. Re-exported here so every existing import keeps working.
export {
  LABEL_LINE_HEIGHT,
  LABEL_TEXT_INSET,
  LABEL_WORDS_MIN_ZOOM,
  LABEL_WORDS_SIZE,
  labelWordsShown,
  readLabelWords,
  textAreaOf,
  wordsElementShowsNode,
  wordsNodeIsLabel,
  type LabelWordsEntry,
  type WordsNode,
} from '../render/labelGeometry';

export interface LabelWordsProps {
  /** The live scene handle ref (App's handleRef) - the authoritative NodeView map. */
  handleRef: RefObject<SceneHandle | null>;
  /**
   * Reads this board's camera: a fresh `{ x, y, scale }` each call, or null before the
   * scene is up. The App passes its own handle's `cameraSnapshot()`, so the words follow
   * the board they sit on. Read-only: nothing the overlay holds can move the camera.
   */
  readCamera: () => CameraSnapshot | null;
}

/** A stable signature so React state moves only when an id, a text or a size changes. */
function wordsSig(list: readonly LabelWordsEntry[]): string {
  return JSON.stringify(list);
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

export function LabelWords({ handleRef, readCamera }: LabelWordsProps): JSX.Element {
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
      const cam = readCamera();
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
    // `readCamera` is a dependency so a new reader restarts the loop; the App passes a
    // stable one, so in the app this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleRef, readCamera]);

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
