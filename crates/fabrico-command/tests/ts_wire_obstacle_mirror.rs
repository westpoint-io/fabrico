//! Phase 92 (CHROME-19, D-09, threat T-92-08): the obstacle stage's CROSS-LANGUAGE locks.
//!
//! # What this file holds
//! The landed cable (the host, through [`fabrico_command::is_wire_obstacle`] and
//! `wire_route_avoiding`) and the drag preview (`frontend/src/protocol/wireRoute.ts`,
//! through `isWireObstacle` and `wireRouteAvoiding`) must read ONE rule about which machines
//! a cable goes around and ONE cap on how many, or the preview promises a way round the
//! landed cable does not take. The values are locked here, one test per value:
//! - the crossable kinds: the TypeScript `WIRE_CROSSABLE_KINDS` that `isWireObstacle` reads,
//!   resolved through `frontend/src/protocol/kinds.ts`, equals the bytes for which
//!   [`fabrico_command::is_wire_obstacle`] is false, over every byte;
//! - the caps: the TypeScript `MAX_AROUND_NODES` and `MAX_CROWDED_CELLS` equal
//!   [`fabrico_command::MAX_AROUND_NODES`] and [`fabrico_command::MAX_CROWDED_CELLS`]
//!   (review fix pass 1 replaced the 64-machine cap);
//! - the two stage candidates: `CAND_AROUND_MACHINES` and `CAND_AROUND_CROWDED`;
//! - the line clamp: the TypeScript `WIRE_LINE_MIN` and `WIRE_LINE_MAX` equal
//!   `GRID_MIN - WIRE_LINE_GUARD` and `GRID_MAX + WIRE_LINE_GUARD` (review WR-A-01).
//!
//! `ts_bound_mirror.rs` locks one bound and says so in its header, so these live in their
//! own file and a red here always names an obstacle-stage mirror.
//!
//! # Why it panics instead of skipping
//! The `include_str!` plus named-anchor plus panic-on-miss idiom of `ts_label_mirror.rs`:
//! each anchor is written with its leading newline and indent so a mention inside a comment
//! cannot satisfy it, and an extractor that found nothing panics naming the anchor. An
//! extractor that returned nothing and let the comparison pass over it would be a green that
//! measured nothing.
//!
//! Run target: `cargo test -p fabrico-command --test ts_wire_obstacle_mirror`

use fabrico_command::command::{GRID_MAX, GRID_MIN};
use fabrico_command::{
    CAND_AROUND_CROWDED, CAND_AROUND_MACHINES, MAX_AROUND_NODES, MAX_CROWDED_CELLS,
    WIRE_LINE_GUARD, is_wire_obstacle,
};

/// The TypeScript router, embedded at COMPILE time: a moved file is a compile error here.
const WIRE_ROUTE_TS: &str = include_str!("../../../frontend/src/protocol/wireRoute.ts");

/// The frontend kind table, embedded at COMPILE time.
const KINDS_TS: &str = include_str!("../../../frontend/src/protocol/kinds.ts");

/// The crossable-kind list `isWireObstacle` reads.
const CROSSABLE_ANCHOR: &str = "\nconst WIRE_CROSSABLE_KINDS: readonly number[] = [";

/// `isWireObstacle` itself, whole: it reads the list above and nothing else. A body that
/// grew a second rule would no longer match, and this file would say so.
const PREDICATE_ANCHOR: &str = "\nexport function isWireObstacle(kind: number): boolean {\n  return !WIRE_CROSSABLE_KINDS.includes(kind);\n}\n";

/// The caps.
const NODES_ANCHOR: &str = "\nexport const MAX_AROUND_NODES = ";
const CELLS_ANCHOR: &str = "\nexport const MAX_CROWDED_CELLS = ";

/// The two stage candidates.
const CAND_AROUND_ANCHOR: &str = "\nexport const CAND_AROUND_MACHINES = ";
const CAND_CROWDED_ANCHOR: &str = "\nexport const CAND_AROUND_CROWDED = ";

/// The line clamp.
const LINE_MIN_ANCHOR: &str = "\nconst WIRE_LINE_MIN = ";
const LINE_MAX_ANCHOR: &str = "\nconst WIRE_LINE_MAX = ";

/// The integer literal after `anchor` in `src`, up to `;`. PANICS on a missing anchor, an
/// unterminated declaration or a value that is not a plain integer.
fn ts_int(src: &str, file: &str, anchor: &str) -> i64 {
    let start = src.find(anchor).unwrap_or_else(|| {
        panic!("{file} no longer declares {anchor:?}: the lock cannot see the mirror and must not pass silently")
    });
    let rest = &src[start + anchor.len()..];
    let end = rest
        .find(';')
        .unwrap_or_else(|| panic!("{anchor:?} in {file} is not terminated by `;`"));
    rest[..end].trim().parse::<i64>().unwrap_or_else(|_| {
        panic!("{anchor:?} in {file} is not a plain integer literal (found {:?})", rest[..end].trim())
    })
}

/// The kind byte `kinds.ts` gives `name`. PANICS when the name is not a `machine_kind` entry.
fn ts_kind_byte(name: &str) -> u8 {
    let anchor = format!("\n  {name}: ");
    let start = KINDS_TS.find(&anchor).unwrap_or_else(|| {
        panic!("frontend/src/protocol/kinds.ts has no machine_kind entry {anchor:?}")
    });
    let rest = &KINDS_TS[start + anchor.len()..];
    let end = rest
        .find(',')
        .unwrap_or_else(|| panic!("the {name} entry in kinds.ts is not terminated by `,`"));
    rest[..end]
        .trim()
        .parse::<u8>()
        .unwrap_or_else(|_| panic!("the {name} entry in kinds.ts is not a plain byte"))
}

/// The bytes the TypeScript side lets a cable cross, sorted. Each element is a
/// `machine_kind.NAME` resolved through `kinds.ts`, or a plain byte literal. PANICS on a
/// missing anchor, an unclosed list, an element of any other form, or an empty list.
fn ts_crossable_bytes() -> Vec<u8> {
    assert!(
        WIRE_ROUTE_TS.contains(PREDICATE_ANCHOR),
        "frontend/src/protocol/wireRoute.ts no longer declares isWireObstacle as the one-line \
         read of WIRE_CROSSABLE_KINDS ({PREDICATE_ANCHOR:?}): the crossable-kind lock would no \
         longer be reading the rule the preview runs"
    );
    let start = WIRE_ROUTE_TS.find(CROSSABLE_ANCHOR).unwrap_or_else(|| {
        panic!(
            "frontend/src/protocol/wireRoute.ts no longer declares {CROSSABLE_ANCHOR:?}: the \
             crossable-kind lock cannot see the mirror and must not pass silently"
        )
    });
    let rest = &WIRE_ROUTE_TS[start + CROSSABLE_ANCHOR.len()..];
    let end = rest
        .find(']')
        .unwrap_or_else(|| panic!("WIRE_CROSSABLE_KINDS in wireRoute.ts is never closed by `]`"));
    let mut bytes: Vec<u8> = rest[..end]
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| match e.strip_prefix("machine_kind.") {
            Some(name) => ts_kind_byte(name),
            None => e.parse::<u8>().unwrap_or_else(|_| {
                panic!("WIRE_CROSSABLE_KINDS element {e:?} is neither machine_kind.NAME nor a byte")
            }),
        })
        .collect();
    assert!(!bytes.is_empty(), "WIRE_CROSSABLE_KINDS in wireRoute.ts is empty");
    bytes.sort_unstable();
    bytes
}

#[test]
fn the_typescript_crossable_set_equals_the_rust_rule() {
    let rust: Vec<u8> = (0..=u8::MAX).filter(|&b| !is_wire_obstacle(b)).collect();
    let ts = ts_crossable_bytes();
    assert_eq!(
        ts, rust,
        "frontend/src/protocol/wireRoute.ts lets a cable cross kind bytes {ts:?}, but \
         fabrico_command::is_wire_obstacle lets it cross {rust:?}: the preview and the landed \
         cable would go round different machines"
    );
}

#[test]
fn the_typescript_caps_equal_the_rust_caps() {
    let file = "frontend/src/protocol/wireRoute.ts";
    assert_eq!(
        (ts_int(WIRE_ROUTE_TS, file, NODES_ANCHOR), ts_int(WIRE_ROUTE_TS, file, CELLS_ANCHOR)),
        (i64::try_from(MAX_AROUND_NODES).expect("the cap fits"), MAX_CROWDED_CELLS),
        "{file} mirrors MAX_AROUND_NODES and MAX_CROWDED_CELLS with other values than \
         fabrico_command's {MAX_AROUND_NODES} and {MAX_CROWDED_CELLS}: the preview would choose \
         another search than the landed cable"
    );
}

#[test]
fn the_typescript_stage_candidates_equal_the_rust_ones() {
    let file = "frontend/src/protocol/wireRoute.ts";
    assert_eq!(
        (ts_int(WIRE_ROUTE_TS, file, CAND_AROUND_ANCHOR), ts_int(WIRE_ROUTE_TS, file, CAND_CROWDED_ANCHOR)),
        (i64::from(CAND_AROUND_MACHINES), i64::from(CAND_AROUND_CROWDED)),
        "{file} numbers the stage's two candidates differently from fabrico_command"
    );
}

#[test]
fn the_typescript_line_clamp_equals_the_rust_line_guard() {
    let file = "frontend/src/protocol/wireRoute.ts";
    assert_eq!(
        (
            ts_int(WIRE_ROUTE_TS, file, LINE_MIN_ANCHOR),
            ts_int(WIRE_ROUTE_TS, file, LINE_MAX_ANCHOR)
        ),
        (i64::from(GRID_MIN - WIRE_LINE_GUARD), i64::from(GRID_MAX + WIRE_LINE_GUARD)),
        "the TS obstacle stage clamps its lines to other bounds than the Rust line guard"
    );
}
