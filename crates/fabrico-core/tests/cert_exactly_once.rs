//! Certification criterion 5 — mock-executor exactly-once, REPLAY-03 (forward
//! model for Phase-5 EXEC-04).
//!
//! Proves that replaying a deterministically-derived command stream performs
//! exactly ONE logical side effect per distinct [`CommandId`], even when the
//! stream is dispatched multiple times (a muted-on-replay double run) and even
//! when an id is duplicated WITHIN a single pass. This is the T-3-DUP mitigation:
//! a replayed/duplicated command must never double-perform its effect.
//!
//! # Why a synthesized stream (RESEARCH Pitfall 5 / Assumption A3)
//! No built-in `Node` variant emits a `Command` in Phase 1 (the executor is
//! muted), and the `Node` enum is closed to integration tests — so we cannot make
//! a built-in topology emit commands through the fold. Instead we synthesize the
//! stream from logged data: each command's `id: CommandId = (tick, NodeId, seq)`
//! is derived deterministically, exactly as Phase 5's real emission will derive
//! it from the log. The proof exercises precisely what criterion 5 and EXEC-04
//! care about — the ledger's exactly-once / idempotency semantics — using the
//! REAL `fabrico_core::command::{Command, Dispatch}` and `CommandId` types.

use fabrico_core::command::{Command, Dispatch, Effect, EVENT_VERSION};
use fabrico_core::ids::{CommandId, NodeId};
use proptest::prelude::*;
use slotmap::SlotMap;
use std::collections::BTreeMap;

/// A minimal in-repo mock executor: the deterministic idempotency ledger keyed on
/// `CommandId`. Uses `BTreeMap` ONLY (never `HashMap` — the crate-wide clippy gate
/// denies it so non-deterministic iteration cannot enter the cert suite, T-3-MAP).
#[derive(Default)]
struct MockExecutor {
    /// Times each id was handed to `dispatch` (duplicates included).
    seen: BTreeMap<CommandId, u32>,
    /// Times the logical side effect actually fired for each id (must end at 1).
    performed: BTreeMap<CommandId, u32>,
}

impl MockExecutor {
    /// Every distinct id that has been dispatched performed its effect exactly once.
    fn all_performed_once(&self) -> bool {
        self.performed.values().all(|&c| c == 1)
    }
}

impl Dispatch for MockExecutor {
    fn dispatch(&mut self, cmd: &Command) {
        let seen = self.seen.entry(cmd.id).or_insert(0);
        *seen += 1;
        // Exactly-once: perform the (mock) logical side effect ONLY on the first
        // sighting of this id; every later sighting (intra-pass duplicate or a
        // whole-stream replay) is suppressed.
        if *seen == 1 {
            *self.performed.entry(cmd.id).or_insert(0) += 1;
        }
    }
}

/// Synthesize one command with a deterministic idempotency key `(tick, node, seq)`.
fn cmd(tick: u64, node: NodeId, seq: u32) -> Command {
    Command {
        event_version: EVENT_VERSION,
        id: (tick, node, seq),
        partition: 0,
        effect: Effect::Noop,
        deadline: tick + 100,
    }
}

/// Mint `m` real generational `NodeId`s (key-minting only — never iterate a
/// `SlotMap` for order-observed logic; see `ids.rs`).
fn mint_nodes(m: usize) -> Vec<NodeId> {
    let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
    (0..m).map(|_| alloc.insert(())).collect()
}

proptest! {
    // Honor PROPTEST_CASES (CI sets 1024); `ProptestConfig::default()` reads the env
    // and defaults to 256 cases locally. `with_cases(256)` hardcoded `cases`, which
    // overwrote the env-derived value, so the env var was dead (WR-01).
    #![proptest_config(ProptestConfig::default())]

    /// An R-fold replay of a synthesized stream performs each distinct command's
    /// effect exactly once; duplicates within a single pass are suppressed too
    /// (criterion 5 / REPLAY-03 / T-3-DUP).
    #[test]
    fn exactly_once_across_replay(
        n_distinct in 1usize..=16,
        repeats in 2u32..=4,
        extra_dups in 0usize..=4,
    ) {
        // Mint a small node set and derive `n_distinct` DISTINCT command ids
        // (distinct `seq` => distinct id), spread deterministically across nodes
        // and ticks so the key varies in all three components.
        let nodes = mint_nodes(4);
        let distinct: Vec<Command> = (0..n_distinct)
            .map(|i| cmd(i as u64, nodes[i % nodes.len()], i as u32))
            .collect();

        // One pass = the distinct set plus `extra_dups` repeats of the FIRST
        // command, so a single pass already contains a duplicate id (intra-pass
        // idempotency must hold even before any replay).
        let mut pass = distinct.clone();
        for _ in 0..extra_dups {
            pass.push(distinct[0].clone());
        }

        // Dispatch the SAME pass `repeats` times into the SAME executor (the
        // muted-on-replay double-run model).
        let mut exec = MockExecutor::default();
        for _ in 0..repeats {
            for c in &pass {
                exec.dispatch(c);
            }
        }

        // Every distinct id performed its effect exactly once across the whole
        // R-fold replay — the second and later passes add ZERO logical effects.
        prop_assert!(exec.all_performed_once(), "every distinct CommandId performs exactly once");
        prop_assert_eq!(
            exec.performed.len(),
            n_distinct,
            "exactly the distinct ids performed an effect"
        );

        // The ledger SAW the duplicates: the first id appears `1 + extra_dups`
        // times per pass over `repeats` passes; every other id once per pass.
        let first_id = distinct[0].id;
        let first_per_pass = 1 + extra_dups as u32;
        prop_assert_eq!(
            exec.seen[&first_id],
            first_per_pass * repeats,
            "ledger counts every duplicate sighting of the first id"
        );
        for c in distinct.iter().skip(1) {
            prop_assert_eq!(
                exec.seen[&c.id],
                repeats,
                "each non-duplicated id is seen once per pass"
            );
        }
    }
}

/// Readable anchor: a hand-built 3-command stream double-dispatched yields exactly
/// one performed effect per distinct id and the expected `seen` counts.
#[test]
fn exactly_once_three_command_anchor() {
    let nodes = mint_nodes(2);
    // c0 and c2 are distinct ids; c1 duplicates c0's id WITHIN the pass.
    let c0 = cmd(0, nodes[0], 0);
    let c1 = cmd(0, nodes[0], 0); // same id as c0 (intra-pass duplicate)
    let c2 = cmd(1, nodes[1], 1);
    let pass = [c0.clone(), c1, c2.clone()];

    let mut exec = MockExecutor::default();
    // Double dispatch (replay once).
    for _ in 0..2 {
        for c in &pass {
            exec.dispatch(c);
        }
    }

    // Two distinct ids, each performed exactly once.
    assert!(exec.all_performed_once(), "each distinct id performs exactly once");
    assert_eq!(exec.performed.len(), 2, "two distinct ids => two effects");
    assert_eq!(exec.performed[&c0.id], 1, "c0's effect fired once despite 4 sightings");
    assert_eq!(exec.performed[&c2.id], 1, "c2's effect fired once despite 2 sightings");

    // seen: c0's id appears twice per pass over two passes = 4; c2's id once per
    // pass over two passes = 2.
    assert_eq!(exec.seen[&c0.id], 4, "c0 id seen 4 times (2/pass x 2 passes)");
    assert_eq!(exec.seen[&c2.id], 2, "c2 id seen 2 times (1/pass x 2 passes)");
}
