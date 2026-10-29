//! `impl Machine for Tee` — broadcast fan-out to all output ports (ROUTE-02).
//!
//! The tee's plain data (`Tee { outputs }`) lives in [`crate::state`]; this
//! module gives it behavior through the public [`Machine`] trait — exactly the
//! surface a future contributor would implement (API-02).
//!
//! A tee copies each inbound item to ALL output ports `0..outputs` as
//! **independent deep clones**: `Item` is `Item(Vec<u8>)`, so `item.clone()` is a
//! structural deep copy with no shared reference between the output copies
//! (ROUTE-02 / CORE-09; threat T-2-COPY).
//!
//! The fold (`tick.rs`) is unchanged — it already drains the whole outbox in
//! ascending `(port, FIFO)` order and routes each `(port, item)` through `links`
//! with its own `route_seq` (RESEARCH Pitfall 3). The tee only chooses which
//! `push_output` calls to make.
//!
//! # Zero-arity guard (threat T-2-ARITY)
//! A `Tee { outputs: 0 }` has an empty `0..0` range, so the broadcast loop body
//! is skipped: the input is still drained but nothing is emitted, no panic, no
//! unbounded growth.
//!
//! # ONE item per pass (71-03 ruling R-12)
//! A pass takes at most ONE item off input port 0 and re-wakes at `tick + 1`
//! while port 0 still holds a backlog, on [`crate::merge`]'s precedent. This is
//! what makes the fold's PILE-02 gate SUFFICIENT rather than optimistic: the gate
//! proves that ONE item per output port is admissible at every destination this
//! node is docked to, so a pass that emitted more than that could overflow a
//! destination the gate had just cleared, and the surplus would be refused at the
//! generic outbox drain and turn into an `OutputRefused` fault carrying an item
//! the user drew a belt for.

//!
//! # One slow branch does not stop the others (phase 87, JAM-02, 87-CONTEXT D-03, D-04)
//! The fold reads, before the step, what each Out branch can take ([`TeeBranch`]): FREE
//! (its destination accepts one more item), BUSY (it does not) or UNDOCKED (no link). The
//! Tee cannot read that itself: another node's capacity is a cross-node read only the fold
//! may make (CORE-03), so the answer is handed in. A free branch gets its copy at once. An
//! undocked branch gets its copy as it always did, a no-op at the drain. A busy branch's
//! copy is counted on [`Tee::faults`] and leaves on [`FAULT_PORT`] as a
//! [`FaultReason::BranchBusy`](crate::fault::FaultReason::BranchBusy) fault carrying the
//! copy, so the Tee reads FAULTED on that tick and the copy is in the count, never lost
//! without a trace. The Tee is only held back (gated, not stepped) when EVERY docked branch
//! is busy; that rule lives at the fold's call site (`tick.rs` `node_gated`).

use crate::fault::{FAULT_PORT, Fault};
use crate::machine::{Machine, StepCtx};
use crate::state::Tee;

/// What the fold read about ONE Tee output branch before the Tee's step (JAM-02, D-03).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TeeBranch {
    /// No link leaves this Out: it is neither free nor busy, and its copy is a no-op at the
    /// drain, as an emission on an unlinked port always was.
    Undocked,
    /// The branch's destination accepts one more item: the branch takes its copy now.
    Free,
    /// The branch's destination cannot take one more item: the branch does not get this
    /// copy, which is counted and faulted instead.
    Busy,
}

impl Tee {
    /// One pass over `branches`, the per-branch states the fold read for ports
    /// `0..outputs` (a port the slice does not name counts as [`TeeBranch::Free`]).
    ///
    /// Takes ONE item off input port 0; every free or undocked branch gets an independent
    /// deep clone of it, and every busy branch's clone increments [`Tee::faults`]
    /// (saturating) and leaves on [`FAULT_PORT`] as a `BranchBusy` fault naming the branch.
    /// The backlog re-wake is unchanged.
    pub fn step_branches(&mut self, ctx: &mut StepCtx<'_>, branches: &[TeeBranch]) {
        // A zero-arity tee consumes-and-emits-nothing because `0..0` is empty (no `% 0`,
        // no panic).
        if let Some((_seq, item)) = ctx.take_input(0) {
            for port in 0..self.outputs {
                match branches.get(usize::from(port)).copied().unwrap_or(TeeBranch::Free) {
                    TeeBranch::Free | TeeBranch::Undocked => ctx.push_output(port, item.clone()),
                    TeeBranch::Busy => {
                        self.faults = self.faults.saturating_add(1);
                        let fault = Fault::branch_busy(ctx.self_id(), port, item.clone());
                        ctx.push_output(FAULT_PORT, fault.encode());
                    }
                }
            }
        }
        // Re-wake next tick while port 0 still holds a backlog - strictly future,
        // never `schedule_wake(now)` (which `StepCtx` promotes to `wake_now`, a
        // same-tick fixpoint re-entry that would drain faster than one item per
        // pass). A drained tee schedules no wake and sleeps (CORE-07).
        //
        // Gate on the SERVICEABLE port only (port 0), never the whole inbox: an
        // item resting on any other port - or on `FAULT_PORT` - is never drained by
        // the pass above, so testing the whole inbox would re-wake forever while the
        // node never returned to idle (livelock, WR-01).
        if ctx.has_pending_input_on(0) {
            ctx.schedule_wake(ctx.tick() + 1);
        }
    }
}

impl Machine for Tee {
    /// Every branch free: the Tee as the module's own unit tests drive it, with no fold to
    /// read destinations. The fold steps a Tee through [`Tee::step_branches`] with the
    /// states it read.
    fn step(&mut self, ctx: &mut StepCtx<'_>) {
        self.step_branches(ctx, &[]);
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

    /// Drive `tee` over `inputs` on port 0 for as many ONE-ITEM PASSES as it takes
    /// to empty the port, returning every output in pass order.
    ///
    /// Since 71-03 (ruling R-12) a pass consumes exactly ONE item, so this loops
    /// where it used to call `step` once. It asserts the two properties that make
    /// the bound safe rather than merely small: each pass consumes EXACTLY one item,
    /// and a pass that leaves a backlog schedules a re-wake at `tick + 1` (a bounded
    /// pass with no re-wake would strand the rest of the inbox and silently stop the
    /// board).
    fn step_tee(tee: &mut Tee, inputs: &[Item]) -> Vec<(PortId, Item)> {
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
                tee.step(&mut ctx);
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
    fn tee_copies_input_to_all_outputs() {
        // ROUTE-02: one item on port 0 lands on output ports 0, 1, 2 — three
        // independent copies.
        let mut tee = Tee::new(3);
        let out = step_tee(&mut tee, &[Item(vec![0xAB])]);
        assert_eq!(
            out,
            vec![
                (0u16, Item(vec![0xAB])),
                (1u16, Item(vec![0xAB])),
                (2u16, Item(vec![0xAB])),
            ],
            "fans out to exactly `outputs` ports"
        );
    }

    #[test]
    fn tee_copies_are_independent_deep_clones() {
        // CORE-09 / threat T-2-COPY: the broadcast copies share no reference;
        // mutating one drained copy must not affect the others.
        let mut tee = Tee::new(3);
        let mut out = step_tee(&mut tee, &[Item(vec![1, 2, 3])]);
        // Mutate the first copy's bytes.
        out[0].1.0[0] = 0xFF;
        assert_eq!(out[0].1, Item(vec![0xFF, 2, 3]), "copy 0 mutated");
        assert_eq!(out[1].1, Item(vec![1, 2, 3]), "copy 1 untouched (deep clone)");
        assert_eq!(out[2].1, Item(vec![1, 2, 3]), "copy 2 untouched (deep clone)");
    }

    #[test]
    fn tee_zero_outputs_drains_without_panic() {
        // threat T-2-ARITY: a zero-arity tee consumes its input and emits nothing,
        // no panic, no unbounded growth. `step_tee` asserts the port empties, which
        // is the half of this that 71-03's bound could have broken: a bounded pass
        // with no re-wake would leave the second item resting forever.
        let mut tee = Tee::new(0);
        let out = step_tee(&mut tee, &[Item(vec![0x01]), Item(vec![0x02])]);
        assert!(out.is_empty(), "zero-output tee emits nothing");
    }

    #[test]
    fn tee_busy_branch_copy_is_counted_and_faulted() {
        // Phase 87, JAM-02, D-03: with Out 1 busy, Out 0 (free) and Out 2 (undocked) get
        // their copies and Out 1's copy leaves on FAULT_PORT as a BranchBusy fault naming
        // port 1 and carrying the copy, counted once on `Tee.faults`.
        use crate::fault::FaultReason;
        let mut tee = Tee::new(3);
        let id = one_id();
        let mut rng = SimRng::from_seed_u64(1);
        let mut inbox = PortInbox::new();
        inbox.push(0, 0, Item(vec![0x5A]));
        let mut sched = Scheduler::new();
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        {
            let mut ctx =
                StepCtx::new(0, id, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            tee.step_branches(&mut ctx, &[TeeBranch::Free, TeeBranch::Busy, TeeBranch::Undocked]);
        }
        let out = outbox.drain_sorted();
        assert_eq!(tee.faults, 1, "one busy copy, counted once");
        assert_eq!(out.len(), 3, "two copies and one fault: {out:?}");
        assert_eq!(out[0], (0u16, Item(vec![0x5A])), "the free branch got its copy");
        assert_eq!(out[1], (2u16, Item(vec![0x5A])), "the undocked branch got its copy, as before");
        assert_eq!(out[2].0, FAULT_PORT, "the busy copy leaves on the fault port");
        let fault = Fault::decode(&out[2].1).expect("a BranchBusy fault decodes");
        assert_eq!(fault.reason, FaultReason::BranchBusy { branch: 1 });
        assert_eq!(fault.source, id, "the fault names the Tee");
        assert_eq!(fault.payload, vec![0x5A], "the copy rides as the payload");
    }

    #[test]
    fn tee_multiple_inputs_each_fans_out() {
        // Two items on port 0 each produce one copy per output, FIFO preserved.
        //
        // The ORDER changed in 71-03 and the change is the point. Draining the whole
        // port in one pass drained the outbox as `[(0,A),(0,B),(1,A),(1,B)]` - both
        // copies of A and B batched per port. One item per pass drains the outbox
        // once per pass, so it now reads `[(0,A),(1,A)]` then `[(0,B),(1,B)]`: each
        // item is fanned out completely before the next is taken. Every copy is still
        // produced, FIFO within a port is still preserved, and the fold sees exactly
        // one item per output port per pass - which is the quantity the PILE-02 gate
        // cleared.
        let mut tee = Tee::new(2);
        let out = step_tee(&mut tee, &[Item(vec![0xA]), Item(vec![0xB])]);
        assert_eq!(
            out,
            vec![
                (0u16, Item(vec![0xA])),
                (1u16, Item(vec![0xA])),
                (0u16, Item(vec![0xB])),
                (1u16, Item(vec![0xB])),
            ],
            "one item per pass, fanned to every port before the next item is taken"
        );
    }
}
