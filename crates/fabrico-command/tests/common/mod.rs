//! Shared by the wire router's test binaries (`wire_corpus.rs`, `wire_side_aware.rs`,
//! `wire_golden.rs`, and since phase 92 `wire_obstacles.rs` and `wire_obstacle_corpus.rs`),
//! plan 75-02: ONE body placement rule, ONE degenerate list and ONE
//! independent oracle, so no test file carries its own copy of any of them.
//!
//! - [`place_body`]: the corpus's placement rule, moved here verbatim from
//!   `wire_corpus.rs` so the physical sweep in `wire_side_aware.rs` places a 3x3 body
//!   exactly where the corpus does.
//! - The degenerate list: [`p1_same_cell`] and [`p2_touching_one_facing`], moved here
//!   verbatim from `wire_side_aware.rs`, where plan 75-01 committed them BEFORE the router
//!   changed, plus [`p3a_faces_into_body_clear_exists`] and
//!   [`p3b_faces_into_body_no_clear_connection`] for real machine sizes (D-03), committed
//!   before plan 75-03's candidate for that class exists. Every predicate reads the docks
//!   and bodies only, never a built path.
//! - [`brute_force_route`]: an exhaustive search that shares no code with
//!   `src/wire_route.rs` (it calls only `normal`), so a check comparing the router with it
//!   can actually fail.
//! - [`brute_force_route_relaxed`] (plan 75-03): the same exhaustive search with RELAXED
//!   ends, the definition of candidate 4 (`CAND_CLEAR_OF_BODIES`), equally independent.
//! - [`brute_force_route_avoiding`] (phase 92, D-09): the relaxed search with every third
//!   machine blocked too, the definition of candidate 5 (`CAND_AROUND_MACHINES`), equally
//!   independent; read by `wire_obstacles.rs` and `wire_obstacle_corpus.rs`.
//!
//! Each test binary uses part of this module, hence the `dead_code` allowance.
#![allow(dead_code)] // not every helper is used by every test binary

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use fabrico_command::wire_route::normal;
use fabrico_command::{WireBody, WireDock};

/// A 1x1 dock at `(x, y)` facing `side`: its body is its own cell.
pub fn dock(x: i32, y: i32, side: u8) -> WireDock {
    WireDock {
        cell: (x, y),
        side,
        body: WireBody {
            min_x: x,
            min_y: y,
            max_x: x,
            max_y: y,
        },
    }
}

/// `b - a` as a step.
pub fn step(a: (i32, i32), b: (i32, i32)) -> (i32, i32) {
    (b.0 - a.0, b.1 - a.1)
}

/// The first and last step of a cable of at least two cells.
pub fn end_steps(cells: &[(i32, i32)]) -> ((i32, i32), (i32, i32)) {
    let n = cells.len();
    (step(cells[0], cells[1]), step(cells[n - 2], cells[n - 1]))
}

/// The inward direction at a target port: the negated outward normal.
pub fn inward(side: u8) -> (i32, i32) {
    let t = normal(side);
    (-t.0, -t.1)
}

/// Whether `c` is inside the inclusive rectangle `b` (either corner order).
pub fn in_rect(c: (i32, i32), b: WireBody) -> bool {
    let (x0, x1) = (b.min_x.min(b.max_x), b.min_x.max(b.max_x));
    let (y0, y1) = (b.min_y.min(b.max_y), b.min_y.max(b.max_y));
    c.0 >= x0 && c.0 <= x1 && c.1 >= y0 && c.1 <= y1
}

/// Whether two inclusive rectangles share a cell.
pub fn rects_overlap(a: WireBody, b: WireBody) -> bool {
    a.min_x <= b.max_x && a.max_x >= b.min_x && a.min_y <= b.max_y && a.max_y >= b.min_y
}

/// The body rectangle of a machine of resolved extent `(w, h)` whose port sits at `cell` on
/// the face `side` names, CENTRED on that face.
///
/// This is the corpus's own placement rule and NOT a mirror of anything in the router: the
/// router is handed the finished rectangle. The rule exists so a 3x3 body is placed where a
/// real 3x3 machine with that port would be, rather than somewhere that makes the sweep
/// easy.
pub fn place_body(cell: (i32, i32), side: u8, w: i32, h: i32) -> WireBody {
    let (x, y) = cell;
    match side {
        // N: the dock is the top row, centred on x; the body extends SOUTH.
        0 => WireBody {
            min_x: x - (w - 1) / 2,
            min_y: y,
            max_x: x - (w - 1) / 2 + w - 1,
            max_y: y + h - 1,
        },
        // E: the dock is the right column, centred on y; the body extends WEST.
        1 => WireBody {
            min_x: x - (w - 1),
            min_y: y - (h - 1) / 2,
            max_x: x,
            max_y: y - (h - 1) / 2 + h - 1,
        },
        // S: the dock is the bottom row, centred on x; the body extends NORTH.
        2 => WireBody {
            min_x: x - (w - 1) / 2,
            min_y: y - (h - 1),
            max_x: x - (w - 1) / 2 + w - 1,
            max_y: y,
        },
        // W: the dock is the left column, centred on y; the body extends EAST.
        _ => WireBody {
            min_x: x,
            min_y: y - (h - 1) / 2,
            max_x: x + w - 1,
            max_y: y - (h - 1) / 2 + h - 1,
        },
    }
}

/// P1, SAME CELL. Reason: a path with both ends on one cell has no steps, so it has no
/// first step and no last step to honour anything with.
pub fn p1_same_cell(from: WireDock, to: WireDock) -> bool {
    from.cell == to.cell
}

/// P2, TOUCHING WITH ONE PORT FACING STRAIGHT AT THE OTHER CELL WHILE THE OTHER FACING
/// DISAGREES. Reason: the port that faces the other cell must step onto it at once, so
/// any path that honours the other end too would have to leave that cell and come back to
/// it, revisiting a cell, which `route()` refuses.
///
/// Written exactly as D-03 states it: `A + f == B && B + t != A`, or
/// `B + t == A && A + f != B`.
pub fn p2_touching_one_facing(from: WireDock, to: WireDock) -> bool {
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;
    let f = normal(from.side);
    let t = normal(to.side);
    let a_faces_b = (ax + f.0, ay + f.1) == (bx, by);
    let b_faces_a = (bx + t.0, by + t.1) == (ax, ay);
    (a_faces_b && !b_faces_a) || (b_faces_a && !a_faces_b)
}

/// A port FACES INTO THE OTHER MACHINE'S BODY: its stub cell (one step out along its own
/// normal) lies inside the other machine's body on a cell that is not the other dock (that
/// case is touching, P2). Only real machine sizes reach this; a 1x1 body is its own dock.
fn faces_into_other_body(from: WireDock, to: WireDock) -> bool {
    let f = normal(from.side);
    let t = normal(to.side);
    let a1 = (from.cell.0 + f.0, from.cell.1 + f.1);
    let b1 = (to.cell.0 + t.0, to.cell.1 + t.1);
    (in_rect(a1, to.body) && a1 != to.cell) || (in_rect(b1, from.body) && b1 != from.cell)
}

/// Whether `d` has a free orthogonal neighbour: a cell next to its dock outside BOTH
/// bodies, i.e. somewhere a cable could leave or reach that dock without crossing a machine.
fn has_free_neighbour(d: WireDock, from: WireDock, to: WireDock) -> bool {
    (0u8..4).any(|s| {
        let n = normal(s);
        let c = (d.cell.0 + n.0, d.cell.1 + n.1);
        !in_rect(c, from.body) && !in_rect(c, to.body)
    })
}

/// P3a, A PORT FACES INTO THE NEIGHBOUR'S BODY AND A BODY-CLEAR CONNECTION EXISTS (every
/// dock has a free orthogonal neighbour outside both bodies). Reason: the facing port's
/// first (or the target's last) step along its normal would enter the other machine, so a
/// cable that honours that face must cross a machine; one that stays clear of both bodies
/// has to leave or arrive from a side. Plan 75-03's candidate serves this class.
pub fn p3a_faces_into_body_clear_exists(from: WireDock, to: WireDock) -> bool {
    faces_into_other_body(from, to)
        && has_free_neighbour(from, from, to)
        && has_free_neighbour(to, from, to)
}

/// P3b, A PORT FACES INTO THE NEIGHBOUR'S BODY AND ONE DOCK HAS NO FREE ORTHOGONAL
/// NEIGHBOUR OUTSIDE BOTH BODIES. Reason: every cell next to that dock is inside a machine,
/// so no connection at all can avoid crossing one; the cable is admitted as crossing.
pub fn p3b_faces_into_body_no_clear_connection(from: WireDock, to: WireDock) -> bool {
    faces_into_other_body(from, to)
        && !(has_free_neighbour(from, from, to) && has_free_neighbour(to, from, to))
}

/// The name of the degenerate shape `(from, to)` belongs to, in the order the predicates
/// are checked (P1, P2, P3a, P3b), or `None` when neither end is excused.
pub fn admitted(from: WireDock, to: WireDock) -> Option<&'static str> {
    if p1_same_cell(from, to) {
        Some("P1")
    } else if p2_touching_one_facing(from, to) {
        Some("P2")
    } else if p3a_faces_into_body_clear_exists(from, to) {
        Some("P3a")
    } else if p3b_faces_into_body_no_clear_connection(from, to) {
        Some("P3b")
    } else {
        None
    }
}

/// How far the brute-force search box reaches beyond the two bodies, in cells.
pub const BRUTE_FORCE_MARGIN: i32 = 6;

/// THE INDEPENDENT ORACLE (plan 75-02): the side-correct cable from `from` to `to` found
/// by an EXHAUSTIVE search over `(cell, heading)`, or `None` when no such cable exists in
/// the box.
///
/// # Why it exists
/// A gate that compares the router with itself cannot fail. The corpus fixture is written
/// by the router's own freezer, so `wire_corpus_matches_frozen` says only "unchanged",
/// never "right". This function says "right": it is written from the DEFINITION of the
/// go-around (75-RESEARCH Pattern 2) and calls nothing in `src/wire_route.rs` except
/// `normal` (the side numbering, which is not a routing decision). Where the router and
/// this search agree cell for cell, the router's compressed line set lost nothing.
///
/// # The definition
/// - The cable is `[A] ++ walk ++ [B]` where the walk runs from the source stub
///   `A1 = A + f` to the target stub `B1 = B + t`, `f` and `t` the two outward normals.
/// - No walk cell is in either body or on either dock. If a stub is, there is no cable.
/// - Cost is `(length, bends)`, compared length first. A bend is counted at `A1` if the
///   first move is not `f`, at `B1` if the last move is not `-t`, and at every turn between.
/// - The answer is canonical: a backward Dijkstra from `B1` fills the least cost-to-go for
///   every `(cell, heading)`, then a forward walk from `(A1, f)` takes at every cell the
///   first move in the order straight, N, E, S, W that keeps the remaining optimum.
///
/// # The box, and why it is NOT clipped to the router's corridor
/// The search runs over every cell of the two bodies' (and docks') bounding box inflated by
/// [`BRUTE_FORCE_MARGIN`] cells on every side, cell by cell. It is deliberately wider than
/// the corridor the router's ring and line set live in (the union box inflated by one): a
/// router that wrongly clipped its search to that corridor would miss a shorter path
/// outside it, and only a search that can see outside it can say so. The box is checked,
/// not trusted: if the canonical walk ever touches its border, a wider box might hold a
/// different optimum, so this function PANICS rather than answer from a box that may be
/// too small.
pub fn brute_force_route(from: WireDock, to: WireDock) -> Option<Vec<(i32, i32)>> {
    let a = from.cell;
    let b = to.cell;
    if a == b {
        return None;
    }
    let f = normal(from.side);
    let t = normal(to.side);
    let headings: [(i32, i32); 4] = [normal(0), normal(1), normal(2), normal(3)];
    let h_first = headings.iter().position(|&v| v == f)?;
    let nt = (-t.0, -t.1);
    let h_last = headings.iter().position(|&v| v == nt)?;

    let blocked = |c: (i32, i32)| -> bool {
        in_rect(c, from.body) || in_rect(c, to.body) || c == a || c == b
    };
    let a1 = (a.0 + f.0, a.1 + f.1);
    let b1 = (b.0 + t.0, b.1 + t.1);
    if blocked(a1) || blocked(b1) {
        return None;
    }

    // The box: both bodies and both docks, inflated by the margin.
    let xs = [
        from.body.min_x,
        from.body.max_x,
        to.body.min_x,
        to.body.max_x,
        a.0,
        b.0,
    ];
    let ys = [
        from.body.min_y,
        from.body.max_y,
        to.body.min_y,
        to.body.max_y,
        a.1,
        b.1,
    ];
    let x0 = xs.iter().copied().min()? - BRUTE_FORCE_MARGIN;
    let x1 = xs.iter().copied().max()? + BRUTE_FORCE_MARGIN;
    let y0 = ys.iter().copied().min()? - BRUTE_FORCE_MARGIN;
    let y1 = ys.iter().copied().max()? + BRUTE_FORCE_MARGIN;
    let w = usize::try_from(x1 - x0 + 1).ok()?;
    let h = usize::try_from(y1 - y0 + 1).ok()?;
    let index = |c: (i32, i32)| -> Option<usize> {
        if c.0 < x0 || c.0 > x1 || c.1 < y0 || c.1 > y1 || blocked(c) {
            return None;
        }
        let cx = usize::try_from(c.0 - x0).ok()?;
        let cy = usize::try_from(c.1 - y0).ok()?;
        Some(cy * w + cx)
    };
    let cell_of = |i: usize| -> (i32, i32) {
        (
            x0 + i32::try_from(i % w).unwrap_or(0),
            y0 + i32::try_from(i / w).unwrap_or(0),
        )
    };
    let bend = |p: usize, q: usize| -> i32 { i32::from(p != q) };

    // Backward Dijkstra: `cost[i * 4 + d]` is the least (length, bends) from standing on
    // cell `i` having arrived along heading `d`, to standing on `B1` with the last move
    // along `-t`.
    let fin = index(b1)?;
    let mut cost: Vec<Option<(i32, i32)>> = vec![None; w * h * 4];
    let mut heap = BinaryHeap::new();
    for d in 0..4 {
        let c = (0, bend(d, h_last));
        cost[fin * 4 + d] = Some(c);
        heap.push(Reverse((c, fin, d)));
    }
    while let Some(Reverse((c, m, d))) = heap.pop() {
        if cost[m * 4 + d] != Some(c) {
            continue;
        }
        // The cell one step back along `d` reaches `m` by moving along `d`.
        let mc = cell_of(m);
        let Some(p) = index((mc.0 - headings[d].0, mc.1 - headings[d].1)) else {
            continue;
        };
        for hp in 0..4 {
            let nc = (c.0 + 1, c.1 + bend(hp, d));
            if cost[p * 4 + hp].is_none_or(|o| nc < o) {
                cost[p * 4 + hp] = Some(nc);
                heap.push(Reverse((nc, p, hp)));
            }
        }
    }

    // Forward canonical walk from `(A1, f)`: straight first, then N, E, S, W.
    let mut cur = index(a1)?;
    let mut hd = h_first;
    let mut c = cost[cur * 4 + hd]?;
    let mut cells = vec![a, a1];
    while c.0 != 0 {
        let here = cell_of(cur);
        let mut moved = false;
        for d in [hd, 0, 1, 2, 3] {
            let Some(q) = index((here.0 + headings[d].0, here.1 + headings[d].1)) else {
                continue;
            };
            let Some(qc) = cost[q * 4 + d] else {
                continue;
            };
            if (1 + qc.0, bend(hd, d) + qc.1) == c {
                let qcell = cell_of(q);
                assert!(
                    qcell.0 > x0 && qcell.0 < x1 && qcell.1 > y0 && qcell.1 < y1,
                    "brute_force_route: the walk for {from:?} -> {to:?} reached the border of \
                     its box at {qcell:?}; the box may be too small to be exhaustive"
                );
                cells.push(qcell);
                cur = q;
                hd = d;
                c = qc;
                moved = true;
                break;
            }
        }
        if !moved {
            return None;
        }
    }
    cells.push(b);
    Some(cells)
}

/// THE RELAXED-END ORACLE (plan 75-03, threat T-75-11): the shortest cable from `from` to
/// `to` that crosses NEITHER machine, found by an exhaustive search over `(cell, heading)`,
/// or `None` when no such cable exists in the box (a dock has no free neighbour).
///
/// # Why it exists
/// Candidate 4 (`CAND_CLEAR_OF_BODIES`) serves a port facing straight into the
/// neighbour's body, where a cable that honours that face must cross the neighbour. D-04
/// says such a pair is DRAWN: the shortest connection crossing neither machine, a straight
/// arrival preferred. This function is that sentence written as an exhaustive search, from
/// the definition and not from the router: it calls nothing in `src/wire_route.rs` except
/// `normal`, so the router agreeing with it cell for cell means something.
///
/// # The definition
/// - The cable is `[A] ++ walk ++ [B]`. The walk starts on ANY orthogonal neighbour of `A`
///   and finishes on ANY orthogonal neighbour of `B`, each outside both bodies and off both
///   docks. No walk cell is in either body or on either dock.
/// - Cost is `(length, arrival missed, departure missed, bends)`, compared in that order.
///   "Arrival missed" is 1 when the last step (finish cell to `B`) is not `-t`; "departure
///   missed" is 1 when the first step (`A` to the start cell) is not `f`. A bend is counted
///   at the start cell if the walk's first move differs from the `A`-to-start step, at the
///   finish cell if its last move differs from the finish-to-`B` step, and at every turn
///   between. Length first, then a straight ARRIVAL before a straight departure: the arrival
///   end wins ties because a wrong arrival is a lie about which port the cable is in.
/// - The answer is canonical: a backward Dijkstra from every finish fills the least
///   cost-to-go for every `(cell, heading)`; the start is the first neighbour of `A` in the
///   order `f`, N, E, S, W that achieves the optimum; then the forward walk takes at every
///   cell the first move in the order straight, N, E, S, W that keeps the remaining optimum.
///
/// The box is [`brute_force_route`]'s (both bodies and docks inflated by
/// [`BRUTE_FORCE_MARGIN`]), checked the same way: the walk touching its border panics.
pub fn brute_force_route_relaxed(from: WireDock, to: WireDock) -> Option<Vec<(i32, i32)>> {
    let a = from.cell;
    let b = to.cell;
    if a == b {
        return None;
    }
    let f = normal(from.side);
    let t = normal(to.side);
    let headings: [(i32, i32); 4] = [normal(0), normal(1), normal(2), normal(3)];
    let h_f = headings.iter().position(|&v| v == f)?;
    let nt = (-t.0, -t.1);
    let h_nt = headings.iter().position(|&v| v == nt)?;
    let blocked = |c: (i32, i32)| -> bool {
        in_rect(c, from.body) || in_rect(c, to.body) || c == a || c == b
    };

    let xs = [
        from.body.min_x,
        from.body.max_x,
        to.body.min_x,
        to.body.max_x,
        a.0,
        b.0,
    ];
    let ys = [
        from.body.min_y,
        from.body.max_y,
        to.body.min_y,
        to.body.max_y,
        a.1,
        b.1,
    ];
    let x0 = xs.iter().copied().min()? - BRUTE_FORCE_MARGIN;
    let x1 = xs.iter().copied().max()? + BRUTE_FORCE_MARGIN;
    let y0 = ys.iter().copied().min()? - BRUTE_FORCE_MARGIN;
    let y1 = ys.iter().copied().max()? + BRUTE_FORCE_MARGIN;
    let w = usize::try_from(x1 - x0 + 1).ok()?;
    let h = usize::try_from(y1 - y0 + 1).ok()?;
    let index = |c: (i32, i32)| -> Option<usize> {
        if c.0 < x0 || c.0 > x1 || c.1 < y0 || c.1 > y1 || blocked(c) {
            return None;
        }
        let cx = usize::try_from(c.0 - x0).ok()?;
        let cy = usize::try_from(c.1 - y0).ok()?;
        Some(cy * w + cx)
    };
    let cell_of = |i: usize| -> (i32, i32) {
        (
            x0 + i32::try_from(i % w).unwrap_or(0),
            y0 + i32::try_from(i / w).unwrap_or(0),
        )
    };
    let bend = |p: usize, q: usize| -> i32 { i32::from(p != q) };

    // Backward Dijkstra over (length, arrival missed, bends). Every free neighbour of `B`
    // is a finish: standing on it having arrived along `d`, the cable ends with the step
    // into `B`, whose heading is `k` (the finish is `B - headings[k]`).
    let mut cost: Vec<Option<(i32, i32, i32)>> = vec![None; w * h * 4];
    let mut heap = BinaryHeap::new();
    for (k, hk) in headings.iter().enumerate() {
        let fc = (b.0 - hk.0, b.1 - hk.1);
        let Some(fi) = index(fc) else {
            continue;
        };
        for d in 0..4 {
            let c = (0, i32::from(k != h_nt), bend(d, k));
            if cost[fi * 4 + d].is_none_or(|o| c < o) {
                cost[fi * 4 + d] = Some(c);
                heap.push(Reverse((c, fi, d)));
            }
        }
    }
    while let Some(Reverse((c, m, d))) = heap.pop() {
        if cost[m * 4 + d] != Some(c) {
            continue;
        }
        let mc = cell_of(m);
        let Some(p) = index((mc.0 - headings[d].0, mc.1 - headings[d].1)) else {
            continue;
        };
        for hp in 0..4 {
            let nc = (c.0 + 1, c.1, c.2 + bend(hp, d));
            if cost[p * 4 + hp].is_none_or(|o| nc < o) {
                cost[p * 4 + hp] = Some(nc);
                heap.push(Reverse((nc, p, hp)));
            }
        }
    }

    // The start: the first neighbour of `A`, in the order f, N, E, S, W, whose total
    // (length, arrival missed, departure missed, bends) is the least.
    let total = |d: usize| -> Option<(i32, i32, i32, i32)> {
        let s = index((a.0 + headings[d].0, a.1 + headings[d].1))?;
        let c = cost[s * 4 + d]?;
        Some((c.0, c.1, i32::from(d != h_f), c.2))
    };
    let order = [h_f, 0, 1, 2, 3];
    let best = order.iter().filter_map(|&d| total(d)).min()?;
    let d0 = *order.iter().find(|&&d| total(d) == Some(best))?;
    let mut cur = index((a.0 + headings[d0].0, a.1 + headings[d0].1))?;
    let mut hd = d0;
    let mut c = cost[cur * 4 + hd]?;
    let mut cells = vec![a, cell_of(cur)];
    while c.0 != 0 {
        let here = cell_of(cur);
        let mut moved = false;
        for d in [hd, 0, 1, 2, 3] {
            let Some(q) = index((here.0 + headings[d].0, here.1 + headings[d].1)) else {
                continue;
            };
            let Some(qc) = cost[q * 4 + d] else {
                continue;
            };
            if (1 + qc.0, qc.1, bend(hd, d) + qc.2) == c {
                let qcell = cell_of(q);
                assert!(
                    qcell.0 > x0 && qcell.0 < x1 && qcell.1 > y0 && qcell.1 < y1,
                    "brute_force_route_relaxed: the walk for {from:?} -> {to:?} reached the \
                     border of its box at {qcell:?}; the box may be too small"
                );
                cells.push(qcell);
                cur = q;
                hd = d;
                c = qc;
                moved = true;
                break;
            }
        }
        if !moved {
            return None;
        }
    }
    cells.push(b);
    Some(cells)
}

/// THE AVOIDING ORACLE (phase 92, D-09, threat T-92-08): the shortest cable from `from` to
/// `to` that crosses neither endpoint machine NOR any machine in `machines`, found by an
/// exhaustive search over `(cell, heading)`, or `None` when no such cable exists (a dock is
/// walled in).
///
/// # Why it exists
/// The obstacle stage (`wire_route_avoiding`) claims that whenever the ladder's path enters
/// a third machine and a way round exists, it draws the shortest way round, ranked
/// `(length, arrival missed, departure missed, bends)`, inside a window it closes around
/// the machines near the two ends. This function is that claim written from the
/// DEFINITION and not from the router: it is [`brute_force_route_relaxed`] with one more
/// blocked predicate, and it calls nothing in `src/wire_route.rs` except `normal`. So the
/// router agreeing with it cell for cell means the window and the line set lost nothing.
///
/// # The definition
/// - The obstacles are `machines` minus every rectangle that contains either dock cell (the
///   two endpoint machines, or a machine under a free-drag pointer), either corner order.
/// - A cell is blocked when it is in either body, on either dock, or in any obstacle.
/// - Everything else is [`brute_force_route_relaxed`]'s: relaxed ends, the same cost order,
///   the same canonical start and walk.
///
/// # The box
/// Both bodies, both docks and EVERY obstacle (not only those near the ends: a router that
/// clipped its window too tightly would miss a shorter path through the space a far machine
/// bounds), inflated by [`BRUTE_FORCE_MARGIN`]. Checked, not trusted: the walk touching the
/// box border panics.
pub fn brute_force_route_avoiding(
    from: WireDock,
    to: WireDock,
    machines: &[WireBody],
) -> Option<Vec<(i32, i32)>> {
    let a = from.cell;
    let b = to.cell;
    if a == b {
        return None;
    }
    let obstacles: Vec<WireBody> = machines
        .iter()
        .copied()
        .filter(|&m| !in_rect(a, m) && !in_rect(b, m))
        .collect();
    let f = normal(from.side);
    let t = normal(to.side);
    let headings: [(i32, i32); 4] = [normal(0), normal(1), normal(2), normal(3)];
    let h_f = headings.iter().position(|&v| v == f)?;
    let nt = (-t.0, -t.1);
    let h_nt = headings.iter().position(|&v| v == nt)?;
    let blocked = |c: (i32, i32)| -> bool {
        in_rect(c, from.body)
            || in_rect(c, to.body)
            || c == a
            || c == b
            || obstacles.iter().any(|&o| in_rect(c, o))
    };

    let mut xs = vec![
        from.body.min_x,
        from.body.max_x,
        to.body.min_x,
        to.body.max_x,
        a.0,
        b.0,
    ];
    let mut ys = vec![
        from.body.min_y,
        from.body.max_y,
        to.body.min_y,
        to.body.max_y,
        a.1,
        b.1,
    ];
    for o in &obstacles {
        xs.extend([o.min_x, o.max_x]);
        ys.extend([o.min_y, o.max_y]);
    }
    let x0 = xs.iter().copied().min()? - BRUTE_FORCE_MARGIN;
    let x1 = xs.iter().copied().max()? + BRUTE_FORCE_MARGIN;
    let y0 = ys.iter().copied().min()? - BRUTE_FORCE_MARGIN;
    let y1 = ys.iter().copied().max()? + BRUTE_FORCE_MARGIN;
    let w = usize::try_from(x1 - x0 + 1).ok()?;
    let h = usize::try_from(y1 - y0 + 1).ok()?;
    let index = |c: (i32, i32)| -> Option<usize> {
        if c.0 < x0 || c.0 > x1 || c.1 < y0 || c.1 > y1 || blocked(c) {
            return None;
        }
        let cx = usize::try_from(c.0 - x0).ok()?;
        let cy = usize::try_from(c.1 - y0).ok()?;
        Some(cy * w + cx)
    };
    let cell_of = |i: usize| -> (i32, i32) {
        (
            x0 + i32::try_from(i % w).unwrap_or(0),
            y0 + i32::try_from(i / w).unwrap_or(0),
        )
    };
    let bend = |p: usize, q: usize| -> i32 { i32::from(p != q) };

    let mut cost: Vec<Option<(i32, i32, i32)>> = vec![None; w * h * 4];
    let mut heap = BinaryHeap::new();
    for (k, hk) in headings.iter().enumerate() {
        let fc = (b.0 - hk.0, b.1 - hk.1);
        let Some(fi) = index(fc) else {
            continue;
        };
        for d in 0..4 {
            let c = (0, i32::from(k != h_nt), bend(d, k));
            if cost[fi * 4 + d].is_none_or(|o| c < o) {
                cost[fi * 4 + d] = Some(c);
                heap.push(Reverse((c, fi, d)));
            }
        }
    }
    while let Some(Reverse((c, m, d))) = heap.pop() {
        if cost[m * 4 + d] != Some(c) {
            continue;
        }
        let mc = cell_of(m);
        let Some(p) = index((mc.0 - headings[d].0, mc.1 - headings[d].1)) else {
            continue;
        };
        for hp in 0..4 {
            let nc = (c.0 + 1, c.1, c.2 + bend(hp, d));
            if cost[p * 4 + hp].is_none_or(|o| nc < o) {
                cost[p * 4 + hp] = Some(nc);
                heap.push(Reverse((nc, p, hp)));
            }
        }
    }

    let total = |d: usize| -> Option<(i32, i32, i32, i32)> {
        let s = index((a.0 + headings[d].0, a.1 + headings[d].1))?;
        let c = cost[s * 4 + d]?;
        Some((c.0, c.1, i32::from(d != h_f), c.2))
    };
    let order = [h_f, 0, 1, 2, 3];
    let best = order.iter().filter_map(|&d| total(d)).min()?;
    let d0 = *order.iter().find(|&&d| total(d) == Some(best))?;
    let mut cur = index((a.0 + headings[d0].0, a.1 + headings[d0].1))?;
    let mut hd = d0;
    let mut c = cost[cur * 4 + hd]?;
    let mut cells = vec![a, cell_of(cur)];
    while c.0 != 0 {
        let here = cell_of(cur);
        let mut moved = false;
        for d in [hd, 0, 1, 2, 3] {
            let Some(q) = index((here.0 + headings[d].0, here.1 + headings[d].1)) else {
                continue;
            };
            let Some(qc) = cost[q * 4 + d] else {
                continue;
            };
            if (1 + qc.0, qc.1, bend(hd, d) + qc.2) == c {
                let qcell = cell_of(q);
                assert!(
                    qcell.0 > x0 && qcell.0 < x1 && qcell.1 > y0 && qcell.1 < y1,
                    "brute_force_route_avoiding: the walk for {from:?} -> {to:?} reached the \
                     border of its box at {qcell:?}; the box may be too small"
                );
                cells.push(qcell);
                cur = q;
                hd = d;
                c = qc;
                moved = true;
                break;
            }
        }
        if !moved {
            return None;
        }
    }
    cells.push(b);
    Some(cells)
}
