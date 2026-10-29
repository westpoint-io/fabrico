// The renderer-owned synth texture cache (SYNTH-02). A PixelMatrix is baked ONCE
// into a nearest-neighbor GPU texture, keyed by "kind|state|frame", and shared
// across every draw of that sprite (the bake-once-blit-many pattern proven in
// items.ts). Ownership is INSTANCE-scoped - the cache dies with the scene that
// owns it - never a module-global singleton (CONTEXT).
//
// The key used to carry a FOURTH segment naming the active skin, and this file
// used to expose a skin-swap teardown hook. SKIN-02 (v7.0, decision D-20) removed
// the theme system entirely, so there is no swap to gate and no second skin for a
// key to discriminate. The dimension was removed rather than hardcoded to the one
// shipped skin's id: a dead parameter is exactly the artifact that misleads a
// future reader into believing a swap is coming back.
//
// Teardown itself SURVIVES and is still the leak-safe path (research Pitfall 4):
// in Pixi v8 a `Texture` and its `TextureSource` are separate objects, so a bare
// `texture.destroy()` leaks the GPU-side source. `destroyAll()` calls
// `texture.destroy(true)` to free BOTH, and the app-owned `created`/`destroyed`
// counters make the no-leak accounting assertable for ordinary scene lifecycle
// (a painter change still destroys-then-lazily-repopulates through this path).

import { BufferImageSource, Texture } from 'pixi.js';
import type { PixelMatrix } from './types.ts';

/**
 * The minimal texture contract the cache owns: something destroyable, with the
 * v8 `destroy(destroySource)` shape. Real path returns a Pixi `Texture`; tests
 * inject a fake so the cache/counter logic runs GPU-free in node.
 */
export interface SynthTexture {
  destroy(destroySource?: boolean): void;
}

/** Factory that bakes one matrix into a texture (injectable for tests). */
export type MakeTexture = (m: PixelMatrix) => SynthTexture;

/**
 * Stable cache key: a fixed-order pipe join of exactly THREE segments. `kind`,
 * `state` and `frame` are bytes/ints and together uniquely identify one bake.
 *
 * A cache key is an IDENTITY string, never a pixel input - nothing downstream
 * rasterises it - so dropping the old fourth skin-naming segment (SKIN-02 / D-20)
 * cannot move a rendered byte. The 8 pixel baselines at `maxDiffPixels: 0` and
 * `channelOrder.test.ts` are the behavioural proof of that, held with no
 * regeneration. Call sites append their own extra terms (footprint, rotation,
 * LOD) AFTER this join; the segment count asserted in the unit spec is this
 * function's own, so a re-introduced dimension reddens instead of passing.
 */
export function cacheKey(kind: number, state: number, frame: number): string {
  return `${kind}|${state}|${frame}`;
}

/**
 * Bake a matrix into a nearest-neighbor Pixi v8 texture. Uses the raw-buffer
 * source path: `BufferImageSource` over the matrix's RGBA `Uint8ClampedArray`.
 *
 * IMPORTANT: BufferImageSource auto-detects a `Uint8ClampedArray` as `bgra8unorm`
 * (channel-swapped), so `format: 'rgba8unorm'` is passed EXPLICITLY to keep the
 * matrix's R,G,B,A byte order on the GPU. `scaleMode: 'nearest'` is set on the
 * SOURCE (not the sprite) so the pixels stay crisp under integer scaling
 * (research Pitfall 3). The matrix's straight alpha is premultiplied on upload
 * for correct transparent-glyph blending. The authoritative artifact remains the
 * matrix `Uint8ClampedArray`; this texture is a write-only downstream copy - never
 * read back for equality (research Pitfall 6).
 */
export function matrixToTexture(m: PixelMatrix): Texture {
  const source = new BufferImageSource({
    resource: m.data,
    width: m.width,
    height: m.height,
    format: 'rgba8unorm',
    alphaMode: 'premultiply-alpha-on-upload',
    scaleMode: 'nearest',
  });
  return new Texture({ source });
}

/**
 * A per-scene texture cache. Construct with a real Pixi bake by default; pass a
 * fake `makeTexture` to unit-test the cache/counter logic without a GPU.
 */
export class SynthTextureCache {
  /** App-owned leak counters - primary no-leak proof (managedTextures corroborates). */
  created = 0;
  destroyed = 0;

  private readonly map = new Map<string, SynthTexture>();
  private readonly makeTexture: MakeTexture;

  constructor(makeTexture: MakeTexture = matrixToTexture) {
    this.makeTexture = makeTexture;
  }

  /**
   * Return the cached texture for `key`, baking it ONCE on first request. On a
   * cache hit `makeMatrix` is not called and no second texture is created.
   */
  get(key: string, makeMatrix: () => PixelMatrix): SynthTexture {
    let tex = this.map.get(key);
    if (tex === undefined) {
      tex = this.makeTexture(makeMatrix());
      this.map.set(key, tex);
      this.created++;
    }
    return tex;
  }

  /**
   * Destroy every cached texture AND its GPU-side source, then clear the map.
   * `destroy(true)` is the Pitfall-4 fix; `destroyed` increments per entry so it
   * returns to match `created` once everything is freed.
   */
  destroyAll(): void {
    for (const tex of this.map.values()) {
      tex.destroy(true);
      this.destroyed++;
    }
    this.map.clear();
  }

  /** Live texture count (created - destroyed) - the app-owned leak truth. */
  get live(): number {
    return this.created - this.destroyed;
  }
}
