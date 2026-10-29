//! 87-REVIEW CR-01, the command half: a Factory's waiting emits follow their Out port when
//! a port edit renumbers the Outs, a removed port's waiting emits are dropped AND counted,
//! and one Undo puts the surviving queue back on the key it came from.
//!
//! Since plan 87-04 a Factory keeps the emits of one run beyond the first per port in
//! `Factory::pending_emits`, keyed by the Out routing key. Removing an earlier Out
//! renumbers every later one, and until the review fix the re-key went through
//! `GridState::unlink`, which threw the later port's queue away with its belt still
//! docked, and counted nothing.
//!
//! # Every row drives the PUBLIC `GridSession` seam
//! `Place`, `AddPort`, `Configure`, `DrawBelt`, `Dock`, a pumped `Input`, `RemovePort` and
//! `Undo`: the same producer the UI is. At each step the board is saved and reopened two
//! ways: the snapshot trust gate (`snapshot::restore`) and a replay of the session's two
//! logs from genesis, which must reproduce the live core byte for byte.
//!
//! Run target: `cargo test -p fabrico-command --test factory_queue_follows_its_port`.

use fabrico_command::GridSession;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::snapshot;
use fabrico_core::state::{Node, Role};
use fabrico_protocol::{BeltEnd, GridCommand, MachineConfig, machine_kind};

const SEED: u64 = 0x87_C0_01;

/// Six emits per run on each of Out keys 0 and 1, so five wait on each after one run.
const SIX_ON_0_AND_1_JS: &str =
    "export default function (input, ctx) { for (const p of [0, 1]) { for (let i = 0; i < 6; i++) { ctx.emit(p, input); } } }";

/// The board: a Factory with two docked Outs, five emits waiting on each.
struct Board {
    session: GridSession,
    factory: NodeId,
    factory_h: u64,
    /// The belt on Out key 0 (catalog index 1), the one the removal releases.
    on_0: NodeId,
    /// The belt on Out key 1 (catalog index 3), the one the removal re-keys to 0.
    on_1: NodeId,
}

fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> (NodeId, u64) {
    session.apply(GridCommand::DrawBelt { cells }).expect("a clear drawn path is accepted");
    let id = *session.core().last_tick.placed.last().expect("the belt was minted");
    (id, session.view().handle_of(id).expect("the belt got a handle"))
}

/// Place the catalog Factory at `(0, 0)` (3x3: In W row 1, Out E row 1, Fault S), add a
/// second Out (it takes the first free E row), configure the JS, draw a belt east from
/// each Out's doorstep and Tail-dock it, then pump one `Input` so the Factory runs once.
fn board() -> Board {
    let mut session = GridSession::new(SEED);
    session
        .apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 0, cell_y: 0 })
        .expect("the Factory is placed");
    let factory = *session.core().last_tick.placed.last().expect("the Factory was minted");
    let factory_h = session.view().handle_of(factory).expect("the Factory got a handle");
    session
        .apply(GridCommand::AddPort { node: factory_h, role: 1, side: 1, medium: 0 })
        .expect("a second Out is accepted");
    session
        .apply(GridCommand::Configure {
            node: factory_h,
            config: MachineConfig::Factory { source: SIX_ON_0_AND_1_JS.to_owned() },
        })
        .expect("the Factory JS is accepted");
    let ports = session.core().state.ports_of(factory).expect("the Factory has ports").to_vec();
    assert_eq!(
        ports.iter().map(|p| p.role).collect::<Vec<_>>(),
        vec![Role::In, Role::Out, Role::Fault, Role::Out],
        "the second Out is appended at catalog index 3"
    );
    let row = |i: usize| ports[i].local_offset.1;
    let (on_0, on_0_h) = draw(&mut session, vec![(3, row(1)), (4, row(1))]);
    let (on_1, on_1_h) = draw(&mut session, vec![(3, row(3)), (4, row(3))]);
    session
        .apply(GridCommand::Dock { belt: on_0_h, endpoint: BeltEnd::Tail, node: factory_h, port: 1 })
        .expect("Out key 0's belt docks");
    session
        .apply(GridCommand::Dock { belt: on_1_h, endpoint: BeltEnd::Tail, node: factory_h, port: 3 })
        .expect("Out key 1's belt docks");
    session.pump(&[Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::Input { target: factory, port: 0, item: Item(b"1".to_vec()) },
    }]);
    Board { session, factory, factory_h, on_0, on_1 }
}

/// The Factory's waiting emits as `(key, items)`.
fn queues(session: &GridSession, f: NodeId) -> Vec<(PortId, Vec<Item>)> {
    match session.core().state.node(f) {
        Some(Node::Factory(fac)) => fac.pending_emits.iter().map(|(&p, q)| (p, q.iter().cloned().collect())).collect(),
        o => panic!("expected the Factory, got {o:?}"),
    }
}

fn queue_len(session: &GridSession, f: NodeId, key: PortId) -> usize {
    queues(session, f).into_iter().find(|(p, _)| *p == key).map_or(0, |(_, q)| q.len())
}

fn faults(session: &GridSession, f: NodeId) -> u64 {
    match session.core().state.node(f) {
        Some(Node::Factory(fac)) => fac.faults,
        o => panic!("expected the Factory, got {o:?}"),
    }
}

/// What a belt holds: its slots and its staging inbox, as bytes, so two boards compare.
fn belt_contents(session: &GridSession, belt: NodeId) -> (Vec<Option<Vec<u8>>>, usize) {
    let slots = match session.core().state.node(belt) {
        Some(Node::Belt(b)) => b.slots.iter().map(|s| s.as_ref().map(|i| postcard::to_allocvec(i).expect("item"))).collect(),
        o => panic!("expected a belt, got {o:?}"),
    };
    (slots, session.core().state.inbox_of(belt).map_or(0, |i| i.len_on(0)))
}

/// Items a belt holds or has taken in.
fn on_belt(session: &GridSession, belt: NodeId) -> usize {
    let (slots, staged) = belt_contents(session, belt);
    slots.iter().filter(|s| s.is_some()).count() + staged
}

fn docked_on(session: &GridSession, f: NodeId, key: PortId) -> Option<NodeId> {
    session.core().state.link_target((f, key)).map(|(n, _)| n)
}

/// Save and reopen, both ways: the snapshot trust gate, and the two logs replayed from
/// genesis reproduce the live core byte for byte.
fn save_and_reopen(session: &GridSession, step: &str) {
    let snap = snapshot::snapshot(session.core());
    if let Err(e) = snapshot::restore(&snap) {
        panic!("{step}: the snapshot reopens (refused: {e:?})");
    }
    let replayed = GridSession::replay_two_logs(SEED, session.edit_log(), session.event_log());
    assert_eq!(snapshot::snapshot(replayed.core()), snap, "{step}: the two logs replay to the live core");
}

#[test]
fn a_removed_out_carries_the_next_queue_down_and_undo_carries_it_back() {
    let Board { mut session, factory: f, factory_h, on_0, on_1 } = board();
    let Board { session: mut control, .. } = board();
    save_and_reopen(&session, "after the run");
    let before = queues(&session, f);
    let waiting_0 = queue_len(&session, f, 0);
    eprintln!("CR01-cmd before: queues={:?} on_0={} on_1={}", before.iter().map(|(p, q)| (*p, q.len())).collect::<Vec<_>>(), on_belt(&session, on_0), on_belt(&session, on_1));
    assert_eq!(waiting_0, 5, "five emits wait on Out key 0");
    assert_eq!(queue_len(&session, f, 1), 5, "five emits wait on Out key 1");

    // Remove Out key 0 (catalog index 1): its belt is released, Out key 1 becomes key 0.
    let tick0 = session.core().tick;
    session.apply(GridCommand::RemovePort { node: factory_h, index: 1 }).expect("the removal is accepted");
    let after_remove = queues(&session, f);
    let facts_remove = format!(
        "queues={:?} on_1={} docked_key0={:?} docked_key1={:?} faults={}",
        after_remove.iter().map(|(p, q)| (*p, q.len())).collect::<Vec<_>>(),
        on_belt(&session, on_1),
        docked_on(&session, f, 0),
        docked_on(&session, f, 1),
        faults(&session, f),
    );
    eprintln!("CR01-cmd after remove: {facts_remove}");
    assert_eq!(docked_on(&session, f, 0), Some(on_1), "the second Out's belt is docked on key 0 now");
    assert_eq!(docked_on(&session, f, 1), None, "and nothing is docked on key 1");
    assert!(after_remove.iter().all(|(p, _)| *p == 0), "the only queue left is on key 0 (read {facts_remove})");
    assert!(queue_len(&session, f, 0) > 0, "the moved queue is not empty yet");
    assert_eq!(queue_len(&session, f, 0) + on_belt(&session, on_1), 6, "none of the second Out's six emits is lost");
    assert_eq!(
        faults(&session, f),
        u64::try_from(waiting_0).expect("small"),
        "the removed Out's five waiting emits are dropped and counted in Factory.faults"
    );
    save_and_reopen(&session, "after the removal");

    // One Undo: the Out comes back on its own slot and its belt re-docks; the second
    // Out's queue goes back to key 1.
    session.apply(GridCommand::Undo).expect("one Undo");
    let ticks = session.core().tick - tick0;
    control.advance(ticks);
    let after_undo = queues(&session, f);
    let control_queues = queues(&control, f);
    eprintln!(
        "CR01-cmd after undo ({ticks} ticks): queues={:?} control={:?} docked_key0={:?} docked_key1={:?} faults={}",
        after_undo.iter().map(|(p, q)| (*p, q.len())).collect::<Vec<_>>(),
        control_queues.iter().map(|(p, q)| (*p, q.len())).collect::<Vec<_>>(),
        docked_on(&session, f, 0),
        docked_on(&session, f, 1),
        faults(&session, f),
    );
    assert_eq!(docked_on(&session, f, 0), Some(on_0), "the removed Out's belt is docked on key 0 again");
    assert_eq!(docked_on(&session, f, 1), Some(on_1), "the second Out's belt is docked on key 1 again");
    let key1 = |qs: &[(PortId, Vec<Item>)]| qs.iter().find(|(p, _)| *p == 1).map(|(_, q)| q.clone());
    assert!(key1(&after_undo).is_some_and(|q| !q.is_empty()), "the queue is back on key 1, not empty yet");
    assert_eq!(key1(&after_undo), key1(&control_queues), "key 1's queue is exactly the unedited board's");
    assert_eq!(belt_contents(&session, on_1), belt_contents(&control, on_1), "and so is its belt");
    assert!(
        after_undo.iter().all(|(p, _)| *p == 1),
        "the removed Out's dropped emits do not come back: they were counted, as a Disconnect's are"
    );
    assert_eq!(faults(&session, f), 5, "the count stands after the Undo");
    save_and_reopen(&session, "after the Undo");

    // The second Out's six emits all arrive.
    session.advance(200);
    assert!(queues(&session, f).is_empty(), "the queue drains");
    assert_eq!(on_belt(&session, on_1), 6, "all six of the second Out's emits reach its belt");
}
