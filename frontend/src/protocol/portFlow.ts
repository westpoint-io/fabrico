// portFlow.ts (PANEL-04, phase 91 CHROME-13) - the selected node's per-port live
// presence and state (idle, moving, backed up), correlated ENTIRELY in the frontend
// from data the render packet already carries. No core change, no protocol change,
// no new wire field (Tier A).
//
// The packet is deliberately split: a `NodeView` carries its ports but no flow,
// and a `BeltView` carries the ITEMS plus the DOCKS naming which node/port each
// end attaches to. Items ride on BELTS, never on nodes. So "what is moving at
// this port" only exists as the JOIN of the two - which is what this file is.
//
// Keyspace discipline: the dock->port resolution is `dockPort` from ports.ts,
// imported verbatim. It is the single reader of all three dock keyspaces (Head
// raw catalog index / Tail Out routing key / 65535 fault sentinel) and it
// already degrades an out-of-range or non-spatial value to `null` rather than
// throwing (T-21-02). Re-implementing that here would be the Don't-Hand-Roll
// violation that puts the panel a keyspace out of step with the canvas.
//
// Presence is tracked independently of the flow state: a docked belt carrying
// zero items is `{docked: true, carrying: false}` - the "idle" step - and is NOT
// the same state as an unconnected port.
//
// THE BACKED-UP RULE (phase 91, D-12, CHROME-13, research Finding E, UI-SPEC 8.5 as
// amended in plan 91-07). A port row used to read `{n} moving`, the item count on
// its belt, so a belt jammed solid read `12 moving` while nothing on it could move.
// The row now reads a state, and the state is built from three packet facts:
//
//   1. The belt's items BY SLOT INDEX. On the wire `ItemView.arrival_tick` IS the
//      slot index (`render_packet.rs` writes `arrival_tick: i as u64` from
//      `enumerate()`; `sceneState.ts` calls it the Phase-14 legacy misnomer), and
//      slot 0 is the HEAD, the delivery end (`belt_slots.rs`). It is never a tick.
//      The UI-SPEC's first rule ("an item whose arrival_tick is below the packet
//      tick is overdue") read it as one, which calls every belt with items past
//      its first few ticks backed up. Nothing here compares `arrival_tick` with a
//      tick.
//   2. The belt's own HEAD dock, resolved through `dockPort` like every other
//      dock read in this file.
//   3. What is at the head end: a consumer node's `load` against `LOAD_FULL` (its
//      fullest mechanical inbox port at the admission cap), or a joined belt's own
//      ENTRY slot (its tail, `latency - 1`, since `latency` is the slot count on the
//      wire).
//
// A belt is BACKED UP when its head item cannot leave: its head slot holds an item AND
// its head docks nowhere, or docks into a node whose inbox is full (`load ===
// LOAD_FULL`), or joins a belt whose entry slot is taken and which is itself backed up
// (followed at most `JOIN_HOP_LIMIT` hops, stopping on a repeat). A head item that
// docks into a node with room reads moving: the core delivers slot 0 on the next due
// advance. See `beltBackedUp`.
//
// WHY `load` AND NOT `state` (phase 91 review WR-A-01, WR-A-02). The state byte answers
// a different question, "what is this machine doing", in the host's order FAULTED,
// refusing, WORKING, waiting, IDLE. So a faulted machine with a full inbox reads FAULTED
// (and its belt read moving on a jam), and a machine waiting behind its blocked output
// reads BACKED_UP with room in its inbox (and a belt still feeding it read backed up).
// `load === LOAD_FULL` is the host's own refusing test (`is_refusing` and the gauge's
// top band agree by `derive_load_bands_and_the_cross_invariant`).
//
// THE ONE STATED LIMIT. The packet carries one `load` per machine, for its fullest
// port, not one per port. On a fan-in machine (a Merge, a Balancer) with one full In, a
// belt whose head item waits at another In that has room reads backed up. The core
// delivers a head item on the tick it can, so a belt into a free port rarely shows one
// at its head; the UI-SPEC (8.5, A11) records the limit. A per-port fill on the wire is
// the fix if the walk ever sees it.

import type { BeltDockView, BeltEnd, BeltView, NodeView, WireView } from './decode.ts';
import { LOAD_FULL } from './kinds.ts';
import { dockPort, PORT_ROLE } from './ports.ts';

// SCOPE (WR-04, WIDENED by Phase 66 / WIRE-05): this join reads `belt.docks` AND
// `wire.from` / `wire.to`. `docked` means "a BELT end or a WIRE endpoint resolves
// here", which is the whole set of things that can name a port: a `WireLink`
// (state.rs:1269) is the only other one.
//
// It used to read belts alone, and the note here said so with a trigger attached:
// wire endpoints are raw CATALOG indices, they DO shift when an earlier port is
// removed, and that was harmless only because the sole production wire minter was
// the demo scene binding an In port that precedes every Out. Phase 66 shipped the
// palette Wire tool (66-01) and the placeable HTTP Endpoint (66-04), so a user
// mints wire endpoints by hand now and the trigger has fired. Without the wire
// loop below this map would go on reporting a wired port as free, and every
// consumer of `docked` - the Disconnect control, the Add advisory - would go with
// it.
//
// THE READER THIS PARAGRAPH USED TO SEND SOMEWHERE IS GONE, and the correction is
// the point rather than a tidy-up. It named a frontend dock-safety gate that
// refused to OFFER a removal the core could not survive, and said the core still
// performed one if asked because `fold_remove_port` dropped the port and never
// touched `links`. Plan 73-06 made that false for BELTS: the fold re-points every
// route, dock and default keyed to the removed port and releases exactly the belt
// that was on it, with a compensating `Dock` on the undo. So 73-08 deleted the gate.
//
// 73-12 CORRECTS THE SENTENCE THAT STOOD HERE, WHICH SAID "every route, dock and
// default" AND MEANT BELTS ONLY. 73-REVIEW's CR-02 measured it: `judge_docks`
// collected a candidate only where the neighbour was a `Node::Belt`, so a WIRE
// endpoint - a raw catalog index, the same keyspace a Head dock uses - never moved
// at all. Where the two rules now stand, since they are NOT the same rule:
//
//   - A wire endpoint ABOVE the removed port SHIFTS with the list, through the same
//     `judge_docks` verdict a Head dock takes (`fold_remove_port`, `fold_add_port`).
//   - Removing the port a cable is attached to is REFUSED at the command layer,
//     `CommandError::PortOccupied`, because the core's release of that cable is the
//     right end state but is not invertible from a `RemovePort` record. That refusal
//     is in `validate_normalize`'s `RemovePort` arm, NOT in this package.
//
// Both are asserted by `crates/fabrico-core/tests/remove_port_repoint.rs` and
// `crates/fabrico-host/tests/undo_on_demo_board.rs`, not in this package at all.

/**
 * WHICH link is attached at a port, resolved by the same join that decides
 * `docked` (CONNECT-01). `docked` alone answers "is there anything here"; this
 * answers "what, exactly", which is what a Disconnect click has to name.
 *
 * The two variants are two MEDIUMS and they take two different verbs at the
 * emit site (decision D1, `67-CONTEXT.md`), so the union is discriminated rather
 * than a bag of optional fields: a `belt` link becomes `GridCommand::Unlink` and
 * a `wire` link becomes `GridCommand::Delete { node: wireId }`. See the
 * `onDisconnect` docblock in `ConfigPanel.tsx` for why an `Unlink` on a wire is
 * a no-op the user cannot see.
 *
 * NO PORT NUMBER RIDES HERE, deliberately. The `Unlink` command's `port` field
 * is the SPATIAL CATALOG index, which is exactly the key this map is keyed by
 * (`PortView.index`, resolved through `dockPort` — the single reader of the
 * three belt dock keyspaces). The emit site reads it off the row's own
 * `port.index`, so the number exists in ONE place and a second copy can never
 * drift out of keyspace. Storing it here would be the hand-rolled reverse map
 * this file's belt loop comment already forbids.
 */
export type PortLink =
  | {
      kind: 'belt';
      /** The belt's dense render handle (`BeltView.id`) — `Unlink`'s `belt`. */
      belt: number;
      /** Which END of that belt docks here, read VERBATIM off
       *  `BeltDockView.end` — `Unlink`'s `endpoint`. Head/Tail is not derivable
       *  from the port; it is a property of the dock record. */
      end: BeltEnd;
      /**
       * LINK-09: the link's TARGET SIDE (`Unlink`'s `node` and `port`) when the
       * row's own panel subject is NOT that side.
       *
       * WHY THIS EXISTS, AND WHY IT IS NOT THE REVERSE MAP THE DOCBLOCK ABOVE
       * FORBIDS. `Unlink`'s `node`/`port` name the side of the link that is NOT
       * the carrier belt. On a MACHINE panel that side is always the panel's own
       * subject, so the emit site closes over the selected handle and reads
       * `port.index` off the row, and there is exactly one copy of both numbers.
       * That stops being true the moment the panel subject is a BELT: on a belt's
       * `Outputs` row the panel subject IS the carrier, and the target is the
       * NEIGHBOUR the Head delivers into. That neighbour's handle and its port are
       * not derivable from this belt's own row. They are properties of the dock
       * record, exactly as `end` above is, so they ride here rather than being
       * reconstructed. The forbidden thing is deriving a port number the row
       * already holds; this is a port number on a DIFFERENT node.
       *
       * OPTIONAL, and the degrade direction is deliberate. Absent means "the
       * panel's own subject is the target side", which is the shipped machine-row
       * behaviour byte for byte, so `selectedNodePortFlow` sets it nowhere and no
       * existing fixture moves. A belt Head row that FORGOT to set it emits
       * `{belt: B, end: Head, node: B, port: 1}`, and the command layer refuses
       * that on the direction rule (`command.rs`'s `Unlink` arm: a Head unlink
       * must name a `Role::In`, and index 1 on a belt is the `Role::Out` Head).
       * So the omission fails CLOSED at the host, on a typed refusal, rather than
       * removing a link the user did not point at (T-74-33).
       */
      target?: { node: number; port: number };
    }
  | {
      kind: 'wire';
      /** The wire node's dense render handle (`WireView.id`) — the `node` field
       *  of the `Delete` this link dispatches (D1). Wires share the dense handle
       *  space with nodes and belts (`sceneState.ts`), so this is directly
       *  deletable. */
      wire: number;
    };

/**
 * The machine a belt leaving a port reaches (phase 91, D-12, CHROME-13, UI-SPEC 8.6):
 * the Router's outputs are named by it. Followed from the belt's Head through any
 * joined belts (`beltReaches`).
 */
export interface PortReach {
  /** The reached machine's dense render handle. */
  node: number;
  /** Its kind byte (`machine_kind`); the panel names it through `KIND_NAMES`. */
  kind: number;
  /** The 1-based position, among the reached machine's In ports, of the port the
   *  chain docks into (0 if that port is not an In, which no legal board makes). */
  input: number;
  /** How many In ports the reached machine has: ` input K` is named only at 2 or more. */
  inputs: number;
}

/** One port's live flow: is a belt or wire attached, and what is its belt doing. */
export interface PortFlow {
  /** True iff at least one BELT end OR one WIRE endpoint resolves to this port
   *  (the Disconnect control and the Add advisory read this as their dock-presence
   *  input). Presence is an OR over both sources; see the SCOPE note above for why
   *  the wire half exists and what it does not promise. */
  docked: boolean;
  /** At least one BELT docked here carries an item. A wire never does: its pulses
   *  live about two ticks, so folding them in would make the row flicker. */
  carrying: boolean;
  /** At least one BELT docked here is backed up (`beltBackedUp`). A fan-in port
   *  reads backed up if any of its belts is. */
  backedUp: boolean;
  /** For a port a belt LEAVES (the belt's Tail docks here): the machine that belt
   *  reaches, when the chain ends on one. Absent on open floor, on an In port and on
   *  a wired port. The last belt scanned wins, as for `link`. */
  reaches?: PortReach;
  /**
   * WHICH link is attached (CONNECT-01), when the join could resolve one.
   * Always set alongside `docked = true` by both loops below; `undefined` on
   * every undocked entry.
   *
   * OPTIONAL, and the direction of that choice is the point rather than a
   * convenience. Two reasons, both load-bearing:
   *
   * 1. It is a PURE ADDITION to a shape test files construct as literals, and an
   *    entry with nothing docked has no link to name.
   *
   * 2. The degrade direction is FAIL-CLOSED. An entry with no resolvable link
   *    renders NO Disconnect control at all: the verb fails closed by not being
   *    offered, rather than by offering a control that guesses which link it
   *    addresses. An absent control cannot send a wrong command. This is the
   *    OPPOSITE of the WR-01 remove-gate hazard, where the missing value's
   *    default (`docked: false`) would have ENABLED a destructive action, which
   *    is why `flow` itself is required and this field is not. Do not "fix" this
   *    into a required field: the safety argument that made `flow` non-optional
   *    does not transfer, and it points the other way here.
   */
  link?: PortLink;
}

/**
 * Per-port `{docked, carrying, backedUp}` for one node, keyed by `PortView.index`.
 *
 * EVERY port index is present in the returned map (initialised to
 * `{docked: false, carrying: false, backedUp: false}`), so a caller renders straight off `flow.get(index)`
 * without a presence branch of its own; a portless node yields an empty map.
 *
 * ONE LINK PER PORT. That is a MEASURED property of the core, not a convention
 * and not a hope (decision D3, `67-CONTEXT.md`, measured 2026-08-29). Four facts,
 * each read off the source rather than inferred:
 *
 *   1. The dock geometry check is `(mcell + unit_delta(mside)) != end_cell ->
 *      InvalidDock` (`command.rs:1084`; the inequality and its return sit at
 *      :1085-1086). EXACTLY ONE cell satisfies it per port.
 *   2. Two belts cannot both occupy that one cell. `view.occupied(t.cell)`
 *      rejects the WHOLE path with `FootprintCollision` (`command.rs:971`), so
 *      belts never overlap - in either dock direction.
 *   3. A belt and a wire cannot share a port either. `mediums_compatible` gates a
 *      belt to a `Medium::Mechanical` port (`command.rs:1075`) and a wire needs an
 *      Electrical one. A port is one medium or the other, never both.
 *   4. `links` is `BTreeMap<(NodeId, PortId), (NodeId, PortId)>`
 *      (`state.rs:1137`) - one key, one value.
 *
 * So the OR over several belts below survives ONLY as hostile-packet degradation, and it
 * is kept for exactly that: a forged or stale packet CAN present two docks on one
 * port, and the join must go on folding rather than throwing (T-51-03). No
 * legal board produces one. Do not read the sum as a topology claim, and do not
 * build a multi-link branch or a disabled-reason copy for a state the core cannot
 * produce - `entry.link` takes the last belt scanned for that same reason (see the
 * belt loop's own comment). Until decision D3 measured it, this paragraph asserted
 * the OPPOSITE, and a reader who believed that version would have built the
 * branch - which is why the four citations above are here rather than a claim.
 *
 * ONE MEASURED HOLE, ledgered rather than smoothed over: fact 1 covers the
 * SPATIAL dock path only. The non-spatial `FAULT_PORT` (`u16::MAX`) branch skips
 * ALL geometry, so a CRAFTED command - never any shipped gesture - can still
 * overwrite a fault port's link. This is recorded as threat `T-67-04-01` (a known
 * FAULT_PORT silent-overwrite gap); the fix is a `Dock` occupancy
 * guard in the command layer and is not this file's to make.
 *
 * A WIRE contributes `docked: true` and nothing else (UI-SPEC 9) - `carrying` and
 * `backedUp` are about belt items, while a wire pulse lives about two ticks, so
 * folding pulses in would make the row flicker meaninglessly. A wired port reads
 * `idle`, which is the truth about it.
 *
 * Hostile input degrades, never throws: a dock or wire endpoint naming another
 * node is skipped, a dock whose keyspace value `dockPort` cannot resolve
 * (out-of-range Out routing key, a fault sentinel on a node with no spatial fault
 * port) credits NO port, and an out-of-range wire port index credits no port
 * either - the row simply reads "not connected" (T-51-03).
 *
 * @param node  The selected node, with its live packet `ports`.
 * @param belts The scene's belts (`SceneState.belts.values()` at the call site).
 * @param wires The scene's wires (`SceneState.wires.values()` at the call site).
 *              Passed WHOLE and scanned, with no reverse index - see the note at
 *              the loop.
 * @param scene The packet's nodes and belts by handle (`SceneState` at the call
 *              site), read by handle only: where a docked belt's Head goes (a
 *              machine, whose `state` the backed-up rule reads, or a joined belt)
 *              and what the chain reaches. REQUIRED: without it no head consumer
 *              resolves, and every belt with a head item would read backed up.
 */
export function selectedNodePortFlow(
  node: NodeView,
  belts: Iterable<BeltView>,
  wires: Iterable<WireView>,
  scene: PacketLookup,
): Map<number, PortFlow> {
  const flow = new Map<number, PortFlow>();
  for (const port of node.ports) {
    flow.set(port.index, { docked: false, carrying: false, backedUp: false });
  }

  for (const belt of belts) {
    for (const dock of belt.docks) {
      if (dock.node !== node.id) {
        continue;
      }
      const port = dockPort(node, dock);
      if (port === null) {
        continue;
      }
      const entry = flow.get(port.index);
      // A resolved port is always one of `node.ports`, so `entry` exists; the
      // guard keeps the function total rather than trusting that invariant.
      if (!entry) {
        continue;
      }
      entry.docked = true;
      // CONNECT-01: capture WHAT is attached on the same line that records THAT
      // something is. `belt.id` and `dock.end` are both already in scope here and
      // were thrown away until now, which is the whole reason the Disconnect
      // control could not exist. `dock.end` rides VERBATIM: `Unlink`'s `endpoint`
      // is `Dock`'s `endpoint`, the same field the dock record carries.
      //
      // The port number is deliberately NOT stored — see the `PortLink` docblock.
      // `port.index` (the resolved SPATIAL CATALOG index) is this map's key, so
      // the emit site already has it and there is exactly one copy of it.
      //
      // On the unreachable-but-tolerated two-belts-on-one-port packet the LAST
      // belt scanned wins. That state is not producible by the core (D3: the dock
      // geometry check admits exactly one belt per port, and belts cannot
      // overlap), so this is the degradation rule for a hostile/stale packet, not
      // a topology decision: the state still folds as an OR, and the offered Disconnect
      // addresses one real link rather than none.
      entry.link = { kind: 'belt', belt: belt.id, end: dock.end };
      // CHROME-13: the state, an OR over every belt docked here. A count is never
      // kept: no row shows one.
      if (belt.items.length > 0) {
        entry.carrying = true;
      }
      if (beltBackedUp(belt, scene, node)) {
        entry.backedUp = true;
      }
      // UI-SPEC 8.6: a belt LEAVING this port (its Tail docks here) names what it
      // reaches. A Head dock here is a belt arriving, which reaches this node.
      if (dock.end === 'Tail') {
        const reach = beltReaches(belt, scene, node);
        if (reach === undefined) {
          delete entry.reaches;
        } else {
          entry.reaches = reach;
        }
      }
    }
  }

  // WIRE-05: the second presence source. Same shape as the belt loop above and
  // the same totality contract, with two differences that are both deliberate.
  //
  // 1. `dockPort` IS NOT USED HERE, and a "simplification" into it would be a
  //    silent keyspace bug rather than a compile error. `dockPort` is the reader
  //    of the three BELT dock keyspaces: a Head raw catalog index, a Tail Out
  //    ROUTING key (the nth role===1 port), and the 65535 fault sentinel. A wire
  //    endpoint is a raw positional `PortId` in a FOURTH keyspace `dockPort` has
  //    never heard of, so routing it through would apply the Out-routing-key
  //    translation to a number that is already a catalog index - on a two-port
  //    Endpoint that turns "Out at catalog 1" into "the second Out", which does
  //    not exist. `flow` is keyed by `PortView.index`, and that IS the same
  //    number: the host resolves an endpoint with `view.ports_of(id).get(port)`,
  //    a positional index into the declared port list, and the render packet
  //    emits `PortView { index: i as u16 }` from `.iter().enumerate()` over that
  //    same list. So look the endpoint up directly.
  //
  // 2. `carrying` and `backedUp` are untouched. See the docblock: a wire is
  //    presence, never items.
  //
  // The scene's wires are scanned WHOLE, with no reverse index, and that is not
  // an oversight about the WR-06 lesson - it is that lesson applied rather than
  // copied. `beltsDockedTo` exists because its join was every-belt-by-every-dock
  // at ~10Hz on a board with hundreds of belts. A maximal v8.0 board is about
  // eight wires with exactly two endpoints each: sixteen comparisons at ~10Hz. A
  // second index would be more code than the scan it replaces and would need its
  // own retraction discipline inside `applyPacket`, which is a place where a bug
  // is invisible.
  for (const wire of wires) {
    for (const end of [wire.from, wire.to]) {
      if (end.node !== node.id) {
        continue;
      }
      const entry = flow.get(end.port);
      // An out-of-range endpoint is the ORDINARY consequence of the very defect
      // this fold mitigates (a port removed under a live wire), so this guard is
      // load-bearing rather than defensive: it must credit nothing and continue,
      // exactly as an unresolvable belt dock does.
      if (!entry) {
        continue;
      }
      entry.docked = true;
      // CONNECT-01 / decision D1: the wire's own render handle, captured on the
      // same line that records presence. It is looked up through `flow.get` above
      // and NOT through `dockPort` for the reason point 1 states - and the link
      // carries no port and no end, because a wire endpoint has neither: `Delete`
      // takes one field, the wire node itself.
      //
      // BOTH endpoints get one. A wire SOURCE has no `links` entry in the core at
      // all, but `WireView` is projected from the wire node's own `from`/`to`
      // fields, so both ports read `docked: true` here and both must therefore
      // offer the verb. Offering it on one end only would leave the cable
      // undismissable from the other machine's panel.
      entry.link = { kind: 'wire', wire: wire.id };
    }
  }

  return flow;
}

/**
 * What `selectedNodePortFlow` and the belt panel read by handle (`SceneState`
 * satisfies it): the packet's machines and belts. Never scanned, only looked up.
 */
export interface PacketLookup {
  readonly nodes: ReadonlyMap<number, NodeView>;
  readonly belts: ReadonlyMap<number, BeltView>;
}

/** The head slot's index (`belt_slots.rs`: slot 0 = HEAD, the delivery end). */
export const HEAD_SLOT = 0;

/** The most joins a belt walk follows (a belt Head docked into another belt's Tail)
 *  before it stops. A chain longer than this reads as not backed up and reaching
 *  nothing, rather than a walk that can run for the length of the board. */
export const JOIN_HOP_LIMIT = 64;

/** True iff the belt's head slot holds an item. `arrival_tick` is the SLOT INDEX
 *  on the wire (see the file header), so this is a slot test, never a tick test. */
export function headSlotOccupied(belt: BeltView): boolean {
  return belt.items.some((item) => item.arrival_tick === HEAD_SLOT);
}

/** True iff the belt's ENTRY slot, its tail, holds an item, so it can take nothing
 *  from a belt joined into it. `latency` is the slot count on the wire
 *  (`render_packet.rs`: `slots.len().max(1)`), so the tail is `latency - 1`. */
export function tailSlotOccupied(belt: BeltView): boolean {
  const tail = Math.max(1, Math.floor(belt.latency)) - 1;
  return belt.items.some((item) => item.arrival_tick === tail);
}

/** True iff the machine takes no more from a belt: its fullest mechanical inbox port is
 *  at the cap (`load === LOAD_FULL`), whatever its state byte says (file header). */
export function machineRefusesDelivery(node: NodeView): boolean {
  return node.load >= LOAD_FULL;
}

/** Where a belt's Head goes: a joined belt, a machine, or nowhere (no Head dock, or
 *  a Head dock naming a handle the packet does not hold or a port `dockPort`
 *  cannot resolve). `self` is the panel's own node, so a belt arriving at the
 *  selected machine resolves without a map lookup. */
type HeadEnd =
  | { to: 'nowhere' }
  | { to: 'belt'; belt: BeltView }
  | { to: 'machine'; node: NodeView; dock: BeltDockView };

function headEnd(belt: BeltView, scene: PacketLookup, self: NodeView | undefined): HeadEnd {
  const head = belt.docks.find((d) => d.end === 'Head');
  if (head === undefined) {
    return { to: 'nowhere' };
  }
  const joined = scene.belts.get(head.node);
  if (joined !== undefined) {
    return { to: 'belt', belt: joined };
  }
  const consumer = self !== undefined && self.id === head.node ? self : scene.nodes.get(head.node);
  if (consumer === undefined || dockPort(consumer, head) === null) {
    return { to: 'nowhere' };
  }
  return { to: 'machine', node: consumer, dock: head };
}

/**
 * The backed-up rule (file header, UI-SPEC 8.5 as amended in plan 91-07 and the phase
 * 91 review): the belt's head item cannot leave. Its head slot holds an item AND its
 * head docks nowhere, docks into a node that refuses a delivery
 * ({@link machineRefusesDelivery}), or joins a belt whose entry slot is taken
 * ({@link tailSlotOccupied}) and which is itself backed up.
 *
 * The join walk stops on a repeat (a ring of belts) and after `JOIN_HOP_LIMIT`
 * joins, and both stops read NOT backed up: the walk could not prove the jam, and
 * a word that cries jam on a ring that still turns is worse than one that says
 * moving.
 */
export function beltBackedUp(belt: BeltView, scene: PacketLookup, self?: NodeView): boolean {
  const seen = new Set<number>();
  let cur: BeltView = belt;
  for (let hop = 0; hop <= JOIN_HOP_LIMIT; hop += 1) {
    if (seen.has(cur.id)) {
      return false;
    }
    seen.add(cur.id);
    if (!headSlotOccupied(cur)) {
      return false;
    }
    const end = headEnd(cur, scene, self);
    if (end.to === 'nowhere') {
      return true;
    }
    if (end.to === 'machine') {
      return machineRefusesDelivery(end.node);
    }
    // A joined belt with a free entry slot takes this belt's head item on the next
    // advance, however jammed its own head is (review WR-A-02 (a)).
    if (!tailSlotOccupied(end.belt)) {
      return false;
    }
    cur = end.belt;
  }
  return false;
}

/**
 * The machine a belt reaches (UI-SPEC 8.6): its Head followed through any joined
 * belts to the first machine, stopping on a repeat or after `JOIN_HOP_LIMIT` joins.
 * Undefined when the chain ends on open floor, loops, or runs past the limit.
 */
export function beltReaches(belt: BeltView, scene: PacketLookup, self?: NodeView): PortReach | undefined {
  const seen = new Set<number>();
  let cur: BeltView = belt;
  for (let hop = 0; hop <= JOIN_HOP_LIMIT; hop += 1) {
    if (seen.has(cur.id)) {
      return undefined;
    }
    seen.add(cur.id);
    const end = headEnd(cur, scene, self);
    if (end.to === 'nowhere') {
      return undefined;
    }
    if (end.to === 'machine') {
      const ins = end.node.ports.filter((p) => p.role === PORT_ROLE.IN);
      const port = dockPort(end.node, end.dock);
      return {
        node: end.node.id,
        kind: end.node.kind,
        input: port === null ? 0 : ins.indexOf(port) + 1,
        inputs: ins.length,
      };
    }
    cur = end.belt;
  }
  return undefined;
}
