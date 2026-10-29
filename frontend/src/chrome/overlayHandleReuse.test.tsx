// @vitest-environment jsdom
//
// overlayHandleReuse.test.tsx (CR-01, plan 76-14) - the two DOM overlays on the frame
// between a keyframe and React's commit.
//
// THE DEFECT. The host mints node, belt and wire handles from ONE counter
// (`render_packet.rs`, the handle mint), and a keyframe (undo, redo, load, New, a scene
// swap, a resync after a `RenderProducer::reset`) can restart it. So after a keyframe a
// handle may name a different node, even one of another kind. `LabelWords` and
// `MachineLabels` both keep a DOM element per handle and position it every animation
// frame from the live `sceneState.nodes`; the element SET only follows on React's next
// commit. On the frames in between:
//   - `LabelWords` hid an element only when its handle was ABSENT, so a deleted label's
//     words were moved over the machine that took its handle and shown;
//   - `MachineLabels` iterated the nodes, never its chip elements, so a chip whose handle
//     became a label, another kind or nothing kept its last place and stayed visible.
//
// WHY jsdom, AND WHY OUTSIDE act. A polled live check cannot see a window one frame wide
// (76-08-SUMMARY.md, refuter finding 8). Here `requestAnimationFrame` is captured, so the
// test drives exactly one frame by hand, OUTSIDE act, the way the browser runs it: the
// overlay's setState is only scheduled when the frame returns, so the old element is
// still in the DOM and its visibility is the in-between frame's. Every case asserts the
// element is still there (else the read would be of nothing) and opens with a POSITIVE
// CONTROL on the very element it later reads hidden.
//
// THE HARNESS. jsdom has no layout, so every element reports a client size of 0, and
// `LabelWords` hides any element whose box lies outside a 0 by 0 overlay: every hidden
// read would pass vacuously. The client size is pinned to 1280 by 800 and each case
// checks it (HARNESS) before driving a frame, with the camera stub defined. The file
// imports only the two components, never their predicates, so either component at its
// pre-fix revision still compiles under it (plan 76-14 Task 3, mutations O1 and O2).
//
// RED AT the instrument commit: see 76-14-SUMMARY.md.

import { act, type ReactElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelWords } from './LabelWords.tsx';
import { MachineLabels } from './MachineLabels.tsx';
import { machine_kind } from '../protocol/kinds.ts';
import type { SceneHandle } from '../render/pixiApp.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const VIEW_W = 1280;
const VIEW_H = 800;

type FakeNode = Record<string, unknown>;

/** A label node, the fields `LabelWords` reads. */
const labelNode = (id: number, cx: number, cy: number, text: string): FakeNode => ({
  id,
  kind: machine_kind.LABEL,
  cell_x: cx,
  cell_y: cy,
  w: 4,
  h: 1,
  rot: 0,
  state: 0,
  label: { text, colour: 0 },
});

/** A machine node, the fields `MachineLabels` reads. */
const machineNode = (id: number, kind: number, cx: number, cy: number): FakeNode => ({
  id,
  kind,
  cell_x: cx,
  cell_y: cy,
  w: 1,
  h: 1,
  rot: 0,
  state: 0,
});

let container: HTMLDivElement;
let root: Root;
let frame: FrameRequestCallback | null = null;
let nodes: Map<number, FakeNode>;
let handleRef: RefObject<SceneHandle | null>;
const savedWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => VIEW_W });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => VIEW_H });
  frame = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    frame = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (): void => {});
  window.__fabrico = {
    camera: () => ({ x: 0, y: 0, scale: 1 }),
  } as unknown as Window['__fabrico'];
  nodes = new Map();
  handleRef = { current: { sceneState: { nodes } } as unknown as SceneHandle };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  act(() => root.unmount());
  container.remove();
  delete window.__fabrico;
  vi.unstubAllGlobals();
  for (const [name, saved] of [
    ['clientWidth', savedWidth],
    ['clientHeight', savedHeight],
  ] as const) {
    if (saved) Object.defineProperty(HTMLElement.prototype, name, saved);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

/** Put `entries` on the live handle, replacing what was there (a keyframe's clear). */
function setNodes(...entries: FakeNode[]): void {
  nodes.clear();
  for (const n of entries) nodes.set(n.id as number, n);
}

/** Mount an overlay; its layout effect runs the first frame synchronously. */
function mount(el: ReactElement): void {
  act(() => root.render(el));
}

/** HARNESS: a laid-out overlay root and a camera, else every hidden read is vacuous. */
function expectHarness(): void {
  const overlay = container.firstElementChild as HTMLElement | null;
  expect(overlay, 'HARNESS: the overlay root is mounted').not.toBeNull();
  expect(overlay!.clientWidth, 'HARNESS: the overlay root has a 1280 px client width').toBe(VIEW_W);
  expect(window.__fabrico?.camera, 'HARNESS: the camera stub is defined').toBeDefined();
  expect(frame, 'HARNESS: the overlay requested its next frame').not.toBeNull();
}

/**
 * Run the captured frame OUTSIDE act, as the browser does. The overlay's setState is
 * only scheduled, so React has not committed when this returns: the in-between frame.
 */
function runFrameOutsideAct(): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const f = frame;
  frame = null;
  f!(0);
}

/** Let React commit the scheduled update, then go back to act mode. */
async function letReactCommit(settled: () => void): Promise<void> {
  await vi.waitFor(settled);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

const wordsEl = (id: number): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-node="${id}"]`);

const chipReading = (text: string): HTMLElement | undefined =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="machine-label"]')].find(
    (el) => el.textContent === text,
  );

describe('LabelWords on the frame its handle changes (CR-01)', () => {
  it('label_words_hide_the_frame_their_handle_becomes_a_machine', async () => {
    setNodes(labelNode(0, 10, 12, 'Order intake'));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    const el = wordsEl(0);
    expect(el?.textContent, 'POSITIVE CONTROL: the words are mounted').toBe('Order intake');
    expect(el!.style.visibility, 'POSITIVE CONTROL: the words are visible').toBe('visible');

    // A keyframe hands handle 0 to a Source.
    setNodes(machineNode(0, machine_kind.SOURCE, 20, 12));
    runFrameOutsideAct();
    expect(el!.isConnected, 'the in-between frame: React has not committed').toBe(true);
    expect(el!.style.visibility, "the deleted label's words are hidden over the Source").toBe('hidden');

    await letReactCommit(() => expect(wordsEl(0), 'after the commit the element is gone').toBeNull());
  });

  it('label_words_stay_shown_the_frame_their_words_change', async () => {
    setNodes(labelNode(0, 10, 12, 'Order intake'));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    const el = wordsEl(0);
    expect(el!.style.visibility, 'POSITIVE CONTROL: the words are visible').toBe('visible');

    // An Apply that changes the words: still a label, so no blink.
    setNodes(labelNode(0, 10, 12, 'Order shipped'));
    runFrameOutsideAct();
    expect(el!.isConnected, 'the in-between frame: React has not committed').toBe(true);
    expect(el!.style.visibility, 'a label whose words change stays shown on that frame').toBe('visible');

    await letReactCommit(() => expect(wordsEl(0)?.textContent).toBe('Order shipped'));
    expect(wordsEl(0)!.style.visibility, 'and after the commit').toBe('visible');
  });
});

describe('MachineLabels on the frame its handle changes (CR-01)', () => {
  it('a_name_chip_hides_the_frame_its_handle_becomes_a_label', () => {
    setNodes(machineNode(0, machine_kind.SOURCE, 4, 4), machineNode(1, machine_kind.SINK, 8, 4));
    mount(<MachineLabels handleRef={handleRef} />);
    expectHarness();
    const source = chipReading('Source');
    const sink = chipReading('Sink');
    expect(source?.style.visibility, 'POSITIVE CONTROL: the Source chip is visible').toBe('visible');
    expect(sink?.style.visibility, 'POSITIVE CONTROL: the Sink chip is visible').toBe('visible');

    // A keyframe hands handle 0 to a label.
    setNodes(labelNode(0, 4, 4, 'Order intake'), machineNode(1, machine_kind.SINK, 8, 4));
    runFrameOutsideAct();
    expect(source!.isConnected, 'the in-between frame: React has not committed').toBe(true);
    expect(source!.style.visibility, 'the Source chip is hidden over the label').toBe('hidden');
    expect(sink!.style.visibility, 'the Sink chip, unchanged, stays visible').toBe('visible');
  });

  it('a_name_chip_hides_the_frame_its_handle_becomes_another_kind', async () => {
    setNodes(machineNode(0, machine_kind.SOURCE, 4, 4));
    mount(<MachineLabels handleRef={handleRef} />);
    expectHarness();
    const chip = chipReading('Source');
    expect(chip?.style.visibility, 'POSITIVE CONTROL: the Source chip is visible').toBe('visible');

    // A keyframe hands handle 0 to a Sink.
    setNodes(machineNode(0, machine_kind.SINK, 4, 4));
    runFrameOutsideAct();
    expect(chip!.isConnected, 'the in-between frame: React has not committed').toBe(true);
    expect(chip!.textContent, 'the chip still reads the old kind').toBe('Source');
    expect(chip!.style.visibility, 'a chip naming the wrong kind is hidden').toBe('hidden');

    await letReactCommit(() => expect(chipReading('Sink'), 'after the commit the chip reads Sink').toBeDefined());
    runFrameOutsideAct();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    expect(chipReading('Sink')!.style.visibility, 'and one frame later it is shown').toBe('visible');
  });

  it('a_name_chip_hides_the_frame_its_machine_is_deleted', () => {
    setNodes(machineNode(0, machine_kind.SOURCE, 4, 4), machineNode(1, machine_kind.SINK, 8, 4));
    mount(<MachineLabels handleRef={handleRef} />);
    expectHarness();
    const source = chipReading('Source');
    expect(source?.style.visibility, 'POSITIVE CONTROL: the Source chip is visible').toBe('visible');
    expect(chipReading('Sink')?.style.visibility, 'POSITIVE CONTROL: the Sink chip is visible').toBe(
      'visible',
    );

    // The Source is deleted: its handle is simply gone.
    setNodes(machineNode(1, machine_kind.SINK, 8, 4));
    runFrameOutsideAct();
    expect(source!.isConnected, 'the in-between frame: React has not committed').toBe(true);
    expect(source!.style.visibility, "the deleted machine's chip is hidden").toBe('hidden');
  });
});
