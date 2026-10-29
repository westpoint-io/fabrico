//! Certification criterion 1 — golden replay (genesis-vs-genesis per-tick hash
//! equality), REPLAY-03.
//!
//! Generalizes the Phase-1 SC#1 byte-equality proof (`tests/replay.rs`) onto the
//! unified `tick_hash` oracle: folding the SAME scenario from genesis twice must
//! yield an identical PER-TICK hash sequence — not merely an identical final
//! state. Equal snapshot bytes imply an equal hash, so the hash sequence is a
//! faithful (and corpus-freezable) restatement of the byte-identity guarantee.
//!
//! Coverage: belt / balancer / merge proptests across random seeds and tick
//! counts, plus a fully STATIC scripted-log router fault-mix unit test so a
//! router (first-match -> default -> fault) is locked under criterion 1 as well.

mod common;

use common::{
    COUNTER_FACTORY_JS, INTRINSIC_STASH_FACTORY_JS, MODULE_SCOPE_COUNTER_FACTORY_JS,
    drive_collecting_hashes, fire, fold_log_collecting_hashes, header, multi_source_merge_collector,
    source_balancer_collectors, source_belt_collector, source_factory_collector,
    step_balancer_scenario, step_factory_scenario, step_merge_scenario, step_scenario,
};
use fabrico_core::core::Core;
use fabrico_core::event::Event;
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::Item;
use fabrico_core::state::RouteKey;
use proptest::prelude::*;

proptest! {
    // Honor PROPTEST_CASES (CI sets 1024); `ProptestConfig::default()` reads the env
    // and defaults to 256 cases locally. `with_cases(256)` hardcoded `cases`, which
    // overwrote the env-derived value, so the env var was dead (WR-01).
    #![proptest_config(ProptestConfig::default())]

    /// Belt: latency 5 keeps items in flight, so intermediate hashes are
    /// non-trivial (not just the final settled state).
    #[test]
    fn belt_golden_replay_per_tick_hash(seed in any::<u64>(), ticks in 1u64..40) {
        let (mut a, sa, _ca) = source_belt_collector(seed, 5);
        let (mut b, sb, _cb) = source_belt_collector(seed, 5);
        let ha = drive_collecting_hashes(&mut a, ticks, |c| step_scenario(c, sa));
        let hb = drive_collecting_hashes(&mut b, ticks, |c| step_scenario(c, sb));
        prop_assert_eq!(
            ha, hb,
            "criterion 1 / REPLAY-03: belt per-tick hash sequence identical on genesis-vs-genesis"
        );
    }

    /// Balancer: one item/tick advances the round-robin rotation pointer, so the
    /// selection state is exercised at every captured boundary.
    #[test]
    fn balancer_golden_replay_per_tick_hash(seed in any::<u64>(), ticks in 1u64..40) {
        let (mut a, sa, _ca) = source_balancer_collectors(seed, 3);
        let (mut b, sb, _cb) = source_balancer_collectors(seed, 3);
        let ha = drive_collecting_hashes(&mut a, ticks, |c| step_balancer_scenario(c, sa));
        let hb = drive_collecting_hashes(&mut b, ticks, |c| step_balancer_scenario(c, sb));
        prop_assert_eq!(
            ha, hb,
            "criterion 1 / REPLAY-03: balancer per-tick hash sequence identical on genesis-vs-genesis"
        );
    }

    /// Merge: rotating feed + even-tick backlog forces a tick+1 re-wake, so the
    /// merge inbox + scheduler wheel are non-trivial at the captured boundaries.
    #[test]
    fn merge_golden_replay_per_tick_hash(seed in any::<u64>(), ticks in 1u64..40) {
        let (mut a, sources_a, _ca) = multi_source_merge_collector(seed, 3);
        let (mut b, sources_b, _cb) = multi_source_merge_collector(seed, 3);
        let ha = drive_collecting_hashes(&mut a, ticks, |c| step_merge_scenario(c, &sources_a));
        let hb = drive_collecting_hashes(&mut b, ticks, |c| step_merge_scenario(c, &sources_b));
        prop_assert_eq!(
            ha, hb,
            "criterion 1 / REPLAY-03: merge per-tick hash sequence identical on genesis-vs-genesis"
        );
    }

    /// Factory: a counter held in `ctx.state` (the SOLE cross-tick factory state) +
    /// a per-node `SimRng` — the FIRST criterion-1 case whose state crosses the JS
    /// boundary. Folding the same scenario from genesis twice must yield an identical
    /// per-tick hash sequence: `ctx.state` advances identically and the JS boundary
    /// (curated Math, f64-free seeded random, canonical JSON) leaks NO nondeterminism
    /// into the per-tick hash (criterion 5 / REPLAY-03). The engine is rebuilt fresh
    /// from source in each core, so an identical sequence also proves the lazy
    /// cold-cache build is deterministic.
    #[test]
    fn factory_golden_replay_per_tick_hash(seed in any::<u64>(), ticks in 1u64..40) {
        let (mut a, sa, _fa, _ca) = source_factory_collector(seed, COUNTER_FACTORY_JS);
        let (mut b, sb, _fb, _cb) = source_factory_collector(seed, COUNTER_FACTORY_JS);
        let ha = drive_collecting_hashes(&mut a, ticks, |c| step_factory_scenario(c, sa));
        let hb = drive_collecting_hashes(&mut b, ticks, |c| step_factory_scenario(c, sb));
        prop_assert_eq!(
            ha, hb,
            "criterion 1 / REPLAY-03: factory per-tick hash sequence identical on genesis-vs-genesis \
             (ctx.state + rng advance identically; the JS boundary leaks no nondeterminism)"
        );
    }

    /// CR-02 regression (genesis-vs-genesis): a factory that keeps its counter in a
    /// MODULE-SCOPE `let` (the idiomatic mistake) instead of `ctx.state`. With
    /// per-tick module re-instantiation the module scope is fresh every tick, so the
    /// emitted value is a constant `1` each tick — folding the same scenario from
    /// genesis twice yields an identical per-tick hash sequence. (This case is the
    /// companion to `factory_snapshot_equiv_module_scope_tick_hash`, which proves the
    /// SAME source ALSO cannot diverge across a snapshot/restore — together they pin
    /// that module-scope state is no longer a hidden, divergence-prone cross-tick
    /// channel.)
    #[test]
    fn module_scope_factory_golden_replay_per_tick_hash(seed in any::<u64>(), ticks in 1u64..40) {
        let (mut a, sa, _fa, _ca) = source_factory_collector(seed, MODULE_SCOPE_COUNTER_FACTORY_JS);
        let (mut b, sb, _fb, _cb) = source_factory_collector(seed, MODULE_SCOPE_COUNTER_FACTORY_JS);
        let ha = drive_collecting_hashes(&mut a, ticks, |c| step_factory_scenario(c, sa));
        let hb = drive_collecting_hashes(&mut b, ticks, |c| step_factory_scenario(c, sb));
        prop_assert_eq!(
            ha, hb,
            "CR-02 / REPLAY-03: a module-scope-counter factory has an identical per-tick hash \
             sequence genesis-vs-genesis (module scope resets each tick; ctx.state is the SOLE \
             cross-tick state)"
        );
    }

    /// CR-01 regression (genesis-vs-genesis): a factory that stashes its counter on
    /// the curated `Math` object + `Object.prototype` (the shallow-freeze door) and
    /// EMITS the stashed value. With a fresh context every tick the intrinsics are
    /// rebuilt each call, so the emitted value is a constant `1` every tick — folding
    /// the same scenario from genesis twice yields an identical per-tick hash
    /// sequence. (Companion to `factory_snapshot_equiv_intrinsic_stash_tick_hash`,
    /// which proves the SAME source ALSO cannot diverge across snapshot/restore —
    /// together they pin that intrinsic/prototype mutation is no longer a hidden,
    /// divergence-prone cross-tick channel.)
    #[test]
    fn intrinsic_stash_factory_golden_replay_per_tick_hash(seed in any::<u64>(), ticks in 1u64..40) {
        let (mut a, sa, _fa, _ca) = source_factory_collector(seed, INTRINSIC_STASH_FACTORY_JS);
        let (mut b, sb, _fb, _cb) = source_factory_collector(seed, INTRINSIC_STASH_FACTORY_JS);
        let ha = drive_collecting_hashes(&mut a, ticks, |c| step_factory_scenario(c, sa));
        let hb = drive_collecting_hashes(&mut b, ticks, |c| step_factory_scenario(c, sb));
        prop_assert_eq!(
            ha, hb,
            "CR-01 / REPLAY-03: an intrinsic/prototype-stash factory has an identical per-tick hash \
             sequence genesis-vs-genesis (curated Math + every prototype reset each tick under the \
             fresh context; ctx.state is the SOLE cross-tick state)"
        );
    }
}

/// Build `source -> factory(COUNTER_FACTORY_JS) -> collector` with the factory's
/// reserved `FAULT_PORT` wired to a dead-letter sink. Returns `(core, source_id)`.
/// Mirrors the `0005-factory-stateful` golden topology so the criterion-1 static-log
/// case drives the real counter + fuse-trip surface.
fn factory_fuse_mix(seed: u64) -> (Core, fabrico_core::ids::NodeId) {
    let (mut core, s, f, _c) = source_factory_collector(seed, COUNTER_FACTORY_JS);
    let sink = core.state.add_source();
    core.state.link((f, FAULT_PORT), (sink, 0));
    (core, s)
}

/// Criterion 1 over a factory via a fully STATIC scripted log INCLUDING a fuse-trip
/// tick: the counter increments three ticks, the `"loop"` sentinel trips the gas
/// fuse to a `FactoryTimeout` routed on `FAULT_PORT`, then the engine is reused for
/// a final increment. Folded through two fresh cores the per-tick hash sequences are
/// identical — so the fuse trip AND the `ctx.state` rollback-on-fault are reproducible
/// genesis-vs-genesis, not merely the happy path. This is the criterion-1 mirror of
/// the frozen `0005-factory-stateful` corpus fixture.
#[test]
fn factory_static_log_golden_replay() {
    const SEED: u64 = 0x0F00_5005;

    let log_for = |s: fabrico_core::ids::NodeId| -> Vec<Event> {
        vec![
            fire(s, 1, 0, Item(b"1".to_vec())),         // count -> 1, emit 1
            fire(s, 2, 1, Item(b"1".to_vec())),         // count -> 2, emit 2
            fire(s, 3, 2, Item(b"1".to_vec())),         // count -> 3, emit 3
            fire(s, 4, 3, Item(b"\"loop\"".to_vec())),  // fuse trip -> FactoryTimeout (state unchanged)
            fire(s, 5, 4, Item(b"1".to_vec())),         // count -> 4, emit 4 (engine reusable)
        ]
    };
    const TICKS: u64 = 7; // 5 event ticks + 2 idle settle ticks

    let (mut a, sa) = factory_fuse_mix(SEED);
    let (mut b, sb) = factory_fuse_mix(SEED);
    let ha = fold_log_collecting_hashes(&mut a, &log_for(sa), TICKS);
    let hb = fold_log_collecting_hashes(&mut b, &log_for(sb), TICKS);

    assert_eq!(
        ha, hb,
        "criterion 1 / REPLAY-03: factory static-log (incl. fuse trip) per-tick hash sequence identical on genesis-vs-genesis"
    );
}

/// Build `source -> router(0x01->port0, 0x02->port1, no default)` with port 0,
/// port 1, and the reserved `FAULT_PORT` each wired to a distinct collector
/// `Source` sink. Returns `(core, source_id)`. Mirrors
/// `tests/routing.rs#router_replay_byte_identical` so the criterion-1 router case
/// drives a real first-match / fault topology.
fn router_fault_mix(seed: u64) -> (Core, fabrico_core::ids::NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let router = core.state.add_router(
        vec![
            (RouteKey::new(0, vec![0x01]), 0),
            (RouteKey::new(0, vec![0x02]), 1),
        ],
        None,
    );
    core.state.link((s, 0), (router, 0));
    let c0 = core.state.add_source();
    let c1 = core.state.add_source();
    let cf = core.state.add_source();
    core.state.link((router, 0), (c0, 0));
    core.state.link((router, 1), (c1, 0));
    core.state.link((router, FAULT_PORT), (cf, 0));
    (core, s)
}

/// Criterion 1 over a router via a fully STATIC scripted log: a fixed fault-mix
/// (port-0 match / port-1 match / no-match fault) folded through two fresh cores
/// with `fold_log_collecting_hashes` yields identical per-tick hash sequences.
#[test]
fn router_static_log_golden_replay() {
    const SEED: u64 = 0x0072_07E5;

    // One fire per tick (ticks 0..5) mixing first-match, second-match, and
    // no-match (fault); then idle ticks 5..8 so the produced items fully settle
    // and the post-routing state is captured in the hash sequence too.
    let script: [(u64, Vec<u8>); 5] = [
        (0, vec![0x01, 0x0A]), // -> port 0
        (1, vec![0x02, 0x0B]), // -> port 1
        (2, vec![0x99, 0x0C]), // -> fault (no match)
        (3, vec![0x01, 0x0D]), // -> port 0
        (4, vec![0x03, 0x0E]), // -> fault (no match)
    ];

    let build_log = |s: fabrico_core::ids::NodeId| -> Vec<Event> {
        script
            .iter()
            .enumerate()
            .map(|(i, (tick, bytes))| fire(s, (i + 1) as u64, *tick, Item(bytes.clone())))
            .collect()
    };

    const TICKS: u64 = 8; // 5 event ticks + 3 idle settle ticks

    let (mut a, sa) = router_fault_mix(SEED);
    let (mut b, sb) = router_fault_mix(SEED);
    let log_a = build_log(sa);
    let log_b = build_log(sb);
    let ha = fold_log_collecting_hashes(&mut a, &log_a, TICKS);
    let hb = fold_log_collecting_hashes(&mut b, &log_b, TICKS);

    assert_eq!(
        ha, hb,
        "criterion 1 / REPLAY-03: router static-log per-tick hash sequence identical on genesis-vs-genesis"
    );
}
