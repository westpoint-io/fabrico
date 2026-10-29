// @vitest-environment jsdom
//
// NET 2 OF 2 for the 400-vertex batch cliff (VEC-04, plan 56-05). Net 1 is the
// DEV-gated throw inside `getAssetContext`, which catches a hand-edit live in the
// running app; this file catches the SAME defect without launching anything.
//
// WHY TWO NETS FOR ONE NUMBER. Crossing 400 does not break rendering and prints
// nothing. `batchMode: 'auto'` simply stops batching the asset, and every `Graphics`
// drawn from it becomes its own draw call. The symptom is a frame-rate regression
// nobody can attribute to a commit. Silence is the whole reason the number is
// asserted rather than watched.
//
// THIS IS THE REPO'S FIRST DOM-CONSUMING SPEC, and that is a deliberate precedent
// change rather than something slid in. Until now every `.tsx` spec (`Legend.test.tsx`
// and friends) invoked React function components DIRECTLY and walked the returned
// element tree, specifically to avoid a DOM dependency and keep the "zero new
// packages" discipline. Pixi's `SVGParser` calls `document.createElement` and
// `querySelector`, so measuring on the REAL parse path needs a DOM.
//
// THE REAL FOOTPRINT IS 37 PACKAGES, NOT ONE, and it is stated here because the
// previous wording ("`jsdom` is a devDependency ... scoped to this spec alone") gave a
// dependency reviewer the wrong number to reason about (phase 56 review WR-12). The
// lockfile diff that added jsdom@30 added 37 `node_modules/*` entries: a full HTTP
// stack (`undici`), a cookie jar (`tough-cookie`, `tldts`), an HTML parser (`parse5`),
// a CSS engine (`css-tree`, `mdn-data`, four `@csstools/*`), `decimal.js`, `saxes`,
// `whatwg-url` and the rest. `npm ci` installs all 37 and runs their lifecycle scripts,
// including in CI's `unit` job.
//
// THE CHOICE STILL STANDS on the true number. The only alternative that gives Pixi's
// SVGParser a real DOM is the `canvas` package, which drags a NATIVE build toolchain
// (node-gyp, cairo, pango) into the frontend and into every CI runner - a worse cost in
// both install time and cross-platform failure modes, for the same capability. The
// scope limit is real and enforced by construction: jsdom is a devDependency, it is
// absent from the production tree, and it is reached only through the
// `@vitest-environment jsdom` docblock on the specs under `render/assets/` that
// measure (this one, `geometryDigest.test.ts` and `measurementAliasing.test.ts`). The
// project default stays `environment: 'node'`.
//
// `npm audit` reports one pre-existing high advisory (`postcss` via `vite@8.1.0`,
// already on the register). jsdom introduced no new advisory.
//
// ONE EXPECTED NOISE LINE, NOT A FAILURE. Under jsdom, importing `pixi.js` prints
// `Not implemented: HTMLCanvasElement's getContext() method: without installing the
// canvas npm package` once. That is jsdom reporting an unimplemented API Pixi probes
// during environment detection. It does not fail anything and it does not affect the
// measurement (the numbers here are byte-identical to the DOM-free reference path).
// Do NOT "fix" it by installing the `canvas` package: that drags a native build
// toolchain into the frontend for zero benefit.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Color, GraphicsContext } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VERTEX_LIMIT,
  VERTEX_WARN,
  assertVertexBudget,
  classifyVertexCount,
  getAssetContext,
  measureContext,
  measureSvg,
  type AssetName,
  type Measurement,
} from '../svgAssets.ts';
import { getPilotContext } from '../../spike/pilotFixture.ts';

/**
 * `render/assets/` itself - this spec lives in it.
 *
 * `import.meta.dirname`, NOT the repo's usual
 * `fileURLToPath(new URL('./', import.meta.url))` idiom, and the difference is a jsdom
 * trap worth naming once. Under `environment: 'jsdom'` the global `URL` is jsdom's
 * whatwg-url and it resolves a relative base against the DOCUMENT's base URI, so
 * `new URL('./', import.meta.url)` evaluates to `http://localhost:3000/src/render/assets`
 * and `fileURLToPath` then throws `ERR_INVALID_URL_SCHEME`. `decode.test.ts` uses the
 * URL idiom safely only because it runs on the node environment. `import.meta.dirname`
 * is unaffected by the DOM and is the correct form for any jsdom spec touching disk.
 */
const ASSET_DIR = import.meta.dirname;
const FIXTURE_DIR = join(ASSET_DIR, '__fixtures__');

/**
 * The SECOND shipped asset directory (plan 59-01, CHROME-01).
 *
 * `join(import.meta.dirname, ...)` and NEVER `new URL('../../chrome/assets/',
 * import.meta.url)`. Under `environment: 'jsdom'` the global `URL` is jsdom's whatwg-url
 * and it resolves a relative base against the DOCUMENT's base URI, so the URL idiom
 * evaluates to an `http://localhost:3000/...` string and `fileURLToPath` then throws
 * `ERR_INVALID_URL_SCHEME`. The trap is documented at `:66-78` above and again at
 * `geometryDigest.test.ts:47-51`; this is the third site to walk into it, so it is named
 * a third time rather than left to be rediscovered.
 */
const CHROME_ASSET_DIR = join(ASSET_DIR, '..', '..', 'chrome', 'assets');

/**
 * The DRAWN markup of an asset - its header comment stripped. The same helper
 * `shippedAssets.test.ts:129` carries, restated rather than exported across specs
 * (`lintSvg.test.ts:68-74` states the rule: a spec that imports the constant it checks
 * agrees with the implementation instead of checking it).
 *
 * Load-bearing, not hygiene: `logomark.svg`'s header NAMES `currentColor` precisely in
 * order to say that this is the one file in the directory that does not use it, and a
 * whole-text scan would read that counter-example as the example.
 */
function markupOf(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * THE SHIPPED ASSET COUNT, as a stated literal - never `discoverAssets().length`.
 *
 * An assertion computed from the same walk it is checking cannot fail: a discovery
 * that silently found nothing would agree with itself and report a clean zero-asset
 * green, which is the vacuous pass this whole gate exists to refuse. This number is
 * edited BY HAND when an asset is added, which is exactly the moment a human should
 * be looking at the budget. `lintSvg.test.ts` pins the same count independently.
 */
// 1 -> 2 in plan 58-01: `tee.svg`, the first SHIPPED machine asset, joins `pilot.svg`.
// 2 -> 9 in plan 58-02: the seven remaining shipped subjects join them. Nine is the FINAL
// shipped figure for this milestone - eight machine subjects plus the permanent
// calibration fixture - because the chassis is drawn in code, so there is no
// per-footprint and no per-state asset variant to add later.
const EXPECTED_ASSET_COUNT = 9;

/**
 * THE SHIPPED CHROME ASSET COUNT, a SECOND stated literal on the same terms as the one
 * above - never `discoverChromeAssets().length`. `lintSvg.test.ts` pins it independently.
 *
 * 1 in plan 59-01 (`belt.svg`); 1 -> 13 in plan 59-02, edited by hand in the commit that
 * authors the other twelve (`play`, `pause`, `step`, `undo`, `redo`, `save`, `load`,
 * `new`, `fit`, `warning`, `trash`, `logomark`); 13 -> 14 in plan 61-06, edited by hand
 * in the commit that authors the Graphics settings trigger's fader glyph;
 * 14 -> 15 in plan 66-01, edited by hand in the commit that authors `wire.svg` (the
 * Palette Wire tool's glyph). THIS FILE READS THE CONSTANT AT TWO ASSERTION SITES, so
 * one edit here clears two gates.
 */
// 15 -> 16 in phase 76 (plan 76-01), by hand, in the commit that authors `label.svg`.
// 16 -> 15 in plan 91-03 on 2026-10-24, by hand (the Graphics trigger's fader glyph deleted
// with the Graphics panel, D-04).
const EXPECTED_CHROME_ASSET_COUNT = 15;

/**
 * The SAME non-recursive `.svg` discovery plan 56-04's lint walker uses
 * (`readdirSync` + `isFile()` + `.endsWith('.svg')` + `.sort()`), so the lint, the
 * budget gate and the geometry digest cannot disagree about which files count.
 *
 * Non-recursive is load-bearing, not incidental: `__fixtures__/` holds deliberately
 * over-budget and deliberately non-conforming files, and every one of them is
 * invisible here because `isFile()` rejects the directory. 56-04 owns and asserts
 * that contract; this file depends on it.
 *
 * Sorted, so the per-asset report and the digest table emit in one stable order that
 * is a property of this function rather than of a filesystem.
 */
function discoverAssets(): string[] {
  return discoverIn(ASSET_DIR);
}

/** The same walk, over the chrome directory. */
function discoverChromeAssets(): string[] {
  return discoverIn(CHROME_ASSET_DIR);
}

function discoverIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name)
    .sort();
}

function readAsset(name: string): string {
  return readFileSync(join(ASSET_DIR, name), 'utf8');
}

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/**
 * An SVG of `n` filled 1u squares on the integer grid - the SAME construction the two
 * committed band fixtures use, so a fixture and this generator cannot drift apart.
 * Measured (not estimated): a filled 1u square tessellates to exactly 8 vertices, so
 * `n` squares measure `8n`.
 */
function squaresSvg(n: number): string {
  const lines = ['<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">'];
  for (let k = 0; k < n; k++) {
    const x = (k % 8) * 4;
    const y = Math.floor(k / 8) * 4;
    lines.push(
      `  <path data-part="sq-${k}" d="M${x} ${y} H${x + 1} V${y + 1} H${x} Z" fill="#b0bacb" />`,
    );
  }
  lines.push('</svg>');
  return lines.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the vertex bands touch at 300 and 400 with no gap and no overlap', () => {
  it('classifies the four exact boundaries', () => {
    // The bands are defined by TWO comparisons in `classifyVertexCount`, so there is
    // no third threshold that could drift. `>= 400` is the exact complement of Pixi's
    // own `vertices.length < 400` batchable test.
    expect(classifyVertexCount(299)).toBe('ok');
    expect(classifyVertexCount(300)).toBe('warn');
    expect(classifyVertexCount(399)).toBe('warn');
    expect(classifyVertexCount(400)).toBe('fail');
  });

  it('pins the two policy constants themselves, in both units', () => {
    // If someone widens the budget to make an asset fit, this reddens first. The
    // budget is never widened; the asset is simplified or split.
    expect(VERTEX_WARN).toBe(300);
    expect(VERTEX_LIMIT).toBe(400);
    // The unit, stated once so it cannot be misread: `vertices` is a FLAT STRIDE-2
    // float array, so the limit is fewer than 200 (x, y) POINTS.
    expect(VERTEX_LIMIT / 2).toBe(200);
    expect(VERTEX_WARN / 2).toBe(150);
    // And the bands are adjacent by construction: the first failing count is exactly
    // one step above the last warning count.
    expect(classifyVertexCount(VERTEX_LIMIT - 1)).toBe('warn');
    expect(classifyVertexCount(VERTEX_WARN - 1)).toBe('ok');
  });
});

describe('the 8n formula holds at every band boundary (MEASURED, not estimated)', () => {
  // These four sizes are the boundary and one step either side of BOTH thresholds.
  // Asserting the exact measured count - not just the band - is what stops a fixture
  // silently drifting under the limit while its test keeps passing.
  const CASES: Array<[squares: number, vertices: number, band: 'ok' | 'warn' | 'fail']> = [
    [37, 296, 'ok'],
    [38, 304, 'warn'],
    [49, 392, 'warn'],
    [50, 400, 'fail'],
  ];

  for (const [squares, vertices, band] of CASES) {
    it(`${squares} filled 1u squares measure ${vertices} vertices (${vertices / 2} points) - ${band}`, () => {
      const m = measureSvg(squaresSvg(squares));
      expect(m.vertexCount).toBe(8 * squares);
      expect(m.vertexCount).toBe(vertices);
      expect(m.pointCount).toBe(vertices / 2);
      expect(classifyVertexCount(m.vertexCount)).toBe(band);
    });
  }
});

describe('the drift canary - Pixi\'s own layout and Pixi\'s own threshold', () => {
  it('a context built to a KNOWN point count reports twice that many vertices', () => {
    // One axis-aligned filled rectangle is four corner points, and nothing else. If a
    // Pixi upgrade changed `geometryData.vertices` from a flat stride-2 array to an
    // array of points, this would report 4 instead of 8 and every budget number in
    // the repo would silently halve - the gate would keep passing while measuring the
    // wrong thing. That is the failure this canary exists to make loud.
    const KNOWN_POINTS = 4;
    const m = measureContext(new GraphicsContext().rect(0, 0, 10, 10).fill(0xffffff));
    expect(m.vertexCount).toBe(KNOWN_POINTS * 2);
    expect(m.pointCount).toBe(KNOWN_POINTS);
    expect(m.vertices).toHaveLength(m.vertexCount);
  });

  it("reads isBatchable off Pixi's own branch, and it flips exactly at our limit", () => {
    // NOT a re-implementation of `vertices.length < 400`: `measureContext` returns the
    // value `GraphicsContextSystem.updateGpuContext` assigned. So if a Pixi upgrade
    // moves the threshold, THIS reddens rather than a mirrored constant quietly
    // disagreeing with the engine forever.
    const under = measureSvg(squaresSvg(49)); // 392
    const at = measureSvg(squaresSvg(50)); // 400
    expect(under.vertexCount).toBe(VERTEX_LIMIT - 8);
    expect(under.isBatchable).toBe(true);
    expect(at.vertexCount).toBe(VERTEX_LIMIT);
    expect(at.isBatchable).toBe(false);
    // Pixi's verdict and our policy band agree on both sides of the cliff. This is the
    // assertion that ties `VERTEX_LIMIT` to reality rather than to itself.
    expect(classifyVertexCount(under.vertexCount) === 'fail').toBe(!under.isBatchable);
    expect(classifyVertexCount(at.vertexCount) === 'fail').toBe(!at.isBatchable);
  });

  it('the committed over-budget fixture is UNBATCHABLE by Pixi, not merely by us', () => {
    const m = measureSvg(readFixture('overbudget.svg'));
    expect(m.vertexCount).toBe(448);
    expect(m.isBatchable).toBe(false);
  });

  it('isBatchable tracks Pixi\'s BRANCH, not a vertex count - proven by batchMode', () => {
    // THE DISCRIMINATOR. The two assertions above are also satisfied by a
    // hand-mirrored `vertices.length < 400`, because a mirror agrees with Pixi TODAY.
    // This case does not have that property. Pixi's assignment is a three-way branch
    // (`GraphicsContextSystem.mjs:95-106`) in which the vertex count is consulted ONLY
    // under `batchMode: 'auto'`:
    //
    //   'no-batch' -> false, whatever the count
    //   'batch'    -> true,  whatever the count
    //   'auto'     -> vertices.length < 400
    //
    // So a tiny 'no-batch' context and a 448-vertex 'batch' context both come out the
    // OPPOSITE way round from any count comparison. Re-implement the threshold offline
    // and this test reddens immediately - which is the point: the gate must prove
    // something about Pixi's actual behaviour, not about a constant agreeing with
    // itself.
    const tiny = new GraphicsContext().rect(0, 0, 10, 10).fill(0xffffff);
    tiny.batchMode = 'no-batch';
    const tinyM = measureContext(tiny);
    expect(tinyM.vertexCount).toBeLessThan(VERTEX_LIMIT);
    expect(tinyM.isBatchable).toBe(false); // a count mirror would say true

    const huge = new GraphicsContext().svg(readFixture('overbudget.svg'));
    huge.batchMode = 'batch';
    const hugeM = measureContext(huge);
    expect(hugeM.vertexCount).toBe(448);
    expect(hugeM.isBatchable).toBe(true); // a count mirror would say false

    // The policy band is deliberately NOT affected by batchMode: every authored asset
    // ships on the default 'auto', so 448 stays a budget failure regardless.
    expect(classifyVertexCount(hugeM.vertexCount)).toBe('fail');
  });

  it('a re-measure after a batchMode change reports the NEW mode, not a cached one', () => {
    // WHY THIS GUARDS THE CANARY ABOVE (phase 56 review WR-03). The case above happens
    // to set `batchMode` on a freshly built context BEFORE its first measurement. That
    // ordering is the only reason it was ever correct: `updateGpuContext` rebuilds only
    // under `if (context.dirty || !hasContext)`, assigning `batchMode` does NOT set
    // `dirty`, and `measureContext` caches under one fixed fake renderer uid. So a
    // measure-then-change-then-measure sequence used to return the FIRST answer twice.
    //
    // That is a false green on `isBatchable` specifically - the single assertion in this
    // file whose whole job is to notice Pixi changing. A canary that reports whatever it
    // reported last time is not a canary. `measureContext` now marks the context dirty
    // on every call, so this sequence is honest and no caller has an ordering rule to
    // remember.
    const ctx = new GraphicsContext().rect(0, 0, 10, 10).fill(0xffffff);

    const asAuto = measureContext(ctx); // default 'auto', well under 400
    expect(asAuto.vertexCount).toBeLessThan(VERTEX_LIMIT);
    expect(asAuto.isBatchable).toBe(true);

    ctx.batchMode = 'no-batch';
    const asNoBatch = measureContext(ctx);
    expect(asNoBatch.vertexCount).toBe(asAuto.vertexCount); // same geometry...
    expect(asNoBatch.isBatchable).toBe(false); // ...different, CURRENT branch

    // And back again, so the assertion cannot pass on a one-way latch.
    ctx.batchMode = 'auto';
    expect(measureContext(ctx).isBatchable).toBe(true);
  });
});

describe('assertVertexBudget - the named message, in both units', () => {
  it('throws on the committed over-budget fixture, naming the file and both units', () => {
    const label = 'render/assets/__fixtures__/overbudget.svg';
    const m = measureSvg(readFixture('overbudget.svg'));
    expect(m.vertexCount).toBe(448); // 56 squares * 8
    expect(m.pointCount).toBe(224);
    expect(classifyVertexCount(m.vertexCount)).toBe('fail');

    // The MESSAGE is asserted, not merely the fact that it threw. A throw with an
    // unreadable message costs a contributor a debugging round-trip on every trip.
    let caught: Error | undefined;
    try {
      assertVertexBudget(label, m);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    const text = String(caught?.message);
    expect(text).toContain(label);
    expect(text).toContain('448');
    expect(text).toContain('224 points');
    expect(text).toContain('400');
    expect(text).toContain('200 points');
    // Two lines: the measurement, then one sentence saying what to do about it.
    expect(text).toContain('Simplify the path or split the part');
    expect(text).toContain('render/assets/README.md');
  });

  it('warns without throwing on the committed warn-band fixture', () => {
    const label = 'render/assets/__fixtures__/warnband.svg';
    const m = measureSvg(readFixture('warnband.svg'));
    expect(m.vertexCount).toBe(320); // 40 squares * 8
    expect(m.pointCount).toBe(160);
    expect(classifyVertexCount(m.vertexCount)).toBe('warn');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => assertVertexBudget(label, m)).not.toThrow();
    // Exactly one warning. A warn band that nothing exercises is a band nobody knows
    // works, which is why this fixture is committed rather than generated inline.
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]?.[0]);
    expect(text).toContain(label);
    expect(text).toContain('320');
    expect(text).toContain('160 points');
    expect(text).toContain('300');
    expect(text).toContain('150 points');
    expect(text).toContain('400');
  });

  it('is SILENT under the warn threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = measureSvg(squaresSvg(37)); // 296
    expect(() => assertVertexBudget('render/assets/quiet.svg', m)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('names ZERO geometry as a failure - the lowest count is not the best score', () => {
    // A path that tessellates to nothing sails under every threshold: 0 is under 300
    // and under 400, and `classifyVertexCount(0)` is legitimately 'ok'. So a budget
    // check that only compares against the limit gives the cleanest green in the suite
    // to an asset that draws absolutely nothing. Zero is handled BEFORE the bands for
    // exactly that reason.
    const ghost =
      '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n' +
      '  <path data-part="ghost" d="M3 3 H3 Z" fill="none" />\n' +
      '</svg>';
    const m = measureSvg(ghost);
    expect(m.vertexCount).toBe(0);
    expect(classifyVertexCount(m.vertexCount)).toBe('ok'); // the trap, stated out loud

    expect(() => assertVertexBudget('render/assets/ghost.svg', m)).toThrow(/ZERO geometry/);
    expect(() => assertVertexBudget('render/assets/ghost.svg', m)).toThrow(
      /render\/assets\/ghost\.svg/,
    );
  });
});

describe('every shipped asset is measured, and none is over budget', () => {
  it('discovers the committed assets against a STATED literal, never its own output', () => {
    const assets = discoverAssets();
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(assets).toHaveLength(EXPECTED_ASSET_COUNT);
    // The EXHAUSTIVE shipped set, spelled out. Plan 58-01 added `tee.svg`, the first
    // shipped machine art; plan 58-02 adds the other seven subjects. `pilot.svg` is the
    // permanent calibration fixture and is NOT machine art - it is in this walk because
    // it is in this directory, which is exactly the property that keeps it measured.
    expect(assets).toEqual([
      'balancer.svg',
      'endpoint.svg',
      'factory.svg',
      'merge.svg',
      'pilot.svg',
      'router.svg',
      'sink.svg',
      'source.svg',
      'tee.svg',
    ]);
    // Sorted order is the emission order for the per-asset report and the digest table.
    expect([...assets].sort()).toEqual(assets);
    // The non-recursive walk cannot see the deliberately over-budget fixtures.
    expect(assets.some((a) => a.includes('__fixtures__'))).toBe(false);
    expect(assets).not.toContain('overbudget.svg');
  });

  it('measures EVERY asset and names EVERY offender, never just the first', () => {
    const assets = discoverAssets();
    expect(assets.length).toBeGreaterThanOrEqual(1); // a zero-asset run is not a pass

    const offenders: string[] = [];
    const unbatchable: string[] = [];
    const measured: Array<[string, Measurement]> = [];

    for (const name of assets) {
      const m = measureSvg(readAsset(name));
      measured.push([name, m]);
      if (m.vertexCount === 0 || classifyVertexCount(m.vertexCount) !== 'ok') {
        offenders.push(
          `render/assets/${name}: ${m.vertexCount} (${m.pointCount} points), limit ${VERTEX_LIMIT}`,
        );
      }
      if (!m.isBatchable) unbatchable.push(`render/assets/${name}`);
    }

    // Collected then asserted, so ONE run names every offending asset. A loop that
    // asserted per iteration would stop at the first and force N runs to find N.
    expect(offenders).toEqual([]);
    expect(unbatchable).toEqual([]);
    expect(measured).toHaveLength(EXPECTED_ASSET_COUNT);
  });

  it('pins EVERY shipped subject at its MEASURED vertex count, not merely in its band', () => {
    // MEASURED IN PLAN 58-02, on the real Pixi tessellation, and pinned so a silent
    // enrichment of a glyph shows up as a number rather than as a still-green band. The
    // band assertion above is satisfied by anything under 300; these are the actual
    // figures, and the whole eight-subject set totals 284 vertices / 142 points - under
    // three quarters of what ONE asset is allowed.
    //
    // DO NOT UPDATE A ROW TO MATCH A CHANGED ASSET WITHOUT INVESTIGATING IT. This table
    // and `__digests__/geometry.digest.json` are the two nets on authored geometry; the
    // digest says the geometry moved, this says by roughly how much and in which
    // direction. Re-blessing either alone defeats both.
    //
    // The lock's own figure of "604 vertices / 302 points across Direction A's eight
    // subjects" describes the CANDIDATES, which carried a chassis path and port stubs.
    // Both left the files under the 2026-08-02 design decision, so the lock's number is not the
    // shipped number and must not be quoted as one.
    const PINNED: Array<[name: string, vertices: number, indices: number]> = [
      ['balancer.svg', 40, 42],
      ['endpoint.svg', 28, 30],
      ['factory.svg', 64, 84],
      ['merge.svg', 32, 24],
      ['router.svg', 32, 36],
      ['sink.svg', 32, 36],
      ['source.svg', 32, 36],
      ['tee.svg', 24, 18],
    ];

    let total = 0;
    const actual: Array<[string, number, number]> = [];
    for (const [name] of PINNED) {
      const m = measureSvg(readAsset(name));
      actual.push([name, m.vertexCount, m.indices.length]);
      total += m.vertexCount;
      expect(m.pointCount, name).toBe(m.vertexCount / 2);
      expect(m.isBatchable, name).toBe(true);
    }
    // One comparison, so a single run names every subject that moved.
    expect(actual).toEqual(PINNED);
    expect(total).toBe(284);
    // The eight subjects TOGETHER are still under the limit ONE asset is held to. That is
    // not a requirement - each asset batches on its own - but it is the headroom figure
    // that says the vector move did not spend the budget it was given.
    expect(total).toBeLessThan(VERTEX_LIMIT);
    // Non-vacuity: the pinned set is the eight machine subjects, and the walk's ninth
    // file is the calibration fixture, pinned separately below.
    expect(PINNED).toHaveLength(EXPECTED_ASSET_COUNT - 1);
    expect(PINNED.map(([n]) => n)).toEqual(discoverAssets().filter((n) => n !== 'pilot.svg'));
  });

  it('the pilot measures its pinned 38 vertices / 39 indices and is batchable', () => {
    // The pilot is the phase's stable subject. 38 vertices is 9.5% of the limit, which
    // is the headroom that makes it a meaningful long-lived digest subject.
    const m = measureSvg(readAsset('pilot.svg'));
    expect(m.vertexCount).toBe(38);
    expect(m.pointCount).toBe(19);
    expect(m.indices).toHaveLength(39);
    expect(m.isBatchable).toBe(true);
    expect(classifyVertexCount(m.vertexCount)).toBe('ok');
  });
});

/* ------------------------------------------------------------------ *
 * The SECOND asset directory (plan 59-01, CHROME-01)
 * ------------------------------------------------------------------ */

describe('the chrome asset directory is DISCOVERED here, and deliberately not MEASURED', () => {
  // WHY THIS WALK EXISTS AT ALL WHEN THE BUDGET DOES NOT APPLY. A second shipped asset
  // directory that no gate reaches is exactly the hole the flat placement contract was
  // written to prevent, and "the budget is irrelevant there" would be a reason to skip
  // the MEASUREMENT, never a reason to skip the DISCOVERY. The count pin below is what
  // makes a chrome directory that walked to nothing - a wrong path segment, a moved
  // file - a named failure in this spec rather than a silent zero.
  //
  // WHY THE BUDGET ITSELF IS NOT APPLIED, MEASURED RATHER THAN ASSUMED. The 400-vertex
  // cliff is a property of Pixi's `GraphicsContext` batching, and chrome assets never
  // reach Pixi. They CANNOT: every fill and stroke in `chrome/assets/` is literally
  // `currentColor`, and `new GraphicsContext().svg(text)` throws
  // `Error: Unable to convert color currentColor` out of `Color._normalize` on the first
  // paint attribute (verified 2026-08-09 against pixi 8.19). Calling `measureSvg` on one
  // would therefore not report a budget - it would throw, and a spec that "measured"
  // these files could only ever do so by first breaking the ink rule that makes them
  // chrome glyphs.
  it('discovers the committed chrome assets against a STATED literal, never its own output', () => {
    const assets = discoverChromeAssets();
    expect(assets.length).toBeGreaterThanOrEqual(1);
    expect(assets).toHaveLength(EXPECTED_CHROME_ASSET_COUNT);
    // Exhaustive, in sorted emission order.
    expect(assets).toEqual([
      'belt.svg',
      'fit.svg',
      'label.svg',
      'load.svg',
      'logomark.svg',
      'new.svg',
      'pause.svg',
      'play.svg',
      'redo.svg',
      'save.svg',
      'step.svg',
      'trash.svg',
      'undo.svg',
      'warning.svg',
      'wire.svg',
    ]);
    expect([...assets].sort()).toEqual(assets);
  });

  it('proves the reason chrome assets are exempt from the budget, rather than asserting it', () => {
    // The exemption is a MEASUREMENT, kept executable so it cannot quietly stop being
    // true. If a future Pixi learns to resolve `currentColor`, this reddens and the
    // exemption above gets re-argued instead of surviving as folklore.
    //
    // OVER THE WHOLE DIRECTORY, not over `belt.svg` alone (plan 59-02). One sampled file
    // would certify one file: the exemption is claimed for the directory, so it is proven
    // for the directory. `logomark.svg` is the reason this matters rather than being
    // tidiness - it is the one asset here that carries NO `currentColor` at all (it is a
    // multi-colour composition painted entirely in `var(--fab-*)` references), so a
    // `currentColor`-shaped proof would have said nothing about the one file whose ink
    // form is different. (What makes it multi-colour changed in plan 80-05 and the
    // property did not: it used to be a lit bevel edge against a shadow edge, and it is
    // now an amber item against a grey belt band. Either way one inherited ink cannot
    // express it, which is the whole reason the exemption exists.)
    //
    // THE `Color.shared` RESET IS LOAD-BEARING, NOT HYGIENE - see the case below, which
    // is what makes that statement checked rather than asserted. Without it this loop is
    // a PARITY COIN FLIP.
    const chromeAssets = discoverChromeAssets();
    expect(chromeAssets).toHaveLength(EXPECTED_CHROME_ASSET_COUNT);
    for (const name of chromeAssets) {
      const text = readFileSync(join(CHROME_ASSET_DIR, name), 'utf8');
      Color.shared.setValue(0x000000);
      expect(
        () => new GraphicsContext().svg(text),
        `${name} no longer defeats Pixi's colour parser - re-argue the budget exemption`,
      ).toThrow(/Unable to convert color/);
    }
    // The two ink FORMS are both present in the directory and both defeat the parser, so
    // the loop above is not accidentally measuring thirteen copies of one case. STRIPPED
    // OF THE HEADER FIRST, the rule every scanner in this repo follows: `logomark.svg`'s
    // docblock NAMES `currentColor` in order to say the file does not use it, and a
    // whole-text scan would read the counter-example as the example.
    expect(markupOf(readFileSync(join(CHROME_ASSET_DIR, 'belt.svg'), 'utf8'))).toContain(
      'currentColor',
    );
    expect(markupOf(readFileSync(join(CHROME_ASSET_DIR, 'logomark.svg'), 'utf8'))).not.toContain(
      'currentColor',
    );
  });

  it("Pixi's colour parser POISONS its shared singleton on a failed conversion, so the refusal above is only true on a clean one", () => {
    // MEASURED IN PLAN 59-02, and it invalidates the shape the plan-59-01 version of the
    // case above was written in. `parseSVGStyle.mjs:parseAttribute` resolves every paint
    // through the module-level singleton `Color.shared`, and `Color`'s `value` setter
    // (`color/Color.mjs`) assigns `this._value` BEFORE calling `_normalize`, which is what
    // throws. So a failed conversion leaves `Color.shared._value === 'currentColor'` while
    // `_int` still holds the LAST GOOD colour.
    //
    // The consequence is that the SECOND `setValue('currentColor')` short-circuits on
    // `_isSourceEqual` and returns successfully with a stale number. Parsing the SAME
    // chrome asset twice in a row therefore THROWS, then SUCCEEDS, then throws, then
    // succeeds - and a spec that asserted `.toThrow()` on one file was green only because
    // of the parity of however many `.svg()` calls happened to run before it in that
    // worker. The 59-01 version of this case is exactly that spec.
    //
    // This is also the honest statement of the exemption itself: it is NOT "Pixi cannot
    // parse a chrome asset". It is "Pixi cannot parse a chrome asset CORRECTLY - it either
    // throws or silently paints the previous subject's colour", which is a strictly worse
    // failure than the throw and an even better reason not to route these files through it.
    //
    // `play.svg` IS THE SUBJECT AND THE CHOICE IS FORCED: it is the only file here with a
    // SINGLE `<path>`. A multi-path file re-throws on its second parse anyway, because
    // completing a path resets `Color.shared` to the resolved number before the next
    // path's `currentColor` is offered - so it hides the poison behind its own second
    // part. `belt.svg` looks immune for exactly that reason and is not.
    const text = readFileSync(join(CHROME_ASSET_DIR, 'play.svg'), 'utf8');
    expect(markupOf(text).match(/<path\b/g), 'play.svg is the single-path subject').toHaveLength(1);

    Color.shared.setValue(0x000000);
    expect(() => new GraphicsContext().svg(text)).toThrow(/Unable to convert color currentColor/);

    // The poison is directly OBSERVABLE, so the mechanism is checked here rather than
    // only narrated above: the failed conversion left the rejected string sitting in the
    // singleton it was supposed to have bounced off.
    expect(Color.shared.value).toBe('currentColor');

    // NO reset here - that absence IS the case.
    expect(
      () => new GraphicsContext().svg(text),
      'Pixi no longer poisons Color.shared on a failed conversion. If this is a fixed ' +
        'upstream bug, delete the Color.shared.setValue resets above - they exist only ' +
        'for it.',
    ).not.toThrow();

    // A direct conversion on a FRESH instance always throws, which is what proves the
    // alternation is the singleton's state and not something about the string.
    expect(() => new Color('currentColor')).toThrow(/Unable to convert color currentColor/);

    // Leave the singleton clean for whatever runs next in this worker. The whole point of
    // this case is that a poisoned singleton changes another spec's result.
    Color.shared.setValue(0x000000);
    expect(Color.shared.value).toBe(0x000000);
  });
});

describe('exactly ONE shared GraphicsContext exists per asset', () => {
  it('returns the IDENTICAL object on two calls (toBe, never toEqual)', () => {
    // Identity, not deep equality. `toEqual` would pass on two separately built
    // contexts and prove nothing: the property under test is that N drawings of an
    // asset share ONE tessellation, and a second context is a second tessellation
    // whose vertices happen to match.
    const first = getAssetContext('tee');
    const second = getAssetContext('tee');
    expect(second).toBe(first);
    expect(first).toBeInstanceOf(GraphicsContext);
    // The pilot calibration fixture's own memo (plan 91-03 moved it out of the shipped
    // table into `spike/pilotFixture.ts`) holds the same property.
    const pilotFirst = getPilotContext();
    expect(getPilotContext()).toBe(pilotFirst);
    expect(pilotFirst).toBeInstanceOf(GraphicsContext);
    expect(pilotFirst).not.toBe(first);
  });

  it('the shared context is the one the budget gate measured', () => {
    const m = measureContext(getPilotContext());
    expect(m.context).toBe(getPilotContext());
    expect(m.vertexCount).toBe(38);
    expect(m.isBatchable).toBe(true);
  });

  it('an unknown name THROWS by name rather than yielding an empty context', () => {
    // WHY A CAST IS THE POINT, NOT A SMELL (phase 56 review WR-09). `AssetName` makes
    // this branch unreachable from any type-checked call site, which is the primary
    // guarantee and the reason the signature stays narrow. But an unexercised error
    // path is a documented safety property that has never been observed to work, and
    // the failure it prevents is silent: `ASSET_SOURCES[name]` would be `undefined`,
    // `.svg(undefined)` builds an EMPTY context, and the app renders a blank canvas
    // with no error anywhere. The cast reproduces exactly the caller shape the
    // signature cannot police - a name widened somewhere upstream, or the `(kind,
    // state)` mapping phase 58 keys onto this accessor.
    expect(() => getAssetContext('pilto' as AssetName)).toThrow(/unknown asset 'pilto'/);
    // The message must also name what IS known, so the throw is actionable at the
    // point of failure rather than sending a reader back to the registry.
    expect(() => getAssetContext('pilto' as AssetName)).toThrow(/known: balancer\|/);
    // The pilot fixture is not a shipped asset (plan 91-03), so the shipped table
    // refuses it by name too.
    expect(() => getAssetContext('pilot' as AssetName)).toThrow(/unknown asset 'pilot'/);
  });
});
