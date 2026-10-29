import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_NODE_COUNT,
  clickAt,
  drawnNodesOf,
  expectRenderLoopAlive,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetToDemo,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
  restoreHostAfterFailedTest,
} from './support/oracle';

// 76-same-pass-delete-cascade.live.spec.ts (plan 76-12 refuter round) - on a paused board
// the host applies every queued gesture in ONE drain pass when Play is pressed. A Delete's
// capture (what Ctrl+Z brings back) used to be read off the board as it stood BEFORE that
// pass, so a belt an earlier gesture of the same pass had already taken out of the
// machine's cascade was still listed, and Ctrl+Z drew it a second time on its own tiles.
// The saved board then refused to load (`CellCollision`). Fixed in `apply_gesture`
// (`crates/fabrico-host/src/input_apply.rs`, the cascade prune); the Rust probes are
// `probe_c1` to `probe_c7` in `crates/fabrico-host/tests/delete_undo_probes.rs`.
//
// ---------------------------------------------------------------------------
// THE LEGS (both on the demo board, the real dev_render_server, zero mocks)
// ---------------------------------------------------------------------------
//
//   1. R then Delete. Paused, the Sink at (5,8) (fed by the belt on (5,5) to (5,7)) is
//      selected, R turns it (the turn releases the belt's dock) and Delete removes it.
//      Play, then Ctrl+Z. ONE belt holds (5,6), the Sink is back at (5,8) and drawn,
//      the belt count is the demo's, and the board saves and opens again ("Loaded").
//   2. Two machines that share a belt. Paused, the Factory at (4,2) (whose fault port
//      feeds the same belt) and the Sink at (5,8) are deleted. Play, then Ctrl+Z twice.
//      Same checks.
//
// RED WITHOUT THE PRUNE (dev_render_server built from the probes' red commit):
// both legs failed at "ONE belt holds (5,6), not a second drawn over it", Expected 1,
// Received 2, so neither reached the Save. The Rust probes show that board failing to
// load `CellCollision`. Recorded in 76-12-SUMMARY.md, refuter round.
//
// Pause is HOST-global: every leg resumes in a `finally`. MODEL FIRST, THEN RENDER
// HEALTH: `watchPageErrors` before `goto`, `drawnNodesOf` for the restored Sink, and
// `expectRenderLoopAlive` at the end.

/** `STATUS_COPY.editsQueued`, transcribed, not imported. */
const QUEUED_COPY = 'Paused - edits queued until Play';
const LOADED_COPY = 'Loaded';
/** The Sink kind byte (protocol `machine_kind::SINK`), a number on purpose. */
const SINK_KIND = 7;

/** The toolbar's transport toggle: `Pause` while playing, `Play` while paused. */
function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** The toolbar status readout: the first `header [role="status"]`. */
function statusReadout(page: Page) {
  return page.locator('header [role="status"]').first();
}

/** Press Play if the toolbar offers it, then wait for the tick to advance. */
async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0, { message: 'the sim runs again', timeout: 10_000 }).toBe(true);
}

/** Pause and wait until two tick reads 200 ms apart agree. */
async function pauseAndSettle(page: Page, leg: string): Promise<void> {
  await transport(page).click();
  await expect(transport(page), `${leg}: the sim is paused (the toggle offers Play)`).toHaveAttribute('aria-label', 'Play');
  let last = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === last;
        last = t;
        return settled;
      },
      { message: `${leg}: the host stopped ticking`, intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
}

/** How many belts hold the cell (x,y). */
function beltsOn(scene: SceneFacts, x: number, y: number): number {
  return scene.belts.filter((b) => b.tiles.some((t) => t.cell_x === x && t.cell_y === y)).length;
}

/** Click empty floor (9,10) a few px off centre: clears the selection and blurs the panel. */
async function clickFloor(page: Page): Promise<void> {
  const p = await screenCellCentre(page, 9, 10);
  await clickAt(page, p.x + 3, p.y - 2);
}

/** After the Undos: one belt on (5,6), the Sink back and drawn, the demo's belt count,
 *  and the board saves and opens again. */
async function expectWholeBoard(page: Page, leg: string, demoBelts: number): Promise<void> {
  await pollScene(page, (s) => nodeAtAnchor(s, 5, 8)?.kind ?? null, {
    message: `${leg}: the Sink is back at (5,8)`,
  }).toBe(SINK_KIND);
  await page.waitForTimeout(500);
  const scene = await readScene(page);
  expect(beltsOn(scene, 5, 6), `${leg}: ONE belt holds (5,6), not a second drawn over it`).toBe(1);
  expect(scene.belts.length, `${leg}: the demo's belt count`).toBe(demoBelts);
  const sink = nodeAtAnchor(scene, 5, 8);
  await expect
    .poll(async () => (await drawnNodesOf(page)).machines.includes(sink?.id ?? -1), {
      message: `${leg}: the restored Sink is drawn on the machine layer`,
    })
    .toBe(true);

  const fab = join(tmpdir(), `fabrico-e2e-same-pass-cascade-${leg.replace(/\s+/g, '')}-${Date.now()}.fab`);
  page.once('dialog', (d) => d.accept(fab));
  await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
  await expect
    .poll(() => existsSync(fab), { timeout: 45_000, intervals: [200, 500, 1000], message: `${leg}: the .fab was written` })
    .toBe(true);
  // The Open drains this busy board before it swaps (since phase 90's D-08 the Save above
  // leaves it running), up to the host's 512-tick settle budget: measured under the CPU quota
  // at plan 90-04's start, the swap came 17.6 s and 18.9 s after the dispatch. Until 90-04 the
  // page's fixed 10 s load timeout wrote `Load failed` over that drain; now the strip waits
  // for the swap, and so does this poll, with the same 45 s room as the Save above.
  page.once('dialog', (d) => d.accept(fab));
  await page.getByTitle('Load a saved factory').click();
  await expect(statusReadout(page), `${leg}: the saved board opens again`).toHaveText(LOADED_COPY, { timeout: 45_000 });
  await pollScene(page, (s) => beltsOn(s, 5, 6) === 1 && s.belts.length === demoBelts, {
    message: `${leg}: the opened board holds one belt on (5,6) and the demo's belt count`,
  }).toBe(true);
}

// THE SHARED HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12): this spec pauses the
// one shared host, and a test that times out while paused never reaches its `finally`.
// `restoreHostAfterFailedTest` puts the host back to running after a failed or timed-out
// test only, logs `HOST RESTORED after <title>`, and never changes that test's verdict.
test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('76-12 refuter round live: a Delete queued behind an edit of the same pass comes back once', () => {
  test('leg 1: paused, R then Delete on the Sink at (5,8), Play, Ctrl+Z: one belt, and the board loads', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await resumeIfPaused(page);
    const demoBelts = (await readScene(page)).belts.length;
    expect(beltsOn(await readScene(page), 5, 6), 'leg 1: MEASURED, one demo belt holds (5,6)').toBe(1);
    await expectRenderLoopAlive(page, 'leg 1, before the gestures');
    try {
      await pauseAndSettle(page, 'leg 1');
      await selectMachineAt(page, 5, 8);
      await page.keyboard.press('r');
      await page.keyboard.press('Delete');
      await expect(statusReadout(page), 'leg 1: the paused gestures are queued').toHaveText(QUEUED_COPY);
      await resumeIfPaused(page);
      await pollScene(page, (s) => nodeAtAnchor(s, 5, 8) === undefined && beltsOn(s, 5, 6) === 1, {
        message: 'leg 1: Play folds the pass: the Sink is gone and the released belt stays',
      }).toBe(true);

      await clickFloor(page);
      await page.keyboard.press('Control+z');
      await expectWholeBoard(page, 'leg 1', demoBelts);
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });

  test('leg 2: paused, Delete the Factory at (4,2) and the Sink at (5,8) that share a belt, Play, Ctrl+Z twice', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await resumeIfPaused(page);
    const demoBelts = (await readScene(page)).belts.length;
    await expectRenderLoopAlive(page, 'leg 2, before the gestures');
    try {
      await pauseAndSettle(page, 'leg 2');
      await selectMachineAt(page, 4, 2);
      await page.keyboard.press('Delete');
      await clickFloor(page);
      await selectMachineAt(page, 5, 8);
      await page.keyboard.press('Delete');
      await expect(statusReadout(page), 'leg 2: the paused Deletes are queued').toHaveText(QUEUED_COPY);
      await resumeIfPaused(page);
      await pollScene(page, (s) => nodeAtAnchor(s, 5, 8) === undefined && nodeAtAnchor(s, 4, 2) === undefined && beltsOn(s, 5, 6) === 0, {
        message: 'leg 2: Play folds the pass: both machines and their shared belt are gone',
      }).toBe(true);

      await clickFloor(page);
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => nodeAtAnchor(s, 5, 8)?.kind ?? null, {
        message: 'leg 2: the first Ctrl+Z brings the Sink back',
      }).toBe(SINK_KIND);
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => nodeAtAnchor(s, 4, 2) !== undefined, {
        message: 'leg 2: the second Ctrl+Z brings the Factory back',
      }).toBe(true);
      await expectWholeBoard(page, 'leg 2', demoBelts);
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });
});
