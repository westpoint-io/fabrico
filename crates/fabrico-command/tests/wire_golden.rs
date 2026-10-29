//! The `wire` cross-language geometry golden fixture — the contract anchor between the
//! Rust electrical-wire auto-router [`wire_route`] and the future hand-rolled TypeScript
//! wire mirror (40-03) that draws the cable + its electrical nub terminals. It freezes
//! the exact `(from_dock, to_dock) -> WireGeometry` mapping (the two integer terminal
//! anchors + the `route()`-normalized orthogonal cell path) so the TS renderer produces
//! shape-identical geometry and the drawn cable == the model CROSS-LANGUAGE (WUI-01
//! criterion 4).
//!
//! This is a SEPARATE artifact from the `route` fixture (which pins the belt tile
//! geometry): `wire` pins the wire-SPECIFIC surface `route()` does not cover — the
//! endpoint->endpoint auto-route AND the electrical terminal anchors. Wire corners
//! themselves INHERIT the `route` parity (wire_route feeds its path through `route()`).
//!
//! Two parts, mirroring the `route_golden.rs` freezer discipline verbatim:
//!   - [`freeze_wire`] (`#[ignore]`d) is the ONLY writer: it postcard-encodes the known
//!     [`fixture_geometry`] to `tests/fixtures/wire.bin` and the same value as pretty
//!     JSON to `tests/fixtures/wire.expected.json`. `cargo test` NEVER runs it, so the
//!     fixture is never silently regenerated; blessing is an explicit, reviewed act:
//!     `cargo test -p fabrico-command freeze_wire -- --ignored`
//!   - [`wire_matches_frozen`] (always runs) re-routes the same docks and asserts the
//!     encoding equals the committed `.bin` bytes — so any drift in `wire_route()`'s
//!     geometry FAILS CI instead of silently re-blessing.
//!
//! Cross-language consumer: a future TS `wireRoute.test.ts` (40-03) reads
//! `crates/fabrico-command/tests/fixtures/wire.bin` (or the `.expected.json`) via a
//! relative path and asserts its wire mirror produces shape-identical geometry. The
//! `.bin` is the byte truth; the `.json` is the human/TS-readable expected object.
//!
//! # The side-aware sibling (plan 75-02, CABLE-04)
//! `tests/fixtures/wire_side_aware.expected.json` sits beside this golden and is NOT one
//! of its outputs: it is HAND-WRITTEN, no freezer writes or rewrites it, and its three
//! cables were derived on paper by the side-aware rule (leave one cell along the source
//! normal, end one cell before the target against its normal, and between those take the
//! shortest, then fewest-bend path, going straight as long as optimal and otherwise turning
//! in the order N, E, S, W). The rule is also carried in the file's own `note` field, since
//! JSON has no comments. `wire.bin` and `wire.expected.json` stay exactly as they were
//! (D-06). [`side_aware_cases_match_the_hand_written_literals`] asserts the router
//! reproduces each; `frontend/src/protocol/wireRoute.test.ts` asserts the same of the
//! TypeScript mirror from the same file.
//!
//! A golden blessed from the implementation agrees with it by construction, so
//! [`every_frozen_case_outside_the_degenerate_list_is_head_on`] adds a PROPERTY that
//! survives any future re-bless: every case in BOTH fixture files, unless the shared
//! degenerate list in `tests/common/mod.rs` admits it, is head-on at both prongs in its
//! frozen cells and in the cells the router produces for it today.
//!
//! `fabrico-command`'s `deps_are_headless` fence bans renderer/IO/host deps from the
//! NORMAL tree only; this freezer legitimately needs `std::fs`, so it carries the same
//! file-scoped escape `route_golden.rs` uses — SCOPED to this one test file.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

mod common;

use common::{admitted, end_steps, inward};
use fabrico_command::wire_route::normal;
use fabrico_command::{WireBody, WireDock, WireGeometry, wire_route};

/// Absolute path to the frozen postcard bytes (resolved at compile time so the test is
/// CWD-independent).
const BIN_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/wire.bin");
/// Absolute path to the human/TS-readable expected JSON sibling.
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wire.expected.json"
);
/// Absolute path to the HAND-WRITTEN side-aware cases (plan 75-02, CABLE-04). No freezer
/// in this repository writes it.
const SIDE_AWARE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wire_side_aware.expected.json"
);

// Side numbering (mirror core `Side`): N=0, E=1, S=2, W=3.
const N: u8 = 0;
const E: u8 = 1;

/// The known, deterministic wire the golden freezes: the canonical L cable from an
/// electrical terminal at cell `(0,0)` facing EAST to one at cell `(1,1)` facing NORTH.
/// The cable leaves (0,0) eastward, bends south, and enters (1,1) from the north — the
/// exact L the belt `route` fixture pins, plus the two electrical nub anchors:
///   - tile 0 `(0,0)` = `Straight { axis: X }`   (leave the E-facing terminal)
///   - tile 1 `(1,0)` = `Corner   { from: E, to: S }` (the single bend)
///   - tile 2 `(1,1)` = `Straight { axis: Y }`   (enter the N-facing terminal)
///   - from_anchor = { (0,0), side E },  to_anchor = { (1,1), side N }
fn fixture_geometry() -> WireGeometry {
    wire_route(
        // Type-only touch, 72-16: `WireDock` gained a resolved body rectangle. This pair
        // has `leave_x` true, so the perimeter ring DECLINES it at D2 and the tiles are
        // identical. `wire_matches_frozen` below must stay GREEN; red there is unintended
        // drift, and `freeze_wire` must NOT be run.
        WireDock {
            cell: (0, 0),
            side: E,
            body: WireBody {
                min_x: 0,
                min_y: 0,
                max_x: 0,
                max_y: 0,
            },
        },
        WireDock {
            cell: (1, 1),
            side: N,
            body: WireBody {
                min_x: 1,
                min_y: 1,
                max_x: 1,
                max_y: 1,
            },
        },
    )
    .expect("the canonical wire L auto-routes (straight + corner + straight + two anchors)")
}

/// FREEZER — `#[ignore]`d so `cargo test` never runs it. Run explicitly to (re)bless the
/// fixture, then COMMIT the produced `.bin` + `.expected.json`:
///   `cargo test -p fabrico-command freeze_wire -- --ignored`
#[test]
#[ignore = "explicit golden freezer; writes the committed wire fixture"]
fn freeze_wire() {
    let geometry = fixture_geometry();

    let bytes = postcard::to_allocvec(&geometry).expect("encode wire fixture");
    let json = serde_json::to_string_pretty(&geometry).expect("pretty-json wire fixture");

    let dir = std::path::Path::new(BIN_PATH)
        .parent()
        .expect("fixture path has a parent dir");
    std::fs::create_dir_all(dir).expect("create fixtures dir");
    std::fs::write(BIN_PATH, &bytes).expect("write wire .bin");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write wire .expected.json");
}

/// GUARD — always runs. Re-routes the same docks and asserts byte-equality with the
/// committed fixture; any geometry drift fails here rather than silently regenerating.
#[test]
fn wire_matches_frozen() {
    let bytes = postcard::to_allocvec(&fixture_geometry()).expect("encode wire fixture");
    let frozen = std::fs::read(BIN_PATH)
        .expect("wire fixture committed; run `freeze_wire -- --ignored` to bless it");
    assert_eq!(
        bytes, frozen,
        "wire_route() geometry drifted from the frozen bytes — re-bless deliberately, never silently",
    );
}

/// One hand-written side-aware case: the two docks and the expected cells, source first.
#[derive(serde::Deserialize, Debug)]
struct SideAwareCase {
    /// What the case exercises, for messages.
    name: String,
    /// The source dock.
    from: WireDock,
    /// The target dock.
    to: WireDock,
    /// The expected cable cells, source dock first, target dock last.
    cells: Vec<(i32, i32)>,
}

/// Read the hand-written side-aware cases.
fn side_aware_cases() -> Vec<SideAwareCase> {
    serde_json::from_str(
        &std::fs::read_to_string(SIDE_AWARE_PATH)
            .expect("the hand-written side-aware fixture is committed"),
    )
    .expect("the hand-written side-aware fixture parses")
}

/// The cells `wire_route` produces for `(from, to)`.
fn routed_cells(from: WireDock, to: WireDock) -> Vec<(i32, i32)> {
    wire_route(from, to)
        .unwrap_or_else(|e| panic!("wire_route refused {from:?} -> {to:?}: {e:?}"))
        .tiles
        .iter()
        .map(|t| t.cell)
        .collect()
}

/// CABLE-04: the router reproduces each of the three HAND-WRITTEN side-aware cables cell
/// for cell (an N-facing source across columns, a W-facing target across rows, and a
/// cornered pair into an E-facing target). Each was red against the router before phase
/// 75; the cells it produced then are recorded in `75-02-SUMMARY.md`.
#[test]
fn side_aware_cases_match_the_hand_written_literals() {
    let cases = side_aware_cases();
    assert_eq!(
        cases.len(),
        3,
        "CABLE-04 names exactly three hand-written cables"
    );
    let mut failures = Vec::new();
    for case in &cases {
        let got = routed_cells(case.from, case.to);
        if got != case.cells {
            failures.push(format!(
                "{}: routed {got:?}, hand-written {:?}",
                case.name, case.cells
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} hand-written side-aware cables are not reproduced:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// The `wire.expected.json` case as docks. `fixture_geometry` routes 1x1 machines, so each
/// body is its anchor's own cell.
fn frozen_wire_case() -> (WireDock, WireDock, Vec<(i32, i32)>) {
    let g: WireGeometry = serde_json::from_str(
        &std::fs::read_to_string(JSON_PATH).expect("wire.expected.json is committed"),
    )
    .expect("wire.expected.json parses");
    let one = |a: fabrico_command::WireAnchor| WireDock {
        cell: (a.cell_x, a.cell_y),
        side: a.side,
        body: WireBody {
            min_x: a.cell_x,
            min_y: a.cell_y,
            max_x: a.cell_x,
            max_y: a.cell_y,
        },
    };
    let cells = g.tiles.iter().map(|t| t.cell).collect();
    (one(g.from_anchor), one(g.to_anchor), cells)
}

/// One frozen case from either fixture file: its name, docks and frozen cells.
type FrozenCase = (String, WireDock, WireDock, Vec<(i32, i32)>);

/// The PROPERTY that survives a re-bless (CABLE-04): every frozen case in BOTH fixture
/// files that the shared degenerate list (`common::admitted`: P1, P2, P3a, P3b) does not
/// admit is head-on at both prongs: first step `normal(from.side)`, last step its negation
/// for `to.side`. Checked on the FROZEN cells and on the cells the router produces for the
/// same docks today, so neither a re-blessed golden nor a changed router can carry a cable
/// that leaves the wrong way.
#[test]
fn every_frozen_case_outside_the_degenerate_list_is_head_on() {
    let mut cases: Vec<FrozenCase> = Vec::new();
    let (from, to, cells) = frozen_wire_case();
    cases.push(("wire.expected.json".to_owned(), from, to, cells));
    for c in side_aware_cases() {
        cases.push((c.name, c.from, c.to, c.cells));
    }
    let mut checked = 0usize;
    let mut failures = Vec::new();
    for (name, from, to, frozen) in &cases {
        if let Some(shape) = admitted(*from, *to) {
            println!("{name}: admitted as {shape}, not graded");
            continue;
        }
        checked += 1;
        for (which, cells) in [
            ("frozen", frozen.clone()),
            ("routed", routed_cells(*from, *to)),
        ] {
            if cells.len() < 2 {
                failures.push(format!("{name} ({which}): fewer than two cells {cells:?}"));
                continue;
            }
            let (first, last) = end_steps(&cells);
            if first != normal(from.side) || last != inward(to.side) {
                failures.push(format!(
                    "{name} ({which}): first {first:?} (want {:?}), last {last:?} (want {:?}); \
                     cells {cells:?}",
                    normal(from.side),
                    inward(to.side)
                ));
            }
        }
    }
    assert_eq!(
        checked, 4,
        "all four frozen cases are outside the degenerate list"
    );
    assert!(
        failures.is_empty(),
        "{} frozen or routed cables are not head-on at both prongs:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
