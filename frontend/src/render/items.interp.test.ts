// The SOURCING half of trailing interpolation (SLOT-04, D-10/D-11/D-13): the per-belt
// previous-slot cache maintained on the packet path, and the two-pointer matcher that
// resolves each current dot's from-slot.
//
// WHY THIS FILE EXISTS SEPARATELY FROM sceneState.test.ts. That file gates the scene
// buffer's diff/keyframe contract. This one gates ONE property of it - that a dot can
// be told where it came from - and it is the property the drawing half is built on. The
// head-delivery case below is the whole reason the matcher is a two-pointer walk over
// slot VALUES rather than a rank/index match, and it was watched failing against a
// deliberate rank implementation before the real one was written (mutation R1, recorded
// in 62-05-SUMMARY.md).
//
// Every case here drives HAND-BUILT packet pairs through the real `applyPacket`, or the
// exported matcher directly. Nothing is derived from the code under test: each expected
// from-slot is typed out.

import { describe, expect, it } from 'vitest';
import type { BeltView, ItemView, RenderPacket } from '../protocol/decode.ts';
import { applyPacket, createSceneState, resolveFromSlots } from './sceneState.ts';

/** One item at slot `slot` (`arrival_tick` IS the slot index - see resolveFromSlots). */
const item = (slot: number): ItemView => ({ arrival_tick: slot, tag: 0 });

/** A 2-tile belt carrying items at the given slots, ASCENDING as the host emits them. */
const beltAt = (id: number, slots: number[], ticks_per_slot = 1): BeltView => ({
  id,
  latency: 8, // SLOTS_PER_TILE (4) * 2 tiles - the host's own invariant
  fill: slots.length,
  items: slots.map(item),
  tiles: [
    { cell_x: 0, cell_y: 0, kind: { Straight: { axis: 0 } } },
    { cell_x: 1, cell_y: 0, kind: { Straight: { axis: 0 } } },
  ],
  docks: [],
  ticks_per_slot,
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

/** Apply two packets in sequence and read back the resolved from-slots for `beltId`. */
function fromSlotsAcross(
  first: RenderPacket,
  second: RenderPacket,
  beltId: number,
): { from: number[]; atTick: number | undefined; cur: number[] } {
  const scene = createSceneState();
  applyPacket(scene, first);
  applyPacket(scene, second);
  const belt = scene.belts.get(beltId)!;
  const cur = belt.items.map((i) => i.arrival_tick);
  const hist = scene.prevItemSlots.get(beltId);
  return {
    from: hist ? resolveFromSlots(hist.slots, cur) : cur.slice(),
    atTick: hist?.atTick,
    cur,
  };
}

describe('trailing interpolation sourcing: the previous-slot cache (SLOT-04)', () => {
  it('two identical packets: every from-slot IS the current slot, so t is irrelevant', () => {
    const { from, cur, atTick } = fromSlotsAcross(
      packet({ tick: 10, belts: [beltAt(1, [2, 5])] }),
      packet({ tick: 11, belts: [beltAt(1, [2, 5])] }),
      1,
    );
    expect(cur).toEqual([2, 5]);
    expect(from).toEqual([2, 5]);
    expect(atTick).toBe(10);
  });

  it('one advance: every from-slot is its current slot PLUS ONE (items move headward)', () => {
    const { from, cur } = fromSlotsAcross(
      packet({ tick: 10, belts: [beltAt(1, [2, 5])] }),
      packet({ tick: 11, belts: [beltAt(1, [1, 4])] }),
      1,
    );
    expect(cur).toEqual([1, 4]);
    expect(from).toEqual([2, 5]);
  });

  it('THE HEAD IS DELIVERED OFF SLOT 0 and the array shifts: every surviving dot still keeps its OWN previous slot (a rank match hands it the one ahead)', () => {
    // Previous packet: three items, the leading one AT the head slot 0.
    // Current packet: the head was delivered, the other two advanced one each.
    // Ranks: the survivor now at slot 2 is rank 0, and the previous rank-0 slot is 0.
    // A rank match would give it from-slot 0 - three slots ahead of where it is, so the
    // dot would be drawn at the delivery end and slide BACKWARDS across the belt.
    const { from, cur } = fromSlotsAcross(
      packet({ tick: 20, belts: [beltAt(1, [0, 3, 6])] }),
      packet({ tick: 21, belts: [beltAt(1, [2, 5])] }),
      1,
    );
    expect(cur).toEqual([2, 5]);
    expect(from).toEqual([3, 6]);
    // Stated as the property, not just the array: no dot is handed a from-slot from
    // the item AHEAD of it, and every from-slot is its own slot or one behind it.
    for (let k = 0; k < cur.length; k++) {
      expect(from[k] - cur[k]).toBeGreaterThanOrEqual(0);
      expect(from[k] - cur[k]).toBeLessThanOrEqual(1);
    }
  });

  it('a NEWLY ADMITTED tail item resolves to its own slot, so it never slides in from off the belt', () => {
    // Slot 7 is the tail of an 8-slot belt and is absent from the previous packet.
    const { from, cur } = fromSlotsAcross(
      packet({ tick: 30, belts: [beltAt(1, [4])] }),
      packet({ tick: 31, belts: [beltAt(1, [3, 7])] }),
      1,
    );
    expect(cur).toEqual([3, 7]);
    expect(from).toEqual([4, 7]);
  });

  it('a belt seen for the FIRST time has no entry at all, so every item resolves to its own slot', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 5, belts: [beltAt(1, [1, 6])] }));
    expect(scene.prevItemSlots.has(1)).toBe(false);
  });

  it('a belt in packet.removed drops its cache entry (the dense handle space is shared)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 40, belts: [beltAt(1, [2])] }));
    applyPacket(scene, packet({ tick: 41, belts: [beltAt(1, [1])] }));
    expect(scene.prevItemSlots.get(1)).toEqual({ slots: [2], atTick: 40 });
    applyPacket(scene, packet({ tick: 42, removed: [1] }));
    expect(scene.prevItemSlots.has(1)).toBe(false);
    expect(scene.belts.has(1)).toBe(false);
  });

  it('a KEYFRAME clears every entry, so nothing leaks across a host swap (the WR-01 bug)', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 50, belts: [beltAt(1, [2]), beltAt(2, [5])] }));
    applyPacket(scene, packet({ tick: 51, belts: [beltAt(1, [1]), beltAt(2, [4])] }));
    expect(scene.prevItemSlots.size).toBe(2);
    applyPacket(scene, packet({ tick: 0, full: true, belts: [beltAt(9, [3])] }));
    expect(scene.prevItemSlots.size).toBe(0);
  });

  it('the cached slots are a COPY: mutating the outgoing view afterwards cannot reach them', () => {
    const scene = createSceneState();
    const first = beltAt(1, [2, 5]);
    applyPacket(scene, packet({ tick: 60, belts: [first] }));
    applyPacket(scene, packet({ tick: 61, belts: [beltAt(1, [1, 4])] }));
    first.items[0].arrival_tick = 999;
    expect(scene.prevItemSlots.get(1)!.slots).toEqual([2, 5]);
  });

  it('atTick is the tick the PREVIOUS slots were observed at, never the tick of the packet that displaced them', () => {
    const scene = createSceneState();
    applyPacket(scene, packet({ tick: 100, belts: [beltAt(1, [3])] }));
    applyPacket(scene, packet({ tick: 104, belts: [beltAt(1, [2])] }));
    expect(scene.prevItemSlots.get(1)).toEqual({ slots: [3], atTick: 100 });
  });
});

describe('trailing interpolation sourcing: resolveFromSlots directly', () => {
  it('an empty previous packet gives every current item its own slot', () => {
    expect(resolveFromSlots([], [0, 3, 7])).toEqual([0, 3, 7]);
  });

  it('an emptied belt resolves to an empty from-set', () => {
    expect(resolveFromSlots([0], [])).toEqual([]);
  });

  it('a full belt sliding one slot resolves every dot one slot back', () => {
    expect(resolveFromSlots([1, 2, 3, 4], [0, 1, 2, 3])).toEqual([1, 2, 3, 4]);
  });

  it('a BLOCKED belt (bunched at the head, nothing moved) resolves every dot to itself', () => {
    // The backpressure cue: a blocked item must NEVER be drawn ahead of its slot.
    expect(resolveFromSlots([0, 1, 2], [0, 1, 2])).toEqual([0, 1, 2]);
  });

  it('a delivery AND an admission in the same interval are both handled in one pass', () => {
    // prev: head at 0, one at 4. cur: the head is gone, 4 advanced to 3, 7 admitted.
    expect(resolveFromSlots([0, 4], [3, 7])).toEqual([4, 7]);
  });

  it('ASSERTION 2: a DRAINING CONTIGUOUS RUN resolves every dot one slot back, rather than freezing the whole belt', () => {
    // The head item at slot 1 is delivered; the two behind it advance into slots 1 and 2.
    // The only correct answer is [2, 3].
    //
    // WHY THIS ONE CASE NEEDED ITS OWN ASSERTION. Every shipped case above happens to
    // leave the matcher's head-end greed unexercised, so a LEFT-TO-RIGHT walk that tests
    // `prev === cur` FIRST passes all of them - and on this input it answers [1, 2],
    // freezing every dot on a belt that is visibly draining. The walk anchors on the
    // wrong end: the HEAD is where items are deleted, so a greedy match there is
    // ambiguous exactly when a delivery meets a contiguous run. The TAIL is where
    // deletions never happen and where admissions are detectable by slot value, so the
    // walk runs right-to-left and the ambiguity cannot arise.
    expect(resolveFromSlots([1, 2, 3], [1, 2])).toEqual([2, 3]);
  });

  it('never derives a from-slot more than one slot ahead of the current one (trailing-only, D-11)', () => {
    const prev = [0, 1, 5, 9];
    const cur = [1, 4, 8, 11];
    const from = resolveFromSlots(prev, cur);
    expect(from.length).toBe(cur.length);
    for (let k = 0; k < cur.length; k++) {
      expect(from[k]).toBeGreaterThanOrEqual(cur[k]);
      expect(from[k]).toBeLessThanOrEqual(cur[k] + 1);
    }
  });
});
