// The ONE end geometry for a drawn cable (phase 75, D-08, 75-UI-SPEC 3.2): where a wire's
// line starts and stops, for the landed cable in `layers/wires.ts` AND for the drag preview
// in `layers/overlay.ts`.
//
// WHY THIS IS ITS OWN MODULE. Until plan 75-05 the clamp lived inside `wires.ts` and the
// preview had none, so the corridor the user saw while dragging stopped 16.5 px short of
// both nubs while the cable that landed reached them (WINDOWS row 121). A second copy of
// the clamp in `overlay.ts` that agreed today would be this repository's named drift
// failure (T-63-14). So the clamp, the crossed collapse and the vertex builder live here,
// and both layers call them. A grep for the clamp's definition finds exactly one, here.
//
// Pixi-free and DOM-free on purpose, like `cableLane.ts`: `input/gestures.ts` imports
// `NO_NUB` and `nubEndAt` from here, and the gesture tests run under vitest's `node`
// environment, which would not survive a transitive `pixi.js` import.

import { CELL } from '../../shared/geometry';
import { nubAnchor, unitDelta } from '../protocol/ports';
import { laneOffsetPolyline, type LaneCell, type LanePoint } from './cableLane';

/** The resting cable's stroke width, world px. The lane offset below is derived from it. */
export const CABLE_WIDTH = 2; // thin, taut - reads "cable" not "track"

/**
 * D1's lane displacement (66-UI-SPEC 5.1). THE DERIVATION IS THE VALUE: the gap equals
 * the cable, so a forward/return pair is separated by `2 * CABLE_LANE_OFFSET` = twice
 * the cable width. A bare `2` here - or worse a bare `4` for the resulting separation -
 * would freeze a coincidence into a number nobody chose, which is the contract violation
 * the UI-SPEC preamble names.
 *
 * THE ORIGINAL PRESCRIPTION WAS A SUB-PIXEL OFFSET AND IT WAS UNSHIPPABLE. It is
 * recorded here rather than deleted, because a later reader WILL propose it again as
 * "subtler". `pixiApp.ts:134` sets `antialias: false` - the maintainer judged antialias-on and
 * rejected it on 2026-07-31 - and `machineState.ts:112` already records that a 0.5u gap
 * does not survive rasterisation. Two 2px cables offset by half a pixel land on the same
 * pixel rows: the fix would have shipped as a NO-OP THAT EVERY GATE PASSED.
 *
 * It is also the LARGEST displacement that still reads connected. `NUB_HALF` is 5, so a
 * clamped cable end sitting `CABLE_LANE_OFFSET` off the nub centre is still inside the
 * 10px nub square. That is the ceiling on this constant, not a coincidence.
 *
 * Moved here from `layers/wires.ts` by plan 75-05 so the preview and the cable read one
 * value; `wires.ts` re-exports it so existing importers keep working.
 */
export const CABLE_LANE_OFFSET = CABLE_WIDTH;

/**
 * One RESOLVED cable end: the nub centre in world px, its outward unit normal, and the
 * cell of the port it belongs to. The port cell is carried because a nub is not always on
 * the cell its cable's end tile names (the pixel guard's comet surface routes from the
 * cell next to its source port), and the end geometry has to be able to tell.
 */
export interface ResolvedNub {
  x: number;
  y: number;
  /** Outward unit normal (`unitDelta` of the port side); both 0 when unresolved. */
  nx: number;
  ny: number;
  /** The port's own cell. */
  cellX: number;
  cellY: number;
}

/**
 * The explicit "this end has no nub" value. The drag preview's free end, while the pointer
 * is over open floor and no port is acquired, ends on the pointer's own cell centre
 * (75-UI-SPEC 3.1) and passes this. It is a named value rather than an omitted argument
 * because an optional nub would let a caller forget one and still compile, which is how
 * the preview stayed short of its nubs for three phases (CABLE-08).
 */
export const NO_NUB = null;

/** A cable end as the builder takes it: a resolved nub, or {@link NO_NUB}. */
export type NubEnd = ResolvedNub | typeof NO_NUB;

/** The two ends of one cable, source first. Both REQUIRED; pass {@link NO_NUB} for none. */
export interface CableNubs {
  from: NubEnd;
  to: NubEnd;
}

/**
 * The resolved nub of a port at `(cellX, cellY)` facing `side`: the shared `nubAnchor`
 * point, the `unitDelta` normal and the port cell. THE ONE PLACE A CABLE END IS BUILT
 * FROM A PORT, for the wire layer's docked ends and the gesture's pressed and acquired
 * ports alike, so the preview's nub and the cable's nub cannot be computed two ways.
 */
export function nubEndAt(cellX: number, cellY: number, side: number): ResolvedNub {
  const { x, y } = nubAnchor(cellX, cellY, side);
  const [nx, ny] = unitDelta(side);
  return { x, y, nx, ny, cellX, cellY };
}

/**
 * D3's clamp (66-UI-SPEC 5.2). Pull ONE end vertex back onto its resolved nub, ALONG
 * ITS OWN SEGMENT'S AXIS ONLY.
 *
 * The defect: the cable is stroked cell-centre to cell-centre while the nub sits at the
 * cell edge plus a 2.5px push (`ports.ts:170-201`, INSET=2, NUB_PUSH=2.5). Cell (10,6)
 * side E gives centre 336 against nub 352.5, so 16.5px of cable is drawn INTO the
 * machine - and because wires composite ABOVE machines, ON TOP of it.
 *
 * THE PERPENDICULAR COORDINATE IS NEVER TOUCHED. Touching it would make the end segment
 * diagonal, which is the one thing `40-UI-SPEC.md:192` forbids outright. This is spelled
 * out rather than left to judgement because "clamp the vertex to the nub" reads like it
 * means both coordinates, and it does not.
 *
 * THE NUB IS READ, NEVER RECOMPUTED. `nubEndAt` already returns `{x, y, nx, ny}` off
 * the shared `nubAnchor` math. A second edge-plus-push arithmetic here would be a second
 * source of truth for the same 2.5px - the exact class of defect Phase 65 spent a whole
 * phase on.
 *
 * WHEN THIS APPLIES. When the port's normal axis EQUALS the terminal segment's axis the
 * overshoot goes to zero and the cable starts at the nub. When they DIFFER (an N/S-facing
 * port with a horizontal first leg, or an E/W-facing port reached by a vertical last
 * leg) the nub's coordinate on the leg axis already equals the cell centre's, the clamp
 * is a no-op, and a stub would remain. That mismatch was D2 (WINDOWS row 118), and since
 * phase 75 the router no longer produces it outside four named shapes, so this function
 * now applies at both ends of every other cable. A THIRD CASE (CR-01, plan 75-09): the
 * axes are EQUAL but the nub lies BEHIND the end vertex, on the side away from its
 * neighbour, because the cable leaves or enters its port's cell through the back. An
 * own-cell nub is then reached (`ownCell`, the own-cell reach below); an off-cell nub is
 * declined, as before.
 *
 * WHERE THE ROUTER LIVES, AND THAT IT WAS NEVER FROZEN. A correction once written here
 * repeated an older claim that the router sat in a frozen crate. It does not and never
 * did: the router is `crates/fabrico-command/src/wire_route.rs`, mirrored by
 * `protocol/wireRoute.ts`, and `fabrico-command` was never in the byte-freeze, whose
 * FROZEN_PATHS were exactly `fabrico-core`, `fabrico-protocol` and `fabrico-scenario`.
 * The router has lived in `fabrico-command` since before the first release. Arm 2 of
 * `scripts/check-drawwire-truth.sh` (plan 75-04) keeps the old claim from coming back.
 *
 * WHAT THE ROUTER NOW GUARANTEES (plans 75-01 to 75-03). Plan 72-16's union-box
 * perimeter RING serves pairs whose four admissibility booleans are all false; plan
 * 75-01's go-around (`CAND_GO_AROUND`) serves the pairs with exactly ONE inadmissible
 * face, leaving along the source's face and entering the target head-on; plan 75-03's
 * clear-of-bodies candidate (`CAND_CLEAR_OF_BODIES`) serves a port facing straight into
 * its neighbour's body. Outside four named shapes, both faces are honoured: P1 (both
 * docks on one cell, now a typed refusal drawn as a two-cell stub), P2 (two touching
 * docks where one faces the other and the other does not), P3a (a port faces into the
 * neighbour's body and the cable goes clear of both bodies instead) and P3b (no
 * connection can avoid crossing a machine). `crates/fabrico-command/tests/wire_side_aware.rs`
 * proves it over every real-size pair, and the `wire-occlusion` pixel surface carries a
 * cable of the fixed class (wire C, plan 75-04).
 * A SECOND EXCEPTION (WR-01): on an exactly-2-cell route whose two resolved nubs have
 * CROSSED on the leg axis (two directly adjacent 1x1 machines: the source's nub lands
 * past the target's along the direction of travel) `cablePoints` collapses onto both
 * nubs directly instead of calling this function - see the branch there and
 * `nubsCrossed` below. A route whose nubs have NOT crossed (including a degraded or
 * hostile one, D3's own reversal-guard fixture) still calls this function for both
 * ends, now against the pre-clamp ORIGINAL neighbour rather than a possibly-mutated
 * one, which is what a shared two-vertex `pts` needs to stay order-independent.
 *
 * THREE MORE TERMS, NO-OPS ON EVERY PAIR THE ROUTER SERVES HEAD-ON. An end the router
 * cannot serve head-on runs one of TWO ways, and plan 75-05 first wrote here that only the
 * first exists. 75-REVIEW CR-01 measured the second over 82,282 random real-size pairs
 * (280 touching pairs whose disagreeing port faces straight away, 418 router-kept
 * crossings leaving or entering through their own body, 278 candidate-4 ends whose only
 * free neighbour is behind the port), and `cableEnds.test.ts` sweeps every adjacent 1x1
 * pair and the 23,888-case physical sweep over the DRAWN ends.
 *   - ACROSS THE NORMAL: THE NUB ELBOW (75-UI-SPEC 2.1, `takesElbow`, plan 75-05). The end
 *     segment runs across the port's normal, so this clamp has nothing to move and the
 *     cable used to stop on the cell centre, 16.5 px short of its nub. `cablePoints` now
 *     appends the nub itself at that end, so the cable turns at the cell centre and runs
 *     out along the normal. It fires only when the end segment's axis differs from the
 *     normal's axis AND the nub's port cell is the end tile's cell (75-RESEARCH
 *     Pitfall 3).
 *   - ALONG THE NORMAL, THROUGH THE BACK: THE OWN-CELL REACH (CR-01, plan 75-09, inside
 *     this function). The end segment runs on the normal's axis but the nub lies behind
 *     the end vertex, so the sign check passes and the WR-02 range bound used to decline,
 *     leaving the end on the cell centre inside the machine. With `ownCell` (the nub's
 *     port cell is this end's routed cell, the `onCell` test the elbow uses) the end
 *     vertex takes the nub's coordinate on the segment axis, the lane coordinate
 *     untouched. One mechanism, not a post-pass beside the clamp: a separate pass would
 *     double-cover head-on ends and leave the clamp's head-on pins unable to fail.
 *   Both costs are named exceptions to CABLE-05 (75-UI-SPEC 2.1): the elbow draws about
 *   32 px of cable over a 1x1 port's own machine (measured on the walk, 75-WALK.md
 *   FINDING ELBOW-LENGTH: the 16.5 px leg plus the run on across the cell), and the reach
 *   draws the cable across its port's own cell, up to the whole cell on a 1x1 machine.
 *   - THE COLLAPSE'S CELL TERM (75-UI-SPEC 2.2, CABLE-09). The WR-01 collapse fires only
 *     when each nub's port cell is its end tile's cell. Plan 75-03's same-cell stub (both
 *     ports on the source cell, drawn to the cell the source faces) reads as crossed too,
 *     and the collapse joined its two nubs straight across the machine; with the term it
 *     clamps the start onto the source nub and leaves a short cable outside the machine.
 * On every pair served head-on the end segments run along the normals (the elbow's first
 * term is false), each nub lies AHEAD of its end vertex rather than behind it (the reach
 * does not fire; the ordinary clamp does), and every path starts and ends on its ports'
 * own cells (the cell term is true), so none of the three changes a vertex there.
 *
 * The reversal guard: if the nub coordinate lies past the far end of the segment, the
 * clamp would reverse it. Leave the vertex where it is instead.
 *
 * ONE COMPARISON COVERS BOTH THE REVERSAL AND THE ZERO CASE, and it was written as two
 * until a deliberate fault proved the second half could not matter. `Math.sign` returns
 * 0 when the nub lands EXACTLY on the far end, and 0 never equals the sign of a
 * non-degenerate segment, so the same test already declines that clamp. A separate
 * `target === far` line read as defensive and was in fact unreachable: no injected fault
 * could make its removal visible to any assertion. Both arms are gated by
 * `wires.test.ts` ("D3's reversal guard", "D3's zero guard").
 *
 * WR-02: the sign check bounds only the DIRECTION (same side of `far` as `near`), never
 * the MAGNITUDE. A nub that resolved somewhere else entirely - a stale packet, or
 * `resolve_wire_dock` degrading to the node origin on a bad port index (the trigger
 * `WINDOWS.md` row 116 describes) - could drag the
 * vertex an unbounded distance past the routed corridor, stroking a line across whatever
 * sits between.
 *
 * WHAT THE 73-08 SENTENCE HERE CLAIMED, AND WHY IT IS DELETED RATHER THAN ANNOTATED. It
 * said the frontend dock-safety gate naming this trigger was removed "once
 * `fold_remove_port` learned to re-point every route and dock keyed to a removed port".
 * 73-REVIEW CR-02 measured that as false for the case this bound is about: the fold
 * re-pointed BELT docks and never looked at a `Node::Wire` at all, so a port removal on a
 * machine carrying a cable left the cable's endpoint naming a port that had moved or gone.
 * 73-12 closes it on both sides - the endpoint shifts with the list through the same
 * `judge_docks` verdict, and removing the port a cable is attached to is refused at the
 * command layer - so this bound is now a genuine backstop for a stale packet rather than a
 * containment for a live core defect. Keep it: a stale packet is still reachable. The bound below is ADDITIVE to the sign check above, not a replacement
 * of it: removing the sign check alone would let a reversal through even though the
 * magnitude bound is satisfied (a reversed target can still lie within [lo, hi] when the
 * segment runs the other way), and removing the magnitude bound alone reopens WR-02.
 *
 * THE BOUND IS RELAXED ON THE NEAR SIDE ONLY, AND ONLY FOR AN OWN-CELL NUB (CR-01, plan
 * 75-09). The own-cell reach accepts a nub past `near` when `ownCell` is true. That nub sits
 * on the edge of the very cell `near` is the centre of, 0.5 px out, so the reach is at most
 * CELL/2 + 0.5 = 16.5 world px BY CONSTRUCTION, and no stale or hostile packet can stretch
 * it: a nub off this end's cell is `ownCell` false and meets the WR-02 bound exactly as
 * before. That is why D3's reversal and zero guards (`wires.test.ts`, nubs off their end
 * cells) and the pixel guard's `wire-comet` surface (a path starting a cell away from its
 * port, 75-RESEARCH Pitfall 3, pinned by `cableGeometry.test.ts` "the comet surface's
 * geometry gains no elbow") do not move.
 *
 * THE LANE-OFFSET MARGIN, stated as the fact that is load-bearing rather than the one
 * that reads well. `laneOffsetPolyline` does NOT displace only along a segment's axis
 * normal: `cableLane.ts` displaces a CORNER on BOTH axes, and its own header says so.
 * Under 72-16's ring, `pts[1]` and `pts[n-2]` are frequently corners, so `far` on the
 * clamp axis shifts by +/-CABLE_LANE_OFFSET while `pts[0]` is an end vertex touching one
 * segment and `near` on the clamp axis is untouched. For an E-facing port the WR-02 range
 * bound therefore becomes `nub 32.5 in [16, 46..50]` rather than `[16, 48]`, which holds.
 * THE FACT THAT MAKES IT HOLD IS `CELL/2 + NUB_PUSH < CELL - CABLE_LANE_OFFSET`, i.e.
 * 18.5 < 30, with 13.5px of margin. If any of those three constants moves, that is the
 * inequality to re-check, not the axis-normal claim.
 *
 * THE MISSING EXIT GATE (66-12). This function's output is read by the resting cable
 * stroke, the reply comet's drawn polyline AND, since plan 75-05, the wire drag preview -
 * `cablePoints` below returns the single vertex list all three consume, there is no
 * second comet-only or preview-only path. So any future change to the clamp or lane
 * geometry here moves pixels on `frontend/e2e/pixel-guard.spec.ts`'s `wire-comet` surface
 * even when every non-visual gate (vitest, tsc, cargo test, core-freeze) stays green.
 * That is exactly what happened with the WR-01/WR-02 fix above: its own "four exit gates"
 * never named the Playwright pixel suite, so the 44-pixel comet-baseline move it caused
 * shipped unblessed and unnoticed until the next phase verification caught it
 * (66-VERIFICATION.md), closed by 66-12. THE RULE: a change to
 * `clampEndToNub`/`nubsCrossed`/`cablePoints` is not done until
 * `frontend/e2e/pixel-guard.spec.ts` has been re-run and any moved baseline read and
 * either re-blessed with its diff described, or flagged.
 */
export function clampEndToNub(p: LanePoint, q: LanePoint, nub: ResolvedNub, ownCell: boolean): void {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  // Only an axis-aligned, non-degenerate segment has an "own axis" to clamp along.
  if (dx === 0 && dy === 0) return;
  if (dx !== 0 && dy !== 0) return;
  const onX = dy === 0;
  const far = onX ? q.x : q.y;
  const near = onX ? p.x : p.y;
  const target = onX ? nub.x : nub.y;
  // Declines both the reversal (opposite signs) and the zero case (Math.sign -> 0).
  if (Math.sign(far - target) !== Math.sign(far - near)) return;
  // CR-01, THE OWN-CELL REACH (plan 75-09): the nub lies BEHIND the end vertex, on the
  // side away from `far` (the cable leaves or enters its port's cell through the back).
  // For a nub on this end's own cell that is at most 16.5 world px, and the end vertex
  // takes the nub's coordinate on this axis. An off-cell nub falls to WR-02 below.
  if (ownCell && Math.sign(target - near) === Math.sign(near - far)) {
    if (onX) p.x = target;
    else p.y = target;
    return;
  }
  // WR-02: the nub must lie ON the segment (between `near` and `far`), not merely on
  // the same side of `far` as `near` is. A degraded/hostile dock outside that range is
  // declined here too, leaving the vertex at its routed cell centre.
  const lo = Math.min(near, far);
  const hi = Math.max(near, far);
  if (target < lo || target > hi) return;
  if (onX) p.x = target;
  else p.y = target;
}

/**
 * WR-01's discriminator. True when the two resolved nubs have CROSSED on the shared
 * leg axis: the source's nub lies past the target's along the direction of travel,
 * which is exactly what happens between two directly adjacent 1x1 machines (their
 * nubs are ~1px apart and INVERTED against the two cell centres, 66-REVIEW.md WR-01).
 * A degraded/hostile nub (D3's own reversal-guard fixture) is simply out of range in
 * the SAME direction as the path, not crossed - `false` here routes it to the guarded
 * `clampEndToNub` calls instead, where the reversal/zero/magnitude checks decline it.
 */
export function nubsCrossed(
  p0: LanePoint,
  p1: LanePoint,
  nub0: ResolvedNub,
  nub1: ResolvedNub,
): boolean {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  if (dx === 0 && dy === 0) return false;
  if (dx !== 0 && dy !== 0) return false;
  const onX = dy === 0;
  const pathDelta = onX ? dx : dy;
  const n0 = onX ? nub0.x : nub0.y;
  const n1 = onX ? nub1.x : nub1.y;
  const nubDelta = n1 - n0;
  if (nubDelta === 0) return false;
  return Math.sign(nubDelta) !== Math.sign(pathDelta);
}

/** The axis a nub's outward normal runs on, or null for an unresolved nub (no normal). */
function normalAxis(nub: ResolvedNub): 'x' | 'y' | null {
  if (nub.nx !== 0) return 'x';
  if (nub.ny !== 0) return 'y';
  return null;
}

/** The axis an axis-aligned, non-degenerate segment runs on, or null otherwise. */
function segmentAxis(p: LanePoint, q: LanePoint): 'x' | 'y' | null {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (dx !== 0 && dy === 0) return 'x';
  if (dy !== 0 && dx === 0) return 'y';
  return null;
}

/** True when the nub's port sits on this cell, the end tile its cable stops on. */
function onCell(nub: ResolvedNub, cell: LaneCell): boolean {
  return nub.cellX === cell.cell_x && nub.cellY === cell.cell_y;
}

/**
 * THE NUB ELBOW (75-UI-SPEC 2.1, plan 75-05): does this end take ONE extra vertex at its
 * nub? `seg` is the end segment, end vertex first.
 *
 * WHAT IT FIXES. On the shapes the router cannot serve head-on (P2, P3a and P3b) an end
 * segment runs either ACROSS its port's normal (this elbow) or ALONG it through the back of
 * the port's cell (the own-cell reach in `clampEndToNub`, CR-01, plan 75-09; plan 75-05
 * first wrote that every such end crosses the normal, and 75-REVIEW measured that false).
 * For an end across the normal the clamp has nothing to move: the nub's coordinate on the
 * leg axis is the cell centre's, so the cable stopped on the cell centre, 16.5 px from its
 * nub, an 11.5 px gap after the 5 px prong. A cable that visibly stops short of its port reads as
 * unplugged. The elbow appends the nub itself, so the cable turns at the cell centre and
 * runs out along the normal onto the nub. The nub is on the cell's midline, so that leg is
 * axis-aligned by construction, and the lane offset (which displaces the end vertex ACROSS
 * the end segment, along the normal's own axis) leaves it parallel to the normal.
 *
 * THE COST, NAMED, AS WALKED. The turn vertex inside the port's own cell is a CABLE-05
 * exception ("no drawn cable vertex lies strictly inside either docked machine's
 * footprint box"), asserted by name in `wires.test.ts` E3c on a P2 pair. On the walk
 * (75-WALK.md FINDING ELBOW-LENGTH) it read as about 32 px of cable over a 1x1 port's own
 * machine: the 16.5 px leg out to the nub plus the run on across the cell to the turn. The
 * own-cell reach is the other exception: a back-facing end crosses its port's own cell, up
 * to the whole cell on a 1x1 machine. Chosen as the default
 * and kept on the walk; one word turns it off.
 *
 * BOTH TERMS ARE REQUIRED (75-RESEARCH Pitfall 3).
 *   (a) The end segment's axis differs from the port normal's axis. Without it every
 *       head-on end, whose clamp already reached the nub, would gain a duplicate vertex.
 *   (b) The nub's port cell is the end tile's cell. Without it an end whose path starts a
 *       cell away from its port (the pixel guard's `wire-comet` surface routes from (1,0)
 *       while its source port is on (0,0)) would be joined to its nub on a DIAGONAL when
 *       its port faces across the first segment, and would move pixels where it does not.
 *
 * A NO-OP ON EVERY PAIR THE ROUTER SERVES HEAD-ON: there the end segment runs along the
 * normal, term (a) is false, and the clamp alone puts the end on the nub.
 */
function takesElbow(seg: readonly [LanePoint, LanePoint], nub: ResolvedNub, endCell: LaneCell): boolean {
  const normal = normalAxis(nub);
  const along = segmentAxis(seg[0], seg[1]);
  return normal !== null && along !== null && along !== normal && onCell(nub, endCell);
}

/**
 * The DRAWN vertices of one cable or one preview corridor: the routed cells' centres,
 * displaced into the lane `lane` names (D1, `lane * CABLE_LANE_OFFSET`), then clamped at
 * both ends onto the resolved nubs (D3, with the own-cell reach for an end that leaves or
 * enters its port's cell through the back, CR-01), with the nub elbow on an end that runs
 * across its port's normal (`takesElbow`). A {@link NO_NUB} end is left on its cell centre.
 *
 * THE ONE BUILDER. `wires.ts`' `cablePolyline` (the resting cable and the comet) and
 * `overlay.ts`' `strokeLeg` (the drag preview) both call this, so the corridor the user
 * drags and the cable that lands cannot disagree about where their ends are (D-08).
 *
 * Fewer than two cells returns the cell centres unclamped; neither caller strokes them.
 */
export function cablePoints(
  cells: ReadonlyArray<LaneCell>,
  lane: number,
  nubs: CableNubs,
): LanePoint[] {
  const pts = laneOffsetPolyline(
    cells.map((c) => ({ x: c.cell_x * CELL + CELL / 2, y: c.cell_y * CELL + CELL / 2 })),
    lane * CABLE_LANE_OFFSET,
  );
  const { from, to } = nubs;
  if (pts.length < 2) return pts;
  const first = cells[0];
  const last = cells[cells.length - 1];
  // The end segments as ROUTED, before any clamp: the clamp moves an end along its own
  // segment's axis only, so the axis the elbow reads is the same either way, and reading
  // it here keeps a 2-point route's two ends independent of each other.
  const head: [LanePoint, LanePoint] = [{ ...pts[0] }, { ...pts[1] }];
  const tail: [LanePoint, LanePoint] = [{ ...pts[pts.length - 1] }, { ...pts[pts.length - 2] }];
  if (pts.length === 2) {
    if (
      from !== NO_NUB &&
      to !== NO_NUB &&
      // THE COLLAPSE'S CELL TERM (plan 75-05, D-05's drawn half, CABLE-09): WR-01 is two
      // adjacent machines, each nub on its own end tile's cell. Plan 75-03's same-cell
      // stub (the source cell, then the cell it faces, both ports on the source cell)
      // ALSO reads as crossed, and collapsing it joined the two nubs straight across the
      // machine body. With this term the stub falls to the guarded clamps below: the
      // start lands on the source nub, the far end stays on the faced cell's centre, a
      // short cable outside the machine (75-UI-SPEC 2.2). A no-op on every routed pair:
      // a router path always starts and ends on its two ports' own cells.
      onCell(from, first) &&
      onCell(to, last) &&
      nubsCrossed(pts[0], pts[1], from, to)
    ) {
      // WR-01: a 2-cell route (two directly adjacent 1x1 machines) means the two ends
      // SHARE one segment, and the two nubs have crossed on the leg axis. Calling
      // `clampEndToNub` twice in sequence would have the second call read the vertex
      // the first one just mutated - order-dependent, and whichever order loses leaves
      // 16.5px of cable drawn inside the target machine's footprint. The honest render
      // for this degenerate, crossed case is the two resolved nub coordinates directly,
      // not two sequential single-axis clamps fighting over one shared vertex.
      pts[0].x = from.x;
      pts[0].y = from.y;
      pts[1].x = to.x;
      pts[1].y = to.y;
      return pts;
    }
    // Not crossed: a degraded/hostile nub (or a genuinely short but non-adjacent
    // route) still goes through the guarded clamp, both ends checked against the
    // PRE-CLAMP original neighbour rather than a possibly-mutated one, so this
    // order-independent regardless of which end is evaluated first.
    if (from !== NO_NUB) clampEndToNub(pts[0], head[1], from, onCell(from, first));
    if (to !== NO_NUB) clampEndToNub(pts[1], tail[1], to, onCell(to, last));
  } else {
    if (from !== NO_NUB) clampEndToNub(pts[0], pts[1], from, onCell(from, first));
    if (to !== NO_NUB) clampEndToNub(pts[pts.length - 1], pts[pts.length - 2], to, onCell(to, last));
  }
  // The nub elbow, at either end, after the clamps (see `takesElbow`).
  if (to !== NO_NUB && takesElbow(tail, to, last)) pts.push({ x: to.x, y: to.y });
  if (from !== NO_NUB && takesElbow(head, from, first)) pts.unshift({ x: from.x, y: from.y });
  return pts;
}
