// Hand-rolled postcard decoder for the fabrico sim->render wire contract.
//
// This is the ONE thing that genuinely must be hand-rolled: there is no
// maintained npm package for the Rust `postcard` wire format. It is pinned to
// the Rust-produced 0008 golden fixture (16-02) so the cross-language contract
// is proven before any pixels are drawn (decode.test.ts).
//
// Wire grammar (postcard, non-self-describing — field order is load-bearing):
//   - u8 / bool          : a single byte
//   - u16 / u32 / u64    : LEB128 unsigned varint
//   - i32 (signed)       : zigzag, then LEB128 unsigned varint
//   - Vec<T> / String    : varint length prefix, then that many elements
//   - enum               : varint discriminant, then the variant payload
//
// Every read is bounds-checked against the buffer length and throws a typed
// DecodeError on underrun — the decoder NEVER reads past the buffer and never
// crashes silently (Pitfall 3 / threat T-07-DECODE-OOB). The host is loopback
// and authoritative, but a robust decoder is defense-in-depth.

import { machine_kind } from './kinds';

// ---------------------------------------------------------------------------
// Decoded shapes — kept in sync with crates/fabrico-protocol/src/lib.rs.
// Defined inline (NOT imported from the gitignored ts-rs `bindings/`) so the
// frontend build never depends on a generated artifact that may be absent in
// CI. The 0008 golden fixture is the contract that keeps these honest.
// ---------------------------------------------------------------------------

/**
 * One resolved machine port: the host projects it to a WORLD cell + side + role
 * (In=0, Out=1, Fault=2). The frontend renders nubs and resolves belt docks off
 * these; the wire keeps them as bare integers (Phase 21 owns the visuals).
 */
export interface PortView {
  index: number;
  cell_x: number;
  cell_y: number;
  side: number; // N=0, E=1, S=2, W=3 (rot-applied)
  role: number; // In=0, Out=1, Fault=2
  medium: number; // Mechanical=0, Electrical=1 (appended LAST on the wire, 35-03)
}

export interface NodeView {
  id: number;
  kind: number;
  cell_x: number;
  cell_y: number;
  state: number;
  /** Footprint width in the rot-0 frame (ABSENT core footprint => 1). */
  w: number;
  /** Footprint height in the rot-0 frame (ABSENT core footprint => 1). */
  h: number;
  /** Authoritative orientation: number of 90deg clockwise quarter-turns (0..=3). */
  rot: number;
  /**
   * Host-resolved ports (world cell + side + role). EMPTY for a node with no
   * ports. Appended LAST on the wire (after `rot`).
   */
  ports: PortView[];
  /**
   * Mechanical inbox fill as a LEVEL, 0..4 (PILE-08). Already quantised host-side
   * against the admission cap, so nothing here mirrors that cap. Appended LAST on
   * the wire, AFTER `ports`; the matching read in `readNodeView` is not optional
   * (see that function's comment).
   */
  load: number;
  /**
   * A label's committed words and colour (phase 76, plan 76-02), `null` on every other
   * kind. Appended LAST on the wire, AFTER `load`, as a postcard `Option<LabelView>`.
   * OPTIONAL IN THE TYPE ONLY so hand-written test literals that predate it stay valid;
   * `readNodeView` ALWAYS writes it, `null` or an object, never `undefined` (the 0008
   * golden's JSON carries `null` and the deep-equal reads it).
   */
  label?: LabelView | null;
}

/**
 * A label's words and colour on the wire, the mirror of `fabrico_protocol::LabelView`:
 * `text` is the committed words (drawn as TEXT, never parsed as markup) and `colour` is the
 * `LabelColour` byte (Sand 0, Stone 1, Moss 2, Lilac 3, Rose 4, Clay 5).
 */
export interface LabelView {
  text: string;
  colour: number;
}

export interface ItemView {
  arrival_tick: number;
  tag: number;
}

/**
 * The typed straight/corner geometry of one belt tile. Mirrors serde's
 * externally-tagged encoding of `fabrico_protocol::TileKindView` (the shape the
 * committed `.expected.json` golden carries — `{ Straight: { axis } }`), NOT a
 * `{ t: ... }` internally-tagged variant. `axis`: X=0, Y=1; `from`/`to` are Dir
 * (N=0, E=1, S=2, W=3).
 */
export type TileKindView =
  | { Straight: { axis: number } }
  | { Corner: { from: number; to: number } };

/**
 * One drawn belt tile: its grid cell plus its typed straight/corner geometry. `kind` is
 * the tile AS DRAWN, which at a docked end is the host's derived seam kind
 * (`effective_belt_tiles`, phase 74.1), not necessarily the kind `route()` stored.
 */
export interface TileView {
  cell_x: number;
  cell_y: number;
  kind: TileKindView;
}

/** Which end of a belt docks to a machine port (postcard: Head=0, Tail=1). */
export type BeltEnd = 'Head' | 'Tail';

/**
 * One per-end belt dock: the docked machine's dense render handle + the port
 * index it docks to + which end docks there. The frontend resolves the world
 * cell locally off the docked node's `ports[]` (FORK B), so the host does NOT
 * re-emit the belt when a docked node moves.
 */
export interface BeltDockView {
  end: BeltEnd;
  node: number;
  port: number;
}

export interface BeltView {
  id: number;
  latency: number;
  fill: number;
  items: ItemView[];
  /**
   * Resolved per-tile geometry (straight/corner). EMPTY for a `Wire`-minted
   * belt (renderer falls back to the degenerate one-cell guard); length matches
   * the drawn path for a `DrawBelt`-drawn belt.
   */
  tiles: TileView[];
  /**
   * Per-end docks (Head before Tail) carrying the docked node handle + port.
   * EMPTY for an undocked belt. Appended after `tiles` on the wire.
   */
  docks: BeltDockView[];
  /**
   * This belt's own advance interval in SIM TICKS per slot (SLOT-03). Larger means
   * slower: the sim advances the belt one slot on every tick `T` where
   * `T % ticks_per_slot == 0`.
   *
   * Appended LAST on the wire (after `docks`). It is on the wire at all because the
   * painted tread's rate is derived from the speed of the cargo the belt carries,
   * and `interp.ts` forbids a render-side copy of a core constant - a second source
   * of truth a core bump could silently desynchronise.
   *
   * The core holds it as a non-zero integer; a zero here means a broken producer.
   * Consumers must FLOOR it rather than divide by it (a division by zero would
   * produce a non-finite phase, and a non-finite bucket index kills the render
   * loop, which no model-level oracle can see).
   */
  ticks_per_slot: number;
}

/**
 * One electrical-wire endpoint dock (WUI-01): the docked machine's dense render
 * handle + the port index the wire terminal attaches to. Mirrors the FORK-B
 * `BeltDockView` discipline — carries the `(node, port)` HANDLE, not a resolved
 * cell, so the frontend resolves the nub anchor off the docked node's `ports[]`.
 */
export interface WireDockView {
  node: number;
  port: number;
}

/**
 * One in-flight wire pulse (WUI-01) — a request/reply energy pulse animated along
 * the cable. The on-cable position is derived render-side from
 * `(effectiveClock - entry_tick) / hop_ticks`, so no float rides the wire.
 * `direction` is the host-derived byte: 0 = FORWARD (request out), 1 = REPLY
 * (response home) — an OPEN u8 (an unknown byte maps to a default downstream,
 * never throws here, mirroring the role/side open-byte discipline).
 */
export interface WirePulseView {
  entry_tick: number;
  hop_ticks: number;
  direction: number; // FORWARD=0, REPLY=1 (open byte)
}

/**
 * An electrical request/response transport wire projected for the renderer
 * (WUI-01): a `Node::Wire` becomes a drawable/animatable cable. EPHEMERAL
 * sim->render IPC appended LAST on the packet (after `can_redo`).
 *
 * - `from`/`to`: the two endpoint docks (`(node, port)` handles, resolved
 *   frontend-side like belt docks).
 * - `path`: the `wire_route()`-normalized orthogonal cell path (wire corners
 *   inherit belt corner geometry) — the same `TileView` shape belts use.
 * - `pulses`: the in-flight request/reply pulses (EMPTY for an idle wire).
 */
export interface WireView {
  id: number;
  from: WireDockView;
  to: WireDockView;
  path: TileView[];
  pulses: WirePulseView[];
}

export interface RenderPacket {
  tick: number;
  full: boolean;
  /**
   * WHY a `full` packet was sent (73-12, 73-REVIEW WR-01): `true` = a LAG RESYNC,
   * `false` = everything else. Meaningless on a diff packet, where the host always
   * emits `false`.
   *
   * `full` alone conflates two events that mean opposite things to a client holding
   * an unacknowledged port edit. A RESTRUCTURE (undo, redo, load, New, scene swap)
   * re-writes the timeline, after which the packet index that edit was addressed
   * against means nothing and `portEditLatch` is right to release. A LAG RESYNC
   * re-sends the CURRENT keyframe to a connection that fell past the bounded diff
   * broadcast: the timeline did not move, the edit may still be sitting unfolded in
   * the host's gesture channel, and releasing there is the releases-too-early
   * direction that killed the latch's first iteration.
   *
   * Appended on the wire after `wires`, and read STRICTLY since phase 88 (plan 88-03): a
   * packet without it is truncated and fails to decode, like every other field.
   */
  resync: boolean;
  /**
   * The BOARD GENERATION of the handle table every handle in this packet belongs to
   * (phase 88, D-02, D-05), appended LAST on the wire after `resync`. Every host reset (an
   * undo, a redo, a load, a New, a scene swap) mints every render handle again from 0 and
   * raises this number by one, so a handle means something only together with the
   * generation it was read under. The client echoes it on every gesture frame
   * (`encodeGestureFrame`) so the host can resolve a handle against the table the user saw.
   *
   * Read STRICTLY: a packet without it fails to decode. A defaulted 0 would silently
   * address every handle the client sends against the wrong table.
   */
  generation: number;
  /**
   * The generation the last BOARD SWAP installed, the host's swap floor (phase 88 security,
   * T-88-11), appended LAST on the wire after `generation`. An undo's keyframe and a Load's
   * both raise the generation; only this says which one the client holds. It equals
   * `generation` on the swap's own keyframe and stays there until the next swap. A handle or
   * an accept from a generation below it was read on a replaced board and names nothing on
   * this one, so nothing is named again across it (`gestures.ts` `tryLand`, `tryLandBelt`),
   * whichever page or client asked for the swap.
   *
   * Read STRICTLY, like `generation`.
   */
  swap_floor: number;
  placed: NodeView[];
  removed: number[];
  belts: BeltView[];
  /**
   * Undo/redo availability (UNDO-06), appended LAST on the wire (after `belts`)
   * — the exact Rust `RenderPacket` field order. The host sources these from the
   * live `GridSession` on EVERY packet (diff AND keyframe) so the toolbar greys
   * out correctly. MANDATORY: the Rust `RenderPacket` always emits these two
   * trailing bools and the 0008 golden is frozen with them, so a well-formed
   * packet always carries them — a packet missing them is truncated and MUST
   * surface a DecodeError like every other underrun (not silently decode).
   */
  can_undo: boolean;
  can_redo: boolean;
  /**
   * The live electrical-wire projections (WUI-01), appended LAST on the wire
   * (after `can_redo`) — the exact Rust `RenderPacket` field order. EMPTY for a
   * grid with no wires (a well-formed packet always carries the length prefix, so
   * a `0` length decodes to an empty array; a truncated wires tail underruns and
   * throws a DecodeError like every other field — total/reject-only decode).
   */
  wires: WireView[];
}

/** Typed decode failure — thrown on buffer underrun or a malformed varint. */
export class DecodeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

/**
 * A cursor over a postcard byte buffer. Reads only the fixed integer grammar
 * the render-packet uses. Bounds-checked: every primitive throws DecodeError
 * before reading past the end.
 */
export class PostcardReader {
  private i = 0;

  constructor(private readonly b: Uint8Array) {}

  /** Bytes not yet consumed. */
  remaining(): number {
    return this.b.length - this.i;
  }

  private next(): number {
    if (this.i >= this.b.length) {
      throw new DecodeError(
        `postcard underrun: read past end of buffer (len=${this.b.length})`,
      );
    }
    return this.b[this.i++];
  }

  /** A single unsigned byte. */
  u8(): number {
    return this.next();
  }

  /** A single byte interpreted as a boolean (postcard encodes false=0, true=1). */
  bool(): boolean {
    return this.next() !== 0;
  }

  /**
   * A postcard `String`: a varint BYTE length, then that many bytes of UTF-8 (phase 76,
   * the first string the render packet carries: a label's words). The length is checked
   * against the bytes left BEFORE anything is sliced, so a forged length is a typed
   * underrun rather than a short read, and the bytes are decoded `fatal`, so invalid
   * UTF-8 is a typed decode error rather than replacement characters drawn on the board.
   */
  str(): string {
    const n = this.varintU();
    if (n > this.remaining()) {
      throw new DecodeError(
        `postcard underrun: string of ${n} bytes with ${this.remaining()} left`,
      );
    }
    const bytes = this.b.subarray(this.i, this.i + n);
    this.i += n;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new DecodeError('postcard string is not valid UTF-8');
    }
  }

  /**
   * LEB128 unsigned varint. Accumulates with `* 2 ** shift` (NOT `<<`) to stay
   * in JS safe-integer range — dense render handles stay below 2^53 by design
   * (A3), so a plain `number` is correct here and we never reach for BigInt.
   */
  varintU(): number {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (shift > 63) {
        throw new DecodeError('postcard varint too long (>10 bytes)');
      }
      byte = this.next();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  /**
   * Signed varint: postcard encodes signed integers zigzag-then-LEB128.
   * zigzag decode maps the unsigned form back to signed:
   *   value = (n >>> 1) ^ -(n & 1)
   * Valid for the i32 cell coordinates on the wire.
   */
  varintI(): number {
    const n = this.varintU();
    // (n >>> 1) ^ -(n & 1) — done with bitwise ops, safe for i32 range.
    return (n >>> 1) ^ -(n & 1);
  }

  /** A length-prefixed homogeneous sequence (postcard Vec / slice). */
  vec<T>(read: () => T): T[] {
    const n = this.varintU();
    const out: T[] = new Array(n);
    for (let k = 0; k < n; k++) {
      out[k] = read();
    }
    return out;
  }
}

/**
 * Decode one resolved machine port. Field order MUST mirror the Rust
 * `fabrico_protocol::PortView` struct declaration exactly:
 *   index (varintU), cell_x (varintI), cell_y (varintI), side (u8), role (u8),
 *   medium (u8).
 * role/side/medium stay OPEN u8 on the wire — an unknown byte maps to a default
 * sprite downstream (Phase 21) and never throws here (T-16-ROLE-OPEN: accepted).
 * `medium` was appended LAST (35-03) to keep the reader prefix byte-stable; the
 * TS reader now consumes it (else the ports vec underruns — Phase 36 fix).
 */
function readPortView(r: PostcardReader): PortView {
  return {
    index: r.varintU(),
    cell_x: r.varintI(),
    cell_y: r.varintI(),
    side: r.u8(),
    role: r.u8(),
    medium: r.u8(), // Mechanical=0, Electrical=1 (appended LAST, 35-03)
  };
}

/**
 * Decode a label's `Option<LabelView>` (phase 76, plan 76-02): one tag byte, 0 for `None`
 * (decoded to `null`), 1 for `Some` followed by the struct positionally, `text` as a
 * byte-length-prefixed UTF-8 string then `colour` as one byte. Any other tag is a decode
 * error: postcard writes only 0 or 1, so a third value means the reader is already out of
 * step, and reading on would decode garbage as the next node.
 */
function readLabel(r: PostcardReader): LabelView | null {
  const tag = r.u8();
  if (tag === 0) return null;
  if (tag !== 1) throw new DecodeError(`NodeView.label option tag ${tag} (expected 0 or 1)`);
  return { text: r.str(), colour: r.u8() };
}

/**
 * Decode one placed machine. Field order MUST mirror the Rust
 * `fabrico_protocol::NodeView` struct declaration exactly, all ELEVEN fields:
 *   id, kind, cell_x, cell_y, state, w, h, rot, ports, load, label.
 * `label` was appended LAST by phase 76 (plan 76-02), AFTER `load`, and the same
 * positional rule below applies to it: an unread option tag desynchronises the packet.
 * `state` stays an OPEN u8 (IDLE=0, WORKING=1, FAULTED=2, BACKED_UP=3 today); an
 * unknown byte maps to a default mark downstream and never throws here.
 * `load` was appended LAST (71-05, AFTER the `ports` vec) to keep the reader prefix
 * byte-stable, and the read below is what consumes it. WITHOUT THAT READ THE GAUGE
 * DOES NOT GO MISSING: this reader is POSITIONAL, so the unconsumed byte shifts
 * every following field, corrupting `ports` and every node after this one in the
 * packet. That has shipped here once before, on the `medium` append (Phase 36 fix,
 * see `readPortView`). The multi-node and full-buffer-consumption cases in
 * `decode.test.ts` are the only checks that see it - `tsc` cannot, because the
 * generated ts-rs binding and the local `NodeView` interface above are two separate
 * declarations that nothing compares.
 */
function readNodeView(r: PostcardReader): NodeView {
  return {
    id: r.varintU(),
    kind: r.u8(),
    cell_x: r.varintI(),
    cell_y: r.varintI(),
    state: r.u8(),
    w: r.varintU(), // u16
    h: r.varintU(), // u16
    rot: r.u8(), // u8
    // Host-resolved ports, appended LAST on the wire (16-03).
    ports: r.vec(() => readPortView(r)),
    // The gauge level 0..4, appended LAST after `ports` (71-05). MUST be read.
    load: r.u8(),
    // A label's words and colour, appended LAST after `load` (76-02). MUST be read.
    label: readLabel(r),
  };
}

function readItemView(r: PostcardReader): ItemView {
  return {
    arrival_tick: r.varintU(),
    tag: r.u8(),
  };
}

/**
 * Decode one belt tile. The TileKind enum rides as a varint discriminant then
 * its u8 payload. A discriminant outside {0,1} throws DecodeError — a forged
 * tag is REJECTED, never default-guessed (Security V5 / T-14-TILE-DISC). Every
 * read goes through the bounds-checked reader, so a truncated tile buffer
 * throws on underrun rather than reading past the end (T-14-DECODE-OOB).
 */
function readTileView(r: PostcardReader): TileView {
  const cell_x = r.varintI();
  const cell_y = r.varintI();
  const disc = r.varintU();
  if (disc === 0) {
    return { cell_x, cell_y, kind: { Straight: { axis: r.u8() } } };
  }
  if (disc === 1) {
    return { cell_x, cell_y, kind: { Corner: { from: r.u8(), to: r.u8() } } };
  }
  throw new DecodeError(`unknown TileKind discriminant ${disc} (expected 0=Straight or 1=Corner)`);
}

/**
 * Decode one per-end belt dock. The BeltEnd enum rides as a varint discriminant
 * (Head=0, Tail=1) then its (node, port) payload. A discriminant outside {0,1}
 * throws DecodeError — a forged tag is REJECTED, never default-guessed (mirrors
 * readTileView; Security V5 / T-16-DOCK-DISC). Every read is bounds-checked, so
 * a truncated dock buffer throws on underrun (T-16-DECODE-OOB).
 */
function readBeltDockView(r: PostcardReader): BeltDockView {
  const disc = r.varintU();
  let end: BeltEnd;
  if (disc === 0) {
    end = 'Head';
  } else if (disc === 1) {
    end = 'Tail';
  } else {
    throw new DecodeError(`unknown BeltEnd discriminant ${disc} (expected 0=Head or 1=Tail)`);
  }
  return { end, node: r.varintU(), port: r.varintU() };
}

function readBeltView(r: PostcardReader): BeltView {
  // Field order MUST match fabrico-protocol::BeltView; `ticks_per_slot` (SLOT-03) is
  // appended LAST, after `docks`.
  //
  // IT IS READ STRICTLY, AND THE PACKET-LEVEL `wires` DEGRADATION IS DELIBERATELY NOT
  // COPIED HERE. That pattern (catch a DecodeError on the newest append-last field and
  // degrade to a default) is correct at the TOP level, where a short tail means an
  // older producer and the rest of the scene is already decoded and usable. This
  // reader is nested inside an `r.vec()`: a short read here is a genuinely TRUNCATED
  // packet, the belt array's remaining entries are garbage, and swallowing it would
  // hand the renderer a scene it cannot trust. So this field throws on underrun
  // exactly as `latency` does.
  return {
    id: r.varintU(),
    latency: r.varintU(),
    fill: r.varintU(),
    items: r.vec(() => readItemView(r)),
    tiles: r.vec(() => readTileView(r)),
    docks: r.vec(() => readBeltDockView(r)),
    ticks_per_slot: r.varintU(),
  };
}

/** Decode one wire endpoint dock: node handle (varintU) then port index (varintU). */
function readWireDockView(r: PostcardReader): WireDockView {
  return { node: r.varintU(), port: r.varintU() };
}

/**
 * Decode one in-flight wire pulse. Field order MUST mirror the Rust
 * `fabrico_protocol::WirePulseView`: entry_tick (varintU), hop_ticks (varintU),
 * direction (u8). `direction` is an OPEN u8 — an unknown byte maps to a default
 * downstream (never throws here, mirroring the role/side open-byte discipline).
 * Every read is bounds-checked, so a truncated pulse throws on underrun.
 */
function readWirePulseView(r: PostcardReader): WirePulseView {
  return {
    entry_tick: r.varintU(),
    hop_ticks: r.varintU(),
    direction: r.u8(),
  };
}

/**
 * Decode one electrical WireView (WUI-01). Field order MUST mirror the Rust
 * `fabrico_protocol::WireView`: id (varintU), from (WireDockView), to
 * (WireDockView), path (Vec<TileView>), pulses (Vec<WirePulseView>). The `path`
 * reuses the belt `readTileView` reader (a forged tile discriminant is REJECTED),
 * and every read is bounds-checked so a short/truncated wire tail throws on
 * underrun rather than reading past the buffer (T-40-DECODE-OOB / total decode).
 */
function readWireView(r: PostcardReader): WireView {
  return {
    id: r.varintU(),
    from: readWireDockView(r),
    to: readWireDockView(r),
    path: r.vec(() => readTileView(r)),
    pulses: r.vec(() => readWirePulseView(r)),
  };
}

/**
 * Decode a single postcard render-packet. Reads tick/full/placed/removed/belts
 * then the trailing can_undo/can_redo and the appended `wires` tail in the EXACT
 * fabrico-protocol::RenderPacket field order. Throws DecodeError on any underrun.
 */
export function decodeRenderPacket(bytes: Uint8Array): RenderPacket {
  return decodeRenderPacketFrom(new PostcardReader(bytes));
}

/**
 * The same decode, driven off a reader the CALLER owns.
 *
 * This exists so a test can observe CONSUMPTION. `readNodeView` is a positional
 * byte reader, so a field written by the Rust producer and not read here does not
 * go missing: on a one-node packet it is left trailing, which a decoder that never
 * checks its cursor happily ignores. Asking the caller's reader for
 * `remaining() === 0` after the packet is the one-line assertion that turns that
 * silent desync into a red. Nothing in production needs the reader back; the
 * public `decodeRenderPacket` above is the entry every caller uses.
 */
export function decodeRenderPacketFrom(r: PostcardReader): RenderPacket {
  // Trailing undo/redo availability (can_undo, can_redo) are read UNCONDITIONALLY
  // AFTER belts, in exact Rust `RenderPacket` field order. They are MANDATORY on
  // the wire (the Rust struct always emits them), so a truncated packet missing
  // them underruns and throws DecodeError via `r.bool()` — matching every other
  // field's underrun behaviour rather than silently leaving them undefined.
  // The `wires` field is appended LAST (WUI-01): a well-formed packet always
  // carries its length prefix (0 => empty array); a truncated wires tail
  // underruns and throws DecodeError, exactly like every other field.
  const base = {
    tick: r.varintU(),
    full: r.bool(),
    placed: r.vec(() => readNodeView(r)),
    removed: r.vec(() => r.varintU()),
    belts: r.vec(() => readBeltView(r)),
    can_undo: r.bool(),
    can_redo: r.bool(),
  };
  // THE TAIL IS STRICT (phase 88, plan 88-03, D-02, D-05). `wires` (WUI-01), `resync`
  // (73-12) and `generation` (phase 88) are the three fields appended last, in that order,
  // and each is read exactly like every field above: a packet that runs out before any of
  // them throws DecodeError. Until plan 88-03 the first two sat on a degrade-to-default
  // tail that swallowed an underrun into an empty wires map and `resync: false`. That
  // tail is gone on purpose: `generation` cannot ride it, because a defaulted generation of
  // 0 would make every gesture the client sends address its handles against the wrong
  // handle table, the exact defect the field exists to end. A host and a client built from
  // different revisions now fail to decode rather than edit the wrong machine.
  const wires = r.vec(() => readWireView(r));
  const resync = r.bool();
  const generation = r.varintU();
  // Phase 88 security (T-88-11): the swap floor, appended after `generation`, read as strictly.
  const swap_floor = r.varintU();
  return { ...base, wires, resync, generation, swap_floor };
}

// ---------------------------------------------------------------------------
// render -> sim gesture encoder (the path 07-09's palette/gesture layer uses).
// Mirrors fabrico-protocol::GridCommand (an enum: discriminant then payload).
// GridCommand SUPERSEDES the removed InputCmd. Phase 17-02 removed the node->node
// `Wire` variant from the Rust enum (belts come only from DrawBelt + Dock), which
// byte-forced every later discriminant DOWN one: Place=0, Delete=1, Rotate=2,
// DrawBelt=3, Dock=4, Undo=5, Redo=6. This TS encoder drives ALL seven shipped
// variants (Dock added in 21-01, CTRL-04) with a compile-time `never`
// exhaustiveness default so a missing arm is a tsc error, not a runtime gap.
// This union mirrors that renumber exactly; the cross-language gridcommand.bin
// parity is re-frozen in 17-06 and Dock byte parity is pinned by TS byte
// literals in decode.test.ts.
// ---------------------------------------------------------------------------

export type GridCommand =
  | { kind: 'Place'; kind_byte: number; cell_x: number; cell_y: number }
  | { kind: 'Delete'; node: number }
  | { kind: 'Rotate'; node: number; ccw: boolean }
  // DrawBelt carries INTEGER grid cells only — the wire grammar (varintI per
  // coordinate) admits no float into a logged command (T-14-FLOAT-LEAK).
  | { kind: 'DrawBelt'; cells: [number, number][] }
  // Dock a drawn belt's end to a machine port (CTRL-01). The `port` field
  // carries the SPATIAL catalog index VERBATIM — the HOST owns the
  // Out-routing-key / FAULT_PORT translation at freeze time (D-11; the 20-01
  // design). Never duplicate the routing-key mapping at encode time; only the
  // READ-side resolver (ports.ts dockPort) reverse-maps wire keyspaces.
  | { kind: 'Dock'; belt: number; end: 'Head' | 'Tail'; node: number; port: number }
  // Fieldless single-step undo/redo (UNDO-04). The command layer resolves the
  // target from its linear undo cursor host-side (Q4.3 — no UndoTo(action_id)),
  // so the wire carries ONLY the discriminant byte. Discriminants 5/6 follow the
  // post-17-02 order (Place0 Delete1 Rotate2 DrawBelt3 Dock4 Undo5 Redo6).
  | { kind: 'Undo' }
  | { kind: 'Redo' }
  // AddPort/RemovePort — the SOLE serialized-wire touch of Phase 36 (PORT-06/07),
  // appended LAST after Redo so every prior discriminant is byte-unchanged
  // (cmd-wire stays v3, golden_gridcommand.bin stays byte-green; mirrors the
  // Undo/Redo append discipline). Field order mirrors the Rust GridCommand
  // variants EXACTLY (crates/fabrico-protocol/src/lib.rs AddPort/RemovePort):
  //   AddPort  (disc 7): node (u64), role (u8), side (u8), medium (u8)
  //   RemovePort (disc 8): node (u64), index (u16)
  // Wire bytes: role In=0/Out=1/Fault=2, side N=0/E=1/S=2/W=3,
  // medium Mechanical=0/Electrical=1. The carried `side`/offset are re-seated
  // deterministically by the host fold; they ride only for shape completeness.
  | { kind: 'AddPort'; node: number; role: number; side: number; medium: number }
  | { kind: 'RemovePort'; node: number; index: number }
  // Configure (disc 9) — the SOLE Phase 39 serialized-wire touch (CFG-01/02),
  // appended LAST after RemovePort so every prior discriminant is byte-unchanged
  // (cmd-wire stays v3; the Undo/Redo/AddPort append discipline). Carries a
  // NESTED MachineConfig tree and NO `code_hash` on the wire — the HOST stamps
  // the blake3 of the Factory JS bytes at freeze time (39-04). The nested
  // encoders below mirror the frozen Rust variant order EXACTLY; a wrong
  // discriminant or a mis-sized varint is a silent cross-language byte-drift
  // (T-39-BYTE-DRIFT), which is why 39-05 pins them to configure-gridcommand.bin.
  | { kind: 'Configure'; node: number; config: MachineConfig }
  // DrawWire (disc 10) / Unlink (disc 11) — the Phase 63 command-wire appends
  // (WIRE-01/WIRE-02, CONNECT-01), landed while fabrico-protocol was open because
  // that crate freezes at the end of Phase 63 and Phases 66/67 need both shapes.
  // Appended LAST after Configure so every prior discriminant is byte-unchanged.
  //
  // DrawWire's ports are DECLARED port indices on each endpoint. Unlink's `port` is
  // the machine port's SPATIAL CATALOG index, exactly like Dock's — the host owns
  // the catalog -> routing-key translation at freeze time (never duplicate it here).
  | { kind: 'DrawWire'; from_node: number; from_port: number; to_node: number; to_port: number }
  | { kind: 'Unlink'; belt: number; end: 'Head' | 'Tail'; node: number; port: number };

// MachineConfig / SourceTrigger / SinkTemplate — protocol-local TS mirrors of
// the frozen fabrico-core enums (crates/fabrico-core/src/edit.rs MachineConfig
// / SourceTrigger, crates/fabrico-core/src/state.rs SinkTemplate / HttpMethod).
// The `kind` discriminant string ORDER below is load-bearing: it maps 1:1 to the
// Rust variant declaration order (the wire discriminant index), pinned by the
// 39-03 cross-language fixture:
//   MachineConfig : Factory=0, Source=1, Sink=2, Belt=3, Router=4, Endpoint=5, Label=6
//   SourceTrigger : Webhook=0, Timer=1
//   SinkTemplate  : Debug=0,   Http=1   (Phase 85 deleted Email=1; Http was 2)
//   HttpMethod    : Get=0, Post=1, Put=2, Patch=3, Delete=4  (method rides as a u8)
//
// Belt=3 and Router=4 landed in Phase 63-04 (BELT-02 / ROUTE-03). Endpoint=5
// landed in 72-07 (SERVE-08) and APPENDS STRICTLY LAST, which is what let
// EDIT_SCHEMA_VERSION stay at 7 THROUGH THAT PHASE: no already-encoded byte moved.
//
// EDIT_SCHEMA_VERSION IS 8 FROM PHASE 73 (plan 73-03), and nothing in THIS union is why.
// It was forced by two fields on two existing `EditOp` / capture variants
// (`AddPort.index` and `DeletedSubgraph.self_record`), neither of which is a
// `MachineConfig`. The distinction is the whole point of the sentence above it and is
// worth keeping straight: an append at the LAST position of a variant list moves no
// stored byte, while a field added to an EXISTING variant moves every byte after it.
//
// EDIT_SCHEMA_VERSION IS 9 FROM PHASE 74.1 (plan 74.1-12), and no byte in this file or any
// EditOp moved for it: two fold verdicts changed what an unchanged log folds to (the
// 74.1-03 rotate facing narrowing and the 74.1-12 port-edit release), so the host refuses
// every version-8 log rather than mis-folding it.
//
// EDIT_SCHEMA_VERSION IS 10 FROM PLAN 74.1-14, again with no byte moved: the port-edit
// reseat rule became centre-out from the catalog box (the ruling 2026-10-04, "Edits
// keep middle layout") and the Router catalog took its output, so version-9 logs are refused.
//
// EDIT_SCHEMA_VERSION IS 11 FROM PLAN 74.1-16, forced by two trailing fields on the
// AddPort and RemovePort edit records (no port edit moves an existing port, the ruling
// of 2026-10-04); no byte of this union or of any cmd-wire message moved, so version-10
// logs are refused host-side and nothing here changes shape.
//
// EDIT_SCHEMA_VERSION IS 13 FROM PHASE 86 (plan 86-02): a Place and a Delete capture carry
// the machine's turn, and a captured belt its pace; no cmd-wire byte moved.
export type MachineConfig =
  | { kind: 'Factory'; source: string }
  | { kind: 'Source'; trigger: SourceTrigger }
  | { kind: 'Sink'; target: SinkTemplate }
  // Belt (disc 3): the belt's own advance interval in sim ticks per slot. The core
  // holds it as a NonZeroU32; the wire carries a plain integer and the command layer
  // refuses a zero with a typed error rather than inventing a speed.
  | { kind: 'Belt'; ticks_per_slot: number }
  // Router (disc 4): the ORDERED match table and the default ("else") output port.
  // Order is load-bearing — the first matching rule wins, so this must never be
  // sorted or deduped on its way to the wire. `default: null` routes a no-match to
  // the fault port.
  | { kind: 'Router'; routes: [RouteKey, number][]; default: number | null }
  // Endpoint (disc 5, plan 72-07 / D-12): the Route's ADDRESS, as a serialized
  // field on the node. It carries its LEADING SLASH - the stored value is what the
  // panel shows and what `endpoint_route_key` publishes, so nothing strips it on
  // the way through. The core bounds it at `MAX_ENDPOINT_PATH_BYTES` and refuses a
  // duplicate with a typed `DuplicatePath`; the panel's own gate is a courtesy.
  | { kind: 'Endpoint'; path: string }
  // Label (disc 6, plan 76-02 / D-04): a label's words, colour and size in ONE config, so
  // one Apply is one edit record and one undo step. `colour` is the LabelColour byte
  // (0..5; the host refuses anything above as UnknownOption, Malformed until plan 88-02), `w` and `h` are cells and ride
  // the wire as varints. Appended STRICTLY LAST, so EDIT_SCHEMA_VERSION stays 11.
  | { kind: 'Label'; text: string; colour: number; w: number; h: number };

// One routing rule on the wire — the TS mirror of fabrico_protocol::RouteKey. A rule
// matches when the item's bytes at [offset .. offset+expect.length] equal `expect`.
// Field order is load-bearing: postcard encodes a struct POSITIONALLY.
export interface RouteKey {
  /** Byte offset into the item at which to compare. */
  offset: number;
  /** The expected bytes at [offset .. offset+expect.length]. */
  expect: number[];
}

export type SourceTrigger =
  | { kind: 'Webhook' }
  | { kind: 'Timer'; interval_ticks: number };

export type SinkTemplate =
  | { kind: 'Debug' }
  | { kind: 'Http'; url: string; method: number };

/** Append-only growable byte sink mirroring the postcard write grammar. */
export class PostcardWriter {
  private bytes: number[] = [];

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  /**
   * LEB128 unsigned varint (matches PostcardReader.varintU).
   *
   * Only a safe non-negative integer encodes (phase 91 review CR-B-01, T-91-24, UF-91-02). The
   * loop below never ends on `Infinity` (`Infinity / 128` is `Infinity`; a pasted timer value hung
   * Apply this way), a value past 2^53 is not the integer the caller holds, and a negative or a
   * fraction writes bytes the host reads as a different number. So any of those throws here, as
   * `encodeGestureFrame` already does for its header, and nothing is sent.
   */
  varintU(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError(`PostcardWriter.varintU: ${v} is not a safe non-negative integer`);
    }
    let n = v;
    while (n >= 0x80) {
      this.bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n & 0x7f);
  }

  /** zigzag-then-LEB128 signed varint (matches PostcardReader.varintI). */
  varintI(v: number): void {
    // zigzag encode for i32: (v << 1) ^ (v >> 31)
    const zz = ((v << 1) ^ (v >> 31)) >>> 0;
    this.varintU(zz);
  }

  /**
   * postcard string grammar: varintU(UTF-8 BYTE length) then the raw UTF-8
   * bytes. The prefix is the BYTE length (from TextEncoder), never the JS char
   * `.length` — a multi-byte codepoint (e.g. emoji, accented char) occupies
   * more bytes than chars, and the Rust `String` decoder reads exactly this many
   * bytes. Mismatching the two is T-39-STR-LEN (a decode reject / silent
   * mis-parse at the Rust boundary).
   */
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.varintU(b.length);
    for (const byte of b) this.bytes.push(byte);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * The first byte of every gesture frame (security T-88-09): the wire version of the
 * header. The Rust twin is `fabrico_host::transport_ws::GESTURE_FRAME_VERSION`, and a Rust
 * test reads this declaration and fails if the two differ, so change both or neither.
 *
 * It is 0xF1 and not 1 because no older page's frame may start with it: a page from
 * before phase 88 sent a bare body, which starts with a GridCommand discriminant (0 to 11)
 * or the run-pace lead 0xFE. The host refuses a frame without it as unreadable, so a page
 * left open across a host rebuild gets the could-not-read sentence instead of having its
 * Dock read as a Delete.
 */
export const GESTURE_FRAME_VERSION = 0xf1;

/**
 * Frame one gesture for the wire (phase 88, D-02, D-06; version byte T-88-09):
 * `[GESTURE_FRAME_VERSION][varint generation][varint gesture id][body]`, the body untouched
 * (the bytes `encodeGridCommand` or `encodeBeltRunPace` wrote, the run-pace lead still a
 * raw byte). The Rust mirror is `fabrico_host::transport_ws::frame_gesture`, and its
 * inverse is `decode_gesture`, which reads this header FIRST and refuses a frame without
 * it.
 *
 * - `generation`: the board generation of the render packet the gesture's handles were
 *   read from (`RenderPacket.generation`), so the host resolves them against the table the
 *   user was looking at.
 * - `gestureId`: the client's own id for the gesture, monotonic per page load. The host's
 *   verdict on this gesture carries it back as `seq`.
 *
 * Both are LEB128 varints written with the writer's `varintU`. Each must be a safe
 * non-negative integer: anything else would encode to bytes the host reads as a different
 * number, so it throws rather than sending them.
 */
export function encodeGestureFrame(generation: number, gestureId: number, body: Uint8Array): Uint8Array {
  for (const [name, v] of [
    ['generation', generation],
    ['gestureId', gestureId],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError(`encodeGestureFrame: ${name} must be a safe non-negative integer, got ${v}`);
    }
  }
  const w = new PostcardWriter();
  w.u8(GESTURE_FRAME_VERSION);
  w.varintU(generation);
  w.varintU(gestureId);
  const head = w.finish();
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * Encode a GridCommand to the IDENTICAL postcard bytes `input_apply.rs` (08-06)
 * decodes — the discriminant order is Place=0, Delete=1, Rotate=2, DrawBelt=3,
 * matching the Rust enum declaration order AFTER the 17-02 `Wire` removal (the
 * byte-forced renumber; cross-language gridcommand.bin re-frozen in 17-06).
 */
export function encodeGridCommand(cmd: GridCommand): Uint8Array {
  const w = new PostcardWriter();
  switch (cmd.kind) {
    case 'Place':
      w.varintU(0);
      w.u8(cmd.kind_byte);
      w.varintI(cmd.cell_x);
      w.varintI(cmd.cell_y);
      break;
    case 'Delete':
      w.varintU(1);
      w.varintU(cmd.node);
      break;
    case 'Rotate':
      w.varintU(2);
      w.varintU(cmd.node);
      w.u8(cmd.ccw ? 1 : 0);
      break;
    case 'DrawBelt':
      w.varintU(3);
      w.varintU(cmd.cells.length);
      for (const [cx, cy] of cmd.cells) {
        w.varintI(cx);
        w.varintI(cy);
      }
      break;
    // Encoder arm for the { kind: 'Dock' } union member above (discriminant 4).
    case 'Dock':
      w.varintU(4);
      w.varintU(cmd.belt);
      w.varintU(cmd.end === 'Head' ? 0 : 1); // BeltEnd disc: Head=0, Tail=1
      w.varintU(cmd.node);
      w.varintU(cmd.port); // SPATIAL catalog index verbatim; host owns translation
      break;
    // Fieldless: emit ONLY the discriminant (Undo=5, Redo=6). The host resolves
    // the undo/redo target from its own cursor — the encoder never carries an
    // action id.
    case 'Undo':
      w.varintU(5);
      break;
    case 'Redo':
      w.varintU(6);
      break;
    // AddPort (disc 7) — node as varintU (dense u64 handle), then role/side/medium
    // as single u8 bytes (postcard u8 == one raw byte, like Place's `kind`). Field
    // order is declaration order in the Rust variant: node, role, side, medium.
    case 'AddPort':
      w.varintU(7);
      w.varintU(cmd.node);
      w.u8(cmd.role); // In=0, Out=1, Fault=2
      w.u8(cmd.side); // N=0, E=1, S=2, W=3
      w.u8(cmd.medium); // Mechanical=0, Electrical=1
      break;
    // RemovePort (disc 8) — node as varintU, then index as varintU (u16 rides as a
    // varint on the wire, exactly like Dock's `port: u16`).
    case 'RemovePort':
      w.varintU(8);
      w.varintU(cmd.node);
      w.varintU(cmd.index);
      break;
    // Configure (disc 9) — node as varintU, then the nested MachineConfig tree.
    // NO code_hash on the wire (the host stamps blake3 in 39-04). The nested
    // discriminants mirror the frozen Rust variant order (edit.rs MachineConfig
    // / SourceTrigger, state.rs SinkTemplate / HttpMethod) and are pinned
    // byte-for-byte to configure-gridcommand.bin (39-03) by decode.test.ts:
    //   MachineConfig : Factory=0 {str source} / Source=1 {SourceTrigger}
    //                   / Sink=2 {SinkTemplate} / Belt=3 {varintU ticks_per_slot}
    //                   / Router=4 {vec[(RouteKey, varintU port)], Option<varintU>}
    //                   / Endpoint=5 {str path}
    //                   / Label=6 {str text, u8 colour, varintU w, varintU h}
    //   RouteKey      : varintU offset, varintU(len) + raw expect bytes
    //   SourceTrigger : Webhook=0 {} / Timer=1 {varintU interval_ticks}
    //   SinkTemplate  : Debug=0 {} / Http=1 {str url, u8 method}
    //   HttpMethod    : Get=0/Post=1/Put=2/Patch=3/Delete=4  (u8)
    //
    // This list is hand-transcribed PROSE and it is the THIRD copy of the fact:
    // fabrico_core::edit::MachineConfig is the byte truth, fabrico_protocol mirrors
    // it, and this encoder mirrors that. Since Phase 63 it is CHECKED rather than
    // merely written down, by two machines with different reach:
    //   - crates/fabrico-command/tests/machine_config_parity.rs holds the two RUST
    //     enums together, encoding an equivalent value on each side of all five
    //     variants and comparing the bytes plus the leading discriminant.
    //   - the configure-gridcommand.bin byte-parity case below holds THIS encoder
    //     to those bytes, across the language boundary, for every nested variant.
    // Appending to one enum and not the others is now a named test failure.
    case 'Configure': {
      w.varintU(9);
      w.varintU(cmd.node);
      const config = cmd.config;
      switch (config.kind) {
        case 'Factory':
          w.varintU(0);
          w.str(config.source);
          break;
        case 'Source': {
          w.varintU(1);
          const trigger = config.trigger;
          switch (trigger.kind) {
            case 'Webhook':
              w.varintU(0);
              break;
            case 'Timer':
              w.varintU(1);
              w.varintU(trigger.interval_ticks);
              break;
            default: {
              const _t: never = trigger;
              return _t;
            }
          }
          break;
        }
        case 'Sink': {
          w.varintU(2);
          const target = config.target;
          switch (target.kind) {
            case 'Debug':
              w.varintU(0);
              break;
            case 'Http':
              w.varintU(1);
              w.str(target.url);
              w.u8(target.method);
              break;
            default: {
              const _s: never = target;
              return _s;
            }
          }
          break;
        }
        // Belt (nested disc 3) — a plain varint interval. postcard encodes the
        // core's NonZeroU32 exactly as its inner u32, so this one varint is the
        // whole payload on both sides.
        case 'Belt':
          w.varintU(3);
          w.varintU(config.ticks_per_slot);
          break;
        // Router (nested disc 4) — the ORDERED routes table then the Option default.
        // A postcard Vec is varintU(len) then each element concatenated; a tuple is
        // its members concatenated with no framing; an Option is 0 for None or 1
        // followed by the value. RouteKey is a STRUCT, so its two fields ride
        // positionally with no discriminant: varintU(offset), then the byte vector
        // as varintU(len) + the raw bytes.
        case 'Router':
          w.varintU(4);
          w.varintU(config.routes.length);
          for (const [key, port] of config.routes) {
            w.varintU(key.offset);
            w.varintU(key.expect.length);
            for (const byte of key.expect) w.u8(byte);
            w.varintU(port);
          }
          if (config.default === null) {
            w.varintU(0);
          } else {
            w.varintU(1);
            w.varintU(config.default);
          }
          break;
        // Endpoint (nested disc 5, 72-07 / D-12) - the Route's address as a
        // postcard `String`: varintU(byte length) then the raw UTF-8, which is
        // exactly what `w.str` writes and exactly what the `Factory { source }`
        // arm above already does with the same shape.
        case 'Endpoint':
          w.varintU(5);
          w.str(config.path);
          break;
        // Label (nested disc 6, 76-02) - the struct's four fields positionally: the words
        // as a postcard `String` (byte length, then UTF-8), the colour as ONE byte (a
        // fieldless enum's declaration index on the core side, a plain u8 on the wire),
        // then width and depth as `u16` varints.
        case 'Label':
          w.varintU(6);
          w.str(config.text);
          w.u8(config.colour);
          w.varintU(config.w);
          w.varintU(config.h);
          break;
        default: {
          const _c: never = config;
          return _c;
        }
      }
      break;
    }
    // DrawWire (disc 10) — four fixed-size scalars in Rust declaration order:
    // from_node (u64 handle), from_port (u16), to_node, to_port. Every one rides as
    // a varintU, exactly like Dock's node/port.
    case 'DrawWire':
      w.varintU(10);
      w.varintU(cmd.from_node);
      w.varintU(cmd.from_port);
      w.varintU(cmd.to_node);
      w.varintU(cmd.to_port);
      break;
    // Unlink (disc 11) — the Dock field set exactly, because an unlink and the dock
    // that created the link name the SAME link from the same side: belt (u64
    // handle), endpoint (BeltEnd disc Head=0/Tail=1), node (u64 handle), port
    // (SPATIAL catalog index verbatim; the host owns the routing-key translation).
    case 'Unlink':
      w.varintU(11);
      w.varintU(cmd.belt);
      w.varintU(cmd.end === 'Head' ? 0 : 1);
      w.varintU(cmd.node);
      w.varintU(cmd.port);
      break;
    default: {
      // Compile-time union coverage (CTRL-04): every shipped GridCommand
      // variant MUST have an encoder arm above. If one is missing, `cmd` fails
      // to narrow to `never` here and tsc rejects the build — a missing arm is
      // a compile error, never a silent runtime gap.
      const _exhaustive: never = cmd;
      return _exhaustive;
    }
  }
  return w.finish();
}

/**
 * The RUN-PACE frame lead byte (D-68-16, route R1). ONE RAW BYTE, 254.
 *
 * It is a SENTINEL on the same gesture channel `encodeGridCommand` writes to, and
 * it cannot collide: `GridCommand`'s discriminants occupy 0..=11 (Place=0 through
 * Unlink=11 above), and `crates/fabrico-app/src/lib.rs`'s malformed-gesture test
 * already asserts that a lead byte of 255 is not a valid `GridCommand`
 * discriminant. 254 sits in the same unreachable band.
 */
export const BELT_RUN_PACE_LEAD = 0xfe;

/**
 * The most belts ONE run-pace frame may name (68-REVIEW WR-03).
 *
 * The FRONTEND MIRROR of `fabrico_host::sim_loop::MAX_RUN_PACE_BELTS`, and it is
 * a mirror rather than a second opinion: `crates/fabrico-host/tests/pace_scale_pin.rs`
 * parses this declaration out of this file and asserts it equals the Rust
 * constant, so the two cannot drift. Move either and that test reddens.
 *
 * # Why the client needs it at all
 * The host refuses an over-cap list with `CommandError::Malformed`
 * (`input_apply.rs`'s `apply_run_pace`, and `transport_ws.rs` refuses an
 * over-cap DECLARED count before postcard is asked to build the sequence). That
 * refusal reaches the user as "The host could not read that gesture." (since plan
 * 88-02; "The host could not carry out that gesture." before) - a sentence about the
 * frame, not the cause they could act on, for a gesture they had every reason to think
 * was ordinary. `beltRun` is bounded only by `scene.belts.size`, so a contiguous
 * chain past the cap is buildable. The client already knows the run length, so
 * it can decline to spend a gesture on a frame that cannot be accepted.
 *
 * Declared as a bare integer literal, terminated by `;`, because that is the only
 * shape the Rust-side parser certifies - it reads a literal and never evaluates
 * an expression.
 */
export const MAX_RUN_PACE_BELTS = 256;

/**
 * Encode ONE belt-run pace edit as a single sentinel-prefixed frame (D-68-16,
 * route R1): the frame `fabrico_host::sim_loop::GestureFrame::RunPace` decodes.
 *
 * # Why this is not a `GridCommand`
 * `fabrico-protocol` is FROZEN for phases 64-68, so `GridCommand` cannot gain a
 * twelfth variant. A run of N belts must nevertheless arrive as ONE frame, because
 * the host mints one action id per frame (`Host::enqueue_edit_with_new_action`) and
 * N frames would therefore be N `Ctrl+Z` steps (68-UI-SPEC FINDING 2). So the run
 * rides a sentinel-prefixed frame on the SAME channel, which is what lets it
 * inherit the Phase 64 sequence-numbering and refusal machinery unchanged.
 *
 * # The byte grammar, and the Rust type it mirrors
 * ```text
 * 0xFE                          ONE RAW BYTE (never varintU - see below)
 * varintU(belts.length)         postcard Vec<u64> length prefix
 * varintU(handle) x N           the belt render handles, in order
 * varintU(ticksPerSlot)         u32
 * ```
 * Everything after the sentinel is the postcard body of the Rust struct
 * `fabrico_host::sim_loop::BeltRunPace { belts: Vec<u64>, ticks_per_slot: u32 }`.
 * The two are findable from each other by name; neither may change alone.
 *
 * # The sentinel is `w.u8`, NEVER `w.varintU`
 * `varintU(0xFE)` LEB128-encodes to TWO bytes (`0xFE 0x01`), which would put a
 * stray `0x01` between the sentinel and the body. The host would then read that
 * `0x01` as the Vec length and the real length as the first handle - a decode that
 * fails looking exactly like a handle bug. `decode.test.ts` pins the encoded length
 * of a small one-belt frame at four bytes for this reason.
 */
export function encodeBeltRunPace(belts: number[], ticksPerSlot: number): Uint8Array {
  const w = new PostcardWriter();
  w.u8(BELT_RUN_PACE_LEAD);
  w.varintU(belts.length);
  for (const belt of belts) {
    w.varintU(belt);
  }
  w.varintU(ticksPerSlot);
  return w.finish();
}

// ---------------------------------------------------------------------------
// pre-placement machine CATALOG (CAT-05) — the single source the placement GHOST
// sizes itself from, replacing the hand-maintained per-kind dims table (deleted
// in 17-03). This is the frontend mirror of the core-authoritative catalog exported
// by fabrico-command::catalog_entry (17-01 Task 3, ts-rs `MachineCatalogEntry` /
// `CatalogPortView`), which is produced FROM the single-source `port_catalog`
// (crates/fabrico-command/src/command.rs). Kept inline (NOT imported from the
// gitignored bindings/, mirroring the decoder shapes above) and pinned honest by
// the cross-language catalog golden re-frozen in the 17-06 coordinated re-bless.
// Every entry is copied VERBATIM from `port_catalog`; never re-derive geometry.
// ---------------------------------------------------------------------------

/**
 * One port in a pre-placement catalog entry. Unlike {@link PortView} (a PLACED
 * node's rot-applied WORLD cell), a catalog port carries the ROT-0 FRAME
 * `local_offset` — a ghost has no anchor yet, so the frontend positions each nub
 * RELATIVE to the placement cursor and applies rotation itself. The pre-placement
 * sibling of {@link PortView}. Mirrors `fabrico_protocol::CatalogPortView`.
 */
export interface CatalogPortView {
  /** Port index in the kind's rot-0 port list (identity-stable). */
  index: number;
  /** Rot-0 frame local X offset (`0 <= x < w`). */
  local_x: number;
  /** Rot-0 frame local Y offset (`0 <= y < h`). */
  local_y: number;
  /** Cell edge the port faces in the rot-0 frame: N=0, E=1, S=2, W=3. */
  side: number;
  /** Port role: In=0, Out=1, Fault=2. */
  role: number;
  /**
   * Port transport medium: Mechanical=0, Electrical=1. Mirrors
   * `fabrico_protocol::port_medium` and `CatalogPortView::medium`, which has carried
   * this field on the Rust side since Phase 66.
   *
   * ADDED IN 72-05, and the reason is worth keeping. The medium is the one byte that
   * tells a mechanical Factory from an electrical Handler: `step_factory` reads the
   * DECLARED medium of port 0 to decide how a machine is serviced (D-16). It was
   * absent here purely because nothing in the frontend branched on it, and
   * `ts_catalog_mirror.rs` recorded exactly when that would stop being acceptable:
   * "the moment anything in the frontend branches on medium, this gap is real and
   * needs a different check". UI-SPEC 1.2 gives an electrical port a square nub, so
   * this is that moment, and the cross-language lock now compares this field.
   */
  medium: number;
}

/**
 * The authoritative pre-placement catalog entry for one machine kind (CAT-05):
 * the footprint dims + rot-0 port set the placement GHOST sizes itself from.
 * Mirrors `fabrico_protocol::MachineCatalogEntry`.
 */
export interface MachineCatalogEntry {
  /** Machine kind byte — see `machine_kind`. */
  kind: number;
  /** Rot-0 footprint width. */
  w: number;
  /** Rot-0 footprint height. */
  h: number;
  /** Declared orientation — `0` for a fresh ghost (the frontend rotates the glyph). */
  rot: number;
  /** The rot-0 port set in port-index order (empty for a portless kind). */
  ports: CatalogPortView[];
}

/** Role bytes on the catalog wire (mirror `fabrico_protocol::port_role`). */
const CAT_IN = 0;
const CAT_OUT = 1;
const CAT_FAULT = 2;
/** Side bytes on the catalog wire (N=0, E=1, S=2, W=3). No catalog port faces N. */
const CAT_E = 1;
const CAT_S = 2;
const CAT_W = 3;
/** Medium bytes on the catalog wire (mirror `fabrico_protocol::port_medium`). */
const CAT_MECH = 0;
const CAT_ELEC = 1;

/**
 * Build one catalog port row.
 *
 * `medium` has NO DEFAULT, on purpose (72-05). A default is exactly how a row
 * acquires a medium nobody chose, and the whole reason the field exists is that an
 * unstated medium was invisible to every check in both languages for two phases.
 * Every row states its own, and the cross-language mirror
 * (`crates/fabrico-command/tests/ts_catalog_mirror.rs`) compares it.
 */
const cp = (
  index: number,
  local_x: number,
  local_y: number,
  side: number,
  role: number,
  medium: number,
): CatalogPortView => ({ index, local_x, local_y, side, role, medium });

/**
 * The frontend catalog table: a HAND-MAINTAINED mirror of the core `port_catalog`
 * (crates/fabrico-command/src/command.rs). Keys are `machine_kind` bytes. Input
 * nubs sit on the WEST edge, output nubs on the EAST edge; the FACTORY Fault port
 * is at array index 2 (S-center) so it sorts LAST under `(port_index asc)`.
 *
 * # EVERY ROW IS MACHINE-CHECKED AGAINST RUST (plan 85-02, GATE-06).
 * This used to be described as a VERBATIM mirror whose drift was caught by "the
 * cross-language catalog golden (17-06 re-bless)". There is no such golden. ts-rs
 * exports the catalog TYPES (`MachineCatalogEntry`, `CatalogPortView`, see
 * `crates/fabrico-protocol/tests/export_bindings.rs`) and no committed fixture pins
 * the catalog VALUES, so the only byte gates that exist cover `GridCommand`, the
 * render packet, `route` and `wire`. When 63-07 widened the Router's Out arity, every
 * Rust test stayed green while this table went on telling the placement ghost a Router
 * has one output. It was corrected by hand, which is exactly the maintenance cost the
 * word "verbatim" was hiding, and the reason this table now has a mirror test.
 *
 * `crates/fabrico-command/tests/ts_catalog_mirror.rs` closes that gap for EVERY row:
 * it embeds THIS FILE with `include_str!`, asserts the kinds this table has rows for equal
 * the kinds `kind_has_catalog_arm` admits (minus BELT) in both directions, and for every
 * one of them (LABEL by its own portless test) asserts the box and the port list equal
 * the matching `port_catalog(..)` value for value, port for port in index order,
 * panicking rather than passing if it cannot find what it parses. Until plan 85-02 only
 * ROUTER, ENDPOINT, SINK, HANDLER and LABEL were compared; SOURCE, FACTORY, TEE, BALANCER
 * and MERGE are now compared too. The table is still written by hand; a drift on either
 * side turns `cargo test` red naming the kind.
 *
 * SINCE 72-05 EVERY MIRRORED ROW IS ALSO WATCHED FOR `Medium`. This paragraph used to
 * read "NO row is watched for `Medium` - `cp()` cannot express one", which was true and
 * is not any more: `cp()` takes a sixth argument, `CatalogPortView` carries the field,
 * and the Rust comparison includes it. The change was not cosmetic. The medium is what
 * separates a mechanical Factory from an electrical Handler, and UI-SPEC 1.2 makes the
 * renderer branch on it, which is the precise condition the mirror's own header named as
 * the moment the gap would become a defect.
 *
 * BELT is intentionally absent — it is not a placeable machine (17-02 rejects
 * `Place{BELT}`); the palette arms DrawBelt-only draw mode instead.
 */
const MACHINE_CATALOG: Record<number, MachineCatalogEntry> = {
  [machine_kind.SOURCE]: { kind: machine_kind.SOURCE, w: 1, h: 1, rot: 0, ports: [cp(0, 0, 0, CAT_E, CAT_OUT, CAT_MECH)] },
  [machine_kind.FACTORY]: {
    kind: machine_kind.FACTORY,
    w: 3,
    h: 3,
    rot: 0,
    ports: [cp(0, 0, 1, CAT_W, CAT_IN, CAT_MECH), cp(1, 2, 1, CAT_E, CAT_OUT, CAT_MECH), cp(2, 1, 2, CAT_S, CAT_FAULT, CAT_MECH)],
  },
  [machine_kind.TEE]: {
    kind: machine_kind.TEE,
    w: 2,
    h: 2,
    rot: 0,
    ports: [cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH), cp(1, 1, 0, CAT_E, CAT_OUT, CAT_MECH), cp(2, 1, 1, CAT_E, CAT_OUT, CAT_MECH)],
  },
  [machine_kind.BALANCER]: {
    kind: machine_kind.BALANCER,
    w: 2,
    h: 2,
    rot: 0,
    ports: [
      cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH),
      cp(1, 0, 1, CAT_W, CAT_IN, CAT_MECH),
      cp(2, 1, 0, CAT_E, CAT_OUT, CAT_MECH),
      cp(3, 1, 1, CAT_E, CAT_OUT, CAT_MECH),
    ],
  },
  // ROUTER carries `ROUTER_OUT_ARITY` outputs since 63-07 / ROUTE-02, so a routing
  // table has somewhere to send a second branch. Index 0 is the In, indices 1..3 the
  // Outs, and a PortId is an index into this list, so the ORDER never moves.
  //
  // THE CELLS MOVED IN 74.1-14 (the ruling of 2026-10-04, "Edits keep middle
  // layout"): the In sits on the middle row, W@(0,1), and the Outs on rows 1, 2, 0 of the
  // E column, the slots the port-edit reseat rule gives a 3-long side, so a Router's
  // first port edit moves no nub. Until then the In sat at (0,0) and the Outs on rows
  // 2, 0, 1. Still hand-maintained, but no longer unwatched: ts_catalog_mirror.rs reddens
  // if this row and `port_catalog(ROUTER)` disagree (see the note above).
  //
  // Index 4 is the PILE-10 fault nub, `S@(0,2)`, appended LAST so it sorts last under
  // ROUTE-06 and re-points no existing dock. It is here because the placement ghost
  // previews a nub PER ROW: without it a user would place a Router, be told by every
  // other surface that it has a fault port, and find nothing to drag a belt onto.
  [machine_kind.ROUTER]: {
    kind: machine_kind.ROUTER,
    w: 2,
    h: 3,
    rot: 0,
    ports: [
      cp(0, 0, 1, CAT_W, CAT_IN, CAT_MECH),
      cp(1, 1, 1, CAT_E, CAT_OUT, CAT_MECH),
      cp(2, 1, 2, CAT_E, CAT_OUT, CAT_MECH),
      cp(3, 1, 0, CAT_E, CAT_OUT, CAT_MECH),
      cp(4, 0, 2, CAT_S, CAT_FAULT, CAT_MECH),
    ],
  },
  [machine_kind.MERGE]: {
    kind: machine_kind.MERGE,
    w: 2,
    h: 2,
    rot: 0,
    ports: [cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH), cp(1, 0, 1, CAT_W, CAT_IN, CAT_MECH), cp(2, 1, 0, CAT_E, CAT_OUT, CAT_MECH)],
  },
  // SINK gains the PILE-10 fault nub at index 1, `S@(0,0)`: BOTH nubs on the ONE 1x1
  // cell, the ENDPOINT row's precedent, so the box does NOT grow. In FIRST, per the Rust
  // invariant `port_catalog_every_kind_lists_in_ports_first`.
  //
  // It is on S and not E on measurement, and the losing candidate is recorded so it is
  // not re-tried: E has the better clearance and still loses, because every other kind
  // here puts its Out on E, so a fault nub there would read as the main line continuing
  // - which is exactly the wrong idea on a terminal.
  // Kept on ONE LINE deliberately, exactly like the ENDPOINT row below it. It is not a
  // formatting preference: `a_single_line_entry_is_bounded_at_its_own_brace_and_not_the_next_ones`
  // in ts_catalog_mirror.rs uses SOURCE and SINK as its two subjects, because the trap it
  // guards (a single-line entry's body running on into its neighbour) can only be proved
  // on a single-line entry that HAS a neighbour - and ENDPOINT, the other two-port
  // single-line row, is the LAST entry and therefore cannot prove it. Reflowing this row
  // to multiple lines removes one of the only two subjects that can fail.
  [machine_kind.SINK]: { kind: machine_kind.SINK, w: 1, h: 1, rot: 0, ports: [cp(0, 0, 0, CAT_W, CAT_IN, CAT_MECH), cp(1, 0, 0, CAT_S, CAT_FAULT, CAT_MECH)] },
  // ENDPOINT (66-03 / WIRE-03) - the host bridge, and the LAST row this table gained.
  // Both nubs sit on the ONE 1x1 cell, In facing W at index 0 and Out facing E at index
  // 1, exactly as SOURCE and SINK put their single port at (0,0). In FIRST, matching the
  // Rust invariant `port_catalog_every_kind_lists_in_ports_first`: a PortId is a raw
  // index into this list, so an Out declared before an In mis-keys every dock that
  // reaches a port by number.
  //
  // WITHOUT this row `catalogEntry(9)` fell through to the `ports: []` fallback below,
  // and the HTTP Endpoint would have been the one palette machine whose placement ghost
  // previewed no nubs at all - on the phase whose whole discoverability argument is that
  // you can see where the wire attaches.
  //
  // Still hand-maintained, but no longer unwatched: ts_catalog_mirror.rs reddens if this
  // row and `port_catalog(ENDPOINT)` disagree (see the note above). AND SINCE 72-05 THAT
  // INCLUDES THE MEDIUM: both of these ports are `Medium::Electrical` in Rust, the one
  // field that makes an endpoint an endpoint, and it was the field the mirror was
  // structurally blind to for two phases because `cp()` could not express one. It can
  // now, this row states it, and the Rust comparison checks it.
  [machine_kind.ENDPOINT]: { kind: machine_kind.ENDPOINT, w: 1, h: 1, rot: 0, ports: [cp(0, 0, 0, CAT_W, CAT_IN, CAT_ELEC), cp(1, 0, 0, CAT_E, CAT_OUT, CAT_ELEC)] },
  // HANDLER (72-05 / SERVE-03) - the HTTP Handler: user code a webhook reaches over a
  // wire. Mirrors `port_catalog(machine_kind::HANDLER)` row for row.
  //
  // IT STANDS ON THE FACTORY'S CHASSIS. The 3x3 box and all three `local_offset` values
  // are the FACTORY row's, unchanged: a Handler folds to a `Node::Factory` in the core
  // (D-11), so its nub clearances are the Factory's already-measured ones. Only the
  // MEDIUM on indices 0 and 1 differs, and that difference is the entire machine.
  //
  // ONE electrical Out, not three (D-02). That is load-bearing rather than merely
  // sufficient: with a single Out the command layer refuses a second Route's return
  // cable as `PortOccupied`, so this port list is what makes the one-request-one-reply
  // shape the only board a user can build. Do not widen it because it looks short.
  //
  // Index 0 is the electrical In, FIRST, per the Rust invariant
  // `port_catalog_every_kind_lists_in_ports_first`: a PortId is a raw index into this
  // list, and index 0 is the port `step_factory` drains, whose declared medium is the
  // discriminator the whole phase turns on.
  [machine_kind.HANDLER]: {
    kind: machine_kind.HANDLER,
    w: 3,
    h: 3,
    rot: 0,
    ports: [
      cp(0, 0, 1, CAT_W, CAT_IN, CAT_ELEC),
      cp(1, 2, 1, CAT_E, CAT_OUT, CAT_ELEC),
      cp(2, 1, 2, CAT_S, CAT_FAULT, CAT_MECH),
    ],
  },
  // LABEL (phase 76, SHAPE-10): a note on the board, placed 4 by 1 and carrying NO ports
  // (it does not connect, D-07). Mirrors `port_catalog(LABEL)`, locked by
  // `ts_catalog_mirror.rs` `the_frontend_label_entry_declares_the_catalog_box_and_no_ports`.
  // The ghost reads this box, so a placement preview is the label's real size.
  [machine_kind.LABEL]: { kind: machine_kind.LABEL, w: 4, h: 1, rot: 0, ports: [] },
};

/**
 * The kind bytes that HAVE a `MACHINE_CATALOG` row, ascending. This is the frontend's
 * own statement of which kinds can LAND on a board: a kind with a catalog entry has a
 * box and a port list, so the placement ghost can preview it and a Place can commit it.
 * A kind WITHOUT one falls through `catalogEntry`'s 1x1 portless fallback below.
 *
 * DERIVED from the table above with `Object.keys`, never restated. That is the whole
 * point of exporting it (plan 72-02 / SERVE-03): `machineVector.test.ts` uses it as the
 * subject list for the LOD totality guard, and a mirrored copy of these keys would stay
 * green exactly when the real table grew, which is the failure the guard exists to catch
 * one layer up. `machines.ts` fails that case SILENTLY - its LOD branch gates on
 * `genKey !== undefined || isEndpoint`, so a placeable kind in neither LOD table sets
 * `sprite.visible = false` and draws nothing at any zoom, with no error.
 *
 * Integer-like object keys enumerate in ascending numeric order, so the explicit sort is
 * belt-and-braces rather than load-bearing: it makes the order a stated property instead
 * of an inherited one.
 */
export const CATALOG_KINDS: readonly number[] = Object.keys(MACHINE_CATALOG)
  .map(Number)
  .sort((a, b) => a - b);

/**
 * The authoritative pre-placement {@link MachineCatalogEntry} for `kind` — the
 * ghost sizing surface (CAT-05). Mirrors `fabrico_command::catalog_entry`; the
 * placement ghost derives its footprint (and, where it previews nubs, its port
 * offsets) from THIS single source, never a hand-maintained `{w,h}` table. An
 * unknown/portless kind (e.g. BELT, which is not placeable) falls back to a 1x1
 * portless entry so a caller never crashes on a stray byte.
 */
export function catalogEntry(kind: number): MachineCatalogEntry {
  return MACHINE_CATALOG[kind] ?? { kind, w: 1, h: 1, rot: 0, ports: [] };
}
