// lintSvg.test.ts - the vitest caller for the constrained-SVG lint (plan 56-04).
//
// This is the SECOND of the lint's two callers: `npm run lint:svg` drives the local
// authoring loop, and this spec makes `npm test` and the CI unit job enforce the exact
// same rules through the exact same pure walker - no re-implementation, no new CI job.
//
// Every rule gets a permanent fixture that proves its failure mode BY NAME AND LINE, so
// a future edit that silently drops a rule reddens here rather than shipping a
// non-conforming asset. The empty, malformed and zero-byte cases exist because the
// classic lint failure is not a wrong error - it is a VACUOUS GREEN: a walk that found
// nothing, or that skipped an unreadable file, and then printed "0 violations".
//
// No `@vitest-environment` docblock: the lint is DOM-free and stays on the project
// default node environment.

import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSET_DIR,
  BRAND_DIR,
  BRAND_RULES,
  CHROME_ASSET_DIR,
  CHROME_BRAND_DIR,
  RULES,
  formatViolation,
  lintDir,
  lintFile,
  report,
  type RuleId,
  type Violation,
} from '../../../scripts/lint-svg.ts';

const FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/lint/', import.meta.url));
const FIXTURE_REL = 'render/assets/__fixtures__/lint';

/**
 * THE FIXTURE SET'S OWN COMMITTED SIZE, as a literal - twelve single-rule fixtures plus
 * the conforming control. NEVER derived from `RULES.length` or from the directory
 * listing, because an assertion computed from the same source it is checking cannot
 * fail. Delete a fixture and this reddens.
 *
 * The FOURTEENTH fixture (plan 57-02) is `bad-viewbox-96x64.svg`, and it is a second
 * fixture for the `viewbox` rule rather than a thirteenth rule: it is the DISCRIMINATOR
 * for the four-literal `LEGAL_VIEWBOXES` whitelist. `0 0 96 64` is a transposed `Router` -
 * a multiple of 32 on both axes and a footprint no machine has - so it is the one value a
 * `/^0 0 (\d+) (\d+)$/` + `% 32 === 0` generalisation of the whitelist would survive.
 *
 * 14 -> 15 BY HAND in plan 58-02. The FIFTEENTH fixture is `odd-coords.svg`, and it is the
 * one fixture in this directory THIS LINT DOES NOT FIRE ON - see `CLEAN_FIXTURE_COUNT`
 * below. `even-coords` is enforced over the shipped machine subjects by
 * `shippedAssets.test.ts`, not by the subject-agnostic walker, and the fixture lives here
 * because this directory is where the format's failure modes are demonstrated.
 *
 * 15 -> 16 BY HAND (phase 59 review WR-01). The SIXTEENTH fixture is
 * `non-self-closing-path.svg`, and like `bad-viewbox-96x64.svg` it is a second fixture
 * for an existing rule rather than a new one: `<path ...></path>` is markup this walker
 * and Pixi both accept and `chrome/svgToElements.ts` silently DROPS, so the file used to
 * pass every gate while rendering an incomplete DOM icon. It is filed under `path-only`
 * because the property is the same one - what the format allows a `<path>` to look like.
 *
 * 16 -> 17 BY HAND (phase 80, plan 80-05). The SEVENTEENTH fixture is `comment-hyphen.svg`,
 * and unlike the two above it IS a new rule: `comment-hyphen`, the fourteenth id in
 * `RULE_IDS`. Its comment body names a paint token in the full `var(--fab-*)` form, and the
 * doubled hyphen that makes it illegal is the exact defect four shipped chrome assets
 * carried for a milestone under a walker that read them every commit - `parseSvg` seeks a
 * comment's `-->` and never inspects the body, so nothing had ever looked. The fixture is
 * what makes the rule provable rather than merely present, and the one-fixture-per-rule case
 * below is what forces it to exist.
 */
const EXPECTED_FIXTURE_COUNT = 17;

/**
 * The two fixtures in this directory that produce NO lint violation, stated as a literal
 * so the arithmetic below reads as a fact rather than as an off-by-one:
 *
 *   - `conforming.svg` - the control, clean by construction.
 *   - `odd-coords.svg` - clean HERE by design. Its rule (`even-coords`) is subject-scoped
 *     and lives in `shippedAssets.test.ts`; the lint walker does not know what a file is
 *     meant to depict, and both `pilot.svg` and twelve judged board candidates carry odd
 *     coordinates legitimately. Adding the rule to this walker would need thirteen
 *     exemptions, and a rule with thirteen exemptions is not a rule.
 */
const CLEAN_FIXTURE_COUNT = 2;

/**
 * THE FOUR LEGAL FOOTPRINT BOXES, MIRRORED AS LITERALS - never imported from
 * `lint-svg.ts`. Importing `LEGAL_VIEWBOXES` would make this spec agree with the walker
 * about a whitelist that had been widened, which is the whole failure this case exists to
 * catch. Rendered form is the `' / '` join both emit branches print.
 */
const LEGAL_VIEWBOXES_MIRROR = ['0 0 32 32', '0 0 64 64', '0 0 64 96', '0 0 96 96'] as const;
const LEGAL_VIEWBOX_LIST = '0 0 32 32 / 0 0 64 64 / 0 0 64 96 / 0 0 96 96';

/** The `fix` string both viewBox-value failures carry, asserted verbatim below. */
const VIEWBOX_FIX =
  'Coordinates pass straight through as user units, so the 32-unit module holds only if the viewBox says so exactly. ' +
  'A multi-cell kind is authored at 32*w by 32*h and never at 32x32 scaled up. ' +
  `The legal boxes are ${LEGAL_VIEWBOX_LIST}.`;

/**
 * THE SHIPPED ASSET COUNT, as a literal. `render/assets/` holds nine assets at this
 * point: `pilot.svg` (the permanent calibration fixture, plan 56-01) plus the EIGHT
 * machine subjects (`tee.svg` in plan 58-01, the other seven in plan 58-02). Asserting
 * against a literal rather than against `result.assets.length` is the whole point - a
 * walker that discovered nothing would otherwise agree with itself and report a clean
 * zero-asset green.
 *
 * 2 -> 9 by hand in plan 58-02. `vertexBudget.test.ts` and `geometryDigest.test.ts` pin
 * the same count independently, and all three are edited by hand for the same reason.
 */
const EXPECTED_ASSET_COUNT = 9;

/**
 * THE SHIPPED CHROME ASSET COUNT, as a SECOND stated literal (plan 59-01).
 *
 * Never derived from the walk under test, for the reason the pin above already gives and
 * which bites harder here: `chrome/assets/` is a BRAND NEW directory, so the failure
 * mode "the walk found nothing and agreed with itself" is not hypothetical - it is what
 * happens if the path is wrong by one segment. A stated literal is the only assertion a
 * zero-file walk cannot satisfy.
 *
 * 1 in plan 59-01: `belt.svg`, the tracer's chrome glyph. 1 -> 13 in plan 59-02, in the
 * commit that authors the other twelve (`play`, `pause`, `step`, `undo`, `redo`, `save`,
 * `load`, `new`, `fit`, `warning`, `trash`, `logomark`). 13 -> 14 in plan 61-06, in the
 * commit that authors the Graphics settings trigger's fader glyph and registers it. A moving stated literal is a visible one-line diff, which is the point.
 * 14 -> 15 in plan 66-01, in the commit that authors `wire.svg` (the Palette Wire
 * tool's glyph) and registers it. `vertexBudget.test.ts` pins the same count
 * independently.
 */
// 15 -> 16 in phase 76 (plan 76-01), by hand, in the commit that authors `label.svg`.
// 16 -> 15 in plan 91-03 on 2026-10-24, by hand (the Graphics trigger's fader glyph deleted
// with the Graphics panel, D-04).
const EXPECTED_CHROME_ASSET_COUNT = 15;

function lintFixture(name: string): Violation[] {
  return lintFile(join(FIXTURE_DIR, name), `${FIXTURE_REL}/${name}`);
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fabrico-lint-svg-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('lint-svg - one fixture per rule, each naming the file and the line', () => {
  it('reports zero violations for the conforming control', () => {
    expect(lintFixture('conforming.svg')).toEqual([]);
  });

  it('fails a comment body carrying a doubled hyphen, and names the line it sits on', () => {
    // THE RULE THE WALKER COULD NOT SEE UNTIL PLAN 80-05. `parseSvg` skips a comment by
    // seeking its `-->` and never reads the body, so a document every strict parser refuses
    // is a document this walker reads happily - which is why the check runs over the RAW
    // text before the parse. The line is asserted, not just the rule id: a rule that always
    // said "line 1" would satisfy a bare rule-id check on every fixture in this directory.
    expect(lintFixture('comment-hyphen.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/comment-hyphen.svg`,
        line: 8,
        rule: 'comment-hyphen',
        severity: 'fail',
        message: 'an XML comment carries a double hyphen or is unterminated',
        fix:
          'A double hyphen is illegal inside an XML comment and every strict parser refuses the whole ' +
          'document, so the file cannot be opened by a rasteriser at all. A comment body may not end in a ' +
          'hyphen either. Name paint tokens without their leading dashes, as fab-accent-item.',
      },
    ]);
  });

  it('does NOT fire on a file with no comment, nor on an empty comment body', () => {
    // THE NEGATIVE HALF, and without it the rule could be "every file fires" and the case
    // above would still pass. Three shapes are covered: no comment at all, a zero-length
    // body, and a legal header naming its tokens without the leading dashes - the form
    // every conforming file in this repository uses.
    const dir = mkdtempSync(join(tmpRoot, 'comment-legal-'));
    const body = '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70" />';
    const root = '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">';
    writeFileSync(join(dir, 'no-comment.svg'), [root, body, '</svg>', ''].join('\n'));
    writeFileSync(join(dir, 'empty-comment.svg'), ['<!---->', root, body, '</svg>', ''].join('\n'));
    writeFileSync(
      join(dir, 'legal-header.svg'),
      ['<!--', '  1. body  fill  fab-panel-fill', '-->', root, body, '</svg>', ''].join('\n'),
    );

    const result = lintDir(dir);
    expect(result.assets).toHaveLength(3);
    expect(result.violations).toEqual([]);
  });

  it('fires on a body ending in a SINGLE hyphen, which collides with the close delimiter', () => {
    // The refinement the XML grammar demands and the plan-79 detector did not have. `<!-- x
    // --->` carries no doubled hyphen inside its body, yet the trailing `-` runs into the
    // `-->` and the grammar refuses it just the same. Without this case a detector testing
    // only for `--` would pass every other assertion in this file.
    const dir = mkdtempSync(join(tmpRoot, 'comment-trailing-'));
    writeFileSync(
      join(dir, 'trailing-hyphen.svg'),
      [
        '<!-- the body of this comment ends in a hyphen --->',
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(lintDir(dir).violations.map((v) => v.rule)).toContain('comment-hyphen');
  });

  it('reports comment-hyphen on a document the parser ALSO refuses, never instead of it', () => {
    // The ordering claim, asserted rather than described. The check runs before `parseSvg`,
    // so a file that is both comment-illegal and structurally broken carries BOTH findings -
    // and the comment is usually the cause of the malformed report a reader would otherwise
    // chase into the markup. A rule that ran after the parse would be silent here, which is
    // the one input it most needs to speak on.
    const dir = mkdtempSync(join(tmpRoot, 'comment-and-malformed-'));
    writeFileSync(
      join(dir, 'both.svg'),
      [
        '<!-- names var(--fab-ink) -->',
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70"',
        '</svg>',
        '',
      ].join('\n'),
    );
    const rules = lintDir(dir).violations.map((v) => v.rule);
    expect(rules).toContain('comment-hyphen');
    expect(rules).toContain('malformed-xml');
  });

  it('fails a viewBox that is numerically equal but textually different (0 0 32.0 32.0)', () => {
    expect(lintFixture('bad-viewbox.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/bad-viewbox.svg`,
        line: 1,
        rule: 'viewbox',
        severity: 'fail',
        message: `viewBox is "0 0 32.0 32.0", not one of the four legal footprint boxes: ${LEGAL_VIEWBOX_LIST}`,
        fix: VIEWBOX_FIX,
      },
    ]);
  });

  it('fails 0 0 96 64 - a TRANSPOSED Router that a multiple-of-32 regex would legalise', () => {
    // THE DISCRIMINATING CASE (plan 57-02, RESEARCH F1.5). `LEGAL_VIEWBOXES` is a closed
    // list of four literals compared by exact string equality. The mutation that survives
    // every other fixture is the "helpful generalisation" to `/^0 0 (\d+) (\d+)$/` with
    // both capture groups `% 32 === 0` - it passes all thirteen other fixtures, passes
    // pilot.svg and passes every candidate draft. `0 0 96 64` is a multiple of 32 on both
    // axes yet is not a footprint any machine has (`Router` is 2x3 -> `0 0 64 96`; the
    // transposition is the single most plausible real authoring error). Only a real
    // whitelist rejects it, so this fixture IS the proof the rule is a whitelist.
    //
    // Do NOT replace this with `0 0 48 48`. That value is killed by the whitelist AND by
    // the regex, so it discriminates nothing (a temp-dir case below covers it as
    // second-order evidence).
    expect(lintFixture('bad-viewbox-96x64.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/bad-viewbox-96x64.svg`,
        line: 1,
        rule: 'viewbox',
        severity: 'fail',
        message: `viewBox is "0 0 96 64", not one of the four legal footprint boxes: ${LEGAL_VIEWBOX_LIST}`,
        fix: VIEWBOX_FIX,
      },
    ]);
  });

  it('accepts ALL FOUR legal footprint boxes - a two-value rule and a four-value whitelist are indistinguishable from the negative cases alone', () => {
    // The positive half of the whitelist proof. Every negative case above would still pass
    // if the rule accepted only `0 0 32 32` and `0 0 96 96`, so the four legal values are
    // each exercised here. Written to a temp dir rather than committed as four more
    // fixtures so EXPECTED_FIXTURE_COUNT keeps meaning "one committed fixture per rule"
    // (plus the one discriminator) - the mechanism the unterminated-start-tag case above
    // already uses.
    const dir = mkdtempSync(join(tmpRoot, 'legal-viewboxes-'));

    // Asserted so the case cannot pass over an empty or truncated loop.
    expect(LEGAL_VIEWBOXES_MIRROR).toHaveLength(4);

    for (const box of LEGAL_VIEWBOXES_MIRROR) {
      const name = `legal-${box.replace(/ /g, '-')}.svg`;
      writeFileSync(
        join(dir, name),
        [
          `<svg viewBox="${box}" xmlns="http://www.w3.org/2000/svg">`,
          '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70" />',
          '</svg>',
          '',
        ].join('\n'),
      );
    }

    const result = lintDir(dir);
    expect(result.assets).toHaveLength(4);
    expect(result.violations.filter((v) => v.rule === 'viewbox')).toEqual([]);
    // Nothing else fires either: these four files are conforming apart from the box.
    expect(result.violations).toEqual([]);
  });

  it('fails 0 0 48 48 - SECOND-ORDER evidence only, since a multiple-of-32 regex kills it too', () => {
    // Named for what it is NOT: the load-bearing case is `bad-viewbox-96x64.svg` above.
    // 48 is not a multiple of 32, so the regex generalisation rejects this file just as
    // the whitelist does. It is here because a square, plausible-looking box is what an
    // author reaches for when guessing a 1.5-cell footprint, and the rule should name it.
    const dir = mkdtempSync(join(tmpRoot, 'viewbox-48-'));
    writeFileSync(
      join(dir, 'forty-eight.svg'),
      [
        '<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70" />',
        '</svg>',
        '',
      ].join('\n'),
    );

    expect(lintDir(dir).violations).toEqual([
      {
        path: 'forty-eight.svg',
        line: 1,
        rule: 'viewbox',
        severity: 'fail',
        message: `viewBox is "0 0 48 48", not one of the four legal footprint boxes: ${LEGAL_VIEWBOX_LIST}`,
        fix: VIEWBOX_FIX,
      },
    ]);
  });

  it('fails a transform attribute - the silent-misrender case', () => {
    expect(lintFixture('transform.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/transform.svg`,
        line: 2,
        rule: 'transform',
        severity: 'fail',
        message: 'transform attribute on <path>',
        fix: "Pixi's SVG parser never reads transform, so the geometry lands untransformed with no warning. Bake the offset into the path coordinates.",
      },
    ]);
  });

  it('fails a banned <use> element', () => {
    expect(lintFixture('banned-element.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/banned-element.svg`,
        line: 3,
        rule: 'banned-element',
        severity: 'fail',
        message: 'banned <use> element',
        fix: "Pixi's SVG parser warns and draws nothing. Inline the geometry as a <path>.",
      },
    ]);
  });

  it('fails a <g> wrapper AND the <path> it nests - both under path-only', () => {
    expect(lintFixture('nested-g.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/nested-g.svg`,
        line: 2,
        rule: 'path-only',
        severity: 'fail',
        message: '<g> element - the format allows only <path>',
        fix: 'One primitive family keeps the vertex count and the geometry digest predictable. Express the shape as a <path>.',
      },
      {
        path: `${FIXTURE_REL}/nested-g.svg`,
        line: 3,
        rule: 'path-only',
        severity: 'fail',
        message: '<path> is nested inside <g>, not a direct child of the root',
        fix: "A flat child list keeps each part's effective style local. Move the <path> up to the root and delete the wrapper.",
      },
    ]);
  });

  it('fails an svg with zero <path> elements - a silently empty asset is not a passing asset', () => {
    expect(lintFixture('no-paths.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/no-paths.svg`,
        line: 1,
        rule: 'no-paths',
        severity: 'fail',
        message: 'no <path> elements in this asset',
        fix: 'An asset that draws nothing is not a passing asset. Add the part geometry as <path> elements, or delete the file.',
      },
    ]);
  });

  it('fails an inline style attribute', () => {
    expect(lintFixture('inline-style.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/inline-style.svg`,
        line: 2,
        rule: 'inline-style',
        severity: 'fail',
        message: 'style attribute on <path>',
        fix: 'Two channels for one property makes an SVG diff unreadable. Move the declarations to presentation attributes.',
      },
    ]);
  });

  it('fails a non-integer coordinate, naming the offending token', () => {
    expect(lintFixture('fractional-coord.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/fractional-coord.svg`,
        line: 2,
        rule: 'non-integer-coord',
        severity: 'fail',
        message: "non-integer coordinate '28.5' in d",
        fix: 'Fractional author coordinates defeat the hard-edge promise at scale 1 and make the geometry digest float-sensitive. Round to a whole unit on the 32-unit grid.',
      },
    ]);
  });

  it('fails a <path> with no data-part', () => {
    expect(lintFixture('missing-data-part.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/missing-data-part.svg`,
        line: 2,
        rule: 'data-part',
        severity: 'fail',
        message: '<path> has no data-part attribute',
        fix: 'data-part is the stable per-part handle later phases tint and diff against. Give every <path> a unique lower-kebab-case data-part.',
      },
    ]);
  });

  it('fails a <path> declaring neither fill nor stroke - the silent black blob', () => {
    expect(lintFixture('no-paint.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/no-paint.svg`,
        line: 2,
        rule: 'explicit-paint',
        severity: 'fail',
        message: '<path> declares neither fill nor stroke',
        fix: 'Pixi falls back to a solid black fill when no style is set, which renders a silent black blob. Declare fill (fill="none" counts) or stroke.',
      },
    ]);
  });

  it('fails an unparseable file with a NAMED per-file error, never a silent skip', () => {
    // LINE 2, NOT LINE 3, and the difference is the finding phase 56's review filed as
    // WR-05. `malformed.svg` is three lines and the defect is the unterminated `<path>`
    // START TAG on line 2:
    //
    //   1  <svg viewBox="0 0 32 32" xmlns="...">
    //   2    <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70"     <- no `>`
    //   3  </svg>
    //
    // The parser does not notice at the end of line 2 - nothing is wrong there yet. The
    // attribute loop runs on, takes `<` from line 3's `</svg>` as an attribute name, and
    // only rejects when it finds `/` where `=` must be. So the CURSOR is on line 3 while
    // the DEFECT is on line 2, and this expectation used to bake the cursor's answer in
    // as correct behaviour. It is now the tag's own start line.
    //
    // Do NOT "fix" a future failure here by moving the number back to match the parser.
    // The locator is a UX surface: an author sent to line 3 edits markup that is fine.
    expect(lintFixture('malformed.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/malformed.svg`,
        line: 2,
        rule: 'malformed-xml',
        severity: 'fail',
        message: 'file could not be parsed as XML',
        fix: 'Fix the markup or remove the file; a skipped file is not a passing file.',
      },
    ]);
  });

  it('locates an unterminated start tag at the TAG, however far the parser then ran', () => {
    // The discriminator for the fix above: `malformed.svg` alone is also satisfied by an
    // off-by-one that happens to subtract 1. Here the parser walks THREE further lines
    // past the defect before it rejects anything, so only real start-line attribution
    // produces 2. Written to a temp dir rather than committed as a fixture so
    // EXPECTED_FIXTURE_COUNT keeps meaning "one fixture per rule".
    const dir = mkdtempSync(join(tmpRoot, 'unterminated-'));
    writeFileSync(
      join(dir, 'unterminated.svg'),
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70"',
        '  <path data-part="trim" d="M8 8 H24 V24 H8 Z" fill="#8b93a1" />',
        '  <path data-part="mark" d="M12 12 H20 V20 H12 Z" fill="#c8ced8" />',
        '</svg>',
        '',
      ].join('\n'),
    );

    const result = lintDir(dir);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe('malformed-xml');
    expect(result.violations[0]?.line).toBe(2);
  });

  it('locates a never-closed element at the ELEMENT, not at end-of-file', () => {
    // Same class, other branch: `parseSvg` used to report `text.length - 1` when the
    // stack was non-empty at EOF, which names the last line of the file for a defect
    // that is by definition somewhere above it.
    const dir = mkdtempSync(join(tmpRoot, 'unclosed-'));
    writeFileSync(
      join(dir, 'unclosed.svg'),
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <g>',
        '    <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70" />',
        '',
        '',
      ].join('\n'),
    );

    const result = lintDir(dir);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe('malformed-xml');
    expect(result.violations[0]?.line).toBe(1); // the unclosed <svg>, not line 5
  });
});

describe('lint-svg - the adjacency edge (VEC-02)', () => {
  it('reports two elements on one line ONCE PER ELEMENT, not once per line', () => {
    const violations = lintFixture('two-elements-one-line.svg');

    // Two violations, not one. A per-line report would tell an author that "a line" is
    // wrong without saying which of the two elements to move.
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.line)).toEqual([2, 2]);
    expect(violations.map((v) => v.rule)).toEqual(['one-element-per-line', 'one-element-per-line']);
    expect(violations.map((v) => v.message)).toEqual([
      '<path data-part="left"> shares a source line with another element',
      '<path data-part="right"> shares a source line with another element',
    ]);
  });
});

describe('lint-svg - the curve rule is FAIL, decided by Phase 58 (VEC-03)', () => {
  // RAISED FROM WARN TO FAIL IN PLAN 58-02, and the change is deliberate rather than
  // drift. `57-ART-LOCK.md` section 5 named this as a shipped-gate change PHASE 58 OWNS
  // WHETHER TO MAKE, and Phase 58 makes it. The two reasons are recorded on `severityOf`
  // in the source it governs; this spec pins the consequence.
  //
  // The abstention that used to live here ("BOARD-02 owns the corner-radius policy, this
  // phase does not vote") expired the moment the policy was locked: axis 5 locks radius 0,
  // authored square, with zero curve commands.
  it('reports a curve command at FAIL severity, per occurrence', () => {
    expect(lintFixture('curve.svg')).toEqual([
      {
        path: `${FIXTURE_REL}/curve.svg`,
        line: 2,
        rule: 'curve',
        severity: 'fail',
        message: "curve command 'C'",
        fix: 'buildAdaptiveBezier tessellates at scale 1 only; this serves faceted geometry when zoomed. Lock axis 5 is radius 0, authored square with zero curve commands - re-plot the shape in M H V L Z.',
      },
    ]);
  });

  it('FAILS a directory whose only violation is a curve', () => {
    // The exact inversion of the case this replaces. Before 58-02 a curve-only directory
    // reported `failed: false`; a shipped asset could therefore carry an arc and pass the
    // gate that guards the art.
    const dir = mkdtempSync(join(tmpRoot, 'curve-only-'));
    copyFileSync(join(FIXTURE_DIR, 'curve.svg'), join(dir, 'curve.svg'));

    const result = lintDir(dir);
    expect(result.assets).toHaveLength(1);
    expect(result.violations.filter((v) => v.severity === 'fail')).toHaveLength(1);
    expect(report(result).failed).toBe(true);
  });

  it('fails every one of the five curve commands, not only C', () => {
    // `A` is the one that matters most in practice - it is what an author reaches for to
    // round a corner, which is precisely what lock axis 5 forbids - and it was covered by
    // the regex but by no case. All five are exercised so a narrowed character class
    // reddens here rather than shipping a rounded chassis.
    const dir = mkdtempSync(join(tmpRoot, 'curve-commands-'));
    const D: Record<string, string> = {
      c: 'M 4 4 C 4 28 28 28 28 4 Z',
      s: 'M 4 4 S 28 28 28 4 Z',
      q: 'M 4 4 Q 16 28 28 4 Z',
      t: 'M 4 4 Q 16 28 28 4 T 28 20 Z',
      a: 'M 4 4 A 8 8 0 0 1 28 4 Z',
    };
    for (const [key, d] of Object.entries(D)) {
      writeFileSync(
        join(dir, `curve-${key}.svg`),
        [
          '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
          `  <path data-part="body" d="${d}" fill="#565f70" />`,
          '</svg>',
          '',
        ].join('\n'),
      );
    }

    const result = lintDir(dir);
    expect(result.assets).toHaveLength(5);
    const curveFails = result.violations.filter((v) => v.rule === 'curve' && v.severity === 'fail');
    // Every file contributes at least one, and every file is named.
    expect(new Set(curveFails.map((v) => v.path)).size).toBe(5);
    expect(report(result).failed).toBe(true);
    // ...and every one of the five COMMAND LETTERS is actually reported, so a narrowed
    // character class cannot pass on the file count alone. (`curve-t` legitimately
    // reports a Q as well - a lone T is not a valid path.)
    const letters = new Set(curveFails.map((v) => /'(.)'/.exec(v.message)?.[1]));
    for (const letter of ['C', 'S', 'Q', 'T', 'A']) {
      expect(letters, `curve command '${letter}' was not reported`).toContain(letter);
    }
  });

  it('fails LOWERCASE curve commands, which a serialiser emits and an eye skips', () => {
    const dir = mkdtempSync(join(tmpRoot, 'curve-lower-'));
    writeFileSync(
      join(dir, 'lower.svg'),
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="body" d="M 4 4 c 0 24 24 24 24 0 Z" fill="#565f70" />',
        '</svg>',
        '',
      ].join('\n'),
    );

    const violations = lintDir(dir).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('curve');
    expect(violations[0]?.severity).toBe('fail');
    expect(violations[0]?.message).toBe("curve command 'c'");
  });

  it('leaves NO rule at warn severity - the band is empty, and that is stated', () => {
    // After the promotion above, every one of the twelve rules is `fail`. The `warn` half
    // of `Severity` is KEPT rather than deleted: `formatViolation` still renders it (see
    // the case in the UX-surface block, which builds a warn violation by hand) and a
    // future advisory rule needs somewhere to live. This assertion is what stops that
    // being a silent claim - if a rule is ever demoted to warn, this reddens and whoever
    // did it has to say so here.
    const { violations } = lintDir(FIXTURE_DIR);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.filter((v) => v.severity === 'warn')).toEqual([]);
    expect(new Set(violations.map((v) => v.severity))).toEqual(new Set(['fail']));
  });
});

describe('lint-svg - the vacuous-green refusals (S1 empty / S1 error)', () => {
  it('treats a zero-asset walk as a FAILURE with the refusal message, never a clean pass', () => {
    const dir = mkdtempSync(join(tmpRoot, 'empty-'));

    const result = lintDir(dir);
    expect(result.assets).toEqual([]);
    expect(result.violations).toEqual([]);

    const rendered = report(result);
    expect(rendered.failed).toBe(true);
    // THE REFUSAL NAMES THE DIRECTORY THAT WALKED TO NOTHING - it is not a hardcoded
    // string any more (plan 59-01). This assertion USED TO READ `no assets found under
    // render/assets/` for a walk of a TEMP directory, which was the bug in miniature:
    // the message was a constant, so it could not distinguish which of two directories
    // was empty, and with a second directory added a vacuous chrome walk would have
    // been masked by the nine machine assets. `result.dir` is carried by the walker.
    expect(result.dir).toBe(`${basename(dir)}/`);
    expect(rendered.text).toBe(
      `lint:svg  no assets found under ${result.dir} - refusing to report a vacuous pass`,
    );
    // The clean summary must NOT be reachable from an empty walk.
    expect(rendered.text).not.toContain('0 violations');
  });

  it('refuses PER DIRECTORY: one empty directory fails a run the other directory would have passed', () => {
    // THE DISCRIMINATING CASE, and the whole reason the refusal moved. A merged run over
    // a healthy directory and an empty one must fail and must NAME the empty one; a
    // global "did the whole run find any asset at all" check passes here, which is
    // precisely how a second asset directory becomes a directory no gate measures.
    const empty = mkdtempSync(join(tmpRoot, 'empty-pair-'));
    const healthy = lintDir(ASSET_DIR);
    const vacuous = lintDir(empty);

    const rendered = report([healthy, vacuous]);
    expect(rendered.failed).toBe(true);
    expect(rendered.text).toBe(
      `lint:svg  no assets found under ${basename(empty)}/ - refusing to report a vacuous pass`,
    );
    // The nine healthy assets do NOT get to speak for the empty directory.
    expect(rendered.text).not.toContain('render/assets/');
    expect(rendered.text).not.toContain('0 violations');
  });

  it('names EVERY empty directory, not merely the first', () => {
    const a = mkdtempSync(join(tmpRoot, 'empty-a-'));
    const b = mkdtempSync(join(tmpRoot, 'empty-b-'));
    const rendered = report([lintDir(a), lintDir(b)]);
    expect(rendered.failed).toBe(true);
    expect(rendered.text.split('\n')).toHaveLength(2);
    expect(rendered.text).toContain(`${basename(a)}/`);
    expect(rendered.text).toContain(`${basename(b)}/`);
  });

  it('names a zero-byte file as malformed rather than skipping it - a skipped file reporting clean is a false green', () => {
    const dir = mkdtempSync(join(tmpRoot, 'zero-byte-'));
    writeFileSync(join(dir, 'zero.svg'), '');

    const result = lintDir(dir);
    expect(result.assets).toHaveLength(1);
    expect(result.violations).toEqual([
      {
        path: 'zero.svg',
        line: 1,
        rule: 'malformed-xml',
        severity: 'fail',
        message: 'file could not be parsed as XML',
        fix: 'Fix the markup or remove the file; a skipped file is not a passing file.',
      },
    ]);
    expect(report(result).failed).toBe(true);
  });

  it('names an UNREADABLE file as malformed rather than throwing or skipping it', () => {
    // A file that vanishes between the readdir and the read (or that the process cannot
    // open) must become a NAMED violation. If the walker threw here, a CI run would show
    // a stack instead of a locator; if it swallowed the error, the file would be skipped
    // and the walk would report clean - the false green this lint exists to prevent.
    //
    // THE MESSAGE MUST NOT SAY "could not be parsed as XML" (phase 56 review IN-02).
    // The markup of a file that cannot be opened has not been examined at all, and an
    // author told the parse message about a permissions error edits markup that is fine.
    // Rule id and severity stay `malformed-xml` / `fail` on purpose, so the report
    // format and the named-violation guarantee are unchanged.
    const missing = join(tmpRoot, 'does-not-exist', 'gone.svg');

    expect(lintFile(missing, 'render/assets/gone.svg')).toEqual([
      {
        path: 'render/assets/gone.svg',
        line: 1,
        rule: 'malformed-xml',
        severity: 'fail',
        message: 'file could not be read (ENOENT)',
        fix: 'Check the path exists and is readable; a skipped file is not a passing file.',
      },
    ]);
  });

  it('rejects a CDATA section rather than skipping it (a skipped region hides markup)', () => {
    // Phase 56 review IN-03. Before this, a CDATA section was consumed wholesale and
    // the file below produced ZERO violations - `banned-element` cannot fire on markup
    // the walker never turned into an element.
    const dir = mkdtempSync(join(tmpRoot, 'cdata-'));
    writeFileSync(
      join(dir, 'cdata.svg'),
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <![CDATA[ <script>alert(1)</script> ]]>',
        '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70" />',
        '</svg>',
        '',
      ].join('\n'),
    );

    const violations = lintDir(dir).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('malformed-xml');
    expect(violations[0]?.line).toBe(2);
  });

  it('rejects a duplicate attribute name, which attrOf would otherwise read past', () => {
    // Phase 56 review IN-03. `attrOf` returns the FIRST match, so the second `viewBox`
    // was invisible and the `viewbox` rule passed on a document a strict XML parser
    // would refuse outright.
    const dir = mkdtempSync(join(tmpRoot, 'dup-attr-'));
    writeFileSync(
      join(dir, 'dup.svg'),
      [
        '<svg viewBox="0 0 32 32" viewBox="bogus" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="body" d="M4 4 H28 V28 H4 Z" fill="#565f70" />',
        '</svg>',
        '',
      ].join('\n'),
    );

    const violations = lintDir(dir).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('malformed-xml');
    expect(violations[0]?.line).toBe(1);
  });

  it('a zero-byte file still reports the PARSE message, not the read message', () => {
    // The discriminator for the split above: a zero-byte file IS readable, so it must
    // keep travelling the parse path. If a future edit collapsed the two messages back
    // together, this and the case above cannot both pass.
    const dir = mkdtempSync(join(tmpRoot, 'read-vs-parse-'));
    writeFileSync(join(dir, 'empty-but-readable.svg'), '');

    const violations = lintDir(dir).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe('file could not be parsed as XML');
  });

  it('reports ALL violations across ALL files, never first-fail', () => {
    const result = lintDir(FIXTURE_DIR);

    // Every fixture that has violations contributes them; a first-fail walker would
    // return one violation from one file and force an author to iterate N times.
    const filesWithViolations = new Set(result.violations.map((v) => v.path));
    expect(filesWithViolations.size).toBe(EXPECTED_FIXTURE_COUNT - CLEAN_FIXTURE_COUNT);
    expect(result.violations.length).toBeGreaterThan(EXPECTED_FIXTURE_COUNT - CLEAN_FIXTURE_COUNT);
    // The two clean fixtures are the two NAMED ones, never merely two of anything - so a
    // fixture that silently stopped firing cannot be absorbed by the count above.
    const clean = readdirSync(FIXTURE_DIR)
      .filter((n) => n.endsWith('.svg'))
      .filter((n) => !filesWithViolations.has(`${FIXTURE_REL}/${n}`))
      .sort();
    expect(clean).toEqual(['conforming.svg', 'odd-coords.svg']);

    // Every fail-severity rule in the set is represented by at least one fixture.
    //
    // WALKED UNDER BOTH SCOPES (plan 59-01). `chrome-ink` is the one rule in the table
    // that does not run over `render/assets/`, so a machine-scope walk alone would
    // report it unrepresented forever - and "add the rule to the ignore list" is how a
    // coverage assertion stops meaning anything. The fixtures are scope-agnostic files;
    // `conforming.svg` carries `fill="#565f70"`, which is legal machine ink and an
    // illegal chrome ink, so the same directory demonstrates both halves.
    const rulesSeen = new Set([
      ...result.violations.map((v) => v.rule),
      ...lintDir(FIXTURE_DIR, { chromeInk: true }).violations.map((v) => v.rule),
    ]);
    expect([...RULES].filter((r) => !rulesSeen.has(r))).toEqual([]);
  });
});

describe('lint-svg - the output IS a UX surface (56-UI-SPEC A.3)', () => {
  it('renders a failure in the exact two-line format from the copywriting contract', () => {
    const [violation] = lintFixture('banned-element.svg');
    expect(formatViolation(violation as Violation)).toBe(
      `${FIXTURE_REL}/banned-element.svg:3  banned <use> element\n` +
        "  Pixi's SVG parser warns and draws nothing. Inline the geometry as a <path>.",
    );
  });

  it('renders a warning with the warning: prefix in the same two-line format', () => {
    // BUILT BY HAND SINCE PLAN 58-02, and the reason is worth stating rather than
    // hiding behind a literal. This case used to read `lintFixture('curve.svg')`, because
    // `curve` was the lint's only warn-severity rule. It is now `fail`, so NO rule
    // produces a warn violation and there is no file that can supply one.
    //
    // The `warn` branch of `formatViolation` is nonetheless still live code and still
    // part of the report format, so it keeps a case. Deleting the branch instead would
    // remove the only severity distinction the `Violation` type carries and leave a
    // future advisory rule nowhere to go; asserting it on a hand-built value says exactly
    // that, without pretending a warn rule exists.
    const synthetic: Violation = {
      path: `${FIXTURE_REL}/hypothetical.svg`,
      line: 7,
      rule: 'curve',
      severity: 'warn',
      message: 'a hypothetical advisory finding',
      fix: 'One sentence saying why it is advisory and what to do about it.',
    };
    expect(formatViolation(synthetic)).toBe(
      `${FIXTURE_REL}/hypothetical.svg:7  warning: a hypothetical advisory finding\n` +
        '  One sentence saying why it is advisory and what to do about it.',
    );
    // The discriminator: the SAME violation at fail severity drops the prefix, so this
    // case cannot pass on a `formatViolation` that prints `warning: ` unconditionally.
    expect(formatViolation({ ...synthetic, severity: 'fail' })).toBe(
      `${FIXTURE_REL}/hypothetical.svg:7  a hypothetical advisory finding\n` +
        '  One sentence saying why it is advisory and what to do about it.',
    );
  });

  it('gives every violation a greppable locator, an actionable fix and no ANSI colour', () => {
    const { violations } = lintDir(FIXTURE_DIR);
    expect(violations.length).toBeGreaterThan(0);

    for (const v of violations) {
      const rendered = formatViolation(v);
      const [locator, fixLine, ...rest] = rendered.split('\n');

      expect(rest).toEqual([]);
      // Line 1: repo-relative path first, then :line, then TWO spaces, then the finding.
      // The filename charset admits digits (`bad-viewbox-96x64.svg`, plan 57-02) - a
      // fixture named for the footprint it rejects is the clearest name it can have. It
      // still admits NO uppercase and no path separator beyond the fixture directory, so
      // the load-bearing half of this assertion (a relative, greppable locator) is intact.
      expect(locator).toMatch(new RegExp(`^${FIXTURE_REL}/[a-z0-9-]+\\.svg:\\d+ {2}\\S`));
      expect(locator?.startsWith('/')).toBe(false);
      // Line 2: two-space indent, and a real sentence saying what to do - not a restated
      // error code. `SVG validation failed` would fail this.
      expect(fixLine?.startsWith('  ')).toBe(true);
      expect(v.fix.length).toBeGreaterThanOrEqual(40);
      expect(v.fix.endsWith('.')).toBe(true);
      expect(v.fix).not.toBe(v.message);
      // No ANSI colour: this lands in CI logs and saved plain-text logs.
      expect(rendered).not.toContain('\u001b');
    }
  });

  it('names both counts in a failing summary and prints the summary last', () => {
    const result = lintDir(FIXTURE_DIR);
    const lines = report(result).text.split('\n');
    const summary = lines[lines.length - 1];

    // The summary NAMES ITS DIRECTORY as of plan 59-01. With two walked directories an
    // unnamed total cannot be attributed to either, and the count a human maintains by
    // hand is per-directory.
    expect(summary).toBe(
      `lint:svg  ${result.dir}  ${EXPECTED_FIXTURE_COUNT} assets, ${result.violations.length} violations in ${EXPECTED_FIXTURE_COUNT - CLEAN_FIXTURE_COUNT} files`,
    );
    expect(result.dir).toBe(`${FIXTURE_REL}/`);
  });
});

describe('lint-svg - ordering and byte-stability (VEC-02 ordering edge)', () => {
  it('produces deeply equal, identically ordered results on two walks of the same directory', () => {
    const first = lintDir(FIXTURE_DIR);
    const second = lintDir(FIXTURE_DIR);

    expect(second).toEqual(first);
    expect(second.assets).toEqual(first.assets);
    expect(second.violations.map(formatViolation).join('\n')).toBe(
      first.violations.map(formatViolation).join('\n'),
    );
    expect(report(second).text).toBe(report(first).text);
  });

  it('sorts by path, then ascending line, then rule-declaration order', () => {
    const { violations } = lintDir(FIXTURE_DIR);

    for (let i = 1; i < violations.length; i++) {
      const prev = violations[i - 1] as Violation;
      const cur = violations[i] as Violation;
      if (prev.path !== cur.path) {
        expect(prev.path < cur.path).toBe(true);
        continue;
      }
      if (prev.line !== cur.line) {
        expect(prev.line).toBeLessThan(cur.line);
        continue;
      }
      expect(RULES.indexOf(prev.rule)).toBeLessThanOrEqual(RULES.indexOf(cur.rule));
    }
  });
});

describe('lint-svg - the real asset directory', () => {
  it('discovers the committed assets and reports them clean - pilot.svg conforms to the format it defines', () => {
    const result = lintDir(ASSET_DIR);

    // Asserted against a stated literal, NOT against the walk's own output.
    expect(result.assets).toHaveLength(EXPECTED_ASSET_COUNT);
    // Plan 58-01/58-02: shipped art lints at the SAME fail severity as the fixture that
    // defines the format. There is no shipped-asset exemption and no allowlist. The set
    // is spelled out exhaustively, because a `toContain` pair is satisfied by a walk that
    // found two of nine files.
    expect(result.assets).toEqual([
      'render/assets/balancer.svg',
      'render/assets/endpoint.svg',
      'render/assets/factory.svg',
      'render/assets/merge.svg',
      'render/assets/pilot.svg',
      'render/assets/router.svg',
      'render/assets/sink.svg',
      'render/assets/source.svg',
      'render/assets/tee.svg',
    ]);
    expect(result.violations).toEqual([]);
    expect(report(result).text).toBe(
      `lint:svg  render/assets/  ${EXPECTED_ASSET_COUNT} assets, 0 violations`,
    );
    expect(report(result).failed).toBe(false);
  });

  it('walks render/assets/ NON-RECURSIVELY, so the deliberately non-conforming fixtures are invisible to it', () => {
    const result = lintDir(ASSET_DIR);

    // Plan 56-05 depends on this and no longer asserts it itself.
    expect(result.assets.some((a) => a.includes('__fixtures__'))).toBe(false);
    expect(readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.svg'))).toHaveLength(
      EXPECTED_FIXTURE_COUNT,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The SECOND asset directory (plan 59-01, CHROME-01)
 * ------------------------------------------------------------------ */

describe('lint-svg - the chrome asset directory', () => {
  it('discovers the committed chrome assets against a STATED literal and reports them clean', () => {
    const result = lintDir(CHROME_ASSET_DIR, { chromeInk: true });

    expect(result.dir).toBe('chrome/assets/');
    // Against the literal, NEVER against the walk's own output.
    expect(result.assets).toHaveLength(EXPECTED_CHROME_ASSET_COUNT);
    // Spelled out exhaustively: a `toContain` pair is satisfied by a walk that found one
    // of fourteen files, which is exactly the state plan 59-02 passes through.
    expect(result.assets).toEqual([
      'chrome/assets/belt.svg',
      'chrome/assets/fit.svg',
      'chrome/assets/label.svg',
      'chrome/assets/load.svg',
      'chrome/assets/logomark.svg',
      'chrome/assets/new.svg',
      'chrome/assets/pause.svg',
      'chrome/assets/play.svg',
      'chrome/assets/redo.svg',
      'chrome/assets/save.svg',
      'chrome/assets/step.svg',
      'chrome/assets/trash.svg',
      'chrome/assets/undo.svg',
      'chrome/assets/warning.svg',
      'chrome/assets/wire.svg',
    ]);
    expect(result.violations).toEqual([]);
    expect(report(result).failed).toBe(false);
  });

  it('walks chrome/assets/ NON-RECURSIVELY, the same placement contract render/assets/ has', () => {
    const result = lintDir(CHROME_ASSET_DIR, { chromeInk: true });
    expect(result.assets.every((a) => a.split('/').length === 3)).toBe(true);
    expect(result.assets.some((a) => a.includes('__fixtures__'))).toBe(false);
  });

  it('holds the chrome ink rule at FAIL severity, naming the attribute and its own line', () => {
    // A scratch copy, never the tracked file (the WR-10 contract).
    const dir = mkdtempSync(join(tmpRoot, 'chrome-ink-'));
    writeFileSync(
      join(dir, 'hexed.svg'),
      '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n' +
        '  <path data-part="rail" d="M 0 8 H 32" fill="none" stroke="#b0bacb" stroke-width="3" />\n' +
        '</svg>\n',
    );

    expect(lintDir(dir, { chromeInk: true }).violations).toEqual([
      {
        path: 'hexed.svg',
        line: 2,
        rule: 'chrome-ink',
        severity: 'fail',
        message: 'stroke="#b0bacb" is not a chrome ink',
        fix: 'A chrome glyph takes its colour from the control it sits in, so it lifts on hover and desaturates with a disabled button; a baked value does neither, silently. Use currentColor, a var(--fab-*) reference, or none.',
      },
    ]);

    // THE DISCRIMINATOR, and the reason this rule is scoped rather than global: the SAME
    // bytes are perfectly legal machine art. `#b0bacb` is `LOCKED_SKIN.palette.ramp[4]`,
    // the one ink lock axis 9 permits, and Pixi cannot render `currentColor` at all
    // (`new GraphicsContext().svg()` throws "Unable to convert color currentColor"), so
    // a global rule would make the nine shipped machine assets unauthorable.
    expect(lintDir(dir).violations).toEqual([]);
  });

  it('admits fill="none" and a var(--fab-*) reference, and nothing else', () => {
    const dir = mkdtempSync(join(tmpRoot, 'chrome-ink-ok-'));
    writeFileSync(
      join(dir, 'tokens.svg'),
      '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n' +
        '  <path data-part="a" d="M 0 8 H 32" fill="none" stroke="currentColor" />\n' +
        '  <path data-part="b" d="M 0 16 H 32" fill="var(--fab-ink)" />\n' +
        '  <path data-part="c" d="M 0 24 H 32" fill="rgb(1, 2, 3)" />\n' +
        '</svg>\n',
    );

    // `none` is the ABSENCE of paint and is required on every stroked path, so refusing
    // it would fail every conforming file. `rgb(...)` is a baked colour wearing a
    // different syntax and is refused - the rule is a whitelist of two token forms, not
    // a hex-character scan that a different notation walks straight through.
    const violations = lintDir(dir, { chromeInk: true }).violations;
    expect(violations.map((v) => [v.line, v.rule, v.message])).toEqual([
      [4, 'chrome-ink', 'fill="rgb(1, 2, 3)" is not a chrome ink'],
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The THIRD walked directory (plan 80-04, decision D-06)
 * ------------------------------------------------------------------ */

describe('lint-svg brand walk - docs/brand/ under the subject-agnostic subset', () => {
  /**
   * THE ANTI-VACUITY FLOOR, AS A NAMED FILE rather than an asset count (the Phase 79
   * pattern, plan 79-01). A count has to be hand-edited the moment Phase 81 or 83 adds a
   * cut to `docs/brand/`, and a literal that reddens on correct work teaches an executor
   * to edit the assertion. This name cannot be satisfied by a walk over nothing, and it
   * is undisturbed by a directory that grows.
   *
   * `fabrico-lockup.svg` and NOT `brand/fabrico-lockup.svg`: `displayPath` renders a path
   * outside `frontend/src/` as its bare filename, which is exactly the form the walker
   * produces here and the form the CLI prints.
   */
  const FLOOR_FILE = 'fabrico-lockup.svg';

  it('walks the brand directory and finds its named floor file', () => {
    const result = lintDir(BRAND_DIR, { only: BRAND_RULES });
    expect(result.dir).toBe('brand/');
    expect(result.assets).toContain(FLOOR_FILE);
  });

  it('reports the committed brand source clean under the subset', () => {
    expect(lintDir(BRAND_DIR, { only: BRAND_RULES }).violations).toEqual([]);
  });

  it('holds the subset NON-EMPTY BY RULE NAME, never by length', () => {
    // THIS IS THE CASE THAT STOPS THE WALK MEANING NOTHING. A subset narrowed to `[]`
    // walks every directory in the repository green, and so does one narrowed to a rule
    // the lockup structurally cannot break. A length assertion would not notice either:
    // `['viewbox']` has length 1 and fires on nothing here. Naming the two rules that
    // carry the actual property - it is flat `<path>` geometry, and it contains no
    // element the format bans - is the only form that cannot be satisfied by a narrowing.
    expect(BRAND_RULES).toContain('path-only');
    expect(BRAND_RULES).toContain('banned-element');
  });

  it('lintFile HONOURS only, not just lintDir', () => {
    // WR-07. `only` is declared on `LintOptions`, and `LintOptions` is the options type of
    // BOTH exported entry points. `lintFile` accepted it, type-checked against it and never
    // read it - the filter lived entirely in `lintDir` - so a caller doing
    // `lintFile(brandFile, rel, { only: BRAND_RULES })` got the full violation list back with
    // no error and no warning. `lintFixture` above already calls `lintFile` directly, so the
    // shape is in live use.
    //
    // THE SUBJECT HAS TO BREAK TWO RULES, ONE IN THE SUBSET AND ONE OUT OF IT. A one-rule
    // subject cannot discriminate: a filter that dropped everything and a filter that dropped
    // nothing would both be caught by only one of the two halves. Every committed fixture in
    // `__fixtures__/lint/` fires exactly one rule by design (measured), so this file is
    // written here rather than copied: a nested `<g>` breaks `path-only`, which is IN
    // `BRAND_RULES`, and a `C` command breaks `curve`, which is deliberately OUT of it.
    const dir = mkdtempSync(join(tmpRoot, 'lintfile-only-'));
    const abs = join(dir, 'two-rules.svg');
    const rel = 'two-rules.svg';
    writeFileSync(
      abs,
      '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">\n' +
        '  <g>\n' +
        '    <path data-part="arc" d="M 4 4 C 8 8 12 12 16 16" fill="none" stroke="currentColor" stroke-width="2" />\n' +
        '  </g>\n' +
        '</svg>\n',
    );

    const all = [...new Set(lintFile(abs, rel).map((v) => v.rule))];
    const filtered = [...new Set(lintFile(abs, rel, { only: BRAND_RULES }).map((v) => v.rule))];

    // NON-VACUITY, both directions. The subject fires under the full rule set, and it fires
    // on a rule the subset keeps AND one it drops. Without these the equality below could be
    // satisfied by a file nothing fired on.
    expect(all).toEqual(['path-only', 'curve']);
    expect(BRAND_RULES).toContain('path-only');
    expect(BRAND_RULES).not.toContain('curve');

    expect(filtered, 'lintFile ignored its `only` option').toEqual(['path-only']);
  });

  it('reports a SECOND brand file that draws nothing, under the subset', () => {
    // WR-04. `no-paths` was missing from the subset, so a zero-path SVG in `docs/brand/`
    // linted clean. The named floor file above does not catch it and neither does
    // `report()`'s per-directory refusal: both are satisfied by the ONE good file that is
    // already there, which is exactly the shape any phase adding a brand cut (Phase 81 did)
    // walks into when the cut fails to generate.
    //
    // The fixture is written rather than copied because there is no committed zero-path
    // asset and there must not be one: a file whose only purpose is to draw nothing does
    // not belong in a fixture directory the other walks discover.
    const dir = mkdtempSync(join(tmpRoot, 'brand-no-paths-'));
    copyFileSync(join(BRAND_DIR, 'fabrico-lockup.svg'), join(dir, 'fabrico-lockup.svg'));
    writeFileSync(
      join(dir, 'fabrico-favicon.svg'),
      '<svg viewBox="0 0 880 260" xmlns="http://www.w3.org/2000/svg"></svg>\n',
    );

    const violations = lintDir(dir, { only: BRAND_RULES }).violations;
    expect(violations.map((v) => [v.path, v.rule])).toEqual([['fabrico-favicon.svg', 'no-paths']]);

    // NON-VACUITY, and it is the half that makes the case above mean something: the good
    // file in the same directory reports nothing, so the walk ran over both and the single
    // violation is a measurement rather than a directory that failed to be read.
    expect(lintDir(dir, { only: BRAND_RULES }).assets).toHaveLength(2);
  });

  it('is a REAL FILTER in both directions: an in-subset rule fires, an out-of-subset rule does not', () => {
    // One direction alone proves nothing. A subset that filtered EVERYTHING would satisfy
    // the negative half; a subset that filtered NOTHING would satisfy the positive half.
    // Both halves run over existing committed fixtures, so neither is a file authored to
    // agree with this case.
    const inSubset = mkdtempSync(join(tmpRoot, 'brand-subset-in-'));
    copyFileSync(join(FIXTURE_DIR, 'nested-g.svg'), join(inSubset, 'nested-g.svg'));
    expect(
      lintDir(inSubset, { only: BRAND_RULES }).violations.map((v) => v.rule),
    ).toContain('path-only');

    // `viewbox` is deliberately OUT of the subset: the lockup is a 0 0 880 260 drawing
    // that never sat on the 32-unit module. The same fixture linted with no options is
    // the discriminator - it proves the rule still exists and still fires, so the silence
    // above is the subset filtering rather than the rule having been deleted.
    const outOfSubset = mkdtempSync(join(tmpRoot, 'brand-subset-out-'));
    copyFileSync(join(FIXTURE_DIR, 'bad-viewbox.svg'), join(outOfSubset, 'bad-viewbox.svg'));
    expect(lintDir(outOfSubset, { only: BRAND_RULES }).violations).toEqual([]);
    expect(lintDir(outOfSubset).violations.map((v) => v.rule)).toEqual(['viewbox']);
  });
});

/* ------------------------------------------------------------------ *
 * The FOURTH walked directory (plan 80.1-02, MARK-17)
 * ------------------------------------------------------------------ */

describe('lint-svg chrome-brand walk - src/chrome/brand/ under the subset plus chrome-ink', () => {
  /**
   * THE ANTI-VACUITY FLOOR, AS A NAMED FILE rather than an asset count, copying the choice
   * `FLOOR_FILE` above records and for the same stated reason: a count literal has to be
   * hand-edited the moment Phase 81 or 83 adds a second cut here, and a literal that reddens
   * on correct work teaches an executor to edit the assertion instead of the code. This name
   * cannot be satisfied by a walk over nothing and is undisturbed by a directory that grows.
   *
   * `chrome/brand/fabrico-header.svg` and NOT the bare filename, because this directory IS
   * inside `frontend/src/`, so `displayPath` renders it relative rather than degrading it -
   * the one difference from the `docs/brand/` walk above.
   */
  const FLOOR_FILE = 'chrome/brand/fabrico-header.svg';

  /**
   * The rule subset this walk uses: the existing subject-agnostic set PLUS `chrome-ink`.
   *
   * TRANSCRIBED HERE AND THEN CHECKED AGAINST THE CALL SITE, rather than trusted. A gate that
   * lints the cut under a list the CLI does not actually pass would report a property nobody
   * enforces, so the third case below reads `scripts/lint-svg.ts` and asserts the fourth walk
   * passes both halves of the same opt-in.
   */
  const CHROME_BRAND_RULES: readonly RuleId[] = [...BRAND_RULES, 'chrome-ink'];

  it('walks the chrome brand directory and finds its named floor file', () => {
    const result = lintDir(CHROME_BRAND_DIR, { only: CHROME_BRAND_RULES, chromeInk: true });
    expect(result.dir).toBe('chrome/brand/');
    expect(result.assets).toContain(FLOOR_FILE);
  });

  it('reports the committed header cut clean under the subset', () => {
    expect(
      lintDir(CHROME_BRAND_DIR, { only: CHROME_BRAND_RULES, chromeInk: true }).violations,
    ).toEqual([]);
  });

  it('is a REAL FILTER in both directions on THIS directory, and the CLI passes this subset', () => {
    // ONE DIRECTION ALONE PROVES NOTHING. A subset that filtered EVERYTHING would satisfy the
    // clean report above and the drop half below; a subset that filtered NOTHING would satisfy
    // the keep half. Both run over this directory's own committed subject rather than over a
    // fixture authored to agree with the case.

    // THE DROP HALF, and it is the reason this directory exists at all. The committed cut
    // linted with NO options fires the three chrome-dialect rules that refuse it: its crop
    // window is not one of the four `LEGAL_VIEWBOXES` literals, its glyph outlines and
    // measured crop top are fractional, and its stadium arcs and drum circles are curves.
    // Stated as the exact rule set rather than a count: if a future rule starts firing here,
    // this reddens and `CHROME_BRAND_DIR`'s docblock (which claims exactly three) should be
    // corrected with it rather than the expectation loosened.
    const fullRules = [...new Set(lintDir(CHROME_BRAND_DIR).violations.map((v) => v.rule))].sort();
    expect(fullRules).toEqual(['curve', 'non-integer-coord', 'viewbox']);
    for (const dropped of fullRules) {
      expect(CHROME_BRAND_RULES, `${dropped} is in the subset`).not.toContain(dropped);
    }

    // THE KEEP HALF, over the rule this walk ADDS to `BRAND_RULES`. A scratch copy, never the
    // tracked file (the WR-10 contract). `chrome-ink` is not a member of `BRAND_RULES`, so a
    // walk called `{ only: BRAND_RULES }` would lint a hex-collapsed one-colour mark green -
    // which is precisely the failure the cut is exposed to, because `svgToElements.paintOf`
    // rewrites a ramp hex to `currentColor` and silently merges three layers into one.
    const dir = mkdtempSync(join(tmpRoot, 'chrome-brand-hexed-'));
    writeFileSync(
      join(dir, 'fabrico-header.svg'),
      readFileSync(join(CHROME_BRAND_DIR, 'fabrico-header.svg'), 'utf8').replace(
        'fill="var(--fab-ink)"',
        'fill="#b0bacb"',
      ),
    );
    const hexed = lintDir(dir, { only: CHROME_BRAND_RULES, chromeInk: true }).violations;
    expect(hexed.map((v) => v.rule)).toEqual(['chrome-ink']);
    // NON-VACUITY on the substitution itself: a `replace` that matched nothing would leave a
    // conforming file and satisfy the drop half of this case while proving nothing about the
    // keep half. The message names the offending value, so a silent no-op is visible here.
    expect(hexed[0]!.message).toBe('fill="#b0bacb" is not a chrome ink');

    // AND THE CLI PASSES THE SAME OPT-IN. Without this the two cases above would hold over a
    // subset assembled in this file and never used, which is a gate on a walk nobody runs.
    // Both halves are required and neither works alone: `only` filters the VIOLATIONS and
    // `chromeInk` runs the CHECK, so naming the rule without enabling it filters findings
    // from a check that never ran.
    const src = readFileSync(new URL('../../../scripts/lint-svg.ts', import.meta.url), 'utf8');
    const call = /lintDir\(CHROME_BRAND_DIR[^)]*\)/.exec(src);
    expect(call, 'the CLI declares no fourth walk over CHROME_BRAND_DIR').not.toBeNull();
    expect(call![0], 'the fourth walk does not name chrome-ink in its `only` list').toContain(
      "'chrome-ink'",
    );
    expect(call![0], 'the fourth walk does not enable chromeInk, so the rule never runs').toContain(
      'chromeInk: true',
    );
  });
});
