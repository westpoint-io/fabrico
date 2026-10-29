import { test, expect, type Page } from '@playwright/test';
import { addFrameBudget, addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  HAND_MOVE_FRAMES,
  alertRingCentres,
  alertRingInstructions,
  applyConfig,
  armAndPlaceAt,
  cameraOf,
  cellCentre,
  deselectViaEmptyCell,
  drawBeltThroughCells,
  expectRenderLoopAlive,
  fillPanelField,
  handPath,
  itemDotsPerCell,
  nodeAtAnchor,
  nubAnchor,
  pointerTravel,
  pollScene,
  pressSegment,
  readScene,
  restoreHostAfterFailedTest,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { emptyBoardAtScaleOne, expectOnCanvas, portOf, sideOf, turnUntilFacing, zoomBelowOne } from './support/beltBoard';

// 89-fan-in-ring.live.spec.ts (phase 89, plan 89-04, FAIL-06, success criterion 3, D-09, D-10,
// D-16; todos `2026-09-29-detect-stranded-docks-fanin-severed-upstream` and
// `2026-09-17-detect-undo-strand-fanin-find-first`) - cutting one upstream of a fan-in shows the
// warning ring, on the REAL host (dev_render_server, real Core -> RenderProducer -> postcard ->
// WS). Zero mocks, zero injected packets: machines are placed and turned with the shipped palette
// and `r` key, the belt is drawn with the shipped Belt tool, the second upstream is docked with the
// shipped belt-end handle drag, undo and redo are the shipped Ctrl+Z and Ctrl+Shift+Z.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## FAIL-06/fanin-diff` and `## FAIL-06/fanin-keyframe`)
// ---------------------------------------------------------------------------
//
// Since LINK-13 a belt's Tail holds one dock per upstream. Both strand detectors in
// `frontend/src/render/strandedDocks.ts` asked only "does this END still have a dock", so a turn
// that cut ONE of two upstreams read the Tail as still docked: no ring, and the packet then took
// the structural branch in App.tsx, which clears any ring already on the board. The Redo of that
// turn arrives as a full keyframe and took the same end-only test on the keyframe path. D-09:
// both detectors compare docks per (end, node, port); a dock lost with nothing gained at that end
// is a strand, a dock lost while the same end gains another is a re-aim and stays silent.
//
// ---------------------------------------------------------------------------
// THE BOARD, AND THE LEGS, GRADED ON WHAT THE EYE SEES (D-10)
// ---------------------------------------------------------------------------
//
// On an empty board, per fan-in: Source A one cell West of the belt's Tail cell, its Out facing
// East onto it; Source B one cell South of the Tail cell, turned so its Out faces North onto it
// (both turned before any belt exists, so D-08 docks nothing early); a four-cell belt drawn East
// from the Tail cell into a Sink whose In faces West. The press on the Tail cell docks the Tail to
// one Source; the other is docked by selecting the belt and dragging its Tail end handle onto that
// Source's Out nub, by hand through a waypoint (the shipped dock-drag). Both Sources then run on a
// Timer. Each test builds two fan-ins: the first walked at camera scale 1, the second after the
// wheel has zoomed the camera below 1 (D-16).
//
//   1. Cut and turn back: A turned away (`r`). The ring is PLOTTED (`alertRingInstructions`) with
//      a centre on the Tail end tile and one on A's Out nub (`alertRingCentres`, world px); B's
//      items keep crossing the belt into the Sink; the ring is still plotted after a full belt
//      transit of flow. A turned back (Shift+R): D-08 never joins a Tail that still holds a dock
//      ("a turn never silently joins an existing fan-in", `turn_docks` in command.rs), so the
//      turn back leaves A undocked (graded) and the ring stays on A's Out dot and the Tail end
//      tile, read off the plot at once and a second later (review fix TODO-FANIN, option 3: a ring
//      stays until its cut is resolved; red before the fix, where the turn back cleared it). The
//      leg reconnects A with the same Tail handle drag that built the fan-in, and the ring is
//      gone (graded; the ring plotted just before the drag is what makes that read evidence).
//   2. Cut, undo, redo: A turned away (ring), Ctrl+Z (CONNECT-03 re-docks A, ring gone),
//      Ctrl+Shift+Z (the turn again, as a full keyframe: the ring is plotted again on the Tail end
//      tile and A's Out nub, the keyframe detector's per-end rule), then Ctrl+Z to leave the
//      fan-in whole for the next walk.
//
// RED FIRST (D-16): leg 1 run once against plan 89-04's start revision and leg 2 against Task 1's
// commit, host and frontend built from each (89-EVIDENCE.md, `LIVE_RED 89-fan-in-ring`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Wire kinds (kinds.ts). */
const KIND_SOURCE = 0;
const KIND_SINK = 7;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** Sides, the wire's numbering (y-down). */
const SIDE_N = 0;
const SIDE_E = 1;
const SIDE_S = 2;
const SIDE_W = 3;
/** Cells per fan-in belt (D-16: a real multi-cell path). */
const BELT_LEN = 4;
/** The Timer interval each Source runs on, in sim ticks: items cross the belt one at a time. */
const FEED_EVERY = 16;
/** "At" a point: the plot is exact geometry, this only absorbs float noise. */
const AT_PX = 2;

/** One fan-in: the belt's Tail cell; every other cell is placed relative to it. */
interface FanIn {
  name: string;
  tail: readonly [number, number];
}
const FAN_INS: readonly FanIn[] = [
  { name: 'at zoom 1', tail: [8, 5] },
  { name: 'below zoom 1', tail: [8, 10] },
];

type Cell = readonly [number, number];
type Pt = { x: number; y: number };

const sourceA = (f: FanIn): Cell => [f.tail[0] - 1, f.tail[1]];
const sourceB = (f: FanIn): Cell => [f.tail[0], f.tail[1] + 1];
const beltCells = (f: FanIn): Cell[] => Array.from({ length: BELT_LEN }, (_, i) => [f.tail[0] + i, f.tail[1]] as const);
const headCell = (f: FanIn): Cell => [f.tail[0] + BELT_LEN - 1, f.tail[1]];
const sinkCell = (f: FanIn): Cell => [f.tail[0] + BELT_LEN, f.tail[1]];
/** A floor cell two below the belt's middle: the waypoint a dock drag swings out through. */
const waypointCell = (f: FanIn): Cell => [f.tail[0] + 2, f.tail[1] + 2];

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
const tileCentre = (c: Cell): Pt => ({ x: cellCentre(c[0]), y: cellCentre(c[1]) });

/** The fan-in belt, by its Tail cell (tiles survive a keyframe; handles do not). */
function beltOf(s: SceneFacts, f: FanIn): SceneFacts['belts'][number] | undefined {
  return s.belts.find((b) => b.tiles[0]?.cell_x === f.tail[0] && b.tiles[0]?.cell_y === f.tail[1]);
}

/**
 * The fan-in belt's docks, named: `A` and `B` for the two Sources, `sink` for the Sink, anything
 * else by its raw handle; Tail docks sorted, then the Head. Read by handle within one scene, so a
 * keyframe's re-mint cannot confuse it.
 */
function docksOf(s: SceneFacts, f: FanIn): string {
  const b = beltOf(s, f);
  if (b === undefined) return 'no belt';
  const name = (node: number): string => {
    const at = s.nodes.find((n) => n.id === node);
    if (at === undefined) return `#${node}`;
    const a = [Math.min(...at.cells.map((c) => c[0])), Math.min(...at.cells.map((c) => c[1]))];
    if (a[0] === sourceA(f)[0] && a[1] === sourceA(f)[1]) return 'A';
    if (a[0] === sourceB(f)[0] && a[1] === sourceB(f)[1]) return 'B';
    if (a[0] === sinkCell(f)[0] && a[1] === sinkCell(f)[1]) return 'sink';
    return `#${node}`;
  };
  const tail = b.docks.filter((d) => d.end === 'Tail').map((d) => name(d.node)).sort();
  const head = b.docks.filter((d) => d.end === 'Head').map((d) => name(d.node));
  return `tail=${tail.join('+')} head=${head.join('+')}`;
}
const BOTH_DOCKED = 'tail=A+B head=sink';
const ONLY_B = 'tail=B head=sink';

/** Place a fan-in's two Sources and its Sink, and turn each to face the belt (no belt exists yet). */
async function placeMachines(page: Page, f: FanIn): Promise<void> {
  for (const [kind, name, cell] of [
    [KIND_SINK, 'Sink', sinkCell(f)],
    [KIND_SOURCE, 'Source', sourceA(f)],
    [KIND_SOURCE, 'Source', sourceB(f)],
  ] as const) {
    await armAndPlaceAt(page, name, cell[0], cell[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, cell[0], cell[1])?.kind ?? -1, {
      message: `${f.name}: the palette ${name} was placed at (${cell.join(',')})`,
    }).toBe(kind);
  }
  await selectMachineAt(page, ...sourceA(f));
  await turnUntilFacing(page, sourceA(f), ROLE_OUT, SIDE_E, `${f.name}: Source A's Out`);
  await selectMachineAt(page, ...sourceB(f));
  await turnUntilFacing(page, sourceB(f), ROLE_OUT, SIDE_N, `${f.name}: Source B's Out`);
  await selectMachineAt(page, ...sinkCell(f));
  await turnUntilFacing(page, sinkCell(f), ROLE_IN, SIDE_W, `${f.name}: the Sink's In`);
  await deselect(page, f);
}

/**
 * Deselect by a click on the fan-in's waypoint cell (empty floor beside the machines, so on screen
 * at every zoom the walk uses), once that point is on the canvas with no panel or control over it,
 * as `selectMachineAt` waits before its own click. A fixed far cell is not used: after the wheel
 * zoom it can sit under the bottom-right camera controls (measured at camera scale 0.93).
 */
async function deselect(page: Page, f: FanIn): Promise<void> {
  const cell = waypointCell(f);
  const pt = await screenCellCentre(page, cell[0], cell[1]);
  await expect
    .poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const), {
      message: `${f.name}: the floor cell (${cell.join(',')}) is on the open board before the deselect click`,
    })
    .toBe('CANVAS');
  await deselectViaEmptyCell(page, cell[0], cell[1]);
}

/**
 * Dock the belt's Tail to the Source anchored at `source` with the shipped belt-end handle drag:
 * select the belt by its middle tile, press its Tail end tile, walk by hand out through the
 * waypoint cell and back onto the Source's Out nub, release.
 */
async function dockTailByHandle(
  page: Page,
  f: FanIn,
  source: Cell,
  why: string,
  beforeDrag?: () => Promise<void>,
): Promise<void> {
  const mid = await screenCellCentre(page, f.tail[0] + 2, f.tail[1]);
  await pointerTravel(page, mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator('#fab-belt-config'), `${why}: clicking the belt's middle tile selected the belt`).toBeVisible();
  if (beforeDrag) await beforeDrag();
  const out = portOf(await readScene(page), source, ROLE_OUT)!;
  const press = await screenCellCentre(page, f.tail[0], f.tail[1]);
  const start = { x: press.x + 2, y: press.y - 1 };
  const via = await screenCellCentre(page, ...waypointCell(f));
  const target = await screenPoint(page, nubAnchor(out.cell_x, out.cell_y, out.side));
  await expectOnCanvas(page, [start, via, target], why);
  const path = [...handPath(start, via), ...handPath(via, target)];
  addFrameBudget((path.length + 1) * HAND_MOVE_FRAMES, `${why}: the handle drag, ${path.length + 1} moves`);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const p of path) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  expect(path.length, `${why}: the handle drag moved through many pointer samples (D-16)`).toBeGreaterThanOrEqual(12);
  await page.keyboard.press('Escape');
}

/** Draw the fan-in's belt, dock its Tail to both Sources, and put both Sources on a Timer. */
async function buildFanIn(page: Page, f: FanIn): Promise<void> {
  const s0 = await readScene(page);
  const outA = portOf(s0, sourceA(f), ROLE_OUT)!;
  const inSink = portOf(s0, sinkCell(f), ROLE_IN)!;
  await drawBeltThroughCells(page, outA, beltCells(f), inSink);
  await pollScene(page, (s) => /^tail=(A|B) head=sink$/.test(docksOf(s, f)), {
    message: `${f.name}: the belt is drawn, its Head docked to the Sink and its Tail to one Source`,
  }).toBe(true);
  const first = docksOf(await readScene(page), f);
  const other = first.startsWith('tail=A ') ? sourceB(f) : sourceA(f);
  await dockTailByHandle(page, f, other, `${f.name}: the second upstream`);
  await pollScene(page, (s) => docksOf(s, f), {
    message: `${f.name}: the Tail end handle dropped on the other Source's Out docks it too: a fan-in of two`,
  }).toBe(BOTH_DOCKED);
  for (const src of [sourceA(f), sourceB(f)]) {
    await selectMachineAt(page, src[0], src[1]);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', String(FEED_EVERY));
    await applyConfig(page);
  }
  await deselect(page, f);
  await pollScene(page, (s) => (beltOf(s, f)?.items ?? 0) > 0, { message: `${f.name}: items ride the fan-in belt` }).toBe(true);
  expect(docksOf(await readScene(page), f), `${f.name}: PRECONDITION: the fan-in is whole`).toBe(BOTH_DOCKED);
}

/** The ticks one item takes to cross the whole belt (4 slots a tile at the belt's pace). */
function transitTicks(s: SceneFacts, f: FanIn): number {
  return BELT_LEN * 4 * (beltOf(s, f)?.ticksPerSlot ?? 2);
}

/** The ring centres and instruction count, as one line for the log. */
async function ringReading(page: Page): Promise<{ instructions: number; centres: Pt[]; line: string }> {
  const instructions = await alertRingInstructions(page);
  const centres = await alertRingCentres(page);
  return { instructions, centres, line: `instructions=${instructions} centres=${JSON.stringify(centres)}` };
}

/**
 * The warning ring is PLOTTED on the cut: a centre on the Tail end tile and one on Source A's Out
 * nub, read off the ring Graphics (D-10), polled to the drawn-state budget.
 */
async function expectCutRing(page: Page, f: FanIn, why: string): Promise<void> {
  const tailEnd = tileCentre(f.tail);
  const outA = portOf(await readScene(page), sourceA(f), ROLE_OUT)!;
  const nub = nubAnchor(outA.cell_x, outA.cell_y, outA.side);
  let seen = await ringReading(page);
  try {
    await expect
      .poll(
        async () => {
          seen = await ringReading(page);
          return seen.centres.some((c) => dist(c, tailEnd) <= AT_PX) && seen.centres.some((c) => dist(c, nub) <= AT_PX);
        },
        {
          timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${why}: the ring plot read`),
          intervals: [100, 250, 500],
        },
      )
      .toBe(true);
  } catch {
    // Graded below with the reading in the message.
  }
  const line = `${seen.line} tail_end=${JSON.stringify(tailEnd)} nub_A=${JSON.stringify(nub)}`;
  console.log(`P89-FANIN-RING ${f.name} ${why}: ${line}`);
  expect(seen.instructions, `${why}: the warning ring is plotted (${line})`).toBeGreaterThan(0);
  expect(seen.centres.some((c) => dist(c, tailEnd) <= AT_PX), `${why}: a ring centre sits on the belt's Tail end tile (${line})`).toBe(true);
  expect(seen.centres.some((c) => dist(c, nub) <= AT_PX), `${why}: a ring centre sits on Source A's Out nub (${line})`).toBe(true);
}

/** No warning ring is plotted (read off the ring Graphics), polled to the drawn-state budget. */
async function expectNoRing(page: Page, why: string): Promise<void> {
  await expect
    .poll(() => alertRingInstructions(page), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), why),
      intervals: [100, 250, 500],
      message: why,
    })
    .toBe(0);
}

/** Select Source A and turn it with `key` until its Out faces `side`. */
async function turnA(page: Page, f: FanIn, key: 'r' | 'Shift+R', side: number, why: string): Promise<void> {
  await selectMachineAt(page, ...sourceA(f));
  await page.keyboard.press(key);
  await pollScene(page, (s) => sideOf(s, sourceA(f), ROLE_OUT), { message: why }).toBe(side);
}

/**
 * B keeps feeding after A is cut: once a full belt transit has passed since the cut (every item A
 * put on the belt has left it), a dot is still drawn on the belt's Head end tile, and the belt is
 * not backing up, so B's items are crossing it into the Sink.
 */
async function expectBKeepsFeeding(page: Page, f: FanIn, cutTick: number): Promise<void> {
  const s = await readScene(page);
  const clearAfter = cutTick + transitTicks(s, f) + FEED_EVERY;
  await pollScene(page, (x) => x.tick > clearAfter, {
    timeout: addWaitBudget(
      tickBudgetMs(clearAfter - cutTick) + frameBudgetMs(DRAWN_STATE_FRAMES),
      `${f.name}: a full belt transit past the cut`,
    ),
    message: `${f.name}: the sim ran a full belt transit past the cut (tick ${clearAfter})`,
  }).toBe(true);
  const key = `${headCell(f)[0]},${headCell(f)[1]}`;
  await expect
    .poll(async () => (await itemDotsPerCell(page))[key] ?? 0, {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES * 40), `${f.name}: a dot on the Head end tile after the cut`),
      intervals: [16, 50, 100],
      message: `${f.name}: after the cut a dot is drawn on the belt's Head end tile: B's items still cross into the Sink`,
    })
    .toBeGreaterThan(0);
  const after = await readScene(page);
  expect(
    beltOf(after, f)?.items ?? 99,
    `${f.name}: the belt is not backing up: the Sink takes what B feeds (${docksOf(after, f)})`,
  ).toBeLessThanOrEqual(4);
}

/** Leg 1: cut A, see the ring, see B keep feeding with the ring still there, turn A back. */
async function walkCutAndTurnBack(page: Page, f: FanIn): Promise<void> {
  await turnA(page, f, 'r', SIDE_S, `${f.name}: the cut landed: Source A's Out faces South`);
  await pollScene(page, (s) => docksOf(s, f), { message: `${f.name}: the turn cut A only: the Tail keeps B's dock` }).toBe(ONLY_B);
  const cutTick = (await readScene(page)).tick;
  await expectCutRing(page, f, 'after the cut');
  await expectRenderLoopAlive(page, `${f.name}: after the cut`);
  await expectBKeepsFeeding(page, f, cutTick);
  await expectCutRing(page, f, 'after a full belt transit of flow');

  // The turn back. D-08 does not join a Tail that still holds a dock, so A is left undocked, and
  // the ring STAYS until A is docked again (TODO-FANIN, option 3, `strandLifetime.ts`): graded on
  // the plot, on A's Out dot where it is now (facing the belt again) and on the Tail end tile.
  await turnA(page, f, 'Shift+R', SIDE_E, `${f.name}: the turn back landed: Source A's Out faces East again`);
  const afterTurnBack = docksOf(await readScene(page), f);
  console.log(`P89-FANIN-TURNBACK ${f.name}: docks=${afterTurnBack} ring ${(await ringReading(page)).line}`);
  expect(afterTurnBack, `${f.name}: D-08 leaves a held Tail alone: the turn back joins nothing`).toBe(ONLY_B);
  await expectCutRing(page, f, 'after the turn back that joins nothing');
  // Held for a beat of real packets, not read once: flow and the next ticks must not clear it.
  await page.waitForTimeout(1_000);
  await expectCutRing(page, f, 'a second after the turn back');
  await page.keyboard.press('Escape');
  // NON-VACUITY for the read after the reconnect (review WR-C-01): the ring is plotted the moment
  // before the handle drag, with the belt selected for it. The turn back above was itself an edit
  // that joined nothing and the ring outlived it, so what clears it next is the reconnect and not
  // an edit wiping every ring. Red with the dock-back no longer resolving the cut in
  // `strandLifetime.ts` (the ring stays on the whole fan-in).
  await dockTailByHandle(page, f, sourceA(f), `${f.name}: the reconnect of A`, () =>
    expectCutRing(page, f, 'with the belt selected, just before the reconnect drag'),
  );
  await pollScene(page, (s) => docksOf(s, f), { message: `${f.name}: the handle drag re-docked A: a fan-in of two again` }).toBe(
    BOTH_DOCKED,
  );
  await expectNoRing(page, `${f.name}: the reconnect resolved the cut: no warning ring is plotted once the fan-in is whole again`);
}

/** Leg 2: cut A (ring), Ctrl+Z (re-docked, no ring), Ctrl+Shift+Z (the ring again, keyframe path). */
async function walkCutUndoRedo(page: Page, f: FanIn): Promise<void> {
  await turnA(page, f, 'r', SIDE_S, `${f.name}: the cut landed: Source A's Out faces South`);
  await pollScene(page, (s) => docksOf(s, f), { message: `${f.name}: the turn cut A only` }).toBe(ONLY_B);
  await expectCutRing(page, f, 'after the cut');

  await page.keyboard.press('Control+z');
  await pollScene(page, (s) => sideOf(s, sourceA(f), ROLE_OUT), { message: `${f.name}: the undo turned A back` }).toBe(SIDE_E);
  await pollScene(page, (s) => docksOf(s, f), { message: `${f.name}: the undo re-docked A (CONNECT-03)` }).toBe(BOTH_DOCKED);
  await expectNoRing(page, `${f.name}: no warning ring is plotted after the undo re-docked A`);

  await page.keyboard.press('Control+Shift+z');
  await pollScene(page, (s) => sideOf(s, sourceA(f), ROLE_OUT), { message: `${f.name}: the redo turned A away again` }).toBe(SIDE_S);
  await pollScene(page, (s) => docksOf(s, f), { message: `${f.name}: the redo cut A again` }).toBe(ONLY_B);
  await expectCutRing(page, f, 'after the redo');
  await expectRenderLoopAlive(page, `${f.name}: after the redo`);

  // Leave the fan-in whole for the next walk.
  await page.keyboard.press('Control+z');
  await pollScene(page, (s) => docksOf(s, f), { message: `${f.name}: the closing undo re-docked A` }).toBe(BOTH_DOCKED);
  await expectNoRing(page, `${f.name}: no warning ring is plotted after the closing undo`);
}

/** Build the machines of both fan-ins, then build and walk the first at scale 1 and the second below 1. */
async function walkBoth(page: Page, walk: (page: Page, f: FanIn) => Promise<void>): Promise<void> {
  await emptyBoardAtScaleOne(page, FAN_INS.flatMap((f) => [sourceA(f), sourceB(f), ...beltCells(f), sinkCell(f), waypointCell(f)]));
  for (const f of FAN_INS) await placeMachines(page, f);
  await expectRenderLoopAlive(page, 'with both fan-ins placed');
  expect((await cameraOf(page)).scale, `${FAN_INS[0].name}: walked at camera scale 1`).toBe(1);
  await buildFanIn(page, FAN_INS[0]);
  await walk(page, FAN_INS[0]);
  const scale = await zoomBelowOne(page, FAN_INS[1].tail);
  console.log(`P89-FANIN ${FAN_INS[1].name}: camera scale ${scale}`);
  await buildFanIn(page, FAN_INS[1]);
  await walk(page, FAN_INS[1]);
}

test.describe('89 live: cutting one upstream of a fan-in shows the warning ring (FAIL-06)', () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the fan-in ring walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test('1: a Source turned off a fan-in rings its cut while the other keeps feeding, keeps the ring when turned back, and the ring is gone once it is docked again', async ({
    page,
  }) => {
    await walkBoth(page, walkCutAndTurnBack);
  });

  test('2: the redo of a turn that cut one upstream of a fan-in rings again', async ({ page }) => {
    await walkBoth(page, walkCutUndoRedo);
  });
});
