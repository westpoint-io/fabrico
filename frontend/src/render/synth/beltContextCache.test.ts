import { describe, expect, it, vi } from 'vitest';
import {
  BeltContextCache,
  beltContextKey,
  type BeltContextEntry,
} from './beltContextCache.ts';

// The belt GEOMETRY cache's own suite (VEC-01, plan 61-02), mirroring
// `textureCache.test.ts` case for case so the two caches stay legible as siblings.
//
// GPU-FREE, AND THE SEAM IS THE BUILD CALLBACK. `SynthTextureCache` takes an
// injectable `makeTexture` because its build step is unavoidably GPU-shaped and lives
// inside the class. This cache's build step lives in the injected `BeltPainter` and
// arrives as the `build` argument of `get`, so a fake here is just a callback that
// returns a plain destroyable object. No Pixi is imported at runtime, no context is
// plotted, and the counter arithmetic is asserted on its own rather than through a
// renderer.

/** A GPU-free fake: every "context" is a plain object whose destroy() is a spy. */
function harness() {
  const built: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const build = vi.fn((): BeltContextEntry => {
    const ctx = { destroy: vi.fn() };
    built.push(ctx);
    return ctx;
  });
  return { cache: new BeltContextCache(), build, built };
}

describe('beltContextKey - stable string join', () => {
  it('joins (kind, chirality, bucket) with pipes in a fixed order', () => {
    expect(beltContextKey('belt-corner', 'ccw', 3)).toBe('belt-corner|ccw|3');
  });

  // `61-UI-SPEC` A8 provisionally keyed a FOURTH zoom-bucket segment in, on the
  // `buildAdaptiveBezier` stale-tessellation hazard. `61-RESEARCH.md` FINDING 1 then
  // measured that Pixi 8.19's `arc()` never reaches that code path, so one fixed
  // tessellation serves the whole zoom range and the term would multiply the cache by
  // |Z| for nothing. The arity is asserted at the STRING level so re-introducing any
  // dimension reddens here instead of slipping in behind a passing suite - exactly as
  // `textureCache.test.ts` guards the removed skin dimension.
  it('produces exactly three pipe-separated segments (no zoom-bucket dimension)', () => {
    expect(beltContextKey('belt', 'none', 0).split('|')).toHaveLength(3);
  });
});

describe('BeltContextCache - one plot per key', () => {
  // Behaviour 1.
  it('plots on first get and returns the IDENTITY-same context on repeat', () => {
    const { cache, build } = harness();
    const key = beltContextKey('belt', 'none', 0);
    const a = cache.get(key, build);
    const b = cache.get(key, build);
    // Identity, not deep equality: sharing ONE tessellation across every Graphics that
    // binds it is the whole reason this class exists (the H7 spike measured that the
    // context setter adopts by identity rather than copying).
    expect(a).toBe(b);
    expect(build).toHaveBeenCalledTimes(1);
    expect(cache.created).toBe(1);
    expect(cache.destroyed).toBe(0);
    expect(cache.live).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('distinct keys yield distinct contexts', () => {
    const { cache, build } = harness();
    const a = cache.get(beltContextKey('belt', 'none', 0), build);
    const b = cache.get(beltContextKey('belt', 'none', 1), build);
    const c = cache.get(beltContextKey('belt-corner', 'cw', 0), build);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    expect(cache.created).toBe(3);
    expect(cache.live).toBe(3);
  });

  // Behaviour 2.
  it('destroyAll frees every entry, matches created, and leaves live at 0', () => {
    const { cache, build, built } = harness();
    for (const bucket of [0, 1, 2, 3]) {
      cache.get(beltContextKey('belt', 'none', bucket), build);
    }
    expect(cache.created).toBe(4);
    expect(cache.live).toBe(4);

    cache.destroyAll();

    // Every entry really was freed - not merely dropped from the map, which is the
    // leak this counter pair exists to make visible.
    for (const ctx of built) expect(ctx.destroy).toHaveBeenCalledTimes(1);
    expect(cache.destroyed).toBe(4);
    expect(cache.destroyed).toBe(cache.created);
    expect(cache.live).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('clears the map: a get after destroyAll re-plots rather than returning a freed context', () => {
    const { cache, build } = harness();
    const key = beltContextKey('belt', 'none', 0);
    const before = cache.get(key, build);
    cache.destroyAll();
    const after = cache.get(key, build);
    expect(after).not.toBe(before);
    expect(build).toHaveBeenCalledTimes(2);
    expect(cache.created).toBe(2);
    expect(cache.live).toBe(1);
  });

  // The counters must keep ACCUMULATING across a teardown, because `belts.ts
  // setPainter` reuses the same instance rather than replacing it - a fresh cache per
  // swap would silently reset the leak evidence.
  it('accumulates its counters across repeated teardowns (the setPainter contract)', () => {
    const { cache, build } = harness();
    for (let round = 1; round <= 3; round++) {
      cache.get(beltContextKey('belt', 'none', 0), build);
      cache.destroyAll();
      expect(cache.created).toBe(round);
      expect(cache.destroyed).toBe(round);
      expect(cache.live).toBe(0);
    }
  });

  it('two caches share no state (instance-scoped, never a module-global singleton)', () => {
    const a = harness();
    const b = harness();
    a.cache.get(beltContextKey('belt', 'none', 0), a.build);
    expect(a.cache.created).toBe(1);
    expect(b.cache.created).toBe(0);
    expect(b.cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE TWO-GENERATION LIFETIME (BELT-05 - plan 61-09)
// ---------------------------------------------------------------------------
//
// The RAIL family is invalidated by a QUANTUM change rather than a painter change, and
// a quantum change happens mid zoom gesture while tiles are on screen. `destroyAll` is
// the wrong shape for that: it frees FIRST, which leaves every holder pointing at freed
// geometry until the next lazy plot. `takeAll` + `release` split the operation so the
// caller can plot new, rebind every holder, and only then free the old.
describe('takeAll / release - plot new, rebind, free old', () => {
  it('empties the map WITHOUT destroying, so the old generation stays usable', () => {
    const { cache, build, built } = harness();
    cache.get('a', build);
    cache.get('b', build);
    expect(cache.size).toBe(2);

    const stale = cache.takeAll();

    expect(stale).toHaveLength(2);
    expect(cache.size, 'the map is empty, so a get() re-plots').toBe(0);
    // NOT DESTROYED. This is the whole difference from `destroyAll` and the reason the
    // rebind window is safe at all.
    for (const ctx of built) expect(ctx.destroy).not.toHaveBeenCalled();
    expect(cache.destroyed).toBe(0);
    // ... and `live` says BOTH generations are alive once a new one is plotted, which is
    // the honest reading of a counter whose whole job is to be the leak truth.
    cache.get('a', build);
    expect(cache.created).toBe(3);
    expect(cache.live).toBe(3);
  });

  it('release frees exactly what it is handed, and accounts every free', () => {
    const { cache, build, built } = harness();
    cache.get('a', build);
    cache.get('b', build);
    const stale = cache.takeAll();
    cache.get('a', build); // the new generation

    cache.release(stale);

    expect(built[0].destroy).toHaveBeenCalledTimes(1);
    expect(built[1].destroy).toHaveBeenCalledTimes(1);
    // The NEW entry is untouched - `release` frees a handed-in list, never the map.
    expect(built[2].destroy).not.toHaveBeenCalled();
    expect(cache.destroyed).toBe(2);
    expect(cache.live, 'one live context after the swap').toBe(1);
    expect(cache.size).toBe(1);
  });

  it('is a no-op on an empty cache, so a first draw needs no special case', () => {
    const { cache } = harness();
    expect(cache.takeAll()).toEqual([]);
    cache.release([]);
    expect(cache.created).toBe(0);
    expect(cache.destroyed).toBe(0);
    expect(cache.live).toBe(0);
  });

  it('leaves destroyAll able to finish the job after a take, with no double free', () => {
    // `setPainter` runs `destroyAll` and can land at any point in a draw. A generation
    // already taken is the CALLER's to free; `destroyAll` must not reach it, and must
    // not skip what is still in the map.
    const { cache, build, built } = harness();
    cache.get('a', build);
    const stale = cache.takeAll();
    cache.get('a', build);

    cache.destroyAll();

    expect(built[1].destroy).toHaveBeenCalledTimes(1); // the mapped entry
    expect(built[0].destroy).not.toHaveBeenCalled(); // the taken one, still the caller's
    cache.release(stale);
    expect(built[0].destroy).toHaveBeenCalledTimes(1);
    expect(built[0].destroy).not.toHaveBeenCalledTimes(2);
    expect(cache.live).toBe(0);
  });
});
