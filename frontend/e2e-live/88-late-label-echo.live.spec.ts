import { test, expect, type Page } from '@playwright/test';
import {
  cameraOf,
  drawnNodesOf,
  expectRenderLoopAlive,
  handPlaceAt,
  newBoard,
  pollScene,
  readScene,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';

// 88-late-label-echo.live.spec.ts (plan 88-01, FAIL-08, D-08, phase 88 success criterion 4)
// - a label whose echo lands after the user armed another tool is neither selected nor given
// the keyboard. On the REAL host (dev_render_server, real Core -> RenderProducer -> postcard ->
// WS). Zero mocks, zero injected packets: the label and the Source come off the palette by
// hand, the board is paused and played from the toolbar.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-08: a label echo that arrives after the user armed another tool does not select the label
// and does not take focus. Plan 76-10 fixed this in the client, with its own test:
// arming any tool marks every pending Place abandoned (`abandonPendingPlacements`), and the
// echo watcher skips an abandoned entry before its label branch, so the late label claims its
// node and does nothing else. Phase 88 re-measured it at its start revision and found it
// fixed (88-EVIDENCE.md `## Red-first record`, `D01 case=FAIL-08`); this spec is its proof on
// the real board, and the one plan 88-05's rewrite of the echo watcher must keep green.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE CASE. An empty board at zoom 1 is paused from the toolbar. A Label is dropped by
//      hand on (10,12): the host answers nothing while paused. The `Place Source` row is
//      clicked, then Play. Once the label is in the scene and the board has run on, graded:
//      `window.__fabrico.selectedNode()` is not the label's handle, no label panel is open,
//      `document.activeElement` is neither an `input` nor a `textarea`, the `Place Source` row
//      still reads `aria-pressed="true"`, and a hand click on another free cell (16,10) places
//      a Source that the machine layer draws.
//   2. THE CONTROL. The same empty board, playing. A Label dropped by hand on (10,12) with no
//      tool change is selected, its panel heading reads `Label`, and its Text field
//      (`#fab-label-text`) holds the keyboard. Without this leg, leg 1 could pass on a page
//      where no label is ever selected or focused.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after
// each gesture block on a ticking board and at the grading, and the watcher's `assertNone`. Never
// while paused: the render clock advances with the board's ticks (`expectRenderLoopAlive`).
//
// Pause is HOST-global: every leg presses Play again in a `finally`, and a failed test restores
// the shared host (`restoreHostAfterFailedTest`).
//
// THE MUTATION (88-EVIDENCE.md `## Plan 88-01`, `LIVE_MUT 88-late-label-echo verdict=RED
// by=abandoned-skip-removed`): with the abandoned-entry skip deleted from the echo watcher
// (`frontend/src/input/gestures.ts`, the `if (p.abandoned) { continue; }` before the label
// branch), served by Vite from a throwaway worktree against the main tree's host, leg 1 reads
// red: the late label is selected and its Text field takes the keyboard.

/** The label kind byte (protocol `machine_kind::LABEL`), transcribed: the live suite imports no product source. */
const KIND_LABEL = 11;
/** The Source kind byte (protocol `machine_kind::SOURCE`). */
const KIND_SOURCE = 0;
/** `LABEL_TEXT_FIELD_ID` (`src/chrome/LabelConfigBody.tsx`), transcribed. */
const LABEL_TEXT_FIELD = 'fab-label-text';
/** Where each leg drops its label, and where leg 1's second Source goes. */
const LABEL_AT: readonly [number, number] = [10, 12];
const SOURCE_AT: readonly [number, number] = [16, 10];
/**
 * Ticks the board runs on after the label first shows in the scene, before leg 1 grades. The
 * echo watcher acts on the next drawn frame after the packet; 30 ticks is many frames at any
 * rate this host runs at, so a late selection or focus would have happened by then.
 */
const RUN_ON_TICKS = 30;
/** The ticks a single echo is allowed to take on a playing board, for the derived budgets. */
const ECHO_TICKS = 120;
/** How many times slower than `FLOOR_TPS` a board may tick and still be graded: phase 87 measured
 *  about 20 ticks a second under the CPU quota (`87-source-backed-up.live.spec.ts`), under the
 *  floor's 28, so every tick budget below is this many times the ticks it waits for. */
const SLOW_BOARD = 3;

function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

function paletteRow(page: Page, kind: string) {
  return page.getByRole('button', { name: `Place ${kind}`, exact: true });
}

async function selectedNode(page: Page): Promise<number | null> {
  return page.evaluate(
    () => (window as unknown as { __fabrico: { selectedNode(): number | null } }).__fabrico.selectedNode(),
  );
}

/** The focused element as the user's keyboard sees it: its tag and id. */
async function focusedElement(page: Page): Promise<{ tag: string; id: string }> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName.toLowerCase() ?? '', id: el?.id ?? '' };
  });
}

function labelAt(s: SceneFacts, x: number, y: number) {
  return s.nodes.find((n) => n.kind === KIND_LABEL && n.cells.some(([cx, cy]) => cx === x && cy === y)) ?? null;
}

function sourceAt(s: SceneFacts, x: number, y: number) {
  return s.nodes.find((n) => n.kind === KIND_SOURCE && n.cells.some(([cx, cy]) => cx === x && cy === y)) ?? null;
}

async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
}

/** Pause from the toolbar and wait until the host stops ticking (two reads in a row agree). */
async function pauseAndSettle(page: Page): Promise<number> {
  await transport(page).click();
  await expect(transport(page), 'the sim is paused (the toggle offers Play)').toHaveAttribute('aria-label', 'Play');
  let pausedAt = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === pausedAt;
        pausedAt = t;
        return settled;
      },
      {
        message: 'the host stopped ticking',
        intervals: [200],
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ECHO_TICKS), 'the paused host settles'),
      },
    )
    .toBe(true);
  return pausedAt;
}

async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await resumeIfPaused(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

test.describe('FAIL-08 live: a late label echo never takes the selection or the keyboard', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('leg 1: a label that lands after the Source tool was armed is neither selected nor focused', async ({ page }) => {
    const errs = watchPageErrors(page);
    try {
      await emptyBoardAtScaleOne(page);
      await expectRenderLoopAlive(page, 'leg 1: before the board is paused');

      const pausedAt = await pauseAndSettle(page);
      await handPlaceAt(page, 'Label', LABEL_AT[0], LABEL_AT[1]);
      // PRECONDITION: the Place is queued, not folded. The host ticks nothing while paused, so
      // no label can be in the scene yet; read across a few frames so a late echo would show.
      await expect
        .poll(async () => labelAt(await readScene(page), LABEL_AT[0], LABEL_AT[1]), {
          message: 'leg 1 PRECONDITION: the paused host has not folded the label',
          intervals: [250, 250, 250, 250],
          timeout: addWaitBudget(frameBudgetMs(4), 'leg 1: the queued label stays unfolded'),
        })
        .toBeNull();
      expect((await readScene(page)).tick, 'leg 1 PRECONDITION: still paused at the settled tick').toBe(pausedAt);

      // The user arms the Source tool BEFORE the label's echo exists.
      await paletteRow(page, 'Source').click();
      await expect(paletteRow(page, 'Source'), 'leg 1: the Source tool is in hand').toHaveAttribute('aria-pressed', 'true');
      // No render-loop check here: the board's render clock advances with its ticks, and a
      // paused board does not tick. The next one runs after Play.

      await transport(page).click();
      await expect(transport(page), 'leg 1: the toggle offers Pause again').toHaveAttribute('aria-label', 'Pause');
      await pollScene(page, (s) => labelAt(s, LABEL_AT[0], LABEL_AT[1]) !== null, {
        message: 'leg 1: the real host folded the queued label on Play',
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ECHO_TICKS), 'leg 1: the queued label echoes'),
      }).toBe(true);
      const seen = await readScene(page);
      const label = labelAt(seen, LABEL_AT[0], LABEL_AT[1])!;
      await pollScene(page, (s) => s.tick >= seen.tick + RUN_ON_TICKS, {
        message: `leg 1: the board ran ${RUN_ON_TICKS} ticks past the label's echo`,
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * RUN_ON_TICKS), 'leg 1: run on past the echo'),
      }).toBe(true);
      await expectRenderLoopAlive(page, 'leg 1: after the late label echoed');

      expect(await selectedNode(page), 'leg 1: the late label is NOT the selection').not.toBe(label.id);
      expect(await page.locator(`#${LABEL_TEXT_FIELD}`).count(), 'leg 1: no label panel is open').toBe(0);
      const focused = await focusedElement(page);
      expect(['input', 'textarea'], `leg 1: no text field holds the keyboard (focused ${JSON.stringify(focused)})`).not.toContain(
        focused.tag,
      );
      await expect(paletteRow(page, 'Source'), 'leg 1: the Source tool is still in hand').toHaveAttribute('aria-pressed', 'true');

      // The armed tool still works: a hand click on another free cell places a Source.
      const cell = await screenCellCentre(page, SOURCE_AT[0], SOURCE_AT[1]);
      await page.mouse.move(cell.x - 20, cell.y + 14);
      await page.mouse.move(cell.x + 3, cell.y - 2, { steps: 6 });
      const under = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return `${el?.tagName.toLowerCase() ?? 'none'}#${el?.id ?? ''}`;
        },
        [cell.x + 3, cell.y - 2] as const,
      );
      console.log(
        `LEG1_SECOND_CLICK cell=${SOURCE_AT.join(',')} screen=${Math.round(cell.x)},${Math.round(cell.y)} under=${under} ` +
          `sourceArmed=${await paletteRow(page, 'Source').getAttribute('aria-pressed')}`,
      );
      expect(under.startsWith('canvas'), `leg 1 PRECONDITION: the board's canvas is under the click point (${under})`).toBe(
        true,
      );
      await page.mouse.down();
      await page.mouse.up();
      await pollScene(page, (s) => sourceAt(s, SOURCE_AT[0], SOURCE_AT[1]) !== null, {
        message: 'leg 1: the armed Source tool placed a Source on the second cell',
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ECHO_TICKS), 'leg 1: the second Source echoes'),
      }).toBe(true);
      const source = sourceAt(await readScene(page), SOURCE_AT[0], SOURCE_AT[1])!;
      await expect
        .poll(async () => (await drawnNodesOf(page)).machines.includes(source.id), {
          message: 'leg 1: the machine layer draws the new Source',
          timeout: addWaitBudget(frameBudgetMs(8), 'leg 1: the new Source is drawn'),
        })
        .toBe(true);
      expect(await selectedNode(page), 'leg 1: the label is still not the selection').not.toBe(label.id);
      await expectRenderLoopAlive(page, 'leg 1: after the second Source');
      errs.assertNone('leg 1: a label echo after the Source tool was armed');
    } finally {
      await resumeIfPaused(page);
      await page.keyboard.press('Escape');
    }
  });

  test('leg 2: a label placed on a playing board with no tool change is selected and its Text field focused', async ({ page }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'leg 2: before the label is placed');

    await handPlaceAt(page, 'Label', LABEL_AT[0], LABEL_AT[1]);
    await pollScene(page, (s) => labelAt(s, LABEL_AT[0], LABEL_AT[1]) !== null, {
      message: 'leg 2: the real host echoed the label',
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ECHO_TICKS), 'leg 2: the label echoes'),
    }).toBe(true);
    const label = labelAt(await readScene(page), LABEL_AT[0], LABEL_AT[1])!;
    await expectRenderLoopAlive(page, 'leg 2: after the label echoed');

    await expect
      .poll(() => selectedNode(page), {
        message: 'leg 2: the placed label is the selection',
        timeout: addWaitBudget(frameBudgetMs(8), 'leg 2: the label is selected'),
      })
      .toBe(label.id);
    const heading = page.locator('#fab-config-heading');
    await expect(heading, 'leg 2: the label panel is open').toBeVisible();
    await expect(heading, 'leg 2: the panel heading names a Label').toContainText('Label');
    await expect
      .poll(() => focusedElement(page), {
        message: "leg 2: the label's Text field holds the keyboard",
        timeout: addWaitBudget(frameBudgetMs(8), 'leg 2: the Text field takes focus'),
      })
      .toEqual({ tag: 'textarea', id: LABEL_TEXT_FIELD });
    await expectRenderLoopAlive(page, 'leg 2: with the label selected and focused');
    errs.assertNone('leg 2: a label placed with no tool change');
    await page.keyboard.press('Escape');
  });
});
