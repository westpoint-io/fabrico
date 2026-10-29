//! `impl Machine for Merge` — the merge / funnel operator (ROUTE-05).
//!
//! The merge's plain data (`Merge { inputs, next }`) lives in [`crate::state`];
//! this module gives it behavior through the public [`Machine`] trait (API-02).
//!
//! A merge combines N input belts into ONE output (always port 0): every inbound
//! item from any of its `inputs` ports passes through to output port 0 (CONTEXT
//! "Merge = funnel", NOT a wait-for-all join — that is deferred to v2).
//!
//! # Deterministic join order (ROUTE-05, RESEARCH Pattern 4)
//! When several inputs have items ready, a single `step` makes ONE round-robin
//! **pass**: starting at `next`, it scans input ports in `next, next+1, …` order
//! and takes ONE item TOTAL from the first non-empty one, funnelling it to output
//! port 0. Within a port the existing inbox FIFO + the per-tick `route_seq`
//! cross-port tie-break (WR-03) are inherited, no new tie-break scheme. After the
//! pass `next` rotates by one so the start port advances each pass (fairness: no
//! input is starved by a busy neighbour). The merged output order is therefore
//! round-robin(port)-then-FIFO, reproducible on replay.
//!
//! **One item TOTAL is a 71-03 change (ruling R-12), and the pass used to take one
//! item PER INPUT.** The fold's PILE-02 gate proves that one item is admissible on
//! each destination a node is docked to, and a merge has exactly one output, so a
//! pass emitting `inputs` items onto port 0 could overflow a destination the gate
//! had just cleared. The rotation is what keeps it fair across ticks.
//!
//! # Snapshot-captured selection state (threat T-2-ROT-MERGE, RESEARCH Pitfall 1)
//! `next` is a field of the `Merge` Node variant, so the whole-node snapshot
//! captures it: a restore taken mid-rotation resumes the funnel from the same
//! start port, byte-identical to an uninterrupted run. It must never live outside
//! the node — proven by the `merge_snapshot_restore_equiv` mid-rotation proptest.
//!
//! # Bounded per-tick work + re-wake (threat T-2-SPIN, RESEARCH Pitfall 5)
//! Each step drains at most one item in total (a single pass), so a
//! flooded merge cannot do unbounded work in one tick. While ANY input still
//! holds a backlog after the pass, the merge re-wakes itself at **`tick + 1`** —
//! a strictly-future tick routed through the wake wheel, giving exactly one pass
//! per tick. It must NOT use `schedule_wake(now)`, which is promoted to `wake_now`
//! (same-tick fixpoint re-entry) and would drain faster than one item per pass,
//! risking the `node_count + 1` fixpoint cap. A fully drained merge schedules
//! no wake and sleeps (CORE-07).
//!
//! # Zero-arity guard (threat T-2-ARITY-M, RESEARCH Pitfall 4)
//! A `Merge { inputs: 0, .. }` would make `% self.inputs` a division by zero. The
//! `inputs == 0` guard returns immediately — never panics, never `% 0`.

use crate::machine::{Machine, StepCtx};
use crate::state::Merge;

impl Machine for Merge {
    fn step(&mut self, ctx: &mut StepCtx<'_>) {
        // Zero-arity guard: no inputs to funnel, never `% 0` (threat T-2-ARITY-M).
        if self.inputs == 0 {
            return;
        }
        // One round-robin PASS: ONE item TOTAL, taken from the FIRST non-empty
        // serviceable port starting at `next`, funnelled to the single output port 0.
        // `take_input` on an empty port is a no-op, so absent inputs are simply
        // skipped and the scan moves on.
        //
        // ONE TOTAL, NOT ONE PER PORT (71-03 ruling R-12, and this is the conversion
        // that surprises). The fold's PILE-02 gate proves that ONE item is admissible
        // on each destination this node is docked to, and a merge has exactly ONE
        // output. A pass taking one item PER INPUT would push up to `inputs` items
        // onto output port 0 against a gate that cleared one, and the surplus would be
        // refused at the generic outbox drain as an `OutputRefused` fault.
        //
        // It is not a throughput regression, and that was measured rather than argued:
        // a belt admits at most one inbox item per tick and only when its tail is free,
        // so the sustained intake below any machine is one item per `ticks_per_slot`
        // ticks, which is 2 on the shipped default. A machine emitting one item per
        // tick is already running at twice what the belt under it can take.
        for k in 0..self.inputs {
            // Widen to u32 before the modulo so `next + k` (which peaks at
            // 2*(inputs-1) and exceeds u16::MAX once inputs > 32768) cannot
            // overflow the u16 port space: a debug-build panic of the
            // deterministic core reachable from decoded bytes, and a wrapped
            // (wrong-port) route in release. Upper-bound twin of the zero-arity
            // guard (threat T-2-ARITY-M, CR-01). For valid arities the widened
            // result is byte-identical to the narrow arithmetic.
            let port = ((self.next as u32 + k as u32) % self.inputs as u32) as u16;
            if let Some((_seq, item)) = ctx.take_input(port) {
                ctx.push_output(0, item);
                break;
            }
        }
        // Rotate the start port for fairness (snapshot-captured; T-2-ROT-MERGE).
        // Widened identically so `next + 1` is overflow-proof and consistent.
        self.next = ((self.next as u32 + 1) % self.inputs as u32) as u16;
        // Re-wake next tick while an IN-RANGE backlog remains — strictly-future
        // (NOT now) so it drains exactly one pass per tick (threat T-2-SPIN). A
        // drained merge sleeps (CORE-07).
        //
        // Gate on the serviceable ports `0..inputs` only, NOT the whole inbox: an
        // item resting on an out-of-range port (`>= inputs`, or `FAULT_PORT`) is
        // never drained by the pass above, so testing the whole inbox would
        // re-wake forever (livelock) while never returning to idle (WR-01).
        let in_range_backlog = (0..self.inputs).any(|p| ctx.has_pending_input_on(p));
        if in_range_backlog {
            ctx.schedule_wake(ctx.tick() + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::Command;
    use crate::ids::{Item, NodeId, PortId};
    use crate::rng::SimRng;
    use crate::scheduler::Scheduler;
    use crate::state::{PortInbox, PortOutbox};
    use slotmap::SlotMap;

    /// Mint one real generational `NodeId`.
    fn one_id() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    /// Drive `merge` for a single tick at `tick`, draining its outbox. The
    /// `inbox`/`sched` are passed by reference so they PERSIST across calls — the
    /// caller can queue items on several input ports, step repeatedly, and inspect
    /// the scheduler for the tick+1 re-wake.
    fn step_merge(
        merge: &mut Merge,
        id: NodeId,
        inbox: &mut PortInbox,
        tick: u64,
        sched: &mut Scheduler,
        rng: &mut SimRng,
    ) -> Vec<(PortId, Item)> {
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        {
            let mut ctx = StepCtx::new(tick, id, inbox, &mut outbox, &mut commands, sched, rng);
            merge.step(&mut ctx);
        }
        outbox.drain_sorted()
    }

    #[test]
    fn merge_funnels_all_inputs_to_port_zero() {
        // ROUTE-05: one item on each of input ports 0,1,2 all funnel to output port
        // 0 in round-robin(port) order - across THREE passes, not one.
        //
        // 71-03 (ruling R-12) made the pass take ONE item TOTAL rather than one per
        // input. The funnelling property and the round-robin order are unchanged and
        // are what this test is for; the pass count is what moved. The rotation is
        // what makes three single-item passes visit all three ports.
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut merge = Merge::new(3);
        let mut inbox = PortInbox::new();
        inbox.push(0, 1, Item(vec![0xA0]));
        inbox.push(1, 2, Item(vec![0xB1]));
        inbox.push(2, 3, Item(vec![0xC2]));

        let mut merged: Vec<(PortId, Item)> = Vec::new();
        for tick in 0..3 {
            merged.extend(step_merge(&mut merge, id, &mut inbox, tick, &mut sched, &mut rng));
        }
        assert_eq!(
            merged,
            vec![
                (0u16, Item(vec![0xA0])), // pass 1 starts at port 0 (next=0)
                (0u16, Item(vec![0xB1])), // pass 2 starts at port 1
                (0u16, Item(vec![0xC2])), // pass 3 starts at port 2
            ],
            "every input funnels to output port 0 in round-robin(port) order"
        );
        assert!(inbox.is_empty(), "all three inputs consumed over three passes");
        assert_eq!(merge.next, 0, "three rotations on three inputs return to 0");
    }

    #[test]
    fn merge_round_robin_order_then_fifo() {
        // Two items queued on each of two input ports. The merged order is
        // round-robin across ports then FIFO within a port, with the start port
        // rotating each pass. Since 71-03 a pass takes ONE item TOTAL, so four items
        // take FOUR passes:
        //   port0 = [a0, a1], port1 = [b0, b1]
        //   pass 1 (start 0): a0     pass 2 (start 1): b0
        //   pass 3 (start 0): a1     pass 4 (start 1): b1
        //   merged: a0, b0, a1, b1
        // The property under test - round-robin across ports, FIFO within a port -
        // is unchanged; only the number of passes it takes moved.
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut merge = Merge::new(2);
        let mut inbox = PortInbox::new();
        inbox.push(0, 1, Item(vec![0xA0]));
        inbox.push(0, 2, Item(vec![0xA1]));
        inbox.push(1, 3, Item(vec![0xB0]));
        inbox.push(1, 4, Item(vec![0xB1]));

        let mut merged: Vec<Item> = Vec::new();

        // Pass 1 at tick 10: starts at port 0, takes ONE item.
        let out = step_merge(&mut merge, id, &mut inbox, 10, &mut sched, &mut rng);
        assert_eq!(
            out,
            vec![(0u16, Item(vec![0xA0]))],
            "pass 1 starts at port 0 and takes ONE item: a0"
        );
        merged.extend(out.into_iter().map(|(_p, it)| it));
        assert_eq!(merge.next, 1, "start port rotated to 1");
        // Backlog remains => re-wake at tick+1 = 11.
        assert_eq!(sched.active_count_at(11), 1, "re-wake scheduled at tick+1");

        for (tick, expected) in [
            (11u64, Item(vec![0xB0])),
            (12, Item(vec![0xA1])),
            (13, Item(vec![0xB1])),
        ] {
            let out = step_merge(&mut merge, id, &mut inbox, tick, &mut sched, &mut rng);
            assert_eq!(
                out,
                vec![(0u16, expected.clone())],
                "pass at tick {tick} takes exactly one item"
            );
            merged.extend(out.into_iter().map(|(_p, it)| it));
        }
        assert!(inbox.is_empty(), "all four items drained after four passes");

        assert_eq!(
            merged,
            vec![
                Item(vec![0xA0]),
                Item(vec![0xB0]),
                Item(vec![0xA1]),
                Item(vec![0xB1]),
            ],
            "merged order is round-robin(port)-then-FIFO with rotating start"
        );
    }

    #[test]
    fn merge_one_item_per_input_per_step_and_rewakes() {
        // port0 = [a0, a1] (backlog), port1 = [b0]. Since 71-03 a single pass takes
        // ONE item TOTAL from the first non-empty serviceable port starting at
        // `next` (a0), leaving a1 AND b0, and re-wakes at tick+1.
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut merge = Merge::new(2);
        let mut inbox = PortInbox::new();
        inbox.push(0, 1, Item(vec![0xA0]));
        inbox.push(0, 2, Item(vec![0xA1]));
        inbox.push(1, 3, Item(vec![0xB0]));

        // Pass 1 at tick 10: ONE item total, from port 0 (next=0).
        let out = step_merge(&mut merge, id, &mut inbox, 10, &mut sched, &mut rng);
        assert_eq!(
            out,
            vec![(0u16, Item(vec![0xA0]))],
            "exactly ONE item in a single step, from the first non-empty port"
        );
        // a1 and b0 still queued => backlog remains.
        assert_eq!(inbox.len_on(0), 1, "the second port-0 item was NOT taken");
        assert_eq!(inbox.len_on(1), 1, "and port 1 was not serviced this pass either");
        assert_eq!(
            sched.active_count_at(11),
            1,
            "backlog => re-wake at tick+1 (strictly future, not same-tick)"
        );

        // Mirror the fold: promote the due tick-11 wake into the active set and
        // drain it, so the wheel is clean going into pass 2 (the fold's
        // `take_due` + `drain_active_sorted` happen before `step_node`).
        assert_eq!(sched.take_due(11), 1, "the re-wake promotes at tick 11");
        assert_eq!(sched.drain_active_sorted(), vec![id], "re-wake targets the merge");
        assert_eq!(sched.pending_wakes(), 0, "wheel clean before pass 2");

        // Pass 2 at tick 11 (next=1): the scan starts at port 1 and takes b0.
        let out = step_merge(&mut merge, id, &mut inbox, 11, &mut sched, &mut rng);
        assert_eq!(out, vec![(0u16, Item(vec![0xB0]))], "the rotation moved the start port");
        assert_eq!(sched.active_count_at(12), 1, "a1 still queued => re-wake at tick+1");

        // Mirror the fold again for pass 3.
        assert_eq!(sched.take_due(12), 1, "the re-wake promotes at tick 12");
        assert_eq!(sched.drain_active_sorted(), vec![id], "re-wake targets the merge");

        // Pass 3 at tick 12 (next=0): port 0 yields a1; now drained.
        let out = step_merge(&mut merge, id, &mut inbox, 12, &mut sched, &mut rng);
        assert_eq!(out, vec![(0u16, Item(vec![0xA1]))], "remaining backlog item drained");
        assert!(inbox.is_empty(), "merge fully drained");
        assert_eq!(
            sched.pending_wakes(),
            0,
            "a drained merge schedules no further wake (sleeps, CORE-07)"
        );
    }

    #[test]
    fn merge_zero_inputs_no_panic() {
        // threat T-2-ARITY-M: a zero-input merge steps to a no-op — never `% 0`,
        // never panics, emits nothing.
        let id = one_id();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut merge = Merge::new(0);
        let mut inbox = PortInbox::new();
        // Even with a stray item present, the guard returns before any `%`.
        inbox.push(0, 1, Item(vec![0xFF]));

        let out = step_merge(&mut merge, id, &mut inbox, 0, &mut sched, &mut rng);
        assert!(out.is_empty(), "zero-input merge emits nothing");
        assert_eq!(merge.next, 0, "pointer untouched");
        assert_eq!(sched.pending_wakes(), 0, "no re-wake scheduled");
    }
}
