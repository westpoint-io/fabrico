import { describe, expect, it } from 'vitest';
import type { BeltDockView, BeltView, NodeView, PortView, WireView } from './decode.ts';
import { LOAD_FULL, state_tag } from './kinds.ts';
import { FAULT_PORT } from './ports.ts';
import { JOIN_HOP_LIMIT, selectedNodePortFlow, type PacketLookup } from './portFlow.ts';

// portFlow.test.ts (PANEL-04) - the correlation contract between the render
// packet's belts (which carry the ITEMS and the DOCKS) and the selected node's
// ports (which carry no flow data at all). The panel's live per-port presence and
// state (idle, moving, backed up) is derived entirely here, so these cases pin:
//
//   - the three dock keyspaces route to the right port (Head raw catalog index /
//     Tail Out routing key / 65535 fault sentinel) - inherited verbatim from
//     `dockPort`, never re-implemented,
//   - a HOSTILE packet presenting multiple belts on ONE port still folds rather
//     than throwing. That topology is NOT reachable (D3, measured 2026-08-29:
//     `command.rs:1084` admits exactly one cell per port, `command.rs:971` stops
//     two belts overlapping it, `mediums_compatible` stops a belt and a wire
//     sharing one, and `state.rs:1137`'s `links` is one key to one value), so the
//     fold is a degradation rule and never a legal-topology claim,
//   - every hostile edge (out-of-range keyspace value, a dock naming another
//     node) credits NOTHING and never throws (T-51-03 / the T-21-02 discipline),
//   - the backed-up rule (phase 91, CHROME-13, research Finding E) on REAL slot
//     indices: items sit at slots 0..n, never at tick-like values, because on the
//     wire `arrival_tick` IS the slot index. A rule that read it as a tick would
//     pass a fixture built with tick-like values and call every flowing belt
//     backed up on the real host.
//
// The fixture shape mirrors ports.test.ts so the two files read as one family.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const port = (
  index: number,
  role: number,
  cell_x = 0,
  cell_y = 0,
  side = 0,
  medium = 0,
): PortView => ({ index, cell_x, cell_y, side, role, medium });

const node = (over: Partial<NodeView> & { id: number }): NodeView => ({
  kind: 0,
  cell_x: 0,
  cell_y: 0,
  state: 0,
  w: 1,
  h: 1,
  rot: 0,
  ports: [],
  load: 0,
  ...over,
});

const dock = (end: 'Head' | 'Tail', nodeId: number, portKey: number): BeltDockView => ({
  end,
  node: nodeId,
  port: portKey,
});

/** Slots on every fixture belt (`latency` is the slot count on the wire). */
const SLOTS = 16;

/** A belt carrying `itemCount` items packed at its TAIL end (the highest slots), so
 *  its head slot is empty and no case built from it is backed up: these cases pin
 *  presence, keyspaces and links. The backed-up cases build their own slots with
 *  {@link beltOn}. */
const belt = (id: number, itemCount: number, docks: BeltDockView[]): BeltView =>
  beltOn(id, Array.from({ length: itemCount }, (_, i) => SLOTS - itemCount + i), docks);

/** A belt with items at exactly these slot indices (ascending; slot 0 is the head). */
const beltOn = (id: number, slots: number[], docks: BeltDockView[]): BeltView => ({
  id,
  latency: SLOTS,
  fill: slots.length,
  items: slots.map((slot) => ({ arrival_tick: slot, tag: 0 })),
  tiles: [],
  docks,
  // SLOT-03: the belt's own advance interval, appended LAST after `docks`. This suite
  // reads docks and item slots only, so the identity value keeps it a pure addition.
  ticks_per_slot: 1,
});

/** The canonical panel fixture: In@0, Out@1, Fault@2 (the core In-first order). */
const FACTORY = node({ id: 7, ports: [port(0, 0), port(1, 1), port(2, 2)] });

/** Every port index resolves to an entry, even with no belts at all. */
const NO_FLOW = { docked: false, carrying: false, backedUp: false };

/** The packet lookup these presence cases pass: no other machine and no belt is
 *  reachable by handle, and every fixture belt's head slot is empty, so nothing
 *  here depends on a head consumer. */
const SCENE: PacketLookup = { nodes: new Map(), belts: new Map() };

/** A packet lookup holding these machines and belts by handle. */
const sceneOf = (nodes: NodeView[], belts: BeltView[]): PacketLookup => ({
  nodes: new Map(nodes.map((n) => [n.id, n])),
  belts: new Map(belts.map((b) => [b.id, b])),
});

/** CONNECT-01: the resolved `PortLink` a belt dock contributes. Spelled out as a
 *  helper rather than inlined 9 times so the ONE thing each case is asserting
 *  about the link - which belt, which end - stays readable next to the state.
 *  `end` is `BeltDockView.end` VERBATIM; it is not derivable from the port. */
const beltLink = (belt: number, end: 'Head' | 'Tail') => ({ kind: 'belt', belt, end });

/** A docked entry carrying items or not, never backed up (the fixture's head slot is empty). */
const carrying = (yes: boolean) => ({ docked: true, carrying: yes, backedUp: false });

/** CONNECT-01 / D1: the resolved `PortLink` a WIRE endpoint contributes. It names
 *  the WIRE's own render handle and nothing else - no end, because a wire has no
 *  `BeltEnd`, and no port, because the map key already is the port. A wire link
 *  dispatches `Delete { node: wireId }`, not `Unlink`. */
const wireLink = (wire: number) => ({ kind: 'wire', wire });

/** One electrical wire. `pulses` is populated on purpose in the pulses case: the
 *  fold must credit NO items whatever the cable is carrying (UI-SPEC 9). */
const wire = (
  from: { node: number; port: number },
  to: { node: number; port: number },
  pulses = 0,
): WireView => ({
  id: 1,
  from,
  to,
  path: [],
  pulses: Array.from({ length: pulses }, () => ({
    entry_tick: 0,
    hop_ticks: 4,
    direction: 0,
  })),
});

/** The ENDPOINT shape (66-03 / decode.ts MACHINE_CATALOG): the ONLY catalog arm
 *  with electrical ports - In@0 facing W, Out@1 facing E, both `medium: 1`. It is
 *  the fixture that matters because every OTHER wireable port arrives by
 *  `AddPort` at the highest index, which is exactly what a `RemovePort` on an
 *  earlier index shifts. */
const ENDPOINT = node({
  id: 7,
  ports: [port(0, 0, 0, 0, 3, 1), port(1, 1, 0, 0, 1, 1)],
});


describe('selectedNodePortFlow', () => {
  it('initialises every port index to undocked/zero when no belt touches the node', () => {
    const flow = selectedNodePortFlow(FACTORY, [], [], SCENE);
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(1)).toEqual(NO_FLOW);
    expect(flow.get(2)).toEqual(NO_FLOW);
    expect(flow.size).toBe(3);
  });

  it('credits a Tail-docked belt (Out routing key 0) carrying items to the Out port', () => {
    const flow = selectedNodePortFlow(FACTORY, [belt(1, 3, [dock('Tail', 7, 0)])], [], SCENE);
    // The Out routing key is the nth role===1 port, NOT the catalog index - a
    // naive `ports[dock.port]` would credit the In port here instead.
    expect(flow.get(1)).toEqual({ ...carrying(true), link: beltLink(1, 'Tail') });
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(2)).toEqual(NO_FLOW);
  });

  it('credits a Head-docked belt (raw catalog index) to the In port', () => {
    const flow = selectedNodePortFlow(FACTORY, [belt(1, 2, [dock('Head', 7, 0)])], [], SCENE);
    expect(flow.get(0)).toEqual({ ...carrying(true), link: beltLink(1, 'Head') });
    expect(flow.get(1)).toEqual(NO_FLOW);
  });

  it('credits a Tail dock on the 65535 fault sentinel to the Fault port', () => {
    const flow = selectedNodePortFlow(FACTORY, [belt(1, 1, [dock('Tail', 7, FAULT_PORT)])], [], SCENE);
    expect(flow.get(2)).toEqual({ ...carrying(true), link: beltLink(1, 'Tail') });
    expect(flow.get(1)).toEqual(NO_FLOW);
  });

  it('marks a docked belt carrying ZERO items as docked and not carrying (the idle step)', () => {
    // This is the distinction the three-step tint exists for: "connected but
    // nothing moving" must be a DIFFERENT state from "nothing connected".
    const flow = selectedNodePortFlow(FACTORY, [belt(1, 0, [dock('Tail', 7, 0)])], [], SCENE);
    expect(flow.get(1)).toEqual({ ...carrying(false), link: beltLink(1, 'Tail') });
  });

  it('folds a HOSTILE packet presenting two belts on one Out port, rather than throwing', () => {
    const flow = selectedNodePortFlow(FACTORY, [
      belt(1, 3, [dock('Tail', 7, 0)]),
      belt(2, 4, [dock('Tail', 7, 0)]),
    ], [], SCENE);
    // D3 (measured 2026-08-29, `67-CONTEXT.md`): THIS INPUT IS NOT REACHABLE, and
    // the case is named for what it is rather than for what its old title claimed
    // ("sums the item counts of two belts docked to the SAME Out port", which read
    // as a legal topology). Four measurements say so: the dock geometry check
    // `(mcell + unit_delta(mside)) != end_cell -> InvalidDock` admits exactly ONE
    // cell per port (`command.rs:1084`); `view.occupied(t.cell)` rejects a second
    // belt on that cell with `FootprintCollision` (`command.rs:971`);
    // `mediums_compatible` stops a belt and a wire sharing one port
    // (`command.rs:1075`); and `links` is `BTreeMap<(NodeId, PortId), (NodeId,
    // PortId)>` - one key, one value (`state.rs:1137`).
    //
    // What is pinned here is therefore TOTALITY, not topology: a forged or stale
    // packet must degrade rather than throw (T-51-03). If this input ever DOES
    // become reachable, the correct response is a host-side occupancy guard at the
    // `Dock` validate arm - NOT a change to this expectation. The assertion below
    // read the item count until phase 91 (CHROME-13) moved the row to state words.
    //
    // CONNECT-01: the state folds as an OR but the link cannot - a port carries one
    // Disconnect control and it must name ONE link. The LAST belt scanned wins
    // (see the belt loop's own comment): the offered verb addresses a real link
    // rather than none, and the next poll re-resolves whatever survives.
    expect(flow.get(1)).toEqual({ ...carrying(true), link: beltLink(2, 'Tail') });
  });

  it('credits BOTH ends of one belt that docks the same node twice (Head In, Tail Out)', () => {
    const flow = selectedNodePortFlow(FACTORY, [
      belt(1, 5, [dock('Head', 7, 0), dock('Tail', 7, 0)]),
    ], [], SCENE);
    // The two entries carry DIFFERENT ends of the SAME belt - which is exactly
    // why `end` is read off the dock record and never derived from the port.
    expect(flow.get(0)).toEqual({ ...carrying(true), link: beltLink(1, 'Head') });
    // The Tail end LEAVES the node, so it names what the belt reaches: its Head
    // docks this very node's In (UI-SPEC 8.6), one In, so no input number.
    expect(flow.get(1)).toEqual({
      ...carrying(true),
      link: beltLink(1, 'Tail'),
      reaches: { node: 7, kind: 0, input: 1, inputs: 1 },
    });
  });

  it('skips an out-of-range Out routing key (dockPort returns null) without throwing', () => {
    // A forged/stale packet: Tail key 9 on a node with ONE Out port. `dockPort`
    // degrades to null (T-21-02) and the row must simply read "not connected".
    const flow = selectedNodePortFlow(FACTORY, [belt(1, 9, [dock('Tail', 7, 9)])], [], SCENE);
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(1)).toEqual(NO_FLOW);
    expect(flow.get(2)).toEqual(NO_FLOW);
  });

  it('skips a fault-sentinel dock on a node that has NO spatial fault port', () => {
    const faultless = node({ id: 7, ports: [port(0, 0), port(1, 1)] });
    const flow = selectedNodePortFlow(faultless, [belt(1, 2, [dock('Tail', 7, FAULT_PORT)])], [], SCENE);
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(1)).toEqual(NO_FLOW);
  });

  it('ignores a belt whose docks reference a DIFFERENT node id', () => {
    const flow = selectedNodePortFlow(FACTORY, [belt(1, 6, [dock('Tail', 99, 0)])], [], SCENE);
    expect(flow.get(1)).toEqual(NO_FLOW);
  });

  it('returns an empty map for a portless node and still tolerates docked belts', () => {
    const portless = node({ id: 7 });
    const flow = selectedNodePortFlow(portless, [belt(1, 3, [dock('Tail', 7, 0)])], [], SCENE);
    expect(flow.size).toBe(0);
  });

  it('accepts any Iterable of belts (a live SceneState.belts.values() iterator)', () => {
    const belts = new Map<number, BeltView>([[1, belt(1, 3, [dock('Tail', 7, 0)])]]);
    const flow = selectedNodePortFlow(FACTORY, belts.values(), [], SCENE);
    expect(flow.get(1)).toEqual({ ...carrying(true), link: beltLink(1, 'Tail') });
  });
});

// ---------------------------------------------------------------------------
// WIRE endpoints (WIRE-05). The frontend dock-safety gate's ASSUMPTION 1 named
// this phase in capitals: the moment wire ports become user-editable, this fold
// must credit `SceneState.wires` endpoints or a wired Out reads as free.
// 66-01 shipped the wire-draw gesture and 66-04 shipped the placeable Endpoint,
// so the assumption is void and these are the cases that say so. The gate itself
// was deleted in 73-08 - `fold_remove_port` re-points and releases rather than the
// panel refusing - but this fold still feeds the Disconnect control and the Add
// advisory, so every case below is live coverage rather than a leftover.
//
// Every case here FAILS against the two-argument fold: it ignores the third
// argument entirely, so a wired Out reads `not connected` and its removal is
// offered.
// ---------------------------------------------------------------------------
describe('selectedNodePortFlow folds WIRE endpoints (WIRE-05)', () => {
  it('marks an electrical Out carrying a wire `from` endpoint as docked', () => {
    const flow = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 7, port: 1 }, { node: 9, port: 0 })], SCENE);
    // CONNECT-01: a wire SOURCE is a real dock from the panel's point of view and
    // must therefore offer the verb, even though the core holds no `links` entry
    // for it at all (`state.rs:1983-1988`). `WireView` is projected from the wire
    // node's own `from`/`to` fields, which is why this port reads docked in the
    // first place - and it is also why the verb here is `Delete`, not `Unlink`.
    expect(flow.get(1)).toEqual({ ...carrying(false), link: wireLink(1) });
    expect(flow.get(0)).toEqual(NO_FLOW);
  });

  it('marks the `to` end too - BOTH endpoints of every wire are read', () => {
    // The `to` half is the one a loop written for the source end alone would
    // miss, and an In port is exactly where the demo scene's own wire lands.
    const flow = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 9, port: 0 }, { node: 7, port: 0 })], SCENE);
    // The SAME wire-variant link the `from` case above resolves: both endpoints
    // of a wire name the one wire node, so both rows dispatch the identical
    // `Delete`. There is no from/to asymmetry to encode.
    expect(flow.get(0)).toEqual({ ...carrying(false), link: wireLink(1) });
    expect(flow.get(1)).toEqual(NO_FLOW);
  });

  it('credits NO items, however many pulses are on the cable', () => {
    // `carrying` is belt items. A wire pulse lives ~2 ticks, so folding pulses in
    // would make the row flicker meaninglessly (UI-SPEC 9). A wired Out reads
    // `idle`, never `moving`.
    const flow = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 7, port: 1 }, { node: 9, port: 0 }, 3)], SCENE);
    expect(flow.get(1)).toEqual({ ...carrying(false), link: wireLink(1) });
  });

  it('skips a wire whose endpoints both name a DIFFERENT node', () => {
    const flow = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 99, port: 1 }, { node: 98, port: 0 })], SCENE);
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(1)).toEqual(NO_FLOW);
  });

  it('credits NO port and does not throw on an out-of-range wire port index', () => {
    // A wire endpoint is a RAW POSITIONAL PortId, and `fold_remove_port` drops a
    // port without touching links - so a stale packet naming a port that no
    // longer exists is the ordinary consequence of the very defect this fold
    // mitigates. It must degrade, exactly like an unresolvable belt dock.
    const flow = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 7, port: 9 }, { node: 7, port: 42 })], SCENE);
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(1)).toEqual(NO_FLOW);
    expect(flow.size).toBe(2);
    // CONNECT-01, stated explicitly rather than left implied by the two `toEqual`s
    // above: an unresolvable endpoint produces NO link, so NO Disconnect control
    // renders for it. The control fails closed by being absent - it never guesses
    // a wire id from a port that credited nothing.
    expect(flow.get(0)?.link).toBeUndefined();
    expect(flow.get(1)?.link).toBeUndefined();
  });

  it('adds presence to a port a belt already credits, without touching its state', () => {
    // Mixed media on one node is not reachable from the shipped catalog, but the
    // fold must not care: presence is an OR, and the belt's state survives.
    const mixed = node({ id: 7, ports: [port(0, 0), port(1, 1), port(2, 1, 0, 0, 1, 1)] });
    const flow = selectedNodePortFlow(
      mixed,
      [belt(1, 4, [dock('Tail', 7, 0)])],
      [wire({ node: 7, port: 2 }, { node: 9, port: 0 })],
      SCENE,
    );
    expect(flow.get(1)).toEqual({ ...carrying(true), link: beltLink(1, 'Tail') });
    expect(flow.get(2)).toEqual({ ...carrying(false), link: wireLink(1) });
  });

  it('accepts any Iterable of wires (a live SceneState.wires.values() iterator)', () => {
    const wires = new Map<number, WireView>([[1, wire({ node: 7, port: 1 }, { node: 9, port: 0 })]]);
    const flow = selectedNodePortFlow(ENDPOINT, [], wires.values(), SCENE);
    expect(flow.get(1)).toEqual({ ...carrying(false), link: wireLink(1) });
  });
});

// ---------------------------------------------------------------------------
// CONNECT-01: LINK IDENTITY across all FOUR keyspaces a port can be named in.
//
// The describes above pin PRESENCE and STATE. These pin the resolved `link` -
// the field a Disconnect click turns into a command - and they are separate
// cases rather than extra assertions on the existing ones because the failure
// they exist to catch is different: a build can credit the right port and still
// name the wrong belt, or name the right belt through the wrong translation and
// agree with a correct build on the fixture that happens to be on screen.
//
// The four keyspaces, and which loop reads each:
//
//   1. Head dock       raw catalog index                 -> `dockPort` (belt loop)
//   2. Tail dock       Out ROUTING key (nth role===1)    -> `dockPort` (belt loop)
//   3. Either dock     the 65535 fault sentinel          -> `dockPort` (belt loop)
//   4. Wire endpoint   raw positional PortId             -> `flow.get` DIRECTLY
//
// Keyspace 4 is deliberately NOT routed through `dockPort` (see the wire loop's
// own comment); these cases are what would notice a "simplification" that did.
//
// Every fixture below is chosen so the RIGHT translation and a plausible WRONG
// one give DIFFERENT answers. A fixture on which they agree proves nothing, and
// this project has shipped that mistake before (plan 65-04).
// ---------------------------------------------------------------------------
describe('selectedNodePortFlow resolves the LINK in every keyspace (CONNECT-01)', () => {
  /** Two Ins, so a Head dock's raw catalog index 1 is NOT also an Out routing
   *  key that resolves (`filter(role===1)[1]` is undefined here). */
  const TWO_IN = node({ id: 7, ports: [port(0, 0), port(1, 0), port(2, 1)] });

  /** The REAL post-AddPort Factory shape: the hand-added Out lands AFTER Fault,
   *  so the second Out's routing key (1) and its catalog index (3) differ. */
  const TWO_OUT = node({ id: 7, ports: [port(0, 0), port(1, 1), port(2, 2), port(3, 1)] });

  it('1. a HEAD dock names a RAW CATALOG index, and the link carries that belt and Head', () => {
    // Catalog index 1 here is the SECOND In. Read as an Out routing key it would
    // resolve to nothing at all, so the two readings disagree on this fixture.
    const flow = selectedNodePortFlow(TWO_IN, [belt(5, 2, [dock('Head', 7, 1)])], [], SCENE);
    expect(flow.get(1)).toEqual({ ...carrying(true), link: beltLink(5, 'Head') });
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(2)).toEqual(NO_FLOW);
  });

  it('2. a TAIL dock names an OUT ROUTING key, translated by dockPort and never re-derived', () => {
    // THE CASE THAT CAN PASS FOR THE WRONG REASON. The routing key here is 1 and
    // the catalog index it names is 3, so a build that used the key VERBATIM as a
    // catalog index credits port 1 instead and this case sees it. A fixture whose
    // first Out is also catalog index 0 makes both implementations agree and
    // proves nothing - which is exactly the shape on a ROUTER, where the In is
    // catalog 0 and the first Out is routing key 0 and the two keyspaces collide
    // numerically at 0. Plan 65-04 recorded that collision as a version that
    // typechecks and is wrong; `command.rs:1410-1445`'s `Unlink` arm refuses on
    // the ROLE for the same reason.
    const outs = TWO_OUT.ports.filter((p) => p.role === 1);
    expect(outs).toHaveLength(2);
    expect(
      outs[1].index,
      'the fixture is only discriminating while the routing key and the catalog index differ',
    ).not.toBe(1);

    const flow = selectedNodePortFlow(TWO_OUT, [belt(6, 4, [dock('Tail', 7, 1)])], [], SCENE);
    expect(flow.get(3)).toEqual({ ...carrying(true), link: beltLink(6, 'Tail') });
    // The port whose CATALOG index equals the routing key is credited nothing.
    expect(flow.get(1)).toEqual(NO_FLOW);
    expect(flow.get(0)).toEqual(NO_FLOW);
    expect(flow.get(2)).toEqual(NO_FLOW);
  });

  it('3. the 65535 FAULT SENTINEL names the spatial fault port, and the link resolves there', () => {
    // 65535 is out of range in BOTH other keyspaces, so a build that dropped the
    // sentinel branch degrades to null and credits nothing.
    const flow = selectedNodePortFlow(TWO_OUT, [belt(7, 1, [dock('Tail', 7, FAULT_PORT)])], [], SCENE);
    expect(flow.get(2)).toEqual({ ...carrying(true), link: beltLink(7, 'Tail') });
    expect(flow.get(1)).toEqual(NO_FLOW);
    expect(flow.get(3)).toEqual(NO_FLOW);
  });

  it('4. a WIRE endpoint is a RAW POSITIONAL PortId, on `from` and on `to` alike', () => {
    // The FOURTH keyspace, and the one `dockPort` has never heard of. Routing the
    // `from` value (1) through `dockPort` as a Tail would ask for the SECOND Out
    // of a two-port Endpoint, which does not exist - so a "simplification" into
    // `dockPort` degrades to null here rather than typechecking into silence.
    const from = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 7, port: 1 }, { node: 9, port: 0 })], SCENE);
    expect(from.get(1)).toEqual({ ...carrying(false), link: wireLink(1) });
    expect(from.get(0)).toEqual(NO_FLOW);

    // The `to` half names the SAME wire node, because both endpoints of one wire
    // dispatch the identical `Delete { node: wireId }` (D1). There is no from/to
    // asymmetry to encode, and a loop written for the source end alone misses it.
    const to = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 9, port: 0 }, { node: 7, port: 0 })], SCENE);
    expect(to.get(0)).toEqual({ ...carrying(false), link: wireLink(1) });
    expect(to.get(1)).toEqual(NO_FLOW);
  });

  it('5. an OUT-OF-RANGE routing key credits no port, carries no link, and reads not connected', () => {
    // FAIL-CLOSED case one of three. `dockPort` degrades to null (T-21-02) and the
    // entry stays at its initialised `NO_FLOW` - which is exactly
    // the entry `portFlowVisual` renders as `PORT_STATUS.notConnected`, and exactly the
    // entry `disconnectControl` returns `undefined` for. The row says "not
    // connected" in words and offers NOTHING; it never offers a dead button.
    const flow = selectedNodePortFlow(TWO_OUT, [belt(8, 9, [dock('Tail', 7, 9)])], [], SCENE);
    for (const index of [0, 1, 2, 3]) {
      expect(flow.get(index)).toEqual(NO_FLOW);
      expect(flow.get(index)?.docked).toBe(false);
      expect(flow.get(index)?.link).toBeUndefined();
    }
  });

  it('6. a FAULT SENTINEL on a node with no spatial fault port credits no port and no link', () => {
    // FAIL-CLOSED case two of three. The node is built INLINE, right below, with
    // two ports and no role-2 port at all, so this assertion is a function of THAT
    // node and observes no machine catalog. `dockPort`'s fault-sentinel lookup is
    // what degrades to null, and the panel must show an undocked row rather than
    // throw.
    //
    // MEASURED in phase 71, not assumed: this case stays GREEN when plan 71-04
    // gives the Router a spatial Role::Fault nub (D-07). Only the old comment here
    // went false - it cited "a ROUTER's fault output is the reserved LOGICAL
    // sentinel with no perimeter cell", which the Router will no longer be an
    // example of. The assertion was and remains correct, so it is untouched: the
    // sibling case in ports.test.ts is the one that genuinely reddened, because it
    // read a SHARED ROUTER fixture instead of building its own node.
    const faultless = node({ id: 7, ports: [port(0, 0), port(1, 1)] });
    const flow = selectedNodePortFlow(faultless, [belt(9, 2, [dock('Tail', 7, FAULT_PORT)])], [], SCENE);
    for (const index of [0, 1]) {
      expect(flow.get(index)).toEqual(NO_FLOW);
      expect(flow.get(index)?.link).toBeUndefined();
    }
    expect(flow.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// THE BACKED-UP RULE (phase 91, D-12, CHROME-13, research Finding E, UI-SPEC 8.5 as
// amended in plan 91-07). Every case puts its items at REAL slot indices, 0..n,
// with slot 0 the head (`belt_slots.rs`), because on the wire `arrival_tick` IS the
// slot index. The UI-SPEC's first rule ("an item whose arrival_tick is below the
// packet tick is overdue") would read every one of these belts as backed up once
// the sim is past tick 16: the flowing cases below are what would catch it.
// ---------------------------------------------------------------------------
describe('selectedNodePortFlow reads a port as idle, moving or backed up from packet facts (CHROME-13)', () => {
  /** The Factory's Out routing key 0 (catalog index 1) is where every belt below leaves. */
  const OUT = 1;
  /** A one-In consumer, taking items. */
  const SINK = node({ id: 20, kind: 7, state: state_tag.WORKING, ports: [port(0, 0)] });
  /** The same consumer, refusing: its inbox at the cap (`load === LOAD_FULL`, review WR-A-01). */
  const JAMMED = node({ id: 21, kind: 7, state: state_tag.BACKED_UP, load: LOAD_FULL, ports: [port(0, 0)] });
  const intoSink = [dock('Tail', 7, 0), dock('Head', 20, 0)];

  it('head slot empty with items behind it, head into a WORKING node: moving', () => {
    const b = beltOn(30, [2, 3, 4], intoSink);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY, SINK], [b]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: false });
  });

  it('head slot occupied, head docked nowhere: backed up', () => {
    const b = beltOn(30, [0, 1, 2, 3], [dock('Tail', 7, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY], [b]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: true });
  });

  it('head slot occupied, head into a node whose inbox is full: backed up', () => {
    const b = beltOn(30, [0, 1], [dock('Tail', 7, 0), dock('Head', 21, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY, JAMMED], [b]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: true });
  });

  it('head slot occupied, head into a WORKING node: moving (the core delivers it on the next due advance)', () => {
    const b = beltOn(30, [0, 3, 7], intoSink);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY, SINK], [b]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: false });
  });

  it('a docked belt with no items: idle', () => {
    const b = beltOn(30, [], [dock('Tail', 7, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY], [b]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: false, backedUp: false });
  });

  it('a wire: idle, whatever it carries', () => {
    const flow = selectedNodePortFlow(ENDPOINT, [], [wire({ node: 7, port: 1 }, { node: 9, port: 0 }, 5)], SCENE);
    expect(flow.get(1)).toMatchObject({ docked: true, carrying: false, backedUp: false });
  });

  it('nothing docked: not connected', () => {
    const flow = selectedNodePortFlow(FACTORY, [], [], sceneOf([FACTORY], []));
    expect(flow.get(OUT)).toEqual(NO_FLOW);
  });

  it('an In row: a belt arriving with its head item at a node whose inbox is full reads backed up', () => {
    const full = { ...FACTORY, state: state_tag.BACKED_UP, load: LOAD_FULL };
    const b = beltOn(30, [0, 1, 2], [dock('Head', 7, 0)]);
    const flow = selectedNodePortFlow(full, [b], [], sceneOf([full], [b]));
    expect(flow.get(0)).toMatchObject({ docked: true, carrying: true, backedUp: true });
    const taking = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY], [b]));
    expect(taking.get(0), 'the same belt into the node while it takes items reads moving').toMatchObject({
      docked: true,
      carrying: true,
      backedUp: false,
    });
  });

  it('a belt joining a backed-up belt packed to its entry slot: backed up; joining a flowing one: moving', () => {
    const up = beltOn(30, [0, 1], [dock('Tail', 7, 0), dock('Head', 31, 0)]);
    const deadEnd = beltOn(31, Array.from({ length: SLOTS }, (_, i) => i), [dock('Tail', 30, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [up], [], sceneOf([FACTORY], [up, deadEnd]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: true });

    const flowing = beltOn(31, [0, 2], [dock('Tail', 30, 0), dock('Head', 20, 0)]);
    const moving = selectedNodePortFlow(FACTORY, [up], [], sceneOf([FACTORY, SINK], [up, flowing]));
    expect(moving.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: false });
  });

  it('a fan-in port with one backed-up belt among flowing ones: backed up', () => {
    const flowingBelt = beltOn(30, [3, 4], intoSink);
    const stuck = beltOn(32, [0, 1, 2], [dock('Tail', 7, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [flowingBelt, stuck], [], sceneOf([FACTORY, SINK], [flowingBelt, stuck]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: true });
  });

  it('a 70-belt join chain stops at the hop limit without throwing; a 10-belt chain is followed to its end', () => {
    const chain = (n: number): BeltView[] =>
      Array.from({ length: n }, (_, k) =>
        beltOn(100 + k, Array.from({ length: SLOTS }, (_, i) => i), [
          dock('Tail', k === 0 ? 7 : 100 + k - 1, 0),
          ...(k === n - 1 ? [] : [dock('Head', 100 + k + 1, 0)]),
        ]),
      );
    expect(JOIN_HOP_LIMIT).toBe(64);
    const long = chain(70);
    const far = selectedNodePortFlow(FACTORY, [long[0]], [], sceneOf([FACTORY], long));
    expect(far.get(OUT), 'past the limit the walk cannot prove the jam').toMatchObject({ backedUp: false });
    const short = chain(10);
    const near = selectedNodePortFlow(FACTORY, [short[0]], [], sceneOf([FACTORY], short));
    expect(near.get(OUT), 'the last of ten joined belts docks nowhere').toMatchObject({ backedUp: true });
  });

  it('a ring of joined belts, every slot taken, stops on the repeat without throwing', () => {
    const full = Array.from({ length: SLOTS }, (_, i) => i);
    const a = beltOn(40, full, [dock('Tail', 7, 0), dock('Head', 41, 0)]);
    const b = beltOn(41, full, [dock('Tail', 40, 0), dock('Head', 40, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [a], [], sceneOf([FACTORY], [a, b]));
    expect(flow.get(OUT)).toMatchObject({ docked: true, carrying: true, backedUp: false });
  });
});

// ---------------------------------------------------------------------------
// THE BELT'S OWN BLOCKED STATE (phase 91 review WR-A-01, WR-A-02). "Backed up" is whether
// the belt's head item can leave: a full consumer (its fullest mechanical inbox port at the
// cap, `load === LOAD_FULL`, whatever its state byte says) refuses it, and a joined belt
// refuses it only when its own entry slot (the tail, `latency - 1`) is taken and it is itself
// backed up. The consumer's state byte is not the question: FAULTED hides a full inbox, and
// BACKED_UP is also worn by a machine waiting behind its output with room in its inbox.
// ---------------------------------------------------------------------------
describe("selectedNodePortFlow reads backed up from the belt's own blocked state (review WR-A-01, WR-A-02)", () => {
  const OUT = 1;
  const packed = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  it('WR-A-01: head slot occupied, head into a FAULTED node whose inbox is full: backed up', () => {
    const faultedFull = node({ id: 22, kind: 7, state: state_tag.FAULTED, load: LOAD_FULL, ports: [port(0, 0)] });
    const b = beltOn(30, [0, 1, 2], [dock('Tail', 7, 0), dock('Head', 22, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY, faultedFull], [b]));
    expect(flow.get(OUT), 'a faulted consumer with a full inbox refuses the head item').toMatchObject({
      docked: true,
      carrying: true,
      backedUp: true,
    });
    const inRow = selectedNodePortFlow(faultedFull, [b], [], sceneOf([FACTORY, faultedFull], [b]));
    expect(inRow.get(0), "and the consumer's own In row says the same").toMatchObject({ backedUp: true });
  });

  it('WR-A-02: head slot occupied, head into a BACKED_UP node that still has room (it waits behind its output): moving', () => {
    const waiting = node({ id: 23, kind: 3, state: state_tag.BACKED_UP, load: 2, ports: [port(0, 0)] });
    const b = beltOn(30, [0, 1], [dock('Tail', 7, 0), dock('Head', 23, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY, waiting], [b]));
    expect(flow.get(OUT), 'its inbox takes the head item on the next advance').toMatchObject({
      docked: true,
      carrying: true,
      backedUp: false,
    });
  });

  it('WR-A-02 (a): a belt joining a belt jammed at its head but with its entry slot free: moving', () => {
    const up = beltOn(30, [0, 1], [dock('Tail', 7, 0), dock('Head', 31, 0)]);
    const jammedHead = beltOn(31, [0, 1, 2, 3], [dock('Tail', 30, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [up], [], sceneOf([FACTORY], [up, jammedHead]));
    expect(flow.get(OUT), "the joined belt still takes items at its tail, so this belt's items move").toMatchObject({
      docked: true,
      carrying: true,
      backedUp: false,
    });
    const full = beltOn(31, packed(SLOTS), [dock('Tail', 30, 0)]);
    const stuck = selectedNodePortFlow(FACTORY, [up], [], sceneOf([FACTORY], [up, full]));
    expect(stuck.get(OUT), 'packed to its entry slot and itself backed up: backed up').toMatchObject({ backedUp: true });
  });

  it('WR-A-02 (b), the stated limit: the packet carries one load per machine, so a fan-in judges by its fullest port', () => {
    // A Merge whose first In is full reads `load === LOAD_FULL`; a belt with its head item at
    // the SECOND In reads backed up, though that port has room. The packet carries no per-port
    // fill, and the UI-SPEC (8.5, A11 as amended by the review fix) says so. The core delivers
    // a head item the tick it can, so a belt into a free port rarely shows one at its head.
    const merge = node({ id: 24, kind: 6, state: state_tag.BACKED_UP, load: LOAD_FULL, ports: [port(0, 0), port(1, 0)] });
    const b = beltOn(30, [0], [dock('Tail', 7, 0), dock('Head', 24, 1)]);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY, merge], [b]));
    expect(flow.get(OUT)).toMatchObject({ backedUp: true });
  });
});

// ---------------------------------------------------------------------------
// WHAT A LEAVING BELT REACHES (phase 91, D-12, CHROME-13, UI-SPEC 8.6): the Router's
// outputs are named by it. The walk follows joined belts, uses `dockPort` for the
// In it lands on, and names nothing on open floor.
// ---------------------------------------------------------------------------
describe('selectedNodePortFlow names the machine a leaving belt reaches (UI-SPEC 8.6)', () => {
  const OUT = 1;
  const SINK = node({ id: 20, kind: 7, ports: [port(0, 0)] });
  const MERGE = node({ id: 22, kind: 6, ports: [port(0, 0), port(1, 0), port(2, 1)] });

  it('a belt into a one-In Sink reaches the Sink, input 1 of 1', () => {
    const b = belt(30, 2, [dock('Tail', 7, 0), dock('Head', 20, 0)]);
    const flow = selectedNodePortFlow(FACTORY, [b], [], sceneOf([FACTORY, SINK], [b]));
    expect(flow.get(OUT)?.reaches).toEqual({ node: 20, kind: 7, input: 1, inputs: 1 });
  });

  it("a belt into a Merge's second In, through a joined belt, reaches input 2 of 2", () => {
    const a = belt(30, 0, [dock('Tail', 7, 0), dock('Head', 31, 0)]);
    const b = belt(31, 0, [dock('Tail', 30, 0), dock('Head', 22, 1)]);
    const flow = selectedNodePortFlow(FACTORY, [a], [], sceneOf([FACTORY, MERGE], [a, b]));
    expect(flow.get(OUT)?.reaches).toEqual({ node: 22, kind: 6, input: 2, inputs: 2 });
  });

  it('a belt ending on open floor, a ring and an arriving belt reach nothing', () => {
    const open = belt(30, 1, [dock('Tail', 7, 0)]);
    expect(selectedNodePortFlow(FACTORY, [open], [], sceneOf([FACTORY], [open])).get(OUT)?.reaches).toBeUndefined();
    const a = belt(40, 0, [dock('Tail', 7, 0), dock('Head', 41, 0)]);
    const b = belt(41, 0, [dock('Tail', 40, 0), dock('Head', 40, 0)]);
    expect(selectedNodePortFlow(FACTORY, [a], [], sceneOf([FACTORY], [a, b])).get(OUT)?.reaches).toBeUndefined();
    const arriving = belt(50, 1, [dock('Head', 7, 0), dock('Tail', 20, 0)]);
    expect(selectedNodePortFlow(FACTORY, [arriving], [], sceneOf([FACTORY, SINK], [arriving])).get(0)?.reaches).toBeUndefined();
  });
});
