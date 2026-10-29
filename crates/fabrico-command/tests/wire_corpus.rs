//! The `wire_corpus` cross-language PARITY corpus for the wire auto-router.
//!
//! # Why this exists, and why it had to ship in the same commit as the router
//! Until phase 72 plan 15 the auto-router was an eight-line monotone walk with nothing in
//! it to get wrong, and one frozen dock pair (`wire.bin`, `wire_golden.rs`) was honest
//! coverage for it. Plan 15 replaced that walk with four admissibility booleans, two Z
//! branches and a four-way selector, HAND-MIRRORED into TypeScript at
//! `frontend/src/protocol/wireRoute.ts`. Plan 16 then put a union-box perimeter RING in
//! front of both, hand-mirrored the same way.
//!
//! **The old golden cannot see any of that.** Its single dock pair `(0,0)E -> (1,1)N`
//! selects the plain X-first arm, so it exercises neither Z branch, nor the selector, nor
//! the ring. One transposed component in the TS copy would leave the drag ghost promising a
//! corridor the landed cable does not take, and it would pass `cargo test`, `tsc` and
//! `vitest` in both trees while looking correct on every board where the two shapes happen
//! to agree. A check that cannot fail on the thing being changed is this repository's
//! signature defect class; it was found twice in phase 72's own walk document, in the very
//! claim this router was rejected against.
//!
//! # The corpus
//! 5 machine-shape pairs x 4 source sides x 4 target sides x target offsets `dx, dy` in
//! `[-3..3]`, with the source dock fixed at the origin = **3920 dock pairs**. The offset
//! range covers, for both axes: the coincident case (`0`), the abutting case the Z's room
//! guard refuses (`+/-1`), and cases with room to jog (`+/-2`, `+/-3`) in both directions.
//! Every one of the four booleans is exercised true and false, both Z branches fire, all
//! five selector arms are reached, and the ring fires on the all-four-false rows.
//!
//! ## Why the SHAPE axis is five-way and not two
//! The router reads a resolved body rectangle per end (`WireBody`). MEASURED at design
//! time: with only `[(1x1, 1x1), (3x3, 1x1)]` the `to.body` term is DEAD, affecting 0 of
//! 504 firing rows, because a 1x1 target body equals its own dock cell, which the ring's
//! Step 1 already folds into K. A TS mirror that forgot `to.body` entirely would pass every
//! row. With the four-way axis it is live in 232 of 1008 firing rows. The fifth pair is
//! NON-SQUARE with the two ends' axes exchanged (`3x1` against `1x3`): it is the only thing
//! in the sweep that can ever see a `w`/`h` transposition, at either end, or a `from.body`
//! and `to.body` swap.
//!
//! Bodies are placed so the dock sits CENTRED on the face its `side` names, and the
//! RESOLVED rectangle is written into the row, so the TS reader parses 14 numbers and
//! derives nothing. There is no `rot` decode in this file and there must never be one: the
//! whole reason the router takes a resolved rectangle is that a `rot` decode would be a
//! drift surface the corpus supplies data past.
//!
//! ## OVERLAPPING BODIES ARE GENERATED, DELIBERATELY, AND THEY ARE NON-PHYSICAL BOARDS
//! At close offsets a 3x3 source body and a 3x3 target body intersect. No real board can
//! hold two machines like that. Those rows are kept because the ring's VALIDITY argument
//! never uses box disjointness, so they are honest coverage of the emitted geometry. What
//! does NOT hold on them is the separate VISUAL claim that the cable touches no body cell
//! but the two port cells. A reader hitting a row whose cable crosses a body has found that
//! documented case, not a bug.
//!
//! # Two parts, mirroring `wire_golden.rs`'s freezer discipline verbatim
//!   - [`freeze_wire_corpus`] (`#[ignore]`d) is the ONLY writer. `cargo test` never runs
//!     it, so the fixture is never silently regenerated:
//!     `cargo test -p fabrico-command freeze_wire_corpus -- --ignored`
//!   - [`wire_corpus_matches_frozen`] (always runs) re-routes all 3920 and asserts equality
//!     with the committed JSON, so geometry drift FAILS rather than re-blessing itself.
//!
//! # The `cand` column, which is the point of the 72-16 revision
//! `wire_route`'s ladder does `if let Ok(tiles) = route(&cells)` on the ring candidate and
//! SWALLOWS the `Err`. Correct for the runtime, and a hole in every gate that reads only
//! the emitted tiles: one transposed sign in `ring_index` makes the ring emit invalid paths
//! for every all-four-false pair, the ladder falls through silently, the fallback geometry
//! is blessed into this fixture in BOTH languages, [`wire_corpus_matches_frozen`] then
//! compares that fixture against itself, and all five project gates go green over a broken
//! picture. [`every_corpus_path_is_route_valid`] does not save it either: it judges each
//! CANDIDATE's emitted path directly, which sees a candidate `route()` refuses but not the
//! ladder settling for a later arm afterwards. (Until 2026-09-04 that sentence read "read
//! it, it asserts a row count and a non-empty tile list", which was accurate and is the
//! reason the phase 72 vacuity sweep pulled that test out; it is corrected here rather
//! than left standing against a test that has since been given its own property.)
//!
//! What closes the hole is `CorpusRow.cand`, frozen into the fixture and read by both
//! languages, recording WHICH candidate won. A fall-through is then a diff. It is read
//! from `wire_route_traced`, the real ladder, and never re-derived here: a restated ladder
//! agrees with itself by construction and would go green on exactly the fall-through it
//! exists to catch.
//!
//! Cross-language consumer: `frontend/src/protocol/wireRoute.test.ts` reads this SAME
//! JSON by relative path (the mechanism it already uses for `wire.expected.json`) and
//! asserts its mirror is tile-for-tile identical AND that its `perimeterCells` fires on
//! exactly the `cand == 0` rows.
//!
//! `fabrico-command`'s `deps_are_headless` fence bans renderer/IO/host deps from the
//! NORMAL tree only; this freezer legitimately needs `std::fs`, so it carries the same
//! file-scoped escape `wire_golden.rs` and `route_golden.rs` use.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs; the freeze step is #[ignore]d.

mod common;

use common::{brute_force_route, brute_force_route_relaxed, in_rect, place_body};
use fabrico_command::route::route;
use fabrico_command::wire_route::{
    clear_of_bodies_search, face_aligned_cells, go_around_search, normal, perimeter_cells,
};
use fabrico_command::{
    CAND_CLEAR_OF_BODIES, CAND_FACE_ALIGNED, CAND_GO_AROUND, CAND_NONE, CAND_PERIMETER,
    WireBody, WireDock, WireRouteError, wire_route_traced,
};

/// Absolute path to the frozen corpus (resolved at compile time so the test is
/// CWD-independent).
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wire_corpus.expected.json"
);

/// The offsets applied to the target cell, source fixed at the origin. Covers coincident
/// (`0`), abutting (`+/-1`, where the Z room guard refuses and the selector must keep the
/// ARRIVAL face) and roomy (`+/-2`, `+/-3`) on both axes and both directions.
const OFFSETS: [i32; 7] = [-3, -2, -1, 0, 1, 2, 3];

/// The machine-shape axis: `(source (w, h), target (w, h))`, RESOLVED extents with any
/// rotation already applied. See the module docblock for why it is five-way: the first two
/// pairs alone leave `to.body` dead, and the fifth pair is the only non-square one.
const SHAPES: [((i32, i32), (i32, i32)); 5] = [
    ((1, 1), (1, 1)),
    ((3, 3), (1, 1)),
    ((1, 1), (3, 3)),
    ((3, 3), (3, 3)),
    ((3, 1), (1, 3)),
];

/// The expected number of rows whose winning candidate is the perimeter ring, pinned so a
/// sweep that quietly stops reaching the ring is a red rather than a smaller number nobody
/// reads. See [`the_ring_wins_on_exactly_the_frozen_rows`].
const FROZEN_PERIMETER_ROWS: usize = 1260;

/// The number of frozen rows whose emitted path DEPENDS on `to.body`, pinned for exactly
/// the reason [`FROZEN_PERIMETER_ROWS`] is pinned: a sweep that quietly narrows until one
/// row still depends on it is a red, not a smaller number nobody reads. See
/// [`the_target_body_is_live_in_the_sweep`], which asserted `live > 0` until 2026-09-04
/// (phase 72 review WR-02) while its own docblock named a measured figure.
///
/// MEASURED on the shipped five-way sweep: 300 of the 1260 rows the ring fires on. The
/// module docblock's "232 of 1008" is the DESIGN-TIME measurement on the FOUR-way axis and
/// is left standing as the history it is; this constant is the current sweep. Re-measure
/// and re-bless deliberately if `SHAPES` or `OFFSETS` moves.
const FROZEN_TO_BODY_LIVE_ROWS: usize = 300;

/// The number of frozen rows the GO-AROUND won (75-01, `cand == 3`), pinned for the reason
/// [`FROZEN_PERIMETER_ROWS`] is: the go-around arm's `if let Ok` swallows a `route()`
/// rejection exactly as the ring arm's does, so a search that quietly broke would move
/// every one of these rows to the face-aligned shape and show up only as a smaller number
/// nobody reads. See [`the_go_around_wins_on_exactly_the_frozen_rows`].
///
/// MEASURED at the 75-01 re-bless: 1440, exactly the number 75-RESEARCH predicted from an
/// independent Python port (per shape group 360, 280, 280, 208, 312). Every one of them is
/// a row whose tiles changed at that re-bless, and no other row's tiles changed.
///
/// OBSERVED REDDENING: removing the finish bend penalty from the search (every arrival
/// heading costs nothing) reddens the gate below with `the fixture says the go-around WON
/// on docks [0, 0, 0, 0, 0, 0, 0, -3, -3, 0, -3, -3, -3, -3], so its search must find a
/// path on them`.
const FROZEN_GO_AROUND_ROWS: usize = 1440;

/// The go-around rows whose path CHANGES when `to.body` is flattened to its dock cell,
/// the go-around's sibling of [`FROZEN_TO_BODY_LIVE_ROWS`]: a TS mirror that dropped
/// `to.body` from its line set or its blocked set would pass every other row. See
/// [`the_go_around_reads_to_body_on_exactly_the_frozen_rows`]. MEASURED 200, as predicted.
///
/// OBSERVED REDDENING: dropping `to.body` from the search's blocked set reddens it with
/// `to.body was live on 200 go-around rows`; dropping the two `to.body` edge lines from the
/// line set reddens it the same way.
const FROZEN_GO_AROUND_TO_BODY_LIVE_ROWS: usize = 200;

/// The same for `from.body`. See
/// [`the_go_around_reads_from_body_on_exactly_the_frozen_rows`]. MEASURED 104, as
/// predicted. OBSERVED REDDENING: dropping the two `from.body` edge lines from the line set
/// reddens it with `from.body was live on 104 go-around rows`.
const FROZEN_GO_AROUND_FROM_BODY_LIVE_ROWS: usize = 104;

/// The number of frozen rows candidate 4, CLEAR OF BODIES (75-03, D-04), won: a port
/// facing straight into the neighbour's body, drawn as the shortest connection crossing
/// neither machine. Pinned for the reason [`FROZEN_GO_AROUND_ROWS`] is: its arm's `if let
/// Ok` swallows a `route()` rejection, so a broken search would move these rows to the
/// face-aligned shape and show only as a smaller number. See
/// [`the_clear_of_bodies_candidate_wins_on_exactly_the_frozen_rows`].
///
/// MEASURED at the 75-03 re-bless: 208, exactly the number 75-RESEARCH predicted from an
/// independent Python port (per shape group 0, 80, 80, 0, 48). 196 of them changed tiles
/// at that re-bless; 12 kept their tiles and changed only `cand` (the face-aligned shape
/// already was the shortest body-clear connection there). No other row changed.
const FROZEN_CLEAR_OF_BODIES_ROWS: usize = 208;

/// The rows the router REFUSES (75-03, D-05): the coincident ones, 5 shape pairs x 16
/// side pairs at offset `(0, 0)`. Each carries `err: "Coincident"`, empty `tiles` and
/// `cand == CAND_NONE`; see [`every_corpus_path_is_route_valid`].
const FROZEN_ERROR_ROWS: usize = 80;

/// The one-face rows with both stub cells free on which the go-around search, run
/// DIRECTLY, finds no path in its line set, so the ladder correctly served the
/// face-aligned shape. Pinned so that number cannot grow in silence. See G3.
const FROZEN_ONE_FACE_SEARCH_DECLINED_ROWS: usize = 0;

// `place_body`, the corpus's placement rule, lives in `tests/common/mod.rs` since plan
// 75-02, moved there verbatim so the physical sweep in `wire_side_aware.rs` places bodies
// by the same rule rather than a copy of it.

/// One corpus row, serialized as plain data so the TS mirror can read it without knowing
/// any Rust type. The tile kind is flattened to the same numeric encoding `decode.ts`
/// carries (axis `X=0`/`Y=1`, dir `N=0 E=1 S=2 W=3`) rather than serde's string enums, so
/// the TS side needs no enum mapping table that could itself drift.
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq, Debug)]
struct CorpusRow {
    /// `[from_x, from_y, from_side, from_body_min_x, from_body_min_y, from_body_max_x,
    /// from_body_max_y, to_x, to_y, to_side, to_body_min_x, to_body_min_y, to_body_max_x,
    /// to_body_max_y]`. RESOLVED rectangles: the TS reader derives nothing.
    docks: [i32; 14],
    /// WHICH CANDIDATE WON: `0` perimeter ring, `1` face-aligned, `2` Manhattan L, `3`
    /// go-around, or `CAND_NONE` (255) on a row the router refused. Read from the real
    /// ladder via `wire_route_traced`. This column is what makes a silent fall-through a
    /// diff; see the module docblock. Do not delete it and do not weaken it to an
    /// assertion over the emitted tiles.
    cand: u8,
    /// THE ROUTER'S REFUSAL, on the rows it refused (75-03, D-05): the `WireRouteError`
    /// variant's name, today only `"Coincident"`, on the 80 rows whose two docks share a
    /// cell; those rows carry empty `tiles` and `cand == CAND_NONE`. SERIALISED ONLY WHEN
    /// PRESENT, so adding it changed no other row's bytes. Read by both languages: the TS
    /// mirror must refuse exactly these rows with the same name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    err: Option<String>,
    /// One `[cell_x, cell_y, kind, a, b]` per tile. `kind` is `0` for Straight (with `a`
    /// the axis and `b` `-1`) and `1` for Corner (with `a` the `from` dir and `b` the
    /// `to` dir).
    tiles: Vec<[i32; 5]>,
}

/// The two docks a corpus row describes, rebuilt from its own frozen numbers.
///
/// The gates below route from THESE rather than from the sweep, so a gate reads what the
/// fixture actually says instead of what the generator would say today.
fn docks_of(row: &CorpusRow) -> (WireDock, WireDock) {
    let d = row.docks;
    let from = WireDock {
        cell: (d[0], d[1]),
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        side: d[2] as u8,
        body: WireBody {
            min_x: d[3],
            min_y: d[4],
            max_x: d[5],
            max_y: d[6],
        },
    };
    let to = WireDock {
        cell: (d[7], d[8]),
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        side: d[9] as u8,
        body: WireBody {
            min_x: d[10],
            min_y: d[11],
            max_x: d[12],
            max_y: d[13],
        },
    };
    (from, to)
}

/// Whether `c` is inside the inclusive rectangle `b`.
fn in_body(c: (i32, i32), b: WireBody) -> bool {
    c.0 >= b.min_x && c.0 <= b.max_x && c.1 >= b.min_y && c.1 <= b.max_y
}

/// The two stub cells, one step out of each port along its own normal.
fn stubs_of(from: WireDock, to: WireDock) -> ((i32, i32), (i32, i32)) {
    let f = normal(from.side);
    let t = normal(to.side);
    (
        (from.cell.0 + f.0, from.cell.1 + f.1),
        (to.cell.0 + t.0, to.cell.1 + t.1),
    )
}

/// The go-around's cells built DIRECTLY, `[A] ++ go_around_search(stubs) ++ [B]`, without
/// the ladder (which would swallow a `route()` rejection) and without the one-face gate
/// (which G3 must not call).
fn go_around_direct(from: WireDock, to: WireDock) -> Option<Vec<(i32, i32)>> {
    let f = normal(from.side);
    let t = normal(to.side);
    let (s, e) = stubs_of(from, to);
    let walk = go_around_search(from, to, s, f, e, (-t.0, -t.1))?;
    let mut cells = vec![from.cell];
    cells.extend(walk);
    cells.push(to.cell);
    Some(cells)
}

/// The cells of a frozen row's tiles.
fn row_cells(row: &CorpusRow) -> Vec<(i32, i32)> {
    row.tiles.iter().map(|t| (t[0], t[1])).collect()
}

/// `dock` with its body flattened to its own cell, which is what a mirror that forgot
/// that body would effectively be computing.
fn flattened(dock: WireDock) -> WireDock {
    WireDock {
        body: WireBody {
            min_x: dock.cell.0,
            min_y: dock.cell.1,
            max_x: dock.cell.0,
            max_y: dock.cell.1,
        },
        ..dock
    }
}

/// Every `(shape pair, source side, target side, dx, dy)` combination, in a fixed nested
/// order so the emitted file is byte-stable across runs and machines.
///
/// The FIRST shape group is `(1x1, 1x1)`, whose bodies are their own dock cells for every
/// side, so its 784 rows carry exactly the dock set the pre-72-16 corpus carried. That is
/// deliberate: it keeps the first block of the fixture diffable against the old one.
fn corpus() -> Vec<CorpusRow> {
    use fabrico_core::state::{Axis, Dir, TileKind};

    fn axis_num(a: Axis) -> i32 {
        match a {
            Axis::X => 0,
            Axis::Y => 1,
        }
    }
    fn dir_num(d: Dir) -> i32 {
        match d {
            Dir::N => 0,
            Dir::E => 1,
            Dir::S => 2,
            Dir::W => 3,
        }
    }

    let mut rows = Vec::new();
    for ((fw, fh), (tw, th)) in SHAPES {
        for from_side in 0u8..4 {
            for to_side in 0u8..4 {
                for dy in OFFSETS {
                    for dx in OFFSETS {
                        let from_body = place_body((0, 0), from_side, fw, fh);
                        let to_body = place_body((dx, dy), to_side, tw, th);
                        let from = WireDock {
                            cell: (0, 0),
                            side: from_side,
                            body: from_body,
                        };
                        let to = WireDock {
                            cell: (dx, dy),
                            side: to_side,
                            body: to_body,
                        };
                        // THE COINCIDENT ROWS ARE ERROR ROWS SINCE 75-03 (75-RESEARCH
                        // Pitfall 2): the router refuses two docks on one cell, so the row
                        // records the refusal instead of panicking. Any OTHER refusal is a
                        // broken safety argument, never an exotic pair, and still panics.
                        let (tiles, cand, err) = match wire_route_traced(from, to) {
                            Ok((g, cand)) => (
                                g.tiles
                                    .iter()
                                    .map(|t| match t.tile_kind() {
                                        TileKind::Straight { axis } => {
                                            [t.cell.0, t.cell.1, 0, axis_num(axis), -1]
                                        }
                                        TileKind::Corner { from, to } => {
                                            [t.cell.0, t.cell.1, 1, dir_num(from), dir_num(to)]
                                        }
                                    })
                                    .collect(),
                                cand,
                                None,
                            ),
                            Err(WireRouteError::Coincident) => {
                                (Vec::new(), CAND_NONE, Some("Coincident".to_string()))
                            }
                            Err(e) => panic!(
                                "every candidate in the ladder emits a route()-valid path for \
                                 EVERY non-coincident dock pair; {e:?} on ({dx},{dy}) means \
                                 one of the safety arguments in wire_route.rs is wrong, not \
                                 that this pair is exotic"
                            ),
                        };
                        rows.push(CorpusRow {
                            docks: [
                                0,
                                0,
                                i32::from(from_side),
                                from_body.min_x,
                                from_body.min_y,
                                from_body.max_x,
                                from_body.max_y,
                                dx,
                                dy,
                                i32::from(to_side),
                                to_body.min_x,
                                to_body.min_y,
                                to_body.max_x,
                                to_body.max_y,
                            ],
                            cand,
                            err,
                            tiles,
                        });
                    }
                }
            }
        }
    }
    rows
}

/// FREEZER, `#[ignore]`d so `cargo test` never runs it. Run explicitly to (re)bless, then
/// COMMIT the produced JSON:
///   `cargo test -p fabrico-command freeze_wire_corpus -- --ignored`
#[test]
#[ignore = "explicit corpus freezer; writes the committed wire_corpus fixture"]
fn freeze_wire_corpus() {
    let rows = corpus();
    let json = serde_json::to_string_pretty(&rows).expect("pretty-json the wire corpus");
    let dir = std::path::Path::new(JSON_PATH)
        .parent()
        .expect("fixture path has a parent dir");
    std::fs::create_dir_all(dir).expect("create fixtures dir");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write wire_corpus.expected.json");
}

/// Read the committed fixture.
fn frozen_rows() -> Vec<CorpusRow> {
    serde_json::from_str(
        &std::fs::read_to_string(JSON_PATH)
            .expect("corpus committed; run `freeze_wire_corpus -- --ignored` to bless it"),
    )
    .expect("the committed corpus parses")
}

/// GUARD, always runs. Any geometry drift fails here rather than silently regenerating.
#[test]
fn wire_corpus_matches_frozen() {
    let frozen = frozen_rows();
    let fresh = corpus();

    assert_eq!(
        fresh.len(),
        frozen.len(),
        "corpus SIZE drifted: the shape of the sweep changed, which is a deliberate act",
    );
    // Compare row by row rather than whole-vec, so a failure names the exact dock pair
    // instead of printing 3920 rows of diff.
    for (a, b) in fresh.iter().zip(frozen.iter()) {
        assert_eq!(
            a, b,
            "wire_route() geometry or winning candidate drifted for docks {:?}: re-bless \
             deliberately, never silently",
            a.docks,
        );
    }
}

/// The safety proof, made executable. Both candidates claim `route()` accepts every path
/// they emit, for every dock pair: `face_aligned_cells` by a strictly increasing potential
/// function, `perimeter_cells` by its two lemmas (interior/ring separation, and S1/S3
/// disjointness under D2). If either is ever false, `wire_route` silently falls through to
/// a later arm and the shape changes with nothing going red.
///
/// # THIS TEST DID NOT CARRY ITS OWN NAME UNTIL 2026-09-04, AND THAT IS WHY IT CHANGED
/// It used to assert a row count and a non-empty tile list, and the docblock said so and
/// called itself "a cheap floor". Both of those are TAUTOLOGIES over this file: the count
/// is the product of the same four constants that drive the loops that built it, and
/// non-emptiness is guaranteed by `route()`'s own contract on any path it accepts. The
/// `.expect` inside `corpus()` is unreachable for a different reason: `wire_route_traced`
/// swallows a rejected candidate (`if let Ok(tiles)` / `Err(_) =>`) and falls through to
/// `manhattan_l`, which `route()` always accepts. So the test could not fail.
///
/// MEASURED, phase 72 vacuity sweep V-6: `wire_route.rs:579`, `run_y(&mut cells, bx, ay,
/// by)` changed to `run_y(&mut cells, ax, ay, by)`, makes `face_aligned_cells` emit paths
/// `route()` REJECTS on 960 of the 3920 dock pairs. This test reported "1 passed; 0 failed"
/// before and after.
///
/// # WHAT IT ASSERTS NOW, AND WHY THIS FORM AND NOT A RENAME
/// The property the NAME claims is the safety proof above, and the safety proof is about
/// what each CANDIDATE emits, not about what the ladder settled for. So each candidate is
/// now built and judged DIRECTLY, bypassing the arm that hides the failure - exactly the
/// discipline [`the_ring_wins_on_exactly_the_frozen_rows`] already applies to the ring,
/// extended to the candidate the ring does not cover. A rename would have left the repo
/// with no gate at all over `face_aligned_cells`'s emitted paths, and there is one to have
/// here for four lines, so the name is kept and paid for.
///
/// THIS IS STILL NOT THE FALL-THROUGH DETECTOR. `cand` and
/// [`the_ring_wins_on_exactly_the_frozen_rows`] remain what see the ladder settling for a
/// later arm; this sees a candidate emitting a path `route()` refuses, which is the CAUSE
/// rather than the symptom.
#[test]
fn every_corpus_path_is_route_valid() {
    let rows = corpus();
    assert_eq!(
        rows.len(),
        SHAPES.len() * 4 * 4 * OFFSETS.len() * OFFSETS.len(),
        "the sweep covers the shape pairs x 4 source sides x 4 target sides x the offset \
         grid",
    );
    for row in &rows {
        let (from, to) = docks_of(row);
        // CANDIDATE 2, judged directly. `wire_route_traced` would swallow a rejection here
        // and serve `manhattan_l` instead, so this is the only place the face-aligned
        // shape's own validity proof is checked against `route()`.
        route(&face_aligned_cells(from, to)).unwrap_or_else(|e| {
            panic!(
                "face_aligned_cells emitted a path route() rejects ({e:?}) on docks {:?}. \
                 The ladder would have swallowed this and served the Manhattan L instead",
                row.docks
            )
        });
        // CANDIDATE 1, on the pairs it fires for. Same discipline, and it overlaps
        // `the_ring_wins_on_exactly_the_frozen_rows` deliberately: that gate walks the
        // FROZEN rows, this one walks the FRESH sweep, so a ring that broke on a pair the
        // fixture no longer contains is still seen.
        if let Some(cells) = perimeter_cells(from, to) {
            route(&cells).unwrap_or_else(|e| {
                panic!(
                    "perimeter_cells emitted a path route() rejects ({e:?}) on docks {:?}",
                    row.docks
                )
            });
        }
        // THE GO-AROUND SEARCH (75-01), on EVERY non-coincident row where it finds a
        // path between the two stubs, whether or not its gate would let it win. Its
        // validity argument (`go_around_search` docblock) does not depend on the gate, so
        // it is judged wherever it emits anything, bypassing the arm that would swallow a
        // rejection. Coincident docks are excluded because that argument needs `A != B`
        // (a path with both ends on one cell is P1 in `wire_side_aware.rs`).
        if let Some(cells) = (from.cell != to.cell)
            .then(|| go_around_direct(from, to))
            .flatten()
        {
            route(&cells).unwrap_or_else(|e| {
                panic!(
                    "go_around_search emitted a path route() rejects ({e:?}) on docks {:?}: \
                     {cells:?}",
                    row.docks
                )
            });
        }
        // CANDIDATE 4'S SEARCH (75-03), on every non-coincident row where it finds a
        // path, gate or no gate, for the reason the go-around is judged above.
        if let Some(cells) = (from.cell != to.cell)
            .then(|| clear_of_bodies_search(from, to))
            .flatten()
        {
            route(&cells).unwrap_or_else(|e| {
                panic!(
                    "clear_of_bodies_search emitted a path route() rejects ({e:?}) on docks \
                     {:?}: {cells:?}",
                    row.docks
                )
            });
        }
        // THE ERROR ROWS ARE EXACTLY THE COINCIDENT ONES (75-03), and every other row is a
        // real cable of at least two cells. Until 75-03 this asserted a non-empty tile
        // list, which the 80 one-tile coincident rows satisfied while the renderer drew
        // them as nothing.
        if from.cell == to.cell {
            assert_eq!(
                (row.err.as_deref(), row.cand, row.tiles.len()),
                (Some("Coincident"), CAND_NONE, 0),
                "a coincident row is a typed refusal with no tiles, docks {:?}",
                row.docks,
            );
        } else {
            assert!(
                row.err.is_none() && row.tiles.len() >= 2,
                "every non-coincident row is routed to at least two cells, docks {:?}: err \
                 {:?}, {} tiles",
                row.docks,
                row.err,
                row.tiles.len(),
            );
        }
    }
    assert_eq!(
        rows.iter().filter(|r| r.err.is_some()).count(),
        FROZEN_ERROR_ROWS,
        "the error rows are the coincident rows: one per shape pair and side pair",
    );
}

/// G1. THE CANDIDATE-WON COLUMN, WHICH IS THE ONLY THING THAT CAN SEE A SILENT
/// FALL-THROUGH.
///
/// `wire_route`'s `if let Ok(tiles) = route(&cells)` swallows the ring's rejection. So a
/// transposed sign in `ring_index` makes the ring emit invalid paths, the ladder quietly
/// serves the face-aligned shape instead, and every gate that reads only the emitted tiles
/// compares a re-blessed fixture against itself.
///
/// Two assertions, and both are needed. The COUNT pins that the ring still wins on the
/// number of rows it won on when this was blessed, so a fall-through that moves every
/// firing row to candidate 1 is a red rather than a smaller number nobody reads. The LOOP
/// calls `perimeter_cells` and `route` DIRECTLY, bypassing the arm that hides the failure,
/// so the ring's own output is judged rather than whatever the ladder settled for.
///
/// OBSERVED REDDENING (the named mutation, run and reverted): swapping the `y == cy0` and
/// `x == cx1` CONDITIONS in `ring_index`, leaving the branch bodies where they are, reddens
/// this test with `the ring emitted a path route() rejects (NonAdjacent) on docks
/// [0, 0, 0, 0, 0, 0, 0, -3, 0, 0, -3, 0, -3, 0]`, and reddens `wire_corpus_matches_frozen`
/// on that same row with `cand: 1` where the fixture says `cand: 0`. That second line IS the
/// silent fall-through, made visible by the column and by nothing else in the repository.
#[test]
fn the_ring_wins_on_exactly_the_frozen_rows() {
    let frozen = frozen_rows();
    let won = frozen.iter().filter(|r| r.cand == CAND_PERIMETER).count();
    assert_eq!(
        won, FROZEN_PERIMETER_ROWS,
        "the perimeter ring won on {FROZEN_PERIMETER_ROWS} rows when this fixture was \
         blessed. A different number means either the sweep narrowed or the ladder is \
         silently falling through, which is exactly what this column exists to see",
    );
    for row in frozen.iter().filter(|r| r.cand == CAND_PERIMETER) {
        let (from, to) = docks_of(row);
        let cells = perimeter_cells(from, to).unwrap_or_else(|| {
            panic!(
                "the fixture says the ring WON on docks {:?}, so the ring must fire on them",
                row.docks
            )
        });
        route(&cells).unwrap_or_else(|e| {
            panic!(
                "the ring emitted a path route() rejects ({e:?}) on docks {:?}. The ladder \
                 would have swallowed this and served the face-aligned shape instead",
                row.docks
            )
        });
    }
}

/// G2. THE LADDER AND THE RING'S D2 GATE AGREE, checked WITHOUT restating either.
///
/// The ring is supposed to fire on exactly the pairs the face-aligned ladder cannot serve
/// at either end: the set that reaches its final `else { true }` arm. That claim is
/// structural, not promised, and this is where it is held. It reads the face-aligned
/// candidate's EMITTED first and last step rather than re-evaluating the four booleans,
/// because a re-evaluation of the gate against itself is not a check.
///
/// Coincident docks are the one case with no steps to read; D0 declines them and that is
/// asserted directly rather than folded into the equivalence.
///
/// OBSERVED REDDENING (the named mutation, run and reverted): flipping the `arrive_x` arm
/// of the priority ladder in `face_aligned_cells` from `false` to `true` reddens this and
/// names the pair: `docks [0, 0, 0, 0, 0, 0, 0, -3, -3, 1, -3, -3, -3, -3]: ring fires
/// false, face-aligned leaves along (-1, 0) (normal (0, -1)) and arrives along (0, -1)
/// (inward normal (-1, 0))`. `wire_corpus_matches_frozen` also reddens on that mutation, as
/// a geometry move; this gate is the one that says the ladder and D2 have stopped agreeing.
#[test]
fn the_ring_fires_on_exactly_the_pairs_the_ladder_honours_neither_end_of() {
    for row in &frozen_rows() {
        let (from, to) = docks_of(row);
        let fires = perimeter_cells(from, to).is_some();
        let cells = face_aligned_cells(from, to);

        if cells.len() < 2 {
            assert!(
                !fires,
                "a single-cell face-aligned path means coincident docks, which D0 declines: \
                 docks {:?}",
                row.docks,
            );
            continue;
        }

        let f = normal(from.side);
        let t = normal(to.side);
        let nt = (-t.0, -t.1);
        let n = cells.len();
        let first_step = (cells[1].0 - cells[0].0, cells[1].1 - cells[0].1);
        let last_step = (
            cells[n - 1].0 - cells[n - 2].0,
            cells[n - 1].1 - cells[n - 2].1,
        );
        let honours_neither = first_step != f && last_step != nt;

        assert_eq!(
            fires, honours_neither,
            "the ring must fire on exactly the pairs the face-aligned shape honours NEITHER \
             end of. docks {:?}: ring fires {fires}, face-aligned leaves along {first_step:?} \
             (normal {f:?}) and arrives along {last_step:?} (inward normal {nt:?})",
            row.docks,
        );
    }
}

/// The FIVE-WAY shape axis is not decoration: `to.body` has to be able to change an answer,
/// or a mirror that dropped it would pass every row.
///
/// MEASURED at design time and re-asserted here rather than trusted: with only the first
/// two shape pairs, `to.body` affects 0 of 504 firing rows. This walks the frozen rows and
/// finds ones where perturbing `to.body` alone changes the emitted path, which is the
/// property the axis was widened for.
#[test]
fn the_target_body_is_live_in_the_sweep() {
    let mut live = 0usize;
    for row in &frozen_rows() {
        let (from, to) = docks_of(row);
        let Some(with) = perimeter_cells(from, to) else {
            continue;
        };
        // Shrink the target body to its own dock cell, which is what a mirror that forgot
        // `to.body` would effectively be computing.
        let flattened = WireDock {
            body: WireBody {
                min_x: to.cell.0,
                min_y: to.cell.1,
                max_x: to.cell.0,
                max_y: to.cell.1,
            },
            ..to
        };
        if perimeter_cells(from, flattened).as_ref() != Some(&with) {
            live += 1;
        }
    }
    // PINNED EXACTLY, not `live > 0` (phase 72 review WR-02). The floor form let a future
    // edit that narrowed `SHAPES` or `OFFSETS` until exactly one row still depended on
    // `to.body` stay green while the property this axis was widened for was gone in
    // substance. The sibling gate in this file already pins `FROZEN_PERIMETER_ROWS`
    // exactly and writes the same reason beside it; the same argument applies here and
    // was not applied.
    assert_eq!(
        live, FROZEN_TO_BODY_LIVE_ROWS,
        "to.body was live on {FROZEN_TO_BODY_LIVE_ROWS} of the frozen rows when this \
         fixture was blessed. Zero means a TS mirror that ignored to.body would pass the \
         whole corpus, which is the exact hole the five-way shape axis exists to close; a \
         different non-zero number means the sweep moved and wants re-blessing \
         deliberately",
    );
}

/// G3. THE GO-AROUND FIRES ON EXACTLY THE ONE-FACE ROWS, AND EVERY TWO-FACE ROW KEEPS ITS
/// BYTES (75-01, D-01 and D-02), checked WITHOUT calling the one-face gate.
///
/// It reads [`face_aligned_cells`]' EMITTED first and last steps, as G2 does, rather than
/// re-evaluating the gate's booleans: a gate re-evaluated against itself is not a check.
/// And it reads the candidate the LIVE ladder picks (`wire_route_traced`) on each frozen
/// row's docks, not the frozen `cand`: a gate mutation followed by a re-bless would make
/// the fixture agree with the broken ladder, and only a live read still sees it. On every
/// non-coincident row:
///   - `cand == 3` only where the face-aligned shape honours exactly one end AND both stub
///     cells (one step out of each port along its normal) are free of both bodies and both
///     docks;
///   - where that holds and `cand` is not 3, the go-around search run DIRECTLY finds no
///     path (so the ladder served the face-aligned shape for a reason, not because a
///     `route()` rejection was swallowed), and the number of such rows is pinned;
///   - where the face-aligned shape honours BOTH ends, the live cells and the frozen cells
///     ARE the face-aligned cells and `cand` is the face-aligned candidate: D-02, every
///     pair that was already right keeps its bytes.
///
/// OBSERVED REDDENING (75-01, run in a throwaway worktree and reverted). Making the
/// one-face gate fire on two-face rows (`!honours_both` replaced by `true`) reddens this
/// with `the go-around won on docks [0, 0, 0, 0, 0, 0, 0, -3, -3, 1, -3, -3, -3, -3],
/// which is not a one-face row with free stubs`. Dropping the x Z's room guard inside the
/// gate (`bx - sx != ax`) reddens it with `docks [0, 0, 1, 0, 0, 0, 0, 1, -3, 3, 1, -3, 1,
/// -3] are a one-face row with free stubs and the go-around search finds a path on them,
/// yet the ladder picked cand 1: it fell through`. While this test read the FROZEN `cand`
/// column, both mutations reddened only `wire_corpus_matches_frozen`, which a re-bless
/// would have silenced; that is why it reads the live ladder.
#[test]
fn the_go_around_fires_on_exactly_the_one_face_rows_and_keeps_every_two_face_row() {
    let mut declined = 0usize;
    for row in &frozen_rows() {
        let (from, to) = docks_of(row);
        if from.cell == to.cell {
            continue;
        }
        let (live, cand) = wire_route_traced(from, to)
            .unwrap_or_else(|e| panic!("docks {:?}: the ladder refused ({e:?})", row.docks));
        let live_cells: Vec<(i32, i32)> = live.tiles.iter().map(|t| t.cell).collect();
        let cells = face_aligned_cells(from, to);
        let f = normal(from.side);
        let t = normal(to.side);
        let nt = (-t.0, -t.1);
        let n = cells.len();
        let first_step = (cells[1].0 - cells[0].0, cells[1].1 - cells[0].1);
        let last_step = (
            cells[n - 1].0 - cells[n - 2].0,
            cells[n - 1].1 - cells[n - 2].1,
        );
        let leaves = first_step == f;
        let arrives = last_step == nt;
        let (s, e) = stubs_of(from, to);
        let stubs_free = [s, e].iter().all(|&c| {
            !in_body(c, from.body) && !in_body(c, to.body) && c != from.cell && c != to.cell
        });
        let eligible = leaves != arrives && stubs_free;

        if cand == CAND_GO_AROUND {
            assert!(
                eligible,
                "the go-around won on docks {:?}, which is not a one-face row with free \
                 stubs: face-aligned leaves along {first_step:?} (normal {f:?}), arrives \
                 along {last_step:?} (inward {nt:?}), stubs {s:?} {e:?}",
                row.docks
            );
        } else if eligible {
            assert!(
                go_around_direct(from, to).is_none(),
                "docks {:?} are a one-face row with free stubs and the go-around search \
                 finds a path on them, yet the ladder picked cand {cand}: it fell through",
                row.docks,
            );
            declined += 1;
        }

        if leaves && arrives {
            assert_eq!(
                (cand, &live_cells, row_cells(row)),
                (CAND_FACE_ALIGNED, &cells, cells.clone()),
                "docks {:?}: the face-aligned shape honours both ends here, so the live \
                 ladder and the frozen row must both be exactly that shape (D-02, it keeps \
                 its bytes)",
                row.docks
            );
        }
    }
    assert_eq!(
        declined, FROZEN_ONE_FACE_SEARCH_DECLINED_ROWS,
        "one-face rows with free stubs where the go-around search finds no path"
    );
}

/// The go-around's exact-count pin, and its own output judged DIRECTLY on every row it
/// won, the [`the_ring_wins_on_exactly_the_frozen_rows`] discipline extended to cand 3.
#[test]
fn the_go_around_wins_on_exactly_the_frozen_rows() {
    let frozen = frozen_rows();
    let won = frozen.iter().filter(|r| r.cand == CAND_GO_AROUND).count();
    assert_eq!(
        won, FROZEN_GO_AROUND_ROWS,
        "the go-around won on {FROZEN_GO_AROUND_ROWS} rows when this fixture was blessed. \
         A different number means the sweep narrowed or the ladder is silently falling \
         through past the go-around"
    );
    for row in frozen.iter().filter(|r| r.cand == CAND_GO_AROUND) {
        let (from, to) = docks_of(row);
        let cells = go_around_direct(from, to).unwrap_or_else(|| {
            panic!(
                "the fixture says the go-around WON on docks {:?}, so its search must find \
                 a path on them",
                row.docks
            )
        });
        route(&cells).unwrap_or_else(|e| {
            panic!(
                "the go-around emitted a path route() rejects ({e:?}) on docks {:?}. The \
                 ladder would have swallowed this and served the face-aligned shape",
                row.docks
            )
        });
        assert_eq!(
            cells,
            row_cells(row),
            "the go-around's direct cells differ from the frozen ones on docks {:?}",
            row.docks
        );
    }
}

/// Count the go-around rows whose direct path changes when `flatten` is applied to the
/// docks.
fn go_around_rows_changed_by(flatten: impl Fn(WireDock, WireDock) -> (WireDock, WireDock)) -> usize {
    let mut live = 0usize;
    for row in frozen_rows().iter().filter(|r| r.cand == CAND_GO_AROUND) {
        let (from, to) = docks_of(row);
        let with = go_around_direct(from, to);
        let (ff, tt) = flatten(from, to);
        if go_around_direct(ff, tt) != with {
            live += 1;
        }
    }
    live
}

/// `to.body` changes the go-around's answer on exactly the pinned number of rows, so a
/// TS mirror that ignored it cannot pass the corpus (the five-way shape axis's reason,
/// applied to cand 3).
#[test]
fn the_go_around_reads_to_body_on_exactly_the_frozen_rows() {
    let live = go_around_rows_changed_by(|f, t| (f, flattened(t)));
    assert_eq!(
        live, FROZEN_GO_AROUND_TO_BODY_LIVE_ROWS,
        "to.body was live on {FROZEN_GO_AROUND_TO_BODY_LIVE_ROWS} go-around rows when this \
         fixture was blessed"
    );
}

/// The same for `from.body`.
#[test]
fn the_go_around_reads_from_body_on_exactly_the_frozen_rows() {
    let live = go_around_rows_changed_by(|f, t| (flattened(f), t));
    assert_eq!(
        live, FROZEN_GO_AROUND_FROM_BODY_LIVE_ROWS,
        "from.body was live on {FROZEN_GO_AROUND_FROM_BODY_LIVE_ROWS} go-around rows when \
         this fixture was blessed"
    );
}

/// THE GO-AROUND IS OPTIMAL ON EVERY CORPUS ROW IT WON (plan 75-02, threat T-75-05). Every
/// frozen row with `cand == 3` is routed again by `common::brute_force_route`, an
/// exhaustive `(cell, heading)` search that shares no code with the router and is not
/// clipped to its corridor, on the row's OWN frozen docks, and must equal the frozen cells
/// AND the cells the live ladder routes on those docks today (so a mutated router is red
/// here before any re-bless, and a re-blessed mutated corpus is red here after one).
///
/// The frozen cells are the router's own output, blessed by its freezer, so
/// [`wire_corpus_matches_frozen`] can only say "unchanged". This test says "shortest, then
/// fewest bends, then the canonical walk", because the thing it compares against was not
/// produced by the router. It runs over every cand-3 row in full.
///
/// OBSERVED REDDENING (75-02, throwaway worktree): with the two body-edge lines of each
/// axis dropped from the router's line set, this test is red; the count it reported is in
/// `75-02-SUMMARY.md`.
#[test]
fn every_go_around_row_equals_the_brute_force_optimum() {
    let mut seen = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for row in frozen_rows().iter().filter(|r| r.cand == CAND_GO_AROUND) {
        seen += 1;
        let (from, to) = docks_of(row);
        let frozen = row_cells(row);
        let live: Option<Vec<(i32, i32)>> = wire_route_traced(from, to)
            .ok()
            .map(|(g, _)| g.tiles.iter().map(|t| t.cell).collect());
        let oracle = brute_force_route(from, to);
        if oracle.as_deref() != Some(frozen.as_slice()) || oracle != live {
            failures.push(format!(
                "docks {:?}: frozen {frozen:?}, live {live:?}, oracle {oracle:?}",
                row.docks
            ));
        }
    }
    assert_eq!(
        seen, FROZEN_GO_AROUND_ROWS,
        "the oracle check must see every go-around row the corpus pins"
    );
    assert!(
        failures.is_empty(),
        "{} of {seen} go-around rows differ from the brute-force optimum (first ten):\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// CANDIDATE 4's exact-count pin, and its own output judged DIRECTLY on every row it won
/// (75-03), the [`the_go_around_wins_on_exactly_the_frozen_rows`] discipline extended to
/// cand 4: `clear_of_bodies_search` is run on each counted row's frozen docks, bypassing
/// the ladder arm that would swallow a `route()` rejection, and must find a path `route()`
/// accepts that equals the frozen cells.
#[test]
fn the_clear_of_bodies_candidate_wins_on_exactly_the_frozen_rows() {
    let frozen = frozen_rows();
    let won = frozen
        .iter()
        .filter(|r| r.cand == CAND_CLEAR_OF_BODIES)
        .count();
    assert_eq!(
        won, FROZEN_CLEAR_OF_BODIES_ROWS,
        "candidate 4 won on {FROZEN_CLEAR_OF_BODIES_ROWS} rows when this fixture was blessed. \
         A different number means the sweep narrowed or the ladder is silently falling \
         through past candidate 4"
    );
    for row in frozen.iter().filter(|r| r.cand == CAND_CLEAR_OF_BODIES) {
        let (from, to) = docks_of(row);
        let cells = clear_of_bodies_search(from, to).unwrap_or_else(|| {
            panic!(
                "the fixture says candidate 4 WON on docks {:?}, so its search must find a \
                 path on them",
                row.docks
            )
        });
        route(&cells).unwrap_or_else(|e| {
            panic!(
                "candidate 4 emitted a path route() rejects ({e:?}) on docks {:?}",
                row.docks
            )
        });
        assert_eq!(
            cells,
            row_cells(row),
            "candidate 4's direct cells differ from the frozen ones on docks {:?}",
            row.docks
        );
    }
}

/// CANDIDATE 4 IS OPTIMAL AND BODY-CLEAR ON EVERY CORPUS ROW IT WON (75-03, threat
/// T-75-11). Every frozen `cand == 4` row is routed again by
/// `common::brute_force_route_relaxed`, an exhaustive search that shares no code with the
/// router, on the row's own frozen docks, and must equal the frozen cells AND the cells the
/// live ladder routes today; and no cell strictly between the two docks may lie in either
/// body.
///
/// OBSERVED REDDENING (75-03, throwaway worktree): with the start and finish coordinate
/// lines dropped from the router's line set, this test is red; the count is in
/// `75-03-SUMMARY.md`.
#[test]
fn every_clear_of_bodies_row_equals_the_relaxed_oracle() {
    let mut seen = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for row in frozen_rows()
        .iter()
        .filter(|r| r.cand == CAND_CLEAR_OF_BODIES)
    {
        seen += 1;
        let (from, to) = docks_of(row);
        let frozen = row_cells(row);
        let live: Option<Vec<(i32, i32)>> = wire_route_traced(from, to)
            .ok()
            .map(|(g, _)| g.tiles.iter().map(|t| t.cell).collect());
        let oracle = brute_force_route_relaxed(from, to);
        let over = frozen[1..frozen.len() - 1]
            .iter()
            .find(|&&c| in_rect(c, from.body) || in_rect(c, to.body))
            .copied();
        if oracle.as_deref() != Some(frozen.as_slice()) || oracle != live || over.is_some() {
            failures.push(format!(
                "docks {:?}: frozen {frozen:?}, live {live:?}, oracle {oracle:?}, over a body \
                 at {over:?}",
                row.docks
            ));
        }
    }
    assert_eq!(
        seen, FROZEN_CLEAR_OF_BODIES_ROWS,
        "the oracle check must see every candidate-4 row the corpus pins"
    );
    assert!(
        failures.is_empty(),
        "{} of {seen} candidate-4 rows differ from the relaxed brute-force optimum or cross a \
         body (first ten):\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
