import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CELL } from '../../shared/geometry';
import type { MachineOutline } from './boardMeasure';

// captureMatrix.ts - what the board capture set boots, which zooms it captures at, and which
// cells each graded property expects a subject in.
//
// A BOOT is one browser context: one pixel ratio and one antialiasing setting. The capture test
// boots each one once and wheels through every zoom on that one page, so the host boots the demo
// board once per boot rather than once per zoom. A CELL is a boot at one zoom. The grading
// project generates one test per (property, cell) from `gradingCells`, at collection time, and
// reads what the capture project measured from that boot's manifest.

/** `shipped` is the build's own antialiasing setting (off); `on` boots with the test-only flag. */
export type AaSetting = 'shipped' | 'on';

/** `boot` is whatever zoom the board's own fit lands on; a number is an exact camera scale. */
export type CaptureZoom = 'boot' | number;

export interface CaptureBoot {
  dpr: number;
  aa: AaSetting;
}

export interface CaptureCell extends CaptureBoot {
  zoom: CaptureZoom;
}

/** The properties the grading project checks. Each one names what it measures on screen. */
export type PropertyId = 'outline-sides';

export const CAPTURE_BOOTS: readonly CaptureBoot[] = [{ dpr: 1, aa: 'shipped' }];

export const CAPTURE_ZOOMS: readonly CaptureZoom[] = ['boot', 1];

/** A file-name-safe id for a boot, for example `dpr1-aa-shipped` or `dpr1.18-aa-on`. */
export function bootId(boot: CaptureBoot): string {
  return `dpr${boot.dpr}-aa-${boot.aa}`;
}

/** A file-name-safe id for a zoom: `boot`, or the scale as written (`1`, `0.75`). */
export function zoomId(zoom: CaptureZoom): string {
  return zoom === 'boot' ? 'boot' : String(zoom);
}

/** The test title of one grading cell, for example `outline-sides dpr=1 aa=shipped zoom=1`. */
export function cellTitle(property: PropertyId, cell: CaptureCell): string {
  return `${property} dpr=${cell.dpr} aa=${cell.aa} zoom=${zoomId(cell.zoom)}`;
}

/** Where every boot's captures and manifest go: `frontend/test-results/capture/`. */
export const CAPTURE_ROOT = fileURLToPath(new URL('../../test-results/capture/', import.meta.url));

/** One boot's directory under `CAPTURE_ROOT`. */
export function captureDir(boot: CaptureBoot): string {
  return `${CAPTURE_ROOT}${bootId(boot)}`;
}

/**
 * The renderer's machine detail cut, read out of `machines.ts` as source: below
 * `scale x CELL < LOD_MIN_MACHINE_PX` a machine draws as a solid block with no outline.
 *
 * Read as text, not imported, because `machines.ts` pulls in the SVG assets through Vite's
 * `?raw` imports, which the Playwright runner can't load. Reading the shipped line keeps the
 * number single-sourced: a file with no such line throws by name rather than defaulting.
 */
export const LOD_MIN_MACHINE_PX: number = (() => {
  const src = readFileSync(fileURLToPath(new URL('../../src/render/layers/machines.ts', import.meta.url)), 'utf8');
  const m = /^export const LOD_MIN_MACHINE_PX = (\d+(?:\.\d+)?);$/m.exec(src);
  if (m === null) throw new Error('captureMatrix: no `export const LOD_MIN_MACHINE_PX = <n>;` line in src/render/layers/machines.ts');
  return Number(m[1]);
})();

/**
 * True when machines draw as vectors (an outline and a glyph) at this zoom. A boot zoom is the
 * board's fit and is known only once captured, so it is taken as drawn here and its capture's
 * machines are what the grade then reads.
 */
export function machinesDrawnAsVectors(zoom: CaptureZoom): boolean {
  return zoom === 'boot' || zoom * CELL >= LOD_MIN_MACHINE_PX;
}

/** One capture as the manifest records it: what was asked, what was read back, what was measured. */
export interface CaptureEntry {
  cell: CaptureCell;
  /** The PNG, relative to `CAPTURE_ROOT`. */
  png: string;
  /** The camera read back after the zoom settled, not the zoom that was asked for. */
  camera: { x: number; y: number; scale: number };
  dpr: number;
  backing: { width: number; height: number };
  client: { width: number; height: number };
  gl: { antialias: boolean | null; samples: number | null };
  tick: number;
  measurements: Record<PropertyId, MachineOutline[]>;
}

/** `<captureDir>/manifest.json`: every capture one boot took. */
export interface CaptureManifest {
  boot: CaptureBoot;
  entries: CaptureEntry[];
}

/** Every cell where the property's subject is drawn, in boot order then zoom order. */
export function gradingCells(property: PropertyId): CaptureCell[] {
  const out: CaptureCell[] = [];
  for (const boot of CAPTURE_BOOTS) {
    for (const zoom of CAPTURE_ZOOMS) {
      if (property === 'outline-sides' && !machinesDrawnAsVectors(zoom)) continue;
      out.push({ ...boot, zoom });
    }
  }
  return out;
}
