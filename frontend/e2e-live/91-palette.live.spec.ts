import { test, expect } from '@playwright/test';
import {
  expectRenderLoopAlive,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 91-palette.live.spec.ts (phase 91, plan 91-01, CHROME-02 and CHROME-16, D-03 and D-15, success
// criteria 1 and 3, UI-SPEC walk steps 1 and 9) - the palette reads cleanly on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-02` and `## CHROME-16`)
// ---------------------------------------------------------------------------
//
// CHROME-02: from phase 52 the palette carried an unconditional bordered box between its
// `Machines` heading and its tool list, pointing at the toolbar Help button. The toolbar `?`
// button already is that pointer, so D-03 removes the box and Help stays the one way to the
// gesture list.
//
// CHROME-16: when the band below the header is shorter than the column, the tool list scrolls
// with an overlay scrollbar that draws nothing until it is used, so nothing said more tools
// followed. D-15 adds a 24px fade on the list's bottom edge while it can scroll further, toggled
// by the `data-more-below` attribute (no scroll timeline, so it works in WebKitGTK).
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. The demo board: the palette's heading reads `MACHINES` (the `Machines` heading in the
//      title tier, uppercased by CSS), the element after it is the tool list, no element on the
//      page reads the retired pointer, and the toolbar `Help` button opens `#fab-help-panel`
//      under the heading `Gestures`.
//   2. At the live config's 1280x720 window the list overflows (a precondition), the list carries
//      `data-more-below` and the fade `[data-fab-palette-fade]` is visible on its bottom edge; the
//      mouse wheel over the list, until the list stops moving, removes both.
//
// RED FIRST (D-17): each leg was run by `redfirst.sh` at PHASE91_START in the kept start worktree
// (the frontend and host of that revision, this spec carried in) and failed there
// (91-EVIDENCE.md, `D17 case=CHROME-02-live`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** The text the retired hint box read, stated once as the value that must not appear. */
const RETIRED_HINT_TEXT = 'Gestures: toolbar ? button';

test.describe('91 live: the palette reads cleanly (CHROME-02, CHROME-16)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: the palette holds no gesture hint box, and the toolbar Help button opens Gestures', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    const palette = page.locator('aside[aria-labelledby="fab-palette-heading"]');
    const heading = palette.getByRole('heading', { name: 'Machines' });
    await expect(heading, 'the palette heading is shown').toBeVisible();
    expect(await heading.innerText(), 'the heading renders in the title tier').toBe('MACHINES');

    const after = await heading.evaluate((h) => {
      const next = h.nextElementSibling;
      const isList =
        !!next &&
        (next.matches('[data-testid="palette-tools"]') ||
          !!next.firstElementChild?.matches('[data-testid="palette-tools"]'));
      return { isList, found: next ? `${next.tagName.toLowerCase()} "${(next.textContent ?? '').slice(0, 40)}"` : 'none' };
    });
    console.log(`P91-CHROME-02 after_heading=${after.found} is_list=${after.isList}`);
    await expect(
      page.getByText(RETIRED_HINT_TEXT, { exact: true }),
      'no element on the page reads the retired gesture pointer',
    ).toHaveCount(0);
    expect(after.isList, `the element after the heading is the tool list (found: ${after.found})`).toBe(true);

    await page.getByRole('button', { name: 'Help', exact: true }).click();
    const help = page.locator('#fab-help-panel');
    await expect(help, 'the toolbar Help button opens the gesture panel').toBeVisible();
    await expect(help.getByRole('heading', { name: 'Gestures' }), 'the panel is headed Gestures').toBeVisible();

    await expectRenderLoopAlive(page, 'after the palette read and the Help panel opened');
    errs.assertNone('the palette hint walk');
  });

  test('2: the palette list shows a scroll cue at 1280x720 and the wheel to its end removes it', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    expect(page.viewportSize(), 'the live config window').toEqual({ width: 1280, height: 720 });

    const list = page.getByTestId('palette-tools');
    const fade = page.locator('[data-fab-palette-fade]');
    const m = await list.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    console.log(`P91-CHROME-16 live 1280x720 scrollHeight=${m.sh} clientHeight=${m.ch}`);
    expect(m.sh, 'PRECONDITION: the tool list overflows at 1280x720').toBeGreaterThan(m.ch);
    await expect(list, 'the list says there is more below').toHaveAttribute('data-more-below', '');
    await expect(fade, 'the scroll cue is visible').toBeVisible();
    const listBox = (await list.boundingBox())!;
    const fadeBox = (await fade.boundingBox())!;
    expect(
      Math.abs(fadeBox.y + fadeBox.height - (listBox.y + listBox.height)),
      'the cue sits on the list bottom edge',
    ).toBeLessThanOrEqual(0.5);

    // The wheel over the list, a notch at a time, until the list stops moving.
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    let last = -1;
    for (let i = 0; i < 20; i += 1) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(150);
      const top = await list.evaluate((el) => el.scrollTop);
      if (top === last) break;
      last = top;
    }
    console.log(`P91-CHROME-16 live scrolled_to=${last}`);
    expect(last, 'the wheel scrolled the list').toBeGreaterThan(0);
    await expect(list, 'at the end of the list the attribute is gone').not.toHaveAttribute('data-more-below');
    await expect(fade, 'at the end of the list the cue is gone').toHaveCount(0);

    await expectRenderLoopAlive(page, 'after the palette list was wheeled to its end');
    errs.assertNone('the palette scroll cue walk');
  });
});
