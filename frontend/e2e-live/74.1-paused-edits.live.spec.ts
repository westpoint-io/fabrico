import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_NODE_COUNT,
  applyConfig,
  armAndPlaceAt,
  cameraOf,
  clickAt,
  deselectViaEmptyCell,
  drawOffloadBelt,
  expectRenderLoopAlive,
  fillPanelField,
  loadExample,
  newBoard,
  openExamples,
  pointerTravel,
  pollScene,
  pressSegment,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
  restoreHostAfterFailedTest,
  guardWillAsk,
} from './support/oracle';
import { CELL } from '../shared/geometry';
import { startFrameSampler, waitForFramesAtFloor } from '../e2e/support/frameSampler';

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
// PAUSED-READOUT: while paused, a pending port edit showed "The host has not applied this
// yet." with [Try again] after about 0.7 s, as if it had failed; after a Step it showed
// the paused wording instead.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. The hand scenario. A belt drawn while playing (so Undo has something to undo, as
//      on the walk), pause from the toolbar, RECORD the Play button's box, draw a second
//      belt with hand-like moves, then click at the recorded Play centre BY POSITION,
//      never by role: the sim resumes, the second belt lands and is still there 1 s later,
//      and no Undo went on the wire or folded.
//   2. Ctrl+Z after a paused draw sends nothing and the toolbar says to press Play; after
//      Play the belt stays, and a Ctrl+Z after it lands removes it.
//   3. `+ Add output` on the demo Factory pressed straight after Pause, as a hand does,
//      while the host is still draining: sampled every frame for 3 s, the Ports status
//      reads the paused wording and never the stalled line.
//   4. Plan 74.1-35 (review round 5 CR-01): paused, a belt drawn, then New: Play leaves
//      the new board empty, and a belt drawn after the swap lands (a drain that ate later
//      input would fail the second half).
//   5. Plan 74.1-35: paused, a machine deleted, then Open of the saved file: Play leaves
//      the file's board whole.
//   6. Plan 74.1-35: an example picked while the pause still drains: Undo stays disabled
//      on every frame until the example board arrives, and Play adds no belt to it.
//      Plan 84-11: the belt drawn while playing is fed by a palette Source and its head is
//      free, so items wait on it and the pause drains for the host's whole settle budget.
//   7. Plan 74.1-35 (review round 5 WR-02): paused, two belts dragged onto one belt end:
//      Play joins the first and refuses the second in words.
//
// THE WINDOWS WAIT FOR THEIR FRAMES (plan 84-09, GATE-01). The 2026-10-09 CI run (a 2-vCPU
// GitHub runner drawing the board through software GL at about 12 frames a second) failed
// leg 3 on `the paused wording showed and the sampler ran on`: `afterFirst` 34 where above
// 100 was needed, in a window fixed at 3 s; two cores here read 84. Leg 3's Resume window
// (1 s, above 30 frames) has the same shape. Each window now keeps its stated time as a
// minimum ("for 3 s" from the first frame the paused wording shows; 1 s from the Play
// click) AND runs on until the frame count its old floor meant is in, through
// `frameSampler.ts`, so a slow machine samples longer, never less, and the wording is
// still graded on every frame observed. A window whose frames never come, or that never
// opens, is a named failure at the helper's cap.
//
// LEG 6'S DRAIN IS THE HOST'S WHOLE SETTLE BUDGET (plan 84-11). The pause drains until no belt
// holds an item and no effect is in flight, or for `MAX_SETTLE_TICKS` (512, `sim_loop.rs`),
// whichever comes first. On the demo that measured about 120 ticks (pause at 92, the swap the
// drain releases at 212 unthrottled; 106 and 227 pinned to two cores), and leg 6's hand-like
// draw alone took 5.3 s at half a CPU, where the sim ran about 23 ticks a second: the drain ended
// before the draw was released, so the leg's own checks that the pick lands mid-drain failed (two
// of two runs, plans 84-10 and 84-11). Nothing a hand does can lengthen a drain the host bounds in
// ticks, so the setup now gives the pause a drain whose length is known: the belt drawn while
// playing runs from a palette Source on a Timer to a free head, the items wait at that head, and
// a belt holding items never settles, so the drain runs the full 512 ticks at any machine speed.
//
// Pause is HOST-global: every leg resumes in a `finally`. MODEL FIRST, THEN RENDER
// HEALTH: `watchPageErrors` before `goto`, `expectRenderLoopAlive` at the end.
// EVERY POINTER FIXTURE MOVES LIKE A HAND: off-centre presses, sub-cell move samples.

const FACTORY_KIND = 2;
const STEPS_PER_CELL = 8;

/**
 * Leg 6's sampler runs on past the example board's arrival for this many drawn frames (plan
 * 84-18, D-12): its old 1 s, at `FLOOR_FPS` (3.5 frames a second) rounded up. Nothing is graded
 * on them; the run-on is counted in frames so the in-page loop keeps no wall-clock cap.
 */
const SWAP_TAIL_FRAMES = 4;

/** `STATUS_COPY.editsQueued`, transcribed, not imported. */
const QUEUED_COPY = 'Paused - edits queued until Play';
/** `STATUS_COPY.undoHeld`, transcribed, not imported. */
const HOLD_COPY = 'Paused - press Play before undo or redo';
/** `PORT_EDIT_PENDING_PAUSED`, transcribed, not imported. */
const PAUSED_COPY = 'The sim is paused - this change applies when you resume.';
/** `PORT_EDIT_STALLED`, transcribed, not imported. */
const STALLED_COPY = 'The host has not applied this yet.';

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
    const errs = watchPageErrors(page);
    await installUndoCounter(page);
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

  test('2: paused, Ctrl+Z after a draw sends nothing and says to press Play; after Play the belt stays, and Ctrl+Z then removes it', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await installUndoCounter(page);
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
  });
});

/** What the leg-3 sampler recorded. */
interface ReadoutSample {
  frames: number;
  /** Frames after the paused wording first showed. */
  afterFirst: number;
  paused: number;
  stalled: number;
  other: number;
  otherSeen: string;
  firstStalledMs: number;
  tickAtStart: number;
  tickAtEnd: number;
  tickAtFirstStalled: number;
}

test.describe('PAUSED-READOUT on the real host: a paused port edit says it waits', () => {
  test('3: paused, + Add output on the demo Factory reads the paused wording for 3 s and never the stalled line', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await resumeIfPaused(page);
    const factory = (await readScene(page)).nodes.filter((n) => n.kind === FACTORY_KIND);
    expect(factory, 'the demo carries one Factory').toHaveLength(1);
    const outs0 = factory[0].ports.filter((p) => p.role === 1).length;
    await selectMachineAt(page, 4, 2);
    const add = page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: '+ Add output' });
    try {
      // Pause and press at once, as the walkers did: the host is still draining.
      await transport(page).click();
      await expect(transport(page)).toHaveAttribute('aria-label', 'Play');
      // The window opens on the first frame the paused wording shows and runs for its
      // stated 3 s AND the 101 frames the old floor (above 100) meant, whichever comes
      // later. Frames before it are still read: a stalled line there counts too.
      const tickAtStart = (await readScene(page)).tick;
      await startFrameSampler(
        page,
        '__readout',
        { minMs: 3_000, frames: 101 },
        {
          seen: 0,
          startedAt: -1,
          frames: 0,
          afterFirst: 0,
          paused: 0,
          stalled: 0,
          other: 0,
          otherSeen: '',
          firstStalledMs: -1,
          tickAtFirstStalled: -1,
        },
        (t, a) => {
          const hook = (window as unknown as { __fabrico: { scene(): { tick: number } } }).__fabrico;
          if (t.startedAt < 0) t.startedAt = performance.now();
          const sec = document.querySelector('section[aria-label="Ports"]');
          const text = Array.from(sec?.querySelectorAll('[role="status"]') ?? [])
            .map((el) => el.textContent ?? '')
            .join('|');
          t.frames++;
          if (text === a.pausedCopy) t.seen = 1;
          if (t.seen === 0) {
            if (text.includes(a.stalledCopy)) t.stalled++;
            return false;
          }
          t.afterFirst++;
          if (text === a.pausedCopy) t.paused++;
          else if (text.includes(a.stalledCopy)) {
            t.stalled++;
            if (t.firstStalledMs < 0) {
              t.firstStalledMs = Math.round(performance.now() - t.startedAt);
              t.tickAtFirstStalled = hook.scene().tick;
            }
          } else {
            t.other++;
            t.otherSeen = text;
          }
          return true;
        },
        { pausedCopy: PAUSED_COPY, stalledCopy: STALLED_COPY },
      );
      await add.click();
      // The midday 2026-10-13 CI run read 85 of these 101 frames at about 5.8 frames a second before the
      // mock suite's fifteen second cap; under D-12 the 101 frames, the 3 s and every per-frame
      // property stand, and the cap is derived at the `FLOOR_FPS` floor from the window's own numbers.
      const rw = await waitForFramesAtFloor<Omit<ReadoutSample, 'tickAtStart' | 'tickAtEnd'>>(page, '__readout');
      const r: ReadoutSample = { ...rw.tallies, tickAtStart, tickAtEnd: (await readScene(page)).tick };
      console.log(`PAUSED-READOUT leg 3: ${JSON.stringify(r)}`);
      expect(r.afterFirst, `leg 3: the paused wording showed and the sampler ran on (${JSON.stringify(r)})`).toBeGreaterThan(100);
      expect(r.stalled, `leg 3: the stalled line never shows while paused (${JSON.stringify(r)})`).toBe(0);
      expect(r.other, `leg 3: nothing but the paused wording shows (saw "${r.otherSeen}")`).toBe(0);
      expect(r.paused, 'leg 3: the paused wording held for the whole window').toBe(r.afterFirst);
      expect(
        outs0,
        'leg 3: the add is held by the paused host',
      ).toBe((await readScene(page)).nodes.filter((n) => n.kind === FACTORY_KIND)[0].ports.filter((p) => p.role === 1).length);
      // Resume: the drained ticks must not count against the edit after Resume either
      // (`resumePortEdit` restarts the count), so no frame from the Play click until the
      // add folds shows the stalled line.
      // The Resume window: its stated 1 s AND the 31 frames the old floor (above 30) meant,
      // whichever comes later.
      await startFrameSampler(
        page,
        '__afterResume',
        { minMs: 1_000, frames: 31 },
        { stalled: 0 },
        (t, a) => {
          const sec = document.querySelector('section[aria-label="Ports"]');
          const text = Array.from(sec?.querySelectorAll('[role="status"]') ?? [])
            .map((el) => el.textContent ?? '')
            .join('|');
          if (text.includes(a.stalledCopy)) t.stalled++;
        },
        { stalledCopy: STALLED_COPY },
      );
      await transport(page).click();
      await expect(transport(page)).toHaveAttribute('aria-label', 'Pause');
      const aw = await waitForFramesAtFloor<{ stalled: number }>(page, '__afterResume');
      const after = { frames: aw.frames, stalled: aw.tallies.stalled, elapsedMs: aw.elapsedMs };
      console.log(`PAUSED-READOUT leg 3 after Resume: ${JSON.stringify(after)}`);
      expect(after.frames, 'leg 3: the resume sampler ran').toBeGreaterThan(30);
      expect(after.stalled, 'leg 3: no frame after Resume shows the stalled line').toBe(0);
    } finally {
      await resumeIfPaused(page);
    }
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === FACTORY_KIND)[0].ports.filter((p) => p.role === 1).length, {
      message: 'leg 3: the resumed host folded the held add',
    }).toBe(outs0 + 1);

    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
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

/** `STATUS_COPY.loaded`, transcribed, not imported. */
const LOADED_COPY = 'Loaded';
/** `REFUSAL_COPY.BeltEndTaken`, transcribed, not imported. */
const BELT_END_TAKEN_COPY = 'That belt end is already joined. Use a free end.';
/** The order-processing example's node count (`loadExample`'s default). */
const ORDER_NODES = 6;

/** Leg 6's palette Source, on the demo's empty floor just west of the belt it feeds (plan 84-11). */
const BACKLOG_SOURCE: readonly [number, number] = [5, 11];
/** Its Timer interval in ticks: fast enough to fill the belt's free head in well under a second. */
const BACKLOG_INTERVAL = '4';
/** `fabrico_core` `SLOTS_PER_TILE`. */
const SLOTS_PER_TILE = 4;
const SOURCE_KIND = 0;
const MEDIUM_MECHANICAL = 0;
/** A demo cell nothing is drawn on, clicked to drop the Source's selection. */
const LEG6_EMPTY_CELL: readonly [number, number] = [11, 11];

/** Leg 6's belt drawn while playing on the demo board, below the scene. */
const DEMO_PLAYING_CELLS: readonly (readonly [number, number])[] = [
  [6, 11],
  [7, 11],
  [8, 11],
];
/**
 * Leg 6's belt drawn on the draining demo board: free on the demo AND on the example, and
 * on screen at the demo's fit camera (row 13 measured below the 720 px viewport).
 */
const DRAIN_CELLS: readonly (readonly [number, number])[] = [
  [2, 10],
  [3, 10],
  [4, 10],
  [5, 10],
];

/** Leg 7's board, the review's: A (1,5)-(3,5) east; D and E start beside A's end. */
const A_CELLS: readonly (readonly [number, number])[] = [
  [1, 5],
  [2, 5],
  [3, 5],
];
const D_CELLS: readonly (readonly [number, number])[] = [
  [3, 4],
  [3, 3],
  [3, 2],
];
const E_CELLS: readonly (readonly [number, number])[] = [
  [3, 6],
  [3, 7],
  [3, 8],
];

/** The belt with a tile on `cell`, or undefined. */
function beltOn(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/** The SCREEN point at fraction (fx, fy) of cell (cx, cy). */
async function cellPoint(page: Page, cell: readonly [number, number], frac: readonly [number, number]) {
  return screenPoint(page, { x: (cell[0] + frac[0]) * CELL, y: (cell[1] + frac[1]) * CELL });
}

/**
 * Select the belt under `select` (its middle tile), then press off-centre inside its end
 * tile `press` and walk in sub-cell steps to an off-centre point inside `drop`.
 */
async function dragBeltEnd(
  page: Page,
  select: readonly [number, number],
  press: readonly [number, number],
  drop: readonly [number, number],
  what: string,
): Promise<void> {
  const mid = await cellPoint(page, select, [0.5, 0.5]);
  await clickAt(page, mid.x, mid.y);
  await expect(page.locator('#fab-belt-config'), `${what}: the dragged belt is selected`).toBeVisible({ timeout: 15_000 });
  const a = await cellPoint(page, press, [0.7, 0.7]);
  const b = await cellPoint(page, drop, [0.4, 0.6]);
  await pointerTravel(page, a.x, a.y);
  await page.mouse.down();
  await pointerTravel(page, b.x, b.y, STEPS_PER_CELL);
  await page.mouse.up();
}

test.describe('CR-01 and WR-02 on the real host: the other swap paths, and two joins onto one end', () => {
  test('5: paused, a machine deleted, then Open of the saved file: Play leaves the file\'s board whole', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    const fab = join(tmpdir(), `fabrico-e2e-paused-open-${Date.now()}.fab`);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    await resumeIfPaused(page);
    try {
      // Two machines and a belt, placed while playing.
      await armAndPlaceAt(page, 'Sink', 4, 4);
      await armAndPlaceAt(page, 'Sink', 8, 4);
      await pollScene(page, (s) => s.nodes.length, { message: 'leg 5: both machines landed' }).toBe(2);
      await armBelt(page);
      await handDraw(page, FIRST_CELLS.map(([x, y]) => [x, y + 6] as const));
      await pollScene(page, (s) => s.belts.length, { message: 'leg 5: the belt landed' }).toBe(1);
      await page.keyboard.press('Escape');

      page.once('dialog', (d) => d.accept(fab));
      await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
      await expect
        .poll(() => existsSync(fab), { timeout: 45_000, intervals: [200, 500, 1000], message: 'leg 5: the .fab was written' })
        .toBe(true);
      const saved = await readScene(page);
      const savedNodes = saved.nodes.length;
      const savedBelts = saved.belts.length;
      expect([savedNodes, savedBelts], 'leg 5: MEASURED, the saved board').toEqual([2, 1]);

      await resumeIfPaused(page);
      await pauseAndSettle(page, 'leg 5');
      await selectMachineAt(page, 4, 4);
      await page.keyboard.press('Delete');
      await expect(statusReadout(page), 'leg 5: the paused Delete went on the wire and is queued').toHaveText(QUEUED_COPY);
      expect((await readScene(page)).nodes.length, 'leg 5: nothing folded while paused').toBe(savedNodes);

      // Open the same file through the toolbar prompt, taking the guard if it opens.
      const tickBefore = (await readScene(page)).tick;
      const dirty = await guardWillAsk(page);
      page.once('dialog', (d) => d.accept(fab));
      await page.getByTitle('Load a saved factory').click();
      if (dirty) await page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' }).click();
      await expect(statusReadout(page), 'leg 5: the Open landed').toHaveText(LOADED_COPY, { timeout: 20_000 });
      await pollScene(page, (s) => s.tick <= tickBefore && s.nodes.length === savedNodes, {
        message: 'leg 5: the opened file is on screen',
      }).toBe(true);

      await resumeIfPaused(page);
      await pollScene(page, (s) => s.tick > 30, { message: 'leg 5: the opened board runs', timeout: 10_000 }).toBe(true);
      await page.waitForTimeout(1_000);
      const after = await readScene(page);
      expect(after.nodes.length, 'leg 5: Play leaves every machine of the opened file (the old board\'s Delete was discarded)').toBe(
        savedNodes,
      );
      expect(after.belts.length, 'leg 5: and its belt').toBe(savedBelts);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }

    await expectRenderLoopAlive(page, 'after leg 5');
    errs.assertNone('leg 5');
  });

  test('6: an example picked while the pause still drains: Undo stays disabled until the example board arrives, and Play adds no belt to it', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    // The example's counts, measured, never typed.
    await loadExample(page, 'order_processing', ORDER_NODES);
    const example = await readScene(page);
    const exampleNodes = example.nodes.length;
    const exampleBelts = example.belts.length;
    await resetToDemo(page, DEMO_NODE_COUNT);
    await resumeIfPaused(page);
    try {
      // A palette Source on a Timer, then one belt off it while playing, so Undo is enabled
      // unless the hold masks it, and items wait at the belt's free head (plan 84-11): a board
      // holding them never settles, so the pause below drains for the host's whole budget.
      await armAndPlaceAt(page, 'Source', BACKLOG_SOURCE[0], BACKLOG_SOURCE[1]);
      const sourceAt = (s: SceneFacts) =>
        s.nodes.find(
          (n) => n.kind === SOURCE_KIND && n.cells.some(([x, y]) => x === BACKLOG_SOURCE[0] && y === BACKLOG_SOURCE[1]),
        );
      await pollScene(page, (s) => sourceAt(s) !== undefined, {
        message: 'leg 6: the palette Source landed on the demo floor',
      }).toBe(true);
      const backlogOut = sourceAt(await readScene(page))!.ports.find(
        (p) => p.role === 1 && p.medium === MEDIUM_MECHANICAL,
      ) as PortFacts;
      await selectMachineAt(page, BACKLOG_SOURCE[0], BACKLOG_SOURCE[1]);
      await pressSegment(page, 'Trigger', 'Timer');
      await fillPanelField(page, 'fab-timer-interval', BACKLOG_INTERVAL);
      await applyConfig(page);
      await deselectViaEmptyCell(page, LEG6_EMPTY_CELL[0], LEG6_EMPTY_CELL[1]);
      await drawOffloadBelt(page, backlogOut, DEMO_PLAYING_CELLS);
      await pollScene(page, (s) => (beltOn(s, DEMO_PLAYING_CELLS[0])?.occupiedSlots ?? []).length >= SLOTS_PER_TILE, {
        message: 'leg 6: the belt drawn while playing landed and items wait at its free head',
      }).toBe(true);
      // `drawOffloadBelt` ends on Escape, which disarms the Belt tool; the paused draw needs it.
      await armBelt(page);
      await expect(page.locator('header button[aria-label="Undo"]'), 'leg 6: Undo has a step to take').toBeEnabled();

      // Draw and pause at once: the busy demo is still draining at the release. The hand walks
      // the belt while the demo plays and Pause lands (Space on the focused transport, one
      // toggle: the canvas shortcut stands down while a button holds focus) just before the
      // button comes up, so the release is a paused draw on a host that has just begun its
      // drain. PLAN 84-13 (D-12): the hand used to press Pause first and then walk 24 moves; at
      // the GPU proxy's 4 to 5 frames a second that walk outlasted the host's whole drain budget
      // (`MAX_SETTLE_TICKS` 512, about 8.5 s, `sim_loop.rs`), and the precondition below went
      // red (`Expected: > 1004 Received: 1004`). The cells, the 8 steps a cell and every
      // assertion are unchanged; only where the Pause falls in the gesture moved.
      await transport(page).focus();
      await handDraw(page, DRAIN_CELLS, async () => {
        await page.keyboard.press('Space');
        await expect(transport(page), 'leg 6: Pause landed before the release').toHaveAttribute('aria-label', 'Play');
      });
      const atRelease = (await readScene(page)).tick;
      await page.waitForTimeout(100);
      expect((await readScene(page)).tick, 'leg 6: the tick still advances at release (the pause drains)').toBeGreaterThan(atRelease);
      await expect(statusReadout(page), 'leg 6: the draw went on the wire and is queued').toHaveText(QUEUED_COPY);
      await expect(page.locator('header button[aria-label="Undo"]'), 'leg 6: Undo is held behind it').toBeDisabled();

      // Sample every animation frame from the pick until the example board is on screen
      // plus `SWAP_TAIL_FRAMES` drawn frames (1 s at the floor): whether Undo is enabled, and
      // whether the example board has arrived.
      const tickBefore = (await readScene(page)).tick;
      await page.evaluate(
        ({ before, nodes, tailFrames }) => {
          const w = window as unknown as {
            __fabrico: { scene(): { tick: number; nodes: unknown[] } };
            __swapFrames: { frames: number; enabledBefore: number; arrivedAt: number; done: boolean };
          };
          const rec = { frames: 0, enabledBefore: 0, arrivedAt: -1, done: false };
          w.__swapFrames = rec;
          const step = (): void => {
            const s = w.__fabrico.scene();
            const undo = document.querySelector('header button[aria-label="Undo"]') as HTMLButtonElement | null;
            rec.frames++;
            if (rec.arrivedAt < 0 && s.tick < before && s.nodes.length === nodes) {
              rec.arrivedAt = rec.frames;
            }
            if (rec.arrivedAt < 0 && undo !== null && !undo.disabled) rec.enabledBefore++;
            if (rec.arrivedAt >= 0 && rec.frames - rec.arrivedAt >= tailFrames) {
              rec.done = true;
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        },
        { before: tickBefore, nodes: exampleNodes, tailFrames: SWAP_TAIL_FRAMES },
      );
      const dirty = await guardWillAsk(page);
      await openExamples(page);
      await page.getByRole('button', { name: 'Load order processing' }).click();
      if (dirty) await page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' }).click();
      const atPick = (await readScene(page)).tick;
      await page.waitForTimeout(100);
      const afterPick = await readScene(page);
      expect(
        afterPick.tick > atPick || afterPick.tick < tickBefore,
        'leg 6: the pick landed while the pause still drained (the tick advanced, or the swap already fired)',
      ).toBe(true);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __swapFrames: { done: boolean } }).__swapFrames.done), {
          timeout: 20_000,
          message: 'leg 6: the example board arrived and the sampler ran on 1 s',
        })
        .toBe(true);
      const rec = await page.evaluate(
        () => (window as unknown as { __swapFrames: { frames: number; enabledBefore: number; arrivedAt: number } }).__swapFrames,
      );
      console.log(`SWAP-HOLD leg 6: ${JSON.stringify(rec)}`);
      expect(rec.arrivedAt, 'leg 6: frames were sampled before the example board arrived').toBeGreaterThan(1);
      expect(rec.enabledBefore, 'leg 6: Undo was disabled on every frame before the example board arrived').toBe(0);
      await expect(transport(page), 'leg 6: the example over a user pause stays paused').toHaveAttribute('aria-label', 'Play');

      await playFor(page, 'leg 6', 30);
      await page.waitForTimeout(1_000);
      const after = await readScene(page);
      expect(after.nodes.length, 'leg 6: the example\'s node count').toBe(exampleNodes);
      expect(after.belts.length, 'leg 6: the example\'s belt count (no belt from the old board)').toBe(exampleBelts);
      expect(
        DRAIN_CELLS.some((c) => beltOn(after, c) !== undefined),
        'leg 6: no belt holds the cells drawn on the draining demo',
      ).toBe(false);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }

    await expectRenderLoopAlive(page, 'after leg 6');
    errs.assertNone('leg 6');
  });

  test('7: paused, two belts dragged onto one belt end: Play joins the first and refuses the second in words', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    await resumeIfPaused(page);
    try {
      await armBelt(page);
      for (const [i, cells] of [A_CELLS, D_CELLS, E_CELLS].entries()) {
        await handDraw(page, cells);
        await pollScene(page, (s) => s.belts.length, { message: `leg 7: belt ${i + 1} was drawn` }).toBe(i + 1);
      }
      await page.keyboard.press('Escape');
      const built = await readScene(page);
      expect(built.belts.flatMap((b) => b.docks), 'leg 7: MEASURED, all three belts start undocked').toEqual([]);
      const a = beltOn(built, A_CELLS[0])!;
      const d = beltOn(built, D_CELLS[0])!;
      const e = beltOn(built, E_CELLS[0])!;

      await pauseAndSettle(page, 'leg 7');
      await dragBeltEnd(page, D_CELLS[1], D_CELLS[0], A_CELLS[2], 'leg 7, D');
      await expect(statusReadout(page), 'leg 7: D\'s join went on the wire and is queued').toHaveText(QUEUED_COPY);
      await page.keyboard.press('Escape');
      await dragBeltEnd(page, E_CELLS[1], E_CELLS[0], A_CELLS[2], 'leg 7, E');
      await page.keyboard.press('Escape');
      expect(
        (await readScene(page)).belts.flatMap((b) => b.docks),
        'leg 7: nothing joined while paused',
      ).toEqual([]);

      await transport(page).click();
      await expect(transport(page)).toHaveAttribute('aria-label', 'Pause');
      await expect(page.locator('#fab-refusal'), 'leg 7: the second join is refused in words').toHaveText(BELT_END_TAKEN_COPY, {
        timeout: 15_000,
      });
      await pollScene(page, (s) => beltOn(s, A_CELLS[0])?.docks.length ?? 0, { message: 'leg 7: A\'s end joined' }).toBe(1);
      const after = await readScene(page);
      expect(beltOn(after, A_CELLS[0])?.docks, 'leg 7: A\'s end is joined to D only').toEqual([
        expect.objectContaining({ end: 'Head', node: d.id }),
      ]);
      expect(beltOn(after, E_CELLS[0])?.docks, 'leg 7: E\'s start is free').toEqual([]);
      expect(a.id, 'leg 7: A kept its id').toBe(beltOn(after, A_CELLS[0])?.id);
      expect(e.id).toBe(beltOn(after, E_CELLS[0])?.id);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }

    await expectRenderLoopAlive(page, 'after leg 7');
    errs.assertNone('leg 7');
  });
});
