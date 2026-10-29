import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  applyConfig,
  armAndPlaceAt,
  cameraOf,
  captureClip,
  clickAt,
  deselectViaEmptyCell,
  drawBeltThroughCells,
  expectRenderLoopAlive,
  fillPanelField,
  newBoard,
  nodeAtAnchor,
  pollScene,
  pressSegment,
  readBeltFlowWatch,
  readScene,
  readTickRecorder,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  selectMachineAt,
  startBeltFlowWatch,
  startTickRecorder,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL, colorOracles } from '../shared/geometry';

// 87-tee-slow-branch.live.spec.ts (plan 87-05, JAM-02, WINDOWS 174, D-03, phase 87 success
// criterion 2) - one slowed Tee branch does not stop the others. On the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: every machine comes off the palette, every belt is drawn with the Belt tool, the slow
// branch is paced through its panel and the Source runs on its own Timer.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-03: the Tee's output gate is per branch. A branch whose destination can take one more item
// takes its copy at once. A branch whose destination is still full when the next item arrives
// does not get that copy: the copy goes to the Tee's fault port as a fault naming the branch
// ("branch busy"), so it shows on the board (the Tee reads FAULTED on that tick, its alert ring
// is drawn) and in the fault count, and never vanishes. A healthy branch runs at its own pace; a
// slow branch gets every copy it can take. Before plan 87-05 the gate was ANY-blocked: once the
// slow branch filled, the whole Tee stopped, its inlet backed up and the healthy branch was held
// to the slow branch's pace (WINDOWS 174, P174: 20, 0, 0, 0 items per 200 ticks headless).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. On an empty board at zoom 1: a palette Source at (9,8), a palette Tee (2 by 2) at
//      (14,8), and two palette Sinks, the healthy one at (22,8) and the slow one at (19,9).
//   2. A belt from the Source's Out into the Tee's In; a belt from the Tee's upper Out (row 8)
//      into the healthy Sink; a three-tile belt from its lower Out (row 9) into the slow Sink.
//      Every belt is graded on its dock set.
//   3. The slow belt is paced to the slowest pace (20 ticks a slot) through its panel; the
//      Source is put on Timer, every 2 ticks, through its panel.
//   4. The slow belt fills (packed head to tail, a derived budget), then the tick recorder and
//      the belt-flow watch record WINDOW ticks. Graded: the healthy Sink takes items in every
//      quarter of the window, in each quarter more than twice what a branch held to the slow
//      belt's pace could take; the slow belt carries items and its Sink takes some (it still
//      delivers); the Tee reads FAULTED on at least one recorded tick and BACKED_UP on none.
//   5. A burst of captures of the Tee's box: the fault accent is painted on it on at least one
//      captured frame.
//
// Render health in the test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after the
// gestures and at the end, and the watcher's `assertNone`.
//
// RED ON PLAN 87-04'S HOST, recorded in 87-EVIDENCE.md: the Tee backs up and
// never reads FAULTED, and the healthy Sink is held to the slow belt's pace.

/** Kind bytes (protocol `machine_kind`), transcribed: the live suite imports no product source. */
const KIND_SOURCE = 0;
const KIND_TEE = 3;
const KIND_SINK = 7;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** State bytes (`fabrico-protocol` `state_tag`). */
const WORKING = 1;
const FAULTED = 2;
const BACKED_UP = 3;

/** Where everything sits. The Tee is 2 by 2: In on its west column's upper row, both Outs on
 *  its east column (the palette catalog). */
const SOURCE_AT: [number, number] = [9, 8];
const TEE_AT: [number, number] = [14, 8];
const TEE_SIZE = 2;
const HEALTHY_SINK_AT: [number, number] = [22, 8];
const SLOW_SINK_AT: [number, number] = [19, 9];
/** An empty cell the deselect click lands on, clear of every machine and belt here. */
const EMPTY_CELL: [number, number] = [12, 12];
/** The inlet belt, Source doorstep to the Tee In's facing cell. */
const INLET: [number, number][] = [
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
];
/** The healthy branch, the Tee's upper Out doorstep to the healthy Sink In's facing cell. */
const HEALTHY: [number, number][] = [
  [16, 8],
  [17, 8],
  [18, 8],
  [19, 8],
  [20, 8],
  [21, 8],
];
/** The slow branch, the Tee's lower Out doorstep to the slow Sink In's facing cell. */
const SLOW: [number, number][] = [
  [16, 9],
  [17, 9],
  [18, 9],
];
/** A tile of the slow branch the pace gesture clicks. */
const SLOW_TILE: [number, number] = [17, 9];

/** The slowest `Belt pace` segment's accessible name (`BeltConfigBody.tsx` `PACE_STEPS`: 20
 *  ticks per slot is 25 px per second, and the segment's name carries the unit). */
const SLOWEST_SEGMENT = '25 px per second';
const SLOWEST_TICKS = 20;
/** The Source's Timer interval, in sim ticks. */
const FEED_INTERVAL = '2';
/** The core's numbers, transcribed: `SLOTS_PER_TILE`. */
const SLOTS_PER_TILE = 4;
/** The slow belt packs head to tail in one slot step per slot it holds, plus the time its first
 *  item takes to reach the head, doubled. A packed belt whose head feeds a Sink holds one item
 *  fewer than its slots between slot steps: each step advances every item one slot and admits
 *  one at the tail, and the fold then delivers the item that reached the head (`belt.rs`), so
 *  slot 0 is empty at every tick boundary. Packed is therefore `SLOW_SLOTS - 1` items. */
const SLOW_SLOTS = SLOW.length * SLOTS_PER_TILE;
const SLOW_PACKED = SLOW_SLOTS - 1;
const FILL_TICKS = 2 * (2 * SLOW_SLOTS * SLOWEST_TICKS);
/** The recorded window, in sim ticks. */
const WINDOW = 600;
/** How many times slower than `FLOOR_TPS` a board may tick and still be graded (plan 87-03's
 *  CPU-quota runs measured about 20 ticks a second on a small board, under the floor's 28). */
const SLOW_BOARD = 3;
/** The window is cut into this many equal parts by tick, and the healthy Sink must take items in
 *  each. */
const QUARTERS = 4;
/** A branch held to the slow belt's pace takes at most one item per `SLOWEST_TICKS` ticks, so a
 *  quarter of the window holds at most this many takes for it; the healthy Sink must take more
 *  than twice that in every quarter. */
const HELD_TAKES_PER_QUARTER = Math.ceil(WINDOW / QUARTERS / SLOWEST_TICKS);
/** Captures of the Tee's box the fault probe takes, at most, looking for one painted frame. The
 *  Tee faults on the ticks it sheds a busy copy, so its ring is drawn on some frames and not
 *  others; this many captures span far more than one shed. */
const FAULT_CAPTURES = 12;
/** Pixels around the Tee's box the fault probe reads: the alert ring sits a few px outside the
 *  box edge (`ALERT_RING_OUTSET_U`), so a margin of a third of a cell covers it. */
const RING_MARGIN = Math.round(CELL / 3);

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/** An empty, playing board at camera scale 1, every cell this spec uses on the open canvas
 *  (the `87-factory-two-emits` shape). */
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
  const cells: [number, number][] = [
    SOURCE_AT,
    TEE_AT,
    [TEE_AT[0] + 1, TEE_AT[1] + 1],
    HEALTHY_SINK_AT,
    SLOW_SINK_AT,
    EMPTY_CELL,
    ...INLET,
    ...HEALTHY,
    ...SLOW,
  ];
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

/** Place one palette machine and wait for it on the model; returns its facts. */
async function place(page: Page, label: string, kind: number, at: [number, number]): Promise<NodeFacts> {
  await armAndPlaceAt(page, label, at[0], at[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, at[0], at[1])?.kind ?? -1, {
    message: `the palette ${label} was placed at (${at[0]},${at[1]})`,
  }).toBe(kind);
  return nodeAtAnchor(await readScene(page), at[0], at[1])!;
}

/** The belt whose tiles include `cell`, or undefined. */
function beltAt(scene: SceneFacts, cell: [number, number]): BeltFacts | undefined {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/** A belt's docks as sorted `End@node:port` strings. */
function dockSet(belt: BeltFacts | undefined): string[] {
  return (belt?.docks ?? []).map((d) => `${d.end}@${d.node}:${d.port}`).sort();
}

/** The key a dock on `port` of `node` carries (the host's `dock_link_key`, transcribed): an
 *  In keeps its catalog index, an Out is numbered among the node's Outs in catalog order. */
function linkKey(node: NodeFacts, port: PortFacts): number {
  if (port.role !== ROLE_OUT) return port.index;
  return node.ports.filter((p) => p.role === ROLE_OUT && p.index < port.index).length;
}

/** Draw one docked belt and grade its dock set on the model; returns the belt id. */
async function belt(
  page: Page,
  fromNode: NodeFacts,
  from: PortFacts,
  cells: [number, number][],
  toNode: NodeFacts,
  to: PortFacts,
  what: string,
): Promise<number> {
  await drawBeltThroughCells(page, from, cells, to);
  const tail = linkKey(fromNode, from);
  const head = linkKey(toNode, to);
  const want = [`Head@${toNode.id}:${head}`, `Tail@${fromNode.id}:${tail}`].sort();
  await pollScene(page, (s) => dockSet(beltAt(s, cells[0])), {
    message: `${what}: its Tail docks node ${fromNode.id} key ${tail} and its Head node ${toNode.id} key ${head}`,
  }).toEqual(want);
  return beltAt(await readScene(page), cells[0])!.id;
}

/** Select the belt covering `cell` with a real click and wait for the panel's Belt arm. */
async function selectBeltAt(page: Page, cell: [number, number]): Promise<number> {
  const found = beltAt(await readScene(page), cell);
  expect(found, `a belt really occupies (${cell[0]},${cell[1]})`).toBeTruthy();
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await clickAt(page, at.x, at.y);
  await expect(
    page.locator('#fab-belt-config'),
    `clicking (${cell[0]},${cell[1]}) selected a belt, so the panel's Belt arm is open on it`,
  ).toBeVisible({ timeout: 15_000 });
  return (found as BeltFacts).id;
}

/** Pixels in a clip around the Tee's box that read as the fault accent: red well above green, and
 *  blue above green, which the alert ring is at every alpha of its cadence, and which the grey
 *  ramp, the orange item accent, the green working accent and the blue build accent are not (the
 *  `87-factory-two-emits` probe, unchanged). */
async function faultPixelsAroundTee(page: Page): Promise<{ count: number; clip: { x: number; y: number; width: number; height: number } }> {
  const nw = await screenCellCentre(page, TEE_AT[0], TEE_AT[1]);
  const se = await screenCellCentre(page, TEE_AT[0] + TEE_SIZE - 1, TEE_AT[1] + TEE_SIZE - 1);
  const x = Math.floor(nw.x - CELL / 2 - RING_MARGIN);
  const y = Math.floor(nw.y - CELL / 2 - RING_MARGIN);
  const clip = { x, y, width: Math.ceil(se.x + CELL / 2 + RING_MARGIN) - x, height: Math.ceil(se.y + CELL / 2 + RING_MARGIN) - y };
  const png = PNG.sync.read(await captureClip(page, clip));
  const fault = { r: (colorOracles.fault >> 16) & 0xff, g: (colorOracles.fault >> 8) & 0xff, b: colorOracles.fault & 0xff };
  expect(fault.r - fault.g, 'NON-VACUITY: the fault accent itself passes the probe').toBeGreaterThan(25);
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    if (r >= g + 25 && b >= g + 5 && r >= b) count += 1;
  }
  return { count, clip };
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('JAM-02 live: one slowed Tee branch does not stop the others', () => {
  test('a Tee with one branch slowed keeps feeding its healthy branch at the Source pace, the slow branch still carries items, and the Tee shows FAULTED, never BACKED_UP', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);

    // (1) The machines, off the palette.
    const src = await place(page, 'Source', KIND_SOURCE, SOURCE_AT);
    const tee = await place(page, 'Tee', KIND_TEE, TEE_AT);
    const healthySink = await place(page, 'Sink', KIND_SINK, HEALTHY_SINK_AT);
    const slowSink = await place(page, 'Sink', KIND_SINK, SLOW_SINK_AT);
    const teeIn = tee.ports.find((p) => p.role === ROLE_IN)!;
    const teeOuts = tee.ports.filter((p) => p.role === ROLE_OUT).sort((a, b) => a.cell_y - b.cell_y);
    expect([teeIn.cell_x, teeIn.cell_y], 'the Tee In sits on its west column, upper row').toEqual([TEE_AT[0], TEE_AT[1]]);
    expect(
      teeOuts.map((p) => [p.cell_x, p.cell_y]),
      'NON-VACUITY: the placed Tee declares two Outs, on its east column',
    ).toEqual([
      [TEE_AT[0] + 1, TEE_AT[1]],
      [TEE_AT[0] + 1, TEE_AT[1] + 1],
    ]);
    const outOf = (n: NodeFacts) => n.ports.find((p) => p.role === ROLE_OUT)!;
    const inOf = (n: NodeFacts) => n.ports.find((p) => p.role === ROLE_IN)!;
    await expectRenderLoopAlive(page, 'after the machines are placed');

    // (2) The belts, each graded on its docks.
    const inlet = await belt(page, src, outOf(src), INLET, tee, teeIn, 'the inlet');
    const healthy = await belt(page, tee, teeOuts[0], HEALTHY, healthySink, inOf(healthySink), 'the healthy branch');
    const slow = await belt(page, tee, teeOuts[1], SLOW, slowSink, inOf(slowSink), 'the slow branch');
    await expectRenderLoopAlive(page, 'after the belts are drawn');

    // (3) The slow branch paced through its panel, then the Source on Timer through its panel.
    await selectBeltAt(page, SLOW_TILE);
    expect(
      beltAt(await readScene(page), SLOW_TILE)?.ticksPerSlot,
      `the slow branch must not already sit at ${SLOWEST_TICKS} ticks/slot, or slowing it proves nothing`,
    ).not.toBe(SLOWEST_TICKS);
    await pressSegment(page, 'Belt pace', SLOWEST_SEGMENT);
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await pollScene(page, (s) => s.belts.find((b) => b.id === slow)?.ticksPerSlot, {
      message: `the slowed pace reached the slow branch in the MODEL: ${SLOWEST_TICKS} ticks/slot`,
    }).toBe(SLOWEST_TICKS);
    const healthyPace = (await readScene(page)).belts.find((b) => b.id === healthy)?.ticksPerSlot ?? SLOWEST_TICKS;
    expect(healthyPace, 'NON-VACUITY: the healthy branch kept its own, faster pace').toBeLessThan(SLOWEST_TICKS);
    await selectMachineAt(page, SOURCE_AT[0], SOURCE_AT[1]);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', FEED_INTERVAL);
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await expectRenderLoopAlive(page, 'after the pace and Timer gestures');

    // (4) The slow belt fills, then the window is recorded.
    const fillMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * FILL_TICKS), `the slow branch packs its ${SLOW_SLOTS} slots at ${SLOWEST_TICKS} ticks a slot`);
    await pollScene(page, (s) => (s.belts.find((b) => b.id === slow)?.items ?? -1) >= SLOW_PACKED, {
      timeout: fillMs,
      message: `the slow branch fills: every slot behind its head (${SLOW_PACKED} of ${SLOW_SLOTS}) carries an item within ${FILL_TICKS} ticks of the Timer`,
    }).toBe(true);
    await startTickRecorder(page);
    await startBeltFlowWatch(page);
    const tStart = (await readScene(page)).tick;
    const windowMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * WINDOW), `the ${WINDOW}-tick recorded window`);
    await pollScene(page, (s) => s.tick >= tStart + WINDOW, {
      timeout: windowMs,
      message: `the board runs ${WINDOW} ticks past tick ${tStart} while it is recorded`,
    }).toBe(true);
    const rec = await readTickRecorder(page);
    const flow = await readBeltFlowWatch(page);

    // (5) The fault accent on a captured frame of the Tee's box.
    const pixelsPerCapture: number[] = [];
    let clip: { x: number; y: number; width: number; height: number } | null = null;
    for (let k = 0; k < FAULT_CAPTURES; k += 1) {
      const read = await faultPixelsAroundTee(page);
      pixelsPerCapture.push(read.count);
      clip = read.clip;
      if (read.count > 0) break;
    }

    const stateOf = (r: (typeof rec.records)[number], id: number) => r.nodes.find((n) => n[0] === id)?.[2] ?? -1;
    const inWindow = rec.records.filter((r) => r.t >= tStart && r.t < tStart + WINDOW);
    const healthyTakesPerQuarter = Array.from({ length: QUARTERS }, (_, q) => {
      const lo = tStart + Math.floor((q * WINDOW) / QUARTERS);
      const hi = tStart + Math.floor(((q + 1) * WINDOW) / QUARTERS);
      return inWindow.filter((r) => r.t >= lo && r.t < hi && stateOf(r, healthySink.id) === WORKING).length;
    });
    const slowTakes = inWindow.filter((r) => stateOf(r, slowSink.id) === WORKING).length;
    const teeFaulted = inWindow.filter((r) => stateOf(r, tee.id) === FAULTED).length;
    const teeBackedUp = inWindow.filter((r) => stateOf(r, tee.id) === BACKED_UP).map((r) => r.t);
    const facts = {
      records: inWindow.length,
      missed: rec.missed,
      window: [tStart, tStart + WINDOW],
      healthyPace,
      healthyTakesPerQuarter,
      heldTakesPerQuarter: HELD_TAKES_PER_QUARTER,
      slowTakes,
      teeFaulted,
      teeBackedUp: teeBackedUp.length,
      inletCarried: flow.carried.includes(inlet),
      healthyCarried: flow.carried.includes(healthy),
      slowCarried: flow.carried.includes(slow),
      faultPixelsPerCapture: pixelsPerCapture,
    };
    console.log(`JAM02_LIVE ${JSON.stringify(facts)}`);

    expect(facts.records, 'NON-VACUITY: the tick recorder took records across the window').toBeGreaterThan(0);
    expect(facts.inletCarried, 'NON-VACUITY: the inlet carried items into the Tee').toBe(true);
    expect(facts.healthyCarried, 'JAM-02: the healthy branch carried items').toBe(true);
    for (let q = 0; q < QUARTERS; q += 1) {
      expect(
        healthyTakesPerQuarter[q],
        `JAM-02: the healthy Sink keeps its pace: in quarter ${q + 1} of the ${WINDOW}-tick window it took items on more than twice the ${HELD_TAKES_PER_QUARTER} ticks a branch held to the slow belt's pace could (${JSON.stringify(healthyTakesPerQuarter)})`,
      ).toBeGreaterThan(2 * HELD_TAKES_PER_QUARTER);
    }
    // The slow branch is graded on its Sink's takes, not on the flow watch's head-cleared latch:
    // a packed belt feeding a Sink has slot 0 empty at every tick boundary (the fold delivers the
    // head within the tick), so its lowest occupied slot never rises and that latch cannot fire.
    expect(facts.slowCarried, 'D-03: the slow branch carried items').toBe(true);
    expect(slowTakes, 'D-03: the slow branch still delivers: its Sink took items in the window').toBeGreaterThan(0);
    expect(teeFaulted, 'D-03: the Tee reads FAULTED on the ticks it sheds a copy the slow branch could not take').toBeGreaterThan(0);
    expect(teeBackedUp, 'JAM-02: the Tee never reads BACKED_UP: one slowed branch does not stop it').toEqual([]);
    expect(
      pixelsPerCapture.some((n) => n > 0),
      `D-03: the fault accent is painted on or around the Tee on at least one of ${pixelsPerCapture.length} captured frames (clip ${JSON.stringify(clip)}, pixels ${JSON.stringify(pixelsPerCapture)})`,
    ).toBe(true);

    await expectRenderLoopAlive(page, 'with one branch slowed and the board running');
    errs.assertNone('while the Tee ran with one slowed branch');
  });
});
