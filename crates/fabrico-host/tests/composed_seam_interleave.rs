//! Phase 69-03: the v8.0 milestone audit warning **W1**, SHIPPED-SEAM half. A
//! `DrawWire`, phase 68's N-belt grouped run pace and an `Unlink` in ONE undo stack, on
//! the seam the running application actually takes (requirements WIRE-01, CONNECT-01,
//! BELT-02; ROADMAP SC3).
//!
//! # Why this claim needs a second file in a second crate
//! `Host::enqueue_action_group` (`crates/fabrico-host/src/driver.rs:380`) is the seam the
//! shipped app groups on, and it is reachable from NOWHERE in `fabrico-command`:
//! `crates/fabrico-host/Cargo.toml` depends on `fabrico-command`, so the reverse edge
//! cannot exist, and `crates/fabrico-command/tests/deps_headless.rs` is a LIVE FENCE
//! holding that crate to `fabrico-core` + `fabrico-protocol` + `serde`. This file is
//! therefore the only place the shipped grouping seam can be driven at all.
//!
//! **Which claim belongs to which file, so neither green can be cited for the other:**
//!
//! - `crates/fabrico-command/tests/composition_interleave.rs` (plan 69-02) proves the
//!   interleave on the PERSISTED LOG: three action shapes coexisting in one
//!   `Vec<EditRecord>`, with undo and redo across them surviving save, load and replay to
//!   the same `snapshot(core)`. It proves NOTHING about the shipped app, because
//!   `GridSession::set_belt_run_pace` is not a path the app takes.
//! - THIS file proves the interleave on the SHIPPED seam: `apply_gesture` for the wire
//!   and the unlink, and a hand-assembled `0xFE` run-pace frame through the real
//!   `decode_gesture` -> `apply_gesture_frame` -> `apply_run_pace` ->
//!   `Host::enqueue_action_group`. It proves NOTHING about a persisted round-trip.
//!
//! # WHAT THIS FILE'S GREEN DOES NOT COVER: byte-identity of a save
//! Every oracle below is either the EDIT LOG (`Host::logged_edits`) or the FOLDED core
//! state (a belt's `ticks_per_slot`, a `Node::Wire`, `GridState::link_target`). None is
//! `snapshot(core)`, and nothing here calls `save_project` / `load_project` /
//! `GridSession::replay_two_logs`. So a defect that folded correctly in memory and
//! persisted wrongly would pass this file. The host-side files that DO cover that are
//! `crates/fabrico-host/tests/live_undo.rs` (`undo_survives_save_load_live`,
//! `live_undo_replays_byte_identical`), and the composed round-trip is
//! `crates/fabrico-command/tests/composition_save_load.rs` (plan 69-01).
//!
//! # Every pace change goes through the REAL decode
//! The run-pace frame is HAND-ASSEMBLED from the sentinel lead byte plus LEB128 varints,
//! exactly as `belt_run_pace.rs:171-193` does, and fed to `decode_gesture` before
//! `apply_gesture_frame`. Route R1 rests on the `0xFE` sentinel peek, so a test that built
//! the frame with `postcard::to_allocvec(&BeltRunPace)` would sample the decoder against
//! its own serializer and prove the half that was never in doubt.
//!
//! # The two findings this file was written with in front of it
//! 1. (plan 69-01, mutation C) A round-trip proof measures the LOG, not the BOARD. Under a
//!    build whose `DrawWire` mints the wire node and never writes the link,
//!    `snapshot(refold) == snapshot(live)` stays GREEN, because both sides fold the same
//!    impoverished log. Every step below therefore carries its own read-back oracle.
//! 2. (plan 69-02, mutation B2) Composition alone is not sufficient either. An `Undo` that
//!    silently skips a whole `EditOp` shape is invisible to an unwind that runs all the way
//!    to an empty board. What catches it is an undo that STOPS MID-STACK and reads the
//!    board back, which is the shape of the second test below.
//!
//! # Board ordering, and why the wire is drawn LAST of the scaffolding
//! `composed_board()` places the endpoint, the factory, the added electrical In, the
//! router, three belts and the offload dock, and only THEN draws the wire. The three v8.0
//! shapes are therefore the top three actions of the stack in the order wire -> run pace ->
//! unlink, so the second test's third undo lands ON the `DrawWire` rather than on the
//! `Dock` that would otherwise sit between them. The wire is still EARLIER than the run
//! pace and the unlink is still LATER, which is the "between a wire and an unlink"
//! property the file is named for.
//!
//! NOT feature-gated in any way: `cargo test -p fabrico-host` runs every case here.

use fabrico_command::CommandError;
use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{Medium, Node, Role};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::{apply_gesture, apply_gesture_frame};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::sim_loop::{BELT_RUN_PACE_LEAD, GestureFrame};
use fabrico_host::transport_ws::{decode_gesture, frame_gesture};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind, port_medium, port_role};
use std::collections::BTreeSet;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Frame a gesture BODY as the client does since phase 88 (a two-varint header, generation 0
/// and gesture 1, then the body) and read it back through the real `decode_gesture`, the one
/// decoder both transports call. Every decode in this file goes through here, so each case
/// still reads the body it was written for.
fn decode_body(body: &[u8]) -> Result<GestureFrame, CommandError> {
    decode_gesture(&frame_gesture(0, 1, body))
        .map(|d| d.frame)
        .map_err(|e| e.error)
}

// =================================================================================
// Rig - copied from `crates/fabrico-host/tests/belt_run_pace.rs:44-202`.
//
// A copy, not a re-use, because `fabrico-host` has no shared test module and its existing
// test files each carry their own rig. NOT because sharing is impossible: each file under
// `tests/` being its own crate is precisely why the `mod common;` idiom works, and this
// repository already uses it (`crates/fabrico-core/tests/common/mod.rs`, imported by 17
// sibling files at HEAD). Hoisting this rig into `crates/fabrico-host/tests/common/mod.rs`
// alongside `belt_run_pace.rs` is the right long-term fix and is not done in this pass.
// The three gesture methods `dock`/`unlink`/`draw_wire`, the
// `add_port` method, the two undo drivers and the `port_index_on` / `live_wire` /
// `link_target` read-backs are this plan's additions.
// =================================================================================

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 7,
    }
}

/// A real `Host` over tempfile redb stores: the `test_host()` shape from
/// `input_apply.rs`, which needs no scene timers and no sim loop.
fn test_host() -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    (dir, Host::new(core, store, ledger, None).expect("open host"))
}

/// The per-tick channels `tick_once` drains (gestures ride the EDIT log, not these).
#[allow(clippy::type_complexity)]
fn channels() -> (
    UnboundedReceiver<EventPayload>,
    UnboundedSender<Command>,
    UnboundedReceiver<ResultEvent>,
) {
    let (_ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    (ingress_rx, cmd_tx, results_rx)
}

/// A board plus the dense-handle table the gesture frames address it by. The handle
/// IS the index into `nodes`, which is the whole of the `resolve` closure's job.
struct Board {
    _dir: tempfile::TempDir,
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    results_rx: UnboundedReceiver<ResultEvent>,
    /// The dense-handle table: the handle IS the index. Written once per mint and NEVER
    /// refreshed, so an entry goes STALE the moment a redo re-mints its node under a new
    /// `NodeId`. Read it through [`Board::node_id`], which makes both failure modes loud.
    nodes: Vec<NodeId>,
}

impl Board {
    fn new() -> Self {
        let (dir, host) = test_host();
        let (ingress_rx, cmd_tx, results_rx) = channels();
        Self {
            _dir: dir,
            host,
            ingress_rx,
            cmd_tx,
            results_rx,
            nodes: Vec::new(),
        }
    }

    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick folds the enqueued edits");
    }

    /// Draw a belt through the CERTIFIED command path and register its handle.
    fn draw_belt(&mut self, cells: &[(i32, i32)]) -> u64 {
        apply_gesture(
            &mut self.host,
            GridCommand::DrawBelt {
                cells: cells.to_vec(),
            },
            |_h| None,
        )
        .expect("a legal drawn path is accepted");
        self.tick();
        self.register_last_placed()
    }

    /// Place a machine through the certified path and register its handle.
    fn place(&mut self, kind: u8, cell_x: i32, cell_y: i32) -> u64 {
        apply_gesture(
            &mut self.host,
            GridCommand::Place {
                kind,
                cell_x,
                cell_y,
            },
            |_h| None,
        )
        .expect("place at a free cell");
        self.tick();
        self.register_last_placed()
    }

    fn register_last_placed(&mut self) -> u64 {
        let id = *self
            .host
            .core()
            .last_tick
            .placed
            .last()
            .expect("the fold minted an id");
        self.nodes.push(id);
        (self.nodes.len() - 1) as u64
    }

    // -- this plan's gesture additions --------------------------------------------
    //
    // Each is the SAME `apply_gesture` shape as `place`/`draw_belt` above with ONE
    // difference that is not cosmetic: the resolver. `Place` and `DrawBelt` address
    // nothing, so the null resolver is correct for them. `AddPort`, `Dock`, `Unlink` and
    // `DrawWire` all address a LIVE handle, and a null resolver would make every one of
    // them refuse with `CommandError::UnknownNode` - a green-looking test proving only
    // that a refusal refuses. They therefore pass the REAL table, the same closure
    // `feed` builds.

    /// Add a port to a live node (the far end of a wire must be GIVEN an electrical In:
    /// the FACTORY catalog arm declares none).
    fn add_port(&mut self, node: u64, role: u8, side: u8, medium: u8) {
        let table = self.nodes.clone();
        apply_gesture(
            &mut self.host,
            GridCommand::AddPort {
                node,
                role,
                side,
                medium,
            },
            move |h| table.get(h as usize).copied(),
        )
        .expect("a port is addable to a placed node");
        self.tick();
    }

    /// Dock a belt's Tail onto a machine's CATALOG port (the offload direction).
    fn dock(&mut self, belt: u64, node: u64, port: u16) {
        let table = self.nodes.clone();
        apply_gesture(
            &mut self.host,
            GridCommand::Dock {
                belt,
                endpoint: BeltEnd::Tail,
                node,
                port,
            },
            move |h| table.get(h as usize).copied(),
        )
        .expect("a valid offload dock is accepted");
        self.tick();
    }

    /// Tear down that same dock, naming the CATALOG port again (the arm translates it
    /// into the ROUTING key the fold wrote).
    fn unlink(&mut self, belt: u64, node: u64, port: u16) {
        let table = self.nodes.clone();
        apply_gesture(
            &mut self.host,
            GridCommand::Unlink {
                belt,
                endpoint: BeltEnd::Tail,
                node,
                port,
            },
            move |h| table.get(h as usize).copied(),
        )
        .expect("an unlink of a live dock is accepted");
        self.tick();
    }

    /// Draw a wire between two resolved electrical ports and register the minted wire.
    fn draw_wire(&mut self, from_node: u64, from_port: u16, to_node: u64, to_port: u16) -> u64 {
        let table = self.nodes.clone();
        apply_gesture(
            &mut self.host,
            GridCommand::DrawWire {
                from_node,
                from_port,
                to_node,
                to_port,
            },
            move |h| table.get(h as usize).copied(),
        )
        .expect("the wire is legal: electrical Out to electrical In, no self-loop");
        self.tick();
        self.register_last_placed()
    }

    /// Undo through the SAME `apply_gesture` entry point as every other gesture.
    ///
    /// No special-casing in the rig, on purpose: `input_apply.rs:424-446` routes
    /// `Undo`/`Redo` to `resolve_undo`/`resolve_redo` plus `Host::enqueue_action_group`
    /// BEFORE `validate_normalize` and returns early. Driving them any other way would
    /// be testing a path the app does not take.
    fn undo(&mut self) {
        let table = self.nodes.clone();
        apply_gesture(&mut self.host, GridCommand::Undo, move |h| {
            table.get(h as usize).copied()
        })
        .expect("undo is ACCEPTED (never CommandError::Malformed)");
        self.tick();
    }

    fn redo(&mut self) {
        let table = self.nodes.clone();
        apply_gesture(&mut self.host, GridCommand::Redo, move |h| {
            table.get(h as usize).copied()
        })
        .expect("redo is ACCEPTED (never CommandError::Malformed)");
        self.tick();
    }

    /// Feed RAW FRAME BYTES through the real decoder and the real dispatcher: the
    /// exact two steps the sim-loop drain takes for every inbound gesture.
    fn feed(&mut self, bytes: &[u8]) -> Result<(), CommandError> {
        let frame = decode_body(bytes)?;
        let table = self.nodes.clone();
        apply_gesture_frame(&mut self.host, frame, move |h| {
            table.get(h as usize).copied()
        })
    }

    fn edit_log(&self) -> Vec<EditRecord> {
        self.host.logged_edits().expect("read the edit log")
    }

    /// The belt's LIVE advance interval, read off folded core state.
    fn pace_of(&self, handle: u64) -> u32 {
        // Through `node_id`, so this inherits both of its guards rather than indexing raw.
        let id = self.node_id(handle);
        match self.host.core().state.node(id) {
            Some(Node::Belt(belt)) => belt.ticks_per_slot.get(),
            other => panic!("handle {handle} is not a live belt: {other:?}"),
        }
    }

    /// The `NodeId` registered under `handle`, guarded on BOTH ways it can be wrong.
    ///
    /// 1. OUT OF RANGE: `self.nodes[handle as usize]` panics with a bare index message,
    ///    which is the opposite of every other failure in this file.
    /// 2. STALE: the table is written once, at mint time, and is never refreshed. Redoing a
    ///    MINTING gesture re-mints the node under a NEW `NodeId` (the slotmap bumps the
    ///    generation), so the entry for such a handle is a DEAD id for the rest of the run.
    ///    Test 2 undoes past the `DrawWire` and redoes it, so the wire's handle is dead for
    ///    the whole back half of that test. No assertion reads it today (`live_wire` scans
    ///    for the wire instead, which is exactly why it exists), but a reader added against
    ///    that handle later would silently address a freed slot and surface as an ordinary
    ///    refusal. The liveness check below turns that into a named failure naming the cause.
    fn node_id(&self, handle: u64) -> NodeId {
        let id = *self.nodes.get(handle as usize).unwrap_or_else(|| {
            panic!(
                "handle {handle} is not registered on this board ({} handles registered)",
                self.nodes.len(),
            )
        });
        assert!(
            self.host.core().state.node(id).is_some(),
            "handle {handle} resolves to {id:?}, which is NOT live in the core. The handle \
             table is written at mint time and never refreshed, so this is a redo that \
             re-minted the node under a new NodeId. Scan for the node instead (see \
             `Board::live_wire`) rather than trusting the remembered handle",
        );
        id
    }

    /// The catalog index of the first port on `handle` with `role`/`medium`, READ BACK
    /// off the host's live core rather than written down as a literal. 63-07 moved
    /// several of these indices; a written-down index would silently start addressing a
    /// different port.
    fn port_index_on(&self, handle: u64, role: Role, medium: Medium) -> u16 {
        let id = self.node_id(handle);
        let ports = self
            .host
            .core()
            .state
            .ports_of(id)
            .expect("the node carries ports");
        let idx = ports
            .iter()
            .position(|p| p.role == role && p.medium == medium)
            .unwrap_or_else(|| panic!("no {role:?}/{medium:?} port among {ports:?}"));
        u16::try_from(idx).expect("a port index fits u16")
    }

    /// The LIVE wire out of `from`, found by scan rather than by a remembered `NodeId`.
    ///
    /// This is deliberately not `self.nodes[wire_handle]`. Redoing a `DrawWire` RE-MINTS
    /// the wire under a NEW `NodeId` (that is what `GridSession::id_translation` exists
    /// for), so a remembered id is stale the moment the second test redoes. The scan
    /// (`GridState::wire_from_node`) is the same one the `WireRequest` admit arm uses to
    /// find the entry wire, so it is an oracle the running system already depends on.
    fn live_wire(&self, from: NodeId) -> Option<NodeId> {
        self.host.core().state.wire_from_node(from)
    }

    /// The forward link out of `(node, port)`, the topology oracle.
    ///
    /// Not a link COUNT: a count is satisfiable by a build that re-docked the wrong belt
    /// to the wrong port. The target is the exact surface CONNECT-01 is a claim about.
    fn link_target(&self, node: NodeId, port: u16) -> Option<(NodeId, u16)> {
        self.host.core().state.link_target((node, port))
    }

    /// The live count of undoable actions, and the ONLY correct "how many undo steps"
    /// oracle in this codebase.
    ///
    /// NOT `undoable_stack().len()`: that stack retains the undone/redoable tail
    /// (`command.rs:4097-4103`), so its length is INVARIANT under undo and an assertion
    /// on it could never fail. Plan 69-02 caught exactly that check-that-cannot-fail
    /// before it shipped (recorded in the internal defect ledger), and this file inherits the correction.
    fn live_actions(&self) -> usize {
        self.host.session().redo_cursor()
    }
}

/// Encode a run-pace frame EXACTLY as `frontend/src/protocol/decode.ts`'s
/// `encodeBeltRunPace` does: the sentinel as ONE RAW BYTE, then the postcard body.
///
/// Hand-assembled rather than `postcard::to_allocvec(&BeltRunPace)` prefixed with the
/// byte: the point of these cases is that the BROWSER's bytes decode, and building
/// them from the Rust struct would sample the decoder against its own serializer.
fn run_frame(belts: &[u64], ticks_per_slot: u32) -> Vec<u8> {
    let mut out = vec![BELT_RUN_PACE_LEAD];
    varint(&mut out, belts.len() as u64);
    for &b in belts {
        varint(&mut out, b);
    }
    varint(&mut out, u64::from(ticks_per_slot));
    out
}

/// LEB128, the grammar `PostcardWriter.varintU` writes.
fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// The DISTINCT `action` ids across the Configure records in the log.
///
/// THE reason this is a cardinality and not a record count: three `Configure` records
/// under ONE action id (one undo step, correct) and three under THREE action ids (three
/// undo steps, broken) have exactly the same record count, and every assertion that the
/// belts hold the new pace is green under both. Only this set's size separates them.
fn configure_actions(log: &[EditRecord]) -> BTreeSet<u64> {
    log.iter()
        .filter(|r| matches!(r.op, EditOp::Configure { .. }))
        .map(|r| r.action)
        .collect()
}

/// How many `Configure` records the log carries, counted SEPARATELY from
/// [`configure_actions`] on purpose. See that helper's docblock.
fn configure_records(log: &[EditRecord]) -> usize {
    log.iter()
        .filter(|r| matches!(r.op, EditOp::Configure { .. }))
        .count()
}

// =================================================================================
// The composed board
// =================================================================================

/// The ROUTER catalog's Out port index (`port_catalog`: In at 0, Out at 1). Its ROUTING
/// key is 0, so the two numbers COLLIDE on a Router: the dock's link key is
/// `(router, 0)` while the gesture names catalog `1` (`command.rs:785`).
const ROUTER_OUT_CATALOG: u16 = 1;

/// The Router's ROUTING key for `ROUTER_OUT_CATALOG`, which is what `fold_dock` wrote
/// into `links` and therefore what `link_target` is keyed by.
const ROUTER_OUT_ROUTING_KEY: u16 = 0;

/// The pace this file writes. Deliberately NOT [`DEFAULT_TICKS_PER_SLOT`], or every belt
/// assertion below would be satisfied by a build that wrote nothing at all.
const NEW_PACE: u32 = 10;

/// The number of undoable actions [`composed_board`] leaves on the stack: Place ENDPOINT,
/// Place FACTORY, AddPort, Place ROUTER, three DrawBelts, Dock, DrawWire.
const SCAFFOLD_ACTIONS: usize = 9;

/// The composed board plus the ids and handles the tests read back.
struct Composed {
    board: Board,
    /// The ENDPOINT: the wire's source, and the node [`Board::live_wire`] scans from.
    /// Never undone in either test, so its id is stable across every redo.
    endpoint: NodeId,
    factory: NodeId,
    /// The catalog index of the `AddPort`-ed electrical In, READ BACK off the factory.
    factory_in_port: u16,
    router: NodeId,
    /// The router's dense handle, carried rather than written down as a literal at each
    /// `unlink` call site.
    router_handle: u64,
    /// The three belt handles in draw order. Belt 0 is the docked offload belt; ALL
    /// THREE take the run pace under one action id.
    belts: [u64; 3],
}

/// Build one board carrying a live wire and a live offload dock, with the wire drawn
/// LAST so the three v8.0 shapes are the top of the stack. See the file header's
/// "Board ordering" note for why the order is load-bearing.
fn composed_board() -> Composed {
    let mut board = Board::new();

    // -- the wire's two ends -------------------------------------------------------
    // ENDPOINT is the only catalog arm with electrical ports, so the far end must be
    // GIVEN an electrical `Role::In`. The `AddPort` is mandatory, not decorative.
    let ep_h = board.place(machine_kind::ENDPOINT, 0, 0);
    let factory_h = board.place(machine_kind::FACTORY, 5, 0);
    board.add_port(
        factory_h,
        port_role::IN,
        3, // W
        port_medium::ELECTRICAL,
    );

    // -- the router, three belts and the proven-valid offload dock -----------------
    // A 2x3 ROUTER anchored at (0, 4) puts its Out port 1 at world (1, 5) facing E (the
    // middle row since plan 74.1-14; it was (1, 6)), so a belt drawn tail-first at (2, 5) -> (3, 5) presents its tail one step E of that
    // port, facing W = opposite(E). Docking the Tail to catalog port 1 links exactly one
    // directed edge (the geometry reused verbatim in five existing files).
    let router_h = board.place(machine_kind::ROUTER, 0, 4);
    let belt_a = board.draw_belt(&[(2, 5), (3, 5)]);
    let belt_b = board.draw_belt(&[(2, 8), (3, 8)]);
    let belt_c = board.draw_belt(&[(2, 10), (3, 10)]);
    board.dock(belt_a, router_h, ROUTER_OUT_CATALOG);

    // -- the wire, LAST of the scaffolding (WIRE-01) -------------------------------
    let from_port = board.port_index_on(ep_h, Role::Out, Medium::Electrical);
    let factory_in_port = board.port_index_on(factory_h, Role::In, Medium::Electrical);
    board.draw_wire(ep_h, from_port, factory_h, factory_in_port);

    let endpoint = board.node_id(ep_h);
    let factory = board.node_id(factory_h);
    let router = board.node_id(router_h);

    // The board really carries what the tests are about to claim about, BEFORE any of
    // them claims it. Each of these is a read-back, not a restatement of the gesture.
    assert!(
        board.live_wire(endpoint).is_some(),
        "the DrawWire fold minted a Node::Wire out of the endpoint",
    );
    assert_eq!(
        board.link_target(
            board.live_wire(endpoint).expect("the wire is live"),
            0
        ),
        Some((factory, factory_in_port)),
        "the wire's forward link reaches the AddPort-ed electrical In (a mint without a \
         link is plan 69-01's mutation C, and it is invisible to a round-trip oracle)",
    );
    assert_eq!(
        board.link_target(router, ROUTER_OUT_ROUTING_KEY),
        Some((board.node_id(belt_a), 0)),
        "the offload dock wrote exactly one directed edge out of the router's Out",
    );
    assert_ne!(
        DEFAULT_TICKS_PER_SLOT.get(),
        NEW_PACE,
        "the written pace must differ from the crate default, or no belt assertion in \
         this file can fail",
    );
    for h in [belt_a, belt_b, belt_c] {
        assert_eq!(
            board.pace_of(h),
            DEFAULT_TICKS_PER_SLOT.get(),
            "belt {h} starts at the crate default pace",
        );
    }
    assert_eq!(
        board.live_actions(),
        SCAFFOLD_ACTIONS,
        "the scaffolding is exactly {SCAFFOLD_ACTIONS} live actions deep, so the three \
         v8.0 shapes applied on top of it are the top three of the stack",
    );
    assert!(
        configure_actions(&board.edit_log()).is_empty(),
        "the scaffolding carries no Configure at all, so every Configure counted below \
         came from the run-pace frame or from undoing it",
    );

    Composed {
        board,
        endpoint,
        factory,
        factory_in_port,
        router,
        router_handle: router_h,
        belts: [belt_a, belt_b, belt_c],
    }
}

// =================================================================================
// Test 1: the three shapes interleave on the shipped seam
// =================================================================================

/// **ROADMAP SC3, the W1 shipped-seam half.** A `DrawWire`, a hand-assembled `0xFE`
/// run-pace frame decoded by the real decoder, and an `Unlink`, all in one undo stack on
/// the seam the running app takes.
///
/// The per-feature read-backs are LOAD-BEARING and are not decoration. Plan 69-01
/// measured (mutation C) that a whole-log equality oracle stays GREEN under a build that
/// dropped a feature outright, because both sides fold the same impoverished log. Each of
/// the three shapes is therefore read back off the folded core in its own terms.
#[test]
fn drawwire_unlink_and_a_raw_run_pace_frame_interleave_on_the_shipped_seam() {
    let Composed {
        mut board,
        endpoint,
        factory,
        factory_in_port,
        router,
        router_handle,
        belts,
    } = composed_board();

    // -- shape 2: the run pace, through the REAL decode ----------------------------
    // `feed` is `decode_gesture(bytes)` then `apply_gesture_frame`, the exact two steps
    // the sim-loop drain takes. Nothing here calls the fan-out directly.
    board
        .feed(&run_frame(&belts, NEW_PACE))
        .expect("a three-belt run frame naming three live belts is accepted");
    board.tick();

    // -- shape 3: the unlink, LAST -------------------------------------------------
    board.unlink(belts[0], router_handle, ROUTER_OUT_CATALOG);

    // -- all three belts took the new pace -----------------------------------------
    for h in belts {
        assert_eq!(
            board.pace_of(h),
            NEW_PACE,
            "belt {h} holds the decoded run pace after an Unlink landed on top of it",
        );
    }

    // -- the wire, drawn BEFORE both of them, is untouched -------------------------
    let wire = board
        .live_wire(endpoint)
        .expect("the wire survives a run pace and an unlink applied over it");
    assert!(
        matches!(board.host.core().state.node(wire), Some(Node::Wire(_))),
        "the surviving wire is still a Node::Wire",
    );
    assert_eq!(
        board.link_target(wire, 0),
        Some((factory, factory_in_port)),
        "the wire's forward link still reaches the electrical In after a decoded run \
         pace and an Unlink were applied over it",
    );

    // -- the dock is gone, and ONLY the dock ---------------------------------------
    assert_eq!(
        board.link_target(router, ROUTER_OUT_ROUTING_KEY),
        None,
        "the Unlink tore down the router's offload edge (catalog {ROUTER_OUT_CATALOG} \
         translated to routing key {ROUTER_OUT_ROUTING_KEY})",
    );

    // -- the grouping property, on the CARDINALITY ---------------------------------
    // Three records under one action id and three under three action ids have the SAME
    // record count, and every pace assertion above is green under both. The two numbers
    // are asserted separately for exactly that reason.
    let log = board.edit_log();
    assert_eq!(
        configure_records(&log),
        3,
        "the three-belt run frame logged one Configure per belt",
    );
    assert_eq!(
        configure_actions(&log).len(),
        1,
        "the three Configure records share exactly ONE action id: a cardinality of 3 is \
         the split-group defect, and it is invisible to every other assertion here",
    );
    assert_eq!(
        board.live_actions(),
        SCAFFOLD_ACTIONS + 2,
        "the run pace counts as ONE action beside the Unlink; a depth of {} is the \
         split-group defect",
        SCAFFOLD_ACTIONS + 4,
    );
}

// =================================================================================
// Test 2: the group undoes as ONE step, and the undo STOPS MID-STACK
// =================================================================================

/// **ROADMAP SC3 / BELT-02.** The grouped run pace undoes as a single step with a wire
/// beneath it and an unlink above it, and the undo STOPS at each boundary so the board
/// can be read back there.
///
/// Stopping is the whole point. Plan 69-02 measured (mutation B2) that an `Undo` which
/// silently skips an entire `EditOp` shape passes a full unwind to an empty board and
/// passes `undo_redo.rs` at 34 of 34. Only an undo that halts in the middle and reads the
/// board back can see it.
#[test]
fn the_run_pace_group_undoes_as_one_step_between_a_wire_and_an_unlink() {
    let Composed {
        mut board,
        endpoint,
        factory,
        factory_in_port,
        router,
        router_handle,
        belts,
    } = composed_board();

    let default_pace = DEFAULT_TICKS_PER_SLOT.get();

    // The same three shapes, in the same order as test 1.
    board
        .feed(&run_frame(&belts, NEW_PACE))
        .expect("a three-belt run frame naming three live belts is accepted");
    board.tick();
    board.unlink(belts[0], router_handle, ROUTER_OUT_CATALOG);

    let actions_at_top = board.live_actions();
    assert_eq!(
        actions_at_top,
        SCAFFOLD_ACTIONS + 2,
        "the stack is the scaffolding plus exactly two more actions (the run pace is ONE)",
    );
    let configure_actions_at_top = configure_actions(&board.edit_log()).len();
    assert_eq!(
        configure_actions_at_top, 1,
        "one action id covers the whole run at the top of the stack",
    );

    // -- undo 1: the Unlink, and NOTHING else --------------------------------------
    board.undo();
    assert_eq!(
        board.link_target(router, ROUTER_OUT_ROUTING_KEY),
        Some((board.node_id(belts[0]), 0)),
        "one undo restored the offload dock the Unlink tore down",
    );
    for h in belts {
        assert_eq!(
            board.pace_of(h),
            NEW_PACE,
            "undoing the Unlink left belt {h}'s run pace standing beneath it",
        );
    }
    assert!(
        board.live_wire(endpoint).is_some(),
        "undoing the Unlink did not disturb the wire two steps below it",
    );
    assert_eq!(
        board.live_actions(),
        actions_at_top - 1,
        "the Unlink undo consumed exactly one live action",
    );

    // -- undo 2: the WHOLE run pace, in ONE step -----------------------------------
    // ALL THREE belts, from ONE Ctrl+Z. Under a build that grouped per belt this leaves
    // two belts at NEW_PACE, which is D-68-07's regression stated as an assertion.
    board.undo();
    for h in belts {
        assert_eq!(
            board.pace_of(h),
            default_pace,
            "ONE undo returned belt {h} to the crate default: the three-belt run is a \
             single undo step (BELT-02 / D-68-07)",
        );
    }
    let wire_before_its_undo = board
        .live_wire(endpoint)
        .expect("undoing the run pace did not disturb the wire beneath it");
    assert_eq!(
        board.link_target(wire_before_its_undo, 0),
        Some((factory, factory_in_port)),
        "the wire drawn beneath the run pace is still linked after the grouped undo",
    );
    assert_eq!(
        board.link_target(router, ROUTER_OUT_ROUTING_KEY),
        Some((board.node_id(belts[0]), 0)),
        "the restored dock survived the grouped undo above it",
    );
    assert_eq!(
        board.live_actions(),
        actions_at_top - 2,
        "the three-belt run consumed exactly ONE live action, not three; a reading of {} \
         here is the split-group defect",
        actions_at_top - 4,
    );

    // The compensating group is itself ONE action covering all three belts. The forward
    // run contributed one action id and this undo contributed a second: the log is
    // append-only, so undoing a Configure APPENDS an inverse Configure rather than
    // retracting the original (`command.rs:3272-3280`).
    let log_after_group_undo = board.edit_log();
    assert_eq!(
        configure_records(&log_after_group_undo),
        6,
        "the compensating group carries one Configure per belt, appended beside the \
         forward three",
    );
    assert_eq!(
        configure_actions(&log_after_group_undo).len(),
        configure_actions_at_top + 1,
        "the compensating group shares ONE action id of its own: a cardinality of {} \
         means the undo emitted a separate step per belt",
        configure_actions_at_top + 3,
    );

    // -- undo 3: the wire itself ---------------------------------------------------
    board.undo();
    assert_eq!(
        board.live_wire(endpoint),
        None,
        "the third undo removed the DrawWire, the shape at the bottom of the three",
    );
    for h in belts {
        assert_eq!(
            board.pace_of(h),
            default_pace,
            "undoing the wire left belt {h} where the grouped undo put it",
        );
    }
    assert_eq!(
        board.live_actions(),
        actions_at_top - 3,
        "three undos consumed exactly three live actions",
    );

    // -- redo x3: back to the post-unlink board ------------------------------------
    board.redo();
    board.redo();
    board.redo();

    // The wire is RE-MINTED under a new NodeId, which is why this is a scan and not the
    // id captured before the undos.
    let rewired = board
        .live_wire(endpoint)
        .expect("redoing the DrawWire re-minted the wire");
    assert!(
        matches!(board.host.core().state.node(rewired), Some(Node::Wire(_))),
        "the re-minted wire is a Node::Wire",
    );
    assert_eq!(
        board.link_target(rewired, 0),
        Some((factory, factory_in_port)),
        "the re-minted wire is linked to the same electrical In it was drawn to",
    );
    for h in belts {
        assert_eq!(
            board.pace_of(h),
            NEW_PACE,
            "redoing the run pace put belt {h} back on the decoded pace",
        );
    }
    assert_eq!(
        board.link_target(router, ROUTER_OUT_ROUTING_KEY),
        None,
        "redoing the Unlink tore the offload edge back down",
    );
    assert_eq!(
        board.live_actions(),
        actions_at_top,
        "three redos returned the stack to its top-of-stack depth",
    );

    // The redo appends a THIRD run-pace action id and a third set of three records. The
    // count and the cardinality are asserted separately, for the same reason as above.
    let log_after_redo = board.edit_log();
    assert_eq!(
        configure_records(&log_after_redo),
        9,
        "the redone run appended one Configure per belt for the third time",
    );
    assert_eq!(
        configure_actions(&log_after_redo).len(),
        configure_actions_at_top + 2,
        "the redone run is ONE action id, exactly like the forward run and the \
         compensating group: three appended groups, three action ids, nine records",
    );
}
