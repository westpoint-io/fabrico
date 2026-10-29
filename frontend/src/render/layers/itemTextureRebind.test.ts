// @vitest-environment jsdom
//
// WAVE 0 SPIKE, KEPT (plan 61-01 task 2, CONTEXT H5).
//
// THE QUESTION. The maintainer ruled that `items.ts` converts to vector this phase, and the pattern
// mapper then found the route is CONSTRAINED in a way the maintainer did not approve because it was not
// known when the ruling was made: `items.ts:4` mandates a `ParticleContainer` (only the particle batch
// path holds thousands of dots at 60fps), and a `Particle` binds a `Texture`, NOT a
// `GraphicsContext`. So the dot cannot be drawn as vector the way the belt tread can. The
// intended route is to keep the container and generate the dot `Texture` by rendering
// resolution-independent vector geometry into a RenderTexture per zoom bucket - which needs
// the texture to be RE-BOUND on a bucket change, adjacent to the exact operation
// `items.ts:283` records as already tried and crashing ("destroy+rebake ... binds a freed
// source on the next frame -> null GPU resource").
//
// THE PRE-NAMED FALLBACK, from CONTEXT H5, is to bake the dot ONCE at the highest supported
// zoom bucket and let Pixi downsample - strictly better than today, which upsamples from a
// 4.8px native bake - without touching the particle lifetime at all. Case 5 below asserts
// that fallback is real rather than assumed, so it is a route and not a hope.
//
// WHY jsdom AND NOT bare node, a DELIBERATE DEVIATION from the plan's wording, recorded here
// rather than left to be rediscovered. The plan asked for a node-environment file using the
// `FAKE_RENDERER` shape from `svgAssets.ts:233`. That shape is sufficient to TESSELLATE, but
// not to run the real particle pipe: `new ParticleContainerPipe(...)` eagerly constructs a
// `ParticleShader`, which goes `GlProgram.from` -> `getMaxFragmentPrecision` ->
// `getTestContext` -> `DOMAdapter.createCanvas()` and throws `document is not defined` under
// bare node (observed, not assumed). The choice was therefore between running the REAL
// `ParticleContainerPipe.execute` under jsdom, or hand-assembling a node-side replica of its
// body. This project's stated discipline (`svgAssets.ts:290-302`: never mirror the branch,
// read Pixi's own answer back) makes the real pipe the stronger evidence, so jsdom wins and
// the deviation is written down. jsdom logs one "HTMLCanvasElement's getContext() ... not
// implemented" notice per run; that is the shader falling back to its default precision and
// is harmless - no case below reads anything from a GL context.
//
// WHAT THIS FILE CANNOT ANSWER, stated so nobody reads its green as more than it is. There is
// no GL here, so it does NOT prove that `renderer.generateTexture` rasterises the dot's vector
// geometry to the right PIXELS. It proves the LIFETIME and BIND question - which is the whole
// of the H5 unknown - plus that the dot's vector geometry exists, tessellates non-empty and
// sits inside the VEC-04 budget. The pixel half is plan 61-05's own gate, and CONTEXT H5 is
// explicit that the gate there is the LOOK.
//
// ===========================================================================
// PLAN 61-05 SHIPPED THE VERDICT, AND ONE HELPER HERE IS NOW HISTORY.
// ===========================================================================
//
// The `shippedBake()` helper used to reproduce the SHIPPED dot exactly, by calling `paintItemDot`
// into a matrix and uploading it. Plan 61-05 retired `paintItemDot` with the matrix it
// painted, so that call no longer exists and the helper is renamed {@link retiredBake}
// to say what it is: a stand-in for A PREVIOUSLY-BOUND TEXTURE. **Nothing this file
// asserts depended on its PIXELS** - every case below is about lifetime and binding, so
// the swap-away-from texture only has to be a real, live, correctly-sized `Texture` -
// and that is why the retirement costs this probe no coverage. Its native extent
// (`DOT_SIZE`) is still the honest figure for what shipped before 61-05, which is what
// case 5's "strictly better than today" comparison is measured against.
//
// CASE 5 IS NOW HISTORICAL AND IS KEPT DELIBERATELY. The bake-once fallback was NOT
// taken - the verdict above selected the per-bucket route and plan 61-05 built it - but
// the case measures the ceiling arithmetic (`DOT_SIZE * MAX_ZOOM * MAX_SUPPORTED_DPR`
// = 80) that the SHIPPED `DOT_ZOOM_BUCKETS` ladder now derives its top bucket from. It
// is a live pin on that number, not a monument to a road not taken.

import { describe, expect, it } from 'vitest';
import {
  GraphicsContext,
  Matrix,
  Particle,
  ParticleContainer,
  ParticleContainerPipe,
  RenderTexture,
  Texture,
} from 'pixi.js';
import { MAX_ZOOM } from '../camera';
import { assertVertexBudget, measureContext } from '../svgAssets';
import { matrixToTexture } from '../synth/textureCache';
import { LOCKED_SKIN } from '../synth/skins/locked';
import { makeMatrix } from '../synth/types';
import {
  CORE_R,
  DOT_SIZE,
  SHIPPED_DOTS,
  dotVectorContext as shippedDotVectorContext,
} from './items';

/**
 * The highest device-pixel ratio this milestone budgets for, as a STATED constant with a
 * reason rather than a number pulled from the air. The shipped DPR baselines cover 1, 1.5, 2
 * and a fractional 1.77 case (`59-03`'s four `dpr-crispness` buckets), so 2 is the ceiling
 * the tree actually carries evidence for. If a future phase supports a 3x display this number
 * moves and case 5's ceiling moves with it - which is exactly why it is one named constant
 * and not an inline literal in three places.
 */
const MAX_SUPPORTED_DPR = 2;

/**
 * The largest number of DEVICE pixels the dot's native box can ever occupy: its native world
 * box at the highest zoom on the densest display.
 *
 * `itemDotGrow` (`items.ts:78`) does NOT push past this. Below zoom 1 it grows the dot in
 * WORLD units so its on-screen size holds - the two effects cancel - and it is capped at
 * `(0.4 * CELL) / CORE_R` = 5.333. At the floor zoom 0.25 the grow is `1 / 0.25` = 4, giving
 * `10 * 4 * 0.25 * 2` = 20 device px, well under the ceiling. At zoom >= 1 the grow is 1, so
 * the maximum is at MAX_ZOOM: `10 * 4 * 2` = 80.
 */
const MAX_DEVICE_EXTENT_PX = DOT_SIZE * MAX_ZOOM * MAX_SUPPORTED_DPR;

/**
 * The fake renderer the real `ParticleContainerPipe` is driven against.
 *
 * Written in the same documented-argument style as `svgAssets.ts:233`'s `FAKE_RENDERER`:
 * every field is here for a NAMED reason, so a Pixi bump that touches one fails with a
 * locatable cause rather than a bare TypeError.
 *
 * - `uid` keys `renderable._gpuData[renderer.uid]`, where the pipe stores the
 *   `ParticleBuffer` it builds. NEGATIVE on purpose, exactly as `svgAssets.ts` does it:
 *   Pixi's own `uid()` counter only issues non-negative integers, so a probe can never
 *   collide with a live renderer's slot.
 * - `gc.addResourceHash` is called by `GCManagedHash`'s constructor, which the pipe builds
 *   eagerly. A bare `{}` renderer throws inside the constructor.
 * - `globalUniforms.globalUniformData` is read by `execute` for the pan offset, the
 *   projection matrix and the resolution. Identity values: this probe asserts nothing about
 *   where the quad lands on screen.
 * - `_roundPixels` is OR-ed with the container's own flag into the `uRound` uniform.
 */
const FAKE_RENDERER = {
  uid: -1,
  _roundPixels: 0,
  limits: { maxBatchableTextures: 16 },
  gc: { now: 0, addResourceHash(): void {} },
  globalUniforms: {
    globalUniformData: {
      offset: { x: 0, y: 0 },
      projectionMatrix: new Matrix(),
      resolution: [1, 1],
    },
  },
};

/** One `TextureSource` the pipe bound on one pass, recorded in order. */
type BoundSource = { destroyed?: boolean; pixelWidth?: number } | null;

/**
 * A driveable stand-in for one render pass over a `ParticleContainer`.
 *
 * `pipe.execute(container)` is the REAL Pixi function. The only thing replaced is the
 * backend adaptor, and it performs the SAME single line the shipped GL adaptor performs
 * (`GlParticleContainerAdaptor.mjs:7`: `shader.resources.uTexture = container.texture._source`)
 * before recording what was bound. Everything a freed source could trip over is therefore
 * real code: `execute` itself dereferences `container.texture._source` through
 * `getAdjustedBlendModeBlend`, and the real `ParticleBuffer.update` re-uploads each
 * particle's quad from `p.texture`.
 */
function harness(pc: ParticleContainer): {
  pass: () => BoundSource;
  /** The REAL pipe, so a case can read the bind group the recorded crash nulls. */
  pipe: { defaultShader: { groups: Record<number, { resources: unknown }> } };
} {
  const bound: BoundSource[] = [];
  const adaptor = {
    execute(pipe: { defaultShader: { resources: Record<string, unknown> } }, c: ParticleContainer) {
      const shader = (c as { shader?: { resources: Record<string, unknown> } }).shader ?? pipe.defaultShader;
      const source = (c.texture as unknown as { _source: BoundSource })._source;
      shader.resources.uTexture = source;
      bound.push(source);
    },
  };
  const pipe = new ParticleContainerPipe(FAKE_RENDERER as never, adaptor as never);
  return {
    pipe: pipe as unknown as { defaultShader: { groups: Record<number, { resources: unknown }> } },
    pass: (): BoundSource => {
      pipe.execute(pc as never);
      return bound[bound.length - 1] ?? null;
    },
  };
}

/**
 * The RETIRED pre-61-05 dot texture, at its true native extent: one `DOT_SIZE` square
 * matrix uploaded as a texture. It is the "previously-bound texture" every case below
 * swaps away from, and none of them reads a pixel of it - see the module header's
 * 61-05 note for why the retirement of `paintItemDot` costs this probe no coverage.
 */
function retiredBake(): Texture {
  return matrixToTexture(makeMatrix(SHIPPED_DOTS.matrix, SHIPPED_DOTS.matrix));
}

/**
 * The dot as RESOLUTION-INDEPENDENT VECTOR GEOMETRY - the thing VEC-01 is actually about.
 *
 * THIS PROBE BUILT ITS OWN TWO-CIRCLE CONTEXT WHEN IT RAN (there was nothing to import: the
 * conversion had not happened yet). Plan 61-05 shipped that geometry as
 * `items.ts dotVectorContext`, so the local copy is DELETED and this file now measures the
 * SHIPPED builder. That is strictly stronger - a probe measuring its own replica of the thing
 * would keep passing after the real one drifted - and it is why the local copy went rather
 * than being kept beside its shipped twin.
 *
 * The two constant alphas, the ring-first draw order and the ringless locked spec are all
 * documented at the shipped function.
 */
function dotVectorContext(spec = SHIPPED_DOTS): GraphicsContext {
  return shippedDotVectorContext(LOCKED_SKIN, spec);
}

/**
 * A RenderTexture sized to the dot's native world box at a stated device resolution.
 *
 * `RenderTexture.create` allocates a `TextureSource` with no GL upload, so it constructs
 * headlessly and its `pixelWidth` (`width * resolution`) is the real native extent the
 * renderer would sample from. That is the number case 5 gates on.
 */
function dotRenderTexture(resolution: number): RenderTexture {
  return RenderTexture.create({
    width: DOT_SIZE,
    height: DOT_SIZE,
    resolution,
    // Held OFF, matching the three shipped sites. The maintainer judged antialias-on and rejected it
    // (2026-07-31); STATE is explicit that byte-exactness surviving is NOT sufficient
    // grounds to relax it.
    antialias: false,
  });
}

/** Bind a texture as the container's shared texture AND as every particle's texture. */
function bindAll(pc: ParticleContainer, particles: Particle[], texture: Texture): void {
  pc.texture = texture;
  for (const p of particles) p.texture = texture;
  // Forces the STATIC attribute buffer to re-upload. Without it the per-particle quad
  // extents stay at the previous texture's size - see case 4, which is the whole reason
  // this helper swaps both halves instead of just the container's.
  pc.update();
}

/** A container with `n` particles already bound to `texture`, in the shipped configuration. */
function container(texture: Texture, n = 3): { pc: ParticleContainer; particles: Particle[] } {
  const pc = new ParticleContainer({
    // Byte-identical to `items.ts:271-273`.
    dynamicProperties: { position: true, color: false, rotation: false, scale: true },
  });
  const particles = Array.from(
    { length: n },
    () => new Particle({ texture, anchorX: 0.5, anchorY: 0.5, scaleX: 1, scaleY: 1 }),
  );
  pc.texture = texture;
  for (const p of particles) pc.addParticle(p);
  return { pc, particles };
}

describe('H5: the item dot texture can be re-bound on a live ParticleContainer', () => {
  it('replaces the shared texture with one sized from vector geometry, and still binds a live source', () => {
    // The vector half is REAL, asserted before anything is bound: the two-circle dot
    // tessellates non-empty and sits inside the VEC-04 budget. `assertVertexBudget` is the
    // shipped gate and it THROWS on zero geometry, which is the vacuous pass that would
    // otherwise sail under every threshold by drawing nothing.
    const vector = measureContext(dotVectorContext());
    assertVertexBudget('item-dot/vector', vector);
    expect(vector.vertexCount).toBeGreaterThan(0);
    expect(vector.isBatchable, 'the dot must stay batchable or the single-batch property dies').toBe(true);

    const old = retiredBake();
    const { pc, particles } = container(old);
    const h = harness(pc);

    const before = h.pass();
    expect(before, 'the pre-swap bind must be the outgoing texture').toBe(
      (old as unknown as { _source: BoundSource })._source,
    );

    const next = dotRenderTexture(MAX_ZOOM * MAX_SUPPORTED_DPR);
    bindAll(pc, particles, next);

    const after = h.pass();
    expect(after, 'the bind must have moved to the new texture').toBe(
      (next as unknown as { _source: BoundSource })._source,
    );
    expect(after, 'a bind of a null source is the items.ts:283 crash').not.toBeNull();
    // `destroyed` is the LIVENESS SIGNAL, and it is deliberately the only one asserted.
    // `TextureSource.destroy()` sets `destroyed = true` and nulls `resource`, so a freed
    // source is caught by this flag whatever kind it is. Asserting `resource` instead would
    // be WRONG here rather than merely redundant: a live `RenderTexture` source legitimately
    // has NO CPU-side resource (measured: `undefined`), because it is a GPU render target.
    // That assertion was written first, failed against a perfectly healthy texture, and is
    // recorded here so it is not re-added.
    expect(after?.destroyed, 'the newly bound source must be live').toBeFalsy();
    expect(after?.pixelWidth, 'the newly bound source must carry the high-resolution extent')
      .toBe(MAX_DEVICE_EXTENT_PX);
  });

  it('frees the replaced-away texture only AFTER the swap, and the bound source survives it', () => {
    const old = retiredBake();
    const { pc, particles } = container(old);
    const h = harness(pc);
    h.pass();

    const next = dotRenderTexture(MAX_ZOOM * MAX_SUPPORTED_DPR);
    bindAll(pc, particles, next);

    // TWO passes BEFORE the free and TWO AFTER, because the recorded crash surfaced on the
    // frame AFTER the free, not on the free itself. A single post-free pass would be a
    // weaker claim than the defect deserves.
    h.pass();
    h.pass();

    old.destroy(true);
    // `Texture.destroy(true)` nulls the texture's own `source` - the exact state the crash
    // binds. Asserted so the free below is known to have really happened.
    expect((old as unknown as { source: unknown }).source).toBeNull();

    for (const label of ['first', 'second']) {
      const source = h.pass();
      expect(source, `${label} post-free pass must still bind a source`).not.toBeNull();
      expect(source?.destroyed, `${label} post-free pass bound a destroyed source`).toBeFalsy();
      expect(source, `${label} post-free pass must bind the NEW texture`).toBe(
        (next as unknown as { _source: BoundSource })._source,
      );
    }
  });

  it('NON-VACUITY: the reverse order (free first) reproduces the recorded items.ts:283 crash', () => {
    // Without this case the one above proves nothing: a harness that could not fail on a
    // freed source would report the cleanest green in the file for a route that crashes in
    // the app. This is the control that makes the ordering the FINDING rather than a habit.
    const old = retiredBake();
    const { pc } = container(old);
    const h = harness(pc);
    h.pass();

    old.destroy(true); // free FIRST - the order items.ts:283 records as already tried

    expect(
      () => h.pass(),
      'freeing before rebinding must still break - if it does not, the ordering above is vacuous',
    ).toThrow(TypeError);
    expect((pc.texture as unknown as { _source: unknown })._source).toBeNull();
  });

  it('quads follow each PARTICLE texture, so a bucket rebind must move both halves and free last', () => {
    // Found while probing, and load-bearing for plan 61-05 in three separate ways.
    // `container.texture._source` is only the SAMPLER; the per-particle quad corners
    // (`aVertex`) are built from `p.texture.orig` into the STATIC attribute buffer. So the
    // container's texture and the particles' textures are two DIFFERENT bindings that a
    // rebind has to keep in step.
    const old = retiredBake();
    const { pc, particles } = container(old);
    const h = harness(pc);
    h.pass();

    const buffers = (pc as unknown as { _gpuData: Record<number, { staticAttributeBuffer: { float32View: Float32Array } }> })
      ._gpuData[FAKE_RENDERER.uid];
    const snapshot = (): number[] => Array.from(buffers.staticAttributeBuffer.float32View.slice(0, 32));
    const atOld = snapshot();

    // (1) THE ACTUAL ROUTE IS SIZE-SAFE BY CONSTRUCTION, and this is the good news.
    // A per-zoom-bucket RenderTexture varies `resolution`, never `width`/`height`, so its
    // `orig` stays at DOT_SIZE and the drawn quads do NOT move on a bucket change. The dot
    // gets more native pixels and the SAME world footprint - which is exactly the "the LOOK
    // must not change, only the representation" rule CONTEXT H5 sets.
    const perBucket = dotRenderTexture(MAX_ZOOM * MAX_SUPPORTED_DPR);
    expect(perBucket.orig.width, 'a higher-resolution RenderTexture must keep its LOGICAL size')
      .toBe(DOT_SIZE);
    bindAll(pc, particles, perBucket);
    h.pass();
    expect(snapshot(), 'a per-bucket resolution change must NOT move the drawn quads').toEqual(atOld);

    // (2) NON-VACUITY for (1): the quads DO move when the logical size changes, and they move
    // on the PARTICLE swap, not on the container swap. Without this leg, (1) would pass just
    // as happily against a buffer nothing ever re-uploads.
    const wider = matrixToTexture(makeMatrix(DOT_SIZE * 4, DOT_SIZE * 4));
    pc.texture = wider;
    pc.update();
    h.pass();
    expect(snapshot(), 'the CONTAINER texture alone does not size the quads').toEqual(atOld);
    for (const p of particles) p.texture = wider;
    pc.update();
    h.pass();
    expect(snapshot(), 'the PARTICLE textures are what size the quads').not.toEqual(atOld);

    // (3) A PARTICLE LEFT HOLDING A FREED TEXTURE BREAKS TOO, and it breaks LOUDLY. Moving
    // the container off `wider` is not enough to make `wider` safe to free while particles
    // still point at it: the next static upload reads `p.texture.uvs` through the texture
    // matrix `destroy()` nulled. So "free last" is a rule about BOTH bindings, not just the
    // container's - and a plan that forgets it gets a TypeError rather than a wrong picture.
    pc.texture = perBucket;
    pc.update();
    wider.destroy(true);
    expect(
      () => h.pass(),
      'a particle still holding a freed texture must break on the next static upload',
    ).toThrow(TypeError);
  });

  it('FALLBACK: a bake-once-at-the-highest-bucket texture downsamples where today upsamples', () => {
    // CONTEXT H5's pre-named fallback, asserted so it is a route rather than a hope. The
    // claim is not "this is as good as per-bucket" - it is "this is strictly better than
    // today and touches no particle lifetime at all".
    const atMax = dotRenderTexture(MAX_ZOOM * MAX_SUPPORTED_DPR);

    expect(
      atMax.source.pixelWidth,
      'the bake-once texture must be at least the device extent implied by the highest bucket, ' +
        'so the renderer DOWNSAMPLES at every zoom below it rather than upsampling at the top',
    ).toBeGreaterThanOrEqual(MAX_DEVICE_EXTENT_PX);
    expect(atMax.source.pixelHeight).toBeGreaterThanOrEqual(MAX_DEVICE_EXTENT_PX);

    // The comparison that makes the sentence "strictly better than today" a measurement.
    const today = retiredBake();
    expect(
      today.source.pixelWidth,
      "the retired bake must be smaller than the ceiling - if it were not, there would be nothing to fix",
    ).toBeLessThan(MAX_DEVICE_EXTENT_PX);
    expect(atMax.source.pixelWidth).toBeGreaterThan(today.source.pixelWidth);

    // And the numbers themselves, pinned so a future reader sees the size of the gap rather
    // than a relational claim: 10 native px stretched to 80 device px is an 8x upsample.
    expect(today.source.pixelWidth).toBe(DOT_SIZE);
    expect(MAX_DEVICE_EXTENT_PX).toBe(80);
    expect(CORE_R * 2).toBe(4.8); // the locked outer diameter, unchanged by either route
  });
});

// ===========================================================================
// THE GATE THAT WAS MISSING, ADDED WITH THE FIX IT WOULD HAVE CAUGHT.
// ===========================================================================
//
// Every case above models a rebind as "swap the JS references, THEN take some passes,
// THEN free". Case 2 takes TWO passes between the swap and the free, and those passes
// are what made it green: a pass is the only thing that moves the SHADER's binding, and
// once the shader no longer holds the outgoing source, freeing it is harmless.
//
// THE SHIPPED LAYER TOOK ZERO PASSES BETWEEN THE SWAP AND THE FREE. `rebindTo` ran
// entirely inside `items.draw()`, and the loop calls `draw()` BEFORE the renderer's own
// ticker listener, so the outgoing source was still the one parked in the shader at the
// instant it was freed - at every possible ordering of `rebindTo`'s three statements.
// That is why the ordering the block above gates was never the property that mattered,
// and why the fix deletes the free instead of moving it.
//
// This block drives the SAME real `ParticleContainerPipe` and the SAME real
// `ParticleShader` as the rest of the file, with the pass removed. It fails on the
// pre-fix shape and passes on the shipped one.
describe('REGRESSION: freeing a source that is STILL BOUND kills the particle shader', () => {
  it('destroys the shader bind group, so the NEXT pass throws even with a live texture', () => {
    const outgoing = dotRenderTexture(1);
    const { pc, particles } = container(outgoing);
    const h = harness(pc);

    // One pass parks the outgoing source in the shader's bind group - exactly what
    // `GlParticleContainerAdaptor.execute` does on every real frame.
    expect(h.pass()).toBe((outgoing as unknown as { _source: BoundSource })._source);

    // The bind group that now holds it. Read BEFORE the free so the assertion below is
    // about this specific object rather than about whatever is there afterwards.
    const held = Object.values(h.pipe.defaultShader.groups).find(
      (g) => g.resources !== null && Object.values(g.resources as object).includes(
        (outgoing as unknown as { _source: unknown })._source,
      ),
    );
    expect(held, 'the outgoing source must really be bound, or this case proves nothing').toBeDefined();

    // The pre-fix rebind: swap BOTH JS bindings to a live texture and free the outgoing
    // one, with NO pass in between. This is `items.ts rebindTo` before the fix, verbatim
    // in shape.
    const fresh = dotRenderTexture(4);
    bindAll(pc, particles, fresh);
    outgoing.destroy(true);

    // THE MECHANISM, NAMED. `TextureSource.destroy()` -> `unload()` -> `emit('change')`
    // -> `BindGroup.onResourceChange` -> `if (resource.destroyed) this.destroy()` ->
    // `this.resources = null`. The bind group belongs to the particle pipe's
    // PER-RENDERER `defaultShader`, so this is not local damage to one container.
    expect(held?.resources, 'a bound source freed under it destroys the whole bind group').toBeNull();

    // ... and the consequence: the next pass throws while writing a perfectly live
    // texture, because the group it writes THROUGH is gone. In the app this threw from
    // inside `Application.render`, a Ticker listener, and `Ticker._tick` only re-requests
    // its animation frame after `update()` returns - so the render loop stopped for good
    // and the board froze on the partial frame the exception interrupted.
    expect(
      (pc.texture as unknown as { _source: { destroyed?: boolean } })._source.destroyed,
      'the container is holding a LIVE source, so this is not the null-source crash',
    ).toBeFalsy();
    expect(() => h.pass(), 'the next pass must throw on the destroyed bind group').toThrow(TypeError);
  });

  it('CONTROL: a repaint that never frees anything leaves the bind group intact', () => {
    // The shipped shape. One texture for the layer's life, resized in place - so there
    // is no free, nothing is bound-then-destroyed, and the pipe keeps working. Without
    // this leg the case above would only prove that destroying things is bad, not that
    // the shipped route avoids it.
    const only = dotRenderTexture(1);
    const { pc } = container(only);
    const h = harness(pc);
    h.pass();

    const source = (only as unknown as { _source: BoundSource })._source;
    const held = Object.values(h.pipe.defaultShader.groups).find(
      (g) => g.resources !== null && Object.values(g.resources as object).includes(source),
    );
    expect(held).toBeDefined();

    // The bucket change: resolution moves, identity does not, nothing is destroyed.
    only.resize(DOT_SIZE, DOT_SIZE, 4);
    expect(only.source.pixelWidth, 'the resize really changed the density').toBe(DOT_SIZE * 4);
    expect(only.orig.width, 'and it did NOT change the logical size').toBe(DOT_SIZE);

    for (const label of ['first', 'second', 'third']) {
      const bound = h.pass();
      expect(bound, `${label} post-repaint pass must still bind a source`).toBe(source);
      expect(bound?.destroyed, `${label} post-repaint pass bound a destroyed source`).toBeFalsy();
    }
    expect(held?.resources, 'the bind group survives a repaint').not.toBeNull();
  });
});
