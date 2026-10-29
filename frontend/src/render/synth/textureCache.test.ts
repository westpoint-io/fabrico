import { describe, expect, it, vi } from 'vitest';
import { SynthTextureCache, cacheKey, type SynthTexture } from './textureCache.ts';
import { makeMatrix } from './types.ts';

// A GPU-free fake: every "texture" is a plain object whose destroy() is a spy,
// so the pure cache/counter logic runs in the node vitest env without Pixi.
function harness() {
  const built: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const factory = vi.fn((_m): SynthTexture => {
    const tex = { destroy: vi.fn() };
    built.push(tex);
    return tex;
  });
  const cache = new SynthTextureCache(factory);
  return { cache, factory, built };
}

const mk = () => makeMatrix(1, 1);

describe('cacheKey - stable string join', () => {
  it('joins (kind,state,frame) with pipes in a fixed order', () => {
    expect(cacheKey(2, 1, 0)).toBe('2|1|0');
  });

  // SKIN-02 / D-20: the skin dimension was REMOVED, not hardcoded to the one
  // shipped skin's id. This asserts the arity at the string level so that
  // re-introducing any dimension (a skin id, a theme, a variant) reddens here
  // instead of slipping in silently behind a passing suite.
  it('produces exactly three pipe-separated segments (no skin dimension)', () => {
    expect(cacheKey(7, 2, 5).split('|')).toHaveLength(3);
  });
});

describe('SynthTextureCache - single bake per key', () => {
  it('bakes on first get, returns the cached object on repeat (no second bake)', () => {
    const { cache, factory } = harness();
    const makeMatrixSpy = vi.fn(mk);
    const key = cacheKey(2, 0, 0);
    const t1 = cache.get(key, makeMatrixSpy);
    const t2 = cache.get(key, makeMatrixSpy);
    expect(t1).toBe(t2);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(makeMatrixSpy).toHaveBeenCalledTimes(1);
    expect(cache.created).toBe(1);
    expect(cache.destroyed).toBe(0);
  });

  it('distinct keys yield distinct textures', () => {
    const { cache } = harness();
    const a = cache.get(cacheKey(2, 0, 0), mk);
    const b = cache.get(cacheKey(2, 1, 0), mk);
    expect(a).not.toBe(b);
    expect(cache.created).toBe(2);
  });
});

describe('SynthTextureCache - clean destroy (SYNTH-02, Pitfall 4)', () => {
  it('destroyAll frees every texture WITH its source and matches created', () => {
    const { cache, built } = harness();
    cache.get(cacheKey(2, 0, 0), mk);
    cache.get(cacheKey(7, 0, 0), mk);
    expect(cache.created).toBe(2);

    cache.destroyAll();

    // destroy(true) on every entry - (true) frees the GPU-side TextureSource.
    expect(built).toHaveLength(2);
    for (const tex of built) {
      expect(tex.destroy).toHaveBeenCalledTimes(1);
      expect(tex.destroy).toHaveBeenCalledWith(true);
    }
    expect(cache.destroyed).toBe(cache.created);
    expect(cache.destroyed).toBe(2);
  });

  it('clears the map: a get after destroyAll re-bakes', () => {
    const { cache } = harness();
    cache.get(cacheKey(2, 0, 0), mk);
    cache.destroyAll();
    cache.get(cacheKey(2, 0, 0), mk);
    expect(cache.created).toBe(2);
    expect(cache.destroyed).toBe(1);
  });
});

describe('SynthTextureCache - instance-scoped ownership (no singleton)', () => {
  it('two caches share no state', () => {
    const a = harness();
    const b = harness();
    a.cache.get(cacheKey(2, 0, 0), mk);
    expect(a.cache.created).toBe(1);
    expect(b.cache.created).toBe(0);
  });
});
