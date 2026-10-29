//! Phase 69-02: the v8.0 milestone audit warning **W1**, persisted-log half: a
//! `Configure` undone BETWEEN a `DrawWire` and an `Unlink`, in ONE session, with phase
//! 68's N-belt grouped pace action sitting in the middle of the same undo stack.
//!
//! # The measured gap this file fills
//! W1 is not a suspicion, it is an arithmetic fact about the tree. Measured at HEAD,
//! `crates/fabrico-command/tests/undo_redo.rs` contains `DrawWire` 22 times and `Unlink`
//! twice and `Configure` **zero** times, so the phase-63-to-phase-67 interleave is already
//! covered and the phase-65/68 config shape has never appeared beside it. Measured at the
//! same HEAD, `crates/fabrico-host/tests/belt_run_pace.rs` (the only file carrying phase
//! 68's N-belts-under-one-action-id shape) contains `DrawWire` **zero** times and `Unlink`
//! **zero** times. The three v8.0 action shapes have therefore never met in one undo
//! stack. That a grouped undo behaves correctly beside a wire and an unlink is, at HEAD,
//! an assumption; this file turns it into a measurement (requirements WIRE-01, CONNECT-01,
//! CONNECT-03, BELT-02; ROADMAP SC3).
//!
//! # Why the same claim needs a second file in a second crate
//! `Host::enqueue_action_group` (`crates/fabrico-host/src/driver.rs:380`) is the seam the
//! shipped app groups on, and it is UNREACHABLE from here: `fabrico-host` depends on
//! `fabrico-command`, so the reverse edge cannot exist, and
//! `crates/fabrico-command/tests/deps_headless.rs` is a live fence holding this crate to
//! `fabrico-core` + `fabrico-protocol` + `serde`. So this file proves the interleave on the
//! PERSISTED LOG (three action shapes coexisting in one `Vec<EditRecord>`, undo and redo
//! across them surviving save, load and replay to the same `snapshot(core)`), and
//! `crates/fabrico-host/tests/composed_seam_interleave.rs` (plan 69-03) proves the same
//! interleave on the seam the shipped app actually takes. Neither green implies the other.
//!
//! # WHAT THIS FILE'S GREEN DOES NOT COVER: the belt-pace seam (audit W2)
//! `GridSession::set_belt_run_pace` is driven below and it is NOT the shipped app's path.
//! `frontend/src/chrome/ConfigPanel.tsx`'s `commitConfig` EARLY-RETURNS for
//! `kind === 'Belt'` and sends `encodeBeltRunPace(...)` to the host arm `apply_run_pace`,
//! so neither `GridCommand::Configure { config: MachineConfig::Belt { .. } }` nor
//! `set_belt_run_pace` is reached by the running application; the helper's own docblock
//! (`command.rs:2513-2528`) says so in as many words. It is driven here on purpose,
//! because it is the ONLY headless way to get the N-belts-under-one-action-id shape into a
//! persisted log, and the persisted artefact is the same `Configure{Belt}` record set
//! either way. No assertion below says anything about the shipped dispatch path. The file
//! that does is `crates/fabrico-host/tests/belt_run_pace.rs`
//! (`a_three_belt_run_frame_lands_under_exactly_one_action_id`), and its composed
//! equivalent is `composed_seam_interleave.rs`.
//!
//! # A second accepted limit, and why every leg here is valid
//! `set_belt_run_pace` can HALF-APPLY: its legs run in order and a rejected leg returns
//! immediately, leaving the belts before it holding the new pace, whereas the live seam
//! validates every record before enqueuing any (`command.rs:2547-2554`). Every leg driven
//! in this file is therefore deliberately VALID. A composed case that mixed a rejection
//! into this seam would prove the weaker of the two contracts while reading as if it
//! proved the stronger one.
//!
//! # What is copied from where
//! The helper set and `assert_save_load_reproduces` are copied from the sibling
//! `crates/fabrico-command/tests/composition_save_load.rs` (plan 69-01), which copied the
//! five-assertion form WHOLE from `undo_save_load.rs:78-118`. It is a copy because this
//! crate has no shared test module and every existing file in it re-declares its own
//! helpers, NOT because sharing is impossible: `mod common;` works fine in an
//! integration-test crate and `crates/fabrico-core/tests/common/mod.rs` is imported that
//! way by 17 sibling files at HEAD. See the duplication note above the helpers below.
//! `configure_actions` is copied from `crates/fabrico-host/tests/belt_run_pace.rs:196-202`,
//! adapted to read `session.edit_log()`. The cardinality is the whole point of that oracle:
//! three `Configure` records under one action id and three under three action ids have the
//! SAME record count, and only the distinct-`action` count separates them.
//!
//! # The finding this file was written with in front of it (plan 69-01, mutation C and E)
//! A round-trip proof measures the LOG, not the BOARD. Under a build whose `DrawWire`
//! mints the node and never writes the link, `snapshot(refold) == snapshot(live)` stays
//! GREEN, because both sides fold the same impoverished log and agree perfectly about a
//! board that lost a feature. Every step below therefore carries its own read-back oracle
//! beside the round-trip equality, never instead of it.

use std::collections::BTreeSet;

use fabrico_command::GridSession;
use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::edit::{EditOp, EditRecord, MachineConfig as CoreMachineConfig};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::snapshot::snapshot;
use fabrico_core::state::{Medium, Node, Role};
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind, port_medium, port_role};

const SEED: u64 = 0xFAB_C0DE;

/// The ROUTER catalog's Out port index (`port_catalog`: In at 0, Out at 1). Its ROUTING
/// key is 0, so the two numbers COLLIDE on a Router, which is why the `Unlink` assertion
/// below pins the frozen `EditOp::Unlink { port: 0 }` and not merely the outcome
/// (`draw_wire.rs:404-425`).
const ROUTER_OUT_CATALOG: u16 = 1;

/// The Router's ROUTING key for [`ROUTER_OUT_CATALOG`]: the key `fold_dock` actually writes
/// into `links`, and therefore the key `GridState::link_target` is keyed by
/// (`composed_seam_interleave.rs:431-433`, the sibling host file this oracle is copied from).
const ROUTER_OUT_ROUTING_KEY: u16 = 0;

/// The run pace this file writes. Deliberately NOT [`DEFAULT_TICKS_PER_SLOT`] (2), or every
/// belt assertion below would be satisfied by a build that wrote nothing at all.
const RUN_PACE: u32 = 11;

/// The number of undoable actions [`build_interleave_board`] produces, and the position of
/// the router `Configure` counted DOWN from the top of the stack.
///
/// Twelve actions: Place ENDPOINT, Place FACTORY, AddPort, DrawWire, Place ROUTER, three
/// DrawBelts, Dock, Configure{Router}, the three-belt run pace (ONE action), Unlink. The
/// run pace being ONE and not three is the property `configure_actions` measures.
const INTERLEAVE_UNDO_DEPTH: usize = 12;

/// Undos needed to land ON the router `Configure`: the `Unlink`, then the run-pace group,
/// then the `Configure` itself. Pinned rather than derived, so a fold that coalesced or
/// SPLIT the run-pace group shifts this boundary visibly instead of being absorbed.
const UNDOS_TO_THE_CONFIGURE: usize = 3;

// -- local helpers ----------------------------------------------------------------
//
// KNOWN DUPLICATION, and the real reason for it. Six existing files in this crate
// re-declare `place`/`handle`/`draw_belt` with near-identical bodies
// (`composition_save_load.rs:99-127`, `undo_save_load.rs:35-69`, `configure.rs:28-44`,
// `undo_redo.rs:300-330`, `draw_wire.rs:429-470`, `rotate_undo_redock.rs:52-70`), and this
// file makes seven. That is HISTORY, not a language constraint. Each file under `tests/`
// being its own crate is precisely why the `mod common;` idiom works, and this repository
// already uses it: `crates/fabrico-core/tests/common/mod.rs` is imported by 17 sibling
// files at HEAD. Hoisting this set into `crates/fabrico-command/tests/common/mod.rs` is the
// right long-term fix and is deliberately NOT done in this pass: the two live copies of
// `assert_save_load_reproduces` have already drifted in message wording, so a hoist has to
// pick one, and those messages are the failure output a reader gets. Until then, note that
// anything fixed here must be fixed in `composition_save_load.rs` too (the CONNECT-01 edge
// oracle added for review finding CR-02 had to be written into both).

/// Place a machine of `kind` at a cell and return its minted `NodeId`.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> NodeId {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placed node minted an id")
}

/// The dense render handle for a `NodeId` (what `GridCommand` variants target).
fn handle(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("live node has a handle")
}

/// Draw a belt along `cells` and return the minted belt's `NodeId`.
fn draw_belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> NodeId {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the drawn belt minted an id")
}

/// The catalog index of the first port on `id` with `role`/`medium`, or a panic naming what
/// was found instead. READ BACK rather than written down: 63-07 moved several of these
/// (`configure.rs:711-723`).
fn port_index(session: &GridSession, id: NodeId, role: Role, medium: Medium) -> u16 {
    let ports = session
        .core()
        .state
        .ports_of(id)
        .expect("the node carries ports");
    let idx = ports
        .iter()
        .position(|p| p.role == role && p.medium == medium)
        .unwrap_or_else(|| panic!("no {role:?}/{medium:?} port among {ports:?}"));
    u16::try_from(idx).expect("port index fits u16")
}

/// Read a Belt node's current advance interval from the folded core
/// (`configure.rs:290-295`).
fn belt_interval(session: &GridSession, id: NodeId) -> u32 {
    match session.core().state.node(id) {
        Some(Node::Belt(b)) => b.ticks_per_slot.get(),
        other => panic!("expected a Belt node, got {other:?}"),
    }
}

/// Read a Router node's `(routes, default, faults)` from the folded core
/// (`configure.rs:299-307`).
#[allow(clippy::type_complexity)]
fn router_state(
    session: &GridSession,
    id: NodeId,
) -> (Vec<(fabrico_core::state::RouteKey, u16)>, Option<u16>, u64) {
    match session.core().state.node(id) {
        Some(Node::Router(r)) => (r.routes.clone(), r.default, r.faults),
        other => panic!("expected a Router node, got {other:?}"),
    }
}

/// The LAST addressable routing key on `id`: `out_count - 1`, counted off the LIVE node.
///
/// Since 65-04 a `Configure{Router}` naming a key at or past the node's live `Role::Out`
/// count is a typed `Malformed` reject, so the default is derived from the node instead of
/// named as a literal (`configure.rs:315-326`).
fn last_addressable_out(session: &GridSession, id: NodeId) -> u16 {
    let outs = session
        .core()
        .state
        .ports_of(id)
        .expect("a placed node declares ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .count();
    assert!(
        outs >= 2,
        "the interleave Router needs at least two Outs to pick a non-zero default"
    );
    u16::try_from(outs - 1).expect("an Out count fits a PortId")
}

/// The wire-side routing table this file configures (`configure.rs:328-344`).
///
/// `fabrico_protocol::RouteKey` and `fabrico_core::state::RouteKey` are two DISTINCT types
/// (one is built by the command, the other is read off the folded node), and this helper
/// keeps them that way rather than aliasing one into the other.
fn wire_routes() -> Vec<(fabrico_protocol::RouteKey, u16)> {
    vec![
        (
            fabrico_protocol::RouteKey {
                offset: 0,
                expect: b"alpha".to_vec(),
            },
            1,
        ),
        (
            fabrico_protocol::RouteKey {
                offset: 2,
                expect: b"beta".to_vec(),
            },
            2,
        ),
    ]
}

/// The serialized `links` map, the topology oracle, copied verbatim from
/// `rotate_undo_redock.rs:44-50` INCLUDING the reason it is not a count: a link COUNT is
/// satisfiable by a build that re-docked the wrong belt to the wrong port. The links map is
/// the exact surface CONNECT-01 / CONNECT-03 are claims about, serialized so the comparison
/// is byte-level.
fn link_bytes(session: &GridSession) -> Vec<u8> {
    let links: Vec<((NodeId, PortId), (NodeId, PortId))> =
        session.core().state.links_iter().collect();
    postcard::to_allocvec(&links).expect("serialize the links map")
}

/// The serialized `GridState` bytes: the WIDER before-versus-after oracle inside ONE
/// session, copied from `draw_wire.rs:459-466`.
///
/// NOT `snapshot(core)`: that serializes the whole `Core`, whose FIRST field is the
/// monotonic tick, and every accepted command advances it, so a mid-session `snapshot`
/// comparison is unattainable by construction. `snapshot` is reserved for the
/// live-versus-refold comparison inside [`assert_save_load_reproduces`], where both sides
/// folded the same records. A `GridState` comparison is the strongest oracle that is
/// actually a function of the topology: nodes, inboxes, links, cells, footprints, ports.
fn grid_state_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("GridState is plain serde data")
}

/// The DISTINCT `action` ids across the `Configure` records in the log, copied from
/// `crates/fabrico-host/tests/belt_run_pace.rs:196-202`.
///
/// THE reason this is a cardinality and not a record count: three `Configure` records under
/// ONE action id (one undo step, correct) and three under THREE action ids (three undo
/// steps, broken) have exactly the same record count, and every assertion that the belts
/// hold the new pace is green under both. Only this set's size separates them.
fn configure_actions(log: &[EditRecord]) -> BTreeSet<u64> {
    log.iter()
        .filter(|r| matches!(r.op, EditOp::Configure { .. }))
        .map(|r| r.action)
        .collect()
}

/// The DISTINCT `action` ids across the `Configure{Belt}` records only: the run-pace group
/// alone, with the router's `Configure` excluded.
fn belt_pace_actions(log: &[EditRecord]) -> BTreeSet<u64> {
    log.iter()
        .filter(|r| {
            matches!(
                r.op,
                EditOp::Configure {
                    config: CoreMachineConfig::Belt { .. },
                    ..
                }
            )
        })
        .map(|r| r.action)
        .collect()
}

/// How many `Configure{Belt}` records the log carries, counted separately from
/// [`belt_pace_actions`] on purpose. See that helper's docblock.
fn belt_pace_record_count(log: &[EditRecord]) -> usize {
    log.iter()
        .filter(|r| {
            matches!(
                r.op,
                EditOp::Configure {
                    config: CoreMachineConfig::Belt { .. },
                    ..
                }
            )
        })
        .count()
}

/// THE SC#3 ASSERTION, copied WHOLE from `undo_save_load.rs:78-118` by way of
/// `composition_save_load.rs:286-326`.
///
/// Serialize the live `session.edit_log()` through `postcard` (the EXACT on-disk
/// representation `ProjectFile` v5 persists), decode it back, then re-fold via
/// `GridSession::replay(seed, ...)`, the genuine save/load path. Assert the replayed core
/// snapshot hash AND the full undo/redo projection (`undoable`/`cursor`/`can_undo`/
/// `can_redo`/`xlate`) equal the live session's.
fn assert_save_load_reproduces(session: &GridSession, seed: u64) {
    // 1. SAVE: encode the edit-log exactly as it is persisted on disk.
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec())
        .expect("the edit-log postcard-encodes (the on-disk format)");
    // 2. LOAD: decode it back from the serialized bytes.
    let records: Vec<EditRecord> =
        postcard::from_bytes(&bytes).expect("the persisted edit-log decodes");
    // The persisted bytes carry the WHOLE lineage: every record survives the round-trip.
    assert_eq!(
        records.as_slice(),
        session.edit_log(),
        "the serialized round-trip preserves every edit-log record (UNDO-01: append-only, never mutated)"
    );
    // 3. REPLAY: re-fold the loaded log from genesis.
    let refold = GridSession::replay(seed, &records);

    // The replayed CORE snapshot hash equals the live one (the headline SC#3 claim).
    assert_eq!(
        snapshot(refold.core()),
        snapshot(session.core()),
        "the save/load/replay reproduces the live core snapshot hash (UNDO-03 / SC#3)"
    );
    // The replayed PROJECTION (the undo/redo history itself) reconstructs identically.
    assert_eq!(
        refold.undoable_stack(),
        session.undoable_stack(),
        "the undoable stack survives save/load"
    );
    assert_eq!(
        refold.redo_cursor(),
        session.redo_cursor(),
        "the redo cursor survives save/load"
    );
    assert_eq!(
        refold.can_undo(),
        session.can_undo(),
        "can_undo survives save/load"
    );
    assert_eq!(
        refold.can_redo(),
        session.can_redo(),
        "can_redo survives save/load"
    );
    assert_eq!(
        refold.id_translation(),
        session.id_translation(),
        "the cross-undo/redo id remap (xlate) reconstructs purely from the persisted log"
    );
}

// -- the interleaved board --------------------------------------------------------

/// The interleaved board plus every id and every captured reading the tests read back.
struct Interleave {
    session: GridSession,
    /// The `Node::Wire` the `DrawWire` minted. Drawn FIRST, so every later assertion that
    /// it survived is an assertion about interference from the three steps after it.
    wire: NodeId,
    /// The wire's far end: the `AddPort`-ed electrical `Role::In` lives on this factory.
    factory: NodeId,
    /// The catalog index of that electrical In, READ BACK off the live factory.
    factory_in_port: u16,
    /// The `Configure`d Router, and the offload target of belt one's Tail.
    router: NodeId,
    /// The three belts, in draw order. Belt 0 is the docked offload belt; ALL THREE take
    /// the run pace under one action id.
    belts: [NodeId; 3],
    /// `grid_state_bytes` immediately BEFORE the router `Configure` (step 3). The point a
    /// three-deep undo must land on, byte for byte.
    state_before_configure: Vec<u8>,
    /// `(routes, default, faults)` immediately BEFORE the router `Configure`: the state the
    /// undo must restore, read off the live node rather than written down as `(vec![], None)`.
    #[allow(clippy::type_complexity)]
    router_before_configure: (Vec<(fabrico_core::state::RouteKey, u16)>, Option<u16>, u64),
    /// `grid_state_bytes` and `link_bytes` immediately AFTER the router `Configure`
    /// (step 3), before the run pace and the `Unlink` landed.
    state_after_configure: Vec<u8>,
    links_after_configure: Vec<u8>,
    /// `(routes, default, faults)` immediately AFTER the `Configure`: what a full redo back
    /// to the top has to reproduce.
    #[allow(clippy::type_complexity)]
    router_after_configure: (Vec<(fabrico_core::state::RouteKey, u16)>, Option<u16>, u64),
    /// `grid_state_bytes` and `link_bytes` at the TOP of the stack (after step 5, the
    /// `Unlink`). A full undo-then-redo must return here byte for byte.
    state_after_unlink: Vec<u8>,
    links_after_unlink: Vec<u8>,
}

/// Build ONE `GridSession` in which a `Configure` sits BETWEEN a `DrawWire` and an
/// `Unlink`, with phase 68's N-belt grouped pace action between the `Configure` and the
/// `Unlink`.
///
/// Order matters and is the whole subject: the wire is drawn FIRST and the unlink is issued
/// LAST, so the `Configure` that the tests undo is genuinely in the MIDDLE of the stack and
/// has both other shapes on either side of it. Every leg is deliberately VALID (see the
/// half-apply caveat in the file header).
fn build_interleave_board() -> Interleave {
    let mut session = GridSession::new(SEED);

    // -- step 1: a hand-drawn wire (WIRE-01), the FIRST action on the board ---------
    // ENDPOINT is the only catalog arm with electrical ports, so the far end must be GIVEN
    // an electrical `Role::In`. The `AddPort` is mandatory, not decorative
    // (`configure.rs:845-899`).
    let ep = place(&mut session, machine_kind::ENDPOINT, 0, 0);
    let factory = place(&mut session, machine_kind::FACTORY, 5, 0);
    let factory_h = handle(&session, factory);
    session
        .apply(GridCommand::AddPort {
            node: factory_h,
            role: port_role::IN,
            side: 3, // W
            medium: port_medium::ELECTRICAL,
        })
        .expect("an electrical In is addable to a placed factory");

    let from_port = port_index(&session, ep, Role::Out, Medium::Electrical);
    let factory_in_port = port_index(&session, factory, Role::In, Medium::Electrical);
    session
        .apply(GridCommand::DrawWire {
            from_node: handle(&session, ep),
            from_port,
            to_node: factory_h,
            to_port: factory_in_port,
        })
        .expect("the wire is legal: electrical Out to electrical In, no self-loop");
    let wire = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the DrawWire minted a wire id");

    // -- step 2: the router, three belts, and the proven-valid offload dock ---------
    // A 2x3 ROUTER anchored at (0, 4) puts its Out port 1 at world (1, 5) facing E (the
    // middle row since plan 74.1-14; it was (1, 6)), so a belt drawn tail-first at (2, 5) -> (3, 5) presents its tail one step E of that port,
    // facing W = opposite(E). Docking the Tail to catalog port 1 links exactly one directed
    // edge (`rotate_undo_redock.rs:73-90`, reused verbatim in five files).
    let router = place(&mut session, machine_kind::ROUTER, 0, 4);
    let router_h = handle(&session, router);
    let belt_a = draw_belt(&mut session, vec![(2, 5), (3, 5)]);
    let belt_b = draw_belt(&mut session, vec![(2, 8), (3, 8)]);
    let belt_c = draw_belt(&mut session, vec![(2, 10), (3, 10)]);
    let belt_a_h = handle(&session, belt_a);
    session
        .apply(GridCommand::Dock {
            belt: belt_a_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: router_h,
            port: ROUTER_OUT_CATALOG,
        })
        .expect("a valid offload dock is accepted");
    // THE DOCK'S OWN EDGE, named by identity before any later reading is compared against
    // another. Every other connectivity oracle in this file is either the WIRE's edge, or a
    // `link_bytes`/`grid_state_bytes` comparison of two readings taken from the SAME
    // session, or the emitted `EditOp::Unlink` record; none of them can see a `fold_dock`
    // that writes NO link. MEASURED 2026-08-31: with `fold_dock`'s two `core.state.link(..)`
    // arms replaced by `let _ = (endpoint, port);`, all five cases in this file and its
    // save/load sibling stayed green, while both file headers claim CONNECT-01/CONNECT-03.
    assert_eq!(
        session
            .core()
            .state
            .link_target((router, ROUTER_OUT_ROUTING_KEY)),
        Some((belt_a, 0)),
        "the offload Dock wrote exactly one directed edge out of the router's Out, keyed by \
         the ROUTING key {ROUTER_OUT_ROUTING_KEY} that `fold_dock` writes for catalog Out \
         {ROUTER_OUT_CATALOG}",
    );

    // -- step 3: THE CONFIGURE IN THE MIDDLE (ROUTE-03) -----------------------------
    // Captured on BOTH sides. Neither reading is written down as a literal: the "before"
    // is read off the live node so a future catalog change that seeds a Router with a
    // non-empty table does not silently turn this into a tautology.
    let state_before_configure = grid_state_bytes(&session);
    let router_before_configure = router_state(&session, router);
    session
        .apply(GridCommand::Configure {
            node: router_h,
            config: MachineConfig::Router {
                routes: wire_routes(),
                default: Some(last_addressable_out(&session, router)),
            },
        })
        .expect("a Configure naming an addressable default is accepted");
    let state_after_configure = grid_state_bytes(&session);
    let links_after_configure = link_bytes(&session);
    let router_after_configure = router_state(&session, router);

    // -- step 4: phase 68's N-belt grouped pace action (BELT-02) --------------------
    // All THREE belts under ONE action id. The docked belt is included on purpose: the
    // group therefore straddles a belt that is party to the link the `Unlink` below tears
    // down, which is the interference a pairwise test cannot see.
    assert_ne!(
        DEFAULT_TICKS_PER_SLOT.get(),
        RUN_PACE,
        "the written pace must differ from the crate default, or no belt assertion here can fail",
    );
    let run = [
        handle(&session, belt_a),
        handle(&session, belt_b),
        handle(&session, belt_c),
    ];
    session
        .set_belt_run_pace(&run, RUN_PACE)
        .expect("a valid three-belt run pace is accepted");

    // -- step 5: an explicit Unlink, the LAST action (CONNECT-01 / CONNECT-03) ------
    // Names belt A's Tail at the router's CATALOG port 1. The arm must translate that into
    // the ROUTING key 0 that `fold_dock` wrote. See `ROUTER_OUT_CATALOG`.
    session
        .apply(GridCommand::Unlink {
            belt: belt_a_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: router_h,
            port: ROUTER_OUT_CATALOG,
        })
        .expect("an unlink of a live dock is accepted");
    let state_after_unlink = grid_state_bytes(&session);
    let links_after_unlink = link_bytes(&session);

    Interleave {
        session,
        wire,
        factory,
        factory_in_port,
        router,
        belts: [belt_a, belt_b, belt_c],
        state_before_configure,
        router_before_configure,
        state_after_configure,
        links_after_configure,
        router_after_configure,
        state_after_unlink,
        links_after_unlink,
    }
}

// -- the interleave case ----------------------------------------------------------

/// **ROADMAP SC3, the W1 persisted-log half.** A `Configure` undone from the MIDDLE of a
/// stack whose earlier action is a `DrawWire` and whose later action is an `Unlink`, with
/// the save/load/replay equality re-asserted after every single undo and every single redo.
///
/// The per-step assertions are LOAD-BEARING and are not decoration. Plan 69-01 measured
/// (mutations C and E) that `snapshot(refold) == snapshot(live)` stays GREEN under a build
/// that dropped a feature outright, because both sides fold the same impoverished log. The
/// round-trip equality is necessary and is NOT sufficient, so every undo boundary below
/// carries its own read-back oracle as well.
#[test]
fn a_configure_undone_between_a_drawwire_and_an_unlink_replays_byte_identically() {
    let board = build_interleave_board();
    let mut session = board.session;

    // The board really carries all three action shapes before anything is claimed about the
    // undo stack.
    assert!(
        matches!(session.core().state.node(board.wire), Some(Node::Wire(_))),
        "the DrawWire fold minted a Node::Wire",
    );
    assert_ne!(
        board.router_after_configure.0, board.router_before_configure.0,
        "the router Configure actually changed the routing table, or undoing it proves nothing",
    );
    assert_eq!(
        [
            belt_interval(&session, board.belts[0]),
            belt_interval(&session, board.belts[1]),
            belt_interval(&session, board.belts[2]),
        ],
        [RUN_PACE, RUN_PACE, RUN_PACE],
        "every belt of the run holds the run pace at the top of the stack",
    );
    assert_eq!(
        session.redo_cursor(),
        INTERLEAVE_UNDO_DEPTH,
        "the interleaved board is exactly {INTERLEAVE_UNDO_DEPTH} LIVE actions deep; a \
         different depth means a fold coalesced or split a step. In particular the \
         three-belt run counts ONCE, so a depth of 14 is the split-group defect",
    );
    assert_save_load_reproduces(&session, SEED);

    // -- undo down to the Configure, equality re-asserted at every step -------------
    for step in 1..=UNDOS_TO_THE_CONFIGURE {
        session
            .apply(GridCommand::Undo)
            .unwrap_or_else(|e| panic!("undo step {step} of the interleave is accepted: {e:?}"));
        assert_save_load_reproduces(&session, SEED);
    }

    // The Configure is undone: the router's table is back where the live node had it BEFORE
    // the Configure landed.
    assert_eq!(
        router_state(&session, board.router),
        board.router_before_configure,
        "undoing the middle Configure restored the Router's routes, default and faults to \
         exactly the pre-Configure reading taken off the live node",
    );

    // The WIRE, drawn three actions EARLIER, is untouched. Both halves: the node kind alone
    // passes against a build that mints the node without writing the link
    // (`composition_save_load.rs` mutation C).
    assert!(
        matches!(session.core().state.node(board.wire), Some(Node::Wire(_))),
        "undoing a Configure did not disturb the Node::Wire drawn before it",
    );
    assert_eq!(
        session.core().state.link_target((board.wire, 0)),
        Some((board.factory, board.factory_in_port)),
        "the wire's forward link still reaches the AddPort-ed electrical In after a router \
         Configure, a three-belt run pace and an Unlink were applied and then undone over it",
    );

    // The belt paces are asserted as EXPLICIT values, not as a relation to what they were.
    // At this depth the run-pace group is undone (it sits between the Unlink and the
    // Configure), so all three are back at the crate default. A shifted undo boundary shows
    // up here as a literal mismatch rather than being absorbed by a relative comparison.
    let default_pace = DEFAULT_TICKS_PER_SLOT.get();
    assert_eq!(
        [
            belt_interval(&session, board.belts[0]),
            belt_interval(&session, board.belts[1]),
            belt_interval(&session, board.belts[2]),
        ],
        [default_pace, default_pace, default_pace],
        "at the Configure boundary the run-pace group is already undone, so all three belts \
         read the crate default",
    );

    // The UNLINK is undone too, so the dock is back. The EDGE by identity first: the byte
    // comparison under it is two readings from the SAME session, so it is equal under a
    // `fold_dock` that never wrote the edge in the first place.
    assert_eq!(
        session
            .core()
            .state
            .link_target((board.router, ROUTER_OUT_ROUTING_KEY)),
        Some((board.belts[0], 0)),
        "undoing the Unlink put the router's offload edge back on routing key \
         {ROUTER_OUT_ROUTING_KEY}, pointing at the belt the Dock named",
    );
    // Then bytes, never a count.
    assert_eq!(
        link_bytes(&session),
        board.links_after_configure,
        "undoing the Unlink restored the links map BYTE-for-byte as the Dock left it",
    );

    // The WHOLE GridState at this boundary equals the reading taken just before the
    // Configure was applied. Attainable here (and not at a full unwind) because none of the
    // three undone actions MINTS: `Configure`, `set_belt_run_pace` and `Unlink` all leave
    // the slotmap alone, so no `NodeId` re-mint crosses this comparison.
    assert_eq!(
        grid_state_bytes(&session),
        board.state_before_configure,
        "three undos land the WHOLE GridState exactly where it stood before the Configure: \
         cells, footprints, ports, inboxes and links alike",
    );
    assert_save_load_reproduces(&session, SEED);

    // -- one redo: back onto the Configure -----------------------------------------
    session
        .apply(GridCommand::Redo)
        .expect("the undone Configure is redoable");
    assert_save_load_reproduces(&session, SEED);
    assert_eq!(
        router_state(&session, board.router),
        board.router_after_configure,
        "redoing the middle Configure reproduces the routing table it wrote the first time",
    );
    assert_eq!(
        grid_state_bytes(&session),
        board.state_after_configure,
        "one redo puts the WHOLE GridState back to its post-Configure bytes",
    );

    // -- redo the rest of the way to the top ---------------------------------------
    let mut redos = 1usize;
    while session.can_redo() {
        session
            .apply(GridCommand::Redo)
            .expect("a live redo step is accepted");
        redos += 1;
        assert_save_load_reproduces(&session, SEED);
        assert!(
            redos <= UNDOS_TO_THE_CONFIGURE,
            "the redo loop ran past the {UNDOS_TO_THE_CONFIGURE} steps that were undone",
        );
    }
    assert_eq!(
        redos, UNDOS_TO_THE_CONFIGURE,
        "every undone action redoes, one for one",
    );

    // The top of the stack. The redone UNLINK tore the router's offload edge back down,
    // asserted by identity: `links_after_unlink` is a reading of this same session, so the
    // byte comparison under it is green whether or not that edge ever existed.
    assert_eq!(
        session
            .core()
            .state
            .link_target((board.router, ROUTER_OUT_ROUTING_KEY)),
        None,
        "redoing the Unlink removed the router's offload edge on routing key \
         {ROUTER_OUT_ROUTING_KEY} again",
    );
    // And byte for byte on both oracles.
    assert_eq!(
        link_bytes(&session),
        board.links_after_unlink,
        "the links map at the top of the stack comes back BYTE-for-byte through the full \
         undo and redo of the interleave",
    );
    assert_eq!(
        grid_state_bytes(&session),
        board.state_after_unlink,
        "the WHOLE GridState comes back byte-identical through the full undo and redo, so \
         nothing on the interleaved board drifted across the three action shapes",
    );
    assert_eq!(
        [
            belt_interval(&session, board.belts[0]),
            belt_interval(&session, board.belts[1]),
            belt_interval(&session, board.belts[2]),
        ],
        [RUN_PACE, RUN_PACE, RUN_PACE],
        "all three belts hold the run pace again after the rewind, the docked one included",
    );

    // The FROZEN op, not merely the outcome. `GridCommand::Unlink` named the router's
    // CATALOG port 1; the arm must translate it into the ROUTING key 0 that `fold_dock`
    // wrote. Those two numbers COLLIDE on a Router, so an outcome-only assertion passes
    // against an untranslated build (`draw_wire.rs:513-528`, and plan 69-01's mutation E,
    // under which every byte oracle in the file stayed green and only this assertion red).
    let unlinks: Vec<&EditRecord> = session
        .edit_log()
        .iter()
        .filter(|r| matches!(r.op, EditOp::Unlink { .. }))
        .collect();
    // The CARDINALITY first, so a build that stopped emitting the forward `Unlink` fails
    // with a named message instead of a bare index-out-of-bounds panic. Two records and not
    // one: the log is append-only, so the forward `Unlink` from `build_interleave_board` and
    // the one the third redo re-appended both sit in it. Indexing `[0]` alone would assert
    // about the PRE-undo record while reading as if it were about the rewind it follows.
    assert_eq!(
        unlinks.len(),
        2,
        "the log is append-only: the forward Unlink plus the one the third redo re-appended. \
         Found {unlinks:?}",
    );
    for (i, r) in unlinks.iter().enumerate() {
        assert_eq!(
            r.op,
            EditOp::Unlink {
                belt: board.belts[0],
                endpoint: fabrico_core::edit::BeltEnd::Tail,
                node: board.router,
                port: 0,
            },
            "Unlink record {i} carries resolved NodeIds AND the Out ROUTING key \
             (catalog 1 to emit 0)",
        );
    }
}

// -- the grouped action, inside the interleave -------------------------------------

/// **Phase 68's N-belt grouped pace action undoes as ONE step while a `DrawWire` and an
/// `Unlink` sit in the same stack.**
///
/// The property is proved by the CARDINALITY of the distinct `action` ids, never by a
/// record count. Three `Configure{Belt}` records under one action id and three under three
/// action ids have the same record count, and every assertion that the belts hold the new
/// pace is green under both; only the cardinality separates them. Both numbers are asserted
/// here, separately, so the difference between them is on the record.
#[test]
fn the_belt_run_pace_group_undoes_as_one_step_inside_the_interleave() {
    let board = build_interleave_board();
    let mut session = board.session;
    let log = session.edit_log().to_vec();

    // Two distinct Configure actions on this board: the router's, and the three belts'.
    assert_eq!(
        configure_actions(&log).len(),
        2,
        "the interleaved board carries exactly two Configure actions (the router's, and the \
         three-belt run as ONE). Got actions {:?}",
        configure_actions(&log),
    );
    // The RECORD count and the ACTION count, asserted separately and on purpose.
    assert_eq!(
        belt_pace_record_count(&log),
        3,
        "one Configure{{Belt}} record per belt named in the run",
    );
    assert_eq!(
        belt_pace_actions(&log).len(),
        1,
        "THE WHOLE POINT: three belts, ONE action id, so ONE Ctrl+Z, and a DrawWire and an \
         Unlink in the same stack do not split it. Got actions {:?}",
        belt_pace_actions(&log),
    );
    // And that one belt action is genuinely distinct from the router's Configure: a build
    // that FUSED the two would satisfy both counts above.
    assert!(
        belt_pace_actions(&log).is_subset(&configure_actions(&log)),
        "the belt run's action id is one of the board's Configure actions",
    );
    assert_eq!(
        configure_actions(&log)
            .difference(&belt_pace_actions(&log))
            .count(),
        1,
        "the router Configure sits under its OWN action id, not fused into the belt run's",
    );

    // -- position on the run-pace group, then ONE undo -----------------------------
    // The `Unlink` is the top of the stack, so one undo positions and the NEXT undo is the
    // one under test. Positioning is asserted, not assumed: the belts must still hold the
    // run pace at this point, or the single undo below would be landing somewhere else.
    session
        .apply(GridCommand::Undo)
        .expect("the Unlink at the top of the stack is undoable");
    assert_eq!(
        [
            belt_interval(&session, board.belts[0]),
            belt_interval(&session, board.belts[1]),
            belt_interval(&session, board.belts[2]),
        ],
        [RUN_PACE, RUN_PACE, RUN_PACE],
        "undoing the Unlink left every belt pace alone, so the next undo lands on the run",
    );
    // `redo_cursor()` and NOT `undoable_stack().len()`: the stack keeps the undone tail, so
    // its LENGTH is invariant under undo and an assertion on it cannot fail. The cursor is
    // the count of currently-LIVE actions (`command.rs:4105-4110`), which is exactly the
    // "how many undo steps did that consume" question.
    let live_actions_before = session.redo_cursor();

    // ONE undo. All three belts come back together or the group was never a group.
    session
        .apply(GridCommand::Undo)
        .expect("the run-pace group is undoable");
    let default_pace = DEFAULT_TICKS_PER_SLOT.get();
    assert_eq!(
        [
            belt_interval(&session, board.belts[0]),
            belt_interval(&session, board.belts[1]),
            belt_interval(&session, board.belts[2]),
        ],
        [default_pace, default_pace, default_pace],
        "ONE Undo restored ALL THREE belts to the crate default. A per-belt action id would \
         leave the second and third still holding {RUN_PACE}",
    );
    assert_eq!(
        session.redo_cursor(),
        live_actions_before - 1,
        "the three-belt run consumed exactly ONE undo step, not three",
    );

    // The router Configure, which sits one step BELOW the run in the stack, is untouched by
    // that single undo: the group did not overshoot into the action beneath it.
    assert_eq!(
        router_state(&session, board.router),
        board.router_after_configure,
        "undoing the run-pace group left the router Configure beneath it standing",
    );
    // And the wire, four steps below, is still linked.
    assert_eq!(
        session.core().state.link_target((board.wire, 0)),
        Some((board.factory, board.factory_in_port)),
        "the wire drawn before the whole sequence is still linked after the grouped undo",
    );
    assert_save_load_reproduces(&session, SEED);
}
