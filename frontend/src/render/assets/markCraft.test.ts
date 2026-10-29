// markCraft.test.ts - the vitest caller for the 16px craft-rule instrument (plan 79-01).
//
// This is the SECOND of the instrument's two callers: `npm run check:mark-craft` drives the
// authoring loop, and this spec makes `npm test` and the CI unit job measure the same
// drawings through the same pure walker. No re-implementation, no new CI job:
// `.github/workflows/ci.yml:1016-1017` records why `lint:svg` is deliberately absent from CI,
// namely that the vitest caller drives the same walker so a second invocation asserts the
// same thing twice. This spec is that caller for the craft script, which is what makes the
// pin run on every commit for free.
//
// WHAT THIS SPEC IS ACTUALLY FOR. A craft script that passes everything it is pointed at is
// this repository's signature defect class, fourteen instances found historically and eight
// in Phase 67 alone. The cases below are ordered so the two that close that hole come last
// and read hardest: `the check can fail` MEASURES the shipped mark rather than reading its
// pinned row, and `expectations` asserts the pinned row cannot be flattened in EITHER
// direction. A pin edited until everything passes reddens here, and so does a pin edited
// until everything fails.
//
// No `@vitest-environment` docblock. The project default is the node environment, and that
// is what lets this spec import a module which resolves its paths from `import.meta.url`.
// A jsdom spec touching disk would have to use `import.meta.dirname` instead, the trap
// documented three times at `render/assets/vertexBudget.test.ts:66-92`.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASSET_DIR, CHROME_ASSET_DIR, lintDir } from '../../../scripts/lint-svg.ts';
import {
  CANDIDATES_DIR,
  SHIPPED_MARK,
  candidateFiles,
  diffAgainstExpectations,
  hasIllegalComment,
  illegalCommentLine,
  loadExpectations,
  measureAll,
  measureCut,
  servesOf,
  type CutMeasurement,
  type ExpectationRow,
} from '../../../scripts/mark-craft.ts';

/**
 * The one candidate committed by plan 79-01, named as a NON-VACUITY FLOOR.
 *
 * Deliberately a named file rather than an asset count. A count would have to be
 * hand-edited from 1 to 7 the moment plan 79-02 draws Candidates A, B and C, and a literal
 * that reddens on correct work teaches an executor to edit the assertion. A named file that
 * must be present is the property actually worth holding: a walk over nothing cannot
 * satisfy it, and adding six more candidates does not disturb it.
 */
const FLOOR_CANDIDATE = 'd-the-board-pixel.svg';

/**
 * THE RETIRED PHASE 59 MARK, committed as this file's NEGATIVE SUBJECT (plan 80-05).
 *
 * Four cases below exist to prove an instrument can fail, and until plan 80-05 all four used
 * the SHIPPED mark for that: the shipped file was not valid XML and it failed three of the
 * four craft rules. Composition A is valid XML and passes all four, so replacing the asset
 * turned every one of those cases green BY REMOVING ITS SUBJECT - a vacuous pass in the
 * exact shape of a fix, which is this repository's signature defect class. The retired
 * geometry is committed instead, and the four cases were re-anchored onto it in the same
 * commit that replaced the asset.
 *
 * MEASURED, NEVER PINNED. It lives outside `CANDIDATES_DIR`, so `measureAll()` never
 * discovers it and it has no row in `mark-craft.expected.json`. That is deliberate: a
 * fixture read through the pin could be made to agree with a broken script by editing the
 * pin, which is the failure these cases exist to catch. It is measured directly through
 * `measureCut`, and `measureAll()` must never grow a path argument to reach it (T-79-01).
 */
const CRAFT_FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/craft/', import.meta.url));
const RETIRED_MARK = join(CRAFT_FIXTURE_DIR, 'retired-logomark-59.svg');

/** Both shipped asset directories, walked for the comment-legality positive half. */
const SHIPPED_ASSET_DIRS: readonly string[] = [ASSET_DIR, CHROME_ASSET_DIR];

/** A minimal conforming drawing. `parts` is the inner markup, one self-closing path per line. */
function svg(parts: string): string {
  return `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n${parts}\n</svg>\n`;
}

const INK = 'var(--fab-ink)';
const ACCENT = 'var(--fab-accent-item)';
const PANEL = 'var(--fab-panel-fill)';

/**
 * D-01's belt band, verbatim: one `<path>` with a panel-grey fill and a 2u ink outline.
 * Named rather than inlined because plan 80-05 pins the composition this band belongs to,
 * and a reader comparing the two must be able to see the same string in both places.
 */
const FILL_AND_STROKE_ONE_PATH = `  <path data-part="rail" d="M 3 23 H 29 V 29 H 3 Z" fill="${PANEL}" stroke="${INK}" stroke-width="2" />`;

/**
 * Two `<path>` elements of the SAME ink whose painted cells share the edge at x=14.
 *
 * The other half of the mutation pair. A rule that simply merged every adjacent ink cell
 * would report 1 here and still satisfy the fill-and-stroke case above, so this fixture is
 * what makes that case mean something. It is also the shape the superseded per-colour
 * docblock feared, "the full-bleed tile swallows the count", answered rather than dropped.
 */
const TWO_TOUCHING_PATHS_ONE_COLOUR =
  `  <path data-part="a" d="M 4 4 H 14 V 14 H 4 Z" fill="${INK}" />\n` +
  `  <path data-part="b" d="M 14 4 H 24 V 14 H 14 Z" fill="${INK}" />`;

/**
 * D-01's composition A, the toolbar square that was chosen: a framed cell holding the amber item
 * above a plain belt band. The three `d` strings and their paints are transcribed from
 * `80-CONTEXT.md` D-01's sketch paragraph.
 *
 * Its four measured cells are what plan 80-05 pins into `mark-craft.expected.json`. They are
 * asserted here as literal strings so 80-05 transcribes a measurement rather than a number
 * repeated from a plan document.
 */
const COMPOSITION_A =
  `${FILL_AND_STROKE_ONE_PATH}\n` +
  `  <path data-part="cell" d="M 9 3 H 23 V 17 H 9 Z" fill="none" stroke="${INK}" stroke-width="2" />\n` +
  `  <path data-part="item" d="M 12 6 H 20 V 14 H 12 Z" fill="${ACCENT}" />`;

let tmpRoot: string;

/** Write a fixture and measure it as a 16px cut. */
function measureFixture(name: string, body: string, serves: 16 | null = 16): CutMeasurement {
  const abs = join(tmpRoot, name);
  writeFileSync(abs, body);
  return measureCut(abs, serves);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fabrico-mark-craft-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('mark-craft valid XML - the doubled-hyphen detector is not inert', () => {
  it('refuses a comment body carrying a double hyphen', () => {
    // The exact shape the shipped mark gets wrong: a provenance header naming its paint
    // tokens in their var(...) form. `--` is illegal inside an XML comment by the XML 1.0
    // specification, and every strict parser refuses the whole document.
    const bad = `<!--\n  1. tile  fill  var(--fab-panel-fill)\n-->\n${svg('  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z" fill="' + INK + '" />')}`;
    expect(hasIllegalComment(bad)).toBe(true);
  });

  it('refuses an unterminated comment', () => {
    // An unterminated comment swallows the rest of the document. Reporting it clean would
    // mean measuring a drawing whose geometry the parser never reached.
    expect(hasIllegalComment('<!-- this comment never closes\n<svg viewBox="0 0 32 32"></svg>\n')).toBe(true);
  });

  it('accepts a legal header that names its tokens without the leading dashes', () => {
    // The positive half. Without it the detector could be `return true` and every negative
    // case above would still pass, which is a detector that cannot distinguish anything.
    const good = `<!--\n  1. source  fill  fab-ink\n  2. sink    fill  fab-accent-item\n-->\n${svg('  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z" fill="' + INK + '" />')}`;
    expect(hasIllegalComment(good)).toBe(false);
  });

  it('finds the defect in a REAL committed file, which is the live proof', () => {
    // RE-ANCHORED IN PLAN 80-05, AND THE REASON IS THE WHOLE POINT OF THIS CASE. It used to
    // read `expect(hasIllegalComment(readFileSync(SHIPPED_MARK, 'utf8'))).toBe(true)`, with
    // a comment saying it was "expected to redden in Phase 80, in the commit that rewrites
    // that file, and that is the correct time for it to change". This is that commit.
    //
    // The subject moved rather than the assertion being deleted or loosened. The shipped
    // mark is now VALID, so it can no longer be the negative subject; the committed lint
    // fixture is. It is still a real file on disk rather than a string built to fire, which
    // is the property this case has always been about.
    const fixture = fileURLToPath(
      new URL('./__fixtures__/lint/comment-hyphen.svg', import.meta.url),
    );
    expect(hasIllegalComment(readFileSync(fixture, 'utf8'))).toBe(true);
    expect(illegalCommentLine(readFileSync(fixture, 'utf8'))).toBe(8);
  });

  it('finds NO defect in any file in EITHER shipped asset directory', () => {
    // THE POSITIVE HALF, AND THE ONE THAT WOULD HAVE CAUGHT THREE FILES A MILESTONE AGO.
    // Plan 79-01 checked exactly one shipped file, the mark, because that was the file it
    // was looking at. `save.svg`, `trash.svg` and `warning.svg` carried the same defect the
    // whole time - trash.svg carried it twice - and nothing looked. A named file is a note;
    // a walk is a gate. Plan 80-05 fixed all four and this is what keeps them fixed.
    //
    // The walk is asserted non-empty FIRST, per directory. A directory that walked to
    // nothing reports no illegal comment and would satisfy the loop below without executing
    // one iteration of it.
    for (const dir of SHIPPED_ASSET_DIRS) {
      const names = readdirSync(dir).filter((n) => n.endsWith('.svg'));
      expect(names.length, `${dir} walked to nothing`).toBeGreaterThan(0);
      for (const name of names) {
        expect(
          illegalCommentLine(readFileSync(join(dir, name), 'utf8')),
          `${name} carries an XML comment a strict parser refuses`,
        ).toBeNull();
      }
    }
  });

  it('accepts every committed candidate, so the rule is one candidates can meet', () => {
    const names = candidateFiles();
    expect(names).toContain(FLOOR_CANDIDATE);
    for (const name of names) {
      expect(hasIllegalComment(readFileSync(join(CANDIDATES_DIR, name), 'utf8'))).toBe(false);
    }
  });
});

describe('mark-craft dialect - the candidates are held to the shipped chrome-asset rules', () => {
  it('walks the candidates directory clean, over a walk that is provably not empty', () => {
    const result = lintDir(CANDIDATES_DIR, { chromeInk: true });
    // The floor comes FIRST. A zero-asset walk also reports zero violations, so asserting
    // the violations alone is a green a renamed directory would satisfy.
    expect(result.assets).toContain(FLOOR_CANDIDATE);
    expect(result.violations).toEqual([]);
  });

  it('names a violation in a deliberately non-conforming file', () => {
    // The negative half, and the reason the green above means anything. `chromeInk` is the
    // setting that forces token paints: a candidate authored with a literal hex fails by
    // name, which is what the monochrome cut on the sheet depends on, since that cut is a
    // token remap and only works on token-painted geometry.
    const dir = mkdtempSync(join(tmpRoot, 'dialect-'));
    writeFileSync(join(dir, 'literal-hex.svg'), svg('  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z" fill="#b0bacb" />'));
    const result = lintDir(dir, { chromeInk: true });
    expect(result.assets).toEqual(['literal-hex.svg']);
    expect(result.violations.map((v) => v.rule)).toContain('chrome-ink');
    expect(result.violations[0]?.message).toBe('fill="#b0bacb" is not a chrome ink');
  });
});

describe('mark-craft craft rules - one fixture per rule, each pinning that rule boundary', () => {
  it('R1 passes at the three-shape ceiling and fails one shape past it', () => {
    const three = 'M 4 4 H 8 V 8 H 4 Z M 12 4 H 16 V 8 H 12 Z M 20 4 H 24 V 8 H 20 Z';
    const four = `${three} M 4 12 H 8 V 16 H 4 Z`;
    expect(measureFixture('r1-three.svg', svg(`  <path data-part="a" d="${three}" fill="${INK}" />`)).r1.text).toBe(
      'PASS 3 shapes',
    );
    expect(measureFixture('r1-four.svg', svg(`  <path data-part="a" d="${four}" fill="${INK}" />`)).r1.text).toBe(
      'FAIL 4 shapes',
    );
  });

  it('R1 reports INFO on a full cut, because the shape ceiling is a 16px rule', () => {
    const four = 'M 4 4 H 8 V 8 H 4 Z M 12 4 H 16 V 8 H 12 Z M 20 4 H 24 V 8 H 20 Z M 4 12 H 8 V 16 H 4 Z';
    const cut = measureFixture('r1-full.svg', svg(`  <path data-part="a" d="${four}" fill="${INK}" />`), null);
    expect(cut.r1.text).toBe('INFO 4 shapes');
    // INFO is not a pass and not a fail. A full cut that read PASS would let a 32px-only
    // drawing claim it cleared a rule it was never measured against.
    expect(cut.r1.kind).toBe('INFO');
  });

  it('R2 passes a 2u bar and fails a 1u bar', () => {
    expect(measureFixture('r2-two.svg', svg(`  <path data-part="a" d="M 4 4 H 6 V 20 H 4 Z" fill="${INK}" />`)).r2.text).toBe(
      'PASS 2u',
    );
    expect(measureFixture('r2-one.svg', svg(`  <path data-part="a" d="M 4 4 H 5 V 20 H 4 Z" fill="${INK}" />`)).r2.text).toBe(
      'FAIL 1u',
    );
  });

  it('R2 rasterises STROKES, not only fills, or a stroked frame measures as empty', () => {
    // Load-bearing rather than an optimisation. Without stroke rasterisation the shipped
    // mark has almost no fill to measure and its R2 and R4 verdicts cannot be produced at
    // all, and Candidate C's outlined source cell would measure as nothing.
    const cut = measureFixture(
      'r2-stroke.svg',
      svg(`  <path data-part="a" d="M 5 5 H 25 V 25 H 5 Z" fill="none" stroke="${INK}" stroke-width="2" />`),
    );
    expect(cut.r2.text).toBe('PASS 2u');
  });

  it('R3 reports n/a with no diagonal, fails a 2u diagonal and passes a 4u diagonal', () => {
    const box = `  <path data-part="a" d="M 4 4 H 12 V 12 H 4 Z" fill="${INK}" />`;
    expect(measureFixture('r3-none.svg', svg(box)).r3.text).toBe('n/a');
    expect(
      measureFixture('r3-two.svg', svg(`  <path data-part="a" d="M 8 8 L 20 20" fill="none" stroke="${INK}" stroke-width="2" />`))
        .r3.text,
    ).toBe('FAIL 2u');
    expect(
      measureFixture('r3-four.svg', svg(`  <path data-part="a" d="M 8 8 L 20 20" fill="none" stroke="${INK}" stroke-width="4" />`))
        .r3.text,
    ).toBe('PASS 4u');
  });

  it('R3 fails a FILLED diagonal at 0u rather than excusing it as n/a', () => {
    // The documented non-permissive choice. A filled diagonal wedge has no stroke-width to
    // measure, and reporting n/a would let a drawing carry an unmeasurable diagonal and
    // still print a clean row.
    expect(
      measureFixture('r3-filled.svg', svg(`  <path data-part="a" d="M 4 4 L 12 12 H 4 Z" fill="${INK}" />`)).r3.text,
    ).toBe('FAIL 0u');
  });

  it('R4 passes a 2u gap and fails a 1u gap', () => {
    expect(
      measureFixture(
        'r4-two.svg',
        svg(`  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z M 10 4 H 14 V 8 H 10 Z" fill="${INK}" />`),
      ).r4.text,
    ).toBe('PASS 2u');
    expect(
      measureFixture(
        'r4-one.svg',
        svg(`  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z M 9 4 H 13 V 8 H 9 Z" fill="${INK}" />`),
      ).r4.text,
    ).toBe('FAIL 1u');
  });

  it('R4 reports OVERLAP when two shapes touch, and OVERLAP is never a pass', () => {
    // Candidate B-16's real case: the amber item sits ON the band with no gap, so with the
    // accent removed the two are one shape. Two different paints, because two touching runs
    // of the SAME paint are one component and there would be no pair to measure.
    const cut = measureFixture(
      'r4-touch.svg',
      svg(
        `  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z" fill="${INK}" />\n` +
          `  <path data-part="b" d="M 8 4 H 12 V 8 H 8 Z" fill="${ACCENT}" />`,
      ),
    );
    expect(cut.r4.text).toBe('OVERLAP');
    expect(cut.r4.kind).toBe('OVERLAP');
    expect(cut.r4.kind).not.toBe('PASS');
  });

  it('R4 reports n/a, NOT pass, for a pair sharing no row and no column', () => {
    // THE CASE THAT DECIDES WHETHER R4 IS A REAL RULE. Two diagonal neighbours have no
    // shared scanline, so there is no gap to measure along one. Inventing PASS here would
    // turn R4 into a rule that quietly passes any sufficiently scattered mark, and no
    // committed input exercises this branch: the shipped mark and Candidate D both have a
    // measurable pair, so the pin alone cannot catch the mutation. This fixture is the only
    // thing standing between that branch and silence.
    const cut = measureFixture(
      'r4-diagonal-neighbours.svg',
      svg(`  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z M 12 12 H 16 V 16 H 12 Z" fill="${INK}" />`),
    );
    expect(cut.r4.text).toBe('n/a');
    expect(cut.r4.kind).toBe('NA');
    expect(cut.r4.kind).not.toBe('PASS');
  });

  it('classifies a *-full.svg filename as a full cut and everything else as a 16px cut', () => {
    // The `serves` convention the INFO branch above depends on, stated as a checked fact
    // rather than as a comment. Candidate D serves 16px, 32px and 96px from one drawing,
    // which is why it is not named `-full`.
    expect(servesOf('a-port-square-full.svg')).toBeNull();
    expect(servesOf('a-port-square-16.svg')).toBe(16);
    expect(servesOf(FLOOR_CANDIDATE)).toBe(16);
  });
});

describe('mark-craft shapes - one path is one shape, two paths are two', () => {
  it('counts one path carrying BOTH a fill and a stroke as ONE shape', () => {
    // D-09, and the direction the ruling is about. This is D-01's belt band verbatim: a
    // panel-grey interior inside its own ink outline, drawn by a single `<path>`. Under the
    // Phase 79 rule, which split components per distinct non-void colour, it measured two
    // shapes and pushed composition A to `FAIL 4 shapes` against a ceiling of three. This
    // band was compared beside a hollow one that passed as drawn and was chosen.
    //
    // MUTATION THAT REDDENS THIS CASE: revert the identity test in `components()` to compare
    // the resolved COLOUR of the neighbour against the seed's colour, and this reports 2.
    expect(measureFixture('shapes-fill-and-stroke.svg', svg(FILL_AND_STROKE_ONE_PATH)).r1.text).toBe('PASS 1 shapes');
  });

  it('counts two TOUCHING paths of the same colour as TWO shapes', () => {
    // The opposite direction, and the reason the case above is not satisfied by a rule that
    // merged everything. Two ink squares sharing the edge at x=14 were ONE component under
    // the Phase 79 per-colour rule and are two under D-09's per-path rule, which is strictly
    // finer wherever a colour is shared across paths.
    //
    // MUTATION THAT REDDENS THIS CASE: change the identity test in `components()` to join
    // any adjacent non-void neighbour whatever painted it, and this reports 1.
    expect(measureFixture('shapes-two-touching-ink.svg', svg(TWO_TOUCHING_PATHS_ONE_COLOUR)).r1.text).toBe(
      'PASS 2 shapes',
    );
  });

  it('still counts two touching paths of DIFFERENT colours as two shapes', () => {
    // The colour axis was not weakened by moving identity onto the path. Same geometry as
    // the case above with the second square repainted amber: two before D-09, two after.
    //
    // MUTATION THAT REDDENS THIS CASE: the same merge-everything mutation, which reports 1
    // here too. Kept as its own case because a future rule could special-case colour and
    // this is where that would be caught.
    const body =
      `  <path data-part="a" d="M 4 4 H 14 V 14 H 4 Z" fill="${INK}" />\n` +
      `  <path data-part="b" d="M 14 4 H 24 V 14 H 14 Z" fill="${ACCENT}" />`;
    expect(measureFixture('shapes-two-touching-inks.svg', svg(body)).r1.text).toBe('PASS 2 shapes');
  });

  it('measures D-01 composition A as PASS on every measurable rule, with no touching pair', () => {
    // THE ROW PLAN 80-05 PINS. All four cells asserted as literal strings, because 80-05
    // transcribes a measurement and must not repeat a number read out of a plan document.
    //
    // The last assertion is D-09's re-check of R4. Research measured composition A with
    // `1 pair(s) touch`, and that pair was the belt band's own fill against its own stroke.
    // `components()` feeds R4's pair enumeration, so the pair stopped existing when the two
    // became one shape. If it comes back, the identity change did not reach R4 and the
    // square is being judged on a stale pair set.
    //
    // MUTATION THAT REDDENS THIS CASE: give the belt a second colour on a second path and
    // R1 reports 4 shapes.
    const cut = measureFixture('shapes-composition-a.svg', svg(COMPOSITION_A));
    expect(cut.r1.text).toBe('PASS 3 shapes');
    expect(cut.r2.text).toBe('PASS 2u');
    expect(cut.r3.text).toBe('n/a');
    expect(cut.r4.text).toBe('PASS 2u');
    expect(cut.r4.why).not.toMatch(/pair\(s\) touch/);
  });
});

describe('mark-craft the check can fail - measured on the retired mark, not read from the pin', () => {
  // RE-ANCHORED IN PLAN 80-05. Both cases below measured `SHIPPED_MARK` until the commit
  // that replaced it. Composition A passes all four rules, so leaving them pointed at the
  // shipped file would have turned this whole describe green by deleting its subject -
  // a check that cannot fail, arriving disguised as a mark landing. The subject moved to
  // `RETIRED_MARK`, which is the same drawing they were always measuring, now committed as
  // a fixture instead of as the shipped asset. Not one number changed.
  it('measures the retired mark as FAIL R1, PASS R2, FAIL R3, FAIL R4', () => {
    // D-05. This is the whole device, and every value here is MEASURED: nothing in this
    // case reads `mark-craft.expected.json`, so a pin edited to agree with a broken script
    // cannot make it green. That property is why the subject had to be a real committed
    // drawing rather than the pin's own row.
    //
    // Why five shapes and not seven, so the arithmetic is not rediscovered and repaired the
    // wrong way. The retired mark declares six layers. `--fab-outline` and
    // `--fab-edge-shadow` both resolve to `#1b1f27`, the ground, so both are void under the
    // buffer rule, and `outline` sits outside the live area anyway. `--fab-edge-lit` and
    // `--fab-ink` both resolve to `#b0bacb`, so the lit bevel and the two chevrons are the
    // same ink, but they are painted by different paths and R1 counts per-path components
    // (D-09). What survives in units 2 to 30 is the tile remainder, the lit bevel L, two
    // disconnected chevrons and the item dot. Five.
    const cut = measureCut(RETIRED_MARK, 16);
    expect(cut.r1.kind).toBe('FAIL');
    expect(cut.r1.value).toBe(5);
    expect(cut.r2.kind).toBe('PASS');
    expect(cut.r2.value).toBe(26);
    expect(cut.r3.kind).toBe('FAIL');
    expect(cut.r3.value).toBe(2);
    expect(cut.r4.kind).toBe('FAIL');
    expect(cut.r4.value).toBe(1);
    expect(cut.r4.why).toContain('4 pair(s) touch');
  });

  it('measures a mix: the retired mark fails three rules and passes exactly one', () => {
    // A script that failed EVERYTHING would satisfy the case above on three of its four
    // assertions and is caught by this one. The mix is what makes the instrument
    // discriminating rather than merely strict.
    //
    // THE ANTI-FLATTENING PROPERTY LIVES HERE NOW (plan 80-05). It used to be held over the
    // pin file, by "THE PIN CANNOT BE FLATTENED" below, which required the shipped row to
    // carry both a FAIL and a PASS - a requirement a conforming shipped mark cannot meet. A
    // measurement cannot be satisfied by editing a pin, so this is the stronger place for it
    // to live and the inversion below cost the suite nothing.
    const cut = measureCut(RETIRED_MARK, 16);
    const kinds = [cut.r1.kind, cut.r2.kind, cut.r3.kind, cut.r4.kind];
    expect(kinds.filter((k) => k === 'FAIL')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'PASS')).toHaveLength(1);
  });

  it('measures the SHIPPED mark as PASSING all four rules, read from the drawing not the pin', () => {
    // ADDED IN PLAN 80-05, and it is the positive half the describe above needs. Without it
    // the instrument's only committed subject is a drawing that fails, and a script that
    // reported FAIL on everything would satisfy every assertion above. The shipped mark is
    // the positive subject now and the retired one is the negative, which is the pairing
    // this file has always required of a detector.
    //
    // MEASURED, NEVER READ FROM `mark-craft.expected.json`. The four cells below are the
    // literal strings plan 80-03 recorded for composition A when it corrected the shape
    // counter, so this case and the pinned row are two independent transcriptions of one
    // measurement rather than one of them copying the other.
    const cut = measureCut(SHIPPED_MARK, 16);
    expect(cut.r1.text).toBe('PASS 3 shapes');
    expect(cut.r2.text).toBe('PASS 2u');
    expect(cut.r3.text).toBe('n/a');
    expect(cut.r4.text).toBe('PASS 2u');
    // R4's `why` is empty on a clean row. Research measured composition A with `1 pair(s)
    // touch` before D-09 corrected the shape counter; that pair was the belt band's own fill
    // against its own stroke and it stopped existing when the two became one shape. If it
    // returns, the square is being judged on a stale pair set.
    expect(cut.r4.why).not.toMatch(/pair\(s\) touch/);
  });
});

describe('mark-craft expectations - the pin is complete, agreed, and cannot be flattened', () => {
  it('parses, is non-empty, and its key set equals the discovered input set in BOTH directions', () => {
    // Threat T-79-04. A script pointed at a renamed directory agrees with itself: it
    // discovers nothing, compares nothing, and reports clean. Equality in both directions is
    // what makes that impossible, and the non-empty assertion is what makes the equality
    // mean something rather than being `[] === []`.
    const pin = loadExpectations();
    const pinned = Object.keys(pin).sort();
    const discovered = measureAll().map((c) => c.file).sort();
    expect(pinned.length).toBeGreaterThan(0);
    expect(discovered).toContain('logomark.svg');
    expect(discovered).toContain(FLOOR_CANDIDATE);
    expect(pinned).toEqual(discovered);
  });

  it('agrees with every measurement, cell for cell', () => {
    expect(diffAgainstExpectations(measureAll())).toEqual([]);
  });

  it('THE SHIPPED ROW CARRIES NO FAIL AND NO OVERLAP: a mark that fails a craft rule reddens', () => {
    // INVERTED IN PLAN 80-05, NOT DELETED, AND HERE IS WHY THE INVERSION IS THE HONEST MOVE.
    //
    // This case used to read "THE PIN CANNOT BE FLATTENED: the logomark row holds at least
    // one FAIL and one PASS", and it was written to survive an executor taking the cheapest
    // route out of a red: a pin edited until everything passes reddened here, and so did a
    // pin edited until everything fails. That was correct for as long as the shipped mark
    // was the instrument's committed failing subject.
    //
    // It cannot hold for a conforming mark. Composition A passes all four rules, so the
    // requirement "the shipped row holds at least one FAIL" is now a requirement that the
    // shipped brand mark be BAD. That is the tail wagging the dog: shipping a mark that
    // fails a craft rule in order to keep an assertion green would be letting the instrument
    // dictate the artwork, which is exactly what D-09 refused when it corrected the shape
    // counter rather than hollowing out the belt band.
    //
    // The anti-flattening property was not dropped on the way past. It moved to
    // `measures a mix: the retired mark fails three rules and passes exactly one`, which is
    // a MEASUREMENT over a committed drawing and therefore cannot be satisfied by editing
    // this file at all - strictly stronger than where it used to live.
    //
    // What is asserted here now is the other direction, and it is a live gate rather than a
    // formality: the shipped row must stay clean. Ship a mark whose shapes overlap, whose
    // gaps close below 2u or whose count passes three, and criterion 5's promise that every
    // gate binding the mark moves WITH the mark reddens right here.
    const row = loadExpectations()['logomark.svg'];
    expect(row).toBeDefined();
    const pinned = row as ExpectationRow;
    // The four cells named rather than reflected over, so a rule silently dropped from
    // `ExpectationRow` reddens here instead of shrinking the set this case inspects.
    const cells = [pinned.r1, pinned.r2, pinned.r3, pinned.r4].map(String);
    expect(cells).toHaveLength(4);
    expect(
      cells.filter((c) => c.startsWith('FAIL')),
      'the shipped mark is pinned as failing a craft rule',
    ).toEqual([]);
    expect(
      cells.filter((c) => c.startsWith('OVERLAP')),
      'the shipped mark is pinned with two shapes touching',
    ).toEqual([]);
    // NON-VACUITY: a row of four empty strings would satisfy both filters above. Every cell
    // must carry a real verdict word.
    for (const cell of cells) {
      expect(cell, `a pinned cell on the shipped row reads ${JSON.stringify(cell)}`).toMatch(
        /^(PASS|INFO|n\/a)/,
      );
    }
  });

  it('reports a mismatch when a discovered input has no pinned row', () => {
    // The negative half of the agreement case. Without it, `diffAgainstExpectations`
    // returning `[]` proves only that it returns `[]`.
    const invented: CutMeasurement[] = [
      ...measureAll(),
      measureFixture('unpinned.svg', svg(`  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z" fill="${INK}" />`)),
    ];
    const mismatches = diffAgainstExpectations(invented);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.every((m) => m.input === 'unpinned.svg')).toBe(true);
    expect(mismatches[0]?.expected).toBe('(no row in mark-craft.expected.json)');
  });
});
