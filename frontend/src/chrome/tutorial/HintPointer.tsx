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

import { useLayoutEffect, useRef, type JSX, type MutableRefObject, type RefObject } from 'react';
import { CELL, nubAnchor } from '../../../shared/geometry';
import { KIND_NAMES } from '../../../shared/kindNames';
import { effectiveBox } from '../../protocol/footprint';
import { machine_kind } from '../../protocol/kinds';
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
/** A port ring's diameter, fixed on screen: `--fab-space-xl`. A later plan sizes it to the exact hit area. */
const PORT_RING_PX = 32;
/** The wire's port roles (`NodeView.ports[].role`): In=0, Out=1, Fault=2. A Sink's fault dot is never a target. */
const PORT_ROLE: Readonly<Record<PortRoleName, number>> = { in: 0, out: 1 };

interface RingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: string;
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

/** A 32 px circle centred on a bound machine's port dot, through the camera. */
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
  const anchor = nubAnchor(port.cell_x, port.cell_y, port.side);
  return {
    x: anchor.x * cam.scale + cam.x - PORT_RING_PX / 2,
    y: anchor.y * cam.scale + cam.y - PORT_RING_PX / 2,
    width: PORT_RING_PX,
    height: PORT_RING_PX,
    zIndex: BOARD_TARGET_Z,
  };
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
  ring.style.visibility = 'visible';
}

export function HintPointer({ handleRef, targetRef, paintRef }: HintPointerProps): JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const ringToRef = useRef<HTMLDivElement | null>(null);
  const paintElRef = useRef<HTMLDivElement | null>(null);
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
      if (paintElRef.current !== null) paintElRef.current.className = hint?.on === 'port' ? 'fab-hint fab-hint--port' : 'fab-hint';
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
      {/* Where a drag ends. Only a port is ever a drag's far end, so its paint is always the circle. */}
      <div
        ref={ringToRef}
        data-fab-hint-to=""
        style={{ position: 'absolute', top: 0, left: 0, willChange: 'transform', visibility: 'hidden' }}
      >
        <div className="fab-hint fab-hint--port" />
      </div>
    </div>
  );
}
