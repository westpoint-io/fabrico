// DEV-ONLY pixel-guard fixture (QAGUARD-01, Plan 43-03). Boots the REAL render
// surfaces over a synthetic scene so the Chromium gate (pixel-guard.spec.ts) can
// screenshot one surface per render-regression class against committed baselines.
// This module is NEVER imported by App.tsx / main.tsx; it is loaded only by the
// root-level pixel-guard.html dev fixture, which is not a build input (only
// index.html is), so it stays out of `dist`.
//
// Six individually-locatable surfaces, one per regression class:
//   (a) #surface-operator     ART-01 / RENDER-01 machine-footprint - the VECTOR
//       machine, drawn through the primitives that actually ship: `drawChassis`
//       (layers/machineChassis.ts) plus `getAssetContext('router')`, on a
//       fixed-size antialias-off Pixi Application. Drawn TWICE: once at the
//       Router's base 2x3 and once at a GROWN 2x4.
//
//       WHY IT MOVED OFF THE BAKE (plan 58-06; 58-RESEARCH F5 named the trap).
//       Until Phase 58 this surface baked a Router through `makeGenerators` into
//       a PNG-data-URL <img>. Phase 58 moved every machine on the real
//       canvas to vector geometry, and `machines.ts` no longer imports a
//       generator at all - so the baked surface would have stayed GREEN forever
//       while the shipped machine path changed underneath it. A gate that has
//       stopped guarding the shipped path is worse than no gate, because it
//       reports green. It now draws through the same two functions the machine
//       layer calls, so a machine-art regression flips this baseline.
//
//       WHY THE GROWN CELL IS THE POINT. `grow_to_fit`
//       (crates/fabrico-core/src/state.rs) clamps only at MAX_FOOTPRINT_DIM = 64,
//       so the shipped `+ Add output` gesture takes a Router from 2x3 to 2x4 and
//       beyond, while the legal `viewBox` whitelist has exactly FOUR entries -
//       a grown machine has no legal asset and never can have one. That is the
//       defect that forced the chassis into code (the maintainers' call, 2026-08-02), and
//       the 2x4 drawing is the only PIXEL-level evidence in the repo that the
//       parametric chassis actually draws a footprint no artwork covers.
//       IDLE at both footprints: the WORKING notch and the FAULTED ring are
//       frame-driven, and a still surface must not depend on a clock.
//   (b) #surface-belt-corner  RENDER-02/FEEL-02 corner-geom - the SHIPPED VECTOR
//       corner, drawn through the primitives that actually ship: the shipped
//       painter's `corner` tread context over its `cornerRails` context, on a
//       fixed-size antialias-off Pixi Application. BOTH chiralities x three
//       sampled march buckets (2 rows x 3 columns, 2px substrate gutters, 100x66).
//
//       WHY IT MOVED OFF THE BAKE (plan 61-07; `61-CONTEXT.md` H4 ruled it). It was
//       a sheet of eight raster corner bakes through a PNG-data-URL
//       <img image-rendering:pixelated>. Plan 61-03 made the
//       belt layer fully vector, so from that point this surface pinned bytes no
//       user could see - the same "gate that has stopped guarding the shipped path"
//       failure (a) was moved off in 58-06. Keeping the bake alive purely to feed
//       this tool was rejected: it leaves dead pixel code with a live baseline,
//       which is what this phase exists to remove.
//
//       WHY BOTH CHIRALITIES ARE STILL THE POINT. The pre-sheet surface drew ONE
//       cw phase-0 corner, and that single-point sampling let a ccw orientation
//       defect and a phase-marching defect (F2) escape the gate. A 90-degree
//       whole-sprite rotation reaches only 4 of the 8 (from,to) corners, so the
//       x-mirror is a genuinely different drawing and must be gated as one.
//   (c) #surface-wire-comet   RENDER-03 wire-pulse   - the real wire layer mounted on a
//       fixed-size antialias-off Pixi Application over a synthetic one-wire scene with
//       a REPLY pulse, frozen mid-sweep by a FIXED render clock (two draws: latch at
//       T0 -> frac 0, then T0 + HALF_SWEEP -> frac 0.5). No wall clock: the fixed
//       effectiveClock is passed straight to the layer draw (the render-clock lever),
//       never scene.tick / a GridCommand / the log (determinism boundary held).
//   (c2) #surface-wire-occlusion  WIRE-02 / E6 wire-vs-world z-order - the real wire,
//       machine AND belt layers mounted TOGETHER over one synthetic scene carrying a
//       machine, a belt run and TWO BENDING, CROSSING wires. Added by plan 66-05, in
//       the SAME wave as the cable/terminal split, because the split is the change
//       that makes an occlusion regression possible and NO gate in the repo could see
//       one: surface (c) mounts the wire layer ALONE on an empty canvas, so it proves
//       painter order WITHIN wires and can never see a crossing, an occlusion, or a
//       z-order change against a machine or a belt in either direction.
//   (c3) #surface-wire-goaround  the 72-16 UNION-BOX PERIMETER RING, added because
//       MEASURED, no pixel or visual gate in this repository could see a go-around at
//       all: occlusion wire A ((0,1)E -> (6,4)W) has leave_x and arrive_x true, wire B
//       ((9,4)W -> (2,0)S) has leave_x and arrive_y true, so BOTH decline at the ring's
//       D2 gate; and surface (c)'s comet path is HAND-AUTHORED and never calls
//       wireRoute at all. This surface carries the row-aligned Route/Handler PAIR from
//       72-16-DESIGN section 6 example A, with a 3x3 Handler, so the reply leg's four
//       admissibility booleans are all false and the ring is what gets drawn. It is the
//       only place a change to the ring's terminal runs, or to clampEndToNub, moves a
//       committed pixel.
//   (d) #surface-vector-pilot VEC-03 vector-crispness - the pilot calibration asset
//       (render/assets/pilot.svg) drawn three times from ONE shared GraphicsContext
//       at scale 1, 2 and 1.77 on a fixed-size antialias-off Pixi Application. The
//       1.77 placement is VEC-01's named 177% case: with AA off the rasteriser snaps
//       each edge to a whole device pixel, so edges stay HARD at a fractional zoom.
//       Also the live demonstration of VEC-04's shared-context rule (three Graphics,
//       one tessellation).
//   (e) #surface-belt-rail   BELT-05 rail-continuity - the REAL belt layer over THREE
//       synthetic runs (a ten-tile straight, a single bend, and an S-bend whose two
//       corners meet with no straight between them), each drawn TWICE at each of six
//       camera scales: once with the shipped device-quantum rail family and once with a
//       CONTROL rail family produced by calling the SAME emitter at quantum 1.
//
//       ONE Pixi Application, RESIZED per drawing - not one per drawing. A browser caps
//       live WebGL contexts (Chromium at around 16) and silently loses the oldest past
//       the cap; 36 Applications here corrupted surfaces (a), (c) and (d) and flipped
//       `data-antialias` to "1". Found by running the suite.
//
//       It commits NO baseline image. Its gate
//       (`e2e/belt-rail-continuity.spec.ts`) reads pixels back through Pixi's own
//       extract path and asserts continuity NUMERICALLY, because that is the property -
//       "both rails present, no interior gap columns" is a count, not a picture, and a
//       screenshot of it would be a baseline that says nothing about whether it passed.
//
//       WHY THE CONTROL IS THE SAME FUNCTION AT A DIFFERENT ARGUMENT. At quantum 1 the
//       rule takes its identity values and reproduces the pre-fix geometry EXACTLY, so
//       the control cannot drift away from the thing it is controlling for - which a
//       copied-out snapshot of the old code certainly would. A gate that cannot fail is
//       not a gate; this one carries its own proof of failure beside its pass.
//
//       ADDITIVE AND INDEPENDENTLY LOCATABLE, on purpose: plan 61-07 re-points surface
//       (b) at the shipped vector corner and blesses that baseline a second time, so
//       this surface must not be entangled with it.
//   (f) #surface-cable-min-zoom  CABLE-07 at the camera's minimum zoom (plan 75-10,
//       75-WALK.md GAP LOW-ZOOM) - the REAL wire layer drawing one routed cable (a
//       vertical and a horizontal straight run, each over four cells) inside a holder
//       scaled by `MIN_ZOOM` (0.25), at 16 sub-pixel camera origins (0, 0.25, 0.5 and
//       0.75 device px on each axis), at REST and MARKED (the re-route mark at alpha 1).
//       Both walks on the real binary saw a moved cable at 25% show little or none of its
//       mark: a 2 world px stroke is half a screen pixel there, and with antialias off half
//       a pixel covers a pixel centre at one origin and none at the origin half a pixel
//       over. So the surface sweeps origins rather than trusting one camera.
//
//       NUMBERS, NOT A PICTURE, for the reason (e) gives: "every position along the run
//       carries ink" is a count, and a blessed PNG of a vanished line would pass. Per run
//       it publishes how many device positions along the line (one cell skipped at each
//       end) carry no ink within 2 device px across of it, as `data-cable-min-zoom` on the
//       readout. Its gate is `e2e/cable-min-zoom.spec.ts`; it commits no baseline image.
//
//       IT CARRIES ITS OWN FAILING CONTROL IN THE SAME RUN (the (e) precedent). Every
//       drawing is made twice: SHIPPED hands the layer's `scale` and `quantum` closures the
//       zoom, as `pixiApp.ts` does at DPR 1; CONTROL hands them 1, the same function at its
//       identity argument, which strokes the pre-fix 2 world px inside the same 0.25
//       holder. The gate requires the control to show gaps, so a read that cannot see a
//       vanished line fails the gate itself.
//
//       ONE Application, resized per drawing (64 drawings), for the WebGL-context cap (e)
//       found: this surface adds exactly one context to the page.
//   (g) #surface-machine-kinds  GATE-05 (plan 92-06) - the REAL machine layer drawing
//       every placeable kind (Factory, HTTP Handler, Router, Tee, Balancer, Merge, Label,
//       Source, Sink, Route) from the shipped catalog, plus a FAULTED Factory carrying all
//       three port roles, a FAULTED Sink and a WORKING Factory, on ONE Application at
//       768 x 384. One frame is drawn: the first at which both alert rings are at their
//       peak, found by search and published on the readout with both ring alphas read back
//       off the drawn rings. Thirteen element-scoped baselines, one per slot, through clip
//       divs over the canvas (`e2e/machine-kinds-pixel.spec.ts`), so a broken kind reddens
//       its own PNG; `scripts/prove-machine-kinds-baselines-bite.sh` breaks each kind's art
//       in a private worktree and shows exactly its own PNGs redden.
//
// NO SURFACE IS A BAKE ANY MORE (plan 61-07 re-pointed the last one). Every drawing on
// this fixture is a live Pixi canvas, and every colour comes from LOCKED_SKIN through
// the real painters - no hand-authored hex. The authored SVGs behind (a) and (d) are
// the ONE documented exemption: an SVG file necessarily carries literal hex, and each
// carries the exemption note plus the named LOCKED_SKIN ramp value it mirrors
// (`shippedAssets.test.ts` gates the shipped nine against the ramp VALUE SET at fail
// severity).

import { Application, Container, Graphics, Rectangle } from 'pixi.js';
import { createWireLayer } from '../render/layers/wires.ts';
import { createBeltLayer } from '../render/layers/belts.ts';
import { createMachineLayer } from '../render/layers/machines.ts';
import { bodyOfNode, wireRoute } from '../protocol/wireRoute.ts';
import { BeltContextCache } from '../render/synth/beltContextCache.ts';
import { SHIPPED_PAINTER, type BeltPainter } from '../render/synth/beltPainter.ts';
import { railBandAt } from '../render/synth/beltGeometry.ts';
import { SynthTextureCache } from '../render/synth/textureCache.ts';
import { createSceneState } from '../render/sceneState.ts';
import { MIN_ZOOM } from '../render/camera.ts';
import { cablePoints, nubEndAt } from '../render/cableGeometry.ts';
import { cableLane } from '../render/cableLane.ts';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { getAssetBox, getAssetContext, type AssetName } from '../render/svgAssets.ts';
import { getPilotContext } from './pilotFixture.ts';
import { drawChassis } from '../render/layers/machineChassis.ts';
import { CELL } from '../../shared/geometry.ts';
import { machine_kind, state_tag } from '../protocol/kinds.ts';
import { catalogEntry, type BeltView, type NodeView, type TileView, type WireView } from '../protocol/decode.ts';
import { alertRingAlpha } from '../render/layers/machineState.ts';
import {
  OCCLUSION_CANVAS_H,
  OCCLUSION_CANVAS_W,
  occlusionScene,
  straight,
} from './occlusionScene.ts';

const hex = (n: number): string => '#' + (n >>> 0).toString(16).padStart(6, '0');

// The synthetic-scene substrate: the darkest ramp step, the SAME void the real
// canvas paints behind the floor (bootPixi background). Read from the skin so a
// transparent bake corner composites against a stable, data-driven backdrop.
const substrate = hex(LOCKED_SKIN.palette.ramp[0]);

// --- Surface (a): the vector machine at a base and a GROWN footprint --------
// See the header. The Router is the subject because it is the kind the growth
// gesture actually reaches in practice (`+ Add output` on a multi-port machine),
// and because its base 2x3 is one of the four whitelisted `viewBox` footprints
// while its grown 2x4 is not a whitelisted footprint at all.
const OPERATOR_SUBJECT: AssetName = 'router';

/**
 * `[w, h, x, y]` per drawing - footprint in CELLS, placement in px.
 *
 * 2x3 is the Router's base footprint (64 x 96 px at CELL 32); 2x4 is the first
 * grown step the shipped gesture produces (64 x 128 px). The chassis stroke is
 * CENTRED on a 4u inset, so its outer edge sits 2.5 px inside the effective box
 * and nothing spills past it - the 8 px margins below clear both drawings with
 * room to spare, and the 16 px gutter keeps a diff PNG readable.
 */
const OPERATOR_PLACEMENTS = [
  [2, 3, 8, 8],
  [2, 4, 88, 8],
] as const;

const OPERATOR_CANVAS_W = 160; // 8 + 64 + 16 + 64 + 8
const OPERATOR_CANVAS_H = 144; // 8 + 128 + 8 (the taller, grown drawing)

// --- Surface (b): belt corner sheet, VECTOR (RENDER-02 / FEEL-02) ----------
//
// RE-POINTED BY PLAN 61-07 AT THE GEOMETRY IT NOW GUARDS. Until this plan the surface
// composed eight raster corner bakes (2 chiralities x the locked K = 4 march phases)
// into a PNG-data-URL <img image-rendering:pixelated>. Plan 61-03 made
// the belt layer fully vector, so from that point the sheet pinned bytes that no user
// could see; plan 61-07 deleted the bake outright. Retaining the bake purely to feed
// this tool was REJECTED and the rejection is worth stating: it would have left dead
// pixel code alive with a live committed baseline, which is the exact outcome this
// phase exists to remove. A tool called the pixel guard should track the thing it
// guards (`61-CONTEXT.md` H4, which rules this route).
//
// WHAT IT DRAWS NOW: the SHIPPED corner, through the SHIPPED painter - the tread
// context at a march bucket plus the corner RAIL context at quantum 1 (the rails left
// the tread contexts in plan 61-09, so a corner drawn without them would not be the
// corner the layer composes). Both chiralities, because a 90-degree whole-sprite
// rotation reaches only 4 of the 8 (from,to) corners and the x-mirror covers the other
// 4 - the asymmetry that let F2a escape a single-chirality gate.
//
// THE PHASE WALK IS NOT REPRODUCED AT K = 12. The old sheet enumerated the FULL raster
// phase space because K was 4 and the whole space fit; at the split-knob K = 12 the
// equivalent sheet would be 24 tiles, and every one of those 12 buckets is already
// pinned exactly - vertex for vertex - by `synth/beltGeometry.digest.test.ts`'s 39-slot
// committed table. This surface samples THREE buckets evenly across the lattice, which
// is what a PIXEL gate adds that a geometry digest cannot: evidence that the march
// reaches real rasterised pixels at all, and that it moves between them.
const CORNER_TILE = CELL; // 32 - the tile the geometry is authored on
const CORNER_GUTTER = 2; // substrate px between tiles
/** Buckets sampled across the K = 12 lattice: entry, third, two-thirds. */
const CORNER_BUCKETS = [0, 4, 8] as const;
const CORNER_CHIRALITIES = ['cw', 'ccw'] as const;
const CORNER_STRIDE = CORNER_TILE + CORNER_GUTTER; // 34px tile-to-tile offset
const CORNER_CANVAS_W = CORNER_BUCKETS.length * CORNER_TILE + (CORNER_BUCKETS.length - 1) * CORNER_GUTTER; // 100
const CORNER_CANVAS_H =
  CORNER_CHIRALITIES.length * CORNER_TILE + (CORNER_CHIRALITIES.length - 1) * CORNER_GUTTER; // 66
/**
 * The device quantum the corner rails are built at.
 *
 * 1 exactly, and stated rather than derived: the spec pins `deviceScaleFactor` 1 and
 * the Pixi resolution below is pinned to 1, so the fixture's device quantum IS 1 and a
 * rail family built at any other value would draw a band this canvas cannot show.
 */
const CORNER_QUANTUM = 1;

// --- Surface (c): wire reply comet mid-sweep (RENDER-03) --------------------
// Fixed render-clock freeze. VISUAL_HOP_TICKS = 28 in the wire layer, so a latch at
// T0 then a draw at T0 + 14 lands the comet at frac 14/28 = 0.5 (mid-cable). These
// are RENDER-CLOCK values handed to the layer draw, never scene.tick.
const COMET_T0 = 100;
const COMET_HALF_SWEEP = 14; // 14 / VISUAL_HOP_TICKS(28) = frac 0.5
const COMET_CANVAS_W = 192; // 6 cells at CELL 32: docked endpoint + 4 wire cells + handler
const COMET_CANVAS_H = 32;
const DIR_REPLY = 1; // WirePulseView.direction: 0 = FORWARD, 1 = REPLY

// --- Surface (c2): wire-vs-world occlusion (WIRE-02 / gate E6, plan 66-05) --
//
// The scene (its machines, belt row and wires, and the design notes saying why each is
// there) lives in `./occlusionScene.ts` since plan 75-04, so `occlusionScene.test.ts` can
// read the same board this surface draws. The drawing stays below, in the one async
// entry point.

// --- Surface (c3): the 72-16 union-box perimeter RING -----------------------
//
// THE FINDING THIS SURFACE EXISTS FOR, measured rather than assumed: before it, NO pixel
// or visual gate in this repository could see the go-around shape at all.
//   - occlusion wire A, (0,1)E -> (6,4)W, has `leave_x` and `arrive_x` true;
//   - occlusion wire B, (9,4)W -> (2,0)S, has `leave_x` and `arrive_y` true;
//     so both decline at the ring's D2 gate and neither baseline can move.
//   - surface (c)'s comet path is HAND-AUTHORED (`path: [straight(1,0), ...]`) and never
//     calls `wireRoute` at all, so it cannot move either.
// A change to `ring_index`, to the ring's terminal runs, or to `clampEndToNub` would
// therefore have shipped without moving one committed pixel.
//
// THE BOARD is 72-16-DESIGN section 6 example A, shifted by (+2, +2) so nothing needs a
// negative cell: a 1x1 Route at (2,2) and a 3x3 Handler anchored (5,1). The Route carries
// In on W and Out on E at its own cell; the Handler carries In at world (5,2) W and Out at
// world (7,2) E. Two wires, the real pair:
//   - the REQUEST, Route.Out (2,2)E -> Handler.In (5,2)W. `leave_x` is true, D2 declines,
//     and this is the FOUR-cell face-aligned run it has been since 72-15. It is here so a
//     reader can see that the fix did not move it.
//   - the REPLY, Handler.Out (7,2)E -> Route.In (2,2)W. `sx` is -1 while `f` and `nt` both
//     point east, so all four admissibility booleans are false and the RING fires: 14
//     cells, out of the Handler's east socket, down the outside of its east wall, west
//     along the clear row one below both machines, up the outside of the Route's west
//     wall, and east into the Route's west socket. This is J-7's cable.
// Both wires are IDLE: no pulse, so nothing on this canvas moves and the baseline holds
// `maxDiffPixels: 0` with the other byte-exact surfaces.
const GOAROUND_CELLS_W = 10;
const GOAROUND_CELLS_H = 6;
const GOAROUND_CANVAS_W = GOAROUND_CELLS_W * CELL; // 320
const GOAROUND_CANVAS_H = GOAROUND_CELLS_H * CELL; // 192

/**
 * The routed path between two named PORTS, through the byte-pinned TS mirror.
 *
 * `occlusionPath` above takes `ports[0]` on each side, which cannot express this board:
 * both machines here carry TWO ports and the pair is Out-to-In in one direction and
 * Out-to-In in the other. Never hand-authored, for the reason stated at the top of this
 * file: a hand-authored path reproduces neither the lane offset nor the end clamp.
 */
function goaroundPath(from: NodeView, fromPort: number, to: NodeView, toPort: number): TileView[] {
  const a = from.ports[fromPort];
  const b = to.ports[toPort];
  const r = wireRoute(
    { cell: [a.cell_x, a.cell_y], side: a.side, body: bodyOfNode(from) },
    { cell: [b.cell_x, b.cell_y], side: b.side, body: bodyOfNode(to) },
  );
  if (!r.ok) throw new Error('the go-around fixture route was rejected: the fixture is wrong');
  return r.geometry.tiles;
}

function goaroundScene(): ReturnType<typeof createSceneState> {
  const scene = createSceneState();
  const route: NodeView = {
    id: 20,
    kind: machine_kind.ENDPOINT,
    cell_x: 2,
    cell_y: 2,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [
      { index: 0, cell_x: 2, cell_y: 2, side: 3, role: 0, medium: 1 },
      { index: 1, cell_x: 2, cell_y: 2, side: 1, role: 1, medium: 1 },
    ],
    load: 0,
  } as NodeView;
  const handler: NodeView = {
    id: 21,
    kind: machine_kind.FACTORY,
    cell_x: 5,
    cell_y: 1,
    state: 0,
    w: 3,
    h: 3,
    rot: 0,
    ports: [
      { index: 0, cell_x: 5, cell_y: 2, side: 3, role: 0, medium: 1 },
      { index: 1, cell_x: 7, cell_y: 2, side: 1, role: 1, medium: 1 },
    ],
    load: 0,
  } as NodeView;
  scene.nodes.set(route.id, route);
  scene.nodes.set(handler.id, handler);

  scene.wires.set(1, {
    id: 1,
    from: { node: 20, port: 1 },
    to: { node: 21, port: 0 },
    path: goaroundPath(route, 1, handler, 0),
    pulses: [],
  } as WireView);
  scene.wires.set(2, {
    id: 2,
    from: { node: 21, port: 1 },
    to: { node: 20, port: 0 },
    path: goaroundPath(handler, 1, route, 0),
    pulses: [],
  } as WireView);
  return scene;
}

// --- Surface (d): the vector pilot at 1x / 2x / 1.77x (VEC-03) --------------
// Canvas size and the three placements are locked by 56-UI-SPEC Part D.3. The
// 32-unit asset occupies 32px at scale 1, 64px at scale 2 and ~57px at 1.77, so
// 192 x 72 clears all three with the 8/4px margins below and no clipping.
const PILOT_CANVAS_W = 192;
const PILOT_CANVAS_H = 72;

/**
 * [scale, x, y] per drawing. scale 1.77 is VEC-01's named 177% case: it lands the
 * geometry on FRACTIONAL device pixels on purpose. With antialias off the
 * rasteriser snaps each edge to a whole pixel, so "crisp" here means NO SOFT
 * EDGE - never "edge at the ideal position". The committed baseline holds
 * whatever that snapping produces; a reviewer expecting sub-pixel accuracy will
 * misread it as a defect.
 */
const PILOT_PLACEMENTS = [
  [1, 8, 8],
  [2, 48, 4],
  [1.77, 120, 8],
] as const;

// --- Surface (e): belt rail continuity (BELT-05, plan 61-09) ----------------
//
// THE SIX CAMERA SCALES ARE THE MEASUREMENT'S OWN, not a fresh choice. 0.75 is the belt
// LOD cut (`belts.ts LOD_MIN_TREAD_PX` 24 / CELL 32), so it is the LOWEST zoom at which
// the full-detail tread is selected; 1.00 is the identity. Between them lie the four
// scales the 2026-08-10 measurement recorded, at which the pre-fix vector belt lost a
// whole rail or grew interior gap columns.
const RAIL_SCALES: readonly number[] = [0.75, 0.8, 0.85, 0.9, 0.95, 1];

/**
 * The camera's MINIMUM-ZOOM CLAMP, mirrored from `belts.ts MIN_SCALE`.
 *
 * Probed once, outside the six gate scales, to MEASURE the one hazard the device rule
 * deliberately cannot reach: at DPR 1 this quantum makes the 2 world px tread band half
 * a device pixel, and a band narrower than one device pixel may contain no pixel centre
 * at all. Below the LOD cut it is the bold tick's band, which is what a player actually
 * sees at that zoom.
 */
const RAIL_MIN_ZOOM_CLAMP = 0.25;

/**
 * How many tiles the probed run is.
 *
 * TEN, because the defect is a SEAM defect and a seam needs neighbours: a single tile
 * can lose its rail without any gap column existing, and a two-tile run has exactly one
 * boundary to be lucky at. Ten gives nine boundaries at every scale. It is also the run
 * length the 2026-08-10 measurement used, so the column counts are comparable to it
 * row for row.
 */
const RAIL_TILES = 10;

/** One rail band's continuity, as counts. No image, no threshold, no eyeball. */
interface RailBandReport {
  /** Whether the band was drawn ANYWHERE across the run. */
  readonly present: boolean;
  /** The device rows the band actually occupies. */
  readonly rows: readonly number[];
  /** How many device columns carry the band. */
  readonly columns: number;
  /** The canvas width in device columns, so `columns` reads as a fraction. */
  readonly total: number;
  /** Uncovered columns strictly BETWEEN the first and last covered one. */
  readonly gaps: number;
}

/**
 * One tile-to-tile JOIN, probed on both rail lanes.
 *
 * WHY A BENT RUN NEEDS A DIFFERENT PROBE FROM A STRAIGHT ONE. On a straight run the
 * rails are two horizontal bands and "no gap columns" is a column count over the whole
 * canvas. Through a bend the rails are ARCS, so most columns of a corner cell carry no
 * ink on the straight's rows by construction and a whole-canvas count would report a
 * gap that is not one. The defect being gated is a SEAM defect, so the probe is the
 * seam: a three-device-pixel window centred on each join, on each lane, which must be
 * fully inked. The corner-to-corner join is the hard case - no straight neighbour
 * overhangs it - and it is exactly what the swept-extension term exists for.
 */
interface SeamReport {
  /** The upstream tile's index in the run. */
  readonly index: number;
  /** Which axis flow runs along at this join. */
  readonly flow: 'x' | 'y';
  /** Inked device pixels of the 3-wide window, on the negative-normal lane. */
  readonly laneA: number;
  /** Inked device pixels of the 3-wide window, on the positive-normal lane. */
  readonly laneB: number;
  /** The window size, so `laneA === window` reads as full coverage. */
  readonly window: number;
}

/** One probed drawing: a run, at a scale, under the shipped or the control rails. */
interface RailReport {
  readonly run: string;
  readonly scale: number;
  readonly variant: 'shipped' | 'control';
  readonly width: number;
  readonly height: number;
  /** Whole-canvas band continuity. Present only for a run that is one cell row deep. */
  readonly north: RailBandReport | null;
  readonly south: RailBandReport | null;
  /**
   * The TREAD band on the tile centreline, measured on the same terms as the rails.
   *
   * It is here for ONE reason: the 2 world px tread band is at least one device pixel
   * wide only while the quantum is at or above 0.5, and the camera's minimum-zoom clamp
   * allows 0.25 at DPR 1. The device rule deliberately does not reach the tread - the
   * tread lives inside the SCALE-FREE cached contexts and applying the rule to it would
   * make that geometry scale-dependent, which is the property this whole plan exists to
   * preserve. So the hazard is MEASURED and RAISED rather than silently carried.
   */
  readonly tread: RailBandReport | null;
  /** Per-join seam windows. Present for EVERY run, straight and bent alike. */
  readonly seams: SeamReport[];
}

/**
 * THE CONTROL PAINTER: the shipped record with its rail methods called at quantum 1.
 *
 * Not a copy of the pre-fix code and deliberately not one. The device rule takes its
 * identity values at every whole quantum, so `rails(skin, 1)` IS the pre-fix geometry,
 * byte for byte - which means the control cannot drift away from its subject as a
 * transcribed snapshot inevitably would. The `id` differs so the two painters cannot
 * serve each other's geometry out of a cache.
 */
const CONTROL_PAINTER: BeltPainter = Object.freeze({
  ...SHIPPED_PAINTER,
  id: 'rail-control-q1',
  rails: (skin: typeof LOCKED_SKIN, _quantum: number) => SHIPPED_PAINTER.rails(skin, 1),
  cornerRails: (skin: typeof LOCKED_SKIN, _quantum: number, chirality: 'cw' | 'ccw') =>
    SHIPPED_PAINTER.cornerRails(skin, 1, chirality),
  cornerRailTick: (skin: typeof LOCKED_SKIN, _quantum: number, chirality: 'cw' | 'ccw') =>
    SHIPPED_PAINTER.cornerRailTick(skin, 1, chirality),
} satisfies BeltPainter);

/** A straight belt tile at (cx, cy) running along x. */
const beltStraight = (cx: number, cy: number): TileView =>
  ({ cell_x: cx, cell_y: cy, kind: { Straight: { axis: 0 } } }) as TileView;

/** A corner belt tile at (cx, cy), flow entering heading `from` and leaving `to`. */
const beltCorner = (cx: number, cy: number, from: number, to: number): TileView =>
  ({ cell_x: cx, cell_y: cy, kind: { Corner: { from, to } } }) as TileView;

/**
 * The probed runs, by name. Cardinals are N=0, E=1, S=2, W=3.
 *
 *   straight  ten tiles, nine straight-to-straight joins. The run the 2026-08-10
 *             measurement used, so its column counts are comparable to it row for row.
 *   bend      straight -> corner -> straight, i.e. BOTH mixed joins, which is what a
 *             real lane is made of.
 *   sbend     two corners with NOTHING between them. The hard case: no straight
 *             neighbour overhangs that join, so it is closed entirely by the corner
 *             emitter's own swept extension.
 */
function railRuns(): Record<string, TileView[]> {
  const straightRun: TileView[] = [];
  for (let i = 0; i < RAIL_TILES; i++) straightRun.push(beltStraight(i, 0));
  return {
    straight: straightRun,
    // E along row 0, turn S at (2,0), then S down column 2.
    bend: [
      beltStraight(0, 0),
      beltStraight(1, 0),
      beltCorner(2, 0, 1, 2),
      beltStraight(2, 1),
      beltStraight(2, 2),
    ],
    // E along row 0, turn S at (2,0), turn W at (2,1), then W along row 1.
    sbend: [
      beltStraight(0, 0),
      beltStraight(1, 0),
      beltCorner(2, 0, 1, 2),
      beltCorner(2, 1, 2, 3),
      beltStraight(1, 1),
      beltStraight(0, 1),
    ],
  };
}

/** Wrap a tile run into a one-belt, undocked, static scene. */
function beltScene(tiles: TileView[]): ReturnType<typeof createSceneState> {
  const scene = createSceneState();
  scene.belts.set(1, {
    id: 1,
    latency: 60,
    fill: 0,
    items: [],
    tiles,
    docks: [],
    // SLOT-03: appended LAST after `docks`; the identity interval. Cast-hidden from
    // tsc, so added deliberately rather than by compiler prompt.
    ticks_per_slot: 1,
  } as unknown as BeltView);
  return scene;
}

/**
 * Measure one rail band's continuity from raw RGBA device pixels.
 *
 * A pixel counts as INKED on alpha alone. The rail and the tread resolve to the SAME
 * ramp step (`BELT_INK.railRamp` and `.inkRamp` are both 4), so colour cannot
 * separate them and the separation is by ROW instead: the tread band is a 2 world px
 * strip on the tile centreline, so the rows within `q` device px of the snapped centre
 * are excluded and everything above / below that is the band being measured.
 */
function measureRailBand(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  rowsOf: (y: number) => boolean,
): RailBandReport {
  const covered: boolean[] = new Array(width).fill(false);
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    if (!rowsOf(y)) continue;
    let any = false;
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > 0) {
        covered[x] = true;
        any = true;
      }
    }
    if (any) rows.push(y);
  }
  const columns = covered.filter(Boolean).length;
  const first = covered.indexOf(true);
  const last = covered.lastIndexOf(true);
  let gaps = 0;
  if (first >= 0) for (let x = first; x <= last; x++) if (!covered[x]) gaps++;
  return { present: columns > 0, rows, columns, total: width, gaps };
}

/**
 * Probe every tile-to-tile join of a run for rail continuity ACROSS the seam.
 *
 * The join's flow axis comes from which snapped device centre coordinate moved; the
 * ACROSS-flow coordinate is shared by both tiles, so the two lanes sit near `C - d` and
 * `C + d - t` device px from it - the two device offsets the straight's bands and the
 * corner's arcs both take at their tangent points, which is the whole reason a straight
 * and a corner can abut at all.
 *
 * **THE LANE IS SEARCHED, NOT ASSUMED, ACROSS A +/-2 DEVICE PX BAND.** The probe must
 * measure CONTINUITY ALONG FLOW and nothing else, so it must not also fail a control
 * whose lane merely sits on a neighbouring row - otherwise a failing control would be
 * reported for the wrong reason and the gate's own evidence would be muddled. The band
 * is far narrower than the ~8-10 device px from the centreline to either rail at these
 * scales, so it can reach neither the tread band nor the other rail.
 *
 * The window is THREE device pixels centred on the join, so the probe fails on a gap
 * that is only one pixel wide - which is exactly the size the measured gaps were.
 */
function measureSeams(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tiles: TileView[],
  scale: number,
  d: number,
  t: number,
): SeamReport[] {
  const SEARCH = 2;
  const inked = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && pixels[(y * width + x) * 4 + 3] > 0;
  // The SNAPPED device centre of a tile - `belts.ts` runs every tile position through
  // `snapToDevicePixel` at this quantum, so this is where the tile actually is.
  const centre = (tile: TileView): { x: number; y: number } => ({
    x: Math.round((tile.cell_x * CELL + CELL / 2) * scale),
    y: Math.round((tile.cell_y * CELL + CELL / 2) * scale),
  });
  const WINDOW = 3;
  const out: SeamReport[] = [];
  for (let i = 0; i < tiles.length - 1; i++) {
    const a = centre(tiles[i]);
    const b = centre(tiles[i + 1]);
    const flow: 'x' | 'y' = a.x !== b.x ? 'x' : 'y';
    const along = flow === 'x' ? Math.round((a.x + b.x) / 2) : Math.round((a.y + b.y) / 2);
    const across = flow === 'x' ? a.y : a.x;
    const count = (offset: number): number => {
      let n = 0;
      for (let k = -(WINDOW >> 1); k <= WINDOW >> 1; k++) {
        let hit = false;
        for (let s = -SEARCH; s <= SEARCH && !hit; s++) {
          const x = flow === 'x' ? along + k : across + offset + s;
          const y = flow === 'x' ? across + offset + s : along + k;
          if (inked(x, y)) hit = true;
        }
        if (hit) n++;
      }
      return n;
    };
    out.push({ index: i, flow, laneA: count(-d), laneB: count(d - t), window: WINDOW });
  }
  return out;
}


/**
 * Build the synthetic one-wire scene: a 4-tile straight electrical wire carrying a
 * single REPLY pulse, DOCKED at both ends to real NodeViews (FEEL-04). The docks now
 * resolve: node 10 is a kind-9 ENDPOINT (E-facing port at cell (0,0)) and node 11 a
 * kind-2 handler (W-facing port at cell (5,0)), so the surface exercises the wires.ts
 * kind-9 inlet-glyph branch at one terminal AND the plain handler square at the
 * other. This is the harden-in-content discipline: the guarded baseline must WITNESS
 * the glyph so a future glyph regression flips the gate instead of escaping it.
 */
function wireScene(): ReturnType<typeof createSceneState> {
  const scene = createSceneState();
  const endpoint: NodeView = {
    id: 10,
    kind: machine_kind.ENDPOINT,
    cell_x: 0,
    cell_y: 0,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 0, cell_y: 0, side: 1, role: 1, medium: 1 }],
    load: 0,
  };
  const handler: NodeView = {
    id: 11,
    kind: machine_kind.FACTORY,
    cell_x: 5,
    cell_y: 0,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 5, cell_y: 0, side: 3, role: 0, medium: 1 }],
    load: 0,
  };
  scene.nodes.set(endpoint.id, endpoint);
  scene.nodes.set(handler.id, handler);
  const wire: WireView = {
    id: 1,
    from: { node: 10, port: 0 },
    to: { node: 11, port: 0 },
    path: [straight(1, 0), straight(2, 0), straight(3, 0), straight(4, 0)],
    pulses: [{ entry_tick: 0, hop_ticks: 1, direction: DIR_REPLY }],
  };
  scene.wires.set(wire.id, wire);
  return scene;
}

// --- Surface (f): the cable and its re-route mark at MIN_ZOOM (plan 75-10) ---
// See the header. Everything here is the measurement; the drawing is the real wire layer.

/** The camera's minimum zoom, read from the camera rather than restated. */
const CABLE_MIN_ZOOM = MIN_ZOOM;

/**
 * The 16 camera origins, in DEVICE px, on each axis. At 0.25 every cell centre lands on a
 * whole device pixel (16 x 0.25 = 4) and the lane puts the cable half a device pixel off
 * it, so a half-pixel strip covers a pixel centre at one origin and none at the origin half
 * a pixel over. ONE camera position would therefore pass or fail by luck; the sweep is the
 * only honest read.
 */
const CABLE_ORIGINS: readonly number[] = [0, 0.25, 0.5, 0.75];

/** The scene's extent in cells: the routed wire spans x 1..7 and y 1..6. */
const CABLE_SCENE_CELLS_W = 9;
const CABLE_SCENE_CELLS_H = 8;

/**
 * How far either side of the cable's line, in device px, a pixel still counts as the
 * cable's ink. Wide enough to absorb any rasteriser's choice of which pixel a centred
 * one-pixel strip lands on, far narrower than a cell (8 device px at 0.25), so it can
 * reach no other run.
 */
const CABLE_SEARCH = 2;

/** One straight run of the drawn cable, walked along its axis at one drawing. */
interface CableRunReport {
  /** The axis the run travels along: 'x' for a horizontal run, 'y' for a vertical one. */
  readonly axis: 'x' | 'y';
  /** Device positions walked along the run (one cell skipped at each end). */
  readonly positions: number;
  /** Positions with no ink within CABLE_SEARCH device px across of the line. */
  readonly gaps: number;
}

/** One drawing of surface (f): one origin, one variant, one state. */
interface CableMinZoomReport {
  readonly ox: number;
  readonly oy: number;
  readonly variant: 'shipped' | 'control';
  readonly state: 'rest' | 'marked';
  readonly runs: CableRunReport[];
}

/**
 * The scene: two 1x1 electrical machines and ONE wire routed by `wireRoute` (never
 * hand-authored, for the reason the go-around surface records). The source port is at
 * (1,1) facing S and the target port at (7,6) facing W. PINNED, measured on 2026-10-06:
 * the router returns the cells (1,1) (1,2) (1,3) (1,4) (1,5) (1,6) (2,6) (3,6) (4,6)
 * (5,6) (6,6) (7,6), lane +1, so the drawn line is a vertical run at x 50 from y 64.5
 * to 210 and a horizontal run at y 210 from x 50 to 223.5 (world px). Two straight runs,
 * one on each axis, each more than four cells long.
 */
function cableMinZoomScene(marked: boolean): ReturnType<typeof createSceneState> {
  const scene = createSceneState();
  const source: NodeView = {
    id: 30,
    kind: machine_kind.FACTORY,
    cell_x: 1,
    cell_y: 1,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 1, cell_y: 1, side: 2, role: 1, medium: 1 }],
    load: 0,
  } as NodeView;
  const target: NodeView = {
    id: 31,
    kind: machine_kind.FACTORY,
    cell_x: 7,
    cell_y: 6,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 7, cell_y: 6, side: 3, role: 0, medium: 1 }],
    load: 0,
  } as NodeView;
  scene.nodes.set(source.id, source);
  scene.nodes.set(target.id, target);
  scene.wires.set(1, {
    id: 1,
    from: { node: 30, port: 0 },
    to: { node: 31, port: 0 },
    path: goaroundPath(source, 0, target, 0),
    pulses: [],
  } as WireView);
  // MARKED: the wire's path changed at generation 1. Drawn with markClock 0 on a fresh
  // layer, so the mark is at its first frame and alpha 1.
  if (marked) scene.wireReroutes.set(1, 1);
  return scene;
}

/**
 * The drawn line's straight runs, in WORLD px, from the SAME builder the wire layer
 * strokes (`cablePoints`: cell centres displaced into the lane, ends clamped onto the
 * nubs). Consecutive collinear segments are merged, so a run is a whole straight leg.
 */
function cableRuns(
  scene: ReturnType<typeof createSceneState>,
): Array<{ axis: 'x' | 'y'; across: number; lo: number; hi: number }> {
  const wire = scene.wires.get(1) as WireView;
  const end = (dock: { node: number; port: number }) => {
    const p = (scene.nodes.get(dock.node) as NodeView).ports[dock.port];
    return nubEndAt(p.cell_x, p.cell_y, p.side);
  };
  const pts = cablePoints(wire.path, cableLane(wire.path), {
    from: end(wire.from),
    to: end(wire.to),
  });
  const runs: Array<{ axis: 'x' | 'y'; across: number; lo: number; hi: number }> = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const axis: 'x' | 'y' = a.y === b.y ? 'x' : 'y';
    const across = axis === 'x' ? a.y : a.x;
    const lo = Math.min(axis === 'x' ? a.x : a.y, axis === 'x' ? b.x : b.y);
    const hi = Math.max(axis === 'x' ? a.x : a.y, axis === 'x' ? b.x : b.y);
    const last = runs[runs.length - 1];
    if (last && last.axis === axis && last.across === across) {
      last.lo = Math.min(last.lo, lo);
      last.hi = Math.max(last.hi, hi);
    } else {
      runs.push({ axis, across, lo, hi });
    }
  }
  return runs;
}

/**
 * Walk one straight run in device px and count the positions with no ink near its line.
 *
 * One whole cell is skipped at each end of the run, so a corner, a round cap, a nub or a
 * prong can never stand in for the cable. At every device pixel along the run whose
 * centre lies in what is left, the pixels within {@link CABLE_SEARCH} device px across of
 * the line (the world line scaled by the zoom and shifted by the camera origin) are read;
 * none inked is a gap. `inked` reads the RGBA read-back at a byte offset; it carries the
 * state's colour rule (any coverage at rest, the build accent when marked).
 */
function measureCableRun(
  width: number,
  height: number,
  run: { axis: 'x' | 'y'; across: number; lo: number; hi: number },
  ox: number,
  oy: number,
  inked: (i: number) => boolean,
): CableRunReport {
  const z = CABLE_MIN_ZOOM;
  const oAlong = run.axis === 'x' ? ox : oy;
  const oAcross = run.axis === 'x' ? oy : ox;
  const from = (run.lo + CELL) * z + oAlong;
  const to = (run.hi - CELL) * z + oAlong;
  const line = run.across * z + oAcross;
  let positions = 0;
  let gaps = 0;
  for (let t = Math.floor(from); t <= Math.ceil(to); t++) {
    if (t + 0.5 < from || t + 0.5 > to) continue;
    positions++;
    let hit = false;
    for (let c = Math.floor(line - CABLE_SEARCH); c <= Math.ceil(line + CABLE_SEARCH) && !hit; c++) {
      if (Math.abs(c + 0.5 - line) > CABLE_SEARCH) continue;
      const x = run.axis === 'x' ? t : c;
      const y = run.axis === 'x' ? c : t;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (inked((y * width + x) * 4)) hit = true;
    }
    if (!hit) gaps++;
  }
  return { axis: run.axis, positions, gaps };
}

// --- Surface (g): every machine kind, a faulted Factory and Sink, a working Factory ---
//
// GATE-05 (plan 92-06, D-11, WINDOWS 19 and 28). Until this surface only the Factory and
// the Route were pictured through the shipped machine layer (on the two wire surfaces),
// the Router only through primitives and with no nubs, and every one of them IDLE. A
// regression in any other kind's art, in the alert ring, in the fault outline, in the
// fault nub or in the working notch reddened no committed pixel: measured at the phase's
// start revision, deleting one `<path>` from `source.svg`, making `drawAlertRing` a no-op
// and changing `LABEL_FILL_ALPHA` each left every pixel-guard baseline green.
//
// WHAT IT DRAWS: the REAL `createMachineLayer(LOCKED_SKIN, () => 1)`, one Application,
// over one node per slot built from `catalogEntry(kind)` (the footprint and the port list
// the placement ghost and the host use, local port cells translated by the node's origin
// at rot 0). No grid, no belts, no wires. Each slot is the machine's footprint plus one
// empty cell on every side, so the nubs, the alert ring and the working notch fall inside
// the slot, and each slot is screenshot on its own through a transparent clip div
// (`data-kind-cell`), so a broken kind reddens its own PNG and no other.
//
// THE FAULTED SINK SITS AT (8, 10), NOT (4, 10) (92-RESEARCH Finding F). The ring's alpha
// is `faultBlinkAlpha(frame + phaseOffset(cell))`, and ONE frame is drawn for every node,
// so the two faulted machines must share a phase for both rings to be at their peak in
// the same picture. (11, 1) and (8, 10) both hash to phase 0; (4, 10) hashes to 20, and no
// frame puts both rings at 0.75 or more. The fixture still SEARCHES for the frame rather
// than hard-coding 3, and publishes both alphas read back off the drawn rings, so a future
// phase change cannot silently picture the ring at its 0.25 floor.
const KINDS_CANVAS_W = 24 * CELL; // 768
const KINDS_CANVAS_H = 12 * CELL; // 384
/** The highest frame the peak search tries (the UI-SPEC 5.1 bound; the cadence is 24 frames). */
const KINDS_FRAME_SEARCH_MAX = 600;
/** The ring alpha both faulted machines must reach in the pictured frame (the peak is 0.80). */
const KINDS_RING_ALPHA_MIN = 0.75;

interface KindSlot {
  /** The baseline name, `<name>.png`, and the clip div's `data-kind-cell`. */
  readonly name: string;
  readonly kind: number;
  readonly state: number;
  /** The slot rectangle in cells: the footprint plus one empty cell on every side. */
  readonly slot: readonly [x: number, y: number, w: number, h: number];
  /** The machine's origin cell. */
  readonly at: readonly [x: number, y: number];
}

/** The UI-SPEC 5.1 table, with Finding F's faulted Sink slot. */
const KIND_SLOTS: readonly KindSlot[] = [
  { name: 'kind-factory', kind: machine_kind.FACTORY, state: state_tag.IDLE, slot: [0, 0, 5, 5], at: [1, 1] },
  { name: 'kind-http-handler', kind: machine_kind.HANDLER, state: state_tag.IDLE, slot: [5, 0, 5, 5], at: [6, 1] },
  { name: 'state-faulted-factory', kind: machine_kind.FACTORY, state: state_tag.FAULTED, slot: [10, 0, 5, 5], at: [11, 1] },
  { name: 'state-working-factory', kind: machine_kind.FACTORY, state: state_tag.WORKING, slot: [15, 0, 5, 5], at: [16, 1] },
  { name: 'kind-router', kind: machine_kind.ROUTER, state: state_tag.IDLE, slot: [20, 0, 4, 5], at: [21, 1] },
  { name: 'kind-tee', kind: machine_kind.TEE, state: state_tag.IDLE, slot: [0, 5, 4, 4], at: [1, 6] },
  { name: 'kind-balancer', kind: machine_kind.BALANCER, state: state_tag.IDLE, slot: [4, 5, 4, 4], at: [5, 6] },
  { name: 'kind-merge', kind: machine_kind.MERGE, state: state_tag.IDLE, slot: [8, 5, 4, 4], at: [9, 6] },
  { name: 'kind-label', kind: machine_kind.LABEL, state: state_tag.IDLE, slot: [12, 5, 6, 3], at: [13, 6] },
  { name: 'kind-source', kind: machine_kind.SOURCE, state: state_tag.IDLE, slot: [18, 5, 3, 3], at: [19, 6] },
  { name: 'kind-sink', kind: machine_kind.SINK, state: state_tag.IDLE, slot: [21, 5, 3, 3], at: [22, 6] },
  { name: 'kind-route', kind: machine_kind.ENDPOINT, state: state_tag.IDLE, slot: [0, 9, 3, 3], at: [1, 10] },
  { name: 'state-faulted-sink', kind: machine_kind.SINK, state: state_tag.FAULTED, slot: [7, 9, 3, 3], at: [8, 10] },
];

/** One node per slot, from the shipped catalog: its box, its ports at world cells, rot 0. */
function kindsScene(): ReturnType<typeof createSceneState> {
  const scene = createSceneState();
  KIND_SLOTS.forEach((s, i) => {
    const entry = catalogEntry(s.kind);
    const [x, y] = s.at;
    const node: NodeView = {
      id: 100 + i,
      kind: s.kind,
      cell_x: x,
      cell_y: y,
      state: s.state,
      w: entry.w,
      h: entry.h,
      rot: 0,
      ports: entry.ports.map((p) => ({
        index: p.index,
        cell_x: x + p.local_x,
        cell_y: y + p.local_y,
        side: p.side,
        role: p.role,
        medium: p.medium,
      })),
      load: 0,
      // The default colour byte (Sand) the host mints for a new label; null on a machine.
      label: s.kind === machine_kind.LABEL ? { text: '', colour: 0 } : null,
    };
    scene.nodes.set(node.id, node);
  });
  return scene;
}

/** The first frame at which every FAULTED slot's ring is at least `KINDS_RING_ALPHA_MIN`, or -1. */
function kindsPeakFrame(): number {
  const faulted = KIND_SLOTS.filter((s) => s.state === state_tag.FAULTED);
  for (let f = 0; f <= KINDS_FRAME_SEARCH_MAX; f++) {
    if (faulted.every((s) => alertRingAlpha(f, s.at[0], s.at[1]) >= KINDS_RING_ALPHA_MIN)) return f;
  }
  return -1;
}

// --- Build the DOM ----------------------------------------------------------
const root = document.getElementById('pixel-guard-root') as HTMLElement;
root.style.background = substrate;

/** Create one labelled surface container holding a single locatable element. */
function surface(id: string): HTMLDivElement {
  const box = document.createElement('div');
  box.id = id;
  box.style.background = substrate;
  box.style.display = 'inline-block';
  box.style.lineHeight = '0'; // no descender gap around the inline img/canvas
  box.style.margin = '8px';
  return box;
}

const operatorBox = surface('surface-operator');
root.appendChild(operatorBox);
const beltCornerBox = surface('surface-belt-corner');
root.appendChild(beltCornerBox);
const cometBox = surface('surface-wire-comet');
root.appendChild(cometBox);
const occlusionBox = surface('surface-wire-occlusion');
occlusionBox.style.display = 'block'; // 320px wide: give it its own row
root.appendChild(occlusionBox);
const goaroundBox = surface('surface-wire-goaround');
goaroundBox.style.display = 'block'; // 320px wide: give it its own row
root.appendChild(goaroundBox);
const pilotBox = surface('surface-vector-pilot');
root.appendChild(pilotBox);
const railBox = surface('surface-belt-rail');
railBox.style.display = 'block'; // one row of canvases per probed drawing
root.appendChild(railBox);
const cableBox = surface('surface-cable-min-zoom');
root.appendChild(cableBox);
// One block of its own: the clip divs are positioned over the canvas, so the box is the
// canvas's exact size and their containing block.
const kindsBox = surface('surface-machine-kinds');
kindsBox.style.display = 'block';
kindsBox.style.position = 'relative';
kindsBox.style.width = `${KINDS_CANVAS_W}px`;
kindsBox.style.height = `${KINDS_CANVAS_H}px`;
root.appendChild(kindsBox);

// A readout element the spec waits on: data-fixture-ready="1" is set only after every
// surface has painted - one Pixi frame rendered for each canvas surface. The belt
// corner joined that list in plan 61-07 when it stopped being a decoded <img>.
const readout = document.createElement('div');
readout.id = 'pixel-guard-readout';
readout.style.display = 'none';
root.appendChild(readout);

const markReady = (): void => {
  readout.setAttribute('data-fixture-ready', '1');
};

/**
 * Read the LIVE antialias state off one canvas's own WebGL context attributes
 * (VEC-03). Re-requesting the same context type returns the ALREADY-CREATED
 * context, so `getContextAttributes()` reports what the GL driver actually
 * built - a strictly stronger claim than reading the `antialias: false` option
 * Pixi was handed, which would still read "off" on a driver that ignored it.
 *
 * Returns FALSE (i.e. "not proven off") when no context or no attributes can be
 * read, so a missing context reddens the gate instead of passing over nothing.
 */
function antialiasOff(canvas: HTMLCanvasElement): boolean {
  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as
    | WebGLRenderingContext
    | null;
  if (gl === null) return false;
  const attrs = gl.getContextAttributes();
  if (attrs === null) return false;
  return attrs.antialias === false;
}

// Boot the three canvas surfaces + gate readiness on the full paint.
// document.fonts.ready always resolves (no fonts here, but kept for the chromeDpr
// markReady discipline so it never hangs); img.decode resolves once the baked PNG is
// rasterized; each Pixi app.render() draws its one frozen frame before we mark ready.
async function boot(): Promise<void> {
  const app = new Application();
  await app.init({
    width: COMET_CANVAS_W,
    height: COMET_CANVAS_H,
    // The same darkest-ramp substrate the real canvas uses (bootPixi background).
    background: LOCKED_SKIN.palette.ramp[0],
    // antialias OFF (matches bootPixi / SKIN-05): SwiftShader software GL with no AA
    // is what makes the WebGL screenshot byte-stable.
    antialias: false,
    autoDensity: false,
    // Pin resolution to 1 so the backing store is exactly COMET_CANVAS_W x _H
    // regardless of the host DPR (the spec also pins deviceScaleFactor 1).
    resolution: 1,
    // No ticker: the fixture draws exactly the two frozen frames itself.
    autoStart: false,
  });

  // The real wire layer at full zoom (scale*CELL = 32 >= the 16px LOD cut => full
  // comet head + glow tail). quantum 1 (DPR*zoom) for the device-pixel snap.
  const wires = createWireLayer(LOCKED_SKIN, () => 1, () => 1);
  // BOTH halves of the split layer (plan 66-05), cables first then terminals - the
  // same adjacency `composeCamera` gives the real camera, so this surface composes
  // the shipped painter order rather than an approximation of it.
  app.stage.addChild(wires.cables, wires.terminals);

  const scene = wireScene();
  // Two-draw latch: first draw anchors entryClock = COMET_T0 (frac 0), the second at
  // COMET_T0 + COMET_HALF_SWEEP sweeps to frac 0.5 (mid-cable). Fixed render clock,
  // never scene.tick.
  wires.draw(scene, COMET_T0, COMET_T0);
  wires.draw(scene, COMET_T0 + COMET_HALF_SWEEP, COMET_T0 + COMET_HALF_SWEEP);
  app.render();

  cometBox.appendChild(app.canvas);

  // --- Surface (c2): wire-vs-world occlusion (E6, plan 66-05) ---------------
  // Built HERE, inside the SAME single async entry point, for the reason the pilot,
  // the corner and the operator all record: a second top-level async booter would
  // race markReady() below and let Playwright screenshot a half-painted page.
  //
  // NAMED RISK, so it is diagnosed rather than discovered. `pixelGuard.tsx` already
  // records (surface (e)) that a browser caps live WebGL contexts - Chromium at around
  // 16 - and SILENTLY LOSES the oldest past the cap, and that building 36 of them
  // corrupted the other four surfaces and flipped `data-antialias` to "1". This is the
  // SIXTH Application on the page, well inside the cap, but the failure mode corrupts
  // OTHER surfaces: if `operator`, `comet`, `belt-corner` or `pilot` goes red on the
  // commit that added this surface, look HERE first, not at the layer split.
  const occlusionApp = new Application();
  await occlusionApp.init({
    width: OCCLUSION_CANVAS_W,
    height: OCCLUSION_CANVAS_H,
    // The four options below are copied VERBATIM from the comet block above, which
    // mirrors `bootPixi` deliberately and says so. The same darkest-ramp substrate the
    // real canvas paints behind the floor.
    background: LOCKED_SKIN.palette.ramp[0],
    antialias: false,
    autoDensity: false,
    resolution: 1,
    autoStart: false,
  });

  // THE REAL LAYERS, NOT PRIMITIVES, AND THAT IS THE WHOLE POINT OF THE SURFACE. The
  // operator and belt-corner surfaces call the shipped painters directly, which is right
  // for them: they gate one drawing, not a composition. This surface gates the
  // COMPOSITION, so calling primitives here would RESTATE the z-order rather than read
  // it, and a restated order is a gate that agrees with itself.
  //
  // `composeCamera` CANNOT be reused here and nobody should unify them: it demands a
  // full `SceneLayers` including `grid` (a render-group Container that re-tiles from a
  // live camera) and `items` (which needs `pixiDotPainter(app.renderer)`), and neither
  // buys anything for occlusion while both add a failure mode. What IS shared is the
  // ORDER, and it is written here in the same bottom-to-top form the contract states:
  // belts < machines < cables < terminals.
  const occBelts = createBeltLayer(LOCKED_SKIN, undefined, () => 1, () => 1);
  const occMachines = createMachineLayer(LOCKED_SKIN, () => 1);
  const occWires = createWireLayer(LOCKED_SKIN, () => 1, () => 1);
  occlusionApp.stage.addChild(
    occBelts.layer,
    occMachines.layer,
    occWires.cables,
    occWires.terminals,
  );

  const occScene = occlusionScene();
  occMachines.draw(occScene, 0);
  occBelts.draw(occScene, 0, 0);
  // Idle wires: no pulse, so nothing on this canvas moves and the frozen frame needs no
  // clock. The render clock is still passed explicitly rather than read from anywhere.
  occWires.draw(occScene, 0, 0);
  occlusionApp.render();
  occlusionBox.appendChild(occlusionApp.canvas);

  // --- Surface (c3): the 72-16 union-box perimeter ring ---------------------
  // Built HERE, inside the SAME single async entry point, for the reason every surface
  // above records: a second top-level async booter would race markReady() below and let
  // Playwright screenshot a half-painted page. This is the SEVENTH Application on the
  // page; the WebGL-context cap named on the occlusion block above applies, so if an
  // unrelated surface reddens on the commit that added this one, look here first.
  const goaroundApp = new Application();
  await goaroundApp.init({
    width: GOAROUND_CANVAS_W,
    height: GOAROUND_CANVAS_H,
    // Copied VERBATIM from the occlusion block, which copied them from the comet block,
    // which mirrors `bootPixi`.
    background: LOCKED_SKIN.palette.ramp[0],
    antialias: false,
    autoDensity: false,
    resolution: 1,
    autoStart: false,
  });
  // The machine layer is mounted as well as the wire layer, and that is the point rather
  // than decoration: the defect J-7 named was a cable drawn STARTING INSIDE the Handler's
  // own chassis outline. Without the machine drawn there is no chassis to read it against.
  const goMachines = createMachineLayer(LOCKED_SKIN, () => 1);
  const goWires = createWireLayer(LOCKED_SKIN, () => 1, () => 1);
  goaroundApp.stage.addChild(goMachines.layer, goWires.cables, goWires.terminals);
  const goScene = goaroundScene();
  goMachines.draw(goScene, 0);
  // Idle wires: no pulse, so nothing on this canvas moves and the frozen frame needs no
  // clock. The render clock is still passed explicitly rather than read from anywhere.
  goWires.draw(goScene, 0, 0);
  goaroundApp.render();
  goaroundBox.appendChild(goaroundApp.canvas);

  // --- Surface (d): the vector pilot ---------------------------------------
  // Built HERE, inside the SINGLE async entry point, on purpose: a second
  // top-level async booter would race markReady() below and let Playwright
  // screenshot a half-painted page. One entry point, one markReady().
  const pilotApp = new Application();
  await pilotApp.init({
    width: PILOT_CANVAS_W,
    height: PILOT_CANVAS_H,
    // The same darkest-ramp substrate the real canvas uses (bootPixi background).
    background: LOCKED_SKIN.palette.ramp[0],
    // antialias OFF (matches bootPixi / SKIN-05, and VEC-03 asserts it below from
    // the LIVE context): software GL with no AA is what makes maxDiffPixels:0
    // survive the move to vector geometry.
    antialias: false,
    autoDensity: false,
    // Pin resolution to 1 so the backing store is exactly PILOT_CANVAS_W x _H
    // regardless of the host DPR (the spec also pins deviceScaleFactor 1).
    resolution: 1,
    // No ticker: the fixture draws exactly the one frozen frame itself.
    autoStart: false,
  });

  // ONE GraphicsContext, three Graphics (VEC-04). Each `new Graphics(pilotCtx)`
  // SHARES the tessellation rather than re-parsing the SVG, so all three
  // drawings are one geometry at three transforms - which is precisely the
  // property that keeps a zoomed asset crisp instead of resampled.
  const pilotCtx = getPilotContext();
  for (const [scale, x, y] of PILOT_PLACEMENTS) {
    const g = new Graphics(pilotCtx);
    g.scale.set(scale);
    g.position.set(x, y);
    pilotApp.stage.addChild(g);
  }
  pilotApp.render();
  pilotBox.appendChild(pilotApp.canvas);

  // --- Surface (b): the SHIPPED vector belt corner --------------------------
  // Built HERE, inside the SAME single async entry point, for the reason the pilot
  // and the operator are: a second top-level async booter would race markReady()
  // below and let Playwright screenshot a half-painted page.
  const cornerApp = new Application();
  await cornerApp.init({
    width: CORNER_CANVAS_W,
    height: CORNER_CANVAS_H,
    // The same darkest-ramp substrate the real canvas uses (bootPixi background) -
    // byte-identical to the gutter colour the retired bake sheet filled by hand.
    background: LOCKED_SKIN.palette.ramp[0],
    // antialias OFF (matches bootPixi / SKIN-05). This is what carries `maxDiffPixels: 0`
    // across the move from a nearest-sampled bake to a live canvas: with AA off the
    // rasteriser snaps every edge to a whole device pixel, exactly as it already does
    // for the operator and vector-pilot canvas surfaces, which hold 0 today. Being
    // canvas-based is not what would cost this surface its exactness.
    antialias: false,
    autoDensity: false,
    // Pin resolution to 1 so the backing store is exactly CORNER_CANVAS_W x _H
    // regardless of the host DPR (the spec also pins deviceScaleFactor 1).
    resolution: 1,
    // No ticker: the fixture draws exactly the one frozen frame itself.
    autoStart: false,
  });

  // The tile geometry is authored with its ORIGIN AT THE TILE CENTRE, so each tile is
  // positioned at its cell centre rather than its top-left. Rails are drawn BENEATH the
  // tread, which is the order `belts.ts` composes its Container children in
  // (RAIL_CHILD under TREAD_CHILD) - a reversed order here would gate a stacking the
  // layer does not draw.
  for (const [row, chirality] of CORNER_CHIRALITIES.entries()) {
    for (const [col, bucket] of CORNER_BUCKETS.entries()) {
      const cx = col * CORNER_STRIDE + CORNER_TILE / 2;
      const cy = row * CORNER_STRIDE + CORNER_TILE / 2;
      const rails = new Graphics(
        SHIPPED_PAINTER.cornerRails(LOCKED_SKIN, CORNER_QUANTUM, chirality),
      );
      rails.position.set(cx, cy);
      cornerApp.stage.addChild(rails);
      const tread = new Graphics(
        SHIPPED_PAINTER.corner(LOCKED_SKIN, bucket, chirality, CORNER_TILE),
      );
      tread.position.set(cx, cy);
      cornerApp.stage.addChild(tread);
    }
  }
  cornerApp.render();
  beltCornerBox.appendChild(cornerApp.canvas);

  // --- Surface (a): the vector machine ------------------------------------
  // Also built HERE, inside the SAME single async entry point, for the same
  // reason the pilot is: a second top-level async booter would race markReady()
  // and let Playwright screenshot a half-painted page.
  const operatorApp = new Application();
  await operatorApp.init({
    width: OPERATOR_CANVAS_W,
    height: OPERATOR_CANVAS_H,
    // The same darkest-ramp substrate the real canvas uses (bootPixi background).
    background: LOCKED_SKIN.palette.ramp[0],
    // antialias OFF (matches bootPixi / SKIN-05, and VEC-03 asserts it below from
    // the LIVE context). The maintainers' stated visual judgement, 2026-07-31.
    antialias: false,
    autoDensity: false,
    // Pin resolution to 1 so the backing store is exactly OPERATOR_CANVAS_W x _H
    // regardless of the host DPR (the spec also pins deviceScaleFactor 1).
    resolution: 1,
    // No ticker: the fixture draws exactly the one frozen frame itself.
    autoStart: false,
  });

  // ONE shared GraphicsContext for both drawings (VEC-04), exactly as the machine
  // layer does it: N Routers on the board are ONE tessellation.
  const operatorCtx = getAssetContext(OPERATOR_SUBJECT);
  // The glyph AUTHOR box, read off the file's own `viewBox` - the same source
  // `machines.ts` centres from. Centring the tessellated INK instead would slide
  // an asymmetric glyph off the composition it was authored at.
  const operatorGlyphBox = getAssetBox(OPERATOR_SUBJECT);
  for (const [w, h, x, y] of OPERATOR_PLACEMENTS) {
    // A `body` Container per drawing, placed at the box min corner - the same
    // shape the machine layer builds (chassis under glyph, both in unrotated
    // effective-box coordinates). rot is 0 here: rotation is a parent transform
    // and this surface guards the FOOTPRINT class, not the orientation class.
    const body = new Container();
    body.position.set(x, y);
    const chassis = new Graphics();
    drawChassis(chassis, w, h, LOCKED_SKIN, state_tag.IDLE);
    const glyph = new Graphics(operatorCtx);
    glyph.position.set(
      (w * CELL - operatorGlyphBox.w) / 2,
      (h * CELL - operatorGlyphBox.h) / 2,
    );
    body.addChild(chassis, glyph);
    operatorApp.stage.addChild(body);
  }
  operatorApp.render();
  operatorBox.appendChild(operatorApp.canvas);

  // --- Surface (e): belt rail continuity ------------------------------------
  // Built HERE, inside the SAME single async entry point, for the reason the pilot and
  // the operator record: a second top-level async booter would race markReady().
  const railReports: RailReport[] = [];

  // ONE Application for all 36 probed drawings (3 runs x 6 scales x 2 variants), RESIZED
  // per drawing rather than one Application each.
  //
  // **THIS IS NOT A TIDINESS CHOICE.** A browser caps live WebGL contexts - Chromium at
  // around 16 - and silently LOSES the oldest ones past the cap. Building 36 here
  // corrupted the other four pixel-guard surfaces and flipped `data-antialias` to "1",
  // reddening the operator, comet and pilot baselines that this plan does not touch.
  // Found by running the suite, not by reasoning about it. One context, reused.
  const railApp = new Application();
  await railApp.init({
    width: Math.ceil(RAIL_TILES * CELL),
    height: CELL,
    background: LOCKED_SKIN.palette.ramp[0],
    // antialias OFF - and this surface depends on it more than any other. The defect
    // being gated IS a non-antialiased rasteriser dropping a sub-device-pixel band; with
    // AA on the control would soften rather than vanish and the gate would silently
    // measure a different phenomenon from the one the app ships.
    antialias: false,
    autoDensity: false,
    resolution: 1,
    autoStart: false,
  });
  railBox.appendChild(railApp.canvas);

  /**
   * Draw ONE run at ONE scale under ONE painter, then measure both rail bands.
   *
   * The whole belt layer goes inside a container scaled by the camera scale, and the
   * layer's own `scale` / `quantum` closures are handed the same number - which is
   * exactly the shape `pixiApp.ts` gives the real canvas at DPR 1. So the device
   * positions here are the device positions the app produces, not an approximation
   * of them.
   */
  const probeRail = async (
    run: string,
    tiles: TileView[],
    scale: number,
    variant: 'shipped' | 'control',
  ): Promise<void> => {
    const cells = tiles.reduce(
      (b, t) => ({ x: Math.max(b.x, t.cell_x + 1), y: Math.max(b.y, t.cell_y + 1) }),
      { x: 0, y: 0 },
    );
    const width = Math.ceil(cells.x * CELL * scale);
    const height = Math.ceil(cells.y * CELL * scale);
    railApp.renderer.resize(width, height);
    railApp.stage.removeChildren();
    const holder = new Container();
    holder.scale.set(scale);
    const belts = createBeltLayer(
      LOCKED_SKIN,
      new SynthTextureCache(),
      () => scale,
      () => scale, // DPR 1, so the device quantum IS the camera scale
      variant === 'control' ? CONTROL_PAINTER : SHIPPED_PAINTER,
      new BeltContextCache(),
      new BeltContextCache(),
    );
    holder.addChild(belts.layer);
    railApp.stage.addChild(holder);
    belts.draw(beltScene(tiles), 0, 0);
    railApp.render();

    // Pixi's OWN extract path, at resolution 1 over an explicit full-canvas frame, so
    // the pixel grid read back is the pixel grid drawn.
    const { pixels } = railApp.renderer.extract.pixels({
      target: railApp.stage,
      frame: new Rectangle(0, 0, width, height),
      resolution: 1,
    });

    // The tread band is a 2 world px strip on the tile centreline; everything outside
    // it, above and below, is rail. `q` is the device quantum, which at DPR 1 is the
    // camera scale.
    const q = scale;
    const centreY = Math.round((CELL / 2) * scale);
    const isTread = (y: number): boolean => Math.abs(y + 0.5 - centreY) < q + 0.5;
    // The whole-canvas band read is meaningful ONLY for a run that is one cell row
    // deep. Reporting it for a bent run would count the columns of a corner cell that
    // carry no ink on the straight's rows BY CONSTRUCTION, and call that a gap.
    const oneRow = cells.y === 1;
    // The two device offsets the rail bands take from the across-flow centre, derived
    // through the SAME rule the emitter uses. The control's lanes sit within a device
    // pixel of these (its `d` is the unrounded `laneHalf * q`), which the seam probe's
    // own +/-2 px search band absorbs - see `measureSeams` for why that matters.
    const band = railBandAt(scale);
    railReports.push({
      run,
      scale,
      variant,
      width,
      height,
      north: oneRow
        ? measureRailBand(pixels, width, height, (y) => y + 0.5 < centreY && !isTread(y))
        : null,
      south: oneRow
        ? measureRailBand(pixels, width, height, (y) => y + 0.5 > centreY && !isTread(y))
        : null,
      tread: oneRow ? measureRailBand(pixels, width, height, isTread) : null,
      seams: measureSeams(pixels, width, height, tiles, scale, band.d, band.t),
    });

    // The one canvas keeps the LAST drawing, tagged, so a human opening the fixture sees
    // something real. The gate reads the numeric payload, never this picture, and this
    // surface commits no baseline.
    railApp.canvas.setAttribute('data-rail-run', run);
    railApp.canvas.setAttribute('data-rail-scale', String(scale));
    railApp.canvas.setAttribute('data-rail-variant', variant);
  };

  for (const [run, tiles] of Object.entries(railRuns())) {
    for (const scale of RAIL_SCALES) {
      for (const variant of ['shipped', 'control'] as const) {
        await probeRail(run, tiles, scale, variant);
      }
    }
  }
  // THE RAISED HAZARD, MEASURED (plan 61-09 task 3). One extra drawing at the camera's
  // minimum-zoom clamp, outside the six gate scales because it is not a gate - it is the
  // number the finding is handed on with.
  await probeRail('straight', railRuns().straight, RAIL_MIN_ZOOM_CLAMP, 'shipped');
  readout.setAttribute('data-rail-continuity', JSON.stringify(railReports));

  // --- Surface (f): the cable and its re-route mark at MIN_ZOOM (plan 75-10) ----
  // Built HERE, inside the SAME single async entry point, for the reason every surface
  // above records: a second top-level async booter would race markReady().
  //
  // ONE Application for all 64 drawings (16 origins x 2 variants x 2 states), RESIZED per
  // drawing, for the WebGL-context cap surface (e) found by running the suite. This is
  // the ninth context on the page, and the only one this surface adds.
  const cableReports: CableMinZoomReport[] = [];
  const cableW = Math.ceil(CABLE_SCENE_CELLS_W * CELL * CABLE_MIN_ZOOM) + 1;
  const cableH = Math.ceil(CABLE_SCENE_CELLS_H * CELL * CABLE_MIN_ZOOM) + 1;
  const cableApp = new Application();
  await cableApp.init({
    width: cableW,
    height: cableH,
    // Copied from the wire surfaces, which mirror `bootPixi`. Antialias OFF is the
    // condition under which the walk saw the cable vanish: with AA on a half-pixel strip
    // would dim rather than drop, and the gate would measure a different phenomenon.
    background: LOCKED_SKIN.palette.ramp[0],
    antialias: false,
    autoDensity: false,
    resolution: 1,
    autoStart: false,
  });
  cableBox.appendChild(cableApp.canvas);
  const buildRgb = LOCKED_SKIN.palette.accents.build;

  for (const oy of CABLE_ORIGINS) {
    for (const ox of CABLE_ORIGINS) {
      for (const variant of ['shipped', 'control'] as const) {
        for (const state of ['rest', 'marked'] as const) {
          cableApp.renderer.resize(cableW, cableH);
          cableApp.stage.removeChildren();
          // SHIPPED hands the layer the zoom, exactly as `pixiApp.ts` does at DPR 1.
          // CONTROL hands it 1: the SAME layer function at its identity argument, so the
          // cable is stroked at the pre-fix 2 world px inside the same 0.25-scaled holder
          // and cannot drift from what it controls for. (At 1 the layer also takes its
          // full-detail branch, which changes only the resting alpha and the end prongs;
          // the ends are skipped and any ink at all counts at rest, so neither moves a
          // count.)
          const k = variant === 'shipped' ? CABLE_MIN_ZOOM : 1;
          const layer = createWireLayer(LOCKED_SKIN, () => k, () => k);
          const holder = new Container();
          holder.position.set(ox, oy);
          holder.scale.set(CABLE_MIN_ZOOM);
          holder.addChild(layer.cables, layer.terminals);
          cableApp.stage.addChild(holder);
          const scene = cableMinZoomScene(state === 'marked');
          layer.draw(scene, 0, 0);
          cableApp.render();
          const { pixels } = cableApp.renderer.extract.pixels({
            target: cableApp.stage,
            frame: new Rectangle(0, 0, cableW, cableH),
            resolution: 1,
          });
          // REST: any coverage at all is ink. The extract target is the stage, whose
          // background is not drawn into the read-back, so an untouched pixel reads alpha
          // 0 and anything the cable touched differs from the `ramp[0]` substrate.
          // MARKED: only a pixel that IS the build accent, opaque, counts, so the resting
          // stroke under the mark cannot stand in for the mark.
          const inked =
            state === 'rest'
              ? (i: number): boolean => pixels[i + 3] > 0
              : (i: number): boolean =>
                  pixels[i + 3] === 255 &&
                  pixels[i] === ((buildRgb >> 16) & 0xff) &&
                  pixels[i + 1] === ((buildRgb >> 8) & 0xff) &&
                  pixels[i + 2] === (buildRgb & 0xff);
          cableReports.push({
            ox,
            oy,
            variant,
            state,
            runs: cableRuns(scene).map((run) =>
              measureCableRun(cableW, cableH, run, ox, oy, inked),
            ),
          });
          cableApp.canvas.setAttribute('data-cable-origin', `${ox},${oy}`);
          cableApp.canvas.setAttribute('data-cable-variant', variant);
          cableApp.canvas.setAttribute('data-cable-state', state);
        }
      }
    }
  }
  readout.setAttribute('data-cable-min-zoom', JSON.stringify(cableReports));

  // --- Surface (g): every machine kind and the faulted and working states (92-06) ---
  // Built HERE, inside the SAME single async entry point, for the reason every surface
  // above records: a second top-level async booter would race markReady() and let
  // Playwright screenshot a half-painted page. This is the NINTH Application on the page,
  // and the only one this surface adds: thirteen machines share one canvas and are
  // screenshot slot by slot through clip divs, rather than one Application each, for the
  // WebGL-context cap surface (e) found (Chromium drops the oldest past about 16). If an
  // unrelated surface reddens on the commit that added this one, look here first.
  const kindsApp = new Application();
  await kindsApp.init({
    width: KINDS_CANVAS_W,
    height: KINDS_CANVAS_H,
    // Copied from the go-around block, which mirrors `bootPixi`.
    background: LOCKED_SKIN.palette.ramp[0],
    antialias: false,
    autoDensity: false,
    resolution: 1,
    autoStart: false,
  });
  // THE REAL LAYER, for the reason the occlusion surface states: calling `drawChassis`
  // and the glyph context here would restate the layer rather than read it, and the
  // nubs, the ring, the notch, the label box and the Handler's alias all live in the layer.
  const kindsMachines = createMachineLayer(LOCKED_SKIN, () => 1);
  kindsApp.stage.addChild(kindsMachines.layer);
  const kindsFrame = kindsPeakFrame();
  // ONE draw at the searched frame (frame 0 when the search found none, so the published
  // alphas, not a missing picture, are what fails). The frame is a fixture constant handed
  // to the layer, never a clock.
  kindsMachines.draw(kindsScene(), Math.max(kindsFrame, 0));
  kindsApp.render();
  kindsBox.appendChild(kindsApp.canvas);
  // The ring alpha the layer SET on each faulted machine, read back off the drawn
  // `machine-alert-ring` Graphics under the root at that machine's origin, not recomputed:
  // a ring that was never plotted, or a root that is not where the slot says, reads -1.
  const ringAlphaAt = (cellX: number, cellY: number): number => {
    for (const child of kindsMachines.layer.children) {
      if (child.position.x !== cellX * CELL || child.position.y !== cellY * CELL) continue;
      const ring = child.getChildByLabel('machine-alert-ring', true);
      if (ring !== null) return ring.alpha;
    }
    return -1;
  };
  readout.setAttribute('data-kinds-frame', String(kindsFrame));
  readout.setAttribute('data-ring-alpha-faulted-factory', String(ringAlphaAt(11, 1)));
  readout.setAttribute('data-ring-alpha-faulted-sink', String(ringAlphaAt(8, 10)));
  // One transparent, borderless clip div per slot, over the canvas at the slot's rect: the
  // spec screenshots each div by locator, which captures the canvas pixels under it.
  for (const s of KIND_SLOTS) {
    const [sx, sy, sw, sh] = s.slot;
    const cell = document.createElement('div');
    cell.setAttribute('data-kind-cell', s.name);
    cell.style.position = 'absolute';
    cell.style.left = `${sx * CELL}px`;
    cell.style.top = `${sy * CELL}px`;
    cell.style.width = `${sw * CELL}px`;
    cell.style.height = `${sh * CELL}px`;
    cell.style.background = 'transparent';
    cell.style.border = '0';
    kindsBox.appendChild(cell);
  }

  // THE IMAGE-DECODE WAIT IS GONE WITH THE LAST <img> (plan 61-07). Every surface is a
  // Pixi canvas now, and each one's `app.render()` above has already drawn its single
  // frozen frame synchronously, so there is nothing left to await for paint. The
  // `document.fonts.ready` await below stays, per the chromeDpr markReady discipline.
  if (document.fonts && typeof document.fonts.ready?.then === 'function') {
    await document.fonts.ready;
  }

  // VEC-03: publish the live antialias state of EVERY canvas this fixture created,
  // read from the running contexts (see antialiasOff above). "0" only when all of
  // them report AA off; "1" otherwise, including when a context could not be read
  // at all - so the gate reddens rather than passing over a missing context.
  // Written before markReady() so the spec can never observe the ready marker
  // without the attribute beside it.
  const allAntialiasOff = [
    app.canvas,
    pilotApp.canvas,
    operatorApp.canvas,
    // The belt-corner canvas joins the assertion in plan 61-07, when the surface
    // stopped being a nearest-sampled <img> and became a live drawing. Its committed
    // baseline is byte-exact at `maxDiffPixels: 0`, so an AA-on driver would not
    // soften it quietly - it would redden the gate without saying why. This says why.
    cornerApp.canvas,
    // The occlusion canvas joins the assertion (plan 66-05). Its baseline is byte-exact
    // at `maxDiffPixels: 0` like the operator, corner and pilot ones, so an AA-on driver
    // would redden it without saying why. This says why.
    occlusionApp.canvas,
    // The rail-continuity canvas joins the assertion (plan 61-09). This surface needs
    // AA off more than any other: the defect it gates IS the non-antialiased drop of a
    // sub-device-pixel band, and on an AA-on driver the control would soften instead of
    // vanishing and the gate would silently measure a different phenomenon.
    railApp.canvas,
    // The cable min-zoom canvas joins the assertion (plan 75-10). The defect it gates IS
    // the non-antialiased drop of a sub-device-pixel strip, so on an AA-on driver it would
    // measure dimming instead of vanishing and pass over the walk's failure.
    cableApp.canvas,
    // The go-around canvas joins the assertion (plan 92-06). It was left out when plan 72-16
    // added it, though its baseline is byte-exact at `maxDiffPixels: 0` like the occlusion
    // one, so an AA-on driver would have reddened it without saying why. This says why.
    goaroundApp.canvas,
    // The machine-kinds canvas joins the assertion (plan 92-06). Its thirteen baselines are
    // byte-exact at `maxDiffPixels: 0`, so an AA-on driver would redden all of them at once
    // without saying why. This says why.
    kindsApp.canvas,
  ].every(antialiasOff);
  readout.setAttribute('data-antialias', allAntialiasOff ? '0' : '1');

  markReady();
}

void boot();
