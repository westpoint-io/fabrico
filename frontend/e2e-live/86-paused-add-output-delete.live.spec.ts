import { test, expect, type Page } from '@playwright/test';
import {
  addOutputViaPanel,
  anchorOf,
  armAndPlaceAt,
  cameraOf,
  demoCallerAndHandler,
  drawnNodesOf,
  expectRenderLoopAlive,
  newBoard,
  nodeAtAnchor,
  beltEndInstructionsOn,
  pointerTravel,
  pollScene,
  portNubInstructionsOn,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenPoint,
  restoreHostAfterFailedTest,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { nubAnchor } from '../shared/geometry';

// 86-paused-add-output-delete.live.spec.ts (plan 86-05, D-05, WORK-05, success criterion 3) -
// on a PAUSED board a user edits a machine and deletes it before pressing Play, then presses
// Ctrl+Z. The machine comes back as it stood when it was deleted, the edit included. On the
// REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks,
// zero injected packets. The spec reads the oracle (`window.__fabrico.scene()`, the MODEL),
// the port-nub overlay's instruction count and the machine layer's census, because a model
// read alone passes over a board that draws nothing (memory fabrico-model-oracle-blindspot).
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-05: a paused board holds every gesture until Play, and Play folds them all in ONE drain
// pass. The host now reads each Delete's whole capture (box, turn, ports, the belts and
// cables it takes) from the board that pass's fold will see at the Delete, not from the
// board before the pass. Before plan 86-05 it read the board before the pass, so an output
// added just before the Delete was not in the capture and Ctrl+Z brought the machine back
// without it.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE ADDED OUTPUT. On an empty board at zoom 1 a palette Factory is placed at (10,8)
//      and given two more outputs through its panel while the board plays (3 by 3, five
//      ports, three outputs: the `probe_p1` start). The board is paused. The Factory is
//      selected and `+ Add output` is pressed (a fourth output grows it to 3 by 4), then
//      the Factory is clicked again (the panel button keeps the key focus, and a focused
//      button swallows Delete) and Delete is pressed. Play folds the pass: the Factory is
//      gone. Ctrl+Z: the Factory is back at (10,8) on twelve cells (3 by 4), with six ports
//      at the cells and sides `probe_p1` measured, its four output nubs drawn (the overlay's
//      instruction count grew by one output's worth) and its body drawn.
//   2. THE DOCKED BELT. On an empty board at zoom 1 a palette Sink is placed at (17,9) and a
//      belt drawn (13,9) to (16,9) with the Belt tool: its Head docks into the Sink's In, its
//      Tail is free (no machine stands there yet). A palette Factory is placed at (10,8): its
//      Out at (12,9) faces E onto the belt's free Tail at (13,9). The board is paused. The
//      belt is selected and its Tail handle dragged onto the Factory's Out nub (a Dock, the
//      shipped reconnect gesture), the Factory is selected and Delete pressed. Play folds the
//      pass: the Factory and the belt it now holds are gone. Ctrl+Z: the Factory is back, the
//      belt is back on (13,9) to (16,9) docked at BOTH ends (Tail to the Factory's Out, Head to
//      the Sink's In), its end marks drawn for two docked ends (the marks' instruction count
//      above its Head-only count) and both machines drawn.
//
//      Why the belt stands before the pause. A belt drawn on a paused board has no handle
//      until Play folds it, and the app sends its Docks only after the belt's echo, so a
//      draw-from-the-nub on a paused board never puts a Dock into the same pass as the
//      Delete. A handle drag docks a belt that already stands, which is the pass the
//      Dock row of the same-pass todo names (`probe_d1_dock_then_delete`).
//
//   3. THE CABLE THE DELETE ALREADY TAKES (phase 86 review, CR-01). On the demo board the
//      board is paused, the caller Route is selected and Delete pressed, then the Route is
//      selected again and its panel's `Disconnect` pressed on the cable row (a Delete of the
//      cable the Route's Delete takes with it). Play folds the pass: the Route and its cable
//      are gone, and the Disconnect is refused in words ("That is no longer on the board.",
//      the `UnknownNode` sentence since plan 88-02, "That machine is no longer there." before,
//      the answer the same click gets once the Route's Delete has folded). Ctrl+Z: ONE press
//      brings the board back exactly as it was before the pause, the Route on its cells and
//      both cable legs on their cells. Before the fix the Disconnect was accepted with a
//      record read off nothing, and every Ctrl+Z after Play was refused ("The host could not
//      carry out that gesture."), so the Route never came back.
//
// Each leg watches page errors from before `goto` and asserts the render loop is alive
// after every gesture the board draws. A paused board draws no new frame, so the loop is
// not read between the pause and Play (a stalled frame counter there is the pause itself).
//
// RED ON THE UNCHANGED HOST, recorded in 86-EVIDENCE.md: in leg 1 the
// Factory came back 3 by 3 with five ports; in leg 2 it came back with no belt at all.

/** Kind bytes (protocol `machine_kind`). A number on purpose: the live suite imports
 *  no product source. */
const KIND_FACTORY = 2;
const KIND_SINK = 7;
/** Port role Out (oracle `PortFacts.role`). */
const ROLE_OUT = 1;
/** `STATUS_COPY.editsQueued`, transcribed, not imported. */
const QUEUED_COPY = 'Paused - edits queued until Play';

/** The Factory's anchor, and an empty floor cell clear of every node in every leg. */
const FACTORY_AT: [number, number] = [10, 8];
// (20,16), not the (4,6) it was: at the identity camera (4,6) is under the palette, so the
// "floor" click pressed a palette button (plan 86-08 measured it with the canvas check below).
const FLOOR_AT: [number, number] = [20, 16];
/** Leg 2: the Sink's anchor and the belt's four tiles, Tail first. */
const SINK_AT: [number, number] = [17, 9];
const BELT_CELLS: [number, number][] = [[13, 9], [14, 9], [15, 9], [16, 9]];

/** The Factory's twelve cells after the fourth output (3 by 4 at (10,8)), row-major. */
const FACTORY_3X4 = [
  '10,8', '11,8', '12,8',
  '10,9', '11,9', '12,9',
  '10,10', '11,10', '12,10',
  '10,11', '11,11', '12,11',
];
/** Its six ports in index order, as `x,y side role` (sides N=0 E=1 S=2 W=3; roles In=0
 *  Out=1 Fault=2): `probe_p1`'s measured rot-0 list (In (0,1) W, Out (2,1) E, Fault (1,3) S,
 *  Out (2,2) E, Out (2,0) E, Out (2,3) E) placed at (10,8). */
const FACTORY_3X4_PORTS = ['10,9 3 0', '12,9 1 1', '11,11 2 2', '12,10 1 1', '12,8 1 1', '12,11 1 1'];

type NodeFacts = SceneFacts['nodes'][number];

/** The toolbar's transport toggle: `Pause` while playing, `Play` while paused. */
function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** The toolbar status readout: the first `header [role="status"]`. */
function statusReadout(page: Page) {
  return page.locator('header [role="status"]').first();
}

/** Press Play if the toolbar offers it, then wait for the tick to advance. */
async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0, { message: 'the sim runs again', timeout: 10_000 }).toBe(true);
}

/** Pause and wait until two tick reads 200 ms apart agree. */
async function pauseAndSettle(page: Page, leg: string): Promise<void> {
  await transport(page).click();
  await expect(transport(page), `${leg}: the sim is paused (the toggle offers Play)`).toHaveAttribute('aria-label', 'Play');
  let last = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === last;
        last = t;
        return settled;
      },
      { message: `${leg}: the host stopped ticking`, intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
}

/** An empty, playing board at camera scale 1. */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  // THE CAMERA DEPENDS ON THE SPEC BEFORE THIS ONE (found by plan 86-08's full live pass). The
  // app frames the board it boots into (NAV-01), and New keeps that camera, so after
  // `86-over-cap-label-edit` leaves its label at (20,24) a 100% reset keeps the pan there and
  // (10,8) lands above the canvas: the palette click armed, the board click placed nothing.
  // Opened again on the empty board, the app has no node to frame and boots at its identity
  // camera, whatever ran before.
  await page.goto('/');
  await waitForAppReady(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  for (const [cx, cy] of [FACTORY_AT, FLOOR_AT, SINK_AT, ...BELT_CELLS]) {
    const pt = await screenCellCentre(page, cx, cy);
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
    expect(under, `cell (${cx},${cy}) is on the open canvas, where a click reaches the board`).toBe('CANVAS');
  }
  await resumeIfPaused(page);
}

/** Click empty floor a few px off a cell centre (blurs the panel, clears the selection). */
async function clickFloor(page: Page): Promise<void> {
  const floor = await screenCellCentre(page, FLOOR_AT[0], FLOOR_AT[1]);
  await page.mouse.click(floor.x + 3, floor.y - 2);
}

/** The one node of `kind` on the board, or null when there is none or more than one. */
function onlyOf(scene: SceneFacts, kind: number): NodeFacts | null {
  const ns = scene.nodes.filter((n) => n.kind === kind);
  return ns.length === 1 ? ns[0] : null;
}

/** A node's cells, sorted row-major, as `x,y` strings, so a literal list compares. */
function sortedCells(node: NodeFacts): string[] {
  return [...node.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([x, y]) => `${x},${y}`);
}

/** What the user sees of the Factory: its cells and its ports in index order. */
function factoryShape(scene: SceneFacts): { cells: string[]; ports: string[] } | null {
  const f = onlyOf(scene, KIND_FACTORY);
  if (f === null) return null;
  const ports = [...f.ports].sort((a, b) => a.index - b.index).map((p) => `${p.cell_x},${p.cell_y} ${p.side} ${p.role}`);
  return { cells: sortedCells(f), ports };
}

/**
 * The port-nub overlay's instruction count on `id` once two reads 200 ms apart agree, and, when
 * `changedFrom` is given, once it no longer reads that count.
 *
 * WHY `changedFrom` (plan 88-02's gate run, `touched-2`). Two reads 200 ms apart can both land on
 * the SAME drawn frame on a slow page (the CPU quota draws under 5 frames a second), so right after
 * an `+ Add output` echo the overlay could read "settled" at the count it had BEFORE the add, and
 * leg 1's `perOutput` read 0. A read taken after an add waits for the overlay to draw the add first;
 * an overlay that never draws it still fails, on this poll's message.
 */
async function settledNubs(page: Page, id: number, ctx: string, changedFrom?: number): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const n = await portNubInstructionsOn(page, id);
        const settled = n === last && n > 0 && n !== changedFrom;
        last = n;
        return settled;
      },
      { message: `${ctx}: the nub overlay on node ${id} settled${changedFrom === undefined ? '' : ` off ${changedFrom}`}`, intervals: [200] },
    )
    .toBe(true);
  return last;
}

/** How many outputs the one Factory has, or -1 when there is not exactly one. */
function factoryOuts(scene: SceneFacts): number {
  return onlyOf(scene, KIND_FACTORY)?.ports.filter((p) => p.role === ROLE_OUT).length ?? -1;
}

/** The one belt on the board, by its tiles and its docks (each as `end node port`), or null. */
function beltShape(scene: SceneFacts): { tiles: string[]; docks: string[] } | null {
  if (scene.belts.length !== 1) return null;
  const b = scene.belts[0];
  return {
    tiles: b.tiles.map((t) => `${t.cell_x},${t.cell_y}`),
    docks: b.docks.map((d) => `${d.end} ${d.node} ${d.port}`).sort(),
  };
}

/** The belt end marks' instruction count on `id` once two reads 200 ms apart agree. */
async function settledEnds(page: Page, id: number, ctx: string): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const n = await beltEndInstructionsOn(page, id);
        const settled = n === last && n > 0;
        last = n;
        return settled;
      },
      { message: `${ctx}: the end marks on belt ${id} settled`, intervals: [200] },
    )
    .toBe(true);
  return last;
}

/** `RefusalMessage`'s sentence for `UnknownNode`, transcribed, not imported. Reworded by plan
 *  88-02 (D-03) to name no kind: a gone label or belt reads it too. */
const NO_LONGER_THERE = 'That is no longer on the board.';
/** The caller Route's electrical Out row control in the Ports region (`28-undo-restores-the-cable`). */
const DISCONNECT_CONTROL_NAME = 'Disconnect Output - Wire';

/** The board with every id erased: each node by kind, anchor and cells, each belt by its tiles
 *  and docks, each cable by its two ends and its cells, every end named by its node's anchor.
 *  A restored node is newly minted with a new id, so this is what "exactly as it was" compares. */
function boardWithoutIds(scene: SceneFacts): { nodes: string[]; belts: string[]; wires: string[] } {
  const at = (id: number): string => {
    const n = scene.nodes.find((m) => m.id === id);
    return n === undefined ? `gone ${id}` : `${n.kind}@${anchorOf(n).join(',')}`;
  };
  const nodes = scene.nodes.map((n) => `${at(n.id)} ${sortedCells(n).join(' ')}`).sort();
  const belts = scene.belts
    .map((b) => `${b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' ')} | ${b.docks.map((d) => `${d.end} ${at(d.node)} ${d.port}`).sort().join(' ')}`)
    .sort();
  const wires = scene.wires
    .map((w) => `${at(w.from.node)}:${w.from.port} -> ${at(w.to.node)}:${w.to.port} | ${w.path.map((c) => `${c.cell_x},${c.cell_y}`).join(' ')}`)
    .sort();
  return { nodes, belts, wires };
}

/** A cell no node, belt or cable stands on, whose centre is on the open canvas: a click there
 *  blurs the panel and clears the selection. */
async function emptyCanvasCell(page: Page, scene: SceneFacts): Promise<[number, number]> {
  const taken = new Set<string>();
  for (const n of scene.nodes) for (const [x, y] of n.cells) taken.add(`${x},${y}`);
  for (const b of scene.belts) for (const t of b.tiles) taken.add(`${t.cell_x},${t.cell_y}`);
  for (const w of scene.wires) for (const c of w.path) taken.add(`${c.cell_x},${c.cell_y}`);
  for (let y = 0; y <= 14; y++) {
    for (let x = 0; x <= 30; x++) {
      if (taken.has(`${x},${y}`) || taken.has(`${x - 1},${y}`) || taken.has(`${x + 1},${y}`)) continue;
      if (taken.has(`${x},${y - 1}`) || taken.has(`${x},${y + 1}`)) continue;
      const pt = await screenCellCentre(page, x, y);
      const under = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
      if (under === 'CANVAS') return [x, y];
    }
  }
  throw new Error('no empty on-canvas cell near the demo board');
}

/** Start an in-page latch on `#fab-refusal`: every non-empty text it ever held, in order. A
 *  MutationObserver, so a sentence that shows and goes between two polls is still recorded. */
async function latchRefusals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __refusalsSeen?: string[] };
    const seen: string[] = [];
    w.__refusalsSeen = seen;
    const region = document.getElementById('fab-refusal');
    if (!region) throw new Error('#fab-refusal is not mounted');
    const record = (): void => {
      const text = (region.textContent ?? '').trim();
      if (text !== '' && seen[seen.length - 1] !== text) seen.push(text);
    };
    record();
    new MutationObserver(record).observe(region, { subtree: true, childList: true, characterData: true });
  });
}

async function refusalsSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __refusalsSeen: string[] }).__refusalsSeen);
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('86-05 live: a machine edited and deleted on a paused board comes back from Ctrl+Z with the edit', () => {
  test('leg 1: paused, + Add output then Delete on a Factory, Play, Ctrl+Z: the Factory is back 3 by 4 with its fourth output drawn', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    try {
      await armAndPlaceAt(page, 'Factory', FACTORY_AT[0], FACTORY_AT[1]);
      await pollScene(page, factoryOuts, { message: 'leg 1: the real host echoed a palette Factory with one output' }).toBe(1);
      const placed = onlyOf(await readScene(page), KIND_FACTORY)!;
      await expectRenderLoopAlive(page, 'leg 1, after the place');
      const nubs1 = await settledNubs(page, placed.id, 'leg 1, one output');

      await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
      await addOutputViaPanel(page, 2);
      const nubs2 = await settledNubs(page, placed.id, 'leg 1, two outputs', nubs1);
      await addOutputViaPanel(page, 3);
      const nubs3 = await settledNubs(page, placed.id, 'leg 1, three outputs', nubs2);
      const perOutput = nubs2 - nubs1;
      expect(perOutput, 'leg 1: MEASURED, an added output adds nub instructions').toBeGreaterThan(0);
      expect(nubs3 - nubs2, 'leg 1: MEASURED, each added output adds the same nub instructions').toBe(perOutput);
      const before = factoryShape(await readScene(page))!;
      expect(before.cells.length, 'leg 1: MEASURED, three outputs keep the Factory 3 by 3').toBe(9);
      expect(before.ports.length, 'leg 1: MEASURED, the Factory has five ports').toBe(5);
      await clickFloor(page);
      await expect(page.locator('#fab-config-heading'), 'leg 1: the floor click closed the panel').toHaveCount(0);

      await pauseAndSettle(page, 'leg 1');
      await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
      await page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: '+ Add output' }).click();
      await expect(statusReadout(page), 'leg 1: the paused add is queued').toHaveText(QUEUED_COPY);
      // The panel button holds the key focus and a focused button swallows Delete, so the
      // Factory is clicked on the board again, as a hand does before pressing the key.
      await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      expect(factoryShape(await readScene(page)), 'leg 1: paused, nothing has folded yet').toEqual(before);

      await resumeIfPaused(page);
      await pollScene(page, (s) => onlyOf(s, KIND_FACTORY) === null, {
        message: 'leg 1: Play folds the pass: the Factory is gone',
      }).toBe(true);
      await expectRenderLoopAlive(page, 'leg 1, after Play');

      await clickFloor(page);
      await page.keyboard.press('Control+z');
      await pollScene(page, factoryShape, {
        message:
          'leg 1: Ctrl+Z brought the Factory back as it stood at the Delete: 3 by 4 at (10,8), six ports, four outputs, the fourth at (12,11) facing E',
      }).toEqual({ cells: FACTORY_3X4, ports: FACTORY_3X4_PORTS });
      const back = onlyOf(await readScene(page), KIND_FACTORY)!;
      expect(nodeAtAnchor(await readScene(page), FACTORY_AT[0], FACTORY_AT[1])?.id, 'leg 1: the restored Factory is seated at (10,8)').toBe(back.id);
      await expect
        .poll(async () => portNubInstructionsOn(page, back.id), {
          message: 'leg 1: the restored Factory draws four output nubs (one output more than before the pause)',
        })
        .toBe(nubs3 + perOutput);
      await expect
        .poll(async () => (await drawnNodesOf(page)).machines, { message: 'leg 1: the machine layer draws the restored Factory' })
        .toEqual([back.id]);
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });
  test('leg 2: paused, a belt Tail dragged onto the Factory Out then Delete, Play, Ctrl+Z: the belt is back docked at both ends', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    try {
      await armAndPlaceAt(page, 'Sink', SINK_AT[0], SINK_AT[1]);
      await pollScene(page, (s) => onlyOf(s, KIND_SINK) !== null, { message: 'leg 2: the real host echoed a palette Sink' }).toBe(true);
      const sink = onlyOf(await readScene(page), KIND_SINK)!;

      await page.getByTitle(/^Draw belts/).click();
      const first = await screenCellCentre(page, BELT_CELLS[0][0], BELT_CELLS[0][1]);
      await pointerTravel(page, first.x, first.y);
      await page.mouse.down();
      for (const [cx, cy] of BELT_CELLS.slice(1)) {
        const p = await screenCellCentre(page, cx, cy);
        await pointerTravel(page, p.x, p.y, 2);
      }
      await page.mouse.up();
      await page.keyboard.press('Escape');
      const tiles = BELT_CELLS.map(([x, y]) => `${x},${y}`);
      await pollScene(page, beltShape, {
        message: 'leg 2: the belt stands on (13,9) to (16,9) with its Head docked into the Sink and its Tail free',
      }).toEqual({ tiles, docks: [`Head ${sink.id} 0`] });
      const belt = (await readScene(page)).belts[0];
      const headOnlyEnds = await settledEnds(page, belt.id, 'leg 2, Head docked only');

      await armAndPlaceAt(page, 'Factory', FACTORY_AT[0], FACTORY_AT[1]);
      await pollScene(page, factoryOuts, { message: 'leg 2: the real host echoed a palette Factory with one output' }).toBe(1);
      const factory = onlyOf(await readScene(page), KIND_FACTORY)!;
      const out = factory.ports.find((p) => p.role === ROLE_OUT)!;
      expect([out.cell_x + 1, out.cell_y], 'leg 2: MEASURED, the Factory Out faces E onto the belt Tail at (13,9)').toEqual(BELT_CELLS[0]);
      // A dock names an Out by its position among the machine's outputs (the link key the
      // host writes, `GridCommand::Unlink`'s keyspace note), not by its catalog index.
      const outKey = factory.ports.filter((p) => p.role === ROLE_OUT).findIndex((p) => p.index === out.index);
      expect(beltShape(await readScene(page)), 'leg 2: placing the Factory docked nothing').toEqual({ tiles, docks: [`Head ${sink.id} 0`] });
      await expectRenderLoopAlive(page, 'leg 2, before the pause');

      await pauseAndSettle(page, 'leg 2');
      const mid = await screenCellCentre(page, BELT_CELLS[2][0], BELT_CELLS[2][1]);
      await page.mouse.click(mid.x, mid.y);
      await expect
        .poll(() => page.evaluate(() => (window as { __fabrico?: { selectedBelt?(): number | null } }).__fabrico?.selectedBelt?.() ?? null), {
          message: 'leg 2: the click selected the belt (its end handles are up)',
        })
        .toBe(belt.id);
      const nub = await screenPoint(page, nubAnchor(out.cell_x, out.cell_y, out.side));
      await pointerTravel(page, first.x, first.y);
      await page.mouse.down();
      await pointerTravel(page, nub.x, nub.y, 4);
      await page.mouse.up();
      await expect(statusReadout(page), 'leg 2: the paused Dock is queued').toHaveText(QUEUED_COPY);
      await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      expect(beltShape(await readScene(page)), 'leg 2: paused, nothing has folded yet').toEqual({ tiles, docks: [`Head ${sink.id} 0`] });

      await resumeIfPaused(page);
      await pollScene(page, (s) => onlyOf(s, KIND_FACTORY) === null && s.belts.length === 0, {
        message: 'leg 2: Play folds the pass: the Dock joins the belt to the Factory and the Delete takes both',
      }).toBe(true);
      await expectRenderLoopAlive(page, 'leg 2, after Play');

      await clickFloor(page);
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => onlyOf(s, KIND_FACTORY) !== null && s.belts.length === 1, {
        message: 'leg 2: Ctrl+Z brought the Factory back WITH the belt it held',
      }).toBe(true);
      const back = onlyOf(await readScene(page), KIND_FACTORY)!;
      expect(sortedCells(back), 'leg 2: the Factory is back on its nine cells at (10,8)').toEqual(sortedCells(factory));
      await pollScene(page, beltShape, {
        message: 'leg 2: the belt is back on (13,9) to (16,9), docked at BOTH ends: Tail to the Factory Out, Head to the Sink In',
      }).toEqual({ tiles, docks: [`Head ${sink.id} 0`, `Tail ${back.id} ${outKey}`].sort() });
      const restored = (await readScene(page)).belts[0];
      await expect
        .poll(async () => beltEndInstructionsOn(page, restored.id), {
          message: 'leg 2: the restored belt draws the end marks of two docked ends (more than its Head-only marks)',
        })
        .toBeGreaterThan(headOnlyEnds);
      await expect
        .poll(async () => (await drawnNodesOf(page)).machines, { message: 'leg 2: the machine layer draws the Factory and the Sink' })
        .toEqual([back.id, sink.id].sort((a, b) => a - b));
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });
  test('leg 3: paused, Delete the caller Route then Disconnect its cable, Play, one Ctrl+Z: the board is back exactly as it was', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);
    // New first, so the demo's arrival is the swap `resetToDemo` waits for (from a demo-shaped
    // board it needs a tick drop, which a CPU-quota run can miss: deferred-items, 86-02).
    await newBoard(page);
    await resetToDemo(page);
    await waitForCameraSettle(page);
    try {
      await resumeIfPaused(page);
      const { caller } = await demoCallerAndHandler(page);
      const callerAt = anchorOf(caller);
      const before = await readScene(page);
      const shapeBefore = boardWithoutIds(before);
      expect(shapeBefore.wires.length, 'leg 3: MEASURED, the demo carries the two legs of its request cable').toBe(2);
      const floor = await emptyCanvasCell(page, before);
      await expectRenderLoopAlive(page, 'leg 3, on the demo board');

      await pauseAndSettle(page, 'leg 3');
      await latchRefusals(page);
      await selectMachineAt(page, callerAt[0], callerAt[1]);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(300);
      expect(boardWithoutIds(await readScene(page)), 'leg 3: paused, the Delete has not folded yet').toEqual(shapeBefore);
      await selectMachineAt(page, callerAt[0], callerAt[1]);
      await page.getByRole('button', { name: DISCONNECT_CONTROL_NAME }).click();
      await expect(statusReadout(page), 'leg 3: the paused Delete and Disconnect are queued').toHaveText(QUEUED_COPY);

      await resumeIfPaused(page);
      await pollScene(page, (s) => s.nodes.every((n) => n.id !== caller.id) && s.wires.length === 0, {
        message: 'leg 3: Play folds the pass: the caller Route and both cable legs are gone',
      }).toBe(true);
      await expect
        .poll(async () => refusalsSeen(page), {
          message: 'leg 3: the Disconnect of a cable the Delete already took is refused in words',
        })
        .toEqual([NO_LONGER_THERE]);
      await expectRenderLoopAlive(page, 'leg 3, after Play');

      const [fx, fy] = floor;
      const pt = await screenCellCentre(page, fx, fy);
      await page.mouse.click(pt.x, pt.y);
      await expect(page.locator('#fab-config-heading'), 'leg 3: the floor click closed the panel').toHaveCount(0);
      await page.keyboard.press('Control+z');
      await pollScene(page, boardWithoutIds, {
        message:
          'leg 3: ONE Ctrl+Z brought the board back exactly as it was before the pause: the Route on its cells, both cable legs on their cells',
      }).toEqual(shapeBefore);
      expect(await refusalsSeen(page), 'leg 3: the Ctrl+Z was not refused').toEqual([NO_LONGER_THERE]);
      const back = nodeAtAnchor(await readScene(page), callerAt[0], callerAt[1]);
      expect(back?.kind, 'leg 3: a Route stands at the caller anchor again').toBe(caller.kind);
      await expect
        .poll(async () => (await drawnNodesOf(page)).machines.includes(back!.id), {
          message: 'leg 3: the machine layer draws the restored Route',
        })
        .toBe(true);
    } finally {
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });
});
