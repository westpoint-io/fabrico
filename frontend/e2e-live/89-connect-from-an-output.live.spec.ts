import { test, expect, type Page } from '@playwright/test';
import {
  armAndPlaceAt,
  cameraOf,
  clickAt,
  expectRenderLoopAlive,
  handPath,
  nodeAtAnchor,
  nubAnchor,
  pointerTravel,
  pollScene,
  readScene,
  restoreHostAfterFailedTest,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { CMD, beltOn, cellPoint, deselectOnFloor, doorstep, emptyBoardAtScaleOne, installFrameSniffer, rowCells, sentCount, zoomBelowOne } from './support/beltBoard';
import { PORT_STATUS } from '../src/chrome/configCopy';

// 89-connect-from-an-output.live.spec.ts (phase 89, plan 89-06, BELT-04 first half, success
// criterion 1, D-05, WINDOWS 113 items ii and iii, UI-SPEC 3.1 and A11 to A14, walk step 4) - with
// no tool picked and nothing selected, a drag from a machine's output dot onto a belt's start
// connects them, and a drag of a belt's end tile onto a machine's output connects them too, on the
// REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero
// injected packets: the machines are placed with the shipped palette and the belts are drawn with
// the shipped Belt tool by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## BELT-04/W113`)
// ---------------------------------------------------------------------------
//
// Every dock gesture belonged to the belt: a handle drag that needs the belt selected first, or a
// new draw. A press on a machine's output dot only selected the machine, and a drag from it onto
// a belt end did nothing else; a press on an unselected belt's end tile only selected the belt.
// D-05 (2026-10-22): with no tool picked, a drag from a machine's Out or Fault dot onto a
// belt's start connects them, and a plain click on the dot still selects the machine.
//
// ---------------------------------------------------------------------------
// THE BOARD AND THE LEGS, GRADED ON WHAT THE EYE SEES
// ---------------------------------------------------------------------------
//
// Each row: a belt drawn first on open floor, from the cell that will be the Router output's
// doorstep, East for five cells (a plain draw, so nothing docks it), and then a Router placed
// from the palette at rot 0 whose top output faces that first tile. Placing docks nothing, so the
// belt starts loose: the precondition reads its docks empty.
//
//   1. the output-dot drag: nothing selected, a hand presses on the Router's top output dot (inside
//      the machine's edge, a few px off the dot's centre), travels three cells away and comes back
//      to the far half of the belt's first tile, and lets go. The belt's start is docked to that
//      output (`Tail@router`), the Router panel's output row reads `idle`, and the selection was
//      null before the press and is still null after the release (`selectedNode()` and
//      `selectedBelt()`);
//   2. a plain click on the same dot selects the Router (its panel opens, `selectedNode()` is the
//      Router) and docks nothing;
//   3. the belt's start tile dragged onto the output: nothing selected, a hand presses on the far
//      half of the belt's first tile (outside the dot's reach), travels three cells away and comes
//      back onto the output dot, and lets go. The belt's start is docked to that output and the
//      selection is still null.
//   4. the right button mid-drag (review CR-B-01): leg 1's drag, the right button pressed and
//      lifted with the left still held (the chorded shape a mouse sends), then the left released
//      on the belt's first tile. Nothing docks and nothing is selected.
//
// Each leg is walked on two rows of one board: at camera scale 1, then after the wheel has zoomed
// the camera below 1, every screen point read again after the zoom (the dot's reach grows in world
// px below 1, which is why the press and the release points sit where they do).
//
// RED FIRST (D-16): run once against the plan's start revision (frontend from a throwaway worktree
// with this spec copied in): legs 1 and 3 red, leg 2 green (it guards the click the new drag must
// not steal, T-89-17). 89-EVIDENCE.md, `LIVE_RED 89-connect-from-an-output`.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Wire kinds (kinds.ts). */
const KIND_ROUTER = 5;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_OUT = 1;
/** Sides, the wire's numbering (y-down). */
const E = 1;

/** A board row: the Router's anchor row, and two floor cells to deselect on. */
interface Row {
  name: string;
  y: number;
  floor: ReadonlyArray<readonly [number, number]>;
}
/** The Router's anchor column (2 by 3 at rot 0, its outputs on the East edge at x + 1). */
const ROUTER_X = 10;
/** The belt runs from the Router output's doorstep (x + 2) for five cells. */
const BELT_LEN = 5;
const ROWS: readonly Row[] = [
  { name: 'at zoom 1', y: 6, floor: [[8, 10], [9, 10]] },
  { name: 'below zoom 1', y: 12, floor: [[8, 16], [9, 16]] },
];

type BeltFacts = SceneFacts['belts'][number];
type NodeFacts = SceneFacts['nodes'][number];

/** `<end>@<who>` for each dock, sorted, naming the Router; or `no belt`. */
function docksOf(belt: BeltFacts | undefined, router: NodeFacts): string {
  if (belt === undefined) return 'no belt on the drawn cells';
  return belt.docks
    .map((d) => `${d.end}@${d.node === router.id ? 'router' : d.node}`)
    .sort()
    .join(',');
}

/** The live selection on both channels, read off the page (`window.__fabrico`). */
async function selectionOf(page: Page): Promise<{ node: number | null; belt: number | null }> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { selectedNode(): number | null; selectedBelt(): number | null } }).__fabrico;
    return { node: hook?.selectedNode() ?? null, belt: hook?.selectedBelt() ?? null };
  });
}

/**
 * Press at `start`, travel the way a hand does to `via` and on to `end`, and let go: the two
 * stretches of `handPath`, every sample a move of a few screen px, never one clean cell per event.
 * Returns the number of moves.
 */
async function handDragVia(
  page: Page,
  start: { x: number; y: number },
  via: { x: number; y: number },
  end: { x: number; y: number },
): Promise<number> {
  const path = [...handPath(start, via), ...handPath(via, end)];
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  for (const p of path) await pointerTravel(page, p.x, p.y);
  await page.mouse.up();
  return path.length;
}

/** A built row: the Router, its top output, and the loose belt on that output's doorstep. */
interface Built {
  router: NodeFacts;
  out: PortFacts;
  cells: Array<[number, number]>;
}

/**
 * Build a row: draw the belt on open floor first (a plain draw, so it docks nothing), then place
 * the Router at rot 0 so its top output faces the belt's first tile. The belt stays loose.
 */
async function buildRow(page: Page, row: Row): Promise<Built> {
  const first = ROUTER_X + 2;
  const cells = rowCells(first, first + BELT_LEN - 1, row.y);
  await page.getByTitle(/^Draw belts/).click();
  const a = await cellPoint(page, first, row.y, 0.35, 0.45);
  const b = await cellPoint(page, first + BELT_LEN - 1, row.y, 0.6, 0.55);
  await pointerTravel(page, a.x, a.y);
  await page.mouse.down();
  for (const p of handPath(a, b)) await pointerTravel(page, p.x, p.y);
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await pollScene(page, (s) => (beltOn(s, cells) === undefined ? 'no belt' : 'belt'), {
    message: `${row.name}: the belt was drawn on ${JSON.stringify(cells)}`,
  }).toBe('belt');
  await armAndPlaceAt(page, 'Router', ROUTER_X, row.y);
  await pollScene(page, (s) => nodeAtAnchor(s, ROUTER_X, row.y)?.kind ?? -1, {
    message: `${row.name}: the palette Router was placed at (${ROUTER_X},${row.y})`,
  }).toBe(KIND_ROUTER);
  const s = await readScene(page);
  const router = nodeAtAnchor(s, ROUTER_X, row.y)!;
  const out = router.ports
    .filter((p) => p.role === ROLE_OUT && p.side === E && p.medium === 0)
    .sort((p, q) => p.cell_y - q.cell_y)[0];
  expect(out, `${row.name}: the Router has a Mechanical output facing East`).toBeDefined();
  expect(doorstep(out), `${row.name}: the Router's top output faces the belt's first tile`).toEqual(cells[0]);
  expect(docksOf(beltOn(s, cells), router), `${row.name}: PRECONDITION: the belt is loose (placing docked nothing)`).toBe('');
  await deselectOnFloor(page, row.floor, `${row.name}: after the build`);
  return { router, out, cells };
}

/** Build both rows at scale 1; for the second, zoom below 1 first. Hands back each row as it is walked. */
async function walk(page: Page, leg: (row: Row, built: Built) => Promise<void>): Promise<void> {
  const cells = ROWS.flatMap((r) => [
    [ROUTER_X, r.y] as const,
    [ROUTER_X + 2, r.y] as const,
    [ROUTER_X + 1 + BELT_LEN, r.y] as const,
    [ROUTER_X + 5, r.y + 3] as const,
    ...r.floor,
  ]);
  await emptyBoardAtScaleOne(page, cells);
  const built: Built[] = [];
  for (const row of ROWS) built.push(await buildRow(page, row));
  await expectRenderLoopAlive(page, 'with both rows built');
  for (let i = 0; i < ROWS.length; i += 1) {
    const row = ROWS[i];
    if (i === 0) {
      expect((await cameraOf(page)).scale, `${row.name}: walked at camera scale 1`).toBe(1);
    } else {
      const scale = await zoomBelowOne(page, built[i].cells[0]);
      console.log(`P89-W113 ${row.name}: camera scale ${scale}`);
    }
    await leg(row, built[i]);
    await expectRenderLoopAlive(page, `after the ${row.name} leg`);
  }
}

/** The Router output dot as a hand presses it: 2 world px inside the machine's edge, 2 px low. */
async function onTheDot(page: Page, out: PortFacts): Promise<{ x: number; y: number }> {
  const nub = nubAnchor(out.cell_x, out.cell_y, out.side);
  return screenPoint(page, { x: nub.x - 2, y: nub.y + 2 });
}

/** A floor point three cells away from the row, the far end of the hand's detour. */
async function detour(page: Page, row: Row): Promise<{ x: number; y: number }> {
  return cellPoint(page, ROUTER_X + 5, row.y + 3, 0.4, 0.6);
}

/** The Router's panel lists exactly one output that reads connected (`idle`, `moving` or `backed up`). */
async function expectOneConnectedOutput(page: Page, row: Row, router: NodeFacts): Promise<void> {
  await selectMachineAt(page, ROUTER_X, row.y);
  const ports = page.getByRole('region', { name: 'Ports' });
  await expect(
    ports.getByRole('listitem', {
      name: new RegExp(`^Output[^,]*, (${PORT_STATUS.idle}|${PORT_STATUS.moving}|${PORT_STATUS.backedUp})$`),
    }),
    `${row.name}: exactly one of the Router's output rows reads idle, moving or backed up (the belt's start)`,
  ).toHaveCount(1);
  await expect(
    ports.getByRole('listitem', { name: /^Output[^,]*, idle$/ }),
    `${row.name}: that output row reads idle: the belt is still, and nothing is on it yet`,
  ).toHaveCount(1);
  expect((await selectionOf(page)).node, `${row.name}: the panel read is the Router's`).toBe(router.id);
  await deselectOnFloor(page, row.floor, `${row.name}: after the Router panel`);
}

test.describe("89 live: connect from a machine's output dot, and from a belt's end tile, with no tool (BELT-04, W113)", () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    // Leg 2 counts the Dock frames the page sends (review WR-C-03); the sniffer goes in before boot.
    await installFrameSniffer(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the connect-from-an-output walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test("1: a drag from a Router's output dot onto a loose belt's first tile connects them, and the selection never changes", async ({
    page,
  }) => {
    await walk(page, async (row, { router, out, cells }) => {
      expect(await selectionOf(page), `${row.name}: nothing is selected before the press`).toEqual({ node: null, belt: null });
      const start = await onTheDot(page, out);
      const end = await cellPoint(page, cells[0][0], cells[0][1], 0.8, 0.45);
      const tags = await page.evaluate((ps) => ps.map((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null), [start, end]);
      expect(tags, `${row.name}: the drag starts and ends on the canvas, not under chrome`).toEqual(['CANVAS', 'CANVAS']);
      const moves = await handDragVia(page, start, await detour(page, row), end);
      expect(moves, `${row.name}: the hand moved through many samples, not one teleport`).toBeGreaterThanOrEqual(10);
      expect(await selectionOf(page), `${row.name}: the selection did not change: still nothing selected`).toEqual({
        node: null,
        belt: null,
      });
      await pollScene(page, (s) => docksOf(beltOn(s, cells), router), {
        message: `${row.name}: the belt's start (its Tail) is docked to the Router's output`,
      }).toBe('Tail@router');
      const belt = beltOn(await readScene(page), cells)!;
      console.log(`P89-W113 ${row.name}: drag moves=${moves} belt=${belt.id} docks=${JSON.stringify(belt.docks)}`);
      expect(await selectionOf(page), `${row.name}: still nothing selected once the Dock folded`).toEqual({ node: null, belt: null });
      await expectOneConnectedOutput(page, row, router);
    });
  });

  test("2: a plain click on the Router's output dot selects the Router and connects nothing", async ({ page }) => {
    await walk(page, async (row, { router, out, cells }) => {
      const at = await onTheDot(page, out);
      const docksBefore = await sentCount(page, CMD.Dock);
      await clickAt(page, at.x, at.y);
      await expect(page.locator('#fab-config-heading'), `${row.name}: the click on the dot opened the Router's panel`).toBeVisible();
      expect(await selectionOf(page), `${row.name}: the click on the dot selected the Router`).toEqual({ node: router.id, belt: null });
      // The negative reads wait for the host (review WR-C-03): the panel is local state, and a Dock
      // sent on the click needs a round trip and a fold. The wire is read too, so a Dock the host
      // refused would still count.
      const t0 = (await readScene(page)).tick;
      await pollScene(page, (s) => s.tick >= t0 + 40, { message: `${row.name}: the host ran past the click` }).toBe(true);
      expect((await sentCount(page, CMD.Dock)) - docksBefore, `${row.name}: the click sent no Dock`).toBe(0);
      expect(docksOf(beltOn(await readScene(page), cells), router), `${row.name}: the click docked nothing`).toBe('');
      await deselectOnFloor(page, row.floor, `${row.name}: after the click`);
    });
  });

  test("4: the right button pressed mid output-dot drag, the left still held, cancels it and connects nothing", async ({ page }) => {
    // Review CR-B-01 (UI-SPEC A14). A real mouse reports the right press as a chorded move, never
    // as a down: measured in this Chromium (`P89-CHORD`, 89-REVIEW-DISPOSITION.md), the press is
    // `pointermove` buttons 3 and the release `pointermove` buttons 1, and Chromium then drops the
    // canvas's pointer capture, whose `lostpointercapture` ended the drag before the fix by accident
    // (so "docked nothing" alone was green there). The grade that can fail is the moment BETWEEN
    // the right press and its release: the drag ends at the press, so the `grabbing` cursor the
    // drag wears is gone before the right button lifts. Red before the fix: still `grabbing`.
    const cursor = (): Promise<string> => page.evaluate(() => document.querySelector('canvas')?.style.cursor ?? 'no canvas');
    await walk(page, async (row, { router, out, cells }) => {
      const start = await onTheDot(page, out);
      const end = await cellPoint(page, cells[0][0], cells[0][1], 0.8, 0.45);
      const path = [...handPath(start, await detour(page, row)), ...handPath(await detour(page, row), end)];
      await pointerTravel(page, start.x, start.y);
      await page.mouse.down();
      for (const q of path) await pointerTravel(page, q.x, q.y);
      expect(path.length, `${row.name}: the hand moved through many samples`).toBeGreaterThanOrEqual(10);
      expect(await cursor(), `${row.name}: NON-VACUITY: the output-dot drag is in flight (cursor grabbing)`).toBe('grabbing');
      await page.mouse.down({ button: 'right' });
      await expect
        .poll(cursor, { message: `${row.name}: the right press ended the drag: the grabbing cursor is gone before the right lifts` })
        .not.toBe('grabbing');
      await page.mouse.up({ button: 'right' });
      await pointerTravel(page, end.x + 1, end.y);
      await page.mouse.up();
      // The host runs past the release before the negative read (a Dock sent on it needs a round
      // trip and a fold).
      const t0 = (await readScene(page)).tick;
      await pollScene(page, (s) => s.tick >= t0 + 40, { message: `${row.name}: the host ran past the release` }).toBe(true);
      expect(docksOf(beltOn(await readScene(page), cells), router), `${row.name}: the cancelled drag docked nothing`).toBe('');
      expect(await selectionOf(page), `${row.name}: and selected nothing`).toEqual({ node: null, belt: null });
    });
  });

  test("3: a loose belt's first tile dragged onto the Router's output connects them, with nothing selected", async ({ page }) => {
    await walk(page, async (row, { router, out, cells }) => {
      expect(await selectionOf(page), `${row.name}: nothing is selected before the press`).toEqual({ node: null, belt: null });
      // The far half of the belt's first tile: inside that end tile, out of the output dot's reach.
      const start = await cellPoint(page, cells[0][0], cells[0][1], 0.8, 0.55);
      const end = await onTheDot(page, out);
      const moves = await handDragVia(page, start, await detour(page, row), end);
      expect(moves, `${row.name}: the hand moved through many samples, not one teleport`).toBeGreaterThanOrEqual(10);
      await pollScene(page, (s) => docksOf(beltOn(s, cells), router), {
        message: `${row.name}: the dragged belt start (its Tail) is docked to the Router's output`,
      }).toBe('Tail@router');
      expect(await selectionOf(page), `${row.name}: the selection did not change: still nothing selected`).toEqual({
        node: null,
        belt: null,
      });
      await expectOneConnectedOutput(page, row, router);
    });
  });
});
