import { test, expect } from '@playwright/test';
import {
  expectRenderLoopAlive,
  handPlaceAt,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 90-tab-title.live.spec.ts (phase 90, plan 90-01, CHROME-05, D-04, success criterion 2, UI-SPEC
// walk step 6) - the browser tab title never carries a dead unsaved marker, on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: the Source is placed with the shipped palette by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (90-MEASURE.md `## CHROME-05: still broken`)
// ---------------------------------------------------------------------------
//
// `setDirty` in App.tsx prefixed the browser tab title with a star while the board was unsaved.
// WebKitGTK under Tauri does not mirror the page title into the native window title and the app
// never calls the Tauri window API, so in the shipped app nobody ever saw it: dead code that only
// a browser tab could show. D-04 removes it; the toolbar `Unsaved` badge is the one unsaved cue.
//
// ---------------------------------------------------------------------------
// THE LEG, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. The demo board, clean (no `Unsaved` badge): the page title is `Fabrico`. A Source placed
//      on an empty cell with the hand: the scene holds it and the `Unsaved` badge shows, and the
//      page title is still exactly `Fabrico`.
//
// RED FIRST (D-14): run once against PHASE90_START (the frontend from the kept start worktree with
// this spec copied in): the title read after the edit carried the star prefix (90-EVIDENCE.md,
// `LIVE_RED 90-tab-title`). The native window title on the real binary is walked at the close.
//
// Render health in the test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** The page title the app ships with (`frontend/index.html`). */
const TITLE = 'Fabrico';
/** An empty cell on the demo board, well clear of its machines (rows 0..8). */
const SOURCE_CELL: readonly [number, number] = [10, 12];

test.describe('90 live: the tab title carries no unsaved marker (CHROME-05)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: an unsaved board keeps the page title exactly Fabrico', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    const badge = page.getByText('Unsaved', { exact: true });
    await expect(badge, 'the demo board is clean: no Unsaved badge').toHaveCount(0);
    expect(await page.title(), 'the clean board: the page title').toBe(TITLE);

    const before = await readScene(page);
    await handPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
    await page.keyboard.press('Escape');
    await pollScene(
      page,
      (s) => s.nodes.some((n) => n.cells.some(([x, y]) => x === SOURCE_CELL[0] && y === SOURCE_CELL[1])),
      { message: 'the hand-placed Source folded on the live host' },
    ).toBe(true);
    expect((await readScene(page)).nodes.length, 'one machine more than the demo').toBe(before.nodes.length + 1);
    await expect(badge, 'the edit marked the board unsaved: the toolbar badge shows').toBeVisible();

    const after = await page.title();
    console.log(`P90-CHROME-05 title_after_edit=${JSON.stringify(after)}`);
    expect(after, 'the unsaved board: the page title carries no marker').toBe(TITLE);

    await expectRenderLoopAlive(page, 'after the unsaved edit');
    errs.assertNone('the tab title walk');
  });
});
