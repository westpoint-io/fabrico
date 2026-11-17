//! The check that a board's HTTP call goes out once, across a save and an open.
//!
//! Both tests boot `examples/boards/docs/patterns-call-exactly-once.board.ron` on a `Host` the way
//! `board_host_parity.rs` does, and drive it only through `Host::tick_with_dispatch`, the body
//! `Host::tick_once` runs in the app. Every command the host hands to the dispatch closure is
//! counted there; in the app that closure is the send to the executor, so a count of 2 is a
//! second real request.
//!
//! `one_dispatch_across_save_and_open` has three legs:
//!
//! 1. The live run: one webhook, one charge, one HTTP call to `https://example.com/charges`.
//! 2. A file whose saved snapshot is older than the call. A save taken before the call is opened
//!    and played until its call is answered, and that host saves again. The second file's base
//!    snapshot is still the one from before the call, so opening it replays the call from the
//!    log, muted. The test checks that the replayed call is reconciled against the dispatch
//!    ledger and isn't sent: nothing stays in flight, nothing times out, and nothing is sent.
//! 3. The usual open: a file saved after the answer. Opening it restores the snapshot taken at
//!    save time, so it replays nothing.
//!
//! Leg 2 exists because leg 3 alone can't fail. With nothing re-folded on open, removing the
//! ledger check from `Host::recover` or dispatching what it re-emits changes nothing on that
//! leg. On leg 2 the first leaves the answered call in flight until it times out, and the second
//! sends it twice.
//!
//! `save_refused_while_the_call_is_out` checks the other half of the promise: a save taken while
//! the call is out is refused, so no file can hold a call that was sent and not yet answered.

// The board file lives on disk.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use fabrico_core::command::{Command, Effect, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_engine::board::{BoardFile, ScriptInput, parse_board};
use fabrico_engine::scripted::{ScriptedExecutor, script_payload};
use fabrico_host::demo_scene::{seed_scene, timers_from_log};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{ProjectError, ProjectFile, load_project, save_project};
use tokio::sync::mpsc::unbounded_channel;

const BOARD: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/boards/docs/patterns-call-exactly-once.board.ron");

/// The one URL the board's HTTP Sink calls.
const CHARGES_URL: &str = "https://example.com/charges";

/// A cap on every "tick until" loop, so a host that never settles fails instead of hanging.
const TICK_CAP: u64 = 2_000;

/// One host's run: the script cursor, the scripted executor, and every HTTP command the host
/// handed to the dispatch closure.
struct Run {
    board: BoardFile,
    minted: Vec<NodeId>,
    exec: ScriptedExecutor,
    cursor: usize,
    correlation: u64,
    http_sent: Vec<Command>,
}

impl Run {
    /// A run for a host standing at `tick`: script entries before that tick were fed already.
    fn at(board: &BoardFile, minted: &[NodeId], tick: u64) -> Self {
        Self {
            board: board.clone(),
            minted: minted.to_vec(),
            exec: ScriptedExecutor::new(board.executor.clone()),
            cursor: board.script.iter().take_while(|e| e.tick < tick).count(),
            correlation: 0,
            http_sent: Vec::new(),
        }
    }

    /// One tick through `Host::tick_with_dispatch`, in the order `BoardRun::step` follows: script
    /// entries, due results, the tick, new handles, then each dispatched command to the executor.
    fn tick(&mut self, host: &mut Host) {
        let (ingress_tx, mut ingress_rx) = unbounded_channel::<EventPayload>();
        let (results_tx, mut results_rx) = unbounded_channel::<ResultEvent>();
        let t = host.core().tick;
        while let Some(entry) = self.board.script.get(self.cursor).filter(|e| e.tick == t) {
            assert!(!matches!(entry.input, ScriptInput::Edit(_)), "this board scripts no edits");
            if let Some(payload) =
                script_payload(&entry.input, t, &self.minted, &mut self.correlation).expect("script payload")
            {
                ingress_tx.send(payload).expect("send ingress");
            }
            self.cursor += 1;
        }
        for result in self.exec.due(t) {
            results_tx.send(result).expect("send result");
        }
        let mut sent: Vec<Command> = Vec::new();
        host.tick_with_dispatch(&mut ingress_rx, &mut results_rx, |cmd, _ledger| sent.push(cmd.clone()))
            .expect("tick");
        self.minted.extend(host.core().last_tick.placed.iter().copied());
        for cmd in &sent {
            if matches!(cmd.effect, Effect::Http { .. }) {
                self.http_sent.push(cmd.clone());
            }
            self.exec.on_command(t, cmd);
        }
    }

    /// Tick until `done` holds, failing past the cap.
    fn tick_until(&mut self, host: &mut Host, what: &str, done: impl Fn(&Host, &Run) -> bool) {
        let start = host.core().tick;
        while !done(host, self) {
            assert!(host.core().tick < start + TICK_CAP, "the host never reached {what} (from tick {start})");
            self.tick(host);
        }
    }
}

fn url_of(cmd: &Command) -> &str {
    match &cmd.effect {
        Effect::Http { url, .. } => url,
        other => panic!("not an HTTP command: {other:?}"),
    }
}

fn count_logged(host: &Host, pick: impl Fn(&EventPayload) -> bool) -> usize {
    host.logged_events().expect("read the event log").iter().filter(|e| pick(&e.payload)).count()
}

fn timeouts(host: &Host) -> usize {
    count_logged(host, |p| matches!(p, EventPayload::Timeout { .. }))
}

/// A scratch folder under the test target's own temp path, not `/tmp`.
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("scratch dir")
}

/// The tick a saved file restores before it replays: its base snapshot's tick.
fn base_tick(path: &Path) -> (u64, u64) {
    let bytes = std::fs::read(path).expect("read the saved file");
    let file: ProjectFile = postcard::from_bytes(&bytes).expect("decode the saved file");
    let base = fabrico_core::snapshot::restore(&file.snapshot).expect("restore the base snapshot").tick;
    (base, file.head_tick)
}

/// Boot the board on a fresh host with its own stores in `dir`.
fn boot(dir: &Path) -> (BoardFile, Host, Vec<NodeId>) {
    let board = parse_board(&std::fs::read_to_string(BOARD).expect("read the board")).expect("parse the board");
    let core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: board.seed });
    let store = RedbStore::open(dir.join("log.redb")).expect("open the event log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open the ledger");
    let mut host = Host::new(core, store, ledger, None).expect("build the host");
    let minted = seed_scene(&mut host, &board.commands).expect("seed the board");
    host.set_timers(timers_from_log(&host).expect("read the edit log"));
    (board, host, minted)
}

#[test]
fn one_dispatch_across_save_and_open() {
    let dir = scratch();
    let (board, mut live, minted) = boot(dir.path());
    let mut run = Run::at(&board, &minted, live.core().tick);

    // Leg 1, the live run. Save once on a tick before the call, for leg 2.
    let early: PathBuf = dir.path().join("before-the-call.fab");
    run.tick_until(&mut live, "tick 50", |h, _| h.core().tick == 50);
    save_project(&live, &early).expect("a save before the call is quiescent");
    run.tick_until(&mut live, "the call's answer", |h, r| !r.http_sent.is_empty() && h.in_flight_len() == 0);

    assert_eq!(run.http_sent.len(), 1, "the page says the board makes one call; the live run sent {}", run.http_sent.len());
    let call = run.http_sent[0].clone();
    assert_eq!(url_of(&call), CHARGES_URL, "the one call goes to the board's charges URL");
    let call_tick = call.id.0;
    assert!(call_tick > 50, "the early save must come before the call (call on tick {call_tick})");
    assert_eq!(
        count_logged(&live, |p| matches!(p, EventPayload::CommandResult(_))),
        1,
        "the page says the answer is logged once"
    );
    assert_eq!(timeouts(&live), 0, "the call is answered inside its deadline, so nothing times out");
    // Past the deadline the live run still sends nothing more.
    run.tick_until(&mut live, "the call's deadline", |h, _| h.core().tick > call.deadline + 1);
    assert_eq!(run.http_sent.len(), 1, "the page says the call is never sent again; the live run sent {}", run.http_sent.len());

    // Leg 2: a file whose saved snapshot is older than the call.
    let open_early = scratch();
    let mut first = load_project(&early, open_early.path(), None).expect("open the save from before the call");
    let mut first_run = Run::at(&board, &minted, first.core().tick);
    first_run.tick_until(&mut first, "the call's answer after the early open", |h, r| {
        !r.http_sent.is_empty() && h.in_flight_len() == 0
    });
    // Opening a save from before the call and playing on is a new run of that call: it goes out
    // once, with the same id, so the receiver gets the same Idempotency-Key.
    assert_eq!(first_run.http_sent.len(), 1, "playing on from a save before the call sends it once");
    assert_eq!(first_run.http_sent[0].id, call.id, "the call sent after the early open has the live call's id");

    let second: PathBuf = open_early.path().join("after-the-call.fab");
    save_project(&first, &second).expect("the host is quiescent once the call is answered");
    let (second_base, second_head) = base_tick(&second);
    assert!(
        second_base < call_tick,
        "leg 2 needs a file whose base snapshot predates the call (base {second_base}, call on tick {call_tick}); \
         on a head-snapshot file this leg can't fail"
    );
    assert!(second_head > call_tick, "the second file is saved after the call (head {second_head})");

    let open_second = scratch();
    let mut reopened = load_project(&second, open_second.path(), None).expect("open the file saved after the call");
    assert_eq!(
        reopened.in_flight_len(),
        0,
        "the page says an open sends nothing: the answered call replayed from the log must not be in flight"
    );
    let mut reopened_run = Run::at(&board, &minted, reopened.core().tick);
    reopened_run.tick_until(&mut reopened, "the call's deadline after the open", |h, _| h.core().tick > call.deadline + 1);
    assert_eq!(
        reopened_run.http_sent.len(),
        0,
        "the page says the call is never sent again on replay; the open sent {}",
        reopened_run.http_sent.len()
    );
    assert_eq!(
        first_run.http_sent.len() + reopened_run.http_sent.len(),
        1,
        "one call across the save and the open"
    );
    assert_eq!(timeouts(&reopened), 0, "the page says the answered call stays answered: no Timeout after the open");

    // Leg 3, the common case: a file saved after the answer. Its base is the head snapshot, so
    // the open replays nothing.
    let usual: PathBuf = dir.path().join("usual.fab");
    save_project(&live, &usual).expect("the live host is quiescent");
    let (usual_base, usual_head) = base_tick(&usual);
    assert_eq!(usual_base, usual_head, "the usual save restores the state it saved");
    let open_usual = scratch();
    let mut opened = load_project(&usual, open_usual.path(), None).expect("open the usual save");
    let mut opened_run = Run::at(&board, &minted, opened.core().tick);
    let past = opened.core().tick + 700;
    opened_run.tick_until(&mut opened, "700 ticks after the usual open", |h, _| h.core().tick > past);
    assert_eq!(opened_run.http_sent.len(), 0, "the page says an open sends nothing; the usual open sent {}", opened_run.http_sent.len());
    assert_eq!(timeouts(&opened), 0, "no Timeout after the usual open");
}

#[test]
fn save_refused_while_the_call_is_out() {
    let dir = scratch();
    let (board, mut host, minted) = boot(dir.path());
    let mut run = Run::at(&board, &minted, host.core().tick);
    run.tick_until(&mut host, "the call going out", |_, r| !r.http_sent.is_empty());
    assert_eq!(host.in_flight_len(), 1, "the call is out and not yet answered");

    let result = save_project(&host, &dir.path().join("while-out.fab"));
    assert!(
        matches!(result, Err(ProjectError::NotQuiescent(1))),
        "the page says a save waits until no call is out; save_project returned {result:?}"
    );
}
