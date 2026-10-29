//! `wire_route` — the pure endpoint->endpoint ELECTRICAL-WIRE cell-path normalizer
//! (WUI-01, Phase 40 Wave-0 spike 2).
//!
//! The belt [`route`](crate::route::route) normalizes a path the PLAYER drew; a wire
//! is drawn differently — the player docks two electrical terminals and the cable
//! auto-routes between them (there is no per-cell drag). [`wire_route`] is that
//! auto-router: given two resolved electrical endpoints (each a world CELL + the
//! outward SIDE of its nub), it computes the deterministic orthogonal L / Manhattan
//! cell path between the two nub cells, then NORMALIZES that path through the existing
//! parity-pinned [`route`](crate::route::route) so wire corners inherit the same proven
//! 90-degree corner geometry belts use (BELT-01, 14-02 fixture). It ALSO carries the
//! two electrical terminal anchors (the wire-specific geometry `route()` does not
//! cover), so the drawn cable == the model on BOTH ends.
//!
//! # Integer-only, deterministic, float-free (the golden byte-truth)
//! Everything here is integer cell math (no `f32`/`f64` ever enters the emitted bytes):
//! the pixel nub anchor (the 2.5px outward push, `ports.ts::nubAnchor`) is a render-side
//! FLOAT derived canvas-side from the integer `(cell, side)` this pins — never on the
//! wire, never in this golden. [`wire_route`] is PURE and deterministic (no RNG, no
//! clock, no host state), so re-emitting the fixture is byte-stable — the cross-language
//! parity discipline the 40-03 TS mirror asserts against (the `route`/`footprint`
//! frozen-fixture precedent).
//!
//! # Auto-route rule (deterministic, FIVE CANDIDATES tried in order)
//! 1. [`perimeter_cells`] — the union-box perimeter RING (72-16). Fires only when NEITHER
//!    face can be honoured by any L or Z, i.e. when all four admissibility booleans are
//!    false. It leaves the source straight along its outward normal to the boundary of the
//!    two machines' union bounding box inflated by one cell, rides that ring the shorter
//!    way round, then runs straight into the target along the target's inward normal. Both
//!    terminal segments are on their port normal axes BY CONSTRUCTION, in every branch,
//!    which is what lets the renderer's `clampEndToNub` apply at BOTH ends.
//! 2. The GO-AROUND (75-01, [`CAND_GO_AROUND`]). Fires only when the face-aligned shape
//!    below would honour EXACTLY ONE face (an input-only gate over the same four booleans,
//!    its two Z room guards and its bend-order ladder) and both stub cells, one cell out
//!    of each port along its normal, are free of both bodies and both docks. It runs
//!    [`go_around_search`] from the source stub to the target stub: the shortest path that
//!    keeps every cell outside both bodies and off both docks, fewest bends second, so the
//!    cable leaves along the source normal and enters against the target normal.
//! 3. CLEAR OF BODIES (75-03, [`CAND_CLEAR_OF_BODIES`]). Fires when the one-face gate
//!    holds, the docks do not touch, and a stub cell lies inside the OTHER machine's body:
//!    the shortest connection crossing neither machine, from any free neighbour of the
//!    source dock to any free neighbour of the target dock, a straight arrival preferred.
//!    Declines when a dock has no free neighbour (no body-clear connection exists).
//! 4. [`face_aligned_cells`]: leaves the source cell along the source port's OUTWARD
//!    NORMAL and arrives at the target cell AGAINST the target port's outward normal,
//!    whenever a monotone walk from A to B actually travels in that direction. Where a
//!    face cannot be honoured it falls back, per face, to the plain X-first L this module
//!    shipped from Phase 40 to Phase 72. It receives every pair the ring declines and the
//!    go-around and candidate 4 do not serve: the pairs it honours both faces of, the
//!    touching pairs, and the pairs with no body-clear connection at all.
//! 5. [`manhattan_l`]: unconditional last, still unreachable by proof.
//!
//! ## What 72-16, 75-01 and 75-03 fixed, stated NARROWLY
//! The ring fires ONLY on the all-four-false class. The one-face class (a pair whose
//! face-aligned L honours exactly one face) is served by the go-around since 75-01,
//! EXCEPT where a stub cell is blocked: two touching cells where one port faces straight
//! at the other cell (no path can honour both ends without revisiting a cell; they keep
//! the two-cell run, already the shortest body-clear connection), and a port facing
//! straight into the neighbour's body, which candidate 4 draws clear of both machines
//! since 75-03 unless a dock has no free neighbour at all (then [`face_aligned_cells`]
//! stays, crossing a machine because nothing else can). Same-cell docks are not
//! routed at all: since 75-03 they are a typed refusal, [`WireRouteError::Coincident`],
//! checked before the ladder, and the host draws a named two-cell stub for them. So "the
//! cable plugs in at both ends" holds on every pair outside those named shapes, and not
//! universally.
//!
//! ## Why the side is read at all (the defect this replaced)
//! `side` sat unused in this function's arguments for thirty-two phases while the path
//! was routed CELL to CELL, X first. The consequence is only visible once the two
//! machines share neither a row nor a column: the cable climbs the target machine's own
//! body column and enters the chassis through its UNDERSIDE, stopping inside the machine
//! beside a port it is not connected to. This was observed in the real WebKitGTK
//! app, with a 1x1 Route parked down-and-left of
//! a 3x3 Handler: the request cable entered the Handler from below, one cell west of the
//! MECHANICAL fault-drain glyph, and read as docked to the fault port. It is not docked
//! there and cannot be (`command.rs` rejects a Fault target), which is what made the
//! picture a lie about the model rather than merely an ugly line.
//!
//! ## The half-plane property this buys, stated narrowly
//! `side` names the face the nub is drawn on, so the port cell sits at the footprint's
//! extreme along that outward normal and the machine's whole body lies behind it. Hence:
//! when the source face is honoured, no emitted cell but the first is inside the SOURCE
//! machine; when the target face is honoured, no emitted cell but the last is inside the
//! TARGET machine. That lemma is enforced, not assumed, by
//! `port_catalog_ports_sit_on_the_face_their_side_names` in `command.rs`.
//!
//! **The ladder above is normal-aware; the obstacle stage over it routes around third
//! machines.** [`wire_route`] and [`wire_route_traced`] run the five-candidate ladder and
//! know only the two endpoint bodies, so on their own they will draw across a third
//! machine. [`wire_route_avoiding`] and [`wire_route_avoiding_traced`] (phase 92, D-09) take
//! every machine rectangle on the board, run the same ladder first, keep its path whenever
//! it enters none of them, and otherwise search around them ([`CAND_AROUND_MACHINES`]).
//! Callers that must route around machines call the `avoiding` form; the two-argument form
//! is kept byte-for-byte so every path it drew before phase 92 is the path it draws now.
//!
//! ## The obstacle stage (phase 92, D-09)
//! 1. Run the ladder: path `P`, candidate `c`.
//! 2. Obstacles: every given rectangle that contains neither dock cell (this drops both
//!    endpoint machines, and the machine under the pointer in a free drag, without the
//!    caller knowing node ids), normalised as [`norm_body`] folds a forged box, sorted by
//!    `(min_x, min_y, max_x, max_y)` and deduplicated. No hashing.
//! 3. If no cell of `P` lies in an obstacle, `P` and `c` are the answer.
//! 4. The window ([`around_machines_window`]): start from the box of both bodies and both
//!    dock cells, and add every obstacle that touches that box inflated by one cell,
//!    growing the box to hold it, until nothing more joins (computed in `O(n log n)`).
//! 5. The line set: the ends' lines and each window obstacle's `min - 1` and `max + 1`,
//!    clamped to the grid widened by [`WIRE_LINE_GUARD`] (an overflow guard that no
//!    buildable board reaches, so a cable may pass one cell outside the grid's edge).
//! 6. At most [`MAX_AROUND_NODES`] nodes on it: the relaxed search candidate 4 already uses
//!    ([`search_between_ends`]'s routine), with the blocked set widened to both bodies, both
//!    docks and the window's obstacles, as candidate 5. More: the CROWDED WINDOW,
//!    [`CAND_AROUND_CROWDED`], a breadth-first walk over the window's cells with the same
//!    blocked set, exact in length and the two face keys, bends taken move by move. Neither
//!    case keeps a path through a machine when a way round exists (UI-SPEC 4.1 rule 1).
//! 7. A walk `route()` accepts as `[A] ++ walk ++ [B]` is the answer; no walk means `P`
//!    and `c` stay (the WALLED-IN DOCK, the one named exception: a dock whose every free
//!    neighbour is inside a machine, or machines that close every way round).
//!
//! Why the window loses no optimum: at the fixed point no obstacle outside the window
//! touches the frame ring one cell outside it, so that ring is free, and any walk that
//! leaves the frame and comes back is strictly longer than the frame segment between its
//! two crossings. The ring's lines are on the line set already ([`around_machines_lines`]).
//! The exhaustive oracle `brute_force_route_avoiding` in `tests/common/mod.rs` and the
//! second corpus `tests/wire_obstacle_corpus.rs` hold it.
//!
//! ## `route()` is the only acceptance oracle
//! No second distinctness or adjacency predicate is written here or in the TS mirror.
//! Each candidate carries its OWN validity proof — a strictly increasing potential for
//! [`face_aligned_cells`], two lemmas (interior/ring separation, and S1/S3 disjointness
//! under D2) for [`perimeter_cells`] — and [`route`](crate::route::route) remains the
//! single judge of what any of them emits. The ladder's decline gates are input-selection
//! rules about which SHAPE to build, evaluated before anything is built, and they are not
//! predicates over a built path. The obstacle stage is the one deliberate exception, and
//! it sits above the ladder rather than inside it: it reads the ladder's built path to
//! decide whether to keep it (D-09's keep-today's-path rule). Its own walk is still judged
//! by `route()` and nothing else.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use fabrico_core::state::BeltTile;

use fabrico_protocol::machine_kind;

use crate::command::{GRID_MAX, GRID_MIN};
use crate::route::{RouteError, route};

/// A resolved electrical wire endpoint: the port's world CELL plus the outward SIDE of
/// its electrical nub (`N=0, E=1, S=2, W=3` — the core side numbering, `port_world`).
///
/// Integer-only: the render-side pixel anchor (`ports.ts::nubAnchor`) is DERIVED from
/// this `(cell, side)` canvas-side and never rides the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WireDock {
    /// The port's world cell `(x, y)`.
    pub cell: (i32, i32),
    /// The outward side of the electrical nub (`N=0, E=1, S=2, W=3`).
    pub side: u8,
    /// The inclusive world cell bounds of the machine this port belongs to.
    pub body: WireBody,
}

/// The inclusive world cell bounds of the machine a [`WireDock`] belongs to, ROTATION
/// ALREADY APPLIED. A port with no machine behind it (the free-drag pointer target) uses
/// the degenerate `min == max ==` the pointer cell.
///
/// A NAMED STRUCT AND NOT A BARE FOUR-TUPLE, deliberately: an argument-order transposition
/// in an `(i32, i32, i32, i32)` is invisible to the type checker, and this rectangle is
/// read by two languages.
///
/// A Fabrico footprint is always ONE axis-aligned rectangle — `cells_of_footprint`
/// (`crates/fabrico-core/src/state.rs`) is literally `anchor + (0..he) x (0..we)` — so
/// four integers carry the occupancy losslessly. The router is handed the RESOLVED
/// rectangle rather than `{w, h, rot}` on purpose: a `rot` decode would then exist once
/// per language as a fresh drift surface the parity corpus cannot see, because the corpus
/// supplies resolved rectangles as data.
///
/// The ladder ([`wire_route`]) knows the two ENDPOINT bodies and nothing else. Third
/// machines reach only [`wire_route_avoiding`], as a list of these rectangles; see the
/// module docblock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WireBody {
    /// Inclusive minimum world cell x.
    pub min_x: i32,
    /// Inclusive minimum world cell y.
    pub min_y: i32,
    /// Inclusive maximum world cell x.
    pub max_x: i32,
    /// Inclusive maximum world cell y.
    pub max_y: i32,
}

/// One electrical terminal anchor pinned by the golden: the nub's world CELL + outward
/// SIDE. The TS mirror derives the float pixel position from these integers via the
/// shared `nubAnchor` math (Don't-Hand-Roll), so this integer triple is the parity
/// contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WireAnchor {
    /// Nub cell x.
    pub cell_x: i32,
    /// Nub cell y.
    pub cell_y: i32,
    /// Outward side (`N=0, E=1, S=2, W=3`).
    pub side: u8,
}

impl WireAnchor {
    fn of(dock: WireDock) -> Self {
        Self {
            cell_x: dock.cell.0,
            cell_y: dock.cell.1,
            side: dock.side,
        }
    }
}

/// The frozen wire geometry the cross-language golden pins: the two electrical terminal
/// anchors + the `route()`-normalized orthogonal cell path between them. Integer-only,
/// serde-round-trippable, byte-stable.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WireGeometry {
    /// The originating electrical terminal anchor (nub cell + outward side).
    pub from_anchor: WireAnchor,
    /// The terminating electrical terminal anchor (nub cell + outward side).
    pub to_anchor: WireAnchor,
    /// The auto-routed, `route()`-normalized orthogonal cell path connecting them —
    /// wire corners inherit the parity-pinned belt corner geometry.
    pub tiles: Vec<BeltTile>,
}

/// Why [`wire_route`] refused a dock pair (75-03, D-05, CABLE-09 part 1).
///
/// # Why this is a NEW type and not a variant on [`RouteError`]
/// [`RouteError`] is the BELT normaliser's error. It is wrapped by `CommandError::Route`
/// and flattened EXHAUSTIVELY by `fabrico-host`'s `command_error_view.rs` into the tags a
/// user can see after a refused belt draw. A coincident pair of wire docks is not a belt
/// the player drew and has no user-facing sentence: no gesture can produce it (self-wiring
/// is refused, and two placed machines never share a cell), so only a forged packet or a
/// damaged port reference reaches it. Adding it to [`RouteError`] would put a wire-only,
/// user-unreachable case into a user-facing exhaustive match. So the wire router gets its
/// own error, and [`RouteError`] keeps its three variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireRouteError {
    /// Both docks resolve to ONE cell. A path with both ends on one cell has no first
    /// step and no last step, so there is no cable to draw, and before 75-03 the router
    /// answered with a one-tile path the renderer drew as nothing. Checked BEFORE the
    /// ladder; the host turns it into a visible two-cell stub (`render_packet.rs`
    /// `fallback_stub`).
    Coincident,
    /// Every candidate's path was refused by the shared normaliser. Unreachable by proof
    /// (the last candidate is a monotone Manhattan L `route()` always accepts), kept so
    /// the router stays total rather than `expect`ing.
    Route(RouteError),
}

/// The outward unit vector of a core side byte on the pinned **y-down** axis:
/// `N=0 -> (0,-1)`, `E=1 -> (1,0)`, `S=2 -> (0,1)`, `W=3 -> (-1,0)`.
///
/// TOTAL over a forged or future byte, which is why the catch-all returns `(0, 0)`
/// rather than panicking: `(0,0)` can equal neither `(sx, 0)` nor `(0, sy)` under the
/// non-zero guards in [`face_aligned_cells`], so an unknown side degrades to the plain
/// L instead of producing a wrong shape or killing the render packet.
///
/// # Why this is `pub`
/// `tests/wire_corpus.rs` gate G2 needs `f` and `nt` to read a path's terminal steps. It
/// calls THIS function rather than carrying its own four-way table, because a test-local
/// copy of the side numbering is a second place for the numbering to drift.
pub fn normal(side: u8) -> (i32, i32) {
    match side {
        0 => (0, -1),
        1 => (1, 0),
        2 => (0, 1),
        3 => (-1, 0),
        _ => (0, 0),
    }
}

/// `+1`, `-1` or `0` toward `b` from `a`.
///
/// Written as an explicit three-way comparison rather than `signum` so the TypeScript
/// mirror is the SAME EXPRESSION rather than a same-named builtin: `i32::signum` and
/// `Math.sign` agree today, and a shared literal comparison cannot start disagreeing.
fn step_toward(a: i32, b: i32) -> i32 {
    if b > a {
        1
    } else if b < a {
        -1
    } else {
        0
    }
}

/// The lesser of two integers.
///
/// Written out rather than `i32::min` for the reason [`step_toward`] is written out: the
/// TypeScript mirror is then the SAME LITERAL EXPRESSION rather than a same-named builtin
/// in each language. `i32::min` and `Math.min` agree today; one shared comparison cannot
/// start disagreeing, two same-named builtins can.
fn lo2(a: i32, b: i32) -> i32 {
    if a < b { a } else { b }
}

/// The greater of two integers. See [`lo2`] for why this is not `i32::max`.
fn hi2(a: i32, b: i32) -> i32 {
    if a > b { a } else { b }
}

/// Walk `x` from `from_x` to `to_x` along the fixed row `y`, pushing each cell AFTER the
/// move. A zero-length run pushes nothing and leaves the chain's last cell untouched.
fn run_x(cells: &mut Vec<(i32, i32)>, y: i32, from_x: i32, to_x: i32) {
    let s = step_toward(from_x, to_x);
    let mut x = from_x;
    while x != to_x {
        x += s;
        cells.push((x, y));
    }
}

/// Walk `y` from `from_y` to `to_y` along the fixed column `x`. See [`run_x`].
fn run_y(cells: &mut Vec<(i32, i32)>, x: i32, from_y: i32, to_y: i32) {
    let s = step_toward(from_y, to_y);
    let mut y = from_y;
    while y != to_y {
        y += s;
        cells.push((x, y));
    }
}

/// Where a ray fired from `(x, y)` in unit direction `d` first meets the corridor
/// rectangle's boundary, in closed form. `d` is never `(0, 0)`: [`perimeter_cells`]'s D1
/// gate has already declined a forged side byte before this is reached.
fn ray_hit(x: i32, y: i32, d: (i32, i32), cx0: i32, cy0: i32, cx1: i32, cy1: i32) -> (i32, i32) {
    match d {
        (1, 0) => (cx1, y),
        (-1, 0) => (cx0, y),
        (0, -1) => (x, cy0),
        // (0, 1). D1 already excluded (0, 0), so this arm is SOUTH and nothing else.
        _ => (x, cy1),
    }
}

/// The position of a boundary cell of the corridor rectangle along the canonical ring
/// traversal: start at `(cx0, cy0)` and run CLOCKWISE in screen space (y-down) — east
/// along the top, south down the right, west along the bottom, north up the left.
///
/// Exact inverse of [`ring_cell`] on `0..=l-1` where `l = 2*(w+h)`. Consecutive indices
/// differ by exactly one unit step across all three seams and across the `l-1 -> 0` wrap.
/// The four corners are index `0 = (cx0,cy0)`, `w = (cx1,cy0)`, `w+h = (cx1,cy1)` and
/// `2w+h = (cx0,cy1)`.
fn ring_index(cx0: i32, cy0: i32, cx1: i32, cy1: i32, x: i32, y: i32) -> i32 {
    let w = cx1 - cx0;
    let h = cy1 - cy0;
    if y == cy0 {
        x - cx0 // top,    0 ..= w
    } else if x == cx1 {
        w + (y - cy0) // right,  w+1 ..= w+h
    } else if y == cy1 {
        w + h + (cx1 - x) // bottom, w+h+1 ..= 2w+h
    } else {
        2 * w + h + (cy1 - y) // left,   2w+h+1 ..= 2w+2h-1
    }
}

/// The boundary cell at ring position `i`. Exact inverse of [`ring_index`] on `0..=l-1`.
fn ring_cell(cx0: i32, cy0: i32, cx1: i32, cy1: i32, i: i32) -> (i32, i32) {
    let w = cx1 - cx0;
    let h = cy1 - cy0;
    if i <= w {
        (cx0 + i, cy0)
    } else if i <= w + h {
        (cx1, cy0 + (i - w))
    } else if i <= 2 * w + h {
        (cx1 - (i - w - h), cy1)
    } else {
        (cx0, cy1 - (i - 2 * w - h))
    }
}

/// The UNION-BOX PERIMETER RING candidate (72-16): leave the source straight along its
/// outward normal until the boundary of the two machines' union bounding box inflated by
/// one cell, ride that boundary the shorter way round, then run straight into the target
/// along the target's inward normal. `None` means "not my shape, hand this pair on".
///
/// # Why this exists
/// With the Route west of the Handler, the Handler's `Out` is on E and the Route's `In` is
/// on W, so `f` and `nt` both point east while the walk direction `sx` is `-1`. All four
/// admissibility booleans are false, both Z guards are dead, and [`face_aligned_cells`]
/// reaches its final `else { true }` arm — the pre-72 plain L, drawn detached from BOTH of
/// its ports. The intended behavior for that cable is "make it go around".
///
/// # The four decline gates are INPUT-SELECTION RULES, never predicates over a built path
/// That distinction is what keeps "`route()` is the only acceptance oracle" true as
/// written: D0/D1/D2 choose which SHAPE to build, before anything is built. Any path this
/// function does build goes through [`route`](crate::route::route) like every other.
/// A malformed BODY does not decline — Step 1's `lo2`/`hi2` fold normalizes it — so there
/// is deliberately no fifth gate turning a total function into a conditional one.
///
/// # Why the output is ALWAYS a valid [`route`](crate::route::route) input
/// [`face_aligned_cells`]'s strictly-increasing potential CANNOT be reused here: the ring
/// walk is deliberately non-monotone. Two lemmas replace it. Write `S1` for the closed run
/// `A..P*`, `S2` for the ring cells strictly after `P*` up to and including `Q*`, and `S3`
/// for the run strictly after `Q*` up to and including `B`.
///
/// NOT EMPTY: `cells` is seeded with `A` and nothing is ever removed.
///
/// ADJACENT: inside `S1`/`S3`, [`run_x`]/[`run_y`] push one cell immediately after moving
/// one coordinate by `+/-1`. Inside `S2`, consecutive ring indices are one unit step apart
/// on every edge and across all four seams. At the joins: `S1` ends at `P*` = index `i` and
/// `S2`'s first push is index `(i +/- 1) mod l`; `S2` ends at `Q*` and `S3`'s first push is
/// one step from `Q*` along `nt`. Both runs are NON-EMPTY because `A` is in `K` (the
/// dock-cell fold, Step 1), which gives `cx0+1 <= ax <= cx1-1` for `f = E` and
/// symmetrically for the other three directions and for `B`.
///
/// LEMMA 1 (interior/ring separation). `Interior(C) == K` by Step 1's inflation.
/// `A` is in `K` by the dock-cell fold, so `A` is in `Interior(C)`. `S1` runs along `f` and
/// stops the first time it reaches a boundary coordinate, so every `S1` cell before `P*`
/// keeps `A`'s other coordinate, which is strictly between the boundary values; hence
/// `S1 \ {P*}` is inside `Interior(C)`, and symmetrically `S3 \ {Q*}`. Every `S2` cell is a
/// [`ring_cell`] output, hence ON the boundary, hence NOT in `Interior(C)`. So `S2` could
/// collide with `S1` or `S3` only at `P*` or `Q*`, and it emits neither: it starts at index
/// `i +/- 1` and ends at `Q*`, which `S3` does not re-push.
///
/// LEMMA 2 (`S1` and `S3` disjoint, UNDER D2). Both are axis-aligned segments: `S1` on the
/// ray from `A` along `f`, `S3` on the ray from `B` along `t` walked backwards.
/// (a) Both horizontal. If `ay != by` they are on different rows. If `ay == by` then
/// `sy == 0` and `A != B` forces `sx != 0`; not-`leave_x` gives `fx == -sx` and
/// not-`arrive_x` gives `tx == sx`, so `S1` satisfies `sx*x <= sx*ax` while `S3` satisfies
/// `sx*x >= sx*bx > sx*ax`. Contradiction.
/// (b) `f` horizontal, `t` vertical: `S1` is on row `ay`, `S3` on column `bx`, so they
/// could meet only at `(bx, ay)`. `S1` contains it only if `fx*(bx-ax) >= 0` while
/// not-`leave_x` gives `fx*(bx-ax) <= 0`, so `bx == ax`; then `sy != 0` (else `A == B`,
/// excluded by D0) and not-`arrive_y` gives `ty == sy`, so `ty*(ay-by) < 0` and `S3` does
/// not contain it. Contradiction.
/// (c) and (d) are (b) and (a) with the axes exchanged.
///
/// COROLLARY: `P*` is in `S1` and `Q*` is in `S3`, so Lemma 2 also proves `P* != Q*`, hence
/// `d_cw` is in `[1, l-1]` and the ring walk is never empty and never degenerate.
///
/// WITHIN each piece: `S1` and `S3` are monotone straight runs, and `S2` visits
/// `min(d_cw, l-d_cw) <= l-1` distinct indices under the [`ring_index`]/[`ring_cell`]
/// bijection. Globally distinct, so [`route`](crate::route::route) accepts every path this
/// candidate emits, for every dock pair passing D0-D2.
///
/// THIS PROOF IS NOT RESTATED IN THE TS MIRROR. A proof maintained in two places is a
/// proof maintained in neither; `wireRoute.ts` points here, as it already does for
/// [`face_aligned_cells`].
///
/// # Body clearance (a VISUAL claim, separate from validity)
/// `S2` is outside `K`, hence outside both bodies. `S1 \ {A}` never enters `from.body` by
/// the half-plane property above, and never enters `to.body` because two PLACED machines
/// have disjoint rectangles: if `to.body` met `A`'s ray along `f` then `B` would lie
/// strictly on the `f` side of `A`, which makes `leave_x` or `leave_y` true and D2 would
/// have declined. Symmetrically for `S3`. On OVERLAPPING bodies — non-physical, reachable
/// only from a forged packet or a synthetic corpus row — validity still holds (neither
/// lemma uses disjointness) but this clearance claim does NOT.
///
/// # Why this is `pub`
/// `tests/wire_corpus.rs` gate G1 calls it DIRECTLY, bypassing [`wire_route`]'s ladder,
/// because that ladder swallows a `route()` rejection. A gate that can only reach this
/// function through the arm that hides its failure is a gate that cannot fail.
pub fn perimeter_cells(from: WireDock, to: WireDock) -> Option<Vec<(i32, i32)>> {
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;

    // D0: coincident docks. `wire_route_traced` refuses them before the ladder since
    // 75-03; this gate stays so the function is total when G1 and G2 call it directly.
    if ax == bx && ay == by {
        return None;
    }

    // D1: a forged or future side byte on either end. `normal` is TOTAL and returns
    // `(0,0)` for one, and that degrades to today's plain L rather than a wrong shape.
    // Declining here is what keeps `normal`'s totality contract load-bearing.
    let f = normal(from.side);
    let t = normal(to.side);
    if f == (0, 0) || t == (0, 0) {
        return None;
    }

    // D2: the four admissibility booleans. THESE ARE THE IDENTICAL FOUR EXPRESSIONS AS
    // `face_aligned_cells`, character for character, and that identity is the whole
    // argument that the set reaching the ring is EXACTLY the set that reached the final
    // `else { true }` arm. Any one of them true means the ladder below can honour at least
    // one face, so the pair is handed on and keeps today's bytes.
    let nt = (-t.0, -t.1);
    let sx = step_toward(ax, bx);
    let sy = step_toward(ay, by);
    let leave_x = sx != 0 && f == (sx, 0);
    let leave_y = sy != 0 && f == (0, sy);
    let arrive_x = sx != 0 && nt == (sx, 0);
    let arrive_y = sy != 0 && nt == (0, sy);
    if leave_x || leave_y || arrive_x || arrive_y {
        return None;
    }

    // Step 1: the keep-out box K, then the corridor rectangle C = K inflated by one cell.
    //
    // BOTH machine bodies AND BOTH DOCK CELLS are folded in. The dock-cell fold is what
    // makes `A in K` UNCONDITIONAL, which is what makes S1 non-empty and P* provably
    // non-corner; and the `lo2`/`hi2` over `(x0, x1)` absorbs a forged box with
    // `x0 > x1` with no fifth decline gate. MEASURED at design time: dropping the
    // `lo2(ax,bx)`/`hi2(ax,bx)` terms changes 0 of 9280 honest corpus rows, so no honest
    // row can ever pin this line — `forged_body_not_containing_its_dock_still_routes`
    // below is the only thing that can.
    let (px0, py0, px1, py1) = (
        from.body.min_x,
        from.body.min_y,
        from.body.max_x,
        from.body.max_y,
    );
    let (qx0, qy0, qx1, qy1) = (to.body.min_x, to.body.min_y, to.body.max_x, to.body.max_y);
    let kx0 = lo2(lo2(px0, px1), lo2(lo2(qx0, qx1), lo2(ax, bx)));
    let kx1 = hi2(hi2(px0, px1), hi2(hi2(qx0, qx1), hi2(ax, bx)));
    let ky0 = lo2(lo2(py0, py1), lo2(lo2(qy0, qy1), lo2(ay, by)));
    let ky1 = hi2(hi2(py0, py1), hi2(hi2(qy0, qy1), hi2(ay, by)));
    let (cx0, cy0, cx1, cy1) = (kx0 - 1, ky0 - 1, kx1 + 1, ky1 + 1);
    let w = cx1 - cx0;
    let h = cy1 - cy0;
    // w, h >= 2 because C is K inflated on all four sides, so l >= 8.
    let l = 2 * (w + h);

    // Step 2: the two landing cells. Both land STRICTLY INSIDE an edge and never on a
    // corner: for `f = E`, `P* = (cx1, ay)` and `ky0 <= ay <= ky1` gives `cy0 < ay < cy1`.
    let p = ray_hit(ax, ay, f, cx0, cy0, cx1, cy1);
    let q = ray_hit(bx, by, t, cx0, cy0, cx1, cy1);

    // Step 3: ring positions and the shorter direction.
    let i = ring_index(cx0, cy0, cx1, cy1, p.0, p.1);
    let j = ring_index(cx0, cy0, cx1, cy1, q.0, q.1);
    // BOTH MODULO NUMERATORS ARE PROVABLY IN `[1, 2l-1]` AND NEVER NEGATIVE. `i` and `j`
    // are in `0..=l-1`, so `j - i + l` is in `[1, 2l-1]`; and below, `i - k + l` for `k` in
    // `1..=l-1` is in `[1, 2l-1]` likewise. This is the ONE place Rust `%` and JS `%` could
    // have disagreed (they differ only on a negative dividend) and it is closed BY RANGE
    // rather than by convention.
    let d_cw = (j - i + l) % l;

    // Step 4: emit.
    let mut cells = vec![(ax, ay)];
    // S1: A -> P* along f.
    if f.0 != 0 {
        run_x(&mut cells, ay, ax, p.0);
    } else {
        run_y(&mut cells, ax, ay, p.1);
    }
    // S2: the ring, the shorter way. An exact tie goes clockwise.
    if 2 * d_cw <= l {
        let mut k = 1;
        while k <= d_cw {
            cells.push(ring_cell(cx0, cy0, cx1, cy1, (i + k) % l));
            k += 1;
        }
    } else {
        let d_ccw = l - d_cw;
        let mut k = 1;
        while k <= d_ccw {
            cells.push(ring_cell(cx0, cy0, cx1, cy1, (i - k + l) % l));
            k += 1;
        }
    }
    // S3: Q* -> B along nt = -t.
    if t.0 != 0 {
        run_x(&mut cells, by, q.0, bx);
    } else {
        run_y(&mut cells, bx, q.1, by);
    }
    Some(cells)
}

/// The deterministic FACE-ALIGNED cell path from `from` to `to`.
///
/// Leaves along the source port's outward normal and arrives against the target port's
/// outward normal wherever a monotone A->B walk travels that way; falls back per face to
/// the plain X-first L otherwise.
///
/// # Why the output is ALWAYS a valid [`route`](crate::route::route) input
/// Not empty: `cells` is seeded with `A` before any branch and nothing is ever removed.
///
/// Adjacent: every cell after the seed is pushed immediately after moving exactly one
/// coordinate by exactly `+/-1` from the previously pushed cell, and each run starts from
/// the coordinates the previous run ended at. An empty run preserves adjacency because it
/// pushes nothing.
///
/// Distinct (the GLOBAL check `route` makes, not merely a consecutive one): in every
/// branch each x-step is exactly `+sx` and each y-step exactly `+sy`. In the Z branches
/// the room guard `turn != a` forces `|delta| >= 2` on the split axis, so the first run's
/// step is `+s` and the closing run is exactly one `+s` step. Define
/// `phi(c) = sx*c.x + sy*c.y`. Each step changes exactly one coordinate by its own sign,
/// and `sx*sx == 1`, `sy*sy == 1`, so `phi` rises by exactly `1` at every step and never
/// by `0` (an axis whose sign is `0` contributes no steps in any branch). `phi` is
/// therefore STRICTLY INCREASING along the emitted list, so no cell can repeat.
///
/// Hence `route()` accepts this for every dock pair, and [`wire_route`]'s fallback arm is
/// dead by proof rather than by hope.
///
/// # Why this is `pub`
/// `tests/wire_corpus.rs` gate G2 reads the FIRST and LAST STEP of the path this emits,
/// which is how it checks the ladder and [`perimeter_cells`]'s D2 agree without restating
/// either as a second predicate.
pub fn face_aligned_cells(from: WireDock, to: WireDock) -> Vec<(i32, i32)> {
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;
    let mut cells = vec![(ax, ay)];
    if ax == bx && ay == by {
        return cells;
    }

    // The two directions a monotone A -> B walk actually travels.
    let sx = step_toward(ax, bx);
    let sy = step_toward(ay, by);

    let f = normal(from.side); // the direction that LEAVES the source
    let t = normal(to.side);
    let nt = (-t.0, -t.1); // the direction that ARRIVES at the target

    // "Admissible" = this face's direction is one the walk travels. Four independent
    // booleans and nothing else; no ordering, no comparator, no arithmetic on sides.
    let leave_x = sx != 0 && f == (sx, 0);
    let leave_y = sy != 0 && f == (0, sy);
    let arrive_x = sx != 0 && nt == (sx, 0);
    let arrive_y = sy != 0 && nt == (0, sy);

    // (1) Both faces admissible ON THE SAME AXIS. A single L cannot both start and end on
    //     the same axis, so this needs a Z: three runs, two corners. The turn line is the
    //     TARGET's stub line, one cell outside its port face, which is what keeps the
    //     cable off the target's body right up to the final step onto the nub cell.
    if leave_x && arrive_x {
        let turn = bx - sx;
        if turn != ax {
            // turn == ax means |dx| == 1: the machines abut and there is no free column
            // to jog in. Fall through to (2), which keeps the ARRIVAL face.
            run_x(&mut cells, ay, ax, turn);
            run_y(&mut cells, turn, ay, by);
            run_x(&mut cells, by, turn, bx);
            return cells;
        }
    }
    if leave_y && arrive_y {
        let turn = by - sy;
        if turn != ay {
            run_y(&mut cells, ax, ay, turn);
            run_x(&mut cells, turn, ax, bx);
            run_y(&mut cells, bx, turn, by);
            return cells;
        }
    }

    // (2) Otherwise ONE L, bend order chosen by which face it can serve.
    //     ARRIVAL WINS TIES, deliberately: a wrong departure is ugly, but a wrong ARRIVAL
    //     is a lie about which port the cable is plugged into, and that lie is the defect
    //     that was reported. The final `true` is the earlier behaviour, reached only when
    //     neither port's normal points anywhere the walk goes.
    // `needless_bool` sees the tail `else if leave_y { false } else { true }` and offers
    // `!leave_y`. DECLINED: this is a five-arm PRIORITY LADDER whose order is the design
    // (arrival beats departure), and it is mirrored expression-for-expression in
    // `wireRoute.ts`. Collapsing the tail would hide the order, break the 1:1 mirror the
    // parity corpus exists to protect, and make the next edit to the priorities a
    // two-shape edit instead of one.
    #[allow(clippy::needless_bool)]
    let x_first = if arrive_y {
        true
    } else if arrive_x {
        false
    } else if leave_x {
        true
    } else if leave_y {
        false
    } else {
        true
    };
    if x_first {
        run_x(&mut cells, ay, ax, bx);
        run_y(&mut cells, bx, ay, by);
    } else {
        run_y(&mut cells, ax, ay, by);
        run_x(&mut cells, by, ax, bx);
    }
    cells
}

/// THE ONE-FACE GATE (75-01, D-01 and D-02): true exactly when [`face_aligned_cells`]
/// would honour ONE of the two faces and not the other.
///
/// An INPUT-SELECTION RULE, never a predicate over a built path (the module docblock's
/// house rule): it is the same four admissibility expressions as [`face_aligned_cells`],
/// character for character, plus that function's two Z room guards and its `x_first`
/// ladder, and from those it reads which way the face-aligned shape's first and last
/// steps would go without building it.
///
/// - Coincident docks and a forged side byte return false: neither is this class.
/// - All four booleans false returns false: that is the ring's class.
/// - A Z that fires honours both faces by construction, so it returns false.
/// - Otherwise the single L's first step is `(sx, 0)` when it walks x first and `sx != 0`,
///   else `(0, sy)`; its last step is `(0, sy)` when `sy != 0` after an x-first walk,
///   else `(sx, 0)`; and symmetrically for a y-first walk. Any boolean true means at least
///   one face is honoured (proved by the ladder: each arm picks the order that serves the
///   face it names), so "not both" is "exactly one".
///
/// `tests/wire_corpus.rs` G3 holds this equal to the EMITTED first and last steps of
/// [`face_aligned_cells`] on every corpus row, without calling this function.
fn face_aligned_honours_exactly_one_face(from: WireDock, to: WireDock) -> bool {
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;
    if ax == bx && ay == by {
        return false;
    }
    let f = normal(from.side);
    let t = normal(to.side);
    if f == (0, 0) || t == (0, 0) {
        return false;
    }

    // THE IDENTICAL FOUR EXPRESSIONS AS `face_aligned_cells`, character for character.
    let sx = step_toward(ax, bx);
    let sy = step_toward(ay, by);
    let nt = (-t.0, -t.1);
    let leave_x = sx != 0 && f == (sx, 0);
    let leave_y = sy != 0 && f == (0, sy);
    let arrive_x = sx != 0 && nt == (sx, 0);
    let arrive_y = sy != 0 && nt == (0, sy);

    // The ring's class: the face-aligned shape honours neither face.
    if !leave_x && !leave_y && !arrive_x && !arrive_y {
        return false;
    }
    // The two Z branches, with their room guards: a Z that fires honours both faces.
    if leave_x && arrive_x && bx - sx != ax {
        return false;
    }
    if leave_y && arrive_y && by - sy != ay {
        return false;
    }

    // `face_aligned_cells`' bend-order ladder, verbatim (and declined from
    // `needless_bool` for the reason written there).
    #[allow(clippy::needless_bool)]
    let x_first = if arrive_y {
        true
    } else if arrive_x {
        false
    } else if leave_x {
        true
    } else if leave_y {
        false
    } else {
        true
    };
    let honours_both = if x_first {
        (leave_x || (sx == 0 && leave_y)) && (arrive_y || (sy == 0 && arrive_x))
    } else {
        (leave_y || (sy == 0 && leave_x)) && (arrive_x || (sx == 0 && arrive_y))
    };
    !honours_both
}

/// A body rectangle normalised so `x0 <= x1` and `y0 <= y1`, the way the ring's Step 1
/// folds a forged box with `lo2`/`hi2`: `(x0, y0, x1, y1)`, inclusive.
fn norm_body(b: WireBody) -> (i32, i32, i32, i32) {
    (
        lo2(b.min_x, b.max_x),
        lo2(b.min_y, b.max_y),
        hi2(b.min_x, b.max_x),
        hi2(b.min_y, b.max_y),
    )
}

/// The four rectangles no go-around cell may enter: both bodies and both dock cells.
/// The dock cells are listed on their own because a forged body need not contain its
/// dock.
fn go_around_blocks(from: WireDock, to: WireDock) -> [(i32, i32, i32, i32); 4] {
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;
    [
        norm_body(from.body),
        norm_body(to.body),
        (ax, ay, ax, ay),
        (bx, by, bx, by),
    ]
}

/// Whether the closed axis-aligned box `(x0, y0)..=(x1, y1)` (a segment or a point,
/// `x0 <= x1`, `y0 <= y1`) touches any of `blocks`. Integer interval overlap per axis.
///
/// A slice since phase 92: the ladder passes its four rectangles, the obstacle stage
/// passes those four plus the window's obstacles.
fn box_blocked(blocks: &[(i32, i32, i32, i32)], x0: i32, y0: i32, x1: i32, y1: i32) -> bool {
    blocks
        .iter()
        .any(|&(rx0, ry0, rx1, ry1)| x0 <= rx1 && x1 >= rx0 && y0 <= ry1 && y1 >= ry0)
}

/// The compressed line set the go-around searches (75-RESEARCH Pattern 2): on each axis,
/// every start's and every finish's coordinate plus the lines one cell outside each body.
/// For the go-around (one start, one finish) that is at most SIX lines per axis, so at most
/// 36 nodes, whatever the distance between the two machines: the bound threat T-75-01 asks
/// for, read from here by the inline test
/// `the_go_around_search_is_bounded_by_its_lines_not_the_board`. Candidate 4 adds the
/// coordinates of up to four starts and four finishes, all within one cell of a dock, so at
/// most three distinct values per dock per axis: at most TEN lines per axis (75-RESEARCH
/// Pattern 3, "the start and finish cells' coordinates added to the line sets").
///
/// Every line lies inside the ring's corridor (`K` inflated by one, `perimeter_cells`
/// Step 1) by construction: a body line is one cell outside a body `K` contains, and a
/// start or finish is one cell from a dock `K` contains. So no clip to the corridor is
/// written.
///
/// Sorted ascending and deduplicated, in a `Vec`: no hashing anywhere.
fn go_around_lines(
    from: WireDock,
    to: WireDock,
    starts: &[SearchEnd],
    finishes: &[SearchEnd],
) -> (Vec<i32>, Vec<i32>) {
    let (px0, py0, px1, py1) = norm_body(from.body);
    let (qx0, qy0, qx1, qy1) = norm_body(to.body);
    let mut xs = vec![px0 - 1, px1 + 1, qx0 - 1, qx1 + 1];
    let mut ys = vec![py0 - 1, py1 + 1, qy0 - 1, qy1 + 1];
    for e in starts.iter().chain(finishes) {
        xs.push(e.cell.0);
        ys.push(e.cell.1);
    }
    xs.sort_unstable();
    xs.dedup();
    ys.sort_unstable();
    ys.dedup();
    (xs, ys)
}

/// The side index of a unit step (`N=0, E=1, S=2, W=3`, the [`normal`] numbering), or
/// `None` for anything that is not one of the four unit steps.
fn heading_of(v: (i32, i32)) -> Option<usize> {
    match v {
        (0, -1) => Some(0),
        (1, 0) => Some(1),
        (0, 1) => Some(2),
        (-1, 0) => Some(3),
        _ => None,
    }
}

/// THE GO-AROUND SEARCH (75-01, D-01): the path from `start` to `finish` that keeps every
/// cell outside both bodies and off both dock cells, SHORTEST FIRST and FEWEST BENDS
/// second, where a bend is also counted at `start` if the first move is not `first` and
/// at `finish` if the last move is not `last`. Returns the cells `start ..= finish`, or
/// `None` when no such path exists in the line set (or `start`/`finish` is blocked, or a
/// heading is not a unit step).
///
/// A thin entry over [`search_between_ends`], the ONE search routine, with a single start
/// and a single finish and no penalties: candidate 4 ([`CAND_CLEAR_OF_BODIES`]) runs the
/// same routine with sets of ends, so the two candidates cannot drift apart.
///
/// # How
/// It searches a COMPRESSED grid ([`go_around_lines`], at most six lines per axis), never
/// cell by cell, so its cost is bounded by a constant and not by the board (threat
/// T-75-01). Nodes are the line intersections; an edge joins two consecutive lines on one
/// row or column and exists only if no cell of the CLOSED segment is in either body or on
/// either dock. Orthogonal connector routing over such lines is optimal for any cost
/// monotone in length and bends (Wybrow, Marriott, Stuckey, GD 2009, section 3); the
/// cell-grid version used here was checked against an exhaustive cell search in
/// 75-RESEARCH and is held by the corpus gates in `tests/wire_corpus.rs`.
///
/// A BACKWARD Dijkstra from `finish` fills a cost-to-go table over `(node, heading)`, then
/// a FORWARD walk from `(start, first)` takes, at every node, the first move in the order
/// straight, N, E, S, W whose cost keeps the remaining optimum. The table is unique
/// whatever order the queue pops ties in, so the cells do not depend on queue order,
/// which is what lets the TypeScript mirror use its own heap. "Straight first" puts the
/// jog at the target end, as the face-aligned Z does.
///
/// NO "NEVER STRAIGHT BACK" RULE IS WRITTEN, ON PURPOSE. The walk only ever takes a move
/// that keeps the whole walk globally optimal, and a walk that turns straight back
/// retraces a segment, so cutting that loop out is strictly shorter: no optimal walk turns
/// back, so no such move ever keeps the optimum. At `start` turning back would also enter
/// `A`, which is blocked. MEASURED at 75-01: an exclusion in both the backward relaxation
/// and the forward walk, removed alone, reddened nothing in `wire_corpus`,
/// `wire_side_aware`, `wire_golden` or this module's tests, so it held by construction and
/// was deleted rather than kept as a term no check can see.
///
/// # Why the cells are always a valid [`route`](crate::route::route) input
/// A length-minimal walk never repeats a cell: two segments of it can only meet at a line
/// intersection, which is a node, and a walk through a node twice can be cut short,
/// strictly reducing length, which comes first in the cost. Every pushed cell lies on an
/// edge whose closed segment is free, so it is outside both bodies and off both docks.
/// Consecutive cells are adjacent because [`run_x`]/[`run_y`] push one cell per unit move
/// and each segment starts where the previous one ended. The caller wraps the walk as
/// `[A] ++ walk ++ [B]` with `A != B`: `A` and `B` are blocked in the interior, `start`
/// must be one step from `A` and `finish` one step from `B`, so the whole list is adjacent
/// and distinct. (On coincident docks the wrap would repeat a cell; the gate in front of
/// the ladder arm never passes them.) [`route`](crate::route::route) remains the only judge all the same.
///
/// # Why this is `pub`
/// `tests/wire_corpus.rs` runs it DIRECTLY on corpus rows, bypassing the ladder that
/// would swallow a `route()` rejection (the [`perimeter_cells`] precedent): G3 asserts it
/// declines on the one-face rows the go-around did not win, and the pins judge its output
/// with `route()` on every row it did win.
pub fn go_around_search(
    from: WireDock,
    to: WireDock,
    start: (i32, i32),
    first: (i32, i32),
    finish: (i32, i32),
    last: (i32, i32),
) -> Option<Vec<(i32, i32)>> {
    search_between_ends(
        from,
        to,
        &[SearchEnd {
            cell: start,
            dir: first,
            missed: false,
        }],
        &[SearchEnd {
            cell: finish,
            dir: last,
            missed: false,
        }],
    )
}

/// One end of [`search_between_ends`]: a cell next to a dock, the step between that dock
/// and the cell IN THE CABLE'S DIRECTION (dock to cell at the source, cell to dock at the
/// target), and whether that step misses the port's face.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SearchEnd {
    /// The cell the walk starts or finishes on.
    pub cell: (i32, i32),
    /// The unit step between the dock and `cell`, along the cable.
    pub dir: (i32, i32),
    /// True when `dir` is not the port's face direction: a departure that does not leave
    /// along the source normal, or an arrival that does not enter against the target's.
    pub missed: bool,
}

/// THE ONE SEARCH ROUTINE (75-01, generalised at 75-03): the walk from one of `starts` to
/// one of `finishes` that keeps every cell outside both bodies and off both dock cells,
/// least `(length, arrival missed, departure missed, bends)` first, compared in that
/// order. "Arrival missed" is the chosen finish's `missed`, "departure missed" the chosen
/// start's; a bend is counted at the start if the first move is not the start's `dir`, at
/// the finish if the last move is not the finish's `dir`, and at every turn between.
/// Returns the cells `start ..= finish`, or `None` when no start or no finish is free or
/// no walk exists in the line set.
///
/// With ONE start, ONE finish and no penalties this is exactly the 75-01 go-around search:
/// the two penalty terms are zero on every walk, so the order is `(length, bends)`, the
/// line set is the 75-01 one, and the walk is the 75-01 walk. That is what keeps every
/// cand-3 corpus row's bytes at the 75-03 re-bless.
///
/// # How
/// A backward Dijkstra from EVERY free finish fills a cost-to-go table over `(node,
/// heading)` of `(length, arrival missed, bends)`; the departure penalty is constant per
/// start, so it is added only when the start is chosen: the first start, IN THE ORDER
/// GIVEN, whose total is the least. The caller orders the starts with the face-honouring
/// one first, then N, E, S, W, which is the canonical walk's own "straight first" rule
/// applied at the dock. The forward walk then takes, at every node, the first move in the
/// order straight, N, E, S, W that keeps the remaining optimum, and stops on the first
/// node whose remaining length is zero, which is only ever a finish. A walk never runs
/// THROUGH one finish to another: stopping at the first is strictly shorter, and length
/// comes first.
///
/// The validity argument is the go-around's, unchanged: a length-minimal walk never
/// repeats a cell, every pushed cell is on a free closed segment, consecutive cells are
/// adjacent, and the caller's `[A] ++ walk ++ [B]` is adjacent because every start is one
/// step from `A` and every finish one step from `B`.
pub fn search_between_ends(
    from: WireDock,
    to: WireDock,
    starts: &[SearchEnd],
    finishes: &[SearchEnd],
) -> Option<Vec<(i32, i32)>> {
    let blocks = go_around_blocks(from, to);
    let starts = free_ends(&blocks, starts);
    let finishes = free_ends(&blocks, finishes);
    if starts.is_empty() || finishes.is_empty() {
        return None;
    }
    let (xs, ys) = go_around_lines(from, to, &starts, &finishes);
    search_on_lines(&blocks, &xs, &ys, &starts, &finishes)
}

/// The ends of `ends` a search may use: a unit-step `dir` and a cell outside every block.
/// Kept in the order given, which is the order the start choice reads.
fn free_ends(blocks: &[(i32, i32, i32, i32)], ends: &[SearchEnd]) -> Vec<SearchEnd> {
    ends.iter()
        .filter(|e| {
            heading_of(e.dir).is_some()
                && !box_blocked(blocks, e.cell.0, e.cell.1, e.cell.0, e.cell.1)
        })
        .copied()
        .collect()
}

/// Which segments of the line set `xs` by `ys` touch a block, as two tables (review WR-A-03,
/// phase 92): `row[j * (nx - 1) + i]` for the closed segment from `(xs[i], ys[j])` to
/// `(xs[i + 1], ys[j])`, and `col[j * nx + i]` for the one from `(xs[i], ys[j])` to
/// `(xs[i], ys[j + 1])`. Each entry is exactly `box_blocked(blocks, ..)` for its segment, built
/// in one pass over the blocks and one over the tables rather than one scan of every block per
/// segment, so a search costs what its line set costs and not that times the machines.
///
/// Why each entry equals `box_blocked`: the row segment `i` on row `j` touches the block
/// `(rx0, ry0, rx1, ry1)` exactly when `xs[i] <= rx1`, `xs[i + 1] >= rx0` and
/// `ry0 <= ys[j] <= ry1`. With `lo(v)` the first index whose line is at least `v` and `hi(v)`
/// the first whose line is above `v` (both by bisection on the sorted lines), those read
/// `i < hi(rx1)`, `i + 1 >= lo(rx0)` and `lo(ry0) <= j < hi(ry1)`: one rectangle of table
/// entries per block, added to a two-dimensional difference array and summed. The column
/// table is the same with the axes exchanged. Integer counts only; no hashing.
fn edge_tables(blocks: &[(i32, i32, i32, i32)], xs: &[i32], ys: &[i32]) -> (Vec<bool>, Vec<bool>) {
    let (nx, ny) = (xs.len(), ys.len());
    let lo = |v: &[i32], t: i32| v.partition_point(|&a| a < t);
    let hi = |v: &[i32], t: i32| v.partition_point(|&a| a <= t);
    // One table of `w` by `h` entries, each the number of blocks over it, from the rectangles
    // `[i0, i1) x [j0, j1)` the blocks cover.
    let fill = |w: usize, h: usize, rects: &mut dyn Iterator<Item = (usize, usize, usize, usize)>| {
        let mut diff = vec![0_i32; (w + 1) * (h + 1)];
        for (i0, i1, j0, j1) in rects {
            if i0 < i1 && j0 < j1 {
                diff[j0 * (w + 1) + i0] += 1;
                diff[j0 * (w + 1) + i1] -= 1;
                diff[j1 * (w + 1) + i0] -= 1;
                diff[j1 * (w + 1) + i1] += 1;
            }
        }
        let mut out = vec![false; w * h];
        for j in 0..h {
            for i in 0..w {
                let up = if j > 0 { diff[(j - 1) * (w + 1) + i] } else { 0 };
                let left = if i > 0 { diff[j * (w + 1) + i - 1] } else { 0 };
                let corner = if i > 0 && j > 0 { diff[(j - 1) * (w + 1) + i - 1] } else { 0 };
                diff[j * (w + 1) + i] += up + left - corner;
                out[j * w + i] = diff[j * (w + 1) + i] > 0;
            }
        }
        out
    };
    let row = fill(
        nx.saturating_sub(1),
        ny,
        &mut blocks.iter().map(|&(rx0, ry0, rx1, ry1)| {
            (
                lo(xs, rx0).saturating_sub(1),
                hi(xs, rx1).min(nx.saturating_sub(1)),
                lo(ys, ry0),
                hi(ys, ry1),
            )
        }),
    );
    let col = fill(
        nx,
        ny.saturating_sub(1),
        &mut blocks.iter().map(|&(rx0, ry0, rx1, ry1)| {
            (
                lo(xs, rx0),
                hi(xs, rx1),
                lo(ys, ry0).saturating_sub(1),
                hi(ys, ry1).min(ny.saturating_sub(1)),
            )
        }),
    );
    (row, col)
}

/// The body of [`search_between_ends`], split out at phase 92 so the obstacle stage can
/// drive the same routine with a wider blocked set and line set: the backward Dijkstra,
/// the start choice and the canonical forward walk, over the line set `xs` by `ys`
/// (ascending, deduplicated) with `blocks` blocked. `starts` and `finishes` are already
/// free ([`free_ends`]) and their coordinates are on the line set; an end that is not is no
/// node, so it is no path (`node_of` is total).
fn search_on_lines(
    blocks: &[(i32, i32, i32, i32)],
    xs: &[i32],
    ys: &[i32],
    starts: &[SearchEnd],
    finishes: &[SearchEnd],
) -> Option<Vec<(i32, i32)>> {
    let nx = xs.len();
    let ny = ys.len();
    let node_of = |c: (i32, i32)| -> Option<usize> {
        Some(ys.binary_search(&c.1).ok()? * nx + xs.binary_search(&c.0).ok()?)
    };
    let (row_blocked, col_blocked) = edge_tables(blocks, xs, ys);

    // The neighbour of node `n` along heading `h`, and the segment length, if the closed
    // segment between them is free: one table read, the answer `box_blocked` gives for the
    // segment (see [`edge_tables`]).
    let next = |n: usize, h: usize| -> Option<(usize, i32)> {
        let (xi, yi) = (n % nx, n / nx);
        let (mx, my, free) = match h {
            0 if yi > 0 => (xi, yi - 1, !col_blocked[(yi - 1) * nx + xi]),
            1 if xi + 1 < nx => (xi + 1, yi, !row_blocked[yi * (nx - 1) + xi]),
            2 if yi + 1 < ny => (xi, yi + 1, !col_blocked[yi * nx + xi]),
            3 if xi > 0 => (xi - 1, yi, !row_blocked[yi * (nx - 1) + xi - 1]),
            _ => return None,
        };
        if !free {
            return None;
        }
        let (x0, x1) = (lo2(xs[xi], xs[mx]), hi2(xs[xi], xs[mx]));
        let (y0, y1) = (lo2(ys[yi], ys[my]), hi2(ys[yi], ys[my]));
        Some((my * nx + mx, (x1 - x0) + (y1 - y0)))
    };
    // Turning from heading `h` to move along `d` costs one bend.
    let bend = |h: usize, d: usize| -> i32 { i32::from(h != d) };

    // Backward Dijkstra: `cost[n * 4 + h]` is the least `(length, arrival missed, bends)`
    // from standing on node `n` having arrived along heading `h`, to finishing on any
    // finish with its last move along that finish's `dir`.
    let mut cost: Vec<Option<(i32, i32, i32)>> = vec![None; nx * ny * 4];
    let mut heap = BinaryHeap::new();
    for e in finishes {
        let fin = node_of(e.cell)?;
        let h_last = heading_of(e.dir)?;
        for h in 0..4 {
            let c = (0, i32::from(e.missed), bend(h, h_last));
            if cost[fin * 4 + h].is_none_or(|o| c < o) {
                cost[fin * 4 + h] = Some(c);
                heap.push(Reverse((c, fin, h)));
            }
        }
    }
    while let Some(Reverse((c, m, d))) = heap.pop() {
        if cost[m * 4 + d] != Some(c) {
            continue;
        }
        // Every node `p` with `m` as its neighbour along `d` is `m`'s neighbour along the
        // opposite heading, over the same closed segment.
        let Some((p, len)) = next(m, (d + 2) % 4) else {
            continue;
        };
        for h in 0..4 {
            let nc = (c.0 + len, c.1, c.2 + bend(h, d));
            if cost[p * 4 + h].is_none_or(|o| nc < o) {
                cost[p * 4 + h] = Some(nc);
                heap.push(Reverse((nc, p, h)));
            }
        }
    }

    // The start: the first, in the order given, whose total `(length, arrival missed,
    // departure missed, bends)` is the least.
    let total = |e: &SearchEnd| -> Option<(i32, i32, i32, i32)> {
        let c = cost[node_of(e.cell)? * 4 + heading_of(e.dir)?]?;
        Some((c.0, c.1, i32::from(e.missed), c.2))
    };
    let best = starts.iter().filter_map(total).min()?;
    let start = starts.iter().find(|e| total(e) == Some(best))?;

    // Forward canonical walk from `(start, start.dir)`.
    let mut cur = node_of(start.cell)?;
    let mut h = heading_of(start.dir)?;
    let mut c = cost[cur * 4 + h]?;
    let mut cells = vec![start.cell];
    while c.0 != 0 {
        let mut moved = false;
        for d in [h, 0, 1, 2, 3] {
            let Some((q, len)) = next(cur, d) else {
                continue;
            };
            let Some(qc) = cost[q * 4 + d] else {
                continue;
            };
            if (len + qc.0, qc.1, bend(h, d) + qc.2) == c {
                let (cx, cy) = (xs[cur % nx], ys[cur / nx]);
                let (qx, qy) = (xs[q % nx], ys[q / nx]);
                if cy == qy {
                    run_x(&mut cells, cy, cx, qx);
                } else {
                    run_y(&mut cells, cx, cy, qy);
                }
                cur = q;
                h = d;
                c = qc;
                moved = true;
                break;
            }
        }
        if !moved {
            // Unreachable: `c` is a table entry, so some move or a finish achieves it.
            return None;
        }
    }
    Some(cells)
}

/// The go-around candidate's cells, `[A] ++ walk ++ [B]`, or `None` when the one-face
/// gate does not fire or the search declines (a stub on a dock or inside either body, or
/// no path in the line set). The source stub is `A + f`, left along `f`; the target stub
/// is `B + t`, left INTO `B` along `-t`.
fn go_around_cells(from: WireDock, to: WireDock) -> Option<Vec<(i32, i32)>> {
    if !face_aligned_honours_exactly_one_face(from, to) {
        return None;
    }
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;
    let f = normal(from.side);
    let t = normal(to.side);
    let walk = go_around_search(
        from,
        to,
        (ax + f.0, ay + f.1),
        f,
        (bx + t.0, by + t.1),
        (-t.0, -t.1),
    )?;
    let mut cells = Vec::with_capacity(walk.len() + 2);
    cells.push((ax, ay));
    cells.extend(walk);
    cells.push((bx, by));
    Some(cells)
}

/// Every orthogonal neighbour of `dock` as a [`SearchEnd`], the face-honouring one first
/// and then N, E, S, W (the canonical walk's "straight first", applied at the dock), with
/// `missed` set where the step misses the port's face. `outward` is true at the source
/// (the step runs dock to neighbour) and false at the target (neighbour to dock).
fn dock_neighbours(dock: WireDock, outward: bool) -> Vec<SearchEnd> {
    let n = normal(dock.side);
    let mut out: Vec<SearchEnd> = Vec::with_capacity(4);
    for side in [dock.side, 0, 1, 2, 3] {
        let d = normal(side);
        if d == (0, 0) || out.iter().any(|e| e.cell == (dock.cell.0 + d.0, dock.cell.1 + d.1)) {
            continue;
        }
        out.push(SearchEnd {
            cell: (dock.cell.0 + d.0, dock.cell.1 + d.1),
            dir: if outward { d } else { (-d.0, -d.1) },
            missed: d != n,
        });
    }
    out
}

/// CANDIDATE 4's cells, `[A] ++ walk ++ [B]`, WITHOUT its gate: the shortest connection
/// from any free neighbour of the source dock to any free neighbour of the target dock
/// that crosses NEITHER machine, a straight arrival preferred to a straight departure,
/// fewest bends last (75-RESEARCH Pattern 3, D-04). `None` when either dock has no free
/// neighbour, or the docks share a cell.
///
/// # Why this is `pub`
/// `tests/wire_corpus.rs` runs it DIRECTLY on every row candidate 4 won and judges it with
/// `route()`, bypassing the ladder arm that would swallow a rejection (the
/// [`go_around_search`] precedent), and compares it with the relaxed oracle.
pub fn clear_of_bodies_search(from: WireDock, to: WireDock) -> Option<Vec<(i32, i32)>> {
    if from.cell == to.cell {
        return None;
    }
    let walk = search_between_ends(
        from,
        to,
        &dock_neighbours(from, true),
        &dock_neighbours(to, false),
    )?;
    let mut cells = Vec::with_capacity(walk.len() + 2);
    cells.push(from.cell);
    cells.extend(walk);
    cells.push(to.cell);
    Some(cells)
}

/// CANDIDATE 4's GATE (75-03, D-04), an input-selection rule like every other gate here:
/// the one-face gate holds, the two docks do not touch (touching pairs, P2, keep today's
/// two-cell run, already the shortest body-clear connection), and a stub cell, one step
/// out of a port along its normal, lies inside the OTHER machine's body on a cell that is
/// not the other dock. That last clause is exactly why the go-around declined: its stub is
/// blocked.
fn clear_of_bodies_cells(from: WireDock, to: WireDock) -> Option<Vec<(i32, i32)>> {
    if !face_aligned_honours_exactly_one_face(from, to) {
        return None;
    }
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;
    if (ax - bx).abs() + (ay - by).abs() == 1 {
        return None;
    }
    let inside = |c: (i32, i32), b: WireBody| {
        let (x0, y0, x1, y1) = norm_body(b);
        c.0 >= x0 && c.0 <= x1 && c.1 >= y0 && c.1 <= y1
    };
    let f = normal(from.side);
    let t = normal(to.side);
    let a1 = (ax + f.0, ay + f.1);
    let b1 = (bx + t.0, by + t.1);
    let faces_into = (inside(a1, to.body) && a1 != to.cell)
        || (inside(b1, from.body) && b1 != from.cell);
    if !faces_into {
        return None;
    }
    clear_of_bodies_search(from, to)
}

/// The deterministic single-L (X-first) Manhattan cell path from `from` to `to`.
///
/// Walks horizontally to the destination column, then vertically to the destination
/// cell. A monotone Manhattan walk, so the produced cells are always distinct and
/// orthogonally adjacent (a valid [`route`](crate::route::route) input). Coincident
/// endpoints yield the single origin cell.
fn manhattan_l(from: (i32, i32), to: (i32, i32)) -> Vec<(i32, i32)> {
    let (fx, fy) = from;
    let (tx, ty) = to;
    let mut cells = vec![(fx, fy)];
    // Horizontal leg: fx -> tx along y = fy.
    let mut x = fx;
    while x != tx {
        x += (tx - x).signum();
        cells.push((x, fy));
    }
    // Vertical leg: fy -> ty along x = tx.
    let mut y = fy;
    while y != ty {
        y += (ty - y).signum();
        cells.push((tx, y));
    }
    cells
}

/// Auto-route an electrical wire between two resolved endpoint terminals, normalized
/// through the belt [`route`](crate::route::route) so wire corners inherit proven
/// parity. PURE + deterministic + integer-only (no float, no RNG, no clock).
///
/// # Errors
/// [`WireRouteError::Coincident`] when both docks are on one cell: REACHABLE, but only
/// from a forged packet or a damaged port reference (no gesture can wire a machine to its
/// own cell), and the host draws a named stub for it rather than nothing.
/// [`WireRouteError::Route`] carries a [`RouteError`] from the shared normaliser and is
/// unreachable by proof: every candidate carries its own validity argument (the ring's two
/// lemmas, the go-around's shortest-walk argument, the face-aligned shape's increasing
/// potential), each emitted path is judged by `route()` before it is used, and the last
/// arm is a monotone Manhattan L `route()` always accepts on two distinct cells. Kept total
/// rather than `expect`ing so a future candidate stays honest.
pub fn wire_route(from: WireDock, to: WireDock) -> Result<WireGeometry, WireRouteError> {
    wire_route_traced(from, to).map(|(geometry, _cand)| geometry)
}

/// The perimeter ring won: [`wire_route_traced`]'s first candidate.
pub const CAND_PERIMETER: u8 = 0;
/// The face-aligned L/Z won: [`wire_route_traced`]'s second candidate.
pub const CAND_FACE_ALIGNED: u8 = 1;
/// The plain Manhattan L won: [`wire_route_traced`]'s last candidate, unreachable by proof.
pub const CAND_MANHATTAN: u8 = 2;
/// The go-around won (75-01): the one-face class, routed by [`go_around_search`] so the
/// cable leaves along the source normal and arrives against the target normal. Numbered
/// after the existing three so no frozen `cand` value changes meaning.
pub const CAND_GO_AROUND: u8 = 3;
/// CLEAR OF BODIES won (75-03, D-04): a port facing straight into the neighbour's body,
/// where any cable honouring that face must cross the neighbour, drawn as the shortest
/// connection crossing NEITHER machine.
///
/// # What fires it
/// The one-face gate holds, the docks do not touch, and a stub cell (one step out of a
/// port along its normal) lies inside the other machine's body, not on its dock. The
/// go-around declined such a pair because that stub is blocked.
///
/// # What it draws
/// [`search_between_ends`] with RELAXED ends: every free neighbour of the source dock is a
/// start and every free neighbour of the target dock a finish, each carrying a penalty for
/// missing its port's face, compared as `(length, arrival missed, departure missed,
/// bends)`. Length first, as D-04 says ("the shortest connection"); then a straight
/// ARRIVAL before a straight departure, because a wrong arrival is a lie about which port
/// the cable is plugged into (the module docblock, and the face-aligned ladder's own
/// "arrival wins ties"); then bends. The start and finish coordinates join the line set.
/// The go-around's validity argument carries over unchanged.
///
/// # Where it declines: the named P3b exception
/// When a dock has NO free neighbour outside both bodies, no body-clear connection exists
/// at all, so "crosses neither machine" is impossible and candidate 4 declines: today's
/// face-aligned L stays. That is D-03's P3b, named in `tests/common/mod.rs` before this
/// candidate existed. This is a chosen default and may be revisited.
pub const CAND_CLEAR_OF_BODIES: u8 = 4;
/// NO candidate won: the value a corpus row records in its `cand` column when
/// [`wire_route_traced`] refused the pair (75-03, the coincident rows). Never returned by
/// the router itself. Chosen as `u8::MAX` so it can never collide with a future
/// candidate number, which grows upward from 0; mirrored as `CAND_NONE` in
/// `frontend/src/protocol/wireRoute.ts`.
pub const CAND_NONE: u8 = 255;

/// [`wire_route`], plus WHICH CANDIDATE produced the geometry ([`CAND_PERIMETER`],
/// [`CAND_GO_AROUND`], [`CAND_CLEAR_OF_BODIES`], [`CAND_FACE_ALIGNED`] or
/// [`CAND_MANHATTAN`]).
///
/// # This exists so the ladder is written ONCE
/// `tests/wire_corpus.rs` freezes the winning candidate into a `cand` column on every
/// corpus row, which is what turns a silent fall-through into a diff (G1). The alternative
/// was for the corpus to re-derive the winner by restating the ladder, and a restated
/// ladder agrees with itself by construction: it would go green on exactly the fall-through
/// it exists to catch. So [`wire_route`] delegates here and the corpus reads what the real
/// ladder actually did.
///
/// # Errors
/// As [`wire_route`]: [`WireRouteError::Coincident`] for two docks on one cell, checked
/// BEFORE the ladder so no candidate ever sees the pair, and [`WireRouteError::Route`]
/// for a normaliser refusal of the last candidate, unreachable by proof.
pub fn wire_route_traced(
    from: WireDock,
    to: WireDock,
) -> Result<(WireGeometry, u8), WireRouteError> {
    // THE COINCIDENT CHECK COMES FIRST (75-03, D-05). A one-cell "path" has no first and
    // no last step, so it plugs into nothing; before 75-03 it fell through to
    // `face_aligned_cells`, came back as one tile, and the host drew it as nothing. It is
    // an INPUT check on the two cells, not a predicate over a built path, so the house rule
    // in the module docblock holds. `face_aligned_cells` keeps its one-cell return for
    // these docks: G2 in `tests/wire_corpus.rs` reads it directly.
    if from.cell == to.cell {
        return Err(WireRouteError::Coincident);
    }
    // FIVE CANDIDATES, and `route()` is the ONLY judge of any of them. No second
    // distinctness or adjacency predicate exists in this crate or in the TS mirror.
    if let Some(cells) = perimeter_cells(from, to) {
        // THIS `if let Ok` SWALLOWS THE `Err`, AND THE ONLY THING THAT CAN SEE THAT IS G1
        // IN `tests/wire_corpus.rs`. Read this arm as safe and you will be wrong: one
        // transposed sign in `ring_index` makes `perimeter_cells` emit invalid paths for
        // every all-four-false pair, this arm falls through silently, the fallback
        // geometry is blessed into `wire_corpus.expected.json` in BOTH languages,
        // `wire_corpus_matches_frozen` then compares that fixture against itself, and all
        // five gates go green over a broken picture. What closes the hole is the `cand`
        // COLUMN frozen into that fixture, which records WHICH candidate won, so a silent
        // fall-through becomes a diff instead of a silence. Do not delete that column and
        // do not weaken it to an assertion over the emitted tiles.
        if let Ok(tiles) = route(&cells) {
            return Ok((
                WireGeometry {
                    from_anchor: WireAnchor::of(from),
                    to_anchor: WireAnchor::of(to),
                    tiles,
                },
                CAND_PERIMETER,
            ));
        }
    }
    if let Some(cells) = go_around_cells(from, to) {
        // The go-around (75-01). Its gate is input-only, and this `if let Ok` swallows a
        // rejection exactly as the ring arm's does; what sees a fall-through here is the
        // `cand` column and the cand-3 count pin in `tests/wire_corpus.rs`, which also
        // runs `go_around_search` directly on every row it won and judges it with
        // `route()`.
        if let Ok(tiles) = route(&cells) {
            return Ok((
                WireGeometry {
                    from_anchor: WireAnchor::of(from),
                    to_anchor: WireAnchor::of(to),
                    tiles,
                },
                CAND_GO_AROUND,
            ));
        }
    }
    if let Some(cells) = clear_of_bodies_cells(from, to) {
        // Candidate 4 (75-03). Its gate is input-only and this `if let Ok` swallows a
        // rejection like the two arms above; the `cand` column, the cand-4 count pin and
        // the direct `clear_of_bodies_search` run in `tests/wire_corpus.rs` see it.
        if let Ok(tiles) = route(&cells) {
            return Ok((
                WireGeometry {
                    from_anchor: WireAnchor::of(from),
                    to_anchor: WireAnchor::of(to),
                    tiles,
                },
                CAND_CLEAR_OF_BODIES,
            ));
        }
    }
    // THE `manhattan_l` ARM IS UNREACHABLE TODAY, BY PROOF, and is deliberately not
    // counted as coverage anywhere. `face_aligned_cells`'s strictly-increasing potential
    // shows every emitted path is non-empty, adjacent and globally distinct, which is
    // exactly the three things `route` rejects on. It is kept because it is what lets a
    // future shape be slotted in as a new FIRST candidate carrying no new proof
    // obligation — which is exactly what `perimeter_cells` above just did.
    let (tiles, cand) = match route(&face_aligned_cells(from, to)) {
        Ok(tiles) => (tiles, CAND_FACE_ALIGNED),
        Err(_) => (
            route(&manhattan_l(from.cell, to.cell)).map_err(WireRouteError::Route)?,
            CAND_MANHATTAN,
        ),
    };
    Ok((
        WireGeometry {
            from_anchor: WireAnchor::of(from),
            to_anchor: WireAnchor::of(to),
            tiles,
        },
        cand,
    ))
}

/// THE OBSTACLE STAGE won (phase 92, D-09, CHROME-19): the ladder's path entered a third
/// machine, and [`wire_route_avoiding_traced`] drew the shortest cable around every machine
/// in its window instead. Numbered after the existing five so no frozen `cand` value
/// changes meaning; mirrored as `CAND_AROUND_MACHINES` in `frontend/src/protocol/wireRoute.ts`.
///
/// # What it draws
/// Candidate 4's relaxed search ([`search_between_ends`]'s routine): every free neighbour of
/// the source dock is a start and every free neighbour of the target dock a finish,
/// compared as `(length, arrival missed, departure missed, bends)`, with the blocked set
/// widened to the window's machines. Length first, so a cable never takes a longer way
/// round than it must; then a straight arrival; then a straight departure; then bends.
///
/// # When the window is crowded
/// A window whose line set holds more than [`MAX_AROUND_NODES`] nodes is searched cell by
/// cell instead, [`CAND_AROUND_CROWDED`]: the cable still enters no machine and still has the
/// shortest length and the same two face keys, and only the bends key is applied move by move.
///
/// # Where it does not fire: one named exception, keeping the ladder's path
/// THE WALLED-IN DOCK: no walk exists, because a dock's every free neighbour is inside a
/// machine (or the machines close every way round inside the window). Counted by the second
/// corpus (`tests/wire_obstacle_corpus.rs`, `FROZEN_WALLED_IN_ROWS`) and pinned by a literal
/// in `tests/wire_obstacles.rs`. A window too large to hold in memory
/// ([`MAX_CROWDED_CELLS`]) keeps the ladder's path too; no board the editor can build reaches
/// it (see that constant). This is a chosen default and may be revisited.
pub const CAND_AROUND_MACHINES: u8 = 5;

/// THE CROWDED WINDOW won (review fix pass 1, WR-A-02): the ladder's path entered a third
/// machine, the window's line set held more than [`MAX_AROUND_NODES`] nodes, and the stage
/// drew the cable cell by cell round every machine in the window ([`crowded_walk`]).
/// Mirrored as `CAND_AROUND_CROWDED` in `frontend/src/protocol/wireRoute.ts`.
///
/// # What it draws
/// The walk from a free neighbour of the source dock to a free neighbour of the target dock
/// that enters no body, dock or window machine, least `(length, arrival missed, departure
/// missed)` first, compared in that order: the exact first three keys of
/// [`CAND_AROUND_MACHINES`]. The fourth key, bends, is applied move by move (at each cell the
/// first move in the order straight, N, E, S, W that keeps the first three keys optimal),
/// not over the whole cable, which is what keeps the search one pass over cells. So UI-SPEC
/// 4.1 rule 1 holds in full and rule 3 holds to its third key. Counted by the second corpus
/// (`FROZEN_CROWDED_ROWS`) and pinned by literals in `tests/wire_obstacles.rs`.
pub const CAND_AROUND_CROWDED: u8 = 6;

/// The most nodes the line search of [`CAND_AROUND_MACHINES`] runs on (review fix pass 1,
/// WR-A-02 and WR-A-03, threats T-92-06 and T-92-10): `xs.len() * ys.len()` of the window's
/// line set. A larger set is searched cell by cell ([`CAND_AROUND_CROWDED`]), never left to
/// cross a machine. This replaced a cap of 64 window machines that kept the ladder's path
/// through a machine: the machine count does not bound the cost (64 machines at distinct
/// coordinates make about 19,600 nodes), the node count does, and UI-SPEC 4.1 rule 1 names no
/// crowded exception. 2048 nodes is 8192 search states, about 0.7 ms in a release build at
/// the cap; at 7,920 nodes the line search cost 2.8 ms where the cell walk over a 300 by 300
/// window cost 0.6 ms (`tests/wire_obstacles.rs` `bench_obstacle_stage`, the `BENCH` lines in
/// `92-GATES.md` `## Review fix pass 1`). Every row of both corpora, and every literal case
/// but the crowded ones, sits far under it. Mirrored as `MAX_AROUND_NODES` in
/// `frontend/src/protocol/wireRoute.ts`, locked by `tests/ts_wire_obstacle_mirror.rs`.
/// A chosen default.
pub const MAX_AROUND_NODES: usize = 2048;

/// The most cells [`crowded_walk`] holds (review fix pass 1): the window inflated by one,
/// `2^21` cells. Every rectangle the host hands the router lies in `[-512, 575]` on each axis
/// (node cells are bounded to the grid at decode, footprints are at most 64 cells a side), so
/// the largest window the editor can build is 1090 by 1090, about 1.19 million cells, under
/// this. Only a forged rectangle or a free-drag pointer far off the grid makes a larger
/// window, and that keeps the ladder's path. Mirrored as `MAX_CROWDED_CELLS` in
/// `frontend/src/protocol/wireRoute.ts`, locked by `tests/ts_wire_obstacle_mirror.rs`.
pub const MAX_CROWDED_CELLS: i64 = 1 << 21;

/// How far past the grid the obstacle stage's extra lines may sit (review fix pass 1,
/// WR-A-01): its window-obstacle lines are clamped to
/// `[GRID_MIN - WIRE_LINE_GUARD, GRID_MAX + WIRE_LINE_GUARD]`. The clamp is an overflow and
/// size guard for forged rectangles and nothing else: on any board the editor can build
/// every line lies in `[-513, 576]`, inside it, so the free ring one cell outside the window
/// stays free at the grid's edge and a cable may pass one cell outside the grid there, as the
/// ladder's own ring already may. Clamping to the grid itself (the shipped rule) collapsed
/// that ring onto the last row and sent a cable 37 cells round where 17 do. Mirrored as
/// `WIRE_LINE_MIN` and `WIRE_LINE_MAX` in `frontend/src/protocol/wireRoute.ts`, locked by
/// `tests/ts_wire_obstacle_mirror.rs`.
pub const WIRE_LINE_GUARD: i32 = 128;

/// Whether a node of kind byte `kind` is in a cable's way (phase 92, D-09): false for the
/// three kinds a cable may cross, a belt ([`machine_kind::BELT`]), a wire
/// ([`machine_kind::WIRE`]) and a label ([`machine_kind::LABEL`]), true for every other
/// byte, a forged or future one included, so an unknown kind is avoided rather than
/// crossed.
///
/// THE ONE RULE IN THIS LANGUAGE: the host's machine list for the landed cable reads it.
/// The drag preview reads `isWireObstacle` in `frontend/src/protocol/wireRoute.ts`, and
/// `tests/ts_wire_obstacle_mirror.rs` locks the two together over every kind byte.
pub fn is_wire_obstacle(kind: u8) -> bool {
    !matches!(
        kind,
        machine_kind::BELT | machine_kind::WIRE | machine_kind::LABEL
    )
}

/// The rectangles of `machines` that are obstacles between `from` and `to`: each one
/// normalised as [`norm_body`] folds a forged box, every one that contains either dock cell
/// dropped (the two endpoint machines, and in a free drag the machine under the pointer),
/// sorted by `(min_x, min_y, max_x, max_y)` and deduplicated. No hashing: a `Vec`, sorted.
///
/// The order does not change any cable: the window is a least fixed point and the line set
/// is sorted later. The sort makes [`AroundWindow::obstacles`] one canonical list, and the
/// dedup lists a rectangle given twice once (`a_machine_given_twice_joins_the_window_once`).
fn obstacles_of(
    from: WireDock,
    to: WireDock,
    machines: &[WireBody],
) -> Vec<(i32, i32, i32, i32)> {
    let holds = |b: (i32, i32, i32, i32), c: (i32, i32)| {
        c.0 >= b.0 && c.0 <= b.2 && c.1 >= b.1 && c.1 <= b.3
    };
    let mut obstacles: Vec<(i32, i32, i32, i32)> = machines
        .iter()
        .map(|&m| norm_body(m))
        .filter(|&b| !holds(b, from.cell) && !holds(b, to.cell))
        .collect();
    obstacles.sort_unstable();
    obstacles.dedup();
    obstacles
}

/// The closed window [`wire_route_avoiding`] searches in (phase 92, D-09, step 4 of the
/// module docblock's obstacle stage), and the obstacles inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AroundWindow {
    /// The window: the box of both bodies and both dock cells, grown by every obstacle that
    /// joined.
    pub frame: WireBody,
    /// The obstacles that joined, normalised, in `(min_x, min_y, max_x, max_y)` order.
    pub obstacles: Vec<WireBody>,
}

fn as_body(r: (i32, i32, i32, i32)) -> WireBody {
    WireBody {
        min_x: r.0,
        min_y: r.1,
        max_x: r.2,
        max_y: r.3,
    }
}

/// The closed window between `from` and `to` over the obstacles in `machines` (the
/// obstacle filter of [`wire_route_avoiding`] applied first): start from the box of both
/// bodies and both dock cells; every obstacle touching that box inflated by one cell joins
/// and grows the box to hold it; repeat until nothing more joins. Machines separated from
/// the box by a free cell do not join, so on a real board the window stays near the two
/// ends. The set that joins is the least fixed point, so it does not depend on the order
/// the obstacles are visited in.
///
/// # Why this is `pub`
/// `tests/wire_obstacles.rs` reads it to prove the search is bounded by the machines in the
/// window and not by the board (threat T-92-06).
pub fn around_machines_window(from: WireDock, to: WireDock, machines: &[WireBody]) -> AroundWindow {
    window_of(from, to, &obstacles_of(from, to, machines))
}

/// The window's least fixed point in `O(n log n)` (review fix pass 1, WR-A-03), where the
/// shipped repeat-until-stable scan cost one full pass per joined machine on a chain grown
/// against the sort order (about 5 ms for 4000 machines on every crossing cable).
///
/// An obstacle `o` touches the box `w` inflated by one exactly when four conditions hold:
/// `o.min_x <= w.max_x + 1`, `o.max_x >= w.min_x - 1`, `o.min_y <= w.max_y + 1` and
/// `o.max_y >= w.min_y - 1`. The box only grows, so each condition, once true, stays true.
/// So each condition is a sweep over the obstacles sorted by the one coordinate it reads
/// (ties by list position), a pointer that only advances, and a counter per obstacle; the
/// obstacle joins when its counter reaches four, and its box grows `w`, which may advance the
/// sweeps further. Every pointer advances at most `n` times. The joined set is a fixed point
/// (every obstacle left out fails a condition its sweep stopped at, so fails it at the final
/// box), and the least one (every join is justified by a box no larger than any fixed
/// point's), so it is exactly the set the repeat-until-stable scan joins.
fn window_of(from: WireDock, to: WireDock, obstacles: &[(i32, i32, i32, i32)]) -> AroundWindow {
    let (px0, py0, px1, py1) = norm_body(from.body);
    let (qx0, qy0, qx1, qy1) = norm_body(to.body);
    let (ax, ay) = from.cell;
    let (bx, by) = to.cell;
    let mut w = (
        lo2(lo2(px0, qx0), lo2(ax, bx)),
        lo2(lo2(py0, qy0), lo2(ay, by)),
        hi2(hi2(px1, qx1), hi2(ax, bx)),
        hi2(hi2(py1, qy1), hi2(ay, by)),
    );
    let n = obstacles.len();
    let sweep = |key: &dyn Fn(usize) -> i64| -> Vec<usize> {
        let mut keyed: Vec<(i64, usize)> = (0..n).map(|i| (key(i), i)).collect();
        keyed.sort_unstable();
        keyed.into_iter().map(|(_, i)| i).collect()
    };
    // Ascending min_x, descending max_x, ascending min_y, descending max_y.
    let sweeps = [
        sweep(&|i| i64::from(obstacles[i].0)),
        sweep(&|i| -i64::from(obstacles[i].2)),
        sweep(&|i| i64::from(obstacles[i].1)),
        sweep(&|i| -i64::from(obstacles[i].3)),
    ];
    let mut at = [0_usize; 4];
    let mut count = vec![0_u8; n];
    let mut joined = vec![false; n];
    loop {
        // Saturating, so a forged rectangle at the integer bounds cannot overflow; on any
        // board inside the grid this is plain `- 1` and `+ 1`.
        let (ix0, iy0) = (w.0.saturating_sub(1), w.1.saturating_sub(1));
        let (ix1, iy1) = (w.2.saturating_add(1), w.3.saturating_add(1));
        let holds = |s: usize, o: (i32, i32, i32, i32)| match s {
            0 => o.0 <= ix1,
            1 => o.2 >= ix0,
            2 => o.1 <= iy1,
            _ => o.3 >= iy0,
        };
        let mut fresh = Vec::new();
        for (s, order) in sweeps.iter().enumerate() {
            while at[s] < n && holds(s, obstacles[order[at[s]]]) {
                let i = order[at[s]];
                at[s] += 1;
                count[i] += 1;
                if count[i] == 4 {
                    fresh.push(i);
                }
            }
        }
        if fresh.is_empty() {
            break;
        }
        for i in fresh {
            let o = obstacles[i];
            joined[i] = true;
            w = (lo2(w.0, o.0), lo2(w.1, o.1), hi2(w.2, o.2), hi2(w.3, o.3));
        }
    }
    AroundWindow {
        frame: as_body(w),
        obstacles: obstacles
            .iter()
            .zip(&joined)
            .filter(|&(_, &j)| j)
            .map(|(&o, _)| as_body(o))
            .collect(),
    }
}

/// A line one cell outside a rectangle edge, clamped to the grid widened by
/// [`WIRE_LINE_GUARD`] (an overflow and size guard; on any buildable board it never binds).
/// Saturating first, so a forged rectangle at the integer bounds cannot overflow; clamping a
/// saturated value gives what clamping the exact value would, which is what the TS mirror
/// computes.
fn clamped_line(v: i32, d: i32) -> i32 {
    let l = if d < 0 {
        v.saturating_sub(1)
    } else {
        v.saturating_add(1)
    };
    l.clamp(GRID_MIN - WIRE_LINE_GUARD, GRID_MAX + WIRE_LINE_GUARD)
}

/// Everything the around-machines search runs on.
struct AroundSetup {
    /// Both bodies, both docks and the window's obstacles.
    blocks: Vec<(i32, i32, i32, i32)>,
    /// The free neighbours of the source dock, the relaxed starts candidate 4 uses.
    starts: Vec<SearchEnd>,
    /// The free neighbours of the target dock.
    finishes: Vec<SearchEnd>,
    /// Today's lines over those ends plus each window obstacle's `min - 1` and `max + 1`,
    /// clamped ([`clamped_line`]); ascending, unique. The ring one cell outside the window is
    /// already on it (see [`around_machines_lines`]).
    xs: Vec<i32>,
    /// The same on the other axis.
    ys: Vec<i32>,
}

fn around_setup(from: WireDock, to: WireDock, window: &AroundWindow) -> AroundSetup {
    let mut blocks: Vec<(i32, i32, i32, i32)> = go_around_blocks(from, to).to_vec();
    blocks.extend(window.obstacles.iter().map(|&o| norm_body(o)));
    let starts = free_ends(&blocks, &dock_neighbours(from, true));
    let finishes = free_ends(&blocks, &dock_neighbours(to, false));
    let (mut xs, mut ys) = go_around_lines(from, to, &starts, &finishes);
    for o in &window.obstacles {
        xs.push(clamped_line(o.min_x, -1));
        xs.push(clamped_line(o.max_x, 1));
        ys.push(clamped_line(o.min_y, -1));
        ys.push(clamped_line(o.max_y, 1));
    }
    xs.sort_unstable();
    xs.dedup();
    ys.sort_unstable();
    ys.dedup();
    AroundSetup {
        blocks,
        starts,
        finishes,
        xs,
        ys,
    }
}

/// The line set the around-machines search would run on for `window`, `(xs, ys)`, ascending
/// and deduplicated: the very vectors [`wire_route_avoiding_traced`] searches over when
/// `xs.len() * ys.len()` is at most [`MAX_AROUND_NODES`].
///
/// # Why this is `pub`
/// `tests/wire_obstacles.rs` `the_around_machines_search_is_bounded_by_its_lines_not_the_board`
/// reads it: at most ten lines per axis come from the two ends, at most two more per window
/// machine, and a machine outside the window adds none (threat T-92-06).
///
/// # The free ring is on the set without a line of its own
/// The soundness argument (module docblock) needs the lines one cell outside the window.
/// Each window edge is an edge of a body, of a window obstacle or of a dock cell, and each of
/// those already puts its outside line on the set: a body's through [`go_around_lines`], an
/// obstacle's through its own `min - 1` and `max + 1`, and a dock's through its outward
/// neighbour, which is a free end (it lies outside the window, so outside every body and
/// obstacle). So the shipped explicit frame lines added nothing, and went at review fix pass 1
/// (IN-A-02): removing them reddened no test and moved none of 200,000 forged-body boards
/// against the oracle.
pub fn around_machines_lines(from: WireDock, to: WireDock, window: &AroundWindow) -> (Vec<i32>, Vec<i32>) {
    let s = around_setup(from, to, window);
    (s.xs, s.ys)
}

/// THE CROWDED WALK ([`CAND_AROUND_CROWDED`], review fix pass 1): the walk `start ..= finish`
/// over single cells inside the window inflated by one, or `None` when no walk exists (the
/// walled-in dock) or the region exceeds [`MAX_CROWDED_CELLS`].
///
/// # How
/// The blocks are painted into the region through a two-dimensional difference array (one
/// pass over the blocks, one over the cells). A breadth-first search from every free finish
/// fills, per cell, its length to the nearest finish (the layer) and the arrival key of the
/// finish it was first reached from. That key is the least over every finish at that length:
/// the one finish that arrives on the target's face (key 0) is queued first
/// (`dock_neighbours` puts it first), so by induction every layer holds its key-0 cells
/// before its key-1 cells, and a cell next to a key-0 cell of the layer before is reached
/// from it first. The start is the first, in the order given, whose `(length, arrival
/// missed)` is the least; the walk then takes, at each cell, the first move in the order
/// straight, N, E, S, W onto a cell one shorter with the same arrival key.
///
/// # Why the region loses no shorter way round
/// It is the window inflated by one. At the window's fixed point no obstacle outside it
/// touches that ring, so the ring is free, and a walk leaving the region crosses the ring
/// twice and can be replaced by the ring between the two crossings, no longer. So the least
/// length inside the region is the least length on the board, as the exhaustive oracle
/// `brute_force_route_avoiding` measures (`tests/wire_obstacles.rs`, and the crowded rows of
/// `tests/wire_obstacle_corpus.rs`).
///
/// # Why the cells are a valid [`route`](crate::route::route) input
/// Each move goes one layer down, so no cell repeats; each is one unit step; every cell is
/// free. The caller wraps it as `[A] ++ walk ++ [B]`, and `route()` judges it all the same.
fn crowded_walk(window: &AroundWindow, setup: &AroundSetup) -> Option<Vec<(i32, i32)>> {
    let f = window.frame;
    let (x0, y0) = (f.min_x.saturating_sub(1), f.min_y.saturating_sub(1));
    let (x1, y1) = (f.max_x.saturating_add(1), f.max_y.saturating_add(1));
    let w64 = i64::from(x1) - i64::from(x0) + 1;
    let h64 = i64::from(y1) - i64::from(y0) + 1;
    if w64.saturating_mul(h64) > MAX_CROWDED_CELLS {
        return None;
    }
    let w = usize::try_from(w64).ok()?;
    let h = usize::try_from(h64).ok()?;
    let index = |c: (i32, i32)| -> Option<usize> {
        if c.0 < x0 || c.0 > x1 || c.1 < y0 || c.1 > y1 {
            return None;
        }
        Some(usize::try_from(c.1 - y0).ok()? * w + usize::try_from(c.0 - x0).ok()?)
    };
    let cell_of = |i: usize| -> (i32, i32) {
        (
            x0 + i32::try_from(i % w).unwrap_or(0),
            y0 + i32::try_from(i / w).unwrap_or(0),
        )
    };

    // The blocked cells, every block clipped to the region.
    let mut grid = vec![0_i32; (w + 1) * (h + 1)];
    for &(bx0, by0, bx1, by1) in &setup.blocks {
        let (cx0, cy0, cx1, cy1) = (hi2(bx0, x0), hi2(by0, y0), lo2(bx1, x1), lo2(by1, y1));
        if cx0 > cx1 || cy0 > cy1 {
            continue;
        }
        let i0 = usize::try_from(cx0 - x0).ok()?;
        let i1 = usize::try_from(cx1 - x0).ok()? + 1;
        let j0 = usize::try_from(cy0 - y0).ok()?;
        let j1 = usize::try_from(cy1 - y0).ok()? + 1;
        grid[j0 * (w + 1) + i0] += 1;
        grid[j0 * (w + 1) + i1] -= 1;
        grid[j1 * (w + 1) + i0] -= 1;
        grid[j1 * (w + 1) + i1] += 1;
    }
    let mut blocked = vec![false; w * h];
    for j in 0..h {
        for i in 0..w {
            let up = if j > 0 { grid[(j - 1) * (w + 1) + i] } else { 0 };
            let left = if i > 0 { grid[j * (w + 1) + i - 1] } else { 0 };
            let corner = if i > 0 && j > 0 { grid[(j - 1) * (w + 1) + i - 1] } else { 0 };
            grid[j * (w + 1) + i] += up + left - corner;
            blocked[j * w + i] = grid[j * (w + 1) + i] > 0;
        }
    }
    drop(grid);

    // The cell one unit step from `i` along heading `d`, inside the region.
    let step = |i: usize, d: usize| -> Option<usize> {
        let (cx, cy) = (i % w, i / w);
        match d {
            0 if cy > 0 => Some(i - w),
            1 if cx + 1 < w => Some(i + 1),
            2 if cy + 1 < h => Some(i + w),
            3 if cx > 0 => Some(i - 1),
            _ => None,
        }
    };

    // Breadth-first from every free finish: `len[i]` (-1 unreached) and `arr[i]`, the
    // arrival key of the finish `i` was first reached from.
    let mut len = vec![-1_i32; w * h];
    let mut arr = vec![0_u8; w * h];
    let mut queue: Vec<usize> = Vec::new();
    for e in &setup.finishes {
        let i = index(e.cell)?;
        len[i] = 0;
        arr[i] = u8::from(e.missed);
        queue.push(i);
    }
    let mut head = 0;
    while head < queue.len() {
        let c = queue[head];
        head += 1;
        for d in 0..4 {
            let Some(q) = step(c, d) else {
                continue;
            };
            if blocked[q] {
                continue;
            }
            if len[q] < 0 {
                len[q] = len[c] + 1;
                arr[q] = arr[c];
                queue.push(q);
            }
        }
    }

    // The start: the first, in the order given, whose `(length, arrival missed)` is the
    // least. That is also the least `(length, arrival missed, departure missed)`: the one
    // start that does not miss its face is first in the order (`dock_neighbours`).
    let total = |e: &SearchEnd| -> Option<(i32, u8)> {
        let i = index(e.cell)?;
        (len[i] >= 0).then(|| (len[i], arr[i]))
    };
    let best = setup.starts.iter().filter_map(total).min()?;
    let start = setup.starts.iter().find(|e| total(e) == Some(best))?;

    let mut cur = index(start.cell)?;
    let mut h_cur = heading_of(start.dir)?;
    let mut cells = vec![start.cell];
    while len[cur] > 0 {
        let mut moved = false;
        for d in [h_cur, 0, 1, 2, 3] {
            let Some(q) = step(cur, d) else {
                continue;
            };
            if len[q] == len[cur] - 1 && arr[q] == arr[cur] {
                cells.push(cell_of(q));
                cur = q;
                h_cur = d;
                moved = true;
                break;
            }
        }
        if !moved {
            // Unreachable: a cell of length `L > 0` was reached from one of length `L - 1`
            // with its arrival key.
            return None;
        }
    }
    Some(cells)
}

/// [`wire_route`] for a board with other machines on it (phase 92, D-09, CHROME-19): the
/// cable between `from` and `to` goes around every machine in `machines` whenever a way
/// round exists, and is today's path whenever today's path enters none of them. Callers
/// pass EVERY machine rectangle on the board (the kinds [`is_wire_obstacle`] says are in
/// the way); the two endpoint machines are dropped by the router itself. PURE,
/// deterministic, integer-only, and independent of the order of `machines`.
///
/// # Errors
/// As [`wire_route`]: the ladder runs first and its refusal is returned unchanged.
pub fn wire_route_avoiding(
    from: WireDock,
    to: WireDock,
    machines: &[WireBody],
) -> Result<WireGeometry, WireRouteError> {
    wire_route_avoiding_traced(from, to, machines).map(|(geometry, _cand)| geometry)
}

/// [`wire_route_avoiding`], plus which candidate drew the geometry: the ladder's own
/// candidate when its path was kept (no machine in the way, the walled-in dock), or
/// [`CAND_AROUND_MACHINES`], or [`CAND_AROUND_CROWDED`]. The steps are the module docblock's
/// obstacle stage, 1 to 7.
///
/// # Errors
/// As [`wire_route_traced`].
pub fn wire_route_avoiding_traced(
    from: WireDock,
    to: WireDock,
    machines: &[WireBody],
) -> Result<(WireGeometry, u8), WireRouteError> {
    // 1. Today's ladder, unchanged.
    let (geometry, cand) = wire_route_traced(from, to)?;
    // 2. The obstacles.
    let obstacles = obstacles_of(from, to, machines);
    // 3. D-09: today's path whenever it enters no machine. Only an obstacle meeting the
    // path's bounding box can hold one of its cells, so the cell test runs on those alone
    // (review WR-A-03: the full test was cells times machines on every cable).
    let (mut px0, mut py0, mut px1, mut py1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for t in &geometry.tiles {
        (px0, py0) = (lo2(px0, t.cell.0), lo2(py0, t.cell.1));
        (px1, py1) = (hi2(px1, t.cell.0), hi2(py1, t.cell.1));
    }
    let near: Vec<(i32, i32, i32, i32)> = obstacles
        .iter()
        .copied()
        .filter(|&(x0, y0, x1, y1)| x0 <= px1 && x1 >= px0 && y0 <= py1 && y1 >= py0)
        .collect();
    let enters = geometry.tiles.iter().any(|t| {
        near.iter()
            .any(|&(x0, y0, x1, y1)| t.cell.0 >= x0 && t.cell.0 <= x1 && t.cell.1 >= y0 && t.cell.1 <= y1)
    });
    if !enters {
        return Ok((geometry, cand));
    }
    // 4. The closed window, and what the search runs on.
    let window = window_of(from, to, &obstacles);
    let setup = around_setup(from, to, &window);
    // 5 and 6. The line search, or the cell walk on a crowded window; the walled-in dock (no
    // free end, or no walk) keeps today's path.
    let walk = if setup.starts.is_empty() || setup.finishes.is_empty() {
        None
    } else if setup.xs.len().saturating_mul(setup.ys.len()) <= MAX_AROUND_NODES {
        search_on_lines(&setup.blocks, &setup.xs, &setup.ys, &setup.starts, &setup.finishes)
            .map(|w| (w, CAND_AROUND_MACHINES))
    } else {
        crowded_walk(&window, &setup).map(|w| (w, CAND_AROUND_CROWDED))
    };
    let Some((walk, around)) = walk else {
        return Ok((geometry, cand));
    };
    // 7. `route()` is the only judge.
    let mut cells = Vec::with_capacity(walk.len() + 2);
    cells.push(from.cell);
    cells.extend(walk);
    cells.push(to.cell);
    match route(&cells) {
        Ok(tiles) => Ok((
            WireGeometry {
                from_anchor: WireAnchor::of(from),
                to_anchor: WireAnchor::of(to),
                tiles,
            },
            around,
        )),
        // Unreachable by each walk's validity argument (a length-minimal walk on free cells,
        // one step from each dock); kept total.
        Err(_) => Ok((geometry, cand)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::state::{Axis, Dir, TileKind};

    // Side numbering (mirror core `Side`): N=0, E=1, S=2, W=3.
    const N: u8 = 0;
    const E: u8 = 1;
    const W: u8 = 3;

    /// The 1x1 body of a dock that sits on its own single cell — the degenerate rectangle
    /// a 1x1 machine (and the free-drag pointer target) carries.
    fn cell_body(x: i32, y: i32) -> WireBody {
        WireBody {
            min_x: x,
            min_y: y,
            max_x: x,
            max_y: y,
        }
    }

    #[test]
    fn adjacent_endpoints_yield_single_l_path() {
        // The canonical L: leave (0,0) eastward, bend south, enter (1,1) from the north.
        // Mirrors the belt route fixture's L exactly (straight X, one corner, straight Y).
        let g = wire_route(
            WireDock {
                cell: (0, 0),
                side: E,
                body: cell_body(0, 0),
            },
            WireDock {
                cell: (1, 1),
                side: N,
                body: cell_body(1, 1),
            },
        )
        .expect("the canonical wire L auto-routes");

        assert_eq!(g.tiles.len(), 3, "an L-bend cable is three tiles");
        assert_eq!(g.tiles[0].cell, (0, 0));
        assert_eq!(g.tiles[0].tile_kind(), TileKind::Straight { axis: Axis::X });
        assert_eq!(g.tiles[1].cell, (1, 0));
        assert_eq!(
            g.tiles[1].tile_kind(),
            TileKind::Corner {
                from: Dir::E,
                to: Dir::S
            }
        );
        assert_eq!(g.tiles[2].cell, (1, 1));
        assert_eq!(g.tiles[2].tile_kind(), TileKind::Straight { axis: Axis::Y });

        // The electrical terminal anchors ride alongside the path (integer cell + side).
        assert_eq!(
            g.from_anchor,
            WireAnchor {
                cell_x: 0,
                cell_y: 0,
                side: E
            }
        );
        assert_eq!(
            g.to_anchor,
            WireAnchor {
                cell_x: 1,
                cell_y: 1,
                side: N
            }
        );
    }

    /// DECLARED INVERSION (75-01). This test was `colinear_endpoints_yield_a_straight_run`
    /// and pinned four straight cells `(0,0)..(3,0)`. Both ports face E, so that straight
    /// run entered the target's EAST-facing port from the west, through the back of the
    /// machine: the arrival was wrong. The pair is in the one-face class, so since 75-01
    /// the cable goes around: out of `(0,0)` east, up one row, east past the target, down
    /// and west into `(3,0)` against its east-facing normal.
    #[test]
    fn colinear_east_to_east_goes_around_into_the_target_face() {
        let g = wire_route_traced(
            WireDock {
                cell: (0, 0),
                side: E,
                body: cell_body(0, 0),
            },
            WireDock {
                cell: (3, 0),
                side: E,
                body: cell_body(3, 0),
            },
        )
        .expect("the colinear wire auto-routes");
        let cells: Vec<(i32, i32)> = g.0.tiles.iter().map(|t| t.cell).collect();
        assert_eq!(
            cells,
            vec![
                (0, 0),
                (1, 0),
                (2, 0),
                (2, -1),
                (3, -1),
                (4, -1),
                (4, 0),
                (3, 0),
            ],
            "east out of (0,0), around the target, and west into its east-facing port"
        );
        assert_eq!(g.1, CAND_GO_AROUND, "the go-around drew it");
    }

    /// THE BOUND (threat T-75-01). The go-around searches a compressed line set, never the
    /// cells between the two machines, so its size is fixed whatever the distance. This
    /// routes a one-face pair whose docks sit near opposite corners of the grid (about
    /// 2,000 cells apart along the path) and reads the line sets the search itself builds:
    /// at most six lines per axis, so at most 36 nodes.
    #[test]
    fn the_go_around_search_is_bounded_by_its_lines_not_the_board() {
        use crate::command::{GRID_MAX, GRID_MIN};
        let a = (GRID_MIN + 2, GRID_MIN + 2);
        let b = (GRID_MAX - 2, GRID_MAX - 2);
        let from = WireDock {
            cell: a,
            side: E,
            body: cell_body(a.0, a.1),
        };
        // Both ports face E, so the face-aligned L honours the departure and enters the
        // target from behind: the one-face class.
        let to = WireDock {
            cell: b,
            side: E,
            body: cell_body(b.0, b.1),
        };
        assert!(face_aligned_honours_exactly_one_face(from, to));
        let start = SearchEnd {
            cell: (a.0 + 1, a.1),
            dir: (1, 0),
            missed: false,
        };
        let finish = SearchEnd {
            cell: (b.0 + 1, b.1),
            dir: (-1, 0),
            missed: false,
        };
        let (xs, ys) = go_around_lines(from, to, &[start], &[finish]);
        assert!(
            xs.len() <= 6 && ys.len() <= 6,
            "at most six lines per axis whatever the distance: {} x-lines, {} y-lines",
            xs.len(),
            ys.len()
        );
        let (g, cand) = wire_route_traced(from, to).expect("routes");
        assert_eq!(cand, CAND_GO_AROUND);
        let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
        let n = cells.len();
        assert_eq!((cells[1].0 - cells[0].0, cells[1].1 - cells[0].1), (1, 0));
        assert_eq!(
            (cells[n - 1].0 - cells[n - 2].0, cells[n - 1].1 - cells[n - 2].1),
            (-1, 0)
        );
    }

    /// DECLARED INVERSION (75-03, CABLE-09 part 1). This test was
    /// `coincident_endpoints_yield_single_cell` and pinned a one-tile `Ok` for two docks on
    /// one cell. That one tile reached the host as a one-cell path, which the renderer
    /// draws as nothing, with nothing logged: the failure CABLE-09 names. Since 75-03 the
    /// router refuses the pair with a typed error, checked before the ladder, and the host
    /// draws a named two-cell stub for it instead.
    #[test]
    fn coincident_docks_are_a_typed_refusal() {
        let d = WireDock {
            cell: (2, 2),
            side: N,
            body: cell_body(2, 2),
        };
        let r = wire_route_traced(d, d);
        assert!(
            matches!(r, Err(WireRouteError::Coincident)),
            "two docks on one cell must be a typed refusal, not a path; got {r:?}"
        );
        assert_eq!(wire_route(d, d), Err(WireRouteError::Coincident));
        // The candidates still see a one-cell list on their own: the check is in front of
        // the ladder, not inside `face_aligned_cells` (G2 reads that directly).
        assert_eq!(face_aligned_cells(d, d), vec![(2, 2)]);
    }

    #[test]
    fn wire_route_is_deterministic_byte_identical() {
        // preview == commit at the function level: the SAME docks route to the SAME
        // geometry every call (no RNG, no clock, no hidden state) — the byte-stability
        // the cross-language golden rests on.
        let a = wire_route(
            WireDock {
                cell: (0, 0),
                side: E,
                body: cell_body(0, 0),
            },
            WireDock {
                cell: (2, 3),
                side: N,
                body: cell_body(2, 3),
            },
        )
        .expect("routes");
        let b = wire_route(
            WireDock {
                cell: (0, 0),
                side: E,
                body: cell_body(0, 0),
            },
            WireDock {
                cell: (2, 3),
                side: N,
                body: cell_body(2, 3),
            },
        )
        .expect("routes");
        assert_eq!(a, b, "wire_route() is deterministic");
    }

    /// G5. THE DOCK-CELL FOLD, AND NOTHING ELSE IN THE REPOSITORY CAN PIN IT.
    ///
    /// Step 1 folds both dock cells into K alongside both bodies. That fold is what makes
    /// `A in K` unconditional, which is what makes S1 non-empty and P* provably non-corner,
    /// and it is what absorbs a body rectangle that does not contain its own dock cell with
    /// no fifth decline gate. MEASURED at design time: dropping the `lo2(ax,bx)`/`hi2(ax,bx)`
    /// terms changes 0 of 9280 HONEST corpus rows, so no honest row can ever hold that line
    /// honest. This forged pair can.
    ///
    /// Both bodies are parked far to the EAST of both dock cells — the shape a stale or
    /// forged packet produces, reachable in principle through `resolve_wire_dock`'s
    /// degraded branch, which is `WINDOWS` row 116's trigger. Both being east of both docks
    /// is what makes this pair able to see the named mutation: with only ONE body forged,
    /// the honest body's own `x0` already pulls `kx0` past the dock cells and dropping the
    /// fold changes nothing.
    ///
    /// OBSERVED REDDENING. Replacing the `kx0` fold with `lo2(px0, qx0)` moves K's west
    /// edge from `-5` to `90`, which puts `A` outside K, drops `P*` and `Q*` onto the same
    /// row `S1` already walked, and `route()` rejects the result `SelfCrossing`. Reverted.
    #[test]
    fn forged_body_not_containing_its_dock_still_routes() {
        let from = WireDock {
            cell: (0, 0),
            side: E,
            // A body nowhere near its own dock cell.
            body: WireBody {
                min_x: 90,
                min_y: 90,
                max_x: 92,
                max_y: 92,
            },
        };
        let to = WireDock {
            cell: (-5, 0),
            side: W,
            body: WireBody {
                min_x: 95,
                min_y: 90,
                max_x: 97,
                max_y: 92,
            },
        };
        // All four admissibility booleans are false here (the target sits BEHIND the
        // east-facing source and its west face points the same way), so the ring fires.
        let cells = perimeter_cells(from, to).expect("the ring fires on this all-four-false pair");
        route(&cells).expect(
            "the dock-cell fold keeps A inside K, so S1 is non-empty and the emitted path is \
             adjacent and distinct even against a body that does not contain its own dock",
        );
        // And the whole router stays total against it.
        wire_route(from, to).expect("wire_route is total against a forged body");
    }

    /// The design brief's worked example, Board A, transcribed cell for cell.
    ///
    /// Route 1x1 at `(0,0)`; Handler 3x3 anchored `(3,-1)` so its body is `(3,-1)-(5,1)`
    /// and its `Out` is world `(5,0)` facing E. The REPLY leg runs Handler.Out `(5,0)`E to
    /// Route.In `(0,0)`W: `sx = -1`, `f = (1,0)`, `nt = (1,0)`, all four booleans false.
    ///
    /// This is J-7's cable. Before 72-16 it was 6 cells straight through the Handler's own
    /// middle row, leaving an east-facing port heading west. Pinning the exact 14 cells here
    /// is what says the implementation is the algorithm the brief specified rather than a
    /// different loop that happens to be `route()`-valid.
    #[test]
    fn board_a_reply_leg_rides_the_union_box_ring() {
        let handler_out = WireDock {
            cell: (5, 0),
            side: E,
            body: WireBody {
                min_x: 3,
                min_y: -1,
                max_x: 5,
                max_y: 1,
            },
        };
        let route_in = WireDock {
            cell: (0, 0),
            side: W,
            body: cell_body(0, 0),
        };
        let cells = perimeter_cells(handler_out, route_in).expect("the ring fires");
        assert_eq!(
            cells,
            vec![
                (5, 0),
                (6, 0),
                (6, 1),
                (6, 2),
                (5, 2),
                (4, 2),
                (3, 2),
                (2, 2),
                (1, 2),
                (0, 2),
                (-1, 2),
                (-1, 1),
                (-1, 0),
                (0, 0),
            ],
            "out of the Handler's east socket, down the outside of its east wall, along the \
             row one below both machines, up the outside of the Route's west wall, and east \
             into the Route's west socket",
        );
        // The acceptance criterion, in cells: the FIRST step is along the source's outward
        // normal and the LAST step is along the target's inward normal, so the renderer's
        // `clampEndToNub` applies at BOTH ends.
        assert_eq!(
            (cells[1].0 - cells[0].0, cells[1].1 - cells[0].1),
            (1, 0),
            "the cable leaves the east-facing Out heading EAST",
        );
        let n = cells.len();
        assert_eq!(
            (
                cells[n - 1].0 - cells[n - 2].0,
                cells[n - 1].1 - cells[n - 2].1
            ),
            (1, 0),
            "the cable arrives at the west-facing In heading EAST, i.e. against its normal",
        );
        // And the whole router selects it.
        let g = wire_route(handler_out, route_in).expect("routes");
        assert_eq!(g.tiles.len(), 14);
    }

    /// The REQUEST leg of the same board does NOT move. `leave_x` is true, D2 declines, and
    /// `face_aligned_cells` emits exactly the four cells it emitted after 72-15.
    #[test]
    fn board_a_request_leg_is_byte_identical_to_the_face_aligned_shape() {
        let route_out = WireDock {
            cell: (0, 0),
            side: E,
            body: cell_body(0, 0),
        };
        let handler_in = WireDock {
            cell: (3, 0),
            side: W,
            body: WireBody {
                min_x: 3,
                min_y: -1,
                max_x: 5,
                max_y: 1,
            },
        };
        assert!(
            perimeter_cells(route_out, handler_in).is_none(),
            "the request leg can honour its departure face, so the ring declines it",
        );
        let g = wire_route(route_out, handler_in).expect("routes");
        let cells: Vec<(i32, i32)> = g.tiles.iter().map(|t| t.cell).collect();
        assert_eq!(cells, vec![(0, 0), (1, 0), (2, 0), (3, 0)]);
    }
}
