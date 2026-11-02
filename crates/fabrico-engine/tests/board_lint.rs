//! The board lint: each board runs a second time at half the memory limit and a quarter of the
//! stack limit, and has to behave exactly as it does at the full limits.
//!
//! A board's hash comes out the same on the desktop and in the browser only while its Factories
//! stay clear of the memory and stack limits, because the point where a limit first faults differs
//! from one target to the next. Running the board is the check. A scan of the source can't see
//! recursion through `Array.map`, which spends more stack per level than plain recursion.
//!
//! A board fails the lint on either of two rules:
//! - R1: at some tick, its `tick_hash` at the reduced limits differs from its `tick_hash` at the
//!   full limits. This catches a Factory that catches the limit's error itself and so raises no
//!   fault.
//! - R2: at the reduced limits, a Factory faults with a limit's text, read by
//!   [`is_limit_fault`]. R1 alone misses a board that hits a limit at both sizes.
//!
//! A fault a Factory throws on purpose passes, because it happens the same way at both sizes and
//! its text names no limit. The demo board throws 6 times.
//!
//! Both runs go through [`BoardRun`], the one tick loop.

// The board files live on disk.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::path::{Path, PathBuf};

use fabrico_core::factory::{DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT, FactoryLimits};
use fabrico_core::state::Node;
use fabrico_engine::board::parse_board;
use fabrico_engine::scripted::BoardRun;
use fabrico_scenario::tick_hash;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const BOARDS_DIR: &str = "examples/boards";

/// The 3 shipped boards and the docs test board. A walk that finds fewer is broken, and an empty
/// walk would otherwise pass.
const BOARD_FLOOR: usize = 4;

/// Half the default memory limit.
const LINT_MEM: u32 = DEFAULT_MEM_LIMIT / 2;
/// A quarter of the default stack limit.
const LINT_STACK: u32 = DEFAULT_STACK_LIMIT / 4;

/// The limits of the lint's second run.
const LINT_LIMITS: FactoryLimits = FactoryLimits { mem_limit: LINT_MEM, stack_limit: LINT_STACK };

/// One run of a board: the hash after each step, and the faults its Factories raised.
struct Run {
    /// `(tick, tick_hash)` after each step, where `tick` is the core's tick after the step.
    hashes: Vec<(u64, String)>,
    /// Faults that came from a limit, by the engine cache's count.
    limit_faults: u64,
    /// The tick after the step on which the first limit fault happened.
    first_limit_fault_tick: Option<u64>,
    /// The ticks a Factory faulted on, deliberate faults included, one entry per faulting
    /// Factory per tick, read from the core's per-tick observation.
    factory_fault_ticks: Vec<u64>,
}

/// Run a board's text to its end tick, at `limits`, or through [`BoardRun::boot`] for `None`.
fn run_at(text: &str, limits: Option<FactoryLimits>) -> Result<Run, String> {
    let board = parse_board(text).map_err(|e| format!("parse: {e}"))?;
    let mut run = match limits {
        None => BoardRun::boot(board),
        Some(limits) => BoardRun::boot_with_limits(board, limits),
    }
    .map_err(|e| format!("boot: {e}"))?;
    let mut hashes = Vec::new();
    let mut first_limit_fault_tick = None;
    let mut factory_fault_ticks = Vec::new();
    while !run.is_finished() {
        run.step().map_err(|e| format!("run: {e}"))?;
        let core = run.engine().core();
        hashes.push((core.tick, tick_hash(core)));
        if first_limit_fault_tick.is_none() && core.factory_runtimes.limit_fault_count() > 0 {
            first_limit_fault_tick = Some(core.tick);
        }
        for &id in &core.last_tick.faulted {
            if matches!(core.state.node(id), Some(Node::Factory(_))) {
                factory_fault_ticks.push(core.tick);
            }
        }
    }
    let core = run.engine().core();
    Ok(Run {
        hashes,
        limit_faults: core.factory_runtimes.limit_fault_count(),
        first_limit_fault_tick,
        factory_fault_ticks,
    })
}

/// Every problem the lint finds with one board's text. Empty means it passes.
fn lint_board(text: &str) -> Vec<String> {
    let full = match run_at(text, None) {
        Ok(run) => run,
        Err(e) => return vec![format!("at the full limits: {e}")],
    };
    let reduced = match run_at(text, Some(LINT_LIMITS)) {
        Ok(run) => run,
        Err(e) => return vec![format!("at the reduced limits: {e}")],
    };
    let mut problems = Vec::new();
    // R1: the two runs have to agree at every tick.
    if let Some(((tick, _), _)) = full.hashes.iter().zip(&reduced.hashes).find(|(a, b)| a != b) {
        problems.push(format!(
            "R1: the hash after tick {tick} at {LINT_MEM} bytes of memory and {LINT_STACK} bytes of \
             stack differs from the run at the full limits"
        ));
    } else if full.hashes.len() != reduced.hashes.len() {
        problems.push(format!(
            "R1: the run at the full limits took {} steps and the run at the reduced limits took {}",
            full.hashes.len(),
            reduced.hashes.len()
        ));
    }
    // R2: no fault at the reduced limits may come from a limit.
    if reduced.limit_faults > 0 {
        let tick = reduced.first_limit_fault_tick.map_or_else(|| "?".to_owned(), |t| t.to_string());
        problems.push(format!(
            "R2: {} Factory fault(s) at {LINT_MEM} bytes of memory and {LINT_STACK} bytes of stack came \
             from a limit, the first by tick {tick}",
            reduced.limit_faults
        ));
    }
    problems
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

/// Each board under `examples/boards/`, in byte order of path, with its text.
fn shipped_boards() -> Vec<(String, String)> {
    let mut files = Vec::new();
    board_files(&Path::new(REPO_ROOT).join(BOARDS_DIR), BOARDS_DIR, &mut files);
    files.sort();
    files
        .into_iter()
        .map(|(path, on_disk)| {
            let text = fs::read_to_string(&on_disk).unwrap_or_else(|e| panic!("read {path}: {e}"));
            (path, text)
        })
        .collect()
}

/// The walk's verdict: each board's problems under its path, and a walk that found too few boards.
fn walk_problems(linted: &[(String, Vec<String>)]) -> Vec<String> {
    let mut problems = Vec::new();
    if linted.len() < BOARD_FLOOR {
        problems.push(format!(
            "the walk found {} board(s) under {BOARDS_DIR}, and there are at least {BOARD_FLOOR}",
            linted.len()
        ));
    }
    for (path, board_problems) in linted {
        for problem in board_problems {
            problems.push(format!("{path}: {problem}"));
        }
    }
    problems
}

/// A board with one Factory between a Source and a Sink, and one webhook into the Source at tick
/// 40. The item reaches the Factory around tick 63, and the run ends on tick 120.
fn factory_board(source: &str) -> String {
    factory_board_with_script(source, "")
}

/// [`factory_board`] with more script entries after the webhook.
fn factory_board_with_script(source: &str, more_script: &str) -> String {
    format!(
        r##"Board(
    format: 1,
    seed: 94,
    commands: [
        Place(kind: 0, cell_x: 1, cell_y: 2),
        Place(kind: 2, cell_x: 5, cell_y: 1),
        Place(kind: 7, cell_x: 11, cell_y: 2),
        DrawBelt(cells: [(2, 2), (3, 2), (4, 2)]),
        DrawBelt(cells: [(8, 2), (9, 2), (10, 2)]),
        Dock(belt: 3, endpoint: Tail, node: 0, port: 0),
        Dock(belt: 3, endpoint: Head, node: 1, port: 0),
        Dock(belt: 4, endpoint: Tail, node: 1, port: 1),
        Dock(belt: 4, endpoint: Head, node: 2, port: 0),
        Configure(node: 1, config: Factory(source: r#"{source}"#)),
    ],
    script: [
        At(tick: 40, input: Webhook(source: 0, body: "{{}}")),
{more_script}    ],
    executor: Executor(default: Reply(after_ticks: 1), rules: []),
    view: View(fit: Board),
    end_tick: 120,
)
"##
    )
}

/// `n` arrays of 1000 elements, then one emit.
fn arrays_source(n: u64) -> String {
    format!(
        "export default function (input, ctx) {{ const a = []; for (let k = 0; k < {n}; k++) \
         a.push(new Array(1000).fill(k)); ctx.emit(0, {{ arrays: a.length }}); }}"
    )
}

#[test]
fn the_lint_limits_are_half_the_memory_and_a_quarter_of_the_stack() {
    // Both divisions are exact at the defaults. A default that stops dividing evenly shows up here.
    assert_eq!(LINT_MEM, 4 * 1024 * 1024);
    assert_eq!(LINT_STACK, 128 * 1024);
    assert_eq!(LINT_MEM * 2, DEFAULT_MEM_LIMIT);
    assert_eq!(LINT_STACK * 4, DEFAULT_STACK_LIMIT);
}

#[test]
fn boot_and_boot_with_the_default_limits_give_the_same_run() {
    let boards = shipped_boards();
    assert!(boards.len() >= BOARD_FLOOR, "found {} boards", boards.len());
    for (path, text) in &boards {
        let booted = run_at(text, None).unwrap_or_else(|e| panic!("{path}: {e}"));
        let limited = run_at(text, Some(FactoryLimits::default())).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert_eq!(booted.hashes.len(), limited.hashes.len(), "{path}");
        for (a, b) in booted.hashes.iter().zip(&limited.hashes) {
            assert_eq!(a, b, "{path}: the hash after tick {} differs", a.0);
        }
    }
}

#[test]
fn a_limit_fault_is_counted_and_the_demo_throws_are_not() {
    let arrays = factory_board(&arrays_source(300));
    let reduced = run_at(&arrays, Some(LINT_LIMITS)).expect("runs");
    assert_eq!(reduced.limit_faults, 1, "300 arrays fault once at the reduced memory limit");
    assert_eq!(reduced.factory_fault_ticks.len(), 1, "{:?}", reduced.factory_fault_ticks);

    let demo = fs::read_to_string(Path::new(REPO_ROOT).join(BOARDS_DIR).join("demo_scene.board.ron"))
        .expect("read the demo board");
    let reduced = run_at(&demo, Some(LINT_LIMITS)).expect("runs");
    assert_eq!(reduced.factory_fault_ticks.len(), 6, "the demo's Factory throws 6 times: {:?}", reduced.factory_fault_ticks);
    assert_eq!(reduced.limit_faults, 0, "and none of those throws is a limit fault");
}

#[test]
fn a_configure_rebuilds_the_engine_at_the_reduced_limits() {
    // The first webhook builds the pass-through engine. The edit at tick 80 swaps in 300 arrays,
    // which evicts the engine, and the second webhook makes the cache rebuild it.
    let board = factory_board_with_script(
        "export default function (input, ctx) { ctx.emit(0, input); }",
        &format!(
            "        At(tick: 80, input: Edit(Configure(node: 1, config: Factory(source: r#\"{}\"#)))),\n        \
             At(tick: 90, input: Webhook(source: 0, body: \"{{}}\")),\n",
            arrays_source(300)
        ),
    );
    let full = run_at(&board, None).expect("runs");
    assert_eq!(full.limit_faults, 0, "300 arrays run at the full limits");
    let reduced = run_at(&board, Some(LINT_LIMITS)).expect("runs");
    assert_eq!(reduced.limit_faults, 1, "the rebuilt engine has the reduced memory limit");
    assert!(reduced.first_limit_fault_tick.is_some_and(|t| t > 90), "{:?}", reduced.first_limit_fault_tick);
}

#[test]
fn a_cloned_core_keeps_its_limits_and_starts_with_no_engines() {
    let board = parse_board(&factory_board(&arrays_source(1))).expect("parses");
    let mut run = BoardRun::boot_with_limits(board, LINT_LIMITS).expect("boots");
    run.run_to_end().expect("runs");
    let core = run.engine().core();
    assert_eq!(core.factory_runtimes.limits(), LINT_LIMITS, "the engine's core kept the limits");
    assert_eq!(core.factory_runtimes.len(), 1, "the Factory's engine was built");
    let clone = core.clone();
    assert_eq!(clone.factory_runtimes.limits(), LINT_LIMITS);
    assert!(clone.factory_runtimes.is_empty());
    assert_eq!(clone.factory_runtimes.limit_fault_count(), 0);
}

#[test]
fn the_walk_fails_on_fewer_boards_than_the_floor() {
    let three: Vec<(String, Vec<String>)> = (0..3).map(|i| (format!("b{i}"), Vec::new())).collect();
    let problems = walk_problems(&three);
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].contains("found 3 board(s)"), "{problems:?}");
    let four: Vec<(String, Vec<String>)> = (0..4).map(|i| (format!("b{i}"), Vec::new())).collect();
    assert!(walk_problems(&four).is_empty());
}

#[test]
fn every_board_passes_the_lint() {
    let linted: Vec<(String, Vec<String>)> =
        shipped_boards().into_iter().map(|(path, text)| (path, lint_board(&text))).collect();
    let problems = walk_problems(&linted);
    assert!(problems.is_empty(), "the board lint found {} problem(s):\n{}", problems.len(), problems.join("\n"));
}
