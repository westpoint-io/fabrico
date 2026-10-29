// The SOURCE gate over the lane-width strip (review CR-02 and WR-09, plan 57-11).
//
// Default node environment, and NO import of the module under test. `artBoardLanes.ts`
// pulls in `pixi.js` and reaches `artBoard.ts` through a deliberate import cycle whose
// bindings are only safe to read inside a function body, so importing it here would buy
// a DOM environment and a TDZ hazard for a check that only needs the text.
//
// WHY THIS FILE EXISTS. Two claims in the tree asserted a gate that was not committed:
//
//   1. `artBoardLanes.ts`'s header said every number on the strip is computed and every
//      point comes from `artBoardGeometry.ts`. That was true of the printed TEXT and
//      false of the DRAWING - the module carried a duplicate `polar()`, an inline copy
//      of the arc-length-to-angle mapping and a second tread loop (review CR-02).
//   2. `art-board.spec.ts`'s lane block said "it is the source grep that catches" a
//      hardcoded dash figure, "recorded in 57-08-SUMMARY.md's mutation table rather than
//      papered over with a weaker assertion here". No such source grep was in the tree:
//      `artBoardGeometry.test.ts` scans `artBoardGeometry.ts` only, and no spec anywhere
//      read `artBoardLanes.ts` (review WR-09). A literal `'3.750'` substituted into
//      `renderNumbersCell` went green in CI, because the e2e reads the rendered text
//      either way.
//
// COMMENTS ARE STRIPPED BEFORE SCANNING, for the reason `check-board-structure.sh`
// records about its own corpus: this file's subject matter is a list of forbidden
// constructs and so are the module's docblocks, which name `polar()`, the four dash
// figures and `Math.cos` in prose in order to record that they are gone. A check that
// counted prose would be permanently red and would get "fixed" by weakening it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The SHIPPED radius, imported (W-4, see the block at the foot of this file). Importing
// it HERE is not the thing the no-import rule below forbids: that rule is about what
// `artBoardLanes.ts` may read, and `shared/geometry.ts` is pure and dependency-free, so
// a spec can hold the two declarations against each other without coupling the board.
import { ELBOW_R } from '../../shared/geometry.ts';

const LANES_PATH = new URL('./artBoardLanes.ts', import.meta.url);
const RAW = readFileSync(LANES_PATH, 'utf8');

/**
 * The module's source with comment lines removed, LINE COUNT PRESERVED so a hit is
 * still a locator. Line-oriented rather than a block parser: every comment in this
 * module is either a `//` line or a `/** ... *` block whose continuation lines start
 * with `*`, which is the whole of the house style.
 */
const CODE = RAW.split('\n')
  .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? '' : line))
  .join('\n');

describe('artBoardLanes source gate - the corpus is real', () => {
  it('reads a non-empty module with code left after the comment strip', () => {
    // THE NON-VACUITY HALF. Every assertion below is a `not.toMatch`, and a `not`
    // assertion over an empty string is the cleanest green in the suite. A rename or a
    // comment-strip bug has to fail here rather than silence the whole file.
    expect(RAW.length).toBeGreaterThan(10_000);
    expect(CODE.split('\n').filter((l) => l.trim() !== '').length).toBeGreaterThan(200);
    expect(CODE).toContain('export function buildLaneStrip');
  });
});

describe('artBoardLanes prints no typed figure - every number is computed (WR-09)', () => {
  it('carries none of the four published dash figures as a source literal', () => {
    // The four inner-rail dashes (3.750 / 2.500 / 1.875 / 1.250) and the lane-20 outer
    // dash (16.250). A typed literal would survive mutation M1 (BOARD_ELBOW_R 16 -> 15)
    // and the strip would stop being a derivation without anything reddening - the e2e
    // reads the same rendered text either way, which is exactly why this has to be a
    // SOURCE assertion.
    //
    // `2\.5` and not `2\.50`: the natural hardcode is `2.5`, which only becomes `2.500`
    // after `formatDash`'s `toFixed(3)`. `2\.5` still matches `2.500` (WR-10).
    expect(CODE).not.toMatch(/3\.75|2\.5|1\.875|1\.25|16\.25/);
  });

  it('routes every printed figure through the geometry module', () => {
    // The positive form: the numbers cell reads `laneFigures`, and the caption reads
    // `correctedCorner`. Neither is a literal table.
    expect(CODE).toMatch(/laneFigures\(/);
    expect(CODE).toMatch(/correctedCorner\(/);
    expect(CODE).toMatch(/formatDash\(/);
  });
});

describe('artBoardLanes draws through ONE parameterisation (CR-02)', () => {
  it('contains no trigonometry - every point comes from artBoardGeometry.ts', () => {
    // THE STRONGEST FORM OF THE CHECK, and the reason it is phrased over `Math.cos` /
    // `Math.sin` rather than over the name `polar`: a duplicate polar primitive can be
    // called anything, but it cannot be written without trigonometry. All of it lives in
    // `cornerPointAtAngle`, which this module calls.
    expect(CODE).not.toMatch(/Math\.(cos|sin|tan|atan2?|hypot)\s*\(/);
  });

  it('re-derives the arc-length-to-angle mapping nowhere', () => {
    // The inline expression this replaced was
    // `corner.startAngle - Math.max(s0, 0) / corner.rCentre`. Dividing an arc length by
    // either name for the radius is that mapping, wherever it is written.
    expect(CODE).not.toMatch(/\/\s*(corner\.)?rCentre/);
    expect(CODE).not.toMatch(/\/\s*BOARD_ELBOW_R/);
    expect(CODE).not.toMatch(/startAngle\s*-/);
  });

  it('rebuilds the tread schedule nowhere - it calls the one in the geometry module', () => {
    // `beltRun` used to run its own `for (let k = Math.ceil(runStart / DASH_REPEAT); ...)`
    // loop. The schedule is now `treadSpans`, which is the same function
    // `correctedCorner()` builds its own `treads` field from - a join
    // `artBoardGeometry.test.ts` asserts directly.
    expect(CODE).not.toMatch(/Math\.ceil\s*\([^)]*BOARD_DASH_REPEAT/);
    expect(CODE).not.toMatch(/k\s*\*\s*BOARD_DASH_REPEAT/);
    expect(CODE).toMatch(/treadSpans\(/);
  });

  it('imports the three shared primitives it is required to draw through', () => {
    // Non-vacuity for the three `not.toMatch`es above: deleting the call sites would
    // satisfy every one of them.
    for (const name of ['cornerPointAtAngle', 'angleAtArcLength', 'treadSpans']) {
      expect(CODE, `${name} is imported`).toMatch(
        new RegExp(`^\\s*${name},\\s*$`, 'm'),
      );
      expect(CODE, `${name} is called`).toMatch(new RegExp(`${name}\\(`));
    }
  });

  it('imports its geometry from artBoardGeometry.ts and from nowhere else', () => {
    // THE RULE STANDS; ITS REASON WAS REWRITTEN BY PLAN 61-03, because the hazard it
    // used to name has ceased to exist and a live rule must not stand on a dead fact.
    //
    // It used to read: "The board draws at BOARD_ELBOW_R = 16 and the tree ships
    // ELBOW_R = 15. Importing the shipped constant here would draw the corner at 15
    // while printing the 16 table, and that divergence is invisible in the output."
    // The signed `61-BELT-LOCK-SUPERSESSION.md` (2026-08-09) moved the shipped radius
    // to 16, so the two agree and no import could produce that divergence today.
    //
    // The reason that remains is PUBLISHED-FIGURE STABILITY. This strip's numbers are
    // quoted in `57-ART-LOCK.md` and a lane width was chosen against them, so a future
    // shipped radius change must not silently move a figure that has already been
    // judged - while the drawing goes on looking correct. Reading the shipped constant
    // is exactly what would allow that. Same rule, same source form, honest reason.
    expect(CODE).not.toMatch(/from\s*['"][^'"]*shared\/geometry/);
    expect(CODE).toMatch(/from\s*['"]\.\/artBoardGeometry\.ts['"]/);
  });
});

/* ==================================================================== *
 * SHIPPED_ELBOW_R CONVERGENCE (W-4 of the v7.0 milestone audit, 2026-08-11)
 *
 * The rule directly above says the lane module must NOT import the shipped radius, and
 * that rule is correct and stays: this strip's figures are published in `57-ART-LOCK.md`
 * and were judged, so reading the live constant would let a future radius change move an
 * already-judged number while the drawing went on looking right.
 *
 * The COST of that rule is a hand-copied second declaration, `SHIPPED_ELBOW_R = 16`, and
 * it feeds a caption that makes a factual claim ABOUT THE TREE: "frontend/shared/
 * geometry.ts carries ELBOW_R = 16". Nothing asserted the two agreed. If the shipped
 * radius moved, the board would keep printing that sentence and it would be FALSE - the
 * instrument would publish a lie about the code it is quoting, which is worse than the
 * divergence the non-import rule exists to prevent.
 *
 * The guard is the sibling module's, copied in shape: `artBoardGeometry.test.ts` imports
 * the shipped `ELBOW_R` and asserts convergence with `BOARD_ELBOW_R`. The MECHANISM is
 * adapted, because this spec deliberately does not import its subject (pixi.js plus the
 * `artBoard.ts` import cycle, see the file header), so the board's side is read out of
 * the source text with the same comment-stripped corpus every other rule here uses.
 * ==================================================================== */

describe('artBoardLanes SHIPPED_ELBOW_R agrees with the tree (W-4)', () => {
  it('declares the shipped radius as a bare literal this spec can read', () => {
    // The non-vacuity half. Rename the constant or compute it and the extraction below
    // returns nothing, which must redden here rather than silently pass a `not` check.
    expect(CODE).toMatch(/const\s+SHIPPED_ELBOW_R\s*=\s*\d+\s*;/);
  });

  it('the hand-copied value EQUALS the shipped ELBOW_R', () => {
    const m = /const\s+SHIPPED_ELBOW_R\s*=\s*(\d+)\s*;/.exec(CODE);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(ELBOW_R);
  });

  it('the published caption interpolates the constant, never a re-typed radius', () => {
    // The claim the caption makes about the tree must be BUILT from the constant this
    // spec just pinned. A caption that typed the number would still read correctly on
    // screen while being unreachable from either gate above.
    expect(CODE).toMatch(/carries ELBOW_R = \$\{SHIPPED_ELBOW_R\}/);
    expect(CODE).not.toMatch(/carries ELBOW_R = \d/);
  });
});
