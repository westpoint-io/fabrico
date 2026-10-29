//! `impl Machine for Sink` — the terminal side-effect sink (Phase-5 EXEC seam).
//!
//! The sink's plain data (`Sink { template, deadline_ticks }`) lives in
//! [`crate::state`]; here it gains behavior through the public [`Machine`] trait
//! (API-02), exactly like the other built-ins. A sink is the grid's "launch the
//! rocket" terminal: it consumes items on input port 0 and, for each, emits one
//! [`Command`] of side-effecting *intent* via [`StepCtx::emit`] — and produces NO
//! belt output (it is terminal). The host executor (a later plan) turns the intent
//! into real I/O off the sim thread and feeds the [`Outcome`](crate::command::Outcome)
//! back as a logged event that re-enters the fold via [`crate::manual_inject::admit`].
//!
//! # Determinism
//! The sink touches the world ONLY through its `StepCtx` (the golden-rule
//! capability) — no clock, no I/O. Each emitted command's `id` is the deterministic
//! idempotency key `(tick, self_id, event_seq)` derived purely from logged data
//! (`CommandId`, [`crate::ids`]), and its `deadline` is integer tick arithmetic
//! (`tick + deadline_ticks`). The host's exactly-once dispatch keys off that id.

use crate::command::{Command, EVENT_VERSION};
use crate::machine::{Machine, StepCtx};

impl Machine for crate::state::Sink {
    fn step(&mut self, ctx: &mut StepCtx<'_>) {
        // ONE item per pass off input port 0 (71-03 ruling R-12); one consumed item
        // == one emitted command of intent. A terminal sink writes NO output port
        // (the host owns the effect).
        //
        // The idempotency key is UNCHANGED: `(tick, self_id, event_seq)` still comes
        // from the item's own inbox `seq`, which is per-item and not per-pass, so two
        // items consumed on two different ticks still mint two distinct keys and the
        // host's exactly-once dispatch is unaffected by the bound.
        if let Some((seq, item)) = ctx.take_input(0) {
            let id = (ctx.tick(), ctx.self_id(), seq as u32);
            let deadline = ctx.tick() + self.deadline_ticks;
            ctx.emit(Command {
                event_version: EVENT_VERSION,
                id,
                partition: 0,
                effect: self.template.to_effect(item.0),
                deadline,
            });
        }
        // Re-wake next tick while port 0 still holds a backlog - strictly future,
        // never `schedule_wake(now)`. Gate on the SERVICEABLE port only, never the
        // whole inbox: a Sink's `FAULT_PORT` carries `CommandFailure` and
        // `CommandTimeout` faults it never drains, so testing the whole inbox would
        // re-wake it forever on a board pointed at a dead endpoint (livelock, WR-01).
        // That is not a hypothetical for a Sink; it is the ordinary case.
        if ctx.has_pending_input_on(0) {
            ctx.schedule_wake(ctx.tick() + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::command::{Command, Effect};
    use crate::ids::{Item, NodeId};
    use crate::machine::{Machine, StepCtx};
    use crate::rng::SimRng;
    use crate::scheduler::Scheduler;
    use crate::state::{GridState, HttpMethod, Node, PortInbox, PortOutbox, Sink, SinkTemplate};
    use slotmap::SlotMap;

    /// Step a `Sink` over an inbox prepared by the caller, returning the emitted
    /// commands and the drained outbox (which must always be empty for a sink).
    fn step_sink(
        tick: u64,
        sink: &mut Sink,
        inbox: &mut PortInbox,
    ) -> (Vec<Command>, Vec<(u16, Item)>) {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let me = alloc.insert(());
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(0);
        {
            let mut ctx =
                StepCtx::new(tick, me, inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            sink.step(&mut ctx);
        }
        (commands, outbox.drain_sorted())
    }

    #[test]
    fn sink_emits_one_http_command_per_item_with_deadline_and_no_output() {
        // A Sink{Http{url}, deadline_ticks=N} fed one item on port 0 emits exactly
        // one Command whose effect is Effect::Http{url, body=item bytes}, whose
        // deadline == tick + N, and whose id == (tick, self_id, event_seq), with an
        // EMPTY outbox (terminal sink).
        let mut sink = Sink::new(
            SinkTemplate::Http {
                url: "https://example.com/hook".to_owned(),
                method: HttpMethod::Post,
            },
            5,
        );
        let mut inbox = PortInbox::new();
        inbox.push(0, /*seq*/ 42, Item(vec![0xDE, 0xAD]));

        let (commands, outputs) = step_sink(10, &mut sink, &mut inbox);
        assert_eq!(commands.len(), 1, "one item == one command");
        let cmd = &commands[0];
        assert_eq!(
            cmd.effect,
            Effect::Http {
                url: "https://example.com/hook".to_owned(),
                body: vec![0xDE, 0xAD],
                method: HttpMethod::Post,
            },
            "effect carries the item bytes as the body"
        );
        assert_eq!(cmd.deadline, 15, "deadline == tick(10) + deadline_ticks(5)");
        assert_eq!(cmd.id.0, 10, "command id tick is the emit tick");
        assert_eq!(cmd.id.2, 42, "command id seq is the item's event_seq");
        assert!(outputs.is_empty(), "a terminal sink produces no belt output");
    }

    #[test]
    fn sink_with_two_queued_items_emits_two_commands_fifo() {
        // Two queued items emit two commands, FIFO, one per item - but since 71-03
        // (ruling R-12) that takes TWO PASSES, not one. The FIFO property and the
        // one-item-one-command property are unchanged; what changed is that a pass
        // consumes exactly one item and re-wakes while a backlog remains.
        let mut sink = Sink::new(SinkTemplate::Debug, 1);
        let mut inbox = PortInbox::new();
        inbox.push(0, 1, Item(vec![0xA]));
        inbox.push(0, 2, Item(vec![0xB]));

        let (commands, outputs) = step_sink(0, &mut sink, &mut inbox);
        assert_eq!(commands.len(), 1, "ONE item per pass == ONE command (R-12)");
        assert_eq!(
            commands[0].effect,
            Effect::Debug { message: vec![0xA] },
            "FIFO: first item first"
        );
        assert!(outputs.is_empty(), "no belt output");
        assert_eq!(inbox.len_on(0), 1, "the second item was NOT taken this pass");

        // Pass two at tick 1 takes the second. Without the re-wake this pass would
        // never happen on a live board and the item would rest forever, which is the
        // failure a bounded pass introduces if its author forgets the wake.
        let (commands, outputs) = step_sink(1, &mut sink, &mut inbox);
        assert_eq!(commands.len(), 1, "the backlog item on the next pass");
        assert_eq!(commands[0].effect, Effect::Debug { message: vec![0xB] });
        assert!(outputs.is_empty(), "no belt output");
        assert!(inbox.is_empty(), "sink fully drained over two passes");
    }

    #[test]
    fn sink_rewakes_at_tick_plus_one_while_port_zero_has_a_backlog_and_never_on_faults() {
        // The two halves of R-12's re-wake rule, on the machine where getting the
        // second half wrong is not hypothetical.
        //
        // Half one: a pass leaving a backlog on the SERVICEABLE port schedules a wake
        // at tick+1, strictly future.
        let mut sink = Sink::new(SinkTemplate::Debug, 1);
        let mut inbox = PortInbox::new();
        inbox.push(0, 1, Item(vec![0xA]));
        inbox.push(0, 2, Item(vec![0xB]));
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let me = alloc.insert(());
        let mut sched = Scheduler::new();
        {
            let mut outbox = PortOutbox::new();
            let mut commands: Vec<Command> = Vec::new();
            let mut rng = SimRng::from_seed_u64(0);
            let mut ctx = StepCtx::new(
                10,
                me,
                &mut inbox,
                &mut outbox,
                &mut commands,
                &mut sched,
                &mut rng,
            );
            sink.step(&mut ctx);
        }
        assert_eq!(sched.active_count_at(11), 1, "backlog => re-wake at tick+1");

        // Half two, and this is the livelock guard (WR-01): a Sink's FAULT_PORT holds
        // CommandFailure / CommandTimeout faults it NEVER drains. A re-wake gated on
        // the WHOLE inbox rather than on port 0 would keep a faulted Sink awake
        // forever on every board pointed at a dead endpoint - not a corner case, the
        // ordinary one. Drain port 0 completely, leave a fault resting, and assert the
        // Sink sleeps.
        let mut inbox = PortInbox::new();
        inbox.push(crate::fault::FAULT_PORT, 3, Item(vec![0xFF]));
        let mut sched = Scheduler::new();
        {
            let mut outbox = PortOutbox::new();
            let mut commands: Vec<Command> = Vec::new();
            let mut rng = SimRng::from_seed_u64(0);
            let mut ctx = StepCtx::new(
                20,
                me,
                &mut inbox,
                &mut outbox,
                &mut commands,
                &mut sched,
                &mut rng,
            );
            sink.step(&mut ctx);
        }
        assert_eq!(
            sched.pending_wakes(),
            0,
            "an item resting on FAULT_PORT must NOT keep the sink awake (WR-01)"
        );
        assert_eq!(
            inbox.len_on(crate::fault::FAULT_PORT),
            1,
            "and the fault is still there: the pass services port 0 only"
        );
    }

    #[test]
    fn sink_with_no_input_emits_nothing() {
        let mut sink = Sink::new(SinkTemplate::Debug, 1);
        let mut inbox = PortInbox::new();
        let (commands, outputs) = step_sink(0, &mut sink, &mut inbox);
        assert!(commands.is_empty(), "no input => no command");
        assert!(outputs.is_empty(), "no input => no output");
    }

    #[test]
    fn add_sink_mints_node_with_inbox() {
        // add_sink mints a node, inserts Node::Sink + an inbox, and node(id) matches.
        let mut g = GridState::new();
        let id = g.add_sink(
            SinkTemplate::Http {
                url: "https://example.com/hook".to_owned(),
                method: crate::state::HttpMethod::Post,
            },
            7,
        );
        assert_eq!(g.node_count(), 1);
        match g.node(id) {
            Some(Node::Sink(s)) => {
                assert_eq!(s.deadline_ticks, 7);
                assert_eq!(
                    s.template,
                    SinkTemplate::Http {
                        url: "https://example.com/hook".to_owned(),
                        method: crate::state::HttpMethod::Post,
                    }
                );
            }
            other => panic!("expected a Sink node, got {other:?}"),
        }
        assert!(g.inbox_of(id).is_some(), "a sink has an inbox provisioned");
    }

    #[test]
    fn sink_is_the_last_node_discriminant_and_no_sink_grid_is_byte_stable() {
        // Node::Sink must serialize at discriminant 7 (appended LAST) so the frozen
        // corpus 0001-0005 (Source..Factory = 0..6) still decodes byte-identically.
        let mut g = GridState::new();
        let id = g.add_sink(SinkTemplate::Debug, 1);
        let node = g.node(id).expect("sink node");
        let bytes = postcard::to_allocvec(node).expect("serialize node");
        assert_eq!(
            bytes.first(),
            Some(&7u8),
            "Sink is the 8th variant (discriminant 7), appended last"
        );

        // Byte-stability: a grid WITHOUT a Sink serializes identically before and
        // after this append (variants 0-6 unshifted). We build a representative
        // no-sink grid and assert its postcard round-trip is byte-identical (the
        // same invariant the frozen corpus relies on; the discriminants of the
        // existing variants are unchanged because Sink was appended last).
        let mut nosink = GridState::new();
        let s = nosink.add_source();
        let b = nosink.add_belt(3);
        nosink.link((s, 0), (b, 0));
        let bytes = postcard::to_allocvec(&nosink).expect("serialize no-sink grid");
        let restored: GridState =
            postcard::from_bytes(&bytes).expect("deserialize no-sink grid");
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize");
        assert_eq!(bytes, bytes2, "a no-sink grid round-trips byte-identically");
    }

    #[test]
    fn sink_grid_serde_round_trips_byte_identical() {
        // A GridState containing a Node::Sink serde round-trips byte-identically.
        let mut g = GridState::new();
        let src = g.add_source();
        let sink = g.add_sink(
            SinkTemplate::Http {
                url: "https://example.com".to_owned(),
                method: HttpMethod::Post,
            },
            9,
        );
        g.link((src, 0), (sink, 0));
        let bytes = postcard::to_allocvec(&g).expect("serialize sink grid");
        let restored: GridState = postcard::from_bytes(&bytes).expect("deserialize sink grid");
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize sink grid");
        assert_eq!(bytes, bytes2, "GridState with a Node::Sink round-trips byte-identical");
    }
}
