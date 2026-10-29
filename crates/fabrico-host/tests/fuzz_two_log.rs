//! Adversarial two-log decode fuzz (TEST-04) — the phase's primary security work.
//!
//! This integration test lives in `fabrico-host/tests` (NOT `fabrico-scenario`):
//! the load path's home is `fabrico_host::project::load_project`, and keeping the
//! fuzz here preserves the headless fence (RESEARCH Open Q2 — the harness crate
//! never gains a dependency on the host).
//!
//! # What it proves (ROADMAP SC#3 "two-log save/load is adversarially hardened")
//! `load_project` decodes a FULLY UNTRUSTED `.fab` file — a two-log `ProjectFile`
//! v5 bundle (base snapshot + runtime event-log + topology edit-log). The
//! reject-only validator (`project.rs:448-701`) must turn EVERY hostile byte
//! sequence into a typed [`ProjectError`] — never a panic, OOM, or hang.
//!
//! Three layers of proof:
//!  1. `mutated_two_log_bundle_is_always_typed_error` — a proptest that builds a
//!     VALID bundle (with a real edit-log `Place`, so the edit-log attack surface
//!     at `project.rs:531-589` is reachable — RESEARCH Pitfall 6), applies bounded
//!     byte mutations (flip / truncate / grow / zero-run), and asserts `load_project`
//!     NEVER panics (via `catch_unwind`) and returns within a wall-clock budget
//!     (the hang backstop). The result is `Err(ProjectError::*)` or — for a
//!     mutation that coincidentally lands on a still-valid bundle — `Ok(Host)`.
//!  2. `structurally_forged_bundle_is_always_typed_error` — a proptest over
//!     STRUCTURAL forges (duplicate log/edit keys, oversize ticks, oversize
//!     footprint dims, out-of-extent anchors) re-encoded through the real
//!     `ProjectFile` shape, the same no-panic/no-hang invariant.
//!  3. Targeted deterministic cases asserting the EXACT variant for each of the
//!     ~15 typed decode-error classes across BOTH logs — so coverage is
//!     demonstrable, not merely probabilistic.
//!
//! The OOM/DoS classes are bounded by `MAX_PROJECT_BYTES` (the up-front metadata
//! stat) and `MAX_REPLAY_SPAN` (the pre-replay span ceiling); this fuzz proves the
//! decode never trips them into a panic/abort.

// `fabrico-host` is the project's sanctioned I/O home and does NOT carry the
// determinism clippy gate (that lives only in `fabrico-core`). Writing the mutated
// `.fab` bytes to a tempfile is exactly the test IO that belongs here; scope the
// allow defensively in case CI promotes the lint workspace-wide.
#![allow(clippy::disallowed_methods)]
// The wall-clock `Instant` is the mandated HANG BACKSTOP (plan Task 2): it measures
// how long an UNTRUSTED-byte `load_project` takes and fails the case if it blows a
// generous budget — the no-hang proof for the DoS classes. This is host-side TEST
// instrumentation, NOT sim code (the determinism `current_tick` clock governs the
// sim, never a fuzz timer), so scope the determinism-gate allow to this file.
#![allow(clippy::disallowed_types)]

use std::panic;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use fabrico_core::command::{Command, Outcome, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::{
    GRID_MAX, GRID_MIN, MAX_FOOTPRINT_DIM, Medium, Port, Role, SinkTemplate, Side,
};

use fabrico_core::persist::RedbStore;
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{
    MAX_PROJECT_BYTES, MAX_REPLAY_SPAN, PRE_SLOT_CHANGE_PROJECT_VERSION,
    PRE_SPEED_CHANGE_PROJECT_VERSION, PROJECT_FILE_VERSION,
    ProjectError, ProjectFile, load_project,
};

use proptest::prelude::*;
use tokio::sync::mpsc::unbounded_channel;

/// The wall-clock budget for a single `load_project` of mutated bytes. The
/// validator's `MAX_PROJECT_BYTES` + `MAX_REPLAY_SPAN` ceilings keep a legitimate
/// or hostile decode well under a second; a load that blows past this generous
/// bound signals the hang class the bounds are meant to kill. Generous enough not
/// to flake on a loaded CI box, finite enough to catch a real DoS.
const LOAD_BUDGET: Duration = Duration::from_secs(30);

/// Fixed genesis header for the valid bundle (seed value is irrelevant to the
/// decode-rejection surface; it only seeds the embedded snapshot's RNG).
fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 0x00FA_B12C,
    }
}

/// An unstamped `Place` edit the host stamps + folds (mirrors the driver/project
/// test helper). The host overwrites `partition`/`sequence`/`tick` on enqueue.
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

/// Build a `source -> sink` host driven to a QUIESCENT boundary (in-flight empty),
/// then fold a real topology `Place` edit so the produced bundle carries a genuine
/// edit-log record (the edit-log attack surface). Mirrors `project.rs`'s
/// `quiesced_host` + `project_v5_round_trips`, reconstructed against the PUBLIC
/// `Host` API (the private test helpers are not importable across the crate fence).
fn quiesced_host_with_edit(snapshot_every: Option<u64>) -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let sink = core.state.add_sink(SinkTemplate::Debug, 5);
    core.state.link((source, 0), (sink, 0));
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, snapshot_every).expect("open host");

    let (cmd_tx, mut cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, mut res_rx) = unbounded_channel::<ResultEvent>();
    let (ing_tx, mut ing_rx) = unbounded_channel::<EventPayload>();
    ing_tx
        .send(EventPayload::ManualInject {
            target: source,
            port: 0,
            item: Item(vec![0xAB]),
        })
        .expect("seed ingress");

    // Drive to quiescence: resolve the Debug sink's emitted command one tick later
    // (modelling the async executor), so the loop stops the instant nothing is in
    // flight. Identical shape to `project.rs`'s `quiesced_host`.
    let mut pending: Option<ResultEvent> = None;
    let mut saw_command = false;
    let mut guard = 0u32;
    loop {
        host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx).expect("tick");
        if let Some(re) = pending.take() {
            let _ = res_tx.send(re);
        }
        while let Ok(cmd) = cmd_rx.try_recv() {
            saw_command = true;
            pending = Some(ResultEvent {
                command_id: cmd.id,
                tick: 0,
                outcome: Outcome::Success,
            });
        }
        if saw_command && host.in_flight_len() == 0 && pending.is_none() {
            break;
        }
        guard += 1;
        assert!(guard < 64, "the host failed to quiesce within 64 ticks");
    }

    // Fold a real topology edit into the edit-log (mints a node AT a cell, emits no
    // command -> stays quiescent), so the bundle's edit-log is non-empty.
    let nodes_before = host.core().state.node_count();
    host.enqueue_edit(place_edit(0, 7, 7));
    host.tick_once(&mut ing_rx, &mut res_rx, &cmd_tx)
        .expect("fold the edit");
    assert_eq!(
        host.core().state.node_count(),
        nodes_before + 1,
        "the Place edit minted a node"
    );
    assert_eq!(host.in_flight_len(), 0, "still quiescent after the edit fold");
    (dir, host)
}

/// Produce a VALID two-log `ProjectFile` v5 bundle whose edit-log contains a real
/// `Place` (so the edit-log footprint/anchor/port/monotonic/span validation at
/// `project.rs:531-589` is reachable on mutation). Mirrors `save_project`'s
/// base-snapshot selection (the latest persisted snapshot).
fn build_valid_bundle_with_edits() -> ProjectFile {
    let (_dir, host) = quiesced_host_with_edit(Some(1));
    let (_base_tick, snapshot) = host
        .latest_persisted_snapshot()
        .expect("read persisted snapshot")
        .expect("a base snapshot was persisted (snapshot_every=1)");
    let bundle = ProjectFile {
        version: PROJECT_FILE_VERSION,
        head_tick: host.core().tick,
        snapshot,
        log: host.logged_events().expect("logged events"),
        edit_log: host.logged_edits().expect("logged edits"),
    };
    assert!(
        bundle
            .edit_log
            .iter()
            .any(|er| matches!(er.op, EditOp::Place { .. })),
        "the valid bundle must carry a real edit-log Place (Pitfall 6 attack surface)"
    );
    bundle
}

/// The canonical valid bundle bytes, built ONCE and reused across every proptest
/// case (each case mutates a clone) — keeps the fuzz fast at `PROPTEST_CASES=1024`.
fn valid_bytes() -> &'static [u8] {
    static BYTES: OnceLock<Vec<u8>> = OnceLock::new();
    BYTES.get_or_init(|| postcard::to_allocvec(&build_valid_bundle_with_edits()).expect("encode"))
}

// ---------------------------------------------------------------------------
// Byte-level mutation strategy
// ---------------------------------------------------------------------------

/// A single bounded byte-level mutation applied to a clone of the valid bundle
/// bytes. Covers the attacker's raw-byte surface: bit flips, tail truncation,
/// trailing growth, and zeroed runs (which smash structure / collapse keys).
#[derive(Clone, Debug)]
enum Mutation {
    /// Flip bits at a byte (index taken modulo the current length).
    Flip { idx: usize, mask: u8 },
    /// Cut `drop` bytes off the tail (a truncated/short bundle).
    Truncate { drop: usize },
    /// Append junk bytes (grow the file — a trailing-garbage / oversize nudge).
    AppendJunk { bytes: Vec<u8> },
    /// Zero a run of bytes (corrupt a varint length / key / version in place).
    ZeroRun { idx: usize, len: usize },
}

fn mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        (any::<usize>(), 1u8..=255).prop_map(|(idx, mask)| Mutation::Flip { idx, mask }),
        (1usize..4096).prop_map(|drop| Mutation::Truncate { drop }),
        prop::collection::vec(any::<u8>(), 1..=256).prop_map(|bytes| Mutation::AppendJunk { bytes }),
        (any::<usize>(), 1usize..64).prop_map(|(idx, len)| Mutation::ZeroRun { idx, len }),
    ]
}

/// A bounded SEQUENCE of byte mutations (1..=12) — keeps the per-case work small
/// and the strategy shrinkable to a minimal failing sequence.
fn mutation_strategy() -> impl Strategy<Value = Vec<Mutation>> {
    prop::collection::vec(mutation(), 1..=12)
}

fn apply_mutations(bytes: &mut Vec<u8>, muts: &[Mutation]) {
    for m in muts {
        match m {
            Mutation::Flip { idx, mask } => {
                if !bytes.is_empty() {
                    let i = idx % bytes.len();
                    bytes[i] ^= mask;
                }
            }
            Mutation::Truncate { drop } => {
                let keep = bytes.len().saturating_sub(*drop);
                bytes.truncate(keep);
            }
            Mutation::AppendJunk { bytes: junk } => {
                bytes.extend_from_slice(junk);
            }
            Mutation::ZeroRun { idx, len } => {
                if !bytes.is_empty() {
                    let start = idx % bytes.len();
                    let end = (start + len).min(bytes.len());
                    for b in &mut bytes[start..end] {
                        *b = 0;
                    }
                }
            }
        }
    }
}

/// Outcome of a single guarded load attempt.
struct LoadOutcome {
    /// `true` iff `load_project` unwound (a panic — always a test FAILURE).
    panicked: bool,
    /// Wall-clock the load took (the hang backstop).
    elapsed: Duration,
}

/// Write `bytes` to a fresh tempfile and call `load_project` inside
/// `catch_unwind` + a wall-clock measurement. A caught panic and the elapsed time
/// are reported to the caller; the inner `Result<Host, ProjectError>` is
/// deliberately discarded — BOTH `Err(typed)` and a coincidentally-valid `Ok` are
/// acceptable, only an unwound panic or a budget-blowing hang is a failure.
fn load_bytes_guarded(bytes: &[u8]) -> LoadOutcome {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mutated.fab");
    std::fs::write(&path, bytes).expect("write mutated bytes");
    let work = tempfile::tempdir().expect("work dir");

    let start = Instant::now();
    // AssertUnwindSafe: the only thing crossing the boundary is the returned
    // `Result<Host, ProjectError>` (discarded by the caller); the `&Path` captures
    // are themselves unwind-safe. We assert NO panic, so a poisoned-state escape is
    // a test failure by construction.
    let res = panic::catch_unwind(panic::AssertUnwindSafe(|| {
        load_project(&path, work.path(), None)
    }));
    let elapsed = start.elapsed();
    LoadOutcome {
        panicked: res.is_err(),
        elapsed,
    }
}

// ---------------------------------------------------------------------------
// Structural forge strategy
// ---------------------------------------------------------------------------

/// A structural forge applied to a DECODED `ProjectFile` (then re-encoded through
/// the real shape) — covers the higher-level attack surface that random byte
/// flips rarely reach: duplicated/out-of-order log keys, oversize ticks, oversize
/// footprint dims, and out-of-extent anchors.
#[derive(Clone, Debug)]
enum Forge {
    DuplicateLogKey,
    DuplicateEditKey,
    OversizeTick(u64),
    OversizeFootprint(u16),
    OversizeAnchor(i32),
}

fn forge_strategy() -> impl Strategy<Value = Forge> {
    prop_oneof![
        Just(Forge::DuplicateLogKey),
        Just(Forge::DuplicateEditKey),
        (1_000_000u64..u64::MAX).prop_map(Forge::OversizeTick),
        ((MAX_FOOTPRINT_DIM + 1)..=u16::MAX).prop_map(Forge::OversizeFootprint),
        prop_oneof![(GRID_MAX + 1)..=i32::MAX, i32::MIN..GRID_MIN].prop_map(Forge::OversizeAnchor),
    ]
}

/// Apply a structural forge in place. A no-op if the targeted log is empty (the
/// valid bundle always has a non-empty event-log and a Place edit-log, so every
/// forge bites).
fn apply_forge(bundle: &mut ProjectFile, forge: &Forge) {
    match forge {
        Forge::DuplicateLogKey => {
            if let Some(first) = bundle.log.first().cloned() {
                bundle.log.push(first);
            }
        }
        Forge::DuplicateEditKey => {
            if let Some(first) = bundle.edit_log.first().cloned() {
                bundle.edit_log.push(first);
            }
        }
        Forge::OversizeTick(t) => {
            if let Some(ev) = bundle.log.first_mut() {
                ev.tick = *t;
            }
            if let Some(er) = bundle.edit_log.first_mut() {
                er.tick = *t;
            }
        }
        Forge::OversizeFootprint(d) => {
            for er in &mut bundle.edit_log {
                if let EditOp::Place { w, h, .. } = &mut er.op {
                    *w = *d;
                    *h = *d;
                }
            }
        }
        Forge::OversizeAnchor(a) => {
            for er in &mut bundle.edit_log {
                if let EditOp::Place { cell_x, cell_y, .. } = &mut er.op {
                    *cell_x = *a;
                    *cell_y = *a;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sanity: the unmutated bundle is genuinely valid
// ---------------------------------------------------------------------------

#[test]
fn unmutated_two_log_bundle_loads_ok() {
    // The factory's VALID bundle must load cleanly — otherwise the fuzz would be
    // mutating an already-broken baseline and prove nothing. Also re-asserts the
    // edit-log carries a real Place (the Pitfall-6 attack surface).
    let bundle = build_valid_bundle_with_edits();
    assert!(
        bundle
            .edit_log
            .iter()
            .any(|er| matches!(er.op, EditOp::Place { .. })),
        "baseline bundle carries a real edit-log Place"
    );
    let bytes = postcard::to_allocvec(&bundle).expect("encode");
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("valid.fab");
    std::fs::write(&path, &bytes).expect("write valid bundle");
    let work = tempfile::tempdir().expect("work dir");
    let loaded = load_project(&path, work.path(), None).expect("the valid bundle must load OK");
    assert_eq!(
        loaded.core().tick,
        bundle.head_tick,
        "the loaded host reaches the bundle's head_tick"
    );
    assert_eq!(
        loaded.logged_edits().expect("edits").len(),
        bundle.edit_log.len(),
        "the loaded host restores the bundled edit-log"
    );
}

// ---------------------------------------------------------------------------
// The fuzz proper
// ---------------------------------------------------------------------------

proptest! {
    // Honor PROPTEST_CASES (CI sets 1024); default reads the env / 256 locally.
    #![proptest_config(ProptestConfig::default())]

    /// Byte-mutated two-log bundle: `load_project` is ALWAYS a typed error or a
    /// coincidentally-valid Ok — NEVER a panic (catch_unwind) and NEVER a hang
    /// (wall-clock budget). The OOM class is bounded by MAX_PROJECT_BYTES /
    /// MAX_REPLAY_SPAN inside the validator. (TEST-04, T-V5-DESERIALIZE.)
    #[test]
    fn mutated_two_log_bundle_is_always_typed_error(muts in mutation_strategy()) {
        let mut bytes = valid_bytes().to_vec();
        apply_mutations(&mut bytes, &muts);
        let outcome = load_bytes_guarded(&bytes);
        prop_assert!(
            !outcome.panicked,
            "load_project PANICKED on mutated bytes — mutations: {muts:?}"
        );
        prop_assert!(
            outcome.elapsed < LOAD_BUDGET,
            "load_project exceeded the {LOAD_BUDGET:?} budget ({:?}) — possible hang; mutations: {muts:?}",
            outcome.elapsed
        );
    }

    /// Structurally-forged two-log bundle (dup keys / oversize tick / oversize
    /// footprint / out-of-extent anchor) re-encoded through the real ProjectFile
    /// shape: the same no-panic / no-hang invariant. Covers the higher-level
    /// surface raw byte flips rarely reach (T-13-04 / T-13-05 / T-13-06).
    #[test]
    fn structurally_forged_bundle_is_always_typed_error(forge in forge_strategy()) {
        let mut bundle: ProjectFile =
            postcard::from_bytes(valid_bytes()).expect("decode valid baseline");
        apply_forge(&mut bundle, &forge);
        let bytes = postcard::to_allocvec(&bundle).expect("re-encode forged bundle");
        let outcome = load_bytes_guarded(&bytes);
        prop_assert!(
            !outcome.panicked,
            "load_project PANICKED on a structurally-forged bundle — forge: {forge:?}"
        );
        prop_assert!(
            outcome.elapsed < LOAD_BUDGET,
            "load_project exceeded the {LOAD_BUDGET:?} budget ({:?}) — possible hang; forge: {forge:?}",
            outcome.elapsed
        );
    }
}

// ---------------------------------------------------------------------------
// Targeted deterministic coverage of the ~15 typed decode-error classes
// ---------------------------------------------------------------------------
//
// These DIRECTLY construct a bundle hitting each class so coverage is demonstrable,
// not merely probabilistic (plan Task 2). Each writes a real `.fab`, calls
// `load_project`, and asserts the EXACT `ProjectError` variant.

/// A genesis-snapshot bundle with a single `add_source` node — the minimal valid
/// substrate for the event-/edit-tick targeted cases (mirrors `project.rs`).
fn genesis_bundle() -> (ProjectFile, NodeId) {
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let snapshot = fabrico_core::snapshot::snapshot(&core);
    let bundle = ProjectFile {
        version: PROJECT_FILE_VERSION,
        head_tick: core.tick,
        snapshot,
        log: Vec::new(),
        edit_log: Vec::new(),
    };
    (bundle, source)
}

fn load_bundle(bundle: &ProjectFile, name: &str) -> Result<Host, ProjectError> {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(name);
    std::fs::write(&path, postcard::to_allocvec(bundle).expect("encode")).expect("write");
    let work = tempfile::tempdir().expect("work dir");
    load_project(&path, work.path(), None)
}

#[test]
fn class_malformed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("garbage.fab");
    std::fs::write(&path, [0xFFu8; 32]).expect("write garbage");
    let work = tempfile::tempdir().expect("work dir");
    let result = load_project(&path, work.path(), None);
    assert!(
        matches!(result, Err(ProjectError::Malformed)),
        "garbage bytes must be a typed Malformed error (no panic)"
    );
}

#[test]
fn class_unknown_version() {
    let (mut bundle, _src) = genesis_bundle();
    bundle.version = PROJECT_FILE_VERSION + 1;
    let result = load_bundle(&bundle, "forward.fab");
    assert!(
        matches!(result, Err(ProjectError::UnknownVersion(v)) if v == PROJECT_FILE_VERSION + 1),
        "a forward bundle version must be UnknownVersion"
    );
}

#[test]
fn class_too_old() {
    // 60-03: this case USED to read `PROJECT_FILE_VERSION - 1`, which after the too-old
    // branch split no longer selects the generic arm at all: that exact version is now
    // PRE_SLOT_CHANGE_PROJECT_VERSION and lands on `SlotModelChanged` (see
    // `class_slot_model_changed` below). Re-pointed one version further back so it tests
    // the class it is named for. The derived form was the defect: an expectation written
    // as arithmetic off the constant under test silently re-points on every bump.
    let (mut bundle, _src) = genesis_bundle();
    let older = PRE_SLOT_CHANGE_PROJECT_VERSION - 1;
    bundle.version = older;
    let result = load_bundle(&bundle, "old.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::TooOld { found, expected })
                if found == older && expected == PROJECT_FILE_VERSION
        ),
        "a pre-current bundle version must be a typed TooOld (no migration, no panic)"
    );
}

#[test]
fn class_slot_model_changed() {
    // 60-03 / D-02: the one version that predates the belt slot-spacing change gets its
    // own typed refusal, so this file's per-class coverage stays complete (its header
    // promises the EXACT variant for EVERY typed decode-error class, demonstrably rather
    // than probabilistically). Reject-only and O(1) like every other envelope arm: the
    // store must not be hydrated.
    let (mut bundle, _src) = genesis_bundle();
    bundle.version = PRE_SLOT_CHANGE_PROJECT_VERSION;
    let result = load_bundle(&bundle, "pre_slot_change.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::SlotModelChanged { found })
                if found == PRE_SLOT_CHANGE_PROJECT_VERSION
        ),
        "a pre-slot-change bundle version must be a typed SlotModelChanged (no migration, no panic)"
    );
}

#[test]
fn class_belt_speed_model_changed() {
    // 62-06 / D-14: the one version that predates the per-belt advance-interval change gets
    // its own typed refusal, so this file's per-class coverage stays complete (its header
    // promises the EXACT variant for EVERY typed decode-error class, demonstrably rather
    // than probabilistically). Adding a variant without adding a case here would leave that
    // promise false, quietly, which is the failure mode `class_too_old` above was re-pointed
    // to avoid one bump earlier. Reject-only and O(1) like every other envelope arm: the
    // store must not be hydrated.
    //
    // `class_too_old` needed NO re-point this bump, and that is the hard literal earning its
    // keep: it reads `PRE_SLOT_CHANGE_PROJECT_VERSION - 1`, a fact about the slot boundary,
    // so it still names v5 and still lands on the generic arm. Had it been left as
    // `PROJECT_FILE_VERSION - 1` it would now be silently testing THIS arm under that name.
    let (mut bundle, _src) = genesis_bundle();
    bundle.version = PRE_SPEED_CHANGE_PROJECT_VERSION;
    let result = load_bundle(&bundle, "pre_speed_change.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::BeltSpeedModelChanged { found })
                if found == PRE_SPEED_CHANGE_PROJECT_VERSION
        ),
        "a pre-speed-change bundle version must be a typed BeltSpeedModelChanged (no \
         migration, no panic)"
    );
}

#[test]
fn class_too_large() {
    // A SPARSE file declares a length past MAX_PROJECT_BYTES without allocating it,
    // exercising the up-front metadata-stat guard (no OOM).
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("huge.fab");
    let f = std::fs::File::create(&path).expect("create");
    f.set_len(MAX_PROJECT_BYTES + 1).expect("set_len (sparse)");
    drop(f);
    let work = tempfile::tempdir().expect("work dir");
    let result = load_project(&path, work.path(), None);
    assert!(
        matches!(
            result,
            Err(ProjectError::TooLarge { size, limit })
                if size == MAX_PROJECT_BYTES + 1 && limit == MAX_PROJECT_BYTES
        ),
        "an oversized file must be a typed TooLarge (no OOM/panic)"
    );
}

#[test]
fn class_invalid_snapshot() {
    // Forge a structurally-valid-but-invariant-violating snapshot (a node whose
    // inbox was removed -> MissingInbox), rejected by the HARDENED restore.
    let mut core = Core::genesis(header());
    let node = core.state.add_source();
    core.state.test_remove_inbox(node);
    let snapshot = fabrico_core::snapshot::snapshot(&core);
    let bundle = ProjectFile {
        version: PROJECT_FILE_VERSION,
        head_tick: core.tick,
        snapshot,
        log: Vec::new(),
        edit_log: Vec::new(),
    };
    let result = load_bundle(&bundle, "hostile_snapshot.fab");
    assert!(
        matches!(result, Err(ProjectError::InvalidSnapshot(_))),
        "an invariant-violating snapshot must be a typed InvalidSnapshot (no panic)"
    );
}

#[test]
fn class_head_tick_mismatch() {
    let (mut bundle, _src) = genesis_bundle();
    bundle.head_tick += 1; // forge an inconsistent head_tick
    let result = load_bundle(&bundle, "tampered_head.fab");
    assert!(
        matches!(result, Err(ProjectError::HeadTickMismatch { .. })),
        "a head_tick disagreeing with the replay target must be HeadTickMismatch"
    );
}

#[test]
fn class_unreadable_log_event() {
    let (mut bundle, source) = genesis_bundle();
    bundle.log.push(Event {
        schema_version: SCHEMA_VERSION + 1, // forward-versioned event
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::ManualInject {
            target: source,
            port: 0,
            item: Item(vec![0x01]),
        },
    });
    let result = load_bundle(&bundle, "forward_log.fab");
    assert!(
        matches!(result, Err(ProjectError::UnreadableLogEvent(v)) if v == SCHEMA_VERSION + 1),
        "a forward-versioned bundled log event must be UnreadableLogEvent"
    );
}

#[test]
fn class_non_monotonic_log() {
    let (mut bundle, source) = genesis_bundle();
    let ev = Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::ManualInject {
            target: source,
            port: 0,
            item: Item(vec![0x01]),
        },
    };
    bundle.log.push(ev.clone());
    bundle.log.push(ev); // duplicate (partition, sequence) key
    let result = load_bundle(&bundle, "out_of_order_log.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::NonMonotonicLog { partition, sequence })
                if partition == 0 && sequence == 0
        ),
        "a duplicate/out-of-order bundled log key must be NonMonotonicLog"
    );
}

#[test]
fn class_unreadable_edit_record() {
    let (mut bundle, _src) = genesis_bundle();
    let mut bad = place_edit(0, 1, 1);
    bad.schema_version = EDIT_SCHEMA_VERSION + 1; // forward-versioned record
    bundle.edit_log.push(bad);
    let result = load_bundle(&bundle, "forward_edit.fab");
    assert!(
        matches!(result, Err(ProjectError::UnreadableEditRecord(v)) if v == EDIT_SCHEMA_VERSION + 1),
        "a forward-versioned bundled edit record must be UnreadableEditRecord"
    );
}

#[test]
fn class_stale_edit_record() {
    // The backward twin of `class_unreadable_edit_record`, added by the v8.0 clean
    // break (Phase 63, plan 63-11). Until then the predicate was forward-only, so a
    // record from an EARLIER milestone was waved through and replayed against a layout
    // it was not written for. It is now the same typed error as a forward one.
    //
    // HAND-WRITTEN 6, not `EDIT_SCHEMA_VERSION - 1`: 6 is the version every pre-v8.0
    // saved board actually carries, so this stays a real stale-file witness after the
    // next bump rather than silently following it.
    const PREVIOUS_MILESTONE_EDIT_VERSION: u16 = 6;
    let (mut bundle, _src) = genesis_bundle();
    let mut stale = place_edit(0, 1, 1);
    stale.schema_version = PREVIOUS_MILESTONE_EDIT_VERSION;
    bundle.edit_log.push(stale);
    let result = load_bundle(&bundle, "stale_edit.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::UnreadableEditRecord(v)) if v == PREVIOUS_MILESTONE_EDIT_VERSION
        ),
        "a version-6 bundled edit record must be UnreadableEditRecord(6)"
    );
}

#[test]
fn class_version_8_edit_record_is_refused_after_the_reseat_release() {
    // 74.1-12 (CORNER-06, review WR-01): EDIT_SCHEMA_VERSION went 8 to 9 with NO byte of an
    // `EditOp` moving, because two fold verdicts changed what an unchanged log folds to
    // (the 74.1-03 rotate facing narrowing and the 74.1-12 port-edit release). A version-8
    // record therefore decodes perfectly well, which is exactly why the version has to
    // refuse it: replayed, it would fold to a different board than the one it was saved
    // from. This is the `.fab` half of that refusal, the per-record check at load.
    //
    // HAND-WRITTEN 8, not `EDIT_SCHEMA_VERSION - 1`, for the reason
    // `class_stale_edit_record` gives about its own 6.
    const PRE_RESEAT_RELEASE_EDIT_VERSION: u16 = 8;
    let (mut bundle, _src) = genesis_bundle();
    let mut stale = place_edit(0, 1, 1);
    stale.schema_version = PRE_RESEAT_RELEASE_EDIT_VERSION;
    bundle.edit_log.push(stale);
    let result = load_bundle(&bundle, "version_8_edit.fab");
    let Err(err) = result else {
        panic!("a version-8 bundled edit record must be refused, got Ok");
    };
    assert!(
        matches!(err, ProjectError::UnreadableEditRecord(8)),
        "a version-8 bundled edit record must be UnreadableEditRecord(8), got {err:?}"
    );
    let message = err.to_string();
    assert!(
        message.contains("schema_version 8"),
        "and the typed message names the refused version: {message}"
    );
}

#[test]
fn class_version_9_edit_record_is_refused_after_the_catalog_layout_rule() {
    // 74.1-14 (CORNER-06, the "Edits keep middle layout" rule):
    // EDIT_SCHEMA_VERSION went 9 to 10 with NO byte of an `EditOp` moving. The port-edit
    // reseat rule became centre-out from the catalog box and the Router catalog took its
    // output, so a version-9 record decodes perfectly well and would replay to different
    // port cells and different kept docks. Version 9 never shipped in a release but is in
    // committed history (74.1-12's gated revision), so it is refused. This is the `.fab`
    // half of that refusal, the per-record check at load.
    //
    // HAND-WRITTEN 9, not `EDIT_SCHEMA_VERSION - 1`, for the reason
    // `class_stale_edit_record` gives about its own 6.
    const PRE_CATALOG_LAYOUT_EDIT_VERSION: u16 = 9;
    let (mut bundle, _src) = genesis_bundle();
    let mut stale = place_edit(0, 1, 1);
    stale.schema_version = PRE_CATALOG_LAYOUT_EDIT_VERSION;
    bundle.edit_log.push(stale);
    let result = load_bundle(&bundle, "version_9_edit.fab");
    let Err(err) = result else {
        panic!("a version-9 bundled edit record must be refused, got Ok");
    };
    assert!(
        matches!(err, ProjectError::UnreadableEditRecord(9)),
        "a version-9 bundled edit record must be UnreadableEditRecord(9), got {err:?}"
    );
    let message = err.to_string();
    assert!(
        message.contains("schema_version 9"),
        "and the typed message names the refused version: {message}"
    );
}

#[test]
fn class_version_10_edit_record_is_refused_after_ports_stay_put() {
    // 74.1-16 (CORNER-06, the remove-output layout rule, review WR-01): EDIT_SCHEMA_VERSION
    // went 10 to 11, BYTE-forced (`AddPort.seat` and `RemovePort.restore` are trailing
    // fields on live variants) and decision-forced (no port edit moves an existing port,
    // so an unchanged version-10 log folds to a different board). Version 10 never shipped
    // in a release but is in committed history (74.1-14's and 74.1-15's gated revisions),
    // so it is refused. This is the `.fab` half of that refusal, the per-record check at
    // load.
    //
    // HAND-WRITTEN 10, not `EDIT_SCHEMA_VERSION - 1`, for the reason
    // `class_stale_edit_record` gives about its own 6.
    const PRE_PORTS_STAY_PUT_EDIT_VERSION: u16 = 10;
    let (mut bundle, _src) = genesis_bundle();
    let mut stale = place_edit(0, 1, 1);
    stale.schema_version = PRE_PORTS_STAY_PUT_EDIT_VERSION;
    bundle.edit_log.push(stale);
    let result = load_bundle(&bundle, "version_10_edit.fab");
    let Err(err) = result else {
        panic!("a version-10 bundled edit record must be refused, got Ok");
    };
    assert!(
        matches!(err, ProjectError::UnreadableEditRecord(10)),
        "a version-10 bundled edit record must be UnreadableEditRecord(10), got {err:?}"
    );
    let message = err.to_string();
    assert!(
        message.contains("schema_version 10"),
        "and the typed message names the refused version: {message}"
    );
}

#[test]
fn class_non_monotonic_edit_log() {
    let (mut bundle, _src) = genesis_bundle();
    let mut a = place_edit(0, 1, 1);
    a.partition = 0;
    a.sequence = 0;
    a.tick = 0;
    bundle.edit_log.push(a.clone());
    bundle.edit_log.push(a); // duplicate (partition, sequence) key
    let result = load_bundle(&bundle, "out_of_order_edit.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::NonMonotonicEditLog { partition, sequence })
                if partition == 0 && sequence == 0
        ),
        "a duplicate/out-of-order bundled edit key must be NonMonotonicEditLog"
    );
}

#[test]
fn class_tick_overflow() {
    // Mode A of T-06-LOAD-DOS: a u64::MAX base + event tick would drive recover()'s
    // `core.tick += 1` AT u64::MAX into an add-overflow PANIC. The checked guard
    // rejects it as a typed TickOverflow before recover() runs.
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    core.tick = u64::MAX;
    let snapshot = fabrico_core::snapshot::snapshot(&core);
    let bundle = ProjectFile {
        version: PROJECT_FILE_VERSION,
        head_tick: u64::MAX,
        snapshot,
        log: vec![Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: u64::MAX,
            payload: EventPayload::ManualInject {
                target: source,
                port: 0,
                item: Item(vec![0x01]),
            },
        }],
        edit_log: Vec::new(),
    };
    let result = load_bundle(&bundle, "tick_overflow.fab");
    assert!(
        matches!(result, Err(ProjectError::TickOverflow { max_event_tick }) if max_event_tick == u64::MAX),
        "a u64::MAX-tick bundle must be a typed TickOverflow (no add-overflow panic)"
    );
}

#[test]
fn class_replay_span_too_long() {
    // Mode B of T-06-LOAD-DOS: a 2^40 tick gap would drive recover()'s idle-tick
    // loop ~10^12 iterations (a HANG). The saturating span ceiling refuses it in
    // O(1) as a typed ReplaySpanTooLong; this test completing fast is the no-hang
    // proof.
    const HOSTILE_TICK: u64 = 1 << 40;
    let mut core = Core::genesis(header());
    let source = core.state.add_source();
    let snapshot = fabrico_core::snapshot::snapshot(&core);
    let bundle = ProjectFile {
        version: PROJECT_FILE_VERSION,
        head_tick: HOSTILE_TICK + 1,
        snapshot,
        log: vec![Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: HOSTILE_TICK,
            payload: EventPayload::ManualInject {
                target: source,
                port: 0,
                item: Item(vec![0x02]),
            },
        }],
        edit_log: Vec::new(),
    };
    let result = load_bundle(&bundle, "replay_span.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::ReplaySpanTooLong { span, limit })
                if span == HOSTILE_TICK + 1 && limit == MAX_REPLAY_SPAN
        ),
        "a multi-year tick gap must be a typed ReplaySpanTooLong (no replay-loop hang)"
    );
}

#[test]
fn class_edit_footprint_out_of_range() {
    // CR-01 / T-06-01-DOS: a w=h=u16::MAX Place would expand ~4.3 billion occupancy
    // cells (an allocation bomb). The up-front dim bound rejects it.
    let (mut bundle, _src) = genesis_bundle();
    bundle.edit_log.push(EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::Place {
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            w: u16::MAX,
            h: u16::MAX,
            ports: Vec::new(),
            rot: 0,
        },
    });
    let result = load_bundle(&bundle, "oversized_place.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::EditFootprintOutOfRange { w, h })
                if w == u16::MAX && h == u16::MAX
        ),
        "a bundled oversized Place footprint must be EditFootprintOutOfRange"
    );
}

#[test]
fn class_edit_anchor_out_of_bounds() {
    let (mut bundle, _src) = genesis_bundle();
    bundle.edit_log.push(EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::Place {
            kind: 0,
            cell_x: GRID_MAX + 1,
            cell_y: 0,
            w: 1,
            h: 1,
            ports: Vec::new(),
            rot: 0,
        },
    });
    let result = load_bundle(&bundle, "out_of_extent_anchor.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::EditAnchorOutOfBounds { cell_x, cell_y })
                if cell_x == GRID_MAX + 1 && cell_y == 0
        ),
        "a bundled out-of-extent Place anchor must be EditAnchorOutOfBounds"
    );
}

#[test]
fn class_edit_port_out_of_footprint() {
    let (mut bundle, _src) = genesis_bundle();
    bundle.edit_log.push(EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op: EditOp::Place {
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            w: 2,
            h: 2,
            // (2, 0) lies outside [0,2)×[0,2) on the x axis (x must be < w == 2).
            ports: vec![Port {
                local_offset: (2, 0),
                side: Side::E,
                role: Role::Out, medium: Medium::Mechanical,
            }],
            rot: 0,
        },
    });
    let result = load_bundle(&bundle, "out_of_footprint_port.fab");
    assert!(
        matches!(
            result,
            Err(ProjectError::EditPortOutOfFootprint { local_offset, w, h })
                if local_offset == (2, 0) && w == 2 && h == 2
        ),
        "a bundled out-of-footprint Place port must be EditPortOutOfFootprint"
    );
}

// ---------------------------------------------------------------------------
// Plan 74.1-23 (review WR-02, round 3): forged port edits and the post-replay gate
// ---------------------------------------------------------------------------

/// A bundle over an EMPTY genesis core (no out-of-log node), so `NodeId`s minted by a
/// `GridSession` on the same seed name the same nodes when `load_project` replays them.
fn empty_bundle(edit_log: Vec<EditRecord>) -> ProjectFile {
    let core = Core::genesis(header());
    let head_tick = edit_log.iter().map(|r| r.tick).max().map_or(core.tick, |t| t + 1);
    ProjectFile {
        version: PROJECT_FILE_VERSION,
        head_tick,
        snapshot: fabrico_core::snapshot::snapshot(&core),
        log: Vec::new(),
        edit_log,
    }
}

/// A 3-output Factory (3x3) at (20,20), built by the command layer: its records, its
/// node id and the catalog index of its first Out.
fn three_output_factory_records() -> (fabrico_command::GridSession, NodeId, u16) {
    use fabrico_protocol::{GridCommand, machine_kind, port_medium, port_role};
    let mut s = fabrico_command::GridSession::new(header().seed);
    s.apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 20, cell_y: 20 })
        .expect("place the factory");
    let m = *s.core().last_tick.placed.last().expect("minted");
    let h = s.view().handle_of(m).expect("handle");
    for _ in 0..2 {
        s.apply(GridCommand::AddPort {
            node: h,
            role: port_role::OUT,
            side: Side::E as u8,
            medium: port_medium::MECHANICAL,
        })
        .expect("an add on clear floor");
    }
    let first_out = s
        .core()
        .state
        .ports_of(m)
        .expect("ports")
        .iter()
        .position(|p| p.role == Role::Out)
        .expect("an Out");
    (s, m, u16::try_from(first_out).expect("small"))
}

/// Append `op` to `log` as its own action on the next tick.
fn forge_next(log: &mut Vec<EditRecord>, op: EditOp) {
    let last = log.last().expect("a log to extend");
    let (sequence, tick, action) = (last.sequence + 1, last.tick + 1, last.action + 1);
    log.push(EditRecord { schema_version: EDIT_SCHEMA_VERSION, partition: 0, sequence, tick, action, op });
}

/// A forged `AddPort { seat: Captured }` whose slot lies outside `[0, MAX_FOOTPRINT_DIM)`
/// is refused at load with the typed variant naming the record; slot 0 and
/// `MAX_FOOTPRINT_DIM - 1` are inside the envelope and load.
/// RED at the start revision: the out-of-range slots loaded.
#[test]
fn class_edit_port_edit_out_of_envelope() {
    let (_, src) = genesis_bundle();
    let captured_add = |slot: i32| {
        let (mut bundle, _) = genesis_bundle();
        bundle.edit_log.push(EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 5,
            tick: 0,
            action: 0,
            op: EditOp::AddPort {
                node: src,
                port: Port { local_offset: (0, slot), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                index: 0,
                seat: fabrico_core::edit::PortSeat::Captured,
            },
        });
        bundle.head_tick = 1;
        bundle
    };
    for slot in [-1, i32::from(MAX_FOOTPRINT_DIM)] {
        let result = load_bundle(&captured_add(slot), "forged_captured_seat.fab");
        assert!(
            matches!(result, Err(ProjectError::EditPortEditOutOfEnvelope { sequence: 5 })),
            "a captured slot {slot} is refused naming its record, got {:?}",
            result.err()
        );
    }
    for slot in [0, i32::from(MAX_FOOTPRINT_DIM) - 1] {
        let result = load_bundle(&captured_add(slot), "captured_seat_in_range.fab");
        assert!(result.is_ok(), "a captured slot {slot} is inside the envelope, got {:?}", result.err());
    }
}

/// THE STATE-AWARE HALF (round-4 checker): a forged `RemovePort{restore: Some}` whose box
/// is too small for the ports that SURVIVE is inside the decode envelope (dims in range,
/// anchor in extent), so only the replayed state can show it is wrong. The replayed Core
/// must pass the snapshot trust gate before anything is installed.
/// RED at the start revision: it loaded `Ok`, and the loaded core failed its own gate
/// (`PortOutOfFootprint`): a session running on a state the next load refuses.
#[test]
fn class_edit_replay_state_invalid() {
    use fabrico_core::edit::BoxRestore;
    use fabrico_core::event::{DecodeError, StateInvariant};
    let (s, m, first_out) = three_output_factory_records();
    let mut log = s.edit_log().to_vec();
    forge_next(
        &mut log,
        EditOp::RemovePort {
            node: m,
            index: first_out,
            restore: Some(BoxRestore { w: 3, h: 1, anchor_x: 20, anchor_y: 20 }),
        },
    );
    let result = load_bundle(&empty_bundle(log), "too_small_restore.fab");
    match result {
        Err(ProjectError::EditReplayStateInvalid(DecodeError::InvalidState(
            StateInvariant::PortOutOfFootprint,
        ))) => {}
        Err(e) => panic!("refused with the wrong error: {e:?}"),
        Ok(host) => panic!(
            "the forged log loaded; its core passes the gate: {:?}",
            fabrico_core::snapshot::restore(&fabrico_core::snapshot::snapshot(host.core())).map(|_| ())
        ),
    }
}

/// The control: a real growing add and its Ctrl+Z, both written by the command layer (so
/// the `RemovePort{restore: Some}` is the undo's own), loads `Ok`, and a save of the
/// loaded host loads `Ok` again. Green at both revisions: the check refuses only a state
/// the gate refuses.
#[test]
fn class_edit_replay_state_invalid_control_real_undo_loads() {
    use fabrico_protocol::{GridCommand, port_medium, port_role};
    let (mut s, m, _) = three_output_factory_records();
    let h = s.view().handle_of(m).expect("handle");
    s.apply(GridCommand::AddPort { node: h, role: port_role::OUT, side: Side::E as u8, medium: port_medium::MECHANICAL })
        .expect("a growing add");
    s.apply(GridCommand::Undo).expect("its undo");
    assert!(
        s.edit_log().iter().any(|r| matches!(r.op, EditOp::RemovePort { restore: Some(_), .. })),
        "the undo of a growing add carries a restore box"
    );
    let host = load_bundle(&empty_bundle(s.edit_log().to_vec()), "real_undo.fab").expect("a real undo loads");
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("resaved.fab");
    fabrico_host::project::save_project(&host, &path).expect("save the loaded host");
    let work = tempfile::tempdir().expect("work dir");
    load_project(&path, work.path(), None).expect("and the re-save loads again");
}
