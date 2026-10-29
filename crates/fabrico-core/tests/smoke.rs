//! Smoke test — exercises the integration-test pipeline so `cargo test
//! -p fabrico-core` confirms the `proptest` dev-dependency resolves and builds.
//! Real determinism property tests (SC#1/SC#2) arrive in later plans.

#[test]
fn pipeline_runs() {
    // A trivial assertion: the test harness, the crate, and the dev-deps all
    // compile and link. This is the green-pipeline canary for plan 01-01.
    assert_eq!(2 + 2, 4);
}
