// candidateLint.test.ts - the twelve-rule authoring contract, applied to Phase 57's
// art-board DRAFTS (plan 57-04, BOARD-01).
//
// ONE RULE IN THAT CONTRACT MOVED AFTER THE BOARD WAS JUDGED (plan 58-02): `curve` is now
// fail severity rather than warn. The thirty-two committed candidates are curve-free by
// choice, so the promotion costs them nothing and they are NOT re-authored - they are the
// artefact that was judged and they stay byte-identical.
//
// The rule that did NOT move here is `even-coords`. Shipped machine art sits on a 2u
// sub-module, but twelve of these thirty-two carry odd coordinates and re-authoring them
// to satisfy a rule invented after the judgement would falsify the board record. That
// rule is therefore scoped to the shipped subjects in
// `src/render/assets/shippedAssets.test.ts` and is deliberately not a lint rule.
//
// The board is only worth judging if every cell obeys the same rules. A candidate that
// quietly broke the format would either render wrong or render differently from its
// siblings, and either way a DIRECTION would get judged on an artefact of the file
// rather than on the drawing. So the drafts are held to the shipped contract in full,
// at `fail` severity, even though not one of them ships.
//
// THIS IS THE SECOND CALLER OF THE SAME PURE WALKER, never a re-implementation. It
// imports the exported `lintDir` from `scripts/lint-svg.ts` - the same function
// `npm run lint:svg` and `assets/lintSvg.test.ts` drive. A second regex-based checker
// living here would be a second source of truth for the format, and the two would
// disagree on the first rule change. It also deliberately does NOT shell out to the CLI
// entry: that entry reads no argv and no cwd (threat T-56-13), and the only way to keep
// that property true is to never depend on it having arguments.
//
// No `@vitest-environment` docblock: the lint is DOM-free and stays on the project
// default node environment, exactly as `assets/lintSvg.test.ts:13-14` records.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatViolation, lintDir, type Violation } from '../../../../scripts/lint-svg.ts';

/**
 * `render/assets/candidates/` itself - this spec lives in it.
 *
 * `import.meta.dirname`, and NOT the repo's usual
 * `fileURLToPath(new URL('./', import.meta.url))` idiom. This spec runs on the node
 * environment where the URL idiom is safe, but its sibling `candidateBudget.test.ts`
 * runs under jsdom where that idiom throws `ERR_INVALID_URL_SCHEME` (Phase 56's recorded
 * lesson, `vertexBudget.test.ts:66-77`). The two gates walk the same tree, so they use
 * the same accessor: a difference here would be a difference nobody could explain later.
 */
const CANDIDATE_ROOT = import.meta.dirname;

/**
 * THE FOUR CANDIDATE DIRECTIONS, as a stated literal. This is the COMPLETE set, not a
 * running total: D-01 locked four directions plus `TODAY` (which is a pinned reference and
 * NOT a candidate, so it has no directory here). A fifth would make the comparison
 * meaningless - beyond about six directions a side-by-side board stops being judgeable.
 *
 * Raised from `['a', 'b']` by plan 57-05 in the same edit that added the sixteen `c/` and
 * `d/` files, so the bump is VISIBLE IN THE DIFF. That is the whole property
 * `EXPECTED_FIXTURE_COUNT` has in Phase 56: a count that moves silently is a count that
 * proves nothing.
 */
const AUTHORED_DIRECTIONS = ['a', 'b', 'c', 'd'] as const;

/**
 * SUBJECTS PER DIRECTION, as a stated literal - never `EXPECTED_STEMS.length` and never
 * a directory listing. An assertion computed from the same source it is checking cannot
 * fail.
 *
 * IT IS 8 AND NOT 9. There are nine board subjects, but `BELT` is a board subject and NOT
 * a candidate: its art is already locked by `53-BELT-LOCK.md` (Direction B,
 * "Blueprint / clean line", the maintainers' lock, 2026-07-26, all 65 axis cells pinned). Belts
 * are the settled language machine candidates are judged AGAINST, so drawing a belt
 * candidate would re-open a decision this phase does not own.
 */
const EXPECTED_PER_DIRECTION = 8;

/**
 * THE WHOLE COMMITTED SET'S FINAL SIZE: four directions of eight subjects each. This is the
 * complete art board, not a milestone toward one.
 *
 * IT IS 32 AND NOT 36. There are NINE board subjects and four directions, and 9 x 4 = 36 -
 * but `BELT` is a board subject and NOT a candidate. Its art is already locked by
 * `53-BELT-LOCK.md` (Direction B, "Blueprint / clean line", the maintainers' lock, 2026-07-26,
 * all 65 axis cells pinned), so a belt candidate would re-open a decision this phase does
 * not own. Four absent belt cells are the entire difference between 36 and 32.
 *
 * IT IS A LITERAL AND NEVER `AUTHORED_DIRECTIONS.length * EXPECTED_PER_DIRECTION`, and
 * never `readdirSync(...).length`. An assertion computed from the same source it is
 * checking cannot fail: derive this from the directory listing and the gate would agree
 * that sixteen files are sixteen files, thirty-one are thirty-one, and nothing is missing.
 */
const EXPECTED_CANDIDATE_COUNT = 32;

/**
 * THE EIGHT STEMS, stated and sorted. Every direction directory holds exactly these,
 * so a direction that is missing a subject cannot make itself look cleaner than one
 * that has all eight - a missing cell reads on the board as a tidier direction, which
 * is the single most dangerous silent failure the board can have.
 *
 * The count assertion alone does NOT catch a RENAME (eight files are still eight files),
 * which is exactly why this list exists alongside it.
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
 * THE FOOTPRINT EACH STEM IS AUTHORED AT, as an exact `viewBox` string (review WR-13).
 *
 * WHY THIS LIVES HERE AND NOT IN THE LINT. `lint-svg.ts`'s `LEGAL_VIEWBOXES` rule accepts
 * ANY of the four legal boxes for ANY file, because the lint walker is subject-agnostic
 * BY DESIGN - it does not know what a file is meant to depict. That leaves a real hole:
 * a `candidates/a/source.svg` authored at `0 0 96 96` passes the lint, passes the
 * fail-severity gate, and passes the budget gate (the budget is footprint-independent,
 * measured) - and then renders on the board through `extractCell`'s frame of
 * `ceil(1 * 32 * zoom)`, i.e. CROPPED TO ITS TOP-LEFT 32x32 CORNER, with no error
 * anywhere.
 *
 * That is the neutrality failure the board declares fatal, delivered silently: one
 * direction would render a clipped, sparser-looking SOURCE and read as the tidier
 * direction. `candidates/README.md` already prints this mapping in prose - it was
 * documented and unenforced.
 *
 * THE STEM IS KNOWN HERE, so the check belongs here, next to `EXPECTED_STEMS`. The
 * values mirror the board's own `SUBJECTS` footprints at 32u per cell: 1x1 -> 32x32,
 * 2x2 -> 64x64, 2x3 -> 64x96, 3x3 -> 96x96. STATED as literals rather than computed from
 * `SUBJECTS`, for the reason this file states everywhere else: an assertion derived from
 * the source it checks cannot disagree with it.
 *
 * Phase 58 carries the same mapping for the shipped set.
 */
const VIEWBOX_OF_STEM: Readonly<Record<string, string>> = {
  source: '0 0 32 32',
  sink: '0 0 32 32',
  endpoint: '0 0 32 32',
  tee: '0 0 64 64',
  balancer: '0 0 64 64',
  merge: '0 0 64 64',
  router: '0 0 64 96',
  factory: '0 0 96 96',
};

/**
 * The SAME non-recursive `.svg` discovery the lint walker and the budget gate use
 * (`readdirSync` + `isFile()` + `.endsWith('.svg')` + `.sort()`), so all three walkers
 * agree about which files count. Deliberately `readdirSync` rather than a glob package:
 * the board discovers its cells with Vite's `import.meta.glob` and the gates discover
 * with `readdirSync`, DIFFERENT walkers on purpose, and no npm registry entry is opened
 * to do it (threat T-57-SC).
 */
function svgNamesIn(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name)
    .sort();
}

describe('the candidate directions hold the stated set, and every candidate lints clean', () => {
  it('every candidate direction holds exactly the eight expected stems', () => {
    const perDirection: Array<[string, string[]]> = [];

    for (const dir of AUTHORED_DIRECTIONS) {
      // A missing directory THROWS here rather than reporting a clean zero-candidate
      // green. That is the intended behaviour: `readdirSync` on a path that does not
      // exist is louder than any assertion this spec could write.
      const names = svgNamesIn(join(CANDIDATE_ROOT, dir));
      perDirection.push([dir, names]);
    }

    // Reported together, so ONE run names every direction that is wrong.
    const wrong = perDirection
      .filter(([, names]) => names.join(',') !== EXPECTED_FILENAMES.join(','))
      .map(([dir, names]) => `candidates/${dir}: [${names.join(', ')}]`);
    expect(wrong).toEqual([]);

    for (const [dir, names] of perDirection) {
      expect(names, `candidates/${dir}`).toEqual(EXPECTED_FILENAMES);
      // The non-vacuity half: the deep-equal above is satisfiable by a walk that found
      // the right eight names, and this pins the COUNT against the stated literal so a
      // future stem list edited to fewer entries reddens on both assertions.
      expect(names, `candidates/${dir}`).toHaveLength(EXPECTED_PER_DIRECTION);
    }

    expect(perDirection).toHaveLength(AUTHORED_DIRECTIONS.length);
  });

  it('every candidate lints clean at fail severity, and every offender is named', () => {
    const discovered: string[] = [];
    const failures: Violation[] = [];

    for (const dir of AUTHORED_DIRECTIONS) {
      // The EXPORTED pure walker, called with a path resolved inside a first-party spec.
      // Never the CLI entry, never a local copy of the rules.
      const result = lintDir(join(CANDIDATE_ROOT, dir));

      // THE NON-VACUITY HALF, per direction. A walker that discovered nothing would
      // otherwise agree with itself: zero assets produce zero violations, and the
      // zero-violation assertion below would pass on an empty directory. The two
      // assertions are only meaningful as a pair.
      expect(result.assets, `candidates/${dir}`).toHaveLength(EXPECTED_PER_DIRECTION);

      discovered.push(...result.assets);
      failures.push(...result.violations.filter((v) => v.severity === 'fail'));
    }

    // Collected then asserted ONCE, so a single run names EVERY offender. A loop that
    // asserted per file would stop at the first and force an author to run the gate N
    // times to find N problems - the exact iteration tax Phase 56 recorded as the reason
    // for report-all output.
    const rendered = failures.map(formatViolation);
    expect(rendered, rendered.join('\n\n')).toEqual([]);

    // The whole-set count, against the stated literal rather than against the walk.
    expect(discovered).toHaveLength(EXPECTED_CANDIDATE_COUNT);
  });

  it('warn-severity violations are reported without failing (the band is now EMPTY, and that is the finding)', () => {
    // REWRITTEN IN PLAN 58-02, because what this case used to assert became false and a
    // stale docblock over a still-passing test is worse than a red one.
    //
    // WHAT IT USED TO SAY: `curve` is the lint's only warn-severity rule, held at warn as
    // a deliberate abstention because BOARD-02 owned the corner-radius policy and this
    // gate must not pre-judge it. Mutation M5 (plan 57-05) confirmed both halves -
    // introducing a curve left the suite green and named the file in the warn report.
    //
    // WHAT IS TRUE NOW: the policy was locked (axis 5 - radius 0, authored square, zero
    // curve commands), the abstention expired with it, and plan 58-02 promoted `curve` to
    // FAIL. No rule is warn any more, so this walk collects an empty report BY
    // CONSTRUCTION rather than by the candidates' good behaviour.
    //
    // The case is KEPT rather than deleted for two reasons. It still proves the walker
    // separates the bands rather than collapsing them, and - the load-bearing half - a
    // candidate that now carries a curve is caught by the FAIL assertion above instead of
    // being quietly recorded here. That is a real change in what this board's gate does,
    // and it is asserted below rather than described.
    const warnings: Violation[] = [];
    let discovered = 0;

    for (const dir of AUTHORED_DIRECTIONS) {
      const result = lintDir(join(CANDIDATE_ROOT, dir));
      discovered += result.assets.length;
      warnings.push(...result.violations.filter((v) => v.severity === 'warn'));
    }

    // Non-vacuity again: a report over nothing is not a report.
    expect(discovered).toBe(EXPECTED_CANDIDATE_COUNT);

    if (warnings.length > 0) {
      console.warn(
        `candidate warn-severity findings (${warnings.length}) - recorded for the board, not a failure:\n` +
          warnings.map(formatViolation).join('\n'),
      );
    }
    // The warn band is empty because NO RULE IS WARN, not because 32 files behaved. If a
    // future rule is introduced at warn severity, this reddens and whoever introduced it
    // has to decide here whether the board tolerates it.
    expect(warnings).toEqual([]);
  });

  it('a candidate carrying a curve is now a FAILURE, not a recorded warning', () => {
    // THE CONSEQUENCE OF THE 58-02 PROMOTION, asserted on the board's own gate. Mutation
    // M5 (plan 57-05) established that introducing a curve command into a candidate left
    // the suite GREEN. That is no longer true, and the difference is checked here rather
    // than assumed from the severity table: the candidates are held to the shipped
    // contract in full, so a shipped-gate change lands on them too.
    //
    // Written to a temp directory - the committed thirty-two are the artefact that was
    // judged and are not mutated, even transiently, by a test.
    const dir = mkdtempSync(join(tmpdir(), 'fabrico-candidate-curve-'));
    try {
      writeFileSync(
        join(dir, 'source.svg'),
        [
          '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
          '  <path data-part="lens" d="M 4 16 C 4 4 28 4 28 16 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
          '</svg>',
          '',
        ].join('\n'),
      );

      const result = lintDir(dir);
      expect(result.assets).toHaveLength(1);
      const fails = result.violations.filter((v) => v.severity === 'fail');
      expect(fails.map((v) => v.rule)).toEqual(['curve']);
      expect(result.violations.filter((v) => v.severity === 'warn')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no candidate path declares fill="none" together with stroke="none"', () => {
    // ADDED AFTER MUTATION M4 SURVIVED, and the survivor is worth recording rather than
    // quietly patching. M4 replaced a candidate's paths with a single
    // `fill="none" stroke="none"` path expecting the budget gate's `vertexCount > 0`
    // assertion to redden. It did not: MEASURED, that path tessellates to EIGHT vertices,
    // because Pixi treats the declared-but-empty paint as no paint at all and
    // `renderChildren` falls back to `noStyle -> fillStyle = { color: 0 }`. The result is
    // not a blank cell, it is a SOLID BLACK SQUARE - a machine-shaped hole on the board
    // that a zero-geometry check cannot see, because there IS geometry.
    //
    // The twelve rules deliberately do not catch this: `explicit-paint` asks whether a
    // paint was DECLARED, and `stroke="none"` is a declaration. Widening that rule is a
    // Phase 56 lint change and 57-02 owns lint amendments, so this is a CANDIDATES-ONLY
    // assertion in the candidates' own gate rather than a thirteenth rule.
    //
    // It is a text scan over the drawn markup, not a re-implementation of any rule: the
    // header comment is stripped first so a docblock that NAMES the trap (every candidate
    // header does, and so does this one) cannot count as an occurrence - the same
    // strip-then-count discipline plan 57-01's structural gates use.
    const offenders: string[] = [];
    let scanned = 0;

    for (const dir of AUTHORED_DIRECTIONS) {
      for (const name of svgNamesIn(join(CANDIDATE_ROOT, dir))) {
        scanned += 1;
        const markup = readFileSync(join(CANDIDATE_ROOT, dir, name), 'utf8').replace(
          /<!--[\s\S]*?-->/g,
          '',
        );
        markup.split('\n').forEach((line, i) => {
          if (!line.includes('<path')) return;
          if (line.includes('fill="none"') && line.includes('stroke="none"')) {
            offenders.push(
              `render/assets/candidates/${dir}/${name}:${i + 1}  fill="none" with stroke="none" - ` +
                'Pixi paints this a SOLID BLACK SQUARE, not a blank',
            );
          }
        });
      }
    }

    // Non-vacuity: a scan that opened no files is not a scan.
    expect(scanned).toBe(EXPECTED_CANDIDATE_COUNT);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every candidate header declares its own path and the direction it actually sits in', () => {
    // ADDED AFTER MUTATION M4 SURVIVED (plan 57-05), and it is important to be exact about
    // WHAT it closes, because it is NOT M4.
    //
    // M4 copied `c/tee.svg` over `d/tee.svg` so two directions carried byte-identical
    // geometry, and NOTHING reddened: both gates passed, and the budget gate cheerfully
    // measured the C drawing at 98 verts under a `d/` path. That hole is REAL AND IT STAYS
    // OPEN BY DESIGN. These gates check CONFORMANCE (the twelve rules) and COST (the vertex
    // band); they do not check DISTINCTNESS, and they must not. Distinctness is the entire
    // question the art board is being built to put in front of a human, and a machine that
    // pre-answered it - by asserting two directions differ - would be voting on the lock.
    // It would also give false assurance: a byte-equality check goes green the moment one
    // coordinate differs, while the two cells still look identical at 1x.
    //
    // What IS mechanically checkable, and what M4 exposed as unchecked, is a LABELLING
    // defect: the copied file still declared itself `candidates/c/tee.svg - DIRECTION C`
    // while sitting in `d/`. That is a provenance error, not an aesthetic judgement. ART-04
    // provenance is recorded per candidate IN ITS OWN HEADER (threat T-57-17), so a header
    // that describes a different file is a broken provenance record, and provenance
    // reconstructed after a lock is not provenance. Sixteen files authored in one plan is
    // exactly the workload where a copy-paste survives review.
    //
    // ONLY THE SELF-DECLARATION LINE IS READ - the first header line carrying ` - DIRECTION `.
    // Candidate headers deliberately cross-reference their siblings (`c/merge.svg` discusses
    // `c/balancer.svg`; `d/factory.svg` is set against `c/factory.svg`), and those references
    // are the honest comparative reasoning this board runs on. Scanning the whole comment
    // would punish exactly the files that did the most thinking.
    const offenders: string[] = [];
    let scanned = 0;

    for (const dir of AUTHORED_DIRECTIONS) {
      for (const name of svgNamesIn(join(CANDIDATE_ROOT, dir))) {
        scanned += 1;
        const text = readFileSync(join(CANDIDATE_ROOT, dir, name), 'utf8');
        const header = /<!--([\s\S]*?)-->/.exec(text)?.[1] ?? '';
        const declaration = header
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.includes(' - DIRECTION '));

        if (declaration === undefined) {
          offenders.push(
            `render/assets/candidates/${dir}/${name}  no self-declaration line ` +
              '(expected a header line of the form "candidates/<dir>/<file>.svg - DIRECTION <X> draft ...")',
          );
          continue;
        }
        const expectedPath = `candidates/${dir}/${name}`;
        const expectedDirection = `DIRECTION ${dir.toUpperCase()}`;
        if (!declaration.startsWith(expectedPath) || !declaration.includes(expectedDirection)) {
          offenders.push(
            `render/assets/candidates/${dir}/${name}  header declares "${declaration}" - ` +
              `expected it to start with "${expectedPath}" and to name "${expectedDirection}"`,
          );
        }
      }
    }

    // Non-vacuity: a scan that opened no files is not a scan.
    expect(scanned).toBe(EXPECTED_CANDIDATE_COUNT);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every candidate is authored at the footprint its SUBJECT actually has', () => {
    // WR-13. `LEGAL_VIEWBOXES` in the lint is a whitelist of four boxes accepted for any
    // file, so a wrong-footprint asset lints clean and is then silently cropped to its
    // top-left 32x32 corner by `extractCell`'s frame. One direction rendering a clipped
    // SOURCE reads as the tidier direction, which is exactly the advocacy-by-rendering
    // the whole board is built to refuse.
    //
    // EXACT STRING EQUALITY, matching the lint's own comparison discipline: not a regex
    // and not a divisibility test, so a transposed `0 0 96 64` router fails.
    const offenders: string[] = [];
    let scanned = 0;

    for (const dir of AUTHORED_DIRECTIONS) {
      for (const name of svgNamesIn(join(CANDIDATE_ROOT, dir))) {
        scanned += 1;
        const stem = name.replace(/\.svg$/, '');
        const expected = VIEWBOX_OF_STEM[stem];
        if (expected === undefined) {
          offenders.push(
            `render/assets/candidates/${dir}/${name}  stem "${stem}" has no stated footprint - ` +
              'add it to VIEWBOX_OF_STEM deliberately, never widen the check',
          );
          continue;
        }
        const text = readFileSync(join(CANDIDATE_ROOT, dir, name), 'utf8');
        const actual = /viewBox="([^"]*)"/.exec(text)?.[1];
        if (actual !== expected) {
          offenders.push(
            `render/assets/candidates/${dir}/${name}  viewBox="${actual ?? '<none>'}" - ` +
              `expected "${expected}" for a ${stem}. A wrong footprint is not a lint error: ` +
              'it renders CROPPED on the board, with no error anywhere.',
          );
        }
      }
    }

    // Non-vacuity: the whole committed set, or this assertion proves nothing.
    expect(scanned).toBe(EXPECTED_CANDIDATE_COUNT);
    expect(Object.keys(VIEWBOX_OF_STEM).sort()).toEqual([...EXPECTED_STEMS].sort());
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
