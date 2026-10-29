import { test, expect, type Page } from '@playwright/test';
import {
  armAndPlaceAt,
  backedUpMarkPaintedOn,
  cameraOf,
  drawBeltThroughCells,
  expectRenderLoopAlive,
  loadGaugeFormOn,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  readTickRecorder,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  startTickRecorder,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, tickBudgetMs } from '../e2e/support/frameSampler';

// 87-balancer-both-inputs.live.spec.ts (plan 87-03, JAM-01, WINDOWS 175, D-02, phase 87 success
// criterion 1) - a belt docked to a Balancer's SECOND input flows. On the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: every machine comes off the palette, every belt is drawn with the Belt tool, and every
// item is a real POST to a Source's own webhook.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-02: the Balancer services BOTH declared In ports with the round-robin scan `merge.rs` uses,
// from its own input pointer `next_in` (never the output pointer `next`), and re-wakes while
// either In holds a backlog. The port catalog keeps two In ports. Before plan 87-03 only In 0
// was ever taken: a belt docked to In 1 delivered into inbox port 1, which nothing drained, so
// that belt packed and stopped for good while the Balancer looked idle (WINDOWS 175).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. On an empty board at zoom 1: a palette Balancer at (16,8), two palette Sources at (10,8)
//      and (10,9) left on Webhook (a fresh Source has no Configure), and two palette Sinks at
//      (22,7) and (22,10). The Balancer's port facts are read off the scene: its two Ins (role
//      In, sorted by row) and its two Outs.
//   2. A belt from each Source's Out straight into one Balancer In (Source A into In 0, Source B
//      into In 1), and a belt from each Balancer Out, with one bend, into one Sink. Every belt is
//      graded on its dock set before anything is sent.
//   3. A burst of BURST POSTs to each Source's webhook URL, interleaved, each answered 200.
//   4. The tick recorder runs until both inlet belts read empty (a derived budget). Graded: both
//      inlet belts carried items and emptied, both outlet belts carried items, and the Balancer
//      ends neither BACKED_UP on the model nor painted backed up or merged full on the canvas.
//
// Render health in the test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after the
// gestures and at the end, and the watcher's `assertNone`.
//
// RED ON PLAN 87-02'S HOST, recorded in 87-EVIDENCE.md: the In 1 belt stays
// packed and never empties.

/** Kind bytes (protocol `machine_kind`), transcribed: the live suite imports no product source. */
const KIND_SOURCE = 0;
const KIND_SINK = 7;
const KIND_BALANCER = 4;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** The BACKED_UP state byte (`fabrico-protocol` `state_tag`). */
const BACKED_UP = 3;

/** Where everything sits. The Balancer is 2 by 2: Ins on its west column, Outs on its east. */
const BALANCER_AT: [number, number] = [16, 8];
const SOURCE_A_AT: [number, number] = [10, 8];
const SOURCE_B_AT: [number, number] = [10, 9];
const SINK_0_AT: [number, number] = [22, 7];
const SINK_1_AT: [number, number] = [22, 10];

/** The inlet belts, Source doorstep to the In's facing cell (five tiles each). */
const INLET_A: [number, number][] = [
  [11, 8],
  [12, 8],
  [13, 8],
  [14, 8],
  [15, 8],
];
const INLET_B: [number, number][] = [
  [11, 9],
  [12, 9],
  [13, 9],
  [14, 9],
  [15, 9],
];
/** The outlet belts, Out doorstep to the Sink In's facing cell, one bend each. */
const OUTLET_0: [number, number][] = [
  [18, 8],
  [19, 8],
  [20, 8],
  [20, 7],
  [21, 7],
];
const OUTLET_1: [number, number][] = [
  [18, 9],
  [19, 9],
  [20, 9],
  [20, 10],
  [21, 10],
];

/** Items POSTed to each Source. More than an inlet belt plus the Balancer's In inbox can hold
 *  (`SLOTS_PER_TILE` 4 x 5 tiles = 20, plus `MECHANICAL_INBOX_CAP` 16 would hold 36), so an In
 *  that is never drained cannot hide its items; under the Source's 16-item backlog cap as well
 *  as the belt, so most of the burst is admitted. */
const BURST = 24;
/** The core's numbers, transcribed: `SLOTS_PER_TILE` and the belt's default `ticks_per_slot`. */
const SLOTS_PER_TILE = 4;
const TICKS_PER_SLOT = 2;
/** Ticks the drain takes at most on a working board: the Balancer takes ONE item a tick from
 *  the two Ins together, so both bursts leave in 2 x BURST ticks, plus one inlet belt's
 *  traversal and one outlet belt's, doubled for the POSTs' own round trips. */
const DRAIN_TICKS = 2 * (2 * BURST + 2 * INLET_A.length * SLOTS_PER_TILE * TICKS_PER_SLOT);
/** How many times slower than `FLOOR_TPS` a board may tick and still be graded (the CPU-quota
 *  run measured about 20 ticks a second on a small board in plan 87-01, under the floor's 28). */
const SLOW_BOARD = 3;
/** Ticks the board runs after the inlets empty, so the outlet belts finish delivering and the
 *  Balancer's final state is read on a settled board. */
const SETTLE_TICKS = 2 * OUTLET_0.length * SLOTS_PER_TILE * TICKS_PER_SLOT;

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/** An empty, playing board at camera scale 1, every cell this spec uses on the open canvas
 *  (the `87-source-backed-up` shape). */
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
    BALANCER_AT,
    [BALANCER_AT[0] + 1, BALANCER_AT[1] + 1],
    SOURCE_A_AT,
    SOURCE_B_AT,
    SINK_0_AT,
    SINK_1_AT,
    ...INLET_A,
    ...INLET_B,
    ...OUTLET_0,
    ...OUTLET_1,
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

/** Draw one docked belt and grade its dock set on the model. */
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

/** POST one item to a Source's webhook; returns the status. */
async function post(page: Page, url: string, n: number): Promise<number> {
  const resp = await page.request.post(url, { data: { n } });
  return resp.status();
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('JAM-01 live: a Balancer drains both of its inputs', () => {
  test('two Webhook Sources belted into the Balancer In 0 and In 1 both empty, both Outs carry items, and the Balancer is not left backed up', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);

    // (1) The machines, off the palette.
    const bal = await place(page, 'Balancer', KIND_BALANCER, BALANCER_AT);
    const srcA = await place(page, 'Source', KIND_SOURCE, SOURCE_A_AT);
    const srcB = await place(page, 'Source', KIND_SOURCE, SOURCE_B_AT);
    const sink0 = await place(page, 'Sink', KIND_SINK, SINK_0_AT);
    const sink1 = await place(page, 'Sink', KIND_SINK, SINK_1_AT);
    const ins = bal.ports.filter((p) => p.role === ROLE_IN).sort((a, b) => a.cell_y - b.cell_y);
    const outs = bal.ports.filter((p) => p.role === ROLE_OUT).sort((a, b) => a.cell_y - b.cell_y);
    expect(ins.length, 'NON-VACUITY: the placed Balancer declares two In ports').toBe(2);
    expect(outs.length, 'NON-VACUITY: the placed Balancer declares two Out ports').toBe(2);
    expect(
      ins.map((p) => [p.cell_x, p.cell_y]),
      'the Balancer Ins sit on its west column, In 0 above In 1',
    ).toEqual([
      [BALANCER_AT[0], BALANCER_AT[1]],
      [BALANCER_AT[0], BALANCER_AT[1] + 1],
    ]);
    const outOf = (n: NodeFacts) => n.ports.find((p) => p.role === ROLE_OUT)!;
    const inOf = (n: NodeFacts) => n.ports.find((p) => p.role === ROLE_IN)!;
    await expectRenderLoopAlive(page, 'after the machines are placed');

    // (2) The belts, each graded on its docks.
    const inletA = await belt(page, srcA, outOf(srcA), INLET_A, bal, ins[0], 'the In 0 inlet');
    const inletB = await belt(page, srcB, outOf(srcB), INLET_B, bal, ins[1], 'the In 1 inlet');
    const outlet0 = await belt(page, bal, outs[0], OUTLET_0, sink0, inOf(sink0), 'the Out 0 outlet');
    const outlet1 = await belt(page, bal, outs[1], OUTLET_1, sink1, inOf(sink1), 'the Out 1 outlet');
    expect(
      [linkKey(bal, ins[0]), linkKey(bal, ins[1])],
      'NON-VACUITY: the two inlets land on Balancer inbox ports 0 and 1, the second being the one WINDOWS 175 names',
    ).toEqual([0, 1]);
    await expectRenderLoopAlive(page, 'after the belts are drawn');

    // (3) The bursts, interleaved, each a real POST to the Source's own URL.
    const urlA = await webhookUrl(page, srcA.id);
    const urlB = await webhookUrl(page, srcB.id);
    expect(urlA, 'Source A answers on its own loopback /hook/src-<id> URL').toMatch(/\/hook\/src-\d+$/);
    expect(urlB, 'Source B answers on its own loopback /hook/src-<id> URL').toMatch(/\/hook\/src-\d+$/);
    await startTickRecorder(page, { gaugeOf: [bal.id] });
    const statuses: number[] = [];
    for (let k = 0; k < BURST; k += 1) {
      statuses.push(await post(page, urlA!, k));
      statuses.push(await post(page, urlB!, k));
    }
    expect(statuses, `every one of the ${2 * BURST} POSTs is answered 200`).toEqual(Array(2 * BURST).fill(200));

    // (4) The inlets empty within the derived budget.
    const drainMs = addWaitBudget(
      tickBudgetMs(SLOW_BOARD * DRAIN_TICKS),
      `the Balancer takes ${2 * BURST} items from its two Ins at one a tick`,
    );
    const items = (s: SceneFacts) => [beltAt(s, INLET_A[0])?.items ?? -1, beltAt(s, INLET_B[0])?.items ?? -1];
    await pollScene(page, items, {
      timeout: drainMs,
      message:
        `JAM-01: both inlet belts empty within ${DRAIN_TICKS} ticks of the bursts, In 1 as well as In 0 ` +
        '(before plan 87-03 the In 1 belt stayed packed: nothing drained inbox port 1)',
    }).toEqual([0, 0]);
    const tEmpty = (await readScene(page)).tick;
    const settleMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS), `the board runs ${SETTLE_TICKS} more ticks`);
    await pollScene(page, (s) => s.tick >= tEmpty + SETTLE_TICKS, {
      timeout: settleMs,
      message: `the board ran ${SETTLE_TICKS} ticks past the drain`,
    }).toBe(true);

    // What every belt carried, off the tick recording.
    const rec = await readTickRecorder(page);
    const carried = (id: number) => Math.max(0, ...rec.records.map((r) => r.belts.find((b) => b[0] === id)?.[2].length ?? 0));
    const facts = {
      inletA: carried(inletA),
      inletB: carried(inletB),
      outlet0: carried(outlet0),
      outlet1: carried(outlet1),
      records: rec.records.length,
    };
    console.log(`JAM01_LIVE ${JSON.stringify(facts)} drain_ticks=${tEmpty - rec.records[0].t}`);
    expect(facts.records, 'NON-VACUITY: the tick recorder took records').toBeGreaterThan(0);
    expect(facts.inletA, 'NON-VACUITY: the In 0 inlet carried items').toBeGreaterThan(0);
    expect(facts.inletB, 'NON-VACUITY: the In 1 inlet carried items').toBeGreaterThan(0);
    expect(facts.outlet0, 'JAM-01: the Out 0 outlet belt carried items').toBeGreaterThan(0);
    expect(facts.outlet1, 'JAM-01: the Out 1 outlet belt carried items').toBeGreaterThan(0);

    // The Balancer is not left backed up: the model, the painted mark and the gauge's form.
    const last = await readScene(page);
    const balNow = nodeAtAnchor(last, BALANCER_AT[0], BALANCER_AT[1]);
    expect(balNow?.state, 'JAM-01: the Balancer is not left BACKED_UP on the model').not.toBe(BACKED_UP);
    expect(await backedUpMarkPaintedOn(page, bal.id), 'JAM-01: no backed-up mark is painted on the Balancer').toBe(false);
    expect(
      (await loadGaugeFormOn(page, bal.id))?.merged ?? false,
      "JAM-01: the Balancer's gauge is not drawn as the merged full bar",
    ).toBe(false);

    await expectRenderLoopAlive(page, 'with both inlets drained');
    errs.assertNone('while the Balancer drained both of its inputs');
  });
});
