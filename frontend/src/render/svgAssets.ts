// The vector asset registry (VEC-02/VEC-04, Plan 56-01): authored `.svg` files
// in, ONE shared tessellated `GraphicsContext` per asset out.
//
// The whole pipeline is compile-time. Each asset is pulled in through Vite's
// `?raw` transform, so its text is inlined into the bundle and then into the
// Tauri binary: no runtime fetch, no asset directory to ship, no rebake step.
// That is also what makes ART-05 ("change the artwork by editing one SVG path,
// no code change") true from this phase on rather than later.
//
// WHY THE MEMO IS LOAD-BEARING, not a micro-optimisation. Pixi v8 caches
// TESSELLATED GEOMETRY on the `GraphicsContext`, and `new Graphics(ctx)` shares
// that context rather than re-parsing. So "one shared GraphicsContext, many
// Graphics" is what keeps N drawings of the same asset at ONE tessellation and
// inside the 400-vertex batching cliff (`isBatchable` is a property of the
// context, not of each Graphics). `getAssetContext` returning the SAME OBJECT
// REFERENCE on every call is therefore an asserted property (identity, not deep
// equality), not an implementation detail. Phase 58 keys `(kind, state)` onto
// this same accessor.
//
// DELIBERATE DIVERGENCE from `synth/textureCache.ts`'s "instance-scoped, never a
// module-global singleton" rule, stated here so it reads as a decision and not
// an oversight: that rule exists because a baked GPU texture is scene-owned and
// must die with its scene. A `GraphicsContext` built from a committed,
// immutable, authored file is process-wide constant data with no per-scene
// ownership and nothing to tear down between scenes - it is closer to the
// authored literal in `skins/locked.ts` than to a texture cache entry.
//
// NO `node:crypto` IN THIS FILE, EVER. `spike/pixelGuard.tsx` imports this module, so
// it is a browser-bundle module: a Node builtin import here would break the Tauri
// build. The SHA-256 geometry digest helper therefore lives in
// `assets/geometryDigest.test.ts`, exactly as `synth/beltPainter.digest.test.ts` holds
// its own. The measurement half below is bundle-safe (pure Pixi, no Node builtins).

import { GraphicsContext, GraphicsContextSystem } from 'pixi.js';
import BALANCER_SVG_RAW from './assets/balancer.svg?raw';
import ENDPOINT_SVG_RAW from './assets/endpoint.svg?raw';
import FACTORY_SVG_RAW from './assets/factory.svg?raw';
import MERGE_SVG_RAW from './assets/merge.svg?raw';
import ROUTER_SVG_RAW from './assets/router.svg?raw';
import SINK_SVG_RAW from './assets/sink.svg?raw';
import SOURCE_SVG_RAW from './assets/source.svg?raw';
import TEE_SVG_RAW from './assets/tee.svg?raw';

/**
 * Every SHIPPED vector asset, by name. A LITERAL registry, not `import.meta.glob`:
 * globs resolve only under Vite, and this module is also loaded by vitest under
 * bare node in later plans. A new asset means a new row here.
 *
 * THE CALIBRATION FIXTURE IS NOT A ROW (plan 91-03, CHROME-06, D-05). It was one, so
 * its text shipped in the app's bundle although it is drawn only on the dev-only
 * `pixel-guard.html` page. It has its own fixture module under `src/spike/`, which the
 * build guard in `vite.config.ts` keeps out of `dist/`.
 */
const ASSET_SOURCES = {
  // ---- the EIGHT shipped machine subjects, alphabetical (plan 58-01 for `tee`,
  // plan 58-02 for the other seven). Every one carries its GLYPH ONLY: the chassis
  // is drawn parametrically by `layers/machineChassis.ts` at whatever footprint the
  // node actually has, so there is no whole-machine asset to register and no
  // per-footprint variant of any row. That is also why eight subjects need exactly
  // eight rows rather than eight times the number of states.
  //
  // The 32 Phase 57 candidate drafts stay OUT of this table and out of `AssetName`,
  // before and after these rows (57-ART-LOCK.md section 6). A draft that becomes
  // importable is a draft that can ship by accident.
  balancer: BALANCER_SVG_RAW,
  endpoint: ENDPOINT_SVG_RAW,
  factory: FACTORY_SVG_RAW,
  merge: MERGE_SVG_RAW,
  router: ROUTER_SVG_RAW,
  sink: SINK_SVG_RAW,
  source: SOURCE_SVG_RAW,
  tee: TEE_SVG_RAW,
} as const;

/** The name of an authored vector asset. */
export type AssetName = keyof typeof ASSET_SOURCES;

/**
 * The RAW AUTHORED TEXT of one asset - the same bytes `getAssetContext` tessellates.
 *
 * Added by plan 59-01 for CHROME-01, and its whole reason for existing is that the DOM
 * palette icon must read the SAME file the Pixi registry does. The alternative was a
 * second `?raw` import table in `chrome/icons.tsx`, and two tables that happen to name
 * the same files is exactly the "two code paths that agree" arrangement CHROME-01 is
 * written against: the day one row is edited, the icon and the machine diverge with
 * nothing to say so. Handing out the text keeps ONE declaration of what a subject's
 * artwork is.
 *
 * Same two-nets treatment as `getAssetContext` for an unknown name, for the same reason:
 * `ASSET_SOURCES[name]` would otherwise be `undefined`, and an `undefined` handed to a
 * parser produces an empty icon rather than an error.
 */
export function getAssetSource(name: AssetName): string {
  const source = ASSET_SOURCES[name];
  if (source === undefined) {
    throw new Error(`svgAssets: unknown asset '${name}' (known: ${Object.keys(ASSET_SOURCES).join('|')})`);
  }
  return source;
}

/** name -> the ONE built context for that asset. Populated lazily, never evicted. */
const CONTEXTS = new Map<AssetName, GraphicsContext>();

/**
 * The shared `GraphicsContext` for `name`, built on first call and returned by
 * IDENTITY thereafter. Callers construct `new Graphics(getAssetContext(name))`
 * as many times as they need; every one shares this context's tessellation.
 *
 * TWO NETS FOR AN UNKNOWN NAME, and the second one's job is stated precisely
 * because the phase 56 review (WR-09) was right that the old docblock overstated
 * it. Net 1 is the SIGNATURE: `AssetName` is `keyof typeof ASSET_SOURCES`, so from
 * any type-checked call site a typo is a compile error and the runtime branch
 * below is genuinely unreachable. That is the guarantee this function leans on and
 * the reason the parameter is NOT widened to `string`.
 *
 * Net 2 is the throw, which is deliberately kept for the callers a signature
 * cannot reach: a name that arrives through a cast, a `Record` lookup that was
 * widened somewhere upstream, or the `(kind, state)` mapping phase 58 keys onto
 * this accessor. Without it, `ASSET_SOURCES[name]` is `undefined`,
 * `new GraphicsContext().svg(undefined)` yields an EMPTY context, and the symptom
 * is a blank canvas with no error anywhere - the silent-failure class this module
 * exists to refuse. `assets/vertexBudget.test.ts` exercises the branch through a
 * cast so it is proven code rather than documented intent.
 */
export function getAssetContext(name: AssetName): GraphicsContext {
  const cached = CONTEXTS.get(name);
  if (cached !== undefined) return cached;
  const source = ASSET_SOURCES[name];
  if (source === undefined) {
    throw new Error(`svgAssets: unknown asset '${name}' (known: ${Object.keys(ASSET_SOURCES).join('|')})`);
  }
  // `.svg()` parses the text through Pixi's SVGParser and tessellates into this
  // context; it returns the context itself, so the built object is what we cache.
  const ctx = new GraphicsContext().svg(source);
  // NET 1 OF 2 (VEC-04): measure the freshly built context ONCE, on the build, so a
  // hand-edit to an asset is caught live in the running app at the moment it is first
  // drawn - not at the next CI run. NET 2 is `assets/vertexBudget.test.ts`, which walks
  // every file in `render/assets/` and catches the SAME defect without launching the
  // app. The 400 cliff is silent by default; one net is not enough for a silent failure.
  //
  // DEV-gated so a shipped Tauri build carries no measurement cost at all: the assets
  // are committed and immutable in a release, so the only thing this can catch there is
  // something that could not have changed.
  if (import.meta.env.DEV) {
    assertVertexBudget(`render/assets/${name}.svg`, measureContext(ctx));
  }
  CONTEXTS.set(name, ctx);
  return ctx;
}

/**
 * The shared `GraphicsContext` for `name` IF IT HAS ALREADY BEEN BUILT, else
 * `undefined`. NEVER BUILDS ONE (plan 76-08).
 *
 * WHY A SECOND ACCESSOR. `getAssetContext` builds, tessellates, DEV-measures and caches
 * on first ask, which is right for a draw and wrong for a READ-BACK: the machine layer's
 * `glyphSubjectOn(id)` names the art a glyph holds by comparing its context against the
 * shared ones by identity, and doing that through `getAssetContext` would build a context
 * for every subject not yet on the board, a side effect on this process-wide cache from a
 * probe that claims to be read-only. A glyph can only hold a context that was built, so
 * a context that does not exist yet can never be the match: comparing against the built
 * ones alone loses nothing. `machineReadback.test.ts` counts the built contexts before and
 * after a read-back and requires them equal.
 */
export function peekAssetContext(name: AssetName): GraphicsContext | undefined {
  return CONTEXTS.get(name);
}

/**
 * The AUTHOR BOX of one asset, in `u`, read off its own `viewBox`.
 *
 * Needed because Pixi's `SVGParser` NEVER READS `viewBox` - coordinates pass straight
 * through as user units - so a built `GraphicsContext` knows nothing about the box its
 * paths were authored inside. A caller that must centre a glyph in a machine's
 * effective box needs the authored extent, and the only honest place to get it is the
 * file itself.
 *
 * DERIVED FROM THE ARTIFACT, NEVER A HAND TABLE. A per-asset `{ tee: [64, 64] }`
 * literal would be a second declaration of the box, free to drift from the `viewBox`
 * the lint actually enforces, and the drift would show up as artwork silently
 * off-centre rather than as a failure. `lint-svg.ts`'s four-literal whitelist is what
 * constrains the value; this function only reads it.
 *
 * Throws on a missing or unparseable `viewBox` rather than defaulting to a plausible
 * 32x32: a default here would centre a wrongly-authored asset perfectly and report
 * nothing.
 */
export function getAssetBox(name: AssetName): { w: number; h: number } {
  const cached = BOXES.get(name);
  if (cached !== undefined) return cached;
  const source = ASSET_SOURCES[name];
  if (source === undefined) {
    throw new Error(`svgAssets: unknown asset '${name}' (known: ${Object.keys(ASSET_SOURCES).join('|')})`);
  }
  // ANCHORED AT THE ROOT TAG (WR-02), the same rule `glyphOccupancy.parseParts` uses.
  // Scanning the whole text would read a `viewBox="..."` out of the header DOCBLOCK,
  // and `router.svg`'s header quotes the transposed `0 0 96 64` box in order to call it
  // illegal. Since `getAssetBox` is the input to the glyph centring in
  // `machines.ts`, one header edit that quoted a box would silently mis-centre that
  // subject's artwork on the board with nothing to redden.
  const body = source.slice(source.indexOf('<svg'));
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(body);
  if (m === null) {
    throw new Error(
      `svgAssets: asset '${name}' has no parseable viewBox="0 0 W H". The author box is ` +
        'what centres a glyph in a machine box; a default would silently mis-centre it.',
    );
  }
  const box = { w: Number(m[1]), h: Number(m[2]) };
  BOXES.set(name, box);
  return box;
}

/** name -> its parsed author box. Same lazy/never-evicted shape as `CONTEXTS`. */
const BOXES = new Map<AssetName, { w: number; h: number }>();

/* ------------------------------------------------------------------ *
 * The vertex budget (VEC-04, Plan 56-05)
 * ------------------------------------------------------------------ */

/**
 * The three-field renderer stand-in `GraphicsContextSystem` is measured against.
 *
 * Written in the documented-argument style `synth/textureCache.ts` uses for
 * `BufferImageSource`: every field is here for a NAMED reason, verified by reading
 * Pixi 8.19's own source, so a future Pixi bump that touches one of them fails with
 * a locatable cause rather than a bare TypeError.
 *
 * - `uid` is the key `context._gpuData[renderer.uid]` is stored under
 *   (`GraphicsContextSystem.mjs:92`). It is NEGATIVE on purpose: Pixi's own `uid()`
 *   counter only ever issues non-negative integers, so a measurement can never
 *   collide with a live renderer's slot on a context the app also draws. (Measuring
 *   also leaves `context.dirty === false`, which is harmless for the same reason: a
 *   real renderer finds no entry under ITS uid and rebuilds regardless -
 *   `if (context.dirty || !hasContext)`.)
 * - `limits.maxBatchableTextures` is read by `_initContextRenderData` when the
 *   batcher's render data is pooled. Unused on the measurement path itself, but the
 *   field must exist or a later Pixi could dereference undefined.
 * - `gc.addResourceHash` is called by `GCManagedHash`'s constructor, which the system
 *   builds eagerly. A bare `{}` renderer throws
 *   `TypeError: Cannot read properties of undefined (reading 'addResourceHash')`
 *   here - observed during phase research, and the reason this field is not optional.
 *
 * No GL, no canvas, no device: tessellation is a pure CPU step that happens strictly
 * BEFORE any GPU work, which is why the whole budget gate runs in vitest.
 */
const FAKE_RENDERER = {
  uid: -1,
  limits: { maxBatchableTextures: 16 },
  gc: { now: 0, addResourceHash(): void {} },
};

/**
 * One asset's tessellation, in Pixi's own units.
 *
 * A `Measurement` is a SNAPSHOT and owns its arrays. `vertices` and `indices` are
 * COPIES of Pixi's buffers, never live views onto them - see `measureContext` for
 * why that distinction is load-bearing rather than defensive style.
 */
export interface Measurement {
  /**
   * The flat, stride-2 float array Pixi itself thresholds on. A copy, safe to
   * retain and safe to mutate.
   */
  vertices: number[];
  /** The triangle index list. A copy, safe to retain and safe to mutate. */
  indices: number[];
  /** `geometryData.vertices.length` - NOT a point count. See {@link VERTEX_LIMIT}. */
  vertexCount: number;
  /** `vertexCount / 2` - the (x, y) point count, carried so messages print both. */
  pointCount: number;
  /** Pixi's OWN `isBatchable` assignment, read back rather than recomputed. */
  isBatchable: boolean;
  /** The context that was measured. */
  context: GraphicsContext;
}

/**
 * The warn threshold, in `geometryData.vertices.length`. A warn band exists because a
 * bare hard-fail gives no drift signal: an asset that walks from 120 to 290 over three
 * phases is a trend, and a gate that only speaks at 400 never mentions it.
 */
export const VERTEX_WARN = 300;

/**
 * The hard limit, in `geometryData.vertices.length`.
 *
 * READ THE UNIT TWICE. `vertices` is a FLAT STRIDE-2 FLOAT ARRAY: `buildContextBatches`
 * computes point counts as `vertices.length / 2`. So 400 means fewer than **200 (x, y)
 * points**, not 400 points. Half of all readers get this backwards, which is why every
 * message this module emits prints BOTH numbers.
 *
 * The value is the COMPLEMENT of Pixi's own batchable test
 * (`GraphicsContextSystem.mjs:103`: `isBatchable = vertices.length < 400`). It is
 * duplicated here as a POLICY constant only - nothing in this module decides
 * batchability from it. `Measurement.isBatchable` is read back off Pixi's own
 * assignment, and `assets/vertexBudget.test.ts` carries a canary that reddens if the
 * two ever disagree. Mirroring the branch instead would make the gate prove nothing
 * about Pixi's actual behaviour on the next upgrade.
 */
export const VERTEX_LIMIT = 400;

/**
 * Measure a built `GraphicsContext` through Pixi's OWN tessellation.
 *
 * `GraphicsContextSystem.updateGpuContext` is the SINGLE measurement entry point, and
 * deliberately not the bare `buildContextBatches` function the UI-SPEC named:
 * `buildContextBatches` fills `geometryData` and `batches` but leaves `isBatchable`
 * UNDEFINED. The assignment lives in `updateGpuContext` (`GraphicsContextSystem.mjs:95-106`),
 * so a test calling only the bare function and asserting `isBatchable` would read
 * `undefined` and pass on nothing.
 *
 * Reading Pixi's own assignment is what makes "never an estimate, never an offline
 * re-implementation" literally true: if a Pixi upgrade moves the 400 threshold or
 * changes the array layout, this reports the new reality and the canary in
 * `assets/vertexBudget.test.ts` reddens. A hand-copied `< 400` branch would silently
 * agree with itself forever.
 *
 * THE RETURNED ARRAYS ARE COPIES, AND THAT IS NOT DEFENSIVE STYLE. `gpu.geometryData`
 * is owned by the POOLED `GpuGraphicsContext` and is mutated IN PLACE, never replaced:
 * `GpuGraphicsContext.reset()` does `geometryData.vertices.length = 0` and
 * `buildContextBatches` then refills that SAME array object
 * (`GraphicsContextSystem.mjs:20-34, 96-99`). Handing the live array out has two silent
 * failure modes, both of which `assets/measurementAliasing.test.ts` pins:
 *
 *   1. A retained `Measurement` changes under its holder when the same context is
 *      measured again. A digest gate would then hash a buffer it did not measure and
 *      either agree with the committed table by accident or diverge with no
 *      diagnosable cause - the "gate measures nothing" class this module is written
 *      against.
 *   2. `getAssetContext` hands out PROCESS-WIDE-SHARED contexts. A consumer using
 *      `Measurement.vertices` as a scratch array would corrupt the geometry the
 *      shipped app draws from.
 *
 * Nothing in the tree exercises either path today. Phases 57 and 58 add many assets to
 * exactly this accessor, which is why the boundary is closed now rather than after.
 *
 * EVERY CALL RE-TESSELLATES, and that is also a correctness requirement rather than a
 * cost the function forgot to avoid. `updateGpuContext` rebuilds only under
 * `if (context.dirty || !hasContext)`, and every measurement caches its result on the
 * context under the ONE fixed fake uid `-1`. So without the explicit dirty flag below,
 * the second measurement of a context returns the FIRST measurement's cached
 * `GpuGraphicsContext` - and `isBatchable` in particular is then stale, because
 * assigning `context.batchMode` does NOT set `dirty`:
 *
 *     const m1 = measureContext(ctx);   // batchMode 'auto'
 *     ctx.batchMode = 'no-batch';
 *     const m2 = measureContext(ctx);   // would report m1.isBatchable
 *
 * `isBatchable` is the one field in `vertexBudget.test.ts`'s drift canary whose whole
 * job is to catch a Pixi change, so a cached answer there is a false green on the
 * assertion least able to afford one. Forcing the rebuild makes `measureContext` a
 * function of the context's CURRENT state at every call, with no ordering constraint
 * for a caller to remember. `updateGpuContext` clears the flag again on its way out,
 * so the context is left exactly as it was found.
 */
export function measureContext(context: GraphicsContext): Measurement {
  const system = new GraphicsContextSystem(FAKE_RENDERER as never);
  context.dirty = true;
  const gpu = system.updateGpuContext(context);
  const vertices = gpu.geometryData.vertices.slice();
  const indices = gpu.geometryData.indices.slice();
  return {
    vertices,
    indices,
    vertexCount: vertices.length,
    pointCount: vertices.length / 2,
    isBatchable: gpu.isBatchable,
    context,
  };
}

/**
 * Parse SVG text into a fresh `GraphicsContext` and measure it.
 *
 * `.svg()` runs Pixi's `SVGParser`, which calls `document.createElement` and
 * `querySelector` - so this needs a DOM. That is why every spec that measures carries a
 * `// @vitest-environment jsdom` docblock while the project default stays
 * `environment: 'node'`. Measuring on the REAL parse path is the entire point of
 * VEC-04: a DOM-free re-plot of each `d` string would re-implement the
 * attribute-to-style mapping offline, which is exactly the class of thing this gate
 * exists to refuse.
 */
export function measureSvg(svgText: string): Measurement {
  return measureContext(new GraphicsContext().svg(svgText));
}

/**
 * The band a vertex count falls in.
 *
 * The two comparisons below are the WHOLE band definition. There is no third
 * threshold and no separate "ok" test, so the bands cannot drift apart or overlap:
 * they touch exactly at 300 and at 400. `>= VERTEX_LIMIT` is the exact complement of
 * Pixi's `< 400` batchable test.
 */
export function classifyVertexCount(vertexCount: number): 'ok' | 'warn' | 'fail' {
  if (vertexCount >= VERTEX_LIMIT) return 'fail';
  if (vertexCount >= VERTEX_WARN) return 'warn';
  return 'ok';
}

/** The second line of every budget message: what to actually do about it. */
const BUDGET_FIX = '  Simplify the path or split the part. See render/assets/README.md.';

/**
 * Enforce the budget for one measured asset, naming it.
 *
 * Three outcomes, and the first one is the one that is easy to get wrong:
 *
 * 1. ZERO geometry is a NAMED FAILURE, never a 0-vertex pass. An asset that tessellates
 *    to nothing sails under every threshold - it is the lowest possible vertex count -
 *    so a budget check that only compares against the limit reports the cleanest green
 *    in the suite for an asset that draws absolutely nothing. That is the vacuous pass
 *    this gate exists to refuse.
 * 2. At or above the limit: throw, naming the label, the count in BOTH units, and the
 *    limit in both units.
 * 3. In the warn band: emit a named `console.warn` and RETURN. A warning that threw
 *    would just be a second limit.
 */
export function assertVertexBudget(label: string, m: Measurement): void {
  if (m.vertexCount === 0) {
    throw new Error(
      `${label}  produced ZERO geometry: 0 vertices (0 points)\n` +
        '  An asset that tessellates to nothing is not a passing asset - it is under every\n' +
        `  budget by drawing nothing. Check the paths parse and declare fill or stroke.\n${BUDGET_FIX}`,
    );
  }
  const band = classifyVertexCount(m.vertexCount);
  if (band === 'fail') {
    throw new Error(
      `${label}  vertex budget exceeded: ${m.vertexCount} (${m.pointCount} points), ` +
        `limit ${VERTEX_LIMIT} (${VERTEX_LIMIT / 2} points)\n${BUDGET_FIX}`,
    );
  }
  if (band === 'warn') {
    console.warn(
      `${label}  vertex budget warning: ${m.vertexCount} (${m.pointCount} points), ` +
        `warn at ${VERTEX_WARN} (${VERTEX_WARN / 2} points), ` +
        `limit ${VERTEX_LIMIT} (${VERTEX_LIMIT / 2} points)\n${BUDGET_FIX}`,
    );
  }
}
