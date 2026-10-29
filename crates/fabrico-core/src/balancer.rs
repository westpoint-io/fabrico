//! `impl Machine for Balancer` — single-output round-robin (ROUTE-03).
//!
//! # Both catalog In ports are drained (phase 87, JAM-01, D-02, WINDOWS 175)
//! The port catalog gives a Balancer TWO In ports (`DEFAULT_ARITY`), and a belt docked
//! to the second lands on inbox port 1. Until phase 87 only port 0 was ever taken, so a
//! belt on In 1 filled and stopped for good. A pass now scans both Ins round-robin from
//! the input pointer `next_in`, in the shape of `merge.rs`, takes ONE item, sends it to
//! the output pointer `next`, and re-wakes while either In holds a backlog.
//!
//! The balancer's plain data (`Balancer { outputs, next }`) lives in
//! [`crate::state`]; this module gives it behavior through the public
//! [`Machine`] trait (API-02).
//!
//! A balancer sends each inbound item to exactly ONE output port, advancing the
//! round-robin pointer `next` each item — visibly distinct from a tee, which
//! copies to all (ROUTE-03 SC#2). Selection is a **deterministic round-robin**
//! (CONTEXT-locked; least-loaded selection is deferred to v2).
//!
//! # Snapshot-captured selection state (threat T-2-ROT, RESEARCH Pitfall 1)
//! `next` is a field of the `Balancer` Node variant, so the whole-node snapshot
//! captures it: a restore taken mid-rotation resumes the round-robin from the
//! same port, byte-identical to an uninterrupted run. The pointer must never
//! live outside the node (no static/thread-local/Core-level side map), or
//! snapshot/replay diverges — proven by the `balancer_snapshot_restore_equiv`
//! mid-rotation proptest.
//!
//! # Zero-arity guard (threat T-2-ARITY, RESEARCH Pitfall 4)
//! A `Balancer { outputs: 0, .. }` would make `% self.outputs` a division by
//! zero. The `outputs == 0` guard drains the input and returns, emitting nothing
//! — never panics.
//!
//! Since phase 87 the guard drains both Ins, one item per pass.

use crate::machine::{Machine, StepCtx};
use crate::state::Balancer;
use crate::tick::DEFAULT_ARITY;

/// The next catalog In port with an item, scanning `0..DEFAULT_ARITY` round-robin from
/// `next_in`, or `None` when both Ins are empty. Widened to u32 before the modulo so a
/// forged `next_in` near `u16::MAX` cannot overflow (CR-01, threat T-87-05); for a valid
/// pointer the result is byte-identical to the narrow arithmetic.
fn take_round_robin(next_in: u16, ctx: &mut StepCtx<'_>) -> Option<crate::ids::Item> {
    for k in 0..DEFAULT_ARITY {
        let port = ((next_in as u32 + k as u32) % DEFAULT_ARITY as u32) as u16;
        if let Some((_seq, item)) = ctx.take_input(port) {
            return Some(item);
        }
    }
    None
}

/// True while either catalog In holds an item. The SERVICEABLE ports only, never the
/// whole inbox: an item on `FAULT_PORT` or on a port past the catalog Ins is never
/// taken by a pass, so testing the whole inbox would re-wake forever (livelock, WR-01).
fn has_input_backlog(ctx: &StepCtx<'_>) -> bool {
    (0..DEFAULT_ARITY).any(|p| ctx.has_pending_input_on(p))
}

impl Machine for Balancer {
    fn step(&mut self, ctx: &mut StepCtx<'_>) {
        // Zero-arity guard: consume ONE and stop, never `% 0` (threat T-2-ARITY).
        // The DROP here is the pre-existing deliberate one - a balancer with no
        // outputs has nowhere to send an item and has always eaten it - and 71-03
        // does NOT introduce it. What 71-03 changes is only the bound: one item per
        // pass plus a re-wake, so a zero-arity balancer with a full inbox still
        // empties over successive ticks rather than stalling with items resting on
        // port 0 forever.
        // Since phase 87 it eats from EITHER In, round-robin, one item per pass.
        if self.outputs == 0 {
            let _ = take_round_robin(self.next_in, ctx);
            self.next_in = ((self.next_in as u32 + 1) % DEFAULT_ARITY as u32) as u16;
            if has_input_backlog(ctx) {
                ctx.schedule_wake(ctx.tick() + 1);
            }
            return;
        }
        // Round-robin: ONE item per pass to exactly one output, advancing `next`
        // (71-03 ruling R-12). Pure integer arithmetic, captured by the whole-node
        // snapshot (T-2-ROT).
        //
        // D-02 (phase 87, JAM-01, WINDOWS 175): the pass scans BOTH catalog Ins
        // (`0..DEFAULT_ARITY`) from the input pointer `next_in`, which is separate from
        // the output pointer `next`; reusing `next` would lock each In to one Out.
        if let Some(item) = take_round_robin(self.next_in, ctx) {
            ctx.push_output(self.next, item);
            // Widen to u32 before the modulo so `next + 1` is overflow-proof even
            // for a crafted snapshot with `next == u16::MAX` (mirrors the merge
            // fix for CR-01). The result is `< outputs <= u16::MAX`, so the cast
            // back to u16 is lossless and byte-identical for valid rotation state.
            self.next = ((self.next as u32 + 1) % self.outputs as u32) as u16;
        }
        // Rotate the input start once per pass, as `merge.rs` rotates its pointer
        // (snapshot-captured, T-2-ROT), widened the same way.
        self.next_in = ((self.next_in as u32 + 1) % DEFAULT_ARITY as u32) as u16;
        // Re-wake next tick while either In still holds a backlog - strictly future,
        // never `schedule_wake(now)`. Gate on the SERVICEABLE ports only, never the
        // whole inbox (`has_input_backlog`, WR-01).
        if has_input_backlog(ctx) {
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

    /// Drive `bal` for a single tick with `inputs` on port 0, returning the
    /// outputs drained from the outbox (ascending port, FIFO within port). The
    /// caller keeps `bal` so it can inspect the advanced `next` pointer.
    /// Drive `bal` over `inputs` on port 0 for as many ONE-ITEM PASSES as it takes
    /// to empty the port, returning every output in pass order.
    ///
    /// Since 71-03 (ruling R-12) a pass consumes exactly ONE item, so this loops
    /// where it used to call `step` once. It asserts both halves of what makes the
    /// bound safe: a pass consumes exactly one item, and a pass leaving a backlog
    /// schedules a re-wake at `tick + 1` - including in the ZERO-ARITY arm, where a
    /// missing re-wake would leave the rest of the inbox resting forever.
    fn step_balancer(bal: &mut Balancer, inputs: &[Item]) -> Vec<(PortId, Item)> {
        let id = one_id();
        let mut rng = SimRng::from_seed_u64(1);
        let mut inbox = PortInbox::new();
        for (i, item) in inputs.iter().enumerate() {
            inbox.push(0, i as u64, item.clone());
        }
        let mut all: Vec<(PortId, Item)> = Vec::new();
        let mut tick = 0u64;
        while !inbox.is_empty() {
            let before = inbox.len_on(0);
            let mut sched = Scheduler::new();
            let mut outbox = PortOutbox::new();
            let mut commands: Vec<Command> = Vec::new();
            {
                let mut ctx = StepCtx::new(
                    tick,
                    id,
                    &mut inbox,
                    &mut outbox,
                    &mut commands,
                    &mut sched,
                    &mut rng,
                );
                bal.step(&mut ctx);
            }
            assert_eq!(
                inbox.len_on(0),
                before - 1,
                "one item per pass, never the whole port (R-12)"
            );
            assert_eq!(
                sched.active_count_at(tick + 1),
                usize::from(!inbox.is_empty()),
                "a pass leaving a backlog re-wakes at tick+1 and a drained one sleeps"
            );
            all.extend(outbox.drain_sorted());
            tick += 1;
        }
        all
    }

    #[test]
    fn balancer_sends_each_item_to_one_output_round_robin() {
        // ROUTE-03: 6 items across 3 outputs go 0,1,2,0,1,2 — one item per output
        // per cycle. Item k still lands on port k%3; what 71-03 changed is only that
        // each item is taken on its OWN pass, so `drain_sorted` runs once per item
        // and the accumulated order is emission order rather than port-grouped.
        let mut bal = Balancer::new(3);
        let items: Vec<Item> = (0u8..6).map(|b| Item(vec![b])).collect();
        let out = step_balancer(&mut bal, &items);
        assert_eq!(
            out,
            vec![
                (0u16, Item(vec![0])), // cycle 1
                (1u16, Item(vec![1])),
                (2u16, Item(vec![2])),
                (0u16, Item(vec![3])), // cycle 2
                (1u16, Item(vec![4])),
                (2u16, Item(vec![5])),
            ],
            "each item to exactly one output, advancing round-robin"
        );
        assert_eq!(bal.next, 0, "two full cycles leave the pointer back at 0");
    }

    #[test]
    fn balancer_pointer_advances_mid_cycle() {
        // 4 items across 3 outputs leaves the pointer mid-rotation (next == 1).
        let mut bal = Balancer::new(3);
        let items: Vec<Item> = (0u8..4).map(|b| Item(vec![b])).collect();
        let _ = step_balancer(&mut bal, &items);
        assert_eq!(bal.next, 1, "4 % 3 == 1: pointer mid-cycle");
    }

    #[test]
    fn balancer_zero_outputs_drains_without_panic() {
        // threat T-2-ARITY: a zero-arity balancer consumes its input one item per
        // pass, emits nothing, and never does `% 0`. `step_balancer` asserts the port
        // empties and that each pass re-wakes while a backlog remains, which is the
        // half 71-03's bound could have broken in this arm specifically.
        let mut bal = Balancer::new(0);
        let out = step_balancer(&mut bal, &[Item(vec![0x01]), Item(vec![0x02])]);
        assert!(out.is_empty(), "zero-output balancer emits nothing");
        assert_eq!(bal.next, 0, "pointer untouched");
    }

    /// Drive `bal` with `in0` on In 0 and `in1` on In 1, one pass per tick, for at most
    /// `max_passes` passes or until both Ins are empty. Returns every output in pass
    /// order. Asserts on every pass that exactly ONE item left the two Ins together (the
    /// R-12 bound, now over both catalog Ins) and that the pass re-wakes at `tick + 1`
    /// exactly when either In still holds a backlog.
    fn step_two_inputs(
        bal: &mut Balancer,
        in0: &[Item],
        in1: &[Item],
        max_passes: u64,
    ) -> (Vec<(PortId, Item)>, usize, usize) {
        let id = one_id();
        let mut rng = SimRng::from_seed_u64(1);
        let mut inbox = PortInbox::new();
        let mut seq = 0u64;
        for item in in0 {
            inbox.push(0, seq, item.clone());
            seq += 1;
        }
        for item in in1 {
            inbox.push(1, seq, item.clone());
            seq += 1;
        }
        let mut all: Vec<(PortId, Item)> = Vec::new();
        let mut tick = 0u64;
        while !inbox.is_empty() && tick < max_passes {
            let before = inbox.len_on(0) + inbox.len_on(1);
            let mut sched = Scheduler::new();
            let mut outbox = PortOutbox::new();
            let mut commands: Vec<Command> = Vec::new();
            {
                let mut ctx = StepCtx::new(
                    tick,
                    id,
                    &mut inbox,
                    &mut outbox,
                    &mut commands,
                    &mut sched,
                    &mut rng,
                );
                bal.step(&mut ctx);
            }
            let after = inbox.len_on(0) + inbox.len_on(1);
            assert_eq!(after + 1, before, "one item per pass across both Ins (R-12)");
            assert_eq!(
                sched.active_count_at(tick + 1),
                usize::from(!inbox.is_empty()),
                "a pass re-wakes at tick+1 while either In holds a backlog, and only then"
            );
            all.extend(outbox.drain_sorted());
            tick += 1;
        }
        (all, inbox.len_on(0), inbox.len_on(1))
    }

    #[test]
    fn balancer_alternates_inputs_when_both_are_fed() {
        // JAM-01 (WINDOWS 175, D-02): with both catalog Ins fed, the Balancer takes from
        // In 0 and In 1 in turn, and the Outs still alternate. Items are tagged by the In
        // they arrived on (0xA_ on In 0, 0xB_ on In 1), so the order out names the order
        // taken. Before the fix In 1 was never drained and the run left it full.
        let mut bal = Balancer::new(2);
        let a: Vec<Item> = (0u8..3).map(|i| Item(vec![0xA0 + i])).collect();
        let b: Vec<Item> = (0u8..3).map(|i| Item(vec![0xB0 + i])).collect();
        let (out, left0, left1) = step_two_inputs(&mut bal, &a, &b, 12);
        assert_eq!((left0, left1), (0, 0), "both Ins drain");
        assert_eq!(
            out,
            vec![
                (0u16, Item(vec![0xA0])),
                (1u16, Item(vec![0xB0])),
                (0u16, Item(vec![0xA1])),
                (1u16, Item(vec![0xB1])),
                (0u16, Item(vec![0xA2])),
                (1u16, Item(vec![0xB2])),
            ],
            "the Ins are taken in turn and the Outs alternate"
        );
        assert_eq!((bal.next, bal.next_in), (0, 0), "six passes leave both pointers at 0");
    }

    #[test]
    fn zero_output_balancer_drains_both_inputs() {
        // T-2-ARITY over both Ins: a zero-output Balancer eats one item per pass from
        // either In and stops re-waking once both are empty (`step_two_inputs` asserts
        // the re-wake on every pass). Before the fix the guard drained In 0 only.
        let mut bal = Balancer::new(0);
        let a = [Item(vec![0x01]), Item(vec![0x02])];
        let b = [Item(vec![0x03]), Item(vec![0x04])];
        let (out, left0, left1) = step_two_inputs(&mut bal, &a, &b, 10);
        assert!(out.is_empty(), "a zero-output balancer emits nothing");
        assert_eq!((left0, left1), (0, 0), "both Ins drain");
        assert_eq!(bal.next, 0, "the output pointer is untouched");
    }

    #[test]
    fn balancer_rotation_pointer_at_u16_max_does_not_overflow() {
        // Regression for the CR-01 overflow class (security audit WARN-01), mirroring
        // the merge fix: a crafted or restored snapshot can place `next` at u16::MAX.
        // Advancing it must widen to u32 before the modulo — `(u16::MAX + 1)` would
        // otherwise panic on arithmetic overflow in debug builds (a panic of the
        // deterministic core reachable from decoded bytes) or wrap to a wrong port in
        // release, diverging replay.
        let mut bal = Balancer::new(3);
        bal.next = u16::MAX; // pointer at the overflow boundary
        let out = step_balancer(&mut bal, &[Item(vec![0xAB])]);
        // The item is emitted to the current pointer port before rotating.
        assert_eq!(out, vec![(u16::MAX, Item(vec![0xAB]))]);
        // (65535 + 1) % 3 == 65536 % 3 == 1 — wrapped via u32, no overflow.
        assert_eq!(bal.next, 1, "pointer wraps via u32-widened modulo, no overflow");
    }
}
