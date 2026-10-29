//! Integration coverage for the host driver — the sync sim ↔ async executor
//! bridge that turns "which results arrived in time" into a deterministic LOG.
//!
//! - `emits_without_blocking`: ticking a Sink-emitting topology with empty
//!   channels produces a command on the executor channel + a durable InFlight
//!   ledger row, and returns promptly (EXEC-01/EXEC-02 send side).
//! - `deadline_synthesizes_timeout`: a command whose deadline passes with no
//!   result yields exactly one logged Timeout and routes a CommandTimeout fault to
//!   the emitting sink's FAULT_PORT (EXEC-03).
//! - `inflight_result_prevents_timeout`: an in-time result clears the in-flight
//!   entry, so no Timeout is synthesized for it (Pitfall 5).
//! - `http_result_folds_back`: a loopback http command driven end-to-end through
//!   `run()` folds its Outcome::Success back as a logged CommandResult (EXEC-02).
//! - `replay_dispatches_zero`: replaying the produced log through `recover()`
//!   re-emits the same N commands but dispatches ZERO (REPLAY-04).
//! - `recovery_no_double_send`: a crash mid-flight, rebuilt from log + ledger,
//!   re-dispatches nothing and times out at the deadline instead (EXEC-04).

use std::time::Duration;

use fabrico_core::command::{Command, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::SinkTemplate;
use fabrico_host::config::HostConfig;
use fabrico_host::driver::Host;
use fabrico_host::executor::CountingExecutor;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderProducer;
use fabrico_host::sim_loop::{SimLoop, gesture_channel};
use fabrico_core::command::Dispatch;
use tokio::sync::mpsc::unbounded_channel;

/// A driver wrapped around a `source -> sink` topology on temp redb files.
struct Harness {
    host: Host,
    source: NodeId,
    sink: NodeId,
    _dir: tempfile::TempDir,
}

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 1,
    }
}

/// Build a fresh `source -> sink(template, deadline_ticks)` host on temp redb.
fn harness(template: SinkTemplate, deadline_ticks: u64) -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let sink = core.state.add_sink(template, deadline_ticks);
    core.state.link((source, 0), (sink, 0));
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    Harness {
        host,
        source,
        sink,
        _dir: dir,
    }
}

/// Inject one item into a source node (a webhook-style ingress payload).
fn inject(source: NodeId, byte: u8) -> EventPayload {
    EventPayload::ManualInject {
        target: source,
        port: 0,
        item: Item(vec![byte]),
    }
}

/// Decode the single fault resting on `node`'s reserved FAULT_PORT, if any.
fn fault_on(host: &Host, node: NodeId) -> Option<Fault> {
    let mut inbox = host.core().state.inbox_of(node).cloned()?;
    let (_seq, item) = inbox.take(FAULT_PORT)?;
    Fault::decode(&item).ok()
}

#[test]
fn emits_without_blocking() {
    // Ticking a Sink-emitting topology with EMPTY result/ingress channels (save
    // one injected item) produces a command on the executor channel and a durable
    // InFlight ledger row, and returns without blocking (EXEC-01/EXEC-02).
    let mut h = harness(SinkTemplate::Debug, 5);
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    ing_tx.send(inject(h.source, 0xAA)).expect("seed ingress");
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick");

    // A command landed on the executor channel, emitted by the sink.
    let cmd = cmd_rx.try_recv().expect("a command was dispatched off-thread");
    assert_eq!(cmd.id.1, h.sink, "the command was emitted by the sink");
    assert!(cmd_rx.try_recv().is_err(), "exactly one command this tick");

    // It is tracked in-flight and has a durable InFlight ledger row.
    assert_eq!(h.host.in_flight_len(), 1, "the command is tracked in-flight");
    let recovery = h
        .host
        .ledger()
        .recover(&std::collections::BTreeSet::new())
        .expect("ledger recover");
    assert_eq!(
        recovery.do_not_resend.len(),
        1,
        "a durable InFlight ledger row exists for the emitted command"
    );
    assert_eq!(recovery.do_not_resend[0].0, cmd.id);
}

#[test]
fn deadline_synthesizes_timeout() {
    // A command whose deadline tick arrives with NO logged result yields exactly
    // one synthesized Timeout and routes a CommandTimeout fault to the emitting
    // sink's FAULT_PORT (EXEC-03).
    let mut h = harness(
        SinkTemplate::Http {
            url: "http://unused.invalid/x".to_owned(),
            method: fabrico_core::state::HttpMethod::Post,
        },
        2, // deadline_ticks: emitted at tick 0 => deadline tick 2
    );
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    ing_tx.send(inject(h.source, 0x01)).expect("seed");
    // Tick 0: the sink emits one command with deadline == 0 + 2 == 2.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 0");
    let cmd = cmd_rx.try_recv().expect("a command was emitted");
    assert_eq!(h.host.in_flight_len(), 1);

    // Tick 1: deadline (2) not reached — no timeout yet.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 1");
    assert_eq!(h.host.in_flight_len(), 1, "not yet at the deadline");

    // Tick 2: deadline (2) <= tick (2) -> exactly one synthesized Timeout.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 2");
    assert_eq!(h.host.in_flight_len(), 0, "the command timed out");

    let events = h.host.logged_events().expect("read log");
    let timeouts = events
        .iter()
        .filter(|e| {
            matches!(&e.payload, EventPayload::Timeout { command_id } if *command_id == cmd.id)
        })
        .count();
    assert_eq!(timeouts, 1, "exactly one Timeout was logged for the command");

    // admit() routed a CommandTimeout fault to the emitting sink's FAULT_PORT.
    let fault = fault_on(&h.host, h.sink).expect("a fault rests on the sink FAULT_PORT");
    assert_eq!(fault.reason, FaultReason::CommandTimeout);
    assert_eq!(fault.source, h.sink);
}

#[test]
fn inflight_result_prevents_timeout() {
    // A result that arrives BEFORE the deadline clears the in-flight entry, so no
    // Timeout is synthesized for it — no Timeout + CommandResult for one CommandId
    // (Pitfall 5).
    let mut h = harness(
        SinkTemplate::Http {
            url: "http://unused.invalid/x".to_owned(),
            method: fabrico_core::state::HttpMethod::Post,
        },
        2,
    );
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    ing_tx.send(inject(h.source, 0x01)).expect("seed");
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 0");
    let cmd = cmd_rx.try_recv().expect("a command was emitted");

    // The result arrives in time (before deadline tick 2).
    res_tx
        .send(ResultEvent {
            command_id: cmd.id,
            tick: 0,
            outcome: Outcome::Success,
        })
        .expect("send result");
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 1");
    assert_eq!(h.host.in_flight_len(), 0, "the in-time result cleared in-flight");

    // Tick past the deadline — no Timeout must be synthesized.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 2");
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 3");

    let events = h.host.logged_events().expect("read log");
    let results = events
        .iter()
        .filter(|e| {
            matches!(&e.payload, EventPayload::CommandResult(re) if re.command_id == cmd.id)
        })
        .count();
    let timeouts = events
        .iter()
        .filter(|e| {
            matches!(&e.payload, EventPayload::Timeout { command_id } if *command_id == cmd.id)
        })
        .count();
    assert_eq!(results, 1, "the in-time result was logged once");
    assert_eq!(timeouts, 0, "no spurious Timeout for a result that arrived in time");
}

#[test]
fn late_result_after_timeout_does_not_double_resolve() {
    // CR-01: a result that arrives AFTER its command has already timed out (on a
    // LATER tick than the deadline) must be DROPPED — never a second logged
    // resolution. The log must carry exactly the Timeout (one resolution), never a
    // Timeout AND a CommandResult for the same CommandId.
    let mut h = harness(
        SinkTemplate::Http {
            url: "http://unused.invalid/x".to_owned(),
            method: fabrico_core::state::HttpMethod::Post,
        },
        2, // emitted at tick 0 => deadline tick 2
    );
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    ing_tx.send(inject(h.source, 0x01)).expect("seed");
    // Tick 0: emit the command (deadline tick 2), nothing resolved yet.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 0");
    let cmd = cmd_rx.try_recv().expect("a command was emitted");
    assert_eq!(h.host.in_flight_len(), 1);

    // Tick 1: still under the deadline, no result — no resolution.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 1");

    // Tick 2: deadline reached with NO result -> exactly one synthesized Timeout;
    // the command leaves the in-flight set.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 2");
    assert_eq!(h.host.in_flight_len(), 0, "the command timed out at its deadline");

    // The slow endpoint finally responds AFTER the timeout — its late result lands
    // on a later tick.
    res_tx
        .send(ResultEvent {
            command_id: cmd.id,
            tick: 0,
            outcome: Outcome::Success,
        })
        .expect("send the late result");
    // Tick 3: drain the late result — it must be dropped (command already resolved),
    // logging NO second resolution.
    h.host
        .tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 3");

    let events = h.host.logged_events().expect("read log");
    let timeouts = events
        .iter()
        .filter(|e| {
            matches!(&e.payload, EventPayload::Timeout { command_id } if *command_id == cmd.id)
        })
        .count();
    let results = events
        .iter()
        .filter(|e| {
            matches!(&e.payload, EventPayload::CommandResult(re) if re.command_id == cmd.id)
        })
        .count();
    assert_eq!(timeouts, 1, "exactly one Timeout was logged for the command");
    assert_eq!(
        results, 0,
        "the late result was dropped — no second resolution (one Timeout XOR one CommandResult)"
    );
    assert_eq!(
        h.host.in_flight_len(),
        0,
        "the late result did not re-introduce or re-resolve the command"
    );
}

/// Spin an in-process axum server on an ephemeral loopback port returning 200 on
/// POST /ok. Returns the bound base URL.
async fn spawn_ok_server() -> String {
    use axum::routing::post;
    let app = axum::Router::new().route("/ok", post(|| async { axum::http::StatusCode::OK }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    format!("http://{addr}")
}

#[test]
fn http_result_folds_back() {
    // A loopback http command driven end-to-end through the canonical SimLoop
    // bounded run: the dispatched Outcome::Success folds back as a logged
    // CommandResult the loop drains on a later tick (EXEC-02 — off-thread result).
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let base = rt.block_on(spawn_ok_server());

    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    // Long deadline so the result folds back well before any timeout.
    let sink = core.state.add_sink(
        SinkTemplate::Http {
            url: format!("{base}/ok"),
            method: fabrico_core::state::HttpMethod::Post,
        },
        1000,
    );
    core.state.link((source, 0), (sink, 0));
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");

    let cfg = HostConfig {
        webhook_addr: "127.0.0.1:0".parse().expect("addr"),
    };
    // Seed tick 0's ingress via a one-shot pre_tick hook (SimLoop owns the ingress
    // sender), then drive the canonical bounded run. The host is read back through
    // sim.host() since SimLoop owns it by value.
    let (_gesture_tx, gesture_rx) = gesture_channel();
    let mut sim = SimLoop::new(host, RenderProducer::new(), rt.handle(), cfg, gesture_rx)
        .with_pre_tick(Box::new(move |tick, ingress_tx| {
            if tick == 0 {
                let _ = ingress_tx.send(inject(source, 0x42));
            }
        }));
    sim.run(Some(50), Duration::from_millis(10)).expect("run");

    let events = sim.host().logged_events().expect("read log");
    let folded = events.iter().any(|e| {
        matches!(&e.payload, EventPayload::CommandResult(re) if re.outcome == Outcome::Success)
    });
    assert!(
        folded,
        "the http Outcome::Success folded back as a logged CommandResult (EXEC-02)"
    );
}

#[test]
fn replay_dispatches_zero() {
    // Replaying the produced log through recover() re-emits the same N commands
    // but dispatches ZERO (REPLAY-04): live dispatches N, replay dispatches 0.
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("log.redb");
    let ledger_path = dir.path().join("ledger.redb");

    // Build the identical topology twice (slotmap mints identical NodeIds for the
    // same insertion sequence, so the logged ids route on replay).
    let build_topology = || {
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        let sink = core.state.add_sink(SinkTemplate::Debug, 100);
        core.state.link((source, 0), (sink, 0));
        (core, source)
    };

    let live_count;
    let live_state;
    {
        let (core, source) = build_topology();
        let store = RedbStore::open(&log_path).expect("open log");
        let ledger = DispatchLedger::open(&ledger_path).expect("open ledger");
        let mut host = Host::new(core, store, ledger, None).expect("open host");

        let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
        let (res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

        // Inject three items at tick 0 -> three emitted commands.
        for byte in [0xA, 0xB, 0xC] {
            ing_tx.send(inject(source, byte)).expect("seed");
        }
        let mut live = CountingExecutor::default();
        // SEVERAL ticks, not one. Since 71-03 (ruling R-12) a source fires ONE item per
        // pass and a sink consumes ONE item per pass, so the three items reach the
        // executor over successive ticks instead of all in the tick they were injected.
        // The claim under test - live dispatches N, replay dispatches 0, and the two
        // states are byte-equal - is untouched by the pacing.
        //
        // The loop runs to QUIESCENCE rather than to a fixed budget, and the stopping
        // rule is not decoration: the byte-equality assertion below compares the live
        // snapshot against a `recover()` replay, and `recover()` replays exactly the
        // span the LOG covers. So the live run must stop on the tick that logged the
        // last result and did no new dispatch. A generous fixed budget would leave the
        // live core some ticks ahead of the replayed one and redden on the `tick` field
        // alone, which reads as a determinism failure and is not one.
        let mut t = 0u64;
        loop {
            host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
                .unwrap_or_else(|e| panic!("tick {t}: {e:?}"));
            // Drain dispatched commands into the counting executor + feed results back.
            let mut dispatched_this_tick = false;
            while let Ok(cmd) = cmd_rx.try_recv() {
                live.dispatch(&cmd);
                res_tx
                    .send(ResultEvent {
                        command_id: cmd.id,
                        tick: t,
                        outcome: Outcome::Success,
                    })
                    .expect("send result");
                dispatched_this_tick = true;
            }
            t += 1;
            if !dispatched_this_tick && live.count() == 3 {
                break;
            }
            assert!(t < 32, "the board did not quiesce in 32 ticks");
        }
        live_count = live.count();
        live_state = host.snapshot_bytes();
        // Drop the host -> release the redb file locks before reopening.
    }
    assert_eq!(live_count, 3, "the live run dispatched exactly N commands");

    // Replay: reopen the SAME redb, rebuild the SAME topology, recover() muted.
    let (core, _source) = build_topology();
    let store = RedbStore::open(&log_path).expect("reopen log");
    let ledger = DispatchLedger::open(&ledger_path).expect("reopen ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");

    let replay = CountingExecutor::default();
    let emitted = host.recover().expect("recover");

    assert_eq!(
        emitted.len(),
        live_count,
        "the muted replay re-emitted the same N commands"
    );
    assert_eq!(
        replay.count(),
        0,
        "the executor is muted on replay — zero dispatches (REPLAY-04)"
    );
    assert_eq!(
        host.snapshot_bytes(),
        live_state,
        "replay reproduced the live state byte-for-byte"
    );
}

#[test]
fn new_over_populated_log_resumes_past_high_water_mark_without_recover() {
    // WR-04: constructing a Host over an already-populated log derives next_seq from
    // the persisted high-water mark, so ticking WITHOUT first calling recover() can
    // no longer hand out sequences 0,1,2,… and silently OVERWRITE the existing log.
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("log.redb");
    let ledger_path = dir.path().join("ledger.redb");

    let build_topology = || {
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        let sink = core.state.add_sink(SinkTemplate::Debug, 100);
        core.state.link((source, 0), (sink, 0));
        (core, source)
    };

    // Run 1: produce some persisted events, capture them, then drop the host.
    let events_before;
    {
        let (core, source) = build_topology();
        let store = RedbStore::open(&log_path).expect("open log");
        let ledger = DispatchLedger::open(&ledger_path).expect("open ledger");
        let mut host = Host::new(core, store, ledger, None).expect("open host");
        let (cmd_tx, mut _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
        for byte in [0xA, 0xB, 0xC] {
            ing_tx.send(inject(source, byte)).expect("seed");
        }
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick 0");
        events_before = host.logged_events().expect("read log");
        assert!(!events_before.is_empty(), "run 1 persisted some events");
    }

    // Run 2: reopen the SAME log, construct a fresh Host, and tick WITHOUT recover().
    // The pre-existing events must survive byte-for-byte (no overwrite at seq 0..N).
    let (core, source) = build_topology();
    let store = RedbStore::open(&log_path).expect("reopen log");
    let ledger = DispatchLedger::open(&ledger_path).expect("reopen ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let (cmd_tx, mut _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
    ing_tx.send(inject(source, 0xFF)).expect("seed");
    host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick without recover");

    let events_after = host.logged_events().expect("read log");
    assert!(
        events_after.len() > events_before.len(),
        "the new tick APPENDED events (it did not overwrite the existing log)"
    );
    assert_eq!(
        &events_after[..events_before.len()],
        &events_before[..],
        "every pre-existing event survived byte-for-byte — next_seq resumed past the high-water mark"
    );
}

#[test]
fn recovery_reinstates_emitted_command_with_no_ledger_row() {
    // WR-05: a command emitted (its item consumed + folded into state that replay
    // reproduces) whose InFlight ledger row never committed — a crash in the one
    // step between `core.advance` emitting it and `before_dispatch` — must NOT be
    // silently dropped. Recovery reconciles the replay-emitted set against the
    // ledger and reinstates such a command (re-write-ahead + in-flight) so it times
    // out and routes a fault, instead of vanishing with no effect and no audit.
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("log.redb");

    let build_topology = || {
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        let sink = core.state.add_sink(SinkTemplate::Debug, 100);
        core.state.link((source, 0), (sink, 0));
        (core, source)
    };

    // Run 1: log a ManualInject (folds -> the sink emits a command). Ledger A is
    // discarded for recovery, modelling the crash where the inject was logged +
    // folded but the command's InFlight marker never reached the ledger.
    {
        let (core, source) = build_topology();
        let store = RedbStore::open(&log_path).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger-a.redb")).expect("open ledger A");
        let mut host = Host::new(core, store, ledger, None).expect("open host");
        let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
        ing_tx.send(inject(source, 0x55)).expect("seed");
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick 0");
        assert!(cmd_rx.try_recv().is_ok(), "the sink emitted a command in run 1");
    }

    // Recover against the SAME log but a FRESH, EMPTY ledger — no InFlight/Done row
    // exists for the emitted command (the write-ahead never happened).
    let (core, _source) = build_topology();
    let store = RedbStore::open(&log_path).expect("reopen log");
    let ledger = DispatchLedger::open(dir.path().join("ledger-b.redb")).expect("open empty ledger B");
    let mut host = Host::new(core, store, ledger, None).expect("open host");

    let emitted = host.recover().expect("recover");
    assert_eq!(emitted.len(), 1, "the muted replay re-emitted the command");
    assert_eq!(
        host.in_flight_len(),
        1,
        "the emitted-but-unlogged command was reinstated, not silently dropped (WR-05)"
    );
    // It was re-write-ahead-logged into the previously-empty ledger.
    let recovery = host
        .ledger()
        .recover(&std::collections::BTreeSet::new())
        .expect("ledger recover");
    assert_eq!(
        recovery.do_not_resend.len(),
        1,
        "the reinstated command now has a durable InFlight ledger row"
    );
}

/// An unstamped `Place` edit-record the host will stamp + fold this tick. The
/// `partition`/`sequence`/`tick` are overwritten by the host on enqueue/stamp; the
/// `op`/`action`/`schema_version` ride from the producer (08-06 in production).
fn place_edit(kind: u8, cell_x: i32, cell_y: i32) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::Place {
            kind,
            cell_x,
            cell_y,
            w: 1,
            h: 1,
            ports: vec![],
            rot: 0,
        },
    }
}

#[test]
fn edit_folds_topology() {
    // ELOG-01: an enqueued Place edit folds EDITS-FIRST on the next tick — a node
    // is minted into the Core topology AND the stamped edit is durably persisted in
    // the EDITS table (read back via logged_edits / read_edits in order).
    let dir = tempfile::tempdir().expect("tempdir");
    // An empty-genesis host (no topology) so the only node is the one the edit mints.
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    assert_eq!(host.core().state.node_count(), 0, "genesis is empty");

    let (cmd_tx, mut _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (_ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    // Enqueue one Place (Source, machine_kind 0) and tick once.
    host.enqueue_edit(place_edit(0, 3, -4));
    host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 0");

    // The edit folded -> a node was minted into the topology.
    assert_eq!(
        host.core().state.node_count(),
        1,
        "the Place edit minted exactly one node (folded edits-first)"
    );

    // The stamped edit was persisted and reads back in order.
    let edits = host.logged_edits().expect("logged edits");
    assert_eq!(edits.len(), 1, "exactly one edit persisted");
    assert_eq!(edits[0].tick, 0, "stamped at the tick it folded");
    assert_eq!(edits[0].sequence, 0, "stamped with the first edit-sequence");
    assert_eq!(edits[0].partition, 0, "stamped into partition 0");
    assert!(
        matches!(edits[0].op, EditOp::Place { kind: 0, cell_x: 3, cell_y: -4, .. }),
        "the resolved Place op survived the round-trip"
    );
}

#[test]
fn recover_replays_both_logs() {
    // ELOG-05/REPLAY: a host that enqueues edits AND fires events, ticks, is then
    // rebuilt over the SAME store and recover()ed reaches a BYTE-IDENTICAL Core —
    // recover() folds BOTH logs via run_log_two_logs (edits-first per tick).
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("log.redb");
    let ledger_path = dir.path().join("ledger.redb");

    let live_state;
    {
        let core = Core::genesis(header());
        let store = RedbStore::open(&log_path).expect("open log");
        let ledger = DispatchLedger::open(&ledger_path).expect("open ledger");
        let mut host = Host::new(core, store, ledger, None).expect("open host");

        let (cmd_tx, mut _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

        // Tick 0: place a Source via the edit-log (mints node 0, edits-first).
        host.enqueue_edit(place_edit(0, 0, 0));
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
            .expect("tick 0");
        let source = host
            .core()
            .state
            .node_ids()
            .next()
            .expect("the placed source node id");

        // Tick 1: inject an item into the placed source via the event-log.
        ing_tx.send(inject(source, 0x5A)).expect("seed ingress");
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
            .expect("tick 1");

        // Two logs are populated independently.
        assert_eq!(host.logged_edits().expect("edits").len(), 1, "one edit logged");
        assert!(!host.logged_events().expect("events").is_empty(), "events logged");

        live_state = host.snapshot_bytes();
    }

    // Rebuild over the SAME store (throwaway genesis topology — recover() rebuilds
    // it by folding the edit-log) and recover().
    let core = Core::genesis(header());
    let store = RedbStore::open(&log_path).expect("reopen log");
    let ledger = DispatchLedger::open(&ledger_path).expect("reopen ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    host.recover().expect("recover");

    assert_eq!(
        host.snapshot_bytes(),
        live_state,
        "recover() folding BOTH logs reproduced the live trajectory byte-for-byte"
    );
}

#[test]
fn recovery_no_double_send() {
    // A crash mid-flight, rebuilt from log + ledger, re-dispatches nothing and the
    // in-flight command times out at its deadline instead of re-sending (EXEC-04 —
    // "never send the email twice").
    let dir = tempfile::tempdir().expect("tempdir");
    let log_path = dir.path().join("log.redb");
    let ledger_path = dir.path().join("ledger.redb");

    let build_topology = || {
        let mut core = Core::genesis(header());
        let source = core.state.add_source();
        let sink = core.state.add_sink(
            SinkTemplate::Http {
                url: "http://unused.invalid/x".to_owned(),
                method: fabrico_core::state::HttpMethod::Post,
            },
            2, // deadline_ticks
        );
        core.state.link((source, 0), (sink, 0));
        (core, source, sink)
    };

    let cmd_id;
    let sink_id;
    let pre_crash_state;
    {
        let (core, source, sink) = build_topology();
        sink_id = sink;
        let store = RedbStore::open(&log_path).expect("open log");
        let ledger = DispatchLedger::open(&ledger_path).expect("open ledger");
        let mut host = Host::new(core, store, ledger, None).expect("open host");

        let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
        let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

        ing_tx.send(inject(source, 0x77)).expect("seed");
        // Tick 0: emit the command + write its durable InFlight ledger row.
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
            .expect("tick 0");
        let cmd = cmd_rx.try_recv().expect("a command was emitted");
        cmd_id = cmd.id;
        assert_eq!(host.in_flight_len(), 1);
        pre_crash_state = host.snapshot_bytes();
        // DROP the host before any result/Done -> a crash mid-flight.
    }

    // Recover: reopen the SAME redb, rebuild the SAME topology, recover().
    let (core, _source, sink) = build_topology();
    assert_eq!(sink, sink_id, "topology rebuild mints identical NodeIds");
    let store = RedbStore::open(&log_path).expect("reopen log");
    let ledger = DispatchLedger::open(&ledger_path).expect("reopen ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");

    host.recover().expect("recover");
    // The rebuilt state matches the pre-crash trajectory (replay equivalence).
    assert_eq!(
        host.snapshot_bytes(),
        pre_crash_state,
        "recovered state == pre-crash state"
    );
    // The in-flight command is reinstated so it can time out (never re-send).
    assert_eq!(host.in_flight_len(), 1, "the in-flight command is reinstated");

    // Continue live ticking through the deadline, routing ANY dispatch into a
    // counting executor — it must stay 0 (no double-send).
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (_ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
    let mut counter = CountingExecutor::default();

    // After recover, core.tick == 1 (folded tick 0). Deadline == 2.
    host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 1");
    while let Ok(cmd) = cmd_rx.try_recv() {
        counter.dispatch(&cmd);
    }
    // Tick 2: deadline reached -> Timeout, NOT a re-dispatch.
    host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("tick 2");
    while let Ok(cmd) = cmd_rx.try_recv() {
        counter.dispatch(&cmd);
    }

    assert_eq!(
        counter.count(),
        0,
        "recovery + continuation re-dispatched zero commands (no double-send)"
    );
    assert_eq!(host.in_flight_len(), 0, "the in-flight command timed out");
    let events = host.logged_events().expect("read log");
    assert!(
        events.iter().any(|e| matches!(
            &e.payload,
            EventPayload::Timeout { command_id } if *command_id == cmd_id
        )),
        "the in-flight command resolved as a Timeout, not a re-send"
    );
    let fault = fault_on(&host, sink_id).expect("a CommandTimeout fault on the sink");
    assert_eq!(fault.reason, FaultReason::CommandTimeout);
}

/// Append one raw postcard-encoded [`Event`] directly to a fresh `log.redb` at
/// `(partition 0, key)` — the crafted-on-disk-log primitive the hostile-recover
/// tests need (a tampered log that did NOT pass through `load_project`).
fn craft_log_with_event(dir: &std::path::Path, key: u64, ev: &Event) {
    use fabrico_core::persist::PersistenceStore;
    let mut store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let bytes = postcard::to_allocvec(ev).expect("encode crafted event");
    store.append_event(0, key, &bytes).expect("append crafted event");
}

/// Append one raw postcard-encoded [`EditRecord`] directly to a fresh `log.redb` at
/// `(partition 0, key)`: the edit-log twin of [`craft_log_with_event`], for a store
/// that did NOT pass through `load_project`.
fn craft_edit_log_with_record(dir: &std::path::Path, key: u64, er: &EditRecord) {
    use fabrico_core::persist::PersistenceStore;
    let mut store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let bytes = postcard::to_allocvec(er).expect("encode crafted edit");
    store.append_edit(0, key, &bytes).expect("append crafted edit");
}

#[test]
fn stale_versioned_edit_in_the_redb_store_is_refused_by_the_driver() {
    // SCHEMA-01 at the SECOND reachable edit-log boundary: a redb edit-log store, not
    // a `.fab` file. A store written by a pre-v8.0 build carries records stamped 6, and
    // the v8.0 clean break (Phase 63, plan 63-11) refuses them with a typed error
    // rather than replaying them against a layout they were not written for.
    //
    // WHERE THE REFUSAL LANDS, and why that is not where the plan expected it. Plan
    // 63-11 named `Host::logged_edits` as this boundary, following RESEARCH FINDING 3.
    // `Host::new` is a FOURTH decode site the research did not name: it decodes every
    // persisted edit record to compute the action high-water, and until 63-11 it
    // checked no version at all while its own comment claimed it did. With that hole
    // closed, `Host::new` refuses a stale store STRICTLY EARLIER than `logged_edits`
    // could be called - so a stale store can no longer reach `logged_edits` in-process
    // at all, and this test asserts at the boundary that actually fires.
    //
    // HAND-WRITTEN 6, not `EDIT_SCHEMA_VERSION - 1`: 6 is the version a real pre-v8.0
    // store carries, so this stays a genuine stale-bytes witness after the next bump.
    const PREVIOUS_MILESTONE_EDIT_VERSION: u16 = 6;

    let dir = tempfile::tempdir().expect("tempdir");
    let mut stale = place_edit(0, 2, 2);
    stale.schema_version = PREVIOUS_MILESTONE_EDIT_VERSION;
    craft_edit_log_with_record(dir.path(), 0, &stale);

    let store = RedbStore::open(dir.path().join("log.redb")).expect("reopen log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let result = Host::new(Core::genesis(header()), store, ledger, None);
    let err = match result {
        Ok(_) => panic!("a store carrying a version-6 edit record must be refused"),
        Err(e) => e.to_string(),
    };
    assert!(
        err.contains('6'),
        "the refusal must name the offending version, got: {err}"
    );
    assert!(
        !err.contains("exceeds"),
        "the message must not still describe an exact-match refusal as a forward-only \
         one, got: {err}"
    );

    // NON-VACUITY: the identical store at the CURRENT version opens, and
    // `logged_edits` reads the record back. Without this the assertion above would
    // pass just as well if the driver had started refusing every store.
    let ok_dir = tempfile::tempdir().expect("tempdir");
    craft_edit_log_with_record(ok_dir.path(), 0, &place_edit(0, 2, 2));
    let store = RedbStore::open(ok_dir.path().join("log.redb")).expect("reopen log");
    let ledger = DispatchLedger::open(ok_dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(Core::genesis(header()), store, ledger, None)
        .expect("a current-version store must open");
    let edits = host.logged_edits().expect("logged_edits reads a current-version store");
    assert_eq!(edits.len(), 1, "the current-version record reads back");
    assert_eq!(
        edits[0].schema_version,
        fabrico_core::edit::EDIT_SCHEMA_VERSION,
        "and it carries the running version"
    );
}

#[test]
fn recover_rejects_unbounded_replay_span() {
    // WR-02: a tampered on-disk log carrying an event stamped far beyond
    // MAX_REPLAY_SPAN reaches recover() directly (NOT via load_project's pre-flight
    // guards). The engine-level bound in run_log_two_logs must refuse it as a typed
    // StoreError instead of hanging the idle-tick replay loop / overflowing the tick
    // advance. We assert recover() returns Err (and, implicitly, RETURNS at all).
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let s = core.state.add_source();
    let ev = Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: fabrico_core::core::MAX_REPLAY_SPAN + 100,
        payload: inject(s, 0x1),
    };
    craft_log_with_event(dir.path(), 0, &ev);

    let store = RedbStore::open(dir.path().join("log.redb")).expect("reopen log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let result = host.recover();
    assert!(
        result.is_err(),
        "an unbounded replay span must be refused (typed error), never hung"
    );
}

#[test]
fn recover_rejects_u64_max_sequence() {
    // WR-03: a hostile `.fab` can carry a record with sequence == u64::MAX (it passes
    // load_project's strictly-increasing + forward-version checks, which do NOT bound
    // the sequence MAGNITUDE). recover()'s high-water `max(seq) + 1` would panic
    // (debug) or wrap to 0 (release, then collide live-append keys). The checked
    // high-water computation must refuse it as a typed StoreError — never a panic.
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let s = core.state.add_source();
    let ev = Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: u64::MAX, // the hostile high-water mark
        tick: 0,            // a benign tick so the replay-span guard passes first
        payload: inject(s, 0x1),
    };
    craft_log_with_event(dir.path(), u64::MAX, &ev);

    let store = RedbStore::open(dir.path().join("log.redb")).expect("reopen log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    let result = host.recover();
    assert!(
        result.is_err(),
        "a u64::MAX sequence must be refused (typed error), never panic/wrap"
    );
}

// ---------------------------------------------------------------------------
// Plan 74.1-23 (review WR-02, round 3): the redb boundary refuses a forged port edit,
// and `recover` refuses a replay the snapshot trust gate refuses.
// ---------------------------------------------------------------------------

/// Open a host over the store in `dir`, on an empty genesis core.
fn host_over(dir: &std::path::Path) -> Host {
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    Host::new(core, store, ledger, None).expect("open host")
}

/// `Host::logged_edits` (the redb edit-log boundary) refuses a forged
/// `AddPort { seat: Captured }` whose slot lies outside `[0, MAX_FOOTPRINT_DIM)`, with a
/// `StoreError::Backend` that names the record's sequence.
/// RED at the start revision: the record decoded and was returned.
#[test]
fn logged_edits_refuses_a_forged_captured_seat_naming_the_record() {
    use fabrico_core::edit::PortSeat;
    use fabrico_core::persist::StoreError;
    use fabrico_core::state::{MAX_FOOTPRINT_DIM, Medium, Port, Role, Side};
    for slot in [-1, i32::from(MAX_FOOTPRINT_DIM)] {
        let dir = tempfile::tempdir().expect("tempdir");
        let node = {
            let mut c = Core::genesis(header());
            c.state.add_source()
        };
        craft_edit_log_with_record(
            dir.path(),
            41,
            &EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: 41,
                tick: 0,
                action: 0,
                op: EditOp::AddPort {
                    node,
                    port: Port { local_offset: (0, slot), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                    index: 0,
                    seat: PortSeat::Captured,
                },
            },
        );
        let host = host_over(dir.path());
        match host.logged_edits() {
            Err(StoreError::Backend(msg)) => {
                assert!(msg.contains("41"), "the refusal names the record's sequence: {msg}");
            }
            other => panic!("a captured slot {slot} must be refused, got {other:?}"),
        }
    }
}

/// THE STATE-AWARE HALF at the store boundary: a store holding a real 3-output Factory
/// and then a forged `RemovePort{restore: Some(3x1)}` (inside the decode envelope, too
/// small for the ports that survive) is refused by `Host::recover` before any session is
/// installed, with a `StoreError::Backend` naming the snapshot gate's refusal.
/// RED at the start revision: `recover` returned `Ok` and the session ran on a core the
/// next load refuses.
#[test]
fn recover_refuses_a_replay_the_snapshot_gate_refuses() {
    use fabrico_core::edit::BoxRestore;
    use fabrico_core::persist::StoreError;
    use fabrico_core::state::{Role, Side};
    use fabrico_protocol::{GridCommand, machine_kind, port_medium, port_role};

    let mut s = fabrico_command::GridSession::new(header().seed);
    s.apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 20, cell_y: 20 })
        .expect("place the factory");
    let m = *s.core().last_tick.placed.last().expect("minted");
    let h = s.view().handle_of(m).expect("handle");
    for _ in 0..2 {
        s.apply(GridCommand::AddPort { node: h, role: port_role::OUT, side: Side::E as u8, medium: port_medium::MECHANICAL })
            .expect("an add on clear floor");
    }
    let first_out = s.core().state.ports_of(m).expect("ports").iter().position(|p| p.role == Role::Out).expect("an Out");
    let mut log = s.edit_log().to_vec();
    let last = log.last().expect("records").clone();
    log.push(EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: last.sequence + 1,
        tick: last.tick + 1,
        action: last.action + 1,
        op: EditOp::RemovePort {
            node: m,
            index: u16::try_from(first_out).expect("small"),
            restore: Some(BoxRestore { w: 3, h: 1, anchor_x: 20, anchor_y: 20 }),
        },
    });

    let dir = tempfile::tempdir().expect("tempdir");
    for r in &log {
        craft_edit_log_with_record(dir.path(), r.sequence, r);
    }
    let mut host = host_over(dir.path());
    match host.recover() {
        Err(StoreError::Backend(msg)) => {
            assert!(msg.contains("snapshot gate"), "the refusal names the trust gate: {msg}");
        }
        Err(other) => panic!("refused with the wrong error: {other:?}"),
        Ok(_) => panic!(
            "the forged store recovered; its core passes the gate: {:?}",
            fabrico_core::snapshot::restore(&fabrico_core::snapshot::snapshot(host.core())).map(|_| ())
        ),
    }
}
