//! The deterministic fixture-regen ("bless") path — Open Q3.
//!
//! This file AUTHORS the harness fixture corpus via the [`Scene`] builder and writes
//! each scenario's `to_fixture().to_bytes()` to `crates/fabrico-scenario/fixtures/
//! <name>.postcard`. It is the regen path a SCHEMA BUMP runs to re-emit the committed
//! fixtures from the Rust authoring code — kept DELIBERATELY SEPARATE from the core
//! 0001-0015 golden cert corpus re-bless, so a `Scenario`/`EditRecord`/`Event` schema
//! change has a regen path that does not touch the certified core fixtures.
//!
//! - [`bless_fixtures`] is `#[ignore]`-by-default; run it explicitly to (re)write the
//!   `.postcard` files: `cargo test -p fabrico-scenario --test bless_fixtures -- --ignored`.
//! - [`fixtures_are_deterministic`] (normal) re-authors each scenario twice and asserts
//!   the bytes are byte-identical — the deterministic-regen guarantee Open Q3 needs.
//! - [`committed_fixtures_match_authoring`] (normal) is the DRIFT GUARD: it asserts the
//!   committed `.postcard` bytes equal freshly-authored bytes, so an authoring-code or
//!   schema change that was not re-blessed fails the normal test run (forcing a bless).
//!
//! # Expressivity boundary (recorded, not papered over)
//! Every BUILD/RUN/EDIT/UNDO step below is a `GridCommand` driven through `Scene`. The
//! two boundaries the command layer deliberately does NOT cross at v2.0 are BEHAVIORAL
//! CONFIG, not topology — (1) CUSTOM FACTORY JS and (2) ROUTER ROUTE TABLE.
//!
//! (1) CUSTOM FACTORY JS — a `Place{FACTORY}` mints the FIXED default passthrough
//! `export default function (input, ctx) { ctx.emit(0, input); }` (tick.rs
//! `DEFAULT_FACTORY_SOURCE`); there is no `GridCommand` to author custom JS (Pitfall 5).
//! The factory below is a REAL running QuickJS node, just the default.
//!
//! (2) ROUTER ROUTE TABLE — a `Place{ROUTER}` mints `add_router([], Some(0))`: an EMPTY
//! route table whose default output is port 0. There is no `GridCommand` to configure a
//! router's routes/default; the default route port 0 is where every item exits. Since
//! Phase 20 (Finding 1) an Out dock freezes the ROUTING key — the router's docked Out
//! belt is keyed on 0 == the default route port — so a routed item now actually rides
//! the docked Out belt. The multi-cell ROUTER + DrawBelt + Dock are all expressible as
//! TOPOLOGY (node→node Wire was retired in 17-02; belts come only from DrawBelt +
//! explicit Dock); CONFIGURING routes beyond the default remains the same family of
//! "behavioral config not on the wire" boundary as custom factory JS.
//!
//! Neither is a command-layer LEAK (no step here reaches around `GridCommand` into the
//! core); both are recorded as future seeds in the plan SUMMARY.

// The workspace-root `clippy.toml` disallows `std::fs` IO to keep the sim CORE free of
// ambient filesystem access. `fabrico-scenario` has no determinism gate of its own (only
// `fabrico-core` does); writing/reading the fixture corpus from THIS regen test is the
// sanctioned filesystem IO (exactly like `deps_headless.rs` spawning `cargo tree`), so
// the disallowed-methods lint is allowed for this fixture-bless file only.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::path::PathBuf;

use fabrico_core::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE};
use fabrico_core::command::Effect;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::Node;
use fabrico_core::wire::DEFAULT_WIRE_BUDGET;
use fabrico_protocol::machine_kind::{ENDPOINT, FACTORY, MERGE, ROUTER, SINK, SOURCE};
use fabrico_protocol::{BeltEnd, MachineConfig, RouteKey, port_medium, port_role};

use fabrico_command::{GridSession, ROUTER_OUT_ARITY};
use fabrico_scenario::{Handle, Scene, tick_hash};

/// The genesis seed of the headline exit-gate scenario.
const EXIT_GATE_SEED: u64 = 0x1306_5EED;
/// The genesis seed of the belt-transport seed scenario.
const BELT_SEED: u64 = 0x0BE1_7000;
/// Idle settle ticks after the run so the belts finish transporting and settle before
/// the edit/undo (Pitfall 1). Bounded and cheap (well under `MAX_REPLAY_SPAN`); the
/// gap ticks are re-folded on replay because the EDIT records that follow are stamped
/// at the post-settle tick (run_log_two_logs folds every intermediate idle tick).
///
/// # A BUDGET, therefore DERIVED (SLOT-03, plan 62-03)
/// A belt advances one slot every `ticks_per_slot` ticks, so the settle a multi-tile
/// belt needs scales one-for-one with that interval. This is HEADROOM and not an
/// expectation, so it is multiplied by the construction default and re-derives at
/// whatever interval ships.
///
/// # This is the ONE budget whose under-run is COMMITTED
/// The unraised 64 has three ticks of margin at an interval of 4 (measured), which
/// makes two other budgets numerically tighter. It is still the one to be most
/// careful with, for a reason that is not about margin: every other budget's under-run
/// spoils a single test run and is gone. This one authors the golden corpus. Bless a
/// scenario mid-transport and the fixture BYTES change for a reason nobody chose, and
/// they stay changed. The free tell is the `items=` field of the three insta snapshot
/// summary lines (`01-exit-gate` is `items=1`, the deliberately dangling offload-belt
/// head; `02-belt-transport` and `03-undo-redo-live` are both `items=0`, fully
/// settled). Any movement in those three integers means a fixture was blessed
/// mid-transport.
const SETTLE: u64 = settle_for(DEFAULT_TICKS_PER_SLOT.get());

/// The settle HEADROOM a board whose slowest belt runs at `ticks_per_slot` needs, in
/// sim ticks.
///
/// This is [`SETTLE`]'s own derivation, given a name so the two speed scenes can call it
/// with THEIR slowest interval instead of borrowing a constant derived from the
/// construction default. `SETTLE` is now literally `settle_for(DEFAULT_TICKS_PER_SLOT)`,
/// so the shared budget and the per-scene ones cannot drift apart.
///
/// A scene that configures a belt SLOWER than the construction default settles LATER
/// than every scene above, by exactly the ratio of the two intervals - so reusing
/// `SETTLE` there would under-run the budget by that same ratio, and the under-run is
/// COMMITTED (see [`SETTLE`]'s docblock).
const fn settle_for(ticks_per_slot: u32) -> u64 {
    64 * ticks_per_slot as u64
}

/// The advance ticks a length-`tiles` belt at `ticks_per_slot` takes to carry one item
/// from its tail slot to its head slot: `(SLOTS_PER_TILE * tiles - 1) * ticks_per_slot`,
/// the traverse-time contract stated at the top of `fabrico_core::belt_slots`.
///
/// EXCLUDES the admission-alignment offset of at most `ticks_per_slot - 1` ticks (a belt
/// advances only on ticks where `T % ticks_per_slot == 0`, so an item admitted just after
/// a due tick waits for the next one). A caller comparing two runs mid-flight must add
/// that offset itself; a caller sizing a whole-board settle should use [`settle_for`],
/// which carries headroom for the alignment, the machine hops and the source drain.
const fn belt_traverse(tiles: u32, ticks_per_slot: u32) -> u64 {
    ((SLOTS_PER_TILE * tiles - 1) * ticks_per_slot) as u64
}

/// The port-facing `side` wire byte: `N = 0`, `E = 1`, `S = 2`, `W = 3`.
///
/// `fabrico_protocol` exports `port_role` and `port_medium` as named constant modules but
/// spells the side convention only in `GridCommand::AddPort`'s doc, so the two values the
/// endpoint scenes need are transcribed here rather than written as bare integers at four
/// call sites.
const SIDE_E: u8 = 1;
/// The W facing (see [`SIDE_E`]).
const SIDE_W: u8 = 3;

/// One unstamped `ManualInject` of `item` into the source behind `target` (pump
/// overwrites tick/sequence/partition — the session owns ordering).
fn inject(target: NodeId, item: &[u8]) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::ManualInject {
            target,
            port: 0,
            item: Item(item.to_vec()),
        },
    }
}

/// One unstamped `WireRequest` addressed to `caller`'s port 0 (pump overwrites
/// tick/sequence/partition, exactly as [`inject`]).
///
/// `caller` is BOTH the request's origin and its reply target: `manual_inject::admit`
/// selects the ENTRY WIRE as the live `Node::Wire` whose `from.node == return_addr.0`,
/// so a request naming a node with no outgoing wire is DROPPED rather than folded.
///
/// `deadline_tick` is `u64::MAX` because the reply deadline is a HOST-side concern (the
/// Phase-38 pending-request registry retires the correlation on it); nothing in the core
/// fold reads the field, and a finite value would be a number this fixture invented.
///
/// `body` must be VALID JSON when a `Node::Factory` services the request: the sandbox
/// hands the request payload to `JSON.parse` before the handler runs, so a bare
/// `b"ping"` faults the factory with `FactoryError` and emits NO command at all. That
/// was measured (a plain-bytes body produced `cmds=[] faulted=[factory]`), not assumed.
fn request(caller: NodeId, correlation: u64, body: &[u8]) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::WireRequest {
            correlation,
            deadline_tick: u64::MAX,
            budget: DEFAULT_WIRE_BUDGET,
            return_addr: (caller, 0),
            payload: Item(body.to_vec()),
        },
    }
}

/// How many of `belt`'s slots are occupied RIGHT NOW - the per-belt half of
/// [`StateSummary`]'s aggregate `items` count.
///
/// A TEST-LOCAL free function, not a `Scene` method: `Scene::core()` already exposes the
/// whole read side, so this carries none of the this-phase-or-never asymmetry the
/// `Scene` command mappings do (plan 63-08 took the same decision for `ports_of`).
///
/// # Panics
/// Panics if `belt` is not a live `Node::Belt` (an authoring bug).
fn belt_items(scene: &Scene, belt: Handle) -> usize {
    let id = scene
        .node_id(belt)
        .expect("belt_items: the handle resolves to a live node");
    match scene.core().state.node(id) {
        Some(Node::Belt(b)) => b.slots.iter().filter(|s| s.is_some()).count(),
        _ => panic!("belt_items: the handle names a Node::Belt"),
    }
}

/// AUTHOR the COMPLEX exit-gate scenario — the milestone exit gate (TEST-05), built,
/// run, edited, and undone ENTIRELY through `GridCommand` via [`Scene`]:
///
/// BUILD (topology, edit-log): a multi-cell `ROUTER` (the `>1×1` exemplar) + two
/// `SOURCE`s + a default-JS `FACTORY` passthrough + a `SINK`; a DRAWN offload belt
/// docked (`Tail`→Out) to the router; `Wire`s linking source A → factory → sink and
/// source B → router In; a `Rotate` of the factory.
///
/// RUN (event-log): ONE `pump` of two `ManualInject`s — one per DISTINCT source at the
/// SAME tick (the qualifying arrival-order batch) — then `advance(SETTLE)` so the
/// factory chain transports + processes its item.
///
/// EDIT then UNDO: `move_` the sink (delete+place under one action) and `undo` it —
/// the build→run→edit→undo arc, all logged, replayable, headless.
fn author_exit_gate() -> Scene {
    let mut s = Scene::new(EXIT_GATE_SEED);

    // ── BUILD ────────────────────────────────────────────────────────────────────
    // The multi-cell (2×3) ROUTER @ (5,0): In port 0 (W, world (5,1), facing (4,1)),
    // Out port 1 (E, world (6,1), facing (7,1)). The non-trivial `>1×1` placement
    // exemplar, all via GridCommand::Place. Both nubs sit on the middle row since plan
    // 74.1-14 (the "Edits keep middle layout" rule); until then the In
    // was (5,0) and the Out (6,2), and the two belts below were drawn to those cells.
    let r = s.place(ROUTER, 5, 0);
    // Two DISTINCT sources (the same-tick arrival-order batch): src_b feeds the router
    // In on row 0; src_a feeds a sink on row 5.
    let src_b = s.place(SOURCE, 0, 0);
    let src_a = s.place(SOURCE, 0, 5);
    let sink = s.place(SINK, 5, 5);
    // A REAL QuickJS factory (the FIXED default passthrough, no custom-JS command),
    // placed ISOLATED at (0,10) purely to exercise Place{FACTORY} + a Rotate on a real
    // 3×3 machine (its item-processing path is certified by golden 0005; docking to a
    // rotated 3×3 factory is out of this fixture's scope).
    let fac = s.place(FACTORY, 0, 10);

    // Rotate the isolated factory one clockwise quarter-turn (FOOT-02) via
    // GridCommand::Rotate — exercises the Rotate command on a real placed multi-cell
    // machine. It stays isolated, so no dock geometry depends on its post-rotation ports.
    s.rotate(fac, false);

    // ── the runtime chains, all DrawBelt + Dock (post-Wire model; belts carry real
    //    geometry and each end is an explicit Dock) ──
    // src_b Out (world (0,0) faces E) -> belt -> router In port 0 (world (5,1) faces W):
    // a 5-tile belt (1,0)..(3,0) then down to (3,1) and east to (4,1), Tail one step E of
    // src_b, Head one step W of the In (arriving straight).
    let belt_in = s.draw_belt(&[(1, 0), (2, 0), (3, 0), (3, 1), (4, 1)]);
    s.dock(belt_in, BeltEnd::Tail, src_b, 0);
    s.dock(belt_in, BeltEnd::Head, r, 0);
    // A DRAWN OFFLOAD belt off the router Out (catalog port 1, world (6,1) faces E):
    // tail (7,1) one step E, outward W = opposite E - a valid OFFLOAD dock (machine
    // Out → belt). The dock freezes the Out ROUTING key 0 (Phase 20 Finding 1), which
    // == the router's fold_place default route port — so the item pumped into the
    // router In actually RIDES this belt to its undocked head and waits there:
    // delivered-but-dangling, not docked-but-undelivered.
    let belt_off = s.draw_belt(&[(7, 1), (8, 1)]);
    s.dock(belt_off, BeltEnd::Tail, r, 1);
    // src_a Out (world (0,5) faces E) -> belt -> sink In (world (5,5) faces W): a 4-tile
    // belt (1,5)..(4,5) OFFLOAD-docked to src_a and LOAD-docked to the sink.
    let belt_main = s.draw_belt(&[(1, 5), (2, 5), (3, 5), (4, 5)]);
    s.dock(belt_main, BeltEnd::Tail, src_a, 0);
    s.dock(belt_main, BeltEnd::Head, sink, 0);

    // ── RUN ──────────────────────────────────────────────────────────────────────
    // One item per DISTINCT source, pumped in ONE call so both are stamped at the SAME
    // tick (the distinct-source same-tick batch the arrival-order proof requires).
    let a = s.node_id(src_a).expect("source A resolves to a NodeId");
    let b = s.node_id(src_b).expect("source B resolves to a NodeId");
    s.pump(&[inject(a, b"123"), inject(b, b"456")]);
    // Settle the belts so the chains finish transporting their items. `SETTLE` is a
    // DERIVED budget (see its docblock): it stretches with the belt advance interval,
    // because how long a chain takes to clear is exactly what that interval sets.
    s.advance(SETTLE);

    // ── EDIT then UNDO ───────────────────────────────────────────────────────────
    // Move the sink (delete+place under ONE action — the Phase-12 coalescing edit),
    // then undo the move. Both are logged GridCommands; undo appends its frozen,
    // retargeted inverse group (the build→run→EDIT→UNDO arc closes here).
    s.move_(sink, SINK, 12, 2);
    s.undo();

    s
}

/// AUTHOR the simpler belt-transport seed scenario: a DRAWN belt carrying a pumped item
/// from a `SOURCE` to a `SINK`, settled. Post-Wire (17-02) the SOURCE/SINK catalog now
/// carries real ports (SOURCE Out on E, SINK In on W), so the transport is a genuine
/// DrawBelt + Dock chain: the source Out OFFLOAD-docks the belt Tail and the sink In
/// LOAD-docks the belt Head. It exercises source admit → belt transport → sink consume,
/// the second corpus entry alongside the complex exit gate.
fn author_belt_transport() -> Scene {
    let mut s = Scene::new(BELT_SEED);
    let src = s.place(SOURCE, 0, 0);
    let sink = s.place(SINK, 5, 0);
    // src Out (world (0,0) faces E, facing (1,0)) -> belt -> sink In (world (5,0) faces
    // W, facing (4,0)): a 4-tile belt (1,0)..(4,0), Tail->src, Head->sink.
    let belt = s.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
    s.dock(belt, BeltEnd::Tail, src, 0);
    s.dock(belt, BeltEnd::Head, sink, 0);
    let src_id = s.node_id(src).expect("source resolves to a NodeId");
    s.pump(&[inject(src_id, b"789")]);
    s.advance(SETTLE);
    // A LOGGED RECORD AFTER THE SETTLE, so the fixture replays to the board this scene
    // settled at rather than stopping mid-transport. `advance` is UNLOGGED trailing time: a
    // fixture is `(seed, edit_log, event_log)` and `replay_two_logs` folds ticks
    // `0 ..= max(tick)` over those two logs, so without a post-settle record the settle
    // contributes ZERO bytes and the committed fixture is not the scenario the name promises.
    // The undo/redo pair is copied from `author_undo_redo_live` deliberately: it leaves the
    // FINAL TOPOLOGY identical (the Head dock is detached and re-attached), so only the item
    // state moves and the snapshot summary keeps its node and belt counts. Phase 70 plan
    // 70-04, under the declared-moves gate; the byte-freeze is what made this unpayable
    // before, not any doubt about it.
    s.undo();
    s.redo();
    s
}

/// The genesis seed of the live undo/redo arc scenario (Phase 19).
const UNDO_REDO_SEED: u64 = 0x0170_D0ED;

/// AUTHOR the live undo/redo arc scenario (Phase 19, UNDO-05) — a build→undo→redo arc
/// driven ENTIRELY through `GridCommand` via [`Scene`], the ADDITIVE corpus entry the
/// live undo/redo determinism proofs freeze headless.
///
/// BUILD: a `SOURCE` + `SINK` chained by a DRAWN belt (Tail→source Out, Head→sink In),
/// then a pumped item settled through the chain.
///
/// UNDO then REDO: `undo` the Head dock (the belt detaches from the sink), then `redo`
/// it (the dock is restored). Both are logged `GridCommand`s appending their frozen,
/// retargeted inverse groups — so `replay_two_logs` reproduces the final docked state
/// from genesis. The secondary `StateSummary` line is id-free, so freezing this hash is
/// undo/redo-id-stable (safe additive freeze — no existing golden is re-blessed).
fn author_undo_redo_live() -> Scene {
    let mut s = Scene::new(UNDO_REDO_SEED);
    let src = s.place(SOURCE, 0, 0);
    let sink = s.place(SINK, 5, 0);
    // src Out (world (0,0) faces E) -> belt -> sink In (world (5,0) faces W): a 4-tile
    // belt (1,0)..(4,0), Tail->src, Head->sink (mirrors author_belt_transport).
    let belt = s.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
    s.dock(belt, BeltEnd::Tail, src, 0);
    s.dock(belt, BeltEnd::Head, sink, 0);
    let src_id = s.node_id(src).expect("source resolves to a NodeId");
    s.pump(&[inject(src_id, b"u19")]);
    s.advance(SETTLE);
    // The live undo/redo arc: undo the last edit (the Head dock) then redo it. The final
    // topology is the fully-docked chain again (up to id-relabeling), replayed from the
    // persisted two-log via replay_two_logs.
    s.undo();
    s.redo();
    s
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The scenes below close plan 63-09's set. They were the last scenes milestone v8.0 could
// ever have, because `crates/fabrico-scenario` was entry 3 of the core-freeze gate's
// FROZEN_PATHS and the freeze covered `tests/` as surely as `fixtures/`. Milestone v9.0
// replaced that byte-freeze with a declared-moves gate, so a later phase CAN add a scene now -
// it must declare the fixture and snapshot bytes it moves in the declared-moves list.
//
// EVERY ONE OF THEM ENDS WITH A LOGGED EDIT-UNDO ARC, AND THAT IS LOAD-BEARING, NOT
// STYLE. A fixture is `(seed, edit_log, event_log)` and `replay_two_logs` folds ticks
// `0 ..= max(tick)` over those two logs, so a scene whose last logged record precedes
// its settle replays MID-TRANSPORT and its settle contributes ZERO bytes. The arc is
// what makes the settled board the board the fixture describes.
// `scenes_replay_to_the_board_they_settled_in` is the executable form of that.
// ─────────────────────────────────────────────────────────────────────────────────────

/// The genesis seed of the connect/disconnect round-trip scenario (Phase 67 SC2).
const CONNECT_DISCONNECT_SEED: u64 = 0x0004_C0DE;
/// The genesis seed of the router-configuration scenario (Phase 65 SC3).
const ROUTER_CONFIG_SEED: u64 = 0x0005_B0A7;
/// The genesis seed of the two-speed belt scenario (Phase 68 SC3, the SPEED half).
const BELT_SPEED_SEED: u64 = 0x0006_5AFE;
/// The genesis seed of the wire request/reply scenario (Phase 66 SC3).
const WIRE_REPLY_SEED: u64 = 0x0007_FACE;
/// The genesis seed of the fast-meets-slow junction scenario (Phase 68 SC3, the MEET
/// half).
const BELT_MEET_SEED: u64 = 0x0008_DEED;

/// AUTHOR the connect / disconnect round-trip scenario - **Phase 67 SC2**, which
/// requires connect and disconnect to be certified edit-log commands, proved by a
/// scenario fixture.
///
/// BUILD (topology, edit-log): a `SOURCE` + `SINK` chained by a drawn belt docked at
/// BOTH ends; the Head dock is then REMOVED with `GridCommand::Unlink` and RE-MADE with
/// `GridCommand::Dock`, so the round trip is in the fixture rather than only the
/// disconnect. Then an `ENDPOINT` and a `FACTORY`, an electrical `Role::In` added to the
/// factory with `GridCommand::AddPort`, and a WIRE drawn between them with
/// `GridCommand::DrawWire`.
///
/// RUN (event-log): one `ManualInject` into the source, then `advance(SETTLE)` so the
/// belt transports its item into the sink.
///
/// EDIT then UNDO: `undo` the last connection - the wire - and `redo` it. Undoing a
/// `DrawWire` is `EditOp::Delete { node: wire }` (63-CONTEXT), so this arc also drives
/// the wire half of the delete cascade plan 63-06 landed, and the redo re-mints the wire
/// under a FRESH `NodeId`. The replayed board is byte-identical to the live one
/// regardless, which is the property `scenes_replay_to_the_board_they_settled_in` pins.
///
/// # Why the wire's far end is an `AddPort`-ed port and not a catalog one
/// `mediums_compatible` is strict equality, so `DrawWire` accepts an electrical `Role::In`
/// and nothing else, and NO factory catalog port is electrical. Plan 63-07 decided the far
/// end of a hand-drawn wire is an `AddPort`-ed electrical `Role::In` rather than a second
/// catalog arm, and plan 63-08 added `Scene::add_port` carrying the medium byte verbatim
/// for exactly this. The added port lands at catalog index 3, after the factory's three
/// mechanical ports.
///
/// This wire is TOPOLOGY only - nothing is pumped through it here. The scene that drives
/// a request down a wire is [`author_wire_request_reply`], and it has to strip the
/// factory's catalog ports first, for the reason recorded there.
fn author_connect_disconnect() -> Scene {
    let mut s = Scene::new(CONNECT_DISCONNECT_SEED);

    // ── BUILD: the belt chain, docked at both ends ───────────────────────────────
    let src = s.place(SOURCE, 0, 0);
    let sink = s.place(SINK, 5, 0);
    // src Out (world (0,0) faces E) -> belt -> sink In (world (5,0) faces W): the same
    // 4-tile (1,0)..(4,0) geometry `author_belt_transport` uses.
    let belt = s.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
    s.dock(belt, BeltEnd::Tail, src, 0);
    s.dock(belt, BeltEnd::Head, sink, 0);

    // ── DISCONNECT then RECONNECT: the round trip Phase 67 SC2 asks for ──────────
    // `Unlink` names the SAME link from the SAME side the `Dock` did, so the two pair.
    // `port` is the SINK's spatial catalog index (its one `Role::In`), which the command
    // layer translates into the link keyspace - never pre-translated at the call site.
    s.unlink(belt, BeltEnd::Head, sink, 0);
    s.dock(belt, BeltEnd::Head, sink, 0);

    // ── BUILD: the wire half of "connect" (a wire is a connection too) ───────────
    let ep = s.place(ENDPOINT, 0, 5);
    let fac = s.place(FACTORY, 4, 5);
    s.add_port(fac, port_role::IN, SIDE_W, port_medium::ELECTRICAL);
    // ENDPOINT catalog: index 0 is its electrical In, index 1 its electrical Out. The
    // wire runs OUT of the endpoint and IN to the factory's added port (index 3).
    s.draw_wire(ep, 1, fac, 3);

    // ── RUN ──────────────────────────────────────────────────────────────────────
    let src_id = s.node_id(src).expect("source resolves to a NodeId");
    s.pump(&[inject(src_id, b"c04")]);
    s.advance(SETTLE);
    assert_eq!(
        belt_items(&s, belt),
        0,
        "04-connect-disconnect: the belt is empty at the settle (the sink consumed the \
         item) - a non-zero count means the board was captured mid-transport"
    );

    // ── EDIT then UNDO ───────────────────────────────────────────────────────────
    s.undo();
    s.redo();
    s
}

/// AUTHOR the router-configuration scenario - **Phase 65 SC3**, which requires a routing
/// table edit to save, load, undo, redo and replay byte-identically, proved by a scenario
/// fixture.
///
/// BUILD (topology, edit-log): a `SOURCE` feeding a multi-cell `ROUTER` through a drawn
/// belt, plus one drawn OFFLOAD belt docked to EVERY addressed output. The outputs are
/// counted from [`ROUTER_OUT_ARITY`] rather than written down, so this scene follows the
/// catalog if a later phase grows it.
///
/// CONFIGURE: one `GridCommand::Configure` carrying a `MachineConfig::Router` whose table
/// has two rules matching different bytes at offset 0, plus a `Some` default. This is the
/// FIRST scenario fixture in the corpus to carry an `EditOp::Configure` of any kind - the
/// harness could not express one at all before plan 63-08.
///
/// RUN (event-log): three items pumped at the SAME tick, one matching rule one, one
/// matching rule two, one matching NEITHER, so all three branches of the router are
/// exercised and each item comes to rest on a DIFFERENT addressed output belt. The
/// outcome is therefore visible in `GridState`, not only inside the router's own table.
///
/// EDIT then UNDO: `undo` the Configure (the table reverts to the `add_router(vec![],
/// Some(0))` the fold minted) and `redo` it. That is the round trip SC3 names.
///
/// # The two keyspaces this scene straddles, and why nothing is pre-translated
/// A `GridCommand::Dock` names a port by its SPATIAL CATALOG INDEX; a `MachineConfig::
/// Router` rule names an output by its ROUTING KEY (its 0-based position among the node's
/// `Role::Out` ports). On a Router the two COLLIDE numerically - catalog index 0 is the
/// In, and routing key 0 is the first Out - so the dock loop below passes catalog indices
/// `1 ..= ROUTER_OUT_ARITY` and the rules name routing keys `0 ..< ROUTER_OUT_ARITY`. The
/// command layer owns the one translation (`dock_link_key`); pre-translating here would
/// be a wrong-port bug that still typechecks.
fn author_router_config() -> Scene {
    let mut s = Scene::new(ROUTER_CONFIG_SEED);

    // ── BUILD ────────────────────────────────────────────────────────────────────
    let src = s.place(SOURCE, 0, 0);
    // The 2x3 ROUTER @ (5,0): In at catalog index 0 (local (0,1), W, world (5,1)), on the
    // middle row since plan 74.1-14 (under the "Edits keep middle
    // layout" rule); it was local (0,0) and the feed ended on (4,0). The feed now steps down a
    // row at x=3 and arrives straight into the In's doorstep (4,1).
    let r = s.place(ROUTER, 5, 0);
    let feed = s.draw_belt(&[(1, 0), (2, 0), (3, 0), (3, 1), (4, 1)]);
    s.dock(feed, BeltEnd::Tail, src, 0);
    s.dock(feed, BeltEnd::Head, r, 0);

    // One OFFLOAD belt per addressed Out. Since 74.1-14 the catalog seats indices 1, 2, 3
    // on local rows 1, 2, 0 (the port-edit reseat rule's centre-out slots; until then
    // rows 2, 0, 1). The row is read back off the node rather than restated, so this loop
    // follows the catalog rather than a transcription of it, and it needed no change.
    let mut offloads: Vec<Handle> = Vec::with_capacity(ROUTER_OUT_ARITY as usize);
    for catalog_index in 1..=ROUTER_OUT_ARITY {
        let r_id = s.node_id(r).expect("router resolves to a NodeId");
        let nub = s
            .core()
            .state
            .ports_of(r_id)
            .and_then(|ports| ports.get(catalog_index as usize))
            .map(|p| p.local_offset)
            .expect("the router declares this catalog port");
        // The Out nub sits on the router's E column at local row `nub.1`; the belt tail
        // is the cell one step E of it, i.e. world (5 + w, nub.1) with w == 2.
        let y = nub.1;
        let belt = s.draw_belt(&[(7, y), (8, y)]);
        s.dock(belt, BeltEnd::Tail, r, catalog_index);
        offloads.push(belt);
    }

    // ── CONFIGURE: the routing table (ROUTE-03) ──────────────────────────────────
    // Routing keys, NOT catalog indices: rule one -> the SECOND Out, rule two -> the
    // THIRD, and everything else -> the default, which is the FIRST. The table moves
    // through the command layer VERBATIM (no sort, no dedup) because the router applies
    // the FIRST matching rule.
    s.configure(
        r,
        MachineConfig::Router {
            routes: vec![
                (
                    RouteKey {
                        offset: 0,
                        expect: b"A".to_vec(),
                    },
                    1,
                ),
                (
                    RouteKey {
                        offset: 0,
                        expect: b"B".to_vec(),
                    },
                    2,
                ),
            ],
            default: Some(0),
        },
    );

    // ── RUN: one item per BRANCH, all at the same tick ───────────────────────────
    let src_id = s.node_id(src).expect("source resolves to a NodeId");
    s.pump(&[
        inject(src_id, b"A-one"),
        inject(src_id, b"B-two"),
        inject(src_id, b"Z-none"),
    ]);
    s.advance(SETTLE);
    // Each addressed output holds EXACTLY ONE item: the three branches are distinct and
    // the board is settled. An offload belt's head is undocked, so a delivered item comes
    // to rest ON the belt (the `01-exit-gate` dangling-head shape) rather than vanishing
    // into a sink, which is what makes the routing outcome readable from GridState.
    assert_eq!(
        belt_items(&s, feed),
        0,
        "05-router-config: the feed belt is empty at the settle"
    );
    for (i, belt) in offloads.iter().enumerate() {
        assert_eq!(
            belt_items(&s, *belt),
            1,
            "05-router-config: addressed output {i} carries exactly one routed item"
        );
    }

    // ── EDIT then UNDO: the Configure round trip Phase 65 SC3 names ──────────────
    s.undo();
    s.redo();
    s
}

/// Belt length, in tiles, shared by both speed scenes.
const SPEED_BELT_TILES: u32 = 4;
/// The FAST run's interval in [`author_belt_speed`]. Interior by construction: it is
/// neither the smallest representable interval (`NonZeroU32` bottoms out at 1) nor
/// anywhere near a ceiling. **No belt-speed BOUND is encoded anywhere in this file** -
/// BELT-04's range is a `fabrico-command` validation by decision (63-CONTEXT), precisely
/// so Phase 68 can move it without touching this frozen crate, and a fixture that pinned
/// a limit would take that freedom back.
const FAST_TICKS_PER_SLOT: u32 = 3;
/// The SLOW run's interval in [`author_belt_speed`] - three times [`FAST_TICKS_PER_SLOT`],
/// which is what makes the difference legible mid-flight rather than asymptotically.
const SLOW_TICKS_PER_SLOT: u32 = 9;

/// AUTHOR the two-speed belt scenario - **Phase 68 SC3, the SPEED half**: two runs
/// holding different speeds on one board.
///
/// BUILD (topology, edit-log): two `SOURCE`s, two drawn belts of equal length feeding the
/// two `Role::In` ports of ONE `MERGE`, and a drawn OFFLOAD belt on the merge's Out so the
/// delivered items come to rest somewhere readable.
///
/// CONFIGURE: two `GridCommand::Configure`s carrying `MachineConfig::Belt` at
/// [`FAST_TICKS_PER_SLOT`] and [`SLOW_TICKS_PER_SLOT`] - the first per-belt speed edits
/// the corpus has ever carried.
///
/// RUN (event-log): two items per source, pumped at the SAME tick, then a settle in TWO
/// steps. At the FAST run's traverse time the fast belt is EMPTY and the slow one is
/// still carrying both of its items - that backlog is the observable difference, and it
/// is asserted rather than described. The scene then advances to `settle_for(SLOW_TICKS_
/// PER_SLOT)` in total, where both runs are drained and all four items rest on the shared
/// offload belt.
///
/// EDIT then UNDO: `undo` the last speed edit and `redo` it.
///
/// # This scene contains NO MEET, deliberately
/// Two PARALLEL runs into a common consumer never put a fast item behind a slow one, so
/// nothing here depends on what happens where a fast run feeds a slow one - which is one
/// of this milestone's two human gates, a decision recorded in writing before Phase 68
/// implemented it. A fixture that settled only under one resolution of that gate would
/// decide it by accident, inside a corpus no later phase can re-bless. The meet is
/// [`author_belt_speed_meet`], and it asserts nothing about whether the behaviour it pins
/// is right.
///
/// # The budget is computed from the SLOWER belt, not borrowed
/// A scene whose whole point is that one run is slower is a scene that settles later than
/// every scene above it. [`settle_for`] is [`SETTLE`]'s own derivation given a name so
/// this call can pass `SLOW_TICKS_PER_SLOT`; reusing `SETTLE` would under-run the budget
/// by exactly the ratio of the two intervals, and this is the one budget whose under-run
/// is committed.
fn author_belt_speed() -> Scene {
    let mut s = Scene::new(BELT_SPEED_SEED);

    // ── BUILD ────────────────────────────────────────────────────────────────────
    let src_fast = s.place(SOURCE, 0, 0);
    let src_slow = s.place(SOURCE, 0, 1);
    // The 2x2 MERGE @ (5,0): In ports at catalog 0 (local (0,0), W, world (5,0)) and
    // catalog 1 (local (0,1), W, world (5,1)); its one Out at catalog 2 (local (1,0), E,
    // world (6,0)). A merge funnels every input to ONE output, which is what makes the
    // two runs share a consumer without meeting.
    let merge = s.place(MERGE, 5, 0);
    let fast = s.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
    s.dock(fast, BeltEnd::Tail, src_fast, 0);
    s.dock(fast, BeltEnd::Head, merge, 0);
    let slow = s.draw_belt(&[(1, 1), (2, 1), (3, 1), (4, 1)]);
    s.dock(slow, BeltEnd::Tail, src_slow, 0);
    s.dock(slow, BeltEnd::Head, merge, 1);
    // The shared offload, at the construction default interval: the two configured runs
    // are the subject, and a third configured belt would only add a variable.
    let offload = s.draw_belt(&[(7, 0), (8, 0)]);
    s.dock(offload, BeltEnd::Tail, merge, 2);

    // ── CONFIGURE: two DIFFERENT intervals (BELT-02) ─────────────────────────────
    s.configure(
        fast,
        MachineConfig::Belt {
            ticks_per_slot: FAST_TICKS_PER_SLOT,
        },
    );
    s.configure(
        slow,
        MachineConfig::Belt {
            ticks_per_slot: SLOW_TICKS_PER_SLOT,
        },
    );

    // ── RUN ──────────────────────────────────────────────────────────────────────
    let fast_id = s.node_id(src_fast).expect("fast source resolves to a NodeId");
    let slow_id = s.node_id(src_slow).expect("slow source resolves to a NodeId");
    s.pump(&[
        inject(fast_id, b"f1"),
        inject(fast_id, b"f2"),
        inject(slow_id, b"s1"),
        inject(slow_id, b"s2"),
    ]);

    // Step 1: the FAST run's traverse time plus its admission-alignment offset (at most
    // `ticks_per_slot - 1`, rounded up to a whole interval). The fast run has cleared;
    // the slow one has not.
    let fast_done = belt_traverse(SPEED_BELT_TILES, FAST_TICKS_PER_SLOT)
        + u64::from(FAST_TICKS_PER_SLOT) * 2;
    s.advance(fast_done);
    assert_eq!(
        belt_items(&s, fast),
        0,
        "06-belt-speed: the FAST run has cleared at tick {fast_done} of the settle"
    );
    assert!(
        belt_items(&s, slow) > 0,
        "06-belt-speed: the SLOW run is still carrying at tick {fast_done} - the backlog \
         IS the observable speed difference, and its absence means the two intervals are \
         not far enough apart to be legible inside the budget"
    );

    // Step 2: the remainder of the budget the SLOWER belt sets. Both runs drain.
    s.advance(settle_for(SLOW_TICKS_PER_SLOT) - fast_done);
    assert_eq!(
        (belt_items(&s, fast), belt_items(&s, slow)),
        (0, 0),
        "06-belt-speed: both runs are drained at the slow-derived settle"
    );
    assert_eq!(
        belt_items(&s, offload),
        4,
        "06-belt-speed: all four items reached the shared offload - the board is settled, \
         not merely quiet"
    );

    // ── EDIT then UNDO ───────────────────────────────────────────────────────────
    s.undo();
    s.redo();
    s
}

/// The FAST side of the junction in [`author_belt_speed_meet`].
const MEET_FAST_TICKS_PER_SLOT: u32 = 2;
/// The SLOW side of the junction in [`author_belt_speed_meet`] - six times the fast side,
/// so the junction is genuinely a bottleneck rather than a rounding difference.
const MEET_SLOW_TICKS_PER_SLOT: u32 = 12;

/// AUTHOR the fast-meets-slow junction scenario - **Phase 68 SC3, the MEET half**: the
/// behaviour where a fast run feeds a slow one.
///
/// BUILD (topology, edit-log): a `SOURCE`, a FAST drawn belt into the `Role::In` of a
/// `MERGE`, and a SLOW drawn belt off that merge's Out.
///
/// WHY A MACHINE JUNCTION AND NOT A BELT-TO-BELT ONE, now that both exist. When this
/// scene was blessed a belt declared no port records at all, so a junction NODE was the
/// only shape available for two runs to meet. Phase 74 (LINK-01) made a belt a ported
/// node and opened the belt-to-belt join on the certified command path, so that is no
/// longer true - but this scene is FROZEN corpus and keeps the topology it was blessed
/// with, and the merge is still the smallest junction that passes items straight
/// through. The belt-to-belt shape has its own coverage elsewhere:
/// `crates/fabrico-command/tests/dock_occupancy.rs` and
/// `crates/fabrico-host/tests/belt_backpressure_meet.rs`.
///
/// CONFIGURE: [`MEET_FAST_TICKS_PER_SLOT`] on the upstream run and
/// [`MEET_SLOW_TICKS_PER_SLOT`] on the downstream one.
///
/// RUN (event-log): four items pumped at one tick, then a settle sized from the SLOW
/// side.
///
/// EDIT then UNDO: `undo` the downstream speed edit and `redo` it.
///
/// # THIS SCENE PINS WHAT THE ENGINE DOES. IT DOES NOT ENDORSE IT.
/// It asserts the state hash (through `golden_hashes.rs`) and REPLAY IDENTITY (through
/// `scenes_replay_to_the_board_they_settled_in` and `fixtures_are_deterministic`) and
/// NOTHING ELSE. There is deliberately no assertion here that the junction behaviour is
/// correct or desirable - no item-count expectation, no backlog claim, no fault claim -
/// because what SHOULD happen where a fast run feeds a slow one is one of this
/// milestone's two human gates, a decision recorded in writing before Phase 68 implemented
/// it. Asserting desirability here would answer that question inside a corpus its
/// deciders never saw.
///
/// **The consequence, in one sentence, because someone editing this scene needs it here
/// and not in a planning file:** these bytes describe the CURRENT junction behaviour, and
/// Phase 68 cannot change that behaviour in `fabrico-core` without invalidating a fixture
/// it has no way to re-bless - so the meet gate has to be resolved above the core, or it
/// does not ship. That constraint was handed forward from the Phase 63 keystone schema
/// change.
fn author_belt_speed_meet() -> Scene {
    let mut s = Scene::new(BELT_MEET_SEED);

    // ── BUILD ────────────────────────────────────────────────────────────────────
    let src = s.place(SOURCE, 0, 0);
    // The junction. MERGE catalog: In at 0 (world (5,0), W) and 1 (world (5,1), W), Out
    // at 2 (world (6,0), E).
    let junction = s.place(MERGE, 5, 0);
    let fast = s.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
    s.dock(fast, BeltEnd::Tail, src, 0);
    s.dock(fast, BeltEnd::Head, junction, 0);
    // The downstream run's head is UNDOCKED, so whatever crosses the junction comes to
    // rest ON the slow belt and is visible in the replayed state.
    let slow = s.draw_belt(&[(7, 0), (8, 0), (9, 0), (10, 0)]);
    s.dock(slow, BeltEnd::Tail, junction, 2);

    // ── CONFIGURE: fast in, slow out ─────────────────────────────────────────────
    s.configure(
        fast,
        MachineConfig::Belt {
            ticks_per_slot: MEET_FAST_TICKS_PER_SLOT,
        },
    );
    s.configure(
        slow,
        MachineConfig::Belt {
            ticks_per_slot: MEET_SLOW_TICKS_PER_SLOT,
        },
    );

    // ── RUN ──────────────────────────────────────────────────────────────────────
    let src_id = s.node_id(src).expect("source resolves to a NodeId");
    s.pump(&[
        inject(src_id, b"m1"),
        inject(src_id, b"m2"),
        inject(src_id, b"m3"),
        inject(src_id, b"m4"),
    ]);
    // The budget is the SLOW side's, computed and not borrowed - same reason as
    // [`author_belt_speed`], and here it is the downstream run that sets it.
    s.advance(settle_for(MEET_SLOW_TICKS_PER_SLOT));

    // ── EDIT then UNDO ───────────────────────────────────────────────────────────
    s.undo();
    s.redo();
    s
}

/// The handler the wire scene installs on its factory through a certified
/// `GridCommand::Configure` - never a hand-seeded node.
///
/// `ctx.command(effect, deadline)` is mapped by the 37-03 reply seam into an
/// `Effect::Reply { correlation, payload }` when (and ONLY when) the item being serviced
/// is a canonical `WireEnvelope` the wire fold delivered; an ordinary belt item leaves it
/// as the muted `Effect::Noop`. So this one line is the whole difference between a
/// handler that replies and one that does not.
const WIRE_REPLY_HANDLER_JS: &str =
    "export default function (input, ctx) { ctx.command({ status: 200, body: \"pong\" }, 0); }";

/// The correlation id the wire scene's one request carries.
const WIRE_REPLY_CORRELATION: u64 = 0x00C0_FFEE;

/// AUTHOR the wire request/reply scenario - **Phase 66 SC3**, which requires a scenario
/// test to drive a request through a hand-drawn wire and assert the reply returns to its
/// caller.
///
/// BUILD (topology, edit-log): an `ENDPOINT` and a `FACTORY`; the factory's three
/// MECHANICAL catalog ports are stripped with `GridCommand::RemovePort` and replaced by an
/// electrical `Role::In` and an electrical `Role::Out` via `GridCommand::AddPort`; the
/// handler is installed with `GridCommand::Configure`; and BOTH wires are minted with
/// `GridCommand::DrawWire` - the forward wire `endpoint -> factory` and the RETURN wire
/// `factory -> endpoint`. Nothing reaches around the command layer into a core seam.
///
/// RUN (event-log): one `WireRequest` pumped at the endpoint, then `advance(SETTLE)`.
///
/// EDIT then UNDO: `undo` the return wire and `redo` it.
///
/// # Why the factory's catalog ports are STRIPPED, which no other scene does
/// Two rules meet here and only one arrangement satisfies both. `DrawWire` requires an
/// electrical `Role::In` on the target (`mediums_compatible` is strict equality), and
/// `factory.rs` drains input port **0** and no other. A factory whose electrical In is
/// appended after its three mechanical catalog ports takes delivery on port 3, where the
/// sandbox never looks, and the request is silently stranded on a board that otherwise
/// looks correct. Stripping first puts the electrical In at index 0. This is the same
/// strip-then-reseed shape `place_router_preset` uses for an electrical Router, and it is
/// why `Scene::remove_port` - added in plan 63-08 for the closure rather than for a
/// requirement - has a committed user.
///
/// # The RETURN wire is not optional
/// `tick::route_replies` reverse-transports an `Effect::Reply` into the live `Node::Wire`
/// whose `from.node == handler`, and DROPS the reply when there is none. Without the
/// return wire the effect would still be emitted and drained, and the caller would never
/// hear it - a fixture that looked like a round trip and was not.
///
/// # What this scene ASSERTS, and where the payload assertion actually lives
/// Two things, and they cover different halves.
/// - **The drained effect.** `Scene::drain_effects` returns an `Effect::Reply` carrying
///   [`WIRE_REPLY_CORRELATION`]. This is the FIRST and only committed scene to call that
///   accessor, and calling it is the point: an accessor no fixture exercises is a frozen
///   method whose defect would surface in Phase 66, where this crate cannot be edited.
/// - **The state-observable stand-in: the endpoint's port-0 inbox is OCCUPIED.** That is
///   the reply, transported back down the return wire and delivered to the `return_addr`
///   the request named. `Node::Endpoint` is an inert marker that never drains its inbox,
///   so the delivery persists to the settle and rides the state hash.
///
/// The stand-in is what the FIXTURE BYTES depend on: drained effects are NOT serialized,
/// so nothing in `to_fixture()` or `hash()` can see them. And neither assertion inspects
/// the reply PAYLOAD - the `{status, headers, body}` descriptor is asserted end to end,
/// over a real loopback socket, in `crates/fabrico-host/tests/headline.rs`. A Phase 66
/// planner reading SC3 should read those two together and not treat this fixture as the
/// payload proof.
fn author_wire_request_reply() -> Scene {
    let mut s = Scene::new(WIRE_REPLY_SEED);

    // ── BUILD ────────────────────────────────────────────────────────────────────
    let ep = s.place(ENDPOINT, 0, 0);
    let fac = s.place(FACTORY, 4, 0);
    // Strip TOP-DOWN so each removal's index is still valid: Fault(2), Out(1), In(0).
    s.remove_port(fac, 2).remove_port(fac, 1).remove_port(fac, 0);
    // Re-seed electrical. In FIRST, so the wire's delivery port is index 0 - the one port
    // the sandbox drains - and the Out second, for the return wire to leave from.
    s.add_port(fac, port_role::IN, SIDE_W, port_medium::ELECTRICAL);
    s.add_port(fac, port_role::OUT, SIDE_E, port_medium::ELECTRICAL);
    s.configure(
        fac,
        MachineConfig::Factory {
            source: WIRE_REPLY_HANDLER_JS.to_owned(),
        },
    );
    // ONE CALL MINTS THE PAIR (72-08, D-04). This drag joins a Route and a Handler - the
    // reseeded factory above satisfies R-37's naming predicate exactly, an electrical In
    // at index 0 and an electrical Out - so the command layer resolves BOTH cable legs
    // from the two nodes' declarations under ONE action id: the FORWARD leg endpoint Out
    // (catalog 1) -> factory In (catalog 0), and the RETURN leg factory Out (catalog 1)
    // -> endpoint In (catalog 0). The two wires are byte-for-byte the two this scene used
    // to draw by hand, in the same order, so the BOARD does not move; only this scene's
    // authored command log does, by one fewer `GridCommand`.
    //
    // A SECOND CALL WOULD NOW BE REFUSED. The return leg has already taken the factory's
    // single electrical Out, so drawing it by hand a second time is `PortOccupied` and
    // the scene builder would panic on it. That is not a regression to work around, it
    // is R-52: the pair is minted whole or refused whole.
    s.draw_wire(ep, 1, fac, 0);

    // ── RUN ──────────────────────────────────────────────────────────────────────
    let ep_id = s.node_id(ep).expect("endpoint resolves to a NodeId");
    // A JSON body: the sandbox parses the request payload before the handler runs.
    s.pump(&[request(
        ep_id,
        WIRE_REPLY_CORRELATION,
        br#"{"op":"ping"}"#,
    )]);
    s.advance(SETTLE);

    // THE DRAINED EFFECT - the accessor exercised by a committed scene, in the last phase
    // that can still change it.
    let replies: Vec<u64> = s
        .drain_effects()
        .iter()
        .filter_map(|cmd| match cmd.effect {
            Effect::Reply { correlation, .. } => Some(correlation),
            _ => None,
        })
        .collect();
    assert_eq!(
        replies,
        vec![WIRE_REPLY_CORRELATION],
        "07-wire-request-reply: the handler emitted exactly one Effect::Reply, carrying \
         the request's own correlation"
    );

    // THE STATE-OBSERVABLE STAND-IN - the reply came back to the caller the request named.
    assert!(
        s.core()
            .state
            .inbox_of(ep_id)
            .is_some_and(|inbox| inbox.has_on(0)),
        "07-wire-request-reply: the reply was delivered to the endpoint's port-0 inbox \
         (the return_addr the request carried). This is the half the FIXTURE BYTES record."
    );

    // ── EDIT then UNDO ───────────────────────────────────────────────────────────
    s.undo();
    s.redo();
    s
}

/// The committed corpus: `(filename, authoring fn)` pairs. Adding a corpus entry is
/// one line here; `bless_fixtures` writes it and both guard tests cover it.
///
/// # Eight entries, three fixture files - a DECLARED short state, not a broken one
/// Plan 63-09 registers the five scenes below and deliberately does NOT bless. Running
/// `bless_fixtures` writes EVERY entry in one act, so blessing here would rewrite the
/// three existing fixtures at edit schema version 6 and plan 63-12 would rewrite all
/// eight again at version 7 - two bless events on a corpus 63-CONTEXT says is re-blessed
/// ONCE. Until 63-12 runs, `committed_fixtures_match_authoring` is red on the five
/// missing files, and that is recorded in the committed `63-RED-SET.txt` baseline.
///
/// # THE COMPILE-TIME GLOB GOTCHA - read this before blessing
/// `golden_hashes.rs` and `determinism.rs` both expand `#[files("fixtures/*.postcard")]`
/// at COMPILE time, so the rstest cases are generated from the fixture set that existed
/// when the crate was last built. When plan 63-12 writes the five new files, the glob does
/// NOT pick them up until the test SOURCE is touched or the crate is rebuilt - and until
/// it does, the two sweeps generate three cases and silently cover five fewer scenarios
/// than the corpus appears to hold, with everything green. Plan 63-12 carries an
/// acceptance criterion that COUNTS the generated golden cases and requires eight, which
/// is the only check that can see this.
fn corpus() -> Vec<(&'static str, Scene)> {
    vec![
        ("01-exit-gate.postcard", author_exit_gate()),
        ("02-belt-transport.postcard", author_belt_transport()),
        ("03-undo-redo-live.postcard", author_undo_redo_live()),
        ("04-connect-disconnect.postcard", author_connect_disconnect()),
        ("05-router-config.postcard", author_router_config()),
        ("06-belt-speed.postcard", author_belt_speed()),
        ("07-wire-request-reply.postcard", author_wire_request_reply()),
        ("08-belt-speed-meet.postcard", author_belt_speed_meet()),
    ]
}

/// Absolute path to a fixture file under `crates/fabrico-scenario/fixtures/`.
fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name)
}

/// THE BLESS PATH (Open Q3): author each corpus scenario via `Scene` and write its
/// `to_fixture().to_bytes()` to disk. `#[ignore]`-by-default so a normal `cargo test`
/// never rewrites the committed fixtures; run explicitly to regenerate after a schema
/// bump:
///
/// ```text
/// cargo test -p fabrico-scenario --test bless_fixtures -- --ignored
/// ```
#[test]
#[ignore = "regen path: rewrites committed fixtures; run explicitly with --ignored"]
fn bless_fixtures() {
    for (name, scene) in corpus() {
        let bytes = scene.to_fixture().to_bytes();
        let path = fixture_path(name);
        fs::write(&path, &bytes)
            .unwrap_or_else(|e| panic!("write fixture {}: {e}", path.display()));
        println!("blessed {} ({} bytes)", path.display(), bytes.len());
    }
}

/// Re-authoring a scenario twice yields BYTE-IDENTICAL fixture bytes — the
/// deterministic-regen guarantee (Open Q3). The factory sub-seed draw (sim RNG) and the
/// plain-ordered-serde `Scenario` postcard encoding are both deterministic, so a bless
/// is reproducible across runs and machines.
#[test]
fn fixtures_are_deterministic() {
    let first = corpus();
    let second = corpus();
    for ((name, a), (_, b)) in first.into_iter().zip(second) {
        assert_eq!(
            a.to_fixture().to_bytes(),
            b.to_fixture().to_bytes(),
            "re-authoring {name} must produce byte-identical fixture bytes (deterministic regen)"
        );
    }
}

/// The corpus floor this guard refuses to run below: the eight scenes `corpus()` registers.
///
/// A guard that walks a registry is only as good as the registry's size. If `corpus()` were
/// truncated to two entries the loop below would still pass, covering six fewer scenes than
/// the corpus appears to hold, with everything green. This constant is what makes that a RED.
/// It is a FLOOR and not an equality: a later phase adding a ninth scene should not have to
/// touch this line, and a ninth scene is covered by the loop the moment it is registered.
const MIN_REGISTERED_SCENES: usize = 8;

/// THE SETTLE DISCIPLINE, MADE EXECUTABLE: every scene the corpus registers must REPLAY to
/// the board its author settled, not to some earlier tick.
///
/// # Why this test exists, stated as the mechanism rather than as a rule
/// A fixture carries exactly `(seed, edit_log, event_log)` and NOTHING else.
/// `GridSession::replay_two_logs` folds ticks `0 ..= max(tick)` over those two logs, so
/// an idle `Scene::advance` is reproduced ONLY when a LOGGED record follows it and is
/// stamped at a post-settle tick. A scene whose last logged record precedes its settle
/// therefore replays to a MID-TRANSPORT board, and the settle contributes zero bytes to
/// the fixture: the scenario is not the one the author thought they blessed.
///
/// That is not hypothetical, and it is why this guard exists. `02-belt-transport` WAS exactly
/// this shape until Phase 70 - it pumped, settled, then logged nothing - so its committed
/// `.snap` froze a replay at tick 6 against a live scene at tick 134. Its `items=0` read like
/// a settled board and was not one: the item was parked in the belt's INBOX, which
/// [`StateSummary`] does not count. So the `items=` tell named in [`SETTLE`]'s docblock is a
/// tell about the LIVE scene and NOT about the replayed fixture, and only this equality
/// covers the second. Re-authoring the scene with a logged post-settle arc (plan 70-04) moved
/// the replay from tick 6 to tick 136, the tick the author settles at, and moved the recorded
/// hash with it.
///
/// THE SNAPSHOT'S `items=` DID NOT MOVE, AND THAT IS THE POINT. It read 0 before because the
/// single item was parked in an uncounted inbox six ticks in, and it reads 0 now because the
/// sink has CONSUMED it by tick 136. Two different boards, one integer. `02-belt-transport`
/// now agrees with `03-undo-redo-live` on the whole summary line (`nodes=3 belts=1 items=0`),
/// which is what an identical topology settled through an identical arc should read. The
/// frozen HASH is the assertion that moved (`e6caa275...` to `264b5179...`); the summary is a
/// readability aid and was never the primary, exactly as the module docblock says.
///
/// The measured before-state is preserved here on purpose: it is the only record of what this
/// guard bites on, and re-deriving it later would cost a revert of a committed fixture.
///
/// # Scope: EVERY registered scene, and no exemption list
///
/// Until Phase 70 this guard ran over a hand-written list of five names, because
/// `02-belt-transport` failed it and `crates/fabrico-scenario` was byte-frozen, so the scene
/// could not be re-authored to pass. A guard scoped to a hand-written subset of the registry
/// it guards certifies nothing about the scenes left off the list: a scene could be exempted
/// by forgetting to add its name, which is indistinguishable from a scene that was checked.
///
/// Milestone v9.0's declared-moves gate made the fix payable. Plan 70-04 re-authored
/// `02-belt-transport` with a logged undo/redo pair after its settle, DELETED the hand list
/// rather than leaving it unused, and pointed this loop at [`corpus()`] itself. The
/// exemption mechanism is gone: a scene is covered the moment it is registered, and the two
/// pre-loop assertions below refuse a registry that is too small or that repeats a name.
#[test]
fn scenes_replay_to_the_board_they_settled_in() {
    let corpus = corpus();

    // NON-VACUITY 1 - the registry is not truncated. Without this, a `corpus()` cut down to
    // one entry would satisfy the loop below completely while covering seven fewer scenes.
    assert!(
        corpus.len() >= MIN_REGISTERED_SCENES,
        "corpus() registers {} scene(s); this guard refuses to run below {MIN_REGISTERED_SCENES}. \
         A truncated registry makes the loop below vacuously satisfied - it would report a \
         clean settle discipline over scenes it never reached. If a scene was deliberately \
         retired, lower MIN_REGISTERED_SCENES in the SAME commit and say why.",
        corpus.len()
    );

    // NON-VACUITY 2 - the names are pairwise distinct. Without this, a registry holding the
    // same scene eight times would satisfy assertion 1 and the loop, and would look like
    // eight scenes covered.
    let mut names: Vec<&str> = corpus.iter().map(|(n, _)| *n).collect();
    names.sort_unstable();
    let distinct = {
        let mut d = names.clone();
        d.dedup();
        d
    };
    assert_eq!(
        distinct.len(),
        names.len(),
        "corpus() registers {} scene(s) under only {} distinct name(s) ({names:?}). A \
         duplicated entry makes this loop appear to cover a scene it never reached, and it \
         also means the bless writes one fixture path twice.",
        names.len(),
        distinct.len()
    );

    for (name, scene) in &corpus {
        let fixture = scene.to_fixture();
        let replayed =
            GridSession::replay_two_logs(fixture.seed, &fixture.edit_log, &fixture.event_log);
        assert_eq!(
            replayed.core().tick,
            scene.core().tick,
            "{name}: the replayed fixture stops at tick {} while the authored scene \
             settled at tick {} - the settle is UNLOGGED trailing time and is invisible \
             to the fixture. Follow the settle with a logged edit (the EDIT-UNDO arc) so \
             run_log_two_logs folds it.",
            replayed.core().tick,
            scene.core().tick
        );
        assert_eq!(
            tick_hash(replayed.core()),
            scene.hash(),
            "{name}: the replayed board is not the authored board (HASH PRIMARY, \
             T-13-HASH)"
        );
    }
}

/// Every corpus scene carries its OWN genesis seed, read back off the fixtures rather
/// than restated from the constants.
///
/// A shared seed makes two fixtures correlated for no reason, and correlated fixtures
/// fail together for reasons that have nothing to do with what either one tests.
#[test]
fn every_scene_carries_its_own_seed() {
    let mut seen: Vec<(u64, &str)> = Vec::new();
    for (name, scene) in corpus() {
        let seed = scene.to_fixture().seed;
        if let Some((_, other)) = seen.iter().find(|(s, _)| *s == seed) {
            panic!("{name} shares genesis seed {seed:#x} with {other}");
        }
        seen.push((seed, name));
    }
}

/// DRIFT GUARD: the committed `.postcard` bytes MUST equal freshly-authored bytes. A
/// schema/authoring change that was not re-blessed fails HERE (in the normal test run),
/// forcing an explicit `--ignored` bless — so the committed corpus can never silently
/// drift from the authoring code.
#[test]
fn committed_fixtures_match_authoring() {
    for (name, scene) in corpus() {
        let path = fixture_path(name);
        let committed = fs::read(&path).unwrap_or_else(|e| {
            panic!(
                "read committed fixture {} ({e}); run `cargo test -p fabrico-scenario \
                 --test bless_fixtures -- --ignored` to (re)generate it",
                path.display()
            )
        });
        assert_eq!(
            committed,
            scene.to_fixture().to_bytes(),
            "committed fixture {name} drifted from the authoring code — re-bless with \
             `cargo test -p fabrico-scenario --test bless_fixtures -- --ignored`"
        );
    }
}
