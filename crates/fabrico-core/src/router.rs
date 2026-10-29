//! `impl Machine for Router` — the router / switch operator (ROUTE-04).
//!
//! The router's plain data (`Router { routes, default, faults }`) lives in
//! [`crate::state`]; this module gives it behavior through the public [`Machine`]
//! trait (API-02).
//!
//! A router switches each inbound item to an output port chosen by a deterministic
//! condition evaluated over the item's own logged bytes — the **first** matching
//! [`RouteKey`](crate::state::RouteKey) in the ordered `routes` table wins (a
//! `Vec`, never a `HashMap`, so first-match is deterministic; threat T-2-DET).
//!
//! # No-match policy (CONTEXT, ROUTE-04)
//! With no matching route the item goes to the configured `default` ("else")
//! output. If `default` is `None`, the item is emitted on the reserved
//! [`FAULT_PORT`] as a [`Fault::no_match`] — the **first real Phase-2 fault
//! producer**. Each such emission bumps the snapshot-captured `faults` debug
//! counter.
//!
//! # Routing over logged data with zero envelope change (RESEARCH Pitfall 2)
//! The router matches a byte-slice of the opaque [`Item`](crate::ids::Item) — the
//! `Event` envelope is consumed at `admit` and never reaches an operator. The item
//! bytes ARE logged data (they entered via a logged `ManualInject`/`Input` and are
//! byte-reproducible on replay), so matching on them satisfies ROUTE-04 "condition
//! over logged data" + ROUTE-06 determinism with **no `event.rs` change and no
//! `SCHEMA_VERSION` bump**.
//!
//! # Bounds-safe match (threat T-2-ITEM, RESEARCH Pitfall 4 / Security V5)
//! [`RouteKey::matches`](crate::state::RouteKey::matches) reads the item with a
//! bounds-safe `item.0.get(lo..hi)` range, so a short or crafted item yields
//! no-match (routed to default/fault), never a panic — a panic would be a DoS of
//! the deterministic core.

use crate::fault::{Fault, FAULT_PORT};
use crate::machine::{Machine, StepCtx};
use crate::state::Router;

impl Machine for Router {
    fn step(&mut self, ctx: &mut StepCtx<'_>) {
        let me = ctx.self_id();
        // ONE item per pass off input port 0 (71-03 ruling R-12); switch it by the
        // first matching route. The route table, the default ("else") port and the
        // no-match fault are all unchanged - only the loop bound moved.
        if let Some((_seq, item)) = ctx.take_input(0) {
            let matched = self
                .routes
                .iter()
                .find(|(key, _)| key.matches(&item))
                .map(|(_, port)| *port);
            match matched {
                Some(port) => ctx.push_output(port, item),
                None => match self.default {
                    // No match but a default ("else") port is configured.
                    Some(port) => ctx.push_output(port, item),
                    // No match and no default => emit on the reserved fault port
                    // as a NoMatch fault (the first Phase-2 fault producer) and
                    // bump the producer-side debug counter.
                    None => {
                        self.faults += 1;
                        ctx.push_output(FAULT_PORT, Fault::no_match(me, item).encode());
                    }
                },
            }
        }
        // Re-wake next tick while port 0 still holds a backlog - strictly future,
        // never `schedule_wake(now)`. Gate on the SERVICEABLE port only, never the
        // whole inbox: a no-match fault this router EMITTED rides its outbox, but a
        // fault DELIVERED to its own `FAULT_PORT` would rest in the inbox forever and
        // testing the whole inbox would re-wake it forever (livelock, WR-01).
        if ctx.has_pending_input_on(0) {
            ctx.schedule_wake(ctx.tick() + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::Command;
    use crate::fault::FaultReason;
    use crate::ids::{Item, NodeId, PortId};
    use crate::rng::SimRng;
    use crate::scheduler::Scheduler;
    use crate::state::{PortInbox, PortOutbox, RouteKey};
    use slotmap::SlotMap;

    /// Mint one real generational `NodeId`.
    fn one_id() -> NodeId {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        alloc.insert(())
    }

    /// Drive `router` (with node id `id`) for a single tick over `inputs` queued
    /// on port 0, returning the outputs drained from the outbox (ascending port,
    /// FIFO within port). `id` is passed so a faulted item's `source` can be
    /// asserted equal to it.
    fn step_router(
        router: &mut Router,
        id: NodeId,
        inputs: &[Item],
    ) -> Vec<(PortId, Item)> {
        let mut sched = Scheduler::new();
        let mut rng = SimRng::from_seed_u64(1);
        let mut inbox = PortInbox::new();
        for (i, item) in inputs.iter().enumerate() {
            inbox.push(0, i as u64, item.clone());
        }
        let mut outbox = PortOutbox::new();
        let mut commands: Vec<Command> = Vec::new();
        {
            let mut ctx =
                StepCtx::new(0, id, &mut inbox, &mut outbox, &mut commands, &mut sched, &mut rng);
            router.step(&mut ctx);
        }
        outbox.drain_sorted()
    }

    #[test]
    fn router_routes_by_matching_byte_slice() {
        // routes: item starting 0x01 -> port 0 ; item starting 0x02 -> port 1.
        let id = one_id();
        let mut router = Router::new(
            vec![
                (RouteKey::new(0, vec![0x01]), 0),
                (RouteKey::new(0, vec![0x02]), 1),
            ],
            None,
        );

        let out = step_router(&mut router, id, &[Item(vec![0x01, 0xAA])]);
        assert_eq!(out, vec![(0u16, Item(vec![0x01, 0xAA]))], "0x01.. -> port 0");

        let out = step_router(&mut router, id, &[Item(vec![0x02, 0xBB])]);
        assert_eq!(out, vec![(1u16, Item(vec![0x02, 0xBB]))], "0x02.. -> port 1");

        assert_eq!(router.faults, 0, "every item matched a route => no faults");
    }

    #[test]
    fn router_first_match_wins() {
        // Two overlapping routes both match an item starting 0x01; the FIRST
        // (port 3) wins because `routes` is an ordered Vec (deterministic).
        let id = one_id();
        let mut router = Router::new(
            vec![
                (RouteKey::new(0, vec![0x01]), 3),
                (RouteKey::new(0, vec![0x01]), 7),
            ],
            None,
        );

        let out = step_router(&mut router, id, &[Item(vec![0x01, 0x01])]);
        assert_eq!(
            out,
            vec![(3u16, Item(vec![0x01, 0x01]))],
            "first matching route wins (ordered Vec, deterministic)"
        );
    }

    #[test]
    fn router_no_match_uses_default() {
        // A non-matching item with a configured default(5) goes to the default.
        let id = one_id();
        let mut router =
            Router::new(vec![(RouteKey::new(0, vec![0x01]), 0)], Some(5));

        let out = step_router(&mut router, id, &[Item(vec![0x99])]);
        assert_eq!(
            out,
            vec![(5u16, Item(vec![0x99]))],
            "no matching route => default ('else') port"
        );
        assert_eq!(router.faults, 0, "default routing is not a fault");
    }

    #[test]
    fn router_no_match_no_default_goes_to_fault() {
        // default=None: a non-matching item is emitted on FAULT_PORT as a
        // decodable NoMatch fault carrying source + attempt=1, and the router's
        // faults counter increments.
        let id = one_id();
        let mut router =
            Router::new(vec![(RouteKey::new(0, vec![0x01]), 0)], None);

        let out = step_router(&mut router, id, &[Item(vec![0x99, 0xEE])]);
        assert_eq!(out.len(), 1, "exactly one output");
        let (port, item) = &out[0];
        assert_eq!(*port, FAULT_PORT, "no-match without default => FAULT_PORT");

        let fault = Fault::decode(item).expect("the faulted item decodes to a Fault");
        assert_eq!(fault.reason, FaultReason::NoMatch);
        assert_eq!(fault.source, id, "fault carries the producing router's id");
        assert_eq!(fault.attempt, 1, "attempt rides the item, set to 1 on production");
        assert_eq!(fault.payload, vec![0x99, 0xEE], "original item bytes preserved");

        assert_eq!(router.faults, 1, "the faults counter incremented on production");
    }

    #[test]
    fn router_short_item_does_not_panic() {
        // A route expecting bytes at offset 4 over an item only 2 bytes long must
        // yield no-match (routed to default here), NEVER panic (threat T-2-ITEM).
        let id = one_id();
        let mut router =
            Router::new(vec![(RouteKey::new(4, vec![0xAA, 0xBB]), 0)], Some(9));

        let out = step_router(&mut router, id, &[Item(vec![0x01, 0x02])]);
        assert_eq!(
            out,
            vec![(9u16, Item(vec![0x01, 0x02]))],
            "too-short item is no-match (-> default), no panic"
        );

        // And with no default, the short item faults rather than panicking.
        let mut router_no_default =
            Router::new(vec![(RouteKey::new(4, vec![0xAA, 0xBB]), 0)], None);
        let out = step_router(&mut router_no_default, id, &[Item(vec![0x01])]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, FAULT_PORT, "short item -> fault, no panic");
        assert_eq!(router_no_default.faults, 1);
    }
}
