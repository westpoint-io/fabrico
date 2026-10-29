//! The determinism helpers — proving the three byte-equality properties for any
//! authored [`Scenario`], reusing the core primitives (never forking them).
//!
//! For any `Scenario` these assert:
//! - [`assert_replays`] — replay-from-genesis is a DETERMINISTIC re-fold (two
//!   independent `replay_two_logs` reach byte-identical snapshots).
//! - [`assert_snapshot_restore`] — `snapshot -> restore -> snapshot` is byte-identical,
//!   and `restore` is the REJECT-ONLY trust gate (returns a typed `Result`).
//! - [`assert_arrival_order_independent`] — permuting a SAME-TICK batch of injections
//!   across DISTINCT sources (one item each) yields an identical final `tick_hash`.
//!
//! All three drive the canonical primitives: `GridSession::replay_two_logs`
//! (`run_log_two_logs` underneath), `fabrico_core::snapshot::{snapshot, restore}`, and
//! the one `oracle::tick_hash` digest. Nothing here re-implements a fold or a digest.

use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::event::{Event, EventPayload};
use fabrico_core::ids::NodeId;
use fabrico_core::snapshot::{restore, snapshot};

use fabrico_command::GridSession;

use crate::fixture::Scenario;
use crate::oracle;

/// Idle settle ticks applied after a replay before a final hash comparison, so
/// multi-tile belts deliver their items first (Pitfall 1).
///
/// # A BUDGET, therefore DERIVED (SLOT-03, plan 62-03)
/// A belt advances one slot every `ticks_per_slot` ticks, so the ticks a multi-tile
/// belt needs to clear scale one-for-one with that interval. This number is
/// HEADROOM, not an expectation: it must be large enough that transport has
/// finished, and being larger than necessary costs nothing but idle ticks. It is
/// therefore multiplied by the construction default so it re-derives at whatever
/// interval ships, rather than being a literal somebody has to remember to move.
///
/// # Its failure mode is SILENCE, which is why the raise is not optional
/// The unraised 32 has ONE tick of margin at an interval of 2 (measured). Under-run
/// it does not error: `assert_arrival_order_independent` still compares two
/// `tick_hash` values and they still agree, because both states are mid-transport in
/// the same way. The property keeps holding and quietly stops proving what its name
/// claims - that the arrival ORDER of a same-tick batch does not change the settled
/// result.
const SETTLE: u64 = 32 * DEFAULT_TICKS_PER_SLOT.get() as u64;

/// The largest batch size for which we enumerate ALL permutations (`n! <= 720`). Above
/// this we fall back to a deterministic REPRESENTATIVE set (canonical + reverse + every
/// single rotation) — still a strong order-independence probe without `n!` blow-up.
const FULL_PERMUTE_MAX: usize = 6;

/// (a) Replay-from-genesis is a DETERMINISTIC re-fold: two independent
/// `replay_two_logs` of the same `Scenario` reach BYTE-IDENTICAL snapshots. (The
/// stronger "== a live session that authored it" equality is proven once-and-for-all
/// in 13-01's `tests/pump.rs`; here we certify the authored scenario itself re-folds
/// deterministically.)
///
/// # Panics
/// Panics if the two replays diverge by a single byte.
pub fn assert_replays(s: &Scenario) {
    let a = GridSession::replay_two_logs(s.seed, &s.edit_log, &s.event_log);
    let b = GridSession::replay_two_logs(s.seed, &s.edit_log, &s.event_log);
    assert_eq!(
        snapshot(a.core()),
        snapshot(b.core()),
        "replay-from-genesis must be a byte-identical deterministic re-fold"
    );
}

/// (b) `snapshot -> restore -> snapshot` round-trips byte-identically, exercising the
/// REJECT-ONLY restore trust gate (`restore` returns a typed `Result`; a VALID
/// scenario snapshot restores).
///
/// # Panics
/// Panics if `restore` rejects a snapshot taken from this very scenario (it must not),
/// or if the re-snapshot differs by a byte.
pub fn assert_snapshot_restore(s: &Scenario) {
    let session = GridSession::replay_two_logs(s.seed, &s.edit_log, &s.event_log);
    let bytes = snapshot(session.core());
    // restore is reject-only: it NEVER mutates the decoded bytes and returns Result.
    let restored = restore(&bytes).expect("a snapshot taken from a valid scenario restores");
    assert_eq!(
        snapshot(&restored),
        bytes,
        "snapshot -> restore -> snapshot must be byte-identical"
    );
}

/// (c) Arrival-order independence (REPLAY-03 / T-3-ARR): permuting the wall-clock
/// arrival order of a SAME-TICK batch of injections leaves the final `tick_hash`
/// unchanged.
///
/// # DESIGN CONSTRAINT (load-bearing — copied verbatim from `cert_arrival_order.rs`)
/// The permuted events MUST each target a DISTINCT source (exactly one item per
/// source), NOT multiple items into one source. Reason: admission folds the inbound
/// slice IN ORDER and `ManualInject::admit` enqueues the item into the target source's
/// `pending` FIFO. So two items into the SAME source are arrival-order-sensitive *by
/// design* — and that order is the log's canonical `sequence` order, not wall-clock.
/// Across DISTINCT sources each source receives exactly one item, the fold steps the
/// woken sources in ascending `NodeId` order regardless of admission order, and
/// `route_seq` is assigned in that deterministic fold order — so the result is
/// genuinely arrival-order-independent. A future contributor who rewrites this to push
/// several items into one source will (correctly) see it become order-sensitive and
/// must NOT "fix" it by sorting — that would make the check vacuous.
///
/// This helper therefore only treats a same-tick batch as QUALIFYING when every event
/// is a `ManualInject` and all their targets are DISTINCT. If the scenario has no such
/// batch (size >= 2), the helper is a documented NO-OP and returns `false`.
///
/// # Returns
/// `true` if a qualifying batch was found and its permutations were all checked equal;
/// `false` if the scenario had no qualifying same-tick distinct-source batch (skipped).
///
/// # Panics
/// Panics if any permutation of the qualifying batch yields a different final hash.
#[must_use]
pub fn assert_arrival_order_independent(s: &Scenario) -> bool {
    let Some(batch_positions) = qualifying_batch(&s.event_log) else {
        return false; // documented no-op: no distinct-source same-tick batch
    };

    let batch: Vec<Event> = batch_positions
        .iter()
        .map(|&i| s.event_log[i].clone())
        .collect();

    let mut hashes: Vec<String> = Vec::new();
    for perm in permutations(batch.len()) {
        // Rebuild the event-log with ONLY the qualifying batch reordered; all other
        // events (and the edit-log) stay put.
        let mut permuted = s.event_log.clone();
        for (&slot, &pick) in batch_positions.iter().zip(perm.iter()) {
            permuted[slot] = batch[pick].clone();
        }
        let mut session = GridSession::replay_two_logs(s.seed, &s.edit_log, &permuted);
        // Settle multi-tile belts so the items reach their destinations before hashing.
        session.advance(SETTLE);
        hashes.push(oracle::tick_hash(session.core()));
    }

    let first = &hashes[0];
    assert!(
        hashes.iter().all(|h| h == first),
        "arrival order is irrelevant: every permutation of the distinct-source same-tick \
         batch must reach the identical final hash (REPLAY-03 / T-3-ARR)"
    );
    true
}

/// Find a QUALIFYING same-tick batch: the FIRST tick (in event-log order) whose events
/// are ALL `ManualInject`, number >= 2, and target DISTINCT sources. Returns the
/// positions (indices into `event_log`) of that batch, or `None` if none qualifies.
fn qualifying_batch(event_log: &[Event]) -> Option<Vec<usize>> {
    let mut i = 0usize;
    while i < event_log.len() {
        let tick = event_log[i].tick;
        // Gather the contiguous run of this tick's events (pump stamps a whole batch at
        // one tick in one call, so a same-tick batch is contiguous).
        let mut j = i;
        while j < event_log.len() && event_log[j].tick == tick {
            j += 1;
        }
        let positions: Vec<usize> = (i..j).collect();
        if positions.len() >= 2 && all_distinct_source_injections(event_log, &positions) {
            return Some(positions);
        }
        i = j;
    }
    None
}

/// True iff every event at `positions` is a `ManualInject` AND all their targets are
/// DISTINCT (the one-item-per-distinct-source design constraint).
fn all_distinct_source_injections(event_log: &[Event], positions: &[usize]) -> bool {
    let mut targets: Vec<NodeId> = Vec::with_capacity(positions.len());
    for &p in positions {
        match &event_log[p].payload {
            EventPayload::ManualInject { target, .. } => targets.push(*target),
            _ => return false, // a non-injection in the batch ⇒ not a source batch
        }
    }
    // Distinctness: sort + dedup must not shrink the set.
    let mut sorted = targets.clone();
    sorted.sort();
    sorted.dedup();
    sorted.len() == targets.len()
}

/// A bounded, DETERMINISTIC set of permutations of `0..n`. For `n <= FULL_PERMUTE_MAX`
/// this is EVERY permutation (Heap's algorithm); above that it is a representative set
/// (canonical + reverse + every single left-rotation) so the probe stays bounded.
fn permutations(n: usize) -> Vec<Vec<usize>> {
    let mut base: Vec<usize> = (0..n).collect();
    if n <= FULL_PERMUTE_MAX {
        let mut out = Vec::new();
        heap_permute(n, &mut base, &mut out);
        out
    } else {
        let mut out = Vec::new();
        out.push(base.clone()); // canonical
        let mut rev = base.clone();
        rev.reverse();
        out.push(rev);
        for r in 1..n {
            out.push((0..n).map(|k| (k + r) % n).collect());
        }
        out
    }
}

/// Heap's algorithm — append every permutation of `arr[0..k]` to `out`.
fn heap_permute(k: usize, arr: &mut [usize], out: &mut Vec<Vec<usize>>) {
    if k <= 1 {
        out.push(arr.to_vec());
        return;
    }
    for i in 0..k {
        heap_permute(k - 1, arr, out);
        // Heap's swap: even k swaps arr[i]/arr[k-1], odd k swaps arr[0]/arr[k-1].
        if k.is_multiple_of(2) {
            arr.swap(i, k - 1);
        } else {
            arr.swap(0, k - 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
    use fabrico_core::ids::Item;
    use fabrico_protocol::machine_kind::{SINK, SOURCE};
    use fabrico_protocol::BeltEnd;

    use crate::scene::{Handle, Scene};

    const SEED: u64 = 0x000A_C0DE;

    /// One `ManualInject` of `item` into the source behind `target`, unstamped (pump
    /// overwrites tick/sequence/partition).
    fn inject(target: NodeId, item: Vec<u8>) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            payload: EventPayload::ManualInject {
                target,
                port: 0,
                item: Item(item),
            },
        }
    }

    /// Author a scenario: THREE distinct source->sink pairs, then ONE pump of three
    /// `ManualInject`s (one per distinct source) at the SAME tick.
    fn three_source_scenario() -> Scenario {
        let mut scene = Scene::new(SEED);
        let pairs = [(0, 0, 2, 0), (0, 2, 2, 2), (0, 4, 2, 4)];
        let mut sources: Vec<Handle> = Vec::new();
        for (sx, sy, kx, ky) in pairs {
            let src = scene.place(SOURCE, sx, sy);
            let sink = scene.place(SINK, kx, ky);
            // Post-Wire (17-02): draw a straight belt from the source Out's facing cell
            // (sx+1, sy) to the sink In's facing cell (kx-1, ky) and dock both ends. The
            // pairs are laid out one row each with a 2-cell gap, so the belt is a single
            // tile at (sx+1, sy) == (kx-1, ky).
            let belt_cells: Vec<(i32, i32)> = (sx + 1..=kx - 1).map(|x| (x, sy)).collect();
            let belt = scene.draw_belt(&belt_cells);
            scene.dock(belt, BeltEnd::Tail, src, 0);
            scene.dock(belt, BeltEnd::Head, sink, 0);
            sources.push(src);
        }
        // Resolve each source to its NodeId and pump one item each, all in ONE call so
        // every event is stamped at the SAME tick (the qualifying batch).
        let batch: Vec<Event> = sources
            .iter()
            .enumerate()
            .map(|(k, &h)| inject(scene.node_id(h).expect("source resolves"), vec![k as u8]))
            .collect();
        scene.pump(&batch);
        scene.to_fixture()
    }

    #[test]
    fn all_three_determinism_properties_hold() {
        let s = three_source_scenario();
        assert_replays(&s);
        assert_snapshot_restore(&s);
        assert!(
            assert_arrival_order_independent(&s),
            "the scenario has a qualifying distinct-source same-tick batch, so the \
             arrival-order helper must run (not skip)"
        );
    }

    #[test]
    fn arrival_order_helper_skips_when_no_qualifying_batch() {
        // A scenario with no runtime events at all has no same-tick injection batch.
        let mut scene = Scene::new(SEED);
        let src = scene.place(SOURCE, 0, 0);
        let sink = scene.place(SINK, 3, 0);
        // Post-Wire: source@(0,0) Out faces E (facing (1,0)); sink@(3,0) In faces W
        // (facing (2,0)); the 2-tile belt (1,0)->(2,0) docks Tail->src, Head->sink.
        let belt = scene.draw_belt(&[(1, 0), (2, 0)]);
        scene.dock(belt, BeltEnd::Tail, src, 0);
        scene.dock(belt, BeltEnd::Head, sink, 0);
        let s = scene.to_fixture();
        assert!(
            !assert_arrival_order_independent(&s),
            "no injection batch ⇒ documented no-op (returns false)"
        );
        // The other two still hold for an event-free scenario.
        assert_replays(&s);
        assert_snapshot_restore(&s);
    }

    #[test]
    fn permutations_are_exhaustive_for_small_n() {
        assert_eq!(permutations(3).len(), 6, "3! = 6 permutations enumerated");
        // Every permutation is itself a permutation of 0..3 (no duplicates/garbage).
        for p in permutations(3) {
            let mut sorted = p.clone();
            sorted.sort();
            assert_eq!(sorted, vec![0, 1, 2]);
        }
    }
}
