// The renderer-owned belt GEOMETRY cache (VEC-01, plan 61-02): one shared
// `GraphicsContext` per `(kind, chirality, bucket)`, plotted ONCE and bound by every
// `Graphics` that draws that tile. This is the vector sibling of
// `synth/textureCache.ts` and it is deliberately the SAME class shape - a keyed map,
// a lazy build, `created` / `destroyed` / `live` counters, and one `destroyAll()`
// teardown path - so a reader who knows one knows the other.
//
// WHY A CONTEXT CACHE IS A CACHE AT ALL. Pixi v8 caches TESSELLATED GEOMETRY on the
// `GraphicsContext`, not on the `Graphics`. So "one shared context, many Graphics" is
// what keeps N tiles of the same kind at ONE tessellation and inside the 400-vertex
// batching cliff (`isBatchable` is a property of the context). The H7 spike measured
// both halves of that: the context setter ADOPTS by identity rather than copying
// (`61-SPIKE-FINDINGS.md`, case a2), and one context bound by two `Graphics` at once
// leaves neither short of geometry (case c). Without the identity property this
// class would be a per-tile copier wearing a cache's name.
//
// ---------------------------------------------------------------------------
// DELIBERATE DIVERGENCE from `svgAssets.ts` - these contexts are INSTANCE-scoped
// ---------------------------------------------------------------------------
//
// Stated here so it reads as a decision and not an oversight, in the voice
// `svgAssets.ts:20-26` uses for the mirror-image divergence.
//
// `svgAssets.ts` memoises its `GraphicsContext` values at MODULE scope, and it is
// right to: a context built from a committed, immutable, authored `.svg` is
// process-wide constant data with no per-scene ownership and nothing to tear down.
// A BELT context is none of those things. It is a function of the march bucket and of
// the injected `BeltPainter`, it is rebuilt live whenever either changes, and it is
// therefore scene-owned in exactly the way a baked texture is. Memoising it at module
// scope would put a growing map of stale contexts beyond the reach of the
// `setPainter` hook - reintroducing precisely the leak that hook exists to prevent,
// and doing it silently, because a leaked module-global has no counter watching it.
//
// So: instance-scoped, never a module-global singleton, exactly as
// `synth/textureCache.ts` requires of a scene-owned resource.
//
// ---------------------------------------------------------------------------
// TEARDOWN
// ---------------------------------------------------------------------------
//
// `destroyAll()` frees each entry through its OWN `destroy()`. The Pitfall-4
// `destroy(true)` argument that `textureCache.ts` must pass has no analogue here -
// that argument frees a v8 `TextureSource` living behind the `Texture`, and a
// `GraphicsContext` has no second object behind it.
//
// The ORDER still matters and is NOT relaxed by the spike's finding that a bare
// `Graphics.destroy()` spares an externally-supplied context. `destroyAll()` frees
// the contexts EXPLICITLY, so `belts.ts setPainter` must drop every belt root FIRST
// and only then call this - a root still holding a freed context is pointing at freed
// geometry on the next frame. `belts.test.ts` asserts that ORDER, not merely the end
// state.

import type { GraphicsContext } from 'pixi.js';

/**
 * The minimal contract the cache owns: something destroyable. The real path stores a
 * Pixi `GraphicsContext`; a spec stores a fake so the cache and counter logic run
 * GPU-free in the default node environment.
 */
export interface BeltContextEntry {
  destroy(): void;
}

/** Build one context on a cache MISS. Never called on a hit. */
export type BuildBeltContext = () => BeltContextEntry;

/**
 * Stable cache key: a fixed-order pipe join of exactly THREE segments - the tile
 * KIND, the corner CHIRALITY (`'none'` on a straight, which has none) and the march
 * BUCKET.
 *
 * THERE IS NO ZOOM-BUCKET TERM, and its absence is measured rather than assumed.
 * `61-UI-SPEC` A8 provisionally keyed one in, on the `buildAdaptiveBezier`
 * `const scale = 1` hazard. `61-RESEARCH.md` FINDING 1 then established that Pixi
 * 8.19's `ShapePath.arc` routes to `buildArc`, which has its own step formula and
 * never reaches that code path - so ONE fixed tessellation serves the whole zoom
 * range and a zoom term would multiply the cache by |Z| for nothing. That TIGHTENS
 * the boundedness invariant (39, not 156), which is the only direction
 * `beltPainter.metrics.test.ts` permits it to move.
 *
 * THERE IS NO DEVICE-QUANTUM TERM EITHER, AND THAT IS THE SAME DECISION TAKEN TWICE.
 * Plan 61-09 gave the belt RAILS a device-quantum-aware geometry, which is a
 * scale-DEPENDENT asset living beside four scale-free ones. It does not key the
 * quantum in. The quantum is continuous, so a quantum KEY makes the key space
 * unbounded: the cache would either grow without limit under a zoom gesture or be
 * flushed whole, meaning 39 context replots per frame while zooming, 24 of them corner
 * contexts at 24 arc samples each. Instead the rails live in their OWN cache instance,
 * whose whole contents are replaced when the quantum changes - **so the quantum is a
 * cache LIFETIME term and never a cache KEY term**, this function's three-segment
 * contract stays literally true for the rail families as well, and the rail cache
 * cannot grow during a zoom gesture. See `belts.ts` for why it is a second INSTANCE
 * rather than a key prefix inside the first.
 *
 * A cache key is an IDENTITY string, never a geometry input - nothing downstream
 * plots it. Call sites append their OWN extra terms (the painter id) AFTER this join;
 * the segment count a spec asserts is this function's own, so a re-introduced
 * dimension reddens here instead of passing.
 */
export function beltContextKey(kind: string, chirality: string, bucket: number): string {
  return `${kind}|${chirality}|${bucket}`;
}

/**
 * A per-scene belt geometry cache.
 *
 * WHERE THE GPU-FREE SEAM IS, stated because it sits in a different place from
 * `SynthTextureCache`'s. That class takes an injectable `makeTexture` because its
 * build step (`BufferImageSource` upload) is unavoidably GPU-shaped and lives inside
 * the cache. Here the build step lives in the injected `BeltPainter` - which
 * `createBeltLayer` already accepts as a parameter - and reaches this class as the
 * `build` callback of {@link get}. So the seam is the callback, and a second
 * injectable factory field would be a parameter with exactly one legal value: the
 * dead-value artifact `textureCache.ts`'s own header warns misleads a future reader.
 */
export class BeltContextCache {
  /** App-owned leak counters - the primary no-leak proof for belt geometry. */
  created = 0;
  destroyed = 0;

  private readonly map = new Map<string, BeltContextEntry>();

  /**
   * Return the cached context for `key`, plotting it ONCE on first request. On a hit
   * `build` is not called and no second context is created - which is the whole
   * populated-state contract: the context count is a function of the KEY SPACE, not
   * of how many belts are on the board.
   */
  get(key: string, build: BuildBeltContext): BeltContextEntry {
    let ctx = this.map.get(key);
    if (ctx === undefined) {
      ctx = build();
      this.map.set(key, ctx);
      this.created++;
    }
    return ctx;
  }

  /**
   * Remove every entry from the map and hand it back WITHOUT destroying it, so the
   * caller can plot a new generation, rebind every holder, and only THEN free the old.
   *
   * WHY THIS IS NOT `destroyAll()` (plan 61-09). The RAIL family is invalidated by a
   * QUANTUM change rather than by a painter change, and a quantum change happens mid
   * zoom gesture while tiles are on screen. Destroying first would leave every tile
   * bound to freed geometry for exactly one frame - a null GPU resource, not a thrown
   * error. Plot new, rebind, free old; `belts.test.ts` asserts that order AT THE MOMENT
   * OF EACH FREE, because both orderings leave the same tidy end state.
   *
   * `destroyed` deliberately does NOT move here. Between `takeAll` and {@link release}
   * both generations really are alive, and `live` says so - which is the honest reading
   * of a counter whose whole job is to be the leak truth.
   */
  takeAll(): BeltContextEntry[] {
    const out = [...this.map.values()];
    this.map.clear();
    return out;
  }

  /** Free a generation handed back by {@link takeAll}, accounting each free. */
  release(entries: readonly BeltContextEntry[]): void {
    for (const ctx of entries) {
      ctx.destroy();
      this.destroyed++;
    }
  }

  /**
   * Destroy every cached context, then clear the map. `destroyed` increments per
   * entry so it returns to match `created` once everything is freed.
   */
  destroyAll(): void {
    for (const ctx of this.map.values()) {
      ctx.destroy();
      this.destroyed++;
    }
    this.map.clear();
  }

  /** Live context count (created - destroyed) - the app-owned leak truth. */
  get live(): number {
    return this.created - this.destroyed;
  }

  /** Entry count currently held. The populated-state assertion reads this. */
  get size(): number {
    return this.map.size;
  }
}

/** A `GraphicsContext` satisfies {@link BeltContextEntry}; this pins that at compile time. */
export type BeltGraphicsContext = GraphicsContext & BeltContextEntry;
