//! The SECOND cross-language parity corpus for the wire router (phase 92, D-09, CHROME-19):
//! cables with machines in the way.
//!
//! # Why a second corpus
//! `tests/wire_corpus.rs` holds the two routers to each other on 3920 dock pairs with no
//! third machine anywhere, which is exactly the input the ladder (`wire_route`) sees. The
//! obstacle stage (`wire_route_avoiding`) reads a machine list as well, and the TypeScript
//! mirror (`wireRouteAvoidingTraced` in `frontend/src/protocol/wireRoute.ts`) reimplements it
//! by hand: a transposed window edge, a missing line or a different endpoint filter would
//! leave the drag preview promising a way round the landed cable does not take, and the
//! first corpus cannot see any of it. That first corpus does not move: this file adds a
//! fixture, it never re-blesses the old one.
//!
//! # The sweep (`92-RESEARCH.md` Finding C)
//! The first corpus's five shape pairs x 4 source sides x 4 target sides, the source dock at
//! the origin, the target at five offsets far enough apart for a machine to sit between them
//! (`(7,0)`, `(0,7)`, `(7,3)`, `(-7,2)`, `(5,-6)`), times eight machine sets placed from the
//! two docks' midpoint `m` and thirds:
//! 1. a 1x1 at `m`;
//! 2. a 2x2 at `m`;
//! 3. a 3x3 centred on `m`;
//! 4. a 1x5 wall centred on `m`;
//! 5. a 5x1 wall centred on `m`;
//! 6. a 1x1 at each third;
//! 7. a 1x1 on the target's stub cell (one step out of its port);
//! 8. a 1x1 two cells out of the source port plus a 3x3 centred on `m`.
//!
//! A set that overlaps either body, or whose two machines overlap each other, is not a board
//! anyone can build and is SKIPPED and counted ([`FROZEN_SKIPPED_SETS`]).
//!
//! # The extra rows (review fix pass 1), appended after the sweep
//! [`extra_boards`] adds the boards the sweep cannot reach, each a literal case of
//! `tests/wire_obstacles.rs` made a row both languages read: the grid-edge wall at each of
//! the four edges (WR-A-01, [`FROZEN_EDGE_ROWS`]), a column of 65 touching machines and two
//! fields of machines at distinct coordinates (WR-A-02, the crowded class), a forged body off
//! its dock, and a dock neighbour inside a third machine (IN-A-02). The sweep's rows come
//! first and are byte-identical to the fixture before the extras were added. Each row's machine
//! list is written SCRAMBLED ON PURPOSE as `[last obstacle, to.body, other obstacles,
//! from.body]`, so the two endpoint bodies ride in the list (the endpoint filter must drop
//! them) and the obstacles are out of sorted order. The scramble proves ORDER INDEPENDENCE
//! ([`machine_order_never_changes_a_path`] tries two more orders); it does not test the
//! router's sort, which no answer depends on (the window is a least fixed point and the line
//! set is sorted on its own; review IN-A-01). The sort only makes `AroundWindow::obstacles`
//! one canonical list.
//!
//! # The classes, and what holds each to the truth
//! Every row is one of four classes. The class gates ROUTE EACH ROW FRESH and judge the
//! router's answer (a gate that compared the fixture with the oracle could fail only on a
//! re-bless); the fixture itself is judged by [`wire_obstacle_corpus_matches_frozen`]:
//! - AROUND MACHINES: `cand == CAND_AROUND_MACHINES`. Held by
//!   [`every_around_machines_row_equals_the_avoiding_oracle`], cell for cell against the
//!   exhaustive `brute_force_route_avoiding`, which shares no code with the router.
//! - WALLED IN: the ladder's path enters an obstacle and the stage kept it. Held by
//!   [`every_walled_in_row_has_no_clear_path_by_the_oracle`]: the oracle must find no way
//!   round either, so "kept because walled in" is never "kept because the search gave up".
//! - CROWDED: `cand == CAND_AROUND_CROWDED`, the cell walk on a window whose line set is over
//!   `MAX_AROUND_NODES`. Held by [`every_crowded_row_matches_the_oracle_ranking`]: no cell in
//!   a machine, and the exhaustive optimum's length and both face keys.
//! - KEPT CLEAR: the ladder's path enters no obstacle. Held by
//!   [`every_kept_row_is_todays_path`]: tiles and candidate equal `wire_route_traced`.
//!
//! The six count pins hold the sweep to reaching every class: a sweep that quietly stops
//! producing a class is a red, not a smaller number nobody reads. They are NOT what proves
//! the router right (a row count of the router's own output agrees with itself by
//! construction, the `wire_corpus.rs` tautology warning); the oracle gates are.
//!
//! # Two parts, the `wire_corpus.rs` freezer discipline
//!   - [`freeze_wire_obstacle_corpus`] (`#[ignore]`d) is the ONLY writer:
//!     `cargo test -p fabrico-command freeze_wire_obstacle_corpus -- --ignored`
//!   - [`wire_obstacle_corpus_matches_frozen`] (always runs) re-routes every row and asserts
//!     equality with the committed JSON.
//!
//! Cross-language consumer: `frontend/src/protocol/wireRoute.test.ts` reads this SAME JSON by
//! relative path and asserts its mirror is tile and candidate equal on every row, with the
//! machine list reversed and rotated too.
//!
//! Run target: `cargo test -p fabrico-command --test wire_obstacle_corpus`
#![allow(clippy::disallowed_methods)] // corpus freezer: needs std::fs; the freeze step is #[ignore]d.

mod common;

use common::{brute_force_route_avoiding, in_rect, place_body, rects_overlap};
use fabrico_command::route::route;
use fabrico_command::wire_route::normal;
use fabrico_command::{
    CAND_AROUND_CROWDED, CAND_AROUND_MACHINES, WireBody, WireDock, WireRouteError,
    wire_route_avoiding_traced, wire_route_traced,
};

/// Absolute path to the frozen obstacle corpus (CWD-independent).
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wire_obstacle_corpus.expected.json"
);

/// The first corpus, read for [`wire_route_equals_wire_route_avoiding_with_no_machines`].
const FIRST_CORPUS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wire_corpus.expected.json"
);

/// The machine-shape axis: the first corpus's five pairs, `(source (w, h), target (w, h))`,
/// resolved extents. Repeated here rather than imported so the two sweeps can be read apart.
const SHAPES: [((i32, i32), (i32, i32)); 5] = [
    ((1, 1), (1, 1)),
    ((3, 3), (1, 1)),
    ((1, 1), (3, 3)),
    ((3, 3), (3, 3)),
    ((3, 1), (1, 3)),
];

/// The target offsets, the source at the origin: far enough apart on at least one axis for a
/// machine to sit between the two ends, in all four quadrants.
const OFFSETS: [(i32, i32); 5] = [(7, 0), (0, 7), (7, 3), (-7, 2), (5, -6)];

/// The number of rows the obstacle stage drew around a machine (`cand == 5`), pinned so a
/// sweep that quietly stops reaching the stage is a red rather than a smaller number nobody
/// reads.
const FROZEN_AROUND_MACHINES_ROWS: usize = 1338;

/// The number of rows whose ladder path enters a machine and that the stage kept because no
/// way round exists (the walled-in dock), pinned so a sweep that quietly stops reaching that
/// exception is a red. Each is held by [`every_walled_in_row_has_no_clear_path_by_the_oracle`].
const FROZEN_WALLED_IN_ROWS: usize = 174;

/// The number of rows whose ladder path enters no machine, so the stage keeps it unchanged
/// (D-09's keep-today's-path rule), pinned so a sweep that quietly stops exercising that rule
/// with machines on the board is a red.
const FROZEN_KEPT_CLEAR_ROWS: usize = 1355;

/// The number of rows the stage walked cell by cell because the window's line set is over
/// `MAX_AROUND_NODES` (the crowded class, review fix pass 1), pinned so the extra rows that
/// reach it cannot quietly stop reaching it.
const FROZEN_CROWDED_ROWS: usize = 2;

/// The number of extra rows on a grid edge (review WR-A-01): the wall at each of the four.
const FROZEN_EDGE_ROWS: usize = 4;

/// The number of machine sets the sweep skipped because they overlap a body or each other,
/// pinned so a placement change that quietly skips most of the sweep is a red.
const FROZEN_SKIPPED_SETS: usize = 340;

/// One row, plain data both languages read. `docks` and `tiles` use the first corpus's
/// encoding (`wire_corpus.rs` `CorpusRow`).
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq, Debug)]
struct ObstacleRow {
    /// `[from_x, from_y, from_side, from_body x0, y0, x1, y1, to_x, to_y, to_side,
    /// to_body x0, y0, x1, y1]`, resolved rectangles.
    docks: [i32; 14],
    /// The machine list handed to the router, `[min_x, min_y, max_x, max_y]` each, in the
    /// scrambled order the module docblock describes.
    machines: Vec<[i32; 4]>,
    /// Which candidate drew the cable: the ladder's own (0, 1, 3 or 4) or 5.
    cand: u8,
    /// One `[cell_x, cell_y, kind, a, b]` per tile; kind 0 Straight (a = axis), 1 Corner.
    tiles: Vec<[i32; 5]>,
}

fn body_of(r: [i32; 4]) -> WireBody {
    WireBody {
        min_x: r[0],
        min_y: r[1],
        max_x: r[2],
        max_y: r[3],
    }
}

fn docks_of(d: &[i32; 14]) -> (WireDock, WireDock) {
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let side = |v: i32| v as u8;
    (
        WireDock {
            cell: (d[0], d[1]),
            side: side(d[2]),
            body: body_of([d[3], d[4], d[5], d[6]]),
        },
        WireDock {
            cell: (d[7], d[8]),
            side: side(d[9]),
            body: body_of([d[10], d[11], d[12], d[13]]),
        },
    )
}

fn machines_of(row: &ObstacleRow) -> Vec<WireBody> {
    row.machines.iter().map(|&m| body_of(m)).collect()
}

/// The `w` by `h` rectangle whose top-left cell is `(x, y)`.
fn rect(x: i32, y: i32, w: i32, h: i32) -> WireBody {
    WireBody {
        min_x: x,
        min_y: y,
        max_x: x + w - 1,
        max_y: y + h - 1,
    }
}

/// `a / b` rounded to the nearest integer, a half rounded UP (toward positive infinity), for
/// `b > 0`: the placement rule of the research prototype's sweep, written in integers.
fn round_div(a: i32, b: i32) -> i32 {
    (2 * a + b).div_euclid(2 * b)
}

/// The tiles of a geometry in the corpus encoding.
fn encode(g: &fabrico_command::WireGeometry) -> Vec<[i32; 5]> {
    use fabrico_core::state::{Axis, Dir, TileKind};
    let axis = |a: Axis| match a {
        Axis::X => 0,
        Axis::Y => 1,
    };
    let dir = |d: Dir| match d {
        Dir::N => 0,
        Dir::E => 1,
        Dir::S => 2,
        Dir::W => 3,
    };
    g.tiles
        .iter()
        .map(|t| match t.tile_kind() {
            TileKind::Straight { axis: a } => [t.cell.0, t.cell.1, 0, axis(a), -1],
            TileKind::Corner { from, to } => [t.cell.0, t.cell.1, 1, dir(from), dir(to)],
        })
        .collect()
}

/// The sweep: every row in a fixed nested order (byte-stable), and the count of skipped sets.
fn corpus() -> (Vec<ObstacleRow>, usize) {
    let mut rows = Vec::new();
    let mut skipped = 0;
    for ((fw, fh), (tw, th)) in SHAPES {
        for from_side in 0u8..4 {
            for to_side in 0u8..4 {
                for (dx, dy) in OFFSETS {
                    let from = WireDock {
                        cell: (0, 0),
                        side: from_side,
                        body: place_body((0, 0), from_side, fw, fh),
                    };
                    let to = WireDock {
                        cell: (dx, dy),
                        side: to_side,
                        body: place_body((dx, dy), to_side, tw, th),
                    };
                    let m = (round_div(dx, 2), round_div(dy, 2));
                    let t3 = (round_div(dx, 3), round_div(dy, 3));
                    let t6 = (round_div(2 * dx, 3), round_div(2 * dy, 3));
                    let tn = normal(to_side);
                    let fnn = normal(from_side);
                    let sets: [Vec<WireBody>; 8] = [
                        vec![rect(m.0, m.1, 1, 1)],
                        vec![rect(m.0, m.1, 2, 2)],
                        vec![rect(m.0 - 1, m.1 - 1, 3, 3)],
                        vec![rect(m.0, m.1 - 2, 1, 5)],
                        vec![rect(m.0 - 2, m.1, 5, 1)],
                        vec![rect(t3.0, t3.1, 1, 1), rect(t6.0, t6.1, 1, 1)],
                        vec![rect(dx + tn.0, dy + tn.1, 1, 1)],
                        vec![rect(fnn.0 * 2, fnn.1 * 2, 1, 1), rect(m.0 - 1, m.1 - 1, 3, 3)],
                    ];
                    for obs in sets {
                        let overlaps_body = obs
                            .iter()
                            .any(|&o| rects_overlap(o, from.body) || rects_overlap(o, to.body));
                        let overlaps_each_other = obs.len() > 1 && rects_overlap(obs[0], obs[1]);
                        if overlaps_body || overlaps_each_other {
                            skipped += 1;
                            continue;
                        }
                        // Scrambled on purpose: [last obstacle, to.body, the rest, from.body].
                        let mut machines = vec![obs[obs.len() - 1], to.body];
                        machines.extend(obs[..obs.len() - 1].iter().copied());
                        machines.push(from.body);
                        let (g, cand) = match wire_route_avoiding_traced(from, to, &machines) {
                            Ok(r) => r,
                            Err(e) => panic!(
                                "no corpus pair is coincident, so the stage routes every one; \
                                 {e:?} on ({dx},{dy}) means a safety argument is wrong"
                            ),
                        };
                        rows.push(ObstacleRow {
                            docks: [
                                0,
                                0,
                                i32::from(from_side),
                                from.body.min_x,
                                from.body.min_y,
                                from.body.max_x,
                                from.body.max_y,
                                dx,
                                dy,
                                i32::from(to_side),
                                to.body.min_x,
                                to.body.min_y,
                                to.body.max_x,
                                to.body.max_y,
                            ],
                            machines: machines
                                .iter()
                                .map(|b| [b.min_x, b.min_y, b.max_x, b.max_y])
                                .collect(),
                            cand,
                            tiles: encode(&g),
                        });
                    }
                }
            }
        }
    }
    for (from, to, obs) in extra_boards() {
        rows.push(row_of(from, to, &obs));
    }
    (rows, skipped)
}

/// One row: the machine list scrambled as the sweep scrambles it, routed by the stage.
fn row_of(from: WireDock, to: WireDock, obs: &[WireBody]) -> ObstacleRow {
    let mut machines = vec![obs[obs.len() - 1], to.body];
    machines.extend(obs[..obs.len() - 1].iter().copied());
    machines.push(from.body);
    let (g, cand) = wire_route_avoiding_traced(from, to, &machines).expect("every extra row routes");
    let side = |d: WireDock| i32::from(d.side);
    ObstacleRow {
        docks: [
            from.cell.0,
            from.cell.1,
            side(from),
            from.body.min_x,
            from.body.min_y,
            from.body.max_x,
            from.body.max_y,
            to.cell.0,
            to.cell.1,
            side(to),
            to.body.min_x,
            to.body.min_y,
            to.body.max_x,
            to.body.max_y,
        ],
        machines: machines.iter().map(|b| [b.min_x, b.min_y, b.max_x, b.max_y]).collect(),
        cand,
        tiles: encode(&g),
    }
}

/// The boards the sweep cannot reach (review fix pass 1), in a fixed order: the four grid
/// edges, the crowded column and two crowded fields, the forged body off its dock, and the
/// dock neighbour inside a third machine. Each is a literal case of `tests/wire_obstacles.rs`.
fn extra_boards() -> Vec<(WireDock, WireDock, Vec<WireBody>)> {
    let dock = |cell: (i32, i32), side: u8, body: WireBody| WireDock { cell, side, body };
    let mut out = Vec::new();

    // The grid-edge wall (WR-A-01): five 3x3 machines whose last row is GRID_MAX, between two
    // 1x1 ends on row 510, and the same board turned onto the other three edges: `t` maps a
    // cell, `ts` a side byte (N=0, E=1, S=2, W=3).
    type Turn = (fn((i32, i32)) -> (i32, i32), fn(u8) -> u8);
    let turns: [Turn; 4] = [
        (|c| c, |s| s),
        (|c| (c.0, -c.1), |s| [2, 1, 0, 3][usize::from(s)]),
        (|c| (c.1, c.0), |s| [3, 2, 1, 0][usize::from(s)]),
        (|c| (-c.1, c.0), |s| [3, 0, 1, 2][usize::from(s)]),
    ];
    for (t, ts) in turns {
        let turned = |b: WireBody| {
            let (a, c) = (t((b.min_x, b.min_y)), t((b.max_x, b.max_y)));
            WireBody {
                min_x: a.0.min(c.0),
                min_y: a.1.min(c.1),
                max_x: a.0.max(c.0),
                max_y: a.1.max(c.1),
            }
        };
        let wall: Vec<WireBody> = (0..5).map(|k| turned(rect(504, 498 + 3 * k, 3, 3))).collect();
        let from = dock(t((500, 510)), ts(1), turned(rect(500, 510, 1, 1)));
        let to = dock(t((510, 510)), ts(3), turned(rect(510, 510, 1, 1)));
        out.push((from, to, wall));
    }

    // The crowded column (WR-A-02): 65 touching machines, one over the old cap.
    let from = dock((0, 0), 1, rect(0, 0, 1, 1));
    let to = dock((4, 0), 3, rect(4, 0, 1, 1));
    out.push((from, to, (0..65).map(|k| rect(2, k, 1, 1)).collect()));

    // Two crowded fields (WR-A-02): machines at pairwise distinct columns and rows, one on
    // the ladder's path; their line sets are over MAX_AROUND_NODES.
    for (target, n) in [((110, 60), 100), ((-70, 90), 64)] {
        let from = dock((0, 0), 1, rect(0, 0, 1, 1));
        let to = dock(target, 3, rect(target.0, target.1, 1, 1));
        let (ladder, _) = wire_route_traced(from, to).expect("the ladder routes it");
        let mid = ladder.tiles[ladder.tiles.len() / 3].cell;
        let mut field = vec![rect(mid.0, mid.1, 1, 1)];
        let dir = target.0.signum();
        for k in 0..n {
            let (x, y) = (dir * (4 + k), -20 + (37 * k).rem_euclid(n));
            let clash = in_rect((x, y), from.body)
                || in_rect((x, y), to.body)
                || ladder.tiles.iter().any(|t| t.cell == (x, y));
            if !clash {
                field.push(rect(x, y, 1, 1));
            }
        }
        out.push((from, to, field));
    }

    // A forged body off its dock (IN-A-02): the window must start from the dock cells.
    out.push((
        dock((0, 0), 1, rect(0, 2, 1, 3)),
        dock((3, 0), 3, rect(2, 2, 1, 1)),
        vec![rect(1, -1, 1, 2)],
    ));
    // A dock neighbour inside a third machine (IN-A-02): no end may sit in a machine.
    out.push((
        dock((0, 0), 1, rect(0, 0, 1, 1)),
        dock((1, 1), 0, rect(1, 1, 1, 1)),
        vec![rect(1, 0, 1, 1)],
    ));
    out
}

/// FREEZER, `#[ignore]`d so `cargo test` never runs it. Run explicitly to bless, then COMMIT
/// the produced JSON:
///   `cargo test -p fabrico-command freeze_wire_obstacle_corpus -- --ignored`
#[test]
#[ignore = "explicit corpus freezer; writes the committed wire_obstacle_corpus fixture"]
fn freeze_wire_obstacle_corpus() {
    let (rows, skipped) = corpus();
    let json = serde_json::to_string_pretty(&rows).expect("pretty-json the obstacle corpus");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write wire_obstacle_corpus.expected.json");
    let (around, crowded, walled, kept) = classes(&rows);
    println!(
        "FROZE rows={} around={around} crowded={crowded} walled={walled} kept={kept} skipped={skipped}",
        rows.len()
    );
}

fn frozen_rows() -> Vec<ObstacleRow> {
    serde_json::from_str(
        &std::fs::read_to_string(JSON_PATH)
            .expect("corpus committed; run `freeze_wire_obstacle_corpus -- --ignored` to bless it"),
    )
    .expect("the committed obstacle corpus parses")
}

/// The obstacles of a row by the definition (the router's own filter is not called): every
/// listed rectangle that holds neither dock cell.
fn obstacles_by_definition(from: WireDock, to: WireDock, machines: &[WireBody]) -> Vec<WireBody> {
    machines
        .iter()
        .copied()
        .filter(|&m| !in_rect(from.cell, m) && !in_rect(to.cell, m))
        .collect()
}

/// Whether the shipped ladder's path for the row enters any obstacle.
fn ladder_crosses(row: &ObstacleRow) -> bool {
    let (from, to) = docks_of(&row.docks);
    let obstacles = obstacles_by_definition(from, to, &machines_of(row));
    let (g, _) = wire_route_traced(from, to).expect("no corpus pair is coincident");
    g.tiles
        .iter()
        .any(|t| obstacles.iter().any(|&o| in_rect(t.cell, o)))
}

/// Whether a row's cable was drawn by the stage (either way round).
fn stage_drew(cand: u8) -> bool {
    cand == CAND_AROUND_MACHINES || cand == CAND_AROUND_CROWDED
}

/// `(around, crowded, walled in, kept clear)` row counts.
fn classes(rows: &[ObstacleRow]) -> (usize, usize, usize, usize) {
    let around = rows.iter().filter(|r| r.cand == CAND_AROUND_MACHINES).count();
    let crowded = rows.iter().filter(|r| r.cand == CAND_AROUND_CROWDED).count();
    let crossing = rows.iter().filter(|r| ladder_crosses(r)).count();
    let walled = rows
        .iter()
        .filter(|r| !stage_drew(r.cand) && ladder_crosses(r))
        .count();
    let kept = rows.len() - crossing;
    (around, crowded, walled, kept)
}

/// GUARD, always runs: any drift in either the stage or the sweep fails here, row by row.
#[test]
fn wire_obstacle_corpus_matches_frozen() {
    let frozen = frozen_rows();
    let (fresh, _) = corpus();
    assert_eq!(
        fresh.len(),
        frozen.len(),
        "obstacle corpus SIZE drifted: the sweep or the skip rule changed, a deliberate act"
    );
    for (a, b) in fresh.iter().zip(frozen.iter()) {
        assert_eq!(
            a, b,
            "wire_route_avoiding geometry or candidate drifted for docks {:?} machines {:?}: \
             re-bless deliberately, never silently",
            a.docks, a.machines
        );
    }
}

/// The stage's answer for a row, routed FRESH from the row's own docks and machine list.
///
/// The three class gates below judge THIS, never the frozen tiles: a gate that compared the
/// fixture with the oracle could only ever fail on a re-bless, and would stay green over a
/// broken router until then (seen at plan 92-02: skipping the window growth moved 84 rows
/// to other equal-length paths and a fixture-reading oracle gate stayed green). The fixture
/// is judged by [`wire_obstacle_corpus_matches_frozen`]; the router by these.
fn fresh(row: &ObstacleRow) -> (Vec<(i32, i32)>, u8) {
    let (from, to) = docks_of(&row.docks);
    let (g, cand) = wire_route_avoiding_traced(from, to, &machines_of(row)).expect("routes");
    (g.tiles.iter().map(|t| t.cell).collect(), cand)
}

/// THE ORACLE GATE: on every row the stage draws around a machine (now, or in the frozen
/// fixture), the cable is, cell for cell, the exhaustive optimum `brute_force_route_avoiding`
/// finds over a box holding every rectangle plus the margin. So the window and the line set
/// lost no shorter way round, and no cell lies inside any machine.
#[test]
fn every_around_machines_row_equals_the_avoiding_oracle() {
    let rows = frozen_rows();
    let mut bad = Vec::new();
    let mut judged = 0;
    for row in &rows {
        let (cells, cand) = fresh(row);
        if cand != CAND_AROUND_MACHINES && row.cand != CAND_AROUND_MACHINES {
            continue;
        }
        judged += 1;
        let (from, to) = docks_of(&row.docks);
        let machines = machines_of(row);
        let oracle = brute_force_route_avoiding(from, to, &machines);
        let obstacles = obstacles_by_definition(from, to, &machines);
        let inside = cells
            .iter()
            .any(|&c| obstacles.iter().any(|&o| in_rect(c, o)));
        if cand != CAND_AROUND_MACHINES
            || oracle.as_deref() != Some(&cells[..])
            || inside
            || route(&cells).is_err()
        {
            bad.push(format!(
                "docks {:?} machines {:?}\n  router (cand {cand}): {cells:?}\n  oracle: {oracle:?}",
                row.docks, row.machines
            ));
        }
    }
    assert!(judged > 0, "no row reached the stage: the gate measured nothing");
    assert!(
        bad.is_empty(),
        "{} around-machines rows differ from the exhaustive oracle; first:\n{}",
        bad.len(),
        bad.first().map_or("", String::as_str)
    );
}

/// `(length, arrival missed, departure missed)` of a cable's cells: the crowded walk's exact
/// keys, read from the cells by the definition (the router's own costs are not called).
fn ranking(from: WireDock, to: WireDock, cells: &[(i32, i32)]) -> (usize, bool, bool) {
    let f = normal(from.side);
    let t = normal(to.side);
    let n = cells.len();
    let first = (cells[1].0 - cells[0].0, cells[1].1 - cells[0].1);
    let last = (cells[n - 1].0 - cells[n - 2].0, cells[n - 1].1 - cells[n - 2].1);
    (n, last != (-t.0, -t.1), first != f)
}

/// THE CROWDED GATE (review fix pass 1): on every row the stage walks cell by cell (now, or
/// in the frozen fixture), the cable enters no machine, `route()` accepts it, and it has the
/// exhaustive optimum's length and both face keys. Bends are taken move by move in this class,
/// so the cells themselves are not the oracle's.
#[test]
fn every_crowded_row_matches_the_oracle_ranking() {
    let rows = frozen_rows();
    let mut bad = Vec::new();
    let mut judged = 0;
    for row in &rows {
        let (cells, cand) = fresh(row);
        if cand != CAND_AROUND_CROWDED && row.cand != CAND_AROUND_CROWDED {
            continue;
        }
        judged += 1;
        let (from, to) = docks_of(&row.docks);
        let machines = machines_of(row);
        let oracle = brute_force_route_avoiding(from, to, &machines);
        let obstacles = obstacles_by_definition(from, to, &machines);
        let inside = cells.iter().any(|&c| obstacles.iter().any(|&o| in_rect(c, o)));
        let ranked_alike = oracle
            .as_deref()
            .is_some_and(|o| ranking(from, to, o) == ranking(from, to, &cells));
        if cand != CAND_AROUND_CROWDED || !ranked_alike || inside || route(&cells).is_err() {
            bad.push(format!(
                "docks {:?}\n  router (cand {cand}): {cells:?}\n  oracle: {oracle:?}",
                row.docks
            ));
        }
    }
    assert!(judged > 0, "no row reached the crowded walk: the gate measured nothing");
    assert!(
        bad.is_empty(),
        "{} crowded rows differ from the oracle's ranking; first:\n{}",
        bad.len(),
        bad.first().map_or("", String::as_str)
    );
}

/// THE EDGE ROWS (review WR-A-01): each grid-edge wall row passes one cell outside the grid,
/// where the oracle's way round goes; [`every_around_machines_row_equals_the_avoiding_oracle`]
/// holds its cells, and this holds that the extras still reach all four edges.
#[test]
fn the_edge_rows_leave_the_grid_by_one_cell() {
    use fabrico_command::command::{GRID_MAX, GRID_MIN};
    let rows = frozen_rows();
    let edge = rows
        .iter()
        .filter(|r| {
            r.tiles.iter().any(|t| {
                t[0] == GRID_MAX + 1 || t[0] == GRID_MIN - 1 || t[1] == GRID_MAX + 1 || t[1] == GRID_MIN - 1
            })
        })
        .count();
    assert_eq!(edge, FROZEN_EDGE_ROWS, "rows whose cable passes one cell outside the grid");
}

/// THE WALLED-IN GATE: on every row whose ladder path enters a machine and where the stage
/// keeps that path, the oracle finds no way round either. A stage that gave up where a path
/// exists is a red.
#[test]
fn every_walled_in_row_has_no_clear_path_by_the_oracle() {
    let rows = frozen_rows();
    let mut bad = Vec::new();
    let mut judged = 0;
    for row in rows.iter().filter(|r| ladder_crosses(r)) {
        let (_, cand) = fresh(row);
        if stage_drew(cand) {
            continue;
        }
        judged += 1;
        let (from, to) = docks_of(&row.docks);
        if let Some(found) = brute_force_route_avoiding(from, to, &machines_of(row)) {
            bad.push(format!(
                "docks {:?} machines {:?}: kept the crossing ladder, oracle found {found:?}",
                row.docks, row.machines
            ));
        }
    }
    assert!(judged > 0, "no walled-in row: the gate measured nothing");
    assert!(
        bad.is_empty(),
        "{} walled-in rows have a way round; first:\n{}",
        bad.len(),
        bad.first().map_or("", String::as_str)
    );
}

/// D-09'S KEEP RULE: on every row whose ladder path enters no machine, the stage draws
/// today's path, tiles and candidate.
#[test]
fn every_kept_row_is_todays_path() {
    let rows = frozen_rows();
    let mut bad = Vec::new();
    let mut judged = 0;
    for row in rows.iter().filter(|r| !ladder_crosses(r)) {
        judged += 1;
        let (from, to) = docks_of(&row.docks);
        let (g, cand) = wire_route_traced(from, to).expect("no corpus pair is coincident");
        let today: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
        if fresh(row) != (today, cand) || encode(&g) != row.tiles {
            bad.push(format!("docks {:?} machines {:?}", row.docks, row.machines));
        }
    }
    assert!(judged > 0, "no kept row: the gate measured nothing");
    assert!(
        bad.is_empty(),
        "{} kept rows are not today's path; first: {}",
        bad.len(),
        bad.first().map_or("", String::as_str)
    );
}

/// ORDER INDEPENDENCE: the machine list reversed, and rotated by one, routes every row to the
/// same tiles and candidate. Placement order is not part of a board's meaning.
#[test]
fn machine_order_never_changes_a_path() {
    let rows = frozen_rows();
    let mut bad = Vec::new();
    for row in &rows {
        let (from, to) = docks_of(&row.docks);
        let machines = machines_of(row);
        let mut reversed = machines.clone();
        reversed.reverse();
        let mut rotated = machines.clone();
        rotated.rotate_left(1);
        for (name, list) in [("reversed", &reversed), ("rotated", &rotated)] {
            let (g, cand) = wire_route_avoiding_traced(from, to, list).expect("routes");
            if encode(&g) != row.tiles || cand != row.cand {
                bad.push(format!("{name}: docks {:?} machines {:?}", row.docks, row.machines));
            }
        }
    }
    assert!(
        bad.is_empty(),
        "{} rows change with the machine order; first: {}",
        bad.len(),
        bad.first().map_or("", String::as_str)
    );
}

/// ZERO CHURN ON THE FIRST CORPUS: with no machines the stage is the ladder, tiles,
/// candidate and refusal, on all 3920 rows of `wire_corpus.expected.json`.
#[test]
fn wire_route_equals_wire_route_avoiding_with_no_machines() {
    #[derive(serde::Deserialize)]
    struct FirstRow {
        docks: [i32; 14],
    }
    let first: Vec<FirstRow> = serde_json::from_str(
        &std::fs::read_to_string(FIRST_CORPUS_PATH).expect("the first corpus is committed"),
    )
    .expect("the first corpus parses");
    assert_eq!(first.len(), 3920, "the first corpus is the 3920-row sweep");
    let mut bad = 0;
    for row in &first {
        let (from, to) = docks_of(&row.docks);
        let ladder = wire_route_traced(from, to);
        let stage = wire_route_avoiding_traced(from, to, &[]);
        let same = match (&ladder, &stage) {
            (Ok(a), Ok(b)) => a == b,
            (Err(WireRouteError::Coincident), Err(WireRouteError::Coincident)) => true,
            _ => false,
        };
        if !same {
            bad += 1;
        }
    }
    assert_eq!(bad, 0, "{bad} of 3920 first-corpus rows differ with no machines");
}

/// THE PINS: the frozen sweep and its extra rows reach every class at the freezer's numbers.
#[test]
fn the_sweep_reaches_every_class_at_the_frozen_counts() {
    let rows = frozen_rows();
    let (around, crowded, walled, kept) = classes(&rows);
    let (_, skipped) = corpus();
    assert_eq!(around, FROZEN_AROUND_MACHINES_ROWS, "around-machines rows");
    assert_eq!(crowded, FROZEN_CROWDED_ROWS, "crowded rows");
    assert_eq!(walled, FROZEN_WALLED_IN_ROWS, "walled-in rows");
    assert_eq!(kept, FROZEN_KEPT_CLEAR_ROWS, "kept-clear rows");
    assert_eq!(skipped, FROZEN_SKIPPED_SETS, "skipped machine sets");
    assert_eq!(rows.len(), around + crowded + walled + kept, "every row is in exactly one class");
}
