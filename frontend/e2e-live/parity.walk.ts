import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';
import { machine_kind } from '../src/protocol/kinds';
import { YOUR_FIRST_LINE as LESSON } from '../src/tutorial/lessons/yourFirstLine';
import { frameBudgetMs } from '../e2e/support/frameSampler';
import { portOf, transport } from './support/beltBoard';
import { latchStepRecord, openLessonsFromHelp, readProbe, readRecord, startLesson } from './support/lessonRunner';
import {
  CELL,
  cameraOf,
  expectRenderLoopAlive,
  guardWillAsk,
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
  waitForEditVerdicts,
  waitForFile,
  watchPageErrors,
} from './support/oracle';

// parity.walk.ts - does the tutorial change what the user builds?
//
// A tutorial that watches the user must not change the board. The comparison that says so has to
// be able to tell two boards apart, and it has to hold still: a live board advances on wall-clock
// time, so two sittings land on different ticks. So this runs on a paused board, where nothing moves
// until the Step button says so, and every gesture is followed by a fixed number of Steps: one, or
// two for a belt, whose Docks go out after the belt is echoed. A retry Step would make the tick
// counts differ, so a missing echo is a hard failure.
//
// Each board is saved through the toolbar and read back from the file by the `replay_hash` example,
// which prints the head tick, the tick hash and the edit log.
//
// THE TWO SITTINGS DIFFER ONLY IN HOW THE BOARD STARTS. One presses New, the other starts the lesson
// through the real panel, which asks the host for the same New. The test presses the gestures itself
// and never goes through the hints, because only the hint reads differ between the sittings.
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
/** Drawn frames for a read of the lesson to catch up with the board. */
const LESSON_FRAMES = 20;
/** The gestures the Undo test makes: two machines placed and two Undos. */
const UNDO_TEST_INPUTS = 4;
/** The step index of the lesson's press-play step, which a sitting has to reach before it saves. */
const PRESS_PLAY_INDEX = 4;
/** The strings a saved board could hold if lesson state leaked into it: the lesson's id and the progress key's stem. */
const LESSON_STATE_STRINGS = ['your-first-line', 'fab.tutorial'] as const;
/** What the gestures of one sitting log, in order, as each edit line's op name. */
const USER_GESTURE_OPS = ['Place', 'Place', 'Configure', 'DrawBelt', 'Dock', 'Dock'] as const;

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

/** One sitting: what the file holds, the sends since just before its New, and how far the lesson got. */
interface Sitting extends Printed {
  inputs: number;
  controls: number;
  stepIndex: number;
}

type Mode = 'off' | 'on';

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

/** How many controls the page has handed to the transport. */
async function controlsSent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { controlsSent?(): number } }).__fabrico;
    if (typeof hook?.controlsSent !== 'function') throw new Error('window.__fabrico.controlsSent() not installed');
    return hook.controlsSent();
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

/** Start the lesson through Help and its list, discarding the board if the question comes up. */
async function startLessonFromHelp(page: Page): Promise<void> {
  await waitForEditVerdicts(page);
  const asks = await guardWillAsk(page);
  await openLessonsFromHelp(page);
  // `startLesson` presses Start and waits for the lesson to run, which the question holds up.
  await Promise.all([
    startLesson(page, LESSON),
    asks ? page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' }).click() : Promise.resolve(),
  ]);
}

/**
 * One sitting: a New board on the paused host, from the toolbar or from the lesson's Start, the
 * gestures with one Step each, a fixed number of further Steps, then a save. Answers what
 * `replay_hash` prints from the file, with the sends counted from just before the New.
 */
async function runBoard(page: Page, mode: Mode, cells: BoardCells, outPath: string): Promise<Sitting> {
  const inputsAtStart = await inputsSent(page);
  const controlsAtStart = await controlsSent(page);
  if (mode === 'off') await newBoard(page);
  else await startLessonFromHelp(page);
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

  // A tutorial that never started would match the plain board without proving anything. Reaching the
  // step after the belt takes a bound Source, Sink and belt and an answer from `machine_config`.
  const probe = await readProbe(page);
  if (mode === 'on') {
    expect(probe.card, 'the lesson is still on screen when the board is saved').toBe('running');
    expect(probe.stepIndex, `the lesson reached press-play or later (at ${probe.stepId ?? 'no step'})`).toBeGreaterThanOrEqual(PRESS_PLAY_INDEX);
    expect(probe.bound.belt, 'the lesson bound the belt on the board').toBe(held.belts[0].id);
    // Each one looked up, rather than the whole list compared: a machine the tutorial added has to
    // reach the compare of the edit lines and the hash, which is the check that speaks to it.
    expect(held.nodes.find((n) => n.id === probe.bound.source)?.kind, 'the lesson bound the Source on the board').toBe(machine_kind.SOURCE);
    expect(held.nodes.find((n) => n.id === probe.bound.sink)?.kind, 'the lesson bound the Sink on the board').toBe(machine_kind.SINK);
  } else {
    expect(probe.card, 'no lesson is on screen in the plain sitting').toBe('none');
  }

  await saveTo(page, outPath);
  const printed = readSavedBoard(outPath);
  expect(printed.tick, 'the file holds the tick read before the save, so no drain ran').toBe(tick);
  return {
    ...printed,
    inputs: (await inputsSent(page)) - inputsAtStart,
    controls: (await controlsSent(page)) - controlsAtStart,
    stepIndex: probe.stepIndex,
  };
}

/** The app on a paused, empty board at actual size, and two free cells either side of the middle of the view. */
async function pausedBoardCells(page: Page): Promise<BoardCells> {
  await page.goto('/');
  await waitForAppReady(page);
  await pauseBoard(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  return middleCells(page);
}

/** The row through the middle of the view, with the Source and Sink either side of the middle. */
async function middleCells(page: Page): Promise<BoardCells> {
  const cam = await cameraOf(page);
  const viewport = page.viewportSize()!;
  const midX = Math.floor((viewport.width / 2 - cam.x) / cam.scale / CELL);
  const midY = Math.floor((viewport.height / 2 - cam.y) / cam.scale / CELL);
  return { source: [midX - 3, midY], sink: [midX - 3 + SINK_OFFSET, midY] };
}

/** Leave the shared host playing, for whichever test comes next. */
async function pressPlayIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
}

/** A sitting's line in the run's output, read into the evidence file. */
function measure(sitting: Sitting): string {
  return `MEASURE parity-on-off tick=${sitting.tick} hash=${sitting.hash.slice(0, 12)} edits=${sitting.edits.length} inputs=${sitting.inputs} controls=${sitting.controls} stepIndex=${sitting.stepIndex}`;
}

/** An edit line is `edit <sequence> <tick> <action> <op, Debug form>`. The op's name starts the Debug form. */
function opNameOf(editLine: string): string {
  const op = editLine.split(' ')[4] ?? '';
  return /^[A-Za-z]+/.exec(op)?.[0] ?? `unreadable: ${editLine}`;
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test('the same gestures with the tutorial on and off end on the same tick hash', async ({ page }, testInfo) => {
  // Two sittings of 81 Steps each took 3.9 minutes on two CPUs at a 100% quota.
  test.setTimeout(8 * 60_000);
  const watcher = watchPageErrors(page);
  try {
    const cells = await pausedBoardCells(page);

    const off = await runBoard(page, 'off', cells, testInfo.outputPath('tutorial-off.fab'));
    const on = await runBoard(page, 'on', cells, testInfo.outputPath('tutorial-on.fab'));
    console.log(measure(off));
    console.log(measure(on));

    expect(on.tick, 'both sittings ended on one tick').toBe(off.tick);
    expect(on.edits, 'both sittings logged the same edits').toEqual(off.edits);
    expect(on.hash, 'both sittings ended on one tick hash').toBe(off.hash);
    expect(on.inputs, 'both sittings handed the host the same number of gestures').toBe(off.inputs);
    expect(on.controls, 'both sittings handed the host the same number of controls').toBe(off.controls);

    // The negative control, on the tutorial's board: one more Step moves both what is printed.
    await stepOnce(page, 'the negative control');
    const controlPath = testInfo.outputPath('tutorial-on-plus-one.fab');
    await saveTo(page, controlPath);
    const third = readSavedBoard(controlPath);
    console.log(`MEASURE parity control tick=${third.tick} hash=${third.hash.slice(0, 12)} edits=${third.edits.length}`);
    expect(third.tick, 'one more Step moved the printed tick by one').toBe(on.tick + 1);
    expect(third.hash, 'one more Step moved the hash').not.toBe(on.hash);

    await expectRenderLoopAlive(page, 'after the paused sittings', { boardHeld: true });
    watcher.assertNone('during the paused sittings');
  } finally {
    await pressPlayIfPaused(page);
  }
});

test('a board saved mid-lesson holds no lesson state', async ({ page }, testInfo) => {
  // One sitting of 81 Steps took about 2 minutes on two CPUs at a 100% quota.
  test.setTimeout(5 * 60_000);
  const watcher = watchPageErrors(page);
  try {
    const cells = await pausedBoardCells(page);
    // Its own path: Playwright starts a new worker after a failed test, so a path kept from the test
    // above wouldn't survive into this one.
    const path = testInfo.outputPath('saved-mid-lesson.fab');
    const saved = await runBoard(page, 'on', cells, path);

    // A hash can't speak to bytes outside the core, so this reads them. The file is plain postcard
    // with no compression, so a string in it can be found as its UTF-8 bytes. Collected first, so
    // one hit can't hide the other.
    const bytes = readFileSync(path);
    expect(bytes.length, 'the saved file holds something to search').toBeGreaterThan(0);
    const found = LESSON_STATE_STRINGS.filter((s) => bytes.includes(Buffer.from(s, 'utf8')));
    expect(found, 'lesson state found in the bytes of the saved board').toEqual([]);

    expect(saved.edits.map(opNameOf), "the edit log holds the user's gestures and nothing else").toEqual([...USER_GESTURE_OPS]);

    await expectRenderLoopAlive(page, 'after the save', { boardHeld: true });
    watcher.assertNone('during the paused sitting');
  } finally {
    await pressPlayIfPaused(page);
  }
});

test("Undo takes back only the user's own gestures", async ({ page }) => {
  const watcher = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await expect(transport(page), 'this test runs on a playing board').toHaveAttribute('aria-label', 'Pause');

  await startLessonFromHelp(page);
  await pollScene(page, (s) => s.canUndo, { message: 'a new board has nothing to undo' }).toBe(false);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  const cells = await middleCells(page);

  await latchStepRecord(page);
  const inputsAtStart = await inputsSent(page);

  await handPlaceAt(page, 'Source', cells.source[0], cells.source[1]);
  await pollScene(page, (s) => s.nodes.length, { message: 'the Source landed' }).toBe(1);
  await handPlaceAt(page, 'Sink', cells.sink[0], cells.sink[1]);
  await page.keyboard.press('Escape');
  await pollScene(page, (s) => s.nodes.length, { message: 'the Sink landed' }).toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => (await readProbe(page)).stepId, {
      message: 'the two machines took the lesson to the Timer step',
      timeout: frameBudgetMs(LESSON_FRAMES),
    })
    .toBe('set-timer');

  for (const press of ['first', 'second'] as const) {
    const before = (await readScene(page)).nodes.length;
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => s.nodes.length, { message: `the ${press} Undo took one machine away` }).toBe(before - 1);
  }

  // Read as one value, so a machine the tutorial placed shows the board, the button and the count at once.
  await expect
    .poll(
      async () => {
        const scene = await readScene(page);
        return { machines: scene.nodes.length, canUndo: scene.canUndo, inputs: (await inputsSent(page)) - inputsAtStart };
      },
      { message: "two Undos emptied the board, and every gesture sent was the user's own" },
    )
    .toEqual({ machines: 0, canUndo: false, inputs: UNDO_TEST_INPUTS });

  await expect
    .poll(
      async () => {
        const probe = await readProbe(page);
        return `${probe.card}:${probe.stepId ?? 'no step'}`;
      },
      { message: 'the lesson went back to its first step', timeout: frameBudgetMs(LESSON_FRAMES) },
    )
    .toBe('running:place-source');
  const record = await readRecord(page);
  expect(
    record.filter((e) => e.card !== 'running').map((e) => e.card),
    'the lesson read running throughout',
  ).toEqual([]);
  expect(
    record.map((e) => e.stepIndex).filter((index, i, all) => index !== all[i - 1]),
    'the lesson went forward with the two machines and back with the two Undos',
  ).toEqual([0, 1, 2, 1, 0]);

  await expectRenderLoopAlive(page, 'after the Undos');
  watcher.assertNone('during the Undos');
});
