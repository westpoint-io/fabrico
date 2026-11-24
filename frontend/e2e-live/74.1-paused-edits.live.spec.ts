import { test, expect, type Page } from './support/liveTest';
import {
  DEMO_NODE_COUNT,
  cameraOf,
  expectRenderLoopAlive,
  newBoard,
  pointerTravel,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
  restoreHostAfterFailedTest,
  guardWillAsk,
} from './support/oracle';
import { CELL } from '../shared/geometry';

// 74.1-paused-edits.live.spec.ts (plan 74.1-31, third re-walk) - a paused board is safe
// to click and honest to read, on the real `dev_render_server`.
//
// ---------------------------------------------------------------------------
// WHAT THE WALK FOUND
// ---------------------------------------------------------------------------
//
// PAUSE-TOOLBAR: an edit made while paused put `Paused - edits queued until Play` into
// the toolbar's button row, the centre buttons slid 130 to 180 px, and a click where Play
// had been landed on Undo. On Play the queued Undo deleted the belt just drawn, with no
// message (log seq 11 DrawBelt, seq 12 Undo and Delete).
//
// ---------------------------------------------------------------------------
// THE TESTS
// ---------------------------------------------------------------------------
//
// The first test runs two legs as steps, each on its own page load:
//
//   1. The hand scenario. A belt drawn while playing (so Undo has something to undo, as
//      on the walk), pause from the toolbar, RECORD the Play button's box, draw a second
//      belt with hand-like moves, then click at the recorded Play centre BY POSITION,
//      never by role: the sim resumes, the second belt lands and is still there 1 s later,
//      and no Undo went on the wire or folded.
//   2. Ctrl+Z after a paused draw sends nothing and the toolbar says to press Play; after
//      Play the belt stays, and a Ctrl+Z after it lands removes it.
//
// The Undo counter is installed once, before leg 1's load. It is an init script, so every
// new document starts it at zero and leg 2's load resets it; a second install would wrap
// the socket twice and count each Undo twice.
//
// The second test is leg 4 (plan 74.1-35, review round 5 CR-01): paused, a belt drawn,
// then New: Play leaves the new board empty, and a belt drawn after the swap lands (a drain
// that ate later input would fail the second half). 90-load-survives-undo test 3 walks the
// same leak through Open, and 11-panel-add-remove CR-01 walks a paused port edit.
//
// Pause is HOST-global: every leg resumes in a `finally`. MODEL FIRST, THEN RENDER
// HEALTH: `watchPageErrors` before `goto`, `expectRenderLoopAlive` at the end.
// EVERY POINTER FIXTURE MOVES LIKE A HAND: off-centre presses, sub-cell move samples.

const STEPS_PER_CELL = 8;

/** `STATUS_COPY.editsQueued`, transcribed, not imported. */
const QUEUED_COPY = 'Paused - edits queued until Play';
/** `STATUS_COPY.undoHeld`, transcribed, not imported. */
const HOLD_COPY = 'Paused - press Play before undo or redo';

/** A first belt, drawn while playing, so Undo has a step to take. */
const FIRST_CELLS: readonly (readonly [number, number])[] = [
  [3, 3],
  [4, 3],
  [5, 3],
];
/** The belt drawn while paused: four cells east on empty floor. */
const PAUSED_CELLS: readonly (readonly [number, number])[] = [
  [5, 9],
  [6, 9],
  [7, 9],
  [8, 9],
];
const listOf = (cells: readonly (readonly [number, number])[]): string => cells.map(([x, y]) => `${x},${y}`).join(' ');

/** The toolbar's transport toggle: `Pause` while playing, `Play` while paused. */
function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** The toolbar status readout: the first `header [role="status"]` (Unsaved is the second). */
function statusReadout(page: Page) {
  return page.locator('header [role="status"]').first();
}

/** Press Play if the toolbar offers it, then wait for the tick to advance. */
async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0, { message: 'the sim runs again', timeout: 10_000 }).toBe(true);
}

/** Pause from the toolbar and return the tick the host settled at (two reads 200 ms apart agree). */
async function pauseAndSettle(page: Page, leg: string): Promise<number> {
  await transport(page).click();
  await expect(transport(page), `${leg}: the sim is paused (the toggle offers Play)`).toHaveAttribute('aria-label', 'Play');
  let pausedAt = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === pausedAt;
        pausedAt = t;
        return settled;
      },
      { message: `${leg}: the host stopped ticking`, intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
  return pausedAt;
}

async function emptyBoardAtScale1(page: Page): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

/**
 * Count the Undo and Redo GridCommands the page puts on the render socket. An observer
 * on `WebSocket.prototype.send`, installed before the app boots: it forwards every frame
 * unchanged and only counts binary frames whose BODY's first byte is the Undo (5) or Redo
 * (6) discriminant. Since phase 88 (plan 88-03) a frame starts with a header, the version
 * byte (0xF1, T-88-09) then two varints, the board generation and the gesture id, which the
 * counter skips first. A frame without the version byte is not a gesture and is not counted.
 */
async function installUndoCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __undoSends: number };
    w.__undoSends = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      let bytes: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes !== null) {
        // Skip the header: the version byte (`GESTURE_FRAME_VERSION`, 0xF1, which this
        // init script cannot import), then its two varints (generation, gesture id), then
        // read the body's byte.
        let i = bytes.length > 0 && bytes[0] === 0xf1 ? 1 : bytes.length;
        for (let field = 0; field < 2; field++) {
          while (i < bytes.length && (bytes[i] & 0x80) !== 0) i++;
          i++;
        }
        const first = i < bytes.length ? bytes[i] : -1;
        if (first === 5 || first === 6) w.__undoSends += 1;
      }
      return send.call(this, data as Parameters<WebSocket['send']>[0]);
    };
  });
}

async function undoSends(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __undoSends: number }).__undoSends);
}

/** Every belt in the scene, as its cell list. */
function beltCellLists(scene: SceneFacts): string[] {
  return scene.belts.map((b) => b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' ')).sort();
}

/**
 * Draw a belt like a hand: an off-centre press, sub-cell move samples, a release. `beforeRelease`,
 * when given, runs after the last move and before the button comes up (plan 84-13, leg 6).
 */
async function handDraw(
  page: Page,
  cells: readonly (readonly [number, number])[],
  beforeRelease?: () => Promise<void>,
): Promise<void> {
  const start = await screenPoint(page, { x: (cells[0][0] + 0.45) * CELL, y: (cells[0][1] + 0.55) * CELL });
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await pointerTravel(page, pt.x + 3, pt.y - 2, STEPS_PER_CELL);
  }
  if (beforeRelease) await beforeRelease();
  await page.mouse.up();
}

/** An empty board at scale 1, the Belt tool armed, one belt drawn while playing. */
async function boardWithOneBelt(page: Page): Promise<void> {
  await emptyBoardAtScale1(page);
  await resumeIfPaused(page);
  await page.getByTitle(/^Draw belts/).click();
  await handDraw(page, FIRST_CELLS);
  await pollScene(page, beltCellLists, { message: 'the first belt landed while playing' }).toEqual([listOf(FIRST_CELLS)]);
  await pollScene(page, (s) => s.canUndo, { message: 'Undo has a step to take' }).toBe(true);
}

// THE SHARED HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12): this spec pauses the
// one shared host, and a test that times out while paused never reaches its `finally`.
// `restoreHostAfterFailedTest` puts the host back to running after a failed or timed-out
// test only, logs `HOST RESTORED after <title>`, and never changes that test's verdict.
test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe.configure({ mode: 'serial' });

test.describe('PAUSE-TOOLBAR on the real host: a paused board is safe to click', () => {
  test('1: paused, a click where Play was resumes the sim and the belt drawn while paused stays', async ({ page }) => {
    // One install for both legs: the init script runs on each new document, so leg 2's
    // load starts the count at zero again (a second install would count each Undo twice).
    await installUndoCounter(page);
    await test.step('1: paused, a click where Play was resumes the sim and the belt drawn while paused stays', async () => {
      const errs = watchPageErrors(page);
      await page.goto('/');
      await waitForAppReady(page);
      await boardWithOneBelt(page);
      try {
        const pausedAt = await pauseAndSettle(page, 'leg 1');
        // Where the hand sees Play, recorded BEFORE the edit. The click below is at this
        // position, never at the role.
        const box = await transport(page).boundingBox();
        expect(box, 'leg 1: the Play button has a box').not.toBeNull();
        const playAt = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

        await handDraw(page, PAUSED_CELLS);
        await expect(statusReadout(page), 'leg 1: the walk state: the queued notice is up').toHaveText(QUEUED_COPY);
        expect(beltCellLists(await readScene(page)), 'leg 1: the paused belt is held, not landed').toEqual([listOf(FIRST_CELLS)]);

        // The hand goes back to where Play was and clicks there.
        await pointerTravel(page, playAt.x, playAt.y, 12);
        await page.mouse.down();
        await page.mouse.up();

        await pollScene(page, (s) => s.tick > pausedAt + 10, {
          message: 'leg 1: a click where Play was resumes the sim (the tick runs on)',
          timeout: 5_000,
        }).toBe(true);
        await expect(transport(page), 'leg 1: the toggle offers Pause again').toHaveAttribute('aria-label', 'Pause');
        await pollScene(page, beltCellLists, { message: 'leg 1: the belt drawn while paused landed' }).toEqual(
          [listOf(FIRST_CELLS), listOf(PAUSED_CELLS)].sort(),
        );
        await page.waitForTimeout(1_000);
        const after = await readScene(page);
        expect(beltCellLists(after), 'leg 1: both belts are still there 1 s later').toEqual(
          [listOf(FIRST_CELLS), listOf(PAUSED_CELLS)].sort(),
        );
        expect(after.canRedo, 'leg 1: no Undo folded (nothing to redo)').toBe(false);
        expect(await undoSends(page), 'leg 1: no Undo or Redo went on the wire').toBe(0);
      } finally {
        await page.mouse.up().catch(() => {});
        await resumeIfPaused(page);
      }

      await expectRenderLoopAlive(page, 'after leg 1');
      errs.assertNone('leg 1');
    });

    await test.step(
      '2: paused, Ctrl+Z after a draw sends nothing and says to press Play; after Play the belt stays, and Ctrl+Z then removes it',
      async () => {
        const errs = watchPageErrors(page);
        await page.goto('/');
        await waitForAppReady(page);
        await boardWithOneBelt(page);
        try {
          await pauseAndSettle(page, 'leg 2');
          await handDraw(page, PAUSED_CELLS);
          await expect(statusReadout(page)).toHaveText(QUEUED_COPY);

          await page.keyboard.press('Control+z');
          await expect(statusReadout(page), 'leg 2: the held undo says to press Play').toHaveText(HOLD_COPY);
          await expect(page.locator('header button[aria-label="Undo"]'), 'leg 2: Undo is held').toBeDisabled();
          await page.waitForTimeout(300);
          expect(await undoSends(page), 'leg 2: Ctrl+Z sent nothing while the draw was queued').toBe(0);

          await transport(page).click();
          await expect(transport(page)).toHaveAttribute('aria-label', 'Pause');
          await pollScene(page, beltCellLists, { message: 'leg 2: the belt drawn while paused landed' }).toEqual(
            [listOf(FIRST_CELLS), listOf(PAUSED_CELLS)].sort(),
          );
          await page.waitForTimeout(1_000);
          const after = await readScene(page);
          expect(beltCellLists(after), 'leg 2: after Play the paused belt stays').toEqual(
            [listOf(FIRST_CELLS), listOf(PAUSED_CELLS)].sort(),
          );
          expect(after.canRedo, 'leg 2: no Undo folded').toBe(false);

          await expect(page.locator('header button[aria-label="Undo"]'), 'leg 2: Undo is available again').toBeEnabled();
          await page.keyboard.press('Control+z');
          await pollScene(page, beltCellLists, { message: 'leg 2: Ctrl+Z after it landed removes the paused belt' }).toEqual([
            listOf(FIRST_CELLS),
          ]);
          expect(await undoSends(page), 'leg 2: exactly one Undo went on the wire').toBe(1);
        } finally {
          await resumeIfPaused(page);
        }

        await expectRenderLoopAlive(page, 'after leg 2');
        errs.assertNone('leg 2');
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Plan 74.1-35 (review round 5 CR-01): A BOARD SWAP DISCARDS THE EDITS QUEUED ON THE BOARD
// IT REPLACES. Before it, a belt drawn on a paused board survived New, Open and an example
// load and landed on the NEW board at the next Play.
// ---------------------------------------------------------------------------

/** The belt drawn on the paused board before the swap. */
const SWAP_CELLS: readonly (readonly [number, number])[] = [
  [6, 6],
  [7, 6],
  [8, 6],
  [9, 6],
];
/** The belt drawn on the new board after the swap: different cells, so a stray is told apart. */
const AFTER_SWAP_CELLS: readonly (readonly [number, number])[] = [
  [4, 11],
  [5, 11],
  [6, 11],
];

/** Arm the Belt tool unless it is already armed (a second click would disarm it). */
async function armBelt(page: Page): Promise<void> {
  const belt = page.getByTitle(/^Draw belts/);
  if ((await belt.getAttribute('aria-pressed')) !== 'true') await belt.click();
  await expect(belt, 'the Belt tool is armed').toHaveAttribute('aria-pressed', 'true');
}

/** Press Play from the toolbar and wait until the host has run at least `ticks` ticks. */
async function playFor(page: Page, leg: string, ticks: number): Promise<void> {
  const t0 = (await readScene(page)).tick;
  await transport(page).click();
  await expect(transport(page), `${leg}: the toggle offers Pause again`).toHaveAttribute('aria-label', 'Pause');
  await pollScene(page, (s) => s.tick >= t0 + ticks, {
    message: `${leg}: the host ran ${ticks} ticks after Play`,
    timeout: 10_000,
  }).toBe(true);
}

test.describe('CR-01 on the real host: a board swap discards the edits queued on the board it replaces', () => {
  test('4: paused, a belt drawn, then New: Play leaves the new board empty, and a belt drawn after the swap lands', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    await resumeIfPaused(page);
    try {
      await pauseAndSettle(page, 'leg 4');
      await armBelt(page);
      await handDraw(page, SWAP_CELLS);
      await expect(statusReadout(page), 'leg 4: the paused draw is queued').toHaveText(QUEUED_COPY);
      expect(beltCellLists(await readScene(page)), 'leg 4: nothing landed while paused').toEqual([]);

      // The toolbar New, as a hand presses it, taking the discard guard if it opens.
      const tickBefore = (await readScene(page)).tick;
      const dirty = await guardWillAsk(page);
      await page.getByTitle('New board (Ctrl+N)').click();
      if (dirty) await page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' }).click();
      await pollScene(page, (s) => s.nodes.length === 0 && s.belts.length === 0 && s.tick < tickBefore, {
        message: 'leg 4: the New swap landed (an empty board whose tick restarted)',
      }).toBe(true);
      await expect(transport(page), 'leg 4: New over a user pause stays paused').toHaveAttribute('aria-label', 'Play');

      await playFor(page, 'leg 4', 30);
      await page.waitForTimeout(1_000);
      const after = await readScene(page);
      expect(beltCellLists(after), 'leg 4: Play leaves the new board empty (the old board\'s draw was discarded)').toEqual([]);
      expect(after.nodes.length, 'leg 4: and with no machine').toBe(0);

      // Input sent AFTER the swap is the new board's: it must land.
      await armBelt(page);
      await handDraw(page, AFTER_SWAP_CELLS);
      await pollScene(page, beltCellLists, { message: 'leg 4: a belt drawn after the swap lands' }).toEqual([
        listOf(AFTER_SWAP_CELLS),
      ]);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }

    await expectRenderLoopAlive(page, 'after leg 4');
    errs.assertNone('leg 4');
  });
});

