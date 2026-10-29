import { test, expect, type Page } from '@playwright/test';
import {
  applyConfig,
  armAndPlaceAt,
  backedUpMarkPaintedOn,
  cameraOf,
  DRAWN_STATE_FRAMES,
  drawOffloadBelt,
  expectRenderLoopAlive,
  fillPanelField,
  loadGaugeFormOn,
  newBoard,
  nodeAtAnchor,
  outwardStep,
  pollScene,
  pressSegment,
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

// 87-source-backed-up.live.spec.ts (plan 87-01, JAM-06, WINDOWS 173, D-09, phase 87 success
// criterion 5) - a Source whose backlog is full shows the backed-up mark on the real board. On
// the REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks,
// zero injected packets. The spec reads the oracle (`window.__fabrico.scene()`, the MODEL) AND
// the load gauge drawn on the canvas, because a model read alone passes over a board that draws
// nothing (memory fabrico-model-oracle-blindspot, 87-RESEARCH Pitfall 5).
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-09: the host's state byte reads the Source's own backlog (`ManualInject.pending` against
// `SOURCE_PENDING_CAP`, through the core's one predicate `admit::source_accepts_one`) as well
// as the mechanical inbox, and the load gauge reads the same backlog on the same bands. A Source
// whose backlog is full is refusing every event it is sent, so it paints BACKED_UP (state 3)
// with the merged full bar. Before plan 87-01 it painted WORKING (state 1) with no gauge at all,
// because a Source has no mechanical inbox to fill: the user saw a green machine silently
// dropping every event (WINDOWS 173).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. On an empty board at zoom 1 a palette Source is placed at (10,8). A belt is drawn from
//      its Out through three empty cells with the Belt tool and released on plain floor, so its
//      Head docks nowhere: the belt fills, its staging inbox fills, and the Source can drain no
//      more of its backlog.
//   2. The Source is set to Timer, Every 2, through its panel, and the panel is applied: the
//      host's own clock now sends it one event every two ticks.
//   3. The belt packs and the Source's backlog reaches its cap. The Source reads state 3
//      (BACKED_UP) on the model, its backed-up mark is painted on the canvas (the gauge plotted
//      geometry, read off its Graphics), and the gauge is drawn in its merged full-bar form.
//      The reading holds over a further window of sampled scenes, never falling back to WORKING.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after
// the gestures and at the end, and the watcher's `assertNone`.
//
// RED ON THE UNCHANGED HOST (PHASE87_START), recorded in 87-EVIDENCE.md: the Source read
// state 1 (WORKING) with its backlog full, and nothing was painted on it.

/** Kind byte of a Source (protocol `machine_kind`). A number on purpose: the live suite
 *  imports no product source. */
const KIND_SOURCE = 0;
/** Port role Out (oracle `PortFacts.role`). */
const ROLE_OUT = 1;
/** The state bytes (`fabrico-protocol` `state_tag`), transcribed, the values
 *  `25-backpressure-cascade.spec.ts` mirrors. */
const WORKING = 1;
const BACKED_UP = 3;

/** The Source's anchor, and an empty floor cell clear of the Source and its belt. */
const SOURCE_AT: [number, number] = [10, 8];
const FLOOR_AT: [number, number] = [20, 16];
/** The belt's tiles from the Source's doorstep (three cells, Head on plain floor). */
const BELT_TILES = 3;

/** The Timer interval the Source is set to, in sim ticks (one event every two ticks). */
const FEED_EVERY = 2;
/** The core's numbers, transcribed: `SLOTS_PER_TILE` (four slots a tile),
 *  `MECHANICAL_INBOX_CAP` (a belt's staging inbox) and `SOURCE_PENDING_CAP` (the backlog). */
const SLOTS_PER_TILE = 4;
const INBOX_CAP = 16;
const PENDING_CAP = 16;
/** Items the Source must be sent before its backlog is full: every belt slot, the belt's
 *  staging inbox, then the backlog itself. */
const ITEMS_TO_FILL = BELT_TILES * SLOTS_PER_TILE + INBOX_CAP + PENDING_CAP;
/** Ticks the fill takes at the Timer's pace, doubled for the belt's own traversal and the
 *  Apply's round trip. */
const FILL_TICKS = 2 * FEED_EVERY * ITEMS_TO_FILL;
/** Ticks the BACKED_UP reading is held for after it first shows (two seconds at full speed,
 *  about six under the CPU quota, so the poll's 100, 250 then 500 ms reads land several times
 *  inside it). */
const HOLD_TICKS = 120;
/** How many times slower than `FLOOR_TPS` a board may tick and still be graded: the CPU-quota
 *  run measured about 20 ticks a second on this board (plan 87-01), under the floor's 28, so
 *  every tick budget below is this many times the ticks it waits for. */
const SLOW_BOARD = 3;
/** The fewest scene reads the hold must take for its every-read claim to mean anything. */
const HOLD_READS = 4;

type NodeFacts = SceneFacts['nodes'][number];

/** An empty, playing board at camera scale 1 (the `86-paused-add-output-delete` shape: the app
 *  is opened again on the empty board so it boots at its identity camera, whatever ran before). */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await page.goto('/');
  await waitForAppReady(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  const cells: [number, number][] = [SOURCE_AT, FLOOR_AT];
  for (let k = 1; k <= BELT_TILES; k += 1) cells.push([SOURCE_AT[0] + k, SOURCE_AT[1]]);
  for (const [cx, cy] of cells) {
    const pt = await screenCellCentre(page, cx, cy);
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
    expect(under, `cell (${cx},${cy}) is on the open canvas, where a click reaches the board`).toBe('CANVAS');
  }
  const btn = page.getByRole('button', { name: /^(Play|Pause)$/ });
  if ((await btn.getAttribute('aria-label')) === 'Play') await btn.click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0, { message: 'the empty board is playing', timeout: 10_000 }).toBe(true);
}

/** The Source seated at SOURCE_AT, or undefined. */
function sourceOf(scene: SceneFacts): NodeFacts | undefined {
  const n = nodeAtAnchor(scene, SOURCE_AT[0], SOURCE_AT[1]);
  return n?.kind === KIND_SOURCE ? n : undefined;
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('JAM-06 live: a Source with a full backlog shows backed up, on the model and on the canvas', () => {
  test('a Timer Source into a belt whose Head docks nowhere reads BACKED_UP and paints the full bar once its backlog is full', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);

    // (1) The Source, and a belt from its Out through three empty cells, Head on plain floor.
    await armAndPlaceAt(page, 'Source', SOURCE_AT[0], SOURCE_AT[1]);
    await pollScene(page, (s) => sourceOf(s)?.kind ?? -1, {
      message: `the palette Source was placed at (${SOURCE_AT[0]},${SOURCE_AT[1]})`,
    }).toBe(KIND_SOURCE);
    const source = sourceOf(await readScene(page))!;
    const out = source.ports.find((p) => p.role === ROLE_OUT);
    expect(out, 'NON-VACUITY: the placed Source has an Out port').toBeDefined();
    const [dx, dy] = outwardStep(out!.side);
    const tiles: [number, number][] = [];
    for (let k = 1; k <= BELT_TILES; k += 1) tiles.push([out!.cell_x + k * dx, out!.cell_y + k * dy]);
    await drawOffloadBelt(page, out!, tiles);
    const beltOf = (s: SceneFacts) =>
      s.belts.find((b) => b.tiles.some((t) => t.cell_x === tiles[0][0] && t.cell_y === tiles[0][1]));
    await pollScene(page, (s) => beltOf(s)?.docks.map((d) => `${d.end}@${d.node}`).join(',') ?? 'no belt', {
      message: "the belt from the Source's Out docks its Tail on the Source and its Head nowhere",
    }).toBe(`Tail@${source.id}`);
    await expectRenderLoopAlive(page, 'after the Source and its belt are drawn');
    expect(
      sourceOf(await readScene(page))?.state,
      'NON-VACUITY: the Source is not already backed up before it is fed (nothing has been sent to it)',
    ).not.toBe(BACKED_UP);

    // (2) Timer, Every 2, applied: the host's own clock feeds it one event every two ticks.
    await selectMachineAt(page, SOURCE_AT[0], SOURCE_AT[1]);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', String(FEED_EVERY));
    await applyConfig(page);
    const floor = await screenCellCentre(page, FLOOR_AT[0], FLOOR_AT[1]);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    await expectRenderLoopAlive(page, 'after the Timer is applied');

    // (3) The belt packs and the backlog fills: BACKED_UP on the model.
    const fillMs = addWaitBudget(
      tickBudgetMs(SLOW_BOARD * FILL_TICKS),
      `the Source is sent ${ITEMS_TO_FILL} events at one every ${FEED_EVERY} ticks`,
    );
    await pollScene(page, (s) => ({ beltHead: beltOf(s)?.headOccupied ?? false, state: sourceOf(s)?.state ?? -1 }), {
      timeout: fillMs,
      message:
        `JAM-06: with the belt packed and its Head docked nowhere, the Source's backlog fills to its cap ` +
        `within ${FILL_TICKS} ticks and the Source reads BACKED_UP (${BACKED_UP}), not WORKING (${WORKING})`,
    }).toEqual({ beltHead: true, state: BACKED_UP });

    // The mark on the canvas: the gauge on the Source plotted geometry, in its merged full bar.
    const drawnMs = addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the canvas draws the backed-up Source');
    await expect
      .poll(() => backedUpMarkPaintedOn(page, source.id), {
        timeout: drawnMs,
        message: "JAM-06 PAINTED: the backed-up mark is drawn on the Source's own gauge on the canvas",
      })
      .toBe(true);
    await expect
      .poll(async () => (await loadGaugeFormOn(page, source.id))?.merged ?? false, {
        timeout: drawnMs,
        message: "JAM-06 PAINTED: the Source's gauge is drawn as the merged full bar, not a partial run",
      })
      .toBe(true);

    // (4) The reading holds: every scene read while the board runs a further HOLD_TICKS ticks
    // reads BACKED_UP. The poll's read records the Source's state on every read it takes.
    const tStart = (await readScene(page)).tick;
    const seen: number[] = [];
    const holdMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * HOLD_TICKS), `the board runs ${HOLD_TICKS} more ticks`);
    await pollScene(
      page,
      (s) => {
        seen.push(sourceOf(s)?.state ?? -1);
        return s.tick >= tStart + HOLD_TICKS;
      },
      { timeout: holdMs, message: `the board ran ${HOLD_TICKS} ticks past tick ${tStart}` },
    ).toBe(true);
    expect(seen.length, `NON-VACUITY: the hold took at least ${HOLD_READS} scene reads`).toBeGreaterThanOrEqual(HOLD_READS);
    expect(seen, `JAM-06 HOLDS: every scene read over ${HOLD_TICKS} ticks after the backlog filled reads BACKED_UP`).toEqual(
      Array(seen.length).fill(BACKED_UP),
    );
    expect(await backedUpMarkPaintedOn(page, source.id), 'JAM-06 HOLDS: the mark is still painted at the end').toBe(true);

    await expectRenderLoopAlive(page, 'with the Source backed up');
    errs.assertNone('while the Source filled its backlog');
  });
});
