import { test, expect, type Page } from './support/liveTest';
import {
  DEMO_NODE_COUNT,
  anchorOf,
  applyConfig,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  selectMachineAt,
  typeFactorySource,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';

// 90-applied-config-is-unsaved.live.spec.ts (phase 90, WORK-08 and CHROME-17, D-03 and D-05,
// success criterion 2, UI-SPEC sections 4.2 and 5, walk steps 4 and 5): an edit the host
// accepts marks the board unsaved, whatever it does to the board's shape, on the real dev host.
//
// WHAT WAS BROKEN (90-MEASURE.md, "WORK-08: still broken"). The only writer of the unsaved flag
// was the render-packet path, which marks the board dirty when a packet shows a node or a belt
// dock change shape (`isStructuralEdit`). A Factory code, a belt pace, a Route path, a cable
// drawn and a cable disconnected change none of what it reads, so the board stayed "clean" and
// New, an example, an Open and quit discarded the edit with no warning. Since plan 90-05 the
// host's accept of any edit other than Undo and Redo lights the toolbar `Unsaved` badge
// (`dirtyAfterVerdict`, `App.tsx` `onGestureVerdict`).
//
// CHROME-17 rides leg 1: typing the Factory code marks the panel heading `• not applied`
// (`CONFIG_NOT_APPLIED_MARKER`, imported, never spelled) and lights no toolbar badge; Apply
// clears the marker and the host's accept then lights `Unsaved`.
//
// THE LEG, from the demo reset (`resetToDemo`) with the badge absent first; every machine is
// found by kind and cell, never by a handle number: the demo Factory's code is changed and
// applied: `Unsaved` shows; New opens `Start a new board?`; Cancel leaves the demo on screen
// (it still runs, with all its machines).
//
// The leg prints `P90-WORK-08 leg-1 badge=<shown|absent>` before it asserts, so a red run
// says what the toolbar showed. MODEL FIRST, THEN RENDER HEALTH.

const UNSAVED = 'Unsaved';
/** Protocol `machine_kind`: FACTORY 2, ROUTE 9. */
const FACTORY_KIND = 2;
/** A new, valid Factory handler that differs from the demo's. */
const NEW_SOURCE = 'export default (payload) => payload;';
/** The host's accept lands about one tick after the send on a playing board; a quota run is slower. */
const BADGE_MS = 15_000;
/** Ticks the demo must run on after Cancel, so a silent New swap could not hide (its tick restarts low). */
const RUNS_ON_TICKS = 60;

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  await waitForCameraSettle(page);
}

/** The badge reading, waited for up to `BADGE_MS`, printed, then graded shown. */
async function expectBadgeShown(page: Page, leg: string, what: string): Promise<void> {
  const badge = page.getByText(UNSAVED, { exact: true });
  const shown = await badge.waitFor({ state: 'visible', timeout: BADGE_MS }).then(
    () => true,
    () => false,
  );
  console.log(`P90-WORK-08 ${leg} badge=${shown ? 'shown' : 'absent'}`);
  expect(shown, `${leg}: ${what} lights the toolbar Unsaved badge on the host's accept`).toBe(true);
}

async function expectBadgeAbsent(page: Page, leg: string, what: string): Promise<void> {
  await expect(page.getByText(UNSAVED, { exact: true }), `${leg}: ${what}`).toHaveCount(0);
}

function demoFactory(scene: SceneFacts): SceneFacts['nodes'][number] {
  const factories = scene.nodes.filter((n) => n.kind === FACTORY_KIND).sort((a, b) => a.id - b.id);
  expect(factories.length, 'the demo carries a Factory').toBeGreaterThan(0);
  return factories[0];
}

test.describe('90 live: an edit the host accepts marks the board unsaved (WORK-08)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: the Factory code applied lights Unsaved, New asks first, and Cancel keeps the demo', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectBadgeAbsent(page, 'leg 1', 'the demo reset is clean');
    const factory = demoFactory(await readScene(page));
    const [fx, fy] = anchorOf(factory);
    await selectMachineAt(page, fx, fy);
    await typeFactorySource(page, NEW_SOURCE);
    // CHROME-17 (D-05): the typed code is "not applied" in the panel's heading, and typing alone
    // lights no toolbar badge ("unsaved" is the board file's word only).
    const heading = page.locator('#fab-config-heading');
    await expect(heading, 'leg 1: the typed code marks the panel heading not applied').toContainText(CONFIG_NOT_APPLIED_MARKER);
    expect(((await heading.textContent()) ?? '').toLowerCase(), 'leg 1: the panel heading never says unsaved').not.toContain('unsaved');
    await expectBadgeAbsent(page, 'leg 1', 'typing in the panel without Apply lights no toolbar badge');
    await applyConfig(page);
    await expect(heading, 'leg 1: Apply clears the not-applied marker').not.toContainText(CONFIG_NOT_APPLIED_MARKER);
    await expectBadgeShown(page, 'leg 1', 'the Factory code Apply');
    await expectRenderLoopAlive(page, 'leg 1, after the Apply');

    // New is pressed with the Factory's panel still open: the panel docks below the toolbar
    // (phase 91, CHROME-07), so it no longer covers New.
    await page.getByTitle('New board (Ctrl+N)').click();
    const dialog = page.locator('.fab-dialog-panel');
    await expect(dialog.getByText('Start a new board?', { exact: true }), 'leg 1: New opens the discard guard first').toBeVisible({
      timeout: BADGE_MS,
    });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog, 'leg 1: Cancel closes the guard').toHaveCount(0);
    const t0 = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick >= t0 + RUNS_ON_TICKS, {
      timeout: 30_000,
      message: `leg 1: after Cancel the demo runs on past tick ${t0 + RUNS_ON_TICKS} (a New swap restarts the tick low)`,
    }).toBe(true);
    const after = await readScene(page);
    expect(
      { nodes: after.nodes.length, wires: after.wires.length, factory: demoFactory(after).cells },
      'leg 1: Cancel kept the demo on screen, every machine and both cable legs, the Factory where it was',
    ).toEqual({ nodes: DEMO_NODE_COUNT, wires: 2, factory: factory.cells });
    await expect(page.getByText(UNSAVED, { exact: true }), 'leg 1: the board is still unsaved after Cancel').toHaveCount(1);
    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });
});
