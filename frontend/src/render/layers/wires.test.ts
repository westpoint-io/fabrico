import { beforeAll, describe, expect, it, vi } from 'vitest';

// wires.test.ts - the GPU-free unit gate for the electrical wire render layer
// (WUI-01, plan 40-04; RENDER-03 latch rewrite, plan 42-03). A strict SIBLING of
// belts.test.ts: it mocks `pixi.js` with tiny scene-graph fakes (the wire layer only
// needs Container + Graphics - it draws PURE Graphics primitives, no baked
// Sprite/texture), and drives the layer over hand-built SceneState.wires fixtures.
// Everything is at the primitive/colour level (no pixels), so nothing is a
// render-quarantine candidate.
//
// RENDER-03: the reply comet no longer reads its `frac` from the 1-tick core
// `entry_tick/hop_ticks` (that pinned it at the origin nub). It rides a render-side
// pulse LATCH anchored to `effectiveClock` at first sighting and driven by a
// `VISUAL_HOP_TICKS` render-clock span, so the reply visibly SWEEPS home over ~0.45s.
// This suite asserts the six latch behaviours by DATA (drawn geometry/colours):
//   - sweep: origin -> mid -> home over VISUAL_HOP_TICKS render ticks (frac 0 -> 1),
//   - persistence: the comet keeps advancing after the core pulses[] clears,
//   - retire: at frac>=1 the latch is dropped and no comet is drawn,
//   - GC: a wire that leaves the scene leaves no residual latch (no map leak),
//   - freeze: two draws at the SAME effectiveClock yield the SAME frac (pause proof),
//   - distinctness: a REPLY is an amber ~1.5-CELL comet, a FORWARD a cyan compact
//     spark (the LOCKED Phase-40 visuals - only the frac SOURCE changed).

interface Filled {
  kind: 'circle' | 'rect';
  x: number;
  y: number;
  r?: number;
  w?: number;
  h?: number;
  color: number;
  alpha: number;
}
interface Stroked {
  width: number;
  color: number;
  alpha: number;
}

/**
 * ONE stroked run of `moveTo`/`lineTo` points, with the style the stroke closed it
 * with. The drawn cable IS a polyline, and until plan 66-02 nothing in this
 * repository could describe one: the stub's `moveTo`/`lineTo` took no arguments and
 * dropped every point, so no assertion anywhere named a cable vertex and a wire
 * CORNER had never been asserted at all.
 */
interface Polyline {
  pts: Array<{ x: number; y: number }>;
  width: number;
  color: number;
  alpha: number;
  /** The stroke's cap and join, recorded for the re-route mark's round ends (plan 75-06). */
  cap?: string;
  join?: string;
}

vi.mock('pixi.js', () => {
  class Container {
    children: unknown[] = [];
    addChild(...c: unknown[]): unknown {
      this.children.push(...c);
      return c[0];
    }
    removeChild(c: unknown): unknown {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    destroy(): void {}
  }
  // A recording Graphics: `circle`/`rect` push a PENDING shape; the next `fill`
  // closes every still-open shape with its colour+alpha; `stroke` records the last
  // stroked style. This mirrors the Pixi v8 build-path-then-fill/stroke idiom.
  class Graphics {
    filled: Filled[] = [];
    strokes: Stroked[] = [];
    // Records every STROKED polyline (its vertices, its width, its colour) drawn
    // since the last clear(), so the 66-02 characterisation suite can read the drawn
    // cable's geometry: the straight-run vertex list, the 90-degree turn in a
    // cornered fixture, whether a forward/return pair coincides (D1) and whether the
    // first vertex sits inside the source machine's footprint (D3). The belts.test.ts
    // rule, followed: the recorded field is reset in clear() and is headed by the
    // assertions it exists for.
    polylines: Polyline[] = [];
    private pending: Filled[] = [];
    // The path currently being built. A run that is never stroked drew NOTHING, so it
    // is discarded rather than recorded - the same "a stroke consumes any open path"
    // reading the existing stroke() comment already states, from the other side.
    private open: Array<{ x: number; y: number }> = [];
    clear(): this {
      this.filled = [];
      this.strokes = [];
      this.polylines = [];
      this.pending = [];
      this.open = [];
      return this;
    }
    circle(x: number, y: number, r: number): this {
      this.pending.push({ kind: 'circle', x, y, r, color: 0, alpha: 1 });
      return this;
    }
    rect(x: number, y: number, w: number, h: number): this {
      this.pending.push({ kind: 'rect', x, y, w, h, color: 0, alpha: 1 });
      return this;
    }
    moveTo(x: number, y: number): this {
      // A new subpath: anything still open was never stroked and drew nothing.
      this.open = [{ x, y }];
      return this;
    }
    lineTo(x: number, y: number): this {
      this.open.push({ x, y });
      return this;
    }
    fill(style: number | { color: number; alpha?: number }): this {
      const color = typeof style === 'number' ? style : style.color;
      const alpha = typeof style === 'number' ? 1 : (style.alpha ?? 1);
      for (const s of this.pending) {
        s.color = color;
        s.alpha = alpha;
        this.filled.push(s);
      }
      this.pending = [];
      this.open = [];
      return this;
    }
    stroke(style: { width?: number; color: number; alpha?: number; cap?: string; join?: string }): this {
      this.strokes.push({ width: style.width ?? 1, color: style.color, alpha: style.alpha ?? 1 });
      // A stroke also consumes any open path without filling it.
      this.pending = [];
      // ... and it is what CLOSES a polyline: a run of two or more points is now a
      // drawn line with a width and a colour, which is the thing an assertion can
      // describe. Single-point runs drew nothing and are dropped.
      if (this.open.length >= 2) {
        this.polylines.push({
          pts: this.open,
          width: style.width ?? 1,
          color: style.color,
          alpha: style.alpha ?? 1,
          cap: style.cap,
          join: style.join,
        });
      }
      this.open = [];
      return this;
    }
    destroy(): void {}
  }
  return { Container, Graphics };
});

const { createWireLayer, CABLE_LANE_OFFSET } = await import('./wires.ts');
const { LOCKED_SKIN } = await import('../synth/skins/locked.ts');
const { CELL } = await import('../../../shared/geometry.ts');
const { nubAnchor, unitDelta } = await import('../../protocol/ports.ts');
const { machine_kind } = await import('../../protocol/kinds.ts');
const { inletGlyphRects } = await import('./inletGlyph.ts');
const { PORT_ROLE: WIRE_PORT_ROLE } = await import('../../protocol/ports.ts');
// The REAL scene buffer (CR-01, plan 76-14): the keyframe case builds its scenes through
// the real createSceneState and applyPacket, never `as unknown as SceneState` fixtures.
const sceneStateModule = await import('../sceneState.ts');

/**
 * The ROLE the `dockedWireScene` fixture's endpoint port carries, and therefore the role
 * the glyph's chevron must mirror for (72-09 R-60). It is a named constant rather than a
 * literal at each call site so a change to the fixture has ONE place to come through,
 * and `the fixture's endpoint port really carries the role the expectations assume`
 * below asserts the two have not drifted apart - without it every expectation here would
 * be derived from an assumption nothing checks.
 */
const FIXTURE_ENDPOINT_ROLE = WIRE_PORT_ROLE.OUT;
const { snapToDevicePixel } = await import('./items.ts');
const { wireRoute, bodyOfNode } = await import('../../protocol/wireRoute.ts');
const { effectiveBox } = await import('../../protocol/footprint.ts');
type SceneStateT = import('../sceneState.ts').SceneState;
type WireViewT = import('../../protocol/decode.ts').WireView;
type WirePulseViewT = import('../../protocol/decode.ts').WirePulseView;
type TileViewT = import('../../protocol/decode.ts').TileView;
type NodeViewT = import('../../protocol/decode.ts').NodeView;

const FORWARD = 0;
const REPLY = 1;

// The real core hop is 1 tick (WIRE_HOP_TICKS=1); the latch drives the sweep from
// VISUAL_HOP_TICKS instead, so these fixtures carry the honest hop_ticks=1 to prove
// the frac no longer comes from the raw hop.
const replyPulse = (): WirePulseViewT[] =>
  [{ entry_tick: 0, hop_ticks: 1, direction: REPLY }] as WirePulseViewT[];
const forwardPulse = (): WirePulseViewT[] =>
  [{ entry_tick: 0, hop_ticks: 1, direction: FORWARD }] as WirePulseViewT[];

/** A straight horizontal wire tile at (cx, cy). */
const straight = (cx: number, cy: number): TileViewT =>
  ({ cell_x: cx, cell_y: cy, kind: { Straight: { axis: 0 } } }) as TileViewT;

/** A 4-tile straight electrical wire (cell centres x = 2.5..5.5 * CELL), optionally carrying pulses. */
function wireScene(pulses: WirePulseViewT[], tick = 0): SceneStateT {
  const wire: WireViewT = {
    id: 1,
    from: { node: 10, port: 0 },
    to: { node: 11, port: 0 },
    path: [straight(2, 5), straight(3, 5), straight(4, 5), straight(5, 5)],
    pulses,
  };
  return {
    tick,
    nodes: new Map(),
    belts: new Map(),
    wires: new Map([[1, wire]]),
    canUndo: false,
    canRedo: false,
  } as unknown as SceneStateT;
}

/**
 * A docked-endpoint scene (FEEL-04): the SAME 4-tile wire as `wireScene` but with a
 * POPULATED nodes map so `resolveNub` resolves real docks. Node 10 is a kind-9
 * ENDPOINT whose single port faces `endpointSide`; node 11 is a kind-2 handler with
 * a W-facing port. `endpointAt` picks which wire dock (`from`/`to`) the endpoint
 * occupies, so both polarities are testable. Distinct from `wireScene`/`emptyScene`,
 * whose EMPTY nodes maps are load-bearing for the unresolved-fallback tests.
 */
function dockedWireScene(endpointSide: number, endpointAt: 'from' | 'to'): SceneStateT {
  const endpoint: NodeViewT = {
    id: 10,
    kind: machine_kind.ENDPOINT,
    cell_x: 1,
    cell_y: 5,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 1, cell_y: 5, side: endpointSide, role: 1, medium: 1 }],
    load: 0,
  };
  const handler: NodeViewT = {
    id: 11,
    kind: 2,
    cell_x: 6,
    cell_y: 5,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 6, cell_y: 5, side: 3, role: 0, medium: 1 }],
    load: 0,
  };
  const epDock = { node: 10, port: 0 };
  const hDock = { node: 11, port: 0 };
  const wire: WireViewT = {
    id: 1,
    from: endpointAt === 'from' ? epDock : hDock,
    to: endpointAt === 'from' ? hDock : epDock,
    path: [straight(2, 5), straight(3, 5), straight(4, 5), straight(5, 5)],
    pulses: [],
  };
  return {
    tick: 0,
    nodes: new Map([
      [10, endpoint],
      [11, handler],
    ]),
    belts: new Map(),
    wires: new Map([[1, wire]]),
    canUndo: false,
    canRedo: false,
  } as unknown as SceneStateT;
}

/** The snapped nub centre + outward normal for a port, derived via the SHARED math. */
function snappedNub(
  cellX: number,
  cellY: number,
  side: number,
): { cx: number; cy: number; nx: number; ny: number } {
  const { x, y } = nubAnchor(cellX, cellY, side);
  const [nx, ny] = unitDelta(side);
  return { cx: snapToDevicePixel(x, 1), cy: snapToDevicePixel(y, 1), nx, ny };
}

/** A scene with NO wires (the wire has left the scene) - drives the latch GC path. */
function emptyScene(): SceneStateT {
  return {
    tick: 0,
    nodes: new Map(),
    belts: new Map(),
    wires: new Map(),
    canUndo: false,
    canRedo: false,
  } as unknown as SceneStateT;
}

/**
 * The MERGED recorder view over the split layer's two Graphics, cables first then
 * terminals (plan 66-05).
 *
 * Before the split there was one Container holding one Graphics and this helper read
 * `layer.layer.children[0]`. `layer` is gone; `cables` and `terminals` replaced it. The
 * merge is what keeps all 21 pre-existing test bodies BYTE-UNCHANGED across the split:
 * every one of them filters by kind, colour or alpha, or uses `.find(...)`, so a
 * concatenated view answers each of them exactly as the single Graphics did. The one
 * order-sensitive case (the per-frame idempotence check, which compares whole arrays
 * across two draws) also holds, because concatenation is deterministic.
 *
 * `cablesGfx` / `terminalsGfx` below are the UNMERGED accessors. Reach for those when
 * the point of the assertion IS the separation.
 */
type Recorder = { filled: Filled[]; strokes: Stroked[]; polylines: Polyline[] };
type SplitLayer = { cables: { children: unknown[] }; terminals: { children: unknown[] } };

const cablesGfx = (layer: SplitLayer): Recorder => layer.cables.children[0] as Recorder;
const terminalsGfx = (layer: SplitLayer): Recorder => layer.terminals.children[0] as Recorder;

function gfx(layer: SplitLayer): { filled: Filled[]; strokes: Stroked[] } {
  const c = cablesGfx(layer);
  const t = terminalsGfx(layer);
  return { filled: [...c.filled, ...t.filled], strokes: [...c.strokes, ...t.strokes] };
}

/** Circles (comet heads/tails) filled with a given accent colour. */
const circlesOf = (g: { filled: Filled[] }, color: number): Filled[] =>
  g.filled.filter((f) => f.kind === 'circle' && f.color === color);

/** The opaque r=3 comet head of a given accent colour (alpha ~1), if drawn. */
const headOf = (g: { filled: Filled[] }, color: number): Filled | undefined =>
  circlesOf(g, color).find((c) => c.r === 3 && c.alpha > 0.9);

// CHROME-19 (phase 92, D-10, UI-SPEC 4.2 and 4.3): THE RESTING CABLE READS APART FROM THE GRID.
// A GRADED PROPERTY, not a pin on a constant: the resting stroke's colour and alpha are read off
// the drawn cables Graphics, composited over the floor exactly as the canvas does with antialias
// off (one colour per covered pixel), and graded by WCAG relative luminance against the floor
// (`ramp[0]`) and against the major grid line (`ramp[2]`, stroked opaque at 1.5 screen px by
// `grid.ts`, so every pixel it covers is `ramp[2]` itself). The old cable, `ramp[3]` at alpha 0.35,
// composited to a dimmer copy of the grid's own grey: 1.35:1 on the floor and 1.22:1 against the
// major line (walk-114's "stray rectangle outlines"). The helpers copy `overlay.test.ts`'s shape.
describe('wires - the resting cable reads apart from the grid (CHROME-19, D-10)', () => {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb: number): number =>
    0.2126 * lin((rgb >> 16) & 255) + 0.7152 * lin((rgb >> 8) & 255) + 0.0722 * lin(rgb & 255);
  const over = (fg: number, bg: number, a: number): number =>
    [16, 8, 0].reduce((acc, sh) => acc | (Math.round(a * ((fg >> sh) & 255) + (1 - a) * ((bg >> sh) & 255)) << sh), 0);
  const ratio = (a: number, b: number): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

  it('the resting cable reads apart from the floor and the major grid line', () => {
    const { ramp, accents } = LOCKED_SKIN.palette;
    const floor = ramp[0];
    const major = ramp[2];
    // Full zoom (scale 1) and below the wire LOD cut (scale 0.25: 8 px a cell, under 16).
    for (const zoom of [1, 0.25]) {
      const layer = createWireLayer(LOCKED_SKIN, () => zoom, () => zoom);
      layer.draw(wireScene([]), 0, 0);
      const resting = cablesGfx(layer as unknown as SplitLayer).polylines;
      expect(resting, `one wire strokes one resting cable at zoom ${zoom}`).toHaveLength(1);
      const { color, alpha } = resting[0];
      const ink = over(color, floor, alpha);
      const onFloor = ratio(ink, floor);
      const onMajor = ratio(ink, major);
      expect(
        {
          floorAtLeast3: onFloor >= 3,
          majorAtLeast2: onMajor >= 2,
          notElectric: color !== accents.electric,
          notBuild: color !== accents.build,
        },
        `RED-FIRST CHROME-19-colour-unit: at zoom ${zoom} the resting cable ${hex(color)} at alpha ${alpha} composites to ` +
          `${hex(ink)} over the floor ${hex(floor)}: ${onFloor.toFixed(2)}:1 against the floor (needs 3:1) and ` +
          `${onMajor.toFixed(2)}:1 against the major grid line ${hex(major)} (needs 2:1), and is neither the electric ` +
          `accent (terminals, the request spark) nor the build accent (the re-route mark)`,
      ).toEqual({ floorAtLeast3: true, majorAtLeast2: true, notElectric: true, notBuild: true });
    }
  });
});

describe('wires - dormant cable when idle (E1, the belt-vs-wire contrast)', () => {
  it('an idle wire draws ONLY the palette.cable cable at alpha 1 and emits no comet', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(wireScene([]), 0, 0);
    const g = gfx(layer);

    // The dormant cable: a stroke in palette.cable at alpha 1 (taut, static; D-10).
    const cable = g.strokes.find((s) => s.color === LOCKED_SKIN.palette.cable && s.alpha === 1);
    expect(cable, 'the dormant cable is a palette.cable stroke at alpha 1').toBeDefined();
    expect(cable!.width).toBe(2);

    // No comet: an idle wire animates nothing (no head/tail circles at all).
    expect(g.filled.filter((f) => f.kind === 'circle')).toHaveLength(0);
    // No colour is the electric or item accent among comet primitives.
    expect(circlesOf(g, LOCKED_SKIN.palette.accents.electric)).toHaveLength(0);
    expect(circlesOf(g, LOCKED_SKIN.palette.accents.item)).toHaveLength(0);
  });

  it('the electrical nub is a SQUARE (rect), shape-distinct from the round belt cap', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(wireScene([]), 0, 0);
    const g = gfx(layer);
    const nubs = g.filled.filter((f) => f.kind === 'rect');
    // Two terminals, both filled with the electric accent, square (w === h).
    expect(nubs.length).toBeGreaterThanOrEqual(2);
    for (const n of nubs) {
      expect(n.color).toBe(LOCKED_SKIN.palette.accents.electric);
      expect(n.w).toBe(n.h);
      expect(n.w).toBe(10); // 5px half-extent -> 10px square terminal
    }
  });
});

describe('wires - reply comet sweeps home via the render-clock latch (RENDER-03)', () => {
  it('sweeps origin -> mid -> home over VISUAL_HOP_TICKS render ticks (frac 0 -> 0.5 -> 1)', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    // First sighting at C0=100: the latch anchors HERE (frac 0) -> head at the ORIGIN nub.
    layer.draw(wireScene(replyPulse()), 100, 100);
    const h0 = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item);
    expect(h0, 'a reply comet head exists at first sighting').toBeDefined();
    expect(h0!.x, 'frac 0 -> the origin (tail) end').toBeCloseTo(2.5 * CELL, 0); // 80

    // +14 render ticks -> frac ~0.5 -> head at mid-cable.
    layer.draw(wireScene(replyPulse()), 114, 114);
    const hMid = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item);
    expect(hMid!.x, 'frac ~0.5 -> mid-cable').toBeCloseTo(4 * CELL, 0); // 128

    // +28 render ticks -> frac 1 -> head HOME (delivery end); drawn then retired.
    layer.draw(wireScene(replyPulse()), 128, 128);
    const hHome = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item);
    expect(hHome!.x, 'frac 1 -> home (delivery) end').toBeCloseTo(5.5 * CELL, 0); // 176
  });

  it('persists after the 1-tick core pulse clears (pulses[] empty) and keeps advancing', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(wireScene(replyPulse()), 100, 100); // latch registered
    // The core pulse lives ~1 tick: subsequent frames observe an EMPTY pulses[], yet
    // the visual sweep must continue from the latch (this is the whole point).
    layer.draw(wireScene([]), 114, 114);
    const h = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item);
    expect(h, 'the comet persists after pulses[] clears').toBeDefined();
    expect(h!.x, 'it keeps sweeping (frac ~0.5) with no observed pulse').toBeCloseTo(4 * CELL, 0);
  });

  it('retires the latch at frac>=1 (no comet after it reaches home)', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(wireScene(replyPulse()), 100, 100);
    layer.draw(wireScene([]), 128, 128); // frac 1 -> drawn at home, then retired
    expect(
      headOf(gfx(layer), LOCKED_SKIN.palette.accents.item),
      'the comet is still drawn on the frac=1 frame',
    ).toBeDefined();
    layer.draw(wireScene([]), 130, 130); // latch gone -> nothing left to draw
    expect(
      circlesOf(gfx(layer), LOCKED_SKIN.palette.accents.item),
      'no comet after the latch retires',
    ).toHaveLength(0);
  });

  it('GCs the latch when the wire leaves the scene (no map leak, restarts fresh on re-add)', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(wireScene(replyPulse()), 100, 100); // latch created for wire 1 at entryClock 100
    layer.draw(emptyScene(), 114, 114); // wire 1 gone -> latch GC'd, no comet
    expect(
      circlesOf(gfx(layer), LOCKED_SKIN.palette.accents.item),
      'no comet for an absent wire',
    ).toHaveLength(0);
    // Re-add the SAME wire+pulse far in the future. A leaked latch would still read
    // frac>=1 (home); a GC'd latch re-anchors NOW -> frac 0 back at the origin nub.
    layer.draw(wireScene(replyPulse()), 128, 128);
    const h = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item);
    expect(h!.x, 'a re-added wire restarts its sweep at the origin (latch was GC-d)').toBeCloseTo(
      2.5 * CELL,
      0,
    );
  });

  it('freezes mid-sweep on pause: two draws at the SAME effectiveClock give the SAME frac', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(wireScene(replyPulse()), 100, 100);
    layer.draw(wireScene(replyPulse()), 114, 114); // frac ~0.5
    const before = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item)!.x;
    // Paused: the render clock does not advance, so a redraw at the SAME clock is identical.
    layer.draw(wireScene(replyPulse()), 114, 114);
    const after = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item)!.x;
    expect(after, 'a paused redraw does not advance the sweep').toBe(before);
    expect(after).toBeCloseTo(4 * CELL, 0);
  });
});

describe('wires - rewind resets the retired high-water-mark (replay/time-travel safety)', () => {
  it('a scene-tick regression clears retiredHwm so a replayed pulse re-registers at frac 0', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    // Forward run at scene tick 50: latch at C=100, sweep home at C=128, retire.
    layer.draw(wireScene(replyPulse(), 50), 100, 100);
    layer.draw(wireScene([], 50), 128, 128); // frac 1 -> retired, hwm[REPLY] = 0
    layer.draw(wireScene([], 50), 130, 130);
    expect(
      circlesOf(gfx(layer), LOCKED_SKIN.palette.accents.item),
      'the comet is retired after sweeping home',
    ).toHaveLength(0);

    // Forward control: the SAME pulse lingering at the SAME scene tick stays
    // suppressed by the WR-03 guard (entry_tick 0 <= hwm 0) - no re-anchor.
    layer.draw(wireScene(replyPulse(), 50), 140, 140);
    expect(
      circlesOf(gfx(layer), LOCKED_SKIN.palette.accents.item),
      'a lingering pulse at the same tick stays suppressed (WR-03 guard intact)',
    ).toHaveLength(0);

    // REWIND: the scene clock moves BACKWARD (replay/scrub repopulates the maps in
    // place with the same wire id). The stale hwm must NOT swallow the replayed
    // pulse: the reset re-registers it and the comet restarts at the origin nub.
    layer.draw(wireScene(replyPulse(), 10), 200, 200);
    const h = headOf(gfx(layer), LOCKED_SKIN.palette.accents.item);
    expect(h, 'a replayed pulse after a rewind re-registers (comet fires again)').toBeDefined();
    expect(h!.x, 'the replayed comet restarts its sweep at the origin').toBeCloseTo(2.5 * CELL, 0);
  });
});

// CR-01 (76-REVIEW, plan 76-14): the host mints node, belt and wire handles from ONE
// counter (render_packet.rs ~750-755), and every keyframe (undo, redo, load, New, a scene
// swap, a resync after a `RenderProducer::reset`) restarts it. So a `full` packet can hand
// wire handle 5 from cable A to cable B. The comet latches and the retired marks are keyed
// by wire handle, and neither of the two ways they forgot a handle saw this:
//   - the presence GC (wires.ts, the `scene.wires.has` loops) drops an entry only when its
//     handle is ABSENT, and handle 5 is present on both frames;
//   - the rewind guard (wires.ts, `scene.tick < lastSceneTick`) clears only when the tick
//     moves BACKWARD, and an Undo or Redo keyframe moves it forward by one (the shape
//     strandedDocks.ts gate 1 relies on).
// So A's in-flight reply comet kept sweeping, drawn along B's path. Both scenes are built
// through the real createSceneState and applyPacket, so the case runs the keyframe count
// end to end and cannot pass on a count that never moves.
// RED AT THE TEST-ONLY COMMIT: "no reply comet anywhere: cable B never carried
// one, and A's must not cross to it: expected [ { row: 9, x: 80 }, …(8) ] to deeply equal []",
// both controls green.
describe('wires - a keyframe that remints a wire handle (CR-01, plan 76-14)', () => {
  const { createSceneState, applyPacket } = sceneStateModule;
  type RenderPacketT = import('../../protocol/decode.ts').RenderPacket;

  /** The sceneState.test.ts `packet` builder shape; every tick below is set explicitly. */
  const packet = (p: Partial<RenderPacketT>): RenderPacketT => ({
    tick: 0,
    full: false,
    placed: [],
    removed: [],
    belts: [],
    can_undo: false,
    can_redo: false,
    wires: [],
    resync: false,
    generation: 0,
    swap_floor: 0,
    ...p,
  });

  /** A four-tile straight cable on `row` (cells 2..5), on wire handle 5. */
  const cableOnRow = (row: number, pulses: WirePulseViewT[]): WireViewT => ({
    id: 5,
    from: { node: 10, port: 0 },
    to: { node: 11, port: 0 },
    path: [straight(2, row), straight(3, row), straight(4, row), straight(5, row)],
    pulses,
  });

  const T = 50;

  it('a_comet_never_crosses_to_another_cable_across_a_keyframe', () => {
    const { item, electric } = LOCKED_SKIN.palette.accents;
    const layer = createWireLayer(LOCKED_SKIN);
    const scene = createSceneState();

    // Packet 1, a keyframe at tick T: handle 5 is cable A on row 5, carrying a REPLY pulse.
    applyPacket(
      scene,
      packet({
        tick: T,
        full: true,
        wires: [cableOnRow(5, [{ entry_tick: T, hop_ticks: 1, direction: REPLY }])],
      }),
    );
    const tickAtFirstDraw = scene.tick;
    layer.draw(scene, 100, 100);
    const headA = headOf(gfx(layer), item);
    expect(headA, 'POSITIVE CONTROL: cable A draws its reply comet head').toBeDefined();
    expect(Math.floor(headA!.y / CELL), "POSITIVE CONTROL: A's comet head sits on row 5").toBe(5);

    // Packet 2, a keyframe ONE tick later (an Undo or Redo): handle 5 is now cable B on
    // row 9, with no pulse at all.
    applyPacket(
      scene,
      packet({ tick: T + 1, full: true, wires: [cableOnRow(9, [])] }),
    );
    const tickAtSecondDraw = scene.tick;
    expect(
      [tickAtFirstDraw, tickAtSecondDraw],
      'TICK MOVED FORWARD: T at the first draw, T + 1 at the second, so the rewind guard is not the path under test',
    ).toEqual([T, T + 1]);

    // Clock 110: A's latch, had it survived, would be at frac about 0.36, drawn on B's row.
    layer.draw(scene, 110, 110);
    const g = gfx(layer);
    expect(
      circlesOf(g, item).map((c) => ({ row: Math.floor(c.y / CELL), x: c.x })),
      "no reply comet anywhere: cable B never carried one, and A's must not cross to it",
    ).toEqual([]);
    expect(circlesOf(g, electric), 'no forward spark anywhere either').toEqual([]);
  });
});

describe('wires - forward vs reply distinctness (WUI-01, LOCKED Phase-40 visuals fed via the latch)', () => {
  it('a FORWARD pulse is a cyan compact spark; a REPLY pulse an amber ~1.5-CELL comet', () => {
    // Drive both to mid-sweep (frac ~0.5) THROUGH the latch (register, then advance).
    const fwd = createWireLayer(LOCKED_SKIN);
    fwd.draw(wireScene(forwardPulse()), 100, 100);
    fwd.draw(wireScene(forwardPulse()), 114, 114);
    const cyan = circlesOf(gfx(fwd), LOCKED_SKIN.palette.accents.electric);
    expect(cyan.length, 'a forward spark emits cyan circles').toBeGreaterThan(0);
    expect(
      headOf(gfx(fwd), LOCKED_SKIN.palette.accents.electric),
      'the forward head is an alpha-1 r=3 cyan core',
    ).toBeDefined();
    expect(
      circlesOf(gfx(fwd), LOCKED_SKIN.palette.accents.item),
      'a forward pulse is never amber',
    ).toHaveLength(0);

    const rep = createWireLayer(LOCKED_SKIN);
    rep.draw(wireScene(replyPulse()), 100, 100);
    rep.draw(wireScene(replyPulse()), 114, 114);
    const amber = circlesOf(gfx(rep), LOCKED_SKIN.palette.accents.item);
    expect(amber.length, 'a reply comet emits amber circles').toBeGreaterThan(0);
    expect(
      headOf(gfx(rep), LOCKED_SKIN.palette.accents.item),
      'the reply head is an alpha-1 r=3 amber core',
    ).toBeDefined();
    // The distinct "coming home" cue: the reply glow has MORE tail samples than the
    // compact forward spark (a ~1.5-CELL glow vs a ~0.3-CELL tail).
    expect(amber.length).toBeGreaterThan(cyan.length);
    // The glow fades (alpha compositing, never a brightness multiply): at least one
    // tail circle sits at a partial alpha strictly between 0 and the head's alpha.
    expect(amber.some((c) => c.alpha > 0 && c.alpha < 0.9)).toBe(true);
    // No cyan on a reply.
    expect(
      circlesOf(gfx(rep), LOCKED_SKIN.palette.accents.electric),
      'a reply pulse is never cyan',
    ).toHaveLength(0);
  });

  it('N concurrent pulses render N independent heads (zero-one-many)', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    const pulses = [
      { entry_tick: 0, hop_ticks: 1, direction: FORWARD },
      { entry_tick: 0, hop_ticks: 1, direction: REPLY },
    ] as WirePulseViewT[];
    layer.draw(wireScene(pulses), 100, 100);
    layer.draw(wireScene(pulses), 114, 114); // both mid-sweep via the latch
    const g = gfx(layer);
    const cyanHead = circlesOf(g, LOCKED_SKIN.palette.accents.electric).filter(
      (c) => c.r === 3 && c.alpha > 0.9,
    );
    const amberHead = circlesOf(g, LOCKED_SKIN.palette.accents.item).filter(
      (c) => c.r === 3 && c.alpha > 0.9,
    );
    expect(cyanHead).toHaveLength(1);
    expect(amberHead).toHaveLength(1);
  });
});

describe('wires - LOD hard-cut at 16px (reuse the belt cut)', () => {
  it('below scale*CELL < 16 a pulse is a single bright dot with NO tail', () => {
    let z = 1;
    const layer = createWireLayer(LOCKED_SKIN, () => z, () => 1);
    z = 0.25; // scale*CELL = 8 < 16 -> LOD low
    layer.draw(wireScene(replyPulse()), 2, 2);
    const g = gfx(layer);
    const amber = circlesOf(g, LOCKED_SKIN.palette.accents.item);
    // Exactly one dot, no glow tail (the fine comet tail would smear at low zoom).
    expect(amber, 'one bright dot, no tail below the LOD cut').toHaveLength(1);
    expect(amber[0].alpha).toBeGreaterThan(0.9);
  });

  it('at exactly scale*CELL === 16 the full comet (head + tail) returns (inclusive cut)', () => {
    let z = 1;
    const layer = createWireLayer(LOCKED_SKIN, () => z, () => 1);
    z = 16 / CELL; // scale*CELL === 16 -> inclusive -> full comet
    layer.draw(wireScene(replyPulse()), 2, 2);
    const amber = circlesOf(gfx(layer), LOCKED_SKIN.palette.accents.item);
    expect(amber.length, 'the full reply comet has a head + glow tail at the cut').toBeGreaterThan(1);
  });
});

describe('wires - endpoint inlet terminal (FEEL-04, D-01: legible at rest)', () => {
  /** All filled rects, projected to bare geometry for deep-equality asserts. */
  const rectsOf = (g: { filled: Filled[] }): Filled[] => g.filled.filter((f) => f.kind === 'rect');
  const geomOf = (r: Filled): { x: number; y: number; w: number; h: number } => ({
    x: r.x,
    y: r.y,
    w: r.w!,
    h: r.h!,
  });

  it('a kind-9 dock at `from` stamps the shared inlet glyph; the handler end stays one plain 10x10 square', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    // E-facing endpoint port, AT REST: no pulses, clock 0, scale 1, quantum 1.
    layer.draw(dockedWireScene(1, 'from'), 0, 0);
    const g = gfx(layer);
    const rects = rectsOf(g);

    // (a) The endpoint end: the recorded rects equal EXACTLY the shared module's
    // output translated by the snapped centre (shared-source proof, no hand-copied
    // coordinates), every one filled electric at alpha 1.
    const ep = snappedNub(1, 5, 1);
    const expected = inletGlyphRects(ep.nx, ep.ny, FIXTURE_ENDPOINT_ROLE).map((r) => ({
      x: ep.cx + r.x,
      y: ep.cy + r.y,
      w: r.w,
      h: r.h,
    }));
    const glyph = rects.filter((f) => !(f.w === 10 && f.h === 10));
    expect(glyph.map(geomOf)).toEqual(expected);
    for (const r of glyph) {
      expect(r.color).toBe(LOCKED_SKIN.palette.accents.electric);
      expect(r.alpha).toBe(1);
    }

    // (b) The handler end: exactly ONE plain 10x10 square centred on its snapped anchor.
    const h = snappedNub(6, 5, 3);
    const squares = rects.filter((f) => f.w === 10 && f.h === 10);
    expect(squares).toHaveLength(1);
    expect(geomOf(squares[0])).toEqual({ x: h.cx - 5, y: h.cy - 5, w: 10, h: 10 });
    expect(squares[0].color).toBe(LOCKED_SKIN.palette.accents.electric);
    expect(squares[0].alpha).toBe(1);
  });

  it("the fixture's endpoint port really carries the role the expectations assume", () => {
    // The non-vacuity arm for every `FIXTURE_ENDPOINT_ROLE` use above and below. If the
    // fixture's port role drifted, the expectations would keep agreeing with themselves
    // while the shipped glyph mirrored the other way.
    const scene = dockedWireScene(1, 'from');
    expect(scene.nodes.get(10)!.ports[0].role).toBe(FIXTURE_ENDPOINT_ROLE);
  });

  it('the chevron follows the PORT ROLE, not a constant - an In-role Route mirrors the other way', () => {
    // THE ASSERTION THAT SAYS `wires.ts` READS THE ROLE AT ALL (72-09 R-60). Every other
    // case in this block uses the fixture's Out port, so a `wires.ts` that hard-coded
    // Role::In would redden them all together and a reader could not tell "it ignores the
    // role" from "it mirrors the wrong way". This drives the SAME board with an In-role
    // Route port and requires the OTHER glyph, so the two readings are separated.
    //
    // It matters because under D-04 both cables terminate at the Route: the forward
    // cable's glyph sits on the Out nub and the return cable's on the In nub, on ONE
    // board, and they must not be the same arrow.
    const scene = dockedWireScene(1, 'from');
    const ep = scene.nodes.get(10)!;
    scene.nodes.set(10, {
      ...ep,
      ports: [{ ...ep.ports[0], role: WIRE_PORT_ROLE.IN }],
    });
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(scene, 0, 0);
    const rects = rectsOf(gfx(layer));

    const n = snappedNub(1, 5, 1);
    const inExpected = inletGlyphRects(n.nx, n.ny, WIRE_PORT_ROLE.IN).map((r) => ({
      x: n.cx + r.x,
      y: n.cy + r.y,
      w: r.w,
      h: r.h,
    }));
    const glyph = rects.filter((f) => !(f.w === 10 && f.h === 10));
    expect(glyph.map(geomOf)).toEqual(inExpected);
    // ...and that really is a DIFFERENT glyph from the Out one, or the case proves nothing.
    const outExpected = inletGlyphRects(n.nx, n.ny, WIRE_PORT_ROLE.OUT).map((r) => ({
      x: n.cx + r.x,
      y: n.cy + r.y,
      w: r.w,
      h: r.h,
    }));
    expect(inExpected).not.toEqual(outExpected);
  });

  // ─────────── The maintainer's 2026-09-03 ruling: the Out prong stem is SUPPRESSED ───────────
  //
  // THIS BLOCK OVERRIDES 72-09 R-60 / 72-UI-SPEC 5.4 DELIBERATELY, and it is the
  // machine-checkable half of that override. R-60 mirrored the chevron for a
  // `Role::Out` terminal and locked the socket rects still; it did NOT account for the
  // 2px prong stem, whose run is `u in [-NUB_HALF, 0]`. The MIRRORED chevron's arms
  // land at `u in [-2, 0)`, INSIDE that run, so arms and stem fuse into a solid bar and
  // the silhouette reads as a plus rather than an arrow at 1x.
  //
  // The maintainer chose candidate 2 of the three costed in `72-09-SUMMARY.md`: suppress the stem
  // on a glyph-stamping Out terminal. These two cases are what stops a later reader
  // "restoring" the stem for symmetry - the FIRST asserts the suppression and the
  // SECOND asserts that an In-role terminal still gets its stem, so a blanket
  // suppression that killed every prong would fail here rather than pass both.
  //
  // The prongs are counted by COLOUR out of the terminals Graphics, exactly as the
  // characterisation block below does; `the cable colour and the prong colour are
  // DISTINCT` is the non-vacuity arm for that filter and it lives there.
  const prongsOf = (layer: ReturnType<typeof createWireLayer>): Polyline[] =>
    terminalsGfx(layer as unknown as SplitLayer).polylines.filter(
      (p) => p.color === LOCKED_SKIN.palette.accents.electric,
    );

  it('a glyph-stamping Role::Out terminal strokes NO prong stem, so the mirrored chevron cannot fuse with it', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(dockedWireScene(1, 'from'), 0, 0);

    // The fixture's endpoint carries Role::Out (asserted non-vacuously above), so the
    // ONLY prong left on this board belongs to the kind-2 handler at the other end.
    const prongs = prongsOf(layer);
    expect(
      prongs,
      'exactly ONE prong is stroked: the handler end keeps its stem, the glyph-stamping Out end does not',
    ).toHaveLength(1);

    const h = snappedNub(6, 5, 3);
    expect(
      prongs[0].pts,
      'and the surviving prong is the HANDLER end, running along its own outward normal',
    ).toEqual([
      { x: h.cx - h.nx * 5, y: h.cy - h.ny * 5 },
      { x: h.cx, y: h.cy },
    ]);
  });

  it('an In-role Route terminal DOES keep its prong stem: the suppression is Out-only, not a blanket removal', () => {
    // The discriminator for the case above. Without it a `wires.ts` that dropped EVERY
    // prong would satisfy the suppression assertion, and the ruling would have been
    // implemented as "delete the prong vocabulary" rather than as what the maintainer decided.
    const scene = dockedWireScene(1, 'from');
    const ep = scene.nodes.get(10)!;
    scene.nodes.set(10, { ...ep, ports: [{ ...ep.ports[0], role: WIRE_PORT_ROLE.IN }] });

    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(scene, 0, 0);
    expect(
      prongsOf(layer),
      'an In-role glyph terminal and the handler end stroke TWO prongs between them',
    ).toHaveLength(2);
  });

  it('the RETURN polarity (endpoint docked at `to`) still stamps the glyph at the endpoint end', () => {
    // The live-demo return wire: branch keys on the docked node KIND, never on
    // which wire dock (from/to) the endpoint occupies (D-01).
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(dockedWireScene(1, 'to'), 0, 0);
    const rects = rectsOf(gfx(layer));

    const ep = snappedNub(1, 5, 1);
    const expected = inletGlyphRects(ep.nx, ep.ny, FIXTURE_ENDPOINT_ROLE).map((r) => ({
      x: ep.cx + r.x,
      y: ep.cy + r.y,
      w: r.w,
      h: r.h,
    }));
    expect(rects.filter((f) => !(f.w === 10 && f.h === 10)).map(geomOf)).toEqual(expected);
    // The handler (now at `from`) stays the single plain square.
    expect(rects.filter((f) => f.w === 10 && f.h === 10)).toHaveLength(1);
  });

  it.each([0, 1, 2, 3])(
    'orientation sweep side %i: the glyph orients by the port outward normal',
    (side) => {
      const layer = createWireLayer(LOCKED_SKIN);
      layer.draw(dockedWireScene(side, 'from'), 0, 0);
      const rects = rectsOf(gfx(layer));
      const ep = snappedNub(1, 5, side);
      const expected = inletGlyphRects(ep.nx, ep.ny, FIXTURE_ENDPOINT_ROLE).map((r) => ({
        x: ep.cx + r.x,
        y: ep.cy + r.y,
        w: r.w,
        h: r.h,
      }));
      expect(rects.filter((f) => !(f.w === 10 && f.h === 10)).map(geomOf)).toEqual(expected);
    },
  );

  it('below the LOD cut the endpoint end falls back to ONE plain 10x10 square (zero glyph rects)', () => {
    let z = 1;
    const layer = createWireLayer(LOCKED_SKIN, () => z, () => 1);
    z = 0.25; // scale*CELL = 8 < 16 -> below the cut, mirroring the prong-stem gate
    layer.draw(dockedWireScene(1, 'from'), 0, 0);
    const rects = rectsOf(gfx(layer));

    // No glyph rect anywhere; the endpoint nub records exactly ONE plain square.
    expect(rects.filter((f) => !(f.w === 10 && f.h === 10))).toHaveLength(0);
    const ep = snappedNub(1, 5, 1);
    const atEndpoint = rects.filter((f) => f.x === ep.cx - 5 && f.y === ep.cy - 5);
    expect(atEndpoint).toHaveLength(1);
    expect(atEndpoint[0].w).toBe(10);
    expect(atEndpoint[0].h).toBe(10);
  });

  it('docked-but-not-endpoint kinds stay plain: kind 2 at BOTH ends records two 10x10 squares', () => {
    const handlerA: NodeViewT = {
      id: 10,
      kind: 2,
      cell_x: 1,
      cell_y: 5,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [{ index: 0, cell_x: 1, cell_y: 5, side: 1, role: 1, medium: 1 }],
      load: 0,
    };
    const handlerB: NodeViewT = {
      id: 11,
      kind: 2,
      cell_x: 6,
      cell_y: 5,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [{ index: 0, cell_x: 6, cell_y: 5, side: 3, role: 0, medium: 1 }],
      load: 0,
    };
    const wire: WireViewT = {
      id: 1,
      from: { node: 10, port: 0 },
      to: { node: 11, port: 0 },
      path: [straight(2, 5), straight(3, 5), straight(4, 5), straight(5, 5)],
      pulses: [],
    };
    const scene = {
      tick: 0,
      nodes: new Map([
        [10, handlerA],
        [11, handlerB],
      ]),
      belts: new Map(),
      wires: new Map([[1, wire]]),
      canUndo: false,
      canRedo: false,
    } as unknown as SceneStateT;

    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(scene, 0, 0);
    const rects = rectsOf(gfx(layer));
    expect(rects).toHaveLength(2);
    for (const r of rects) {
      expect(r.w).toBe(10);
      expect(r.h).toBe(10);
    }
  });

  it('draw() is per-frame idempotent: two identical (scene, clock) draws record identical geometry (FEEL-04 concurrency edge)', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(dockedWireScene(1, 'from'), 0, 0);
    const g = gfx(layer);
    const firstFilled = g.filled; // clear() replaces the arrays, so these refs persist
    const firstStrokes = g.strokes;

    layer.draw(dockedWireScene(1, 'from'), 0, 0);
    expect(gfx(layer).filled).toEqual(firstFilled);
    expect(gfx(layer).strokes).toEqual(firstStrokes);
    // The glyph branch introduced no persistent state: the records are non-empty
    // (a real draw happened both times) and byte-for-byte equal.
    expect(firstFilled.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 66-02 CHARACTERISATION: the drawn cable, described for the first time.
//
// Everything below this line pins the geometry the wire layer draws AT HEAD,
// INCLUDING ITS TWO DEFECTS. It is CHARACTERISATION, NOT APPROVAL. Two of the
// four assertions state something the phase is going to change:
//
//   - D1: a forward wire and its return between the same two machines are
//     stroked exactly on top of each other. Pinned here as COINCIDENT. Plan
//     66-08 flips it to DISJOINT when the lane offset lands.
//   - D3: the cable is stroked cell-centre to cell-centre while the nub sits at
//     the cell edge plus a 2.5px push, so the first 16.5px of cable is drawn
//     INSIDE the machine it leaves. Pinned here as INSIDE. Plan 66-08 flips it
//     to outside when the end-vertex clamp lands.
//
// A reviewer must be able to read "coincident" and "inside the footprint" as
// the recorded starting point and not as a contract anybody is defending.
//
// PRONG POLLUTION, STATED HONESTLY. Before the plan-66-05 Container split,
// `wires.ts` draws the cable AND each terminal prong through the same reused
// Graphics with moveTo/lineTo/stroke (wires.ts:280-282 and :308-310), so
// `polylines` holds one cable plus up to two prongs per wire. They are told
// apart by COLOUR: the cable stroked at `ramp[3]` then (`palette.cable` since phase 92), the prong at
// `accents.electric`, both read from LOCKED_SKIN and never as a literal. After
// the split they land in different Containers and the ambiguity disappears.
// ===========================================================================

/**
 * Every recorded polyline the layer drew this frame, cables first then terminals -
 * the merged sibling of `gfx()` above, on the same concatenation.
 */
function polys(layer: SplitLayer): Polyline[] {
  return [...cablesGfx(layer).polylines, ...terminalsGfx(layer).polylines];
}

/**
 * The CABLE polylines, read STRUCTURALLY from the `cables` Container (plan 66-05).
 *
 * Until the split, cable and prong shared one Graphics and this helper had to tell them
 * apart by colour (the resting colour versus `accents.electric`). The split IS the separation, so
 * reading the cable Container is now the honest form and the colour filter would be a
 * second, weaker statement of the same thing kept alive out of habit. The
 * colour-distinctness assertion at the head of the characterisation block is kept: it
 * still protects `polys(...).filter(...electric)`, which is how the prongs are named.
 */
const cablesOf = (layer: SplitLayer): Polyline[] => cablesGfx(layer).polylines;

/** The centre of a routed tile, in world px. The thing a cable vertex should BE. */
const centreOf = (t: TileViewT): { x: number; y: number } => ({
  x: t.cell_x * CELL + CELL / 2,
  y: t.cell_y * CELL + CELL / 2,
});

/** A 1x1 electrical machine carrying exactly ONE port, on `side`. */
function electricalNode(
  id: number,
  cellX: number,
  cellY: number,
  side: number,
  role: number,
): NodeViewT {
  return {
    id,
    kind: 2, // a plain handler: NOT kind-9, so no inlet glyph branch is taken
    cell_x: cellX,
    cell_y: cellY,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: cellX, cell_y: cellY, side, role, medium: 1 }],
  } as NodeViewT;
}

/**
 * A wire whose path comes from `wireRoute`, the byte-pinned TS mirror of the Rust
 * auto-router, and NEVER from hand-authored tiles.
 *
 * This is not fussiness. The shipped hand-authored fixture in `pixelGuard.tsx` is not
 * host-shaped: it omits both dock cells, while `manhattan_l` seeds from `from.cell`
 * and INCLUDES them. A hand-authored path therefore reproduces neither D1 (whose
 * whole shape is that A->B and B->A are the same cells reversed) nor D3 (whose whole
 * shape is that the first cell IS the machine's own cell).
 */
function routedWire(id: number, from: NodeViewT, to: NodeViewT): WireViewT {
  const a = from.ports[0];
  const b = to.ports[0];
  // The body rides in through the SAME `bodyOfNode` production uses, so this fixture
  // cannot disagree with the shipped derivation. Type-only for these two nodes:
  // MEASURED, the SRC (2,5)E / DST (6,5)W pair declines at D2 in BOTH directions, so
  // the E2 pair assertion below does not move.
  const r = wireRoute(
    { cell: [a.cell_x, a.cell_y], side: a.side, body: bodyOfNode(from) },
    { cell: [b.cell_x, b.cell_y], side: b.side, body: bodyOfNode(to) },
  );
  if (!r.ok) throw new Error('the fixture route was rejected; the fixture is wrong, not the layer');
  return {
    id,
    from: { node: from.id, port: 0 },
    to: { node: to.id, port: 0 },
    path: r.geometry.tiles,
    pulses: [],
  } as WireViewT;
}

/** A scene carrying the given resolved nodes and routed wires, at tick 0. */
function routedScene(nodes: NodeViewT[], wires: WireViewT[]): SceneStateT {
  return {
    tick: 0,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    belts: new Map(),
    wires: new Map(wires.map((w) => [w.id, w])),
    canUndo: false,
    canRedo: false,
  } as unknown as SceneStateT;
}

// The fixture geography, once. Source faces E, target faces W, so the X-first
// router leaves the source along its own port normal - the case D3's clamp fixes
// outright, and the case every port on the demo board is in.
const SRC = electricalNode(10, 2, 5, 1, 1); // (2,5), side E, Role::Out
const DST = electricalNode(11, 6, 5, 3, 0); // (6,5), side W, Role::In
const DST_BELOW = electricalNode(12, 6, 9, 3, 0); // (6,9), side W, Role::In - forces an L
// CABLE-05 (plan 75-02): an N-facing 1x1 source at (2,5), ROUTED to DST_BELOW by `wireRoute`.
// Not the hand-authored `N_SRC` reversal fixture below, whose path is written by hand: this
// one's path is whatever the router does, which is the thing CABLE-05 grades. Before phase 75
// it left the N-facing port downward, and its first vertex stayed at the source cell centre,
// strictly inside the machine's own box.
const N_SRC_ROUTED = electricalNode(13, 2, 5, 0, 1); // (2,5), side N, Role::Out

/**
 * Every segment of every drawn cable is axis-aligned (40-UI-SPEC.md:192 - "90-degree
 * corners only, no diagonal strokes"). Run over EVERY fixture in this block, because
 * the D1 lane offset displaces a corner vertex on BOTH axes and the D3 clamp rewrites
 * one coordinate of each end vertex: either one, done on the wrong axis, turns a leg
 * diagonal, and a diagonal wire leg is the one shape the spec forbids outright.
 */
function expectAxisAligned(cables: Polyline[], label: string): void {
  expect(cables.length, `${label}: there is a cable to check`).toBeGreaterThan(0);
  for (const [ci, c] of cables.entries()) {
    for (let i = 1; i < c.pts.length; i++) {
      const dx = c.pts[i].x - c.pts[i - 1].x;
      const dy = c.pts[i].y - c.pts[i - 1].y;
      expect(dx === 0 || dy === 0, `${label}: cable ${ci} segment ${i - 1}->${i}`).toBe(true);
    }
  }
}

type Pt = { x: number; y: number };

/** Distance from a point to a segment (clamped projection). */
function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** Orientation sign of the triangle (a, b, c). */
function orient(a: Pt, b: Pt, c: Pt): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/** True when segments ab and cd properly or improperly intersect. */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (p: Pt, q: Pt, r: Pt): boolean =>
    orient(p, q, r) === 0 &&
    Math.min(p.x, q.x) <= r.x &&
    r.x <= Math.max(p.x, q.x) &&
    Math.min(p.y, q.y) <= r.y &&
    r.y <= Math.max(p.y, q.y);
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}

/**
 * The MINIMUM distance between two drawn polylines, over every segment pair. Zero
 * means they touch or cross somewhere. This is what "DISJOINT, with a visible gap"
 * has to be measured as: a vertex-set comparison alone would pass two cables that
 * lie on top of each other while merely sampling different points along the run.
 */
function polylineGap(a: Polyline, b: Polyline): number {
  let best = Infinity;
  for (let i = 1; i < a.pts.length; i++) {
    for (let j = 1; j < b.pts.length; j++) {
      const [p, q, r, t] = [a.pts[i - 1], a.pts[i], b.pts[j - 1], b.pts[j]];
      const d = segmentsCross(p, q, r, t)
        ? 0
        : Math.min(pointSegDist(p, r, t), pointSegDist(q, r, t), pointSegDist(r, p, q), pointSegDist(t, p, q));
      if (d < best) best = d;
    }
  }
  return best;
}

describe('wires - the drawn cable geometry (E1, plan 66-02 characterisation)', () => {
  it('the cable colour and the prong colour are DISTINCT, so separating them by colour is not vacuous', () => {
    // Every assertion in this block filters `polylines` by colour to tell the cable
    // from the terminal prongs it currently shares a Graphics with. If the two ever
    // became the same value that filter would silently select both and every
    // geometric assertion below would be describing something it did not mean to.
    expect(LOCKED_SKIN.palette.cable).not.toBe(LOCKED_SKIN.palette.accents.electric);
  });

  it('a straight run records ONE cable polyline: the cell centres, displaced into their lane and clamped to the nubs', () => {
    const wire = routedWire(1, SRC, DST);
    // Sanity on the fixture itself: 5 cells, (2,5) through (6,5) inclusive of both docks.
    expect(wire.path).toHaveLength(5);

    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([SRC, DST], [wire]), 0, 0);

    const cables = cablesOf(layer);
    expect(cables, 'exactly one cable is stroked for one wire').toHaveLength(1);

    // The drawn line, stated as NUMBERS rather than by re-running the layer's own
    // arithmetic - a derived expectation here would agree with any offset the layer
    // chose, including none. path[0]=(2,5) sorts before path[4]=(6,5), so lane=+1 and
    // every vertex moves +2 in y (the perpendicular of a horizontal segment). Then the
    // two ends clamp along their OWN segment's axis (x) to the resolved nubs: the E
    // nub of (2,5) at 96.5 and the W nub of (6,5) at 191.5.
    expect(cables[0].pts).toEqual([
      { x: 96.5, y: 178 },
      { x: 112, y: 178 },
      { x: 144, y: 178 },
      { x: 176, y: 178 },
      { x: 191.5, y: 178 },
    ]);

    // And the same thing said against the routed cells, so the relationship survives a
    // fixture move: every INTERIOR vertex is its cell centre pushed one lane offset
    // perpendicular, and nothing else has moved.
    const centres = wire.path.map(centreOf);
    for (let i = 1; i < centres.length - 1; i++) {
      expect(cables[0].pts[i]).toEqual({ x: centres[i].x, y: centres[i].y + CABLE_LANE_OFFSET });
    }

    expectAxisAligned(cables, 'straight run');
    // 2px is the locked CABLE_WIDTH (wires.ts:76) and 1 the locked idle alpha (D-10); both
    // are stated here rather than imported because the module does not export them,
    // and the point of this assertion is to describe the drawn line, not to agree
    // with a constant.
    expect(cables[0].width).toBe(2);
    expect(cables[0].alpha).toBe(1);

    // The prongs are present and are NOT being mistaken for the cable.
    const prongs = polys(layer).filter((p) => p.color === LOCKED_SKIN.palette.accents.electric);
    expect(prongs, 'two resolved terminals stroke two prongs').toHaveLength(2);
  });

  it('a CORNERED run records a face-aligned polyline, two right-angle turns, no diagonal segment', () => {
    // No wire corner has ever been asserted in this repository. This is the first one.
    //
    // RE-BLESSED 2026-09-03 by plan 72-15, and this is the expectation that most needed
    // to move: it was PINNING THE DEFECT. Its own comment said so, naming its last vertex
    // as the D2 residual "deferred by this phase and filed as a WINDOWS row rather than
    // fixed here". Row 118 named this exact fixture as reproduction (b). It is now fixed,
    // so the fixture flips from recording the residual to proving its absence, and the
    // test title changes with it: the route is no longer a single L.
    const wire = routedWire(1, SRC, DST_BELOW);
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([SRC, DST_BELOW], [wire]), 0, 0);

    const cable = cablesOf(layer)[0];
    expect(cable, 'the cornered fixture strokes a cable').toBeDefined();

    // The Z, in numbers. SRC (2,5) faces E and DST_BELOW (6,9) faces W, so BOTH faces
    // are admissible on the x axis and one L cannot serve both: cells (2,5)..(5,5), then
    // (5,6)..(5,9), then one step EAST into (6,9). Nine cells, the same count as the old
    // L. lane=+1 because (2,5) sorts before (6,9); horizontal vertices move +2 in y,
    // vertical ones +2 in x, and each corner moves on BOTH so the legs meet at a right
    // angle.
    //
    // BOTH ENDS NOW SIT ON THEIR OWN NUB, which is the whole point of the re-bless.
    // First vertex x = 96.5, the E nub of (2,5). LAST vertex x = 191.5, the W nub of
    // (6,9) - it used to be 210, the cell centre plus lane, leaving an 18.5 px stub of
    // cable floating beside an unattached terminal square. The descent column moved from
    // 6 to 5, so the final leg into the W-facing port is now HORIZONTAL, its axis matches
    // the port's normal, and the D3 end-clamp applies where it used to be a no-op.
    expect(cable.pts).toEqual([
      { x: 96.5, y: 178 },
      { x: 112, y: 178 },
      { x: 144, y: 178 },
      { x: 178, y: 178 },
      { x: 178, y: 208 },
      { x: 178, y: 240 },
      { x: 178, y: 272 },
      { x: 178, y: 306 },
      { x: 191.5, y: 306 },
    ]);

    // THE CLAIM THAT MAKES THE RE-BLESS A FIX RATHER THAN A DRIFT, asserted rather than
    // described: the cable's last vertex IS the destination nub's x, not the cell centre.
    expect(cable.pts[cable.pts.length - 1].x, 'the cable ends ON the W nub of (6,9)').toBe(
      nubAnchor(6, 9, 3).x,
    );

    // Every segment is axis-aligned. 40-UI-SPEC.md:192 - "90-degree corners only, no
    // diagonal strokes" - and until now nothing could read it.
    const axes: Array<'h' | 'v'> = [];
    for (let i = 1; i < cable.pts.length; i++) {
      const dx = cable.pts[i].x - cable.pts[i - 1].x;
      const dy = cable.pts[i].y - cable.pts[i - 1].y;
      expect(dx === 0 || dy === 0, `segment ${i - 1}->${i} is axis-aligned`).toBe(true);
      axes.push(dx === 0 ? 'v' : 'h');
    }

    // TWO axis changes, not one: the Z the face-aligned router produces when both ports
    // face along the same axis. Two is the minimum for a path that leaves eastward AND
    // arrives eastward while changing row, so this count is a property of the two ports
    // rather than a routing preference.
    const turns = axes.filter((a, i) => i > 0 && a !== axes[i - 1]);
    expect(turns, 'a Z route turns exactly twice').toHaveLength(2);

    // It turns first at (5,5): the end of the horizontal leg, the start of the descent -
    // displaced on BOTH axes, which is the whole reason both legs stay axis-aligned.
    const turnAt = axes.findIndex((a, i) => i > 0 && a !== axes[i - 1]);
    expect(cable.pts[turnAt]).toEqual({
      x: 5 * CELL + CELL / 2 + CABLE_LANE_OFFSET,
      y: 5 * CELL + CELL / 2 + CABLE_LANE_OFFSET,
    });
    expect(centreOf(wire.path[turnAt]), 'the corner cell it is displaced FROM').toEqual({
      x: 5 * CELL + CELL / 2,
      y: 5 * CELL + CELL / 2,
    });

    // ...and again at (5,9), where the descent turns east onto the In nub's own face.
    // THIS SECOND CORNER IS THE FIX: the old route had no turn here at all, it simply ran
    // down column 6 and stopped short of the nub.
    const turn2 = axes.findIndex((a, i) => i > turnAt && a !== axes[i - 1]);
    expect(cable.pts[turn2]).toEqual({
      x: 5 * CELL + CELL / 2 + CABLE_LANE_OFFSET,
      y: 9 * CELL + CELL / 2 + CABLE_LANE_OFFSET,
    });
  });

  it('E2: a forward/return PAIR is stroked as TWO DISJOINT cables, one lane either side', () => {
    // THIS IS THE INVERSION OF 66-02's `characterisation of D1`, AND IT IS THE PHASE'S
    // STRONGEST GATE.
    //
    // THE PREMISE, AS IT STANDS SINCE PHASE 75 (rewritten by plan 75-02, declared, not a
    // requirement). The router reads both port SIDES, not only the two cells: since 72-15
    // the face-aligned shape, since 72-16 the perimeter ring, and since 75-01 the
    // go-around, which takes a one-face pair around a machine so the cable leaves along
    // its port and enters the other head-on. So A to B and B to A are NOT always the same
    // cells reversed: the demo board's own pair is not (the forward cable runs along row 6,
    // the return cable goes around above it). THIS fixture's pair still is: SRC (2,5)E and
    // DST (6,5)W face each other on one row, so both directions are the same straight run,
    // and the test re-derives that below rather than assuming it. The reversal is a
    // property of this fixture, not of the router.
    //
    // At HEAD they were stroked exactly on top of one another and
    // what read as ONE cable on the shipped demo board was two. The lane offset makes
    // them opposite by CONSTRUCTION rather than by a rule someone maintains: the key is
    // a lexicographic compare of path[0] against path[last], which reverses with the
    // path, and the perpendicular is the segment's AXIS NORMAL, which does not.
    const forward = routedWire(1, SRC, DST);
    const ret = routedWire(2, DST, SRC);
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([SRC, DST], [forward, ret]), 0, 0);

    const cables = cablesOf(layer);
    expect(cables, 'two wires, two cables').toHaveLength(2);

    // The fixture still reproduces the ROUTER-side coincidence this gate exists for:
    // the two routed cell lists ARE the same cells reversed. If that ever stopped being
    // true the disjointness below would be measuring nothing.
    expect([...ret.path].reverse().map((t) => `${t.cell_x},${t.cell_y}`)).toEqual(
      forward.path.map((t) => `${t.cell_x},${t.cell_y}`),
    );

    // DISJOINT, measured as the minimum distance between the two drawn polylines over
    // every segment pair - not as a vertex-set comparison, which two coincident lines
    // sampled at different points would pass. The gap is 2 * CABLE_LANE_OFFSET, twice
    // the cable width: at zoom 1 two 2px cables with a 2px hole between them.
    expect(polylineGap(cables[0], cables[1])).toBeCloseTo(2 * CABLE_LANE_OFFSET, 9);
    expect(polylineGap(cables[0], cables[1]), 'strictly disjoint, never touching').toBeGreaterThan(0);
    // The clause above is written in terms of CABLE_LANE_OFFSET and therefore goes
    // trivially true at offset 0; `toBeGreaterThan(0)` is what carries the claim. And
    // the gap must survive `antialias: false` rasterisation at the wire LOD cut
    // (scale 16/CELL = 0.5) - the exact test the original SUB-PIXEL prescription
    // failed, which would have shipped as a no-op every gate passed.
    expect(2 * CABLE_LANE_OFFSET * (16 / CELL)).toBeGreaterThanOrEqual(2);

    // Not one shared drawn point anywhere.
    const key = (p: { x: number; y: number }): string => `${p.x},${p.y}`;
    const forwardPts = new Set(cables[0].pts.map(key));
    for (const p of cables[1].pts) {
      expect(forwardPts.has(key(p)), `${key(p)} is NOT also a forward-cable vertex`).toBe(false);
    }

    // And the reversal identity 66-02 pinned is now FALSE. Stated explicitly because
    // "disjoint" is the claim and this is the exact sentence it replaced.
    expect([...cables[1].pts].reverse()).not.toEqual(cables[0].pts);

    // Opposite lanes, not merely different ones: the pair straddles the routed row.
    const row = 5 * CELL + CELL / 2;
    expect(cables[0].pts.every((p) => p.y === row + CABLE_LANE_OFFSET)).toBe(true);
    expect(cables[1].pts.every((p) => p.y === row - CABLE_LANE_OFFSET)).toBe(true);

    expectAxisAligned(cables, 'forward/return pair');
  });

  it("D3's reversal guard: an end vertex whose nub lies past the far end of its segment is LEFT ALONE", () => {
    // T-66-08-01. The clamp rewrites an end vertex's coordinate on its own segment's
    // axis; if the nub's coordinate lies PAST the far end of that segment the rewrite
    // would reverse it or collapse it to nothing, and a reversed terminal segment draws
    // a cable that doubles back through the machine it just left. The guard has to be
    // reachable to be worth having, and the reachable shape is a HOSTILE PACKET rather
    // than a gesture: `resolve_wire_dock` degrades to the node origin on a bad port
    // index, so a wire can arrive docked to a port that is nowhere near its own path.
    //
    // FAR_SRC's port is at (4,5) facing E, so its nub is at x=160.5 - past the far end
    // (x=112) of a first segment that runs 80 -> 112. The clamp must decline.
    const FAR_SRC = electricalNode(20, 4, 5, 1, 1);
    const wire = {
      id: 1,
      from: { node: 20, port: 0 },
      to: { node: 11, port: 0 },
      path: [straight(2, 5), straight(3, 5)],
      pulses: [],
    } as unknown as WireViewT;
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([FAR_SRC, DST], [wire]), 0, 0);

    const cable = cablesOf(layer)[0];
    expect(nubAnchor(4, 5, 1).x, 'the nub really is past the far end').toBeCloseTo(160.5, 9);
    expect(cable.pts[0], 'the guarded end keeps its cell centre').toEqual({ x: 80, y: 178 });
    // WR-02: DST's resolved nub (x=191.5) lies outside the segment [80, 112] this end's
    // own near/far bound now excludes, so this end ALSO declines and keeps its routed
    // cell centre (x=112). Both ends of this hostile-packet fixture decline: the
    // guarded end via the original reversal/zero sign check, this end via the new
    // magnitude bound. The POSITIVE case - the guard letting an in-range nub through -
    // is proved by E3/E3b, not this fixture.
    expect(cable.pts[1]).toEqual({ x: 112, y: 178 });
    expectAxisAligned([cable], 'reversal-guarded end');
  });

  it("D3's zero guard: an end vertex whose nub lands exactly on the far end is LEFT ALONE", () => {
    // The second arm: `target === far` would collapse the terminal segment to zero
    // length, which strokes nothing and leaves `pointAlong` dividing by a zero segment.
    // A N-facing port at (3,5) puts its nub at x = 112 exactly, which IS the far end of
    // the first segment.
    const N_SRC = electricalNode(21, 3, 5, 0, 1);
    expect(nubAnchor(3, 5, 0).x, 'the nub lands exactly on the far end').toBeCloseTo(112, 9);
    const wire = {
      id: 1,
      from: { node: 21, port: 0 },
      to: { node: 11, port: 0 },
      path: [straight(2, 5), straight(3, 5)],
      pulses: [],
    } as unknown as WireViewT;
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([N_SRC, DST], [wire]), 0, 0);

    const cable = cablesOf(layer)[0];
    expect(cable.pts[0], 'the guarded end keeps its cell centre').toEqual({ x: 80, y: 178 });
    expect(cable.pts[1].x - cable.pts[0].x, 'the terminal segment still has length').toBeGreaterThan(0);
  });

  it('E3: no drawn cable vertex lies inside a machine footprint, on every routed fixture', () => {
    // THIS IS THE INVERSION OF 66-02's `characterisation of D3`. The cable was stroked
    // cell-centre to cell-centre while the nub sits at the cell edge plus a 2.5px push,
    // and wires composite ABOVE machines, so 16.5px of cable was drawn OVER the machine
    // it left. The clamp replaces each end vertex's coordinate ON ITS OWN SEGMENT'S AXIS
    // with the resolved nub's - never the perpendicular, which would make the end
    // segment diagonal.
    const wire = routedWire(1, SRC, DST);
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([SRC, DST], [wire]), 0, 0);

    const cable = cablesOf(layer)[0];

    // The footprint boxes, DERIVED through the core-mirrored `effectiveBox` rather than
    // by multiplying w and h here (a 1x1 at rot 0 is the degenerate case, but the
    // derivation is the point: this box must be the sim's box).
    const boxOf = (n: NodeViewT): { x0: number; y0: number; x1: number; y1: number } => {
      const { ew, eh } = effectiveBox(n.w, n.h, n.rot);
      return {
        x0: n.cell_x * CELL,
        y0: n.cell_y * CELL,
        x1: (n.cell_x + ew) * CELL,
        y1: (n.cell_y + eh) * CELL,
      };
    };
    // CABLE-05 (plan 75-02): over EVERY routed fixture, not only the straight one - the
    // straight SRC to DST, the cornered SRC to DST_BELOW, and the N-facing N_SRC_ROUTED to
    // DST_BELOW - each pair's own two docked machines' boxes, every vertex strictly
    // outside both, and every segment axis-aligned.
    const pairs: [string, NodeViewT, NodeViewT][] = [
      ['straight SRC to DST', SRC, DST],
      ['cornered SRC to DST_BELOW', SRC, DST_BELOW],
      ['N-facing N_SRC_ROUTED to DST_BELOW', N_SRC_ROUTED, DST_BELOW],
    ];
    for (const [label, a, b] of pairs) {
      const w = routedWire(1, a, b);
      const l = createWireLayer(LOCKED_SKIN);
      l.draw(routedScene([a, b], [w]), 0, 0);
      const drawn = cablesOf(l);
      expect(drawn, `${label}: one cable is stroked`).toHaveLength(1);
      for (const box of [boxOf(a), boxOf(b)]) {
        for (const p of drawn[0].pts) {
          const inside = p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1;
          expect(
            inside,
            `${label}: vertex ${p.x},${p.y} is outside the machine box ${JSON.stringify(box)}; ` +
              `cells ${JSON.stringify(w.path.map((t) => [t.cell_x, t.cell_y]))}`,
          ).toBe(false);
        }
      }
      expectAxisAligned(drawn, label);
    }

    // The magnitude 66-02 left a number for, driven to zero on BOTH ends. The port
    // faces E, so the overshoot is measured on X: nub 96.5 against a former vertex 80.
    const srcNub = nubAnchor(SRC.ports[0].cell_x, SRC.ports[0].cell_y, SRC.ports[0].side);
    const dstNub = nubAnchor(DST.ports[0].cell_x, DST.ports[0].cell_y, DST.ports[0].side);
    expect(srcNub.x).toBeCloseTo(96.5, 9);
    expect(srcNub.x - cable.pts[0].x, 'the D3 overshoot at the source, in world px').toBeCloseTo(0, 9);
    expect(
      dstNub.x - cable.pts[cable.pts.length - 1].x,
      'the D3 overshoot at the target, in world px',
    ).toBeCloseTo(0, 9);

    // The clamp NEVER touched the perpendicular coordinate: both ends still sit exactly
    // one lane offset off the nub CENTRE, which is inside the 10px (NUB_HALF=5) square,
    // so the terminal still reads connected.
    expect(Math.abs(cable.pts[0].y - srcNub.y)).toBeCloseTo(CABLE_LANE_OFFSET, 9);
    expect(Math.abs(cable.pts[cable.pts.length - 1].y - dstNub.y)).toBeCloseTo(CABLE_LANE_OFFSET, 9);
    expect(CABLE_LANE_OFFSET, 'the end stays inside the 10px nub square').toBeLessThan(5);

    expectAxisAligned([cable], 'clamped straight run');
  });

  it('E3b: the 16.5px ORDER-DEPENDENT overshoot is gone on two DIRECTLY ADJACENT 1x1 machines, down to the intrinsic 0.5px nub-push residual (WR-01)', () => {
    // The 2-cell degenerate route E3 does not exercise: `SRC`/`DST` are 4 cells apart.
    // Two 1x1 electrical machines standing side by side produce a route of exactly two
    // cells, and `cablePolyline`'s two SEQUENTIAL `clampEndToNub` calls used to have the
    // second read the vertex the first had just mutated - the reversal guard then
    // declined the second clamp and the target end kept 16.5px of cable drawn INSIDE
    // its own machine's footprint. The fix collapses this degenerate, CROSSED case
    // directly onto both resolved nubs.
    //
    // MEASURED, NOT ASSUMED (the discipline this project's own STATE.md names
    // repeatedly): `nubAnchor`'s constants (`ports.ts` INSET=2, NUB_PUSH=2.5) push
    // every port's nub 0.5px (PUSH - INSET) PAST its own cell's far edge, outward. For
    // two cells sharing that exact edge, each nub therefore lands 0.5px INSIDE the
    // OTHER machine's box - verified numerically: nubAnchor(5,5,E).x=192.5 and
    // nubAnchor(6,5,W).x=191.5 straddle the shared boundary at x=192 by 0.5px each way.
    // This is intrinsic to `nubAnchor` (shared by every port in the renderer, not
    // introduced by this fix) and out of this plan's scope (`ports.ts` is not in
    // `files_modified`). The WR-01 defect this test proves fixed is the
    // ORDER-DEPENDENT 16.5px residual, not this shared, symmetric 0.5px geometry.
    const ADJ_SRC = electricalNode(30, 5, 5, 1, 1); // (5,5), side E, Role::Out
    const ADJ_DST = electricalNode(31, 6, 5, 3, 0); // (6,5), side W, Role::In - directly adjacent
    const wire = routedWire(1, ADJ_SRC, ADJ_DST);
    // Proves this fixture actually exercises the degenerate 2-cell path E3 does not.
    expect(wire.path, 'a directly-adjacent route is exactly 2 cells').toHaveLength(2);

    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([ADJ_SRC, ADJ_DST], [wire]), 0, 0);

    const cable = cablesOf(layer)[0];

    const boxOf = (n: NodeViewT): { x0: number; y0: number; x1: number; y1: number } => {
      const { ew, eh } = effectiveBox(n.w, n.h, n.rot);
      return {
        x0: n.cell_x * CELL,
        y0: n.cell_y * CELL,
        x1: (n.cell_x + ew) * CELL,
        y1: (n.cell_y + eh) * CELL,
      };
    };
    // NUB_PUSH(2.5) - INSET(2): the intrinsic residual named above, in world px.
    const INTRINSIC_NUB_RESIDUAL = 0.5;
    const penetration = (p: { x: number; y: number }, box: { x0: number; y0: number; x1: number; y1: number }): number => {
      const inside = p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1;
      if (!inside) return 0;
      // The box is 1x1 (32px); penetration from whichever edge is nearer.
      return Math.min(p.x - box.x0, box.x1 - p.x, p.y - box.y0, box.y1 - p.y);
    };
    for (const box of [boxOf(ADJ_SRC), boxOf(ADJ_DST)]) {
      for (const p of cable.pts) {
        // The pre-fix defect (16.5px, an order-dependent WRONG-end residual) is gone;
        // what remains is bounded by the shared, symmetric, out-of-scope nub geometry.
        expect(
          penetration(p, box),
          `vertex ${p.x},${p.y} penetrates a machine box by more than the intrinsic nub-push residual`,
        ).toBeLessThanOrEqual(INTRINSIC_NUB_RESIDUAL);
      }
    }

    // The WR-01 collapse target: both drawn endpoints equal the resolved nub
    // coordinates exactly, proving the order-dependent mutation bug (not this
    // fixture's OWN nub geometry) is what the fix eliminated.
    const srcNub = nubAnchor(ADJ_SRC.ports[0].cell_x, ADJ_SRC.ports[0].cell_y, ADJ_SRC.ports[0].side);
    const dstNub = nubAnchor(ADJ_DST.ports[0].cell_x, ADJ_DST.ports[0].cell_y, ADJ_DST.ports[0].side);
    expect(cable.pts[0]).toEqual({ x: srcNub.x, y: srcNub.y });
    expect(cable.pts[cable.pts.length - 1]).toEqual({ x: dstNub.x, y: dstNub.y });

    expectAxisAligned([cable], 'adjacent-machine collapse');
  });

  it("E3c: the nub elbow's inner vertex is the ONE named CABLE-05 exception, on a P2 pair (plan 75-05)", () => {
    // 75-UI-SPEC 2.1. A P2 pair: two touching 1x1 docks, (2,5) facing E into (3,5), whose
    // In faces N. No head-on cable exists, the router returns (2,5) (3,5), and the last
    // segment runs east ACROSS the N port's normal. The nub elbow makes the cable turn at
    // (3,5)'s centre and run up onto the N nub, and the turn vertex is the one vertex
    // E3's rule lets inside a docked box, by name.
    //   E nub of (2,5): x = 2*32 + 32 - 2 + 2.5 = 96.5, y = 176
    //   N nub of (3,5): x = 3*32 + 16 = 112,          y = 5*32 + 2 - 2.5 = 159.5
    //   lane +1 (first cell (2,5) sorts before (3,5)): the horizontal leg sits at y 178
    const P2_SRC = electricalNode(40, 2, 5, 1, 1); // (2,5), side E, Role::Out
    const P2_DST = electricalNode(41, 3, 5, 0, 0); // (3,5), side N, Role::In
    const wire = routedWire(1, P2_SRC, P2_DST);
    expect(wire.path.map((t) => [t.cell_x, t.cell_y]), 'the router serves P2 with two cells').toEqual([
      [2, 5],
      [3, 5],
    ]);
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([P2_SRC, P2_DST], [wire]), 0, 0);
    const cable = cablesOf(layer)[0];
    expect(cable.pts).toEqual([
      { x: 96.5, y: 178 },
      { x: 112, y: 178 },
      { x: 112, y: 159.5 },
    ]);
    expectAxisAligned([cable], 'P2 elbow');

    // Every vertex strictly inside either docked box, by more than the intrinsic 0.5 px
    // nub-push residual two touching machines always carry (E3b names it: the E nub at
    // 96.5 sits 0.5 px past the shared edge at 96). Exactly one: the elbow's turn.
    const boxes = [
      { x0: 64, y0: 160, x1: 96, y1: 192 }, // (2,5)
      { x0: 96, y0: 160, x1: 128, y1: 192 }, // (3,5)
    ];
    const INTRINSIC_NUB_RESIDUAL = 0.5;
    const deepInside = cable.pts.filter((p) =>
      boxes.some((b) => {
        const inside = p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;
        return inside && Math.min(p.x - b.x0, b.x1 - p.x, p.y - b.y0, b.y1 - p.y) > INTRINSIC_NUB_RESIDUAL;
      }),
    );
    expect(deepInside, 'the CABLE-05 exception: the nub elbow turn on the port cell, and nothing else').toEqual([
      { x: 112, y: 178 },
    ]);
  });

  it('E3d: every adjacent 1x1 pair draws both ends on their nubs, through the layer (CR-01)', () => {
    // 75-REVIEW CR-01, plan 75-09. E3 and E3c grade hand-picked fixtures, and the class
    // CR-01 names (an end that runs ALONG its port's normal but backwards, through the
    // back of the port's cell) was never one of them. So this case is a sweep: every
    // adjacent 1x1 pair, 4 directions x 16 side pairs, each routed by `wireRoute` (via
    // `routedWire`), drawn by the REAL layer and read off the recorded cable polyline.
    // The expected nub is `nubAnchor` of each port, independent of `nubEndAt`. An end
    // passes within CABLE_LANE_OFFSET of its nub (the lane moves an end across its own
    // segment by exactly that); every segment must be axis-aligned.
    const steps: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ];
    const name = ['N', 'E', 'S', 'W'];
    const misses: string[] = [];
    let total = 0;
    for (const [dx, dy] of steps) {
      for (let fs = 0; fs < 4; fs++) {
        for (let ts = 0; ts < 4; ts++) {
          total += 1;
          const src = electricalNode(50, 0, 0, fs, 1); // Role::Out
          const dst = electricalNode(51, dx, dy, ts, 0); // Role::In
          const layer = createWireLayer(LOCKED_SKIN);
          layer.draw(routedScene([src, dst], [routedWire(1, src, dst)]), 0, 0);
          const cable = cablesOf(layer)[0];
          const pts = cable.pts;
          const a = nubAnchor(0, 0, fs);
          const b = nubAnchor(dx, dy, ts);
          const first = pts[0];
          const last = pts[pts.length - 1];
          const head = `(0,0)${name[fs]} -> (${dx},${dy})${name[ts]}`;
          if (Math.hypot(first.x - a.x, first.y - a.y) > CABLE_LANE_OFFSET + 1e-9) {
            misses.push(`${head} drawn=(${first.x},${first.y}) nub=(${a.x},${a.y})`);
          } else if (Math.hypot(last.x - b.x, last.y - b.y) > CABLE_LANE_OFFSET + 1e-9) {
            misses.push(`${head} drawn=(${last.x},${last.y}) nub=(${b.x},${b.y})`);
          } else {
            for (let i = 1; i < pts.length; i++) {
              if (pts[i].x !== pts[i - 1].x && pts[i].y !== pts[i - 1].y) {
                misses.push(`${head} diagonal segment ${i - 1}->${i}`);
                break;
              }
            }
          }
        }
      }
    }
    expect(total).toBe(64);
    expect(misses.length, `adjacent off-nub ${misses.length} of ${total}\n${misses.slice(0, 10).join('\n')}`).toBe(0);
  });

  it('G3: the REPLY cable on an all-four-false pair plugs in at BOTH ends (J-7, 72-16)', () => {
    // THIS IS THE PHASE'S ACCEPTANCE CRITERION AND NOTHING IN THE REPOSITORY ASSERTED IT
    // BEFORE THIS TEST. The maintainer ruled J-7 on 2026-09-04 with the words "make it go around",
    // against a reply cable measured as UNPLUGGED at both ends: 16.6 px at the Handler
    // Role::Out (the WR-02 range bound declining, with the stroke starting ~14 px inside
    // the Handler's own chassis) and 14.5 px at the Route Role::In (axis mismatch: a
    // vertical last segment into a west-facing nub, so `wires.ts` could move only p.y).
    //
    // The corpus in wireRoute.test.ts pins the CELLS. It cannot see whether the drawn
    // polyline reaches the nub, because that is a render-layer question. E3 above pins
    // the same property, but only on a pair whose faces are ADMISSIBLE, which is the
    // case that already worked. This is the both-faces-INADMISSIBLE case.
    //
    // OBSERVED REDDENING, TWICE, because the plan's named mutation turned out to redden
    // this test for a different reason than predicted and one observation would have
    // overstated what is pinned.
    //   1. The named one: swap S1's emission in `perimeterCells` to walk TOWARD A
    //      (`runX(cells, ay, p[0], ax)`). The design expected a still-valid path; it is
    //      not one, it re-emits A and route() rejects it, so the ladder falls through and
    //      this test reddens at the 14-cell non-vacuity clause with "expected [ ...(6) ]
    //      to have a length of 14 but got 6". Run, observed, reverted.
    //   2. So a second, deliberately VALID one, to prove the gap assertions themselves
    //      can fail rather than riding on the length: make the x arm of `clampEndToNub`
    //      a no-op (`p.x = near`). This test reddens with "the gap at the Handler Out:
    //      expected 16.5 to be close to +0", which is WINDOWS row 191's own 16.6 px
    //      measurement reproduced by a one-token change. Run, observed, reverted.
    //
    // The board is design section 6 example A, transcribed: a 1x1 Route at (0,0) with
    // In on W and Out on E, and a 3x3 Handler anchored (3,-1) with In at world (3,0)W
    // and Out at world (5,0)E. Negative cells are fine here: this suite is GPU-free and
    // there is no canvas to fall off.
    const ROUTE: NodeViewT = {
      id: 20,
      kind: 2,
      cell_x: 0,
      cell_y: 0,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [
        { index: 0, cell_x: 0, cell_y: 0, side: 3, role: 0, medium: 1 }, // In,  W
        { index: 1, cell_x: 0, cell_y: 0, side: 1, role: 1, medium: 1 }, // Out, E
      ],
    } as NodeViewT;
    const HANDLER: NodeViewT = {
      id: 21,
      kind: 2,
      cell_x: 3,
      cell_y: -1,
      state: 0,
      w: 3,
      h: 3,
      rot: 0,
      ports: [
        { index: 0, cell_x: 3, cell_y: 0, side: 3, role: 0, medium: 1 }, // In,  W
        { index: 1, cell_x: 5, cell_y: 0, side: 1, role: 1, medium: 1 }, // Out, E
      ],
    } as NodeViewT;

    // The REPLY leg: Handler.Out (5,0)E -> Route.In (0,0)W. sx = -1, f = E, nt = E, so
    // all four admissibility booleans are false and the ring is the candidate that fires.
    const r = wireRoute(
      { cell: [5, 0], side: 1, body: bodyOfNode(HANDLER) },
      { cell: [0, 0], side: 3, body: bodyOfNode(ROUTE) },
    );
    expect(r.ok, 'the reply leg routes').toBe(true);
    if (!r.ok) return;
    // NON-VACUITY. 14 cells is the ring; 6 is the pre-72-16 straight run through the
    // Handler's own middle row. If this ever reads 6 again, the ring stopped firing and
    // every assertion below would be measuring the old shape.
    expect(r.geometry.tiles, 'the ring fired: 14 cells, not the pre-72-16 straight 6').toHaveLength(14);

    const wire = {
      id: 1,
      from: { node: HANDLER.id, port: 1 },
      to: { node: ROUTE.id, port: 0 },
      path: r.geometry.tiles,
      pulses: [],
    } as WireViewT;
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(routedScene([ROUTE, HANDLER], [wire]), 0, 0);

    const cables = cablesOf(layer);
    expect(cables, 'one wire, one cable').toHaveLength(1);
    const cable = cables[0];
    const n = cable.pts.length;

    // (1) BOTH END VERTICES SIT ON THEIR RESOLVED NUB, ON THE CLAMP AXIS. Both ports
    //     face E/W, so the clamp axis is x at both ends. These two numbers are the 16.6
    //     px and the 14.5 px from WINDOWS row 191, driven to zero.
    const outNub = nubAnchor(5, 0, 1); // Handler Role::Out, E
    const inNub = nubAnchor(0, 0, 3); // Route Role::In, W
    expect(outNub.x - cable.pts[0].x, 'the gap at the Handler Out, in world px').toBeCloseTo(0, 9);
    expect(inNub.x - cable.pts[n - 1].x, 'the gap at the Route In, in world px').toBeCloseTo(0, 9);

    // (2) THE FIRST AND LAST SEGMENTS RUN ALONG THEIR PORT NORMALS, which is WHY (1)
    //     holds rather than a coincidence of this board. `clampEndToNub` moves a vertex
    //     only along its own segment's axis, so a terminal segment on the wrong axis
    //     leaves the nub unreachable however close it happens to be.
    expect(cable.pts[1].y, 'the first segment is horizontal').toBeCloseTo(cable.pts[0].y, 9);
    expect(
      Math.sign(cable.pts[1].x - cable.pts[0].x),
      'the cable LEAVES the east-facing Out heading east, along its own normal',
    ).toBe(1);
    expect(cable.pts[n - 2].y, 'the last segment is horizontal').toBeCloseTo(cable.pts[n - 1].y, 9);
    expect(
      Math.sign(cable.pts[n - 1].x - cable.pts[n - 2].x),
      'the cable ARRIVES at the west-facing In heading east, against its normal',
    ).toBe(1);

    // Every perimeter path is at least 4 cells, so `cablePolyline` always takes the
    // `pts.length > 2` branch and the WR-01 two-vertex crossed-nub branch is never
    // entered on a ring. Stated so nobody re-reasons that branch for this shape.
    expect(n, 'a ring is never the 2-vertex WR-01 case').toBeGreaterThan(2);

    expectAxisAligned([cable], 'the go-around reply cable');
  });

});

// ---------------------------------------------------------------------------
// CABLE-07 (plan 75-06, D-07, UI-SPEC 4.2 and 4.3): THE RE-ROUTE MARK. A cable whose
// `scene.wireReroutes` generation is new is stroked in the build accent, on its own drawn
// polyline, after every resting stroke on the cables Graphics, at alpha 1 for 40
// render-clock units and fading to nothing at 60, on `markClock`. Every assertion reads
// the recording Graphics, never the latch.
// ---------------------------------------------------------------------------
describe('wires - the re-route mark (CABLE-07)', () => {
  const BUILD = LOCKED_SKIN.palette.accents.build;
  const RESTING = LOCKED_SKIN.palette.cable;

  /** Straight wires `id` on row `row` from x 2 to 5, in the given order, and generations. */
  function rerouteScene(
    rows: Array<[number, number]>,
    gens: Array<[number, number]> | null,
    tick = 0,
  ): SceneStateT {
    const wires = new Map<number, WireViewT>();
    for (const [id, row] of rows) {
      wires.set(id, {
        id,
        from: { node: 90, port: 0 },
        to: { node: 91, port: 0 },
        path: [straight(2, row), straight(3, row), straight(4, row), straight(5, row)],
        pulses: [],
      });
    }
    const scene: Record<string, unknown> = {
      tick,
      nodes: new Map(),
      belts: new Map(),
      wires,
      canUndo: false,
      canRedo: false,
    };
    if (gens) scene.wireReroutes = new Map(gens);
    return scene as unknown as SceneStateT;
  }

  const marksOf = (layer: SplitLayer): Polyline[] => cablesOf(layer).filter((p) => p.color === BUILD);
  const restingOf = (layer: SplitLayer): Polyline[] => cablesOf(layer).filter((p) => p.color === RESTING);

  it('at its first frame the moved cable is stroked in build, on its own polyline, at CABLE_WIDTH, after every resting stroke', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    // Wire 1 moved and is FIRST in draw order; wire 2 did not move and is drawn after it,
    // so a mark drawn inline with its own cable would sit under wire 2's resting stroke.
    layer.draw(rerouteScene([[1, 5], [2, 8]], [[1, 1]]), 0, 0);
    const all = cablesOf(layer);
    const marks = marksOf(layer);
    expect(marks, 'one moved cable, one mark').toHaveLength(1);
    const resting = restingOf(layer);
    expect(resting, 'both cables still draw their resting stroke').toHaveLength(2);
    expect(marks[0].pts, 'the mark is the moved cable\'s own drawn polyline').toEqual(resting[0].pts);
    expect(marks[0].width, 'CABLE_WIDTH').toBe(2);
    expect(marks[0].alpha).toBe(1);
    expect([marks[0].cap, marks[0].join], 'round caps and joins').toEqual(['round', 'round']);
    const markAt = all.indexOf(marks[0]);
    const lastResting = Math.max(...resting.map((r) => all.indexOf(r)));
    expect(markAt, 'the mark is stroked after every resting cable stroke').toBeGreaterThan(lastResting);
    expect(
      terminalsGfx(layer as unknown as SplitLayer).polylines.filter((p) => p.color === BUILD),
      'nothing on the terminals Graphics is drawn in build',
    ).toHaveLength(0);
  });

  it('the envelope: alpha 1 at 40, below 1 at 50, gone at 60', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    const scene = rerouteScene([[1, 5]], [[1, 1]]);
    layer.draw(scene, 0, 100); // first seen at markClock 100
    layer.draw(scene, 0, 140);
    expect(marksOf(layer).map((m) => m.alpha), 'unit 40: still full').toEqual([1]);
    layer.draw(scene, 0, 150);
    const at50 = marksOf(layer).map((m) => m.alpha);
    expect(at50, 'unit 50: half way down the fade').toHaveLength(1);
    expect(at50[0]).toBeCloseTo(0.5, 9);
    layer.draw(scene, 0, 160);
    expect(marksOf(layer), 'unit 60: not drawn').toHaveLength(0);
    layer.draw(scene, 0, 400);
    expect(marksOf(layer), 'and never again for the same move').toHaveLength(0);
  });

  it('a second path change restarts the span', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(rerouteScene([[1, 5]], [[1, 1]]), 0, 0);
    layer.draw(rerouteScene([[1, 5]], [[1, 1]]), 0, 50);
    expect(marksOf(layer)[0].alpha).toBeCloseTo(0.5, 9);
    layer.draw(rerouteScene([[1, 6]], [[1, 2]]), 0, 55); // moved again
    expect(marksOf(layer).map((m) => m.alpha), 'the second move starts at full').toEqual([1]);
    layer.draw(rerouteScene([[1, 6]], [[1, 2]]), 0, 95);
    expect(marksOf(layer).map((m) => m.alpha), '40 units after the second move').toEqual([1]);
    layer.draw(rerouteScene([[1, 6]], [[1, 2]]), 0, 115);
    expect(marksOf(layer), '60 units after the second move').toHaveLength(0);
  });

  it('two moved cables are both marked, the unmoved one is not', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(rerouteScene([[1, 5], [2, 8], [3, 11]], [[1, 1], [3, 4]]), 0, 0);
    const resting = restingOf(layer);
    const marks = marksOf(layer);
    expect(marks, 'two marks').toHaveLength(2);
    expect(marks.map((m) => m.pts), 'on wires 1 and 3, not 2').toEqual([resting[0].pts, resting[2].pts]);
  });

  it('a rewind clears a live mark and never flashes a re-routed cable again', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(rerouteScene([[1, 5], [2, 8]], [[1, 1]], 10), 0, 0);
    expect(marksOf(layer), 'live before the rewind').toHaveLength(1);
    layer.draw(rerouteScene([[1, 5], [2, 8]], [[1, 1]], 5), 0, 10); // scene.tick moved back
    expect(marksOf(layer), 'a rewind clears the live mark').toHaveLength(0);
    // An expired mark, then a rewind: the generation is still in the map and must not
    // be re-latched with a fresh start (75-RESEARCH Pitfall 6).
    const l2 = createWireLayer(LOCKED_SKIN);
    l2.draw(rerouteScene([[1, 5]], [[1, 1]], 10), 0, 0);
    l2.draw(rerouteScene([[1, 5]], [[1, 1]], 12), 0, 70);
    expect(marksOf(l2), 'expired').toHaveLength(0);
    l2.draw(rerouteScene([[1, 5]], [[1, 1]], 3), 0, 71);
    expect(marksOf(l2), 'the rewind does not flash it').toHaveLength(0);
    l2.draw(rerouteScene([[1, 5]], [[1, 1]], 4), 0, 72);
    expect(marksOf(l2), 'nor the frame after').toHaveLength(0);
  });

  it('a pinned effectiveClock with an advancing markClock still expires (reduced motion)', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    const scene = rerouteScene([[1, 5]], [[1, 1]]);
    layer.draw(scene, 7, 0);
    layer.draw(scene, 7, 30);
    expect(marksOf(layer), 'live at 30 with the effective clock pinned').toHaveLength(1);
    layer.draw(scene, 7, 60);
    expect(marksOf(layer), 'gone at 60: the mark reads markClock, not the pin').toHaveLength(0);
  });

  it('a fixture scene without wireReroutes draws no mark and does not throw', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    expect(() => layer.draw(rerouteScene([[1, 5]], null), 0, 0)).not.toThrow();
    expect(restingOf(layer), 'the cable still draws').toHaveLength(1);
    expect(marksOf(layer)).toHaveLength(0);
  });

  it('a wire with no generation is never marked', () => {
    const layer = createWireLayer(LOCKED_SKIN);
    layer.draw(rerouteScene([[1, 5]], []), 0, 0);
    expect(marksOf(layer)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LOW-ZOOM (plan 75-10, CABLE-07, 75-WALK.md GAP LOW-ZOOM): THE CABLE AND ITS MARK NEVER
// DRAW UNDER ONE SCREEN PIXEL. Both walks on the real binary saw a moved cable at 25% zoom
// show little or none of its re-route mark: the cable and the mark were stroked at
// CABLE_WIDTH, 2 world px, which at the camera's minimum zoom is half a screen pixel, and
// with antialias off half a pixel covers a pixel centre at some camera origins and none at
// others. This block pins the drawn WIDTH through the real layer, at the zoom the camera
// actually allows; `e2e/cable-min-zoom.spec.ts` reads the pixels.
// ---------------------------------------------------------------------------
const { MIN_ZOOM } = await import('../camera.ts');
const { CABLE_WIDTH: LOCKED_CABLE_WIDTH } = await import('../cableGeometry.ts');

describe('wires - the cable and its mark never draw under one screen pixel (LOW-ZOOM, plan 75-10)', () => {
  const BUILD = LOCKED_SKIN.palette.accents.build;
  const RESTING = LOCKED_SKIN.palette.cable;

  /** Draw the routed SRC -> DST cable, re-routed at generation 1, at camera zoom `zoom`. */
  function strokesAt(zoom: number): { resting: Polyline; mark: Polyline } {
    // Both closures return the zoom, which is what `pixiApp.ts` hands the layer at DPR 1.
    const layer = createWireLayer(LOCKED_SKIN, () => zoom, () => zoom);
    const scene = routedScene([SRC, DST], [routedWire(1, SRC, DST)]);
    (scene as unknown as { wireReroutes: Map<number, number> }).wireReroutes = new Map([[1, 1]]);
    layer.draw(scene, 0, 0); // markClock 0 at first sighting: the mark is at alpha 1
    const cables = cablesOf(layer as unknown as SplitLayer);
    const resting = cables.find((p) => p.color === RESTING);
    const mark = cables.find((p) => p.color === BUILD);
    expect(resting, `the resting stroke at zoom ${zoom}`).toBeDefined();
    expect(mark, `the re-route mark stroke at zoom ${zoom}`).toBeDefined();
    return { resting: resting as Polyline, mark: mark as Polyline };
  }

  it('at MIN_ZOOM, 0.3 and 0.45 the resting stroke and the mark are each at least one screen pixel wide', () => {
    // The minimum zoom is READ from the camera, never restated, so a camera that allowed a
    // lower zoom would be measured here rather than escaping this case.
    expect(MIN_ZOOM, 'the camera exports its minimum zoom').toBeGreaterThan(0);
    for (const zoom of [MIN_ZOOM, 0.3, 0.45]) {
      const { resting, mark } = strokesAt(zoom);
      for (const [name, p] of [
        ['resting', resting],
        ['mark', mark],
      ] as const) {
        const screen = p.width * zoom;
        expect(screen >= 1, `${name}: screen width ${screen} at zoom ${zoom}`).toBe(true);
      }
      // UI-SPEC 4.2: the mark is stroked at the cable's own width, at every zoom.
      expect(mark.width, `the mark keeps the cable's width at zoom ${zoom}`).toBe(resting.width);
    }
  });

  it('at zoom 0.5, 1 and 2 both strokes are exactly CABLE_WIDTH (nothing at or above 50% moves)', () => {
    for (const zoom of [0.5, 1, 2]) {
      const { resting, mark } = strokesAt(zoom);
      expect(resting.width, `resting at zoom ${zoom}`).toBe(LOCKED_CABLE_WIDTH);
      expect(mark.width, `mark at zoom ${zoom}`).toBe(LOCKED_CABLE_WIDTH);
    }
    expect(LOCKED_CABLE_WIDTH, 'the locked cable width').toBe(2);
  });
});

// ---------------------------------------------------------------------------
// THE CABLES AS PLOTTED, READ OFF THE REAL GRAPHICS (plan 77-05, 77 D-04). `cablePolylines()`
// is the canvas half of done-test leg 5's "the cable comes back in the same place": the live
// walk had only model geometry for a cable, and a wire layer that drew nothing, or drew a
// stale line, passed every model read and both render-health helpers.
//
// REAL PIXI, NOT THE STUB. The read walks the cables Graphics' own `context.instructions`,
// which the recording stub at the top of this file does not have, so a case against the stub
// would be a check on the double (`overlay.plot.test.ts` header, the same reasoning). The
// stub stays registered for every case above; this block, LAST in the file so nothing after
// it can be affected, drops the mock and imports a FRESH `wires.ts`, which then builds real
// Graphics. The stubbed layer is still useful here as the independent witness of WHAT was
// stroked: the same scene drawn on both, the stub's recorded resting polylines are the
// vertices the real read must return.
// ---------------------------------------------------------------------------
describe('wires - cablePolylines, the resting cables read off the real Graphics (plan 77-05)', () => {
  const RESTING = LOCKED_SKIN.palette.cable;
  let createRealWireLayer: typeof createWireLayer;

  beforeAll(async () => {
    vi.resetModules();
    vi.doUnmock('pixi.js');
    ({ createWireLayer: createRealWireLayer } = await import('./wires.ts'));
  });

  /** A 1x1 electrical machine with an Out on `outSide` (port 0) and an In on `inSide` (port 1). */
  function pairNode(id: number, cellX: number, cellY: number, outSide: number, inSide: number): NodeViewT {
    return {
      id,
      kind: 2,
      cell_x: cellX,
      cell_y: cellY,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [
        { index: 0, cell_x: cellX, cell_y: cellY, side: outSide, role: 1, medium: 1 },
        { index: 1, cell_x: cellX, cell_y: cellY, side: inSide, role: 0, medium: 1 },
      ],
    } as NodeViewT;
  }

  /** One leg of a pair, routed by the shipped router from `from`'s Out to `to`'s In. */
  function pairLeg(id: number, from: NodeViewT, to: NodeViewT): WireViewT {
    const a = from.ports[0];
    const b = to.ports[1];
    const r = wireRoute(
      { cell: [a.cell_x, a.cell_y], side: a.side, body: bodyOfNode(from) },
      { cell: [b.cell_x, b.cell_y], side: b.side, body: bodyOfNode(to) },
    );
    if (!r.ok) throw new Error('the fixture route was rejected; the fixture is wrong, not the layer');
    return {
      id,
      from: { node: from.id, port: 0 },
      to: { node: to.id, port: 1 },
      path: r.geometry.tiles,
      pulses: [],
    } as WireViewT;
  }

  // The leg-1 shape in miniature: a forward leg and a return leg between two machines.
  const ROUTE_LIKE = pairNode(30, 2, 5, 1, 3); // Out faces E, In faces W
  const HANDLER_LIKE = pairNode(31, 8, 5, 1, 3); // Out faces E, In faces W
  const pairScene = (): SceneStateT =>
    routedScene(
      [ROUTE_LIKE, HANDLER_LIKE],
      [pairLeg(1, ROUTE_LIKE, HANDLER_LIKE), pairLeg(2, HANDLER_LIKE, ROUTE_LIKE)],
    );

  it('cablePolylines: a drawn pair reads back as two polylines on the vertices the layer stroked', () => {
    const real = createRealWireLayer(LOCKED_SKIN);
    expect(
      (real.cables.children[0] as unknown as { context?: { instructions?: unknown[] } }).context?.instructions,
      'the fresh import built a REAL Graphics, not the stub',
    ).toBeDefined();
    const stub = createWireLayer(LOCKED_SKIN);
    real.draw(pairScene(), 0, 0);
    stub.draw(pairScene(), 0, 0);
    // The real read FIRST, on its own: a layer that skips a cable's stroke reddens HERE, at
    // the read this block exists for, not at the witness below (which is drawn by the same
    // source and so reddens with it).
    expect(real.cablePolylines(), 'TWO DRAWN: the real Graphics holds two resting cable strokes').toHaveLength(2);
    const stroked = cablesOf(stub as unknown as SplitLayer)
      .filter((p) => p.color === RESTING)
      .map((p) => p.pts);
    expect(stroked, 'the witness: the stub recorded two resting cable strokes').toHaveLength(2);
    expect(real.cablePolylines()).toEqual(stroked);
  });

  it('cablePolylines: a scene with no wire reads back no polyline', () => {
    const real = createRealWireLayer(LOCKED_SKIN);
    real.draw(pairScene(), 0, 0);
    real.draw(routedScene([ROUTE_LIKE, HANDLER_LIKE], []), 0, 0);
    expect(real.cablePolylines()).toEqual([]);
  });

  it('cablePolylines: a re-route mark stroked on the same Graphics is excluded, the count stays two', () => {
    const real = createRealWireLayer(LOCKED_SKIN);
    const scene = pairScene();
    (scene as unknown as { wireReroutes: Map<number, number> }).wireReroutes = new Map([[1, 1]]);
    real.draw(scene, 0, 0); // markClock 0 at first sighting: the mark is at alpha 1
    expect(real.rerouteMarkStrokes(), 'a re-route mark was plotted on the cables Graphics').toBeGreaterThan(0);
    expect(real.cablePolylines()).toHaveLength(2);
  });
});
