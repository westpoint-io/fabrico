// @vitest-environment jsdom
//
// The read-only board's label overlay against a hand-built scene. A board's script can apply any
// grid command, so the node set can change between keyframes without its size changing, and a
// read-only board's camera never moves.

import { describe, expect, it } from 'vitest';
import { machine_kind } from '../protocol/kinds';
import type { SceneHandle } from '../render/pixiApp';
import { createLabelOverlay } from './labelOverlay';

interface Node {
  id: number;
  kind: number;
  cell_x: number;
  cell_y: number;
  w: number;
  h: number;
  rot: number;
  label?: { text: string; colour: number } | null;
}

function setup(nodes: Node[]) {
  const scene = { nodes: new Map(nodes.map((n) => [n.id, n])), keyframes: 1 };
  const ticks: (() => void)[] = [];
  const handle = {
    sceneState: scene,
    cameraSnapshot: () => ({ x: 0, y: 0, scale: 1 }),
    app: { ticker: { add: (fn: () => void) => ticks.push(fn) } },
  } as unknown as SceneHandle;
  const stage = document.createElement('div');
  const overlay = createLabelOverlay(stage, handle);
  const frame = (): void => {
    for (const fn of ticks) fn();
  };
  const entry = (id: number): HTMLElement | null => overlay.root.querySelector(`[data-id="${id}"]`);
  return { scene, overlay, frame, entry };
}

const factory = (id: number, over: Partial<Node> = {}): Node => ({
  id,
  kind: machine_kind.FACTORY,
  cell_x: 2,
  cell_y: 2,
  w: 1,
  h: 1,
  rot: 0,
  ...over,
});
const label = (id: number, text: string): Node => ({
  id,
  kind: machine_kind.LABEL,
  cell_x: 6,
  cell_y: 6,
  w: 3,
  h: 1,
  rot: 0,
  label: { text, colour: 0 },
});

describe('the label overlay', () => {
  it('shows a label edit that keeps the node count', () => {
    const { scene, frame, entry } = setup([factory(1), label(2, 'before')]);
    expect(entry(2)?.textContent).toBe('before');
    scene.nodes.set(2, label(2, 'after'));
    frame();
    expect(entry(2)?.textContent).toBe('after');
  });

  it('follows a delete and a place folded on one tick', () => {
    const { scene, overlay, frame, entry } = setup([factory(1), factory(3)]);
    scene.nodes.delete(3);
    scene.nodes.set(4, factory(4, { kind: machine_kind.SINK, cell_x: 8 }));
    frame();
    expect(entry(3)).toBeNull();
    expect(entry(4)?.textContent).not.toBe('');
    expect(entry(4)?.style.visibility).toBe('visible');
    expect(overlay.counts()).toEqual({ chips: 2, words: 0 });
  });

  it('renames a chip whose handle now names another kind', () => {
    const { scene, frame, entry } = setup([factory(1), factory(3)]);
    const before = entry(3)?.textContent;
    scene.nodes.set(3, factory(3, { kind: machine_kind.SINK }));
    frame();
    expect(entry(3)?.textContent).not.toBe(before);
  });

  it('moves a chip when its machine rotates and the camera is still', () => {
    const { scene, frame, entry } = setup([factory(1, { w: 2, h: 1 })]);
    frame();
    const before = entry(1)?.style.transform;
    scene.nodes.set(1, factory(1, { w: 2, h: 1, rot: 1 }));
    frame();
    expect(entry(1)?.style.transform).not.toBe(before);
  });

  it('leaves the elements alone on a frame where nothing changed', () => {
    const { frame, entry } = setup([factory(1), label(2, 'words')]);
    const chip = entry(1);
    const words = entry(2);
    frame();
    frame();
    expect(entry(1)).toBe(chip);
    expect(entry(2)).toBe(words);
  });
});
