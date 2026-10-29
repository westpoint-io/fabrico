import { test, expect, type Page } from '@playwright/test';
import {
  captureRefusalText,
  DEMO_NODE_COUNT,
  CELL,
  armAndPlaceAt,
  cameraOf,
  clickAt,
  expectRenderLoopAlive,
  newBoard,
  nubAnchor,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  rotateHandle,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 74.1-belt-refusals-say-why.live.spec.ts (plan 74.1-18, review WR-03 and gap N4c) - every
// refusal a belt causes says so in belt words, on the REAL host (dev_render_server, real
// Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// On review WR-03, 2026-10-04, the choice was "Refuse, say why": a Router with a belt on its
// first output cannot turn (plan 74.1-14 moved that output to the middle row, so the turned
// box covers the belt's first tile). Before this plan R answered with the FootprintCollision
// sentence, about a taken space, which names neither the belt nor the fix.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. The demo Router selected, r pressed: the host refuses with `Turning would cover a
//      belt. Move that belt first.`, every node, belt and link is unchanged, and the canvas
//      paints the reject flash (on the belt in the way; the gesture unit cases pin WHICH
//      tile, this leg proves it is painted in the real app).
//   2. The demo Factory selected, `+ Add output` pressed three times: the first two fit its
//      3x3 box, the third (the fourth output) would grow the box south over the fault
//      belt's first tile (5,5). The host refuses with `Growing would cover a belt. Move
//      that belt first.` and the ports, box and links are unchanged. Before this plan it
//      read the FootprintCollision sentence, about a taken space.
//   3. On an empty board at scale 1, a side belt's last-tile dot dragged onto the first
//      tile of a main belt TWO tiles away: the host refuses with `These ends do not
//      touch.` (plan 74.1-24, gap J11) and nothing links. Before plan 74.1-18 it read the
//      output-and-input sentence that was judged an error that explains nothing (gap N4c);
//      from 74.1-18 to 74.1-24 the one belt-rule sentence, whose clause actually broken
//      was its vaguest.
//   4. THE CONTROL: a MACHINE-target role refusal still reads the InvalidDock sentence
//      (`A belt runs from an output to an input, right next to it.`). A belt's last-tile dot
//      dropped on a Factory's OUTPUT nub, with the belt end on that output's doorstep and
//      leaving it straight, so the role rule is the only one broken. Green before and after
//      this plan: it proves the belt-join tag did not swallow a machine target.
//
//   5. THE U-TURN (plan 74.1-24, gaps N4D and J11): the re-walk's N4D board, a top belt four
//      cells east and a bottom belt starting right under its last tile running west. Way 1
//      drags the top belt's last-tile dot down onto the bottom belt's first tile; way 2, on
//      a fresh board, drags the bottom belt's first-tile dot up onto the top belt's last
//      tile. Both are refused with `A join cannot turn back the way it came.` and nothing
//      links. Before plan 74.1-24 both read the one rule sentence, whose "side by side" the
//      walk read as approving the U-turn.
//
//   6. THE ROTATE HANDLE (plan 74.1-25, review WR-04): leg 1's board and flash latch, the
//      Router turned by a click on its rotate handle instead of r. The same sentence, the
//      same unchanged board, and the canvas paints the reject flash on the belt in the way.
//      RED BEFORE THE FIX: the handle sent the Rotate and flashed nothing, so "Move that belt
//      first." pointed at no belt.
//
//   7. HEAD-WORDS (plan 74.1-32): a belt's last tile joined to a second belt's first tile,
//      then that joined end pressed off-centre inside its tile and dropped on a third belt's
//      free first tile one step away, turning across. The host refuses with `That belt end
//      is already joined. Use a free end.` and nothing changes. Before plan 74.1-32 it read
//      "That output is already connected. Disconnect it first.", naming an output for a belt
//      end the user dragged (the third re-walk's FINDING HEAD-WORDS).
//
//   8. J11-THIRD (plan 74.1-32): a belt's last tile dropped on another belt's last tile
//      right beside it (the role rule is the only one broken). The host refuses with `Join a
//      belt's end to the start of another belt.` and nothing links. Before plan 74.1-32 it
//      read "A belt's end joins only a belt starting right next to it, never turning
//      back.", which explained this refusal through one word (FINDING J11-THIRD).
//
// EVERY POINTER FIXTURE IN LEGS 3 TO 5 MOVES LIKE A HAND (`74.1-belt-join-both-ways.live.spec.ts`'s
// discipline): presses and drops land on off-centre points inside tiles, and every move
// emits sub-cell samples, so the first samples stay inside the pressed tile.
//
// Every leg compares the board's STRUCTURE before and after (node cells and ports, belt
// tiles and docks, wire endpoints), never item positions, which move on their own.
//
// MODEL FIRST, THEN RENDER HEALTH: the scene oracle reads the decoded packet, which keeps
// advancing with a dead renderer, so every leg opens with `watchPageErrors` before `goto`
// and closes with `expectRenderLoopAlive`.

/** `machine_kind::ROUTER` (`frontend/src/protocol/kinds.ts`). */
const ROUTER_KIND = 5;

/** `machine_kind::FACTORY`. */
const FACTORY_KIND = 2;

/** The exact `REFUSAL_COPY.RotateCoversBelt` sentence, transcribed, not imported. */
const ROTATE_COVERS_BELT_COPY = 'Turning would cover a belt. Move that belt first.';
/** The exact `REFUSAL_COPY.GrowCoversBelt` sentence, transcribed, not imported. */
const GROW_COVERS_BELT_COPY = 'Growing would cover a belt. Move that belt first.';
/** The exact `REFUSAL_COPY.InvalidDock` sentence, transcribed, not imported. */
const INVALID_DOCK_COPY = 'A belt runs from an output to an input, right next to it.';
/** The exact `REFUSAL_COPY.BeltEndsApart` sentence (plan 74.1-24, gap J11), transcribed. */
const BELT_ENDS_APART_COPY = 'These ends do not touch.';

/** Leg 3's main belt: four cells east, Tail (4,6). */
const MAIN_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** Leg 3's side belt: three cells south, Head (4,4), TWO tiles above the main belt's Tail. */
const SIDE_CELLS: readonly (readonly [number, number])[] = [
  [4, 2],
  [4, 3],
  [4, 4],
];
/** The exact `REFUSAL_COPY.BeltJoinTurnsBack` sentence (plan 74.1-24, gap J11), transcribed. */
const BELT_JOIN_TURNS_BACK_COPY = 'A join cannot turn back the way it came.';

/** Leg 5's top belt (the re-walk's N4D board): four cells east, last tile (7,6). */
const UTURN_TOP_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** Leg 5's bottom belt: starts right under the top belt's last tile and runs west, first tile (7,7). */
const UTURN_BOTTOM_CELLS: readonly (readonly [number, number])[] = [
  [7, 7],
  [6, 7],
  [5, 7],
];

/** The exact `REFUSAL_COPY.BeltEndTaken` sentence (plan 74.1-32, HEAD-WORDS), transcribed. */
const BELT_END_TAKEN_COPY = 'That belt end is already joined. Use a free end.';
/** The exact `REFUSAL_COPY.InvalidBeltJoin` sentence (reworded by plan 74.1-32, J11-THIRD), transcribed. */
const INVALID_BELT_JOIN_COPY = "Join a belt's end to the start of another belt.";

/** Leg 7's upstream belt: four cells east, last tile (7,6). */
const JOINED_UP_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** Leg 7's downstream belt: three cells east, first tile (8,6), right after the upstream's last tile. */
const JOINED_DOWN_CELLS: readonly (readonly [number, number])[] = [
  [8, 6],
  [9, 6],
  [10, 6],
];
/** Leg 7's third belt: first tile (7,5), right above the upstream's last tile, running north. */
const THIRD_CELLS: readonly (readonly [number, number])[] = [
  [7, 5],
  [7, 4],
  [7, 3],
];
/** Leg 8's first belt: three cells east, last tile (6,6). */
const HEAD_A_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
];
/** Leg 8's second belt: two cells WEST, last tile (7,6), right beside the first belt's last tile. */
const HEAD_B_CELLS: readonly (readonly [number, number])[] = [
  [8, 6],
  [7, 6],
];

/** Pointer samples per one-cell move at scale 1: an eighth of a cell each. */
const STEPS_PER_CELL = 8;
/** The off-centre fractions a press and a drop land on inside a tile (never the centre). */
const PRESS_FRAC = [0.7, 0.7] as const;
const DROP_FRAC = [0.4, 0.6] as const;

/**
 * The board's structure as one string: every node's id, kind, cells and ports; every
 * belt's id, tiles (cell and kind) and docks; every wire's endpoints. Nothing that moves
 * on its own (items, tick, machine state, load) is in it, so two reads are equal exactly
 * when no command changed the board.
 */
function structure(scene: SceneFacts): string {
  const nodes = scene.nodes
    .map((n) => ({ id: n.id, kind: n.kind, cells: n.cells, ports: n.ports }))
    .sort((a, b) => a.id - b.id);
  const belts = scene.belts
    .map((b) => ({
      id: b.id,
      tiles: b.tiles,
      docks: [...b.docks].sort((x, y) => `${x.end}${x.node}${x.port}`.localeCompare(`${y.end}${y.node}${y.port}`)),
    }))
    .sort((a, b) => a.id - b.id);
  const wires = scene.wires.map((w) => ({ id: w.id, from: w.from, to: w.to })).sort((a, b) => a.id - b.id);
  return JSON.stringify({ nodes, belts, wires });
}

/** The number of Out ports (role 1) on a node. */
function outCount(node: SceneFacts['nodes'][number]): number {
  return node.ports.filter((p) => p.role === 1).length;
}

/** The one Factory on the board (the demo carries exactly one). */
function theFactory(scene: SceneFacts): SceneFacts['nodes'][number] {
  const fs = scene.nodes.filter((n) => n.kind === FACTORY_KIND);
  expect(fs, 'the board carries exactly one Factory').toHaveLength(1);
  return fs[0];
}

/** The SCREEN point at fraction (fx, fy) of cell (cx, cy). */
async function cellPoint(
  page: Page,
  cell: readonly [number, number],
  frac: readonly [number, number],
): Promise<{ x: number; y: number }> {
  return screenPoint(page, { x: (cell[0] + frac[0]) * CELL, y: (cell[1] + frac[1]) * CELL });
}

/** Draw a plain belt through `cells` with the armed Belt tool, sub-cell samples per cell. */
async function drawPlain(page: Page, cells: readonly (readonly [number, number])[]): Promise<void> {
  const start = await cellPoint(page, cells[0], [0.45, 0.55]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await cellPoint(page, [cx, cy], [0.55, 0.45]);
    await page.mouse.move(pt.x, pt.y, { steps: STEPS_PER_CELL });
  }
  await page.mouse.up();
}

/**
 * Select the belt under `select` (an interior tile), then press off-centre inside `press`
 * and walk in sub-cell steps to an off-centre point inside `drop`: the hand-like drag legs
 * 3 to 5 use, shared by legs 7 and 8.
 */
async function dragBeltEnd(
  page: Page,
  select: readonly [number, number],
  press: readonly [number, number],
  drop: readonly [number, number],
  what: string,
): Promise<void> {
  const mid = await cellPoint(page, select, [0.5, 0.5]);
  await clickAt(page, mid.x, mid.y);
  await expect(page.locator('#fab-belt-config'), `${what}: the dragged belt is selected`).toBeVisible({ timeout: 15_000 });
  const a = await cellPoint(page, press, PRESS_FRAC);
  const b = await cellPoint(page, drop, DROP_FRAC);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: STEPS_PER_CELL });
  await page.mouse.up();
}

/**
 * A new empty board at scale 1 with the Belt tool armed, `belts` drawn as plain belts in
 * order, then Escape. The caller asserts the dock set: a belt drawn straight on from
 * another belt's last tile joins it as it is drawn.
 */
async function boardOfBelts(page: Page, belts: readonly (readonly (readonly [number, number])[])[]): Promise<SceneFacts> {
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  await page.getByTitle(/^Draw belts/).click();
  for (const [i, cells] of belts.entries()) {
    await drawPlain(page, cells);
    await pollScene(page, (s) => s.belts.length, { message: `belt ${i + 1} was drawn` }).toBe(i + 1);
  }
  await page.keyboard.press('Escape');
  const built = await readScene(page);
  for (const cells of belts) {
    expect(beltAt(built, cells[0])?.tiles.map((t) => [t.cell_x, t.cell_y]), `the belt starting at ${cells[0]}`).toEqual(
      cells.map(([x, y]) => [x, y]),
    );
  }
  return built;
}

/** The belt with a tile on `cell`, or undefined. */
function beltAt(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/** Whether the reject flash Graphics holds any plotted geometry right now. */
async function flashPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { rejectFlashInstructions?: () => number } }).__fabrico;
    if (!hook || typeof hook.rejectFlashInstructions !== 'function') {
      throw new Error('window.__fabrico.rejectFlashInstructions() not installed');
    }
    return hook.rejectFlashInstructions() > 0;
  });
}

/** Start a per-frame latch that records whether the reject flash was ever painted. */
async function latchFlash(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabrico: { rejectFlashInstructions(): number };
      __flashSeen?: boolean;
    };
    w.__flashSeen = false;
    const tick = (): void => {
      if (w.__fabrico.rejectFlashInstructions() > 0) {
        w.__flashSeen = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** The latch's reading. */
async function flashSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __flashSeen?: boolean }).__flashSeen === true);
}

/** The demo board, freshly reset, with render health watched from before `goto`. */
async function bootOnDemo(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  return errs;
}

test.describe.configure({ mode: 'serial' });

test.describe('74.1-18 live: a refusal a belt causes says so in belt words', () => {
  test('leg 1 (WR-03): r on the demo Router is refused with the belt sentence and the board does not change', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    const before = await readScene(page);
    const routers = before.nodes.filter((n) => n.kind === ROUTER_KIND);
    expect(routers, 'the demo board carries exactly one Router').toHaveLength(1);
    const router = routers[0];
    // MEASURED: the Router's box and the belt on its first output. The turn keeps the
    // anchor, so the turned 3x2 box is x 14..16, y 0..1 and covers (16,1).
    const xs = router.cells.map((c) => c[0]);
    const ys = router.cells.map((c) => c[1]);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 'the demo Router is the 2x3 at (14,0)').toEqual([
      14, 0, 15, 2,
    ]);
    const firstOut = router.ports.find((p) => p.index === 1);
    expect(
      firstOut && [firstOut.cell_x, firstOut.cell_y, firstOut.side, firstOut.role],
      'catalog port 1 is the first Out, on the middle row at (15,1) facing E',
    ).toEqual([15, 1, 1, 1]);
    const onDoorstep = before.belts.find((b) => b.tiles.length > 0 && b.tiles[0].cell_x === 16 && b.tiles[0].cell_y === 1);
    expect(onDoorstep, 'a belt starts on the first Out\'s doorstep (16,1)').toBeDefined();
    expect(
      onDoorstep!.docks.some((d) => d.end === 'Tail' && d.node === router.id),
      'and its Tail is docked to the Router',
    ).toBe(true);

    await selectMachineAt(page, 14, 0);
    const selected = structure(await readScene(page));
    // THE WHERE (task 3): latch whether the reject flash is PAINTED on any animation frame
    // from here on. Read as the flash Graphics' instruction count (`rejectFlashInstructions`,
    // the 74-05 read-back), never as a call latch, and nothing is painted at rest. The
    // flash lives 180 ms, so a frame-by-frame latch is the only read that cannot miss it.
    expect(await flashPainted(page), 'no reject flash is painted before the press').toBe(false);
    await latchFlash(page);
    await page.keyboard.press('r');
    expect(
      await captureRefusalText(page, 'the Rotate was answered with a refusal sentence'),
      'the refused Rotate names the belt in the way and the fix (before plan 74.1-18 it read "That space is taken.")',
    ).toBe(ROTATE_COVERS_BELT_COPY);
    expect(structure(await readScene(page)), 'every node, belt and link is unchanged: nothing turned, nothing deleted').toBe(
      selected,
    );
    expect(selected, 'and selecting the Router changed nothing either').toBe(structure(before));
    await expect
      .poll(() => flashSeen(page), {
        timeout: 5_000,
        message: 'the canvas flashed the belt in the way of the turn (before task 3 of plan 74.1-18 it flashed nothing)',
      })
      .toBe(true);

    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });

  test('leg 2: a third + Add output on the demo Factory is refused with the growth sentence and the board does not change', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    const before = await readScene(page);
    const f0 = theFactory(before);
    // MEASURED: the demo Factory is the 3x3 at (4,2) with one output, and the fault belt
    // starts on (5,5), the Fault's doorstep, right below the box.
    const xs = f0.cells.map((c) => c[0]);
    const ys = f0.cells.map((c) => c[1]);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 'the demo Factory is the 3x3 at (4,2)').toEqual([
      4, 2, 6, 4,
    ]);
    expect(outCount(f0), 'the demo Factory starts with one output').toBe(1);
    const fault = f0.ports.find((p) => p.role === 2);
    expect(fault && [fault.cell_x, fault.cell_y, fault.side], 'the Fault is (5,4) facing S').toEqual([5, 4, 2]);
    const faultBelt = beltAt(before, [5, 5]);
    expect(faultBelt?.tiles[0], 'the fault belt starts on (5,5)').toMatchObject({ cell_x: 5, cell_y: 5 });

    await selectMachineAt(page, 4, 2);
    const addOutput = page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: '+ Add output' });
    // Presses 1 and 2 fit the 3x3 box (the bottom and then the top row of the E column).
    for (const outs of [2, 3]) {
      await expect(addOutput, `+ Add output is offered before output ${outs}`).toBeEnabled();
      await addOutput.click();
      await pollScene(page, (s) => outCount(theFactory(s)), {
        message: `the real host folded the AddPort (the Factory now has ${outs} outputs)`,
      }).toBe(outs);
    }
    const three = await readScene(page);
    expect(theFactory(three).cells, 'three outputs still fit the 3x3 box').toEqual(f0.cells);
    const held = structure(three);

    // Press 3, the fourth output: the box would grow south over (5,5).
    await expect(addOutput, '+ Add output is offered before the fourth output').toBeEnabled();
    await addOutput.click();
    expect(
      await captureRefusalText(page, 'the fourth output was answered with a refusal sentence'),
      'the refused growth names the belt in the way and the fix (before plan 74.1-18 it read "That space is taken.")',
    ).toBe(GROW_COVERS_BELT_COPY);
    const after = await readScene(page);
    expect(outCount(theFactory(after)), 'still three outputs').toBe(3);
    expect(structure(after), 'the ports, the box and every link are unchanged').toBe(held);

    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });

  test('leg 3 (N4c, J11): a belt end dragged onto a belt end two tiles away is refused because the ends do not touch, and nothing links', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
    await page.getByTitle(/^Draw belts/).click();
    await drawPlain(page, MAIN_CELLS);
    await pollScene(page, (s) => s.belts.length, { message: 'the main belt was drawn' }).toBe(1);
    await drawPlain(page, SIDE_CELLS);
    await pollScene(page, (s) => s.belts.length, { message: 'the side belt was drawn' }).toBe(2);
    await page.keyboard.press('Escape');
    const built = await readScene(page);
    expect(beltAt(built, [4, 6])?.tiles.map((t) => [t.cell_x, t.cell_y]), 'the main belt').toEqual(
      MAIN_CELLS.map(([x, y]) => [x, y]),
    );
    expect(beltAt(built, [4, 4])?.tiles.map((t) => [t.cell_x, t.cell_y]), 'the side belt').toEqual(
      SIDE_CELLS.map(([x, y]) => [x, y]),
    );
    expect(built.belts.flatMap((b) => b.docks), 'both belts start undocked').toEqual([]);
    const held = structure(built);

    // Select the side belt (an interior tile), then press off-centre inside its LAST tile
    // (4,4) and walk in sub-cell steps to an off-centre point inside the main belt's FIRST
    // tile (4,6), two tiles away.
    const mid = await cellPoint(page, [4, 3], [0.5, 0.5]);
    await clickAt(page, mid.x, mid.y);
    await expect(page.locator('#fab-belt-config'), 'clicking (4,3) selected the side belt').toBeVisible({
      timeout: 15_000,
    });
    const a = await cellPoint(page, [4, 4], PRESS_FRAC);
    const b = await cellPoint(page, [4, 6], DROP_FRAC);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 2 * STEPS_PER_CELL });
    await page.mouse.up();
    expect(
      await captureRefusalText(page, 'the dropped belt end was answered with a refusal sentence'),
      'the refused join says the ends do not touch (before plan 74.1-24 it read the one belt-rule sentence, before 74.1-18 the output-and-input one)',
    ).toBe(BELT_ENDS_APART_COPY);
    const after = await readScene(page);
    expect(after.belts.flatMap((x) => x.docks), 'nothing linked').toEqual([]);
    expect(structure(after), 'both belts are unchanged').toBe(held);

    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });

  test('leg 4 (control): a belt end dropped on a MACHINE output still reads the InvalidDock sentence', async ({ page }) => {
    const errs = await bootOnDemo(page);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
    await armAndPlaceAt(page, 'Factory', 10, 4);
    await pollScene(page, (s) => s.nodes.length, { message: 'the real host echoed the placed Factory' }).toBe(1);
    const f = theFactory(await readScene(page));
    const out = f.ports.find((p) => p.role === 1);
    // MEASURED: a fresh 3x3 Factory at (10,4) has its Out at (12,5) facing E, doorstep (13,5).
    expect(out && [out.cell_x, out.cell_y, out.side], 'the Out is (12,5) facing E').toEqual([12, 5, 1]);

    // A plain belt from (15,5) west to the doorstep (13,5): its LAST tile sits on the
    // doorstep (adjacency passes) and leaves it straight (facing passes), so dropping that
    // end on the Out breaks the role rule alone. The press is on no doorstep.
    await page.getByTitle(/^Draw belts/).click();
    await drawPlain(page, [
      [15, 5],
      [14, 5],
      [13, 5],
    ]);
    await pollScene(page, (s) => s.belts.length, { message: 'the belt was drawn' }).toBe(1);
    await page.keyboard.press('Escape');
    const built = await readScene(page);
    expect(built.belts[0].tiles.map((t) => [t.cell_x, t.cell_y]), 'the belt ends on the doorstep').toEqual([
      [15, 5],
      [14, 5],
      [13, 5],
    ]);
    expect(built.belts[0].docks, 'the belt starts undocked').toEqual([]);
    const held = structure(built);

    const mid = await cellPoint(page, [14, 5], [0.5, 0.5]);
    await clickAt(page, mid.x, mid.y);
    await expect(page.locator('#fab-belt-config'), 'clicking (14,5) selected the belt').toBeVisible({ timeout: 15_000 });
    const a = await cellPoint(page, [13, 5], [0.6, 0.55]);
    const nub = nubAnchor(out!.cell_x, out!.cell_y, out!.side);
    const b = await screenPoint(page, nub);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: STEPS_PER_CELL });
    await page.mouse.up();
    expect(
      await captureRefusalText(page, 'the dropped belt end was answered with a refusal sentence'),
      'a machine-target role refusal keeps the InvalidDock sentence',
    ).toBe(INVALID_DOCK_COPY);
    expect(structure(await readScene(page)), 'nothing linked, nothing moved').toBe(held);

    await expectRenderLoopAlive(page, 'after leg 4');
    errs.assertNone('leg 4');
  });

  test('leg 5 (N4D, J11): a U-turn join is refused in both drag directions with its own sentence and nothing links', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    // Way 1 drags the TOP belt's last tile (7,6) onto the bottom belt's first tile (7,7);
    // way 2 drags the BOTTOM belt's first tile (7,7) onto the top belt's last tile (7,6).
    const ways = [
      { name: 'way 1 (top last tile onto bottom first tile)', select: [5, 6], press: [7, 6], drop: [7, 7] },
      { name: 'way 2 (bottom first tile onto top last tile)', select: [6, 7], press: [7, 7], drop: [7, 6] },
    ] as const;
    for (const way of ways) {
      await newBoard(page);
      await resetZoomToActualSize(page);
      await waitForCameraSettle(page);
      expect((await cameraOf(page)).scale, `${way.name}: the camera is at scale 1`).toBe(1);
      await page.getByTitle(/^Draw belts/).click();
      await drawPlain(page, UTURN_TOP_CELLS);
      await pollScene(page, (s) => s.belts.length, { message: `${way.name}: the top belt was drawn` }).toBe(1);
      await drawPlain(page, UTURN_BOTTOM_CELLS);
      await pollScene(page, (s) => s.belts.length, { message: `${way.name}: the bottom belt was drawn` }).toBe(2);
      await page.keyboard.press('Escape');
      const built = await readScene(page);
      expect(beltAt(built, [7, 6])?.tiles.map((t) => [t.cell_x, t.cell_y]), `${way.name}: the top belt`).toEqual(
        UTURN_TOP_CELLS.map(([x, y]) => [x, y]),
      );
      expect(beltAt(built, [7, 7])?.tiles.map((t) => [t.cell_x, t.cell_y]), `${way.name}: the bottom belt`).toEqual(
        UTURN_BOTTOM_CELLS.map(([x, y]) => [x, y]),
      );
      expect(built.belts.flatMap((b) => b.docks), `${way.name}: both belts start undocked`).toEqual([]);
      const held = structure(built);

      // Select the dragged belt on an interior tile, press off-centre inside its end tile and
      // walk in sub-cell steps to an off-centre point inside the other belt's end tile.
      const mid = await cellPoint(page, way.select, [0.5, 0.5]);
      await clickAt(page, mid.x, mid.y);
      await expect(page.locator('#fab-belt-config'), `${way.name}: the dragged belt is selected`).toBeVisible({
        timeout: 15_000,
      });
      const a = await cellPoint(page, way.press, PRESS_FRAC);
      const b = await cellPoint(page, way.drop, DROP_FRAC);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: STEPS_PER_CELL });
      await page.mouse.up();
      expect(
        await captureRefusalText(page, `${way.name}: the dropped belt end was answered with a refusal sentence`),
        `${way.name}: the refused U-turn says what is wrong with it (before plan 74.1-24 it read the one belt-rule sentence)`,
      ).toBe(BELT_JOIN_TURNS_BACK_COPY);
      const after = await readScene(page);
      expect(after.belts, `${way.name}: still two belts`).toHaveLength(2);
      expect(after.belts.flatMap((x) => x.docks), `${way.name}: nothing linked`).toEqual([]);
      expect(structure(after), `${way.name}: both belts are unchanged`).toBe(held);
      // Let the held sentence clear before the next way, so its latch reads a fresh refusal.
      await expect(page.locator('#fab-refusal'), `${way.name}: the sentence clears`).toHaveText('', { timeout: 15_000 });
      // Deselect, so the next way starts from no selection (the belt panel docks below the
      // toolbar since plan 91-09, so New is reachable either way).
      await page.keyboard.press('Escape');
      await expect(page.locator('#fab-belt-config'), `${way.name}: the belt is deselected`).toBeHidden({ timeout: 15_000 });
    }

    await expectRenderLoopAlive(page, 'after leg 5');
    errs.assertNone('leg 5');
  });

  test('leg 6 (WR-04): the rotate handle on the demo Router is refused with the belt sentence and flashes the belt in the way', async ({
    page,
  }) => {
    // THE WALK'S WINDOW, 1600 by 1000 (re-walk J10). MEASURED at the suite's 1280 by 720: the
    // Router's handle lands at screen (814, 244), under the open Router panel (its
    // `#fab-route-add` button), so a click there never reaches the canvas. At 1600 by 1000
    // it lands at (998, 333), on the canvas; the guard below says so before the click.
    await page.setViewportSize({ width: 1600, height: 1000 });
    const errs = await bootOnDemo(page);
    const before = await readScene(page);
    const routers = before.nodes.filter((n) => n.kind === ROUTER_KIND);
    expect(routers, 'the demo board carries exactly one Router').toHaveLength(1);
    const router = routers[0];
    // MEASURED as in leg 1: the 2x3 Router at (14,0), its first Out's belt on (16,1).
    const xs = router.cells.map((c) => c[0]);
    const ys = router.cells.map((c) => c[1]);
    expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 'the demo Router is the 2x3 at (14,0)').toEqual([
      14, 0, 15, 2,
    ]);
    expect(
      before.belts.some((b) => b.tiles.length > 0 && b.tiles[0].cell_x === 16 && b.tiles[0].cell_y === 1),
      'a belt starts on the first Out\'s doorstep (16,1)',
    ).toBe(true);

    await selectMachineAt(page, 14, 0);
    const selected = structure(await readScene(page));
    expect(await flashPainted(page), 'no reject flash is painted before the click').toBe(false);
    await latchFlash(page);
    // The rotate handle sits on the selection outline's top-right corner (the shared
    // `rotateHandle` anchor math; the Router's box is 2 cells wide). A plain click turns CW,
    // exactly as r does.
    const handle = await screenPoint(page, rotateHandle(14, 0, 2));
    expect(
      await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'none', [handle.x, handle.y]),
      'the rotate handle is on the canvas, not under the panel',
    ).toBe('CANVAS');
    await clickAt(page, handle.x, handle.y);
    expect(
      await captureRefusalText(page, 'the handle Rotate was answered with a refusal sentence'),
      'the refused handle turn names the belt in the way and the fix, as r does',
    ).toBe(ROTATE_COVERS_BELT_COPY);
    expect(structure(await readScene(page)), 'every node, belt and link is unchanged: nothing turned').toBe(selected);
    expect(selected, 'and selecting the Router changed nothing either').toBe(structure(before));
    await expect
      .poll(() => flashSeen(page), {
        timeout: 5_000,
        message:
          'the canvas flashed the belt in the way of the handle turn (before plan 74.1-25 the handle flashed nothing, review WR-04)',
      })
      .toBe(true);

    await expectRenderLoopAlive(page, 'after leg 6');
    errs.assertNone('leg 6');
  });
  test('leg 7 (HEAD-WORDS): a joined belt end dropped on a free belt start reads the belt-end sentence and nothing links', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    // The downstream belt is drawn straight on from the upstream belt's last tile, so it
    // joins as it is drawn (MEASURED on the first run of this leg): the upstream's last
    // tile (7,6) feeds the downstream's first tile (8,6). The third belt stays free.
    const joined = await boardOfBelts(page, [JOINED_UP_CELLS, JOINED_DOWN_CELLS, THIRD_CELLS]);
    const up = beltAt(joined, [7, 6]);
    const down = beltAt(joined, [8, 6]);
    const third = beltAt(joined, [7, 5]);
    expect(up?.docks, 'the upstream belt\'s last tile feeds the downstream belt').toEqual([
      expect.objectContaining({ end: 'Head', node: down?.id }),
    ]);
    expect(down?.docks, 'the downstream belt\'s first tile is fed by the upstream belt').toEqual([
      expect.objectContaining({ end: 'Tail', node: up?.id }),
    ]);
    expect(third?.docks, 'the third belt is free at both ends').toEqual([]);
    const held = structure(joined);

    // THE DROP: the joined end pressed off-centre inside (7,6) and dropped inside the third
    // belt's free first tile (7,5), one step up and turning across.
    await dragBeltEnd(page, [5, 6], [7, 6], [7, 5], 'the joined end');
    expect(
      await captureRefusalText(page, 'the dropped joined belt end was answered with a refusal sentence'),
      'the refused drop names the belt end the user dragged (before plan 74.1-32 it read "That output is already connected. Disconnect it first.")',
    ).toBe(BELT_END_TAKEN_COPY);
    expect(structure(await readScene(page)), 'nothing linked, nothing moved: the first join is the only one').toBe(held);

    await expectRenderLoopAlive(page, 'after leg 7');
    errs.assertNone('leg 7');
  });

  test("leg 8 (J11-THIRD): a belt end dropped on another belt's end reads the join rule sentence and nothing links", async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);
    const built = await boardOfBelts(page, [HEAD_A_CELLS, HEAD_B_CELLS]);
    expect(built.belts.flatMap((b) => b.docks), 'both belts start undocked').toEqual([]);
    const held = structure(built);

    // The first belt's last tile (6,6) dropped inside the second belt's LAST tile (7,6),
    // right beside it: the ends touch and nothing turns back, so the role rule is the only
    // one broken.
    await dragBeltEnd(page, [5, 6], [6, 6], [7, 6], 'last tile onto last tile');
    expect(
      await captureRefusalText(page, 'the dropped belt end was answered with a refusal sentence'),
      'the refused join says what to do (before plan 74.1-32 it read the 74.1-24 rule sentence)',
    ).toBe(INVALID_BELT_JOIN_COPY);
    const after = await readScene(page);
    expect(after.belts.flatMap((x) => x.docks), 'nothing linked').toEqual([]);
    expect(structure(after), 'both belts are unchanged').toBe(held);

    await expectRenderLoopAlive(page, 'after leg 8');
    errs.assertNone('leg 8');
  });
});
