// capture-mark-evidence.ts - the D-07 evidence capture for phase 79, plan 79-04.
//
// Writes nine PNGs of `mark-sheet.html` to `frontend/evidence/79/` so the verdict
// the reviewer records has file evidence a later reader can open without re-running anything,
// proves the sheet's central claim by measuring that a 16px tile really is 16 device
// pixels, and measures the two erasure properties per candidate.
//
// A STANDALONE SCRIPT, NOT A SPEC IN THE SUITE. Playwright's `testDir` is `./e2e`, so a
// capture spec would rewrite nine PNGs on every gate-4 run and leave churn in the working
// tree of a suite that is supposed to leave it clean. `@playwright/test` is already a
// devDependency and `chromium` drives fine from bare node, so this file imports it
// directly and owns its own browser lifecycle.
//
// EVERY CAPTURE CARRIES `scale: 'device'`, AND THE CONTEXT IS PINNED AT
// `deviceScaleFactor: 1`. Without `scale: 'device'` Playwright captures in CSS pixels and
// DOWNSAMPLES out of the device buffer. That is how the first generation of the four
// `logomark-dpr-*` baselines came back byte-identical across four different device pixel
// ratios: four files holding one image, under a claim they proved four renderings. The
// cost is recorded at `e2e/dpr-crispness.spec.ts:42-50` and is not repeated here. (Those
// four baselines were retired with `LogoMark.tsx` on 2026-10-11; the lesson stands.)
//
// THE HONESTY PROBE IS THE POINT OF THIS FILE, not a formality. Each column's
// `[data-tile="{col}-16-colour"]` is captured element-scoped and `magick identify`
// asserts it measures exactly 16 by 16. A 16px tile that captures at 20 or 32 device
// pixels means the phase's central claim was false and the whole sheet was judged at the
// wrong size. The probe runs over EVERY column including `b` and `shipped`, which both
// carry a failing verdict and therefore differ in chrome, and that is deliberate: a probe
// that skipped the failing columns would skip the only ones whose chrome differs. Plan
// 79-03 paints the failure rule on the column cell wrapper and never on the `data-tile`
// element, so the tile's border box stays exactly its declared size. If a probe tile ever
// returns 20 by 16, the bug is in the sheet's CSS and the fix is to move the rule back to
// the wrapper. Do not relax the probe, do not exclude the failing columns, and do not
// switch to a clipped region capture to work around it.
//
// GATES RUN BEFORE THE EVIDENCE IS WRITTEN, AND THE EVIDENCE IS PROMOTED, NOT STREAMED.
// Every capture lands in a scratch staging directory first. The measurement-pipeline
// self-test, the honesty probe and the erasure assertions all run and all throw from
// inside `captureEvidence` BEFORE anything is copied into `EVIDENCE_DIR`, and the
// promotion clears the directory so a file whose name has left `SHOTS` cannot survive as
// plausible-looking evidence. Ordering matters here: an earlier revision wrote all nine
// PNGs first and only then reported the probe, so a red run replaced the artefacts a human
// had already judged and the phase's own `ls *.png | wc -l -eq 9` check still passed over
// the wreckage. A run that fails now writes nothing at all, and the last green capture
// stays exactly as it was.
//
// EVERY CONSTANT IN THIS FILE IS ASSERTED, NOT NARRATED. `FULL_BLEED_SURVIVAL` and
// `SHIPPED_MARK_RESEARCH_ALPHA_COLOURS` are re-measured through this exact ImageMagick
// pipeline on synthetic extremes at the top of every run, and `RESEARCH_CROP_CONSTANT` is
// a value no column is allowed to report. A number that is only printed is a number
// nothing defends, and printing "the shipped mark measures 1, matching the research" out
// of a constant while the run measured 2 is how a file that hunts checks-that-cannot-fail
// grows one of its own.
//
// NO PATH INPUT, EVER (threat T-79-01). Every path is resolved from `import.meta.url`.
// This module reads no argv and no cwd, so `node frontend/scripts/capture-mark-evidence.ts`
// works from the repository root and from `frontend/` alike.
//
// ERASURE-ONLY TYPESCRIPT, the dialect stated at `scripts/lint-svg.ts:29-34`: interfaces,
// type aliases, annotations and `import type` only, an explicit `.ts` extension on every
// relative import, and no Vite-only import form.
//
// NO NEW DEPENDENCY. `@playwright/test` and the system ImageMagick are both already
// present; `79-RESEARCH.md`'s Package Legitimacy Audit records zero packages for this
// phase.

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/* ------------------------------------------------------------------ *
 * The exported contract
 * ------------------------------------------------------------------ */

/**
 * The generated sheet this capture photographs, kept as a URL as well as a path.
 * `file://${SHEET_PATH}` was string concatenation over a value `fileURLToPath` had just
 * percent-decoded: a checkout under a path holding `#` truncated at the fragment, a space
 * was at the mercy of Chromium's tolerance, and on Windows `file://C:\...` is not a URL at
 * all. The properly formed URL was already in hand, so it is what is kept and what
 * `page.goto` is given.
 */
const SHEET_URL = new URL('../mark-sheet.html', import.meta.url);
export const SHEET_PATH = fileURLToPath(SHEET_URL);

/**
 * Where the evidence lands: `frontend/evidence/NN/`, an ignored output
 * directory, so a capture run never leaves churn in the tracked tree.
 */
export const EVIDENCE_DIR = fileURLToPath(
  new URL('../evidence/79/', import.meta.url),
);

/** The five columns, in the order the sheet lays them out. */
export const COLUMNS: readonly string[] = ['a', 'b', 'c', 'd', 'shipped'];

/** One evidence file: its name and the section it is captured from. */
export interface EvidenceShot {
  /** File name under `EVIDENCE_DIR`, following the `NN-x-name.png` convention. */
  readonly file: string;
  /** The `data-section` value to capture, or null for the full-page shot. */
  readonly section: string | null;
}

/** The nine files `79-UI-SPEC.md` names, in its order. */
export const SHOTS: readonly EvidenceShot[] = [
  { file: '79-a-16px-colour.png', section: '16-colour' },
  { file: '79-b-16px-mono.png', section: '16-mono' },
  { file: '79-c-32px-colour.png', section: '32-colour' },
  { file: '79-d-32px-mono.png', section: '32-mono' },
  { file: '79-e-32px-silhouette.png', section: '32-silhouette' },
  { file: '79-f-96px-colour.png', section: '96-colour' },
  { file: '79-g-96px-mono.png', section: '96-mono' },
  { file: '79-h-craft-table.png', section: 'craft' },
  { file: '79-i-sheet-full.png', section: null },
];

/** What the two erasure commands measured for one column. */
export interface ErasureMeasurement {
  readonly column: string;
  /**
   * Unique colours in the alpha channel. One means the alpha is opaque everywhere and a
   * tray or menu-bar fill collapses the mark to a solid square. Two or more means the
   * silhouette carries real holes.
   */
  readonly alphaColours: number;
  /** Mean alpha over the whole tile before any crop. 1 means opaque everywhere. */
  readonly alphaMean: number;
  /**
   * The fraction of the mark's OWN opaque area that survives a crop to the inscribed
   * circle: `mean(alpha AND circle) / mean(alpha)`. null when the tile carries no ink at
   * all and there is nothing to lose. A mark whose identity is a full-bleed square reads
   * about 0.795; a mark drawn entirely inside the circle reads 1.
   */
  readonly circularCropSurvival: number | null;
}

/** What the honesty probe measured for one column. */
export interface TileProbe {
  readonly column: string;
  readonly width: number;
  readonly height: number;
}

/* ------------------------------------------------------------------ *
 * The measured values this run is compared against
 * ------------------------------------------------------------------ */

/**
 * `79-RESEARCH.md` section 6 measured the shipped mark through resvg at 96px and reported
 * one unique alpha colour (opaque everywhere) and `0.670382` surviving a circular crop.
 * Neither half is a claim this pipeline can restate, and the reason matters:
 * THE RESEARCH'S CROP COMMAND IS A CHECK THAT CANNOT FAIL.
 *
 * Its shape is `( +clone -alpha extract -fill black -colorize 100 -fill white -draw
 * circle ) -alpha off -compose CopyOpacity -composite`. `-colorize 100` fills the clone
 * solid black, throwing away the alpha it has just extracted, so the mask is the drawn
 * circle and nothing else; `CopyOpacity` then REPLACES the subject's alpha with that mask
 * rather than intersecting the two. The output describes the circle and never the mark.
 * Measured deliberately on the two extremes while writing this file: a fully transparent
 * 96x96 PNG and a fully opaque one both read `0.670382`, and so did all five columns of
 * this sheet on the first run of this script. `0.670382` is a constant, not a measurement
 * of the shipped mark, so no column of this sheet is allowed to report it.
 *
 * What this file measures instead is what the plan asks for in words: the fraction of the
 * mark's own opaque area that survives a crop to the inscribed circle. That discriminates,
 * measured on the same two extremes: a full-bleed opaque square reads 0.795222 and a mark
 * drawn inside the circle reads 1.000000. Report the number beside the tile and do NOT
 * turn it into a threshold: a mark whose identity is a full-bleed square loses everything
 * outside the circle, a mark drawn inside the circle loses nothing that matters, and the
 * useful thing is the comparison rather than a line nobody can defend.
 */
const RESEARCH_CROP_CONSTANT = 0.670382;

/**
 * The alpha-colour count of an alpha channel that is opaque everywhere, which is what
 * `79-RESEARCH.md` section 6 reported for the shipped mark through resvg.
 *
 * IT IS NOT A VALUE ANY COLUMN OF THIS SHEET SHOULD MATCH, and it is asserted as a floor
 * rather than as an equality. Chromium antialiases where resvg did not, so nothing here
 * reproduces the research reading directly; what does carry over is the meaning. A column
 * that reads exactly one alpha colour through THIS pipeline has an opaque alpha channel,
 * which is precisely what the background neutralisation below exists to prevent, so the
 * holes measurement would be a check that cannot fail. `assertMeasurementPipeline` proves
 * the reading is really 1 for an opaque frame before any column is trusted against it.
 */
const SHIPPED_MARK_RESEARCH_ALPHA_COLOURS = 1;

/**
 * A full-bleed opaque square measures this THROUGH THIS PIPELINE. It sits above the
 * inscribed circle's geometric share of a square frame (pi/4 = 0.785398) because
 * `-draw circle` antialiases its boundary and `Multiply` gives the roughly 300 perimeter
 * pixels partial credit. MEASURED WITH ANTIALIASING, NOT DERIVED: the number is specific
 * to this ImageMagick's rasteriser, and an ImageMagick whose `-draw` antialiasing differs
 * will move it. `assertMeasurementPipeline` re-measures it on every run for that reason.
 */
const FULL_BLEED_SURVIVAL = 0.795222;

/** A mark drawn strictly inside the inscribed circle loses nothing to the crop. */
const INSIDE_CIRCLE_SURVIVAL = 1;

/**
 * How far a re-measurement of the two extremes may drift before the run is refused. The
 * pipeline is deterministic for a given ImageMagick, so the honest tolerance is the
 * rounding in the six-decimal constants above plus a hair; anything that actually changes
 * `-draw` or `Multiply` semantics moves these numbers by percent, not by 1e-4.
 */
const PIPELINE_TOLERANCE = 5e-4;

/**
 * Below this mean alpha there is no ink in the tile and the survival ratio has no
 * numerator worth dividing. `alphaMean === 0` was an exact float comparison against a
 * value ImageMagick reports as `0.0000152588` for a tile holding one stray antialiased
 * pixel, so the `n/a (nothing to lose)` branch never fired and a ratio computed over a
 * handful of pixels was printed to six decimals beside four real measurements.
 * 1e-4 of a 96x96 frame is under one fully opaque pixel.
 */
const NOTHING_TO_LOSE = 1e-4;

/** The declared size of a 16px tile. The probe asserts the capture matches it exactly. */
const TILE_16 = 16;

/** The declared size of the erasure tile. The circle geometry is derived from it. */
const ERASURE_TILE = 96;

/**
 * The floor a capture's standard deviation has to clear to count as an image of anything.
 * A BYTE FLOOR CANNOT DO THIS JOB. PNG compresses a uniform frame to almost nothing, and
 * "almost nothing" at these dimensions is 434 bytes for a solid `#1b1f27` 1232x844 and
 * 1288 bytes for a solid 1401x5712, both comfortably over the 400-byte floor that used to
 * stand here claiming to catch "an empty capture". A blank frame has a standard deviation
 * of exactly 0; the nine real captures measure between 0.107 and 0.140.
 */
const MIN_STANDARD_DEVIATION = 0.01;

/** Kept as a cheap second check. It is not the one that can fail. */
const MIN_EVIDENCE_BYTES = 400;

/* ------------------------------------------------------------------ *
 * ImageMagick, the only rasteriser this file shells out to
 * ------------------------------------------------------------------ */

function magick(args: readonly string[]): string {
  return execFileSync('magick', args, { encoding: 'utf8' });
}

function identify(path: string): { width: number; height: number } {
  const out = execFileSync('magick', ['identify', '-format', '%wx%h', path], {
    encoding: 'utf8',
  }).trim();
  const parts = out.split('x');
  if (parts.length !== 2) throw new Error(`magick identify returned '${out}' for ${path}`);
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`magick identify returned '${out}' for ${path}`);
  }
  // The single place dimensions are parsed is the single place they are sanity-checked.
  // A caller-side `width < 1 || height < 1` guard was unreachable: every input that could
  // make it true has already thrown one line above.
  if (width < 1 || height < 1) {
    throw new Error(`magick identify returned '${out}' for ${path}, which has no pixels`);
  }
  return { width, height };
}

/**
 * Check 1 from `79-RESEARCH.md` section 6: does the silhouette carry real holes?
 * The enumeration header line starts with '#'; every other non-empty line is one colour.
 */
function countAlphaColours(png: string): number {
  const out = magick([png, '-alpha', 'extract', '-unique-colors', 'txt:']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#')).length;
}

function meanOf(png: string): number {
  const out = magick([png, '-format', '%[fx:mean]', 'info:']).trim();
  const mean = Number(out);
  if (!Number.isFinite(mean)) throw new Error(`mean read back as '${out}' for ${png}`);
  return mean;
}

function standardDeviationOf(png: string): number {
  const out = magick([png, '-format', '%[fx:standard_deviation]', 'info:']).trim();
  const sd = Number(out);
  if (!Number.isFinite(sd)) throw new Error(`standard deviation read back as '${out}' for ${png}`);
  return sd;
}

/**
 * Check 2 from `79-RESEARCH.md` section 6, with its command corrected for the reason
 * recorded above the constants: what fraction of the mark's OWN ink survives a crop to the
 * inscribed circle?
 *
 * The alpha channel is extracted, a black frame carrying a white inscribed circle is
 * multiplied into it, and the mean of the result is divided by the mean of the original.
 * `Multiply` INTERSECTS the two, where the research's `CopyOpacity` replaced one with the
 * other, and that is the whole difference between a number about the mark and a number
 * about the circle.
 *
 * THE CIRCLE IS DERIVED FROM THE FRAME, not hardcoded. `circle 47.5,47.5 47.5,-0.5` is the
 * inscribed circle of a 96x96 frame and of no other size; the guard that made that safe
 * lived at the one call site rather than in here, so a later phase pointing this helper at
 * a 32px silhouette tile would have drawn the same absolute circle almost entirely outside
 * the frame and filled a table with near-zero survivals without throwing.
 */
function circularCropSurvival(
  png: string,
  scratch: string,
): { alphaMean: number; survival: number | null } {
  const { width, height } = identify(png);
  if (width !== height) {
    throw new Error(`circular crop needs a square frame, got ${String(width)}x${String(height)}`);
  }
  const centre = (width - 1) / 2;
  const edge = centre - width / 2;
  const alpha = join(scratch, 'alpha.png');
  const masked = join(scratch, 'masked.png');
  magick([png, '-alpha', 'extract', alpha]);
  const alphaMean = meanOf(alpha);
  magick([
    alpha,
    '(',
    '+clone',
    '-fill',
    'black',
    '-colorize',
    '100',
    '-fill',
    'white',
    '-draw',
    `circle ${String(centre)},${String(centre)} ${String(centre)},${String(edge)}`,
    ')',
    '-compose',
    'Multiply',
    '-composite',
    masked,
  ]);
  const keptMean = meanOf(masked);
  return { alphaMean, survival: alphaMean < NOTHING_TO_LOSE ? null : keptMean / alphaMean };
}

/* ------------------------------------------------------------------ *
 * The gates
 * ------------------------------------------------------------------ */

/**
 * THE MEASUREMENT PIPELINE IS ITSELF MEASURED, before a single column is trusted.
 *
 * Three synthetic 96x96 tiles are drawn and pushed through the same helpers the columns
 * go through. The extremes are the whole reason the erasure numbers mean anything, and
 * until this ran they were three comments and three unasserted constants. An ImageMagick
 * that changes `-colorize`, `-draw` antialiasing or `Multiply` semantics, or an edit that
 * puts `CopyOpacity` back, moves at least one of these and reddens the run here rather
 * than filling the table with confident wrong numbers.
 */
function assertMeasurementPipeline(scratch: string): void {
  const centre = (ERASURE_TILE - 1) / 2;
  const inner = centre - ERASURE_TILE / 4;

  const opaque = join(scratch, 'extreme-full-bleed.png');
  magick([
    '-size',
    `${String(ERASURE_TILE)}x${String(ERASURE_TILE)}`,
    'xc:white',
    '-alpha',
    'set',
    '-channel',
    'A',
    '-evaluate',
    'set',
    '100%',
    '+channel',
    opaque,
  ]);
  const inside = join(scratch, 'extreme-inside-circle.png');
  magick([
    '-size',
    `${String(ERASURE_TILE)}x${String(ERASURE_TILE)}`,
    'xc:none',
    '-fill',
    'white',
    '-draw',
    `circle ${String(centre)},${String(centre)} ${String(centre)},${String(inner)}`,
    inside,
  ]);
  const empty = join(scratch, 'extreme-empty.png');
  magick([
    '-size',
    `${String(ERASURE_TILE)}x${String(ERASURE_TILE)}`,
    'xc:none',
    '-alpha',
    'set',
    '-channel',
    'A',
    '-evaluate',
    'set',
    '0%',
    '+channel',
    empty,
  ]);

  const opaqueColours = countAlphaColours(opaque);
  if (opaqueColours !== SHIPPED_MARK_RESEARCH_ALPHA_COLOURS) {
    throw new Error(
      `a fully opaque 96x96 alpha channel reads ${String(opaqueColours)} unique colours, not ` +
        `${String(SHIPPED_MARK_RESEARCH_ALPHA_COLOURS)}. The holes measurement reads an opaque ` +
        'alpha as that count, so every column threshold below it is meaningless.',
    );
  }

  const fullBleed = circularCropSurvival(opaque, scratch).survival;
  if (fullBleed === null || Math.abs(fullBleed - FULL_BLEED_SURVIVAL) > PIPELINE_TOLERANCE) {
    throw new Error(
      `a full-bleed opaque square survives the circular crop at ${String(fullBleed)}, not the ` +
        `recorded ${FULL_BLEED_SURVIVAL.toFixed(6)}. This constant is measured through this ` +
        'ImageMagick and nothing else, so either the mask geometry changed or the rasteriser ' +
        'did; re-measure the extremes before touching any column number.',
    );
  }

  const insideCircle = circularCropSurvival(inside, scratch).survival;
  if (
    insideCircle === null ||
    Math.abs(insideCircle - INSIDE_CIRCLE_SURVIVAL) > PIPELINE_TOLERANCE
  ) {
    throw new Error(
      `a disc drawn strictly inside the inscribed circle survives at ${String(insideCircle)}, ` +
        'not 1. The crop is erasing ink it should leave alone, which is the CopyOpacity ' +
        'failure mode this measurement replaced.',
    );
  }

  const nothing = circularCropSurvival(empty, scratch).survival;
  if (nothing !== null) {
    throw new Error(
      `a fully transparent tile reported a survival of ${String(nothing)} instead of nothing ` +
        'to lose. The empty-tile branch is what stops a tile that failed to paint reading as ' +
        'a measurement.',
    );
  }
}

/**
 * THE ERASURE TABLE HAS TO DISCRIMINATE, and until this ran nothing said so.
 *
 * The defect this whole measurement replaced was five columns reporting one identical
 * number, `0.670382`, under a paragraph explaining that identical numbers are the
 * signature of a check that cannot fail. That regression exited 0. It does not now.
 */
function assertErasureDiscriminates(erasure: readonly ErasureMeasurement[]): void {
  for (const measurement of erasure) {
    if (measurement.alphaColours <= SHIPPED_MARK_RESEARCH_ALPHA_COLOURS) {
      throw new Error(
        `column ${measurement.column} reads ${String(measurement.alphaColours)} alpha colour(s) ` +
          `and a mean alpha of ${measurement.alphaMean.toFixed(6)}: its alpha channel is opaque, ` +
          'so the background neutralisation missed and the holes check is blind. Compare the ' +
          "override's selector list against the class names build-mark-sheet.ts emits.",
      );
    }
  }

  const survivals: number[] = [];
  for (const measurement of erasure) {
    if (measurement.circularCropSurvival !== null) survivals.push(measurement.circularCropSurvival);
  }
  if (survivals.length !== erasure.length) {
    throw new Error(
      'a column reported no ink at all, so its tile did not paint and the sheet is not fit to ' +
        'be judged',
    );
  }
  if (new Set(survivals.map((s) => s.toFixed(6))).size < 2) {
    throw new Error(
      `every column reported the same circular-crop survival (${survivals[0].toFixed(6)}); that ` +
        'is the signature of a check that cannot fail, and it is the exact defect this ' +
        'measurement replaced. The likely causes are a mask that no longer intersects the ' +
        "mark's own alpha (a Multiply that became a CopyOpacity again) or an ImageMagick whose " +
        '-colorize semantics changed.',
    );
  }
  for (const measurement of erasure) {
    if (
      measurement.circularCropSurvival !== null &&
      measurement.circularCropSurvival.toFixed(6) === RESEARCH_CROP_CONSTANT.toFixed(6)
    ) {
      throw new Error(
        `column ${measurement.column} reported ${RESEARCH_CROP_CONSTANT.toFixed(6)}, which is ` +
          '79-RESEARCH.md section 6\'s constant rather than a measurement of anything: a fully ' +
          'transparent tile and a fully opaque one both read it. The crop command has ' +
          'regressed to the research shape.',
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * The capture
 * ------------------------------------------------------------------ */

export interface CaptureResult {
  readonly files: readonly string[];
  readonly probes: readonly TileProbe[];
  readonly erasure: readonly ErasureMeasurement[];
  readonly sheetUrl: string;
}

export async function captureEvidence(): Promise<CaptureResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'mark-evidence-'));
  // Everything is captured here and promoted to EVIDENCE_DIR only once every gate is
  // green, so a failing run cannot leave nine plausible files behind for the phase's own
  // `ls *.png | wc -l -eq 9` check to pass over.
  const staging = join(scratch, 'staging');
  mkdirSync(staging, { recursive: true });
  const sheetUrl = SHEET_URL.href;

  const browser = await chromium.launch();
  try {
    assertMeasurementPipeline(scratch);

    // THE CONTEXT IS PINNED. A capture at any other device pixel ratio would document a
    // rendering nobody looked at.
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(sheetUrl);
    await page.locator('#masthead').waitFor({ state: 'attached' });

    // The readout is `#dpr-readout` and NOT `[data-dpr]`: the live value is also mirrored
    // onto `document.documentElement`, which makes `<html>` the first match for a bare
    // attribute selector. Found by plan 79-03 and recorded in `79-03-SUMMARY.md`.
    const readout = page.locator('#dpr-readout');
    await readout.waitFor({ state: 'attached' });
    const reported = await readout.getAttribute('data-dpr');
    if (reported !== '1') {
      throw new Error(
        `the sheet reports devicePixelRatio ${String(reported)}, not 1, so the 16px row is ` +
          'being scaled and this capture would document a rendering nobody judged',
      );
    }

    // The sheet refuses to be voted on when it is stale, and it says so with this id.
    // Capturing evidence off a stale sheet would file a photograph of a page that is not
    // fit for the decision it is evidence for.
    if ((await page.locator('#stale-banner').count()) > 0) {
      throw new Error('the sheet carries #stale-banner and is not fit to be voted on');
    }

    // Fonts and the nearest-neighbour magnification both land after load. Wait for both,
    // or the evidence records a page mid-render.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForFunction(() => {
      const all = document.querySelectorAll('canvas[data-magnify]');
      const done = document.querySelectorAll('canvas[data-magnify][data-magnified]');
      return all.length > 0 && all.length === done.length;
    });

    // THE HONESTY PROBE, ahead of every capture. Into scratch, never into the evidence
    // directory: the nine section files are the evidence and the probe is a gate, and a
    // gate that reports after the artefacts are already on disk is a report, not a gate.
    const probes: TileProbe[] = [];
    for (const column of COLUMNS) {
      const path = join(scratch, `probe-${column}-16.png`);
      await page.locator(`[data-tile="${column}-16-colour"]`).screenshot({ path, scale: 'device' });
      const dims = identify(path);
      probes.push({ column, width: dims.width, height: dims.height });
    }
    const wrongSize = probes.filter((p) => p.width !== TILE_16 || p.height !== TILE_16);
    if (wrongSize.length > 0) {
      const measured = wrongSize
        .map((p) => `${p.column} at ${String(p.width)}x${String(p.height)}`)
        .join(', ');
      throw new Error(
        `a 16px tile did not capture at 16 by 16 device pixels (${measured}).\n` +
          'The bug is in the sheet CSS, not in this probe: move the failure rule off the\n' +
          'data-tile element and back onto the column cell wrapper. Do not relax the probe.',
      );
    }

    // THE TWO ERASURE MEASUREMENTS, on a SECOND page so the evidence PNGs stay pristine.
    // `omitBackground` removes Chromium's default page backdrop, not an author background,
    // and the sheet paints `#1b1f27` on `html`, `body` and every `.tile`. Left in place the
    // alpha channel would be opaque for every column and the holes check would be a check
    // that cannot fail. The override is scoped to the elements under the tile and changes
    // no geometry.
    const erasurePage = await context.newPage();
    await erasurePage.goto(sheetUrl);
    await erasurePage.locator('#masthead').waitFor({ state: 'attached' });
    await erasurePage.addStyleTag({
      content:
        'html, body, .section, .row, .col, .cell, .tile { background: transparent !important; }',
    });

    // AND THE OVERRIDE IS READ BACK, because that selector list is a hand-maintained copy
    // of class names `build-mark-sheet.ts` emits and nothing keeps the two in step. A
    // rename there would have left every column reading one alpha colour and a full mean,
    // reporting that all four candidates are solid squares with no holes: the opposite of
    // the truth, presented as a measurement. The walk goes up the ancestor chain because
    // an element screenshot is clipped out of the page, so an opaque wrapper paints into
    // the crop just as an opaque tile does.
    const painted = await erasurePage.evaluate(() => {
      const offenders: string[] = [];
      for (const tile of document.querySelectorAll('[data-tile]')) {
        for (let node: Element | null = tile; node !== null; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none') {
            offenders.push(
              `${String(tile.getAttribute('data-tile'))} under ${node.tagName.toLowerCase()}` +
                `.${node.className || '(no class)'} (${style.backgroundColor})`,
            );
            break;
          }
        }
      }
      return offenders;
    });
    if (painted.length > 0) {
      throw new Error(
        `the background override missed ${String(painted.length)} tile(s), so the holes check ` +
          `would be blind. First: ${String(painted[0])}. Reconcile the override's selector ` +
          'list with the class names build-mark-sheet.ts emits.',
      );
    }

    const erasure: ErasureMeasurement[] = [];
    for (const column of COLUMNS) {
      const path = join(scratch, `erasure-${column}-96.png`);
      await erasurePage
        .locator(`[data-tile="${column}-96-colour"]`)
        .screenshot({ path, omitBackground: true, scale: 'device' });
      const dims = identify(path);
      if (dims.width !== ERASURE_TILE || dims.height !== ERASURE_TILE) {
        throw new Error(
          `erasure tile ${column} captured at ${String(dims.width)}x${String(dims.height)}, ` +
            `not ${String(ERASURE_TILE)}x${String(ERASURE_TILE)}, so its circular crop is not ` +
            'comparable with the shipped measurement',
        );
      }
      const crop = circularCropSurvival(path, scratch);
      erasure.push({
        column,
        alphaColours: countAlphaColours(path),
        alphaMean: crop.alphaMean,
        circularCropSurvival: crop.survival,
      });
    }
    await erasurePage.close();
    assertErasureDiscriminates(erasure);

    // NINE SECTION CAPTURES, into staging.
    const staged: { readonly from: string; readonly file: string }[] = [];
    for (const shot of SHOTS) {
      const path = join(staging, shot.file);
      if (shot.section === null) {
        await page.screenshot({ path, fullPage: true, scale: 'device' });
      } else {
        await page
          .locator(`[data-section="${shot.section}"]`)
          .screenshot({ path, scale: 'device' });
      }
      const size = statSync(path).size;
      const dims = identify(path);
      const sd = standardDeviationOf(path);
      if (sd < MIN_STANDARD_DEVIATION) {
        throw new Error(
          `${shot.file} has a standard deviation of ${String(sd)}: it is a uniform frame, not a ` +
            'capture of anything. Every inlined SVG in that section failed to paint, or the ' +
            'section collapsed. A blank frame at these dimensions is well over any byte floor, ' +
            'so the file size cannot tell you this.',
        );
      }
      if (size < MIN_EVIDENCE_BYTES) {
        throw new Error(`${shot.file} is ${String(size)} bytes, that is an empty capture`);
      }
      staged.push({ from: path, file: shot.file });
      console.log(
        `  staged ${shot.file}  ${String(dims.width)}x${String(dims.height)} device px, ` +
          `${String(size)} bytes, sd ${sd.toFixed(6)}`,
      );
    }
    await context.close();

    // PROMOTION, the only write into EVIDENCE_DIR and the last thing that happens. The
    // directory is cleared first so a file whose name has left SHOTS cannot survive as
    // plausible-looking evidence of a rendering nobody produced.
    rmSync(EVIDENCE_DIR, { recursive: true, force: true });
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const files: string[] = [];
    for (const item of staged) {
      const path = join(EVIDENCE_DIR, item.file);
      copyFileSync(item.from, path);
      files.push(path);
    }

    return { files, probes, erasure, sheetUrl };
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * The optional dev server, which must never influence the exit code
 * ------------------------------------------------------------------ */

/** A dev server that answered, and the handle that shuts it and its Vite child down. */
interface DevServer {
  readonly url: string;
  readonly stop: () => void;
}

/**
 * Best effort only. Some restricted shells kill dev-server launches at signal 16,
 * so a failure here is expected rather than a sign of a broken build, and the evidence
 * route does not use the server at all. Letting a dev-server failure redden
 * `npm run capture:mark-evidence` would fail a verify over something the task does not
 * depend on, and a verify that goes red for an unrelated reason gets muted.
 *
 * THE TRY/CATCH IS NOT WHAT KEEPS THAT PROMISE. `spawn` does not throw synchronously when
 * a binary will not launch; it returns a ChildProcess and emits `'error'` asynchronously,
 * and an unhandled `'error'` event is thrown out of the event loop where no surrounding
 * catch can reach it. Any environment without `npm` on the spawned PATH exited 1 AFTER the
 * nine PNGs, the probe, the table and the success line had all printed. The listener below
 * is what makes the guarantee real, and it is attached before anything can fire.
 *
 * THE CHILD IS DETACHED SO IT CAN BE KILLED AS A GROUP. `npm run dev` forks Vite as a
 * grandchild and npm's signal forwarding is not something to rely on; a SIGTERM to npm
 * alone left Vite holding port 5173, where the next `npx playwright test` without `CI=1`
 * would silently attach to it and report success about code it never loaded.
 */
async function tryDevServer(): Promise<DevServer | null> {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  let child: ReturnType<typeof spawn> | null = null;
  const stop = (): void => {
    const target = child;
    child = null;
    if (target === null || target.exitCode !== null) return;
    if (target.pid !== undefined) {
      try {
        process.kill(-target.pid, 'SIGTERM');
        return;
      } catch {
        // no process group, or it is already gone; fall through to the direct signal
      }
    }
    try {
      target.kill('SIGTERM');
    } catch {
      // already gone
    }
  };
  try {
    child = spawn('npm', ['run', 'dev', '--', '--port', '5173', '--strictPort'], {
      cwd,
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {
      // Best effort only, and deliberately silent: this must never move the exit code.
    });
    child.unref();
    const url = 'http://127.0.0.1:5173/mark-sheet.html';
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        // The caller owns the shutdown from here: killing the server on the way out of
        // this function and then printing its URL as somewhere to go handed the one
        // person the sheet exists for a link that refuses the connection.
        if (response.ok) return { url, stop };
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    stop();
    return null;
  } catch {
    stop();
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log('capture-mark-evidence: Chromium, deviceScaleFactor 1, scale device\n');
  const result = await captureEvidence();

  console.log('\nHONESTY PROBE - every column\'s 16px colour tile, element-scoped');
  console.log('  column     measured   expected');
  for (const probe of result.probes) {
    const measured = `${String(probe.width)}x${String(probe.height)}`;
    console.log(
      `  ${probe.column.padEnd(10)} ${measured.padEnd(10)} ${String(TILE_16)}x${String(TILE_16)}` +
        '   OK',
    );
  }

  console.log('\nERASURE - measured on each column\'s 96px colour tile, alpha kept');
  console.log('  column     alpha colours   alpha mean   circular crop survival');
  for (const measurement of result.erasure) {
    const survival =
      measurement.circularCropSurvival === null
        ? 'n/a (nothing to lose)'
        : measurement.circularCropSurvival.toFixed(6);
    console.log(
      `  ${measurement.column.padEnd(10)} ${String(measurement.alphaColours).padEnd(15)} ` +
        `${measurement.alphaMean.toFixed(6)}     ${survival}`,
    );
  }
  const shipped = result.erasure.find((m) => m.column === 'shipped');
  console.log(
    '\n  HOLES. One alpha colour means the alpha is opaque everywhere and a tray or\n' +
      '  menu-bar fill collapses the mark to a solid square. Two or more means the\n' +
      '  silhouette carries real holes. The shipped mark measures ' +
      `${shipped === undefined ? 'nothing (no shipped column)' : String(shipped.alphaColours)}` +
      ' here.\n' +
      `  79-RESEARCH.md section 6 reports ${String(SHIPPED_MARK_RESEARCH_ALPHA_COLOURS)} for it\n` +
      '  through resvg, which antialiases where Chromium does not; the two are not the\n' +
      '  same measurement and this run does not claim they are. What is asserted is that\n' +
      `  no column reads ${String(SHIPPED_MARK_RESEARCH_ALPHA_COLOURS)}, because through THIS\n` +
      '  pipeline that count means an opaque alpha channel and a blind holes check.\n' +
      '\n  CIRCULAR CROP SURVIVAL. The fraction of the mark\'s own opaque area left after a\n' +
      '  crop to the inscribed circle. A full-bleed opaque square reads ' +
      `${FULL_BLEED_SURVIVAL.toFixed(6)},\n` +
      '  re-measured through this ImageMagick at the top of this run; it sits above the\n' +
      '  circle\'s geometric share of a square frame (pi/4 = 0.785398) because -draw circle\n' +
      '  antialiases its boundary. A mark drawn inside the circle reads 1.000000. It is a\n' +
      '  comparison, not a threshold.\n' +
      `\n  79-RESEARCH.md section 6 reports ${RESEARCH_CROP_CONSTANT.toFixed(6)} here, and THAT NUMBER IS\n` +
      '  A CONSTANT rather than a measurement: its command discards the extracted alpha\n' +
      '  with -colorize 100, then replaces the subject\'s alpha with the drawn circle, so\n' +
      '  it describes the circle and never the mark. A fully transparent 96x96 PNG and a\n' +
      '  fully opaque one both read it. Corrected here, recorded as a finding, and now\n' +
      '  asserted: no column of this sheet is allowed to report it.',
  );

  console.log(`\nThe sheet, the route that always works:\n  ${result.sheetUrl}`);

  const dev = await tryDevServer();
  if (dev !== null) {
    dev.stop();
    console.log(
      'A dev server also answered on 127.0.0.1:5173 just now and has been shut down again,\n' +
        'because leaving Vite holding that port is how a later playwright test attaches to a\n' +
        'stale server. To read the sheet over http instead of file://, run it yourself:\n' +
        '  npm run dev -- --port 5173 --strictPort\n' +
        '  then open http://127.0.0.1:5173/mark-sheet.html',
    );
  } else {
    console.log(
      'The optional dev-server launch did not answer. Expected in a restricted shell that\n' +
        'kills dev-server launches at signal 16, and it is not a failure of\n' +
        'this capture: the evidence route does not use the server at all.',
    );
  }

  console.log(`\n${String(result.files.length)} evidence PNGs in frontend/evidence/79/`);
}

try {
  await main();
} catch (error) {
  // `process.exitCode` and not `process.exit`: when stdout is a pipe rather than a TTY,
  // Node writes asynchronously and `process.exit` does not flush, so the explanation of
  // what to do about the failure is exactly the output most likely to be lost under
  // `npm run -s` in a captured shell.
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error('\nNothing was written to frontend/evidence/79/; the last green capture, if\n' +
    'there is one, is untouched.');
  process.exitCode = 1;
}
