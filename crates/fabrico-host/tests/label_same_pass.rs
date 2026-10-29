//! A label takes its cells inside ONE drain pass (phase 76, plans 76-07 and 76-11, CR-02).
//!
//! THE RULE (D-01, "Takes its cells")
//! A label is a sim object that owns the cells its box covers, exactly as a machine
//! does: nothing may be placed, drawn, turned or grown onto a cell a label holds, and a
//! label that shrinks gives its cells back at once. Code review CR-02 measured the hole:
//! the host's pending-record replay (`HostGridLookup` in `input_apply.rs`) treated EVERY
//! `Configure` as cell-neutral, so on a paused board a label grow followed by a Place on
//! a cell the grow now covers were BOTH accepted, both folded, the cells overlapped, and
//! the saved board was refused `CellCollision` when it was opened again. Lost work.
//!
//! WHY ONE DRAIN PASS
//! `SimLoop::acquire_input` applies every queued gesture through `apply_gesture` with no
//! fold between them, and a paused board queues every gesture until Play. So
//! consecutive `apply_gesture` calls with no `tick_once` between them ARE that pass:
//! [`pass`] below is the drain, [`fold`] is the tick Play runs. Every leg runs on
//! [`demo_host`], the board the shipped app boots (the demo's commands, its Route,
//! HTTP Handler and cables included, through `seed_scene`), because a check that only
//! ever runs on an empty board has been this project's blind spot before (CR-01, phase
//! 73). Until plan 85-08 that board also carried four nodes minted outside the log; it
//! carries none now, so these legs run on the board a user actually opens.
//!
//! THE LABELLED-PAIR RULE
//! Every leg asserts ONE `Vec<(&'static str, String)>` of labelled facts in ONE
//! `assert_eq!` against the expected `Vec`, each pair `("<fact>", <its Debug text>)`.
//! A red then prints every fact, and each fact is findable in the failure text by its
//! label (plan 76-12 greps them).
//!
//! THE LEGS
//! - [`grow_then_place_on_a_covered_cell_in_one_pass_is_refused_and_the_board_reloads`]:
//!   a 4 by 1 label grown to 6 by 1, then a Place on a newly covered cell, in one pass:
//!   the Place is refused `FootprintCollision`, and the saved board opens again.
//! - [`shrink_then_place_on_the_freed_cell_in_one_pass_is_accepted_and_the_board_reloads`]:
//!   a 6 by 1 label shrunk to 4 by 1, then a Place on a freed cell, in one pass: the Place
//!   is accepted and the folded board passes the snapshot trust gate.
//!
//! - [`shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell`]:
//!   the Delete capture reads the replayed label box, not the pre-pass one (`label_boxes`).
//! - Every other record that takes a cell against a pending resize, in both orders
//!   (DrawBelt, a neighbour's Rotate, a second label, a neighbour's growing AddPort, a
//!   Place), and a grow then shrink inside one pass (the CR-02 refuter round on 76-07).
//!
//! - Plan 76-11, the remaining one-pass legs: a Factory turned once, whose growing add
//!   moves its anchor, in both orders ([`turned_factory_growth`] measures where it grows
//!   and the legs place their label by a written rule on that measurement); the Undo's
//!   shrinking RemovePort then a grow into the freed cell then a Place there; a shrink
//!   that frees a cell for a neighbour's turn; and a grow then a shrink in one pass
//!   stepped back by two Undos.
//!
//! THE ORDERS GRADED. With the label's resize pending first: a Place, a DrawBelt, a
//! neighbour Router's Rotate, a second label's grow and a neighbour Factory's growing
//! AddPort (turned or not) onto a cell the grow took are refused; an Undo's shrink then a
//! grow then a Place on the cell the grow took is refused; a shrink frees its cells for a
//! Place and for a neighbour's Rotate; a grow then a shrink frees the grown cells; two
//! Undos step back through a grow and a shrink. With the other record first: a Place, a
//! growing AddPort (turned or not), a Rotate or a DrawBelt, then a grow over its cell, is
//! refused `ResizeCovers`. A shrink, a Place and a Delete in one pass come back on Undo at
//! the shrunk box. No other order is claimed: a Delete then a grow, and a shrink followed
//! by a DrawBelt or an AddPort into a freed cell, are not graded here.
//!
//! BITE RECORD
//! Plan 76-12's machine run: each mutation applied with `perl` to its pinned site
//! (counted exactly once) in a throwaway worktree, the whole
//! target run with `--no-fail-fast` (every run exited 101), each graded leg's own token
//! read out of its own failure section, the file restored, the worktree removed. Each
//! line: the mutation, every leg it reddened (a second run of the same nine mutations at
//! the same revision), and one `first[...]` line copied verbatim from the graded run.
//!
//! BITE A: the `occupied_by` label alternative line deleted: grow_then_place_on_a_covered_cell_in_one_pass_is_refused_and_the_board_reloads, shrink_then_place_on_the_freed_cell_in_one_pass_is_accepted_and_the_board_reloads, shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell, grow_then_draw_belt_across_a_covered_cell_in_one_pass_is_refused, two_labels_growing_into_one_free_cell_in_one_pass_refuse_the_second, grow_then_a_neighbour_rotate_onto_a_covered_cell_in_one_pass_is_refused, grow_then_a_neighbour_add_port_onto_a_covered_cell_in_one_pass_is_refused, turned_factory_grow_then_add_port_onto_a_claimed_cell_in_one_pass_is_refused, undo_shrink_then_grow_into_the_freed_cell_then_place_there_is_refused, shrink_then_a_neighbour_rotate_into_a_freed_cell_in_one_pass_is_accepted: first[A:grow_then_place_on_a_covered_cell_in_one_pass_is_refused_and_the_board_reloads]=  left: [("configure", "Ok(())"), ("place", "Ok(())"), ("pending", "2"), ("label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })"), ("owner_15_20", "Some(NodeId(24v1))"), ("restores", "Some(\"InvalidState(CellCollision)\")"), ("save", "Ok(())"), ("load", "Err(InvalidSnapshot(InvalidState(CellCollision)))"), ("loaded_label_fp", "no board")]
//! BITE B: the `effective_geometry_upto` label arm's guard `if *resized == node` forced false: grow_then_place_on_a_covered_cell_in_one_pass_is_refused_and_the_board_reloads, shrink_then_place_on_the_freed_cell_in_one_pass_is_accepted_and_the_board_reloads, shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell, grow_then_draw_belt_across_a_covered_cell_in_one_pass_is_refused, two_labels_growing_into_one_free_cell_in_one_pass_refuse_the_second, grow_then_a_neighbour_rotate_onto_a_covered_cell_in_one_pass_is_refused, grow_then_a_neighbour_add_port_onto_a_covered_cell_in_one_pass_is_refused, turned_factory_grow_then_add_port_onto_a_claimed_cell_in_one_pass_is_refused, undo_shrink_then_grow_into_the_freed_cell_then_place_there_is_refused, shrink_then_a_neighbour_rotate_into_a_freed_cell_in_one_pass_is_accepted: first[B:grow_then_place_on_a_covered_cell_in_one_pass_is_refused_and_the_board_reloads]=  left: [("configure", "Ok(())"), ("place", "Ok(())"), ("pending", "2"), ("label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })"), ("owner_15_20", "Some(NodeId(24v1))"), ("restores", "Some(\"InvalidState(CellCollision)\")"), ("save", "Ok(())"), ("load", "Err(InvalidSnapshot(InvalidState(CellCollision)))"), ("loaded_label_fp", "no board")]
//! BITE C: the free-before box read at index 0 instead of `idx`: grow_then_shrink_in_one_pass_frees_the_cells_the_grow_took: first[C:grow_then_shrink_in_one_pass_frees_the_cells_the_grow_took]=  left: [("grow", "Ok(())"), ("shrink", "Ok(())"), ("place", "Err(FootprintCollision)"), ("pending", "2"), ("owner_15_42_is_source", "false"), ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })"), ("restores", "None")]
//! BITE D: `label_boxes.get(node)` filtered to nothing: shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell: first[D:shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell]=  left: [("setup_configure", "Ok(())"), ("pre_label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })"), ("pre_owner_15_46", "Some(NodeId(23v1))"), ("shrink", "Ok(())"), ("place", "Ok(())"), ("delete", "Ok(())"), ("captured_wh", "Some((6, 1))"), ("undo", "Ok(())"), ("restored_anchor", "Some((10, 46))"), ("restored_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })"), ("restored_text", "Some(\"Order intake\")"), ("owner_15_46_is_source", "false"), ("restores", "None"), ("further_place", "Ok(())"), ("restores_after_further", "Some(\"InvalidState(CellCollision)\")")]
//! BITE E: the pending Place's claim forced false: place_then_grow_over_it_in_one_pass_is_refused_resize_covers: first[E:place_then_grow_over_it_in_one_pass_is_refused_resize_covers]=  left: [("place", "Ok(())"), ("grow", "Ok(())"), ("pending", "2"), ("owner_14_50_is_source", "false"), ("label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })"), ("restores", "Some(\"InvalidState(CellCollision)\")")]
//! BITE F: the AddPort arm of `effective_geometry_upto` forced false: add_port_then_grow_over_its_growth_cell_in_one_pass_is_refused_resize_covers, turned_factory_add_port_then_grow_over_a_claimed_cell_in_one_pass_is_refused_resize_covers: first[F:add_port_then_grow_over_its_growth_cell_in_one_pass_is_refused_resize_covers]=  left: [("add_port", "Ok(())"), ("grow", "Ok(())"), ("pending", "2"), ("factory_fp", "Some(Footprint { w: 3, h: 4, rot: 0 })"), ("owner_30_23_is_factory", "false"), ("label_fp", "Some(Footprint { w: 5, h: 1, rot: 0 })"), ("restores", "Some(\"InvalidState(CellCollision)\")")]
//! BITE G: `capture_slice`'s scratch core disabled (`fabrico-command`, worktree only): shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell, grow_then_shrink_in_one_pass_then_two_undos_step_back_through_both_boxes: first[G:grow_then_shrink_in_one_pass_then_two_undos_step_back_through_both_boxes]=  left: [("setup_configure", "Ok(())"), ("pre_box", "Footprint { w: 4, h: 1, rot: 0 }"), ("pre_text", "Some(\"A\")"), ("grow", "Ok(())"), ("shrink", "Ok(())"), ("after_fold_box", "Footprint { w: 4, h: 1, rot: 0 }"), ("after_fold_text", "Some(\"C\")"), ("first_undo", "Ok(())"), ("first_undo_box", "Footprint { w: 4, h: 1, rot: 0 }"), ("first_undo_text", "Some(\"A\")"), ("first_undo_owner_15_54_is_label", "false"), ("first_undo_restores", "None"), ("second_undo", "Ok(())"), ("second_undo_box", "Footprint { w: 4, h: 1, rot: 0 }"), ("second_undo_text", "Some(\"A\")"), ("second_undo_owner_15_54", "None"), ("second_undo_restores", "None")]
//! BITE H: the pending Rotate's claim forced false: rotate_then_grow_onto_its_new_cells_in_one_pass_is_refused_resize_covers: first[H:rotate_then_grow_onto_its_new_cells_in_one_pass_is_refused_resize_covers]=  left: [("rotate", "Ok(())"), ("grow", "Ok(())"), ("pending", "2"), ("router_fp", "Some(Footprint { w: 2, h: 3, rot: 1 })"), ("owner_22_28_is_router", "false"), ("label_fp", "Some(Footprint { w: 4, h: 3, rot: 0 })"), ("restores", "Some(\"InvalidState(CellCollision)\")")]
//! BITE I: the pending DrawBelt's claim forced false: draw_belt_then_grow_across_its_tiles_in_one_pass_is_refused_resize_covers: first[I:draw_belt_then_grow_across_its_tiles_in_one_pass_is_refused_resize_covers]=  left: [("draw_belt", "Ok(())"), ("grow", "Ok(())"), ("pending", "2"), ("belt_on_15_24", "false"), ("label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })"), ("restores", "Some(\"InvalidState(CellCollision)\")")]

use fabrico_command::CommandError;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::snapshot::{restore, snapshot};
use fabrico_core::state::Node;
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands, seed_scene};
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::project::{load_project, save_project};
use fabrico_protocol::{GridCommand, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// A demo-booted host plus the channel triple `tick_once` requires, every half held
/// alive for the probe's lifetime (the `undo_on_demo_board.rs` shape).
pub struct Probe {
    pub host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    results_rx: UnboundedReceiver<ResultEvent>,
    cmd_tx: UnboundedSender<Command>,
    _ingress_tx: UnboundedSender<EventPayload>,
    _res_tx: UnboundedSender<ResultEvent>,
    _cmd_rx: UnboundedReceiver<Command>,
    _dirs: Vec<tempfile::TempDir>,
}

/// A `Host` booted the way the shipped app boots: genesis at [`DEMO_GENESIS_SEED`], the
/// demo's commands through the certified gesture path (`seed_scene`, which seals the
/// history). No timers, so the board stays quiescent between legs.
pub fn demo_host() -> Probe {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: DEMO_GENESIS_SEED,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let mut host = Host::new(core, store, ledger, None).expect("open host");
    seed_scene(&mut host, &demo_commands()).expect("seed_scene folds every demo command");

    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    Probe {
        host,
        ingress_rx,
        results_rx,
        cmd_tx,
        _ingress_tx: ingress_tx,
        _res_tx: res_tx,
        _cmd_rx: cmd_rx,
        _dirs: vec![dir],
    }
}

/// Fold ONE tick: what Play runs after the drain pass.
pub fn fold(probe: &mut Probe) {
    probe
        .host
        .tick_once(&mut probe.ingress_rx, &mut probe.results_rx, &probe.cmd_tx)
        .expect("tick_once persists and folds");
}

/// Place a `kind` at `cell`, fold it in its own tick, and return the minted id (read
/// off `last_tick.placed`).
pub fn place(probe: &mut Probe, kind: u8, cell: (i32, i32)) -> NodeId {
    apply_gesture(
        &mut probe.host,
        GridCommand::Place { kind, cell_x: cell.0, cell_y: cell.1 },
        |_| None,
    )
    .expect("the place is accepted");
    fold(probe);
    probe.host.core().last_tick.placed[0]
}

/// The wire-side `Configure{Label}` config: `text`, colour 3, `w` by `h`.
pub fn label_config(text: &str, w: u16, h: u16) -> fabrico_protocol::MachineConfig {
    fabrico_protocol::MachineConfig::Label { text: text.to_owned(), colour: 3, w, h }
}

/// Apply `cmds` through `apply_gesture` in order, every handle resolved through ONE
/// table, with NO fold between them (one `acquire_input` drain pass), and return every
/// verdict.
pub fn pass(probe: &mut Probe, table: &[(u64, NodeId)], cmds: Vec<GridCommand>) -> Vec<Result<(), CommandError>> {
    cmds.into_iter()
        .map(|cmd| {
            apply_gesture(&mut probe.host, cmd, |h| {
                table.iter().find(|(k, _)| *k == h).map(|(_, n)| *n)
            })
        })
        .collect()
}

/// The snapshot trust gate on the folded core: `restore(&snapshot(core))`'s error as
/// its Debug text, `None` when the board would load.
pub fn restores(core: &Core) -> Option<String> {
    restore(&snapshot(core)).err().map(|e| format!("{e:?}"))
}

/// Debug text of any fact, for the labelled-pair `Vec`.
fn dbg<T: std::fmt::Debug>(v: T) -> String {
    format!("{v:?}")
}

/// A 4 by 1 label at (10,20), folded (x 10 to 13). ONE pass: Configure it to 6 by 1
/// (now x 10 to 15), then Place a Source at (15,20), a cell the grow now covers. The
/// host must refuse the Place inside the pass, the fold must leave the label owning
/// (15,20), and the board the user saves must open again.
///
/// RED before the fix (CR-02): the Place was answered `Ok(())`, both records folded onto
/// one cell, and the snapshot gate refused the board `CellCollision`.
#[test]
fn grow_then_place_on_a_covered_cell_in_one_pass_is_refused_and_the_board_reloads() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 20));

    let verdicts = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 6, 1) },
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 15, cell_y: 20 },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);

    let core = probe.host.core();
    let mut facts: Vec<(&'static str, String)> = vec![
        ("configure", dbg(verdicts[0])),
        ("place", dbg(verdicts[1])),
        ("pending", pending.to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("owner_15_20", dbg(core.state.occupied((15, 20)))),
        ("restores", dbg(restores(core))),
    ];

    let save_dir = tempfile::tempdir().expect("save tempdir");
    let fab = save_dir.path().join("label_same_pass.fab");
    let saved = save_project(&probe.host, &fab);
    facts.push(("save", dbg(&saved)));
    let load_dir = tempfile::tempdir().expect("load work dir");
    let loaded = load_project(&fab, load_dir.path(), None);
    let (load, loaded_fp) = match &loaded {
        Ok(h) => {
            let fp = h.core().state.occupied((10, 20)).and_then(|n| h.core().state.footprint_of(n));
            ("Ok(())".to_owned(), dbg(fp))
        }
        Err(e) => (dbg(Err::<(), _>(e)), "no board".to_owned()),
    };
    facts.push(("load", load));
    facts.push(("loaded_label_fp", loaded_fp));

    let expected: Vec<(&'static str, String)> = vec![
        ("configure", "Ok(())".to_owned()),
        ("place", "Err(FootprintCollision)".to_owned()),
        ("pending", "1".to_owned()),
        ("label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })".to_owned()),
        ("owner_15_20", dbg(Some(label))),
        ("restores", "None".to_owned()),
        ("save", "Ok(())".to_owned()),
        ("load", "Ok(())".to_owned()),
        ("loaded_label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })".to_owned()),
    ];
    assert_eq!(facts, expected, "a grow then a Place on a covered cell, in one drain pass");
}

/// A label at (10,38) grown to 6 by 1 (x 10 to 15) and folded in its own pass. ONE
/// pass: Configure it to 4 by 1 (x 10 to 13), then Place a Source at (15,38), a cell the
/// shrink frees. The host must accept the Place inside the pass, and the folded board
/// must pass the snapshot trust gate with the Source on (15,38).
///
/// The setup is asserted, not assumed: `pre_label_fp` and `pre_owner_15_38` are read
/// after the setup fold and before the pass, so a grow that silently did nothing (the
/// cell was always free) cannot pass this leg.
///
/// RED before the fix (CR-02): the pending shrink was invisible, so (15,38) still read
/// as the label's and the Place was refused `FootprintCollision`.
#[test]
fn shrink_then_place_on_the_freed_cell_in_one_pass_is_accepted_and_the_board_reloads() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 38));
    let setup = pass(
        &mut probe,
        &[(0, label)],
        vec![GridCommand::Configure { node: 0, config: label_config("Order intake", 6, 1) }],
    );
    fold(&mut probe);
    let mut facts: Vec<(&'static str, String)> = vec![
        ("setup_configure", dbg(setup[0])),
        ("pre_label_fp", dbg(probe.host.core().state.footprint_of(label))),
        ("pre_owner_15_38", dbg(probe.host.core().state.occupied((15, 38)))),
    ];

    let verdicts = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 4, 1) },
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 15, cell_y: 38 },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);

    let core = probe.host.core();
    let owner = core.state.occupied((15, 38));
    facts.extend([
        ("configure", dbg(verdicts[0])),
        ("place", dbg(verdicts[1])),
        ("pending", pending.to_string()),
        ("owner_15_38_is_source", dbg(owner.and_then(|n| core.state.node(n)).is_some_and(|n| matches!(n, Node::Source(_))))),
        ("owner_15_38_anchor", dbg(owner.and_then(|n| core.state.cell_of(n)))),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ]);

    let expected: Vec<(&'static str, String)> = vec![
        ("setup_configure", "Ok(())".to_owned()),
        ("pre_label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })".to_owned()),
        ("pre_owner_15_38", dbg(Some(label))),
        ("configure", "Ok(())".to_owned()),
        ("place", "Ok(())".to_owned()),
        ("pending", "2".to_owned()),
        ("owner_15_38_is_source", "true".to_owned()),
        ("owner_15_38_anchor", "Some((15, 38))".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a shrink then a Place on the freed cell, in one drain pass");
}

/// A label at (10,46) configured 6 by 1 (x 10 to 15) and folded. ONE pass: shrink it to
/// 4 by 1 (x 10 to 13), Place a Source at (15,46), a cell the shrink freed, and Delete
/// the label. Fold, then Undo (the buffer is empty, `apply_gesture`'s precondition),
/// and fold. The label must come back at its shrunk 4 by 1 box, the Source must keep
/// (15,46) in the occupancy index, a further Place there must be refused, and the board
/// must pass the snapshot trust gate.
///
/// RED before plan 76-11's `label_boxes` (CR-02 refuter round on plan 76-07):
/// `apply_gesture` captured the Delete on the PRE-PASS core, so the capture said 6 by 1.
/// The Undo's re-Place claimed the old 6 by 1 box over the Source (claim, never evict),
/// the re-Configure shrank it and freed (14,46) and (15,46) from the index, the
/// Source's cell read unowned, and a further Place on it was accepted.
#[test]
fn shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 46));
    let setup = pass(
        &mut probe,
        &[(0, label)],
        vec![GridCommand::Configure { node: 0, config: label_config("Order intake", 6, 1) }],
    );
    fold(&mut probe);
    let mut facts: Vec<(&'static str, String)> = vec![
        ("setup_configure", dbg(setup[0])),
        ("pre_label_fp", dbg(probe.host.core().state.footprint_of(label))),
        ("pre_owner_15_46", dbg(probe.host.core().state.occupied((15, 46)))),
    ];

    let verdicts = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 4, 1) },
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 15, cell_y: 46 },
            GridCommand::Delete { node: 0 },
        ],
    );
    fold(&mut probe);
    let captured_wh = probe
        .host
        .logged_edits()
        .expect("read the edit log")
        .iter()
        .rev()
        .find_map(|r| match &r.op {
            fabrico_core::edit::EditOp::Delete { node, captured, .. } if *node == label => {
                Some((captured.w, captured.h))
            }
            _ => None,
        });
    let undo = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);

    let core = probe.host.core();
    let restored = core.state.occupied((10, 46));
    let owner = core.state.occupied((15, 46));
    facts.extend([
        ("shrink", dbg(verdicts[0])),
        ("place", dbg(verdicts[1])),
        ("delete", dbg(verdicts[2])),
        ("captured_wh", dbg(captured_wh)),
        ("undo", dbg(undo[0])),
        ("restored_anchor", dbg(restored.and_then(|n| core.state.cell_of(n)))),
        ("restored_fp", dbg(restored.and_then(|n| core.state.footprint_of(n)))),
        (
            "restored_text",
            dbg(restored.and_then(|n| match core.state.node(n) {
                Some(Node::Label(l)) => Some(l.text.clone()),
                _ => None,
            })),
        ),
        (
            "owner_15_46_is_source",
            dbg(owner.and_then(|n| core.state.node(n)).is_some_and(|n| matches!(n, Node::Source(_)))),
        ),
        ("restores", dbg(restores(core))),
    ]);
    let further = pass(
        &mut probe,
        &[],
        vec![GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 15, cell_y: 46 }],
    );
    facts.push(("further_place", dbg(further[0])));
    fold(&mut probe);
    facts.push(("restores_after_further", dbg(restores(probe.host.core()))));

    let expected: Vec<(&'static str, String)> = vec![
        ("setup_configure", "Ok(())".to_owned()),
        ("pre_label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })".to_owned()),
        ("pre_owner_15_46", dbg(Some(label))),
        ("shrink", "Ok(())".to_owned()),
        ("place", "Ok(())".to_owned()),
        ("delete", "Ok(())".to_owned()),
        ("captured_wh", "Some((4, 1))".to_owned()),
        ("undo", "Ok(())".to_owned()),
        ("restored_anchor", "Some((10, 46))".to_owned()),
        ("restored_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restored_text", "Some(\"Order intake\")".to_owned()),
        ("owner_15_46_is_source", "true".to_owned()),
        ("restores", "None".to_owned()),
        ("further_place", "Err(FootprintCollision)".to_owned()),
        ("restores_after_further", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a shrink, a Place on the freed cell and a Delete in one pass, then Undo");
}

// ---------------------------------------------------------------------------------
// CR-02 refuter round on plan 76-07, defect 2: every other record that takes a cell,
// in both orders, against a pending label resize in one drain pass. Names, cells and
// pair labels follow plan 76-11's Task 2 and Task 3 text so that plan finds them.
// ---------------------------------------------------------------------------------

/// The kind name of the node owning `cell` in the folded core, `"none"` when free.
fn owner_kind(core: &Core, cell: (i32, i32)) -> &'static str {
    match core.state.occupied(cell).and_then(|n| core.state.node(n)) {
        None => "none",
        Some(Node::Label(_)) => "label",
        Some(Node::Source(_)) => "source",
        Some(Node::Factory(_)) => "factory",
        Some(Node::Belt(_)) => "belt",
        Some(_) => "other",
    }
}

/// The panel's `+ Add output` on handle 0: an OUT port on side E, mechanical.
fn add_out() -> GridCommand {
    GridCommand::AddPort {
        node: 0,
        role: fabrico_protocol::port_role::OUT,
        side: fabrico_core::state::Side::E as u8,
        medium: fabrico_protocol::port_medium::MECHANICAL,
    }
}

/// A Factory at (30,20) with two `add_out`s, each folded: 3 by 3, so the next add grows
/// row y 23 (x 30 to 32). Asserted as a measured premise.
fn factory_with_two_outs(probe: &mut Probe) -> NodeId {
    let f = place(probe, machine_kind::FACTORY, (30, 20));
    for _ in 0..2 {
        let v = pass(probe, &[(0, f)], vec![add_out()]);
        assert_eq!(v, vec![Ok(())], "measured: an add on clear floor is accepted");
        fold(probe);
    }
    assert_eq!(
        probe.host.core().state.footprint_of(f),
        Some(fabrico_core::state::Footprint { w: 3, h: 3, rot: 0 }),
        "measured: a two-output Factory is 3 by 3"
    );
    assert_eq!(owner_kind(probe.host.core(), (30, 23)), "none", "measured: (30,23) is free before the third add");
    f
}

/// A Router at (20,28) folded at rot 0, asserted to cover x 20 to 21, y 28 to 30 and
/// to leave (22,28) free.
fn router_at_20_28(probe: &mut Probe) -> NodeId {
    let r = place(probe, machine_kind::ROUTER, (20, 28));
    assert_eq!(
        probe.host.core().state.footprint_of(r),
        Some(fabrico_core::state::Footprint { w: 2, h: 3, rot: 0 }),
        "measured: a Router is 2 by 3 at rot 0"
    );
    assert_eq!(probe.host.core().state.occupied((22, 28)), None, "measured: (22,28) is free at rot 0");
    r
}

/// Grow then DrawBelt: a label at (10,24) grown to 6 by 1 (x 10 to 15), then a belt down
/// x 15 from y 22 to 25, crossing (15,24). The belt is refused; no belt folds.
#[test]
fn grow_then_draw_belt_across_a_covered_cell_in_one_pass_is_refused() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 24));
    let v = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 6, 1) },
            GridCommand::DrawBelt { cells: vec![(15, 22), (15, 23), (15, 24), (15, 25)] },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("configure", dbg(v[0])),
        ("draw_belt", dbg(v[1])),
        ("pending", pending.to_string()),
        ("owner_15_23", owner_kind(core, (15, 23)).to_owned()),
        ("owner_15_24", owner_kind(core, (15, 24)).to_owned()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("configure", "Ok(())".to_owned()),
        ("draw_belt", "Err(FootprintCollision)".to_owned()),
        ("pending", "1".to_owned()),
        ("owner_15_23", "none".to_owned()),
        ("owner_15_24", "label".to_owned()),
        ("label_fp", "Some(Footprint { w: 6, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a grow then a DrawBelt across a covered cell, in one drain pass");
}

/// DrawBelt then grow: the same belt drawn first, then the label grown over (15,24). The
/// grow is refused `ResizeCovers`; the belt folds and the label stays 4 by 1.
#[test]
fn draw_belt_then_grow_across_its_tiles_in_one_pass_is_refused_resize_covers() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 24));
    let v = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::DrawBelt { cells: vec![(15, 22), (15, 23), (15, 24), (15, 25)] },
            GridCommand::Configure { node: 0, config: label_config("Order intake", 6, 1) },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("draw_belt", dbg(v[0])),
        ("grow", dbg(v[1])),
        ("pending", pending.to_string()),
        ("belt_on_15_24", (owner_kind(core, (15, 24)) == "belt").to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("draw_belt", "Ok(())".to_owned()),
        ("grow", "Err(ResizeCovers)".to_owned()),
        ("pending", "1".to_owned()),
        ("belt_on_15_24", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a DrawBelt then a grow across its tiles, in one drain pass");
}

/// Two labels growing into one free cell: L1 at (10,32) and L2 at (14,30), both 4 by 1
/// and folded, (14,32) free. L1 to 5 by 1 claims (14,32); L2 to 4 by 3 (x 14 to 17, y 30
/// to 32) then wants the same cell and is refused `ResizeCovers`.
#[test]
fn two_labels_growing_into_one_free_cell_in_one_pass_refuse_the_second() {
    let mut probe = demo_host();
    let l1 = place(&mut probe, machine_kind::LABEL, (10, 32));
    let l2 = place(&mut probe, machine_kind::LABEL, (14, 30));
    let pre_free = probe.host.core().state.occupied((14, 32));
    let v = pass(
        &mut probe,
        &[(0, l1), (1, l2)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 5, 1) },
            GridCommand::Configure { node: 1, config: label_config("Dispatch", 4, 3) },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("pre_owner_14_32", dbg(pre_free)),
        ("first", dbg(v[0])),
        ("second", dbg(v[1])),
        ("pending", pending.to_string()),
        ("owner_14_32_is_l1", (core.state.occupied((14, 32)) == Some(l1)).to_string()),
        ("l1_fp", dbg(core.state.footprint_of(l1))),
        ("l2_fp", dbg(core.state.footprint_of(l2))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("pre_owner_14_32", "None".to_owned()),
        ("first", "Ok(())".to_owned()),
        ("second", "Err(ResizeCovers)".to_owned()),
        ("pending", "1".to_owned()),
        ("owner_14_32_is_l1", "true".to_owned()),
        ("l1_fp", "Some(Footprint { w: 5, h: 1, rot: 0 })".to_owned()),
        ("l2_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "two labels growing into one free cell, in one drain pass");
}

/// Grow then a neighbour's Rotate: a Router at (20,28) and a label at (22,26), folded.
/// The label grows to 4 by 3 (x 22 to 25, y 26 to 28, clear of the Router at rot 0);
/// the Router's quarter turn (rot 1 covers x 20 to 22, y 28 to 29) then wants (22,28)
/// and is refused.
#[test]
fn grow_then_a_neighbour_rotate_onto_a_covered_cell_in_one_pass_is_refused() {
    let mut probe = demo_host();
    let router = router_at_20_28(&mut probe);
    let label = place(&mut probe, machine_kind::LABEL, (22, 26));
    let v = pass(
        &mut probe,
        &[(0, label), (1, router)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 4, 3) },
            GridCommand::Rotate { node: 1, ccw: false },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("configure", dbg(v[0])),
        ("rotate", dbg(v[1])),
        ("pending", pending.to_string()),
        ("router_fp", dbg(core.state.footprint_of(router))),
        ("owner_22_28_is_label", (core.state.occupied((22, 28)) == Some(label)).to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("configure", "Ok(())".to_owned()),
        ("rotate", "Err(RotateBlocked)".to_owned()),
        ("pending", "1".to_owned()),
        ("router_fp", "Some(Footprint { w: 2, h: 3, rot: 0 })".to_owned()),
        ("owner_22_28_is_label", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 3, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a grow then a neighbour's Rotate onto a covered cell, in one drain pass");
}

/// Rotate then grow: the Router turned first (its rot-1 body claims (22,28) and (22,29)),
/// then the label grown to 4 by 3 over (22,28). The grow is refused `ResizeCovers`.
#[test]
fn rotate_then_grow_onto_its_new_cells_in_one_pass_is_refused_resize_covers() {
    let mut probe = demo_host();
    let router = router_at_20_28(&mut probe);
    let label = place(&mut probe, machine_kind::LABEL, (22, 26));
    let v = pass(
        &mut probe,
        &[(0, label), (1, router)],
        vec![
            GridCommand::Rotate { node: 1, ccw: false },
            GridCommand::Configure { node: 0, config: label_config("Order intake", 4, 3) },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("rotate", dbg(v[0])),
        ("grow", dbg(v[1])),
        ("pending", pending.to_string()),
        ("router_fp", dbg(core.state.footprint_of(router))),
        ("owner_22_28_is_router", (core.state.occupied((22, 28)) == Some(router)).to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("rotate", "Ok(())".to_owned()),
        ("grow", "Err(ResizeCovers)".to_owned()),
        ("pending", "1".to_owned()),
        ("router_fp", "Some(Footprint { w: 2, h: 3, rot: 1 })".to_owned()),
        ("owner_22_28_is_router", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a neighbour's Rotate then a grow onto its new cells, in one drain pass");
}

/// Grow then a neighbour's growing AddPort: a two-output Factory at (30,20) and a label at
/// (26,23), 4 by 1 (x 26 to 29), folded. The label grows to 5 by 1 (claims (30,23)); the
/// Factory's third add then wants row y 23 and is refused (a label is a machine, not a
/// belt, so `GrowBlocked` (`FootprintCollision` until plan 88-02), not `GrowCoversBelt`).
#[test]
fn grow_then_a_neighbour_add_port_onto_a_covered_cell_in_one_pass_is_refused() {
    let mut probe = demo_host();
    let factory = factory_with_two_outs(&mut probe);
    let label = place(&mut probe, machine_kind::LABEL, (26, 23));
    let v = pass(
        &mut probe,
        &[(1, label), (0, factory)],
        vec![GridCommand::Configure { node: 1, config: label_config("Order intake", 5, 1) }, add_out()],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("configure", dbg(v[0])),
        ("add_port", dbg(v[1])),
        ("pending", pending.to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("owner_30_23_is_label", (core.state.occupied((30, 23)) == Some(label)).to_string()),
        ("factory_fp", dbg(core.state.footprint_of(factory))),
        ("outs", core.state.ports_of(factory).map_or(0, |p| p.iter().filter(|p| p.role == fabrico_core::state::Role::Out).count()).to_string()),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("configure", "Ok(())".to_owned()),
        ("add_port", "Err(GrowBlocked)".to_owned()),
        ("pending", "1".to_owned()),
        ("label_fp", "Some(Footprint { w: 5, h: 1, rot: 0 })".to_owned()),
        ("owner_30_23_is_label", "true".to_owned()),
        ("factory_fp", "Some(Footprint { w: 3, h: 3, rot: 0 })".to_owned()),
        ("outs", "3".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a grow then a neighbour's growing AddPort, in one drain pass");
}

/// AddPort then grow: the Factory's third add first (its pending growth claims row y 23),
/// then the label grown to 5 by 1 over (30,23). The grow is refused `ResizeCovers`.
#[test]
fn add_port_then_grow_over_its_growth_cell_in_one_pass_is_refused_resize_covers() {
    let mut probe = demo_host();
    let factory = factory_with_two_outs(&mut probe);
    let label = place(&mut probe, machine_kind::LABEL, (26, 23));
    let v = pass(
        &mut probe,
        &[(1, label), (0, factory)],
        vec![add_out(), GridCommand::Configure { node: 1, config: label_config("Order intake", 5, 1) }],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("add_port", dbg(v[0])),
        ("grow", dbg(v[1])),
        ("pending", pending.to_string()),
        ("factory_fp", dbg(core.state.footprint_of(factory))),
        ("owner_30_23_is_factory", (core.state.occupied((30, 23)) == Some(factory)).to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("add_port", "Ok(())".to_owned()),
        ("grow", "Err(ResizeCovers)".to_owned()),
        ("pending", "1".to_owned()),
        ("factory_fp", "Some(Footprint { w: 3, h: 4, rot: 0 })".to_owned()),
        ("owner_30_23_is_factory", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a neighbour's growing AddPort then a grow over its growth cell, in one drain pass");
}

/// Place then grow: a Source placed at (14,50), then the label at (10,50) grown to 6 by 1
/// over it. The grow is refused `ResizeCovers`.
#[test]
fn place_then_grow_over_it_in_one_pass_is_refused_resize_covers() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 50));
    let v = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 14, cell_y: 50 },
            GridCommand::Configure { node: 0, config: label_config("Order intake", 6, 1) },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("place", dbg(v[0])),
        ("grow", dbg(v[1])),
        ("pending", pending.to_string()),
        ("owner_14_50_is_source", (owner_kind(core, (14, 50)) == "source").to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("place", "Ok(())".to_owned()),
        ("grow", "Err(ResizeCovers)".to_owned()),
        ("pending", "1".to_owned()),
        ("owner_14_50_is_source", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a Place then a grow over it, in one drain pass");
}

/// Grow then shrink then Place: a label at (10,42) folded 4 by 1; one pass grows it to 6
/// by 1, shrinks it back to 4 by 1, and places a Source on (15,42), a cell only the grow
/// took. The Place is accepted: the shrink's free-before reads the GROWN box (the record
/// at its own index in the replay), not the folded one.
#[test]
fn grow_then_shrink_in_one_pass_frees_the_cells_the_grow_took() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 42));
    let v = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 6, 1) },
            GridCommand::Configure { node: 0, config: label_config("Order intake", 4, 1) },
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 15, cell_y: 42 },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("grow", dbg(v[0])),
        ("shrink", dbg(v[1])),
        ("place", dbg(v[2])),
        ("pending", pending.to_string()),
        ("owner_15_42_is_source", (owner_kind(core, (15, 42)) == "source").to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("grow", "Ok(())".to_owned()),
        ("shrink", "Ok(())".to_owned()),
        ("place", "Ok(())".to_owned()),
        ("pending", "3".to_owned()),
        ("owner_15_42_is_source", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a grow then a shrink then a Place on a cell only the grow took, in one drain pass");
}

// ---------------------------------------------------------------------------------
// Plan 76-11: the turned Factory, the Undo's shrinking RemovePort, a shrink that frees a
// cell for a neighbour's turn, and the two-Undo step back.
// ---------------------------------------------------------------------------------

/// The cells of a `w` by `h` box anchored at its min corner `anchor`, rot 0 (a label's
/// box never turns).
fn box_cells(anchor: (i32, i32), w: u16, h: u16) -> Vec<(i32, i32)> {
    (0..i32::from(h))
        .flat_map(|dy| (0..i32::from(w)).map(move |dx| (anchor.0 + dx, anchor.1 + dy)))
        .collect()
}

/// Every cell `node` owns in the folded core over x 34 to 48, y 14 to 28, in (y, x) order.
fn cells_owned_by(core: &Core, node: NodeId) -> Vec<(i32, i32)> {
    (14..=28)
        .flat_map(|y| (34..=48).map(move |x| (x, y)))
        .filter(|&c| core.state.occupied(c) == Some(node))
        .collect()
}

/// A Factory placed at (40,20), turned once clockwise, then grown by two `add_out`s,
/// every step folded on its own tick. Returns its id.
fn turned_factory(probe: &mut Probe) -> NodeId {
    let f = place(probe, machine_kind::FACTORY, (40, 20));
    let turn = pass(probe, &[(0, f)], vec![GridCommand::Rotate { node: 0, ccw: false }]);
    assert_eq!(turn, vec![Ok(())], "measured: an undocked Factory turns on clear floor");
    fold(probe);
    for _ in 0..2 {
        let v = pass(probe, &[(0, f)], vec![add_out()]);
        assert_eq!(v, vec![Ok(())], "measured: an add on clear floor is accepted");
        fold(probe);
    }
    f
}

/// What [`turned_factory_growth`] read off a second demo-booted host.
#[derive(Debug, Clone)]
struct TurnedGrowth {
    /// The Factory's cells before the third add.
    pre_box: Vec<(i32, i32)>,
    /// The cells the third add made the Factory's (one full column of 3).
    growth: Vec<(i32, i32)>,
    /// The Factory's anchor before the third add.
    pre_anchor: (i32, i32),
    /// The Factory's anchor after the third add.
    post_anchor: (i32, i32),
}

/// Measure, on its own demo-booted host, where a turned two-output Factory at (40,20)
/// grows when one more `add_out` folds: its box before, the cells that become its own,
/// and where its anchor goes. Panics with a `measured:` message unless the box before
/// is `Footprint { w: 3, h: 3, rot: 1 }` and the growth is one full column of 3 cells
/// directly west or east of it.
fn turned_factory_growth() -> TurnedGrowth {
    let mut probe = demo_host();
    let f = turned_factory(&mut probe);
    assert_eq!(
        probe.host.core().state.footprint_of(f),
        Some(fabrico_core::state::Footprint { w: 3, h: 3, rot: 1 }),
        "measured: a turned two-output Factory is 3 by 3 at rot 1"
    );
    let pre_box = cells_owned_by(probe.host.core(), f);
    let pre_anchor = probe.host.core().state.cell_of(f).expect("measured: the Factory has an anchor");
    let v = pass(&mut probe, &[(0, f)], vec![add_out()]);
    assert_eq!(v, vec![Ok(())], "measured: the third add on clear floor is accepted");
    fold(&mut probe);
    let post_box = cells_owned_by(probe.host.core(), f);
    let post_anchor = probe.host.core().state.cell_of(f).expect("measured: the Factory has an anchor");
    let growth: Vec<(i32, i32)> = post_box.iter().copied().filter(|c| !pre_box.contains(c)).collect();

    let min_x = pre_box.iter().map(|c| c.0).min().expect("measured: the box has cells");
    let max_x = pre_box.iter().map(|c| c.0).max().expect("measured: the box has cells");
    let mut rows: Vec<i32> = pre_box.iter().map(|c| c.1).collect();
    rows.sort_unstable();
    rows.dedup();
    let gx = growth.first().map(|c| c.0);
    let column = growth.len() == 3
        && growth.iter().all(|c| Some(c.0) == gx)
        && (gx == Some(min_x - 1) || gx == Some(max_x + 1))
        && growth.iter().map(|c| c.1).collect::<Vec<_>>() == rows;
    assert!(
        pre_box.len() == 9 && column,
        "measured: the third add on a turned Factory grows one full column of 3 beside its 3 by 3 box \
         (pre_box {pre_box:?}, growth {growth:?}, pre_anchor {pre_anchor:?}, post_anchor {post_anchor:?})"
    );
    TurnedGrowth { pre_box, growth, pre_anchor, post_anchor }
}

/// Where both turned legs put their label, by a written rule on what
/// [`turned_factory_growth`] measured, so the label's 4 by 1 box touches no Factory cell
/// and its grown box covers exactly one growth cell.
#[derive(Debug, Clone, Copy)]
struct TurnedLabel {
    /// The label's anchor (its min corner).
    anchor: (i32, i32),
    /// The box it grows to, `(w, h)`.
    grown: (u16, u16),
    /// The one growth cell the grown box covers.
    g: (i32, i32),
}

/// The rule. Growth column WEST at `gx`: a 4 by 1 label on the column's middle row,
/// ending one cell west of it (x `gx - 4` to `gx - 1`), grown to 5 by 1 over `(gx, gy)`.
/// Growth column EAST at `gx`: a 4 by 1 label on the row above the box, anchored on the
/// column (x `gx` to `gx + 3`), grown to 4 by 2 over `(gx, top)`.
fn turned_label(m: &TurnedGrowth) -> TurnedLabel {
    let gx = m.growth[0].0;
    let min_x = m.pre_box.iter().map(|c| c.0).min().expect("measured: the box has cells");
    let top = m.pre_box.iter().map(|c| c.1).min().expect("measured: the box has cells");
    if gx < min_x {
        let gy = m.growth[1].1;
        TurnedLabel { anchor: (gx - 4, gy), grown: (5, 1), g: (gx, gy) }
    } else {
        TurnedLabel { anchor: (gx, top - 1), grown: (4, 2), g: (gx, top) }
    }
}

/// Build the turned Factory and the rule's label on a FRESH demo-booted host, both
/// folded, and assert every measured premise: the Factory is the measured 3 by 3 at rot
/// 1 on the measured cells and anchor, the label is 4 by 1, its box touches no Factory
/// cell, and its grown box covers exactly one growth cell, `g`, which is free.
fn turned_factory_and_label(m: &TurnedGrowth, rule: TurnedLabel) -> (Probe, NodeId, NodeId) {
    let mut probe = demo_host();
    let factory = turned_factory(&mut probe);
    let label = place(&mut probe, machine_kind::LABEL, rule.anchor);
    let core = probe.host.core();
    assert_eq!(
        core.state.footprint_of(factory),
        Some(fabrico_core::state::Footprint { w: 3, h: 3, rot: 1 }),
        "measured: the turned Factory is 3 by 3 at rot 1"
    );
    assert_eq!(cells_owned_by(core, factory), m.pre_box, "measured: the Factory holds the measured cells");
    assert_eq!(core.state.cell_of(factory), Some(m.pre_anchor), "measured: the Factory sits at the measured anchor");
    assert_ne!(m.post_anchor, m.pre_anchor, "measured: the turned Factory's third add moves its anchor");
    assert_eq!(
        core.state.footprint_of(label),
        Some(fabrico_core::state::Footprint { w: 4, h: 1, rot: 0 }),
        "measured: a placed label is 4 by 1"
    );
    let label_box = box_cells(rule.anchor, 4, 1);
    assert!(
        label_box.iter().all(|c| !m.pre_box.contains(c) && !m.growth.contains(c)),
        "measured: the label's box {label_box:?} touches no Factory cell, before or after the add"
    );
    let grown = box_cells(rule.anchor, rule.grown.0, rule.grown.1);
    let covered: Vec<(i32, i32)> = grown.iter().copied().filter(|c| m.growth.contains(c)).collect();
    assert_eq!(covered, vec![rule.g], "measured: the grown box covers exactly one growth cell");
    assert!(
        grown.iter().all(|c| !m.pre_box.contains(c)),
        "measured: the grown box touches no cell of the Factory before the add"
    );
    assert_eq!(core.state.occupied(rule.g), None, "measured: the growth cell is free before the pass");
    (probe, factory, label)
}

/// Turned Factory, grow then AddPort: the label's grow claims `g`, a cell of the column
/// the turned Factory's third add would grow into (and whose add moves its anchor). The
/// add is refused; the Factory stays 3 by 3 at its old anchor.
#[test]
fn turned_factory_grow_then_add_port_onto_a_claimed_cell_in_one_pass_is_refused() {
    let m = turned_factory_growth();
    let rule = turned_label(&m);
    let (mut probe, factory, label) = turned_factory_and_label(&m, rule);
    let v = pass(
        &mut probe,
        &[(0, factory), (1, label)],
        vec![
            GridCommand::Configure { node: 1, config: label_config("Order intake", rule.grown.0, rule.grown.1) },
            add_out(),
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("configure", dbg(v[0])),
        ("add_port", dbg(v[1])),
        ("pending", pending.to_string()),
        ("factory_fp", dbg(core.state.footprint_of(factory))),
        ("factory_anchor", dbg(core.state.cell_of(factory))),
        ("owner_g_is_label", (core.state.occupied(rule.g) == Some(label)).to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("configure", "Ok(())".to_owned()),
        ("add_port", "Err(GrowBlocked)".to_owned()),
        ("pending", "1".to_owned()),
        ("factory_fp", "Some(Footprint { w: 3, h: 3, rot: 1 })".to_owned()),
        ("factory_anchor", dbg(Some(m.pre_anchor))),
        ("owner_g_is_label", "true".to_owned()),
        ("label_fp", dbg(Some(fabrico_core::state::Footprint { w: rule.grown.0, h: rule.grown.1, rot: 0 }))),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a grow then a turned Factory's growing AddPort onto a claimed cell, in one drain pass");
}

/// Turned Factory, AddPort then grow: the third add first (its pending growth claims the
/// column and moves the anchor), then the label's grow over `g`. The grow is refused
/// `ResizeCovers`; the Factory folds 3 by 4 at the measured new anchor.
#[test]
fn turned_factory_add_port_then_grow_over_a_claimed_cell_in_one_pass_is_refused_resize_covers() {
    let m = turned_factory_growth();
    let rule = turned_label(&m);
    let (mut probe, factory, label) = turned_factory_and_label(&m, rule);
    let v = pass(
        &mut probe,
        &[(0, factory), (1, label)],
        vec![
            add_out(),
            GridCommand::Configure { node: 1, config: label_config("Order intake", rule.grown.0, rule.grown.1) },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("add_port", dbg(v[0])),
        ("grow", dbg(v[1])),
        ("pending", pending.to_string()),
        ("factory_fp", dbg(core.state.footprint_of(factory))),
        ("factory_anchor", dbg(core.state.cell_of(factory))),
        ("owner_g_is_factory", (core.state.occupied(rule.g) == Some(factory)).to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("add_port", "Ok(())".to_owned()),
        ("grow", "Err(ResizeCovers)".to_owned()),
        ("pending", "1".to_owned()),
        ("factory_fp", "Some(Footprint { w: 3, h: 4, rot: 1 })".to_owned()),
        ("factory_anchor", dbg(Some(m.post_anchor))),
        ("owner_g_is_factory", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a turned Factory's growing AddPort then a grow over a claimed cell, in one drain pass");
}

/// The Undo's shrinking RemovePort, then a grow into the cell it frees, then a Place
/// there. A label at (26,23), 4 by 1 (x 26 to 29), placed and folded BEFORE the Factory
/// so the Undo names the Factory's last add; the Factory at (30,20) with a third
/// `add_out` folded, 3 by 4 and owning (30,23). Then, with no fold between: Undo (the
/// buffer is empty, `apply_gesture`'s precondition; its group holds a RemovePort whose
/// `restore` is `Some`, asserted), the label grown to 5 by 1 into (30,23), which the
/// shrink frees, and a Source placed on (30,23), refused because the grow took it.
///
/// The live drain never forms this pass: `acquire_input` ends a pass at every Undo, and
/// the panel's RemovePort freezes `restore: None`. This leg pins the adapter's replay
/// order for the only record that SHRINKS a machine, not a user path.
#[test]
fn undo_shrink_then_grow_into_the_freed_cell_then_place_there_is_refused() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (26, 23));
    let factory = factory_with_two_outs(&mut probe);
    let third = pass(&mut probe, &[(0, factory)], vec![add_out()]);
    assert_eq!(third, vec![Ok(())], "measured: the third add on clear floor is accepted");
    fold(&mut probe);
    assert_eq!(
        probe.host.core().state.footprint_of(factory),
        Some(fabrico_core::state::Footprint { w: 3, h: 4, rot: 0 }),
        "measured: a three-output Factory is 3 by 4"
    );
    assert_eq!(probe.host.core().state.occupied((30, 23)), Some(factory), "measured: (30,23) is the Factory's");
    assert!(probe.host.pending_edits().is_empty(), "measured: the buffer is empty before the Undo");

    let undo = pass(&mut probe, &[], vec![GridCommand::Undo]);
    let restore_some = probe
        .host
        .pending_edits()
        .iter()
        .any(|r| matches!(r.op, fabrico_core::edit::EditOp::RemovePort { node, restore: Some(_), .. } if node == factory));
    assert!(restore_some, "measured: the Undo's group holds the Factory's RemovePort with restore Some");
    let v = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 5, 1) },
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 30, cell_y: 23 },
        ],
    );
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("undo", dbg(undo[0])),
        ("grow", dbg(v[0])),
        ("place", dbg(v[1])),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("owner_30_23_is_label", (core.state.occupied((30, 23)) == Some(label)).to_string()),
        ("factory_fp", dbg(core.state.footprint_of(factory))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("undo", "Ok(())".to_owned()),
        ("grow", "Ok(())".to_owned()),
        ("place", "Err(FootprintCollision)".to_owned()),
        ("label_fp", "Some(Footprint { w: 5, h: 1, rot: 0 })".to_owned()),
        ("owner_30_23_is_label", "true".to_owned()),
        ("factory_fp", "Some(Footprint { w: 3, h: 3, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "an Undo's shrinking RemovePort, a grow into the freed cell, then a Place there");
}

/// Shrink then a neighbour's Rotate: the Router at (20,28) at rot 0 and a label at
/// (22,26) configured to 4 by 3 and folded (it covers (22,28), clear of the Router at rot
/// 0). One pass: the label shrinks to 4 by 1, then the Router turns; its rot-1 body
/// claims (22,28), which the shrink freed, so the turn is accepted.
#[test]
fn shrink_then_a_neighbour_rotate_into_a_freed_cell_in_one_pass_is_accepted() {
    let mut probe = demo_host();
    let router = router_at_20_28(&mut probe);
    let label = place(&mut probe, machine_kind::LABEL, (22, 26));
    let setup = pass(
        &mut probe,
        &[(0, label)],
        vec![GridCommand::Configure { node: 0, config: label_config("Order intake", 4, 3) }],
    );
    assert_eq!(setup, vec![Ok(())], "measured: the 4 by 3 grow is clear of the Router at rot 0");
    fold(&mut probe);
    assert_eq!(probe.host.core().state.occupied((22, 28)), Some(label), "measured: the label owns (22,28)");

    let v = pass(
        &mut probe,
        &[(0, label), (1, router)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("Order intake", 4, 1) },
            GridCommand::Rotate { node: 1, ccw: false },
        ],
    );
    let pending = probe.host.pending_edits().len();
    fold(&mut probe);
    let core = probe.host.core();
    let facts: Vec<(&'static str, String)> = vec![
        ("shrink", dbg(v[0])),
        ("rotate", dbg(v[1])),
        ("pending", pending.to_string()),
        ("router_fp", dbg(core.state.footprint_of(router))),
        ("owner_22_28_is_router", (core.state.occupied((22, 28)) == Some(router)).to_string()),
        ("label_fp", dbg(core.state.footprint_of(label))),
        ("restores", dbg(restores(core))),
    ];
    let expected: Vec<(&'static str, String)> = vec![
        ("shrink", "Ok(())".to_owned()),
        ("rotate", "Ok(())".to_owned()),
        ("pending", "2".to_owned()),
        ("router_fp", "Some(Footprint { w: 2, h: 3, rot: 1 })".to_owned()),
        ("owner_22_28_is_router", "true".to_owned()),
        ("label_fp", "Some(Footprint { w: 4, h: 1, rot: 0 })".to_owned()),
        ("restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a shrink then a neighbour's Rotate into the freed cell, in one drain pass");
}

/// The label's text, `None` when `node` is not a label.
fn label_text(core: &Core, node: NodeId) -> Option<String> {
    match core.state.node(node) {
        Some(Node::Label(l)) => Some(l.text.clone()),
        _ => None,
    }
}

/// The label's box as bare `Footprint { .. }` Debug text (`"none"` when it has none), so
/// the two-Undo leg's box facts read `("first_undo_box", "Footprint { w: 6, h: 1, rot: 0 }")`,
/// the token plan 76-12 greps.
fn box_of(core: &Core, node: NodeId) -> String {
    core.state.footprint_of(node).map_or_else(|| "none".to_owned(), dbg)
}

/// Grow then shrink in one pass, then two Undos. A label at (10,54) folded 4 by 1 with
/// text `A`; one pass grows it to 6 by 1 (text `B`) and shrinks it to 4 by 1 (text `C`).
/// The fold captures both records' prior configs through `capture_slice`'s
/// `names_a_node_twice` path, and an Undo replays them with no validation, so the first
/// Undo must step back to 6 by 1 `B` (owning (15,54) again) and the second, in its own
/// pass (the drain's own rule), to 4 by 1 `A`.
#[test]
fn grow_then_shrink_in_one_pass_then_two_undos_step_back_through_both_boxes() {
    let mut probe = demo_host();
    let label = place(&mut probe, machine_kind::LABEL, (10, 54));
    let setup = pass(
        &mut probe,
        &[(0, label)],
        vec![GridCommand::Configure { node: 0, config: label_config("A", 4, 1) }],
    );
    fold(&mut probe);
    let mut facts: Vec<(&'static str, String)> = vec![
        ("setup_configure", dbg(setup[0])),
        ("pre_box", box_of(probe.host.core(), label)),
        ("pre_text", dbg(label_text(probe.host.core(), label))),
    ];

    let v = pass(
        &mut probe,
        &[(0, label)],
        vec![
            GridCommand::Configure { node: 0, config: label_config("B", 6, 1) },
            GridCommand::Configure { node: 0, config: label_config("C", 4, 1) },
        ],
    );
    fold(&mut probe);
    facts.extend([
        ("grow", dbg(v[0])),
        ("shrink", dbg(v[1])),
        ("after_fold_box", box_of(probe.host.core(), label)),
        ("after_fold_text", dbg(label_text(probe.host.core(), label))),
    ]);

    let first = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);
    let core = probe.host.core();
    facts.extend([
        ("first_undo", dbg(first[0])),
        ("first_undo_box", box_of(core, label)),
        ("first_undo_text", dbg(label_text(core, label))),
        ("first_undo_owner_15_54_is_label", (core.state.occupied((15, 54)) == Some(label)).to_string()),
        ("first_undo_restores", dbg(restores(core))),
    ]);

    let second = pass(&mut probe, &[], vec![GridCommand::Undo]);
    fold(&mut probe);
    let core = probe.host.core();
    facts.extend([
        ("second_undo", dbg(second[0])),
        ("second_undo_box", box_of(core, label)),
        ("second_undo_text", dbg(label_text(core, label))),
        ("second_undo_owner_15_54", dbg(core.state.occupied((15, 54)))),
        ("second_undo_restores", dbg(restores(core))),
    ]);

    let expected: Vec<(&'static str, String)> = vec![
        ("setup_configure", "Ok(())".to_owned()),
        ("pre_box", "Footprint { w: 4, h: 1, rot: 0 }".to_owned()),
        ("pre_text", "Some(\"A\")".to_owned()),
        ("grow", "Ok(())".to_owned()),
        ("shrink", "Ok(())".to_owned()),
        ("after_fold_box", "Footprint { w: 4, h: 1, rot: 0 }".to_owned()),
        ("after_fold_text", "Some(\"C\")".to_owned()),
        ("first_undo", "Ok(())".to_owned()),
        ("first_undo_box", "Footprint { w: 6, h: 1, rot: 0 }".to_owned()),
        ("first_undo_text", "Some(\"B\")".to_owned()),
        ("first_undo_owner_15_54_is_label", "true".to_owned()),
        ("first_undo_restores", "None".to_owned()),
        ("second_undo", "Ok(())".to_owned()),
        ("second_undo_box", "Footprint { w: 4, h: 1, rot: 0 }".to_owned()),
        ("second_undo_text", "Some(\"A\")".to_owned()),
        ("second_undo_owner_15_54", "None".to_owned()),
        ("second_undo_restores", "None".to_owned()),
    ];
    assert_eq!(facts, expected, "a grow then a shrink in one pass, then two Undos");
}
