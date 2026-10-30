import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  DEMO_NODE_COUNT,
  DRAWN_STATE_FRAMES,
  alertRingCentres,
  alertRingInstructions,
  armAndPlaceAt,
  armAndPlaceFactoryAt,
  cameraOf,
  cellCentre,
  clickAt,
  expectRenderLoopAlive,
  handDragBetween,
  loadDemoViaExamples,
  nubAnchor,
  pollScene,
  readScene,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CMD, installFrameSniffer, pauseAndSettle, resumeIfPaused, sentCount } from './support/beltBoard';
import { PORT_STATUS } from '../src/chrome/configCopy';

// 89-turn-back-reconnects.live.spec.ts (phase 89, BELT-07, FAIL-06, success criterion 3) - a
// docked machine turned away and back, or the turn undone, leaves its belt connected, on the
// REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero
// injected packets: the turn is the shipped `r` key on a selected machine, the undo the shipped
// Ctrl+Z.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE HOLDS NOW, AND WHAT COMES LATER
// ---------------------------------------------------------------------------
//
// Leg 1 is the UNDO half of BELT-07, which phase 67 plan 67-03 already fixed (CONNECT-03: the
// undo of a severing Rotate emits one compensating Dock per link the turn cut). 89-MEASURE.md
// read that half FIXED at the time; plan 89-01 proves it on the board a user opens, graded on
// the scene AND on both panels, and proves the leg can fail (89-EVIDENCE.md, `LIVE_MUT
// 89-turn-back-reconnects verdict=RED by=connect03-harvest-disabled`). Plan 89-02 lands D-08
// (a turn toward a loose belt end docks it, in the turn's own command group) and adds the
// forward legs here: R then Shift+R (and one Ctrl+Z after it), four R, the paused double turn,
// and a Factory docked on all three ports turned away and back. D-08 must keep this leg green:
// its group's inverse carries both the CONNECT-03 compensation and the Unlink of the docks the
// turn made. Legs 2 to 5 were each run once against plan 89-02's start revision, host and
// frontend built from it, and read red there (89-EVIDENCE.md, `LIVE_RED
// 89-turn-back-reconnects`). Leg 6 is the review's CR-A-01: on a paused board a belt drawn
// earlier in the same pass is docked by a later turn, as the headless session docks it (red before
// the fix).
//
// D-10, GRADED ON WHAT THE EYE SEES. Right after the severing turn the leg reads the warning
// ring off the overlay's ring Graphics (`alertRingInstructions`, `alertRingCentres`), not the
// paint latch. WINDOWS 141 reported no ring on the real WebKitGTK binary after this exact turn;
// this leg is its Chromium half, measured at `PHASE89_START` (89-EVIDENCE.md, `D01 case=W141`).
// The WebKitGTK half is the phase close's walk (plan 89-10).
//
// THE BOARD. The demo board, loaded as `05-undo-strand-ring.spec.ts` loads it. The Audit Sink
// stands on (14,4) with its In facing West; belt 21 runs (11,4) to (13,4) and its Head is docked
// to that In. Both are found by cell and kind, never by a handle number: the Undo is a keyframe
// that re-mints every handle.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

test.describe.configure({ mode: 'serial' });

/** The Sink's wire kind (kinds.ts). */
const KIND_SINK = 7;
/** The Audit Sink's cell on the demo board (demo_scene.board.ron, node 4). */
const SINK_CELL = [14, 4] as const;
/** Belt 21's cells on the demo board, Tail first (demo_scene.board.ron). */
const BELT_CELLS: ReadonlyArray<readonly [number, number]> = [
  [11, 4],
  [12, 4],
  [13, 4],
];
/** Belt 21's middle tile, where a click selects the belt and nothing else. */
const BELT_MIDDLE = BELT_CELLS[1];
/** Belt 21's Head end tile, where its warning ring is plotted when the Head is cut. */
const HEAD_TILE = BELT_CELLS[2];
/** The side the Sink's In faces at rot 0 (N=0, E=1, S=2, W=3). */
const SIDE_W = 3;
/** Port role keyspace (In=0, Out=1, Fault=2). */
const ROLE_IN = 0;
/** "At" a point: the plot is exact geometry, this only absorbs float noise. */
const AT_PX = 2;
/**
 * A connected port row's status word (`PortsSection.tsx`, phase 91 `PORT_STATUS`): `idle` when
 * something is attached and still, `moving` when items flow on it, `backed up` when its head item
 * cannot leave. A row that reads `not connected` matches none of them.
 */
const connectedRow = (label: string): RegExp =>
  new RegExp(`^${label}, (${PORT_STATUS.idle}|${PORT_STATUS.moving}|${PORT_STATUS.backedUp})$`);

// WINDOWS 141's Chromium reading at `PHASE89_START` (89-EVIDENCE.md, `D01 case=W141`): the first
// read after the turn's echo saw 2 ring instructions, centred on the Head end tile (432, 144) and
// at (464, 127.5). Leg 1 asserts that plot unconditionally (review IN-C-03 removed the constant
// that gated it). The WebKitGTK half is the phase close's walk.

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];
type Pt = { x: number; y: number };

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The Audit Sink, by its cell and kind. */
function auditSink(s: SceneFacts): NodeFacts | undefined {
  return s.nodes.find((n) => n.kind === KIND_SINK && n.cells.some((c) => c[0] === SINK_CELL[0] && c[1] === SINK_CELL[1]));
}

/** Belt 21, by its cells. */
function belt21(s: SceneFacts): BeltFacts | undefined {
  return s.belts.find(
    (b) =>
      b.tiles.length === BELT_CELLS.length &&
      b.tiles.every((t, i) => t.cell_x === BELT_CELLS[i][0] && t.cell_y === BELT_CELLS[i][1]),
  );
}

/** The side the Sink's In faces, or -1 when the Sink or its In is not on the board. */
function sinkInSide(s: SceneFacts): number {
  return auditSink(s)?.ports.find((p) => p.role === ROLE_IN)?.side ?? -1;
}

/** Belt 21's Head dock, as `<node>:<port>` naming the Sink when it is the Sink, else the raw dock. */
function headDock(s: SceneFacts): string {
  const sink = auditSink(s);
  const head = belt21(s)?.docks.filter((d) => d.end === 'Head') ?? [];
  return head.map((d) => (sink !== undefined && d.node === sink.id ? `sink:${d.port}` : `${d.node}:${d.port}`)).join(',');
}

/** Reset to the demo baseline via the SHIPPED Examples menu (genesis swap), as spec 05 does. */
async function loadDemoReset(page: Page): Promise<void> {
  const tickBefore = (await readScene(page)).tick;
  await loadDemoViaExamples(page);
  await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
    message: 'the LoadDemo genesis swap folded onto the demo baseline',
  }).toBe(true);
}

/** Click belt 21's middle tile with a real pointer; the belt panel opening is the proof. */
async function selectBelt21(page: Page): Promise<void> {
  const pt = await screenCellCentre(page, BELT_MIDDLE[0], BELT_MIDDLE[1]);
  await expect
    .poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const), {
      message: "belt 21's middle tile is on the open board, not under a panel, before it is clicked",
    })
    .toBe('CANVAS');
  await clickAt(page, pt.x, pt.y);
  await expect(page.locator('#fab-belt-config'), "clicking belt 21's middle tile selected the belt").toBeVisible();
}

const portsRegion = (page: Page) => page.getByRole('region', { name: 'Ports' });

/** The side the Sink's In faces after one clockwise turn (W + 1 = N). */
const SIDE_N = 0;
/** The FACTORY wire kind (kinds.ts). */
const KIND_FACTORY = 2;
/** The Factory leg's drop cell: the 3x3 box (6..8, 11..13) is clear floor on the demo board. */
const FACTORY_CELL = [6, 11] as const;
/**
 * The Factory's three belts, Tail first, each four cells (D-16), found by these cells. The
 * Factory is drawn against at rot 2 (two quarter turns, before any belt exists), where its Out
 * faces West onto (5,12), its In faces East onto (9,12) and its Fault faces North onto (7,10):
 * every belt then lies in rows the default camera shows (rows below 12 sit under the window's
 * bottom edge at the demo's fit scale).
 */
const OUT_BELT: ReadonlyArray<readonly [number, number]> = [
  [5, 12],
  [4, 12],
  [3, 12],
  [2, 12],
];
const FAULT_BELT: ReadonlyArray<readonly [number, number]> = [
  [7, 10],
  [7, 9],
  [7, 8],
  [7, 7],
];
const IN_BELT: ReadonlyArray<readonly [number, number]> = [
  [12, 12],
  [11, 12],
  [10, 12],
  [9, 12],
];

/** Both panels read belt 21 and the Audit Sink connected, as leg 1 reads them. */
async function expectBothPanelsConnected(page: Page, leg: string): Promise<void> {
  await selectBelt21(page);
  await expect(
    portsRegion(page).getByRole('listitem', { name: connectedRow('Output - Item') }),
    `${leg}: belt 21's panel reads its Head (Output) connected: idle or moving, never not connected`,
  ).toHaveCount(1);
  await expect(
    portsRegion(page).getByRole('listitem', { name: /not connected/ }),
    `${leg}: no row of belt 21's panel reads not connected`,
  ).toHaveCount(0);
  await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
  await expect(
    portsRegion(page).getByRole('listitem', { name: connectedRow('Input - Item') }),
    `${leg}: the Sink's panel reads its In connected: idle or moving, never not connected`,
  ).toHaveCount(1);
}

/** No warning ring is plotted (read off the ring Graphics, D-10), polled to the drawn-state budget. */
async function expectNoRingPlotted(page: Page, why: string): Promise<void> {
  await expect
    .poll(() => alertRingInstructions(page), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), why),
      intervals: [100, 250, 500],
      message: why,
    })
    .toBe(0);
}

/**
 * The warning ring is plotted with a centre on belt 21's Head end tile (D-10, read off the ring
 * Graphics), polled to the drawn-state budget. The NON-VACUITY half of every "no ring after the
 * dock" read below (review WR-C-01): since the TODO-FANIN lifetime rule an edit that joins nothing
 * leaves a ring where it is, so a ring plotted right before the docking turn and gone right after
 * it was cleared by that dock.
 */
async function expectRingOnHead(page: Page, why: string): Promise<void> {
  const headEnd = { x: cellCentre(HEAD_TILE[0]), y: cellCentre(HEAD_TILE[1]) };
  let centres: Pt[] = [];
  await expect
    .poll(
      async () => {
        centres = await alertRingCentres(page);
        return centres.some((c) => dist(c, headEnd) <= AT_PX);
      },
      {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${why}: the ring plot read`),
        intervals: [100, 250, 500],
        message: `${why}: a warning ring centre sits on belt 21's Head end tile ${JSON.stringify(headEnd)}`,
      },
    )
    .toBe(true);
  console.log(`P89-RING-ON-HEAD ${why}: centres=${JSON.stringify(centres)}`);
}

/**
 * The selected machine's floating delete control covers no plotted warning ring (review UI-01):
 * its button box, read off the DOM, against every ring centre read off the ring Graphics and
 * projected to the screen through the camera, with the ring's outer radius (8 plus half its 2 px
 * stroke, world px) scaled. Polled to the drawn-state budget: the control is placed on a frame.
 */
async function expectDeleteControlClearOfRings(page: Page, why: string): Promise<void> {
  let line = '';
  await expect
    .poll(
      async () => {
        const box = await page.locator('.fab-delete-control').boundingBox();
        const cam = await cameraOf(page);
        const rings = await alertRingCentres(page);
        if (box === null) return `no delete control on screen (rings ${JSON.stringify(rings)})`;
        const covered = rings.filter((r) => {
          const sx = r.x * cam.scale + cam.x;
          const sy = r.y * cam.scale + cam.y;
          const dx = Math.max(box.x - sx, 0, sx - (box.x + box.width));
          const dy = Math.max(box.y - sy, 0, sy - (box.y + box.height));
          return Math.hypot(dx, dy) < 9 * cam.scale;
        });
        line = `control ${JSON.stringify(box)} rings ${JSON.stringify(rings)} camera ${JSON.stringify(cam)}`;
        return covered.length === 0 && rings.length > 0 ? 'clear' : `covers ${JSON.stringify(covered)}`;
      },
      {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${why}: the control and ring read`),
        intervals: [100, 250, 500],
        message: `${why}: the floating delete control covers no warning ring (NON-VACUITY: a ring is plotted)`,
      },
    )
    .toBe('clear');
  console.log(`P89-UI01 ${why}: ${line}`);
}

/** Press `key` (`r` or `Shift+R`) on the selected Sink and wait for its In to face `side`. */
async function turnSinkTo(page: Page, key: 'r' | 'Shift+R', side: number, why: string): Promise<void> {
  await page.keyboard.press(key);
  await pollScene(page, sinkInSide, { message: why }).toBe(side);
}

/** The belt whose first tile sits on `tail`. */
function beltFrom(s: SceneFacts, tail: readonly [number, number]): BeltFacts | undefined {
  return s.belts.find((b) => b.tiles[0]?.cell_x === tail[0] && b.tiles[0]?.cell_y === tail[1]);
}

/** The placed Factory, by its anchor cell and kind. */
function placedFactory(s: SceneFacts): NodeFacts | undefined {
  return s.nodes.find(
    (n) =>
      n.kind === KIND_FACTORY &&
      Math.min(...n.cells.map((c) => c[0])) === FACTORY_CELL[0] &&
      Math.min(...n.cells.map((c) => c[1])) === FACTORY_CELL[1],
  );
}

/**
 * Every dock between the Factory's three belts and the Factory, as `<belt>:<end>:<port>`, the
 * belt named by which of the three it is. A belt that is not on the board reads `<belt>:absent`.
 */
function factoryDocks(s: SceneFacts): string {
  const f = placedFactory(s);
  const rows: string[] = [];
  for (const [name, cells] of [
    ['out', OUT_BELT],
    ['fault', FAULT_BELT],
    ['in', IN_BELT],
  ] as const) {
    const b = beltFrom(s, cells[0]);
    if (b === undefined) {
      rows.push(`${name}:absent`);
      continue;
    }
    for (const d of b.docks) {
      if (f !== undefined && d.node === f.id) rows.push(`${name}:${d.end}:${d.port}`);
    }
  }
  return rows.sort().join(',');
}

/**
 * Draw ONE belt with the armed Belt tool the way a hand does: press the centre of `cells[0]`,
 * travel with `handDragBetween` (several samples per cell) to `end`, release. The caller polls
 * what the host made of it.
 */
async function handDrawBelt(page: Page, cells: ReadonlyArray<readonly [number, number]>, end: Pt): Promise<void> {
  const start = await screenCellCentre(page, cells[0][0], cells[0][1]);
  const tags = await page.evaluate((ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null), [start, end]);
  expect(tags, `the belt from (${cells[0].join(',')}) starts and ends on the canvas, not under chrome`).toEqual([
    'CANVAS',
    'CANVAS',
  ]);
  const moves = await handDragBetween(page, start, end);
  expect(moves, 'the belt drag moved through several samples, not one teleport').toBeGreaterThan(cells.length);
}

test.describe('89 live: a severing turn undone reconnects its belt (BELT-07, CONNECT-03)', () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    // Leg 4 counts the Rotate frames the page sends (review WR-C-02); the sniffer goes in before boot.
    await installFrameSniffer(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the test');
    errs.assertNone('the turn-back walk');
  });

  test("1: the undo of a turn that cut the Audit Sink's belt reconnects it, and both panels say so", async ({ page }) => {
    await loadDemoReset(page);
    const built = await readScene(page);
    expect(auditSink(built), 'PRECONDITION: the Audit Sink stands on (14,4)').toBeDefined();
    expect(belt21(built), 'PRECONDITION: belt 21 runs (11,4) to (13,4)').toBeDefined();
    expect(sinkInSide(built), "PRECONDITION: the Sink's In faces West, onto belt 21's Head").toBe(SIDE_W);
    expect(headDock(built), "PRECONDITION: belt 21's Head is docked to the Sink's In").toBe('sink:0');
    await expectRenderLoopAlive(page, 'on the demo board before the turn');

    // ---- The severing turn: select the Sink, press r.
    await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
    await page.keyboard.press('r');
    await pollScene(page, sinkInSide, { message: "the turn landed: the Sink's In no longer faces West" }).not.toBe(SIDE_W);
    await pollScene(page, headDock, { message: "the turn cut belt 21's Head: it carries no dock" }).toBe('');

    // ---- W141, MEASURED: the ring read at once, then again once the overlay has drawn.
    const headEnd = { x: cellCentre(HEAD_TILE[0]), y: cellCentre(HEAD_TILE[1]) };
    const atOnce = { instructions: await alertRingInstructions(page), centres: await alertRingCentres(page) };
    let settled = atOnce;
    try {
      await expect
        .poll(async () => (await alertRingCentres(page)).some((c) => dist(c, headEnd) <= AT_PX), {
          timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the W141 ring plot read after the turn'),
          intervals: [100, 250, 500],
          message: "the warning ring is plotted on belt 21's Head end tile after the severing turn",
        })
        .toBe(true);
    } catch {
      // Graded below with the reading in the message.
    }
    settled = { instructions: await alertRingInstructions(page), centres: await alertRingCentres(page) };
    const onHead = settled.centres.some((c) => dist(c, headEnd) <= AT_PX);
    const w141 = `W141 reading: at once instructions=${atOnce.instructions} centres=${JSON.stringify(atOnce.centres)}; settled instructions=${settled.instructions} centres=${JSON.stringify(settled.centres)}; head_end=${JSON.stringify(headEnd)} on_head=${onHead}`;
    console.log(`P89-W141 ${w141}`);
    expect(settled.instructions, `the ring is plotted after the severing turn (${w141})`).toBeGreaterThan(0);
    expect(onHead, `a ring centre sits on belt 21's Head end tile (${w141})`).toBe(true);
    // ---- UI-01 (review): the turned Sink is still selected, and its floating delete control
    // used to sit on the ring at belt 21's Head end tile, the tile left of the Sink's top row.
    // Graded on screen: the control's box (DOM) against every plotted ring (world, projected).
    await expectDeleteControlClearOfRings(page, 'leg 1, the Sink still selected after the severing turn');
    await expectRenderLoopAlive(page, 'after the severing turn');

    // ---- One Ctrl+Z: the Sink turns back and belt 21's Head is docked to it again.
    await page.keyboard.press('Control+z');
    await pollScene(page, sinkInSide, { message: "the undo turned the Sink back: its In faces West again" }).toBe(SIDE_W);
    await pollScene(page, headDock, {
      message: "the undo re-docked belt 21's Head to the Sink's In (CONNECT-03's compensating Dock)",
    }).toBe('sink:0');
    await expect
      .poll(() => alertRingInstructions(page), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the ring cleared after the undo'),
        intervals: [100, 250, 500],
        message: 'no warning ring is plotted after the undo re-docked the belt',
      })
      .toBe(0);

    // ---- Both panels read the connection the scene holds.
    await selectBelt21(page);
    await expect(
      portsRegion(page).getByRole('listitem', { name: connectedRow('Output - Item') }),
      "belt 21's panel reads its Head (Output) connected: idle or moving, never not connected",
    ).toHaveCount(1);
    await expect(
      portsRegion(page).getByRole('listitem', { name: /not connected/ }),
      "no row of belt 21's panel reads not connected",
    ).toHaveCount(0);
    await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
    await expect(
      portsRegion(page).getByRole('listitem', { name: connectedRow('Input - Item') }),
      "the Sink's panel reads its In connected: idle or moving, never not connected",
    ).toHaveCount(1);
    await expectRenderLoopAlive(page, 'after the undo and both panel reads');
  });

  test("2: r then Shift+R on the Audit Sink reconnects belt 21, and one Ctrl+Z steps back over the turn back only", async ({ page }) => {
    await loadDemoReset(page);
    expect(headDock(await readScene(page)), "PRECONDITION: belt 21's Head is docked to the Sink's In").toBe('sink:0');

    await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
    await turnSinkTo(page, 'r', SIDE_N, "the turn away landed: the Sink's In faces North");
    await pollScene(page, headDock, { message: "the turn away cut belt 21's Head" }).toBe('');
    await expectRingOnHead(page, 'leg 2: NON-VACUITY: the turn away rings the cut Head, right before the turn back');

    // ---- The turn back (D-08): the In faces belt 21's free Head again, so the same turn docks it.
    await turnSinkTo(page, 'Shift+R', SIDE_W, "the turn back landed: the Sink's In faces West again");
    await pollScene(page, headDock, {
      message: "D-08: turning the Sink back toward belt 21's loose Head docks it, in the turn's own step",
    }).toBe('sink:0');
    await expectNoRingPlotted(page, 'leg 2: the dock the turn back made resolved the cut: no warning ring is plotted');
    await expectBothPanelsConnected(page, 'leg 2 after the turn back');
    await expectRenderLoopAlive(page, 'after the turn back');

    // ---- One Ctrl+Z reverts the turn back AND the dock it made: the Sink faces North, belt 21 cut.
    await page.keyboard.press('Control+z');
    await pollScene(page, sinkInSide, {
      message: "one Ctrl+Z steps back over the turn back only: the Sink is at the first turn's rotation",
    }).toBe(SIDE_N);
    await pollScene(page, headDock, {
      message: "and the dock the turn back made goes with it: belt 21's Head is cut again",
    }).toBe('');
    // The ring after this undo, graded on the plot by plan 89-04 (D-10): the undo cut belt 21's
    // Head again, so the warning ring is plotted on its Head end tile.
    let ringOnHead = false;
    const headEnd = { x: cellCentre(HEAD_TILE[0]), y: cellCentre(HEAD_TILE[1]) };
    try {
      await expect
        .poll(async () => (await alertRingCentres(page)).some((c) => dist(c, headEnd) <= AT_PX), {
          timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the ring read after the undo of the turn back'),
          intervals: [100, 250, 500],
        })
        .toBe(true);
      ringOnHead = true;
    } catch {
      // Graded below with the reading in the message.
    }
    const undoRing = `instructions=${await alertRingInstructions(page)} centres=${JSON.stringify(await alertRingCentres(page))} on_head=${ringOnHead}`;
    console.log(`P89-UNDO-RING after the undo of the turn back: ${undoRing}`);
    expect(await alertRingInstructions(page), `the ring is plotted after the undo of the turn back (${undoRing})`).toBeGreaterThan(0);
    expect(ringOnHead, `a ring centre sits on belt 21's Head end tile after the undo of the turn back (${undoRing})`).toBe(true);
    await expectRenderLoopAlive(page, 'after the undo of the turn back');

    // ---- A second Ctrl+Z steps back over the turn away: rot 0, docked by CONNECT-03's
    // compensation. It also leaves no items backed up on a cut belt, which a scene load waits
    // to drain before it swaps (the next leg's demo reset).
    await page.keyboard.press('Control+z');
    await pollScene(page, sinkInSide, { message: "the second Ctrl+Z turned the Sink back to West" }).toBe(SIDE_W);
    await pollScene(page, headDock, {
      message: "the second Ctrl+Z re-docked belt 21's Head (the turn away's own compensation)",
    }).toBe('sink:0');
  });

  test('3: four r presses on the Audit Sink end with belt 21 docked and no ring', async ({ page }) => {
    await loadDemoReset(page);
    expect(headDock(await readScene(page)), "PRECONDITION: belt 21's Head is docked to the Sink's In").toBe('sink:0');
    await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
    // One quarter turn clockwise per press: In W -> N -> E -> S -> W.
    const sides = [0, 1, 2, SIDE_W];
    for (let k = 0; k < sides.length; k += 1) {
      await turnSinkTo(page, 'r', sides[k], `turn ${k + 1} landed: the Sink's In faces side ${sides[k]}`);
      if (k === 0) {
        await pollScene(page, headDock, { message: "turn 1 cut belt 21's Head" }).toBe('');
      }
      // Turns 1 to 3 join nothing, so the ring stays through them (review WR-C-01): what clears it
      // is the fourth turn's dock, not a turn as such.
      if (k < sides.length - 1) {
        await expectRingOnHead(page, `leg 3: after turn ${k + 1}, which joins nothing, the ring on the cut Head stays`);
      }
    }
    await pollScene(page, headDock, {
      message: "D-08: after four quarter turns the In faces belt 21's loose Head again and the fourth turn docks it",
    }).toBe('sink:0');
    await expectNoRingPlotted(page, 'leg 3: the fourth turn docked belt 21 and resolved the cut: no warning ring is plotted');
    await expectBothPanelsConnected(page, 'leg 3 after four turns');
  });

  test('4: paused, r then Shift+R then Play ends with belt 21 docked', async ({ page }) => {
    await loadDemoReset(page);
    expect(headDock(await readScene(page)), "PRECONDITION: belt 21's Head is docked to the Sink's In").toBe('sink:0');
    try {
      const pausedAt = await pauseAndSettle(page, 'leg 4');
      // The canvas click moves focus off the toolbar button, so `r` reaches the board.
      await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
      // The board ends where it started (In West, belt 21 docked), so the end state alone cannot
      // show the turns happened (review WR-C-02): both turns are graded on the wire as they are
      // sent, and the turn back is graded by its own undo after Play.
      const rotBefore = await sentCount(page, CMD.Rotate);
      await page.keyboard.press('r');
      await page.keyboard.press('Shift+R');
      await expect
        .poll(async () => (await sentCount(page, CMD.Rotate)) - rotBefore, { message: 'leg 4: both turns were sent while paused' })
        .toBe(2);
      // Both turns are queued, not folded: the board still reads the paused tick and the docked belt.
      const queued = await readScene(page);
      expect(queued.tick, 'leg 4: the host is still paused while the two turns are queued').toBe(pausedAt);
      expect(headDock(queued), 'leg 4: nothing folded while paused').toBe('sink:0');
      await resumeIfPaused(page);
      await pollScene(page, (s) => s.tick > pausedAt + 1, { message: 'leg 4: Play folded the queued pass' }).toBe(true);
      await pollScene(page, sinkInSide, { message: "leg 4: after Play the Sink's In faces West" }).toBe(SIDE_W);
      await pollScene(page, headDock, {
        message: "D-08 on a paused board: the turn away and back folded in one pass end with belt 21's Head docked",
      }).toBe('sink:0');
      // No "no ring" read here (review WR-C-01): measured with a dock that never resolves a cut
      // (`strandLifetime.ts` mutated), this leg stayed green, so the paused pass raises no ring to
      // clear and such a read could not fail. The wire count above and the undo below grade it.
      await expectBothPanelsConnected(page, 'leg 4 after Play');
      // The turn back folded as its own step: one Ctrl+Z undoes it alone, the Sink faces North
      // again with belt 21 cut, and a second Ctrl+Z undoes the turn away, docked again (CONNECT-03).
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+z');
      await pollScene(page, sinkInSide, { message: "leg 4: the turn back folded: one Ctrl+Z faces the Sink's In North" }).toBe(SIDE_N);
      await pollScene(page, headDock, { message: "leg 4: and belt 21's Head is cut again" }).toBe('');
      await page.keyboard.press('Control+z');
      await pollScene(page, sinkInSide, { message: 'leg 4: the turn away folded: a second Ctrl+Z faces it West' }).toBe(SIDE_W);
      await pollScene(page, headDock, { message: "leg 4: and belt 21's Head is docked again" }).toBe('sink:0');
    } finally {
      await resumeIfPaused(page).catch(() => undefined);
    }
  });

  test('5: a Factory docked on In, Out and Fault, turned away and back, ends with all three docked', async ({ page }) => {
    await loadDemoReset(page);
    await armAndPlaceFactoryAt(page, FACTORY_CELL[0], FACTORY_CELL[1]);
    await pollScene(page, (s) => placedFactory(s) !== undefined, {
      message: 'the real host echoes the Factory placed at (6,11)',
    }).toBe(true);
    // Two quarter turns before any belt exists (nothing to dock): rot 2.
    await selectMachineAt(page, FACTORY_CELL[0], FACTORY_CELL[1]);
    for (let k = 0; k < 2; k += 1) {
      const before = JSON.stringify(placedFactory(await readScene(page))?.ports);
      await page.keyboard.press('r');
      await pollScene(page, (s) => JSON.stringify(placedFactory(s)?.ports) !== before, {
        message: `bare turn ${k + 1} of the Factory landed`,
      }).toBe(true);
    }
    await page.keyboard.press('Escape');
    const f0 = placedFactory(await readScene(page))!;
    const portByRole = (role: number) => f0.ports.find((p) => p.role === role)!;

    // ---- Three belts drawn by hand, each across four cells: off the Out and the Fault doorsteps,
    // and into the In's doorstep, released on the In's nub (rot 2: Out West, In East, Fault North).
    await page.getByTitle(/^Draw belts/).click();
    const outEnd = await screenCellCentre(page, OUT_BELT[3][0], OUT_BELT[3][1]);
    await handDrawBelt(page, OUT_BELT, outEnd);
    await pollScene(page, (s) => (beltFrom(s, OUT_BELT[0])?.docks.length ?? 0) === 1, {
      message: "the Out belt is drawn and its Tail docked to the Factory's Out",
    }).toBe(true);
    const faultEnd = await screenCellCentre(page, FAULT_BELT[3][0], FAULT_BELT[3][1]);
    await handDrawBelt(page, FAULT_BELT, faultEnd);
    await pollScene(page, (s) => (beltFrom(s, FAULT_BELT[0])?.docks.length ?? 0) === 1, {
      message: "the Fault belt is drawn and its Tail docked to the Factory's Fault",
    }).toBe(true);
    const inPort = portByRole(ROLE_IN);
    const inNub = await screenPoint(page, nubAnchor(inPort.cell_x, inPort.cell_y, inPort.side));
    await handDrawBelt(page, IN_BELT, inNub);
    await pollScene(page, (s) => (beltFrom(s, IN_BELT[0])?.docks.length ?? 0) === 1, {
      message: "the In belt is drawn and its Head docked to the Factory's In",
    }).toBe(true);
    await page.keyboard.press('Escape');
    const docked = factoryDocks(await readScene(page));
    expect(docked.split(',').length, `PRECONDITION: all three belts docked to the Factory (${docked})`).toBe(3);
    await expectRenderLoopAlive(page, 'with the Factory docked on all three ports');

    // ---- Turn the Factory away (r) and back (Shift+R).
    await selectMachineAt(page, FACTORY_CELL[0], FACTORY_CELL[1]);
    const portsAt0 = JSON.stringify(f0.ports);
    await page.keyboard.press('r');
    await pollScene(page, (s) => JSON.stringify(placedFactory(s)?.ports) !== portsAt0, {
      message: 'the turn away landed: the Factory ports moved',
    }).toBe(true);
    console.log(`P89-FACTORY after the turn away: docks=${factoryDocks(await readScene(page))}`);
    // NON-VACUITY for the "no ring" read after the turn back (review WR-C-01): the turn away cut
    // the Out and In belts, so the ring is plotted right before the turn back.
    await expect
      .poll(() => alertRingInstructions(page), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'leg 5: the ring plot read after the turn away'),
        intervals: [100, 250, 500],
        message: 'leg 5: NON-VACUITY: the turn away that cut the Out and In belts plots the warning ring',
      })
      .toBeGreaterThan(0);
    await page.keyboard.press('Shift+R');
    await pollScene(page, (s) => JSON.stringify(placedFactory(s)?.ports), {
      message: 'the turn back landed: the Factory ports are where they started',
    }).toBe(portsAt0);
    await pollScene(page, factoryDocks, {
      message: 'D-08: the turn back docks every loose belt end a Factory port faces again: In, Out and Fault',
    }).toBe(docked);
    await expectNoRingPlotted(page, 'leg 5: the turn back docked all three ports and resolved every cut: no warning ring is plotted');
    await expectRenderLoopAlive(page, 'after the Factory turned away and back');
  });

  test('6: paused, a belt drawn then a turn that faces its Head, then Play: the turn docks it', async ({ page }) => {
    // Review CR-A-01. On a paused board every gesture waits and is validated in ONE pass after
    // Play, before any of it folds. A Sink placed on open floor at (12,9), its In on the W edge.
    // Paused: a belt drawn by hand North from (12,12) to (12,10), its Head on the cell South of
    // the Sink, then Shift+R on the Sink, which puts its In on the S edge facing that Head. After
    // Play the turn's D-08 dock joins them, as the headless session does. Red before the fix: the
    // host read the pending belt as a reserved cell with no geometry, so the Sink sat facing the
    // Head unjoined. The turn cuts nothing (the Sink held no dock), so no ring is plotted.
    const SINK2 = [12, 9] as const;
    const NEW_BELT: ReadonlyArray<readonly [number, number]> = [
      [12, 12],
      [12, 11],
      [12, 10],
    ];
    const SIDE_S = 2;
    const sink2 = (s: SceneFacts): NodeFacts | undefined =>
      s.nodes.find((n) => n.kind === KIND_SINK && n.cells.some((c) => c[0] === SINK2[0] && c[1] === SINK2[1]));
    const sink2In = (s: SceneFacts): number => sink2(s)?.ports.find((p) => p.role === ROLE_IN)?.side ?? -1;
    const newBeltDocks = (s: SceneFacts): string => {
      const b = beltFrom(s, NEW_BELT[0]);
      if (b === undefined) return 'no belt';
      const k = sink2(s);
      return b.docks.map((d) => `${d.end}:${k !== undefined && d.node === k.id ? 'sink' : d.node}:${d.port}`).join(',');
    };
    await loadDemoReset(page);
    await armAndPlaceAt(page, 'Sink', SINK2[0], SINK2[1]);
    await pollScene(page, sink2In, { message: 'the Sink placed at (12,9), its In facing West' }).toBe(SIDE_W);
    try {
      const pausedAt = await pauseAndSettle(page, 'leg 6');
      await page.getByTitle(/^Draw belts/).click();
      const head = await screenCellCentre(page, NEW_BELT[2][0], NEW_BELT[2][1]);
      await handDrawBelt(page, NEW_BELT, { x: head.x + 3, y: head.y + 2 });
      await page.keyboard.press('Escape');
      await selectMachineAt(page, SINK2[0], SINK2[1]);
      await page.keyboard.press('Shift+R');
      const queued = await readScene(page);
      expect(queued.tick, 'leg 6: the host is still paused while the draw and the turn are queued').toBe(pausedAt);
      expect(beltFrom(queued, NEW_BELT[0]), 'leg 6: nothing folded while paused').toBeUndefined();
      await resumeIfPaused(page);
      await pollScene(page, sink2In, { message: "leg 6: after Play the Sink's In faces South, onto the drawn Head" }).toBe(SIDE_S);
      await pollScene(page, newBeltDocks, {
        message: "CR-A-01: the paused turn docked the belt drawn earlier in the same pass: its Head on the Sink's In",
      }).toBe('Head:sink:0');
      await expectNoRingPlotted(page, 'no warning ring is plotted: the turn cut nothing and docked the new belt');
    } finally {
      await resumeIfPaused(page).catch(() => undefined);
    }
  });
});
