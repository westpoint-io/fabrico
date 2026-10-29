//! The public `Machine` trait and the single `StepCtx` capability object.
//!
//! This is the contract every built-in (plan 05) and every future operator,
//! factory, or sink (Phases 2/4/5) plugs into. It is also the **structural
//! enforcement point for the golden rule** (CORE-03): a machine reaches the
//! world ONLY through [`StepCtx`], and [`StepCtx`] exposes only the tick number,
//! its input/output ports, an `emit` for command intent, a `schedule_wake`, and
//! the seeded [`SimRng`]. There is no method to read a wall clock, touch the
//! filesystem, or do network IO — so a machine *literally cannot* reach ambient
//! authority. The crate-wide clippy `disallowed-types`/`disallowed-methods` gate
//! (see `clippy.toml`) plus `#![forbid(unsafe_code)]` back this at build time
//! (threat T-1-DET, SC#5).
//!
//! Snapshotting is handled by whole-node serde (plan 04's `GridState` derives
//! `serde`), so the trait carries only `step` — no per-machine
//! `snapshot`/`restore`, which would force a `typetag`-style registry.

use crate::command::Command;
use crate::ids::{Item, NodeId, PortId};
use crate::rng::SimRng;
use crate::scheduler::Scheduler;
use crate::state::{PortInbox, PortOutbox};

/// A machine on the grid. Built-ins (belt, manual-inject) and all future
/// operators/factories/sinks implement this single trait (API-01/02/04).
///
/// `step` is called once per tick **while the machine is in the active set**
/// (the scheduler never steps an idle machine — CORE-07). The machine mutates
/// only what it can reach through `ctx`.
pub trait Machine {
    /// Advance this machine by one tick using only the [`StepCtx`] capability.
    fn step(&mut self, ctx: &mut StepCtx<'_>);
}

/// The single capability object handed to [`Machine::step`] — the ONLY authority
/// surface a machine can touch (RESEARCH Pattern 4, CORE-03).
///
/// Holds short-lived borrows valid for one `step` call: the stepping node's
/// inbox/outbox, the shared command intent sink, the scheduler (for
/// `schedule_wake`, always targeting *this* node), and the seeded RNG.
///
/// # Golden-rule enforcement
/// The method surface is deliberately exhaustive and minimal: `tick`, `self_id`,
/// `take_input`, `has_pending_input` (read-only), `push_output`, `emit`,
/// `schedule_wake`, `rng`. **Deliberately absent:** any `now()` / `system_time()`
/// / `read_file()` / `http()` / `env()`. No such method exists, so a machine
/// cannot reach a clock, the filesystem, the network, or unseeded randomness —
/// the structural half of SC#5. `has_pending_input` adds NO authority: it is a
/// `&self` read of the inbox's emptiness (no clock/fs/net/rng), so the golden-rule
/// structural guarantee (CORE-03) is preserved.
pub struct StepCtx<'a> {
    /// The current tick (logical time — the ONLY notion of "now" a machine has).
    tick: u64,
    /// The stepping node's own id; `schedule_wake` always targets it.
    self_id: NodeId,
    /// This node's input ports for the tick.
    inbox: &'a mut PortInbox,
    /// This node's output ports for the tick.
    outbox: &'a mut PortOutbox,
    /// Shared sink for emitted command intent (executor muted in Phase 1).
    commands: &'a mut Vec<Command>,
    /// The scheduler — reached only via `schedule_wake` (self-targeting).
    sched: &'a mut Scheduler,
    /// The single sanctioned nondeterminism source (seeded, logged).
    rng: &'a mut SimRng,
}

impl<'a> StepCtx<'a> {
    /// Construct a capability object for one `step` call. The fold (plan 05)
    /// assembles this from the grid + scheduler + rng for the active node.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        tick: u64,
        self_id: NodeId,
        inbox: &'a mut PortInbox,
        outbox: &'a mut PortOutbox,
        commands: &'a mut Vec<Command>,
        sched: &'a mut Scheduler,
        rng: &'a mut SimRng,
    ) -> Self {
        Self {
            tick,
            self_id,
            inbox,
            outbox,
            commands,
            sched,
            rng,
        }
    }

    /// The current tick — logical time, the only "now" a machine may read.
    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// This machine's own node id.
    pub fn self_id(&self) -> NodeId {
        self.self_id
    }

    /// Take the front item of input `port` (FIFO), as `(event_seq, item)`.
    /// The `event_seq` is the ROUTE-06 cross-port tie-break key.
    pub fn take_input(&mut self, port: PortId) -> Option<(u64, Item)> {
        self.inbox.take(port)
    }

    /// True if any input port still holds an item — a **read-only** query used by
    /// operators (e.g. the merge funnel) to decide whether to re-wake themselves
    /// while a backlog remains, without taking the input.
    ///
    /// This adds no authority: it takes `&self`, reads only
    /// [`PortInbox::is_empty`], mutates nothing, and exposes no clock/fs/net/rng —
    /// so the golden-rule structural guarantee (CORE-03) that the `StepCtx` method
    /// surface is exhaustive-and-minimal is preserved (threat T-2-CTX-AUTH).
    pub fn has_pending_input(&self) -> bool {
        !self.inbox.is_empty()
    }

    /// True if input `port` specifically still holds an item — a **read-only**,
    /// port-scoped variant of [`has_pending_input`](Self::has_pending_input).
    ///
    /// Operators that drain only a bounded port range (e.g. the merge funnel,
    /// which services `0..inputs`) use this to decide re-wake on whether any
    /// *in-range* port still has work, rather than on the whole inbox — so an
    /// item stranded on an out-of-range port (`>= inputs`, or `FAULT_PORT`)
    /// cannot keep the operator perpetually awake (livelock, WR-01).
    ///
    /// Adds no authority: `&self`, reads only [`PortInbox::has_on`], mutates
    /// nothing, exposes no clock/fs/net/rng — the golden-rule structural
    /// guarantee (CORE-03, threat T-2-CTX-AUTH) is preserved.
    pub fn has_pending_input_on(&self, port: PortId) -> bool {
        self.inbox.has_on(port)
    }

    /// Push `item` to output `port` (FIFO). Routing onto belts happens in the
    /// fold after `step` returns (plan 05).
    pub fn push_output(&mut self, port: PortId, item: Item) {
        self.outbox.push(port, item);
    }

    /// Emit a command as *intent*. The executor is muted in Phase 1; the Phase 5
    /// dispatcher consumes these off the sim thread.
    pub fn emit(&mut self, cmd: Command) {
        self.commands.push(cmd);
    }

    /// Ask to be re-stepped at tick `at`. Always targets *this* node's id, so a
    /// machine cannot schedule a wake for anyone else (share-nothing, API-04).
    ///
    /// A wake for the current tick or any past tick (`at <= tick`) is routed to
    /// an immediate wake (`wake_now`) rather than the wake wheel: a bucket at a
    /// tick `take_due` has already passed would never be promoted, silently
    /// stranding the machine ("stuck machine", WR-02). Only strictly-future ticks
    /// go on the wheel.
    pub fn schedule_wake(&mut self, at: u64) {
        if at <= self.tick {
            self.sched.wake_now(self.self_id);
        } else {
            self.sched.schedule_wake(self.self_id, at);
        }
    }

    /// The seeded, logged PRNG — the single sanctioned source of randomness.
    pub fn rng(&mut self) -> &mut SimRng {
        self.rng
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::{Command, Effect, EVENT_VERSION};
    use crate::ids::Item;
    use crate::state::{PortInbox, PortOutbox};
    use slotmap::SlotMap;

    /// A throwaway machine exercising every capability method: it consumes an
    /// input, forwards it to an output, emits a command, draws from the rng, and
    /// schedules a wake `delay` ticks ahead.
    struct EchoMachine {
        delay: u64,
        last_draw: u64,
    }

    impl Machine for EchoMachine {
        fn step(&mut self, ctx: &mut StepCtx<'_>) {
            let now = ctx.tick();
            // Draw from the seeded rng (the only nondeterminism source).
            self.last_draw = ctx.rng().next_u64();
            // Consume input port 0 and forward it to output port 0.
            if let Some((seq, item)) = ctx.take_input(0) {
                ctx.push_output(0, item);
                // Emit a command intent keyed off the consumed seq.
                ctx.emit(Command {
                    event_version: EVENT_VERSION,
                    id: (now, ctx.self_id(), seq as u32),
                    partition: 0,
                    effect: Effect::Noop,
                    deadline: now + 100,
                });
            }
            // Ask to be re-stepped later.
            ctx.schedule_wake(now + self.delay);
        }
    }

    #[test]
    fn machine_step_ctx_exercises_every_capability() {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let me = alloc.insert(());

        let mut inbox = PortInbox::new();
        inbox.push(0, /*seq*/ 42, Item(vec![9, 9, 9]));
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(123);

        let mut m = EchoMachine {
            delay: 3,
            last_draw: 0,
        };

        {
            let mut ctx =
                StepCtx::new(10, me, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            m.step(&mut ctx);
            // tick() reads logical time.
            assert_eq!(ctx.tick(), 10);
            assert_eq!(ctx.self_id(), me);
        }

        // Input consumed, output produced.
        assert!(inbox.is_empty(), "input port 0 was consumed");
        assert_eq!(outbox.drain_sorted(), vec![(0u16, Item(vec![9, 9, 9]))]);

        // A command intent was emitted.
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].id, (10, me, 42));
        assert_eq!(commands[0].effect, Effect::Noop);

        // schedule_wake(at) targeted THIS node at tick 10 + 3 = 13.
        assert_eq!(sched.take_due(13), 1, "wake landed at tick 13");
        assert_eq!(sched.drain_active_sorted(), vec![me], "wake targets self_id");

        // The rng draw is reproducible from the same seed.
        let mut reference = SimRng::from_seed_u64(123);
        assert_eq!(m.last_draw, reference.next_u64(), "rng draw is deterministic");
    }

    #[test]
    fn has_pending_input_true_when_any_port_holds_an_item() {
        // A read-only query: any input port holding an item => true. Build the
        // StepCtx the same way `machine_step_ctx_exercises_every_capability` does.
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let me = alloc.insert(());
        let mut inbox = PortInbox::new();
        // Push onto a non-zero port to prove "any port", not just port 0.
        inbox.push(2, /*seq*/ 7, Item(vec![0xAB]));
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(0);

        let ctx =
            StepCtx::new(0, me, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
        assert!(ctx.has_pending_input(), "a port holding an item reports pending input");
    }

    #[test]
    fn has_pending_input_false_when_inbox_empty() {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let me = alloc.insert(());
        let mut inbox = PortInbox::new();
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(0);

        let ctx =
            StepCtx::new(0, me, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
        assert!(!ctx.has_pending_input(), "an empty inbox reports no pending input");
    }

    #[test]
    fn has_pending_input_does_not_consume() {
        // Read-only / non-consuming (threat T-2-CTX-AUTH): calling it twice leaves
        // the item still takeable via take_input.
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let me = alloc.insert(());
        let mut inbox = PortInbox::new();
        inbox.push(0, /*seq*/ 5, Item(vec![0xCD]));
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(0);

        let mut ctx =
            StepCtx::new(0, me, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
        assert!(ctx.has_pending_input(), "first query sees the item");
        assert!(ctx.has_pending_input(), "second query still sees it (non-consuming)");
        // The item survives both queries and is still takeable.
        assert_eq!(ctx.take_input(0), Some((5, Item(vec![0xCD]))), "item untouched by the query");
    }

    #[test]
    fn machine_schedule_wake_past_or_present_wakes_now_not_stranded() {
        // Regression for WR-02: schedule_wake(at) with at <= now must wake the
        // node immediately rather than parking it in a wheel bucket that take_due
        // has already passed (which would silently strand it forever).
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let me = alloc.insert(());
        let mut inbox = PortInbox::new();
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(0);

        {
            let mut ctx =
                StepCtx::new(10, me, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            ctx.schedule_wake(10); // == now
            ctx.schedule_wake(3); // in the past
        }
        // Both routed to the active set (wake_now); nothing parked on the wheel.
        assert_eq!(sched.pending_wakes(), 0, "no unreachable wheel bucket created");
        assert_eq!(sched.drain_active_sorted(), vec![me], "woken immediately, not stranded");

        // A strictly-future wake still goes on the wheel as before.
        {
            let mut ctx =
                StepCtx::new(10, me, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            ctx.schedule_wake(11);
        }
        assert_eq!(sched.pending_wakes(), 1, "future wake parked on the wheel");
        assert_eq!(sched.take_due(11), 1, "promoted at its future tick");
    }
}
