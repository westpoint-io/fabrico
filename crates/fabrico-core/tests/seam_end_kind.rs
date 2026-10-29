//! CORNER-01 / CORNER-06 (phase 74.1 gap closure, plan 74.1-07): THE SEAM TABLE,
//! `fabrico_core::state::seam_end_kind`, pinned exhaustively.
//!
//! `seam_end_kind` decides the kind a docked belt END tile is DRAWN as. The render packet
//! ships its answer (through `GridState::effective_belt_tiles`); nothing stores it, so it
//! moves no replay byte. This file pins the pure table on its own, case by case, so a
//! change to any row reddens here before it reaches a board:
//!
//! 1. **A Tail end**, own direction `d`, one feed `s`, for all 16 `(d, s)`: Straight on
//!    `d`'s axis when `s == d`; the STORED kind when `s` is the reverse of `d`;
//!    `Corner { from: s, to: d }` otherwise.
//! 2. **A Head end**, own direction `d`, a drain `s`, for all 16 `(d, s)`: Straight when
//!    `s == d`; stored when reversed; `Corner { from: d, to: s }` otherwise.
//! 3. **Fan-in**: zero feeds (no seam) keeps the stored kind; one feed is the table above;
//!    two feeds keep the stored kind whatever they are (a straight feed plus a side feed,
//!    two side feeds), in either order.
//! 4. **A single tile** (no own direction): zero seams keeps stored; one feed or one drain,
//!    or a feed and a drain in the same direction, is the zero-turn `Corner { from: e, to: e }`
//!    along that seam (phase 89, BELT-10, D-15); a feed and a perpendicular drain is a Corner.
//! 5. **A reversing feed** keeps the stored kind, whatever was stored.
//!
//! Every expected value is written from the `Dir` meaning (y-down, `N=(0,-1)`), never
//! computed by a second copy of the table.
//!
//! Run target: `cargo test -p fabrico-core --test seam_end_kind`.

use fabrico_core::state::{Axis, Dir, TileKind, seam_end_kind};

const DIRS: [Dir; 4] = [Dir::N, Dir::E, Dir::S, Dir::W];

/// A stored kind no rule here produces for the tiles below, so "kept the stored kind" can
/// never be confused with a derived kind. A REVERSING corner: the table answers only 90°
/// corners and, since phase 89 (D-15), the zero-turn `Corner { from: e, to: e }` of a single
/// tile, which is why this is no longer `Corner { W, W }`.
const SENTINEL: TileKind = TileKind::Corner {
    from: Dir::W,
    to: Dir::E,
};

fn straight(axis: Axis) -> TileKind {
    TileKind::Straight { axis }
}

fn corner(from: Dir, to: Dir) -> TileKind {
    TileKind::Corner { from, to }
}

/// The axis a flow along `d` runs on, written as a literal table.
fn axis_of(d: Dir) -> Axis {
    match d {
        Dir::N | Dir::S => Axis::Y,
        Dir::E | Dir::W => Axis::X,
    }
}

/// The reverse of `d`, written as a literal table.
fn rev(d: Dir) -> Dir {
    match d {
        Dir::N => Dir::S,
        Dir::S => Dir::N,
        Dir::E => Dir::W,
        Dir::W => Dir::E,
    }
}

#[test]
fn a_tail_end_follows_the_table_for_all_sixteen_directions() {
    let mut corners = 0;
    for d in DIRS {
        for s in DIRS {
            let got = seam_end_kind(SENTINEL, Some(d), Some(d), &[s], None);
            let want = if s == d {
                straight(axis_of(d))
            } else if s == rev(d) {
                SENTINEL
            } else {
                corners += 1;
                corner(s, d)
            };
            assert_eq!(got, want, "Tail: own {d:?}, feed {s:?}");
        }
    }
    assert_eq!(corners, 8, "eight perpendicular (own, feed) pairs turn");
}

#[test]
fn the_tail_table_written_out_for_an_eastbound_belt() {
    // One own direction written out literally: an eastbound belt's Tail. A feed travelling
    // N enters from the south and leaves E; a feed travelling W would run against the belt.
    let e = Some(Dir::E);
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::E], None), straight(Axis::X));
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::N], None), corner(Dir::N, Dir::E));
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::S], None), corner(Dir::S, Dir::E));
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::W], None), SENTINEL);
    // And S1 itself: a northbound belt fed by an eastbound belt's Head.
    let n = Some(Dir::N);
    assert_eq!(seam_end_kind(SENTINEL, n, n, &[Dir::E], None), corner(Dir::E, Dir::N));
}

#[test]
fn a_head_end_follows_the_table_for_all_sixteen_directions() {
    let mut corners = 0;
    for d in DIRS {
        for s in DIRS {
            let got = seam_end_kind(SENTINEL, Some(d), Some(d), &[], Some(s));
            let want = if s == d {
                straight(axis_of(d))
            } else if s == rev(d) {
                SENTINEL
            } else {
                corners += 1;
                corner(d, s)
            };
            assert_eq!(got, want, "Head: own {d:?}, drain {s:?}");
        }
    }
    assert_eq!(corners, 8, "eight perpendicular (own, drain) pairs turn");
}

#[test]
fn zero_feeds_and_no_drain_is_no_seam_and_keeps_the_stored_kind() {
    for d in DIRS {
        for stored in [SENTINEL, straight(Axis::X), straight(Axis::Y), corner(Dir::N, Dir::E)] {
            assert_eq!(
                seam_end_kind(stored, Some(d), Some(d), &[], None),
                stored,
                "own {d:?}, no seam"
            );
        }
    }
}

#[test]
fn two_feeds_keep_the_stored_kind_in_either_order() {
    // An eastbound Tail fed straight from the west (E) and from the south (N): a side-load.
    let e = Some(Dir::E);
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::E, Dir::N], None), SENTINEL);
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::N, Dir::E], None), SENTINEL);
    // Two side feeds, from the south (N) and the north (S): a merge.
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::N, Dir::S], None), SENTINEL);
    assert_eq!(seam_end_kind(SENTINEL, e, e, &[Dir::S, Dir::N], None), SENTINEL);
    // Every pair of feeds into every own direction keeps it, three feeds too.
    for d in DIRS {
        for s1 in DIRS {
            for s2 in DIRS {
                assert_eq!(
                    seam_end_kind(SENTINEL, Some(d), Some(d), &[s1, s2], None),
                    SENTINEL,
                    "own {d:?}, feeds {s1:?} {s2:?}"
                );
            }
        }
        assert_eq!(
            seam_end_kind(SENTINEL, Some(d), Some(d), &[Dir::N, Dir::E, Dir::S], None),
            SENTINEL
        );
    }
}

/// A SINGLE TILE TAKES BOTH SEAMS, AND KEEPS ITS FLOW DIRECTION (rewritten by phase 89 plan
/// 89-03, BELT-10, D-15). A single tile has no own in or out direction, so its entry and exit
/// come from its seams alone. Until phase 89 a tile whose entry equalled its exit answered
/// `Straight { axis }`, which carries no direction: a one-tile belt flowing West was drawn
/// flowing East and one flowing North was drawn flowing South (89-MEASURE.md). It now answers
/// the zero-turn `Corner { from: e, to: e }` for one feed, one drain, and a feed and drain in the
/// same direction. A turning pair, a reversing pair, zero seams and a fan-in are unchanged, and
/// every multi-tile row above is untouched (an own direction says which way the end runs).
#[test]
fn a_single_tile_takes_both_seams() {
    // Zero seams: stored.
    assert_eq!(seam_end_kind(SENTINEL, None, None, &[], None), SENTINEL);
    // One feed S: the zero-turn corner along it, flowing S.
    assert_eq!(seam_end_kind(SENTINEL, None, None, &[Dir::S], None), corner(Dir::S, Dir::S));
    // One drain N: the zero-turn corner along it, flowing N.
    assert_eq!(seam_end_kind(SENTINEL, None, None, &[], Some(Dir::N)), corner(Dir::N, Dir::N));
    // Fed West and drained West (a Source's Out West of nothing into a Sink's In): flowing W.
    assert_eq!(
        seam_end_kind(straight(Axis::X), None, None, &[Dir::W], Some(Dir::W)),
        corner(Dir::W, Dir::W)
    );
    // Feed S, drain E: the tile turns.
    assert_eq!(
        seam_end_kind(SENTINEL, None, None, &[Dir::S], Some(Dir::E)),
        corner(Dir::S, Dir::E)
    );
    // Every one-seam and two-seam combination, against the literal tables.
    for s in DIRS {
        assert_eq!(seam_end_kind(SENTINEL, None, None, &[s], None), corner(s, s));
        assert_eq!(seam_end_kind(SENTINEL, None, None, &[], Some(s)), corner(s, s));
        for x in DIRS {
            let want = if x == s {
                corner(s, s)
            } else if x == rev(s) {
                SENTINEL
            } else {
                corner(s, x)
            };
            assert_eq!(
                seam_end_kind(SENTINEL, None, None, &[s], Some(x)),
                want,
                "single tile, feed {s:?}, drain {x:?}"
            );
        }
    }
    // A fan-in onto a single tile keeps stored even with a drain.
    assert_eq!(
        seam_end_kind(SENTINEL, None, None, &[Dir::S, Dir::N], Some(Dir::E)),
        SENTINEL
    );
    // A multi-tile end whose seam agrees with its own direction stays Straight (not a corner).
    for d in DIRS {
        assert_eq!(seam_end_kind(SENTINEL, Some(d), Some(d), &[d], None), straight(axis_of(d)));
        assert_eq!(seam_end_kind(SENTINEL, Some(d), Some(d), &[], Some(d)), straight(axis_of(d)));
    }
}

#[test]
fn a_reversing_feed_keeps_whatever_was_stored() {
    for d in DIRS {
        for stored in [straight(Axis::X), straight(Axis::Y), corner(Dir::E, Dir::S), SENTINEL] {
            assert_eq!(
                seam_end_kind(stored, Some(d), Some(d), &[rev(d)], None),
                stored,
                "own {d:?}, reversing feed"
            );
            assert_eq!(
                seam_end_kind(stored, Some(d), Some(d), &[], Some(rev(d))),
                stored,
                "own {d:?}, reversing drain"
            );
        }
    }
}
