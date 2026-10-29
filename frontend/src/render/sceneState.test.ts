import { describe, expect, it } from 'vitest';
import type {
  BeltView,
  ItemView,
  NodeView,
  RenderPacket,
  WireView,
} from '../protocol/decode.ts';
import * as sceneStateModule from './sceneState.ts';
import { applyPacket, beltsDockedTo, createSceneState, isStaleDiff, sceneSnapshot } from './sceneState.ts';

const node = (id: number, cell_x = 0): NodeView => ({
  id,
  kind: 0,
  cell_x,
  cell_y: 0,
  state: 0,
  w: 1,
  h: 1,
  rot: 0,
  ports: [],
  load: 0,
});

const belt = (id: number, fill = 0): BeltView => ({
  id,
  latency: 8,
  fill,
  items: [],
  tiles: [],
  docks: [],
  // SLOT-03: the belt's own advance interval, appended LAST after `docks`. The identity
  // value, so the apply/copy assertions in this file mean what they meant before.
  ticks_per_slot: 1,
});

const wire = (id: number, pulses: WireView['pulses'] = []): WireView => ({
  id,
  from: { node: 10, port: 0 },
  to: { node: 11, port: 0 },
  path: [
    { cell_x: 2, cell_y: 12, kind: { Straight: { axis: 0 } } },
    { cell_x: 3, cell_y: 12, kind: { Straight: { axis: 0 } } },
  ],
  pulses,
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

describe('sceneState - the board generation (phase 88, D-02)', () => {
  it('holds the generation of the last applied packet, diff and keyframe alike, and snapshots it', () => {
    const scene = createSceneState();
    expect(scene.generation, 'a fresh host starts on its first handle table').toBe(0);
    // A reset's keyframe raises it...
    applyPacket(scene, packet({ tick: 4, full: true, generation: 3 }));
    expect(scene.generation).toBe(3);
    // ...a diff under the same table keeps it...
    applyPacket(scene, packet({ tick: 5, generation: 3, placed: [node(1)] }));
    expect(scene.generation).toBe(3);
    // ...and every packet names its own, so a diff is never a reason to keep a stale one.
    applyPacket(scene, packet({ tick: 6, generation: 4 }));
    expect(scene.generation).toBe(4);
    expect(sceneSnapshot(scene).generation, 'the read-only snapshot carries it by value').toBe(4);
  });

  it('holds the swap floor of the last applied packet beside the generation (phase 88 security, T-88-11)', () => {
    const scene = createSceneState();
    expect(scene.swapFloor, 'no swap before the first packet').toBe(0);
    applyPacket(scene, packet({ tick: 4, full: true, generation: 3, swap_floor: 0 }));
    expect([scene.generation, scene.swapFloor], "an undo's keyframe: the floor stays").toEqual([3, 0]);
    applyPacket(scene, packet({ tick: 5, full: true, generation: 4, swap_floor: 4 }));
    expect([scene.generation, scene.swapFloor], "a swap's keyframe names its own generation").toEqual([4, 4]);
    applyPacket(scene, packet({ tick: 6, generation: 5, swap_floor: 4 }));
    expect(sceneSnapshot(scene).swapFloor, 'the snapshot carries it by value').toBe(4);
  });
});

describe('sceneState - a diff older than the scene (phase 90, FAIL-05)', () => {
  // Phase 90 red-first probe (plan 90-01, D-14), turned on by plan 90-03; the guard is reached
  // through the cast it was written with, so turning it on changed no body.
  it('a_diff_older_than_the_scene_is_skipped', () => {
    type At = { generation: number; tick: number };
    const isStaleDiff = (sceneStateModule as unknown as { isStaleDiff?: (scene: At, packet: At & { full: boolean }) => boolean })
      .isStaleDiff;
    console.log(`P90-FAIL-05-client isStaleDiff_is_a_function=${typeof isStaleDiff === 'function'}`);
    expect(typeof isStaleDiff, 'sceneState exports the stale-diff guard').toBe('function');
    const scene: At = { generation: 1, tick: 301 };
    expect(isStaleDiff!(scene, { full: false, generation: 1, tick: 46 }), 'a diff older than the scene').toBe(true);
    expect(isStaleDiff!(scene, { full: false, generation: 1, tick: 301 }), 'a diff at the scene tick').toBe(false);
    expect(isStaleDiff!(scene, { full: true, generation: 0, tick: 46 }), 'a keyframe is never skipped').toBe(false);
    expect(isStaleDiff!(scene, { full: false, generation: 2, tick: 3 }), 'a diff of a newer board').toBe(false);
  });

  it('skips a diff of an older generation and passes every keyframe (plan 90-03)', () => {
    const scene = { generation: 1, tick: 301 };
    expect(isStaleDiff(scene, { full: false, generation: 0, tick: 400 }), 'an older board, a higher tick').toBe(true);
    expect(isStaleDiff(scene, { full: false, generation: 0, tick: 301 }), 'an older board, the same tick').toBe(true);
    expect(isStaleDiff(scene, { full: false, generation: 1, tick: 300 }), 'one tick behind').toBe(true);
    expect(isStaleDiff(scene, { full: false, generation: 1, tick: 302 }), 'one tick ahead').toBe(false);
    for (const [generation, tick] of [[0, 46], [1, 46], [1, 301], [2, 3]] as const) {
      expect(isStaleDiff(scene, { full: true, generation, tick }), `a keyframe (${generation}, ${tick})`).toBe(false);
    }
  });

  it('a keyframe at tick 301 then a diff at tick 46, in the App packet order, leaves the scene at 301', () => {
    // App's onPacket order: decode, isStaleDiff, then (only if not stale) applyPacket.
    const onPacket = (scene: ReturnType<typeof createSceneState>, p: RenderPacket): boolean => {
      if (isStaleDiff(scene, p)) return false;
      applyPacket(scene, p);
      return true;
    };
    const scene = createSceneState();
    expect(onPacket(scene, packet({ tick: 301, full: true, generation: 1, placed: [node(1, 5), node(2, 9)] }))).toBe(true);
    const before = structuredClone([...scene.nodes.entries()]);
    const stale = packet({ tick: 46, generation: 1, placed: [node(1, 0), node(3, 7)], removed: [2] });
    expect(onPacket(scene, stale), 'the stale diff is skipped').toBe(false);
    expect(scene.tick, 'the tick does not go back').toBe(301);
    expect(scene.generation).toBe(1);
    expect([...scene.nodes.entries()], 'the node map is unchanged').toEqual(before);
    // The next live diff still applies.
    expect(onPacket(scene, packet({ tick: 302, generation: 1, placed: [node(3, 7)] }))).toBe(true);
    expect(scene.tick).toBe(302);
    expect(scene.nodes.get(3)?.cell_x).toBe(7);
  });
});

describe('sceneState — diff application', () => {
  it('upserts placed nodes and belts and advances the tick', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({ tick: 5, placed: [node(100)], belts: [belt(200, 1024)] }),
    );
    expect(scene.tick).toBe(5);
    expect(scene.nodes.get(100)).toEqual(node(100));
    expect(scene.belts.get(200)?.fill).toBe(1024);
  });

  it('upserts in place (a later packet overwrites a node/belt by handle)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, placed: [node(100, 0)] }));
    applyPacket(scene, packet({ tick: 2, placed: [node(100, 9)] }));
    expect(scene.nodes.size).toBe(1);
    expect(scene.nodes.get(100)?.cell_x).toBe(9);
  });

  it('removes handles from both node and belt maps (shared handle space)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, placed: [node(100)], belts: [belt(200)] }));
    applyPacket(scene, packet({ tick: 2, removed: [100, 200] }));
    expect(scene.nodes.has(100)).toBe(false);
    expect(scene.belts.has(200)).toBe(false);
  });

  it('treats a full packet as a keyframe that resets the buffer', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, placed: [node(1), node(2)] }));
    applyPacket(scene, packet({ tick: 2, full: true, placed: [node(9)] }));
    expect(scene.nodes.size).toBe(1);
    expect(scene.nodes.has(9)).toBe(true);
    expect(scene.nodes.has(1)).toBe(false);
  });

  it('starts with an EMPTY previous-slot cache and keeps it out of the read-only snapshot (SLOT-04)', () => {
    // The cache's own diff/keyframe/removal behaviour is gated in items.interp.test.ts,
    // which is the file that owns trailing interpolation's sourcing half. What belongs
    // HERE is the buffer contract: a fresh scene has no history, and the field is
    // deliberately absent from `sceneSnapshot`. NOTE the narrowing (PILE-06): what is
    // withheld is THIS MAP, the per-frame interpolation buffer, not per-item facts in
    // general - the snapshot now reports `occupiedSlots` / `headOccupied` per belt.
    // The buffer contract is unchanged; the opacity doctrine it used to cite is not.
    const scene = createSceneState();
    expect(scene.prevItemSlots.size).toBe(0);
    applyPacket(scene, packet({ tick: 1, belts: [belt(200)] }));
    expect(Object.keys(sceneSnapshot(scene))).not.toContain('prevItemSlots');
  });
});

const item = (arrival_tick = 0, tag = 0): ItemView => ({ arrival_tick, tag });

describe('sceneState — sceneSnapshot (read-only introspection, REND-02)', () => {
  it('expands a multi-cell node into its footprint cells + reports state and tick', () => {
    const scene = createSceneState();
    // A 2x3 (rot 0) node at (4,5): 6 footprint cells, faulted (state 2).
    applyPacket(
      scene,
      packet({
        tick: 42,
        placed: [{ ...node(7, 4), cell_y: 5, w: 2, h: 3, rot: 0, state: 2, kind: 5 }],
      }),
    );

    const snap = sceneSnapshot(scene);
    expect(snap.tick).toBe(42);
    const n = snap.nodes.find((x) => x.id === 7);
    expect(n).toBeDefined();
    expect(n?.kind).toBe(5);
    expect(n?.state).toBe(2);
    // 2 wide x 3 tall anchored at (4,5) → 6 cells.
    expect(n?.cells).toEqual([
      [4, 5],
      [4, 6],
      [4, 7],
      [5, 5],
      [5, 6],
      [5, 7],
    ]);
  });

  it('reports a belt item count (a number), never the individual items', () => {
    const scene = createSceneState();
    const b: BeltView = { ...belt(200), items: [item(1, 0), item(2, 0)] };
    applyPacket(scene, packet({ tick: 3, belts: [b] }));

    const snap = sceneSnapshot(scene);
    const sb = snap.belts.find((x) => x.id === 200);
    expect(sb).toBeDefined();
    expect(sb?.items).toBe(2);
    expect(typeof sb?.items).toBe('number');
  });

  it('reports per-node port roles and per-belt dock ends (P22 E2E-03 oracle surface)', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({
        tick: 7,
        placed: [
          {
            ...node(5, 2),
            cell_y: 3,
            w: 3,
            h: 3,
            ports: [
              { index: 0, cell_x: 2, cell_y: 4, side: 3, role: 0, medium: 0 },
              { index: 1, cell_x: 4, cell_y: 4, side: 1, role: 1, medium: 0 },
              { index: 2, cell_x: 3, cell_y: 5, side: 2, role: 2, medium: 0 },
            ],
          },
        ],
        belts: [{ ...belt(9), docks: [{ end: 'Tail', node: 5, port: 2 }] }],
      }),
    );

    const snap = sceneSnapshot(scene);
    const n = snap.nodes.find((x) => x.id === 5);
    expect(n?.ports).toEqual([
      { index: 0, cell_x: 2, cell_y: 4, side: 3, role: 0, medium: 0 },
      { index: 1, cell_x: 4, cell_y: 4, side: 1, role: 1, medium: 0 },
      { index: 2, cell_x: 3, cell_y: 5, side: 2, role: 2, medium: 0 },
    ]);
    const b = snap.belts.find((x) => x.id === 9);
    expect(b?.docks).toEqual([{ end: 'Tail', node: 5, port: 2 }]);
    // BELT-02: the belt's advance interval reaches the read-only snapshot. It is
    // the MODEL's reading of a pace, and it is what the live gate asserts a pace
    // edit against - the panel that raised the edit cannot be its own witness.
    // Asserted against a NON-DEFAULT value so a projection hard-coding the crate
    // default would redden here rather than agree by luck.
    expect(sceneSnapshot(scene).belts.find((x) => x.id === 9)?.ticksPerSlot).toBe(1);
    applyPacket(scene, packet({ tick: 2, belts: [{ ...belt(9), ticks_per_slot: 7 }] }));
    expect(sceneSnapshot(scene).belts.find((x) => x.id === 9)?.ticksPerSlot).toBe(7);
  });

  it('deep-copies ports and docks: mutating a snapshot never reaches the scene', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({
        tick: 1,
        placed: [
          { ...node(5), ports: [{ index: 0, cell_x: 0, cell_y: 0, side: 3, role: 0, medium: 0 }] },
        ],
        belts: [{ ...belt(9), docks: [{ end: 'Head', node: 5, port: 0 }] }],
      }),
    );

    const snap = sceneSnapshot(scene);
    // Tamper with the returned ports/docks as aggressively as a page script could.
    snap.nodes[0].ports[0].role = 2;
    snap.nodes[0].ports.push({ index: 9, cell_x: 9, cell_y: 9, side: 0, role: 1, medium: 0 });
    snap.belts[0].docks[0].node = 777;
    snap.belts[0].docks.length = 0;

    // The live scene is untouched — the snapshot held no live references.
    expect(scene.nodes.get(5)?.ports).toEqual([
      { index: 0, cell_x: 0, cell_y: 0, side: 3, role: 0, medium: 0 },
    ]);
    expect(scene.belts.get(9)?.docks).toEqual([{ end: 'Head', node: 5, port: 0 }]);

    // And a fresh snapshot reflects the real state, not the mutated copy.
    const again = sceneSnapshot(scene);
    // sceneSnapshot projects to FabricoPort, which now carries `medium` (exposed
    // for the ROUTE-06 live gate) alongside role/side.
    expect(again.nodes[0].ports).toEqual([
      { index: 0, cell_x: 0, cell_y: 0, side: 3, role: 0, medium: 0 },
    ]);
    expect(again.belts[0].docks).toEqual([{ end: 'Head', node: 5, port: 0 }]);
  });

  it('mirrors canUndo/canRedo as plain booleans (P22 E2E oracle surface)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 4, can_undo: true, can_redo: false }));

    const snap = sceneSnapshot(scene);
    expect(snap.canUndo, 'snapshot canUndo mirrors packet can_undo').toBe(true);
    expect(snap.canRedo, 'snapshot canRedo mirrors packet can_redo').toBe(false);

    // Plain values, not live references: tampering with the snapshot booleans
    // never reaches back into SceneState (T-14-FABRICO-RO snapshot purity).
    snap.canUndo = false;
    snap.canRedo = true;
    expect(scene.canUndo, 'live scene canUndo untouched by snapshot mutation').toBe(true);
    expect(scene.canRedo, 'live scene canRedo untouched by snapshot mutation').toBe(false);

    // A fresh snapshot reflects the real state, not the mutated copy.
    const again = sceneSnapshot(scene);
    expect(again.canUndo).toBe(true);
    expect(again.canRedo).toBe(false);
  });

  it('is a fresh plain-data snapshot: mutating it never reaches the live scene (T-14-FABRICO-RO)', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({
        tick: 1,
        placed: [{ ...node(1, 0), w: 1, h: 1 }],
        belts: [{ ...belt(200), items: [item()] }],
      }),
    );

    const snap = sceneSnapshot(scene);
    // Tamper with the returned object as aggressively as a page script could.
    snap.tick = 9999;
    snap.nodes[0].state = 2;
    snap.nodes[0].cells.push([99, 99]);
    snap.belts[0].items = 12345;
    snap.belts.push({
      id: 777,
      tiles: [],
      items: 0,
      occupiedSlots: [],
      headOccupied: false,
      docks: [],
      ticksPerSlot: 2,
    });

    // The live scene is untouched — the snapshot held no live references.
    expect(scene.tick).toBe(1);
    expect(scene.nodes.get(1)?.state).toBe(0);
    expect(scene.belts.get(200)?.items.length).toBe(1);
    expect(scene.belts.size).toBe(1);

    // And a fresh snapshot reflects the real state, not the mutated copy.
    const again = sceneSnapshot(scene);
    expect(again.tick).toBe(1);
    expect(again.nodes[0].state).toBe(0);
    expect(again.belts[0].items).toBe(1);
  });
});

// PILE-06: the belt's per-slot occupancy reaches the read-only snapshot.
//
// This is the block that reverses the "a belt reports a COUNT and nothing else"
// doctrine, so it is written to fail if the derivation is faked. Every case drives
// a REAL packet through `applyPacket` and reads `sceneSnapshot`: a hand-built
// `SceneState` would still pass if the decode path stopped filling `items`, which
// is precisely the regression these cases exist to catch.
//
// Slot-index convention (crates/fabrico-core/src/belt_slots.rs): slot 0 is the
// HEAD, the deliver/output end, which is why `headOccupied` means "the tile
// pressed against the downstream machine holds an item". The host puts the slot
// index on the wire as `ItemView.arrival_tick` (render_packet.rs enumerates
// BEFORE the filter_map), which is the same reading `prevItemSlots` already takes.
describe('sceneState - per-belt slot occupancy (PILE-06)', () => {
  it('reports occupiedSlots [0, 2] and headOccupied TRUE for items at the head and slot 2', () => {
    const scene = createSceneState();
    const b: BeltView = { ...belt(200), items: [item(0), item(2)] };
    applyPacket(scene, packet({ tick: 3, belts: [b] }));

    const sb = sceneSnapshot(scene).belts.find((x) => x.id === 200);
    expect(sb?.occupiedSlots).toEqual([0, 2]);
    expect(sb?.headOccupied).toBe(true);
    // The count survives the widening: every existing live spec reads it.
    expect(sb?.items).toBe(2);
  });

  it('reports headOccupied FALSE when the head slot is clear (items at 2 and 3 only)', () => {
    const scene = createSceneState();
    const b: BeltView = { ...belt(200), items: [item(2), item(3)] };
    applyPacket(scene, packet({ tick: 3, belts: [b] }));

    const sb = sceneSnapshot(scene).belts.find((x) => x.id === 200);
    expect(sb?.occupiedSlots).toEqual([2, 3]);
    expect(sb?.headOccupied).toBe(false);
    // Same COUNT as the head-occupied case above: this is the pair that proves
    // `items` alone cannot answer PILE-06's question and the new field can.
    expect(sb?.items).toBe(2);
  });

  it('reports an EMPTY belt as occupiedSlots [] and headOccupied false (the empty read)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, belts: [belt(200)] }));

    const sb = sceneSnapshot(scene).belts.find((x) => x.id === 200);
    expect(sb?.occupiedSlots).toEqual([]);
    expect(sb?.headOccupied).toBe(false);
  });

  it('sorts ASCENDING and drops duplicates, whatever order the packet arrived in', () => {
    const scene = createSceneState();
    // Deliberately out of order AND duplicated: the host emits ascending-unique
    // today, so asserting the property on a well-formed packet would be a check
    // that cannot fail. Feed it a packet only a hostile/buggy producer emits.
    const b: BeltView = { ...belt(200), items: [item(5), item(0), item(5), item(2)] };
    applyPacket(scene, packet({ tick: 4, belts: [b] }));

    const sb = sceneSnapshot(scene).belts.find((x) => x.id === 200);
    expect(sb?.occupiedSlots).toEqual([0, 2, 5]);
    expect(sb?.headOccupied).toBe(true);
    // `items` stays the raw view count and is NOT deduped: the two fields answer
    // different questions and neither is derived from the other.
    expect(sb?.items).toBe(4);
  });

  it('hands out a FRESH occupiedSlots array per call (deep-copy discipline, T-14-FABRICO-RO)', () => {
    const scene = createSceneState();
    const b: BeltView = { ...belt(200), items: [item(0), item(1)] };
    applyPacket(scene, packet({ tick: 3, belts: [b] }));

    const first = sceneSnapshot(scene).belts[0];
    const second = sceneSnapshot(scene).belts[0];
    expect(first.occupiedSlots).not.toBe(second.occupiedSlots);

    // Tamper as aggressively as a page script could.
    first.occupiedSlots.push(999);
    first.occupiedSlots[0] = -1;
    first.headOccupied = false;

    expect(scene.belts.get(200)?.items.map((i) => i.arrival_tick)).toEqual([0, 1]);
    const again = sceneSnapshot(scene).belts[0];
    expect(again.occupiedSlots).toEqual([0, 1]);
    expect(again.headOccupied).toBe(true);
  });
});

describe('sceneState — wire projections + reply-home latch (WUI-01)', () => {
  it('upserts wires into the scene and drops them on removal', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, wires: [wire(20), wire(21)] }));
    expect(scene.wires.size).toBe(2);
    // A removed handle drops from the wires map too (shared dense handle space).
    applyPacket(scene, packet({ tick: 2, removed: [20] }));
    expect(scene.wires.has(20)).toBe(false);
    expect(scene.wires.has(21)).toBe(true);
  });

  it('a dormant wire snapshots with an empty pulses array and does NOT latch a reply', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, wires: [wire(20)] }));
    const snap = sceneSnapshot(scene);
    expect(snap.wires).toHaveLength(1);
    expect(snap.wires[0].id).toBe(20);
    expect(snap.wires[0].pulses).toHaveLength(0);
    expect(snap.wires[0].tiles).toBe(2);
    // Dormant: no reply-home observation.
    expect(snap.replyPulsesObserved).toBe(0);
  });

  it('latches replyPulsesObserved when a wire carries a REPLY pulse, not a FORWARD one', () => {
    const scene = createSceneState();
    // A FORWARD pulse (direction 0) does NOT latch the reply-home counter.
    applyPacket(
      scene,
      packet({ tick: 1, wires: [wire(20, [{ entry_tick: 0, hop_ticks: 4, direction: 0 }])] }),
    );
    expect(scene.replyPulsesObserved).toBe(0);
    // A REPLY pulse (direction 1) latches it — the amber reply-home comet.
    applyPacket(
      scene,
      packet({ tick: 2, wires: [wire(21, [{ entry_tick: 1, hop_ticks: 4, direction: 1 }])] }),
    );
    expect(scene.replyPulsesObserved).toBe(1);
    // Each subsequent packet carrying a reply pulse bumps it monotonically.
    applyPacket(
      scene,
      packet({ tick: 3, wires: [wire(21, [{ entry_tick: 2, hop_ticks: 4, direction: 1 }])] }),
    );
    expect(scene.replyPulsesObserved).toBe(2);
    expect(sceneSnapshot(scene).replyPulsesObserved).toBe(2);
  });

  it('deep-copies wire pulses so the snapshot holds no live reference', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({ tick: 1, wires: [wire(20, [{ entry_tick: 0, hop_ticks: 4, direction: 1 }])] }),
    );
    const snap = sceneSnapshot(scene);
    snap.wires[0].pulses[0].direction = 0; // mutate the copy
    // The live scene is untouched (T-14-FABRICO-RO).
    expect(scene.wires.get(20)!.pulses[0].direction).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CABLE-07 (plan 75-06, D-07): the re-route generation. A DIFF re-sending a held wire on
// a different PATH bumps it; a pulse-only re-send, a first sighting and a keyframe do not;
// a keyframe clears the map and a removed handle drops its entry.
// ---------------------------------------------------------------------------
describe('sceneState - re-route generations (CABLE-07)', () => {
  /** The same wire id one row lower: a different path. */
  const moved = (id: number, pulses: WireView['pulses'] = []): WireView => ({
    ...wire(id, pulses),
    path: [
      { cell_x: 2, cell_y: 13, kind: { Straight: { axis: 0 } } },
      { cell_x: 3, cell_y: 13, kind: { Straight: { axis: 0 } } },
    ],
  });

  it('a diff re-sending a held wire on a new path bumps its generation, once per change', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, full: true, wires: [wire(20)] }));
    expect(scene.wireReroutes.has(20), 'a first sighting is not a re-route').toBe(false);
    applyPacket(scene, packet({ tick: 2, wires: [moved(20)] }));
    expect(scene.wireReroutes.get(20)).toBe(1);
    applyPacket(scene, packet({ tick: 3, wires: [moved(20)] }));
    expect(scene.wireReroutes.get(20), 'the same path again is not a second change').toBe(1);
    applyPacket(scene, packet({ tick: 4, wires: [wire(20)] }));
    expect(scene.wireReroutes.get(20), 'moving back is a second change').toBe(2);
  });

  it('a change of tile KIND alone on the same cells is a re-route', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, full: true, wires: [wire(20)] }));
    const bent: WireView = {
      ...wire(20),
      path: [
        { cell_x: 2, cell_y: 12, kind: { Straight: { axis: 0 } } },
        { cell_x: 3, cell_y: 12, kind: { Corner: { from: 3, to: 0 } } },
      ],
    };
    applyPacket(scene, packet({ tick: 2, wires: [bent] }));
    expect(scene.wireReroutes.get(20)).toBe(1);
  });

  it('a pulse-only re-send does not bump', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, full: true, wires: [wire(20)] }));
    applyPacket(scene, packet({ tick: 2, wires: [wire(20, [{ entry_tick: 2, hop_ticks: 1, direction: 0 }])] }));
    applyPacket(scene, packet({ tick: 3, wires: [wire(20, [{ entry_tick: 3, hop_ticks: 1, direction: 1 }])] }));
    expect(scene.wireReroutes.has(20)).toBe(false);
  });

  it('a first sighting in a diff does not bump', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, wires: [wire(20)] }));
    expect(scene.wireReroutes.has(20)).toBe(false);
  });

  it('a full packet moving a held wire does not bump, and clears every generation', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, full: true, wires: [wire(20), wire(21)] }));
    applyPacket(scene, packet({ tick: 2, wires: [moved(21)] }));
    expect(scene.wireReroutes.get(21)).toBe(1);
    applyPacket(scene, packet({ tick: 3, full: true, wires: [moved(20), wire(21)] }));
    expect(scene.wireReroutes.size, 'the undo shape clears and marks nothing').toBe(0);
  });

  it('a generation is never reused after a keyframe clears the map', () => {
    // The layer keeps an expired mark's generation; a re-route numbered the same after a
    // clear would hide behind it. Generations come from one scene-wide sequence.
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, full: true, wires: [wire(20)] }));
    applyPacket(scene, packet({ tick: 2, wires: [moved(20)] }));
    const first = scene.wireReroutes.get(20);
    applyPacket(scene, packet({ tick: 3, full: true, wires: [moved(20)] }));
    applyPacket(scene, packet({ tick: 4, wires: [wire(20)] }));
    expect(scene.wireReroutes.get(20)).toBeDefined();
    expect(scene.wireReroutes.get(20), 'a fresh generation after the clear').not.toBe(first);
  });

  it('a removed handle drops its generation', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, full: true, wires: [wire(20)] }));
    applyPacket(scene, packet({ tick: 2, wires: [moved(20)] }));
    expect(scene.wireReroutes.get(20)).toBe(1);
    applyPacket(scene, packet({ tick: 3, removed: [20] }));
    expect(scene.wireReroutes.has(20)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WR-06: the reverse dock index. It exists so the config panel's ~10Hz per-port
// flow join costs O(belts docked to the selected machine) instead of O(every belt
// on the board). Correctness rests entirely on it being RETRACTED as faithfully as
// it is added - a stale entry would report a belt on a port it has left.
// ---------------------------------------------------------------------------
describe('sceneState — reverse dock index (beltsDockedTo)', () => {
  const docked = (id: number, docks: BeltView['docks']): BeltView => ({ ...belt(id), docks });

  it('indexes BOTH ends: one belt is docked to two different nodes', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({
        belts: [
          docked(200, [
            { end: 'Head', node: 5, port: 0 },
            { end: 'Tail', node: 6, port: 1 },
          ]),
        ],
      }),
    );
    expect(beltsDockedTo(scene, 5).map((b) => b.id)).toEqual([200]);
    expect(beltsDockedTo(scene, 6).map((b) => b.id)).toEqual([200]);
    expect(beltsDockedTo(scene, 7), 'an undocked-to node yields nothing').toEqual([]);
  });

  it('returns LIVE belt views, so a re-emitted item count is read without a rebuild', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ belts: [docked(200, [{ end: 'Tail', node: 5, port: 0 }])] }));
    applyPacket(
      scene,
      packet({
        belts: [
          { ...docked(200, [{ end: 'Tail', node: 5, port: 0 }]), items: [item(), item()] },
        ],
      }),
    );
    expect(beltsDockedTo(scene, 5)[0].items.length).toBe(2);
  });

  it('RETRACTS the old docks when a belt re-emits with different ones (a de-dock)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ belts: [docked(200, [{ end: 'Tail', node: 5, port: 0 }])] }));
    // The host unlinks it from node 5 and docks it to node 6 instead.
    applyPacket(scene, packet({ belts: [docked(200, [{ end: 'Tail', node: 6, port: 0 }])] }));
    expect(beltsDockedTo(scene, 5), 'the belt must not haunt its old node').toEqual([]);
    expect(beltsDockedTo(scene, 6).map((b) => b.id)).toEqual([200]);
    expect(scene.dockedBelts.has(5), 'an emptied set is pruned, not left behind').toBe(false);
  });

  it('drops a removed belt from the index', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ belts: [docked(200, [{ end: 'Tail', node: 5, port: 0 }])] }));
    applyPacket(scene, packet({ removed: [200] }));
    expect(beltsDockedTo(scene, 5)).toEqual([]);
    expect(scene.dockedBelts.size).toBe(0);
  });

  it('keeps the OTHER belts when one of several docked to the same node goes', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({
        belts: [
          docked(200, [{ end: 'Tail', node: 5, port: 0 }]),
          docked(201, [{ end: 'Tail', node: 5, port: 1 }]),
        ],
      }),
    );
    applyPacket(scene, packet({ removed: [200] }));
    expect(beltsDockedTo(scene, 5).map((b) => b.id)).toEqual([201]);
  });

  it('a keyframe resets the index with the rest of the scene', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ belts: [docked(200, [{ end: 'Tail', node: 5, port: 0 }])] }));
    applyPacket(scene, packet({ full: true, belts: [] }));
    expect(beltsDockedTo(scene, 5)).toEqual([]);
    expect(scene.dockedBelts.size).toBe(0);
  });

  // WR-06 (iteration 2): this case used to prove an equivalence nothing relied
  // on - the App poll read the index, but the SELECTION EDGE still full-scanned
  // `scene.belts`, so two derivations fed one gate and this test only pinned that
  // they happened to agree. Both paths now go through `beltsDockedTo`, which
  // makes this the single equivalence proof for the port-flow join: if the index
  // ever diverges from a full scan, the panel's dock gate is wrong EVERYWHERE
  // rather than in one of two places.
  it('agrees with a full scan of every belt (the shape it replaced)', () => {
    const scene = createSceneState();
    applyPacket(
      scene,
      packet({
        belts: [
          docked(200, [{ end: 'Tail', node: 5, port: 0 }]),
          docked(201, [{ end: 'Head', node: 9, port: 0 }]),
          docked(202, [
            { end: 'Head', node: 5, port: 65535 },
            { end: 'Tail', node: 9, port: 2 },
          ]),
          belt(203),
        ],
      }),
    );
    for (const nodeId of [5, 9, 42]) {
      const scanned = [...scene.belts.values()]
        .filter((b) => b.docks.some((d) => d.node === nodeId))
        .map((b) => b.id)
        .sort();
      expect(
        beltsDockedTo(scene, nodeId)
          .map((b) => b.id)
          .sort(),
        `node ${nodeId}`,
      ).toEqual(scanned);
    }
  });
});

// THE PER-WIRE REPLY LATCH (plan 84-18, push 6). CI run 5 failed `25-route-and-handler` SERVE-07:
// the reply pulse lives on its wire for one packet, and a slow page's poll read that wire's
// `pulses` empty on every read while the board-wide latch had counted it.
describe('sceneState — the per-wire reply latch (plan 84-18)', () => {
  const reply = (entry: number) => [{ entry_tick: entry, hop_ticks: 1, direction: 1 }];
  it('keeps the count on THAT wire after the next packet clears its pulse (the one-packet window a slow reader misses)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, wires: [wire(20), wire(21)] }));
    applyPacket(scene, packet({ tick: 2, wires: [wire(21, reply(1))] }));
    applyPacket(scene, packet({ tick: 3, wires: [wire(21)] }));
    const snap = sceneSnapshot(scene);
    expect(snap.wires.find((w) => w.id === 21)?.pulses).toEqual([]);
    expect(snap.wires.map((w) => [w.id, w.replyPulsesSeen])).toEqual([
      [20, 0],
      [21, 1],
    ]);
    expect(snap.replyPulsesObserved).toBe(1);
  });
  it('does not count a FORWARD pulse', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, wires: [wire(20, [{ entry_tick: 0, hop_ticks: 1, direction: 0 }])] }));
    expect(sceneSnapshot(scene).wires[0].replyPulsesSeen).toBe(0);
  });
  it('a keyframe clears it, and a removed handle drops it (dense handles are reused)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 1, wires: [wire(20, reply(0)), wire(21, reply(0))] }));
    applyPacket(scene, packet({ tick: 2, removed: [20] }));
    expect(scene.wireReplyPulses.has(20)).toBe(false);
    applyPacket(scene, packet({ tick: 3, wires: [wire(20)] }));
    expect(sceneSnapshot(scene).wires.find((w) => w.id === 20)?.replyPulsesSeen).toBe(0);
    applyPacket(scene, packet({ tick: 4, full: true, wires: [wire(21)] }));
    expect(sceneSnapshot(scene).wires[0].replyPulsesSeen).toBe(0);
  });
});
