//! THE PIN FOR B1: the mock e2e packet BUILDER and the shipped DECODER must agree.
//!
//! # The defect this file exists to keep dead
//! `e2e/support/wire.ts` is a second, hand-written producer of the same postcard wire
//! format the Rust host produces. When Phase 62 appended `ticks_per_slot` to
//! `BeltView`, `decode.ts` learned the field and `wire.ts` did not. Every field after
//! `docks` in a mock belt fixture then shifted by one: `ticks_per_slot` ate the
//! `canUndo` byte, `can_undo` ate `canRedo`, `can_redo` ate the wires-vec length, and
//! the wires vec underran into the TOP-LEVEL degrade path and silently became `[]`.
//! Nothing threw. 186 mock specs stayed green while every belt-bearing fixture
//! rendered at `ticks_per_slot = 1`, twice the shipped pace, and inverted undo/redo.
//!
//! # Why it was invisible
//! `frontend/tsconfig.json`'s `include` is `["scripts", "src", "shared", ...]` - `e2e/`
//! is absent, so `tsc --noEmit` never reads `wire.ts`. Phase 62 enumerated its blast
//! radius WITH THE COMPILER (`62-01-SUMMARY.md:248`, fourteen literal sites), so this
//! producer was structurally incapable of appearing in that enumeration. A grep would
//! have found it; the type checker could not.
//!
//! # Why this test lives in `src/` and not in `e2e/`
//! So that both `tsc --noEmit` and `vitest` see it. `vitest.config.ts` includes
//! `src/**/*.{test,spec}.{ts,tsx}` only, and tsc includes `src` only. A pin for a
//! producer nothing type-checks has to be reachable from the side that IS checked.
//!
//! # Why it asserts DECODED VALUES, not byte counts
//! A byte-count assertion would pass on any producer that writes the right NUMBER of
//! bytes in the wrong ORDER, which is the shape of every future append-last field.
//! Round-tripping through the real decoder is the only assertion that cannot.

import { describe, expect, it } from 'vitest';

import { buildPacket, type InjectNode } from '../../e2e/support/wire';
import { decodeRenderPacket } from './decode';

/** The shipped default, `fabrico-core::belt_slots::DEFAULT_TICKS_PER_SLOT`. */
const SHIPPED_TICKS_PER_SLOT = 2;

describe('the mock e2e packet builder round-trips through the shipped decoder', () => {
  it('decodes a belt-bearing packet with every field in its own place', () => {
    // canUndo and canRedo are DELIBERATELY DIFFERENT. When they matched, the
    // one-field shift left `can_undo` reading correctly by coincidence and only
    // `can_redo` went wrong, which is exactly how a shifted packet hides.
    const packet = decodeRenderPacket(
      buildPacket({
        canUndo: true,
        canRedo: false,
        belts: [
          {
            id: 7,
            latency: 8,
            tiles: [
              [2, 2],
              [3, 2],
            ],
            docks: [],
          },
        ],
      }),
    );

    expect(packet.belts).toHaveLength(1);
    const belt = packet.belts[0];

    // The appended-last field itself, at the SHIPPED pace. Reading 1 here is the
    // signature of the original defect: 1 is the `canUndo` byte, not a pace.
    expect(belt.ticks_per_slot).toBe(SHIPPED_TICKS_PER_SLOT);

    // The fields the shift corrupted downstream of the belt. These are the assertions
    // that catch the NEXT append-last field, not just this one.
    expect(packet.can_undo).toBe(true);
    expect(packet.can_redo).toBe(false);
    expect(packet.wires).toEqual([]);

    // And the belt's own earlier fields, so a shift in the other direction is caught.
    expect(belt.id).toBe(7);
    expect(belt.latency).toBe(8);
    expect(belt.tiles).toHaveLength(2);
  });

  it('honours an explicit ticksPerSlot override', () => {
    const packet = decodeRenderPacket(
      buildPacket({
        canUndo: false,
        canRedo: true,
        belts: [{ id: 1, tiles: [[0, 0]], ticksPerSlot: 5 }],
      }),
    );

    expect(packet.belts[0].ticks_per_slot).toBe(5);
    // Still correctly framed either side of the override.
    expect(packet.can_undo).toBe(false);
    expect(packet.can_redo).toBe(true);
  });

  it('frames a MULTI-belt packet, where a per-belt shift compounds', () => {
    // With two belts, a missing per-belt field does not merely shift the tail - the
    // SECOND belt's decode starts mid-record. A single-belt test cannot see that.
    const packet = decodeRenderPacket(
      buildPacket({
        canUndo: true,
        canRedo: false,
        belts: [
          { id: 1, tiles: [[0, 0]], ticksPerSlot: 2 },
          { id: 2, tiles: [[5, 5]], ticksPerSlot: 3 },
        ],
      }),
    );

    expect(packet.belts.map((b) => [b.id, b.ticks_per_slot])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(packet.can_undo).toBe(true);
    expect(packet.can_redo).toBe(false);
  });
});

/**
 * THE OTHER HALF OF B1, AND THE HALF THAT WAS MISSING.
 *
 * Every case in the describe above builds a packet with NO `nodes` key. That made this
 * file, whose own header claims it pins "the mock e2e packet BUILDER and the shipped
 * DECODER must agree", a check that could only ever fail on `BeltView` growth. When
 * plan 71-05 appended `NodeView.load` after `ports` and taught only `decode.ts` to read
 * it, this file stayed green, `tsc` never reads `e2e/`, and 45 mock e2e specs went red
 * on an empty scene instead. The producer/decoder pin has to exercise BOTH vecs or it
 * is only ever pinning the one that last broke.
 *
 * Framing here is stricter than in the belt half because `NodeView` carries a nested
 * `Vec<PortView>`: a missed read at the end of a node does not merely shift the tail,
 * it feeds a stray byte into the NEXT node's `id` varint. So the fixture is
 * MULTI-NODE, a ported node is followed by further nodes, and every scalar is a
 * DISTINCT non-default value - a fixture of zeroes round-trips clean under a shift
 * that happens to land on another zero.
 */
describe('the mock e2e packet builder frames NodeView too', () => {
  /** Three nodes. The FIRST carries ports, so the ports vec is between the fields a
   *  shift would corrupt and the nodes that follow it. `load` is distinct per node and
   *  never 0, so a producer that omits the byte cannot read correctly by luck. */
  const NODES: InjectNode[] = [
    {
      id: 100,
      kind: 3,
      cell_x: 4,
      cell_y: -5,
      state: 3,
      w: 2,
      h: 3,
      rot: 1,
      load: 4,
      ports: [
        { index: 0, cell_x: 4, cell_y: -5, side: 3, role: 0, medium: 0 },
        { index: 1, cell_x: 5, cell_y: -3, side: 1, role: 1, medium: 0 },
      ],
    },
    { id: 101, kind: 7, cell_x: 9, cell_y: 9, state: 2, load: 1 },
    { id: 102, kind: 5, cell_x: -1, cell_y: 2, state: 1, load: 3 },
  ];

  it('decodes a MULTI-node packet with every node field in its own place', () => {
    const packet = decodeRenderPacket(
      buildPacket({ canUndo: true, canRedo: false, nodes: NODES }),
    );

    // The ids first: a byte eaten anywhere inside node 100 lands in node 101's id
    // varint, so this line alone catches any missed read in the first record.
    expect(packet.placed.map((n) => n.id)).toEqual([100, 101, 102]);

    // The appended-last field itself, on all three. Reading 0 on node 100 is the
    // signature of the original defect: 0 is the `removed` vec length, not a load.
    expect(packet.placed.map((n) => n.load)).toEqual([4, 1, 3]);

    // Every other scalar, so a shift in either direction inside a node is caught
    // rather than only a shift off its end.
    expect(
      packet.placed.map((n) => [n.kind, n.cell_x, n.cell_y, n.state, n.w, n.h, n.rot]),
    ).toEqual([
      [3, 4, -5, 3, 2, 3, 1],
      [7, 9, 9, 2, 1, 1, 0],
      [5, -1, 2, 1, 1, 1, 0],
    ]);

    // The nested ports vec, whose length prefix is what a shifted reader misreads
    // into a wild allocation or a swallowed neighbour.
    expect(packet.placed.map((n) => n.ports.length)).toEqual([2, 0, 0]);
    expect(packet.placed[0].ports.map((p) => [p.index, p.side, p.role, p.medium])).toEqual([
      [0, 3, 0, 0],
      [1, 1, 1, 0],
    ]);

    // And the packet tail, which is where a node-vec shift finally surfaces. These
    // are the assertions that catch the NEXT field appended to NodeView.
    expect(packet.can_undo).toBe(true);
    expect(packet.can_redo).toBe(false);
    expect(packet.wires).toEqual([]);
  });

  it('frames nodes and belts TOGETHER, the shape every failing spec actually injects', () => {
    // The two vecs are adjacent on the wire with only the `removed` vec between them,
    // so a node-side shift is absorbed by the belt vec and can present as a wrong
    // BELT rather than a wrong node. Neither single-vec case above sees that.
    const packet = decodeRenderPacket(
      buildPacket({
        canUndo: false,
        canRedo: true,
        nodes: NODES,
        belts: [{ id: 7, tiles: [[2, 2]], ticksPerSlot: 5 }],
      }),
    );

    expect(packet.placed.map((n) => [n.id, n.load])).toEqual([
      [100, 4],
      [101, 1],
      [102, 3],
    ]);
    expect(packet.belts.map((b) => [b.id, b.ticks_per_slot])).toEqual([[7, 5]]);
    expect(packet.can_undo).toBe(false);
    expect(packet.can_redo).toBe(true);
    expect(packet.wires).toEqual([]);
  });

  it('defaults `load` to 0 for the fixtures that do not care, and still frames them', () => {
    // Most call sites will never name `load`. The default has to be a WRITTEN zero
    // byte, not an omitted field: omitting it is precisely the defect, and a default
    // that skips the write would reintroduce it silently on every unannotated fixture.
    const packet = decodeRenderPacket(
      buildPacket({ canUndo: true, canRedo: false, nodes: [{ id: 1, kind: 3, cell_x: 0, cell_y: 0 }] }),
    );

    expect(packet.placed).toHaveLength(1);
    expect(packet.placed[0].load).toBe(0);
    expect(packet.can_undo).toBe(true);
    expect(packet.can_redo).toBe(false);
    expect(packet.wires).toEqual([]);
  });
  it('writes resync and the generation on EVERY packet, defaulted, and honours each when named', () => {
    // MOVED BY PLAN 88-03 (D-02, D-05). Until then `resync` was written only when a
    // fixture named it, and the decoder degraded a missing byte to `false`. The tail is
    // strict now, so a packet without either field would not decode at all: both are
    // written on every packet, `resync` defaulting to `false` and `generation` to 0.
    const plain = decodeRenderPacket(buildPacket({ tick: 5, canUndo: true }));
    expect(plain.resync).toBe(false);
    expect(plain.generation).toBe(0);
    expect(buildPacket({ tick: 5, canUndo: true, resync: false })).toEqual(
      buildPacket({ tick: 5, canUndo: true }),
    );
    const resync = decodeRenderPacket(buildPacket({ tick: 5, canUndo: true, resync: true }));
    expect(resync.resync).toBe(true);
    expect(resync.can_undo).toBe(true);
    expect(resync.wires).toEqual([]);
    // A two-byte generation, so the builder's varint and the decoder's agree past 127.
    const later = decodeRenderPacket(buildPacket({ tick: 5, resync: true, generation: 300 }));
    expect(later.generation).toBe(300);
    expect(later.resync).toBe(true);
    // Phase 88 security (T-88-11): the swap floor after the generation, 0 when not named.
    expect(plain.swap_floor).toBe(0);
    const swapped = decodeRenderPacket(buildPacket({ tick: 5, generation: 300, swapFloor: 200 }));
    expect([swapped.generation, swapped.swap_floor], 'two two-byte varints, in order').toEqual([300, 200]);
  });
});
