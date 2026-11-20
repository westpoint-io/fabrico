import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { gradeOutlineSides } from './support/boardMeasure';
import { bootId, captureDir, cellTitle, gradingCells, zoomId, type CaptureCell, type CaptureManifest } from './support/captureMatrix';

// board-grade.capture.ts - grades what the capture project measured, one test per (property,
// cell), generated at collection time from `gradingCells`. The capture project
// (`board.capture.ts`) runs first (this project depends on it) and writes one manifest per boot;
// each test here reads only that manifest. No capture is compared with a stored image.

function entryFor(cell: CaptureCell) {
  const path = join(captureDir(cell), 'manifest.json');
  if (!existsSync(path)) throw new Error(`no manifest for boot ${bootId(cell)} at ${path}: the capture test for this boot didn't write one`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as CaptureManifest;
  const entry = manifest.entries.find((e) => e.cell.zoom === cell.zoom);
  if (entry === undefined) throw new Error(`the manifest for boot ${bootId(cell)} has no capture at zoom ${zoomId(cell.zoom)}, which this cell expects`);
  return entry;
}

for (const cell of gradingCells('outline-sides')) {
  test(cellTitle('outline-sides', cell), () => {
    const entry = entryFor(cell);
    const { offenders, explain } = gradeOutlineSides(entry.measurements['outline-sides'], cell);
    expect(offenders, explain).toEqual([]);
  });
}
