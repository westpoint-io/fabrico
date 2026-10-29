import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { SynthTexture } from '../synth/textureCache.ts';
import { seamEndTiles } from '../../protocol/seam.ts';

// MOTION-02 belt march: the belt layer swaps each tile's bound asset per frame to
// the current march-bucket asset, WITHOUT churning geometry. This suite is GPU-free -
// it mocks the `pixi.js` SCENE GRAPH with tiny fakes (the belt layer only needs
// Container / Sprite / Graphics) and injects fake-backed caches so the saturation
// counters (`created`) are directly assertable. Everything here is at the
// bucket-INDEX / object-identity level - no pixels, so nothing is a Phase 28
// quarantine candidate.
//
// PARTIAL MOCK, NOT A WHOLE ONE (VEC-01, plan 61-02). The mock now spreads the REAL
// module and overrides only the three scene-graph classes, so `GraphicsContext` and
// `GraphicsContextSystem` are Pixi's own. That is deliberate rather than expedient:
// the vector painter builds a REAL context and measures it through the project's own
// `measureContext` path, so the DEV vertex-budget net (VEC-04 / T-61-07) stays LIVE in
// this suite instead of being faked into a guaranteed pass. A hand-written
// GraphicsContext stub would have made the budget assertion vacuous exactly where a
// procedural builder is most likely to emit nothing at all. Both halves are
// bare-node-safe: a procedurally built context never touches a DOM (only `.svg()`
// does), which the H7 spike measured.
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  class Container {
    children: unknown[] = [];
    // Records the last-set x/y. A belt TILE is a Container as of plan 61-09 (it holds
    // the tread and the rail as two `Graphics`), and the tile is the object the FLOW-06
    // device-pixel snap moves - so the position has to be readable here and not only on
    // the leaf classes below.
    position = {
      x: 0,
      y: 0,
      set(x: number, y: number): void {
        this.x = x;
        this.y = y;
      },
    };
    rotation = 0;
    destroyed = false;
    addChild(...c: unknown[]): unknown {
      this.children.push(...c);
      return c[0];
    }
    removeChild(c: unknown): unknown {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    }
    removeChildren(): unknown[] {
      const r = this.children;
      this.children = [];
      return r;
    }
    destroy(opts?: { children?: boolean }): void {
      this.destroyed = true;
      // Modelled rather than stubbed, so "a removed tile takes its rail child with it"
      // is an assertable claim instead of a hope. A bare `destroy()` deliberately does
      // NOT touch the children - which is exactly the orphaning bug being guarded.
      if (opts?.children === true) {
        for (const c of this.children) (c as { destroy?: () => void }).destroy?.();
        this.children = [];
      }
    }
  }
  class Sprite {
    texture: unknown;
    anchor = { set: (): void => {} };
    // Records the last-set x/y so a test can read a tile Sprite's snapped position
    // (FLOW-06 device-pixel tread snap). `set` is a real method so `this` binds to
    // the position object when the layer calls `sprite.position.set(x, y)`.
    position = {
      x: 0,
      y: 0,
      set(x: number, y: number): void {
        this.x = x;
        this.y = y;
      },
    };
    rotation = 0;
    constructor(tex?: unknown) {
      this.texture = tex;
    }
    destroy(): void {}
  }
  // 56-05 (VEC-04): a CONSTRUCTION counter on the mocked Graphics class.
  //
  // WHAT THIS COUNTER MEANS CHANGED IN PLAN 61-02, and the counter is kept rather than
  // deleted because the property it guards survived the change of representation.
  // Before VEC-01 the tread was Sprites out of the texture cache and ANY per-tile
  // Graphics was the regression. Now a straight tile IS a Graphics - but it is a
  // Graphics bound to ONE shared `GraphicsContext`, and in Pixi v8 tessellated geometry
  // lives on the CONTEXT, not on the Graphics. So the cost that must not scale with
  // belt length is the CONTEXT count, which is what the rewritten case asserts, while
  // this counter keeps its other job intact: proving the PER-FRAME path allocates
  // nothing at all.
  const graphicsBuilds = { n: 0 };
  (globalThis as unknown as { __graphicsBuilds: typeof graphicsBuilds }).__graphicsBuilds =
    graphicsBuilds;
  class Graphics {
    // Records every circle(x,y,r) drawn since the last clear() so the FLOW-07
    // dominant-cap suite can read the last cap radius / count (docked vs undocked).
    circles: Array<{ x: number; y: number; r: number }> = [];
    // THE ORDERED INSTRUCTION LOG (Phase 74, LINK-03). `circles` alone cannot tell a
    // FILLED disc from a STROKED ring, cannot see the plug stem at all, and cannot say
    // in what order anything was plotted - so a junction collar that plotted two circles
    // and then inked NEITHER of them would pass a circles-only assertion completely.
    // This project has shipped that exact defect before (phase 73's `alertRingsPainted`
    // latched on a non-null field, so a build whose ring drew nothing passed the whole
    // user-visible claim). The log is what makes "it was PAINTED" assertable rather than
    // "the function was CALLED".
    ops: Array<{
      op: 'circle' | 'fill' | 'stroke' | 'moveTo' | 'lineTo' | 'arcTo';
      x?: number;
      y?: number;
      // `arcTo`'s second control point (plan 74.1-08): the preview stroke's end-corner
      // cases assert the whole ordered path, arcs included.
      x2?: number;
      y2?: number;
      r?: number;
      width?: number;
      color?: number;
    }> = [];
    // Recorded so "a removed tile takes its two children with it" is assertable. A belt
    // tile is a `Container` holding a tread `Graphics` and a rail `Graphics` (plan
    // 61-09); it is deliberately NOT a `Graphics` with children, because Pixi 8 warns
    // `addChild: Only Containers will be allowed to add children` on a view object.
    destroyed = false;
    // The bound geometry. Constructed WITH a context on a straight tile (so Pixi
    // allocates no owned context), then live-swapped per frame - the H7 route.
    context: unknown;
    position = {
      x: 0,
      y: 0,
      set(x: number, y: number): void {
        this.x = x;
        this.y = y;
      },
    };
    rotation = 0;
    constructor(ctx?: unknown) {
      this.context = ctx;
      graphicsBuilds.n++;
    }
    // Records the last arcTo rounding radius so the FLOW-05 single-source ELBOW_R
    // assertion can read what `drawBeltTilePath` strokes a corner with.
    lastArcRadius: number | null = null;
    clear(): this {
      this.circles = [];
      this.ops = [];
      return this;
    }
    moveTo(x?: number, y?: number): this {
      this.ops.push({ op: 'moveTo', x, y });
      return this;
    }
    lineTo(x?: number, y?: number): this {
      this.ops.push({ op: 'lineTo', x, y });
      return this;
    }
    stroke(o?: number | { width?: number; color?: number }): this {
      const s = typeof o === 'object' && o !== null ? o : {};
      this.ops.push({ op: 'stroke', width: s.width, color: s.color });
      return this;
    }
    circle(x: number, y: number, r: number): this {
      this.circles.push({ x, y, r });
      this.ops.push({ op: 'circle', x, y, r });
      return this;
    }
    fill(o?: number | { color?: number }): this {
      const c = typeof o === 'object' && o !== null ? o.color : o;
      this.ops.push({ op: 'fill', color: c });
      return this;
    }
    arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): this {
      this.lastArcRadius = radius;
      this.ops.push({ op: 'arcTo', x: x1, y: y1, x2, y2, r: radius });
      return this;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  // Only the three scene-graph classes are replaced; everything else - crucially
  // `GraphicsContext` and `GraphicsContextSystem` - stays Pixi's own.
  return { ...actual, Container, Sprite, Graphics };
});

/**
 * A CALL COUNTER on the ONE function the phase accumulator is built from (plan 61-04).
 *
 * BELT-02 requires the accumulator to run on the geoKey rebuild and NOT in the
 * per-frame loop, because a tile's tail offset is pure topology. That is a claim about
 * WHEN CODE RUNS, and no end-state assertion can see it: the offsets array holds the
 * same numbers whether it was built once or rebuilt sixty times a second. A counter on
 * `tileFlowLength` is the smallest honest observable - it is called exactly once per
 * tile per accumulator run and nowhere else in the layer.
 *
 * PARTIAL, exactly like the `pixi.js` mock above: everything else in the geometry
 * module - the emitters, `bucketOf`, every constant `beltPainter.ts` reads - passes
 * through untouched, so nothing about the march itself is faked.
 */
const flowLengthCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../synth/beltGeometry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../synth/beltGeometry.ts')>();
  return {
    ...actual,
    tileFlowLength: (isCorner: boolean): number => {
      flowLengthCalls.n++;
      return actual.tileFlowLength(isCorner);
    },
  };
});

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is safe).
// `flowDirAt` is the FLOW-01 addition; `cornerChiralityOf` + `drawBeltTilePath` are
// the FLOW-05 additions (cornerChiralityOf does not exist yet in the RED state).
const {
  anchorKey,
  createBeltLayer,
  flowDirAt,
  cornerChiralityOf,
  cornerQuarterTurns,
  drawBeltTilePath,
  isTurningCorner,
  tailOffsets,
} = await import('./belts.ts');
// BELT-06 (plan 61-04): the march selector moved to the Pixi-free geometry module and
// `marchPhaseOf` is gone from `belts.ts`. See the march-bucket describe block for why
// this is a rename rather than a repurpose.
const { bucketOf, bucketSizePx, worstCaseQuantizationPx } = await import(
  '../synth/beltGeometry.ts'
);
// SLOT-03 (plan 62-01): `bucketOf` gained a fourth parameter, the BELT's own march
// advance in px per sim tick, so each belt walks the shared buckets at its own rate.
//
// PLAN 62-04 DELETED THE MODULE CONSTANT THIS ALIAS USED TO IMPORT (D-05): the advance
// is now derived per belt from its slot pitch and its interval, both off the wire, so
// there is no shipped BASE advance to import. The cases below that need a concrete
// advance derive it through the same public function the layer uses, at the shipped 8px
// slot pitch, which is what a belt at the pre-change identity interval actually gets.
const { marchPxPerTick, MARCH_NYQUIST_CEILING_PX_PER_TICK } = await import(
  '../synth/beltGeometry.ts'
);
const SHIPPED_SLOT_PITCH_PX = 8; // 32px cell / 4 slots per tile, hand-typed
/**
 * A TEST LATTICE, NEVER A CANDIDATE PACE.
 *
 * At this interval the tread advances `8 / 6` = 1.333333px per tick, which is EXACTLY
 * one bucket of the 16px dash period at K = 12 - the one-bucket-per-sim-tick lattice
 * every march-selector case below was written against, and the pace the deleted
 * art-directed constant carried. Choosing it here keeps those cases pinning the
 * SELECTOR (euclidean wrap, offset subtraction, one asset per bucket, the frozen
 * mid-dash bucket) rather than accidentally pinning a speed.
 *
 * **`62-CONTEXT.md` D-19 reserves the SHIPPED interval to the maintainer, chosen at the wave-5
 * sitting on the real WebKitGTK binary. This number is a lattice for a test fixture and
 * nothing in this file proposes a pace.** At the pre-change IDENTITY interval of 1 the
 * tread advances a whole 8px slot per tick, which is exactly the aliasing ceiling, so
 * only two distinct buckets exist and no selector property is legible at all - which is
 * itself asserted, once, in the identity case below.
 */
const ONE_BUCKET_PER_TICK_INTERVAL = 6;
const LATTICE_PX_PER_TICK = marchPxPerTick(SHIPPED_SLOT_PITCH_PX, ONE_BUCKET_PER_TICK_INTERVAL);
/**
 * THE PRE-CHANGE INTERVAL, KEPT. Not a candidate pace and no longer the shipped one -
 * see {@link SHIPPED_TICKS_PER_SLOT} directly below, which is what ships as of plan
 * 62-09. The identity cases are correct statements about an interval of 1 and they are
 * what the shipped margin is halved *from*, so they stay.
 */
const IDENTITY_PX_PER_TICK = marchPxPerTick(SHIPPED_SLOT_PITCH_PX, 1);
/**
 * **THE SHIPPED BELT ADVANCE INTERVAL, HAND-TYPED.** The maintainer's value, judged at the
 * 2026-08-14 pace sitting on the real WebKitGTK binary and recorded in
 * `62-SITTING-VERDICT.md`, which is its only admissible source.
 *
 * IT IS A MIRROR OF A RUST CONSTANT AND IT IS CHECKED AGAINST ONE. The sim owns
 * `DEFAULT_TICKS_PER_SLOT` in `crates/fabrico-core/src/belt_slots.rs`; nothing on the
 * wire carries the DEFAULT (a packet carries each belt's own `ticks_per_slot`, which a
 * scene is free to vary), so the frontend has no runtime source for it and a literal is
 * the only honest form. The suite therefore reads the Rust source and asserts the two
 * agree - see the cross-language case below.
 *
 * **WHY A LITERAL AND NOT A DERIVATION (`62-CONTEXT.md` D-22).** A value computed from
 * the thing it pins agrees with that thing at EVERY value. This is not a hypothetical
 * here: plan 62-04 asserted the Nyquist conflict in three suites specifically so they
 * would redden the day the real interval landed, that day came, and **none of the three
 * moved**, because each hand-typed the interval as `1` and a Rust constant cannot move a
 * TypeScript literal (`62-CORPUS-REVIEW.md` FINDING 9-F). Restating the truth with a
 * hand-typed `2` alone would have reproduced that miss one interval later. The literal
 * plus the source check is the fix: two independent statements of one fact, compared.
 */
const SHIPPED_TICKS_PER_SLOT = 2;
/**
 * The shipped tread advance, **hand-typed as 4 px per sim tick** and then corroborated
 * against the function the layer actually calls. An 8 px slot crossed in 2 ticks is
 * 4 px a tick, which is HALF the 8 px aliasing ceiling: margin 0.5 against a wall of
 * 1.0. That is the phase's headline - the tread came off the wall - and it is asserted
 * rather than narrated.
 */
const SHIPPED_PX_PER_TICK = 4;
// SAFE-02: the shipped reduced-motion pin, imported so the freeze case can corroborate
// its own LITERAL 18 against it. The case pins the literal, never this constant's own
// derivation - see the case for why.
const { REDUCED_MOTION_FRAME } = await import('../../chrome/reducedMotion.ts');
const { SynthTextureCache } = await import('../synth/textureCache.ts');
// VEC-01: ALL FOUR belt families live in the belt geometry cache as of plan 61-03
// (plan 61-02 moved the straights; 61-03 moved the corners with the radius). Every
// saturation / boundedness assertion that used to read the texture cache reads this one
// now. Nothing is weakened - each moved case is restated on the counter that actually
// moves, and the texture cache's new emptiness is asserted positively rather than left
// to pass by being zero.
const { BeltContextCache, beltContextKey } = await import('../synth/beltContextCache.ts');
// cornerCommands: the REAL corner geometry composed with the layer's quarter-turn math
// in the quadrant-after-rotation suite (D-05) - the geometry-times-rotation composition
// no single-tier test saw before F2a escaped. RE-POINTED BY PLAN 61-07 off the raster
// corner bake, which it deleted, onto the emitter that actually draws the shipped
// corner; the emitter is Pixi-free (flat point lists), so the suite stays mock-safe
// exactly as it was when it read PixelMatrix bytes.
const { cornerCommands, BELT_MARCH_BUCKETS } = await import('../synth/beltGeometry.ts');
// Phase 53: the texture-cache bound is asserted against the PAINTER the layer is
// driving (`3 * painter.phases + 3`), never a module literal - see the bounded test.
const { SHIPPED_PAINTER, beltPainterForBuckets } = await import('../synth/beltPainter.ts');
// BELT-06 (plan 61-06): the three bucket counts the Graphics panel offers. Swept rather
// than sampled, for the same reason `beltGeometry.digest.test.ts` sweeps them: a knob
// move must not be able to leave a legal value ungated.
const { BELT_MARCH_BUCKET_COUNTS } = await import('../synth/beltGeometry.ts');
const { LOCKED_SKIN } = await import('../synth/skins/locked.ts');
const { state_tag } = await import('../../protocol/kinds.ts');
// FLOW-03/06: the LOD threshold reads CELL; the tread snap is asserted against the
// SAME `snapToDevicePixel` the layer consumes (round(v*q)/q).
const { snapToDevicePixel } = await import('./items.ts');
// FLOW-05: ELBOW_R is now the SINGLE geometry-owned corner radius (preview ==
// committed). The suite asserts the belt-layer preview strokes THIS constant.
const { BELT_DASH_PERIOD, CELL, ELBOW_R } = await import('../../../shared/geometry.ts');
// FLOW-01/WR-01: the single-tile straight tread must agree with the item flow, so
// the suite derives the expected direction from the SAME beltItemPolyline the item
// layer consumes (interp.ts is pixi-free, safe to import under the pixi mock).
const { beltItemPolyline } = await import('../interp.ts');
// `Sprite` is pulled in alongside `Graphics` for the VEC-04 batching block, which
// asserts the tread's display-object TYPE rather than duck-typing it.
const { Graphics, Sprite } = await import('pixi.js');
type SceneStateT = import('../sceneState.ts').SceneState;
type BeltViewT = import('../../protocol/decode.ts').BeltView;
type TileViewT = import('../../protocol/decode.ts').TileView;

/** A GPU-free cache: every "texture" is a unique tagged object (no Pixi bake). */
function fakeCache(): InstanceType<typeof SynthTextureCache> {
  let n = 0;
  return new SynthTextureCache((): SynthTexture => ({ id: n++, destroy: (): void => {} }) as never);
}

/** A one-belt static scene: a 3-tile straight run, undocked (no end plugs). */
function straightBeltScene(ticksPerSlot: number = ONE_BUCKET_PER_TICK_INTERVAL): SceneStateT {
  const tiles = [
    { cell_x: 2, cell_y: 5, kind: { Straight: { axis: 0 } } },
    { cell_x: 3, cell_y: 5, kind: { Straight: { axis: 0 } } },
    { cell_x: 4, cell_y: 5, kind: { Straight: { axis: 0 } } },
  ];
  const belt: BeltViewT = {
    id: 1,
    // **CORRECTED IN PLAN 62-04, AND IT WAS WRONG BEFORE THIS PHASE COULD SEE IT.** This
    // read a flat `latency: 60` on a three-tile belt, i.e. TWENTY slots per tile, which
    // no well-formed packet can carry: the host ships `latency = SLOTS_PER_TILE * tiles`
    // (`belt_slots.rs slot_count`), and `interp.ts` calls a belt whose slot count is not
    // a whole multiple of its tile count a DEGRADE rather than the model. It passed
    // because nothing in this suite read `latency` until the tread's px-per-tick started
    // deriving the slot pitch from it (D-05). Written as the host's own invariant so it
    // cannot drift again.
    latency: 4 * tiles.length,
    fill: 0,
    items: [],
    tiles,
    docks: [],
    // SLOT-03: appended LAST after `docks`. LOAD-BEARING HERE: the layer derives the
    // tread's px-per-tick from it, so a fixture at another value re-times every march
    // assertion in this file. It defaults to the one-bucket-per-tick TEST LATTICE (see
    // `ONE_BUCKET_PER_TICK_INTERVAL`); pass 1 for the pre-change identity.
    ticks_per_slot: ticksPerSlot,
  } as BeltViewT;
  return {
    tick: 0,
    nodes: new Map(),
    belts: new Map([[1, belt]]),
    canUndo: false,
    canRedo: false,
  } as unknown as SceneStateT;
}

/** Navigate the fake scene graph to a belt's tile objects (bound asset + rotation). */
function tileSprites(
  layer: { layer: { children: unknown[] } },
): Array<{ texture: unknown; rotation: number }> {
  const root = layer.layer.children[0] as { children: unknown[] };
  const tiles = root.children[0] as { children: unknown[] };
  return tiles.children as Array<{ texture: unknown; rotation: number }>;
}

/**
 * The ASSET one tile is currently bound to, whichever representation it uses.
 *
 * Plan 61-02 split the tread across two representations mid-migration: a STRAIGHT tile
 * is a `Graphics` bound to a shared `GraphicsContext`, a CORNER tile is still a
 * `Sprite` bound to a cached `Texture`. Every case below that used to read `.texture`
 * reads this instead, so the assertions keep asserting the same PROPERTY (which tiles
 * share one asset, when the asset changes, when it does not) across the change of
 * representation rather than being deleted with it.
 *
 * It THROWS on a tile bound to neither. A tile whose asset is `undefined` would make
 * every identity comparison below pass by comparing two nothings - the vacuous green
 * this helper exists to refuse.
 */
function boundOf(tile: unknown): unknown {
  // PLAN 61-09 PUT ONE MORE LEVEL IN. A tile is now a `Container` holding the TREAD
  // `Graphics` at index 0 and the RAIL `Graphics` at index 1, so "the asset this tile
  // is bound to" is the tread child's context. The fallbacks below are kept so this
  // helper still reads a bare leaf tile - which is what every non-belt caller has.
  const t = tile as { texture?: unknown; context?: unknown; children?: unknown[] };
  const tread = t.children?.[0] as { context?: unknown } | undefined;
  const bound = tread?.context ?? t.context ?? t.texture;
  if (bound === undefined || bound === null) {
    throw new Error('belt tile is bound to neither a GraphicsContext nor a Texture');
  }
  return bound;
}

/**
 * The RAIL asset one tile is bound to - the second child's context (plan 61-09).
 *
 * Separate from {@link boundOf} rather than a parameter of it, so a case that means
 * "the tread" cannot silently read the rail when an index moves.
 */
function railBoundOf(tile: unknown): unknown {
  const rail = (tile as { children?: unknown[] }).children?.[1] as
    | { context?: unknown }
    | undefined;
  if (rail?.context === undefined || rail.context === null) {
    throw new Error('belt tile carries no rail child bound to a GraphicsContext');
  }
  return rail.context;
}

/** Every tile's bound asset, index-aligned with the belt's tile run. */
function tileBinds(layer: { layer: { children: unknown[] } }): unknown[] {
  return tileSprites(layer).map(boundOf);
}

/**
 * Same tile Sprites, but typed to expose the recorded `position` (x/y) so the
 * FLOW-06 tread device-pixel snap is directly readable (the mock Sprite records
 * the last-set coordinates).
 */
function tileSpritesRaw(
  layer: { layer: { children: unknown[] } },
): Array<{ texture: unknown; rotation: number; position: { x: number; y: number } }> {
  const root = layer.layer.children[0] as { children: unknown[] };
  const tiles = root.children[0] as { children: unknown[] };
  return tiles.children as Array<{
    texture: unknown;
    rotation: number;
    position: { x: number; y: number };
  }>;
}

/** The unsnapped cell-center (world px) of a tile, mirroring `tileCenter`. */
const centerOf = (cx: number, cy: number): { x: number; y: number } => ({
  x: cx * CELL + CELL / 2,
  y: cy * CELL + CELL / 2,
});

// TileView factories (mirror interp.test.ts:20-30). axis: X=0, Y=1.
// Dir cardinals: N=0, E=1, S=2, W=3.
const straight = (cx: number, cy: number, axis: number): TileViewT =>
  ({ cell_x: cx, cell_y: cy, kind: { Straight: { axis } } }) as TileViewT;
const corner = (cx: number, cy: number, from: number, to: number): TileViewT =>
  ({ cell_x: cx, cell_y: cy, kind: { Corner: { from, to } } }) as TileViewT;

/** Wrap a tile list into a one-belt undocked static scene. */
function tileScene(
  tiles: TileViewT[],
  ticksPerSlot: number = ONE_BUCKET_PER_TICK_INTERVAL,
): SceneStateT {
  // SLOT-03 / D-05: `latency` is the host's invariant and `ticks_per_slot` the test
  // lattice - see `straightBeltScene` for why both are load-bearing here.
  const belt = {
    id: 1,
    latency: 4 * tiles.length,
    fill: 0,
    items: [],
    tiles,
    docks: [],
    ticks_per_slot: ticksPerSlot,
  } as BeltViewT;
  return {
    tick: 0,
    nodes: new Map(),
    belts: new Map([[1, belt]]),
    canUndo: false,
    canRedo: false,
  } as unknown as SceneStateT;
}

/** Expected straight/corner rotation: native WEST chevron turned to `dir`. */
const rotFor = (dir: number): number => (((dir + 1) % 4) * Math.PI) / 2;

describe('belts - march bucket selection (BELT-06, plan 61-04)', () => {
  // RENAMED, NOT REPURPOSED (`61-RESEARCH.md` Pitfall 8). The case this replaces pinned
  // `marchPhaseOf(frame)` - a pure integer wrap of the 10fps animation index, with no
  // clock and no offset in it. The new selector is `bucketOf(clockTicks, offsetPx, K, LATTICE_PX_PER_TICK)`,
  // which is neither integer-in nor offset-free, so satisfying the OLD NAME with the
  // NEW ARITHMETIC would have been a silent redefinition of what the case checked.
  // `marchPhaseOf` is gone from `belts.ts` entirely; the layer now calls the geometry
  // module's `bucketOf`, and the wrap it used to own survives inside `dashPhase` where
  // it is actually needed.
  it('selects the bucket from the CLOCK IN TICK UNITS, wrapping Euclidean', () => {
    const K = SHIPPED_PAINTER.phases;
    // One bucket per SIM TICK at the shipped rate - stated in ticks, never in frames.
    for (const t of [0, 1, 5, 11]) expect(bucketOf(t, 0, K, LATTICE_PX_PER_TICK)).toBe(t);
    expect(bucketOf(K, 0, K, LATTICE_PX_PER_TICK)).toBe(0); // one whole dash period later
    // Defensive: a negative pinned or rewound clock still lands in [0, K).
    for (const t of [-1, -13, -1000]) {
      expect(bucketOf(t, 0, K, LATTICE_PX_PER_TICK)).toBeGreaterThanOrEqual(0);
      expect(bucketOf(t, 0, K, LATTICE_PX_PER_TICK)).toBeLessThan(K);
    }
    expect(bucketOf(-1, 0, K, LATTICE_PX_PER_TICK)).toBe(K - 1);
  });

  it('at the IDENTITY interval the aliasing ceiling leaves only TWO buckets (D-05/D-06)', () => {
    // THE CONSEQUENCE OF D-05 AT THE PRE-CHANGE INTERVAL, asserted once so it is a
    // measured fact rather than a paragraph. The tread now carries at the speed of its
    // cargo, and a belt at the identity interval moves an item one whole 8px slot per
    // tick - which is EXACTLY half the 16px dash period, the maximally
    // direction-ambiguous displacement a periodic pattern can take. So the march reaches
    // buckets 0 and 6 and nothing else, at every legal K.
    //
    // **THIS WAS A TRANSIENT OF THE TREE AND IT IS NO LONGER SHIPPED.** Plan 62-09
    // replaced the identity with the maintainer's judged value of 2 - see the shipped case
    // immediately below, which is the one that states what the tree does now. This case
    // is kept because it is a correct statement about an interval of 1 and it is the
    // number the shipped margin is halved *from*; deleting it would leave the halving
    // with nothing to be half of.
    //
    // **A CORRECTION IN PLACE, `62-CORPUS-REVIEW.md` FINDING 9-F.** This comment used to
    // claim that "the day that value lands, this case reddens and a human reads the new
    // position count". That day came and IT DID NOT REDDEN, because the case takes its
    // interval from a hand-typed `1` and a Rust constant cannot move a TypeScript
    // literal. The claim is corrected rather than quietly dropped: a tripwire that was
    // believed armed and was not is worth more as a recorded miss than as a deleted
    // sentence. What actually arms it now is the cross-language source check below.
    const K = SHIPPED_PAINTER.phases;
    const visited = new Set<number>();
    for (let t = 0; t < 4 * K; t++) visited.add(bucketOf(t, 0, K, IDENTITY_PX_PER_TICK));
    expect([...visited].sort((a, b) => a - b)).toEqual([0, 6]);
    // ... and the two-bucket collapse is a property of the ADVANCE, not of K: raising
    // the step count buys a belt at this pace exactly nothing (the arithmetic that made
    // the Graphics panel's one setting a no-op, CHROME-03).
    for (const k of [12, 16, 24]) {
      const seen = new Set<number>();
      for (let t = 0; t < 4 * k; t++) seen.add(bucketOf(t, 0, k, IDENTITY_PX_PER_TICK));
      expect(seen.size, `distinct buckets at K = ${k}`).toBe(2);
    }
  });

  it('at the SHIPPED interval of 2 the tread is HALF the ceiling and reaches FOUR buckets', () => {
    // **THE PHASE'S HEADLINE, AND UNTIL PLAN 62-09 NO TEST STATED IT** (FINDING 9-F).
    // The interval the maintainer judged at the 2026-08-14 sitting is 2, so an 8px slot is crossed
    // in two sim ticks and the tread that carries at its cargo's speed advances 4px a
    // tick. The 16px dash period's aliasing ceiling is half of it, 8px, so the shipped
    // tread runs at exactly HALF the wall: a wagon-wheel margin of 0.5 where 1.0 is the
    // direction-ambiguous wall the identity case above sits on. The tread came off the
    // wall, and that is what D-06's hard floor was for.
    //
    // EVERY NUMBER BELOW IS HAND-TYPED AND THEN CORROBORATED, never derived from the
    // thing it checks (D-22). `SHIPPED_PX_PER_TICK` is the literal 4; the call to
    // `marchPxPerTick` is what has to agree with IT, not the other way round.
    expect(marchPxPerTick(SHIPPED_SLOT_PITCH_PX, SHIPPED_TICKS_PER_SLOT)).toBe(
      SHIPPED_PX_PER_TICK,
    );
    expect(SHIPPED_PX_PER_TICK).toBe(4);
    expect(MARCH_NYQUIST_CEILING_PX_PER_TICK).toBe(8);
    expect(BELT_DASH_PERIOD).toBe(16);
    // The margin, in the units `beltPainter.metrics.test.ts` states it in: advance over
    // half the pattern period, where 1.0 IS the wall.
    expect(SHIPPED_PX_PER_TICK / (BELT_DASH_PERIOD / 2)).toBe(0.5);
    // ...and exactly half of what the identity belt takes, which is the whole content of
    // "at most half today's pace" (D-06). Stated as a ratio so it cannot drift into
    // agreement with a moved identity.
    expect(SHIPPED_PX_PER_TICK / IDENTITY_PX_PER_TICK).toBe(0.5);

    // THE VISIBLE CONSEQUENCE THE IDENTITY CASE PROMISED A HUMAN WOULD READ. Two buckets
    // became FOUR: at 4px a tick the march lands on 0, 4, 8 and 12 px through a 16px
    // period, i.e. buckets 0, 3, 6, 9 at K = 12. Enumerated, not counted, so a different
    // four would still fail.
    const K = SHIPPED_PAINTER.phases;
    const visited = new Set<number>();
    for (let t = 0; t < 4 * K; t++) visited.add(bucketOf(t, 0, K, SHIPPED_PX_PER_TICK));
    expect([...visited].sort((a, b) => a - b)).toEqual([0, 3, 6, 9]);
    // Four distinct positions at EVERY legal K, because the position count is a property
    // of the advance and not of the bucket count - which is why raising K still buys the
    // shipped belt nothing, and why the Graphics panel's one setting had no visible effect
    // (CHROME-03, deleted in plan 91-03).
    for (const k of [12, 16, 24]) {
      const seen = new Set<number>();
      for (let t = 0; t < 4 * k; t++) seen.add(bucketOf(t, 0, k, SHIPPED_PX_PER_TICK));
      expect(seen.size, `distinct buckets at K = ${k}`).toBe(4);
    }
  });

  it('the hand-typed shipped interval MIRRORS the sim constant, read out of the Rust source', () => {
    // **THIS IS THE CASE THAT ARMS THE TRIPWIRE FINDING 9-F FOUND UNARMED.** Plan 62-04
    // asserted the Nyquist conflict in three suites "so it REDDENS the day the real
    // value lands". The value landed and nothing reddened, because all three hand-typed
    // the interval and no TypeScript literal can hear a Rust constant move. Restating
    // the truth with a hand-typed `2` fixes the STATEMENT and leaves the TRIPWIRE
    // exactly as dead - it would miss a move to 3 the same way the old ones missed the
    // move to 2. So the link is made here, once, explicitly.
    //
    // WHY A SOURCE READ AND NOT AN IMPORT OR A WIRE FIELD. A render packet carries each
    // BELT's own `ticks_per_slot`, never the DEFAULT (a scene may vary it per belt), so
    // there is no runtime value to read - `62-CORPUS-REVIEW.md` FINDING 9-F records this
    // as the reason the tripwire could not have been armed at the time. The committed
    // Rust source is the artifact a reviewer reads, and reading it is the same idiom
    // `glPinConfig.test.ts` uses to pin the Playwright GL args across files vitest
    // cannot import.
    //
    // THIS IS A COMPARISON, NOT A DERIVATION (D-22). Both sides are independent
    // statements of one fact: the frontend's literal stays a literal, and the assertion
    // is that the sim agrees with it. Nothing here computes the expected value from the
    // value under test, which is the failure mode that let Phase 60 measure 308 of 309
    // core tests green at a WRONG constant.
    const beltSlotsRs = readFileSync(
      fileURLToPath(new URL('../../../../crates/fabrico-core/src/belt_slots.rs', import.meta.url)),
      'utf8',
    );
    // The declaration, matched narrowly enough that a docblock mentioning the number
    // cannot satisfy it. `NonZeroU32::new(N)` is the constructor the constant is built
    // through; the match is anchored to the const's own name on the same statement.
    const decl = /pub const DEFAULT_TICKS_PER_SLOT: NonZeroU32 = match NonZeroU32::new\((\d+)\)/.exec(
      beltSlotsRs,
    );
    // A regex that found nothing must FAIL rather than skip: a renamed or restructured
    // constant is exactly the change this case exists to notice, and a null-guarded
    // no-op would report green on it.
    expect(decl, 'DEFAULT_TICKS_PER_SLOT declaration not found in belt_slots.rs').not.toBeNull();
    expect(Number(decl?.[1])).toBe(SHIPPED_TICKS_PER_SLOT);
  });

  // Plan 61-02: the straight tread's asset is a shared `GraphicsContext` rather than a
  // texture handle. The property asserted is unchanged - one asset per bucket, shared
  // by every tile, re-selected on a bucket change - so the case is re-pointed at
  // `boundOf`, not rewritten and not dropped.
  //
  // PLAN 61-04 DRIVES IT BY CLOCK. The old form passed `frame` alone and leaned on the
  // 2-argument default (`clock = frame * 6`); under the new march that still happened to
  // land on distinct buckets, which is exactly the kind of accidental pass worth
  // removing. The clock is now explicit, so the case exercises the march input itself.
  it('the same march bucket reuses one asset; a different bucket swaps to another', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    const scene = straightBeltScene();
    const K = SHIPPED_PAINTER.phases;

    layer.draw(scene, 0, 0); // bucket 0
    const atT0 = tileBinds(layer);

    layer.draw(scene, 0, K); // one whole dash period on -> bucket 0 -> SAME context
    expect(tileBinds(layer)).toEqual(atT0);

    layer.draw(scene, 0, 1); // one sim tick on -> bucket 1 -> a DIFFERENT context
    const atT1 = tileBinds(layer);
    expect(atT1[0]).not.toBe(atT0[0]);
    // Every tile of this straight-only belt shares the one bucket asset: a straight's
    // flow length is 32, a whole multiple of the 16px period, so every tile of a
    // straight run carries the identical residue and therefore the identical bucket.
    // That is the 0px straight-to-straight seam, read off the cache.
    expect(new Set(atT1).size).toBe(1);
  });

  // SLOT-03 (D-18): the pre-Phase-62 TREAD-APPEARANCE override, plan 62-07's fourth
  // `draw` argument. FEEL row 60-a is asked at today's shipped pace FIRST, and by the
  // time the sitting happens the tread no longer LOOKS like today's, so the sitting
  // panel can restore the appearance. What has to hold in this layer is only this: the
  // override actually changes the advance the layer derives, and it is null-defaulted so
  // no shipped caller can reach it by accident.
  it('the tread-appearance override CHANGES the derived advance, and is null by default', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    // The pre-change IDENTITY belt: 8px per tick, exactly the aliasing ceiling, so at
    // clock 1 it has walked a whole HALF dash period and sits in bucket K/2.
    const scene = straightBeltScene(1);
    const K = SHIPPED_PAINTER.phases;

    layer.draw(scene, 0, 1);
    const derived = tileBinds(layer);
    // Corroborate that this IS the wire-derived rate and not an accident of the fixture:
    // the 3-argument call and an explicit null must select the identical asset.
    layer.draw(scene, 0, 1, null);
    expect(tileBinds(layer)).toEqual(derived);

    // The override value is the file's OWN TEST LATTICE, not the superseded art figure.
    // The two happen to be the same number - 1.333333px per tick, exactly one bucket of
    // the 16px dash period at K = 12 - but this layer must assert the MECHANISM, and
    // naming the art axis here would put a copy of a deleted figure into the render
    // path's tests by the back door. The one sanctioned copy that used to live in the
    // define-gated pace panel went with that panel in plan 68-07, so there is now no
    // copy anywhere in the tree and this is the only place one could creep back in.
    // This case only needs an override that lands somewhere the derived rate does not.
    layer.draw(scene, 0, 1, LATTICE_PX_PER_TICK);
    const overridden = tileBinds(layer);
    expect(overridden[0]).not.toBe(derived[0]);
    expect(bucketOf(1, 0, K, LATTICE_PX_PER_TICK)).toBe(1);
    expect(bucketOf(1, 0, K, IDENTITY_PX_PER_TICK)).toBe(K / 2);

    // ...and dropping the override restores exactly the wire-derived asset. The switch
    // is reversible at runtime, which is the whole reason it exists.
    layer.draw(scene, 0, 1, null);
    expect(tileBinds(layer)).toEqual(derived);
  });

  it('the override goes through the SAME aliasing ceiling as the derived rate', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    const scene = straightBeltScene(1);
    // An absurd override is CLAMPED to the ceiling rather than trusted, so it selects
    // exactly what the identity belt (which already sits ON the ceiling) selects. The
    // wall is a property of the dash period, not of where the number came from.
    layer.draw(scene, 0, 1, 10_000);
    const clamped = tileBinds(layer);
    layer.draw(scene, 0, 1, null);
    expect(tileBinds(layer)).toEqual(clamped);
  });

  it('a non-finite or non-positive override falls back to the wire-derived rate', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    const scene = straightBeltScene(ONE_BUCKET_PER_TICK_INTERVAL);
    layer.draw(scene, 0, 3, null);
    const derived = tileBinds(layer);
    // A NaN advance is the recorded mechanism that stops the Pixi ticker permanently, so
    // the guard here is render HEALTH, not defensive decoration.
    for (const bad of [Number.NaN, 0, -4, Number.POSITIVE_INFINITY]) {
      layer.draw(scene, 0, 3, bad);
      expect(tileBinds(layer), `override ${String(bad)}`).toEqual(derived);
    }
  });
});

describe('belts - cache saturates, geometry never churns (Pitfall 1)', () => {
  // Plan 61-02: the straight families moved to the belt GEOMETRY cache, so the
  // saturation counter this case reads is that cache's.
  //
  // PLAN 61-04 DRIVES IT BY CLOCK AND BOUNDS IT BY THE PAINTER'S OWN K. The old form
  // swept `frame` and leaned on the 2-argument default (`clock = frame * 6`), which
  // under the new march advances SIX buckets a step and therefore reaches only the even
  // half of a 12-bucket lattice - it would have plateaued at 2 and passed a `<= 12`
  // bound while covering a sixth of the key space. Sweeping the CLOCK one tick at a
  // time is what makes "all K buckets visited exactly once each" a real statement.
  it('driving many ticks over a static scene plateaus created at <= K', () => {
    const contexts = new BeltContextCache();
    const layer = createBeltLayer(
      LOCKED_SKIN,
      fakeCache(),
      () => 1,
      () => 1,
      SHIPPED_PAINTER,
      contexts,
    );
    const scene = straightBeltScene();

    // Drive a full march cycle plus extra - every bucket 0..K-1 is requested once.
    const K = SHIPPED_PAINTER.phases;
    for (let t = 0; t <= 2 * K; t++) layer.draw(scene, 0, t);
    const afterCycle = contexts.created;
    expect(afterCycle).toBeLessThanOrEqual(K);
    expect(afterCycle).toBe(K); // all K buckets visited exactly once each

    // Drive 30 MORE ticks - the cache is saturated, so `created` does NOT grow.
    for (let t = 0; t < 30; t++) layer.draw(scene, 0, t);
    expect(contexts.created).toBe(afterCycle);
  });

  it('tile object identity is stable across >= 12 frames (no destroy/recreate per frame)', () => {
    const cache = fakeCache();
    const layer = createBeltLayer(LOCKED_SKIN, cache);
    const scene = straightBeltScene();

    layer.draw(scene, 0);
    const spritesAtStart = [...tileSprites(layer)];
    expect(spritesAtStart).toHaveLength(3);

    for (let f = 1; f <= 12; f++) layer.draw(scene, f);
    const spritesAfter = tileSprites(layer);

    // Same display-object instances - the geoKey stayed frame-free so rebuildTiles
    // never fired; only their bound asset was swapped. On the vector half that is the
    // H7 live `Graphics.context =` assignment, which constructs nothing.
    expect(spritesAfter).toHaveLength(spritesAtStart.length);
    for (let i = 0; i < spritesAtStart.length; i++) {
      expect(spritesAfter[i]).toBe(spritesAtStart[i]);
    }
  });

  it('the belt tread plots at IDLE only (state is irrelevant to a track)', () => {
    // A track is never WORKING/FAULTED; the cache should key buckets only, so a
    // second identical-bucket draw does not plot a new context. Plan 61-02 re-points
    // this at the geometry cache: on a straight-only scene the TEXTURE cache is now
    // untouched, so reading it here would have been a green over a counter that never
    // moves - the vacuous pass this re-point removes.
    const contexts = new BeltContextCache();
    const layer = createBeltLayer(
      LOCKED_SKIN,
      fakeCache(),
      () => 1,
      () => 1,
      SHIPPED_PAINTER,
      contexts,
    );
    const scene = straightBeltScene();
    layer.draw(scene, 3);
    const created1 = contexts.created;
    expect(created1).toBeGreaterThan(0); // non-vacuity: something really was plotted
    layer.draw(scene, 3);
    expect(contexts.created).toBe(created1);
    // Sanity: the state tag exists (belt plots at IDLE inside the layer).
    expect(state_tag.IDLE).toBeDefined();
  });
});

describe('belts - flow-true tread direction (FLOW-01)', () => {
  // (a) flowDirAt is the true 1-of-4 cardinal of travel toward the head, derived
  // from tiles[] order alone (tiles[i] -> tiles[i+1], head uses tiles[i-1] -> tiles[i]).
  it('flowDirAt gives the travel cardinal for E/W/N/S straight runs (incl. the head tile)', () => {
    // East run: cell_x increases -> E(1) for every tile including the head.
    const east = [straight(2, 5, 0), straight(3, 5, 0), straight(4, 5, 0)];
    expect(east.map((_, i) => flowDirAt(east, i))).toEqual([1, 1, 1]);
    // West run: cell_x decreases -> W(3).
    const west = [straight(4, 5, 0), straight(3, 5, 0), straight(2, 5, 0)];
    expect(west.map((_, i) => flowDirAt(west, i))).toEqual([3, 3, 3]);
    // North run: cell_y decreases -> N(0).
    const north = [straight(5, 4, 1), straight(5, 3, 1), straight(5, 2, 1)];
    expect(north.map((_, i) => flowDirAt(north, i))).toEqual([0, 0, 0]);
    // South run: cell_y increases -> S(2).
    const south = [straight(5, 2, 1), straight(5, 3, 1), straight(5, 4, 1)];
    expect(south.map((_, i) => flowDirAt(south, i))).toEqual([2, 2, 2]);
  });

  // The headline bug: an east-running straight must NOT render the native WEST
  // chevron (rotation 0). At the belt-layer it must land at rotFor(E) = PI (180deg).
  it('an east straight run renders every tread at rotFor(E)=PI, not the native 0', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    layer.draw(tileScene([straight(2, 5, 0), straight(3, 5, 0), straight(4, 5, 0)]), 0);
    for (const s of tileSprites(layer)) expect(s.rotation).toBeCloseTo(rotFor(1));
  });

  it('W/N/S straight runs render their treads at the matching flow rotation', () => {
    const cases: Array<[TileViewT[], number]> = [
      [[straight(4, 5, 0), straight(3, 5, 0), straight(2, 5, 0)], 3], // W
      [[straight(5, 4, 1), straight(5, 3, 1), straight(5, 2, 1)], 0], // N
      [[straight(5, 2, 1), straight(5, 3, 1), straight(5, 4, 1)], 2], // S
    ];
    for (const [tiles, dir] of cases) {
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
      layer.draw(tileScene(tiles), 0);
      for (const s of tileSprites(layer)) expect(s.rotation).toBeCloseTo(rotFor(dir));
    }
  });

  // (b0) D-01 helper pinning: cornerQuarterTurns' EXACT integer quarter-turn values
  // for every valid pair, pinned independently of the layer harness. The cw pairs
  // keep the ((to+1) mod 4) cardinal mapping; the ccw pairs use ((to+3) mod 4)
  // because the ccw bake is the cw bake's x-mirror (native at to=E, not to=W) and a
  // mirror cannot be oriented by the unmirrored formula (F2a).
  it('cornerQuarterTurns pins exact quarter-turn integers per chirality (D-01)', () => {
    // cw pairs (to === (from+1)%4): quarter turns = (to+1)%4.
    expect(cornerQuarterTurns(1, 2)).toBe(3); // E -> S
    expect(cornerQuarterTurns(3, 0)).toBe(1); // W -> N
    expect(cornerQuarterTurns(0, 1)).toBe(2); // N -> E
    expect(cornerQuarterTurns(2, 3)).toBe(0); // S -> W (the native cw bake)
    // ccw pairs (to === (from+3)%4): quarter turns = (to+3)%4.
    expect(cornerQuarterTurns(1, 0)).toBe(3); // E -> N
    expect(cornerQuarterTurns(3, 2)).toBe(1); // W -> S
    expect(cornerQuarterTurns(0, 3)).toBe(2); // N -> W
    expect(cornerQuarterTurns(2, 1)).toBe(0); // S -> E (the native ccw mirror)
  });

  // (b) All 8 L-bend (from,to) pairs, split by chirality (D-01): the corner tread
  // rotation is (cornerQuarterTurns(from, to) * PI) / 2 - the SAME exported helper
  // the layer consumes, so a future formula change cannot silently diverge from
  // this assertion. The 4 cw pairs' expected values are numerically UNCHANGED from
  // the pre-fix suite (regression guard that the fix touched only ccw); the 4 ccw
  // pairs previously asserted the buggy rotFor(to) and were exactly PI (180deg) off.
  it('every corner pair renders the tread at cornerQuarterTurns(from,to) quarter turns', () => {
    // Canonical chirality partition (mirrors the cornerChiralityOf table below).
    const cwPairs: Array<[number, number]> = [
      [1, 2], // E -> S
      [3, 0], // W -> N
      [0, 1], // N -> E
      [2, 3], // S -> W
    ];
    const ccwPairs: Array<[number, number]> = [
      [1, 0], // E -> N
      [3, 2], // W -> S
      [0, 3], // N -> W
      [2, 1], // S -> E
    ];
    for (const [from, to] of [...cwPairs, ...ccwPairs]) {
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
      // A lone corner tile is enough to read its own (from,to)-driven rotation.
      layer.draw(tileScene([corner(3, 3, from, to)]), 0);
      const [s] = tileSprites(layer);
      expect(
        s.rotation,
        `corner from=${from} to=${to} (${cornerChiralityOf(from, to)})`,
      ).toBeCloseTo((cornerQuarterTurns(from, to) * Math.PI) / 2);
    }
    // cw regression guard: the fix left cw rotations numerically identical to the
    // old uniform ((to+1)%4) mapping (only ccw changed).
    for (const [from, to] of cwPairs) {
      expect((cornerQuarterTurns(from, to) * Math.PI) / 2).toBeCloseTo(rotFor(to));
    }
  });

  // (c) Junction agreement: east straight -> corner turning south -> south straight.
  // Flow stays continuous across BOTH shared edges - the upstream straight matches
  // the corner's `from` at the entry edge, and the corner + downstream straight both
  // resolve to `to` at the exit edge. flowDirAt at the corner equals its own `to`.
  it('straights and their corner neighbour agree at the shared junction edges', () => {
    const cor = corner(2, 0, 1 /* from E */, 2 /* to S */);
    const run = [straight(0, 0, 0), straight(1, 0, 0), cor, straight(2, 1, 1)];
    const to = (cor.kind as { Corner: { to: number } }).Corner.to;
    const from = (cor.kind as { Corner: { from: number } }).Corner.from;
    // Upstream straight (index 1) exits E, matching the corner's `from` at the entry edge.
    expect(flowDirAt(run, 1)).toBe(from); // E(1)
    // The corner's own derived flow toward the head equals its `to`.
    expect(flowDirAt(run, 2)).toBe(to); // S(2)
    // Downstream straight (index 3) enters S, agreeing with the corner's `to` at the exit edge.
    expect(flowDirAt(run, 3)).toBe(to); // S(2)

    // And at the belt layer, the corner tread and the downstream straight tread
    // carry the identical `to`-driven rotation (they agree, not merely match number).
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    layer.draw(tileScene(run), 0);
    const sprites = tileSprites(layer);
    expect(sprites[2].rotation).toBeCloseTo(rotFor(to)); // corner
    expect(sprites[3].rotation).toBeCloseTo(rotFor(to)); // downstream straight
  });

  // (d) WR-01 regression: a LONE straight tile has no adjacency, so flowDirAt returns
  // its degenerate N(0) default. The tread must instead honour Straight.axis and land
  // on the SAME cardinal beltItemPolyline derives for the single-tile item flow, so a
  // 1-tile belt's tread and its item dots agree (FLOW-01), never a perpendicular smear.
  it('a single-tile straight tread honours its axis and matches the item flow (WR-01)', () => {
    // Map a beltItemPolyline's overall tail->head heading to a travel cardinal.
    const polyCardinal = (tiles: TileViewT[]): number => {
      const pl = beltItemPolyline(tiles);
      const a = pl.pts[0];
      const b = pl.pts[pl.pts.length - 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 1 : 3; // E / W
      return dy >= 0 ? 2 : 0; // S / N
    };
    // axis 0 (horizontal) -> item flow E(1); axis 1 (vertical) -> item flow S(2).
    for (const [axis, expectedDir] of [
      [0, 1],
      [1, 2],
    ] as Array<[number, number]>) {
      const tiles = [straight(3, 4, axis)];
      expect(polyCardinal(tiles)).toBe(expectedDir); // the item layer's own flow
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
      layer.draw(tileScene(tiles), 0);
      const [s] = tileSprites(layer);
      // The tread rotation equals the item flow direction (agreement by construction).
      expect(s.rotation).toBeCloseTo(rotFor(expectedDir));
      // Regression: NOT the old degenerate NORTH default that ignored the axis.
      expect(s.rotation).not.toBeCloseTo(rotFor(0));
    }
  });

  // Phase 89 red-first probe (plan 89-01, D-01), seen failing at PHASE89_START and turned on by
  // plan 89-03 (its gate and title suffix removed; the body is unchanged).

  it(
    'a_one_tile_west_belt_draws_its_tread_west',
    () => {
      // BELT-10 (D-15): the one tile of a belt fed and drained West, in the kind the seam table
      // gives it, is drawn with its tread turned West, not East.
      const tiles = seamEndTiles([straight(5, 5, 0)], [3], 3);
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
      layer.draw(tileScene(tiles), 0);
      const sprites = tileSprites(layer);
      console.log(`P89-BELT-10-tread kind=${JSON.stringify(tiles[0].kind)} rotations=${JSON.stringify(sprites.map((s) => s.rotation))} west=${rotFor(3)}`);
      expect(sprites, 'one tile drawn').toHaveLength(1);
      expect(sprites[0].rotation, 'the tread points West').toBeCloseTo(rotFor(3));
    },
  );

  // Plan 89-03 (BELT-10, D-15): a ZERO-TURN corner is a straight running along `from`. The seam
  // table answers `Corner{from: e, to: e}` for a one-tile belt so its flow direction survives;
  // every drawing site asks `isTurningCorner`, so the tread, the rail, the march offset and the
  // stroke all treat it as a straight, and every turning corner is unchanged.
  it('a zero-turn corner gets the straight tread and rail, turned along its flow (West and North)', () => {
    for (const [dir, name] of [
      [3, 'West'],
      [0, 'North'],
    ] as Array<[number, string]>) {
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
      layer.draw(tileScene([straight(5, 5, dir === 3 ? 0 : 1)]), 0);
      const [st] = tileSprites(layer);
      const straightTread = boundOf(st);
      const straightRail = railBoundOf(st);
      layer.draw(tileScene([corner(5, 5, dir, dir)]), 0);
      const [zt] = tileSprites(layer);
      expect(zt, `${name}: the zero-turn tile was rebuilt, not the straight object kept`).not.toBe(st);
      expect(boundOf(zt), `${name}: the zero-turn tile wears the STRAIGHT tread`).toBe(straightTread);
      expect(railBoundOf(zt), `${name}: and the STRAIGHT rail, not an elbow`).toBe(straightRail);
      expect(zt.rotation, `${name}: the tread points ${name}`).toBeCloseTo(rotFor(dir));
      expect(layer.treadRotationAt(5, 5), `${name}: the drawn-rotation read agrees`).toBeCloseTo(rotFor(dir));
    }
  });

  it('a turning corner still wears the elbow, at its cornerQuarterTurns rotation', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    layer.draw(tileScene([straight(5, 5, 0)]), 0);
    const straightTread = boundOf(tileSprites(layer)[0]);
    layer.draw(tileScene([corner(5, 5, 1, 2)]), 0);
    const [ct] = tileSprites(layer);
    expect(boundOf(ct), 'a turning corner is not drawn with the straight tread').not.toBe(straightTread);
    expect(ct.rotation).toBeCloseTo((cornerQuarterTurns(1, 2) * Math.PI) / 2);
    expect(isTurningCorner({ Corner: { from: 1, to: 2 } })).toBe(true);
    expect(isTurningCorner({ Corner: { from: 3, to: 3 } })).toBe(false);
    expect(isTurningCorner({ Straight: { axis: 0 } })).toBe(false);
  });

  it('a zero-turn corner flows a whole cell in the march offsets; a turning corner its quarter arc', () => {
    expect(tailOffsets([corner(5, 5, 3, 3), straight(4, 5, 0)])).toEqual([0, CELL]);
    const turning = tailOffsets([corner(5, 5, 1, 2), straight(5, 6, 1)]);
    expect(turning[1]).toBeLessThan(CELL);
    expect(turning[1]).toBeCloseTo((Math.PI / 2) * ELBOW_R);
  });

  it('treadRotationAt answers null on a cell no drawn belt covers', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    layer.draw(tileScene([straight(5, 5, 0)]), 0);
    expect(layer.treadRotationAt(6, 5)).toBeNull();
  });
});

describe('belts - zoom LOD + tread device-pixel snap (FLOW-03/06)', () => {
  // (a) LOD hard-cut (UI-SPEC C4, RESEARCH Pattern 4): below scale*CELL = 24 (RENDER-02
  // raised it from 16) every tile swaps from the phase-animated marching chevron to the
  // single, phase-independent bold LOD tick; at/above it the chevron returns.
  it('below zoom 0.75 (scale*CELL<24) shows the phase-independent LOD tick; at/above it the tread', () => {
    const cache = fakeCache();
    let z = 1;
    const layer = createBeltLayer(LOCKED_SKIN, cache, () => z, () => 1);
    const scene = straightBeltScene();

    // Full zoom: the tread is bucket-dependent (a +1 frame swaps the asset).
    z = 1; // scale*CELL = 32 >= 24
    layer.draw(scene, 0);
    const tread0 = tileBinds(layer);
    layer.draw(scene, 1);
    const tread1 = tileBinds(layer);
    expect(tread1[0]).not.toBe(tread0[0]);

    // Low zoom: the tick is phase-INDEPENDENT and one shared object across tiles.
    z = 0.25; // scale*CELL = 8 < 24
    layer.draw(scene, 0);
    const tickA = tileBinds(layer);
    layer.draw(scene, 1);
    const tickB = tileBinds(layer);
    expect(new Set(tickA).size).toBe(1); // one tick asset shared by every tile
    expect(tickB[0]).toBe(tickA[0]); // a +1 phase does NOT change the tick
    // A distinct family from the tread (not just a re-used bucket asset).
    expect(tickA[0]).not.toBe(tread0[0]);
    expect(tickA[0]).not.toBe(tread1[0]);
  });

  // (b) The threshold is a SINGLE inclusive cut at scale*CELL >= 24 (no hysteresis),
  // mirroring the Phase-29 grid minor-line hard-cut: chevron exactly at 24, tick below.
  // RENDER-02 raised the belt cut 16 -> 24 (the full-width corner arc bands smear in
  // the 0.5-1.0x band); this straight-belt case still falls back to the straight tick.
  it('the scale*CELL >= 24 threshold is inclusive (chevron at exactly 24, tick just below)', () => {
    const cache = fakeCache();
    let z = 0.5;
    const layer = createBeltLayer(LOCKED_SKIN, cache, () => z, () => 1);
    const scene = straightBeltScene();

    z = 24 / CELL; // scale*CELL === 24 -> inclusive -> full tread (bucket-dependent)
    layer.draw(scene, 0);
    const at24f0 = tileBinds(layer)[0];
    layer.draw(scene, 1);
    const at24f1 = tileBinds(layer)[0];
    expect(at24f1).not.toBe(at24f0);

    z = 23 / CELL; // scale*CELL = 23 < 24 -> tick (phase-independent)
    layer.draw(scene, 0);
    const belowF0 = tileBinds(layer)[0];
    layer.draw(scene, 1);
    const belowF1 = tileBinds(layer)[0];
    expect(belowF1).toBe(belowF0);
  });

  // (c) Both straight families stay bounded (Pitfall 6): the marching tread saturates
  // at K entries per painter and the tick adds exactly ONE more. Plan 61-02 re-points
  // the counter at the geometry cache, where both now live; plan 61-04 sweeps the CLOCK
  // rather than the frame index, for the reason the saturation case above records.
  it('the tread + tick families both stay bounded across a full march cycle', () => {
    const contexts = new BeltContextCache();
    let z = 1;
    const layer = createBeltLayer(
      LOCKED_SKIN,
      fakeCache(),
      () => z,
      () => 1,
      SHIPPED_PAINTER,
      contexts,
    );
    const scene = straightBeltScene();

    const K = SHIPPED_PAINTER.phases;
    z = 1; // drive every tread bucket
    for (let t = 0; t <= 2 * K; t++) layer.draw(scene, 0, t);
    z = 0.25; // drive a full cycle at tick LOD -> adds ONE phase-independent entry
    for (let t = 0; t <= 2 * K; t++) layer.draw(scene, 0, t);

    expect(contexts.created).toBe(K + 1);
  });

  // (d) Device-pixel tread snap (UI-SPEC C6, RESEARCH Pattern 8): each tile position
  // is snapToDevicePixel(center, q); it RE-snaps when q changes, while the Sprite
  // instances stay identical (geoKey unchanged -> no rebuild, Pitfall 3).
  it('tread positions snap to the device grid and re-snap on q change with stable identity', () => {
    const cache = fakeCache();
    let q = 1.234; // fractional -> center*q is non-integer -> snap actually moves it
    const layer = createBeltLayer(LOCKED_SKIN, cache, () => 1, () => q);
    const scene = straightBeltScene();
    const centers = [centerOf(2, 5), centerOf(3, 5), centerOf(4, 5)];

    q = 1.234;
    layer.draw(scene, 0);
    const spritesAtQ1 = [...tileSpritesRaw(layer)];
    spritesAtQ1.forEach((s, i) => {
      expect(s.position.x).toBeCloseTo(snapToDevicePixel(centers[i].x, 1.234));
      expect(s.position.y).toBeCloseTo(snapToDevicePixel(centers[i].y, 1.234));
    });
    // Sanity: the snap actually shifted a tile off its raw integer center.
    expect(spritesAtQ1.some((s, i) => s.position.x !== centers[i].x)).toBe(true);

    // Change q -> positions re-snap; the SAME Sprite instances persist (no rebuild).
    q = 2.468;
    layer.draw(scene, 1);
    const spritesAtQ2 = tileSpritesRaw(layer);
    for (let i = 0; i < spritesAtQ1.length; i++) {
      expect(spritesAtQ2[i]).toBe(spritesAtQ1[i]);
    }
    spritesAtQ2.forEach((s, i) => {
      expect(s.position.x).toBeCloseTo(snapToDevicePixel(centers[i].x, 2.468));
      expect(s.position.y).toBeCloseTo(snapToDevicePixel(centers[i].y, 2.468));
    });
  });
});

// ---------------------------------------------------------------------------
// FLOW-05 (corner chirality) + FLOW-07 (dominant dock cap)
// ---------------------------------------------------------------------------

/** The ends Graphics of a belt (root.children[1]), exposing its recorded circles. */
function endsGraphics(
  layer: { layer: { children: unknown[] } },
): { circles: Array<{ x: number; y: number; r: number }> } {
  const root = layer.layer.children[0] as { children: unknown[] };
  return root.children[1] as { circles: Array<{ x: number; y: number; r: number }> };
}

/**
 * A one-belt scene whose HEAD end docks into a machine OUT port (role 1). The
 * node exposes a single role-1 port on its SOUTH side; the belt's head tile sits
 * directly below it. `dockPort` (Head, non-fault) resolves `node.ports[port]`, so
 * resolveEndAnchor returns a role-1 anchor -> plugCapColor(1) = brightest ramp.
 */
function dockedBeltScene(): SceneStateT {
  const node = {
    id: 10,
    kind: 2,
    cell_x: 2,
    cell_y: 4,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 2, cell_y: 4, side: 2 /* S */, role: 1 /* Out */ }],
  };
  const belt = {
    id: 1,
    // The host's own invariant, `SLOTS_PER_TILE * tiles` - corrected in plan 62-04, see
    // `straightBeltScene`.
    latency: 4 * 2,
    fill: 0,
    items: [],
    tiles: [straight(2, 5, 1), straight(2, 6, 1)],
    docks: [{ end: 'Head', node: 10, port: 0 }],
    ticks_per_slot: ONE_BUCKET_PER_TICK_INTERVAL,
  } as unknown as BeltViewT;
  return {
    tick: 0,
    nodes: new Map([[10, node]]),
    belts: new Map([[1, belt]]),
    canUndo: false,
    canRedo: false,
  } as unknown as SceneStateT;
}

describe('belts - corner chirality + dominant dock cap (FLOW-05/07)', () => {
  // (a) cornerChiralityOf partitions the 8 valid (from,to) turns 4/4 by handedness:
  // a clockwise turn (to === (from+1)%4) is 'cw'; a counterclockwise turn
  // (to === (from+3)%4) is 'ccw'. A whole-sprite 90deg rotation reaches only 4 of
  // the 8 corners, so the OTHER chirality's bake covers the remaining 4.
  it('cornerChiralityOf maps the 8 (from,to) turns to a stable 4/4 cw/ccw partition', () => {
    const cw: Array<[number, number]> = [
      [1, 2], // E -> S
      [3, 0], // W -> N
      [0, 1], // N -> E
      [2, 3], // S -> W
    ];
    const ccw: Array<[number, number]> = [
      [1, 0], // E -> N
      [3, 2], // W -> S
      [0, 3], // N -> W
      [2, 1], // S -> E
    ];
    for (const [from, to] of cw) expect(cornerChiralityOf(from, to)).toBe('cw');
    for (const [from, to] of ccw) expect(cornerChiralityOf(from, to)).toBe('ccw');
    // The partition is exactly 4/4 (the two sets are disjoint and cover all 8).
    expect(cw).toHaveLength(4);
    expect(ccw).toHaveLength(4);
    // Handedness matches the (from+1)/(from+3) turn algebra for every turn.
    for (const [from, to] of [...cw, ...ccw]) {
      const expected = to === (from + 1) % 4 ? 'cw' : 'ccw';
      expect(cornerChiralityOf(from, to)).toBe(expected);
    }
  });

  // (b) A corner tile pulls a corner-FAMILY texture distinct from a straight tile's
  // chevron in the SAME frame; the per-frame swap keeps each tile on its own family.
  it('a corner tile uses a corner-family asset distinct from neighbouring straights', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    // east straight -> corner turning south -> south straight (the junction run).
    const run = [straight(0, 0, 0), straight(1, 0, 0), corner(2, 0, 1, 2), straight(2, 1, 1)];
    layer.draw(tileScene(run), 0);
    const binds = tileBinds(layer);
    const cornerAsset = binds[2];
    // The corner tile's asset differs from every straight tile's asset. Plan 61-02:
    // mid-migration these are two DIFFERENT KINDS of object (a Texture against a
    // GraphicsContext), which is why `boundOf` throws on an unbound tile - without it
    // this loop would pass by comparing two `undefined`s.
    for (const i of [0, 1, 3]) expect(binds[i]).not.toBe(cornerAsset);
    // The two straights UPSTREAM of the bend share ONE tread asset: same family, and
    // the same bucket because a straight's 32px flow length is a whole multiple of the
    // 16px dash period, so both carry residue 0.
    expect(binds[0]).toBe(binds[1]);
    // ... and the straight DOWNSTREAM of the bend does NOT, which is BELT-02 working
    // rather than a regression. Plan 61-04 accumulates phase per belt from the tail, so
    // tile 3 sits `32 + 32 + 25.132741` along flow and carries the corner's 9.132741
    // residue. Under the shipped global march phase every straight on every belt drew
    // the identical bucket, which is precisely why the dash used to jump at every bend.
    // The assertion is RE-DERIVED here, not relaxed: the sharing claim moved onto the
    // tiles that genuinely share, and the non-sharing is asserted positively beside it.
    expect(binds[3]).not.toBe(binds[0]);

    // Per-frame swap: after a +1 tick, the corner stays on the corner family and the
    // straights on the tread family (still distinct from each other).
    layer.draw(tileScene(run), 0, 1);
    const b2 = tileBinds(layer);
    expect(b2[2]).not.toBe(b2[0]);
    // ... and the whole lane really did march: every tile moved to a new bucket.
    for (let i = 0; i < b2.length; i++) expect(b2[i]).not.toBe(binds[i]);
  });

  // (c) Both corner chiralities + the straight chevron + the ticks stay bounded over
  // many frames (Pitfall 6): 2 chiralities x phases + straight phases + straight tick
  // + 2 corner-tick chiralities (RENDER-02: below the cut a corner falls back to its
  // chirality's bend-cue tick, NOT the straight tick, so it adds up to 2 more entries).
  it('the corner families stay bounded across a full march cycle for both chiralities', () => {
    // PLAN 61-03 MOVED THE COUNTER THIS CASE READS, and moving it was NOT optional.
    // The corner families were the last belt assets on the TEXTURE cache; now that they
    // are vector, `cache.created` is permanently 0 and the old assertion
    // (`0 <= 3K + 3`) would have gone on passing forever while measuring nothing - the
    // self-agreeing vacuity class `beltPainter.digest.test.ts` records about its own
    // count. The bound is asserted on the GEOMETRY cache, which is where the entries
    // now live, and the texture cache's emptiness is asserted POSITIVELY beside it so
    // the migration is stated rather than silently assumed.
    const cache = fakeCache();
    const contexts = new BeltContextCache();
    let z = 1;
    const layer = createBeltLayer(LOCKED_SKIN, cache, () => z, () => 1, SHIPPED_PAINTER, contexts);
    const cwRun = tileScene([corner(2, 0, 1, 2)]); // cw corner
    const ccwRun = tileScene([corner(2, 0, 1, 0)]); // ccw corner
    z = 1;
    for (let f = 0; f <= 2 * SHIPPED_PAINTER.phases; f++) {
      layer.draw(cwRun, f);
      layer.draw(ccwRun, f);
    }
    z = 0.25; // low zoom: corners fall back to their chirality's bend-cue tick (bounded)
    for (let f = 0; f <= 2 * SHIPPED_PAINTER.phases; f++) {
      layer.draw(cwRun, f);
      layer.draw(ccwRun, f);
    }
    // 2 chiralities x P corner phases + straight P + straight tick + 2 corner-ticks.
    // Phase 53: the bound is PARAMETERIZED off the painter the layer is driving
    // (SHIPPED_PAINTER here), not a module literal - so a variant with a different K is
    // held to ITS own bound rather than to the shipped one. Same arithmetic the golden
    // digest table enumerates (`3 * phases + 3`), so the two corroborate each other.
    // NEVER relax this to a larger literal.
    const painter = SHIPPED_PAINTER;
    expect(contexts.created).toBeLessThanOrEqual(3 * painter.phases + 3);
    // NON-VACUITY, and it is what makes the bound above a bound rather than a zero:
    // both corner chiralities really were plotted, at both LOD levels.
    expect(contexts.created).toBeGreaterThanOrEqual(4);
    // The belt layer bakes NOTHING any more. Stated as its own assertion so a
    // reintroduced raster belt asset reddens HERE, naming the reason.
    expect(cache.created, 'the belt layer holds no raster asset after plan 61-03').toBe(0);
  });

  // (d) FLOW-07 dominant cap: a docked end draws a solid cap of native radius 6,
  // floored on-screen via 6 / Math.min(1, scale); an undocked end draws NO cap.
  it('the docked cap radius follows 6 / Math.min(1, scale) at several zooms', () => {
    for (const z of [1, 2, 0.5, 0.25]) {
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => z, () => 1);
      layer.draw(dockedBeltScene(), 0);
      const ends = endsGraphics(layer);
      expect(ends.circles, `a docked end draws exactly one cap at zoom ${z}`).toHaveLength(1);
      expect(ends.circles[0].r).toBeCloseTo(6 / Math.min(1, z));
    }
  });

  it('the docked cap is dominant (native 6px) and grows below zoom 1, never shrinks above', () => {
    // At zoom 1 the native cap is 6 (was 2.5): dominant. At 0.25 it grows to 24
    // world px so the on-screen role read survives; at 2x it stays 6 (no shrink).
    const mk = (z: number): number => {
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => z, () => 1);
      layer.draw(dockedBeltScene(), 0);
      return endsGraphics(layer).circles[0].r;
    };
    expect(mk(1)).toBeCloseTo(6);
    expect(mk(0.25)).toBeCloseTo(24);
    expect(mk(2)).toBeCloseTo(6);
    // Strictly larger than the old 2.5px dot at every zoom (dominance guarantee).
    for (const z of [1, 0.5, 0.25]) expect(mk(z)).toBeGreaterThan(2.5);
  });

  // (d3) WR-03: capR = CAP_R / min(1, scale) is now guarded (scale 0 -> finite) and
  // ceilinged (never balloons past the lane), matching the itemDotGrow discipline.
  it('the dominant cap radius is finite at scale 0 and bounded below the min-zoom clamp (WR-03)', () => {
    const mk = (z: number): number => {
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => z, () => 1);
      layer.draw(dockedBeltScene(), 0);
      return endsGraphics(layer).circles[0].r;
    };
    // scale 0 (camera-init transient): finite, NOT Infinity, clamped to the ceiling (24).
    expect(Number.isFinite(mk(0))).toBe(true);
    expect(mk(0)).toBeCloseTo(24);
    // Below the 0.25 min-zoom clamp: bounded at the ceiling, does NOT balloon unbounded.
    expect(mk(0.1)).toBeCloseTo(24);
    // At/above the clamp: unchanged from before the guard (regression protection).
    expect(mk(0.25)).toBeCloseTo(24);
    expect(mk(1)).toBeCloseTo(6);
    expect(mk(2)).toBeCloseTo(6);
  });

  // -------------------------------------------------------------------------
  // LINK-03: the junction collar (74-UI-SPEC 2.1 / 2.3 / 2.4)
  // -------------------------------------------------------------------------

  /** The ends Graphics of the Nth belt root in the layer, with its ordered op log. */
  const endsAt = (
    layer: { layer: { children: unknown[] } },
    i: number,
  ): {
    circles: Array<{ x: number; y: number; r: number }>;
    ops: Array<{ op: string; x?: number; y?: number; r?: number; width?: number; color?: number }>;
  } => {
    const root = layer.layer.children[i] as { children: unknown[] };
    return root.children[1] as never;
  };

  /** A straight horizontal tile at (x,y). */
  const st = (x: number, y: number): TileViewT =>
    ({ cell_x: x, cell_y: y, kind: { Straight: { axis: 0 } } }) as TileViewT;
  /** A straight VERTICAL tile at (x,y). */
  const sv = (x: number, y: number): TileViewT =>
    ({ cell_x: x, cell_y: y, kind: { Straight: { axis: 1 } } }) as TileViewT;

  const mkBelt = (
    id: number,
    tiles: TileViewT[],
    docks: Array<{ end: string; node: number; port: number }>,
  ): BeltViewT =>
    ({
      id,
      latency: 4 * tiles.length,
      fill: 0,
      items: [],
      tiles,
      docks,
      ticks_per_slot: ONE_BUCKET_PER_TICK_INTERVAL,
    }) as unknown as BeltViewT;

  /**
   * The one join this phase ships, projected from BOTH sides exactly as
   * `render_packet.rs belt_docks` projects it: `up`'s Head (Role::Out) docks to
   * `down`'s Tail (Role::In), and `down` reports the reciprocal Tail dock.
   * The two end tiles (3,0) and (4,0) abut on the edge at x = 4*CELL.
   */
  const joinedPair = (): SceneStateT =>
    ({
      tick: 0,
      nodes: new Map(),
      belts: new Map([
        [21, mkBelt(21, [st(2, 0), st(3, 0)], [{ end: 'Head', node: 22, port: 0 }])],
        [22, mkBelt(22, [st(4, 0), st(5, 0)], [{ end: 'Tail', node: 21, port: 1 }])],
      ]),
      canUndo: false,
      canRedo: false,
    }) as unknown as SceneStateT;

  it('a belt-to-belt join draws ONE collar, on the UPSTREAM HEAD, and the downstream Tail draws nothing', () => {
    // 74-UI-SPEC 2.3, and it is a correctness requirement rather than a preference:
    // the packet projects the dock from both sides and the layer resolves both ends of
    // both belts every frame, so without the ownership rule the seam gets TWO collars a
    // whole cell apart.
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    layer.draw(joinedPair(), 0);

    const up = endsAt(layer, 0);
    const down = endsAt(layer, 1);

    // The grommet is TWO circles and nothing else on the upstream belt.
    expect(up.circles).toHaveLength(2);
    // ...and ZERO on the downstream belt. This is the assertion the ownership rule
    // exists for; on a build without it this reads 2.
    expect(down.circles).toHaveLength(0);
    expect(down.ops).toHaveLength(0);
  });

  it('the collar is PAINTED: a ground-filled disc on the ring inner edge, then a ramp[4] ring', () => {
    // The instruction log, not a call latch. Phase 73 shipped `alertRingsPainted` as a
    // latch on a non-null field, so a build whose ring drew NOTHING passed the whole
    // user-visible claim. Two circles that were never inked would pass a circles-only
    // count; this reads the fill and the stroke that followed each of them.
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    layer.draw(joinedPair(), 0);
    const up = endsAt(layer, 0);

    expect(up.ops.map((o) => o.op)).toEqual(['circle', 'fill', 'circle', 'stroke']);
    // Disc: the ring's INNER edge (7 - 2/2 = 6), filled with the ground ramp step, so
    // an item dot crossing the junction passes over the DARK substrate.
    expect(up.ops[0].r).toBeCloseTo(6);
    expect(up.ops[1].color).toBe(LOCKED_SKIN.palette.ramp[0]);
    // Ring: r 7, stroke 2, ramp[4].
    expect(up.ops[2].r).toBeCloseTo(7);
    expect(up.ops[3].width).toBe(2);
    expect(up.ops[3].color).toBe(LOCKED_SKIN.palette.ramp[4]);
    // NO STEM. The plug stem is a moveTo/lineTo/stroke at width 8; two abutting belt
    // tiles have no gap to bridge, so none of those three ops may appear at all.
    expect(up.ops.some((o) => o.op === 'moveTo' || o.op === 'lineTo')).toBe(false);
    expect(up.ops.some((o) => o.op === 'stroke' && o.width === 8)).toBe(false);
  });

  it('the collar is centred on the SEAM, the shared cell edge, not on either end tile centre', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    layer.draw(joinedPair(), 0);
    const up = endsAt(layer, 0);
    for (const c of up.circles) {
      expect(c.x).toBeCloseTo(4 * CELL);
      expect(c.y).toBeCloseTo(CELL / 2);
      // Stated as what it MUST NOT be, so the case cannot pass on a build that fell
      // back to the shipped end-tile-centre anchor.
      expect(c.x).not.toBeCloseTo(3 * CELL + CELL / 2);
    }
  });

  it('the collar takes the plug cap floor formula verbatim and ceilings at 28 world px', () => {
    // COLLAR_R_MAX = NUB_RING_R / MIN_SCALE = 7 / 0.25. Inherited one for one from
    // CAP_R_MAX rather than minted, so the two marks grow together under a zoom-out.
    const ringAt = (z: number): number => {
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => z, () => 1);
      layer.draw(joinedPair(), 0);
      return endsAt(layer, 0).circles[1].r;
    };
    expect(ringAt(1)).toBeCloseTo(7);
    expect(ringAt(2)).toBeCloseTo(7); // never shrinks above zoom 1
    expect(ringAt(0.5)).toBeCloseTo(14);
    expect(ringAt(0.25)).toBeCloseTo(28);
    expect(ringAt(0.1)).toBeCloseTo(28); // below the clamp: bounded, not ballooning
    expect(Number.isFinite(ringAt(0))).toBe(true); // scale-0 camera-init transient
    expect(ringAt(0)).toBeCloseTo(28);
  });

  it('the disc stays welded to the ring inner edge at low zoom, so the grommet never falls apart', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 0.25, () => 1);
    layer.draw(joinedPair(), 0);
    const [disc, ring] = endsAt(layer, 0).circles;
    expect(ring.r).toBeCloseTo(28);
    expect(disc.r).toBeCloseTo(28 - 1); // ringR - NUB_RING_STROKE / 2
  });

  it('the collar centre is device-pixel snapped with the LIVE quantum, like the plug cap', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1.234);
    layer.draw(joinedPair(), 0);
    const c = endsAt(layer, 0).circles[0];
    expect(c.x).toBeCloseTo(snapToDevicePixel(4 * CELL, 1.234));
    expect(c.y).toBeCloseTo(snapToDevicePixel(CELL / 2, 1.234));
  });

  it('a FAN-IN draws TWO collars at TWO seams, one per upstream Head', () => {
    // D-08 makes a fan-in user-constructible and LINK-13 puts every upstream on the
    // wire. Nothing extra is drawn to say "this is a fan-in": two collars are two
    // joints, which is what the board actually contains.
    const scene = {
      tick: 0,
      nodes: new Map(),
      belts: new Map([
        // A runs EAST, Head (3,0), meeting D's Tail (4,0) on the x = 4*CELL edge.
        [31, mkBelt(31, [st(2, 0), st(3, 0)], [{ end: 'Head', node: 33, port: 0 }])],
        // B runs NORTH, Head (4,1), meeting the SAME Tail from below.
        [32, mkBelt(32, [sv(4, 2), sv(4, 1)], [{ end: 'Head', node: 33, port: 0 }])],
        [
          33,
          mkBelt(33, [st(4, 0), st(5, 0)], [
            { end: 'Tail', node: 31, port: 1 },
            { end: 'Tail', node: 32, port: 1 },
          ]),
        ],
      ]),
      canUndo: false,
      canRedo: false,
    } as unknown as SceneStateT;

    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    layer.draw(scene, 0);

    const a = endsAt(layer, 0);
    const b = endsAt(layer, 1);
    const d = endsAt(layer, 2);
    expect(a.circles).toHaveLength(2);
    expect(b.circles).toHaveLength(2);
    // The downstream draws NOTHING even though it reports TWO Tail docks. Only the
    // fixed dock-resolution added by 74-04 makes both of them visible here at all.
    expect(d.circles).toHaveLength(0);
    // TWO DIFFERENT SEAMS, not one seam drawn twice.
    expect({ x: a.circles[0].x, y: a.circles[0].y }).toEqual({ x: 4 * CELL, y: CELL / 2 });
    expect({ x: b.circles[0].x, y: b.circles[0].y }).toEqual({
      x: 4 * CELL + CELL / 2,
      y: 1 * CELL,
    });
  });

  it('a belt with NO belt-to-belt dock draws exactly what it drew before (the change is narrow)', () => {
    // The machine-docked belt keeps its plug stem and its role cap; the undocked belt
    // keeps its bare terminus. This is what makes the collar an ADDITION rather than a
    // rewrite of the shipped end.
    const docked = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    docked.draw(dockedBeltScene(), 0);
    const d = endsAt(docked, 0);
    expect(d.circles).toHaveLength(1); // one role cap, not a grommet
    expect(d.circles[0].r).toBeCloseTo(6);
    expect(d.ops.map((o) => o.op)).toEqual(['moveTo', 'lineTo', 'stroke', 'circle', 'fill']);
    expect(d.ops[2].width).toBe(8); // the stem is still stroked at width 8

    const bare = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    bare.draw(straightBeltScene(), 0);
    expect(endsAt(bare, 0).ops).toHaveLength(0);
  });

  it('a ONE-TILE belt docked at both ends draws its two caps and no stem, so its tread shows (UI-04)', () => {
    // Phase 89 UI review UI-04: both stems ran from the one tile's centre, covering the whole
    // centreline the tread marches along, so a one-tile belt showed no direction at rest. A
    // multi-tile belt keeps its stems (the case above).
    const scene = dockedBeltScene();
    const belt = scene.belts.get(1) as unknown as { tiles: unknown[]; docks: unknown[] };
    belt.tiles = [straight(2, 5, 1)];
    belt.docks = [
      { end: 'Head', node: 10, port: 0 },
      { end: 'Tail', node: 11, port: 0 },
    ];
    (scene.nodes as Map<number, unknown>).set(11, {
      id: 11,
      kind: 2,
      cell_x: 2,
      cell_y: 6,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [{ index: 0, cell_x: 2, cell_y: 6, side: 0 /* N */, role: 1 /* Out */ }],
    });
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    layer.draw(scene, 0);
    const d = endsAt(layer, 0);
    expect(d.circles, 'both role caps are drawn').toHaveLength(2);
    expect(d.ops.some((o) => o.op === 'moveTo' || o.op === 'lineTo'), 'no stem covers the one tile').toBe(false);
  });

  it('a FAN-IN Tail docked to two machines draws a plug for each (walk finding, review pass 2)', () => {
    // Since LINK-13 a Tail holds one dock per upstream, but only the first was drawn, so the
    // second machine's Out looked unconnected while its panel read connected.
    const scene = dockedBeltScene();
    const belt = scene.belts.get(1) as unknown as { docks: unknown[] };
    belt.docks = [
      { end: 'Tail', node: 10, port: 0 },
      { end: 'Tail', node: 11, port: 0 },
    ];
    (scene.nodes as Map<number, unknown>).set(11, {
      id: 11,
      kind: 0,
      cell_x: 1,
      cell_y: 5,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [{ index: 0, cell_x: 1, cell_y: 5, side: 1 /* E */, role: 1 /* Out */ }],
    });
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    layer.draw(scene, 0);
    const d = endsAt(layer, 0);
    expect(d.circles, 'one role cap per upstream machine').toHaveLength(2);
    expect(d.ops.filter((o) => o.op === 'stroke'), 'one stem per upstream machine').toHaveLength(2);
  });

  it('anchorKey FOLDS the discriminant, so a seam key names itself as one', () => {
    // The geoKey gates the whole `rebuildEnds`, so an anchor whose KIND changed without
    // its point moving must re-key - the file's own stale-nub lesson with a new cause.
    //
    // WHAT THIS CASE HAD TO BE REWRITTEN INTO, and the first draft is worth recording
    // because it is this project's signature defect. The first version asserted only
    // that a port anchor and a seam anchor at ONE point produce different keys, and it
    // SURVIVED the mutation that deletes the `${a.kind}` term outright - because the
    // role term separates them anyway (`128,16,1` against `128,16,-`). It asserted a
    // true thing that the code under test was not responsible for. The containment
    // assertions below are the ones that die when the discriminant stops being folded.
    const port = { kind: 'port', x: 128, y: 16, role: 1 } as const;
    const seam = { kind: 'belt-seam', x: 128, y: 16 } as const;
    expect(anchorKey(seam)).toContain('belt-seam');
    expect(anchorKey(port)).toContain('port');
    expect(anchorKey(port)).not.toBe(anchorKey(seam));
    // Both keys still name the point and the role, so a MOVED or RE-ROLED anchor of
    // either kind still re-keys - the fold ADDS a term, it does not replace one.
    expect(anchorKey(seam)).not.toBe(anchorKey({ kind: 'belt-seam', x: 129, y: 16 }));
    expect(anchorKey(port)).not.toBe(anchorKey({ kind: 'port', x: 128, y: 16, role: 0 }));
    expect(anchorKey(null)).toBe('none');
  });

  it('a dock naming a belt the client has never seen draws nothing and does not throw', () => {
    // T-74-24: the seam resolver RETURNS a value for a dock it cannot resolve rather
    // than throwing, so nothing this phase adds can kill the Pixi ticker.
    const scene = {
      tick: 0,
      nodes: new Map(),
      belts: new Map([
        [41, mkBelt(41, [st(2, 0), st(3, 0)], [{ end: 'Head', node: 9999, port: 0 }])],
      ]),
      canUndo: false,
      canRedo: false,
    } as unknown as SceneStateT;
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    expect(() => layer.draw(scene, 0)).not.toThrow();
    expect(endsAt(layer, 0).ops).toHaveLength(0);
  });

  it('an undocked end draws NO cap (neutral terminus)', () => {
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    layer.draw(straightBeltScene(), 0); // undocked (docks: [])
    expect(endsGraphics(layer).circles).toHaveLength(0);
  });

  // (d2) WR-02: at zoom >= 1 the geoKey capBucket is pinned (min(1,scale)*20 = 20), so
  // a quantum change (zoom-in past 1x) never re-runs rebuildEnds via geoKey. The cap
  // center must STILL re-snap to the live device-pixel grid on a quantum change, or it
  // shimmers under a zoom gesture. Ground-truth the re-snapped center against a fresh
  // layer drawn directly at the new quantum (whose first draw always snaps).
  it('the dominant cap re-snaps to the device grid on a quantum change at zoom >= 1 (WR-02)', () => {
    let q = 1.234; // fractional -> anchor*q is non-integer -> the snap actually moves it
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 2 /* zoom pinned */, () => q);

    q = 1.234;
    layer.draw(dockedBeltScene(), 0);
    const stale = { ...endsGraphics(layer).circles[0] };

    // Change ONLY the quantum (zoom stays 2, so geoKey is unchanged) and redraw.
    q = 2.468;
    layer.draw(dockedBeltScene(), 1);
    const resnapped = endsGraphics(layer).circles[0];

    // Ground truth: a fresh layer at zoom 2 / q=2.468 snaps the cap on its first draw.
    const fresh = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 2, () => 2.468);
    fresh.draw(dockedBeltScene(), 0);
    const expected = endsGraphics(fresh).circles[0];

    expect(resnapped.x).toBeCloseTo(expected.x);
    expect(resnapped.y).toBeCloseTo(expected.y);
    // And it actually moved off the stale q=1.234 snap (the pre-fix shimmer state).
    expect(resnapped.x !== stale.x || resnapped.y !== stale.y).toBe(true);
  });

  // (e) FLOW-05 single source: the belt-layer preview (drawBeltTilePath) strokes a
  // corner with the geometry-owned ELBOW_R, so preview == committed by construction.
  it('drawBeltTilePath rounds corners with the shared geometry ELBOW_R (single source)', () => {
    const g = new Graphics();
    // A corner-bearing tile path: straight -> corner -> straight forces one arcTo.
    drawBeltTilePath(g as never, [straight(0, 0, 0), corner(1, 0, 1, 2), straight(1, 1, 1)], {
      width: 4,
      color: 0x000000,
    });
    expect((g as unknown as { lastArcRadius: number }).lastArcRadius).toBe(ELBOW_R);
  });

  // (f) Plan 74.1-08: THE PREVIEW STROKE BENDS AT AN END CORNER. Since 74.1-07 the host
  // ships a Corner at a docked end that turns, and the draw preview now predicts it, so
  // tiles[0] or tiles[n-1] can be a Corner. The stroke used to start and end at a tile
  // CENTRE and skip a corner at either end, so an end corner drew as a straight stub.
  // Each case asserts the whole ordered instruction log, arcs included.
  const pathOps = (tiles: TileViewT[]) => {
    const g = new Graphics();
    drawBeltTilePath(g as never, tiles, { width: 4, color: 0x000000 });
    return (g as unknown as { ops: Array<Record<string, unknown>> }).ops
      .filter((o) => o.op !== 'stroke')
      .map((o) => ({ ...o }));
  };

  it('drawBeltTilePath: a Corner at tiles[0] starts on its entry edge and arcs through its centre', () => {
    // Corner{from:E,to:N} at (8,6), then Straight{Y} at (8,5): flow enters (8,6) heading
    // E, so through its WEST edge (256, 208), and bends north toward (8,5)'s centre.
    expect(pathOps([corner(8, 6, 1, 0), straight(8, 5, 1)])).toEqual([
      { op: 'moveTo', x: 256, y: 208 },
      { op: 'arcTo', x: 272, y: 208, x2: 272, y2: 176, r: ELBOW_R },
      { op: 'lineTo', x: 272, y: 176 },
    ]);
  });

  it('drawBeltTilePath: a Corner at tiles[n-1] arcs through its centre and ends on its exit edge', () => {
    // Straight{Y} at (8,8), then Corner{from:N,to:E} at (8,7): the last point is (8,7)'s
    // EAST edge midpoint (288, 240).
    expect(pathOps([straight(8, 8, 1), corner(8, 7, 0, 1)])).toEqual([
      { op: 'moveTo', x: 272, y: 272 },
      { op: 'arcTo', x: 272, y: 240, x2: 288, y2: 240, r: ELBOW_R },
      { op: 'lineTo', x: 288, y: 240 },
    ]);
  });

  it('drawBeltTilePath: an interior corner draws exactly as before (Straight, Corner, Straight)', () => {
    expect(pathOps([straight(0, 0, 0), corner(1, 0, 1, 2), straight(1, 1, 1)])).toEqual([
      { op: 'moveTo', x: 16, y: 16 },
      { op: 'arcTo', x: 48, y: 16, x2: 48, y2: 48, r: ELBOW_R },
      { op: 'lineTo', x: 48, y: 48 },
    ]);
  });

  it('drawBeltTilePath: a one-tile Corner draws its own quarter arc, entry edge to exit edge', () => {
    // Corner{from:E,to:S} at (0,0): in through the W edge (0,16), out through S (16,32).
    expect(pathOps([corner(0, 0, 1, 2)])).toEqual([
      { op: 'moveTo', x: 0, y: 16 },
      { op: 'arcTo', x: 16, y: 16, x2: 16, y2: 32, r: ELBOW_R },
      { op: 'lineTo', x: 16, y: 32 },
    ]);
  });

  // Plan 89-03 (BELT-10, D-15): the zero-turn corner a one-tile belt ships draws a STRAIGHT
  // segment along its flow, entry edge through centre to exit edge, with no `arcTo` over three
  // collinear points. This is also the preview's and the held picture's stroke.
  it('drawBeltTilePath: a one-tile zero-turn corner is a straight stroke along its flow, no arc', () => {
    // Corner{from:W,to:W} at (5,5): in through the E edge (192,176), out through the W (160,176).
    expect(pathOps([corner(5, 5, 3, 3)])).toEqual([
      { op: 'moveTo', x: 192, y: 176 },
      { op: 'lineTo', x: 176, y: 176 },
      { op: 'lineTo', x: 160, y: 176 },
    ]);
    // Corner{from:N,to:N} at (5,5): in through the S edge (176,192), out through the N (176,160).
    expect(pathOps([corner(5, 5, 0, 0)])).toEqual([
      { op: 'moveTo', x: 176, y: 192 },
      { op: 'lineTo', x: 176, y: 176 },
      { op: 'lineTo', x: 176, y: 160 },
    ]);
  });

  // Review IN-B-02: the zero-turn arm for a tile AFTER the first is defensive (route never makes a
  // multi-tile belt with a zero-turn head today), and this case is what keeps it from being dead
  // code that looks load-bearing: a two-tile run East whose head ships Corner{from:E,to:E} is a
  // straight stroke on to the head's E edge, no arc over three collinear points. Removing the arm
  // routes the head through the turning-corner `arcTo` and reddens this case.
  it('drawBeltTilePath: a zero-turn corner head after a straight is a straight stroke, no arc', () => {
    const ops = pathOps([straight(4, 5, 0), corner(5, 5, 1, 1)]);
    expect(ops.some((o) => o.op === 'arcTo'), `no arc (${JSON.stringify(ops)})`).toBe(false);
    expect(ops.slice(-2), 'through the head centre, out its E edge').toEqual([
      { op: 'lineTo', x: 176, y: 176 },
      { op: 'lineTo', x: 192, y: 176 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// RED MEANS FAULTED (CHROME-18, phase 92 D-06, UI-SPEC 3.1 and 3.4).
//
// A belt docked at a machine's fault exit used to end in a solid cap in the fault accent, so a
// resting demo board showed a permanent red dot at the Factory's fault belt into Rejects while
// nothing was faulted. The cap now takes the fault nub's own neutral (`ramp[3]`) and keeps its
// role by SHAPE: a ring at r = capR stroked capR / 3 around a core disc of r = capR / 3. In and
// Out caps stay solid discs. Read from the ordered op log of the mocked Graphics (which records
// each circle and the fill or stroke that inked it), colours compared with the skin's own ramp
// and accents, never a hex.
// ---------------------------------------------------------------------------
const { nubAnchor: nubAnchorOf } = await import('../../protocol/ports.ts');
describe('belts - a docked fault exit is neutral (CHROME-18)', () => {
  /**
   * A Factory-shaped node with an In (N), an Out (E) and a fault exit (S), and a Sink. Belt 1
   * runs from the Factory's fault exit (Tail, FAULT_PORT) to the Sink's In (Head); belt 2 leaves
   * the Factory's Out (Tail, the first Out routing key). So the three ends that dock read one
   * fault cap, one In cap and one Out cap.
   */
  const faultDockScene = (): SceneStateT => {
    const factory = {
      id: 30,
      kind: 2,
      cell_x: 4,
      cell_y: 4,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [
        { index: 0, cell_x: 4, cell_y: 4, side: 0 /* N */, role: 0 /* In */ },
        { index: 1, cell_x: 4, cell_y: 4, side: 1 /* E */, role: 1 /* Out */ },
        { index: 2, cell_x: 4, cell_y: 4, side: 2 /* S */, role: 2 /* Fault */ },
      ],
    };
    const sink = {
      id: 31,
      kind: 1,
      cell_x: 4,
      cell_y: 8,
      state: 0,
      w: 1,
      h: 1,
      rot: 0,
      ports: [{ index: 0, cell_x: 4, cell_y: 8, side: 0 /* N */, role: 0 /* In */ }],
    };
    const faultBelt = {
      id: 1,
      latency: 4 * 3,
      fill: 0,
      items: [],
      tiles: [straight(4, 5, 1), straight(4, 6, 1), straight(4, 7, 1)],
      docks: [
        { end: 'Tail', node: 30, port: 65535 },
        { end: 'Head', node: 31, port: 0 },
      ],
      ticks_per_slot: ONE_BUCKET_PER_TICK_INTERVAL,
    } as unknown as BeltViewT;
    const outBelt = {
      id: 2,
      latency: 4 * 2,
      fill: 0,
      items: [],
      tiles: [straight(5, 4, 0), straight(6, 4, 0)],
      docks: [{ end: 'Tail', node: 30, port: 0 }],
      ticks_per_slot: ONE_BUCKET_PER_TICK_INTERVAL,
    } as unknown as BeltViewT;
    return {
      tick: 0,
      nodes: new Map([
        [30, factory],
        [31, sink],
      ]),
      belts: new Map([
        [1, faultBelt],
        [2, outBelt],
      ]),
      canUndo: false,
      canRedo: false,
    } as unknown as SceneStateT;
  };

  type Op = { op: string; x?: number; y?: number; r?: number; width?: number; color?: number };
  /** Each circle of an ends Graphics with the fill or stroke op that inked it. */
  const inkedCircles = (g: { ops: Op[] }): Array<{ x: number; y: number; r: number; action: string; color?: number; width?: number }> => {
    const out: Array<{ x: number; y: number; r: number; action: string; color?: number; width?: number }> = [];
    g.ops.forEach((o, i) => {
      if (o.op !== 'circle') return;
      const ink = g.ops[i + 1];
      out.push({ x: o.x ?? NaN, y: o.y ?? NaN, r: o.r ?? NaN, action: ink?.op ?? 'none', color: ink?.color, width: ink?.width });
    });
    return out;
  };
  const endsOf = (layer: { layer: { children: unknown[] } }, i: number): { ops: Op[] } => {
    const root = layer.layer.children[i] as { children: unknown[] };
    return root.children[1] as { ops: Op[] };
  };

  it('a docked fault exit ends in a neutral ring cap', () => {
    const { ramp, accents } = LOCKED_SKIN.palette;
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    layer.draw(faultDockScene(), 0);
    const faultEnds = inkedCircles(endsOf(layer, 0));
    const outEnds = inkedCircles(endsOf(layer, 1));
    const all = [...faultEnds, ...outEnds];
    const capR = 6; // CAP_R at zoom 1
    // The fault cap is the one drawn at the Tail's nub anchor: the Factory's S nub, by the
    // shared `nubAnchor` math the layer resolves it with.
    const { x: faultX, y: faultY } = nubAnchorOf(4, 4, 2);
    const atFault = faultEnds.filter((c) => Math.abs(c.x - faultX) < 1 && Math.abs(c.y - faultY) < 1);
    expect(
      atFault.map((c) => ({ r: c.r, action: c.action, color: c.color, width: c.width })),
      'RED-FIRST CHROME-18-cap-unit: the fault cap is a ramp[3] ring at capR stroked capR/3 around a ramp[3] core of capR/3, never the fault accent',
    ).toEqual([
      { r: capR, action: 'stroke', color: ramp[3], width: capR / 3 },
      { r: capR / 3, action: 'fill', color: ramp[3], width: undefined },
    ]);
    // In and Out caps stay one solid disc each, In ramp[3] and Out ramp[4].
    const inCaps = faultEnds.filter((c) => !(Math.abs(c.x - faultX) < 1 && Math.abs(c.y - faultY) < 1));
    expect(inCaps.map((c) => ({ r: c.r, action: c.action, color: c.color })), 'the In cap is one solid ramp[3] disc').toEqual([
      { r: capR, action: 'fill', color: ramp[ramp.length - 2] },
    ]);
    expect(outEnds.map((c) => ({ r: c.r, action: c.action, color: c.color })), 'the Out cap is one solid ramp[4] disc').toEqual([
      { r: capR, action: 'fill', color: ramp[ramp.length - 1] },
    ]);
    // Nothing the belt layer plots is the fault accent.
    expect(all.filter((c) => c.color === accents.fault), 'no circle on the belt layer is the fault accent').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE LAYER'S LIFETIME AND ITS TWO POPULATION EXTREMES (plan 61-02).
//
// Three contracts that had no executable statement before this plan, added because
// the `ui-consideration-probe` found the canvas belt reached only through two
// `partial` rows and never asked its empty / populated questions at all.
// ---------------------------------------------------------------------------
describe('belts - cache lifetime, empty board, many belts (plan 61-02)', () => {
  /** `n` one-tile straight belts, each on its own row so no two share geometry. */
  function manyBeltScene(n: number): SceneStateT {
    const belts = new Map<number, BeltViewT>();
    for (let i = 0; i < n; i++) {
      belts.set(i + 1, {
        id: i + 1,
        // The host's own invariant, `SLOTS_PER_TILE * tiles` - corrected in plan 62-04.
        latency: 4 * 2,
        fill: 0,
        items: [],
        tiles: [straight(2, i, 0), straight(3, i, 0)],
        docks: [],
        ticks_per_slot: ONE_BUCKET_PER_TICK_INTERVAL,
      } as unknown as BeltViewT);
    }
    return {
      tick: 0,
      nodes: new Map(),
      belts,
      canUndo: false,
      canRedo: false,
    } as unknown as SceneStateT;
  }

  /** An otherwise ordinary scene carrying no belts at all - the first-run board. */
  const emptyBoardScene = (): SceneStateT =>
    ({
      tick: 0,
      nodes: new Map(),
      belts: new Map(),
      canUndo: false,
      canRedo: false,
    }) as unknown as SceneStateT;

  // Behaviour 3 - the ORDER, not the end state. Both orderings leave the same tidy
  // end state (no roots, no cache entries), so an end-state assertion would pass on
  // the broken order too: contexts freed FIRST leaves every live tile bound to freed
  // geometry for exactly one frame, which is the class of defect that shows up as a
  // null GPU resource and not as a failing test.
  it('setPainter drops every belt root BEFORE either cache is destroyed', () => {
    const cache = fakeCache();
    const contexts = new BeltContextCache();
    const railContexts = new BeltContextCache();
    const layer = createBeltLayer(
      LOCKED_SKIN,
      cache,
      () => 1,
      () => 1,
      SHIPPED_PAINTER,
      contexts,
      railContexts,
    );
    layer.draw(tileScene([straight(2, 5, 0), corner(3, 5, 1, 2)]), 0);
    expect(layer.layer.children).toHaveLength(1);

    const order: string[] = [];
    const rootsAtFree: number[] = [];
    const root = layer.layer.children[0] as { destroy: (o?: unknown) => void };
    const realRootDestroy = root.destroy.bind(root);
    root.destroy = (o?: unknown): void => {
      order.push('root.destroy');
      realRootDestroy(o);
    };
    for (const [name, target] of [
      ['contexts.destroyAll', contexts],
      ['cache.destroyAll', cache],
      ['railContexts.destroyAll', railContexts],
    ] as const) {
      const real = target.destroyAll.bind(target);
      target.destroyAll = (): void => {
        order.push(name);
        // The load-bearing observation: by the time a free runs, the layer must
        // already hold no roots, so nothing can still be pointing at what is freed.
        rootsAtFree.push(layer.layer.children.length);
        real();
      };
    }

    layer.setPainter(SHIPPED_PAINTER);

    expect(order[0]).toBe('root.destroy');
    expect(order).toContain('contexts.destroyAll');
    expect(order).toContain('cache.destroyAll');
    expect(order).toContain('railContexts.destroyAll');
    expect(order.indexOf('root.destroy')).toBeLessThan(order.indexOf('contexts.destroyAll'));
    expect(order.indexOf('root.destroy')).toBeLessThan(order.indexOf('cache.destroyAll'));
    expect(order.indexOf('root.destroy')).toBeLessThan(order.indexOf('railContexts.destroyAll'));
    // Asserted at the moment of each free, not afterwards.
    expect(rootsAtFree).toEqual([0, 0, 0]);
    // ... and the end state is still tidy, so the order assertion is an ADDITION to
    // the old guarantee rather than a replacement for it.
    expect(layer.layer.children).toHaveLength(0);
    expect(contexts.live).toBe(0);
    // BELT-05 (plan 61-09): the RAIL cache is torn down by the SAME one path. A
    // bucket-count change routes through `setPainter` and the painter
    // id is a term in every rail key, so a swap that freed only the tread contexts
    // would strand five rail entries keyed to a painter that no longer exists.
    expect(railContexts.live).toBe(0);
    expect(railContexts.size).toBe(0);
    // NON-VACUITY: the rail cache was actually populated before the swap, so the zeros
    // above are a teardown and not an empty cache that was never filled.
    expect(railContexts.created).toBeGreaterThan(0);
  });

  // Behaviour 4 - stated POSITIVELY so a later reader does not fill the silence with a
  // placeholder. An empty board is the shipped first-run state after the welcome card,
  // and it must draw no belt chrome of any kind.
  it('a board with ZERO belts draws nothing and populates no geometry cache', () => {
    const cache = fakeCache();
    const contexts = new BeltContextCache();
    const layer = createBeltLayer(
      LOCKED_SKIN,
      cache,
      () => 1,
      () => 1,
      SHIPPED_PAINTER,
      contexts,
    );

    for (let f = 0; f < 8; f++) layer.draw(emptyBoardScene(), f);

    expect(layer.layer.children, 'an empty board adds no belt child').toHaveLength(0);
    expect(contexts.created, 'an empty board plots no belt geometry').toBe(0);
    expect(contexts.size).toBe(0);
    expect(cache.created, 'an empty board bakes no belt texture').toBe(0);

    // Non-vacuity: the SAME layer populates the moment a belt exists, so the zeros
    // above are a property of the empty board and not of a layer that never draws.
    layer.draw(straightBeltScene(), 0);
    expect(layer.layer.children).toHaveLength(1);
    expect(contexts.created).toBeGreaterThan(0);
  });

  // IN-05 (phase-61 review): the zero-tiles TRIPWIRE must stay a warning.
  //
  // A belt still present in `scene.belts` but with `tiles.length === 0` used to hit the
  // warn-once branch and `continue`, leaving its existing tile children mounted and
  // bound to rail contexts. On the next quantum change `release` destroys that
  // generation, and those orphaned children would then be pointing at freed geometry -
  // a GPU-level fault at the exact moment the tripwire is trying to report a
  // regression legibly. The branch is documented as impossible post-P20 DrawBelt mint,
  // which is WHY this matters: it only ever runs when something else has already gone
  // wrong, and it must not compound it.
  it('a belt that loses all its tiles loses its geometry too, and still warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const contexts = new BeltContextCache();
      const layer = createBeltLayer(
        LOCKED_SKIN,
        fakeCache(),
        () => 1,
        () => 1,
        SHIPPED_PAINTER,
        contexts,
      );
      layer.draw(tileScene([straight(2, 5, 0), corner(3, 5, 1, 2)]), 0);
      expect(layer.layer.children, 'the populated belt mounted no root').toHaveLength(1);
      const root = layer.layer.children[0] as { destroyed: boolean; children: unknown[] };
      const tiles = root.children[0] as { destroyed: boolean; children: unknown[] };
      expect(tiles.children.length, 'the populated belt drew no tiles').toBeGreaterThan(0);

      // The SAME belt id, now with no tiles at all.
      layer.draw(tileScene([]), 1);
      expect(warn, 'the tripwire did not fire').toHaveBeenCalledTimes(1);
      // Destroyed AND unmounted - not merely one of the two, since either alone leaves a
      // live reference into the released rail generation.
      expect(root.destroyed, 'the sprite root survived').toBe(true);
      expect(layer.layer.children, 'the sprite root is still mounted').toHaveLength(0);
      // The tile CONTAINER goes with the root, so nothing under it is reachable from the
      // layer any more. The stub's `destroy({children: true})` recurses one level with a
      // BARE `destroy()` (its comment says the non-recursive form is modelled on purpose,
      // to keep "a removed tile takes its rail child with it" assertable elsewhere), so
      // one level is the honest limit of what this suite can measure here - not a claim
      // that the leaf rail Graphics survives.
      expect(tiles.destroyed, 'the tile container survived its root').toBe(true);

      // Warn-once is unchanged: a second zero-tile frame is silent, and the layer stays
      // empty rather than re-minting anything for a belt with nothing to draw.
      layer.draw(tileScene([]), 2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(layer.layer.children).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  // Behaviour 5 - the populated-state contract. The assertion is on the CACHE ENTRY
  // COUNT and not on the child count, because the whole promise is that ONE shared
  // context serves many tiles across many belts.
  it('many belts at once share ONE context per key: the count is independent of belt count', () => {
    const measure = (n: number): { contexts: number; children: number } => {
      const contexts = new BeltContextCache();
      const layer = createBeltLayer(
        LOCKED_SKIN,
        fakeCache(),
        () => 1,
        () => 1,
        SHIPPED_PAINTER,
        contexts,
      );
      layer.draw(manyBeltScene(n), 0);
      return { contexts: contexts.created, children: layer.layer.children.length };
    };

    const few = measure(2);
    const many = measure(40);

    // Non-vacuity: the belt count really did grow 20x.
    expect(few.children).toBe(2);
    expect(many.children).toBe(40);

    // ... and the tessellation cost did not move at all.
    expect(few.contexts).toBe(1);
    expect(many.contexts).toBe(few.contexts);
  });

  // -------------------------------------------------------------------------
  // BELT-06 (plan 61-06): a LIVE step-count change.
  //
  // The Graphics panel that offered this change, and the render handle's
  // `belts.setPainter(beltPainterForBuckets(k))` pass-through it called, were deleted in
  // plan 91-03 (CHROME-03, D-04); the default count is unchanged. These two cases stay
  // as renderer invariants of `setPainter` itself: the teardown
  // ORDER survives a swap between two DIFFERENT painters (the order case above swaps
  // the shipped painter for itself, which cannot see a bucket-count-dependent bug),
  // and the cache lands on the right cardinality at each of the three legal counts.
  // -------------------------------------------------------------------------

  it('a step-count change destroys the old contexts BEFORE repopulating, at every count', () => {
    for (const buckets of BELT_MARCH_BUCKET_COUNTS) {
      const contexts = new BeltContextCache();
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1, SHIPPED_PAINTER, contexts);
      layer.draw(tileScene([straight(2, 5, 0), corner(3, 5, 1, 2)]), 0);
      const beforeCreated = contexts.created;
      expect(beforeCreated).toBeGreaterThan(0);

      // Observe WHEN, not the end state: a repopulate that raced the free would leave
      // exactly the same tidy numbers behind.
      const order: string[] = [];
      const createdAtFree: number[] = [];
      const realFree = contexts.destroyAll.bind(contexts);
      contexts.destroyAll = (): void => {
        order.push('destroyAll');
        createdAtFree.push(contexts.created);
        realFree();
      };

      layer.setPainter(beltPainterForBuckets(buckets));
      // Nothing is plotted by the swap itself - the next draw re-plots lazily.
      expect(order).toEqual(['destroyAll']);
      expect(createdAtFree).toEqual([beforeCreated]);
      expect(contexts.live, `no leak at K=${buckets}`).toBe(0);
      expect(contexts.size).toBe(0);

      // ... and the repopulate happens strictly AFTER, on the next draw.
      layer.draw(tileScene([straight(2, 5, 0), corner(3, 5, 1, 2)]), 0);
      expect(order).toEqual(['destroyAll']);
      expect(contexts.size).toBeGreaterThan(0);
    }
  });

  it('lands on the right slot cardinality at EACH of the three step counts', () => {
    // Swept across a FULL march cycle at each count, at both LOD levels, so the count
    // is the saturated one rather than whatever one frame happened to touch.
    const saturate = (buckets: number): number => {
      const contexts = new BeltContextCache();
      let z = 1;
      const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => z, () => 1, SHIPPED_PAINTER, contexts);
      layer.setPainter(beltPainterForBuckets(buckets));
      const cw = tileScene([corner(2, 0, 1, 2)]);
      const ccw = tileScene([corner(2, 0, 1, 0)]);
      const run = tileScene([straight(2, 5, 0), straight(3, 5, 0)]);
      for (let t = 0; t <= 3 * buckets; t++) {
        layer.draw(run, 0, t);
        layer.draw(cw, 0, t);
        layer.draw(ccw, 0, t);
      }
      z = 0.25; // below the cut: the three phase-INDEPENDENT LOD assets
      for (let t = 0; t <= 3 * buckets; t++) {
        layer.draw(run, 0, t);
        layer.draw(cw, 0, t);
        layer.draw(ccw, 0, t);
      }
      return contexts.created;
    };

    // MEASURED, AND IT IS NOT WHAT THE PLAN PREDICTED - so the measurement is written
    // down rather than the prediction. `3K + 3` (39 / 51 / 75) is the cache BOUND: the
    // number of slots the painter HAS. The number the live march actually PLOTS is 39 at
    // every legal count, because the per-tick advance is 1.333333px = one twelfth of the
    // 16px dash period regardless of K, so the march visits exactly 12 distinct buckets
    // whatever the lattice is divided into. At K = 16 those 12 are 12 OF 16 (a 1.000px
    // lattice against a 1.333333px advance - the judder), and at K = 24 they are the 12
    // EVEN buckets of 24 (exactly two per tick), which is the "double the cache for a
    // look identical to 12" line stated as a runtime measurement rather than as prose.
    //
    // THIS IS THE ARITHMETIC THE PANEL'S CAPTION IS BOUND BY. "Higher values ... look the
    // same today" is not a hedge: the cache lands on the same 39 plots at all three.
    //
    // AN EQUALITY, NEVER AN AT-MOST, on both halves. A `<=` would pass on a cache half of
    // whose slots had silently collapsed - the BELT-06 defect itself.
    expect(BELT_MARCH_BUCKET_COUNTS).toEqual([12, 16, 24]);
    expect(saturate(12)).toBe(39);
    expect(saturate(16)).toBe(39);
    expect(saturate(24)).toBe(39);
    // The BOUND does move with the knob, stated as three literals beside the `3K + 3`
    // derivation that explains them - never as the expression the assertion evaluates,
    // because a derivation-only assertion agrees with itself at any K.
    expect(BELT_MARCH_BUCKET_COUNTS.map((k) => 3 * beltPainterForBuckets(k).phases + 3)).toEqual([
      39, 51, 75,
    ]);
    // So the two upper counts ship with slots the march never selects. Asserted rather
    // than remarked, because it is the whole reason 12 is the default.
    expect(saturate(16)).toBeLessThan(51);
    expect(saturate(24)).toBeLessThan(75);
  });

  it('refuses a step count off the gated lattice rather than building it', () => {
    // The renderer-side half of the closed set (the chrome half went with the Graphics
    // panel in plan 91-03): any count that ever reaches it from client state is
    // untrusted, and a single allowlist checked in one place is a fence with one gate.
    for (const rogue of [0, 4, 13, 32, -12, 12.5]) {
      expect(() => beltPainterForBuckets(rogue)).toThrow(/gated bucket counts/);
    }
    for (const legal of BELT_MARCH_BUCKET_COUNTS) {
      expect(beltPainterForBuckets(legal).phases).toBe(legal);
    }
    // The default is the SHIPPED object by identity, not an equal-looking rebuild, so
    // no committed digest label moves and the shipped path stays one object.
    expect(beltPainterForBuckets(SHIPPED_PAINTER.phases)).toBe(SHIPPED_PAINTER);
    // Every non-default painter carries a DISTINCT id, because the id is a cache-key
    // term: two painters sharing one would serve each other's geometry at the wrong K.
    const ids = BELT_MARCH_BUCKET_COUNTS.map((k) => beltPainterForBuckets(k).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// THE RAIL FAMILY'S LIFETIME (BELT-05 - plan 61-09)
// ---------------------------------------------------------------------------
//
// The rails left the four scale-free tread contexts and became their own family, whose
// geometry is a function of the LIVE DEVICE QUANTUM. That makes the quantum a cache
// LIFETIME term - and a lifetime is a claim about WHEN things happen, which no
// end-state assertion can see. Both blocks below assert timing, not tidiness.
describe('belts - the rail cache is quantum-LIVED, not quantum-KEYED (plan 61-09)', () => {
  /** A layer over an injectable rail cache, with the quantum on a movable closure. */
  const layerAt = (
    q: { v: number },
    railContexts: InstanceType<typeof BeltContextCache>,
    contexts = new BeltContextCache(),
  ): ReturnType<typeof createBeltLayer> =>
    createBeltLayer(
      LOCKED_SKIN,
      fakeCache(),
      () => 1,
      () => q.v,
      SHIPPED_PAINTER,
      contexts,
      railContexts,
    );

  it('holds exactly ONE straight rail entry, at one quantum and across a quantum change', () => {
    // **THE UNBOUNDEDNESS THE DESIGN REFUSED, ASSERTED AS A NUMBER.** Keying the
    // quantum in would have made the key space CONTINUOUS: a zoom gesture visiting
    // sixty distinct quanta in a second would either leave sixty live entries or flush
    // and re-plot all 39 tread contexts per frame. The cache is REPLACED instead, so
    // its size is 1 forever on a straight run - during the gesture, not only after it.
    const q = { v: 1 };
    const rails = new BeltContextCache();
    const layer = layerAt(q, rails);
    const scene = tileScene([straight(2, 5, 0), straight(3, 5, 0), straight(4, 5, 0)]);

    for (let f = 0; f < 20; f++) layer.draw(scene, f);
    expect(rails.size, 'many draws at one quantum plot one rail asset').toBe(1);
    expect(rails.created).toBe(1);

    // A whole simulated zoom gesture, one fractional quantum per frame.
    const gesture = [0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.25, 1.5, 1.77, 2];
    for (const [i, v] of gesture.entries()) {
      q.v = v;
      layer.draw(scene, 20 + i);
      expect(rails.size, `rail cache size at q=${v}`).toBe(1);
      expect(rails.live, `live rail contexts at q=${v}`).toBe(1);
    }
    // It really did re-plot at each new quantum - so `size === 1` is a replacement, not
    // a stale entry being served at every zoom.
    expect(rails.created).toBe(1 + gesture.length);
    expect(rails.destroyed).toBe(gesture.length);
  });

  it('plots the new rail generation and rebinds EVERY tile BEFORE freeing the old', () => {
    // **THE ORDER, AT THE MOMENT OF THE FREE.** Both orderings leave the same tidy end
    // state - one live context, every tile bound to it - so an end-state assertion
    // passes on the broken one. Freeing first leaves every tile pointing at freed
    // geometry for exactly one frame, which surfaces as a null GPU resource and not as
    // a thrown error. This is the same discipline the `setPainter` case applies.
    const q = { v: 1 };
    const rails = new BeltContextCache();
    const layer = layerAt(q, rails);
    const scene = tileScene([straight(2, 5, 0), straight(3, 5, 0), straight(4, 5, 0)]);
    layer.draw(scene, 0);

    const generationOne = tileSprites(layer).map(railBoundOf);
    expect(new Set(generationOne).size, 'one rail asset serves the run').toBe(1);

    const observed: Array<{
      freed: unknown[];
      boundAtFree: unknown[];
      sizeAtFree: number;
    }> = [];
    const realRelease = rails.release.bind(rails);
    rails.release = (entries: readonly { destroy(): void }[]): void => {
      observed.push({
        freed: [...entries],
        // Read the LIVE scene graph at the instant of the free.
        boundAtFree: tileSprites(layer).map(railBoundOf),
        sizeAtFree: rails.size,
      });
      realRelease(entries);
    };

    q.v = 0.85;
    layer.draw(scene, 1);

    expect(observed, 'a quantum change frees exactly one generation').toHaveLength(1);
    const [seen] = observed;
    // 1. The NEW generation was already plotted when the old one was freed...
    expect(seen.sizeAtFree, 'the new rail generation is plotted before the free').toBe(1);
    // 2. ... EVERY holder had already been rebound onto it...
    expect(new Set(seen.boundAtFree).size).toBe(1);
    for (const bound of seen.boundAtFree) {
      expect(seen.freed, 'a tile still held a context that was being freed').not.toContain(
        bound,
      );
    }
    // 3. ... and what was freed really is the previous generation, so the case is not
    //    passing by freeing nothing at all.
    expect(seen.freed).toHaveLength(1);
    expect(seen.freed[0]).toBe(generationOne[0]);
    expect(seen.boundAtFree[0]).not.toBe(generationOne[0]);
  });

  it('takes the rail child with the tile when a geometry change rebuilds the run', () => {
    // `rebuildTiles` destroys each removed tile; a bare `destroy()` would ORPHAN the
    // rail child - a display object with no parent, no owner, and no counter watching
    // it. The mocked `Container.destroy` models the `{ children: true }` contract, so
    // this is a real observation rather than a restatement of the call site.
    const q = { v: 1 };
    const layer = layerAt(q, new BeltContextCache());
    layer.draw(tileScene([straight(2, 5, 0), straight(3, 5, 0)]), 0);
    const before = tileSprites(layer).map(
      (t) => (t as unknown as { children: { destroyed: boolean }[] }).children[1],
    );
    expect(before).toHaveLength(2);
    for (const rail of before) expect(rail.destroyed).toBe(false);

    // A real geometry change: a different tile run on the same belt id.
    layer.draw(tileScene([straight(2, 5, 0), straight(3, 5, 0), straight(4, 5, 0)]), 1);
    for (const rail of before) expect(rail.destroyed, 'an orphaned rail child').toBe(true);
    expect(tileSprites(layer)).toHaveLength(3);
  });

  it('keys the rail family by THREE segments, with no quantum term', () => {
    // The rail keys go through the SAME `beltContextKey` join the tread keys do. If a
    // future edit keyed the rail cache by scale, the cache would multiply silently and
    // nothing else in the suite would notice - so the key shape is asserted here, on
    // the same contract `beltContextCache.test.ts` states for the tread families.
    for (const [kind, chirality] of [
      ['belt-rail', 'none'],
      ['belt-corner-rail', 'cw'],
      ['belt-corner-rail', 'ccw'],
      ['belt-corner-rail-tick', 'cw'],
      ['belt-corner-rail-tick', 'ccw'],
    ] as const) {
      const key = beltContextKey(kind, chirality, 0);
      expect(key.split('|'), `${kind}|${chirality} segment count`).toHaveLength(3);
      expect(key, `${kind}|${chirality} must carry no quantum term`).not.toMatch(/q[=0-9.]/);
    }
  });
});

// ---------------------------------------------------------------------------
// D-05 quadrant-after-rotation hardening (RESEARCH Pattern 4 Tier B): compose the
// REAL corner geometry with the layer's quarter-turn math and assert the tread
// centroid lands in the tile quadrant adjoined by the corner's two port edges - for
// ALL 8 (from,to) pairs. This is the tier that was structurally blind to F2a: the
// pixel gate screenshots the ASSET, but rotation is LAYER state, so an asset-only
// probe can never see a layer rotation bug. The negative control proves the assertion
// has teeth (the F2 lesson: assertions without teeth).
//
// RE-POINTED ONTO VECTOR GEOMETRY BY PLAN 61-07, WHICH IS A STRENGTHENING AND NOT A
// PORT. It read raster corner-bake bytes, masked them down to the ~2px band around
// the ELBOW_R centreline (the rail arcs carry the SAME colour as the tread under the
// locked single-ink scheme, so an unmasked centroid was dragged toward the tile centre
// by the outer rail), rotated the matrix by a hand-written quarter-turn transpose and
// reduced that to an ink centroid. `cornerCommands` emits the TREAD ROLE ONLY - the
// rail arcs left for the device-quantum family in plan 61-09 - so the masking step and
// its 2px tolerance are GONE rather than reimplemented, and the centroid is now over
// the exact points the shipped corner draws instead of over the pixels a deleted bake
// used to produce.
//
// Everything here is test-local and pure: no GPU, no harness, no sprite - just flat
// point lists rotated about the tile centre and reduced to a mean position. The
// centroid-in-quadrant claim is deliberately SHAPE-agnostic, so it survives a change of
// dash treatment exactly as it survived the raster-to-vector move.
// ---------------------------------------------------------------------------

describe('belts - quadrant-after-rotation: geometry x rotation composed (D-05)', () => {
  /**
   * Rotate a tile-local point by k quarter turns in Pixi's POSITIVE rotation direction
   * (clockwise in screen coordinates, y-down). `cornerCommands` emits points with the
   * ORIGIN AT THE TILE CENTRE, so one 90-degree CW step is exactly (x, y) -> (-y, x)
   * with no half-cell offset to get wrong. The convention is pinned by the native cw
   * sanity case below BEFORE the 8-pair sweep trusts it.
   *
   * This replaced a 20-line matrix transpose whose own index arithmetic
   * (`dest(x,y) = src(y, N-1-x)`) had to be pinned separately - the centre-origin point
   * list removes that whole class of off-by-one.
   */
  function rotCW(x: number, y: number, k: number): { x: number; y: number } {
    let px = x;
    let py = y;
    for (let step = 0, n = ((k % 4) + 4) % 4; step < n; step++) {
      const nx = -py;
      const ny = px;
      px = nx;
      py = ny;
    }
    return { x: px, y: py };
  }

  /**
   * The mean position of every TREAD point the corner emits at the resting bucket,
   * rotated by `turns` quarter turns.
   *
   * The role filter is belt-and-braces: `cornerCommands` is tread-only since plan
   * 61-09, and asserting that here rather than assuming it means a future emitter that
   * put the rails back could not silently blunt the discriminator the way the raster
   * rails did.
   */
  function treadCentroid(
    chirality: 'cw' | 'ccw',
    turns: number,
  ): { x: number; y: number; count: number } {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (const cmd of cornerCommands(0, BELT_MARCH_BUCKETS, chirality)) {
      if (cmd.role !== 'tread') continue;
      for (let i = 0; i < cmd.points.length; i += 2) {
        const p = rotCW(cmd.points[i], cmd.points[i + 1], turns);
        sx += p.x;
        sy += p.y;
        count++;
      }
    }
    return { x: sx / count, y: sy / count, count };
  }

  /**
   * Does a centroid satisfy the half-plane of one tile EDGE (headings N=0, E=1, S=2,
   * W=3)? The points are tile-centre-relative, so each half-plane is a sign test about
   * 0: N: y < 0, E: x >= 0, S: y >= 0, W: x < 0.
   */
  function inEdgeHalf(edge: number, cx: number, cy: number): boolean {
    if (edge === 0) return cy < 0; // N
    if (edge === 1) return cx >= 0; // E
    if (edge === 2) return cy >= 0; // S
    return cx < 0; // W
  }

  /**
   * A corner's two PORT edges: flow entering heading `from` crosses the OPPOSITE
   * side (in-edge = (from + 2) % 4); flow exiting heading `to` crosses the `to`
   * side (out-edge = to). The two edges are always perpendicular (90-degree turn),
   * so their half-plane intersection is a proper tile quadrant.
   */
  const portEdges = (from: number, to: number): [number, number] => [(from + 2) % 4, to];

  // Canonical chirality partition (same table as the FLOW-05 suite above).
  const cwPairs: Array<[number, number]> = [
    [1, 2], // E -> S
    [3, 0], // W -> N
    [0, 1], // N -> E
    [2, 3], // S -> W
  ];
  const ccwPairs: Array<[number, number]> = [
    [1, 0], // E -> N
    [3, 2], // W -> S
    [0, 3], // N -> W
    [2, 1], // S -> E
  ];

  // (a) Sanity pin: the native cw case from=S(2), to=W(3) needs ZERO quarter turns
  // and its UNROTATED tread centroid sits in the {N,W} quadrant (the emitter's arc
  // centre is the tile's top-left corner). This pins the rotCW handedness BEFORE the
  // sweep trusts it: if this fails, the rotation direction is inverted - flip rotCW,
  // never the expected quadrants.
  it('native cw (from=S, to=W): zero turns, unrotated tread centroid in the {N,W} quadrant', () => {
    expect(cornerQuarterTurns(2, 3)).toBe(0);
    const c = treadCentroid('cw', 0);
    expect(c.count).toBeGreaterThan(0);
    expect(c.x).toBeLessThan(0); // W half-plane
    expect(c.y).toBeLessThan(0); // N half-plane
  });

  // (b) The F2a-catching sweep: for ALL 8 pairs, rotating the correct chirality's
  // geometry by cornerQuarterTurns quarter turns lands the tread centroid in the
  // quadrant adjoined by the corner's two port edges. Resting bucket only - the
  // quadrant claim is bucket-independent.
  it('all 8 (from,to) pairs: rotated tread centroid lands in the port-edge quadrant', () => {
    for (const [from, to] of [...cwPairs, ...ccwPairs]) {
      const chirality = cornerChiralityOf(from, to);
      const c = treadCentroid(chirality, cornerQuarterTurns(from, to));
      const [inEdge, outEdge] = portEdges(from, to);
      expect(c.count, `from=${from} to=${to}`).toBeGreaterThan(0);
      expect(
        inEdgeHalf(inEdge, c.x, c.y),
        `from=${from} to=${to} (${chirality}): centroid (${c.x.toFixed(1)},${c.y.toFixed(1)}) in the in-edge ${inEdge} half-plane`,
      ).toBe(true);
      expect(
        inEdgeHalf(outEdge, c.x, c.y),
        `from=${from} to=${to} (${chirality}): centroid (${c.x.toFixed(1)},${c.y.toFixed(1)}) in the out-edge ${outEdge} half-plane`,
      ).toBe(true);
    }
  });

  // (c) Negative control - the teeth: rotating each ccw pair by the RETIRED
  // uniform formula ((to+1)%4 quarter turns, spelled inline - imported from
  // nowhere) places the centroid in the diagonally OPPOSITE quadrant, violating
  // BOTH port half-planes. This locks out the F2a class forever and proves the
  // sweep above is non-vacuous.
  it('locks out the F2a class: the retired uniform formula misplaces every ccw pair', () => {
    for (const [from, to] of ccwPairs) {
      const retiredTurns = (to + 1) % 4; // the pre-fix uniform cw-only formula
      const c = treadCentroid('ccw', retiredTurns);
      const [inEdge, outEdge] = portEdges(from, to);
      expect(c.count, `from=${from} to=${to}`).toBeGreaterThan(0);
      // 180 degrees off puts the arc diagonally opposite: BOTH half-planes violated.
      expect(
        inEdgeHalf(inEdge, c.x, c.y),
        `retired formula from=${from} to=${to}: centroid must MISS the in-edge half-plane`,
      ).toBe(false);
      expect(
        inEdgeHalf(outEdge, c.x, c.y),
        `retired formula from=${from} to=${to}: centroid must MISS the out-edge half-plane`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// VEC-04: the belt TREAD stays batched as the belt gets longer.
//
// Same promise as the item-layer block in `items.test.ts`, on the other high-count
// surface. WHAT CARRIES THE PROMISE CHANGED IN PLAN 61-02 and the block is restated
// rather than deleted, because the promise itself did not change.
//
// Before VEC-01 the tread was Sprites bound to cached textures and the regression to
// catch was a per-tile `Graphics`. After VEC-01 a straight tile IS a `Graphics` - so
// the old assertion would now fail on the shipped design, and re-blessing it as-is
// would have quietly removed the guard. The thing that actually breaks a batch in
// Pixi v8 is TESSELLATED GEOMETRY, which lives on the `GraphicsContext` and not on the
// `Graphics`: N drawings of one shared context are one tessellation and stay under the
// 400-vertex `isBatchable` cliff (`svgAssets.ts`, "why the memo is load-bearing").
//
// So the restated guard is in two halves, and BOTH are needed:
//   1. the CONTEXT count does not move with belt length (the batching property), and
//   2. the PER-FRAME path constructs nothing at all (the churn property, which is what
//      the construction counter was always really measuring).
// A refactor that plotted a fresh context per tile would redden half 1; one that
// rebuilt tiles every frame would redden half 2.
// ---------------------------------------------------------------------------
describe('belt tread stays batched as the belt gets longer (VEC-04)', () => {
  const graphicsBuilds = (): number =>
    (globalThis as unknown as { __graphicsBuilds: { n: number } }).__graphicsBuilds.n;

  /** `n` straight tiles in one horizontal run starting at (2, 5). */
  const run = (n: number): TileViewT[] =>
    Array.from({ length: n }, (_, i) => straight(2 + i, 5, 0));

  const layerWith = (
    contexts: InstanceType<typeof BeltContextCache>,
    rails: InstanceType<typeof BeltContextCache> = new BeltContextCache(),
  ): ReturnType<typeof createBeltLayer> =>
    createBeltLayer(
      LOCKED_SKIN,
      fakeCache(),
      () => 1,
      () => 1,
      SHIPPED_PAINTER,
      contexts,
      rails,
    );

  it('plots the SAME number of contexts for a 3-tile and a 12-tile belt', () => {
    const shortCtx = new BeltContextCache();
    const short = layerWith(shortCtx);
    short.draw(tileScene(run(3)), 0);

    const longCtx = new BeltContextCache();
    const long = layerWith(longCtx);
    long.draw(tileScene(run(12)), 0);

    // The tile count really did differ 4x - without this the assertion below could be
    // comparing two identical scenes and proving nothing.
    expect(tileSprites(short)).toHaveLength(3);
    expect(tileSprites(long)).toHaveLength(12);

    // ... and the tessellation cost did not move with it. A fixed cost, not a per-tile
    // one: exactly ONE context serves the whole run at either length.
    expect(shortCtx.created).toBe(1);
    expect(longCtx.created).toBe(shortCtx.created);

    // Driving many more frames over the longer belt allocates no further display
    // objects: the per-frame work is the H7 live `Graphics.context =` assignment on
    // objects that already exist.
    const beforeFrames = graphicsBuilds();
    for (let f = 1; f <= 12; f++) long.draw(tileScene(run(12)), f);
    expect(graphicsBuilds()).toBe(beforeFrames);
  });

  it('every straight tread tile is a Graphics bound to the ONE shared cached context', () => {
    const contexts = new BeltContextCache();
    const rails = new BeltContextCache();
    const layer = layerWith(contexts, rails);
    layer.draw(tileScene(run(12)), 0);

    const tiles = tileSprites(layer);
    expect(tiles).toHaveLength(12);
    // Plan 61-02 asserted the tread tile's display-object TYPE rather than duck-typing
    // it, and plan 61-09 KEEPS that discipline one level down. A tile is now a
    // `Container` holding two `Graphics` - tread then rail - because Pixi 8 warns
    // `addChild: Only Containers will be allowed to add children` on a view object, so
    // hanging the rail off the tread `Graphics` would ship on a deprecated path.
    for (const t of tiles) {
      const parts = (t as unknown as { children: unknown[] }).children;
      expect(parts, 'a tile carries exactly a tread and a rail').toHaveLength(2);
      for (const p of parts) expect(p).toBeInstanceOf(Graphics);
      for (const p of parts) expect(p).not.toBeInstanceOf(Sprite);
    }
    // All twelve share ONE bucket context out of the cache - one tessellation, one
    // batch. This is the assertion the old `.texture` identity check became.
    expect(new Set(tileBinds(layer)).size).toBe(1);
    // ... and the same is true of the rail half, which is the whole reason it may be a
    // second display object at all: twelve tiles, ONE rail tessellation.
    expect(new Set(tiles.map(railBoundOf)).size).toBe(1);
    // And each cache plotted a single context for the whole run, not one per tile.
    expect(contexts.created).toBe(1);
    expect(rails.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE PER-BELT PHASE ACCUMULATOR (BELT-02, SAFE-02 - plan 61-04)
// ---------------------------------------------------------------------------
describe('belts - dash phase accumulates PER BELT from the tail (BELT-02)', () => {
  // The two flow lengths, TRANSCRIBED rather than imported. A straight is a whole cell;
  // a corner is the quarter arc on the CENTRELINE radius, which is emphatically NOT a
  // whole tile - accumulating 32 through a bend is exactly how the shipped belt earned
  // its 2px jump at every corner.
  const STRAIGHT_FLOW = 32;
  const CORNER_FLOW = 25.132741228718345; // R * pi / 2 at R = 16

  it('sums upstream tile flow lengths from the tail, index-aligned with the tiles', () => {
    const run = [straight(2, 5, 0), corner(3, 5, 1, 2), straight(3, 6, 1), corner(3, 7, 2, 1)];
    const offsets = tailOffsets(run);
    expect(offsets).toHaveLength(run.length);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeCloseTo(STRAIGHT_FLOW, 12);
    expect(offsets[2]).toBeCloseTo(STRAIGHT_FLOW + CORNER_FLOW, 12);
    expect(offsets[3]).toBeCloseTo(2 * STRAIGHT_FLOW + CORNER_FLOW, 12);
    // The two literals themselves, so a corner that silently became a whole tile long
    // reddens here rather than agreeing with a derivation.
    expect(offsets[1] - offsets[0]).toBe(32);
    expect(offsets[2] - offsets[1]).toBeCloseTo(25.132741, 6);
    // Index-alignment with the LAYER's tile children, asserted through the layer rather
    // than assumed: the swap loop reads `offsets[i]` against `children[i]`.
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    layer.draw(tileScene(run), 0, 0);
    expect(tileSprites(layer)).toHaveLength(offsets.length);
  });

  it('RESTARTS at 0 at each belt tail: two belts at a dock do not share an accumulator', () => {
    // The decision, gated (`61-CONTEXT.md` section B): phase is continuous end to end
    // WITHIN one belt including through every corner, and a seam may appear where two
    // belts meet at a dock - which is accepted because a dock is already a visual break
    // (there is a machine standing there). Accumulating ACROSS docks would couple
    // independently cached belts and re-phase everything downstream of any upstream
    // topology edit.
    const upstream = [straight(2, 5, 0), corner(3, 5, 1, 2)];
    const downstream = [straight(3, 6, 1), straight(3, 7, 1)];
    expect(tailOffsets(upstream)[0]).toBe(0);
    expect(tailOffsets(downstream)[0]).toBe(0);
    // ... and the downstream belt does NOT inherit the upstream belt's accumulated
    // total, which is the whole content of "restarts".
    const joined = tailOffsets([...upstream, ...downstream]);
    expect(joined[2]).not.toBe(tailOffsets(downstream)[0]);
    expect(joined[2]).toBeCloseTo(STRAIGHT_FLOW + CORNER_FLOW, 12);
  });

  it('holds a 0px seam at every straight-to-straight boundary, EXACTLY', () => {
    // A straight's flow length is 32, a whole multiple of the 16px dash period, so its
    // residue is 0 and it lands on a bucket EXACTLY. This is an IDENTITY over the
    // record, not a sampled measurement - a sampled seam is only ever as good as its
    // sampling, while this is exact.
    expect(STRAIGHT_FLOW % BELT_DASH_PERIOD).toBe(0);
    const K = SHIPPED_PAINTER.phases;
    const run = [straight(2, 5, 0), straight(3, 5, 0), straight(4, 5, 0), straight(5, 5, 0)];
    const offsets = tailOffsets(run);
    for (const o of offsets) expect(o % BELT_DASH_PERIOD).toBe(0);
    // ... and read off the SELECTOR, so the identity and the shipped code corroborate:
    // every tile of a straight run draws the identical bucket at every clock.
    for (const clock of [0, 1, 7, 18, 1000]) {
      const buckets = offsets.map((o) => bucketOf(clock, o, K, LATTICE_PX_PER_TICK));
      expect(new Set(buckets).size, `clock ${clock}`).toBe(1);
    }
  });

  it('holds the corner-exit seam at +0.200593px, and pins all three numbers (BELT-02)', () => {
    // THE ONE PLACE THE QUANTIZATION SHOWS, and it is smaller than the raw 8/K bound
    // suggests. A corner contributes 25.132741, so every tile downstream of it shares
    // the residue `25.132741 mod 16` = 9.132741 - the error is CONSTANT along the whole
    // downstream run and appears as ONE sub-pixel offset at the corner exit, once per
    // corner. Against the shipped belt's 2px jump at every corner that is an order of
    // magnitude better, and it is honest.
    const K = SHIPPED_PAINTER.phases;
    const run = [straight(2, 5, 0), corner(3, 5, 1, 2), straight(3, 6, 1)];
    const exitOffset = tailOffsets(run)[2];
    const residue = exitOffset % BELT_DASH_PERIOD;
    const bucketPx = bucketSizePx(K);
    const nearest = Math.round(residue / bucketPx) * bucketPx;
    // The three numbers `61-UI-SPEC` A6 states, pinned - WITH ONE RECORD CORRECTED
    // AGAINST MEASUREMENT. The residue and the nearest bucket reproduce exactly. The
    // ERROR does not: `61-RESEARCH.md`'s table and this plan's own behaviour text both
    // state **+0.200593**, and `61-UI-SPEC` A6 states **+0.2007** at 4dp, but
    // `9.333333333333332 - 9.132741228718345` is **+0.200592104614987**. The upstream
    // figures are a transcription slip in the 6th decimal (and a 4dp rounding of it);
    // measurement wins, exactly as plan 61-03 corrected two records against measurement
    // rather than reproducing them. Nothing about the CONCLUSION moves - it is still an
    // order of magnitude better than the shipped 2px jump and still well inside the
    // 0.666667px bound - so this is a record correction, not a finding.
    expect(residue).toBeCloseTo(9.132741, 6);
    expect(nearest).toBeCloseTo(9.333333, 6);
    expect(nearest - residue).toBeCloseTo(0.200592104614987, 12);
    expect(nearest - residue).toBeCloseTo(0.2006, 4);
    // ... inside the worst-case bound, which is half the dash period over K.
    expect(Math.abs(nearest - residue)).toBeLessThanOrEqual(BELT_DASH_PERIOD / 2 / K);
    expect(worstCaseQuantizationPx(K)).toBeCloseTo(0.666667, 6);
    // AND the same error read off the SHIPPED SELECTOR rather than off this local
    // arithmetic, so a `bucketOf` that drifted from the spec's lattice reddens here.
    // The sign flips because the offset is SUBTRACTED from the phase (the dash marches
    // WITH the flow), so the drawn phase is the mirror of the residue about the period.
    const drawn = bucketOf(0, exitOffset, K, LATTICE_PX_PER_TICK) * bucketPx;
    const ideal = ((((0 - exitOffset) % BELT_DASH_PERIOD) + BELT_DASH_PERIOD) % BELT_DASH_PERIOD);
    expect(Math.abs(drawn - ideal)).toBeCloseTo(0.200592104614987, 12);
  });

  it('does NOT improve that seam error when the bucket count is raised', () => {
    // STATED SO NOBODY REACHES FOR K AS A SEAM REMEDY. K = 24's lattice CONTAINS
    // K = 12's, and 9.333333 is a point on both, so a corner lands at the identical
    // error at both. The knob buys smoothness; it does not buy this.
    const run = [straight(2, 5, 0), corner(3, 5, 1, 2), straight(3, 6, 1)];
    const exitOffset = tailOffsets(run)[2];
    const residue = exitOffset % BELT_DASH_PERIOD;
    const errorAt = (k: number): number => {
      const bucketPx = bucketSizePx(k);
      return Math.round(residue / bucketPx) * bucketPx - residue;
    };
    expect(errorAt(24)).toBe(errorAt(12)); // EQUAL, not merely "no worse"
    expect(errorAt(24)).toBeCloseTo(0.200592104614987, 12);
    // ... and it holds through the shipped selector too, at both counts.
    expect(bucketOf(0, exitOffset, 24, LATTICE_PX_PER_TICK) * bucketSizePx(24)).toBeCloseTo(
      bucketOf(0, exitOffset, 12, LATTICE_PX_PER_TICK) * bucketSizePx(12),
      12,
    );
    // The knob DOES move what it is for - the quantization bound halves - so this case
    // is not quietly asserting that K changes nothing at all.
    expect(worstCaseQuantizationPx(24)).toBeCloseTo(worstCaseQuantizationPx(12) / 2, 12);
  });

  it('FREEZES under reduced motion at the pinned clock 18 - bucket 6 of 12 (SAFE-02)', () => {
    // THE LITERAL 18, NEVER `SIM_TICKS_PER_FRAME * 3`, AND THE REASON IS THE COUPLING.
    // `reducedMotion.ts` derives `REDUCED_MOTION_FRAME` FROM `SIM_TICKS_PER_FRAME` -
    // the very constant this phase is decoupling the belt from. Writing the pin as that
    // derivation would let the test and the thing it checks move together and assert
    // nothing: change the animation lattice and both sides slide, silently. The literal
    // is what makes this a real pin on the frozen belt's actual phase.
    //
    // The arithmetic it pins: `18 ticks * 1.333333 px/tick` = 24px of phase,
    // `24 mod 16` = 8px, which at the 1.333333px lattice is bucket 6 of 12. A stable
    // MID-DASH offset on an EXACT bucket - not zero, not a gap boundary - so a frozen
    // belt still reads as a dashed belt rather than as a blank lane.
    const PINNED_CLOCK = 18;
    const K = SHIPPED_PAINTER.phases;
    expect(bucketOf(PINNED_CLOCK, 0, K, LATTICE_PX_PER_TICK)).toBe(6);
    expect(K).toBe(12);
    // The freeze itself, through the LAYER: successive draws at the pinned clock bind
    // the identical context object. It is free rather than implemented, because the
    // march is a pure function of a clock the pin holds constant.
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    const scene = straightBeltScene();
    layer.draw(scene, 0, PINNED_CLOCK);
    const frozen = tileBinds(layer);
    for (const frame of [1, 2, 3, 17, 240]) {
      layer.draw(scene, frame, PINNED_CLOCK);
      expect(tileBinds(layer), `frame ${frame} at the pinned clock`).toEqual(frozen);
    }
    // NON-VACUITY: the belt is not frozen because it never moves. Release the pin by
    // one tick and the bound context changes.
    layer.draw(scene, 0, PINNED_CLOCK + 1);
    expect(tileBinds(layer)[0]).not.toBe(frozen[0]);
    // Corroboration that the pin really is 18 in the shipped chrome - asserted as an
    // EQUALITY against the literal, which is the one direction that cannot slide.
    expect(REDUCED_MOTION_FRAME).toBe(18);
  });

  it("marches each belt at ITS OWN wire interval, and floors a forged zero (SLOT-03)", () => {
    // THE RENDER-SIDE HALF OF THE TRACER, driven through the LAYER rather than through
    // `bucketOf` directly, because the thing under test is the layer's derivation of
    // px-per-tick from the wire - not the selector, which its own suite already pins.
    //
    // The claim: a belt at interval `n` marches at 1/n the rate, so it draws at clock
    // `n * t` exactly what an identity belt draws at clock `t`. That equivalence is the
    // sharpest available statement, because it holds for EVERY t rather than pinning one
    // bucket, and it cannot be satisfied by a layer that ignores the field.
    // The base is the PRE-CHANGE IDENTITY interval explicitly, not the file's default
    // test lattice: the equivalence below is stated against interval 1 and reads as
    // nonsense against anything else.
    const identity = straightBeltScene(1);
    const slowed = straightBeltScene(1);
    const SLOW = 3; // a TEST interval, not a proposed pace (D-19)
    for (const b of slowed.belts.values()) (b as BeltViewT).ticks_per_slot = SLOW;

    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    for (const t of [1, 2, 5, 11, 37]) {
      layer.draw(identity, 0, t);
      const fast = tileBinds(layer);
      layer.draw(slowed, 0, t * SLOW);
      expect(tileBinds(layer), `interval ${SLOW} at clock ${t * SLOW}`).toEqual(fast);
    }

    // NON-VACUITY, in the one direction that matters: the two are NOT simply equal at
    // every clock. Without this, a layer that ignored `ticks_per_slot` entirely would
    // pass every assertion above whenever the two clocks happened to agree.
    layer.draw(identity, 0, 1);
    const atOne = tileBinds(layer);
    layer.draw(slowed, 0, 1);
    expect(tileBinds(layer)).not.toEqual(atOne);

    // RENDER HEALTH, not defensive decoration. `ticks_per_slot` is a plain integer on an
    // untrusted wire; the core's non-zero invariant does not travel. A zero would make
    // the phase non-finite, `Math.round(NaN)` is `NaN`, and a NaN bucket index misses the
    // asset cache and throws inside `Application.render` - which, running as a Ticker
    // listener, stops the render loop PERMANENTLY on a partial frame
    // (the 2026-08-11 machines-missing-on-WebKitGTK failure). No model-level oracle
    // can see that, so it is asserted here.
    for (const forged of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const broken = straightBeltScene(1);
      for (const b of broken.belts.values()) (b as BeltViewT).ticks_per_slot = forged;
      expect(() => layer.draw(broken, 0, 7), `forged interval ${forged}`).not.toThrow();
      for (const bound of tileBinds(layer)) {
        expect(bound, `a forged ${forged} still binds a real asset`).toBeDefined();
      }
    }
  });

  it('runs the accumulator on the geoKey rebuild ONLY, never in the per-frame loop', () => {
    // PURE TOPOLOGY BELONGS ON THE GEOKEY-GATED RECORD. A tile's tail offset cannot move
    // without its belt's tile run moving, and the tile run is a geoKey term - so
    // re-deriving it per frame would burn an unchanging array sixty times a second per
    // belt on a completely static board, which is the Pitfall-1 class of defect the
    // frame-free geoKey exists to prevent.
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache());
    const scene = straightBeltScene();
    layer.draw(scene, 0, 0); // first draw: geoKey changes, so the accumulator runs
    const afterFirst = flowLengthCalls.n;
    expect(afterFirst).toBeGreaterThanOrEqual(3); // one call per tile - non-vacuity

    for (let t = 1; t <= 40; t++) layer.draw(scene, 0, t); // 40 frames, geometry static
    expect(flowLengthCalls.n, 'the accumulator ran on a frame with an unchanged geoKey').toBe(
      afterFirst,
    );

    // ... and it DOES run again on a real geometry change, so the case above is a
    // statement about gating rather than about the accumulator being dead.
    layer.draw(tileScene([straight(2, 5, 0), straight(3, 5, 0)]), 0, 41);
    expect(flowLengthCalls.n).toBeGreaterThan(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// WR-05 (plan 74.1-20): the frames between the release and the Dock echo
// ---------------------------------------------------------------------------
//
// The host ships a docked end's corner only once the Dock has folded, and the gesture
// layer can send that Dock only after the DrawBelt has echoed. So a real release
// produces, in order: a frame with no belt yet (the release), a frame with the belt
// echoed carrying route()'s Straight at the seam and NO dock, a frame on which the Dock
// is sent (scene unchanged), and a frame with the dock and the packet's derived corner.
// Nothing graded those frames before this plan, and the drawn seam was the T.
//
// Each frame is drawn through the REAL layer and graded on what it drew at the seam
// tile, two ways: the tile run the geometry was built from (`drawnTilesOf`), and the
// scene graph itself (the seam tile's tread is bound to the SAME corner asset a lone
// reference corner of that turn binds in the same draw, and carries its quarter turns).
// The registry is fed exactly as the gesture layer feeds it at release.
const { recordPendingSeams, clearPendingSeams, pendingSeamsRecord } = await import(
  '../pendingSeams.ts'
);

describe('belts - the seam between release and the Dock echo (74.1-20, WR-05)', () => {
  /** The follow-up TTL the gesture layer passes (`ECHO_TTL_TICKS`). */
  const TTL = 120;
  /** The release tick. */
  const T0 = 100;

  const mk = (
    id: number,
    tiles: TileViewT[],
    docks: Array<{ end: 'Head' | 'Tail'; node: number; port: number }> = [],
  ): BeltViewT =>
    ({
      id,
      latency: 4 * tiles.length,
      fill: 0,
      items: [],
      tiles,
      docks,
      ticks_per_slot: ONE_BUCKET_PER_TICK_INTERVAL,
    }) as unknown as BeltViewT;

  const frameScene = (
    tick: number,
    belts: BeltViewT[],
    nodes: Array<[number, unknown]> = [],
  ): SceneStateT =>
    ({
      tick,
      nodes: new Map(nodes),
      belts: new Map(belts.map((b) => [b.id, b])),
      canUndo: false,
      canRedo: false,
    }) as unknown as SceneStateT;

  /** The tile objects of the belt root at `i` (roots are created in first-draw order). */
  const tilesOfRoot = (layer: { layer: { children: unknown[] } }, i: number): unknown[] => {
    const root = layer.layer.children[i] as { children: unknown[] };
    return (root.children[0] as { children: unknown[] }).children;
  };

  interface Shape {
    name: string;
    /** The new belt's cells, tail first, as route() types them (all Straight{Y}). */
    stored: TileViewT[];
    /** The seam kind the preview showed and the host derives once docked. */
    seam: { from: number; to: number };
    /** The partner the Tail docks to, already on the board. */
    partner: { belts: BeltViewT[]; nodes: Array<[number, unknown]> };
    /** The Tail dock the Dock echo carries. */
    tailDock: { end: 'Tail'; node: number; port: number };
    /** The partner as it reads after the Dock echo (a belt partner reports the link). */
    partnerAfter: BeltViewT[];
  }

  const NEW_ID = 9;
  /** A lone reference corner far from everything: the same turn, offset 0, same draw. */
  const REF_ID = 99;

  // S1: belt A runs east with its Head at (7,6); the new belt is pressed on A's Head
  // doorstep (8,6) and turned north at once. Fed east, leaving north: Corner{E,N}.
  const S1: Shape = {
    name: 'S1 (a belt Head pressed, then north at once)',
    stored: [straight(8, 6, 1), straight(8, 5, 1), straight(8, 4, 1)],
    seam: { from: 1, to: 0 },
    partner: { belts: [mk(5, [straight(6, 6, 0), straight(7, 6, 0)])], nodes: [] },
    tailDock: { end: 'Tail', node: 5, port: 1 },
    partnerAfter: [mk(5, [straight(6, 6, 0), straight(7, 6, 0)], [{ end: 'Head', node: NEW_ID, port: 0 }])],
  };
  // S2: a Source at (2,5) whose Out faces E, doorstep (3,5); the new belt turns south
  // at once. Fed east, leaving south: Corner{E,S}. (A Straight heading south carries the
  // same quarter turns as this corner, which is why the asset is graded as well.)
  const srcNode = {
    id: 1,
    kind: 0,
    cell_x: 2,
    cell_y: 5,
    state: 0,
    w: 1,
    h: 1,
    rot: 0,
    ports: [{ index: 0, cell_x: 2, cell_y: 5, side: 1 /* E */, role: 1 /* Out */, medium: 0 }],
  };
  const S2: Shape = {
    name: 'S2 (a Source Out facing E, then south at once)',
    stored: [straight(3, 5, 1), straight(3, 6, 1), straight(3, 7, 1)],
    seam: { from: 1, to: 2 },
    partner: { belts: [], nodes: [[1, srcNode]] },
    tailDock: { end: 'Tail', node: 1, port: 0 },
    partnerAfter: [],
  };

  /**
   * Draw one frame and read the seam: the drawn kind at tiles[0] of the new belt, and
   * whether its scene-graph tile is the reference corner (same asset, same quarter turns).
   */
  const drawAndRead = (
    layer: ReturnType<typeof createBeltLayer>,
    scene: SceneStateT,
    seam: { from: number; to: number },
  ): { kind: unknown; cornerDrawn: boolean } => {
    layer.draw(scene, 0);
    const drawn = layer.drawnTilesOf(NEW_ID);
    if (drawn === null) throw new Error('the new belt has no sprite on this frame');
    // Roots: partner belts first (if any), then the reference, then the new belt.
    const roots = layer.layer.children.length;
    const seamTile = tilesOfRoot(layer, roots - 1)[0] as { rotation: number };
    const refTile = tilesOfRoot(layer, roots - 2)[0] as { rotation: number };
    const cornerDrawn =
      boundOf(seamTile) === boundOf(refTile) &&
      Math.abs(seamTile.rotation - (cornerQuarterTurns(seam.from, seam.to) * Math.PI) / 2) < 1e-9;
    return { kind: drawn[0].kind, cornerDrawn };
  };

  const setup = (s: Shape) => {
    clearPendingSeams();
    const layer = createBeltLayer(LOCKED_SKIN, fakeCache(), () => 1, () => 1);
    const ref = mk(REF_ID, [corner(30, 30, s.seam.from, s.seam.to)]);
    const predicted = [corner(s.stored[0].cell_x, s.stored[0].cell_y, s.seam.from, s.seam.to), ...s.stored.slice(1)];
    // FRAME 0, THE RELEASE: the gesture records what the preview showed, the DrawBelt
    // goes out, the scene holds no new belt yet.
    recordPendingSeams({
      cells: s.stored.map((t) => [t.cell_x, t.cell_y] as [number, number]),
      tiles: predicted,
      expect: { Tail: true, Head: false },
      tick: T0,
      ttlTicks: TTL,
    });
    layer.draw(frameScene(T0, [...s.partner.belts, ref], s.partner.nodes), 0);
    expect(layer.drawnTilesOf(NEW_ID), 'NON-VACUITY: no new belt on the release frame').toBeNull();
    return { layer, ref, predicted };
  };

  for (const s of [S1, S2]) {
    it(`${s.name}: the seam is drawn as the corner on EVERY frame from the DrawBelt echo to the Dock echo`, () => {
      const { layer, ref, predicted } = setup(s);
      const C = { Corner: { from: s.seam.from, to: s.seam.to } };

      // FRAME 1, THE DRAWBELT ECHO: route()'s Straight at the seam, no dock.
      const echoed = mk(NEW_ID, s.stored.map((t) => ({ ...t })));
      const f1 = drawAndRead(layer, frameScene(T0 + 1, [...s.partner.belts, ref, echoed], s.partner.nodes), s.seam);
      expect(f1.kind, 'frame 1 (DrawBelt echo, no dock): the drawn seam').toEqual(C);
      expect(f1.cornerDrawn, 'frame 1: the scene graph holds the corner asset at the corner turn').toBe(true);
      // The decoded scene is NOT altered: the packet still says Straight.
      expect(echoed.tiles[0].kind, 'the scene belt is untouched by the prediction').toEqual({
        Straight: { axis: 1 },
      });

      // FRAME 2, THE DOCK IS SENT (by watchBeltFollowUp): the scene is unchanged.
      const f2 = drawAndRead(layer, frameScene(T0 + 2, [...s.partner.belts, ref, echoed], s.partner.nodes), s.seam);
      expect(f2.kind, 'frame 2 (Dock sent, not echoed)').toEqual(C);
      expect(f2.cornerDrawn).toBe(true);

      // FRAME 3, THE DOCK ECHO: the packet carries the dock and its own derived corner.
      const docked = mk(NEW_ID, predicted.map((t) => ({ ...t })), [s.tailDock]);
      const f3 = drawAndRead(
        layer,
        frameScene(T0 + 3, [...(s.partnerAfter.length ? s.partnerAfter : s.partner.belts), ref, docked], s.partner.nodes),
        s.seam,
      );
      expect(f3.kind, "frame 3 (Dock echo): the packet's own corner").toEqual(C);
      expect(f3.cornerDrawn).toBe(true);
      expect(pendingSeamsRecord(), 'the registry is empty once the dock has echoed').toBeNull();
    });

    it(`${s.name}: a REFUSED Dock draws the stored Straight once the TTL has passed`, () => {
      const { layer, ref } = setup(s);
      const C = { Corner: { from: s.seam.from, to: s.seam.to } };
      const echoed = mk(NEW_ID, s.stored.map((t) => ({ ...t })));
      const at = (tick: number) =>
        drawAndRead(layer, frameScene(tick, [...s.partner.belts, ref, echoed], s.partner.nodes), s.seam);

      expect(at(T0 + 1).kind, 'NON-VACUITY: predicted on the frame after the echo').toEqual(C);
      // The Dock is refused: no dock ever echoes. Up to the TTL tick the prediction holds
      // (the follow-up's own window), one tick past it the truth shows.
      expect(at(T0 + TTL).kind, 'at the TTL tick').toEqual(C);
      const past = at(T0 + TTL + 1);
      expect(past.kind, 'past the TTL: the belt is genuinely not joined').toEqual({ Straight: { axis: 1 } });
      expect(past.cornerDrawn, 'and the scene graph no longer holds the corner').toBe(false);
      expect(pendingSeamsRecord()).toBeNull();
    });
  }

  it('teardown (clearPendingSeams) drops the prediction on the very next frame', () => {
    // Retitled in plan 88-06: a keyframe no longer clears the records (the held belt and its
    // predicted seam survive it and end on their own verdict); teardown still does.
    const { layer, ref } = setup(S1);
    const echoed = mk(NEW_ID, S1.stored.map((t) => ({ ...t })));
    const scene = (tick: number) => frameScene(tick, [...S1.partner.belts, ref, echoed]);
    expect(drawAndRead(layer, scene(T0 + 1), S1.seam).kind, 'NON-VACUITY').toEqual({
      Corner: { from: 1, to: 0 },
    });
    clearPendingSeams();
    expect(drawAndRead(layer, scene(T0 + 2), S1.seam).kind).toEqual({ Straight: { axis: 1 } });
  });
});
