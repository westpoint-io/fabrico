import { test, expect, type Page } from './support/liveTest';
import {
  cameraOf,
  drawnNodesOf,
  expectRenderLoopAlive,
  glyphSubjectOn,
  handPlaceAt,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';

// 88-edit-behind-undo.live.spec.ts (plan 88-04, WORK-03, phase 88 success criterion 1, D-02,
// D-03) - an edit queued behind an Undo lands on the machine or label the user picked. On the
// REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero
// injected packets: every machine comes off the palette by hand, every press is the shipped
// control, and the board is paused and played from the toolbar.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// Success criterion 1: on a paused board, pressing Ctrl+Z and then deleting or editing a
// machine or label, then pressing Play, changes the one the user picked and nothing else.
// D-02: the host keeps the handle tables of the last 8 board generations and resolves a
// gesture's handles against the table of the generation its header names, the one the user
// was looking at. D-03: when that table cannot say which node it was, the edit is refused and
// never applied to a different node (the host legs in `edit_lands_where_aimed.rs`).
//
// THE DEFECT (todo `2026-10-07-queued-edit-behind-undo-names-a-reminted-handle.md`, the 76-18
// command-path probe, research P88-W3a and P88-W3b). An Undo resets the render producer, which
// re-mints every handle from 0. On a paused board the Undo and the edit after it are drained
// in the same Play, the Undo first; before plan 88-04 the edit's handle was then read in the
// NEW table, where it named a different node. The user deleted C and lost B.
//
// ---------------------------------------------------------------------------
// THE LEGS (the two 76-18 probes, replayed by hand and graded)
// ---------------------------------------------------------------------------
//
//   1. THE DELETE. Sources A (4,4), B (8,4), C (12,4); A deleted, Ctrl+Z, Ctrl+Shift+Z. Pause;
//      Ctrl+Z (queued); select C; Delete (queued); Play. Graded once the Undo has folded and
//      the board has run on: the machine layer draws exactly two machines, both Source art,
//      on the handles the scene holds at (4,4) and (8,4), and nothing at (12,4).
//
// The label probe (words applied behind a paused Undo) rides the same handle-table fix, so leg 1
// stands for it here; the host side is pinned in `edit_lands_where_aimed.rs`.
//
// Each leg was read red against a dev host built at the plan's start revision
// (88-EVIDENCE.md `## Plan 88-04`): leg 1 drew C and lost B, and the label probe put the words
// on LB.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` on a
// ticking board before the pause and after Play, and the watcher's `assertNone`. Never while
// paused: the render clock advances with the board's ticks.
//
// Pause is HOST-global: every leg presses Play again in a `finally`, and a failed test restores
// the shared host (`restoreHostAfterFailedTest`).

/** Kind bytes (protocol `machine_kind`), transcribed: the live suite imports no product source. */
const KIND_SOURCE = 0;
/** The status the toolbar shows for an edit made on a paused board (`controlHandlers.ts`). */
const EDITS_QUEUED = 'Paused - edits queued until Play';
/** The three Sources of leg 1, A, B and C. */
const A_AT: readonly [number, number] = [4, 4];
const B_AT: readonly [number, number] = [8, 4];
const C_AT: readonly [number, number] = [12, 4];
/** The ticks one host answer may take on a playing board, for the derived budgets. */
const ANSWER_TICKS = 120;
/** Ticks the board runs on after the Undo folds before a leg grades: the edit behind it is
 *  drained on the pass after the Undo's, so a misapplied edit has long landed by then. */
const RUN_ON_TICKS = 30;
/** Phase 87 measured about 20 ticks a second under the CPU quota, so every tick budget is
 *  this many times the ticks it waits for (`88-late-label-echo`). */
const SLOW_BOARD = 3;

function answerWait(what: string): number {
  return addWaitBudget(tickBudgetMs(SLOW_BOARD * ANSWER_TICKS), what);
}

function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
}

async function selectedNode(page: Page): Promise<number | null> {
  return page.evaluate(
    () => (window as unknown as { __fabrico: { selectedNode(): number | null } }).__fabrico.selectedNode(),
  );
}

/** The page's board generation, read off `window.__fabrico.scene()` (phase 88, D-02). */
async function generationOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { scene(): { generation: number } } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    return hook.scene().generation;
  });
}

/** The toolbar's status row. */
async function statusText(page: Page): Promise<string> {
  return ((await page.locator('header [role="status"]').first().textContent()) ?? '').trim();
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
      { message: 'the host stopped ticking', intervals: [250], timeout: answerWait('the paused host settles') },
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

/** Empty floor, far from every node this spec places. */
async function clickFloor(page: Page): Promise<void> {
  const floor = await screenCellCentre(page, 2, 14);
  await page.mouse.click(floor.x + 3, floor.y - 2);
}

function at(s: SceneFacts, cell: readonly [number, number]) {
  return nodeAtAnchor(s, cell[0], cell[1]);
}

function describeNodes(s: SceneFacts): string {
  return s.nodes
    .map((n) => {
      const [ax, ay] = [Math.min(...n.cells.map((c) => c[0])), Math.min(...n.cells.map((c) => c[1]))];
      return `h${n.id}:k${n.kind}@(${ax},${ay})${n.label ? `"${n.label.text}"` : ''}`;
    })
    .join(' ');
}

/** Press Play, wait until the node at `back` is in the scene again (the queued Undo folded),
 *  then let the board run on `RUN_ON_TICKS` ticks so the edit drained after it has landed. */
async function playAndRunOn(page: Page, back: readonly [number, number], what: string): Promise<SceneFacts> {
  await transport(page).click();
  await expect(transport(page), `${what}: the sim runs (the toggle offers Pause)`).toHaveAttribute('aria-label', 'Pause');
  await pollScene(page, (s) => at(s, back) !== undefined, {
    message: `${what} PRECONDITION: after Play a node is at (${back.join(',')}) again (the queued Undo folded)`,
    timeout: answerWait(`${what}: the queued Undo folds`),
  }).toBe(true);
  const folded = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick >= folded + RUN_ON_TICKS, {
    message: `${what}: the board ran ${RUN_ON_TICKS} ticks past the Undo`,
    timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * RUN_ON_TICKS), `${what}: run on past the Undo`),
  }).toBe(true);
  return readScene(page);
}

test.describe('WORK-03 live: an edit queued behind an Undo lands on the node the user picked', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('leg 1: a Delete queued behind a paused Ctrl+Z removes the machine the user picked', async ({ page }) => {
    const errs = watchPageErrors(page);
    try {
      await emptyBoardAtScaleOne(page);
      await expectRenderLoopAlive(page, 'leg 1: before the Sources are placed');

      for (const cell of [A_AT, B_AT, C_AT]) {
        await handPlaceAt(page, 'Source', cell[0], cell[1]);
        await pollScene(page, (s) => at(s, cell)?.kind ?? null, {
          message: `leg 1: the host echoed a Source at (${cell.join(',')})`,
          timeout: answerWait('leg 1: a Source echoes'),
        }).toBe(KIND_SOURCE);
        await page.keyboard.press('Escape');
        await clickFloor(page);
      }
      expect((await readScene(page)).nodes.length, 'leg 1 PRECONDITION: three Sources on the board').toBe(3);

      // Delete A, Ctrl+Z, Ctrl+Shift+Z, each folded on the playing board.
      await selectMachineAt(page, A_AT[0], A_AT[1]);
      await page.keyboard.press('Delete');
      await pollScene(page, (s) => s.nodes.length, { message: 'leg 1: the Delete removed A', timeout: answerWait('leg 1: Delete A') }).toBe(2);
      await clickFloor(page);
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => s.nodes.length, { message: 'leg 1: Ctrl+Z put A back', timeout: answerWait('leg 1: Undo') }).toBe(3);
      await page.keyboard.press('Control+Shift+z');
      await pollScene(page, (s) => s.nodes.length, { message: 'leg 1: Ctrl+Shift+Z deleted A again', timeout: answerWait('leg 1: Redo') }).toBe(2);
      await expectRenderLoopAlive(page, 'leg 1: after Delete, Undo and Redo, before the pause');

      // Pause; Ctrl+Z, queued on the paused board.
      await pauseAndSettle(page);
      await clickFloor(page);
      await page.keyboard.press('Control+z');
      await expect.poll(() => statusText(page), {
        message: 'leg 1 PRECONDITION: the toolbar says the Undo is queued',
        timeout: addWaitBudget(frameBudgetMs(8), 'leg 1: the queued status shows'),
      }).toBe(EDITS_QUEUED);
      const queued = await readScene(page);
      expect(
        { nodes: queued.nodes.length, a: at(queued, A_AT)?.id ?? null },
        `leg 1 PRECONDITION: the queued Undo has not folded (B and C only): ${describeNodes(queued)}`,
      ).toEqual({ nodes: 2, a: null });
      const bBefore = at(queued, B_AT)!.id;
      const cBefore = at(queued, C_AT)!.id;

      // The user picks C and presses Delete.
      await selectMachineAt(page, C_AT[0], C_AT[1]);
      expect(await selectedNode(page), 'leg 1 PRECONDITION: the selection is C, on the handle the board shows it').toBe(cBefore);
      await page.keyboard.press('Delete');
      console.log(`LEG1_QUEUED scene=[${describeNodes(queued)}] B=h${bBefore} C=h${cBefore} generation=${await generationOf(page)}`);

      const after = await playAndRunOn(page, A_AT, 'leg 1');
      const a = at(after, A_AT);
      const b = at(after, B_AT);
      const c = at(after, C_AT);
      const drawn = await drawnNodesOf(page);
      console.log(
        `LEG1_AFTER scene=[${describeNodes(after)}] drawn=${JSON.stringify(drawn)} generation=${await generationOf(page)}`,
      );

      // THE GRADE, on what the machine layer draws: exactly the two machines the scene holds at
      // (4,4) and (8,4), each drawing Source art, and nothing at (12,4).
      expect(c, `leg 1: the Delete took C, so nothing is at (12,4): ${describeNodes(after)}`).toBeUndefined();
      expect(
        { a: a?.kind ?? null, b: b?.kind ?? null },
        `leg 1: A is back at (4,4) and B is still at (8,4): ${describeNodes(after)}`,
      ).toEqual({ a: KIND_SOURCE, b: KIND_SOURCE });
      const want = [a!.id, b!.id].sort((x, y) => x - y);
      await expect
        .poll(async () => (await drawnNodesOf(page)).machines, {
          message: 'leg 1: the machine layer draws exactly the Sources at (4,4) and (8,4)',
          timeout: addWaitBudget(frameBudgetMs(8), 'leg 1: the board draws the outcome'),
        })
        .toEqual(want);
      for (const [name, node] of [
        ['(4,4)', a!],
        ['(8,4)', b!],
      ] as const) {
        expect(await glyphSubjectOn(page, node.id), `leg 1: the machine drawn at ${name} is Source art`).toBe('source');
      }
      await expectRenderLoopAlive(page, 'leg 1: after Play');
      errs.assertNone('leg 1: a Delete behind a paused Undo');
    } finally {
      await resumeIfPaused(page);
      await page.keyboard.press('Escape');
    }
  });
});
