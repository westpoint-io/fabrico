import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  applyConfig,
  armAndPlaceAt,
  cameraOf,
  captureClip,
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
  typeFactorySource,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL, colorOracles } from '../shared/geometry';

// 87-factory-two-emits.live.spec.ts (plan 87-04, JAM-05, WINDOWS 165, D-07, phase 87 success
// criterion 4) - a Factory whose code emits twice on one port delivers both, and neither lands
// on its fault port. On the REAL host (dev_render_server, real Core -> RenderProducer -> postcard
// -> WS). Zero mocks, zero injected packets: every machine comes off the palette, every belt is
// drawn with the Belt tool, the Factory's JS is typed into its panel and applied, and every item
// is a real POST to the Source's own webhook.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-07: a Factory's emits beyond the one the output gate cleared wait in a per-port queue on the
// Factory and leave one per port per step as the belt takes them; while the queue is not empty
// the Factory takes no new input, so it applies back-pressure like every other machine. Before
// plan 87-04 both emits were pushed at once, and whenever the outlet belt had room for exactly
// one the second was refused and rested on the Factory's fault port as an `OutputRefused` dead
// letter, which paints the Factory FAULTED and keeps it so (WINDOWS 165).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. On an empty board at zoom 1: a palette Source at (9,8) left on Webhook, a palette Factory
//      (3 by 3) at (14,7) and a palette Sink at (22,8). The Factory's JS is typed and applied:
//      it emits its input twice on Out 0. The Sink is set to HTTP POST at a loopback listener
//      this spec binds off-board, so every item the Sink takes is one real request the spec
//      counts (87-REVIEW WR-02).
//   2. A belt from the Source's Out into the Factory's In, and a belt from the Factory's Out
//      into the Sink's In, each graded on its dock set. The Factory's fault port is left
//      undocked, so a refused emit would rest on it and the Factory would read FAULTED.
//   3. A burst of BURST POSTs to the Source's webhook URL, each answered 200.
//   4. The tick recorder and the belt-flow watch run until the inlet is empty and the outlet has
//      drained (derived budgets). Graded: the Factory never reads FAULTED on any recorded tick;
//      no fault colour is painted on or around it at the end; the outlet belt carried items and
//      the Sink took items in each quarter of the window from its first take to the last tick
//      the outlet was carrying. Since the review the take ticks are read off the dispatches'
//      Idempotency-Keys (exact), no longer off the sampled tick recorder.
//   5. WHAT ARRIVED IS COUNTED (87-REVIEW WR-02). The listener must receive exactly 2 x BURST
//      distinct dispatches (one Idempotency-Key each), and every one of the BURST posted numbers
//      exactly twice in their bodies. Until the review the legs above were the whole grading,
//      and a Factory that silently dropped every second emit (no queue, no fault) passed all of
//      them; the mutation run that reads this leg red against such a host is recorded in
//      87-REVIEW-FIX.md.
//
// Render health in the test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after the
// gestures and at the end, and the watcher's `assertNone`.
//
// RED ON PLAN 87-03'S HOST, recorded in 87-EVIDENCE.md: the Factory turns
// FAULTED under the burst.

/** Kind bytes (protocol `machine_kind`), transcribed: the live suite imports no product source. */
const KIND_SOURCE = 0;
const KIND_FACTORY = 2;
const KIND_SINK = 7;

/** The off-board listener the Sink posts to. A port no other live spec binds (17 binds 8799),
 *  on 127.0.0.1 only, so the executor's connect needs no resolver. */
const HTTP_PORT = 8796;
const HTTP_PATH = '/jam05';
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}${HTTP_PATH}`;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** State bytes (`fabrico-protocol` `state_tag`). */
const WORKING = 1;
const FAULTED = 2;

/** The JS the Factory runs: its input, emitted twice on Out 0. */
const TWO_EMITS_JS = 'export default function (input, ctx) { ctx.emit(0, input); ctx.emit(0, input); }';

/** Where everything sits. The Factory is 3 by 3: In on its west middle row, Out on its east
 *  middle row, the fault port on its south middle column (the palette catalog). */
const SOURCE_AT: [number, number] = [9, 8];
const FACTORY_AT: [number, number] = [14, 7];
const FACTORY_SIZE = 3;
const SINK_AT: [number, number] = [22, 8];
/** An empty cell the deselect click lands on, clear of every machine and belt here. */
const EMPTY_CELL: [number, number] = [12, 12];
/** The inlet belt, Source doorstep to the Factory In's facing cell. */
const INLET: [number, number][] = [
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
];
/** The outlet belt, Factory Out doorstep to the Sink In's facing cell. */
const OUTLET: [number, number][] = [
  [17, 8],
  [18, 8],
  [19, 8],
  [20, 8],
  [21, 8],
];

/** Items POSTed to the Source: more than the Source's 16-item backlog and the inlet together
 *  hold, so the Factory runs under load (the refusal of WINDOWS 165 needs the outlet belt to have
 *  exactly one free slot when the Factory steps, which only a loaded outlet gives). */
const BURST = 24;
/** The core's numbers, transcribed: `SLOTS_PER_TILE` and the belt's default `ticks_per_slot`. */
const SLOTS_PER_TILE = 4;
const TICKS_PER_SLOT = 2;
/** Ticks the board takes at most to empty: the Factory makes two items per input and the
 *  outlet carries them at most one a slot step, so the 2 x BURST items leave within
 *  2 x BURST x TICKS_PER_SLOT ticks, plus both belts' traversals, doubled for the POSTs' own
 *  round trips. */
const DRAIN_TICKS = 2 * (2 * BURST * TICKS_PER_SLOT + (INLET.length + OUTLET.length) * SLOTS_PER_TILE * TICKS_PER_SLOT);
/** How many times slower than `FLOOR_TPS` a board may tick and still be graded (plan 87-03's
 *  CPU-quota runs measured about 20 ticks a second on a small board, under the floor's 28). */
const SLOW_BOARD = 3;
/** The window is cut into this many equal parts by tick, and the Sink must take items in each. */
const QUARTERS = 4;
/** Pixels around the Factory's box the fault probe reads: the alert ring sits a few px outside
 *  the box edge (`ALERT_RING_OUTSET_U`), so a margin of a third of a cell covers it. */
const RING_MARGIN = Math.round(CELL / 3);

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/** An empty, playing board at camera scale 1, every cell this spec uses on the open canvas
 *  (the `87-balancer-both-inputs` shape). */
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
  const cells: [number, number][] = [SOURCE_AT, FACTORY_AT, [FACTORY_AT[0] + 2, FACTORY_AT[1] + 2], SINK_AT, EMPTY_CELL, ...INLET, ...OUTLET];
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

/** POST one item to the Source's webhook; returns the status. */
async function post(page: Page, url: string, n: number): Promise<number> {
  const resp = await page.request.post(url, { data: { n } });
  return resp.status();
}

/** Pixels in the clip around the Factory's box that read as the fault accent: red well above
 *  green, and blue above green, which the alert ring and a faulted chassis stroke are at every
 *  alpha of their cadence (0.25 to 0.80 over the substrate ramp), and which the grey ramp, the
 *  orange item accent, the green working accent and the blue build accent are not. Returns the
 *  count, read off a real capture. */
async function faultPixelsAroundFactory(page: Page): Promise<{ count: number; clip: { x: number; y: number; width: number; height: number } }> {
  const nw = await screenCellCentre(page, FACTORY_AT[0], FACTORY_AT[1]);
  const se = await screenCellCentre(page, FACTORY_AT[0] + FACTORY_SIZE - 1, FACTORY_AT[1] + FACTORY_SIZE - 1);
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

/** One request the listener received. */
interface CapturedPost {
  path: string;
  body: string;
  idempotencyKey: string;
}

const captured: CapturedPost[] = [];
let listener: Server | null = null;
/** Non-null when the listener could not be bound: the test then fails with this reason. */
let bindFailure: string | null = null;

test.beforeAll(async () => {
  const bound = await new Promise<Server | Error>((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        captured.push({
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    server.once('error', (err: Error) => resolve(err));
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
  });
  if (bound instanceof Error) {
    bindFailure = `could not bind the Sink's listener on 127.0.0.1:${HTTP_PORT} (${bound.message}); free the port and re-run`;
  } else {
    listener = bound;
  }
});

test.afterAll(async () => {
  const server = listener;
  listener = null;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('JAM-05 live: a Factory that emits twice on one port delivers both', () => {
  test('a Webhook Source bursts into a Factory emitting each item twice; the Sink delivers every item twice, the Factory never reads FAULTED, no fault colour is painted on it, and the Sink takes items throughout', async ({
    page,
  }) => {
    expect(bindFailure, 'the Sink\'s off-board listener is bound').toBeNull();
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);

    // (1) The machines, off the palette, and the Factory's JS.
    const src = await place(page, 'Source', KIND_SOURCE, SOURCE_AT);
    const fac = await place(page, 'Factory', KIND_FACTORY, FACTORY_AT);
    const sink = await place(page, 'Sink', KIND_SINK, SINK_AT);
    await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
    await typeFactorySource(page, TWO_EMITS_JS);
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await selectMachineAt(page, SINK_AT[0], SINK_AT[1]);
    await pressSegment(page, 'Target', 'HTTP');
    await fillPanelField(page, 'fab-sink-http-url', HTTP_URL);
    await pressSegment(page, 'Method', 'POST');
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    const facIn = fac.ports.find((p) => p.role === ROLE_IN)!;
    const facOut = fac.ports.find((p) => p.role === ROLE_OUT)!;
    expect([facIn.cell_x, facIn.cell_y], 'the Factory In sits on its west middle row').toEqual([FACTORY_AT[0], FACTORY_AT[1] + 1]);
    expect([facOut.cell_x, facOut.cell_y], 'the Factory Out sits on its east middle row').toEqual([FACTORY_AT[0] + 2, FACTORY_AT[1] + 1]);
    const outOf = (n: NodeFacts) => n.ports.find((p) => p.role === ROLE_OUT)!;
    const inOf = (n: NodeFacts) => n.ports.find((p) => p.role === ROLE_IN)!;
    await expectRenderLoopAlive(page, 'after the machines are placed and the JS applied');

    // (2) The belts, each graded on its docks. The fault port stays undocked.
    const inlet = await belt(page, src, outOf(src), INLET, fac, facIn, 'the inlet');
    const outlet = await belt(page, fac, facOut, OUTLET, sink, inOf(sink), 'the outlet');
    expect(
      dockSet(beltAt(await readScene(page), OUTLET[0])),
      'NON-VACUITY: nothing but the outlet docks the Factory on its Out side; its fault port is free',
    ).toHaveLength(2);
    await expectRenderLoopAlive(page, 'after the belts are drawn');

    // (3) The burst, each a real POST to the Source's own URL.
    const url = await webhookUrl(page, src.id);
    expect(url, 'the Source answers on its own loopback /hook/src-<id> URL').toMatch(/\/hook\/src-\d+$/);
    await startTickRecorder(page);
    await startBeltFlowWatch(page);
    const capturedBefore = captured.length;
    const statuses: number[] = [];
    for (let k = 0; k < BURST; k += 1) statuses.push(await post(page, url!, k));
    expect(statuses, `every one of the ${BURST} POSTs is answered 200`).toEqual(Array(BURST).fill(200));

    // (4) The inlet empties and the outlet drains within the derived budget.
    const drainMs = addWaitBudget(
      tickBudgetMs(SLOW_BOARD * DRAIN_TICKS),
      `the Factory turns ${BURST} items into ${2 * BURST} and the outlet carries them to the Sink`,
    );
    await pollScene(page, (s) => [beltAt(s, INLET[0])?.items ?? -1, beltAt(s, OUTLET[0])?.items ?? -1], {
      timeout: drainMs,
      message: `JAM-05: the inlet empties and the outlet drains within ${DRAIN_TICKS} ticks of the burst`,
    }).toEqual([0, 0]);

    const rec = await readTickRecorder(page);
    const flow = await readBeltFlowWatch(page);
    const stateOf = (r: (typeof rec.records)[number], id: number) => r.nodes.find((n) => n[0] === id)?.[2] ?? -1;
    const outletItems = (r: (typeof rec.records)[number]) => r.belts.find((b) => b[0] === outlet)?.[2].length ?? 0;
    const faultedTicks = rec.records.filter((r) => stateOf(r, fac.id) === FAULTED).map((r) => r.t);
    const carrying = rec.records.filter((r) => outletItems(r) > 0);
    // (5) What arrived. The outlet has drained, so every item has left the Sink's inbox; the
    // last dispatches may still be in flight, so the count of distinct keys is polled up to the
    // expected total, and the exact counts below then catch a surplus as well as a shortfall.
    const want = 2 * BURST;
    const deliveries = () => captured.slice(capturedBefore).filter((c) => c.path === HTTP_PATH);
    await expect
      .poll(() => new Set(deliveries().map((c) => c.idempotencyKey)).size, {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * DRAIN_TICKS), `the ${want} dispatches reach the listener`),
        message: `JAM-05: the Sink's listener receives ${want} distinct dispatches`,
      })
      .toBeGreaterThanOrEqual(want);
    const got = deliveries();
    const keys = new Set(got.map((c) => c.idempotencyKey));
    const perN = new Map<number, number>();
    for (const c of got) {
      const m = /"n"\s*:\s*(\d+)/.exec(c.body);
      const n = m ? Number(m[1]) : -1;
      perN.set(n, (perN.get(n) ?? 0) + 1);
    }
    const notTwice = Array.from({ length: BURST }, (_, k) => k).filter((k) => perN.get(k) !== 2);
    // The tick the Sink took each item, read off its dispatch's Idempotency-Key
    // (`fabrico-cmd-<tick>-<node>-<seq>`, the host's `command_id_string`): exact for every
    // item, where the tick recorder only samples, and under the CPU quota it records fewer than
    // a third of the ticks (87-REVIEW-FIX.md). The window opens at the first take and closes at
    // the later of the last take and the last recorded tick the outlet was carrying, so a
    // quarter with nothing taken is a stall in the middle of the flow or an outlet left holding
    // items the Sink never took.
    const takeTicks = got
      .map((c) => /^fabrico-cmd-(\d+)-/.exec(c.idempotencyKey))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    const t0 = takeTicks.length > 0 ? Math.min(...takeTicks) : 0;
    const t1 = Math.max(takeTicks.length > 0 ? Math.max(...takeTicks) : 0, carrying.length > 0 ? carrying[carrying.length - 1].t : 0);
    const span = Math.max(1, t1 - t0 + 1);
    const quarterOf = (lo: number, hi: number, ticks: number[]) => ticks.filter((t) => t >= lo && t < hi).length;
    const bounds = Array.from({ length: QUARTERS }, (_, q) => [
      t0 + Math.floor((q * span) / QUARTERS),
      q === QUARTERS - 1 ? t1 + 1 : t0 + Math.floor(((q + 1) * span) / QUARTERS),
    ]);
    const sinkTookPerQuarter = bounds.map(([lo, hi]) => quarterOf(lo, hi, takeTicks));
    // The sampled reading the spec graded before the review, kept as a fact only.
    const workingRecords = rec.records.filter((r) => stateOf(r, sink.id) === WORKING).map((r) => r.t);
    const workingRecordsPerQuarter = bounds.map(([lo, hi]) => quarterOf(lo, hi, workingRecords));

    const pixels = await faultPixelsAroundFactory(page);
    const facNow = nodeAtAnchor(await readScene(page), FACTORY_AT[0], FACTORY_AT[1]);
    const facts = {
      records: rec.records.length,
      missed: rec.missed,
      faultedTicks: faultedTicks.length,
      firstFaulted: faultedTicks[0] ?? null,
      window: [t0, t1],
      outletFirstCarried: carrying[0]?.t ?? null,
      sinkTookPerQuarter,
      workingRecordsPerQuarter,
      takeTicksRead: takeTicks.length,
      inletCarried: flow.carried.includes(inlet),
      outletCarried: flow.carried.includes(outlet),
      outletDrained: flow.drained.includes(outlet),
      faultPixels: pixels.count,
      factoryStateNow: facNow?.state ?? null,
      delivered: got.length,
      distinctKeys: keys.size,
      numbersNotTwice: notTwice,
      firstBody: got[0]?.body ?? null,
    };
    console.log(`JAM05_LIVE ${JSON.stringify(facts)}`);

    expect(facts.records, 'NON-VACUITY: the tick recorder took records').toBeGreaterThan(0);
    expect(keys.has(''), 'every dispatch carried its Idempotency-Key').toBe(false);
    expect(got.length, `JAM-05: the Sink delivered exactly ${want} items, two for each of the ${BURST} posted`).toBe(want);
    expect(keys.size, `JAM-05: the ${want} deliveries are ${want} distinct dispatches, none a retry`).toBe(want);
    expect(notTwice, `JAM-05: every posted number arrives exactly twice (first body ${JSON.stringify(facts.firstBody)})`).toEqual([]);
    expect(takeTicks.length, 'every dispatch key names the tick the Sink took its item').toBe(want);
    expect(facts.inletCarried, 'NON-VACUITY: the inlet carried items into the Factory').toBe(true);
    expect(facts.outletCarried, 'JAM-05: the outlet belt carried items').toBe(true);
    expect(facts.outletDrained, 'JAM-05: the outlet belt drained into the Sink').toBe(true);
    expect(
      faultedTicks,
      'JAM-05: the Factory never reads FAULTED on any recorded tick (before plan 87-04 a refused second emit rested on its fault port and painted it FAULTED)',
    ).toEqual([]);
    expect(facts.factoryStateNow, 'JAM-05: the Factory is not FAULTED on the model at the end').not.toBe(FAULTED);
    expect(pixels.count, `JAM-05: no fault colour is painted on or around the Factory at the end (clip ${JSON.stringify(pixels.clip)})`).toBe(0);
    for (let q = 0; q < QUARTERS; q += 1) {
      expect(
        sinkTookPerQuarter[q],
        `JAM-05: the Sink took items in quarter ${q + 1} of the ${span}-tick window from its first take to its last (${JSON.stringify(sinkTookPerQuarter)})`,
      ).toBeGreaterThan(0);
    }

    await expectRenderLoopAlive(page, 'with the burst delivered');
    errs.assertNone('while the two-emit Factory ran');
  });
});
