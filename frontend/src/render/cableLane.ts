// The wire LANE: which of two parallel corridors a cable occupies, so a forward wire
// and its return do not draw on top of each other (66-UI-SPEC section 5.1, D1).
//
// WHY THIS IS ITS OWN MODULE AND NOT PART OF `layers/wires.ts`. Two consumers need the
// IDENTICAL expression: the landed cable in `layers/wires.ts`, and the in-drag ghost,
// which is computed in `input/gestures.ts` and stroked by `layers/overlay.ts`. If the
// ghost's lane key and the cable's lane key were computed independently, the preview
// would promise a corridor the landed cable does not take - which is precisely the
// failure that disqualified the `fabrico-command` corridor offset (66-CONTEXT). So the
// key lives in ONE place, and that place must be reachable from `input/`, which is
// Pixi-free by construction (`gestures.test.ts` runs under vitest's `node` environment
// and would not survive a transitive `pixi.js` import). Hence: no Pixi, no DOM, pure
// integer/float math over plain data.
//
// The MAGNITUDE of the offset is NOT here. `CABLE_LANE_OFFSET` is declared in
// `cableGeometry.ts` (since plan 75-05; `layers/wires.ts` re-exports it) beside
// `CABLE_WIDTH`, as `CABLE_LANE_OFFSET = CABLE_WIDTH`, because
// the derivation IS the value: the gap equals the cable. This module takes the offset
// as an argument so it never restates it.

/** Which lane a cable occupies: +1, -1, or 0 for a degenerate path. */
export type Lane = -1 | 0 | 1;

/** The minimum a lane key needs off a routed tile: its cell. */
export interface LaneCell {
  cell_x: number;
  cell_y: number;
}

/**
 * The lane key: a lexicographic compare of the path's FIRST cell against its LAST, on
 * x then y. `+1` when the first sorts before the last, `-1` when after, `0` when the
 * path is a single cell or its two ends coincide.
 *
 * IT MUST NOT REACH FOR A WIRE IDENTITY, and that constraint is what chose this key.
 * The key has to be pure over data that
 *   (a) exists DURING THE DRAG, when the wire has no identity at all - the preview
 *       computes it from `wireRoute(...).geometry.tiles` before the wire exists, and
 *   (b) survives the dense render-handle re-mint on every undo/redo-folding tick
 *       (`sim_loop.rs:1764-1768`) and every load (`sim_loop.rs:1521`).
 * The dense render handle satisfies neither. `WireView.path` satisfies both.
 *
 * WHY A PAIR LANDS OPPOSITE BY CONSTRUCTION, rather than by a rule someone maintains.
 * THE REASON THIS PARAGRAPH GAVE UNTIL 72-16 WAS "`manhattan_l(A,B)` walks A->B and
 * `manhattan_l(B,A)` walks B->A, so a forward wire and its return carry the SAME CELL SET
 * IN REVERSED ORDER". That stopped being true. Since 72-15 the router reads `side`, and
 * since 72-16 a pair whose four admissibility booleans are all false gets a perimeter
 * RING one way and a face-aligned L the other: on a Route and HTTP Handler pair (the demo's
 * included since plan 85-08, a palette pair with the request on the Route's Out and the
 * reply on the Handler's Out, each cable on its own nub) the request is a few cells and
 * the reply a ring round both machines, sharing almost nothing.
 *
 * THE OUTCOME STILL HOLDS, on a weaker and sufficient premise. The key compares the
 * path's FIRST cell against its LAST. A forward wire runs A->B and its return runs B->A,
 * so whatever cells lie between, the two ends are EXCHANGED: first/last of one are
 * last/first of the other. The lexicographic compare of an exchanged pair is the negation
 * of the compare of the original, so the sign flips and the two cables take opposite
 * lanes. That argument needs only that the two wires connect the same two docks in
 * opposite directions, which is what a pair IS. It does not need the paths to be
 * reversals of each other, and they are not. Nothing has to know that the other wire
 * exists.
 *
 * The `0` arm still absorbs the degenerate case: if A and B were the same cell the
 * compare is 0 either way, and the paragraph below explains why no gesture can reach it.
 *
 * The degenerate `0` arm is unreachable through the gesture - ports sit on their node's
 * footprint, footprints cannot overlap, and a self-loop is refused at host step 2, so
 * `path.length >= 2` for any wire a gesture can make. IT IS KEPT ANYWAY: `resolve_wire_dock`
 * degrades to the node origin on a bad port index, and the wire layer must never throw
 * inside the Pixi ticker (T-21-06 / T-66-08-01) - an uncaught exception in a ticker
 * listener kills the renderer permanently while every model assertion stays green.
 */
export function cableLane(path: ReadonlyArray<LaneCell>): Lane {
  if (path.length < 2) return 0;
  const first = path[0];
  const last = path[path.length - 1];
  if (first.cell_x !== last.cell_x) return first.cell_x < last.cell_x ? 1 : -1;
  if (first.cell_y !== last.cell_y) return first.cell_y < last.cell_y ? 1 : -1;
  return 0;
}

/** A world-px point on a drawn polyline. */
export interface LanePoint {
  x: number;
  y: number;
}

/**
 * Displace an axis-aligned polyline into its lane, by `offset` world px.
 *
 * THE PERPENDICULAR IS THE SEGMENT'S AXIS NORMAL, NEVER ITS SIGNED DIRECTION, and that
 * is load-bearing rather than a detail. A signed perpendicular flips with travel
 * direction; the lane key ALSO flips with travel direction; the two cancel, and a
 * forward/return pair lands back on the SAME lane - the defect restated, with more code.
 * Keying the perpendicular on the AXIS alone (horizontal segment -> displace in y,
 * vertical segment -> displace in x) leaves the lane sign as the only thing that
 * reverses, which is what makes the pair opposite by construction.
 *
 * Each vertex is displaced by the perpendicular of EVERY DISTINCT AXIS among the
 * segments touching it. An interior straight vertex touches one axis and moves on one
 * coordinate. An END vertex touches one segment - the one it leaves, or for the last
 * vertex the one it arrives on - and does the same. A CORNER touches both axes and
 * MOVES ON BOTH, which is exactly why both of its legs stay perfectly axis-aligned and
 * still meet: the horizontal leg's two endpoints both gain the same y, the vertical
 * leg's two endpoints both gain the same x. `40-UI-SPEC.md:192` ("90-degree corners
 * only, no diagonal strokes") is untouched.
 *
 * WHERE THE SEPARATION HOLDS, STATED HONESTLY. A pair is separated by `2 * offset`. At
 * `CABLE_LANE_OFFSET = CABLE_WIDTH = 2` that is 4 world px, so at zoom 1 and above the
 * gap is 4 device px and up: two distinct cables with a clear hole between them. At the
 * wire LOD cut (scale 0.5, `LOD_MIN_TREAD_PX / CELL`) the gap is 2 device px: two
 * distinct cables, touching. BELOW the cut it MERGES, and that is ACCEPTED - below the
 * cut the comet has already collapsed to a dot and the board is being navigated rather
 * than read.
 *
 * `offset === 0` returns the points unchanged (a fresh array, never the caller's).
 */
export function laneOffsetPolyline(
  pts: ReadonlyArray<LanePoint>,
  offset: number,
): LanePoint[] {
  const out = pts.map((p) => ({ x: p.x, y: p.y }));
  if (offset === 0 || out.length < 2) return out;
  for (let i = 0; i < out.length; i++) {
    let horizontal = false; // a segment at this vertex runs along x -> displace in y
    let vertical = false; // a segment at this vertex runs along y -> displace in x
    // The segment this vertex ARRIVES on, and the one it LEAVES on. An end vertex has
    // exactly one of the two, which is the "final vertex uses the segment it arrives
    // on" rule, expressed without a special case.
    for (const [a, b] of [
      [i - 1, i],
      [i, i + 1],
    ] as const) {
      if (a < 0 || b >= pts.length) continue;
      const dx = pts[b].x - pts[a].x;
      const dy = pts[b].y - pts[a].y;
      if (dx !== 0 && dy === 0) horizontal = true;
      else if (dy !== 0 && dx === 0) vertical = true;
      // A zero-length or (impossible) diagonal segment contributes no axis, so it
      // cannot push the vertex off its own line.
    }
    if (horizontal) out[i].y += offset;
    if (vertical) out[i].x += offset;
  }
  return out;
}
