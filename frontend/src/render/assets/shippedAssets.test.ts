// shippedAssets.test.ts - the three gates a per-file linter STRUCTURALLY CANNOT HOLD
// (ART-01/ART-04, plan 58-02).
//
// `scripts/lint-svg.ts` is SUBJECT-AGNOSTIC BY DESIGN: it does not know what a file is
// meant to depict, and that is the right shape for a format checker. The consequence is a
// class of defect it cannot see, and Phase 57's review filed the first instance of it as
// WR-13 - `LEGAL_VIEWBOXES` accepts any of the four legal boxes for ANY file, so an asset
// authored at the wrong footprint for its subject lints clean and is then silently
// cropped. Phase 57 closed that hole for the 32 board CANDIDATES, in the candidates' own
// gate, beside their own stem table (`candidates/candidateLint.test.ts`). This file is
// the same closure for SHIPPED art, and it holds two further gates that need the same
// knowledge.
//
// THE THREE GATES, all at FAIL severity, all with a proven negative case:
//
//   1. SUBJECT KEYING     - a `sink.svg` at `0 0 64 64` fails, even though that literal
//                           is on the four-value whitelist. Closes WR-13 for shipped art.
//   2. INK ALLOWLIST      - every colour literal is exactly a `LOCKED_SKIN.palette.ramp`
//                           value, asserted over the VALUE SET, reporting the index each
//                           literal matched. Also refuses a paint-free asset.
//   3. EVEN COORDINATES   - shipped machine art sits on the 2u sub-module.
//
// THREE MORE HAVE SINCE JOINED THEM, each with its own preamble further down and each
// closing a hole a mutation proved was open: GATE 4 (lock axis 6, the fill ceiling) and
// GATE 5 (lock axis 2, the two stroke weights) came from the 58 review's WR-06, and GATE 6
// (ART-04 provenance) from the Phase 58 verification's Gap 1, where an asset declaring
// itself a game-icons.net derivative shipped past 1443 tests.
//
// WHY GATE 3 IS HERE AND NOT A LINT RULE, stated at length because the plan for this work
// specified the opposite and the measurement changed the answer. `even-coords` was to be
// a thirteenth rule in `scripts/lint-svg.ts`, at fail severity, over the production walk.
// A scan of all 50 committed `.svg` files found TWO bodies of CORRECT SVG that carry odd
// coordinates and must keep them:
//
//   - `pilot.svg` (`M3 3 H29 V29 H3 Z`). It is the permanent calibration fixture, it is
//     IN the production walk, its geometry is pinned by a committed `maxDiffPixels: 0`
//     PNG baseline (`vector-pilot`) and it is the subject of the digest table's
//     mutation demonstration (`H29` -> `H28`). Changing it moves a baseline.
//   - TWELVE of the thirty-two Phase 57 board candidates. They are the artefact
//     actually judged on 2026-07-31; re-authoring them to satisfy a rule invented after
//     the judgement would falsify the board record.
//
// A blanket rule would therefore need thirteen exemptions, and a rule with thirteen
// exemptions is not a rule - it is an allowlist wearing a rule's name, which is exactly
// the shape of failure this milestone keeps finding. The rule is real, it is at fail
// severity, and it has a committed failing fixture; it is simply scoped to the eight
// subjects, in the file that knows what a subject is. `__fixtures__/lint/odd-coords.svg`
// still lives with the other format demonstrations and is read from here.
//
// NO NEW DEPENDENCY. Every check is a text scan over committed first-party markup, in the
// same strip-the-header-then-scan discipline `candidateLint.test.ts` uses, so a docblock
// that NAMES a trap cannot count as an occurrence of it.
//
// No `@vitest-environment` docblock: these gates are DOM-free and stay on the project
// default node environment. Tessellation is `vertexBudget.test.ts`'s job.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintDir, report } from '../../../scripts/lint-svg.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';

/** `render/assets/` itself - this spec lives in it. See `vertexBudget.test.ts` on why. */
const ASSET_DIR = import.meta.dirname;
const LINT_FIXTURE_DIR = join(ASSET_DIR, '__fixtures__', 'lint');

/**
 * THE FOOTPRINT EACH SHIPPED SUBJECT IS AUTHORED AT, as an exact `viewBox` string. Eight
 * rows, one per machine subject, HAND-WRITTEN.
 *
 * NEVER COMPUTED - not from `KIND_SPECS`, not from `base_footprint`, not from the files
 * themselves. An assertion derived from the source it checks cannot fail: generate this
 * from the footprint table and the gate would agree with a wrong footprint table, and
 * read it off the file and the gate would agree with a wrong file. It is the same
 * reasoning `LEGAL_VIEWBOXES` already carries in `scripts/lint-svg.ts`, and the same
 * table `candidates/candidateLint.test.ts` keeps for the drafts.
 *
 * THE PAIRING WITH THE LINT'S WHITELIST IS THE WHOLE MECHANISM. The lint says the box is
 * one of four; this says WHICH of the four this subject gets. Neither alone catches a
 * `sink.svg` authored at `0 0 64 64`: the box is legal, and the file is then drawn at
 * half scale into a 1x1 cell with no error anywhere.
 *
 * 1x1 -> `0 0 32 32`, 2x2 -> `0 0 64 64`, 2x3 -> `0 0 64 96`, 3x3 -> `0 0 96 96`.
 */
const SUBJECT_VIEWBOX: Readonly<Record<string, string>> = {
  balancer: '0 0 64 64',
  endpoint: '0 0 32 32',
  factory: '0 0 96 96',
  merge: '0 0 64 64',
  router: '0 0 64 96',
  sink: '0 0 32 32',
  source: '0 0 32 32',
  tee: '0 0 64 64',
};

/**
 * THE SHIPPED MACHINE SUBJECT COUNT, as a stated literal. Eight machine kinds, of which
 * the ninth flat file (`pilot.svg`) is NOT one - it is the calibration fixture.
 */
const EXPECTED_SUBJECT_COUNT = 8;

/**
 * The one flat `.svg` in this directory that is NOT machine art.
 *
 * It stays in the production walk deliberately (that is what keeps it measured by the
 * budget gate and the digest table) and it is excluded from the SUBJECT-scoped gates
 * here, because it has no subject: it is a registration target, not a machine, and
 * `render/assets/README.md` says it must never be improved toward one.
 */
const CALIBRATION_FIXTURE = 'pilot.svg';

/** The SAME non-recursive, sorted `.svg` discovery every other gate in this directory uses. */
function discoverAssets(): string[] {
  return readdirSync(ASSET_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.svg'))
    .map((e) => e.name)
    .sort();
}

/**
 * The DRAWN markup of an asset - its header comment stripped.
 *
 * Load-bearing, not hygiene: every shipped header NAMES the literal it is allowed to use
 * and several of them name traps in prose. A scan over the raw text would count a
 * docblock's mention of `#b0bacb` as ink and, worse, would let a file pass a paint check
 * on the strength of its own comment.
 */
function markupOf(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * The exact inverse of {@link markupOf} - every comment block in the file, joined.
 *
 * GATE 6 is the one gate in this directory whose subject IS the prose, so it needs the
 * half of the file every other gate throws away. Written as its own function rather than
 * as an inline regex so the pairing with `markupOf` is visible: between them they
 * partition the file, and a check that read the whole text would be reading both.
 */
function headerOf(text: string): string {
  return (text.match(/<!--[\s\S]*?-->/g) ?? []).join('\n');
}

/** Prose collapsed to single-spaced text, so a re-wrap of a comment is not a diff. */
function normaliseProse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readAsset(name: string): string {
  return readFileSync(join(ASSET_DIR, name), 'utf8');
}

/* ------------------------------------------------------------------ *
 * GATE 1 - subject keying (closes WR-13 for shipped art)
 * ------------------------------------------------------------------ */

/**
 * Check one file's `viewBox` against the footprint ITS SUBJECT has. Returns a violation
 * string per problem, empty when clean - report-all, matching the lint's own contract.
 *
 * An unknown stem is a VIOLATION rather than a skip. A file whose subject this table does
 * not know is a file this gate cannot check, and a gate that silently passes what it
 * cannot check is the false green every assertion in this directory is written against.
 */
function checkSubjectViewBox(name: string, text: string): string[] {
  const stem = name.replace(/\.svg$/, '');
  const expected = SUBJECT_VIEWBOX[stem];
  if (expected === undefined) {
    return [
      `render/assets/${name}  stem "${stem}" has no stated footprint - add it to ` +
        'SUBJECT_VIEWBOX deliberately, never widen the check',
    ];
  }
  // EXACT STRING EQUALITY, matching the lint's own comparison discipline: not a regex and
  // not a divisibility test, so a transposed `0 0 96 64` fails.
  const actual = /viewBox="([^"]*)"/.exec(markupOf(text))?.[1];
  if (actual === expected) return [];
  return [
    `render/assets/${name}  viewBox="${actual ?? '<none>'}" - expected "${expected}" for a ` +
      `${stem}. A wrong footprint is NOT a lint error: all four boxes are whitelisted, so ` +
      'this file lints clean and is then drawn at the wrong scale with no error anywhere.',
  ];
}

/* ------------------------------------------------------------------ *
 * GATE 2 - the ink allowlist, over the ramp VALUE SET
 * ------------------------------------------------------------------ */

/**
 * The shipped ramp, rendered as lowercase `#rrggbb` literals - DERIVED FROM
 * `LOCKED_SKIN.palette.ramp` at run time, never a hand-copied hex list.
 *
 * That derivation is the point of the gate. A copied list would agree with a ramp that
 * had changed and the assets would keep passing while drawing a colour the skin no longer
 * contains. This is the one place in the file where reading the source under test is
 * CORRECT: the ramp is the authority, and the assets are what is being checked against it.
 */
const RAMP_LITERALS: readonly string[] = LOCKED_SKIN.palette.ramp.map(
  (c) => `#${c.toString(16).padStart(6, '0')}`,
);

/** Every colour literal in some markup, in document order, with its source attribute. */
function colourLiteralsIn(markup: string): Array<{ attr: string; value: string }> {
  const out: Array<{ attr: string; value: string }> = [];
  for (const m of markup.matchAll(/(fill|stroke)="([^"]*)"/g)) {
    const value = (m[2] as string).trim();
    // `none` is the ABSENCE of paint, not a colour. It is a legal, explicit declaration
    // (`explicit-paint` accepts it) and there is nothing for an allowlist to check.
    if (value === 'none') continue;
    out.push({ attr: m[1] as string, value });
  }
  return out;
}

interface InkReport {
  violations: string[];
  /** Every literal that PASSED, with the ramp index it matched. Reported, not just counted. */
  matched: Array<{ attr: string; value: string; rampIndex: number }>;
}

/**
 * Assert one asset's ink over the ramp VALUE SET, and refuse an asset that paints nothing.
 *
 * TWO FAILURE MODES, and the second is the one with history. A literal outside the ramp is
 * the obvious one. The other is an asset whose every path declares `fill="none"
 * stroke="none"`: it satisfies `explicit-paint` (a declaration WAS made), it satisfies the
 * vertex budget (Pixi falls back to `noStyle -> fillStyle = { color: 0 }` and tessellates
 * real geometry - MEASURED at eight vertices for one such path), and it renders as a SOLID
 * BLACK SQUARE. That exact mutation survived first run three separate times in Phase 57
 * (57-01 M3, 57-04 M4, 57-06 M2), which is why this is a value-set assertion rather than a
 * well-formedness one, and why zero paint is a named failure rather than an empty pass.
 */
function checkInk(name: string, text: string): InkReport {
  const markup = markupOf(text);
  const literals = colourLiteralsIn(markup);
  const violations: string[] = [];
  const matched: InkReport['matched'] = [];

  for (const { attr, value } of literals) {
    const rampIndex = RAMP_LITERALS.indexOf(value.toLowerCase());
    if (rampIndex === -1) {
      violations.push(
        `render/assets/${name}  ${attr}="${value}" is not a LOCKED_SKIN.palette.ramp value ` +
          `(the ramp is ${RAMP_LITERALS.join(' / ')}). Shipped art carries the skin's own ink; ` +
          'the candidates\' "it never ships" exemption does not reach this directory.',
      );
      continue;
    }
    matched.push({ attr, value, rampIndex });
  }

  // PAINT-FREE IS `literals.length === 0`, NOT `matched.length === 0`, and the difference
  // is a real defect caught by this gate's own negative cases during 58-02. Keying it off
  // `matched` meant an asset with ONE bad colour reported TWO violations - the wrong
  // literal, and a "declares no paint" claim that was simply untrue of a file painting a
  // near-miss grey. Two messages for one defect is the noise this directory's report-all
  // contract exists to avoid, and the second one sends a reader looking for a missing
  // attribute that is right there.
  if (literals.length === 0) {
    violations.push(
      `render/assets/${name}  declares NO paint anywhere - every path is fill="none" ` +
        'and/or stroke="none". Pixi renders that as a SOLID BLACK SQUARE, not as a blank: ' +
        'the declared-but-empty paint is treated as no paint and `renderChildren` falls ' +
        'back to a black fill. An asset that paints nothing is not a passing asset.',
    );
  }
  return { violations, matched };
}

/* ------------------------------------------------------------------ *
 * GATE 3 - even coordinates, on the 2u sub-module
 * ------------------------------------------------------------------ */

/**
 * Geometry attributes whose numbers are COORDINATES. Deliberately narrower than the
 * lint's `GEOMETRIC_ATTRS`: `stroke-width`, `stroke-dasharray` and `stroke-dashoffset` are
 * excluded because the locked stroke system is 3u structural / 2u detail (axis 2), and
 * `3` is a LOCKED VALUE rather than a coordinate. A rule that reddened on
 * `stroke-width="3"` would be demanding a change to the lock, which is not this rule's
 * business.
 */
const COORDINATE_ATTRS: readonly string[] = [
  'd',
  'x',
  'y',
  'width',
  'height',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
];

/**
 * Every coordinate in shipped machine art is an EVEN integer.
 *
 * THE DERIVATION, so this reads as measured rather than invented. The locked detail stroke
 * is 2u (axis 2), so the natural sub-module of the glyph grid is 2u, not 1u. On a 2u grid
 * every part's centreline, every mirror pair about a cell centre (16, 32, 48) and every
 * clearance between two 2u strokes is expressible without a half-unit - `ENDPOINT`'s
 * socket back wall at x = 12 spanning 11-13 against a chevron apex at x = 16 spanning
 * 15-17 is the worked example, and it is arithmetic a reviewer can do in their head. Land
 * one coordinate on the odd step and every clearance in that subject becomes a half-unit
 * argument, which is how a 1px collision ships.
 *
 * NON-INTEGER TOKENS ARE NOT THIS RULE'S BUSINESS and are skipped: `non-integer-coord` in
 * the lint already names them, at fail severity, with a better message. One defect, one
 * rule - double-reporting `28.5` would make both messages noise.
 */
function checkEvenCoords(name: string, text: string): string[] {
  const out: string[] = [];
  const lines = markupOf(text).split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      if (!COORDINATE_ATTRS.includes(m[1] as string)) continue;
      for (const t of (m[2] as string).matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)) {
        const token = t[0];
        if (!/^-?\d+$/.test(token)) continue; // `non-integer-coord` owns this
        if (Number(token) % 2 === 0) continue;
        out.push(
          `render/assets/${name}:${i + 1}  odd coordinate '${token}' in ${m[1]} - shipped ` +
            'machine art sits on the 2u sub-module (the locked detail stroke is 2u), so every ' +
            'clearance and every mirror pair stays a whole unit. Move it to the even step.',
        );
      }
    }
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * A scratch directory for the proven-to-fail cases
 * ------------------------------------------------------------------ */

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'fabrico-shipped-assets-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write one throwaway asset and return its text. The committed eight are never mutated. */
function scratchAsset(label: string, body: string): string {
  const dir = mkdtempSync(join(tmpRoot, `${label}-`));
  const path = join(dir, `${label}.svg`);
  writeFileSync(path, body);
  return readFileSync(path, 'utf8');
}

/* ------------------------------------------------------------------ *
 * The set under test
 * ------------------------------------------------------------------ */

describe('the shipped set is exactly the eight subjects plus the calibration fixture', () => {
  it('discovers nine flat assets, and the subject table covers exactly eight of them', () => {
    const assets = discoverAssets();
    expect(assets).toHaveLength(EXPECTED_SUBJECT_COUNT + 1);
    expect(assets).toContain(CALIBRATION_FIXTURE);

    const subjects = assets.filter((n) => n !== CALIBRATION_FIXTURE);
    expect(subjects).toHaveLength(EXPECTED_SUBJECT_COUNT);
    // Both directions. A subset check would let a subject ship with no stated footprint;
    // a superset check would let a stated footprint outlive the file it describes.
    expect(subjects.map((n) => n.replace(/\.svg$/, ''))).toEqual(
      Object.keys(SUBJECT_VIEWBOX).sort(),
    );
    expect(Object.keys(SUBJECT_VIEWBOX)).toHaveLength(EXPECTED_SUBJECT_COUNT);
    // The non-recursive walk cannot see the candidates or the fixtures.
    expect(assets.some((a) => a.includes('/'))).toBe(false);
  });
});

describe('GATE 1 - every shipped asset is authored at the footprint its SUBJECT has', () => {
  it('all eight subjects are at their stated box, and every offender would be named', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of discoverAssets()) {
      if (name === CALIBRATION_FIXTURE) continue;
      scanned += 1;
      offenders.push(...checkSubjectViewBox(name, readAsset(name)));
    }
    // Non-vacuity: a scan that opened no files is not a scan.
    expect(scanned).toBe(EXPECTED_SUBJECT_COUNT);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('FAILS a sink authored at 0 0 64 64 - a LEGAL box that is the wrong one for the stem', () => {
    // THE WR-13 CASE, and the whole reason this gate exists. `0 0 64 64` is on the lint's
    // four-value whitelist, so `scripts/lint-svg.ts` reports this file clean. Only a
    // subject-keyed check rejects it, and without one the asset is drawn at double scale
    // into a 1x1 cell with no error anywhere.
    //
    // Proven on a TEMP FILE. The committed `sink.svg` is not edited, not even transiently:
    // a gate demonstrated by mutating the artefact it guards is a gate that has been
    // switched off, however briefly.
    const text = scratchAsset(
      'sink',
      [
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="ring" d="M 10 10 H 22 V 22 H 10 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );

    const violations = checkSubjectViewBox('sink.svg', text);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('viewBox="0 0 64 64"');
    expect(violations[0]).toContain('expected "0 0 32 32"');
    expect(violations[0]).toContain('lints clean');

    // The discriminator: the SAME box on a subject that genuinely has it passes. Without
    // this half, a checker that rejected `0 0 64 64` outright would satisfy the case above.
    expect(checkSubjectViewBox('tee.svg', text)).toEqual([]);
  });

  it('FAILS a transposed router (0 0 96 64), which is a footprint no machine has', () => {
    const text = scratchAsset(
      'router',
      [
        '<svg viewBox="0 0 96 64" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="diamond" d="M 32 24 L 54 48 L 32 72 L 10 48 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkSubjectViewBox('router.svg', text);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('expected "0 0 64 96"');
  });

  it('FAILS an unknown stem rather than skipping it - an unchecked file is not a clean one', () => {
    const text = scratchAsset(
      'splitter',
      ['<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">', '</svg>', ''].join('\n'),
    );
    const violations = checkSubjectViewBox('splitter.svg', text);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('has no stated footprint');
    expect(violations[0]).toContain('never widen the check');
  });

  it('reads the DRAWN viewBox, not one quoted in a header comment', () => {
    // Several shipped headers discuss `viewBox` values in prose - `router.svg` names the
    // transposed `0 0 96 64` explicitly in order to say it is illegal. A scan over raw
    // text would read the prose and pass a file whose real box is wrong.
    const text = scratchAsset(
      'source',
      [
        '<!-- this file discusses viewBox="0 0 96 96" in prose, which is NOT its box -->',
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="eye" d="M 10 16 L 16 10 L 22 16 L 16 22 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkSubjectViewBox('source.svg', text);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('viewBox="0 0 64 64"'); // the drawn one, not the quoted one
  });
});

describe('GATE 2 - every colour literal is a LOCKED_SKIN.palette.ramp VALUE', () => {
  it('derives the allowlist from the shipped ramp, and the ramp is not empty', () => {
    // The allowlist is only as good as its source, so the source is asserted first.
    expect(RAMP_LITERALS.length).toBe(LOCKED_SKIN.palette.ramp.length);
    expect(RAMP_LITERALS.length).toBeGreaterThanOrEqual(3);
    for (const literal of RAMP_LITERALS) expect(literal).toMatch(/^#[0-9a-f]{6}$/);
    // `ramp[4]` is the ink lock axis 9 permits for every kind's glyph. Named here so a
    // ramp reorder is visible in this file rather than only in the assets.
    expect(RAMP_LITERALS[4]).toBe('#b0bacb');
  });

  it('passes all NINE flat assets and REPORTS the ramp index every literal matched', () => {
    const offenders: string[] = [];
    const report: string[] = [];
    let scanned = 0;

    for (const name of discoverAssets()) {
      scanned += 1;
      const { violations, matched } = checkInk(name, readAsset(name));
      offenders.push(...violations);
      // The gate REPORTS rather than merely permits: an index printed per literal is what
      // makes "these are ramp values" a readable fact instead of a boolean.
      for (const m of matched) report.push(`${name}  ${m.attr}="${m.value}" = ramp[${m.rampIndex}]`);
    }

    expect(scanned).toBe(EXPECTED_SUBJECT_COUNT + 1);
    expect(offenders, offenders.join('\n')).toEqual([]);
    // Non-vacuity: an empty match list would satisfy the offender assertion perfectly.
    expect(report.length).toBeGreaterThanOrEqual(scanned);
    // Every one of the eight subjects paints in ramp[4] and in nothing else - the single
    // ink lock axis 9 permits. The pilot is the one file that also uses ramp[3], and it is
    // not machine art.
    const subjectIndices = new Set<number>();
    for (const name of discoverAssets()) {
      if (name === CALIBRATION_FIXTURE) continue;
      for (const m of checkInk(name, readAsset(name)).matched) subjectIndices.add(m.rampIndex);
    }
    expect([...subjectIndices]).toEqual([4]);
  });

  it('FAILS a literal that is not a ramp value, even a plausible near-miss', () => {
    // `#b0bacc` is one hex digit from the ink. A well-formedness check passes it; a
    // VALUE-SET check does not, which is the difference this gate is built on.
    const text = scratchAsset(
      'nearmiss',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="eye" d="M 10 16 L 16 10 L 22 16 Z" fill="none" stroke="#b0bacc" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const { violations, matched } = checkInk('nearmiss.svg', text);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('#b0bacc');
    expect(violations[0]).toContain('is not a LOCKED_SKIN.palette.ramp value');
    expect(matched).toEqual([]);
  });

  it('FAILS an accent colour - `working` green is a STATE channel, never authored ink', () => {
    // The most plausible wrong-but-tempting literal in the whole codebase: it IS a
    // `LOCKED_SKIN` colour, it IS what a working machine's outline turns, and it is
    // emphatically not authorable. State lives on the board-drawn chassis outline, and
    // lock axis 9 gives every kind's glyph ONE ink. Asserted against
    // `LOCKED_SKIN.accents.working` rather than a copied hex, so the case survives a
    // re-lock of the accent.
    const accent = `#${LOCKED_SKIN.palette.accents.working.toString(16).padStart(6, '0')}`;
    const text = scratchAsset(
      'accent',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        `  <path data-part="core" d="M 14 14 H 18 V 18 H 14 Z" fill="${accent}" />`,
        '</svg>',
        '',
      ].join('\n'),
    );
    const { violations } = checkInk('accent.svg', text);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(accent);
    // ...and the ramp genuinely does not contain it, so the case is not passing by typo.
    expect(RAMP_LITERALS).not.toContain(accent);
  });

  it('FAILS an asset whose every path is fill="none" stroke="none" - the black-square mutation', () => {
    // THIS EXACT MUTATION SURVIVED FIRST RUN THREE TIMES IN PHASE 57 (57-01 M3, 57-04 M4,
    // 57-06 M2). It defeats `explicit-paint` (a paint WAS declared), it defeats the vertex
    // budget's zero-geometry refusal (measured: such a path tessellates to eight
    // vertices), and it renders a solid black square rather than a blank. Only an
    // assertion over the paint VALUES catches it.
    const text = scratchAsset(
      'ghost',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="eye" d="M 10 16 L 16 10 L 22 16 Z" fill="none" stroke="none" />',
        '  <path data-part="pupil" d="M 14 14 H 18 V 18 H 14 Z" fill="none" stroke="none" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const { violations, matched } = checkInk('ghost.svg', text);
    expect(matched).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('declares NO paint anywhere');
    expect(violations[0]).toContain('SOLID BLACK SQUARE');
  });

  it('does NOT read ink out of a header comment', () => {
    // Every shipped header names `#b0bacb` in prose while explaining the colour rule. A
    // raw-text scan would let a file pass the paint check on the strength of its own
    // comment, which is a gate reading its own documentation as evidence.
    const text = scratchAsset(
      'commented',
      [
        '<!-- the one literal here is #b0bacb = LOCKED_SKIN.palette.ramp[4] -->',
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="eye" d="M 10 16 L 16 10 L 22 16 Z" fill="none" stroke="none" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const { violations, matched } = checkInk('commented.svg', text);
    expect(matched).toEqual([]);
    expect(violations[0]).toContain('declares NO paint anywhere');
  });
});

describe('GATE 3 - shipped machine art sits on the 2u sub-module', () => {
  it('all eight subjects carry only even coordinates, and every offender would be named', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of discoverAssets()) {
      if (name === CALIBRATION_FIXTURE) continue;
      scanned += 1;
      offenders.push(...checkEvenCoords(name, readAsset(name)));
    }
    expect(scanned).toBe(EXPECTED_SUBJECT_COUNT);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('FAILS the committed odd-coords fixture, naming the LINE and the offending number', () => {
    // THE PERMANENT DEMONSTRATION. `__fixtures__/lint/odd-coords.svg` is conforming in
    // every other respect - legal box, one flat path, a data-part, explicit paint, integer
    // coordinates, zero curves - so it isolates this rule and nothing else.
    const text = readFileSync(join(LINT_FIXTURE_DIR, 'odd-coords.svg'), 'utf8');
    const violations = checkEvenCoords('__fixtures__/lint/odd-coords.svg', text);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("odd coordinate '29' in d");
    expect(violations[0]).toContain('2u sub-module');
    // The LINE is part of the locator, exactly as the lint's own output is.
    expect(violations[0]).toMatch(/odd-coords\.svg:\d+ {2}odd coordinate/);
  });

  it('does NOT fire on stroke-width="3" - the locked structural weight is not a coordinate', () => {
    // The rule is scoped to the coordinate attribute set on purpose. `3` is lock axis 2's
    // structural stroke, a LOCKED VALUE, and a rule that reddened on it would be demanding
    // a change to the lock. `2` is exercised alongside it so the case is not passing
    // because the checker ignores the whole attribute list.
    const text = scratchAsset(
      'weights',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="a" d="M 4 4 H 28 V 28 H 4 Z" fill="none" stroke="#b0bacb" stroke-width="3" />',
        '  <path data-part="b" d="M 10 10 H 22" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(checkEvenCoords('weights.svg', text)).toEqual([]);
    // ...and the discriminator: one odd COORDINATE in the same file does fire, so the
    // case above is not passing because the checker found nothing to look at.
    const withOdd = text.replace('H 22', 'H 23');
    expect(checkEvenCoords('weights.svg', withOdd)).toHaveLength(1);
    expect(checkEvenCoords('weights.svg', withOdd)[0]).toContain("'23'");
  });

  it('leaves a FRACTIONAL coordinate to the lint, so one defect gets one message', () => {
    // `28.5` is a `non-integer-coord` failure in `scripts/lint-svg.ts`, at fail severity,
    // with a better message. Reporting it here as well would make both noise.
    const text = scratchAsset(
      'fractional',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="a" d="M 4 4 H 28.5 V 28 H 4 Z" fill="#b0bacb" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(checkEvenCoords('fractional.svg', text)).toEqual([]);
  });

  it('reports EVERY odd coordinate in one pass, never just the first', () => {
    const text = scratchAsset(
      'many',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="a" d="M 3 4 H 29 V 28 H 3 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '  <path data-part="b" d="M 7 7 H 21" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkEvenCoords('many.svg', text);
    // 3, 29, 3 on line 2; 7, 7, 21 on line 3.
    expect(violations).toHaveLength(6);
    expect(violations.filter((v) => v.includes(':2  '))).toHaveLength(3);
    expect(violations.filter((v) => v.includes(':3  '))).toHaveLength(3);
  });

  it('does NOT read coordinates out of a header comment', () => {
    const text = scratchAsset(
      'commented',
      [
        '<!-- the candidate drew this at d="M 19 15 L 19 21", corrected below -->',
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="a" d="M 20 16 L 20 20" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(checkEvenCoords('commented.svg', text)).toEqual([]);
  });

  it('states WHY the calibration fixture and the board candidates are out of scope', () => {
    // NOT AN EXEMPTION - a SCOPE. Both bodies are asserted to genuinely violate the rule,
    // so this case reddens if either is ever brought into conformance (at which point the
    // scope should be reconsidered rather than silently kept) AND if the checker ever
    // stops being able to see them.
    //
    // The pilot's geometry is pinned by a committed `maxDiffPixels: 0` baseline and by the
    // digest table's `H29` -> `H28` mutation demonstration. The candidates are the artefact
    // judged on 2026-07-31. Neither can be re-authored to satisfy a rule introduced
    // after the fact, and neither is machine art.
    const pilot = checkEvenCoords(CALIBRATION_FIXTURE, readAsset(CALIBRATION_FIXTURE));
    expect(pilot.length).toBeGreaterThan(0);
    expect(pilot[0]).toContain("odd coordinate '3'");

    const candidateRoot = join(ASSET_DIR, 'candidates');
    const offending: string[] = [];
    let scanned = 0;
    for (const dir of ['a', 'b', 'c', 'd']) {
      for (const name of readdirSync(join(candidateRoot, dir)).filter((n) => n.endsWith('.svg'))) {
        scanned += 1;
        const text = readFileSync(join(candidateRoot, dir, name), 'utf8');
        if (checkEvenCoords(`${dir}/${name}`, text).length > 0) offending.push(`${dir}/${name}`);
      }
    }
    expect(scanned).toBe(32);
    // TWELVE, as measured in plan 58-02. A literal, so a candidate quietly re-authored -
    // or a checker quietly narrowed - reddens here and has to be explained.
    expect(offending).toHaveLength(12);
    expect(offending).toContain('a/endpoint.svg'); // the one the shipped endpoint corrects
  });
});

/* ------------------------------------------------------------------ *
 * THE SWEEP - the gates over the finished set, composed rather than assumed
 * ------------------------------------------------------------------ */

describe('the sweep - every gate walks the SAME nine files', () => {
  it('the lint, the digest table and this spec agree on the shipped set', () => {
    // THE COMPOSITION CHECK, and it is not a duplicate of any of the three. Each gate
    // discovers its own files with its own `readdirSync`, and each is individually green
    // over whatever it found. NOTHING previously asserted that they found the SAME THING.
    //
    // That is a real gap rather than a hypothetical one: the walkers are three separate
    // copies of one convention (non-recursive, `.svg`, sorted), and a divergence in any
    // of them is invisible from inside that gate - it just measures a smaller set and
    // reports a cleaner green. This case is the only thing standing between the three.
    const mine = discoverAssets();
    const linted = lintDir(ASSET_DIR).assets.map((p) => p.replace(/^render\/assets\//, ''));
    const digested = Object.keys(
      JSON.parse(readFileSync(join(ASSET_DIR, '__digests__', 'geometry.digest.json'), 'utf8')),
    ).sort();

    expect(mine).toHaveLength(EXPECTED_SUBJECT_COUNT + 1);
    expect(linted).toEqual(mine);
    expect(digested).toEqual(mine);
  });

  it('reports zero FAIL-severity lint violations over the shipped nine', () => {
    const result = lintDir(ASSET_DIR);
    const fails = result.violations.filter((v) => v.severity === 'fail');
    expect(fails, fails.map((v) => `${v.path}:${v.line} ${v.message}`).join('\n')).toEqual([]);
    expect(report(result).failed).toBe(false);
    // Non-vacuity: a walk that found nothing would also report no failures, and `report`
    // refuses that case with its own message rather than a clean summary.
    // The summary NAMES ITS DIRECTORY as of plan 59-01: `lint:svg` now walks TWO shipped
    // asset directories (`render/assets/` and `chrome/assets/`), and an unnamed total
    // cannot be attributed to either. `result.dir` comes off the walk rather than being
    // restated, so this case cannot pass on a run that walked somewhere else.
    expect(result.dir).toBe('render/assets/');
    expect(report(result).text).toBe(
      `lint:svg  ${result.dir}  ${EXPECTED_SUBJECT_COUNT + 1} assets, 0 violations`,
    );
  });

  it('the 32 candidates exist and are INVISIBLE to the production walk', () => {
    // The non-recursive walk is the whole mechanism keeping drafts out of the shipped
    // tables - there is no ignore list to maintain and therefore none to get wrong. Both
    // halves are asserted: the drafts are really there, and none of them is in the walk.
    const candidateRoot = join(ASSET_DIR, 'candidates');
    let candidates = 0;
    for (const dir of ['a', 'b', 'c', 'd']) {
      candidates += readdirSync(join(candidateRoot, dir)).filter((n) => n.endsWith('.svg')).length;
    }
    expect(candidates).toBe(32);
    expect(discoverAssets()).toHaveLength(EXPECTED_SUBJECT_COUNT + 1);
    expect(lintDir(ASSET_DIR).assets.some((p) => p.includes('candidates'))).toBe(false);
  });
});

describe('the sweep - the shipped registry holds eight rows and no draft', () => {
  /** `svgAssets.ts`'s own source text. Read as an ARTIFACT, not imported and reflected on. */
  const REGISTRY_SOURCE = readFileSync(join(ASSET_DIR, '..', 'svgAssets.ts'), 'utf8');
  /** The pilot fixture module's source text (plan 91-03), read the same way. */
  const FIXTURE_SOURCE = readFileSync(join(ASSET_DIR, '..', '..', 'spike', 'pilotFixture.ts'), 'utf8');

  it('imports exactly the eight shipped subjects as `?raw` assets, none from candidates/ and not the calibration fixture', () => {
    // WHY READ THE TEXT RATHER THAN IMPORT THE MODULE. `ASSET_SOURCES` is not exported -
    // deliberately, since `AssetName` is the public surface - and `Object.keys(...)` on a
    // re-export would prove the module agrees with itself. What actually matters is that
    // no `candidates/` path is IMPORTABLE from the shipped registry, and that is a
    // property of the file's text.
    const imports = [...REGISTRY_SOURCE.matchAll(/^import .*? from '(\.\/assets\/[^']+)\?raw';$/gm)]
      .map((m) => m[1] as string)
      .sort();

    expect(imports).toHaveLength(EXPECTED_SUBJECT_COUNT);
    expect(imports).toEqual([
      './assets/balancer.svg',
      './assets/endpoint.svg',
      './assets/factory.svg',
      './assets/merge.svg',
      './assets/router.svg',
      './assets/sink.svg',
      './assets/source.svg',
      './assets/tee.svg',
    ]);
    // The registry imports exactly the files the walk discovers but the calibration
    // fixture - one row per shipped asset, no row without a file and no shipped file
    // without a row. The fixture stays on disk (the walkers hold it to the format) and
    // is imported by its own module under `src/spike/` only, which the build guard in
    // `vite.config.ts` keeps out of `dist/` (plan 91-03, CHROME-06, D-05).
    expect(imports.map((p) => p.replace('./assets/', ''))).toEqual(
      discoverAssets().filter((f) => f !== CALIBRATION_FIXTURE),
    );
    expect(FIXTURE_SOURCE).toMatch(/^import \w+ from '\.\.\/render\/assets\/pilot\.svg\?raw';$/m);
  });

  it('mentions no candidate path ANYWHERE in the registry, not even in a comment', () => {
    // A draft that becomes importable is a draft that can ship by accident
    // (57-ART-LOCK.md section 6). The check is over the whole file rather than over the
    // import block, because a commented-out candidate import is one keystroke from live.
    expect(REGISTRY_SOURCE).not.toMatch(/\.\/assets\/candidates\//);
    expect(REGISTRY_SOURCE).not.toMatch(/candidates\/[abcd]\//);
  });
});

/* ------------------------------------------------------------------ *
 * GATE 4 - lock axis 6: at most LOCKED_SKIN.fillCeiling filled paths
 * GATE 5 - lock axis 2: only the two locked stroke weights
 * ------------------------------------------------------------------ *
 *
 * WHY THESE TWO EXIST (58 review WR-06). Both are LOCK AXES and neither had a
 * rule-level gate over the shipped art:
 *
 *   - `Skin.fillCeiling` was declared, validated and documented as transcribing axis 6,
 *     and NOTHING READ IT. `grep -rn fillCeiling frontend/src` returned only `skin.ts`,
 *     its own tests and the skin literals. WINDOWS ledger id 17 filed exactly this and
 *     assigned the gate to "58-02 / 58-03"; both plans shipped without it.
 *   - The lock's "only stroke-widths 2 and 3" was enforced nowhere: `lint-svg.ts`
 *     checks `stroke-width` for INTEGRALITY only, and GATE 3's `COORDINATE_ATTRS`
 *     deliberately excludes it (correctly - `3` is a locked value, not a coordinate).
 *
 * Measured before these were written: adding two extra `fill="#b0bacb"` paths to
 * `sink.svg` reddened 9 cases and setting `stroke-width="7"` on `merge.svg`'s neck
 * reddened 5 - but EVERY ONE of those was a geometry pin (`geometryDigest`,
 * `shapeDistinctness`, `vertexBudget`). Not one named the fill count or the weight. A
 * geometry digest is re-blessed BY DESIGN on any deliberate re-art
 * (`geometryDigest.test.ts:30-35`), so the next legitimate re-art would carry an axis
 * violation straight through. "Caught as `geometry changed`" is not a gate for a rule.
 */

/** Every filled (i.e. not `fill="none"`) path in the DRAWN markup. */
function countFills(text: string): number {
  return [...markupOf(text).matchAll(/fill="(?!none)[^"]*"/g)].length;
}

/** Every `stroke-width` value in the DRAWN markup, as numbers, in document order. */
function strokeWidthsIn(text: string): number[] {
  return [...markupOf(text).matchAll(/stroke-width="([^"]*)"/g)].map((m) => Number(m[1]));
}

describe('GATE 4 - lock axis 6: no subject exceeds LOCKED_SKIN.fillCeiling filled paths', () => {
  it('every shipped subject is at or under the ceiling, and the ceiling is the SKIN value', () => {
    // Read from the skin, never transcribed - that is the whole point of closing
    // ledger id 17 with a CONSUMER rather than with the phase.
    expect(LOCKED_SKIN.fillCeiling, '57-ART-LOCK.md axis 6').toBe(1);

    const offenders: string[] = [];
    let scanned = 0;
    for (const name of discoverAssets()) {
      if (name === CALIBRATION_FIXTURE) continue;
      scanned += 1;
      const fills = countFills(readAsset(name));
      if (fills > LOCKED_SKIN.fillCeiling) {
        offenders.push(`${name}: ${fills} filled paths against a ceiling of ${LOCKED_SKIN.fillCeiling}`);
      }
    }
    expect(scanned).toBe(EXPECTED_SUBJECT_COUNT);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('FAILS a subject with three fills - the exact mutation that reddened only geometry pins', () => {
    const text = scratchAsset(
      'overfill',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="a" d="M 4 4 H 8 V 8 H 4 Z" fill="#b0bacb" />',
        '  <path data-part="b" d="M 12 12 H 16 V 16 H 12 Z" fill="#b0bacb" />',
        '  <path data-part="c" d="M 20 20 H 24 V 24 H 20 Z" fill="#b0bacb" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(countFills(text)).toBe(3);
    expect(countFills(text)).toBeGreaterThan(LOCKED_SKIN.fillCeiling);
  });

  it('and `fill="none"` is NOT a fill - a stroked-only subject is at zero', () => {
    // The discriminator. Without it the rule would pass on a regex that counted every
    // `fill=` attribute, which would make every stroked subject an instant violator and
    // the "ceiling" meaningless.
    const text = scratchAsset(
      'strokeonly',
      [
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="a" d="M 4 4 H 8" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(countFills(text)).toBe(0);
  });
});

describe('GATE 5 - lock axis 2: every stroke-width is one of the two locked weights', () => {
  /** The lock's two weights, READ FROM THE SKIN rather than transcribed as 2 and 3. */
  const LEGAL_STROKE_WIDTHS = [LOCKED_SKIN.strokeDetail, LOCKED_SKIN.strokeStructural];

  it('all eight subjects use only the locked weights, and every offender would be named', () => {
    expect(LEGAL_STROKE_WIDTHS, '57-ART-LOCK.md axis 2 is 2u detail / 3u structural').toEqual([
      2, 3,
    ]);

    const offenders: string[] = [];
    let scanned = 0;
    for (const name of discoverAssets()) {
      if (name === CALIBRATION_FIXTURE) continue;
      scanned += 1;
      for (const w of strokeWidthsIn(readAsset(name))) {
        if (!LEGAL_STROKE_WIDTHS.includes(w)) {
          offenders.push(`${name}: stroke-width="${w}" is not one of ${LEGAL_STROKE_WIDTHS.join(' / ')}`);
        }
      }
    }
    expect(scanned).toBe(EXPECTED_SUBJECT_COUNT);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('FAILS stroke-width="7" - the exact mutation that reddened only geometry pins', () => {
    const text = scratchAsset(
      'fatstroke',
      [
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="neck" d="M 16 16 H 48" fill="none" stroke="#b0bacb" stroke-width="7" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(strokeWidthsIn(text)).toEqual([7]);
    expect(LEGAL_STROKE_WIDTHS).not.toContain(7);
  });

  it('does not read a stroke-width quoted in a HEADER COMMENT - the WR-02 rule, applied here too', () => {
    // Both helpers go through `markupOf`, so a header that discusses an illegal weight
    // in order to forbid it cannot fail its own subject. Same class of defect WR-02
    // fixed in `parseViewBox`, refused up front here rather than found later.
    const text = scratchAsset(
      'headerweight',
      [
        '<!-- A stroke-width="7" would be illegal under axis 2. -->',
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="a" d="M 4 4 H 8" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(strokeWidthsIn(text)).toEqual([2]);
  });
});

/* ------------------------------------------------------------------ *
 * GATE 6 - ART-04: the provenance paragraph, and no derivation claim
 * ------------------------------------------------------------------ *
 *
 * WHY THIS EXISTS (Phase 58 verification, Gap 1). The ART-04 requirement
 * row claimed "every shipped header carries its provenance paragraph, asserted by test",
 * and NO SUCH TEST EXISTED. The verifier proved it twice, and the second proof is the one
 * that matters: replacing `source.svg`'s provenance paragraph with
 *
 *     "DERIVED FROM game-icons.net (CC-BY-3.0) and Remix Icon; traced and redrawn."
 *
 * - a claim that would make the asset UNSHIPPABLE under ART-04's own licence rules -
 * passed the FULL vitest suite (1443 tests), `lint:svg` (9 assets, 0 violations) and
 * `tsc --noEmit` (exit 0). The art is original in fact; what was false was the claim that
 * a gate held it. That exact string is a case below, and this gate was watched failing on
 * it before it was committed.
 *
 * ART-04'S OWN RULES, which are what the check encodes rather than a general "don't
 * plagiarise" sentiment:
 *
 *   - Material Symbols (Apache-2.0) - permitted as a VOCABULARY REFERENCE ONLY. Reading
 *     it for "what does a fork icon usually look like" is fine; taking geometry from it
 *     is not, and the licence is not the reason (Apache-2.0 would allow it) - lock axis 8
 *     and the from-scratch authoring of the Phase 57 board are.
 *   - game-icons.net (CC-BY-3.0) - EXCLUDED OUTRIGHT. Redrawing does not clear CC-BY: a
 *     derivative still owes attribution, and no in-bundle attribution surface exists.
 *   - Remix Icon - EXCLUDED OUTRIGHT. Non-OSI, and its licence bans redistributing the
 *     icons as an icon pack, which is exactly what `render/assets/` is.
 *
 * THE HARD PART, and the reason this is not a one-line `not.toMatch(/game-icons/)`: every
 * shipped header NAMES all three sources, because the declaration works by naming what was
 * NOT used. A blanket name ban would redden on the eight conforming files. So the gate is
 * built the other way round:
 *
 *   1. Every subject must carry the ORIGINALITY DECLARATION VERBATIM (whitespace
 *      normalised, so a re-wrap is not a diff).
 *   2. The declaration is then REMOVED from the header, and no excluded source may be
 *      named anywhere in what remains. A negated mention lives inside the declaration by
 *      construction; a derivation claim cannot.
 *
 * That shape is what makes the check both non-vacuous and un-gameable by rewording: an
 * author who wants to change the wording has to change the stated declaration here, in a
 * diff a reviewer reads, which is the entire point of a licence-critical claim.
 *
 * SCOPE, split deliberately. The declaration is required of the EIGHT SUBJECTS. The
 * excluded-source scan runs over all NINE files, `pilot.svg` included: the calibration
 * fixture is first-party too (Plan 56-01) and it renders only on the dev-only pixel-guard
 * page, so it is not owed a shipped-art provenance paragraph - but a derivation claim in
 * it would still be a licence problem, and a gate that could not see it would be the
 * narrower-scan-reports-a-cleaner-green failure this directory is written against.
 */

/**
 * THE ART-04 ORIGINALITY DECLARATION, stated here in full and HAND-WRITTEN.
 *
 * Never read out of an asset and never assembled from the source table below - a claim
 * derived from the files it checks agrees with those files however they read. This is the
 * same discipline `SUBJECT_VIEWBOX` carries at the top of this file, applied to prose.
 */
const ORIGINALITY_DECLARATION = normaliseProse(`
  ART-04 PROVENANCE: authored from scratch for the Phase 57 board. No icon pack was
  consulted, copied, traced or redrawn - not Material Symbols (permitted as a VOCABULARY
  REFERENCE ONLY), and not game-icons.net (CC-BY-3.0, which redrawing does not clear) or
  Remix Icon (non-OSI), which are excluded outright.
`);

/** The paragraph's opening token, so "no paragraph at all" is a DISTINCT report from "wrong paragraph". */
const PROVENANCE_MARKER = 'ART-04 PROVENANCE:';

/**
 * The third-party icon sets ART-04 names, with the status ART-04 gives each.
 *
 * `excluded` sources may not be named outside the declaration AT ALL - there is no
 * legitimate sentence in a shipped header that mentions game-icons.net other than the one
 * saying it was not used, and that sentence is the declaration.
 *
 * `vocabulary-only` is narrower on purpose. Material Symbols IS permitted as a reference
 * for what a motif conventionally looks like, so merely naming it is not a violation;
 * naming it in the same sentence as a derivation verb is.
 */
interface SourceRule {
  readonly label: string;
  readonly pattern: RegExp;
  readonly status: 'excluded' | 'vocabulary-only';
  readonly why: string;
}

const NAMED_SOURCES: readonly SourceRule[] = [
  {
    label: 'game-icons.net',
    pattern: /game[\s-]?icons(\.net)?/i,
    status: 'excluded',
    why: 'CC-BY-3.0 - redrawing does NOT clear it, the derivative still owes attribution, and this bundle has no attribution surface',
  },
  {
    label: 'Remix Icon',
    pattern: /remix[\s-]?icons?/i,
    status: 'excluded',
    why: 'non-OSI, and its licence bans redistributing the icons as an icon pack - which is what render/assets/ is',
  },
  {
    label: 'Material Symbols',
    pattern: /material[\s-]?(symbols|icons)/i,
    status: 'vocabulary-only',
    why: 'Apache-2.0 and permitted as a VOCABULARY REFERENCE ONLY - naming it beside a derivation verb is a claim on its GEOMETRY',
  },
];

/**
 * Verbs that turn naming a source into CLAIMING it as one. Scoped to a sentence rather
 * than to the whole header, because `endpoint.svg` legitimately writes "this glyph must
 * NOT be geometrically derived from `layers/inletGlyph.ts`" - a derivation verb in a
 * sentence that names no icon set, and a sentence a header-wide verb scan would fail.
 */
const DERIVATION_VERB =
  /\b(deriv\w*|trac(e|ed|ing)|redraw\w*|redrew|copi(ed|es)|copy|adapt\w*|based on|lifted from|taken from)\b/i;

/**
 * Check one asset's header for the ART-04 claim. Report-all, matching this file's contract.
 *
 * `requireDeclaration` is false for the calibration fixture: it is not shipped machine art
 * and is not owed the paragraph, but the excluded-source half still runs over it.
 */
function checkProvenance(name: string, text: string, requireDeclaration: boolean): string[] {
  const out: string[] = [];
  const header = normaliseProse(headerOf(text));

  if (header === '') {
    return [
      `render/assets/${name}  carries NO header comment at all - the ART-04 provenance ` +
        'claim has nowhere to live.',
    ];
  }

  if (requireDeclaration) {
    if (!header.includes(PROVENANCE_MARKER)) {
      out.push(
        `render/assets/${name}  carries no "${PROVENANCE_MARKER}" paragraph. Every shipped ` +
          'subject records where its geometry came from; an asset with no stated provenance ' +
          'is an asset nobody can clear for shipping.',
      );
    } else if (!header.includes(ORIGINALITY_DECLARATION)) {
      out.push(
        `render/assets/${name}  has an ${PROVENANCE_MARKER} paragraph that is NOT the stated ` +
          'ART-04 declaration. Expected, verbatim (whitespace-insensitive):\n' +
          `  ${ORIGINALITY_DECLARATION}\n` +
          'Reword it here in ORIGINALITY_DECLARATION if the wording must change, so a licence ' +
          'claim moves in a diff a reviewer reads rather than in one file at a time.',
      );
    }
  }

  // The declaration NAMES all three sources in order to disclaim them, so it is removed
  // before the scan. Everything left is prose that named a source for some OTHER reason.
  const residue = header.split(ORIGINALITY_DECLARATION).join(' ');

  for (const rule of NAMED_SOURCES) {
    if (rule.status === 'excluded') {
      const hit = rule.pattern.exec(residue);
      if (hit !== null) {
        out.push(
          `render/assets/${name}  names "${hit[0]}" OUTSIDE the ART-04 declaration. ` +
            `${rule.label} is EXCLUDED OUTRIGHT (${rule.why}). The only sentence in a shipped ` +
            'header that may name it is the declaration saying it was not used.',
        );
      }
      continue;
    }
    // `vocabulary-only`: a mention is fine, a mention beside a derivation verb is not.
    for (const sentence of residue.split(/(?<=\.)\s+/)) {
      if (!rule.pattern.test(sentence)) continue;
      if (!DERIVATION_VERB.test(sentence)) continue;
      out.push(
        `render/assets/${name}  claims derivation from ${rule.label}: "${sentence.trim()}". ` +
          `${rule.why}.`,
      );
    }
  }
  return out;
}

describe('GATE 6 - ART-04: every subject states its provenance and claims no excluded source', () => {
  it('the stated declaration is the real one - it names all three sources and disclaims them', () => {
    // The gate is only as good as the sentence it demands, so the sentence is asserted
    // first. Without this, a declaration accidentally trimmed to "authored from scratch"
    // would still be "carried verbatim" by eight files that no longer disclaim anything.
    expect(ORIGINALITY_DECLARATION.startsWith(PROVENANCE_MARKER)).toBe(true);
    expect(ORIGINALITY_DECLARATION).toContain('authored from scratch');
    for (const rule of NAMED_SOURCES) {
      expect(rule.pattern.test(ORIGINALITY_DECLARATION), `${rule.label} is not disclaimed`).toBe(
        true,
      );
    }
    expect(ORIGINALITY_DECLARATION).toContain('excluded outright');
    expect(ORIGINALITY_DECLARATION).toContain('VOCABULARY REFERENCE ONLY');
  });

  it('all eight subjects carry the declaration, and every offender would be named', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of discoverAssets()) {
      if (name === CALIBRATION_FIXTURE) continue;
      scanned += 1;
      offenders.push(...checkProvenance(name, readAsset(name), true));
    }
    // Non-vacuity: a scan that opened no files is not a scan.
    expect(scanned).toBe(EXPECTED_SUBJECT_COUNT);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('...and the eight PASS while naming all three sources - the check is not a name ban', () => {
    // THE DISCRIMINATOR THAT MAKES THE GATE POSSIBLE. Every conforming header contains the
    // literal strings "game-icons.net" and "Remix Icon", because the declaration works by
    // naming what was not used. A gate built as `not.toMatch(/game-icons/)` would redden on
    // all eight correct files, which is why this one removes the declaration first and
    // scans the remainder.
    for (const name of discoverAssets()) {
      if (name === CALIBRATION_FIXTURE) continue;
      const header = readAsset(name);
      expect(header, `${name} does not name game-icons.net at all`).toContain('game-icons.net');
      expect(header, `${name} does not name Remix Icon at all`).toContain('Remix Icon');
    }
  });

  it('the calibration fixture is OUT OF SCOPE for the paragraph and IN SCOPE for the scan', () => {
    // NOT AN EXEMPTION - a SCOPE, stated the way GATE 3 states its own. `pilot.svg` is
    // first-party (Plan 56-01) and renders only on the dev-only pixel-guard page, so it is
    // not shipped machine art and is not owed a shipped-art provenance paragraph. A
    // derivation claim in it would still be a licence problem, so the excluded-source half
    // runs over it anyway.
    const text = readAsset(CALIBRATION_FIXTURE);
    expect(checkProvenance(CALIBRATION_FIXTURE, text, false)).toEqual([]);
    // ...and it genuinely has no paragraph, so the scoping is doing real work rather than
    // describing a file that would have passed either way.
    expect(normaliseProse(headerOf(text))).not.toContain(PROVENANCE_MARKER);
    expect(checkProvenance(CALIBRATION_FIXTURE, text, true)).toHaveLength(1);
  });

  it('FAILS the verifier\'s exact mutation - an explicit game-icons.net + Remix Icon derivation', () => {
    // THE STRING THAT SHIPPED PAST 1443 TESTS. Reproduced character for character from the
    // Phase 58 verification report, because a gate proven against a paraphrase of the
    // mutation is a gate proven against nothing.
    const text = scratchAsset(
      'source',
      [
        '<!--',
        '  render/assets/source.svg - SHIPPED art for the SOURCE machine.',
        '',
        '  ART-04 PROVENANCE: DERIVED FROM game-icons.net (CC-BY-3.0) and Remix Icon;',
        '  traced and redrawn.',
        '-->',
        '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="eye" d="M 10 16 L 16 10 L 22 16 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkProvenance('source.svg', text, true);
    // Three distinct facts, each reported once: the declaration is gone, and each excluded
    // source is claimed.
    expect(violations, violations.join('\n')).toHaveLength(3);
    expect(violations[0]).toContain('NOT the stated ART-04 declaration');
    expect(violations[1]).toContain('game-icons.net');
    expect(violations[1]).toContain('EXCLUDED OUTRIGHT');
    expect(violations[2]).toContain('Remix Icon');
  });

  it('FAILS a MISSING paragraph, not only a wrong one - the other half of the mutation', () => {
    // The verifier's FIRST proof: the paragraph deleted outright and a derivation claim
    // dropped elsewhere in the header. Both halves are reported, because they are two
    // different defects and a fix for one is not a fix for the other.
    const text = scratchAsset(
      'tee',
      [
        '<!--',
        '  render/assets/tee.svg - SHIPPED art for the TEE machine.',
        '  Traced from game-icons.net and cleaned up.',
        '-->',
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="spine" d="M 14 32 H 34" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkProvenance('tee.svg', text, true);
    expect(violations, violations.join('\n')).toHaveLength(2);
    expect(violations[0]).toContain('carries no "ART-04 PROVENANCE:" paragraph');
    expect(violations[1]).toContain('game-icons.net');
  });

  it('FAILS a header with NO provenance paragraph and nothing else wrong', () => {
    // The pure missing-paragraph case, isolated: a perfectly innocent header that simply
    // never states where the geometry came from. Exactly one violation, so "missing" is a
    // failure in its own right and not something the gate only notices when a bad claim is
    // attached to it.
    const text = scratchAsset(
      'merge',
      [
        '<!--',
        '  render/assets/merge.svg - SHIPPED art for the MERGE machine.',
        '  FOOTPRINT: 2x2, so viewBox 0 0 64 64. Two inputs converge on one output.',
        '-->',
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="neck" d="M 34 32 H 48" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkProvenance('merge.svg', text, true);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('carries no "ART-04 PROVENANCE:" paragraph');
    expect(violations[0]).toContain('nobody can clear for shipping');
  });

  it('FAILS a header with no comment at all - an unstated provenance is not a clean one', () => {
    const text = scratchAsset(
      'router',
      [
        '<svg viewBox="0 0 64 96" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="diamond" d="M 32 24 L 54 48 L 32 72 L 10 48 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkProvenance('router.svg', text, true);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('carries NO header comment at all');
  });

  it('FAILS a SUBTLE claim - the declaration intact, the derivation added a paragraph later', () => {
    // The realistic version, and the one a reviewer is most likely to miss: nobody deletes
    // the provenance paragraph, they add a sentence somewhere else in a 50-line header.
    // Removing the declaration before the scan is what catches it.
    const text = scratchAsset(
      'factory',
      [
        '<!--',
        '  render/assets/factory.svg - SHIPPED art for the FACTORY machine.',
        '',
        `  ${ORIGINALITY_DECLARATION}`,
        '',
        '  The roofline was later adapted from a Remix Icon factory pictogram to read',
        '  better at 3x3.',
        '-->',
        '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="roof" d="M 12 40 H 84" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    const violations = checkProvenance('factory.svg', text, true);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Remix Icon');
    expect(violations[0]).toContain('EXCLUDED OUTRIGHT');
  });

  it('MATERIAL SYMBOLS is vocabulary-only: naming it passes, claiming its geometry fails', () => {
    // Both halves, because the asymmetry IS the rule. ART-04 permits consulting Material
    // Symbols for what a motif conventionally looks like; it does not permit taking the
    // geometry. A gate that banned the name would forbid the permitted use, and a gate
    // that ignored the name would miss the forbidden one.
    const body = [
      '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">',
      '  <path data-part="eye" d="M 10 16 L 16 10 L 22 16 Z" fill="none" stroke="#b0bacb" stroke-width="2" />',
      '</svg>',
      '',
    ];
    const permitted = scratchAsset(
      'sink',
      [
        '<!--',
        '  render/assets/sink.svg - SHIPPED art for the SINK machine.',
        '',
        `  ${ORIGINALITY_DECLARATION}`,
        '',
        '  The bullseye motif is the one Material Symbols also uses for a target, which is',
        '  what makes it legible without a label.',
        '-->',
        ...body,
      ].join('\n'),
    );
    expect(checkProvenance('sink.svg', permitted, true)).toEqual([]);

    const claimed = permitted.replace(
      'The bullseye motif is the one Material Symbols also uses for a target, which is',
      'The bullseye ring was traced from the Material Symbols target glyph, which is',
    );
    const violations = checkProvenance('sink.svg', claimed, true);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('claims derivation from Material Symbols');
    expect(violations[0]).toContain('VOCABULARY REFERENCE ONLY');
  });

  it('does NOT fire on a derivation verb in a sentence that names no icon set', () => {
    // `endpoint.svg` really does write "this glyph must NOT be geometrically derived from
    // `layers/inletGlyph.ts`" - a first-party module, not an icon pack. A header-wide verb
    // scan would fail the shipped endpoint, which is why the vocabulary-only rule is
    // scoped to the sentence that names the source.
    const endpoint = readAsset('endpoint.svg');
    expect(normaliseProse(headerOf(endpoint))).toContain('must NOT be geometrically derived');
    expect(checkProvenance('endpoint.svg', endpoint, true)).toEqual([]);
  });

  it('reads the HEADER and not the markup - a data-part named for a pack is not a claim', () => {
    // The mirror of the "does NOT read ink out of a header comment" cases above: this gate
    // is the one that reads the comments, so it must NOT read the drawing. A path id is not
    // a provenance claim, and reporting it as one would send a reader hunting a sentence
    // that does not exist.
    const text = scratchAsset(
      'balancer',
      [
        '<!--',
        '  render/assets/balancer.svg - SHIPPED art for the BALANCER machine.',
        '',
        `  ${ORIGINALITY_DECLARATION}`,
        '-->',
        '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">',
        '  <path data-part="remix-icon-bar" d="M 16 24 H 48" fill="none" stroke="#b0bacb" stroke-width="2" />',
        '</svg>',
        '',
      ].join('\n'),
    );
    expect(checkProvenance('balancer.svg', text, false)).toEqual([]);
    // ...and the discriminator: the same string in the HEADER does fire, so the case above
    // is not passing because the scan found nothing to look at.
    const inHeader = text.replace(
      '  render/assets/balancer.svg - SHIPPED art for the BALANCER machine.',
      '  render/assets/balancer.svg - bars copied from a remix-icon bar chart.',
    );
    expect(checkProvenance('balancer.svg', inHeader, false)).toHaveLength(1);
  });

  it('no asset in the directory - the calibration fixture included - claims an excluded source', () => {
    // The whole-directory sweep, at the wider scope. Nine files, and the paragraph
    // requirement relaxed so this leg reports ONLY derivation claims.
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of discoverAssets()) {
      scanned += 1;
      offenders.push(...checkProvenance(name, readAsset(name), false));
    }
    expect(scanned).toBe(EXPECTED_SUBJECT_COUNT + 1);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
