//! The capstone vertical slice (headless): a webhook payload flows
//! `source -> JS factory transform -> debug sink` end-to-end through the real
//! assembly API + the [`Host`] driver, capturing EXACTLY ONE Debug effect at the
//! executor seam, then the whole cycle is proven to survive replay and save/load
//! byte-for-byte.
//!
//! The slice ended in an email sink until phase 85 removed the mail sender (D-08).
//! It now ends in a Debug sink, and every criterion it asserted is asserted over
//! the one captured Debug effect instead; none was dropped.
//!
//! The slice hand-rolls a tiny deterministic mini-executor rather than calling
//! `executor::dispatch()`, so it can see each effect it resolves: drive
//! [`Host::tick_once`], drain the command channel, resolve each `Effect::Debug`
//! via [`dispatch_debug`] while recording its command id and message bytes, and
//! feed the `Outcome` back as a [`ResultEvent`] the host folds on a later tick.
//! ZERO production change (Open Question 3: ship the mini-executor, defer any
//! injection seam).
//!
//! The four ROADMAP success criteria, one test each:
//! - `end_to_end_captures_one_debug_effect` (SC#1): the slice captures exactly one
//!   Debug effect, from the sink node, carrying the factory's transformed bytes.
//! - `replay_reproduces_state_one_debug_effect` (SC#2): `Host::recover` (muted)
//!   reproduces the head state byte-for-byte AND re-fires no second effect
//!   (exactly-once).
//! - `save_load_identical_state` (SC#3): `save_project -> load_project` yields a
//!   byte-identical running state (the snapshot byte-equality oracle).
//! - `load_replays_forward_to_head_hash` (SC#4): the bundled base snapshot is at
//!   `base_tick < head_tick`, so load restores the base and replays the log forward
//!   to a state that byte-matches the saved head (the substrate proof).
//!
//! Exactly-once across save/load/replay rests on a QUIESCENT save (RESEARCH
//! Pitfall 3): the mini-executor models the effect's async result landing a tick
//! after dispatch, then ticks until the `CommandResult{Success}` is folded and the
//! in-flight set is empty BEFORE any snapshot/save is read. The muted replay
//! re-folds that logged Success as audit-only, never a re-dispatch.

use std::collections::BTreeSet;
use std::path::Path;

use fabrico_core::command::{Command, Effect, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::factory::DEFAULT_GAS_BUDGET;
use fabrico_core::ids::{CommandId, Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::SinkTemplate;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_host::sinks::debug::dispatch_debug;
use tokio::sync::mpsc::unbounded_channel;

/// Genesis seed (also the factory RNG sub-seed parameter). Fixed so every rebuild
/// of the topology mints identical NodeIds + factory substreams — the replay /
/// load paths route the logged ids and reproduce the same state.
const SEED: u64 = 7;

/// The factory transform: parse the inbound webhook JSON (`JSON.parse(body)` is the
/// engine's input decode) and emit a human line built from `input.name` (the emit
/// payload is `JSON.stringify`'d; RESEARCH Pitfall 5: the POST body must be valid
/// JSON, e.g. `{"name":"Ada"}`).
const TRANSFORM_JS: &str = r#"export default function (input, ctx) {
  var name = (input && input.name) ? input.name : "world";
  ctx.emit(0, "fabrico received an event for " + name);
}"#;

/// The bytes the Debug sink must receive: the factory's emitted string for the
/// webhook below, `JSON.stringify`'d (so it carries its quotes).
const EXPECTED_MESSAGE: &[u8] = br#""fabrico received an event for Ada""#;

/// The inbound webhook body — valid JSON (Pitfall 5).
const WEBHOOK_BODY: &[u8] = br#"{"name":"Ada"}"#;

/// Snapshot cadence. A SMALL cadence so a persisted base snapshot lands strictly
/// before the head tick (SC#4 replay-forward is non-trivial — Open Question 1).
const SNAPSHOT_EVERY: Option<u64> = Some(2);

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: SEED,
    }
}

/// Wire the `source -> factory -> debug-sink` topology onto `core`, returning the
/// three node ids. Identical insertion order on every call (live build, replay
/// rebuild) mints identical generational NodeIds.
fn wire(core: &mut Core) -> (NodeId, NodeId, NodeId) {
    let src = core.state.add_source();
    let fact = core
        .state
        .add_factory(TRANSFORM_JS.to_owned(), DEFAULT_GAS_BUDGET, SEED);
    let sink = core.state.add_sink(
        SinkTemplate::Debug,
        // A long deadline so the in-flight effect never times out before its
        // (deferred) Success folds back.
        10,
    );
    core.state.link((src, 0), (fact, 0));
    core.state.link((fact, 0), (sink, 0));
    (src, fact, sink)
}

/// One Debug effect the mini-executor resolved: the command id it carried and
/// the message bytes the sink handed over.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Captured {
    id: CommandId,
    message: Vec<u8>,
}

/// The mini-executor's one resolver: a Debug effect is recorded and resolved by
/// the real debug sink; anything else is a trivial Success, recording nothing.
fn resolve(cmd: &Command, capture: &mut Vec<Captured>) -> Outcome {
    match &cmd.effect {
        Effect::Debug { message } => {
            capture.push(Captured {
                id: cmd.id,
                message: message.clone(),
            });
            dispatch_debug(message)
        }
        _ => Outcome::Success,
    }
}

/// The command ids already resolved (a logged `CommandResult` or `Timeout`) in
/// `events` — the at-most-once set the muted replay must NOT re-dispatch.
fn resolved_ids(events: &[Event]) -> BTreeSet<CommandId> {
    let mut resolved = BTreeSet::new();
    for ev in events {
        match &ev.payload {
            EventPayload::CommandResult(re) => {
                resolved.insert(re.command_id);
            }
            EventPayload::Timeout { command_id } => {
                resolved.insert(*command_id);
            }
            _ => {}
        }
    }
    resolved
}

/// Build the slice on temp redb under `dir` and drive the hand-rolled mini-executor
/// to a QUIESCENT boundary: inject one webhook payload, tick until the Debug
/// effect is dispatched + captured and its `CommandResult{Success}` is folded
/// (in-flight empty). Returns the live host (its tick == head_tick), the capture
/// and the sink's node id.
///
/// The effect's result is fed back ONE tick after dispatch (modelling the real async
/// round-trip `run()` paces with `tick_pause`). This guarantees the `CommandResult`
/// is logged at a tick strictly after the latest base-snapshot boundary, so the
/// bundled base lands at `base_tick < head_tick` for the SC#4 replay-forward proof.
/// There are NO trailing idle ticks: the loop stops the instant the slice quiesces,
/// so the persisted log drives a cold replay exactly to head (idle ticks would
/// advance `core.tick` past the last logged event and diverge a log-only replay).
async fn run_slice(dir: &Path, snapshot_every: Option<u64>) -> (Host, Vec<Captured>, NodeId) {
    let mut core = Core::genesis(header());
    let (src, _fact, sink) = wire(&mut core);
    let store = RedbStore::open(dir.join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, snapshot_every).expect("open host");

    let mut capture: Vec<Captured> = Vec::new();
    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();

    // The webhook payload, injected in-process (the runnable example fires a real
    // loopback socket; here the topology + mini-executor are what we prove).
    ing_tx
        .send(EventPayload::ManualInject {
            target: src,
            port: 0,
            item: Item(WEBHOOK_BODY.to_vec()),
        })
        .expect("seed ingress");

    // A result queued this iteration is sent on the NEXT one (one-tick async
    // latency). The slice emits a single Debug command, so a one-slot buffer holds.
    let mut pending: Option<ResultEvent> = None;
    let mut guard = 0u32;
    loop {
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
            .expect("tick");

        // Deliver the previous iteration's result to the sim now (it folds this
        // tick, stamped with the host's admit tick).
        if let Some(re) = pending.take() {
            let _ = res_tx.send(re);
        }

        // Resolve each freshly-emitted command. Debug is recorded and resolved by
        // the real debug sink (no socket); anything else is a trivial Success.
        while let Ok(cmd) = cmd_rx.try_recv() {
            let outcome = resolve(&cmd, &mut capture);
            pending = Some(ResultEvent {
                command_id: cmd.id,
                tick: 0, // the host stamps the real admit tick on fold
                outcome,
            });
        }

        // Quiescent: the effect captured AND its result folded (in-flight empty) AND
        // nothing left to deliver. Stop immediately, no trailing idle ticks.
        if host.in_flight_len() == 0 && capture.len() == 1 && pending.is_none() {
            break;
        }

        guard += 1;
        assert!(guard < 64, "the slice failed to quiesce within 64 ticks");
    }

    (host, capture, sink)
}

#[tokio::test]
async fn end_to_end_captures_one_debug_effect() {
    // SC#1: webhook -> factory -> debug sink captures EXACTLY ONE Debug effect,
    // headless, no socket; it was emitted by the sink node and carries the
    // factory's transformed bytes, not the raw webhook body.
    let dir = tempfile::tempdir().expect("tempdir");
    let (_host, capture, sink) = run_slice(dir.path(), SNAPSHOT_EVERY).await;

    assert_eq!(capture.len(), 1, "exactly one Debug effect captured end-to-end");
    let (_tick, node, _seq) = capture[0].id;
    assert_eq!(node, sink, "the captured effect was emitted by the debug sink node");
    assert_eq!(
        capture[0].message,
        EXPECTED_MESSAGE,
        "the debug sink received the factory's transformed bytes"
    );
}

#[tokio::test]
async fn replay_reproduces_state_one_debug_effect() {
    // SC#2: re-running the recorded log via Host::recover() (executor muted)
    // reproduces the head state byte-for-byte AND re-fires NO second effect.
    //
    // No snapshot cadence here (`None`): the muted recover() replays the WHOLE log
    // from genesis, so it RE-EMITS the Debug command (emitted at tick 0), the set
    // we prove is never re-dispatched. (A mid-stream base snapshot, as SC#4 uses,
    // would hide the tick-0 emission behind the snapshot; full replay is the strong
    // exactly-once proof.)
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, capture, _src) = run_slice(dir.path(), None).await;
    assert_eq!(capture.len(), 1, "the live run captured one Debug effect");

    let original = host.snapshot_bytes();
    let head = host.core().tick;
    // Drop the live host so its redb file locks release before we reopen the SAME
    // store in a fresh "process".
    drop(host);

    // Rebuild the SAME topology over the SAME persisted redb; recover() muted.
    let mut core = Core::genesis(header());
    let _ = wire(&mut core);
    let store = RedbStore::open(dir.path().join("log.redb")).expect("reopen log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("reopen ledger");
    let mut recovered = Host::new(core, store, ledger, None).expect("open host");
    let emitted = recovered.recover().expect("recover");

    // The muted replay reproduced the live trajectory byte-for-byte.
    assert_eq!(
        recovered.snapshot_bytes(),
        original,
        "recovered state == live head state (byte-equality oracle)"
    );
    assert_eq!(recovered.core().tick, head, "replay folded forward to head_tick");

    // Exactly-once: the muted replay re-emits the Debug command, but its Success is
    // already in the log, so driving a fresh capture over the emitted set (skipping
    // resolved commands, exactly as the mini-executor would on replay) dispatches
    // NOTHING. No second effect is ever fired.
    let re_emitted: Vec<&Command> = emitted
        .iter()
        .filter(|c| matches!(c.effect, Effect::Debug { .. }))
        .collect();
    assert_eq!(
        re_emitted.len(),
        1,
        "the muted replay re-emitted the one Debug command"
    );
    assert_eq!(
        re_emitted[0].id, capture[0].id,
        "the re-emitted command is the one the live run resolved"
    );
    let resolved = resolved_ids(&recovered.logged_events().expect("read log"));
    let mut replay_cap: Vec<Captured> = Vec::new();
    for cmd in &emitted {
        if !resolved.contains(&cmd.id) {
            // Unreachable for the slice's command (it IS resolved): present to prove
            // the gate, never to fire a second effect.
            resolve(cmd, &mut replay_cap);
        }
    }
    assert!(
        replay_cap.is_empty(),
        "the muted replay fired no second effect (exactly-once on replay)"
    );
}

#[tokio::test]
async fn save_load_identical_state() {
    // SC#3: save_project -> load_project yields snapshot(loaded) == snapshot(original)
    // — a byte-identical running state, loaded into a FRESH work dir.
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, _capture, _src) = run_slice(dir.path(), SNAPSHOT_EVERY).await;
    assert_eq!(
        host.in_flight_len(),
        0,
        "save is taken at a quiescent boundary (in-flight empty)"
    );

    let original = host.snapshot_bytes();
    let path = dir.path().join("slice.fab");
    save_project(&host, &path).expect("save");

    // A SEPARATE fresh tempdir for the loaded store (RESEARCH Pitfall 4).
    let load_dir = tempfile::tempdir().expect("fresh work_dir");
    let loaded = load_project(&path, load_dir.path(), SNAPSHOT_EVERY).expect("load");

    assert_eq!(
        loaded.core().tick,
        host.core().tick,
        "loaded host reaches the saved head_tick"
    );
    assert_eq!(
        loaded.snapshot_bytes(),
        original,
        "loaded state is byte-identical to the original (SC#3)"
    );
}

#[tokio::test]
async fn load_replays_forward_to_head_hash() {
    // SC#4: the bundled base snapshot is at base_tick < head_tick, so load_project
    // restores the base and replays the log FORWARD to a state that byte-matches the
    // saved head (the substrate proof — non-trivial replay-forward).
    let dir = tempfile::tempdir().expect("tempdir");
    let (host, _capture, _src) = run_slice(dir.path(), SNAPSHOT_EVERY).await;

    let original = host.snapshot_bytes();
    let head = host.core().tick;

    // The base snapshot save_project will bundle is the latest PERSISTED snapshot —
    // assert it lands strictly before head so replay-forward is exercised.
    let (base_tick, _bytes) = host
        .latest_persisted_snapshot()
        .expect("read persisted snapshot")
        .expect("a base snapshot was persisted before head");
    assert!(
        base_tick < head,
        "base_tick {base_tick} must be strictly before head_tick {head} (replay-forward)"
    );

    let path = dir.path().join("slice.fab");
    save_project(&host, &path).expect("save");

    // THE BUNDLE ITSELF keeps the persisted base (phase 86 review, IN-02). The assertion
    // above reads the store, not the file; a save that always wrote the head snapshot would
    // pass it. Decoded from the saved bytes, the bundled base must be the persisted restart
    // point, strictly before the head, so the keep-the-base branch of `replay_end` is graded.
    // Reading the saved file back is host-side test IO, not the sim core the lint fences.
    #[allow(clippy::disallowed_methods)]
    let saved = std::fs::read(&path).expect("read the saved file");
    let bundle: fabrico_host::project::ProjectFile =
        postcard::from_bytes(&saved).expect("the saved file decodes");
    let bundled_base = fabrico_core::snapshot::restore(&bundle.snapshot)
        .expect("the bundled base snapshot restores")
        .tick;
    assert_eq!(
        (bundled_base, bundle.head_tick),
        (base_tick, head),
        "the file bundles the persisted base {base_tick}, not the head {head}"
    );

    let load_dir = tempfile::tempdir().expect("fresh work_dir");
    let loaded = load_project(&path, load_dir.path(), SNAPSHOT_EVERY).expect("load");

    assert_eq!(
        loaded.core().tick,
        head,
        "load restored the base and replayed the log forward to head_tick"
    );
    assert_eq!(
        loaded.snapshot_bytes(),
        original,
        "post-load state byte-matches the saved head (byte-equality == tick-hash equality)"
    );
}
