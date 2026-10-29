// THE SHIPPED ITEM DOT's golden GEOMETRY digest.
//
// THE BELT HALF OF THIS FILE RETIRED WITH ITS SUBJECT (plan 61-07). Until this plan the
// file opened with the 15-entry golden BYTE digest table for the four raster belt bakes
// - born 27-entry in Phase 53 Wave 1, re-blessed to 15 at the locked K = 4 march by
// Phase 54, and re-blessed once more by plan 61-03 when `ELBOW_R` moved 15 -> 16. Plan
// 61-07 deleted all four raster bakes - the straight, the corner and the two LOD ticks -
// so there are no RGBA bytes left for that table to hash. IT IS RETIRED, NOT LOOSENED,
// and the distinction is the whole reason this
// paragraph exists: a golden table is deleted only when the artefact it pins no longer
// exists, never because it went red. The SHIPPED belt's own gate did not move - it is
// `synth/beltGeometry.digest.test.ts`, which pins all 39 vector tread slots plus the 50
// rail probes by the identical VEC-05 mechanism the block below uses.
//
// THE FILE KEEPS ITS NAME ON PURPOSE. `layers/items.ts:149` and `layers/items.test.ts`
// both name this path as the item dot's ONLY gate; renaming the file to match its now
// single subject would silently break two source comments that a reader follows to find
// that gate. One misleading filename is cheaper than two dangling references.
//
// SHA-256 is used here as a change-detection digest and it is not a security primitive.
// There is no key, no secret, no signature, and no adversary in this model - the only
// thing being detected is an accidental change in a locally-computed geometry buffer.
// A future security audit should not misread this import as a cryptographic control.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CORE_R, DOT_SIZE, SHIPPED_DOTS, dotVectorContext } from '../layers/items.ts';
import { measureContext, type Measurement } from '../svgAssets.ts';
import { LOCKED_SKIN } from './skins/locked.ts';

// The SHIPPED ITEM DOT golden digest (53-02 T3 step one; RE-BLESSED by plan 61-05).
//
// IT WAS SEPARATE FROM THE BELT ENUMERATION BY DESIGN, and it survived that
// enumeration's retirement for exactly the reason it was kept apart: the belt table's
// count was asserted against the RASTER's own family arithmetic and corroborated the
// cache-bound assertion in `belts.test.ts`, so folding a non-belt asset into it would
// have broken both. Having never been folded in, this block lost nothing when the belt
// table was deleted with its bakes (plan 61-07).
//
// WHY IT EXISTS. NO pixel baseline covers the item dot (the pixel-guard scenes are
// belt/wire/footprint), so unlike the belt bakes there is no second gate that would
// catch the default moving. This digest IS that gate (T-53-05-TAM).
//
// ===========================================================================
// PLAN 61-05 RE-BLESS: WHAT IS HASHED CHANGED, NOT MERELY ITS VALUE.
// ===========================================================================
//
// It was ruled (61-CONTEXT.md H5) that `items.ts` converts to vector this phase. The dot
// is now two concentric circles rasterised per zoom bucket, so **there are no RGBA
// bytes left to hash** and the old value ('868750018fb82e4e', over a 10x10
// `Uint8ClampedArray`) pins an artifact that no longer exists.
//
// The gate therefore MOVES rather than loosens: it now digests the dot's TESSELLATED
// vertex and index buffers, which is the identical VEC-05 mechanism
// `synth/beltGeometry.digest.test.ts` locks all 39 belt slots with. Same discipline as
// every re-bless in this tree - the value is GENERATED (via a temporary dump, never
// hand-authored), nothing is deleted, no count is relaxed, and it lands in the SAME
// COMMIT as the change that broke it, because this file's own header records that this
// is the dot's ONLY gate and a gap of even one commit would leave it gateless.
//
// WHAT THE NEW DIGEST DOES NOT SEE, stated so its green is not over-read: geometry
// only. Colour, alpha and draw ORDER are invisible to it - a digest over
// `geometryData` sees vertices and indices and nothing else. Those are pinned in
// `layers/items.test.ts` (the two constant alphas, the accent, and the
// ring-under-core precedence), and the pair is deliberately complementary: this file
// says the SHAPE did not move, that file says the LOOK did not.
// ---------------------------------------------------------------------------

/**
 * The geometry digest of one measured context.
 *
 * COPIED VERBATIM from `synth/beltGeometry.digest.test.ts`, which copied it verbatim
 * from `render/assets/geometryDigest.test.ts`. Every contract travels with it, because
 * a contract that travels without its reasons stops being a contract: a 1/256 unit
 * quantum (far below a device pixel, so float noise dies and a real geometry change
 * cannot hide), `Math.round`'s HALF-UP asymmetry as the recorded rounding contract, a
 * little-endian uint32 vertex-byte-length prefix so the vertex/index split is
 * unambiguous, and the platform note that a big-endian host would need a re-bless.
 */
function digestOfMeasurement(m: Measurement): string {
  const vertices = Float32Array.from(m.vertices, (v) => Math.round(v * 256) / 256);
  const indices = Uint32Array.from(m.indices);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(vertices.byteLength, 0);
  return createHash('sha256')
    .update(prefix)
    .update(Buffer.from(vertices.buffer, vertices.byteOffset, vertices.byteLength))
    .update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength))
    .digest('hex');
}

describe('the shipped item dot is pinned to a golden GEOMETRY digest (VEC-01)', () => {
  /** The shipped dot's vector geometry, exactly as `createItemLayer` builds it at boot. */
  const shippedDot = (): Measurement => measureContext(dotVectorContext(LOCKED_SKIN));

  it('matches the golden tessellated-geometry digest of the shipped amber dot', () => {
    expect(
      digestOfMeasurement(shippedDot()),
      'the item dot GEOMETRY changed. The dot has NO pixel baseline covering it, so this ' +
        'digest is the only gate on its shape. If a spec default that was supposed to ' +
        'reproduce the shipped dot does NOT, fix the spec, never this value. If this is a ' +
        'deliberate look change, re-bless it in the SAME commit as the change, alongside ' +
        'the alpha/accent/draw-order assertions in layers/items.test.ts.',
    ).toBe('08abae282af7c7cd5133a7ccf974098a09f3ab4a8dcd7f32c26c5ee26eda926f');
  });

  it('is NON-EMPTY and inside the VEC-04 batch budget', () => {
    // A procedural builder fails silently by producing nothing: zero geometry draws
    // nothing, throws nothing, and sails under every budget by being under all of
    // them. Without this the digest above would happily pin the digest of an empty
    // buffer. `isBatchable` is read back off Pixi's own answer, never re-derived from
    // a mirrored `< 400` threshold.
    const m = shippedDot();
    expect(m.vertexCount).toBeGreaterThan(0);
    expect(m.isBatchable, 'the dot must stay batchable or the single-batch property dies').toBe(
      true,
    );
  });

  it('pins the LOCKED four numbers the geometry is authored from', () => {
    // The digest sees vertices, so it cannot say WHY they are where they are. These
    // three lines are what make the golden readable: the locked 4.8px outer diameter,
    // the 10px box, and the ringless spec (53-BELT-LOCK.md axis 5).
    expect(2 * CORE_R).toBeCloseTo(4.8, 9);
    expect(SHIPPED_DOTS.matrix).toBe(DOT_SIZE);
    expect(SHIPPED_DOTS.glowR).toBe(0);
  });

  it('is reproducible: two measurements yield identical digests', () => {
    expect(digestOfMeasurement(shippedDot())).toBe(digestOfMeasurement(shippedDot()));
  });
});
