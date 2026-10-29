import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  armAndPlaceAt,
  cameraOf,
  dispatchPointer,
  expectRenderLoopAlive,
  handPath,
  newBoard,
  nodeAtAnchor,
  pointerTravel,
  pollScene,
  readScene,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  seenPointerEvents,
  touchSequence,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  watchPointerEvents,
  type SceneFacts,
} from './support/oracle';
import { CMD, beltOn, cellPoint, doorstep, expectOnCanvas, installFrameSniffer, portOf, rowCells, sentCount, zoomBelowOne } from './support/beltBoard';

// 89-draw-survives.live.spec.ts (phase 89, plan 89-07, BELT-08, success criterion 4, D-11, WINDOWS
// 244 to 253, UI-SPEC section 5 and A14, A15) - a belt draw survives what a real hand and a real
// webview do to it, on the REAL host (dev_render_server, real Core -> RenderProducer -> postcard
// -> WS). Zero mocks, zero injected packets for the board: every belt is drawn with the shipped
// Belt tool by a hand drag of many sub-cell samples. The interruptions are the ones the browser
// itself produces (a second touch point through CDP's touch input) or the exact events a webview
// that lost a release delivers (a `pointercancel`, a move of the owning pointer with no button
// down), dispatched on the canvas.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## BELT-08/W244` to `W253`)
// ---------------------------------------------------------------------------
//
// The draw state was one global any pointer fed: a second finger reseeded the path and its lift
// committed a belt nobody drew. There was no `pointercancel` handler and no pointer capture, so a
// cancelled or lost release left the path live and the next release (or a move with no button
// down) laid a belt the user never released. D-11: one pointer owns a draw; a cancel, a lost
// capture or a move with no button down throws the path away and keeps the Belt tool armed; no
// flash and no sentence (A15).
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE EYE SEES (UI-SPEC section 5, one leg per row)
// ---------------------------------------------------------------------------
//
//   1. a second touch point goes down, moves and lifts in the middle of a mouse draw: exactly one
//      new belt, its cells the mouse's, and the Belt palette row still `aria-pressed="true"`;
//   2. a `pointercancel` of the mouse's pointer mid-draw: no new belt, the preview gone
//      (`beltPreviewInstructions()` 0) while the hand is still down and after the release, the
//      row still armed, and a fresh drag draws one belt;
//   3. a move of the mouse's pointer with `buttons: 0` mid-draw (a release the webview lost): the
//      same grading as leg 2;
//   4. a middle-button drag with the Belt tool armed pans the camera (`cameraOf` moved) and keeps
//      the tool (`aria-pressed="true"`); a multi-cell left draw after it lays exactly one belt on
//      the drawn cells; at zoom 1 and again below 1;
//   5. a middle press in the middle of a left drag (the page's own events say how it arrived,
//      research A5): the camera pans with the hand while the middle is held (review UI-05), the
//      path survives, the cells the hand crossed under the middle button are not in it, and the
//      left release lays exactly one belt on the cells drawn before it;
//   6. Escape while the button is still held, the hand moving on and releasing: no new belt, the
//      preview gone, the tool armed; a second drag draws one belt; a second Escape disarms;
//   7. the Belt row armed from the keyboard (Tab to it, Enter), so its button keeps focus, then
//      Escape: the tool is put away (WINDOWS 252);
//   8. a keyframe mid-drag: a draw pressed on a Source's Out doorstep, Ctrl+Z (undoing the Place of
//      a second Source) while the button is held, the walk going on and released on a Sink's In
//      doorstep. The camera does not move at the keyframe, the preview is plotted after every
//      sampled move (never 0 before the release), and one belt carries every drawn cell, docked at
//      both ends; at zoom 1 and again below 1. (The board boots empty here, which left the boot
//      fit pending until plan 89-07: the Undo's keyframe re-framed the camera under the hand.)
//
// RED FIRST (D-16): legs 1 to 3 run once against the plan's start revision, legs 4 to 8 once
// against Task 1's commit (frontend from a throwaway worktree with this spec and the oracle helpers
// copied in): every leg red (89-EVIDENCE.md, `LIVE_RED 89-draw-survives`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Every belt's tiles as `x,y` lists, for a message. */
function beltsText(s: SceneFacts): string {
  return JSON.stringify(s.belts.map((b) => b.tiles.map((t) => `${t.cell_x},${t.cell_y}`)));
}

/** The Belt palette row (its title is copy that doubles as a selector, prefix-matched). */
function beltRow(page: Page) {
  return page.getByTitle(/^Draw belts/);
}

/** The preview Graphics' plotted instruction count, read once off the page. */
async function previewInstructions(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __fabrico: { beltPreviewInstructions(): number } }).__fabrico.beltPreviewInstructions());
}

/** An empty, playing board at camera scale 1, every named cell on the open canvas. */
async function emptyBoard(page: Page, cells: ReadonlyArray<readonly [number, number]>): Promise<void> {
  await newBoard(page);
  await page.goto('/');
  await waitForAppReady(page);
  await watchPointerEvents(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  for (const [cx, cy] of cells) {
    const pt = await screenCellCentre(page, cx, cy);
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
    expect(under, `cell (${cx},${cy}) is on the open canvas, where a hand reaches the board`).toBe('CANVAS');
  }
  const btn = page.getByRole('button', { name: /^(Play|Pause)$/ });
  if ((await btn.getAttribute('aria-label')) === 'Play') await btn.click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0, { message: 'the empty board is playing', timeout: 10_000 }).toBe(true);
}

/** Arm the Belt tool from its palette row and read it armed. */
async function armBelt(page: Page): Promise<void> {
  await beltRow(page).click();
  await expect(beltRow(page), 'the Belt palette row reads armed').toHaveAttribute('aria-pressed', 'true');
}

/** The press point and the release point of a draw along row `y` from x0 to x1, off-centre. */
async function rowEnds(page: Page, x0: number, x1: number, y: number): Promise<{ a: { x: number; y: number }; b: { x: number; y: number } }> {
  return { a: await cellPoint(page, x0, y, 0.35, 0.45), b: await cellPoint(page, x1, y, 0.6, 0.55) };
}

/** A plain hand draw along row `y` from x0 to x1 (many sub-cell samples), released at the end. */
async function handDraw(page: Page, x0: number, x1: number, y: number): Promise<number> {
  const { a, b } = await rowEnds(page, x0, x1, y);
  const path = handPath(a, b);
  await pointerTravel(page, a.x, a.y);
  await page.mouse.down();
  for (const p of path) await pointerTravel(page, p.x, p.y);
  await page.mouse.up();
  return path.length;
}

/** The pointer id the browser gave the mouse's last real press, read off the page's own events. */
async function mousePointerId(page: Page): Promise<number> {
  const seen = await seenPointerEvents(page);
  const down = [...seen].reverse().find((e) => e.type === 'pointerdown' && e.trusted && e.pointerType === 'mouse');
  expect(down, 'PRECONDITION: the page saw the mouse press as a trusted pointerdown').toBeDefined();
  return down!.pointerId;
}

/**
 * A fresh drag on row `y` draws exactly one belt on its cells: the tool still works. With
 * `interrupted`, the cells of the draw that was interrupted before it are read again at the end, so
 * a belt the interrupted release sent late cannot hide in this drag's baseline (review WR-C-06).
 */
async function expectFreshDragDraws(
  page: Page,
  x0: number,
  x1: number,
  y: number,
  why: string,
  interrupted?: ReadonlyArray<readonly [number, number]>,
): Promise<void> {
  const before = (await readScene(page)).belts.length;
  const cells = rowCells(x0, x1, y);
  const moves = await handDraw(page, x0, x1, y);
  expect(moves, `${why}: the fresh drag moved through many samples`).toBeGreaterThanOrEqual(10);
  await pollScene(page, (s) => (beltOn(s, cells) === undefined ? `no belt on ${JSON.stringify(cells)}: ${beltsText(s)}` : 'drawn'), {
    message: `${why}: a fresh drag draws its belt`,
    timeout: 10_000,
  }).toBe('drawn');
  const after = await readScene(page);
  expect(after.belts.length, `${why}: exactly one more belt`).toBe(before + 1);
  if (interrupted) expect(beltOn(after, interrupted), `${why}: still no belt on the interrupted draw's cells`).toBeUndefined();
}

/**
 * The release of an interrupted draw laid nothing (review WR-C-06): no DrawBelt frame left the
 * page for it (`drawsBefore` read before the press), and once the host has run 40 ticks past the
 * release, the 89-belt-delete settle, no belt stands on the walked cells and the belt count is
 * unchanged. Four ticks was shorter than a loaded round trip.
 */
async function expectNothingLaid(
  page: Page,
  drawsBefore: number,
  beltsBefore: number,
  cells: ReadonlyArray<readonly [number, number]>,
  why: string,
): Promise<void> {
  expect((await sentCount(page, CMD.DrawBelt)) - drawsBefore, `${why}: the release sent no DrawBelt`).toBe(0);
  const t = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick >= t + 40, { message: `${why}: the host ran 40 ticks past the release`, timeout: 10_000 }).toBe(true);
  const s = await readScene(page);
  expect(s.belts.length, `${why}: no belt was laid: ${beltsText(s)}`).toBe(beltsBefore);
  expect(beltOn(s, cells), `${why}: no belt on the walked cells`).toBeUndefined();
  expect((await sentCount(page, CMD.DrawBelt)) - drawsBefore, `${why}: and none was sent while the host ran on`).toBe(0);
}

/**
 * Walk a draw along row `y` from x0 to x1, and run `interrupt` once the hand has crossed `atX`
 * (a cell before the end); the hand keeps walking to the end and lets go. Returns the move count.
 */
async function interruptedDraw(
  page: Page,
  x0: number,
  x1: number,
  y: number,
  atX: number,
  interrupt: (at: { x: number; y: number }) => Promise<void>,
): Promise<number> {
  const { a, b } = await rowEnds(page, x0, x1, y);
  const cut = (await cellPoint(page, atX, y, 0.5, 0.5)).x;
  const path = handPath(a, b);
  await pointerTravel(page, a.x, a.y);
  await page.mouse.down();
  let done = false;
  for (const p of path) {
    await pointerTravel(page, p.x, p.y);
    if (!done && p.x >= cut) {
      done = true;
      await interrupt(p);
    }
  }
  expect(done, 'PRECONDITION: the interruption ran mid-walk').toBe(true);
  await page.mouse.up();
  return path.length;
}

/**
 * Legs 2 and 3: a draw along row 6 interrupted at its third cell by `kind`, then graded: no new belt,
 * the preview gone while the hand is still down and after the release, the tool armed, and a fresh
 * drag on row 10 draws one belt.
 */
async function interruptionLeg(page: Page, kind: 'pointercancel' | 'a move with no button down'): Promise<void> {
  const y = 6;
  const cells = rowCells(6, 11, y);
  await emptyBoard(page, [...cells, ...rowCells(6, 9, 10)]);
  await armBelt(page);
  const before = (await readScene(page)).belts.length;
  const drawsBefore = await sentCount(page, CMD.DrawBelt);
  let previewBefore = -1;
  let previewAfter = -1;
  const moves = await interruptedDraw(page, 6, 11, y, 8, async (at) => {
    previewBefore = await previewInstructions(page);
    const id = await mousePointerId(page);
    if (kind === 'pointercancel') {
      await dispatchPointer(page, { type: 'pointercancel', on: 'canvas', pointerId: id, pointerType: 'mouse', buttons: 0, x: at.x, y: at.y });
    } else {
      await dispatchPointer(page, { type: 'pointermove', on: 'canvas', pointerId: id, pointerType: 'mouse', buttons: 0, x: at.x + 1, y: at.y });
    }
    await expect
      .poll(() => previewInstructions(page), {
        message: `the ${kind} took the preview down while the hand is still down`,
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES + 4), `the preview cleared after the ${kind}`),
      })
      .toBe(0);
    previewAfter = await previewInstructions(page);
  });
  console.log(`P89-W245 ${kind}: moves=${moves} preview_before=${previewBefore} preview_after=${previewAfter}`);
  expect(previewBefore, 'NON-VACUITY: the preview was plotted before the interruption').toBeGreaterThan(0);
  expect(await previewInstructions(page), 'no preview after the release either').toBe(0);
  await expect(beltRow(page), `the Belt tool is still armed after the ${kind}`).toHaveAttribute('aria-pressed', 'true');
  await expectNothingLaid(page, drawsBefore, before, cells, `after the ${kind}`);
  await expectFreshDragDraws(page, 6, 9, 10, `after the ${kind}`, cells);
  await expect(beltRow(page), 'the Belt tool is still armed after the fresh drag').toHaveAttribute('aria-pressed', 'true');
}

/** Wire kinds (kinds.ts). */
const KIND_SOURCE = 0;
const KIND_SINK = 7;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;

/**
 * Leg 4 on one row: a middle-button drag over open floor pans the camera and keeps the Belt tool,
 * then a hand draw along the row lays exactly one belt on its cells.
 */
async function middlePanThenDraw(page: Page, y: number, why: string): Promise<void> {
  const cells = rowCells(6, 10, y);
  const before = (await readScene(page)).belts.length;
  const cam0 = await cameraOf(page);
  const from = await cellPoint(page, 15, y + 2, 0.4, 0.6);
  await expectOnCanvas(page, [from], `${why}: the pan`);
  await pointerTravel(page, from.x, from.y);
  await page.mouse.down({ button: 'middle' });
  for (const p of handPath(from, { x: from.x + 40, y: from.y + 28 })) await pointerTravel(page, p.x, p.y);
  await page.mouse.up({ button: 'middle' });
  await waitForCameraSettle(page);
  const cam1 = await cameraOf(page);
  console.log(`P89-W244 ${why}: camera ${JSON.stringify(cam0)} -> ${JSON.stringify(cam1)}`);
  expect(Math.abs(cam1.x - cam0.x) + Math.abs(cam1.y - cam0.y), `${why}: the middle drag panned the camera`).toBeGreaterThan(20);
  await expect(beltRow(page), `${why}: the middle drag kept the Belt tool`).toHaveAttribute('aria-pressed', 'true');
  const { a, b } = await rowEnds(page, 6, 10, y);
  await expectOnCanvas(page, [a, b], `${why}: the draw after the pan`);
  const moves = await handDraw(page, 6, 10, y);
  expect(moves, `${why}: the draw moved through many samples`).toBeGreaterThanOrEqual(10);
  await pollScene(page, (s) => (beltOn(s, cells) === undefined ? `no belt on ${JSON.stringify(cells)}: ${beltsText(s)}` : 'drawn'), {
    message: `${why}: the draw after the pan laid its belt`,
    timeout: 10_000,
  }).toBe('drawn');
  expect((await readScene(page)).belts.length, `${why}: exactly one new belt`).toBe(before + 1);
  await expect(beltRow(page), `${why}: the Belt tool is still armed`).toHaveAttribute('aria-pressed', 'true');
}

/** Leg 8's row: a Source at x 6 feeding East, a Sink at x 13 taking from the West, on row `y`. */
interface KeyframeRow {
  name: string;
  y: number;
}
const KEYFRAME_ROWS: readonly KeyframeRow[] = [
  { name: 'at zoom 1', y: 6 },
  { name: 'below zoom 1', y: 12 },
];
const KF_SOURCE_X = 6;
const KF_SINK_X = 13;
/** The second Source, placed last on each row and undone mid-drag: three rows below, off the path. */
const KF_EXTRA_DY = 3;
const KF_EXTRA_X = 9;

/** Place a row's Source and Sink, and read the two doorsteps the draw joins. */
async function buildKeyframeRow(page: Page, row: KeyframeRow): Promise<{ from: [number, number]; to: [number, number] }> {
  await armAndPlaceAt(page, 'Source', KF_SOURCE_X, row.y);
  await armAndPlaceAt(page, 'Sink', KF_SINK_X, row.y);
  await pollScene(page, (s) => `${nodeAtAnchor(s, KF_SOURCE_X, row.y)?.kind ?? -1},${nodeAtAnchor(s, KF_SINK_X, row.y)?.kind ?? -1}`, {
    message: `${row.name}: the palette Source and Sink were placed`,
  }).toBe(`${KIND_SOURCE},${KIND_SINK}`);
  const s = await readScene(page);
  const out = portOf(s, [KF_SOURCE_X, row.y], ROLE_OUT, 0)!;
  const inp = portOf(s, [KF_SINK_X, row.y], ROLE_IN, 0)!;
  expect(out, `${row.name}: the Source has a Mechanical Out`).toBeDefined();
  expect(inp, `${row.name}: the Sink has a Mechanical In`).toBeDefined();
  const from = doorstep(out);
  const to = doorstep(inp);
  expect([from[1], to[1]], `${row.name}: PRECONDITION: both doorsteps are on row ${row.y}`).toEqual([row.y, row.y]);
  expect(to[0] - from[0], `${row.name}: PRECONDITION: the Sink's doorstep is East of the Source's, cells apart`).toBeGreaterThanOrEqual(4);
  return { from, to };
}

/**
 * Leg 8 on one row: place the second Source (the last edit), press on the first Source's Out
 * doorstep, walk East, press Ctrl+Z once the hand is past half way (the Undo removes the second
 * Source and the host sends a keyframe), keep walking, and release on the Sink's In doorstep. The
 * preview is read after every move once the keyframe has landed.
 */
async function keyframeLeg(page: Page, row: KeyframeRow, ends: { from: [number, number]; to: [number, number] }): Promise<void> {
  const extra: [number, number] = [KF_EXTRA_X, row.y + KF_EXTRA_DY];
  await armAndPlaceAt(page, 'Source', extra[0], extra[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, extra[0], extra[1])?.kind ?? -1, {
    message: `${row.name}: the second Source was placed (the edit the Undo takes back)`,
  }).toBe(KIND_SOURCE);
  await armBelt(page);
  const cells = rowCells(ends.from[0], ends.to[0], row.y);
  const before = (await readScene(page)).belts.length;
  const a = await cellPoint(page, ends.from[0], row.y, 0.4, 0.45);
  const b = await cellPoint(page, ends.to[0], row.y, 0.55, 0.55);
  await expectOnCanvas(page, [a, b], `${row.name}: the draw`);
  const cut = (await cellPoint(page, ends.from[0] + 2, row.y, 0.5, 0.5)).x;
  const path = handPath(a, b);
  await pointerTravel(page, a.x, a.y);
  await page.mouse.down();
  let undone = false;
  const after: number[] = [];
  for (const p of path) {
    await pointerTravel(page, p.x, p.y);
    if (!undone && p.x >= cut) {
      undone = true;
      const cam0 = await cameraOf(page);
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => nodeAtAnchor(s, extra[0], extra[1])?.kind ?? -1, {
        message: `${row.name}: the Undo took the second Source back while the button is held`,
      }).toBe(-1);
      // The board does not move under the hand: an Undo's keyframe is not a load, so it never
      // frames the camera (the boot fit an empty board left pending, plan 89-07). Read on each of
      // the next three animation frames in the page, not once on the echo's task (review
      // IN-C-08): a fit applied on the next ticker frame would land in one of these reads. (The
      // render clock behind `frame()` restarts on a keyframe, so it cannot count these frames.)
      const cams = await page.evaluate(
        () =>
          new Promise<Array<{ x: number; y: number; scale: number }>>((resolve) => {
            const seen: Array<{ x: number; y: number; scale: number }> = [];
            const step = (): void => {
              const c = (window as unknown as { __fabrico: { camera(): { x: number; y: number; scale: number } } }).__fabrico.camera();
              seen.push({ x: c.x, y: c.y, scale: c.scale });
              if (seen.length >= 3) resolve(seen);
              else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }),
      );
      expect(cams.length, `${row.name}: the camera was read on three frames after the keyframe`).toBe(3);
      expect(cams, `${row.name}: the keyframe left the camera where the hand had it, on every frame after it`).toEqual(
        cams.map(() => ({ x: cam0.x, y: cam0.y, scale: cam0.scale })),
      );
      after.push(await previewInstructions(page));
    } else if (undone) {
      after.push(await previewInstructions(page));
    }
  }
  expect(undone, `${row.name}: PRECONDITION: the Undo ran mid-walk`).toBe(true);
  console.log(`P89-W246 ${row.name}: moves=${path.length} preview_after_keyframe=${JSON.stringify(after)}`);
  expect(after.length, `${row.name}: the preview was read after the keyframe on many moves`).toBeGreaterThanOrEqual(5);
  expect(after.filter((n) => n === 0).length, `${row.name}: the preview never blinked out after the keyframe`).toBe(0);
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await pollScene(
    page,
    (s) => {
      const belt = beltOn(s, cells);
      if (belt === undefined) return `no belt on ${JSON.stringify(cells)}: ${beltsText(s)}`;
      const src = nodeAtAnchor(s, KF_SOURCE_X, row.y)?.id;
      const snk = nodeAtAnchor(s, KF_SINK_X, row.y)?.id;
      return belt.docks
        .map((d) => `${d.end}@${d.node === src ? 'source' : d.node === snk ? 'sink' : d.node}`)
        .sort()
        .join(',');
    },
    { message: `${row.name}: one belt on every drawn cell, its start on the Source and its end on the Sink`, timeout: 10_000 },
  ).toBe('Head@sink,Tail@source');
  expect((await readScene(page)).belts.length, `${row.name}: exactly one new belt`).toBe(before + 1);
}

test.describe('89 live: a belt draw survives interruptions (BELT-08, D-11)', () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    // Legs 2, 3 and 6 count the DrawBelt frames the page sends (review WR-C-06), before boot.
    await installFrameSniffer(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the draw-survives walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test('1: a second touch point down, moved and lifted during a mouse draw is ignored: one belt, the mouse cells', async ({ page }) => {
    const y = 6;
    const cells = rowCells(6, 11, y);
    await emptyBoard(page, [...cells, [8, 12], [11, 12]]);
    await armBelt(page);
    const before = (await readScene(page)).belts.length;
    const t0 = await cellPoint(page, 8, 12, 0.4, 0.5);
    const t1 = await cellPoint(page, 9, 12, 0.5, 0.5);
    const t2 = await cellPoint(page, 11, 12, 0.6, 0.5);
    const moves = await interruptedDraw(page, 6, 11, y, 8, async (at) => {
      // The finger goes down far from the draw, moves two cells while the mouse keeps walking, and
      // lifts: every touch event between two mouse samples.
      let k = 0;
      await touchSequence(
        page,
        [
          { type: 'start', x: t0.x, y: t0.y },
          { type: 'move', x: t1.x, y: t1.y },
          { type: 'move', x: t2.x, y: t2.y },
          { type: 'end' },
        ],
        async () => {
          k += 1;
          await pointerTravel(page, at.x + k, at.y);
        },
      );
    });
    expect(moves, 'the mouse moved through many samples, not one teleport').toBeGreaterThanOrEqual(10);
    const seen = await seenPointerEvents(page);
    const touchDowns = seen.filter((e) => e.type === 'pointerdown' && e.pointerType === 'touch' && e.trusted);
    console.log(`P89-W253 touch_downs=${touchDowns.length} ids=${JSON.stringify([...new Set(seen.map((e) => `${e.pointerType}:${e.pointerId}`))])}`);
    expect(touchDowns.length, 'NON-VACUITY: the page saw the second finger as a trusted touch pointerdown').toBeGreaterThanOrEqual(1);
    await pollScene(page, (s) => (beltOn(s, cells) === undefined ? `no belt on the mouse cells: ${beltsText(s)}` : 'drawn'), {
      message: "one belt with exactly the mouse's cells",
      timeout: 10_000,
    }).toBe('drawn');
    const s = await readScene(page);
    expect(s.belts.length, `exactly one new belt, nothing from the finger: ${beltsText(s)}`).toBe(before + 1);
    await expect(beltRow(page), 'the Belt tool is still armed').toHaveAttribute('aria-pressed', 'true');
  });

  test('2: a pointercancel mid-draw lays no belt, the preview goes, the tool stays armed, and a fresh drag draws', async ({ page }) => {
    await interruptionLeg(page, 'pointercancel');
  });

  test('3: a move with no button down mid-draw lays no belt, the preview goes, the tool stays armed, and a fresh drag draws', async ({
    page,
  }) => {
    await interruptionLeg(page, 'a move with no button down');
  });
  test('4: a middle-button drag with the Belt tool armed pans and keeps the tool, and the draw after it lays one belt, at zoom 1 and below 1', async ({
    page,
  }) => {
    await emptyBoard(page, [...rowCells(6, 10, 6), [15, 8], ...rowCells(6, 10, 12), [15, 14]]);
    await armBelt(page);
    await middlePanThenDraw(page, 6, 'at zoom 1');
    await expectRenderLoopAlive(page, 'after the zoom 1 row');
    const scale = await zoomBelowOne(page, [10, 12]);
    console.log(`P89-W244 below zoom 1: camera scale ${scale}`);
    await expect(beltRow(page), 'the wheel kept the Belt tool').toHaveAttribute('aria-pressed', 'true');
    await middlePanThenDraw(page, 12, 'below zoom 1');
  });

  test('5: a middle press in the middle of a left drag neither extends nor commits the path: one belt, the cells drawn before it', async ({
    page,
  }) => {
    const y = 6;
    await emptyBoard(page, rowCells(6, 11, y));
    await armBelt(page);
    const before = (await readScene(page)).belts.length;
    const a = await cellPoint(page, 6, y, 0.35, 0.45);
    const mid = await cellPoint(page, 8, y, 0.55, 0.5);
    const far = await cellPoint(page, 10, y, 0.6, 0.55);
    await pointerTravel(page, a.x, a.y);
    await page.mouse.down();
    for (const p of handPath(a, mid)) await pointerTravel(page, p.x, p.y);
    // Sliced by sequence number, not by array index (review IN-C-04): the recorder trims its
    // oldest entries on a long walk, which shifts every index.
    const mark = (await seenPointerEvents(page)).at(-1)?.seq ?? 0;
    const cam0 = await cameraOf(page);
    await page.mouse.down({ button: 'middle' });
    for (const p of handPath(mid, far)) await pointerTravel(page, p.x, p.y);
    // The chord pans the board with the hand (review UI-05, UI-SPEC section 5 "a mid-draw pan"):
    // red before the camera panned on a chorded middle move, which reaches the page as a move, never
    // as a press. The path is frozen under it, so the hand comes back to the cell it left.
    const cam1 = await cameraOf(page);
    console.log(`P89-UI05 chord pan: camera ${JSON.stringify(cam0)} -> ${JSON.stringify(cam1)}`);
    expect(Math.abs(cam1.x - cam0.x) + Math.abs(cam1.y - cam0.y), 'the middle chord panned the camera with the hand').toBeGreaterThan(20);
    await page.mouse.up({ button: 'middle' });
    const chord = (await seenPointerEvents(page)).filter((e) => e.seq > mark);
    const downs = chord.filter((e) => e.type === 'pointerdown').length;
    const chorded = chord.filter((e) => e.type === 'pointermove' && (e.buttons & 4) !== 0).length;
    const ups = chord.filter((e) => e.type === 'pointerup').length;
    console.log(`P89-A5 middle during a left drag: pointerdown=${downs} chorded_moves=${chorded} pointerup=${ups} buttons=${JSON.stringify([...new Set(chord.map((e) => e.buttons))])}`);
    expect(chorded, 'NON-VACUITY: the page saw moves with the middle button held during the left drag').toBeGreaterThan(0);
    await page.mouse.up();
    const cells = rowCells(6, 8, y);
    await pollScene(page, (s) => (beltOn(s, cells) === undefined ? `no belt on ${JSON.stringify(cells)}: ${beltsText(s)}` : 'drawn'), {
      message: 'one belt on the cells drawn before the middle press, none of the cells crossed under it',
      timeout: 10_000,
    }).toBe('drawn');
    expect((await readScene(page)).belts.length, 'exactly one new belt').toBe(before + 1);
    await expect(beltRow(page), 'the Belt tool is still armed').toHaveAttribute('aria-pressed', 'true');
  });

  test('6: Escape while the button is held cancels only the path: no belt, the tool armed, a second drag draws, a second Escape disarms', async ({
    page,
  }) => {
    const y = 6;
    const cells = rowCells(6, 11, y);
    await emptyBoard(page, [...cells, ...rowCells(6, 9, 10)]);
    await armBelt(page);
    const before = (await readScene(page)).belts.length;
    const drawsBefore = await sentCount(page, CMD.DrawBelt);
    let previewBefore = -1;
    const moves = await interruptedDraw(page, 6, 11, y, 8, async () => {
      previewBefore = await previewInstructions(page);
      await page.keyboard.press('Escape');
      await expect
        .poll(() => previewInstructions(page), {
          message: 'the first Escape took the preview down while the hand is still down',
          timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES + 4), 'the preview cleared after Escape'),
        })
        .toBe(0);
      await expect(beltRow(page), 'the first Escape kept the Belt tool').toHaveAttribute('aria-pressed', 'true');
    });
    console.log(`P89-W247 moves=${moves} preview_before=${previewBefore}`);
    expect(previewBefore, 'NON-VACUITY: the preview was plotted before Escape').toBeGreaterThan(0);
    expect(await previewInstructions(page), 'no preview after the release').toBe(0);
    await expectNothingLaid(page, drawsBefore, before, cells, 'the release after Escape');
    await expect(beltRow(page), 'the Belt tool is still armed after the release').toHaveAttribute('aria-pressed', 'true');
    await expectFreshDragDraws(page, 6, 9, 10, 'after Escape', cells);
    await page.keyboard.press('Escape');
    await expect(beltRow(page), 'the second Escape, with no path, puts the tool away').toHaveAttribute('aria-pressed', 'false');
  });

  test('7: the Belt row armed from the keyboard keeps its focus, and Escape still puts the tool away', async ({ page }) => {
    await emptyBoard(page, rowCells(6, 9, 6));
    let focused = false;
    for (let k = 0; k < 80 && !focused; k += 1) {
      await page.keyboard.press('Tab');
      focused = await beltRow(page).evaluate((el) => el === document.activeElement);
    }
    expect(focused, 'Tab reached the Belt palette row').toBe(true);
    await page.keyboard.press('Enter');
    await expect(beltRow(page), 'Enter on the focused row armed the Belt tool').toHaveAttribute('aria-pressed', 'true');
    expect(await beltRow(page).evaluate((el) => el === document.activeElement), 'PRECONDITION: the row button still holds focus').toBe(true);
    await page.keyboard.press('Escape');
    await expect(beltRow(page), 'Escape past the focused button put the tool away').toHaveAttribute('aria-pressed', 'false');
  });

  test('8: a keyframe mid-drag keeps the drawn path: the preview never blinks, one belt docked at both ends, at zoom 1 and below 1', async ({
    page,
  }) => {
    const cells = KEYFRAME_ROWS.flatMap((r) => [
      ...rowCells(KF_SOURCE_X, KF_SINK_X, r.y),
      [KF_EXTRA_X, r.y + KF_EXTRA_DY] as [number, number],
    ]);
    await emptyBoard(page, cells);
    const ends = [];
    for (const row of KEYFRAME_ROWS) ends.push(await buildKeyframeRow(page, row));
    await expectRenderLoopAlive(page, 'with both rows built');
    for (let i = 0; i < KEYFRAME_ROWS.length; i += 1) {
      const row = KEYFRAME_ROWS[i];
      if (i === 0) {
        expect((await cameraOf(page)).scale, `${row.name}: walked at camera scale 1`).toBe(1);
      } else {
        const scale = await zoomBelowOne(page, [KF_SINK_X, row.y]);
        console.log(`P89-W246 ${row.name}: camera scale ${scale}`);
      }
      await keyframeLeg(page, row, ends[i]);
      await expectRenderLoopAlive(page, `after the ${row.name} leg`);
    }
  });
});
