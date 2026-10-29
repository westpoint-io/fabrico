// @vitest-environment jsdom
//
// `Measurement` OWNS ITS ARRAYS (phase 56 review WR-02).
//
// THE DEFECT THIS PINS. `measureContext` used to return `gpu.geometryData.vertices`
// and `.indices` BY REFERENCE. Those arrays belong to the pooled `GpuGraphicsContext`
// and are mutated in place, never replaced: `GpuGraphicsContext.reset()` does
// `geometryData.vertices.length = 0` and `buildContextBatches` refills the SAME array
// object (`GraphicsContextSystem.mjs:20-34, 96-99`). So a `Measurement` was a live view
// onto Pixi's scratch buffer wearing the shape of a snapshot.
//
// WHY IT IS WORTH A SPEC OF ITS OWN rather than a comment. Both failure modes are
// SILENT and both defeat a gate rather than the renderer:
//
//   1. Re-measuring a context rewrites every `Measurement` previously taken from it.
//      `geometryDigest.test.ts` would then hash a buffer it did not measure, and would
//      either agree with the committed digest table by accident or diverge with no
//      diagnosable cause. A digest gate reading a buffer that changed under it is the
//      exact "gate measures nothing" class every docblock in `svgAssets.ts` is written
//      against.
//   2. `getAssetContext` returns PROCESS-WIDE-SHARED contexts. A consumer treating
//      `Measurement.vertices` as its own scratch array corrupts the geometry the
//      shipped app draws from - a rendering defect authored from a test helper.
//
// Nothing in the tree triggered either path when the aliasing was found, which is
// precisely why it needed a gate: the next thing to touch this accessor is phase 57,
// and a latent defect with no test is indistinguishable from a fixed one.
//
// EVERY ASSERTION BELOW FAILED against the pre-fix implementation. That is the bar for
// a regression spec: it must be able to detect the bug it was written for, not merely
// agree with the fix.
//
// (See `vertexBudget.test.ts` for why these specs run on jsdom and for the one expected
// `getContext() ... without installing the canvas npm package` noise line.)

import { GraphicsContext } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import { measureContext, measureSvg } from '../svgAssets.ts';
import { PILOT_SVG, getPilotContext } from '../../spike/pilotFixture.ts';

/** A small, cheap context with real tessellated geometry. */
function squares(): GraphicsContext {
  return new GraphicsContext().rect(0, 0, 10, 10).fill(0xffffff);
}

describe('Measurement arrays are copies, not views onto Pixi\'s pooled buffers', () => {
  it('two measurements of the SAME context do not share array objects', () => {
    const ctx = squares();
    const first = measureContext(ctx);

    // `.rect().fill()` marks the context dirty, so the next `updateGpuContext` takes
    // the rebuild branch: `reset()` truncates the pooled arrays and
    // `buildContextBatches` refills them. Under the pre-fix code this is the exact
    // moment `first.vertices` silently became the SECOND measurement's geometry.
    ctx.rect(20, 20, 5, 5).fill(0xff0000);
    const second = measureContext(ctx);

    expect(first.vertices).not.toBe(second.vertices);
    expect(first.indices).not.toBe(second.indices);
  });

  it('a retained Measurement is unchanged by a later re-measure of its context', () => {
    const ctx = squares();
    const retained = measureContext(ctx);
    const before = [...retained.vertices];
    const beforeCount = retained.vertexCount;
    expect(beforeCount).toBeGreaterThan(0); // never assert against an empty buffer

    ctx.rect(20, 20, 5, 5).fill(0xff0000);
    const remeasured = measureContext(ctx);

    // The re-measure MUST have produced different geometry, or this spec would pass
    // vacuously on two identical buffers.
    expect(remeasured.vertexCount).toBeGreaterThan(beforeCount);

    expect(retained.vertices).toEqual(before);
    expect(retained.vertexCount).toBe(beforeCount);
  });

  it('writing into Measurement.vertices does NOT corrupt the measured context', () => {
    const m = measureSvg(PILOT_SVG);
    const original = m.vertices[0];
    expect(original).toBeDefined();

    m.vertices[0] = 999;
    m.indices[0] = 999;

    // Re-measuring the same context must report Pixi's geometry, not the scribble.
    const fresh = measureContext(m.context);
    expect(fresh.vertices[0]).toBe(original);
    expect(fresh.vertices[0]).not.toBe(999);
  });

  it('a scribble on a memoised context\'s Measurement does not reach the shared context', () => {
    // The consequence that actually reaches users: `getAssetContext` hands the SAME
    // context to every `new Graphics(...)` in the app. The pilot fixture's own memo
    // (`getPilotContext`, plan 91-03) is built the same way, so it carries the case.
    const shared = getPilotContext();
    const m = measureContext(shared);
    const original = m.vertices[0];

    m.vertices[0] = -12345;

    expect(measureContext(shared).vertices[0]).toBe(original);
    // ...and identity of the shared context itself is untouched (the memo contract).
    expect(getPilotContext()).toBe(shared);
  });
});
