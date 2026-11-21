import type { Grade } from './boardMeasure';
import {
  FRACTIONAL_DPR,
  FULLSCREEN_BOOT_ZOOM,
  cellTitle,
  gradingCells,
  type AaSetting,
  type CaptureCell,
  type CaptureZoom,
  type PropertyId,
} from './captureMatrix';

// captureDefects.ts - the board capture set's declared expected failures, and the rule that lets a
// declared grading test stand as an expected failure.
//
// WHAT A ROW IS. The capture set grades the board as it is drawn today, and some of what it measures
// is a known defect that a later change is meant to fix. Each row here names one grading cell (a
// property at one pixel ratio, antialiasing setting and zoom), the requirement whose fix makes it
// pass (STRK-01, STRK-02 or STRK-03), the offenders a measured run at the revision that added the
// row found in that cell (`<node id>:<side>` keys from the grader), and why, with the widths that
// run measured.
//
// WHAT A ROW DOES. A declared grading test keeps CI green while it fails on exactly the offenders
// its row names. If it starts passing, Playwright reports it as an unexpected pass and CI goes red,
// so the change that fixes the defect has to remove the row. Anything else is a plain failure, never
// a declared one: a crash, a missing manifest entry, a side that wasn't measured, a machine no tile
// held whole, a declared offender that stopped failing while the cell still fails, or an offender
// the row doesn't name. `runGradeCell` reaches the expected-failure mark (the spec's `test.fail()`)
// only after `checkDeclared` finds the failure is exactly the declared one, so for any of those the
// test is still expected to pass and is reported as failed.
//
// HOW ROWS ARE ADDED. Only from a measured run: run `npm run e2e:capture` with the row absent, read
// the failing cell's offenders and widths from its report, and copy them in. A row is never written
// from a research note or from the checker's report alone. `board-grade.capture.ts` refuses to
// collect when a row matches no grading cell or two rows match one cell, so a stale row can't sit
// here unnoticed.

export interface DeclaredDefect {
  property: PropertyId;
  dpr: number;
  aa: AaSetting;
  zoom: CaptureZoom;
  fixes: 'STRK-01' | 'STRK-02' | 'STRK-03';
  /** The offender keys the measured run found in this cell, every one a measured side. */
  offenders: readonly string[];
  /** Why the cell fails, with the widths the measured run read. */
  why: string;
}

/**
 * The rows, measured by `npm run e2e:capture` at the revision that added them (16 of the 18
 * outline-sides cells fail there; ratio 1 and ratio 2 at zoom 1 with antialiasing as shipped pass).
 * Widths are device px, read as the median over each side's sample lines. Offender keys are
 * `<node id>:<side>`.
 */
export const DECLARED_DEFECTS: readonly DeclaredDefect[] = [
  {
    property: 'outline-sides',
    dpr: 1,
    aa: 'shipped',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: [
      '3:right',
      '5:left',
      '9:right',
      '10:right',
      '29:top',
    ],
    why: 'ratio 1, antialiasing as shipped, boot zoom (scale 1.3027): 5 of 13 machines draw a side at a different core width from their other sides (device px, the odd side vs the other sides): machine 3 right 3 vs 4, machine 5 left 3 vs 4, machine 9 right 3 vs 4, machine 10 right 3 vs 4, machine 29 top 3 vs 4',
  },
  {
    property: 'outline-sides',
    dpr: 1,
    aa: 'shipped',
    zoom: FULLSCREEN_BOOT_ZOOM,
    fixes: 'STRK-01',
    offenders: [
      '0:right',
      '1:top', '1:bottom',
      '2:bottom',
      '4:top',
      '5:bottom',
      '6:bottom', '6:left',
      '7:left',
      '8:bottom',
      '29:bottom',
    ],
    why: 'ratio 1, antialiasing as shipped, full-screen boot zoom (scale 2.8853): 9 of 13 machines draw a side at a different core width from their other sides (device px, the odd side vs the other sides): machine 0 right 8 vs 9, machine 1 top 8 bottom 8 vs 9, machine 2 bottom 8 vs 9, machine 4 top 9 vs 8, machine 5 bottom 9 vs 8, machine 6 bottom 8 left 8 vs 9, machine 7 left 8 vs 9, machine 8 bottom 8 vs 9, machine 29 bottom 8 vs 9',
  },
  {
    property: 'outline-sides',
    dpr: 1,
    aa: 'on',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:left',
      '1:right', '1:bottom', '1:left',
      '2:top', '2:bottom', '2:left',
      '3:top', '3:right', '3:bottom', '3:left',
      '4:top', '4:right', '4:bottom', '4:left',
      '5:top', '5:right', '5:bottom', '5:left',
      '6:top', '6:right', '6:bottom', '6:left',
      '7:top', '7:right', '7:bottom', '7:left',
      '8:top', '8:right', '8:bottom', '8:left',
      '9:top', '9:right', '9:left',
      '10:top', '10:right', '10:left',
      '29:top', '29:right', '29:bottom',
      '30:top', '30:right', '30:bottom',
    ],
    why: 'ratio 1, antialiasing on, boot zoom (scale 1.3027): 44 sides of 13 of 13 machines show a grey fringe (median device px: 30 x core 3 fringe 2, 11 x core 4 fringe 1, 3 x core 3 fringe 1); effective widths spread more than 0.25 px (machine 1 0.295, machine 2 0.295, machine 3 0.298, machine 5 0.305, machine 6 0.295, machine 7 0.400, machine 30 0.295 px)',
  },
  {
    property: 'outline-sides',
    dpr: 1,
    aa: 'on',
    zoom: 1,
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:right', '0:bottom', '0:left',
      '1:top', '1:right', '1:bottom', '1:left',
      '2:top', '2:right', '2:bottom', '2:left',
      '3:top', '3:right', '3:bottom', '3:left',
      '4:top', '4:right', '4:bottom', '4:left',
      '5:top', '5:right', '5:bottom', '5:left',
      '6:top', '6:right', '6:bottom', '6:left',
      '7:top', '7:right', '7:bottom', '7:left',
      '8:top', '8:right', '8:bottom', '8:left',
      '9:top', '9:right', '9:bottom', '9:left',
      '10:top', '10:right', '10:bottom', '10:left',
      '29:top', '29:right', '29:bottom', '29:left',
      '30:top', '30:right', '30:bottom', '30:left',
    ],
    why: 'ratio 1, antialiasing on, zoom 1: 52 sides of 13 of 13 machines show a grey fringe (median device px: 52 x core 2 fringe 2), the 2 px core with a partly covered row either side that the 3u stroke on a half-pixel edge gives',
  },
  {
    property: 'outline-sides',
    dpr: 1,
    aa: 'on',
    zoom: FULLSCREEN_BOOT_ZOOM,
    fixes: 'STRK-01',
    offenders: [
      '0:right',
      '1:top', '1:bottom',
      '2:right', '2:bottom', '2:left',
      '3:right',
      '4:right', '4:bottom', '4:left',
      '5:top', '5:right', '5:bottom', '5:left',
      '6:bottom', '6:left',
      '7:bottom', '7:left',
      '8:top', '8:right', '8:bottom', '8:left',
      '9:right',
      '10:right',
      '29:right', '29:bottom',
      '30:top', '30:bottom',
    ],
    why: 'ratio 1, antialiasing on, full-screen boot zoom (scale 2.8853): 26 sides of 13 of 13 machines show a grey fringe (median device px: 17 x core 8 fringe 2, 9 x core 8 fringe 1); effective widths spread more than 0.25 px (machine 1 0.250, machine 2 0.252, machine 3 0.250, machine 5 0.252, machine 7 0.252, machine 8 0.252, machine 9 0.250, machine 10 0.250, machine 30 0.250 px)',
  },
  {
    property: 'outline-sides',
    dpr: FRACTIONAL_DPR,
    aa: 'shipped',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: [
      '0:left',
      '1:left',
      '2:top',
      '3:bottom',
      '6:top',
      '7:right',
      '8:right',
      '9:top', '9:bottom',
      '10:top',
      '29:top', '29:bottom',
      '30:top',
    ],
    why: 'ratio 1.1818, antialiasing as shipped, boot zoom (scale 1.3028): 11 of 13 machines draw a side at a different core width from their other sides (device px, the odd side vs the other sides): machine 0 left 5 vs 4, machine 1 left 4 vs 5, machine 2 top 4 vs 5, machine 3 bottom 4 vs 5, machine 6 top 4 vs 5, machine 7 right 4 vs 5, machine 8 right 4 vs 5, machine 9 top 4 bottom 4 vs 5, machine 10 top 4 vs 5, machine 29 top 4 bottom 4 vs 5, machine 30 top 4 vs 5',
  },
  {
    property: 'outline-sides',
    dpr: FRACTIONAL_DPR,
    aa: 'shipped',
    zoom: 1,
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:left',
      '2:top', '2:right',
      '3:right', '3:bottom',
      '4:left',
      '5:right',
      '6:top', '6:right',
      '7:right',
      '8:top',
      '9:top', '9:right',
      '10:top', '10:left',
      '29:right',
      '30:top', '30:bottom',
    ],
    why: 'ratio 1.1818, antialiasing as shipped, zoom 1: 12 of 13 machines draw a side at a different core width from their other sides (device px, the odd side vs the other sides): machine 0 top 3 left 3 vs 4, machine 2 top 3 right 3 vs 4, machine 3 right 3 bottom 3 vs 4, machine 4 left 3 vs 4, machine 5 right 3 vs 4, machine 6 top 3 right 3 vs 4, machine 7 right 3 vs 4, machine 8 top 4 vs 3, machine 9 top 3 right 3 vs 4, machine 10 top 3 left 3 vs 4, machine 29 right 4 vs 3, machine 30 top 3 bottom 3 vs 4',
  },
  {
    property: 'outline-sides',
    dpr: FRACTIONAL_DPR,
    aa: 'shipped',
    zoom: FULLSCREEN_BOOT_ZOOM,
    fixes: 'STRK-01',
    offenders: [
      '1:left',
      '3:bottom',
      '5:top', '5:left',
      '9:top', '9:right',
      '10:left',
      '30:top', '30:bottom',
    ],
    why: 'ratio 1.1818, antialiasing as shipped, full-screen boot zoom (scale 2.8853): 6 of 13 machines draw a side at a different core width from their other sides (device px, the odd side vs the other sides): machine 1 left 11 vs 10, machine 3 bottom 11 vs 10, machine 5 top 10 left 10 vs 11, machine 9 top 10 right 10 vs 11, machine 10 left 11 vs 10, machine 30 top 10 bottom 10 vs 11',
  },
  {
    property: 'outline-sides',
    dpr: FRACTIONAL_DPR,
    aa: 'on',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:right', '0:bottom', '0:left',
      '1:top', '1:right', '1:bottom', '1:left',
      '2:top', '2:bottom', '2:left',
      '3:top', '3:bottom', '3:left',
      '4:top', '4:right', '4:bottom', '4:left',
      '5:top', '5:right', '5:bottom', '5:left',
      '6:top', '6:right', '6:bottom', '6:left',
      '7:top', '7:right', '7:bottom', '7:left',
      '8:top', '8:right', '8:bottom', '8:left',
      '9:top', '9:bottom', '9:left',
      '10:top', '10:bottom', '10:left',
      '29:top', '29:right', '29:bottom', '29:left',
      '30:top', '30:right', '30:bottom', '30:left',
    ],
    why: 'ratio 1.1818, antialiasing on, boot zoom (scale 1.3028): 47 sides of 13 of 13 machines show a grey fringe (median device px: 25 x core 4 fringe 1, 22 x core 4 fringe 2); effective widths spread more than 0.25 px (machine 0 0.252, machine 3 0.299, machine 4 0.301, machine 5 0.303, machine 29 0.271, machine 30 0.255 px)',
  },
  {
    property: 'outline-sides',
    dpr: FRACTIONAL_DPR,
    aa: 'on',
    zoom: 1,
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:right', '0:bottom', '0:left',
      '1:top', '1:right', '1:bottom', '1:left',
      '2:top', '2:right', '2:bottom', '2:left',
      '3:top', '3:right', '3:bottom', '3:left',
      '4:top', '4:right', '4:bottom', '4:left',
      '5:top', '5:right', '5:bottom', '5:left',
      '6:top', '6:right', '6:bottom', '6:left',
      '7:top', '7:right', '7:bottom', '7:left',
      '8:top', '8:right', '8:bottom', '8:left',
      '9:top', '9:right', '9:bottom', '9:left',
      '10:top', '10:right', '10:bottom', '10:left',
      '29:top', '29:right', '29:bottom', '29:left',
      '30:top', '30:right', '30:bottom', '30:left',
    ],
    why: 'ratio 1.1818, antialiasing on, zoom 1: 52 sides of 13 of 13 machines show a grey fringe (median device px: 37 x core 3 fringe 1, 14 x core 3 fringe 2, 1 x core 2 fringe 2); effective widths spread more than 0.25 px (machine 0 0.286, machine 2 0.255, machine 3 0.312, machine 4 0.285, machine 9 0.279, machine 10 0.296, machine 29 0.268 px)',
  },
  {
    property: 'outline-sides',
    dpr: FRACTIONAL_DPR,
    aa: 'on',
    zoom: FULLSCREEN_BOOT_ZOOM,
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:right', '0:bottom', '0:left',
      '1:top', '1:right', '1:bottom', '1:left',
      '2:top', '2:right', '2:bottom', '2:left',
      '3:top', '3:right', '3:bottom', '3:left',
      '4:top', '4:right', '4:bottom', '4:left',
      '5:top', '5:right', '5:bottom', '5:left',
      '6:top', '6:right', '6:bottom', '6:left',
      '7:top', '7:right', '7:bottom', '7:left',
      '8:top', '8:right', '8:bottom', '8:left',
      '9:top', '9:right', '9:bottom', '9:left',
      '10:top', '10:right', '10:bottom', '10:left',
      '29:top', '29:right', '29:bottom', '29:left',
      '30:top', '30:right', '30:bottom', '30:left',
    ],
    why: 'ratio 1.1818, antialiasing on, full-screen boot zoom (scale 2.8853): 52 sides of 13 of 13 machines show a grey fringe (median device px: 24 x core 10 fringe 1, 21 x core 9 fringe 2, 7 x core 10 fringe 2); effective widths spread more than 0.25 px (machine 4 0.254 px)',
  },
  {
    property: 'outline-sides',
    dpr: 2,
    aa: 'shipped',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: [
      '0:left',
      '1:left',
      '2:left',
      '3:left',
      '5:right',
      '6:right', '6:left',
      '7:bottom',
      '9:left',
      '10:top', '10:left',
      '29:right', '29:bottom',
      '30:top',
    ],
    why: 'ratio 2, antialiasing as shipped, boot zoom (scale 1.3027): 11 of 13 machines draw a side at a different core width from their other sides (device px, the odd side vs the other sides): machine 0 left 7 vs 8, machine 1 left 7 vs 8, machine 2 left 7 vs 8, machine 3 left 7 vs 8, machine 5 right 7 vs 8, machine 6 right 7 left 7 vs 8, machine 7 bottom 7 vs 8, machine 9 left 7 vs 8, machine 10 top 7 left 7 vs 8, machine 29 right 7 bottom 7 vs 8, machine 30 top 7 vs 8',
  },
  {
    property: 'outline-sides',
    dpr: 2,
    aa: 'shipped',
    zoom: FULLSCREEN_BOOT_ZOOM,
    fixes: 'STRK-01',
    offenders: [
      '1:bottom', '1:left',
      '3:left',
      '5:top',
      '6:right',
      '7:right',
      '8:bottom',
      '9:left',
      '10:top', '10:right',
      '29:left',
      '30:top', '30:bottom',
    ],
    why: 'ratio 2, antialiasing as shipped, full-screen boot zoom (scale 2.8853): 10 of 13 machines draw a side at a different core width from their other sides (device px, the odd side vs the other sides): machine 1 bottom 17 left 17 vs 18, machine 3 left 18 vs 17, machine 5 top 18 vs 17, machine 6 right 18 vs 17, machine 7 right 18 vs 17, machine 8 bottom 18 vs 17, machine 9 left 18 vs 17, machine 10 top 17 right 17 vs 18, machine 29 left 18 vs 17, machine 30 top 17 bottom 17 vs 18',
  },
  {
    property: 'outline-sides',
    dpr: 2,
    aa: 'on',
    zoom: 'boot',
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:left',
      '1:bottom', '1:left',
      '2:top', '2:right', '2:bottom', '2:left',
      '3:top', '3:left',
      '4:top', '4:bottom', '4:left',
      '5:top', '5:right',
      '6:top', '6:right', '6:bottom', '6:left',
      '7:top', '7:right', '7:bottom', '7:left',
      '8:top', '8:right',
      '9:top', '9:left',
      '10:top', '10:left',
      '29:right', '29:bottom',
      '30:top', '30:right', '30:left',
    ],
    why: 'ratio 2, antialiasing on, boot zoom (scale 1.3027): 34 sides of 13 of 13 machines show a grey fringe (median device px: 30 x core 7 fringe 2, 3 x core 8 fringe 1, 1 x core 7 fringe 1); effective widths spread more than 0.25 px (machine 4 0.252, machine 5 0.252, machine 6 0.250, machine 7 0.250, machine 8 0.252, machine 10 0.252, machine 29 0.252, machine 30 0.268 px)',
  },
  {
    property: 'outline-sides',
    dpr: 2,
    aa: 'on',
    zoom: 1,
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:bottom',
      '1:top', '1:bottom',
      '2:top', '2:bottom',
      '3:top', '3:bottom',
      '4:top', '4:bottom',
      '5:top', '5:bottom',
      '6:top', '6:bottom',
      '7:top', '7:bottom',
      '8:top', '8:bottom',
      '9:top', '9:bottom',
      '10:top', '10:bottom',
      '29:top', '29:bottom',
      '30:top', '30:bottom',
    ],
    why: 'ratio 2, antialiasing on, zoom 1: 26 sides of 13 of 13 machines show a grey fringe (median device px: 13 x core 6 fringe 1, 13 x core 5 fringe 2)',
  },
  {
    property: 'outline-sides',
    dpr: 2,
    aa: 'on',
    zoom: FULLSCREEN_BOOT_ZOOM,
    fixes: 'STRK-01',
    offenders: [
      '0:top', '0:right', '0:bottom', '0:left',
      '1:top', '1:right', '1:bottom', '1:left',
      '2:top', '2:right', '2:bottom', '2:left',
      '3:top', '3:right', '3:bottom', '3:left',
      '4:top', '4:right', '4:bottom', '4:left',
      '5:top', '5:right', '5:bottom', '5:left',
      '6:top', '6:right', '6:bottom', '6:left',
      '7:top', '7:right', '7:bottom', '7:left',
      '8:top', '8:right', '8:bottom', '8:left',
      '9:top', '9:right', '9:bottom', '9:left',
      '10:top', '10:right', '10:bottom', '10:left',
      '29:top', '29:right', '29:bottom', '29:left',
      '30:top', '30:right', '30:bottom', '30:left',
    ],
    why: 'ratio 2, antialiasing on, full-screen boot zoom (scale 2.8853): 49 sides of 13 of 13 machines show a grey fringe (median device px: 45 x core 17 fringe 1, 4 x core 17 fringe 2); effective widths spread more than 0.25 px (machine 1 0.250, machine 2 0.252, machine 5 0.252, machine 6 0.250, machine 7 0.252, machine 30 0.252 px)',
  },
];

function sameCell(row: DeclaredDefect, property: PropertyId, cell: CaptureCell): boolean {
  return row.property === property && row.dpr === cell.dpr && row.aa === cell.aa && row.zoom === cell.zoom;
}

/** The row declaring this cell, if any. */
export function declaredDefect(property: PropertyId, cell: CaptureCell): DeclaredDefect | undefined {
  return DECLARED_DEFECTS.find((row) => sameCell(row, property, cell));
}

/**
 * Throws when a row matches no grading cell of its property, or two rows match one cell. The
 * grading spec calls this at collection time, so either mistake stops the run before any test.
 */
export function assertDeclaredRowsMatchCells(rows: readonly DeclaredDefect[] = DECLARED_DEFECTS): void {
  const problems: string[] = [];
  for (const row of rows) {
    const cells = gradingCells(row.property).filter((cell) => sameCell(row, row.property, cell));
    const label = cellTitle(row.property, row);
    if (cells.length === 0) problems.push(`the row for ${label} matches no grading cell`);
    const twins = rows.filter((other) => other !== row && sameCell(other, row.property, row));
    if (twins.length > 0) problems.push(`${twins.length + 1} rows declare ${label}`);
  }
  if (problems.length > 0) throw new Error(`captureDefects.ts: ${[...new Set(problems)].join('; ')}`);
}

/**
 * Why `result` is not exactly the failure `row` declares: one reason for each offender that wasn't
 * measured, each row key the result doesn't hold, and each result key the row doesn't name. An empty
 * list means the cell fails on exactly its declared offenders, all of them measured.
 */
export function checkDeclared(row: DeclaredDefect, result: Grade): string[] {
  const reasons: string[] = [];
  const keys = new Set(result.offenders.map((o) => o.key));
  const declared = new Set(row.offenders);
  for (const o of result.offenders) if (o.unmeasured) reasons.push(`${o.key} was not measured, so this cell can't be judged against its row: ${o.text}`);
  for (const k of row.offenders) if (!keys.has(k)) reasons.push(`${k} is declared but no longer fails`);
  for (const o of result.offenders) if (!declared.has(o.key)) reasons.push(`${o.key} fails but the row doesn't declare it: ${o.text}`);
  return reasons;
}

/**
 * Grade one cell. Framework-free, so the unit tests drive the same code the grading spec runs.
 *
 * `grade(cell)` reads the manifest and grades; it throws when the manifest or the cell's entry is
 * missing or unreadable, and that throw comes out of here unchanged. With a row: a cell with no
 * offenders reaches `markExpectedFailure` and returns, so the spec's `test.fail()` reports the pass
 * and the row has to go; otherwise any reason from `checkDeclared` is thrown before the mark, and
 * only an exact match reaches it. Last, a cell with offenders throws its explanation.
 */
export function runGradeCell(
  cell: CaptureCell,
  row: DeclaredDefect | undefined,
  grade: (cell: CaptureCell) => Grade,
  markExpectedFailure: () => void,
): void {
  const result = grade(cell);
  if (row !== undefined) {
    if (result.offenders.length === 0) {
      markExpectedFailure();
      return;
    }
    const reasons = checkDeclared(row, result);
    if (reasons.length > 0) {
      throw new Error(`${cellTitle(row.property, cell)} is declared under ${row.fixes} but doesn't fail the way its row says:\n  ${reasons.join('\n  ')}\n${result.explain}`);
    }
    markExpectedFailure();
  }
  if (result.offenders.length > 0) throw new Error(result.explain);
}
