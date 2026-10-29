// mark-sheet.spec.ts - the assertions that stop the Phase 79 comparison sheet lying about
// itself (MARK-01, plan 79-03).
//
// WHAT IS ACTUALLY BEING TESTED HERE. MARK-01's deliverable is a human decision, so no test
// can assert the verdict. What these seven cases assert is the INSTRUMENT: that the sheet the reviewer
// votes on is trustworthy. A sheet that renders a candidate wrong, hides a craft failure, or
// silently drops a column produces a verdict about a rendering bug rather than about a mark,
// and that verdict then steers four more phases.
//
// THE DEVICE PIXEL RATIO IS PINNED IN THE CONTEXT, not inherited from the host display
// density, exactly as `art-board.spec.ts:152` and `dpr-crispness.spec.ts:98` both do. Without
// it the tile-size assertions would be measuring this machine rather than the page.
//
// NO SNAPSHOT BASELINE, DELIBERATELY. This sheet is a one-phase artefact. The four
// `logomark-dpr-*` baselines are the only mark baselines in the tree and they re-bless exactly
// once, in Phase 80; a ninth image baseline here would put a second re-bless in Phase 80's
// path. Everything worth asserting about this page is structural.
//
// UPDATE 2026-10-11: the four `logomark-dpr-*` baselines were retired with `LogoMark.tsx`,
// because the square is no longer rendered in the app. The brand baselines in the tree are
// now the four `header-lockup-dpr-*` images; the square's geometry stays guarded by
// `iconMasterParity.test.ts` and `markSheet.test.ts`'s byte comparison (the icon raster pins
// guard the master, not the square). The decision above is unchanged.
//
// THIS FILE IS TYPECHECKED. `frontend/tsconfig.json` includes `e2e`, added 2026-08-31 after
// the gap where `npx tsc --noEmit` covered zero Playwright specs.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

/* ==================================================================== *
 * The sheet's own contract, mirrored as literals
 * ==================================================================== */

/**
 * The ten sections in the order the generator emits them, which is the reading order.
 *
 * Mirrored here as literals rather than imported from `scripts/build-mark-sheet.ts`,
 * deliberately: a spec that imports its expectations from the thing it is testing asserts only
 * that the module is self-consistent. A drift between this list and the generator IS a finding.
 */
const SECTION_ORDER: readonly string[] = [
  '16-colour',
  '16-mono',
  '32-colour',
  '32-mono',
  '32-silhouette',
  '96-colour',
  '96-mono',
  'craft',
  'verdict',
  '16-colour-repeat',
];

/** The eight sections that render tiles, with the size and tile-id suffix each one uses. */
interface RenderSection {
  id: string;
  size: 16 | 32 | 96;
  suffix: string;
}

const RENDER_SECTIONS: readonly RenderSection[] = [
  { id: '16-colour', size: 16, suffix: 'colour' },
  { id: '16-mono', size: 16, suffix: 'mono' },
  { id: '32-colour', size: 32, suffix: 'colour' },
  { id: '32-mono', size: 32, suffix: 'mono' },
  { id: '32-silhouette', size: 32, suffix: 'silhouette' },
  { id: '96-colour', size: 96, suffix: 'colour' },
  { id: '96-mono', size: 96, suffix: 'mono' },
  { id: '16-colour-repeat', size: 16, suffix: 'repeat' },
];

/** Five columns, in this order, in every render section. `shipped` is a reference, not a candidate. */
const COLUMNS: readonly string[] = ['a', 'b', 'c', 'd', 'shipped'];

/** The four candidates. Candidate D is in this list because D is a peer (D-02), not an appendix. */
const CANDIDATE_COLUMNS: readonly string[] = ['a', 'b', 'c', 'd'];

/** `--fab-destructive` `#f0506e` as Chromium serialises it. Page chrome for failure, nowhere else. */
const DESTRUCTIVE_RGB = 'rgb(240, 80, 110)';

/** The failing-candidate rule, in CSS px. Painted on the column cell wrapper, never on a tile. */
const FAILURE_RULE_PX = 4;

/**
 * D-14's five advocacy tokens, widened by D-17's eight. Thirteen, lower-case, matched by
 * SUBSTRING so `preferred` and `defaulted` are caught too.
 *
 * Mirrored as literals from `e2e/art-board.spec.ts:2226-2240` rather than imported, for the
 * same reason that file states: the two halves of the gate are meant to be independently
 * readable, and a drift between this list, that one and `scripts/check-neutrality.sh` IS a
 * finding.
 *
 * THE RESOLUTION OF A RED SCAN IS ALWAYS A REWORDING OF THE SHEET COPY AND NEVER A SHORTENING
 * OF THIS LIST. That is the documented failure mode, and on this sheet it matters more than
 * anywhere else in the tree: the vote is the reviewer's, and a nudge in the copy corrupts it.
 */
const BANNED_TOKENS: readonly string[] = [
  'recommend',
  'we suggest',
  'best option',
  'prefer',
  'default',
  'winner',
  'strongest',
  'should',
  'obviously',
  'pick',
  'clearly',
  'the right',
  'the obvious',
];

/**
 * The non-vacuity floor for the token scan. AN EMPTY SCAN IS A FAILURE.
 *
 * 900 is a floor, not a measurement. MEASURED on a clean tree the sheet renders **12 950
 * characters** of body text - the masthead and its four rule statements, forty column headers
 * and verdict chips, seventy tile captions, five findings repeated across three 16px sections,
 * the monochrome loss lines, the eight-row craft table and its fourteen why-clauses - so the
 * floor sits at about 7% of the real corpus and is nowhere near it. Anything that collapses the
 * sheet below this has broken, and a scan over the wreckage must not report a clean result.
 *
 * Following the `MIN_BOARD_TEXT_CHARS` idiom at `e2e/art-board.spec.ts:2249`.
 */
const MIN_SHEET_TEXT_CHARS = 900;

/**
 * The non-vacuity floor for the content-digest walk. Seventy tiles carry a digest today; a walk
 * that found three would report a clean result over almost nothing.
 */
const MIN_DIGESTS = 35;

/* ==================================================================== *
 * Paths on disk, for the content-digest half
 * ==================================================================== */

const CANDIDATES_DIR = fileURLToPath(
  new URL('../scripts/mark-candidates/', import.meta.url),
);
const SHIPPED_MARK = fileURLToPath(new URL('../src/chrome/assets/logomark.svg', import.meta.url));

function sourcePath(file: string): string {
  return file === 'logomark.svg' ? SHIPPED_MARK : join(CANDIDATES_DIR, file);
}

/* ==================================================================== *
 * The harness
 * ==================================================================== */

interface OpenSheet {
  page: Page;
  close: () => Promise<void>;
}

/**
 * Open the sheet with the device pixel ratio PINNED at 1.
 *
 * The page prints its own live `devicePixelRatio` for a human reader, because that is a
 * property of the reader's browser and desktop scaling rather than of the page. Here it is
 * pinned, so `16px, 1:1 - this is what you get` is a claim the test can hold the page to.
 */
async function openSheet(browser: Browser): Promise<OpenSheet> {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto('/mark-sheet.html');
  await page.locator('#masthead').waitFor({ state: 'attached' });
  return { page, close: async (): Promise<void> => context.close() };
}

async function sectionIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section') ?? ''),
  );
}

/* ==================================================================== *
 * 1. 16px first
 * ==================================================================== */

test('mark sheet: 16px first - the 16px colour row is the first render on the page', async ({
  browser,
}) => {
  const { page, close } = await openSheet(browser);
  try {
    const ids = await sectionIds(page);

    // Read off the LIVE page, never off the file: a section the browser refuses to build is
    // still in the HTML, and the reading order that matters is the one a reader gets.
    expect(
      ids,
      'the sheet renders its ten sections in the locked reading order, 16px colour first and a ' +
        'repeat of it last',
    ).toEqual(SECTION_ORDER);

    const before = await page.evaluate(() => {
      const first = document.querySelector('[data-section]');
      if (first === null) return null;
      const preceding: string[] = [];
      for (const child of [...document.body.children]) {
        if (child === first || child.contains(first)) break;
        preceding.push(child.id === '' ? child.tagName.toLowerCase() : `#${child.id}`);
      }
      return preceding;
    });

    expect(
      before,
      'nothing precedes the 16px colour row but the masthead - success criterion 1 is that the ' +
        '16px row is what the reviewer sees first, above the fold',
    ).toEqual(['#masthead']);
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * 2. peer
 * ==================================================================== */

interface ColumnMetrics {
  order: string[];
  widths: Record<string, number>;
  headFontSizes: Record<string, string>;
  headFontWeights: Record<string, string>;
  tiles: Record<string, [number, number] | null>;
  dInsideC: boolean;
}

async function readColumns(page: Page, section: RenderSection): Promise<ColumnMetrics> {
  return page.evaluate(
    ({ id, size, suffix }) => {
      const root = [...document.querySelectorAll('[data-section]')].find(
        (s) => s.getAttribute('data-section') === id,
      );
      if (root === undefined) throw new Error(`section ${id} is absent from the live page`);
      const columns = [...root.querySelectorAll('[data-column]')];
      const widths: Record<string, number> = {};
      const headFontSizes: Record<string, string> = {};
      const headFontWeights: Record<string, string> = {};
      const tiles: Record<string, [number, number] | null> = {};
      for (const column of columns) {
        const key = column.getAttribute('data-column') ?? '';
        widths[key] = Math.round(column.getBoundingClientRect().width);
        const name = column.querySelector('.col-name');
        const style = name === null ? null : getComputedStyle(name);
        headFontSizes[key] = style === null ? 'absent' : style.fontSize;
        headFontWeights[key] = style === null ? 'absent' : style.fontWeight;
        const tile = root.querySelector(`[data-tile="${key}-${size}-${suffix}"]`);
        if (tile === null) {
          tiles[key] = null;
        } else {
          const box = tile.getBoundingClientRect();
          tiles[key] = [Math.round(box.width), Math.round(box.height)];
        }
      }
      const c = root.querySelector('[data-column="c"]');
      const d = root.querySelector('[data-column="d"]');
      return {
        order: columns.map((column) => column.getAttribute('data-column') ?? ''),
        widths,
        headFontSizes,
        headFontWeights,
        tiles,
        dInsideC: c !== null && d !== null && c.contains(d),
      };
    },
    { id: section.id, size: section.size, suffix: section.suffix },
  );
}

test('mark sheet: peer - five columns of identical chrome, Candidate D never subordinated', async ({
  browser,
}) => {
  const { page, close } = await openSheet(browser);
  try {
    // BOTH WIDTHS, because the overflow backstop is exactly the case where a tile silently
    // shrinks to make five columns fit. A pass at 1920 alone would prove nothing about 1280.
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1000 });

      for (const section of RENDER_SECTIONS) {
        const m = await readColumns(page, section);
        const where = `${section.id} at ${width}px`;

        expect(m.order, `${where}: five columns in the locked order, none dropped`).toEqual(COLUMNS);

        // D-02, ENFORCED BY CONSTRUCTION. If the reviewer names D, that one answer settles both the
        // route and the drawing style. Naming the route C and D share is honest; giving D a
        // narrower column, a smaller tile, a lighter header or a nested position is not.
        const candidateWidths = CANDIDATE_COLUMNS.map((c) => m.widths[c]);
        expect(
          new Set(candidateWidths).size,
          `${where}: A, B, C and D have one column width between them, got ${JSON.stringify(m.widths)}`,
        ).toBe(1);
        expect(
          new Set(COLUMNS.map((c) => m.headFontSizes[c])).size,
          `${where}: every column header is set at one size, got ${JSON.stringify(m.headFontSizes)}`,
        ).toBe(1);
        expect(
          new Set(COLUMNS.map((c) => m.headFontWeights[c])).size,
          `${where}: every column header is set at one weight, got ${JSON.stringify(m.headFontWeights)}`,
        ).toBe(1);
        expect(
          m.dInsideC,
          `${where}: Candidate D is a sibling of Candidate C, never a tile nested inside it`,
        ).toBe(false);

        // THE TILE IS THE SIZE UNDER TEST. A 16px tile that measures anything but 16 by 16 makes
        // the caption "16px, 1:1 - this is what you get" a claim the page cannot back up, and
        // plan 79-04's element-scoped honesty probe would go red for the same reason.
        for (const column of COLUMNS) {
          expect(
            m.tiles[column],
            `${where}: column ${column}'s tile is exactly ${section.size} by ${section.size} CSS px, ` +
              'neither shrunk to fit nor grown by a border on the tile itself',
          ).toEqual([section.size, section.size]);
        }
      }
    }
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * 3. monochrome
 * ==================================================================== */

test('mark sheet: monochrome - every mono tile is the same markup as its colour twin', async ({
  browser,
}) => {
  const { page, close } = await openSheet(browser);
  try {
    const ids = await sectionIds(page);
    for (const [colour, mono] of [
      ['16-colour', '16-mono'],
      ['32-colour', '32-mono'],
      ['96-colour', '96-mono'],
    ]) {
      expect(
        ids.indexOf(mono as string),
        `${mono} sits directly beneath ${colour}, so the comparison is a glance rather than a scroll`,
      ).toBe(ids.indexOf(colour as string) + 1);
    }

    const compared = await page.evaluate(
      ({ columns, sizes }) => {
        const rows: { column: string; size: number; equal: boolean; found: boolean }[] = [];
        for (const size of sizes) {
          for (const column of columns) {
            const colour = document.querySelector(`[data-tile="${column}-${size}-colour"] svg`);
            const mono = document.querySelector(`[data-tile="${column}-${size}-mono"] svg`);
            rows.push({
              column,
              size,
              found: colour !== null && mono !== null,
              equal: colour !== null && mono !== null && colour.outerHTML === mono.outerHTML,
            });
          }
        }
        return rows;
      },
      { columns: [...COLUMNS], sizes: [16, 32, 96] },
    );

    // NON-VACUITY FIRST. A walk that found no tiles would report no inequalities.
    expect(
      compared.filter((row) => row.found).length,
      'every colour tile and every monochrome tile was found, so the equality below is measured ' +
        'over a real corpus rather than over nothing',
    ).toBe(COLUMNS.length * 3);

    // THIS IS THE PROOF THAT THE MONOCHROME CUT IS A TOKEN REMAP AND NOT A SECOND SET OF
    // DRAWINGS. If the two markups are byte-identical then the geometry cannot differ, and a
    // candidate cannot be quietly redrawn to survive its own monochrome section.
    expect(
      compared.filter((row) => !row.equal).map((row) => `${row.column}-${row.size}`),
      'each monochrome tile holds the SAME inlined SVG node as its colour twin - a difference ' +
        'here means the mono cut is a second drawing and the geometry claim is unfounded',
    ).toEqual([]);
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * 4. failing
 * ==================================================================== */

interface FailureReadout {
  failing: string[];
  chipText: Record<string, string>;
  treated: Record<string, string[]>;
  untreated: string[];
}

async function readFailures(page: Page, sections: readonly string[]): Promise<FailureReadout> {
  return page.evaluate(
    ({ ids, rulePx, rgb }) => {
      const first = [...document.querySelectorAll('[data-section]')].find(
        (s) => s.getAttribute('data-section') === '16-colour',
      );
      if (first === undefined) throw new Error('the 16px colour section is absent');
      const failing: string[] = [];
      const chipText: Record<string, string> = {};
      for (const chip of first.querySelectorAll('[data-verdict]')) {
        const column = chip.closest('[data-column]');
        if (column === null) continue;
        const key = column.getAttribute('data-column') ?? '';
        if (chip.getAttribute('data-verdict') === 'pass') continue;
        failing.push(key);
        chipText[key] = (chip as HTMLElement).innerText;
      }

      const treated: Record<string, string[]> = {};
      const untreated: string[] = [];
      for (const key of failing) {
        treated[key] = [];
        for (const id of ids) {
          const section = [...document.querySelectorAll('[data-section]')].find(
            (s) => s.getAttribute('data-section') === id,
          );
          if (section === undefined) continue;
          const cell = section.querySelector(`[data-column="${key}"] .cell`);
          if (cell === null) {
            untreated.push(`${key} has no cell in ${id}`);
            continue;
          }
          if (cell.getAttribute('data-failure-rule') !== '1') {
            untreated.push(`${key} in ${id} carries no failure rule`);
            continue;
          }
          const style = getComputedStyle(cell);
          if (style.borderLeftWidth !== `${rulePx}px` || style.borderLeftColor !== rgb) {
            untreated.push(
              `${key} in ${id} paints ${style.borderLeftWidth} ${style.borderLeftColor}`,
            );
            continue;
          }
          // And the rule must NOT be on the tile: a border there changes the border box, and
          // an element-scoped screenshot would then measure a 16px tile as 20 by 16.
          const tile = section.querySelector(`[data-column="${key}"] [data-tile]`);
          if (tile !== null && getComputedStyle(tile).borderLeftWidth !== '0px') {
            untreated.push(`${key} in ${id} paints the rule on the tile rather than the cell`);
            continue;
          }
          (treated[key] as string[]).push(id);
        }
      }
      return { failing, chipText, treated, untreated };
    },
    { ids: [...sections], rulePx: FAILURE_RULE_PX, rgb: DESTRUCTIVE_RGB },
  );
}

test('mark sheet: failing - a candidate that fails carries the named rule on every tile', async ({
  browser,
}) => {
  const { page, close } = await openSheet(browser);
  try {
    const renderIds = RENDER_SECTIONS.map((s) => s.id);
    const readout = await readFailures(page, renderIds);

    // DERIVED FROM THE PAGE, NEVER HARDCODED, and asserted non-empty FIRST. A sheet on which
    // nothing failed would satisfy every loop below without executing one of them, and that is
    // the vacuous pass this case exists to refuse.
    //
    // WHERE THE FAILING COLUMN COMES FROM, CORRECTED IN PLACE (plan 80-05). This paragraph
    // used to end: "The shipped column is on the sheet partly for this reason: it fails three
    // of the four rules, so there is always at least one visibly failing column." That was
    // true of the Phase 59 mark and stopped being true in the commit that replaced it: the
    // shipped column now measures PASS on all four rules and contributes no failing chip at
    // all. This case did not lose its subject, because it never depended on that column
    // alone - Candidate B's `b-the-turn-16.svg` measures R4 OVERLAP with one touching pair,
    // and that column is untouched by Phase 80. Measured after the replacement: the sheet
    // still carries failing chips, and the assertion below is what says so rather than this
    // comment.
    expect(
      readout.failing,
      'at least one column measured a non-PASS verdict - with the shipped mark on the sheet a ' +
        'clean sweep means the craft measurement stopped running, not that everything passed',
    ).not.toEqual([]);

    for (const column of readout.failing) {
      // Never a bare icon and never a bare colour: read in greyscale the words still say which
      // rule went, which is what makes the chip legible to a reader who cannot see the fill.
      expect(
        readout.chipText[column],
        `column ${column}'s chip names the rule it failed in text, not by colour alone`,
      ).toMatch(/R[1-4] (shapes|axis|diagonal|gap)/);
    }

    expect(
      readout.untreated,
      'the failing rule travels with the candidate through EVERY section, colour and ' +
        'monochrome, 16px through 96px - not only in the table at the foot of the page',
    ).toEqual([]);

    for (const column of readout.failing) {
      expect(
        readout.treated[column],
        `column ${column} carries its failure treatment in all eight render sections`,
      ).toEqual(renderIds);
    }
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * 5. neutrality
 * ==================================================================== */

interface NeutralityReadout {
  textLength: number;
  tokenHits: string[];
}

async function readNeutrality(page: Page): Promise<NeutralityReadout> {
  return page.evaluate((tokens) => {
    const text = document.body.innerText.toLowerCase();
    const tokenHits: string[] = [];
    for (const token of tokens) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(token, from);
        if (at === -1) break;
        // Report the token AND its context, so a red gate is a rewording job rather than a hunt
        // through seventy tiles.
        tokenHits.push(`"${token}" @${at}: ...${text.slice(Math.max(0, at - 40), at + 40)}...`);
        from = at + token.length;
      }
    }
    return { textLength: text.length, tokenHits };
  }, BANNED_TOKENS as string[]);
}

test('mark sheet: neutrality - no advocacy token appears in the rendered text', async ({
  browser,
}) => {
  const { page, close } = await openSheet(browser);
  try {
    const neutrality = await readNeutrality(page);

    // THE NON-VACUITY HALF, FIRST. A scan over an empty corpus reports zero hits and would
    // otherwise be the cleanest result this gate can produce.
    expect(
      neutrality.textLength,
      'the sheet rendered real text for the scan to run over - an empty scan is a FAILURE, never ' +
        'a vacuous pass',
    ).toBeGreaterThan(MIN_SHEET_TEXT_CHARS);

    // Report-all, never first-fail. And the resolution is a rewording of the sheet copy: the
    // sheet describes and measures, it does not recommend, and the vote is the reviewer's.
    expect(
      neutrality.tokenHits,
      'no advocacy token from D-14 as widened by D-17 appears anywhere in the text a reader sees',
    ).toEqual([]);
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * 6. dpr readout
 * ==================================================================== */

test('mark sheet: dpr readout - the page states its own device pixel ratio', async ({ browser }) => {
  const { page, close } = await openSheet(browser);
  try {
    const readout = await page.evaluate(() => {
      const element = document.getElementById('dpr-readout');
      if (element === null) return null;
      return {
        text: element.innerText,
        attribute: element.getAttribute('data-dpr'),
        mirrored: document.documentElement.getAttribute('data-dpr'),
      };
    });

    expect(readout, 'the masthead carries a device pixel ratio readout').not.toBeNull();
    expect(
      (readout as { text: string }).text.length,
      'the readout is not empty - a blank readout is the same as no readout at all',
    ).toBeGreaterThan(0);

    // THE HONESTY CHECK FOR THE CAPTION ON EVERY 16px TILE. `devicePixelRatio` is a property of
    // the reader's browser and desktop scaling rather than of the page, so a 16px tile is 16
    // DEVICE pixels only at ratio 1. Pinned here; the page reddens for a human when it is not.
    expect(
      (readout as { attribute: string | null }).attribute,
      'under a context pinned to deviceScaleFactor 1 the readout reads 1, so the page can back ' +
        'up its own "16px, 1:1 - this is what you get" caption',
    ).toBe('1');
    expect(
      (readout as { mirrored: string | null }).mirrored,
      'the live ratio is mirrored onto the document element, which is where plan 79-04 reads it',
    ).toBe('1');
    expect(
      (readout as { text: string }).text,
      'at ratio 1 the readout says so rather than warning about scaling',
    ).not.toContain('not 1');
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * 7. not stale
 * ==================================================================== */

test('mark sheet: not stale - no expectations mismatch and every drawing matches its digest', async ({
  browser,
}) => {
  const { page, close } = await openSheet(browser);
  try {
    // DEVICE 4. A sheet that cannot detect its own staleness is a check that cannot fail. When
    // the measured verdicts disagree with `mark-craft.expected.json` the generator emits this
    // banner and replaces the verdict section with it, so a mismatched sheet is not fit to be
    // voted on and says so before anything else on the page.
    expect(
      await page.locator('#stale-banner').count(),
      'the sheet built with its measured verdicts matching the pin, so it is fit to vote on',
    ).toBe(0);

    const digests = await page.evaluate(() =>
      [...document.querySelectorAll('[data-sha256]')].map((wrapper) => ({
        file: wrapper.getAttribute('data-candidate') ?? '',
        sha256: wrapper.getAttribute('data-sha256') ?? '',
      })),
    );

    // NON-VACUITY FIRST, again: a walk that found three digests would report a clean result over
    // almost nothing.
    expect(
      digests.length,
      'every tile on the sheet carries the content digest of the file it was inlined from',
    ).toBeGreaterThanOrEqual(MIN_DIGESTS);

    // CONTENT DIGESTS, NOT A TIMESTAMP AND NOT A GIT COMPARISON: a digest is deterministic and
    // needs no clock. A drawing edited after the sheet was generated reddens HERE rather than
    // being silently judged in its old form.
    const drifted: string[] = [];
    for (const digest of digests) {
      const path = sourcePath(digest.file);
      if (!existsSync(path)) {
        drifted.push(`${digest.file} is inlined on the sheet but absent from disk`);
        continue;
      }
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (actual !== digest.sha256) {
        drifted.push(`${digest.file} on disk is ${actual}, the sheet was built from ${digest.sha256}`);
      }
    }

    expect(
      [...new Set(drifted)],
      'every inlined drawing is byte-identical to the file it came from - regenerate the sheet ' +
        'with npm run build:mark-sheet after editing any candidate',
    ).toEqual([]);
  } finally {
    await close();
  }
});
