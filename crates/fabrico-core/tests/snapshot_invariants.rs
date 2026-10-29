//! Snapshot trust-gate fuzzing — `restore()` is TOTAL over untrusted bytes
//! (closes the carried Phase-2 -> Phase-6 restore-invariant blocker, threat
//! T-06-01-DOS).
//!
//! A shareable project file is untrusted input. After the schema-tag check and a
//! successful `postcard::from_bytes::<Core>`, a structurally-valid-but-corrupt
//! `Core` could still drive `tick::step_node` / output routing / the scheduler
//! into a panic (RESEARCH A1). `restore()` forecloses that with a REJECT-ONLY
//! post-decode `validate_invariants` pass, returning a typed
//! `DecodeError::InvalidState(StateInvariant)`.
//!
//! This suite proves two things:
//!   1. **Totality** (proptest): for arbitrary byte mutations of a valid snapshot,
//!      `restore()` ALWAYS RETURNS — never panics / aborts — with one of the
//!      sanctioned variants. A returning test IS the no-panic proof.
//!   2. **Per-class rejection** (focused cases): each of the five
//!      `StateInvariant` classes, constructed as a decodable-but-invalid `Core`,
//!      is rejected with its exact variant.
//!
//! Run target: `cargo test -p fabrico-core --test snapshot_invariants`
//! (`PROPTEST_CASES=1024` in CI). Core is NOT `Debug`, so assertions match on the
//! `Result` shape only — never on decoded fields.

use fabrico_core::core::Core;
use fabrico_core::event::{DecodeError, LogHeader, SCHEMA_VERSION, StateInvariant};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::{Footprint, MAX_FOOTPRINT_DIM, Medium, Node, Port, Role, Side, SinkTemplate};
use fabrico_core::wire::{WIRE_INFLIGHT_CAP, WireInFlight};
use proptest::prelude::*;

/// A genesis header carrying `seed`.
fn header(seed: u64) -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed,
    }
}

/// A `NodeId` guaranteed absent from any grid built with `add_*` (which only ever
/// insert, so every live node id is version 1). Insert -> remove -> re-insert
/// reuses slot index 0 with a BUMPED version (2), so the id can never collide with
/// a live grid id — the rigorous "dangling id" the trust gate must reject.
fn ghost_id() -> NodeId {
    let mut foreign: slotmap::SlotMap<NodeId, ()> = slotmap::SlotMap::with_key();
    let k = foreign.insert(());
    foreign.remove(k); // frees slot 0, bumping its version
    foreign.insert(()) // slot 0, version 2 — distinct from any v1 grid id
}

/// A VALID base `Core` with a populated topology — a balancer, a merge, a belt, a
/// link chain to live targets, and both an immediate and a future scheduled wake
/// on live nodes. All pointers are in range and every reference is live, so it
/// passes `validate_invariants`; it is the deterministic seed the fuzzer mutates.
fn valid_base() -> Core {
    let mut core = Core::genesis(header(0xBA5E_5EED));
    let s = core.state.add_source();
    let bal = core.state.add_balancer(3); // next = 0 < 3 (in range)
    let mrg = core.state.add_merge(2); // next = 0 < 2 (in range)
    let b = core.state.add_belt(4);
    // Wire source -> balancer -> belt -> merge: every link target is a live node.
    core.state.link((s, 0), (bal, 0));
    core.state.link((bal, 0), (b, 0));
    core.state.link((b, 0), (mrg, 0));
    // Schedule wakes on LIVE nodes only.
    core.sched.wake_now(s);
    core.sched.schedule_wake(b, 4);
    core
}

#[test]
fn valid_base_restores_ok() {
    // Sanity: the fuzzer's seed snapshot is itself accepted (Ok), so the suite is
    // mutating a genuinely-valid baseline.
    let bytes = snapshot(&valid_base());
    assert!(restore(&bytes).is_ok());
}

proptest! {
    // CI overrides with PROPTEST_CASES=1024; the in-source default keeps local
    // runs fast while still exercising the totality property broadly.
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Flip an arbitrary byte of a valid snapshot to an arbitrary value and assert
    /// `restore()` ALWAYS returns one of the sanctioned outcomes — never panics,
    /// never aborts. Most flips corrupt the postcard body (-> Malformed); a tag
    /// flip may yield UnknownVersion (too-new) or SnapshotTooOld (too-old, the
    /// Phase-9 backward-version refusal); a rare flip lands a still-valid Core
    /// (-> Ok) or a structurally-valid-but-invariant-violating Core (-> InvalidState).
    #[test]
    fn restore_is_total_over_single_byte_flips(
        idx in any::<prop::sample::Index>(),
        new_byte in any::<u8>(),
    ) {
        let mut bytes = snapshot(&valid_base());
        let i = idx.index(bytes.len());
        bytes[i] = new_byte;
        // The call RETURNING at all is the no-panic proof; the variant must be
        // one of the sanctioned typed-error shapes. SnapshotTooOld closes the
        // allow-set drift: a version-tag flip to a recognized-but-too-old value
        // is a legitimate total-restore outcome (symmetric with UnknownVersion).
        prop_assert!(matches!(
            restore(&bytes),
            Ok(_)
                | Err(DecodeError::InvalidState(_))
                | Err(DecodeError::Malformed)
                | Err(DecodeError::UnknownVersion(_))
                | Err(DecodeError::SnapshotTooOld(_))
        ));
    }

    /// Truncate a valid snapshot to an arbitrary prefix length: a short blob must
    /// be refused (or, at the exact full length, accepted) — never a panic.
    #[test]
    fn restore_is_total_over_truncations(cut in 0usize..512) {
        let bytes = snapshot(&valid_base());
        let end = cut.min(bytes.len());
        let truncated = &bytes[..end];
        prop_assert!(matches!(
            restore(truncated),
            Ok(_)
                | Err(DecodeError::InvalidState(_))
                | Err(DecodeError::Malformed)
                | Err(DecodeError::UnknownVersion(_))
        ));
    }

    /// Forge a structurally-valid Core with an out-of-range balancer/merge pointer
    /// drawn from the strategy: the decode succeeds but the invariant gate rejects
    /// it with the matching variant (never a panic on the corrupt pointer).
    #[test]
    fn restore_rejects_out_of_range_operator_pointers(
        outputs in 1u16..8,
        bad_next in 8u16..64,
        pick_merge in any::<bool>(),
    ) {
        let mut core = Core::genesis(header(0x0DD_F00D));
        if pick_merge {
            let m = core.state.add_merge(outputs);
            if let Some(Node::Merge(node)) = core.state.node_mut(m) {
                node.next = bad_next; // bad_next >= outputs -> out of range
            }
            let bytes = snapshot(&core);
            prop_assert!(matches!(
                restore(&bytes),
                Err(DecodeError::InvalidState(StateInvariant::MergePointer))
            ));
        } else {
            let b = core.state.add_balancer(outputs);
            if let Some(Node::Balancer(node)) = core.state.node_mut(b) {
                node.next = bad_next;
            }
            let bytes = snapshot(&core);
            prop_assert!(matches!(
                restore(&bytes),
                Err(DecodeError::InvalidState(StateInvariant::BalancerPointer))
            ));
        }
    }
}

// --- Focused, fast regression: one decodable-but-invalid Core per variant. ---

#[test]
fn rejects_balancer_pointer() {
    let mut core = Core::genesis(header(1));
    let bal = core.state.add_balancer(3);
    if let Some(Node::Balancer(b)) = core.state.node_mut(bal) {
        b.next = b.outputs; // 3 >= 3 -> out of range
    }
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::BalancerPointer))
    ));
}

/// Phase 87 (JAM-01, D-02, threat T-87-05): a Balancer whose INPUT pointer is not a
/// catalog In is refused as `BalancerInputPointer`, never a panic and never a wrapped
/// scan. Forged at the edge (`u16::MAX`) and just past the range (`DEFAULT_ARITY`), on a
/// one-output Balancer and on a zero-output one (whose guard scans the Ins too).
#[test]
fn rejects_forged_balancer_input_pointer() {
    for (outputs, bad) in [
        (2u16, u16::MAX),
        (2, fabrico_core::tick::DEFAULT_ARITY),
        (1, u16::MAX),
        (0, fabrico_core::tick::DEFAULT_ARITY),
    ] {
        let mut core = Core::genesis(header(0x87_0003));
        let bal = core.state.add_balancer(outputs);
        if let Some(Node::Balancer(b)) = core.state.node_mut(bal) {
            b.next_in = bad;
        }
        let bytes = snapshot(&core);
        assert!(
            matches!(
                restore(&bytes),
                Err(DecodeError::InvalidState(StateInvariant::BalancerInputPointer))
            ),
            "outputs={outputs} next_in={bad} must be refused as BalancerInputPointer"
        );
    }
    // And the last in-range value is accepted, so the arm is not over-wide.
    let mut core = Core::genesis(header(0x87_0003));
    let bal = core.state.add_balancer(2);
    if let Some(Node::Balancer(b)) = core.state.node_mut(bal) {
        b.next_in = fabrico_core::tick::DEFAULT_ARITY - 1;
    }
    assert!(restore(&snapshot(&core)).is_ok(), "next_in = DEFAULT_ARITY - 1 restores");
}

/// A Factory whose Out 0 is linked to a Sink, as a live board would have it, for the four
/// forged `pending_emits` shapes below (phase 87, D-07, threat T-87-06). Returns the core
/// and the Factory's id.
fn factory_board() -> (Core, NodeId) {
    let mut core = Core::genesis(header(0x87_0006));
    let f = core.state.add_factory(
        "export default function (input, ctx) { ctx.emit(0, input); }".to_owned(),
        fabrico_core::factory::DEFAULT_GAS_BUDGET,
        6,
    );
    let k = core.state.add_sink(fabrico_core::state::SinkTemplate::Debug, 0);
    core.state.link((f, 0), (k, 0));
    (core, f)
}

/// Set `f`'s pending emits to one queue of `n` items on `port`.
fn forge_pending(core: &mut Core, f: NodeId, port: u16, n: usize) {
    if let Some(Node::Factory(factory)) = core.state.node_mut(f) {
        let queue: std::collections::VecDeque<Item> = (0..n).map(|i| Item(vec![i as u8])).collect();
        factory.pending_emits.insert(port, queue);
    }
}

/// The refusal every forged `pending_emits` shape must earn.
fn assert_pending_emits_refused(core: &Core, what: &str) {
    let got = restore(&snapshot(core)).map(|_| ());
    assert!(
        matches!(
            got,
            Err(DecodeError::InvalidState(StateInvariant::FactoryPendingEmits))
        ),
        "{what} must be refused as FactoryPendingEmits: got {got:?}"
    );
}

#[test]
fn rejects_forged_factory_pending_emits_on_the_fault_port() {
    let (mut core, f) = factory_board();
    // A fault port docked to something, so only the key itself can be what is refused.
    let k = core.state.add_sink(fabrico_core::state::SinkTemplate::Debug, 0);
    core.state.link((f, fabrico_core::fault::FAULT_PORT), (k, 0));
    forge_pending(&mut core, f, fabrico_core::fault::FAULT_PORT, 1);
    assert_pending_emits_refused(&core, "a pending emit keyed on FAULT_PORT");
}

#[test]
fn rejects_forged_factory_pending_emits_on_an_unlinked_port() {
    let (mut core, f) = factory_board();
    forge_pending(&mut core, f, 1, 1); // Out 1 has no link from this Factory
    assert_pending_emits_refused(&core, "a pending emit on a port with no link");
}

#[test]
fn rejects_forged_factory_pending_emits_empty_queue() {
    let (mut core, f) = factory_board();
    forge_pending(&mut core, f, 0, 0);
    assert_pending_emits_refused(&core, "an empty pending queue");
}

#[test]
fn rejects_forged_factory_pending_emits_over_the_cap() {
    let cap = fabrico_core::factory::FACTORY_EMITS_PER_PORT;
    for n in [cap, cap + 1, 4096] {
        let (mut core, f) = factory_board();
        forge_pending(&mut core, f, 0, n);
        assert_pending_emits_refused(&core, &format!("a pending queue of {n} items (cap {cap})"));
    }
    // The bound is not over-wide: the largest queue one run can leave, cap - 1 on a linked
    // port, restores. Scheduled at `core.tick`, as the run that left it re-wakes the Factory
    // (a queue with no wake is `MachineWakeMissing`, threat T-87-28).
    let (mut core, f) = factory_board();
    forge_pending(&mut core, f, 0, cap - 1);
    core.sched.schedule_wake(f, core.tick);
    assert!(
        restore(&snapshot(&core)).is_ok(),
        "a pending queue of cap - 1 items on a linked port restores"
    );
}

#[test]
fn rejects_forged_dangling_blocked_id() {
    let mut core = Core::genesis(header(0x87_0007));
    let _s = core.state.add_source();
    core.sched.test_insert_blocked(ghost_id()); // a sleeper that is not a live node
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(
        matches!(got, Err(DecodeError::InvalidState(StateInvariant::DanglingSchedule))),
        "a blocked id naming no live node must be refused as DanglingSchedule: got {got:?}"
    );
    // A live sleeper restores, so the arm reads liveness and not mere presence. Since plan
    // 87-06 a sleeper must also be gated (`BlockedNotGated`), so the live sleeper here is a
    // Source whose only Out feeds a Sink holding `MECHANICAL_INBOX_CAP` items: a machine the
    // gate really holds back.
    let (core, _s) = gated_source_board();
    assert!(restore(&snapshot(&core)).is_ok(), "a live, gated blocked id restores");
}

/// A Source whose Out 0 feeds a Sink whose In 0 already holds `MECHANICAL_INBOX_CAP` items,
/// so the gate holds the Source back, with the Source put in the sleep set. Returns
/// `(core, source)`.
///
/// The Sink is scheduled at `core.tick`, as a live Sink holding a backlog re-wakes itself:
/// a full Sink with no wake would never step, and is refused as `MachineWakeMissing`
/// (phase 87 security audit, threat T-87-28). Until that arm this fixture held exactly
/// that shape and restored.
fn gated_source_board() -> (Core, NodeId) {
    let mut core = Core::genesis(header(0x87_0617));
    let s = core.state.add_source();
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (k, 0));
    for i in 0..fabrico_core::admit::MECHANICAL_INBOX_CAP {
        core.state.inbox_mut(k).push(0, i as u64, Item(vec![1]));
    }
    core.sched.schedule_wake(k, core.tick);
    core.sched.test_insert_blocked(s);
    (core, s)
}

/// Plan 87-06, JAM-04, D-06, threat T-87-17: a sleeper that could move is refused.
///
/// A Sink has no output link, so the gate never holds it back; a forged file putting it in
/// the sleep set would strand it (nothing wakes a sleeper that is not blocked). It must be
/// refused as `BlockedNotGated`, never restored. So must a Source whose Sink has room for
/// one more item. The gated Source of `gated_source_board` restores, so the arm reads the
/// gate and not mere membership.
#[test]
fn rejects_forged_blocked_machine_that_can_move() {
    let mut core = Core::genesis(header(0x87_0616));
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.sched.test_insert_blocked(k);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(
        matches!(got, Err(DecodeError::InvalidState(StateInvariant::BlockedNotGated))),
        "a Sink (never gated) in the sleep set must be refused as BlockedNotGated: got {got:?}"
    );

    let (mut core, _s) = gated_source_board();
    let k = core.state.node_ids().find(|&id| matches!(core.state.node(id), Some(Node::Sink(_)))).expect("the Sink");
    let _ = core.state.inbox_mut(k).take(0);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(
        matches!(got, Err(DecodeError::InvalidState(StateInvariant::BlockedNotGated))),
        "a Source asleep with room on its Sink must be refused as BlockedNotGated: got {got:?}"
    );

    let (core, _s) = gated_source_board();
    assert!(restore(&snapshot(&core)).is_ok(), "a gated sleeper restores");
}

/// A 1-tile belt whose head docks nowhere, holding `occupied` slots, with neither a wake
/// nor a sleep-set entry. Returns `(core, belt)`.
fn dangling_belt(seed: u64, occupied: &[usize]) -> (Core, NodeId) {
    let mut core = Core::genesis(header(seed));
    let belt = core.state.add_belt(1);
    if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
        for &i in occupied {
            b.slots[i] = Some(Item(vec![1]));
        }
    }
    (core, belt)
}

/// Plan 87-07, JAM-04, D-06, threat T-87-19: a belt in the sleep set that could still move
/// is refused.
///
/// Three forged sleepers, each also holding its wake at `core.tick` so the refusal cannot
/// be `BeltWakeMissing`: a belt with a gap behind its head (it would close forward), a
/// packed belt whose head has room downstream (it would deliver), and a packed belt with a
/// free tail and an item staged (it would admit). Each must be refused as
/// `BlockedBeltNotSettled`, never restored: a sleeper nothing will wake would strand its
/// items.
#[test]
fn rejects_forged_unsettled_belt_in_blocked() {
    let (mut core, belt) = dangling_belt(0x87_0711, &[0, 2]);
    core.sched.schedule_wake(belt, core.tick);
    core.sched.test_insert_blocked(belt);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(
        matches!(got, Err(DecodeError::InvalidState(StateInvariant::BlockedBeltNotSettled))),
        "a sleeping belt with a gap behind its head must be refused: got {got:?}"
    );

    let (mut core, belt) = dangling_belt(0x87_0712, &[0, 1]);
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((belt, 0), (k, 0));
    core.sched.schedule_wake(belt, core.tick);
    core.sched.test_insert_blocked(belt);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(
        matches!(got, Err(DecodeError::InvalidState(StateInvariant::BlockedBeltNotSettled))),
        "a sleeping belt whose head the Sink would take must be refused: got {got:?}"
    );

    let (mut core, belt) = dangling_belt(0x87_0713, &[0]);
    core.state.inbox_mut(belt).push(0, 1, Item(vec![2]));
    core.sched.schedule_wake(belt, core.tick);
    core.sched.test_insert_blocked(belt);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(
        matches!(got, Err(DecodeError::InvalidState(StateInvariant::BlockedBeltNotSettled))),
        "a sleeping belt with a free tail and an item staged must be refused: got {got:?}"
    );
}

/// Plan 87-07, JAM-04, D-06: a settled belt asleep with no wake restores.
///
/// Since plan 87-07 the fold withdraws a settled belt's own next-tick wake and puts it in
/// the sleep set, so a legitimate save holds an occupied belt with no wheel entry. The trust
/// gate must restore it rather than read it as `BeltWakeMissing`: a hand-built settled
/// sleeper (head held, packed from the head, nothing to admit), and the same belt settled
/// by the fold itself. The exemption reads the sleep set: the same belt with no wake and NOT
/// asleep is still `BeltWakeMissing`, so the arm is not a blanket pass.
#[test]
fn accepts_a_settled_sleeping_belt() {
    let (mut core, belt) = dangling_belt(0x87_0714, &[0, 1]);
    core.sched.test_insert_blocked(belt);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(got.is_ok(), "a settled sleeping belt with no wake restores: got {got:?}");

    let (mut core, belt) = dangling_belt(0x87_0715, &[0, 1, 2, 3]);
    core.state.inbox_mut(belt).push(0, 1, Item(vec![2]));
    core.sched.test_insert_blocked(belt);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(got.is_ok(), "a full settled belt with an item staged behind its full tail restores: got {got:?}");

    let (mut core, belt) = dangling_belt(0x87_0716, &[0, 1]);
    core.sched.schedule_wake(belt, core.tick);
    for _ in 0..3 {
        core.advance(&[]);
    }
    assert!(core.sched.is_blocked(belt), "the fold put the settled belt to sleep");
    assert!(!core.sched.is_scheduled_at(belt, core.tick), "with no wake of its own");
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(got.is_ok(), "the fold's own sleeping belt restores: got {got:?}");

    let (core, _belt) = dangling_belt(0x87_0717, &[0, 1]);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(
        matches!(got, Err(DecodeError::InvalidState(StateInvariant::BeltWakeMissing))),
        "an occupied belt neither scheduled nor asleep is still BeltWakeMissing: got {got:?}"
    );
}

#[test]
fn rejects_merge_pointer() {
    let mut core = Core::genesis(header(2));
    let mrg = core.state.add_merge(2);
    if let Some(Node::Merge(m)) = core.state.node_mut(mrg) {
        m.next = 9; // 9 >= 2 -> out of range
    }
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::MergePointer))
    ));
}

#[test]
fn rejects_missing_inbox() {
    let mut core = Core::genesis(header(3));
    let s = core.state.add_source();
    // `test_remove_inbox` is exposed via the `test-support` feature (enabled for
    // this crate's integration tests by the self dev-dependency) — no `add_*` path
    // can produce a node without an inbox.
    core.state.test_remove_inbox(s);
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::MissingInbox))
    ));
}

#[test]
fn rejects_dangling_link() {
    let mut core = Core::genesis(header(4));
    let s = core.state.add_source();
    core.state.link((s, 0), (ghost_id(), 0)); // target is not a live node
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::DanglingLink))
    ));
}

#[test]
fn rejects_dangling_schedule() {
    let mut core = Core::genesis(header(5));
    let _s = core.state.add_source();
    core.sched.schedule_wake(ghost_id(), 7); // scheduled id is not a live node
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::DanglingSchedule))
    ));
}

// --- FOOT-01 / V5: the three forged multi-cell rejections + a no-false-trip case. ---

#[test]
fn rejects_body_overlap_cell_collision() {
    // T-10-FORGE-BODY: two footprints with DISTINCT anchors but OVERLAPPING 2×2
    // bodies — an anchor-only check would pass, but the EXPANDED-cell check rejects
    // the duplicate body cell (1,1) with CellCollision (Pitfall 3).
    let mut core = Core::genesis(header(10));
    let a = core.state.add_source();
    let b = core.state.add_source();
    core.state.set_cell(a, (0, 0)); // body {(0,0),(1,0),(0,1),(1,1)}
    core.state.set_cell(b, (1, 1)); // body {(1,1),(2,1),(1,2),(2,2)} — overlaps at (1,1)
    let two_by_two = Footprint { w: 2, h: 2, rot: 0 };
    core.state.test_force_footprint(a, two_by_two, vec![]);
    core.state.test_force_footprint(b, two_by_two, vec![]);
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::CellCollision))
    ));
}

#[test]
fn rejects_dangling_footprint() {
    // T-10-FORGE-DANGLE: a footprints/ports key for a non-live NodeId → DanglingFootprint.
    let mut core = Core::genesis(header(11));
    let _s = core.state.add_source();
    let ghost = ghost_id();
    core.state
        .test_force_footprint(ghost, Footprint { w: 2, h: 1, rot: 0 }, vec![]);
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::DanglingFootprint))
    ));
}

#[test]
fn rejects_port_out_of_footprint() {
    // T-10-FORGE-PORT: a port local_offset outside the [0,w)×[0,h) rot-0 box →
    // PortOutOfFootprint. A 2×1 footprint admits x∈[0,2), y∈[0,1); (5,0) is out.
    let mut core = Core::genesis(header(12));
    let m = core.state.add_source();
    core.state.set_cell(m, (0, 0));
    let bad_port = Port {
        local_offset: (5, 0),
        side: Side::N,
        role: Role::In, medium: Medium::Mechanical,
    };
    core.state
        .test_force_footprint(m, Footprint { w: 2, h: 1, rot: 0 }, vec![bad_port]);
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::PortOutOfFootprint))
    ));
}

#[test]
fn rejects_oversized_footprint_dims() {
    // CR-01 / T-10-FORGE-DIM: a forged footprint at `w = h = u16::MAX` would expand
    // through `cells_of_footprint` to ~4.3 billion occupancy cells during
    // `rebuild_occupancy` (which runs BEFORE the class-invariant gate) — a tiny-input,
    // multi-GiB-allocation amplification bomb. The pre-rebuild dimension bound rejects
    // it with `FootprintTooLarge` BEFORE any expansion: a typed error, never an OOM,
    // never a panic. The single-byte-flip proptest above would essentially never
    // construct this, so it is pinned explicitly.
    let mut core = Core::genesis(header(14));
    let m = core.state.add_source();
    core.state.set_cell(m, (0, 0));
    core.state.test_force_footprint(
        m,
        Footprint {
            w: u16::MAX,
            h: u16::MAX,
            rot: 0,
        },
        vec![],
    );
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::FootprintTooLarge))
    ));
}

#[test]
fn rejects_out_of_bounds_anchor_no_overflow() {
    // CR-02 / T-10-FORGE-ANCHOR: a forged `cells` anchor at `i32::MAX` paired with a
    // multi-cell (2×1) footprint would compute `i32::MAX + 1` inside
    // `cells_of_footprint` on the pre-gate `rebuild_occupancy` path — a debug-build
    // overflow PANIC / release-build wrap, violating restore's reject-only-no-panic
    // guarantee. The anchor bound rejects it with `CellOutOfBounds` BEFORE expansion;
    // this test returning a typed error (not unwinding) is the no-panic proof.
    let mut core = Core::genesis(header(16));
    let m = core.state.add_source();
    core.state.set_cell(m, (i32::MAX, 0));
    core.state.test_force_footprint(
        m,
        Footprint {
            w: 2,
            h: 1,
            rot: 0,
        },
        vec![],
    );
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::CellOutOfBounds))
    ));
}

#[test]
fn rejects_zero_dim_footprint() {
    // WR-02: a `w == 0` (or `h == 0`) footprint expands to ZERO cells, so
    // `rebuild_occupancy` indexes nothing for the node while `cells` still records its
    // anchor — a placed-but-unoccupied node a live `Core` can never produce. The gate
    // rejects the degenerate dim with `FootprintTooLarge` (the dim-range check).
    let mut core = Core::genesis(header(17));
    let m = core.state.add_source();
    core.state.set_cell(m, (0, 0));
    core.state.test_force_footprint(
        m,
        Footprint {
            w: 0,
            h: 3,
            rot: 0,
        },
        vec![],
    );
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::FootprintTooLarge))
    ));
}

#[test]
fn rejects_out_of_range_rotation() {
    // WR-02: a forged `rot > 3` is out of the documented `0..=3` quarter-turn range.
    // Consumers mask, so it is harmless to the math, but the reject-only gate must not
    // hand back a validated `Core` carrying an out-of-contract `rot` → `FootprintBadRot`.
    let mut core = Core::genesis(header(18));
    let m = core.state.add_source();
    core.state.set_cell(m, (0, 0));
    core.state.test_force_footprint(
        m,
        Footprint {
            w: 2,
            h: 2,
            rot: 7,
        },
        vec![],
    );
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::FootprintBadRot))
    ));
}

#[test]
fn accepts_footprint_at_max_dim_boundary() {
    // No false trip: a footprint at EXACTLY `MAX_FOOTPRINT_DIM` on each axis is the
    // largest legal shape — it restores clean (the bound is inclusive) and round-trips
    // byte-identically, so the reject-only gate never drifts a legitimate save.
    let mut core = Core::genesis(header(15));
    let m = core.state.add_source();
    core.state.set_cell(m, (0, 0));
    core.state.test_force_footprint(
        m,
        Footprint {
            w: MAX_FOOTPRINT_DIM,
            h: MAX_FOOTPRINT_DIM,
            rot: 0,
        },
        vec![],
    );
    let bytes = snapshot(&core);
    let restored = restore(&bytes).expect("a footprint at the MAX_FOOTPRINT_DIM boundary restores");
    assert_eq!(
        bytes,
        snapshot(&restored),
        "reject-only: a max-dim footprint round-trips byte-identically"
    );
}

#[test]
fn valid_multicell_grid_restores_byte_identically() {
    // No false trip: distinct, non-overlapping 2×2 footprints, in-footprint ports,
    // live keys — restore() accepts it and it round-trips byte-identically (reject-only).
    let mut core = Core::genesis(header(13));
    let a = core.state.add_source();
    let b = core.state.add_source();
    core.state.set_cell(a, (0, 0)); // body {(0,0),(1,0),(0,1),(1,1)}
    core.state.set_cell(b, (10, 10)); // far away — disjoint
    let two_by_two = Footprint { w: 2, h: 2, rot: 0 };
    core.state.test_force_footprint(
        a,
        two_by_two,
        vec![
            Port {
                local_offset: (0, 0),
                side: Side::N,
                role: Role::In, medium: Medium::Mechanical,
            },
            Port {
                local_offset: (1, 1),
                side: Side::S,
                role: Role::Out, medium: Medium::Mechanical,
            },
        ],
    );
    core.state.test_force_footprint(b, two_by_two, vec![]);
    let bytes = snapshot(&core);
    let restored = restore(&bytes).expect("valid multi-cell grid restores clean");
    assert_eq!(
        bytes,
        snapshot(&restored),
        "reject-only: a valid multi-cell grid round-trips byte-identically"
    );
}

// --- Phase 37 / WIRE-03: the two forged wire rejections + an at-cap no-false-trip. ---

/// An in-flight message whose `return_addr` is `ret` (empty payload, budget/tick 0).
fn wire_msg(ret: (NodeId, u16)) -> WireInFlight {
    WireInFlight {
        entry_tick: 0,
        correlation: 0,
        return_addr: ret,
        budget: 0,
        payload: Item(vec![]),
    }
}

#[test]
fn rejects_oversized_wire_in_flight() {
    // T-37-10-OVERSIZE: a forged `Node::Wire` whose `in_flight` FIFO holds
    // `WIRE_INFLIGHT_CAP + 1` messages — a fan-out length the live `wire::admit` can
    // NEVER produce (it refuses at the cap). The pre-`rebuild_occupancy` bound
    // (`validate_footprint_bounds`, the DRAWBELT-BOMB precedent) rejects it with
    // `WireInFlightTooMany` BEFORE the fold walks it: a typed error, never an OOM/panic.
    let mut core = Core::genesis(header(30));
    let s = core.state.add_source();
    let w = core.state.add_wire((s, 0), (s, 1)); // live endpoints
    if let Some(Node::Wire(link)) = core.state.node_mut(w) {
        for _ in 0..=WIRE_INFLIGHT_CAP {
            link.in_flight.push_back(wire_msg((s, 0))); // CAP + 1 entries, live return_addr
        }
    }
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::WireInFlightTooMany))
    ));
}

#[test]
fn rejects_dangling_wire_endpoint() {
    // T-37-11-DANGLE (endpoint): a forged `Node::Wire` whose `to` endpoint names a
    // non-live NodeId — the exact `(node, port)` handle the deliver path dereferences.
    // Rejected with `DanglingWireEndpoint` (mirror `DanglingLink`), never a fold panic.
    let mut core = Core::genesis(header(31));
    let s = core.state.add_source();
    let _w = core.state.add_wire((s, 0), (ghost_id(), 1)); // `to` is not a live node
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::DanglingWireEndpoint))
    ));
}

#[test]
fn rejects_dangling_wire_return_addr() {
    // T-37-11-DANGLE (return_addr): a forged in-flight message whose `return_addr`
    // names a non-live NodeId — the address the reply path routes back to. Rejected
    // with `DanglingWireEndpoint`, never a fold panic on the dangling reply target.
    let mut core = Core::genesis(header(32));
    let s = core.state.add_source();
    let w = core.state.add_wire((s, 0), (s, 1)); // endpoints live
    if let Some(Node::Wire(link)) = core.state.node_mut(w) {
        link.in_flight.push_back(wire_msg((ghost_id(), 0))); // dangling reply address
    }
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::DanglingWireEndpoint))
    ));
}

#[test]
fn accepts_wire_at_in_flight_cap_boundary() {
    // No false trip (T-37-12-OVERREJECT): a LEGITIMATE `Node::Wire` holding EXACTLY
    // `WIRE_INFLIGHT_CAP` in-flight messages with LIVE endpoints + return addresses is
    // the largest legal in-flight state — it restores clean (the bound is inclusive)
    // and round-trips byte-identically, so the reject-only envelope never drifts a
    // legitimate at-cap save.
    //
    // WR-01: an occupied wire is ALSO self-re-woken at `core.tick` at a clean boundary
    // (`step_wire` SELF-REWAKE schedules `now + 1`, which sits at `core.tick` when
    // `take_due` has not run yet). This test now constructs that LEGITIMATE at-cap
    // state WITH the scheduler wake, so it exercises the "valid, no false trip" arm of
    // the new `WireWakeMissing` guard (the no-wake forge is the separate
    // `rejects_wire_wake_missing` below).
    let mut core = Core::genesis(header(33));
    let s = core.state.add_source();
    let w = core.state.add_wire((s, 0), (s, 1));
    if let Some(Node::Wire(link)) = core.state.node_mut(w) {
        for _ in 0..WIRE_INFLIGHT_CAP {
            link.in_flight.push_back(wire_msg((s, 0))); // exactly CAP, all live
        }
    }
    // The legit self-rewake an occupied wire always carries at the snapshot boundary.
    core.sched.schedule_wake(w, core.tick);
    assert!(
        core.sched.is_scheduled_at(w, core.tick),
        "an occupied wire is legitimately wheel-held at core.tick at the boundary"
    );
    let bytes = snapshot(&core);
    let restored = restore(&bytes).expect("a wire at the WIRE_INFLIGHT_CAP boundary restores");
    assert_eq!(
        bytes,
        snapshot(&restored),
        "reject-only: an at-cap wire round-trips byte-identically"
    );
}

#[test]
fn rejects_wire_wake_missing() {
    // WR-01 (the wire analog of `BeltWakeMissing`): a forged `Node::Wire` holding an
    // in-flight message with LIVE endpoints + return address but NO scheduler wake at
    // `core.tick`. `step_wire` self-re-wakes an occupied wire at `now + 1`, so a legit
    // occupied wire is ALWAYS wheel-held at `core.tick` at a clean boundary; dropping
    // that wake would silently strand the message (the wire never re-steps, the replay
    // hash drifts). The trust gate turns that into a typed rejection — never a panic,
    // never a silent strand. Deliberately NO `schedule_wake` here.
    let mut core = Core::genesis(header(34));
    let s = core.state.add_source();
    let w = core.state.add_wire((s, 0), (s, 1)); // endpoints live
    if let Some(Node::Wire(link)) = core.state.node_mut(w) {
        link.in_flight.push_back(wire_msg((s, 0))); // occupied, live return_addr, no wake
    }
    assert!(
        !core.sched.is_scheduled_at(w, core.tick),
        "the forge: an occupied wire with its wake dropped"
    );
    let bytes = snapshot(&core);
    assert!(matches!(
        restore(&bytes),
        Err(DecodeError::InvalidState(StateInvariant::WireWakeMissing))
    ));
}

#[test]
fn rejects_forged_zero_belt_interval() {
    // SLOT-03 / T-62-01: a forged snapshot whose belt carries a ZERO advance interval
    // is refused as a TYPED error and never panics the deterministic core.
    //
    // `Belt::ticks_per_slot` is `NonZeroU32`, so this state is UNREACHABLE from Rust —
    // there is no way to build the forge through the API, which is the whole point of
    // the type. So the forge is made at the BYTE level, the way a hand-edited save
    // file would make it, and that is what makes this test evidence rather than an
    // argument: `Belt::step` divides by this number, and a zero would be a division by
    // zero inside the sim's hot loop.
    //
    // The refusal is `DecodeError::Malformed`, produced by postcard's own `NonZeroU32`
    // decode inside `restore()`, NOT by a `StateInvariant` arm. `snapshot.rs`'s belt
    // block records in place why no arm was added and why recording the absence is the
    // decision. If a future edit weakens the field to a plain `u32`, this test is what
    // reddens.
    let mut core = Core::genesis(header(62));
    let b = core.state.add_belt(1);
    // A distinctive, otherwise-absent interval so the byte can be located unambiguously
    // rather than by guessing at postcard's field offsets. 0x7B = 123: a TEST marker,
    // not a proposed belt speed (D-19: the shipped value is a maintainer decision).
    let marker = std::num::NonZeroU32::new(0x7B).expect("0x7B is non-zero");
    if let Some(Node::Belt(belt)) = core.state.node_mut(b) {
        belt.ticks_per_slot = marker;
    }
    let bytes = snapshot(&core);

    // Sanity, in BOTH directions, before the forge: the marker must be present exactly
    // once (so the replacement below cannot hit some other field) and the unforged
    // snapshot must restore clean (so a rejection after the forge is caused by the
    // forge and not by an already-invalid base).
    let hits = bytes.iter().filter(|b| **b == 0x7B).count();
    assert_eq!(hits, 1, "the marker interval appears exactly once in the snapshot bytes");
    assert!(restore(&bytes).is_ok(), "the UNforged snapshot restores clean");

    let mut forged = bytes.clone();
    let at = forged.iter().position(|b| *b == 0x7B).expect("marker located");
    forged[at] = 0x00; // the forge: interval zero

    // Reject-only: an `Err`, NOT a `should_panic`. A panicking core is the failure this
    // guards against, so the assertion must be that the call RETURNED.
    assert!(
        matches!(restore(&forged), Err(DecodeError::Malformed)),
        "a forged zero belt interval is a typed Malformed refusal, never a panic"
    );
}

// ── Phase 87 security audit, threat T-87-28: work with no wake ──

/// One forged machine holding work its own step takes, alone on a board or feeding a Sink
/// with room, so nothing gates it. `wake` puts its wake at `core.tick`, the boundary a live
/// board's `now + 1` re-wake lands on. Returns `(name, core, machine)`.
fn machines_holding_work(wake: bool) -> Vec<(&'static str, Core, NodeId)> {
    let mut out = Vec::new();
    let mut add = |name: &'static str, build: &dyn Fn(&mut Core) -> NodeId| {
        let mut core = Core::genesis(header(0x87_2800 + out.len() as u64));
        let id = build(&mut core);
        if wake {
            core.sched.schedule_wake(id, core.tick);
        }
        out.push((name, core, id));
    };
    let room = |core: &mut Core, from: NodeId| {
        let k = core.state.add_sink(SinkTemplate::Debug, 0);
        core.state.link((from, 0), (k, 0));
    };
    add("a Source with a backlog", &|core| {
        let s = core.state.add_source();
        room(core, s);
        if let Some(Node::Source(src)) = core.state.node_mut(s) {
            src.pending.push_back(Item(vec![1]));
            src.pending.push_back(Item(vec![2]));
        }
        s
    });
    add("a Sink holding items on In 0", &|core| {
        let k = core.state.add_sink(SinkTemplate::Debug, 0);
        for i in 0..3 {
            core.state.inbox_mut(k).push(0, i, Item(vec![1]));
        }
        k
    });
    add("a Router holding an item on In 0", &|core| {
        let r = core.state.add_router(Vec::new(), Some(0));
        room(core, r);
        core.state.inbox_mut(r).push(0, 1, Item(vec![1]));
        r
    });
    add("a Tee holding an item on In 0", &|core| {
        let t = core.state.add_tee(1);
        room(core, t);
        core.state.inbox_mut(t).push(0, 1, Item(vec![1]));
        t
    });
    add("a Balancer holding an item on In 0", &|core| {
        let b = core.state.add_balancer(1);
        room(core, b);
        core.state.inbox_mut(b).push(0, 1, Item(vec![1]));
        b
    });
    add("a Balancer holding an item on In 1", &|core| {
        let b = core.state.add_balancer(1);
        room(core, b);
        core.state.inbox_mut(b).push(1, 1, Item(vec![1]));
        b
    });
    add("a Merge holding an item on In 1", &|core| {
        let m = core.state.add_merge(2);
        room(core, m);
        core.state.inbox_mut(m).push(1, 1, Item(vec![1]));
        m
    });
    add("a Factory holding an item on In 0", &|core| {
        let (f, _k) = linked_factory(core);
        core.state.inbox_mut(f).push(0, 1, Item(vec![b'1']));
        f
    });
    add("a Factory with waiting emits", &|core| {
        let (f, _k) = linked_factory(core);
        forge_pending(core, f, 0, 3);
        f
    });
    out
}

/// A Factory whose Out 0 feeds a Sink with room, on `core`. Returns `(factory, sink)`.
fn linked_factory(core: &mut Core) -> (NodeId, NodeId) {
    let f = core.state.add_factory(
        "export default function (input, ctx) { ctx.emit(0, input); }".to_owned(),
        fabrico_core::factory::DEFAULT_GAS_BUDGET,
        6,
    );
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((f, 0), (k, 0));
    (f, k)
}

/// THREAT T-87-28. A machine holding work its own step takes (a Source backlog, an item on
/// an In its step reads, a Factory's waiting emits) that is neither scheduled at
/// `core.tick` nor asleep in the sleep set would never step again: nothing on a live board
/// leaves one so, because every step re-wakes itself at `now + 1` while it holds such work
/// and every gated machine sleeps. Each must be refused as `MachineWakeMissing`, the
/// machine twin of `BeltWakeMissing`. The same machine with its wake restores, so the arm
/// reads the wake and not the work.
///
/// RED BEFORE THE ARM: every forged board restored `Ok(())`. Spelled as text so the test
/// compiled, and was seen red, before the variant existed.
#[test]
fn rejects_a_machine_holding_work_with_no_wake() {
    for (what, core, _id) in machines_holding_work(false) {
        let got = format!("{:?}", restore(&snapshot(&core)).map(|_| ()));
        assert_eq!(got, "Err(InvalidState(MachineWakeMissing))", "{what}, with no wake");
    }
    for (what, core, _id) in machines_holding_work(true) {
        let got = restore(&snapshot(&core)).map(|_| ());
        assert!(got.is_ok(), "{what}, scheduled at core.tick, restores: got {got:?}");
    }
}

/// THREAT T-87-28, the belt half. A belt's step takes from its staging inbox port 0, so an
/// item staged there with every slot empty is work too: neither scheduled nor asleep it
/// would wait forever. Refused as `BeltWakeMissing`, the arm that already guards a belt's
/// slots; restored once scheduled.
#[test]
fn rejects_a_belt_with_a_staged_item_and_no_wake() {
    let mut core = Core::genesis(header(0x87_2810));
    let belt = core.state.add_belt(1);
    core.state.inbox_mut(belt).push(0, 1, Item(vec![1]));
    let got = format!("{:?}", restore(&snapshot(&core)).map(|_| ()));
    assert_eq!(got, "Err(InvalidState(BeltWakeMissing))", "a staged item with no wake");
    core.sched.schedule_wake(belt, core.tick);
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(got.is_ok(), "the same belt scheduled at core.tick restores: got {got:?}");
}

/// THREAT T-87-28, the boards the arm must NOT refuse. Each holds items with no wake, and
/// each is a shape a live board reaches or no step reads:
///
/// - a gated machine asleep in the sleep set (`gated_source_board`): the sleep set is its
///   wake, and step 3b already proves it gated;
/// - a fault resting on a Sink's `FAULT_PORT` whose fault port is docked: a dock wakes
///   nothing (`tick.rs` `fold_dock`), so a live board holds this shape at a boundary and
///   the fault drain is left out of the arm on purpose;
/// - an item on an In no step reads (a Balancer's In 2, a Merge's In 2 on a two-input
///   Merge, a Sink's In 1): its step would not take it either, so a wake would not move it.
///   That shape is threat T-87-29's, not this arm's.
#[test]
fn accepts_items_that_have_a_wake_or_that_no_step_takes() {
    let (core, _s) = gated_source_board();
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(got.is_ok(), "a gated Source asleep behind a scheduled full Sink: got {got:?}");

    let mut core = Core::genesis(header(0x87_2820));
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    let fault_belt = core.state.add_belt(1);
    core.state.link((k, fabrico_core::fault::FAULT_PORT), (fault_belt, 0));
    core.state.inbox_mut(k).push(fabrico_core::fault::FAULT_PORT, 1, Item(vec![9]));
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(got.is_ok(), "a resting fault on a docked fault port, no wake: got {got:?}");

    let mut core = Core::genesis(header(0x87_2821));
    let b = core.state.add_balancer(1);
    let m = core.state.add_merge(2);
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.inbox_mut(b).push(fabrico_core::tick::DEFAULT_ARITY, 1, Item(vec![1]));
    core.state.inbox_mut(m).push(2, 2, Item(vec![2]));
    core.state.inbox_mut(k).push(1, 3, Item(vec![3]));
    let got = restore(&snapshot(&core)).map(|_| ());
    assert!(got.is_ok(), "items on Ins no step reads, no wake: got {got:?}");
}
