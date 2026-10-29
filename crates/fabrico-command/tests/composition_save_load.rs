//! Phase 69-01: the v8.0 milestone audit blocker **B2** proof: ONE board carrying a
//! feature from four v8.0 phases saves, loads and replays to the SAME `snapshot(core)`.
//!
//! # The claim, and why it needed its own file
//! `crates/fabrico-command/tests/undo_save_load.rs` is this repository's named SC#3 /
//! UNDO-03 headline proof, and measured at HEAD it contains `DrawWire` 0 times,
//! `Configure` 0 times and `Unlink` 0 times: its vocabulary is Phase-12 vintage and no
//! v8.0 phase extended it. Every save/load/replay proof in the tree runs on a board
//! carrying exactly ONE feature, while the board the v8.0 done-test describes carries
//! four. A suite of single-feature round-trips is green against a build where any two of
//! those features interfere in one edit log, so the green retired a question it never
//! asked. That is the milestone-scale instance of this project's signature defect class,
//! and closing it is the whole subject of this file.
//!
//! The claim proved here (ROADMAP SC1; requirements SCHEMA-01, SCHEMA-02, SCHEMA-03,
//! ROUTE-03, WIRE-01, BELT-02, CONNECT-01, CONNECT-03): a single `GridSession` carrying
//! a hand-drawn `DrawWire`, a `Configure` of a Router routing table, a per-belt pace on
//! BOTH headless belt seams, and an `Unlink` followed by a re-`Dock`, persists as the
//! on-disk `postcard(Vec<EditRecord>)` format, decodes back, replays from genesis, and
//! reproduces the live `snapshot(core)` exactly, along with the undoable stack, the redo
//! cursor and the cross-undo/redo id translation.
//!
//! # Mechanism, and what is copied from where
//! `assert_save_load_reproduces` is COPIED WHOLE from
//! `crates/fabrico-command/tests/undo_save_load.rs:78-118`, all five assertions with
//! their messages intact. It is a copy because `fabrico-command` has no shared test module
//! and every existing file in it re-declares its own helpers, NOT because sharing is
//! impossible: a `tests/common/mod.rs` declared as `mod common;` works fine in an
//! integration-test crate, and `crates/fabrico-core/tests/common/mod.rs` is imported that
//! way by 17 sibling files at HEAD. See the duplication note above the helpers below.
//! `configure.rs:440`'s thinner `save_and_load` is deliberately NOT
//! substituted: it compares one field and stays green under a divergence anywhere else,
//! which is the exact failure mode this file exists to close. `link_bytes` is copied from
//! `crates/fabrico-command/tests/rotate_undo_redock.rs:44-50` for the same reason its own
//! header gives: a count-based topology assertion passes against a build that re-docked
//! the wrong belt to the wrong port. Every port index, routing key and router default is
//! READ BACK off the live node (`port_index`, `last_addressable_out`), never written down
//! as a literal: 63-07 moved several catalog indices and 65-04 made an out-of-range
//! routing key a typed `Malformed` reject.
//!
//! This file is a SIBLING of `undo_save_load.rs` rather than an extension of it (D-69-06).
//! That file states one tight subject in a 25-line header and its proptest harness drives
//! only Place/Delete/move/Undo/Redo; bolting a scripted four-feature composition onto it
//! would force its header to describe two claims.
//!
//! # THE BELT-PACE SEAM, AND WHAT THIS FILE'S GREEN DOES NOT COVER
//! Neither seam driven here is the path the shipped app takes, and audit warning W2 is
//! precisely about a reader taking one of them as if it were. `frontend/src/chrome/
//! ConfigPanel.tsx`'s `commitConfig` EARLY-RETURNS for `kind === 'Belt'` and sends
//! `encodeBeltRunPace(...)` to the host arm `apply_run_pace`; so neither
//! `GridCommand::Configure { config: MachineConfig::Belt { .. } }` nor
//! `GridSession::set_belt_run_pace` is reached by the running application. Both are
//! driven here ON PURPOSE, because the question B2 asks is whether a multi-feature
//! PERSISTED LOG survives a save, a load and a replay, and the persisted artefact is the
//! same `Vec<EditRecord>` of `Configure{Belt}` records either way, and `set_belt_run_pace`
//! is additionally the only headless way to get the N-belts-under-one-action-id shape
//! into that log.
//!
//! The file that DOES cover the shipped seam is
//! `crates/fabrico-host/tests/belt_run_pace.rs`
//! (`a_three_belt_run_frame_lands_under_exactly_one_action_id`), which drives a raw
//! `0xFE` run-pace frame through the live decoder. Its COMPOSED equivalent, the same
//! three action shapes interleaved on that shipped seam, is
//! `crates/fabrico-host/tests/composed_seam_interleave.rs` (plan 69-03). No green in this
//! file says anything about either.
//!
//! # A second accepted limit
//! `set_belt_run_pace` can HALF-APPLY: its legs run in order and a rejected leg returns
//! immediately, leaving the belts before it holding the new pace, whereas the live seam
//! validates every record before enqueuing any (`command.rs:2547-2554`). Every leg driven
//! in this file is therefore deliberately VALID. A composed case that mixed a rejection
//! into this seam would prove the weaker of the two contracts while reading as if it
//! proved the stronger one.

use fabrico_command::GridSession;
use fabrico_core::edit::{BeltEnd, EditOp, EditRecord};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::snapshot::snapshot;
use fabrico_core::state::{Medium, Node, Role};
use fabrico_protocol::{
    GridCommand, MachineConfig, machine_kind, port_medium, port_role,
};

const SEED: u64 = 0xFAB_C0DE;

/// The ROUTER catalog's Out port index (`port_catalog`: In at 0, Out at 1). Its ROUTING
/// key is 0, so the two numbers COLLIDE on a Router, which is why the `Unlink` assertion in
/// `each_of_the_four_features_is_individually_readable_on_the_composed_board` pins the
/// frozen `EditOp::Unlink { port: 0 }` and not merely the outcome (`draw_wire.rs:404-425`).
const ROUTER_OUT_CATALOG: u16 = 1;

/// The Router's ROUTING key for [`ROUTER_OUT_CATALOG`]: the key `fold_dock` actually writes
/// into `links`, and therefore the key `GridState::link_target` is keyed by
/// (`composed_seam_interleave.rs:431-433`, the sibling host file this oracle is copied from).
const ROUTER_OUT_ROUTING_KEY: u16 = 0;

// ── local helpers ────────────────────────────────────────────────────────────
//
// KNOWN DUPLICATION, and the real reason for it. Five existing files in this crate
// re-declare `place`/`draw`/`handle` with near-identical bodies (`undo_save_load.rs:35-69`,
// `configure.rs:28-44`, `undo_redo.rs:300-330`, `draw_wire.rs:429-470`,
// `rotate_undo_redock.rs:52-70`), and this file and `composition_interleave.rs` make seven.
// That is HISTORY, not a language constraint. Each file under `tests/` being its own crate
// is precisely why the `mod common;` idiom works, and this repository already uses it:
// `crates/fabrico-core/tests/common/mod.rs` is imported by 17 sibling files at HEAD.
// Hoisting this set into `crates/fabrico-command/tests/common/mod.rs` is the right
// long-term fix and is deliberately NOT done in this pass: the two live copies of
// `assert_save_load_reproduces` have already drifted in message wording, so a hoist has to
// pick one, and those messages are the failure output a reader gets. Until then, note that
// anything fixed here must be fixed in `composition_interleave.rs` too.
//
// This file follows the `configure.rs` convention (`place` returns a `NodeId` and a
// separate `handle` returns the dense u64), because every read-back oracle here takes a
// `NodeId`.

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

/// The catalog index of the first port on `id` with `role`/`medium`, or a panic naming
/// what was found instead. READ BACK rather than written down: 63-07 moved several of
/// these (`configure.rs:711-723`).
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
/// count is a typed `Malformed` reject, so the default is derived from the node instead
/// of named as a literal (`configure.rs:315-326`).
fn last_addressable_out(session: &GridSession, id: NodeId) -> u16 {
    let outs = session
        .core()
        .state
        .ports_of(id)
        .expect("a placed node declares ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .count();
    assert!(outs >= 2, "the composed Router needs at least two Outs to pick a non-zero default");
    u16::try_from(outs - 1).expect("an Out count fits a PortId")
}

/// The wire-side routing table this file configures (`configure.rs:328-344`).
///
/// `fabrico_protocol::RouteKey` and `fabrico_core::state::RouteKey` are two DISTINCT
/// types (one is built by the command, the other is read off the folded node), and this
/// sibling-helper pairing keeps them that way rather than aliasing one into the other.
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

/// The core-side twin of [`wire_routes`], for asserting on the folded node
/// (`configure.rs:346-355`). The whole route VECTOR is compared, never its length.
fn core_routes() -> Vec<(fabrico_core::state::RouteKey, u16)> {
    use fabrico_core::state::RouteKey;
    vec![
        (RouteKey::new(0, b"alpha".to_vec()), 1),
        (RouteKey::new(2, b"beta".to_vec()), 2),
    ]
}

/// The serialized `links` map, the topology oracle, copied verbatim from
/// `rotate_undo_redock.rs:44-50` INCLUDING the reason it is not a count.
///
/// `GridState`-wide equality is unattainable across a rotate (the rotation itself is a
/// real difference), and a link COUNT is satisfiable by a build that re-docked the wrong
/// belt to the wrong port. The links map is the exact surface CONNECT-01 / CONNECT-03 are
/// claims about, serialized so the comparison is byte-level.
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

/// Follow the cross-undo/redo id remap (`xlate`) to the node's CURRENT live `NodeId`.
///
/// A redo of an undone Place RE-MINTS a fresh `NodeId` (the slotmap bumps the
/// generation). That is the accepted FLAG stated in `undo_save_load.rs:18-24` and proved
/// in `undo_redo.rs:243-286`: SC#3 is unaffected, because a FIXED log always re-folds
/// deterministically, but a `NodeId` captured before an unwind is dead after the rewind.
/// The in-tree precedent (`undo_redo.rs:294-296`) drops to observable COUNTS at this
/// point; this file does not, because a count is exactly the oracle
/// `rotate_undo_redock.rs` records as passing against a wrong re-dock. Relabelling one
/// side through `xlate` keeps the comparison a whole-topology one.
fn live_id(session: &GridSession, original: NodeId) -> NodeId {
    let xlate = session.id_translation();
    let mut id = original;
    // The remap is a CHAIN when a node is undone and redone more than once. Bound the
    // walk by the map's size, so a cyclic map is a loud failure rather than a hang.
    for _ in 0..=xlate.len() {
        match xlate.get(&id) {
            Some(&next) if next != id => id = next,
            _ => return id,
        }
    }
    panic!("the id translation map cycles at {original:?}")
}

/// The links map as typed, sorted pairs: the form [`link_bytes`] serializes, kept typed
/// so one side can be relabelled through [`live_id`] before the comparison. Sorted
/// because relabelling changes the `NodeId` ordering `links_iter` yields.
fn links_sorted(session: &GridSession) -> Vec<((NodeId, PortId), (NodeId, PortId))> {
    let mut links: Vec<((NodeId, PortId), (NodeId, PortId))> =
        session.core().state.links_iter().collect();
    links.sort();
    links
}

/// THE SC#3 ASSERTION, copied WHOLE from `undo_save_load.rs:78-118`.
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
        "the save→load→replay reproduces the live core snapshot hash (UNDO-03 / SC#3)"
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
    assert_eq!(refold.can_undo(), session.can_undo(), "can_undo survives save/load");
    assert_eq!(refold.can_redo(), session.can_redo(), "can_redo survives save/load");
    assert_eq!(
        refold.id_translation(),
        session.id_translation(),
        "the cross-undo/redo id remap (xlate) reconstructs purely from the persisted log"
    );
}

// ── the composed board ───────────────────────────────────────────────────────

/// The composed board plus every id the tests read back off it.
struct Composed {
    session: GridSession,
    /// The `Node::Wire` the `DrawWire` minted.
    wire: NodeId,
    /// The wire's far end: the `AddPort`-ed electrical `Role::In` lives on this factory.
    factory: NodeId,
    /// The catalog index of that electrical In, READ BACK off the live factory.
    factory_in_port: u16,
    /// The configured Router, and the offload target of belt one's Tail.
    router: NodeId,
    /// The three belts, in draw order. Belt 0 is the docked offload belt and carries the
    /// individually-`Configure`d pace; belts 1 and 2 carry the run pace.
    belts: [NodeId; 3],
    /// `link_bytes` captured immediately after the FIRST `Dock`, before the `Unlink` and
    /// the re-`Dock`. The re-`Dock` must reproduce these bytes EXACTLY, not merely
    /// restore a link count.
    links_after_first_dock: Vec<u8>,
    /// `grid_state_bytes` captured immediately BEFORE the `Unlink`, after both pace seams
    /// had already landed. The `Unlink` + re-`Dock` pair must leave the WHOLE `GridState`
    /// byte-identical: cells, footprints, ports and inboxes as well as links.
    state_before_unlink: Vec<u8>,
}

/// Build ONE `GridSession` carrying all four v8.0 features (D-69-07: the topology the
/// 69-RESEARCH probe measured, chosen because each of its four features is individually
/// perturbable for the mutation proof).
///
/// Every leg is deliberately VALID. See the half-apply caveat in the file header.
fn build_composed_board() -> Composed {
    let mut session = GridSession::new(SEED);

    // ── feature 1: a hand-drawn wire (WIRE-01) ───────────────────────────────
    // ENDPOINT is the only catalog arm with electrical ports, so the far end must be
    // GIVEN an electrical `Role::In`. The `AddPort` is mandatory, not decorative
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

    // ── feature 2: a router routing table (ROUTE-03) ─────────────────────────
    let router = place(&mut session, machine_kind::ROUTER, 0, 4);
    let router_h = handle(&session, router);
    session
        .apply(GridCommand::Configure {
            node: router_h,
            config: MachineConfig::Router {
                routes: wire_routes(),
                default: Some(last_addressable_out(&session, router)),
            },
        })
        .expect("a Configure naming an addressable default is accepted");

    // ── the three belts, and the proven-valid offload dock ───────────────────
    // A 2×3 ROUTER anchored at (0, 4) puts its Out port 1 at world (1, 5) facing E (the
    // middle row since plan 74.1-14; it was (1, 6)), so a belt drawn tail-first at (2, 5) -> (3, 5) presents its tail one step E of that
    // port, facing W = opposite(E). Docking the Tail to catalog port 1 links exactly one
    // directed edge (`rotate_undo_redock.rs:73-90`, reused verbatim in four files).
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
    // THE DOCK'S OWN EDGE, named by identity before anything else is claimed about it.
    // Neither this file's `link_bytes` comparison nor its `grid_state_bytes` comparison can
    // see a `fold_dock` that writes NO link: both are two readings taken from the SAME
    // session, so an impoverished board compares equal to itself. MEASURED 2026-08-31: with
    // `fold_dock`'s two `core.state.link(..)` arms replaced by `let _ = (endpoint, port);`,
    // all five cases in this file and its interleave sibling stayed green, while both file
    // headers claim CONNECT-01 and CONNECT-03.
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
    let links_after_first_dock = link_bytes(&session);

    // ── feature 3: a per-belt pace on BOTH headless seams (BELT-02) ──────────
    // Belt A goes through `Configure{Belt}` individually; belts B and C go through
    // `set_belt_run_pace`, the N-belts-under-one-action-id shape. Belt A is therefore a
    // live CONTROL: a mutation on the run path must NOT move its pace of 2.
    session
        .apply(GridCommand::Configure {
            node: belt_a_h,
            config: MachineConfig::Belt { ticks_per_slot: 2 },
        })
        .expect("an individual belt Configure is accepted");
    let run = [handle(&session, belt_b), handle(&session, belt_c)];
    session
        .set_belt_run_pace(&run, 11)
        .expect("a valid two-belt run pace is accepted");

    // ── feature 4: an explicit Unlink, then a re-Dock (CONNECT-01/CONNECT-03) ─
    // Captured here rather than after the first Dock, because the two pace seams above
    // legitimately moved the GridState in between. No id drift crosses this pair:
    // `Unlink` and `Dock` re-mint nothing, so a BYTE comparison is attainable.
    let state_before_unlink = grid_state_bytes(&session);
    // Both name belt A's Tail at the router's CATALOG port 1. The arm translates that
    // into the ROUTING key 0 that `fold_dock` wrote. See `ROUTER_OUT_CATALOG`.
    session
        .apply(GridCommand::Unlink {
            belt: belt_a_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: router_h,
            port: ROUTER_OUT_CATALOG,
        })
        .expect("an unlink of a live dock is accepted");
    session
        .apply(GridCommand::Dock {
            belt: belt_a_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: router_h,
            port: ROUTER_OUT_CATALOG,
        })
        .expect("the re-dock of the just-unlinked edge is accepted");

    Composed {
        session,
        wire,
        factory,
        factory_in_port,
        router,
        belts: [belt_a, belt_b, belt_c],
        links_after_first_dock,
        state_before_unlink,
    }
}

// ── the headline case ────────────────────────────────────────────────────────

/// **ROADMAP SC1, the headline B2 proof.** One `GridSession` carrying a hand-drawn
/// `DrawWire`, a `Configure` of a Router routing table, a per-belt pace on both headless
/// seams, and an `Unlink` followed by a re-`Dock`, saves, loads and replays to the SAME
/// `snapshot(core)`.
///
/// The four up-front assertions are LOAD-BEARING and are not decoration: without them a
/// build that dropped one feature entirely would still round-trip to an equal snapshot
/// and pass, because both sides of the comparison folded the same (impoverished) log.
#[test]
fn a_board_carrying_all_four_v8_features_saves_loads_and_replays_to_the_same_snapshot() {
    let composed = build_composed_board();
    let session = &composed.session;

    // The board really carries all four features before anything is claimed about it.
    assert!(
        matches!(session.core().state.node(composed.wire), Some(Node::Wire(_))),
        "feature 1 present: the DrawWire fold minted a Node::Wire",
    );
    // The whole route VECTOR and the exact default, never `!routes.is_empty()` and
    // `default.is_some()`: a presence check is green against a build that wrote a table with
    // the wrong keys, the wrong targets or the wrong default. This is the same oracle the
    // sibling case in this file already uses.
    let (routes, default, _faults) = router_state(session, composed.router);
    assert_eq!(
        routes,
        core_routes(),
        "feature 2 present: the Router carries the exact routing table this board \
         configured, vector for vector",
    );
    assert_eq!(
        default,
        Some(last_addressable_out(session, composed.router)),
        "feature 2 present: the Router's default is the last addressable Out counted off \
         the live node",
    );
    assert_eq!(
        [
            belt_interval(session, composed.belts[0]),
            belt_interval(session, composed.belts[1]),
            belt_interval(session, composed.belts[2]),
        ],
        [2, 11, 11],
        "feature 3 present: the individually-configured belt holds 2 and the run holds 11",
    );
    // Named by EDGE IDENTITY, never as `!link_bytes(session).is_empty()`. `link_bytes`
    // serializes the whole `links` map, and feature 1's `DrawWire` already writes into
    // that map (`fold_draw_wire`, `tick.rs:651`), so an emptiness check here is GREEN on a
    // board carrying no Dock at all: MEASURED 2026-08-31 by deleting the Dock, the Unlink
    // and the re-Dock from `build_composed_board` outright and watching this test pass.
    assert_eq!(
        session
            .core()
            .state
            .link_target((composed.router, ROUTER_OUT_ROUTING_KEY)),
        Some((composed.belts[0], 0)),
        "feature 4 present: the re-Dock wrote the router's own offload edge back, keyed by \
         the ROUTING key {ROUTER_OUT_ROUTING_KEY} that `fold_dock` writes for catalog Out \
         {ROUTER_OUT_CATALOG}",
    );

    // THE CLAIM: save → load → replay reproduces the whole core and the whole projection.
    assert_save_load_reproduces(session, SEED);
}

// ── the ADJACENCY edge (SCHEMA-01 / SCHEMA-03) ───────────────────────────────

/// Four features' records sit ADJACENT in one edit log and do not interfere. Proved by
/// asserting each feature's OWN read-back oracle on the composed board, not by asserting
/// a total: a composition that silently dropped one feature cannot pass this.
#[test]
fn each_of_the_four_features_is_individually_readable_on_the_composed_board() {
    let composed = build_composed_board();
    let session = &composed.session;

    // ── WIRE (WIRE-01). BOTH halves. The node-kind assertion alone passes against a
    // build that mints the node without writing the link (`configure.rs:885-898`).
    assert!(
        matches!(session.core().state.node(composed.wire), Some(Node::Wire(_))),
        "the DrawWire fold minted a Node::Wire beside three other features' records",
    );
    assert_eq!(
        session.core().state.link_target((composed.wire, 0)),
        Some((composed.factory, composed.factory_in_port)),
        "the wire's forward link still reaches the AddPort-ed electrical In after a router \
         Configure, three belts, two pace seams, an Unlink and a re-Dock landed after it",
    );

    // ── ROUTER (ROUTE-03). The whole route VECTOR, never its length, and a default read
    // back off the live node rather than written down (65-04 made an out-of-range key a
    // typed reject).
    let (routes, default, _faults) = router_state(session, composed.router);
    assert_eq!(
        routes,
        core_routes(),
        "the Router's routing table survives verbatim beside the wire, the belts and the dock",
    );
    assert_eq!(
        default,
        Some(last_addressable_out(session, composed.router)),
        "the Router's default port is still the last addressable Out counted off the live node",
    );

    // ── BELT PACE (BELT-02). All THREE values. Asserting only the run belts would miss a
    // mutation that leaked the run pace onto the individually-configured control belt;
    // asserting only the first would miss one that applied the run to its first leg only.
    assert_eq!(
        belt_interval(session, composed.belts[0]),
        2,
        "the individually-Configure'd control belt still holds its own pace of 2",
    );
    assert_eq!(
        [
            belt_interval(session, composed.belts[1]),
            belt_interval(session, composed.belts[2]),
        ],
        [11, 11],
        "EVERY belt of the set_belt_run_pace run holds 11, not just its first leg",
    );

    // ── UNLINK and re-DOCK (CONNECT-01 / CONNECT-03). The re-docked EDGE first, named by
    // identity: the two byte oracles below are each a comparison of two readings taken from
    // the SAME session, so both stay green under a `fold_dock` that writes no link at all
    // (mutation-proved 2026-08-31). Identity first, bytes after.
    assert_eq!(
        session
            .core()
            .state
            .link_target((composed.router, ROUTER_OUT_ROUTING_KEY)),
        Some((composed.belts[0], 0)),
        "the re-Dock put the router's offload edge back on the exact routing key \
         {ROUTER_OUT_ROUTING_KEY} that the first Dock wrote, pointing at the same belt",
    );
    // Bytes, never a count: a count-based assertion passes against a build that re-docked
    // the wrong belt to the wrong port.
    assert_eq!(
        link_bytes(session),
        composed.links_after_first_dock,
        "the re-Dock reproduced the links map BYTE-for-byte as the first Dock left it",
    );
    assert_eq!(
        grid_state_bytes(session),
        composed.state_before_unlink,
        "the Unlink + re-Dock pair left the WHOLE GridState byte-identical (cells, footprints, \
         ports and inboxes as well as links), so nothing else on the composed board moved",
    );

    // The FROZEN op, not merely the outcome. `GridCommand::Unlink` named the router's
    // CATALOG port 1; the arm must translate it into the ROUTING key 0 that `fold_dock`
    // wrote. Those two numbers COLLIDE on a Router, so an outcome-only assertion passes
    // against an untranslated build (`draw_wire.rs:513-528`).
    let unlinks: Vec<&EditRecord> = session
        .edit_log()
        .iter()
        .filter(|r| matches!(r.op, EditOp::Unlink { .. }))
        .collect();
    assert_eq!(
        unlinks.len(),
        1,
        "exactly one Unlink was issued on this board; found {unlinks:?}",
    );
    assert_eq!(
        unlinks[0].op,
        EditOp::Unlink {
            belt: composed.belts[0],
            endpoint: BeltEnd::Tail,
            node: composed.router,
            port: 0,
        },
        "the frozen Unlink carries resolved NodeIds AND the Out ROUTING key (catalog 1 -> emit 0)",
    );
}

// ── the ORDERING and EMPTY edges (SCHEMA-01 / SCHEMA-03) ─────────────────────

/// The number of undoable actions the composed board is built from, MEASURED by the
/// 69-RESEARCH section-1.0 probe (`PROBE undos=14 nodes_after_full_undo=0`).
///
/// Pinned rather than derived, so a fold that silently COALESCED two actions into one
/// undo step (or SPLIT one into two) is visible instead of absorbed. In particular the
/// two-belt `set_belt_run_pace` run is ONE step here, not two.
const COMPOSED_UNDO_DEPTH: usize = 14;

/// The composed log's replay order is stable at EVERY step, and it unwinds all the way to
/// an EMPTY board and redoes all the way back.
///
/// `assert_save_load_reproduces` runs after every single undo and every single redo, so
/// `undoable_stack()`, `redo_cursor()` and `id_translation()` are proved to reconstruct
/// identically from the persisted bytes at each intermediate position, not only at the
/// end. A test that only checked the final state would stay green against a build whose
/// projection diverged in the middle and re-converged.
#[test]
fn the_composed_log_unwinds_to_an_empty_board_and_redoes_back_with_equality_at_every_step() {
    let composed = build_composed_board();
    let mut session = composed.session;

    // Captured BEFORE the unwind, with `grid_state_bytes` and not `snapshot(core)`:
    // `snapshot` leads with the monotonic tick, which every accepted command advances.
    let belts_before = [
        belt_interval(&session, composed.belts[0]),
        belt_interval(&session, composed.belts[1]),
        belt_interval(&session, composed.belts[2]),
    ];
    let links_before = links_sorted(&session);
    assert_save_load_reproduces(&session, SEED);

    // ── EMPTY: unwind to a board with no nodes at all ────────────────────────
    let mut undos = 0usize;
    while session.can_undo() {
        session.apply(GridCommand::Undo).expect("a live undo step is accepted");
        undos += 1;
        assert_save_load_reproduces(&session, SEED);
        assert!(undos <= COMPOSED_UNDO_DEPTH, "the undo loop ran past the measured depth");
    }
    assert_eq!(
        undos, COMPOSED_UNDO_DEPTH,
        "the composed board is exactly {COMPOSED_UNDO_DEPTH} undoable actions deep; a different \
         depth means a fold coalesced or split a step",
    );
    assert_eq!(
        session.core().state.node_count(),
        0,
        "the composed log unwinds ALL the way to an empty board, not merely to a shallower one",
    );
    // A zero node count alone is satisfiable by a state still carrying stranded links or
    // claimed cells, so the emptiness is asserted on those surfaces too. (A byte
    // comparison against a virgin `GridSession::new(SEED)` is NOT available and is not a
    // defect: the slotmap keeps its freed slots with bumped generations, which is the
    // same accepted id-drift FLAG `live_id` exists for.)
    assert!(
        links_sorted(&session).is_empty(),
        "the emptied board carries no stranded links: {:?}",
        links_sorted(&session),
    );
    for cell in [(0, 0), (5, 0), (0, 4), (2, 5), (3, 5), (2, 8), (3, 8), (2, 10), (3, 10)] {
        assert!(
            session.core().state.occupied(cell).is_none(),
            "the emptied board released cell {cell:?}",
        );
    }

    // ── ORDERING: redo all the way back, equality re-asserted at every step ──
    let mut redos = 0usize;
    while session.can_redo() {
        session.apply(GridCommand::Redo).expect("a live redo step is accepted");
        redos += 1;
        assert_save_load_reproduces(&session, SEED);
        assert!(redos <= COMPOSED_UNDO_DEPTH, "the redo loop ran past the measured depth");
    }
    assert_eq!(redos, undos, "every undone action redoes, one for one");

    // The board that came back carries all four features at their configured values.
    // Every id is resolved through `xlate` first: the rewind re-minted them (see
    // [`live_id`]), and reading the pre-unwind ids straight off the rewound board is a
    // panic, not a pass.
    let belts_after = [
        belt_interval(&session, live_id(&session, composed.belts[0])),
        belt_interval(&session, live_id(&session, composed.belts[1])),
        belt_interval(&session, live_id(&session, composed.belts[2])),
    ];
    assert_eq!(
        belts_after, belts_before,
        "all three belt paces come back through the full unwind and rewind, the control belt \
         and the run belts alike",
    );
    assert!(
        matches!(
            session.core().state.node(live_id(&session, composed.wire)),
            Some(Node::Wire(_))
        ),
        "the wire comes back as a Node::Wire through the full unwind and rewind",
    );
    assert_eq!(
        router_state(&session, live_id(&session, composed.router)).0,
        core_routes(),
        "the Router's whole routing table comes back through the full unwind and rewind",
    );

    // The WHOLE links map, relabelled through `xlate`, and not a link count, which is
    // satisfiable by a build that re-docked the wrong belt to the wrong port.
    let mut expected: Vec<((NodeId, PortId), (NodeId, PortId))> = links_before
        .iter()
        .map(|&((a, ap), (b, bp))| ((live_id(&session, a), ap), (live_id(&session, b), bp)))
        .collect();
    expected.sort();
    assert_eq!(
        links_sorted(&session),
        expected,
        "the whole links map comes back, entry for entry, up to the accepted id re-mint",
    );
}
