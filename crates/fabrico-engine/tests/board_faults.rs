//! The fault check: every board under `examples/boards/` raises exactly the fault reasons its line in
//! `examples/boards/faults.manifest` names, and a board with no line there raises none.
//!
//! A docs page shows a board that faults on purpose with `<Board faultsAbout="...">`, and a line
//! under the board names the reasons to the reader. The docs suite plays the board in a browser and
//! counts the times a machine turns FAULTED, but the render state carries no reason, so it can't
//! tell a `NoMatch` from a `FactoryError`. This test reads the reasons natively, and the site build
//! compares each page's `faultsAbout` with the same manifest line, so the board, the manifest and
//! the page can't drift apart unseen.
//!
//! # How the reasons are read
//! The engine's per-tick observation lists the nodes that emitted a fault, with no reason. So after
//! every step the test decodes each [`Fault`] it finds on a path that carries faults. The path
//! decides what an item is, never its bytes, the same rule the engine follows: plenty of other
//! items decode as a fault by accident (a request envelope whose correlation id is 0 to 8 does), so
//! the test reads only
//! - the items resting on any node's fault port inbox;
//! - the fault belts: every belt a node's fault port links to, and every belt those belts link on
//!   to, with each one's slots and staging inbox;
//! - the inbox port a fault belt hands its items to;
//! - the emits a Factory holds on its fault port.
//!
//! An item counts as a fault only if its bytes decode as one and encode back to the same bytes, so
//! a fault followed by trailing bytes is no fault.
//!
//! Two producers drop a fault when nothing is docked on their Fault port, and each has a counter
//! that only one reason raises: a Router's `faults` counts `NoMatch`, and a Tee's counts
//! `BranchBusy`. A Factory's counter is no help, because a Factory can fault for several reasons and
//! the counter also counts items it lost for other causes, so a rise in it is reported as a
//! problem: dock the Factory's Fault port so the fault's reason can be read.
//!
//! Each fault names the node that produced it. A node that turns FAULTED (by
//! [`derive_state`], the reading the render packet sends) and produced no fault this test read is a
//! problem too, so a fault the test can't see fails it instead of passing as no fault.

// The board files and the manifest live on disk.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::state::{GridState, Node};
use fabrico_engine::board::{BoardFile, ScriptInput, parse_board};
use fabrico_engine::render_packet::derive_state;
use fabrico_engine::scripted::BoardRun;
use fabrico_protocol::state_tag;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const BOARDS_DIR: &str = "examples/boards";
const MANIFEST_PATH: &str = "examples/boards/faults.manifest";

/// The fewest boards a walk may find. Fewer means the walk is broken, and an empty walk would
/// otherwise pass.
const BOARD_FLOOR: usize = 5;

/// The reason's name as the manifest, the pages and `facts.json` write it. No `_` arm: a new
/// variant is a compile error here.
fn reason_name(reason: &FaultReason) -> &'static str {
    match reason {
        FaultReason::NoMatch => "NoMatch",
        FaultReason::FactoryError => "FactoryError",
        FaultReason::FactoryTimeout => "FactoryTimeout",
        FaultReason::CommandTimeout => "CommandTimeout",
        FaultReason::CommandFailure => "CommandFailure",
        FaultReason::WireOverflow => "WireOverflow",
        FaultReason::OutputRefused => "OutputRefused",
        FaultReason::NoEntryWire => "NoEntryWire",
        FaultReason::BranchBusy { branch: _ } => "BranchBusy",
    }
}

/// What one run of a board showed.
#[derive(Debug, Default)]
struct Observed {
    /// Each reason read, with the first tick it was read on.
    reasons: BTreeMap<&'static str, u64>,
    /// Faults the test couldn't read a reason for, as messages naming the node and the tick.
    unread: Vec<String>,
}

/// The handle a board's commands gave `id`, for messages.
fn handle_of(run: &BoardRun, id: NodeId) -> String {
    run.minted()
        .iter()
        .position(|&m| m == id)
        .map_or_else(|| format!("{id:?}"), |h| format!("handle {h}"))
}

/// The fault an item on a fault path holds: its bytes decode as a [`Fault`] and that fault encodes
/// back to the same bytes. `Fault::decode` alone ignores trailing bytes.
fn fault_in(item: &Item) -> Option<Fault> {
    Fault::decode(item).ok().filter(|fault| fault.encode() == *item)
}

/// Where faults ride on this tick: every belt reachable from some node's fault port link,
/// following belt-to-belt links, and the (node, port) inboxes those belts hand items to.
fn fault_paths(state: &GridState, ids: &[NodeId]) -> (BTreeSet<NodeId>, BTreeSet<(NodeId, PortId)>) {
    let is_belt = |id: NodeId| matches!(state.node(id), Some(Node::Belt(_)));
    let mut belts: BTreeSet<NodeId> = BTreeSet::new();
    let mut ends: BTreeSet<(NodeId, PortId)> = BTreeSet::new();
    let mut frontier: Vec<(NodeId, PortId)> =
        ids.iter().filter_map(|&id| state.link_target((id, FAULT_PORT))).collect();
    while let Some((dest, port)) = frontier.pop() {
        if !is_belt(dest) {
            ends.insert((dest, port));
        } else if belts.insert(dest) {
            frontier.extend(state.links_from(dest).map(|(_, to)| to));
        }
    }
    (belts, ends)
}

/// Play a board's text to its end tick and read every fault reason it raises.
fn observe(text: &str) -> Result<Observed, String> {
    observe_board(parse_board(text).map_err(|e| format!("parse: {e}"))?)
}

/// Play a parsed board to its end tick and read every fault reason it raises.
fn observe_board(board: BoardFile) -> Result<Observed, String> {
    let mut run = BoardRun::boot(board).map_err(|e| format!("boot: {e}"))?;
    let mut observed = Observed::default();
    // The nodes each fault named as its producer, over the whole run.
    let mut producers: BTreeSet<NodeId> = BTreeSet::new();
    // The nodes seen FAULTED, with the first tick.
    let mut faulted: BTreeMap<NodeId, u64> = BTreeMap::new();
    // The counters last read, per node.
    let mut counters: BTreeMap<NodeId, u64> = BTreeMap::new();

    let note = |observed: &mut Observed, producers: &mut BTreeSet<NodeId>, item: &Item, tick: u64| {
        if let Some(fault) = fault_in(item) {
            observed.reasons.entry(reason_name(&fault.reason)).or_insert(tick);
            producers.insert(fault.source);
        }
    };

    while !run.is_finished() {
        run.step().map_err(|e| format!("run: {e}"))?;
        let core = run.engine().core();
        let tick = core.tick;
        let ids: Vec<NodeId> = core.state.node_ids().collect();
        let (fault_belts, fault_ends) = fault_paths(&core.state, &ids);
        for &id in &ids {
            let fault_belt = fault_belts.contains(&id);
            if let Some(inbox) = core.state.inbox_of(id) {
                let carries_faults =
                    |port: PortId| fault_belt || port == FAULT_PORT || fault_ends.contains(&(id, port));
                for port in inbox.ports_sorted().filter(|&port| carries_faults(port)) {
                    for item in inbox.items_on(port) {
                        note(&mut observed, &mut producers, item, tick);
                    }
                }
            }
            match core.state.node(id) {
                Some(Node::Belt(belt)) if fault_belt => {
                    for item in belt.slots.iter().flatten() {
                        note(&mut observed, &mut producers, item, tick);
                    }
                }
                Some(Node::Factory(factory)) => {
                    for item in factory.pending_emits.get(&FAULT_PORT).into_iter().flatten() {
                        note(&mut observed, &mut producers, item, tick);
                    }
                    let before = counters.insert(id, factory.faults).unwrap_or(0);
                    if factory.faults > before {
                        observed.unread.push(format!(
                            "the Factory at {} raised its fault counter by {} on tick {tick}: a fault left \
                             with nothing docked on its Fault port, or it dropped an item, and neither \
                             carries a reason this test can read. Dock its Fault port to a Sink",
                            handle_of(&run, id),
                            factory.faults - before
                        ));
                    }
                }
                Some(Node::Router(router)) => {
                    let before = counters.insert(id, router.faults).unwrap_or(0);
                    if router.faults > before {
                        observed.reasons.entry(reason_name(&FaultReason::NoMatch)).or_insert(tick);
                        producers.insert(id);
                    }
                }
                Some(Node::Tee(tee)) => {
                    let before = counters.insert(id, tee.faults).unwrap_or(0);
                    if tee.faults > before {
                        let busy = FaultReason::BranchBusy { branch: Default::default() };
                        observed.reasons.entry(reason_name(&busy)).or_insert(tick);
                        producers.insert(id);
                    }
                }
                _ => {}
            }
            if derive_state(id, &core.last_tick, &core.state) == state_tag::FAULTED {
                faulted.entry(id).or_insert(tick);
            }
        }
    }
    for (&id, &tick) in &faulted {
        if !producers.contains(&id) {
            observed.unread.push(format!(
                "the node at {} turned FAULTED on tick {tick}, and this test read no fault it produced",
                handle_of(&run, id)
            ));
        }
    }
    Ok(observed)
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

/// Every fault reason name, from one sample of each variant.
fn known_reasons() -> BTreeSet<&'static str> {
    [
        FaultReason::NoMatch,
        FaultReason::FactoryError,
        FaultReason::FactoryTimeout,
        FaultReason::CommandTimeout,
        FaultReason::CommandFailure,
        FaultReason::WireOverflow,
        FaultReason::OutputRefused,
        FaultReason::NoEntryWire,
        FaultReason::BranchBusy { branch: Default::default() },
    ]
    .iter()
    .map(reason_name)
    .collect()
}

/// The manifest's lines as board path to reasons, and everything wrong with the text itself.
fn parse_manifest(text: &str) -> (BTreeMap<&str, Vec<&str>>, Vec<String>) {
    let known = known_reasons();
    let mut lines: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut problems = Vec::new();
    let mut previous: Option<&str> = None;
    for (index, line) in text.lines().enumerate() {
        let number = index + 1;
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(' ').collect();
        if fields.len() < 2 || fields.iter().any(|f| f.is_empty()) {
            problems.push(format!(
                "faults.manifest line {number} isn't a board path and its reasons, separated by single spaces: {line:?}"
            ));
            continue;
        }
        let (path, reasons) = (fields[0], fields[1..].to_vec());
        if previous.is_some_and(|p| p >= path) {
            problems.push(format!("faults.manifest line {number} ({path}) is out of order or repeats a board"));
        }
        previous = Some(path);
        for reason in &reasons {
            if !known.contains(reason) {
                problems.push(format!("faults.manifest line {number} names {reason:?}, which is no fault reason"));
            }
        }
        if reasons.windows(2).any(|w| w[0] >= w[1]) {
            problems.push(format!(
                "faults.manifest line {number} ({path}): list the reasons once each, in byte order"
            ));
        }
        lines.insert(path, reasons);
    }
    (lines, problems)
}

/// Everything wrong between what each board raised and the manifest.
fn compare(observed: &[(String, Result<Observed, String>)], manifest: &str) -> Vec<String> {
    let (lines, mut problems) = parse_manifest(manifest);
    if observed.len() < BOARD_FLOOR {
        problems.push(format!(
            "the walk found {} board(s) under {BOARDS_DIR}, and there are at least {BOARD_FLOOR}",
            observed.len()
        ));
    }
    for (path, result) in observed {
        let declared: BTreeSet<&str> = lines.get(path.as_str()).into_iter().flatten().copied().collect();
        let run = match result {
            Ok(run) => run,
            Err(e) => {
                problems.push(format!("{path}: {e}"));
                continue;
            }
        };
        for message in &run.unread {
            problems.push(format!("{path}: {message}"));
        }
        let read: BTreeSet<&str> = run.reasons.keys().copied().collect();
        if read != declared {
            let seen = run
                .reasons
                .iter()
                .map(|(reason, tick)| format!("{reason} (first on tick {tick})"))
                .collect::<Vec<_>>();
            let action = if read.is_empty() {
                format!("remove its line from {MANIFEST_PATH}")
            } else {
                format!(
                    "write the line \"{path} {}\" in {MANIFEST_PATH}",
                    read.iter().copied().collect::<Vec<_>>().join(" ")
                )
            };
            problems.push(format!(
                "{path}: the manifest says it raises [{}] and the run raised [{}]. If the run is right, \
                 {action}, and change faultsAbout on any page that shows the board",
                declared.iter().copied().collect::<Vec<_>>().join(" "),
                seen.join(", ")
            ));
        }
    }
    let walked: BTreeSet<&str> = observed.iter().map(|(path, _)| path.as_str()).collect();
    for path in lines.keys() {
        if !walked.contains(path) {
            problems.push(format!("{MANIFEST_PATH} has a line for {path}, which is no board under {BOARDS_DIR}"));
        }
    }
    problems
}

#[test]
fn every_board_raises_the_fault_reasons_its_manifest_line_names() {
    let manifest = fs::read_to_string(Path::new(REPO_ROOT).join(MANIFEST_PATH))
        .unwrap_or_else(|e| panic!("read {MANIFEST_PATH}: {e}"));
    let observed: Vec<(String, Result<Observed, String>)> =
        shipped_boards().into_iter().map(|(path, text)| (path, observe(&text))).collect();
    for (path, run) in &observed {
        if let Ok(run) = run {
            println!("BOARD_FAULTS {path} {:?}", run.reasons);
        }
    }
    let problems = compare(&observed, &manifest);
    assert!(problems.is_empty(), "the fault check found {} problem(s):\n{}", problems.len(), problems.join("\n"));
}

// The tests below build small boards to show the reading works, so a reader that stopped finding
// faults would fail here and not pass every board as fault-free.

/// A Source, a Factory running `source` and a Sink, one webhook at tick 40, end on tick 120. With
/// `fault_belt`, a belt carries the Factory's faults to a second Sink.
fn factory_board(source: &str, fault_belt: bool) -> String {
    let (place, belt, docks) = if fault_belt {
        (
            "        Place(kind: 7, cell_x: 11, cell_y: 5),\n",
            "        DrawBelt(cells: [(6, 4), (6, 5), (7, 5), (8, 5), (9, 5), (10, 5)]),\n",
            "        Dock(belt: 6, endpoint: Tail, node: 1, port: 2),\n        Dock(belt: 6, endpoint: Head, node: 3, port: 0),\n",
        )
    } else {
        ("", "", "")
    };
    // Without the fault belt the belts are handles 3 and 4; with it the second Sink takes 3.
    let (b1, b2) = if fault_belt { (4, 5) } else { (3, 4) };
    format!(
        r##"Board(
    format: 2,
    title: "One Factory",
    seed: 94,
    commands: [
        Place(kind: 0, cell_x: 1, cell_y: 2),
        Place(kind: 2, cell_x: 5, cell_y: 1),
        Place(kind: 7, cell_x: 11, cell_y: 2),
{place}        DrawBelt(cells: [(2, 2), (3, 2), (4, 2)]),
        DrawBelt(cells: [(8, 2), (9, 2), (10, 2)]),
{belt}        Dock(belt: {b1}, endpoint: Tail, node: 0, port: 0),
        Dock(belt: {b1}, endpoint: Head, node: 1, port: 0),
        Dock(belt: {b2}, endpoint: Tail, node: 1, port: 1),
        Dock(belt: {b2}, endpoint: Head, node: 2, port: 0),
{docks}        Configure(node: 1, config: Factory(source: r#"{source}"#)),
    ],
    script: [
        At(tick: 40, input: Webhook(source: 0, body: "{{}}")),
    ],
    captions: [],
    executor: Executor(default: Reply(after_ticks: 1), rules: []),
    view: View(fit: Board),
    end_tick: 120,
)
"##
    )
}

const THROWS: &str = r#"export default function (input, ctx) { throw new Error("no"); }"#;
const PASSES: &str = "export default function (input, ctx) { ctx.emit(0, input); }";

#[test]
fn a_factory_throw_on_a_fault_belt_reads_as_factory_error() {
    let run = observe(&factory_board(THROWS, true)).expect("runs");
    assert_eq!(run.reasons.keys().copied().collect::<Vec<_>>(), ["FactoryError"], "{run:?}");
    assert!(run.unread.is_empty(), "{:?}", run.unread);
}

#[test]
fn a_factory_throw_with_no_fault_belt_is_a_problem() {
    let run = observe(&factory_board(THROWS, false)).expect("runs");
    assert!(run.reasons.is_empty(), "{run:?}");
    assert!(run.unread.iter().any(|m| m.contains("handle 1")), "{:?}", run.unread);
}

#[test]
fn a_factory_that_passes_its_item_raises_nothing() {
    for fault_belt in [false, true] {
        let run = observe(&factory_board(PASSES, fault_belt)).expect("runs");
        assert!(run.reasons.is_empty() && run.unread.is_empty(), "{run:?}");
    }
}

/// A Source into a Router with no routes and no default output, so the item faults with NoMatch,
/// and nothing is docked on the Router's Fault port.
const ROUTER_NO_MATCH: &str = r#"Board(
    format: 2,
    title: "One Router",
    seed: 94,
    commands: [
        Place(kind: 0, cell_x: 1, cell_y: 2),
        Place(kind: 5, cell_x: 6, cell_y: 1),
        Place(kind: 7, cell_x: 9, cell_y: 2),
        DrawBelt(cells: [(2, 2), (3, 2), (4, 2), (5, 2)]),
        DrawBelt(cells: [(8, 2)]),
        Dock(belt: 3, endpoint: Tail, node: 0, port: 0),
        Dock(belt: 3, endpoint: Head, node: 1, port: 0),
        Dock(belt: 4, endpoint: Tail, node: 1, port: 1),
        Dock(belt: 4, endpoint: Head, node: 2, port: 0),
        Configure(node: 1, config: Router(routes: [], default: None)),
    ],
    script: [
        At(tick: 40, input: Webhook(source: 0, body: "{\"kind\":\"b\"}")),
    ],
    captions: [],
    executor: Executor(default: Reply(after_ticks: 1), rules: []),
    view: View(fit: Board),
    end_tick: 120,
)
"#;

#[test]
fn a_router_no_match_with_no_fault_belt_reads_as_no_match() {
    let run = observe(ROUTER_NO_MATCH).expect("runs");
    assert_eq!(run.reasons.keys().copied().collect::<Vec<_>>(), ["NoMatch"], "{run:?}");
    assert!(run.unread.is_empty(), "{:?}", run.unread);
}

/// A Source, a belt and a Sink, one webhook at tick 40, end on tick 120. The belt carries no faults.
const SOURCE_TO_SINK: &str = r#"Board(
    format: 2,
    title: "Source to Sink",
    seed: 94,
    commands: [
        Place(kind: 0, cell_x: 1, cell_y: 2),
        Place(kind: 7, cell_x: 5, cell_y: 2),
        DrawBelt(cells: [(2, 2), (3, 2), (4, 2)]),
        Dock(belt: 2, endpoint: Tail, node: 0, port: 0),
        Dock(belt: 2, endpoint: Head, node: 1, port: 0),
    ],
    script: [
        At(tick: 40, input: Webhook(source: 0, body: "{}")),
    ],
    captions: [],
    executor: Executor(default: Reply(after_ticks: 1), rules: []),
    view: View(fit: Board),
    end_tick: 120,
)
"#;

/// The bytes of a `NoMatch` fault naming the Source of [`SOURCE_TO_SINK`], built as the engine
/// builds one.
fn no_match_bytes(board: &BoardFile) -> Vec<u8> {
    let run = BoardRun::boot(board.clone()).expect("boots");
    Fault::no_match(run.minted()[0], Item(b"{}".to_vec())).encode().0
}

/// A webhook whose body is a well-formed fault rides an ordinary belt into a Sink. The belt
/// carries no faults, so the bytes are no fault and the Source they name is credited with nothing.
/// Reading every item's bytes would report a `NoMatch` here.
#[test]
fn fault_bytes_on_a_belt_that_carries_no_faults_are_no_fault() {
    let mut board = parse_board(SOURCE_TO_SINK).expect("parses");
    let body = no_match_bytes(&board);
    let Some(ScriptInput::Webhook { body: script_body, .. }) = board.script.first_mut().map(|e| &mut e.input) else {
        panic!("the board's first input is a webhook");
    };
    *script_body = String::from_utf8(body).expect("the fault's bytes are ASCII on this board");
    let run = observe_board(board).expect("runs");
    assert!(run.reasons.is_empty() && run.unread.is_empty(), "{run:?}");
}

/// Trailing bytes after a fault make the item no fault, since `Fault::decode` alone accepts them.
#[test]
fn a_fault_with_trailing_bytes_is_no_fault() {
    let bytes = no_match_bytes(&parse_board(SOURCE_TO_SINK).expect("parses"));
    assert!(fault_in(&Item(bytes.clone())).is_some(), "the fault itself reads");
    let mut longer = bytes;
    longer.extend_from_slice(b"{}");
    assert!(Fault::decode(&Item(longer.clone())).is_ok(), "postcard accepts trailing bytes");
    assert!(fault_in(&Item(longer)).is_none(), "fault_in refuses them");
}

const ONE_BOARD: &str = "examples/boards/a.board.ron";

fn clean_run() -> Result<Observed, String> {
    Ok(Observed::default())
}

fn run_with(reasons: &[&'static str]) -> Result<Observed, String> {
    Ok(Observed { reasons: reasons.iter().map(|r| (*r, 1)).collect(), unread: Vec::new() })
}

/// Five clean boards plus `extra`, for the comparison's own tests.
fn walk(extra: Vec<(String, Result<Observed, String>)>) -> Vec<(String, Result<Observed, String>)> {
    let mut boards: Vec<_> = (0..5).map(|i| (format!("examples/boards/z{i}.board.ron"), clean_run())).collect();
    boards.extend(extra);
    boards
}

#[test]
fn a_matching_manifest_passes() {
    let observed = walk(vec![(ONE_BOARD.to_owned(), run_with(&["CommandFailure", "CommandTimeout"]))]);
    let problems = compare(&observed, "# comment\nexamples/boards/a.board.ron CommandFailure CommandTimeout\n");
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn a_board_that_faults_with_no_line_fails() {
    let observed = walk(vec![(ONE_BOARD.to_owned(), run_with(&["NoMatch"]))]);
    let problems = compare(&observed, "");
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].contains("says it raises [] and the run raised [NoMatch"), "{problems:?}");
}

#[test]
fn a_line_naming_another_reason_fails() {
    let observed = walk(vec![(ONE_BOARD.to_owned(), run_with(&["FactoryError"]))]);
    let problems = compare(&observed, "examples/boards/a.board.ron NoMatch\n");
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].contains("says it raises [NoMatch] and the run raised [FactoryError"), "{problems:?}");
}

#[test]
fn a_line_for_a_board_that_raises_nothing_fails() {
    let observed = walk(vec![(ONE_BOARD.to_owned(), clean_run())]);
    let problems = compare(&observed, "examples/boards/a.board.ron NoMatch\n");
    assert_eq!(problems.len(), 1, "{problems:?}");
}

#[test]
fn a_bad_manifest_line_fails() {
    let observed = walk(Vec::new());
    for (text, expect) in [
        ("examples/boards/z0.board.ron\n", "separated by single spaces"),
        ("examples/boards/z0.board.ron Nope\n", "which is no fault reason"),
        ("examples/boards/z0.board.ron NoMatch FactoryError\n", "in byte order"),
        ("examples/boards/z1.board.ron NoMatch\nexamples/boards/z0.board.ron NoMatch\n", "out of order"),
        ("examples/boards/gone.board.ron NoMatch\n", "which is no board"),
    ] {
        let problems = compare(&observed, text);
        assert!(problems.iter().any(|p| p.contains(expect)), "{text:?}: {problems:?}");
    }
}

#[test]
fn an_unread_fault_fails() {
    let unread = Ok(Observed { reasons: BTreeMap::new(), unread: vec!["the node at handle 2 turned FAULTED".to_owned()] });
    let problems = compare(&walk(vec![(ONE_BOARD.to_owned(), unread)]), "");
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].contains("handle 2"), "{problems:?}");
}

#[test]
fn the_walk_fails_on_fewer_boards_than_the_floor() {
    let four: Vec<_> = (0..4).map(|i| (format!("b{i}"), clean_run())).collect();
    let problems = compare(&four, "");
    assert!(problems.iter().any(|p| p.contains("found 4 board(s)")), "{problems:?}");
}
