// @vitest-environment jsdom
//
// candidateBudget.test.ts - the 400-vertex batch cliff, applied to Phase 57's art-board
// DRAFTS (plan 57-04, BOARD-01, VEC-04).
//
// REQUIRED DOCBLOCK, not a copied habit. `GraphicsContext.svg()` runs Pixi's `SVGParser`,
// which calls `document.createElement` and `querySelector`. Measuring on the REAL parse
// path is the entire point - a DOM-free re-plot of each `d` string would re-implement
// the attribute-to-style mapping offline and prove nothing about what Pixi will draw.
// The project default stays `environment: 'node'`; jsdom is reached only through this
// docblock, exactly as on the three specs in the parent directory that measure.
//
// ONE EXPECTED NOISE LINE, NOT A FAILURE. Under jsdom, importing `pixi.js` prints
// `Not implemented: HTMLCanvasElement's getContext() method: without installing the
// canvas npm package` once. That is jsdom reporting an unimplemented API Pixi probes
// during environment detection. It does not fail anything and it does not affect the
// measurement. Do NOT "fix" it by installing the `canvas` package: that drags a native
// build toolchain (node-gyp, cairo, pango) into the frontend and into every CI runner
// for zero benefit.
//
// THE HEADROOM, MEASURED, SO AN AUTHOR KNOWS THE CEILING BEFORE DRAWING RATHER THAN
// AFTER (57-RESEARCH F2.1/F2.2, measured this phase through this exact path):
//
//   filled rectangle (`M H V H Z`)      8 verts / 4 pts    -> 49 filled parts fit
//   stroked rectangle, stroke-width 3  24 verts / 12 pts   -> 16 stroked parts fit
//   rounded-rect outline, r = 3..8    104 verts / 52 pts   ->  3 such outlines fit
//
// A STROKE COSTS THREE TIMES THE FILL OF THE SAME PATH. That is worth stating out loud
// because it is the opposite of what a direction's prose description suggests: D-02
// calls Direction D (schematic / line-only) "cheapest in vertices", and per primitive
// that is false. Cost is read off the printed measurement below, never reasoned from a
// direction's description.
//
// AND THE BUDGET IS FOOTPRINT-INDEPENDENT. Identical geometry authored at `0 0 32 32`
// and at `0 0 96 96` tessellates to BYTE-IDENTICAL vertex counts (measured: 32 verts at
// all four legal viewBoxes). A 96x96 `FACTORY` is NOT budget-constrained relative to a
// 32x32 `SOURCE`, and no candidate is simplified on the belief that it is.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VERTEX_LIMIT,
  VERTEX_WARN,
  classifyVertexCount,
  measureSvg,
  type Measurement,
} from '../../svgAssets.ts';

/**
 * `render/assets/candidates/` itself - this spec lives in it.
 *
 * `import.meta.dirname`, NOT `fileURLToPath(new URL('./', import.meta.url))`. Under
 * `environment: 'jsdom'` the global `URL` is jsdom's whatwg-url and resolves a relative
 * base against the DOCUMENT's base URI, so the URL idiom evaluates to an `http://` URL
 * and `fileURLToPath` throws `ERR_INVALID_URL_SCHEME` (Phase 56's recorded lesson).
 * `candidateLint.test.ts` uses the same accessor so the two gates cannot walk different
 * trees.
 */
const CANDIDATE_ROOT = import.meta.dirname;

/**
 * THE FOUR CANDIDATE DIRECTIONS, as a stated literal - the COMPLETE set, not a running
 * total. D-01 locked four directions plus `TODAY`, which is a pinned reference and NOT a
 * candidate, so it has no directory here.
 *
 * Raised from `['a', 'b']` by plan 57-05 in the same edit that added the sixteen `c/` and
 * `d/` files, so the bump is visible in the diff.
 */
const AUTHORED_DIRECTIONS = ['a', 'b', 'c', 'd'] as const;

/**
 * SUBJECTS PER DIRECTION, as a stated literal - never a directory listing, because an
 * assertion computed from the same source it is checking cannot fail.
 *
 * IT IS 8 AND NOT 9: `BELT` is a board subject but NOT a candidate. Its art is already
 * locked by `53-BELT-LOCK.md` (Direction B, the maintainers' lock, 2026-07-26).
 */
const EXPECTED_PER_DIRECTION = 8;

/**
 * THE WHOLE COMMITTED SET'S FINAL SIZE: four directions of eight subjects each.
 *
 * IT IS 32 AND NOT 36. Nine board subjects times four directions is 36, but `BELT` is a
 * board subject and NOT a candidate - its art is already locked by `53-BELT-LOCK.md`
 * (the maintainers' lock, 2026-07-26). Four absent belt cells are the whole difference.
 *
 * IT IS A LITERAL, never `AUTHORED_DIRECTIONS.length * EXPECTED_PER_DIRECTION` and never a
 * directory listing: an assertion computed from the same source it is checking cannot fail.
 * Stated independently of `candidateLint.test.ts`'s copy on purpose - two gates that each
 * refuse a vacuous run are two nets, and a shared constant module would let one edit
 * silence both.
 */
const EXPECTED_CANDIDATE_COUNT = 32;

/**
 * THE EIGHT STEMS, stated and sorted - the same literal `candidateLint.test.ts` carries.
 * Duplicated on purpose: two independent gates that each refuse a vacuous run are two
 * nets, and a shared constant module would make one edit silence both.
 */
const EXPECTED_STEMS = [
  'balancer',
  'endpoint',
  'factory',
  'merge',
  'router',
  'sink',
  'source',
  'tee',
] as const;

/** The stated stems as filenames. Derived from the LITERAL above, never from disk. */
const EXPECTED_FILENAMES: readonly string[] = EXPECTED_STEMS.map((stem) => `${stem}.svg`);

/**
 * The SAME non-recursive `.svg` discovery the lint walker uses, so the lint gate and the
 * budget gate cannot disagree about which files count.
 */
function svgNamesIn(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name)
    .sort();
}

/**
 * The band word for a measured candidate, resolved through the EXPORTED classifier and
 * never through a hand-written comparison against the limit.
 *
 * A mirrored threshold agrees with the classifier today and would keep agreeing with
 * itself forever - including after a Pixi upgrade moved the cliff, at which point the
 * gate would be measuring policy rather than reality. Routing every band decision in
 * this file through one helper is also what makes the mirror MUTATION-VISIBLE: replace
 * the call below with a bare limit comparison and the warn band disappears, which the
 * boundary case in the first describe block catches by name.
 */
function bandOf(vertexCount: number): 'ok' | 'warn' | 'fail' {
  return classifyVertexCount(vertexCount);
}

interface Measured {
  readonly rel: string;
  readonly m: Measurement;
  readonly band: 'ok' | 'warn' | 'fail';
}

function measureAll(): Measured[] {
  const out: Measured[] = [];
  for (const dir of AUTHORED_DIRECTIONS) {
    // A missing direction directory THROWS here rather than producing a clean
    // zero-candidate green.
    for (const name of svgNamesIn(join(CANDIDATE_ROOT, dir))) {
      const text = readFileSync(join(CANDIDATE_ROOT, dir, name), 'utf8');
      const m = measureSvg(text);
      out.push({ rel: `render/assets/candidates/${dir}/${name}`, m, band: bandOf(m.vertexCount) });
    }
  }
  return out;
}

describe('the band words this gate prints come from the exported classifier', () => {
  it('resolves the three bands at their exact boundaries, warn band included', () => {
    // THE ANTI-MIRROR CASE. A hand-written "is it under the limit" comparison collapses
    // ok and warn into one answer, so it reports 'ok' at 300 and 399. The classifier
    // does not. This is the assertion that reddens if `bandOf` is ever rewritten to
    // compare against the constant directly.
    expect(bandOf(VERTEX_WARN - 1)).toBe('ok');
    expect(bandOf(VERTEX_WARN)).toBe('warn');
    expect(bandOf(VERTEX_LIMIT - 1)).toBe('warn');
    expect(bandOf(VERTEX_LIMIT)).toBe('fail');
    // The policy constants themselves, in both units. `vertices` is a FLAT STRIDE-2
    // float array, so the limit means fewer than 200 (x, y) POINTS. Half of all readers
    // get this backwards, which is why every message below prints both numbers.
    expect(VERTEX_WARN).toBe(300);
    expect(VERTEX_LIMIT).toBe(400);
    expect(VERTEX_LIMIT / 2).toBe(200);
  });
});

describe('every candidate is measured through Pixi, and none is over budget', () => {
  it('every candidate direction holds exactly the eight expected stems', () => {
    // This gate discovers independently of `candidateLint.test.ts` and pins the same
    // stated literals, so neither spec can be the single point of failure for "is the
    // set complete".
    const perDirection: Array<[string, string[]]> = [];
    for (const dir of AUTHORED_DIRECTIONS) {
      perDirection.push([dir, svgNamesIn(join(CANDIDATE_ROOT, dir))]);
    }
    for (const [dir, names] of perDirection) {
      expect(names, `candidates/${dir}`).toEqual(EXPECTED_FILENAMES);
      expect(names, `candidates/${dir}`).toHaveLength(EXPECTED_PER_DIRECTION);
    }
    expect(perDirection).toHaveLength(AUTHORED_DIRECTIONS.length);
  });

  it('every candidate tessellates to non-zero geometry', () => {
    // ZERO IS NOT THE BEST SCORE. A candidate that tessellates to nothing sails under
    // every threshold - 0 is under the warn line and under the limit, and the classifier
    // legitimately calls it 'ok'. On the board it renders as a BLANK CELL, and a blank
    // cell reads as a tidier, cleaner direction. That is the single most dangerous
    // silent failure this instrument can have, so zero is checked BEFORE the bands.
    //
    // The concrete authoring mistake it catches: `fill="none" stroke="none"` on every
    // path. (`fill="none"` alone with no stroke is worse still - Pixi's `renderChildren`
    // sets `noStyle -> fillStyle = { color: 0 }` and paints a SOLID BLACK SQUARE.)
    const measured = measureAll();
    expect(measured).toHaveLength(EXPECTED_CANDIDATE_COUNT);

    const ghosts = measured
      .filter((x) => x.m.vertexCount === 0)
      .map((x) => `${x.rel}: 0 vertices (0 points) - tessellated to NOTHING`);
    expect(ghosts, ghosts.join('\n')).toEqual([]);
  });

  it('every candidate is inside the vertex budget, and every offender is named', () => {
    const measured = measureAll();

    // THE NON-VACUITY HALF. A walk that found nothing would produce an empty offender
    // list and report the cleanest green in the suite.
    expect(measured).toHaveLength(EXPECTED_CANDIDATE_COUNT);

    // The full table, printed on SUCCESS as well as on failure. These numbers are the
    // recorded finding the board and `57-ART-LOCK.md` are meant to read: a direction's
    // real cost is a measurement, not a description.
    const table = measured
      .map(
        (x) =>
          `  ${x.band.padEnd(4)} ${String(x.m.vertexCount).padStart(4)} verts / ` +
          `${String(x.m.pointCount).padStart(3)} pts  ${x.rel}`,
      )
      .join('\n');
    console.info(
      `candidate vertex budget (limit ${VERTEX_LIMIT} verts / ${VERTEX_LIMIT / 2} pts, ` +
        `warn at ${VERTEX_WARN} verts / ${VERTEX_WARN / 2} pts):\n${table}`,
    );

    const offenders = measured
      .filter((x) => x.band === 'fail')
      .map(
        (x) =>
          `${x.rel}: ${x.m.vertexCount} vertices (${x.m.pointCount} points) - band '${x.band}', ` +
          `limit ${VERTEX_LIMIT} vertices (${VERTEX_LIMIT / 2} points)`,
      );

    // Collected then asserted once, so ONE run names EVERY offender.
    //
    // THE LEGITIMATE RESPONSE TO A FAILURE HERE IS TO HALT AND RECORD IT, not to fix the
    // art. An over-budget candidate is an N12 finding for the board and for
    // `57-ART-LOCK.md` section 5: it is the measured price of that direction, and the
    // lock is only meaningful if the price is on the table. Quietly deleting detail to
    // slip under the ceiling silently art-directs one direction to look cheaper than it
    // is, and then reads forever after as a design choice nobody made.
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `OVER BUDGET - halt and record as an N12 finding, do NOT simplify the art to fit:\n${offenders.join('\n')}`,
    ).toEqual([]);

    // Warn-band candidates are a recorded finding too, surfaced without failing.
    const warned = measured.filter((x) => x.band === 'warn');
    if (warned.length > 0) {
      console.warn(
        `candidates in the WARN band (recorded for 57-ART-LOCK.md, not a failure):\n` +
          warned
            .map((x) => `  ${x.rel}: ${x.m.vertexCount} verts / ${x.m.pointCount} pts`)
            .join('\n'),
      );
    }
  });
});
