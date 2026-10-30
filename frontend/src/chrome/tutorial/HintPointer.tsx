// HintPointer.tsx - the ring that shows where the current stage wants the pointer.
//
// A DOM overlay positioned once a frame, never through React state, because the camera can move on
// any frame. `pointer-events: none` on the whole layer means the gesture the step asks for lands on
// the control or the floor under the ring.
//
// THE RING RECORDS WHICH STAGE IT WAS PLACED FOR, in `data-fab-hint-stage`. The layer's frame loop
// paints the ring first and works out the lesson second, so a stage change reaches the ring a frame
// after the lesson state has moved. Until then its rect belongs to the old stage. The attribute is
// what lets a reader tell the two apart, and only this file writes it.

import { useLayoutEffect, useRef, type JSX, type MutableRefObject, type RefObject } from 'react';
import { CELL } from '../../../shared/geometry';
import { KIND_NAMES } from '../../../shared/kindNames';
import type { HintAnchor } from '../../tutorial/types';
import { readCamera } from './cameraRead';

/** What the layer asks the ring to mark. `stageKey` is `stageKey(stepIndex, stage.id)` from the lesson machine. */
export interface HintTarget {
  stageKey: string;
  hint: HintAnchor | null;
  cell: readonly [number, number] | null;
}

/** Space between the target and the ring, on each side. */
const OUTSET_PX = 4;
/** Over the palette's bezel, under the refusal text at 5. */
const PANEL_TARGET_Z = '4';
/** With the name chips: a ring on the board is cut off by a panel it pans under. */
const BOARD_TARGET_Z = '1';

interface RingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: string;
}

/** A panel target's selector, by the control's accessible name, so a renamed control fails the walk. */
function panelSelector(target: Extract<HintAnchor, { on: 'panel' }>['target']): string {
  return target.kind === 'playButton'
    ? 'header button[aria-label="Play"]'
    : `button[aria-label="Place ${KIND_NAMES[target.machineKind]}"]`;
}

/** The ring's box in the layer's own coordinates, or null when the target resolves to nothing. */
function ringBox(target: HintTarget, layer: HTMLElement, stageBegan: boolean): RingBox | null {
  const hint = target.hint;
  if (hint === null) return null;
  if (hint.on === 'panel') {
    const control = document.querySelector<HTMLElement>(panelSelector(hint.target));
    if (control === null) return null;
    // Once, when the stage begins: a palette row can sit below the fold of its scrolling column.
    // This moves chrome only, so the camera and the board stay as they were.
    if (stageBegan) control.scrollIntoView({ block: 'nearest' });
    const r = control.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const origin = layer.getBoundingClientRect();
    return {
      x: r.left - origin.left - OUTSET_PX,
      y: r.top - origin.top - OUTSET_PX,
      width: r.width + 2 * OUTSET_PX,
      height: r.height + 2 * OUTSET_PX,
      zIndex: PANEL_TARGET_Z,
    };
  }
  const cam = readCamera();
  if (cam === null || target.cell === null) return null;
  const size = CELL * cam.scale;
  return {
    x: target.cell[0] * size + cam.x - OUTSET_PX,
    y: target.cell[1] * size + cam.y - OUTSET_PX,
    width: size + 2 * OUTSET_PX,
    height: size + 2 * OUTSET_PX,
    zIndex: BOARD_TARGET_Z,
  };
}

export interface HintPointerProps {
  /** Written by the layer's frame loop; null when there is no stage. */
  targetRef: RefObject<HintTarget | null>;
  /** Where the ring leaves its paint function, for the layer's frame loop to call. */
  paintRef: MutableRefObject<(() => void) | null>;
}

export function HintPointer({ targetRef, paintRef }: HintPointerProps): JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const lastStageRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const project = (): void => {
      const layer = layerRef.current;
      const ring = ringRef.current;
      if (layer === null || ring === null) return;
      const target = targetRef.current;
      const stageBegan = target !== null && target.stageKey !== lastStageRef.current;
      lastStageRef.current = target?.stageKey ?? null;
      const box = target === null ? null : ringBox(target, layer, stageBegan);
      if (target === null || box === null) {
        ring.style.visibility = 'hidden';
        ring.removeAttribute('data-fab-hint-stage');
      } else {
        layer.style.zIndex = box.zIndex;
        ring.style.transform = `translate(${box.x}px, ${box.y}px)`;
        ring.style.width = `${box.width}px`;
        ring.style.height = `${box.height}px`;
        ring.setAttribute('data-fab-hint-stage', target.stageKey);
        ring.style.visibility = 'visible';
      }
    };
    project();
    paintRef.current = project;
    return () => {
      paintRef.current = null;
    };
  }, [targetRef, paintRef]);

  return (
    <div
      ref={layerRef}
      data-fab-hint-layer=""
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {/* Hidden until the first write, so it never flashes at the origin. */}
      <div
        ref={ringRef}
        data-fab-hint=""
        style={{ position: 'absolute', top: 0, left: 0, willChange: 'transform', visibility: 'hidden' }}
      >
        {/* The paint, apart from the moving element, so a later pulse never touches the transform. */}
        <div className="fab-hint" />
      </div>
    </div>
  );
}
