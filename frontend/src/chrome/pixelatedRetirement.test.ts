// pixelatedRetirement.test.ts (CHROME-02, plan 59-03) - the nearest-neighbour rendering
// hint is GONE from `frontend/src/chrome/`, because nothing under it is raster any more.
//
// THE RULE, AND WHY IT IS ABSOLUTE RATHER THAN ALLOWLISTED. `image-rendering: pixelated`
// asks the compositor not to smooth RASTER content: an `<img>`, a `<canvas>`, a
// `background-image`, an SVG `<image>`. On an inline `<svg>` of shapes, or on a
// solid-colour `<div>`, it does nothing at all. A declaration on a vector surface is
// therefore a stale line that READS AS INTENT: the next person to touch that component
// believes a raster contract exists and preserves it.
//
// 59-UI-SPEC'S RETIREMENT TABLE IS WRONG ON TWO ROWS, and the gate follows the rule
// rather than the wrong facts (the same call plan 59-01 made when a mechanical
// enumeration disagreed with a spec). The table says to KEEP the hint on
// `chrome/PortIndicator.tsx` because it is "still a baked matrix", and on the "Legend
// sprite <img>s" because they are "still baked matrices" and removing it "would soften
// real pixel art this phase is not replacing". MEASURED on the shipped tree:
//
//   - PortIndicator renders an inline `<svg>` with one `<circle>` and two `<rect>`s.
//     There is no matrix and no raster.
//   - Legend contains NO `<img>` elements at all - `grep -rn "<img" src/chrome/` is
//     empty. Its five swatches are inline `<svg>`s of `<rect>`s and solid-colour
//     `<span>`/`<div>`s.
//   - No module under `frontend/src/chrome/` references `matrixToPngDataUrl` or a
//     `data:image/png` source any more; plan 59-02 removed the last one, and plan
//     61-07 deleted the `matrixToPngDataUrl` module itself once its last consumer
//     anywhere in the tree went vector (see the RASTER_SOURCE docblock below).
//
// So the gate as drafted ("the hint appears only beside a baked-matrix source") could
// not be satisfied by ANY of the six surviving declarations, and the honest reading of
// its own stated purpose is that all six were exactly the stale line it exists to catch.
// They were deleted, and the full 166-case Playwright suite passed at zero pixel
// tolerance afterwards - which is the proof that they were inert, not an argument that
// they were. `shapeRendering: 'crispEdges'`, which is what actually hardens the edges on
// those swatches, is untouched. (Plan 91-10, CHROME-20: the Legend swatches still take it, UI-SPEC
// A19; the chrome ICONS no longer do. `icons.tsx`'s shared root style and `PortIndicator` take
// `geometricPrecision`, because at a fractional device scale a snapped glyph stops matching its
// mirror. Neither hint is the raster hint this file retires.)
//
// If a real raster surface ever returns to the chrome, this gate must be widened
// deliberately in a one-line diff, with the raster source named. That is the point.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `frontend/src/chrome/` - this spec lives in it. */
const CHROME_DIR = import.meta.dirname;

/** The hint in both spellings the tree can carry: CSS text and a React style object. */
const HINT = /image-rendering\s*:\s*pixelated|imageRendering\s*:\s*'pixelated'/g;

/**
 * A raster source: the only thing that could legitimately justify the hint.
 *
 * THE FIRST ALTERNATIVE CHANGED MEANING IN PLAN 61-07, AND THE CHANGE IS RECORDED HERE
 * RATHER THAN DISCOVERED LATER. `matrixToPngDataUrl` was a real module under
 * `render/synth/chrome/` when this regex was written, so the alternative asked "does
 * this chrome module reach the PixelMatrix -> PNG adapter?". That module is DELETED:
 * plan 61-07 re-pointed `spike/pixelGuard.tsx`'s belt surface at the shipped vector
 * corner, which was its last consumer anywhere in the tree, and a re-run grep over
 * `frontend/{src,shared,e2e,e2e-live}` found nothing but comments and this line.
 *
 * The alternative is KEPT, deliberately, and it is now a RESURRECTION guard: it names a
 * helper that no longer exists so that reintroducing one under that name puts a chrome
 * module into the raster set and reddens the premise case below. It is vacuous ON ITS
 * OWN - nothing can match a deleted name today - which is exactly why the regex's
 * non-vacuity has never rested on it: `data:image/png` and `<img` name live DOM
 * concepts, and the scanner's own fixtures at the foot of this file exercise both
 * directions of `hasRasterSource` against literal strings rather than against the tree.
 */
const RASTER_SOURCE = /matrixToPngDataUrl|data:image\/png|<img\b/;

/**
 * Blank `//` and block comments in place, preserving newlines and columns.
 *
 * LOAD-BEARING, not tidy: this phase's corrected docblocks deliberately QUOTE the
 * deleted declarations by name ("`imageRendering: 'pixelated'` WAS HERE and is deleted
 * by plan 59-03"), so a walker that measured prose would redden on the very comments
 * that record the retirement. The stripper is deliberately naive - it does not
 * understand string or regex literals - and that error direction can only produce a
 * false GREEN, never a false red, which is why the mutation below is not optional.
 */
function stripComments(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

export interface HintFinding {
  line: number;
  found: string;
  /** Whether the same module references a raster source the hint could apply to. */
  hasRasterSource: boolean;
}

/**
 * Scan one module's source for the hint. Exported as a PURE function of a string so the
 * same scanner that measures the shipped tree can be pointed at a fixture - which is
 * what makes both the RED mutation and the GREEN negative real assertions rather than
 * narrated ones.
 */
export function scanPixelatedHint(source: string): HintFinding[] {
  const src = stripComments(source);
  const hasRasterSource = RASTER_SOURCE.test(src);
  const out: HintFinding[] = [];
  for (const m of src.matchAll(HINT)) {
    out.push({ line: lineOf(src, m.index), found: m[0].trim(), hasRasterSource });
  }
  return out;
}

/** Every shipped `.ts` / `.tsx` module under `frontend/src/chrome/`, recursively. */
function chromeSourceFiles(dir = CHROME_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) out.push(...chromeSourceFiles(join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(`${prefix}${e.name}`);
    }
  }
  return out;
}

/**
 * THE FILE COUNT, as a stated literal - never `chromeSourceFiles().length`.
 *
 * The same vacuity refusal `bitMatrixIdiom.test.ts` and `lintSvg.test.ts` carry, and it
 * bites hardest on a walker proving an ABSENCE: a discovery that silently returned
 * nothing would report a clean pass over zero files. Edited by hand when a chrome module
 * is added. 39 -> 41 in plan 61-06 (`graphicsSettings.ts`, the storage adapter, and
 * `GraphicsPanel.tsx`, the panel itself). 41 -> 42 in plan 62-07 (the development pace
 * panel; it was a chrome source file even though it shipped in no bundle). 42 -> 43 in
 * plan 64-06 (`RefusalMessage.tsx`, the host-refusal message surface). 43 -> 44 in plan
 * 65-02 (`RouterConfigBody.tsx`, the Router rules editor body). 44 -> 45 in plan 68-02
 * (`BeltConfigBody.tsx`, the Belt pace segmented control). 45 -> 44 in plan 68-07, which
 * DELETED the development pace panel added at 62-07 along with the rest of the
 * development pace switch (BELT-05 / D-68-12). The deleted path is named in
 * `68-07-SUMMARY.md` and deliberately NOT named here: this file sits inside the scan set
 * of `scripts/check-dev-pace-switch-absent.sh`, which asserts that name appears zero
 * times anywhere in the tree. A `.test.ts` sibling is excluded by the walk, so one file
 * means one bump.
 *
 * THIS NUMBER IS TRUE AT EVERY WAVE, and that is why it moved twice inside this one
 * phase rather than once. But the two moves OFFSET EXACTLY, and that is the hazard
 * `68-UI-SPEC.md` 6.1 names: across phase 68 the count is net unmoved, so **a 68-07 that
 * shipped 68-02's addition and forgot 68-07's deletion would have left this walker and
 * `bitMatrixIdiom.test.ts` both GREEN at 45.** Neither walker can catch that omission;
 * the two history lines are what make the offsetting pair visible to a reader, and
 * `scripts/check-dev-pace-switch-absent.sh` is the check that actually catches it, which
 * is why that gate's non-vacuity prover is load-bearing for the user-interface half of
 * the removal too. Leaving the constant at 44 across the gap would ALSO have left both
 * walkers RED for three waves and made the frontend gate in plans 68-04, 68-05 and 68-06
 * unsatisfiable - so two real history entries, not one invisible offset that nets out.
 *
 * 44 -> 45 in plan 72-10 (`RouteConfigBody.tsx`, the Route's Path field and the
 * client-side path gate - the per-kind body every other configurable kind already has).
 * This move does NOT offset anything: 72-10 deletes no chrome source, so unlike the
 * 68-02/68-07 pair below it is a plain increment with one cause.
 *
 * 45 -> 46 in plan 73-04 (`LoadRefusedCard.tsx`, the card that says why a `.fab` file
 * will not open - UNDO-09). A plain increment with one cause: 73-04 deletes no chrome
 * source. Its `.test.tsx` sibling is NOT counted, per the exclusion above.
 *
 * 46 -> 47 in plan 80.1-01 (`HeaderLockup.tsx`, the component that renders the generated
 * header cut of the lockup - MARK-17). A plain increment with one cause: 80.1-01 deletes
 * no chrome source. Its emitted asset, `chrome/brand/fabrico-header.svg`, is NOT counted
 * and could not be: this walk filters `/\.tsx?$/`, so the whole `chrome/brand/`
 * subdirectory is invisible to it.
 *
 * 47 -> 48 in the 80.1 code review fix pass (`headerLockupMetrics.ts`, the ONE declaration
 * of the header lockup's shipped height, WR-01). A plain increment with one cause and no
 * offsetting deletion. It is a values module rather than a component, which is why it is
 * worth naming here: this walk counts chrome SOURCE FILES, not chrome components, so the
 * number moves for it exactly as it does for a new panel.
 *
 * 48 -> 49 in plan 74.1-19 (`portEditGrace.ts`, the controller that holds the pending
 * port-edit status back for its grace so a fast fold paints no text, re-walk J10). A
 * plain increment with one cause and no offsetting deletion; its `.test.ts` sibling is
 * not counted.
 *
 * 49 -> 51 in plan 76-02 (phase 76, labels): `LabelConfigBody.tsx`, the label panel's
 * Text field, and `LabelWords.tsx`, the DOM overlay that draws a label's words on the
 * board. Two plain increments, no offsetting deletion; their `.test.tsx` siblings are not
 * counted.
 *
 * 51 -> 52 in the plan 76-17 refuter round (`selectionEpoch.ts`, the counter App keys its
 * ConfigPanels on and gates their sends on, so a reminted handle number is not mistaken
 * for the old selection). A plain increment, no offsetting deletion; its `.test.ts`
 * sibling is not counted.
 *
 * 52 -> 53 in plan 77-04 (`hudCounts.ts`, `machineCountOf`, the HUD's machine count that
 * leaves labels out). A plain increment, no offsetting deletion; its `.test.ts` sibling is
 * not counted.
 *
 * 53 -> 52 on 2026-10-11, BY HAND: `LogoMark.tsx` deleted. The square's component had no
 * production consumer after MARK-17 (the header draws `HeaderLockup`), so it was retired
 * under the clean-break rule. A plain decrement, no offsetting addition; its deleted
 * `.test.tsx` sibling was never counted.
 *
 * 52 -> 53 in plan 85-06 (`sceneFit.ts`, `takeFit`, the rule that frames each loaded
 * board, DEMO-07). A plain increment, no offsetting deletion; its `.test.ts` sibling is
 * not counted.
 *
 * 53 -> 54 in plan 90-05 on 2026-10-23 (`configCopy.ts`, the config panel's not-applied
 * words, D-05). A plain increment, no offsetting deletion; its `.test.ts` sibling is not
 * counted.
 *
 * 54 -> 55 in plan 90-07 on 2026-10-24 (SimStoppedCard.tsx, the card a fatal sim error shows,
 * D-12). A plain increment, no offsetting deletion; its .test.tsx sibling is not counted.
 *
 * 55 -> 53 in plan 91-03 on 2026-10-24 (Hud.tsx and hudCounts.ts deleted, D-02): the
 * bottom-right readout and its machine count, removed with no replacement (CHROME-01). Two
 * plain decrements, no offsetting addition; the deleted hudCounts.test.ts was never counted.
 *
 * 53 -> 51 in plan 91-03 on 2026-10-24 (GraphicsPanel.tsx and graphicsSettings.ts deleted,
 * D-04): the Graphics panel and its belt step setting, removed with their trigger
 * (CHROME-03). Two plain decrements; their deleted test siblings were never counted.
 */
const EXPECTED_CHROME_SOURCE_FILES = 51;

describe('the nearest-neighbour rendering hint is retired from frontend/src/chrome', () => {
  const files = chromeSourceFiles();

  it('walks a non-empty, stated number of chrome source files', () => {
    expect(files).toHaveLength(EXPECTED_CHROME_SOURCE_FILES);
    // The walk reaches SUBDIRECTORIES; a scanner that stopped at the top level would
    // certify a directory it never opened.
    expect(files).toContain('assets/registry.ts');
    expect(files).toContain('PortIndicator.tsx');
    expect(files).toContain('Legend.tsx');
  });

  it('finds the hint in NO module, because no module under chrome/ is raster', () => {
    // MUTATION 7: add `imageRendering: 'pixelated'` to a chrome module with no baked
    // matrix -> this reddens, naming the file and line.
    const offenders: string[] = [];
    for (const rel of files) {
      for (const f of scanPixelatedHint(readFileSync(join(CHROME_DIR, rel), 'utf8'))) {
        offenders.push(
          `${rel}:${f.line}  ${f.found}  (raster source in this module: ${f.hasRasterSource})`,
        );
      }
    }
    expect(
      offenders,
      'A nearest-neighbour rendering hint is back under frontend/src/chrome. It acts on ' +
        'RASTER content only, and nothing here is raster: on an inline <svg> or a ' +
        'solid-colour element it does nothing and reads as intent. If a real raster ' +
        'surface has returned, widen this gate deliberately and name the source.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('confirms the premise executably: no chrome module references a raster source', () => {
    // This is the case that makes the absolute rule above HONEST rather than merely
    // convenient, and it is the one that reddens the day the premise stops holding -
    // at which point the gate must be widened with the raster source named, instead of
    // a stale hint quietly surviving beside it.
    const withRaster = files.filter((rel) =>
      RASTER_SOURCE.test(stripComments(readFileSync(join(CHROME_DIR, rel), 'utf8'))),
    );
    expect(
      withRaster,
      `These chrome modules reference a raster source: ${withRaster.join(', ')}. The gate ` +
        'above assumes none do.',
    ).toEqual([]);
  });
});

describe('the scanner fires on the hint and not on the prose that records its deletion', () => {
  it('fires on both spellings', () => {
    expect(scanPixelatedHint(`const s = { imageRendering: 'pixelated' };`)).toHaveLength(1);
    expect(scanPixelatedHint('.x { image-rendering: pixelated; }')).toHaveLength(1);
  });

  it('is quiet on a comment that NAMES the retired declaration (the required green negative)', () => {
    // The exact shape of the corrected docblocks this plan wrote. A walker that measured
    // these would make recording the retirement impossible.
    const doc = [
      "// `imageRendering: 'pixelated'` WAS HERE and is deleted by plan 59-03.",
      '/* image-rendering: pixelated is retired: nothing under chrome/ is raster. */',
      "// NOT `imageRendering: 'pixelated'`. There is no raster anywhere in this module.",
    ].join('\n');
    expect(scanPixelatedHint(doc)).toEqual([]);
  });

  it('reports whether the module carries a raster source, so a finding can be judged', () => {
    const withImg = `const url = 'data:image/png;base64,AA';\nconst s = { imageRendering: 'pixelated' };`;
    expect(scanPixelatedHint(withImg)[0].hasRasterSource).toBe(true);
    expect(scanPixelatedHint(`const s = { imageRendering: 'pixelated' };`)[0].hasRasterSource).toBe(
      false,
    );
  });
});
