//! SERVE-06, core half: the return cable a reply takes home is chosen by the ADDRESS the
//! reply carries, and two replies emitted on different ticks BOTH arrive.
//!
//! # The board, and why it cannot be reached by gesture
//! Every test here builds the same shape: two callers, ONE shared handler, and a return
//! cable from the handler to each caller.
//!
//!     callerA --forwardA--> [ handler ] --returnA--> callerA
//!     callerB --forwardB-->            --returnB--> callerB
//!
//! That board is UNREACHABLE BY GESTURE in the shipped app, and it is important that a
//! later reader knows this rather than concluding the app is broken. D-01 plus D-02 make
//! a wire endpoint a PORT, and `fabrico-command`'s `DrawWire` refuses a second wire out
//! of an already-linked Out port with `PortOccupied`. So a user dragging a second return
//! leg out of one handler is refused at the command layer by design. The two-caller board
//! is therefore built here through the core `add_wire` seam the golden corpus itself uses,
//! and SERVE-06 is a CORE-CORRECTNESS requirement rather than a live scenario. Plan 72-01
//! reworded it for exactly this reason. Do not "fix" this file by trying to add a live e2e.
//!
//! # Everything is driven through `Core::advance`, and read off `GridState`
//! No test here hand-builds a `WireLink` or calls a routing function directly. The wire a
//! reply was admitted to is READ BACK from `GridState`, and the caller each cable points
//! at is read from that same live link rather than assumed from creation order. A test
//! that supplied the link would be asserting its author's intent instead of the fold's
//! behaviour, which is the defect class this repository keeps finding in itself.

use fabrico_core::core::Core;
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::{Medium, Node, Port, Role, Side};
use fabrico_core::wire::WireEnvelope;

/// The shared handler. It emits exactly one `ctx.command` per serviced request, which the
/// 37-03 reply seam maps to an `Effect::Reply` while (and only while) the item it is
/// servicing arrived as a wire envelope on an electrical port 0.
const SHARED_HANDLER_JS: &str = "export default function (input, ctx) { ctx.command({ok:1}, 0); }";

/// callerA's correlation. Distinct values so an observation names WHOSE reply it saw.
const CORRELATION_A: u64 = 0xAAAA_0001;
/// callerB's correlation.
const CORRELATION_B: u64 = 0xBBBB_0002;

/// The per-request hop budget. Well above the two hops this board takes, so nothing here
/// can pass or fail for a depth-bound reason.
const BUDGET: u64 = 8;

/// The two-caller board, plus the handles a test needs to interrogate it.
struct TwoCallerBoard {
    core: Core,
    caller_a: NodeId,
    caller_b: NodeId,
    /// The cable handler -> callerA. Created FIRST, so it holds the lower `NodeId`.
    return_a: NodeId,
    /// The cable handler -> callerB. Created SECOND, so the lowest-ascending-`NodeId`
    /// scan this plan deletes could never have chosen it.
    return_b: NodeId,
}

/// Build `callerA/callerB -> forward wires -> one handler -> return wires -> callerA/callerB`
/// from genesis. The handler DECLARES an electrical In at port 0, which after phase 72 is
/// what makes it a handler at all (D-16): `add_factory` inserts an inbox and NO ports, and
/// a port-less node reads Mechanical, so without that declaration the requests arrive, are
/// never unwrapped, and no reply is ever emitted. Deleting the line would not simplify this
/// fixture, it would silence every test in the file.
fn two_caller_board() -> TwoCallerBoard {
    let mut core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 7,
    });
    let caller_a = core.state.add_source();
    let caller_b = core.state.add_source();
    let handler = core.state.add_factory(SHARED_HANDLER_JS.to_owned(), 256, 7);
    core.state.set_ports(
        handler,
        vec![Port {
            local_offset: (0, 1),
            side: Side::W,
            role: Role::In,
            medium: Medium::Electrical,
        }],
    );

    // FORWARD cables. The entry lookup is node-only (D-19), and each caller has exactly
    // one outgoing cable, so entry selection is unambiguous on this board and cannot be
    // what any assertion below is measuring.
    let forward_a = core.state.add_wire((caller_a, 0), (handler, 0));
    core.state.link((forward_a, 0), (handler, 0));
    let forward_b = core.state.add_wire((caller_b, 0), (handler, 0));
    core.state.link((forward_b, 0), (handler, 0));

    // RETURN cables, BOTH out of the same handler. This is the whole subject: the handler
    // has two outgoing cables, so "which cable leaves the handler" has two answers and only
    // the reply's own address can pick between them.
    let return_a = core.state.add_wire((handler, 0), (caller_a, 0));
    core.state.link((return_a, 0), (caller_a, 0));
    let return_b = core.state.add_wire((handler, 0), (caller_b, 0));
    core.state.link((return_b, 0), (caller_b, 0));

    TwoCallerBoard {
        core,
        caller_a,
        caller_b,
        return_a,
        return_b,
    }
}

/// A logged `WireRequest` admitting one request from `caller`, stamped at the core's
/// current tick.
fn request(core: &Core, caller: NodeId, correlation: u64, sequence: u64) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence,
        tick: core.tick,
        payload: EventPayload::WireRequest {
            correlation,
            deadline_tick: 500,
            budget: BUDGET,
            return_addr: (caller, 0),
            // Valid JSON: the sandbox parses the request body before the handler runs.
            payload: Item(b"{\"n\":1}".to_vec()),
        },
    }
}

/// Every message currently in `wire`'s in-flight queue, as
/// `(the node this cable points AT, the message's correlation)`.
///
/// BOTH halves are read off live `GridState`: the destination comes from the stored
/// `WireLink::to`, never from the creation order this file happens to know.
fn in_flight_on(core: &Core, wire: NodeId) -> Vec<(NodeId, u64)> {
    match core.state.node(wire) {
        Some(Node::Wire(link)) => link
            .in_flight
            .iter()
            .map(|msg| (link.to.0, msg.correlation))
            .collect(),
        _ => Vec::new(),
    }
}

/// Drain whatever reply envelopes are resting in `caller`'s inbox port 0.
fn replies_at(core: &Core, caller: NodeId) -> Vec<WireEnvelope> {
    let Some(inbox) = core.state.inbox_of(caller) else {
        return Vec::new();
    };
    let mut clone = inbox.clone();
    let mut out = Vec::new();
    while let Some((_seq, item)) = clone.take(0) {
        if let Ok(env) = WireEnvelope::decode(&item) {
            out.push(env);
        }
    }
    out
}

/// A reply is admitted to the cable that POINTS AT the caller it is owed to, even when the
/// handler has two outgoing cables and the caller in question is behind the higher-`NodeId`
/// one.
///
/// RED ON HEAD BECAUSE: `tick.rs`'s `route_replies` selected the return cable with
/// `GridState::wire_from_node(handler)` (`state.rs`), whose `find_map` takes the FIRST
/// ascending `NodeId` with `link.from.0 == handler` and has no reference to who is owed the
/// answer. On this board that is ALWAYS `return_a`, so callerB's reply was admitted to
/// callerA's cable: the third assertion below saw `(callerA, CORRELATION_B)` on `return_a`,
/// and `return_b` held nothing all run. That is WINDOWS 124, reproduced on the smallest
/// board that can show it.
#[test]
fn each_callers_reply_lands_on_the_wire_that_points_at_that_caller() {
    let mut board = two_caller_board();

    // NON-VACUITY, asserted rather than assumed: `return_a` really is the cable a
    // lowest-ascending-`NodeId` scan out of the handler would pick. If a future change to
    // `add_wire` reversed the id order this test would still pass while measuring nothing,
    // so the precondition is pinned here.
    assert!(
        board.return_a < board.return_b,
        "the callerA cable holds the LOWER NodeId, so a lowest-id scan out of the handler \
         would choose it for BOTH callers. Without this the test proves nothing"
    );

    // The two requests are STAGGERED across ticks on purpose. Admitted on one tick, the
    // handler (one item per tick) would emit the second reply a tick later, and on HEAD
    // that reply was dropped by the empty per-tick scratch map instead of misrouted. This
    // test is about the ADDRESS, so both replies must be emitted while the old mechanism
    // was working exactly as designed. The same-tick loss is the next test's subject.
    let mut seen: Vec<(NodeId, NodeId, u64)> = Vec::new(); // (cable, cable's destination, correlation)
    board
        .core
        .advance(&[request(&board.core, board.caller_a, CORRELATION_A, 1)]);
    for tick in 0..12 {
        if tick == 4 {
            let ev = request(&board.core, board.caller_b, CORRELATION_B, 2);
            board.core.advance(&[ev]);
        } else {
            board.core.advance(&[]);
        }
        for cable in [board.return_a, board.return_b] {
            for (dest, correlation) in in_flight_on(&board.core, cable) {
                seen.push((cable, dest, correlation));
            }
        }
    }

    // Non-vacuity: both replies were actually emitted and reached a return cable. Without
    // this an empty `seen` would satisfy every "never rode the wrong cable" assertion.
    assert!(
        seen.iter().any(|(_, _, c)| *c == CORRELATION_A),
        "callerA's reply reached a return cable at all (seen: {seen:?})"
    );
    assert!(
        seen.iter().any(|(_, _, c)| *c == CORRELATION_B),
        "callerB's reply reached a return cable at all (seen: {seen:?})"
    );

    // THE ASSERTION. Every reply observed on a return cable was on a cable whose live
    // `WireLink::to` points at the caller that reply is owed to. The expected destination
    // is derived from the correlation, not from which cable it turned up on.
    for (cable, dest, correlation) in &seen {
        let owed_to = if *correlation == CORRELATION_A {
            board.caller_a
        } else {
            board.caller_b
        };
        assert_eq!(
            *dest, owed_to,
            "a reply for correlation {correlation:#x} was admitted to cable {cable:?}, which \
             points at {dest:?}, but that reply is owed to {owed_to:?}. A reply riding another \
             caller's cable is WINDOWS 124"
        );
    }

    // And it arrives: each caller holds its OWN answer and only its own.
    let a: Vec<u64> = replies_at(&board.core, board.caller_a)
        .iter()
        .map(|e| e.correlation)
        .collect();
    let b: Vec<u64> = replies_at(&board.core, board.caller_b)
        .iter()
        .map(|e| e.correlation)
        .collect();
    assert_eq!(a, vec![CORRELATION_A], "callerA holds exactly its own reply");
    assert_eq!(b, vec![CORRELATION_B], "callerB holds exactly its own reply");
}

/// Two requests admitted on ONE tick produce TWO replies that both arrive home.
///
/// RED ON HEAD BECAUSE: the correlation-to-address binding `route_replies` read was a
/// scratch `BTreeMap` declared inside `tick::advance` and rebuilt EMPTY every tick. A
/// Factory drains `FACTORY_ITEMS_PER_TICK = 1` item per tick (`factory.rs`) and re-wakes at
/// now+1 (`factory.rs`), so with both requests delivered on one tick the handler emitted
/// reply A on that tick and reply B on the NEXT one, by which point the map was empty. Reply
/// B found no binding and hit the `continue` that dropped it. On HEAD `callerB` ends this
/// test holding nothing.
///
/// ASSERTED IN THE CORE, ON THE WIRES AND THE CALLERS' INBOXES, NEVER ON AN HTTP RESPONSE.
/// That is not a stylistic choice. The host resolves a parked socket by correlation off the
/// command stream and reads nothing from the grid (`sim_loop.rs`, D-08), so the caller still
/// received its 200 with this defect fully present: every HTTP-level assertion in this
/// repository passes over the loss. An HTTP-level version of this test would be GREEN on
/// HEAD and would prove nothing.
#[test]
fn two_replies_emitted_on_the_same_tick_both_arrive() {
    let mut board = two_caller_board();

    // BOTH requests in ONE `advance` call, so both forward cables ingest at the same tick
    // and mature on the same tick, and the handler is handed two items at once.
    let ev_a = request(&board.core, board.caller_a, CORRELATION_A, 1);
    let ev_b = request(&board.core, board.caller_b, CORRELATION_B, 2);
    board.core.advance(&[ev_a, ev_b]);

    let mut cables_seen: Vec<(NodeId, u64)> = Vec::new();
    for _ in 0..12 {
        board.core.advance(&[]);
        for cable in [board.return_a, board.return_b] {
            for (dest, correlation) in in_flight_on(&board.core, cable) {
                cables_seen.push((dest, correlation));
            }
        }
    }

    // Each reply travelled on the cable pointing at its own caller. Read off `GridState`,
    // never a hand-built link.
    assert!(
        cables_seen.contains(&(board.caller_a, CORRELATION_A)),
        "callerA's reply travelled the cable pointing at callerA (seen: {cables_seen:?})"
    );
    assert!(
        cables_seen.contains(&(board.caller_b, CORRELATION_B)),
        "callerB's reply travelled the cable pointing at callerB. On HEAD it was never \
         emitted onto any cable at all: the per-tick scratch map was empty by the tick the \
         handler got to callerB's item (seen: {cables_seen:?})"
    );

    // And both arrive home, each carrying its own correlation, address and inherited budget.
    let a = replies_at(&board.core, board.caller_a);
    let b = replies_at(&board.core, board.caller_b);
    assert_eq!(a.len(), 1, "callerA received exactly one reply, got {a:?}");
    assert_eq!(
        b.len(),
        1,
        "callerB received exactly one reply. TWO POSTs on one tick must produce TWO answers \
         that travel home, not one. Got {b:?}"
    );
    assert_eq!(a[0].correlation, CORRELATION_A);
    assert_eq!(b[0].correlation, CORRELATION_B);
    assert_eq!(a[0].return_addr, (board.caller_a, 0));
    assert_eq!(b[0].return_addr, (board.caller_b, 0));
    assert_eq!(
        (a[0].budget, b[0].budget),
        (BUDGET, BUDGET),
        "each reply INHERITS its own request's remaining budget (entry and return hops are \
         both free on this board), so one budget bounds each round trip"
    );
}
