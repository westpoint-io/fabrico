import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { mockRenderSocket, waitForChrome } from './support/wire';
// The PNG decoder Playwright already bundles (pngjs). No new dependency is added
// this phase; we reach the bundled decoder rather than installing one.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';

// dpr-crispness.spec.ts (CHROME-04, Plan 27-02) - the AUTOMATED (Chromium) half of
// the fractional-DPR crispness proof. The WebKitGTK (Tauri) half has no automated
// harness in this repo and is human-verified live (Task 3 checkpoint).
//
// For each DPR in 1 / 1.25 / 1.5 / 2 this spec:
//  (a) holds a per-DPR VISUAL BASELINE of the bezel panel via toHaveScreenshot, and
//  (b) runs a MACHINE crispness metric: it scans a 1-device-px column down through
//      the fixed crisp target's TOP ring and asserts the lit-edge -> panel-fill
//      transition spans at most ONE intermediate colour (a blurred edge produces a
//      multi-step antialiasing gradient and fails).
//
// The lit band reads back as EXACTLY the skin's lit colour and the interior as
// EXACTLY the panel fill, which also proves matrixToPngDataUrl encoded the bezel
// PNG losslessly - the browser half of the Plan 01 round-trip (Node has no real
// canvas, so this is where end-to-end PNG fidelity is proven).
//
// Since Phase 47 the fixture is BEZEL-ONLY (chrome text moved to vector fonts,
// so there is no font ladder here): both screenshot subjects are text-free.
//
// PLAN 59-06 WIDENED IT PAST THE BEZEL, and the fixture is still text-free. Eleven new
// zero-tolerance baselines live here: the 29-cell icon strip and the brand mark at all
// four DPRs, plus the disabled chunky button, the guard-dialog button row and a SCROLLED
// config panel at DPR 1. Each of those last three is a surface where a real defect would
// ship with every OTHER gate green - a declaration-reading walker cannot see a ring that
// is present but overpainted, and a geometry check cannot see a ring that is missing.
//
// THE SUBJECT IS THE FIXTURE, NOT THE APP ROUTE, AND THAT IS DELIBERATE. The crisp
// target's border-box origin is pinned at device pixel (0, 0) by construction, which is
// the only reason the zero-blend metric below is measurable at all; a real-app panel is
// content-sized and its origin lands wherever layout puts it. The honesty cost is paid
// in the fixture, which renders the SHIPPED components and applies the SHIPPED
// CHROME_CSS rather than an imitation.
//
// EVERY NEW BASELINE SETS `scale: 'device'`, AND THAT IS NOT A STYLE CHOICE. MEASURED
// while writing this plan: `toHaveScreenshot` defaults to `scale: 'css'`, so an
// element-scoped baseline is captured in CSS pixels and DOWNSAMPLED out of the device
// buffer. The first generation of the eight icon/mark baselines came back
// BYTE-IDENTICAL across all four DPR buckets, at 272x120 and 32x32 for every one of
// them - four files holding one image, and a "crisp at four DPRs" claim resting on a
// single device rendering. With `scale: 'device'` each bucket keeps its own device
// buffer (272x120 / 340x150 / 408x180 / 544x240) and the four files are four
// measurements.
//
// THE SAME MEASUREMENT READS BACK ON THE FOUR PRE-EXISTING BEZEL BASELINES, and it is
// recorded rather than acted on. They are all 280x160 - CSS scale - so what they
// distinguish between buckets is the ring's CSS-LEVEL geometry (`--fab-bezel-band`
// resolves to 1 / 0.8 / 1.3333 / 1 px), not its device rasterisation. That is why
// DPR 1 and DPR 2 are byte-identical there and 1.25 and 1.5 are not. The device-pixel
// half of the bezel's proof is metric (b) below, whose `page.screenshot` DOES default
// to `scale: 'device'` - so the bezel is gated at both levels, by two different
// assertions. Those four baselines are NOT re-blessed here: plan 59-06 forbids them
// moving, and the coverage they are claimed to give is genuinely present. Flagged for
// 59-07 as a wording correction, not a hole.
//
// TOLERANCE IS NEVER LOOSENED HERE. `maxDiffPixels: 0` is stated per assertion and the
// per-pixel `threshold` is 0 GLOBALLY in both playwright.config.ts and
// playwright.mock.reuse.config.ts (phase 58 measured that `maxDiffPixels: 0` alone is
// not byte-exactness: the default 0.2 threshold absorbs a whole ink swap). That global
// is VERIFIED rather than re-declared per assertion, so there is one place to change it
// and one place to audit.
//
// ELEVEN IS NOW SEVEN (2026-10-11). The four brand-mark baselines named in the plan-59-06
// paragraph above (`logomark-dpr-*`) were retired with LogoMark.tsx, because the square is
// no longer rendered in the app. The paragraph is kept as written: it records what 59-06
// added and why. The header the app actually ships is photographed in its own block below.

const DPRS = [1, 1.25, 1.5, 2] as const;

/**
 * The pinned length of the fixture's `ICON_STRIP_ORDER`.
 *
 * 11 transport / file / warning glyphs at the medium size + 8 CANONICAL machine subjects
 * at the medium size + the same 8 at the large size + the belt glyph at both = 29. It is
 * asserted BEFORE any pixel is compared, because "the full icon export set" is not a
 * specification: a baseline whose membership is described in prose can lose a subject
 * and still regenerate green. A dropped cell reddens on the COUNT.
 *
 * CANONICAL, since plan 72-09: rows 2 and 3 derive from `SUBJECT_OF` MINUS the declared
 * `ART_ALIAS_OF` rows. An alias resolves to the same `.svg` as its target, so its cell
 * would be a byte-identical duplicate carrying a duplicate cell id, and it would move
 * all four of this file's `chrome-icons` baselines to record art already on the strip.
 */
const ICON_STRIP_LENGTH = 29;

/**
 * Open the DPR fixture at one device scale factor and wait for its ready marker.
 *
 * The readout is an ATTRIBUTE-ONLY node (empty, zero-size, so never "visible"), hence
 * `attached` rather than `visible`.
 */
async function openFixture(
  browser: import('@playwright/test').Browser,
  dpr: number,
): Promise<{ ctx: import('@playwright/test').BrowserContext; page: import('@playwright/test').Page }> {
  const ctx = await browser.newContext({ deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.goto('/chrome-dpr-spike.html');
  const readout = page.locator('#dpr-readout[data-fixture-ready="1"]');
  await readout.waitFor({ state: 'attached' });
  // Sanity: the fixture computed the SAME DPR/bucket this context emulates.
  await expect(readout).toHaveAttribute('data-dpr', String(dpr));
  return { ctx, page };
}

/**
 * The number of padding sites plan 59-03 migrated off the retired bezel border.
 *
 * FIVE in the shipped chrome stylesheet (`.fab-tool-btn`/`.fab-cta`,
 * `.fab-tool-btn--labeled`, the header-scoped labeled/CTA reclaim, `.fab-dialog-panel`
 * and `.fab-dialog-btn`) and NINE inline on components (Toolbar, Palette, Legend,
 * HelpPanel, ExamplesPopover, CameraCluster, WelcomeCard, ConfigPanel, and - as of plan
 * 61-06 - the Graphics panel, which was a new `.fab-panel` surface carrying the same
 * ring-padding expression the other eight do rather than declaring a new one). 14 -> 15
 * at plan 62-07: the development pace panel was a TENTH inline `.fab-panel` carrying that
 * same expression. It was absent from every shipped bundle, but this walk reads SOURCE
 * and the panel had to stay legible at the sub-0.75 zoom its judging session required, so
 * it was held to the identical DPR-invariance proof rather than exempted. 15 -> 16 at
 * plan 64-06: `RefusalMessage.tsx` is an ELEVENTH inline `.fab-panel`, carrying the same
 * ring-inclusive padding expression rather than a new one. It is on screen for at most
 * four seconds at a time, but the ring it paints in that window has to be as crisp at
 * DPR 1.25 as any panel that never leaves. 16 -> 15 at plan 68-07, which DELETED the
 * 62-07 panel with the rest of the development pace switch (BELT-05 / D-68-12). The
 * deleted path is named in `68-07-SUMMARY.md` and deliberately not here: this file is
 * inside the scan set of `scripts/check-dev-pace-switch-absent.sh`. 15 -> 16 at plan
 * 73-04: `LoadRefusedCard.tsx` is an ELEVENTH inline `.fab-panel` (UNDO-09, the card that
 * says why a `.fab` file will not open), carrying the SAME ring-inclusive padding
 * expression `RefusalMessage.tsx` does rather than declaring a new one. Unlike the
 * refusal banner it stays until the user dismisses it, so its ring is on screen longer
 * than any other transient surface in the app and is held to the identical proof. 16 -> 17 at
 * plan 90-07 on 2026-10-24: `SimStoppedCard.tsx` (FAIL-01, the card a fatal sim error shows)
 * is a TWELFTH inline `.fab-panel` with the same ring-inclusive padding expression as
 * `LoadRefusedCard.tsx`, whose slot it takes; it never leaves once shown, so its ring is held
 * to the same proof. 17 -> 16 in plan 91-03 on 2026-10-24 (GraphicsPanel.tsx deleted, D-04):
 * the Graphics panel and its one inline ring-padding site went with its trigger (CHROME-03).
 *
 * THE PROSE BREAKDOWN IN THE ASSERTION MESSAGE BELOW IS DERIVED, NOT TRANSCRIBED. It used
 * to read "5 in chromeCss.ts and 8 inline", which summed to 13 and had been stale since
 * plan 61-06; a hand-written breakdown beside a moving total is a second thing to forget.
 *
 * The count is pinned so that a site REVERTED to the old border form reddens on the
 * count before it can hide behind twelve fixed ones. The list itself is DERIVED from the
 * source at test time and never transcribed: a transcribed list agrees with itself.
 */
const PADDING_SITE_COUNT = 16;

interface PaddingSite {
  readonly file: string;
  readonly kind: 'css' | 'inline';
  readonly decl: string;
}

/**
 * Every padding declaration under `src/chrome` whose value reaches `--fab-bezel-ring`.
 *
 * Two shapes, because the sites live in two forms. `chromeCss.ts` carries real CSS text
 * inside a template literal, terminated by `;`. The component modules carry React style
 * objects, whose value is a single-quoted string terminated by `,` - and two of them
 * (Toolbar, CameraCluster) put the value on the line AFTER the key, hence the optional
 * newline. Neither pattern can match the other's form, so the union is exact rather than
 * approximate.
 */
function readPaddingSites(): PaddingSite[] {
  // Resolved from the SPEC'S OWN path via `test.info().file` rather than from
  // `__dirname` (undefined under Playwright's ESM loader) or from `process.cwd()`
  // (whatever directory the run was launched in).
  const dir = path.join(path.dirname(test.info().file), '..', 'src', 'chrome');
  const out: PaddingSite[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.tsx?$/.test(f)).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/padding:\s*([^;'`]*--fab-bezel-ring[^;'`]*);/g)) {
      out.push({ file, kind: 'css', decl: m[1].trim() });
    }
    for (const m of text.matchAll(/padding:\s*\n?\s*'([^']*--fab-bezel-ring[^']*)'/g)) {
      out.push({ file, kind: 'inline', decl: m[1].trim() });
    }
  }
  return out;
}

/** A device-pixel colour, 0-255 per channel. */
interface RGB {
  r: number;
  g: number;
  b: number;
}

function eqColour(a: RGB, b: RGB, tol = 6): boolean {
  return (
    Math.abs(a.r - b.r) <= tol &&
    Math.abs(a.g - b.g) <= tol &&
    Math.abs(a.b - b.b) <= tol
  );
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

for (const dpr of DPRS) {
  test(`bezel crisp + lossless at DPR ${dpr}`, async ({ browser }) => {
    const ctx = await browser.newContext({ deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    try {
      await page.goto('/chrome-dpr-spike.html');

      // The fixture marks itself ready once document.fonts settles (a formality:
      // the fixture renders no text since Phase 47). This IS the ready signal (a
      // fixture-specific marker, not the app's getByTitle affordance). The
      // readout is an ATTRIBUTE-ONLY node (empty, zero-size => never "visible"),
      // so wait for attachment, not visibility.
      const readout = page.locator('#dpr-readout[data-fixture-ready="1"]');
      await readout.waitFor({ state: 'attached' });

      // Sanity: the fixture computed the SAME DPR/bucket this context emulates.
      await expect(readout).toHaveAttribute('data-dpr', String(dpr));

      // The skin colours the fixture self-reports (proves losslessness by value).
      const litHex = (await readout.getAttribute('data-lit'))!;
      const fillHex = (await readout.getAttribute('data-fill'))!;
      const shadowHex = (await readout.getAttribute('data-shadow'))!;
      const lit = hexToRgb(litHex);
      const fill = hexToRgb(fillHex);
      // The hairline inner outline is a legitimate STRUCTURAL band (a single solid
      // colour), not blur - it is an expected plateau, not an antialiasing step.
      const shadow = hexToRgb(shadowHex);

      // (a) Per-DPR visual baseline of the human-facing bezel panel.
      const panel = page.locator('.fab-spike-panel').first();
      await expect(panel).toHaveScreenshot(`bezel-dpr-${dpr}.png`, {
        maxDiffPixels: 0,
      });

      // (b) Machine crispness metric on the fixed crisp target (border-box origin
      // at device (0,0) so band transitions are never smeared by a fractional box
      // origin). Read a device column straight DOWN the horizontal MIDPOINT of the
      // TOP edge - the mid-edge, well clear of BOTH corner slices (WR-02).
      //
      // Under the pre-CR-01 `side = ring*2` geometry the top EDGE slice collapsed to
      // 0px, so the ring painted only its corners and this mid-edge column saw NO lit
      // band (litStart === -1). This scan therefore FAILS a corner-only ring and
      // PASSES a continuous one. (The former x=3 column sat inside the inner-outline
      // strip for the s=2 buckets and never reached the interior fill, so it could
      // not measure the top-edge crispness at fractional DPR at all.)
      const strip = await page.screenshot({
        clip: { x: 0, y: 0, width: 48, height: 48 },
      });
      const png = PNG.sync.read(strip);

      // The horizontal centre of the top edge (mid-edge, away from either corner).
      const col = png.width >> 1;
      const column: RGB[] = [];
      for (let y = 0; y < png.height; y++) {
        const i = (png.width * y + col) << 2;
        column.push({ r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] });
      }

      // All three band colours must appear EXACTLY (within a tiny tolerance):
      // this is the lossless PNG round-trip proof - matrixToPngDataUrl encoded the
      // bezel without quantization, and the browser decoded the same bytes.
      const litStart = column.findIndex((c) => eqColour(c, lit));
      expect(litStart, `lit colour ${litHex} must appear in the top ring`).toBeGreaterThanOrEqual(0);
      const shadowSeen = column.some((c, y) => y > litStart && eqColour(c, shadow));
      expect(shadowSeen, `shadow/outline colour ${shadowHex} must appear in the ring`).toBe(true);
      const fillStart = column.findIndex((c, y) => y > litStart && eqColour(c, fill));
      expect(fillStart, `fill colour ${fillHex} must appear below the lit band`).toBeGreaterThan(litStart);

      // Crispness gate: across the whole lit->fill span the ONLY colours allowed
      // are the three structural plateaus (lit, shadow, fill). Any other colour is
      // an antialiasing BLEND.
      //
      // TIGHTENED FROM ONE TO ZERO (plan 59-06), and a strictly stronger gate is the
      // only kind of gate change this milestone accepts. The superseded allowance,
      // quoted rather than deleted: "a crisp ring has at most one such blend pixel at
      // a fractional DPR (the ring maps 1:1 to device px; only the fractional
      // border-width can leave a single AA pixel at one internal boundary)". There is
      // no border-width any more. Every band is now a whole number of device pixels
      // at every bucket, so the exact bar is reachable, and it was MEASURED before it
      // was asserted: 0 distinct blends at all four DPRs, with the lit->fill span
      // reading [lit, shadow, fill] at DPR 1 and 1.25 and [lit, lit, shadow, shadow,
      // fill] at 1.5 and 2.
      //
      // THE EXACTNESS IS A PROPERTY OF THIS FIXTURE, NOT A RESTATED PROPERTY OF THE
      // SHIPPED CHROME - say so here or a future reader files a real-app blend pixel
      // as a regression. A band lands on whole device pixels only where the element's
      // BORDER-BOX ORIGIN is itself at an integral device position. The crisp target
      // is pinned at viewport (0, 0) BY CONSTRUCTION, which is the only reason this
      // bar is reachable at all. A shipped panel is content-sized and positioned by
      // layout: `Palette.tsx` is `position: absolute` with content-driven extent, so
      // at DPR 1.25 its box can legitimately start on a fractional device pixel and
      // produce a real blend row. That would not be a regression, and this assertion
      // does not claim otherwise.
      const between = column.slice(litStart, fillStart + 1);
      const blends: RGB[] = [];
      for (const c of between) {
        if (eqColour(c, lit) || eqColour(c, shadow) || eqColour(c, fill)) continue;
        if (!blends.some((d) => eqColour(c, d))) blends.push(c);
      }
      expect(
        blends.length,
        `lit->fill transition at DPR ${dpr} must span ZERO non-structural (blend) colours beyond the lit/shadow/fill bands (found ${blends.length}: ${blends
          .map((d) => `rgb(${d.r},${d.g},${d.b})`)
          .join(', ')}) - on THIS fixture, whose crisp target's border-box origin is pinned at device pixel (0, 0). A shipped, content-sized panel at a fractional origin is not held to this bar`,
      ).toBe(0);
    } finally {
      await ctx.close();
    }
  });
}

// ---------------------------------------------------------------------------
// PLAN 59-06: the icon strip (and, until 2026-10-11, the brand mark), at all four DPRs.
// ---------------------------------------------------------------------------

for (const dpr of DPRS) {
  test(`icon strip at DPR ${dpr}`, async ({ browser }) => {
    const { ctx, page } = await openFixture(browser, dpr);
    try {
      // THE MEMBERSHIP PIN, BEFORE ANY PIXEL.
      //
      // `ICON_STRIP_ORDER` is IMPORTED from the fixture rather than retyped here - but
      // imported IN THE PAGE, not in Node. A Node-side import is not available: the
      // fixture's transitive imports reach `?raw` SVG asset imports and a `.woff2`
      // import, which are Vite resolutions that Playwright's TypeScript loader does not
      // perform. The dynamic import below returns the ALREADY-INSTANTIATED module record
      // for the module the page loaded, so nothing re-runs and no side effect repeats.
      // It is also the stronger read: it pins the literal that actually rendered, in the
      // runtime where it is real, rather than a parallel build of the same file.
      const strip = await page.evaluate(async () => {
        // The specifier is cast rather than written as a bare literal so tsc does not
        // try to RESOLVE it. It is a Vite-served URL that only exists in the page at
        // run time, and `e2e/` entered `tsconfig.json`'s include in the phase-69
        // follow-up. TypeScript resolves `import()` only for a literal argument, so
        // the cast is what keeps the URL readable here instead of hidden behind a
        // variable or silenced with a suppression comment.
        const mod = await import('/src/spike/chromeDpr.tsx' as string);
        return {
          exported: (mod.ICON_STRIP_ORDER as ReadonlyArray<{ id: string }>).map((c) => c.id),
          rendered: [...document.querySelectorAll('[data-strip-cell]')].map((el) =>
            el.getAttribute('data-strip-cell'),
          ),
        };
      });

      expect(
        strip.exported,
        `ICON_STRIP_ORDER must name ${ICON_STRIP_LENGTH} cells: 11 transport glyphs at ` +
          'the medium size, the 8 CANONICAL machine subjects at the medium size, the ' +
          'same 8 at the large size, and the belt glyph at both. Rows 2 and 3 are ' +
          'DERIVED from SUBJECT_OF minus the declared ART_ALIAS_OF rows, so a new ' +
          'CANONICAL subject added to the registry grows this number and a subject ' +
          'dropped from it shrinks this number. Either way the strip cannot drift ' +
          'behind the registry unnoticed. An ALIASED subject deliberately does NOT ' +
          'grow it: it draws byte-identical art under a duplicate cell id, so a cell ' +
          'for it would be evidence of nothing.',
      ).toHaveLength(ICON_STRIP_LENGTH);

      // The literal and the DOM must AGREE. Without this the count alone would pass a
      // literal that grew while the render silently dropped a cell, which is the same
      // hole the count is here to close, one level in.
      expect(
        strip.rendered,
        'every cell in ICON_STRIP_ORDER must reach the DOM, in order',
      ).toEqual(strip.exported);

      // ...and every cell id is UNIQUE, which the fixture's header has always claimed
      // in prose and nothing checked (plan 72-09). It matters now: a cell id is
      // `<subject>@<size>`, so a subject sharing another's asset would mint a duplicate
      // id, and `[data-strip-cell="factory@md"]` would resolve to two nodes. The
      // duplicate is what the ART_ALIAS_OF subtraction in `chromeDpr.tsx` prevents;
      // this is the assertion that would say so if it ever stopped preventing it.
      expect(
        new Set(strip.exported).size,
        'two ICON_STRIP_ORDER cells share an id, so the strip carries art it already ' +
          'shows and a per-cell selector is ambiguous',
      ).toBe(strip.exported.length);

      // 16px is the TIGHTEST crispness case in the phase - the point where the 2u detail
      // stroke lands on exactly 1.00 CSS px - so its row is asserted present by name
      // rather than merely counted. Row 2 is not redundant with row 3.
      expect(strip.exported).toContain('endpoint@md');
      expect(strip.exported).toContain('endpoint@lg');

      // (a) The strip. All twenty exports plus the endpoint subject (which has no named
      // convenience export and is reachable only through MachineGlyphIcon), at both
      // sizes, at this DPR.
      await expect(page.locator('[data-spike="icon-strip"]')).toHaveScreenshot(
        `chrome-icons-dpr-${dpr}.png`,
        { maxDiffPixels: 0, scale: 'device' },
      );

      // (b) THE BRAND MARK BLOCK THAT SAT HERE IS RETIRED (2026-10-11). It held the four
      // `logomark-dpr-*` baselines of the 32u square, element-scoped on
      // `[data-testid="logo-mark"]` in this fixture. The square's component, LogoMark.tsx,
      // was deleted because no production surface rendered it after MARK-17 (phase 80.1):
      // the header draws HeaderLockup, whose four baselines are the next block, taken on the
      // real app route. Its stated purpose, quoted: "they are the only evidence for the
      // mark's LAYER ADJACENCY and its per-DPR pixel behaviour". Per-DPR behaviour of a
      // drawing the app never shows is evidence about nothing a user sees; the square's
      // GEOMETRY, which the installer icons are still held to, stays guarded by
      // `chrome/iconMasterParity.test.ts` (equal to the icon master shape for shape, plus the
      // square's one-accent rule) and `markSheet.test.ts`'s byte comparison. The icon raster
      // pins (`iconRaster.test.ts`) guard the master, not the square.
    } finally {
      await ctx.close();
    }
  });
}

// ---------------------------------------------------------------------------
// PLAN 80.1-03: the header lockup as it SHIPS, at all four DPRs.
// ---------------------------------------------------------------------------

for (const dpr of DPRS) {
  test(`header lockup at DPR ${dpr}`, async ({ browser }) => {
    // THE SUBJECT IS THE APP ROUTE, NOT THE SPIKE FIXTURE, AND THAT IS THE POINT.
    // `openFixture()` opens /chrome-dpr-spike.html, which is `src/spike/chromeDpr.tsx`,
    // which App.tsx never reaches. Taking the header lockup's baselines there would
    // photograph a fixture; taken here they are evidence about the surface that actually
    // ships.
    //
    // SUPERSEDED, QUOTED RATHER THAN DELETED. The fixture sentence above used to continue:
    // "which imports the 32u square directly ... That page stays pinned to the square by
    // decision, which is what keeps the square's per-ratio coverage alive for the
    // hand-tuned 16px cut of Phase 81 to master from." Phase 81 has shipped, and on
    // 2026-10-11 the square's component and its four baselines were retired, because the
    // square is no longer rendered in the app. The fixture no longer imports it.
    const ctx = await browser.newContext({ deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    try {
      // The mock render socket is installed BEFORE navigating, for the reason
      // logo.spec.ts records: a bare goto('/') connects to the real dev host at
      // ws://127.0.0.1:8787/render, and the result then depends on whether one happens
      // to be running on this machine (H-1, WINDOWS row 203). The whole value of the
      // mock suite is that it does not depend on a live host.
      //
      // THE CAPTURE WAITS FOR A STILL PAGE (plan 84-08). On the 2026-10-09 CI run's two-CPU
      // runner the DPR 2 capture failed on both tries with `Timeout 5000ms exceeded` while
      // Playwright's call log sat on `waiting for element to be stable`. The lockup never
      // moved (plan 84-08 sampled its box on every frame for 6 s at a 50% CPU quota: one
      // rect throughout). The time went into the capture itself: the app redraws the board
      // on every animation frame through software GL, and a capture of that page took 3 to
      // 16 s at the quota, against 0.1 to 0.2 s for a static page there. So the page runs
      // on Playwright's clock and is paused once the chrome is up: the board stops
      // redrawing, the header is what it was, and the capture takes 1.5 to 2.6 s at the
      // same quota. Nothing the PNG records is touched: the four baselines still compare at
      // `maxDiffPixels: 0`, and no timeout here was raised. `pauseAt` only jumps forward, so
      // it is aimed a second past the page's present to leave room for the round trip.
      await page.clock.install();
      await mockRenderSocket(page);
      await page.goto('/');
      // Chrome mounts only once the app is `ready`; the palette entry is the signal,
      // the same ready gate logo.spec.ts and chrome-icons.spec.ts use.
      await waitForChrome(page);
      const pageNow = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(pageNow + 1000);

      // WHAT THESE FOUR PNGs ARE EVIDENCE FOR, AND WHY NO ASSERTION IS MADE HERE.
      //
      // The cut carries two SUB-PIXEL strokes at the shipped 32 CSS px header height:
      // the belt / cleat / drum structure at 3u, which lands at 0.531 CSS px, and the
      // cell outline at 2u, which lands at 0.354 (80.1-UI-SPEC.md, "Rendered sizes at
      // the shipped 32 CSS px height"). At DPR 1 both are anti-aliased blends rather
      // than solid device rows, and at DPR 2 the cell outline is STILL under one device
      // pixel. So the zero-blend metric this file runs on the bezel, and any "no blended
      // pixels" bar, would be a number invented to be cleared. That is the same reason
      // once recorded for the retired brand mark baselines (removed 2026-10-11), for a
      // subject that sits further under the line than the mark did.
      //
      // D-06 is locked on a judgement the maintainer made on the plate cut at true shipping size,
      // and criterion 7's live walk on the real WebKitGTK binary is where a human judges
      // it. A record is therefore the honest instrument for this subject. These four
      // PNGs are that record: what the sub-pixel line work actually does at each ratio,
      // so a later phase that changes the drawing has something to be compared against.
      //
      // `scale: 'device'` and NOT the default `scale: 'css'`, for the measured reason at
      // the head of this file: at CSS scale the four buckets come back byte-identical
      // and four files hold one image. `maxDiffPixels: 0`, with the per-pixel
      // `threshold` pinned to 0 globally in both configs, because a whole ink swap has
      // already passed unnoticed in this tree at the default 0.2. If one of these ever
      // proves flaky, that is evidence about the DRAWING and it goes in front of the maintainer;
      // it is never absorbed by widening the bar.
      await expect(page.locator('header [data-testid="header-lockup"]')).toHaveScreenshot(
        `header-lockup-dpr-${dpr}.png`,
        { maxDiffPixels: 0, scale: 'device' },
      );
    } finally {
      await ctx.close();
    }
  });
}

// ---------------------------------------------------------------------------
// PLAN 59-06: layout is DPR-INVARIANT, over three ring carriers and all thirteen
// migrated padding sites.
// ---------------------------------------------------------------------------

test('layout is DPR-INVARIANT: three ring carriers and all 13 migrated padding sites', async ({
  browser,
}) => {
  // THIS PROPERTY WAS FALSE BEFORE PHASE 59, so the assertion is a real proof of the
  // fix rather than a tautology. `border-image` reserved its ring in the BORDER area
  // and its width VARIED with the device pixel ratio: `--fab-bezel-width` resolved to
  // 6 / 9.6 / 8 / 6 CSS px across these four buckets, so a header measured
  // 1232x72 / 1232x78 / 1232x76 / 1232x72 and a transport button
  // 60x44 / 66x44 / 64x44 / 60x44. Plan 59-03 moved all thirteen sites off the border
  // and into padding; this is the standing gate that keeps them there.
  //
  // ALL THIRTEEN, not a sample. A single missed site is exactly the defect that hides
  // behind twelve fixed ones, so the site list is DERIVED from the source at test time
  // and its cardinality is pinned: a site reverted to the old form disappears from the
  // derivation and reddens the count before any rect is compared.
  //
  // The subject of each site probe is a content-box div of fixed inner size carrying
  // that site's exact declaration, so its outer rect is `inner + 2 * padding` and any
  // DPR-varying term in the expression shows up directly. `--fab-bezel-band` is such a
  // term and is live in this stylesheet (1 / 0.8 / 1.3333 / 1 px), so the gate has
  // something real to catch.
  const sites = readPaddingSites();
  expect(
    sites.map((s) => `${s.file}:${s.kind}`),
    `the retired bezel border has ${PADDING_SITE_COUNT} migrated padding sites - ` +
      `${sites.filter((s) => s.kind === 'inline').length} inline on components and ` +
      `${sites.filter((s) => s.kind !== 'inline').length} in the stylesheet, both counted ` +
      'from this run rather than transcribed. A site missing from this derivation has ' +
      'been reverted to a border form, or moved somewhere this walk does not reach; a ' +
      'site added to it is a new ring carrier that needs the same proof.',
  ).toHaveLength(PADDING_SITE_COUNT);

  const measured = new Map<string, string[]>();

  for (const dpr of DPRS) {
    const { ctx, page } = await openFixture(browser, dpr);
    try {
      const rects = await page.evaluate((decls: string[]) => {
        const box = (el: Element): string => {
          const r = el.getBoundingClientRect();
          return `x=${r.x} y=${r.y} w=${r.width} h=${r.height}`;
        };
        const out: Record<string, string> = {};

        // The three carriers the plan names by hand: a panel, a chunky button and a
        // guard-dialog button. The panel is content-driven on purpose - a fixed-width
        // panel would satisfy this assertion no matter what its padding did.
        out['carrier:panel'] = box(document.querySelector('[data-spike="rect-panel"]')!);
        out['carrier:chunky-button'] = box(
          document.querySelector('[data-spike="toolbtn-disabled"]')!,
        );
        out['carrier:dialog-button'] = box(
          document.querySelector('[data-spike="dialog-buttons"] .fab-dialog-btn')!,
        );

        // One hidden probe per migrated site. Appended, measured and REMOVED inside a
        // single evaluate so no baseline in this file can ever see them.
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;';
        document.body.appendChild(host);
        decls.forEach((decl, i) => {
          const probe = document.createElement('div');
          probe.style.cssText = `box-sizing:content-box;width:100px;height:20px;padding:${decl};`;
          host.appendChild(probe);
          const r = probe.getBoundingClientRect();
          out[`site:${i}`] = `w=${r.width} h=${r.height}`;
        });
        host.remove();
        return out;
      }, sites.map((s) => s.decl));

      for (const [key, value] of Object.entries(rects)) {
        const bucket = measured.get(key) ?? [];
        bucket.push(value);
        measured.set(key, bucket);
      }
    } finally {
      await ctx.close();
    }
  }

  for (const [key, values] of measured) {
    const label = key.startsWith('site:')
      ? `${key} (${sites[Number(key.slice(5))].file}: padding ${sites[Number(key.slice(5))].decl})`
      : key;
    expect(
      new Set(values).size,
      `${label} must report the SAME box at every DPR. Measured ` +
        DPRS.map((d, i) => `${d}: ${values[i]}`).join(' | '),
    ).toBe(1);
  }
});

// ---------------------------------------------------------------------------
// PLAN 59-06: the three surfaces where a ring defect would ship with every other
// gate green. DPR 1 only - these are existence-and-composition proofs, and the
// four-bucket crispness question is answered by the strip above (and, until 2026-10-11,
// by the brand mark).
// ---------------------------------------------------------------------------

test('the three uncovered bezel surfaces carry their ring at DPR 1', async ({ browser }) => {
  const { ctx, page } = await openFixture(browser, 1);
  try {
    // (1) THE DISABLED CHUNKY BUTTON. `.fab-tool-btn:disabled` used to declare
    // `box-shadow: none`, which was harmless while the frame lived in the border area
    // and erases the ENTIRE frame now that the frame IS the box-shadow. 59-05 measured
    // that `toolbar-stability.spec.ts` stays GREEN under exactly that mutation, because
    // paint sits outside layout. This baseline is the only pixel in the repo that can
    // see a disabled button go ringless.
    await expect(page.locator('[data-spike="toolbtn-disabled"]')).toHaveScreenshot(
      'toolbtn-disabled-dpr-1.png',
      { maxDiffPixels: 0, scale: 'device' },
    );

    // (2) THE GUARD-DIALOG BUTTON ROW. `.fab-dialog-btn` is the FIFTH ring-carrying
    // class - the one an earlier reading of the stylesheet missed - and it had no pixel
    // evidence at all. Four variants in the order 59-UI-SPEC pins: base, --drain,
    // --danger, and the ring-exempt --cancel ghost, which is the single selector the
    // ring walker deliberately cannot check. Three ringed buttons beside one flat ghost
    // is what this baseline has to keep showing.
    await expect(page.locator('[data-spike="dialog-buttons"]')).toHaveScreenshot(
      'dialog-buttons-dpr-1.png',
      { maxDiffPixels: 0, scale: 'device' },
    );

    // (3) THE SCROLLED CONFIG PANEL, and it is the fifteenth baseline this phase
    // produces where the design contract counted fourteen. It exists because of a
    // defect the research found and no gate covered: an inset shadow is clipped to the
    // PADDING box and paints above the background but BELOW the content, so a ring
    // carrier that is also its own scroll container has its top ring band overpainted
    // by its own scrolled content - with a fully green board, because the rect gate
    // reads geometry, the CSS walkers read declarations, and no baseline before this
    // one captures a SCROLLED panel.
    //
    // The panel is scrolled by the fixture before the ready marker, to 100px, which is
    // deliberately NOT a multiple of the 48px row pitch: at a multiple the scroll box
    // opens on a clean row boundary and the panel reads as though it were never
    // scrolled.
    const scrolled = page.locator('[data-spike="configpanel-scrolled"]');
    await expect(
      scrolled.locator('[data-fab-panel-scroll]'),
      'the panel must actually be scrolled, or this baseline proves nothing',
    ).toHaveJSProperty('scrollTop', 100);
    await expect(scrolled).toHaveScreenshot('configpanel-scrolled-dpr-1.png', {
      maxDiffPixels: 0,
      scale: 'device',
    });
  } finally {
    await ctx.close();
  }
});
