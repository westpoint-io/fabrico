//! Phase 87, JAM-04, success criterion 3 on a TIMER-fed board (plan 87-07): a board jammed
//! solid stops growing its save.
//!
//! The core half of criterion 3 is `fabrico-core`'s `a_board_jammed_solid_goes_idle`: once
//! nothing can move, no node steps and two snapshots far apart differ in the tick alone. A
//! save is more than a snapshot, though. It carries the event log, and before plan 87-07 the
//! host's own timer logged one `ManualInject` per interval into a Source that refused every
//! one of them (its backlog at `SOURCE_PENDING_CAP`, behind a full belt). The fold dropped
//! each refused fire silently, so the state never moved, but the log, and with it the save,
//! grew by one event per interval forever.
//!
//! Since plan 87-07 `TimerSet::due_events` skips a fire its target Source would refuse,
//! asked through the core's own predicate (`admit::source_accepts_one`), and consumes no
//! sequence number for it. These tests drive a real `Host` through `tick_once`, the board
//! built through the certified gesture path and the timer projected from the edit-log, as
//! the sim loop does:
//!
//! - `a_jammed_timer_board_save_stays_small`: a Timer Source every 2 ticks into a 1-tile
//!   belt whose head docks nowhere. Saves at ticks 2000 and 6000 (one varint band, so the
//!   tick fields have the same width) must be the same length, and the second, loaded into
//!   a fresh host and replayed to its head tick, must reach the live host's snapshot bytes:
//!   the skipped fires change nothing a replay can see.
//! - `a_flowing_timer_board_logs_every_fire`: the same Source on Timer every 8 ticks into a
//!   belt docked on a Sink. Nothing backs up, so every due tick logs its fire, as before.

// `fabrico-host` is the sanctioned I/O home; reading back the `.fab` files this test just
// wrote is exactly the test IO that belongs here (the same allow, for the same reason, as
// `tests/belt_run_save_reload.rs`).
#![allow(clippy::disallowed_methods)]

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::driver::Host;
use fabrico_host::ingress::timer::project_timers;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_protocol::{BeltEnd, GridCommand, MachineConfig, SourceTrigger, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The genesis seed for every host here.
const SEED: u64 = 0x0087_0707_5A7E_0000;

/// A real `Host` over tempfile redb stores, the per-tick channels `tick_once` drains, and
/// the dense handle table gesture frames address the board by. Every channel end is kept
/// alive for the life of the board.
struct Board {
    dir: tempfile::TempDir,
    host: Host,
    _ingress_tx: UnboundedSender<EventPayload>,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    _cmd_rx: UnboundedReceiver<Command>,
    _results_tx: UnboundedSender<ResultEvent>,
    results_rx: UnboundedReceiver<ResultEvent>,
    nodes: Vec<NodeId>,
}

impl Board {
    /// A genesis host persisting a snapshot every `snapshot_every` ticks, so a save has a
    /// replay base behind its head and a load really replays the log.
    fn new(snapshot_every: u64) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: SEED,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, Some(snapshot_every)).expect("open host");
        let (_ingress_tx, ingress_rx) = unbounded_channel();
        let (cmd_tx, _cmd_rx) = unbounded_channel();
        let (_results_tx, results_rx) = unbounded_channel();
        Self {
            dir,
            host,
            _ingress_tx,
            ingress_rx,
            cmd_tx,
            _cmd_rx,
            _results_tx,
            results_rx,
            nodes: Vec::new(),
        }
    }

    /// One tick of the real driver.
    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick persists");
    }

    /// Apply ONE `GridCommand` through the certified gesture path and fold it in ONE tick.
    fn apply(&mut self, cmd: GridCommand, what: &str) {
        let table = self.nodes.clone();
        apply_gesture(&mut self.host, cmd, move |h| table.get(h as usize).copied())
            .unwrap_or_else(|e| panic!("{what}: rejected with {e:?}"));
        self.tick();
        let placed: Vec<NodeId> = self.host.core().last_tick.placed.to_vec();
        self.nodes.extend(placed);
    }

    /// Install the timer set projected from the certified edit-log, as the sim loop does
    /// after every Configure fold.
    fn project_timers(&mut self) {
        let timers = project_timers(&self.host.logged_edits().expect("read edit-log"));
        self.host.set_timers(timers);
    }

    /// The logged timer fires into `source`.
    fn fires_into(&self, source: NodeId) -> usize {
        self.host
            .logged_events()
            .expect("read log")
            .iter()
            .filter(|e| matches!(e.payload, EventPayload::ManualInject { target, .. } if target == source))
            .count()
    }

    /// The Source's backlog length.
    fn pending(&self, source: NodeId) -> usize {
        match self.host.core().state.node(source) {
            Some(Node::Source(s)) => s.pending.len(),
            _ => 0,
        }
    }

    /// Save to `name` in the board's temp dir and return the path and the file's length.
    fn save(&self, name: &str) -> (std::path::PathBuf, u64) {
        let path = self.dir.path().join(name);
        save_project(&self.host, &path).unwrap_or_else(|e| panic!("save {name}: {e}"));
        let len = std::fs::metadata(&path).expect("stat the save").len();
        (path, len)
    }
}

/// A SOURCE at `(0, 0)` on Timer every `interval` ticks, its Out docked on the tail of a
/// belt drawn east. With `sink`, the belt is two tiles and its head docks on a SINK at
/// `(3, 0)`; without, it is one tile and its head docks nowhere. Returns the board and the
/// Source's id.
fn timer_board(interval: u64, sink: bool) -> (Board, NodeId) {
    let mut b = Board::new(1000);
    b.apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 }, "place SOURCE");
    let belt_handle = if sink {
        b.apply(GridCommand::Place { kind: machine_kind::SINK, cell_x: 3, cell_y: 0 }, "place SINK");
        b.apply(GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0)] }, "draw the flowing belt");
        b.apply(GridCommand::Dock { belt: 2, endpoint: BeltEnd::Head, node: 1, port: 0 }, "dock HEAD to SINK In");
        2
    } else {
        b.apply(GridCommand::DrawBelt { cells: vec![(1, 0)] }, "draw the dead-end belt");
        1
    };
    b.apply(
        GridCommand::Dock { belt: belt_handle, endpoint: BeltEnd::Tail, node: 0, port: 0 },
        "dock TAIL to SOURCE Out",
    );
    b.apply(
        GridCommand::Configure {
            node: 0,
            config: MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: interval } },
        },
        "put the SOURCE on Timer",
    );
    b.project_timers();
    let source = b.nodes[0];
    assert!(matches!(b.host.core().state.node(source), Some(Node::Source(_))), "handle 0 is the Source");
    assert_eq!(b.host.timers().interval_for(source), Some(interval), "the Source is on Timer every {interval}");
    (b, source)
}

/// Plan 87-07, JAM-04, criterion 3: a jammed Timer board's save stops growing, and still
/// replays exactly.
///
/// Before plan 87-07 the second save was longer by the refused fires the timer logged
/// between the two (one every 2 ticks).
#[test]
fn a_jammed_timer_board_save_stays_small() {
    const SAVE_A: u64 = 2000;
    const SAVE_B: u64 = 6000;
    let (mut b, source) = timer_board(2, false);

    while b.host.core().tick < SAVE_A {
        b.tick();
    }
    let fires_a = b.fires_into(source);
    let (_path_a, len_a) = b.save("jammed-a.fab");
    while b.host.core().tick < SAVE_B {
        b.tick();
    }
    let fires_b = b.fires_into(source);
    let (path_b, len_b) = b.save("jammed-b.fab");

    let work = tempfile::tempdir().expect("a fresh work dir for the load");
    let loaded = load_project(&path_b, work.path(), None).unwrap_or_else(|e| panic!("load the second save: {e}"));
    let live_snap = b.host.snapshot_bytes();
    let loaded_snap = loaded.snapshot_bytes();
    eprintln!(
        "JAMMED-TIMER save_bytes_at_{SAVE_A}={len_a} save_bytes_at_{SAVE_B}={len_b} fires_logged_at_{SAVE_A}={fires_a} \
         fires_logged_at_{SAVE_B}={fires_b} source_pending={} loaded_tick={} live_hash={} loaded_hash={}",
        b.pending(source),
        loaded.core().tick,
        blake3::hash(&live_snap).to_hex(),
        blake3::hash(&loaded_snap).to_hex(),
    );

    assert_eq!(
        b.pending(source),
        fabrico_core::admit::SOURCE_PENDING_CAP,
        "the Source sits at its cap behind the full belt (non-vacuity: the board is jammed)"
    );
    assert!(fires_a > 0, "the timer fired into the Source before the jam (non-vacuity)");
    assert_eq!(fires_b, fires_a, "no fire was logged between the two saves: the Source refused every one");
    assert_eq!(len_a, len_b, "the two saves are the same size");
    assert_eq!(loaded.core().tick, SAVE_B, "the load replays to the saved head tick");
    assert_eq!(loaded_snap, live_snap, "the loaded, replayed save reaches the live host's state");
}

/// Plan 87-07: the skip touches only a fire its Source would refuse. On a flowing board the
/// Source never sits at its cap, so every due tick logs its fire, exactly as before.
#[test]
fn a_flowing_timer_board_logs_every_fire() {
    const INTERVAL: u64 = 8;
    const RUN: u64 = 800;
    let (mut b, source) = timer_board(INTERVAL, true);
    let from = b.host.core().tick;
    let before = b.fires_into(source);
    let mut peak = 0usize;
    for _ in 0..RUN {
        b.tick();
        peak = peak.max(b.pending(source));
    }
    let logged = b.fires_into(source) - before;
    let due = (from..from + RUN).filter(|t| t.is_multiple_of(INTERVAL)).count();
    eprintln!("FLOWING-TIMER from={from} due={due} logged={logged} peak_pending={peak}");
    assert!(peak < fabrico_core::admit::SOURCE_PENDING_CAP, "the board flows: the Source never reached its cap ({peak})");
    assert!(due >= 90, "a real run of fires ({due})");
    assert_eq!(logged, due, "every due fire was logged");
}
