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
//
// A DRAG HAS TWO RINGS, and one paint call writes both with that attribute. If either target resolves
// to nothing, both hide and the attribute goes, so a drag stage never shows half its rings.
//
// A PORT RING IS THE SIZE OF THE SPOT THE GESTURE ACCEPTS, and its shape follows the port's role. An
// In port is where a drag ends, so its ring is a disc whose inner edge is the belt release's hit
// circle (`dropHitRadiusWorld`, the radius `headInAt` passes). An Out port is where a drag starts,
// and the press check accepts its whole doorstep cell, so its ring is a square around that cell.
// A disc's moving element carries `data-fab-hit-r`, the hit radius in CSS px as painted this frame.

import { useLayoutEffect, useRef, type JSX, type MutableRefObject, type RefObject } from 'react';
import { CELL, nubAnchor } from '../../../shared/geometry';
import { KIND_NAMES } from '../../../shared/kindNames';
import type { PortView } from '../../protocol/decode';
import { effectiveBox } from '../../protocol/footprint';
import { machine_kind } from '../../protocol/kinds';
import { doorstepCell, dropHitRadiusWorld } from '../../protocol/ports';
import type { SceneHandle } from '../../render/pixiApp';
import type { BoundNode, TutorialState } from '../../tutorial/machine';
import type { BindingName, HintAnchor, PanelTarget, PortRoleName } from '../../tutorial/types';
import { readCamera } from './cameraRead';

/** What the layer asks the ring to mark. `stageKey` is `stageKey(stepIndex, stage.id)` from the lesson machine. */
export interface HintTarget {
  stageKey: string;
  hint: HintAnchor | null;
  cell: readonly [number, number] | null;
  bindings: TutorialState['bindings'];
}

/** Space between the target and the ring, on each side. */
const OUTSET_PX = 4;
/** Over the palette's bezel, under the refusal text at 5. */
const PANEL_TARGET_Z = '4';
/** With the name chips: a ring on the board is cut off by a panel it pans under. */
const BOARD_TARGET_Z = '1';
/** The ring's border width (`.fab-hint`). A disc's border draws outside the hit circle. */
const BORDER_PX = 2;
/** The wire's port roles (`NodeView.ports[].role`): In=0, Out=1, Fault=2. A Sink's fault dot is never a target. */
const PORT_ROLE: Readonly<Record<PortRoleName, number>> = { in: 0, out: 1 };

/** A box in the layer's coordinates, which are the window's for a board target. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The camera as `readCamera` gives it: pan in CSS px and the scale. */
export interface Cam {
  x: number;
  y: number;
  scale: number;
}

/** A drop disc: its border box, plus the hit circle its inner edge sits on, in CSS px. */
export interface DiscBox extends Box {
  hitRadiusPx: number;
  hitCentre: { x: number; y: number };
}

interface RingBox extends Box {
  zIndex: string;
  /** Set for a disc only: the hit radius in CSS px, written to `data-fab-hit-r`. */
  hitRadiusPx?: number;
}

/**
 * The ring where a drag ends, on an In port's dot at `anchor` (world px): a disc whose inner edge is
 * the belt release's hit circle. Its border box is `2r + 4` across, so the 2 px border draws outside.
 */
export function dropDiscBox(anchor: { x: number; y: number }, cam: Cam): DiscBox {
  const r = dropHitRadiusWorld(cam.scale) * cam.scale;
  const d = 2 * r + 2 * BORDER_PX;
  const cx = anchor.x * cam.scale + cam.x;
  const cy = anchor.y * cam.scale + cam.y;
  return { x: cx - d / 2, y: cy - d / 2, width: d, height: d, hitRadiusPx: r, hitCentre: { x: cx, y: cy } };
}

/**
 * The ring where a drag starts, on an Out port: a square around the port's doorstep cell plus the
 * outset each side, because the press check accepts a press anywhere on that cell.
 */
export function doorstepSquareBox(port: Pick<PortView, 'cell_x' | 'cell_y' | 'side'>, cam: Cam): Box {
  const [cx, cy] = doorstepCell(port);
  const size = CELL * cam.scale;
  return {
    x: cx * size + cam.x - OUTSET_PX,
    y: cy * size + cam.y - OUTSET_PX,
    width: size + 2 * OUTSET_PX,
    height: size + 2 * OUTSET_PX,
  };
}

/** The first button under `root` whose whole text reads `word`. */
function buttonReading(root: Element | null, word: string): HTMLElement | null {
  if (root === null) return null;
  return [...root.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === word) ?? null;
}

/** A panel target's control, by its name or its state, so a renamed control fails the walk. */
function panelControl(target: PanelTarget): HTMLElement | null {
  switch (target.kind) {
    case 'playButton':
      return document.querySelector<HTMLElement>('header button[aria-label="Play"]');
    case 'placeMachine':
      return document.querySelector<HTMLElement>(`button[aria-label="Place ${KIND_NAMES[target.machineKind]}"]`);
    case 'armedTool':
      return document.querySelector<HTMLElement>('[data-fab-left-dock] button.is-armed');
    case 'beltTool':
      return buttonReading(document.querySelector('[data-fab-left-dock]'), KIND_NAMES[machine_kind.BELT] as string);
    case 'segment':
      return buttonReading(document.querySelector(`[role="group"][aria-label="${target.group}"]`), target.label);
    case 'applyButton':
      return buttonReading(document.querySelector('aside[aria-labelledby="fab-config-heading"]'), 'Apply');
  }
}

type SceneNodes = NonNullable<SceneHandle['sceneState']>['nodes'];

/**
 * The bound machine as it stands now, or null. A keyframe can hand a handle to another kind or to
 * nothing and the binding follows a frame later, so the node has to still read the kind in its key.
 */
function boundNode(nodes: SceneNodes | undefined, bound: BoundNode | undefined) {
  if (nodes === undefined || bound === undefined) return null;
  const node = nodes.get(bound.id);
  if (node === undefined || String(node.kind) !== bound.nodeKey.split('@')[0]) return null;
  return node;
}

/** A bound machine's port ring through the camera: a disc on an In port's dot, a square on an Out port's doorstep. */
function portBox(
  nodes: SceneNodes | undefined,
  bindings: TutorialState['bindings'],
  of: BindingName,
  role: PortRoleName,
): RingBox | null {
  const node = boundNode(nodes, bindings[of]);
  const cam = readCamera();
  if (node === null || cam === null) return null;
  const port = node.ports.find((p) => p.role === PORT_ROLE[role]);
  if (port === undefined) return null;
  if (role === 'out') return { ...doorstepSquareBox(port, cam), zIndex: BOARD_TARGET_Z };
  const disc = dropDiscBox(nubAnchor(port.cell_x, port.cell_y, port.side), cam);
  return { x: disc.x, y: disc.y, width: disc.width, height: disc.height, zIndex: BOARD_TARGET_Z, hitRadiusPx: disc.hitRadiusPx };
}

/**
 * The paint class for a ring: the disc's for a port ring on an In port, the square's for anything else, and
 * the shallower pulse for a ring on a panel, where the blue has less contrast to spare.
 */
function paintClass(on: HintAnchor['on'] | null, role: PortRoleName | null): string {
  if (on === 'panel') return 'fab-hint fab-hint--panel';
  return role === 'in' ? 'fab-hint fab-hint--port' : 'fab-hint';
}

/**
 * The part of a control its scrolling ancestors still show, or null when they show none of it. The
 * ring goes around this part, because the rest can't take a press and a ring around all of it would
 * float over whatever sits past the column's edge.
 */
function shownPart(control: HTMLElement): { left: number; top: number; right: number; bottom: number } | null {
  let { left, top, right, bottom } = control.getBoundingClientRect();
  for (let el = control.parentElement; el !== null; el = el.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(el);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    const box = el.getBoundingClientRect();
    const clipLeft = box.left + el.clientLeft;
    const clipTop = box.top + el.clientTop;
    left = Math.max(left, clipLeft);
    top = Math.max(top, clipTop);
    right = Math.min(right, clipLeft + el.clientWidth);
    bottom = Math.min(bottom, clipTop + el.clientHeight);
  }
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** The ring's box in the layer's own coordinates, or null when the target resolves to nothing. */
function ringBox(target: HintTarget, layer: HTMLElement, stageBegan: boolean, nodes: SceneNodes | undefined): RingBox | null {
  const hint = target.hint;
  if (hint === null) return null;
  if (hint.on === 'panel') {
    const control = panelControl(hint.target);
    if (control === null) return null;
    // Once, when the stage begins: a palette row can sit below the fold of its scrolling column.
    // This moves chrome only, so the camera and the board stay as they were.
    if (stageBegan) control.scrollIntoView({ block: 'nearest' });
    const shown = shownPart(control);
    if (shown === null) return null;
    const origin = layer.getBoundingClientRect();
    return {
      x: shown.left - origin.left - OUTSET_PX,
      y: shown.top - origin.top - OUTSET_PX,
      width: shown.right - shown.left + 2 * OUTSET_PX,
      height: shown.bottom - shown.top + 2 * OUTSET_PX,
      zIndex: PANEL_TARGET_Z,
    };
  }
  if (hint.on === 'port') return portBox(nodes, target.bindings, hint.of, hint.role);
  const cam = readCamera();
  if (cam === null) return null;
  const size = CELL * cam.scale;
  if (hint.on === 'machine') {
    const node = boundNode(nodes, target.bindings[hint.of]);
    if (node === null) return null;
    const { ew, eh } = effectiveBox(node.w, node.h, node.rot);
    return {
      x: node.cell_x * size + cam.x - OUTSET_PX,
      y: node.cell_y * size + cam.y - OUTSET_PX,
      width: ew * size + 2 * OUTSET_PX,
      height: eh * size + 2 * OUTSET_PX,
      zIndex: BOARD_TARGET_Z,
    };
  }
  if (target.cell === null) return null;
  return {
    x: target.cell[0] * size + cam.x - OUTSET_PX,
    y: target.cell[1] * size + cam.y - OUTSET_PX,
    width: size + 2 * OUTSET_PX,
    height: size + 2 * OUTSET_PX,
    zIndex: BOARD_TARGET_Z,
  };
}

export interface HintPointerProps {
  handleRef: RefObject<SceneHandle | null>;
  /** Written by the layer's frame loop; null when there is no stage. */
  targetRef: RefObject<HintTarget | null>;
  /** Where the ring leaves its paint function, for the layer's frame loop to call. */
  paintRef: MutableRefObject<(() => void) | null>;
}

function writeRing(ring: HTMLElement, box: RingBox): void {
  ring.style.transform = `translate(${box.x}px, ${box.y}px)`;
  ring.style.width = `${box.width}px`;
  ring.style.height = `${box.height}px`;
  if (box.hitRadiusPx === undefined) ring.removeAttribute('data-fab-hit-r');
  else ring.setAttribute('data-fab-hit-r', String(box.hitRadiusPx));
  ring.style.visibility = 'visible';
}

export function HintPointer({ handleRef, targetRef, paintRef }: HintPointerProps): JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const ringToRef = useRef<HTMLDivElement | null>(null);
  const paintElRef = useRef<HTMLDivElement | null>(null);
  const paintToElRef = useRef<HTMLDivElement | null>(null);
  const lastStageRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const project = (): void => {
      const layer = layerRef.current;
      const ring = ringRef.current;
      const ringTo = ringToRef.current;
      if (layer === null || ring === null || ringTo === null) return;
      const target = targetRef.current;
      const stageBegan = target !== null && target.stageKey !== lastStageRef.current;
      lastStageRef.current = target?.stageKey ?? null;
      const nodes = handleRef.current?.sceneState.nodes;
      const box = target === null ? null : ringBox(target, layer, stageBegan, nodes);
      const hint = target?.hint;
      const to = hint?.on === 'port' ? hint.to : undefined;
      const toBox = target !== null && to !== undefined ? portBox(nodes, target.bindings, to.of, to.role) : null;
      if (target === null || box === null || (to !== undefined && toBox === null)) {
        ring.style.visibility = 'hidden';
        ringTo.style.visibility = 'hidden';
        ring.removeAttribute('data-fab-hint-stage');
        return;
      }
      layer.style.zIndex = box.zIndex;
      writeRing(ring, box);
      if (toBox === null) ringTo.style.visibility = 'hidden';
      else writeRing(ringTo, toBox);
      if (paintElRef.current !== null) paintElRef.current.className = paintClass(hint?.on ?? null, hint?.on === 'port' ? hint.role : null);
      if (paintToElRef.current !== null) paintToElRef.current.className = paintClass(to === undefined ? null : 'port', to?.role ?? null);
      ring.setAttribute('data-fab-hint-stage', target.stageKey);
    };
    project();
    paintRef.current = project;
    return () => {
      paintRef.current = null;
    };
  }, [handleRef, targetRef, paintRef]);

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
        <div ref={paintElRef} className="fab-hint" />
      </div>
      {/* Where a drag ends. Its paint follows the far port's role, the same rule as the main ring. */}
      <div
        ref={ringToRef}
        data-fab-hint-to=""
        style={{ position: 'absolute', top: 0, left: 0, willChange: 'transform', visibility: 'hidden' }}
      >
        <div ref={paintToElRef} className="fab-hint fab-hint--port" />
      </div>
    </div>
  );
}
