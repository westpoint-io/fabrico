//! The pure belt-path normalizer (BELT-01..03).
//!
//! [`route`] is the ONE shared primitive that turns a player-ordered, orthogonally-
//! adjacent list of drawn cells into typed/oriented [`BeltTile`]s with auto-inferred
//! 90° corners. It is **PURE**, deterministic, float-free, and search-free — there is
//! NO A*/auto-routing anywhere (BELT-02, a deliberate anti-feature): `route()`
//! normalizes the path the player drew, it never invents one.
//!
//! # One shared primitive (preview == commit, BELT-03)
//! Both producers of a belt — the UI ghost preview (Phase 14) and the
//! [`validate_normalize`](crate::command::validate_normalize) commit path — call this
//! IDENTICAL function and get byte-identical tiles. Preview == commit is therefore
//! satisfied STRUCTURALLY, exactly like the Phase-10 `port_catalog` /
//! `cells_of_footprint` "one shared primitive" discipline. The corner geometry is
//! decided in exactly ONE place.
//!
//! # Atomic typed rejection (never a guess)
//! An empty / non-orthogonal / non-adjacent / self-crossing drawn path is rejected
//! ATOMICALLY with a typed [`RouteError`] before any tile is produced. `route()`
//! never panics, never guesses, never partially applies (T-11-ROUTE).
//!
//! # Boundary: geometry only, NOT occupancy
//! `route()` does NOT check grid occupancy or grid extent — it is a reusable pure
//! geometry fn the renderer can also call for the ghost. Occupancy + extent live in
//! [`validate_normalize`](crate::command::validate_normalize) (the DrawBelt arm).

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;

use fabrico_core::state::{Axis, BeltTile, Dir, TileKind};

/// Why a drawn belt path was rejected — a typed, **non-panicking**, atomic outcome.
/// `route()` produces NOTHING on any of these (never a partial path, never a guess).
///
/// `Copy`, derive-only (no payload) like
/// [`CommandError`](crate::error::CommandError), so it is cheap to return, compare,
/// and wrap. After the [`Empty`](Self::Empty) / [`NonAdjacent`](Self::NonAdjacent) /
/// [`SelfCrossing`](Self::SelfCrossing) checks pass, every interior tile has exactly
/// one in-direction and one out-direction that are either equal (straight) or
/// perpendicular (corner) — no ambiguity remains, so no further reject variant is
/// needed (RESEARCH Pitfall 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteError {
    /// An empty drawn path (no cells). A belt must have at least one tile.
    Empty,
    /// Two consecutive cells are not orthogonally adjacent (`|dx| + |dy| != 1`).
    /// This single check rejects diagonal steps AND `>1`-cell jumps.
    NonAdjacent,
    /// A cell appears more than once — the path crosses or overlaps itself. Checked
    /// with an ordered [`BTreeSet`] (deterministic, no float, no `HashSet`).
    SelfCrossing,
}

impl fmt::Display for RouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            RouteError::Empty => "drawn belt path is empty",
            RouteError::NonAdjacent => "drawn cells are not orthogonally adjacent",
            RouteError::SelfCrossing => "drawn belt path crosses or overlaps itself",
        };
        f.write_str(msg)
    }
}

impl Error for RouteError {}

/// Map an orthogonal unit step `(dx, dy)` to its [`Dir`] on the pinned **y-down**
/// axis convention (mirrors [`fabrico_core::state::unit_delta`]): `N=(0,-1)`,
/// `E=(+1,0)`, `S=(0,+1)`, `W=(-1,0)`. The caller guarantees the step is a unit step
/// (the adjacency check ran first), so the non-unit arm is unreachable — but it is
/// kept total and non-panicking (returns `None`) rather than `unreachable!`.
#[must_use]
fn dir_of_step(dx: i32, dy: i32) -> Option<Dir> {
    match (dx, dy) {
        (0, -1) => Some(Dir::N),
        (1, 0) => Some(Dir::E),
        (0, 1) => Some(Dir::S),
        (-1, 0) => Some(Dir::W),
        _ => None,
    }
}

/// The straight-run [`Axis`] a flow [`Dir`] travels along: `N`/`S` run on the
/// vertical [`Axis::Y`]; `E`/`W` run on the horizontal [`Axis::X`].
#[must_use]
fn axis_of_dir(dir: Dir) -> Axis {
    match dir {
        Dir::N | Dir::S => Axis::Y,
        Dir::E | Dir::W => Axis::X,
    }
}

/// Normalize a player-ordered, orthogonally-adjacent list of drawn `cells` into
/// typed/oriented [`BeltTile`]s with auto-inferred 90° corners (BELT-01).
///
/// **PURE**, deterministic, float-free, search-free (NO A*/auto-routing — BELT-02).
/// Called byte-identically by the UI ghost preview and the
/// [`validate_normalize`](crate::command::validate_normalize) commit path, so
/// preview == commit holds structurally (BELT-03).
///
/// # Tiles
/// - A length-1 path is a single [`Straight`](TileKind::Straight) tile (no drawn
///   direction; defaults to [`Axis::X`]).
/// - An endpoint (the tail/admit end or the head/deliver end of a longer path) carries
///   its single direction as a `Straight` tile along that direction's axis.
/// - An interior tile whose in-direction equals its out-direction is a `Straight`
///   along that axis; a perpendicular bend is an auto-inferred
///   [`Corner`](TileKind::Corner) recording the `from`/`to` flow directions. A 180°
///   reversal is impossible (rejected by the distinct-cells check).
///
/// # Errors
/// [`RouteError::Empty`] (no cells), [`RouteError::SelfCrossing`] (a repeated cell),
/// or [`RouteError::NonAdjacent`] (a diagonal or `>1` jump). The WHOLE path is
/// rejected atomically — `route()` never produces a partial path and never panics.
pub fn route(cells: &[(i32, i32)]) -> Result<Vec<BeltTile>, RouteError> {
    if cells.is_empty() {
        return Err(RouteError::Empty);
    }

    // (a) Self-crossing / overlap-with-self: every cell must be distinct. Ordered
    //     BTreeSet keeps the check deterministic (no HashSet — determinism discipline).
    let mut seen = BTreeSet::new();
    for &c in cells {
        if !seen.insert(c) {
            return Err(RouteError::SelfCrossing);
        }
    }

    // (b) Every consecutive step must be orthogonally adjacent (|dx| + |dy| == 1).
    //     This rejects diagonal steps AND >1-cell jumps in one check.
    for w in cells.windows(2) {
        let (dx, dy) = (w[1].0 - w[0].0, w[1].1 - w[0].1);
        if dx.abs() + dy.abs() != 1 {
            return Err(RouteError::NonAdjacent);
        }
    }

    // (c) Per-tile direction + corner inference. After (a)+(b) every interior cell has
    //     exactly one in-direction and one out-direction (both unit steps), equal
    //     (straight) or perpendicular (corner) — no ambiguity (RESEARCH Pitfall 4).
    let n = cells.len();
    let mut tiles = Vec::with_capacity(n);
    for (i, &cell) in cells.iter().enumerate() {
        // in_dir = step INTO this cell (None at the tail/admit end).
        let in_dir = (i > 0).then(|| {
            let (dx, dy) = (cell.0 - cells[i - 1].0, cell.1 - cells[i - 1].1);
            dir_of_step(dx, dy)
        });
        // out_dir = step OUT of this cell (None at the head/deliver end).
        let out_dir = (i + 1 < n).then(|| {
            let (dx, dy) = (cells[i + 1].0 - cell.0, cells[i + 1].1 - cell.1);
            dir_of_step(dx, dy)
        });

        let kind = match (in_dir.flatten(), out_dir.flatten()) {
            // Interior tile: equal dirs => straight; perpendicular => corner.
            (Some(ind), Some(outd)) => {
                if ind == outd {
                    TileKind::Straight { axis: axis_of_dir(ind) }
                } else {
                    TileKind::Corner { from: ind, to: outd }
                }
            }
            // Tail/admit end (longer path): single out-direction.
            (None, Some(outd)) => TileKind::Straight { axis: axis_of_dir(outd) },
            // Head/deliver end (longer path): single in-direction.
            (Some(ind), None) => TileKind::Straight { axis: axis_of_dir(ind) },
            // Length-1 path: no drawn direction — default to the X axis.
            (None, None) => TileKind::Straight { axis: Axis::X },
        };
        tiles.push(BeltTile::new(cell, kind));
    }

    Ok(tiles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straight_horizontal_run_is_all_straight_x() {
        // A horizontal run (0,0)->(1,0)->(2,0)->(3,0): every tile Straight on Axis::X.
        let cells = [(0, 0), (1, 0), (2, 0), (3, 0)];
        let tiles = route(&cells).expect("a straight horizontal run routes");
        assert_eq!(tiles.len(), 4);
        for (t, &c) in tiles.iter().zip(cells.iter()) {
            assert_eq!(t.cell, c);
            assert_eq!(t.tile_kind(), TileKind::Straight { axis: Axis::X });
        }
    }

    #[test]
    fn straight_vertical_run_is_all_straight_y() {
        // A vertical run on the y-down axis: every tile Straight on Axis::Y.
        let cells = [(5, 0), (5, 1), (5, 2)];
        let tiles = route(&cells).expect("a straight vertical run routes");
        for t in &tiles {
            assert_eq!(t.tile_kind(), TileKind::Straight { axis: Axis::Y });
        }
    }

    #[test]
    fn l_bend_produces_exactly_one_corner_with_correct_from_to() {
        // (0,0)->(1,0)->(1,1): travel E into (1,0), then S out of (1,0). The bend cell
        // (1,0) is the single Corner{from: E, to: S}; the endpoints are Straight.
        let cells = [(0, 0), (1, 0), (1, 1)];
        let tiles = route(&cells).expect("an L-bend routes");
        assert_eq!(tiles.len(), 3);
        // Tail (admit end): single out-dir E -> Straight on X.
        assert_eq!(tiles[0].tile_kind(), TileKind::Straight { axis: Axis::X });
        // The bend: exactly one Corner with the drawn from/to.
        assert_eq!(tiles[1].cell, (1, 0));
        assert_eq!(tiles[1].tile_kind(), TileKind::Corner { from: Dir::E, to: Dir::S });
        // Head (deliver end): single in-dir S -> Straight on Y.
        assert_eq!(tiles[2].tile_kind(), TileKind::Straight { axis: Axis::Y });
        // Exactly one Corner tile in the whole path.
        let corners = tiles
            .iter()
            .filter(|t| matches!(t.tile_kind(), TileKind::Corner { .. }))
            .count();
        assert_eq!(corners, 1, "an L-bend has exactly one corner tile");
    }

    #[test]
    fn single_cell_path_is_one_straight_tile() {
        // A length-1 belt is a single Straight tile (no drawn direction; defaults X).
        let tiles = route(&[(7, 7)]).expect("a single-cell path routes");
        assert_eq!(tiles.len(), 1);
        assert_eq!(tiles[0].cell, (7, 7));
        assert_eq!(tiles[0].tile_kind(), TileKind::Straight { axis: Axis::X });
    }

    #[test]
    fn reject_empty() {
        assert_eq!(route(&[]), Err(RouteError::Empty));
    }

    #[test]
    fn reject_non_adjacent_jump() {
        // (0,0)->(2,0) is a >1 jump: |dx|+|dy| = 2 != 1.
        assert_eq!(route(&[(0, 0), (2, 0)]), Err(RouteError::NonAdjacent));
    }

    #[test]
    fn reject_diagonal() {
        // (0,0)->(1,1) is diagonal: |dx|+|dy| = 2 != 1.
        assert_eq!(route(&[(0, 0), (1, 1)]), Err(RouteError::NonAdjacent));
    }

    #[test]
    fn reject_self_crossing() {
        // A path revisiting a cell: (0,0)->(1,0)->(1,1)->(0,1)->(0,0) closes a loop,
        // repeating (0,0). The distinct-cell check rejects it before adjacency.
        let cells = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)];
        assert_eq!(route(&cells), Err(RouteError::SelfCrossing));
    }

    #[test]
    fn route_is_deterministic_byte_identical() {
        // preview == commit at the function level: the SAME cells route to the SAME
        // tiles, byte-identically, every call (no RNG, no clock, no hidden state).
        let cells = [(0, 0), (1, 0), (1, 1), (2, 1), (2, 2)];
        let a = route(&cells).expect("routes");
        let b = route(&cells).expect("routes");
        assert_eq!(a, b, "route() is deterministic (preview==commit)");
    }

    #[test]
    fn corner_directions_cover_all_four_bends() {
        // Each of the four perpendicular bends infers the correct Corner{from,to}.
        // E->N: (0,0)->(1,0)->(1,-1).
        assert_eq!(
            route(&[(0, 0), (1, 0), (1, -1)]).expect("routes")[1].tile_kind(),
            TileKind::Corner { from: Dir::E, to: Dir::N }
        );
        // N->W: (0,0)->(0,-1)->(-1,-1).
        assert_eq!(
            route(&[(0, 0), (0, -1), (-1, -1)]).expect("routes")[1].tile_kind(),
            TileKind::Corner { from: Dir::N, to: Dir::W }
        );
        // W->S: (0,0)->(-1,0)->(-1,1).
        assert_eq!(
            route(&[(0, 0), (-1, 0), (-1, 1)]).expect("routes")[1].tile_kind(),
            TileKind::Corner { from: Dir::W, to: Dir::S }
        );
        // S->E: (0,0)->(0,1)->(1,1).
        assert_eq!(
            route(&[(0, 0), (0, 1), (1, 1)]).expect("routes")[1].tile_kind(),
            TileKind::Corner { from: Dir::S, to: Dir::E }
        );
    }
}
