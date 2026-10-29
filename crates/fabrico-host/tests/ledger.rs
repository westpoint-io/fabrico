//! Crash-sim integration coverage for the write-ahead dispatch ledger (EXEC-04).
//!
//! The load-bearing acceptance phrase for this phase is "never send the email
//! twice" (written when the sink set held an Email target; phase 85 removed it, and
//! the non-idempotent effect these tests carry is now an HTTP POST): a crash AFTER the `InFlight` marker is durable but BEFORE the effect
//! completes must NEVER re-dispatch the effect on recovery (at-most-once). These
//! tests model the crash by dropping the [`DispatchLedger`] handle (closing the
//! redb file) without calling `mark_done`, then reopening a fresh ledger over the
//! SAME path — a real durable reopen, not an in-memory shortcut — and asserting
//! the recovery verdict refuses to resend.

use std::collections::BTreeSet;

use fabrico_core::command::{Command, Dispatch, Effect, EVENT_VERSION, Outcome};
use fabrico_core::ids::{CommandId, NodeId};
use fabrico_host::executor::CountingExecutor;
use fabrico_host::ledger::{DispatchLedger, Recovery};
use slotmap::{Key, SlotMap};

/// A tempdir + the redb path inside it (kept separate so the crash-sim can drop
/// the `DispatchLedger` and reopen the SAME path).
fn ledger_path() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("dispatch-ledger.redb");
    (dir, path)
}

fn open(path: &std::path::Path) -> DispatchLedger {
    DispatchLedger::open(path).expect("open dispatch ledger")
}

fn mint_node() -> NodeId {
    let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
    alloc.insert(())
}

/// An HTTP POST command — the canonical "launch the rocket" non-idempotent effect.
fn post_command(id: CommandId) -> Command {
    Command {
        event_version: EVENT_VERSION,
        id,
        partition: 0,
        effect: Effect::Http {
            url: "https://example.com/alert".to_owned(),
            body: b"the building is on fire".to_vec(),
            method: fabrico_core::state::HttpMethod::Post,
        },
        deadline: 100,
    }
}

/// Crash-sim helper: open a fresh ledger at `path`, write the `InFlight` marker
/// durably for `cmd`, then DROP the handle WITHOUT `mark_done` — modelling a
/// crash after the write-ahead marker but before the effect completes.
fn inflight_then_crash(path: &std::path::Path, cmd: &Command) {
    let mut ledger = open(path);
    ledger
        .before_dispatch(cmd)
        .expect("InFlight marker committed durably");
    // `ledger` drops here, closing the redb file — the simulated crash.
}

/// The at-most-once resend gate: drive every command the recovery scan surfaced
/// through a `CountingExecutor`, dispatching ONLY commands that are NOT flagged
/// `do_not_resend`. Returns the executor so the caller can read its count.
///
/// Because `recover()` places every crashed-mid-flight command in
/// `do_not_resend`, feeding those same commands through this gate must dispatch
/// exactly ZERO of them — the proof that recovery never re-fires the effect.
fn drive_resend_gate(recovery: &Recovery) -> CountingExecutor {
    let blocked: BTreeSet<CommandId> =
        recovery.do_not_resend.iter().map(|(id, _)| *id).collect();
    let mut exec = CountingExecutor::default();
    for (id, cmd) in &recovery.do_not_resend {
        // At-most-once: a do-not-resend command is NEVER dispatched.
        if blocked.contains(id) {
            continue;
        }
        exec.dispatch(cmd);
    }
    exec
}

/// EXEC-04, "never send the effect twice": an `InFlight`-then-crash command is
/// surfaced as do-not-resend on recovery, and driving the recovery output
/// through the at-most-once gate dispatches it ZERO times.
#[test]
fn recovery_never_resends() {
    let (_dir, path) = ledger_path();
    let node = mint_node();
    let id: CommandId = (5, node, 0);
    let cmd = post_command(id);

    // 1. Write the POST's InFlight marker durably, then crash mid-flight.
    inflight_then_crash(&path, &cmd);

    // 2. Reopen the SAME redb path (durability across the simulated crash) and
    //    recover with an EMPTY logged-results set (no CommandResult was logged).
    let reopened = open(&path);
    let recovery = reopened
        .recover(&BTreeSet::new())
        .expect("recover after crash");

    // The crashed-mid-flight command is surfaced as do-not-resend...
    assert_eq!(
        recovery.do_not_resend.len(),
        1,
        "the in-flight command must be flagged do-not-resend"
    );
    let (recovered_id, recovered_cmd) = &recovery.do_not_resend[0];
    assert_eq!(*recovered_id, id, "the flagged id is the crashed command's id");
    assert_eq!(recovered_cmd, &cmd, "the full intent is recovered from the ledger");

    // 3. ...and driving recovery through the at-most-once gate sends it ZERO
    //    times — the POST is never sent twice.
    let exec = drive_resend_gate(&recovery);
    assert_eq!(
        exec.count(),
        0,
        "recovery must NEVER re-dispatch an in-flight command (never send twice)"
    );
}

/// A command that completed (`mark_done` written, the `Done` row durable) is NOT
/// flagged on recovery — no spurious resend either way.
#[test]
fn recovery_omits_done_command() {
    let (_dir, path) = ledger_path();
    let node = mint_node();
    let id: CommandId = (7, node, 1);
    let cmd = post_command(id);

    {
        let mut ledger = open(&path);
        ledger.before_dispatch(&cmd).expect("InFlight");
        ledger.mark_done(&id, &Outcome::Success).expect("Done");
        // Drop after a clean completion — reopen must see Done, not InFlight.
    }

    let reopened = open(&path);
    let recovery = reopened.recover(&BTreeSet::new()).expect("recover");
    assert!(
        recovery.do_not_resend.is_empty(),
        "a completed (Done) command must not be flagged for resend"
    );

    let exec = drive_resend_gate(&recovery);
    assert_eq!(exec.count(), 0, "no dispatch for a resolved command");
}

/// An `InFlight` command whose `CommandResult` IS already in the log
/// (`logged_results`) is treated as resolved — recovery omits it, so the result
/// folds from the log without a resend.
#[test]
fn recovery_omits_inflight_with_logged_result() {
    let (_dir, path) = ledger_path();
    let node = mint_node();
    let id: CommandId = (9, node, 2);
    let cmd = post_command(id);

    // Crash mid-flight (InFlight on disk, no Done)...
    inflight_then_crash(&path, &cmd);

    // ...but the log DID capture a CommandResult for this id before the crash.
    let mut logged = BTreeSet::new();
    logged.insert(id);

    let reopened = open(&path);
    let recovery = reopened.recover(&logged).expect("recover");
    assert!(
        recovery.do_not_resend.is_empty(),
        "an in-flight command with a logged result is already resolved"
    );
    let exec = drive_resend_gate(&recovery);
    assert_eq!(exec.count(), 0, "no resend when the result is in the log");
}

/// Sanity on the key encoding the ledger relies on: `CommandId`s sharing a node
/// but differing in tick/seq encode to distinct redb keys, so two in-flight
/// commands from the same node both survive and are both flagged.
#[test]
fn recovery_flags_every_distinct_inflight() {
    let (_dir, path) = ledger_path();
    let node = mint_node();
    // Same node, distinct (tick, seq) → distinct CommandIds / ledger keys.
    let a: CommandId = (5, node, 0);
    let b: CommandId = (5, node, 1);
    let c: CommandId = (6, node, 0);

    {
        let mut ledger = open(&path);
        for id in [a, b, c] {
            ledger
                .before_dispatch(&post_command(id))
                .expect("InFlight");
        }
    }

    let reopened = open(&path);
    let recovery = reopened.recover(&BTreeSet::new()).expect("recover");
    let mut flagged: Vec<CommandId> = recovery.do_not_resend.iter().map(|(id, _)| *id).collect();
    flagged.sort_by_key(|id| (id.0, id.1.data().as_ffi(), id.2));
    assert_eq!(
        flagged,
        vec![a, b, c],
        "every distinct in-flight command is flagged exactly once"
    );
    let exec = drive_resend_gate(&recovery);
    assert_eq!(exec.count(), 0, "none of the three in-flight commands are resent");
}
