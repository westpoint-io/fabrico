//! Phase 72-08 (SERVE-07, D-04) - ONE drag between a Route and a Handler mints BOTH
//! cable legs, and deleting EITHER leg removes both.
//!
//! Everything drives through the public `GridSession::apply(GridCommand::...)` seam, the
//! `draw_wire.rs` idiom, so these are behaviours of the shipped command layer and not of
//! a test-only helper. `Scene::draw_wire` and the live host gesture both go through that
//! same seam, so a rule proven here is a rule the app and the scenario builder obey.
//!
//! # Why this file exists rather than more cases in `draw_wire.rs`
//! `draw_wire.rs` pins the SINGLE-wire path: one command, one wire, one undo step. That
//! path is unchanged for every electrical pair that is not a Route and a Handler, and its
//! suite must stay green beside this one. Mixing the two would make it impossible to read
//! which of the two rules a failure belongs to.
//!
//! # The invariant under test, stated once (D-06)
//! THERE IS NO BOARD STATE IN WHICH THE FORWARD CABLE EXISTS WITHOUT ITS RETURN LEG. As
//! `72-CLEAN-DESIGN`'s walk step 6 was written, a POST succeeds with only the forward
//! cable drawn, because the host resolves the parked socket from the correlation alone.
//! A return cable that can be absent while everything still works is a decorative cable,
//! and a board that lies. `no_gesture_reaches_a_forward_only_board` is that invariant
//! written as an enumeration of the gestures that could reach it.
//!
//! Run target: `cargo test -p fabrico-command --test wire_pair`

use fabrico_command::{CommandError, GridSession};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Medium, Node, WireLink};
use fabrico_protocol::{GridCommand, machine_kind};

const SEED: u64 = 0x0072_0008_C0FF_EE00;

/// A Route's catalog ports: electrical In at 0, electrical Out at 1 (`port_catalog`
/// `machine_kind::ENDPOINT`).
const ROUTE_IN: u16 = 0;
const ROUTE_OUT: u16 = 1;
/// A Handler's catalog ports: electrical In at 0, electrical Out at 1, mechanical Fault
/// at 2 (`port_catalog` `machine_kind::HANDLER`).
const HANDLER_IN: u16 = 0;
const HANDLER_OUT: u16 = 1;
const HANDLER_FAULT: u16 = 2;

/// Place `kind` at `(x, y)` and return the minted `NodeId`.
fn place(session: &mut GridSession, kind: u8, x: i32, y: i32) -> NodeId {
    session
        .apply(GridCommand::Place {
            kind,
            cell_x: x,
            cell_y: y,
        })
        .expect("a free in-bounds place is accepted");
    session
        .core()
        .state
        .occupied((x, y))
        .expect("the placed machine occupies its anchor cell")
}

/// The dense render handle for a `NodeId` (what a `GridCommand` targets).
fn handle(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("live node has a handle")
}

/// The `DrawWire` command wiring `(from, from_port) -> (to, to_port)` by handle.
fn draw(
    session: &GridSession,
    from: NodeId,
    from_port: u16,
    to: NodeId,
    to_port: u16,
) -> GridCommand {
    GridCommand::DrawWire {
        from_node: handle(session, from),
        from_port,
        to_node: handle(session, to),
        to_port,
    }
}

/// Every live `Node::Wire` on the board, as `(id, WireLink)`, in ascending `NodeId`
/// order. The ONE topology read every assertion below goes through.
fn wires(session: &GridSession) -> Vec<(NodeId, WireLink)> {
    let state = &session.core().state;
    state
        .node_ids()
        .filter_map(|id| match state.node(id) {
            Some(Node::Wire(w)) => Some((id, w.clone())),
            _ => None,
        })
        .collect()
}

/// The live wires as `((from_node, from_port), (to_node, to_port))`, order preserved.
fn wire_endpoints(session: &GridSession) -> Vec<((NodeId, u16), (NodeId, u16))> {
    wires(session).into_iter().map(|(_, w)| (w.from, w.to)).collect()
}

/// A session holding a Route at `(0, 0)` and a Handler at `(10, 10)`, plus their ids.
fn route_and_handler() -> (GridSession, NodeId, NodeId) {
    let mut session = GridSession::new(SEED);
    let route = place(&mut session, machine_kind::ENDPOINT, 0, 0);
    let handler = place(&mut session, machine_kind::HANDLER, 10, 10);
    (session, route, handler)
}

/// An electrical preset Router at `(x, y)` - the ONLY electrical machine on the board
/// that is not a Route or a Handler, and therefore the discriminator for R-51.
fn router(session: &mut GridSession, x: i32, y: i32) -> NodeId {
    session
        .place_router_preset(Medium::Electrical, x, y)
        .expect("an electrical router preset places on a free cell");
    session
        .core()
        .state
        .occupied((x, y))
        .expect("the preset router occupies its anchor cell")
}

// ─────────────────────────────────────────────────────────────────────────────────────
// TASK 1 - the mint
// ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn one_drawwire_between_a_route_and_a_handler_mints_two_wires() {
    let (mut session, route, handler) = route_and_handler();

    session
        .apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_IN))
        .expect("a Route-to-Handler drag is accepted");

    assert_eq!(
        wire_endpoints(&session),
        vec![
            ((route, ROUTE_OUT), (handler, HANDLER_IN)),
            ((handler, HANDLER_OUT), (route, ROUTE_IN)),
        ],
        "ONE DrawWire minted BOTH legs: the forward cable Route Out -> Handler In and \
         the return cable Handler Out -> Route In (D-04)"
    );
}

#[test]
fn the_pair_carries_one_action_id() {
    let (mut session, route, handler) = route_and_handler();

    session
        .apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_IN))
        .expect("a Route-to-Handler drag is accepted");

    let actions: Vec<u64> = session
        .edit_log()
        .iter()
        .filter(|r| matches!(r.op, fabrico_core::edit::EditOp::DrawWire { .. }))
        .map(|r| r.action)
        .collect();
    assert_eq!(actions.len(), 2, "two DrawWire records were logged");
    assert_eq!(
        actions[0], actions[1],
        "both legs carry ONE action id, so the pair is ONE undo step (D-04). Two action \
         ids would be two Ctrl+Z presses and a reachable half-pair between them"
    );
}

#[test]
fn the_drag_direction_does_not_change_the_pair() {
    // Forward drag: Route Out -> Handler In.
    let (mut forward_session, f_route, f_handler) = route_and_handler();
    forward_session
        .apply(draw(&forward_session, f_route, ROUTE_OUT, f_handler, HANDLER_IN))
        .expect("the forward drag is accepted");

    // Reverse drag on an identically-seeded board: Handler Out -> Route In.
    let (mut reverse_session, r_route, r_handler) = route_and_handler();
    reverse_session
        .apply(draw(&reverse_session, r_handler, HANDLER_OUT, r_route, ROUTE_IN))
        .expect("the reverse drag is accepted");

    assert_eq!(
        wire_endpoints(&forward_session),
        wire_endpoints(&reverse_session),
        "the pairing is a property of the two MACHINES, not of which nub the user \
         pressed first (R-51): both drags mint the same two wires, in the same order"
    );
    // The ORDER matters and not only the set: fold order decides which leg takes the
    // lower minted NodeId, so two boards that agree on the set and not the order are
    // two DIFFERENT boards at the byte level.
    let ids: Vec<NodeId> = wires(&forward_session).into_iter().map(|(id, _)| id).collect();
    assert_eq!(
        ids,
        wires(&reverse_session).into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
        "the two drags mint the two wires in the SAME order, so the forward leg takes \
         the lower NodeId either way"
    );
}

#[test]
fn a_second_route_paired_to_a_busy_handler_mints_nothing() {
    let (mut session, route, handler) = route_and_handler();
    session
        .apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_IN))
        .expect("the first Route pairs");
    let second = place(&mut session, machine_kind::ENDPOINT, 20, 20);
    let before = wire_endpoints(&session);

    let err = session
        .apply(draw(&session, second, ROUTE_OUT, handler, HANDLER_IN))
        .expect_err("a second Route paired to a busy Handler is refused");

    assert_eq!(
        err,
        CommandError::PortOccupied,
        "under D-02's single electrical Out the RETURN leg is refused PortOccupied"
    );
    // THIS IS D-06. The forward leg into the Handler's In nub is legal on its own (only
    // the FROM port is occupancy-checked, so two forward cables into one In are fine),
    // so without R-52's whole-or-nothing rule the refusal would leave a LONE FORWARD
    // CABLE from the second Route - the forward-only board, reached through an ordinary
    // gesture within a minute of placing a second Route.
    assert_eq!(
        wire_endpoints(&session),
        before,
        "the refused command minted NOTHING: not the return leg, and not the forward \
         leg either (R-52)"
    );
    assert!(
        !wire_endpoints(&session)
            .iter()
            .any(|((from, _), _)| *from == second),
        "no wire is live from the second Route"
    );
}

#[test]
fn an_endpoint_to_router_drag_still_mints_exactly_one_wire() {
    // THE DISCRIMINATOR. This test is not redundant with the single-wire suite in
    // `draw_wire.rs` and must not be deleted as such: it is the only assertion that the
    // pairing is NARROW. A Router emits no Effect::Reply, so a return leg drawn back to
    // one is a cable that can never carry anything - the decorative cable D-06 forbids.
    // If a later reader widens `route_handler_pair` into "any electrical pair", every
    // other test in this file still passes and THIS one fails.
    //
    // It is GREEN on HEAD and green after, which is exactly the point.
    let mut session = GridSession::new(SEED);
    let route = place(&mut session, machine_kind::ENDPOINT, 0, 0);
    let rtr = router(&mut session, 10, 10);

    session
        .apply(draw(&session, route, ROUTE_OUT, rtr, 0))
        .expect("a Route-to-Router drag is accepted");

    assert_eq!(
        wire_endpoints(&session),
        vec![((route, ROUTE_OUT), (rtr, 0))],
        "an Endpoint-to-Router drag mints EXACTLY ONE wire, exactly as it did before \
         72-08. The pairing does not fire for a pair that cannot answer (R-51)"
    );
}

#[test]
fn a_drag_onto_the_handlers_mechanical_fault_nub_is_refused_and_mints_nothing() {
    // The drag's OWN leg is checked first and on its own terms, so an illegal drag gets
    // its own typed tag rather than being rewritten into a legal pair by the pairing.
    // Without that ordering a release on the Fault nub would silently mint the canonical
    // pair, which is a gesture answering something the user did not ask for.
    let (mut session, route, handler) = route_and_handler();

    let err = session
        .apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_FAULT))
        .expect_err("a wire into a Role::Fault port is refused");

    assert_eq!(err, CommandError::IncompatiblePorts);
    assert!(
        wire_endpoints(&session).is_empty(),
        "the refused drag minted nothing, pair or otherwise"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────────
// TASK 2 - the teardown
// ─────────────────────────────────────────────────────────────────────────────────────

/// A session holding a paired Route and Handler, plus `(route, handler, forward, return)`.
fn paired_board() -> (GridSession, NodeId, NodeId, NodeId, NodeId) {
    let (mut session, route, handler) = route_and_handler();
    session
        .apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_IN))
        .expect("the pair mints");
    let live = wires(&session);
    assert_eq!(live.len(), 2, "the board starts with exactly the two paired legs");
    let forward = live[0].0;
    let ret = live[1].0;
    (session, route, handler, forward, ret)
}

#[test]
fn deleting_the_forward_leg_removes_the_return_leg() {
    let (mut session, _route, _handler, forward, _ret) = paired_board();

    session
        .apply(GridCommand::Delete {
            node: handle(&session, forward),
        })
        .expect("deleting a live wire is accepted");

    assert!(
        wire_endpoints(&session).is_empty(),
        "deleting the FORWARD leg removed the return leg too: neither wire is live \
         (R-53). Deleting only the named node would leave the return cable dangling off \
         a Handler nobody can reach"
    );
}

#[test]
fn deleting_the_return_leg_removes_the_forward_leg() {
    let (mut session, _route, _handler, _forward, ret) = paired_board();

    // This is the case Disconnect on the Handler's Out row produces
    // (`ConfigPanel.tsx:1163-1167` emits `Delete { node: link.wire }` for a wire row),
    // which is why UI-SPEC 5.6 needs no frontend change.
    session
        .apply(GridCommand::Delete {
            node: handle(&session, ret),
        })
        .expect("deleting a live wire is accepted");

    assert!(
        wire_endpoints(&session).is_empty(),
        "deleting the RETURN leg removed the forward leg too: the cascade is symmetric \
         (R-53)"
    );
}

#[test]
fn the_paired_delete_is_one_action_id() {
    let (mut session, _route, _handler, forward, _ret) = paired_board();
    let before = session.edit_log().len();

    session
        .apply(GridCommand::Delete {
            node: handle(&session, forward),
        })
        .expect("deleting a live wire is accepted");

    let appended: Vec<u64> = session.edit_log()[before..].iter().map(|r| r.action).collect();
    assert_eq!(appended.len(), 2, "the paired delete appended two Delete records");
    assert_eq!(
        appended[0], appended[1],
        "both Deletes carry ONE action id, so the teardown is ONE undo step - the same \
         property the mint has, seen from the other end"
    );
}

#[test]
fn deleting_a_lone_wire_between_two_routers_removes_only_that_wire() {
    // The cascade must not change what a single-wire delete does on a board with no pair
    // on it. Two electrical Routers wired both ways is the shape that would be caught by
    // the cheaper "two wires between the same two nodes, opposite ways" rule this
    // deliberately does not use.
    let mut session = GridSession::new(SEED);
    let a = router(&mut session, 0, 0);
    let b = router(&mut session, 10, 10);
    session
        .apply(draw(&session, a, 1, b, 0))
        .expect("Router-to-Router is accepted");
    session
        .apply(draw(&session, b, 1, a, 0))
        .expect("the opposite Router-to-Router wire is accepted");
    let live = wires(&session);
    assert_eq!(live.len(), 2, "two SINGLE cables, not a pair");

    session
        .apply(GridCommand::Delete {
            node: handle(&session, live[0].0),
        })
        .expect("deleting a live wire is accepted");

    assert_eq!(
        wire_endpoints(&session),
        vec![((b, 1), (a, 0))],
        "only the named wire went. Two Routers wired both ways is two cables that share \
         their endpoints, NOT one round trip, because a Router emits no Effect::Reply \
         and so has no answer to send back (R-51 applied to the delete side)"
    );
}

#[test]
fn no_gesture_reaches_a_forward_only_board() {
    // D-06 STATED AS AN ASSERTION rather than as prose. An unreachability claim is only
    // as strong as the list of routes it walked, so this ENUMERATES every single-wire
    // gesture reachable on a Route-and-Handler board and asserts the live wire count is
    // always 0 or 2, NEVER 1. A count comparison is legitimate here because the claim IS
    // about the count: one live wire on this board is, by construction, a forward cable
    // without its return leg or a return cable without anything to answer.
    //
    // The gestures, named so a reader can see what is and is not covered:
    //   1. draw forward (Route Out -> Handler In)
    //   2. draw reverse (Handler Out -> Route In)
    //   3. delete the forward leg
    //   4. delete the return leg
    //   5. Disconnect the forward wire row (which IS gesture 3: ConfigPanel emits
    //      `Delete { node: link.wire }`)
    //   6. Disconnect the return wire row (which IS gesture 4)
    //   7. a second Route drawn to the busy Handler (refused, mints nothing)
    //
    // NOT covered, and named rather than left implied: UNDO. Phase 73 owns restoring the
    // pair as one step and this plan does not fix UNDO-01 to UNDO-03, so an undo path to
    // a half-pair is phase 73's to close, not this test's to claim.
    #[derive(Debug)]
    enum Gesture {
        DrawForward,
        DrawReverse,
        DeleteForwardLeg,
        DeleteReturnLeg,
        SecondRouteToBusyHandler,
    }

    for gesture in [
        Gesture::DrawForward,
        Gesture::DrawReverse,
        Gesture::DeleteForwardLeg,
        Gesture::DeleteReturnLeg,
        Gesture::SecondRouteToBusyHandler,
    ] {
        let (mut session, route, handler) = route_and_handler();
        match gesture {
            Gesture::DrawForward => {
                let _ = session.apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_IN));
            }
            Gesture::DrawReverse => {
                let _ = session.apply(draw(&session, handler, HANDLER_OUT, route, ROUTE_IN));
            }
            Gesture::DeleteForwardLeg | Gesture::DeleteReturnLeg => {
                session
                    .apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_IN))
                    .expect("the pair mints");
                let live = wires(&session);
                let leg = match gesture {
                    Gesture::DeleteForwardLeg => live[0].0,
                    _ => live[1].0,
                };
                let node = handle(&session, leg);
                session
                    .apply(GridCommand::Delete { node })
                    .expect("deleting a live wire is accepted");
            }
            Gesture::SecondRouteToBusyHandler => {
                session
                    .apply(draw(&session, route, ROUTE_OUT, handler, HANDLER_IN))
                    .expect("the pair mints");
                let second = place(&mut session, machine_kind::ENDPOINT, 20, 20);
                let _ = session.apply(draw(&session, second, ROUTE_OUT, handler, HANDLER_IN));
            }
        }

        let count = wire_endpoints(&session).len();
        assert!(
            count == 0 || count == 2,
            "gesture {gesture:?} left {count} live wire(s). On a Route-and-Handler board \
             the live wire count is 0 or 2 and NEVER 1: a lone wire IS the forward-only \
             board D-06 rules unreachable"
        );
    }
}
