import { expect, type Page, type WebSocketRoute } from '@playwright/test';

// support/wire.ts (21-08) - the ONE e2e mirror of the CURRENT wire grammar,
// shared by every packet-injecting spec so the injected-fixture encoding can
// never drift per-file again (the Phase-14-era per-spec builders went stale
// against the 16/17/19 wire growth: ports[], tiles[], docks[], trailing
// can_undo/can_redo, and the 17-02 GridCommand renumber).
//
// Encoding mirrors src/protocol/decode.ts EXACTLY:
//   RenderPacket: tick(varintU), full(u8), placed[], removed[], belts[],
//                 can_undo(u8), can_redo(u8), wires[] (appended LAST, WUI-01)
//   NodeView:     id, kind(u8), cell_x(varintI), cell_y(varintI), state(u8),
//                 w(varintU), h(varintU), rot(u8), ports[],
//                 load(u8) (appended LAST after ports, 71-05)
//   PortView:     index(varintU), cell_x(varintI), cell_y(varintI), side(u8), role(u8),
//                 medium(u8) (appended LAST on the wire, 35-03)
//   BeltView:     id, latency(varintU), fill(varintU), items[], tiles[], docks[],
//                 ticks_per_slot(varintU) (appended LAST, SLOT-03 Phase 62)
//   TileView:     cell_x(varintI), cell_y(varintI), disc(varintU), payload
//   BeltDockView: end disc(varintU: Head=0/Tail=1), node(varintU), port(varintU)
//
// GridCommand discriminants (post 17-02 Wire removal, the CURRENT numbering):
//   Place=0, Delete=1, Rotate=2, DrawBelt=3, Dock=4, Undo=5, Redo=6.

// Grid geometry is owned by the ONE shared values source (23-04, GATE-01) and
// re-exported here under the mock suite's historical names so every existing
// spec call site keeps working unchanged. `cellCentrePt` is the mock suite's
// 2-arg point form, re-exported as `cellCentre`.
export {
  CELL,
  cellCentrePt as cellCentre,
  nubAnchor,
  rotateHandle,
} from '../../shared/geometry';

import { cellCentrePt } from '../../shared/geometry';

// The refusal frame's `kind` discriminator, IMPORTED from the production transport
// module rather than retyped as a string literal here (T-64-09-01). The mock suite
// hand-implements the dev-WebSocket grammar, so a retyped literal is a second source
// of truth for a wire word: rename it on the host and in `transport.ts` and this file
// would keep speaking the old grammar, green, certifying behaviour the host no longer
// produces.
//
// IMPORTING PRODUCTION CODE IS LEGAL HERE AND ONLY HERE. The zero-mock rule that
// forbids it applies to the LIVE oracle (`e2e-live/support/oracle.ts`), whose whole
// value is that it shares nothing with the app it audits. This file is the MOCK - it
// IS a stand-in for the host, so sharing the host's constant is the point. The live
// refusal leg asserts rendered DOM text and never names the frame, so it never needs
// this constant.
import {
  GESTURE_ACCEPT_KIND,
  GESTURE_REFUSAL_KIND,
  type RefusalTag,
} from '../../src/transport/transport';
// The version byte every gesture frame starts with (security T-88-09), the page's own
// constant, re-exported for the specs that read a sent frame's header by hand. A frame
// that does not start with it is one the host refuses as unreadable.
import { GESTURE_FRAME_VERSION } from '../../src/protocol/decode';
import { machine_kind } from '../../src/protocol/kinds';
export { GESTURE_FRAME_VERSION };

// ---------------------------------------------------------------------------
// Camera-aware world->screen transform (NAV-01)
// ---------------------------------------------------------------------------
//
// The re-exported geometry above is identity-camera world px. The app can boot
// under a non-identity camera (29-04 fit-to-factory), so every gesture-driving
// coordinate routes through window.__fabrico.camera() here. The transform is the
// separable, rotation-free map screen = world*scale + pan per axis (RESEARCH
// Finding 4). shared/geometry.ts stays pure; the multiply lives only here. This
// mirrors e2e-live/support/oracle.ts but is a SEPARATE copy on purpose - the two
// suites never share a Playwright helper (the live suite's zero-mock audit).

/** The read-only pan+zoom snapshot window.__fabrico.camera() returns. */
export interface CameraSnapshot {
  /** Pan X (root Container position, px). */
  x: number;
  /** Pan Y (root Container position, px). */
  y: number;
  /** Uniform zoom (container.scale). */
  scale: number;
}

/**
 * Read window.__fabrico.camera() - the fresh read-only {x,y,scale} pan+zoom
 * snapshot. Throws a clear error if the getter is absent.
 */
export async function cameraOf(page: Page): Promise<CameraSnapshot> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { camera?(): unknown } }).__fabrico;
    if (!hook || typeof hook.camera !== 'function') {
      throw new Error('window.__fabrico.camera() not installed');
    }
    return hook.camera() as CameraSnapshot;
  });
}

/**
 * Read window.__fabrico.alertRingsActive() - are the CONNECT-02 stranded-dock
 * alert rings actually PAINTED right now? (67-REVIEW WR-05.)
 *
 * The scene model cannot answer this: a build whose `showAlertRings` regressed
 * while `setStrandedRings` still fired leaves `beltDockCount()` reading 0 and the
 * ring pressable over a canvas that drew nothing. This is a read of the SAME
 * `alertBornMs` the paint, the pulse/settle clock and the gesture layer's hit
 * test are all driven from, so it cannot report a ring the user cannot see.
 */
export async function alertRingsPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { alertRingsActive?(): boolean } }).__fabrico;
    if (!hook || typeof hook.alertRingsActive !== 'function') {
      throw new Error('window.__fabrico.alertRingsActive() not installed');
    }
    return hook.alertRingsActive();
  });
}

/** Apply a camera snapshot to a world point: screen = world*scale + pan (per axis). */
function applyCamera(cam: CameraSnapshot, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

/**
 * The live SCREEN point of world cell (cx, cy)'s centre: the identity cell centre
 * transformed through the current camera. Under the identity boot camera this is
 * exactly cellCentre(cx, cy).
 */
export async function screenCellCentre(
  page: Page,
  cx: number,
  cy: number,
): Promise<{ x: number; y: number }> {
  const cam = await cameraOf(page);
  const w = cellCentrePt(cx, cy);
  return applyCamera(cam, w.x, w.y);
}

/**
 * Transform an existing world point (a nubAnchor / rotateHandle output, already
 * identity-camera world px) to the live screen point through the current camera.
 */
export async function screenPoint(
  page: Page,
  worldPt: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const cam = await cameraOf(page);
  return applyCamera(cam, worldPt.x, worldPt.y);
}

/** The dev render socket the browser transport opens (devWebSocket.ts). */
export const WS_URL = 'ws://127.0.0.1:8787/render';

/** GridCommand wire discriminants (src/protocol/decode.ts encodeGridCommand). */
export const CMD = {
  Place: 0,
  Delete: 1,
  Rotate: 2,
  DrawBelt: 3,
  Dock: 4,
  Undo: 5,
  Redo: 6,
  // Appended LAST after Redo (PORT-06/07, Phase 36) so every prior discriminant
  // stayed byte-unchanged. Driven from the config panel's I/O section since 51-03.
  AddPort: 7,
  RemovePort: 8,
  Configure: 9,
  // Appended LAST after Configure (WIRE-01/WIRE-02 + CONNECT-01, Phase 63) for the
  // identical reason the AddPort/RemovePort pair was appended after Redo: every
  // prior discriminant stays byte-unchanged, so `golden_gridcommand.bin` and the
  // cmd-wire version are untouched by the growth. `Unlink` is driven from the
  // config panel's Disconnect control since 67-02.
  DrawWire: 10,
  Unlink: 11,
} as const;

/** Append-only postcard writer mirroring src/protocol/decode.ts PostcardWriter. */
export class PostcardWriter {
  private readonly bytes: number[] = [];

  u8(v: number): this {
    this.bytes.push(v & 0xff);
    return this;
  }

  /** LEB128 unsigned varint. */
  varintU(v: number): this {
    let n = v;
    while (n >= 0x80) {
      this.bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    this.bytes.push(n & 0x7f);
    return this;
  }

  /** zigzag-then-LEB128 signed varint (i32 range). */
  varintI(v: number): this {
    const zz = ((v << 1) ^ (v >> 31)) >>> 0;
    return this.varintU(zz);
  }

  /** A postcard `String`: varint BYTE length, then the UTF-8 bytes (phase 76). */
  str(v: string): this {
    const utf8 = new TextEncoder().encode(v);
    this.varintU(utf8.length);
    for (const b of utf8) this.bytes.push(b);
    return this;
  }

  finish(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/** One host-resolved port on an injected node (mirrors PortView). */
export interface InjectPort {
  index: number;
  cell_x: number;
  cell_y: number;
  /** N=0, E=1, S=2, W=3 (rot-applied world side). */
  side: number;
  /** In=0, Out=1, Fault=2. */
  role: number;
  /** Mechanical=0, Electrical=1 (appended LAST on the wire, 35-03). Defaults
   *  to 0 (Mechanical) - the medium every belt-docking fixture wants. */
  medium?: number;
}

export interface InjectNode {
  id: number;
  kind: number;
  cell_x: number;
  cell_y: number;
  /** Visual state (state_tag) - 2 = faulted. Defaults to 0 (idle). */
  state?: number;
  /** Footprint width (rot-0). Defaults to 1. */
  w?: number;
  /** Footprint height (rot-0). Defaults to 1. */
  h?: number;
  /** Orientation: 90deg CW quarter-turns 0..3. Defaults to 0. */
  rot?: number;
  /** Host-resolved world ports. Defaults to [] (a portless fixture node). */
  ports?: InjectPort[];
  /**
   * The PILE-08 load-gauge level 0..4, appended LAST on the wire AFTER `ports`
   * (71-05). Defaults to 0 (empty inbox), the state every pre-71 fixture was
   * implicitly asserting. The BYTE IS ALWAYS WRITTEN - see the write site.
   */
  load?: number;
  /**
   * A label's words and colour byte (phase 76, plan 76-02), appended LAST on the wire
   * AFTER `load` as a postcard `Option`. Omitted or null writes `None` (one 0 byte); the
   * OPTION TAG IS ALWAYS WRITTEN - see the write site.
   */
  label?: { text: string; colour: number } | null;
}

/** One per-end dock on an injected belt (mirrors BeltDockView). */
export interface InjectDock {
  end: 'Head' | 'Tail';
  node: number;
  /** Wire port keyspace value (catalog index / Out routing key / 65535 fault). */
  port: number;
}

export interface InjectBelt {
  id: number;
  /** Straight orthogonal tile path (Tail = first cell, Head = last cell). */
  tiles: [number, number][];
  /** Number of items currently on the belt - drives the snapshot count. They sit at
   *  slots 0..n-1, packed from the HEAD (slot 0, the delivery end), which is what a
   *  belt whose head cannot deliver looks like on the wire. */
  itemCount?: number;
  /**
   * The exact slot index of every item, ascending (phase 91, CHROME-13). Overrides
   * `itemCount` when set. On the wire `ItemView.arrival_tick` IS the slot index and
   * slot 0 is the head, so this is how a mock board shows a belt that is FLOWING
   * (items behind an empty head slot) rather than one packed from its head, which the
   * port rows read as `backed up` when the head docks nowhere.
   */
  itemSlots?: number[];
  /** Per-end docks. Defaults to [] (undocked). */
  docks?: InjectDock[];
  latency?: number;
  /**
   * Sim ticks per slot advance (SLOT-03, Phase 62). Defaults to the SHIPPED value
   * of 2 (`fabrico-core::belt_slots::DEFAULT_TICKS_PER_SLOT`), never to 1 - a mock
   * board must move at the pace the real board moves, or every pace assertion made
   * against it is measuring something that does not ship.
   */
  ticksPerSlot?: number;
}

/** One electrical wire endpoint on an injected wire (mirrors WireDockView).
 *  `port` is a RAW POSITIONAL PortId - a wire endpoint is a fourth keyspace and
 *  is NOT the belt dock's Out routing key. It indexes the node's declared port
 *  list directly, which is the same number `PortView.index` carries. */
export interface InjectWireEnd {
  node: number;
  port: number;
}

/** One injected wire (mirrors WireView, appended LAST on the packet). */
export interface InjectWire {
  id: number;
  from: InjectWireEnd;
  to: InjectWireEnd;
  /** Straight orthogonal cell path, encoded exactly like belt tiles. Defaults to
   *  [] - a pathless wire still decodes and still docks both endpoints, which is
   *  all a panel fixture needs. */
  path?: [number, number][];
  /**
   * In-flight pulses (mirrors WirePulseView: entry_tick, hop_ticks, direction). Defaults
   * to [], an idle cable. Plan 75-06 added it so a spec can re-send a wire whose PULSES
   * changed and whose path did not, which is what the host does on every comet.
   */
  pulses?: { entry_tick: number; hop_ticks: number; direction: number }[];
}

export interface PacketOpts {
  tick?: number;
  full?: boolean;
  nodes?: InjectNode[];
  removed?: number[];
  belts?: InjectBelt[];
  canUndo?: boolean;
  canRedo?: boolean;
  /** Appended-LAST wires vec (WUI-01). Omitted = an explicit EMPTY vec, never a
   *  truncated tail - see the write site in `buildPacket`. */
  wires?: InjectWire[];
  /**
   * The `resync` byte (73-12), after `wires`. Omitted = `false`, the restructure reading
   * every producer packet carries; `true` is a transport's lag resync of the current
   * keyframe. Plan 74.1-35 added it so a spec can tell the two keyframes apart. Written on
   * EVERY packet since plan 88-03 (the decoder's tail is strict).
   */
  resync?: boolean;
  /**
   * The board generation (phase 88, D-02), appended LAST after `resync`. Omitted = 0, a
   * fresh host's first handle table. A spec that injects the keyframe a host Undo, Redo,
   * Load or New would send names the generation that reset produced.
   */
  generation?: number;
  /**
   * The swap floor (phase 88 security, T-88-11), appended LAST after `generation`. Omitted =
   * 0, no swap yet. A spec that injects a Load's keyframe names its generation here too.
   */
  swapFloor?: number;
}

/**
 * Write a `Vec<TileView>` as Straight tiles, deriving each tile's axis from the
 * path direction. Fixtures use straight runs only - a turning path THROWS, so a
 * fixture can never silently encode a wrong-geometry corner.
 *
 * ONE writer for belt tiles and wire paths alike, because the decoder has one
 * reader for both (`readWireView`'s `path` reuses `readTileView`, decode.ts:422).
 * A second copy here is exactly the per-file drift this module's header exists to
 * prevent.
 */
function writeTiles(w: PostcardWriter, tiles: [number, number][]): void {
  w.varintU(tiles.length);
  for (let i = 0; i < tiles.length; i++) {
    const [cx, cy] = tiles[i];
    const [nx, ny] = tiles[i + 1] ?? tiles[i - 1] ?? [cx + 1, cy];
    if (nx !== cx && ny !== cy) {
      throw new Error('wire.ts fixture paths must be straight orthogonal runs');
    }
    const axis = ny === cy ? 0 : 1; // X=0, Y=1
    w.varintI(cx).varintI(cy).varintU(0).u8(axis); // disc 0 = Straight
  }
}

/**
 * Build one render-packet in the CURRENT decodeRenderPacket field order. Belt
 * tiles are written as Straight tiles with the axis derived from the path
 * direction (fixtures use straight runs only - a turning path throws so a
 * fixture can never silently encode a wrong-geometry corner).
 */
export function buildPacket(opts: PacketOpts): Buffer {
  const w = new PostcardWriter();
  w.varintU(opts.tick ?? 1); // tick
  w.u8(opts.full === false ? 0 : 1); // full (default true)

  const nodes = opts.nodes ?? [];
  w.varintU(nodes.length); // placed Vec length
  for (const n of nodes) {
    w.varintU(n.id).u8(n.kind).varintI(n.cell_x).varintI(n.cell_y).u8(n.state ?? 0);
    w.varintU(n.w ?? 1).varintU(n.h ?? 1).u8(n.rot ?? 0);
    const ports = n.ports ?? [];
    w.varintU(ports.length);
    for (const p of ports) {
      // medium was appended LAST on the wire (35-03); omitting it underruns the
      // decoder's ports vec and silently drops the whole packet (empty scene).
      w.varintU(p.index).varintI(p.cell_x).varintI(p.cell_y).u8(p.side).u8(p.role).u8(p.medium ?? 0);
    }
    // NodeView's LAST field (PILE-08, appended by 71-05 AFTER `ports`). Written
    // UNCONDITIONALLY, defaulted rather than omitted, for the same reason `medium`
    // and `ticks_per_slot` above are.
    //
    // THIS IS THE THIRD TIME THIS FILE HAS LOST AN APPENDED-LAST FIELD, and the
    // first on a NODE. A node-side omission is worse than the Phase 62 belt-side one:
    // `readNodeView` ends inside the top-level `placed` vec, so the stray byte is fed
    // to the NEXT node's `id` varint, and on a one-node packet `load` eats the
    // `removed` vec length, `removed` eats the belt count, and the whole packet
    // underruns into the top-level degrade path. The scene lands EMPTY - no throw the
    // page can show - so 45 mock specs failed minutes later on their readiness wait (then
    // the old readout's machine count, now `waitForBoard`'s model count) pointing at the
    // chrome instead of at this line.
    //
    // It survived because `frontend/tsconfig.json`'s `include` omits `e2e/` (tsc never
    // reads this file) AND because `mockWireRoundTrip.test.ts`, the pin written for
    // exactly this defect class, built ZERO NODES in all three of its cases. That pin
    // now frames a multi-node packet; it is what reddens if the NEXT field is missed.
    w.u8(n.load ?? 0);
    // NodeView's NEW last field (phase 76, plan 76-02, appended AFTER `load`): the
    // label's `Option<LabelView>`. Written UNCONDITIONALLY for the reason the `load`
    // paragraph above gives: an omitted option tag is fed to the next node's `id` and the
    // mock scene lands empty. `0` for None, or `1` then the text (byte length + UTF-8)
    // and the colour byte, exactly `decode.ts`'s `readLabel`.
    if (n.label) {
      w.u8(1).str(n.label.text).u8(n.label.colour);
    } else {
      w.u8(0);
    }
  }

  const removed = opts.removed ?? [];
  w.varintU(removed.length);
  for (const handle of removed) {
    w.varintU(handle);
  }

  const belts = opts.belts ?? [];
  w.varintU(belts.length);
  for (const b of belts) {
    w.varintU(b.id).varintU(b.latency ?? 8).varintU(0); // id, latency, fill
    const slots = b.itemSlots ?? Array.from({ length: b.itemCount ?? 0 }, (_, i) => i);
    w.varintU(slots.length);
    for (const slot of slots) {
      w.varintU(slot).u8(0); // ItemView{ arrival_tick (the slot index), tag }
    }
    writeTiles(w, b.tiles);
    const docks = b.docks ?? [];
    w.varintU(docks.length);
    for (const d of docks) {
      w.varintU(d.end === 'Head' ? 0 : 1).varintU(d.node).varintU(d.port);
    }
    // BeltView's LAST field (SLOT-03, appended by Phase 62). `readBeltView` reads it
    // STRICTLY - it is nested inside an r.vec(), where a short read means a truncated
    // packet, so it does not take the top-level degrade path.
    //
    // THIS LINE WAS MISSING FOR THE WHOLE OF PHASE 62 AND NOTHING CAUGHT IT. Every
    // field after `docks` shifted by one: ticks_per_slot ate the canUndo byte,
    // can_undo ate canRedo, can_redo ate the wires-vec length, and the wires vec then
    // underran into the top-level degrade path and silently became []. No throw, and
    // 186 mock specs stayed green over a misparsed packet. It was invisible to the
    // compiler-driven enumeration that found the other fourteen sites because
    // `frontend/tsconfig.json`'s `include` omits `e2e/`, so tsc never reads this file.
    // Pinned by `roundTrip.test.ts` - a decode assertion, not a byte count.
    w.varintU(b.ticksPerSlot ?? 2);
  }

  // Trailing undo/redo availability - MANDATORY on the wire (19-08 IN-01): a
  // packet missing these underruns the decoder and the fixture never lands.
  w.u8(opts.canUndo ? 1 : 0);
  w.u8(opts.canRedo ? 1 : 0);
  // Appended-LAST wires vec (WUI-01, Phase 40). When no wires are supplied this
  // still writes an explicit EMPTY vec so fixture packets are WELL-FORMED, not
  // merely tolerated by the decoder's truncated-wires-tail degrade path (which
  // would silently mask the NEXT field appended after wires, exactly the way the
  // missing medium byte broke 35-03). That write is kept, not replaced.
  //
  // WireView field order (readWireView, decode.ts): id, from(node,port),
  // to(node,port), path(Vec<TileView>), pulses(Vec<WirePulseView>).
  const wires = opts.wires ?? [];
  w.varintU(wires.length);
  for (const wire of wires) {
    w.varintU(wire.id);
    w.varintU(wire.from.node).varintU(wire.from.port);
    w.varintU(wire.to.node).varintU(wire.to.port);
    writeTiles(w, wire.path ?? []);
    // pulses: an idle cable carries none. Written as an explicit empty vec for
    // the identical reason the wires vec itself is.
    const pulses = wire.pulses ?? [];
    w.varintU(pulses.length);
    for (const p of pulses) {
      w.varintU(p.entry_tick).varintU(p.hop_ticks).u8(p.direction);
    }
  }
  // `resync` (73-12) and `generation` (phase 88, D-02), the two fields after `wires`, are
  // written UNCONDITIONALLY, defaulted rather than omitted. Since plan 88-03 the decoder
  // reads the packet tail strictly, so a packet without either is truncated and fails to
  // decode; until then `resync` was written only when a fixture named it and the tail
  // degraded to `false`. A fixture that names a generation is a board after that many
  // resets; the default 0 is a fresh host's first handle table.
  w.u8(opts.resync ? 1 : 0);
  w.varintU(opts.generation ?? 0);
  w.varintU(opts.swapFloor ?? 0);
  return w.finish();
}

export interface Harness {
  /**
   * The BODIES of the binary gesture frames the page emitted, in order: each frame with its
   * phase 88 header (version byte, generation, gesture id) stripped, so `sent[i][0]` is still the
   * `GridCommand` discriminant (or the run-pace lead) every spec reads. A frame whose
   * header does not read is kept whole, beside a `null` header.
   */
  sent: Buffer[];
  /**
   * The phase 88 header of each frame in `sent`, at the same index: the board generation
   * the page stamped and its own gesture id (D-02, D-06), read after the version byte
   * (T-88-09). `null` for a frame whose header did not read.
   */
  sentHeaders: Array<GestureHeader | null>;
  /**
   * Control TEXT frames the page emitted, in order (devWebSocket.ts encodeControl
   * grammar: `pause`/`resume`/`step`/`new`/`load_demo`, and `save\n<path>` /
   * `load\n<path>`). Config-query frames (`query\n...`) are NOT recorded here; they
   * are routed to `answerQuery`. Lets a spec assert which control a guard outcome
   * dispatched (SAVE-05 discard-guard routing).
   */
  controls: string[];
  /** Resolves once the page has opened the render socket. */
  connected: Promise<void>;
  /** Push a server→page render-packet (e.g. to inject fixture nodes/belts). */
  inject: (packet: Buffer) => void;
  /**
   * Push a server→page TEXT frame, as the host writes a verdict: for a spec that answers a
   * gesture LATER than its frame arrived (a paused board's drain), which `answerGesture`
   * cannot do because it answers at receipt.
   */
  injectText: (frame: string) => void;
}

/** The two fields every gesture frame starts with since phase 88 (D-02, D-06). */
export interface GestureHeader {
  /** The board generation of the packet the gesture's handles were read from. */
  generation: number;
  /** The page's own id for the gesture; the host's verdict names it back as `seq`. */
  gestureId: number;
}

/**
 * Split one page->host binary frame into its header and body: the version byte, two LEB128
 * varints, then the body `encodeGridCommand` or `encodeBeltRunPace` wrote, byte for byte.
 * The mock's copy of the host's header read (`fabrico_host::transport_ws::decode_gesture`),
 * taken in ONE place so no spec reads a header byte as a command. A frame whose header does
 * not read (empty, no version byte, cut short, or a varint over ten bytes) comes back whole
 * with a `null` header.
 */
export function splitGestureHeader(frame: Buffer): { header: GestureHeader | null; body: Buffer } {
  if (frame.length === 0 || frame[0] !== GESTURE_FRAME_VERSION) return { header: null, body: frame };
  let at = 1;
  const field = (): number | null => {
    let value = 0;
    for (let i = 0; i < 10 && at < frame.length; i++) {
      const b = frame[at++];
      value += (b & 0x7f) * 2 ** (7 * i);
      if ((b & 0x80) === 0) return value;
    }
    return null;
  };
  const generation = field();
  const gestureId = generation === null ? null : field();
  if (generation === null || gestureId === null) return { header: null, body: frame };
  return { header: { generation, gestureId }, body: frame.subarray(at) };
}

/** The dev-WS config-query TEXT-frame prefix (src/transport/devWsInvoke.ts
 *  DEV_WS_QUERY_PREFIX). A page-side `devWsInvoke` request rides the SAME dev
 *  render socket as `query\n{reqId,verb,args}`. */
const QUERY_PREFIX = 'query\n';

/**
 * The marker an [`MockSocketOpts.answerGesture`] callback returns to say the host
 * ACCEPTED the gesture. It is a distinct word rather than `undefined` so a spec can
 * state an accept DELIBERATELY - `undefined` means "this callback had no opinion about
 * this frame", and the two read identically at the call site while meaning different
 * things to the reader.
 *
 * Since phase 88 (plan 88-03, D-06) the host ANSWERS every accepted gesture with a
 * `gestureAccepted` frame naming the handles it minted, so this sends one, with generation 0
 * and an EMPTY `minted` list (a spec that needs handles named returns a
 * [`GestureAcceptOverride`]). `undefined` still sends NOTHING: a callback with no opinion is
 * a verdict that never arrived. What stays silent is the USER-facing side: an accept shows
 * no sentence, which `e2e/gesture-verdict.spec.ts` asserts.
 */
export const GESTURE_ACCEPTED = 'accepted';

/**
 * An accept naming the handles the gesture minted (phase 88, D-06), as the host sends it
 * after the tick that folded the gesture: `minted` in fold order, in the handle table of
 * `generation` (default 0, a fresh host's first table).
 */
export interface GestureAcceptOverride {
  accept: number[];
  generation?: number;
}

/**
 * A refusal whose `cmd` / `node` the spec states itself instead of taking them off the
 * frame (plan 74.1-28). It exists for the NEGATIVE legs: a refusal that names a
 * different node, or a command that is not a port edit, must leave the panel's latch in
 * place, and the only way to put such a refusal on the wire against a port-edit press is
 * to say so. `null` omits the field, the shape the host writes for an undecodable frame.
 */
export interface RefusalOverride {
  tag: RefusalTag;
  cmd: string | null;
  node: number | null;
}

/** What an [`MockSocketOpts.answerGesture`] callback may return. */
export type GestureAnswer =
  | RefusalTag
  | RefusalOverride
  | GestureAcceptOverride
  | typeof GESTURE_ACCEPTED
  | undefined;

/** Postcard discriminant -> the variant name the host's `GestureFrame::subject` writes. */
const CMD_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(CMD).map(([name, disc]) => [disc, name]),
);

/** The command variants whose FIRST field is the one node handle they name. Mirrors
 *  `GestureFrame::subject` in `crates/fabrico-host/src/sim_loop.rs`. */
const ONE_NODE_CMDS: ReadonlySet<number> = new Set([
  CMD.Delete,
  CMD.Rotate,
  CMD.AddPort,
  CMD.RemovePort,
  CMD.Configure,
]);

/** The run-pace frame's raw lead byte (`BELT_RUN_PACE_LEAD`). */
const RUN_PACE_LEAD = 0xfe;

/**
 * What the host's refusal frame says about the gesture it refuses (plan 74.1-28):
 * the command's variant name and, for a command naming one node, that node's handle.
 * The MOCK's copy of `GestureFrame::subject`, read off the raw postcard bytes: a
 * varint discriminant, then (for a one-node command) the node handle as a varint.
 * An empty or unknown frame names nothing, as the host's undecodable arm does.
 */
export function gestureSubject(frame: Buffer): { cmd?: string; node?: number } {
  if (frame.length === 0) return {};
  if (frame[0] === RUN_PACE_LEAD) return { cmd: 'RunPace' };
  const disc = frame[0];
  const cmd = CMD_NAMES[disc];
  if (cmd === undefined) return {};
  if (!ONE_NODE_CMDS.has(disc)) return { cmd };
  let node = 0;
  let shift = 1;
  for (let i = 1; i < frame.length; i++) {
    const b = frame[i];
    node += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) return { cmd, node };
    shift *= 128;
  }
  return {};
}

/** Options for `mockRenderSocket` - every member optional and defaulted, so all
 *  existing call sites compile and behave unchanged. */
export interface MockSocketOpts {
  /** Answer a dev-WS `query\n{reqId,verb,args}` TEXT frame (the devWsInvoke.ts
   *  grammar). Return a value to reply `{reqId, ok: true, value}` (routed back
   *  through `resolveDevWsReply` on the page); return undefined to ignore the
   *  frame - its promise stays pending, which only gates the UI awaiting it. */
  answerQuery?: (verb: string, args: Record<string, unknown>) => unknown | undefined;
  /**
   * Answer a page→server BINARY gesture frame the way the host answers it
   * (`crates/fabrico-host/src/transport_ws.rs::service_gesture`).
   *
   * Called with the frame's BODY (its phase 88 header stripped, see
   * [`splitGestureHeader`]) and the gesture id the page put in that header, which is the
   * `seq` the host's verdict carries. Return a
   * [`RefusalTag`] to refuse it - the harness sends the discriminated
   * `{kind, seq, tag, cmd?, node?}` TEXT frame the host emits (the last two read off
   * the frame by [`gestureSubject`], or stated by a [`RefusalOverride`]), which
   * `resolveGestureVerdict` on the page routes to the verdict sink. Return
   * [`GESTURE_ACCEPTED`] and the harness sends the host's `gestureAccepted` frame with an
   * empty `minted` list; return a [`GestureAcceptOverride`] to name the minted handles.
   * Return `undefined` and the harness sends NOTHING AT ALL, a verdict that never arrived.
   *
   * THE USER-FACING SILENCE ON AN ACCEPT IS THE LOAD-BEARING PART (phase 88 moved it from
   * the wire to the screen). The host now writes a frame for every accept; what must stay
   * empty is the refusal region, and the criterion-4 proof asserts exactly that: an
   * implementation that wrote a sentence for an accept would show text here, and the spec
   * asserting the region stays empty catches it.
   *
   * Since phase 88 the sequence is the PAGE's: the host no longer counts frames, it
   * echoes the gesture id each frame's header names (D-06). A frame whose header does not
   * read never reaches this callback: the harness answers it as the host does, inline,
   * `Malformed` with no `seq`.
   */
  answerGesture?: (frame: Buffer, seq: number) => GestureAnswer;
}

/**
 * Mock the render WebSocket BEFORE navigation: capture every page→server binary
 * frame and expose a server→page inject. Must be called before `page.goto`.
 */
export async function mockRenderSocket(page: Page, opts: MockSocketOpts = {}): Promise<Harness> {
  const sent: Buffer[] = [];
  const sentHeaders: Array<GestureHeader | null> = [];
  const controls: string[] = [];
  let route: WebSocketRoute | undefined;
  let resolveConn!: () => void;
  const connected = new Promise<void>((r) => (resolveConn = r));

  await page.routeWebSocket(WS_URL, (ws) => {
    route = ws;
    // Pure mock (no connectToServer): handle page→server messages ourselves.
    ws.onMessage((message) => {
      // Binary frames arrive as a Buffer; text frames are dev-WS config queries.
      if (typeof message !== 'string') {
        // THE ONE PLACE THE MOCK READS A GESTURE HEADER (phase 88, D-02, D-06). `sent`
        // keeps the body, so every spec that reads `sent[i][0]` as a discriminant reads
        // what it always read; the header goes beside it in `sentHeaders`. The verdict's
        // `seq` is the gesture id the page named, exactly as the host echoes it.
        const { header, body } = splitGestureHeader(message);
        sent.push(body);
        sentHeaders.push(header);
        if (!opts.answerGesture) return;
        if (header === null) {
          ws.send(JSON.stringify({ kind: GESTURE_REFUSAL_KIND, tag: 'Malformed' }));
          return;
        }
        const seq = header.gestureId;
        let answer: GestureAnswer;
        try {
          answer = opts.answerGesture(body, seq);
        } catch (err) {
          // The throw-on-callback-error discipline the query arm below already
          // documents, applied here for the identical reason and with the identical
          // consequence if it is skipped: an exception swallowed inside Playwright's
          // onMessage callback never sends the reply, leaves the page waiting for a
          // verdict that will never arrive, and surfaces MINUTES later as an opaque
          // visibility timeout pointing at the display layer instead of at this line.
          throw new Error(
            `mockRenderSocket: answerGesture threw for gesture seq ${seq}: ${String(err)}`,
          );
        }
        // An opinion-free `undefined` sends NOTHING: a verdict that never arrived.
        if (answer === undefined) return;
        // An accept is answered as the host answers it since phase 88 (D-06).
        if (answer === GESTURE_ACCEPTED || (typeof answer === 'object' && 'accept' in answer)) {
          const accept = answer === GESTURE_ACCEPTED ? { accept: [] } : answer;
          ws.send(
            JSON.stringify({
              kind: GESTURE_ACCEPT_KIND,
              seq,
              generation: accept.generation ?? 0,
              minted: accept.accept,
            }),
          );
          return;
        }
        // Plan 74.1-28: the refusal names its gesture, `{kind, seq, tag, cmd?, node?}`,
        // exactly as `transport_ws::refusal_frame` writes it. Taken off the frame unless
        // the spec overrides it for a negative leg.
        const named =
          typeof answer === 'string'
            ? { tag: answer, ...gestureSubject(body) }
            : {
                tag: answer.tag,
                ...(answer.cmd === null ? {} : { cmd: answer.cmd }),
                ...(answer.node === null ? {} : { node: answer.node }),
              };
        ws.send(JSON.stringify({ kind: GESTURE_REFUSAL_KIND, seq, ...named }));
        return;
      }
      // A non-query TEXT frame is a control command (encodeControl grammar):
      // record it so a spec can assert which control a guard outcome dispatched,
      // then stop (it is not a config query).
      if (!message.startsWith(QUERY_PREFIX)) {
        controls.push(message);
        return;
      }
      // Mirror the dev-WS query grammar: `query\n{reqId,verb,args}` answered
      // with a `{reqId, ok: true, value}` TEXT reply on the same socket. An
      // unanswered verb is ignored (harmless: its promise stays pending).
      if (!opts.answerQuery) return;
      // Reject-only parsing (mirrors resolveDevWsReply's discipline): a
      // malformed frame or a throwing answerQuery must surface as a NAMED
      // harness error, not escape inside Playwright's onMessage callback -
      // that path never sends the reply, leaves the page-side devWsInvoke
      // promise pending, and kills the spec minutes later on an opaque
      // toBeVisible timeout pointing at the wrong layer.
      let req: { reqId: number; verb: string; args: Record<string, unknown> };
      try {
        req = JSON.parse(message.slice(QUERY_PREFIX.length)) as {
          reqId: number;
          verb: string;
          args: Record<string, unknown>;
        };
      } catch (err) {
        throw new Error(`mockRenderSocket: malformed dev-WS query frame: ${String(err)}`);
      }
      if (typeof req.reqId !== 'number' || typeof req.verb !== 'string') {
        throw new Error(
          `mockRenderSocket: dev-WS query frame missing reqId/verb: ${JSON.stringify(req)}`,
        );
      }
      let value: unknown;
      try {
        value = opts.answerQuery(req.verb, req.args);
      } catch (err) {
        throw new Error(
          `mockRenderSocket: answerQuery threw for verb "${req.verb}": ${String(err)}`,
        );
      }
      if (value !== undefined) {
        ws.send(JSON.stringify({ reqId: req.reqId, ok: true, value }));
      }
    });
    resolveConn();
  });

  return {
    sent,
    sentHeaders,
    controls,
    connected,
    inject: (packet: Buffer) => {
      if (!route) {
        throw new Error('render socket not connected yet');
      }
      route.send(packet);
    },
    injectText: (frame: string) => {
      if (!route) {
        throw new Error('render socket not connected yet');
      }
      route.send(frame);
    },
  };
}

/** Wait until the app chrome is mounted (Palette renders only once `ready`). */
export async function waitForChrome(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Source/ }).waitFor();
}

/** The toolbar's tick text, `tick {formatTick(tick)}` (`Toolbar.tsx`), the element
 *  `toolbar-stability.spec.ts`'s `tickText` reads. */
const TOOLBAR_TICK = 'header [title="Current sim tick"]';

/** The compact suffixes `formatTick` can write past its threshold (`en-US` compact notation). */
const COMPACT_SCALE: Readonly<Record<string, number>> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/**
 * The tick the toolbar's text shows, or -1 when it reads no tick. A compact reading
 * (`tick 100.1M`) is rounded to one decimal by `formatTick`, so it is taken at its upper
 * bound: a tick past the compact threshold can never hold a wait back.
 */
function toolbarTickOf(text: string): number {
  const m = /^tick ([\d,]+(?:\.\d+)?)([KMBT]?)$/.exec(text.trim());
  if (!m) return -1;
  const n = Number(m[1].replace(/,/g, ''));
  if (!m[2]) return n;
  const scale = COMPACT_SCALE[m[2]];
  return (n + 0.05) * scale;
}

/** The page-load property holding the last board tick `waitForBoard` graded (review WR-C01). It
 *  lives on `window`, so a reload starts it again with the page. */
const LAST_GRADED_TICK = '__fabricoWaitForBoardTick';

/**
 * THE BOARD READINESS WAIT (phase 91 plan 91-02, CHROME-01, D-02, research Finding F): wait until
 * the model holds `machines` machines (every scene node whose kind is not `machine_kind.LABEL`, the
 * count the old bottom-right readout drew) and, when `tick` is given, sits at that tick; then wait
 * until the toolbar's tick text shows the matched scene tick or a later one, so the 10 Hz chrome
 * snapshot has committed the same board (the readiness the readout's text used to give).
 *
 * A wait for 0 machines with no tick is refused before any poll: the start scene holds no
 * machine before a packet lands, so such a wait passes at once and grades nothing.
 *
 * THE TOOLBAR LEG GRADES ONLY A TICK THE TOOLBAR HAS NOT SHOWN YET (phase 91 review WR-C01). The
 * toolbar reads `tick 0` before any packet, and it keeps showing the last tick it drew, so a board
 * at tick 0, or at a tick no later than the last board this helper graded on this page load, would
 * pass the toolbar leg at once and grade no redraw. So a wait naming such a tick is refused before
 * any poll, and a tickless wait polls for a board at a tick PAST the last graded one (which also
 * stops it matching the previous board when a new packet leaves the machine count unchanged).
 * Name a later packet tick. `e2e/wait-for-board.spec.ts` proves both legs: the wait cannot pass
 * before its packet, and it cannot pass before the chrome has drawn it.
 */
export async function waitForBoard(
  page: Page,
  want: { machines: number; tick?: number },
  opts: { timeout?: number } = {},
): Promise<void> {
  if (want.machines === 0 && want.tick === undefined) {
    throw new Error(
      'waitForBoard: a wait for 0 machines must name the tick of the packet it waits for; the start scene holds no machine before any packet lands, so a tickless zero wait passes at once (CHROME-01, research Finding F)',
    );
  }
  if (want.tick === 0) {
    throw new Error(
      'waitForBoard: a board at tick 0 cannot be graded by the toolbar, which reads tick 0 before any packet lands; inject the packet at tick 1 or later (review WR-C01)',
    );
  }
  const last = await page.evaluate((k) => {
    const v = (window as unknown as Record<string, unknown>)[k];
    return typeof v === 'number' ? v : 0;
  }, LAST_GRADED_TICK);
  if (want.tick !== undefined && want.tick <= last) {
    throw new Error(
      `waitForBoard: the board's tick ${want.tick} is not past tick ${last}, the last board this page graded, so the toolbar already shows it and its leg would grade no redraw; name a later packet tick (review WR-C01)`,
    );
  }
  const labelKind = machine_kind.LABEL;
  let seen = { tick: -1, machines: -1 };
  const expected =
    want.tick === undefined ? { machines: want.machines, pastLast: true } : { tick: want.tick, machines: want.machines };
  await expect
    .poll(
      async () => {
        seen = await page.evaluate((label) => {
          const hook = (window as { __fabrico?: { scene?(): { tick: number; nodes: { kind: number }[] } } })
            .__fabrico;
          if (!hook || typeof hook.scene !== 'function') {
            throw new Error('window.__fabrico.scene() not installed');
          }
          const s = hook.scene();
          return { tick: s.tick, machines: s.nodes.filter((n) => n.kind !== label).length };
        }, labelKind);
        return want.tick === undefined ? { machines: seen.machines, pastLast: seen.tick > last } : seen;
      },
      {
        timeout: opts.timeout,
        message: `the model holds ${want.machines} machine(s), labels left out${
          want.tick === undefined ? `, at a tick past ${last} (the last board this page graded)` : `, at tick ${want.tick}`
        }`,
      },
    )
    .toEqual(expected);
  const matchedTick = seen.tick;
  const tickText = page.locator(TOOLBAR_TICK);
  await expect(tickText, 'the toolbar shows the sim tick').toBeVisible({ timeout: opts.timeout });
  await expect
    .poll(async () => toolbarTickOf((await tickText.textContent()) ?? ''), {
      timeout: opts.timeout,
      message: `the toolbar's tick text shows tick ${matchedTick} or later (the chrome drew this board)`,
    })
    .toBeGreaterThanOrEqual(matchedTick);
  await page.evaluate(([k, t]) => {
    (window as unknown as Record<string, unknown>)[k as string] = t;
  }, [LAST_GRADED_TICK, matchedTick] as const);
}

/**
 * Assert the gesture emitted EXACTLY ONE GridCommand frame of `discriminant`:
 * poll until the frame lands, check its discriminant, then settle a short window
 * and re-assert the count is STILL 1 - `expect.poll(...).toBe(1)` resolves the
 * instant the count first reaches 1 and would NOT catch a LATE duplicate frame,
 * weakening the "one GridCommand per gesture" guarantee (WR-13-03).
 */
export async function expectExactlyOneFrame(
  page: Page,
  h: Harness,
  discriminant: number,
): Promise<void> {
  await expect.poll(() => h.sent.length).toBe(1);
  expect(h.sent[0][0]).toBe(discriminant);
  await page.waitForTimeout(150);
  expect(h.sent.length, 'gesture must emit no late duplicate frame').toBe(1);
}
