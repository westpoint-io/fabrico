//! SC#1 — replay equality (REPLAY-01, CORE-02, CORE-05).
//!
//! The non-negotiable promise, proven in-process: the same scripted event log
//! folded from genesis twice produces **byte-identical** grid state. The
//! `snapshot` byte-vector is the state-equality oracle (RESEARCH A4). A second
//! case advances the seeded rng during the run so the equality also covers RNG
//! determinism (CORE-05).

mod common;

use common::{advance_drawing_rng, fire, source_belt_collector, state_bytes};
use fabrico_core::ids::Item;

#[test]
fn replay_twice_identical() {
    // source -> belt(2) -> collector; one scripted fire at tick 0, then drive
    // far enough for the item to traverse the belt and land in the collector.
    let build = || {
        let (mut core, s, _c) = source_belt_collector(0xBEEF, 2);
        core.run_log(&[fire(s, 1, 0, Item(vec![1, 2, 3]))]).expect("replay within MAX_REPLAY_SPAN");
        // run_log stops at the max event tick (0); advance to deliver the belt
        // item at T+2 so the snapshot captures post-delivery state too.
        core.advance(&[]);
        core.advance(&[]);
        core
    };

    let a = build();
    let b = build();
    assert_eq!(
        state_bytes(&a),
        state_bytes(&b),
        "same log from genesis => byte-identical state (SC#1)"
    );
}

#[test]
fn replay_twice_identical_with_rng_draws() {
    // Same determinism guarantee, but the run draws from the seeded rng every
    // tick so the equality also pins RNG-stream determinism (CORE-05): if the
    // rng were unseeded/ambient, the two runs' rng state would diverge and the
    // snapshot bytes would differ.
    let build = || {
        let (mut core, s, _c) = source_belt_collector(0x1234_5678, 1);
        core.run_log(&[fire(s, 1, 0, Item(vec![0x9]))]).expect("replay within MAX_REPLAY_SPAN");
        for _ in 0..10 {
            advance_drawing_rng(&mut core, &[]);
        }
        core
    };

    let a = build();
    let b = build();
    assert_eq!(
        state_bytes(&a),
        state_bytes(&b),
        "identical log + identical rng draws => identical state (SC#1 + CORE-05)"
    );
}
