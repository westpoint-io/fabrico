import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectNode,
  waitForBoard,
} from './support/wire';
// The PNG decoder Playwright already bundles (pngjs), the reach chrome-bezel.spec uses.
import { PNG } from 'playwright-core/lib/utilsBundle';
import { colorToRgb, rampOracles } from '../shared/geometry';

// palette-grouping.spec.ts (Phase 32-03, SHELL-06) - the palette heading, the
// Belt-vs-machines grouping, and the role-describing tooltips at the LIVE UI edge.
//
// After 32-03 the palette teaches what each tool DOES: it carries a `Machines`
// heading, each placeable-machine tool exposes a functional role `title` (not the
// old thin `Place X`), and the Belt tool (a belt is DRAWN, not placed) is divided
// off below a separator. We drive the real app DOM, never canvas pixels. Machine
// tools are still selected by the COPY-STABLE aria-label ("Place Source"), so this
// spec asserts the visible tooltip copy separately from the accessible name.

/**
 * The Palette is ready to measure: its Source tool is on screen (chrome mounts once the app is
 * `ready`), the web fonts have loaded and two frames have painted. Both chrome faces are
 * `font-display: block` and the Palette is `width: fit-content`, so a box read before the font lands
 * is the fallback face's and moves when it does: the scroll-cue case read the list 9.59 px wider than
 * its fade that way (review WR-B-02, reproduced by holding the font between the two reads).
 */
async function paletteReady(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Source/ }).waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

test.describe('Palette heading, Belt grouping, and role tooltips (SHELL-06)', () => {
  test('the palette carries a Machines heading inside the aside', async ({ page }) => {
    await page.goto('/');
    // Chrome mounts only once the app is `ready`; the Source tool is the signal.
    await paletteReady(page);

    const heading = page.getByRole('heading', { name: 'Machines' });
    await expect(heading).toBeVisible();

    // The heading names the palette landmark, so it must live inside the <aside>.
    const inAside = page.locator('aside').getByRole('heading', { name: 'Machines' });
    await expect(inAside).toHaveCount(1);
  });

  test('each machine tool exposes a functional role tooltip, not the bare "Place X"', async ({
    page,
  }) => {
    await page.goto('/');
    await paletteReady(page);

    // Source's role copy describes what it does ("Emits ..."), matched by keyword
    // so copy tweaks do not go stale.
    const source = page.getByRole('button', { name: /Source/ });
    await expect(source).toHaveAttribute('title', /Emits/i);
    // The accessible name is preserved (screen readers still hear "Place Source").
    await expect(source).toHaveAttribute('aria-label', 'Place Source');

    // No placeable-machine tool keeps the old thin "Place X" title (role copy only).
    //
    // THE `?? ''` FALLBACK USED TO MAKE THIS LOOP UNABLE TO SEE THE FAILURE IT
    // MATTERS MOST FOR, and it is corrected here rather than left for the next
    // reader to trip over. MEASURED, plan 66-04: a new palette row was committed
    // with NO `title` attribute at all and this spec stayed GREEN across all 11
    // tests. `getAttribute('title')` returns null for a missing attribute, the
    // `?? ''` turned that into an empty string, and `''` does not match
    // `/^Place /` - so a row with no tooltip whatsoever passed the check whose
    // stated job is "every placeable tool exposes a functional role tooltip".
    // Both 66-04-PLAN.md and 66-UI-SPEC section 3a asserted, in those words, that
    // shipping a row without role copy REDDENS THIS SPEC. It did not.
    //
    // So the fallback is gone and absence is now its own named failure. The two
    // clauses below are DIFFERENT failures on purpose: a null title is a missing
    // tooltip, a `Place `-prefixed title is the old thin copy this test was
    // written to retire. Reporting them as one would name the wrong defect.
    const machineTitles = await page
      .locator('aside button[aria-label^="Place "]')
      .evaluateAll((els) =>
        els.map((el) => ({
          name: el.getAttribute('aria-label') ?? '',
          // NOT coalesced: null (attribute absent) has to stay distinguishable
          // from '' (attribute present and empty). Both are failures; neither is
          // the same failure as thin copy.
          title: el.getAttribute('title'),
        })),
      );
    expect(machineTitles.length).toBeGreaterThan(0);
    for (const t of machineTitles) {
      expect(
        t.title,
        `"${t.name}" ships no role tooltip at all (title attribute absent or empty)`,
      ).toBeTruthy();
      expect(
        t.title ?? '',
        `tooltip of "${t.name}" must be role copy, not "Place X"`,
      ).not.toMatch(/^Place /);
    }
  });

  test('the Belt tool is present and grouped apart from the placeable machines', async ({
    page,
  }) => {
    await page.goto('/');
    await paletteReady(page);

    // The Belt tool keeps its role-describing draw tooltip.
    const belt = page.getByRole('button', { name: /Belt/ });
    await expect(belt).toHaveAttribute('title', /Draw belts/i);

    // A separator divides the drawn Belt from the placed machines.
    const divider = page.locator('aside [data-testid="palette-belt-divider"]');
    await expect(divider).toHaveCount(1);

    // The Belt sits BELOW the machine group: its box is under the last machine
    // (Merge) and under the divider (a belt is drawn, not placed => grouped apart).
    const merge = page.getByRole('button', { name: /Merge/ });
    const mergeBox = await merge.boundingBox();
    const dividerBox = await divider.boundingBox();
    const beltBox = await belt.boundingBox();
    expect(mergeBox && dividerBox && beltBox).toBeTruthy();
    expect(dividerBox!.y).toBeGreaterThan(mergeBox!.y);
    expect(beltBox!.y).toBeGreaterThan(dividerBox!.y);
  });

  // Phase 76 (SHAPE-10, UI-SPEC 1.1): the Label row sits in ITS OWN group at the bottom
  // of the palette, below the Wire tool and a SECOND hairline separator. A note is
  // neither a placed machine nor a drawn link, and a row inside the machine group reads
  // as a machine by default. The palette's separator count moves 1 to 2 here, stated as
  // the number, never as a `>=`.
  test('the Label row sits in its own group below the Wire tool', async ({ page }) => {
    await page.goto('/');
    await paletteReady(page);

    const separators = page.locator('aside [role="separator"]');
    await expect(separators).toHaveCount(2);

    const label = page.getByRole('button', { name: 'Place Label', exact: true });
    await expect(label).toHaveCount(1);
    await expect(label).toHaveAttribute('title', 'A note on the board. It does not connect.');
    // Like every other row: the tooltip is role copy, never the thin "Place X".
    const title = await label.getAttribute('title');
    expect(title ?? '', 'the Label row tooltip must not begin with "Place "').not.toMatch(
      /^Place /,
    );

    const wire = page.getByRole('button', { name: 'Wire', exact: true });
    const wireBox = await wire.boundingBox();
    const secondBox = await separators.nth(1).boundingBox();
    const labelBox = await label.boundingBox();
    expect(wireBox && secondBox && labelBox).toBeTruthy();
    expect(secondBox!.y, 'the second separator sits below the Wire tool').toBeGreaterThan(
      wireBox!.y,
    );
    expect(labelBox!.y, 'the Label row sits below the second separator').toBeGreaterThan(
      secondBox!.y,
    );
  });
});

// ---------------------------------------------------------------------------
// The open Legend costs the user NOTHING (52-06 gap closure, WINDOWS id 2).
//
// WHAT THIS PIN USED TO BE, and why the history matters. Until 52-06 the Legend
// was docked bottom-LEFT, stacked as a column under the vertically-centred
// Palette, and this describe PINNED the resulting damage as a baseline so it
// could not grow silently. Measured 2026-07-25 at 1280px wide, Legend open:
//
//   1280x800: 6 of 9 covered (Tee, Balancer, Merge, HTTP Router, Router, Belt)
//   1280x720: 7 of 9 covered (the above plus Factory)
//
// That was a ratchet on a defect, not a fix, and the defect sat across the
// phase's own primary user journey: wall 1 (how a reply travelled back) is taught
// ONLY inside the Legend, and opening the Legend made the Belt tool that wall 2
// tells the newcomer to click silently unclickable. 52-06 re-docked the Legend as
// a bottom STRIP starting right of the Palette column, so the pin is FLIPPED, not
// deleted: the expected covered count is now ZERO at every tested viewport.
//
// The pre-fix numbers stay above deliberately. If this ever fails with a covered
// count creeping back toward 6 or 7, the reader can see exactly what regressed.
//
// The ORACLE is unchanged and must stay unchanged: `document.elementFromPoint` at
// each tool's OWN CENTRE, which is what decides whether a click reaches the tool.
// A bounding-box comparison would be a WEAKER oracle than the one it replaced -
// it would pass through a stacking-order regression in either direction.
test.describe('The open Legend covers no palette tool (52-06, WINDOWS id 2)', () => {
  // 1280x800 is the shipped default Tauri window; 1280x720 was the previously
  // WORST case (7 of 9 covered); 1024x768 is the tightest wrap, where the strip
  // measured 195px tall over two wrapped lines.
  const VIEWPORTS = [
    { width: 1280, height: 800 },
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
  ];

  for (const { width, height } of VIEWPORTS) {
    test(`covers zero palette tools and no corner control at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await paletteReady(page);

      await page.getByRole('button', { name: 'Legend' }).click();
      await expect(page.locator('#fab-legend-panel')).toBeVisible();

      // HIT-TESTED, not merely geometric: a tool is "covered" when the element
      // at its own centre belongs to the Legend, which is the thing that decides
      // whether a click reaches the tool. Bounding-box overlap alone would miss
      // a stacking-order change in either direction.
      //
      // PHASE 76 MADE THIS A REACHABILITY CHECK, and it is stricter than the one it
      // replaces. The twelfth row (the Label tool) made the column 688.78px tall. It
      // is now centred in the band BELOW the header and capped to it, and when the
      // band is shorter than the column (1280x720, 1024x768) the TOOL LIST scrolls
      // while the heading stays put; at the shipped 1280x800 window nothing
      // scrolls (asserted in its own test below). So each tool is first scrolled into
      // view INSIDE the palette, exactly as a user scrolls to it, and then its centre
      // must hit-test to THE TOOL ITSELF - not merely "something on screen that is not
      // the Legend", which is all the old `hit` clause asked.
      const toolCount = await page
        .locator('aside[aria-labelledby="fab-palette-heading"] button')
        .count();
      const tools: { name: string; hit: boolean; isTool: boolean; covered: boolean }[] = [];
      for (let i = 0; i < toolCount; i++) {
        const button = page.locator('aside[aria-labelledby="fab-palette-heading"] button').nth(i);
        await button.scrollIntoViewIfNeeded();
        tools.push(
          await button.evaluate((b) => {
            const r = b.getBoundingClientRect();
            const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return {
              name: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
              // `elementFromPoint` returns null for a point OUTSIDE the viewport, so
              // `hit` and `covered` stay separate facts (WR-04): an off-screen tool is
              // a broken measurement, never "uncovered".
              hit: at !== null,
              isTool: at !== null && b.contains(at),
              covered: at !== null && at.closest('#fab-legend-panel') !== null,
            };
          }),
        );
      }
      expect(tools, 'the Palette and its tool buttons are on screen').not.toBeNull();
      // ANTI-VACUITY: the tool list is the real one, not an empty query that
      // would make a "0 covered" count pass while proving nothing.
      // A STATED LITERAL, moved by hand when a row lands: 9 -> 10 at plan 66-01,
      // which adds the Wire tool below the divider beside the Belt tool, and
      // 10 -> 11 at plan 66-04, which adds the Route row above the two Router
      // presets, and 11 -> 12 in phase 76 (plan 76-01), which adds the Label row in
      // its own group below the Wire tool.
      //
      // IT IS STILL 11 AFTER 72-10, AND THAT IS A COINCIDENCE WORTH NAMING rather
      // than an unchanged column. That plan ADDS the HTTP Handler row (D-11) and
      // PULLS the `HTTP Router` preset row (R-64: nothing ever links a machine's
      // output port into a wire, so a Router cannot sit on a request path and there
      // is no true sentence for it). One in, one out. The column HEIGHT is therefore
      // also unchanged at 627.78px, which is why the clip-point figure in the
      // comment above still holds and was not re-measured.
      expect(tools!.length, `all twelve palette tools are present at ${width}x${height}`).toBe(
        12,
      );
      // Phase 76: the Label row, by name, for the same reason as the clauses below.
      expect(
        tools!.some((t) => t.name === 'Place Label'),
        'the Label row is among them',
      ).toBe(true);
      expect(
        tools!.some((t) => /Belt/.test(t.name)),
        'the Belt tool is among them',
      ).toBe(true);
      expect(
        tools!.some((t) => /Wire/.test(t.name)),
        'the Wire tool is among them',
      ).toBe(true);
      // BY NAME as well as by count, for the same reason the Belt and Wire
      // clauses above exist: a bare count would let this row be swapped out in a
      // refactor that changed the tool set without changing its size.
      expect(
        tools!.some((t) => /Place Route$/.test(t.name)),
        'the Route row is among them',
      ).toBe(true);
      // 72-10: the machine the request is ANSWERED by, named alongside the machine it
      // arrives at, for the same reason the Belt and Wire clauses above exist.
      expect(
        tools!.some((t) => /HTTP Handler/.test(t.name)),
        'the HTTP Handler row is among them',
      ).toBe(true);
      // AND THE PULLED ROW, ASSERTED ABSENT. `Palette.test.tsx` states this against
      // the React tree; this states it against the SHIPPED, MOUNTED column, which is
      // the only place a row re-added by some other code path would show up.
      expect(
        tools!.filter((t) => /HTTP Router/.test(t.name)).map((t) => t.name),
        'the HTTP Router row is PULLED - it advertises a machine that cannot sit on a request path',
      ).toEqual([]);
      // ANTI-VACUITY, the third clause: every hit test RESOLVED an element. An
      // unresolved one means the tool centre is off-screen, and "not covered" is
      // then a statement about nothing.
      const unhit = tools!.filter((t) => !t.hit).map((t) => t.name);
      expect(
        unhit,
        `every palette tool centre is inside the viewport at ${width}x${height}; these are not: ${unhit.join(', ')}`,
      ).toEqual([]);
      // Phase 76: and what is AT that centre is the tool itself, so a click there
      // reaches it (the scrolled tool list clips; a clipped row would hit-test to the
      // panel behind it and still read as "not covered by the Legend").
      const notTheTool = tools!.filter((t) => !t.isTool).map((t) => t.name);
      expect(
        notTheTool,
        `every palette tool, scrolled into view, is topmost at its own centre at ${width}x${height}; these are not: ${notTheTool.join(', ')}`,
      ).toEqual([]);

      const covered = tools!.filter((t) => t.covered).map((t) => t.name);
      expect(
        covered,
        `the open Legend still covers these palette tools at ${width}x${height}: ${covered.join(', ')}`,
      ).toEqual([]);

      // BY NAME, not only by count: Belt is the headline case (wall 2 points at
      // it), and a count assertion alone would let it be lost in a refactor that
      // changed the tool set.
      const belt = tools!.find((t) => /Belt/.test(t.name));
      expect(belt!.covered, `the Belt tool is clickable at ${width}x${height}`).toBe(false);

      // The bottom-right dock cluster, checked TWO ways because a hit test alone
      // cannot see a strip that runs under the cluster's padding.
      //
      // (a) hit test every corner-dock BUTTON (the CameraCluster's Fit and zoom
      //     controls). Necessary, but not sufficient.
      const cornerButtons = await page.evaluate(() =>
        [...document.querySelectorAll('[data-fab-corner-dock] button')].map((b) => {
          const r = b.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return {
            name: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
            // Same split as the palette loop above (WR-04): off-screen is not
            // "uncovered", it is a broken measurement.
            hit: at !== null,
            covered: at !== null && at.closest('#fab-legend-panel') !== null,
          };
        }),
      );
      expect(
        cornerButtons.length,
        `at least one corner-dock control exists at ${width}x${height}`,
      ).toBeGreaterThan(0);
      const unhitCorners = cornerButtons.filter((c) => !c.hit).map((c) => c.name);
      expect(
        unhitCorners,
        `every corner-dock control centre is inside the viewport at ${width}x${height}; these are not: ${unhitCorners.join(', ')}`,
      ).toEqual([]);
      const coveredCorners = cornerButtons.filter((c) => c.covered).map((c) => c.name);
      expect(
        coveredCorners,
        `the open Legend covers these corner controls at ${width}x${height}: ${coveredCorners.join(', ')}`,
      ).toEqual([]);

      // (b) the GEOMETRIC right bound: the strip stops short of the dock's box,
      //     not only of its buttons' centres. A regression collapsing
      //     cornerInsetPx to 0 could pass (a) while the strip ran under the
      //     cluster's bezel.
      const corners = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-fab-corner-dock]')].map(
          (el) => el.offsetLeft,
        ),
      );
      // EXACTLY ONE dock with nothing selected: the CameraCluster (plan 91-03
      // removed the bottom-right readout, the other permanent dock, CHROME-01).
      // Exactly one, never at least one: zero means the cluster's attribute was
      // dropped, and two means a stray right-docked surface came back.
      expect(
        corners.length,
        `exactly one corner dock (the CameraCluster) resolves with nothing selected at ${width}x${height}`,
      ).toBe(1);

      const legendBox = await page.locator('#fab-legend-panel').boundingBox();
      const paletteBox = await page
        .locator('aside[aria-labelledby="fab-palette-heading"]')
        .boundingBox();
      expect(legendBox && paletteBox, 'both panels have layout boxes').toBeTruthy();
      expect(
        legendBox!.x + legendBox!.width,
        `the strip stops short of the leftmost corner dock at ${width}x${height}`,
      ).toBeLessThanOrEqual(Math.min(...corners));

      // The column property: the strip and the Palette never share the left edge.
      expect(
        legendBox!.x,
        `the strip starts right of the Palette column at ${width}x${height}`,
      ).toBeGreaterThanOrEqual(paletteBox!.x + paletteBox!.width);
    });
  }
});

// ---------------------------------------------------------------------------
// ...and it costs the user nothing WITH A MACHINE SELECTED (52 CR-01).
//
// WHY THIS DESCRIBE EXISTS. The describe above never selects a machine, and that
// hole is the entire reason the first re-dock shipped broken. The `ConfigPanel`
// was then `top:lg / right:lg / bottom:lg` (since plan 91-09 it docks below the
// toolbar and is as tall as its content), so it occupied the strip's own band, and
// it renders after the Legend at the same zIndex, so it wins the paint. Measured
// 2026-07-29 on the live DOM BEFORE the fix, machine selected + Legend open:
//
//   1280x800  strip x [222,1024]  config x [792,1256]  ->  232px of overlap
//   1280x720  strip x [222,1024]  config x [792,1256]  ->  232px of overlap
//   1024x768  strip x [222, 768]  config x [618,1000]  ->  150px of overlap
//
// The hidden right end is exactly where the Request/Reply rows this phase added
// for QA-02 wall 1 sit, and "select a Factory, then + Add output" is the phase's
// own user journey - so the defect sat across the ordinary build state.
//
// The fix folds the ConfigPanel into the SAME measured band (it carries
// `data-fab-corner-dock`, and `Math.min` over every match makes the reserve mean
// "the leftmost right-docked surface"), rather than reopening the maintainer's locked
// bottom-strip design. This describe is the oracle that was missing.
test.describe('The open Legend costs nothing with a machine SELECTED (52 CR-01)', () => {
  /** A FACTORY (kind 2, 3x3) at (10,8) - the catalog shape shared with the
   *  panel-* specs. The Factory is deliberate: it is the machine the app's own
   *  gesture row tells a newcomer to select. */
  const FACTORY: InjectNode = {
    id: 7,
    kind: 2,
    cell_x: 10,
    cell_y: 8,
    w: 3,
    h: 3,
    ports: [
      { index: 0, cell_x: 10, cell_y: 9, side: 3, role: 0, medium: 0 },
      { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1, medium: 0 },
      { index: 2, cell_x: 11, cell_y: 10, side: 2, role: 2, medium: 0 },
    ],
  };
  const FACTORY_BODY: [number, number] = [11, 9];

  // `overflowBudgetPx` is the strip's horizontal overflow allowance
  // (`scrollWidth - clientWidth`), and it is NOT a free parameter - see the
  // assertion below for why 1024x768 is the one non-zero entry.
  const VIEWPORTS = [
    { width: 1280, height: 800, overflowBudgetPx: 0 },
    { width: 1280, height: 720, overflowBudgetPx: 0 },
    { width: 1024, height: 768, overflowBudgetPx: 0 },
  ];

  for (const { width, height, overflowBudgetPx } of VIEWPORTS) {
    test(`the strip clears the ConfigPanel at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
      const h = await mockRenderSocket(page, {
        answerQuery: (verb) =>
          verb === 'machine_config'
            ? { kind: 'Factory', source: 'export default (payload) => payload;' }
            : undefined,
      });
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;
      h.inject(buildPacket({ nodes: [FACTORY] }));
      await waitForBoard(page, { machines: 1 });

      const at = await screenCellCentre(page, FACTORY_BODY[0], FACTORY_BODY[1]);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.up();
      // The ConfigPanel is mounted: this is the state the whole describe is about.
      await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole('button', { name: 'Legend' }).click();
      // ANTI-VACUITY: the Legend really opened. The band model now fails CLOSED
      // (App does not mount the Legend when the band is unmeasurable), so "no
      // overlap" would otherwise be trivially satisfiable by not rendering.
      await expect(page.locator('#fab-legend-panel')).toBeVisible();

      const m = await page.evaluate(() => {
        const legend = document.querySelector<HTMLElement>('#fab-legend-panel');
        const config = document.querySelector<HTMLElement>(
          'aside[aria-labelledby="fab-config-heading"]',
        );
        const palette = document.querySelector<HTMLElement>(
          'aside[aria-labelledby="fab-palette-heading"]',
        );
        const toolbar = document.querySelector<HTMLElement>('header, [role="banner"]');
        if (legend === null || config === null || palette === null) return null;
        const lr = legend.getBoundingClientRect();
        // The Legend's ROWS. Since phase 92 (plan 92-05, CHROME-12) they sit inside four group
        // boxes in an `overflow: hidden` clip box, so the strip's children are no longer its rows
        // and a nowrap row too wide for the strip would be clipped rather than counted by the
        // strip's own scroll overflow. So the rows and headings are read by name, and their own
        // right edges are the overflow check.
        const rows = [...legend.querySelectorAll('[data-fab-legend-row]')];
        const heads = [...legend.querySelectorAll('h2, [data-fab-legend-head] > span:first-child')];
        // The furthest-right edge any ROW or heading reaches, which is the real question when
        // a nowrap row can bleed past its container's padding box.
        const contentRight = Math.max(...[...rows, ...heads].map((el) => el.getBoundingClientRect().right));
        return {
          legend: { x: lr.x, right: lr.right, top: lr.top, bottom: lr.bottom },
          configX: config.getBoundingClientRect().x,
          paletteRight: palette.getBoundingClientRect().right,
          contentRight,
          toolbarBottom: toolbar === null ? null : toolbar.getBoundingClientRect().bottom,
          // The strip's own scroll overflow, or how far a row or heading reaches past the strip's
          // content-right edge, whichever is more (the clip box hides the second from the first).
          overflowX: Math.max(
            legend.scrollWidth - legend.clientWidth,
            Math.round(contentRight - (lr.right - parseFloat(getComputedStyle(legend).paddingRight))),
          ),
          overflowY: legend.scrollHeight - legend.clientHeight,
          configIsCornerDock: config.hasAttribute('data-fab-corner-dock'),
          rowText: rows.map((el) => (el.textContent ?? '').trim()),
          // The row NAME on its own, which `rowText` cannot give: `textContent`
          // concatenates the name span and the hint span with no separator
          // ('RoutePOST here to call its Handler'), so a name can only be matched
          // there by prefix, and 'Router' is a prefix-collision with 'Route'.
          // Every row renders its name as the first text-bearing <span> (the
          // glyph/swatch span before it holds an icon and no text), so this reads
          // the name exactly and the content check below can compare by equality.
          rowNames: rows.map((el) => {
            const spans = [...el.querySelectorAll('span')].map((s) => (s.textContent ?? '').trim());
            return spans.find((t) => t !== '') ?? (el.textContent ?? '').trim();
          }),
          viewportW: window.innerWidth,
          viewportH: window.innerHeight,
        };
      });
      expect(m, 'the Legend, the ConfigPanel and the Palette all have layout boxes').not.toBeNull();

      // The layout CONTRACT itself, asserted rather than assumed: the panel is in
      // the measured set. Without this the geometry below could pass by accident
      // (a narrower panel, a wider window) while the reserve stayed wrong.
      expect(
        m!.configIsCornerDock,
        'the ConfigPanel carries the right-dock layout contract App measures',
      ).toBe(true);

      // 1. THE HEADLINE: the strip's box stops short of the panel.
      expect(
        m!.legend.right,
        `the strip stops short of the ConfigPanel at ${width}x${height}`,
      ).toBeLessThanOrEqual(m!.configX);

      // 2. ...and so does its CONTENT. A `whiteSpace: nowrap` row can extend past
      //    the container's padding box (`overflow: visible`), so the box check
      //    alone would not catch a row reaching under the panel.
      expect(
        m!.contentRight,
        `no strip ROW reaches the ConfigPanel at ${width}x${height}`,
      ).toBeLessThanOrEqual(m!.configX);

      // 3. It still clears the Palette column on the other side.
      expect(
        m!.legend.x,
        `the strip starts right of the Palette column at ${width}x${height}`,
      ).toBeGreaterThanOrEqual(m!.paletteRight);

      // 4. It stays inside the viewport and never climbs into the Toolbar.
      expect(m!.legend.x, `the strip is inside the viewport at ${width}x${height}`)
        .toBeGreaterThanOrEqual(0);
      expect(m!.legend.right, `the strip is inside the viewport at ${width}x${height}`)
        .toBeLessThanOrEqual(m!.viewportW);
      expect(m!.legend.bottom, `the strip is inside the viewport at ${width}x${height}`)
        .toBeLessThanOrEqual(m!.viewportH);
      if (m!.toolbarBottom !== null) {
        expect(
          m!.legend.top,
          `the strip does not climb into the Toolbar at ${width}x${height}`,
        ).toBeGreaterThanOrEqual(m!.toolbarBottom);
      }

      // 5. It does not overflow VERTICALLY at any size, and horizontally only
      //    within the budget above.
      //
      //    THE BUDGET IS 0 AT EVERY VIEWPORT AND IS MEANT TO STAY THAT WAY.
      //    Reserving the ConfigPanel narrows the strip to 372px at 1024x768
      //    (content box 344px), and every row is `nowrap`, so a long hint cannot
      //    shrink to fit. The Working cue's hint was shortened to `tint + motion
      //    (on a request)` for exactly that reason (the maintainer's call at the gap-closure
      //    review; the previous `(handling a request)` measured 357px and bled 5px
      //    onto the ConfigPanel's own bezel). It keeps the request semantic on
      //    purpose: 43-02 reworded this hint FROM a bare `tint + motion` to name
      //    what Working means, so a trim back to mechanism-only would undo that.
      //    This is a hard 0 rather than a tolerance so the next over-long row fails
      //    here instead of being absorbed silently.
      expect(
        m!.overflowY,
        `the strip does not overflow vertically at ${width}x${height}`,
      ).toBe(0);
      expect(
        m!.overflowX,
        `the strip's horizontal overflow at ${width}x${height} is within its pinned budget`,
      ).toBeLessThanOrEqual(overflowBudgetPx);

      // 6. ANTI-VACUITY on the CONTENT: the strip still carries the kind rows (Route,
      //    HTTP Handler and Label among them since phase 92), the state cues, the
      //    Ports rows and the three Connections rows. A strip that
      //    silently dropped rows would satisfy every geometric assertion above.
      //
      //    CORRECTED 2026-09-04 (phase 72 vacuity sweep, V-2). This loop used to
      //    join every row into one `flat` string and `toContain` each name in it,
      //    and that form could not fail: the eight KIND rows are in the same join,
      //    so the `Router` row satisfied `toContain('Route')` and the Route TERMINAL
      //    row could be renamed back to its pre-72-10 name with this - the file's
      //    OWN anti-vacuity content check - still green. MEASURED: renaming
      //    `Legend.tsx`'s `<span>Route</span>` to `<span>Endpoint</span>` left it at
      //    `1 passed`.
      //
      //    The name is now matched against one ROW's NAME by EQUALITY, and exactly one
      //    row must carry it. Equality is what closes the hole rather than merely
      //    narrowing it: the row's `textContent` runs the name straight into its hint
      //    with no separator ('RoutePOST here to call its Handler'), so any prefix form
      //    would still let 'Router' answer for 'Route'. `rowNames` reads the name span
      //    on its own, so the two rows can no longer stand in for each other.
      for (const required of [
        'Source',
        'Factory',
        'Idle',
        'Working',
        'Faulted',
        'Wire',
        'Route',
        'Request',
        'Reply',
        'HTTP Handler',
        'Label',
        'Fault exit',
        'Wire port',
      ]) {
        expect(
          m!.rowNames.filter((n) => n === required).length,
          `exactly one strip row is named ${required} at ${width}x${height} (rows: ${m!.rowNames.join(' | ')})`,
        ).toBe(1);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 76 (plan 76-01): the Palette clears the header at every tested window.
//
// The Label row made the column 688.78px tall. Centred in the WHOLE window it slid under
// the toolbar: at the shipped 1280x800 window its "Machines" heading was hidden, and at
// 1280x720 the old gesture hint box too (the heading was already under it there before this
// phase). The Palette is now centred in the band below the header and capped to it, its
// tool list scrolling when the band is short. Everything here is MEASURED off the live
// header, never written as the 96px the tokens happen to add up to today, so a header that
// changes height reddens this rather than hiding the Palette again. MUTATION (2026-10-07,
// throwaway worktree, reverted): the Palette's `top` put back to the whole-window `50%`
// reddens "the Palette starts below the header, Expected: > 96, Received: 55.609375".
// ---------------------------------------------------------------------------
test.describe('The Palette sits below the header (phase 76)', () => {
  const VIEWPORTS = [
    { width: 1280, height: 800 },
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
  ];
  for (const { width, height } of VIEWPORTS) {
    test(`the heading clears the header, is topmost and leads straight to the tool list at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await paletteReady(page);
      const facts = await page.evaluate(() => {
        const header = document.querySelector('header')!.getBoundingClientRect();
        const palette = document
          .querySelector('aside[aria-labelledby="fab-palette-heading"]')!
          .getBoundingClientRect();
        const topmostIsPalette = (el: Element): boolean => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !!at?.closest('aside[aria-labelledby="fab-palette-heading"]');
        };
        const heading = document.getElementById('fab-palette-heading')!;
        // CHROME-02 (phase 91, D-03): nothing sits between the heading and the tool list. The
        // element after the heading is the list, or the wrapper whose first child is the list
        // (the CHROME-16 cue wraps it).
        const next = heading.nextElementSibling;
        const nextIsList =
          !!next &&
          (next.matches('[data-testid="palette-tools"]') ||
            !!next.firstElementChild?.matches('[data-testid="palette-tools"]'));
        return {
          headerBottom: header.bottom,
          paletteTop: palette.top,
          paletteBottom: palette.bottom,
          headingTopmost: topmostIsPalette(heading),
          nextTag: next ? `${next.tagName.toLowerCase()} ${next.textContent?.slice(0, 40) ?? ''}` : 'none',
          nextIsList,
        };
      });
      expect(facts.paletteTop, 'the Palette starts below the header').toBeGreaterThan(facts.headerBottom);
      expect(facts.paletteBottom, 'the Palette ends inside the window').toBeLessThanOrEqual(height);
      expect(facts.headingTopmost, 'nothing covers the "Machines" heading').toBe(true);
      // The retired hint box's text, stated once as the value that must not appear anywhere.
      await expect(
        page.getByText('Gestures: toolbar ? button', { exact: true }),
        'no element on the page reads the retired gesture pointer (CHROME-02)',
      ).toHaveCount(0);
      expect(
        facts.nextIsList,
        `the element after the "Machines" heading is the tool list (found: ${facts.nextTag})`,
      ).toBe(true);
    });
  }

  test('at the shipped 1280x800 window every tool is visible without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await paletteReady(page);
    const list = page.getByTestId('palette-tools');
    const { scrollHeight, clientHeight } = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(clientHeight, 'the tool list has height').toBeGreaterThan(0);
    expect(scrollHeight, 'the tool list does not scroll at the shipped window').toBe(clientHeight);
    // And the LAST row, the Label tool, is on screen and topmost without any scroll.
    const labelTopmost = await page
      .getByRole('button', { name: 'Place Label', exact: true })
      .evaluate((b) => {
        const r = b.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at !== null && b.contains(at);
      });
    expect(labelTopmost, 'the Label row is reachable without scrolling at 1280x800').toBe(true);
  });

  // -------------------------------------------------------------------------
  // CHROME-16 (phase 91, D-15): a cue at the bottom of the tool list whenever it can scroll.
  //
  // When the band below the header is shorter than the column, the list scrolls with an overlay
  // scrollbar that draws nothing until it is used, so the list looked finished (91-MEASURE.md
  // `## CHROME-16`). The list now carries `data-more-below` exactly while
  // `scrollHeight - scrollTop - clientHeight > 1`, and while it does a 24px `[data-fab-palette-fade]`
  // spans the list's bottom edge, ending in the panel fill, taking no pointer events. Graded by
  // boxes, computed style and pixels, never a snapshot. Seen red at PHASE91_START
  // (91-EVIDENCE.md, `D17 case=CHROME-16-mock`).
  // -------------------------------------------------------------------------
  const SHORT_WINDOWS = [
    { width: 1024, height: 600 },
    { width: 1280, height: 640 },
    { width: 1280, height: 720 },
  ];
  /** The panel fill, `--fab-panel-fill` (LOCKED ramp[2]), the colour the fade ends in. */
  const PANEL_FILL = colorToRgb(rampOracles.locked[2]);
  for (const { width, height } of SHORT_WINDOWS) {
    test(`the list shows a scroll cue while it can scroll, and the cue leaves at its end, at ${width}x${height}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await paletteReady(page);
      const list = page.getByTestId('palette-tools');
      const metrics = await list.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      console.log(`P91-CHROME-16 ${width}x${height} scrollHeight=${metrics.scrollHeight} clientHeight=${metrics.clientHeight}`);
      // PRECONDITION: the list really overflows at this size, so a fit here fails loudly instead
      // of passing every absence check below by accident.
      expect(
        metrics.scrollHeight,
        `PRECONDITION: the tool list overflows at ${width}x${height}`,
      ).toBeGreaterThan(metrics.clientHeight);

      await expect(list, 'the list says there is more below').toHaveAttribute('data-more-below', '');
      const fade = page.locator('[data-fab-palette-fade]');
      await expect(fade, 'the fade is shown').toBeVisible();
      const listBox = (await list.boundingBox())!;
      const fadeBox = (await fade.boundingBox())!;
      expect(Math.abs(fadeBox.x - listBox.x), 'the fade starts at the list left edge').toBeLessThanOrEqual(0.5);
      expect(Math.abs(fadeBox.width - listBox.width), 'the fade spans the list width').toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(fadeBox.y + fadeBox.height - (listBox.y + listBox.height)),
        'the fade sits on the list bottom edge',
      ).toBeLessThanOrEqual(0.5);
      expect(Math.abs(fadeBox.height - 24), 'the fade is 24px tall').toBeLessThanOrEqual(0.5);
      const style = await fade.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { pointerEvents: cs.pointerEvents, backgroundImage: cs.backgroundImage };
      });
      expect(style.pointerEvents, 'the fade takes no pointer events').toBe('none');
      expect(style.backgroundImage, 'the fade paints a gradient').toMatch(/^linear-gradient\(/);

      // PIXELS: the fade's bottom row, and the row 2px above the list's bottom edge (UI-SPEC 6),
      // at the list's horizontal centre, read the panel fill.
      const cx = Math.round(listBox.x + listBox.width / 2);
      const bottomEdge = Math.round(listBox.y + listBox.height);
      for (const above of [1, 2]) {
        const shot = await page.screenshot({ clip: { x: cx, y: bottomEdge - above, width: 1, height: 1 } });
        const png = PNG.sync.read(shot);
        const px = { r: png.data[0], g: png.data[1], b: png.data[2] };
        const off = Math.max(
          Math.abs(px.r - PANEL_FILL.r),
          Math.abs(px.g - PANEL_FILL.g),
          Math.abs(px.b - PANEL_FILL.b),
        );
        expect(off, `the pixel ${above}px above the list bottom reads the panel fill (got rgb(${px.r},${px.g},${px.b}))`).toBeLessThanOrEqual(2);
      }
      // The fade PAINTS: its box shot with the fade hidden differs from the shot with it.
      const clip = { x: fadeBox.x, y: fadeBox.y, width: fadeBox.width, height: fadeBox.height };
      const withFade = await page.screenshot({ clip });
      await fade.evaluate((el) => {
        (el as HTMLElement).style.visibility = 'hidden';
      });
      const withoutFade = await page.screenshot({ clip });
      await fade.evaluate((el) => {
        (el as HTMLElement).style.visibility = '';
      });
      expect(withFade.equals(withoutFade), 'the fade changes the pixels it covers').toBe(false);

      // The row under the fade still takes the click: find the tool row with the most height
      // inside the fade's box and click inside both, then that row is armed.
      const target = await list.evaluate((el, f) => {
        const rows = [...el.querySelectorAll('button')];
        let bestIndex = -1;
        let bestY0 = 0;
        let bestY1 = 0;
        for (let i = 0; i < rows.length; i += 1) {
          const r = rows[i].getBoundingClientRect();
          const y0 = Math.max(r.top, f.y);
          const y1 = Math.min(r.bottom, f.y + f.height);
          if (y1 - y0 > 0 && (bestIndex < 0 || y1 - y0 > bestY1 - bestY0)) {
            bestIndex = i;
            bestY0 = y0;
            bestY1 = y1;
          }
        }
        if (bestIndex < 0) return null;
        const b = rows[bestIndex].getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = (bestY0 + bestY1) / 2;
        const at = document.elementFromPoint(x, y);
        return { index: bestIndex, x, y, hitsRow: !!at && rows[bestIndex].contains(at) };
      }, fadeBox);
      expect(target, 'a tool row sits under the fade').not.toBeNull();
      expect(target!.hitsRow, 'the row under the fade is what a click there reaches').toBe(true);
      const row = list.locator('button').nth(target!.index);
      await page.mouse.click(target!.x, target!.y);
      await expect(row, 'a click on the row under the fade arms it').toHaveAttribute('aria-pressed', 'true');

      // Scrolled to its end, the list says nothing more follows.
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(list, 'at the end of the list the attribute is gone').not.toHaveAttribute('data-more-below');
      await expect(fade, 'at the end of the list the fade is gone').toHaveCount(0);
    });
  }

  // Review IN-B-06: THE CUE FOLLOWS THE LIST'S CONTENT, NOT ONLY ITS BOX. Once the list is at its
  // max height, a row that grows (a late web-font swap, a row added) changes how far it can scroll
  // without resizing the list's own box and without a scroll event, so the attribute went stale
  // until the user scrolled. Here the list is scrolled to its end (no cue), then one row is made
  // taller in place: the cue must come back on its own.
  test('the cue comes back when a row grows under a list scrolled to its end, with no scroll and no resize', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await paletteReady(page);
    const list = page.getByTestId('palette-tools');
    await expect(list, 'PRECONDITION: the list scrolls at 1280x720').toHaveAttribute('data-more-below', '');
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(list, 'PRECONDITION: at its end the cue is gone').not.toHaveAttribute('data-more-below');
    const before = await list.evaluate((el) => ({ h: el.clientHeight, top: el.scrollTop }));
    await list.evaluate((el) => {
      const row = el.querySelector<HTMLElement>('button');
      if (row !== null) row.style.minHeight = '140px';
    });
    const after = await list.evaluate((el) => ({ h: el.clientHeight, top: el.scrollTop, more: el.scrollHeight - el.scrollTop - el.clientHeight }));
    expect(after.h, 'PRECONDITION: the list box did not resize').toBe(before.h);
    expect(after.more, 'PRECONDITION: the taller row put more of the list below').toBeGreaterThan(1);
    await expect(list, 'the cue comes back with no scroll and no resize').toHaveAttribute('data-more-below', '');
  });

  test('the list fits and shows no scroll cue at 1280x800, also after a resize from 1280x720', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await paletteReady(page);
    const list = page.getByTestId('palette-tools');
    const fade = page.locator('[data-fab-palette-fade]');
    // PRECONDITION: at 1280x720 the cue shows, so its absence after the resize is a change.
    await expect(list, 'PRECONDITION: the cue shows at 1280x720').toHaveAttribute('data-more-below', '');
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(list, 'after the resize to 1280x800 the attribute is gone').not.toHaveAttribute('data-more-below');
    await expect(fade, 'after the resize to 1280x800 the fade is gone').toHaveCount(0);

    await page.goto('/');
    await paletteReady(page);
    const { scrollHeight, clientHeight } = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    console.log(`P91-CHROME-16 1280x800 scrollHeight=${scrollHeight} clientHeight=${clientHeight}`);
    expect(scrollHeight, 'the list fits at 1280x800').toBe(clientHeight);
    // Held for several frames, so a late toggle would show.
    for (let i = 0; i < 5; i += 1) {
      await page.waitForTimeout(100);
      expect(await list.getAttribute('data-more-below'), 'no attribute on a list that fits').toBeNull();
      expect(await fade.count(), 'no fade on a list that fits').toBe(0);
    }
  });
});
