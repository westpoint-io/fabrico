//! The redb-persisted webhook delivery-id seen-set (INGRESS-02, store level).
//!
//! Inbound webhooks are deduped on the provider's delivery id BEFORE the event
//! is logged: a request whose id was already recorded is dropped, so a provider
//! that retries an at-least-once delivery never injects the same event twice.
//!
//! The set MUST be durable — an in-memory hash set would (a) lose all dedup
//! state on restart, re-admitting every previously-seen delivery, and (b) is a
//! banned determinism type anyway (RESEARCH Pitfall 7). So this mirrors
//! `fabrico_core::persist::RedbStore`: one redb table keyed by the delivery-id
//! bytes, an explicit caller-provided path (never ambient), a durable
//! `begin_write → commit` fsync before the caller logs the event, and
//! [`MAX_RECORD_BYTES`] bounding so a hostile/oversized id yields a typed
//! [`StoreError`] instead of an unbounded allocation or a panic (threat
//! T-05-02-DES). The recorded value is the tick the id was logged at — kept for
//! audit, not used by the dedup check itself.

use std::path::Path;

use fabrico_core::persist::{MAX_RECORD_BYTES, StoreError};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};

/// redb table: the webhook delivery-id seen-set, keyed by the raw delivery-id
/// bytes. The value is the `tick` the id was first logged at (audit only).
const SEEN: TableDefinition<&[u8], u64> = TableDefinition::new("webhook_seen");

/// Flatten any redb backend error into a [`StoreError::Backend`].
///
/// (Mirrors `persist.rs`'s private `backend` helper, which is not re-exported.)
fn backend<E: std::fmt::Display>(e: E) -> StoreError {
    StoreError::Backend(e.to_string())
}

/// A durable, restart-surviving set of webhook delivery ids.
///
/// Owns a single redb [`Database`] file handle (the only IO surface, and an
/// explicit caller-provided path — never ambient).
#[derive(Debug)]
pub struct SeenSet {
    db: Database,
}

impl SeenSet {
    /// Open (creating if absent) a seen-set database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let db = Database::create(path).map_err(backend)?;
        Ok(Self { db })
    }

    /// Record `delivery_id` as seen (storing `tick` for audit).
    ///
    /// Returns `true` if the id was newly inserted (the caller SHOULD log the
    /// event), or `false` if it was already present (a duplicate — the caller
    /// MUST drop it). The insert is committed durably before returning `true`,
    /// so a crash after the caller logs cannot lose the dedup record
    /// (threat T-05-02-DEDUP-RESTART). An id longer than [`MAX_RECORD_BYTES`] is
    /// rejected as [`StoreError::TooLarge`], never a panic (threat T-05-02-DES).
    pub fn record(&mut self, delivery_id: &[u8], tick: u64) -> Result<bool, StoreError> {
        if delivery_id.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        let wtx = self.db.begin_write().map_err(backend)?;
        let newly_inserted;
        {
            let mut table = wtx.open_table(SEEN).map_err(backend)?;
            // Existence check inside the same write txn keeps record() atomic.
            if table.get(delivery_id).map_err(backend)?.is_some() {
                newly_inserted = false;
            } else {
                table.insert(delivery_id, tick).map_err(backend)?;
                newly_inserted = true;
            }
        }
        if newly_inserted {
            // Durable fsync BEFORE the caller logs the event.
            wtx.commit().map_err(backend)?;
        } else {
            // Nothing written — abort cleanly rather than commit a no-op.
            wtx.abort().map_err(backend)?;
        }
        Ok(newly_inserted)
    }

    /// Whether `delivery_id` has been recorded.
    ///
    /// A never-written table (a freshly-opened database) reads back as
    /// not-seen (`Ok(false)`), not an error.
    pub fn contains(&self, delivery_id: &[u8]) -> Result<bool, StoreError> {
        let rtx = self.db.begin_read().map_err(backend)?;
        let table = match rtx.open_table(SEEN) {
            Ok(table) => table,
            // No id has ever been recorded → nothing is seen.
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(false),
            Err(e) => return Err(backend(e)),
        };
        Ok(table.get(delivery_id).map_err(backend)?.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tempdir + the redb path inside it (kept separate so the restart test
    /// can drop the `SeenSet` and reopen the SAME path).
    fn seen_set_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("webhook-seen.redb");
        (dir, path)
    }

    fn open(path: &std::path::Path) -> SeenSet {
        SeenSet::open(path).expect("open seen-set")
    }

    #[test]
    fn seen_set_record_first_true_then_false_on_repeat() {
        let (_dir, path) = seen_set_path();
        let mut set = open(&path);
        let id = b"delivery-abc";
        assert!(set.record(id, 10).expect("first record"), "first sighting is newly inserted");
        assert!(
            !set.record(id, 11).expect("repeat record"),
            "a repeat delivery id is already seen"
        );
    }

    #[test]
    fn seen_set_contains_false_before_true_after() {
        let (_dir, path) = seen_set_path();
        let mut set = open(&path);
        let id = b"delivery-xyz";
        // A freshly-opened db has no table yet → not-seen, not an error.
        assert!(!set.contains(id).expect("contains before"), "unseen before record");
        set.record(id, 5).expect("record");
        assert!(set.contains(id).expect("contains after"), "seen after record");
    }

    #[test]
    fn seen_set_dedup_persists_across_restart() {
        let (_dir, path) = seen_set_path();
        let id = b"delivery-durable";
        {
            let mut set = open(&path);
            assert!(set.record(id, 42).expect("record"), "newly inserted");
            // Drop the SeenSet (closes the db handle) — simulates a restart.
        }
        // Reopen the SAME redb file: the durable commit must survive.
        let reopened = open(&path);
        assert!(
            reopened.contains(id).expect("contains after reopen"),
            "dedup state must survive a restart (durable commit)"
        );
        // And a re-delivery of the same id is still a duplicate.
        let mut reopened_mut = reopened;
        assert!(
            !reopened_mut.record(id, 99).expect("re-record after restart"),
            "the same delivery id is still deduped after a restart"
        );
    }

    #[test]
    fn seen_set_oversized_id_is_too_large_not_panic() {
        let (_dir, path) = seen_set_path();
        let mut set = open(&path);
        let oversized = vec![0u8; MAX_RECORD_BYTES + 1];
        assert_eq!(
            set.record(&oversized, 0),
            Err(StoreError::TooLarge),
            "an oversized delivery id is rejected, not a panic"
        );
        // A record exactly at the cap is accepted (boundary is inclusive).
        let at_cap = vec![1u8; MAX_RECORD_BYTES];
        assert!(set.record(&at_cap, 1).expect("at-cap record"), "at-cap id is accepted");
    }
}
