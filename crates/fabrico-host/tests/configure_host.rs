//! Phase 39-04 — the two HOST-SIDE halves of certified config that must NOT enter
//! the frozen snapshot:
//!
//! - the blake3 `code_hash` STAMP: `apply_gesture` overwrites a resolved
//!   `EditOp::Configure{ Factory{source} }`'s `code_hash` (the command layer emits
//!   `[0;32]`) with `blake3(source.as_bytes())` before enqueue. Deterministic, opaque
//!   to the core; a non-Factory config keeps `[0;32]`.
//! - the Source Timer PROJECTION (`project_timers`): a host projection that scans the
//!   certified edit-log for the LATEST live `Configure{Source, Timer}` per node and
//!   builds a `TimerSet` that injects LOGGED, replay-identical events (never a live
//!   clock), plus the mutable `Host::set_timers` setter the sim-loop wiring calls.
//!
//! Everything drives through the real `apply_gesture` seam over a tempdir-backed
//! `Host` (mirrors `tests/ingress.rs`), reading the persisted edit-log back with
//! `host.logged_edits()`.

use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{
    EditOp, EditRecord, MachineConfig as CoreConfig, SourceTrigger as CoreTrigger,
};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::ingress::timer::{project_timers, TimerSet};
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::save_project;
use fabrico_host::render_packet::{RenderPacketBuilder, RenderProducer};
use fabrico_host::sim_loop::{ControlMsg, GestureSink, GestureTx, SimLoop, gesture_channel};
use fabrico_protocol::{machine_kind, GridCommand, MachineConfig, SinkTemplate, SourceTrigger};
use slotmap::Key;
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;

const NEW_JS: &str = "export default (x) => x + 1";

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 7,
    }
}

/// A real `Host` over tempfile redb stores (mirrors `tests/ingress.rs`).
fn test_host() -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    (dir, host)
}

/// Open a genesis `Host` over the redb stores in `dir` (reusable across a
/// drop-and-reopen "restart"/Load — the persisted logs live in `dir`).
fn host_over(dir: &std::path::Path) -> Host {
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    Host::new(core, store, ledger, None).expect("open host")
}

/// Count the logged `ManualInject` events targeting `source`.
fn injects_for(host: &Host, source: NodeId) -> usize {
    host.logged_events()
        .expect("read log")
        .iter()
        .filter(|e| matches!(&e.payload, EventPayload::ManualInject { target, .. } if *target == source))
        .count()
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

/// Place a machine of `kind` via a real gesture, fold it, and return its minted id.
fn place(
    host: &mut Host,
    ingress_rx: &mut UnboundedReceiver<EventPayload>,
    results_rx: &mut UnboundedReceiver<ResultEvent>,
    cmd_tx: &UnboundedSender<Command>,
    kind: u8,
    cell_x: i32,
    cell_y: i32,
) -> NodeId {
    apply_gesture(host, GridCommand::Place { kind, cell_x, cell_y }, |_h| None)
        .expect("place at a free cell");
    host.tick_once(ingress_rx, results_rx, cmd_tx)
        .expect("tick folds the placed node");
    *host
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placed node minted an id")
}

/// Apply a Configure gesture targeting `id` (via a fixed handle -> id resolve) and
/// fold it.
fn configure(
    host: &mut Host,
    ingress_rx: &mut UnboundedReceiver<EventPayload>,
    results_rx: &mut UnboundedReceiver<ResultEvent>,
    cmd_tx: &UnboundedSender<Command>,
    id: NodeId,
    config: MachineConfig,
) {
    // The dense handle value is irrelevant to the test; the resolve closure maps our
    // chosen handle (0) to the target id (mirrors `input_apply`'s `resolve` argument).
    apply_gesture(
        host,
        GridCommand::Configure { node: 0, config },
        move |h| (h == 0).then_some(id),
    )
    .expect("Configure accepted");
    host.tick_once(ingress_rx, results_rx, cmd_tx)
        .expect("tick folds the Configure");
}

/// The last logged `EditOp::Configure` record's `code_hash` (the host-stamped value).
fn last_configure_hash(host: &Host) -> [u8; 32] {
    match &host
        .logged_edits()
        .expect("read edit-log")
        .iter()
        .rev()
        .find(|r| matches!(r.op, EditOp::Configure { .. }))
        .expect("a Configure record exists")
        .op
    {
        EditOp::Configure { code_hash, .. } => *code_hash,
        _ => unreachable!(),
    }
}

#[test]
fn configure_code_hash_stamped() {
    // A Configure{Factory{source}} driven through the host yields a logged EditRecord
    // whose code_hash equals blake3(source bytes) — the host stamp overwrote the
    // command layer's [0;32] fence value.
    let (_dir, mut host) = test_host();
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();

    let factory = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::FACTORY, 0, 0);
    configure(
        &mut host,
        &mut ingress_rx,
        &mut results_rx,
        &cmd_tx,
        factory,
        MachineConfig::Factory { source: NEW_JS.to_string() },
    );

    let expected = *blake3::hash(NEW_JS.as_bytes()).as_bytes();
    assert_eq!(
        last_configure_hash(&host),
        expected,
        "the host stamps the code_hash with blake3 of the EXACT Factory JS bytes",
    );
    assert_ne!(
        last_configure_hash(&host),
        [0u8; 32],
        "the stamp overwrote the command-layer [0;32] fence",
    );
}

#[test]
fn undo_factory_configure_restamps_code_hash() {
    // F2 — undo-factory-configure-unstamped-code-hash: undoing a Factory Configure
    // enqueues a COMPENSATING Configure carrying the PRIOR source. `compute_inverse`
    // emits it with the [0;32] blake3 fence; the host MUST re-stamp it with
    // blake3(prior source) on the Undo enqueue path — otherwise a REAL handler persists
    // under a zeroed certification hash (a CFG-02 invariant violation).
    const SRC_A: &str = "export default (x) => x + 1";
    const SRC_B: &str = "export default (x) => x + 2";
    let (_dir, mut host) = test_host();
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();

    let factory = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::FACTORY, 0, 0);
    // Configure A (the prior), then Configure B (the current) — each its own undo step.
    configure(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, factory,
        MachineConfig::Factory { source: SRC_A.to_string() });
    configure(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, factory,
        MachineConfig::Factory { source: SRC_B.to_string() });
    assert_eq!(
        last_configure_hash(&host),
        *blake3::hash(SRC_B.as_bytes()).as_bytes(),
        "the forward Configure B is stamped with blake3(B)",
    );

    // Undo the B config -> a compensating Configure back to source A. The Undo route
    // returns before the forward stamp block, so the host stamps the group itself.
    apply_gesture(&mut host, GridCommand::Undo, |_h| None).expect("undo is accepted");
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
        .expect("tick folds the undo group");

    let expected = *blake3::hash(SRC_A.as_bytes()).as_bytes();
    assert_eq!(
        last_configure_hash(&host),
        expected,
        "the undo's compensating Configure is re-stamped with blake3(prior source A)",
    );
    assert_ne!(
        last_configure_hash(&host),
        [0u8; 32],
        "the host stamp overwrote the compute_inverse [0;32] fence on the undo path (F2)",
    );
}

#[test]
fn configure_source_config_hash_zeroed() {
    // A Source config (and a Sink config) carries no JS -> the host leaves code_hash at
    // [0;32] (only a Factory config is stamped).
    let (_dir, mut host) = test_host();
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();

    let source = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::SOURCE, 0, 0);
    configure(
        &mut host,
        &mut ingress_rx,
        &mut results_rx,
        &cmd_tx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Webhook },
    );
    assert_eq!(last_configure_hash(&host), [0u8; 32], "a Source config keeps [0;32]");

    let sink = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::SINK, 2, 0);
    configure(
        &mut host,
        &mut ingress_rx,
        &mut results_rx,
        &cmd_tx,
        sink,
        MachineConfig::Sink { target: SinkTemplate::Debug },
    );
    assert_eq!(last_configure_hash(&host), [0u8; 32], "a Sink config keeps [0;32]");
}

#[test]
fn stamp_is_deterministic() {
    // Two INDEPENDENT hosts stamping the same JS bytes produce the identical code_hash
    // (a pure function of the bytes — the core stores them opaquely).
    let stamp_once = || {
        let (_dir, mut host) = test_host();
        let (mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let factory = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::FACTORY, 0, 0);
        configure(
            &mut host,
            &mut ingress_rx,
            &mut results_rx,
            &cmd_tx,
            factory,
            MachineConfig::Factory { source: NEW_JS.to_string() },
        );
        let hash = last_configure_hash(&host);
        drop(_dir);
        hash
    };
    assert_eq!(
        stamp_once(),
        stamp_once(),
        "the same JS bytes stamp to the same code_hash across independent applies",
    );
}

// ---------------------------------------------------------------------------------
// Task 2: project_timers (edit-log -> TimerSet) + Host::set_timers
// ---------------------------------------------------------------------------------

/// A minimal `EditOp::Configure{Source, trigger}` record targeting `node` (the
/// stamp/action fields are irrelevant to `project_timers`, which reads only the op).
fn source_configure(node: NodeId, trigger: CoreTrigger) -> EditRecord {
    EditRecord {
        schema_version: 0,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::Configure {
            node,
            config: CoreConfig::Source { trigger },
            code_hash: [0u8; 32],
        },
    }
}

#[test]
fn project_timers_maps_timer() {
    // A one-record edit-log configuring Source A with Timer{5} yields a TimerSet whose
    // single entry injects the fixed b"{}" payload into A on the multiples of 5.
    let (_dir, mut host) = test_host();
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();
    let source = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::SOURCE, 0, 0);
    configure(
        &mut host,
        &mut ingress_rx,
        &mut results_rx,
        &cmd_tx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 5 } },
    );

    let timers = project_timers(&host.logged_edits().expect("read edit-log"));
    let mut seq = 0u64;
    let mut fired = Vec::new();
    for tick in 0..10u64 {
        for ev in timers.due_events(tick, &mut seq, |_| true) {
            match ev.payload {
                EventPayload::ManualInject { target, item, .. } => {
                    assert_eq!(target, source, "injects into the configured source");
                    assert_eq!(item.0, b"{}".to_vec(), "the fixed b\"{{}}\" payload rides the timer");
                    fired.push(tick);
                }
                other => panic!("expected ManualInject, got {other:?}"),
            }
        }
    }
    assert_eq!(fired, vec![0, 5], "the projected timer fires on exactly the multiples of 5");
}

#[test]
fn project_timers_latest_wins() {
    // Latest-wins + Webhook-removes + interval-0-no-entry, all deterministic.
    let mut alloc: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
    let a = alloc.insert(());
    let b = alloc.insert(());
    let c = alloc.insert(());

    // A: Timer{3} then Timer{7} -> latest interval 7 wins.
    // B: Timer{4} then Webhook   -> removed entirely.
    // C: Timer{0}                -> degenerate interval, no entry.
    let log = vec![
        source_configure(a, CoreTrigger::Timer { interval_ticks: 3 }),
        source_configure(b, CoreTrigger::Timer { interval_ticks: 4 }),
        source_configure(a, CoreTrigger::Timer { interval_ticks: 7 }),
        source_configure(b, CoreTrigger::Webhook),
        source_configure(c, CoreTrigger::Timer { interval_ticks: 0 }),
    ];

    let timers = project_timers(&log);
    let mut seq = 0u64;
    // Tick 0 fires every live timer; only A is live (B webhook-removed, C interval-0).
    let due0: Vec<NodeId> = timers
        .due_events(0, &mut seq, |_| true)
        .into_iter()
        .map(|e| match e.payload {
            EventPayload::ManualInject { target, .. } => target,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(due0, vec![a], "only A is live, so only A fires at tick 0");

    // A's interval is 7 (latest wins): it fires at 7, never at 3 (nor ticks 1..7).
    let mut a_ticks = Vec::new();
    for tick in 1..8u64 {
        if !timers.due_events(tick, &mut seq, |_| true).is_empty() {
            a_ticks.push(tick);
        }
    }
    assert_eq!(a_ticks, vec![7], "A's latest interval 7 wins (not the earlier 3)");
}

#[test]
fn project_timers_drops_deleted_node() {
    // F1 — TIMER-DELETE-LEAK: a Source configured with Timer{1} then DELETED must NOT
    // keep projecting a timer. Pre-fix `project_timers` only read `Configure` records
    // and (the log being append-only) re-derived the dead node's interval forever, so
    // `due_events` injected a `ManualInject` into the deleted node every tick. The
    // Delete arm removes it: `interval_for(N) == None` and `due_events` yields nothing.
    let (_dir, mut host) = test_host();
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();

    let source = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::SOURCE, 0, 0);
    configure(
        &mut host,
        &mut ingress_rx,
        &mut results_rx,
        &cmd_tx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 1 } },
    );

    // While the source is live the timer projects (interval 1).
    let before = project_timers(&host.logged_edits().expect("read edit-log"));
    assert_eq!(before.interval_for(source), Some(1), "the timer projects while the source is live");

    // Delete the source via a real gesture (handle 0 -> source), then fold it.
    apply_gesture(&mut host, GridCommand::Delete { node: 0 }, move |h| (h == 0).then_some(source))
        .expect("delete the source is accepted");
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
        .expect("tick folds the Delete");
    assert!(
        host.core().state.node(source).is_none(),
        "the Delete removed the source node from the topology",
    );

    // After the delete the projection drops the node entirely.
    let after = project_timers(&host.logged_edits().expect("read edit-log"));
    assert_eq!(after.interval_for(source), None, "a deleted node's timer stops projecting (F1)");
    let mut seq = 0u64;
    for tick in 0..20u64 {
        assert!(
            after.due_events(tick, &mut seq, |_| true).is_empty(),
            "no perpetual inject into the dead node after its Delete (tick {tick})",
        );
    }
}

#[test]
fn projected_timerset_replay_identical() {
    // The TimerSet from project_timers, driven via due_events, reads NO clock; two
    // independent runs produce byte-identical injected events (replay-identical).
    let mut alloc: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
    let a = alloc.insert(());
    let log = vec![source_configure(a, CoreTrigger::Timer { interval_ticks: 3 })];

    let run = || {
        let timers = project_timers(&log);
        let mut seq = 0u64;
        let mut all = Vec::new();
        for tick in 0..30u64 {
            all.extend(timers.due_events(tick, &mut seq, |_| true));
        }
        all
    };
    let run_a = run();
    let run_b = run();
    assert_eq!(run_a, run_b, "two independent projections inject byte-identical events");
    let fired: Vec<u64> = run_a.iter().map(|e| e.tick).collect();
    let expected: Vec<u64> = (0..30u64).filter(|t| t.is_multiple_of(3)).collect();
    assert_eq!(fired, expected, "injects on exactly the multiples of the interval, no clock");
}

#[test]
fn set_timers_swaps() {
    // Host::set_timers replaces the live timer set: a subsequent tick uses the NEW
    // intervals (beside the build-once with_timers).
    let (_dir, mut host) = test_host();
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();
    let source = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::SOURCE, 0, 0);
    configure(
        &mut host,
        &mut ingress_rx,
        &mut results_rx,
        &cmd_tx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 1 } },
    );

    // Default host has an EMPTY timer set — nothing injected yet.
    let before = injects_for(&host, source);

    // Swap in the projected TimerSet (interval 1 -> fires every tick).
    let timers: TimerSet = project_timers(&host.logged_edits().expect("read edit-log"));
    assert!(!timers.is_empty(), "the projected TimerSet has the interval-1 entry");
    host.set_timers(timers);

    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("tick with swapped timers");
    assert_eq!(
        injects_for(&host, source),
        before + 1,
        "set_timers swapped in the live set -> one injection this tick",
    );
}

#[test]
fn timer_projection_survives_load() {
    // Pitfall 5, the SILENT-TIMER landmine: a configured timer MUST keep firing after
    // a save/Load (host-swap). This plan ships the two primitives that close it —
    // `project_timers` (re-scan the LOADED edit-log) + `set_timers` (install the
    // rebuilt set). This test proves them at the host level: after a genuine
    // drop-and-reopen over the SAME persisted redb (a restart/Load), a host that does
    // NOT re-project is silent (the landmine), and re-projecting from the reloaded
    // edit-log restores firing. (The 39-06 sim-loop wires this into ControlMsg::Load.)
    let dir = tempfile::tempdir().expect("tempdir");
    let source;

    // --- Pre-save: place a Source, configure a Timer{1}; persist the edit-log. ---
    {
        let mut host = host_over(dir.path());
        let (mut ingress_rx, cmd_tx, mut results_rx) = channels();
        source = place(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx, machine_kind::SOURCE, 0, 0);
        configure(
            &mut host,
            &mut ingress_rx,
            &mut results_rx,
            &cmd_tx,
            source,
            MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 1 } },
        );
        // Host dropped here -> releases the redb file locks (models a restart/Load).
    }

    // --- Load: reopen the SAME redb, recover() re-folds the edit-log (re-minting the
    //     SAME source id), then rebuild the timer projection from the LOADED log. ---
    let mut host = host_over(dir.path());
    host.recover().expect("recover from the persisted logs");
    // The source re-mints deterministically to the same id (slotmap insertion order).
    assert!(
        host.core().state.node(source).is_some(),
        "recover re-folded the Place edit, re-minting the SAME source id",
    );
    let (mut ingress_rx, cmd_tx, mut results_rx) = channels();
    let after_load = injects_for(&host, source);

    // THE LANDMINE: a reloaded host has a DEFAULT (empty) timer set — without a
    // re-projection, a tick injects nothing (a run continued from a save would
    // diverge from an uninterrupted run).
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("silent tick");
    assert_eq!(
        injects_for(&host, source),
        after_load,
        "without a re-projection the reloaded timer is SILENT (the Pitfall 5 landmine)",
    );

    // THE FIX: re-scan the LOADED edit-log and install the rebuilt TimerSet.
    let timers = project_timers(&host.logged_edits().expect("read edit-log"));
    assert!(!timers.is_empty(), "the timer projected from the LOADED edit-log survives the reload");
    host.set_timers(timers);

    let before = injects_for(&host, source);
    host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("tick after re-projection");
    assert_eq!(
        injects_for(&host, source),
        before + 1,
        "the configured timer keeps firing after save/Load once re-projected (landmine closed)",
    );
}

// =================================================================================
// Phase 39-06 — the sim-loop wiring: the three tick-boundary query ControlMsgs
// (QueryConfig / QueryWebhookUrl / ValidateFactoryJs) and the timer re-projection on
// a Configure fold + on a real ControlMsg::Load host-swap. These drive the REAL
// `SimLoop` (control channel + oneshot replies + gesture channel) rather than a bare
// `Host`, exercising the production seam end-to-end.
// =================================================================================

/// A well-formed Factory module (compiles under `FactoryRuntime::build_default`).
const GOOD_JS: &str = "export default function (input, ctx) { return input; }";

/// A dedicated multi-thread runtime for the off-sim-thread executor consumer
/// `SimLoop::new` spawns (mirrors the sim_loop internal tests). MUST outlive the loop.
fn test_rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("build executor runtime")
}

/// The offline-safe host config (loopback ephemeral port).
fn sim_cfg() -> HostConfig {
    HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("loopback addr"),
    }
}

/// Place a machine of `kind` via a real gesture through the loop, fold it one tick,
/// and return its minted id (the `producer.on_tick` after the fold assigns its render
/// handle, so `sim.handle_for_node` is valid immediately after).
fn place_g(
    sim: &mut SimLoop,
    gtx: &GestureTx,
    kind: u8,
    cell_x: i32,
    cell_y: i32,
) -> NodeId {
    gtx.send_gesture(GridCommand::Place { kind, cell_x, cell_y })
        .expect("send place gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the placed node");
    *sim.host()
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placed node minted an id")
}

/// Apply a Configure gesture targeting `id` through the loop (resolving the render
/// handle the sim path uses) and fold it one tick.
fn configure_g(
    sim: &mut SimLoop,
    gtx: &GestureTx,
    id: NodeId,
    config: MachineConfig,
) {
    let handle = sim.handle_for_node(id).expect("the placed node has a render handle");
    gtx.send_gesture(GridCommand::Configure { node: handle, config })
        .expect("send configure gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the Configure");
}

/// Drive a `QueryConfig` over the control channel and return the tick-boundary reply.
fn query_config(
    sim: &mut SimLoop,
    ctx: &UnboundedSender<ControlMsg>,
    handle: u64,
) -> Option<CoreConfig> {
    let (reply, mut rx) = oneshot::channel();
    ctx.send(ControlMsg::QueryConfig { node: handle, reply })
        .expect("send QueryConfig");
    sim.run(Some(1), Duration::ZERO).expect("service the query at the tick boundary");
    rx.try_recv().expect("the query replied within the serviced step")
}

#[test]
fn query_machine_config_factory() {
    // After a Configure swaps a Factory.source, QueryConfig replies Factory{ source }.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let factory = place_g(&mut sim, &gtx, machine_kind::FACTORY, 0, 0);
    configure_g(
        &mut sim,
        &gtx,
        factory,
        MachineConfig::Factory { source: NEW_JS.to_string() },
    );

    let handle = sim.handle_for_node(factory).expect("factory handle");
    assert_eq!(
        query_config(&mut sim, &ctx, handle),
        Some(CoreConfig::Factory { source: NEW_JS.to_string() }),
        "QueryConfig reads the CURRENT Factory source off core.state",
    );
}

#[test]
fn query_machine_config_sink() {
    // QueryConfig for a Sink replies with the current Sink.template.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let sink = place_g(&mut sim, &gtx, machine_kind::SINK, 0, 0);
    configure_g(
        &mut sim,
        &gtx,
        sink,
        MachineConfig::Sink { target: SinkTemplate::Debug },
    );

    let handle = sim.handle_for_node(sink).expect("sink handle");
    assert!(
        matches!(
            query_config(&mut sim, &ctx, handle),
            Some(CoreConfig::Sink { target: fabrico_core::state::SinkTemplate::Debug }),
        ),
        "QueryConfig reads the CURRENT Sink template off core.state",
    );
}

#[test]
fn query_machine_config_source_trigger() {
    // A Source's config MERGES the host Timer projection (NOT a snapshot read): the
    // Webhook default before any config, Timer{interval} after a Configure{Timer}.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let source = place_g(&mut sim, &gtx, machine_kind::SOURCE, 0, 0);
    let handle = sim.handle_for_node(source).expect("source handle");

    // Before any Configure: the projection has no entry -> Webhook default.
    assert_eq!(
        query_config(&mut sim, &ctx, handle),
        Some(CoreConfig::Source { trigger: CoreTrigger::Webhook }),
        "an unconfigured Source reports the Webhook default trigger",
    );

    // After Configure{Timer{5}}: the merged trigger reflects the host projection.
    configure_g(
        &mut sim,
        &gtx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 5 } },
    );
    assert_eq!(
        query_config(&mut sim, &ctx, handle),
        Some(CoreConfig::Source { trigger: CoreTrigger::Timer { interval_ticks: 5 } }),
        "QueryConfig for a Source merges the host Timer projection (not a snapshot field)",
    );
}

// =================================================================================
// Phase 68-01 (BELT-02): the Belt read-back arm of `SimLoop::machine_config`.
//
// Before this plan the arm was `Node::Belt(_) => None` with a comment naming Phase 68
// as its owner. A `None` config is not a cosmetic gap: `ConfigPanel` gates both Apply
// and Revert on `!loading && config`, so a belt panel over a null config renders a body
// the user can never commit. The four cases below are the arm's contract.
// =================================================================================

/// Draw a belt through the loop with a real `DrawBelt` gesture, fold it one tick, and
/// return its minted id. `fold_draw_belt` pushes the minted belt into
/// `last_tick.placed` exactly as `fold_place` does for a machine, so this is the
/// `place_g` shape with the belt gesture in place of `Place`.
fn draw_belt_g(sim: &mut SimLoop, gtx: &GestureTx, cells: &[(i32, i32)]) -> NodeId {
    gtx.send_gesture(GridCommand::DrawBelt { cells: cells.to_vec() })
        .expect("send draw-belt gesture");
    sim.run(Some(1), Duration::ZERO).expect("fold the drawn belt");
    *sim.host()
        .core()
        .last_tick
        .placed
        .last()
        .expect("the drawn belt minted an id")
}

/// The `ticks_per_slot` a render packet built from `sim`'s CURRENT core state reports
/// for `belt`: the OTHER producer of the same core field, reached through the public
/// packet builder rather than through `machine_config`.
///
/// A fresh `RenderPacketBuilder` mints its own handle table, so the handle is read back
/// off the same builder that produced the packet; it is deliberately NOT assumed equal
/// to the sim loop's handle for the same node.
fn packet_ticks_per_slot(sim: &SimLoop, belt: NodeId) -> u32 {
    let mut builder = RenderPacketBuilder::new();
    let pkt = builder.build_keyframe(sim.host());
    let handle = builder
        .handle_for_node(belt)
        .expect("the keyframe emitted the belt, so it has a handle");
    pkt.belts
        .iter()
        .find(|b| b.id == handle)
        .expect("the drawn belt is in the keyframe")
        .ticks_per_slot
}

#[test]
fn query_machine_config_belt_answers_the_default_pace() {
    // Case 1. A belt at the crate default answers `Some(Belt{ticks_per_slot})`, not
    // `None`. This is the whole reason the arm exists: `ConfigPanel` gates Apply and
    // Revert on `!loading && config`, so `None` here is a panel with no way to commit.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let belt = draw_belt_g(&mut sim, &gtx, &[(1, 1), (2, 1)]);
    let handle = sim.handle_for_node(belt).expect("belt handle");

    assert_eq!(
        query_config(&mut sim, &ctx, handle),
        Some(CoreConfig::Belt { ticks_per_slot: DEFAULT_TICKS_PER_SLOT }),
        "an unconfigured belt reads back its OWN live interval, not None",
    );
}

#[test]
fn query_machine_config_belt_tracks_a_configured_pace() {
    // Case 2. After a logged Configure moves the belt off the default, the read-back
    // answers the NEW value: it tracks the fold, it is not a snapshot taken at mint.
    // 7 is a TEST literal, not a proposed pace (`62-CONTEXT.md` D-19), and it is
    // asserted as the number typed here rather than derived from the crate default: a
    // derived expectation agrees with the constant at every value.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let belt = draw_belt_g(&mut sim, &gtx, &[(1, 1), (2, 1)]);
    let handle = sim.handle_for_node(belt).expect("belt handle");
    assert_ne!(
        DEFAULT_TICKS_PER_SLOT.get(),
        7,
        "the configured value must differ from the default, or case 2 cannot fail",
    );

    configure_g(&mut sim, &gtx, belt, MachineConfig::Belt { ticks_per_slot: 7 });

    assert_eq!(
        query_config(&mut sim, &ctx, handle),
        Some(CoreConfig::Belt {
            ticks_per_slot: NonZeroU32::new(7).expect("7 is non-zero"),
        }),
        "the read-back follows the Configure fold, not the belt's minting default",
    );
}

#[test]
fn belt_config_read_back_equals_the_render_packets_pace() {
    // Case 3: the two-sources rule (68-UI-SPEC 3.3), the load-bearing case.
    //
    // `SimLoop::machine_config` and `render_packet::build` read the SAME core field by
    // two independent paths. A divergence between them is invisible to either one
    // alone: the panel would show one pace while the belt's tread painted another.
    //
    // The assertion is EQUALITY between the two readings, taken from ONE core state in
    // ONE run, deliberately not "both are non-zero", which two producers that disagree
    // satisfy just as well. No tick runs between the two readings, so neither can be
    // looking at a state the other never saw.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let belt = draw_belt_g(&mut sim, &gtx, &[(1, 1), (2, 1)]);
    let handle = sim.handle_for_node(belt).expect("belt handle");

    // Move the belt OFF the default first. At the default both producers agree with any
    // hard-coded projection, so a default-only comparison is a check that cannot fail.
    configure_g(&mut sim, &gtx, belt, MachineConfig::Belt { ticks_per_slot: 11 });

    // Reading A: the config read-back. `query_config` services the query at the next
    // tick boundary and returns.
    let from_config = match query_config(&mut sim, &ctx, handle) {
        Some(CoreConfig::Belt { ticks_per_slot }) => ticks_per_slot.get(),
        other => panic!("expected a Belt config for a belt handle, got {other:?}"),
    };
    // Reading B: the render packet, built from `sim.host()` - the same core, no tick in
    // between.
    let from_packet = packet_ticks_per_slot(&sim, belt);

    assert_eq!(
        from_config, from_packet,
        "one core state, two producers: the config read-back ({from_config}) and the \
         render packet ({from_packet}) must report the SAME belt pace",
    );
    assert_eq!(
        from_config, 11,
        "and both must report the value the Configure actually wrote",
    );
}

#[test]
fn the_belt_arm_did_not_swallow_a_sibling_kind() {
    // Case 4. The new arm was ADDED, not widened. A Sink on the same board still
    // answers its own arm and a belt still answers Belt, which is the property a
    // `_ =>` catch-all would quietly destroy, and the reason `machine_config`'s match
    // stays exhaustive (`command_error_view.rs:126-133`).
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let sink = place_g(&mut sim, &gtx, machine_kind::SINK, 0, 0);
    configure_g(&mut sim, &gtx, sink, MachineConfig::Sink { target: SinkTemplate::Debug });
    let belt = draw_belt_g(&mut sim, &gtx, &[(4, 4), (5, 4)]);

    let sink_handle = sim.handle_for_node(sink).expect("sink handle");
    let belt_handle = sim.handle_for_node(belt).expect("belt handle");
    assert_ne!(sink_handle, belt_handle, "two nodes, two distinct handles");

    assert!(
        matches!(
            query_config(&mut sim, &ctx, sink_handle),
            Some(CoreConfig::Sink { target: fabrico_core::state::SinkTemplate::Debug }),
        ),
        "the Sink arm still answers Sink after the Belt arm was added",
    );
    assert!(
        matches!(query_config(&mut sim, &ctx, belt_handle), Some(CoreConfig::Belt { .. })),
        "and the belt handle answers Belt, so the two arms are distinct",
    );
}

#[test]
fn query_validate_factory_js_ok_and_reject() {
    // ValidateFactoryJs replies Ok for compilable JS and Err(message) for a syntax
    // error — and enqueues NOTHING either way (no edit is logged by the pre-check).
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (_gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let edits_before = sim.host().logged_edits().expect("read edit-log").len();

    let (reply_ok, mut rx_ok) = oneshot::channel();
    ctx.send(ControlMsg::ValidateFactoryJs { source: GOOD_JS.to_string(), reply: reply_ok })
        .expect("send validate ok");
    let (reply_bad, mut rx_bad) = oneshot::channel();
    ctx.send(ControlMsg::ValidateFactoryJs {
        source: "export default function (".to_string(),
        reply: reply_bad,
    })
    .expect("send validate bad");
    sim.run(Some(1), Duration::ZERO).expect("service both validates");

    assert_eq!(
        rx_ok.try_recv().expect("ok reply"),
        Ok(()),
        "compilable JS validates Ok",
    );
    let err = rx_bad.try_recv().expect("err reply");
    assert!(err.is_err(), "a syntax error validates Err(message)");
    assert!(
        !err.unwrap_err().is_empty(),
        "the reject carries a diagnostic message",
    );

    assert_eq!(
        sim.host().logged_edits().expect("read edit-log").len(),
        edits_before,
        "the pre-check enqueues NO edit either way (bad JS never reaches the sim)",
    );
}

#[test]
fn query_webhook_url_format() {
    // QueryWebhookUrl replies with http://127.0.0.1:PORT/hook/src-<as_ffi> for a
    // Source, and None for a non-routable (Sink) node.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let source = place_g(&mut sim, &gtx, machine_kind::SOURCE, 0, 0);
    let sink = place_g(&mut sim, &gtx, machine_kind::SINK, 4, 0);
    let addr: SocketAddr = "127.0.0.1:8787".parse().expect("addr");

    let src_handle = sim.handle_for_node(source).expect("source handle");
    let (reply, mut rx) = oneshot::channel();
    ctx.send(ControlMsg::QueryWebhookUrl { node: src_handle, addr, reply })
        .expect("send query webhook url");
    sim.run(Some(1), Duration::ZERO).expect("service the query");
    let url = rx
        .try_recv()
        .expect("reply available")
        .expect("a Source has a webhook URL");
    assert_eq!(
        url,
        format!("http://127.0.0.1:8787/hook/src-{}", source.data().as_ffi()),
        "the URL is the loopback src-<as_ffi> label bound at the given port",
    );

    let sink_handle = sim.handle_for_node(sink).expect("sink handle");
    let (reply2, mut rx2) = oneshot::channel();
    ctx.send(ControlMsg::QueryWebhookUrl { node: sink_handle, addr, reply: reply2 })
        .expect("send query webhook url (sink)");
    sim.run(Some(1), Duration::ZERO).expect("service the query");
    assert!(
        rx2.try_recv().expect("reply available").is_none(),
        "a non-Source node has no webhook URL",
    );
}

#[test]
fn timer_reprojects_on_configure_fold() {
    // After a Configure{Source, Timer{interval}} folds, the live timer set fires that
    // Source every interval ticks — the projection updated WITHOUT a restart.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx);

    let source = place_g(&mut sim, &gtx, machine_kind::SOURCE, 0, 0);
    configure_g(
        &mut sim,
        &gtx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 2 } },
    );

    // The Configure fold re-projected the timer set; subsequent ticks fire it.
    let before = injects_for(sim.host(), source);
    sim.run(Some(4), Duration::ZERO).expect("run past the interval");
    assert!(
        injects_for(sim.host(), source) > before,
        "the timer fires after a Configure fold with no restart (reproject-on-fold)",
    );
}

#[test]
fn webhook_config_clears_timer() {
    // A later Configure{Source, Webhook} stops the timer (re-projection removes it).
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx);

    let source = place_g(&mut sim, &gtx, machine_kind::SOURCE, 0, 0);
    configure_g(
        &mut sim,
        &gtx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 1 } },
    );

    // Timer{1} fires every tick — prove it is active.
    let start = injects_for(sim.host(), source);
    sim.run(Some(3), Duration::ZERO).expect("run with the active timer");
    assert!(
        injects_for(sim.host(), source) > start,
        "the interval-1 timer is firing before the Webhook reconfigure",
    );

    // Reconfigure to Webhook: the re-projection clears the timer entry.
    configure_g(
        &mut sim,
        &gtx,
        source,
        MachineConfig::Source { trigger: SourceTrigger::Webhook },
    );
    let cleared = injects_for(sim.host(), source);
    sim.run(Some(4), Duration::ZERO).expect("run after the Webhook reconfigure");
    assert_eq!(
        injects_for(sim.host(), source),
        cleared,
        "a Webhook config removes the timer entry -> no further injections",
    );
}

#[test]
fn timer_projection_survives_load_via_control() {
    // Pitfall 5 at the SIM-LOOP wiring: a configured Source Timer keeps firing after a
    // real ControlMsg::Load host-swap (load_swap re-projects from the LOADED edit-log).
    let rt = test_rt();

    // --- Build a timer scene and save it to a .fab. ---
    let save_dir = tempfile::tempdir().expect("save tempdir");
    let host_a = host_over(save_dir.path());
    let (gtx_a, grx_a) = gesture_channel();
    let mut sim_a = SimLoop::new(host_a, RenderProducer::new(), rt.handle(), sim_cfg(), grx_a);
    let src_a = place_g(&mut sim_a, &gtx_a, machine_kind::SOURCE, 0, 0);
    configure_g(
        &mut sim_a,
        &gtx_a,
        src_a,
        MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 2 } },
    );
    sim_a.run(Some(6), Duration::ZERO).expect("advance the timer scene");
    assert!(
        injects_for(sim_a.host(), src_a) > 0,
        "the timer fired in the pre-save scene (reproject-on-fold)",
    );
    let fab = save_dir.path().join("timer.fab");
    save_project(sim_a.host(), &fab).expect("save the timer scene");

    // --- Load the .fab into a FRESH loop over the control channel. ---
    let load_dir = tempfile::tempdir().expect("load tempdir");
    let host_b = host_over(load_dir.path());
    let (_gtx_b, grx_b) = gesture_channel();
    let (ctx_b, crx_b) = unbounded_channel::<ControlMsg>();
    let mut sim_b = SimLoop::new(host_b, RenderProducer::new(), rt.handle(), sim_cfg(), grx_b)
        .with_control(crx_b);

    // Genesis is quiescent -> the Load swap runs immediately, re-projecting the timer.
    ctx_b.send(ControlMsg::Load(fab)).expect("send load");
    sim_b.run(Some(1), Duration::ZERO).expect("service the load + one tick");

    // The loaded scene re-minted the Source; find it in the loaded state.
    let src_b = sim_b
        .host()
        .core()
        .state
        .node_ids()
        .find(|&id| {
            matches!(
                sim_b.host().core().state.node(id),
                Some(fabrico_core::state::Node::Source(_))
            )
        })
        .expect("the loaded scene has a Source");

    let before = injects_for(sim_b.host(), src_b);
    sim_b.run(Some(4), Duration::ZERO).expect("tick the loaded scene");
    assert!(
        injects_for(sim_b.host(), src_b) > before,
        "the configured timer keeps firing after a real ControlMsg::Load (Pitfall 5 closed at the wiring)",
    );
}

// =================================================================================
// Phase 72-13 (SERVE-05): the ROUTE read-back arm of `SimLoop::machine_config`.
//
// THIS ARM WAS MISSING AND THE GAP WAS INVISIBLE TO EVERY OTHER GATE. `Node::Endpoint`
// sat in the `=> None` group beside the genuinely non-configurable operators, so a Route
// answered `machine_config` with nothing. `ConfigPanel` renders its Path field, its
// Apply and its Revert only under `!loading && config`, which means the whole SERVE-05
// Path UI - `RouteConfigBody.tsx`, its four-rule client gate, its copy and its 39 unit
// cases - was COMPLETE IN THREE LAYERS AND UNREACHABLE IN THE RUNNING BINARY. The unit
// suite could not see it because every one of those cases mounts the body directly; the
// mock e2e suite could not see it because it drives a mocked config reply; the host
// suite could not see it because nothing had ever asked a Route for its config.
//
// It was found by DRIVING THE REAL APP: `frontend/e2e-live/25-route-and-handler.spec.ts`
// at the first `fill('#fab-route-path')` this repository has ever attempted.
//
// This is the same shape as the Belt block directly above, one kind along, and its own
// header already says the general form: "a `None` config is not a cosmetic gap". These
// two cases are the arm's contract, so a later reader who puts `Node::Endpoint(_)` back
// in the `None` group reddens the host suite instead of shipping a dead panel again.
// =================================================================================

#[test]
fn query_machine_config_route_reads_the_default_path() {
    // A Route the user has NOT touched answers with the path `add_endpoint` minted:
    // `/route-1` on a fresh board with one Route (phase 91, D-13). The leading slash is
    // load-bearing (it is what keeps the endpoint and source key namespaces structurally
    // disjoint), so the whole string is asserted rather than trimmed for convenience.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let route = place_g(&mut sim, &gtx, machine_kind::ENDPOINT, 0, 0);
    let handle = sim.handle_for_node(route).expect("route handle");

    let seeded = match sim.host().core().state.node(route) {
        Some(fabrico_core::state::Node::Endpoint(ep)) => ep.path.clone(),
        other => panic!("a Place{{ENDPOINT}} minted {other:?}, not a Node::Endpoint"),
    };
    assert_eq!(
        seeded, "/route-1",
        "the first Route on a fresh board defaults to /route-1, slash included",
    );
    assert_eq!(
        query_config(&mut sim, &ctx, handle),
        Some(CoreConfig::Endpoint { path: seeded }),
        "QueryConfig for a Route replies with its CURRENT path off core.state. A None \
         here renders a Route card with no Path field and no Apply, in the shipped app, \
         on every board (72-13)",
    );
}

#[test]
fn query_machine_config_route_follows_a_configure() {
    // The read-back tracks the WRITE, which is what makes the panel a control rather
    // than a display: without this case the arm above would be satisfied by a function
    // that returned the seeded default forever and ignored every edit.
    let rt = test_rt();
    let dir = tempfile::tempdir().expect("tempdir");
    let host = host_over(dir.path());
    let (gtx, grx) = gesture_channel();
    let (ctx, crx) = unbounded_channel::<ControlMsg>();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), sim_cfg(), grx)
        .with_control(crx);

    let route = place_g(&mut sim, &gtx, machine_kind::ENDPOINT, 0, 0);
    let handle = sim.handle_for_node(route).expect("route handle");

    configure_g(
        &mut sim,
        &gtx,
        route,
        MachineConfig::Endpoint { path: "/orders".to_string() },
    );
    assert_eq!(
        query_config(&mut sim, &ctx, handle),
        Some(CoreConfig::Endpoint { path: "/orders".to_string() }),
        "QueryConfig reads the CURRENT Route path off core.state, not the seeded default",
    );

    // AND THE ROUTE TABLE AGREES, in the same run. The panel and the door must answer
    // about the same path, and `project_routes` is the door's own reading of it - two
    // readers, one field. A panel that showed `/orders` while the listener still served
    // the old label would pass the assertion above on its own.
    let routes = fabrico_host::sim_loop::project_routes(sim.host().core(), sim.host().timers());
    assert_eq!(
        routes.get("/orders").copied(),
        Some(route),
        "the live route table keys this Route at the path the panel reads back",
    );
}
