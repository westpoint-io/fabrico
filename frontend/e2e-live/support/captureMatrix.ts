import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CELL } from '../../shared/geometry';
import type { SceneMachine, TileMeasurements } from './boardMeasure';

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

/**
 * The properties the grading project checks. Each one names what it measures on screen:
 *
 * - `outline-sides`: the four sides of a machine outline read the same width (STRK-01).
 * - `glyph-strokes`: the legs of the Factory glyph read the same width (STRK-01).
 * - `fault-ring`: each bare fault port ring is continuous, keeps its hole and is at least one
 *   device pixel wide (STRK-02).
 * - `belt-dash`: each straight belt tile's dash, or its low-zoom tick, has no gap (STRK-02).
 * - `rail-vs-outline`: a belt rail is no wider than a machine outline in the same capture (STRK-03).
 * - `cap-in-cell`: a belt end cap is no wider than one cell (STRK-03).
 */
export type PropertyId = 'outline-sides' | 'glyph-strokes' | 'fault-ring' | 'belt-dash' | 'rail-vs-outline' | 'cap-in-cell';

/** Every property, in the order the grading project generates its tests. */
export const PROPERTY_IDS: readonly PropertyId[] = ['outline-sides', 'glyph-strokes', 'fault-ring', 'belt-dash', 'rail-vs-outline', 'cap-in-cell'];

/**
 * The fractional pixel ratio the capture set boots at besides 1 and 2: the `devicePixelRatio` read
 * from the shipped app in a full-screen 3840x2160 window on the maintainer's screen,
 * 1.181793212890625. On an Xvfb display, `GDK_DPI_SCALE=1.1818` reproduces this ratio in the real
 * app (WebKitGTK), which is how the real-app walk boots at it.
 */
export const FRACTIONAL_DPR = 1.181793212890625;

/**
 * The zoom the shipped app's own fit lands on in that same full-screen 3840x2160 window at
 * `FRACTIONAL_DPR`: 2.8853387774251424. The 1600x1000 viewport here fits at a much smaller zoom,
 * so this is captured as an exact zoom of its own. It is the zoom the board opens at on that
 * screen, so the outline rule treats it like `boot`.
 */
export const FULLSCREEN_BOOT_ZOOM = 2.8853387774251424;

/** Two zooms this close are one capture: the later one is left out of `CAPTURE_ZOOMS`. */
export const ZOOM_DEDUP = 0.01;

/** The pixel ratios, without repeats, in ascending order. */
const CAPTURE_DPRS: readonly number[] = [...new Set([1, FRACTIONAL_DPR, 2])].sort((a, b) => a - b);

/** One boot per pixel ratio and antialiasing setting: ordered by ratio, `shipped` before `on`. */
export const CAPTURE_BOOTS: readonly CaptureBoot[] = CAPTURE_DPRS.flatMap((dpr) => [
  { dpr, aa: 'shipped' as const },
  { dpr, aa: 'on' as const },
]);

/**
 * Every zoom each boot captures, in this order. The full-screen boot zoom is left out when it lands
 * within `ZOOM_DEDUP` of a zoom already listed (at 2.885 it doesn't: the nearest is 2).
 */
export const CAPTURE_ZOOMS: readonly CaptureZoom[] = (() => {
  const zooms: CaptureZoom[] = ['boot', 0.25, 0.5, 0.75, 1, 2, 4];
  const near = zooms.some((z) => typeof z === 'number' && Math.abs(z - FULLSCREEN_BOOT_ZOOM) < ZOOM_DEDUP);
  return near ? zooms : [...zooms, FULLSCREEN_BOOT_ZOOM];
})();

/** True for a zoom the board opens at: the 1600x1000 fit (`boot`) and the full-screen fit. */
export function isBootZoom(zoom: CaptureZoom): boolean {
  return zoom === 'boot' || zoom === FULLSCREEN_BOOT_ZOOM;
}

/** A file-name-safe id for a boot, for example `dpr1-aa-shipped` or `dpr1.181793212890625-aa-on`. */
export function bootId(boot: CaptureBoot): string {
  return `dpr${boot.dpr}-aa-${boot.aa}`;
}

/**
 * A file-name-safe id for a zoom, also its token in test titles: `boot`, `fullscreen-boot` for
 * `FULLSCREEN_BOOT_ZOOM`, or the scale as written (`1`, `0.75`).
 */
export function zoomId(zoom: CaptureZoom): string {
  if (zoom === 'boot') return 'boot';
  if (zoom === FULLSCREEN_BOOT_ZOOM) return 'fullscreen-boot';
  return String(zoom);
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
 * A number the renderer declares as `const NAME = <n>;` (or `export const`), read out of the
 * shipped source as text. Read, not imported, because the render layers pull in the SVG assets
 * through Vite's `?raw` imports, which the Playwright runner can't load, and some of these numbers
 * aren't exported. Reading the shipped line keeps each number single-sourced: a file with no such
 * line throws by name rather than defaulting.
 */
export function shippedConst(file: string, name: string): number {
  const src = readFileSync(fileURLToPath(new URL(`../../src/render/${file}`, import.meta.url)), 'utf8');
  const m = new RegExp(`^(?:export )?const ${name} = (\\d+(?:\\.\\d+)?);`, 'm').exec(src);
  if (m === null) throw new Error(`captureMatrix: no \`const ${name} = <n>;\` line in src/render/${file}`);
  return Number(m[1]);
}

/**
 * The renderer's machine detail cut (`machines.ts`): below `scale x CELL < LOD_MIN_MACHINE_PX` a
 * machine draws as a solid block with no outline, glyph or port nubs.
 */
export const LOD_MIN_MACHINE_PX: number = shippedConst('layers/machines.ts', 'LOD_MIN_MACHINE_PX');

/**
 * The belt layer's tread detail cut (`belts.ts`): at `scale x CELL >= LOD_MIN_TREAD_PX` a straight
 * tile draws the marching 10-on, 6-off dash, and below it one static tick on the tile centre.
 */
export const LOD_MIN_TREAD_PX: number = shippedConst('layers/belts.ts', 'LOD_MIN_TREAD_PX');

/** True when straight belt tiles draw the full dash at this camera scale (else the low-zoom tick). */
export function treadDrawnAsDash(scale: number): boolean {
  return scale * CELL >= LOD_MIN_TREAD_PX;
}

/**
 * True when machines draw as vectors (an outline and a glyph) at this zoom. A boot zoom is the
 * board's fit and is known only once captured, so it is taken as drawn here and its capture's
 * machines are what the grade then reads.
 */
export function machinesDrawnAsVectors(zoom: CaptureZoom): boolean {
  return zoom === 'boot' || zoom * CELL >= LOD_MIN_MACHINE_PX;
}

/**
 * One capture as the manifest records it: what was asked, what was read back, what was measured.
 * A zoom where the board overflows the viewport has one entry per tile, in tile order, all with the
 * same `cell`.
 */
export interface CaptureEntry {
  cell: CaptureCell;
  /** The zoom's token in test titles and on the page (`zoomId`). */
  zoomId: string;
  /** The tile's place in its zoom's tile order, from 0. */
  tile: number;
  /** The PNG, relative to `CAPTURE_ROOT`. */
  png: string;
  /** The camera scale the board's own fit landed on at this boot, read before any wheel. */
  bootScale: number;
  /** The camera read back after the zoom settled, not the zoom that was asked for. */
  camera: { x: number; y: number; scale: number };
  dpr: number;
  backing: { width: number; height: number };
  client: { width: number; height: number };
  gl: { antialias: boolean | null; samples: number | null };
  tick: number;
  /**
   * Every machine in the scene (label nodes left out), in node-id order. A machine graded in this
   * tile is in `measurements`; one that isn't on the canvas and clear of chrome here isn't.
   */
  scene: SceneMachine[];
  /**
   * Per property, every subject the scene holds for it, whether or not this tile could read it:
   * machine ids (`outline-sides`), Factory glyph node ids, `<node>:fault-<port>`,
   * `<belt>:tile-<n>`, `<belt>:rail`, `<belt>:collar-<n>`. The grade takes the union over a cell's
   * tiles, so a subject no tile measured is an offender, and a cell with no subject at all fails.
   */
  subjects: Record<PropertyId, string[]>;
  /** Per property, the rows measured in this tile: only subjects whose whole sampling area is clear here. */
  measurements: TileMeasurements;
}

/** `<captureDir>/manifest.json`: every capture one boot took. */
export interface CaptureManifest {
  boot: CaptureBoot;
  entries: CaptureEntry[];
}

/**
 * True when a requirement promises the outline-sides property at this zoom. STRK-01 promises equal
 * sides with no grey fringe "at zoom 1 and at boot zoom", and no requirement promises them anywhere
 * else, so only those zooms are graded. The captures at the other zooms still carry their measured
 * widths for the per-run page.
 */
export function outlineSidesPromisedAt(zoom: CaptureZoom): boolean {
  return zoom === 1 || isBootZoom(zoom);
}

/**
 * The zooms where a requirement promises the property, and where its subject is drawn:
 *
 * - `outline-sides` and `glyph-strokes`: zoom 1 and the two boot zooms (STRK-01 says "at zoom 1 and
 *   at boot zoom"; the other vector zooms keep their measured widths on the page).
 * - `fault-ring` and `rail-vs-outline`: every zoom where machines draw as vectors (STRK-02 promises
 *   no stroke under a device pixel at any zoom; a rail is compared with an outline, which only
 *   exists there).
 * - `belt-dash` and `cap-in-cell`: every zoom (belts draw at every zoom).
 */
export function propertyGradedAt(property: PropertyId, zoom: CaptureZoom): boolean {
  switch (property) {
    case 'outline-sides':
    case 'glyph-strokes':
      return machinesDrawnAsVectors(zoom) && outlineSidesPromisedAt(zoom);
    case 'fault-ring':
    case 'rail-vs-outline':
      return machinesDrawnAsVectors(zoom);
    case 'belt-dash':
    case 'cap-in-cell':
      return true;
  }
}

/**
 * Every cell where the property's subject is drawn and a requirement promises the property, in
 * boot order then zoom order.
 */
export function gradingCells(property: PropertyId): CaptureCell[] {
  const out: CaptureCell[] = [];
  for (const boot of CAPTURE_BOOTS) {
    for (const zoom of CAPTURE_ZOOMS) {
      if (!propertyGradedAt(property, zoom)) continue;
      out.push({ ...boot, zoom });
    }
  }
  return out;
}
