//! Phase 76 (SHAPE-10, D-01, D-03, D-04): a Label is a real node on the board, minted by
//! the same `Place` command every machine uses, and it does nothing but sit there.
//!
//! # What each leg carries
//! - `place_mints_a_label_with_its_box_and_inbox` (SHAPE-10, D-02): `Place{kind 11}` mints
//!   ONE `Node::Label` with empty text and the default colour `Sand`, a 4 by 1 footprint
//!   at rot 0, no `ports` entry and an inbox (the snapshot load check refuses a node
//!   without one).
//! - `place_draws_no_random_number` (D-03): the global sim RNG is equal before and after a
//!   label `Place`, on a board that has already drawn once (a Factory placed first). A
//!   draw in the label's fold arm would shift every later Factory's sub-seed.
//! - `the_label_kind_has_a_catalog_arm` (D-02): `port_catalog(LABEL)` is the shared
//!   `LABEL_PLACED_FOOTPRINT` and no ports, so the ghost and the fold read one box.
//! - `a_machine_cannot_be_placed_on_a_label`, `a_label_cannot_be_placed_on_a_machine_or_a_label`
//!   (D-01, the "Takes its cells" decision): a label owns its cells exactly like a machine, so
//!   every overlapping `Place` is `FootprintCollision`, through the shared collision path
//!   with no special case for labels.
//! - `a_belt_cannot_be_drawn_through_a_label` (D-01): a forged `DrawBelt` whose tiles cross
//!   a label cell is refused. The tag is MEASURED, not guessed (see the leg).
//! - `a_label_does_not_turn` (D-04): a forged `Rotate` naming a label is `WrongKind`, and
//!   its box stays 4x1 at rot 0.
//! - `a_belt_cannot_dock_to_a_label`, `a_belt_cannot_dock_to_a_labels_fault_port`,
//!   `a_wire_cannot_start_at_a_label`, `a_wire_cannot_end_at_a_label`,
//!   `a_label_cannot_gain_a_port` (SHAPE-14, D-07, plan 76-04): every shape a forged client
//!   could send to join a label to the flow is `LabelDoesNotConnect`, board unchanged.
//!
//! Every leg builds its board through `GridSession::apply`, the seam the host uses, never
//! by poking `GridState`.
//!
//! Run target: `cargo test -p fabrico-command --test label`
//!
//! MUTATION (place_draws_no_random_number, run 2026-10-07 in a throwaway worktree, reverted):
//! one `core.rng.next_u64()` in `fold_place`'s LABEL arm reddened this leg with "a label Place
//! moved the global sim RNG ...", every other leg green.
//! MUTATION (a_label_does_not_turn): with the Rotate arm's label check removed (throwaway
//! worktree, reverted) the leg reddens with `left: None, right: Some(Malformed)`: the Rotate
//! was ACCEPTED and turned the free 4x1. That is also the red it showed before the check
//! landed (plan 76-01 task 2).

use fabrico_command::{CommandError, GridSession, port_catalog};
use fabrico_core::ids::NodeId;
use fabrico_core::state::{Footprint, LABEL_PLACED_FOOTPRINT, LabelColour, Node};
use fabrico_protocol::{GridCommand, machine_kind};

const SEED: u64 = 0x1A_BE11;

/// Place `kind` at a cell through the session and return the id it minted.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> NodeId {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("place at a free cell");
    *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the placed node minted an id")
}

#[test]
fn place_mints_a_label_with_its_box_and_inbox() {
    let mut session = GridSession::new(SEED);
    let nodes_before = session.core().state.node_count();
    let id = place(&mut session, machine_kind::LABEL, 10, 12);
    assert_eq!(
        session.core().state.node_count(),
        nodes_before + 1,
        "one label Place mints exactly one node"
    );
    match session.core().state.node(id) {
        Some(Node::Label(label)) => {
            assert_eq!(label.text, "", "a placed label starts with no words");
            assert_eq!(label.colour, LabelColour::Sand, "a placed label starts Sand");
        }
        other => panic!("Place{{kind 11}} must mint a Node::Label, got {other:?}"),
    }
    assert_eq!(session.core().state.cell_of(id), Some((10, 12)), "anchored where placed");
    assert_eq!(
        session.core().state.footprint_of(id),
        Some(Footprint { w: 4, h: 1, rot: 0 }),
        "a placed label is 4 wide by 1 deep at rot 0 (UI-SPEC U-2)"
    );
    for x in 10..14 {
        assert_eq!(
            session.core().state.occupied((x, 12)),
            Some(id),
            "the label owns cell ({x},12)"
        );
    }
    assert_eq!(session.core().state.occupied((14, 12)), None, "and nothing past its box");
    assert!(
        session.core().state.ports_of(id).is_none(),
        "a label has no ports entry at all"
    );
    assert!(
        session.core().state.inbox_of(id).is_some(),
        "a label has an inbox: the snapshot load check refuses a node without one"
    );
}

#[test]
fn place_draws_no_random_number() {
    let mut session = GridSession::new(SEED);
    // A Factory first, so the board has drawn from the global RNG once and the state
    // compared below is not the genesis state.
    place(&mut session, machine_kind::FACTORY, 0, 0);
    let before = session.core().rng.clone();
    place(&mut session, machine_kind::LABEL, 10, 12);
    assert!(
        session.core().rng == before,
        "a label Place moved the global sim RNG: a draw in the label's fold arm shifts \
         every later Factory's sub-seed (D-03)"
    );
}

#[test]
fn the_label_kind_has_a_catalog_arm() {
    let (footprint, ports) = port_catalog(machine_kind::LABEL);
    assert_eq!(footprint, LABEL_PLACED_FOOTPRINT, "the catalog reads the one shared box");
    assert_eq!(footprint, Footprint { w: 4, h: 1, rot: 0 }, "4 by 1 at rot 0");
    assert!(ports.is_empty(), "a label has no ports: it does not connect (D-07)");
}

/// A fresh session holding one label at (10,12), returning `(session, label_id)`.
fn board_with_a_label() -> (GridSession, NodeId) {
    let mut session = GridSession::new(SEED);
    let id = place(&mut session, machine_kind::LABEL, 10, 12);
    (session, id)
}

/// The board's serialized grid, so "a refusal changed nothing" is a byte comparison.
fn grid_bytes(session: &GridSession) -> Vec<u8> {
    postcard::to_allocvec(&session.core().state).expect("serialize GridState")
}

#[test]
fn a_machine_cannot_be_placed_on_a_label() {
    // Every one of the label's four cells, with a 1x1 machine (a Source) and with a 3x3
    // machine (a Factory) whose box reaches a label cell from outside it.
    let (mut session, _) = board_with_a_label();
    let before = grid_bytes(&session);
    for x in 10..14 {
        assert_eq!(
            session.apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: x, cell_y: 12 }).err(),
            Some(CommandError::FootprintCollision),
            "a Source on label cell ({x},12) is FootprintCollision"
        );
    }
    // A Factory anchored at (8,10) covers (8..11, 10..13), so (10,12) is under its box.
    assert_eq!(
        session.apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 8, cell_y: 10 }).err(),
        Some(CommandError::FootprintCollision),
        "a Factory whose 3x3 box covers a label cell is FootprintCollision"
    );
    assert_eq!(grid_bytes(&session), before, "a refused Place changes nothing");
}

#[test]
fn a_label_cannot_be_placed_on_a_machine_or_a_label() {
    let mut session = GridSession::new(SEED);
    place(&mut session, machine_kind::SOURCE, 20, 5);
    place(&mut session, machine_kind::LABEL, 10, 12);
    let before = grid_bytes(&session);
    // On a machine: a label anchored at (17,5) covers (17..21, 5), reaching the Source.
    assert_eq!(
        session.apply(GridCommand::Place { kind: machine_kind::LABEL, cell_x: 17, cell_y: 5 }).err(),
        Some(CommandError::FootprintCollision),
        "a label over a machine cell is FootprintCollision"
    );
    // On a label, overlapping from either side and exactly on top: labels never overlap.
    for x in [7, 10, 13] {
        assert_eq!(
            session.apply(GridCommand::Place { kind: machine_kind::LABEL, cell_x: x, cell_y: 12 }).err(),
            Some(CommandError::FootprintCollision),
            "a label anchored at ({x},12) overlaps the label at (10,12)"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused Place changes nothing");
    // And the cell just past its box is free: (14,12) takes a second label.
    place(&mut session, machine_kind::LABEL, 14, 12);
}

/// MEASURED, not guessed: the shipped `DrawBelt` collision path treats every node's cells
/// alike, and a run whose tiles cross a label cell is refused with the same
/// `FootprintCollision` a run across a machine gets (`Err(FootprintCollision)` was the
/// measured answer on the tracer commit, before this leg pinned it). The shipped belt tool
/// never SENDS such a run (its corridor turns red over an occupied cell and release sends
/// nothing); this is the host's answer to a forged one.
#[test]
fn a_belt_cannot_be_drawn_through_a_label() {
    let (mut session, _) = board_with_a_label();
    let before = grid_bytes(&session);
    // Through the label's middle, along its row.
    assert_eq!(
        session
            .apply(GridCommand::DrawBelt { cells: vec![(8, 12), (9, 12), (10, 12), (11, 12)] })
            .err(),
        Some(CommandError::FootprintCollision),
        "a belt run into a label cell is refused"
    );
    // Across it, top to bottom through one cell.
    assert_eq!(
        session
            .apply(GridCommand::DrawBelt { cells: vec![(12, 10), (12, 11), (12, 12), (12, 13)] })
            .err(),
        Some(CommandError::FootprintCollision),
        "a belt run across a label cell is refused"
    );
    assert_eq!(grid_bytes(&session), before, "a refused DrawBelt changes nothing");
    // And a run BESIDE it, one row up, is accepted: the label holds its cells, not its row.
    session
        .apply(GridCommand::DrawBelt { cells: vec![(9, 11), (10, 11), (11, 11), (12, 11), (13, 11)] })
        .expect("a belt beside a label is accepted");
}

/// D-04, research Pitfall 6: R does nothing on a label. The UI sends no Rotate for one; a
/// forged Rotate is refused `WrongKind` (`Malformed` until plan 88-02) at the top of the Rotate arm, before any geometry,
/// because the anchor-preserving pivot would otherwise turn a free 4x1 into a 1x4 whose
/// words (which ignore `rot`) would draw wrong. Both turn directions are probed.
#[test]
fn a_label_does_not_turn() {
    let (mut session, id) = board_with_a_label();
    let handle = session.view().handle_of(id).expect("the label has a handle");
    let before = grid_bytes(&session);
    for ccw in [false, true] {
        assert_eq!(
            session.apply(GridCommand::Rotate { node: handle, ccw }).err(),
            Some(CommandError::WrongKind),
            "a Rotate naming a label is WrongKind (ccw {ccw})"
        );
    }
    assert_eq!(
        session.core().state.footprint_of(id),
        Some(Footprint { w: 4, h: 1, rot: 0 }),
        "the label's box is still 4x1 at rot 0"
    );
    assert_eq!(grid_bytes(&session), before, "a refused Rotate changes nothing");
}

// ── plan 76-02: ONE Configure carries text, colour, width and depth (D-02, D-04) ───────
//
// The label's words, its colour and its box ride ONE `GridCommand::Configure` carrying a
// `MachineConfig::Label { text, colour, w, h }`, so one Apply is one edit record and one
// undo step. Width and depth land in the existing `footprints` map through the shipped
// port-geometry writer, anchored at the label's top-left cell: a label grows right and
// down. The write gate refuses, in order: a Label config aimed at a non-label
// (`WrongKind`), text over `MAX_LABEL_BYTES` (`OverLimit`), a size outside 1 to
// `LABEL_MAX_W` by 1 to `LABEL_MAX_H` (`OverLimit`), any new cell past the grid edge
// (`OutOfBounds`), any new cell another node holds (`ResizeCovers`). A colour byte above
// 5 has no `LabelColour` and is `UnknownOption` at the wire conversion. (Each of the three
// tags was `Malformed` until plan 88-02 split it, D-11.)
//
// RED AT THE START REVISION, recorded in 76-02-SUMMARY.md: none of
// `MachineConfig::Label`, `ResizeCovers`, `LABEL_MAX_W` or `LABEL_MAX_H` exists, so the
// whole target fails to compile.

use fabrico_command::{LABEL_MAX_H, LABEL_MAX_W};
use fabrico_core::edit::{EditOp, MAX_LABEL_BYTES, MachineConfig as CoreConfig};
use fabrico_core::state::{GRID_MAX, GridState};
use fabrico_protocol::MachineConfig;

/// The dense render handle for a live node.
fn handle_of(session: &GridSession, id: NodeId) -> u64 {
    session.view().handle_of(id).expect("a live node has a handle")
}

/// One label Configure on the wire.
fn label_config(text: &str, colour: u8, w: u16, h: u16) -> MachineConfig {
    MachineConfig::Label { text: text.to_owned(), colour, w, h }
}

/// Apply one label Configure to `id` and hand back the session's verdict.
fn configure(
    session: &mut GridSession,
    id: NodeId,
    config: MachineConfig,
) -> Result<(), CommandError> {
    let node = handle_of(session, id);
    session.apply(GridCommand::Configure { node, config }).map(|_| ())
}

/// The label's committed text and colour, read off the node.
fn words_of(session: &GridSession, id: NodeId) -> (String, LabelColour) {
    match session.core().state.node(id) {
        Some(Node::Label(label)) => (label.text.clone(), label.colour),
        other => panic!("expected a live Node::Label, got {other:?}"),
    }
}

/// The label's box, absent footprint meaning the 1x1 rot-0 default.
fn box_of(session: &GridSession, id: NodeId) -> Footprint {
    session
        .core()
        .state
        .footprint_of(id)
        .unwrap_or(Footprint { w: 1, h: 1, rot: 0 })
}

/// The live occupancy index equals what `rebuild_occupancy` reconstructs from the
/// serialized cells and footprints, over a window wide enough to hold every node these
/// legs place. A resize that freed or claimed the wrong cells shows here even when the
/// footprint entry is right.
fn assert_occupancy_rebuilds(session: &GridSession, why: &str) {
    let live: &GridState = &session.core().state;
    let mut rebuilt = live.clone();
    rebuilt.rebuild_occupancy();
    for x in -2..40 {
        for y in -2..30 {
            assert_eq!(
                live.occupied((x, y)),
                rebuilt.occupied((x, y)),
                "{why}: the live occupancy at ({x},{y}) differs from what rebuild_occupancy \
                 reconstructs"
            );
        }
    }
}

#[test]
fn configure_writes_text_colour_and_size_in_one_record() {
    let (mut session, id) = board_with_a_label();
    let log_before = session.edit_log().len();
    configure(&mut session, id, label_config("Order intake", 3, 6, 2))
        .expect("one label Configure is accepted");

    assert_eq!(
        session.edit_log().len(),
        log_before + 1,
        "one Configure appends exactly ONE edit record (one Apply, one undo step)"
    );
    match &session.edit_log().last().expect("a record was appended").op {
        EditOp::Configure { node, config, .. } => {
            assert_eq!(*node, id, "the record names the label");
            assert_eq!(
                *config,
                CoreConfig::Label {
                    text: "Order intake".to_owned(),
                    colour: LabelColour::Lilac,
                    w: 6,
                    h: 2,
                },
                "the record carries text, colour (byte 3 is Lilac) and size together"
            );
        }
        other => panic!("expected an EditOp::Configure, got {other:?}"),
    }
    assert_eq!(
        words_of(&session, id),
        ("Order intake".to_owned(), LabelColour::Lilac),
        "the fold wrote the words and the colour onto the node"
    );
    assert_eq!(
        session.core().state.footprint_of(id),
        Some(Footprint { w: 6, h: 2, rot: 0 }),
        "the fold wrote the 6 by 2 box into footprints, rot 0"
    );
    assert_eq!(session.core().state.cell_of(id), Some((10, 12)), "the anchor never moves");
    for x in 10..16 {
        for y in 12..14 {
            assert_eq!(
                session.core().state.occupied((x, y)),
                Some(id),
                "the grown label owns ({x},{y})"
            );
        }
    }
    assert_eq!(session.core().state.occupied((16, 12)), None, "and nothing past its box");
    assert!(session.core().state.ports_of(id).is_none(), "a resized label still has no ports");
    assert_occupancy_rebuilds(&session, "after one label Configure");

    // Applying the same size again is not a collision with ITSELF: the grow walk excludes
    // the label's own cells.
    configure(&mut session, id, label_config("Order intake", 3, 6, 2))
        .expect("re-applying the committed size is accepted");
}

#[test]
fn configure_refuses_growth_over_a_neighbour_with_resize_covers() {
    let (mut session, id) = board_with_a_label();
    // A machine one column past the label's right edge, and a label two rows below it.
    place(&mut session, machine_kind::SOURCE, 15, 12);
    place(&mut session, machine_kind::LABEL, 10, 14);
    let before = grid_bytes(&session);
    let log_before = session.edit_log().len();

    // Width 5 reaches (14,12): free. Width 6 reaches (15,12): the Source.
    assert_eq!(
        configure(&mut session, id, label_config("x", 0, 6, 1)).err(),
        Some(CommandError::ResizeCovers),
        "growing right over a machine is ResizeCovers"
    );
    // Depth 3 reaches row 14: the other label.
    assert_eq!(
        configure(&mut session, id, label_config("x", 0, 4, 3)).err(),
        Some(CommandError::ResizeCovers),
        "growing down over another label is ResizeCovers"
    );
    assert_eq!(grid_bytes(&session), before, "a refused resize changes nothing");
    assert_eq!(session.edit_log().len(), log_before, "and appends no record");

    // The growth that fits is accepted: 5 wide by 2 deep touches neither neighbour.
    configure(&mut session, id, label_config("x", 0, 5, 2)).expect("growth into free cells");
    assert_eq!(box_of(&session, id), Footprint { w: 5, h: 2, rot: 0 });
}

#[test]
fn configure_refuses_growth_past_the_grid_edge_with_out_of_bounds() {
    let mut session = GridSession::new(SEED);
    // A label whose 4 by 1 box ends exactly on the last column, on the last row.
    let id = place(&mut session, machine_kind::LABEL, GRID_MAX - 3, GRID_MAX);
    let before = grid_bytes(&session);
    assert_eq!(
        configure(&mut session, id, label_config("edge", 0, 5, 1)).err(),
        Some(CommandError::OutOfBounds),
        "one column past the grid edge is OutOfBounds"
    );
    assert_eq!(
        configure(&mut session, id, label_config("edge", 0, 4, 2)).err(),
        Some(CommandError::OutOfBounds),
        "one row past the grid edge is OutOfBounds"
    );
    assert_eq!(grid_bytes(&session), before, "a refused resize changes nothing");
    configure(&mut session, id, label_config("edge", 0, 4, 1))
        .expect("the same box with new words is accepted on the edge");
}

#[test]
fn configure_text_at_the_cap_is_accepted_and_one_byte_over_is_refused() {
    let (mut session, id) = board_with_a_label();
    let at_cap = "a".repeat(MAX_LABEL_BYTES);
    configure(&mut session, id, label_config(&at_cap, 0, 4, 1))
        .expect("exactly MAX_LABEL_BYTES bytes is accepted");
    assert_eq!(words_of(&session, id).0, at_cap);

    // The bound is in BYTES: 256 two-byte characters is exactly the cap.
    let multibyte_at_cap = "\u{e9}".repeat(MAX_LABEL_BYTES / 2);
    assert_eq!(multibyte_at_cap.len(), MAX_LABEL_BYTES);
    configure(&mut session, id, label_config(&multibyte_at_cap, 0, 4, 1))
        .expect("a multibyte text of exactly MAX_LABEL_BYTES bytes is accepted");

    let before = grid_bytes(&session);
    let over = "a".repeat(MAX_LABEL_BYTES + 1);
    assert_eq!(
        configure(&mut session, id, label_config(&over, 0, 4, 1)).err(),
        Some(CommandError::OverLimit),
        "one byte over MAX_LABEL_BYTES is OverLimit"
    );
    // One byte over, reached by a multibyte character: 255 two-byte characters plus a
    // three-byte one is 513 bytes in 256 characters.
    let multibyte_over = format!("{}\u{6ce8}", "\u{e9}".repeat(MAX_LABEL_BYTES / 2 - 1));
    assert_eq!(multibyte_over.len(), MAX_LABEL_BYTES + 1);
    assert_eq!(
        configure(&mut session, id, label_config(&multibyte_over, 0, 4, 1)).err(),
        Some(CommandError::OverLimit),
        "a multibyte text one byte over the cap is OverLimit"
    );
    assert_eq!(grid_bytes(&session), before, "a refused text changes nothing");
}

#[test]
fn configure_refuses_a_colour_byte_above_5() {
    let (mut session, id) = board_with_a_label();
    let before = grid_bytes(&session);
    for colour in [6u8, 7, 200, 255] {
        assert_eq!(
            configure(&mut session, id, label_config("x", colour, 4, 1)).err(),
            Some(CommandError::UnknownOption),
            "colour byte {colour} names no LabelColour: UnknownOption, never a silent default"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused colour changes nothing");
    // And every byte of the closed set lands as its own colour.
    for (byte, colour) in [
        (0u8, LabelColour::Sand),
        (1, LabelColour::Stone),
        (2, LabelColour::Moss),
        (3, LabelColour::Lilac),
        (4, LabelColour::Rose),
        (5, LabelColour::Clay),
    ] {
        configure(&mut session, id, label_config("x", byte, 4, 1))
            .unwrap_or_else(|e| panic!("colour byte {byte} is accepted, got {e:?}"));
        assert_eq!(words_of(&session, id).1, colour, "byte {byte} is {colour:?}");
    }
}

#[test]
fn configure_refuses_size_outside_the_caps() {
    let (mut session, id) = board_with_a_label();
    let before = grid_bytes(&session);
    for (w, h) in [
        (0u16, 1u16),
        (1, 0),
        (0, 0),
        (LABEL_MAX_W + 1, 1),
        (1, LABEL_MAX_H + 1),
        (u16::MAX, u16::MAX),
    ] {
        assert_eq!(
            configure(&mut session, id, label_config("x", 0, w, h)).err(),
            Some(CommandError::OverLimit),
            "a {w} by {h} label is outside 1..={LABEL_MAX_W} by 1..={LABEL_MAX_H}: OverLimit"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused size changes nothing");
    configure(&mut session, id, label_config("x", 0, LABEL_MAX_W, LABEL_MAX_H))
        .expect("exactly the caps are accepted on free floor");
    assert_eq!(box_of(&session, id), Footprint { w: LABEL_MAX_W, h: LABEL_MAX_H, rot: 0 });
    configure(&mut session, id, label_config("x", 0, 1, 1)).expect("1 by 1 is the floor");
    assert_eq!(box_of(&session, id), Footprint { w: 1, h: 1, rot: 0 });
    assert_occupancy_rebuilds(&session, "after the cap and the floor");
}

#[test]
fn a_label_config_on_a_non_label_is_wrong_kind() {
    let mut session = GridSession::new(SEED);
    let source = place(&mut session, machine_kind::SOURCE, 2, 2);
    let factory = place(&mut session, machine_kind::FACTORY, 6, 2);
    let before = grid_bytes(&session);
    let log_before = session.edit_log().len();
    for id in [source, factory] {
        assert_eq!(
            configure(&mut session, id, label_config("x", 0, 4, 1)).err(),
            Some(CommandError::WrongKind),
            "a Label config aimed at a non-label is refused, never accepted as a fold no-op"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused Configure changes nothing");
    assert_eq!(session.edit_log().len(), log_before, "and appends no record");
}

#[test]
fn shrinking_frees_the_cells() {
    let (mut session, id) = board_with_a_label();
    configure(&mut session, id, label_config("big", 0, 6, 2)).expect("grow to 6 by 2");
    configure(&mut session, id, label_config("small", 0, 2, 1)).expect("shrink to 2 by 1");
    assert_eq!(box_of(&session, id), Footprint { w: 2, h: 1, rot: 0 });
    for (x, y) in [(10, 12), (11, 12)] {
        assert_eq!(session.core().state.occupied((x, y)), Some(id), "({x},{y}) is still held");
    }
    for x in 12..16 {
        assert_eq!(session.core().state.occupied((x, 12)), None, "({x},12) was freed");
    }
    for x in 10..16 {
        assert_eq!(session.core().state.occupied((x, 13)), None, "({x},13) was freed");
    }
    assert_occupancy_rebuilds(&session, "after a shrink");
    // A freed cell takes a machine.
    place(&mut session, machine_kind::SOURCE, 12, 12);
    // And 1 by 1 removes the footprint entry entirely (absent means 1x1 rot 0).
    configure(&mut session, id, label_config("tiny", 0, 1, 1)).expect("shrink to 1 by 1");
    assert_eq!(session.core().state.footprint_of(id), None, "a 1x1 label keeps no entry");
    assert_occupancy_rebuilds(&session, "after a shrink to 1 by 1");
}

// ── plan 76-02 task 2: ONE Apply is ONE undo step, before and after a save (D-04) ─────
//
// A label Configure is undone through the shipped Configure inverse: `prior_config_of`
// reads the label's text, colour and box (absent footprint means 1x1) off the core before
// the record folds, and the inverse is one `Configure` carrying them. The capture is
// NON-serialized and re-derived from the edit log on reconstruct, so the same undo works
// after `GridSession::replay` of a saved log.
//
// RED BEFORE THE CAPTURE (recorded in 76-02-SUMMARY.md): with `prior_config_of`'s Label arm
// answering `None` and no seventh pair in `config_variant_matches_live_kind`, the capture
// miss is routed to "skip": `Undo` returns Ok and restores nothing.

use fabrico_core::edit::EditRecord;

/// The full observable state of one label: words, colour and box.
fn label_state(session: &GridSession, id: NodeId) -> (String, LabelColour, Footprint) {
    let (text, colour) = words_of(session, id);
    (text, colour, box_of(session, id))
}

/// Serialize the edit log exactly as a saved project carries it, decode it back and re-fold
/// from genesis: the genuine save-load path (the `configure.rs` shape).
fn save_and_load(session: &GridSession) -> GridSession {
    let bytes = postcard::to_allocvec(&session.edit_log().to_vec()).expect("edit-log encodes");
    let records: Vec<EditRecord> = postcard::from_bytes(&bytes).expect("edit-log decodes");
    GridSession::replay(SEED, &records)
}

/// The one label on a session's board.
fn the_label(session: &GridSession) -> NodeId {
    session
        .core()
        .state
        .node_ids()
        .find(|id| matches!(session.core().state.node(*id), Some(Node::Label(_))))
        .expect("the board holds a label")
}

/// Two Applies on one label, each changing text, colour AND size, so an undo that restored
/// only one of the three would show.
fn two_applies() -> (GridSession, NodeId) {
    let (mut session, id) = board_with_a_label();
    configure(&mut session, id, label_config("Order intake", 3, 6, 2)).expect("first Apply");
    configure(&mut session, id, label_config("Dispatch", 5, 3, 1)).expect("second Apply");
    assert_eq!(
        label_state(&session, id),
        ("Dispatch".to_owned(), LabelColour::Clay, Footprint { w: 3, h: 1, rot: 0 }),
        "the second Apply landed"
    );
    (session, id)
}

#[test]
fn one_apply_is_one_undo_step() {
    let (mut session, id) = two_applies();
    session.apply(GridCommand::Undo).expect("one Undo");
    assert_eq!(
        label_state(&session, id),
        ("Order intake".to_owned(), LabelColour::Lilac, Footprint { w: 6, h: 2, rot: 0 }),
        "ONE Undo restores the previous words, colour and size together"
    );
    assert_occupancy_rebuilds(&session, "after undoing a resize");
    for x in 10..16 {
        assert_eq!(session.core().state.occupied((x, 13)), Some(id), "the 6 by 2 box is back at ({x},13)");
    }
    session.apply(GridCommand::Undo).expect("a second Undo");
    assert_eq!(
        label_state(&session, id),
        (String::new(), LabelColour::Sand, Footprint { w: 4, h: 1, rot: 0 }),
        "a second Undo returns the label to how it was placed"
    );
    assert_occupancy_rebuilds(&session, "after undoing back to the placed box");
    session.apply(GridCommand::Redo).expect("Redo");
    assert_eq!(
        label_state(&session, id),
        ("Order intake".to_owned(), LabelColour::Lilac, Footprint { w: 6, h: 2, rot: 0 }),
        "Redo puts the first Apply back"
    );
}

#[test]
fn one_apply_is_one_undo_step_after_a_replay() {
    let (session, _) = two_applies();
    let mut reloaded = save_and_load(&session);
    let id = the_label(&reloaded);
    assert_eq!(
        label_state(&reloaded, id),
        ("Dispatch".to_owned(), LabelColour::Clay, Footprint { w: 3, h: 1, rot: 0 }),
        "the reloaded board folded to the second Apply"
    );
    assert!(reloaded.can_undo(), "the reloaded session can undo");
    reloaded.apply(GridCommand::Undo).expect("one Undo after the reload");
    assert_eq!(
        label_state(&reloaded, id),
        ("Order intake".to_owned(), LabelColour::Lilac, Footprint { w: 6, h: 2, rot: 0 }),
        "ONE Undo after a save and reload restores words, colour and size: the capture is \
         re-derived from the log, not held in memory"
    );
    assert_occupancy_rebuilds(&reloaded, "after an undo on a reloaded board");
}

/// THE SEVENTH PAIR, and why it is a separate leg from the two above (plan 76-02).
///
/// `config_variant_matches_live_kind` is consulted only on a capture MISS: it decides
/// whether a missing prior config is a misaligned projection (REFUSE) or a wrong-kind fold
/// no-op with nothing to invert (SKIP). With the Label arm of `prior_config_of` present the
/// two legs above never miss, so they cannot see the pair; this leg forges the one miss
/// that can occur (the `configure.rs` belt shape): the label's `Place` and its `Configure`
/// re-stamped into ONE tick and ONE action, so the capture reads the pre-slice core, finds
/// no label, and misses, while by undo time the label is live and IS a label.
///
/// MUTATION (2026-10-07, throwaway worktree, reverted): with the seventh pair removed alone,
/// the two legs above stay GREEN (measured: the capture no longer misses there) and THIS
/// leg reddens: the miss is routed to "skip", and `Undo` returns Ok, undoes the `Place` and
/// silently drops the config restore.
#[test]
fn a_label_capture_miss_on_a_live_label_is_refused() {
    let (mut donor, id) = board_with_a_label();
    configure(&mut donor, id, label_config("Order intake", 3, 6, 2)).expect("Configure accepted");
    let forged: Vec<EditRecord> = donor
        .edit_log()
        .iter()
        .enumerate()
        .map(|(i, r)| EditRecord { sequence: i as u64, tick: 0, action: 1, ..r.clone() })
        .collect();
    let mut session = GridSession::replay(SEED, &forged);
    let live = the_label(&session);
    assert_eq!(
        label_state(&session, live),
        ("Order intake".to_owned(), LabelColour::Lilac, Footprint { w: 6, h: 2, rot: 0 }),
        "the forged log folded the label's config"
    );
    let before = grid_bytes(&session);
    assert_eq!(
        session.apply(GridCommand::Undo).err(),
        Some(CommandError::UndoDoesNotFit),
        "a capture miss against a LIVE label is a typed refusal, never a silent skip"
    );
    assert_eq!(grid_bytes(&session), before, "the refused undo mutated nothing");
}

// ── plan 76-04: A LABEL NEVER CONNECTS (SHAPE-14, D-07) ─────────────────────────────────
//
// Five shapes a forged client can send to join a label to the flow, each refused by name
// as `LabelDoesNotConnect` with the board unchanged. The UI offers none of them (a label
// has no nub for the Wire or Belt tool to start from), so these are the host's answers to
// forged input, and the check is the first one after the handles resolve in each arm.
//
// MEASURED AT THE START REVISION (tree equal to the gated revision), a scratch
// test in a throwaway detached worktree, before any arm changed (verbatim):
//   MEASURE spatial Dock Head port 0: result=Err(InvalidDock) label_ports=None links=0
//   MEASURE fault-port Dock Tail: result=Ok(()) label_ports=None links=1
//   MEASURE DrawWire from label: result=Err(IncompatiblePorts) label_ports=None links=0
//   MEASURE DrawWire to label: result=Err(IncompatiblePorts) label_ports=None links=0
//   MEASURE AddPort on label: result=Ok(()) label_ports=Some(1) links=0
// So the fault-port Dock linked a belt to a note (WINDOWS 68: that branch skips all
// geometry) and AddPort grew the label a port; the other three were refused with
// sentences about ports a label does not have.
//
// MUTATION (2026-10-07, throwaway worktree, reverted): with the Dock arm's label check
// removed alone, `a_belt_cannot_dock_to_a_labels_fault_port` reddens with `left: None,
// right: Some(LabelDoesNotConnect)` (the fault-port Dock ACCEPTED again) and
// `a_belt_cannot_dock_to_a_label` with `left: Some(InvalidDock)`; the other 21 legs stay
// green.

use fabrico_core::fault::FAULT_PORT;
use fabrico_core::state::Medium;
use fabrico_protocol::{BeltEnd, port_role};

/// Draw a belt along `cells` and return its render handle.
fn drawn_belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> u64 {
    session
        .apply(GridCommand::DrawBelt { cells })
        .expect("a clear drawn path is accepted");
    let id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("DrawBelt minted the belt this tick");
    handle_of(session, id)
}

/// An electrical preset Router at `(x, y)` (In at index 0, Outs from index 1), returning
/// its render handle: the one command-layer route to an Electrical port a wire can use.
fn electrical_router(session: &mut GridSession, x: i32, y: i32) -> u64 {
    session
        .place_router_preset(Medium::Electrical, x, y)
        .expect("an electrical router preset places on a free cell");
    let id = session.core().state.occupied((x, y)).expect("the router holds its anchor");
    handle_of(session, id)
}

/// The label has gained no port and no link touches it.
fn assert_label_unconnected(session: &GridSession, id: NodeId) {
    assert!(session.core().state.ports_of(id).is_none(), "the label still has no ports entry");
    assert!(
        session.core().state.links_iter().all(|(from, to)| from.0 != id && to.0 != id),
        "no link touches the label"
    );
}

/// A belt whose Head sits on the tile right beside the label's west edge, and a second
/// belt whose Tail sits right beside its east edge, each docked by catalog index 0 in the
/// direction that end would dock to a machine. Measured `InvalidDock` before D-07; that
/// sentence talks about an output and an input the label does not have.
#[test]
fn a_belt_cannot_dock_to_a_label() {
    let (mut session, id) = board_with_a_label();
    let label = handle_of(&session, id);
    let into = drawn_belt(&mut session, vec![(6, 12), (7, 12), (8, 12), (9, 12)]);
    let out_of = drawn_belt(&mut session, vec![(14, 12), (15, 12), (16, 12)]);
    let before = grid_bytes(&session);
    for (belt, endpoint) in [(into, BeltEnd::Head), (out_of, BeltEnd::Tail)] {
        for port in [0, 1] {
            assert_eq!(
                session.apply(GridCommand::Dock { belt, endpoint, node: label, port }).err(),
                Some(CommandError::LabelDoesNotConnect),
                "a spatial Dock ({endpoint:?}, port {port}) naming a label is LabelDoesNotConnect"
            );
        }
    }
    assert_eq!(grid_bytes(&session), before, "a refused Dock changes nothing");
    assert_label_unconnected(&session, id);
}

/// THE ONE THAT WAS ACCEPTED. `port: FAULT_PORT` on a node with no fault nub takes the
/// non-spatial branch, which checks no geometry at all, so before D-07 a belt anywhere on
/// the board linked to the label (measured `Ok(())`, `links=1`). Both ends are probed:
/// the Head would have been `InvalidDock` there, the Tail was accepted.
#[test]
fn a_belt_cannot_dock_to_a_labels_fault_port() {
    let (mut session, id) = board_with_a_label();
    let label = handle_of(&session, id);
    let belt = drawn_belt(&mut session, vec![(20, 20), (21, 20), (22, 20)]);
    let before = grid_bytes(&session);
    for endpoint in [BeltEnd::Tail, BeltEnd::Head] {
        assert_eq!(
            session
                .apply(GridCommand::Dock { belt, endpoint, node: label, port: FAULT_PORT })
                .err(),
            Some(CommandError::LabelDoesNotConnect),
            "a FAULT_PORT Dock ({endpoint:?}) naming a label is LabelDoesNotConnect"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused fault-port Dock changes nothing");
    assert_label_unconnected(&session, id);
}

/// A wire whose FROM end names the label, aimed at a real electrical In. Measured
/// `IncompatiblePorts` before D-07, whose sentence is about two machines' ports.
#[test]
fn a_wire_cannot_start_at_a_label() {
    let (mut session, id) = board_with_a_label();
    let label = handle_of(&session, id);
    let router = electrical_router(&mut session, 30, 30);
    let before = grid_bytes(&session);
    for from_port in [0, 1, FAULT_PORT] {
        assert_eq!(
            session
                .apply(GridCommand::DrawWire { from_node: label, from_port, to_node: router, to_port: 0 })
                .err(),
            Some(CommandError::LabelDoesNotConnect),
            "a DrawWire from a label (port {from_port}) is LabelDoesNotConnect"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused DrawWire changes nothing");
    assert_label_unconnected(&session, id);
}

/// A wire whose TO end names the label, from a real electrical Out.
#[test]
fn a_wire_cannot_end_at_a_label() {
    let (mut session, id) = board_with_a_label();
    let label = handle_of(&session, id);
    let router = electrical_router(&mut session, 30, 30);
    let before = grid_bytes(&session);
    for to_port in [0, 1, FAULT_PORT] {
        assert_eq!(
            session
                .apply(GridCommand::DrawWire { from_node: router, from_port: 1, to_node: label, to_port })
                .err(),
            Some(CommandError::LabelDoesNotConnect),
            "a DrawWire to a label (port {to_port}) is LabelDoesNotConnect"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused DrawWire changes nothing");
    assert_label_unconnected(&session, id);
}

/// THE OTHER ONE THAT WAS ACCEPTED. `AddPort` had no kind check, so before D-07 a label
/// gained a port (measured `Ok(())`, `label_ports=Some(1)`). Every role and medium is
/// probed, and an unknown role byte too: the label check comes before the bytes are read.
#[test]
fn a_label_cannot_gain_a_port() {
    let (mut session, id) = board_with_a_label();
    let label = handle_of(&session, id);
    let before = grid_bytes(&session);
    for role in [port_role::IN, port_role::OUT, port_role::FAULT, 9] {
        for medium in [0, 1] {
            assert_eq!(
                session.apply(GridCommand::AddPort { node: label, role, side: 1, medium }).err(),
                Some(CommandError::LabelDoesNotConnect),
                "an AddPort (role {role}, medium {medium}) on a label is LabelDoesNotConnect"
            );
        }
    }
    assert_eq!(grid_bytes(&session), before, "a refused AddPort changes nothing");
    assert_label_unconnected(&session, id);
    assert_eq!(
        session.core().state.footprint_of(id),
        Some(Footprint { w: 4, h: 1, rot: 0 }),
        "the label's box did not grow"
    );
}

// ── plan 76-05: DELETE THEN UNDO BRINGS A LABEL BACK WHOLE (D-08, SHAPE-12) ─────────────
//
// A user who deletes a configured label and presses Ctrl+Z gets back the label they
// deleted: its words, its colour AND its size, before and after a save, and when the
// Configure and the Delete fold in one drain pass. The Delete inverse re-`Place`s the box
// from the record's `captured` w and h, so the size alone always came back; the words and
// the colour live on the node, which `DeletedSubgraph` does not carry.
//
// - `delete_then_undo_restores_text_colour_and_size`: a live session, with a Source the
//   log mints after the label, deletes the configured label and undoes it on the same
//   board. Until plan 85-09 its core also held one node minted outside the edit log (the
//   shipped demo's shape of the time), which put the re-fold one allocator slot behind
//   and made the live capture the only one able to restore the words. Every shipped
//   scene is log-only since plan 85-08 and that mint was removed (D-02); the leg now
//   proves the live-board restore on a board the log alone built.
// - `delete_then_undo_restores_text_colour_and_size_after_a_replay`: the same undo on a
//   session rebuilt by `GridSession::replay` from the saved log (the capture re-derived
//   from the log, never held in memory).
// - `configure_then_delete_in_one_slice_restores_the_configured_words`: the Configure and
//   the Delete stamped on one tick and folded in ONE `fold_live` (the
//   `same_tick_port_edits.rs` shape, research Pitfall 8). The Delete's capture must see the
//   core the Delete folds against, not the pre-batch one.
// - `undo_of_a_label_delete_is_one_step`: one Undo appends one action holding the re-Place
//   and the re-Configure, and leaves the label whole; the next Undo reaches the Apply
//   before the Delete.
//
// RED AT THE START REVISION (tree equal to the gated revision), before the
// capture landed, verbatim: the first three legs each
//   assertion `left == right` failed: ...: words, colour and size
//     left: ("", Sand, Footprint { w: 6, h: 2, rot: 0 })
//    right: ("Order intake", Lilac, Footprint { w: 6, h: 2, rot: 0 })
// and the fourth `the undo carries exactly one Configure{Label}, got []`. So the box came
// back at 6 by 2 with no words and the default colour, the research D-08 probe's shape
// for a Factory's JS and a Route's path, measured here for a label.
//
// MUTATIONS (2026-10-07, one throwaway detached worktree, removed and pruned):
// - the `Delete` arm of `capture_slice` removed: all four legs red, the first three with
//   `left: ("", Sand, Footprint { w: 6, h: 2, rot: 0 })` and the fourth `got []`.
// - `EditOp::Delete` removed from `captured_edit_node`: ONLY the same-slice leg reddens,
//   at its replay-equals-live check. The live group re-Configures `Label { text: "",
//   colour: Sand, w: 4, h: 1 }` (the pre-Configure words and box, read off the pre-batch
//   core) where the replayed session's group carries `Order intake`, Lilac, 6 by 2. The
//   re-fold folds each action as its own slice, so only the live drain pass was wrong.
// - the live twin dropped for label captures (`capture_before_fold` skipping a
//   `MachineConfig::Label` entry): only `delete_then_undo_restores_text_colour_and_size`
//   reddened, `left: ("", Sand, ...)`, while its core held the node minted outside the
//   log. Without that node (plan 85-09) the re-fold capture is aligned and restores the
//   words on its own, so this mutation is no longer visible to any leg here; the live
//   twin stays in `reconstruct_projection` as the backstop for a core built by hand.

use fabrico_core::edit::EDIT_SCHEMA_VERSION;

/// The configured label every delete-undo leg deletes: `Order intake`, Lilac, 6 by 2.
fn order_intake() -> MachineConfig {
    label_config("Order intake", 3, 6, 2)
}

/// What `order_intake` reads as on the node.
fn order_intake_state() -> (String, LabelColour, Footprint) {
    ("Order intake".to_owned(), LabelColour::Lilac, Footprint { w: 6, h: 2, rot: 0 })
}

/// The label anchored at `cell`, if one stands there.
fn label_anchored_at(session: &GridSession, cell: (i32, i32)) -> Option<NodeId> {
    session.core().state.node_ids().find(|id| {
        matches!(session.core().state.node(*id), Some(Node::Label(_)))
            && session.core().state.cell_of(*id) == Some(cell)
    })
}

/// How many labels stand on the board.
fn label_count(session: &GridSession) -> usize {
    session
        .core()
        .state
        .node_ids()
        .filter(|id| matches!(session.core().state.node(*id), Some(Node::Label(_))))
        .count()
}

/// Delete `id` through the session, the keyboard Delete's command.
fn delete_label(session: &mut GridSession, id: NodeId) {
    let node = handle_of(session, id);
    session.apply(GridCommand::Delete { node }).expect("a label Delete is accepted");
}

/// The label at (10,12) is back, whole: words, colour, the 6 by 2 box at its anchor, and
/// every one of its 12 cells owned by it.
fn assert_back_whole(session: &GridSession, why: &str) {
    let id = label_anchored_at(session, (10, 12))
        .unwrap_or_else(|| panic!("{why}: no label stands at (10,12) after the undo"));
    assert_eq!(label_state(session, id), order_intake_state(), "{why}: words, colour and size");
    for x in 10..16 {
        for y in 12..14 {
            assert_eq!(session.core().state.occupied((x, y)), Some(id), "{why}: the label owns ({x},{y})");
        }
    }
    assert_occupancy_rebuilds(session, why);
}

#[test]
fn delete_then_undo_restores_text_colour_and_size() {
    let mut session = GridSession::new(SEED);
    let id = place(&mut session, machine_kind::LABEL, 10, 12);
    // A Source minted by the log AFTER the label: a bystander the undo must not touch.
    let source = place(&mut session, machine_kind::SOURCE, 10, 20);
    configure(&mut session, id, order_intake()).expect("configure the label");
    assert_eq!(label_state(&session, id), order_intake_state(), "the Apply landed");

    delete_label(&mut session, id);
    assert!(session.core().state.node(id).is_none(), "the label is gone");
    assert_eq!(label_count(&session), 0, "no label stands");

    session.apply(GridCommand::Undo).expect("one Undo");
    assert_back_whole(&session, "after Delete then Undo on a live board");
    assert!(
        matches!(session.core().state.node(source), Some(Node::Source(_))),
        "the Source is untouched"
    );
}

#[test]
fn delete_then_undo_restores_text_colour_and_size_after_a_replay() {
    let (mut donor, id) = board_with_a_label();
    configure(&mut donor, id, order_intake()).expect("configure the label");
    delete_label(&mut donor, id);
    let mut reloaded = save_and_load(&donor);
    assert_eq!(label_count(&reloaded), 0, "the reloaded board folded the Delete");
    assert!(reloaded.can_undo(), "the reloaded session can undo");
    reloaded.apply(GridCommand::Undo).expect("one Undo after the reload");
    assert_back_whole(&reloaded, "after a save, a reload, then Undo");
}

#[test]
fn configure_then_delete_in_one_slice_restores_the_configured_words() {
    let (mut live, id) = board_with_a_label();
    let h = handle_of(&live, id);
    // Resolve the two gestures one after another on a twin, the records one drain pass
    // would enqueue: the Configure, then the Delete of the box it just grew.
    let (mut twin, _) = board_with_a_label();
    let configure_op = twin
        .apply(GridCommand::Configure { node: h, config: order_intake() })
        .expect("the twin accepts the Configure")
        .op
        .clone();
    let delete_op =
        twin.apply(GridCommand::Delete { node: h }).expect("the twin accepts the Delete").op.clone();

    // Stamp both as their own actions on ONE tick, as `Host::tick_once` stamps a drain
    // pass, and fold them in ONE `fold_live`.
    let log = live.edit_log();
    let first_sequence = log.iter().map(|r| r.sequence).max().map_or(0, |m| m + 1);
    let first_action = log.iter().map(|r| r.action).max().map_or(0, |m| m + 1);
    let tick = live.core().tick;
    let batch: Vec<EditRecord> = (first_sequence..)
        .zip(first_action..)
        .zip([configure_op, delete_op])
        .map(|((sequence, action), op)| EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence,
            tick,
            action,
            op,
        })
        .collect();
    let _ = live.fold_live(&batch, &[]);
    assert_eq!(label_count(&live), 0, "the one-tick batch configured then deleted the label");

    // The undo the host would fold: resolved, stamped as its own action, folded live.
    let group: Vec<EditOp> =
        live.resolve_undo().expect("the Delete is undoable").into_iter().map(|r| r.op).collect();
    let replayed_group: Vec<EditOp> = GridSession::replay(SEED, live.edit_log())
        .resolve_undo()
        .expect("the replayed session can undo")
        .into_iter()
        .map(|r| r.op)
        .collect();
    assert_eq!(replayed_group, group, "a replayed session resolves the same undo (before and after a save)");
    let tick = live.core().tick;
    let action = live.edit_log().iter().map(|r| r.action).max().map_or(0, |m| m + 1);
    let sequence = live.edit_log().iter().map(|r| r.sequence).max().map_or(0, |m| m + 1);
    let undo: Vec<EditRecord> = group
        .into_iter()
        .zip(sequence..)
        .map(|(op, sequence)| EditRecord { schema_version: EDIT_SCHEMA_VERSION, partition: 0, sequence, tick, action, op })
        .collect();
    let _ = live.fold_live(&undo, &[]);
    assert_back_whole(&live, "after a same-slice Configure and Delete, then Undo");
}

#[test]
fn undo_of_a_label_delete_is_one_step() {
    let (mut session, id) = board_with_a_label();
    configure(&mut session, id, order_intake()).expect("configure the label");
    delete_label(&mut session, id);
    let before = session.edit_log().len();
    session.apply(GridCommand::Undo).expect("one Undo");
    let appended = &session.edit_log()[before..];
    let action = appended[0].action;
    assert!(
        appended.iter().all(|r| r.action == action),
        "one Undo appends ONE action: {appended:?}"
    );
    let places: Vec<&EditOp> =
        appended.iter().map(|r| &r.op).filter(|op| matches!(op, EditOp::Place { .. })).collect();
    let configures: Vec<&EditOp> =
        appended.iter().map(|r| &r.op).filter(|op| matches!(op, EditOp::Configure { .. })).collect();
    assert!(
        matches!(places.as_slice(), [EditOp::Place { kind: machine_kind::LABEL, cell_x: 10, cell_y: 12, w: 6, h: 2, .. }]),
        "the undo re-Places the 6 by 2 box at (10,12) once: {places:?}"
    );
    match configures.as_slice() {
        [EditOp::Configure { config: CoreConfig::Label { text, colour, w, h }, .. }] => {
            assert_eq!(
                (text.as_str(), *colour, *w, *h),
                ("Order intake", LabelColour::Lilac, 6, 2),
                "the undo re-Configures the words, colour and size the label carried"
            );
        }
        other => panic!("the undo carries exactly one Configure{{Label}}, got {other:?}"),
    }
    assert_back_whole(&session, "after ONE Undo of the Delete");
    // The next Undo reaches the Apply BEFORE the Delete: the label stays, back to how it
    // was placed. So the delete's undo did not leave a half of itself for a second press.
    session.apply(GridCommand::Undo).expect("a second Undo");
    let id = label_anchored_at(&session, (10, 12)).expect("the label still stands");
    assert_eq!(
        label_state(&session, id),
        (String::new(), LabelColour::Sand, Footprint { w: 4, h: 1, rot: 0 }),
        "the second Undo reverses the Apply, not a remainder of the Delete"
    );
}

// ---------------------------------------------------------------------------
// Plan 86-07 (D-09, WORK-11): an over-cap label can still be re-worded and recoloured
// ---------------------------------------------------------------------------
//
// The label panel's Apply always resends the label's current width and depth with the new
// words or colour. A board from a hand-edited file (or from a later build with a larger cap)
// can hold a label past the panel's 16 by 8, and until plan 86-07 the size cap refused every
// Apply on it, so its words could never change again. Now the cap applies to a dimension
// only when that dimension CHANGES; an unchanged one needs only the fold's envelope,
// `1..=MAX_FOOTPRINT_DIM`. A grow past the cap is still refused.
//
// The 17 by 9 label comes from a forged `Configure` record replayed with
// `GridSession::replay`, the path a loaded file takes.
//
// RED BEFORE THE CHANGE (plan 86-07 task 3, `cap-red.out`): the text-only, colour-only and
// narrow legs were refused `Malformed`; the three refusal legs were green, as they must be.

/// A replayed board whose one label is 17 by 9, words "Order intake", colour Stone.
fn over_cap_label() -> (GridSession, NodeId) {
    let (session, id) = board_with_a_label();
    let mut records = session.edit_log().to_vec();
    let last = records.last().cloned().expect("the label's Place is logged");
    records.push(EditRecord {
        schema_version: last.schema_version,
        partition: last.partition,
        sequence: last.sequence + 1,
        // The Place's own tick: `GridSession::replay` hands a render handle only to the
        // nodes minted in the last tick it folds, and the legs below address the label
        // by its handle, as the panel does.
        tick: last.tick,
        action: last.action + 1,
        op: EditOp::Configure {
            node: id,
            config: CoreConfig::Label {
                text: "Order intake".to_owned(),
                colour: LabelColour::Stone,
                w: 17,
                h: 9,
            },
            code_hash: [0u8; 32],
        },
    });
    let replayed = GridSession::replay(SEED, &records);
    let id = the_label(&replayed);
    assert_eq!(
        label_state(&replayed, id),
        ("Order intake".to_owned(), LabelColour::Stone, Footprint { w: 17, h: 9, rot: 0 }),
        "measured: the replayed label is 17 by 9, past the 16 by 8 panel cap"
    );
    (replayed, id)
}

#[test]
fn an_over_cap_label_accepts_a_text_only_configure() {
    let (mut session, id) = over_cap_label();
    let verdict = configure(&mut session, id, label_config("Dispatch", 1, 17, 9));
    assert_eq!(
        (verdict, label_state(&session, id)),
        (Ok(()), ("Dispatch".to_owned(), LabelColour::Stone, Footprint { w: 17, h: 9, rot: 0 })),
        "new words at the label's own 17 by 9 are accepted and the box stays"
    );
    assert_occupancy_rebuilds(&session, "after a text-only Apply on an over-cap label");
}

#[test]
fn an_over_cap_label_accepts_a_colour_only_configure() {
    let (mut session, id) = over_cap_label();
    let verdict = configure(&mut session, id, label_config("Order intake", 2, 17, 9));
    assert_eq!(
        (verdict, label_state(&session, id)),
        (Ok(()), ("Order intake".to_owned(), LabelColour::Moss, Footprint { w: 17, h: 9, rot: 0 })),
        "a new colour at the label's own 17 by 9 is accepted and the box stays"
    );
}

#[test]
fn an_over_cap_label_refuses_a_wider_box() {
    let (mut session, id) = over_cap_label();
    let before = grid_bytes(&session);
    assert_eq!(
        configure(&mut session, id, label_config("Order intake", 1, 18, 9)),
        Err(CommandError::OverLimit),
        "widening 17 to 18 is a change past the cap"
    );
    assert_eq!(grid_bytes(&session), before, "a refused size changes nothing");
}

#[test]
fn an_over_cap_label_refuses_a_deeper_box() {
    let (mut session, id) = over_cap_label();
    let before = grid_bytes(&session);
    assert_eq!(
        configure(&mut session, id, label_config("Order intake", 1, 17, 10)),
        Err(CommandError::OverLimit),
        "deepening 9 to 10 is a change past the cap"
    );
    assert_eq!(grid_bytes(&session), before, "a refused size changes nothing");
}

#[test]
fn an_over_cap_label_may_narrow_one_side() {
    let (mut session, id) = over_cap_label();
    let verdict = configure(&mut session, id, label_config("Order intake", 1, 16, 9));
    assert_eq!(
        (verdict, box_of(&session, id)),
        (Ok(()), Footprint { w: 16, h: 9, rot: 0 }),
        "narrowing to 16 (inside the cap) while keeping depth 9 is accepted"
    );
    assert_occupancy_rebuilds(&session, "after narrowing an over-cap label");
}

/// THE PER-SIDE READING, graded on the case it is least obvious for (phase 86 review, WR-04;
/// D-09 as amended). A 17 by 9 label shrinks to 17 by 5 (only the depth changes, to 5, inside
/// the cap), then deepens to 17 by 8: the depth grows but lands inside the cap, and the width
/// does not change, so both are accepted although the box stays past the 16 by 8 cap and the
/// second step grows its area. A side that changes must land inside the cap; a side that does
/// not change keeps only the envelope bound. This is the intended answer, not an oversight.
#[test]
fn an_over_cap_label_may_change_one_side_inside_the_cap_while_the_other_stays_past_it() {
    let (mut session, id) = over_cap_label();
    let shrink = configure(&mut session, id, label_config("Order intake", 1, 17, 5));
    let shrunk = box_of(&session, id);
    let deepen = configure(&mut session, id, label_config("Order intake", 1, 17, 8));
    assert_eq!(
        (shrink, shrunk, deepen, box_of(&session, id)),
        (Ok(()), Footprint { w: 17, h: 5, rot: 0 }, Ok(()), Footprint { w: 17, h: 8, rot: 0 }),
        "17 by 9 to 17 by 5 to 17 by 8: each changed side lands inside the cap, the unchanged width stays 17"
    );
    assert_occupancy_rebuilds(&session, "after changing one side of an over-cap label");
}

#[test]
fn a_label_still_cannot_grow_past_the_cap() {
    let (mut session, id) = board_with_a_label();
    let before = grid_bytes(&session);
    for (w, h) in [(LABEL_MAX_W + 1, 1), (4, LABEL_MAX_H + 1), (LABEL_MAX_W + 1, LABEL_MAX_H + 1)] {
        assert_eq!(
            configure(&mut session, id, label_config("x", 0, w, h)),
            Err(CommandError::OverLimit),
            "a 4 by 1 label grown to {w} by {h} is past the cap"
        );
    }
    assert_eq!(grid_bytes(&session), before, "a refused grow changes nothing");
}
