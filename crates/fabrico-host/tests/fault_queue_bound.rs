//! PILE-09's acceptance check (1): a board pointed at a dead endpoint stops growing
//! its save file, and the equality that says so is BYTE equality.
//!
//! # Why this test lives in `fabrico-host` and not in the core
//!
//! PILE-09 names `cargo test -p fabrico-host` and the reason is not administrative.
//! A `CommandResult::Failure` is not something the core can produce on its own: a Sink
//! emits a `Command` of INTENT, the host dispatches it off the sim thread, and the
//! outcome comes back over the results channel as a logged event. Only a host-side test
//! can drive that whole loop, and a core-side test that pushed a fault into an inbox by
//! hand would bypass `admit::try_admit` - which is where `FAULT_QUEUE_CAP` actually
//! lives - and would therefore assert the bound against a queue the bound never saw.
//!
//! There is a second reason, discovered rather than planned: `Host::tick_once` DROPS a
//! `ResultEvent` whose `command_id` is not in its in-flight map (its at-most-once
//! resolution gate, CR-01). A synthesized failure for a command nobody dispatched goes
//! nowhere. So this file cannot fake the re-entry even if it wanted to; every failure
//! below is the answer to a command the Sink really emitted.
//!
//! # What the SCOPE CHANGE bought, and why the equality is BYTE equality
//!
//! PILE-09 used to require a per-machine dropped-fault counter. That clause was REMOVED
//! on 2026-09-01 as a dated scope change (ruling R-16 in plan 71-04 implements the
//! removal). A counter is a postcard varint and a varint
//! crossing 128 widens by a byte, so with a counter in the design the strongest
//! assertable claim would have been "the length does not grow much". With no counter the
//! claim is exact: the two snapshots are the same NUMBER OF BYTES.
//!
//! # THE TRAP THIS FILE IS BUILT AROUND: an equal length is free on a board that never
//! filled anything, AND free on a board whose varints happen to line up
//!
//! Two separate ways this assertion could pass while proving nothing, both closed here:
//!
//!   1. **A board that never faulted.** Its snapshot length is trivially equal at any
//!      two points. Closed by asserting the Sink's `FAULT_PORT` queue is EXACTLY
//!      `FAULT_QUEUE_CAP` at both sample points, and by asserting the host-side
//!      `derive_state` reads FAULTED at both.
//!   2. **A varint coincidence.** `Core` serializes `tick` and `cursor` as postcard
//!      varints and BOTH grow monotonically between the two points. If the two samples
//!      straddled a varint width boundary the equality would redden for a reason that
//!      has nothing to do with a queue; if a later edit moved the sample points into
//!      that straddle the failure would look like a regression in the bound. So this
//!      file asserts the WIDTHS match as its own named clause, with its own message,
//!      rather than leaving the reader to discover it. The existing PILE-04 test in
//!      `tick.rs` records the same hazard in prose; here it is machine-checked.

use fabrico_core::admit::FAULT_QUEUE_CAP;
use fabrico_core::command::{Command, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_core::snapshot;
use fabrico_core::state::SinkTemplate;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::derive_state;
use fabrico_protocol::state_tag;
use slotmap::SlotMap;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A `NodeId` that can never belong to this grid: minted from a foreign allocator,
/// removed, then re-minted so its version is bumped. Used only to address the
/// cursor-prelude events below at a node that does not exist, so `manual_inject`'s
/// existence guard drops each one - the event is logged and counted and changes NOTHING.
fn ghost_id() -> NodeId {
    let mut foreign: SlotMap<NodeId, ()> = SlotMap::with_key();
    let k = foreign.insert(());
    foreign.remove(k);
    foreign.insert(())
}

/// How many bytes postcard spends on a `u64` varint (7 bits per byte).
fn varint_len(mut v: u64) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

/// A real `Host` over tempfile redb stores, driving SOURCE -> SINK.
///
/// The single link is made at the CORE SEAM rather than through a gesture, and that is
/// the honest reason rather than a shortcut: a dock is a BELT-to-machine gesture, so two
/// machines cannot be wired to each other through the certified path at all. The same
/// seam and the same justification are used by `belt_backpressure_meet.rs` for its
/// belt-to-belt junction. Everything this test actually measures - the dispatch, the
/// failure re-entry, the admission, the bound - runs through the real paths.
struct Board {
    _dir: tempfile::TempDir,
    host: Host,
    ingress_tx: UnboundedSender<EventPayload>,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    cmd_rx: UnboundedReceiver<Command>,
    results_tx: UnboundedSender<ResultEvent>,
    results_rx: UnboundedReceiver<ResultEvent>,
    source: NodeId,
    sink: NodeId,
}

impl Board {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 0x7104_0900,
        });
        let source = core.state.add_source();
        // `deadline_ticks` is deliberately generous: a failure is fed back on the tick
        // AFTER its command is emitted, and a tight deadline would let the host
        // synthesize a `Timeout` first. A Timeout is also a fault, so the test would
        // still LOOK right while measuring a different event.
        let sink = core.state.add_sink(SinkTemplate::Debug, 1_000_000);
        core.state.link((source, 0), (sink, 0));

        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        let (ingress_tx, ingress_rx) = unbounded_channel();
        let (cmd_tx, cmd_rx) = unbounded_channel();
        let (results_tx, results_rx) = unbounded_channel();
        Self {
            _dir: dir,
            host,
            ingress_tx,
            ingress_rx,
            cmd_tx,
            cmd_rx,
            results_tx,
            results_rx,
            source,
            sink,
        }
    }

    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick persists");
    }

    /// One full loop of the real cycle: offer an item, fold a tick, and answer every
    /// command the Sink emitted with a FAILURE. Returns how many failures were sent, so
    /// the caller counts what actually happened rather than what it intended.
    fn drive_one(&mut self, payload: u8) -> usize {
        self.ingress_tx
            .send(EventPayload::ManualInject {
                target: self.source,
                port: 0,
                item: Item(vec![payload]),
            })
            .expect("ingress receiver alive");
        self.tick();
        let mut failures = 0;
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            self.results_tx
                .send(ResultEvent {
                    command_id: cmd.id,
                    // The host stamps the admit tick itself; the executor sends 0.
                    tick: 0,
                    outcome: Outcome::Failure,
                })
                .expect("results receiver alive");
            failures += 1;
        }
        failures
    }

    /// Log one event addressed at a node that does not exist. `manual_inject`'s
    /// existence guard drops it, so `cursor` advances and NOTHING else does.
    fn pump_cursor(&mut self) {
        self.ingress_tx
            .send(EventPayload::Input {
                target: ghost_id(),
                port: 0,
                item: Item(vec![0]),
            })
            .expect("ingress receiver alive");
        self.tick();
    }

    fn faults(&self) -> usize {
        self.host
            .core()
            .state
            .inbox_of(self.sink)
            .map_or(0, |i| i.len_on(FAULT_PORT))
    }

    fn sink_state(&self) -> u8 {
        let core = self.host.core();
        derive_state(self.sink, &core.last_tick, &core.state)
    }
}

/// What one sample point records.
struct Sample {
    label: &'static str,
    delivered: usize,
    bytes: usize,
    faults: usize,
    tick: u64,
    cursor: u64,
    state: u8,
}

#[test]
fn a_sink_pointed_at_a_dead_endpoint_stops_growing_its_save_file() {
    let mut board = Board::new();

    // NON-VACUITY OF THE TOPOLOGY, asserted before anything is driven. If the fault port
    // were DOCKED the PILE-10 drain would carry every fault away, the queue would never
    // reach its cap, and every assertion below would pass for the wrong reason.
    assert!(
        board
            .host
            .core()
            .state
            .link_target((board.sink, FAULT_PORT))
            .is_none(),
        "this board's fault port is UNDOCKED, which is what makes the queue fill at all"
    );

    // THE VARINT PRELUDE. `Core` serializes `tick` and `cursor` as varints and both grow
    // between the two sample points. 3 x 16 = 48 delivered failures would leave `cursor`
    // under 128 (a one-byte varint) while 10 x 16 = 160 would put it over (two bytes),
    // so the equality would redden on the encoding of a counter nobody is testing.
    // Pumping the cursor past the boundary FIRST puts both samples in the same band. It
    // is derived from the boundary rather than picked, and the band is asserted at the
    // end so a later edit that moves the sample points fails with the reason attached.
    while board.host.core().cursor < 0x80 {
        board.pump_cursor();
    }

    let mut delivered = 0usize;
    let mut samples: Vec<Sample> = Vec::new();
    let three_x = 3 * FAULT_QUEUE_CAP;
    let ten_x = 10 * FAULT_QUEUE_CAP;

    // A hard iteration ceiling so a board that stopped dispatching fails as a timeout
    // with a message rather than hanging the suite.
    let ceiling = ten_x * 8 + 64;
    for i in 0..ceiling {
        delivered += board.drive_one((i & 0xFF) as u8);
        for (label, target) in [("3x cap", three_x), ("10x cap", ten_x)] {
            if delivered == target && !samples.iter().any(|s| s.label == label) {
                let core = board.host.core();
                samples.push(Sample {
                    label,
                    delivered,
                    bytes: snapshot::snapshot(core).len(),
                    faults: board.faults(),
                    tick: core.tick,
                    cursor: core.cursor,
                    state: board.sink_state(),
                });
            }
        }
        if samples.len() == 2 {
            break;
        }
    }

    assert_eq!(
        samples.len(),
        2,
        "the board must reach both sample points inside {ceiling} loops (delivered \
         {delivered} failures)"
    );
    let a = &samples[0];
    let b = &samples[1];

    // NON-VACUITY CLAUSE 1: the queue really is AT the cap at BOTH points. Without this
    // a board that never faulted has equal snapshot lengths too, and PILE-09's own
    // acceptance names this clause explicitly.
    assert_eq!(
        a.faults, FAULT_QUEUE_CAP,
        "at the {} point the Sink's FAULT_PORT queue is AT the cap ({} delivered)",
        a.label, a.delivered
    );
    assert_eq!(
        b.faults, FAULT_QUEUE_CAP,
        "at the {} point it is STILL exactly at the cap ({} delivered), so {} further \
         failures added nothing",
        b.label,
        b.delivered,
        b.delivered - a.delivered
    );

    // NON-VACUITY CLAUSE 2: the machine READS as faulted, host-side, at both points.
    // This is the user-visible half - a bound that quietly ate the signal would satisfy
    // clause 1 and fail here.
    assert_eq!(a.state, state_tag::FAULTED, "the Sink reads FAULTED at 3x cap");
    assert_eq!(
        b.state,
        state_tag::FAULTED,
        "and still reads FAULTED at 10x cap"
    );

    // NON-VACUITY CLAUSE 3: both samples sit in the same varint band for BOTH growing
    // scalars, so the equality below is about the queue and not about an encoding.
    assert_eq!(
        (varint_len(a.tick), varint_len(a.cursor)),
        (varint_len(b.tick), varint_len(b.cursor)),
        "the two samples must share a varint width for `tick` ({} then {}) and `cursor` \
         ({} then {}), or the byte equality below measures postcard rather than the \
         bound. Widen the prelude if this fires.",
        a.tick,
        b.tick,
        a.cursor,
        b.cursor
    );

    // THE REQUIREMENT.
    assert_eq!(
        a.bytes, b.bytes,
        "PILE-09: the serialized Core is BYTE-EQUAL at the {} point and the {} point \
         ({} then {} bytes) while {} further failed dispatches arrived",
        a.label,
        b.label,
        a.bytes,
        b.bytes,
        b.delivered - a.delivered
    );

    eprintln!(
        "PILE-09 3x cap: {} bytes, {} faults, tick {}, cursor {} | 10x cap: {} bytes, \
         {} faults, tick {}, cursor {}",
        a.bytes, a.faults, a.tick, a.cursor, b.bytes, b.faults, b.tick, b.cursor
    );
}
