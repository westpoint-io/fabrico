//! `fold_draw_wire` is TOTAL over forged edit-log records (WIRE-01, threat T-63-02),
//! and a folded wire is byte-identical to a directly minted one.
//!
//! An edit-log file on disk is untrusted input. `apply_edit` applies every record
//! VERBATIM with no re-validation (decision Q2), so a `DrawWire` record naming nodes
//! and ports that do not exist reaches `fold_draw_wire` unfiltered. WIRE-01 requires
//! that this NEVER panics, and requires it proved over malformed records rather than
//! asserted in a comment.
//!
//! This suite proves four things:
//!   1. **Totality** (proptest): for arbitrary `(from_node, from_port, to_node,
//!      to_port)` quadruples drawn from a pool mixing live ids, dangling ids and
//!      arbitrary raw port indices, folding a `DrawWire` ALWAYS RETURNS - never panics,
//!      never aborts. A returning test IS the no-panic proof.
//!   2. **Per-case behaviour** (focused cases): each of the eight forged shapes, with
//!      its minted-versus-not outcome stated and asserted. Three write NOTHING (an
//!      endpoint is not live); five MINT, because the fold does not re-validate and
//!      the reject for each of them lives at command-validate time.
//!   3. **Genesis identity**: a grid built by folding `EditOp::DrawWire` and a grid
//!      built by calling `add_wire` plus `link` directly are byte-identical. That is
//!      the in-crate half of WIRE-01's indistinguishability claim; the cross-crate half
//!      runs against the real demo seam in `fabrico-host`'s `headline.rs`.
//!   4. **The connect verb needs no new edit-log op** (plan 63-10, the `-- the connect
//!      verb` section below). `63-CONTEXT.md` states that Phase 67's connect and
//!      disconnect verbs need no new `EditOp`, because `EditOp::Dock` and
//!      `EditOp::Unlink` already reach a wire. That claim was ARGUED from the source.
//!      These cases MEASURE it: a `Dock` naming a wire reproduces a drawn wire's
//!      forward link byte for byte, an `Unlink` removes exactly it and nothing else,
//!      the pair round-trips, and a forged one writes zero state bytes.
//!
//! # What proof 4 did NOT cover when it was written, and how that gap was closed
//! The claim was true at the FOLD and false one layer up. Until phase 74,
//! `validate_normalize`'s Dock arm read `GridLookup::belt_geometry`, which answered
//! `None` for a `Wire`-minted belt, so a `GridCommand::Dock` naming a wire was refused
//! with `CommandError::InvalidDock`. `fabrico-command` is not frozen, so that was
//! ordinary later work rather than a missing keystone shape - but it was not free, and
//! it was recorded in `63-KEYSTONE-HANDOFF.md` under "The connect verb's real gap" so a
//! later phase would not discover it mid-implementation.
//!
//! PHASE 74 CLOSED IT (LINK-05, plan 74-06). `belt_geometry` now
//! answers `Some` with an empty tile list for a live `Node::Wire` in BOTH
//! implementations of the trait, and a Head `Dock` naming a wire reconnects it with the
//! same four fields an `Unlink` removed. The measurement is
//! `crates/fabrico-command/tests/wire_unlink_redock.rs`, which also pins the two
//! refusals that survive (a medium mismatch, and an already-linked key). This paragraph
//! stated the pre-74 behaviour in the present tense until plan 74-10 corrected it;
//! WINDOWS row 230 is that correction.
//!
//! Run target: `cargo test -p fabrico-core --test draw_wire`
//! (`PROPTEST_CASES=1024` in CI).
//!
//! # This file could only be created here
//! `golden_readme_currency.rs` records that checks 2 and 3 of
//! the core-freeze gate between them bar ANY new file under
//! `crates/fabrico-core`, and that no phase under the freeze can put one there. Phase
//! 63 is the only phase in v8.0 not under the freeze.

mod common;

use common::{header, state_bytes};
use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::Node;
use proptest::prelude::*;

/// The fixed genesis seed every grid in this suite is built from.
const SEED: u64 = 0x0063_0002_DEAD_BEEF;

/// A `NodeId` guaranteed absent from any grid built with `add_*` (which only ever
/// insert, so every live node id is version 1). Insert -> remove -> re-insert
/// reuses slot index 0 with a BUMPED version (2), so the id can never collide with
/// a live grid id — the rigorous "dangling id" the trust gate must reject.
fn ghost_id() -> NodeId {
    let mut foreign: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
    let k = foreign.insert(());
    foreign.remove(k); // frees slot 0, bumping its version
    foreign.insert(()) // slot 0, version 2 — distinct from any v1 grid id
}

/// A `DrawWire` edit record at sequence/tick 0, the shape a decoded log hands the fold.
fn forged(from_node: NodeId, from_port: PortId, to_node: NodeId, to_port: PortId) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::DrawWire {
            from_node,
            from_port,
            to_node,
            to_port,
        },
    }
}

/// A grid with two live source nodes, the minimal pair a wire can name.
fn two_nodes() -> (Core, NodeId, NodeId) {
    let mut core = Core::genesis(header(SEED));
    let a = core.state.add_source();
    let b = core.state.add_source();
    (core, a, b)
}

/// One live wire, flattened for assertion: its id, its two logical endpoints, and how
/// many messages sit in its FIFO.
type WireShape = (NodeId, (NodeId, PortId), (NodeId, PortId), usize);

/// Every live `Node::Wire` in `core`, as [`WireShape`].
fn wires(core: &Core) -> Vec<WireShape> {
    core.state
        .node_ids()
        .filter_map(|id| match core.state.node(id) {
            Some(Node::Wire(w)) => Some((id, w.from, w.to, w.in_flight.len())),
            _ => None,
        })
        .collect()
}

/// Fold `record` and assert it changed ZERO `GridState` bytes and minted no node.
///
/// `state_bytes` is the shared whole-`Core` snapshot oracle. `common/mod.rs` records
/// that there is deliberately a SINGLE digest path and that a second, field-walking
/// one must never be added, so the zero-change claim is made against it and not
/// against a hand-written field comparison.
fn assert_wrote_nothing(core: &mut Core, record: EditRecord) {
    let before_nodes = core.state.node_count();
    let before = state_bytes(core);
    core.advance_edits(&[record], &[]);
    // The tick counter advances on ANY tick, so compare state at the same tick: fold a
    // second, EMPTY tick into the baseline grid rather than weakening the oracle.
    let mut control = {
        let mut c = Core::genesis(header(SEED));
        c.state.add_source();
        c.state.add_source();
        c
    };
    control.advance_edits(&[], &[]);
    assert_eq!(
        state_bytes(core),
        state_bytes(&control),
        "a forged DrawWire must leave state byte-identical to an empty tick"
    );
    assert_eq!(
        core.state.node_count(),
        before_nodes,
        "a forged DrawWire with a dead endpoint mints no node"
    );
    assert!(
        wires(core).is_empty(),
        "a forged DrawWire with a dead endpoint mints no wire"
    );
    // `before` is captured for the reader: it is the pre-fold digest, and the control
    // above is the same digest advanced one empty tick. Asserting against the control
    // is strictly stronger (it also pins that nothing ELSE moved during the tick).
    assert_ne!(
        before,
        state_bytes(core),
        "the tick counter did advance, so the comparison above is not vacuous"
    );
}

/// Fold `record` and assert it DID mint exactly one wire with the given endpoints.
///
/// The four (here five) minting cases assert the positive outcome explicitly. A test
/// that would still pass if the fold silently did nothing is not evidence about a fold
/// whose job is to mint.
fn assert_minted(
    core: &mut Core,
    record: EditRecord,
    from: (NodeId, PortId),
    to: (NodeId, PortId),
) -> NodeId {
    let before_nodes = core.state.node_count();
    core.advance_edits(&[record], &[]);
    assert_eq!(
        core.state.node_count(),
        before_nodes + 1,
        "the fold minted exactly one node"
    );
    let live = wires(core);
    assert_eq!(live.len(), 1, "exactly one Node::Wire exists");
    let (wire, got_from, got_to, in_flight) = live[0];
    assert_eq!(got_from, from, "WireLink.from is applied verbatim");
    assert_eq!(got_to, to, "WireLink.to is applied verbatim");
    assert_eq!(in_flight, 0, "a freshly minted wire's FIFO is empty");
    assert_eq!(
        core.state.link_target((wire, 0)),
        Some(to),
        "the fold recorded the ONE forward link out of the wire's own port 0"
    );
    assert!(
        core.state.inbox_of(wire).is_some(),
        "add_wire provisioned the inbox (T-63-16)"
    );
    assert!(
        core.last_tick.placed.contains(&wire),
        "the minted id is recorded in last_tick.placed"
    );
    wire
}

// --- The three cases that write NOTHING: an endpoint is not live (T-63-02) ---

/// T-63-02: `from_node` is a dangling `NodeId`. The guard returns before `add_wire`,
/// `link` and the `last_tick.placed` push, so there is no partial-mint state.
#[test]
fn dangling_from_node_writes_nothing() {
    let (mut core, _a, b) = two_nodes();
    assert_wrote_nothing(&mut core, forged(ghost_id(), 0, b, 0));
}

/// T-63-02: `to_node` is a dangling `NodeId`.
#[test]
fn dangling_to_node_writes_nothing() {
    let (mut core, a, _b) = two_nodes();
    assert_wrote_nothing(&mut core, forged(a, 0, ghost_id(), 0));
}

/// T-63-02: BOTH endpoints are dangling.
#[test]
fn both_endpoints_dangling_writes_nothing() {
    let (mut core, _a, _b) = two_nodes();
    assert_wrote_nothing(&mut core, forged(ghost_id(), 0, ghost_id(), 0));
}

// --- The five cases that DO mint: the fold does not re-validate (decision Q2) ---

/// A self-loop MINTS. The fold does not re-validate; the reject lives at
/// command-validate time (`CommandError::IncompatiblePorts`). This test pins that
/// decision rather than leaving it to be rediscovered as a surprise later.
#[test]
fn self_loop_mints_a_wire() {
    let (mut core, a, _b) = two_nodes();
    assert_minted(&mut core, forged(a, 0, a, 0), (a, 0), (a, 0));
}

/// T-63-02: `from_port` indexes a port that does not exist on a live node. A wire is
/// minted whose logical source port nothing reads. Panic-free by construction: `links`
/// is a `BTreeMap` and the fold indexes no slice.
#[test]
fn out_of_range_from_port_mints_a_wire_no_panic() {
    let (mut core, a, b) = two_nodes();
    assert_minted(
        &mut core,
        forged(a, u16::MAX, b, 0),
        (a, u16::MAX),
        (b, 0),
    );
}

/// T-63-02: `to_port` indexes a port that does not exist. Same shape, same reason.
#[test]
fn out_of_range_to_port_mints_a_wire_no_panic() {
    let (mut core, a, b) = two_nodes();
    assert_minted(
        &mut core,
        forged(a, 0, b, u16::MAX),
        (a, 0),
        (b, u16::MAX),
    );
}

/// `to_node` is a `Node::Belt`. A wire is minted: medium legality is a command-layer
/// concern and the fold type-checks nothing about its endpoints, exactly as `fold_dock`
/// does not type-check that its `belt` argument is a belt.
#[test]
fn belt_target_mints_a_wire() {
    let mut core = Core::genesis(header(SEED));
    let a = core.state.add_source();
    let belt = core.state.add_belt(3);
    assert_minted(&mut core, forged(a, 0, belt, 0), (a, 0), (belt, 0));
}

/// `to_node` is another `Node::Wire`. Same reason. This is also the shape the request
/// transport itself uses (`step_wire` hops wire to wire), so it is legal topology, not
/// merely tolerated.
#[test]
fn wire_target_mints_a_wire() {
    let mut core = Core::genesis(header(SEED));
    let a = core.state.add_source();
    let b = core.state.add_source();
    let existing = core.state.add_wire((a, 0), (b, 0));
    let before_nodes = core.state.node_count();

    core.advance_edits(&[forged(a, 1, existing, 0)], &[]);

    assert_eq!(core.state.node_count(), before_nodes + 1, "one node minted");
    let live = wires(&core);
    assert_eq!(live.len(), 2, "the pre-existing wire plus the minted one");
    let minted = live
        .iter()
        .find(|w| w.1 == (a, 1))
        .expect("the minted wire carries the forged endpoints");
    assert_eq!(minted.2, (existing, 0), "it terminates at the other wire");
    assert_eq!(
        core.state.link_target((minted.0, 0)),
        Some((existing, 0)),
        "the forward link targets the other wire's port 0"
    );
}

// --- Totality ---

proptest! {
    // CI overrides with PROPTEST_CASES=1024; the in-source default keeps local runs
    // fast while still exercising the totality property broadly.
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Fold a `DrawWire` built from an arbitrary quadruple and assert the call
    /// RETURNS. The ids are drawn from a pool mixing LIVE grid ids, a `ghost_id()`
    /// that can never collide with one, and an id REMOVED from this very grid (a
    /// dangling id carrying a real slot index rather than slot 0). The ports are
    /// arbitrary raw `u16` indices, so most name no declared port at all.
    ///
    /// `NodeId` is a slotmap key with no public raw-index constructor, so "arbitrary
    /// raw index" is expressed on the PORT axis, where the type permits it, and on the
    /// node axis by the two distinct classes of genuinely dangling id above.
    ///
    /// The call returning at all is the no-panic proof. The post-condition is
    /// deliberately weak on purpose: a fold that minted, and a fold that returned
    /// early, are BOTH sanctioned outcomes here. Which one happens for which input is
    /// what the eight focused cases above pin.
    #[test]
    fn fold_draw_wire_is_total_over_forged_quadruples(
        fi in any::<prop::sample::Index>(),
        ti in any::<prop::sample::Index>(),
        from_port in any::<u16>(),
        to_port in any::<u16>(),
    ) {
        let mut core = Core::genesis(header(SEED));
        let a = core.state.add_source();
        let b = core.state.add_belt(2);
        let c = core.state.add_wire((a, 0), (b, 0));
        let doomed = core.state.add_source();
        core.state.remove_node(doomed); // a dangling id with a REAL slot index
        let pool = [a, b, c, doomed, ghost_id()];

        let from_node = pool[fi.index(pool.len())];
        let to_node = pool[ti.index(pool.len())];
        core.advance_edits(&[forged(from_node, from_port, to_node, to_port)], &[]);

        // Reaching this line is the proof. Assert the ONE structural invariant that
        // must hold whichever branch ran: a wire the FOLD minted always carries its own
        // forward link, so there is no half-applied record. Scoped to `last_tick.placed`
        // deliberately - the grid is seeded with a wire minted by a bare `add_wire`,
        // which legitimately has no link (that is the RETURN-wire shape), so a claim
        // over every live wire would be false for a reason that is not a defect.
        for &wire in &core.last_tick.placed {
            let Some(Node::Wire(w)) = core.state.node(wire) else {
                prop_assert!(false, "a DrawWire fold minted a non-wire node");
                unreachable!()
            };
            prop_assert_eq!(core.state.link_target((wire, 0)), Some(w.to));
            prop_assert!(core.state.inbox_of(wire).is_some());
        }
    }
}

// --- Genesis identity ---

/// A grid built by FOLDING `EditOp::DrawWire` and a grid built by calling `add_wire`
/// plus `link` directly are byte-identical.
///
/// This walks RESEARCH's six-item indistinguishability checklist. `state_bytes` (the
/// whole serialized `Core`) already covers five of them by construction, and each is
/// named below so a later reader can see it was checked rather than assumed:
///
///   1. `WireLink.from` / `to` / empty `in_flight` - inside the serialized node.
///   2. Exactly one `links` entry keyed `(wire, 0)` - the whole `links` map is
///      serialized, so an extra or missing entry moves the bytes.
///   3. The `NodeId` minted through `allocator.insert(())`, so the slotmap generation
///      matches - the id is the `nodes` map key and is serialized with it. This is the
///      item a field-by-field comparison would be tempted to skip, and it is exactly
///      the one that would catch a hand-rolled mint.
///   4. The `inboxes` entry - serialized.
///   5. No `claim_footprint`, no `set_cell`, no `set_ports`. A wire is cell-less; the
///      demo seam sets those on the endpoint and the factory, never on the wire. All
///      three maps are serialized, so any stray claim moves the bytes.
///
/// The sixth item, `last_tick.placed`, is `#[serde(skip)]` and therefore invisible to
/// the oracle, so it is asserted separately below.
#[test]
fn folded_wire_is_byte_identical_to_a_directly_minted_one() {
    // Grid A: mint through the fold.
    let (mut a_core, a1, a2) = two_nodes();
    a_core.advance_edits(&[forged(a1, 0, a2, 0)], &[]);

    // Grid B: mint through the seam the genesis demo scene uses, then fold an EMPTY
    // tick so both grids sit at the same tick boundary. The wire is minted BEFORE the
    // tick in B and DURING it in A, so both allocate it as the third node: allocation
    // ORDER is held identical rather than the comparison being weakened to a field set.
    let (mut b_core, b1, b2) = two_nodes();
    let b_wire = b_core.state.add_wire((b1, 0), (b2, 0));
    b_core.state.link((b_wire, 0), (b2, 0));
    b_core.advance_edits(&[], &[]);

    assert_eq!(
        state_bytes(&a_core),
        state_bytes(&b_core),
        "a folded wire and a directly minted wire produce identical state bytes"
    );

    // Item 6, which the oracle cannot see: only the FOLD records the minted id, and
    // that recording is what makes the undo inverse buildable.
    let a_wire = wires(&a_core)[0].0;
    assert_eq!(a_wire, b_wire, "both grids minted the same NodeId");
    assert!(
        a_core.last_tick.placed.contains(&a_wire),
        "the fold records the minted id in last_tick.placed"
    );
    assert!(
        b_core.last_tick.placed.is_empty(),
        "the direct add_wire seam records nothing: last_tick.placed is a FOLD signal"
    );
}

// --- The connect verb: `Dock` and `Unlink` already reach a wire (plan 63-10) ---
//
// `63-CONTEXT.md` records, as a decision taken before any of this code existed, that
// "The Phase 67 connect verb needs NO new EDIT-LOG op." The reasoning given is that
// `fold_dock` does not type-check that its `belt` argument is a belt, so
// `Dock { belt: wire_id, endpoint: Head, .. }` writes the same `(wire, 0) -> (to)` link
// `fold_draw_wire` writes. The reasoning is correct. These cases are the measurement
// that makes it evidence: two independently built grids compared byte for byte, rather
// than an inspection of the `links` map, which would miss anything the two grids differ
// in OUTSIDE that map.

/// Wrap `op` in the edit record shape a decoded log hands the fold, at sequence/tick 0.
///
/// [`forged`] is the `DrawWire`-specific spelling of this; the connect-verb cases need
/// `Dock` and `Unlink` records too, so the wrapper is factored out rather than copied.
fn record(op: EditOp) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op,
    }
}

/// The serialized `GridState` — nodes, inboxes, links, cells, footprints and ports.
///
/// The suite's primary oracle is [`state_bytes`], the whole serialized `Core`, and it
/// stays that way for every comparison between two grids sitting at the SAME tick. It
/// cannot be used to compare ONE grid across a fold: `Core`'s first serialized field is
/// the monotonic tick and every fold advances it, so a before/after equality over the
/// whole `Core` can never hold. Plans 63-03 and 63-05 both measured that wall and both
/// replaced the criterion with this one rather than weakening it to a field walk.
/// `GridState` is the strongest oracle that is genuinely a function of the topology.
fn grid_bytes(core: &Core) -> Vec<u8> {
    postcard::to_allocvec(&core.state).expect("serialize GridState")
}

/// **The claim, measured.** A `Dock` naming a WIRE reproduces a drawn wire byte for
/// byte.
///
/// Grid A mints the wire by folding `EditOp::DrawWire`, which mints the node AND writes
/// its one forward link in a single fold. Grid B splits those two halves: `add_wire`
/// mints the node with NO link (the bare return-wire shape: a wire minted with no link),
/// and `EditOp::Dock { belt: wire, endpoint: Head, node: to, port: to_port }` supplies
/// the link. `fold_dock`'s Head arm is `link((belt, 0), (node, port))`, and a wire's
/// forward link is exactly `(wire, 0) -> (to_node, to_port)`, so the two must agree.
///
/// The assertion is full serialized-state equality, not a `links` lookup. A `links`
/// inspection would pass even if the Dock path had also touched a cell, a footprint, an
/// inbox or the node store; this cannot.
///
/// Both grids sit at tick 1 when compared: A mints during the tick, B mints before it
/// and folds the Dock during it. Allocation ORDER is therefore held identical (the wire
/// is the third node in both) rather than the comparison being weakened.
#[test]
fn dock_naming_a_wire_reproduces_a_drawn_wire_byte_for_byte() {
    // Grid A: one DrawWire fold — mint plus link together.
    let (mut a_core, a1, a2) = two_nodes();
    a_core.advance_edits(&[forged(a1, 0, a2, 0)], &[]);

    // Grid B: the mint alone, then the link supplied by a Dock naming the wire.
    let (mut b_core, b1, b2) = two_nodes();
    let b_wire = b_core.state.add_wire((b1, 0), (b2, 0));
    assert_eq!(
        b_core.state.link_target((b_wire, 0)),
        None,
        "the bare add_wire seam writes NO link — the Dock below is what supplies it"
    );
    b_core.advance_edits(
        &[record(EditOp::Dock {
            belt: b_wire,
            endpoint: BeltEnd::Head,
            node: b2,
            port: 0,
        })],
        &[],
    );

    assert_eq!(
        state_bytes(&a_core),
        state_bytes(&b_core),
        "a Dock naming a wire reproduces a drawn wire's whole state byte for byte: \
         the connect verb needs no new edit-log op"
    );
    // Named explicitly, because it is the single link the whole claim rests on.
    assert_eq!(
        b_core.state.link_target((b_wire, 0)),
        Some((b2, 0)),
        "fold_dock's Head arm wrote the wire's canonical forward link"
    );
}

/// **The disconnect leg.** An `Unlink` naming a wire removes exactly that wire's
/// forward link and nothing else.
///
/// The grid deliberately carries a SECOND, unrelated link (a source offloading onto a
/// belt). A test with one link in the map would pass against an `unlink` that cleared
/// the whole map. This one would not.
///
/// The wire NODE survives the disconnect — `fold_unlink` removes a link, never a node —
/// which is what makes the reconnect leg below expressible as a `Dock` rather than as a
/// second `DrawWire`.
#[test]
fn unlink_naming_a_wire_removes_exactly_its_forward_link() {
    let (mut core, a, b) = two_nodes();
    let belt = core.state.add_belt(2);
    core.state.link((a, 1), (belt, 0)); // the unrelated link that must SURVIVE
    core.advance_edits(&[forged(a, 0, b, 0)], &[]);
    let wire = wires(&core)[0].0;
    assert_eq!(core.state.links_iter().count(), 2, "two links before the unlink");

    core.advance_edits(
        &[record(EditOp::Unlink {
            belt: wire,
            endpoint: BeltEnd::Head,
            node: b,
            port: 0,
        })],
        &[],
    );

    assert_eq!(
        core.state.link_target((wire, 0)),
        None,
        "the wire's forward link is gone"
    );
    assert_eq!(
        core.state.link_target((a, 1)),
        Some((belt, 0)),
        "the unrelated link is untouched — the unlink removed EXACTLY the named key"
    );
    assert_eq!(
        core.state.links_iter().count(),
        1,
        "exactly one link was removed"
    );
    assert!(
        matches!(core.state.node(wire), Some(Node::Wire(_))),
        "the wire NODE survives a disconnect — Unlink removes a link, never a node"
    );
}

/// **The reconnect leg.** Unlink then Dock returns the grid to byte-identical state.
///
/// This is the connect / disconnect / reconnect round trip `63-CONTEXT.md` promised
/// Phase 63 would prove rather than assert. The comparison is `GridState` rather than
/// the whole `Core` for the reason [`grid_bytes`] records: the tick advances on every
/// fold, so a whole-`Core` before/after equality is unattainable for ANY op.
///
/// The intermediate assertion is what stops the test passing vacuously: the unlink is
/// first proved to have MOVED the bytes, so a no-op pair could not satisfy it.
#[test]
fn unlink_then_dock_returns_a_wire_to_byte_identical_state() {
    let (mut core, a, b) = two_nodes();
    core.advance_edits(&[forged(a, 0, b, 0)], &[]);
    let wire = wires(&core)[0].0;
    let connected = grid_bytes(&core);

    core.advance_edits(
        &[record(EditOp::Unlink {
            belt: wire,
            endpoint: BeltEnd::Head,
            node: b,
            port: 0,
        })],
        &[],
    );
    let disconnected = grid_bytes(&core);
    assert_ne!(
        connected, disconnected,
        "the disconnect MOVED the state bytes, so the reconnect below is not vacuous"
    );

    core.advance_edits(
        &[record(EditOp::Dock {
            belt: wire,
            endpoint: BeltEnd::Head,
            node: b,
            port: 0,
        })],
        &[],
    );

    assert_eq!(
        connected,
        grid_bytes(&core),
        "disconnect then reconnect returns the wire to byte-identical state"
    );
}

/// **T-63-36, the Dock half.** A forged `Dock` naming ids that are not live is a
/// panic-free no-op that writes ZERO state bytes.
///
/// An edit log on disk is untrusted input and reaches `fold_dock` with no
/// re-validation. Three shapes are covered in one test because they share one guard:
/// `fold_dock` returns before either `link` call when EITHER endpoint is absent.
/// Returning at all is the no-panic proof; the byte equality is the no-dangling-link
/// proof.
#[test]
fn forged_dock_naming_a_dead_id_writes_zero_state_bytes() {
    let (mut core, _a, b) = two_nodes();
    core.advance_edits(&[forged(_a, 0, b, 0)], &[]);
    let wire = wires(&core)[0].0;
    let before = grid_bytes(&core);

    for (label, belt, node) in [
        ("dead belt handle", ghost_id(), b),
        ("dead machine handle", wire, ghost_id()),
        ("both handles dead", ghost_id(), ghost_id()),
    ] {
        core.advance_edits(
            &[record(EditOp::Dock {
                belt,
                endpoint: BeltEnd::Head,
                node,
                port: 0,
            })],
            &[],
        );
        assert_eq!(
            before,
            grid_bytes(&core),
            "a forged Dock with a {label} wrote zero GridState bytes"
        );
    }
}

/// **T-63-36, the Unlink half.** A forged `Unlink` naming ids that are not live is a
/// panic-free no-op that writes ZERO state bytes.
///
/// `fold_unlink` needs no missing-node guard at all: `GridState::unlink` of an absent
/// key is already a documented panic-free no-op, which is strictly safer than
/// `fold_dock`'s guard. Both endpoint directions are covered because they key on
/// DIFFERENT halves of the record — `Head` on `(belt, 0)`, `Tail` on `(node, port)` —
/// so one direction passing says nothing about the other.
#[test]
fn forged_unlink_naming_a_dead_id_writes_zero_state_bytes() {
    let (mut core, a, b) = two_nodes();
    core.advance_edits(&[forged(a, 0, b, 0)], &[]);
    let live_wire = wires(&core)[0].0;
    let before = grid_bytes(&core);

    for (label, endpoint, belt, node, port) in [
        ("Head keying on a dead belt", BeltEnd::Head, ghost_id(), b, 0),
        (
            "Tail keying on a dead machine",
            BeltEnd::Tail,
            live_wire,
            ghost_id(),
            0,
        ),
        (
            "Tail keying on a live node at a port carrying no link",
            BeltEnd::Tail,
            live_wire,
            a,
            u16::MAX,
        ),
        (
            "both handles dead",
            BeltEnd::Head,
            ghost_id(),
            ghost_id(),
            u16::MAX,
        ),
    ] {
        core.advance_edits(
            &[record(EditOp::Unlink {
                belt,
                endpoint,
                node,
                port,
            })],
            &[],
        );
        assert_eq!(
            before,
            grid_bytes(&core),
            "a forged Unlink ({label}) wrote zero GridState bytes"
        );
    }
    assert_eq!(
        core.state.link_target((live_wire, 0)),
        Some((b, 0)),
        "the LIVE wire's forward link survived every forged Unlink — none of them \
         removed a key they did not name"
    );
}
