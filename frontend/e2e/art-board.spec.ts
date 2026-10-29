import { test, expect, type Browser, type Page } from '@playwright/test';

// art-board.spec.ts (BOARD-01, plan 57-01) - the gate on the art board's tracer cell.
//
// It asserts the pixels a reader is actually looking at. The board renders one cell
// end to end (a real .svg draft on disk -> Vite ?raw -> new GraphicsContext().svg()
// -> new Graphics(ctx) at a real zoom -> renderer.extract.canvas with an explicit
// frame and clearColor -> an HTMLCanvasElement in the DOM), and this spec reads
// getImageData off that very canvas: no encode, no decode, no screenshot, nothing
// between the assertion and the renderer's output.
//
// WHAT IT GUARDS, and why each one is a trap rather than a formality (57-RESEARCH
// F3.2, all measured):
//   - the backing store is EXACTLY the frame size. Without an explicit `frame`, cell
//     size comes from the artwork's local bounds INCLUDING STROKE EXTENTS, so two
//     directions with different stroke weights get different pixel sizes - a
//     cell-geometry violation delivered by the renderer, underneath the CSS.
//   - EVERY alpha byte is 255. `clearColor` defaults to transparent, NOT to the
//     Application background, so omitting it extracts every cell on a transparent
//     substrate of premultiplied bytes - and then a "pixels differing from the
//     substrate" gate returns ~100% for every cell INCLUDING a genuinely blank one.
//     The non-emptiness assertion below is worth nothing without the alpha one.
//   - at least 1% of pixels differ from the substrate, so a cell that tessellated to
//     nothing fails instead of reporting the cleanest result on the board.
//   - EVERY pixel is one of LOCKED_SKIN's five named ramp values. This assertion was
//     ADDED after mutation-testing (plan 57-01 task 2, mutation M3) found a real hole:
//     replacing the draft's paths with a single `fill="none" stroke="none"` path does
//     NOT produce a blank cell - Pixi's renderChildren sets `noStyle -> fillStyle =
//     { color: 0 }` and silently paints a SOLID BLACK SQUARE. The ink-ratio assertion
//     above dutifully counted 576 black pixels as "real artwork" and the whole gate
//     went green over a cell carrying no artwork at all. A colour allowlist closes it,
//     and closes two more things for free: a blank cell (ratio 0) and any antialiased
//     edge, since a blended pixel is by definition not a named ramp value.
//   - antialias is off, read from the LIVE GL context rather than from the option
//     Pixi was handed.
//
// TWO CONTRACT NOTES, both about how this file is (and is not) gated:
//
//   1. `npx tsc --noEmit` typechecks ZERO e2e specs. frontend/tsconfig.json includes
//      ["scripts","src","shared",...] and NOT "e2e", and Playwright strips types via
//      babel. The Playwright run is the ONLY gate for this file - do not cite tsc for
//      it, and do not assume a rename or a bad type here would be caught by the unit
//      job.
//   2. Under this harness Playwright's own webServer block is unusable (it spawns
//      Vite in a detached process group that trips a signal-16 kill). Start Vite
//      externally on :5173 and run with --config=playwright.mock.reuse.config.ts.
//
// NO PIXEL BASELINE. The board is deliberately absent from pixel-guard.spec.ts and
// gets no toHaveScreenshot: its content is DRAFTS, and baselining drafts trains
// exactly the re-bless habit this milestone refuses. Every assertion here is a
// property of the pixels, not a comparison against a committed image.

/** The tracer cell: SOURCE at zoom 1.00 in direction A. */
const TRACER_CELL = '[data-slate-row="SOURCE@1.00"] [data-cell][data-direction="A"] canvas';

/** SOURCE is 1x1 on the 32-unit grid, so at 1.00x the frame is exactly 32 x 32 px. */
const TRACER_PX = 32;

/** LOCKED_SKIN.palette.ramp[0] - the substrate, as [r, g, b]. */
const SUBSTRATE_RGB: readonly [number, number, number] = [0x1b, 0x1f, 0x27];

/**
 * LOCKED_SKIN.palette.ramp, mirrored as `r,g,b` keys.
 *
 * Mirrored rather than imported: this spec is not typechecked (see the header) and an
 * assertion that read the same module the board reads would agree with a broken board
 * by construction. These are literals on purpose, and a drift here IS a finding.
 */
const RAMP_RGB: readonly string[] = [
  '27,31,39', // ramp[0] #1b1f27 - substrate
  '42,47,58', // ramp[1] #2a2f3a
  '59,66,80', // ramp[2] #3b4250
  '86,95,112', // ramp[3] #565f70
  '176,186,203', // ramp[4] #b0bacb - highlight
];

/** A cell that is at least this fraction non-substrate is carrying real artwork. */
const MIN_INK_RATIO = 0.01;

interface CellReadout {
  readonly width: number;
  readonly height: number;
  /** Pixels whose alpha byte is not 255. Must be zero. */
  readonly translucent: number;
  /** Pixels differing from the substrate in any of R, G, B. */
  readonly ink: number;
  /** Pixels whose RGB is not a named LOCKED_SKIN ramp value. Must be zero. */
  readonly foreign: number;
  /** The distinct `r,g,b` values present, most-frequent first - the failure diagnostic. */
  readonly palette: readonly string[];
  /** Total pixels. */
  readonly total: number;
  /** FNV-1a over the whole RGBA buffer, as hex - the reload test's byte identity. */
  readonly digest: string;
}

/**
 * Wait for the board's ONLY readiness signal, then read the tracer canvas back.
 *
 * ATTACHED, not visible: the readout is an out-of-flow display:none data marker, and
 * Playwright's default `visible` state would time out on it forever. The board sets
 * this attribute exactly once, from its single boot(), after the last cell extracts -
 * so a spec cannot read a half-built board, and no polling or waitForTimeout is
 * needed (or permitted) here.
 */
async function readTracerCell(page: Page): Promise<CellReadout> {
  await page.locator('#art-board-readout[data-board-ready="1"]').waitFor({ state: 'attached' });
  return page.locator(TRACER_CELL).evaluate((el, { substrate, ramp }) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('tracer cell canvas has no 2d context');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const allowed = new Set(ramp);
    const counts = new Map<string, number>();
    let translucent = 0;
    let ink = 0;
    let foreign = 0;
    let hash = 0x811c9dc5;
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] !== 255) translucent++;
      if (
        data[p] !== substrate[0] ||
        data[p + 1] !== substrate[1] ||
        data[p + 2] !== substrate[2]
      ) {
        ink++;
      }
      const key = `${data[p]},${data[p + 1]},${data[p + 2]}`;
      if (!allowed.has(key)) foreign++;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (let i = 0; i < data.length; i++) {
      hash ^= data[i] as number;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      translucent,
      ink,
      foreign,
      palette: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
      total: data.length / 4,
      digest: hash.toString(16).padStart(8, '0'),
    };
  }, { substrate: SUBSTRATE_RGB as unknown as number[], ramp: RAMP_RGB as unknown as string[] });
}

test('art board: the SOURCE@1.00 direction-A cell renders end to end', async ({ browser }) => {
  // Pin DPR so the backing store never varies with the host display density (the
  // board also pins the Pixi resolution to 1 in its extract call).
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto('/art-board.html');
    const cell = await readTracerCell(page);

    expect(
      { width: cell.width, height: cell.height },
      'the extracted backing store is exactly ceil(footprint * CELL_U * zoom) in both axes, ' +
        'independent of the draft stroke weight (an omitted `frame` makes it a function of stroke extents)',
    ).toEqual({ width: TRACER_PX, height: TRACER_PX });

    expect(
      cell.translucent,
      'every extracted pixel is opaque - a transparent substrate is a failure, not a styling choice, ' +
        'and it would make the non-emptiness assertion below pass vacuously',
    ).toBe(0);

    expect(
      cell.ink / cell.total,
      'the cell carries real artwork rather than a blank substrate',
    ).toBeGreaterThanOrEqual(MIN_INK_RATIO);

    expect(
      { foreign: cell.foreign, palette: cell.palette },
      "every pixel is a named LOCKED_SKIN ramp value - this is what stops a silent black " +
        "fill (Pixi's noStyle fallback) from being counted as artwork by the ink ratio above, " +
        'and it fails on any antialiased edge, since a blended pixel is not a ramp value',
    ).toEqual({ foreign: 0, palette: cell.palette });

    expect(
      await page.locator('#art-board-readout').getAttribute('data-antialias'),
      "the board's live WebGL context reports antialias off",
    ).toBe('0');

    expect(
      await page.locator('#art-board-readout').getAttribute('data-context-lost'),
      'no WebGL context was lost while the board built',
    ).toBeNull();
  } finally {
    await ctx.close();
  }
});

test('art board: a second load is byte-identical', async ({ browser }) => {
  // Determinism of the render-extract loop itself. The board builds from committed
  // text through a fixed pipeline with no clock, no RNG and no ticker, so two loads
  // must produce the same bytes - and if they do not, every later comparison on this
  // board is comparing noise as well as artwork.
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto('/art-board.html');
    const first = await readTracerCell(page);
    await page.reload();
    const second = await readTracerCell(page);

    expect(
      { width: second.width, height: second.height },
      'the backing-store size is identical across loads',
    ).toEqual({ width: first.width, height: first.height });

    expect(second.digest, 'the extracted pixel bytes are identical across loads').toBe(
      first.digest,
    );
  } finally {
    await ctx.close();
  }
});

/* ==================================================================== *
 * The slate half of the gate (D-08, plan 57-06)
 *
 * The board is the instrument the direction lock is decided on, so the board is
 * itself gated: every (subject x zoom x direction) cell must be PRESENT and
 * NON-EMPTY, because a silently missing or blank cell makes one direction look
 * cleaner than it actually is. That is the single failure mode that would corrupt
 * the lock, and it is invisible to a reader by construction - a blank cell and an
 * absent cell look identical and mean opposite things.
 *
 * TWO RULES THE ASSERTIONS BELOW OBEY WITHOUT EXCEPTION:
 *
 *   1. EVERY COUNT IS A LITERAL. Not one is derived from the same array that built
 *      the board. A count derived from the board's own constants agrees with a
 *      broken board by construction (the 56-04 EXPECTED_FIXTURE_COUNT principle),
 *      and the arithmetic here - 9 subjects x 3 zooms x 5 directions - is exactly
 *      the arithmetic a reader can check by hand.
 *   2. THE SPEC MEASURES FOR ITSELF. It never reads a `data-` attribute the board
 *      published about its own correctness. `data-cell`, `data-direction`,
 *      `data-absent` and friends are LOCATORS; every judgement below comes from
 *      getBoundingClientRect, getComputedStyle, getImageData or textContent.
 * ==================================================================== */

/** 9 subjects x 3 zooms = 27 rows; x 5 directions = 135 cells. Hand-checkable. */
const SLATE_ROWS = 27;
const SLATE_CELLS = 135;
const CELLS_PER_DIRECTION = 27;

/**
 * The nine subjects' base footprints in grid cells, and the three zooms - MIRRORED
 * as literals from `crates/fabrico-core/src/state.rs:926`, never imported from the
 * board. This is what lets the backing-store assertion compare against a computed
 * `ceil(footprint * 32 * zoom)` rather than only comparing the five cells of a row
 * to each other: five cells can be identically WRONG, and 57-01's mutation table
 * recorded that ceiling explicitly as the hole plan 06 had to close.
 */
const SUBJECT_FOOTPRINT: Readonly<Record<string, readonly [number, number]>> = {
  SOURCE: [1, 1],
  BELT: [1, 1],
  FACTORY: [3, 3],
  TEE: [2, 2],
  BALANCER: [2, 2],
  ROUTER: [2, 3],
  MERGE: [2, 2],
  SINK: [1, 1],
  ENDPOINT: [1, 1],
};

/** The 32-unit module, on both axes. Mirrored, not imported. */
const CELL_UNITS = 32;

/**
 * `TODAY x ENDPOINT` is legitimately absent at EVERY zoom, so THREE cells carry the
 * label, not one.
 *
 * The plan's acceptance criterion said "exactly one", which is an arithmetic slip:
 * the grid is 27 ROWS, and ENDPOINT owns three of them (1.00x, 1.77x, 2.00x).
 * Labelling only the 1.00x cell would leave two cells whose glyph is unexplained on
 * the two rows where the pixel bake is under the most stress, which is precisely
 * where a reader most needs to know that there is no baseline to compare against.
 * The literal is 3 and the reason is here so it cannot read as a weakened count.
 */
const ABSENT_NO_SHIPPED_ART = 3;

/** 8 candidate subjects (every kind but the locked BELT) x 4 directions. */
const COST_CELLS = 32;

/** The cost table's four candidate columns, in DOM order. TODAY has no column here. */
const COST_COLUMNS: readonly string[] = ['A', 'B', 'C', 'D'];

/**
 * The tolerance, in px, between a cost-table header's left edge and its column's.
 *
 * 8 is the padding a header cell and a value cell share; the correct answer is 0, and
 * this is deliberately not widened to swallow one cell pitch (208px) or one gutter
 * (152px), which are the two magnitudes the defect this test was written against had.
 */
const HEADER_COLUMN_TOLERANCE_PX = 8;

/** One row of the slate, as measured - never as the board describes itself. */
interface RowGeometry {
  readonly row: string;
  readonly subject: string;
  readonly zoom: number;
  /** Per cell: direction + the geometry that must be identical across the row. */
  readonly cells: readonly {
    readonly direction: string;
    readonly box: string;
    readonly canvas: string;
  }[];
}

interface SlateCell {
  readonly id: string;
  readonly subject: string;
  readonly kind: string;
  readonly zoom: string;
  readonly direction: string;
  readonly absent: string | null;
  readonly error: string | null;
  readonly hasCanvas: boolean;
  readonly text: string;
  /** Pixels whose alpha byte is not 255. Must be zero. */
  readonly translucent: number;
  /** Fraction of pixels differing from the substrate. Must be >= 1%. */
  readonly inkRatio: number;
  /** Pixels whose RGB is not a named LOCKED_SKIN value. Must be zero. */
  readonly foreign: number;
  /** The distinct `r,g,b` values present, most-frequent first - the failure diagnostic. */
  readonly palette: readonly string[];
  /** The measured backing store, as `WxH`. */
  readonly canvas: string;
  /** The backing store the frame arithmetic requires, as `WxH`. */
  readonly expected: string;
}

interface SlateReadout {
  readonly cellCount: number;
  readonly rowCount: number;
  readonly rowIds: readonly string[];
  readonly perDirection: Readonly<Record<string, number>>;
  readonly canvasCount: number;
  readonly cells: readonly SlateCell[];
  readonly rows: readonly RowGeometry[];
  readonly headers: readonly string[];
  readonly descriptions: readonly { readonly direction: string; readonly length: number }[];
  readonly costCells: readonly {
    readonly subject: string;
    readonly direction: string;
    readonly text: string;
    /** Rounded viewport-relative left edge of the cell BOX, for the header/column check. */
    readonly left: number;
  }[];
  /** The cost table's four direction headers, in DOM order, with their box left edges. */
  readonly costHeaders: readonly {
    readonly direction: string;
    readonly left: number;
    readonly text: string;
  }[];
  readonly bodyText: string;
  /** FNV-1a over three sampled cells' RGBA buffers - one 1x1, one 2x3, one 3x3. */
  readonly digests: Readonly<Record<string, string>>;
}

/**
 * The colour allowlist for the WHOLE slate: LOCKED_SKIN's five ramp steps, plus the
 * one accent that legitimately reaches an extracted cell.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT OPTIONAL. `fill="none" stroke="none"` does NOT
 * blank a path: Pixi's `renderChildren` sets `noStyle -> fillStyle = { color: 0 }` and
 * paints a SOLID BLACK SQUARE, which tessellates to 8 vertices rather than zero. A
 * "pixels differing from the substrate" gate dutifully counts every black pixel as
 * artwork. That trap has now bitten three separate gates in this phase (57-01 M3,
 * 57-04 M4, and 57-06 M2 below, where the whole ten-test board suite went green over a
 * TEE cell carrying a black square instead of a drawing). The allowlist is the only
 * assertion that catches it, and it catches a blank cell and any antialiased edge for
 * free, since a blended pixel is by definition not a named value.
 *
 * WIDENED DELIBERATELY, ONCE, WITH THE REASON RECORDED - 57-01's carried concern asked
 * for exactly this rather than for the assertion to be dropped when TODAY arrived.
 * `78,224,255` is `LOCKED_SKIN.palette.accents.electric`, the fill `layers/wires.ts`
 * uses for the wire-terminal inlet glyph, which is the only shipped endpoint visual and
 * therefore the only honest thing the TODAY x ENDPOINT cell can draw. MEASURED on the
 * clean tree, the entire 135-cell board uses exactly these six values and nothing else:
 * ramp[2] `59,66,80` appears in TODAY only (the baked chassis fill) and electric in the
 * three endpoint cells only. Zero blended pixels anywhere - that is what antialias-off
 * looks like at the byte level, across every cell rather than across one.
 *
 * Mirrored as literals, never imported: this spec is not typechecked (see the header),
 * and an assertion that read the board's own module would agree with a broken board by
 * construction.
 */
const ALLOWED_RGB: readonly string[] = [
  '27,31,39', // ramp[0] #1b1f27 - substrate
  '42,47,58', // ramp[1] #2a2f3a
  '59,66,80', // ramp[2] #3b4250
  '86,95,112', // ramp[3] #565f70
  '176,186,203', // ramp[4] #b0bacb - highlight
  '78,224,255', // accents.electric #4ee0ff - the shipped inlet glyph, TODAY x ENDPOINT
];

/** The three idempotency samples: one 1x1 subject, one 2x3, one 3x3. */
const DIGEST_SAMPLES: readonly string[] = [
  'SOURCE@1.00/A',
  'ROUTER@1.77/C',
  'FACTORY@2.00/D',
];

/**
 * Read the whole board back in ONE evaluate, after its single readiness marker.
 *
 * One round trip rather than 135, because a per-cell locator round trip would make
 * this spec slower than the board it measures (the whole board renders in ~150 ms).
 */
async function readSlate(page: Page): Promise<SlateReadout> {
  await page.locator('#art-board-readout[data-board-ready="1"]').waitFor({ state: 'attached' });
  return page.evaluate(
    ({ substrate, footprints, unit, samples, allowed }) => {
      const cellEls = [...document.querySelectorAll('[data-slate-row] [data-cell]')];
      const idOf = (el: Element): string =>
        `${el.getAttribute('data-subject')}@${el.getAttribute('data-zoom')}/${el.getAttribute('data-direction')}`;

      const allowedSet = new Set(allowed);
      const perDirection: Record<string, number> = {};
      const cells: SlateCell[] = [];
      const digests: Record<string, string> = {};
      let canvasCount = 0;

      for (const el of cellEls) {
        const direction = el.getAttribute('data-direction') as string;
        const subject = el.getAttribute('data-subject') as string;
        const zoomText = el.getAttribute('data-zoom') as string;
        perDirection[direction] = (perDirection[direction] ?? 0) + 1;
        const id = idOf(el);
        const zoom = Number(zoomText);
        const fp = footprints[subject] ?? [0, 0];
        const expected = `${Math.ceil((fp[0] as number) * unit * zoom)}x${Math.ceil((fp[1] as number) * unit * zoom)}`;
        const canvas = el.querySelector('canvas');
        let translucent = 0;
        let inkRatio = 0;
        let foreign = 0;
        let palette: string[] = [];
        let size = 'none';
        if (canvas !== null) {
          canvasCount++;
          size = `${canvas.width}x${canvas.height}`;
          const g = canvas.getContext('2d', { willReadFrequently: true });
          if (g === null) throw new Error(`cell ${id} canvas has no 2d context`);
          const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
          let differing = 0;
          const counts = new Map<string, number>();
          for (let p = 0; p < data.length; p += 4) {
            if (data[p + 3] !== 255) translucent++;
            if (
              data[p] !== substrate[0] ||
              data[p + 1] !== substrate[1] ||
              data[p + 2] !== substrate[2]
            ) {
              differing++;
            }
            const rgb = `${data[p]},${data[p + 1]},${data[p + 2]}`;
            if (!allowedSet.has(rgb)) foreign++;
            counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
          }
          inkRatio = differing / (data.length / 4);
          // The observed palette is carried on EVERY cell, not only on a failing one:
          // a foreign-pixel failure is undiagnosable without it, and a second run to
          // collect it is a second chance for the board to render differently.
          palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
          if (samples.includes(id)) {
            let hash = 0x811c9dc5;
            for (let i = 0; i < data.length; i++) {
              hash ^= data[i] as number;
              hash = Math.imul(hash, 0x01000193) >>> 0;
            }
            digests[id] = hash.toString(16).padStart(8, '0');
          }
        }
        cells.push({
          id,
          subject,
          kind: el.getAttribute('data-kind') as string,
          zoom: zoomText,
          direction,
          absent: el.getAttribute('data-absent'),
          error: el.getAttribute('data-error'),
          hasCanvas: canvas !== null,
          text: (el as HTMLElement).innerText.trim(),
          translucent,
          inkRatio,
          foreign,
          palette,
          canvas: size,
          expected,
        });
      }

      const rowEls = [...document.querySelectorAll('[data-slate-row]')];
      const rows = rowEls.map((rowEl) => {
        const id = rowEl.getAttribute('data-slate-row') as string;
        const [subject, zoomText] = id.split('@');
        return {
          row: id,
          subject: subject as string,
          zoom: Number(zoomText),
          cells: [...rowEl.querySelectorAll('[data-cell]')].map((el) => {
            // getBoundingClientRect, NEVER offsetWidth: offsetWidth is rounded to an
            // integer and would hide a sub-pixel divergence between two columns.
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const canvas = el.querySelector('canvas');
            return {
              direction: el.getAttribute('data-direction') as string,
              box: [
                r.width,
                r.height,
                cs.backgroundColor,
                cs.paddingTop,
                cs.paddingRight,
                cs.paddingBottom,
                cs.paddingLeft,
                cs.borderTopWidth,
                cs.borderRightWidth,
                cs.borderBottomWidth,
                cs.borderLeftWidth,
                cs.borderTopStyle,
                cs.borderTopColor,
              ].join('|'),
              canvas: canvas === null ? 'none' : `${canvas.width}x${canvas.height}`,
            };
          }),
        };
      });

      return {
        cellCount: cellEls.length,
        rowCount: rowEls.length,
        rowIds: rowEls.map((el) => el.getAttribute('data-slate-row') as string),
        perDirection,
        canvasCount,
        cells,
        rows,
        headers: [...document.querySelectorAll('[data-direction-header]')].map(
          (el) => el.getAttribute('data-direction-header') as string,
        ),
        descriptions: [...document.querySelectorAll('[data-description]')].map((el) => ({
          direction: el.getAttribute('data-description') as string,
          length: ((el as HTMLElement).textContent ?? '').length,
        })),
        costCells: [...document.querySelectorAll('[data-cost-cell]')].map((el) => ({
          subject: el.getAttribute('data-subject') as string,
          direction: el.getAttribute('data-direction') as string,
          text: (el as HTMLElement).innerText.trim(),
          left: Math.round(el.getBoundingClientRect().left),
        })),
        costHeaders: [...document.querySelectorAll('[data-cost-header]')].map((el) => ({
          direction: el.getAttribute('data-cost-header') as string,
          left: Math.round(el.getBoundingClientRect().left),
          text: (el as HTMLElement).innerText.trim(),
        })),
        bodyText: (document.body as HTMLElement).innerText,
        digests,
      };
    },
    {
      substrate: SUBSTRATE_RGB as unknown as number[],
      footprints: SUBJECT_FOOTPRINT as unknown as Record<string, number[]>,
      unit: CELL_UNITS,
      samples: DIGEST_SAMPLES as unknown as string[],
      allowed: ALLOWED_RGB as unknown as string[],
    },
  );
}

/** One context per test, DPR pinned so the backing store never varies with the host. */
async function openBoard(
  // `Browser`, imported, rather than dug out of `typeof test` with
  // `Parameters<Parameters<typeof test>[1]>[0]`. That indirection was silently broken:
  // `test`'s second parameter can be a `TestDetails` object under Playwright's
  // three-argument overload, `Parameters<TestDetails>` does not typecheck, and the
  // whole annotation collapsed to `never` - which made every one of the 26 call sites
  // below an error the moment `e2e/` entered `tsconfig.json`'s include.
  browser: Browser,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto('/art-board.html');
  return { page, close: () => ctx.close() };
}

test('art board: the slate holds exactly 135 cells, 27 per direction', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);

    expect(slate.cellCount, '9 subjects x 3 zooms x 5 directions = 135 slate cells').toBe(
      SLATE_CELLS,
    );
    expect(slate.rowCount, '9 subjects x 3 zooms = 27 slate rows').toBe(SLATE_ROWS);

    // N7, equal space: no direction may quietly lose a subject or a zoom. A missing
    // row in one column is the cheapest possible way for a direction to look cleaner.
    expect(slate.perDirection, 'every direction column carries all 27 rows').toEqual({
      TODAY: CELLS_PER_DIRECTION,
      A: CELLS_PER_DIRECTION,
      B: CELLS_PER_DIRECTION,
      C: CELLS_PER_DIRECTION,
      D: CELLS_PER_DIRECTION,
    });

    // Rows in subject order then ascending zoom, spelled out. Ordering is stated on
    // the board as carrying no ranking, so the board has to actually hold to it.
    expect(slate.rowIds, 'rows are subject-then-ascending-zoom, in the declared order').toEqual([
      'SOURCE@1.00', 'SOURCE@1.77', 'SOURCE@2.00',
      'BELT@1.00', 'BELT@1.77', 'BELT@2.00',
      'FACTORY@1.00', 'FACTORY@1.77', 'FACTORY@2.00',
      'TEE@1.00', 'TEE@1.77', 'TEE@2.00',
      'BALANCER@1.00', 'BALANCER@1.77', 'BALANCER@2.00',
      'ROUTER@1.00', 'ROUTER@1.77', 'ROUTER@2.00',
      'MERGE@1.00', 'MERGE@1.77', 'MERGE@2.00',
      'SINK@1.00', 'SINK@1.77', 'SINK@2.00',
      'ENDPOINT@1.00', 'ENDPOINT@1.77', 'ENDPOINT@2.00',
    ]);

    // Every cell carries data-kind, so a MERGE/BALANCER silhouette collapse in some
    // direction stays a finding about the ART and can never be an ambiguity in the
    // instrument reporting it.
    expect(
      slate.cells.filter((c) => c.kind !== c.subject).map((c) => c.id),
      'every cell identifies its kind, so two subjects that collapse stay distinguishable',
    ).toEqual([]);

    // Presence, as distinct from non-emptiness below: today every one of the 135
    // renders, including TODAY x ENDPOINT (the inlet glyph) and the 15 BELT cells.
    expect(slate.canvasCount, 'all 135 cells rendered artwork through extractCell').toBe(
      SLATE_CELLS,
    );
  } finally {
    await close();
  }
});

test('art board: every slate cell is opaque and non-empty', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);

    // The alpha assertion FIRST, because the ink assertion is worth nothing without
    // it: `clearColor` defaults to transparent, and on a transparent premultiplied
    // buffer "pixels differing from the substrate" returns ~100% for EVERY cell,
    // including a genuinely blank one. Every failing cell is named, never just the first.
    expect(
      slate.cells.filter((c) => c.hasCanvas && c.translucent > 0).map((c) => `${c.id} (${c.translucent}px)`),
      'every extracted pixel of every cell is opaque - a transparent substrate would make ' +
        'the non-emptiness assertion below pass vacuously over the whole board',
    ).toEqual([]);

    expect(
      slate.cells
        .filter((c) => c.hasCanvas && c.inkRatio < MIN_INK_RATIO)
        .map((c) => `${c.id} (${(c.inkRatio * 100).toFixed(2)}% ink)`),
      'every rendered cell carries real artwork rather than a blank substrate',
    ).toEqual([]);

    // THE ASSERTION THE INK RATIO ABOVE CANNOT MAKE. See ALLOWED_RGB: a paint-less
    // path is painted SOLID BLACK by Pixi rather than left blank, and the ink ratio
    // counts those black pixels as artwork. Verified by mutation (M2 below): without
    // this line the entire suite passes over a cell carrying no drawing at all.
    expect(
      slate.cells
        .filter((c) => c.hasCanvas && c.foreign > 0)
        .map((c) => `${c.id}: ${c.foreign}px outside the palette, observed ${c.palette.join(' ')}`),
      'every pixel on the board is a named LOCKED_SKIN value - this is what stops a silent black ' +
        "fill (Pixi's noStyle fallback) being counted as artwork, and it fails on any antialiased " +
        'edge, since a blended pixel is not a named value',
    ).toEqual([]);

    // A cell with no canvas is only legitimate if it SAYS why, in words a reader can
    // see. This is the other half of "non-empty": presence of pixels OR presence of
    // an explanation, and never neither.
    expect(
      slate.cells
        .filter((c) => !c.hasCanvas && c.absent === null && c.error === null)
        .map((c) => c.id),
      'a cell with no artwork carries a labelled absent or error state, never a bare blank',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: TODAY x ENDPOINT is labelled absent, and no absent cell is unlabelled', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);

    const noShippedArt = slate.cells.filter((c) => c.absent === 'no-shipped-art');
    expect(
      noShippedArt.map((c) => c.id),
      'the endpoint has no synth generator, so TODAY is absent on all three of its zoom rows',
    ).toEqual(['ENDPOINT@1.00/TODAY', 'ENDPOINT@1.77/TODAY', 'ENDPOINT@2.00/TODAY']);
    expect(noShippedArt.length, 'three rows, one labelled cell each').toBe(ABSENT_NO_SHIPPED_ART);

    // All 32 candidates exist after plan 57-05, so nothing may be reporting itself as
    // unauthored. This is the assertion that reddens when a candidate .svg goes missing.
    expect(
      slate.cells.filter((c) => c.absent === 'no-candidate').map((c) => c.id),
      'every one of the 32 candidate drafts was found and parsed',
    ).toEqual([]);
    expect(
      slate.cells.filter((c) => c.error !== null).map((c) => `${c.id} (${c.error})`),
      'no candidate failed to parse or tessellated to zero geometry',
    ).toEqual([]);

    // THE ASSERTION, stated as a property rather than as an inspection of the one
    // cell that has the state today: a `data-absent` cell with no visible text is a
    // blank box wearing a label, which is the exact failure the label exists to
    // prevent. Stripping the copy while leaving the attribute must redden here.
    expect(
      slate.cells.filter((c) => c.absent !== null && c.text.length === 0).map((c) => c.id),
      'every absent cell states in visible text why it is absent',
    ).toEqual([]);
    expect(
      slate.cells.filter((c) => c.error !== null && c.text.length === 0).map((c) => c.id),
      'every error cell states in visible text what failed',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: cell geometry is identical across a row in CSS box and backing store', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);
    expect(slate.rowCount, 'the geometry sweep covers all 27 rows').toBe(SLATE_ROWS);

    // BOTH HALVES ARE REQUIRED, and this is the plan-57-01 hole being closed.
    // Identical CSS boxes are entirely compatible with differently-sized extracted
    // canvases: drop the explicit `frame` from extractCell and the cell size becomes
    // a function of the artwork's stroke extents, so a 3u-stroked direction and a
    // 2u-stroked one get different pixel sizes underneath identical CSS. That is a
    // cell-geometry violation (N2) and an equal-space violation (N7) delivered by the
    // renderer, below the layer the neutrality rules otherwise check.
    const boxDivergence: string[] = [];
    const canvasDivergence: string[] = [];
    const frameDivergence: string[] = [];
    for (const row of slate.rows) {
      expect(row.cells.length, `row ${row.row} has one cell per direction`).toBe(5);
      const box = (row.cells[0] as { box: string }).box;
      const canvas = (row.cells[0] as { canvas: string }).canvas;
      const fp = SUBJECT_FOOTPRINT[row.subject] as readonly [number, number];
      const expected = `${Math.ceil(fp[0] * CELL_UNITS * row.zoom)}x${Math.ceil(fp[1] * CELL_UNITS * row.zoom)}`;
      for (const cell of row.cells) {
        if (cell.box !== box) boxDivergence.push(`${row.row}/${cell.direction}: ${cell.box} != ${box}`);
        if (cell.canvas !== canvas) {
          canvasDivergence.push(`${row.row}/${cell.direction}: ${cell.canvas} != ${canvas}`);
        }
        if (cell.canvas !== expected) {
          frameDivergence.push(`${row.row}/${cell.direction}: ${cell.canvas} != ${expected}`);
        }
      }
    }

    expect(
      boxDivergence,
      'every cell in a row has an identical CSS box: exact float width and height, and identical ' +
        'background, padding and border - a wider or brighter column is advocacy by layout (N2/N8)',
    ).toEqual([]);
    expect(
      canvasDivergence,
      'every cell in a row has an identical canvas backing store, so no direction is rendered at ' +
        'more pixels than its neighbours',
    ).toEqual([]);
    expect(
      frameDivergence,
      'each backing store is exactly ceil(footprint * 32 * zoom) - five cells can be identically ' +
        'wrong, so equality across the row is not on its own enough (57-01 mutation M2)',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: column order is TODAY A B C D and the standing line is present', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);

    // N1. Column order comes from one const and carries no meaning - but "carries no
    // meaning" is only credible if the order is actually fixed, and a flattering sort
    // is advocacy that no token scan over the board's prose could ever catch.
    expect(slate.headers, 'the five column headers read TODAY, A, B, C, D in DOM order').toEqual([
      'TODAY',
      'A',
      'B',
      'C',
      'D',
    ]);

    // Every row's cells are in the same order as the headers, so the header row cannot
    // be honest while the grid beneath it is permuted.
    expect(
      slate.rows
        .filter((r) => r.cells.map((c) => c.direction).join(',') !== 'TODAY,A,B,C,D')
        .map((r) => `${r.row}: ${r.cells.map((c) => c.direction).join(',')}`),
      'every one of the 27 rows lays its cells out in the same fixed column order',
    ).toEqual([]);

    // D-04 requires the board to SAY this rather than leave a reader to infer it from
    // position. Asserted verbatim: a re-worded claim is a different claim.
    expect(
      slate.bodyText,
      "the board's standing header line is present verbatim",
    ).toContain('Column order carries no meaning. TODAY is a pinned reference, not a candidate.');
    expect(
      slate.bodyText,
      'the slate states, at the columns themselves, that their order carries no ranking meaning',
    ).toContain('it carries no ranking meaning');
    expect(
      slate.bodyText,
      'the slate states that the zoom-row order carries no ranking meaning either',
    ).toContain('Zoom rows run 1.00x, 1.77x, 2.00x, ascending.');
  } finally {
    await close();
  }
});

test('art board: each candidate description is 80-120 characters', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);

    // N9. Unequal description length is itself advocacy: a column given three
    // sentences of explanation while its neighbour gets a clause has been argued for.
    // TODAY is exempt from the band (it is a reference, not a candidate) but is still
    // one sentence, so it is asserted as present rather than as unbounded.
    expect(
      slate.descriptions.map((d) => d.direction),
      'every column carries exactly one description, in column order',
    ).toEqual(['TODAY', 'A', 'B', 'C', 'D']);

    expect(
      slate.descriptions
        .filter((d) => d.direction !== 'TODAY' && (d.length < 80 || d.length > 120))
        .map((d) => `${d.direction}: ${d.length} chars`),
      'each of the four candidate descriptions is one sentence of 80-120 characters',
    ).toEqual([]);

    expect(
      slate.descriptions.filter((d) => d.direction === 'TODAY' && d.length === 0).map((d) => d.direction),
      "the reference column's description is present",
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: the cost table has 32 populated cells, no rating form and no TODAY column', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);

    // N5. 8 candidate subjects x 4 directions. BELT has no candidate .svg (its art is
    // already locked) and TODAY has no tessellation - printing TODAY as 0 would read
    // as the cheapest thing on the board, which is a ranking claim made by arithmetic.
    expect(slate.costCells.length, '8 candidate subjects x 4 directions = 32 measured cells').toBe(
      COST_CELLS,
    );
    expect(
      slate.costCells.filter((c) => c.direction === 'TODAY' || c.subject === 'BELT').map((c) => `${c.subject}/${c.direction}`),
      'the cost table has no TODAY column and no BELT row',
    ).toEqual([]);

    // Every cell is a MEASUREMENT WITH UNITS - both units, per Phase 56's rule that
    // half of all readers get the unit backwards - plus the band as a plain word.
    expect(
      slate.costCells
        .filter((c) => !/^\d+ vertices \/ \d+ points\nband (ok|warn|fail)$/.test(c.text))
        .map((c) => `${c.subject}/${c.direction}: ${JSON.stringify(c.text)}`),
      'every cost cell prints both units and the band as a word',
    ).toEqual([]);

    // No score, rank, ordinal or star anywhere in the table.
    expect(
      slate.costCells.filter((c) => /^[1-5]\/5$/m.test(c.text) || /^#\d/m.test(c.text)).map((c) => c.text),
      'no cost cell carries a rating or an ordinal form',
    ).toEqual([]);

    // The finding the table must not hide: the fewest marks cost the most vertices.
    expect(
      slate.bodyText,
      'the table prints the footprint-independence fact, so no candidate is ever simplified on ' +
        'the belief that a bigger asset has less room',
    ).toContain('it is footprint-independent');
  } finally {
    await close();
  }
});

test('art board: every cost-table header sits over its own column', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const slate = await readSlate(page);

    // THE NON-VACUITY FLOOR. Without it, a dropped data-cost-header attribute empties
    // the divergence array below and this whole test passes over an empty selection -
    // the exact vacuity this phase has already caught three separate times (57-01 M3,
    // 57-04 M4, 57-06 M2).
    expect(
      slate.costHeaders.length,
      'the cost table carries exactly four direction headers',
    ).toBe(COST_COLUMNS.length);
    expect(
      slate.costHeaders.map((h) => h.direction),
      'the four cost-table headers read A, B, C, D in DOM order',
    ).toEqual(COST_COLUMNS);

    // WHAT A READER LOSES WHEN THIS DRIFTS. A header built at label width while its
    // column is built at value width sits over its NEIGHBOUR's box, so scanning down
    // from a direction label reads the adjacent direction's numbers - on the one table
    // that carries the vertex-cost finding, on the board the maintainer reads to lock a direction.
    // Measured against the defect this test was written for: A +0, B -56, C -112,
    // D -168, i.e. three of the four columns misattributed.
    const divergence: string[] = [];
    for (const header of slate.costHeaders) {
      const column = slate.costCells.filter((c) => c.direction === header.direction);
      const lefts = [...new Set(column.map((c) => c.left))];
      expect(
        lefts.length,
        `column ${header.direction} is one straight column, so all its cells share one left edge`,
      ).toBe(1);
      const columnLeft = lefts[0] as number;
      const delta = header.left - columnLeft;
      if (Math.abs(delta) > HEADER_COLUMN_TOLERANCE_PX) {
        divergence.push(
          `${header.direction}: header x=${header.left}, column x=${columnLeft}, delta=${delta}`,
        );
      }
    }
    expect(
      divergence,
      'every cost-table header shares its column\'s left edge, so scanning down from a ' +
        "direction label reads that direction's own measured cost",
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: a second load reproduces identical geometry and identical pixels', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    // Determinism of the whole 135-cell render-extract-destroy loop, not just of one
    // cell. The board builds from committed text through a fixed pipeline with no
    // clock, no RNG and no ticker, so two loads must agree - and if they do not, every
    // comparison on this board is comparing noise as well as artwork.
    const first = await readSlate(page);
    await page.reload();
    const second = await readSlate(page);

    expect(
      second.rows.map((r) => `${r.row}: ${r.cells.map((c) => `${c.box}~${c.canvas}`).join(' ')}`),
      'the whole 27 x 5 cell-geometry matrix is identical across loads',
    ).toEqual(first.rows.map((r) => `${r.row}: ${r.cells.map((c) => `${c.box}~${c.canvas}`).join(' ')}`));

    expect(
      Object.keys(second.digests).sort(),
      'the three sampled cells (a 1x1, a 2x3 and a 3x3) were found on both loads',
    ).toEqual([...DIGEST_SAMPLES].sort());

    expect(
      second.digests,
      'the extracted pixel bytes of the sampled cells are identical across loads',
    ).toEqual(first.digests);
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * The channel half of the gate (D-07, plan 57-07)
 *
 * THE FAILURE MODE THIS BLOCK EXISTS FOR IS THE MOST DANGEROUS ON THE BOARD: a
 * transform that silently did not run makes a failing direction look passable. An
 * untransformed cell labelled `deutan` shows separation a dichromat cannot see, is
 * fully opaque, carries real artwork, and passes every non-emptiness, geometry and
 * palette assertion above. Nothing already written on this board would notice it.
 *
 * SO THE ASSERTION IS IN TWO HALVES AND BOTH ARE REQUIRED (57-UI-SPEC S2, "Added from
 * the checker's recommendation"):
 *
 *   (a) the greyscale cell is achromatic - every pixel satisfies R == G == B;
 *   (b) EACH of deutan, protan and tritan differs from BOTH the colour cell AND the
 *       greyscale cell, in at least MIN_CHANNEL_DIFF of pixels.
 *
 * Half (a) alone passes over an untransformed deutan cell. Half (b) alone passes over a
 * greyscale cell that is merely darker rather than achromatic. Mutation M1 below
 * replaces the deutan transform with an identity copy and is caught by (b) only, which
 * is what makes (b) non-tradeable.
 *
 * WHAT THIS BLOCK PROVES AND WHAT IT DOES NOT. It proves a transform RAN, and that it
 * ran on the artwork the colour row shows. It does NOT prove the RIGHT transform ran -
 * mutation M3 swaps the protan and tritan matrices and SURVIVES here, because both
 * results still differ from colour and from greyscale. Pinning the exact bytes per
 * channel is `src/spike/artBoardChannels.test.ts`'s job (plan 57-03, 37 unit
 * assertions against values transcribed from the authors' publication), and that
 * division of labour is deliberate: a second copy of the unit spec here would be two
 * things to keep in step, not one more thing proven.
 *
 * AND IT NEVER ASSERTS A VERDICT. Whether a direction survives deutan is the judgement
 * being made at the lock, by the maintainer, in 57-ART-LOCK.md. Nothing below scores, ranks or
 * labels a direction. ART-03's CI colour-vision gate is Phase 58 work over the shipped
 * machine set.
 * ==================================================================== */

/** 5 channel rows x 5 direction columns = 25 cells. Hand-checkable. */
const CHANNEL_CELLS = 25;
const CHANNEL_ROWS = 5;
const CELLS_PER_CHANNEL = 5;
const CHANNEL_CELLS_PER_DIRECTION = 5;

/**
 * The fixed channel row order, MIRRORED as literals from `artBoardChannels.ts`'s
 * `CHANNELS`, never imported. An order assertion that read the board's own constant
 * would agree with a re-sorted board by construction.
 */
const CHANNEL_ORDER: readonly string[] = ['colour', 'greyscale', 'deutan', 'protan', 'tritan'];

/**
 * Every panel cell's backing store, in px, as a LITERAL.
 *
 * The arrangement is 200 x 200: row 2 is `TEE` + `BALANCER` + `MERGE` at 64 px with 4 px
 * gaps (136 + 64), and the three rows stack to 32 + 4 + 64 + 4 + 96. Asserting the
 * literal rather than only cross-cell equality is 57-01's recorded M2 ceiling: 25 cells
 * can be identically wrong.
 */
const PANEL_CANVAS_PX = 200;

/**
 * The minimum fraction of pixels by which a CVD cell must differ from BOTH the colour
 * and the greyscale rendering of the same column.
 *
 * 0.5 is a floor, not a measurement. MEASURED on the clean tree the fraction is exactly
 * **1.0000 in all fifteen cases** - every one of the six colours the board paints
 * (`LOCKED_SKIN`'s five ramp steps plus `accents.electric`) maps to a different byte
 * triple under all three Machado matrices, and the substrate is INSIDE the transform
 * (57-UI-SPEC D.2), so every pixel of every cell moves. A half-transformed cell - say
 * one where only the artwork and not its background went through - would land far below
 * 0.5 and redden. An identity copy lands at 0.
 */
const MIN_CHANNEL_DIFF = 0.5;

/**
 * The board ink, `LOCKED_SKIN.palette.ramp[4]`, as the browser reports it.
 *
 * A LITERAL, so the "chrome is not transformed" assertion is not merely "the two rows
 * agree with each other" - two rows can agree while both being wrong.
 */
const BOARD_INK_CSS = 'rgb(176, 186, 203)';

interface ChannelCell {
  readonly id: string;
  readonly channel: string;
  readonly direction: string;
  readonly absent: string | null;
  readonly error: string | null;
  readonly text: string;
  readonly hasCanvas: boolean;
  /** The measured backing store, as `WxH`. */
  readonly canvas: string;
  /** Pixels whose alpha byte is not 255. Must be zero. */
  readonly translucent: number;
  /** Fraction of pixels satisfying R == G == B. Exactly 1 on the greyscale row. */
  readonly achromatic: number;
  /** Fraction of pixels differing from THIS cell's own most-frequent value. */
  readonly inkRatio: number;
  /** Fraction differing from `#1b1f27`. Only meaningful on the untransformed row. */
  readonly inkRatioVsSubstrate: number;
  /** Pixels whose RGB is not a named LOCKED_SKIN value. Only checked on `colour`. */
  readonly foreign: number;
  /** The distinct `r,g,b` values present, most-frequent first - the diagnostic. */
  readonly palette: readonly string[];
}

interface ChannelDiff {
  readonly id: string;
  readonly vsColour: number;
  readonly vsGreyscale: number;
}

interface PanelReadout {
  readonly cellCount: number;
  readonly rowCount: number;
  readonly rowIds: readonly string[];
  readonly labels: readonly string[];
  readonly headers: readonly string[];
  readonly perDirection: Readonly<Record<string, number>>;
  readonly perChannel: Readonly<Record<string, number>>;
  readonly cells: readonly ChannelCell[];
  readonly diffs: readonly ChannelDiff[];
  /** Computed label colour per channel row - the chrome-untransformed assertion. */
  readonly labelColours: Readonly<Record<string, string>>;
  /** `<details>` elements anywhere under the board root. Must be zero. */
  readonly detailsCount: number;
  /** Ids of every element under the board root computing to `display: none`. */
  readonly hiddenIds: readonly string[];
  readonly bodyText: string;
}

/**
 * Read the whole channel panel back in ONE evaluate, after the board's single marker.
 *
 * The cross-cell diffs are computed IN HERE rather than by comparing two round trips:
 * two reads are two chances for the board to have rendered differently, and the whole
 * point of half (b) is a byte comparison between three cells of the same column.
 */
async function readPanel(page: Page): Promise<PanelReadout> {
  await page.locator('#art-board-readout[data-board-ready="1"]').waitFor({ state: 'attached' });
  return page.evaluate(
    ({ substrate, allowed, channels, directions }) => {
      const cellEls = [...document.querySelectorAll('[data-channel-cell]')];
      const allowedSet = new Set(allowed);
      const perDirection: Record<string, number> = {};
      const perChannel: Record<string, number> = {};
      const cells: ChannelCell[] = [];

      const bytesOf = (channel: string, direction: string): Uint8ClampedArray | null => {
        const el = document.querySelector(
          `[data-channel-cell][data-channel="${channel}"][data-direction="${direction}"] canvas`,
        ) as HTMLCanvasElement | null;
        if (el === null) return null;
        const g = el.getContext('2d', { willReadFrequently: true });
        if (g === null) return null;
        return g.getImageData(0, 0, el.width, el.height).data;
      };

      for (const el of cellEls) {
        const channel = el.getAttribute('data-channel') as string;
        const direction = el.getAttribute('data-direction') as string;
        perDirection[direction] = (perDirection[direction] ?? 0) + 1;
        perChannel[channel] = (perChannel[channel] ?? 0) + 1;
        const canvas = el.querySelector('canvas');
        let translucent = 0;
        let achromatic = 0;
        let inkRatio = 0;
        let inkRatioVsSubstrate = 0;
        let foreign = 0;
        let palette: string[] = [];
        let size = 'none';
        if (canvas !== null) {
          size = `${canvas.width}x${canvas.height}`;
          const g = canvas.getContext('2d', { willReadFrequently: true });
          if (g === null) throw new Error(`channel cell ${channel}/${direction} has no 2d context`);
          const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
          const counts = new Map<string, number>();
          let achro = 0;
          let differing = 0;
          for (let p = 0; p < data.length; p += 4) {
            if (data[p + 3] !== 255) translucent++;
            if (data[p] === data[p + 1] && data[p + 1] === data[p + 2]) achro++;
            if (
              data[p] !== substrate[0] ||
              data[p + 1] !== substrate[1] ||
              data[p + 2] !== substrate[2]
            ) {
              differing++;
            }
            const rgb = `${data[p]},${data[p + 1]},${data[p + 2]}`;
            if (!allowedSet.has(rgb)) foreign++;
            counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
          }
          const total = data.length / 4;
          palette = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
          achromatic = achro / total;
          inkRatioVsSubstrate = differing / total;
          // NON-EMPTINESS AGAINST THE CELL'S OWN MODAL VALUE, not against `#1b1f27`.
          // On a TRANSFORMED row the background is no longer `#1b1f27` - it is the
          // transform of it - so a "differs from #1b1f27" count returns ~100% for a
          // transformed cell whether or not it carries any artwork at all, which is
          // the same class of vacuous pass a missing `clearColor` produces. The modal
          // value IS the cell's background by construction (the arrangement occupies a
          // minority of a 200x200 box), so this reads 0 on a genuinely blank cell in
          // every one of the five rows.
          const modal = counts.get(palette[0] as string) ?? 0;
          inkRatio = (total - modal) / total;
        }
        cells.push({
          id: `${channel}/${direction}`,
          channel,
          direction,
          absent: el.getAttribute('data-absent'),
          error: el.getAttribute('data-error'),
          text: (el as HTMLElement).innerText.trim(),
          hasCanvas: canvas !== null,
          canvas: size,
          translucent,
          achromatic,
          inkRatio,
          inkRatioVsSubstrate,
          foreign,
          palette,
        });
      }

      // Half (b), computed byte by byte inside one read.
      const diffs: ChannelDiff[] = [];
      for (const direction of directions) {
        const colour = bytesOf('colour', direction);
        const grey = bytesOf('greyscale', direction);
        for (const channel of channels) {
          if (channel === 'colour' || channel === 'greyscale') continue;
          const t = bytesOf(channel, direction);
          if (t === null || colour === null || grey === null) {
            diffs.push({ id: `${channel}/${direction}`, vsColour: -1, vsGreyscale: -1 });
            continue;
          }
          let dc = 0;
          let dg = 0;
          let n = 0;
          const len = Math.min(t.length, colour.length, grey.length);
          for (let p = 0; p + 3 < len; p += 4) {
            n++;
            if (t[p] !== colour[p] || t[p + 1] !== colour[p + 1] || t[p + 2] !== colour[p + 2]) dc++;
            if (t[p] !== grey[p] || t[p + 1] !== grey[p + 1] || t[p + 2] !== grey[p + 2]) dg++;
          }
          diffs.push({ id: `${channel}/${direction}`, vsColour: dc / n, vsGreyscale: dg / n });
        }
      }

      const labelColours: Record<string, string> = {};
      for (const el of document.querySelectorAll('[data-channel-label]')) {
        labelColours[el.getAttribute('data-channel-label') as string] =
          getComputedStyle(el).color;
      }

      const root = document.getElementById('art-board-root') as HTMLElement;
      const hiddenIds: string[] = [];
      for (const el of root.querySelectorAll('*')) {
        if (getComputedStyle(el).display === 'none') {
          hiddenIds.push(el.id === '' ? `<${el.tagName.toLowerCase()}> with no id` : el.id);
        }
      }

      return {
        cellCount: cellEls.length,
        rowCount: document.querySelectorAll('[data-channel-row]').length,
        rowIds: [...document.querySelectorAll('[data-channel-row]')].map(
          (el) => el.getAttribute('data-channel-row') as string,
        ),
        labels: [...document.querySelectorAll('[data-channel-label]')].map((el) =>
          ((el as HTMLElement).textContent ?? '').trim(),
        ),
        headers: [...document.querySelectorAll('[data-channel-header]')].map(
          (el) => el.getAttribute('data-channel-header') as string,
        ),
        perDirection,
        perChannel,
        cells,
        diffs,
        labelColours,
        detailsCount: root.querySelectorAll('details').length,
        hiddenIds,
        bodyText: (document.body as HTMLElement).innerText,
      };
    },
    {
      substrate: SUBSTRATE_RGB as unknown as number[],
      allowed: ALLOWED_RGB as unknown as string[],
      channels: CHANNEL_ORDER as unknown as string[],
      directions: ['TODAY', 'A', 'B', 'C', 'D'],
    },
  );
}

test('art board: the channel panel holds exactly 25 cells, 5 per direction', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const panel = await readPanel(page);

    expect(panel.cellCount, '5 channel rows x 5 direction columns = 25 channel cells').toBe(
      CHANNEL_CELLS,
    );
    expect(panel.rowCount, 'five channel rows').toBe(CHANNEL_ROWS);

    // The order is printed on the board as fixed and carrying no ranking, so the board
    // has to actually hold to it - a re-sorted channel axis is advocacy no prose scan
    // would catch.
    expect(panel.rowIds, 'the channel rows are in the one fixed order').toEqual([
      'colour',
      'greyscale',
      'deutan',
      'protan',
      'tritan',
    ]);
    expect(panel.labels, 'each row label is the channel name, one word, in the same order').toEqual([
      'colour',
      'greyscale',
      'deutan',
      'protan',
      'tritan',
    ]);

    // The panel's column axis is the SAME axis as the slate's, and no direction may
    // quietly lose a channel row.
    expect(panel.headers, 'the panel columns read TODAY, A, B, C, D in DOM order').toEqual([
      'TODAY',
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(panel.perDirection, 'every direction column carries all five channels').toEqual({
      TODAY: CHANNEL_CELLS_PER_DIRECTION,
      A: CHANNEL_CELLS_PER_DIRECTION,
      B: CHANNEL_CELLS_PER_DIRECTION,
      C: CHANNEL_CELLS_PER_DIRECTION,
      D: CHANNEL_CELLS_PER_DIRECTION,
    });
    expect(panel.perChannel, 'every channel row carries all five directions').toEqual({
      colour: CELLS_PER_CHANNEL,
      greyscale: CELLS_PER_CHANNEL,
      deutan: CELLS_PER_CHANNEL,
      protan: CELLS_PER_CHANNEL,
      tritan: CELLS_PER_CHANNEL,
    });

    // Presence, and the backing store as a literal: 25 cells can be identically wrong.
    expect(
      panel.cells.filter((c) => c.canvas !== `${PANEL_CANVAS_PX}x${PANEL_CANVAS_PX}`).map((c) => `${c.id}: ${c.canvas}`),
      'all 25 cells rendered at exactly the 200 x 200 arrangement box - five images per ' +
        'direction from ONE extraction, so a size divergence means the derivation broke',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: every channel cell is opaque and non-empty', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const panel = await readPanel(page);

    // The alpha assertion FIRST. `clearColor` defaults to transparent, and on a
    // transparent buffer the extracted bytes are PREMULTIPLIED - so the CVD transform
    // would be handed dark, wrong colour, and every non-emptiness count below would
    // pass vacuously. This is the assertion mutation M5 exercises.
    expect(
      panel.cells.filter((c) => c.hasCanvas && c.translucent > 0).map((c) => `${c.id} (${c.translucent}px)`),
      'every extracted and every derived pixel is opaque - alpha 255 is where premultiplied ' +
        'and un-premultiplied are identical and the extraction quirk cannot bite the transform',
    ).toEqual([]);

    // Non-emptiness against each cell's OWN modal value - see the comment at the
    // computation. A "differs from #1b1f27" count is meaningless on a transformed row.
    expect(
      panel.cells
        .filter((c) => c.hasCanvas && c.inkRatio < MIN_INK_RATIO)
        .map((c) => `${c.id} (${(c.inkRatio * 100).toFixed(2)}% ink)`),
      'every one of the 25 cells carries real artwork rather than a flat background, measured ' +
        "against that cell's own most-frequent value so the check means the same thing on a " +
        'transformed row as on the untransformed one',
    ).toEqual([]);

    // And on the UNTRANSFORMED row only, the substrate is proven to be the real one -
    // which is what makes "the substrate is inside the transform" (D.2) a fact rather
    // than an intention.
    expect(
      panel.cells
        .filter((c) => c.channel === 'colour' && c.inkRatioVsSubstrate >= 1)
        .map((c) => c.id),
      'the colour row is drawn on the board substrate #1b1f27, so the transform receives the ' +
        'artwork AND its own background - a greyscale silhouette judged against an untransformed ' +
        'background would show a contrast that does not exist',
    ).toEqual([]);

    // THE BLACK-SQUARE GATE, on the colour row. `fill="none" stroke="none"` does NOT
    // blank a path: Pixi paints a SOLID BLACK SQUARE, which every ink-ratio assertion
    // dutifully counts as artwork. That trap has bitten three separate gates in this
    // milestone. The four transformed rows are DERIVED from these very bytes, so this
    // one assertion covers all 25 cells - a black square in the artwork reaches the
    // colour cell first, by construction.
    expect(
      panel.cells
        .filter((c) => c.channel === 'colour' && c.foreign > 0)
        .map((c) => `${c.id}: ${c.foreign}px outside the palette, observed ${c.palette.join(' ')}`),
      'every pixel of the untransformed row is a named LOCKED_SKIN value - the transformed rows ' +
        "are derived from these bytes, so this is what stops Pixi's silent black fill from " +
        'being counted as artwork anywhere on the panel',
    ).toEqual([]);

    // A cell with no artwork must SAY why, in words. Falling through to the
    // untransformed image is forbidden, so an error cell is the only legitimate
    // alternative to pixels here.
    expect(
      panel.cells
        .filter((c) => !c.hasCanvas && c.absent === null && c.error === null)
        .map((c) => c.id),
      'a channel cell with no pixels carries a labelled absent or error state, never a bare blank',
    ).toEqual([]);
    expect(
      panel.cells.filter((c) => (c.absent !== null || c.error !== null) && c.text.length === 0).map((c) => c.id),
      'every absent or error channel cell states in visible text what happened',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: the greyscale channel is achromatic (R == G == B)', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const panel = await readPanel(page);

    const grey = panel.cells.filter((c) => c.channel === 'greyscale');
    expect(grey.length, 'one greyscale cell per direction').toBe(CELLS_PER_CHANNEL);

    // HALF (a). Rec.709 luminance in linear light writes the same byte to all three
    // channels, so an achromatic fraction below 1 means the greyscale cell is carrying
    // colour it should not have - which is what an untransformed copy looks like.
    expect(
      grey
        .filter((c) => c.achromatic < 1)
        .map((c) => `${c.id}: ${(c.achromatic * 100).toFixed(4)}% of pixels have R == G == B`),
      'every pixel of every greyscale cell satisfies R == G == B',
    ).toEqual([]);

    // The other four rows are NOT achromatic, stated as an assertion rather than left
    // implied: if all five rows were grey, half (a) would be passing over a panel that
    // greyscaled everything, and half (b) alone would not name greyscale as the cause.
    expect(
      panel.cells
        .filter((c) => c.channel !== 'greyscale' && c.achromatic >= 1)
        .map((c) => c.id),
      'no row other than greyscale is achromatic - a board that greyscaled every row would ' +
        'satisfy half (a) while showing nothing about colour vision at all',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: each CVD channel differs from both the normal and the greyscale rendering', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const panel = await readPanel(page);

    // HALF (b), AND THE ASSERTION THE WHOLE PANEL RESTS ON. Without it an untransformed
    // deutan cell passes every other check on this board - and an untransformed deutan
    // cell is exactly what would let a direction look survivable when it is not.
    expect(panel.diffs.length, '3 CVD channels x 5 directions = 15 comparisons').toBe(15);

    expect(
      panel.diffs
        .filter((d) => d.vsColour < MIN_CHANNEL_DIFF)
        .map((d) => `${d.id}: ${(d.vsColour * 100).toFixed(2)}% differ from the colour cell`),
      'each CVD cell differs from the untransformed rendering of the same column - an identity ' +
        'copy of the colour bytes lands at 0% here (mutation M1)',
    ).toEqual([]);

    expect(
      panel.diffs
        .filter((d) => d.vsGreyscale < MIN_CHANNEL_DIFF)
        .map((d) => `${d.id}: ${(d.vsGreyscale * 100).toFixed(2)}% differ from the greyscale cell`),
      'each CVD cell also differs from the greyscale rendering of the same column, so a CVD row ' +
        'that quietly became a second greyscale row cannot pass as a simulation',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: the board chrome is not transformed in any channel row', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const panel = await readPanel(page);

    // The transform applies to the extracted cell pixels ONLY. Transforming the board's
    // own labels, separators and headings would make the tritan row unreadable as a
    // page - and asserted against a LITERAL, not merely row-against-row, because two
    // rows can agree with each other while both being wrong.
    expect(panel.labelColours.colour, 'the colour row label is drawn in the board ink').toBe(
      BOARD_INK_CSS,
    );
    expect(
      panel.labelColours.tritan,
      'the tritan row label is drawn in the SAME board ink - the chrome is never transformed',
    ).toBe(BOARD_INK_CSS);
    expect(
      Object.entries(panel.labelColours)
        .filter(([, colour]) => colour !== BOARD_INK_CSS)
        .map(([channel, colour]) => `${channel}: ${colour}`),
      'every channel row label is in the same untransformed board ink',
    ).toEqual([]);

    // The panel says out loud that it presents rather than asserts, because a reader
    // otherwise has to infer it - and the inference a colour-vision panel invites is
    // exactly the one this phase must not make on the maintainer's behalf.
    expect(
      panel.bodyText,
      'the panel states that it does not assert a verdict on any direction',
    ).toContain('This panel presents. It does not assert');
    expect(
      panel.bodyText,
      'the panel states that the channel row order carries no ranking meaning',
    ).toContain('Channel row order is fixed');
  } finally {
    await close();
  }
});

test('art board: nothing on the board hides anything', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const panel = await readPanel(page);

    // N10, rendered half. D-07 forbids the CVD toggle BY NAME, because a toggle means
    // it does not get looked at; this is the general form of that rule, measured on the
    // live page rather than grepped out of the source.
    expect(panel.detailsCount, 'no collapsible element exists anywhere on the board').toBe(0);

    expect(
      panel.hiddenIds,
      'the ONLY element on the board computing to display:none is the readiness marker, which is ' +
        'an out-of-flow data attribute rather than content - anything else hidden is a candidate, ' +
        'a channel or a subject a reader never sees',
    ).toEqual(['art-board-readout']);
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * The lane half of the gate (BOARD-03, D-10/D-11/D-12, plan 57-08)
 *
 * BOARD-03 locks ONE absolute number in px, and the whole strip exists so that the
 * number is chosen against the consequence of choosing it. Two failure modes would
 * corrupt that, and neither is visible to a reader:
 *
 *   1. A WIDTH SHOWN WITHOUT ITS FIGURE. An uninformed choice is exactly what
 *      BOARD-03 exists to prevent, so a row missing one of its six printed
 *      consequences fails here rather than being noticed at the lock.
 *   2. AN INSET THAT VARIES BY ROW. The magnification is the neutrality-critical
 *      parameter: a per-row "just enough to see it" factor would make every row look
 *      equally readable, which is the opposite of the finding. The crop, the factor
 *      and the canvas size are therefore asserted identical, in bytes and in layout.
 *
 * AND THE `R = 16` DEPENDENCY IS ASSERTED AS RENDERED TEXT. The four printed figures
 * reproduce at `BOARD_ELBOW_R = 16` and at nothing else, so the board has to name the
 * radius on itself rather than leave a reader to assume it.
 *
 * CORRECTED 2026-08-11 (v7.0 milestone audit, W-3). This paragraph used to continue
 * "the tree ships 15, and SEED-012's supersession is NOT SIGNED", and to explain that
 * the board says so "so that a Phase 61 refusal invalidates these figures rather than
 * moving them under a lane width that is already settled". Both halves stopped being
 * true on 2026-08-09, when the maintainer SIGNED `61-BELT-LOCK-SUPERSESSION.md` and plan 61-03
 * moved the shipped `ELBOW_R` to 16: the board and the tree CONVERGE, the anticipated
 * refusal did not happen, and the figures reproduce. The assertion body at the bottom
 * of this file was re-blessed correctly in that same commit and already states the
 * convergence; only this header kept describing the standoff. The guard's shape is
 * unchanged - it still fails if the board goes quiet about the radius.
 *
 * That the correction is landing two days late is itself the point: `npx tsc --noEmit`
 * typechecks ZERO e2e specs (`frontend/tsconfig.json` includes only `src`/`shared`, and
 * Playwright strips types via babel), and a docblock is invisible to the Playwright run
 * as well. Nothing in this tree can catch prose rot in this file. Read the assertions
 * below before trusting anything written above them.
 *
 * THE DIVISION OF LABOUR WITH THE UNIT SPECS, stated so a later plan does not
 * "strengthen" the wrong half. `src/spike/artBoardGeometry.test.ts` owns the
 * ARITHMETIC (the four figures, the constant lane width, the tangency, the tread
 * schedule) and the source checks over the GEOMETRY module;
 * `src/spike/artBoardLanes.source.test.ts` owns the source checks over the LANE
 * module - the no-typed-literal prohibition and the one-parameterisation rule. This
 * spec owns what is RENDERED: that the figures reach the DOM, that the strip is
 * complete, and that the inset is uniform in layout and DIFFERENT in pixels.
 *
 * A hardcoded figure in the lane module passes here BY CONSTRUCTION, because the e2e
 * reads the same rendered text either way - so it is the SOURCE spec that catches it.
 * That spec is `artBoardLanes.source.test.ts`, and it is named here rather than
 * gestured at: this block previously said "it is the source grep that catches it,
 * recorded in 57-08-SUMMARY.md's mutation table", and no such grep existed anywhere in
 * the tree (review WR-09). A mutation run recorded in a plan summary is evidence about
 * a past commit, not a gate on the next one.
 * ==================================================================== */

/** 4 lane widths x 4 candidate directions = 16 artwork cells. Hand-checkable. */
const LANE_CELLS = 16;
const LANE_ROWS = 4;
const LANE_CELLS_PER_DIRECTION = 4;
const LANE_INSETS = 4;
const LANE_NUMBERS = 4;

/** The four candidate widths, in the order the strip renders them. Literals. */
const LANE_ROW_IDS: readonly string[] = ['20', '24', '26', '28'];

/** The four candidate direction columns. TODAY is not one: the shipped belt is not drawn. */
const LANE_DIRECTIONS: readonly string[] = ['A', 'B', 'C', 'D'];

/**
 * The four inner-rail dashes BOARD-03 publishes, as the board must RENDER them.
 *
 * Literals, and deliberately the same four the unit spec pins: this assertion is that
 * the computed figures REACHED THE DOM in ascending-lane order, which is a different
 * claim from the arithmetic being right, and it is the claim a reader depends on.
 */
const LANE_INNER_DASHES: readonly string[] = ['3.750', '2.500', '1.875', '1.250'];

/** The six printed consequences every numbers cell must carry (57-UI-SPEC E.4). */
const LANE_FIGURE_KEYS: readonly string[] = [
  'inner-dash',
  'outer-dash',
  'outer-over-inner',
  'inner-over-lane',
  'corner-pinch',
  'joint-guard',
];

/** 16u crop at 8x, in every row. A literal: four canvases can be identically wrong. */
const INSET_CANVAS_PX = 128;

interface LaneCell {
  readonly id: string;
  readonly lane: string;
  readonly direction: string;
  readonly error: string | null;
  readonly hasCanvas: boolean;
  readonly canvas: string;
  readonly translucent: number;
  readonly inkRatio: number;
  readonly foreign: number;
  readonly palette: readonly string[];
}

/**
 * One magnified inset, read through the SAME pixel walk the artwork cells use
 * (review WR-02).
 *
 * Until this was added the inset column recorded its canvas SIZE and its CSS box and
 * nothing else - no alpha, no ink, no palette and no cross-row difference. An inset
 * that rendered a flat substrate square, or four byte-identical images, or the
 * `fill="none" stroke="none"` black square the rest of this file guards against three
 * separate times, passed every assertion in the suite: sizes equal, boxes equal,
 * captions character-identical. This is the ONE column whose stated job is showing the
 * inner-rail mark that is not legible at any of these zooms, and `renderInsetCell`'s
 * docblock claimed "both are asserted by the strip's spec" when only one was.
 */
interface LaneInset {
  readonly lane: string;
  readonly canvas: string;
  readonly translucent: number;
  readonly inkRatio: number;
  readonly foreign: number;
  readonly palette: readonly string[];
  /** FNV-1a over the whole RGBA buffer. Four identical insets is a FAILURE, not a pass. */
  readonly digest: string;
}

interface LaneReadout {
  readonly cellCount: number;
  readonly rowCount: number;
  readonly rowIds: readonly string[];
  readonly perDirection: Readonly<Record<string, number>>;
  readonly cells: readonly LaneCell[];
  readonly insetCount: number;
  readonly insetCanvases: readonly string[];
  readonly insetRects: readonly string[];
  readonly insetPixels: readonly (LaneInset | null)[];
  readonly insetCaptions: readonly string[];
  readonly numbersCount: number;
  /** Per lane row: the figure keys present, in DOM order. */
  readonly figureKeys: readonly { readonly lane: string; readonly keys: readonly string[] }[];
  /** Every rendered inner-rail dash, in DOM order. */
  readonly innerDashes: readonly string[];
  /** Elements under the strip that would let a reader change a width. */
  readonly controlCount: number;
  readonly stripText: string;
}

/** Read the whole lane strip back in ONE evaluate, after the board's single marker. */
async function readLanes(page: Page): Promise<LaneReadout> {
  await page.locator('#art-board-readout[data-board-ready="1"]').waitFor({ state: 'attached' });
  return page.evaluate(
    ({ substrate, allowed }) => {
      const allowedSet = new Set(allowed);

      /**
       * ONE pixel walk, for the artwork cells AND for the magnified insets (WR-02).
       *
       * Shared rather than written twice on purpose: the inset column was previously
       * exempt from every pixel property the artwork cells are held to, and a second
       * copy of this walk is how that exemption would quietly come back.
       */
      const walk = (
        canvas: HTMLCanvasElement,
        label: string,
      ): {
        size: string;
        translucent: number;
        inkRatio: number;
        foreign: number;
        palette: string[];
        digest: string;
      } => {
        const g = canvas.getContext('2d', { willReadFrequently: true });
        if (g === null) throw new Error(`${label} has no 2d context`);
        const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
        const counts = new Map<string, number>();
        let translucent = 0;
        let differing = 0;
        let foreign = 0;
        // FNV-1a over every byte, alpha included. `Math.imul` keeps the multiply in
        // 32-bit so the digest is stable across engines.
        let hash = 0x811c9dc5;
        for (let p = 0; p < data.length; p += 4) {
          if (data[p + 3] !== 255) translucent++;
          if (
            data[p] !== substrate[0] ||
            data[p + 1] !== substrate[1] ||
            data[p + 2] !== substrate[2]
          ) {
            differing++;
          }
          const rgb = `${data[p]},${data[p + 1]},${data[p + 2]}`;
          if (!allowedSet.has(rgb)) foreign++;
          counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
        }
        for (let i = 0; i < data.length; i++) {
          hash ^= data[i] as number;
          hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return {
          size: `${canvas.width}x${canvas.height}`,
          translucent,
          inkRatio: differing / (data.length / 4),
          foreign,
          palette: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
          digest: hash.toString(16),
        };
      };

      const cellEls = [...document.querySelectorAll('[data-lane-cell]')];
      const perDirection: Record<string, number> = {};
      const cells: LaneCell[] = [];

      for (const el of cellEls) {
        const lane = el.getAttribute('data-lane') as string;
        const direction = el.getAttribute('data-direction') as string;
        perDirection[direction] = (perDirection[direction] ?? 0) + 1;
        const canvas = el.querySelector('canvas');
        const m =
          canvas === null
            ? null
            : walk(canvas as HTMLCanvasElement, `lane cell ${lane}/${direction}`);
        cells.push({
          id: `${lane}/${direction}`,
          lane,
          direction,
          error: el.getAttribute('data-error'),
          hasCanvas: canvas !== null,
          canvas: m?.size ?? 'none',
          translucent: m?.translucent ?? 0,
          inkRatio: m?.inkRatio ?? 0,
          foreign: m?.foreign ?? 0,
          palette: m?.palette ?? [],
        });
      }

      const insetEls = [...document.querySelectorAll('[data-inset]')];
      const numbersEls = [...document.querySelectorAll('[data-numbers]')];
      const strip = document.getElementById('art-board-lanes') as HTMLElement;

      return {
        cellCount: cellEls.length,
        rowCount: document.querySelectorAll('[data-lane-row]').length,
        rowIds: [...document.querySelectorAll('[data-lane-row]')].map(
          (el) => el.getAttribute('data-lane-row') as string,
        ),
        perDirection,
        cells,
        insetCount: insetEls.length,
        insetCanvases: insetEls.map((el) => {
          const c = el.querySelector('canvas');
          return c === null ? 'none' : `${c.width}x${c.height}`;
        }),
        // getBoundingClientRect, NEVER offsetWidth: a sub-pixel divergence between two
        // rows' insets is exactly the "one row is magnified more" failure, and
        // offsetWidth rounds it away.
        insetRects: insetEls.map((el) => {
          const c = el.querySelector('canvas');
          if (c === null) return 'none';
          const r = c.getBoundingClientRect();
          return `${r.width}x${r.height}`;
        }),
        // The inset's PIXELS, through the same walk the artwork cells use (WR-02).
        insetPixels: insetEls.map((el) => {
          const c = el.querySelector('canvas');
          const lane = el.getAttribute('data-lane') as string;
          if (c === null) return null;
          const m = walk(c as HTMLCanvasElement, `lane inset ${lane}`);
          return {
            lane,
            canvas: m.size,
            translucent: m.translucent,
            inkRatio: m.inkRatio,
            foreign: m.foreign,
            palette: m.palette,
            digest: m.digest,
          };
        }),
        insetCaptions: [...document.querySelectorAll('[data-inset-caption]')].map((el) =>
          ((el as HTMLElement).textContent ?? '').trim(),
        ),
        numbersCount: numbersEls.length,
        figureKeys: numbersEls.map((el) => ({
          lane: el.getAttribute('data-lane') as string,
          keys: [...el.querySelectorAll('[data-figure]')].map(
            (f) => f.getAttribute('data-figure') as string,
          ),
        })),
        innerDashes: [...document.querySelectorAll('[data-inner-dash]')].map((el) =>
          ((el as HTMLElement).textContent ?? '').trim(),
        ),
        controlCount: strip.querySelectorAll(
          'input, select, button, textarea, details, [type="range"], [role="slider"]',
        ).length,
        stripText: strip.innerText,
      };
    },
    {
      substrate: SUBSTRATE_RGB as unknown as number[],
      allowed: ALLOWED_RGB as unknown as string[],
    },
  );
}

test('art board: the lane strip holds exactly 16 artwork cells, 4 per direction', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    expect(lanes.cellCount, '4 lane widths x 4 candidate directions = 16 artwork cells').toBe(
      LANE_CELLS,
    );
    expect(lanes.rowCount, 'four candidate widths, four rows').toBe(LANE_ROWS);

    // Ascending, and stated on the board as carrying no ranking - so the board has to
    // actually hold to it. A missing width would leave the remaining three reading as
    // the whole comparison.
    expect(lanes.rowIds, 'the four widths render in ascending order').toEqual(LANE_ROW_IDS);

    expect(lanes.perDirection, 'every candidate direction carries all four widths').toEqual({
      A: LANE_CELLS_PER_DIRECTION,
      B: LANE_CELLS_PER_DIRECTION,
      C: LANE_CELLS_PER_DIRECTION,
      D: LANE_CELLS_PER_DIRECTION,
    });
    expect(
      [...new Set(lanes.cells.map((c) => c.direction))].sort(),
      'the strip has no TODAY column: the shipped belt is the geometry it does not draw',
    ).toEqual([...LANE_DIRECTIONS]);

    // The inset and the numbers columns are NOT artwork cells and are counted apart.
    expect(lanes.insetCount, 'one magnified inset per width').toBe(LANE_INSETS);
    expect(lanes.numbersCount, 'one numbers cell per width').toBe(LANE_NUMBERS);

    expect(
      lanes.cells.filter((c) => !c.hasCanvas).map((c) => c.id),
      'all 16 artwork cells rendered through extractCell',
    ).toEqual([]);
    expect(
      lanes.cells.filter((c) => c.error !== null).map((c) => `${c.id} (${c.error})`),
      'no width failed to build its geometry',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: every lane artwork cell is opaque and non-empty', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    // The alpha assertion FIRST, for the reason it is first everywhere else on this
    // board: on a transparent premultiplied buffer the ink count below returns ~100%
    // for every cell including a blank one, and the non-emptiness check passes
    // vacuously over the whole strip.
    expect(
      lanes.cells
        .filter((c) => c.hasCanvas && c.translucent > 0)
        .map((c) => `${c.id} (${c.translucent}px)`),
      'every extracted pixel of every lane cell is opaque',
    ).toEqual([]);

    expect(
      lanes.cells
        .filter((c) => c.hasCanvas && c.inkRatio < MIN_INK_RATIO)
        .map((c) => `${c.id} (${(c.inkRatio * 100).toFixed(2)}% ink)`),
      'every lane cell carries real artwork rather than a blank substrate',
    ).toEqual([]);

    // THE BLACK-SQUARE GATE. `fill="none" stroke="none"` does not blank a path - Pixi
    // paints a SOLID BLACK SQUARE that every ink-ratio assertion counts as artwork.
    // That trap has bitten four gates in this milestone; the allowlist is the only
    // assertion that catches it, and it catches any antialiased edge for free.
    expect(
      lanes.cells
        .filter((c) => c.hasCanvas && c.foreign > 0)
        .map((c) => `${c.id}: ${c.foreign}px outside the palette, observed ${c.palette.join(' ')}`),
      'every pixel of every lane cell is a named LOCKED_SKIN value',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: the four printed lane inner-rail dashes are 3.750 / 2.500 / 1.875 / 1.250', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    // READ FROM THE RENDERED DOM, in ascending-lane order. This is the assertion that
    // the derivation reached the reader: the arithmetic is pinned in the unit spec, and
    // a board that computed correctly and printed nothing would pass that and fail here.
    expect(
      lanes.innerDashes,
      'the four inner-rail dashes render at 3 dp, in ascending-lane order - the figures BOARD-03 ' +
        'publishes, which reproduce at BOARD_ELBOW_R = 16 and at no other radius',
    ).toEqual(LANE_INNER_DASHES);
  } finally {
    await close();
  }
});

test('art board: every lane row carries all six consequence figures', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    // S3/partial. A width shown WITHOUT its printed consequence fails, because an
    // uninformed choice is the thing BOARD-03 exists to prevent - and the two figures
    // that agree across all four rows (the corner pinch and the axis-3 joint guard) are
    // required here too. A column where all four rows agree is a non-discriminator, and
    // showing it is what tells a reader it did not decide anything.
    expect(
      lanes.figureKeys.map((f) => f.lane),
      'one numbers cell per width, in ascending order',
    ).toEqual(LANE_ROW_IDS);

    expect(
      lanes.figureKeys
        .filter((f) => f.keys.join(',') !== LANE_FIGURE_KEYS.join(','))
        .map((f) => `${f.lane}: ${f.keys.join(',')}`),
      'every width prints all six consequences, in the same order in every row',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: the 8x lane inset is identical in crop, factor and canvas size in all four rows', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    // THE NEUTRALITY-CRITICAL ASSERTION. A per-row magnification would make every row
    // look equally readable, which is the exact opposite of the finding the inset
    // exists to show - and it would be invisible to a reader, because each row would
    // look perfectly reasonable on its own.
    expect(
      lanes.insetCanvases,
      'every inset backing store is exactly the 16u crop at 8x - asserted as a literal, because ' +
        'four canvases can be identically wrong',
    ).toEqual([
      `${INSET_CANVAS_PX}x${INSET_CANVAS_PX}`,
      `${INSET_CANVAS_PX}x${INSET_CANVAS_PX}`,
      `${INSET_CANVAS_PX}x${INSET_CANVAS_PX}`,
      `${INSET_CANVAS_PX}x${INSET_CANVAS_PX}`,
    ]);

    // The CSS box too: a backing store can be identical while one row is presented
    // larger, and presentation is what a reader compares.
    expect(lanes.insetRects.length, 'four insets were measured').toBe(LANE_INSETS);
    expect(
      lanes.insetRects.filter((r) => r !== lanes.insetRects[0]),
      'every inset is laid out at exactly the same size, to sub-pixel precision',
    ).toEqual([]);

    // And the factor is PRINTED, character-identical in every row. A printed factor
    // that varied would be the same failure stated in words.
    expect(lanes.insetCaptions.length, 'every row prints the inset caption').toBe(LANE_INSETS);
    expect(
      lanes.insetCaptions.filter((c) => c !== lanes.insetCaptions[0]),
      'the printed crop-and-magnification caption is character-identical in all four rows',
    ).toEqual([]);
    expect(
      lanes.insetCaptions[0],
      'the caption names the window, the factor and the interpolation',
    ).toBe('inner rail, 16u window at 8x, nearest - identical crop and magnification in all four rows');
  } finally {
    await close();
  }
});

test('art board: every lane inset is opaque, in-palette, non-empty and DIFFERENT from the other three', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    // WR-02. The inset column had its canvas SIZE asserted and its PIXELS asserted
    // nowhere, which left the one column whose stated job is "showing the inner-rail
    // mark, which is not legible at any of these zooms" as the only column that could
    // render nothing and stay green. Everything below is the artwork cells' own set of
    // pixel properties, applied to the four insets.

    expect(
      lanes.insetPixels.filter((i) => i === null).length,
      'all four insets rendered a canvas',
    ).toBe(0);
    const insets = lanes.insetPixels.filter((i): i is NonNullable<typeof i> => i !== null);
    expect(insets.length, 'four insets were read').toBe(LANE_INSETS);
    expect(
      insets.map((i) => i.lane),
      'the insets read back in ascending-lane order',
    ).toEqual(LANE_ROW_IDS);

    // Alpha FIRST, for the reason it is first everywhere else on this board: on a
    // transparent premultiplied buffer the ink count below returns ~100% for every
    // canvas including a blank one, and the non-emptiness check passes vacuously.
    expect(
      insets.filter((i) => i.translucent > 0).map((i) => `${i.lane} (${i.translucent}px)`),
      'every pixel of every inset is opaque',
    ).toEqual([]);

    expect(
      insets
        .filter((i) => i.inkRatio < MIN_INK_RATIO)
        .map((i) => `${i.lane} (${(i.inkRatio * 100).toFixed(2)}% ink)`),
      'every inset carries real belt geometry rather than a flat substrate square',
    ).toEqual([]);

    // THE BLACK-SQUARE GATE, applied to the insets. `fill="none" stroke="none"` does
    // not blank a path - Pixi paints a SOLID BLACK SQUARE that every ink-ratio
    // assertion counts as artwork. The magnification is nearest-neighbour at an exact
    // integer factor, so it invents no colour: the inset palette is the artwork
    // palette, and any pixel outside it is a real defect rather than a resampling
    // artefact.
    expect(
      insets
        .filter((i) => i.foreign > 0)
        .map((i) => `${i.lane}: ${i.foreign}px outside the palette, observed ${i.palette.join(' ')}`),
      'every pixel of every inset is a named LOCKED_SKIN value',
    ).toEqual([]);

    // THE ASSERTION THE COLUMN ACTUALLY EXISTS FOR. Four identical insets is the
    // "every row looks equally readable" failure the whole column exists to refuse -
    // and it is the failure that a uniform crop, a uniform factor and a uniform canvas
    // size all pass. The four rows put their inner rails at radii 6 / 4 / 3 / 2 about
    // the arc centre, every one of them inside the shared crop, so four DISTINCT
    // digests is the property the drawing has to hold.
    const digests = insets.map((i) => i.digest);
    expect(
      new Set(digests).size,
      `the four insets are four different images, not one repeated: ${insets
        .map((i) => `${i.lane}=${i.digest}`)
        .join(' ')}`,
    ).toBe(LANE_INSETS);
  } finally {
    await close();
  }
});

test('art board: the lane strip states the R = 16 CONVERGENCE and omits the 0.25-0.35 band', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    // RE-BLESSED BY PLAN 61-03, IN THE SAME COMMIT AS THE CONSTANT MOVE, and the four
    // strings below inverted rather than drifted - so each one is restated with what it
    // used to say, because "the assertion changed" is worth less than "the fact did".
    //
    // WHAT THIS TEST USED TO GUARD. These figures are only true at radius 16; the tree
    // shipped 15, and SEED-012's supersession carried no signature. The board said so
    // on itself so that a Phase 61 REFUSAL would invalidate the figures rather than
    // move them under a lane width that was already settled.
    //
    // WHAT HAPPENED. Phase 61 did not refuse. The maintainer SIGNED
    // `61-BELT-LOCK-SUPERSESSION.md` on 2026-08-09 and plan 61-03 moved the shipped
    // `ELBOW_R` to 16, so the board and the tree converge and BOARD-03's published
    // figures reproduce. The guard is still a guard - it now holds the board to stating
    // the CONVERGENCE, and it still fails if the board goes quiet about the radius.
    //
    // NOTE: `npx tsc --noEmit` typechecks ZERO e2e specs (tsconfig includes only
    // `src`/`shared`). The Playwright run is the ONLY gate for this edit.
    expect(lanes.stripText, 'the strip names the radius its figures assume').toContain(
      'BOARD_ELBOW_R = 16',
    );
    // Asserted through its full sentence fragment, NOT as the bare string `ELBOW_R = 16`:
    // that substring is contained in `BOARD_ELBOW_R = 16` above, so a board that had
    // stopped naming the shipped constant entirely would still satisfy a bare check.
    // Was: `toContain('ELBOW_R = 15')`.
    expect(lanes.stripText, 'and names the radius the tree actually ships').toContain(
      'frontend/shared/geometry.ts carries ELBOW_R = 16',
    );
    // The four figures recomputed against the SHIPPED constant. They used to be
    // `3.33 / 2.00 / 1.33 / 0.67` - four numbers none of which appears in BOARD-03 -
    // and they are now the strip's OWN inner-rail row, which is what convergence means
    // and is a stronger statement than either number alone.
    expect(
      lanes.stripText,
      "and prints what the four widths give at the shipped radius, which is now BOARD-03's " +
        'own published row rather than four numbers that replace it',
    ).toContain('3.75 / 2.50 / 1.88 / 1.25');
    // THE FOURTH STRING WAS REPLACED RATHER THAN NEGATED. It used to assert that the
    // strip described the supersession as carrying no signature. The obvious re-bless
    // is the negation of that string - but the POSITIVE pair below is the same guard
    // and a better one: a caption that regressed to the old wording would fail these
    // two just as surely, while these also fail a caption that says nothing at all
    // about the signature. The negated form is deliberately NOT kept beside them,
    // because the two together would be one assertion written twice.
    expect(lanes.stripText, 'and names the signature that authorised the radius').toContain(
      'SIGNED 61-BELT-LOCK-SUPERSESSION.md',
    );
    expect(lanes.stripText, 'and the signing date itself').toContain('2026-08-09');

    // SEED-012's cited readable inner:lane band is an EXTERNAL research figure that
    // exactly one of the four widths falls inside. Printing it beside the rows would be
    // a recommendation rendered as a fact. It belongs once, cited, in the lock file's
    // provenance section - and nowhere on the instrument.
    expect(lanes.stripText.match(/0\.25/g) ?? [], 'the strip does not print 0.25').toEqual([]);
    expect(lanes.stripText.match(/0\.35/g) ?? [], 'the strip does not print 0.35').toEqual([]);
  } finally {
    await close();
  }
});

test('art board: the lane strip carries zero controls', async ({ browser }) => {
  const { page, close } = await openBoard(browser);
  try {
    const lanes = await readLanes(page);

    // N3/N4, and D-09's own reasoning: a continuous slider invites fiddling and
    // produces no lockable number, and the board's output has to be a value a human can
    // write into 57-ART-LOCK.md. Four fixed rows, and nothing that changes a width.
    expect(
      lanes.controlCount,
      'no input, select, button, slider or collapsible exists anywhere under the lane strip',
    ).toBe(0);
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * The neutrality gate, rendered half (BOARD-02, D-14 as widened by D-17,
 * plan 57-09)
 *
 * D-14 makes "the board advocates nothing" machine-checkable AS PROSE, and D-17
 * widens the token list because a neutrality gate that can be walked around with a
 * synonym is not a gate. This block is one of the gate's two halves; the other is
 * `scripts/check-neutrality.sh`, over the two markdown artifacts.
 *
 * WHY `innerText` AND NOT `textContent`. `textContent` includes text inside
 * `display:none` nodes. N10 forbids those anyway - the board's only hidden element is
 * the readiness marker, and a separate test asserts exactly that - so on a clean tree
 * the two agree. `innerText` is nevertheless the honest choice, because it is what a
 * reader actually SEES, and what a reader sees is what D-14 is about.
 *
 * WHY THE SCAN IS SCOPED TO THE RENDERED TEXT AND NOT TO SOURCE. Measured on this
 * tree, a source-scoped scan over `src/spike/artBoard*` returns 21 hits and every one
 * is legitimate: `export default`, a `switch` `default:` arm, Pixi's own
 * `defaultAnchor`, and eleven occurrences inside the board modules' own docblocks
 * where the words appear as prose ABOUT the rule rather than as a violation of it. A
 * scan that is permanently red gets weakened into uselessness, so this one is scoped
 * to the only surface the rule is actually about.
 *
 * THE NON-VACUITY HALF IS NOT OPTIONAL. A token scan over an empty string reports
 * zero hits and passes. The captured text is therefore asserted to be longer than a
 * stated floor, so an empty or unbuilt board FAILS here rather than returning the
 * cleanest neutrality result on record.
 *
 * AND THE SATURATION CHECK REPLACES N6's HEX LIST. N6 as specified asserts that the
 * five `LOCKED_SKIN` accent hexes are absent from the board's CSS - which an
 * arbitrary chroma (`#ff0000`, `red`, an `hsl()`) passes while violating the stated
 * claim that the only saturated colour a reader sees belongs to the artwork. The
 * check below reads every colour the board's CHROME actually resolves to and asserts
 * its chroma, so the assertion is now as strong as the prose. 57-RESEARCH F8.4
 * recorded this as a known gap; it is closed here.
 * ==================================================================== */

/**
 * D-14's five, widened by D-17's eight. Thirteen, lower-case, matched by SUBSTRING so
 * `preferred` and `defaulted` are caught.
 *
 * Mirrored as literals rather than imported from the shell gate, deliberately: this
 * spec is not typechecked (see the file header) and the two halves of the gate are
 * meant to be independently readable. A drift between this list and
 * `scripts/check-neutrality.sh`'s IS a finding.
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
 * The non-vacuity floor for the token scan. An empty scan is a FAILURE.
 *
 * 500 is a floor, not a measurement. MEASURED on a clean tree the board renders
 * **10 271 characters** - the four-line standing header, 27 slate row labels, 32 cost
 * cells, 25 channel labels and four lane rows - so the floor sits at about 5% of the
 * real corpus and is nowhere near it. Anything that collapses the board below this has
 * broken, and a scan over the wreckage must not report a clean result.
 */
const MIN_BOARD_TEXT_CHARS = 500;

/**
 * The chroma ceiling for the board's own chrome, as `max(r,g,b) - min(r,g,b)` on the
 * 0-255 byte scale.
 *
 * 32 is chosen from a 5x gap rather than tuned. `LOCKED_SKIN`'s ramp is a COOL neutral
 * grey-steel, not a pure grey, so its own steps carry real chroma: `#1b1f27` is 12,
 * `#565f70` is 26 and `#b0bacb` is 27 - the ramp tops out at 27. The five accents this
 * check exists to exclude sit at 159 (`#34d399`), 160 (`#f0506e`), 171 (`#ffb454`),
 * 176 (`#4fa8ff`) and 177 (`#4ee0ff`), and a bare `#ff0000` is 255. Any threshold in
 * 28..158 gives the identical answer on every colour either side, which is what makes
 * the number uninteresting rather than load-bearing.
 */
const MAX_CHROME_CHROMA = 32;

/**
 * The non-vacuity floor for the saturation walk, in colour observations.
 *
 * The walk resolves eight colour properties over every non-artwork element under
 * `#art-board-root`. MEASURED on a clean tree it makes **5 416 observations**, so the
 * floor sits at about 9% of the real corpus. A walk that finds almost nothing has lost
 * its corpus - a renamed root, an early `continue`, a selector that stopped matching -
 * and must fail rather than report zero saturated colours over zero colours.
 */
const MIN_CHROME_OBSERVATIONS = 500;

interface NeutralityReadout {
  /** `#art-board-root`'s rendered text length. The non-vacuity half. */
  readonly textLength: number;
  /** Every banned token present, with the surrounding text as a locator. */
  readonly tokenHits: readonly string[];
  /** Non-artwork elements walked. */
  readonly elements: number;
  /** Colour observations made over those elements. The non-vacuity half. */
  readonly observations: number;
  /** The highest chroma observed anywhere on the chrome. Diagnostic. */
  readonly maxChroma: number;
  /** Every observation above the ceiling, named. */
  readonly saturated: readonly string[];
  /** Every colour string the parser did not understand. A check that cannot run FAILS. */
  readonly unparsed: readonly string[];
}

/**
 * Read both neutrality properties off the settled board in one pass.
 *
 * ATTACHED, not visible, for the same reason every other reader in this file waits
 * that way: the readiness marker is an out-of-flow `display:none` data attribute.
 */
async function readNeutrality(page: Page): Promise<NeutralityReadout> {
  await page.locator('#art-board-readout[data-board-ready="1"]').waitFor({ state: 'attached' });
  return page.evaluate(
    ({ tokens, ceiling }) => {
      const root = document.getElementById('art-board-root');
      if (root === null) {
        throw new Error('#art-board-root is absent - the token scan has no corpus to read');
      }

      // --- the token scan ---------------------------------------------------
      const text = (root as HTMLElement).innerText.toLowerCase();
      const tokenHits: string[] = [];
      for (const token of tokens) {
        let from = 0;
        for (;;) {
          const at = text.indexOf(token, from);
          if (at === -1) break;
          // Report the token AND its context, so a red gate is a rewording job
          // rather than a hunt through a 27-row board.
          tokenHits.push(`"${token}" @${at}: ...${text.slice(Math.max(0, at - 40), at + 40)}...`);
          from = at + token.length;
        }
      }

      // --- the saturation walk ---------------------------------------------
      // CHROME ONLY. The cell canvases are the ARTWORK, and the artwork is the one
      // thing on this page that is allowed to be saturated - excluding them is the
      // whole content of the rule, not a convenience.
      const PROPS = [
        'color',
        'backgroundColor',
        'borderTopColor',
        'borderRightColor',
        'borderBottomColor',
        'borderLeftColor',
        'outlineColor',
        'textDecorationColor',
      ] as const;

      const saturated: string[] = [];
      const unparsed: string[] = [];
      let elements = 0;
      let observations = 0;
      let maxChroma = 0;

      const describe = (el: Element): string => {
        const id = el.id === '' ? '' : `#${el.id}`;
        const row = el.getAttribute('data-slate-row') ?? el.getAttribute('data-lane-row') ?? '';
        const dir = el.getAttribute('data-direction') ?? '';
        const label = `${el.tagName.toLowerCase()}${id}${row === '' ? '' : `[${row}]`}${
          dir === '' ? '' : `[${dir}]`
        }`;
        return label;
      };

      for (const el of [root, ...root.querySelectorAll('*')]) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'canvas' || tag === 'img' || tag === 'svg') continue;
        elements++;
        const cs = getComputedStyle(el);
        for (const prop of PROPS) {
          const value = cs[prop] as string;
          if (value === '' || value === 'none' || value === 'transparent') continue;
          if (!value.startsWith('rgb')) {
            // A colour format this parser does not understand is NOT skipped: a
            // check that cannot run fails rather than passing over what it could
            // not read.
            unparsed.push(`${describe(el)} ${prop}=${value}`);
            continue;
          }
          const nums = value.match(/[\d.]+/g);
          if (nums === null || nums.length < 3) {
            unparsed.push(`${describe(el)} ${prop}=${value}`);
            continue;
          }
          const alpha = nums.length > 3 ? Number(nums[3]) : 1;
          if (alpha === 0) continue;
          const r = Number(nums[0]);
          const g = Number(nums[1]);
          const b = Number(nums[2]);
          const chroma = Math.max(r, g, b) - Math.min(r, g, b);
          observations++;
          if (chroma > maxChroma) maxChroma = chroma;
          if (chroma > ceiling) {
            saturated.push(`${describe(el)} ${prop}=${value} chroma=${chroma}`);
          }
        }
      }

      return {
        textLength: text.length,
        tokenHits,
        elements,
        observations,
        maxChroma,
        saturated,
        unparsed,
      };
    },
    { tokens: BANNED_TOKENS as unknown as string[], ceiling: MAX_CHROME_CHROMA },
  );
}

test('art board: neutrality-tokens - no advocacy token appears in the rendered text', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const neutrality = await readNeutrality(page);

    // THE NON-VACUITY HALF, FIRST. A scan over an empty corpus reports zero hits and
    // would otherwise be the cleanest result this gate can produce.
    expect(
      neutrality.textLength,
      'the board rendered real text for the scan to run over - an empty scan is a FAILURE, ' +
        'never a vacuous pass',
    ).toBeGreaterThan(MIN_BOARD_TEXT_CHARS);

    // Report-all, never first-fail: every token that hit, with its context, so the
    // resolution is a rewording of the copy rather than a hunt. And the resolution is
    // never to shorten BANNED_TOKENS - that is the documented failure mode.
    expect(
      neutrality.tokenHits,
      'no advocacy token from D-14 as widened by D-17 appears anywhere in the text a reader sees',
    ).toEqual([]);
  } finally {
    await close();
  }
});

test('art board: neutrality - the board chrome is achromatic by saturation, not by hex list', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const neutrality = await readNeutrality(page);

    // A colour the parser could not read is a check that could not run. It fails.
    expect(
      neutrality.unparsed,
      'every colour the board resolves was parseable - an unreadable colour format is a check ' +
        'that could not run, and a check that cannot run fails rather than skipping',
    ).toEqual([]);

    // The non-vacuity half of THIS check: a walk that lost its corpus reports zero
    // saturated colours over zero colours.
    expect(
      neutrality.observations,
      'the saturation walk actually resolved colours off the live board',
    ).toBeGreaterThan(MIN_CHROME_OBSERVATIONS);

    // N6, in its strong form. The five-accent hex list this replaces would pass on a
    // bare #ff0000; a chroma assertion cannot.
    expect(
      neutrality.saturated,
      `every colour on the board's own chrome is within ${MAX_CHROME_CHROMA} of neutral - the ` +
        'only saturated colour a reader sees belongs to the artwork',
    ).toEqual([]);
  } finally {
    await close();
  }
});

/* ==================================================================== *
 * LEGIBILITY: rendered text stays inside the box that owns it
 * (57-VERIFICATION W1)
 *
 * WHAT THIS CLOSES, AND WHY NOTHING ELSE IN THIS FILE COULD. Verification of this
 * phase found 23 of the board's 256 leaf text nodes painting roughly 3x past their
 * own 192px box, straight across the following columns' text: the five column
 * descriptions (616-702px wide), the fifteen BELT lock notes (554px) and the three
 * TODAY x ENDPOINT absence notes (911px). Cause: the slate row and the header row are
 * `white-space: nowrap` so their five inline-block cells stay on one line, and that
 * declaration INHERITED into fixed-width `overflow: visible` prose.
 *
 * Every gate in this file was green over it, and neither code-review pass saw it:
 *   - the cell-geometry sweep measures BOXES. The boxes never overlapped - that was
 *     verified independently, 0 box overlaps - because CSS overflow paints OUTSIDE
 *     the box without changing it. A box-only assertion is structurally blind here.
 *   - the neutrality scan reads `innerText`, which returns the complete string
 *     whatever it does on screen. A token scan cannot see paint.
 *   - there is no pixel baseline for the board (see the file header), by design.
 * So this is not a gate that was weakened; it is a class of defect the existing
 * assertions cannot express. This block adds the missing expression.
 *
 * HOW THE PAINTED EXTENT IS MEASURED. A `Range` over the element's contents, not
 * `scrollWidth` and not the element rect. `getBoundingClientRect` on the ELEMENT
 * returns the box, which is exactly the thing that stayed innocent; `scrollWidth` is
 * rounded to an integer and is 0 for an inline. A Range's client rect is the union of
 * the text's own line boxes - i.e. the ink - at sub-pixel precision, which is the only
 * quantity that answers "does this string paint over its neighbour".
 *
 * BOTH HALVES ARE ASSERTED. Own-box overflow is the general class gate and covers
 * every string on the board including the ones in no column at all; column overflow
 * is the specific harm, and it names the column in its diagnostic so a red gate is a
 * one-line CSS fix rather than a hunt through a 27-row board.
 * ==================================================================== */

/**
 * The elements that constitute a COLUMN for this check: the four grid sections' cells
 * plus the sticky slate headers.
 *
 * The cost table is deliberately absent. Its cells are already covered by the own-box
 * half, and `every cost-table header sits over its own column` above owns the
 * header/column relationship there with a sharper assertion (left edges, 8px).
 */
const COLUMN_SELECTOR =
  '[data-cell], [data-direction-header], [data-lane-cell], [data-channel-cell]';

/**
 * The overhang, in px, at which a string counts as painting outside its box.
 *
 * MEASURED on the fixed tree the worst overhang anywhere on the board is exactly
 * **0.000px** against the own box and **-0.594px** against the column content edge -
 * wrapping cannot produce a line box wider than the content width, so the correct
 * answer here is 0 and this is a sub-pixel guard, not a budget. It is deliberately
 * left far below one character cell (6.6px at 11px in this monospace) and three
 * orders of magnitude below the defect it was written against, which overhung by
 * 362-719px. Widening this to make a failure go away is the documented wrong move:
 * the fix is `white-space: normal` on the offending element.
 */
const TEXT_OVERFLOW_TOLERANCE_PX = 0.5;

/**
 * The non-vacuity floor for the whole-board walk. An empty walk is a FAILURE.
 *
 * MEASURED on a clean tree: **256** leaf text nodes under `#art-board-root` (4 header,
 * 67 slate, 92 cost table, 19 channel panel, 74 lane strip). 200 is a floor at ~78% of
 * the real corpus - close enough that a whole section going missing reddens this
 * rather than quietly shrinking the corpus the check runs over. This phase has already
 * caught three separate vacuous passes (57-01 M3, 57-04 M4, 57-06 M2); the floor is
 * how this one refuses to become the fourth.
 */
const MIN_TEXT_NODES = 200;

/**
 * The non-vacuity floor for the column-scoped half.
 *
 * MEASURED: **28** of the 256 sit inside a column element - the 5 slate headers, the
 * 15 BELT notes, the 3 endpoint absence notes and 5 in the lane and channel grids.
 * That set is small because most of the 135 slate cells carry artwork and no prose,
 * and it is EXACTLY where W1 lived: 23 of these 28 were the defect. A dropped
 * `data-cell` attribute would empty this half and pass it, so it is floored.
 */
const MIN_COLUMN_SCOPED_NODES = 20;

/** One rendered string, with its painted extent measured against the boxes that hold it. */
interface TextExtent {
  /** The string itself, truncated - the locator a reader can search the board for. */
  readonly text: string;
  /** The owning column's identity, or `(no column)`. Diagnostic. */
  readonly column: string;
  /** The computed `white-space`. `nowrap` on a wrapped-prose element IS the cause. */
  readonly whiteSpace: string;
  /** The element's own border-box width, rounded to 2dp. */
  readonly boxWidth: number;
  /** The painted text extent's width, rounded to 2dp. */
  readonly textWidth: number;
  /** Painted right edge minus the element's own right edge. Must be <= tolerance. */
  readonly overOwnBox: number;
  /** Painted right edge minus the column's content right edge, or null. */
  readonly overColumn: number | null;
}

/**
 * Walk every leaf text node under `#art-board-root` and measure what it actually paints.
 *
 * LEAF NODES ONLY (`children.length === 0`): an ancestor's Range spans all of its
 * descendants, so measuring containers as well would report one overflowing note as a
 * failure on every wrapper above it and bury the real element in its own echoes.
 */
async function readTextExtents(page: Page): Promise<readonly TextExtent[]> {
  await page.locator('#art-board-readout[data-board-ready="1"]').waitFor({ state: 'attached' });
  return page.evaluate((columnSelector) => {
    const root = document.getElementById('art-board-root');
    if (root === null) {
      throw new Error('#art-board-root is absent - the text-extent walk has no corpus to read');
    }

    const describe = (el: Element): string => {
      const cell = el.getAttribute('data-cell');
      const subject = el.getAttribute('data-subject');
      const zoom = el.getAttribute('data-zoom');
      const dir = el.getAttribute('data-direction') ?? el.getAttribute('data-direction-header');
      if (cell !== null || subject !== null) return `cell ${subject}@${zoom}/${dir}`;
      if (el.hasAttribute('data-direction-header')) return `header ${dir}`;
      const lane = el.getAttribute('data-lane-cell');
      if (lane !== null) return `lane ${lane}`;
      const channel = el.getAttribute('data-channel-cell');
      if (channel !== null) return `channel ${channel}`;
      return el.tagName.toLowerCase();
    };

    const round = (n: number): number => Math.round(n * 100) / 100;
    const out = [];

    for (const el of root.querySelectorAll('*')) {
      if (el.children.length !== 0) continue;
      if ((el.textContent ?? '').trim() === '') continue;

      const box = el.getBoundingClientRect();
      // The PAINTED extent, at sub-pixel precision. See the block comment above for
      // why this is a Range and not the element rect or scrollWidth.
      const range = document.createRange();
      range.selectNodeContents(el);
      const painted = range.getBoundingClientRect();

      const column = el.closest(columnSelector);
      let overColumn: number | null = null;
      if (column !== null) {
        const cr = column.getBoundingClientRect();
        const cs = getComputedStyle(column);
        // The column's CONTENT edge, not its border edge: text is allowed up to the
        // padding, and measuring to the border edge would silently forgive 8px.
        const contentRight =
          cr.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
        overColumn = round(painted.right - contentRight);
      }

      out.push({
        text: (el.textContent ?? '').trim().slice(0, 60),
        column: column === null ? '(no column)' : describe(column),
        whiteSpace: getComputedStyle(el).whiteSpace,
        boxWidth: round(box.width),
        textWidth: round(painted.width),
        overOwnBox: round(painted.right - box.right),
        overColumn,
      });
    }

    return out;
  }, COLUMN_SELECTOR);
}

test('art board: no rendered string paints outside the column that owns it', async ({
  browser,
}) => {
  const { page, close } = await openBoard(browser);
  try {
    const extents = await readTextExtents(page);

    // THE NON-VACUITY FLOORS, FIRST. A walk over nothing reports zero overflows and is
    // otherwise the cleanest legibility result this gate can produce.
    expect(
      extents.length,
      'the walk found the board\'s real text corpus to measure - an empty walk is a FAILURE, ' +
        'never a vacuous pass',
    ).toBeGreaterThan(MIN_TEXT_NODES);

    const scoped = extents.filter((e) => e.overColumn !== null);
    expect(
      scoped.length,
      'the column-scoped half actually resolved owning columns - a dropped data-cell or ' +
        'data-direction-header attribute would empty this half and pass it',
    ).toBeGreaterThan(MIN_COLUMN_SCOPED_NODES);

    const say = (e: TextExtent, over: number): string =>
      `${e.column} [white-space: ${e.whiteSpace}] overhangs ${over}px ` +
      `(text ${e.textWidth}px in a ${e.boxWidth}px box): ${JSON.stringify(e.text)}`;

    // HALF ONE - the general class. Every string on the board, in a column or not,
    // paints inside its own box. This is the assertion the cell-geometry sweep cannot
    // make: it compares boxes to boxes, and overflow leaves the box untouched.
    expect(
      extents
        .filter((e) => e.overOwnBox > TEXT_OVERFLOW_TOLERANCE_PX)
        .map((e) => say(e, e.overOwnBox)),
      'every rendered string paints inside its own box - a fixed-width overflow:visible element ' +
        'that inherits white-space:nowrap paints across whatever is drawn to its right, and ' +
        'neither the box sweep nor the innerText token scan can see it',
    ).toEqual([]);

    // HALF TWO - the harm, named. A string that leaves its column lands on the next
    // column's text, and on this board that means one candidate direction's prose is
    // painted over by its neighbour's, at the moment a reviewer is comparing them.
    expect(
      scoped
        .filter((e) => (e.overColumn as number) > TEXT_OVERFLOW_TOLERANCE_PX)
        .map((e) => say(e, e.overColumn as number)),
      "every string stays inside its own column's content width, so no column's prose is " +
        "painted over by a neighbour's (N2/N7: a column that paints over the next one has been " +
        'given more space than it was allotted)',
    ).toEqual([]);
  } finally {
    await close();
  }
});
