//! The check that pins each board file's end state.
//!
//! This walks `examples/boards/`, docs folder included, runs each `*.board.ron` headless to its end
//! tick, and compares the end tick and `tick_hash` with that board's line in
//! `examples/boards/hashes.manifest`. It looks at all the boards and all the lines before it
//! asserts, so one run names every problem.
//!
//! The generator at the bottom is `#[ignore]`d, so a test failure never rewrites the manifest. A
//! hash that moves is either a decision, made by running the generator by hand and declaring the
//! new digest in `docs/DECLARED-MOVES.txt`, or a change to revert.
//!
//! The comparison takes the walked results and the manifest text as plain values, so the tests of
//! the check itself can feed it bad inputs without touching a file.

// The board files and the manifest live on disk, and the generator writes the manifest.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use fabrico_engine::board::parse_board;
use fabrico_engine::scripted::BoardRun;
use fabrico_scenario::tick_hash;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const BOARDS_DIR: &str = "examples/boards";
const MANIFEST_PATH: &str = "examples/boards/hashes.manifest";

/// The 3 shipped boards and the docs test board. A walk that finds fewer is broken, and an empty
/// walk would otherwise pass.
const BOARD_FLOOR: usize = 4;

/// The comment header the generator writes above the board lines.
const MANIFEST_HEADER: &str = "\
# Final state hashes for the board files in this folder.
#
# Format: one line per board, with three fields separated by a single space:
#
#   <board path> <end tick> <hash>
#
# Lines are sorted byte-wise by board path. A generator writes this file, so don't edit it by
# hand. Lines that start with # are comments.
";

/// Where a board's run ended.
#[derive(Clone, Debug, PartialEq)]
struct BoardEnd {
    tick: u64,
    hash: String,
}

/// One board the walk found: its `/`-separated repo-relative path and how its run went.
#[derive(Clone, Debug, PartialEq)]
struct Walked {
    path: String,
    outcome: Result<BoardEnd, String>,
}

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

/// Run one board file headless to its end tick.
fn run_board(path: &Path) -> Result<BoardEnd, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    let board = parse_board(&text).map_err(|e| format!("parse: {e}"))?;
    let end_tick = board.end_tick;
    let mut run = BoardRun::boot(board).map_err(|e| format!("boot: {e}"))?;
    run.run_to_end().map_err(|e| format!("run: {e}"))?;
    let core = run.engine().core();
    if core.tick != end_tick {
        return Err(format!("the run stopped at tick {}, and the board says {end_tick}", core.tick));
    }
    Ok(BoardEnd { tick: core.tick, hash: tick_hash(core) })
}

/// Run every board under `examples/boards/`, in byte order of path.
fn walk_boards() -> Vec<Walked> {
    let mut files = Vec::new();
    board_files(&Path::new(REPO_ROOT).join(BOARDS_DIR), BOARDS_DIR, &mut files);
    files.sort();
    files
        .into_iter()
        .map(|(path, on_disk)| Walked { path, outcome: run_board(&on_disk) })
        .collect()
}

/// One well-formed board line of the manifest.
struct ManifestLine<'a> {
    number: usize,
    path: &'a str,
    end_tick: u64,
    hash: &'a str,
}

/// Read one line's three fields, or `None` if it isn't exactly `<path> <end tick> <hash>`.
fn parse_line(number: usize, line: &str) -> Option<ManifestLine<'_>> {
    let fields: Vec<&str> = line.split(' ').collect();
    let [path, end_tick, hash] = fields[..] else {
        return None;
    };
    let is_hash = hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if path.is_empty() || !end_tick.bytes().all(|b| b.is_ascii_digit()) || !is_hash {
        return None;
    }
    Some(ManifestLine { number, path, end_tick: end_tick.parse().ok()?, hash })
}

/// The manifest's board lines, keyed by path, and everything wrong with the text itself. Only the
/// first copy of a path listed twice is kept.
fn parse_manifest(manifest: &str) -> (BTreeMap<&str, ManifestLine<'_>>, Vec<String>) {
    let mut lines: BTreeMap<&str, ManifestLine<'_>> = BTreeMap::new();
    let mut problems = Vec::new();
    let mut previous: Option<&str> = None;
    for (index, line) in manifest.lines().enumerate() {
        let number = index + 1;
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(parsed) = parse_line(number, line) else {
            problems.push(format!("manifest line {number} is malformed: {line:?}"));
            continue;
        };
        // str compares byte by byte, which is the order the manifest promises.
        if let Some(first) = lines.get(parsed.path) {
            problems.push(format!(
                "manifest line {number} lists {} twice; it's first on line {}",
                parsed.path, first.number
            ));
        } else if previous.is_some_and(|p| parsed.path <= p) {
            problems.push(format!(
                "manifest line {number} is out of order: {} comes after {}",
                parsed.path,
                previous.unwrap_or_default()
            ));
        }
        previous = Some(parsed.path);
        lines.entry(parsed.path).or_insert(parsed);
    }
    if lines.is_empty() {
        problems.push("the manifest has no board lines".to_string());
    }
    (lines, problems)
}

/// Everything wrong between the walked boards and the manifest text.
fn compare(walked: &[Walked], manifest: &str) -> Vec<String> {
    let mut problems = Vec::new();
    if walked.len() < BOARD_FLOOR {
        problems.push(format!(
            "the walk found {} boards, and there should be at least {BOARD_FLOOR}",
            walked.len()
        ));
    }
    let (lines, manifest_problems) = parse_manifest(manifest);
    problems.extend(manifest_problems);
    for board in walked {
        let path = &board.path;
        let Some(line) = lines.get(path.as_str()) else {
            problems.push(format!("{path} has no manifest line"));
            continue;
        };
        match &board.outcome {
            Err(reason) => problems.push(format!("{path} could not run: {reason}")),
            Ok(end) => {
                if end.tick != line.end_tick {
                    problems.push(format!(
                        "{path}: end tick is {} and the manifest says {}",
                        end.tick, line.end_tick
                    ));
                }
                if end.hash != line.hash {
                    problems.push(format!(
                        "{path}: hash is {} and the manifest says {}",
                        end.hash, line.hash
                    ));
                }
            }
        }
    }
    for line in lines.values() {
        if !walked.iter().any(|board| board.path == line.path) {
            problems.push(format!(
                "manifest line {} names {}, and no such board exists",
                line.number, line.path
            ));
        }
    }
    problems
}

/// The manifest text for these boards, or the reason it can't be written.
fn render_manifest(walked: &[Walked]) -> Result<String, String> {
    if walked.len() < BOARD_FLOOR {
        return Err(format!(
            "the walk found {} boards, and there should be at least {BOARD_FLOOR}",
            walked.len()
        ));
    }
    let mut sorted: Vec<&Walked> = walked.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut text = MANIFEST_HEADER.to_string();
    for board in sorted {
        let end = board
            .outcome
            .as_ref()
            .map_err(|reason| format!("{} could not run: {reason}", board.path))?;
        writeln!(text, "{} {} {}", board.path, end.tick, end.hash).expect("write to a String");
    }
    Ok(text)
}

#[test]
fn every_board_matches_its_manifest_line() {
    let manifest = fs::read_to_string(Path::new(REPO_ROOT).join(MANIFEST_PATH))
        .unwrap_or_else(|e| panic!("read {MANIFEST_PATH}: {e}"));
    let problems = compare(&walk_boards(), &manifest);
    assert!(problems.is_empty(), "{} problem(s):\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn the_walk_finds_the_docs_board_and_uses_repo_relative_slash_paths() {
    let walked = walk_boards();
    assert!(
        walked.iter().any(|w| w.path == "examples/boards/docs/script-outcomes.board.ron"),
        "the docs folder wasn't walked: {:?}",
        walked.iter().map(|w| &w.path).collect::<Vec<_>>()
    );
    for board in &walked {
        assert!(board.path.starts_with("examples/boards/"), "{}", board.path);
        assert!(!board.path.contains('\\'), "{}", board.path);
    }
}

#[test]
fn the_generator_output_is_byte_identical_on_a_second_run() {
    let first = render_manifest(&walk_boards()).expect("first render");
    let second = render_manifest(&walk_boards()).expect("second render");
    assert_eq!(first, second);
    assert!(first.lines().filter(|l| !l.starts_with('#')).count() >= BOARD_FLOOR, "{first}");
}

// The tests below check the comparison on made-up inputs.

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn walked(path: &str, tick: u64, hash: &str) -> Walked {
    Walked { path: path.to_string(), outcome: Ok(BoardEnd { tick, hash: hash.to_string() }) }
}

fn four_boards() -> Vec<Walked> {
    vec![
        walked("examples/boards/a.board.ron", 100, HASH_A),
        walked("examples/boards/b.board.ron", 200, HASH_B),
        walked("examples/boards/docs/c.board.ron", 300, HASH_C),
        walked("examples/boards/d.board.ron", 400, HASH_A),
    ]
}

const FOUR_LINES: &str = "\
examples/boards/a.board.ron 100 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
examples/boards/b.board.ron 200 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
examples/boards/d.board.ron 400 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
examples/boards/docs/c.board.ron 300 cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
";

/// Assert one problem mentions all of `needles`, and show all the problems if none does.
fn assert_named(problems: &[String], needles: &[&str]) {
    assert!(
        problems.iter().any(|p| needles.iter().all(|n| p.contains(n))),
        "no problem mentions all of {needles:?}:\n{}",
        problems.join("\n")
    );
}

#[test]
fn a_matching_set_has_no_problems() {
    let problems = compare(&four_boards(), FOUR_LINES);
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn comments_and_blank_lines_are_skipped() {
    let manifest = format!("# a comment\n\n{FOUR_LINES}\n# another\n");
    let problems = compare(&four_boards(), &manifest);
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn a_board_with_no_line_is_named() {
    let mut boards = four_boards();
    boards.push(walked("examples/boards/new.board.ron", 500, HASH_B));
    assert_named(&compare(&boards, FOUR_LINES), &["examples/boards/new.board.ron", "no manifest line"]);
}

#[test]
fn a_line_with_no_board_is_named() {
    let boards = four_boards();
    let manifest = format!(
        "{FOUR_LINES}examples/boards/gone.board.ron 500 {HASH_B}\n"
    );
    assert_named(&compare(&boards, &manifest), &["line 5", "examples/boards/gone.board.ron", "no such board"]);
}

#[test]
fn a_wrong_hash_names_the_board_and_both_values() {
    let mut boards = four_boards();
    boards[0] = walked("examples/boards/a.board.ron", 100, HASH_C);
    assert_named(&compare(&boards, FOUR_LINES), &["examples/boards/a.board.ron", "hash", HASH_C, HASH_A]);
}

#[test]
fn a_wrong_end_tick_names_the_board_and_both_values() {
    let mut boards = four_boards();
    boards[1] = walked("examples/boards/b.board.ron", 201, HASH_B);
    assert_named(&compare(&boards, FOUR_LINES), &["examples/boards/b.board.ron", "end tick", "201", "200"]);
}

#[test]
fn an_unsorted_manifest_names_the_line() {
    let manifest = format!(
        "examples/boards/b.board.ron 200 {HASH_B}\n\
         examples/boards/a.board.ron 100 {HASH_A}\n\
         examples/boards/d.board.ron 400 {HASH_A}\n\
         examples/boards/docs/c.board.ron 300 {HASH_C}\n"
    );
    assert_named(&compare(&four_boards(), &manifest), &["line 2", "examples/boards/a.board.ron", "order"]);
}

#[test]
fn a_path_listed_twice_names_the_line_even_when_the_copies_are_not_adjacent() {
    let manifest = format!(
        "examples/boards/a.board.ron 100 {HASH_A}\n\
         examples/boards/b.board.ron 200 {HASH_B}\n\
         examples/boards/a.board.ron 100 {HASH_A}\n\
         examples/boards/d.board.ron 400 {HASH_A}\n\
         examples/boards/docs/c.board.ron 300 {HASH_C}\n"
    );
    assert_named(&compare(&four_boards(), &manifest), &["line 3", "examples/boards/a.board.ron", "twice"]);
}

#[test]
fn malformed_lines_are_named() {
    let long_hash = format!("{HASH_A}a");
    let upper_hash = HASH_A.to_uppercase();
    let bad_lines = [
        "examples/boards/z.board.ron 100".to_string(),
        format!("examples/boards/z.board.ron 100 {HASH_A} extra"),
        format!("examples/boards/z.board.ron  100 {HASH_A}"),
        format!("examples/boards/z.board.ron\t100\t{HASH_A}"),
        format!("examples/boards/z.board.ron soon {HASH_A}"),
        format!("examples/boards/z.board.ron -1 {HASH_A}"),
        format!("examples/boards/z.board.ron +1 {HASH_A}"),
        "examples/boards/z.board.ron 100 abc".to_string(),
        format!("examples/boards/z.board.ron 100 {long_hash}"),
        format!("examples/boards/z.board.ron 100 {upper_hash}"),
        format!(" examples/boards/z.board.ron 100 {HASH_A}"),
        "   ".to_string(),
    ];
    for bad in &bad_lines {
        let manifest = format!("{FOUR_LINES}{bad}\n");
        assert_named(&compare(&four_boards(), &manifest), &["line 5", "malformed"]);
    }
}

#[test]
fn an_empty_walk_fails() {
    assert_named(&compare(&[], FOUR_LINES), &["found 0 boards", "4"]);
}

#[test]
fn fewer_than_the_floor_of_boards_fails() {
    let boards = &four_boards()[..3];
    assert_named(&compare(boards, FOUR_LINES), &["found 3 boards", "4"]);
}

#[test]
fn a_header_only_manifest_fails() {
    let problems = compare(&four_boards(), MANIFEST_HEADER);
    assert_named(&problems, &["no board lines"]);
    assert_named(&problems, &["examples/boards/a.board.ron", "no manifest line"]);
}

#[test]
fn an_empty_walk_and_a_header_only_manifest_fail_together() {
    let problems = compare(&[], MANIFEST_HEADER);
    assert_named(&problems, &["found 0 boards"]);
    assert_named(&problems, &["no board lines"]);
}

#[test]
fn two_boards_with_the_same_hash_each_keep_their_own_line() {
    // a and d share HASH_A in the fixtures above, so both lines have to survive and match.
    assert!(compare(&four_boards(), FOUR_LINES).is_empty());
    let text = render_manifest(&four_boards()).expect("render");
    assert!(text.contains(&format!("examples/boards/a.board.ron 100 {HASH_A}\n")), "{text}");
    assert!(text.contains(&format!("examples/boards/d.board.ron 400 {HASH_A}\n")), "{text}");

    // Dropping one line names that board, so the other's matching hash can't stand in for it.
    let without_d: String = FOUR_LINES.lines().filter(|l| !l.contains("/d.board.ron")).map(|l| format!("{l}\n")).collect();
    let problems = compare(&four_boards(), &without_d);
    assert_named(&problems, &["examples/boards/d.board.ron", "no manifest line"]);
    assert_eq!(problems.len(), 1, "{}", problems.join("\n"));
}

#[test]
fn one_run_names_every_problem() {
    let mut boards = four_boards();
    boards[0] = walked("examples/boards/a.board.ron", 100, HASH_C);
    boards.push(walked("examples/boards/new.board.ron", 500, HASH_B));
    let manifest = format!("{FOUR_LINES}examples/boards/gone.board.ron 500 {HASH_B}\nnot a line at all here\n");
    let problems = compare(&boards, &manifest);
    assert_named(&problems, &["examples/boards/a.board.ron", "hash"]);
    assert_named(&problems, &["examples/boards/new.board.ron", "no manifest line"]);
    assert_named(&problems, &["examples/boards/gone.board.ron", "no such board"]);
    assert_named(&problems, &["line 6", "malformed"]);
}

#[test]
fn a_board_that_could_not_run_is_named_with_its_reason() {
    let mut boards = four_boards();
    boards[2] = Walked {
        path: "examples/boards/docs/c.board.ron".to_string(),
        outcome: Err("parse: unexpected token".to_string()),
    };
    assert_named(&compare(&boards, FOUR_LINES), &["examples/boards/docs/c.board.ron", "parse: unexpected token"]);
}

#[test]
fn the_generator_sorts_byte_wise_by_path_whatever_order_it_is_given() {
    let mut boards = four_boards();
    boards.push(walked("examples/boards/Z.board.ron", 500, HASH_B));
    let sorted = render_manifest(&boards).expect("render");
    boards.reverse();
    assert_eq!(render_manifest(&boards).expect("render"), sorted);

    let paths: Vec<&str> = sorted
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .map(|l| l.split(' ').next().expect("a path"))
        .collect();
    assert_eq!(
        paths,
        [
            "examples/boards/Z.board.ron",
            "examples/boards/a.board.ron",
            "examples/boards/b.board.ron",
            "examples/boards/d.board.ron",
            "examples/boards/docs/c.board.ron",
        ]
    );
}

#[test]
fn the_generator_output_passes_the_comparison_and_ends_in_a_newline() {
    let text = render_manifest(&four_boards()).expect("render");
    assert!(text.starts_with(MANIFEST_HEADER), "{text}");
    assert!(text.ends_with('\n'), "{text}");
    assert!(text.ends_with(&format!("{HASH_C}\n")), "{text}");
    let problems = compare(&four_boards(), &text);
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_generator_refuses_a_board_that_could_not_run() {
    let mut boards = four_boards();
    boards[0] = Walked {
        path: "examples/boards/a.board.ron".to_string(),
        outcome: Err("run: refused".to_string()),
    };
    let refusal = render_manifest(&boards).expect_err("a failed board must stop the generator");
    assert!(refusal.contains("examples/boards/a.board.ron") && refusal.contains("run: refused"), "{refusal}");
}

#[test]
fn the_generator_refuses_a_walk_below_the_floor() {
    let refusal = render_manifest(&four_boards()[..3]).expect_err("a short walk must stop the generator");
    assert!(refusal.contains("found 3 boards"), "{refusal}");
}

/// The one way to write the manifest. Run it by hand, as a stated act, after a change you mean to
/// keep, then declare the new digest: `cargo test -p fabrico-engine --test board_manifest --
/// --ignored regenerate_board_manifest`.
#[test]
#[ignore = "writes the manifest by hand; never run on a failure"]
fn regenerate_board_manifest() {
    let text = render_manifest(&walk_boards()).unwrap_or_else(|reason| panic!("{reason}"));
    let path = Path::new(REPO_ROOT).join(MANIFEST_PATH);
    fs::write(&path, text).unwrap_or_else(|e| panic!("write {MANIFEST_PATH}: {e}"));
}
