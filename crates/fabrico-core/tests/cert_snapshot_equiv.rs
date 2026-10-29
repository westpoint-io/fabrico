//! Certification criterion 2 — snapshot / replay equivalence on the unified
//! `tick_hash` oracle, REPLAY-03.
//!
//! Generalizes the three existing `*_snapshot_restore_equiv` proofs
//! (`tests/snapshot.rs`, `tests/routing.rs`, `tests/merge.rs` — which compare
//! `state_bytes` directly) onto the single shared `tick_hash` digest (Open
//! Question 2). A snapshot taken at any tick T, restored into a fresh core, and
//! continued with the SAME per-tick logic to T+N must reach the same final
//! `tick_hash` as an uninterrupted run to T+N.
//!
//! The operator-specific byte-level snapshot tests are left untouched: equal
//! bytes imply an equal hash, so they remain as finer-grained regressions while
//! this binary ADDS the unified-hash coverage every later criterion reuses.

mod common;

use common::{
    COUNTER_FACTORY_JS, INTRINSIC_STASH_FACTORY_JS, MODULE_SCOPE_COUNTER_FACTORY_JS, run_balancer_to,
    run_factory_to, run_merge_to, run_scenario_to, step_balancer_scenario, step_factory_scenario,
    step_merge_scenario, step_scenario, tick_hash,
};
use common::{advance_drawing_rng, fire, header};
use fabrico_core::core::Core;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::{Node, SinkTemplate};
use fabrico_core::snapshot::{restore, snapshot};
use proptest::prelude::*;

/// Phase 87 (JAM-01, D-02): two Sources docked on the Balancer's In 0 and In 1 and
/// `outputs` collectors. Defined here rather than in `common` so the shared single-input
/// scenario the replay certs use stays exactly as it was.
fn two_input_balancer(seed: u64, outputs: u16) -> (Core, [NodeId; 2]) {
    let mut core = Core::genesis(header(seed));
    let s0 = core.state.add_source();
    let s1 = core.state.add_source();
    let bal = core.state.add_balancer(outputs);
    core.state.link((s0, 0), (bal, 0));
    core.state.link((s1, 0), (bal, 1));
    for port in 0..outputs {
        let c = core.state.add_source();
        core.state.link((bal, port), (c, 0));
    }
    (core, [s0, s1])
}

/// One step of the two-input scenario: one item into In 0 every tick and one into In 1
/// on even ticks, so both Ins hold a backlog (a pass takes ONE item) and the input
/// pointer `next_in` decides which In the next pass serves. The schedule depends only on
/// `core.tick`, so an uninterrupted run and a restored one see the same events.
fn step_two_input_balancer(core: &mut Core, sources: [NodeId; 2]) {
    let t = core.tick;
    let mut inbound = vec![fire(sources[0], 2 * t, t, Item(vec![(t % 127) as u8]))];
    if t.is_multiple_of(2) {
        inbound.push(fire(sources[1], 2 * t + 1, t, Item(vec![0x80 | (t % 127) as u8])));
    }
    advance_drawing_rng(core, &inbound);
}

/// Phase 87 (JAM-05, D-07): a Factory whose JS emits its input three times on Out 0, into
/// a one-tile belt and on to a Sink, so the belt takes the emits slower than a run makes
/// them and `Factory::pending_emits` holds items at most restore ticks. Defined here, not
/// in `common`, so the shared factory scenario stays exactly as it was.
const THRICE_FACTORY_JS: &str =
    "export default function (input, ctx) { ctx.emit(0, input); ctx.emit(0, input); ctx.emit(0, input); }";

/// `source -> factory(THRICE_FACTORY_JS) -> belt(1) -> sink`. Returns `(core, source, factory)`.
fn thrice_factory(seed: u64) -> (Core, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let f = core
        .state
        .add_factory(THRICE_FACTORY_JS.to_owned(), fabrico_core::factory::DEFAULT_GAS_BUDGET, seed);
    let b = core.state.add_belt(1);
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (f, 0));
    core.state.link((f, 0), (b, 0));
    core.state.link((b, 0), (k, 0));
    (core, s, f)
}

/// Run the three-emit Factory scenario (one item a tick, `step_factory_scenario`) from
/// genesis up to (not including) `target`.
fn run_thrice_factory_to(seed: u64, target: u64) -> (Core, NodeId, NodeId) {
    let (mut core, s, f) = thrice_factory(seed);
    while core.tick < target {
        step_factory_scenario(&mut core, s);
    }
    (core, s, f)
}

/// The seed of the three-emit Factory scenario.
const THRICE_SEED: u64 = 0x0FAC_8704;

/// NON-VACUITY for `factory_pending_emits_snapshot_equiv_tick_hash`: the restore ticks its
/// strategy draws (`0..40`) mostly hold a queue, two items deep at some of them, so the
/// proof restores mid-queue rather than only at empty boundaries. Measured: the queue
/// cycles 2, 1, 1, 1, 0, 0 once the belt is full.
#[test]
fn the_pending_emits_restore_scenario_holds_a_queue() {
    let (mut core, s, f) = thrice_factory(THRICE_SEED);
    let mut lengths = Vec::new();
    while core.tick < 40 {
        lengths.push(queued_items(&core, f));
        step_factory_scenario(&mut core, s);
    }
    let holding = lengths.iter().filter(|&&n| n > 0).count();
    eprintln!("JAM-05 restore scenario queue length at t = 0..40: {lengths:?} holding={holding}");
    assert!(holding >= 20, "at least half the restore ticks hold a queue (read {holding} of 40)");
    assert!(lengths.contains(&2), "and some hold two items");
}

/// Items waiting in a Factory's queue.
fn queued_items(core: &Core, f: NodeId) -> usize {
    match core.state.node(f) {
        Some(Node::Factory(fac)) => fac.pending_emits.values().map(|q| q.len()).sum(),
        _ => 0,
    }
}

/// Run the two-input scenario from genesis up to (not including) `target`.
fn run_two_input_balancer_to(seed: u64, outputs: u16, target: u64) -> (Core, [NodeId; 2]) {
    let (mut core, sources) = two_input_balancer(seed, outputs);
    while core.tick < target {
        step_two_input_balancer(&mut core, sources);
    }
    (core, sources)
}

/// Phase 87 (JAM-04, D-06): a Source docked straight onto a one-Out Balancer, a 1-tile
/// outlet belt paced at 8 ticks per slot and a Debug Sink. The Source is fed every tick, so
/// the Balancer outruns its outlet: it sleeps behind the outlet's full staging inbox and is
/// woken each time the outlet takes an item, and the Source sleeps behind the Balancer's
/// full inbox and is woken each time the Balancer takes one. Snapshots taken mid-run
/// therefore carry sleepers that only the reverse link index can wake. Returns
/// `(core, source, balancer)`.
fn jam_board(seed: u64) -> (Core, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let bal = core.state.add_balancer(1);
    let outlet = core.state.add_belt(1);
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (bal, 0));
    core.state.link((bal, 0), (outlet, 0));
    core.state.link((outlet, 0), (k, 0));
    match core.state.node_mut(outlet) {
        Some(Node::Belt(b)) => b.ticks_per_slot = std::num::NonZeroU32::new(8).expect("non-zero"),
        _ => unreachable!("the outlet is a belt"),
    }
    (core, s, bal)
}

/// One step of the jam scenario: one item into the Source every tick. The schedule depends
/// only on `core.tick`, so an uninterrupted run and a restored one see the same events.
fn step_jam_board(core: &mut Core, source: NodeId) {
    let t = core.tick;
    advance_drawing_rng(core, &[fire(source, t + 1, t, Item(vec![(t % 251) as u8]))]);
}

const JAM_SEED: u64 = 0x87_0606;

/// Phase 87 (JAM-04, D-06): the jam board, restored at EVERY tick of its first 400, restores
/// each time (so `BlockedNotGated` and the other trust-gate arms hold at every legitimate
/// boundary of a board that blocks and unblocks), and the sleepers are real: the Balancer is
/// asleep at the boundary on at least 200 of those ticks and the Source on at least 100.
#[test]
fn jam_board_restores_at_every_tick() {
    let (mut core, s, bal) = jam_board(JAM_SEED);
    let (mut bal_asleep, mut s_asleep) = (0u32, 0u32);
    for _ in 0..400 {
        step_jam_board(&mut core, s);
        let restored = restore(&snapshot(&core));
        assert!(restored.is_ok(), "tick {}: the jam board restores ({:?})", core.tick, restored.map(|_| ()));
        bal_asleep += u32::from(core.sched.is_blocked(bal));
        s_asleep += u32::from(core.sched.is_blocked(s));
    }
    eprintln!("JAM-04 restore scenario: balancer asleep at {bal_asleep} of 400 boundaries, source at {s_asleep}");
    assert!(bal_asleep >= 200, "the Balancer sleeps at most boundaries ({bal_asleep})");
    assert!(s_asleep >= 100, "the Source sleeps at many boundaries ({s_asleep})");
}

/// The belt jam board (phase 87, JAM-04, plan 87-07): Source, a 2-tile belt A, a 1-tile
/// belt B paced at 4 ticks per slot, a one-Out Balancer, a 1-tile outlet paced at 8, and a
/// Debug Sink. Fed every tick, the board backs up from the slow outlet: the Balancer sleeps
/// behind the outlet's staging inbox, B settles behind the Balancer's full inbox, A settles
/// behind B's full tail and the Source sleeps behind A. Each wakes and sleeps again as the
/// outlet drains, so a snapshot mid-run carries sleeping BELTS with no wake of their own
/// (the belt-to-belt tail-freed wake and the belt-to-machine consumer wake both in play).
/// Returns `(core, source, a, b)`.
fn belt_jam_board(seed: u64) -> (Core, NodeId, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let a = core.state.add_belt(2);
    let b = core.state.add_belt(1);
    let bal = core.state.add_balancer(1);
    let outlet = core.state.add_belt(1);
    let k = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (a, 0));
    core.state.link((a, 0), (b, 0));
    core.state.link((b, 0), (bal, 0));
    core.state.link((bal, 0), (outlet, 0));
    core.state.link((outlet, 0), (k, 0));
    for (belt, pace) in [(b, 4u32), (outlet, 8)] {
        match core.state.node_mut(belt) {
            Some(Node::Belt(x)) => x.ticks_per_slot = std::num::NonZeroU32::new(pace).expect("non-zero"),
            _ => unreachable!("a belt"),
        }
    }
    (core, s, a, b)
}

const BELT_JAM_SEED: u64 = 0x87_0707;

/// Plan 87-07 (JAM-04, D-06): the belt jam board, restored at EVERY tick of its first 600,
/// restores each time (so `BlockedBeltNotSettled` and the narrowed `BeltWakeMissing` hold at
/// every legitimate boundary of a board whose belts sleep and wake), and the belt sleepers
/// are real: A and B are each asleep at the boundary on at least 100 of those ticks.
#[test]
fn belt_jam_board_restores_at_every_tick() {
    let (mut core, s, a, b) = belt_jam_board(BELT_JAM_SEED);
    let (mut a_asleep, mut b_asleep) = (0u32, 0u32);
    for _ in 0..600 {
        step_jam_board(&mut core, s);
        let restored = restore(&snapshot(&core));
        assert!(restored.is_ok(), "tick {}: the belt jam board restores ({:?})", core.tick, restored.map(|_| ()));
        a_asleep += u32::from(core.sched.is_blocked(a));
        b_asleep += u32::from(core.sched.is_blocked(b));
    }
    eprintln!("JAM-04 belt restore scenario: belt A asleep at {a_asleep} of 600 boundaries, belt B at {b_asleep}");
    assert!(a_asleep >= 100, "belt A sleeps at many boundaries ({a_asleep})");
    assert!(b_asleep >= 100, "belt B sleeps at many boundaries ({b_asleep})");
}

proptest! {
    // Honor PROPTEST_CASES (CI sets 1024); `ProptestConfig::default()` reads the env
    // and defaults to 256 cases locally. `with_cases(256)` hardcoded `cases`, which
    // overwrote the env-derived value, so the env var was dead (WR-01).
    #![proptest_config(ProptestConfig::default())]

    /// Belt: latency 5 keeps items genuinely in flight at the snapshot boundary,
    /// so the restored continuation diverges unless `in_flight` + the scheduler
    /// wheel + the rng counter all survived the snapshot.
    #[test]
    fn belt_snapshot_equiv_tick_hash(t in 0u64..50, n in 1u64..50) {
        const SEED: u64 = 0x0BE1_7000;
        const LATENCY: u32 = 5;
        let total = t + n;

        let (uninterrupted, _s) = run_scenario_to(SEED, LATENCY, total);

        let (at_t, source) = run_scenario_to(SEED, LATENCY, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        while restored.tick < total {
            step_scenario(&mut restored, source);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "criterion 2 / REPLAY-03: belt snapshot+restore+continue == uninterrupted (tick_hash)"
        );
    }

    /// Balancer: one item/tick lands the rotation pointer mid-cycle at the
    /// snapshot boundary; the hashes match only if `next` survived the snapshot.
    /// Since phase 87 a second leg feeds both Ins, for the input pointer `next_in`.
    #[test]
    fn balancer_snapshot_equiv_tick_hash(t in 0u64..50, n in 1u64..50) {
        const SEED: u64 = 0x0BA1_A0CE;
        const OUTPUTS: u16 = 3;
        let total = t + n;

        let (uninterrupted, _s) = run_balancer_to(SEED, OUTPUTS, total);

        let (at_t, source) = run_balancer_to(SEED, OUTPUTS, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        while restored.tick < total {
            step_balancer_scenario(&mut restored, source);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "criterion 2 / REPLAY-03: balancer snapshot+restore+continue == uninterrupted (tick_hash)"
        );

        // Phase 87 (JAM-01, D-02): the same proof with BOTH Ins fed, so the input pointer
        // `next_in` is mid-rotation at the restore tick; the hashes match only if it
        // survived the snapshot as well as `next`.
        let (uninterrupted, _s) = run_two_input_balancer_to(SEED, OUTPUTS, total);
        let (at_t, sources) = run_two_input_balancer_to(SEED, OUTPUTS, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        while restored.tick < total {
            step_two_input_balancer(&mut restored, sources);
        }
        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "JAM-01: a two-input balancer snapshot+restore+continue == uninterrupted (tick_hash)"
        );
    }

    /// Merge: rotating feed + even-tick backlog leaves un-served inbox items and a
    /// pending tick+1 re-wake at the boundary; the source ids are rebuilt from the
    /// second deterministic `run_merge_to` call (topology is genesis-deterministic).
    #[test]
    fn merge_snapshot_equiv_tick_hash(t in 0u64..50, n in 1u64..50) {
        const SEED: u64 = 0x0E36_E000;
        const INPUTS: u16 = 3;
        let total = t + n;

        let (uninterrupted, _s, _c) = run_merge_to(SEED, INPUTS, total);

        let (at_t, sources, _c) = run_merge_to(SEED, INPUTS, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        while restored.tick < total {
            step_merge_scenario(&mut restored, &sources);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "criterion 2 / REPLAY-03: merge snapshot+restore+continue == uninterrupted (tick_hash)"
        );
    }

    /// Factory (criterion 5 / REPLAY-03): the snapshot equivalence proof across the
    /// JS boundary. Run the counter-factory scenario to tick `t` (live `ctx.state`
    /// counter mid-run), snapshot, restore into a FRESH `Core` whose engine cache is
    /// COLD (the `#[serde(skip)]` runtime map is empty after restore and rebuilds
    /// lazily on the next factory step — the live engine is REBUILT, never
    /// deserialized), continue with the SAME per-tick logic to `t+n`, and assert the
    /// final `tick_hash` equals the uninterrupted run's. The hashes match ONLY if
    /// the SOLE persistent factory state (`ctx.state` as plain JSON + the per-node
    /// rng) survived the snapshot — proving criterion 5 with NO JS-heap
    /// serialization. `step_factory_scenario`'s schedule depends only on `core.tick`,
    /// so the uninterrupted and restored event streams are byte-identical.
    #[test]
    fn factory_snapshot_equiv_tick_hash(t in 0u64..40, n in 1u64..40) {
        const SEED: u64 = 0x0FAC_7005;
        let total = t + n;

        let (uninterrupted, _s, _f, _c) = run_factory_to(SEED, COUNTER_FACTORY_JS, total);

        let (at_t, source, _f, _c) = run_factory_to(SEED, COUNTER_FACTORY_JS, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        // The restored core's factory runtime cache is cold; the first step rebuilds
        // the engine lazily from the snapshotted plain `Node::Factory` source.
        while restored.tick < total {
            step_factory_scenario(&mut restored, source);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "criterion 5 / REPLAY-03: factory snapshot+restore (cold cache)+continue == uninterrupted \
             (ctx.state captured in the snapshot as plain data; engine rebuilt, not deserialized)"
        );
    }

    /// Phase 87 (JAM-05, D-07): a restore taken while the Factory's queue holds items. Run
    /// the three-emit Factory scenario to tick `t`, snapshot, restore into a fresh `Core`,
    /// continue to `t+n`, and compare `tick_hash` with the uninterrupted run. The hashes
    /// match only if `Factory::pending_emits` survived the snapshot in order, and the
    /// restore itself passes the trust gate's queue rule.
    #[test]
    fn factory_pending_emits_snapshot_equiv_tick_hash(t in 0u64..40, n in 1u64..40) {
        let total = t + n;

        let (uninterrupted, _s, _f) = run_thrice_factory_to(THRICE_SEED, total);

        let (at_t, source, f) = run_thrice_factory_to(THRICE_SEED, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore a mid-queue snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        prop_assert_eq!(queued_items(&restored, f), queued_items(&at_t, f), "the queue is restored");
        while restored.tick < total {
            step_factory_scenario(&mut restored, source);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "JAM-05: a mid-queue factory snapshot+restore+continue == uninterrupted (tick_hash)"
        );
    }

    /// Phase 87 (JAM-04, D-06, Pitfall 8): a snapshot taken mid-jam, with machines asleep
    /// behind blocked outputs, restores and continues to the same `tick_hash` as the
    /// uninterrupted run. The reverse link index is `#[serde(skip)]`, so this fails when
    /// `restore` does not rebuild it: a restored sleeper is never woken by the consumer
    /// that frees its slot, and the board stops.
    #[test]
    fn jam_snapshot_equiv_tick_hash(t in 0u64..300, n in 1u64..200) {
        let total = t + n;

        let (mut uninterrupted, s, _bal) = jam_board(JAM_SEED);
        while uninterrupted.tick < total {
            step_jam_board(&mut uninterrupted, s);
        }

        let (mut at_t, s, _bal) = jam_board(JAM_SEED);
        while at_t.tick < t {
            step_jam_board(&mut at_t, s);
        }
        let mut restored = restore(&snapshot(&at_t)).expect("restore a mid-jam snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        while restored.tick < total {
            step_jam_board(&mut restored, s);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "JAM-04: a mid-jam snapshot+restore+continue == uninterrupted (tick_hash)"
        );
    }

    /// Phase 87 (JAM-04, plan 87-07): the belt jam board snapshot at any tick of its first
    /// 400, restored and continued, reaches the uninterrupted run's `tick_hash`. Its
    /// snapshots carry sleeping belts with no wake of their own, which only the consumer
    /// wake and the tail-freed wake (through the reverse link index `restore` rebuilds) can
    /// resume; a restored board whose sleepers were never woken would stop and diverge.
    #[test]
    fn belt_jam_snapshot_equiv_tick_hash(t in 0u64..400, n in 1u64..200) {
        let total = t + n;

        let (mut uninterrupted, s, _a, _b) = belt_jam_board(BELT_JAM_SEED);
        while uninterrupted.tick < total {
            step_jam_board(&mut uninterrupted, s);
        }

        let (mut at_t, s, _a, _b) = belt_jam_board(BELT_JAM_SEED);
        while at_t.tick < t {
            step_jam_board(&mut at_t, s);
        }
        let mut restored = restore(&snapshot(&at_t)).expect("restore a mid-jam snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        while restored.tick < total {
            step_jam_board(&mut restored, s);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "JAM-04: a snapshot with sleeping belts + restore + continue == uninterrupted (tick_hash)"
        );
    }

    /// CR-02 regression (snapshot/restore): the divergence the blocker was about.
    /// A factory holding its counter in a MODULE-SCOPE `let` would, under "compile
    /// once, run many", accumulate that counter on the live engine within a session
    /// yet store it NOWHERE in the snapshot — so a restore (cold cache → engine
    /// rebuilt fresh) would reset it to 0 and DIVERGE from the uninterrupted run.
    /// With per-tick module re-instantiation the module scope is fresh every tick in
    /// BOTH runs (the value is always `1`), so the snapshot/restore continuation
    /// reaches the identical final `tick_hash` as the uninterrupted run — proving
    /// module-scope state can no longer break SC#2. The ONLY thing that survives a
    /// snapshot is `ctx.state` (plain JSON) + the per-node rng.
    #[test]
    fn factory_snapshot_equiv_module_scope_tick_hash(t in 0u64..40, n in 1u64..40) {
        const SEED: u64 = 0x0FAC_5C09;
        let total = t + n;

        let (uninterrupted, _s, _f, _c) = run_factory_to(SEED, MODULE_SCOPE_COUNTER_FACTORY_JS, total);

        let (at_t, source, _f, _c) = run_factory_to(SEED, MODULE_SCOPE_COUNTER_FACTORY_JS, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        // Cold cache after restore: the first factory step rebuilds the engine, and
        // because module scope is per-tick scratch there is nothing for it to lose.
        while restored.tick < total {
            step_factory_scenario(&mut restored, source);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "CR-02 / REPLAY-03: a module-scope-counter factory snapshot+restore+continue == \
             uninterrupted (module scope cannot persist; ctx.state is the SOLE cross-tick state)"
        );
    }

    /// CR-01 regression (snapshot/restore): the shallow-freeze divergence the
    /// iteration-2 blocker was about. A factory stashing its counter on the curated
    /// `Math` object + `Object.prototype` (left mutable by the SHALLOW
    /// `Object.freeze(globalThis)`) and EMITTING that stashed value would, on a
    /// REUSED context, accumulate the counter on the live engine within a session yet
    /// store it NOWHERE in the snapshot — so a restore (cold cache → engine rebuilt
    /// fresh) would reset it and DIVERGE from the uninterrupted run. With a fresh
    /// context every tick the curated `Math` and every prototype are rebuilt in BOTH
    /// runs (the emitted value is always `1`), so the snapshot/restore continuation
    /// reaches the identical final `tick_hash` as the uninterrupted run — proving
    /// intrinsic/prototype mutation can no longer break SC#2. The ONLY thing that
    /// survives a snapshot is `ctx.state` (plain JSON) + the per-node rng.
    #[test]
    fn factory_snapshot_equiv_intrinsic_stash_tick_hash(t in 0u64..40, n in 1u64..40) {
        const SEED: u64 = 0x0FAC_AC01;
        let total = t + n;

        let (uninterrupted, _s, _f, _c) = run_factory_to(SEED, INTRINSIC_STASH_FACTORY_JS, total);

        let (at_t, source, _f, _c) = run_factory_to(SEED, INTRINSIC_STASH_FACTORY_JS, t);
        let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");
        // Cold cache after restore: the first factory step rebuilds the engine, and
        // because the JS realm (Math, prototypes) is per-tick scratch there is
        // nothing for it to lose.
        while restored.tick < total {
            step_factory_scenario(&mut restored, source);
        }

        prop_assert_eq!(
            tick_hash(&uninterrupted),
            tick_hash(&restored),
            "CR-01 / REPLAY-03: an intrinsic/prototype-stash factory snapshot+restore+continue == \
             uninterrupted (curated Math + prototypes cannot persist; ctx.state is the SOLE \
             cross-tick state)"
        );
    }
}

/// WR-01 (long-horizon, module-record / memory accumulation): a LIVE long-running
/// core must not diverge from a COLD-restored core via engine-internal growth. Under
/// the old REUSED-context design, per-tick `Module::declare("factory")` could
/// accumulate module records, so a long-lived core might hit `set_memory_limit` at a
/// tick a freshly-restored core would not — a silent snapshot/restore divergence
/// latent below the ~80-tick proptest horizon.
///
/// The fresh-context-per-tick fix resets the module-record table (and the whole
/// realm) every tick, so no such accumulation exists. This test PINS that across a
/// multi-thousand-tick horizon: run a stateful (`ctx.state`) counter factory
/// uninterrupted to a large `TOTAL`, snapshot at a mid-run `T`, restore into a fresh
/// (cold-cache) core, continue to `TOTAL`, and assert the cold-restored core's final
/// `tick_hash` equals the live core's. Any memory-accumulation divergence (live core
/// hits the limit at a tick the restored core does not) would surface as a hash
/// mismatch here. Deterministic, single fixed scenario — not randomized — so it is a
/// stable regression rather than a flaky probe.
#[test]
fn factory_long_horizon_snapshot_equiv_no_module_accumulation() {
    const SEED: u64 = 0x0FAC_10A6;
    // "Several thousand" ticks: far past the ~80-tick proptest horizon, enough that
    // any per-tick engine-internal growth would be visible against the 8 MiB fence.
    const TOTAL: u64 = 5000;
    const T: u64 = 2500;

    let (uninterrupted, _s, _f, _c) = run_factory_to(SEED, COUNTER_FACTORY_JS, TOTAL);

    let (at_t, source, _f, _c) = run_factory_to(SEED, COUNTER_FACTORY_JS, T);
    let mut restored = restore(&snapshot(&at_t)).expect("restore valid snapshot");
    assert_eq!(restored.tick, T, "restored resumes at the snapshot tick");
    while restored.tick < TOTAL {
        step_factory_scenario(&mut restored, source);
    }

    assert_eq!(
        tick_hash(&uninterrupted),
        tick_hash(&restored),
        "WR-01 / REPLAY-03: over {TOTAL} ticks a cold-restored core reaches the identical tick_hash \
         as the live core — per-tick fresh context resets the module-record table, so no engine \
         growth can diverge a long-lived core from a restored one"
    );
}
