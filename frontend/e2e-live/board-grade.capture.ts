import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { gradeOutlineSides, outlinesForCell } from './support/boardMeasure';
import { assertDeclaredRowsMatchCells, declaredDefect, runGradeCell } from './support/captureDefects';
import { bootId, captureDir, cellTitle, gradingCells, zoomId, type CaptureCell, type CaptureEntry, type CaptureManifest } from './support/captureMatrix';

// board-grade.capture.ts - grades what the capture project measured, one test per (property,
// cell), generated at collection time from `gradingCells`. The capture project
// (`board.capture.ts`) runs first (this project depends on it) and writes one manifest per boot;
// each test here reads only that manifest. No capture is compared with a stored image.
//
// A zoom where the board overflows the viewport has several tiles. Each machine is graded in the
// first tile that measured it (`outlinesForCell`); a scene machine no tile held whole is an
// offender, and so is a cell with no manifest entry.
//
// DECLARED CELLS. A cell with a row in `captureDefects.ts` is a known defect: its test carries the
// row's requirement tag and a `fixed-by` annotation with the row's measured reason, and
// `runGradeCell` calls `test.fail()` only once the failure is exactly the row's offenders, all
// measured. A crash, a missing entry, an unmeasured side or a different set of offenders throws
// before that, so the test stays expected to pass and is reported as failed.

/** Every tile the manifest holds for this cell, in tile order. Throws when there is none. */
function entriesFor(cell: CaptureCell): CaptureEntry[] {
  const path = join(captureDir(cell), 'manifest.json');
  if (!existsSync(path)) throw new Error(`no manifest for boot ${bootId(cell)} at ${path}: the capture test for this boot didn't write one`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as CaptureManifest;
  const entries = manifest.entries.filter((e) => e.cell.zoom === cell.zoom).sort((a, b) => a.tile - b.tile);
  if (entries.length === 0) throw new Error(`the manifest for boot ${bootId(cell)} has no capture at zoom ${zoomId(cell.zoom)}, which this cell expects`);
  return entries;
}

/** Read this cell's tiles from the manifest and grade the outline sides. */
function gradeOutlineCell(cell: CaptureCell) {
  const tiles = entriesFor(cell).map((e) => ({ scene: e.scene, outlines: e.measurements['outline-sides'] }));
  const { outlines, neverClear } = outlinesForCell(tiles);
  return gradeOutlineSides(outlines, cell, neverClear);
}

// A row that matches no cell, or two rows on one cell, stops the run here at collection.
assertDeclaredRowsMatchCells();

for (const cell of gradingCells('outline-sides')) {
  const row = declaredDefect('outline-sides', cell);
  const details = row === undefined ? {} : { tag: `@${row.fixes}`, annotation: { type: 'fixed-by', description: row.why } };
  test(cellTitle('outline-sides', cell), details, () => {
    runGradeCell(cell, row, gradeOutlineCell, () => test.fail());
  });
}
