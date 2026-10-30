//! The durability boundary for the source-of-truth event log and the periodic
//! snapshots (CORE-02, REPLAY-01/02).
//!
//! Everything here sits behind a single [`PersistenceStore`] trait so the
//! storage backend stays swappable (redb ↔ SQLite) without touching the sim —
//! the CONTEXT-locked decision that keeps the redb-vs-SQLite question reversible.
//! Two implementations satisfy the same contract:
//!
//! * [`MemStore`] — `BTreeMap`-backed, in-memory; the fast oracle the in-process
//!   determinism tests run against.
//! * [`RedbStore`] — durable, pure-Rust ACID storage over two redb tables: an
//!   `events` table keyed by the monotonic `(partition, sequence)` tuple (so a
//!   range scan returns events in exact fold order) and a `snapshots` table
//!   keyed by `tick`.
//!
//! Determinism discipline: the store is the durability seam, never reached by
//! the pure per-tick fold (CORE-03). redb's file IO is explicit — the caller
//! hands [`RedbStore::open`] a path; nothing here touches an ambient default or
//! the wall clock.
//!
//! Integrity discipline (threat T-1-DES / T-1-ORD): reads of persisted bytes
//! never panic — every backend error is mapped to a typed [`StoreError`], and a
//! single record is length-bounded by [`MAX_RECORD_BYTES`] on both the write and
//! the read paths so a malformed or oversized on-disk blob cannot drive an
//! unbounded allocation.

use std::collections::BTreeMap;
#[cfg(feature = "redb")]
use std::path::Path;

#[cfg(feature = "redb")]
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};

/// Hard upper bound on a single stored record (event payload or snapshot blob).
///
/// Enforced on both append and read. On the read path it bounds the allocation a
/// hostile or corrupt on-disk record can trigger (threat T-1-DES); on the write
/// path it refuses to persist a record the read path would later reject.
pub const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024; // 64 MiB

/// redb table: the append-only event log, keyed by `(partition, sequence)`.
///
/// redb encodes fixed-width integer tuples big-endian and compares them
/// element-by-element, so the key sorts lexicographically as
/// (partition asc, sequence asc) — exactly the order the fold consumes (the
/// integrity guarantee proven by the ordering test, threat T-1-ORD).
#[cfg(feature = "redb")]
const EVENTS: TableDefinition<(u64, u64), &[u8]> = TableDefinition::new("events");

/// redb table: the append-only EDIT log, keyed by `(partition, sequence)`.
///
/// The SECOND ordered log (Phase 8, ELOG-01): the durable home of the topology
/// `EditRecord`s, mirroring [`EVENTS`] exactly — same big-endian tuple key, so a
/// range scan returns edits in `(partition asc, sequence asc)` fold order. It
/// lives in the SAME redb [`Database`] as `EVENTS`/`SNAPSHOTS`, so the host's
/// single-writer invariant is preserved (no second store, no second writer).
#[cfg(feature = "redb")]
const EDITS: TableDefinition<(u64, u64), &[u8]> = TableDefinition::new("edits");

/// redb table: full-state snapshots, keyed by the `tick` they were taken at.
#[cfg(feature = "redb")]
const SNAPSHOTS: TableDefinition<u64, &[u8]> = TableDefinition::new("snapshots");

/// A typed, non-panicking error from a [`PersistenceStore`].
///
/// Backend failures (redb txn/commit/io errors) are flattened into
/// [`StoreError::Backend`] with a message; an over-cap record yields
/// [`StoreError::TooLarge`]. No store method ever panics on stored bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// An underlying backend (e.g. redb) operation failed.
    Backend(String),
    /// A record exceeded [`MAX_RECORD_BYTES`] on append or read.
    TooLarge,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Backend(msg) => write!(f, "persistence backend error: {msg}"),
            StoreError::TooLarge => write!(
                f,
                "record exceeds MAX_RECORD_BYTES ({MAX_RECORD_BYTES} bytes)"
            ),
        }
    }
}

impl std::error::Error for StoreError {}

/// Flatten any backend error into a [`StoreError::Backend`].
#[cfg(feature = "redb")]
fn backend<E: std::fmt::Display>(e: E) -> StoreError {
    StoreError::Backend(e.to_string())
}

/// The durability contract for the event log + snapshots.
///
/// Byte-oriented on purpose: the store is independent of the `Event`/snapshot
/// types (which serialize via postcard above this layer), so it can be built and
/// tested in isolation and the backend can be swapped freely (CONTEXT lock).
pub trait PersistenceStore {
    /// The error type surfaced by this store (never panics on stored bytes).
    type Error;

    /// Append one event record under the monotonic `(partition, sequence)` key.
    fn append_event(
        &mut self,
        partition: u64,
        sequence: u64,
        bytes: &[u8],
    ) -> Result<(), Self::Error>;

    /// Range-scan a partition's events with `sequence >= from_seq`, returned in
    /// ascending `(partition, sequence)` order — the fold order.
    fn read_events(&self, partition: u64, from_seq: u64) -> Result<Vec<Vec<u8>>, Self::Error>;

    /// Append one EDIT record under the monotonic `(partition, sequence)` key
    /// (the SECOND log, ELOG-01). Mirrors [`append_event`](Self::append_event)
    /// verbatim, including the [`MAX_RECORD_BYTES`] write-side length bound.
    fn append_edit(
        &mut self,
        partition: u64,
        sequence: u64,
        bytes: &[u8],
    ) -> Result<(), Self::Error>;

    /// Range-scan a partition's edits with `sequence >= from_seq`, returned in
    /// ascending `(partition, sequence)` order — the edit fold order. Mirrors
    /// [`read_events`](Self::read_events), including the read-side
    /// [`MAX_RECORD_BYTES`] allocation bound on untrusted on-disk bytes.
    fn read_edits(&self, partition: u64, from_seq: u64) -> Result<Vec<Vec<u8>>, Self::Error>;

    /// Persist a full-state snapshot taken at tick `tick`.
    fn write_snapshot(&mut self, tick: u64, bytes: &[u8]) -> Result<(), Self::Error>;

    /// Return the highest-tick snapshot, or `None` if none exists.
    fn latest_snapshot(&self) -> Result<Option<(u64, Vec<u8>)>, Self::Error>;
}

/// In-memory store backed by `BTreeMap`s (CORE-06: ordered, never `HashMap`).
///
/// The fast, allocation-only oracle for in-process determinism tests; satisfies
/// the identical [`PersistenceStore`] contract as [`RedbStore`].
#[derive(Debug, Default)]
pub struct MemStore {
    events: BTreeMap<(u64, u64), Vec<u8>>,
    edits: BTreeMap<(u64, u64), Vec<u8>>,
    snapshots: BTreeMap<u64, Vec<u8>>,
}

impl MemStore {
    /// Create an empty in-memory store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl PersistenceStore for MemStore {
    type Error = StoreError;

    fn append_event(
        &mut self,
        partition: u64,
        sequence: u64,
        bytes: &[u8],
    ) -> Result<(), Self::Error> {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        self.events.insert((partition, sequence), bytes.to_vec());
        Ok(())
    }

    fn read_events(&self, partition: u64, from_seq: u64) -> Result<Vec<Vec<u8>>, Self::Error> {
        let mut out = Vec::new();
        for (_key, value) in self
            .events
            .range((partition, from_seq)..=(partition, u64::MAX))
        {
            if value.len() > MAX_RECORD_BYTES {
                return Err(StoreError::TooLarge);
            }
            out.push(value.clone());
        }
        Ok(out)
    }

    fn append_edit(
        &mut self,
        partition: u64,
        sequence: u64,
        bytes: &[u8],
    ) -> Result<(), Self::Error> {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        self.edits.insert((partition, sequence), bytes.to_vec());
        Ok(())
    }

    fn read_edits(&self, partition: u64, from_seq: u64) -> Result<Vec<Vec<u8>>, Self::Error> {
        let mut out = Vec::new();
        for (_key, value) in self
            .edits
            .range((partition, from_seq)..=(partition, u64::MAX))
        {
            if value.len() > MAX_RECORD_BYTES {
                return Err(StoreError::TooLarge);
            }
            out.push(value.clone());
        }
        Ok(out)
    }

    fn write_snapshot(&mut self, tick: u64, bytes: &[u8]) -> Result<(), Self::Error> {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        self.snapshots.insert(tick, bytes.to_vec());
        Ok(())
    }

    fn latest_snapshot(&self) -> Result<Option<(u64, Vec<u8>)>, Self::Error> {
        match self.snapshots.last_key_value() {
            Some((tick, bytes)) => {
                if bytes.len() > MAX_RECORD_BYTES {
                    return Err(StoreError::TooLarge);
                }
                Ok(Some((*tick, bytes.clone())))
            }
            None => Ok(None),
        }
    }
}

/// Durable redb-backed store: the on-disk home of the event log + snapshots.
///
/// Owns a single redb [`Database`] file handle (the only IO surface, and an
/// explicit caller-provided path — never ambient). Maps every redb error into
/// [`StoreError::Backend`]; a missing table on read is treated as empty rather
/// than an error so a freshly-opened database reads back cleanly.
#[cfg(feature = "redb")]
#[derive(Debug)]
pub struct RedbStore {
    db: Database,
}

#[cfg(feature = "redb")]
impl RedbStore {
    /// Open (creating if absent) a redb database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let db = Database::create(path).map_err(backend)?;
        Ok(Self { db })
    }
}

#[cfg(feature = "redb")]
impl PersistenceStore for RedbStore {
    type Error = StoreError;

    fn append_event(
        &mut self,
        partition: u64,
        sequence: u64,
        bytes: &[u8],
    ) -> Result<(), Self::Error> {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        let wtx = self.db.begin_write().map_err(backend)?;
        {
            let mut table = wtx.open_table(EVENTS).map_err(backend)?;
            table.insert((partition, sequence), bytes).map_err(backend)?;
        }
        wtx.commit().map_err(backend)?;
        Ok(())
    }

    fn read_events(&self, partition: u64, from_seq: u64) -> Result<Vec<Vec<u8>>, Self::Error> {
        let rtx = self.db.begin_read().map_err(backend)?;
        let table = match rtx.open_table(EVENTS) {
            Ok(table) => table,
            // No events have ever been written → nothing to read.
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(e) => return Err(backend(e)),
        };
        let mut out = Vec::new();
        for entry in table
            .range((partition, from_seq)..=(partition, u64::MAX))
            .map_err(backend)?
        {
            let (_key, value) = entry.map_err(backend)?;
            let bytes = value.value();
            // Bound allocation from untrusted on-disk bytes (threat T-1-DES).
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(StoreError::TooLarge);
            }
            out.push(bytes.to_vec());
        }
        Ok(out)
    }

    fn append_edit(
        &mut self,
        partition: u64,
        sequence: u64,
        bytes: &[u8],
    ) -> Result<(), Self::Error> {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        let wtx = self.db.begin_write().map_err(backend)?;
        {
            let mut table = wtx.open_table(EDITS).map_err(backend)?;
            table.insert((partition, sequence), bytes).map_err(backend)?;
        }
        wtx.commit().map_err(backend)?;
        Ok(())
    }

    fn read_edits(&self, partition: u64, from_seq: u64) -> Result<Vec<Vec<u8>>, Self::Error> {
        let rtx = self.db.begin_read().map_err(backend)?;
        let table = match rtx.open_table(EDITS) {
            Ok(table) => table,
            // No edits have ever been written → nothing to read.
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(Vec::new()),
            Err(e) => return Err(backend(e)),
        };
        let mut out = Vec::new();
        for entry in table
            .range((partition, from_seq)..=(partition, u64::MAX))
            .map_err(backend)?
        {
            let (_key, value) = entry.map_err(backend)?;
            let bytes = value.value();
            // Bound allocation from untrusted on-disk bytes (threat T-1-DES).
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(StoreError::TooLarge);
            }
            out.push(bytes.to_vec());
        }
        Ok(out)
    }

    fn write_snapshot(&mut self, tick: u64, bytes: &[u8]) -> Result<(), Self::Error> {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(StoreError::TooLarge);
        }
        let wtx = self.db.begin_write().map_err(backend)?;
        {
            let mut table = wtx.open_table(SNAPSHOTS).map_err(backend)?;
            table.insert(tick, bytes).map_err(backend)?;
        }
        wtx.commit().map_err(backend)?;
        Ok(())
    }

    fn latest_snapshot(&self) -> Result<Option<(u64, Vec<u8>)>, Self::Error> {
        let rtx = self.db.begin_read().map_err(backend)?;
        let table = match rtx.open_table(SNAPSHOTS) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(backend(e)),
        };
        match table.last().map_err(backend)? {
            Some((tick, value)) => {
                let bytes = value.value();
                // Bound allocation from untrusted on-disk bytes (threat T-1-DES).
                if bytes.len() > MAX_RECORD_BYTES {
                    return Err(StoreError::TooLarge);
                }
                Ok(Some((tick.value(), bytes.to_vec())))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode the 8-byte little-endian sequence tag a record was stored with.
    fn tag(record: &[u8]) -> u64 {
        u64::from_le_bytes(record[..8].try_into().expect("record carries an 8-byte tag"))
    }

    /// Events appended out of order range back in (partition, sequence) order;
    /// `from_seq` filters; partitions are isolated. Run against any store.
    fn check_ordering_and_filter<S: PersistenceStore<Error = StoreError>>(store: &mut S) {
        // Append partition 0 in deliberately shuffled call order.
        for seq in [3u64, 0, 2, 1, 4] {
            store
                .append_event(0, seq, &seq.to_le_bytes())
                .expect("append");
        }
        // A second partition with a high sequence proves the range is bounded
        // to the requested partition, not the whole key space.
        store
            .append_event(7, 9, &9u64.to_le_bytes())
            .expect("append other partition");

        // Full read of partition 0 comes back strictly ascending by sequence.
        let seqs: Vec<u64> = store
            .read_events(0, 0)
            .expect("read")
            .iter()
            .map(|r| tag(r))
            .collect();
        assert_eq!(seqs, vec![0, 1, 2, 3, 4], "events must read back in seq order");

        // from_seq lower-bounds the scan.
        let filtered: Vec<u64> = store
            .read_events(0, 2)
            .expect("read from_seq")
            .iter()
            .map(|r| tag(r))
            .collect();
        assert_eq!(filtered, vec![2, 3, 4], "from_seq must lower-bound the scan");

        // Partition isolation: partition 7 holds exactly its one record.
        let p7 = store.read_events(7, 0).expect("read p7");
        assert_eq!(p7.len(), 1);
        assert_eq!(tag(&p7[0]), 9);

        // A partition that was never written reads back empty (not an error).
        assert!(store.read_events(42, 0).expect("read empty").is_empty());
    }

    /// Edits appended out of order range back in (partition, sequence) order;
    /// `from_seq` filters; partitions are isolated; the EDITS table is independent
    /// of the EVENTS table (a write to one is invisible to the other). Run against
    /// any store. Mirrors `check_ordering_and_filter` for the SECOND log (ELOG-01).
    fn check_edits_ordering_and_filter<S: PersistenceStore<Error = StoreError>>(store: &mut S) {
        // Append partition 0 in deliberately shuffled call order.
        for seq in [3u64, 0, 2, 1, 4] {
            store
                .append_edit(0, seq, &seq.to_le_bytes())
                .expect("append edit");
        }
        // A second partition with a high sequence proves the range is bounded.
        store
            .append_edit(7, 9, &9u64.to_le_bytes())
            .expect("append other partition");

        // Full read of partition 0 comes back strictly ascending by sequence.
        let seqs: Vec<u64> = store
            .read_edits(0, 0)
            .expect("read edits")
            .iter()
            .map(|r| tag(r))
            .collect();
        assert_eq!(seqs, vec![0, 1, 2, 3, 4], "edits must read back in seq order");

        // from_seq lower-bounds the scan.
        let filtered: Vec<u64> = store
            .read_edits(0, 2)
            .expect("read edits from_seq")
            .iter()
            .map(|r| tag(r))
            .collect();
        assert_eq!(filtered, vec![2, 3, 4], "from_seq must lower-bound the scan");

        // Partition isolation: partition 7 holds exactly its one record.
        let p7 = store.read_edits(7, 0).expect("read p7");
        assert_eq!(p7.len(), 1);
        assert_eq!(tag(&p7[0]), 9);

        // A partition that was never written reads back empty (not an error).
        assert!(store.read_edits(42, 0).expect("read empty").is_empty());

        // The two logs are independent: the EVENTS table saw none of these writes.
        assert!(
            store.read_events(0, 0).expect("read events").is_empty(),
            "the EDITS writes must not leak into the EVENTS table (separate logs)"
        );
    }

    /// An over-cap edit record yields `StoreError::TooLarge`, never a panic, on
    /// both append and read paths. Run against any store.
    fn check_edit_bounds_guard<S: PersistenceStore<Error = StoreError>>(store: &mut S) {
        let oversized = vec![0u8; MAX_RECORD_BYTES + 1];
        assert_eq!(
            store.append_edit(0, 0, &oversized),
            Err(StoreError::TooLarge),
            "oversized edit must be rejected, not panic"
        );
        // A record exactly at the cap is accepted (boundary is inclusive).
        let at_cap = vec![1u8; MAX_RECORD_BYTES];
        assert!(store.append_edit(0, 1, &at_cap).is_ok());
        assert_eq!(
            store.read_edits(0, 0).expect("read edits").len(),
            1,
            "the at-cap edit was persisted and reads back"
        );
    }

    /// `latest_snapshot()` returns the highest-tick entry regardless of write
    /// order, and `None` before anything is written. Run against any store.
    fn check_snapshot_latest_wins<S: PersistenceStore<Error = StoreError>>(store: &mut S) {
        assert_eq!(store.latest_snapshot().expect("empty latest"), None);

        store.write_snapshot(100, b"at-100").expect("snap 100");
        store.write_snapshot(110, b"at-110").expect("snap 110");
        // Out-of-order write must not become "latest".
        store.write_snapshot(105, b"at-105").expect("snap 105");

        let (tick, bytes) = store
            .latest_snapshot()
            .expect("latest")
            .expect("some latest");
        assert_eq!(tick, 110, "latest must be the highest tick");
        assert_eq!(bytes, b"at-110");
    }

    /// An over-cap record yields `StoreError::TooLarge`, never a panic, on both
    /// the event and snapshot write paths. Run against any store.
    fn check_bounds_guard<S: PersistenceStore<Error = StoreError>>(store: &mut S) {
        let oversized = vec![0u8; MAX_RECORD_BYTES + 1];
        assert_eq!(
            store.append_event(0, 0, &oversized),
            Err(StoreError::TooLarge),
            "oversized event must be rejected, not panic"
        );
        assert_eq!(
            store.write_snapshot(0, &oversized),
            Err(StoreError::TooLarge),
            "oversized snapshot must be rejected, not panic"
        );
        // A record exactly at the cap is accepted (boundary is inclusive).
        let at_cap = vec![1u8; MAX_RECORD_BYTES];
        assert!(store.write_snapshot(1, &at_cap).is_ok());
    }

    #[cfg(feature = "redb")]
    fn redb_store() -> (tempfile::TempDir, RedbStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = RedbStore::open(dir.path().join("fabrico-test.redb")).expect("open redb");
        (dir, store)
    }

    #[test]
    fn persist_mem_ordering_and_filter() {
        check_ordering_and_filter(&mut MemStore::new());
    }

    #[cfg(feature = "redb")]
    #[test]
    fn persist_redb_ordering_and_filter() {
        let (_dir, mut store) = redb_store();
        check_ordering_and_filter(&mut store);
    }

    #[test]
    fn persist_mem_edits_ordering_and_filter() {
        check_edits_ordering_and_filter(&mut MemStore::new());
    }

    #[cfg(feature = "redb")]
    #[test]
    fn persist_redb_edits_ordering_and_filter() {
        let (_dir, mut store) = redb_store();
        check_edits_ordering_and_filter(&mut store);
    }

    #[test]
    fn persist_mem_edit_bounds_guard() {
        check_edit_bounds_guard(&mut MemStore::new());
    }

    #[cfg(feature = "redb")]
    #[test]
    fn persist_redb_edit_bounds_guard() {
        let (_dir, mut store) = redb_store();
        check_edit_bounds_guard(&mut store);
    }

    #[test]
    fn persist_mem_snapshot_latest_wins() {
        check_snapshot_latest_wins(&mut MemStore::new());
    }

    #[cfg(feature = "redb")]
    #[test]
    fn persist_redb_snapshot_latest_wins() {
        let (_dir, mut store) = redb_store();
        check_snapshot_latest_wins(&mut store);
    }

    #[test]
    fn persist_mem_bounds_guard() {
        check_bounds_guard(&mut MemStore::new());
    }

    #[cfg(feature = "redb")]
    #[test]
    fn persist_redb_bounds_guard() {
        let (_dir, mut store) = redb_store();
        check_bounds_guard(&mut store);
    }
}
