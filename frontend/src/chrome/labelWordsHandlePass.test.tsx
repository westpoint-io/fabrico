// @vitest-environment jsdom
//
// labelWordsHandlePass.test.tsx (CR-01, the 76-14 refuter round) - LabelWords on the frame a
// keyframe hands a label's handle to ANOTHER label, before React commits.
//
// The harness is overlayHandleReuse.test.tsx's (captured requestAnimationFrame, one frame
// run outside act, client size pinned to 1280 by 800 and checked by HARNESS), plus
// `keyframe()`, which bumps `SceneState.keyframes` with the node swap the way `applyPacket`
// does. These cases live in their own file so that plan 76-14's BITE block, which counts
// the failures of overlayHandleReuse.test.tsx under its O1 mutation, still reads 1.
//
// RED BEFORE THE FIX: 4 failed, each "expected 'visible' to be 'hidden'" (76-14-SUMMARY.md,
// "Refuter round").

import { act, type ReactElement, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LabelWords } from './LabelWords.tsx';
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
  handleRef = { current: { sceneState: { nodes, keyframes: 0 } } as unknown as SceneHandle };
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

/**
 * A `full` packet: `applyPacket` replaces the nodes AND bumps `SceneState.keyframes` in
 * the same synchronous step, so a frame never sees one without the other. A diff (an
 * Apply) is `setNodes` alone.
 */
function keyframe(...entries: FakeNode[]): void {
  setNodes(...entries);
  (handleRef.current!.sceneState as unknown as { keyframes: number }).keyframes += 1;
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

/**
 * Every VISIBLE words element whose words are not the words of the label its handle names
 * now (a label with no words included). What the user would read over the wrong label.
 */
function wrongWordsShown(): Array<{ node: string; shows: string; labelSays: string | undefined }> {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="label-words"]')]
    .filter((el) => el.style.visibility === 'visible')
    .map((el) => {
      const n = nodes.get(Number(el.dataset.node)) as { label?: { text: string } | null } | undefined;
      return { node: el.dataset.node ?? '', shows: el.textContent ?? '', labelSays: n?.label?.text };
    })
    .filter((r) => r.shows !== r.labelSays);
}

// The 76-14 refuter round. A keyframe also hands a label's handle to ANOTHER LABEL, the
// commonest remint: `RenderProducer::reset` mints 0, 1, 2 ... in NodeId order, so on a
// board with labels a and b, deleting a and then any Undo or Redo gives b the handle a
// held (measured on the host: a=0 b=1 before, b=0 after). The kind guard passes such an
// element, so on the in-between frame it showed a's words, at a's box size, on b's cell.
describe('LabelWords on the frame a keyframe hands a label handle to another label (CR-01)', () => {
  it('label_words_hide_the_frame_their_handle_passes_to_another_label', async () => {
    setNodes(labelNode(0, 10, 12, 'Alpha'), labelNode(1, 18, 12, 'Beta'));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    const alpha = wordsEl(0);
    expect(alpha?.textContent, 'POSITIVE CONTROL: Alpha is on handle 0').toBe('Alpha');
    expect(alpha!.style.visibility, 'POSITIVE CONTROL: Alpha is visible').toBe('visible');
    expect(wordsEl(1)!.style.visibility, 'POSITIVE CONTROL: Beta is visible').toBe('visible');
    expect(wrongWordsShown(), 'POSITIVE CONTROL: no wrong words before the keyframe').toEqual([]);

    // The Redo of "delete Alpha": Beta is reminted onto handle 0.
    keyframe(labelNode(0, 18, 12, 'Beta'));
    runFrameOutsideAct();
    expect(alpha!.isConnected, 'the in-between frame: React has not committed').toBe(true);
    expect(alpha!.textContent, 'the element still carries the old words').toBe('Alpha');
    expect(alpha!.style.visibility, "Alpha's words are hidden over Beta").toBe('hidden');
    expect(wrongWordsShown(), "no label shows another label's words").toEqual([]);

    await letReactCommit(() => expect(wordsEl(0)?.textContent, 'the commit gives handle 0 Beta').toBe('Beta'));
    expect(wordsEl(1), "handle 1's element is gone").toBeNull();
    runFrameOutsideAct();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    expect(wordsEl(0)!.style.visibility, "one frame later Beta's words are shown").toBe('visible');
    expect(wrongWordsShown()).toEqual([]);
  });

  it('label_words_hide_the_frame_their_handle_passes_to_a_label_with_no_words', async () => {
    setNodes(labelNode(0, 10, 12, 'Alpha'));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    const alpha = wordsEl(0);
    expect(alpha!.style.visibility, 'POSITIVE CONTROL: Alpha is visible').toBe('visible');

    keyframe(labelNode(0, 18, 12, ''));
    runFrameOutsideAct();
    expect(alpha!.isConnected, 'the in-between frame: React has not committed').toBe(true);
    expect(alpha!.style.visibility, 'an empty label shows no words').toBe('hidden');
    expect(wrongWordsShown()).toEqual([]);

    await letReactCommit(() => expect(wordsEl(0), 'after the commit the element is gone').toBeNull());
  });

  it('label_words_hide_the_frame_two_labels_trade_handles', async () => {
    setNodes(labelNode(0, 10, 12, 'Order intake'), labelNode(1, 30, 20, 'Payment'));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    const intake = wordsEl(0);
    const payment = wordsEl(1);
    expect(intake!.style.visibility, 'POSITIVE CONTROL').toBe('visible');
    expect(payment!.style.visibility, 'POSITIVE CONTROL').toBe('visible');

    keyframe(labelNode(0, 30, 20, 'Payment'), labelNode(1, 10, 12, 'Order intake'));
    runFrameOutsideAct();
    expect(intake!.isConnected && payment!.isConnected, 'the in-between frame').toBe(true);
    expect(intake!.style.visibility, "'Order intake' is hidden over Payment").toBe('hidden');
    expect(payment!.style.visibility, "'Payment' is hidden over Order intake").toBe('hidden');

    await letReactCommit(() => expect(wordsEl(0)?.textContent).toBe('Payment'));
    runFrameOutsideAct();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    expect(wordsEl(0)!.style.visibility, 'Payment shown one frame later').toBe('visible');
    expect(wordsEl(1)!.style.visibility, 'Order intake shown one frame later').toBe('visible');
    expect(wrongWordsShown()).toEqual([]);
  });

  it('label_words_hide_the_frame_their_handle_passes_to_a_smaller_label_with_the_same_words', () => {
    setNodes(labelNode(0, 10, 12, 'Note'));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    const el = wordsEl(0);
    expect(el!.style.visibility, 'POSITIVE CONTROL').toBe('visible');
    expect(el!.style.width, 'POSITIVE CONTROL: a 4-wide box, 32*4-16').toBe('112px');

    // Another label with the same words but 2 cells wide takes handle 0.
    keyframe({ ...labelNode(0, 18, 12, 'Note'), w: 2 });
    runFrameOutsideAct();
    expect(el!.isConnected, 'the in-between frame').toBe(true);
    expect(el!.style.width, 'the element still has the old box').toBe('112px');
    expect(el!.style.visibility, 'words laid out for a 4-wide box are hidden over a 2-wide one').toBe('hidden');
  });

  it('label_words_stay_shown_across_a_keyframe_that_leaves_them_alone', () => {
    // An Undo of a Source placement: a keyframe, and both labels keep handle and words.
    setNodes(labelNode(0, 10, 12, 'Alpha'), labelNode(1, 18, 12, 'Beta'), machineNode(2, machine_kind.SOURCE, 4, 4));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    expect(wordsEl(0)!.style.visibility, 'POSITIVE CONTROL').toBe('visible');

    keyframe(labelNode(0, 10, 12, 'Alpha'), labelNode(1, 18, 12, 'Beta'));
    runFrameOutsideAct();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    expect(wordsEl(0)!.style.visibility, 'Alpha does not blink on the keyframe').toBe('visible');
    expect(wordsEl(1)!.style.visibility, 'Beta does not blink on the keyframe').toBe('visible');
  });

  it('label_words_stay_shown_on_an_apply_after_a_keyframe_settles', async () => {
    setNodes(labelNode(0, 10, 12, 'Alpha'), labelNode(1, 18, 12, 'Beta'));
    mount(<LabelWords handleRef={handleRef} />);
    expectHarness();
    keyframe(labelNode(0, 18, 12, 'Beta'));
    runFrameOutsideAct();
    await letReactCommit(() => expect(wordsEl(0)?.textContent).toBe('Beta'));
    runFrameOutsideAct();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const el = wordsEl(0);
    expect(el!.style.visibility, 'POSITIVE CONTROL: the keyframe has settled').toBe('visible');

    // An Apply, a diff: the words change in place, no keyframe.
    setNodes(labelNode(0, 18, 12, 'Gamma'));
    runFrameOutsideAct();
    expect(el!.isConnected, 'the in-between frame').toBe(true);
    expect(el!.textContent, 'the element still carries the old words').toBe('Beta');
    expect(el!.style.visibility, 'an Apply after a settled keyframe never blinks').toBe('visible');

    await letReactCommit(() => expect(wordsEl(0)?.textContent).toBe('Gamma'));
  });
});
