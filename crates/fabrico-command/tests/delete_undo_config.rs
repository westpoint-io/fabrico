//! Phase 86 plan 03 (WORK-01, D-01, D-02): Delete then Ctrl+Z gives a machine back WITH
//! ITS CONFIGURATION, and every belt docked to it with its own pace.
//!
//! Before this plan the Delete inverse re-applied config for a label only (plan 76-05). A
//! configured Factory came back with the placement JS, a Route with the default path a new
//! Route is minted (then `/ep-<id>` from its NEW id; `/route-N` since phase 91), a Sink with the Debug target, a Router with an empty table, a Source as a
//! webhook source, and a belt docked to a deleted machine at the default pace.
//!
//! # What each leg carries
//! - One LIVE leg and one `_after_a_replay` twin per configurable kind (Factory, Handler,
//!   Sink, Source, Router, Route, label): place, configure away from the default, Delete,
//!   (save and reload for the twin), Undo. The restored node's config, read off the session
//!   core, equals what it carried before the Delete, and a bystander placed beside it keeps
//!   its id, its cell and its own config. A Source's trigger is not core state (a Source
//!   config folds to nothing), so it is read from the newest logged `Configure{Source}`
//!   naming the node, which is exactly what the host's timer projection reads.
//! - `a_default_config_is_still_reapplied` (D-02): a Sink at its placement default comes
//!   back through an undo group that still holds the re-`Configure`. One shape for every
//!   Delete undo, no "equal to the default, so skip it" case.
//! - `cascade_belt_pace_survives_a_machine_delete_then_undo` (research Pitfall 2): a belt at
//!   pace 5 docked to a Router comes back at 5 when the Router is deleted and undone.
//! - `bare_belt_pace_survives_delete_then_undo`: a belt deleted on its own at pace 7 comes
//!   back at 7.
//! - `a_tee_balancer_or_merge_undo_appends_no_configure`: the three kinds with no config get
//!   no `Configure` in their undo group.
//!
//! RED FIRST: on plan 86-02's tree the twelve non-label kind legs, the default
//! leg and both pace legs FAILED (15); the label pair and the no-Configure leg passed.
//!
//! Run target: `cargo test -p fabrico-command --test delete_undo_config`

use fabrico_command::{GridLookup, GridSession};
use fabrico_core::edit::{EditOp, EditRecord, MachineConfig as CoreConfig, SourceTrigger as CoreTrigger};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Footprint, Node, Role};
use fabrico_protocol::{
    BeltEnd, GridCommand, HttpMethod, MachineConfig, RouteKey, SinkTemplate, SourceTrigger,
    machine_kind,
};

const SEED: u64 = 0x0086_0003_C0F1;

/// Where every machine under test is anchored, and where its bystander stands.
const CELL: (i32, i32) = (0, 0);
const BYSTANDER_CELL: (i32, i32) = (30, 30);

/// Place `kind` at `cell` through the session and return the id it minted.
fn place(session: &mut GridSession, kind: u8, cell: (i32, i32)) -> NodeId {
    session
        .apply(GridCommand::Place { kind, cell_x: cell.0, cell_y: cell.1 })
        .expect("place at a free cell");
    *session.core().last_tick.placed.last().expect("the placed node minted an id")
}

/// Draw a belt along `cells` and return the minted belt's id.
fn draw(session: &mut GridSession, cells: Vec<(i32, i32)>) -> NodeId {
    session.apply(GridCommand::DrawBelt { cells }).expect("a clear drawn path is accepted");
    *session.core().last_tick.placed.last().expect("the belt minted an id")
}

/// The dense render handle for a live node.
fn handle_of(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("a live node has a handle")
}

fn configure(session: &mut GridSession, id: NodeId, config: MachineConfig) {
    let node = handle_of(session, id);
    session.apply(GridCommand::Configure { node, config }).expect("the Configure is accepted");
}

fn delete(session: &mut GridSession, id: NodeId) {
    let node = handle_of(session, id);
    session.apply(GridCommand::Delete { node }).expect("the Delete is accepted");
}

/// Serialize the edit log as a saved project carries it, decode it back and re-fold from
/// genesis: the save-load path `label.rs` uses.
fn save_and_load(session: &GridSession) -> GridSession {
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec()).expect("edit-log encodes");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("edit-log decodes");
    GridSession::replay(SEED, &records)
}

/// The newest logged Source trigger naming `id`, Webhook when none was ever logged (the
/// placement default). The host's timer projection reads the same records.
fn logged_trigger(session: &GridSession, id: NodeId) -> CoreTrigger {
    session
        .edit_log()
        .iter()
        .rev()
        .find_map(|r| match &r.op {
            EditOp::Configure { node, config: CoreConfig::Source { trigger }, .. } if *node == id => {
                Some(trigger.clone())
            }
            _ => None,
        })
        .unwrap_or(CoreTrigger::Webhook)
}

/// The node's whole config, read off the session (the core for every kind but a Source).
/// The test's own reader, so a wrong reader in `command.rs` cannot agree with itself here.
fn config_of(session: &GridSession, id: NodeId) -> Option<CoreConfig> {
    let state = &session.core().state;
    Some(match state.node(id)? {
        Node::Factory(f) => CoreConfig::Factory { source: f.source.clone() },
        Node::Sink(s) => CoreConfig::Sink { target: s.template.clone() },
        Node::Source(_) => CoreConfig::Source { trigger: logged_trigger(session, id) },
        Node::Belt(b) => CoreConfig::Belt { ticks_per_slot: b.ticks_per_slot },
        Node::Router(r) => CoreConfig::Router { routes: r.routes.clone(), default: r.default },
        Node::Endpoint(e) => CoreConfig::Endpoint { path: e.path.clone() },
        Node::Label(l) => {
            let fp = state.footprint_of(id).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
            CoreConfig::Label { text: l.text.clone(), colour: l.colour, w: fp.w, h: fp.h }
        }
        Node::Tee(_) | Node::Balancer(_) | Node::Merge(_) | Node::Wire(_) => return None,
    })
}

/// What the user sees of `id` apart from its config: its kind as the command layer reads it
/// (`GridLookup::kind_of`, the one reading that tells a Handler from a Factory, since both
/// fold to a `Node::Factory`), its port list and its box (phase 86 review, IN-03). A Handler
/// that came back as a plain Factory with the same JS differs here.
fn shape_of(session: &GridSession, id: NodeId) -> (Option<u8>, Option<Vec<fabrico_core::state::Port>>, Option<Footprint>) {
    let core = session.core();
    let lookup = session.view().lookup(core);
    (lookup.kind_of(id), core.state.ports_of(id).map(<[_]>::to_vec), core.state.footprint_of(id))
}

/// The count of `Role::Out` ports on `id`, so a Router's default names a key it has.
fn out_count(session: &GridSession, id: NodeId) -> u16 {
    let outs = session
        .core()
        .state
        .ports_of(id)
        .expect("a placed node declares ports")
        .iter()
        .filter(|p| p.role == Role::Out)
        .count();
    u16::try_from(outs).expect("an Out count fits a u16")
}

/// What one configurable kind is set to before its Delete.
type ConfigFor = fn(&GridSession, NodeId) -> MachineConfig;

fn factory_js(_: &GridSession, _: NodeId) -> MachineConfig {
    MachineConfig::Factory { source: "export default (x) => ({ ...x, seen: true })".to_owned() }
}

fn handler_js(_: &GridSession, _: NodeId) -> MachineConfig {
    MachineConfig::Factory { source: "export default (req) => ({ status: 201 })".to_owned() }
}

fn sink_target(_: &GridSession, _: NodeId) -> MachineConfig {
    MachineConfig::Sink {
        target: SinkTemplate::Http { url: "http://127.0.0.1/orders".to_owned(), method: HttpMethod::Put },
    }
}

fn source_timer(_: &GridSession, _: NodeId) -> MachineConfig {
    MachineConfig::Source { trigger: SourceTrigger::Timer { interval_ticks: 90 } }
}

fn router_rules(session: &GridSession, id: NodeId) -> MachineConfig {
    let outs = out_count(session, id);
    assert!(outs >= 2, "the Router leg needs two Outs to name a non-zero default");
    MachineConfig::Router {
        routes: vec![
            (RouteKey { offset: 0, expect: b"order".to_vec() }, 1),
            (RouteKey { offset: 3, expect: b"refund".to_vec() }, 0),
        ],
        default: Some(outs - 1),
    }
}

fn route_path(_: &GridSession, _: NodeId) -> MachineConfig {
    MachineConfig::Endpoint { path: "/orders".to_owned() }
}

fn label_words(_: &GridSession, _: NodeId) -> MachineConfig {
    MachineConfig::Label { text: "Order intake".to_owned(), colour: 3, w: 6, h: 2 }
}

/// One leg: place `kind` at [`CELL`] beside a configured bystander, configure it with
/// `config_for`, Delete it, optionally save and reload, Undo, and grade the restored
/// node's config and the bystander.
fn leg(kind: u8, config_for: ConfigFor, after_a_replay: bool) {
    let mut session = GridSession::new(SEED);
    let bystander = place(&mut session, machine_kind::SINK, BYSTANDER_CELL);
    let bystander_target = sink_target(&session, bystander);
    configure(&mut session, bystander, bystander_target);
    let bystander_config = config_of(&session, bystander);

    let id = place(&mut session, kind, CELL);
    let placed_default = config_of(&session, id);
    let config = config_for(&session, id);
    configure(&mut session, id, config);
    let want = config_of(&session, id).expect("a configurable kind has a config");
    assert_ne!(Some(&want), placed_default.as_ref(), "the leg configures away from the placement default");
    let want_shape = shape_of(&session, id);
    assert_eq!(want_shape.0, Some(kind), "measured: the placed node reads as the kind placed");

    delete(&mut session, id);
    assert!(session.core().state.node(id).is_none(), "the Delete took the node");
    assert_eq!(session.core().state.occupied(CELL), None, "the Delete freed the anchor cell");

    if after_a_replay {
        session = save_and_load(&session);
        assert!(session.can_undo(), "the reloaded session can undo the Delete");
    }
    session.apply(GridCommand::Undo).expect("one Undo");

    let back = session.core().state.occupied(CELL).expect("a node stands on the anchor cell again");
    assert_eq!(config_of(&session, back), Some(want), "the restored node carries the config it had");
    assert_eq!(shape_of(&session, back), want_shape, "the restored node is the kind it was, with its ports and box");
    assert_eq!(session.core().state.occupied(BYSTANDER_CELL), Some(bystander), "the bystander keeps its cell");
    assert_eq!(config_of(&session, bystander), bystander_config, "the bystander keeps its config");
}

#[test]
fn factory_js_survives_delete_then_undo() {
    leg(machine_kind::FACTORY, factory_js, false);
}

#[test]
fn factory_js_survives_delete_then_undo_after_a_replay() {
    leg(machine_kind::FACTORY, factory_js, true);
}

#[test]
fn handler_js_survives_delete_then_undo() {
    leg(machine_kind::HANDLER, handler_js, false);
}

#[test]
fn handler_js_survives_delete_then_undo_after_a_replay() {
    leg(machine_kind::HANDLER, handler_js, true);
}

#[test]
fn sink_target_survives_delete_then_undo() {
    leg(machine_kind::SINK, sink_target, false);
}

#[test]
fn sink_target_survives_delete_then_undo_after_a_replay() {
    leg(machine_kind::SINK, sink_target, true);
}

#[test]
fn source_timer_survives_delete_then_undo() {
    leg(machine_kind::SOURCE, source_timer, false);
}

#[test]
fn source_timer_survives_delete_then_undo_after_a_replay() {
    leg(machine_kind::SOURCE, source_timer, true);
}

#[test]
fn router_rules_survive_delete_then_undo() {
    leg(machine_kind::ROUTER, router_rules, false);
}

#[test]
fn router_rules_survive_delete_then_undo_after_a_replay() {
    leg(machine_kind::ROUTER, router_rules, true);
}

#[test]
fn route_path_survives_delete_then_undo() {
    leg(machine_kind::ENDPOINT, route_path, false);
}

#[test]
fn route_path_survives_delete_then_undo_after_a_replay() {
    leg(machine_kind::ENDPOINT, route_path, true);
}

#[test]
fn label_words_survive_delete_then_undo() {
    leg(machine_kind::LABEL, label_words, false);
}

#[test]
fn label_words_survive_delete_then_undo_after_a_replay() {
    leg(machine_kind::LABEL, label_words, true);
}

/// The records one Undo appended: everything after `before` in the log, one action.
fn undo_group(session: &GridSession, before: usize) -> Vec<EditOp> {
    let appended = &session.edit_log()[before..];
    let action = appended.first().expect("the Undo appended records").action;
    assert!(appended.iter().all(|r| r.action == action), "one Undo appends ONE action");
    appended.iter().map(|r| r.op.clone()).collect()
}

#[test]
fn a_default_config_is_still_reapplied() {
    let mut session = GridSession::new(SEED);
    let id = place(&mut session, machine_kind::SINK, CELL);
    let default = config_of(&session, id).expect("a Sink has a config");
    assert_eq!(
        default,
        CoreConfig::Sink { target: fabrico_core::state::SinkTemplate::Debug },
        "the Sink is at its placement default"
    );
    delete(&mut session, id);
    let before = session.edit_log().len();
    session.apply(GridCommand::Undo).expect("one Undo");
    let back = session.core().state.occupied(CELL).expect("the Sink is back");
    let group = undo_group(&session, before);
    let configures: Vec<&EditOp> = group.iter().filter(|op| matches!(op, EditOp::Configure { .. })).collect();
    match configures.as_slice() {
        [EditOp::Configure { node, config, .. }] => {
            assert_eq!(*node, back, "the re-Configure names the re-minted Sink");
            assert_eq!(config, &default, "the re-Configure carries the default it had");
        }
        other => panic!("the undo of a Delete holds one re-Configure even at the default, got {other:?}"),
    }
    assert_eq!(config_of(&session, back), Some(default), "the Sink is back at its target");
}

/// The cells of the belt docked to the Router at [`CELL`] (the `undo_redo.rs` board).
const DOCK_BELT_CELLS: [(i32, i32); 2] = [(2, 1), (3, 1)];

fn pace_of(session: &GridSession, cell: (i32, i32)) -> Option<u32> {
    let id = session.core().state.occupied(cell)?;
    match session.core().state.node(id)? {
        Node::Belt(b) => Some(b.ticks_per_slot.get()),
        _ => None,
    }
}

#[test]
fn cascade_belt_pace_survives_a_machine_delete_then_undo() {
    let mut session = GridSession::new(SEED);
    let router = place(&mut session, machine_kind::ROUTER, CELL);
    let belt = draw(&mut session, DOCK_BELT_CELLS.to_vec());
    let (r, b) = (handle_of(&session, router), handle_of(&session, belt));
    session
        .apply(GridCommand::Dock { belt: b, endpoint: BeltEnd::Tail, node: r, port: 1 })
        .expect("the belt docks to the Router");
    configure(&mut session, belt, MachineConfig::Belt { ticks_per_slot: 5 });
    assert_eq!(pace_of(&session, DOCK_BELT_CELLS[0]), Some(5), "the belt runs at pace 5");
    let links_before = session.core().state.links_iter().count();

    delete(&mut session, router);
    assert_eq!(pace_of(&session, DOCK_BELT_CELLS[0]), None, "the Router's Delete took the docked belt");
    session.apply(GridCommand::Undo).expect("one Undo");

    assert!(session.core().state.occupied(CELL).is_some(), "the Router is back");
    assert_eq!(pace_of(&session, DOCK_BELT_CELLS[0]), Some(5), "the docked belt comes back at its own pace");
    assert_eq!(pace_of(&session, DOCK_BELT_CELLS[1]), Some(5), "one belt, both tiles");
    assert_eq!(session.core().state.links_iter().count(), links_before, "the dock is back");
}

#[test]
fn bare_belt_pace_survives_delete_then_undo() {
    let mut session = GridSession::new(SEED);
    let cells = vec![(10, 10), (11, 10), (12, 10)];
    let belt = draw(&mut session, cells.clone());
    configure(&mut session, belt, MachineConfig::Belt { ticks_per_slot: 7 });
    assert_eq!(pace_of(&session, cells[0]), Some(7), "the belt runs at pace 7");

    delete(&mut session, belt);
    assert_eq!(pace_of(&session, cells[0]), None, "the belt is gone");
    session.apply(GridCommand::Undo).expect("one Undo");

    for cell in cells {
        assert_eq!(pace_of(&session, cell), Some(7), "the bare belt comes back at its own pace at {cell:?}");
    }
}

#[test]
fn a_tee_balancer_or_merge_undo_appends_no_configure() {
    for kind in [machine_kind::TEE, machine_kind::BALANCER, machine_kind::MERGE] {
        let mut session = GridSession::new(SEED);
        let id = place(&mut session, kind, CELL);
        assert_eq!(config_of(&session, id), None, "kind {kind} carries no config");
        delete(&mut session, id);
        let before = session.edit_log().len();
        session.apply(GridCommand::Undo).expect("one Undo");
        assert!(session.core().state.occupied(CELL).is_some(), "kind {kind} is back");
        let group = undo_group(&session, before);
        assert!(
            !group.iter().any(|op| matches!(op, EditOp::Configure { .. })),
            "kind {kind}: an undo of a Delete appends no Configure for a kind with no config: {group:?}"
        );
    }
}
