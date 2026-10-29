//! The redb write-ahead dispatch ledger (`InFlight` → `Done`, keyed by
//! `CommandId`) + crash recovery — the exactly-once backbone (EXEC-04).
//!
//! # The write-ahead protocol
//! On the host loop, a freshly-emitted command is recorded as
//! [`LedgerRecord::InFlight`] under its deterministic [`CommandId`] and the redb
//! transaction is committed **durably (fsync)** by [`DispatchLedger::before_dispatch`]
//! BEFORE the effect task is spawned. After the effect resolves,
//! [`DispatchLedger::mark_done`] overwrites the row with [`LedgerRecord::Done`].
//! The crash window that could double-send is only the window *before* `InFlight`
//! is on disk — but at that point the effect has not run, so not-sending is safe
//! (at-most-once). After `InFlight` is committed, [`DispatchLedger::recover`]
//! refuses to resend.
//!
//! # Single-writer invariant (threat T-05-04-CONTENTION)
//! redb permits exactly one write transaction at a time. ALL ledger writes
//! (`before_dispatch` / `mark_done`) happen on the ONE owner — the host loop —
//! which takes `&mut self`. Concurrent executor tasks NEVER call `begin_write`;
//! they only send `Outcome`s back over a channel for the host loop to drain and
//! mark done. This keeps the single-writer guarantee without a mutex.
//!
//! # Durability is non-negotiable (threat T-05-04-DURABILITY)
//! The commit stays at redb's default durable (fsync) level — the reduced
//! (eventual / none) durability levels are deliberately never used. The
//! `InFlight` marker MUST be on disk before the effect can run, or a crash could
//! lose the marker and re-dispatch.
//!
//! # Bounded, non-panicking reads (threat T-05-04-DES)
//! Both the write and the read paths bound a single record by
//! [`fabrico_core::persist::MAX_RECORD_BYTES`] and decode behind a `Result`, so a
//! hostile or corrupt on-disk blob yields a typed [`fabrico_core::persist::StoreError`],
//! never an unbounded allocation or a panic. Mirrors `persist.rs` / `seen_set.rs`.

use std::collections::BTreeSet;
use std::path::Path;

use fabrico_core::command::{Command, EVENT_VERSION, Outcome, check_event_version};
use fabrico_core::ids::{CommandId, NodeId};
use fabrico_core::persist::{MAX_RECORD_BYTES, StoreError};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use slotmap::{Key, KeyData};

/// Flatten any redb backend error into a [`StoreError::Backend`].
///
/// (Mirrors `persist.rs`'s private `backend` helper, which is not re-exported.)
fn backend<E: std::fmt::Display>(e: E) -> StoreError {
    StoreError::Backend(e.to_string())
}

/// A durable, restart-surviving dispatch ledger keyed by `CommandId`.
///
/// Owns a single redb [`Database`] file handle (the only IO surface, and an
/// explicit caller-provided path — never ambient). The single host-loop owner
/// holds it `&mut` for every write (the single-writer invariant).
#[derive(Debug)]
pub struct DispatchLedger {
    db: Database,
}

impl DispatchLedger {
    /// Open (creating if absent) a dispatch ledger at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let db = Database::create(path).map_err(backend)?;
        Ok(Self { db })
    }

    /// Write-ahead the `InFlight` marker durably BEFORE the effect runs.
    ///
    /// Postcard-encodes [`LedgerRecord::InFlight`] under `key(cmd.id)` and commits
    /// at redb's default durable (fsync) level — the marker is on disk before this
    /// returns. An encoded record exceeding [`MAX_RECORD_BYTES`] is rejected as
    /// [`StoreError::TooLarge`] (so the read path would never have to reject it).
    pub fn before_dispatch(&mut self, cmd: &Command) -> Result<(), StoreError> {
        let record = LedgerRecord::InFlight {
            command: cmd.clone(),
        };
        let bytes = postcard::to_allocvec(&record).map_err(backend)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        let wtx = self.db.begin_write().map_err(backend)?;
        {
            let mut table = wtx.open_table(DISPATCHES).map_err(backend)?;
            table.insert(key(&cmd.id), bytes.as_slice()).map_err(backend)?;
        }
        // Durable fsync — the write-ahead invariant; do NOT lower durability.
        wtx.commit().map_err(backend)?;
        Ok(())
    }

    /// Overwrite the row with the `Done` outcome AFTER the effect completes.
    ///
    /// Same durable txn shape; the `Done` row marks the command resolved so
    /// recovery omits it.
    pub fn mark_done(&mut self, id: &CommandId, outcome: &Outcome) -> Result<(), StoreError> {
        let record = LedgerRecord::Done {
            outcome: outcome.clone(),
        };
        let bytes = postcard::to_allocvec(&record).map_err(backend)?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        let wtx = self.db.begin_write().map_err(backend)?;
        {
            let mut table = wtx.open_table(DISPATCHES).map_err(backend)?;
            table.insert(key(id), bytes.as_slice()).map_err(backend)?;
        }
        wtx.commit().map_err(backend)?;
        Ok(())
    }

    /// Scan the ledger and classify every command for at-most-once recovery.
    ///
    /// Range-scans the whole [`DISPATCHES`] table in key order (a never-written
    /// table reads back empty, not an error). For each row:
    /// - [`LedgerRecord::InFlight`] whose `command.id` is **absent** from
    ///   `logged_results` → pushed into `do_not_resend` (crashed mid-flight; the
    ///   effect may or may not have happened, so at-most-once means NEVER resend —
    ///   it resolves as a `Timeout` at its deadline tick in the driver).
    /// - [`LedgerRecord::Done`], or an `InFlight` whose `command.id` **is** in
    ///   `logged_results`, is omitted (already resolved — the log is the truth).
    ///
    /// A malformed or oversized stored record yields [`StoreError`], never a panic. So
    /// does an `InFlight` row whose command carries any wire version other than
    /// [`EVENT_VERSION`] (phase 85, plan 85-05): the effect enum is not self-describing,
    /// so a row written by an older build can decode positionally as a different effect
    /// (a v4 Email intent reads as an HTTP one under v5). It is refused with both
    /// versions named, never classified and never re-dispatched.
    pub fn recover(&self, logged_results: &BTreeSet<CommandId>) -> Result<Recovery, StoreError> {
        let rtx = self.db.begin_read().map_err(backend)?;
        let table = match rtx.open_table(DISPATCHES) {
            Ok(table) => table,
            // No command has ever been recorded → nothing to recover.
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(Recovery::default()),
            Err(e) => return Err(backend(e)),
        };
        let mut do_not_resend = Vec::new();
        let mut known = BTreeSet::new();
        for entry in table.iter().map_err(backend)? {
            let (key_entry, value) = entry.map_err(backend)?;
            // Reconstruct the CommandId from the fixed-width tuple key so EVERY row
            // — InFlight and Done alike — is recorded as "known to the ledger" (used
            // by the driver's WR-05 reconciliation to tell a crashed-before-WAL
            // command apart from one whose effect already completed). `from_ffi`
            // round-trips a value produced by `as_ffi` in `key()`.
            let (k0, kffi, k2) = key_entry.value();
            let cmd_id: CommandId = (k0, NodeId::from(KeyData::from_ffi(kffi)), k2);
            known.insert(cmd_id);
            let bytes = value.value();
            // Bound allocation from untrusted on-disk bytes (threat T-05-04-DES).
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(StoreError::TooLarge);
            }
            // Decode behind a Result — a malformed row is an error, never a panic.
            let record: LedgerRecord = postcard::from_bytes(bytes).map_err(backend)?;
            if let LedgerRecord::InFlight { command } = record {
                // An intent stored by another wire version is refused, never classified.
                if check_event_version(command.event_version).is_err() {
                    return Err(StoreError::Backend(format!(
                        "dispatch ledger row holds a command at event version {}, this build \
                         reads only version {EVENT_VERSION}",
                        command.event_version
                    )));
                }
                // Already resolved (its result is in the log) → omit.
                if logged_results.contains(&command.id) {
                    continue;
                }
                // In-flight at the crash, no logged result → NEVER resend.
                do_not_resend.push((command.id, command));
            }
            // Done rows are resolved → omit (but still recorded in `known`).
        }
        Ok(Recovery {
            do_not_resend,
            known,
        })
    }
}

/// The recovery verdict: commands that must NEVER be re-dispatched.
#[derive(Debug, Default)]
pub struct Recovery {
    /// `InFlight`-without-result commands — at-most-once: do NOT resend.
    pub do_not_resend: Vec<(CommandId, Command)>,
    /// EVERY command id with a ledger row (`InFlight` OR `Done`). The driver uses
    /// this to tell a command that crashed BEFORE its write-ahead row committed
    /// (absent here — must be reinstated, WR-05) apart from one whose effect already
    /// completed (`Done`, present here — must NOT be reinstated).
    pub known: BTreeSet<CommandId>,
}

/// One stored ledger row: write-ahead `InFlight`, then overwritten with `Done`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum LedgerRecord {
    /// Written BEFORE the effect runs (durable fsync) — the write-ahead marker.
    InFlight {
        /// The full command intent (so recovery can classify without the log).
        command: Command,
    },
    /// Written AFTER the effect completes — the command is resolved.
    Done {
        /// The terminal outcome of the dispatched effect.
        outcome: Outcome,
    },
}

/// redb table: the dispatch ledger, keyed by the encoded `CommandId`.
///
/// The `NodeId` inside `CommandId` is a slotmap key, not a redb-native key, so it
/// is encoded as `id.1.data().as_ffi():u64` — making the key a fixed-width
/// `(u64, u64, u32)` tuple that range-scans deterministically like the `EVENTS`
/// table in `persist.rs`.
const DISPATCHES: TableDefinition<(u64, u64, u32), &[u8]> = TableDefinition::new("dispatches");

/// Encode a `CommandId` as the fixed-width redb tuple key.
fn key(id: &CommandId) -> (u64, u64, u32) {
    (id.0, id.1.data().as_ffi(), id.2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::command::{Effect, EVENT_VERSION};
    use fabrico_core::ids::NodeId;
    use fabrico_core::persist::{MAX_RECORD_BYTES, StoreError};
    use slotmap::SlotMap;

    fn ledger_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dispatch-ledger.redb");
        (dir, path)
    }

    fn open(path: &std::path::Path) -> DispatchLedger {
        DispatchLedger::open(path).expect("open ledger")
    }

    fn mint_node() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    fn command(id: CommandId, effect: Effect) -> Command {
        Command {
            event_version: EVENT_VERSION,
            id,
            partition: 0,
            effect,
            deadline: 100,
        }
    }

    #[test]
    fn ledger_before_dispatch_is_durable_and_recovers() {
        let (_dir, path) = ledger_path();
        let node = mint_node();
        let id: CommandId = (5, node, 0);
        {
            let mut ledger = open(&path);
            ledger
                .before_dispatch(&command(id, Effect::Http {
                    url: "https://example.com/hook".into(),
                    body: b"body".to_vec(),
                    method: fabrico_core::state::HttpMethod::Post,
                }))
                .expect("before_dispatch durable");
            // Drop closes the handle — simulating a crash after the marker.
        }
        // Reopen the SAME path: the committed InFlight survives.
        let reopened = open(&path);
        let rec = reopened.recover(&BTreeSet::new()).expect("recover");
        assert_eq!(rec.do_not_resend.len(), 1, "in-flight marker survives restart");
        assert_eq!(rec.do_not_resend[0].0, id);
    }

    #[test]
    fn ledger_mark_done_removes_from_recovery() {
        let (_dir, path) = ledger_path();
        let node = mint_node();
        let id: CommandId = (7, node, 2);
        let mut ledger = open(&path);
        ledger
            .before_dispatch(&command(id, Effect::Noop))
            .expect("before_dispatch");
        ledger.mark_done(&id, &Outcome::Success).expect("mark_done");
        let rec = ledger.recover(&BTreeSet::new()).expect("recover");
        assert!(rec.do_not_resend.is_empty(), "Done rows are resolved");
    }

    #[test]
    fn ledger_recover_classifies_each_command() {
        let (_dir, path) = ledger_path();
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n0 = alloc.insert(());
        let n1 = alloc.insert(());
        let n2 = alloc.insert(());
        let inflight: CommandId = (1, n0, 0); // InFlight, no result → do_not_resend
        let resolved_logged: CommandId = (2, n1, 0); // InFlight but in logged_results → omit
        let done: CommandId = (3, n2, 0); // Done → omit

        let mut ledger = open(&path);
        ledger
            .before_dispatch(&command(inflight, Effect::Noop))
            .expect("inflight");
        ledger
            .before_dispatch(&command(resolved_logged, Effect::Noop))
            .expect("resolved");
        ledger
            .before_dispatch(&command(done, Effect::Noop))
            .expect("done-inflight");
        ledger.mark_done(&done, &Outcome::Success).expect("mark done");

        let mut logged = BTreeSet::new();
        logged.insert(resolved_logged);
        let rec = ledger.recover(&logged).expect("recover");

        let ids: Vec<CommandId> = rec.do_not_resend.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec![inflight], "only the unresolved in-flight is flagged");
    }

    #[test]
    fn ledger_before_dispatch_oversized_is_too_large_not_panic() {
        let (_dir, path) = ledger_path();
        let node = mint_node();
        let id: CommandId = (9, node, 0);
        let mut ledger = open(&path);
        let oversized = vec![0u8; MAX_RECORD_BYTES + 1];
        assert_eq!(
            ledger.before_dispatch(&command(id, Effect::Debug { message: oversized })),
            Err(StoreError::TooLarge),
            "an oversized command record is rejected, not a panic"
        );
    }

    #[test]
    fn ledger_recover_refuses_a_stored_command_of_another_event_version() {
        // T-85-11: an InFlight row written by a v4 build, raw, bypassing before_dispatch.
        // The command bytes are the frozen v4 Email witness from fabrico-core's
        // `frozen_v4_email_command_is_refused_under_v5` (captured at a pre-release revision), behind
        // the `InFlight` discriminant 0. Under v5 they decode positionally as an Http
        // effect, so only the version check stands between them and a re-dispatch.
        const FROZEN_V4_EMAIL_COMMAND: &[u8] = &[
            0x04, 0x05, 0x01, 0x01, 0x00, 0x00, 0x02, 0x05, 0x61, 0x40, 0x62, 0x2E, 0x63, 0x01,
            0x78, 0x02, 0x7B, 0x7D, 0x64,
        ];
        let (_dir, path) = ledger_path();
        let id: CommandId = (5, mint_node(), 0);
        {
            let db = Database::create(&path).expect("create db");
            let wtx = db.begin_write().expect("begin_write");
            {
                let mut table = wtx.open_table(DISPATCHES).expect("open table");
                let mut row = vec![0x00];
                row.extend_from_slice(FROZEN_V4_EMAIL_COMMAND);
                table.insert(key(&id), row.as_slice()).expect("insert v4 row");
            }
            wtx.commit().expect("commit");
        }
        let ledger = open(&path);
        let err = ledger
            .recover(&BTreeSet::new())
            .map(|_| ())
            .expect_err("a stored v4 command must be refused, never classified");
        let msg = err.to_string();
        assert!(
            msg.contains("event version 4") && msg.contains(&format!("only version {EVENT_VERSION}")),
            "the refusal names both versions: {msg}"
        );

        // And a current-version row still recovers through the same read path.
        let (_dir2, path2) = ledger_path();
        let mut fresh = open(&path2);
        fresh
            .before_dispatch(&command(id, Effect::Noop))
            .expect("before_dispatch");
        assert_eq!(
            fresh.recover(&BTreeSet::new()).expect("recover").do_not_resend.len(),
            1,
            "a current-version in-flight row is classified as before"
        );
    }

    #[test]
    fn ledger_recover_oversized_stored_record_is_too_large_not_panic() {
        let (_dir, path) = ledger_path();
        let node = mint_node();
        let id: CommandId = (11, node, 0);
        // Write a raw oversized blob directly under the DISPATCHES key, bypassing
        // before_dispatch's write-side bound, to exercise the read-side guard.
        {
            let db = Database::create(&path).expect("create db");
            let wtx = db.begin_write().expect("begin_write");
            {
                let mut table = wtx.open_table(DISPATCHES).expect("open table");
                let oversized = vec![0u8; MAX_RECORD_BYTES + 1];
                table
                    .insert(key(&id), oversized.as_slice())
                    .expect("insert oversized");
            }
            wtx.commit().expect("commit");
        }
        let ledger = open(&path);
        assert_eq!(
            ledger.recover(&BTreeSet::new()).map(|_| ()),
            Err(StoreError::TooLarge),
            "an oversized stored record is rejected on read, not a panic"
        );
    }
}
