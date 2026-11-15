//! What an edit does to the items already on a belt, measured on a running grid.
//!
//! The docs page "Editing a running board" states one rule per edit, and each rule names a
//! test in this file. The claims, one test per row:
//!
//! | Edit on a belt carrying 3 items | Items on the belt after the run | Delivered |
//! |---|---|---|
//! | none (the control) | 0 | 3 |
//! | turn the Sink away, so its input no longer faces the belt's head | 3 | 0, then 3 after turning back |
//! | unlink the belt's head from the Sink | 3 | 0, then 3 after Undo |
//! | unlink the belt's tail from the Source | 0 | 3 |
//! | turn the Source away, so its output no longer faces the belt's tail | 0 | 3 |
//! | delete the Sink | the belt goes with it, 0 items anywhere | 0; Undo puts back the Sink, both docks and an empty belt |
//! | delete the belt | the belt and its items are gone | 0; Undo puts back an empty belt |
//!
//! A cut at the receiving end holds the items, a cut at the feeding end doesn't stop them,
//! and only a delete drops them.
//!
//! Run target: `cargo test -p fabrico-command --test items_in_transit`.
//!
//! # The assertion discipline
//! The items reach the belt through real runtime events (`pump` with `ManualInject` into the
//! Source), never by writing belt slots, so a build that loses or teleports an item on its
//! way onto the belt fails the fixture. Every test first asserts the belt holds exactly 3
//! items and that none has reached the Sink yet; an empty count after an edit can't then
//! pass on a fixture that never loaded anything. The Sink's deliveries are read as the Debug
//! effect payloads, in order, so a build that delivers the wrong item, a duplicate, or only
//! some of them fails on the payload list, not just on a count.
//!
//! The run length is derived from the belt's traverse time, because it is a budget; the
//! expected counts are pinned numbers, because a count that re-derives is a tautology.
//!
//! # Watched failing
//! Three planted engine changes, made in a throwaway worktree and never committed, turned
//! rows here red: `fold_unlink` clearing the belt's slots failed both unlink rows; a turn
//! that clears the slots of the belts it undocks failed both turn rows; and a machine
//! delete that leaves its docked belts in place failed the delete-the-Sink row.

use std::collections::BTreeSet;

use fabrico_command::GridSession;
use fabrico_core::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE};
use fabrico_core::command::Effect;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::state::Node;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0098_0007_0000_0001;

/// The belt runs over this many cells between the Source and the Sink.
const BELT_CELLS: u32 = 8;

/// Ticks between two loaded items, so the three sit apart on the belt.
const LOAD_GAP: u64 = 6;

/// Ticks each test runs after its edit. Three times the time an item takes to cross the
/// whole belt, so every item that can arrive has arrived; it re-derives with the slot rate
/// because it is a budget.
const RUN: u64 = 3 * (SLOTS_PER_TILE * BELT_CELLS) as u64 * DEFAULT_TICKS_PER_SLOT.get() as u64;

/// One directed link, `(from_node, from_port) -> (to_node, to_port)`.
type Link = ((NodeId, PortId), (NodeId, PortId));

/// A Source, an 8-cell belt and a Debug Sink, both belt ends docked, with 3 items loaded.
struct Line {
    session: GridSession,
    source_h: u64,
    source: NodeId,
    sink_h: u64,
    sink: NodeId,
    belt_h: u64,
    belt: NodeId,
}

/// The payloads the three loaded items carry, in the order they were sent.
fn loaded_payloads() -> Vec<Vec<u8>> {
    (0..3u8).map(|i| vec![b'a' + i]).collect()
}

fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> (u64, NodeId) {
    session
        .apply(GridCommand::Place {
            kind,
            cell_x,
            cell_y,
        })
        .expect("placement accepted");
    let id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the place minted a node");
    let handle = session
        .view()
        .handle_of(id)
        .expect("the minted node got a handle");
    (handle, id)
}

fn inject(target: NodeId, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::ManualInject {
            target,
            port: 0,
            item,
        },
    }
}

/// Build the line and load it. Asserts the load: 3 items on the belt, none delivered.
fn loaded_line() -> Line {
    let mut session = GridSession::new(SEED);
    let (source_h, source) = place(&mut session, machine_kind::SOURCE, 0, 0);
    let end_x = i32::try_from(BELT_CELLS).expect("small") + 1;
    let (sink_h, sink) = place(&mut session, machine_kind::SINK, end_x, 0);
    let cells: Vec<(i32, i32)> = (1..end_x).map(|x| (x, 0)).collect();
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear belt path is accepted");
    let belt = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the DrawBelt minted a belt");
    let belt_h = session
        .view()
        .handle_of(belt)
        .expect("the belt got a handle");
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: BeltEnd::Tail,
            node: source_h,
            port: 0,
        })
        .expect("the tail docks on the Source's output");
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: BeltEnd::Head,
            node: sink_h,
            port: 0,
        })
        .expect("the head docks on the Sink's input");

    let mut line = Line {
        session,
        source_h,
        source,
        sink_h,
        sink,
        belt_h,
        belt,
    };
    for payload in loaded_payloads() {
        let stamped = line.session.pump(&[inject(line.source, Item(payload))]);
        assert_eq!(
            stamped.len(),
            1,
            "the ManualInject into the Source was logged"
        );
        line.session.advance(LOAD_GAP);
    }
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(3),
        "the fixture loaded 3 items onto the belt, without which every held or dropped count \
         below would pass on an empty belt"
    );
    assert_eq!(
        line.session.core().state.belt_items_in_flight(),
        3,
        "and nowhere else"
    );
    assert!(
        delivered(&mut line.session).is_empty(),
        "no item has reached the Sink yet, so every delivery counted later is caused by the run \
         after the edit"
    );
    line
}

/// Items in the belt's slots, or `None` when the belt is gone.
fn on_belt(session: &GridSession, belt: NodeId) -> Option<usize> {
    match session.core().state.node(belt) {
        Some(Node::Belt(b)) => Some(b.slots.iter().filter(|s| s.is_some()).count()),
        _ => None,
    }
}

/// The Debug Sink's deliveries since the last call, as payloads in order.
fn delivered(session: &mut GridSession) -> Vec<Vec<u8>> {
    session
        .drain_effects()
        .into_iter()
        .filter_map(|c| match c.effect {
            Effect::Debug { message } => Some(message),
            _ => None,
        })
        .collect()
}

fn links(session: &GridSession) -> BTreeSet<Link> {
    session.core().state.links_iter().collect()
}

/// The one live node matching `pick`, which the delete-and-undo rows use to find the
/// re-minted Sink and belt (an undo mints new ids).
fn only_node(session: &GridSession, pick: fn(&Node) -> bool) -> Option<NodeId> {
    let found: Vec<NodeId> = session
        .core()
        .state
        .node_ids()
        .filter(|id| session.core().state.node(*id).is_some_and(pick))
        .collect();
    assert!(
        found.len() <= 1,
        "at most one node of the kind under test: {found:?}"
    );
    found.first().copied()
}

fn is_belt(n: &Node) -> bool {
    matches!(n, Node::Belt(_))
}

fn is_sink(n: &Node) -> bool {
    matches!(n, Node::Sink(_))
}

/// `links` with every `from` id swapped for its `to` id.
fn renamed(links: &BTreeSet<Link>, swaps: &[(NodeId, NodeId)]) -> BTreeSet<Link> {
    let swap = |id: NodeId| {
        swaps
            .iter()
            .find(|(from, _)| *from == id)
            .map_or(id, |(_, to)| *to)
    };
    links
        .iter()
        .map(|((a, ap), (b, bp))| ((swap(*a), *ap), (swap(*b), *bp)))
        .collect()
}

#[test]
fn with_nothing_cut_all_three_items_arrive() {
    let mut line = loaded_line();
    line.session.advance(RUN);
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(0),
        "the belt emptied into the Sink"
    );
    assert_eq!(
        delivered(&mut line.session),
        loaded_payloads(),
        "all 3 arrived, in order"
    );
}

#[test]
fn turning_the_sink_away_holds_the_items_and_turning_it_back_delivers_them() {
    let mut line = loaded_line();
    line.session
        .apply(GridCommand::Rotate {
            node: line.sink_h,
            ccw: false,
        })
        .expect("the Sink turns a quarter-turn clockwise");
    assert_eq!(
        links(&line.session).len(),
        1,
        "the turn took the belt's head off the Sink and left the tail docked"
    );
    line.session.advance(RUN);
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(3),
        "all 3 items wait on the belt"
    );
    assert!(
        delivered(&mut line.session).is_empty(),
        "none reached the Sink while it faced away"
    );

    line.session
        .apply(GridCommand::Rotate {
            node: line.sink_h,
            ccw: true,
        })
        .expect("the Sink turns back");
    assert_eq!(
        links(&line.session).len(),
        2,
        "turning back docked the head again"
    );
    line.session.advance(RUN);
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(0),
        "the waiting items moved in"
    );
    assert_eq!(
        delivered(&mut line.session),
        loaded_payloads(),
        "all 3 arrived, in order"
    );
}

#[test]
fn unlinking_the_head_holds_the_items_and_undo_delivers_them() {
    let mut line = loaded_line();
    line.session
        .apply(GridCommand::Unlink {
            belt: line.belt_h,
            endpoint: BeltEnd::Head,
            node: line.sink_h,
            port: 0,
        })
        .expect("the head unlinks from the Sink");
    assert_eq!(links(&line.session).len(), 1, "only the tail stays docked");
    line.session.advance(RUN);
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(3),
        "all 3 items wait on the belt"
    );
    assert!(
        delivered(&mut line.session).is_empty(),
        "none reached the Sink while unlinked"
    );

    line.session
        .apply(GridCommand::Undo)
        .expect("the Unlink can be undone");
    assert_eq!(
        links(&line.session).len(),
        2,
        "the undo docked the head again"
    );
    line.session.advance(RUN);
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(0),
        "the waiting items moved in"
    );
    assert_eq!(
        delivered(&mut line.session),
        loaded_payloads(),
        "all 3 arrived, in order"
    );
}

#[test]
fn unlinking_the_tail_leaves_the_items_moving() {
    let mut line = loaded_line();
    line.session
        .apply(GridCommand::Unlink {
            belt: line.belt_h,
            endpoint: BeltEnd::Tail,
            node: line.source_h,
            port: 0,
        })
        .expect("the tail unlinks from the Source");
    assert_eq!(links(&line.session).len(), 1, "only the head stays docked");
    line.session.advance(RUN);
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(0),
        "the items kept moving"
    );
    assert_eq!(
        delivered(&mut line.session),
        loaded_payloads(),
        "all 3 arrived, in order"
    );
}

#[test]
fn turning_the_source_away_leaves_the_items_moving() {
    let mut line = loaded_line();
    line.session
        .apply(GridCommand::Rotate {
            node: line.source_h,
            ccw: false,
        })
        .expect("the Source turns a quarter-turn clockwise");
    assert_eq!(
        links(&line.session).len(),
        1,
        "the turn took the belt's tail off the Source and left the head docked"
    );
    line.session.advance(RUN);
    assert_eq!(
        on_belt(&line.session, line.belt),
        Some(0),
        "the items kept moving"
    );
    assert_eq!(
        delivered(&mut line.session),
        loaded_payloads(),
        "all 3 arrived, in order"
    );
}

#[test]
fn deleting_the_sink_deletes_its_belt_and_items_and_undo_brings_the_belt_back_empty() {
    let mut line = loaded_line();
    let before = links(&line.session);
    assert_eq!(
        before.len(),
        2,
        "both belt ends are docked before the delete"
    );

    line.session
        .apply(GridCommand::Delete { node: line.sink_h })
        .expect("the Sink deletes");
    assert_eq!(only_node(&line.session, is_sink), None, "the Sink is gone");
    assert_eq!(
        on_belt(&line.session, line.belt),
        None,
        "the belt docked to it went too"
    );
    assert_eq!(
        only_node(&line.session, is_belt),
        None,
        "and no other belt stands in for it"
    );
    assert_eq!(
        line.session.core().state.belt_items_in_flight(),
        0,
        "0 items anywhere"
    );
    assert!(links(&line.session).is_empty(), "no link is left");
    line.session.advance(RUN);
    assert!(
        delivered(&mut line.session).is_empty(),
        "no item was delivered"
    );

    line.session
        .apply(GridCommand::Undo)
        .expect("the delete can be undone");
    let sink = only_node(&line.session, is_sink).expect("the undo put back the Sink");
    let belt = only_node(&line.session, is_belt).expect("and its belt");
    assert_eq!(
        links(&line.session),
        renamed(&before, &[(line.sink, sink), (line.belt, belt)]),
        "both docks came back as they were"
    );
    let slots = match line.session.core().state.node(belt) {
        Some(Node::Belt(b)) => b.slots.len(),
        _ => 0,
    };
    assert!(
        slots > 0,
        "the restored belt has slots, so the empty count below means something"
    );
    assert_eq!(
        on_belt(&line.session, belt),
        Some(0),
        "the restored belt is empty"
    );
    assert_eq!(
        line.session.core().state.belt_items_in_flight(),
        0,
        "nothing came back anywhere"
    );
    line.session.advance(RUN);
    assert!(
        delivered(&mut line.session).is_empty(),
        "the dropped items never reach the Sink"
    );
}

#[test]
fn deleting_the_belt_drops_its_items_and_undo_brings_it_back_empty() {
    let mut line = loaded_line();
    let before = links(&line.session);

    line.session
        .apply(GridCommand::Delete { node: line.belt_h })
        .expect("the belt deletes");
    assert_eq!(on_belt(&line.session, line.belt), None, "the belt is gone");
    assert_eq!(
        line.session.core().state.belt_items_in_flight(),
        0,
        "with its 3 items"
    );
    assert_eq!(
        only_node(&line.session, is_sink),
        Some(line.sink),
        "the Sink stays"
    );
    line.session.advance(RUN);
    assert!(
        delivered(&mut line.session).is_empty(),
        "no item was delivered"
    );

    line.session
        .apply(GridCommand::Undo)
        .expect("the delete can be undone");
    let belt = only_node(&line.session, is_belt).expect("the undo put back the belt");
    assert_eq!(
        links(&line.session),
        renamed(&before, &[(line.belt, belt)]),
        "both docks came back as they were"
    );
    let slots = match line.session.core().state.node(belt) {
        Some(Node::Belt(b)) => b.slots.len(),
        _ => 0,
    };
    assert!(
        slots > 0,
        "the restored belt has slots, so the empty count below means something"
    );
    assert_eq!(
        on_belt(&line.session, belt),
        Some(0),
        "the restored belt is empty"
    );
    line.session.advance(RUN);
    assert!(
        delivered(&mut line.session).is_empty(),
        "the dropped items never reach the Sink"
    );
}
