//! SC#3 — active-set flat cost (CORE-07).
//!
//! An idle tick steps **zero** machines, and the per-tick active count is
//! independent of the total machine count: 10 idle machines and 10 000 idle
//! machines both report 0 would-step on an idle tick (no full-grid scan). With
//! exactly one woken node among many idle ones the count is 1 — cost tracks the
//! active set, not the grid size. An idle tick also leaves the grid unchanged.

mod common;

use common::{grid_state_bytes, header};
use fabrico_core::core::Core;

#[test]
fn active_set_idle_flat() {
    // Idle active-count is 0 regardless of total machine count (10 vs 10 000).
    for n in [10usize, 10_000] {
        let mut core = Core::genesis(header(1));
        for _ in 0..n {
            core.state.add_source();
        }
        assert_eq!(
            core.sched.active_count_at(core.tick),
            0,
            "idle tick steps zero machines for {n} machines (no full-grid scan)"
        );
    }

    // Exactly one woken node among many idle ones => active count is 1.
    let mut core = Core::genesis(header(2));
    let mut ids = Vec::new();
    for _ in 0..1_000 {
        ids.push(core.state.add_source());
    }
    core.sched.wake_now(ids[500]);
    assert_eq!(
        core.sched.active_count_at(core.tick),
        1,
        "cost tracks the active set, not the grid size"
    );

    // An idle tick leaves the grid-state projection unchanged (logical time
    // still advances, but no node is stepped).
    let mut idle = Core::genesis(header(3));
    for _ in 0..10 {
        idle.state.add_source();
    }
    let before = grid_state_bytes(&idle);
    assert_eq!(idle.sched.active_count_at(idle.tick), 0, "nothing woken");
    idle.advance(&[]);
    let after = grid_state_bytes(&idle);
    assert_eq!(before, after, "an idle tick leaves grid state unchanged");
}
