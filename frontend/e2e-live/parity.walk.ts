import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';
import { frameBudgetMs } from '../e2e/support/frameSampler';
import { portOf, transport } from './support/beltBoard';
import {
  CELL,
  cameraOf,
  expectRenderLoopAlive,
  handDragBetween,
  handPlaceAt,
  newBoard,
  nubAnchor,
  pollScene,
  pressSegment,
  readScene,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  waitForFile,
  watchPageErrors,
} from './support/oracle';

// parity.walk.ts - does the same list of gestures end on the same board?
//
// A tutorial that watches the user must not change what the user builds. The comparison that
// says so has to be able to tell two boards apart, and it has to hold still: a live board advances
// on wall-clock time, so two sittings land on different ticks. So this runs on a paused board,
// where nothing moves until the Step button says so, and every gesture is followed by a fixed
// number of Steps: one, or two for a belt, whose Docks go out after the belt is echoed. A retry
// Step would make the tick counts differ, so a missing echo is a hard failure.
//
// Each board is saved through the toolbar and read back from the file by the `replay_hash` example,
// which prints the head tick, the tick hash and the edit log.
//
// THE RUN STOPS WHILE ITEMS STILL RIDE THE BELT. A Sink emits a Command on delivery, the executor
// is held while paused, and Save then drains on real time, so the saved tick would depend on the
// wall clock. The belt must read items above 0 with its head slot empty, and the tick read before
// the save must equal the tick printed from the file, which shows no drain ran.
//
// THE NEGATIVE CONTROL stays in the test: one more Step after the second save moves both the
// printed tick and the hash, so the comparison is known to be able to differ.

/**
 * Steps after the last gesture. The gestures take 5 ticks and the Timer's 60-tick interval puts
 * the first item on the belt at tick 62, in slot 19 of 20. At tick 81 it is in slot 9, about half
 * way, and it would reach the Sink near tick 100.
 */
const PARITY_STEPS = 76;
/** Cells from the Source east to the Sink, on one row: five belt tiles between them. */
const SINK_OFFSET = 6;
/** Drawn frames the page may take to see the echoed belt and send its Docks. */
const DOCKS_SENT_FRAMES = 8;

/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;

interface BoardCells {
  source: readonly [number, number];
  sink: readonly [number, number];
}

interface Printed {
  tick: number;
  hash: string;
  edits: string[];
}

/** The built example; a run from a throwaway worktree names this tree's binary with the env var. */
function replayHashBinary(): string {
  return process.env.FABRICO_REPLAY_HASH ?? fileURLToPath(new URL('../../target/debug/examples/replay_hash', import.meta.url));
}

/** What `replay_hash` prints for a saved board. */
function readSavedBoard(path: string): Printed {
  const text = execFileSync(replayHashBinary(), [path], { encoding: 'utf8' });
  const lines = text.trimEnd().split('\n');
  const tick = /^tick (\d+)$/.exec(lines[0] ?? '');
  const hash = /^hash ([0-9a-f]{64})$/.exec(lines[1] ?? '');
  expect(tick, `replay_hash printed a tick line first:\n${text}`).not.toBeNull();
  expect(hash, `replay_hash printed a hash line second:\n${text}`).not.toBeNull();
  const edits = lines.slice(2);
  expect(
    edits.every((l) => l.startsWith('edit ')),
    `every other line is an edit line:\n${text}`,
  ).toBe(true);
  return { tick: Number(tick![1]), hash: hash![1], edits };
}

/** How many gestures the page has handed to the transport. */
async function inputsSent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { inputsSent?(): number } }).__fabrico;
    if (typeof hook?.inputsSent !== 'function') throw new Error('window.__fabrico.inputsSent() not installed');
    return hook.inputsSent();
  });
}

/** Press Step once and require the tick to rise by exactly 1. Never pressed twice. */
async function stepOnce(page: Page, what: string): Promise<number> {
  const before = (await readScene(page)).tick;
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await pollScene(page, (s) => s.tick, {
    message: `${what}: one Step moved the paused board from tick ${before} to ${before + 1}`,
  }).toBe(before + 1);
  return before + 1;
}

/** Pause if the toolbar offers Pause, then wait for two equal tick reads 200 ms apart. */
async function pauseBoard(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Pause') await transport(page).click();
  await expect(transport(page), 'the board is paused (the toggle offers Play)').toHaveAttribute('aria-label', 'Play');
  let last = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const held = t === last;
        last = t;
        return held;
      },
      { message: 'the host stopped ticking', intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
}

/** Save As through the toolbar to `path` and wait until the file is whole. */
async function saveTo(page: Page, path: string): Promise<void> {
  page.once('dialog', (d) => d.accept(path));
  await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click({ modifiers: ['Shift'] });
  await waitForFile(path, `the host wrote ${path}`);
}

/**
 * One sitting: a New board on the paused host, the gestures with one Step each, a fixed number
 * of further Steps, then a save. Answers what `replay_hash` prints from the file.
 */
async function runBoard(page: Page, cells: BoardCells, outPath: string): Promise<Printed> {
  await newBoard(page);
  expect((await readScene(page)).nodes, 'New left an empty board').toEqual([]);

  await handPlaceAt(page, 'Source', cells.source[0], cells.source[1]);
  await stepOnce(page, 'place the Source');
  await pollScene(page, (s) => s.nodes.length, { message: 'the Source was echoed after its one Step' }).toBe(1);

  await handPlaceAt(page, 'Sink', cells.sink[0], cells.sink[1]);
  await page.keyboard.press('Escape');
  await stepOnce(page, 'place the Sink');
  await pollScene(page, (s) => s.nodes.length, { message: 'the Sink was echoed after its one Step' }).toBe(2);

  // The Timer: `applyConfig` would wait for an answer a paused board withholds until the next Step.
  await selectMachineAt(page, cells.source[0], cells.source[1]);
  await pressSegment(page, 'Trigger', 'Timer');
  const marker = page.getByText(CONFIG_NOT_APPLIED_MARKER);
  await expect(marker, 'the panel holds an unapplied Timer, so its clearing below can fail').toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  await stepOnce(page, 'apply the Timer');
  await expect(marker, 'the one Step answered the Apply').toHaveCount(0, { timeout: 10_000 });

  // The belt, drawn by hand from just off the Source's Out dot to just off the Sink's In dot.
  const board = await readScene(page);
  const out = portOf(board, cells.source, ROLE_OUT)!;
  const into = portOf(board, cells.sink, ROLE_IN)!;
  await page.getByTitle(/^Draw belts/).click();
  const outDot = await screenPoint(page, nubAnchor(out.cell_x, out.cell_y, out.side));
  const inDot = await screenPoint(page, nubAnchor(into.cell_x, into.cell_y, into.side));
  await handDragBetween(page, { x: outDot.x + 3, y: outDot.y - 2 }, { x: inDot.x - 2, y: inDot.y + 3 });
  await page.keyboard.press('Escape');
  // The drag is two sends. The Docks wait for the host to mint the belt, so one Step folds the
  // DrawBelt, the page then sends both Docks from its frame loop, and a second Step folds them.
  const sentWithDraw = await inputsSent(page);
  await stepOnce(page, 'mint the belt');
  await pollScene(page, (s) => s.belts.length, { message: 'the belt was echoed after its one Step' }).toBe(1);
  await expect
    .poll(() => inputsSent(page), {
      message: 'the page sent both Docks once the belt was echoed',
      timeout: frameBudgetMs(DOCKS_SENT_FRAMES),
    })
    .toBe(sentWithDraw + 2);
  await stepOnce(page, 'dock both belt ends');
  await pollScene(page, (s) => s.belts[0]?.docks.map((d) => d.end).sort().join(',') ?? 'no belt', {
    message: 'the belt is docked at both ends after the second Step',
  }).toBe('Head,Tail');

  let tick = (await readScene(page)).tick;
  for (let i = 0; i < PARITY_STEPS; i += 1) {
    tick = await stepOnce(page, `running step ${i + 1} of ${PARITY_STEPS}`);
  }

  const held = await readScene(page);
  expect(held.belts[0].items, 'items ride the belt when the board is saved').toBeGreaterThan(0);
  expect(held.belts[0].headOccupied, 'no item has reached the Sink, so Save does not drain').toBe(false);
  expect(held.tick, 'the board stayed on the tick the last Step reached').toBe(tick);

  await saveTo(page, outPath);
  const printed = readSavedBoard(outPath);
  expect(printed.tick, 'the file holds the tick read before the save, so no drain ran').toBe(tick);
  return printed;
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test('the same gestures on a paused board end on the same tick hash', async ({ page }, testInfo) => {
  // Two sittings of 81 Steps each took 3.9 minutes on two CPUs at a 100% quota.
  test.setTimeout(8 * 60_000);
  const watcher = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  try {
    await pauseBoard(page);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);

    // The row through the middle of the view, with the Source and Sink either side of the middle.
    const cam = await cameraOf(page);
    const viewport = page.viewportSize()!;
    const midX = Math.floor((viewport.width / 2 - cam.x) / cam.scale / CELL);
    const midY = Math.floor((viewport.height / 2 - cam.y) / cam.scale / CELL);
    const cells: BoardCells = { source: [midX - 3, midY], sink: [midX - 3 + SINK_OFFSET, midY] };

    const first = await runBoard(page, cells, testInfo.outputPath('run-1.fab'));
    const second = await runBoard(page, cells, testInfo.outputPath('run-2.fab'));
    console.log(`MEASURE parity run=1 tick=${first.tick} hash=${first.hash.slice(0, 12)} edits=${first.edits.length} steps=${PARITY_STEPS}`);
    console.log(`MEASURE parity run=2 tick=${second.tick} hash=${second.hash.slice(0, 12)} edits=${second.edits.length} steps=${PARITY_STEPS}`);

    expect(second.tick, 'both sittings ended on one tick').toBe(first.tick);
    expect(second.edits, 'both sittings logged the same edits').toEqual(first.edits);
    expect(second.hash, 'both sittings ended on one tick hash').toBe(first.hash);

    // The negative control: one more Step moves both what is printed.
    await stepOnce(page, 'the negative control');
    const controlPath = testInfo.outputPath('run-2-plus-one.fab');
    await saveTo(page, controlPath);
    const third = readSavedBoard(controlPath);
    console.log(`MEASURE parity control tick=${third.tick} hash=${third.hash.slice(0, 12)} edits=${third.edits.length}`);
    expect(third.tick, 'one more Step moved the printed tick by one').toBe(second.tick + 1);
    expect(third.hash, 'one more Step moved the hash').not.toBe(second.hash);

    await expectRenderLoopAlive(page, 'after the paused sittings', { boardHeld: true });
    watcher.assertNone('during the paused sittings');
  } finally {
    if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  }
});
