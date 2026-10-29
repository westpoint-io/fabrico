// @vitest-environment jsdom
//
// THE ART-03 SHAPE GATE (plan 58-04) - the gate that can fail on the named pair.
//
// WHY THIS EXISTS, in one paragraph. `57-ART-LOCK.md` section 5 ceiling 4 handed
// Phase 58 an OPEN EXPOSURE rather than a solved problem: under Direction A
// `merge` and `balancer` are the SAME 4u-inset rectangle and only the 2u glyph
// separates them. The design call on 2026-08-01 was to keep the shared outline and
// separate the pair by glyph MASS DISTRIBUTION - and to GATE it, not assert it,
// with NO exemption and NO allowlist entry: "if the mass discriminator is too
// weak, the gate says so". Phase 57's mutation 57-05 M4 is the reason: copying one
// candidate over another reddened nothing, because every gate in the tree checked
// conformance and cost and none checked DISTINCTNESS.
//
// THE OCCUPANCY BITMAP COMES FROM PIXI'S OWN TESSELLATION. `measureSvg` parses the
// file through the same `SVGParser` the running app uses and hands back the
// triangle list; this spec fills those triangles into a 64x64 grid. It is NOT a
// `d`-string re-plot. Measuring the real parse path is the whole point of VEC-04,
// and an offline re-plot would re-implement the attribute-to-style mapping this
// repo has already refused once. That is also why this spec carries
// `@vitest-environment jsdom` - `SVGParser` calls `document.createElement`.
//
// WITH THE CHASSIS OUT OF EVERY FILE, glyph-only ink IS the whole asset. There is
// no `chassis` part to exclude and no exclusion is written for one: the chassis is
// drawn parametrically by `layers/machineChassis.ts` at whatever footprint the node
// actually has (design decision, 2026-08-02), and `render/assets/README.md` records
// this so it does not get rebuilt from the UI-SPEC's pre-amendment wording.
//
// ============================================================================
// THREE SCOPING CORRECTIONS TO `58-UI-SPEC.md`'s ASSERTION TABLE (:555-563).
// Each is a correction to a metric's DOMAIN, made because the row as written
// CANNOT GO GREEN ON THE SHIPPED ART. None of them is an exemption in the
// MERGE / BALANCER sense and none may be turned into one. The reasoning for
// each sits in the docblock beside the threshold it scopes, so a later reader
// finds the derivation rather than an unexplained narrowing and "fixes" it back.
//
//   (1) CLASS DISTINCTNESS IS 2x2-SCOPED - see `CLASS_DISTINCT_GROUP`.
//   (2) EDGE ORIENTATION IS STROKED-PARTS-ONLY - see `EDGE_ORIENTATION`.
//   (3) HAMMING IS NORMALISED OVER THE UNION, AND ITS FLOOR IS MEASURED - see
//       `HAMMING_FLOOR`.
//
// AND A FOURTH, FOUND BY MUTATING THE SHIPPED ART RATHER THAN BY READING THE SPEC:
//
//   (4) THE PERIPHERAL-MASS ROW CANNOT FIRE ON ITS OWN STATED FAILURE CASE.
//       Strip BALANCER's four corner returns and it stays green (0.881 -> 0.851
//       against a 0.70 floor). The transcribed row is KEPT - it catches mass
//       migrating to the centre - and a derived CORNER-REACH floor is added
//       beside it for the case it misses. See `BALANCER_CORNER_REACH_AT_LEAST`.
//
// SYMMETRY CLASSIFICATION IS NOT SCOPED. It runs over ALL EIGHT subjects. Only
// the pairwise class-DISTINCTNESS rule is footprint-scoped.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OCCUPANCY_SIZE,
  axisAlignedShare,
  bandRatio,
  classifySymmetry,
  cornerReach,
  hammingDistance,
  occupancyOf,
  parseParts,
  parseViewBox,
  peripheralMassShare,
  symmetry,
  type Occupancy,
} from './glyphOccupancy.ts';

/**
 * `render/assets/`.
 *
 * `import.meta.dirname`, NOT `fileURLToPath(new URL('./', import.meta.url))`:
 * under jsdom the global `URL` resolves a relative base against the DOCUMENT base
 * URI, yielding an `http://localhost:3000/...` href that `fileURLToPath` rejects
 * with `ERR_INVALID_URL_SCHEME`. Same trap, same fix, as `vertexBudget.test.ts`
 * and `geometryDigest.test.ts` (the 56-05 lesson).
 */
const ASSET_DIR = import.meta.dirname;
const FIXTURE_DIR = join(ASSET_DIR, '__fixtures__');

/**
 * The EIGHT shipped machine subjects and their footprint groups, as a STATED
 * TABLE rather than a directory walk.
 *
 * A walk would also pick up `pilot.svg`, which is the calibration fixture and not
 * machine art, and it would silently shrink if a subject were ever deleted - a
 * distinctness gate over seven subjects reports a cleaner green than one over
 * eight. The count is cross-checked against the walk below so the table cannot
 * drift from the directory either.
 */
const SUBJECTS = {
  // 1x1 - `0 0 32 32`
  source: '1x1',
  sink: '1x1',
  endpoint: '1x1',
  // 2x2 - `0 0 64 64`. THE GROUP THE DECISION LIVES IN.
  tee: '2x2',
  balancer: '2x2',
  merge: '2x2',
  // unique footprints
  router: '2x3',
  factory: '3x3',
} as const;

type Subject = keyof typeof SUBJECTS;

const SUBJECT_NAMES = Object.keys(SUBJECTS) as Subject[];

/** Read one shipped subject's authored text. */
const readSubject = (s: Subject): string => readFileSync(join(ASSET_DIR, `${s}.svg`), 'utf8');

/** Every subject's occupancy bitmap, measured once. */
const OCC: Record<Subject, Occupancy> = Object.fromEntries(
  SUBJECT_NAMES.map((s) => [s, occupancyOf(readSubject(s))]),
) as Record<Subject, Occupancy>;

/** Every subject's symmetry scores, measured once. */
const SYM: Record<Subject, { symV: number; symH: number }> = Object.fromEntries(
  SUBJECT_NAMES.map((s) => [s, symmetry(OCC[s])]),
) as Record<Subject, { symV: number; symH: number }>;

/** The `(symV, symH)` CLASS of a subject, as the UI-SPEC's YES/NO pair. */
function classOf(s: Subject): string {
  return `(${classifySymmetry(SYM[s].symV)}, ${classifySymmetry(SYM[s].symH)})`;
}

/** Every unordered subject pair, in table order. */
function allPairs(): [Subject, Subject][] {
  const out: [Subject, Subject][] = [];
  for (let i = 0; i < SUBJECT_NAMES.length; i++) {
    for (let j = i + 1; j < SUBJECT_NAMES.length; j++) out.push([SUBJECT_NAMES[i]!, SUBJECT_NAMES[j]!]);
  }
  return out;
}

/**
 * THE SIX BINDING PAIRS: the pairs that SHARE A FOOTPRINT.
 *
 * All 28 pairs are computed and reported; only these six carry a fail threshold.
 * Footprint is a discriminator BEFORE any glyph work - a 1x1 source and a 3x3
 * factory occupy different numbers of cells on the board and no glyph metric is
 * doing that work - so tuning a threshold against a pair that cannot be confused
 * is how a gate becomes decorative.
 */
function bindingPairs(): [Subject, Subject][] {
  return allPairs().filter(([a, b]) => SUBJECTS[a] === SUBJECTS[b]);
}

/**
 * THE GROUP THE PAIRWISE CLASS-DISTINCTNESS RULE IS SCOPED TO (correction 1).
 *
 * `58-UI-SPEC.md:557` states the rule GROUP-AGNOSTICALLY: "within each footprint
 * group, the `(symV, symH)` class pairs are pairwise distinct". But the spec's OWN
 * 1x1 table at `:214-216` gives `SOURCE` (YES, YES) and `SINK` (YES, YES) - THE
 * SAME CLASS - and its prose two lines down at `:218-220` says so outright:
 * "`SOURCE` and `SINK` share a symmetry class, so their binding discriminator is
 * the edge-orientation histogram ... `ENDPOINT` is separated from both by vertical
 * asymmetry." The assertion row was never scoped to match its own table, and an
 * unscoped version of it fails on the shipped 1x1 art the moment it is written.
 *
 * So the rule is asserted over the 2x2 GROUP. That is where the decision lives
 * and it stays FULLY UNEXEMPTED there: all three classes distinct, no allowlist,
 * no pair skipped -
 *
 *   BALANCER (YES, YES) / MERGE (YES, NO)  - differ on the HORIZONTAL mirror.
 *                                            The named pair.
 *   BALANCER (YES, YES) / TEE   (NO,  YES) - differ on the VERTICAL mirror.
 *                                            The lock's printed adjacent exposure.
 *   MERGE    (YES, NO)  / TEE   (NO,  YES) - differ on both.
 *
 * THE 1x1 GROUP IS COVERED, NOT DROPPED, and by NAMED discriminators rather than
 * by the symmetry class: `SOURCE` against `SINK` by the stroked-only
 * edge-orientation metric (`EDGE_ORIENTATION`), and `ENDPOINT` against both by its
 * vertical asymmetry (`symV` ASYMMETRIC where both others are SYMMETRIC). Both are
 * asserted below, and all three 1x1 pairs additionally carry the Hamming backstop.
 */
const CLASS_DISTINCT_GROUP = '2x2';

/**
 * THE SYMMETRY CLASSIFICATION BANDS, transcribed from `58-UI-SPEC.md:556`.
 *
 * A score between the two is an UNCLASSIFIED FAIL - art that is neither symmetric
 * nor deliberately not symmetric cannot pass by sitting in the middle. This is the
 * one threshold pair in this file that is transcribed rather than derived, and the
 * measured headroom on the shipped eight is recorded in `58-04-SUMMARY.md`.
 */
const SYMMETRIC_AT_LEAST = 0.9;
const ASYMMETRIC_AT_MOST = 0.6;

/** `BALANCER` peripheral-mass floor, TRANSCRIBED from `58-UI-SPEC.md:559`. Measured 0.881. */
const BALANCER_PERIPHERAL_AT_LEAST = 0.7;

/**
 * `BALANCER` CORNER-REACH floor - a FOURTH correction, and the only one that adds
 * a metric rather than scoping one (`glyphOccupancy.ts:cornerReach` carries the
 * derivation).
 *
 * WHY. `58-UI-SPEC.md:559` pairs the peripheral-mass floor with the failure case
 * "a balancer redrawn without its corner returns", and MEASURED IT DOES NOT CATCH
 * IT: stripping the four 6u returns moves peripheral mass 0.881 -> 0.851 against a
 * 0.70 floor. That was found by mutating the shipped `balancer.svg` and watching
 * the gate stay green - the row's stated failure case simply did not fire. A gate
 * whose named failure case cannot fire is decorative, which is the exact thing
 * `58-CONTEXT.md` sends this plan to prevent, so the coverage is ADDED. The
 * transcribed row is kept as well: it catches a DIFFERENT failure (mass migrating
 * to the centre - the k=2 ladder case scores 0.678) and the two are not redundant.
 *
 * THE FLOOR IS DERIVED, NOT TRANSCRIBED - there is no UI-SPEC number for a metric
 * the UI-SPEC does not have:
 *
 *   real BALANCER              1.000   passes with full margin
 *   returns shortened 6u->4u   0.714   still a bracket - PASSES, margin 0.214
 *   returns REMOVED            0.286   CAUGHT, margin 0.214
 *   floor                      0.50    equidistant from the last real variant that
 *                                      should pass and the first that must not
 *
 * And it has a sentence, not just a number: "in each of the four corner boxes the
 * ink must occupy at least half the box on BOTH axes" - i.e. the corner is
 * genuinely turned, not merely grazed by a passing rail.
 */
const BALANCER_CORNER_REACH_AT_LEAST = 0.5;
/** `MERGE` top-heaviness floor (`58-UI-SPEC.md:560`). */
const MERGE_TOP_HEAVY_AT_LEAST = 1.8;
/** `TEE` east-heaviness floor (`58-UI-SPEC.md:561`). */
const TEE_EAST_HEAVY_AT_LEAST = 1.4;

/**
 * THE EDGE-ORIENTATION THRESHOLDS, AND THE DOMAIN THEY ARE COMPUTED OVER
 * (correction 2).
 *
 * `58-UI-SPEC.md:562` reads "axis-aligned share of GLYPH path length: SOURCE
 * <= 0.10, SINK >= 0.90" and does not say which parts count. THE CHOICE DECIDES
 * THE ASSERTION. `SOURCE`'s glyph is TWO parts, not one:
 *
 *   `eye`   `M 10 16 L 16 10 L 22 16 L 16 22 Z`  four diagonal edges, 33.94u, STROKED
 *   `pupil` `M 14 14 H 18 V 18 H 14 Z`           16u, ALL axis-aligned, a FILL
 *
 * Over BOTH parts the axis-aligned share is 16 / 49.94 = 0.32 - over the 0.10
 * ceiling by more than 3x. The threshold silently assumed the glyph was the lens
 * alone. Excluding fills, `SOURCE` measures 0.00 and `SINK` 1.00 (`ring`, 48u, all
 * axis-aligned), both at full margin, and the metric then measures exactly what the
 * UI-SPEC says it measures: the OUTER-EDGE ORIENTATION of the lens against the ring
 * (`:214-215`, `:240`, `:251`). A FILL CONTRIBUTES COVERAGE, NOT EDGE ORIENTATION -
 * its outline is an interior boundary, not the silhouette a reader traces.
 *
 * Strokedness is read off the part's AUTHORED ATTRIBUTES (`fill="none" stroke=...`
 * is stroked; a fill part is not), and the gate REPORTS the excluded parts by
 * `data-part` name beside the figure, so the exclusion is visible in the gate's
 * output and not only in its source.
 *
 * THIS IS THE 1x1 GROUP'S BINDING DISCRIMINATOR, not a decoration: `SOURCE` and
 * `SINK` share a symmetry class, so correction 1 leans on exactly this metric to
 * keep that group covered.
 */
const EDGE_ORIENTATION = {
  source: { atMost: 0.1 },
  sink: { atLeast: 0.9 },
} as const;

/**
 * THE OCCUPANCY BACKSTOP'S FLOOR - MEASURED, NOT TRANSCRIBED (correction 3).
 *
 * `58-UI-SPEC.md:563` says "normalised Hamming distance >= 0.35" and NEVER SAYS
 * NORMALISED OVER WHAT, and the choice decides the whole assertion. Over the
 * 64 x 64 bitmap (4096 cells) `SOURCE`'s total ink is about 336 cells, so no two
 * glyphs can differ by more than about 0.16 and ALL SIX binding pairs fail -
 * including pairs the named metrics separate cleanly. The denominator used here is
 * the UNION OF THE TWO INK SETS:
 *
 *     distance = |A xor B| / |A or B|          ( = 1 - Jaccard )
 *
 * 0 for identical ink, 1 for disjoint ink, and the only denominator under which the
 * number means "how much of the drawn ink disagrees".
 *
 * AND THE 0.35 IS NOT CARRIED FORWARD. The six binding pairs were measured first,
 * printed, and the floor set with a stated margin below the WORST REAL PAIR. A
 * threshold nobody measured is exactly the "green gate that was not checking"
 * failure this milestone keeps finding; a floor set far below the real data is
 * decorative in the other direction.
 *
 *   worst real binding pair : 0.6348   (sink / endpoint - a square ring against a
 *                                       socket that is three of the same four sides)
 *   margin below it         : 0.1348   (21.2% of the worst pair)
 *   floor                   : 0.50
 *
 * AND 0.50 IS NOT AN ARBITRARY 21%: it is the JACCARD-0.5 POINT, so the floor has a
 * sentence rather than a number behind it - "two subjects fail the backstop when
 * they share MORE THAN HALF of their combined ink". A threshold that can be stated
 * in words is one a later reader can argue with instead of quietly re-tuning.
 *
 * WHAT IT CATCHES, MEASURED on a plagiarism ladder (a BALANCER that takes k of
 * MERGE's four parts and keeps its own remainder; recorded in `58-04-SUMMARY.md`
 * and re-run below):
 *
 *   k=0  real balancer   d(merge) 0.9343   passes - correct
 *   k=1  one part taken   d(merge) 0.7135   PASSES the backstop; caught by the CLASS
 *                                           rule instead, because it takes MERGE's
 *                                           (SYMMETRIC, ASYMMETRIC) class
 *   k=2  half taken       d(merge) 0.3960   CAUGHT here (and by peripheral mass,
 *                                           0.678 < 0.70; its class is a fourth
 *                                           class, so the class rule does NOT catch
 *                                           it - which is what a backstop is for)
 *   k=3                   d(merge) 0.1101   caught
 *   k=4  the fixture      d(merge) 0.0000   caught by all three
 *
 * That ladder is the honest statement of this gate's reach: the backstop catches
 * HALF-plagiarism and up, the named metrics catch the quarter case, and k=2 is the
 * case only the backstop catches. Neither layer is redundant and neither is
 * sufficient.
 *
 * CROSS-CHECK, asserted below: `__fixtures__/balancer-collapsed.svg` carries
 * MERGE's funnel verbatim, so its BALANCER / MERGE distance is EXACTLY 0.0 and it
 * must land below this floor. If it did not, the floor would be the thing that is
 * wrong.
 */
const HAMMING_FLOOR = 0.5;

/** Collected report lines, printed once. */
const REPORT: string[] = [];
const report = (line: string): void => void REPORT.push(line);

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

describe('the shape gate reports what it measured, over all 28 pairs', () => {
  it('the subject table matches the directory, so neither can drift', () => {
    // The stated table is the iteration subject everywhere else in this file; this
    // is the one case that ties it to the flat production walk. `pilot.svg` is the
    // calibration fixture, not machine art, and is the only expected difference.
    const walked = readdirSync(ASSET_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.svg'))
      .map((e) => e.name.replace(/\.svg$/, ''))
      .sort();
    expect(walked).toEqual([...SUBJECT_NAMES, 'pilot'].sort());
    expect(SUBJECT_NAMES).toHaveLength(8);
  });

  it('prints the symmetry table, the named metrics and all 28 pair distances', () => {
    report('');
    report('=== ART-03 / SHAPE. Symmetry, over ALL EIGHT subjects ===');
    report('  subject    fp    symV   symH   class');
    for (const s of SUBJECT_NAMES) {
      report(
        `  ${s.padEnd(10)} ${SUBJECTS[s].padEnd(5)} ${SYM[s].symV.toFixed(3)}  ${SYM[s].symH.toFixed(3)}  ${classOf(s)}`,
      );
    }

    report('');
    report('=== Named discriminators ===');
    report(
      `  BALANCER peripheral mass   ${peripheralMassShare(OCC.balancer).toFixed(3)} ` +
        `(floor ${BALANCER_PERIPHERAL_AT_LEAST}, transcribed)`,
    );
    report(
      `  BALANCER corner reach      ${cornerReach(OCC.balancer).toFixed(3)} ` +
        `(floor ${BALANCER_CORNER_REACH_AT_LEAST}, derived - correction 4)`,
    );
    report(
      `  MERGE top/bottom third     ${bandRatio(OCC.merge, 'top-third').toFixed(3)} ` +
        `(floor ${MERGE_TOP_HEAVY_AT_LEAST})`,
    );
    report(
      `  TEE east/west half         ${bandRatio(OCC.tee, 'east-half').toFixed(3)} ` +
        `(floor ${TEE_EAST_HEAVY_AT_LEAST})`,
    );
    for (const s of ['source', 'sink'] as const) {
      const r = axisAlignedShare(parseParts(readSubject(s)));
      report(
        `  ${s.toUpperCase().padEnd(8)} axis-aligned share  ${r.share.toFixed(3)} ` +
          `over ${r.strokedLength.toFixed(2)}u of STROKED path; ` +
          `excluded fills: ${r.excluded.length > 0 ? r.excluded.join(', ') : 'none'}`,
      );
    }

    report('');
    report('=== Normalised Hamming, |A xor B| / |A or B|, ALL 28 PAIRS ===');
    report(`    (* = one of the SIX binding pairs, which carry the ${HAMMING_FLOOR} floor)`);
    const binding = new Set(bindingPairs().map(([a, b]) => `${a}/${b}`));
    const rows = allPairs()
      .map(([a, b]) => ({
        name: `${a}/${b}`,
        // BOTH footprints, not just the first subject's - the first draft printed
        // one and read as a claim about the pair, so `sink/balancer` was labelled
        // `1x1` when balancer is 2x2. The label is what tells a reader why a pair
        // is or is not binding, so it has to name both sides.
        fp: `${SUBJECTS[a]}/${SUBJECTS[b]}`,
        d: hammingDistance(OCC[a], OCC[b]),
        bind: binding.has(`${a}/${b}`),
      }))
      .sort((x, y) => x.d - y.d);
    for (const r of rows) {
      report(`  ${r.bind ? '*' : ' '} ${r.name.padEnd(22)} ${r.d.toFixed(4)}   ${r.fp}`);
    }
    report('');
    report(`  ink cells per subject (of ${OCCUPANCY_SIZE * OCCUPANCY_SIZE}):`);
    report(`    ${SUBJECT_NAMES.map((s) => `${s}=${OCC[s].ink}`).join('  ')}`);

    // eslint-disable-next-line no-console
    console.log(REPORT.join('\n'));
    expect(rows).toHaveLength(28);
    expect(binding.size).toBe(6);
  });
});

/* ------------------------------------------------------------------ *
 * Symmetry classification - ALL EIGHT subjects, both axes
 * ------------------------------------------------------------------ */

describe('every shipped subject classifies cleanly on BOTH mirror axes', () => {
  it('no subject sits in the unclassified band on either axis', () => {
    for (const s of SUBJECT_NAMES) {
      for (const axis of ['symV', 'symH'] as const) {
        const score = SYM[s][axis];
        expect(
          classifySymmetry(score),
          `${s} ${axis} = ${score.toFixed(3)} is UNCLASSIFIED: neither symmetric ` +
            `(>= ${SYMMETRIC_AT_LEAST}) nor deliberately asymmetric (<= ${ASYMMETRIC_AT_MOST}). ` +
            'Art that is neither cannot pass by sitting in the middle.',
        ).not.toBe('UNCLASSIFIED');
      }
    }
  });

  it('the classifier itself has all three outcomes, at the stated boundaries', () => {
    // The discriminator. Without it the case above would pass on a classifier that
    // never returns UNCLASSIFIED - which is exactly what a no-op stub does.
    expect(classifySymmetry(1)).toBe('SYMMETRIC');
    expect(classifySymmetry(SYMMETRIC_AT_LEAST)).toBe('SYMMETRIC');
    expect(classifySymmetry(0)).toBe('ASYMMETRIC');
    expect(classifySymmetry(ASYMMETRIC_AT_MOST)).toBe('ASYMMETRIC');
    expect(classifySymmetry(0.75)).toBe('UNCLASSIFIED');
    expect(classifySymmetry(SYMMETRIC_AT_LEAST - 0.001)).toBe('UNCLASSIFIED');
    expect(classifySymmetry(ASYMMETRIC_AT_MOST + 0.001)).toBe('UNCLASSIFIED');
  });

  it('matches the UI-SPEC class table, subject by subject', () => {
    // Transcribed from `58-UI-SPEC.md:202-206` (2x2) and `:214-216` (1x1). This is
    // what makes a silent re-arting visible: a glyph that quietly lost an axis of
    // symmetry still classifies cleanly and would pass the case above.
    const EXPECTED: Record<Subject, [string, string]> = {
      source: ['SYMMETRIC', 'SYMMETRIC'],
      sink: ['SYMMETRIC', 'SYMMETRIC'],
      endpoint: ['ASYMMETRIC', 'SYMMETRIC'],
      tee: ['ASYMMETRIC', 'SYMMETRIC'],
      balancer: ['SYMMETRIC', 'SYMMETRIC'],
      merge: ['SYMMETRIC', 'ASYMMETRIC'],
      router: ['SYMMETRIC', 'SYMMETRIC'],
      factory: ['SYMMETRIC', 'SYMMETRIC'],
    };
    for (const s of SUBJECT_NAMES) {
      expect([classifySymmetry(SYM[s].symV), classifySymmetry(SYM[s].symH)], `${s} class`).toEqual(EXPECTED[s]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Correction 1: class distinctness, scoped to the 2x2 group
 * ------------------------------------------------------------------ */

describe(`class distinctness within the ${CLASS_DISTINCT_GROUP} group - the design decision, unexempted`, () => {
  it('BALANCER, MERGE and TEE hold three PAIRWISE DISTINCT symmetry classes', () => {
    const group = SUBJECT_NAMES.filter((s) => SUBJECTS[s] === CLASS_DISTINCT_GROUP);
    expect(group.sort()).toEqual(['balancer', 'merge', 'tee']);
    const seen = new Map<string, Subject>();
    for (const s of group) {
      const c = classOf(s);
      const clash = seen.get(c);
      expect(
        clash,
        `${s} and ${clash} both classify ${c}. Under Direction A these share the SAME ` +
          '4u-inset chassis, so the glyph is the only separator and the symmetry class ' +
          'is how it is gated. No exemption and no allowlist entry (58-CONTEXT.md).',
      ).toBeUndefined();
      seen.set(c, s);
    }
    expect(seen.size).toBe(3);
  });

  it('names the 1x1 group\'s two discriminators, so that group is visibly covered', () => {
    // Correction 1 narrows the CLASS rule to the 2x2 group. This case is what stops
    // that narrowing from silently dropping the 1x1 group: both replacements are
    // asserted here, in the same describe a reader lands in when they ask "what
    // covers source vs sink?".
    //
    // (a) SOURCE vs SINK - the edge-orientation metric, asserted in full below.
    const src = axisAlignedShare(parseParts(readSubject('source')));
    const snk = axisAlignedShare(parseParts(readSubject('sink')));
    expect(src.share).toBeLessThan(snk.share);
    // (b) ENDPOINT vs both - vertical asymmetry where the other two are symmetric.
    expect(classifySymmetry(SYM.endpoint.symV)).toBe('ASYMMETRIC');
    expect(classifySymmetry(SYM.source.symV)).toBe('SYMMETRIC');
    expect(classifySymmetry(SYM.sink.symV)).toBe('SYMMETRIC');
  });
});

/* ------------------------------------------------------------------ *
 * The named mass discriminators
 * ------------------------------------------------------------------ */

describe('the named mass discriminators (58-UI-SPEC.md:559-561)', () => {
  it('BALANCER puts its mass at the PERIPHERY - a balancer without corner returns fails', () => {
    const share = peripheralMassShare(OCC.balancer);
    expect(
      share,
      `BALANCER peripheral mass ${share.toFixed(3)} < ${BALANCER_PERIPHERAL_AT_LEAST}. ` +
        'The design call was "mass at the four corners, symmetric about BOTH axes"; this is that ' +
        'sentence as a number.',
    ).toBeGreaterThanOrEqual(BALANCER_PERIPHERAL_AT_LEAST);
  });

  it('BALANCER TURNS all four corners - stripping the returns fails (correction 4)', () => {
    // The coverage the transcribed peripheral-mass row claims and does not deliver.
    // Both assertions ship: this one catches a lost return, that one catches mass
    // migrating to the centre. See BALANCER_CORNER_REACH_AT_LEAST for the ladder.
    const reach = cornerReach(OCC.balancer);
    expect(
      reach,
      `BALANCER corner reach ${reach.toFixed(3)} < ${BALANCER_CORNER_REACH_AT_LEAST}: at least one of ` +
        'the four corner boxes is only grazed, not turned. "Mass at the four corners" ' +
        '(design decision, 2026-08-01) is a claim about all four.',
    ).toBeGreaterThanOrEqual(BALANCER_CORNER_REACH_AT_LEAST);

    // Executed, so the ladder in the docblock is a measurement and not a memory: a
    // balancer whose rails are plain bars scores far below the floor, and one whose
    // returns are merely shortened still clears it.
    const bar = (railTop: string, railBottom: string): number =>
      cornerReach(
        occupancyOf(
          '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">\n' +
            `<path data-part="rail-top" d="${railTop}" fill="none" stroke="#b0bacb" stroke-width="2" />\n` +
            `<path data-part="rail-bottom" d="${railBottom}" fill="none" stroke="#b0bacb" stroke-width="2" />\n` +
            '<path data-part="spine" d="M 32 20 V 44" fill="none" stroke="#b0bacb" stroke-width="2" />\n</svg>\n',
        ),
      );
    const stripped = bar('M 14 20 H 50', 'M 14 44 H 50');
    const shortened = bar('M 14 24 V 20 H 50 V 24', 'M 14 40 V 44 H 50 V 40');
    expect(stripped, 'returns REMOVED must be caught').toBeLessThan(BALANCER_CORNER_REACH_AT_LEAST);
    expect(shortened, 'returns merely SHORTENED must still pass').toBeGreaterThanOrEqual(
      BALANCER_CORNER_REACH_AT_LEAST,
    );
    // ... and the reason the extra metric was needed at all: the transcribed
    // peripheral-mass row stays green on the stripped balancer.
    const strippedOcc = occupancyOf(
      '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">\n' +
        '<path data-part="rail-top" d="M 14 20 H 50" fill="none" stroke="#b0bacb" stroke-width="2" />\n' +
        '<path data-part="rail-bottom" d="M 14 44 H 50" fill="none" stroke="#b0bacb" stroke-width="2" />\n' +
        '<path data-part="spine" d="M 32 20 V 44" fill="none" stroke="#b0bacb" stroke-width="2" />\n</svg>\n',
    );
    expect(peripheralMassShare(strippedOcc)).toBeGreaterThanOrEqual(BALANCER_PERIPHERAL_AT_LEAST);
  });

  it('MERGE is TOP-HEAVY - a funnel drawn politely fails', () => {
    const r = bandRatio(OCC.merge, 'top-third');
    expect(r, `MERGE top/bottom third ratio ${r.toFixed(3)} < ${MERGE_TOP_HEAVY_AT_LEAST}`).toBeGreaterThanOrEqual(
      MERGE_TOP_HEAVY_AT_LEAST,
    );

    // WHERE THE TRANSCRIBED 1.8 ACTUALLY BITES, executed rather than assumed. The
    // real funnel measures 5.667 - a 3.1x headroom that reads loose until you see
    // what it takes to spend it. The floor lands exactly where a funnel stops being
    // one: a mouth of ~8u against a 2u neck.
    const funnel = (mx0: number, mx1: number, apex: number, neckEnd: number): number =>
      bandRatio(
        occupancyOf(
          '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">\n' +
            `<path data-part="mouth" d="M ${mx0} 16 H ${mx1}" fill="none" stroke="#b0bacb" stroke-width="2" />\n` +
            `<path data-part="wall-left" d="M ${mx0} 16 L 32 ${apex}" fill="none" stroke="#b0bacb" stroke-width="2" />\n` +
            `<path data-part="wall-right" d="M ${mx1} 16 L 32 ${apex}" fill="none" stroke="#b0bacb" stroke-width="2" />\n` +
            `<path data-part="neck" d="M 32 ${apex} V ${neckEnd}" fill="none" stroke="#b0bacb" stroke-width="2" />\n</svg>\n`,
        ),
        'top-third',
      );
    expect(funnel(26, 38, 22, 56), 'a 12u mouth still reads as a funnel').toBeGreaterThanOrEqual(
      MERGE_TOP_HEAVY_AT_LEAST,
    );
    expect(funnel(30, 34, 18, 60), 'a 4u mouth against a 2u neck is not a funnel').toBeLessThan(
      MERGE_TOP_HEAVY_AT_LEAST,
    );
  });

  it('TEE is EAST-HEAVY - a fork that stopped diverging fails', () => {
    const r = bandRatio(OCC.tee, 'east-half');
    expect(r, `TEE east/west half ratio ${r.toFixed(3)} < ${TEE_EAST_HEAVY_AT_LEAST}`).toBeGreaterThanOrEqual(
      TEE_EAST_HEAVY_AT_LEAST,
    );
  });

  it('the mass metrics are not trivially large: a symmetric subject scores near 1', () => {
    // The discriminator for the two RATIO metrics. `factory` is symmetric on both
    // axes, so both ratios must sit near 1 - a metric that returned a big number
    // for anything would fail here and the two cases above would be vacuous.
    expect(bandRatio(OCC.factory, 'top-third')).toBeCloseTo(1, 1);
    expect(bandRatio(OCC.factory, 'east-half')).toBeCloseTo(1, 1);
    // ... and for the peripheral-mass metric, a subject whose ink runs through the
    // middle scores far below BALANCER's floor.
    expect(peripheralMassShare(OCC.merge)).toBeLessThan(BALANCER_PERIPHERAL_AT_LEAST);
  });
});

/* ------------------------------------------------------------------ *
 * Correction 2: edge orientation, stroked parts only
 * ------------------------------------------------------------------ */

describe('edge orientation, over STROKED parts only (correction 2)', () => {
  it('SOURCE\'s lens is all-diagonal and SINK\'s ring is all-axis-aligned', () => {
    const src = axisAlignedShare(parseParts(readSubject('source')));
    const snk = axisAlignedShare(parseParts(readSubject('sink')));
    expect(
      src.share,
      `SOURCE axis-aligned share ${src.share.toFixed(3)} > ${EDGE_ORIENTATION.source.atMost} ` +
        `(over ${src.strokedLength.toFixed(2)}u of stroked path; excluded fills: ${src.excluded.join(', ')})`,
    ).toBeLessThanOrEqual(EDGE_ORIENTATION.source.atMost);
    expect(
      snk.share,
      `SINK axis-aligned share ${snk.share.toFixed(3)} < ${EDGE_ORIENTATION.sink.atLeast} ` +
        `(over ${snk.strokedLength.toFixed(2)}u of stroked path; excluded fills: ${snk.excluded.join(', ')})`,
    ).toBeGreaterThanOrEqual(EDGE_ORIENTATION.sink.atLeast);
  });

  it('REPORTS the excluded fill parts by data-part name', () => {
    // The exclusion must be visible in the gate's OUTPUT, not only in its source.
    // A reader looking at a failure has to be able to see which parts were dropped
    // without opening this file.
    expect(axisAlignedShare(parseParts(readSubject('source'))).excluded).toEqual(['pupil']);
    expect(axisAlignedShare(parseParts(readSubject('sink'))).excluded).toEqual(['core']);
  });

  it('and the scoping is LOAD-BEARING: over all parts, SOURCE fails its own ceiling', () => {
    // The correction, executed. Including the `pupil` fill puts SOURCE at
    // 16 / 49.94 = 0.32, over the 0.10 ceiling by more than 3x. This case is why
    // the stroked-only domain is part of the metric and not an afterthought - and
    // it is also what stops someone "simplifying" the exclusion away.
    const all = parseParts(readSubject('source')).map((p) => ({ ...p, stroked: true }));
    const naive = axisAlignedShare(all);
    expect(naive.share).toBeGreaterThan(EDGE_ORIENTATION.source.atMost);
    expect(naive.share).toBeCloseTo(16 / (16 + 4 * Math.sqrt(72)), 3);
    expect(naive.excluded).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Correction 3: the Hamming backstop
 * ------------------------------------------------------------------ */

describe('the occupancy backstop, normalised over the UNION of the ink sets (correction 3)', () => {
  it('every one of the SIX binding pairs clears the measured floor', () => {
    const pairs = bindingPairs();
    expect(pairs).toHaveLength(6);
    for (const [a, b] of pairs) {
      const d = hammingDistance(OCC[a], OCC[b]);
      expect(
        d,
        `${a}/${b} (both ${SUBJECTS[a]}) normalised Hamming ${d.toFixed(4)} < ${HAMMING_FLOOR}. ` +
          'These two share a footprint, so the glyph is the only separator.',
      ).toBeGreaterThanOrEqual(HAMMING_FLOOR);
    }
  });

  it('the denominator is the UNION, not the bitmap - identical ink scores 0, disjoint scores 1', () => {
    // The property that makes the number mean "how much of the drawn ink
    // disagrees". Over the 4096-cell bitmap instead, SOURCE's ~336 ink cells would
    // cap every distance near 0.16 and all six binding pairs would fail.
    for (const s of SUBJECT_NAMES) expect(hammingDistance(OCC[s], OCC[s]), `${s} vs itself`).toBe(0);
    const size = OCCUPANCY_SIZE;
    const left: Occupancy = { grid: new Uint8Array(size * size), size, ink: 1 };
    const right: Occupancy = { grid: new Uint8Array(size * size), size, ink: 1 };
    left.grid[0] = 1;
    right.grid[1] = 1;
    expect(hammingDistance(left, right)).toBe(1);
  });

  it('the floor sits below the worst REAL binding pair, with the margin recorded', () => {
    // The derivation, executed. A floor above the real data would be a permanently
    // red gate; a floor far below it would be decorative. Both failure modes are
    // caught by asserting the relationship rather than the number.
    const worst = Math.min(...bindingPairs().map(([a, b]) => hammingDistance(OCC[a], OCC[b])));
    expect(worst).toBeCloseTo(0.6348, 3); // sink / endpoint, the measured worst pair
    expect(HAMMING_FLOOR).toBeLessThan(worst);
    expect(worst - HAMMING_FLOOR).toBeCloseTo(0.1348, 3); // the recorded margin
    expect(HAMMING_FLOOR).toBeGreaterThan(0);
    // ... and the floor's SENTENCE: 0.50 is the Jaccard-0.5 point, so failing the
    // backstop means "these two share more than half their combined ink".
    expect(HAMMING_FLOOR).toBe(0.5);
  });

  it('the PLAGIARISM LADDER: the floor catches half-copying, and the class rule catches a quarter', () => {
    // The floor's reach, executed rather than asserted in prose. A BALANCER that
    // takes k of MERGE's four parts and keeps its own remainder. This is what stops
    // the floor from being re-tuned on a hunch: move it and this case says exactly
    // what stopped being caught.
    const bodyPaths = (svg: string): string[] => svg.slice(svg.indexOf('<svg')).match(/<path\b[^>]*\/>/g) ?? [];
    const wrap = (ps: string[]): string =>
      `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">\n${ps.join('\n')}\n</svg>\n`;
    const mergeParts = bodyPaths(readSubject('merge'));
    const balancerParts = bodyPaths(readSubject('balancer'));
    expect(mergeParts).toHaveLength(4);
    expect(balancerParts).toHaveLength(3);

    const at = (k: number): Occupancy =>
      occupancyOf(wrap([...mergeParts.slice(0, k), ...balancerParts.slice(Math.min(k, balancerParts.length))]));

    // k=1: one part copied. ABOVE the floor - the backstop does NOT catch it...
    const k1 = at(1);
    expect(hammingDistance(k1, OCC.merge)).toBeGreaterThan(HAMMING_FLOOR);
    // ... and the CLASS rule does, because it has taken MERGE's class.
    expect(`(${classifySymmetry(symmetry(k1).symV)}, ${classifySymmetry(symmetry(k1).symH)})`).toBe(classOf('merge'));

    // k=2: half copied. BELOW the floor - and this is the case ONLY the backstop
    // catches, because (ASYMMETRIC, ASYMMETRIC) is a fourth class that the 2x2
    // class rule is perfectly happy with.
    const k2 = at(2);
    expect(hammingDistance(k2, OCC.merge)).toBeLessThan(HAMMING_FLOOR);
    expect(`(${classifySymmetry(symmetry(k2).symV)}, ${classifySymmetry(symmetry(k2).symH)})`).not.toBe(
      classOf('merge'),
    );
    expect(peripheralMassShare(k2)).toBeLessThan(BALANCER_PERIPHERAL_AT_LEAST);

    // k=3: below the floor and getting closer to the fixture.
    expect(hammingDistance(at(3), OCC.merge)).toBeLessThan(HAMMING_FLOOR);
  });
});

/* ------------------------------------------------------------------ *
 * THE FIXTURE. The gate has been SHOWN to fail.
 * ------------------------------------------------------------------ */

describe('__fixtures__/balancer-collapsed.svg - the gate FAILS on it, three ways', () => {
  const collapsed = occupancyOf(readFileSync(join(FIXTURE_DIR, 'balancer-collapsed.svg'), 'utf8'));

  it('is committed, and lives outside the non-recursive production walk', () => {
    // If it ever landed flat in `render/assets/` it would become a shipped asset:
    // linted, digested, budgeted and drawn. The placement is the contract.
    const walked = readdirSync(ASSET_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.svg'))
      .map((e) => e.name);
    expect(walked).not.toContain('balancer-collapsed.svg');
    expect(readdirSync(FIXTURE_DIR)).toContain('balancer-collapsed.svg');
  });

  it('FAILURE 1 - it takes MERGE\'s symmetry class, breaking 2x2 class distinctness', () => {
    const c = symmetry(collapsed);
    const collapsedClass = `(${classifySymmetry(c.symV)}, ${classifySymmetry(c.symH)})`;
    expect(collapsedClass).toBe(classOf('merge'));
    expect(
      collapsedClass,
      'the collapsed balancer no longer differs from MERGE on the horizontal mirror',
    ).not.toBe(classOf('balancer'));
  });

  it('FAILURE 2 - its mass is not at the periphery', () => {
    const share = peripheralMassShare(collapsed);
    expect(share, `collapsed balancer peripheral mass ${share.toFixed(3)}`).toBeLessThan(
      BALANCER_PERIPHERAL_AT_LEAST,
    );
  });

  it('FAILURE 3 - its Hamming distance from MERGE is EXACTLY 0.0, below the floor', () => {
    // The cross-check on the floor's derivation. The fixture carries MERGE's paths
    // verbatim, so the symmetric difference of the two ink sets is empty. If this
    // ever landed at or above the floor, the floor would be the thing that is wrong.
    const d = hammingDistance(collapsed, OCC.merge);
    expect(d, 'the fixture no longer carries MERGE\'s funnel verbatim').toBe(0);
    expect(d).toBeLessThan(HAMMING_FLOOR);
  });

  it('and the REAL balancer passes all three, so the failures are the fixture\'s', () => {
    // Without this the three cases above would also pass if the metrics were simply
    // broken for every subject.
    expect(classOf('balancer')).not.toBe(classOf('merge'));
    expect(peripheralMassShare(OCC.balancer)).toBeGreaterThanOrEqual(BALANCER_PERIPHERAL_AT_LEAST);
    expect(hammingDistance(OCC.balancer, OCC.merge)).toBeGreaterThanOrEqual(HAMMING_FLOOR);
  });
});

/* ------------------------------------------------------------------ *
 * WR-02: the viewBox comes from the DRAWN root tag, never from a comment
 * ------------------------------------------------------------------ */

describe('parseViewBox reads the DRAWN viewBox, not one quoted in a header comment', () => {
  // The negative case the shipping code lacked. `shippedAssets.test.ts` already has a
  // case with this name over its OWN comment-stripping helper; the defect (58 review
  // WR-02) was that the helper was comment-safe while `parseViewBox` and
  // `svgAssets.getAssetBox` scanned the raw text, so the GATE was stronger than the
  // code it was supposed to be guarding. `router.svg`'s real header quotes the
  // transposed `0 0 96 64` box in order to say it is illegal, which makes this the
  // exact shape of a live footgun rather than a hypothetical one.
  it('a header that quotes a DIFFERENT box does not win', () => {
    const svg =
      '<!-- The transposed box `viewBox="0 0 96 64"` is ILLEGAL for this subject. -->\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 96"><path d="M 0 0 L 8 0"/></svg>';
    expect(parseViewBox(svg)).toEqual({ w: 64, h: 96 });
  });

  it('every shipped asset agrees with itself once the header is stripped', () => {
    // The property over the REAL artwork, so a future header edit that quotes a box
    // reddens here rather than silently mis-centring that subject on the board.
    for (const name of readdirSync(join(import.meta.dirname), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.svg'))
      .map((e) => e.name)) {
      const text = readFileSync(join(import.meta.dirname, name), 'utf8');
      const body = text.slice(text.indexOf('<svg'));
      expect(parseViewBox(text), `${name}: parseViewBox read a box from the header`).toEqual(
        parseViewBox(body),
      );
    }
  });
});
