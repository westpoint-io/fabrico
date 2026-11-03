//! The board files are all format 2, each with a title, and the demo board's captions say what its
//! run does on their ticks.
//!
//! The walk is the one `board_manifest.rs` uses: every `*.board.ron` under `examples/boards/`, at
//! any depth.

// The board files live on disk.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::path::{Path, PathBuf};

use fabrico_core::state::Node;
use fabrico_engine::board::{BOARD_FORMAT, BoardFile, parse_board};
use fabrico_engine::scripted::{BoardRun, EffectSummary};

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const BOARDS_DIR: &str = "examples/boards";
const DEMO: &str = "examples/boards/demo_scene.board.ron";

/// The 3 shipped boards and the docs boards. A walk that finds fewer is broken.
const BOARD_FLOOR: usize = 4;

/// Every `*.board.ron` under `dir`, at any depth, as (repo-relative path, path on disk).
fn board_files(dir: &Path, relative: &str, found: &mut Vec<(String, PathBuf)>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
        let path = entry.expect("read a folder entry").path();
        let name = path.file_name().and_then(|n| n.to_str()).expect("a board path is UTF-8");
        let child = format!("{relative}/{name}");
        if path.is_dir() {
            board_files(&path, &child, found);
        } else if name.ends_with(".board.ron") {
            found.push((child, path));
        }
    }
}

fn walk_boards() -> Vec<(String, BoardFile)> {
    let mut found = Vec::new();
    board_files(&Path::new(REPO_ROOT).join(BOARDS_DIR), BOARDS_DIR, &mut found);
    found.sort();
    found
        .into_iter()
        .map(|(relative, path)| {
            let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {relative}: {e}"));
            let board = parse_board(&text).unwrap_or_else(|e| panic!("{relative}: {e}"));
            (relative, board)
        })
        .collect()
}

fn demo_board() -> BoardFile {
    walk_boards().into_iter().find(|(path, _)| path == DEMO).expect("the walk finds the demo board").1
}

#[test]
fn every_board_is_format_2_with_a_title_and_boots_with_its_captions() {
    let boards = walk_boards();
    assert!(boards.len() >= BOARD_FLOOR, "the walk found {} boards", boards.len());
    let mut problems = Vec::new();
    for (path, board) in boards {
        if board.format != BOARD_FORMAT || BOARD_FORMAT != 2 {
            problems.push(format!("{path}: format {}", board.format));
        }
        if board.title.trim().is_empty() {
            problems.push(format!("{path}: an empty title"));
        }
        // The boot is where a caption's handle is checked against the machines the board mints.
        if let Err(e) = BoardRun::boot(board) {
            problems.push(format!("{path}: {e}"));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

#[test]
fn the_demo_board_has_at_least_two_captions() {
    let board = demo_board();
    assert!(board.captions.len() >= 2, "the demo board has {} captions", board.captions.len());
    for caption in &board.captions {
        assert!(!caption.text.trim().is_empty(), "the caption at tick {} has no text", caption.tick);
    }
}

/// The captions name ticks a native run measured. If the board changes and a caption no longer
/// says what happens on its tick, this names the caption.
#[test]
fn the_demo_captions_describe_what_the_run_does_on_their_ticks() {
    let board = demo_board();
    let ticks: Vec<(u64, u64)> = board.captions.iter().map(|caption| (caption.tick, caption.highlight)).collect();
    assert_eq!(ticks, [(88, 1), (232, 1), (253, 5)], "the captions this test reads");

    let mut run = BoardRun::boot(board).expect("the demo board boots");
    let factory = run.minted()[1];
    let tee_belt = run.minted()[19];
    let fault_belt = run.minted()[22];
    let order_of = |run: &BoardRun| match run.engine().core().state.node(factory) {
        Some(Node::Factory(f)) => String::from_utf8_lossy(&f.state_json).into_owned(),
        other => panic!("handle 1 is the Factory, got {other:?}"),
    };
    let holds_an_item = |run: &BoardRun, belt: fabrico_core::ids::NodeId| match run.engine().core().state.node(belt) {
        Some(Node::Belt(belt)) => belt.slots.iter().any(Option::is_some),
        other => panic!("expected a belt, got {other:?}"),
    };

    let step_to = |run: &mut BoardRun, tick: u64| {
        while run.engine().core().tick < tick {
            run.step().expect("the demo board steps");
        }
    };

    step_to(&mut run, 87);
    assert!(!holds_an_item(&run, tee_belt), "the belt to the Tee is empty at tick 87");
    step_to(&mut run, 88);
    assert_eq!(order_of(&run), r#"{"order":1}"#, "order 1 at tick 88");
    assert!(holds_an_item(&run, tee_belt), "order 1 is on the belt to the Tee at tick 88");

    step_to(&mut run, 231);
    assert!(!holds_an_item(&run, fault_belt), "the fault belt is empty at tick 231");
    step_to(&mut run, 232);
    assert!(holds_an_item(&run, fault_belt), "the rejected order is on the fault belt at tick 232");

    step_to(&mut run, 253);
    let rejects_before: Vec<u64> = run
        .effects()
        .iter()
        .filter(|record| matches!(&record.effect, EffectSummary::Debug { message } if message.windows(8).any(|w| w == b"rejected")))
        .map(|record| record.tick)
        .collect();
    assert_eq!(rejects_before, [252], "the Rejects sink takes the order in the step that ends on tick 253");
}
