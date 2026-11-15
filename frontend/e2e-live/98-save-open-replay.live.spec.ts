import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  expectRenderLoopAlive,
  guardWillAsk,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  waitForFile,
  watchPageErrors,
} from './support/oracle';

// 98-save-open-replay.live.spec.ts - the "Save, open and replay" docs page
// (`site/src/content/docs/get-started/save-open-replay.mdx`) on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// WHAT IT PROVES
// ---------------------------------------------------------------------------
//
// The page says opening a project file replays the saved events and edits forward and brings the
// board back at the tick it was saved, and that a board paused before Load stays paused. This spec
// saves the demo board at a known tick through the toolbar's Save, lets it run on past that tick,
// loads the file through the toolbar's Load ("Load a saved factory"), and checks the tick and the
// machines are back where they were. The page describes the desktop app's native dialog; the dev
// browser takes the path from `window.prompt`, which this spec answers.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. The demo, paused. A Pause drains the items in flight before it freezes, so the saved tick
//      T is read once the tick has stood still for SETTLE_MS.
//   2. Save on the toolbar, a temp path into the prompt, and the file on disk with stable bytes.
//      The tick still reads T.
//   3. Play until the tick passes T + RUN_ON_TICKS, then Pause, so the board is somewhere else.
//   4. Load on the toolbar, the same path into the prompt, the status strip reads Loaded, and the
//      model reads tick T with the node count from before the save. The board is still paused.
//   5. Play, and the tick rises from T.
//
// Render health: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after each step (the
// held-board form while paused, since the render clock follows the sim clock), and the watcher's
// `assertNone` at the end (fabrico-model-oracle-blindspot).

/** The toolbar's Save button title (`Toolbar.tsx`, with the shortcut label). */
const SAVE_TITLE = 'Save (Ctrl+S) - Shift for Save As';
/** The toolbar's Load button title starts with this (`Toolbar.tsx`, the shortcut follows). */
const LOAD_TITLE = 'Load a saved factory';
/** The status strip's readout (`controlHandlers.ts` `STATUS_COPY`). */
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';
/** How far past the saved tick the board runs before the Load. */
const RUN_ON_TICKS = 60;
/** How long the paused tick must stand still to count as settled (the 90-save-keeps-running rule). */
const SETTLE_MS = 1_000;
/** The host's drain budget for a Pause, Save or Load (`sim_loop.rs` `MAX_SETTLE_TICKS`, 512). */
const SETTLE_TICKS = 512;
/** How many times slower than full speed the host may tick and still be graded (the 87 specs' 3). */
const SLOW_BOARD = 3;
/** Frames the Load's repopulate keyframe and the strip's update take to reach the page. */
const LOADED_FRAMES = 10;

/** The transport button. Icon-only: its accessible name is its `aria-label`, `Pause` while the
 *  sim runs and `Play` while it is paused. */
function transportOf(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** Press the transport button if it offers `want`, then wait until it offers the other one. */
async function pressTransport(page: Page, want: 'Play' | 'Pause'): Promise<void> {
  await expect(transportOf(page), `the transport offers ${want}`).toHaveAttribute('aria-label', want);
  await transportOf(page).click();
  await expect(transportOf(page), `${want} pressed`).toHaveAttribute('aria-label', want === 'Play' ? 'Pause' : 'Play');
}

/** The paused board's tick once it has stood still for SETTLE_MS (the Pause drains first). */
async function settledTick(page: Page, what: string): Promise<number> {
  let settled = (await readScene(page)).tick;
  let since = Date.now();
  await expect
    .poll(
      async () => {
        const now = (await readScene(page)).tick;
        if (now !== settled) {
          settled = now;
          since = Date.now();
        }
        return Date.now() - since;
      },
      {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS) + frameBudgetMs(0, SETTLE_MS), `${what}: the drain settles`),
        intervals: [100, 250],
        message: `${what}: the paused board settles, its tick standing still for ${SETTLE_MS} ms`,
      },
    )
    .toBeGreaterThanOrEqual(SETTLE_MS);
  return settled;
}

let savePath: string | null = null;

test.afterEach(async ({ page }, testInfo) => {
  if (savePath !== null) rmSync(savePath, { force: true });
  savePath = null;
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('98 live: Save, open and replay, through the toolbar on the real host', () => {
  test('a board saved paused at tick T, run on past T + 60 and loaded, stands at tick T with the same machines, then plays on', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectRenderLoopAlive(page, 'on the demo board');

    // 1. Pause and read the settled tick.
    await pressTransport(page, 'Pause');
    const savedTick = await settledTick(page, 'before the save');
    const nodesBefore = (await readScene(page)).nodes.length;
    expect(nodesBefore, 'the demo has machines to save').toBeGreaterThan(0);
    await expectRenderLoopAlive(page, 'paused before the save', { boardHeld: true });

    // 2. Save through the toolbar.
    savePath = join(tmpdir(), `fabrico-e2e-98-save-open-${process.pid}-${Date.now()}.fab`);
    const path = savePath;
    page.once('dialog', (d) => void d.accept(path));
    await page.getByTitle(SAVE_TITLE).click();
    await waitForFile(
      path,
      `the Save wrote ${path}`,
      addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS), 'the host writes the project file'),
    );
    expect((await readScene(page)).tick, 'the save on a paused board leaves the tick where it was').toBe(savedTick);
    await expectRenderLoopAlive(page, 'after the save', { boardHeld: true });

    // 3. Run on past the saved tick, then pause somewhere else.
    await pressTransport(page, 'Play');
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * RUN_ON_TICKS), 'the board runs on past the saved tick'),
      message: `the board runs on past tick ${savedTick + RUN_ON_TICKS}`,
    }).toBeGreaterThan(savedTick + RUN_ON_TICKS);
    await expectRenderLoopAlive(page, 'running on after the save');
    await pressTransport(page, 'Pause');
    const awayTick = await settledTick(page, 'before the load');
    expect(awayTick, 'the board stands past the saved tick before the load').toBeGreaterThan(savedTick + RUN_ON_TICKS);

    // 4. Load the file through the toolbar.
    expect(await guardWillAsk(page), 'running the board made no unsaved edits, so Load opens no discard guard').toBe(false);
    page.once('dialog', (d) => void d.accept(path));
    await page.locator(`button[title^="${LOAD_TITLE}"]`).click();
    await expect
      .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS) + frameBudgetMs(LOADED_FRAMES), 'the Load swaps the board in'),
        intervals: [50, 100, 250],
        message: 'the status strip reads Loaded',
      })
      .toBe('Loaded');
    await pollScene(page, (s) => `tick=${s.tick} nodes=${s.nodes.length}`, {
      timeout: addWaitBudget(frameBudgetMs(LOADED_FRAMES), 'the loaded scene reaches the model'),
      message: `the loaded board stands at the saved tick ${savedTick} with the ${nodesBefore} machines it had`,
    }).toBe(`tick=${savedTick} nodes=${nodesBefore}`);
    await expect(transportOf(page), 'a board paused before the Load stays paused').toHaveAttribute('aria-label', 'Play');
    console.log(`SAVE_OPEN saved=${savedTick} away=${awayTick} loaded=${(await readScene(page)).tick} nodes=${nodesBefore}`);
    await expectRenderLoopAlive(page, 'after the load', { boardHeld: true });

    // 5. Play on from the saved tick.
    await pressTransport(page, 'Play');
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * RUN_ON_TICKS), 'the loaded board plays on'),
      message: `the loaded board plays on from tick ${savedTick}`,
    }).toBeGreaterThan(savedTick);
    await expectRenderLoopAlive(page, 'playing the loaded board');

    errs.assertNone('the save, run on and load');
  });
});
