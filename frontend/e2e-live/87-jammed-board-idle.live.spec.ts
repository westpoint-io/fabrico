import { existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  armAndPlaceAt,
  backedUpMarkPaintedOn,
  cameraOf,
  DRAWN_STATE_FRAMES,
  drawBeltThroughCells,
  applyConfig,
  deselectViaEmptyCell,
  drawOffloadBelt,
  expectRenderLoopAlive,
  fillPanelField,
  loadGaugeFormOn,
  newBoard,
  nodeAtAnchor,
  pollScene,
  pressSegment,
  readScene,
  readTickRecorder,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  selectMachineAt,
  startTickRecorder,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { PORT_STATUS } from '../src/chrome/configCopy';

// 87-jammed-board-idle.live.spec.ts (plan 87-06, JAM-04, WINDOWS 177, D-06, D-12, phase 87
// success criterion 3, the machine half) - a board jammed solid sits still, the machine stuck
// behind its output wears the jam mark, and one edit releases it. On the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: every machine comes off the palette, every belt is drawn with the Belt tool, the
// items arrive as real webhook POSTs and the release is a real Delete.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-06: a machine whose outputs are blocked stops scheduling itself every tick. It sleeps until
// something it feeds frees a slot, a delivery reaches it or an edit is made, and the code that
// frees the slot wakes it. Before plan 87-06 the gate re-scheduled every blocked machine at the
// next tick forever (WINDOWS 177, P177B: 2.00 machine steps per tick on a board that cannot move).
// A sleeping machine is no longer in the tick's stepped set, so the host reads one that waits
// behind its blocked output holding work as BACKED_UP (state 3), the jam mark the board already
// draws (the dimmed outline, the gauge at its inbox's own level), never IDLE: a jammed board must
// not look empty. Before plan 87-06 the spinning Tee read WORKING (state 1) on every tick, so the
// board looked busy while nothing moved.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. On an empty board at zoom 1: a palette Source at (9,8) on its default Webhook trigger and
//      a palette Tee (2 by 2) at (14,8). A belt from the Source's Out into the Tee's In, and from
//      each Tee Out a three-tile belt through empty cells released on plain floor, so neither
//      branch head docks anywhere. Every belt is graded on its dock set.
//   2. The branch belts' slot counts are read off the scene and the Source is sent, one POST at a
//      time and at most 30 a second, exactly the items that fill both branches (their slots and
//      their staging inboxes) and leave eight in the Tee's inbox. The Tee copies every item it
//      takes to both branches, so it takes one branch's worth and then holds the rest. The inlet
//      holds nothing once it settles: the Tee's eight are the whole backlog, and they are what the
//      release must drain.
//   3. Once the board stops changing (derived budgets), 300 ticks are recorded. Graded on every
//      record: every belt's occupied slots identical to the first record's, the Tee reads
//      BACKED_UP and its gauge is drawn, and no machine reads WORKING. Then on the canvas: the
//      Tee's backed-up mark is painted and its gauge is drawn and NOT merged (eight of sixteen is
//      not a full inbox, so the bar must not claim one).
//   4. The release, an edit: the Tee is selected, and (phase 91, plan 91-07, CHROME-13, D-12)
//      both its Out rows read `Output - Item, backed up`: each branch's head slot holds an item
//      and its head docks nowhere. At PHASE91_START they read `12 moving`, an item count on belts
//      where nothing moves (91-EVIDENCE.md, `D17 case=CHROME-13-ports-live`). Then both branch
//      belts are disconnected from the Tee through the Tee
//      panel's two "Disconnect Output - Item" controls (one `Unlink` each). The Tee then has no
//      docked branch and is never gated. Graded: each click removed exactly that branch's Tail
//      dock, the inlet holds nothing, the Tee's gauge clears (its inbox drained) and the Tee reads
//      off BACKED_UP. THE RELEASE USED: the Disconnect. The plan named "delete both branch belts"
//      first, but the app offers no belt delete (a keyboard Delete on a selected belt is a no-op,
//      `gestures.ts` "NODE selections only", and the belt panel carries no delete control), and
//      a Disconnect is the edit D-06 names first.
//
// LEG 2 (plan 87-07, JAM-04, D-06, D-12, criterion 3 on a Timer-fed board): THE SAVE STOPS
// GROWING. A board jammed solid must also stop growing its save, and a save is the event log as
// well as the state. On an empty board a palette Source is set to Timer, Every 2, through its
// panel, and a three-tile belt from its Out is released on plain floor, so its Head docks
// nowhere. The belt packs, the belt's staging inbox fills, the Source's backlog reaches its cap
// and the board stops changing. It is saved through the toolbar Save (the dev path's prompt),
// played on for at least 1200 more ticks, and saved again through Shift+Save (Save As) to a
// second path, both saves inside one varint band (ticks 128 to 16383, so the tick fields have
// the same width). Graded: the two files on disk are the same size. A save on a board with items
// on its belts drains for the settle budget (512 ticks) and leaves the sim frozen, so the spec
// presses Pause then Play to run it on.
//
// RED ON PLAN 87-06'S HOST, recorded in 87-EVIDENCE.md: the host logged one
// refused timer fire every two ticks into the Source at its cap, so the second save was longer
// by every fire between the two. Plan 87-07's host skips a fire the Source would refuse
// (`TimerSet::due_events` asks the core's `source_accepts_one`), so nothing is logged between
// the saves. The core half (no node steps, two snapshots differing in the tick alone) is
// `a_board_jammed_solid_goes_idle` in `fabrico-core`; this leg grades the file the user keeps.
//
// Render health in the test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after the
// gestures and at the end, and the watcher's `assertNone`.
//
// RED ON PLAN 87-05'S HOST, recorded in 87-EVIDENCE.md: the spinning Tee
// reads WORKING on every record. RED ON THIS PLAN'S HOST WITH THE WAITING ARM REMOVED from
// `derive_state`: the sleeping Tee reads IDLE and the jammed board looks empty.

/** Kind bytes (protocol `machine_kind`), transcribed: the live suite imports no product source. */
const KIND_SOURCE = 0;
const KIND_TEE = 3;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** State bytes (`fabrico-protocol` `state_tag`). */
const WORKING = 1;
const BACKED_UP = 3;

/** Where everything sits. The Tee is 2 by 2: In on its west column's upper row, both Outs on
 *  its east column (the palette catalog). */
const SOURCE_AT: [number, number] = [9, 8];
const TEE_AT: [number, number] = [14, 8];
/** An empty cell clear of every machine and belt here. */
const EMPTY_CELL: [number, number] = [12, 13];
/** The inlet belt, Source doorstep to the Tee In's facing cell. */
const INLET: [number, number][] = [
  [10, 8],
  [11, 8],
  [12, 8],
  [13, 8],
];
/** The two branch belts, from each Tee Out doorstep through empty cells, heads on plain floor. */
const UPPER: [number, number][] = [
  [16, 8],
  [17, 8],
  [18, 8],
];
const LOWER: [number, number][] = [
  [16, 9],
  [17, 9],
  [18, 9],
];

/** The core's numbers, transcribed: `SLOTS_PER_TILE` and `MECHANICAL_INBOX_CAP` (a belt's
 *  staging inbox and a machine's inbox). */
const SLOTS_PER_TILE = 4;
const INBOX_CAP = 16;
/** Items left resting in the Tee's inbox: half the cap, so the gauge is drawn and not merged. */
const TEE_HOLDS = 8;
/** POSTs at most this many a second, one at a time. */
const MAX_POSTS_PER_SECOND = 30;
/** The recorded window, in sim ticks. */
const WINDOW = 300;
/** Ticks the board must read unchanged before the window opens (two branch belts' worth of slot
 *  steps at the default pace is far less). */
const STILL_TICKS = 60;
/** How many times slower than `FLOOR_TPS` a board may tick and still be graded (plan 87-03's
 *  CPU-quota runs measured about 20 ticks a second on a small board, under the floor's 28). */
const SLOW_BOARD = 3;

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/** An empty, playing board at camera scale 1, every cell this spec uses on the open canvas
 *  (the `87-tee-slow-branch` shape). */
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
    EMPTY_CELL,
    ...INLET,
    ...UPPER,
    ...LOWER,
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

/** Leg 2: the Timer interval the Source is set to, in sim ticks. */
const FEED_EVERY = 2;
/** Leg 2: the belt from the Source's Out (three tiles, Head on plain floor): the inlet's first
 *  three cells, which leg 1 already proves are the Source Out's doorstep and open canvas. */
const DEAD_END = INLET.slice(0, 3);
/** Leg 2: the core's `SOURCE_PENDING_CAP`, transcribed. */
const PENDING_CAP = 16;
/** Leg 2: the fewest ticks between the two saves. */
const SAVE_GAP_TICKS = 1200;
/** Leg 2: one postcard varint band. A tick from 128 to 16383 encodes in two bytes, so two saves
 *  whose ticks both sit in it carry tick fields of the same width (87-RESEARCH Pitfall 2). */
const VARINT_BAND: [number, number] = [128, 16384];
/** Leg 2: the host's drain-to-quiescence settle budget (`sim_loop::MAX_SETTLE_TICKS`),
 *  transcribed. A save on a board still holding belt items drains this long, then saves. */
const MAX_SETTLE_TICKS = 512;

/** Save through the toolbar to `path` (`saveAs` = Shift+click, the Save As prompt), wait for
 *  the host to write the file and for its size to hold, and return the size and the tick the
 *  frozen sim reads after the save. */
async function saveTo(page: Page, path: string, saveAs: boolean): Promise<{ bytes: number; tick: number }> {
  page.once('dialog', (d) => d.accept(path));
  await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click(saveAs ? { modifiers: ['Shift'] } : undefined);
  const writeMs = addWaitBudget(
    tickBudgetMs(SLOW_BOARD * (MAX_SETTLE_TICKS + 64)),
    'the host drains to its settle budget and writes the .fab',
  );
  await expect
    .poll(() => existsSync(path), {
      timeout: writeMs,
      intervals: [200, 500, 1000],
      message: `the host wrote the .fab at ${path} (a real save artifact on disk)`,
    })
    .toBe(true);
  let last = -1;
  await expect
    .poll(
      () => {
        const now = statSync(path).size;
        const held = now > 0 && now === last;
        last = now;
        return held;
      },
      { timeout: 10_000, intervals: [300], message: 'the written .fab holds its size across two reads' },
    )
    .toBe(true);
  return { bytes: statSync(path).size, tick: (await readScene(page)).tick };
}

/** Run the sim on after a latched save left it frozen: the toolbar still reads Pause (it sends
 *  no state back), so Pause is pressed first if shown, then Play, and the ticks must advance. */
async function playOn(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: /^(Play|Pause)$/ });
  if ((await btn.getAttribute('aria-label')) === 'Pause') {
    await btn.click();
    await expect(btn, 'the toolbar reads Play once paused').toHaveAttribute('aria-label', 'Play');
  }
  await btn.click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0 + 10, {
    timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * 40), 'the sim runs again after the save'),
    message: 'the board plays on after the save',
  }).toBe(true);
}

/** The Tee panel's Disconnect control on a docked Output row (`PortsSection.tsx` composes
 *  `Disconnect ${portRowLabel(port)}`; both Tee Outs are mechanical Item outputs, so the two
 *  controls share this name and are told apart by which dock each click removes). */
const DISCONNECT_OUTPUT = 'Disconnect Output - Item';

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('JAM-04 live: a board jammed solid sits still, the stuck machine wears the jam mark, and an edit releases it', () => {
  test('a Tee holding eight behind two full branch belts reads BACKED_UP with a part-full gauge while nothing moves and no machine reads WORKING; deleting both branches drains it', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);

    // (1) The machines, off the palette, and the belts, each graded on its docks.
    const src = await place(page, 'Source', KIND_SOURCE, SOURCE_AT);
    const tee = await place(page, 'Tee', KIND_TEE, TEE_AT);
    const srcOut = src.ports.find((p) => p.role === ROLE_OUT)!;
    const teeIn = tee.ports.find((p) => p.role === ROLE_IN)!;
    const teeOuts = tee.ports.filter((p) => p.role === ROLE_OUT).sort((a, b) => a.cell_y - b.cell_y);
    expect(
      teeOuts.map((p) => [p.cell_x, p.cell_y]),
      'NON-VACUITY: the placed Tee declares two Outs, on its east column',
    ).toEqual([
      [TEE_AT[0] + 1, TEE_AT[1]],
      [TEE_AT[0] + 1, TEE_AT[1] + 1],
    ]);
    await expectRenderLoopAlive(page, 'after the machines are placed');

    await drawBeltThroughCells(page, srcOut, INLET, teeIn);
    const inletWant = [`Head@${tee.id}:${linkKey(tee, teeIn)}`, `Tail@${src.id}:${linkKey(src, srcOut)}`].sort();
    await pollScene(page, (s) => dockSet(beltAt(s, INLET[0])), {
      message: "the inlet docks its Tail on the Source's Out and its Head on the Tee's In",
    }).toEqual(inletWant);
    const branches: { cells: [number, number][]; port: PortFacts; what: string }[] = [
      { cells: UPPER, port: teeOuts[0], what: 'the upper branch' },
      { cells: LOWER, port: teeOuts[1], what: 'the lower branch' },
    ];
    for (const b of branches) {
      await drawOffloadBelt(page, b.port, b.cells);
      await pollScene(page, (s) => dockSet(beltAt(s, b.cells[0])), {
        message: `${b.what}: its Tail docks the Tee's Out key ${linkKey(tee, b.port)} and its Head nowhere`,
      }).toEqual([`Tail@${tee.id}:${linkKey(tee, b.port)}`]);
    }
    const scene0 = await readScene(page);
    const inletId = beltAt(scene0, INLET[0])!.id;
    const branchIds = branches.map((b) => beltAt(scene0, b.cells[0])!.id);
    await expectRenderLoopAlive(page, 'after the belts are drawn');

    // (2) The items, one POST at a time. Each branch takes its slots plus its staging inbox;
    // the Tee copies every item to both, so it takes one branch's worth and then holds TEE_HOLDS.
    const url = await webhookUrl(page, src.id);
    expect(url, 'the palette Source resolves to its own loopback /hook/src-<id> POST URL').toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/,
    );
    const branchSlots = branchIds.map((id) => scene0.belts.find((b) => b.id === id)!.tiles.length * SLOTS_PER_TILE);
    expect(branchSlots[0], 'NON-VACUITY: both branches are the same length, so they fill together').toBe(branchSlots[1]);
    const perBranch = branchSlots[0] + INBOX_CAP;
    const items = perBranch + TEE_HOLDS;
    for (let k = 0; k < items; k += 1) {
      const t0 = Date.now();
      const resp = await page.request.post(url!, {
        data: JSON.stringify({ n: k }),
        headers: { 'content-type': 'application/json' },
        failOnStatusCode: false,
        timeout: 10_000,
      });
      expect(resp.status(), `POST ${k + 1} of ${items} was accepted`).toBeLessThan(400);
      const wait = 1000 / MAX_POSTS_PER_SECOND - (Date.now() - t0);
      if (wait > 0) await page.waitForTimeout(wait);
    }

    // (3) The board settles: both branches packed, the inlet empty, the Tee BACKED_UP, and then
    // nothing changes for STILL_TICKS ticks.
    const pace = scene0.belts.find((b) => b.id === inletId)!.ticksPerSlot;
    const settleTicks = 2 * pace * (items + (INLET.length + UPPER.length) * SLOTS_PER_TILE);
    const settleMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * settleTicks), `the ${items} items travel and pack both branches`);
    const teeState = (s: SceneFacts) => s.nodes.find((n) => n.id === tee.id)?.state ?? -1;
    await pollScene(
      page,
      (s) => ({
        branches: branchIds.map((id) => s.belts.find((b) => b.id === id)?.items ?? -1),
        inlet: s.belts.find((b) => b.id === inletId)?.items ?? -1,
        tee: teeState(s),
      }),
      {
        timeout: settleMs,
        message: `both branches pack (${branchSlots[0]} items each), the inlet empties and the Tee reads BACKED_UP (${BACKED_UP})`,
      },
    ).toEqual({ branches: branchSlots, inlet: 0, tee: BACKED_UP });
    const slotsKey = (s: SceneFacts) => JSON.stringify(s.belts.map((b) => [b.id, b.occupiedSlots]));
    let stillFrom = (await readScene(page)).tick;
    let stillKey = slotsKey(await readScene(page));
    const stillMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * 4 * STILL_TICKS), `${STILL_TICKS} unchanged ticks`);
    await pollScene(
      page,
      (s) => {
        const key = slotsKey(s);
        if (key !== stillKey) {
          stillKey = key;
          stillFrom = s.tick;
        }
        return s.tick - stillFrom >= STILL_TICKS;
      },
      { timeout: stillMs, message: `the board reads unchanged for ${STILL_TICKS} ticks` },
    ).toBe(true);

    await startTickRecorder(page, { gaugeOf: [tee.id] });
    const tStart = (await readScene(page)).tick;
    const windowMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * WINDOW), `the ${WINDOW}-tick recorded window`);
    await pollScene(page, (s) => s.tick >= tStart + WINDOW, {
      timeout: windowMs,
      message: `the board runs ${WINDOW} ticks past tick ${tStart} while it is recorded`,
    }).toBe(true);
    const rec = await readTickRecorder(page);
    const records = rec.records.filter((r) => r.t >= tStart && r.t < tStart + WINDOW);
    const beltKey = (r: (typeof records)[number]) => JSON.stringify(r.belts.map((b) => [b[0], b[2]]));
    const firstKey = records.length > 0 ? beltKey(records[0]) : '';
    const moved = records.filter((r) => beltKey(r) !== firstKey).map((r) => r.t);
    const teeOff = records.filter((r) => r.nodes.find((n) => n[0] === tee.id)?.[2] !== BACKED_UP).map((r) => r.t);
    const working = records.filter((r) => r.nodes.some((n) => n[2] === WORKING)).map((r) => r.t);
    const gaugeDark = records
      .filter((r) => {
        const form = r.g?.find(([id]) => id === tee.id)?.[1];
        return !form || form.instructions === 0;
      })
      .map((r) => r.t);
    const gaugeMerged = records.filter((r) => r.g?.find(([id]) => id === tee.id)?.[1]?.merged === true).map((r) => r.t);
    const facts = {
      records: records.length,
      missed: rec.missed,
      window: [tStart, tStart + WINDOW],
      items,
      branchSlots,
      moved: moved.length,
      teeOffBackedUp: teeOff.length,
      workingRecords: working.length,
      gaugeDark: gaugeDark.length,
      gaugeMerged: gaugeMerged.length,
    };
    console.log(`JAM04_LIVE ${JSON.stringify(facts)}`);

    expect(facts.records, 'NON-VACUITY: the tick recorder took records across the window').toBeGreaterThan(WINDOW / 4);
    expect(moved, 'JAM-04: nothing moves: every belt holds the same slots on every record').toEqual([]);
    expect(teeOff, `JAM-04: the Tee reads BACKED_UP (${BACKED_UP}) on every record, never IDLE`).toEqual([]);
    expect(working, 'JAM-04: no machine reads WORKING on any record: nothing is busy on a board that cannot move').toEqual([]);
    expect(gaugeDark, "D-12: the Tee's gauge is drawn on every record: it holds items").toEqual([]);
    expect(gaugeMerged, 'D-12: the gauge never claims a full inbox: eight of sixteen is not the merged bar').toEqual([]);

    // The mark on the canvas, read off the Graphics after the window.
    const drawnMs = addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the canvas draws the jammed Tee');
    await expect
      .poll(() => backedUpMarkPaintedOn(page, tee.id), {
        timeout: drawnMs,
        message: "JAM-04 PAINTED: the backed-up mark is drawn on the Tee's own gauge",
      })
      .toBe(true);
    const form = await loadGaugeFormOn(page, tee.id);
    expect(form?.instructions ?? 0, "JAM-04 PAINTED: the Tee's gauge is drawn").toBeGreaterThan(0);
    expect(form?.merged, 'JAM-04 PAINTED: and not as the merged full bar').toBe(false);
    await expectRenderLoopAlive(page, 'with the board jammed solid');

    // (3b) Phase 91 review WR-B-07: the belt panel reads the belt whose items cross each seam,
    // the belt a machine's own port row reads. The upper branch is packed from the Tee to open
    // floor, so its Inputs row (fed by the Tee) is this belt's own state, backed up, and its
    // Outputs row docks nothing. Until the review fix a machine neighbour gave presence only and
    // the Inputs row read idle beside the Tee's backed-up Out row (the 91-11 walk, item 2).
    const upperMid = await screenCellCentre(page, UPPER[1][0], UPPER[1][1]);
    await page.mouse.move(upperMid.x, upperMid.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#fab-belt-config'), "the upper branch's belt panel opened").toBeVisible({ timeout: 15_000 });
    const beltPorts = page.getByRole('region', { name: 'Ports' });
    await expect(
      beltPorts.getByRole('list', { name: 'Inputs' }).getByRole('listitem', { name: `Input - Item, ${PORT_STATUS.backedUp}`, exact: true }),
      `WR-B-07: the packed branch's Inputs row reads "Input - Item, ${PORT_STATUS.backedUp}", as the Tee's Out row does`,
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(
      beltPorts.getByRole('list', { name: 'Outputs' }).getByRole('listitem', { name: `Output - Item, ${PORT_STATUS.notConnected}`, exact: true }),
      "WR-B-07: the branch's head docks nothing, so its Outputs row reads not connected",
    ).toHaveCount(1);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // (4) The release, an edit: both branches disconnected from the Tee through its panel.
    await selectMachineAt(page, TEE_AT[0], TEE_AT[1]);
    const portsRegion = page.getByRole('region', { name: 'Ports' });
    await expect(portsRegion, "the Tee's panel carries the Ports region the Disconnect control lives in").toBeVisible();
    // CHROME-13 (phase 91, D-12, UI-SPEC 8.5): the jammed Tee's two Out rows say what their belts
    // are doing, in words: backed up, not an item count.
    const backedUpRows = portsRegion
      .getByRole('list', { name: 'Outputs' })
      .getByRole('listitem', { name: `Output - Item, ${PORT_STATUS.backedUp}`, exact: true });
    await expect(
      backedUpRows,
      `CHROME-13: both of the jammed Tee's Out rows read "Output - Item, ${PORT_STATUS.backedUp}" (each branch's head slot holds an item and its head docks nowhere)`,
    ).toHaveCount(2, { timeout: 10_000 });
    await expect(
      portsRegion.getByRole('listitem', { name: /\d\s*moving/ }),
      'CHROME-13: no row of the Tee panel shows an item count',
    ).toHaveCount(0);
    const tailsOnTee = (s: SceneFacts) =>
      branchIds.filter((id) => (s.belts.find((b) => b.id === id)?.docks ?? []).some((d) => d.end === 'Tail' && d.node === tee.id));
    for (let k = 2; k >= 1; k -= 1) {
      const controls = portsRegion.getByRole('button', { name: DISCONNECT_OUTPUT });
      await expect(controls, `the panel offers ${k} "${DISCONNECT_OUTPUT}" control(s), one per docked branch`).toHaveCount(k);
      await controls.first().click();
      await pollScene(page, (s) => tailsOnTee(s).length, {
        message: `one click of Disconnect removed exactly one branch's Tail dock on the Tee (${k - 1} left)`,
      }).toBe(k - 1);
    }
    const released = await readScene(page);
    expect(
      branchIds.map((id) => dockSet(released.belts.find((b) => b.id === id))),
      'each branch belt is still on the board, docked nowhere now',
    ).toEqual([[], []]);
    const releaseMs = addWaitBudget(tickBudgetMs(SLOW_BOARD * 4 * INBOX_CAP), 'the Tee drains its inbox to undocked Outs');
    await expect
      .poll(
        async () => {
          const s = await readScene(page);
          const g = await loadGaugeFormOn(page, tee.id);
          return {
            inlet: s.belts.find((b) => b.id === inletId)?.items ?? -1,
            gaugeDrawn: (g?.instructions ?? 0) > 0,
            teeBackedUp: teeState(s) === BACKED_UP,
          };
        },
        {
          timeout: releaseMs,
          message: 'JAM-04 RELEASED: the inlet holds nothing, the Tee drains its inbox (its gauge clears) and reads off BACKED_UP',
        },
      )
      .toEqual({ inlet: 0, gaugeDrawn: false, teeBackedUp: false });

    await expectRenderLoopAlive(page, 'after the release');
    errs.assertNone('while the board jammed and was released');
  });

  test('leg 2: a Timer Source behind a belt docked nowhere, left until it stops changing, saves twice at least 1200 ticks apart to two files of the same size', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const stamp = Date.now();
    const fabA = join(tmpdir(), `fabrico-e2e-87-jammed-a-${stamp}.fab`);
    const fabB = join(tmpdir(), `fabrico-e2e-87-jammed-b-${stamp}.fab`);
    await emptyBoardAtScaleOne(page);

    // (1) The Source, and its belt to nowhere, graded on its docks.
    const src = await place(page, 'Source', KIND_SOURCE, SOURCE_AT);
    const srcOut = src.ports.find((p) => p.role === ROLE_OUT)!;
    await drawOffloadBelt(page, srcOut, DEAD_END);
    await pollScene(page, (s) => dockSet(beltAt(s, DEAD_END[0])), {
      message: "the belt from the Source's Out docks its Tail there and its Head nowhere",
    }).toEqual([`Tail@${src.id}:${linkKey(src, srcOut)}`]);
    const beltId = beltAt(await readScene(page), DEAD_END[0])!.id;
    await expectRenderLoopAlive(page, 'after the Source and its belt are drawn');

    // (2) Timer, Every 2, applied through the panel: the host's own clock feeds the Source.
    await selectMachineAt(page, SOURCE_AT[0], SOURCE_AT[1]);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', String(FEED_EVERY));
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // (3) The board jams solid and stops changing: the belt packed, the Source at its cap
    // (BACKED_UP), then no slot changes for STILL_TICKS ticks.
    const scene1 = await readScene(page);
    const slots = DEAD_END.length * SLOTS_PER_TILE;
    const pace = scene1.belts.find((b) => b.id === beltId)!.ticksPerSlot;
    const fillTicks = 2 * FEED_EVERY * (slots + INBOX_CAP + PENDING_CAP) + 2 * pace * slots;
    const sourceState = (s: SceneFacts) => s.nodes.find((n) => n.id === src.id)?.state ?? -1;
    await pollScene(
      page,
      (s) => ({ items: s.belts.find((b) => b.id === beltId)?.items ?? -1, source: sourceState(s) }),
      {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * fillTicks), 'the Timer fills the belt, its staging inbox and the backlog'),
        message: `the belt packs (${slots} items) and the Source reads BACKED_UP (${BACKED_UP}) at its cap`,
      },
    ).toEqual({ items: slots, source: BACKED_UP });
    const slotsKey = (s: SceneFacts) => JSON.stringify(s.belts.map((b) => [b.id, b.occupiedSlots]));
    let stillFrom = (await readScene(page)).tick;
    let stillKey = slotsKey(await readScene(page));
    await pollScene(
      page,
      (s) => {
        const key = slotsKey(s);
        if (key !== stillKey) {
          stillKey = key;
          stillFrom = s.tick;
        }
        return s.tick - stillFrom >= STILL_TICKS;
      },
      {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * 4 * STILL_TICKS), `${STILL_TICKS} unchanged ticks`),
        message: `the board reads unchanged for ${STILL_TICKS} ticks`,
      },
    ).toBe(true);
    await expectRenderLoopAlive(page, 'with the Timer board jammed solid');

    // (4) Save, run on, Save As: two files on disk, at least SAVE_GAP_TICKS apart, one band.
    const a = await saveTo(page, fabA, false);
    await playOn(page);
    await pollScene(page, (s) => s.tick >= a.tick + SAVE_GAP_TICKS, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SAVE_GAP_TICKS), `${SAVE_GAP_TICKS} ticks between the saves`),
      message: `the board runs ${SAVE_GAP_TICKS} ticks past the first save (tick ${a.tick})`,
    }).toBe(true);
    const b = await saveTo(page, fabB, true);
    const facts = { saveA: a, saveB: b, gap: b.tick - a.tick, band: VARINT_BAND };
    console.log(`JAM04_SAVES ${JSON.stringify(facts)}`);
    await playOn(page);

    expect(a.tick, 'the first save sits inside the varint band').toBeGreaterThanOrEqual(VARINT_BAND[0]);
    expect(b.tick, 'the second save sits inside the same band').toBeLessThan(VARINT_BAND[1]);
    expect(facts.gap, `the saves are at least ${SAVE_GAP_TICKS} ticks apart`).toBeGreaterThanOrEqual(SAVE_GAP_TICKS);
    expect(
      b.bytes,
      `JAM-04: a board jammed solid stops growing its save: the file at tick ${b.tick} is the size of the file at tick ${a.tick}`,
    ).toBe(a.bytes);

    for (const f of [fabA, fabB]) if (existsSync(f)) unlinkSync(f);
    await expectRenderLoopAlive(page, 'after the two saves');
    errs.assertNone('while the Timer board jammed and was saved twice');
  });
});
