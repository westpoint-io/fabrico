import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  expectRenderLoopAlive,
  guardWillAsk,
  itemDotsPerCell,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  waitForFile,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 98-save-open-replay.live.spec.ts - the "Save, open and replay" docs page
// (`site/src/content/docs/get-started/save-open-replay.mdx`) on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// WHAT IT PROVES
// ---------------------------------------------------------------------------
//
// The page says a paused board is saved with the items on its belts, that opening the file brings
// the board back exactly where it was, that a board paused before Load stays paused, and that a
// board playing when Load is pressed plays on from the saved tick. This spec holds the demo with
// Step while orders ride its belts, saves it through the toolbar's Save, lets it run on, loads the
// file through the toolbar's Load ("Load a saved factory") and compares the whole board with what
// was saved: every machine's id, kind, state and cells, every belt's id and which slots hold an
// item, and how many item dots are drawn in each cell. Then it loads the same file again while the
// board plays. The page describes the desktop app's native dialog; the dev browser takes the path
// from `window.prompt`, which this spec answers.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. The demo, held with Step once at least MIN_ITEMS orders ride its belts. Pause wouldn't do:
//      it drains every belt before it freezes, so the saved file would hold no items.
//   2. Save on the toolbar, a temp path into the prompt, and the file on disk with stable bytes.
//      Once the board stands still, its tick T and the full record above are read, and the record
//      has to hold at least MIN_ITEMS items on belts.
//   3. Play until the tick passes T + RUN_ON_TICKS, then Pause, so the board is somewhere else and
//      its belts are empty.
//   4. Load on the toolbar, the same path into the prompt, the status strip reads Loaded, and the
//      model's record equals the saved one: tick T, the same machines in the same states, the same
//      items in the same belt slots. The item dots drawn per cell equal the saved ones too, so a
//      renderer that missed the loaded items fails. The board is still paused.
//   5. Play, and the tick rises from T.
//   6. Run on past T + RUN_ON_TICKS again and press Load while the board plays. An in-page watch
//      latches the lowest tick drawn after the click: it has to drop back to T or just after, and
//      the transport keeps offering Pause while the tick rises again.
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
/** The fewest items on belts the saved board must hold, so the comparison after Load grades items. */
const MIN_ITEMS = 2;
/** How long two reads of a held board must agree to count as held. */
const HELD_MS = 250;
/** The wall-clock part of the held read's cap: a few HELD_MS rounds past the board's drain. */
const HELD_POLL_MS = 1_000;

/**
 * The board as one string: the tick, each machine's id, kind, state and cells, and each belt's id
 * and occupied slots, sorted so two records compare with one `toBe`.
 */
function recordOf(s: SceneFacts): string {
  const nodes = s.nodes.map((n) => `node ${n.id} kind=${n.kind} state=${n.state} cells=${JSON.stringify(n.cells)}`).sort();
  const belts = s.belts.map((b) => `belt ${b.id} items=${b.items} slots=${JSON.stringify(b.occupiedSlots)}`).sort();
  return [`tick=${s.tick}`, ...nodes, ...belts].join('\n');
}

const itemsOn = (s: SceneFacts): number => s.belts.reduce((sum, b) => sum + b.items, 0);

/** Item dots drawn per cell as a sorted list, so two reads compare with one `toEqual`. */
async function dotsRecord(page: Page): Promise<string[]> {
  return Object.entries(await itemDotsPerCell(page))
    .map(([cell, n]) => `${cell}:${n}`)
    .sort();
}

/** Read the board once two reads HELD_MS apart agree, record and drawn dots alike. */
async function heldRecord(page: Page, what: string): Promise<{ scene: SceneFacts; record: string; dots: string[] }> {
  let last = '';
  let lastDots = '';
  let held: { scene: SceneFacts; record: string; dots: string[] } | null = null;
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(HELD_MS);
        const scene = await readScene(page);
        const record = recordOf(scene);
        const dots = await dotsRecord(page);
        const same = record === last && JSON.stringify(dots) === lastDots;
        last = record;
        lastDots = JSON.stringify(dots);
        if (same) held = { scene, record, dots };
        return same;
      },
      {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS) + frameBudgetMs(0, HELD_POLL_MS), `${what}: the board holds still`),
        intervals: [0],
        message: `${what}: two reads ${HELD_MS} ms apart agree on the board and its drawn dots`,
      },
    )
    .toBe(true);
  return held!;
}
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
  test('a board held at tick T with items on its belts, saved, run on and loaded, stands exactly as saved, items and drawn dots included, then plays on; loaded while playing, it plays on from T', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectRenderLoopAlive(page, 'on the demo board');

    // 1. Hold the board with Step once orders ride its belts.
    await pollScene(page, itemsOn, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS), 'orders reach the demo belts'),
      message: `at least ${MIN_ITEMS} items ride the demo's belts`,
    }).toBeGreaterThanOrEqual(MIN_ITEMS);
    await page.getByRole('button', { name: 'Step', exact: true }).click();
    await expect(transportOf(page), 'Step holds the board, so the transport offers Play').toHaveAttribute('aria-label', 'Play');
    await heldRecord(page, 'held with Step');
    await expectRenderLoopAlive(page, 'held before the save', { boardHeld: true });

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
    const saved = await heldRecord(page, 'after the save');
    const savedTick = saved.scene.tick;
    expect(itemsOn(saved.scene), `the saved board holds at least ${MIN_ITEMS} items on its belts`).toBeGreaterThanOrEqual(MIN_ITEMS);
    expect(saved.dots.length, 'the saved board draws its items').toBeGreaterThan(0);
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
    await pollScene(page, recordOf, {
      timeout: addWaitBudget(frameBudgetMs(LOADED_FRAMES), 'the loaded scene reaches the model'),
      message: `the loaded board stands exactly as saved at tick ${savedTick}: machines, states and items in belt slots`,
    }).toBe(saved.record);
    await expect
      .poll(() => dotsRecord(page), {
        timeout: addWaitBudget(frameBudgetMs(LOADED_FRAMES), 'the loaded items are drawn'),
        message: 'the loaded board draws the same item dots in each cell as the saved one',
      })
      .toEqual(saved.dots);
    await expect(transportOf(page), 'a board paused before the Load stays paused').toHaveAttribute('aria-label', 'Play');
    console.log(
      `SAVE_OPEN saved=${savedTick} away=${awayTick} loaded=${(await readScene(page)).tick} items=${itemsOn(saved.scene)} dots=${saved.dots.join(' ')}`,
    );
    await expectRenderLoopAlive(page, 'after the load', { boardHeld: true });

    // 5. Play on from the saved tick.
    await pressTransport(page, 'Play');
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * RUN_ON_TICKS), 'the loaded board plays on'),
      message: `the loaded board plays on from tick ${savedTick}`,
    }).toBeGreaterThan(savedTick);
    await expectRenderLoopAlive(page, 'playing the loaded board');

    // 6. Run on again, then Load while the board plays: it comes back at T and plays on.
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * RUN_ON_TICKS), 'the board runs on before the second load'),
      message: `the board runs on past tick ${savedTick + RUN_ON_TICKS} before the second load`,
    }).toBeGreaterThan(savedTick + RUN_ON_TICKS);
    await expect(transportOf(page), 'the board plays when the second Load is pressed').toHaveAttribute('aria-label', 'Pause');
    const playingTick = (await readScene(page)).tick;
    await page.evaluate(() => {
      const w = window as unknown as { __fabrico: { scene(): { tick: number } }; __soLowest?: { min: number; stop: boolean } };
      const latch = { min: Number.POSITIVE_INFINITY, stop: false };
      w.__soLowest = latch;
      const step = (): void => {
        if (latch.stop) return;
        latch.min = Math.min(latch.min, w.__fabrico.scene().tick);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const lowest = (): Promise<number> =>
      page.evaluate(() => (window as unknown as { __soLowest: { min: number } }).__soLowest.min);
    expect(await guardWillAsk(page), 'playing the loaded board made no unsaved edits, so Load opens no discard guard').toBe(false);
    page.once('dialog', (d) => void d.accept(path));
    await page.locator(`button[title^="${LOAD_TITLE}"]`).click();
    await expect
      .poll(lowest, {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS) + frameBudgetMs(LOADED_FRAMES), 'the Load on a playing board swaps the board in'),
        intervals: [50, 100, 250],
        message: `the board drops back below tick ${playingTick} after the Load on a playing board`,
      })
      .toBeLessThan(playingTick);
    const backAt = await lowest();
    await page.evaluate(() => {
      (window as unknown as { __soLowest: { stop: boolean } }).__soLowest.stop = true;
    });
    expect(backAt, `a board loaded while playing comes back at the saved tick ${savedTick}, not before it`).toBeGreaterThanOrEqual(savedTick);
    expect(backAt, `a board loaded while playing comes back at the saved tick ${savedTick} or just after`).toBeLessThan(savedTick + RUN_ON_TICKS);
    await expect(transportOf(page), 'a board playing when Load was pressed plays on').toHaveAttribute('aria-label', 'Pause');
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * RUN_ON_TICKS), 'the board loaded while playing plays on'),
      message: `the board loaded while playing plays on from tick ${backAt}`,
    }).toBeGreaterThan(backAt + 1);
    console.log(`SAVE_OPEN_PLAYING playing=${playingTick} backAt=${backAt} saved=${savedTick}`);
    await expectRenderLoopAlive(page, 'playing the board loaded while playing');

    errs.assertNone('the save, run on and both loads');
  });
});
