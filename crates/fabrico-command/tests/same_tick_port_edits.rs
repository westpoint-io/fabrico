//! Review WR-01, round 3 (plan 74.1-23): AN UNDO OF ANY PORT EDIT RESTORES WHAT THAT EDIT
//! CHANGED, EVEN WHEN SEVERAL PORT EDITS ON ONE NODE FOLD IN ONE TICK.
//!
//! # The defect
//! `GridSession::apply` folds one record per tick, but the host's `fold_live` folds a whole
//! drain pass: two `+ Add output` clicks, or two removals, or two config edits on one
//! machine, can land in one batch. The undo captures (`capture_before_fold` and its twin in
//! `reconstruct_projection`) read the core as it stood before the BATCH, so the second
//! record of the pair captured a state it never folded against. The reviewer's
//! reproduction: two growing adds on a 3-output Factory, then Ctrl+Z, restored the 3x3 box
//! instead of 3x4, left an Out on row 3 outside it, and the save no longer loaded
//! (`snapshot::restore` refused `PortOutOfFootprint`).
//!
//! # What these pins hold
//! Each case stamps two records on one tick the way `Host::tick_once` does (host
//! provenance, one action per gesture) and folds them in ONE `fold_live`. The second
//! record's undo must restore exactly what that record changed, and a session rebuilt by
//! `GridSession::replay` from the same log must resolve the identical undo group (the
//! reconstruct twin), so an undo behaves the same before and after a save.
//!
//! Run target: `cargo test -p fabrico-command --test same_tick_port_edits`.

use fabrico_command::GridSession;
use fabrico_core::core::Core;
use fabrico_core::edit::{BoxRestore, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::ids::NodeId;
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::{Footprint, Node, Port, Side};
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind, port_medium, port_role};

const SEED: u64 = 0xFAB_7423;

/// The Factory's anchor on every board here.
const ANCHOR: (i32, i32) = (20, 20);

/// A Factory at [`ANCHOR`] with `outs` outputs (the catalog's one plus `outs - 1` adds),
/// built through `apply`, one record per tick. Returns the session, the node and its handle.
fn factory(outs: usize) -> (GridSession, NodeId, u64) {
    let mut s = GridSession::new(SEED);
    s.apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: ANCHOR.0, cell_y: ANCHOR.1 })
        .expect("place the factory");
    let m = *s.core().last_tick.placed.last().expect("the factory was minted");
    let h = s.view().handle_of(m).expect("the factory got a handle");
    for _ in 1..outs {
        s.apply(add_out(h)).expect("an add on clear floor is accepted");
    }
    (s, m, h)
}

/// The panel's `+ Add output` gesture.
fn add_out(h: u64) -> GridCommand {
    GridCommand::AddPort { node: h, role: port_role::OUT, side: Side::E as u8, medium: port_medium::MECHANICAL }
}

/// Resolve `cmds` one after another on a twin of `base` (rebuilt by `build`), returning
/// each command's resolved op: the records two same-tick gestures would enqueue.
fn resolve_on_twin(build: impl Fn() -> (GridSession, NodeId, u64), cmds: &[GridCommand]) -> Vec<EditOp> {
    let (mut twin, _, _) = build();
    cmds.iter()
        .map(|c| twin.apply(c.clone()).expect("the twin accepts the gesture").op.clone())
        .collect()
}

/// Stamp each group as its own action, ALL on the session's current tick, continuing the
/// log's sequence and action counters, the way `Host::tick_once` stamps one drain pass.
fn stamp_one_tick(s: &GridSession, groups: Vec<Vec<EditOp>>) -> Vec<EditRecord> {
    let log = s.edit_log();
    let mut sequence = log.iter().map(|r| r.sequence).max().map_or(0, |m| m + 1);
    let first_action = log.iter().map(|r| r.action).max().map_or(0, |m| m + 1);
    let tick = s.core().tick;
    let mut out = Vec::new();
    for (action, group) in (first_action..).zip(groups) {
        for op in group {
            out.push(EditRecord { schema_version: EDIT_SCHEMA_VERSION, partition: 0, sequence, tick, action, op });
            sequence += 1;
        }
    }
    out
}

/// Fold `groups` in ONE `fold_live` batch.
fn fold_one_tick(s: &mut GridSession, groups: Vec<Vec<EditOp>>) {
    let batch = stamp_one_tick(s, groups);
    let _ = s.fold_live(&batch, &[]);
}

/// Resolve the next undo and fold it as the host would (its own action, its own tick).
fn undo_live(s: &mut GridSession) -> Vec<EditOp> {
    let group: Vec<EditOp> =
        s.resolve_undo().expect("the last edit is undoable").into_iter().map(|r| r.op).collect();
    fold_one_tick(s, vec![group.clone()]);
    group
}

fn footprint(core: &Core, m: NodeId) -> Footprint {
    core.state.footprint_of(m).unwrap_or(Footprint { w: 1, h: 1, rot: 0 })
}

fn ports(core: &Core, m: NodeId) -> Vec<Port> {
    core.state.ports_of(m).expect("the factory declares ports").to_vec()
}

/// The replay twin: a session rebuilt from the live log resolves the identical undo group.
fn assert_replay_resolves_the_same_undo(live: &GridSession) {
    let replayed = GridSession::replay(SEED, live.edit_log());
    let ops = |s: &GridSession| -> Vec<EditOp> {
        s.resolve_undo().expect("undoable").into_iter().map(|r| r.op).collect()
    };
    assert_eq!(ops(&replayed), ops(live), "a replayed session resolves the same undo (before and after a save)");
}

/// THE REVIEWER'S REPRODUCTION: two growing adds on a 3-output Factory (3x3) in one batch.
/// Undoing the second must put back the 3x4 box it grew from, and the result must pass the
/// snapshot trust gate.
/// RED at the start revision: the restore was the pre-batch 3x3 and `restore` refused
/// `PortOutOfFootprint`.
#[test]
fn two_same_tick_growing_adds_each_undo_to_the_box_they_grew_from() {
    let (mut live, m, h) = factory(3);
    assert_eq!(footprint(live.core(), m), Footprint { w: 3, h: 3, rot: 0 }, "measured: 3 outputs fill 3x3");
    let adds = resolve_on_twin(|| factory(3), &[add_out(h), add_out(h)]);
    fold_one_tick(&mut live, adds.into_iter().map(|op| vec![op]).collect());
    assert_eq!(footprint(live.core(), m), Footprint { w: 3, h: 5, rot: 0 }, "measured: two adds grow 3x3 to 3x5");

    assert_replay_resolves_the_same_undo(&live);
    let undo = undo_live(&mut live);
    let restore_box = undo.iter().find_map(|op| match op {
        EditOp::RemovePort { restore, .. } => *restore,
        _ => None,
    });
    assert_eq!(
        restore_box,
        Some(BoxRestore { w: 3, h: 4, anchor_x: ANCHOR.0, anchor_y: ANCHOR.1 }),
        "the second add's undo restores the 3x4 box it grew from, not the pre-batch 3x3"
    );
    assert_eq!(footprint(live.core(), m), Footprint { w: 3, h: 4, rot: 0 }, "one undo leaves 3x4");
    assert!(restore(&snapshot(live.core())).is_ok(), "the board after the undo passes the trust gate (the save loads)");

    assert_replay_resolves_the_same_undo(&live);
    undo_live(&mut live);
    assert_eq!(footprint(live.core(), m), Footprint { w: 3, h: 3, rot: 0 }, "the first add's undo restores 3x3");
    assert!(restore(&snapshot(live.core())).is_ok(), "and the board still passes the trust gate");
}

/// Two removals on one node in one batch: undoing the second re-inserts the port the
/// second removed, on its own slot.
/// RED at the start revision: the second removal's capture was the pre-batch port at its
/// index, which is the port the FIRST removal took.
#[test]
fn two_same_tick_removals_each_undo_to_the_port_they_removed() {
    let (mut live, m, h) = factory(3);
    let before = ports(live.core(), m);
    let outs: Vec<u16> = before
        .iter()
        .enumerate()
        .filter(|(_, p)| p.role == fabrico_core::state::Role::Out)
        .map(|(i, _)| u16::try_from(i).expect("small"))
        .collect();
    assert_eq!(outs.len(), 3, "measured: three outputs");
    // Remove the first Out, then the Out now sitting at that same index (originally the
    // second one): the second record's index names a different port after the first folds.
    let first = outs[0];
    let cmds = [GridCommand::RemovePort { node: h, index: first }, GridCommand::RemovePort { node: h, index: first }];
    let removes = resolve_on_twin(|| factory(3), &cmds);
    let (mut after_first, _, _) = factory(3);
    after_first.apply(cmds[0].clone()).expect("the first removal");
    let want = ports(after_first.core(), m);

    fold_one_tick(&mut live, removes.into_iter().map(|op| vec![op]).collect());
    assert_eq!(ports(live.core(), m).len(), before.len() - 2, "both removals folded");

    assert_replay_resolves_the_same_undo(&live);
    undo_live(&mut live);
    assert_eq!(
        ports(live.core(), m),
        want,
        "undoing the second removal re-inserts the port IT removed, on its own slot"
    );
    assert!(restore(&snapshot(live.core())).is_ok(), "the board passes the trust gate");
    undo_live(&mut live);
    assert_eq!(ports(live.core(), m), before, "undoing the first puts the original list back");
}

/// Two config edits on one node in one batch: undoing the second restores the FIRST
/// one's config.
/// RED at the start revision: the second edit's prior was the pre-batch config.
#[test]
fn two_same_tick_configures_each_undo_to_the_config_before_them() {
    let (mut live, m, h) = factory(1);
    let source = |core: &Core| match core.state.node(m) {
        Some(Node::Factory(f)) => f.source.clone(),
        other => panic!("{m:?} is a Factory, got {other:?}"),
    };
    let original = source(live.core());
    let cmds = [
        GridCommand::Configure { node: h, config: MachineConfig::Factory { source: "first".into() } },
        GridCommand::Configure { node: h, config: MachineConfig::Factory { source: "second".into() } },
    ];
    let configures = resolve_on_twin(|| factory(1), &cmds);
    fold_one_tick(&mut live, configures.into_iter().map(|op| vec![op]).collect());
    assert_eq!(source(live.core()), "second", "both configures folded");

    assert_replay_resolves_the_same_undo(&live);
    undo_live(&mut live);
    assert_eq!(source(live.core()), "first", "undoing the second restores the first one's config");
    undo_live(&mut live);
    assert_eq!(source(live.core()), original, "undoing the first restores the original");
}
