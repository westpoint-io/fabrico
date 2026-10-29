//! Phase 92 (CHROME-19, D-09): the wire router's OBSTACLE STAGE, pinned by literal cases.
//!
//! # What this file pins
//! - The three measured reproductions (`92-MEASURE.md` section 4, R1 to R3), each a cable
//!   the shipped ladder draws THROUGH a third machine: through
//!   `wire_route_avoiding_traced` they put no cell inside that machine, win
//!   `CAND_AROUND_MACHINES`, pass `route()`, and equal the paths the research prototype
//!   measured (`92-RESEARCH.md` Finding B), which the exhaustive oracle
//!   `brute_force_route_avoiding` (`tests/common/mod.rs`) agrees with cell for cell.
//! - That the two-argument ladder still crosses those machines at the measured cells, so
//!   D-09's keep-today's-path rule lives in the stage and nowhere else.
//! - That no machines, or only the two endpoint machines, means today's path exactly.
//! - The order of the machine list, the two named exceptions (the walled-in dock and the
//!   crowded corridor), the bound on the search, and totality over forged rectangles.
//!
//! R1 to R3 are router inputs, not catalog boards: MEASURE's 2x2 and 1x3 third machines are
//! not catalog footprints (`92-RESEARCH.md` Finding B's correction). Plan 92-03's host test
//! and live spec build catalog machines.
//!
//! The second, swept corpus lives in `tests/wire_obstacle_corpus.rs`.
//!
//! Run target: `cargo test -p fabrico-command --test wire_obstacles`

mod common;

use common::{brute_force_route_avoiding, in_rect};
use fabrico_command::route::route;
use fabrico_command::{
    CAND_AROUND_CROWDED, CAND_AROUND_MACHINES, MAX_AROUND_NODES, WireBody, WireDock,
    around_machines_lines,
    around_machines_window, wire_route, wire_route_avoiding, wire_route_avoiding_traced,
    wire_route_traced,
};

const E: u8 = 1;
const W: u8 = 3;

/// The `w` by `h` rectangle whose top-left cell is `(x, y)`.
fn rect(x: i32, y: i32, w: i32, h: i32) -> WireBody {
    WireBody {
        min_x: x,
        min_y: y,
        max_x: x + w - 1,
        max_y: y + h - 1,
    }
}

fn dock(cell: (i32, i32), side: u8, body: WireBody) -> WireDock {
    WireDock { cell, side, body }
}

/// One measured reproduction: the two docks, the third machines, the cells the ladder
/// enters, and the path the stage must draw.
struct Repro {
    name: &'static str,
    from: WireDock,
    to: WireDock,
    machines: Vec<WireBody>,
    ladder_inside: Vec<(i32, i32)>,
    around: Vec<(i32, i32)>,
}

fn repros() -> Vec<Repro> {
    vec![
        // R1: a straight run along row 0 from a 1x1 to a 3x3, a 2x2 in the way.
        Repro {
            name: "R1",
            from: dock((0, 0), E, rect(0, 0, 1, 1)),
            to: dock((8, 0), W, rect(8, -1, 3, 3)),
            machines: vec![rect(3, -1, 2, 2)],
            ladder_inside: vec![(3, 0), (4, 0)],
            around: vec![
                (0, 0),
                (1, 0),
                (2, 0),
                (2, 1),
                (3, 1),
                (4, 1),
                (5, 1),
                (6, 1),
                (7, 1),
                (7, 0),
                (8, 0),
            ],
        },
        // R2: `occlusionScene` wire A, a Z down column 5 through node 14 (2x2 at (4,3)).
        Repro {
            name: "R2",
            from: dock((0, 1), E, rect(0, 1, 1, 1)),
            to: dock((6, 4), W, rect(6, 4, 1, 1)),
            machines: vec![rect(4, 3, 2, 2)],
            ladder_inside: vec![(5, 3), (5, 4)],
            around: vec![
                (0, 1),
                (1, 1),
                (2, 1),
                (3, 1),
                (4, 1),
                (5, 1),
                (6, 1),
                (6, 2),
                (6, 3),
                (6, 4),
            ],
        },
        // R3: walk-114's reply cable leaving a 3x3 Handler's W face for a 1x1 Route, a 1x1
        // and a 1x3 in the way along row 1.
        Repro {
            name: "R3",
            from: dock((10, 1), W, rect(10, 0, 3, 3)),
            to: dock((0, 1), E, rect(0, 1, 1, 1)),
            machines: vec![rect(5, 1, 1, 1), rect(3, 0, 1, 3)],
            ladder_inside: vec![(5, 1), (3, 1)],
            around: vec![
                (10, 1),
                (9, 1),
                (8, 1),
                (7, 1),
                (6, 1),
                (6, 0),
                (6, -1),
                (5, -1),
                (4, -1),
                (3, -1),
                (2, -1),
                (1, -1),
                (1, 0),
                (1, 1),
                (0, 1),
            ],
        },
    ]
}

/// The cells of `tiles` that lie inside any of `machines`, in path order.
fn cells_inside(cells: &[(i32, i32)], machines: &[WireBody]) -> Vec<(i32, i32)> {
    cells
        .iter()
        .copied()
        .filter(|&c| machines.iter().any(|&m| in_rect(c, m)))
        .collect()
}

#[test]
fn a_cable_never_enters_a_third_machine_when_a_clear_path_exists() {
    for r in repros() {
        // The caller passes every machine on the board, the two endpoints included.
        let mut board = vec![r.to.body];
        board.extend(r.machines.iter().copied());
        board.push(r.from.body);
        let (g, cand) = wire_route_avoiding_traced(r.from, r.to, &board)
            .unwrap_or_else(|e| panic!("{}: the stage refused a routable pair: {e:?}", r.name));
        let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
        assert_eq!(
            cells_inside(&cells, &r.machines),
            Vec::<(i32, i32)>::new(),
            "{}: the cable entered a third machine",
            r.name
        );
        assert_eq!(cand, CAND_AROUND_MACHINES, "{}: the stage did not draw it", r.name);
        assert!(route(&cells).is_ok(), "{}: route() refuses the drawn cells", r.name);
        assert_eq!(cells, r.around, "{}: not the measured way around", r.name);
        // The literal is not the router's own output copied in: the exhaustive oracle,
        // which shares no code with the router, finds the same cable.
        assert_eq!(
            brute_force_route_avoiding(r.from, r.to, &board),
            Some(r.around.clone()),
            "{}: the exhaustive oracle disagrees with the literal",
            r.name
        );
    }
}

#[test]
fn the_ladder_alone_still_enters_the_third_machine() {
    for r in repros() {
        let g = wire_route(r.from, r.to).expect("the ladder routes every repro");
        let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
        assert_eq!(
            cells_inside(&cells, &r.machines),
            r.ladder_inside,
            "{}: the two-argument ladder must still cross at the measured cells, so the \
             avoidance lives in the stage and nowhere else",
            r.name
        );
    }
}

#[test]
fn no_machines_means_todays_path() {
    for r in repros() {
        let today = wire_route_traced(r.from, r.to).expect("the ladder routes every repro");
        let none = wire_route_avoiding_traced(r.from, r.to, &[]).expect("no machines");
        assert_eq!(none, today, "{}: an empty machine list changed the path", r.name);
        // The two endpoint bodies alone: the endpoint filter drops both.
        let ends = wire_route_avoiding_traced(r.from, r.to, &[r.from.body, r.to.body])
            .expect("only the endpoint machines");
        assert_eq!(
            ends, today,
            "{}: the endpoint machines were treated as obstacles",
            r.name
        );
        assert_eq!(
            wire_route_avoiding(r.from, r.to, &[r.to.body, r.from.body]).expect("plain form"),
            today.0,
            "{}: the plain form disagrees with the traced form",
            r.name
        );
    }
}

/// The repro's whole board, the way a caller passes it: the endpoints and the machines.
fn board_of(r: &Repro) -> Vec<WireBody> {
    let mut board = vec![r.to.body];
    board.extend(r.machines.iter().copied());
    board.push(r.from.body);
    board
}

/// Every permutation of `items` (Heap's algorithm), in a fixed order.
fn permutations(items: &[WireBody]) -> Vec<Vec<WireBody>> {
    fn heap(k: usize, a: &mut Vec<WireBody>, out: &mut Vec<Vec<WireBody>>) {
        if k <= 1 {
            out.push(a.clone());
            return;
        }
        for i in 0..k - 1 {
            heap(k - 1, a, out);
            if k.is_multiple_of(2) {
                a.swap(i, k - 1);
            } else {
                a.swap(0, k - 1);
            }
        }
        heap(k - 1, a, out);
    }
    let mut a = items.to_vec();
    let mut out = Vec::new();
    heap(a.len(), &mut a, &mut out);
    out
}

#[test]
fn obstacle_order_does_not_change_the_path() {
    let r3 = repros().into_iter().find(|r| r.name == "R3").expect("R3");
    let board = board_of(&r3);
    let want = wire_route_avoiding_traced(r3.from, r3.to, &board).expect("R3 routes");
    let perms = permutations(&board);
    assert_eq!(perms.len(), 24, "R3's board is four rectangles: 24 orders");
    for p in &perms {
        assert_eq!(
            wire_route_avoiding_traced(r3.from, r3.to, p).expect("routes"),
            want,
            "the machine order {p:?} changed R3's cable"
        );
    }
}

/// THE WALLED-IN DOCK, a named exception: the source port's every neighbour is inside a
/// machine, so no cable can leave it without crossing one. The stage keeps the ladder's path
/// and candidate, and the oracle agrees there is no way round. The swept corpus counts the
/// class (`FROZEN_WALLED_IN_ROWS`, `tests/wire_obstacle_corpus.rs`); this pins one literal.
#[test]
fn an_enclosed_dock_keeps_its_path_and_is_counted() {
    let from = dock((0, 0), E, rect(0, 0, 1, 1));
    let to = dock((6, 0), W, rect(6, 0, 1, 1));
    let walls = vec![
        rect(1, 0, 1, 1),
        rect(0, -1, 1, 1),
        rect(0, 1, 1, 1),
        rect(-1, 0, 1, 1),
    ];
    let today = wire_route_traced(from, to).expect("the ladder routes it");
    let cells: Vec<(i32, i32)> = today.0.tiles.iter().map(|t| t.cell).collect();
    assert_eq!(
        cells_inside(&cells, &walls),
        vec![(1, 0)],
        "precondition: the ladder's straight run enters the east wall"
    );
    let mut board = walls.clone();
    board.push(from.body);
    board.push(to.body);
    assert_eq!(
        brute_force_route_avoiding(from, to, &board),
        None,
        "precondition: the oracle finds no way out of the enclosed dock"
    );
    assert_eq!(
        wire_route_avoiding_traced(from, to, &board).expect("the stage stays total"),
        today,
        "a walled-in dock keeps today's path and candidate"
    );
}

/// THE BOUND (threat T-92-06): the search's line set holds at most ten lines per axis from
/// the two ends plus two per machine in the window, and a machine outside the window, or a
/// thousand of them, adds none. So one search costs what the machines near the cable cost,
/// never what the board holds.
#[test]
fn the_around_machines_search_is_bounded_by_its_lines_not_the_board() {
    for r in repros() {
        let board = board_of(&r);
        let window = around_machines_window(r.from, r.to, &board);
        let k = window.obstacles.len();
        assert_eq!(k, r.machines.len(), "{}: every third machine is in the window", r.name);
        let (xs, ys) = around_machines_lines(r.from, r.to, &window);
        assert!(
            xs.len() <= 10 + 2 * k && ys.len() <= 10 + 2 * k,
            "{}: {} x lines and {} y lines for {k} window machines",
            r.name,
            xs.len(),
            ys.len()
        );

        // A thousand machines far from the cable.
        let mut crowded = board.clone();
        for i in 0..1000 {
            crowded.push(rect(200 + 2 * (i % 40), 200 + 2 * (i / 40), 1, 1));
        }
        let far = around_machines_window(r.from, r.to, &crowded);
        assert_eq!(far, window, "{}: a distant machine joined the window", r.name);
        assert_eq!(
            around_machines_lines(r.from, r.to, &far),
            (xs, ys),
            "{}: a distant machine added a line",
            r.name
        );
        assert_eq!(
            wire_route_avoiding_traced(r.from, r.to, &crowded).expect("routes"),
            wire_route_avoiding_traced(r.from, r.to, &board).expect("routes"),
            "{}: distant machines changed the cable",
            r.name
        );
    }
}

/// TOTALITY OVER FORGED RECTANGLES (threat T-92-07): a board file can carry any four
/// integers. An inverted rectangle is folded as the ladder folds a forged body, a rectangle
/// reaching the integer bounds neither overflows nor panics, and a rectangle holding a dock
/// is dropped like an endpoint machine.
#[test]
fn forged_inverted_rectangles_route_totally() {
    let r1 = repros().into_iter().find(|r| r.name == "R1").expect("R1");
    let normal_way = wire_route_avoiding_traced(r1.from, r1.to, &r1.machines).expect("R1");

    // R1's machine written with both corners swapped.
    let inverted = WireBody {
        min_x: 4,
        min_y: 0,
        max_x: 3,
        max_y: -1,
    };
    assert_eq!(
        wire_route_avoiding_traced(r1.from, r1.to, &[inverted]).expect("total"),
        normal_way,
        "an inverted rectangle is the same machine"
    );

    // A machine reaching up to the integer bound over R1's crossing cells, written inverted.
    let to_the_bound = WireBody {
        min_x: 4,
        min_y: 0,
        max_x: 3,
        max_y: i32::MIN,
    };
    let (g, cand) = wire_route_avoiding_traced(r1.from, r1.to, &[to_the_bound]).expect("total");
    let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
    assert_eq!(cand, CAND_AROUND_MACHINES, "the stage still draws round it");
    assert_eq!(cells, r1.around, "round it by row 1, as R1");

    // Rectangles at every integer bound; the whole plane holds both docks and is dropped.
    let forged = [
        WireBody {
            min_x: i32::MIN,
            min_y: i32::MIN,
            max_x: i32::MAX,
            max_y: i32::MAX,
        },
        WireBody {
            min_x: i32::MAX,
            min_y: i32::MAX,
            max_x: i32::MAX,
            max_y: i32::MAX,
        },
        WireBody {
            min_x: i32::MIN,
            min_y: 5,
            max_x: i32::MAX,
            max_y: 5,
        },
        WireBody {
            min_x: i32::MAX,
            min_y: i32::MIN,
            max_x: i32::MIN,
            max_y: i32::MAX,
        },
    ];
    for r in repros() {
        let mut board = board_of(&r);
        board.extend(forged);
        let got = wire_route_avoiding_traced(r.from, r.to, &board);
        assert!(got.is_ok(), "{}: a forged rectangle made the stage refuse", r.name);
    }
}

/// THE GRID EDGE (review WR-A-01): a wall of five 3x3 machines whose last row is the grid's
/// last row (`GRID_MAX`, 512), between two 1x1 ends on row 510. Every body lies inside the
/// grid, so this is a board the editor can build. The shortest way round passes one row
/// below the grid, at 513, exactly as the ladder's own ring may; the stage used to clamp its
/// frame line onto 512, lose the free ring and go the long way over the top (37 cells, row
/// 497). The exhaustive oracle is the judge, cell for cell.
#[test]
fn a_cable_at_the_grid_edge_takes_the_oracle_way_round() {
    let from = dock((500, 510), E, rect(500, 510, 1, 1));
    let to = dock((510, 510), W, rect(510, 510, 1, 1));
    let wall: Vec<WireBody> = (0..5).map(|k| rect(504, 498 + 3 * k, 3, 3)).collect();
    assert_eq!(
        wall.last().map(|b| b.max_y),
        Some(fabrico_command::command::GRID_MAX),
        "precondition: the wall ends on the grid's last row"
    );
    let mut board = wall.clone();
    board.push(from.body);
    board.push(to.body);
    let oracle = brute_force_route_avoiding(from, to, &board).expect("a way round exists");
    assert_eq!(oracle.len(), 17, "precondition: the oracle's way round is 17 cells");
    let (g, cand) = wire_route_avoiding_traced(from, to, &board).expect("routes");
    let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
    assert_eq!(cand, CAND_AROUND_MACHINES, "the stage draws it");
    assert_eq!(cells_inside(&cells, &wall), Vec::<(i32, i32)>::new());
    assert_eq!(cells, oracle, "the stage's way round at the grid edge is the oracle's");
}

/// `(length, arrival missed, departure missed)` of a cable's cells, the first three keys of
/// the stage's cost order: a departure misses when the first step is not the source port's
/// normal, an arrival when the last step does not run against the target port's normal.
fn ranking(from: WireDock, to: WireDock, cells: &[(i32, i32)]) -> (usize, bool, bool) {
    let f = fabrico_command::wire_route::normal(from.side);
    let t = fabrico_command::wire_route::normal(to.side);
    let n = cells.len();
    let first = (cells[1].0 - cells[0].0, cells[1].1 - cells[0].1);
    let last = (cells[n - 1].0 - cells[n - 2].0, cells[n - 1].1 - cells[n - 2].1);
    (n, last != (-t.0, -t.1), first != f)
}

/// A field of `n` 1x1 machines with pairwise distinct columns and rows, every row from -20
/// up, so the window joins them all and the search's line set holds about `2n` lines on each
/// axis, plus one machine on the ladder's path so the stage runs.
fn scattered_field(from: WireDock, to: WireDock, n: i32) -> Vec<WireBody> {
    let (ladder, _) = wire_route_traced(from, to).expect("the ladder routes it");
    let mid = ladder.tiles[ladder.tiles.len() / 3].cell;
    let mut field = vec![rect(mid.0, mid.1, 1, 1)];
    for k in 0..n {
        let (x, y) = (4 + k, -20 + (37 * k).rem_euclid(n));
        let clash = in_rect((x, y), from.body)
            || in_rect((x, y), to.body)
            || ladder.tiles.iter().any(|t| t.cell == (x, y));
        if !clash {
            field.push(rect(x, y, 1, 1));
        }
    }
    field
}

/// THE CROWDED WINDOW (review WR-A-02): UI-SPEC 4.1 rule 1 has no machine-count exception.
/// A column of 65 touching machines (one over the old cap of 64, whose cable crossed the
/// column) and a field of a hundred machines at distinct coordinates both join one window; a
/// way round exists in each, so the cable enters no machine. The column's line set is small,
/// so its cable is the exhaustive optimum cell for cell (`CAND_AROUND_MACHINES`); the field's
/// is over `MAX_AROUND_NODES`, so it is walked cell by cell (`CAND_AROUND_CROWDED`) and still
/// has the optimum's length and both face keys.
#[test]
fn a_crowded_window_still_goes_round() {
    let from = dock((0, 0), E, rect(0, 0, 1, 1));
    let to = dock((4, 0), W, rect(4, 0, 1, 1));
    let column: Vec<WireBody> = (0..65).map(|k| rect(2, k, 1, 1)).collect();
    let mut board = column.clone();
    board.push(from.body);
    board.push(to.body);
    assert_eq!(around_machines_window(from, to, &board).obstacles.len(), 65, "precondition");
    let (g, cand) = wire_route_avoiding_traced(from, to, &board).expect("routes");
    assert_eq!(cand, CAND_AROUND_MACHINES, "the column's line set is small");
    let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
    assert_eq!(cells_inside(&cells, &column), Vec::<(i32, i32)>::new(), "the column");
    assert_eq!(Some(cells), brute_force_route_avoiding(from, to, &board), "the column's optimum");

    let from = dock((0, 0), E, rect(0, 0, 1, 1));
    let to = dock((110, 60), W, rect(110, 60, 1, 1));
    let field = scattered_field(from, to, 100);
    let mut board = field.clone();
    board.push(from.body);
    board.push(to.body);
    let window = around_machines_window(from, to, &board);
    assert_eq!(window.obstacles.len(), field.len(), "precondition: the whole field joins");
    let (xs, ys) = around_machines_lines(from, to, &window);
    assert!(xs.len() * ys.len() > MAX_AROUND_NODES, "precondition: the field crowds the lines");
    let (g, cand) = wire_route_avoiding_traced(from, to, &board).expect("routes");
    assert_eq!(cand, CAND_AROUND_CROWDED, "a crowded line set is walked cell by cell");
    let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
    assert_eq!(cells_inside(&cells, &field), Vec::<(i32, i32)>::new(), "the field");
    assert!(route(&cells).is_ok());
    let oracle = brute_force_route_avoiding(from, to, &board).expect("a way round exists");
    assert_eq!(
        ranking(from, to, &cells),
        ranking(from, to, &oracle),
        "the field's cable has the optimum's length and face keys"
    );
}

/// A DOCK NEIGHBOUR INSIDE A THIRD MACHINE IS NO END (review IN-A-02): two diagonal 1x1 ends
/// share two neighbours, and the one both faces want, `(1, 0)`, is a third machine. Were the
/// ends filtered against the two bodies and docks only, `(1, 0)` would be a start and a
/// finish at once, a cable of length zero through the machine. The oracle goes by `(0, 1)`.
#[test]
fn a_dock_neighbour_inside_a_third_machine_is_no_end() {
    let from = dock((0, 0), E, rect(0, 0, 1, 1));
    let to = dock((1, 1), 0, rect(1, 1, 1, 1));
    let third = rect(1, 0, 1, 1);
    let board = vec![third, from.body, to.body];
    let (g, cand) = wire_route_avoiding_traced(from, to, &board).expect("routes");
    let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
    assert_eq!(cand, CAND_AROUND_MACHINES);
    assert_eq!(cells, vec![(0, 0), (0, 1), (1, 1)]);
    assert_eq!(brute_force_route_avoiding(from, to, &board), Some(cells));
}

/// A FORGED BODY OFF ITS DOCK (review IN-A-02): the window starts from both bodies AND both
/// dock cells. Here the source body (column 0, rows 2 to 4) does not hold its dock `(0, 0)`
/// and the target body `(2, 2)` does not hold `(3, 0)`, so a window grown from the bodies
/// alone never reaches the third machine at `(1, -1)..(1, 0)`, and its search walked straight
/// through it. With the dock cells in the box the machine joins and the cable is the oracle's.
/// Found by a 200,000-board forged-body sweep against the oracle with the dock fold removed
/// (547 boards differed; with it, none).
#[test]
fn a_forged_body_off_its_dock_still_joins_the_window() {
    let from = dock((0, 0), E, rect(0, 2, 1, 3));
    let to = dock((3, 0), W, rect(2, 2, 1, 1));
    let third = rect(1, -1, 1, 2);
    let board = vec![third, from.body, to.body];
    let (g, cand) = wire_route_avoiding_traced(from, to, &board).expect("routes");
    let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
    assert_eq!(cand, CAND_AROUND_MACHINES);
    assert_eq!(cells_inside(&cells, &[third]), Vec::<(i32, i32)>::new());
    assert_eq!(Some(cells), brute_force_route_avoiding(from, to, &board));
}

/// A MACHINE GIVEN TWICE JOINS THE WINDOW ONCE (review IN-A-01): the obstacle filter
/// deduplicates, so a rectangle the list carries twice is one window obstacle and one set of
/// lines, and the window is the one the single copy makes.
#[test]
fn a_machine_given_twice_joins_the_window_once() {
    let r1 = repros().into_iter().find(|r| r.name == "R1").expect("R1");
    let once = board_of(&r1);
    let mut twice = once.clone();
    twice.push(r1.machines[0]);
    let w1 = around_machines_window(r1.from, r1.to, &once);
    let w2 = around_machines_window(r1.from, r1.to, &twice);
    assert_eq!(w2.obstacles.len(), 1, "the duplicate is one window obstacle");
    assert_eq!(w2, w1);
    assert_eq!(
        wire_route_avoiding_traced(r1.from, r1.to, &twice).expect("routes"),
        wire_route_avoiding_traced(r1.from, r1.to, &once).expect("routes")
    );
}

/// The window by its definition, the shipped repeat-until-stable scan (review WR-A-03 kept
/// it as the reference): from the box of both bodies and both docks, join every obstacle
/// touching the box inflated by one and grow the box, until a pass joins nothing.
fn window_by_definition(from: WireDock, to: WireDock, machines: &[WireBody]) -> Vec<WireBody> {
    let norm = |b: WireBody| WireBody {
        min_x: b.min_x.min(b.max_x),
        min_y: b.min_y.min(b.max_y),
        max_x: b.min_x.max(b.max_x),
        max_y: b.min_y.max(b.max_y),
    };
    let (p, q) = (norm(from.body), norm(to.body));
    let mut obstacles: Vec<WireBody> = machines
        .iter()
        .map(|&m| norm(m))
        .filter(|&m| !in_rect(from.cell, m) && !in_rect(to.cell, m))
        .collect();
    obstacles.sort_by_key(|b| (b.min_x, b.min_y, b.max_x, b.max_y));
    obstacles.dedup();
    let mut w = (
        p.min_x.min(q.min_x).min(from.cell.0).min(to.cell.0),
        p.min_y.min(q.min_y).min(from.cell.1).min(to.cell.1),
        p.max_x.max(q.max_x).max(from.cell.0).max(to.cell.0),
        p.max_y.max(q.max_y).max(from.cell.1).max(to.cell.1),
    );
    let mut joined = vec![false; obstacles.len()];
    loop {
        let mut grew = false;
        for (i, o) in obstacles.iter().enumerate() {
            if !joined[i] && w.0 - 1 <= o.max_x && w.2 + 1 >= o.min_x && w.1 - 1 <= o.max_y && w.3 + 1 >= o.min_y {
                joined[i] = true;
                grew = true;
                w = (w.0.min(o.min_x), w.1.min(o.min_y), w.2.max(o.max_x), w.3.max(o.max_y));
            }
        }
        if !grew {
            break;
        }
    }
    obstacles.into_iter().zip(joined).filter(|&(_, j)| j).map(|(o, _)| o).collect()
}

/// THE WINDOW IN `O(n log n)` (review WR-A-03): the four-sweep fixed point joins exactly the
/// machines the definition's repeat-until-stable scan joins, on a chain grown against the
/// sort order (one machine per pass for the scan), a spiral, and four hundred seeded boards
/// of scattered rectangles, some inverted.
#[test]
fn the_window_is_its_definitions_fixed_point() {
    let from = dock((0, 0), E, rect(0, 0, 1, 1));
    let to = dock((5, 0), W, rect(5, 0, 1, 1));
    let mut chain = vec![rect(2, 0, 1, 1)];
    for i in 1..=300 {
        chain.push(rect(-i, 1, 1, 1));
    }
    let want = window_by_definition(from, to, &chain);
    assert_eq!(want.len(), 301, "precondition: the whole chain joins");
    assert_eq!(around_machines_window(from, to, &chain).obstacles, want, "the chain");

    let mut spiral = Vec::new();
    let (mut x, mut y, mut len) = (8, 0, 2);
    for turn in 0..40 {
        let (dx, dy) = [(0, 1), (-1, 0), (0, -1), (1, 0)][turn % 4];
        for _ in 0..len {
            spiral.push(rect(x, y, 1, 1));
            x += dx;
            y += dy;
        }
        len += 1;
    }
    assert_eq!(
        around_machines_window(from, to, &spiral).obstacles,
        window_by_definition(from, to, &spiral),
        "the spiral"
    );

    let mut seed: u64 = 92;
    let mut next = |n: i32| -> i32 {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        i32::try_from((seed >> 33) % u64::try_from(n).expect("positive")).expect("small")
    };
    for _ in 0..400 {
        let k = 1 + next(40);
        let mut board = Vec::new();
        for _ in 0..k {
            let (x, y, w, h) = (next(41) - 20, next(41) - 20, next(4) - 1, next(4) - 1);
            board.push(WireBody { min_x: x, min_y: y, max_x: x + w, max_y: y + h });
        }
        assert_eq!(
            around_machines_window(from, to, &board).obstacles,
            window_by_definition(from, to, &board),
            "seeded board {board:?}"
        );
    }
}

/// THE OBSTACLE STAGE'S COST (review WR-A-02 and WR-A-03, threats T-92-06 and T-92-10), one
/// `BENCH` line per case, mean milliseconds per call:
/// - `field64`: the old cap's worst case, 64 machines at distinct coordinates in one window
///   (the security audit's 8.9 ms);
/// - `snake4000`: a 4000-machine touching chain inside the grid, four columns of 1000 joined
///   end to end, with ten cables crossing it (the review's 4000-machine chain);
/// - `forged6400`: a hundred 100-cell tiles, each with 64 machines at distinct coordinates
///   and one cable corner to corner, all 6400 machines handed to every cable (the audit's
///   forged board, 409.6 ms per build).
///
/// Run: `cargo test -p fabrico-command --test wire_obstacles --release -- --ignored
/// --nocapture bench_obstacle_stage`.
#[test]
#[ignore = "a timing bench, run by hand in release"]
#[allow(clippy::disallowed_types, clippy::disallowed_methods)]
fn bench_obstacle_stage() {
    use std::time::Instant;
    let time = |reps: u32, f: &mut dyn FnMut()| -> f64 {
        f();
        let t = Instant::now();
        for _ in 0..reps {
            f();
        }
        t.elapsed().as_secs_f64() * 1000.0 / f64::from(reps)
    };
    let one = |x: i32, y: i32| rect(x, y, 1, 1);

    // field64.
    let from = dock((0, 0), E, one(0, 0));
    let to = dock((300, 300), W, one(300, 300));
    let (g, _) = wire_route_traced(from, to).expect("routes");
    let mid = g.tiles[g.tiles.len() / 3].cell;
    let mut field = vec![one(mid.0, mid.1)];
    let mut k = 1;
    while field.len() < 64 {
        let (x, y) = (4 + (k * 37) % 290, 4 + (k * 101) % 290);
        k += 1;
        if x != mid.0 && y != mid.1 {
            field.push(one(x, y));
        }
    }
    let (_, cand) = wire_route_avoiding_traced(from, to, &field).expect("routes");
    let ms = time(20, &mut || {
        std::hint::black_box(wire_route_avoiding_traced(from, to, &field).expect("routes"));
    });
    println!("BENCH field64 cand={cand} per_call_ms={ms:.3}");
    // The largest field whose line set the line search still takes: the costliest
    // `CAND_AROUND_MACHINES` call.
    let mut largest = field.clone();
    loop {
        let window = around_machines_window(from, to, &largest);
        let (xs, ys) = around_machines_lines(from, to, &window);
        if xs.len() * ys.len() <= MAX_AROUND_NODES {
            break;
        }
        largest.pop();
    }
    let window = around_machines_window(from, to, &largest);
    let (xs, ys) = around_machines_lines(from, to, &window);
    let (_, cand) = wire_route_avoiding_traced(from, to, &largest).expect("routes");
    let ms = time(20, &mut || {
        std::hint::black_box(wire_route_avoiding_traced(from, to, &largest).expect("routes"));
    });
    println!(
        "BENCH field_at_node_cap machines={} nodes={} cand={cand} per_call_ms={ms:.3}",
        largest.len(),
        xs.len() * ys.len()
    );

    // snake4000: columns at x = 0, 2, 4, 6, rows -500..=499, joined alternately at the top and
    // the bottom by one machine in the gap column.
    let mut snake = Vec::new();
    for c in 0..4 {
        for y in -500..500 {
            snake.push(one(2 * c, y));
        }
    }
    for c in 0..3 {
        snake.push(one(2 * c + 1, if c % 2 == 0 { -500 } else { 499 }));
    }
    let snake: Vec<WireBody> = snake.into_iter().take(4000).collect();
    let cables: Vec<(WireDock, WireDock)> = (0..10)
        .map(|i| {
            let y = -400 + 90 * i;
            (dock((-6, y), E, one(-6, y)), dock((12, y), W, one(12, y)))
        })
        .collect();
    let mut cands = Vec::new();
    for &(f, t) in &cables {
        let mut board = snake.clone();
        board.push(f.body);
        board.push(t.body);
        let (g, c) = wire_route_avoiding_traced(f, t, &board).expect("routes");
        let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
        assert_eq!(cells_inside(&cells, &snake), Vec::<(i32, i32)>::new(), "snake cable");
        cands.push(c);
    }
    let ms = time(5, &mut || {
        for &(f, t) in &cables {
            std::hint::black_box(wire_route_avoiding_traced(f, t, &snake).expect("routes"));
        }
    });
    println!("BENCH snake4000 machines={} cables=10 cands={cands:?} ten_cables_ms={ms:.3}", snake.len());

    // forged6400.
    let mut board = Vec::new();
    let mut pairs = Vec::new();
    for ty in 0..10 {
        for tx in 0..10 {
            let (ox, oy) = (-510 + tx * 102, -510 + ty * 102);
            let f = dock((ox, oy), E, one(ox, oy));
            let t = dock((ox + 98, oy + 98), W, one(ox + 98, oy + 98));
            let (g, _) = wire_route_traced(f, t).expect("routes");
            let mid = g.tiles[g.tiles.len() / 3].cell;
            let mut m = vec![one(mid.0, mid.1)];
            let mut k = 1;
            while m.len() < 64 && k < 5000 {
                let (x, y) = (ox + 2 + (k * 37) % 95, oy + 2 + (k * 61) % 95);
                k += 1;
                if x != mid.0 && y != mid.1 && !m.iter().any(|q| q.min_x == x || q.min_y == y) {
                    m.push(one(x, y));
                }
            }
            board.extend(m);
            pairs.push((f, t));
        }
    }
    let mut cands = [0_usize; 8];
    for &(f, t) in &pairs {
        let (_, c) = wire_route_avoiding_traced(f, t, &board).expect("routes");
        cands[usize::from(c)] += 1;
    }
    let ms = time(3, &mut || {
        for &(f, t) in &pairs {
            std::hint::black_box(wire_route_avoiding_traced(f, t, &board).expect("routes"));
        }
    });
    println!("BENCH forged6400 machines={} cables=100 cands={cands:?} hundred_cables_ms={ms:.3}", board.len());
}
