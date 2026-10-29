import { test, expect, type Page } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CELL,
  DRAWN_STATE_FRAMES,
  armAndPlaceAt,
  cameraOf,
  drawnNodesOf,
  ensurePlaying,
  expectRenderLoopAlive,
  glyphBoxOn,
  newBoard,
  pollScene,
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

// 88-refusal-sentences.live.spec.ts (plan 88-02, FAIL-09, WINDOWS 81, 83 and 84, phase 88
// success criterion 5, D-11) - a refused edit tells the user its real cause. On the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: every machine comes off the palette, every press is the shipped control.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-11: a refusal tag that carried two causes is split so each sentence names one. Before plan
// 88-02 a machine in the middle of the grid grown past the size limit read the off-grid
// sentence ("That cell is past the edge of the grid.", WINDOWS 83), a turn or an output add
// blocked by another machine read the FootprintCollision sentence, which offers an elsewhere, for a
// gesture that has no elsewhere (WINDOWS 84), and an Undo whose inverse no longer fits the board
// read "The host could not carry out that gesture." (WINDOWS 81).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. MACHINE TOO BIG. A Factory placed mid-grid, selected, and grown by `+ Add output` until
//      the host refuses. The refused press is the one past the 64-cell size limit (the box is
//      3 by 64 when it comes), every cell far from any grid edge. The band reads the
//      MachineTooBig sentence and never "past the edge"; the Factory keeps its 64 outputs and
//      the machine layer still draws it 3 by 64.
//   2. ROTATE BLOCKED. A Router (2 by 3) with a Source on the cell its turned box (3 by 2)
//      would cover. The Router selected, r pressed: the band reads the RotateBlocked sentence
//      and never "elsewhere"; neither machine moves, both are drawn where they were.
//   3. GROW BLOCKED. A Factory with a Source on the row its third `+ Add output` would grow the
//      box into. The band reads the GrowBlocked sentence and never "elsewhere"; the
//      Factory keeps its ports and its 3 by 3 box, drawn as before.
//   4. UNDO DOES NOT FIT. `crates/fabrico-host/tests/fixtures/88-undo-does-not-fit.fab` (a
//      Source, and a Sink deleted last with its docked belt, the Delete's captured belt
//      stripped of its links by `forged_files.rs`) opened through the toolbar, Ctrl+Z: the
//      band reads the UndoDoesNotFit sentence, the drawn board and the model are the same
//      before and after, and Undo is still offered.
//
// RED BEFORE THE SPLIT (88-EVIDENCE.md `## Plan 88-02`, `sentences-red.*`): every leg read the
// old sentence, on the host and frontend at the plan's start revision.
//
// Each leg grades the band text the user reads AND the board the machine layer draws
// (`drawnNodesOf`, `glyphBoxOn`), never the model alone. Render health in every test:
// `watchPageErrors` before `goto`, `expectRenderLoopAlive` on a ticking board after each
// gesture block, and the watcher's `assertNone`.

/** Kind bytes (protocol `machine_kind`), transcribed: the live suite imports no product source. */
const KIND_SOURCE = 0;
const KIND_FACTORY = 2;
const KIND_ROUTER = 5;
const KIND_SINK = 7;

/** `MAX_FOOTPRINT_DIM` (`crates/fabrico-core/src/state.rs`), transcribed. */
const MAX_FOOTPRINT_DIM = 64;

/** The sentences, transcribed from `REFUSAL_COPY` rather than imported. */
const MACHINE_TOO_BIG = 'That machine would grow past the size limit.';
const ROTATE_BLOCKED = 'No room to turn. Clear the space first.';
const GROW_BLOCKED = 'No room to grow. Clear the space first.';
const UNDO_DOES_NOT_FIT = 'That step no longer fits the board.';

/** The screen point legs 1 to 3 build around: left of the right-docked panel, right of the
 *  palette, in the upper half of the 1280 by 800 viewport so a grown box has room below it. */
const VIEW_AT = { x: 560, y: 260 } as const;

/** Leg 4's forged board. */
const FIXTURE = fileURLToPath(
  new URL('../../crates/fabrico-host/tests/fixtures/88-undo-does-not-fit.fab', import.meta.url),
);
/** Leg 4's witness Source and the deleted Sink's cell (`forged_files.rs` `UF_SOURCE_AT`, `UF_SINK_AT`). */
const UF_SOURCE_AT: readonly [number, number] = [16, 16];
const UF_SINK_AT: readonly [number, number] = [20, 20];
/** A floor cell clear of every node on leg 4's board, clicked so Ctrl+Z goes to the board. */
const UF_FLOOR_AT: readonly [number, number] = [12, 12];

/** The ticks one host answer may take on a playing board, for the derived budgets. */
const ANSWER_TICKS = 120;
/** Phase 87 measured about 20 ticks a second under the CPU quota, under `FLOOR_TPS` 28, so
 *  every tick budget is this many times the ticks it waits for (`88-late-label-echo`). */
const SLOW_BOARD = 3;
/** How long one press may take to come back as an echo or a sentence (each wait on it also
 *  raises the test's limit by as much, through `addWaitBudget`). */
const ANSWER_MS = tickBudgetMs(SLOW_BOARD * ANSWER_TICKS);

/** `ANSWER_MS`, added to the running test's limit, for one wait named by `what`. */
function answerWait(what: string): number {
  return addWaitBudget(ANSWER_MS, what);
}

type NodeFacts = SceneFacts['nodes'][number];

/** The band's text, trimmed. */
async function bandText(page: Page): Promise<string> {
  return ((await page.locator('#fab-refusal').textContent()) ?? '').trim();
}

/** The number of Out ports (role 1) on a node. */
function outCount(node: NodeFacts): number {
  return node.ports.filter((p) => p.role === 1).length;
}

/** A node's box as [minX, minY, maxX, maxY]. */
function boxOf(node: NodeFacts): [number, number, number, number] {
  const xs = node.cells.map((c) => c[0]);
  const ys = node.cells.map((c) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The one node of `kind` on the board. */
function only(scene: SceneFacts, kind: number, what: string): NodeFacts {
  const found = scene.nodes.filter((n) => n.kind === kind);
  expect(found, `the board carries exactly one ${what}`).toHaveLength(1);
  return found[0];
}

/**
 * The board's structure as one string: every node's id, kind, sorted cells and ports, every
 * belt's tiles and docks, every wire's ends. Nothing that moves on its own is in it, so two
 * reads are equal exactly when no command changed the board.
 */
function structure(scene: SceneFacts): string {
  const nodes = scene.nodes
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      cells: [...n.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]),
      ports: n.ports,
    }))
    .sort((a, b) => a.id - b.id);
  const belts = scene.belts.map((b) => ({ id: b.id, tiles: b.tiles, docks: b.docks })).sort((a, b) => a.id - b.id);
  const wires = scene.wires.map((w) => ({ id: w.id, from: w.from, to: w.to })).sort((a, b) => a.id - b.id);
  return JSON.stringify({ nodes, belts, wires });
}

/** What the machine layer draws: the drawn census plus each drawn machine's footprint in cells. */
async function drawnBoard(page: Page): Promise<{ machines: number[]; strays: number; boxes: string[] }> {
  const d = await drawnNodesOf(page);
  const boxes: string[] = [];
  for (const id of d.machines) {
    const g = await glyphBoxOn(page, id);
    boxes.push(g === null ? `${id}:none` : `${id}:${g.footW / CELL}x${g.footH / CELL}`);
  }
  return { machines: d.machines, strays: d.strays, boxes };
}

/**
 * The world cell under `VIEW_AT` on the camera as it is now. New keeps the camera where the last
 * board left it, so a fixed world cell can sit under the palette or off the canvas; every leg
 * builds from this cell instead.
 */
async function cellInView(page: Page): Promise<[number, number]> {
  const cam = await cameraOf(page);
  return [
    Math.floor((VIEW_AT.x - cam.x) / cam.scale / CELL),
    Math.floor((VIEW_AT.y - cam.y) / cam.scale / CELL),
  ];
}

/** A fresh, playing, empty board at 100% zoom. */
async function bootEmpty(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await ensurePlaying(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  return errs;
}

/** Place `kind` at `at` from the palette and wait for the host's echo of it. */
async function placeAndSee(page: Page, name: string, kind: number, at: readonly [number, number]): Promise<NodeFacts> {
  const count = (await readScene(page)).nodes.length;
  const pt = await screenCellCentre(page, at[0], at[1]);
  expect(
    await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const),
    `PRECONDITION: the canvas is under the ${name}'s cell (${at[0]},${at[1]}) at screen (${Math.round(pt.x)},${Math.round(pt.y)})`,
  ).toBe('CANVAS');
  await armAndPlaceAt(page, name, at[0], at[1]);
  await pollScene(page, (s) => s.nodes.length, {
    timeout: answerWait('the Place echo'),
    message: `the host placed the ${name} at (${at[0]},${at[1]})`,
  }).toBe(count + 1);
  const placed = (await readScene(page)).nodes.find(
    (n) => n.kind === kind && n.cells.some(([x, y]) => x === at[0] && y === at[1]),
  );
  expect(placed, `the ${name} holds (${at[0]},${at[1]})`).toBeDefined();
  return placed!;
}

/**
 * Press `+ Add output` on the selected Factory until the host refuses one, and return the
 * sentence the band shows for it with the Out count the Factory held when it came. Each
 * press waits for its own answer: the Out count one higher (accepted) or a sentence in the
 * band (refused). The refusal is read the moment it shows, before its 4000 ms hold runs out.
 */
async function addOutputsUntilRefused(page: Page, factory: number, limit: number): Promise<{ said: string; outs: number }> {
  const addOutput = page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: '+ Add output' });
  for (let press = 1; press <= limit; press += 1) {
    const before = outCount((await readScene(page)).nodes.find((n) => n.id === factory)!);
    await expect(addOutput, `+ Add output is offered before press ${press}`).toBeEnabled({ timeout: answerWait('the Ports panel is ready for the next press') });
    await addOutput.click();
    let answer = '';
    await expect
      .poll(
        async () => {
          const said = await bandText(page);
          if (said !== '') {
            answer = `refused:${said}`;
            return answer;
          }
          const node = (await readScene(page)).nodes.find((n) => n.id === factory);
          answer = node !== undefined && outCount(node) === before + 1 ? 'accepted' : '';
          return answer;
        },
        { timeout: answerWait('one press of + Add output'), intervals: [100, 250, 500], message: `press ${press} of + Add output was answered` },
      )
      .not.toBe('');
    if (answer.startsWith('refused:')) {
      return { said: answer.slice('refused:'.length), outs: before };
    }
  }
  throw new Error(`no press of + Add output was refused in ${limit} presses`);
}

test.describe('FAIL-09 live: a refused edit says its real cause', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('leg 1: a machine grown past the size limit in the middle of the grid is told so, not that it is past the edge', async ({
    page,
  }) => {
    test.setTimeout(addWaitBudget(70 * ANSWER_MS, 'leg 1: 64 presses, each one host answer'));
    const errs = await bootEmpty(page);
    const FACTORY_AT = await cellInView(page);
    const factory = await placeAndSee(page, 'Factory', KIND_FACTORY, FACTORY_AT);
    expect(outCount(factory), 'a placed Factory starts with one output').toBe(1);
    await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
    await expectRenderLoopAlive(page, 'leg 1: the Factory placed and selected');

    const { said, outs } = await addOutputsUntilRefused(page, factory.id, MAX_FOOTPRINT_DIM + 4);
    const after = await readScene(page);
    const grown = after.nodes.find((n) => n.id === factory.id)!;
    const [x0, y0, x1, y1] = boxOf(grown);
    console.log(`LEG1_REFUSED outs=${outs} box=${x1 - x0 + 1}x${y1 - y0 + 1} said=${JSON.stringify(said)}`);
    // PRECONDITIONS: the refused press is the one past the size limit, and no edge is near.
    expect(y1 - y0 + 1, 'PRECONDITION: the last accepted box is at the size limit, so the next add passes it').toBe(
      MAX_FOOTPRINT_DIM,
    );
    expect(
      [x0, y0, x1, y1].every((v) => v > -400 && v < 400),
      'PRECONDITION: every cell of the box is far from every grid edge (-512 and 512)',
    ).toBe(true);
    expect(said, 'the band names the size limit').toBe(MACHINE_TOO_BIG);
    expect(said.toLowerCase(), 'and never the grid edge').not.toContain('past the edge');
    expect(outCount(grown), 'the refused press added no output').toBe(outs);
    await expect
      .poll(() => drawnBoard(page), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the machine layer draws the refused board'),
        message: 'the machine layer still draws the Factory 3 by 64',
      })
      .toEqual({ machines: [factory.id], strays: 0, boxes: [`${factory.id}:3x${MAX_FOOTPRINT_DIM}`] });
    await expectRenderLoopAlive(page, 'leg 1: after the refused press');
    errs.assertNone('leg 1');
  });

  test('leg 2: a turn into another machine is told there is no room to turn, never to place elsewhere', async ({ page }) => {
    test.setTimeout(addWaitBudget(20 * ANSWER_MS, 'leg 2: four gestures, each one host answer'));
    const errs = await bootEmpty(page);
    const ROUTER_AT = await cellInView(page);
    await placeAndSee(page, 'Router', KIND_ROUTER, ROUTER_AT);
    // The Router's ports are seeded by the client on the Place's echo, so its box is read
    // once two reads half a second apart agree.
    let last = '';
    await expect
      .poll(
        async () => {
          const r = (await readScene(page)).nodes.find((n) => n.kind === KIND_ROUTER);
          const now = JSON.stringify(r === undefined ? null : { cells: r.cells, ports: r.ports });
          const settled = now === last;
          last = now;
          return settled;
        },
        { timeout: answerWait('the Router port seeding'), intervals: [500], message: 'the Router settled after its port seeding' },
      )
      .toBe(true);
    const router = only(await readScene(page), KIND_ROUTER, 'Router');
    const [rx0, ry0, rx1, ry1] = boxOf(router);
    const [w, h] = [rx1 - rx0 + 1, ry1 - ry0 + 1];
    console.log(`LEG2_ROUTER box=${w}x${h} at=${rx0},${ry0}`);
    expect(w === h, 'PRECONDITION: the Router box is not square, so a turn claims new cells').toBe(false);
    // The turn keeps the anchor, so the turned box is h wide and w deep from (rx0, ry0). The
    // first cell it claims that the Router does not hold gets a Source.
    const blockerAt: [number, number] = h > w ? [rx0 + h - 1, ry0] : [rx0, ry0 + w - 1];
    const source = await placeAndSee(page, 'Source', KIND_SOURCE, blockerAt);
    await selectMachineAt(page, rx0, ry0);
    const before = await readScene(page);
    const drawnBefore = await drawnBoard(page);
    expect(drawnBefore.machines, 'the machine layer draws both machines').toEqual([router.id, source.id].sort((a, b) => a - b));
    await expectRenderLoopAlive(page, 'leg 2: the board built and the Router selected');

    await page.keyboard.press('r');
    let said = '';
    await expect
      .poll(async () => (said = await bandText(page)), { timeout: answerWait('a host answer'), intervals: [100, 250, 500], message: 'r was answered with a sentence' })
      .not.toBe('');
    console.log(`LEG2_REFUSED said=${JSON.stringify(said)}`);
    expect(said, 'the band says there is no room to turn').toBe(ROTATE_BLOCKED);
    expect(said.toLowerCase(), 'and never offers elsewhere: a turn has no elsewhere').not.toContain('elsewhere');
    expect(structure(await readScene(page)), 'neither machine moved: the Router did not turn').toBe(structure(before));
    expect(await drawnBoard(page), 'the machine layer draws both machines as they were').toEqual(drawnBefore);
    await expectRenderLoopAlive(page, 'leg 2: after the refused turn');
    errs.assertNone('leg 2');
  });

  test('leg 3: an output that would grow the box into another machine is told there is no room to grow', async ({ page }) => {
    test.setTimeout(addWaitBudget(20 * ANSWER_MS, 'leg 3: six gestures, each one host answer'));
    const errs = await bootEmpty(page);
    const FACTORY_AT = await cellInView(page);
    const factory = await placeAndSee(page, 'Factory', KIND_FACTORY, FACTORY_AT);
    const [fx0, , fx1, fy1] = boxOf(factory);
    expect([fx1 - fx0 + 1, fy1 - boxOf(factory)[1] + 1], 'MEASURED: a placed Factory is 3 by 3').toEqual([3, 3]);
    // The first add that grows the box adds the row below it (the probe in
    // `refusal_copy_truth.rs` measured the growth claiming the anchor column one row down).
    const blockerAt: [number, number] = [fx0, fy1 + 1];
    const source = await placeAndSee(page, 'Source', KIND_SOURCE, blockerAt);
    await selectMachineAt(page, FACTORY_AT[0], FACTORY_AT[1]);
    await expectRenderLoopAlive(page, 'leg 3: the board built and the Factory selected');

    const { said, outs } = await addOutputsUntilRefused(page, factory.id, 6);
    console.log(`LEG3_REFUSED outs=${outs} said=${JSON.stringify(said)}`);
    const after = await readScene(page);
    const held = after.nodes.find((n) => n.id === factory.id)!;
    expect(said, 'the band says there is no room to grow').toBe(GROW_BLOCKED);
    expect(said.toLowerCase(), 'and never offers elsewhere: an output add has no elsewhere').not.toContain('elsewhere');
    expect(outCount(held), 'the Factory keeps the outputs it had').toBe(outs);
    expect(boxOf(held), 'and its 3 by 3 box').toEqual(boxOf(factory));
    expect(
      after.nodes.find((n) => n.id === source.id)?.cells,
      'the Source keeps its cell',
    ).toEqual([blockerAt]);
    await expect
      .poll(() => drawnBoard(page), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the machine layer draws the refused board'),
        message: 'the machine layer draws the Factory 3 by 3 and the Source',
      })
      .toEqual({
        machines: [factory.id, source.id].sort((a, b) => a - b),
        strays: 0,
        boxes: [factory.id, source.id]
          .sort((a, b) => a - b)
          .map((id) => (id === factory.id ? `${id}:3x3` : `${id}:1x1`)),
      });
    await expectRenderLoopAlive(page, 'leg 3: after the refused press');
    errs.assertNone('leg 3');
  });

  test('leg 4: Ctrl+Z on a board whose last step no longer fits it is told so, and the board does not change', async ({ page }) => {
    test.setTimeout(addWaitBudget(20 * ANSWER_MS, 'leg 4: an open and a Ctrl+Z'));
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);
    await expectRenderLoopAlive(page, 'leg 4: on the board the app boots');

    const opened = join(tmpdir(), `fabrico-e2e-88-undo-does-not-fit-${Date.now()}.fab`);
    copyFileSync(FIXTURE, opened);
    page.once('dialog', (d) => void d.accept(opened));
    await page.getByTitle('Load a saved factory').click();
    await pollScene(page, (s) => s.nodes.map((n) => `${n.kind}@${n.cells.map((c) => c.join(',')).join(';')}`), {
      timeout: answerWait('a host answer'),
      message: 'the forged board opened: one Source on (16,16), the Sink and its belt deleted',
    }).toEqual([`${KIND_SOURCE}@${UF_SOURCE_AT.join(',')}`]);
    await expect(page.getByRole('alert'), 'no refusal card: the forged board opens').toHaveCount(0);
    await ensurePlaying(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    const before = await readScene(page);
    const source = only(before, KIND_SOURCE, 'Source');
    const drawnBefore = await drawnBoard(page);
    expect(drawnBefore, 'the machine layer draws the one Source the model holds').toEqual({
      machines: [source.id],
      strays: 0,
      boxes: [`${source.id}:1x1`],
    });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo, 'the opened board offers Undo (its last step is the Delete)').toBeEnabled();
    await expectRenderLoopAlive(page, 'leg 4: on the opened board');

    const floor = await screenCellCentre(page, UF_FLOOR_AT[0], UF_FLOOR_AT[1]);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    const tickAtPress = (await readScene(page)).tick;
    await page.keyboard.press('Control+z');
    let said = '';
    await expect
      .poll(async () => (said = await bandText(page)), { timeout: answerWait('a host answer'), intervals: [100, 250, 500], message: 'Ctrl+Z was answered with a sentence' })
      .not.toBe('');
    console.log(`LEG4_REFUSED said=${JSON.stringify(said)}`);
    expect(said, 'the band says the step no longer fits the board').toBe(UNDO_DOES_NOT_FIT);
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * 30), 'leg 4: the board ticks on past the press'),
      message: `the board ticks on after the Ctrl+Z (tick ${tickAtPress} at the press)`,
    }).toBeGreaterThan(tickAtPress + 30);
    const after = await readScene(page);
    expect(structure(after), 'the board did not change: no Sink and no belt came back').toBe(structure(before));
    expect(after.nodes.some((n) => n.kind === KIND_SINK), 'no Sink came back').toBe(false);
    expect(
      after.nodes.some((n) => n.cells.some(([x, y]) => x === UF_SINK_AT[0] && y === UF_SINK_AT[1])),
      'the Sink cell is still empty',
    ).toBe(false);
    expect(await drawnBoard(page), 'the machine layer draws the same board').toEqual(drawnBefore);
    await expect(undo, 'Undo is still offered: nothing was undone').toBeEnabled();
    await expectRenderLoopAlive(page, 'leg 4: after the refused Ctrl+Z');
    errs.assertNone('leg 4');
  });
});
