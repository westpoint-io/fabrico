// WAVE 0 SPIKE, KEPT (plan 61-01 task 1, CONTEXT H7 / 61-RESEARCH Assumptions Log A1).
//
// THE QUESTION. `61-RESEARCH.md` read Pixi 8.19's tessellation and path APIs but never
// EXERCISED the `Graphics.context = ctx` setter as a LIVE swap on an already-constructed
// instance. The whole vector belt rewrite is written against the assumption that it works:
// `belts.ts:628`'s per-frame `(children[i] as Sprite).texture = t` becomes
// `(children[i] as Graphics).context = ctx`, and the frame-free `geoKey` at `belts.ts:577-598`
// exists precisely so no tile is destroyed/recreated per animation frame. If the setter is
// NOT a live swap, the per-frame path degrades to `new Graphics(ctx)` per bucket change -
// which is the exact Sprite-churn regression the geoKey design was built to prevent.
//
// THIS FILE IS KEPT, NOT THROWN AWAY. A spike that answers a question and then deletes its
// evidence leaves the next Pixi bump free to re-open the question silently. These three
// assertions are the regression lock on the property plan 61-02 spends its per-frame budget
// on. The verdict string they produced is recorded in
// `61-SPIKE-FINDINGS.md` (internal design notes).
//
// NODE ENVIRONMENT, DELIBERATELY - this file carries NO jsdom environment docblock, and
// the token that would request one is deliberately not written anywhere in it (vitest
// regex-scans the leading comments for that pragma, so even naming it in prose silently
// flips the whole file into jsdom - observed while writing this spike). A PROCEDURALLY
// built `GraphicsContext` (`.rect()` / `.fill()`) never touches the DOM;
// only `GraphicsContext.svg()` does, because that runs Pixi's `SVGParser` through
// `document.createElement` (`svgAssets.ts:359-372` records exactly that split). The belt
// tread is procedural by decision (CONTEXT section A: the per-tile dash offset cannot be
// expressed by an SVG asset file), so the shipped path is the DOM-free one and this spike
// measures the shipped path.
//
// NO NODE BUILTIN CRYPTO IMPORT HERE either (the same token discipline as above - the
// module specifier is deliberately not written in this file). The reason is the one
// `svgAssets.ts:28-32` records: this directory is browser-bundle territory, and the SHA-256
// digest helpers live in their own spec files rather than beside the modules they measure.
// This spike compares vertex buffers directly, so it needs no hash at all.

import { describe, expect, it } from 'vitest';
import { Graphics, GraphicsContext } from 'pixi.js';
import { measureContext } from '../svgAssets';

/**
 * Two DISTINCT procedural contexts standing in for two march-phase buckets of the same
 * belt tile. They differ in `rect` geometry rather than in colour, because the thing under
 * test is the tessellated VERTEX BUFFER: a colour-only difference would leave both buffers
 * byte-identical and the "geometry actually moved" assertion would pass on nothing.
 *
 * Built fresh per call rather than shared at module scope: `measureContext` sets
 * `context.dirty = true` on its way in (`svgAssets.ts:343-346`), so a shared fixture would
 * make one test's measurement observable from another's.
 */
function ctxA(): GraphicsContext {
  return new GraphicsContext().rect(0, 0, 32, 2).fill(0x8899aa);
}

function ctxB(): GraphicsContext {
  // Two rects, not one: B must tessellate to a strictly different buffer AND a different
  // vertex COUNT, so a swap that silently kept A's geometry cannot pass by coincidence.
  return new GraphicsContext().rect(0, 10, 6, 2).fill(0x8899aa).rect(12, 10, 6, 2).fill(0x8899aa);
}

/** A non-default orientation + position, the two per-tile properties MOTION-05 and FLOW-06 own. */
const ROTATION = Math.PI / 2;
const POSITION = { x: 48.5, y: -16.25 };

describe('H7: Graphics.context is a LIVE swap on an existing instance', () => {
  it('takes the new context geometry and drops the old, measured through measureContext', () => {
    const a = ctxA();
    const b = ctxB();
    const g = new Graphics(a);

    const mA = measureContext(a);
    const mB = measureContext(b);
    // Non-vacuity: if the two fixtures tessellated the same, everything below would pass
    // whether or not the setter did anything at all.
    expect(mA.vertexCount, 'the two fixture contexts must differ, or this whole file is vacuous')
      .not.toBe(mB.vertexCount);

    g.context = b;

    const after = measureContext(g.context);
    expect(after.vertices, 'after the assignment the instance must measure as B').toEqual(mB.vertices);
    expect(after.indices).toEqual(mB.indices);
    expect(after.vertices, 'after the assignment the instance must NOT still measure as A')
      .not.toEqual(mA.vertices);
    // Identity, not deep equality: the setter must ADOPT the passed context, not copy it.
    // A copy would defeat the whole "one shared GraphicsContext per (kind, chirality,
    // phaseBucket)" cache design (VEC-04, `svgAssets.ts:10-18`).
    expect(g.context).toBe(b);

    // The context that was swapped AWAY is untouched and still measurable - the setter must
    // not destroy it. The cache owns that lifetime and frees it through `destroyAll()`
    // (Pattern 5 / `belts.ts:664` setPainter), never as a side effect of a per-frame swap.
    expect(measureContext(a).vertices, 'the swapped-away context must survive the swap')
      .toEqual(mA.vertices);
  });

  it('preserves rotation and position BYTE-EQUAL across the assignment', () => {
    // This is the property that makes the swap worth having. MOTION-05 is bake-once /
    // rotate-many: a corner tile's orientation is a whole-instance 90-degree rotation
    // (`cornerQuarterTurns`), never a re-plot. FLOW-06 snaps each tile's position onto the
    // whole-device-pixel grid and only re-runs that pass on a quantum change
    // (`belts.ts:636-645`). If either were reset by the context assignment, every per-frame
    // march would silently un-rotate and un-snap the whole lane.
    const g = new Graphics(ctxA());
    g.rotation = ROTATION;
    g.position.set(POSITION.x, POSITION.y);

    g.context = ctxB();

    // `toBe` on numbers is Object.is - exact, no epsilon. A "close enough" comparison here
    // would accept a re-derived value, and FLOW-06's whole point is that the value is exact.
    expect(g.rotation).toBe(ROTATION);
    expect(g.position.x).toBe(POSITION.x);
    expect(g.position.y).toBe(POSITION.y);
  });

  it('lets ONE context be bound by two Graphics at once, and survives one of them being destroyed', () => {
    // The cache design shares a single `GraphicsContext` across every tile drawing that
    // (kind, chirality, phaseBucket). A belt run is many tiles at the same bucket, so
    // "many instances, one context" is the common case, not an edge case.
    const shared = ctxB();
    const expected = measureContext(shared);

    const g1 = new Graphics(shared);
    const g2 = new Graphics(shared);

    expect(g1.context).toBe(shared);
    expect(g2.context).toBe(shared);
    expect(measureContext(g1.context).vertices).toEqual(expected.vertices);
    expect(measureContext(g2.context).vertices).toEqual(expected.vertices);

    // A bare `destroy()` on an instance holding an EXTERNAL context must not take the
    // context with it (`Graphics.destroy` only frees `_ownedContext`, or `_context` when
    // explicitly asked via `destroy(true)` / `destroy({ context: true })`). This is what
    // lets `belts.ts`'s per-belt teardown drop roots freely while the cache keeps owning
    // the contexts - and it is the exact ordering Pattern 5 / Pitfall 4 depend on.
    g1.destroy();

    expect(measureContext(g2.context).vertices, 'destroying one holder must not free the shared context')
      .toEqual(expected.vertices);
  });
});
