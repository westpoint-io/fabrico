//! Phase 76 (SHAPE-11, D-03): a Label is INERT. A board that carries one replays exactly the
//! same item flow, tick for tick, as the same board without it, and placing one draws no
//! random number.
//!
//! # How the comparison is made, and why by node identity
//! Three boards are built through the real command surface (`GridSession::apply`): a
//! Source, a three-tile belt and a Sink, docked end to end, with NO label, with a label
//! placed BEFORE the flow's nodes, and with a label placed AFTER them (once items are
//! already on the belt). Each board's frozen edit log and event log are then folded into a
//! FRESH `Core::genesis` through `advance_edits`, one tick at a time, which is the fold
//! every replay performs. The flow nodes are found in each Core by their CELL (the Source
//! at (0,0), the belt at (1,0), the Sink at (4,0)), never by matching ids: a label minted
//! first takes the id the Source would have had, so every later id shifts, and a
//! comparison keyed by id would compare different machines. Whole-core hashes are never
//! compared either, because the label's own node, cells and inbox are in the core by
//! design. What is compared, per tick over 50 ticks from the first fire:
//! - the belt's slot occupancy (which item sits in which slot);
//! - the ordered effects the Sink emitted that tick (the items it received, in order);
//! - the inboxes of the three flow nodes only.
//!
//! # Why the board stays RNG-free, and why there is a separate RNG clause
//! A Factory's `ctx.random` substream is seeded from its OWN `NodeId`, so ANY node minted
//! before a Factory (a label or a machine) changes that id and so that substream. That is
//! a property of id-keyed seeding, not something a label does to items (76-RESEARCH
//! Pitfall 5), so this board carries no Factory and its items are a pure function of the
//! log.
//!
//! That same choice makes the flow comparison BLIND to the hazard D-03 names: a label fold
//! arm that called `core.rng.next_u64()` would change nothing on an RNG-free board, and every
//! flow observable would stay equal. The RNG clause closes that gap: it asserts `core.rng`
//! is equal between the with-label and the without-label Core at the tick boundary right
//! after the label's `Place` folds, in both orders.
//!
//! MUTATION (run 2026-10-07 in a throwaway worktree, reverted): one `core.rng.next_u64()`
//! added to `fold_place`'s LABEL arm. `placing_a_label_draws_no_random_number_in_either_order`
//! reddened with "Before: the global sim RNG differs right after the label's Place folded at
//! tick 0. ..." while `a_label_changes_no_item_flow_placed_before_or_after_the_flow` stayed
//! GREEN: every flow observable was unchanged by the draw. That green is the reason the RNG
//! clause exists - without it the D-03 hazard is invisible to this file.
//!
//! Run target: `cargo test -p fabrico-core --test label_inert`

mod common;

use common::{fire, header};
use fabrico_command::GridSession;
use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::command::Effect;
use fabrico_core::core::Core;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::event::Event;
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::rng::SimRng;
use fabrico_core::state::{LABEL_PLACED_FOOTPRINT, Node, PortInbox};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0x0076_1AB3;

/// The flow's cells. The belt runs E from the Source's Out to the Sink's In.
const SOURCE_CELL: (i32, i32) = (0, 0);
const BELT_CELLS: [(i32, i32); 3] = [(1, 0), (2, 0), (3, 0)];
const SINK_CELL: (i32, i32) = (4, 0);
/// The label's anchor: the row directly below the belt, so its 4 by 1 box runs beside
/// (1,0) to (4,0) without touching a flow cell.
const LABEL_CELL: (i32, i32) = (1, 1);

/// The tick the first item is fired on, identical on every board. The setup takes five
/// ticks on the no-label board and six on the other two; the no-label board spends its
/// sixth tick idle so every board's flow starts on the same tick.
const FLOW_START: u64 = 6;
/// How many items are fired, one every `DEFAULT_TICKS_PER_SLOT` ticks.
const ITEMS: u64 = 6;
/// The ticks observed from `FLOW_START`.
const OBSERVED_TICKS: u64 = 50;
/// For the AFTER board: the label is placed after this many items have been fired, so it
/// lands while items are on the belt.
const LABEL_AFTER_ITEMS: u64 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Order {
    /// No label at all.
    None,
    /// The label is the first node minted, before the Source.
    Before,
    /// The label is minted after every flow node, while items are already in flight.
    After,
}

/// One board's frozen logs, plus the tick the label's `Place` folded on (if any).
struct Board {
    edits: Vec<EditRecord>,
    events: Vec<Event>,
    label_tick: Option<u64>,
}

fn place(session: &mut GridSession, kind: u8, (x, y): (i32, i32)) -> u64 {
    session
        .apply(GridCommand::Place { kind, cell_x: x, cell_y: y })
        .expect("place at a free cell");
    let id = *session.core().last_tick.placed.last().expect("minted");
    session.view().handle_of(id).expect("live node has a handle")
}

fn place_label(session: &mut GridSession) -> u64 {
    let tick = session.core().tick;
    place(session, machine_kind::LABEL, LABEL_CELL);
    tick
}

/// Build one board through the command surface and return its frozen logs.
fn build(order: Order) -> Board {
    let mut session = GridSession::new(SEED);
    let mut label_tick = None;
    if order == Order::Before {
        label_tick = Some(place_label(&mut session));
    }
    let src = place(&mut session, machine_kind::SOURCE, SOURCE_CELL);
    session
        .apply(GridCommand::DrawBelt { cells: BELT_CELLS.to_vec() })
        .expect("draw the belt");
    let belt_id = *session.core().last_tick.placed.last().expect("belt minted");
    let belt = session.view().handle_of(belt_id).expect("belt handle");
    let sink = place(&mut session, machine_kind::SINK, SINK_CELL);
    session
        .apply(GridCommand::Dock { belt, endpoint: BeltEnd::Tail, node: src, port: 0 })
        .expect("offload-dock the belt tail to the source Out");
    session
        .apply(GridCommand::Dock { belt, endpoint: BeltEnd::Head, node: sink, port: 0 })
        .expect("load-dock the belt head into the sink In");
    if order != Order::Before {
        // The no-label and AFTER boards took one tick fewer to set up; spend it idle so
        // every board fires its first item on FLOW_START.
        session.advance(1);
    }
    assert_eq!(session.core().tick, FLOW_START, "every board's flow starts on one tick");

    let src_id = session.core().state.occupied(SOURCE_CELL).expect("the source");
    let interval = u64::from(DEFAULT_TICKS_PER_SLOT.get());
    for i in 0..ITEMS {
        if i == LABEL_AFTER_ITEMS {
            if order == Order::After {
                // A Place costs exactly one tick; the other two boards idle that tick.
                label_tick = Some(place_label(&mut session));
            } else {
                session.advance(1);
            }
        }
        session.pump(&[fire(src_id, i + 1, 0, Item(vec![b'L', i as u8]))]);
        session.advance(interval - 1);
    }
    Board {
        edits: session.edit_log().to_vec(),
        events: session.event_log().to_vec(),
        label_tick,
    }
}

/// What a flow looks like at one tick boundary, read by ROLE (cell), never by id.
#[derive(Debug, PartialEq, Eq)]
struct Observation {
    tick: u64,
    belt_slots: Vec<Option<Item>>,
    sink_effects: Vec<Effect>,
    inboxes: [PortInbox; 3],
}

fn node_at(core: &Core, cell: (i32, i32)) -> NodeId {
    core.state
        .occupied(cell)
        .unwrap_or_else(|| panic!("a flow node owns {cell:?} at tick {}", core.tick))
}

fn observe(core: &Core, sink_effects: Vec<Effect>) -> Observation {
    let src = node_at(core, SOURCE_CELL);
    let belt = node_at(core, BELT_CELLS[0]);
    let sink = node_at(core, SINK_CELL);
    let belt_slots = match core.state.node(belt) {
        Some(Node::Belt(b)) => b.slots.clone(),
        other => panic!("expected the belt at {:?}, got {other:?}", BELT_CELLS[0]),
    };
    let inbox = |id: NodeId| core.state.inbox_of(id).cloned().expect("a flow node has an inbox");
    Observation {
        tick: core.tick,
        belt_slots,
        sink_effects,
        inboxes: [inbox(src), inbox(belt), inbox(sink)],
    }
}

/// Fold `board`'s frozen logs into a fresh genesis Core one tick at a time. Returns the
/// per-tick observations from `FLOW_START` on, and the RNG state at the tick boundary
/// right after the label's `Place` folded (the tick after `label_tick`), or at that same
/// boundary for a board given `rng_probe_at` without a label of its own.
fn replay(board: &Board, rng_probe_at: &[u64]) -> (Vec<Observation>, Vec<(u64, SimRng)>) {
    let mut core = Core::genesis(header(SEED));
    let mut observations = Vec::new();
    let mut probes = Vec::new();
    while core.tick < FLOW_START + OBSERVED_TICKS {
        let edits: Vec<EditRecord> =
            board.edits.iter().filter(|r| r.tick == core.tick).cloned().collect();
        let events: Vec<Event> =
            board.events.iter().filter(|e| e.tick == core.tick).cloned().collect();
        let folded_tick = core.tick;
        let commands = core.advance_edits(&edits, &events);
        if rng_probe_at.contains(&folded_tick) {
            probes.push((folded_tick, core.rng.clone()));
        }
        if core.tick > FLOW_START {
            let effects = commands.into_iter().map(|c| c.effect).collect();
            observations.push(observe(&core, effects));
        }
    }
    (observations, probes)
}

/// The label's record in a board's edit log is a `Place` of kind 11 with the shared box
/// and no ports, written out here from `LABEL_PLACED_FOOTPRINT` rather than read back from
/// the command catalog, so a catalog drift is visible in this file.
fn assert_label_record(board: &Board) {
    let tick = board.label_tick.expect("this board places a label");
    let labels: Vec<&EditRecord> = board
        .edits
        .iter()
        .filter(|r| matches!(r.op, EditOp::Place { kind, .. } if kind == machine_kind::LABEL))
        .collect();
    assert_eq!(labels.len(), 1, "exactly one label Place in the log");
    assert_eq!(labels[0].tick, tick, "the label Place is stamped on the tick it folded");
    match &labels[0].op {
        EditOp::Place { kind, cell_x, cell_y, w, h, ports, rot } => {
            assert_eq!(*kind, 11, "the label kind byte is 11 (HANDLER took 10)");
            assert_eq!((*cell_x, *cell_y), LABEL_CELL);
            assert_eq!((*w, *h), (LABEL_PLACED_FOOTPRINT.w, LABEL_PLACED_FOOTPRINT.h));
            assert_eq!((*w, *h), (4, 1), "a placed label is 4 by 1");
            assert!(ports.is_empty(), "a label Place carries no ports");
            assert_eq!(*rot, 0, "a placed label is unturned (EDIT 13 carries the rotation)");
        }
        other => panic!("expected a Place, got {other:?}"),
    }
}

#[test]
fn a_label_changes_no_item_flow_placed_before_or_after_the_flow() {
    let none = build(Order::None);
    let (baseline, _) = replay(&none, &[]);
    // NON-VACUITY: the comparison below must be over a flow that actually moved items,
    // and an item must actually have reached the sink, or equality is over nothing.
    assert!(
        baseline.iter().any(|o| o.belt_slots.iter().any(Option::is_some)),
        "items rode the belt on the no-label board"
    );
    let delivered = baseline.iter().map(|o| o.sink_effects.len()).sum::<usize>();
    assert!(delivered >= 1, "the sink received at least one item on the no-label board");
    assert_eq!(baseline.len(), OBSERVED_TICKS as usize, "one observation per tick");

    for order in [Order::Before, Order::After] {
        let board = build(order);
        assert_label_record(&board);
        let (with_label, _) = replay(&board, &[]);
        // The label is really on this board for every observed tick.
        let mut core = Core::genesis(header(SEED));
        core.run_log_two_logs(&board.edits, &board.events).expect("replays");
        let label = core.state.occupied(LABEL_CELL).expect("the label owns its anchor");
        assert!(
            matches!(core.state.node(label), Some(Node::Label(_))),
            "{order:?}: the node at {LABEL_CELL:?} is a Node::Label"
        );
        assert_eq!(baseline.len(), with_label.len(), "{order:?}: same observation count");
        for (a, b) in baseline.iter().zip(&with_label) {
            assert_eq!(
                a, b,
                "{order:?}: the flow diverged at tick {} with a label on the board (SHAPE-11)",
                a.tick
            );
        }
    }
}

#[test]
fn placing_a_label_draws_no_random_number_in_either_order() {
    let none = build(Order::None);
    for order in [Order::Before, Order::After] {
        let board = build(order);
        let tick = board.label_tick.expect("this board places a label");
        let (_, with) = replay(&board, &[tick]);
        let (_, without) = replay(&none, &[tick]);
        assert_eq!(with.len(), 1, "{order:?}: probed once, right after the label Place");
        assert_eq!(without.len(), 1, "{order:?}: the no-label board probed at the same tick");
        assert!(
            with[0].1 == without[0].1,
            "{order:?}: the global sim RNG differs right after the label's Place folded at \
             tick {tick}. A draw in the label's fold arm shifts every later Factory's sub-seed \
             (D-03), and the flow comparison cannot see it on an RNG-free board."
        );
    }
}

// ---------------------------------------------------------------------------
// Plan 86-07 (D-08, WORK-09): the connect folds never join a label to anything
// ---------------------------------------------------------------------------
//
// A label is a note. Validation refuses every gesture that would give one a port, dock a
// belt to one or draw a cable to or from one (`LabelDoesNotConnect`, plan 76-04), so only a
// forged log reaches the folds with a label named. Each leg below folds ONE such forged
// record onto a real board and requires the board's snapshot bytes equal those of a twin
// that folded an empty tick instead, and the label named in
// `last_tick.refused_label_connects`.
//
// RED BEFORE THE FOLD CHANGE (plan 86-07 task 2, `shapes-red.out`): every Dock and DrawWire
// leg linked or minted against the label. The AddPort leg was mutation-proved instead (its
// fold guard landed in task 1; with the guard removed in a throwaway worktree the leg reads
// the label holding the port).

/// A real board (the flow board's Source, belt and Sink, docked end to end) with a label
/// below the belt, built through `GridSession::apply`. Returns the core and the ids of the
/// label, the belt and the Source.
fn connect_board() -> (Core, NodeId, NodeId, NodeId) {
    let board = build(Order::After);
    let mut core = Core::genesis(header(SEED));
    let last = board.edits.iter().map(|r| r.tick).max().expect("the board has edits");
    while core.tick <= last {
        let edits: Vec<EditRecord> =
            board.edits.iter().filter(|r| r.tick == core.tick).cloned().collect();
        let events: Vec<Event> =
            board.events.iter().filter(|e| e.tick == core.tick).cloned().collect();
        core.advance_edits(&edits, &events);
    }
    let label = node_at(&core, LABEL_CELL);
    assert!(matches!(core.state.node(label), Some(Node::Label(_))), "measured: a label at (1,1)");
    let belt = node_at(&core, BELT_CELLS[0]);
    assert!(matches!(core.state.node(belt), Some(Node::Belt(_))), "measured: a belt at (1,0)");
    let source = node_at(&core, SOURCE_CELL);
    (core, label, belt, source)
}

/// Fold `op` as one forged record at the core's tick, beside a twin that folds an empty
/// tick, and return (the two snapshots equal, the labels the fold refused).
fn fold_forged(core: &Core, op: EditOp) -> (bool, Vec<NodeId>) {
    let mut forged = core.clone();
    let mut twin = core.clone();
    let record = EditRecord {
        schema_version: fabrico_core::edit::EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: u64::MAX,
        tick: forged.tick,
        action: u64::MAX,
        op,
    };
    forged.advance_edits(std::slice::from_ref(&record), &[]);
    twin.advance_edits(&[], &[]);
    let same = fabrico_core::snapshot::snapshot(&forged) == fabrico_core::snapshot::snapshot(&twin);
    (same, forged.last_tick.refused_label_connects.clone())
}

#[test]
fn a_forged_add_port_on_a_label_changes_nothing_and_is_recorded() {
    let (core, label, _belt, _source) = connect_board();
    let op = EditOp::AddPort {
        node: label,
        port: fabrico_core::state::Port {
            local_offset: (0, 0),
            side: fabrico_core::state::Side::E,
            role: fabrico_core::state::Role::Out,
            medium: fabrico_core::state::Medium::Mechanical,
        },
        index: 0,
        seat: fabrico_core::edit::PortSeat::Auto,
    };
    assert_eq!(fold_forged(&core, op), (true, vec![label]), "an AddPort on a label is a recorded no-op");
}

#[test]
fn a_forged_dock_into_a_label_changes_nothing_and_is_recorded() {
    let (core, label, belt, _source) = connect_board();
    for (endpoint, port, what) in [
        (fabrico_core::edit::BeltEnd::Head, 0, "the belt's head into the label"),
        (fabrico_core::edit::BeltEnd::Tail, 0, "the belt's tail from the label"),
        (fabrico_core::edit::BeltEnd::Head, fabrico_core::fault::FAULT_PORT, "the label's fault port"),
    ] {
        let op = EditOp::Dock { belt, endpoint, node: label, port };
        assert_eq!(fold_forged(&core, op), (true, vec![label]), "a Dock of {what} is a recorded no-op");
    }
}

#[test]
fn a_forged_cable_to_or_from_a_label_changes_nothing_and_is_recorded() {
    let (core, label, _belt, source) = connect_board();
    let from_label = EditOp::DrawWire { from_node: label, from_port: 0, to_node: source, to_port: 0 };
    assert_eq!(fold_forged(&core, from_label), (true, vec![label]), "a cable from a label is a recorded no-op");
    let to_label = EditOp::DrawWire { from_node: source, from_port: 0, to_node: label, to_port: 0 };
    assert_eq!(fold_forged(&core, to_label), (true, vec![label]), "a cable to a label is a recorded no-op");
}
