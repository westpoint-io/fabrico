//! CABLE-01, CABLE-02 and CABLE-03: a cable leaves its port along the direction the port
//! faces and arrives head-on into the target port, on every 1x1 pair except a named,
//! counted list of shapes where no path can do both.
//!
//! # Why this file was committed BEFORE the router changed (phase 75, D-03)
//! An exception list written after the router is the list of whatever the router got
//! wrong. So the two shapes this file admits are written as PREDICATES over the inputs
//! `(from.cell, to.cell, from.side, to.side)`, each with the one-line reason no path can
//! honour both ends, and their counts are printed and pinned. The commit that added this
//! file touched nothing under `src/`, and it was run against the router of that commit and
//! seen red (the reds are quoted in `75-01-SUMMARY.md`).
//!
//! # What "side-correct" means here, in cells
//! The cable's FIRST step (second cell minus first) equals `normal(from.side)`, the
//! outward normal of the source port, and its LAST step equals the negated
//! `normal(to.side)`, i.e. it moves INTO the target port against that port's outward
//! normal. Every side vector is read through the crate's `normal`, never a local table:
//! a test-local copy of the side numbering is a second place for it to drift.
//!
//! # Bodies
//! The CABLE-01, CABLE-02 and 1x1 CABLE-03 tests use 1x1 machines whose body is their own
//! cell. Real machine sizes add the "port faces straight into the neighbour's body" class,
//! which plan 75-03's candidate serves; plan 75-02 named it FIRST, as P3a and P3b in
//! `tests/common/mod.rs`, and sweeps seven real shape pairs against it here
//! ([`cable_03_every_real_size_pair_is_side_correct_outside_the_named_shapes`]).
//!
//! # The independent oracle
//! [`the_go_around_equals_the_brute_force_optimum_on_every_fired_case`] routes every 1x1
//! case the go-around won through `common::brute_force_route`, an exhaustive search that
//! shares no code with the router, and requires the same cells.

mod common;

use common::{
    BRUTE_FORCE_MARGIN, admitted, brute_force_route, brute_force_route_relaxed, dock, end_steps,
    in_rect, inward, p1_same_cell, p2_touching_one_facing, place_body, rects_overlap,
};
use fabrico_command::route::route;
use fabrico_command::wire_route::{face_aligned_cells, normal};
use fabrico_command::{CAND_GO_AROUND, WireDock, WireRouteError, wire_route_traced};

/// The cells of the routed cable, in order, from the real ladder.
fn cells_of(from: WireDock, to: WireDock) -> Vec<(i32, i32)> {
    let (g, _cand) = wire_route_traced(from, to)
        .unwrap_or_else(|e| panic!("wire_route_traced refused {from:?} -> {to:?}: {e:?}"));
    g.tiles.iter().map(|t| t.cell).collect()
}

// `place_body`, `dock`, the step helpers and the degenerate list (P1, P2, and since plan
// 75-02 P3a and P3b) live in `tests/common/mod.rs`, moved there verbatim so
// `wire_golden.rs` and `wire_corpus.rs` read the same list rather than a copy of it.

/// The side names, for messages only.
const SIDE_NAMES: [&str; 4] = ["N", "E", "S", "W"];

/// CABLE-01. A cable leaves its source port along the direction the port faces, for all
/// four source sides.
///
/// The pair is `(2,5)` to `(6,9)` with the target port facing W. ROW AND COLUMN BOTH
/// DIFFER ON PURPOSE: a same-row or same-column pair is already green against the
/// pre-phase-75 router on every arm (a straight run, or an L that happens to leave the
/// right way), so a check on it cannot fail. With both differing, the N and W arms are the
/// ones the face-aligned L could not honour (it honours the arrival and leaves the wrong
/// way), which is what this test exists to see.
///
/// Every arm is evaluated and every failing arm is reported, so a red names which sides
/// break rather than stopping at the first.
#[test]
fn cable_01_leaves_along_the_source_facing_on_all_four_sides() {
    let to = dock(6, 9, 3);
    let mut failures = Vec::new();
    for side in 0u8..4 {
        let from = dock(2, 5, side);
        let cells = cells_of(from, to);
        let (first, _) = end_steps(&cells);
        if first != normal(side) {
            failures.push(format!(
                "source side {}: first step {first:?}, expected {:?}; cells {cells:?}",
                SIDE_NAMES[side as usize],
                normal(side)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of 4 source sides leave the wrong way:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// CABLE-02. A cable arrives head-on into the target port, for all four target sides.
///
/// The pair is `(2,5)` facing E to `(6,9)`. ROW AND COLUMN BOTH DIFFER for the reason
/// given on CABLE-01: with a shared row or column every arm is already green against the
/// pre-phase-75 router and the check cannot fail. With both differing, the E and S arms
/// are the ones the face-aligned L could not honour (it honours the departure and arrives
/// from the side), which is what this test exists to see.
#[test]
fn cable_02_arrives_head_on_on_all_four_target_sides() {
    let from = dock(2, 5, 1);
    let mut failures = Vec::new();
    for side in 0u8..4 {
        let to = dock(6, 9, side);
        let cells = cells_of(from, to);
        let (_, last) = end_steps(&cells);
        if last != inward(side) {
            failures.push(format!(
                "target side {}: last step {last:?}, expected {:?}; cells {cells:?}",
                SIDE_NAMES[side as usize],
                inward(side)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of 4 target sides are entered from the side:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The admitted counts, pinned (D-03). 784 = 49 cells x 16 side pairs on the same cell.
/// 1,008 = 168 ordered touching cell pairs in a 7x7 block x 6 side pairs each (3 where the
/// source faces the target and the target does not face back, 3 the other way round).
const ADMITTED_P1: usize = 784;
/// See [`ADMITTED_P1`].
const ADMITTED_P2: usize = 1008;

/// CABLE-03. The exhaustive 1x1 sweep: every from-cell of a 7x7 block crossed with every
/// to-cell of the same block and all 16 side pairs, 38,416 cases.
///
/// - P1 (same cell): counted, and since plan 75-03 the router must REFUSE it with
///   `WireRouteError::Coincident` (CABLE-09 part 1): a one-cell path plugs into nothing,
///   and the host draws a named stub for the refusal instead.
/// - P2 (touching, one port facing the other cell, the other facing disagreeing):
///   counted, and the path must still be `route()`-valid.
/// - Every other case: the router returns a path, `route()` accepts it, its first step is
///   `normal(from.side)` and its last step is the negated `normal(to.side)`.
///
/// Failures are collected; the first ten and the total are reported. The admitted counts
/// are printed (`admitted: P1=<n> P2=<n>`) and pinned exactly, so a predicate that quietly
/// widens to swallow a failure moves the pin rather than hiding.
#[test]
fn cable_03_every_1x1_pair_is_side_correct_outside_the_named_shapes() {
    let mut p1 = 0usize;
    let mut p2 = 0usize;
    let mut checked = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for fy in 0..7 {
        for fx in 0..7 {
            for ty in 0..7 {
                for tx in 0..7 {
                    for fs in 0u8..4 {
                        for ts in 0u8..4 {
                            let from = dock(fx, fy, fs);
                            let to = dock(tx, ty, ts);
                            let routed = wire_route_traced(from, to);
                            if p1_same_cell(from, to) {
                                p1 += 1;
                                if !matches!(routed, Err(WireRouteError::Coincident)) {
                                    failures.push(format!(
                                        "P1 {from:?} -> {to:?}: a same-cell pair must be \
                                         the typed refusal Coincident; got {routed:?}"
                                    ));
                                }
                                continue;
                            }
                            if p2_touching_one_facing(from, to) {
                                p2 += 1;
                                match routed {
                                    Ok((g, _)) => {
                                        let cells: Vec<(i32, i32)> =
                                            g.tiles.iter().map(|t| t.cell).collect();
                                        if let Err(e) = route(&cells) {
                                            failures.push(format!(
                                                "P2 {from:?} -> {to:?}: route() rejects \
                                                 ({e:?}) {cells:?}"
                                            ));
                                        }
                                    }
                                    Err(e) => failures.push(format!(
                                        "P2 {from:?} -> {to:?}: router refused ({e:?})"
                                    )),
                                }
                                continue;
                            }
                            checked += 1;
                            let cells: Vec<(i32, i32)> = match routed {
                                Ok((g, _)) => g.tiles.iter().map(|t| t.cell).collect(),
                                Err(e) => {
                                    failures.push(format!(
                                        "{from:?} -> {to:?}: router refused ({e:?})"
                                    ));
                                    continue;
                                }
                            };
                            if let Err(e) = route(&cells) {
                                failures.push(format!(
                                    "{from:?} -> {to:?}: route() rejects ({e:?}) {cells:?}"
                                ));
                                continue;
                            }
                            let (first, last) = end_steps(&cells);
                            let leaves = first == normal(fs);
                            let arrives = last == inward(ts);
                            if !(leaves && arrives) {
                                failures.push(format!(
                                    "({fx},{fy}){} -> ({tx},{ty}){}: first {first:?} \
                                     (want {:?}), last {last:?} (want {:?})",
                                    SIDE_NAMES[fs as usize],
                                    SIDE_NAMES[ts as usize],
                                    normal(fs),
                                    inward(ts)
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    println!("admitted: P1={p1} P2={p2}");
    println!("checked outside P1 and P2: {checked}");
    assert_eq!(
        (p1, p2),
        (ADMITTED_P1, ADMITTED_P2),
        "D-03: the admitted shapes are P1 same cell (784) and P2 touching with one facing \
         (1,008). A different count means a predicate moved, and a predicate that moves is \
         an exception list absorbing failures"
    );
    assert!(
        failures.is_empty(),
        "{} violations: P1 cases not refused as Coincident, P2 cases route() rejects, plus \
         cases among the {checked} outside P1 and P2 that are not side-correct (first \
         ten):\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// THE GO-AROUND IS OPTIMAL, PROVED AGAINST AN ORACLE THAT SHARES NONE OF ITS CODE (plan
/// 75-02, threat T-75-05). Every case of the 1x1 sweep above where the real ladder picked
/// the go-around (`CAND_GO_AROUND`) is routed again by `common::brute_force_route`, an
/// exhaustive `(cell, heading)` search over a box wider than the router's corridor, and the
/// two cell lists must be identical.
///
/// It runs on every fired case, not a stride: MEASURED at 75-02 in the debug profile, the
/// whole test takes well under the 30 s budget the plan sets (the time is in the SUMMARY).
///
/// OBSERVED REDDENING (75-02, throwaway worktree): with the two body-edge lines of each
/// axis dropped from the router's line set, this test is red; the count it reported is in
/// `75-02-SUMMARY.md`.
#[test]
fn the_go_around_equals_the_brute_force_optimum_on_every_fired_case() {
    let mut fired = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for fy in 0..7 {
        for fx in 0..7 {
            for ty in 0..7 {
                for tx in 0..7 {
                    for fs in 0u8..4 {
                        for ts in 0u8..4 {
                            let from = dock(fx, fy, fs);
                            let to = dock(tx, ty, ts);
                            let Ok((g, cand)) = wire_route_traced(from, to) else {
                                continue;
                            };
                            if cand != CAND_GO_AROUND {
                                continue;
                            }
                            fired += 1;
                            let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
                            let oracle = brute_force_route(from, to);
                            if oracle.as_deref() != Some(cells.as_slice()) {
                                failures.push(format!(
                                    "{from:?} -> {to:?}: router {cells:?}, oracle {oracle:?}"
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    println!("go-around fired on {fired} 1x1 cases; oracle margin {BRUTE_FORCE_MARGIN}");
    assert!(
        fired > 0,
        "the go-around fired on no 1x1 case, so this check saw nothing"
    );
    assert!(
        failures.is_empty(),
        "{} of {fired} go-around cases differ from the brute-force optimum (first ten):\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// The seven real shape pairs of the physical sweep, `(source (w, h), target (w, h))`,
/// resolved extents: the corpus's five plus two the corpus lacks, `(2,3)/(3,3)` (an even
/// width, so `place_body`'s centring rounds) and `(1,3)/(3,1)` (the corpus's non-square
/// pair, transposed).
const PHYSICAL_SHAPES: [((i32, i32), (i32, i32)); 7] = [
    ((1, 1), (1, 1)),
    ((3, 3), (1, 1)),
    ((1, 1), (3, 3)),
    ((3, 3), (3, 3)),
    ((3, 1), (1, 3)),
    ((2, 3), (3, 3)),
    ((1, 3), (3, 1)),
];

/// Cases the physical sweep visits after dropping overlapping bodies. See
/// [`cable_03_every_real_size_pair_is_side_correct_outside_the_named_shapes`].
const PHYSICAL_TOTAL: usize = 23_888;
/// Admitted P2 (touching, one port facing the other cell) in the physical sweep.
const PHYSICAL_P2: usize = 74;
/// Admitted P3a (faces into the neighbour's body, a body-clear connection exists).
const PHYSICAL_P3A: usize = 196;
/// Admitted P3b (faces into the neighbour's body, no body-clear connection exists).
const PHYSICAL_P3B: usize = 132;

/// CABLE-03 ON REAL MACHINE SIZES (plan 75-02, D-03): the seven shape pairs of
/// [`PHYSICAL_SHAPES`], the source dock at the origin and the target dock at every offset
/// `-7..=7` on both axes, all 16 side pairs, each body placed by `common::place_body`
/// (centred on its face), cases whose bodies overlap dropped.
///
/// The degenerate list is `common::admitted`, read from there and never restated: P1, P2,
/// and the two real-size shapes P3a and P3b, written over the docks and bodies only and
/// committed BEFORE plan 75-03's candidate for that class exists, so they cannot be the
/// list of whatever that candidate gets wrong.
///
/// - Admitted cases: counted, `route()`-valid, and since plan 75-03 each held to what D-04
///   draws for its shape:
///   - P2 (touching): EXACTLY the two-cell run `[A, B]`, already the shortest body-clear
///     connection;
///   - P3a (faces into the neighbour, a body-clear connection exists): no cell strictly
///     between the two docks inside either body, AND cell for cell what
///     `common::brute_force_route_relaxed` finds, the independent definition of
///     candidate 4;
///   - P3b (no body-clear connection exists at all): today's face-aligned cells, the named
///     exception, since crossing neither machine is impossible there.
/// - Every other case: `route()`-valid, first step `normal(from.side)`, last step the
///   negated `normal(to.side)`, and no cell strictly between the two docks inside either
///   body (the cable is not drawn over its own machines).
///
/// Prints `physical: total=<n> P2=<n> P3a=<n> P3b=<n>` and pins every number as measured.
///
/// RED BEFORE CANDIDATE 4 (75-03): every P3a case crossed a body or differed from the
/// relaxed oracle; the verbatim red is in `75-03-SUMMARY.md`.
#[test]
fn cable_03_every_real_size_pair_is_side_correct_outside_the_named_shapes() {
    let mut total = 0usize;
    let (mut p1, mut p2, mut p3a, mut p3b) = (0usize, 0usize, 0usize, 0usize);
    let mut failures: Vec<String> = Vec::new();
    for ((fw, fh), (tw, th)) in PHYSICAL_SHAPES {
        for fs in 0u8..4 {
            for ts in 0u8..4 {
                for dy in -7..=7 {
                    for dx in -7..=7 {
                        let from = WireDock {
                            cell: (0, 0),
                            side: fs,
                            body: place_body((0, 0), fs, fw, fh),
                        };
                        let to = WireDock {
                            cell: (dx, dy),
                            side: ts,
                            body: place_body((dx, dy), ts, tw, th),
                        };
                        if rects_overlap(from.body, to.body) {
                            continue;
                        }
                        total += 1;
                        let shape = format!("({fw}x{fh})->({tw}x{th})");
                        let cells: Vec<(i32, i32)> = match wire_route_traced(from, to) {
                            Ok((g, _)) => g.tiles.iter().map(|t| t.cell).collect(),
                            Err(e) => {
                                failures.push(format!(
                                    "{shape} {from:?} -> {to:?}: router refused ({e:?})"
                                ));
                                continue;
                            }
                        };
                        if let Err(e) = route(&cells) {
                            failures.push(format!(
                                "{shape} {from:?} -> {to:?}: route() rejects ({e:?}) {cells:?}"
                            ));
                            continue;
                        }
                        let over_body = |cells: &[(i32, i32)]| {
                            cells[1..cells.len() - 1]
                                .iter()
                                .find(|&&c| in_rect(c, from.body) || in_rect(c, to.body))
                                .copied()
                        };
                        match admitted(from, to) {
                            Some("P1") => {
                                p1 += 1;
                                continue;
                            }
                            Some("P2") => {
                                p2 += 1;
                                if cells != vec![from.cell, to.cell] {
                                    failures.push(format!(
                                        "P2 {shape} (0,0) -> ({dx},{dy}): not the two-cell \
                                         run; cells {cells:?}"
                                    ));
                                }
                                continue;
                            }
                            Some("P3a") => {
                                p3a += 1;
                                let oracle = brute_force_route_relaxed(from, to);
                                let over = over_body(&cells);
                                if over.is_some() || oracle.as_deref() != Some(cells.as_slice()) {
                                    failures.push(format!(
                                        "P3a {shape} (0,0){} -> ({dx},{dy}){}: over a body at \
                                         {over:?}; cells {cells:?}, relaxed oracle {oracle:?}",
                                        SIDE_NAMES[fs as usize],
                                        SIDE_NAMES[ts as usize],
                                    ));
                                }
                                continue;
                            }
                            Some(_) => {
                                p3b += 1;
                                let today = face_aligned_cells(from, to);
                                if cells != today {
                                    failures.push(format!(
                                        "P3b {shape} (0,0) -> ({dx},{dy}): cells {cells:?}, \
                                         face-aligned {today:?}"
                                    ));
                                }
                                continue;
                            }
                            None => {}
                        }
                        let (first, last) = end_steps(&cells);
                        let leaves = first == normal(fs);
                        let arrives = last == inward(ts);
                        let over = over_body(&cells);
                        if !(leaves && arrives) || over.is_some() {
                            failures.push(format!(
                                "{shape} (0,0){} -> ({dx},{dy}){}: first {first:?} (want \
                                 {:?}), last {last:?} (want {:?}), over a body at {over:?}; \
                                 cells {cells:?}",
                                SIDE_NAMES[fs as usize],
                                SIDE_NAMES[ts as usize],
                                normal(fs),
                                inward(ts)
                            ));
                        }
                    }
                }
            }
        }
    }
    println!("physical: total={total} P2={p2} P3a={p3a} P3b={p3b}");
    assert_eq!(
        p1, 0,
        "a same-cell pair has overlapping bodies and is dropped before this"
    );
    assert_eq!(
        (total, p2, p3a, p3b),
        (PHYSICAL_TOTAL, PHYSICAL_P2, PHYSICAL_P3A, PHYSICAL_P3B),
        "the physical sweep's case total and admitted counts are pinned as measured; a \
         predicate that moves is an exception list absorbing failures"
    );
    assert!(
        failures.is_empty(),
        "{} violations in the physical sweep: admitted cases not drawn as D-04 says, or \
         cases outside P2, P3a and P3b that are not side-correct and body-clear (first \
         ten):\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
