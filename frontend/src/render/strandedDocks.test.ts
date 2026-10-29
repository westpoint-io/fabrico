// ---------------------------------------------------------------------------
// strandedDocks.test.ts
//
// READ THIS BEFORE READING THE GREENS. (Phase 67, plan 67-07 task 1, 2026-08-30;
// rewritten by plan 74.1-27, 2026-10-06.)
//
// The keyframe detector (`detectKeyframeStrand`, named `detectKeyframeStrand` until 74.1-27)
// fires on a belt let go of by an undo or a redo, both of which arrive as full
// keyframes. 67-07 wrote here that it was expected never to fire in production, because
// CONNECT-03 made the undo of a severing Rotate re-dock. That is no longer true: since
// 74.1-27 it fires on the REDO of a port removal and of a stranding Rotate.
//
// The cases below prove its LOGIC against constructed packets. What proves it is LIVE
// is `frontend/e2e-live/74.1-port-edit-rings.live.spec.ts`, which drives remove, undo
// and redo on the real host through the shipped packet path and reads the rings off
// the ring Graphics; it was red before the widening.
//
// FIXTURE CHANGE in 74.1-27 (inputs, not verdicts): every keyframe case in the
// `detectKeyframeStrand` describes sets the scene at tick 10 and the keyframe at tick
// 11, because tick continuity is now a gate. Without it each silent case would be
// silent by that gate instead of the one it names, and so would test nothing.
//
// The `detectStrandedDocks` / `findNodeByCellKind` / `isStructuralEdit` cases are
// unaffected: that forward, non-keyframe path is the one CONNECT-02's stranded-ring
// reconnect uses.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import type { BeltDockView, BeltView, NodeView, RenderPacket } from '../protocol/decode.ts';
import { createSceneState, type SceneState } from './sceneState.ts';
import {
  detectStrandedDocks,
  detectKeyframeStrand,
  findNodeByCellKind,
  isStructuralEdit,
} from './strandedDocks.ts';

// Fixture builders mirror sceneState.test.ts: hand-built Map-based SceneState
// (via createSceneState) + plain RenderPacket literals. The diff probe reads
// BOTH structures purely — these fixtures are the packet-vs-scene transition
// cases from RESEARCH Finding 7 / Pitfall 7 (false-positive classes).

const belt = (id: number, docks: BeltDockView[] = []): BeltView => ({
  id,
  latency: 8,
  fill: 0,
  items: [],
  tiles: [],
  docks,
  // SLOT-03: appended LAST after `docks`; the identity interval.
  ticks_per_slot: 1,
});

const packet = (p: Partial<RenderPacket>): RenderPacket => ({
  tick: 0,
  full: false,
  placed: [],
  removed: [],
  belts: [],
  can_undo: false,
  can_redo: false,
  wires: [],
  // 73-12: appended on the wire after `wires`. `false` is the shipped value
  // for every packet except a transport's lag-resync frame.
  resync: false,
  // Phase 88 (D-02): appended LAST, after `resync`; the board generation.
  generation: 0,
  swap_floor: 0,
  ...p,
});

/** A scene holding belt 3 docked Tail -> node 1 port 2 (the rotate victim). */
const sceneWithTailDock = (): SceneState => {
  const scene = createSceneState();
  scene.belts.set(3, belt(3, [{ end: 'Tail', node: 1, port: 2 }]));
  return scene;
};

describe('detectStrandedDocks — pure packet-vs-scene dock-vanished diff', () => {
  it('reports a dock vanished from a re-emitted belt on a non-full packet', () => {
    const scene = sceneWithTailDock();
    const p = packet({ belts: [belt(3, [])] });
    expect(detectStrandedDocks(scene, p)).toEqual([
      { beltId: 3, end: 'Tail', node: 1, port: 2 },
    ]);
  });

  it('never fires on a full:true keyframe (undo/redo/load restructure legitimately)', () => {
    const scene = sceneWithTailDock();
    const p = packet({ full: true, belts: [belt(3, [])] });
    expect(detectStrandedDocks(scene, p)).toEqual([]);
  });

  it('suppresses the cascade-delete case (docked node in packet.removed)', () => {
    const scene = sceneWithTailDock();
    const p = packet({ removed: [1], belts: [belt(3, [])] });
    expect(detectStrandedDocks(scene, p)).toEqual([]);
  });

  it('reports nothing when the re-emitted belt keeps its docks unchanged', () => {
    const scene = sceneWithTailDock();
    const p = packet({ belts: [belt(3, [{ end: 'Tail', node: 1, port: 2 }])] });
    expect(detectStrandedDocks(scene, p)).toEqual([]);
  });

  it('reports nothing for a NEW belt id absent from the scene', () => {
    const scene = sceneWithTailDock();
    const p = packet({ belts: [belt(9, [])] });
    expect(detectStrandedDocks(scene, p)).toEqual([]);
  });

  it('does not report an end that still has a dock, even with changed node/port fields', () => {
    const scene = sceneWithTailDock();
    // Tail re-docked elsewhere: the end SURVIVES docked, so nothing vanished.
    const p = packet({ belts: [belt(3, [{ end: 'Tail', node: 4, port: 0 }])] });
    expect(detectStrandedDocks(scene, p)).toEqual([]);
  });

  it('reports only the vanished end when the other end survives', () => {
    const scene = createSceneState();
    scene.belts.set(3, belt(3, [
      { end: 'Head', node: 2, port: 0 },
      { end: 'Tail', node: 1, port: 2 },
    ]));
    // Head survives (fields changed is irrelevant — the end has a dock);
    // Tail vanished -> exactly one stranded event, for Tail.
    const p = packet({ belts: [belt(3, [{ end: 'Head', node: 6, port: 1 }])] });
    expect(detectStrandedDocks(scene, p)).toEqual([
      { beltId: 3, end: 'Tail', node: 1, port: 2 },
    ]);
  });

  it('is a pure read: neither the scene nor the packet is mutated', () => {
    const scene = sceneWithTailDock();
    const p = packet({ belts: [belt(3, [])] });
    detectStrandedDocks(scene, p);
    expect(scene.belts.get(3)?.docks).toEqual([{ end: 'Tail', node: 1, port: 2 }]);
    expect(p.belts[0].docks).toEqual([]);
    expect(p.removed).toEqual([]);
  });

  // Phase 89 red-first probe (plan 89-01, D-01), turned on by plan 89-04 (D-09): the gate and
  // the title suffix went; the body did not change.

  it(
    'a_cut_upstream_of_a_fan_in_is_one_strand',
    () => {
      // FAIL-06 (D-09): belt 3's Tail is fed by two upstreams (LINK-13 fan-in), nodes 1 and 2, and
      // its Head docks node 9. A turn cuts node 1 only: the packet re-emits the Tail docked to node
      // 2 alone. Losing a dock with nothing gained at that end is ONE strand, naming node 1; the
      // end-only test reads "the Tail still has a dock" and reports nothing.
      const scene = createSceneState();
      scene.belts.set(
        3,
        belt(3, [
          { end: 'Tail', node: 1, port: 0 },
          { end: 'Tail', node: 2, port: 0 },
          { end: 'Head', node: 9, port: 0 },
        ]),
      );
      const p = packet({
        belts: [
          belt(3, [
            { end: 'Tail', node: 2, port: 0 },
            { end: 'Head', node: 9, port: 0 },
          ]),
        ],
      });
      const got = detectStrandedDocks(scene, p);
      console.log(`P89-FAIL-06-diff strands=${JSON.stringify(got)}`);
      expect(got, 'exactly one strand: the cut upstream, node 1').toEqual([{ beltId: 3, end: 'Tail', node: 1, port: 0 }]);
    },
  );

  // Plan 89-04 (D-09): the per (end, node, port) rule's other three edges.
  /** Belt 3 with a two-upstream Tail (nodes 1 and 2, port 0 each) and its Head on node 9. */
  const fanInScene = (): SceneState => {
    const scene = createSceneState();
    scene.belts.set(
      3,
      belt(3, [
        { end: 'Tail', node: 1, port: 0 },
        { end: 'Tail', node: 2, port: 0 },
        { end: 'Head', node: 9, port: 0 },
      ]),
    );
    return scene;
  };

  it('a_re_aim_at_the_same_end_is_no_strand', () => {
    // The Tail loses (1,0) and gains (1,2) in the same packet: a turn that cut port 0 of node 1
    // and docked its port 2 to the same end (D-08). Something still holds the end: silent.
    const p = packet({
      belts: [
        belt(3, [
          { end: 'Tail', node: 2, port: 0 },
          { end: 'Tail', node: 1, port: 2 },
          { end: 'Head', node: 9, port: 0 },
        ]),
      ],
    });
    expect(detectStrandedDocks(fanInScene(), p)).toEqual([]);
  });

  it('an_unchanged_fan_in_re_emit_is_no_strand', () => {
    // The same two Tail docks, in the other order (an item-flow re-emit): nothing was lost.
    const p = packet({
      belts: [
        belt(3, [
          { end: 'Head', node: 9, port: 0 },
          { end: 'Tail', node: 2, port: 0 },
          { end: 'Tail', node: 1, port: 0 },
        ]),
      ],
    });
    expect(detectStrandedDocks(fanInScene(), p)).toEqual([]);
  });

  it('a_cut_dock_of_a_removed_machine_is_no_strand', () => {
    // Node 1 is deleted in the same packet: its dropped Tail dock is a cascade, not a strand,
    // under the per-key rule as under the end-only one.
    const p = packet({
      removed: [1],
      belts: [
        belt(3, [
          { end: 'Tail', node: 2, port: 0 },
          { end: 'Head', node: 9, port: 0 },
        ]),
      ],
    });
    expect(detectStrandedDocks(fanInScene(), p)).toEqual([]);
  });
});

// A machine at cell (5,6), kind 1, rot 0, footprint 1x1, IDLE (state 0), no ports.
const node = (over: Partial<NodeView> = {}): NodeView => ({
  id: 1,
  kind: 1,
  cell_x: 5,
  cell_y: 6,
  state: 0,
  w: 1,
  h: 1,
  rot: 0,
  ports: [],
  load: 0,
  ...over,
});

/** A scene holding node 1 (IDLE) and belt 3 docked Tail -> node 1 port 2. */
const sceneWithNodeAndDock = (): SceneState => {
  const scene = createSceneState();
  scene.nodes.set(1, node());
  scene.belts.set(3, belt(3, [{ end: 'Tail', node: 1, port: 2 }]));
  return scene;
};

describe('isStructuralEdit — pure PRE-apply structural-vs-state-only classifier', () => {
  it('is FALSE on a state-only IDLE->WORKING re-emit (only the state byte differs)', () => {
    const scene = sceneWithNodeAndDock();
    // Node re-emitted with state=1 (WORKING); geometry identical, docks unchanged.
    const p = packet({ placed: [node({ state: 1 })], belts: [belt(3, [{ end: 'Tail', node: 1, port: 2 }])] });
    expect(isStructuralEdit(scene, p)).toBe(false);
  });

  it('is TRUE on a Place (a NEW node absent from the scene)', () => {
    const scene = sceneWithNodeAndDock();
    const p = packet({ placed: [node({ id: 7, cell_x: 9, cell_y: 9 })] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is TRUE on a Delete (packet.removed non-empty)', () => {
    const scene = sceneWithNodeAndDock();
    const p = packet({ removed: [1] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is TRUE on a Rotate (rot changed on an existing node)', () => {
    const scene = sceneWithNodeAndDock();
    const p = packet({ placed: [node({ rot: 1 })] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is TRUE on a dock/undock (belt dock set changed)', () => {
    const scene = sceneWithNodeAndDock();
    // Belt 3 re-emitted with the Tail dock removed (undock).
    const p = packet({ belts: [belt(3, [])] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is TRUE for a NEW belt id (a DrawBelt/Wire structural edit)', () => {
    const scene = sceneWithNodeAndDock();
    const p = packet({ belts: [belt(9, [])] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is TRUE when a dock end re-targets a different node/port', () => {
    const scene = sceneWithNodeAndDock();
    const p = packet({ belts: [belt(3, [{ end: 'Tail', node: 4, port: 0 }])] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is FALSE for a pure item-flow packet (belt re-emitted, docks unchanged, no placed/removed)', () => {
    const scene = sceneWithNodeAndDock();
    // Belt 3 re-emitted with moved items but the SAME dock set.
    const p = packet({
      belts: [
        {
          id: 3,
          latency: 8,
          fill: 2,
          items: [{ arrival_tick: 10, tag: 0 }],
          tiles: [],
          docks: [{ end: 'Tail', node: 1, port: 2 }],
          ticks_per_slot: 1, // SLOT-03: appended LAST; the identity interval.
        },
      ],
    });
    expect(isStructuralEdit(scene, p)).toBe(false);
  });

  // 74-05: since LINK-13 a downstream belt reports one Tail dock PER upstream, so a
  // fan-in belt holds two Tail docks. The find-first-by-end match spuriously flagged an
  // unchanged fan-in (the second Tail matched the first prior Tail record, whose node
  // differed). These lock the multiset semantics.
  const sceneWithFanIn = (): SceneState => {
    const scene = createSceneState();
    scene.nodes.set(1, node());
    scene.belts.set(3, belt(3, [
      { end: 'Tail', node: 1, port: 0 },
      { end: 'Tail', node: 2, port: 0 },
    ]));
    return scene;
  };

  it('is FALSE on an unchanged two-upstream fan-in re-emit (the 74-05 no-op)', () => {
    const scene = sceneWithFanIn();
    const p = packet({ belts: [belt(3, [
      { end: 'Tail', node: 1, port: 0 },
      { end: 'Tail', node: 2, port: 0 },
    ])] });
    expect(isStructuralEdit(scene, p)).toBe(false);
  });

  it('is FALSE when the fan-in docks re-emit in reversed order (multiset, not order-sensitive)', () => {
    const scene = sceneWithFanIn();
    const p = packet({ belts: [belt(3, [
      { end: 'Tail', node: 2, port: 0 },
      { end: 'Tail', node: 1, port: 0 },
    ])] });
    expect(isStructuralEdit(scene, p)).toBe(false);
  });

  it('is TRUE when one upstream of a fan-in changes node (a genuine change is not masked)', () => {
    const scene = sceneWithFanIn();
    const p = packet({ belts: [belt(3, [
      { end: 'Tail', node: 1, port: 0 },
      { end: 'Tail', node: 3, port: 0 },
    ])] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  // quick-260929-p7p (PR #3 review WR-01, WR-02): each key of the (end, node, port)
  // multiset match is pinned on its own. The node-changing cases above do not pin
  // `port` or `end`: dropping either comparison from the match left every test green.
  it('is TRUE when a dock re-targets only the port on the same node', () => {
    const scene = createSceneState();
    scene.belts.set(3, belt(3, [{ end: 'Tail', node: 1, port: 1 }]));
    const p = packet({ belts: [belt(3, [{ end: 'Tail', node: 1, port: 2 }])] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is TRUE when a dock moves from the Tail to the Head on the same node and port', () => {
    const scene = createSceneState();
    scene.belts.set(3, belt(3, [{ end: 'Tail', node: 1, port: 0 }]));
    const p = packet({ belts: [belt(3, [{ end: 'Head', node: 1, port: 0 }])] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  // The shipped fault-drain topology (golden_0008): ONE router's Out (port 1) and
  // Fault (port 2) both offload onto the same belt's Tail. Same node, different
  // ports, so the old find-first-by-end match tripped on the PORT comparison, not the
  // node one. An unchanged re-emit must not read as structural.
  it('is FALSE on an unchanged router Out+Fault fan-in re-emit (same node, ports 1 and 2)', () => {
    const scene = createSceneState();
    scene.belts.set(3, belt(3, [
      { end: 'Tail', node: 100, port: 1 },
      { end: 'Tail', node: 100, port: 2 },
    ]));
    const p = packet({ belts: [belt(3, [
      { end: 'Tail', node: 100, port: 1 },
      { end: 'Tail', node: 100, port: 2 },
    ])] });
    expect(isStructuralEdit(scene, p)).toBe(false);
  });

  it('is TRUE on a full:true keyframe', () => {
    const scene = sceneWithNodeAndDock();
    const p = packet({ full: true, placed: [node()] });
    expect(isStructuralEdit(scene, p)).toBe(true);
  });

  it('is a pure read: neither the scene nor the packet is mutated', () => {
    const scene = sceneWithNodeAndDock();
    const p = packet({ placed: [node({ state: 1 })], belts: [belt(3, [{ end: 'Tail', node: 1, port: 2 }])] });
    isStructuralEdit(scene, p);
    expect(scene.nodes.get(1)?.state).toBe(0);
    expect(p.placed[0].state).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectKeyframeStrand — the conservative keyframe-aware sibling (MOTION-06b).
//
// The crafted prev/keyframe pairs are the false-positive/false-negative table
// from RESEARCH Pattern 5. The load-silent and redo-silent cases are the Fork #1
// guarantee (never cry wolf on a legitimate load/redo). Every keyframe RE-MINTS
// handles (App.tsx:244), so the fixtures deliberately give the keyframe belt/node
// DIFFERENT ids than prev — the detector must match STRUCTURALLY (origin-cell+kind
// for nodes, tile-path for belts), never by id.
// ---------------------------------------------------------------------------

/** A belt carrying a real tile-path (the structural key the keyframe matches on). */
const beltT = (id: number, tiles: Array<[number, number]>, docks: BeltDockView[] = []): BeltView => ({
  id,
  latency: 8,
  fill: 0,
  items: [],
  tiles: tiles.map(([cell_x, cell_y]) => ({ cell_x, cell_y, kind: { Straight: { axis: 0 } } })),
  docks,
  ticks_per_slot: 1, // SLOT-03: appended LAST; the identity interval.
});

const BELT_PATH: Array<[number, number]> = [
  [1, 1],
  [1, 2],
];

describe('detectKeyframeStrand — the undo-of-a-turn cases (MOTION-06b, ticks continuous since 74.1-27)', () => {
  it('FIRES on an undo-of-Rotate that strands a dock, matched STRUCTURALLY (re-minted ids)', () => {
    // prev: node handle 100 at (5,6) kind 1 rot 1, belt handle 3 docked Tail -> 100.
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 1 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    // undo keyframe: SAME machine (origin (5,6) kind 1) but rot 0, RE-MINTED to
    // handle 200; the belt (same tile-path) re-minted to handle 9 with NO dock.
    const p = packet({
      tick: 11,
      full: true,
      can_redo: true,
      placed: [node({ id: 200, rot: 0 })],
      belts: [beltT(9, BELT_PATH, [])],
    });
    // WR-01: carries the node's STABLE structural identity (origin (5,6) kind 1)
    // so App.tsx resolves the vacated nub against the re-minted POST-apply scene,
    // NOT by the stale pre-keyframe handle 100.
    expect(detectKeyframeStrand(scene, p)).toEqual([
      { beltId: 9, end: 'Tail', node: 100, port: 2, nodeCellX: 5, nodeCellY: 6, nodeKind: 1 },
    ]);
  });

  it('is SILENT on a keyframe whose node set is wholesale different (the node-set gate, gate 2)', () => {
    // RENAMED in 74.1-33 (review round 4 IN-06). This case was titled as a `can_redo`
    // gate, but plan 74.1-27 removed `can_redo` from the detector, and a Load restores the
    // saved stacks rather than resetting them. What silences this fixture is gate 2: no
    // node in the keyframe sits at the prev node's origin with its kind. Gates 0 and 1 are
    // asserted to PASS here, so a gate 2 made tolerant of a changed set turns this red
    // with a message about the node set. The measured Load hazard (same node set, the
    // tick jumps) is pinned in the port-edit describe below.
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 1 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    const p = packet({
      tick: 11,
      full: true,
      can_redo: false,
      placed: [node({ id: 500, cell_x: 20, cell_y: 20, kind: 4 })],
      belts: [beltT(9, [[20, 20], [20, 21]], [])],
    });
    expect(p.full && !p.resync, 'gate 0 passes: a full keyframe, not a resync').toBe(true);
    expect(p.tick, 'gate 1 passes: the keyframe is the next tick').toBe(scene.tick + 1);
    expect(detectKeyframeStrand(scene, p), 'silenced by the node-set gate alone').toEqual([]);
  });

  it('is SILENT on a redo of a NON-stranding action (can_redo true but no dock vanished)', () => {
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 0 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    // A mid-stack redo of a rotate that keeps the dock: node-set matches, one
    // rot change, but the belt STILL carries its Tail dock -> gate 3 finds
    // nothing lost.
    const p = packet({
      tick: 11,
      full: true,
      can_redo: true,
      placed: [node({ id: 200, rot: 1 })],
      belts: [beltT(9, BELT_PATH, [{ end: 'Tail', node: 200, port: 2 }])],
    });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });

  it('is SILENT on an undo of a Place/Delete (node-set size differs — size gate)', () => {
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 0 }));
    scene.nodes.set(101, node({ id: 101, cell_x: 8, cell_y: 8, rot: 0 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    // Undo of a Place removes the second machine: prev has 2 nodes, keyframe 1.
    const p = packet({
      tick: 11,
      full: true,
      can_redo: true,
      placed: [node({ id: 200, rot: 0 })],
      belts: [beltT(9, BELT_PATH, [])],
    });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });

  it('is SILENT on an undo of a multi-node op (>1 rot changed — rot-count gate)', () => {
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 0 }));
    scene.nodes.set(101, node({ id: 101, cell_x: 8, cell_y: 8, rot: 0 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    // Node-set matches (same origins/kinds), but TWO nodes changed rot -> too
    // broad to be a confident single-rotate undo.
    const p = packet({
      tick: 11,
      full: true,
      can_redo: true,
      placed: [node({ id: 200, rot: 1 }), node({ id: 201, cell_x: 8, cell_y: 8, rot: 1 })],
      belts: [beltT(9, BELT_PATH, [])],
    });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });

  it('is SILENT on a non-keyframe packet (the diff path owns those — gate 0)', () => {
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 1 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    const p = packet({ tick: 11, full: false, can_redo: true, belts: [beltT(3, BELT_PATH, [])] });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });

  it('ignores a belt whose tile-path changed (belt re-pathed — not a stationary-belt strand)', () => {
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 1 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    // The keyframe belt has a DIFFERENT tile-path, so it is not matched to the
    // prev belt at all -> no strand collected.
    const p = packet({
      tick: 11,
      full: true,
      can_redo: true,
      placed: [node({ id: 200, rot: 0 })],
      belts: [beltT(9, [[7, 7], [7, 8]], [])],
    });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });

  it('is a pure read: neither the scene nor the packet is mutated', () => {
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 1 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    const p = packet({
      tick: 11,
      full: true,
      can_redo: true,
      placed: [node({ id: 200, rot: 0 })],
      belts: [beltT(9, BELT_PATH, [])],
    });
    detectKeyframeStrand(scene, p);
    expect(scene.belts.get(3)?.docks).toEqual([{ end: 'Tail', node: 100, port: 2 }]);
    expect(scene.nodes.get(100)?.rot).toBe(1);
    expect(p.belts[0].docks).toEqual([]);
    expect(p.placed[0].rot).toBe(0);
  });

  // Phase 89 red-first probe (plan 89-01, D-01), turned on by plan 89-04 (D-09): the gate and
  // the title suffix went; the body did not change.

  it(
    'a_redo_that_cuts_one_upstream_of_a_fan_in_is_one_strand',
    () => {
      // FAIL-06 (D-09), the keyframe sibling (the path a Redo takes): belt 3's Tail is fed by the
      // turned machine at (5,6) and by a second upstream at (8,8); its Head docks a machine at
      // (3,3). The redo keyframe (tick + 1, every handle re-minted) turns the first machine and its
      // belt keeps the Tail dock from the second alone. Nodes are matched by cell and kind, and the
      // one lost dock is one strand naming the turned machine.
      const scene = createSceneState();
      scene.tick = 10;
      scene.nodes.set(100, node({ id: 100, rot: 1 }));
      scene.nodes.set(101, node({ id: 101, cell_x: 8, cell_y: 8 }));
      scene.nodes.set(102, node({ id: 102, cell_x: 3, cell_y: 3, kind: 2 }));
      scene.belts.set(
        3,
        beltT(3, BELT_PATH, [
          { end: 'Tail', node: 100, port: 0 },
          { end: 'Tail', node: 101, port: 0 },
          { end: 'Head', node: 102, port: 0 },
        ]),
      );
      const p = packet({
        tick: 11,
        full: true,
        can_redo: false,
        placed: [
          node({ id: 200, rot: 0 }),
          node({ id: 201, cell_x: 8, cell_y: 8 }),
          node({ id: 202, cell_x: 3, cell_y: 3, kind: 2 }),
        ],
        belts: [
          beltT(9, BELT_PATH, [
            { end: 'Tail', node: 201, port: 0 },
            { end: 'Head', node: 202, port: 0 },
          ]),
        ],
      });
      const got = detectKeyframeStrand(scene, p);
      console.log(`P89-FAIL-06-keyframe strands=${JSON.stringify(got)}`);
      expect(got, 'exactly one strand: the turned upstream, found by cell and kind').toEqual([
        { beltId: 9, end: 'Tail', node: 100, port: 0, nodeCellX: 5, nodeCellY: 6, nodeKind: 1 },
      ]);
    },
  );

  it('a_redo_re_aim_is_no_strand', () => {
    // Plan 89-04 (D-09), the keyframe sibling of a_re_aim_at_the_same_end_is_no_strand: the redo
    // keyframe (tick + 1, every handle re-minted) turns the machine at (5,6), and the belt's Tail
    // is re-emitted docked to ANOTHER port of that same turned machine (port 1 where it held port
    // 0), the second upstream kept. The end lost a key and gained one: a re-aim, silent.
    const scene = createSceneState();
    scene.tick = 10;
    scene.nodes.set(100, node({ id: 100, rot: 1 }));
    scene.nodes.set(101, node({ id: 101, cell_x: 8, cell_y: 8 }));
    scene.belts.set(
      3,
      beltT(3, BELT_PATH, [
        { end: 'Tail', node: 100, port: 0 },
        { end: 'Tail', node: 101, port: 0 },
      ]),
    );
    const p = packet({
      tick: 11,
      full: true,
      can_undo: true,
      placed: [node({ id: 200, rot: 0 }), node({ id: 201, cell_x: 8, cell_y: 8 })],
      belts: [
        beltT(9, BELT_PATH, [
          { end: 'Tail', node: 201, port: 0 },
          { end: 'Tail', node: 200, port: 1 },
        ]),
      ],
    });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });
});

describe('findNodeByCellKind — structural POST-apply node resolution (WR-01)', () => {
  it('resolves a re-minted node by origin cell + kind, not by handle', () => {
    // A full keyframe re-mints the node from handle 100 -> 200 but keeps its
    // origin cell (5,6) + kind 1; resolve it by that stable structural key.
    const scene = createSceneState();
    scene.nodes.set(200, node({ id: 200, rot: 0 }));
    const found = findNodeByCellKind(scene, 5, 6, 1);
    expect(found?.id).toBe(200);
  });

  it('returns null when no node matches the structural key', () => {
    const scene = createSceneState();
    scene.nodes.set(200, node({ id: 200 }));
    expect(findNodeByCellKind(scene, 5, 6, 9)).toBeNull(); // wrong kind
    expect(findNodeByCellKind(scene, 9, 9, 1)).toBeNull(); // wrong cell
  });
});

// ---------------------------------------------------------------------------
// The keyframe path on a PORT EDIT (plan 74.1-27, walk item N5B).
//
// A redo arrives as a full keyframe. The redo of `Remove output 1` lets go of the belt
// on that output again, and until this plan nothing rang it: the keyframe detector
// required `can_redo` (true only after an undo) and a changed `rot`. These cases are
// the walk board in miniature: a Factory at (6,11), two Outs on its east edge, a belt
// east from each. Ticks are continuous (an undo or redo folds on the tick after the
// last packet the client applied), measured on the dev host and tabled in
// 74.1-27-SUMMARY.md.
// ---------------------------------------------------------------------------

const P = (index: number, cell_x: number, cell_y: number, side: number, role: number) => ({
  index,
  cell_x,
  cell_y,
  side,
  role,
  medium: 0,
});
const FACTORY_TWO_OUTS = [P(0, 6, 12, 3, 0), P(1, 8, 12, 1, 1), P(2, 8, 13, 1, 1), P(3, 7, 13, 2, 2)];
const FACTORY_ONE_OUT = [P(0, 6, 12, 3, 0), P(1, 8, 13, 1, 1), P(2, 7, 13, 2, 2)];
const MIDDLE_BELT: Array<[number, number]> = [
  [9, 12],
  [10, 12],
];
const BOTTOM_BELT: Array<[number, number]> = [
  [9, 13],
  [10, 13],
];
const factory = (id: number, ports: ReturnType<typeof P>[]): NodeView =>
  node({ id, kind: 2, cell_x: 6, cell_y: 11, w: 3, h: 3, ports });

/** The board after an undo of the removal: two Outs, both belts docked, tick 520. */
const twoOutsDocked = (): SceneState => {
  const scene = createSceneState();
  scene.tick = 520;
  scene.nodes.set(12, factory(12, FACTORY_TWO_OUTS));
  scene.belts.set(30, beltT(30, MIDDLE_BELT, [{ end: 'Tail', node: 12, port: 0 }]));
  scene.belts.set(31, beltT(31, BOTTOM_BELT, [{ end: 'Tail', node: 12, port: 1 }]));
  return scene;
};

/** The keyframe a redo of the removal sends (measured: can_undo true, can_redo false). */
const redoOfRemoval = (over: Partial<RenderPacket> = {}): RenderPacket =>
  packet({
    tick: 521,
    full: true,
    can_undo: true,
    can_redo: false,
    placed: [factory(40, FACTORY_ONE_OUT)],
    belts: [beltT(50, MIDDLE_BELT, []), beltT(51, BOTTOM_BELT, [{ end: 'Tail', node: 40, port: 0 }])],
    ...over,
  });

describe('the keyframe strand detector on a port edit (74.1-27, N5B)', () => {
  it('FIRES on a redo of a removal: the belt on the removed output, with the node\'s structural identity', () => {
    expect(detectKeyframeStrand(twoOutsDocked(), redoOfRemoval())).toEqual([
      { beltId: 50, end: 'Tail', node: 12, port: 0, nodeCellX: 6, nodeCellY: 11, nodeKind: 2 },
    ]);
  });

  it('is SILENT on an undo of the removal (the dock comes back; nothing vanished)', () => {
    const scene = createSceneState();
    scene.tick = 421;
    scene.nodes.set(40, factory(40, FACTORY_ONE_OUT));
    scene.belts.set(50, beltT(50, MIDDLE_BELT, []));
    scene.belts.set(51, beltT(51, BOTTOM_BELT, [{ end: 'Tail', node: 40, port: 0 }]));
    const undo = packet({
      tick: 422,
      full: true,
      can_undo: true,
      can_redo: true,
      placed: [factory(12, FACTORY_TWO_OUTS)],
      belts: [
        beltT(30, MIDDLE_BELT, [{ end: 'Tail', node: 12, port: 0 }]),
        beltT(31, BOTTOM_BELT, [{ end: 'Tail', node: 12, port: 1 }]),
      ],
    });
    expect(detectKeyframeStrand(scene, undo)).toEqual([]);
  });

  it('is SILENT on a lag resync carrying the same board', () => {
    expect(detectKeyframeStrand(twoOutsDocked(), redoOfRemoval({ resync: true }))).toEqual([]);
  });

  it('is SILENT on a Load of a board one port edit apart (measured: the tick jumps to the saved one)', () => {
    // Measured on the dev host: loading a saved board that differs from the one on
    // screen by exactly this removal matches the node set, changes one port count and
    // loses one dock, with `full`, `resync`, `can_undo` and `can_redo` identical to a
    // redo. Only the tick tells them apart: a load re-seeds it from the saved core.
    expect(detectKeyframeStrand(twoOutsDocked(), redoOfRemoval({ tick: 536 }))).toEqual([]);
    expect(detectKeyframeStrand(twoOutsDocked(), redoOfRemoval({ tick: 38 }))).toEqual([]);
  });

  it('is SILENT on a Load whose node set differs, and on New', () => {
    const loadOther = redoOfRemoval({
      placed: [node({ id: 1, kind: 4, cell_x: 20, cell_y: 20 })],
      belts: [beltT(9, [[20, 21], [21, 21]], [])],
    });
    expect(detectKeyframeStrand(twoOutsDocked(), loadOther)).toEqual([]);
    const fresh = redoOfRemoval({ tick: 0, can_undo: false, can_redo: false, placed: [], belts: [] });
    expect(detectKeyframeStrand(twoOutsDocked(), fresh)).toEqual([]);
  });

  it('NAMED CHANGE: a redo of a STRANDING Rotate now fires (it was silent only because can_redo was false)', () => {
    // Before 74.1-27 gate 0 required can_redo, so this keyframe rang nothing although
    // the redo severs the dock again. It is the case the RESIDUAL note at the function
    // always called a truthful alert.
    const scene = createSceneState();
    scene.tick = 700;
    scene.nodes.set(100, node({ id: 100, rot: 0 }));
    scene.belts.set(3, beltT(3, BELT_PATH, [{ end: 'Tail', node: 100, port: 2 }]));
    const redo = packet({
      tick: 701,
      full: true,
      can_undo: true,
      can_redo: false,
      placed: [node({ id: 200, rot: 1 })],
      belts: [beltT(9, BELT_PATH, [])],
    });
    expect(detectKeyframeStrand(scene, redo)).toEqual([
      { beltId: 9, end: 'Tail', node: 100, port: 2, nodeCellX: 5, nodeCellY: 6, nodeKind: 1 },
    ]);
  });

  it('is SILENT when two nodes changed (a port edit and a turn in one keyframe)', () => {
    const scene = twoOutsDocked();
    scene.nodes.set(13, node({ id: 13, cell_x: 20, cell_y: 20, rot: 0 }));
    const p = redoOfRemoval({
      placed: [factory(40, FACTORY_ONE_OUT), node({ id: 41, cell_x: 20, cell_y: 20, rot: 1 })],
    });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The keyframe path on a TURN that lets go of more than two belts (plan 74.1-33, review
// round 4 WR-03).
//
// Gate 4 used to cap the lost docks at two ("a single turn or port edit lets go of at
// most two belt ends"), a cap inherited from the undo-only detector where it never
// mattered. A turn releases EVERY docked port that no longer reaches its belt end
// (`judge_docks`), so the redo of a turn of a Factory with its In, Out and Fault docked
// lets go of three belts, and the cap silenced all three. The bound is now the cause:
// every lost dock must name the one machine that changed, by origin cell and kind.
// ---------------------------------------------------------------------------

/** A Factory at (6,11), 3x3, In on the west, Out on the east, Fault on the south. */
const FACTORY_THREE = [P(0, 6, 12, 3, 0), P(1, 8, 12, 1, 1), P(2, 7, 13, 2, 2)];
const IN_BELT: Array<[number, number]> = [
  [4, 12],
  [5, 12],
];
const OUT_BELT: Array<[number, number]> = [
  [9, 12],
  [10, 12],
];
const FAULT_BELT: Array<[number, number]> = [
  [7, 14],
  [7, 15],
];
/** The sentinel a Fault link carries (`fabrico_core::FAULT_PORT`). */
const FAULT_KEY = 65535;

/** The board before the turn, all three ports docked, tick 300. */
const threeDocked = (): SceneState => {
  const scene = createSceneState();
  scene.tick = 300;
  scene.nodes.set(12, node({ id: 12, kind: 2, cell_x: 6, cell_y: 11, w: 3, h: 3, rot: 0, ports: FACTORY_THREE }));
  scene.belts.set(30, beltT(30, IN_BELT, [{ end: 'Head', node: 12, port: 0 }]));
  scene.belts.set(31, beltT(31, OUT_BELT, [{ end: 'Tail', node: 12, port: 0 }]));
  scene.belts.set(32, beltT(32, FAULT_BELT, [{ end: 'Tail', node: 12, port: FAULT_KEY }]));
  return scene;
};

/** The keyframe a redo of the turn sends: the Factory turned and re-minted, no belt docked. */
const redoOfTurn = (over: Partial<RenderPacket> = {}): RenderPacket =>
  packet({
    tick: 301,
    full: true,
    can_undo: true,
    can_redo: false,
    placed: [node({ id: 40, kind: 2, cell_x: 6, cell_y: 11, w: 3, h: 3, rot: 1, ports: FACTORY_THREE })],
    belts: [beltT(50, IN_BELT, []), beltT(51, OUT_BELT, []), beltT(52, FAULT_BELT, [])],
    ...over,
  });

describe('the keyframe strand detector on a turn that lets go of three belts (74.1-33, WR-03)', () => {
  it('FIRES three events on the redo of a turn that releases In, Out and Fault, each naming the Factory', () => {
    const named = { nodeCellX: 6, nodeCellY: 11, nodeKind: 2 };
    expect(detectKeyframeStrand(threeDocked(), redoOfTurn())).toEqual([
      { beltId: 50, end: 'Head', node: 12, port: 0, ...named },
      { beltId: 51, end: 'Tail', node: 12, port: 0, ...named },
      { beltId: 52, end: 'Tail', node: 12, port: FAULT_KEY, ...named },
    ]);
  });

  it('a port removal that releases one belt still fires one event', () => {
    expect(detectKeyframeStrand(twoOutsDocked(), redoOfRemoval())).toHaveLength(1);
  });

  it('is SILENT when a lost dock names a machine other than the one that changed', () => {
    // The Factory turns and lets go of its Out belt, and in the same keyframe a belt
    // docked to a Source that did NOT change loses its dock too. No single turn or port
    // edit does that, so the keyframe is not one, and the detector says nothing rather
    // than ring a belt it cannot explain.
    const scene = threeDocked();
    scene.belts.delete(30);
    scene.belts.delete(32);
    scene.nodes.set(13, node({ id: 13, kind: 1, cell_x: 20, cell_y: 20 }));
    scene.belts.set(33, beltT(33, [[21, 20], [22, 20]], [{ end: 'Tail', node: 13, port: 0 }]));
    const p = redoOfTurn({
      placed: [
        node({ id: 40, kind: 2, cell_x: 6, cell_y: 11, w: 3, h: 3, rot: 1, ports: FACTORY_THREE }),
        node({ id: 41, kind: 1, cell_x: 20, cell_y: 20 }),
      ],
      belts: [beltT(51, OUT_BELT, []), beltT(53, [[21, 20], [22, 20]], [])],
    });
    expect(detectKeyframeStrand(scene, p)).toEqual([]);
  });
});
