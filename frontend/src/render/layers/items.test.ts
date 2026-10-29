import { describe, expect, it, vi } from 'vitest';

// MOTION-07 device-pixel snap math, the FLOW-03 zoom floor, and - since plan 61-05 -
// the VECTOR dot and its per-zoom-bucket texture re-bind. The item layer imports
// pixi.js at module load, so this suite stubs pixi.js to stay GPU-free (mirroring
// belts.test.ts). Nothing here touches a live renderer.
//
// THE STUBS RECORD RATHER THAN MERELY EXIST, and that is what lets this suite drive
// the REAL `pixiDotPainter` and the REAL bucket repaint instead of a hand-rolled
// replica of them. `GraphicsContext` records its `circle`/`fill` calls (so the dot's
// geometry and its two constant alphas are assertable without a rasteriser),
// `RenderTexture` records its logical size, its resolution, every RESIZE and its own
// destruction, and every bind/update/resize/destroy is appended to ONE ordered event
// log - which is how "ONE texture, resized in place, NEVER destroyed" is gated rather
// than described.
//
// THE `destroy:` EVENT IS NOW A FAILURE SIGNAL RATHER THAN A STEP TO ORDER. It used to
// be asserted to come LAST in a three-step re-bind; the fix deleted the free entirely,
// because freeing a bound `TextureSource` is what killed the renderer. See
// `itemTextureRebind.test.ts`, which drives the REAL Pixi bind group to prove it.
vi.mock('pixi.js', () => {
  /** The ordered ledger of texture lifecycle events, read by the re-bind cases. */
  const events: string[] = [];
  /** Every RenderTexture ever created, in order. */
  const renderTextures: RenderTexture[] = [];
  (globalThis as unknown as { __dotEvents: string[] }).__dotEvents = events;
  (globalThis as unknown as { __dotTextures: RenderTexture[] }).__dotTextures = renderTextures;

  class GraphicsContext {
    calls: Array<Record<string, unknown>> = [];
    destroyed = false;
    circle(x: number, y: number, radius: number): this {
      this.calls.push({ op: 'circle', x, y, radius });
      return this;
    }
    fill(style: { color: number; alpha: number }): this {
      this.calls.push({ op: 'fill', ...style });
      return this;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  class Graphics {
    destroyed = false;
    destroyedContext = false;
    constructor(public context?: GraphicsContext) {}
    destroy(o?: { context?: boolean }): void {
      this.destroyed = true;
      if (o?.context === true) {
        this.destroyedContext = true;
        this.context?.destroy();
      }
    }
  }
  let nextTextureId = 1;
  class RenderTexture {
    readonly id = nextTextureId++;
    readonly width: number;
    readonly height: number;
    /** MUTABLE since the fix: a bucket change RESIZES this texture in place. */
    resolution: number;
    /** Pixi's LOGICAL extent - what sizes the particle quads. Never moved by resolution. */
    readonly orig: { width: number; height: number };
    readonly source: { pixelWidth: number; pixelHeight: number; destroyed: boolean };
    destroyed = false;
    constructor(o: { width: number; height: number; resolution: number }) {
      this.width = o.width;
      this.height = o.height;
      this.resolution = o.resolution;
      this.orig = { width: o.width, height: o.height };
      this.source = {
        pixelWidth: o.width * o.resolution,
        pixelHeight: o.height * o.resolution,
        destroyed: false,
      };
      renderTextures.push(this);
      events.push(`create:${this.id}@${o.resolution}`);
    }
    static create(o: { width: number; height: number; resolution: number }): RenderTexture {
      return new RenderTexture(o);
    }
    /**
     * Pixi's real `RenderTexture.resize` delegates to `TextureSource.resize`, which
     * keeps `width`/`height` and moves ONLY `resolution` + the pixel extents. Mirrored
     * exactly here, because that invariant is what keeps the drawn quads still.
     */
    resize(width: number, height: number, resolution: number): this {
      this.resolution = resolution;
      this.source.pixelWidth = width * resolution;
      this.source.pixelHeight = height * resolution;
      events.push(`resize:${this.id}@${resolution}`);
      return this;
    }
    destroy(destroySource?: boolean): void {
      this.destroyed = true;
      if (destroySource === true) this.source.destroyed = true;
      events.push(`destroy:${this.id}`);
    }
  }
  class Texture {}
  // 56-05 (VEC-04): the container records the particles actually IN the batch, so the
  // batching assertion can read the display-object list and its types rather than
  // trusting the layer's own bookkeeping.
  class ParticleContainer {
    #texture: RenderTexture | undefined;
    particles: Particle[] = [];
    updates = 0;
    get texture(): RenderTexture | undefined {
      return this.#texture;
    }
    set texture(t: RenderTexture | undefined) {
      this.#texture = t;
      events.push(`bind-container:${t?.id ?? 'none'}`);
    }
    update(): void {
      this.updates++;
      events.push('update');
    }
    /** Pixi v8's own name for the particles in the batch (`ParticleContainer.particleChildren`),
     *  a view of the same list, so `plottedDots` reads the field the real class carries. */
    get particleChildren(): Particle[] {
      return this.particles;
    }
    addParticle(p: Particle): void {
      this.particles.push(p);
    }
    removeParticle(p: Particle): void {
      const i = this.particles.indexOf(p);
      if (i >= 0) this.particles.splice(i, 1);
    }
  }
  class Particle {
    x = 0;
    y = 0;
    scaleX = 1;
    scaleY = 1;
    #texture: RenderTexture | undefined;
    constructor(props?: { texture?: RenderTexture }) {
      this.#texture = props?.texture;
    }
    get texture(): RenderTexture | undefined {
      return this.#texture;
    }
    set texture(t: RenderTexture | undefined) {
      this.#texture = t;
      events.push(`bind-particle:${t?.id ?? 'none'}`);
    }
  }
  return { Graphics, GraphicsContext, ParticleContainer, Particle, RenderTexture, Texture };
});

import {
  CORE_R,
  DOT_SIZE,
  DOT_ZOOM_BUCKETS,
  createItemLayer,
  dotDeviceScale,
  dotVectorContext,
  dotZoomBucket,
  itemDotGrow,
  ITEM_INTERPOLATION_DEFAULT,
  pixiDotPainter,
  SHIPPED_DOTS,
  snapToDevicePixel,
  type DotTexturePainter,
  type ItemDotSpec,
} from './items.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { CELL } from '../../../shared/geometry.ts';
import { MAX_ZOOM } from '../camera.ts';
// 56-05 (VEC-04): the mocked classes, imported as VALUES so the batching assertion can
// check display-object types with `toBeInstanceOf` rather than duck-typing them.
import { Graphics, Particle, ParticleContainer, RenderTexture } from 'pixi.js';
import { applyPacket, createSceneState, type SceneState } from '../sceneState.ts';
import type { BeltView, RenderPacket } from '../../protocol/decode.ts';
// The REAL render clock and the REAL lag constant. The interpolation-drive cases at the
// bottom of this file produce every clock value they draw at by calling
// `advanceRenderClock`, so no test down there can pin a clock the live loop cannot reach.
import { advanceRenderClock, LAG_TICKS } from '../interp.ts';
import { SIM_TICK_MS } from '../loop.ts';

// ---------------------------------------------------------------------------
// Shared harness for the vector-dot cases (plan 61-05).
// ---------------------------------------------------------------------------

// The mocked classes' RECORDING shape. `npx tsc --noEmit` typechecks against the REAL
// pixi.js declarations (vi.mock is a runtime substitution and the compiler never sees
// it), so the recorders below are invisible to it and every read of one goes through
// these local shapes. They are hand-written to match the stubs, deliberately: a type
// derived from the stub classes would agree with them at any shape.
interface StubTexture {
  id: number;
  resolution: number;
  orig: { width: number; height: number };
  source: { pixelWidth: number; destroyed: boolean };
  destroyed: boolean;
}
interface StubParticle {
  x: number;
  y: number;
  texture: StubTexture;
}
interface StubContainer {
  texture: StubTexture;
  particles: StubParticle[];
  updates: number;
}
interface StubGraphics {
  destroyed: boolean;
  destroyedContext: boolean;
}

const events = (): string[] => (globalThis as unknown as { __dotEvents: string[] }).__dotEvents;
const textures = (): StubTexture[] =>
  (globalThis as unknown as { __dotTextures: StubTexture[] }).__dotTextures;

/** A recording stand-in for the ONE renderer capability `pixiDotPainter` uses. */
function fakeRenderer(): {
  render(o: { container: unknown; target: unknown; clear: boolean }): void;
  calls: Array<{ container: unknown; target: unknown; clear: boolean }>;
} {
  const calls: Array<{ container: unknown; target: unknown; clear: boolean }> = [];
  return {
    calls,
    render(o): void {
      calls.push(o);
    },
  };
}

/** The SHIPPED painter, driven against the recording renderer. */
function realPainter(): DotTexturePainter {
  return pixiDotPainter(fakeRenderer() as never);
}

/** Build a wired layer; every positional argument stays where it has always been. */
function layerAt(
  quantum: () => number,
  scale: () => number = () => 1,
  dots: ItemDotSpec = SHIPPED_DOTS,
  paint: DotTexturePainter = realPainter(),
): ReturnType<typeof createItemLayer> {
  return createItemLayer(LOCKED_SKIN, quantum, scale, dots, paint);
}

describe('snapToDevicePixel - device-pixel quantum snap (MOTION-07)', () => {
  // q = renderer.resolution * camera.container.scale.x (zoom). Snapping to the
  // WHOLE-device-pixel grid means round(v*q)/q: the result, multiplied by q, is an
  // integer number of device pixels. This is the anti-shimmer invariant.

  const onGrid = (snapped: number, q: number): boolean =>
    Number.isInteger(Math.round(snapped * q * 1e9) / 1e9);

  it('DPR 1, zoom 1 (q=1): snaps to whole world units', () => {
    // At q=1 the device-pixel grid IS the integer world grid.
    expect(snapToDevicePixel(3.4, 1)).toBe(3);
    expect(snapToDevicePixel(3.6, 1)).toBe(4);
    expect(snapToDevicePixel(-2.4, 1)).toBe(-2);
  });

  it('is a no-op on a value already on the device-pixel grid', () => {
    // Already-snapped values must round-trip identically (no drift / no crawl).
    for (const q of [1, 1.25, 1.5, 2, 0.5]) {
      // Build a value that is exactly k device-pixels: v = k / q.
      const v = 7 / q;
      expect(snapToDevicePixel(v, q)).toBeCloseTo(v, 10);
    }
  });

  it('fractional DPR (q=1.25): step is fractional-world but whole-device', () => {
    // q=1.25 → device pixel = 0.8 world units. Nearest device pixel to 3.4 is
    // round(3.4*1.25)/1.25 = round(4.25)/1.25 = 4/1.25 = 3.2.
    const s = snapToDevicePixel(3.4, 1.25);
    expect(s).toBeCloseTo(3.2, 10);
    expect(onGrid(s, 1.25)).toBe(true);
  });

  it('fractional DPR (q=1.5): lands on the whole-device-pixel grid', () => {
    // round(3.4*1.5)/1.5 = round(5.1)/1.5 = 5/1.5 = 3.3333…
    const s = snapToDevicePixel(3.4, 1.5);
    expect(s).toBeCloseTo(5 / 1.5, 10);
    expect(onGrid(s, 1.5)).toBe(true);
  });

  it('non-1.0 zoom folded into q (q = res*zoom) keeps alignment', () => {
    // DPR 1.25 at zoom 2 → q = 2.5. The same world point snaps DIFFERENTLY than at
    // zoom 1 - alignment holds at every zoom (Pitfall 4: zoom MUST be in q).
    const q = 1.25 * 2;
    const s = snapToDevicePixel(3.4, q);
    expect(s).toBeCloseTo(Math.round(3.4 * q) / q, 10);
    expect(onGrid(s, q)).toBe(true);
    // And it differs from the zoom-1 snap for this point (proves zoom is load-bearing).
    expect(s).not.toBeCloseTo(snapToDevicePixel(3.4, 1.25), 6);
  });

  it('guards a non-positive quantum (returns the value untouched)', () => {
    // q should never be <= 0 (resolution >= 1, zoom in [0.25, 4]); the guard just
    // keeps the math NaN-free if a degenerate quantum ever reaches it.
    expect(snapToDevicePixel(3.4, 0)).toBe(3.4);
    expect(snapToDevicePixel(3.4, Number.NaN)).toBe(3.4);
  });
});

describe('itemDotGrow - dot zoom-floor (FLOW-03)', () => {
  // The per-particle world-scale grown from the zoom floor so a native ~2.8px core
  // never vanishes at low zoom. Shape mirrors ports.ts nubHitRadiusWorld
  // (1 / Math.min(1, scale)), capped so the grown world radius never balloons past
  // the lane: grow <= (0.4 * CELL) / CORE_R. Pure math, no layer construction
  // (mirrors the snapToDevicePixel suite above).

  const CAP = (0.4 * CELL) / CORE_R; // ~5.333 for CELL=32, CORE_R=2.4

  it('is native size (grow 1) at zoom >= 1 - no ballooning at 4x', () => {
    // Math.min(1, scale) = 1 for scale >= 1 -> grow = 1. The dot stays its baked
    // native size at zoom 1 and does not balloon at max zoom 4.
    expect(itemDotGrow(1)).toBe(1);
    expect(itemDotGrow(4)).toBe(1);
    expect(itemDotGrow(2)).toBe(1);
  });

  it('grows as 1/scale below zoom 1 (while under the cap)', () => {
    // Below zoom 1 the dot grows in world units so its on-screen size holds:
    // grow = 1 / scale as long as that stays under the cap.
    expect(itemDotGrow(0.5)).toBeCloseTo(2, 10); // 1 / 0.5
    expect(itemDotGrow(0.25)).toBeCloseTo(4, 10); // 1 / 0.25 (still < CAP ~4.571)
  });

  it('caps the grow factor so the dot never balloons past the lane', () => {
    // For a very small scale the raw 1/scale would explode; the cap holds it at
    // (0.4 * CELL) / CORE_R so the grown world radius stays <= 0.4*CELL.
    expect(itemDotGrow(0.01)).toBeCloseTo(CAP, 10);
    expect(itemDotGrow(0.1)).toBeCloseTo(CAP, 10); // 1/0.1 = 10 > CAP -> capped
    // The grown world core radius never exceeds 0.4 * CELL.
    expect(itemDotGrow(0.01) * CORE_R).toBeLessThanOrEqual(0.4 * CELL + 1e-9);
  });

  it('is monotonic non-increasing in scale over (0, 1]', () => {
    const samples = [0.05, 0.1, 0.25, 0.4, 0.5, 0.75, 1];
    for (let k = 1; k < samples.length; k++) {
      expect(itemDotGrow(samples[k])).toBeLessThanOrEqual(itemDotGrow(samples[k - 1]) + 1e-12);
    }
  });
});

// ---------------------------------------------------------------------------
// VEC-01 (plan 61-05): THE DOT'S REPRESENTATION CHANGED. ITS LOOK DID NOT.
//
// The maintainer ruled (2026-08-10) that `items.ts` converts to vector this
// phase: a 4.8px baked dot resampled at 177% zoom is the soft-edge complaint milestone
// v7.0 was founded on. `61-UI-SPEC.md` A9 locks the item dot as "unchanged"; that lock
// was written before the collision was known and is superseded ON REPRESENTATION ONLY.
//
// **SO THE GATE IS THE LOOK**, and it is asserted rather than assumed: the drawn
// diameter, the two constant alphas, the accent, the ring-under-core precedence and
// the logical box size are each pinned below. The TESSELLATED bytes are pinned
// separately by the golden digest in `synth/beltPainter.digest.test.ts`, which is the
// dot's only regression gate and was re-blessed in the same commit as this change.
//
// VEC-01 IS TICKED ON A STATED, NARROWER READING THAN ITS LITERAL TEXT - the written
// exemption list lives in `render/vectorOnly.test.ts`. Nothing in this file should be
// read as VEC-01 unqualified.
// ---------------------------------------------------------------------------
describe('the item dot is VECTOR, and its look is unchanged (VEC-01, plan 61-05)', () => {
  type Call = Record<string, unknown>;
  const callsOf = (spec?: ItemDotSpec): Call[] =>
    (dotVectorContext(LOCKED_SKIN, spec) as unknown as { calls: Call[] }).calls;

  it('SHIPPED_DOTS is the frozen default and still holds the locked four numbers', () => {
    expect(SHIPPED_DOTS.matrix).toBe(DOT_SIZE);
    expect(SHIPPED_DOTS.coreR).toBe(CORE_R);
    expect(SHIPPED_DOTS.glowR).toBe(0); // 53-BELT-LOCK.md axis 5: NO ring
    expect(SHIPPED_DOTS.glowAlpha).toBe(110); // carried, INERT at radius 0
    expect(Object.isFrozen(SHIPPED_DOTS)).toBe(true);
  });

  it('THE LOOK: the shipped dot is ONE opaque 4.8px-diameter core in the item accent', () => {
    // This is the assertion the superseded A9 lock actually protects. The drawn
    // diameter and the alpha are the two things a reader would notice if this
    // conversion had gone wrong, so they are pinned as literals rather than derived
    // from the spec that produced them.
    const calls = callsOf();
    expect(calls).toHaveLength(2); // one circle + its fill; the ring branch never fires
    expect(calls[0]).toEqual({ op: 'circle', x: DOT_SIZE / 2, y: DOT_SIZE / 2, radius: CORE_R });
    expect(calls[1]).toEqual({ op: 'fill', color: LOCKED_SKIN.palette.accents.item, alpha: 1 });
    expect(2 * (calls[0].radius as number)).toBeCloseTo(4.8, 9); // the locked outer diameter
  });

  it('THE GEOMETRY: a ring-bearing spec draws two CONCENTRIC circles, ring FIRST', () => {
    // The retired bake selected between two constant alphas by a radius threshold with
    // an `else if`, so the core won at every radius it covered. In vector that
    // precedence IS the draw order, which is why it is asserted rather than left to
    // read correctly. A converter that dropped the ring, or drew it over the core,
    // would pass every other case in this file.
    const ringed: ItemDotSpec = { ...SHIPPED_DOTS, glowR: 3.8 };
    const calls = callsOf(ringed);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ op: 'circle', radius: ringed.glowR });
    expect(calls[1]).toMatchObject({ op: 'fill', alpha: ringed.glowAlpha / 255 });
    expect(calls[2]).toMatchObject({ op: 'circle', radius: ringed.coreR });
    expect(calls[3]).toMatchObject({ op: 'fill', alpha: 1 });
    // CONCENTRIC: both circles sit on the box centre, so the ring is a ring and not a
    // crescent.
    expect(calls[0].x).toBe(calls[2].x);
    expect(calls[0].y).toBe(calls[2].y);
    // TWO CONSTANT ALPHAS and no third: 255/255 and glowAlpha/255, never a computed
    // tint or a brightness multiply (SYNTH-05's surviving half).
    const alphas = calls.filter((c) => c.op === 'fill').map((c) => c.alpha);
    expect(new Set(alphas).size).toBe(2);
    expect(alphas).toEqual([110 / 255, 1]);
  });

  it('rejects a box too small for its ring with a NAMED error (never clips silently)', () => {
    const tooSmall: ItemDotSpec = { matrix: 6, coreR: 2.4, glowR: 3.8, glowAlpha: 110 };
    expect(() => dotVectorContext(LOCKED_SKIN, tooSmall)).toThrow(/ItemDotSpec/);
    expect(() => dotVectorContext(LOCKED_SKIN, tooSmall)).toThrow(/glowR/);
    // The shipped spec sits comfortably inside the bound.
    expect(SHIPPED_DOTS.matrix).toBeGreaterThanOrEqual(2 * SHIPPED_DOTS.glowR + 1);
  });

  it('THE PAINTER: repaints ONE target whose LOGICAL size never moves', () => {
    // The size-safety that makes "the look must not change" cheap: a RenderTexture
    // varies `resolution`, never `width`/`height`, so `orig` stays at the box size and
    // the drawn quads do not move on a bucket change (Wave 0 probe, case 4).
    const renderer = fakeRenderer();
    const paint = pixiDotPainter(renderer as never);
    const target = RenderTexture.create({
      width: DOT_SIZE,
      height: DOT_SIZE,
      resolution: 1,
    }) as unknown as StubTexture;

    paint(target as never, LOCKED_SKIN, SHIPPED_DOTS, 1);
    expect(target.orig).toEqual({ width: DOT_SIZE, height: DOT_SIZE });
    expect(target.source.pixelWidth).toBe(DOT_SIZE);

    paint(target as never, LOCKED_SKIN, SHIPPED_DOTS, 8);
    // THE SAME OBJECT, at a new density. Identity stability is the safety property:
    // a source that is never replaced is a source that is never freed while bound.
    expect(target.orig).toEqual({ width: DOT_SIZE, height: DOT_SIZE }); // the LOOK
    expect(target.source.pixelWidth).toBe(DOT_SIZE * 8); // the CRISPNESS: 8x native px
    expect(target.destroyed).toBe(false);

    // The renderer was actually driven, into that same target, with a clear.
    expect(renderer.calls).toHaveLength(2);
    expect(renderer.calls[1]).toMatchObject({ target, clear: true });
    expect(renderer.calls[1].container).toBeInstanceOf(Graphics);
    // The externally-supplied GraphicsContext is freed with its holder, or every
    // repaint leaks a tessellation (`Graphics.destroy()` frees only an OWNED context).
    // This destroy is safe where the TEXTURE one was not: a GraphicsContext is bound
    // into no shader's bind group.
    const holder = renderer.calls[1].container as unknown as StubGraphics;
    expect(holder.destroyed).toBe(true);
    expect(holder.destroyedContext).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The zoom-bucket ladder and the in-place bucket repaint (plan 61-05, corrected by
// the `machines-missing-webkitgtk` fix).
// ---------------------------------------------------------------------------
describe('the dot texture is rasterised per ZOOM BUCKET and never upsampled', () => {
  it('buckets are a CEILING over the drawn device scale, so the dot downsamples', () => {
    expect(DOT_ZOOM_BUCKETS).toEqual([1, 2, 4, 8]);
    expect(dotZoomBucket(1)).toBe(1);
    expect(dotZoomBucket(1.01)).toBe(2);
    expect(dotZoomBucket(1.77)).toBe(2); // the fractional-DPR crispness case
    expect(dotZoomBucket(4)).toBe(4);
    expect(dotZoomBucket(4.5)).toBe(8);
    // The ceiling is DERIVED: MAX_ZOOM x the highest DPR this milestone has baselines
    // for (2). Above it the ladder clamps rather than allocating without bound.
    expect(DOT_ZOOM_BUCKETS[DOT_ZOOM_BUCKETS.length - 1]).toBe(MAX_ZOOM * 2);
    expect(dotZoomBucket(99)).toBe(MAX_ZOOM * 2);
    // A degenerate scale takes the floor rather than producing a NaN resolution.
    expect(dotZoomBucket(0)).toBe(1);
    expect(dotZoomBucket(Number.NaN)).toBe(1);
  });

  it('the device scale composes the FLOW-03 grow with the MOTION-07 quantum', () => {
    // At zoom >= 1 grow is 1, so the drawn scale is just DPR x zoom.
    expect(dotDeviceScale(8, 4)).toBe(8); // zoom 4 on a 2x display
    expect(dotDeviceScale(1, 1)).toBe(1);
    // BELOW zoom 1 the two cancel: itemDotGrow holds the ON-SCREEN size, so bucketing
    // on raw zoom would rasterise the low-zoom dot at a quarter of its drawn size.
    expect(dotDeviceScale(0.25, 0.25)).toBeCloseTo(1, 9); // grow 4 x quantum 0.25
    expect(dotZoomBucket(dotDeviceScale(0.25, 0.25))).toBe(1);
  });

  it('THE RETIRED BAKE UPSAMPLED 8x AT THE TOP OF THE RANGE - the reason this exists', () => {
    // Non-vacuity for the whole ladder: if the shipped native extent had already met
    // the ceiling there would have been nothing to fix. The retired bake was DOT_SIZE
    // native px at every zoom.
    const RETIRED_NATIVE_PX = DOT_SIZE;
    const drawnAtMax = DOT_SIZE * MAX_ZOOM * 2;
    expect(drawnAtMax / RETIRED_NATIVE_PX).toBe(8);
    const paint = realPainter();
    const atMax = RenderTexture.create({
      width: DOT_SIZE,
      height: DOT_SIZE,
      resolution: 1,
    }) as unknown as StubTexture;
    paint(atMax as never, LOCKED_SKIN, SHIPPED_DOTS, dotZoomBucket(8));
    expect(atMax.source.pixelWidth).toBe(drawnAtMax); // 1:1 now, not 8x up
  });
});

describe('the per-bucket repaint keeps ONE texture and frees NOTHING', () => {
  /** A one-belt, three-tile scene carrying `itemCount` in-flight items. */
  function sceneWithItems(itemCount: number): SceneState {
    const belt = {
      id: 1,
      latency: 60,
      fill: 0,
      items: Array.from({ length: itemCount }, (_, i) => ({ arrival_tick: i })),
      tiles: [
        { cell_x: 2, cell_y: 5, kind: { Straight: { axis: 0 } } },
        { cell_x: 3, cell_y: 5, kind: { Straight: { axis: 0 } } },
        { cell_x: 4, cell_y: 5, kind: { Straight: { axis: 0 } } },
      ],
      docks: [],
      // SLOT-03: appended LAST after `docks`; the identity interval. This literal is
      // cast (`as unknown as SceneState`) so tsc cannot enforce the field here - it is
      // added deliberately, because a scene belt without it would reach the belt layer
      // as `undefined` and silently exercise the px-per-tick floor.
      ticks_per_slot: 1,
    };
    return {
      tick: 0,
      nodes: new Map(),
      belts: new Map([[1, belt]]),
      canUndo: false,
      canRedo: false,
    } as unknown as SceneState;
  }

  it('RESIZES the one texture in place and DESTROYS NOTHING (the regression gate)', () => {
    // THIS IS THE FIXED DEFECT, AND THE `destroy:` ABSENCE IS THE WHOLE ASSERTION.
    // Plan 61-05 minted a texture per bucket and freed the outgoing one. Freeing a
    // `TextureSource` that is still bound in a Pixi `BindGroup` makes that bind group
    // DESTROY ITSELF (`BindGroup.onResourceChange`: `if (resource.destroyed)
    // this.destroy()`), and the source was bound in the particle pipe's per-renderer
    // `defaultShader`. The next frame's `shader.resources.uTexture = ...` threw from
    // inside `Application.render` - a Ticker listener - and `Ticker._tick` only
    // re-requests its animation frame AFTER `update()` returns, so the render loop
    // stopped for good. `itemTextureRebind.test.ts` drives REAL Pixi to prove that
    // chain; this case gates the SHIPPED layer against ever re-entering it.
    //
    // Ordering could not have fixed it, which is why the old three-step order
    // assertion is GONE rather than reordered: `layer.texture = fresh` is a JS
    // assignment, while the SHADER binding only moves during a real render pass, and
    // the whole rebind ran inside `draw()` - before the renderer's own ticker listener.
    let zoom = 1;
    const layer = layerAt(() => zoom, () => zoom);
    layer.draw(sceneWithItems(4), 0);

    const container = layer.layer as unknown as StubContainer;
    const before = container.texture;
    const mark = events().length;

    zoom = 4; // quantum 4, grow 1 -> device scale 4 -> bucket 4
    layer.draw(sceneWithItems(4), 1);

    const after = container.texture;
    expect(after.id, 'the texture IDENTITY must survive a bucket change').toBe(before.id);
    expect(after.resolution, 'the bucket change moved the DENSITY').toBe(4);
    expect(after.source.pixelWidth).toBe(DOT_SIZE * 4);

    const seq = events().slice(mark);
    expect(seq, 'a bucket change RESIZES the one texture').toContain(`resize:${after.id}@4`);
    expect(
      seq.filter((e) => e.startsWith('destroy:')),
      'NOTHING may be destroyed on a bucket change - freeing a bound source is the bug',
    ).toEqual([]);
    expect(
      seq.filter((e) => e.startsWith('create:')),
      'a bucket change allocates no second texture',
    ).toEqual([]);

    // Both bindings still hold the one live texture. They were never re-pointed
    // because there is nothing to re-point to: the object never changed.
    for (const p of container.particles) {
      expect(p.texture.id).toBe(after.id);
      expect(p.texture.destroyed).toBe(false);
    }
    // ... including pooled particles that leave and re-enter the batch.
    layer.draw(sceneWithItems(1), 2); // shrink: three particles leave the batch
    layer.draw(sceneWithItems(4), 3); // grow: the same three come back
    for (const p of container.particles) {
      expect(p.texture.id).toBe(after.id);
      expect(p.texture.destroyed).toBe(false);
    }
  });

  it('NON-VACUITY: the bucket really moved, so the gate above is not asserting a no-op', () => {
    // Without this the case above would pass just as happily against a layer that
    // ignored zoom entirely and never repainted at all.
    let zoom = 1;
    const layer = layerAt(() => zoom, () => zoom);
    layer.draw(sceneWithItems(4), 0);
    const container = layer.layer as unknown as StubContainer;
    expect(container.texture.resolution).toBe(1);

    const mark = events().length;
    zoom = 4;
    layer.draw(sceneWithItems(4), 1);
    expect(container.texture.resolution).toBe(4);
    expect(events().slice(mark).filter((e) => e.startsWith('resize:'))).toHaveLength(1);

    // ... and a draw that does NOT cross a bucket repaints nothing at all.
    const steady = events().length;
    layer.draw(sceneWithItems(4), 2);
    expect(events().slice(steady).filter((e) => e.startsWith('resize:'))).toEqual([]);
  });

  it('the container still binds a LIVE source after the bucket change and two more draws', () => {
    // The recorded crash surfaced on the frame AFTER the free, so a single post-change
    // draw would be a weaker claim than the defect deserves.
    let zoom = 1;
    const layer = layerAt(() => zoom, () => zoom);
    layer.draw(sceneWithItems(6), 0);
    const container = layer.layer as unknown as StubContainer;
    const before = container.texture;

    zoom = 2;
    layer.draw(sceneWithItems(6), 1);
    layer.draw(sceneWithItems(6), 2);
    layer.draw(sceneWithItems(6), 3);

    const live = container.texture;
    expect(live.destroyed).toBe(false);
    expect(live.source.destroyed).toBe(false);
    // ... and it is the SAME source it always was. The outgoing texture is not freed
    // because there is no outgoing texture: that is the fix, not an omission.
    expect(live.id).toBe(before.id);
    expect(before.destroyed).toBe(false);
    expect(before.source.destroyed).toBe(false);
  });

  it('holds EXACTLY ONE live dot texture, before and after a bucket change', () => {
    let zoom = 1;
    const mark = textures().length;
    const layer = layerAt(() => zoom, () => zoom);
    layer.draw(sceneWithItems(30), 0);
    const mine = (): StubTexture[] => textures().slice(mark);
    expect(mine().filter((t) => !t.destroyed)).toHaveLength(1);

    zoom = 4;
    layer.draw(sceneWithItems(30), 1);
    // ONE texture across the change, and it is live. A per-item texture would read 30
    // here and still satisfy every other case in this file; the pre-fix per-bucket
    // baker read 2 (one of them destroyed), which is the shape that broke the renderer.
    expect(mine()).toHaveLength(1);
    expect(mine().filter((t) => !t.destroyed)).toHaveLength(1);

    // A steady zoom repaints nothing at all: twelve more draws allocate no texture.
    const steady = textures().length;
    for (let f = 2; f < 14; f++) layer.draw(sceneWithItems(30), f);
    expect(textures().length).toBe(steady);
  });

  it('refuses to construct without a painter, LOUDLY, naming the wiring', () => {
    // The parameter is defaulted only so the four before it keep their positions. The
    // default's job is to fail at construction rather than to silently fall back to
    // the retired pixel bake - which is how a requirement gets reported as met while
    // the thing it names is still there (61-CONTEXT.md H5).
    expect(() => createItemLayer(LOCKED_SKIN, () => 1)).toThrow(/DotTexturePainter/);
    expect(() => createItemLayer(LOCKED_SKIN, () => 1)).toThrow(/pixiDotPainter/);
    expect(() => createItemLayer(LOCKED_SKIN, () => 1, () => 1, SHIPPED_DOTS)).toThrow(/VEC-01/);
  });

  it('a custom dots spec sizes the texture and STILL holds exactly one', () => {
    const spec: ItemDotSpec = { matrix: 14, coreR: 4.5, glowR: 5.5, glowAlpha: 110 };
    const mark = textures().length;
    layerAt(() => 1, () => 1, spec);
    const mine = textures().slice(mark);
    expect(mine).toHaveLength(1);
    expect(mine[0].orig).toEqual({ width: spec.matrix, height: spec.matrix });
  });
});

// ---------------------------------------------------------------------------
// VEC-04 (plan 56-05): the item layer stays BATCHED as the scene grows.
//
// The vertex budget keeps a single asset inside Pixi's 400-vertex batch cliff. This
// block guards the other half of the same promise: that the number of GPU batches
// does not scale with the number of things on screen. The failure mode it refuses is
// the one that looks harmless in a diff - a texture (or a Graphics) built per item.
// Thirty items would then be thirty draw calls, and the symptom is an unattributable
// frame-rate regression, exactly like crossing the vertex cliff.
//
// The blocks above pin ONE texture per LAYER. This pins the stronger property: one
// texture per layer INDEPENDENT OF SCENE SIZE, measured across a 10x item count - and
// that the ParticleContainer mandate at the head of `items.ts` survived the plan 61-05
// representation change, which is the one thing that route was constrained by.
// ---------------------------------------------------------------------------
describe('items stay batched as the scene grows (VEC-04)', () => {
  /** A one-belt, three-tile scene carrying `itemCount` in-flight items. */
  function sceneWithItems(itemCount: number): SceneState {
    const belt = {
      id: 1,
      latency: 60,
      fill: 0,
      items: Array.from({ length: itemCount }, (_, i) => ({ arrival_tick: i })),
      tiles: [
        { cell_x: 2, cell_y: 5, kind: { Straight: { axis: 0 } } },
        { cell_x: 3, cell_y: 5, kind: { Straight: { axis: 0 } } },
        { cell_x: 4, cell_y: 5, kind: { Straight: { axis: 0 } } },
      ],
      docks: [],
      // SLOT-03: appended LAST after `docks`; the identity interval. This literal is
      // cast (`as unknown as SceneState`) so tsc cannot enforce the field here - it is
      // added deliberately, because a scene belt without it would reach the belt layer
      // as `undefined` and silently exercise the px-per-tick floor.
      ticks_per_slot: 1,
    };
    return {
      tick: 0,
      nodes: new Map(),
      belts: new Map([[1, belt]]),
      canUndo: false,
      canRedo: false,
    } as unknown as SceneState;
  }

  it('constructs the SAME texture count for a 3-item and a 30-item scene', () => {
    const beforeSmall = textures().length;
    const small = layerAt(() => 1, () => 1);
    small.draw(sceneWithItems(3), 0);
    const smallTextures = textures().length - beforeSmall;

    const beforeBig = textures().length;
    const big = layerAt(() => 1, () => 1);
    big.draw(sceneWithItems(30), 0);
    const bigTextures = textures().length - beforeBig;

    // ONE each, and - the actual property - IDENTICAL across a 10x scene. A per-item
    // texture would read 3 and 30 here and still satisfy every other test in this file.
    expect(smallTextures).toBe(1);
    expect(bigTextures).toBe(smallTextures);

    // Redrawing the bigger scene many times allocates nothing further: at a steady zoom
    // the one texture is for the layer's lifetime, not for the frame.
    const beforeRedraw = textures().length;
    for (let f = 0; f < 12; f++) big.draw(sceneWithItems(30), f);
    expect(textures().length).toBe(beforeRedraw);
  });

  it('holds every dot as a Particle inside ONE ParticleContainer sharing ONE Texture', () => {
    const layer = layerAt(() => 1, () => 1);
    layer.draw(sceneWithItems(30), 0);

    const container = layer.layer as unknown as StubContainer;
    expect(container).toBeInstanceOf(ParticleContainer);
    expect(container.particles).toHaveLength(30);
    for (const p of container.particles) expect(p).toBeInstanceOf(Particle);
    expect(container.texture).toBeInstanceOf(RenderTexture);

    // The container's shared texture is the single bind the particle adaptor uses every
    // frame. One texture object, not one per particle - and every particle holds THAT
    // object, so the two bindings agree.
    expect(container.texture).toBeDefined();
    expect(new Set(container.particles.map((p) => p.texture)).size).toBe(1);
    expect(container.particles[0].texture).toBe(container.texture);

    // Shrinking the scene removes particles from the batch rather than tearing the
    // container down, so the batch survives a scene change.
    layer.draw(sceneWithItems(3), 1);
    expect(container.particles).toHaveLength(3);
    expect(layer.layer).toBe(container);
  });

  it('MOTION-07 SURVIVED THE CONVERSION: every drawn dot position is device-snapped', () => {
    // The device-pixel snap is retained UNTOUCHED (STATE is explicit that it is not the
    // bug, and removing it trades an alternating gap for blur at every position). This
    // case drives the real `draw` at a fractional quantum and checks the OUTPUT, so a
    // future edit that dropped the snap while keeping the function exported reddens.
    const q = 1.25;
    const layer = layerAt(() => q, () => 1);
    layer.draw(sceneWithItems(12), 0);
    const container = layer.layer as unknown as StubContainer;
    expect(container.particles).toHaveLength(12);
    for (const p of container.particles) {
      expect(Math.round(p.x * q * 1e9) / 1e9).toBe(Math.round(p.x * q));
      expect(Math.round(p.y * q * 1e9) / 1e9).toBe(Math.round(p.y * q));
      expect(p.x).toBe(snapToDevicePixel(p.x, q)); // idempotent: already on the grid
    }
    // NON-VACUITY: the dots are not all at one point, so "snapped" is a claim about
    // twelve distinct positions rather than about the origin.
    expect(new Set(container.particles.map((p) => p.x)).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// TRAILING INTERPOLATION, THE DRAWING HALF (SLOT-04, D-10/D-11/D-12).
// ---------------------------------------------------------------------------
//
// EVERY EXPECTED ARC LENGTH BELOW IS HAND-TYPED, never taken from `slotArcLength`.
// A value derived from the function under test agrees with it at every value, which is
// this phase's standing rule (D-22). The arithmetic, written out once so each literal
// is checkable by eye rather than by re-running the code:
//
//   A 2-tile STRAIGHT belt spans admit edge to deliver edge, so `total` = 64 and each
//   tile flows 32. The host ships `latency` = SLOTS_PER_TILE * tiles = 8, so
//   `slotsPerTile` = 4 and the pitch is 8.000px. Slot 0 is the HEAD, so counting from
//   the tail `fromTail = 7 - slot`, the owning tile is `floor(fromTail / 4)` and the
//   slot sits in a CENTERED band inside it:
//
//     d(slot) = 32 * floor((7 - slot) / 4) + 8 * ((7 - slot) mod 4) + 4
//
//     slot 2 -> fromTail 5 -> 32 + 8 + 4 = 44
//     slot 3 -> fromTail 4 -> 32 + 0 + 4 = 36
//
//   The belt sits on row 0, so every dot's y is that row's cell centre, 16.
//
// The scene is driven through the REAL `applyPacket`, so these cases gate the packet
// path and the draw path together: a from-slot that the cache failed to record is a
// dot drawn at its current slot, which every case here would catch.

/** The 2-tile straight belt the arithmetic above describes, carrying `slots`. */
function straightBelt(slots: number[]): BeltView {
  return {
    id: 1,
    latency: 8, // SLOTS_PER_TILE (4) * 2 tiles - the host's own invariant
    fill: slots.length,
    items: slots.map((s) => ({ arrival_tick: s, tag: 0 })),
    tiles: [
      { cell_x: 0, cell_y: 0, kind: { Straight: { axis: 0 } } },
      { cell_x: 1, cell_y: 0, kind: { Straight: { axis: 0 } } },
    ],
    docks: [],
    ticks_per_slot: 1,
  };
}

const interpPacket = (p: Partial<RenderPacket>): RenderPacket => ({
  tick: 0,
  full: false,
  placed: [],
  removed: [],
  belts: [],
  can_undo: false,
  can_redo: false,
  wires: [],
  // 73-12: appended on the wire after `wires`. `false` is the shipped value
  // for every packet except a transport's lag-resync frame.
  resync: false,
  // Phase 88 (D-02): appended LAST, after `resync`; the board generation.
  generation: 0,
  swap_floor: 0,
  ...p,
});

/**
 * A scene in which belt 1's single item was at `wasSlot` at tick `atTick` and is at
 * `isSlot` now. Built by applying two real packets, so `prevItemSlots` is populated the
 * way the live path populates it.
 */
function sceneAfterAdvance(
  wasSlot: number,
  isSlot: number,
  atTick = 100,
  belt: (slots: number[]) => BeltView = straightBelt,
): SceneState {
  const scene = createSceneState();
  applyPacket(scene, interpPacket({ tick: atTick, belts: [belt([wasSlot])] }));
  applyPacket(scene, interpPacket({ tick: atTick + 1, belts: [belt([isSlot])] }));
  return scene;
}

/**
 * THE MID-GLIDE CLOCK, AND WHY IT IS 99.5 RATHER THAN THE 100.5 THIS BLOCK SHIPPED WITH.
 *
 * `sceneAfterAdvance` builds packets at ticks 100 and 101, so `history.atTick` is 100 and
 * `advanceRenderClock` caps the clock at `latestSimTick - LAG_TICKS` = 100.0. The 100.5
 * these cases used to pass is ABOVE that ceiling: the live loop cannot produce it on any
 * display, at any refresh rate, ever. That is how a whole block of green cases sat on top
 * of an interpolation that never interpolated (see the 62-INTERP-FIX block at the bottom
 * of this file) - they exercised the lerp at a parameter the integration could not
 * deliver.
 *
 * 99.5 is REACHABLE and is what the loop actually holds mid-walk: the clock free-runs at
 * 60 tick-units/sec toward a ceiling that steps on each packet, so on a panel refreshing
 * faster than the sim ticks it sits between the ceilings 99 and 100 for real frames. At
 * the identity interval that makes `t` exactly 0.5, which is why every arc-length figure
 * below is unchanged from the ones this block was written with.
 */
const MID_GLIDE_CLOCK = 99.5;
/** The clock on the frame the walk SATURATES on its ceiling: t = 1, the current slot. */
const ARRIVED_CLOCK = 100;
/** The clock one full tick below the origin: t = 0, the slot the item left. */
const DEPARTED_CLOCK = 99;

describe('trailing item interpolation, the drawing half (SLOT-04)', () => {
  it('the exported default is OFF, read without installing any hook', () => {
    expect(ITEM_INTERPOLATION_DEFAULT).toBe(false);
  });

  it('TOGGLE OFF: the dot is drawn at EXACTLY its current slot arc length (44), bit-for-bit the pre-plan renderer', () => {
    const layer = layerAt(() => 1, () => 1);
    // Mid-glide by the clock, and irrelevant: the off path never reads it.
    layer.draw(sceneAfterAdvance(3, 2), MID_GLIDE_CLOCK);
    const [p] = (layer.layer as unknown as StubContainer).particles;
    expect(p.x, 'slot 2 sits at arc length 44 on a 2-tile straight').toBe(44);
    expect(p.y).toBe(16);
  });

  it('TOGGLE OFF is the DEFAULT: an unedited 2-argument caller gets the current slot', () => {
    const layer = layerAt(() => 1, () => 1);
    layer.draw(sceneAfterAdvance(3, 2), MID_GLIDE_CLOCK); // no third argument at all
    expect((layer.layer as unknown as StubContainer).particles[0].x).toBe(44);
  });

  it('TOGGLE ON, mid-glide: the dot lies strictly BETWEEN the two slots (36 and 44), at 40', () => {
    const layer = layerAt(() => 1, () => 1);
    layer.draw(sceneAfterAdvance(3, 2), MID_GLIDE_CLOCK, true); // t = 0.5 at ticks_per_slot 1
    const [p] = (layer.layer as unknown as StubContainer).particles;
    expect(p.x).toBe(40);
    expect(p.x).toBeGreaterThan(36);
    expect(p.x).toBeLessThan(44);
  });

  it('TOGGLE ON, the CLAMP LOW extreme (a pinned render clock while the sim advances): EXACTLY the previous slot, 36 - never behind the tail, never NaN', () => {
    // `06-fault-red-probe.spec.ts` pins the render clock to 0 while the sim keeps
    // running, so the raw parameter here is (0 + 1 - 100) / 1 = -99.
    const layer = layerAt(() => 1, () => 1);
    layer.draw(sceneAfterAdvance(3, 2), 0, true);
    const [p] = (layer.layer as unknown as StubContainer).particles;
    expect(p.x).toBe(36);
    expect(Number.isNaN(p.x)).toBe(false);
  });

  it('TOGGLE ON, the CLAMP HIGH extreme (the RESYNC_GAP_TICKS snap): EXACTLY the current slot, 44 - never past it', () => {
    // `loop.ts` snaps the clock forward by more than RESYNC_GAP_TICKS in one frame, so
    // the raw parameter here is (1000 + 1 - 100) / 1 = 901.
    const layer = layerAt(() => 1, () => 1);
    layer.draw(sceneAfterAdvance(3, 2), 1000, true);
    expect((layer.layer as unknown as StubContainer).particles[0].x).toBe(44);
  });

  it('TOGGLE ON, a BLOCKED item whose slot did not change: the dot does not move at all (D-11, the backpressure cue)', () => {
    const layer = layerAt(() => 1, () => 1);
    // Same slot in both packets: the item is blocked behind a full head.
    layer.draw(sceneAfterAdvance(2, 2), MID_GLIDE_CLOCK, true);
    expect((layer.layer as unknown as StubContainer).particles[0].x).toBe(44);
  });

  it('TOGGLE ON, a belt with NO history (first sight): the dot is at its current slot, so it never slides in from off the belt', () => {
    const layer = layerAt(() => 1, () => 1);
    const scene = createSceneState();
    applyPacket(scene, interpPacket({ tick: 100, belts: [straightBelt([2])] }));
    layer.draw(scene, MID_GLIDE_CLOCK, true);
    expect((layer.layer as unknown as StubContainer).particles[0].x).toBe(44);
  });

  it('TOGGLE ON with a forged ZERO or NON-FINITE advance interval: the dot lands at 40 and is FINITE, because a NaN dot position kills the Pixi loop permanently', () => {
    // `ticks_per_slot` is a plain u32 on an UNTRUSTED wire and the core's non-zero
    // invariant does not travel. Without the floor a zero divisor makes the parameter
    // Infinity (the clamp saturates it to 1, so the dot silently snaps to the current
    // slot) and a NON-FINITE one makes it NaN outright - and `Math.max(NaN, 0)` is NaN,
    // so the clamp does NOT save that case. `pointAlong` then returns NaN, and a NaN
    // particle position throws inside Application.render, which runs as a Ticker
    // listener and stops the loop PERMANENTLY on a partial frame
    // (the 2026-08-11 machines-missing-on-WebKitGTK failure). BOTH forgeries are
    // driven here, because only the second can produce the NaN this floor exists for.
    for (const forgedInterval of [Number.NaN, 0]) {
      const forged = (slots: number[]): BeltView => ({
        ...straightBelt(slots),
        ticks_per_slot: forgedInterval,
      });
      const layer = layerAt(() => 1, () => 1);
      layer.draw(sceneAfterAdvance(3, 2, 100, forged), MID_GLIDE_CLOCK, true);
      const [p] = (layer.layer as unknown as StubContainer).particles;
      expect(Number.isFinite(p.x), `x is finite at a forged interval of ${forgedInterval}`).toBe(
        true,
      );
      expect(Number.isFinite(p.y)).toBe(true);
      // Floored to the identity interval, so t is still 0.5 and the dot is mid-glide -
      // NOT snapped to either endpoint, which is what a saturating clamp would give.
      expect(p.x).toBe(40);
    }
  });

  it('THROUGH A BEND the glide stays ON the drawn arc, so the corner speed dip is preserved rather than smoothed away (D-12)', () => {
    // The belt runs EAST into a corner at cell (1,0) that turns SOUTH. That corner's
    // arc centre is the tile corner it rounds - c - u_from * R + u_to * R with
    // c = (48,16), R = 16 - which is (32,32), and EVERY point of the drawn arc is
    // exactly R from it. Nothing about that centre or that radius comes from the
    // interpolation code: it is the belt's own geometry.
    //
    // A dot gliding between two slots INSIDE that corner must therefore stay at
    // distance R. A world-space lerp between the two dot POSITIONS would cut the chord
    // and sit ~0.31px inside the circle - which is exactly the "constant px/sec through
    // the bend" alternative `interp.ts` names and rejects, arriving by the back door.
    const bendBelt = (slots: number[]): BeltView => ({
      id: 1,
      latency: 12, // SLOTS_PER_TILE (4) * 3 tiles
      fill: slots.length,
      items: slots.map((s) => ({ arrival_tick: s, tag: 0 })),
      tiles: [
        { cell_x: 0, cell_y: 0, kind: { Straight: { axis: 0 } } },
        { cell_x: 1, cell_y: 0, kind: { Corner: { from: 1, to: 2 } } }, // E -> S
        { cell_x: 1, cell_y: 1, kind: { Straight: { axis: 1 } } },
      ],
      docks: [],
      ticks_per_slot: 1,
    });
    // Slots 7 and 6 are the first two slots of the corner tile (fromTail 4 and 5).
    // A fine device-pixel quantum keeps the snap far below the on-arc tolerance.
    const q = 256;
    const layer = layerAt(() => q, () => 1);
    layer.draw(sceneAfterAdvance(7, 6, 100, bendBelt), MID_GLIDE_CLOCK, true);
    const [p] = (layer.layer as unknown as StubContainer).particles;
    const r = Math.hypot(p.x - 32, p.y - 32);
    expect(
      Math.abs(r - 16),
      `the mid-glide dot sits ${r.toFixed(4)}px from the arc centre; the drawn arc is at ` +
        `exactly 16px, and a world-space lerp would cut ~0.31px inside it`,
    ).toBeLessThan(0.02);
    // NON-VACUITY: the dot really is mid-glide, not parked on either endpoint.
    const ends = [layerAt(() => q, () => 1), layerAt(() => q, () => 1)];
    ends[0].draw(sceneAfterAdvance(7, 6, 100, bendBelt), DEPARTED_CLOCK, true);
    ends[1].draw(sceneAfterAdvance(7, 6, 100, bendBelt), ARRIVED_CLOCK, true);
    const at = (l: (typeof ends)[number]): number =>
      (l.layer as unknown as StubContainer).particles[0].x;
    expect(p.x).not.toBe(at(ends[0]));
    expect(p.x).not.toBe(at(ends[1]));
  });

  it('a belt with several dots interpolates EACH from its own previous slot, across a head delivery', () => {
    // prev [0, 3, 6]: the head is delivered and the other two advance to 2 and 5, so
    // their from-slots are 3 and 6 (never 0 and 3, which a rank match would give).
    //   slot 2 -> 44, from slot 3 -> 36, mid-glide 40
    //   slot 5 -> 20, from slot 6 -> 12, mid-glide 16
    const scene = createSceneState();
    applyPacket(scene, interpPacket({ tick: 100, belts: [straightBelt([0, 3, 6])] }));
    applyPacket(scene, interpPacket({ tick: 101, belts: [straightBelt([2, 5])] }));
    const layer = layerAt(() => 1, () => 1);
    layer.draw(scene, MID_GLIDE_CLOCK, true);
    const xs = (layer.layer as unknown as StubContainer).particles.map((p) => p.x);
    expect(xs).toEqual([40, 16]);
  });
});

// ---------------------------------------------------------------------------
// THE INTEGRATION GATE: the real clock, driving the real draw (62-INTERP-FIX).
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK EXISTS, AND WHY THE BLOCK ABOVE WAS NOT ENOUGH. Every case above
// hands `draw` a render clock as a literal - 100.5 against a scene whose newest packet
// is tick 101. `advanceRenderClock` caps the clock at `latestSimTick - LAG_TICKS`, so
// against that scene the live loop can never produce a value above 100.0, and 100.5 is
// unreachable. Those cases therefore proved the lerp ARITHMETIC works at a parameter the
// integration could not deliver, and shipped an interpolation that never interpolated:
// with the origin (`history.atTick`) and the ceiling (`latestSimTick - LAG_TICKS`) being
// the same number at the identity interval, the numerator was pinned at or below zero and
// the clamp made it exactly 0 on every frame of every display.
//
// This block closes that gap by construction: NOTHING here writes a clock value. Every
// clock drawn at comes out of `advanceRenderClock`, fed the deltas a display frame
// actually carries. If the ceiling and the origin ever collide again, these go red.

/** One drawn frame: the clock the real loop produced, and where the dot landed. */
interface DrivenFrame {
  clock: number;
  x: number;
}

/**
 * Drive `packets` through the REAL `applyPacket` and the REAL `advanceRenderClock`,
 * drawing `framesPerTick` display frames per sim tick, and report every frame.
 *
 * `framesPerTick` is the DISPLAY refresh expressed against the sim rate, and it is
 * load-bearing rather than cosmetic. At 1 the clock's free-running rate and the ceiling's
 * rate are in lockstep, so the clock saturates on the integer every frame and has no
 * sub-tick resolution. Above 1 (a 120Hz or 144Hz panel above a ~60/s sim) the clock walks
 * the gap in fractions before it saturates, which is the only place sub-tick motion can
 * come from. Both are driven below.
 *
 * A fine device-pixel quantum keeps MOTION-07's snap far below the distances asserted, so
 * a failure here is about the motion model and never about rounding.
 */
function driveRealClock(packets: RenderPacket[], framesPerTick: number): DrivenFrame[] {
  const layer = layerAt(() => 256, () => 1);
  const scene = createSceneState();
  const frames: DrivenFrame[] = [];
  // The clock the loop already holds when the first packet lands: its own ceiling.
  let clock = packets[0].tick - LAG_TICKS;
  const deltaMs = SIM_TICK_MS / framesPerTick;
  for (const packet of packets) {
    applyPacket(scene, packet);
    for (let f = 0; f < framesPerTick; f++) {
      clock = advanceRenderClock(clock, scene.tick, deltaMs, SIM_TICK_MS);
      layer.draw(scene, clock, true);
      const p = (layer.layer as unknown as StubContainer).particles[0];
      frames.push({ clock, x: p === undefined ? Number.NaN : p.x });
    }
  }
  return frames;
}

/** A 2-tile straight belt at a chosen advance interval (D-12: the interval moves no slot). */
const beltAtInterval =
  (ticks_per_slot: number) =>
  (slots: number[]): BeltView => ({ ...straightBelt(slots), ticks_per_slot });

/** The arc length of `slot` on the 2-tile straight belt - the header's own formula. */
const arcOf = (slot: number): number => 32 * Math.floor((7 - slot) / 4) + 8 * ((7 - slot) % 4) + 4;

describe('trailing item interpolation, driven by the REAL render clock (62-INTERP-FIX)', () => {
  it('ASSERTION 1: across ONE slot advance the dot takes MORE THAN ONE position, so it actually interpolates', () => {
    // Five real consecutive packets at the SHIPPED identity interval, drawn on a panel
    // refreshing three times per sim tick. Within the tick-101 window the clock walks
    // 99.333 -> 99.667 -> 100.0, so a working interpolation puts the dot at three
    // distinct places between slot 7 (arc 4) and slot 6 (arc 12).
    //
    // At HEAD this is RED with exactly ONE position, and that position is arc 4 - the
    // slot the item has already LEFT.
    const belt = beltAtInterval(1);
    const frames = driveRealClock(
      [100, 101, 102, 103, 104].map((tick, i) =>
        interpPacket({ tick, belts: [belt([7 - i])] }),
      ),
      3,
    );
    // The three frames drawn while the newest packet is tick 101 (item at slot 6).
    const window = frames.slice(3, 6);
    const xs = window.map((f) => f.x);
    const clocks = window.map((f) => f.clock);
    expect(
      new Set(xs).size,
      `the dot must MOVE across the advance; clocks ${JSON.stringify(clocks)} drew ${JSON.stringify(xs)}`,
    ).toBeGreaterThan(1);
    // ...and every one of those positions must lie in the half-open span (from, to]:
    // strictly past the slot it left, never past the slot it is in (D-11 trailing-only).
    for (const x of xs) {
      expect(x, `frame at ${JSON.stringify(clocks)} drew ${JSON.stringify(xs)}`).toBeGreaterThan(
        arcOf(7),
      );
      expect(x).toBeLessThanOrEqual(arcOf(6));
    }
    // The last frame of the window is the one whose clock has saturated on the ceiling,
    // and it must have ARRIVED: the interpolation ends on the truth, it does not stop
    // short of it forever.
    expect(xs[xs.length - 1], `clocks ${JSON.stringify(clocks)} drew ${JSON.stringify(xs)}`).toBe(
      arcOf(6),
    );
  });

  it('ASSERTION 1b: on a panel in LOCKSTEP with the sim the dot still sits on its CURRENT slot, never one slot upstream', () => {
    // One display frame per sim tick: the clock saturates on the integer ceiling every
    // frame, so there is no sub-tick resolution and nothing to interpolate. That is a
    // smoothness limit and it is accepted. It is NOT a licence to draw the dot in the
    // WRONG PLACE, which is what HEAD does - every frame lands a full slot (8px) upstream
    // of where the sim says the item is, so switching interpolation ON visibly shifts
    // every dot backwards. RED at HEAD on all four advances.
    const belt = beltAtInterval(1);
    const frames = driveRealClock(
      [100, 101, 102, 103, 104].map((tick, i) =>
        interpPacket({ tick, belts: [belt([7 - i])] }),
      ),
      1,
    );
    expect(frames.map((f) => f.x), `clocks ${JSON.stringify(frames.map((f) => f.clock))}`).toEqual([
      arcOf(7),
      arcOf(6),
      arcOf(5),
      arcOf(4),
      arcOf(3),
    ]);
  });

  it('ASSERTION 1c: at an advance interval of 4 the glide REACHES the current slot before the next advance', () => {
    // A TEST INTERVAL, NOT A PACE. 4 is chosen here because it is the smallest interval
    // that shows the whole shape of a glide in whole ticks; D-19 (the shipped belt speed)
    // is the maintainer's decision at the sitting and no test value bears on it.
    //
    // The host suppresses an unchanged belt, so at interval 4 the belt re-emits every 4th
    // tick and the empty packets in between still advance the tick (and the clock). Over
    // the four ticks of one interval the dot must walk from the slot it left to the slot
    // it is in, ARRIVING on the last tick. At HEAD it walks 4 -> 6 -> 8 -> 10 and never
    // reaches 12: it is short by one tick's worth on every single frame, forever.
    const belt = beltAtInterval(4);
    const packets = [
      interpPacket({ tick: 100, belts: [belt([7])] }),
      interpPacket({ tick: 101 }),
      interpPacket({ tick: 102 }),
      interpPacket({ tick: 103 }),
      interpPacket({ tick: 104, belts: [belt([6])] }),
      interpPacket({ tick: 105 }),
      interpPacket({ tick: 106 }),
      interpPacket({ tick: 107 }),
    ];
    const frames = driveRealClock(packets, 1);
    // Frames 4..7 are the four ticks of the interval that begins at the tick-104 re-emit.
    const xs = frames.slice(4, 8).map((f) => f.x);
    expect(xs, `clocks ${JSON.stringify(frames.slice(4, 8).map((f) => f.clock))}`).toEqual([
      arcOf(7) + 2,
      arcOf(7) + 4,
      arcOf(7) + 6,
      arcOf(6),
    ]);
  });
});

// ---------------------------------------------------------------------------
// plottedDots (plan 77-02, phase 77 D-04): the drawn items read off the batch.
// ---------------------------------------------------------------------------
//
// The composed walk grades every item claim on the MODEL's `occupiedSlots`, and an item
// layer that places nothing (or places stale positions) passes those reads and both
// render-health helpers. `plottedDots` is the read that cannot: the world-px position of
// every particle the latest `draw` left in the ParticleContainer. These cases pin it on the
// REAL `createItemLayer` and the REAL `draw`.
describe('plottedDots reads the drawn items off the ParticleContainer (plan 77-02)', () => {
  /** A one-belt, three-tile, east-flowing scene, tail (2,5) to head (4,5), twelve slots,
   *  holding items in `slots` (slot 0 is the head end). `null` is a scene with no belt. */
  function sceneOf(slots: number[] | null): SceneState {
    const belts = new Map<number, unknown>();
    if (slots !== null) {
      belts.set(1, {
        id: 1,
        latency: 12,
        fill: 0,
        items: slots.map((s) => ({ arrival_tick: s })),
        tiles: [
          { cell_x: 2, cell_y: 5, kind: { Straight: { axis: 0 } } },
          { cell_x: 3, cell_y: 5, kind: { Straight: { axis: 0 } } },
          { cell_x: 4, cell_y: 5, kind: { Straight: { axis: 0 } } },
        ],
        docks: [],
        ticks_per_slot: 1,
      });
    }
    return {
      tick: 0,
      nodes: new Map(),
      belts,
      canUndo: false,
      canRedo: false,
      prevItemSlots: new Map(),
    } as unknown as SceneState;
  }
  const cellOf = (d: { x: number; y: number }): string =>
    `${Math.floor(d.x / CELL)},${Math.floor(d.y / CELL)}`;

  it('plottedDots: three slots on a 3-tile belt plot three dots, slots 0 and 1 in the head tile cell and slot 11 in the tail tile cell', () => {
    const layer = layerAt(() => 1);
    layer.draw(sceneOf([0, 1, 11]), 0);
    const dots = layer.plottedDots();
    expect(dots, 'one dot per placed item').toHaveLength(3);
    expect(dots.map(cellOf).sort(), 'each dot inside the cell of the tile its slot belongs to').toEqual(
      ['2,5', '4,5', '4,5'],
    );
    for (const d of dots) {
      expect(typeof d.x === 'number' && typeof d.y === 'number', 'plain numbers, no Pixi object').toBe(true);
      expect(Object.keys(d).sort(), 'exactly x and y').toEqual(['x', 'y']);
    }
  });

  it('plottedDots: a scene with no belt plots no dot', () => {
    const layer = layerAt(() => 1);
    layer.draw(sceneOf(null), 0);
    expect(layer.plottedDots()).toEqual([]);
  });

  it('plottedDots: a draw with items followed by a draw with none reports none (released particles are not reported)', () => {
    const layer = layerAt(() => 1);
    layer.draw(sceneOf([0, 1, 11]), 0);
    expect(layer.plottedDots(), 'the first draw placed three').toHaveLength(3);
    layer.draw(sceneOf([]), 1);
    expect(layer.plottedDots()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// plottedDotsFrame (plan 77-04, phase 77 D-04, the 77-04 review blocker): the drawn items AND
// the scene tick the latest `draw` read them from.
// ---------------------------------------------------------------------------
//
// The scene model is updated as each packet lands (`App.tsx` `applyPacket`), and the item layer
// places its dots only inside `draw`, once per display frame. On a FLOWING belt a read of the
// model and of `plottedDots` taken in one breath can therefore pair tick T's model with the dots
// drawn for T-1, and every item that crossed a tile edge in between reads as a mismatch on a
// correct build. Plan 77-07 met the same lag on the load gauge and answered it with a drawn tick;
// these cases pin the same answer for the item layer, on the REAL `createItemLayer`.
describe('plottedDotsFrame carries the scene tick the dots were drawn from (plan 77-04)', () => {
  function sceneAt(tick: number, slots: number[]): SceneState {
    const belts = new Map<number, unknown>();
    belts.set(1, {
      id: 1,
      latency: 12,
      fill: 0,
      items: slots.map((s) => ({ arrival_tick: s })),
      tiles: [
        { cell_x: 2, cell_y: 5, kind: { Straight: { axis: 0 } } },
        { cell_x: 3, cell_y: 5, kind: { Straight: { axis: 0 } } },
        { cell_x: 4, cell_y: 5, kind: { Straight: { axis: 0 } } },
      ],
      docks: [],
      ticks_per_slot: 1,
    });
    return {
      tick,
      nodes: new Map(),
      belts,
      canUndo: false,
      canRedo: false,
      prevItemSlots: new Map(),
    } as unknown as SceneState;
  }

  it('plottedDotsFrame: before any draw, no tick and no dot', () => {
    const layer = layerAt(() => 1);
    expect(layer.plottedDotsFrame()).toEqual({ drawnAtTick: null, dots: [] });
  });

  it('plottedDotsFrame: the dots are exactly plottedDots, and the tick is the drawn scene tick', () => {
    const layer = layerAt(() => 1);
    layer.draw(sceneAt(41, [0, 1, 11]), 0);
    const frame = layer.plottedDotsFrame();
    expect(frame.drawnAtTick, 'the tick of the scene the draw read').toBe(41);
    expect(frame.dots, 'the same dots plottedDots reads').toEqual(layer.plottedDots());
    expect(frame.dots).toHaveLength(3);
  });

  it('plottedDotsFrame: a later draw moves the tick and the dots together, and a read between draws keeps the last pair', () => {
    const layer = layerAt(() => 1);
    layer.draw(sceneAt(41, [0, 1, 11]), 0);
    layer.draw(sceneAt(42, [5]), 1);
    const frame = layer.plottedDotsFrame();
    expect(frame.drawnAtTick).toBe(42);
    expect(frame.dots).toHaveLength(1);
    expect(layer.plottedDotsFrame(), 'no draw in between: the same pair').toEqual(frame);
  });
});
