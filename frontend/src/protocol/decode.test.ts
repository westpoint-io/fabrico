import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  type GridCommand,
  type MachineConfig,
  PostcardReader,
  PostcardWriter,
  type SinkTemplate,
  type SourceTrigger,
  decodeRenderPacket,
  decodeRenderPacketFrom,
  encodeBeltRunPace,
  encodeGestureFrame,
  GESTURE_FRAME_VERSION,
  encodeGridCommand,
  BELT_RUN_PACE_LEAD,
} from './decode.ts';
import { machine_kind, state_tag } from './kinds.ts';
import { applyPacket, createSceneState } from '../render/sceneState.ts';

// The frozen 0008 cross-language golden fixture lives in the Rust crate
// (16-02). Resolving it relative to THIS test file keeps the path stable no
// matter the vitest cwd. This is the single cross-language contract anchor:
// the hand-rolled TS decoder must reproduce exactly what the Rust producer
// postcard-encoded — now including host-resolved ports[] and per-end docks[].
const fixtureUrl = (name: string) =>
  fileURLToPath(
    new URL(`../../../crates/fabrico-protocol/tests/fixtures/${name}`, import.meta.url),
  );

const goldenBytes = new Uint8Array(readFileSync(fixtureUrl('0008-render-packet.bin')));
const expected = JSON.parse(
  readFileSync(fixtureUrl('0008-render-packet.expected.json'), 'utf8'),
);

describe('decodeRenderPacket — 0008 golden fixture', () => {
  it('decodes the Rust-produced bytes to the expected object (cross-language anchor)', () => {
    const packet = decodeRenderPacket(goldenBytes);
    expect(packet).toEqual(expected);
  });

  it('consumes the whole buffer (no trailing bytes, no underrun)', () => {
    // Drive the decode off a reader THIS TEST owns, so the cursor is observable.
    // The previous version of this case constructed a reader, never decoded with
    // it, and then asserted that an untouched reader still had every byte left:
    // green for any decoder whatsoever, including one that reads nothing at all.
    const reader = new PostcardReader(goldenBytes);
    expect(decodeRenderPacketFrom(reader)).toEqual(expected);
    expect(reader.remaining()).toBe(0);
  });

  it('reads the board generation STRICTLY: the golden names a nonzero one, a packet cut before it throws', () => {
    // Phase 88 (D-02, D-05): `generation` is appended LAST, after `resync`. The golden
    // carries a NONZERO value, so a decoder that never read the field (and defaulted it
    // to 0) fails the deep-equal above; this case adds the other direction. A packet whose
    // generation byte is missing must FAIL to decode: a defaulted generation of 0 would
    // address every handle in it against the wrong table.
    expect(decodeRenderPacket(goldenBytes).generation).toBeGreaterThan(0);
    // The golden's last two bytes are the generation (7) and the swap floor (5, T-88-11).
    expect(decodeRenderPacket(goldenBytes).swap_floor).toBe(5);
    const cutBeforeGeneration = goldenBytes.slice(0, goldenBytes.length - 2);
    expect(() => decodeRenderPacket(cutBeforeGeneration)).toThrow(DecodeError);
  });

  it('carries a Fault PortView (role 2) and Head/Tail belt docks (PORT-02/03/05)', () => {
    const packet = decodeRenderPacket(goldenBytes);
    // A Fault port (role byte === 2) is present somewhere in the placed nodes —
    // the reserved wire value Phase 17's core Role::Fault slots into.
    const roles = packet.placed.flatMap((n) => n.ports.map((p) => p.role));
    expect(roles).toContain(0); // In
    expect(roles).toContain(1); // Out
    expect(roles).toContain(2); // Fault
    // The belt carries both a Head and a Tail dock (Head before Tail on the wire).
    const ends = packet.belts.flatMap((b) => b.docks.map((d) => d.end));
    expect(ends).toContain('Head');
    expect(ends).toContain('Tail');
  });
});

/**
 * THE TWO ASSERTIONS THAT SEE A MISSED POSITIONAL READ (71-05, UI-SPEC site 4).
 *
 * `readNodeView` decodes `fabrico_protocol::NodeView` field by field off a byte
 * reader. A `u8` added to the Rust struct with no matching `r.u8()` here does NOT
 * produce a missing value on the decoded object: it desynchronises the reader
 * mid-node. That has shipped in this repository once already, on the `medium`
 * append (the Phase 36 fix `readPortView`'s comment records).
 *
 * NOTHING ELSE IN THIS REPOSITORY SEES IT. `NodeView` carries a `ts-rs` derive, so
 * the generated binding grows the field for free, and `decode.ts` declares its OWN
 * local `NodeView` interface that `tsc` never compares to that binding. The
 * realistic mistake is forgetting BOTH together, which is green in `tsc`, in
 * `vitest` and in `cargo test`. These cases are the check.
 */
describe('NodeView positional reads (a missed field is a desync, not a gap)', () => {
  /**
   * A hand-built ONE-node packet whose node carries one port. Field order is the
   * Rust struct's, all eleven (phase 76 appended `label` after `load`):
   *   id, kind, cell_x, cell_y, state, w, h, rot, ports, load, label.
   */
  const oneNodePacket = (load: number) =>
    new Uint8Array([
      0x01, // tick = 1
      0x01, // full = true
      0x01, // placed len = 1
      0x05, // node id = 5
      0x02, // kind = FACTORY
      0x00, // cell_x = 0 (zigzag)
      0x00, // cell_y = 0 (zigzag)
      0x03, // state = BACKED_UP (the fourth byte)
      0x01, // w = 1
      0x01, // h = 1
      0x00, // rot = 0
      0x01, // ports len = 1
      0x00, //   port index = 0
      0x00, //   port cell_x = 0
      0x00, //   port cell_y = 0
      0x03, //   side = W
      0x00, //   role = In
      0x00, //   medium = Mechanical
      load, // load, appended after the ports vec
      0x00, // label = None, appended LAST after load (76-02)
      0x00, // removed len = 0
      0x00, // belts len = 0
      0x00, // can_undo = false
      0x00, // can_redo = false
      0x00, // wires len = 0
      0x00, // resync = false (73-12)
      0x00, // generation = 0 (phase 88, appended LAST)
      0x00, // swap_floor = 0 (phase 88 security, T-88-11, appended LAST)
    ]);

  it('decodes the SECOND and THIRD nodes of a multi-node packet exactly as authored', () => {
    // The 0008 golden's FIRST node carries a non-empty ports vec and is followed by
    // two more nodes. With `load` appended last and its read omitted, node 100's
    // stray trailing byte is fed into node 101's `id` varint and everything after
    // it diverges: the ids, the kinds and the ports below all move.
    //
    // PHASE 76 (plan 76-02): a FOURTH node, a LABEL carrying multibyte words, now sits
    // between 101 and 102, so node 102 is read only after a `Some` option, a
    // byte-length string and a colour byte were all consumed in step.
    const packet = decodeRenderPacket(goldenBytes);
    expect(packet.placed).toHaveLength(4);
    expect(packet.placed[0].ports.length).toBeGreaterThan(0);
    expect(packet.placed[0].label).toBeNull();

    expect(packet.placed[1].id).toBe(101);
    expect(packet.placed[1].kind).toBe(machine_kind.SINK);
    expect(packet.placed[1].ports).toEqual([]);
    expect(packet.placed[1].label).toBeNull();

    expect(packet.placed[2].id).toBe(103);
    expect(packet.placed[2].kind).toBe(machine_kind.LABEL);
    expect(packet.placed[2].label).toEqual({ text: 'Caf\u00e9 \u6ce8\u6587', colour: 3 });

    expect(packet.placed[3].id).toBe(102);
    expect(packet.placed[3].kind).toBe(machine_kind.SINK);
    expect(packet.placed[3].state).toBe(state_tag.BACKED_UP);
    expect(packet.placed[3].load).toBe(4);
    expect(packet.placed[3].label).toBeNull();
    expect(packet.placed[3].ports).toEqual([
      { index: 0, cell_x: 9, cell_y: 7, side: 3, role: 0, medium: 0 },
    ]);
  });

  it('consumes every byte of a ONE-node packet (the stray byte has nowhere to hide)', () => {
    // On a one-node packet a missed read leaves the byte merely TRAILING, and a
    // decoder that never checks its cursor ignores it. This is the case that makes
    // the proof independent of the fixture happening to carry several nodes.
    const bytes = oneNodePacket(0x00);
    const reader = new PostcardReader(bytes);
    const packet = decodeRenderPacketFrom(reader);
    // The cursor FIRST, so this assertion is the one that reddens on a missed read
    // rather than a payload check tripping ahead of it.
    expect(reader.remaining()).toBe(0);
    expect(packet.placed[0].id).toBe(5);
    expect(packet.placed[0].load).toBe(0);
  });

  it('reads a load byte outside 0..4 RAW, without throwing (open keyspace)', () => {
    // Same discipline `role`, `side` and `medium` already ride under: an unknown
    // byte decodes as itself and the clamp belongs at the draw call, never here.
    const reader = new PostcardReader(oneNodePacket(0xfa));
    const packet = decodeRenderPacketFrom(reader);
    expect(reader.remaining()).toBe(0);
    expect(packet.placed[0].load).toBe(0xfa);
  });
});

/**
 * PHASE 76 (plan 76-02, D-02): `NodeView.label`, appended LAST after `load`.
 *
 * A postcard `Option<LabelView>`: one tag byte, 0 for `None`, or 1 followed by the
 * `LabelView` struct (`text` as a byte-length-prefixed UTF-8 string, then `colour` as
 * one byte). `None` decodes to `null`, never `undefined`, because the 0008 golden's JSON
 * (serde) writes `null` and the deep-equal above reads it.
 *
 * The packet is hand-built from the postcard rules, TWO nodes, the label FIRST, so a
 * reader that skipped the option, or read the string length in characters rather than
 * bytes, feeds a stray byte into the second node's `id` and the cursor check fails. The
 * text is multibyte UTF-8 for exactly that reason.
 *
 * RED AT THE START REVISION: `readNodeView` stops at `load`, so the option
 * tag byte is read as the second node's `id` and the decode diverges.
 */
describe('NodeView.label: a label carries its text and colour, every other node null', () => {
  const text = 'Caf\u00e9 \u6ce8\u6587';
  const textBytes = [...new TextEncoder().encode(text)];
  const packet = new Uint8Array([
    0x01, // tick = 1
    0x01, // full = true
    0x02, // placed len = 2
    // node 1: a LABEL at (10,12), 4 by 1
    0x07, // id = 7
    machine_kind.LABEL, // kind = 11
    0x14, // cell_x = 10 (zigzag 20)
    0x18, // cell_y = 12 (zigzag 24)
    0x00, // state = IDLE
    0x04, // w = 4
    0x01, // h = 1
    0x00, // rot = 0
    0x00, // ports len = 0
    0x00, // load = 0
    0x01, // label = Some
    textBytes.length, // text byte length (12, one varint byte)
    ...textBytes, // text, UTF-8
    0x03, // colour = 3 (Lilac)
    // node 2: a SOURCE at (0,0)
    0x08, // id = 8
    machine_kind.SOURCE, // kind = 0
    0x00, // cell_x = 0
    0x00, // cell_y = 0
    0x00, // state = IDLE
    0x01, // w = 1
    0x01, // h = 1
    0x00, // rot = 0
    0x00, // ports len = 0
    0x00, // load = 0
    0x00, // label = None
    0x00, // removed len = 0
    0x00, // belts len = 0
    0x00, // can_undo = false
    0x00, // can_redo = false
    0x00, // wires len = 0
    0x00, // resync = false (73-12)
    0x00, // generation = 0 (phase 88, appended LAST)
    0x00, // swap_floor = 0 (phase 88 security, T-88-11, appended LAST)
  ]);

  it('decodes the label to { text, colour } and the other node to null, consuming every byte', () => {
    expect(textBytes.length, 'the multibyte text is 12 UTF-8 bytes in 8 characters').toBe(12);
    const reader = new PostcardReader(packet);
    const decoded = decodeRenderPacketFrom(reader);
    // The cursor FIRST: a missed or mis-sized read reddens here before a payload check.
    expect(reader.remaining()).toBe(0);
    expect(decoded.placed).toHaveLength(2);
    expect(decoded.placed[0].label).toEqual({ text, colour: 3 });
    expect(decoded.placed[1].id).toBe(8);
    expect(decoded.placed[1].label).toBeNull();
  });
});

describe('PostcardReader bounds-safety (T-07-DECODE-OOB)', () => {
  it('throws a typed DecodeError on a truncated buffer (never reads past the end)', () => {
    const truncated = goldenBytes.slice(0, 5);
    expect(() => decodeRenderPacket(truncated)).toThrow(DecodeError);
  });

  it('throws DecodeError when a varint runs off the end', () => {
    // 0x80 sets the continuation bit but there is no following byte.
    const reader = new PostcardReader(new Uint8Array([0x80]));
    expect(() => reader.varintU()).toThrow(DecodeError);
  });

  it('throws DecodeError when u8 reads past the end', () => {
    const reader = new PostcardReader(new Uint8Array([]));
    expect(() => reader.u8()).toThrow(DecodeError);
  });
});

describe('readTileView discriminant + bounds safety (T-14-TILE-DISC / T-14-DECODE-OOB)', () => {
  // readTileView is module-private; exercise it through decodeRenderPacket by
  // building a minimal packet whose single belt carries one forged tile.
  // Prefix grammar (new 16-03 BeltView field order, source/dest cells removed):
  // tick, full, placed-len(0), removed-len(0), belts-len(1), then the BeltView
  // { id, latency, fill, items-len, tiles-len, <tiles...>, docks-len }.
  const beltPrefix = [
    0x01, // tick = 1
    0x01, // full = true
    0x00, // placed len = 0
    0x00, // removed len = 0
    0x01, // belts len = 1
    0x01, // belt id = 1
    0x01, // latency = 1
    0x00, // fill = 0
    0x00, // items len = 0
    0x01, // tiles len = 1
    0x00, // tile cell_x = 0
    0x00, // tile cell_y = 0
  ];

  it('throws DecodeError on a forged TileKind discriminant (disc 2)', () => {
    // ...followed by disc = 2 (neither Straight=0 nor Corner=1).
    const forged = new Uint8Array([...beltPrefix, 0x02]);
    expect(() => decodeRenderPacket(forged)).toThrow(DecodeError);
  });

  it('decodes a valid Straight tile (disc 0) without throwing', () => {
    // disc 0, axis 0, then docks-len = 0 (belt has no docks) and ticks_per_slot = 0, then
    // the two MANDATORY trailing availability bools (can_undo=0, can_redo=0), then the
    // tail every packet carries: wires-len = 0, resync = false, generation = 0 (read
    // strictly since plan 88-03) and swap_floor = 0 (phase 88 security, T-88-11).
    const ok = new Uint8Array([...beltPrefix, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const packet = decodeRenderPacket(ok);
    expect(packet.belts[0].tiles).toEqual([
      { cell_x: 0, cell_y: 0, kind: { Straight: { axis: 0 } } },
    ]);
    expect(packet.belts[0].docks).toEqual([]);
    expect(packet.can_undo).toBe(false);
    expect(packet.can_redo).toBe(false);
  });

  it('throws DecodeError on a truncated tiles buffer (underrun, not a partial read)', () => {
    // disc 1 = Corner needs two more bytes (from, to); supply only `from`.
    const truncated = new Uint8Array([...beltPrefix, 0x01, 0x01]);
    expect(() => decodeRenderPacket(truncated)).toThrow(DecodeError);
  });
});

describe('readPortView / readBeltDockView safety (T-16-DECODE-OOB / T-16-DOCK-DISC)', () => {
  it('throws a typed DecodeError on a truncated 0008 buffer (ports/docks underrun)', () => {
    // Cut the golden deep in the MANDATORY placed[]/ports region (30 bytes into a
    // 90+ byte packet): the ports[]/docks[] reads run off the end and must throw on
    // underrun rather than reading past the buffer. NB: the trailing `wires` tail is
    // the tolerant/total field (covered separately below) — truncating THERE
    // degrades gracefully, so this test deliberately cuts a MANDATORY prefix field.
    const truncated = goldenBytes.slice(0, 30);
    expect(() => decodeRenderPacket(truncated)).toThrow(DecodeError);
  });

  it('throws DecodeError on a forged BeltEnd discriminant (fail-closed, disc 2)', () => {
    // A minimal packet: one belt with no tiles and one dock whose BeltEnd
    // discriminant is 2 (neither Head=0 nor Tail=1) — readBeltDockView rejects it.
    const forgedDock = new Uint8Array([
      0x01, // tick = 1
      0x01, // full = true
      0x00, // placed len = 0
      0x00, // removed len = 0
      0x01, // belts len = 1
      0x01, // belt id = 1
      0x01, // latency = 1
      0x00, // fill = 0
      0x00, // items len = 0
      0x00, // tiles len = 0
      0x01, // docks len = 1
      0x02, // forged BeltEnd discriminant (out of range)
    ]);
    expect(() => decodeRenderPacket(forgedDock)).toThrow(DecodeError);
  });

  it('throws DecodeError on a truncated dock (BeltEnd ok, node/port underrun)', () => {
    // A valid Head disc (0) but the node/port varints run off the end.
    const truncatedDock = new Uint8Array([
      0x01, 0x01, 0x00, 0x00, 0x01, // tick, full, placed0, removed0, belts1
      0x01, 0x01, 0x00, 0x00, 0x00, // id, latency, fill, items0, tiles0
      0x01, // docks len = 1
      0x00, // BeltEnd = Head (valid) — but no node/port follow
    ]);
    expect(() => decodeRenderPacket(truncatedDock)).toThrow(DecodeError);
  });
});

describe('readWireView — WUI-01 wires tail (append-LAST, total decode)', () => {
  it('decodes the 0008 wires tail into WireView objects (endpoints, path, pulses)', () => {
    const packet = decodeRenderPacket(goldenBytes);
    // The re-frozen 0008 golden carries exactly one WireView (the whole-object
    // deep-equal above already pins it; here we assert the wire-specific shape).
    expect(packet.wires).toHaveLength(1);
    const w = packet.wires[0];
    // Endpoint docks resolve to (node, port) handles (FORK B, like belt docks).
    expect(w.from).toEqual({ node: 100, port: 1 });
    expect(w.to).toEqual({ node: 101, port: 0 });
    // The route()-normalized path carries the Straight + Corner tile coverage.
    expect(w.path).toEqual([
      { cell_x: 0, cell_y: 0, kind: { Straight: { axis: 0 } } },
      { cell_x: 1, cell_y: 0, kind: { Corner: { from: 1, to: 2 } } },
    ]);
    // One in-flight pulse carrying entry_tick/hop_ticks + the host-derived REPLY
    // direction byte (1) — the reply-home read.
    expect(w.pulses).toEqual([{ entry_tick: 6, hop_ticks: 1, direction: 1 }]);
  });

  it('surfaces decoded wires onto the scene wires map (keyed by handle)', () => {
    const scene = createSceneState();
    applyPacket(scene, decodeRenderPacket(goldenBytes));
    expect(scene.wires.size).toBe(1);
    expect(scene.wires.get(300)?.pulses[0].direction).toBe(1);
  });

  it('decodes an empty wires tail to an empty scene wires map (no throw)', () => {
    // A minimal keyframe with NO wires: the trailing wires-len = 0 decodes to [].
    const emptyWires = new Uint8Array([
      0x01, // tick = 1
      0x01, // full = true
      0x00, // placed len = 0
      0x00, // removed len = 0
      0x00, // belts len = 0
      0x00, // can_undo = false
      0x00, // can_redo = false
      0x00, // wires len = 0 (WUI-01 empty tail)
      0x00, // resync = false (73-12)
      0x00, // generation = 0 (phase 88, appended LAST)
      0x00, // swap_floor = 0 (phase 88 security, T-88-11, appended LAST)
    ]);
    const packet = decodeRenderPacket(emptyWires);
    expect(packet.wires).toEqual([]);
    const scene = createSceneState();
    applyPacket(scene, packet);
    expect(scene.wires.size).toBe(0);
  });

  it('THROWS on a short/truncated wires tail (the tail is strict since plan 88-03)', () => {
    // MOVED BY PLAN 88-03 (D-02, D-05). This case used to pin the opposite: a wires tail
    // cut short degraded to an empty wires array and the packet decoded. The tail now
    // carries the board generation after `resync`, and a packet that degraded instead of
    // failing would hand the client a generation of 0, addressing every handle it sends
    // against the wrong table. A cut tail is a truncated packet, a DecodeError like any
    // other underrun (T-40-02-DEC still holds: a typed throw, never a hang).
    const shortWiresTail = goldenBytes.slice(0, goldenBytes.length - 4);
    expect(() => decodeRenderPacket(shortWiresTail)).toThrow(DecodeError);
  });

  // ── 73-12 (73-REVIEW WR-01): the `resync` bit, appended AFTER `wires` ──────────
  it('reads the appended resync bit off a lag-resync keyframe', () => {
    // The same minimal keyframe as above with the trailing resync byte set. This is
    // the frame both transports now send on `RecvError::Lagged`, and the ONE thing
    // that distinguishes it from a restructure keyframe.
    const resyncKeyframe = new Uint8Array([
      0x01, // tick = 1
      0x01, // full = true
      0x00, // placed len = 0
      0x00, // removed len = 0
      0x00, // belts len = 0
      0x00, // can_undo = false
      0x00, // can_redo = false
      0x00, // wires len = 0
      0x01, // resync = true (73-12)
      0x00, // generation = 0 (phase 88, appended LAST)
      0x00, // swap_floor = 0 (phase 88 security, T-88-11, appended LAST)
    ]);
    expect(decodeRenderPacket(resyncKeyframe).resync).toBe(true);
  });

  it('THROWS on an ABSENT resync byte, and on a resync byte with no generation after it', () => {
    // MOVED BY PLAN 88-03 (D-02, D-05). This case used to pin a degrade: a frame ending
    // after `wires` read `resync: false`, so an older host stayed readable. Since phase 88
    // both ends ship from one revision and the decoder is the clean break: a host and a
    // page from different revisions fail to decode rather than edit the wrong machine.
    const noResyncByte = new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => decodeRenderPacket(noResyncByte)).toThrow(DecodeError);
    const noGeneration = new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => decodeRenderPacket(noGeneration)).toThrow(DecodeError);
  });

  it('reads the generation off a hand-built packet, multi-byte varint included', () => {
    // Phase 88 (D-02): 300 is two LEB128 bytes (0xAC 0x02), so a reader that took one
    // byte as a u8 would leave one behind and read 44.
    const reader = new PostcardReader(
      new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xac, 0x02, 0x00]),
    );
    expect(decodeRenderPacketFrom(reader).generation).toBe(300);
    expect(reader.remaining()).toBe(0);
  });

  it('reads the swap floor after the generation, and THROWS on a generation with no floor after it (phase 88 security, T-88-11)', () => {
    // Generation 300 (0xAC 0x02), then swap floor 200 (0xC8 0x01): two two-byte varints, so a
    // reader that took either as a u8 would misread the other.
    const reader = new PostcardReader(
      new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xac, 0x02, 0xc8, 0x01]),
    );
    const pkt = decodeRenderPacketFrom(reader);
    expect([pkt.generation, pkt.swap_floor]).toEqual([300, 200]);
    expect(reader.remaining()).toBe(0);
    // Read STRICTLY: a packet that ends after its generation is a packet from an older host.
    const noFloor = new Uint8Array([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(() => decodeRenderPacket(noFloor)).toThrow(DecodeError);
  });

  it('the 0008 golden decodes resync FALSE, so the bit is not stuck on', () => {
    // The DECLARED NEGATIVE CONTROL. Without it, `resync: true` above is satisfied by
    // a reader that returns true unconditionally.
    expect(decodeRenderPacket(goldenBytes).resync).toBe(false);
  });
});

describe('encodeGestureFrame - the gesture header (phase 88, D-02, D-06; version byte T-88-09)', () => {
  it('writes the version byte, generation, gesture id, then the body untouched: the bytes the Rust test decodes', () => {
    // `fabrico_host::transport_ws::tests::decode_gesture_reads_the_header_before_the_body`
    // decodes exactly `[0xF1, 3, 41, <Place body>]` to generation 3, gesture 41 and the Place.
    const body = encodeGridCommand({ kind: 'Place', kind_byte: 0, cell_x: 1, cell_y: 2 });
    expect([...body], 'the Place body (0, kind 0, zigzag 1, zigzag 2)').toEqual([0, 0, 2, 4]);
    expect([...encodeGestureFrame(3, 41, body)]).toEqual([0xf1, 3, 41, 0, 0, 2, 4]);
  });

  it('starts every frame with a version byte no pre-88 bare body starts with (T-88-09)', () => {
    // A pre-88 page sent a bare GridCommand (lead 0 to 11) or a run-pace frame (lead 0xFE).
    // A bare Dock{belt 9, Tail, node 5, port 0} is [4, 9, 1, 5, 0]; without the version byte
    // the host read it as generation 4, gesture 9, Delete{node 5}.
    expect(GESTURE_FRAME_VERSION).toBe(0xf1);
    expect(GESTURE_FRAME_VERSION).toBeGreaterThan(11);
    expect(GESTURE_FRAME_VERSION).not.toBe(BELT_RUN_PACE_LEAD);
    const dock = encodeGridCommand({ kind: 'Dock', belt: 9, end: 'Tail', node: 5, port: 0 });
    expect([...dock], 'the bare Dock a pre-88 page sent').toEqual([4, 9, 1, 5, 0]);
    expect([...encodeGestureFrame(4, 9, dock)]).toEqual([0xf1, 4, 9, 4, 9, 1, 5, 0]);
    expect(encodeGestureFrame(0, 1, encodeBeltRunPace([9], 4))[0]).toBe(GESTURE_FRAME_VERSION);
  });

  it('writes multi-byte LEB128 for both fields, matching the Rust writer', () => {
    // `frame_gesture(300, 70_000, ..)` on the Rust side starts 0xF1 0xAC 0x02 0xF0 0xA2 0x04.
    const framed = encodeGestureFrame(300, 70_000, new Uint8Array([9]));
    expect([...framed]).toEqual([0xf1, 0xac, 0x02, 0xf0, 0xa2, 0x04, 9]);
    const r = new PostcardReader(framed);
    expect([r.u8(), r.varintU(), r.varintU(), r.u8()]).toEqual([0xf1, 300, 70_000, 9]);
    expect(r.remaining()).toBe(0);
  });

  it('leaves a run-pace body exactly as encodeBeltRunPace wrote it, its lead a raw byte', () => {
    const run = encodeBeltRunPace([9], 4);
    expect([...encodeGestureFrame(1, 2, run)]).toEqual([0xf1, 1, 2, BELT_RUN_PACE_LEAD, 1, 9, 4]);
  });

  it('refuses a negative or unsafe field rather than writing bytes that read as another number', () => {
    const body = new Uint8Array([5]);
    expect(() => encodeGestureFrame(-1, 1, body)).toThrow(RangeError);
    expect(() => encodeGestureFrame(0, 1.5, body)).toThrow(RangeError);
    expect(() => encodeGestureFrame(Number.MAX_SAFE_INTEGER + 1, 1, body)).toThrow(RangeError);
  });
});

describe('PostcardReader primitives', () => {
  it('decodes a multi-byte LEB128 unsigned varint (1024 = 0x80 0x08)', () => {
    expect(new PostcardReader(new Uint8Array([0x80, 0x08])).varintU()).toBe(1024);
  });

  it('zigzag-decodes signed i32 varints (5 = 0x0a, -1 = 0x01)', () => {
    expect(new PostcardReader(new Uint8Array([0x0a])).varintI()).toBe(5);
    expect(new PostcardReader(new Uint8Array([0x01])).varintI()).toBe(-1);
    expect(new PostcardReader(new Uint8Array([0x00])).varintI()).toBe(0);
  });
});

describe('encodeGridCommand — render -> sim gesture (08-06 path)', () => {
  it('Place round-trips through the decoder grammar', () => {
    const bytes = encodeGridCommand({ kind: 'Place', kind_byte: 2, cell_x: 5, cell_y: -3 });
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(0); // discriminant: Place
    expect(r.u8()).toBe(2); // kind
    expect(r.varintI()).toBe(5); // cell_x
    expect(r.varintI()).toBe(-3); // cell_y
    expect(r.remaining()).toBe(0);
  });

  // The node->node `Wire` variant (formerly disc 1) was removed in Phase 17-02;
  // belts come only from the DrawBelt tool + Dock, and the remaining discriminants
  // shifted DOWN one (Delete 2->1, Rotate 3->2, DrawBelt 4->3).

  it('Delete encodes discriminant 1 with the node handle', () => {
    const bytes = encodeGridCommand({ kind: 'Delete', node: 101 });
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(1); // discriminant: Delete (17-02 renumber)
    expect(r.varintU()).toBe(101);
    expect(r.remaining()).toBe(0);
  });

  it('Rotate encodes discriminant 2 with the node handle + ccw bool', () => {
    const bytes = encodeGridCommand({ kind: 'Rotate', node: 400, ccw: true });
    expect(bytes[0]).toBe(2); // first byte: Rotate discriminant (17-02 renumber)
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(2);
    expect(r.varintU()).toBe(400);
    expect(r.bool()).toBe(true);
    expect(r.remaining()).toBe(0);
  });

  it('DrawBelt encodes discriminant 3 with a length-prefixed integer cell path', () => {
    const bytes = encodeGridCommand({ kind: 'DrawBelt', cells: [[0, 0], [1, 0], [1, 1]] });
    expect(bytes[0]).toBe(3); // first byte: DrawBelt discriminant (17-02 renumber)
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(3);
    expect(r.varintU()).toBe(3); // cells length
    expect([r.varintI(), r.varintI()]).toEqual([0, 0]);
    expect([r.varintI(), r.varintI()]).toEqual([1, 0]);
    expect([r.varintI(), r.varintI()]).toEqual([1, 1]);
    expect(r.remaining()).toBe(0);
  });

  // Fieldless Undo/Redo variants (19-05): discriminants 5/6 per the post-17-02
  // GridCommand order (Place0 Delete1 Rotate2 DrawBelt3 Dock4 Undo5 Redo6). The
  // encoder is dumb — it emits a single discriminant byte and NO payload.
  it('Undo encodes as exactly one byte: discriminant 5 (fieldless)', () => {
    const bytes = encodeGridCommand({ kind: 'Undo' });
    expect(Array.from(bytes)).toEqual([5]);
  });

  it('Redo encodes as exactly one byte: discriminant 6 (fieldless)', () => {
    const bytes = encodeGridCommand({ kind: 'Redo' });
    expect(Array.from(bytes)).toEqual([6]);
  });

  it('leaves the existing command encodings unchanged (byte parity regression)', () => {
    expect(Array.from(encodeGridCommand({ kind: 'Place', kind_byte: 2, cell_x: 5, cell_y: -3 })))
      .toEqual([0, 2, 10, 5]); // disc0, kind2, zigzag(5)=10, zigzag(-3)=5
    expect(Array.from(encodeGridCommand({ kind: 'Delete', node: 101 }))).toEqual([1, 101]);
    expect(Array.from(encodeGridCommand({ kind: 'Rotate', node: 400, ccw: true })))
      .toEqual([2, 0x90, 0x03, 1]); // disc2, varint(400)=0x90 0x03, ccw=1
  });

  // AddPort/RemovePort (Phase 36, PORT-06/07): appended LAST after Redo=6, so the
  // discriminants are 7/8 and NO prior variant's bytes move. These byte literals
  // pin the TS encoder to the frozen Rust GridCommand::AddPort/RemovePort postcard
  // layout (T-36-10 tampering guard) — the exact field order from
  // crates/fabrico-protocol/src/lib.rs: AddPort { node, role, side, medium },
  // RemovePort { node, index }.
  it('AddPort encodes discriminant 7 with node varint then role/side/medium u8 bytes', () => {
    const bytes = encodeGridCommand({ kind: 'AddPort', node: 300, role: 1, side: 1, medium: 1 });
    // disc7, varint(300)=0xAC 0x02, role=1 (Out), side=1 (E), medium=1 (Electrical)
    expect(Array.from(bytes)).toEqual([7, 0xac, 0x02, 1, 1, 1]);
    // and it round-trips through the reader grammar in declaration order.
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(7); // discriminant: AddPort (appended LAST)
    expect(r.varintU()).toBe(300); // node (dense u64 handle)
    expect(r.u8()).toBe(1); // role: Out
    expect(r.u8()).toBe(1); // side: E
    expect(r.u8()).toBe(1); // medium: Electrical (the first design-time wire port)
    expect(r.remaining()).toBe(0);
  });

  it('AddPort mechanical (medium=0) round-trips — the Router preset seeding byte', () => {
    const bytes = encodeGridCommand({ kind: 'AddPort', node: 5, role: 0, side: 3, medium: 0 });
    expect(Array.from(bytes)).toEqual([7, 5, 0, 3, 0]); // disc7, node5, In, W, Mechanical
  });

  it('RemovePort encodes discriminant 8 with node varint then index varint', () => {
    const bytes = encodeGridCommand({ kind: 'RemovePort', node: 300, index: 2 });
    expect(Array.from(bytes)).toEqual([8, 0xac, 0x02, 2]); // disc8, varint(300), index2
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(8); // discriminant: RemovePort (appended LAST)
    expect(r.varintU()).toBe(300); // node
    expect(r.varintU()).toBe(2); // index (u16 rides as varint, like Dock's port)
    expect(r.remaining()).toBe(0);
  });

  // DrawWire/Unlink (Phase 63, WIRE-01/WIRE-02 and CONNECT-01): appended LAST after
  // Configure=9, so the discriminants are 10/11 and NO prior variant's bytes move.
  // Both landed while fabrico-protocol was still open — the crate freezes at the end
  // of Phase 63, and Phases 66/67 need these two shapes on the command wire.
  it('DrawWire encodes discriminant 10 with four varints in Rust field order', () => {
    const bytes = encodeGridCommand({
      kind: 'DrawWire',
      from_node: 300,
      from_port: 1,
      to_node: 7,
      to_port: 0,
    });
    // disc10, varint(300)=0xAC 0x02, from_port 1, to_node 7, to_port 0
    expect(Array.from(bytes)).toEqual([10, 0xac, 0x02, 1, 7, 0]);
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(10); // discriminant: DrawWire
    expect(r.varintU()).toBe(300); // from_node (dense u64 handle)
    expect(r.varintU()).toBe(1); // from_port: a declared Role::Out Electrical port
    expect(r.varintU()).toBe(7); // to_node
    expect(r.varintU()).toBe(0); // to_port: a declared Role::In Electrical port
    expect(r.remaining()).toBe(0);
  });

  it('Unlink encodes discriminant 11 with the Dock field set (belt, end, node, port)', () => {
    const bytes = encodeGridCommand({ kind: 'Unlink', belt: 12, end: 'Tail', node: 300, port: 1 });
    // disc11, belt12, BeltEnd Tail=1, varint(300)=0xAC 0x02, port 1 (CATALOG index)
    expect(Array.from(bytes)).toEqual([11, 12, 1, 0xac, 0x02, 1]);
    const r = new PostcardReader(bytes);
    expect(r.varintU()).toBe(11); // discriminant: Unlink
    expect(r.varintU()).toBe(12); // belt (dense u64 handle)
    expect(r.varintU()).toBe(1); // endpoint: Tail (BeltEnd Head=0, Tail=1)
    expect(r.varintU()).toBe(300); // node
    expect(r.varintU()).toBe(1); // port: the SPATIAL catalog index, verbatim
    expect(r.remaining()).toBe(0);
    // Head=0, the other direction of the same field set.
    expect(
      Array.from(encodeGridCommand({ kind: 'Unlink', belt: 12, end: 'Head', node: 5, port: 0 })),
    ).toEqual([11, 12, 0, 5, 0]);
  });
});

// ---------------------------------------------------------------------------
// Cross-language byte-parity: encodeGridCommand(Configure) vs the Rust-frozen
// configure-gridcommand.bin (39-03). This is the TOP cross-language drift risk
// (T-39-BYTE-DRIFT): the TS MachineConfig encoder MUST reproduce the exact
// postcard bytes the Rust GridCommand::Configure producer froze, for EVERY
// nested variant (Factory / Source Timer+Webhook / Sink Http+Debug, with a
// non-default HttpMethod::Patch). The fixture is a postcard `Vec<GridCommand>`:
// varintU(len) then each element concatenated — so we prefix varintU(len) and
// concat the encoded commands. Phase 85 (plan 85-05) deleted the Sink/Email entry
// with the Email target; Http moved from SinkTemplate discriminant 2 to 1.
//
// NOTE: this vitest golden is NECESSARY-NOT-SUFFICIENT (the v5.0 live-oracle
// lesson): the same encoder is re-exercised LIVE in the 39-08 e2e:live
// config-apply, which catches live-oracle breakage vitest+tsc miss.
// ---------------------------------------------------------------------------

// The Rust HttpMethod discriminant order (state.rs :752), keyed by the serde
// variant NAME the fixture .expected.json carries -> the u8 the wire encodes.
const HTTP_METHOD: Record<string, number> = {
  Get: 0,
  Post: 1,
  Put: 2,
  Patch: 3,
  Delete: 4,
};

// serde externally-tagged JSON shapes the Rust fixture serializes.
type SerdeTrigger = 'Webhook' | { Timer: { interval_ticks: number } };
type SerdeTarget =
  | 'Debug'
  | { Http: { url: string; method: string } };
// RouteKey is a serde STRUCT (named fields), so it serializes as an object.
type SerdeRouteKey = { offset: number; expect: number[] };
type SerdeConfig =
  | { Factory: { source: string } }
  | { Source: { trigger: SerdeTrigger } }
  | { Sink: { target: SerdeTarget } }
  | { Belt: { ticks_per_slot: number } }
  | { Router: { routes: [SerdeRouteKey, number][]; default: number | null } };
type SerdeConfigureCmd = { Configure: { node: number; config: SerdeConfig } };

/** Translate one serde-JSON Configure command into the TS GridCommand shape. */
function serdeToConfigure(cmd: SerdeConfigureCmd): GridCommand {
  const { node, config } = cmd.Configure;
  let machineConfig: MachineConfig;
  if ('Factory' in config) {
    machineConfig = { kind: 'Factory', source: config.Factory.source };
  } else if ('Source' in config) {
    const t = config.Source.trigger;
    const trigger: SourceTrigger =
      t === 'Webhook'
        ? { kind: 'Webhook' }
        : { kind: 'Timer', interval_ticks: t.Timer.interval_ticks };
    machineConfig = { kind: 'Source', trigger };
  } else if ('Belt' in config) {
    machineConfig = { kind: 'Belt', ticks_per_slot: config.Belt.ticks_per_slot };
  } else if ('Router' in config) {
    machineConfig = {
      kind: 'Router',
      routes: config.Router.routes.map(([key, port]) => [
        { offset: key.offset, expect: key.expect },
        port,
      ]),
      default: config.Router.default,
    };
  } else {
    const tgt = config.Sink.target;
    let target: SinkTemplate;
    if (tgt === 'Debug') {
      target = { kind: 'Debug' };
    } else {
      target = { kind: 'Http', url: tgt.Http.url, method: HTTP_METHOD[tgt.Http.method] };
    }
    machineConfig = { kind: 'Sink', target };
  }
  return { kind: 'Configure', node, config: machineConfig };
}

describe('encodeGridCommand — Configure cross-language byte parity (39-05, T-39-BYTE-DRIFT)', () => {
  const configureBin = new Uint8Array(readFileSync(fixtureUrl('configure-gridcommand.bin')));
  const configureExpected: SerdeConfigureCmd[] = JSON.parse(
    readFileSync(fixtureUrl('configure-gridcommand.expected.json'), 'utf8'),
  );

  it('reproduces the Rust-frozen configure-gridcommand.bin byte-for-byte (every nested variant)', () => {
    // The fixture is a postcard Vec<GridCommand>: varintU(len) then each element.
    const w = new PostcardWriter();
    w.varintU(configureExpected.length); // 7 since 85-05 (8 from 63-05); one byte
    const prefix = Array.from(w.finish());
    const body = configureExpected.flatMap((c) =>
      Array.from(encodeGridCommand(serdeToConfigure(c))),
    );
    expect([...prefix, ...body]).toEqual(Array.from(configureBin));
  });

  // Per-variant hard-coded byte tripwires (mirror the AddPort literal-bytes
  // style): pinpoint a regression even if the fixture is regenerated. These
  // encode a SINGLE GridCommand (no Vec prefix) so they isolate the arm.
  it('Factory: disc9 + node + MachineConfig::Factory(0) + str(source), no code_hash', () => {
    const bytes = encodeGridCommand({
      kind: 'Configure',
      node: 1,
      config: { kind: 'Factory', source: 'hi' },
    });
    // disc9, node1, Factory=0, str "hi" = len2 + 0x68 0x69
    expect(Array.from(bytes)).toEqual([9, 1, 0, 2, 0x68, 0x69]);
  });

  it('Source/Timer: disc9 + node + Source(1) + Timer(1) + varintU(interval_ticks)', () => {
    const bytes = encodeGridCommand({
      kind: 'Configure',
      node: 7,
      config: { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 60 } },
    });
    // disc9, node7, Source=1, Timer=1, interval 60
    expect(Array.from(bytes)).toEqual([9, 7, 1, 1, 60]);
    // Source/Webhook: Source(1) + Webhook(0) with NO trailing field.
    expect(
      Array.from(
        encodeGridCommand({
          kind: 'Configure',
          node: 9,
          config: { kind: 'Source', trigger: { kind: 'Webhook' } },
        }),
      ),
    ).toEqual([9, 9, 1, 0]);
  });

  it('Sink/Http: disc9 + node + Sink(2) + Http(1) + str(url) + u8(method)', () => {
    const bytes = encodeGridCommand({
      kind: 'Configure',
      node: 3,
      config: { kind: 'Sink', target: { kind: 'Http', url: 'a', method: HTTP_METHOD.Patch } },
    });
    // disc9, node3, Sink=2, Http=1 (2 until Phase 85 deleted Email), str "a" = len1 +
    // 0x61, method Patch=3
    expect(Array.from(bytes)).toEqual([9, 3, 2, 1, 1, 0x61, 3]);
    // Sink/Debug: Sink(2) + Debug(0), no field.
    expect(
      Array.from(
        encodeGridCommand({ kind: 'Configure', node: 6, config: { kind: 'Sink', target: { kind: 'Debug' } } }),
      ),
    ).toEqual([9, 6, 2, 0]);
  });

  // Phase 63-05: the two nested config variants appended in 63-04. Named cases so a
  // failure says WHICH arm drifted, rather than only reporting a byte mismatch
  // somewhere inside the fixture blob.
  it('Belt: disc9 + node + MachineConfig::Belt(3) + varintU(ticks_per_slot)', () => {
    const bytes = encodeGridCommand({
      kind: 'Configure',
      node: 11,
      config: { kind: 'Belt', ticks_per_slot: 12 },
    });
    // disc9, node11, Belt=3, ticks 12. postcard encodes the core's NonZeroU32
    // exactly as its inner u32, so the wire's plain integer is byte-compatible.
    expect(Array.from(bytes)).toEqual([9, 11, 3, 12]);
  });

  it('Router: disc9 + node + MachineConfig::Router(4) + vec(routes) + Option(default)', () => {
    const bytes = encodeGridCommand({
      kind: 'Configure',
      node: 13,
      config: {
        kind: 'Router',
        routes: [
          [{ offset: 0, expect: [0x7b] }, 1],
          [{ offset: 4, expect: [0xde, 0xad, 0xbe, 0xef] }, 2],
        ],
        default: 0,
      },
    });
    // disc9, node13, Router=4,
    //   routes len 2,
    //     rule 1: offset 0, expect len 1 + 0x7b, port 1
    //     rule 2: offset 4, expect len 4 + de ad be ef, port 2
    //   default Some(1) + 0
    expect(Array.from(bytes)).toEqual([
      9, 13, 4, 2, 0, 1, 0x7b, 1, 4, 4, 0xde, 0xad, 0xbe, 0xef, 2, 1, 0,
    ]);
    // The empty/None case: an empty table is a bare zero length, and a None default
    // is the single 0 tag with NO following value.
    expect(
      Array.from(
        encodeGridCommand({
          kind: 'Configure',
          node: 2,
          config: { kind: 'Router', routes: [], default: null },
        }),
      ),
    ).toEqual([9, 2, 4, 0, 0]);
  });

  it('Label: disc9 + node + MachineConfig::Label(6) + str(text) + u8(colour) + varintU(w) + varintU(h)', () => {
    // Phase 76 (plan 76-02). Written out BY HAND from the postcard rules, not read back
    // from the encoder: a String is varint(byte length) then UTF-8, the colour is one
    // byte, and the two u16 sizes are varints (16 and 8 each fit one byte).
    const bytes = encodeGridCommand({
      kind: 'Configure',
      node: 300,
      config: { kind: 'Label', text: 'Hi \u00e9', colour: 5, w: 16, h: 8 },
    });
    expect([...bytes]).toEqual([
      0x09, // GridCommand::Configure
      0xac, 0x02, // node = 300 (LEB128)
      0x06, // MachineConfig::Label
      0x05, // text byte length: 'H' 'i' ' ' + two bytes for e-acute
      0x48, 0x69, 0x20, 0xc3, 0xa9, // 'Hi ' then U+00E9 as UTF-8
      0x05, // colour = Clay
      0x10, // w = 16
      0x08, // h = 8
    ]);
  });

  it('PostcardWriter.str prefixes the UTF-8 BYTE length, not the char length (T-39-STR-LEN)', () => {
    // "é" is one JS char but TWO UTF-8 bytes (0xC3 0xA9) — the prefix must be 2.
    const w = new PostcardWriter();
    w.str('é');
    expect(Array.from(w.finish())).toEqual([2, 0xc3, 0xa9]);
    // ASCII: byte length == char length.
    const w2 = new PostcardWriter();
    w2.str('hi');
    expect(Array.from(w2.finish())).toEqual([2, 0x68, 0x69]);
  });

  // Phase 91 review CR-B-01, T-91-24, UF-91-02: the writer refuses a value it cannot encode
  // exactly. `Infinity` used to loop forever (`Infinity / 128` is `Infinity`), and a finite value
  // past 2^53 or a negative or fractional one encoded bytes the host reads as a different number.
  // Every case here is finite or a constant, so a regressed writer fails these fast; none of them
  // calls `varintU(Infinity)`, which on a regressed writer would hang the suite.
  it('PostcardWriter.varintU throws on a value that is not a safe non-negative integer (CR-B-01)', () => {
    for (const v of [2 ** 53, 2 ** 64, 1e21, -1, 1.5, Number.NaN]) {
      expect(() => new PostcardWriter().varintU(v), `varintU(${v})`).toThrow(RangeError);
    }
    // The largest safe integer still encodes, and decodes back to itself.
    const w = new PostcardWriter();
    w.varintU(Number.MAX_SAFE_INTEGER);
    expect(new PostcardReader(w.finish()).varintU()).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('RenderPacket can_undo/can_redo availability (UNDO-06, 19-05)', () => {
  // A minimal packet: no nodes, no belts, then the two trailing availability
  // bools appended AFTER belts (exact Rust RenderPacket field order). The wire
  // grammar is: tick, full, placed-len, removed-len, belts-len, can_undo, can_redo.
  const emptyPacket = (canUndo: number, canRedo: number, full = 0) =>
    new Uint8Array([
      0x01, // tick = 1
      full, // full
      0x00, // placed len = 0
      0x00, // removed len = 0
      0x00, // belts len = 0
      canUndo, // can_undo
      canRedo, // can_redo
      0x00, // wires len = 0 (WUI-01 empty wires tail)
      0x00, // resync = false (73-12)
      0x00, // generation = 0 (phase 88, appended LAST)
      0x00, // swap_floor = 0 (phase 88 security, T-88-11, appended LAST)
    ]);

  it('decodes trailing (1,0) as can_undo=true, can_redo=false (field order after belts)', () => {
    const packet = decodeRenderPacket(emptyPacket(1, 0));
    expect(packet.can_undo).toBe(true);
    expect(packet.can_redo).toBe(false);
  });

  it('decodes trailing (0,1) as can_undo=false, can_redo=true', () => {
    const packet = decodeRenderPacket(emptyPacket(0, 1));
    expect(packet.can_undo).toBe(false);
    expect(packet.can_redo).toBe(true);
  });

  it('surfaces canUndo/canRedo onto the scene state for the App to poll', () => {
    const scene = createSceneState();
    applyPacket(scene, decodeRenderPacket(emptyPacket(1, 0)));
    expect(scene.canUndo).toBe(true);
    expect(scene.canRedo).toBe(false);
    // A later packet flips availability (rides diffs, not only keyframes).
    applyPacket(scene, decodeRenderPacket(emptyPacket(0, 1)));
    expect(scene.canUndo).toBe(false);
    expect(scene.canRedo).toBe(true);
  });

  it('preserves the full:true clear+rebuild path while carrying availability', () => {
    const scene = createSceneState();
    // Seed a stale node via a diff, then a full keyframe must clear it.
    scene.nodes.set(999, {
      id: 999, kind: 0, cell_x: 0, cell_y: 0, state: 0, w: 1, h: 1, rot: 0, ports: [], load: 0,
    });
    applyPacket(scene, decodeRenderPacket(emptyPacket(1, 1, /* full */ 1)));
    expect(scene.nodes.size).toBe(0); // keyframe cleared the stale node
    expect(scene.canUndo).toBe(true);
    expect(scene.canRedo).toBe(true);
  });
});

describe('encodeGridCommand — gridcommand golden parity (cross-language, 14-02)', () => {
  // The frozen `.bin` is `postcard::to_allocvec(&Vec<GridCommand>)` — a Vec, so
  // it carries a leading varint length prefix before the concatenated command
  // encodings. We reconstruct the same fixture literal the Rust
  // `fixture_commands()` froze, encode each branch, prepend the Vec length, and
  // assert byte-equality against the committed bytes.
  //
  // EXPECTED-RED WINDOW (17-03..17-06): the 17-02 Wire removal renumbered the
  // GridCommand discriminants (Wire gone; Delete/Rotate/DrawBelt shifted down) and
  // dropped the Wire member from `fixture_commands()`. The TS encoder + this
  // fixture now mirror that, but the committed `gridcommand.bin` still carries the
  // OLD Wire-bearing layout — it is re-frozen in the single coordinated re-bless
  // (17-06). Until then this byte assertion is EXPECTED to fail; the frontend
  // BUILD (tsc + vite) stays green and the non-parity unit tests above pass.
  const gridBytes = new Uint8Array(readFileSync(fixtureUrl('gridcommand.bin')));

  it('TS-encoded fixture commands byte-equal the committed gridcommand.bin', () => {
    const cmds: import('./decode.ts').GridCommand[] = [
      { kind: 'Place', kind_byte: 0, cell_x: 3, cell_y: 4 },
      { kind: 'Delete', node: 300 },
      { kind: 'Rotate', node: 400, ccw: true },
      { kind: 'DrawBelt', cells: [[0, 0], [1, 0], [1, 1]] },
    ];

    // Postcard Vec<T> = varint length prefix, then each element. cmds.length=4
    // is < 0x80 so the prefix is the single byte 0x04.
    const parts = cmds.map((c) => encodeGridCommand(c));
    const total = 1 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    out[0] = cmds.length; // varint length prefix (4)
    let off = 1;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }

    expect(out).toEqual(gridBytes);
  });
});

describe('encodeGridCommand — Dock byte literals (postcard grammar, 21-01)', () => {
  // Hand-computed from the postcard grammar verified against
  // crates/fabrico-protocol/src/lib.rs (GridCommand::Dock, post-17-02 renumber):
  //   varintU(4)  discriminant
  //   varintU(belt)  dense belt handle
  //   varintU(end)   BeltEnd disc: Head=0, Tail=1
  //   varintU(node)  dense node handle
  //   varintU(port)  SPATIAL catalog index (or 65535 sentinel)
  // This TS byte-literal golden is the RESEARCH Finding 8 recommended path;
  // the optional Rust gridcommand.bin re-freeze is explicitly NOT taken.

  it('Tail dock to the 65535 fault sentinel: 65535 LEB128-encodes to FF FF 03', () => {
    const bytes = encodeGridCommand({
      kind: 'Dock',
      belt: 2,
      end: 'Tail',
      node: 1,
      port: 65535,
    });
    expect(bytes).toEqual(new Uint8Array([4, 2, 1, 1, 0xff, 0xff, 0x03]));
  });

  it('Head dock to a plain catalog index: single-byte varints throughout', () => {
    const bytes = encodeGridCommand({
      kind: 'Dock',
      belt: 0,
      end: 'Head',
      node: 1,
      port: 2,
    });
    expect(bytes).toEqual(new Uint8Array([4, 0, 0, 1, 2]));
  });
});

describe('encodeBeltRunPace - the 0xFE sentinel frame (D-68-16, route R1)', () => {
  it('writes the sentinel as ONE RAW BYTE, so a small one-belt frame is exactly four bytes', () => {
    // THE CHECK THAT CATCHES A LEB128-ENCODED SENTINEL, and the only one that can.
    // `varintU(254)` emits TWO bytes (0xFE 0x01), so an encoder that varint-wrote
    // the sentinel would emit FIVE bytes with a stray 0x01 at index 1 - which the
    // host reads as a one-element list and the real length as the first handle,
    // failing in a way that looks exactly like a handle bug. Nothing else in the
    // tree sees the difference: both frames start 0xFE.
    const bytes = encodeBeltRunPace([7], 4);
    expect(Array.from(bytes)).toEqual([0xfe, 1, 7, 4]);
    expect(bytes).toHaveLength(4);
    expect(bytes[0]).toBe(0xfe);
    expect(bytes[1]).toBe(1);
  });

  it('writes the postcard body of { belts: Vec<u64>, ticks_per_slot: u32 }', () => {
    const bytes = encodeBeltRunPace([3, 9, 21], 20);
    const r = new PostcardReader(bytes.subarray(1));
    expect(r.varintU()).toBe(3);
    expect([r.varintU(), r.varintU(), r.varintU()]).toEqual([3, 9, 21]);
    expect(r.varintU()).toBe(20);
  });

  it('LEB128-encodes a handle past 127, and the sentinel still occupies one byte', () => {
    const bytes = encodeBeltRunPace([300], 2);
    expect(bytes[0]).toBe(BELT_RUN_PACE_LEAD);
    const r = new PostcardReader(bytes.subarray(1));
    expect(r.varintU()).toBe(1);
    expect(r.varintU()).toBe(300);
    expect(r.varintU()).toBe(2);
  });

  it('writes an EMPTY list as a zero-length vec rather than refusing client-side', () => {
    // The client never decides legality (the panel's whole discipline). An empty
    // run is refused by the HOST with a typed error, which is what reaches
    // `#fab-refusal`; the encoder's job is to say faithfully what it was given.
    expect(Array.from(encodeBeltRunPace([], 2))).toEqual([0xfe, 0, 2]);
  });

  it('cannot collide with any GridCommand: every shipped frame leads below 12', () => {
    // The sentinel's non-collision argument, checked rather than asserted in prose.
    // `GridCommand`'s discriminants occupy 0..=11 and the enum is FROZEN for this
    // milestone, so 254 names no variant and can name none.
    const shipped: GridCommand[] = [
      { kind: 'Place', kind_byte: 0, cell_x: 1, cell_y: 2 },
      { kind: 'Delete', node: 3 },
      { kind: 'Rotate', node: 3, ccw: false },
      { kind: 'DrawBelt', cells: [[0, 0]] },
      { kind: 'Dock', belt: 1, end: 'Head', node: 2, port: 0 },
      { kind: 'Undo' },
      { kind: 'Redo' },
      { kind: 'AddPort', node: 1, role: 1, side: 1, medium: 0 },
      { kind: 'RemovePort', node: 1, index: 0 },
      { kind: 'Configure', node: 1, config: { kind: 'Belt', ticks_per_slot: 4 } },
      { kind: 'DrawWire', from_node: 1, from_port: 0, to_node: 2, to_port: 0 },
      { kind: 'Unlink', belt: 1, end: 'Tail', node: 2, port: 0 },
    ];
    for (const cmd of shipped) {
      expect(encodeGridCommand(cmd)[0], `${cmd.kind} lead byte`).toBeLessThan(12);
    }
    expect(BELT_RUN_PACE_LEAD).toBe(0xfe);
  });
});
