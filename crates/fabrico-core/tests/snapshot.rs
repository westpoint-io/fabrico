//! SC#2 — snapshot / restore equivalence (REPLAY-01/02, CORE-09, Pitfall 6/7).
//!
//! A snapshot taken at a clean tick boundary, restored, and advanced N ticks
//! must reach the same state as an uninterrupted run to the same tick. The
//! scenario keeps **belt items in flight** at the snapshot boundary AND draws
//! from the seeded **rng every tick**, so any field left out of the snapshot —
//! belt `in_flight`, the scheduler `wake_wheel`, or the rng counter position —
//! makes the restored continuation diverge and fails the property (catches
//! "hidden in-flight state", RESEARCH Pitfall 6/7).

mod common;

use common::{run_scenario_to, state_bytes, step_scenario};
use fabrico_core::snapshot::{restore, snapshot};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn snapshot_restore_equiv(t in 0u64..50, n in 1u64..50) {
        const SEED: u64 = 0xA5A5_5A5A;
        const LATENCY: u32 = 5; // > 1 so items genuinely sit in flight at T
        let total = t + n;

        // (1) The uninterrupted reference run to T+N.
        let (uninterrupted, _s) = run_scenario_to(SEED, LATENCY, total);

        // (2) Run to T, snapshot at that clean tick boundary, restore into a
        //     fresh Core, then continue it to T+N with the SAME per-tick logic.
        let (at_t, source) = run_scenario_to(SEED, LATENCY, t);
        let snap = snapshot(&at_t);
        let mut restored = restore(&snap).expect("restore valid snapshot");
        prop_assert_eq!(restored.tick, t, "restored resumes at the snapshot tick");

        while restored.tick < total {
            step_scenario(&mut restored, source);
        }

        // (3) The two must be byte-identical — including in-flight belt items
        //     and the advanced rng position.
        prop_assert_eq!(
            state_bytes(&uninterrupted),
            state_bytes(&restored),
            "snapshot+restore+continue == uninterrupted run (SC#2)"
        );
    }
}
