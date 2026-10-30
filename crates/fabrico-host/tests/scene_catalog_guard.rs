//! THE SCENE CATALOG GUARD (plan 85-09, D-23, DEMO-03, DEMO-04, phase 85 success
//! criterion 2): every node on every shipped scene is a catalog machine shaped only by
//! logged edits, and was minted by the scene's edit log.
//!
//! Until plan 85-08 the demo's HTTP handler was a 1x1 Factory minted straight onto the
//! core, a machine no palette could produce (walk-112, SWEEP Appendix C). Nothing caught
//! it, because no check compared a scene's machines with the catalog a user's machines
//! come from. This file is that check, and it is pure: it reads the scene's own command
//! list and the board `boot_scene` builds from it, the way every boot site builds it.
//!
//! # What "matches the catalog" means here
//! For every logged `Place { kind, cell_x, cell_y }` on a scene, a REFERENCE node is
//! rebuilt alone on a fresh `GridSession`: the same logged kind at the same anchor, then
//! only that node's later SHAPE edits, re-addressed to the fresh handle. The shape edits
//! are the ones a user makes: `Rotate`, `AddPort`, `RemovePort`, and a Label's
//! `Configure`, whose `w` and `h` are a resize. The reference and the booted node must
//! agree on `w`, `h`, `rot` and every port (offset, side, role, medium). A node that
//! differs from the catalog without a logged edit saying so is named, with its scene,
//! its handle, its kind and the field.
//!
//! The reference is keyed on the LOGGED kind, never on what the board reports a node to
//! be: an HTTP Handler folds to a Factory node, so a guard keyed on the board's kind
//! would compare a handler against the Factory catalog and either pass a wrong shape or
//! fail a right one (`85-CONTEXT.md` D-23).
//!
//! # What "minted by the log" means here
//! The booted host's own edit log is replayed into a fresh session at the scene's
//! genesis seed, and the two node id sets must be equal. A node minted any other way
//! (straight onto `core.state`) is missing from the replay and the set comparison names
//! it.
//!
//! # Why it cannot pass empty
//! The checked count must equal the scene's Place count, so a builder that skipped a
//! node, or a scene the loop forgot, fails the count rather than passing. The three
//! comparator legs feed it a footprint shrunk to 1x1, a dropped port and an added port,
//! and each must come back as a violation naming the scene, the handle and the field.
//! `SceneId::ALL` is iterated with an exhaustive `match` inside the loop, so a fourth
//! scene is a compile error here until it is handled.

use fabrico_command::GridSession;
use fabrico_core::core::Core;
use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{Footprint, Port};
use fabrico_engine::board::parse_board;
use fabrico_host::demo_scene::{SceneId, boot_scene};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};

/// A node's shape as the guard compares it: its footprint and its rot-0 ports in
/// catalog order.
type Shape = (Footprint, Vec<Port>);

/// The violations between a node's `expected` shape (its logged kind rebuilt from the
/// catalog plus its own logged shape edits) and the `actual` shape the booted board
/// holds. Each string names the scene, the handle, the kind and the differing field; an
/// empty list is a match.
fn catalog_violations(
    scene: &str,
    handle: u64,
    kind: u8,
    expected: Shape,
    actual: Shape,
) -> Vec<String> {
    let at = format!("{scene}: handle {handle} (kind {kind})");
    let mut out = Vec::new();
    let ((ef, eports), (af, aports)) = (expected, actual);
    if ef.w != af.w {
        out.push(format!(
            "{at}: field w is {} where the catalog and its logged edits give {}",
            af.w, ef.w
        ));
    }
    if ef.h != af.h {
        out.push(format!(
            "{at}: field h is {} where the catalog and its logged edits give {}",
            af.h, ef.h
        ));
    }
    if ef.rot != af.rot {
        out.push(format!(
            "{at}: field rot is {} where its logged edits give {}",
            af.rot, ef.rot
        ));
    }
    if eports.len() != aports.len() {
        out.push(format!(
            "{at}: field ports holds {} where the catalog and its logged edits give {}",
            aports.len(),
            eports.len()
        ));
    }
    for (i, (e, a)) in eports.iter().zip(&aports).enumerate() {
        if e != a {
            out.push(format!(
                "{at}: field ports[{i}] is {a:?} where the catalog gives {e:?}"
            ));
        }
    }
    out
}

/// The shape `id` holds on `core`: its footprint (absent reads as a 0x0 box, which no
/// catalog machine has) and its ports (absent reads as none).
fn shape_on(core: &Core, id: NodeId) -> Shape {
    let footprint = core
        .state
        .footprint_of(id)
        .unwrap_or(Footprint { w: 0, h: 0, rot: 0 });
    let ports = core
        .state
        .ports_of(id)
        .map(<[Port]>::to_vec)
        .unwrap_or_default();
    (footprint, ports)
}

/// Apply `commands` to a fresh headless session at `seed`, one `apply` each, and return
/// the mint-order handle ledger: dense handle `h` is `ledger[h]`. This is the second
/// applier the regenerability proofs use; its ids equal the booted host's by
/// construction, and a node the ledger names that the board lacks is reported missing.
fn mint_ledger(seed: u64, commands: &[GridCommand]) -> Vec<NodeId> {
    let mut session = GridSession::new(seed);
    let mut ledger = Vec::new();
    for (i, cmd) in commands.iter().enumerate() {
        session
            .apply(cmd.clone())
            .unwrap_or_else(|e| panic!("command {i} ({cmd:?}) is refused headless: {e:?}"));
        ledger.extend(session.core().last_tick.placed.iter().copied());
    }
    ledger
}

/// Whether `cmd`, aimed at dense handle `handle`, changes that node's SHAPE, and if so
/// the same command re-addressed to `to`. Exhaustive over `GridCommand`, so a new
/// command is a compile error here until the guard decides whether it shapes a node.
///
/// # Panics
/// On a scene command the guard does not model for a placed machine (a `Delete`, an
/// `Undo` or a `Redo` aimed at it): no shipped scene issues one, and a scene that starts
/// to must teach the guard what the node should then look like.
fn shape_edit_for(cmd: &GridCommand, handle: u64, to: u64) -> Option<GridCommand> {
    match cmd {
        GridCommand::Rotate { node, ccw } if *node == handle => Some(GridCommand::Rotate {
            node: to,
            ccw: *ccw,
        }),
        GridCommand::AddPort {
            node,
            role,
            side,
            medium,
        } if *node == handle => Some(GridCommand::AddPort {
            node: to,
            role: *role,
            side: *side,
            medium: *medium,
        }),
        GridCommand::RemovePort { node, index } if *node == handle => {
            Some(GridCommand::RemovePort {
                node: to,
                index: *index,
            })
        }
        GridCommand::Configure {
            node,
            config: config @ MachineConfig::Label { .. },
        } if *node == handle => Some(GridCommand::Configure {
            node: to,
            config: config.clone(),
        }),
        GridCommand::Delete { node } if *node == handle => {
            panic!("a scene deletes placed handle {handle}; the guard does not model a delete")
        }
        GridCommand::Rotate { .. }
        | GridCommand::AddPort { .. }
        | GridCommand::RemovePort { .. }
        | GridCommand::Configure { .. }
        | GridCommand::Delete { .. }
        | GridCommand::Place { .. }
        | GridCommand::DrawBelt { .. }
        | GridCommand::Dock { .. }
        | GridCommand::DrawWire { .. }
        | GridCommand::Unlink { .. } => None,
        GridCommand::Undo | GridCommand::Redo => {
            panic!("a scene issues Undo or Redo; the guard does not model history")
        }
    }
}

/// The REFERENCE shape of the node `commands[place_at]` placed (dense handle `handle`):
/// that logged `Place` alone on a fresh session at `seed`, then only the later commands
/// that reshape `handle`, re-addressed to the fresh node's handle 0.
fn rebuild_reference(seed: u64, commands: &[GridCommand], place_at: usize, handle: u64) -> Shape {
    let GridCommand::Place {
        kind,
        cell_x,
        cell_y,
    } = commands[place_at]
    else {
        panic!("command {place_at} is not a Place");
    };
    let mut fresh = GridSession::new(seed);
    fresh
        .apply(GridCommand::Place {
            kind,
            cell_x,
            cell_y,
        })
        .unwrap_or_else(|e| panic!("kind {kind} at ({cell_x},{cell_y}) places alone: {e:?}"));
    let id = *fresh
        .core()
        .last_tick
        .placed
        .first()
        .expect("the Place minted the node");
    let fresh_handle = fresh
        .view()
        .handle_of(id)
        .expect("the fresh node has a handle");
    for later in &commands[place_at + 1..] {
        if let Some(edit) = shape_edit_for(later, handle, fresh_handle) {
            fresh
                .apply(edit.clone())
                .unwrap_or_else(|e| panic!("the logged shape edit {edit:?} applies alone: {e:?}"));
        }
    }
    shape_on(fresh.core(), id)
}

/// Every violation on a board built from `commands`: each logged `Place` rebuilt as its
/// reference and compared with the node `ledger` names on `board`. Returns the
/// violations and how many nodes were checked.
fn scene_violations(
    scene: &str,
    seed: u64,
    commands: &[GridCommand],
    ledger: &[NodeId],
    board: &Core,
) -> (Vec<String>, usize) {
    // Map each command to the handles it minted, in order, by replaying the mint counts
    // the ledger already holds: a Place mints one node, so its handle is the running
    // count of mints before it.
    let mut handle_of_place: Vec<(usize, u64)> = Vec::new();
    let mut session = GridSession::new(seed);
    let mut minted_so_far = 0u64;
    for (i, cmd) in commands.iter().enumerate() {
        session
            .apply(cmd.clone())
            .expect("the scene applies headless");
        let minted = session.core().last_tick.placed.len() as u64;
        if matches!(cmd, GridCommand::Place { .. }) {
            assert_eq!(
                minted, 1,
                "{scene}: the Place at command {i} mints exactly one node"
            );
            handle_of_place.push((i, minted_so_far));
        }
        minted_so_far += minted;
    }
    let mut violations = Vec::new();
    let mut checked = 0usize;
    for (place_at, handle) in handle_of_place {
        let GridCommand::Place { kind, .. } = commands[place_at] else {
            unreachable!()
        };
        let id = ledger[usize::try_from(handle).expect("a handle fits usize")];
        if board.state.node(id).is_none() {
            violations.push(format!(
                "{scene}: handle {handle} (kind {kind}) is missing from the booted board"
            ));
            checked += 1;
            continue;
        }
        let expected = rebuild_reference(seed, commands, place_at, handle);
        let actual = shape_on(board, id);
        violations.extend(catalog_violations(scene, handle, kind, expected, actual));
        checked += 1;
    }
    (violations, checked)
}

/// A fresh genesis host at `seed` over a temp store, the way every boot site builds one
/// before handing it to `boot_scene`.
fn fresh_host(seed: u64) -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed,
    });
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");
    (dir, host)
}

/// The scene's name for a failure message, and the exhaustive `match` that makes a new
/// `SceneId` a compile error in this file until the guard is told about it.
fn scene_name(id: SceneId) -> &'static str {
    match id {
        SceneId::Demo => "demo",
        SceneId::OrderProcessing => "order processing",
        SceneId::Advanced => "advanced",
    }
}

/// The board files at the top of `examples/boards/` are exactly the shipped scenes. A new board
/// placed there with no [`SceneId`] fails here by name, and that is what keeps a docs board, which
/// belongs in `examples/boards/docs/`, out of the Examples list. The walk isn't recursive, so the
/// docs folder never counts.
#[test]
fn board_files_match_the_scene_catalog() {
    let boards_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/boards");
    let mut stems: Vec<String> = std::fs::read_dir(&boards_dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", boards_dir.display()))
        .map(|entry| entry.expect("read a directory entry").file_name().to_string_lossy().into_owned())
        .filter_map(|name| name.strip_suffix(".board.ron").map(str::to_owned))
        .collect();
    stems.sort();
    let mut wire_ids: Vec<String> = SceneId::ALL.iter().map(|id| id.wire_id().to_owned()).collect();
    wire_ids.sort();
    assert_eq!(
        stems, wire_ids,
        "the board files at the top of examples/boards must be exactly SceneId::ALL; a docs-only \
         board goes in examples/boards/docs/"
    );
    assert_eq!(stems.len(), SceneId::ALL.len(), "one file per scene");

    for id in SceneId::ALL {
        let path = boards_dir.join(format!("{}.board.ron", id.wire_id()));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let board = parse_board(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(
            board.commands,
            id.commands().expect("the embedded board parses"),
            "{}: the file and the build's embedded copy differ",
            id.wire_id()
        );
        assert_eq!(board.seed, id.genesis_seed(), "{}: seed", id.wire_id());
    }
}

#[test]
fn every_shipped_scene_node_matches_its_catalog_shape() {
    let mut report = Vec::new();
    for id in SceneId::ALL {
        let scene = scene_name(id);
        let seed = id.genesis_seed();
        let commands = id.commands().unwrap_or_else(|e| panic!("{scene}: {e}"));
        let (_dir, host) = fresh_host(seed);
        let host = boot_scene(host, id).unwrap_or_else(|e| panic!("{e}"));
        let ledger = mint_ledger(seed, &commands);

        let places = commands
            .iter()
            .filter(|c| matches!(c, GridCommand::Place { .. }))
            .count();
        assert!(
            places > 0,
            "{scene}: the scene places machines, so the guard has work to do"
        );
        let (violations, checked) = scene_violations(scene, seed, &commands, &ledger, host.core());
        assert_eq!(
            checked, places,
            "{scene}: every logged Place was checked ({checked} of {places})"
        );
        report.push(format!(
            "{scene}: places={places} checked={checked} violations={}",
            violations.len()
        ));
        assert!(
            violations.is_empty(),
            "{scene}: nodes differ from the catalog without a logged edit:\n{}",
            violations.join("\n")
        );
    }
    // The per-scene counts, for the evidence record (`--nocapture`).
    println!("SCENE CATALOG GUARD {}", report.join("; "));
}

#[test]
fn every_shipped_scene_node_was_minted_by_its_edit_log() {
    let mut report = Vec::new();
    for id in SceneId::ALL {
        let scene = scene_name(id);
        let seed = id.genesis_seed();
        let (_dir, host) = fresh_host(seed);
        let host = boot_scene(host, id).unwrap_or_else(|e| panic!("{e}"));
        let edits = host
            .logged_edits()
            .expect("read the booted host's edit log");
        let events = host
            .logged_events()
            .expect("read the booted host's event log");
        let replayed = GridSession::replay_two_logs(seed, &edits, &events);

        let mut booted: Vec<NodeId> = host.core().state.node_ids().collect();
        booted.sort_unstable();
        let mut from_log: Vec<NodeId> = replayed.core().state.node_ids().collect();
        from_log.sort_unstable();
        assert!(!booted.is_empty(), "{scene}: the booted board holds nodes");
        let not_from_log: Vec<NodeId> = booted
            .iter()
            .copied()
            .filter(|n| !from_log.contains(n))
            .collect();
        assert!(
            not_from_log.is_empty(),
            "{scene}: these booted nodes were not minted by any edit-log record: {not_from_log:?}"
        );
        assert_eq!(
            booted, from_log,
            "{scene}: the booted node set is the set its edit log mints"
        );
        report.push(format!(
            "{scene}: nodes={} records={}",
            booted.len(),
            edits.len()
        ));
    }
    println!("SCENE MINTED BY LOG {}", report.join("; "));
}

// ── The comparator's legs: each injected defect is named, scene, handle and field ──────

/// A Factory's catalog shape, rebuilt the way the guard rebuilds one.
fn factory_reference() -> Shape {
    let commands = [GridCommand::Place {
        kind: machine_kind::FACTORY,
        cell_x: 0,
        cell_y: 0,
    }];
    rebuild_reference(7, &commands, 0, 0)
}

/// Assert `violations` holds one naming the scene, the handle and `field`.
fn assert_named(violations: &[String], field: &str) {
    assert!(
        violations
            .iter()
            .any(|v| v.contains("leg-scene") && v.contains("handle 41") && v.contains(field)),
        "a violation must name the scene, the handle and the field {field:?}; got {violations:?}"
    );
}

#[test]
fn a_shrunk_footprint_is_a_violation_naming_its_field() {
    let expected = factory_reference();
    assert!(
        expected.0.w > 1 && expected.0.h > 1,
        "non-vacuity: a Factory is bigger than 1x1"
    );
    let mut actual = expected.clone();
    actual.0.w = 1;
    actual.0.h = 1;
    let violations = catalog_violations("leg-scene", 41, machine_kind::FACTORY, expected, actual);
    assert_named(&violations, "w");
    assert_named(&violations, "h");
}

#[test]
fn a_dropped_port_is_a_violation_naming_its_field() {
    let expected = factory_reference();
    assert!(
        expected.1.len() > 1,
        "non-vacuity: a Factory has more than one port"
    );
    let mut actual = expected.clone();
    actual.1.pop();
    let violations = catalog_violations("leg-scene", 41, machine_kind::FACTORY, expected, actual);
    assert_named(&violations, "ports");
}

#[test]
fn an_added_port_is_a_violation_naming_its_field() {
    let expected = factory_reference();
    let mut actual = expected.clone();
    let extra = *actual.1.last().expect("a Factory has a port to copy");
    actual.1.push(extra);
    let violations = catalog_violations("leg-scene", 41, machine_kind::FACTORY, expected, actual);
    assert_named(&violations, "ports");
}

/// A Label resized by its own logged `Configure` is a catalog machine shaped by a logged
/// edit, so it is NOT a violation; and the same board compared against the bare catalog
/// box IS one, which is what keeps this leg from passing on a comparator that never
/// looks.
#[test]
fn a_label_resized_by_its_configure_is_not_a_violation() {
    let commands = vec![
        GridCommand::Place {
            kind: machine_kind::LABEL,
            cell_x: 4,
            cell_y: 4,
        },
        GridCommand::Configure {
            node: 0,
            config: MachineConfig::Label {
                text: "Make orders".to_owned(),
                colour: 0,
                w: 6,
                h: 2,
            },
        },
    ];
    let seed = 7;
    let ledger = mint_ledger(seed, &commands);
    let mut board = GridSession::new(seed);
    for cmd in &commands {
        board.apply(cmd.clone()).expect("the label scene applies");
    }
    let (violations, checked) =
        scene_violations("leg-scene", seed, &commands, &ledger, board.core());
    assert_eq!(checked, 1, "the one Place was checked");
    assert!(
        violations.is_empty(),
        "a Configure resize is a logged edit, not a violation: {violations:?}"
    );
    assert_eq!(
        shape_on(board.core(), ledger[0]).0,
        Footprint { w: 6, h: 2, rot: 0 },
        "non-vacuity: the Configure really resized the label"
    );

    let bare = rebuild_reference(seed, &commands[..1], 0, 0);
    let against_bare = catalog_violations(
        "leg-scene",
        41,
        machine_kind::LABEL,
        bare,
        shape_on(board.core(), ledger[0]),
    );
    assert_named(&against_bare, "w");
}
