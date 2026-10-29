//! Golden-corpus GENERATOR (criterion 4 / REPLAY-03) — the ONLY file in the
//! suite that writes to disk.
//!
//! The determinism clippy gate (`clippy.toml` `disallowed-methods`) bans every
//! `std::fs::*` write in ALL targets, tests included. The corpus writer
//! legitimately needs `std::fs` to freeze fixtures, so this file carries a
//! file-scoped escape hatch on its first line. The escape is SCOPED to this one
//! file and to `disallowed_methods` ONLY:
//!   - the cross-platform RUNNER (`cert_cross_platform.rs`) uses
//!     `include_bytes!`/`include_str!` and touches no fs, so it needs no allow;
//!   - the negative-test (`scripts/determinism-gate-negative-test.sh`) plants an
//!     `f64` + `HashMap`, which trip `disallowed_TYPES`, NOT methods — so the gate
//!     still bites everywhere else and this allow cannot mask a determinism-killer.
//!
//! Every generator is `#[ignore]`d: `cargo test` never runs it, so the corpus is
//! NEVER auto-regenerated on a test failure. Freezing or re-blessing a fixture is
//! an explicit, reviewed act via `scripts/regen-golden.sh new|bless <id>` (which
//! runs the matching `gen_<id>` with `--ignored`). The frozen bytes are the
//! corpus the runner asserts forever.
#![allow(clippy::disallowed_methods)] // corpus-generation utility: needs std::fs; #[ignore]d, never in the CI test pass.

mod common;

use common::{
    COUNTER_FACTORY_JS, collector_count, collector_items, command_result, command_timeout,
    fault_port_reasons, fire, fold_two_logs_collecting_hashes, header,
    multi_source_merge_collector, source_balancer_collectors, source_belt_collector,
    source_factory_collector, source_sink_deadletter,
};
use fabrico_command::GridSession;
use fabrico_protocol::GridCommand;
// SLOT-03 (plan 62-09): `gen_0012`'s drive length is a BUDGET and must stretch with the
// belt advance interval. See `BUNCH_TICKS` there for why this import is a budget
// derivation and never an expectation - the distinction `crates/fabrico-scenario`'s
// `SETTLE` already draws in this same phase.
// PILE-01/PILE-04/PILE-09 (plan 71-07, ruling R-32): `gen_0030` IMPORTS the three
// bounds it saturates rather than transcribing them, exactly as the `WIRE_INFLIGHT_CAP`
// import below is the precedent for. A generator carrying its own 16 would keep passing
// after somebody moved the constant, which is the failure that fixture exists to catch.
use fabrico_core::admit::{FAULT_QUEUE_CAP, MECHANICAL_INBOX_CAP, SOURCE_PENDING_CAP};
use fabrico_core::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE};
use fabrico_core::command::Outcome;
use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord, MachineConfig};
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::fault::{Fault, FaultReason, FAULT_PORT};
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::snapshot::{self, SNAPSHOT_SCHEMA_VERSION};
use fabrico_core::wire::{WireEnvelope, WIRE_INFLIGHT_CAP};
use fabrico_core::state::{
    BeltTile, Footprint, Medium, Node, Port, Role, RouteKey, Side, SinkTemplate, TileKind,
};
use std::fs;
use std::num::NonZeroU32;
use std::path::PathBuf;

/// `machine_kind` u8 convention (single source of truth is
/// `fabrico-protocol::machine_kind`; fabrico-core is protocol-free, so it is
/// re-declared here exactly like `tick.rs`'s private copy).
const KIND_SOURCE: u8 = 0;
const KIND_BELT: u8 = 1;
const KIND_FACTORY: u8 = 2;
const KIND_ROUTER: u8 = 5;
const KIND_SINK: u8 = 7;

/// Build one RESOLVED [`EditRecord`] for the edit-log fixtures (Q2 — replay applies
/// these verbatim, no re-validation).
fn edit_record(seq: u64, tick: u64, op: EditOp) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        action: 0,
        op,
    }
}

/// Human/script-readable provenance for one fixture. Written into `meta.toml`;
/// the runner NEVER reads it (the runner drives off the frozen hash COUNT only).
struct Meta {
    scenario_id: &'static str,
    builder: &'static str,
    seed: u64,
    params: &'static str,
    tick_count: u64,
}

/// Freeze one scenario into `tests/golden/<scenario_id>/` as five self-contained
/// files: the genesis `Core` snapshot blob (captured BEFORE any fold), the
/// postcard-encoded ordered event log, the postcard-encoded ordered topology
/// edit-log (empty for 0001-0006, populated for 0007/0008), the per-tick blake3
/// hash manifest, and the human-readable provenance. The hashes are produced by
/// folding a FRESH `restore(&genesis_blob)` core through BOTH logs with the SAME
/// `fold_two_logs_collecting_hashes` helper the runner uses (EDITS-FIRST), so the
/// frozen manifest and the runner's recomputation cannot drift.
fn freeze(meta: &Meta, genesis_blob: &[u8], edits: &[EditRecord], log: &[Event]) {
    // Re-derive the manifest from the frozen genesis exactly as the runner will:
    // restore the genesis Core through the hardened decode, then fold both logs.
    let mut core = snapshot::restore(genesis_blob).expect("genesis blob restores");
    let hashes = fold_two_logs_collecting_hashes(&mut core, edits, log, meta.tick_count);

    let dir = golden_dir(meta.scenario_id);
    fs::create_dir_all(&dir).expect("create fixture dir");

    fs::write(dir.join("genesis.snapshot"), genesis_blob).expect("write genesis.snapshot");
    fs::write(
        dir.join("log.postcard"),
        postcard::to_allocvec(&log.to_vec()).expect("encode log"),
    )
    .expect("write log.postcard");
    fs::write(
        dir.join("edit-log.postcard"),
        postcard::to_allocvec(&edits.to_vec()).expect("encode edit-log"),
    )
    .expect("write edit-log.postcard");

    let mut manifest = String::new();
    for h in &hashes {
        manifest.push_str(h);
        manifest.push('\n');
    }
    fs::write(dir.join("hashes.txt"), manifest).expect("write hashes.txt");

    let meta_toml = format!(
        "# Golden fixture provenance — human/script readable, NOT read by the runner.\n\
         # Re-freeze ONLY via `scripts/regen-golden.sh bless {id}` after a reviewed,\n\
         # deliberate behavior change (the corpus is asserted forever).\n\
         scenario_id = \"{id}\"\n\
         builder = \"{builder}\"\n\
         seed = \"{seed:#018x}\"\n\
         params = \"{params}\"\n\
         tick_count = {ticks}\n\
         hash_lines = {nlines}\n\
         schema_version = {sv}\n\
         snapshot_schema_version = {ssv}\n",
        id = meta.scenario_id,
        builder = meta.builder,
        seed = meta.seed,
        params = meta.params,
        ticks = meta.tick_count,
        nlines = hashes.len(),
        sv = SCHEMA_VERSION,
        ssv = SNAPSHOT_SCHEMA_VERSION,
    );
    fs::write(dir.join("meta.toml"), meta_toml).expect("write meta.toml");
}

/// Resolve `tests/golden/<id>/` from the crate manifest dir, so the writer hits
/// the right place regardless of cwd.
fn golden_dir(scenario_id: &str) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests");
    p.push("golden");
    p.push(scenario_id);
    p
}

// ---------------------------------------------------------------------------
// Scenario generators — one `#[ignore]`d test each. Each builds a topology at
// tick 0, captures the genesis blob, scripts a STATIC log (no rng draws: built-in
// machines never draw the sim rng, so a static log fully determines state), and
// freezes the fixture.
// ---------------------------------------------------------------------------

/// 0001 — `source -> belt(3) -> collector`: an item in-flight on the belt across
/// several ticks (covers belt `in_flight` queue state).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0001-source-belt-collector"]
fn gen_0001_source_belt_collector() {
    const SEED: u64 = 0x0000_B117;
    let (core, s, _c) = source_belt_collector(SEED, 3);
    let genesis = snapshot::snapshot(&core);
    // Inject three items spaced across ticks so the belt holds overlapping
    // in-flight items, then drain.
    let log = vec![
        fire(s, 1, 0, Item(vec![0x01])),
        fire(s, 2, 2, Item(vec![0x02])),
        fire(s, 3, 4, Item(vec![0x03])),
    ];
    freeze(
        &Meta {
            scenario_id: "0001-source-belt-collector",
            builder: "source_belt_collector",
            seed: SEED,
            params: "latency=3",
            tick_count: 10,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0002 — `[3 sources] -> merge(3) -> collector` with TWO items on one input at
/// tick 0, forcing the merge to leave a backlog and re-wake at tick+1 (covers the
/// merge inbox backlog + scheduler wheel + rotation pointer).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0002-merge-backlog"]
fn gen_0002_merge_backlog() {
    const SEED: u64 = 0x4A1C_3E70;
    let (core, sources, _c) = multi_source_merge_collector(SEED, 3);
    let genesis = snapshot::snapshot(&core);
    // Two items onto the SAME input port => one drains this pass, one re-wakes.
    let log = vec![
        fire(sources[0], 1, 0, Item(vec![0xA0])),
        fire(sources[0], 2, 0, Item(vec![0xA1])),
    ];
    freeze(
        &Meta {
            scenario_id: "0002-merge-backlog",
            builder: "multi_source_merge_collector",
            seed: SEED,
            params: "inputs=3",
            tick_count: 6,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0003 — `source -> balancer(3) -> [3 collectors]` with one item per tick so the
/// round-robin pointer advances every tick (covers balancer `next` selection
/// state mid-rotation).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0003-balancer-rotation"]
fn gen_0003_balancer_rotation() {
    const SEED: u64 = 0x00B4_1A0C;
    let (core, s, _collectors) = source_balancer_collectors(SEED, 3);
    let genesis = snapshot::snapshot(&core);
    // One item per tick for five ticks => the rotation pointer lands at each phase.
    let log = vec![
        fire(s, 1, 0, Item(vec![0x10])),
        fire(s, 2, 1, Item(vec![0x11])),
        fire(s, 3, 2, Item(vec![0x12])),
        fire(s, 4, 3, Item(vec![0x13])),
        fire(s, 5, 4, Item(vec![0x14])),
    ];
    freeze(
        &Meta {
            scenario_id: "0003-balancer-rotation",
            builder: "source_balancer_collectors",
            seed: SEED,
            params: "outputs=3",
            tick_count: 8,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0004 — `source -> router(0x01->port0, 0x02->port1, no default)` with per-port +
/// FAULT_PORT collectors, driven by a scripted mix hitting port0 / port1 / fault
/// (covers the router route table + fault counter + fault bytes).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0004-router-fault-mix"]
fn gen_0004_router_fault_mix() {
    const SEED: u64 = 0x0072_07E5;
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    // routes: 0x01.. -> port 0 ; 0x02.. -> port 1 ; no default => fault.
    let router = core.state.add_router(
        vec![
            (RouteKey::new(0, vec![0x01]), 0),
            (RouteKey::new(0, vec![0x02]), 1),
        ],
        None,
    );
    core.state.link((s, 0), (router, 0));
    let c0 = core.state.add_source();
    let c1 = core.state.add_source();
    let cf = core.state.add_source();
    core.state.link((router, 0), (c0, 0));
    core.state.link((router, 1), (c1, 0));
    core.state.link((router, FAULT_PORT), (cf, 0));

    let genesis = snapshot::snapshot(&core);
    // A scripted mix: match port 0, match port 1, no-match (fault), match port 0
    // again, no-match (fault) — one fire per tick.
    let log = vec![
        fire(s, 1, 0, Item(vec![0x01, 0x0A])), // -> port 0
        fire(s, 2, 1, Item(vec![0x02, 0x0B])), // -> port 1
        fire(s, 3, 2, Item(vec![0x99, 0x0C])), // -> fault
        fire(s, 4, 3, Item(vec![0x01, 0x0D])), // -> port 0
        fire(s, 5, 4, Item(vec![0x03, 0x0E])), // -> fault
    ];
    freeze(
        &Meta {
            scenario_id: "0004-router-fault-mix",
            builder: "inline router (2 routes, no default) + FAULT_PORT sink",
            seed: SEED,
            params: "routes=[0x01->0,0x02->1], default=none",
            tick_count: 7,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0005 — `source -> factory(COUNTER_FACTORY_JS) -> collector` with the factory's
/// reserved `FAULT_PORT` wired to a dead-letter sink (criterion 5 / REPLAY-03).
///
/// This is the FIRST fixture whose state crosses the **JS boundary**: the factory
/// holds a counter in `ctx.state` (the SOLE snapshotted cross-tick factory state)
/// and a per-node `SimRng`. The genesis blob is a COLD cache (only plain
/// `Node::Factory` data — empty `ctx.state` + the sub-seeded rng — no live engine),
/// and the `freeze` helper rebuilds the engine lazily while folding, exactly like
/// the cross-platform runner will. The static log drives three increments (the
/// counter survives + is emitted each tick), then on tick 3 injects the canonical
/// `"loop"` sentinel so `COUNTER_FACTORY_JS`'s unbounded-loop branch trips the
/// deterministic gas fuse → a `FactoryTimeout` fault stamped on `FAULT_PORT` and
/// rested in the dead-letter sink (FACT-03, the fuse reproducible in the frozen
/// corpus), then a final increment proving the engine is reusable after the abort.
/// The byte-identical frozen hashes hold IFF the curated Math, the execution-driven
/// fuse, the f64-free seeded random, and the canonical JSON encoding are all
/// platform-independent — so this fixture is the empirical cross-OS guard against a
/// nondeterminism leak through the JS boundary.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0005-factory-stateful"]
fn gen_0005_factory_stateful() {
    const SEED: u64 = 0x0F00_5005;
    let (mut core, s, f, _c) = source_factory_collector(SEED, COUNTER_FACTORY_JS);
    // Wire the reserved fault port to a dead-letter sink (a Source that ignores its
    // input port, so the fuse-trip's FactoryTimeout rests in its inbox and becomes
    // part of the frozen tick state — the fuse is reproved by the corpus).
    let sink = core.state.add_source();
    core.state.link((f, FAULT_PORT), (sink, 0));

    // Genesis captured BEFORE any fold: a COLD factory cache (plain data only).
    let genesis = snapshot::snapshot(&core);

    // Static log: three increments, one fuse-trip sentinel, one more increment.
    // `"1"` is JSON `1` (counter advances regardless of input value); `"\"loop\""`
    // is the JSON string `"loop"` that triggers the unbounded-loop fuse trip.
    let log = vec![
        fire(s, 1, 0, Item(b"1".to_vec())), // count -> 1, emit 1
        fire(s, 2, 1, Item(b"1".to_vec())), // count -> 2, emit 2
        fire(s, 3, 2, Item(b"1".to_vec())), // count -> 3, emit 3
        fire(s, 4, 3, Item(b"\"loop\"".to_vec())), // fuse trip -> FactoryTimeout, state unchanged
        fire(s, 5, 4, Item(b"1".to_vec())), // count -> 4, emit 4 (engine reusable after abort)
    ];
    freeze(
        &Meta {
            scenario_id: "0005-factory-stateful",
            builder: "source_factory_collector(COUNTER_FACTORY_JS) + FAULT_PORT dead-letter sink",
            seed: SEED,
            params: "gas_budget=DEFAULT; ctx.state counter; \"loop\" sentinel trips the fuse at tick 3",
            tick_count: 7,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0006 — `source -> sink(Http)` exercising the Phase-5 EXECUTOR seam with a STATIC
/// log of host-logged command outcomes (REPLAY-04 cross-platform + EXEC-03 frozen).
///
/// The sink emits one `Command` of side-effecting intent per consumed item; the
/// cert runner NEVER dispatches it. The static log BAKES the three outcomes the host
/// would have logged on a live run — a `CommandResult{Success}`, a
/// `CommandResult{Failure}`, and a `Timeout` — each keyed to a distinct command id
/// the sink emitted. Re-folding them through Plan-01's `admit()` arms proves the
/// routing is deterministic and platform-independent: `Success` is audit-only (it
/// leaves NO grid trace), while `Failure` and `Timeout` each deposit a fault
/// (`CommandFailure` / `CommandTimeout`) on the **emitting sink's own FAULT_PORT
/// inbox** — the dead-letter resting place — and wake it. The sink's `step` only
/// drains input port 0, so the FAULT_PORT inbox faults persist into the frozen
/// tick state (the EXEC-03 proof).
///
/// Note (deviation from the literal plan prose): unlike gen_0005's factory, which
/// *emits* its `FactoryTimeout` to its outbox `FAULT_PORT` and the tick loop routes
/// it along a link to a downstream dead-letter node, a command fault is *deposited*
/// straight into the emitting sink's INBOX by `admit()` and never reaches an
/// outbox — so a `link((sink, FAULT_PORT), dead_letter)` would carry nothing. The
/// sink's own FAULT_PORT inbox IS the dead-letter collector here (empirically
/// verified before freezing).
///
/// The command ids are DISCOVERED on a throwaway clone (fold the three source-fire
/// ticks, read the `Vec<Command>` each `advance()` returns) rather than hardcoded,
/// so the fixture cannot silently drift from the sink's real id derivation.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0006-executor-loop"]
fn gen_0006_executor_loop() {
    const SEED: u64 = 0x0006_5006;
    let (core, s, k) = source_sink_deadletter(
        SEED,
        SinkTemplate::Http {
            url: "https://example.invalid/launch".to_owned(),
            method: fabrico_core::state::HttpMethod::Post,
        },
        4,
    );
    // Genesis captured BEFORE any fold (topology only; the sink inbox is empty).
    let genesis = snapshot::snapshot(&core);

    // DISCOVER the three distinct command ids the sink emits by firing s at ticks
    // 0,1,2 on a THROWAWAY clone and reading the commands each advance() returns.
    let mut probe = core.clone();
    let mut ids = Vec::new();
    for t in 0..3u64 {
        for cmd in probe.advance(&[fire(s, t, t, Item(b"go".to_vec()))]) {
            ids.push(cmd.id);
        }
    }
    assert_eq!(
        ids.len(),
        3,
        "the sink emits exactly three commands (one per source fire)"
    );
    let (cmd_a, cmd_b, cmd_c) = (ids[0], ids[1], ids[2]);

    // STATIC log: three fires emit commands A,B,C; then BAKE the host-logged
    // outcomes — A succeeds (audit-only), B fails, C times out.
    let log = vec![
        fire(s, 0, 0, Item(b"go".to_vec())),
        fire(s, 1, 1, Item(b"go".to_vec())),
        fire(s, 2, 2, Item(b"go".to_vec())),
        command_result(cmd_a, 10, 3, Outcome::Success), // audit-only, no grid trace
        command_result(cmd_b, 11, 4, Outcome::Failure), // -> CommandFailure on sink FAULT_PORT
        command_timeout(cmd_c, 12, 5),                  // -> CommandTimeout on sink FAULT_PORT
    ];

    // Behavior assertion (generator-time sanity, mirroring gen_0005's dead-letter
    // check): fold a FRESH restore of the frozen genesis and confirm the dead-letter
    // resting place (the sink's FAULT_PORT inbox) ends with exactly the Failure then
    // Timeout faults, and the Success left no fault.
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        let mut idx = 0usize;
        for t in 0..6u64 {
            let start = idx;
            while idx < log.len() && log[idx].tick == t {
                idx += 1;
            }
            check.advance(&log[start..idx]);
        }
        assert_eq!(
            fault_port_reasons(&check, k),
            vec![FaultReason::CommandFailure, FaultReason::CommandTimeout],
            "the sink's FAULT_PORT inbox dead-letters exactly the Failure then Timeout \
             faults; the Success result produced no fault"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0006-executor-loop",
            builder: "source_sink_deadletter(Http) + logged CommandResult/Timeout outcomes",
            seed: SEED,
            params: "Success audit-only; Failure+Timeout route CommandFailure/CommandTimeout \
                     faults to the emitting sink's FAULT_PORT inbox (dead-letter)",
            tick_count: 6,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0007 — INTERLEAVED edit-ADD during flow (08-03 / ELOG-03): the spike's proof that
/// the two-log merge is EDITS-FIRST ("build, then run").
///
/// Genesis: `s -> b(3) -> c` with one item already in flight on the belt. At tick 2
/// (while that item is still travelling) the EDIT-LOG mints a brand-new source `s2`,
/// draws a belt and docks it `s2 -> belt -> c` (DrawBelt+Dock, the post-Wire-removal
/// model), and the EVENT-LOG fires an item into `s2` at the SAME tick 2.
/// Because edits apply FIRST, `s2` + its belt exist before the tick-2 event fold, so
/// the fire routes through the just-grafted branch and reaches `c`. Under an
/// events-first order the fire would admit to a not-yet-existing target and drop —
/// so the frozen hashes capture an outcome ONLY edits-first can produce.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0007-edit-add-during-flow"]
fn gen_0007_edit_add_during_flow() {
    const SEED: u64 = 0x0007_ED17;
    // Genesis: s -> b(3) -> c (the item rides the belt across ticks 0..3).
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let b = core.state.add_belt(3);
    let c = core.state.add_source();
    core.state.link((s, 0), (b, 0));
    core.state.link((b, 0), (c, 0));
    let _ = b;
    let genesis = snapshot::snapshot(&core);

    // Edit-log @tick2: mint s2, DRAW a 1-tile belt, then DOCK it s2(Tail)->belt->c(Head)
    // — the post-Wire-removal model (belts come only from DrawBelt; the two ends are
    // separate explicit Dock commands). The Tail dock links (s2,0)->(belt,0) so s2 feeds
    // the belt entry; the Head dock links (belt,0)->(c,0) so the belt delivers into c.
    let place_s2 = edit_record(
        1,
        2,
        EditOp::Place {
            kind: KIND_SOURCE,
            cell_x: 0,
            cell_y: 0,
            w: 1,
            h: 1,
            ports: vec![],
            rot: 0,
        },
    );
    // A standalone 1-tile drawn belt (the logical successor to the old Wire belt);
    // its tile cell (2,0) is free (s2 claims (0,0); genesis nodes claim no cells).
    let draw_belt = edit_record(
        2,
        2,
        EditOp::DrawBelt {
            tiles: vec![BeltTile::new((2, 0), TileKind::default())],
        },
    );

    // Discover the ids s2 + the drawn belt mint. Nothing mints before tick 2, so folding
    // the Place + DrawBelt on a throwaway restore yields the exact ids the real fold will
    // (fold_place pushes s2, fold_draw_belt pushes the belt — both into last_tick.placed).
    let (s2, belt) = {
        let mut probe = snapshot::restore(&genesis).expect("genesis restores");
        probe.advance_edits(&[place_s2.clone(), draw_belt.clone()], &[]);
        (probe.last_tick.placed[0], probe.last_tick.placed[1])
    };

    let dock_tail = edit_record(
        3,
        2,
        EditOp::Dock { belt, endpoint: BeltEnd::Tail, node: s2, port: 0 },
    );
    let dock_head = edit_record(
        4,
        2,
        EditOp::Dock { belt, endpoint: BeltEnd::Head, node: c, port: 0 },
    );
    let edits = vec![place_s2, draw_belt, dock_tail, dock_head];
    // Event-log: item1 into s at tick 0 (mid-flight); item2 into the just-grafted s2 at
    // tick 2 (flows ONLY because the edit applied first).
    let log = vec![
        fire(s, 1, 0, Item(vec![0x01])),
        fire(s2, 2, 2, Item(vec![0x02])),
    ];
    freeze(
        &Meta {
            scenario_id: "0007-edit-add-during-flow",
            builder: "inline s->b(3)->c + edit-log grafting s2->belt->c at tick 2 via DrawBelt+Dock (EDITS-FIRST)",
            seed: SEED,
            params: "belt latency=3; edit@tick2 Place(SOURCE)+DrawBelt(1-tile)+Dock(s2 Tail, c Head); fire s@0, s2@2",
            tick_count: 6,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0008 — INTERLEAVED edit-DELETE during flow (08-03 / ELOG-03 / Q3): a belt carrying
/// an in-flight item is deleted mid-flow, and the item DROPS via the existing
/// missing-link no-op (zero new machinery).
///
/// Genesis: `s -> b(3) -> c` with one item fired at tick 0. At tick 1 (while the item
/// is mid-belt) the EDIT-LOG deletes `b`. `fold_delete` removes the belt + forgets its
/// scheduled wake, so the in-flight item never re-arrives and no later tick panics on
/// a dead id. The fixture is driven several ticks past the original arrival to freeze
/// the no-resurrection / no-panic steady state.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0008-edit-delete-during-flow"]
fn gen_0008_edit_delete_during_flow() {
    const SEED: u64 = 0x0008_DE17;
    // Genesis: s -> b(3) -> c.
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let b = core.state.add_belt(3);
    let c = core.state.add_source();
    core.state.link((s, 0), (b, 0));
    core.state.link((b, 0), (c, 0));
    let _ = c;
    let genesis = snapshot::snapshot(&core);

    // Event-log: one item into s at tick 0 (mid-belt across ticks 0..3).
    let log = vec![fire(s, 1, 0, Item(vec![0x77]))];
    // Edit-log @tick1: delete the belt while the item is in flight (the belt's id is
    // deterministic from genesis fold order — s, b, c).
    let edits = vec![edit_record(
        1,
        1,
        EditOp::Delete {
            node: b,
            kind: KIND_BELT,
            cell_x: 0,
            cell_y: 0,
            // 12-02: default-empty capture — the re-bless adds only these body bytes
            // (fold ignores them), keeping every per-tick hash byte-identical.
            captured: Default::default(),
        },
    )];
    freeze(
        &Meta {
            scenario_id: "0008-edit-delete-during-flow",
            builder: "inline s->b(3)->c + edit-log deleting b at tick 1 mid-flow (Q3 drop)",
            seed: SEED,
            params: "belt latency=3; fire s@0; edit@tick1 Delete(b); item drops via missing-link no-op",
            tick_count: 7,
        },
        &genesis,
        &edits,
        &log,
    );
}

// ---------------------------------------------------------------------------
// Phase 37 ADDITIVE wire fixtures (WIRE-01..04). Registered LAST in the CORPUS
// table (0001-0021 frozen corpus UNTOUCHED — NO re-bless, NO version bump). Each
// builds a wire request/response topology INLINE and drives a logged
// `WireRequest` (constructed via the local `wire_request_event` below, NOT the
// Plan-05 `common::wire_fire` helper, so this wave stands alone), so multi-hop
// transport / reply reverse-transport / the same-tick belt+wire tie-break / the
// DEPTH (budget cycle) + SPACE (in-flight cap fan-in) overflow bounds all fold +
// replay byte-identically from genesis on every platform. The two WIRE-03 bounds
// are INTEGRATION-proven here as real topologies (a routing cycle for DEPTH, a
// fan-in for SPACE), not just unit-proven in `wire.rs`.
// ---------------------------------------------------------------------------

/// Build a logged [`EventPayload::WireRequest`] INLINE — the Plan-05
/// `common::wire_fire`-INDEPENDENT sibling that keeps this fixture wave self-standing.
/// `return_addr` names BOTH the reply target AND the entry node (the caller is both
/// origin and reply target — `manual_inject.rs:149`); the admit arm locates the entry
/// wire via `wire_from_node(return_addr.0)`. `deadline_tick` is the unused-this-phase
/// Phase-38 reply deadline, pinned to `u64::MAX` so it is never a folding factor.
fn wire_request_event(
    return_addr: (NodeId, PortId),
    correlation: u64,
    budget: u64,
    seq: u64,
    tick: u64,
    payload: Item,
) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::WireRequest {
            correlation,
            deadline_tick: u64::MAX,
            budget,
            return_addr,
            payload,
        },
    }
}

/// The in-flight message count on a `Node::Wire` (its `WireLink.in_flight` FIFO len).
fn wire_in_flight_len(core: &Core, id: NodeId) -> usize {
    match core.state.node(id) {
        Some(Node::Wire(link)) => link.in_flight.len(),
        other => panic!("expected a Wire, got {other:?}"),
    }
}

/// The JS handler that services a wire request and emits ONE `ctx.command` — mapped by
/// the 37-03 reply seam to an `Effect::Reply` routed back to the caller by correlation
/// (a non-wire input would stay `Effect::Noop`). Shared by 0023 + 0024.
const WIRE_REPLY_HANDLER_JS: &str =
    "export default function (input, ctx) { ctx.command({ok:1}, 0); }";

/// 0022 — WIRE MULTI-HOP TRANSPORT (WIRE-02/04, the wire-transport corpus anchor):
/// `caller -> wire1 -> wire2 -> handler`. A single logged `WireRequest` admitted at
/// tick 0 hops wire-to-wire, `>= 1` tick per hop (the maturity gate), through the
/// Plan-02 inbox INGEST path, spending one DEPTH-budget unit per wire it is DELIVERED
/// into (the entry-wire hop is free, wire2 spends 1 → the handler sees budget-1), and
/// is delivered as an opaque `WireEnvelope` into the handler's inbox through the ONE
/// `route_seq` queue belt items use. The frozen per-tick blake3 manifest re-proves the
/// multi-hop transport replays byte-identically on every OS. Purely additive
/// (0001-0021 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0022-wire-transport-basic"]
fn gen_0022_wire_transport_basic() {
    const SEED: u64 = 0x0022_5117;
    // caller -> wire1 -> wire2 -> handler. wire1 is the ENTRY wire (from.node == caller).
    let mut core = Core::genesis(header(SEED));
    let caller = core.state.add_source();
    let handler = core.state.add_source();
    let wire1 = core.state.add_wire((caller, 0), (handler, 0)); // entry (from.node == caller)
    let wire2 = core.state.add_wire((wire1, 0), (handler, 0));
    core.state.link((wire1, 0), (wire2, 0)); // wire1 forwards into wire2's inbox
    core.state.link((wire2, 0), (handler, 0)); // wire2 forwards into the handler's inbox
    let genesis = snapshot::snapshot(&core);

    const CORRELATION: u64 = 0x0022_C0DE;
    // One request admitted at tick 0 (return_addr == caller), budget 8.
    let log = vec![wire_request_event((caller, 0), CORRELATION, 8, 1, 0, Item(vec![0x22]))];

    // Generator-time sanity (mirrors gen_0006): a FRESH restore of the frozen genesis
    // folds the request and delivers the twice-hopped envelope to the handler — budget
    // decremented ONCE (entry free + wire2 spends 1), payload intact.
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        check.advance(&log); // tick 0: admit into the entry wire
        let mut delivered: Option<WireEnvelope> = None;
        for _ in 0..10u64 {
            check.advance(&[]);
            if let Some(inbox) = check.state.inbox_of(handler) {
                let mut clone = inbox.clone();
                if let Some((_seq, item)) = clone.take(0) {
                    delivered =
                        Some(WireEnvelope::decode(&item).expect("a well-formed envelope delivered"));
                    break;
                }
            }
        }
        let env = delivered.expect("the handler received the multi-hop envelope");
        assert_eq!(env.correlation, CORRELATION, "correlation transported intact");
        assert_eq!(env.return_addr, (caller, 0), "return_addr transported intact");
        assert_eq!(env.budget, 7, "budget spent once across two wires (entry free, wire2 spends 1)");
        assert_eq!(env.payload, Item(vec![0x22]), "payload transported intact");
        assert_eq!(wire_in_flight_len(&check, wire1), 0, "wire1 drained");
        assert_eq!(wire_in_flight_len(&check, wire2), 0, "wire2 drained");
    }

    freeze(
        &Meta {
            scenario_id: "0022-wire-transport-basic",
            builder: "inline caller -> wire1 -> wire2 -> handler + logged WireRequest (budget 8) — multi-hop >= 1 tick/hop INGEST, budget-1 per delivered wire, delivered via the ONE route_seq queue",
            seed: SEED,
            params: "WIRE-02/04 multi-hop: request admitted @tick0 (return_addr==caller); hops wire1->wire2 (entry hop free, wire2 spends 1 => handler sees budget-1); delivered as opaque WireEnvelope through the same route_seq drain belt items use",
            tick_count: 10,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0023 — WIRE REPLY ROUND-TRIP (WIRE-01/04, the request/response corpus anchor):
/// `caller -> forward_wire -> factory-handler -> return_wire -> caller`. A logged
/// `WireRequest` (budget 8) reaches a factory whose JS emits one `ctx.command`, which
/// the 37-03 reply seam maps to an `Effect::Reply{correlation, payload}`; the fold
/// reverse-transports it back to the caller (return_addr) BY CORRELATION through the
/// return wire and the SAME `route_seq` queue — the reply INHERITING the request's
/// REMAINING budget (Warning 2) so the whole forward+return round-trip is bounded by
/// ONE budget. This is the FIRST corpus fixture crossing the JS boundary for a reply,
/// re-proving the request->handler->reply round-trip is a pure fold consequence that
/// replays byte-identically on every OS. Purely additive (0001-0022 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0023-wire-reply-round-trip"]
fn gen_0023_wire_reply_round_trip() {
    const SEED: u64 = 0x0023_5117;
    // caller -> forward_wire -> factory -> return_wire -> caller.
    let mut core = Core::genesis(header(SEED));
    let caller = core.state.add_source();
    let factory = core.state.add_factory(WIRE_REPLY_HANDLER_JS.to_owned(), 256, 7);
    // THE HANDLER DECLARES AN ELECTRICAL In AT PORT 0, and after phase 72 that
    // declaration is what makes it a handler at all (D-16, plan 72-03). The sandbox
    // drains inbox port 0 ONLY, and `admit::inbox_class` reads the DECLARED MEDIUM of
    // that exact port to decide whether the delivery is a WIRE REQUEST at all.
    // `add_factory` inserts an inbox and NO ports, and an undeclared port reads
    // MECHANICAL (`inbox_class` clause 4), so without this line the request arrives, is
    // never unwrapped, no `Effect::Reply` is produced, and the generator's own sanity
    // block below panics rather than freezing a board that silently does nothing.
    // Deleting this does not simplify the fixture, it silences it.
    core.state.set_ports(
        factory,
        // local_offset (0, 0) and not (0, 1): this factory carries NO footprint, and
        // `snapshot::validate_invariants` step 7 reads an absent footprint as 1x1, so any
        // other offset is refused as `StateInvariant::PortOutOfFootprint` at restore.
        vec![Port {
            local_offset: (0, 0),
            side: Side::W,
            role: Role::In,
            medium: Medium::Electrical,
        }],
    );
    let forward_wire = core.state.add_wire((caller, 0), (factory, 0)); // entry (from.node == caller)
    core.state.link((forward_wire, 0), (factory, 0));
    let return_wire = core.state.add_wire((factory, 0), (caller, 0)); // return (from.node == factory)
    core.state.link((return_wire, 0), (caller, 0));
    let genesis = snapshot::snapshot(&core);

    const CORRELATION: u64 = 0x0023_C0DE;
    // Admit one request at tick 0; the inner payload is valid JSON the handler parses
    // (the wire envelope wrapping it is stripped by the reply seam, 37-03).
    let log = vec![wire_request_event(
        (caller, 0),
        CORRELATION,
        8,
        1,
        0,
        Item(b"{\"n\":1}".to_vec()),
    )];

    // Generator-time sanity: the reply reverse-transports to the caller with the
    // request's correlation and the INHERITED remaining budget (entry + return hops
    // are both free here, so budget stays 8).
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        check.advance(&log); // tick 0: admit the request into the forward wire
        let mut reply: Option<WireEnvelope> = None;
        for _ in 0..10u64 {
            check.advance(&[]);
            if let Some(inbox) = check.state.inbox_of(caller) {
                let mut clone = inbox.clone();
                if let Some((_seq, item)) = clone.take(0) {
                    reply =
                        Some(WireEnvelope::decode(&item).expect("a well-formed reply envelope"));
                    break;
                }
            }
        }
        let env = reply.expect("the reply reverse-transported to the caller");
        assert_eq!(env.correlation, CORRELATION, "reply carries the request's correlation");
        assert_eq!(env.return_addr, (caller, 0), "reply routed to return_addr");
        assert_eq!(env.budget, 8, "reply INHERITS the request's remaining budget (both hops free here)");
    }

    freeze(
        &Meta {
            scenario_id: "0023-wire-reply-round-trip",
            builder: "inline caller -> forward_wire -> factory(handler JS) -> return_wire -> caller + logged WireRequest (budget 8) — handler emits Effect::Reply, reverse-transported by correlation through the ONE route_seq queue, inheriting the remaining budget",
            seed: SEED,
            params: "WIRE-01/04 reply round-trip: request @tick0 (return_addr==caller, correlation 0x0023C0DE); factory reply seam maps ctx.command -> Effect::Reply; reply reverse-transports via the return wire (from.node==factory), inheriting the remaining budget (one budget bounds forward+return)",
            tick_count: 12,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0024 — SAME-TICK BELT+WIRE TIE-BREAK (WIRE-02, the ONE-comparator corpus anchor): a
/// wire REPLY and a belt item land at the SAME machine (the caller) on the SAME tick,
/// and the ONE `route_seq` comparator orders them canonically. Topology:
/// `caller -> forward_wire -> factory -> return_wire -> caller` (the reply lane, as in
/// 0023) PLUS `belt_source -> belt(1) -> caller` (the belt lane). A belt `fire` is
/// scheduled (its tick DISCOVERED on a throwaway probe) so its item arrives at the
/// caller on the exact tick the reply does — belt delivery and wire delivery are
/// INDISTINGUISHABLE to the comparator (both ride the same `route_seq` drain), so the
/// frozen per-tick manifest re-proves the canonical tie-break replays byte-identically
/// on every OS. Purely additive (0001-0023 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0024-same-tick-belt-wire-tiebreak"]
fn gen_0024_same_tick_belt_wire_tiebreak() {
    const SEED: u64 = 0x0024_5117;
    // The reply lane (caller -> forward_wire -> factory -> return_wire -> caller) + a
    // belt lane (belt_source -> belt(1) -> caller) converging on the caller's port 0.
    let mut core = Core::genesis(header(SEED));
    let caller = core.state.add_source();
    let factory = core.state.add_factory(WIRE_REPLY_HANDLER_JS.to_owned(), 256, 7);
    // THE HANDLER DECLARES AN ELECTRICAL In AT PORT 0, for the same load-bearing reason
    // as 0023 above (D-16, plan 72-03): the sandbox drains inbox port 0 ONLY, and after
    // phase 72 the DECLARED MEDIUM of that port is what decides whether the delivery is a
    // wire request at all. Without it the reply lane never produces a reply, probe A
    // below spins to its 60-fold bound and panics, and this fixture's whole subject - a
    // reply and a belt item landing on the SAME tick - has only one lane left to
    // tie-break. Deleting this does not simplify the fixture, it silences it.
    core.state.set_ports(
        factory,
        // local_offset (0, 0) and not (0, 1): this factory carries NO footprint, and
        // `snapshot::validate_invariants` step 7 reads an absent footprint as 1x1, so any
        // other offset is refused as `StateInvariant::PortOutOfFootprint` at restore.
        vec![Port {
            local_offset: (0, 0),
            side: Side::W,
            role: Role::In,
            medium: Medium::Electrical,
        }],
    );
    let forward_wire = core.state.add_wire((caller, 0), (factory, 0)); // entry
    core.state.link((forward_wire, 0), (factory, 0));
    let return_wire = core.state.add_wire((factory, 0), (caller, 0)); // return
    core.state.link((return_wire, 0), (caller, 0));
    let belt_source = core.state.add_source();
    let belt = core.state.add_belt(1);
    core.state.link((belt_source, 0), (belt, 0));
    core.state.link((belt, 0), (caller, 0)); // belt delivers into the caller's port 0
    let genesis = snapshot::snapshot(&core);

    const CORRELATION: u64 = 0x0024_C0DE;

    // Probe A — the REPLY-lane latency: fold ONLY a tick-0 wire request and count the
    // folds until the caller first receives the reply on port 0 (the reply lane leaves
    // nothing in the caller's inbox until the reply lands). A request fired at tick `w`
    // therefore lands its reply after `w + reply_folds` folds.
    let reply_folds = {
        let mut p = snapshot::restore(&genesis).expect("genesis restores");
        p.advance(&[wire_request_event((caller, 0), CORRELATION, 8, 1, 0, Item(b"{\"n\":2}".to_vec()))]);
        let mut folds = 1u64;
        while collector_count(&p, caller) == 0 {
            p.advance(&[]);
            folds += 1;
            assert!(folds < 60, "the reply must reverse-transport within a bounded fold count");
        }
        folds
    };
    // Probe B — the BELT-lane latency: a fire at tick `b` arrives after `b + belt_folds`.
    let belt_folds = {
        let mut p = snapshot::restore(&genesis).expect("genesis restores");
        p.advance(&[fire(belt_source, 1, 0, Item(vec![0x24]))]); // tick 0
        let mut folds = 1u64;
        while collector_count(&p, caller) == 0 {
            p.advance(&[]);
            folds += 1;
            assert!(folds < 60, "the belt item must arrive within a bounded fold count");
        }
        folds
    };
    // Align BOTH lanes to converge on the same fold: fire each at `target - lane_folds`
    // (both non-negative, whichever lane is shorter simply fires later).
    let target = reply_folds.max(belt_folds);
    let wire_tick = target - reply_folds;
    let belt_tick = target - belt_folds;

    // Ordered log (contiguous by tick): the wire request @wire_tick, the belt fire @belt_tick.
    let mut log = vec![
        wire_request_event((caller, 0), CORRELATION, 8, 1, wire_tick, Item(b"{\"n\":2}".to_vec())),
        fire(belt_source, 2, belt_tick, Item(vec![0x24])),
    ];
    log.sort_by_key(|e| (e.tick, e.sequence));

    let tick_count = target + 3;

    // Generator-time sanity: the caller's FIRST non-empty tick already holds BOTH items —
    // the belt item AND the wire reply converged on the SAME tick (the route_seq tie-break).
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        let mut eidx = 0usize;
        let mut first_nonzero: Option<usize> = None;
        for _ in 0..tick_count {
            let t = check.tick;
            let start = eidx;
            while eidx < log.len() && log[eidx].tick == t {
                eidx += 1;
            }
            check.advance(&log[start..eidx]);
            if first_nonzero.is_none() && collector_count(&check, caller) > 0 {
                first_nonzero = Some(collector_count(&check, caller));
            }
        }
        assert_eq!(
            first_nonzero,
            Some(2),
            "the belt item AND the wire reply converge on the SAME tick at the caller \
             (the ONE route_seq comparator orders them canonically)"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0024-same-tick-belt-wire-tiebreak",
            builder: "inline reply lane (caller->forward_wire->factory->return_wire->caller) + belt lane (belt_source->belt(1)->caller); a discovered-tick belt fire lands its item on the caller the SAME tick the wire reply does",
            seed: SEED,
            params: "WIRE-02 tie-break: a wire reply and a belt item converge on the caller's port 0 the SAME tick; both ride the SAME route_seq drain (belt/wire delivery indistinguishable to the ONE comparator), ordered canonically",
            tick_count,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0025 — WIRE BUDGET-OVERFLOW CYCLE / the DEPTH bound (WIRE-03, integration-proven):
/// `caller -> wire_a <-> wire_b` is a routing CYCLE (a real v6.0 misconfiguration). A
/// single logged `WireRequest` (budget 3) bounces `a -> b -> a -> b`, spending one
/// DEPTH-budget unit on each wire it is DELIVERED into, until the budget hits 0 and the
/// next hop faults `FaultReason::WireOverflow` at a DETERMINISTIC tick — and the cycle
/// TERMINATES in a BOUNDED tick count (both wires drain; never hangs, never OOMs). Each
/// wire's reserved `FAULT_PORT` is routed to a dead-letter collector so the frozen
/// fixture's WireOverflow reason is decode-verifiable. The generator carries a HARD tick
/// bound + a termination assertion (Warning: cannot infinite-loop). Purely additive
/// (0001-0024 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0025-wire-budget-overflow-cycle"]
fn gen_0025_wire_budget_overflow_cycle() {
    const SEED: u64 = 0x0025_5117;
    // caller -> wire_a <-> wire_b routing cycle; both fault ports dead-letter to `dead`.
    let mut core = Core::genesis(header(SEED));
    let caller = core.state.add_source();
    let dead = core.state.add_source(); // dead-letter collector for the WireOverflow fault
    let wire_a = core.state.add_wire((caller, 0), (caller, 0)); // entry (from.node == caller)
    let wire_b = core.state.add_wire((wire_a, 0), (caller, 0));
    core.state.link((wire_a, 0), (wire_b, 0));
    core.state.link((wire_b, 0), (wire_a, 0)); // b forwards back to a — THE cycle
    // Route each wire's reserved FAULT_PORT to the dead-letter collector (fault-emit key),
    // so the WireOverflow the DEPTH bound trips rests decode-verifiably in `dead`'s inbox.
    core.state.link((wire_a, FAULT_PORT), (dead, 0));
    core.state.link((wire_b, FAULT_PORT), (dead, 0));
    let genesis = snapshot::snapshot(&core);

    const CORRELATION: u64 = 0x0025_C0DE;
    const BUDGET: u64 = 3;
    let log = vec![wire_request_event((caller, 0), CORRELATION, BUDGET, 1, 0, Item(vec![0x55]))];

    // Generator-time BOUNDED-TERMINATION proof (the DEPTH bound cannot hang): fold a
    // FRESH restore under a HARD tick ceiling; the cycle MUST fault WireOverflow at a
    // deterministic tick AND fully drain (both wires empty) within the bound.
    const HARD_BOUND: u64 = 64;
    let settle_folds = {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        check.advance(&log); // tick 0: admit into the entry wire
        let mut folds = 1u64;
        let mut faulted_at: Option<u64> = None;
        let mut drained_at: Option<u64> = None;
        for _ in 0..HARD_BOUND {
            check.advance(&[]);
            folds += 1;
            if faulted_at.is_none() && !check.last_tick.faulted.is_empty() {
                faulted_at = Some(folds);
            }
            if faulted_at.is_some()
                && wire_in_flight_len(&check, wire_a) == 0
                && wire_in_flight_len(&check, wire_b) == 0
            {
                drained_at = Some(folds);
                break;
            }
        }
        assert!(
            faulted_at.is_some(),
            "the routing cycle trips WireOverflow at a deterministic tick within the HARD bound (never hangs)"
        );
        let drained = drained_at.expect("the cycle terminates — both wires drain within the HARD bound");
        // The DEPTH-bound fault is a WireOverflow (decode it from the dead-letter inbox).
        let reasons: Vec<FaultReason> = collector_items(&check, dead)
            .iter()
            .map(|item| Fault::decode(item).expect("decode the dead-lettered fault").reason)
            .collect();
        assert!(
            !reasons.is_empty() && reasons.iter().all(|r| *r == FaultReason::WireOverflow),
            "the cycle dead-letters exactly WireOverflow fault(s) (the DEPTH bound), got {reasons:?}"
        );
        drained
    };
    // Freeze a couple of ticks past the settled (fully drained) terminal state.
    let tick_count = settle_folds + 2;

    freeze(
        &Meta {
            scenario_id: "0025-wire-budget-overflow-cycle",
            builder: "inline caller -> wire_a <-> wire_b routing cycle (both FAULT_PORTs dead-lettered) + logged WireRequest (budget 3) — a request bounces a<->b, budget-1 per delivered wire, faulting WireOverflow when the budget hits 0",
            seed: SEED,
            params: "WIRE-03 DEPTH bound (integration): a routing cycle spends one budget unit per delivered wire; budget 3 exhausts at a DETERMINISTIC tick -> WireOverflow (dead-lettered); the cycle TERMINATES in bounded ticks (both wires drain — never hangs/OOMs)",
            tick_count,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0026 — WIRE CAP-OVERFLOW FAN-IN / the SPACE bound (WIRE-03, integration-proven):
/// `caller -> wire -> handler`. A fan-IN of `WIRE_INFLIGHT_CAP + 1` (257) logged
/// `WireRequest`s, ALL at tick 0 with `return_addr == caller`, all admit into the ONE
/// entry wire (`wire_from_node(caller)`). The FIFO fills to EXACTLY the cap (256); the
/// over-cap 257th request REFUSES admission and faults `FaultReason::WireOverflow` to
/// the entry node (caller) — `in_flight` NEVER exceeds `WIRE_INFLIGHT_CAP` (cannot OOM).
/// The generator asserts the at-cap state + the WireOverflow fault + the never-exceeds-cap
/// invariant across the whole run. Purely additive (0001-0025 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0026-wire-cap-overflow-fanin"]
fn gen_0026_wire_cap_overflow_fanin() {
    const SEED: u64 = 0x0026_5117;
    // caller -> wire -> handler. The single entry wire (from.node == caller) receives the
    // whole fan-in of same-tick requests.
    let mut core = Core::genesis(header(SEED));
    let caller = core.state.add_source();
    let handler = core.state.add_source();
    let wire = core.state.add_wire((caller, 0), (handler, 0)); // the sole entry wire
    core.state.link((wire, 0), (handler, 0));
    let genesis = snapshot::snapshot(&core);

    // Fan-IN of WIRE_INFLIGHT_CAP + 1 requests, ALL at tick 0, all return_addr == caller.
    let fanin = (WIRE_INFLIGHT_CAP + 1) as u64; // 257
    let log: Vec<Event> = (0..fanin)
        .map(|i| {
            wire_request_event(
                (caller, 0),
                0x0026_0000 + i, // distinct correlation per request
                8,
                i + 1, // distinct ascending sequence
                0,     // ALL at tick 0 — a single-tick fan-in
                Item(vec![(i & 0xFF) as u8]),
            )
        })
        .collect();

    // Generator-time SPACE-bound proof: at tick 0 the FIFO fills to EXACTLY the cap and
    // the over-cap request faults WireOverflow to the entry node; across the whole run
    // in_flight never exceeds WIRE_INFLIGHT_CAP.
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        check.advance(&log); // tick 0: all 257 admits (256 placed, 1 refused + faulted)
        assert_eq!(
            wire_in_flight_len(&check, wire),
            WIRE_INFLIGHT_CAP,
            "the FIFO fills to EXACTLY the cap, never past it"
        );
        assert_eq!(
            fault_port_reasons(&check, caller),
            vec![FaultReason::WireOverflow],
            "the over-cap (257th) request faults WireOverflow to the entry node (the SPACE bound)"
        );
        let mut max_in_flight = wire_in_flight_len(&check, wire);
        for _ in 0..4u64 {
            check.advance(&[]);
            max_in_flight = max_in_flight.max(wire_in_flight_len(&check, wire));
        }
        assert!(
            max_in_flight <= WIRE_INFLIGHT_CAP,
            "in_flight NEVER exceeds the cap across the run (cannot OOM): {max_in_flight} <= {WIRE_INFLIGHT_CAP}"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0026-wire-cap-overflow-fanin",
            builder: "inline caller -> wire -> handler + a fan-IN of WIRE_INFLIGHT_CAP+1 (257) same-tick WireRequests into the ONE entry wire — 256 fill the FIFO, the 257th refuses + faults WireOverflow to the entry node",
            seed: SEED,
            params: "WIRE-03 SPACE bound (integration): 257 same-tick requests fan-in to one entry wire; the FIFO fills to exactly WIRE_INFLIGHT_CAP=256 and the over-cap request faults WireOverflow to the caller; in_flight never exceeds the cap (cannot OOM)",
            tick_count: 5,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0009 — MULTI-CELL footprint + a valid belt dock (FOOT-01 / FOOT-03 corpus growth).
///
/// Genesis is empty. The EDIT-LOG (tick 0) places TWO instances of the multi-cell
/// exemplar — a 2×3 machine with an `In` port on its west edge (port 0, local (0,0))
/// and an `Out` port on its east edge (port 1, local (1,2)) — each frozen with its
/// RESOLVED dims+ports (catalog-INDEPENDENT: the record carries the dims, so replay
/// never consults `fabrico-command`'s `port_catalog`), then DRAWS a 1-tile belt and
/// DOCKS A's `Out` port and B's `In` port to it as a VALID dock (the post-Wire-removal
/// DrawBelt+Dock model). Router A at (0,0) puts its `Out` world-cell at (1,2) facing E;
/// router B at (3,2) puts its `In` world-cell at (3,2) facing W; the drawn belt tile
/// sits at (2,2) BETWEEN them — one step E of A.Out (Tail OFFLOAD) and one step W of
/// B.In (Head LOAD), facing-adjacent on both ends (the FOOT-03 dock rule). The fold
/// claims both 2×3 footprints into the single occupancy index (every body cell, not
/// just the anchor) and the belt's tile cell, and links the docked belt
/// (`A.Out -> belt -> B.In`). The fixture then rests
/// several ticks (no events) so the frozen per-tick hashes capture a multi-cell
/// topology + a dock AT REST, re-proving byte-identically on every OS. Purely additive
/// (0001-0008 untouched): exercises a `>1×1` machine the earlier corpus never had.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0009-multi-cell-footprint"]
fn gen_0009_multi_cell_footprint() {
    const SEED: u64 = 0x0009_F007;
    // Genesis: an empty grid (the two multi-cell machines + the dock arrive via edits).
    let core = Core::genesis(header(SEED));
    let genesis = snapshot::snapshot(&core);

    // The exemplar's frozen rot-0 ports: In on the west edge as port 0 at (0,0), Out on
    // the east edge as port 1 at (1,2). This FREEZES the pre-63-07 two-port exemplar
    // layout in hand-built `Place` records; it does NOT mirror the current
    // `port_catalog(ROUTER)` (which since 74.1-14 seats the In at (0,1) and the first Out
    // at (1,1)), and no command builds this record, so the catalog change moves none of
    // its bytes.
    let exemplar_ports = || {
        vec![
            Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
            Port { local_offset: (1, 2), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
        ]
    };
    // Two 2×3 placements at tick 0: A at (0,0), B at (2,2) — non-overlapping bodies.
    let place_a = edit_record(
        1,
        0,
        EditOp::Place {
            kind: KIND_ROUTER,
            cell_x: 0,
            cell_y: 0,
            w: 2,
            h: 3,
            ports: exemplar_ports(),
            rot: 0,
        },
    );
    // B anchored at (3,2) so its In world-cell lands at (3,2) facing W — leaving cell
    // (2,2) FREE between A.Out (1,2) and B.In (3,2) for a real 1-tile drawn belt (the
    // post-Wire-removal model: a belt has real geometry, so the two facing ports need a
    // tile of gap rather than the old empty-geometry Wire belt bridging adjacent cells).
    let place_b = edit_record(
        2,
        0,
        EditOp::Place {
            kind: KIND_ROUTER,
            cell_x: 3,
            cell_y: 2,
            w: 2,
            h: 3,
            ports: exemplar_ports(),
            rot: 0,
        },
    );
    // A 1-tile drawn belt at (2,2): one step E of A.Out (1,2) — its Tail OFFLOAD dock —
    // AND one step W of B.In (3,2) — its Head LOAD dock. Head==Tail==(2,2) on a single
    // tile; both docks are facing-adjacent and VALID (the FOOT-03 dock rule).
    let draw_belt = edit_record(
        3,
        0,
        EditOp::DrawBelt {
            tiles: vec![BeltTile::new((2, 2), TileKind::default())],
        },
    );

    // Discover the ids A, B, and the drawn belt mint (deterministic fold order on a
    // throwaway restore): all three records fold at tick 0, so `placed` holds
    // [A, B, belt] in fold order (fold_place pushes A then B; fold_draw_belt pushes belt).
    let (a, b, belt) = {
        let mut probe = snapshot::restore(&genesis).expect("genesis restores");
        probe.advance_edits(&[place_a.clone(), place_b.clone(), draw_belt.clone()], &[]);
        (
            probe.last_tick.placed[0],
            probe.last_tick.placed[1],
            probe.last_tick.placed[2],
        )
    };

    // Dock A.port1 (Out @ (1,2) facing E) as the belt's Tail OFFLOAD: link (a,1)->(belt,0).
    // Dock B.port0 (In @ (3,2) facing W) as the belt's Head LOAD:     link (belt,0)->(b,0).
    // Together they reproduce the old Wire's A.Out -> belt -> B.In directed path.
    let dock_tail = edit_record(
        4,
        0,
        EditOp::Dock { belt, endpoint: BeltEnd::Tail, node: a, port: 1 },
    );
    let dock_head = edit_record(
        5,
        0,
        EditOp::Dock { belt, endpoint: BeltEnd::Head, node: b, port: 0 },
    );
    let edits = vec![place_a, place_b, draw_belt, dock_tail, dock_head];
    // A dock at rest: NO events (the fixture freezes multi-cell occupancy + the docked
    // topology, not item flow).
    let log: Vec<Event> = vec![];

    freeze(
        &Meta {
            scenario_id: "0009-multi-cell-footprint",
            builder: "two 2x3 multi-cell exemplars + DrawBelt(1-tile @(2,2)) + Dock Tail->A.Out/Head->B.In (valid facing dock, FOOT-01/FOOT-03)",
            seed: SEED,
            params: "A@(0,0) Out(1,2,E) --belt(2,2)--> B@(3,2) In(3,2,W); 2x3 footprints; DrawBelt+Dock at rest",
            tick_count: 4,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0010 — DELETE-WITH-CASCADE during flow (FOOT-04 / 10-05): deleting a multi-cell
/// machine frees its WHOLE footprint AND cascade-detaches its docked Wire-minted
/// belts, dropping an in-flight item via the missing-link no-op (Q3), AR-3-safe.
///
/// Genesis: `s -> beltA(3) -> M -> beltC(3) -> c`, where `M` is a 2×3 multi-cell
/// machine. One item is fired into `s` at tick 0; it rides `beltA` in-flight (arrival
/// tick 3). At tick 1 the EDIT-LOG deletes `M` mid-flow. `remove_node` frees M's whole
/// 2×3 footprint and cascade-detaches BOTH docked belts (`beltA` carrying the
/// in-flight item, and `beltC`) in `(NodeId,PortId)` order; `fold_delete` pairs
/// `sched.remove` with each removal (the AR-3 pairing, Pitfall 4), so the in-flight
/// item DROPs (never re-arrives, no `BeltWakeMissing`/`DanglingSchedule`, no panic).
/// The fixture is driven several ticks past the original arrival to freeze the
/// no-resurrection / no-panic steady state. Purely additive (0001-0009 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0010-delete-cascade-detach"]
fn gen_0010_delete_cascade_detach() {
    const SEED: u64 = 0x0010_CADE;
    // Genesis: s -> beltA(3) -> M(2x3) -> beltC(3) -> c. M is a multi-cell machine
    // (a router footprint) with docked Wire-minted belts on its in + out ports.
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let belt_a = core.state.add_belt(3);
    let m = core.state.add_router(vec![], Some(0));
    let belt_c = core.state.add_belt(3);
    let c = core.state.add_source();
    // Claim M's WHOLE 2×3 footprint (anchored at (5,5)) so the delete must free every
    // body cell, not just the anchor (the FOOT-04 whole-footprint free).
    core.state.claim_footprint(m, (5, 5), 2, 3, 0);
    core.state.link((s, 0), (belt_a, 0));
    core.state.link((belt_a, 0), (m, 0));
    core.state.link((m, 0), (belt_c, 0));
    core.state.link((belt_c, 0), (c, 0));
    let _ = c;
    let genesis = snapshot::snapshot(&core);

    // Event-log: one item into s at tick 0 (rides beltA across ticks 0..3).
    let log = vec![fire(s, 1, 0, Item(vec![0xCA]))];
    // Edit-log @tick1: delete M while the item is in flight on beltA. The cascade
    // detaches both belts; the in-flight item drops (Q3). M's id is deterministic
    // from genesis fold order (s, beltA, m, beltC, c).
    let edits = vec![edit_record(
        1,
        1,
        EditOp::Delete {
            node: m,
            kind: KIND_ROUTER,
            cell_x: 5,
            cell_y: 5,
            captured: Default::default(),
        },
    )];
    freeze(
        &Meta {
            scenario_id: "0010-delete-cascade-detach",
            builder: "inline s->beltA(3)->M(2x3)->beltC(3)->c + edit-log deleting M at tick 1 mid-flow (FOOT-04 cascade + Q3 drop)",
            seed: SEED,
            params: "belt latency=3; M 2x3 footprint @(5,5); fire s@0; edit@tick1 Delete(M) cascade-detaches beltA(in-flight)+beltC; item drops via missing-link no-op",
            tick_count: 7,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0011 — ROTATE-IN-PLACE (FOOT-02 / 10-06; re-blessed under 17-05 selective de-dock):
/// a multi-cell machine rotated 90° four times returns its footprint/occupancy to the
/// original orientation (`rotate90⁴ == identity` for the BARE footprint), and rotating a
/// DOCKED machine SELECTIVELY UNLINKS the dock that can no longer reach — the belt
/// SURVIVES (it is no longer destroyed).
///
/// Genesis: a 2×3 multi-cell machine `M` (a router footprint anchored at (5,5)) with
/// an empty-geometry belt docked to its `Out` port (`M -> belt -> sink`). The EDIT-LOG
/// grafts FOUR `+1` quarter-turn `Rotate` records (ticks 0..3): each is an
/// anchor-preserving pivot that frees M's old footprint cells and re-expands the
/// new-rot rectangle into occupancy. The FIRST rotate moves M's port world-cells, so
/// `fold_rotate` runs the selective-de-dock predicate; the docked belt has EMPTY
/// geometry (no tile can face the port) so its dock is UNLINKED — the belt node
/// SURVIVES disconnected and `last_tick.unlinked` records it (NO `remove_node`, NO
/// `sched.remove` — 17-05 Pitfall 4). The remaining three rotate the now-undocked
/// machine (no further docks to evaluate). After four `+1` turns M's footprint occupancy
/// returns to the rot-0 state — the identity proof for the BARE footprint captured in
/// the frozen per-tick hashes (the dock is NOT restored on turn 4: rotate90⁴ is NOT a
/// grid identity once a dock was unlinked — 17-05 Landmine 4). Re-blessed in 17-06 under
/// the selective-de-dock semantics (the belt survives; the OLD cascade-destroy is gone).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0011-rotate-in-place"]
fn gen_0011_rotate_in_place() {
    const SEED: u64 = 0x0011_2071;
    // Genesis: M(2x3) with a docked empty-geometry belt (M -> belt -> sink). M is a
    // router footprint anchored at (5,5); the belt docks to M's out port.
    let mut core = Core::genesis(header(SEED));
    let m = core.state.add_router(vec![], Some(0));
    let belt = core.state.add_belt(1);
    let sink = core.state.add_source();
    // Claim M's WHOLE 2×3 footprint so each rotate frees/re-expands every body cell,
    // not just the anchor (the anchor-preserving pivot over the full rectangle).
    core.state.claim_footprint(m, (5, 5), 2, 3, 0);
    // Dock a belt to M (M.port1 -> belt -> sink): rotating M UNLINKS this dock (the belt
    // survives; the empty-geometry belt cannot face the port's new world cell).
    core.state.link((m, 1), (belt, 0));
    core.state.link((belt, 0), (sink, 0));
    let _ = sink;
    let genesis = snapshot::snapshot(&core);

    // Edit-log: four +1 quarter-turns (ticks 0..3). rot cycles 0→1→2→3→0, so the
    // fourth rotate returns M's footprint to rot-0 (rotate90⁴ == footprint identity). The
    // tick-0 rotate selectively UNLINKS the docked belt (belt survives, unlinked). M's id
    // is deterministic from the genesis fold order (m, belt, sink).
    let edits = vec![
        edit_record(1, 0, EditOp::Rotate { node: m, new_rot: 1, old_rot: 0 }),
        edit_record(2, 1, EditOp::Rotate { node: m, new_rot: 2, old_rot: 1 }),
        edit_record(3, 2, EditOp::Rotate { node: m, new_rot: 3, old_rot: 2 }),
        edit_record(4, 3, EditOp::Rotate { node: m, new_rot: 0, old_rot: 3 }),
    ];
    // No events: the fixture freezes rotation occupancy + the cascade-on-rotate, not
    // item flow.
    let log: Vec<Event> = vec![];

    freeze(
        &Meta {
            scenario_id: "0011-rotate-in-place",
            builder: "inline M(2x3) + docked belt (M->belt->sink) + edit-log rotating M four +1 quarter-turns (FOOT-02 rotate90^4==footprint-identity + 17-05 selective de-dock)",
            seed: SEED,
            params: "M 2x3 footprint @(5,5); belt docked to M.port1; edits ticks 0..3 Rotate +1 each (rot 0->1->2->3->0); tick-0 rotate UNLINKS the docked belt (belt survives, last_tick.unlinked records it)",
            tick_count: 5,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0012 — LENGTH-AS-BUFFER + belt->belt BACKPRESSURE BUNCHING (BELT-05/07): a source
/// feeds a length-2 per-tile `beltA` whose head feeds a length-1 `beltB` whose head is
/// DANGLING (no downstream link ⇒ a permanently full tail). Items advance tile-by-tile
/// and, once `beltB` saturates, BUNCH backward into `beltA` (its head slot RETAINS) and
/// then into the source's pending queue — the Factorio-style length-as-buffer
/// backpressure the slot model exists for (RESEARCH Pattern 3; the SAME dangling-tail
/// shape `belt_per_tile`'s fold-level proptest certifies, explicitly a blocked downstream
/// TAIL and NOT a stalled machine whose inbox is unbounded). A standalone tick-0
/// `EditOp::DrawBelt` grafts a 3-tile straight DRAWN belt to exercise `fold_draw_belt` +
/// the unified tile-cell occupancy claim inside the frozen snapshot. 12 items are fired
/// into the source at tick 0 (> the 9-slot combined capacity), so the fixture is driven
/// past steady state with `beltA`'s head bunched + a source backlog; the bunching is
/// visible as many distinct per-tick blake3 hashes (the PRIMARY assertion). Purely
/// additive (0001-0011 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0012-draw-belt-flow"]
fn gen_0012_draw_belt_flow() {
    const SEED: u64 = 0x0012_B017;
    // Genesis: s -> beltA(2 tiles) -> beltB(1 tile, DANGLING head = permanently full tail).
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let belt_a = core.state.add_belt(2);
    let belt_b = core.state.add_belt(1);
    core.state.link((s, 0), (belt_a, 0));
    core.state.link((belt_a, 0), (belt_b, 0));
    // NB: NO link from (belt_b, 0) — beltB's head dangles, so the chain never delivers and
    // bunches backward (the belt->belt backpressure proof, NOT a stalled machine).
    let genesis = snapshot::snapshot(&core);

    // Edit @tick0: graft a standalone 3-tile straight DRAWN belt to exercise
    // fold_draw_belt + the unified tile-cell occupancy claim (frozen in every snapshot).
    let drawn = vec![
        BeltTile::new((20, 20), TileKind::default()),
        BeltTile::new((21, 20), TileKind::default()),
        BeltTile::new((22, 20), TileKind::default()),
    ];
    let edits = vec![edit_record(1, 0, EditOp::DrawBelt { tiles: drawn })];

    // Event-log: 12 items into s at tick 0 (> the 9-slot combined capacity), drained one
    // per tick; the overflow bunches beltA's head + backs up the source.
    let log: Vec<Event> = (0..12u64)
        .map(|i| fire(s, i + 1, 0, Item(vec![(i & 0xFF) as u8])))
        .collect();

    // # THE DRIVE LENGTH IS A BUDGET AND IT STRETCHES WITH THE ADVANCE INTERVAL (SLOT-03)
    //
    // **This was a hardcoded 16 and plan 62-09 caught it by PANICKING.** When the shipped
    // interval moved from the pre-change identity of 1 to 2, the generator-time assertion
    // below failed with "beltA head bunched at steady state" and the fixture could not be
    // re-blessed at all. It was diagnosed rather than absorbed: a probe measured beltA's
    // head first bunching after tick **16** at an interval of 2, while the loop drove only
    // to tick 15. **It missed by exactly one tick.**
    //
    // The cause is the whole point of the phase: at an interval of `n` every transport in
    // this chain takes `n` times as long, so a drive length that does not scale stops
    // reaching the steady state the fixture exists to certify. The old 16 had roughly 2x
    // margin at the identity and NEGATIVE margin at 2.
    //
    // **This is a BUDGET (headroom), not an EXPECTATION, which is why deriving it from the
    // constant is correct here and would be wrong three lines down.** The assertion is
    // "beltA's head is bunched"; that claim is real at every interval and is not derived
    // from anything. What is derived is only how long we drive before making it.
    // `crates/fabrico-scenario`'s `SETTLE` (`64 * DEFAULT_TICKS_PER_SLOT`, plan 62-03)
    // draws exactly this distinction in exactly this phase, and this follows it.
    //
    // **Leaving it at 16 and "fixing" the assertion would have gutted the fixture.** A
    // corpus entry named `draw-belt-flow` whose params advertise belt-to-belt backpressure,
    // frozen at a tick count where the backpressure has not engaged, would still replay to
    // a stable hash forever and would certify nothing. That is the silent failure this
    // budget exists to prevent, and it is the reason the panic was good news.
    const BUNCH_TICKS: u64 = 16 * DEFAULT_TICKS_PER_SLOT.get() as u64;

    // Generator-time sanity (mirrors gen_0006's dead-letter check): fold a FRESH restore
    // of the frozen genesis through both logs and confirm beltA's HEAD slot is occupied
    // (bunched) at steady state — i.e. the belt->belt backpressure actually engaged.
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        check.advance_edits(&edits, &log); // tick 0: all 12 fires + the DrawBelt
        for _ in 1..BUNCH_TICKS {
            check.advance(&[]);
        }
        match check.state.node(belt_a) {
            Some(Node::Belt(b)) => assert!(
                b.slots.first().is_some_and(Option::is_some),
                "beltA head bunched at steady state (belt->belt backpressure engaged)"
            ),
            _ => panic!("beltA must still exist"),
        }
    }

    freeze(
        &Meta {
            scenario_id: "0012-draw-belt-flow",
            builder: "inline s->beltA(2)->beltB(1, DANGLING head = full tail) + tick-0 DrawBelt(3-tile straight) exercising fold_draw_belt",
            seed: SEED,
            params: "length-as-buffer backpressure: beltB head dangles (blocked downstream TAIL, not a stalled machine); 12 items > 9-slot capacity => beltA head bunches + source backlog; + 3-tile drawn belt claims tile cells",
            tick_count: BUNCH_TICKS,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0013 — DELETE-BELT-WITH-IN-FLIGHT-ITEMS / deterministic discard (BELT-08): a DRAWN
/// per-tile belt (real `geometry` + claimed tile cells) carries an in-flight item in its
/// slots when an edit-log `Delete` removes it mid-flow. `remove_node_traces` drops the
/// belt's `slots` (the item goes WITH it — a deterministic discard, NOT a fault) AND frees
/// every claimed `geometry` tile cell from the unified occupancy (11-05), while the fold's
/// AR-3 `sched.remove` forgets the belt's wake — so no item is resurrected, no occupancy
/// ghost survives, and no later tick panics on the dead id. The belt is built like a
/// `fold_draw_belt` belt (geometry SET + `claim_belt_tiles`) so the delete must FREE real
/// occupancy cells (a `Wire`-minted belt's empty geometry would make the free a vacuous
/// no-op, proving nothing). Driven several ticks past the delete to freeze the
/// no-resurrection steady state; the per-tick blake3 manifest is the assertion. Purely
/// additive (0001-0012 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0013-delete-belt-with-items"]
fn gen_0013_delete_belt_with_items() {
    const SEED: u64 = 0x0013_DE17;
    // Genesis: s -> beltA(2 tiles, DRAWN: geometry + claimed cells) -> c.
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let belt_a = core.state.add_belt(2);
    // Make beltA a DRAWN belt (mirror fold_draw_belt: set geometry + claim the tile cells)
    // so the delete must free real occupancy, not a no-op over empty geometry.
    let drawn = vec![
        BeltTile::new((7, 7), TileKind::default()),
        BeltTile::new((8, 7), TileKind::default()),
    ];
    if let Some(Node::Belt(b)) = core.state.node_mut(belt_a) {
        b.geometry = drawn.clone();
    }
    core.state.claim_belt_tiles(belt_a, &drawn);
    let c = core.state.add_source();
    core.state.link((s, 0), (belt_a, 0));
    core.state.link((belt_a, 0), (c, 0));
    let _ = c;
    let genesis = snapshot::snapshot(&core);

    // Event-log: one item into s at tick 0 (rides beltA's 6 slots toward the head).
    let log = vec![fire(s, 1, 0, Item(vec![0xDE]))];
    // Edit-log @tick2: delete beltA while the item is resident in its slots. The cell is
    // the belt's anchor tile (provenance only — the free reads node.geometry, not this cell).
    let edits = vec![edit_record(
        1,
        2,
        EditOp::Delete { node: belt_a, kind: KIND_BELT, cell_x: 7, cell_y: 7, captured: Default::default() },
    )];

    // Generator-time sanity (mirrors gen_0006): the item is resident in beltA's slots
    // BEFORE the delete; AFTER the delete + drive, beltA is GONE, its tile cells are freed
    // (no occupancy ghost), and the item is NOT resurrected (the deterministic discard).
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        check.advance(&[log[0].clone()]); // tick 0
        check.advance(&[]); // tick 1
        let resident_before = match check.state.node(belt_a) {
            Some(Node::Belt(b)) => b.slots.iter().filter(|slot| slot.is_some()).count(),
            _ => 0,
        };
        assert_eq!(resident_before, 1, "the item rides beltA's slots before the delete");
        check.advance_edits(&edits, &[]); // tick 2: apply the Delete
        for _ in 3..8u64 {
            check.advance(&[]);
        }
        assert!(check.state.node(belt_a).is_none(), "beltA is gone after the delete");
        assert!(
            check.state.occupied((7, 7)).is_none() && check.state.occupied((8, 7)).is_none(),
            "beltA's claimed tile cells are freed (no occupancy ghost)"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0013-delete-belt-with-items",
            builder: "inline s->beltA(2, DRAWN geometry+claimed cells)->c + edit-log deleting beltA at tick 2 with an in-flight slot item (BELT-08 deterministic discard)",
            seed: SEED,
            params: "drawn belt carries an in-flight slot item; Delete@tick2 drops items + frees claimed tile cells (no resurrection / no occupancy ghost); driven past the delete",
            tick_count: 8,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0014 — UNDO-DELETE-WITH-DOCKED-BELT (12-05, RESEARCH Pitfall 2): place a port-bearing
/// ROUTER, draw a belt, dock the belt to the router (OFFLOAD, the proven-valid geometry),
/// then DELETE the router (cascade-detaching the docked drawn belt + freeing its tile
/// cells), then UNDO the delete — restoring the machine AND re-drawing + re-docking the
/// belt from the persisted capture ALONE. Built through the REAL command layer
/// (`GridSession`) so the Delete record carries the REAL captured subgraph and the undo
/// group is the REAL frozen inverse (NOT a hand-built empty-capture delete). The frozen
/// per-tick blake3 manifest proves the whole place→draw→dock→delete→undo round-trip
/// replays deterministically; the post-undo tick shows belt count + tile occupancy back
/// to pre-delete. Purely additive (0001-0013 untouched). Driven a few extra ticks past
/// the undo to freeze the settled restored state.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0014-undo-delete-with-docked-belt"]
fn gen_0014_undo_delete_with_docked_belt() {
    const SEED: u64 = 0x0014_DE17;
    // The frozen genesis is the EMPTY grid; the runner restores it and re-folds the
    // session's edit-log (the place/draw/dock/delete + the undo group) to reproduce the
    // exact trajectory the live session folded — byte-identical per-tick hashes.
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    // Drive the REAL command surface to produce the edit-log (real capture + real undo).
    let mut session = GridSession::new(SEED);
    let handle = |s: &GridSession| -> u64 {
        s.view()
            .handle_of(*s.core().last_tick.placed.last().expect("a node was minted"))
            .expect("the minted node got a handle")
    };
    // Port-bearing ROUTER (2×3 exemplar) at (0,0): Out port 1 at world (1,1) facing E.
    // RE-AUTHORED IN 74.1-14: the Router catalog's first Out moved to its middle row
    // (layout ruling 2026-10-04, "Edits keep middle layout"); it was (1,2) and the belt
    // sat at (2,2)->(3,2). The subject (a Delete that captures a docked belt, then its
    // Undo) is unchanged.
    session
        .apply(GridCommand::Place { kind: KIND_ROUTER, cell_x: 0, cell_y: 0 })
        .expect("place the router");
    let r = handle(&session);
    // A 2-tile straight DRAWN belt tail-first at (2,1)->(3,1): tail one step E of the
    // Out port, facing W = opposite(E) → a valid OFFLOAD dock (the undo_inverse_dock geom).
    session
        .apply(GridCommand::DrawBelt { cells: vec![(2, 1), (3, 1)] })
        .expect("draw the belt");
    let b = handle(&session);
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r,
            port: 1,
        })
        .expect("offload-dock the belt tail to the router Out port");

    // Generator-time sanity: the docked subgraph + tile occupancy, then delete, then undo.
    let nodes_pre = session.core().state.node_count();
    assert_eq!(nodes_pre, 2, "router + docked belt before the delete");
    assert!(session.core().state.occupied((2, 1)).is_some(), "belt tile (2,1) claimed");
    assert!(session.core().state.occupied((3, 1)).is_some(), "belt tile (3,1) claimed");

    session
        .apply(GridCommand::Delete { node: r })
        .expect("delete the router (cascade-detaches the belt)");
    assert_eq!(session.core().state.node_count(), 0, "router + belt both removed");
    assert!(session.core().state.occupied((2, 1)).is_none(), "belt tile freed by cascade");
    assert!(session.core().state.occupied((3, 1)).is_none(), "belt tile freed by cascade");

    session.apply(GridCommand::Undo).expect("undo the delete (restore the subgraph)");
    assert_eq!(
        session.core().state.node_count(),
        nodes_pre,
        "undo restored the machine AND the cascade belt (count back to pre-delete)"
    );
    assert!(session.core().state.occupied((2, 1)).is_some(), "belt tile re-claimed by undo");
    assert!(session.core().state.occupied((3, 1)).is_some(), "belt tile re-claimed by undo");

    // The persisted edit-log carries the real-capture Delete + the frozen undo group.
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    assert!(
        edits.iter().any(|r| matches!(&r.op,
            EditOp::Delete { captured, .. } if !captured.belts.is_empty())),
        "a Delete record carries a non-empty real capture"
    );
    // No item-flow events (the docked-belt scenario has no source feeding the belt; the
    // belt-slot in-flight discard on delete is already certified by golden 0013).
    let log: Vec<Event> = Vec::new();

    freeze(
        &Meta {
            scenario_id: "0014-undo-delete-with-docked-belt",
            builder: "GridSession: place ROUTER(2x3) -> DrawBelt[(2,1),(3,1)] -> Dock(Tail->port1) -> Delete(router, REAL capture) -> Undo (restore machine + re-draw/re-dock belt from capture)",
            seed: SEED,
            params: "12-05 delete-undo full-subgraph restore: the Delete record carries the captured footprint+cascade belt; undo re-Places + re-DrawBelts + re-Docks from the capture alone; belt count + tile occupancy return to pre-delete; driven past the undo to settle",
            tick_count: 8,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0015 — UNDO-REDO-EACH-OP (12-06, the phase-closing corpus anchor): exercises an
/// undo+redo round-trip of every undoable op type — Place, Rotate, DrawBelt, and Dock
/// (node→node Wire retired in 17-02) — in ONE scenario, each driven through the REAL
/// command layer (`GridSession`) so
/// the persisted edit-log carries the REAL lineage markers + frozen inverses + re-mint
/// groups. Each op is applied, UNDONE (its frozen inverse folds), then REDONE (re-minted
/// under a fresh slotmap id — the accepted FLAG). The frozen per-tick blake3 manifest
/// proves the WHOLE undo-vocabulary round-trips deterministically: a fixed edit-log
/// replays FORWARD to the same hash on every OS (SC#3). Functionally each op returns to
/// its post-apply topology (id labels differ — the FLAG). Purely additive — 0001-0014 are
/// untouched and stay byte-identical. Driven a few extra ticks past the last redo to
/// freeze the settled state.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0015-undo-redo-each-op"]
fn gen_0015_undo_redo_each_op() {
    const SEED: u64 = 0x0015_DE17;
    // The frozen genesis is the EMPTY grid; the runner restores it and re-folds the
    // session's edit-log (every op + its undo/redo group) to reproduce the exact
    // trajectory the live session folded — byte-identical per-tick hashes.
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    // Drive the REAL command surface to produce the edit-log (real inverses + re-mints).
    let mut session = GridSession::new(SEED);
    let handle = |s: &GridSession| -> u64 {
        s.view()
            .handle_of(*s.core().last_tick.placed.last().expect("a node was minted"))
            .expect("the minted node got a handle")
    };

    // --- PLACE: place a SOURCE, undo it (removed), redo it (re-minted). ---
    session
        .apply(GridCommand::Place { kind: KIND_SOURCE, cell_x: 10, cell_y: 0 })
        .expect("place the source");
    session.apply(GridCommand::Undo).expect("undo the place");
    session.apply(GridCommand::Redo).expect("redo the place (re-mint)");

    // --- ROTATE: place a ROUTER (fixture), rotate CW, undo (rot0 restored), redo (rot1). ---
    session
        .apply(GridCommand::Place { kind: KIND_ROUTER, cell_x: 0, cell_y: 0 })
        .expect("place the rotate-fixture router");
    let r_rot = handle(&session);
    session
        .apply(GridCommand::Rotate { node: r_rot, ccw: false })
        .expect("rotate the router CW");
    session.apply(GridCommand::Undo).expect("undo the rotate");
    session.apply(GridCommand::Redo).expect("redo the rotate");

    // --- DRAWBELT + DOCK: a fresh ROUTER(20,0) dock target; its Out port 1 is at world
    //     (21,1) facing E (the middle row since 74.1-14; it was (21,2) with the belt at
    //     (22,2)->(23,2)), so a belt drawn tail-first at (22,1)->(23,1) presents its tail
    //     one step E of the port (facing W = opposite) for a valid OFFLOAD dock. ---
    session
        .apply(GridCommand::Place { kind: KIND_ROUTER, cell_x: 20, cell_y: 0 })
        .expect("place the dock-fixture router");
    let r_dock = handle(&session);
    session
        .apply(GridCommand::DrawBelt { cells: vec![(22, 1), (23, 1)] })
        .expect("draw the belt");
    session.apply(GridCommand::Undo).expect("undo the drawbelt");
    session.apply(GridCommand::Redo).expect("redo the drawbelt (re-mint)");
    let b = handle(&session);
    session
        .apply(GridCommand::Dock {
            belt: b,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: r_dock,
            port: 1,
        })
        .expect("offload-dock the belt tail to the router Out port");
    session.apply(GridCommand::Undo).expect("undo the dock (unlink)");
    session.apply(GridCommand::Redo).expect("redo the dock (re-link)");

    // (Post-Wire-removal: the old WIRE undo/redo leg is GONE — node→node Wire no longer
    // exists as an op. The belt-minting + dock vocabulary is fully covered by the
    // DrawBelt+Dock leg above; belts now come ONLY from DrawBelt.)

    // Generator-time sanity: every op's redo left its live topology in place. Three
    // machines (1 source + 2 routers) + one belt (the drawn belt) = 4.
    assert_eq!(session.core().state.node_count(), 4, "all op redos left their nodes live");
    assert!(session.core().state.occupied((10, 0)).is_some(), "redone PLACE source live");
    assert!(session.core().state.occupied((22, 1)).is_some(), "redone DrawBelt tile live");
    assert!(session.core().state.occupied((23, 1)).is_some(), "redone DrawBelt tile live");

    // The persisted edit-log carries real Undo + Redo lineage markers (the undo vocabulary).
    assert!(
        session.edit_log().iter().any(|r| matches!(&r.op, EditOp::Undo { .. })),
        "the log carries at least one real Undo marker"
    );
    assert!(
        session.edit_log().iter().any(|r| matches!(&r.op, EditOp::Redo { .. })),
        "the log carries at least one real Redo marker"
    );

    // Freeze the WHOLE trajectory + a few settle ticks past the last redo.
    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    // No item-flow events: this fixture certifies the undo/redo TOPOLOGY vocabulary,
    // not item transport (belt transport is already certified by 0001/0012/0013).
    let log: Vec<Event> = Vec::new();

    freeze(
        &Meta {
            scenario_id: "0015-undo-redo-each-op",
            builder: "GridSession: Place(undo/redo) + Rotate(undo/redo) + DrawBelt(undo/redo) + Dock(undo/redo) — undo+redo of every undoable op type (Wire retired 17-02), real inverses + re-mints",
            seed: SEED,
            params: "12-06 undo-vocabulary corpus anchor: each op is applied -> undone (frozen inverse) -> redone (re-minted under a fresh slotmap id, the accepted FLAG); the fixed edit-log replays forward to the same per-tick hash (SC#3) on every OS",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0016 — FACTORY 3×3 + FAULT-DOCK (CAT-01/CAT-02/DET-05, the new-model corpus anchor
/// for the reconciled fault port). A 3×3 FACTORY is placed via the REAL command layer
/// (`GridSession`), a 1-tile belt is drawn on the fault nub's facing cell (1,3), and its
/// TAIL is OFFLOAD-docked to the fault port BY ITS SPATIAL INDEX (2). 17-04's Option-A
/// reconciliation spatially validates the fault dock exactly like an `Out` dock and
/// RESOLVES the frozen `EditOp::Dock.port` to `FAULT_PORT` (`u16::MAX`) — so the dock
/// link key equals the factory's fault-EMIT key `(factory, FAULT_PORT)` (a faulted item
/// would actually ride the docked belt). The empty-event fixture freezes the docked-fault
/// TOPOLOGY at rest and re-proves it snapshots + replays byte-identically at schema 7 on
/// every OS. Purely additive (0001-0015 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0016-factory-3x3-fault-dock"]
fn gen_0016_factory_3x3_fault_dock() {
    const SEED: u64 = 0x0016_FA17;
    // The frozen genesis is the EMPTY grid; the runner restores it and re-folds the
    // session's edit-log (Place FACTORY + DrawBelt + fault Dock) to reproduce the exact
    // trajectory — byte-identical per-tick hashes.
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    // FACTORY 3×3 at (0,0): body (0,0)..=(2,2); the Fault nub world-cell is (1,2) facing
    // S, so its facing cell (one step S) is (1,3).
    session
        .apply(GridCommand::Place { kind: KIND_FACTORY, cell_x: 0, cell_y: 0 })
        .expect("place the factory");
    let fac_id = *session.core().last_tick.placed.last().expect("factory minted");
    let fac_h = session.view().handle_of(fac_id).expect("factory got a handle");
    // A 1-tile belt on the fault nub's facing cell (1,3): a facing-adjacent Tail dock.
    session
        .apply(GridCommand::DrawBelt { cells: vec![(1, 3)] })
        .expect("draw the fault belt");
    let belt_id = *session.core().last_tick.placed.last().expect("belt minted");
    let belt_h = session.view().handle_of(belt_id).expect("belt got a handle");
    // Dock the belt TAIL to the fault port by its SPATIAL INDEX (2); 17-04 resolves the
    // link key to FAULT_PORT.
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: fac_h,
            port: 2,
        })
        .expect("offload-dock the belt tail to the factory Fault port");

    // Generator-time sanity: the dock is keyed on FAULT_PORT (the fault-emit key), NOT
    // the bare spatial index 2 — the DET-05 reconciliation contract.
    assert_eq!(
        session.core().state.link_target((fac_id, FAULT_PORT)),
        Some((belt_id, 0)),
        "the fault dock keys on FAULT_PORT == the fault-emit key (Option A)"
    );
    assert_eq!(
        session.core().state.link_target((fac_id, 2)),
        None,
        "the dock link is resolved to FAULT_PORT, not left on the spatial index"
    );

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0016-factory-3x3-fault-dock",
            builder: "GridSession: Place FACTORY(3x3) + DrawBelt[(1,3)] + Dock(Tail->fault port 2 -> resolved FAULT_PORT) — the reconciled Role::Fault<->FAULT_PORT dock (CAT-02/DET-05)",
            seed: SEED,
            params: "3x3 factory @(0,0); fault nub world (1,2) S, facing (1,3); belt tail OFFLOAD-docked by spatial index 2, link key resolved to FAULT_PORT; docked-fault topology at rest, round-trips at schema 7",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0017 — ROTATE-RE-ROUTE SELECTIVE DE-DOCK, BOTH-ENDS LANDMINE (CAT-06 / 17-05
/// Pitfall 1). A single belt is docked at BOTH ends to ONE machine — its TAIL
/// OFFLOAD-docked to the machine's `Out0` port and its HEAD LOAD-docked to the machine's
/// `In0` port — and the machine is rotated once. Because the selective-de-dock evaluates
/// each DIRECTED DOCK independently (iterating raw `links`, NOT deduped belt ids), the
/// two ends get INDEPENDENT verdicts: after the +1 quarter-turn the Tail still faces
/// `Out0`'s new world cell (KEPT) while the Head no longer faces `In0`'s (UNLINKED). The
/// belt NODE SURVIVES disconnected (NO `remove_node`, NO `sched.remove`), `last_tick.unlinked`
/// records the one dropped Head dock, and the KEPT Tail link is intact. Hand-built genesis
/// (the both-ends dock geometry is deliberately crafted; the core does not yet organically
/// mint a self-docked belt). Purely additive (0001-0016 untouched).
///
/// Geometry (BALANCER 2×2 @ (5,5)): `Out0` local (1,0)/E, `In0` local (0,0)/W. Under
/// rot 1 `port_world` puts `Out0` at world (6,6) facing S (facing cell (6,7)) and `In0`
/// at world (6,5) facing N (facing cell (6,4)). The belt is drawn tail-first
/// (6,7)->(6,8)->(6,9): its Tail (6,7) lands EXACTLY on `Out0`'s rot-1 facing cell with
/// outward N == opposite(S) (KEPT); its Head (6,9) is nowhere near `In0`'s facing cell
/// (6,4) (UNLINKED).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0017-rotate-re-route-dedock"]
fn gen_0017_rotate_re_route_dedock() {
    const SEED: u64 = 0x0017_DED0;
    // Hand-built genesis: a BALANCER 2×2 @ (5,5) with real catalog ports + a belt (real
    // 3-tile geometry) docked at BOTH ends to the machine.
    let mut core = Core::genesis(header(SEED));
    let m = core.state.add_balancer(2);
    core.state.claim_footprint(m, (5, 5), 2, 2, 0);
    // BALANCER catalog ports (idx 0/1 = In on W; idx 2/3 = Out on E).
    core.state.set_ports(
        m,
        vec![
            Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
            Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
            Port { local_offset: (1, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
            Port { local_offset: (1, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
        ],
    );
    // A 3-tile drawn belt (real geometry, tail-first): tail (6,7) -> (6,9) head.
    let belt_tiles = vec![
        BeltTile::new((6, 7), TileKind::default()),
        BeltTile::new((6, 8), TileKind::default()),
        BeltTile::new((6, 9), TileKind::default()),
    ];
    let belt = core.state.add_belt(belt_tiles.len() as u32);
    if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
        b.geometry = belt_tiles.clone();
    }
    core.state.claim_belt_tiles(belt, &belt_tiles);
    // Dock BOTH ends to M. A Tail (offload) link key lives in the Out ROUTING
    // keyspace — the 0-based index among Role::Out ports (Phase 20 Finding 1; machines
    // emit on 0..n-outs and `dock_still_reaches` resolves Tail keys via a Role::Out
    // filtered nth()): Out0 (catalog idx 2) routes as 0 => link (m,0)->(belt,0).
    // A Head (load) key stays the raw catalog index (In ports come first): In0
    // (port 0) => link (belt,0)->(m,0).
    core.state.link((m, 0), (belt, 0));
    core.state.link((belt, 0), (m, 0));
    let genesis = snapshot::snapshot(&core);

    // Edit-log: one +1 quarter-turn (rot 0 -> 1). M's id is deterministic (m, belt).
    let edits = vec![edit_record(1, 0, EditOp::Rotate { node: m, new_rot: 1, old_rot: 0 })];
    let log: Vec<Event> = Vec::new();

    // Generator-time sanity: the both-ends landmine — exactly ONE dock (the Head) is
    // de-docked, the belt SURVIVES, and the KEPT Tail link is intact.
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        check.advance_edits(&edits, &[]);
        assert!(
            matches!(check.state.node(belt), Some(Node::Belt(_))),
            "the belt node SURVIVES the rotate (selective de-dock never removes it)"
        );
        assert_eq!(
            check.last_tick.unlinked.len(),
            1,
            "exactly ONE dock de-docks (the two ends got INDEPENDENT verdicts)"
        );
        assert_eq!(
            check.last_tick.unlinked[0].endpoint,
            BeltEnd::Head,
            "the Head dock (to In0) is the one that de-docks"
        );
        assert_eq!(
            check.state.link_target((m, 0)),
            Some((belt, 0)),
            "the Tail dock (to Out0, routing key 0) is KEPT — it still faces the port's new world cell"
        );
        assert_eq!(
            check.state.link_target((belt, 0)),
            None,
            "the Head dock (to In0) is UNLINKED — it no longer faces the port"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0017-rotate-re-route-dedock",
            builder: "inline BALANCER(2x2)@(5,5) + a belt docked BOTH ends (Tail->Out0, Head->In0) + edit-log Rotate +1 (CAT-06 selective de-dock, both-ends landmine)",
            seed: SEED,
            params: "rot 0->1 spins Out0 to face the belt Tail (KEPT) but In0 away from the belt Head (UNLINKED); belt SURVIVES; last_tick.unlinked records exactly the Head dock",
            tick_count: 3,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0018 — WIRE-REMOVED DEFAULT MODEL: DrawBelt + Dock (CLEAN-01 / CAT-04, the corpus
/// anchor for the post-Wire topology). A `source -> belt -> sink` graph built the ONLY
/// way belts now exist — a drawn 2-tile belt whose TAIL OFFLOAD-docks the SOURCE's `Out`
/// and whose HEAD LOAD-docks the SINK's `In` — driven through the REAL command layer
/// (`GridSession`), with NO `Wire` command anywhere. Freezes the docked topology at rest
/// and re-proves it snapshots + replays byte-identically at schema 7 on every OS — the
/// determinism anchor that the node→node Wire fiction is gone and belts carry real
/// geometry. Purely additive (0001-0017 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0018-wire-removed-drawbelt-dock"]
fn gen_0018_wire_removed_drawbelt_dock() {
    const SEED: u64 = 0x0018_DB17;
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    // SOURCE @ (0,0): Out world (0,0) faces E -> facing cell (1,0).
    session
        .apply(GridCommand::Place { kind: KIND_SOURCE, cell_x: 0, cell_y: 0 })
        .expect("place the source");
    let src_id = *session.core().last_tick.placed.last().expect("source minted");
    let src_h = session.view().handle_of(src_id).expect("source got a handle");
    // SINK @ (3,0): In world (3,0) faces W -> facing cell (2,0).
    session
        .apply(GridCommand::Place { kind: KIND_SINK, cell_x: 3, cell_y: 0 })
        .expect("place the sink");
    let snk_id = *session.core().last_tick.placed.last().expect("sink minted");
    let snk_h = session.view().handle_of(snk_id).expect("sink got a handle");
    // A 2-tile drawn belt (1,0)->(2,0): tail (1,0) one step E of the source Out (outward
    // W == opposite E), head (2,0) one step W of the sink In (outward E == opposite W).
    session
        .apply(GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0)] })
        .expect("draw the belt");
    let belt_id = *session.core().last_tick.placed.last().expect("belt minted");
    let belt_h = session.view().handle_of(belt_id).expect("belt got a handle");
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: src_h,
            port: 0,
        })
        .expect("offload-dock the belt tail to the source Out");
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: fabrico_protocol::BeltEnd::Head,
            node: snk_h,
            port: 0,
        })
        .expect("load-dock the belt head to the sink In");

    // Generator-time sanity: the source->belt->sink directed path exists (no Wire).
    assert_eq!(session.core().state.node_count(), 3, "source + belt + sink");
    assert_eq!(
        session.core().state.link_target((src_id, 0)),
        Some((belt_id, 0)),
        "source Out feeds the belt tail (Tail OFFLOAD dock)"
    );
    assert_eq!(
        session.core().state.link_target((belt_id, 0)),
        Some((snk_id, 0)),
        "belt head delivers into the sink In (Head LOAD dock)"
    );

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0018-wire-removed-drawbelt-dock",
            builder: "GridSession: Place SOURCE + Place SINK + DrawBelt[(1,0),(2,0)] + Dock(Tail->source Out) + Dock(Head->sink In) — the post-Wire default model (belts only from DrawBelt)",
            seed: SEED,
            params: "source@(0,0) --belt(1,0)-(2,0)--> sink@(3,0); NO Wire command; docked topology at rest, round-trips at schema 7 (CLEAN-01/CAT-04)",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

// ---------------------------------------------------------------------------
// Phase 36 ADDITIVE port-edit fixtures (PORT-07). Registered LAST in the CORPUS
// table (0001-0018 frozen v6.0 corpus UNTOUCHED — NO re-bless, NO version bump).
// Each drives the REAL command layer (`GridSession`) over a seeded Router PRESET
// (1-in/3-out, footprint 2×3 - the ROUTE-06 base, whose Out count is ROUTER_OUT_ARITY
// since plan 65-05), so `AddPort`/`RemovePort` +
// deterministic footprint-resize + undo replay byte-identically from genesis on
// every platform. `AddPort` wire bytes: role In=0/Out=1/Fault=2, side N=0/E=1/S=2/W=3,
// medium Mechanical=0/Electrical=1 (since 74.1-16 the fold seats an added port on the
// first free slot of its role and moves no existing port, deterministically).
// ---------------------------------------------------------------------------

/// 0019 — ADD-REMOVE-PORT ROUTER PRESET (PORT-07, the port-edit corpus anchor): an
/// Item Router (`Medium::Mechanical`) PRESET (1-in/3-out, footprint 2×3) has two `Out`
/// ports ADDED (footprint grows 2×3 → 2×5 at 5 outputs - the `grow_to_fit` min-rect
/// rule) then both `RemovePort`ed back. RE-AUTHORED BY 74.1-16 (design ruling of
/// 2026-10-04): until then the removals FLOORED the footprint back to the 2×3 base; a
/// removal now never shrinks the machine, so the box stays 2×5 and only the port list
/// returns to 1-in/3-out. Driven through the REAL command layer so the persisted edit-log
/// carries the real `EditOp::AddPort`/`RemovePort` records; the runner restores the
/// genesis snapshot and re-folds them to reproduce the exact trajectory — byte-identical
/// per-tick hashes. Re-proves the add/remove-port footprint-resize replays from genesis
/// on every OS. Purely additive (0001-0018 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0019-add-remove-port-router-preset"]
fn gen_0019_add_remove_port_router_preset() {
    const SEED: u64 = 0x0019_B017;
    // The frozen genesis is the EMPTY grid; the runner restores it and re-folds the
    // session's edit-log (the preset seeding + the AddPort/RemovePort edits) to reproduce
    // the exact trajectory the live session folded — byte-identical per-tick hashes.
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    // Item Router (Mechanical) PRESET at (0,0): a 1-in/3-out Node::Router, footprint 2×3
    // (the ROUTE-06 base - its ports already sit at their reseat-canonical slots; the Out
    // count is ROUTER_OUT_ARITY, which `place_router_preset` seeds since plan 65-05).
    session
        .place_router_preset(Medium::Mechanical, 0, 0)
        .expect("place the Item Router preset");
    let r_id = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    let r_h = session.view().handle_of(r_id).expect("router got a handle");

    // Preset base: 1-in/3-out, footprint 2×3 (3 outputs still fit the frozen base height).
    let ports_preset = session.core().state.ports_of(r_id).expect("preset ports").to_vec();
    assert_eq!(ports_preset.iter().filter(|p| p.role == Role::In).count(), 1, "preset is 1-in");
    assert_eq!(ports_preset.iter().filter(|p| p.role == Role::Out).count(), 3, "preset is 3-out");
    assert_eq!(
        session.core().state.footprint_of(r_id),
        Some(Footprint { w: 2, h: 3, rot: 0 }),
        "the 1-in/3-out preset floors at the frozen Router base 2×3"
    );

    // ADD two Mechanical `Out` ports (role Out=1, side E=1, medium Mechanical=0) → 1-in/5-out.
    // At 5 outputs the min-rect grows the height above the 2×3 base to 2×5.
    for _ in 0..2 {
        session
            .apply(GridCommand::AddPort { node: r_h, role: 1, side: 1, medium: 0 })
            .expect("add an Out port");
    }
    assert_eq!(
        session.core().state.ports_of(r_id).expect("grown ports").iter().filter(|p| p.role == Role::Out).count(),
        5,
        "two AddPort Out edits grew the router to 1-in/5-out"
    );
    assert_eq!(
        session.core().state.footprint_of(r_id),
        Some(Footprint { w: 2, h: 5, rot: 0 }),
        "5 outputs grow the footprint 2×3 → 2×5 (grow_to_fit min-rect)"
    );

    // REMOVE both back (highest index FIRST so lower indices stay valid) → 1-in/3-out.
    // 74.1-16: the footprint STAYS 2×5, because a removal never shrinks the machine.
    for _ in 0..2 {
        let last = session.core().state.ports_of(r_id).expect("ports").len() - 1;
        session
            .apply(GridCommand::RemovePort { node: r_h, index: last as u16 })
            .expect("remove the last Out port");
    }
    let ports_final = session.core().state.ports_of(r_id).expect("final ports").to_vec();
    assert_eq!(ports_final.iter().filter(|p| p.role == Role::In).count(), 1, "back to 1-in");
    assert_eq!(ports_final.iter().filter(|p| p.role == Role::Out).count(), 3, "back to 3-out");
    assert_eq!(
        session.core().state.footprint_of(r_id),
        Some(Footprint { w: 2, h: 5, rot: 0 }),
        "removing both Out ports keeps the 2×5 box (74.1-16: a removal never shrinks)"
    );
    // The persisted edit-log carries the real AddPort + RemovePort records.
    assert!(
        session.edit_log().iter().any(|r| matches!(&r.op, EditOp::AddPort { .. })),
        "the edit-log carries at least one real AddPort record"
    );
    assert!(
        session.edit_log().iter().any(|r| matches!(&r.op, EditOp::RemovePort { .. })),
        "the edit-log carries at least one real RemovePort record"
    );

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    // No item-flow events: this fixture certifies the port-edit + footprint-resize
    // TOPOLOGY vocabulary, not item transport (belt transport is certified by 0001/0012).
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0019-add-remove-port-router-preset",
            builder: "GridSession: place_router_preset(Mechanical) [1-in/3-out + Mechanical Fault, 2x3] + AddPort Out x2 (grows to 1-in/5-out, 2x5) + RemovePort x2 (back to 1-in/3-out, box stays 2x5 since 74.1-16)",
            seed: SEED,
            params: "PORT-07 add/remove-port footprint-resize: two Out ports added (2x3 -> 2x5 at 5 outputs, grow_to_fit min-rect) then removed back (since 74.1-16 a removal never shrinks the machine, so the box stays 2x5); replays byte-identical from genesis on every OS",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0020 — FOOTPRINT-RESIZE REPLAY (PORT-07): an HTTP Router (`Medium::Electrical`) PRESET
/// (1-in/3-out, footprint 2×3) is GROWN by four `Out` ports (footprint 2×3 → 2×7 - the
/// min-rect stacks outputs down the E column) then four `RemovePort`s take the added
/// ports off again. RE-AUTHORED BY 74.1-16: until then the removals FLOORED the box back
/// to the frozen 2×3 base; a removal now never shrinks the machine (design ruling of
/// 2026-10-04), so the box stays 2×7. The resize is a pure function of the edit records, so
/// the snapshot the runner restores at genesis + the re-folded edit-log reproduce every
/// intermediate footprint byte-identically (snapshot/restore round-trips the resized
/// machine). Purely additive (0001-0019 untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0020-footprint-resize-replay"]
fn gen_0020_footprint_resize_replay() {
    const SEED: u64 = 0x0020_B017;
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    // HTTP Router (Electrical) PRESET at (0,0): 1-in/3-out, footprint 2×3 (the Out count is
    // ROUTER_OUT_ARITY, seeded by `place_router_preset` since plan 65-05).
    session
        .place_router_preset(Medium::Electrical, 0, 0)
        .expect("place the HTTP Router preset");
    let r_id = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    let r_h = session.view().handle_of(r_id).expect("router got a handle");
    assert_eq!(
        session.core().state.footprint_of(r_id),
        Some(Footprint { w: 2, h: 3, rot: 0 }),
        "the HTTP Router preset floors at the frozen Router base 2×3"
    );

    // GROW: add four Electrical `Out` ports (role Out=1, side E=1, medium Electrical=1) →
    // 1-in/7-out; the min-rect stacks 7 outputs down the E column so the height grows to 7.
    for _ in 0..4 {
        session
            .apply(GridCommand::AddPort { node: r_h, role: 1, side: 1, medium: 1 })
            .expect("add an Out port");
    }
    assert_eq!(
        session.core().state.ports_of(r_id).expect("grown ports").iter().filter(|p| p.role == Role::Out).count(),
        7,
        "four AddPort Out edits grew the router to 1-in/7-out"
    );
    assert_eq!(
        session.core().state.footprint_of(r_id),
        Some(Footprint { w: 2, h: 7, rot: 0 }),
        "7 outputs grow the footprint 2×3 → 2×7 (grow_to_fit min-rect)"
    );

    // REMOVE all four added Out ports (highest index first) → back to 1-in/3-out; since
    // 74.1-16 the footprint stays 2×7 (a removal never shrinks).
    for _ in 0..4 {
        let last = session.core().state.ports_of(r_id).expect("ports").len() - 1;
        session
            .apply(GridCommand::RemovePort { node: r_h, index: last as u16 })
            .expect("remove the last Out port");
    }
    assert_eq!(
        session.core().state.ports_of(r_id).expect("floored ports").iter().filter(|p| p.role == Role::Out).count(),
        3,
        "removing the four added Out ports returns the router to 1-in/3-out"
    );
    assert_eq!(
        session.core().state.footprint_of(r_id),
        Some(Footprint { w: 2, h: 7, rot: 0 }),
        "the footprint stays 2×7 (74.1-16: a removal never shrinks the machine)"
    );

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0020-footprint-resize-replay",
            builder: "GridSession: place_router_preset(Electrical) [1-in/3-out + Mechanical Fault, 2x3] + AddPort Out x4 (grows to 1-in/7-out, 2x7) + RemovePort x4 (back to 1-in/3-out, box stays 2x7 since 74.1-16)",
            seed: SEED,
            params: "PORT-07 footprint-resize replay: the resize is a pure fn of the edit records; the genesis snapshot + re-folded edit-log reproduce every intermediate footprint (2x3 -> 2x7, kept at 2x7 by the removals since 74.1-16) byte-identically on every OS (snapshot/restore round-trips the resized machine)",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0021 — UNDO-PORT-EDIT SURVIVES SAVE/LOAD (PORT-07 / UNDO-03 durability): a port edit
/// (`AddPort`) and its inverse (`RemovePort`) are each UNDONE on an Item Router
/// (`Medium::Mechanical`) PRESET whose ports already sit at their reseat-canonical slots,
/// so each undo returns the machine to its prior 1-in/3-out shape. Driven through the REAL
/// command layer so the persisted edit-log carries the real `Undo` markers + retargeted
/// inverses; the runner restores the genesis snapshot (the SAVE/LOAD boundary) and re-folds
/// the WHOLE edit-log FORWARD — reproducing a byte-equal core hash AND projection at every
/// tick (the UNDO-03 "undo survives save/load" property). Purely additive (0001-0020
/// untouched).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0021-undo-port-edit-survives-save-load"]
fn gen_0021_undo_port_edit_survives_save_load() {
    const SEED: u64 = 0x0021_B017;
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    // Item Router (Mechanical) PRESET at (0,0): 1-in/3-out, footprint 2×3. The preset was
    // itself seeded via AddPort/RemovePort, so its ports are reseat-canonical → a port edit
    // + Undo returns to the exact prior port list.
    session
        .place_router_preset(Medium::Mechanical, 0, 0)
        .expect("place the Item Router preset");
    let r_id = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    let r_h = session.view().handle_of(r_id).expect("router got a handle");
    let out_preset = session.core().state.ports_of(r_id).expect("preset ports")
        .iter().filter(|p| p.role == Role::Out).count();
    assert_eq!(out_preset, 3, "preset is 1-in/3-out");

    // AddPort Out → 1-in/4-out, then UNDO the AddPort → back to 1-in/3-out.
    session
        .apply(GridCommand::AddPort { node: r_h, role: 1, side: 1, medium: 0 })
        .expect("add an Out port");
    assert_eq!(
        session.core().state.ports_of(r_id).expect("post-add ports").iter().filter(|p| p.role == Role::Out).count(),
        4,
        "the AddPort took the router to 1-in/4-out"
    );
    session.apply(GridCommand::Undo).expect("undo the AddPort");
    assert_eq!(
        session.core().state.ports_of(r_id).expect("post-undo-add ports").iter().filter(|p| p.role == Role::Out).count(),
        3,
        "undoing the AddPort restored 1-in/3-out"
    );

    // RemovePort (the last Out) → 1-in/2-out, then UNDO the RemovePort → back to 1-in/3-out
    // (the inverse re-adds the captured Port). Since plan 85-05 (D-22) the preset carries
    // its Fault LAST, so the last Out is found by role rather than taken as the last index.
    let last = session
        .core()
        .state
        .ports_of(r_id)
        .expect("ports")
        .iter()
        .rposition(|p| p.role == Role::Out)
        .expect("the preset has an Out");
    session
        .apply(GridCommand::RemovePort { node: r_h, index: last as u16 })
        .expect("remove the last Out port");
    assert_eq!(
        session.core().state.ports_of(r_id).expect("post-remove ports").iter().filter(|p| p.role == Role::Out).count(),
        2,
        "the RemovePort took the router to 1-in/2-out"
    );
    session.apply(GridCommand::Undo).expect("undo the RemovePort");
    let out_final = session.core().state.ports_of(r_id).expect("final ports")
        .iter().filter(|p| p.role == Role::Out).count();
    assert_eq!(out_final, 3, "undoing the RemovePort restored 1-in/3-out (inverse re-adds the port)");
    assert_eq!(
        session.core().state.footprint_of(r_id),
        Some(Footprint { w: 2, h: 3, rot: 0 }),
        "the router is back at its 1-in/3-out preset footprint 2×3"
    );

    // The persisted edit-log carries real Undo markers over the port edits (durability).
    assert!(
        session.edit_log().iter().any(|r| matches!(&r.op, EditOp::Undo { .. })),
        "the edit-log carries at least one real Undo marker"
    );
    assert!(
        session.edit_log().iter().any(|r| matches!(&r.op, EditOp::AddPort { .. })),
        "the edit-log carries the AddPort edit that was undone"
    );
    assert!(
        session.edit_log().iter().any(|r| matches!(&r.op, EditOp::RemovePort { .. })),
        "the edit-log carries the RemovePort edit that was undone"
    );

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0021-undo-port-edit-survives-save-load",
            builder: "GridSession: place_router_preset(Mechanical) [1-in/3-out + Mechanical Fault] + AddPort Out + Undo + RemovePort + Undo - a port edit and its inverse each undone, back to the preset",
            seed: SEED,
            params: "PORT-07/UNDO-03 durability: the genesis snapshot is the save/load boundary; re-folding the whole edit-log FORWARD (AddPort+Undo, RemovePort+Undo) reproduces a byte-equal core hash AND projection at every tick on every OS (undo survives save/load)",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// The genesis Factory source: the minimal passthrough that emits its input unchanged
/// on port 0 (a verbatim copy of `tick::DEFAULT_FACTORY_SOURCE`, which is crate-private
/// so it is re-declared here — the fixture only needs an identical seed source).
const PASSTHROUGH_FACTORY_JS: &str =
    "export default function (input, ctx) { ctx.emit(0, input); }";

/// The NEW Factory source a `Configure` swaps in — DOUBLES its numeric input, so its
/// output (`42` for input `21`) is DISTINCT from the passthrough's (`21`). The distinct
/// output is what makes the eviction landmine visible in the frozen per-tick hashes.
const DOUBLING_FACTORY_JS: &str =
    "export default function (input, ctx) { ctx.emit(0, input * 2); }";

/// 0027 — CONFIGURE FACTORY SOURCE-SWAP (CFG-02, the config-determinism corpus anchor):
/// `source -> factory -> collector`. An item fires through the factory under its ORIGINAL
/// passthrough source (building + caching the compiled engine), THEN a logged `Configure`
/// edit swaps the factory's `source` to a doubling handler AND evicts the NodeId-keyed
/// runtime cache, THEN a second item fires through the factory — emitting the DOUBLED
/// value only because the stale engine was evicted and rebuilt from the new source
/// (threat T-39-STALE-JS). The frozen per-tick blake3 manifest re-proves the whole
/// source-swap replays byte-identically on every OS, with the NEW handler's output baked
/// into the post-Configure hashes (a behavioral eviction proof, stronger than a
/// state-field diff). Purely additive (0001-0026 untouched); NO version bump.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0027-configure-factory-source-swap"]
fn gen_0027_configure_factory_source_swap() {
    const SEED: u64 = 0x0027_C0F6;
    // Genesis: source -> factory(passthrough) -> collector (instant links; the collector
    // is a Source that ignores its inbox, so delivered items rest there for inspection).
    let (core, s, f, c) = source_factory_collector(SEED, PASSTHROUGH_FACTORY_JS);
    let genesis = snapshot::snapshot(&core);

    // Edit-log @tick1: Configure the factory to the doubling source. The code_hash is the
    // REAL blake3 of the new bytes (host-stamped in production; the core stores it opaquely,
    // so replay is byte-identical regardless of its value).
    let code_hash = *blake3::hash(DOUBLING_FACTORY_JS.as_bytes()).as_bytes();
    let edits = vec![edit_record(
        1,
        1,
        EditOp::Configure {
            node: f,
            config: MachineConfig::Factory { source: DOUBLING_FACTORY_JS.to_owned() },
            code_hash,
        },
    )];
    // Event-log: fire `21` through the source BEFORE the swap (tick 0 — builds+caches the
    // passthrough engine, collector gets 21) and AFTER the swap (tick 2 — the evicted cache
    // rebuilds from the doubling source, collector gets 42). The tick-2 emission is the
    // behavioral eviction proof frozen into the hashes.
    let log = vec![
        fire(s, 1, 0, Item(b"21".to_vec())),
        fire(s, 2, 2, Item(b"21".to_vec())),
    ];

    // Generator-time sanity (mirrors gen_0022): a FRESH restore of the frozen genesis folds
    // the Configure + both fires; the factory ends on the NEW source and the collector holds
    // the passthrough output THEN the doubled output (proving the swap + eviction ran).
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        // Drive both logs EDITS-FIRST for enough ticks to cover fire@0, configure@1, fire@2.
        let _ = fold_two_logs_collecting_hashes(&mut check, &edits, &log, 5);
        match check.state.node(f) {
            Some(Node::Factory(fac)) => assert_eq!(
                fac.source, DOUBLING_FACTORY_JS,
                "the Configure swapped Factory.source to the new bytes"
            ),
            other => panic!("expected a Factory, got {other:?}"),
        }
        assert_eq!(
            collector_items(&check, c),
            vec![Item(b"21".to_vec()), Item(b"42".to_vec())],
            "passthrough emitted 21 (pre-swap), then the rebuilt doubling engine emitted 42 \
             (post-swap) — the cache was evicted and rebuilt from the NEW source"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0027-configure-factory-source-swap",
            builder: "inline source -> factory(passthrough) -> collector + edit-log Configure(Factory{doubling}) @tick1; fire 21 @tick0 (pre-swap) and @tick2 (post-swap)",
            seed: SEED,
            params: "CFG-02 config determinism: a logged Configure swaps Factory.source (passthrough -> doubling) and evicts the NodeId-keyed runtime cache; the post-swap fire emits the DOUBLED value only because the stale engine was rebuilt (behavioral eviction proof, T-39-STALE-JS); replays byte-identically",
            tick_count: 5,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// Generator-time measurement: the sim tick on which `collector`'s inbox FIRST holds at
/// least `target` items, or `None` if it never does within `ticks`.
///
/// # Why it re-folds from genesis for every probe length
/// [`fold_two_logs_collecting_hashes`] walks both logs from index 0 and consumes each
/// record when it reaches that record's tick. Calling it repeatedly on ONE core with
/// `ticks = 1` would therefore restart at index 0 against a core whose tick has already
/// moved past the early records, silently dropping every edit and event after the first
/// tick. Re-folding a FRESH `snapshot::restore(genesis)` for each length `n` keeps the
/// measurement on exactly the certified two-log path the runner uses, at the cost of an
/// O(n^2) walk over a corpus-sized tick budget.
///
/// A fold of `n` ticks ends having folded tick `n - 1`, so that is the tick reported.
fn tick_first_reaching_count(
    genesis: &[u8],
    edits: &[EditRecord],
    log: &[Event],
    ticks: u64,
    collector: NodeId,
    target: usize,
) -> Option<u64> {
    for n in 1..=ticks {
        let mut core = snapshot::restore(genesis).expect("genesis blob restores");
        let _ = fold_two_logs_collecting_hashes(&mut core, edits, log, n);
        if collector_count(&core, collector) >= target {
            return Some(n - 1);
        }
    }
    None
}

/// The item both 0028 fires carry, byte-identical. The routing decision has to come from
/// the ROUTER's table and from nothing else, so the two fires cannot differ in any way.
const ROUTED_ITEM: &[u8] = b"A1";

/// 0028 — CONFIGURE ROUTER ROUTING TABLE (ROUTE-03 / THAW-04, the routing-rule corpus
/// anchor): `source -> router -> [collector_0, collector_1, collector_2]`, one distinct
/// collector on each of the router's three `Out` ports.
///
/// The SAME item bytes are fired twice. Under the GENESIS table the matching route sends
/// them to `Out` port 2; a logged `Configure` then installs a NEW routing table in which
/// that same `RouteKey` maps to `Out` port 0, so the second fire lands in a DIFFERENT
/// collector. That behavioural difference is what makes the fixture certify the routing
/// editor rather than merely carry an inert record: the generator-time sanity block below
/// refuses to reach `freeze()` unless the two destinations actually differ, and unless the
/// pre-Configure arrival really did happen before the post-Configure one.
///
/// The installed table is non-degenerate on purpose: two PAIRWISE-DISTINCT `RouteKey`s
/// mapping to two PAIRWISE-DISTINCT `Out` ports, plus a `Some(default)` naming a third
/// `Out` port that no route names, so one record exercises first-match routing AND the
/// "else" fallthrough.
///
/// `code_hash` is `[0u8; 32]`, the documented N/A value for a config carrying no Factory
/// JS. That is not a convenience: `fabrico-command` freezes EVERY `Configure` with a
/// zeroed hash (`command.rs:1480-1491`, the blake3 fence) and the host only ever stamps a
/// real digest onto a `Factory` config (`input_apply::stamp_factory_code_hashes`), so a
/// Router record carrying anything else would not be the record the shipped path emits.
///
/// The topology is built INLINE rather than through a `tests/common/mod.rs` helper
/// (plan 70-03 ruling R-16): `common/mod.rs` is a covered source path under the v9.0
/// declared-moves gate, and a helper added there is a declaration line that outlives this
/// phase. The wiring shape follows `source_tee_collectors` (one distinct collector per
/// output port) rather than `router_dead_letter` (which wires only the fault port).
///
/// Purely additive (0001-0027 untouched); NO version bump.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0028-router-config-replay"]
fn gen_0028_router_config_replay() {
    const SEED: u64 = 0x0028_C0DE;
    /// The router's `Out` port count: three, so the installed table can name two distinct
    /// route targets AND a default that neither of them names.
    const OUT_PORTS: PortId = 3;
    /// Where the GENESIS table sends `ROUTED_ITEM`.
    const PRE_PORT: PortId = 2;
    /// Where the CONFIGURED table sends the identical bytes.
    const POST_PORT: PortId = 0;
    /// The "else" port of the configured table. Named by no route, which is what makes it
    /// a fallthrough rather than a duplicate of one.
    const ELSE_PORT: PortId = 2;
    const FIRE_PRE_TICK: u64 = 0;
    const CONFIGURE_TICK: u64 = 1;
    const FIRE_POST_TICK: u64 = 2;
    const TICKS: u64 = 8;

    // Genesis: source -> router -> one distinct collector per Out port. Each collector is
    // a Source node that ignores its input port, so a routed item RESTS in its inbox and
    // the destination is readable directly.
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let router = core.state.add_router(
        vec![(RouteKey::new(0, ROUTED_ITEM[..1].to_vec()), PRE_PORT)],
        Some(PRE_PORT),
    );
    core.state.link((s, 0), (router, 0));
    let mut collectors: Vec<NodeId> = Vec::new();
    for port in 0..OUT_PORTS {
        let c = core.state.add_source();
        core.state.link((router, port), (c, 0));
        collectors.push(c);
    }
    let genesis = snapshot::snapshot(&core);

    // Edit-log @tick1: install a NEW routing table. The key that used to reach PRE_PORT
    // now reaches POST_PORT; a second, DISTINCT key reaches a second, DISTINCT port; and
    // the default names a third port that neither route names.
    let post_routes: Vec<(RouteKey, PortId)> = vec![
        (RouteKey::new(0, ROUTED_ITEM[..1].to_vec()), POST_PORT),
        (RouteKey::new(0, b"B".to_vec()), 1),
    ];
    let edits = vec![edit_record(
        1,
        CONFIGURE_TICK,
        EditOp::Configure {
            node: router,
            config: MachineConfig::Router {
                routes: post_routes.clone(),
                default: Some(ELSE_PORT),
            },
            // The N/A value: this config carries no Factory JS, and the shipped command
            // path zeroes the hash on every Configure it emits.
            code_hash: [0u8; 32],
        },
    )];

    // Event-log: the SAME bytes before the Configure (tick 0) and after it (tick 2).
    let log = vec![
        fire(s, 1, FIRE_PRE_TICK, Item(ROUTED_ITEM.to_vec())),
        fire(s, 2, FIRE_POST_TICK, Item(ROUTED_ITEM.to_vec())),
    ];

    // Generator-time sanity (mirrors gen_0027): a FRESH restore of the frozen genesis
    // folds the Configure + both fires, and the fixture is NOT frozen unless the same
    // bytes demonstrably left a DIFFERENT Out port after the edit than before it. A
    // fixture whose Configure is inert cannot get past this block, which is what THAW-04
    // requires of it.
    {
        // The routing table on the folded core really is the configured one.
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        let _ = fold_two_logs_collecting_hashes(&mut check, &edits, &log, TICKS);
        match check.state.node(router) {
            Some(Node::Router(r)) => {
                assert_eq!(r.routes, post_routes, "the Configure installed the new table");
                assert_eq!(r.default, Some(ELSE_PORT), "the Configure installed the default");
            }
            other => panic!("expected a Router, got {other:?}"),
        }

        // Exactly two collectors received, one item each, and they are DIFFERENT
        // collectors. The unnamed third receives nothing.
        let landed: Vec<(PortId, Vec<Item>)> = (0..OUT_PORTS)
            .map(|p| (p, collector_items(&check, collectors[usize::from(p)])))
            .collect();
        for (port, items) in &landed {
            let want = usize::from(*port == PRE_PORT || *port == POST_PORT);
            assert_eq!(
                items.len(),
                want,
                "Out port {port} collected {} item(s), expected {want}",
                items.len()
            );
            for item in items {
                assert_eq!(
                    item.0.as_slice(),
                    ROUTED_ITEM,
                    "every collected item is the SAME bytes that were fired"
                );
            }
        }
        assert_ne!(
            PRE_PORT, POST_PORT,
            "the pre- and post-Configure destinations must be DIFFERENT Out ports, or the \
             record this fixture freezes is inert and certifies nothing"
        );

        // ORDERING: the arrival at PRE_PORT really is the pre-Configure fire and the one
        // at POST_PORT really is the post-Configure fire. Without this, two arrivals in
        // two collectors would be equally consistent with a table that never changed and
        // a second item that happened to be routed elsewhere.
        let pre_tick = tick_first_reaching_count(
            &genesis,
            &edits,
            &log,
            TICKS,
            collectors[usize::from(PRE_PORT)],
            1,
        )
        .expect("the pre-Configure fire must arrive within the frozen tick budget");
        let post_tick = tick_first_reaching_count(
            &genesis,
            &edits,
            &log,
            TICKS,
            collectors[usize::from(POST_PORT)],
            1,
        )
        .expect("the post-Configure fire must arrive within the frozen tick budget");
        assert!(
            pre_tick < post_tick,
            "the PRE_PORT arrival (tick {pre_tick}) must precede the POST_PORT arrival \
             (tick {post_tick})"
        );
        assert!(
            post_tick > CONFIGURE_TICK,
            "the POST_PORT arrival (tick {post_tick}) must be strictly after the Configure \
             (tick {CONFIGURE_TICK}), or it cannot have been routed by the new table"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0028-router-config-replay",
            builder: "inline source -> router(3 Out ports) -> one collector per port + edit-log Configure(Router{routes:[(offset 0 'A')->port 0, (offset 0 'B')->port 1], default:Some(port 2)}) @tick1; fire the SAME item 'A1' @tick0 (pre-Configure, routed to port 2) and @tick2 (post-Configure, routed to port 0)",
            seed: SEED,
            params: "ROUTE-03 / THAW-04 routing-table determinism: a logged Configure replaces the router's ordered route table and its default Out port; the SAME item bytes leave a DIFFERENT Out port after the edit than before it, and the frozen per-tick hashes bake that difference in. Routes are pairwise distinct RouteKeys on pairwise distinct Out ports plus a Some(default) naming a port no route names; code_hash is the [0u8;32] N/A value the shipped command path emits for a non-Factory config",
            tick_count: TICKS,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0029 — CONFIGURE BELT PACE (BELT-02 / THAW-05, the per-belt-speed corpus anchor):
/// `source -> belt(1 tile) -> collector`, the belt left at [`DEFAULT_TICKS_PER_SLOT`] in
/// genesis.
///
/// The SAME item bytes traverse the belt twice. A logged `Configure` between the two
/// traversals sets the belt's own advance interval to a `NonZeroU32` that DIFFERS from the
/// default, so the second traversal takes a DIFFERENT number of ticks. Zero is
/// unrepresentable in `NonZeroU32`, so the "empty" case this variant could otherwise carry
/// cannot arise at all.
///
/// The generator-time sanity block measures both traversals and refuses to reach
/// `freeze()` unless they differ, and unless the difference agrees with the traverse-time
/// contract stated in `tests/golden/README.md`, `src/belt_slots.rs` and `src/belt.rs`:
/// `(SLOTS_PER_TILE * tiles - 1) * ticks_per_slot` advance ticks, plus an
/// admission-alignment offset of at most `ticks_per_slot - 1`. The fixed source-step
/// overhead is identical for both traversals and therefore cancels in the difference; only
/// the two alignment offsets survive it.
///
/// `code_hash` is `[0u8; 32]` for the same reason it is on 0028.
///
/// Purely additive (0001-0028 untouched); NO version bump.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0029-belt-pace-replay"]
fn gen_0029_belt_pace_replay() {
    const SEED: u64 = 0x0029_BE17;
    const TILES: u32 = 1;
    /// The configured pace. DIFFERENT from `DEFAULT_TICKS_PER_SLOT` (which is 2) and not
    /// the degenerate every-tick value 1, so the fixture exercises a real modulo interval.
    const NEW_TICKS_PER_SLOT: NonZeroU32 = match NonZeroU32::new(5) {
        Some(n) => n,
        None => panic!("5 is non-zero"),
    };
    const FIRE_PRE_TICK: u64 = 0;
    const CONFIGURE_TICK: u64 = 12;
    const FIRE_POST_TICK: u64 = 15;
    const TICKS: u64 = 44;

    // Genesis: source -> belt(1 tile) -> collector, belt at DEFAULT_TICKS_PER_SLOT.
    let (core, s, c) = source_belt_collector(SEED, TILES);
    let belt = {
        // The belt is the one node between the source and the collector; name it by the
        // link the topology helper drew rather than by an id the helper does not return.
        let (target, _port) = core
            .state
            .link_target((s, 0))
            .expect("the source's output is linked to the belt");
        target
    };
    match core.state.node(belt) {
        Some(Node::Belt(b)) => assert_eq!(
            b.ticks_per_slot, DEFAULT_TICKS_PER_SLOT,
            "genesis leaves the belt at the DEFAULT pace, so the Configure below is the \
             only thing that can change it"
        ),
        other => panic!("expected a Belt between the source and the collector, got {other:?}"),
    }
    let genesis = snapshot::snapshot(&core);

    // Edit-log @tick12: set the belt's own advance interval, well after the first item has
    // finished traversing, so the two traversals never overlap the edit.
    let edits = vec![edit_record(
        1,
        CONFIGURE_TICK,
        EditOp::Configure {
            node: belt,
            config: MachineConfig::Belt {
                ticks_per_slot: NEW_TICKS_PER_SLOT,
            },
            code_hash: [0u8; 32],
        },
    )];

    // Event-log: the SAME bytes before the Configure and after it.
    let log = vec![
        fire(s, 1, FIRE_PRE_TICK, Item(b"pace".to_vec())),
        fire(s, 2, FIRE_POST_TICK, Item(b"pace".to_vec())),
    ];

    // Generator-time sanity: the pace edit landed AND it changed how long the belt takes.
    {
        let mut check = snapshot::restore(&genesis).expect("genesis restores");
        let _ = fold_two_logs_collecting_hashes(&mut check, &edits, &log, TICKS);
        match check.state.node(belt) {
            Some(Node::Belt(b)) => assert_eq!(
                b.ticks_per_slot, NEW_TICKS_PER_SLOT,
                "the Configure wrote the belt's advance interval"
            ),
            other => panic!("expected a Belt, got {other:?}"),
        }
        assert_eq!(
            collector_items(&check, c),
            vec![Item(b"pace".to_vec()), Item(b"pace".to_vec())],
            "both traversals completed inside the frozen tick budget, carrying identical \
             bytes, so the only thing that can differ between them is the belt's pace"
        );

        let pre_arrival = tick_first_reaching_count(&genesis, &edits, &log, TICKS, c, 1)
            .expect("the pre-Configure item must arrive within the frozen tick budget");
        let post_arrival = tick_first_reaching_count(&genesis, &edits, &log, TICKS, c, 2)
            .expect("the post-Configure item must arrive within the frozen tick budget");
        let pre_elapsed = pre_arrival - FIRE_PRE_TICK;
        let post_elapsed = post_arrival - FIRE_POST_TICK;

        assert!(
            pre_arrival < CONFIGURE_TICK,
            "the first traversal (arriving at tick {pre_arrival}) must complete BEFORE the \
             Configure at tick {CONFIGURE_TICK}, or the two traversals share a pace and the \
             measurement below means nothing"
        );

        // The literal THAW-05 reading: the SAME item takes a DIFFERENT number of ticks
        // after the Configure than before it. It is kept, but it is deliberately NOT the
        // load-bearing assertion, and the reason is worth writing down because it is
        // exactly the shape of a check that passes for the wrong reason.
        //
        // The admission-alignment offset is the wait for the first DUE tick after the
        // admit, so it depends on WHEN the item was fired, not only on the interval. Two
        // fires at different ticks can therefore differ by up to `ticks_per_slot - 1`
        // ticks at an IDENTICAL pace. MEASURED, by neutering the Configure to the default
        // value and re-running this generator: `pre_elapsed != post_elapsed` still held.
        // On its own this assertion certifies nothing about the pace.
        assert_ne!(
            pre_elapsed, post_elapsed,
            "the SAME item took {pre_elapsed} tick(s) before the Configure and \
             {post_elapsed} after it"
        );

        // THE LOAD-BEARING COMPARISON: the identical event log folded against an EMPTY
        // edit log. Same genesis, same item bytes, same fire tick, therefore the same
        // admission alignment and the same fixed source-step overhead. The ONLY thing that
        // differs from the run above is the Configure record itself, so a difference here
        // can only be the PACE, and an inert record makes the two equal and reddens.
        let no_edits: Vec<EditRecord> = Vec::new();
        let control_arrival = tick_first_reaching_count(&genesis, &no_edits, &log, TICKS, c, 2)
            .expect(
                "the second item must also arrive within the tick budget with NO edit \
                 applied, or the control fold measures nothing",
            );
        let control_elapsed = control_arrival - FIRE_POST_TICK;
        assert_ne!(
            post_elapsed, control_elapsed,
            "the SAME item fired at the SAME tick took {post_elapsed} tick(s) WITH the \
             Configure and {control_elapsed} WITHOUT it. A Configure that does not move \
             the traverse time is an INERT record and cannot certify THAW-05"
        );

        // The SIZE of that difference, checked against the traverse-time contract rather
        // than against a number typed here. Advances are `SLOTS_PER_TILE * tiles - 1`;
        // each costs `ticks_per_slot` ticks; the alignment offset is bounded by
        // `ticks_per_slot - 1` on each side and is the only term that does not cancel.
        //
        // Signed arithmetic on purpose: an inert or reversed record must reach the NAMED
        // assertion below rather than panicking on an unsigned underflow inside the band
        // computation, which would say nothing about which contract term was violated.
        let advances = i64::from(SLOTS_PER_TILE * TILES - 1);
        let contract_default = advances * i64::from(DEFAULT_TICKS_PER_SLOT.get());
        let contract_new = advances * i64::from(NEW_TICKS_PER_SLOT.get());
        let max_align_default = i64::from(DEFAULT_TICKS_PER_SLOT.get() - 1);
        let max_align_new = i64::from(NEW_TICKS_PER_SLOT.get() - 1);
        let widened = i64::try_from(post_elapsed).expect("tick budget fits in i64")
            - i64::try_from(control_elapsed).expect("tick budget fits in i64");
        let lo = contract_new - contract_default - max_align_default;
        let hi = contract_new - contract_default + max_align_new;
        assert!(
            (lo..=hi).contains(&widened),
            "the configured traversal is {widened} tick(s) longer than the same traversal \
             with no edit applied ({control_elapsed} -> {post_elapsed}), outside the \
             {lo}..={hi} band the traverse-time contract predicts for {advances} advance(s) \
             moving from {} to {} ticks per slot",
            DEFAULT_TICKS_PER_SLOT.get(),
            NEW_TICKS_PER_SLOT.get()
        );
    }

    freeze(
        &Meta {
            scenario_id: "0029-belt-pace-replay",
            builder: "source_belt_collector(1 tile) at DEFAULT_TICKS_PER_SLOT + edit-log Configure(Belt{ticks_per_slot:5}) @tick12; fire the SAME item 'pace' @tick0 (pre-Configure, default pace) and @tick15 (post-Configure, slowed pace)",
            seed: SEED,
            params: "BELT-02 / THAW-05 belt-pace determinism: a logged Configure sets the belt's own advance interval to a NonZeroU32 differing from DEFAULT_TICKS_PER_SLOT, and the SAME item takes a DIFFERENT number of ticks to traverse the belt afterwards; the frozen per-tick hashes bake both traversals in. The measured widening is checked against the (SLOTS_PER_TILE * tiles - 1) * ticks_per_slot traverse-time contract plus its bounded admission-alignment offset, not against a typed constant; code_hash is the [0u8;32] N/A value",
            tick_count: TICKS,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// The item bytes 0030 injects, one per tick, tagged with a low counter byte so the
/// frozen log is not a run of identical records. Nothing reads the tag; it exists so a
/// reader can tell two queued items apart in a snapshot dump.
const SATURATION_ITEM_TAG: u8 = b'P';

/// 0030 — ALL FOUR BOUNDS SATURATED AT ONCE (PILE-01/02/03/04/09, the overload corpus
/// anchor): `source -> belt(1 tile) -> collector`, deliberately over-fed until every
/// bound this phase introduced is holding at the same tick.
///
/// # The four resting places, and why one board reaches all of them
///
/// The board is a CHAIN with no exit. The collector is an `add_source()` node, which
/// ignores its input port and never drains its inbox, so items pile up at the far end
/// and the jam propagates backwards one bound at a time:
///
/// 1. The collector's port-0 inbox fills to [`MECHANICAL_INBOX_CAP`] and refuses.
/// 2. The belt's head can no longer be delivered, so the fold RETAINS it in slot 0 and
///    the belt bunches backwards (PILE-01). That retention is the REFUSAL.
/// 3. The belt's own staging inbox fills to [`MECHANICAL_INBOX_CAP`] too - one constant
///    governing two queues, per `admit`'s ruling R-1 - so the PILE-02 gate stops
///    stepping the source at all.
/// 4. An unstepped source does not drain `pending`, so `pending` fills to
///    [`SOURCE_PENDING_CAP`] and the admission path starts refusing at the TOP of the
///    chain (PILE-04), which is the leak that bound exists to close.
///
/// The FAULT bucket is the fifth queue and it is filled independently, by logged
/// `Timeout` events aimed at the collector. `manual_inject`'s `Timeout` arm routes off
/// `CommandId.NodeId` alone and pushes a [`FaultReason::CommandTimeout`] onto that
/// node's [`FAULT_PORT`] through the same `try_admit`, so the bucket is bounded by
/// [`FAULT_QUEUE_CAP`] (PILE-09). The collector's fault port is DELIBERATELY LEFT
/// UNLINKED: PILE-10's fold-side fault drain fires only on a LINKED fault port, so an
/// undocked one keeps the faults resting where the bound can be read. More timeouts are
/// logged than the bound admits, so the DROP path is exercised too.
///
/// # Why the generator refuses to freeze an inert board
///
/// A fixture frozen from a board that never actually jammed would look identical in git
/// to one that jams on every tick, and would certify nothing. The sanity block below
/// therefore asserts all four saturations on a FRESH restore of the frozen genesis
/// BEFORE `freeze()` is called, and names the one that was missed. It also proves the
/// belt-head REFUSAL rather than inferring it: the collector is at the cap and the belt
/// head is occupied at TWO probe points separated by more than one advance interval, so
/// the belt had a due tick with a deliverable head and a destination that would not take
/// it. A single-point reading cannot tell a retained head from one about to be delivered.
///
/// Every bound is IMPORTED from `fabrico_core::admit`, never transcribed. A generator
/// carrying its own `16` would keep passing after somebody moved the constant, which is
/// the failure this fixture exists to catch.
///
/// The topology is built INLINE rather than through a `tests/common/mod.rs` helper
/// (plan 70-03 ruling R-16): `common/mod.rs` is a covered source path under the v9.0
/// declared-moves gate, and a helper added there is a declaration line that outlives
/// this phase.
///
/// Purely additive (0001-0029 untouched); NO version bump.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0030-inbox-saturation-replay"]
fn gen_0030_inbox_saturation_replay() {
    const SEED: u64 = 0x0030_C0DE;
    /// One tile, so the belt holds `SLOTS_PER_TILE` items and the chain jams quickly
    /// rather than absorbing the over-feed in transport.
    const TILES: u32 = 1;
    /// The last tick that carries an injection. One `ManualInject` per tick from tick 0,
    /// which is strictly faster than the chain drains even before it jams.
    const INJECT_LAST_TICK: u64 = 99;
    /// The first tick that carries a logged `Timeout`. After the injections, so the two
    /// fills are separable in the frozen per-tick hashes.
    const TIMEOUT_FIRST_TICK: u64 = 100;
    /// How many timeouts are logged. STRICTLY MORE than `FAULT_QUEUE_CAP`, which is what
    /// makes the bucket assertion mean something: a run that logged sixteen or fewer
    /// would fill the bucket exactly and would pass against a build with no fault bound
    /// at all.
    const TIMEOUTS: usize = FAULT_QUEUE_CAP + 4;
    const TICKS: u64 = TIMEOUT_FIRST_TICK + TIMEOUTS as u64;
    /// The gap between the two refusal probes, in ticks. Strictly greater than
    /// `DEFAULT_TICKS_PER_SLOT`, so the belt has at least one DUE tick inside the window
    /// and a head that is still occupied at both ends was demonstrably refused rather
    /// than merely waiting for its next advance.
    const REFUSAL_WINDOW: u64 = 4 * DEFAULT_TICKS_PER_SLOT.get() as u64;

    // Genesis: source -> belt(1 tile) -> collector. The collector is an `add_source()`
    // node, so it ignores its input port and its inbox is a resting place rather than a
    // queue anything drains. Its FAULT_PORT is left UNLINKED on purpose (see the
    // docblock): a linked one would drain into the fold's PILE-10 arm.
    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let belt = core.state.add_belt(TILES);
    let m = core.state.add_source();
    core.state.link((s, 0), (belt, 0));
    core.state.link((belt, 0), (m, 0));
    let genesis = snapshot::snapshot(&core);

    // Event log, tick-ascending (the two-log fold consumes it in tick order): one
    // injection per tick through INJECT_LAST_TICK, then one Timeout per tick aimed at the
    // collector. Sequences are strictly increasing across the whole log.
    let mut log: Vec<Event> = Vec::new();
    for t in 0..=INJECT_LAST_TICK {
        log.push(fire(
            s,
            t + 1,
            t,
            Item(vec![SATURATION_ITEM_TAG, (t & 0xFF) as u8]),
        ));
    }
    for i in 0..TIMEOUTS {
        let t = TIMEOUT_FIRST_TICK + i as u64;
        // `CommandId` is `(tick, NodeId, u32)` and the Timeout arm reads the NodeId and
        // nothing else, so the id is synthesized here rather than discovered from a Sink
        // dispatch. This fixture is about the BOUND on the bucket, not about the
        // executor seam that 0006 already certifies.
        log.push(command_timeout(
            (t, m, i as u32),
            t + 1 + INJECT_LAST_TICK + 1,
            t,
        ));
    }

    // NON-VACUITY of the feed itself, checked before anything is folded: the board is
    // offered strictly more items than every bounded resting place on it can hold. A
    // board fed exactly its capacity would saturate without ever REFUSING anything.
    let absorbable = MECHANICAL_INBOX_CAP
        + MECHANICAL_INBOX_CAP
        + SOURCE_PENDING_CAP
        + (SLOTS_PER_TILE * TILES) as usize;
    let injected = (INJECT_LAST_TICK + 1) as usize;
    assert!(
        injected > absorbable,
        "the log injects {injected} item(s) into a chain that can hold {absorbable}; a \
         feed that does not exceed capacity cannot make anything refuse"
    );

    // Generator-time sanity (R-32): the fixture is NOT frozen unless all four bounds are
    // demonstrably HOLDING, each named separately so a failure says which one was missed.
    {
        // The board read at ONE tick budget: (collector inbox on port 0, belt staging
        // inbox on port 0, source pending, collector FAULT_PORT bucket, belt head
        // occupied). Every reading is taken from a FRESH restore of the FROZEN genesis
        // folded through the SAME two-log path the runner uses, so a reading here cannot
        // drift from what the fixture replays to.
        let probe = |ticks: u64| -> (usize, usize, usize, usize, bool) {
            let mut check = snapshot::restore(&genesis).expect("genesis blob restores");
            let _ = fold_two_logs_collecting_hashes(&mut check, &[], &log, ticks);
            let inbox = check.state.inbox_of(m).expect("collector inbox");
            let machine_depth = inbox.len_on(0);
            let fault_depth = inbox.len_on(FAULT_PORT);
            let staging = check
                .state
                .inbox_of(belt)
                .expect("belt staging inbox")
                .len_on(0);
            let pending = match check.state.node(s) {
                Some(Node::Source(source)) => source.pending.len(),
                other => panic!("expected the feeding node to be a Source, got {other:?}"),
            };
            let head_occupied = match check.state.node(belt) {
                Some(Node::Belt(b)) => b.slots[0].is_some(),
                other => panic!("expected a Belt, got {other:?}"),
            };
            (machine_depth, staging, pending, fault_depth, head_occupied)
        };

        let (machine_depth, staging, pending, fault_depth, head_occupied) = probe(TICKS);

        // BOUND 1 - the MACHINE INBOX (PILE-01 / PILE-03).
        assert_eq!(
            machine_depth, MECHANICAL_INBOX_CAP,
            "the collector's port-0 inbox holds {machine_depth}, not the \
             MECHANICAL_INBOX_CAP {MECHANICAL_INBOX_CAP} this fixture exists to bake in"
        );

        // BOUND 2 - the BELT STAGING INBOX. The same constant on a second queue, which
        // is `admit`'s ruling R-1 made observable in the corpus.
        assert_eq!(
            staging, MECHANICAL_INBOX_CAP,
            "the belt's own staging inbox holds {staging}, not the MECHANICAL_INBOX_CAP \
             {MECHANICAL_INBOX_CAP}; without this the PILE-02 gate never closes on the \
             source and `pending` never fills"
        );

        // BOUND 3 - the SOURCE PENDING DEQUE (PILE-04), the bound at the TOP of the
        // chain and the one that stops the leak relocating upstream.
        assert_eq!(
            pending, SOURCE_PENDING_CAP,
            "the source's pending deque holds {pending}, not the SOURCE_PENDING_CAP \
             {SOURCE_PENDING_CAP}"
        );

        // BOUND 4 - the FAULT QUEUE (PILE-09). More timeouts were logged than the bound
        // admits, so this equality also proves the surplus was DROPPED rather than
        // queued.
        assert_eq!(
            fault_depth, FAULT_QUEUE_CAP,
            "the collector's FAULT_PORT bucket holds {fault_depth}, not the \
             FAULT_QUEUE_CAP {FAULT_QUEUE_CAP}, against {TIMEOUTS} logged timeout(s)"
        );

        // THE REFUSAL ITSELF (PILE-01), proved rather than inferred. A single reading of
        // "the head is occupied" is equally consistent with a head that is simply waiting
        // for its next advance, so the head is read at TWO points more than one advance
        // interval apart with the destination at its cap throughout. A belt with a
        // deliverable head, a linked destination, and at least one due tick in between
        // that still holds that head was REFUSED.
        let (earlier_depth, _, _, _, earlier_head) = probe(TICKS - REFUSAL_WINDOW);
        assert!(
            head_occupied && earlier_head,
            "the belt head must be OCCUPIED at both probe points (tick \
             {} and tick {TICKS}) for the retention to be readable; it was {earlier_head} \
             then {head_occupied}",
            TICKS - REFUSAL_WINDOW
        );
        assert_eq!(
            earlier_depth,
            MECHANICAL_INBOX_CAP,
            "the collector must already be AT the cap {MECHANICAL_INBOX_CAP} at the \
             earlier probe (tick {}) for the window between the probes to be a window in \
             which delivery was refused; it held {earlier_depth}",
            TICKS - REFUSAL_WINDOW
        );
        assert!(
            REFUSAL_WINDOW > u64::from(DEFAULT_TICKS_PER_SLOT.get()),
            "the refusal window {REFUSAL_WINDOW} must exceed the belt's advance interval \
             {} or it can contain no due tick and proves nothing",
            DEFAULT_TICKS_PER_SLOT.get()
        );
        // The belt is linked to the collector, which is what makes the retained head a
        // REFUSAL rather than the dangling-head bunch (the fold's third case).
        assert_eq!(
            core.state.link_target((belt, 0)),
            Some((m, 0)),
            "the belt's head must be LINKED to the collector, or a retained head is the \
             dangling-head case and certifies no refusal"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0030-inbox-saturation-replay",
            builder: "inline source -> belt(1 tile) -> collector, over-fed one ManualInject per tick through tick 99, then 20 logged Timeouts aimed at the collector's UNLINKED FAULT_PORT",
            seed: SEED,
            params: "PILE-01/02/03/04/09 overload determinism: the chain jams backwards from the far end and every bound this phase introduced is holding at the frozen final tick - the collector's port-0 inbox at MECHANICAL_INBOX_CAP, the belt's head RETAINED in slot 0 (the refusal), the belt's own staging inbox at MECHANICAL_INBOX_CAP, the source's pending deque at SOURCE_PENDING_CAP, and the collector's FAULT_PORT bucket at FAULT_QUEUE_CAP with the surplus timeouts dropped. Every bound is imported from fabrico_core::admit, never transcribed",
            tick_count: TICKS,
        },
        &genesis,
        &[],
        &log,
    );
}

// ============================================================================
// PHASE 73 (UNDO-08) - THE THREE PRE-FIX FIXTURES
//
// 0031, 0032 and 0033 are frozen on a tree where NONE of the phase-73 undo fixes is
// applied. That ordering IS the point of them. A golden fixture created AFTER a fix
// can never have gone red, and this repository's signature defect is a check that
// cannot fail: the pre-existing RemovePort corpus (0019, 0020, 0021) removes only the
// HIGHEST index on preset Routers with an empty routing table and no docked belts, so
// the whole of UNDO-04 and UNDO-05 could land with the corpus green and not one byte
// moved.
//
// Each of the three therefore records what the BROKEN fold actually does, and
// a prefix-hash gate compared their `hashes.txt` against the digests
// recorded at this commit. That gate is RED from this commit
// until the fixes land, which is the correct verdict here and the demonstration that
// the instrument has teeth.
// ============================================================================

/// 0031 - UNDO OF A DELETED WIRE (UNDO-01): two electrical preset Routers, a `DrawWire`
/// between them, a `Delete` of the minted wire, then `Undo`.
///
/// No fixture in the corpus replays draw-wire then delete-wire then undo, so UNDO-01
/// would otherwise ship uncertified: 0022 through 0026 carry wires and never delete one,
/// and 0013 deletes a belt and never undoes it.
///
/// The endpoints are electrical preset Routers for the reason
/// `crates/fabrico-command/tests/draw_wire.rs` documents in full:
/// `place_router_preset(Medium::Electrical, ..)` is the ONLY command path to a
/// `Medium::Electrical` port, and a `DrawWire` between two Mechanical ports is a
/// `MediumMismatch` at validate time.
///
/// TIGHTENED BY PLAN 73-05 (UNDO-01 / UNDO-08), which is what plan 73-02's pre-fix
/// docblock said would happen here. It was blessed on a tree where the `Undo` returned
/// `Err(Malformed)` and the wire did NOT come back, so the verdict was taken into a
/// binding and nothing was asserted about restoration; an `.expect()` would have PANICKED
/// and the pre-fix bless could not have run at all. It now `.expect()`s the `Undo` and
/// asserts what came back: a live `Node::Wire` running between the IDENTICAL endpoints,
/// and its canonical forward link present again in the links map.
///
/// The endpoints and not the id: a restored wire is a newly minted node, so an
/// id-carrying comparison could never pass. What a user means by "the same cable" is the
/// same two `(node, port)` ends, and that is what is read.
///
/// This fixture's `hashes.txt` moved when plan 73-03 landed the `DrawWire` restore leg,
/// which is the proof UNDO-08 exists to produce: the bytes that recorded the failure are
/// no longer the bytes the generator produces. The tightening here is what stops it
/// silently going back.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0031-undo-delete-of-a-wire"]
fn gen_0031_undo_delete_of_a_wire() {
    const SEED: u64 = 0x0031_D00D;
    /// The port indices an electrical `place_router_preset` seeds: index 0 is the `In`/W
    /// and indices 1..=3 are its `Out`/E ports, all `Electrical`; since plan 85-05 (D-22)
    /// index 4 is its `Fault`/S at `Mechanical`, which no wire here touches.
    const WIRE_IN_PORT: u16 = 0;
    const WIRE_OUT_PORT: u16 = 1;

    // The frozen genesis is the EMPTY grid, captured BEFORE any fold; the runner restores
    // it and re-folds the whole edit-log to reproduce this exact trajectory.
    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    session
        .place_router_preset(Medium::Electrical, 0, 0)
        .expect("place the source-side electrical Router preset");
    let a = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    session
        .place_router_preset(Medium::Electrical, 10, 10)
        .expect("place the target-side electrical Router preset");
    let b = session.core().state.occupied((10, 10)).expect("router at (10,10)");

    let a_h = session.view().handle_of(a).expect("source router got a handle");
    let b_h = session.view().handle_of(b).expect("target router got a handle");
    session
        .apply(GridCommand::DrawWire {
            from_node: a_h,
            from_port: WIRE_OUT_PORT,
            to_node: b_h,
            to_port: WIRE_IN_PORT,
        })
        .expect("draw the wire between the two electrical Outs/Ins");

    let wire: NodeId = session
        .core()
        .state
        .node_ids()
        .find(|id| matches!(session.core().state.node(*id), Some(Node::Wire(_))))
        .expect("the DrawWire minted a Node::Wire");
    let wire_h = session.view().handle_of(wire).expect("the minted wire got a handle");

    // The endpoints, read off the live wire BEFORE the delete. The restored wire is a
    // newly minted node, so this is what "the same cable" can mean.
    let endpoints_before = match session.core().state.node(wire) {
        Some(Node::Wire(link)) => (link.from, link.to),
        _ => panic!("the node just found is a live Node::Wire"),
    };

    // Generator-time sanity about the state BEFORE the undo.
    assert_eq!(session.core().state.node_count(), 3, "two routers plus the minted wire");
    session
        .apply(GridCommand::Delete { node: wire_h })
        .expect("a live wire is deletable");
    assert_eq!(session.core().state.node_count(), 2, "the delete removed exactly the wire");

    // TIGHTENED BY 73-05: the verdict is unwrapped and the restoration is asserted.
    session
        .apply(GridCommand::Undo)
        .expect("undo the wire delete");

    assert_eq!(
        session.core().state.node_count(),
        3,
        "the undo put the wire back and minted nothing else"
    );
    let restored: NodeId = session
        .core()
        .state
        .node_ids()
        .find(|id| matches!(session.core().state.node(*id), Some(Node::Wire(_))))
        .expect("a Node::Wire is live again after the undo");
    let endpoints_after = match session.core().state.node(restored) {
        Some(Node::Wire(link)) => (link.from, link.to),
        _ => panic!("the node just found is a live Node::Wire"),
    };
    assert_eq!(
        endpoints_after, endpoints_before,
        "the restored wire runs between the IDENTICAL (node, port) endpoints"
    );
    let links_after: Vec<((NodeId, PortId), (NodeId, PortId))> =
        session.core().state.links_iter().collect();
    assert!(
        links_after.contains(&((restored, 0), endpoints_before.1)),
        "the wire's incident forward link is back, keyed on the RE-MINTED wire's port 0: \
         {links_after:?}"
    );

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0031-undo-delete-of-a-wire",
            builder: "GridSession: place_router_preset(Electrical) x2 + DrawWire(Out->In) + Delete(the minted wire) + Undo - the Undo now succeeds and the wire comes back",
            seed: SEED,
            params: "UNDO-01/UNDO-08: blessed PRE-FIX in plan 73-02 with the Undo refused, TIGHTENED in plan 73-05. The Undo is now expected to succeed and the generator asserts the restored wire runs between the identical endpoints with its forward link back. The hashes.txt moved when 73-03 landed the DrawWire restore leg, which is what a fixture blessed after a fix can never show",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0032 - UNDO OF A DELETED BARE BELT (UNDO-02): a three-tile drawn belt with no dock and
/// no items, `Delete`d, then `Undo`ne.
///
/// `0013-delete-belt-with-items` deletes a belt and never undoes it, and
/// `0014-undo-delete-with-docked-belt` undoes the delete of a MACHINE whose cascade
/// re-draws the belt from the machine's capture. Nothing in the corpus exercises the
/// restore of a belt deleted in its own right, which is the whole of UNDO-02.
///
/// The cells (4,7), (5,7), (6,7) are used by no other fixture, so the frozen tile
/// occupancy is unambiguous.
///
/// TIGHTENED BY PLAN 73-05 (UNDO-02 / UNDO-08), which is what plan 73-02's pre-fix
/// docblock said would happen here. It was blessed on a tree where the `Undo` returned
/// `Err(Malformed)` and the belt did NOT come back, so the verdict was taken into a
/// binding and nothing was asserted about restoration; an `.expect()` would have PANICKED
/// and the pre-fix bless could not have run at all. It now `.expect()`s the `Undo` and
/// asserts what came back: a live belt whose drawn geometry EQUALS the pre-delete
/// geometry, tile for tile, with all three cells re-claimed by that one node.
///
/// Geometry equality and cell re-claim are two separate claims and both are made. A
/// restore that re-minted a belt with the right tiles but failed to claim their cells
/// would leave the board silently placeable-over, and one that claimed cells for a belt
/// with different tiles would be a different belt on the same ground.
///
/// This fixture's `hashes.txt` MOVES in the same commit as this tightening, because plan
/// 73-05's `DrawBelt` self-record leg is what makes the `Undo` succeed at all. That move
/// is the proof UNDO-08 exists to produce: the bytes that recorded the failure are no
/// longer the bytes the generator produces.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0032-undo-delete-of-a-bare-belt"]
fn gen_0032_undo_delete_of_a_bare_belt() {
    const SEED: u64 = 0x0032_BE17;
    /// The belt's three drawn cells. Chosen clear of every other fixture's board.
    const CELLS: [(i32, i32); 3] = [(4, 7), (5, 7), (6, 7)];

    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::DrawBelt { cells: CELLS.to_vec() })
        .expect("draw the three-tile belt");
    let belt = session.core().state.occupied(CELLS[0]).expect("belt tile at the tail cell");
    let belt_h = session.view().handle_of(belt).expect("the drawn belt got a handle");

    // The drawn geometry, read off the live belt BEFORE the delete. The restored belt is a
    // newly minted node, so its tiles are what "the same belt" can mean.
    let geometry_before = match session.core().state.node(belt) {
        Some(Node::Belt(b)) => b.geometry.clone(),
        _ => panic!("the node under the tail cell is a live Node::Belt"),
    };

    // Generator-time sanity BEFORE the undo.
    for cell in CELLS {
        assert!(
            session.core().state.occupied(cell).is_some(),
            "belt tile {cell:?} is claimed before the delete"
        );
    }
    session
        .apply(GridCommand::Delete { node: belt_h })
        .expect("a live bare belt is deletable");
    for cell in CELLS {
        assert!(
            session.core().state.occupied(cell).is_none(),
            "belt tile {cell:?} is freed by the delete"
        );
    }

    // TIGHTENED BY 73-05: the verdict is unwrapped and the restoration is asserted.
    session
        .apply(GridCommand::Undo)
        .expect("undo the bare belt delete");

    let restored = session
        .core()
        .state
        .occupied(CELLS[0])
        .expect("the tail cell is claimed again by the restored belt");
    let geometry_after = match session.core().state.node(restored) {
        Some(Node::Belt(b)) => b.geometry.clone(),
        _ => panic!("the undo restored a live Node::Belt"),
    };
    assert_eq!(
        geometry_after, geometry_before,
        "the restored belt carries the IDENTICAL drawn tiles, cell for cell and shape for shape"
    );
    for cell in CELLS {
        assert_eq!(
            session.core().state.occupied(cell),
            Some(restored),
            "belt tile {cell:?} is claimed by the restored belt again, and by that ONE node"
        );
    }

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0032-undo-delete-of-a-bare-belt",
            builder: "GridSession: DrawBelt[(4,7),(5,7),(6,7)] + Delete(the belt) + Undo - the Undo now succeeds and the belt comes back on the same three cells",
            seed: SEED,
            params: "UNDO-02/UNDO-08: blessed PRE-FIX in plan 73-02 with the Undo refused, TIGHTENED and RE-BLESSED in plan 73-05. The Undo is now expected to succeed and the generator asserts the restored belt has the identical drawn geometry with all three tile cells re-claimed by that one node. The hashes.txt MOVED in the same commit, which is what a fixture blessed after a fix can never show",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0033 - REMOVE AN EARLIER OUT ON A ROUTED, DOCKED ROUTER (UNDO-04 / UNDO-05): the only
/// fixture in the corpus that can certify the routing-table re-point and the surviving-dock
/// re-key, because it is the only one whose board gives either of them anything to do.
///
/// Every clause of the board is load-bearing (plan 73-02 ruling R-06):
///
/// - a NON-EMPTY routing table, installed through a certified `Configure` record in
///   `gen_0028_router_config_replay`'s idiom. `fold_place`'s ROUTER arm is
///   `add_router(Vec::new(), Some(0))` (`tick.rs:382`), so a fold-placed Router has an
///   empty table and nothing for a re-point to do.
/// - `default` set to a routing key ABOVE the one removed, so the default's decrement is
///   exercised rather than left at 0.
/// - a belt docked to a HIGHER Out than the one removed. The surviving-dock re-key is the
///   half of UNDO-05 that has no other fixture.
/// - an EARLIER Out removed. 0019, 0020 and 0021 all remove the HIGHEST index, which is
///   precisely why they can certify nothing here.
///
/// The two keyspaces collide on a Router and the collision is deliberate in this board:
/// `Dock`'s `port` is the SPATIAL catalog index (3), which the command layer translates
/// into ROUTING KEY 2; `RemovePort`'s `index` is the catalog index (1), whose Out is
/// routing key 0.
///
/// TIGHTENED BY PLAN 73-06 (UNDO-04 / UNDO-05), which is the plan its PRE-FIX BLESS marker
/// named. Plan 73-02 froze it deliberately weak - it asserted nothing about where the
/// restored port landed, what the routing table said, or where any dock pointed, because on
/// the pre-fix tree the restored Out landed LAST in the port array, the table was never
/// re-pointed, and the surviving dock silently changed which physical port it named.
///
/// It now asserts all three, and `hashes.txt` moved as UNDO-08 requires:
///   1. the removal DROPS the rule that named the removed key and DECREMENTS the higher
///      ones, and re-keys the surviving dock down with them;
///   2. the removal RELEASES exactly the dock that was on the removed output, recorded on
///      `core.last_tick.unlinked`, and exactly one;
///   3. ONE `Undo` puts the Out back AT ITS ORIGINAL INDEX, re-points the table and the
///      default to the values they carried before, and re-docks the released belt - with
///      the surviving belt still resolving to the SAME downstream node.
///
/// Every restoration assertion is on a RESOLVED value - a routing key, a `link_target`
/// destination, a port ROLE at an index - and never on a `Port` struct. `reseat_ports`
/// preserves only role and medium, so two same-medium Out ports are byte-identical structs
/// and a struct comparison would pass on the very defect this fixture froze.
/// Purely additive (0001-0032 untouched); no version bump.
///
/// # WIDENED AGAIN BY 73-12, BECAUSE AS 73-06 LEFT IT THIS FIXTURE COULD NOT FAIL
/// 73-REVIEW's CR-01 found the board arranged so that BOTH of its rules, and its
/// `default`, named routing keys ABOVE the one being removed. `fold_remove_port` has three
/// arms and only ONE of them fires on such a board: the decrement. The two
/// information-DESTROYING arms - `routes.retain(|(_, port)| *port != k)` and
/// `default == Some(k) => None` - were never exercised in the undo direction, so a fixture
/// written this phase to certify UNDO-04 was structurally incapable of catching the phase's
/// own headline defect. It passed while one Ctrl+Z was permanently destroying a routing
/// rule and its fallback.
///
/// The board now carries rule "A" ON routing key 0 (the removed Out's key) and a `default`
/// naming that same key, ALONGSIDE the two rules that name keys above it. So a single
/// generator run walks all three arms in both directions, and the restoration assertion is
/// satisfiable only by the compensating `Configure` 73-12 added to the `RemovePort`
/// inverse - a shift alone cannot re-create a dropped rule.
///
/// The re-bless it forces is DECLARED. Both `edit-log.postcard` (a Configure record with a
/// third rule, plus the compensating Configure the undo now emits) and `hashes.txt` move.
///
/// # RE-AUTHORED BY 74.1-14 (layout ruling 2026-10-04, "Edits keep middle layout")
/// 74.1-12 left this board as a named changed outcome: the CATALOG Router seated its Outs
/// at rows 2, 0, 1, the removal re-seated by index, and no undo could put the catalog rows
/// back, so the undo RELEASED the surviving belt. Since 74.1-14 the catalog Router seats
/// its Outs at rows 1, 2, 0, which is exactly where every port edit and every undo
/// re-seats them (centre-out from the catalog box), so the undo restores every cell.
///
/// The board now: the belt docks the THIRD Out (catalog 3, routing key 2) on its catalog
/// doorstep (2,0). Removing the first Out (key 0) moves every later Out into the previous
/// slot, so the third Out moves from row 0 into slot 1, row 2; its belt no longer touches
/// it, and the removal RELEASES it under its pre-edit key 2 (UNDO-06 as amended by
/// 74.1-12). ONE Undo puts the Out back at its index, restores the table and the default,
/// AND re-docks the belt with its port's facing cell on the belt's Tail. Every routing-arm
/// assertion stands.
///
/// THE FORWARD "RE-KEYED AND KEPT" CLAUSE (clause 1, the surviving dock re-keyed from 2 to
/// 1 and still reaching the same belt) was NAMED IMPOSSIBLE here by 74.1-14: on a same-role
/// board every command built, removing an earlier Out moved every later one.
///
/// # RE-AUTHORED BY 74.1-16 (design ruling of 2026-10-04): the clause is reachable again
/// Removing an output now moves no other port (existing ports are not auto-arranged), so
/// the third Out stays on row 0 and its belt is KEPT, re-keyed 2 -> 1, still touching its
/// unmoved port: clause 1 is asserted again. The board gains a SECOND belt, on the removed
/// Out itself (catalog 1, routing key 0, doorstep (2,1)), so the removal releases exactly
/// that belt and ONE Undo re-docks only it, while the kept belt goes back to key 2 by the
/// insert's identity shift. Every routing-arm assertion stands.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0033-remove-out-port-repoints"]
fn gen_0033_remove_out_port_repoints() {
    const SEED: u64 = 0x0033_C0DE;
    /// The CATALOG index of the Out this fixture removes: the first Out, at local (1,1)
    /// since 74.1-14, which is the FIRST Out in the array and therefore ROUTING KEY 0. An
    /// earlier Out, which is what 0019/0020/0021 never remove.
    const REMOVED_CATALOG_INDEX: u16 = 1;
    /// The CATALOG index the belt docks to: the third Out, at local (1,0) since 74.1-14,
    /// which the command layer translates into ROUTING KEY 2. Higher than the removed Out's
    /// key.
    const DOCKED_CATALOG_INDEX: u16 = 3;
    /// The routing key the docked belt sits on: above the removed Out's key 0.
    const DOCKED_ROUTE_KEY: PortId = 2;
    /// The routing key the `default` names. 73-12: it names the REMOVED Out's own key,
    /// not a key above it - see the widening note in this generator's docblock.
    const DEFAULT_ROUTE_KEY: PortId = 0;
    /// The belt's two drawn cells: tail one step E of the docked Out at world (1,0),
    /// facing W = opposite(E), the proven-valid OFFLOAD dock geometry `gen_0014` uses.
    const BELT_CELLS: [(i32, i32); 2] = [(2, 0), (3, 0)];
    /// 74.1-16: a second belt, on the REMOVED Out itself (local (1,1), doorstep (2,1)).
    const REMOVED_BELT_CELLS: [(i32, i32); 2] = [(2, 1), (3, 1)];

    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: KIND_ROUTER, cell_x: 0, cell_y: 0 })
        .expect("place the 2x3 Router");
    let router = session.core().state.occupied((0, 0)).expect("router at (0,0)");
    let router_h = session.view().handle_of(router).expect("the router got a handle");

    // The NON-EMPTY table. WIDENED BY 73-12: rule "A" and the `default` name the routing
    // key that is about to be REMOVED, while "B" and "C" name keys above it. The two
    // groups travel DIFFERENT arms of the fold - one is dropped/cleared outright, the
    // other is shifted - and until this widening only the shifted arm was ever exercised
    // in the undo direction, which is why this fixture could not catch CR-01.
    session
        .apply(GridCommand::Configure {
            node: router_h,
            config: fabrico_protocol::MachineConfig::Router {
                routes: vec![
                    (fabrico_protocol::RouteKey { offset: 0, expect: b"A".to_vec() }, 0),
                    (fabrico_protocol::RouteKey { offset: 0, expect: b"B".to_vec() }, 1),
                    (fabrico_protocol::RouteKey { offset: 0, expect: b"C".to_vec() }, 2),
                ],
                default: Some(DEFAULT_ROUTE_KEY),
            },
        })
        .expect("install the non-empty routing table");

    session
        .apply(GridCommand::DrawBelt { cells: BELT_CELLS.to_vec() })
        .expect("draw the offload belt");
    let belt = session
        .core()
        .state
        .occupied(BELT_CELLS[0])
        .expect("belt tile at the tail cell");
    let belt_h = session.view().handle_of(belt).expect("the drawn belt got a handle");
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: router_h,
            port: DOCKED_CATALOG_INDEX,
        })
        .expect("offload-dock the belt tail to the HIGHER Out");
    // 74.1-16: and a belt on the Out about to be removed, so the removal has its own
    // dock to release and the undo has exactly one belt to re-dock.
    session
        .apply(GridCommand::DrawBelt { cells: REMOVED_BELT_CELLS.to_vec() })
        .expect("draw the belt on the removed Out");
    let removed_belt = session
        .core()
        .state
        .occupied(REMOVED_BELT_CELLS[0])
        .expect("belt tile at the removed Out's doorstep");
    let removed_belt_h = session.view().handle_of(removed_belt).expect("the belt got a handle");
    session
        .apply(GridCommand::Dock {
            belt: removed_belt_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: router_h,
            port: REMOVED_CATALOG_INDEX,
        })
        .expect("offload-dock the second belt to the Out about to be removed");

    // Generator-time sanity about the board this fixture exists to be. Every assertion
    // here is about the SETUP being the R-06 board, not about what the undo does with it,
    // so all of them survive the fix unchanged.
    match session.core().state.node(router) {
        Some(Node::Router(r)) => {
            assert!(!r.routes.is_empty(), "the routing table is NON-EMPTY, or the re-point has nothing to do");
            assert!(
                r.routes.iter().any(|(_, port)| *port == 0),
                "73-12: a rule names the REMOVED Out's own key, or the retain arm is never \
                 exercised in the undo direction and this fixture certifies nothing"
            );
            assert_eq!(r.default, Some(DEFAULT_ROUTE_KEY), "and so does the default");
        }
        other => panic!("expected a Router, got {other:?}"),
    }
    assert!(
        session.core().state.link_target((router, DOCKED_ROUTE_KEY)).is_some(),
        "a belt is docked to routing key {DOCKED_ROUTE_KEY}, which is HIGHER than the removed Out's key 0"
    );
    let outs_before = session
        .core()
        .state
        .ports_of(router)
        .expect("a placed Router declares ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .count();
    assert!(outs_before >= 3, "the board needs at least three Outs to remove an EARLIER one");

    // The port ROLES before the removal, and the routing table, both read off the live
    // core so the restoration below is measured against what this board actually was
    // rather than against a hand-written expectation.
    let roles_before: Vec<Role> = session
        .core()
        .state
        .ports_of(router)
        .expect("preset ports")
        .iter()
        .map(|p| p.role)
        .collect();
    let (routes_before, default_before) = match session.core().state.node(router) {
        Some(Node::Router(r)) => (r.routes.clone(), r.default),
        other => panic!("expected a Router, got {other:?}"),
    };
    let docked_belt = session
        .core()
        .state
        .link_target((router, DOCKED_ROUTE_KEY))
        .expect("the belt is reachable through routing key 2");

    session
        .apply(GridCommand::RemovePort { node: router_h, index: REMOVED_CATALOG_INDEX })
        .expect("remove the EARLIEST Out, not the highest");

    // (1) and (2): what the REMOVAL did, asserted before the undo so a restoration that
    //     passed because nothing ever moved cannot read as a success.
    match session.core().state.node(router) {
        Some(Node::Router(r)) => {
            assert_eq!(
                r.routes,
                vec![
                    (RouteKey::new(0, b"B".to_vec()), 0),
                    (RouteKey::new(0, b"C".to_vec()), 1),
                ],
                "removing routing key 0 DROPS the rule that named it and decrements the two \
                 that named keys above it"
            );
            assert_eq!(
                r.default, None,
                "and CLEARS a default that named the removed output (R-25, ruled 2026-09-05)"
            );
        }
        other => panic!("expected a Router, got {other:?}"),
    }
    // 74.1-16: the removal moves NO other port, so the third Out stays on row 0, its belt
    // is KEPT and re-keyed 2 -> 1 (clause 1, reachable again), and only the belt on the
    // removed Out is released, under its pre-edit key 0. Measured, then asserted.
    let kept_out = session
        .core()
        .state
        .ports_of(router)
        .expect("ports after the removal")
        .iter()
        .filter(|p| p.role == Role::Out)
        .nth(1)
        .copied()
        .expect("the third Out is routing key 1 after the removal");
    let fp = session.core().state.footprint_of(router).expect("router footprint");
    let (pcell, pside) = fabrico_core::state::port_world((0, 0), fp.w, fp.h, fp.rot, &kept_out);
    let (dx, dy) = fabrico_core::state::unit_delta(pside);
    assert_eq!(
        (pcell.0 + dx, pcell.1 + dy),
        BELT_CELLS[0],
        "measured: the third Out did not move, its doorstep is still the belt's Tail (2,0)"
    );
    assert_eq!(
        session.core().state.link_target((router, 1)),
        Some(docked_belt),
        "clause 1: the surviving dock is re-keyed 2 -> 1 and still reaches the same belt"
    );
    assert_eq!(
        session.core().state.link_target((router, DOCKED_ROUTE_KEY)),
        None,
        "and nothing is reachable through its old key"
    );
    assert_eq!(
        session
            .core()
            .last_tick
            .unlinked
            .iter()
            .map(|u| (u.belt, u.port))
            .collect::<Vec<_>>(),
        vec![(removed_belt, 0)],
        "the removal RELEASES exactly the belt that was ON the removed output, recorded          under its pre-edit key 0"
    );
    assert!(
        matches!(session.core().state.node(removed_belt), Some(Node::Belt(_))),
        "the belt node itself survives, released, never deleted"
    );

    // (3): ONE Undo restores all three, and re-docks the released belt.
    session.apply(GridCommand::Undo).expect("undo the RemovePort");

    let roles_after: Vec<Role> = session
        .core()
        .state
        .ports_of(router)
        .expect("restored ports")
        .iter()
        .map(|p| p.role)
        .collect();
    assert_eq!(
        roles_after, roles_before,
        "the restored Out is back at its ORIGINAL index - asserted by POSITION, because a \
         count is satisfied by the reversed list the pre-73-03 bug produced"
    );
    match session.core().state.node(router) {
        Some(Node::Router(r)) => {
            assert_eq!(r.routes, routes_before, "the table names the outputs it named before");
            assert_eq!(r.default, default_before, "and so does the default");
        }
        other => panic!("expected a Router, got {other:?}"),
    }
    assert_eq!(
        session.core().state.link_target((router, DOCKED_ROUTE_KEY)),
        Some(docked_belt),
        "ONE Undo puts the kept belt back on its own key 2 (the insert's identity shift)"
    );
    assert_eq!(
        session.core().state.link_target((router, 0)),
        Some((removed_belt, 0)),
        "and re-docks the released belt on the restored output's key 0"
    );
    let restored_out = session
        .core()
        .state
        .ports_of(router)
        .expect("restored ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .nth(DOCKED_ROUTE_KEY as usize)
        .copied()
        .expect("routing key 2 names an Out again");
    let fp = session.core().state.footprint_of(router).expect("router footprint");
    let (pcell, pside) = fabrico_core::state::port_world((0, 0), fp.w, fp.h, fp.rot, &restored_out);
    let (dx, dy) = fabrico_core::state::unit_delta(pside);
    assert_eq!(
        (pcell.0 + dx, pcell.1 + dy),
        BELT_CELLS[0],
        "and the third Out's facing cell is still the kept belt's Tail"
    );
    let restored_first = session
        .core()
        .state
        .ports_of(router)
        .expect("restored ports")
        .iter()
        .find(|p| p.role == Role::Out)
        .copied()
        .expect("routing key 0 names an Out again");
    let (pcell, pside) = fabrico_core::state::port_world((0, 0), fp.w, fp.h, fp.rot, &restored_first);
    let (dx, dy) = fabrico_core::state::unit_delta(pside);
    assert_eq!(
        (pcell.0 + dx, pcell.1 + dy),
        REMOVED_BELT_CELLS[0],
        "and the restored Out is back on its own row: the re-docked belt touches it"
    );

    let tick_count = session.core().tick + 3;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = Vec::new();
    freeze(
        &Meta {
            scenario_id: "0033-remove-out-port-repoints",
            builder: "GridSession: Place ROUTER(2x3) + Configure(3-rule table, default key 0) + DrawBelt[(2,0),(3,0)] + Dock(Tail->catalog index 3 = routing key 2) + DrawBelt[(2,1),(3,1)] + Dock(Tail->catalog index 1 = routing key 0) + RemovePort(catalog index 1 = routing key 0) + Undo - TIGHTENED at plan 73-06, re-authored at 74.1-14 and 74.1-16",
            seed: SEED,
            params: "UNDO-04/UNDO-05/UNDO-08: an EARLIER Out is removed on a Router carrying a non-empty routing table, a default naming the removed key, and a belt docked to a HIGHER Out. The removal drops the rule and clears the default that named the removed key and decrements the higher rules; since 74.1-16 (no port edit moves an existing port) the belt on the higher Out is KEPT and re-keyed 2 -> 1, touching its unmoved port, and only the belt on the removed Out is released, under its pre-edit key 0. ONE Undo puts the Out back at its ORIGINAL index on its own row, re-points the table and the default, puts the kept belt back on key 2 and re-docks the released belt touching its port. Every assertion is on a resolved value, never on a Port struct",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0034 - TWO BELT RUNS JOINED INTO ONE, DRIVEN AND THEN DISCONNECTED (LINK-01 / LINK-08,
/// the belt-to-belt junction corpus anchor).
///
/// # What this fixture certifies
/// Phase 74 made a belt a PORTED node (two `Port` records, Tail `Role::In` first, Head
/// `Role::Out` second) and opened the `Dock` arm to a BELT target, so two drawn belt runs
/// join through the same certified command path that joins a belt to a machine. Before
/// this phase that exact command returned `Err(CommandError::InvalidDock)` and the only
/// junction a user could build was a machine.
///
/// The board is driven rather than merely built, so the frozen per-tick hashes carry the
/// BEHAVIOUR of the junction and not only its presence:
///
///   1. `Place SOURCE` @(0,34), `DrawBelt A` [(1,34),(2,34),(3,34)], `DrawBelt B`
///      [(4,34),(5,34)], `Place SINK` @(6,34) - a straight line, every dock geometrically
///      exact.
///   2. `Dock A.Tail -> source Out` and `Dock B.Head -> sink In`, the two ordinary
///      belt-to-machine docks that give the run an inlet and an outlet.
///   3. **`Dock A.Head -> B port 0`, the belt-to-belt join this phase shipped.** A's Head
///      outward side is E and B's Tail outward side is W, so each end's outward step lands
///      exactly on the other's end tile - the same facing-adjacency and facing-opposite
///      rules a belt-to-machine dock passes, applied to a belt target.
///   4. A logged `Configure` sets B's own advance interval to `SLOW_PACE`, THREE times the
///      default, so B is the slower run. Items therefore CROSS the junction and then BUNCH
///      backwards over it into A, which is the observable a junction that merely existed
///      could not produce.
///   5. `Unlink A.Head -> B port 0`, the disconnect half, certified in the same log. After
///      it B drains into the sink and empties while A stays PACKED against its now-dangling
///      head, which is the two-sided consequence of severing a junction that was carrying.
///
/// # Every record is authored by the certified command path
/// The whole board is built through `GridSession::apply`, the same path a user's gesture
/// drives, and the frozen `edit-log.postcard` is the session's own log. NO `EditOp` is
/// forged and NO link is written at the core seam. A forged link would certify a state a
/// user cannot reach, which is the opposite of what this fixture is for.
///
/// # THE FAN-IN IS DELIBERATELY ABSENT, AND THE REASON IS MEASURED
/// LINK-13's every-upstream projection (a belt whose Tail carries two upstream docks) is
/// NOT in this fixture, and it is not an omission of convenience. A belt-to-belt fan-in is
/// **not constructible through the certified path at all**: the `Dock` arm requires the
/// target end's cell stepped toward its outward side to land EXACTLY on the carrier belt's
/// endpoint cell (`command.rs`, the `(mcell.0 + dx, mcell.1 + dy) != end_cell` refusal), and
/// a belt end has exactly ONE outward direction, so exactly ONE cell can host an upstream
/// head. A second upstream belt aimed at the same tail earns `Err(InvalidDock)` on the
/// adjacency rule before occupancy is ever asked.
///
/// MEASURED at this commit, by probe, and not inferred from reading the rule. On a board
/// whose downstream B runs (4,0)->(5,0), the one geometrically valid join returns `Ok`, and
/// a second upstream approaching from the N (head at (4,-1)), from the S (head at (4,1)) or
/// from the row above (head at (3,-1)) each returns `Err(InvalidDock)`. The only cell that
/// could ever qualify, (3,0), is already held by the first upstream, and a machine placed
/// there to feed the same tail returns `Err(FootprintCollision)`.
/// `crates/fabrico-host/src/render_packet.rs`'s own fan-in case builds its two upstream
/// links at the CORE SEAM (`state.link`) for exactly this reason. A fixture cannot freeze a
/// command that is refused, so the fan-in stays certified by that host-side test and not
/// here.
///
/// That measurement contradicts `REQUIREMENTS.md`'s LINK-13 rationale, which says LINK-01
/// makes a belt-to-belt fan-in user-constructible for the first time. The packet fix
/// plan 74-04 shipped is still correct and still worth having; what is not true is that a
/// user can reach the board it fixes. Recorded as WINDOWS row 237 rather than corrected
/// here, because a requirement's own rationale is not this plan's to rewrite.
///
/// # What this fixture does NOT certify, said plainly
/// A blessed fixture asserts whatever the code produced on the day it was blessed. These
/// hashes prove that this board REPLAYS identically from its genesis on every OS - the
/// project's core value and the whole reason the corpus exists. They do NOT prove the
/// junction's behaviour is correct: had the crossing been wrong, the wrong crossing would
/// have been frozen just as faithfully. The behavioural claims are carried by
/// `crates/fabrico-host/tests/belt_backpressure_meet.rs` and by the generator-time sanity
/// block below, which refuses to freeze a board where nothing crossed, nothing bunched, or
/// nothing drained.
///
/// Purely additive (0001-0033 untouched); NO version bump - the corpus is minted at the
/// `SNAPSHOT_SCHEMA_VERSION` 12 this phase already moved in plan 74-02.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0034-belt-to-belt-junction-replay"]
fn gen_0034_belt_to_belt_junction_replay() {
    const SEED: u64 = 0x0034_C0DE;
    /// The row this board occupies. Clear of every other fixture's cells, and chosen to
    /// match the fixture id so a snapshot dump reads unambiguously.
    const ROW: i32 = 34;
    /// Belt A, the UPSTREAM run: three tiles, tail at (1,ROW) one step E of the source Out.
    const A_CELLS: [(i32, i32); 3] = [(1, ROW), (2, ROW), (3, ROW)];
    /// Belt B, the DOWNSTREAM run: two tiles, tail at (4,ROW) abutting A's head at (3,ROW).
    const B_CELLS: [(i32, i32); 2] = [(4, ROW), (5, ROW)];
    /// B's configured advance interval. THREE times `DEFAULT_TICKS_PER_SLOT`, so B is
    /// unambiguously the slower run and the bunching is a pace consequence rather than an
    /// alignment coincidence. Derived from the constant, never transcribed: a generator
    /// carrying its own 6 would keep passing after somebody moved the default.
    const SLOW_PACE: u32 = 3 * DEFAULT_TICKS_PER_SLOT.get();
    /// How many items are fired into the source. They are fired at EXACTLY belt A's own
    /// free-flow rate, one every `DEFAULT_TICKS_PER_SLOT` ticks, and that spacing is the
    /// single thing that makes the bunching below attributable to B's pace. An OVER-fed
    /// chain saturates whatever the paces are, so a fixture driven that way would freeze a
    /// jam it could not tell from a jam the junction caused. MEASURED, not argued: the
    /// first draft of this generator fired one item per TICK, and its bunching assertions
    /// stayed GREEN with the `Configure` neutered to the default pace.
    const ITEMS: u64 = 30;
    /// Idle ticks after the last fire, before the disconnect. A BUDGET, derived from the
    /// slower pace so it stretches if the constants move: long enough for B to fill and for
    /// the bunching to reach back across the junction into A.
    const BUNCH_TICKS: u64 = 8 * SLOW_PACE as u64;
    /// The window the head-retention measurement below is taken over. Derived from belt A's
    /// OWN interval and deliberately NOT from `SLOW_PACE`: a window that scaled with the
    /// downstream pace would move its own yardstick, which is how the first draft of that
    /// measurement made itself unable to fail.
    const RETENTION_WINDOW: u64 = 6 * DEFAULT_TICKS_PER_SLOT.get() as u64;
    /// Idle ticks after the disconnect. Also a budget: B holds at most
    /// `SLOTS_PER_TILE * 2` items and each advance costs `SLOW_PACE` ticks.
    const DRAIN_TICKS: u64 = 4 * SLOTS_PER_TILE as u64 * SLOW_PACE as u64;

    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    // SOURCE @(0,ROW): its single Out sits at world (0,ROW) facing E -> facing cell (1,ROW).
    session
        .apply(GridCommand::Place { kind: KIND_SOURCE, cell_x: 0, cell_y: ROW })
        .expect("place the source");
    let src = *session.core().last_tick.placed.last().expect("source minted");
    let src_h = session.view().handle_of(src).expect("source got a handle");
    session
        .apply(GridCommand::DrawBelt { cells: A_CELLS.to_vec() })
        .expect("draw belt A, the upstream run");
    let belt_a = *session.core().last_tick.placed.last().expect("belt A minted");
    let a_h = session.view().handle_of(belt_a).expect("belt A got a handle");
    session
        .apply(GridCommand::DrawBelt { cells: B_CELLS.to_vec() })
        .expect("draw belt B, the downstream run");
    let belt_b = *session.core().last_tick.placed.last().expect("belt B minted");
    let b_h = session.view().handle_of(belt_b).expect("belt B got a handle");
    // SINK @(6,ROW): its In sits at world (6,ROW) facing W -> facing cell (5,ROW).
    session
        .apply(GridCommand::Place { kind: KIND_SINK, cell_x: 6, cell_y: ROW })
        .expect("place the sink");
    let snk = *session.core().last_tick.placed.last().expect("sink minted");
    let snk_h = session.view().handle_of(snk).expect("sink got a handle");

    session
        .apply(GridCommand::Dock {
            belt: a_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: src_h,
            port: 0,
        })
        .expect("offload-dock belt A's tail to the source Out");
    session
        .apply(GridCommand::Dock {
            belt: b_h,
            endpoint: fabrico_protocol::BeltEnd::Head,
            node: snk_h,
            port: 0,
        })
        .expect("load-dock belt B's head into the sink In");
    // THE JOIN. Belt A's HEAD onto belt B's TAIL, which is B's catalog index 0 (its
    // `Role::In` record). This is the command that returned Err(InvalidDock) before this
    // phase, on this exact board.
    session
        .apply(GridCommand::Dock {
            belt: a_h,
            endpoint: fabrico_protocol::BeltEnd::Head,
            node: b_h,
            port: 0,
        })
        .expect("join belt A's head to belt B's tail through the certified path");
    // B is the SLOWER run, set through the shipped Configure record rather than by hand.
    session
        .apply(GridCommand::Configure {
            node: b_h,
            config: fabrico_protocol::MachineConfig::Belt { ticks_per_slot: SLOW_PACE },
        })
        .expect("slow belt B down so items bunch backwards over the junction");

    // Drive: one item every `DEFAULT_TICKS_PER_SLOT` ticks, which is exactly the rate belt
    // A carries when nothing downstream refuses it. `pump` advances one tick of its own, so
    // the idle remainder of each interval is advanced explicitly.
    for i in 0..ITEMS {
        session.pump(&[fire(src, i + 1, 0, Item(vec![b'J', (i & 0xFF) as u8]))]);
        session.advance(u64::from(DEFAULT_TICKS_PER_SLOT.get()) - 1);
    }
    session.advance(BUNCH_TICKS);

    // The tick the disconnect lands on, read off the live session rather than computed
    // from the constants above, so the probe below cannot drift from the log.
    let unlink_tick = session.core().tick;

    // THE DISCONNECT, in the same log, naming the same link from the same side.
    session
        .apply(GridCommand::Unlink {
            belt: a_h,
            endpoint: fabrico_protocol::BeltEnd::Head,
            node: b_h,
            port: 0,
        })
        .expect("disconnect the junction through the certified path");
    session.advance(DRAIN_TICKS);

    let tick_count = session.core().tick;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = session.event_log().to_vec();

    // Generator-time sanity, on FRESH restores of the frozen genesis folded through both
    // frozen logs - the exact fold the runner performs. A fixture frozen from a board where
    // nothing ever crossed the junction would replay to a stable hash forever and certify
    // nothing, so this block refuses to reach `freeze()` unless the junction actually
    // carried and the disconnect actually severed it.
    //
    // Both probes read a FRESH restore rather than the live session, for the reason
    // `gen_0029` gives: what the runner will replay is what has to be asserted, and a live
    // session that agreed with itself would prove nothing about the frozen bytes.
    {
        let slots_of = |core: &Core, id: NodeId| match core.state.node(id) {
            Some(Node::Belt(b)) => b.slots.clone(),
            other => panic!("expected a Node::Belt, got {other:?}"),
        };
        let occupied = |core: &Core, id: NodeId| {
            slots_of(core, id).iter().filter(|s| s.is_some()).count()
        };

        // PROBE 1, at the tick boundary the Unlink record folds on, so the state read here
        // is the board WITH the junction still live.
        let mut joined = snapshot::restore(&genesis).expect("genesis restores");
        let _ = fold_two_logs_collecting_hashes(&mut joined, &edits, &log, unlink_tick);
        assert_eq!(
            joined.state.link_target((belt_a, 0)),
            Some((belt_b, 0)),
            "the belt-to-belt join is live at the disconnect tick: (A,0) -> (B,0)"
        );
        // ITEMS CROSSED. B's ONLY inlet is A's head dock - no source feeds it and no other
        // belt can reach its tail - so an occupied slot on B is proof that items travelled
        // ACROSS the junction rather than merely proof that a link exists.
        assert!(
            occupied(&joined, belt_b) > 0,
            "items crossed the junction: belt B carries {} item(s) and its only inlet is \
             belt A's head dock",
            occupied(&joined, belt_b)
        );
        // AND THE DOWNSTREAM IS SATURATED. B is the slower run and it is carrying at its
        // own capacity, which is what makes A's head un-handoffable below. The floor is
        // `capacity - 1` and not `capacity`, because B's own head slot is momentarily free
        // on each tick it delivers into the sink.
        let b_capacity = B_CELLS.len() * SLOTS_PER_TILE as usize;
        assert!(
            occupied(&joined, belt_b) >= b_capacity - 1,
            "belt B is saturated at the disconnect tick: it carries {} of {b_capacity} \
             slots, so A has nowhere to hand its head",
            occupied(&joined, belt_b)
        );

        // AND ITEMS BUNCHED BACK OVER THE JUNCTION. **This is measured over a WINDOW and
        // never at one tick.** A's head slot is legitimately EMPTY on each tick it does
        // successfully hand off, and the disconnect happens to land on one of those, so a
        // single-point reading cannot tell a RETAINED head from one that has just been
        // delivered. `gen_0030`'s docblock states the same trap for the same reason, and
        // this was not a prediction: the single-point form was written first and it FAILED
        // on a correctly bunched board.
        //
        // THE YARDSTICK IS BELT A'S OWN PACE, NOT B'S. The count of head-free ticks over
        // `RETENTION_WINDOW` is compared against what A would produce if NOTHING refused it
        // - one hand-off every `DEFAULT_TICKS_PER_SLOT` ticks. Fewer than that means A is
        // rate-limited by something downstream rather than by itself, and with the
        // saturation assertion above that something can only be B. Comparing against a
        // prediction derived from `SLOW_PACE` would move the yardstick with the very
        // constant under test, which is exactly how the first draft of this block passed
        // with the `Configure` neutered to the default pace.
        let free_flow_handoffs = RETENTION_WINDOW / u64::from(DEFAULT_TICKS_PER_SLOT.get());
        let head_free = (unlink_tick - RETENTION_WINDOW + 1..=unlink_tick)
            .filter(|t| {
                let mut c = snapshot::restore(&genesis).expect("genesis restores");
                let _ = fold_two_logs_collecting_hashes(&mut c, &edits, &log, *t);
                slots_of(&c, belt_a).first().is_none_or(Option::is_none)
            })
            .count() as u64;
        assert!(
            head_free < free_flow_handoffs,
            "belt A's head is free on {head_free} of the {RETENTION_WINDOW} tick boundaries \
             ending at the disconnect. Unrefused, A hands off every {} ticks and would be \
             free on {free_flow_handoffs} of them, so A is NOT being refused and nothing \
             bunched back over the junction",
            DEFAULT_TICKS_PER_SLOT.get()
        );
        let a_before = occupied(&joined, belt_a);

        // PROBE 2, at the frozen final tick: the board AFTER the disconnect has settled.
        let mut severed = snapshot::restore(&genesis).expect("genesis restores");
        let _ = fold_two_logs_collecting_hashes(&mut severed, &edits, &log, tick_count);
        assert_eq!(
            severed.state.link_target((belt_a, 0)),
            None,
            "the Unlink removed exactly the link the Dock created, and the frozen hashes \
             carry the board without it"
        );
        // THE DOWNSTREAM DRAINED. B kept delivering into the sink after the sever and is
        // now EMPTY, which is only reachable because the disconnect stopped it being
        // refilled.
        assert_eq!(
            occupied(&severed, belt_b), 0,
            "belt B drained completely into the sink after the disconnect: B = {:?}",
            slots_of(&severed, belt_b).iter().map(Option::is_some).collect::<Vec<_>>()
        );
        // THE UPSTREAM STAYED PACKED. A's head now dangles, so nothing leaves it: its head
        // slot is still retained and it holds no fewer items than it did at the sever.
        assert!(
            slots_of(&severed, belt_a).first().is_some_and(Option::is_some),
            "belt A's head is still retained against its now-dangling head: A = {:?}",
            slots_of(&severed, belt_a).iter().map(Option::is_some).collect::<Vec<_>>()
        );
        assert!(
            occupied(&severed, belt_a) >= a_before,
            "nothing escaped belt A after the sever: it held {a_before} item(s) at the \
             disconnect and holds {} now",
            occupied(&severed, belt_a)
        );
        // The two probes are DIFFERENT boards, stated as an assertion rather than left to
        // the reader: if the drive were inert both would read identically and every claim
        // above would be satisfied by a board that never moved.
        assert_ne!(
            slots_of(&joined, belt_b),
            slots_of(&severed, belt_b),
            "the disconnect changed the board: an inert drive would make both probes equal"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0034-belt-to-belt-junction-replay",
            builder: "GridSession: Place SOURCE@(0,34) + DrawBelt A[(1,34),(2,34),(3,34)] + DrawBelt B[(4,34),(5,34)] + Place SINK@(6,34) + Dock(A.Tail->source Out) + Dock(B.Head->sink In) + Dock(A.Head->B port 0, THE BELT-TO-BELT JOIN) + Configure(Belt{ticks_per_slot: 3x DEFAULT_TICKS_PER_SLOT}) + 30 ManualInject fired one every DEFAULT_TICKS_PER_SLOT ticks (belt A's own free-flow rate, so the bunching is B's pace and not an over-feed) + Unlink(A.Head->B port 0)",
            seed: SEED,
            params: "LINK-01/LINK-08 belt-to-belt junction determinism: two abutting drawn runs joined by the belt-to-belt Dock this phase shipped, driven until items cross the junction and bunch backwards over it into the slower upstream, then DISCONNECTED in the same log so the downstream drains and the upstream stays packed. Every record is authored by the certified command path; no forged EditOp and no core-seam link",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0035 - A LABEL ON A FLOWING BOARD, CONFIGURED, DELETED AND UNDONE (SHAPE-11, D-08, the
/// label corpus anchor).
///
/// # What this fixture certifies
/// Phase 76 made a label a real sim object: `Node::Label { text, colour }` in the certified
/// snapshot, its box in `footprints`, its words, colour and size written by one
/// `Configure{Label}`. This fixture freezes those bytes on a board that is actually moving
/// items, and replays them from genesis on every OS the corpus runs on:
///
///   1. `Place SOURCE` @(0,35), `DrawBelt` [(1,35),(2,35),(3,35)], `Place SINK` @(4,35),
///      `Dock belt.Tail -> source Out`, `Dock belt.Head -> sink In`: a straight run.
///   2. `Place LABEL` @(1,36), the free row right under the belt, then ONE
///      `Configure{Label}` (`Order intake`, Lilac, 6 by 2) through the protocol command.
///   3. Items fired at the Source at the belt's own free-flow rate, one every
///      `DEFAULT_TICKS_PER_SLOT` ticks, so they reach the Sink.
///   4. Once those items have drained into the Sink, `Delete` of the label, then `Undo`: the Delete inverse's records (the re-`Place` of
///      the 6 by 2 box and, since 76-05, the re-`Configure{Label}` carrying the words and
///      colour) are frozen in the edit log like any user record.
///   5. More items, so the board keeps flowing after the label came back.
///
/// The whole board is built through `GridSession::apply`, and the frozen `edit-log.postcard`
/// is the session's own log: no forged `EditOp`.
///
/// # What this fixture does NOT certify, said plainly
/// `cert_cross_platform` links no `fabrico-command` code on its replay path: it restores the
/// frozen genesis and folds the frozen records verbatim. So 0035 certifies that the label's
/// frozen records REPLAY to the same per-tick hashes, including the two records the undo
/// appended. It can never see a `compute_inverse` regression: had the Delete inverse stopped
/// re-configuring the label, the corpus would keep replaying the old, correct records
/// forever. That guard is `crates/fabrico-command/tests/label.rs` (the four delete-undo
/// legs), never this fixture (memory fabrico-checks-that-cannot-fail, the golden 0033
/// lesson). And like every blessed fixture it proves the board replays identically, not
/// that the label's behaviour is right; the generator-time sanity block below refuses to
/// freeze an inert board or a label that did not come back.
///
/// Purely additive (0001-0034 untouched); NO version bump: `Node::Label` was appended to
/// the snapshot by plan 76-01 and `MachineConfig::Label` to the edit record by plan 76-02,
/// each as a new last variant that moved no existing byte, and this fixture is minted at the
/// schemas that already carry them.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0035-label-inert-replay"]
fn gen_0035_label_inert_replay() {
    use fabrico_core::state::LabelColour;

    const SEED: u64 = 0x0035_1ABE;
    /// The row this board's run occupies, matching the fixture id.
    const ROW: i32 = 35;
    /// The belt between Source and Sink.
    const BELT_CELLS: [(i32, i32); 3] = [(1, ROW), (2, ROW), (3, ROW)];
    /// The label's anchor: right under the belt's first tile, so the 6 by 2 box sits
    /// beside the moving items (cells x 1 to 6, y 36 to 37, all free).
    const LABEL_AT: (i32, i32) = (1, ROW + 1);
    /// Items fired before the Delete and after the Undo. At the belt's own free-flow rate.
    const ITEMS_BEFORE: u64 = 12;
    const ITEMS_AFTER: u64 = 12;
    /// Idle ticks at the end, a budget for the last items to reach the Sink: three tiles
    /// of `SLOTS_PER_TILE` slots at the default pace, doubled.
    const DRAIN_TICKS: u64 =
        2 * BELT_CELLS.len() as u64 * SLOTS_PER_TILE as u64 * DEFAULT_TICKS_PER_SLOT.get() as u64;

    let genesis = snapshot::snapshot(&Core::genesis(header(SEED)));

    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: KIND_SOURCE, cell_x: 0, cell_y: ROW })
        .expect("place the source");
    let src = *session.core().last_tick.placed.last().expect("source minted");
    let src_h = session.view().handle_of(src).expect("source got a handle");
    session
        .apply(GridCommand::DrawBelt { cells: BELT_CELLS.to_vec() })
        .expect("draw the belt");
    let belt = *session.core().last_tick.placed.last().expect("belt minted");
    let belt_h = session.view().handle_of(belt).expect("belt got a handle");
    session
        .apply(GridCommand::Place { kind: KIND_SINK, cell_x: 4, cell_y: ROW })
        .expect("place the sink");
    let snk = *session.core().last_tick.placed.last().expect("sink minted");
    let snk_h = session.view().handle_of(snk).expect("sink got a handle");
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: src_h,
            port: 0,
        })
        .expect("offload-dock the belt's tail to the source Out");
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: fabrico_protocol::BeltEnd::Head,
            node: snk_h,
            port: 0,
        })
        .expect("load-dock the belt's head into the sink In");

    // THE LABEL, placed and configured through the shipped commands.
    session
        .apply(GridCommand::Place {
            kind: fabrico_protocol::machine_kind::LABEL,
            cell_x: LABEL_AT.0,
            cell_y: LABEL_AT.1,
        })
        .expect("place the label beside the belt");
    let label = *session.core().last_tick.placed.last().expect("label minted");
    let label_h = session.view().handle_of(label).expect("label got a handle");
    session
        .apply(GridCommand::Configure {
            node: label_h,
            config: fabrico_protocol::MachineConfig::Label {
                text: "Order intake".to_owned(),
                colour: 3,
                w: 6,
                h: 2,
            },
        })
        .expect("configure the label: Order intake, Lilac, 6 by 2");

    let fire_items = |session: &mut GridSession, from: u64, n: u64| {
        for i in from..from + n {
            session.pump(&[fire(src, i + 1, 0, Item(vec![b'L', (i & 0xFF) as u8]))]);
            session.advance(u64::from(DEFAULT_TICKS_PER_SLOT.get()) - 1);
        }
    };
    fire_items(&mut session, 0, ITEMS_BEFORE);
    // Let the first batch reach the Sink before the label is touched, so the counts below
    // attribute each item to one side of the Delete and Undo.
    session.advance(DRAIN_TICKS);

    // DELETE THEN UNDO. The tick each lands on is read off the session, so the probes
    // below cannot drift from the log.
    let delete_tick = session.core().tick;
    session
        .apply(GridCommand::Delete { node: label_h })
        .expect("delete the label");
    let undo_tick = session.core().tick;
    session.apply(GridCommand::Undo).expect("undo the delete");

    fire_items(&mut session, ITEMS_BEFORE, ITEMS_AFTER);
    session.advance(DRAIN_TICKS);

    let tick_count = session.core().tick;
    let edits: Vec<EditRecord> = session.edit_log().to_vec();
    let log: Vec<Event> = session.event_log().to_vec();

    // Generator-time sanity, on FRESH restores of the frozen genesis folded through both
    // frozen logs, the exact fold the runner performs (the `gen_0034` rule: what the
    // runner replays is what is asserted). This block refuses to reach `freeze()` for an
    // inert board, a label that did not come back whole, or a log without the undo's
    // re-Configure.
    {
        let labels = |core: &Core| -> Vec<NodeId> {
            core.state
                .node_ids()
                .filter(|id| matches!(core.state.node(*id), Some(Node::Label(_))))
                .collect()
        };
        // The fold, tick by tick, counting the commands the Sink emitted (one per item it
        // consumed) before the Delete and after the Undo.
        let mut core = snapshot::restore(&genesis).expect("genesis restores");
        let (mut eidx, mut didx) = (0usize, 0usize);
        let (mut sunk_before, mut sunk_after) = (0usize, 0usize);
        let mut labels_while_deleted: Option<usize> = None;
        for _ in 0..tick_count {
            let t = core.tick;
            let dstart = didx;
            while didx < edits.len() && edits[didx].tick == t {
                didx += 1;
            }
            let estart = eidx;
            while eidx < log.len() && log[eidx].tick == t {
                eidx += 1;
            }
            let emitted = core.advance_edits(&edits[dstart..didx], &log[estart..eidx]).len();
            if t < delete_tick {
                sunk_before += emitted;
            } else if t > undo_tick {
                sunk_after += emitted;
            }
            if t == delete_tick {
                labels_while_deleted = Some(labels(&core).len());
            }
        }
        // Every item fired reached the Sink, on its side of the Delete and Undo (measured
        // 12 and 12 at this commit; the Sink emits one command per item it consumes).
        assert_eq!(
            (sunk_before, sunk_after),
            (ITEMS_BEFORE as usize, ITEMS_AFTER as usize),
            "every item fired reached the Sink before the Delete and after the Undo: an \
             inert board certifies nothing"
        );
        assert_eq!(
            labels_while_deleted,
            Some(0),
            "the Delete removed the label: no label stands on the tick it folded"
        );
        let standing = labels(&core);
        assert_eq!(standing.len(), 1, "exactly one label stands at the end");
        let id = standing[0];
        match core.state.node(id) {
            Some(Node::Label(l)) => {
                assert_eq!(l.text, "Order intake", "the label came back with its words");
                assert_eq!(l.colour, LabelColour::Lilac, "and its colour");
            }
            other => panic!("expected a Node::Label, got {other:?}"),
        }
        assert_eq!(
            core.state.footprint_of(id),
            Some(Footprint { w: 6, h: 2, rot: 0 }),
            "and its 6 by 2 box"
        );
        assert_eq!(core.state.cell_of(id), Some(LABEL_AT), "at its first anchor");
        let label_configures = edits
            .iter()
            .filter(|r| {
                matches!(r.op, EditOp::Configure { config: MachineConfig::Label { .. }, .. })
            })
            .count();
        assert!(
            label_configures >= 2,
            "the edit log carries the user's Configure{{Label}} AND the undo's \
             re-Configure: {label_configures} found"
        );
        // The board the runner replays is the board just asserted.
        let mut runner = snapshot::restore(&genesis).expect("genesis restores");
        let _ = fold_two_logs_collecting_hashes(&mut runner, &edits, &log, tick_count);
        assert_eq!(
            snapshot::snapshot(&runner),
            snapshot::snapshot(&core),
            "the runner's fold lands on the same state as the counting fold"
        );
    }

    freeze(
        &Meta {
            scenario_id: "0035-label-inert-replay",
            builder: "GridSession: Place SOURCE@(0,35) + DrawBelt[(1,35),(2,35),(3,35)] + Place SINK@(4,35) + Dock(belt.Tail->source Out) + Dock(belt.Head->sink In) + Place LABEL@(1,36) + Configure(Label{Order intake, Lilac, 6x2}) + 12 ManualInject one every DEFAULT_TICKS_PER_SLOT ticks + drain + Delete(label) + Undo + 12 more injects + drain",
            seed: SEED,
            params: "SHAPE-11/D-08 label determinism: a configured 6 by 2 Lilac label beside a flowing belt, deleted and undone (the undo re-Places the box and re-Configures the words and colour), replayed from genesis. Certifies the label's frozen records replay identically; it cannot see a compute_inverse regression (fabrico-command tests/label.rs is that guard)",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

// ---------------------------------------------------------------------------
// Phase 87, "No permanent jams" (JAM-01 to JAM-05, D-10): one golden per core jam the
// phase fixed. Each generator builds the board its `tests/no_permanent_jams.rs` probe
// proves (87-RESEARCH P175, P174, P176b, P177B, P165), inline through the core seam as
// 0030 does, so the fixed behaviour replays from genesis on every OS the corpus runs on.
//
// WHAT THESE DO NOT CERTIFY, said once for all five: a blessed fixture asserts whatever
// the code produced on the day it was blessed. The hashes prove the board REPLAYS the same
// everywhere; the jam itself is graded by the probes in `no_permanent_jams.rs`. Each
// generator below refuses to freeze a board on which the fixed behaviour is absent, so a
// regression that brings a jam back changes these hashes and reddens the runner.
// ---------------------------------------------------------------------------

/// The commands Sink `sink` emitted in `cmds` (one per item it consumed).
fn sink_emits(cmds: &[fabrico_core::command::Command], sink: NodeId) -> usize {
    cmds.iter().filter(|c| c.id.1 == sink).count()
}

/// A Source's backlog length (0 for any other kind).
fn source_pending(core: &Core, id: NodeId) -> usize {
    match core.state.node(id) {
        Some(Node::Source(s)) => s.pending.len(),
        _ => 0,
    }
}

/// Fold the FROZEN genesis through BOTH frozen logs tick by tick with the slicing
/// [`fold_two_logs_collecting_hashes`] uses, calling `each` after every tick with the core
/// and the commands that tick emitted. Ends by asserting the result equals the runner's own
/// fold, so what the sanity blocks below assert is the board the runner replays (the
/// `gen_0034` rule).
fn fold_watching(
    genesis: &[u8],
    edits: &[EditRecord],
    log: &[Event],
    ticks: u64,
    mut each: impl FnMut(&Core, &[fabrico_core::command::Command]),
) -> Core {
    let mut core = snapshot::restore(genesis).expect("genesis restores");
    let (mut eidx, mut didx) = (0usize, 0usize);
    for _ in 0..ticks {
        let t = core.tick;
        let dstart = didx;
        while didx < edits.len() && edits[didx].tick == t {
            didx += 1;
        }
        let estart = eidx;
        while eidx < log.len() && log[eidx].tick == t {
            eidx += 1;
        }
        let cmds = core.advance_edits(&edits[dstart..didx], &log[estart..eidx]);
        each(&core, &cmds);
    }
    assert_eq!(didx, edits.len(), "every edit record was folded inside the tick count");
    assert_eq!(eidx, log.len(), "every logged event was folded inside the tick count");
    let mut runner = snapshot::restore(genesis).expect("genesis restores");
    let _ = fold_two_logs_collecting_hashes(&mut runner, edits, log, ticks);
    assert_eq!(
        snapshot::snapshot(&runner),
        snapshot::snapshot(&core),
        "the runner's fold lands on the same state as the watching fold"
    );
    core
}

/// 0036 - A BALANCER FED ON BOTH INPUTS DRAINS BOTH (JAM-01, WINDOWS 175).
///
/// # What this fixture certifies
/// Two Sources, each into a 1-tile belt, one belt on the Balancer's In 0 and the other on
/// its In 1; the Balancer's two Outs feed two Debug Sinks. Each Source is fed one event per
/// tick whenever it would accept one, items tagged `A` and `B` by Source, for `FEED_TICKS`,
/// then the board drains. Before plan 87-03 the Balancer read In 0 only, so nothing on In 1
/// ever left and that belt jammed for good (87-RESEARCH P175, leg B). The board is the leg-B
/// board of `no_permanent_jams.rs#a_balancer_drains_both_inputs`.
///
/// The generator refuses to freeze unless items from BOTH Sources reached the Sinks and
/// both Sinks received items, read on a fresh restore of the frozen genesis. Topology is
/// built at genesis through the core seam (0030's shape), so the edit log is empty.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0036-balancer-both-inputs"]
fn gen_0036_balancer_both_inputs() {
    const SEED: u64 = 0x0036_BA1A;
    const FEED_TICKS: u64 = 200;
    const DRAIN_TICKS: u64 = 100;
    const TAG_A: u8 = b'A';
    const TAG_B: u8 = b'B';

    let mut core = Core::genesis(header(SEED));
    let sa = core.state.add_source();
    let sb = core.state.add_source();
    let ba = core.state.add_belt(1);
    let bb = core.state.add_belt(1);
    let bal = core.state.add_balancer(2);
    let k0 = core.state.add_sink(SinkTemplate::Debug, 0);
    let k1 = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((sa, 0), (ba, 0));
    core.state.link((sb, 0), (bb, 0));
    core.state.link((ba, 0), (bal, 0));
    core.state.link((bb, 0), (bal, 1));
    core.state.link((bal, 0), (k0, 0));
    core.state.link((bal, 1), (k1, 0));
    let genesis = snapshot::snapshot(&core);

    // The log, written by running the board: each Source fired while it would accept.
    let mut log: Vec<Event> = Vec::new();
    let mut seq = 0u64;
    for _ in 0..FEED_TICKS {
        let t = core.tick;
        let mut evs = Vec::new();
        for (src, tag) in [(sa, TAG_A), (sb, TAG_B)] {
            if source_pending(&core, src) < SOURCE_PENDING_CAP {
                seq += 1;
                evs.push(fire(src, seq, t, Item(vec![tag, (seq & 0xFF) as u8])));
            }
        }
        core.advance(&evs);
        log.extend(evs);
    }
    let tick_count = FEED_TICKS + DRAIN_TICKS;

    let (mut out0, mut out1) = (0usize, 0usize);
    let final_core = fold_watching(&genesis, &[], &log, tick_count, |_, cmds| {
        out0 += sink_emits(cmds, k0);
        out1 += sink_emits(cmds, k1);
    });
    // What left each In: every event its Source took, minus what still rests upstream of
    // that In at the end (the Source's backlog, the belt's slots and staging inbox, and the
    // In itself). Every logged event was fired while its Source would accept it.
    let resting_upstream = |src: NodeId, belt: NodeId, port: u16| {
        source_pending(&final_core, src)
            + match final_core.state.node(belt) {
                Some(Node::Belt(b)) => b.slots.iter().filter(|s| s.is_some()).count(),
                _ => 0,
            }
            + final_core.state.inbox_of(belt).map_or(0, |i| i.len_on(0))
            + final_core.state.inbox_of(bal).map_or(0, |i| i.len_on(port))
    };
    let fired_a = log
        .iter()
        .filter(|e| matches!(e.payload, EventPayload::ManualInject { target, .. } if target == sa))
        .count();
    let fired_b = log.len() - fired_a;
    let left_a = fired_a - resting_upstream(sa, ba, 0);
    let left_b = fired_b - resting_upstream(sb, bb, 1);
    eprintln!(
        "GEN0036 ticks={tick_count} fired_a={fired_a} fired_b={fired_b} left_in0={left_a} left_in1={left_b} \
         sink0={out0} sink1={out1}"
    );
    assert!(left_a > 0 && left_b > 0, "items from BOTH inputs leave the Balancer (In 0 {left_a}, In 1 {left_b})");
    assert!(out0 > 0 && out1 > 0, "both Sinks receive items (Out 0 {out0}, Out 1 {out1})");
    assert_eq!(out0 + out1, left_a + left_b, "every item that left an In reached a Sink");

    freeze(
        &Meta {
            scenario_id: "0036-balancer-both-inputs",
            builder: "core seam: Source A -> belt(1) -> Balancer In 0, Source B -> belt(1) -> Balancer In 1, Balancer Out 0 and Out 1 -> two Debug Sinks; each Source fired one tagged event per tick while it would accept, for 200 ticks, then 100 ticks of drain",
            seed: SEED,
            params: "JAM-01/WINDOWS 175 (87-RESEARCH P175 leg B): a Balancer fed on both inputs drains both. Certifies the board replays identically; the behaviour is graded by no_permanent_jams.rs#a_balancer_drains_both_inputs",
            tick_count,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0037 - ONE SLOW TEE BRANCH DOES NOT STOP THE OTHERS (JAM-02, WINDOWS 174).
///
/// # What this fixture certifies
/// A Source into a two-Out Tee; Out 0 feeds a Debug Sink, Out 1 a 1-tile belt whose head
/// docks nowhere (the slow branch, full after a few items). The Source is fed one event
/// every 2 ticks while it would accept, for `TICKS`. Before plan 87-05 the Tee stalled the
/// moment its slow branch filled, so the healthy Sink starved (87-RESEARCH P174 read 20, 0,
/// 0, 0 per 200 ticks). Since 87-05 the Tee keeps the healthy branch's pace, counts each copy
/// the full branch could not take on `Tee.faults`, and reads FAULTED on every tick it sheds
/// one. The board is `no_permanent_jams.rs#a_slow_tee_branch_does_not_stop_the_others`.
///
/// The generator refuses to freeze unless, on a fresh restore of the frozen genesis, the
/// healthy Sink received at least `FLOOR` items in the second window, `Tee.faults` grew,
/// and the Tee was marked faulted on every tick it shed a copy.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0037-tee-slow-branch"]
fn gen_0037_tee_slow_branch() {
    const SEED: u64 = 0x0037_7EE5;
    const TICKS: u64 = 400;
    const WINDOW: u64 = 200;
    /// The feed is 100 items a window; the probe's floor.
    const FLOOR: usize = 90;

    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let tee = core.state.add_tee(2);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    let slow = core.state.add_belt(1);
    core.state.link((s, 0), (tee, 0));
    core.state.link((tee, 0), (sink, 0));
    core.state.link((tee, 1), (slow, 0));
    let genesis = snapshot::snapshot(&core);

    let mut log: Vec<Event> = Vec::new();
    let mut seq = 0u64;
    for _ in 0..TICKS {
        let t = core.tick;
        let mut evs = Vec::new();
        if t.is_multiple_of(2) && source_pending(&core, s) < SOURCE_PENDING_CAP {
            seq += 1;
            evs.push(fire(s, seq, t, Item(vec![b'T', (seq & 0xFF) as u8])));
        }
        core.advance(&evs);
        log.extend(evs);
    }

    let tee_faults = |core: &Core| match core.state.node(tee) {
        Some(Node::Tee(t)) => t.faults,
        _ => 0,
    };
    let mut windows = vec![0usize; (TICKS / WINDOW) as usize];
    let (mut faults_seen, mut shedding_ticks, mut unmarked) = (0u64, 0usize, 0usize);
    let mut tick = 0u64;
    let final_core = fold_watching(&genesis, &[], &log, TICKS, |core, cmds| {
        windows[(tick / WINDOW) as usize] += sink_emits(cmds, sink);
        let f = tee_faults(core);
        if f > faults_seen {
            shedding_ticks += 1;
            if !core.last_tick.faulted.contains(&tee) {
                unmarked += 1;
            }
            faults_seen = f;
        }
        tick += 1;
    });
    eprintln!(
        "GEN0037 ticks={TICKS} fired={} healthy_per_{WINDOW}={windows:?} tee_faults={} shedding_ticks={shedding_ticks} \
         shedding_unmarked={unmarked}",
        log.len(),
        tee_faults(&final_core),
    );
    for (k, n) in windows.iter().enumerate().skip(1) {
        assert!(*n >= FLOOR, "the healthy branch keeps its pace: window {k} received {n} (windows {windows:?})");
    }
    assert!(tee_faults(&final_core) > 0, "the copies the slow branch could not take are counted on Tee.faults");
    assert_eq!(unmarked, 0, "the Tee reads FAULTED on every tick it sheds a copy");

    freeze(
        &Meta {
            scenario_id: "0037-tee-slow-branch",
            builder: "core seam: Source -> Tee(2); Tee Out 0 -> Debug Sink, Tee Out 1 -> belt(1) whose head docks nowhere; the Source fired one event every 2 ticks while it would accept, for 400 ticks",
            seed: SEED,
            params: "JAM-02/WINDOWS 174 (87-RESEARCH P174): one slow Tee branch does not stop the healthy branch; the shed copies are counted on Tee.faults. Certifies the board replays identically; the behaviour is graded by no_permanent_jams.rs#a_slow_tee_branch_does_not_stop_the_others",
            tick_count: TICKS,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0038 - A REFUSED FAULT STAYS BOUNDED (JAM-03, WINDOWS 176).
///
/// # What this fixture certifies
/// A Source into a Router with no routes and no default, so every item faults; the
/// Router's `FAULT_PORT` docks a 1-tile belt into a Debug Sink. The Source is fed one event
/// per tick while it would accept, and a logged command timeout lands on the Router every 5
/// ticks before `SEED_UNTIL` (resting faults the fold's drain arm carries out). Before plan
/// 87-02 the drain arm did not count in the output gate, so the drain overfilled the fault
/// belt, the refusal wrapped one fault inside another, and the save grew without bound
/// (87-RESEARCH P176b: nesting depth 38, 69 and 131 at ticks 1000, 2000 and 3999). Since
/// 87-02 the gate counts the drain and a refused fault is re-admitted unchanged. The board
/// is `no_permanent_jams.rs`'s `p176b_board`.
///
/// The generator refuses to freeze unless, on a fresh restore of the frozen genesis, no
/// `OutputRefused` fault rests anywhere and no fault rests on the Router's fault port at
/// every 100th tick, while the Sink received faults (the drain ran).
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0038-refused-fault-bounded"]
fn gen_0038_refused_fault_bounded() {
    const SEED: u64 = 0x0038_FA17;
    const TICKS: u64 = 1000;
    const SEED_UNTIL: u64 = 400;

    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let router = core.state.add_router(Vec::new(), None);
    let fault_belt = core.state.add_belt(1);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (router, 0));
    core.state.link((router, FAULT_PORT), (fault_belt, 0));
    core.state.link((fault_belt, 0), (sink, 0));
    let genesis = snapshot::snapshot(&core);

    let mut log: Vec<Event> = Vec::new();
    let mut seq = 0u64;
    let mut timeouts = 0u32;
    for _ in 0..TICKS {
        let t = core.tick;
        let mut evs = Vec::new();
        if source_pending(&core, s) < SOURCE_PENDING_CAP {
            seq += 1;
            evs.push(fire(s, seq, t, Item(vec![b'F', (seq & 0xFF) as u8])));
        }
        if t < SEED_UNTIL && t.is_multiple_of(5) {
            seq += 1;
            evs.push(command_timeout((t, router, timeouts), seq, t));
            timeouts += 1;
        }
        core.advance(&evs);
        log.extend(evs);
    }

    let refused_anywhere = |core: &Core| -> usize {
        core.state
            .node_ids()
            .filter_map(|id| core.state.inbox_of(id))
            .flat_map(|inbox| inbox.items_on(FAULT_PORT))
            .filter(|item| Fault::decode(item).is_ok_and(|f| f.reason == FaultReason::OutputRefused))
            .count()
    };
    let (mut sunk, mut checks, mut refused_checks, mut backlog_checks) = (0usize, 0usize, 0usize, 0usize);
    let mut tick = 0u64;
    let final_core = fold_watching(&genesis, &[], &log, TICKS, |core, cmds| {
        sunk += sink_emits(cmds, sink);
        tick += 1;
        if tick.is_multiple_of(100) {
            checks += 1;
            if refused_anywhere(core) > 0 {
                refused_checks += 1;
            }
            if core.state.inbox_of(router).map_or(0, |i| i.len_on(FAULT_PORT)) > 0 {
                backlog_checks += 1;
            }
        }
    });
    eprintln!(
        "GEN0038 ticks={TICKS} fired={} timeouts={timeouts} sunk={sunk} checks={checks} \
         checks_with_output_refused={refused_checks} checks_with_router_fault_backlog={backlog_checks} \
         snapshot_bytes={}",
        log.len() - timeouts as usize,
        snapshot::snapshot(&final_core).len(),
    );
    assert!(timeouts as usize > FAULT_QUEUE_CAP, "more timeouts were seeded than the fault queue holds");
    assert!(sunk > 0, "the fault drain carried faults to the Sink: an inert board certifies nothing");
    assert_eq!(refused_checks, 0, "no OutputRefused fault rests anywhere at any 100th tick");
    assert_eq!(backlog_checks, 0, "no fault rests on the Router's fault port at any 100th tick");

    freeze(
        &Meta {
            scenario_id: "0038-refused-fault-bounded",
            builder: "core seam: Source -> Router(no routes, no default); Router FAULT_PORT -> belt(1) -> Debug Sink; the Source fired one event per tick while it would accept, and a logged command Timeout on the Router every 5 ticks before tick 400, for 1000 ticks",
            seed: SEED,
            params: "JAM-03/WINDOWS 176 (87-RESEARCH P176b): the fault drain counts in the output gate and a refused fault is never wrapped again, so the board stays bounded. Certifies the board replays identically; the behaviour is graded by no_permanent_jams.rs#the_fault_drain_counts_in_the_gate",
            tick_count: TICKS,
        },
        &genesis,
        &[],
        &log,
    );
}

/// 0039 - A BOARD JAMMED SOLID GOES IDLE, AND AN EDIT RELEASES IT (JAM-04, WINDOWS 177).
///
/// # What this fixture certifies
/// The P177B board: a Source, a 1-tile inlet belt, a two-Out Tee and two 1-tile branch
/// belts whose heads dock nowhere, plus a Debug Sink standing unlinked. 60 events are fired
/// in the first 60 ticks and none after, so the branches, the inlet, the Tee and the
/// Source's backlog fill and nothing can move. Before plans 87-06 and 87-07 every blocked
/// machine and every settled belt was re-scheduled on every tick forever (87-RESEARCH: 2.00
/// machine steps and 3.00 belt steps per tick). Since then the whole board sleeps
/// (`Scheduler.blocked`, which every tick hash covers), and the hashes over the idle span
/// differ only by the tick.
///
/// Once the board has stepped nothing for `IDLE_SPAN` ticks, ONE edit releases it: a
/// `Dock` of the right branch's head into the Sink. An edit wakes every sleeper; the right
/// branch drains, the Tee passes its items on and sheds the copies the still-full left
/// branch cannot take (JAM-02), and the Source's backlog empties into the Sink. The edit is
/// a frozen record like any other, built verbatim (0030's core-seam shape; a fold applies
/// a `Dock` verbatim).
///
/// The generator refuses to freeze unless, on a fresh restore of the frozen genesis, the
/// idle span stepped no node with every board node asleep and `grid_state_bytes` unchanged
/// across it, the edit's tick stepped the Source, and afterwards the Source, inlet and Tee
/// emptied with items at the Sink and the board went idle again.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0039-jammed-solid-goes-idle"]
fn gen_0039_jammed_solid_goes_idle() {
    const SEED: u64 = 0x0039_1D1E;
    const EVENTS: u64 = 60;
    /// Ticks the board must step nothing before the release edit lands.
    const IDLE_SPAN: u64 = 200;
    /// Ticks after the release edit, a budget for the backlog to drain and the board to
    /// sleep again.
    const AFTER: u64 = 300;
    /// The run gives up if the board has not gone idle by this tick.
    const IDLE_BY: u64 = 1200;

    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let feed = core.state.add_belt(1);
    let tee = core.state.add_tee(2);
    let left = core.state.add_belt(1);
    let right = core.state.add_belt(1);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (feed, 0));
    core.state.link((feed, 0), (tee, 0));
    core.state.link((tee, 0), (left, 0));
    core.state.link((tee, 1), (right, 0));
    let genesis = snapshot::snapshot(&core);

    // The event log, then run until the board has stepped nothing for IDLE_SPAN ticks; the
    // release edit lands on the next tick. The tick is read off the run, never guessed.
    let log: Vec<Event> = (0..EVENTS).map(|t| fire(s, t + 1, t, Item(vec![b'J', t as u8]))).collect();
    let mut quiet = 0u64;
    while quiet < IDLE_SPAN {
        assert!(core.tick < IDLE_BY, "the board went idle by tick {IDLE_BY}");
        let t = core.tick;
        let evs: Vec<Event> = log.iter().filter(|e| e.tick == t).cloned().collect();
        core.advance(&evs);
        if t >= EVENTS && core.last_tick.stepped.is_empty() {
            quiet += 1;
        } else {
            quiet = 0;
        }
    }
    let release_tick = core.tick;
    let idle_from = release_tick - IDLE_SPAN;
    let edits = vec![edit_record(
        1,
        release_tick,
        EditOp::Dock { belt: right, endpoint: BeltEnd::Head, node: sink, port: 0 },
    )];
    let tick_count = release_tick + AFTER;

    let board = [s, feed, tee, left, right];
    let (mut idle_stepped, mut idle_awake) = (0usize, 0usize);
    let (mut grid_at_idle_start, mut grid_at_release): (Option<Vec<u8>>, Option<Vec<u8>>) = (None, None);
    let (mut held_before, mut source_stepped_on_release, mut sunk) = (0usize, false, 0usize);
    let mut quiet_tail = 0u64;
    let final_core = fold_watching(&genesis, &edits, &log, tick_count, |core, cmds| {
        let folded = core.tick - 1;
        if (idle_from..release_tick).contains(&folded) {
            idle_stepped += core.last_tick.stepped.len();
            idle_awake += board.iter().filter(|id| !core.sched.is_blocked(**id)).count();
            if folded == idle_from {
                grid_at_idle_start = Some(common::grid_state_bytes(core));
            }
            if folded + 1 == release_tick {
                grid_at_release = Some(common::grid_state_bytes(core));
                held_before = source_pending(core, s);
            }
        }
        if folded == release_tick {
            source_stepped_on_release = core.last_tick.stepped.contains(&s);
        }
        sunk += sink_emits(cmds, sink);
        if core.last_tick.stepped.is_empty() {
            quiet_tail += 1;
        } else {
            quiet_tail = 0;
        }
    });
    let inbox = |id: NodeId| final_core.state.inbox_of(id).map_or(0, |i| i.len_on(0));
    let slots = |id: NodeId| match final_core.state.node(id) {
        Some(Node::Belt(b)) => b.slots.iter().filter(|x| x.is_some()).count(),
        _ => 0,
    };
    let tee_faults = match final_core.state.node(tee) {
        Some(Node::Tee(t)) => t.faults,
        _ => 0,
    };
    eprintln!(
        "GEN0039 release_tick={release_tick} idle_from={idle_from} ticks={tick_count} idle_stepped={idle_stepped} \
         idle_awake={idle_awake} grid_unchanged_over_idle={} source_backlog_before_release={held_before} \
         source_stepped_on_release={source_stepped_on_release} sunk={sunk} after: source={} inlet={} tee_in={} \
         left={} right={} tee_faults={tee_faults} quiet_tail={quiet_tail}",
        grid_at_idle_start == grid_at_release,
        source_pending(&final_core, s),
        slots(feed) + inbox(feed),
        inbox(tee),
        slots(left),
        slots(right) + inbox(right),
    );
    assert_eq!(idle_stepped, 0, "the board jammed solid stepped no node over the idle span");
    assert_eq!(idle_awake, 0, "every board node sat in the sleep set over the idle span");
    assert!(grid_at_idle_start.is_some() && grid_at_idle_start == grid_at_release, "the grid did not change while idle");
    assert!(held_before > 0, "the Source slept holding a backlog (non-vacuity)");
    assert!(source_stepped_on_release, "the release edit woke the Source on its own tick");
    assert!(sunk > held_before, "the backlog and the jammed items reached the Sink after the release");
    assert_eq!(source_pending(&final_core, s) + slots(feed) + inbox(feed) + inbox(tee), 0, "the Source, inlet and Tee emptied");
    assert!(tee_faults > 0, "the Tee shed the copies its still-full left branch could not take");
    assert!(quiet_tail >= 100, "the released board went idle again ({quiet_tail} quiet ticks at the end)");

    freeze(
        &Meta {
            scenario_id: "0039-jammed-solid-goes-idle",
            builder: "core seam: Source -> belt(1) -> Tee(2); Tee Out 0 -> belt(1) and Tee Out 1 -> belt(1), both heads docked nowhere; a Debug Sink unlinked; 60 events at ticks 0 to 59; once the board has stepped nothing for 200 ticks, one Dock(right branch Head -> Sink In) edit; 300 ticks after it",
            seed: SEED,
            params: "JAM-04/WINDOWS 177 (87-RESEARCH P177B): a board jammed solid goes idle (every machine and settled belt asleep, no node stepped), and an edit wakes it and drains it. Certifies the board replays identically; the behaviour is graded by no_permanent_jams.rs#a_board_jammed_solid_goes_idle and #an_edit_wakes_a_blocked_machine",
            tick_count,
        },
        &genesis,
        &edits,
        &log,
    );
}

/// 0040 - A FACTORY THAT EMITS TWICE ON ONE PORT DELIVERS BOTH (JAM-05, WINDOWS 165).
///
/// # What this fixture certifies
/// A Source into a Factory whose JS calls `ctx.emit(0, input)` twice, the Factory's Out 0
/// into a 1-tile belt into a Debug Sink. The Source is fed one event per tick while it would
/// accept, for `FEED_TICKS`, then the board drains. Before plan 87-04 the second emit of a
/// pass was refused when the port's destination had room for one, so it rested on the
/// Factory as an `OutputRefused` fault (87-RESEARCH P165: 347 delivered of 1200). Since 87-04
/// the extra emits wait in `Factory.pending_emits` and leave one per port per pass. The
/// board is `no_permanent_jams.rs#a_factory_that_emits_twice_delivers_both`.
///
/// The generator refuses to freeze unless, on a fresh restore of the frozen genesis, the
/// Sink received exactly twice the events the Source took, the queue was used, no
/// `OutputRefused` ever rested on the Factory, `Factory.faults` stayed 0, and the board
/// emptied inside the run.
#[test]
#[ignore = "corpus generator: run explicitly via scripts/regen-golden.sh new|bless 0040-factory-two-emits"]
fn gen_0040_factory_two_emits() {
    const SEED: u64 = 0x0040_2E17;
    const FEED_TICKS: u64 = 120;
    /// The run's length: measured, the board empties at tick 285; the rest is idle margin.
    const TICKS: u64 = 400;
    const TWICE_JS: &str = "export default function (input, ctx) { ctx.emit(0, input); ctx.emit(0, input); }";

    let mut core = Core::genesis(header(SEED));
    let s = core.state.add_source();
    let factory = core
        .state
        .add_factory(TWICE_JS.to_owned(), fabrico_core::factory::DEFAULT_GAS_BUDGET, 7);
    let belt = core.state.add_belt(1);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (factory, 0));
    core.state.link((factory, 0), (belt, 0));
    core.state.link((belt, 0), (sink, 0));
    let genesis = snapshot::snapshot(&core);

    let mut log: Vec<Event> = Vec::new();
    let mut seq = 0u64;
    for _ in 0..FEED_TICKS {
        let t = core.tick;
        let mut evs = Vec::new();
        if source_pending(&core, s) < SOURCE_PENDING_CAP {
            seq += 1;
            // The item is the event's sequence as JSON text: a Factory's input is decoded as
            // JSON, so a non-JSON item would fault in the decode and never reach the code.
            evs.push(fire(s, seq, t, Item(seq.to_string().into_bytes())));
        }
        core.advance(&evs);
        log.extend(evs);
    }

    let refused_on_factory = |core: &Core| {
        core.state.inbox_of(factory).map_or(0, |inbox| {
            inbox
                .items_on(FAULT_PORT)
                .filter(|item| Fault::decode(item).is_ok_and(|f| f.reason == FaultReason::OutputRefused))
                .count()
        })
    };
    let queued = |core: &Core| match core.state.node(factory) {
        Some(Node::Factory(f)) => f.pending_emits.values().map(|q| q.len()).sum::<usize>(),
        _ => 0,
    };
    let (mut delivered, mut max_refused, mut max_queued) = (0usize, 0usize, 0usize);
    let mut empty_at: Option<u64> = None;
    let final_core = fold_watching(&genesis, &[], &log, TICKS, |core, cmds| {
        delivered += sink_emits(cmds, sink);
        max_refused = max_refused.max(refused_on_factory(core));
        max_queued = max_queued.max(queued(core));
        let empty = source_pending(core, s) == 0
            && queued(core) == 0
            && [factory, belt, sink].iter().all(|id| core.state.inbox_of(*id).map_or(0, |i| i.len_on(0)) == 0)
            && matches!(core.state.node(belt), Some(Node::Belt(b)) if b.slots.iter().all(|x| x.is_none()));
        if core.tick > FEED_TICKS && empty && empty_at.is_none() {
            empty_at = Some(core.tick);
        }
    });
    let faults = match final_core.state.node(factory) {
        Some(Node::Factory(f)) => f.faults,
        _ => u64::MAX,
    };
    let injected = log.len();
    eprintln!(
        "GEN0040 ticks={TICKS} injected={injected} delivered={delivered} expected={} max_queued={max_queued} \
         max_refused_on_factory={max_refused} factory_faults={faults} empty_at={empty_at:?}",
        2 * injected,
    );
    assert_eq!(delivered, 2 * injected, "every one of the two emits per event arrives");
    assert!(max_queued > 0, "the second emits waited in Factory.pending_emits (the queue was used)");
    assert_eq!(max_refused, 0, "no OutputRefused ever rests on the Factory");
    assert_eq!(faults, 0, "Factory.faults stays 0");
    assert!(empty_at.is_some(), "the board emptied inside the run");

    freeze(
        &Meta {
            scenario_id: "0040-factory-two-emits",
            builder: "core seam: Source -> Factory(JS: ctx.emit(0, input) twice) -> belt(1) -> Debug Sink; the Source fired one event per tick while it would accept, for 120 ticks, then the board drains to 400 ticks",
            seed: SEED,
            params: "JAM-05/WINDOWS 165 (87-RESEARCH P165): a Factory that emits twice on one port delivers both, the extra emit waiting in Factory.pending_emits. Certifies the board replays identically; the behaviour is graded by no_permanent_jams.rs#a_factory_that_emits_twice_delivers_both",
            tick_count: TICKS,
        },
        &genesis,
        &[],
        &log,
    );
}
