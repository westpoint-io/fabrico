// The electrical wire layer (UI-SPEC "Wire Visual Language", WUI-01, plan 40-04).
//
// A wire is NOT a belt: where the belt layer is a marching chevron TRACK baked into
// per-tile Sprites, the wire is a thin (2px) taut CABLE stroked along the
// wire_route() polyline, DORMANT/dim when idle and energizing to a bright energy
// pulse (comet) only while a request/reply message is in flight. This is the
// primary belt-vs-wire contrast: belts always march, wires REST (active-set only,
// 0 fps until a pulse rides the cable).
//
// This layer is a strict SIBLING of belts.ts, never a recolor of it:
//   - same factory ARGUMENT shape: `createWireLayer(activeSkin, scale?, quantum?)`.
//     The RETURN shape deliberately DIVERGES (plan 66-05): this is the one layer
//     factory in the renderer that does not answer `{ layer, draw }`. See the
//     `createWireLayer` docblock below for why, and for the counter-example,
//   - its OWN LOD hard-cut (LOD_MIN_TREAD_PX = 16 device-px per cell), deliberately
//     decoupled from the belt cut (belts tune for full-width corner arcs, wires for
//     comet tails), below which the comet collapses to a single bright dot with no tail,
//   - reuses interp.ts `tilePolyline`/`pointAlong` (the item-dot arc-length
//     sampler) and ports.ts `nubAnchor` (the shared electrical-terminal geometry),
//   - reads `skin.palette.accents.electric` / `.item` / `skin.palette.cable` each draw -
//     NO hand-authored hex - so the cable belongs to the same ONE locked palette every
//     other layer resolves from (D-22),
//   - one-way render-only interpolation: the comet position rides a render-side pulse
//     LATCH (RENDER-03, plan 42-03) anchored to `effectiveClock` at first sighting
//     and swept over VISUAL_HOP_TICKS, since the raw core hop (WIRE_HOP_TICKS=1 +
//     LAG_TICKS=1) clamps to 0 and pins the comet at the origin nub. The latch holds
//     ONLY local render state and is NEVER written back to decode.ts, a GridCommand,
//     or scene.tick (the T-31-DET / T-42-DET determinism boundary belts.ts/items.ts
//     already hold). It reads the same effectiveClock the belt tread does, so the
//     comet freezes on pause for free - no new freeze gate.
//
// The reply-home distinct read (the explicit WUI-01 success criterion - "the reply
// travelling home"): a FORWARD pulse is an electric-cyan COMPACT spark (~0.3-CELL
// tail); a REPLY pulse is an item-amber comet with a ~1.5-CELL TRAILING GLOW (alpha
// 0.9 -> 0, alpha compositing of a fixed accent - NEVER a brightness multiply, style
// bible section 7). Two redundant cues (warmer tint + longer glow tail) make the
// reply unmistakable even in greyscale (the VIS-03 colour-blind discipline). The
// electrical terminal is a SQUARE/prong nub (shape-distinct from the round belt cap).

import { Container, Graphics } from 'pixi.js';
import { CELL } from '../../../shared/geometry';
import { tileCenter, pointAlong } from '../interp';
import type { BeltPolyline } from '../interp';
import { cableLane } from '../cableLane';
import {
  CABLE_LANE_OFFSET,
  CABLE_WIDTH,
  cablePoints,
  nubEndAt,
  type ResolvedNub,
} from '../cableGeometry';
import { NUB_HALF, PORT_ROLE } from '../../protocol/ports';
import { machine_kind } from '../../protocol/kinds';
import { inletGlyphRects } from './inletGlyph';
import { plottedPolylines } from './overlay';
import { snapToDevicePixel, itemDotGrow } from './items';
import type { Skin } from '../synth/skin';
import type { SceneState } from '../sceneState';
import type { NodeView, TileView, WireDockView } from '../../protocol/decode';

// FLOW-03 / WUI-01 LOD hard-cut: the wire layer keeps its OWN separate cut at 16
// device-px per cell, DELIBERATELY decoupled from the belt cut (RENDER-02 raised the
// belt cut to 24; belts.ts explicitly says wires keep their own 16 and to NOT couple
// them). The two are tuned independently: belts for full-width corner arcs, wires for
// fine comet tails. Do NOT re-sync this value to the belt cut. At `scale * CELL >= 16`
// the full comet (head + tail); below it a single bright dot with NO tail (the fine
// glow would smear at low zoom).
const LOD_MIN_TREAD_PX = 16;

// Pulse direction byte (host-derived on the render packet - WirePulseView.direction).
// FORWARD (0) is the electric-cyan spark; REPLY (1) is the item-amber comet.
const DIR_REPLY = 1;

// RENDER-03 render-clock sweep span. The core hop is WIRE_HOP_TICKS=1 and the render
// LAG_TICKS=1 clamp `(effectiveClock - entry_tick)/hop_ticks` to 0, so the raw core
// hop pins the comet at the origin nub. Instead the reply rides a render-side LATCH
// anchored to `effectiveClock` at first sighting and driven by this constant, so it
// visibly SWEEPS home over ~0.45s (28 / 60 units-per-second ≈ 0.467s; effectiveClock
// advances at ~1 unit per sim tick, interp.ts:250). This is a DISPLAY-only interp
// span - it never touches the core hop, the packet, or any serialized byte. Tune the
// value to land ~0.45s at the actual render-clock rate (RESEARCH A2).
const VISUAL_HOP_TICKS = 28;

/**
 * THE RE-ROUTE MARK'S HOLD, in render-clock units (plan 75-06, CABLE-07, UI-SPEC 4.3): a
 * cable an edit moved is stroked in `skin.palette.accents.build` at alpha 1 for this many
 * units after the frame the move is first seen, then fades. D-07 fixes the shape (the
 * render clock, cleared by keyframes and rewinds); the numbers are the plan's.
 */
const MARK_HOLD = 40;
/**
 * THE RE-ROUTE MARK'S WHOLE SPAN, in render-clock units (plan 75-06, UI-SPEC 4.3, D-07):
 * the alpha falls linearly from 1 at {@link MARK_HOLD} to 0 here, and from here on the
 * mark is not drawn. 60 units is about one second at the render clock's rate of about
 * one unit per sim tick. Chosen as the stated default (the allowed range is 45 to 90);
 * the walk can move it.
 */
const MARK_SPAN = 60;

/**
 * The re-route mark's alpha `age` render units after it was first seen: alpha
 * compositing of a fixed accent, never a brightness multiply (style bible section 7).
 * A negative age (a render clock that stepped back without a rewind) reads as fresh.
 */
function markAlpha(age: number): number {
  const a = Math.max(age, 0);
  if (a <= MARK_HOLD) return 1;
  if (a >= MARK_SPAN) return 0;
  return 1 - (a - MARK_HOLD) / (MARK_SPAN - MARK_HOLD);
}

// The locked wire dimensions (UI-SPEC "Spacing Scale" - geometry-space native px @
// zoom 1, the belt-layer counterparts to CAP_R / plug widths). All colours are read
// from `skin.palette.*` at draw time; only these DIMENSIONS are constants here.
// `CABLE_WIDTH` (2, thin and taut, reads "cable" not "track") and D1's lane displacement
// `CABLE_LANE_OFFSET = CABLE_WIDTH` moved to `../cableGeometry.ts` with the end geometry
// (plan 75-05), so the drag preview and the cable read one value. Their derivation
// docblock moved with them. The lane offset is re-exported here so existing importers keep
// working.
export { CABLE_LANE_OFFSET };
/**
 * The resting cable's alpha, at EVERY zoom (phase 92, D-10, UI-SPEC 4.2 and A14): the cable is
 * stroked in `skin.palette.cable` at alpha 1. It was `ramp[3]` at 0.35 at full zoom and 0.5
 * below the LOD cut, which composited to a dimmer copy of the grid's own grey (1.35:1 on the
 * floor, 1.22:1 against a major grid line); walk-114 read the cables as stray rectangle
 * outlines. With one opaque teal the low-zoom branch had nothing left to do (its 0.5 would now
 * be the dimmer of the two), so it went. Alpha never kept a line on screen anyway: with
 * antialias off a stroke narrower than a pixel draws no pixel wherever it covers no pixel
 * centre, and the width floor below (`MIN_CABLE_SCREEN_PX`, plan 75-10) is what keeps the line
 * on a pixel below 50% zoom. Exported so the live walk's screen read
 * (`e2e-live/support/canvasDots.ts` `CABLE_ALPHA`) is pinned to it.
 */
export const CABLE_ALPHA_IDLE = 1;

/**
 * THE CABLE'S MINIMUM SCREEN WIDTH, in screen (device) px at a device pixel ratio of 1
 * (plan 75-10, CABLE-07, 75-WALK.md GAP LOW-ZOOM).
 *
 * WHAT WAS MEASURED. Both walks on the real binary moved a cable at 25% zoom and saw
 * little or none of its re-route mark. `CABLE_WIDTH` is 2 world px, which at the camera's
 * `MIN_ZOOM` 0.25 is HALF a screen pixel. At 0.25 every cell centre lands on a whole
 * device pixel (16 x 0.25 = 4) and the lane puts the cable half a device pixel off it, so
 * a half-pixel strip covers a pixel centre at one camera origin and none at the origin
 * half a pixel over: `e2e/cable-min-zoom.spec.ts` read 32 of 64 shipped runs with EVERY
 * position empty (origins 0.5 and 0.75 device px across the line) on the unchanged layer.
 *
 * WHY ONE. A one-pixel strip is the narrowest stroke that always covers a pixel centre
 * with antialias off, at any camera origin and any device pixel ratio of 1 or more: any
 * half-open interval one pixel long holds exactly one pixel centre. The pixel gate above
 * sweeps 16 origins and reads zero gaps at this value.
 *
 * WHY ON THE ZOOM ALONE, not the device quantum. The same shape as `itemDotGrow` and
 * `nubHitRadiusWorld`: a screen-size floor that grows in world units as the camera zooms
 * out. At a device pixel ratio above 1 a screen pixel is several device pixels, so the
 * floor is conservative there, never short.
 *
 * WHAT DELIBERATELY DOES NOT FOLLOW. The lane offset (`CABLE_LANE_OFFSET`, 2 world px)
 * stays put, so at 25% a forward cable and its return, each now one screen pixel wide and
 * half a pixel apart, abut as one two-pixel band. Separating them there would mean a
 * scale-dependent route geometry, which the drag preview and the comet would then have to
 * share; the pair still reads as one connection. The prong stem, the nub squares and the
 * comets are untouched: the stem draws only at full zoom, and the comets carry their own
 * `itemDotGrow` floor.
 */
export const MIN_CABLE_SCREEN_PX = 1;

/**
 * The world-px width BOTH cable strokes (the resting cable and the re-route mark) are
 * drawn at, for camera zoom `scale`: `CABLE_WIDTH`, or {@link MIN_CABLE_SCREEN_PX} screen
 * px in world units when that is wider. At zoom 0.5 and above it is the identity (2 world
 * px), so nothing a user sees at 50% or more moves and no pixel-guard baseline (all drawn
 * at zoom 1) moves; at 25% it is 4 world px. A non-finite or non-positive scale returns
 * `CABLE_WIDTH` rather than an infinite or negative width.
 */
export function cableStrokeWidth(scale: number): number {
  if (!Number.isFinite(scale) || !(scale > 0)) return CABLE_WIDTH;
  return Math.max(CABLE_WIDTH, MIN_CABLE_SCREEN_PX / scale);
}
const HEAD_R = 3; // compact bright comet head (forward AND reply)
const FORWARD_TAIL = 0.3 * CELL; // compact forward spark tail
const REPLY_GLOW = 1.5 * CELL; // the reply comet's "coming home" trailing glow
const REPLY_GLOW_ALPHA = 0.9; // glow head alpha, fading to 0 along the tail
// NUB_HALF - the electrical terminal half-extent, 10px square - now lives in
// `protocol/ports.ts` and is IMPORTED rather than declared here (plan 72-09). An
// UNCONNECTED electrical port draws the same square via `machines.ts drawRoleNub`
// reading the same constant under its port-silhouette spelling
// `NUB_ELECTRICAL_HALF`, so a connected and an unconnected electrical port are ONE
// object at ONE size. A literal here and a literal there is two sources of truth for
// one silhouette, and they will drift.

/**
 * One resolved wire terminal: the shared cable end (`ResolvedNub`: the nub centre in world
 * px, its outward normal, both 0 when unresolved, and the port's cell) plus what the
 * terminal drawing needs.
 */
interface WireNub extends ResolvedNub {
  /** True when the docked node is a kind-9 ENDPOINT: this end stamps the asymmetric inlet glyph (FEEL-04). */
  isEndpoint: boolean;
  /**
   * The docked port's ROLE byte. The inlet glyph's chevron mirrors for `Role::Out` so
   * its arrow points along the direction traffic actually travels at that nub (72-09
   * R-60): under D-04 both cables terminate at the Route, so the FORWARD cable's glyph
   * now sits on the Route's Out nub. An unresolved dock has no role and takes
   * `PORT_ROLE.IN`, which is the request-in chevron the glyph has always drawn.
   */
  role: number;
}

/**
 * The DRAWN cable polyline for one wire: `cablePoints` (the ONE end geometry, shared with
 * the drag preview since plan 75-05: cell centres, displaced into the wire's lane (D1) and
 * clamped at both ends onto the resolved nubs (D3)), measured so the comet rides the line
 * that is actually stroked. The clamp, the crossed collapse and their docblock live in
 * `../cableGeometry.ts`; nothing here decides where an end goes.
 *
 * The comet reads THIS polyline, not the raw cell-centre one. If it did not, a 2px lane
 * displacement would leave every comet floating beside its own cable, and the clamp
 * would stop the comet 16.5px short of the nub it is travelling home to.
 */
function cablePolyline(
  path: ReadonlyArray<TileView>,
  nubs: readonly [WireNub, WireNub],
): BeltPolyline {
  const pts = cablePoints(path, cableLane(path), { from: nubs[0], to: nubs[1] });
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segLen.push(len);
    total += len;
  }
  return { pts, segLen, total };
}

export interface WireLayer {
  /**
   * The resting cable strokes, and NOTHING else (UI-SPEC 2a). This is the only
   * thing an underlay would ever sink: it is what crosses other machines and belts.
   */
  cables: Container;
  /**
   * The prong stem, the square nub, the endpoint inlet glyph AND BOTH COMETS
   * (UI-SPEC 2a). These sit ON the machine's own port cell, or ride the cable as
   * the phase's showpiece. The comet lives here rather than with the cable because
   * The maintainer's stated objection to an underlay is that the reply comet would dip behind
   * every belt rail it crosses, so it must never travel downward with the cable.
   */
  terminals: Container;
  /**
   * Redraw every wire for the current scene at `effectiveClock` (the SAME quantized
   * render clock the belt + item layers read, loop.ts). ONE function over BOTH
   * Containers: the pulse latches and the retired high-water marks are keyed by wire
   * id and live in ONE place, because duplicating them across two draw functions
   * would double-anchor every comet. Pure per-frame recompute off the observed
   * packet - no scene-graph churn (one reused Graphics each), no write-back.
   *
   * `markClock` (plan 75-06, CABLE-07) is the clock the RE-ROUTE MARK runs on, and it is
   * REQUIRED, with no default, so no call site can forget it. The render loop passes the
   * UNPINNED render clock: reduced motion pins `effectiveClock`, and a mark on a pinned
   * clock would never expire (UI-SPEC 4.3; the repo's D-25 rule that a time-limited
   * affordance keeps elapsing under reduced motion). One-shot and fixture callers pass
   * their own clock explicitly.
   */
  draw(scene: SceneState, effectiveClock: number, markClock: number): void;
  /**
   * THE RE-ROUTE MARK'S PLOT READ (plan 75-06, CABLE-07, D-07): how many stroke
   * instructions the `cables` Graphics holds right now in `skin.palette.accents.build`,
   * read back off its own `context.instructions`, the house plot-read shape
   * (`OverlayLayer.beltPreviewInstructions`). Nothing else on that Graphics is ever
   * stroked in `build` (the resting cable is `skin.palette.cable`), so a count above zero means a
   * re-route mark reached the plot in the last frame, and zero means none did.
   *
   * WHY A COUNT AND NOT A FLAG. A latch that says "a mark is live" would stay true over a
   * Graphics that drew nothing, which is the model-oracle blind spot this repository has
   * paid for before. The count is taken off what was plotted, so a mark that was decided
   * but never stroked reads 0.
   *
   * WHAT IT CANNOT SEE: which cable carries the mark (it is a count, not a geometry), the
   * stroke's alpha, and whether Pixi then rasterised the instruction. Vitest grades the
   * geometry and the envelope off a recording Graphics; this read exists so the mock and
   * the live harness can ask whether the running app plotted a mark at all.
   */
  rerouteMarkStrokes(): number;
  /**
   * THE RESTING CABLES AS PLOTTED (plan 77-05, 77 D-04, done-test leg 5): one array of world-px
   * vertices per resting cable stroke the `cables` Graphics holds right now, read back off its
   * own `context.instructions` through `overlay.ts`'s `plottedPolylines`, in plot order. The
   * re-route mark is excluded by its colour (`skin.palette.accents.build`, the colour
   * `rerouteMarkStrokes` counts and nothing else on this Graphics is stroked in), so a mark on
   * screen never reads as a second cable.
   *
   * WHY. Every cable check in the live walk read MODEL geometry (`scene().wires[].path`), and a
   * wire layer that draws nothing, or draws a stale line, passes those reads and both
   * render-health helpers. This read sees what the layer STROKED and where; whether a user can
   * see it is the screen read's question (below).
   *
   * WHAT IT CANNOT SEE: the stroke's alpha and width, whether the `cables` Container is visible
   * or on the stage at all, the terminals (they live on the other Graphics), and whether Pixi then
   * rasterised the instruction. It is a PLOT read, not a canvas read: a cable stroked at alpha 0,
   * or a hidden or detached `cables` Container, still lists every polyline (the 77-05 refuter
   * round). What a user sees is read off screen pixels by the live walk
   * (`e2e-live/support/canvasDots.ts` `cablesOnCanvas`, the cable and its prongs). Read-only:
   * fresh arrays of plain numbers, no setter, no Pixi object escapes.
   */
  cablePolylines(): Array<Array<{ x: number; y: number }>>;
}

/**
 * Build the electrical wire render layer against a single `activeSkin`. Its ARGUMENTS
 * still mirror `createBeltLayer`: `scale` (live camera zoom for the LOD cut + low-zoom
 * floor) and `quantum` (DPR * zoom for the device-pixel snap) are injected as defaulted
 * closures so a GPU-free unit test can drive the layer. Both are read one-way, never
 * written back to decode.ts / a GridCommand / scene.tick (T-31-DET).
 *
 * ITS RETURN SHAPE IS THE ONE EXCEPTION IN THIS RENDERER, AND THE EXCEPTION IS THE POINT.
 * The old note here claimed signature parity with `createBeltLayer`. That claim died with
 * plan 66-05 and is rewritten rather than preserved, because a stale parity note is how a
 * later reader talks themselves into undoing this. Every OTHER layer factory - grid,
 * belts, items, machines, overlay - answers exactly ONE Container under the key `layer`.
 * This one answers TWO SIBLINGS, `cables` and `terminals`, with a single `draw` over both.
 *
 * WHY. A future underlay (sinking the resting cable beneath the machines while the
 * terminals stay overhead) becomes a ONE-LINE z-slot choice in `composeCamera` instead of
 * a refactor. The terminals sit on the machine's OWN port cell, so a naive whole-layer
 * reorder would bury the 10px nub and the endpoint inlet glyph under the chassis stroke,
 * and those two marks are the only things making a resting wire legible. The maintainer approved
 * paying this cost to keep the underlay option open (66-CONTEXT, locked decision 2). The
 * underlay itself is NOT taken here: wires stay overhead, `machines < cables < terminals`.
 *
 * THE TWO CONTAINERS ARE SIBLINGS THE CAMERA HOLDS DIRECTLY. Do not nest them under a
 * shared parent: that puts the z-slot choice back inside this module and defeats the split
 * outright.
 *
 * `layers/overlay.ts:240` IS THE DELIBERATE COUNTER-EXAMPLE, and it is named here so that
 * nobody "fixes" this file by making it match. Overlay holds THIRTEEN sibling Graphics
 * under ONE parent on purpose: its internal z-order is overlay's own business and no
 * camera slot will ever need to be inserted between two of them. The wire split does the
 * opposite for the opposite reason - a camera slot between `cables` and `terminals` is
 * precisely the thing being kept available. Neither file is a mistake; they answer
 * different questions.
 *
 * The 2nd parameter used to be a `SynthTextureCache`, touched ONLY by the deleted
 * skin-swap hook (this layer is pure Graphics and bakes no texture). It went with the
 * hook rather than being kept as a dead argument. The `undefined` placeholder at the
 * existing call sites went with it.
 */
export function createWireLayer(
  activeSkin: Skin,
  scale: () => number = () => 1,
  quantum: () => number = () => 1,
): WireLayer {
  // TWO Containers, each with ONE reused Graphics: cleared + replotted each frame.
  // The comet MUST move every frame (analytic pointAlong), and a thin 2px cable
  // stroke is trivially cheap to replot - critically NO scene-graph object is
  // allocated per frame (the belt Pitfall-1 allocation storm is avoided by
  // construction). Two Graphics instead of one costs one extra draw call and buys
  // the z-slot between them.
  const cables = new Container();
  const gCable = new Graphics();
  cables.addChild(gCable);
  const terminals = new Container();
  const gTerm = new Graphics();
  terminals.addChild(gTerm);
  const skin = activeSkin;

  /**
   * Resolve one wire terminal to its electrical nub anchor (the belts.ts
   * resolveEndAnchor discipline): the docked node's port -> the shared `nubAnchor`
   * math + outward normal. An unresolved dock (unknown node handle / out-of-range
   * port) falls back to the terminal tile centre with no outward normal - that end
   * renders undocked-style and NEVER throws (T-21-06 mitigated).
   */
  const resolveNub = (
    nodes: ReadonlyMap<number, NodeView>,
    dock: WireDockView,
    terminal: TileView,
  ): WireNub => {
    const node = nodes.get(dock.node);
    const port = node ? (node.ports[dock.port] ?? null) : null;
    if (!port) {
      // The unresolved end sits on its terminal tile's centre, and that tile is the
      // cell it records, so the shared end geometry treats it as a nub on its own cell.
      const c = tileCenter(terminal);
      return {
        x: c.x,
        y: c.y,
        nx: 0,
        ny: 0,
        cellX: terminal.cell_x,
        cellY: terminal.cell_y,
        isEndpoint: false,
        role: PORT_ROLE.IN,
      };
    }
    // FEEL-04: branch on the docked node's KIND (never wire polarity); an alien kind
    // byte simply compares unequal and degrades to the plain square (no new throw).
    // The nub itself comes from `nubEndAt`, the one place a cable end is built from a
    // port, so this terminal and the drag preview's nub cannot be computed two ways.
    return {
      ...nubEndAt(port.cell_x, port.cell_y, port.side),
      isEndpoint: node?.kind === machine_kind.ENDPOINT,
      role: port.role,
    };
  };

  /**
   * Draw one comet along the cable polyline at a supplied `frac` in [0,1]. FORWARD =
   * electric-cyan compact spark; REPLY = item-amber comet with a longer trailing glow
   * (the distinct home read). The glow is alpha compositing of a FIXED accent colour
   * at a fading alpha (never a brightness multiply). Below the LOD cut it collapses to
   * a single bright dot.
   *
   * RENDER-03: `frac` is now driven by the render-side LATCH (see `draw`), NOT by the
   * pulse's raw `entry_tick/hop_ticks` (which clamped to 0 and pinned the comet at the
   * origin nub). The LOCKED Phase-40 visuals below are unchanged - only the frac
   * SOURCE moved to the latch.
   *
   * It draws onto `gTerm`, the TERMINAL Graphics, never onto the cable one: UI-SPEC 2a
   * keeps both comets with the terminals so a future underlay cannot sink the reply
   * comet behind the belt rails it crosses.
   */
  const drawComet = (
    direction: number,
    frac: number,
    pl: BeltPolyline,
    full: boolean,
    q: number,
    grow: number,
  ): void => {
    const { accents } = skin.palette;
    const isReply = direction === DIR_REPLY;
    const color = isReply ? accents.item : accents.electric;
    const d = frac * pl.total;
    const p = pointAlong(pl, d);
    const hx = snapToDevicePixel(p.x, q);
    const hy = snapToDevicePixel(p.y, q);
    const r = HEAD_R * grow; // low-zoom floor (the items.ts itemDotGrow discipline)

    if (!full) {
      // LOD low zoom: a single bright dot, NO tail (the fine comet tail smears).
      gTerm.circle(hx, hy, r).fill({ color, alpha: 1 });
      return;
    }

    // The trailing glow/tail: sample points BEHIND the head along the polyline,
    // fading the accent alpha to 0. Reply carries a ~1.5-CELL glow; forward a
    // compact ~0.3-CELL spark. Drawn tail-first so the opaque head composites on top.
    const tailLen = isReply ? REPLY_GLOW : FORWARD_TAIL;
    const maxAlpha = isReply ? REPLY_GLOW_ALPHA : 0.6;
    const samples = Math.max(2, Math.round(tailLen / (CELL * 0.2)));
    for (let i = samples; i >= 1; i--) {
      const t = i / samples; // 1 = furthest back
      const td = Math.max(0, d - t * tailLen);
      const tp = pointAlong(pl, td);
      gTerm
        .circle(snapToDevicePixel(tp.x, q), snapToDevicePixel(tp.y, q), r * (1 - 0.4 * t))
        .fill({
          color,
          alpha: maxAlpha * (1 - t),
        });
    }
    // The opaque bright head on top (alpha 1, r=HEAD_R*grow).
    gTerm.circle(hx, hy, r).fill({ color, alpha: 1 });
  };

  // RENDER-03 render-side pulse LATCH (sibling of the faultBlink identity/clock
  // discipline): `Map<wireId, Map<pulseKey, { entryClock, direction }>>`. Each pulse
  // is latched at first sighting with `entryClock = effectiveClock` (Pitfall 3: NEVER
  // overwrite an existing latch - otherwise it re-anchors every display frame and
  // stays at frac 0). The comet then sweeps from that anchor over VISUAL_HOP_TICKS,
  // PERSISTING after the ~1-tick core pulse leaves `wire.pulses[]`, retiring at
  // frac>=1, and GC'd when the wire leaves the scene. A keyframe clears it too (CR-01,
  // plan 76-14: the handle may now name another cable). This holds ONLY local render
  // state - nothing is written back to decode.ts / a GridCommand / scene.tick / the
  // event log (T-42-DET). The separate `replyPulsesObserved` ORACLE latch in
  // sceneState.ts (the e2e data proof) is untouched.
  const latches = new Map<
    number,
    Map<string, { entryClock: number; direction: number; entryTick: number }>
  >();

  // WR-03 resurrection guard. A latch is deleted at frac>=1 to avoid map growth; without
  // a guard, if a core pulse ever LINGERED in `wire.pulses[]` past its comet retirement
  // it would be re-registered with a fresh `entryClock` and loop the comet forever.
  // INVARIANT (enforced defensively here): a core pulse's lifetime in `wire.pulses[]`
  // (WIRE_HOP_TICKS=1 + LAG_TICKS=1, ~2 ticks) is FAR below VISUAL_HOP_TICKS=28, so every
  // pulse leaves `pulses[]` long before its comet reaches home - the resurrection path is
  // unreachable TODAY. This guard makes that invariant explicit so a future core-hop or
  // VISUAL_HOP_TICKS change cannot silently reintroduce a flickering/looping comet.
  // `entry_tick` is monotonic per wire, so any observed pulse whose entry_tick is <= the
  // retired high-water-mark for its direction has already swept home and must NOT
  // re-anchor. This is O(1) bounded (one number per direction per wire) - unlike a
  // growing retired-key set - and is GC'd with the latch when the wire leaves the scene.
  // A keyframe clears it too (CR-01, plan 76-14: the handle may now name another cable).
  // Pure local render state: never written back to decode.ts / a GridCommand / scene.tick.
  const retiredHwm = new Map<number, Map<number, number>>();

  // Rewind guard: the WR-03 high-water-mark premise ("entry_tick is monotonic per
  // wire") holds ONLY while sim ticks move forward. On a rewind (load-snapshot,
  // replay-from-history, time-travel scrubbing) the scene maps can be repopulated
  // in place with the SAME wire ids; a surviving stale hwm would then silently
  // suppress every replayed pulse (entry_tick <= hwm) - the cable renders but no
  // comet ever fires again in exactly the debugging mode where seeing pulses
  // matters most. So when scene.tick moves BACKWARD, all render-side latch state
  // is invalidated wholesale (latches + retiredHwm) and rebuilt from the replayed
  // packets. scene.tick is read one-way here (no write-back), so the T-42-DET
  // determinism boundary holds.
  let lastSceneTick = -Infinity;

  // Keyframe guard (CR-01, plan 76-14): the last `SceneState.keyframes` this layer saw.
  // The host mints node, belt and wire handles from ONE counter (render_packet.rs, the
  // handle mint), so a `full` packet can hand wire handle 5 from one cable to another.
  // The presence GC below drops an entry only when its handle is ABSENT, and the rewind
  // guard above clears only when the tick moves BACKWARD; an Undo or Redo keyframe moves
  // the tick forward by one and keeps handle 5 present, so neither saw it, and the old
  // cable's in-flight comet swept along the new cable's path.
  let lastKeyframes = 0;

  // THE RE-ROUTE MARK LATCH (plan 75-06, CABLE-07, D-07): wire id -> the re-route
  // generation last seen for it and the `markClock` of the frame it was first seen. A new
  // generation (`scene.wireReroutes`, bumped on the packet path when a diff re-sends the
  // wire on a different path) re-latches at the current `markClock`, so a second move
  // restarts the span. An expired latch is KEPT, with its generation, so the same move is
  // never latched twice; it is dropped only when its wire or its generation entry is gone.
  // Pure local render state: never written back to decode.ts / a GridCommand / scene.tick.
  const markLatch = new Map<number, { gen: number; start: number }>();

  const draw = (scene: SceneState, effectiveClock: number, markClock: number): void => {
    // Read defensively: fixture scenes built `as unknown as SceneState` carry no
    // `wireReroutes` (75-RESEARCH Pitfall 7), and a TypeError here would kill the Pixi
    // ticker while every model assertion stayed green. No map, no mark.
    const reroutes: ReadonlyMap<number, number> | undefined = (
      scene as { wireReroutes?: Map<number, number> }
    ).wireReroutes;
    // Read defensively, on the same Pitfall 7 precedent: a fixture scene carries no count,
    // which reads as 0 and so never moves.
    const keyframes = (scene as { keyframes?: number }).keyframes ?? 0;
    // CR-01 (plan 76-14): any `full` packet since the last frame may have reminted the wire
    // handles, so the comet latches and the retired marks keyed by them are forgotten. The
    // re-route marks need nothing here: `markLatch` already empties, because a keyframe
    // clears `wireReroutes` and the GC below drops every entry whose generation is gone.
    // THE LAG RESYNC, AS MEASURED: a resync keyframe can carry the handles the client
    // already had (no reset during its lag) or reminted ones (its lag spanned a
    // `RenderProducer::reset`, a fresh builder whose handles restart at 0, and the
    // keyframe watch then holds that builder's keyframe). The client cannot tell which, so
    // the clear runs on every `full` packet; when nothing was reminted the cost is at most
    // one in-flight comet per cable, cut short.
    if (keyframes !== lastKeyframes) {
      latches.clear();
      retiredHwm.clear();
    }
    lastKeyframes = keyframes;
    if (scene.tick < lastSceneTick) {
      latches.clear();
      retiredHwm.clear(); // a rewind invalidates the monotonic entry_tick premise
      // CABLE-07 (75-RESEARCH Pitfall 6): a rewind must never FLASH. Clearing the mark
      // latches alone would re-latch every generation still in `wireReroutes` with a fresh
      // start below, lighting every cable that was ever re-routed. So every current
      // generation is recorded as already seen, with a start that has long expired.
      markLatch.clear();
      for (const [id, gen] of reroutes ?? []) markLatch.set(id, { gen, start: -Infinity });
    }
    lastSceneTick = scene.tick;
    gCable.clear();
    gTerm.clear();
    // GC: drop latch maps for wires no longer present (mirror machines.ts:166 "remove
    // entries whose handle is gone"), so a deleted wire cannot leak the map (T-42-LEAK).
    for (const wireId of latches.keys()) {
      if (!scene.wires.has(wireId)) latches.delete(wireId);
    }
    for (const wireId of retiredHwm.keys()) {
      if (!scene.wires.has(wireId)) retiredHwm.delete(wireId);
    }
    for (const wireId of markLatch.keys()) {
      if (!scene.wires.has(wireId) || !reroutes?.has(wireId)) markLatch.delete(wireId);
    }
    // The live re-route marks found by the loop below, stroked after it (UI-SPEC 4.2).
    const marks: Array<{ pts: ReadonlyArray<{ x: number; y: number }>; alpha: number }> = [];
    const s = scale();
    const full = s * CELL >= LOD_MIN_TREAD_PX;
    // Both cable strokes, the resting cable and the re-route mark, read this one width, so
    // the mark keeps the cable's width exactly at every zoom (UI-SPEC 4.2).
    const strokeW = cableStrokeWidth(s);
    const q = quantum();
    const grow = itemDotGrow(s); // shared low-zoom dot floor (never balloons past the lane)
    const { accents } = skin.palette;

    // THE PAINTER ORDER IS NOW GROUPED, NOT PER-WIRE INTERLEAVED, AND THAT IS A REAL
    // PIXEL CHANGE ON A MULTI-WIRE BOARD (plan 66-05). Before the split one Graphics
    // took cableA, prongA, nubA, glyphA, cometA, then cableB, prongB, ... so a LATER
    // wire's cable (then alpha 0.35) stroked OVER an earlier wire's opaque cyan nub and
    // tinted it. Now every cable lands in `gCable` and every terminal in `gTerm`, so
    // the order is cableA, cableB | prongA, nubA, glyphA, cometA, prongB, ... and a
    // nub always wins over a crossing cable. It is arguably an improvement and it is
    // NOT a no-op: at ONE wire the two orders are identical, which is why the
    // one-wire `surface-wire-comet` baseline is byte-identical across the split while
    // the two-crossing-wire `surface-wire-occlusion` baseline is what can see this.
    for (const wire of scene.wires.values()) {
      if (wire.path.length === 0) continue; // a degenerate wire draws nothing

      // 0) The two electrical terminals are resolved BEFORE the cable, because the
      // cable's end vertices clamp onto them (D3). Their DRAWING still happens after
      // the stroke, in step 2, so the painter order is unchanged.
      const firstTile = wire.path[0];
      const lastTile = wire.path[wire.path.length - 1];
      const nubs: readonly [WireNub, WireNub] = [
        resolveNub(scene.nodes, wire.from, firstTile),
        resolveNub(scene.nodes, wire.to, lastTile),
      ];
      // The line that is actually drawn: cell centres, displaced into this wire's lane
      // (D1) and clamped to the nubs (D3). The comet rides it too.
      const pl = cablePolyline(wire.path, nubs);

      // 1) The resting/dormant cable: a thin taut stroke along the cell-centre
      // polyline in `skin.palette.cable` (the muted electric teal, phase 92 D-10) at
      // alpha 1 at every zoom. It is the width floor, `strokeW`, that keeps the line on a
      // pixel below 50% zoom (plan 75-10, 75-WALK.md GAP LOW-ZOOM); alpha alone cannot.
      // This is the ENTIRE idle read (0 fps - no comet when idle).
      if (pl.pts.length >= 2) {
        gCable.moveTo(pl.pts[0].x, pl.pts[0].y);
        for (let i = 1; i < pl.pts.length; i++) gCable.lineTo(pl.pts[i].x, pl.pts[i].y);
        gCable.stroke({
          width: strokeW,
          color: skin.palette.cable,
          alpha: CABLE_ALPHA_IDLE,
          cap: 'round',
          join: 'round',
        });
      }

      // 1b) CABLE-07: is this cable inside a re-route mark's span? Latch a NEW generation
      // at the current `markClock` (never overwrite a latch for the same generation), and
      // keep the drawn polyline so the mark is stroked on exactly the line the user sees.
      const gen = reroutes?.get(wire.id);
      if (gen !== undefined) {
        let ml = markLatch.get(wire.id);
        if (!ml || ml.gen !== gen) {
          ml = { gen, start: markClock };
          markLatch.set(wire.id, ml);
        }
        const alpha = markAlpha(markClock - ml.start);
        if (alpha > 0 && pl.pts.length >= 2) marks.push({ pts: pl.pts, alpha });
      }

      // 2) The two electrical terminals: resolve each nub from its docked node's
      // port (or fall back to the path end tile centre). Draw a short outward prong
      // stem (full zoom only) + a SQUARE nub in the electric accent (shape-distinct
      // from the round belt cap). A future WireOverflow fault byte would swap the
      // nub colour to `accents.fault` here (the shipped fault language); the current
      // WireView carries no fault flag, so the terminal reads electric.
      for (const nub of nubs) {
        const cx = snapToDevicePixel(nub.x, q);
        const cy = snapToDevicePixel(nub.y, q);
        // Does this terminal STAMP THE GLYPH rather than the plain square? Hoisted out
        // of the `if` below because the prong-stem gate now has to ask the same
        // question (see the suppression note directly under it).
        const stampsGlyph = nub.isEndpoint && full && (nub.nx !== 0 || nub.ny !== 0);
        // THE PRONG STEM IS SUPPRESSED ON A GLYPH-STAMPING `Role::Out` TERMINAL, AND
        // THIS DELIBERATELY OVERRIDES 72-09 R-60 / 72-UI-SPEC 5.4 (the maintainer's ruling,
        // 2026-09-03, candidate 2 of the three costed in `72-09-SUMMARY.md`).
        //
        // WHAT WAS MEASURED AND WHY THE LOCKED CONTRACT HAD TO MOVE. R-60 mirrors the
        // three chevron rects for a `Role::Out` terminal and locks the socket rects
        // still. It did not account for THIS STEM. The stem runs along the outward
        // normal from `u = -NUB_HALF` to `u = 0`; the IN chevron's apex sits at
        // `u in [-2, 0)` ON the stem with its arms flaring clear at `u in [0, 2)`, so
        // it reads as a notch. Mirrored for OUT, the ARMS land at `u in [-2, 0)`,
        // which is INSIDE the stem's run: arms and stem stack into a solid 2x6
        // vertical bar with the apex as a spur, and the silhouette reads as a PLUS or
        // a "T" at 1x rather than as ">". Read off the re-blessed `wire-comet`
        // baseline at 72-09, not inferred.
        //
        // WHY SUPPRESSION RATHER THAN MOVING THE CHEVRON. Shifting the mirrored
        // chevron outward by 2u would mirror the In clearance but leaves a 1px gap at
        // the stem's end and pushes the glyph toward the cable. Suppressing the stem
        // gives a clean ">" with no fusion, and the prong is arguably WRONG on an Out
        // terminal anyway: it points INTO the machine on a port whose whole meaning is
        // that traffic leaves there. The Out port becomes the ONE port type in this
        // renderer that draws no prong, and that is a decision rather than an
        // oversight - do not "restore" it for symmetry.
        //
        // THE SUPPRESSION IS NARROW ON PURPOSE. It applies only where the glyph is
        // actually stamped: below the LOD cut, and at every non-Route terminal, the
        // plain square still gets its stem, so the prong vocabulary is unchanged
        // everywhere the fusion cannot happen.
        const suppressProng = stampsGlyph && nub.role === PORT_ROLE.OUT;
        if (full && (nub.nx !== 0 || nub.ny !== 0) && !suppressProng) {
          // A short prong from the terminal cell edge to the nub centre.
          gTerm
            .moveTo(cx - nub.nx * NUB_HALF, cy - nub.ny * NUB_HALF)
            .lineTo(cx, cy)
            .stroke({ width: CABLE_WIDTH, color: accents.electric, alpha: 1, cap: 'round' });
        }
        if (stampsGlyph) {
          // FEEL-04 (D-01): a kind-9 ENDPOINT end stamps the asymmetric inlet glyph
          // (notched socket + directional chevron) so the wire is legible AT REST. This
          // overturns the Phase-43 no-new-marker decision (D-03). Below the LOD cut it
          // falls back to the plain square, mirroring the prong-stem gate above. Same
          // electric fill as the plain square: SHAPE, not colour, is the differentiator
          // (greyscale-safe).
          //
          // THE ROLE IS PASSED (72-09 R-60). The chevron mirrors for a Role::Out
          // terminal so the arrow points the way traffic actually goes at that nub.
          // This stamp has never referenced the role, and under D-04 both cables now
          // terminate at the Route - so without it the FORWARD cable's glyph would sit
          // on the Route's Out nub pointing INTO the port the request is leaving from.
          for (const r of inletGlyphRects(nub.nx, nub.ny, nub.role)) {
            gTerm.rect(cx + r.x, cy + r.y, r.w, r.h);
          }
          gTerm.fill({ color: accents.electric, alpha: 1 });
        } else {
          gTerm.rect(cx - NUB_HALF, cy - NUB_HALF, NUB_HALF * 2, NUB_HALF * 2).fill({
            color: accents.electric,
            alpha: 1,
          });
        }
      }

      // 3) The in-flight pulses via the render-side latch (RENDER-03). Register each
      // newly-observed pulse ONCE (keyed `${entry_tick}|${direction}` - entry_tick is
      // monotonic so it never repeats; direction separates a same-tick forward+reply),
      // anchoring `entryClock = effectiveClock` at first sighting and NEVER overwriting
      // (Pitfall 3). Then render + retire EVERY live latch for the wire - not just the
      // currently-observed pulses - so the comet keeps sweeping after the ~1-tick core
      // pulse leaves `wire.pulses[]` (active-set: an idle wire with no latch animates
      // nothing). Render-only interpolation; no write-back.
      let wl = latches.get(wire.id);
      if (!wl) {
        wl = new Map();
        latches.set(wire.id, wl);
      }
      let rh = retiredHwm.get(wire.id);
      if (!rh) {
        rh = new Map();
        retiredHwm.set(wire.id, rh);
      }
      for (const pulse of wire.pulses) {
        const k = `${pulse.entry_tick}|${pulse.direction}`;
        // WR-03 guard: skip a pulse that already swept home + retired (its entry_tick is
        // <= the retired high-water-mark for its direction). entry_tick is monotonic, so
        // this only ever suppresses a LINGERING pulse - it can never reject a genuinely
        // new one - keeping observable behaviour identical for WIRE_HOP_TICKS=1.
        const hwm = rh.get(pulse.direction);
        if (hwm !== undefined && pulse.entry_tick <= hwm) continue;
        if (!wl.has(k)) {
          wl.set(k, {
            entryClock: effectiveClock,
            direction: pulse.direction,
            entryTick: pulse.entry_tick,
          });
        }
      }
      for (const [k, l] of wl) {
        const raw = (effectiveClock - l.entryClock) / VISUAL_HOP_TICKS;
        const frac = Math.min(Math.max(raw, 0), 1);
        drawComet(l.direction, frac, pl, full, q, grow);
        if (frac >= 1) {
          wl.delete(k); // retire once it reaches home (no map growth)
          // Advance the retired high-water-mark so a lingering pulse cannot re-anchor.
          const prev = rh.get(l.direction);
          if (prev === undefined || l.entryTick > prev) rh.set(l.direction, l.entryTick);
        }
      }
    }

    // 4) THE RE-ROUTE MARKS (plan 75-06, CABLE-07, UI-SPEC 4.2), on `gCable` AFTER every
    // resting cable stroke, so no idle cable crossing a marked one tints it, and below
    // every nub, prong, glyph and comet, which live on `gTerm`. The cable's own drawn
    // polyline, the cable's own width (still true below 50% zoom: both read `strokeW`,
    // the one-screen-pixel floor, plan 75-10), the build accent through the locked skin.
    for (const m of marks) {
      gCable.moveTo(m.pts[0].x, m.pts[0].y);
      for (let i = 1; i < m.pts.length; i++) gCable.lineTo(m.pts[i].x, m.pts[i].y);
      gCable.stroke({
        width: strokeW,
        color: accents.build,
        alpha: m.alpha,
        cap: 'round',
        join: 'round',
      });
    }
  };

  const rerouteMarkStrokes = (): number => {
    const build = skin.palette.accents.build;
    let n = 0;
    for (const ins of gCable.context.instructions) {
      if (ins.action !== 'stroke') continue;
      const style = (ins.data as { style?: { color?: number } }).style;
      if (style?.color === build) n += 1;
    }
    return n;
  };

  const cablePolylines = (): Array<Array<{ x: number; y: number }>> => {
    const build = skin.palette.accents.build;
    // Only the strokes NOT in the build accent: the resting cables. `plottedPolylines` reads a
    // Graphics' `context.instructions` and nothing else, so it is handed the kept instructions
    // in that shape rather than copied here.
    const kept = gCable.context.instructions.filter(
      (ins) =>
        ins.action === 'stroke' && (ins.data as { style?: { color?: number } }).style?.color !== build,
    );
    return plottedPolylines({ context: { instructions: kept } } as unknown as Graphics);
  };

  return { cables, terminals, draw, rerouteMarkStrokes, cablePolylines };
}
