// The occlusion scene of the pixel guard's surface (c2), side-effect free (plan 75-04).
//
// Moved out of `pixelGuard.tsx` unchanged by plan 75-04 so a unit test can read the
// SAME scene the pixel surface draws: `pixelGuard.tsx` is a page module with no exports
// and boots seven Pixi Applications on import, so nothing could import its scene. This
// module imports no renderer and touches no DOM; `occlusionScene.test.ts` builds the
// scene in Node and `pixelGuard.tsx` draws it through the real layers.
//
// `straight` moved with it because the occlusion belt row is built from it; the comet
// surface in `pixelGuard.tsx` imports it from here, so there is still one definition.

import { CELL } from '../../shared/geometry.ts';
import { bodyOfNode, wireRoute } from '../protocol/wireRoute.ts';
import { createSceneState } from '../render/sceneState.ts';
import { machine_kind } from '../protocol/kinds.ts';
import type { BeltView, NodeView, TileView, WireView } from '../protocol/decode.ts';

/** A straight horizontal wire tile at (cx, cy) - mirrors the wires.test.ts driver. */
export const straight = (cx: number, cy: number): TileView =>
  ({ cell_x: cx, cell_y: cy, kind: { Straight: { axis: 0 } } }) as TileView;

// --- Surface (c2): wire-vs-world occlusion (WIRE-02 / gate E6, plan 66-05) --
//
// WHY THIS SURFACE EXISTS AND WHY IT LANDED IN THE SPLIT'S OWN WAVE. The only wire
// baseline in the repo before this one is (c), and it mounts the wire layer ALONE on an
// empty canvas over a fixture carrying exactly ONE wire. So it proves the painter order
// WITHIN a wire and it can never see a crossing, an occlusion, or a z-order change
// against a machine or a belt, in either direction. `66-UI-SPEC.md:1131-1132` says so in
// terms and makes E6 a planner constraint on the split's wave: the cable/terminal split
// is the change that makes an occlusion regression POSSIBLE, and shipping it with its
// real gate deferred is the exact "every gate was green" condition Phase 64 shipped a
// one-click data-loss regression under.
//
// TWO WIRES, NOT ONE, AND THAT IS THE LOAD-BEARING PART. The split changes the painter
// order ONLY at wire count greater than one: before it, one Graphics drew per-wire
// interleaved (cableA, prongA, nubA, cometA, cableB, ...) so a LATER wire's alpha-0.35
// cable stroked over an EARLIER wire's opaque cyan nub; after it, every cable is grouped
// beneath every terminal and the nub wins. A one-wire surface would pass while being
// structurally blind to the one defect the split can introduce. This project has now
// found seven checks unable to see the thing they guarded. This is not the eighth.
//
// THE GEOMETRY, CHOSEN SO THAT EACH THING THE GATE CLAIMS TO SEE IS ACTUALLY DRAWN:
//   - wire A runs east along row 1 then bends SOUTH down column 6 into its target,
//   - wire B runs west along row 4 then bends NORTH up column 2 into its target,
//   - they CROSS TRANSVERSALLY at cell (2,1), away from every terminal,
//   - wire B's row-4 cable passes directly OVER wire A's target nub at cell (6,4), which
//     is the exact cable-versus-terminal overlap the split reorders,
//   - wire B's row-4 cable also crosses the 2x2 FACTORY body at (4,3), which is what a
//     `machines` reorder would occlude,
//   - the row-2 belt run crosses BOTH wires' vertical legs, at (6,2) and (2,2).
//
// EVERY PATH IS AUTHORED FROM `wireRoute(...).geometry.tiles`, NEVER BY HAND. The
// shipped `wireScene()` fixture below is NOT host-shaped: it authors four tiles between
// ports at (0,0) side E and (5,0) side W, while `manhattan_l` seeds from `from.cell` and
// INCLUDES both dock cells, so the real host emits six. A hand-authored path reproduces
// neither D1 nor D3 and would make plan 66-08's clamp behave differently here than on a
// real board.
export const OCCLUSION_CELLS_W = 10;
export const OCCLUSION_CELLS_H = 5;
export const OCCLUSION_CANVAS_W = OCCLUSION_CELLS_W * CELL; // 320
export const OCCLUSION_CANVAS_H = OCCLUSION_CELLS_H * CELL; // 160

/** One 1x1 electrical machine carrying exactly ONE port, on `side`, at its own cell. */
export function occlusionNode(
  id: number,
  kind: number,
  cellX: number,
  cellY: number,
  side: number,
  role: number,
): NodeView {
  return {
    id,
    kind,
    cell_x: cellX,
    cell_y: cellY,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: cellX, cell_y: cellY, side, role, medium: 1 }],
  } as NodeView;
}

/**
 * The routed path between two single-port nodes, through the byte-pinned TS mirror.
 *
 * THE TWO-ARGUMENT ROUTER, ON PURPOSE (phase 92, D-09, 92-RESEARCH Finding E). Since plan
 * 92-03 a real board routes every cable around the machines in its way (the avoiding
 * router in `wireRoute.ts`, called by the drag preview and mirrored by the host's render
 * packet), and a real board crosses a machine only at a walled-in port. This fixture keeps
 * the two-argument `wireRoute`, which knows only the two endpoint bodies, because its
 * crossings ARE the surface: wire B over wire A's target nub at (6,4) and both wires over
 * node 14 are the z-order witness the `wire-occlusion` baseline reddens on under a layer
 * reorder. Handed the scene's machine list, both wires would leave node 14 and wire B would
 * leave (6,4), and no reorder could move a pixel, a check that cannot fail. So
 * `wire-occlusion` moves only for the cable colour (plan 92-04), never for the obstacle rule.
 */
export function occlusionPath(from: NodeView, to: NodeView): TileView[] {
  const a = from.ports[0];
  const b = to.ports[0];
  const r = wireRoute(
    { cell: [a.cell_x, a.cell_y], side: a.side, body: bodyOfNode(from) },
    { cell: [b.cell_x, b.cell_y], side: b.side, body: bodyOfNode(to) },
  );
  if (!r.ok) throw new Error('the occlusion fixture route was rejected: the fixture is wrong');
  return r.geometry.tiles;
}

/**
 * The synthetic occlusion scene: seven machines, one belt run and THREE bending wires
 * (A and B cross), all in ONE SceneState so the three real layers read the same board.
 *
 * Sides: 0 = N, 1 = E, 2 = S, 3 = W. Roles: 1 = Out, 0 = In.
 * Wire A: node 10 ENDPOINT (0,1) E Out  ->  node 11 FACTORY (6,4) W In.
 * Wire B: node 12 FACTORY  (9,4) W Out  ->  node 13 FACTORY (2,0) S In.
 * Node 14 is the 2x2 FACTORY at (4,3) that BOTH cables now cross; it docks nothing.
 * Wire C: node 15 ENDPOINT (6,1) E Out  ->  node 16 FACTORY (7,3) W In (plan 75-04).
 *
 * RE-BLESSED 2026-09-03 by plan 72-15, and what changed is worth stating because the
 * baseline moved for TWO different reasons at once.
 *
 * THE FIX: wire A's ports face E and W, so the face-aligned router routes a Z. It now
 * descends in column 5 and takes a final EASTWARD step onto (6,4), so the cable ends ON
 * the In nub. It used to descend column 6 and stop at the cell centre, leaving 18.5 px
 * of cable short of an unattached terminal square. That gap was WINDOWS row 118's
 * reproduction (b), and this surface was one of the two places it was visible.
 *
 * THE COST, named rather than discovered later: column 5 rows 3 and 4 are INSIDE node
 * 14. Wire A did not cross node 14 before and does now, so this surface went from one
 * crossing cable to two. The router is NORMAL-aware, not OBSTACLE-aware: it is proved to
 * avoid the bodies of the two machines a cable CONNECTS, and it knows nothing about any
 * third machine. Column 6 was clear only by luck of this fixture's layout. Filed as its
 * own WINDOWS row rather than left for a reviewer to report as new.
 *
 * That cost is mild HERE specifically, because wire-vs-machine z-order is exactly what
 * this surface exists to witness: a second crossing cable gives the occlusion gate more
 * to see, not less.
 *
 * Node 10 is a kind-9 ENDPOINT so this surface WITNESSES the asymmetric inlet glyph
 * (FEEL-04) as well as the plain square nub - the same harden-in-content discipline
 * surface (c) states. Both wires are IDLE: no pulse, so the frozen frame carries no
 * comet and the baseline can hold `maxDiffPixels: 0` with the byte-exact surfaces.
 *
 * WIRE C, ADDED BY PLAN 75-04 (CABLE-11, D-10), AND WHY IT IS THE THIRD WIRE. Measured
 * before phase 75, wires A and B were already side-correct: each leaves along its source
 * port's face and enters its target head-on. So this surface, the repository's one
 * picture of cables against machines, showed no cable from the class phase 75 fixed, and
 * a regression of that fix could not move one of its pixels. Wire C is that class: two
 * 1x1 machines one column apart, the Out facing E and the In facing W, with the target
 * two rows below. Before phase 75 the face-aligned router left (6,1) heading SOUTH out of
 * an east-facing port. On the router of plans 75-01 to 75-03 it is the one-column
 * go-around, six cells `(6,1) (7,1) (7,2) (6,2) (6,3) (7,3)`: out east, down, back west,
 * down, and east into the target's west face. It stays inside the 10x5 canvas, touches no
 * other machine, and crosses the row-2 belt at (7,2) and (6,2), so the belt-under-cable
 * order is witnessed on a third wire too. Like A and B its path comes from `wireRoute`;
 * `occlusionScene.test.ts` holds every wire here to the head-on property.
 */
export function occlusionScene(): ReturnType<typeof createSceneState> {
  const scene = createSceneState();
  const aFrom = occlusionNode(10, machine_kind.ENDPOINT, 0, 1, 1, 1);
  const aTo = occlusionNode(11, machine_kind.FACTORY, 6, 4, 3, 0);
  const bFrom = occlusionNode(12, machine_kind.FACTORY, 9, 4, 3, 1);
  const bTo = occlusionNode(13, machine_kind.FACTORY, 2, 0, 2, 0);
  // The bystander the cable crosses: a 2x2 FACTORY at (4,3), docking nothing. A machine
  // with no port is what proves the cable reads as OVERHEAD rather than as something
  // attached, and it is the subject of the `machines` half of the non-vacuity check.
  const crossed: NodeView = {
    id: 14,
    kind: machine_kind.FACTORY,
    cell_x: 4,
    cell_y: 3,
    state: 0,
    w: 2,
    h: 2,
    rot: 0,
    ports: [],
    load: 0,
  } as NodeView;
  const cFrom = occlusionNode(15, machine_kind.ENDPOINT, 6, 1, 1, 1);
  const cTo = occlusionNode(16, machine_kind.FACTORY, 7, 3, 3, 0);
  for (const n of [aFrom, aTo, bFrom, bTo, crossed, cFrom, cTo]) scene.nodes.set(n.id, n);

  // The belt run: row 2, the full board width, so it crosses BOTH wires' vertical legs.
  scene.belts.set(1, {
    id: 1,
    latency: 60,
    fill: 0,
    items: [],
    tiles: Array.from({ length: OCCLUSION_CELLS_W }, (_, i) => straight(i, 2)),
    docks: [],
    // SLOT-03: appended LAST after `docks`; the identity interval (see beltScene).
    ticks_per_slot: 1,
  } as unknown as BeltView);

  scene.wires.set(1, {
    id: 1,
    from: { node: 10, port: 0 },
    to: { node: 11, port: 0 },
    path: occlusionPath(aFrom, aTo),
    pulses: [],
  } as WireView);
  scene.wires.set(2, {
    id: 2,
    from: { node: 12, port: 0 },
    to: { node: 13, port: 0 },
    path: occlusionPath(bFrom, bTo),
    pulses: [],
  } as WireView);
  scene.wires.set(3, {
    id: 3,
    from: { node: 15, port: 0 },
    to: { node: 16, port: 0 },
    path: occlusionPath(cFrom, cTo),
    pulses: [],
  } as WireView);
  return scene;
}
