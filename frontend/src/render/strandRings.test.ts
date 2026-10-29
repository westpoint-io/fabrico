// strandRings.test.ts - where the two alarm rings of a stranded dock go (plan 74.1-27).
//
// The walk saw a ring on a still-connected output after `Remove output 1` (N5): the
// vacated nub was resolved by its old routing key against the node's NEW port list,
// where that key names the surviving output. These cases pin the rule that replaced it:
// resolve against the node as it was before the packet; use the post-apply node only
// when its port count did not change (a turn moves the nub with the machine).

import { describe, expect, it } from 'vitest';
import type { BeltDockView, BeltView, NodeView, PortView } from '../protocol/decode.ts';
import { nubAnchor } from '../protocol/ports.ts';
import { CELL } from '../../shared/geometry';
import { createSceneState, type SceneState } from './sceneState.ts';
import type { StrandedDock } from './strandedDocks.ts';
import { strandRingPoints } from './strandRings.ts';

const port = (index: number, cell_x: number, cell_y: number, side: number, role: number): PortView => ({
  index,
  cell_x,
  cell_y,
  side,
  role,
  medium: 0,
});

const node = (over: Partial<NodeView> = {}): NodeView => ({
  id: 7,
  kind: 2,
  cell_x: 6,
  cell_y: 11,
  state: 0,
  w: 3,
  h: 3,
  rot: 0,
  ports: [],
  load: 0,
  ...over,
});

const beltT = (id: number, tiles: Array<[number, number]>, docks: BeltDockView[] = []): BeltView => ({
  id,
  latency: 8,
  fill: 0,
  items: [],
  tiles: tiles.map(([cell_x, cell_y]) => ({ cell_x, cell_y, kind: { Straight: { axis: 0 } } })),
  docks,
  ticks_per_slot: 1,
});

const sceneOf = (nodes: NodeView[], belts: BeltView[] = []): SceneState => {
  const s = createSceneState();
  for (const n of nodes) s.nodes.set(n.id, n);
  for (const b of belts) s.belts.set(b.id, b);
  return s;
};

const centre = (cx: number, cy: number) => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });

// The walk board: a Factory at (6,11), 3 by 3, In on the west, two Outs on the east
// edge (middle row, then bottom row), Fault on the south.
const IN = port(0, 6, 12, 3, 0);
const OUT1 = port(1, 8, 12, 1, 1);
const OUT2 = port(2, 8, 13, 1, 1);
const FAULT = port(3, 7, 13, 2, 2);
// After RemovePort index 1: the survivor keeps its cell (74.1-16), indices close up.
const OUT2_AFTER = port(1, 8, 13, 1, 1);
const FAULT_AFTER = port(2, 7, 13, 2, 2);

describe('strandRingPoints - the vacated nub and the orphaned belt end', () => {
  it('N5: a removal of output 1 rings the REMOVED nub where it was, never the surviving output', () => {
    const pre = sceneOf([node({ ports: [IN, OUT1, OUT2, FAULT] })]);
    const post = sceneOf(
      [node({ ports: [IN, OUT2_AFTER, FAULT_AFTER] })],
      [beltT(3, [[9, 12], [10, 12]], [])],
    );
    // The forward diff path: the belt on Out 1 lost its Tail dock, routing key 0.
    const ev: StrandedDock = { beltId: 3, end: 'Tail', node: 7, port: 0 };
    const got = strandRingPoints(pre, post, ev);
    expect(got.nub, 'the removed output\'s pre-apply anchor').toEqual(nubAnchor(8, 12, 1));
    expect(got.nub, 'not the surviving output\'s nub').not.toEqual(nubAnchor(8, 13, 1));
    expect(got.beltEnd).toEqual(centre(9, 12));
  });

  it('a turn rings the vacated port where the nub is NOW (post-apply; same port count)', () => {
    // A quarter turn moves the Out from the east edge to the south edge.
    const pre = sceneOf([node({ ports: [IN, OUT1, FAULT] })]);
    const turnedOut = port(1, 7, 13, 2, 1);
    const post = sceneOf(
      [node({ rot: 1, ports: [port(0, 7, 11, 0, 0), turnedOut, port(2, 6, 12, 3, 2)] })],
      [beltT(3, [[9, 12], [10, 12]], [])],
    );
    const ev: StrandedDock = { beltId: 3, end: 'Tail', node: 7, port: 0 };
    const got = strandRingPoints(pre, post, ev);
    expect(got.nub).toEqual(nubAnchor(7, 13, 2));
    expect(got.beltEnd).toEqual(centre(9, 12));
  });

  it('a keyframe with re-minted handles resolves the node STRUCTURALLY, never by the stale handle', () => {
    // Pre-keyframe the Factory is handle 100; the keyframe re-mints it to 200 and gives
    // handle 100 to a DIFFERENT machine. Same port count (an undone turn), so the nub is
    // read off the post-apply Factory found by origin cell + kind.
    const pre = sceneOf([node({ id: 100, rot: 1, ports: [IN, port(1, 7, 13, 2, 1), FAULT] })]);
    const post = sceneOf(
      [
        node({ id: 200, rot: 0, ports: [IN, OUT1, FAULT] }),
        node({ id: 100, kind: 4, cell_x: 20, cell_y: 20, ports: [port(0, 22, 20, 1, 1)] }),
      ],
      [beltT(9, [[9, 12], [10, 12]], [])],
    );
    const ev: StrandedDock = {
      beltId: 9,
      end: 'Tail',
      node: 100,
      port: 0,
      nodeCellX: 6,
      nodeCellY: 11,
      nodeKind: 2,
    };
    const got = strandRingPoints(pre, post, ev);
    expect(got.nub).toEqual(nubAnchor(8, 12, 1));
    expect(got.beltEnd).toEqual(centre(9, 12));
  });

  it('a keyframed port edit (a redo of the removal) rings the removed nub at its pre-apply anchor', () => {
    const pre = sceneOf([node({ id: 100, ports: [IN, OUT1, OUT2, FAULT] })]);
    const post = sceneOf(
      [node({ id: 200, ports: [IN, OUT2_AFTER, FAULT_AFTER] })],
      [beltT(9, [[9, 12], [10, 12]], [])],
    );
    const ev: StrandedDock = {
      beltId: 9,
      end: 'Tail',
      node: 100,
      port: 0,
      nodeCellX: 6,
      nodeCellY: 11,
      nodeKind: 2,
    };
    const got = strandRingPoints(pre, post, ev);
    expect(got.nub).toEqual(nubAnchor(8, 12, 1));
    expect(got.beltEnd).toEqual(centre(9, 12));
  });

  it('rings no nub when the node is gone after the packet, and no end when the belt is', () => {
    const pre = sceneOf([node({ ports: [IN, OUT1, FAULT] })]);
    const post = sceneOf([]);
    const got = strandRingPoints(pre, post, { beltId: 3, end: 'Tail', node: 7, port: 0 });
    expect(got).toEqual({ nub: null, beltEnd: null });
  });

  it('a Head end rings the belt\'s LAST tile', () => {
    const pre = sceneOf([node({ ports: [IN, OUT1, FAULT] })]);
    const post = sceneOf([node({ ports: [IN, OUT1, FAULT] })], [beltT(3, [[2, 12], [3, 12], [4, 12]], [])]);
    const got = strandRingPoints(pre, post, { beltId: 3, end: 'Head', node: 7, port: 0 });
    expect(got.nub).toEqual(nubAnchor(6, 12, 3));
    expect(got.beltEnd).toEqual(centre(4, 12));
  });

  it('is a pure read: neither scene is mutated', () => {
    const preNode = node({ ports: [IN, OUT1, OUT2, FAULT] });
    const pre = sceneOf([preNode]);
    const post = sceneOf([node({ ports: [IN, OUT2_AFTER, FAULT_AFTER] })], [beltT(3, [[9, 12]], [])]);
    strandRingPoints(pre, post, { beltId: 3, end: 'Tail', node: 7, port: 0 });
    expect(pre.nodes.get(7)).toBe(preNode);
    expect(preNode.ports).toHaveLength(4);
    expect(post.nodes.get(7)?.ports).toHaveLength(3);
  });
});
