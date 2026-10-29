//! Phase 73-03 (UNDO-05 groundwork) - THE EDIT LOG NOW SAYS WHICH SLOT A PORT WENT INTO.
//!
//! `EditOp::AddPort` was `{node, port}` and `fold_add_port` pushed, so the inverse of a
//! `RemovePort` could only ever RE-APPEND. Undoing the removal of a middle output put it
//! back LAST and silently renumbered every port after it. Nothing caught that, and the
//! reason is worth stating: the port COUNT came back correct, so every length-based
//! assertion passed. Only the ORDER was wrong, and order is what every belt dock key is.
//!
//! `EditOp::AddPort` now carries `index: PortId`. That is a field on an EXISTING variant,
//! which under postcard shifts every byte after it, so it is one of the two halves of the
//! `EDIT_SCHEMA_VERSION` `7 -> 8` bump this same commit spends.
//!
//! # The forward behaviour deliberately does NOT move, and one test here pins that
//! A forward `GridCommand::AddPort` is the user gesture "add an output", which always
//! appends: `validate_normalize` resolves `index = ports.len()`, so the fold's indexed
//! insert lands exactly where its `push` did. That is what keeps every existing golden
//! fixture's per-tick `hashes.txt` byte-identical across this bump, with only
//! `edit-log.postcard` growing. The wire `GridCommand::AddPort` gains nothing and the
//! cmd-wire `EVENT_VERSION` does not move.

use fabrico_command::GridSession;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{Node, Port, Role};
use fabrico_protocol::{GridCommand, machine_kind, port_medium, port_role};

const SEED: u64 = 0x0073_0003_AD00_0001;

/// Place a machine of `kind` at a cell and return its live `NodeId`.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> NodeId {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("a free in-bounds place is accepted");
    session
        .core()
        .state
        .occupied((cell_x, cell_y))
        .expect("the placed machine occupies its anchor cell")
}

/// The machine's live rot-0 port list.
fn ports_of(session: &GridSession, node: NodeId) -> Vec<Port> {
    session
        .core()
        .state
        .ports_of(node)
        .map(<[Port]>::to_vec)
        .unwrap_or_default()
}

/// One `AddPort` gesture by dense handle: a mechanical `Out` on the E side.
fn add_output(session: &mut GridSession, node: NodeId) {
    let handle = session.view().handle_of(node).expect("the node got a handle");
    session
        .apply(GridCommand::AddPort {
            node: handle,
            role: port_role::OUT,
            side: 1,
            medium: port_medium::MECHANICAL,
        })
        .expect("adding an output to a placed machine is accepted");
}

/// The `index` on the LAST `AddPort` record in the log.
fn last_add_port_index(records: &[EditRecord]) -> PortId {
    records
        .iter()
        .rev()
        .find_map(|r| match &r.op {
            EditOp::AddPort { index, .. } => Some(*index),
            _ => None,
        })
        .expect("the log carries an AddPort record")
}

/// UNDO-05 groundwork, the forward half. A forward `AddPort` freezes the port list length
/// BEFORE the add, which is the append position.
///
/// RED ON HEAD BECAUSE: `EditOp::AddPort` has no `index` field at all on HEAD, so this
/// does not compile there. That is the strongest form of red a shape change can have, and
/// it is why the assertion below reads the index off the RECORD rather than off the board:
/// a board read would still pass on a build that dropped the field.
#[test]
fn a_forward_add_port_records_the_append_index() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    let before = ports_of(&session, router).len();
    assert!(before > 0, "the Router preset seeds a non-empty port list");

    add_output(&mut session, router);

    assert_eq!(
        usize::from(last_add_port_index(session.edit_log())),
        before,
        "the frozen index is the port-list length BEFORE the add, which is the append \
         position - this is what keeps every forward board byte-identical across the bump"
    );
    assert_eq!(
        ports_of(&session, router).len(),
        before + 1,
        "and the fold still appended exactly one port"
    );
}

/// UNDO-05 groundwork, the half the field exists for. The inverse of a `RemovePort` names
/// the index the port came OUT of, not the end of the list.
///
/// RED ON HEAD BECAUSE: on HEAD `compute_inverse`'s `RemovePort` arm emits
/// `EditOp::AddPort { node, port }` with no index at all, and `fold_add_port` pushes. The
/// removed middle output comes back LAST. This test does not compile on HEAD for the same
/// shape reason as the one above, and the BEHAVIOUR it asserts is wrong there too.
#[test]
fn the_remove_port_inverse_names_the_index_the_port_came_out_of() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    // Grow to at least three Outs so index 1 is genuinely a MIDDLE slot: an inverse that
    // re-appends and an inverse that re-inserts are indistinguishable on the last one.
    while ports_of(&session, router)
        .iter()
        .filter(|p| p.role == Role::Out)
        .count()
        < 3
    {
        add_output(&mut session, router);
    }
    let before = ports_of(&session, router);
    let handle = session.view().handle_of(router).expect("the router got a handle");

    // Remove the port at index 1 - a middle slot with real ports on both sides of it.
    session
        .apply(GridCommand::RemovePort {
            node: handle,
            index: 1,
        })
        .expect("removing an in-range port is accepted");
    assert_eq!(
        ports_of(&session, router).len(),
        before.len() - 1,
        "the removal took exactly one port"
    );

    session
        .apply(GridCommand::Undo)
        .expect("undoing a port removal is buildable");

    // THE RECORD, not the board: the emitted inverse must NAME the slot. A board-only
    // assertion would pass on a build that appended and then happened to re-seat.
    assert_eq!(
        usize::from(last_add_port_index(session.edit_log())),
        1,
        "the RemovePort inverse emits an AddPort carrying index 1, the slot the port came \
         out of - not ports.len(), which is what it emitted before this plan"
    );

    // AND the board, by POSITION and never by count. A count of 3 Outs is satisfied by
    // the exact defect this closes: the removed output re-appended at the end.
    let after = ports_of(&session, router);
    assert_eq!(
        after.iter().map(|p| p.role).collect::<Vec<_>>(),
        before.iter().map(|p| p.role).collect::<Vec<_>>(),
        "one Ctrl+Z put the port back in its ORIGINAL slot, so the whole role sequence is \
         the one that was there before the removal"
    );
    assert_eq!(
        after[1].medium, before[1].medium,
        "and the restored port kept its medium, not just its role"
    );
}

/// The redo half, asserted because a redo that dropped the index would put the port back
/// at the end on the SECOND press and nothing above would notice.
///
/// RED ON HEAD BECAUSE: same shape reason - the field does not exist there.
#[test]
fn redo_of_a_port_removal_carries_the_index_through() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    while ports_of(&session, router)
        .iter()
        .filter(|p| p.role == Role::Out)
        .count()
        < 3
    {
        add_output(&mut session, router);
    }
    let handle = session.view().handle_of(router).expect("the router got a handle");
    let before = ports_of(&session, router);

    session
        .apply(GridCommand::RemovePort {
            node: handle,
            index: 1,
        })
        .expect("removing an in-range port is accepted");
    let after_remove = ports_of(&session, router);

    session.apply(GridCommand::Undo).expect("undo is buildable");
    session.apply(GridCommand::Redo).expect("redo is buildable");

    assert_eq!(
        ports_of(&session, router)
            .iter()
            .map(|p| p.role)
            .collect::<Vec<_>>(),
        after_remove.iter().map(|p| p.role).collect::<Vec<_>>(),
        "redo re-applies the removal, landing on the same list the removal produced"
    );

    session.apply(GridCommand::Undo).expect("undo is buildable again");
    assert_eq!(
        ports_of(&session, router)
            .iter()
            .map(|p| p.role)
            .collect::<Vec<_>>(),
        before.iter().map(|p| p.role).collect::<Vec<_>>(),
        "and a second undo still puts the port back in its ORIGINAL slot, so the index \
         survived the whole undo/redo/undo round trip rather than only the first press"
    );
}

/// A live `Node::Router` is what the fixtures above assume; asserted once so a change to
/// the preset shows up here as a named failure rather than as three confusing ones.
#[test]
fn the_test_board_is_a_router_with_a_port_list_worth_indexing() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, 0, 0);
    assert!(
        matches!(session.core().state.node(router), Some(Node::Router(_))),
        "the board these tests index into is a Router"
    );
    assert!(
        ports_of(&session, router).len() >= 2,
        "with a port list long enough for a middle slot to exist"
    );
}
