import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  armAndPlaceAt,
  cameraOf,
  drawnNodesOf,
  expectRenderLoopAlive,
  glyphBoxOn,
  glyphSubjectOn,
  handPlaceAt,
  labelBoxOn,
  labelWordsOf,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 86-turned-delete-undo.live.spec.ts (plan 86-02, D-03, WORK-02) - a user turns a Router,
// puts a neighbour on a cell only the UNTURNED Router would cover, deletes the Router and
// presses Ctrl+Z. The Router comes back turned, on exactly the cells it held, the
// neighbour keeps its cell, and the board saves and opens again. On the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero
// injected packets. The spec reads the oracle (`window.__fabrico.scene()`, the MODEL), the
// machine layer's census and glyph read-backs, the label box and the words overlay,
// because a model read alone passes over a board that draws nothing (memory
// fabrico-model-oracle-blindspot).
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-03 (default, route 1 of the turned-Delete todo): the Delete record carries the
// rotation the machine held, and the Undo re-places the turned box in ONE claim. A
// re-Place at rot 0 followed by a Rotate is ruled out: the rot-0 claim overwrites the
// neighbour's cells in the occupancy index and the Rotate then frees them.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE TRACER, a Source as the neighbour. On an empty board at zoom 1 a palette Router
//      is placed at (10,8): rot 0 it covers x 10 to 11, y 8 to 10. It is selected and
//      turned once with `r`: it now covers x 10 to 12, y 8 to 9, and its input faces N.
//      Cell (10,10), covered only by the unturned body, is asserted free, and a palette
//      Source is placed there. The Router is selected, Delete is pressed, empty floor is
//      clicked and Ctrl+Z is pressed. The Router is back at (10,8) on exactly its six
//      turned cells with its input facing N, the Source still holds (10,10), and the
//      machine layer draws both (census, glyph subject and glyph box). Then Save to a temp
//      path, New, and Open the file through the toolbar and its prompt: the board comes
//      back with no refusal card and the same topology (kinds, cells, ports with their
//      sides, so the turn is in it), drawn again.
//   2. A LABEL as the neighbour. The same Router, turned once; a palette Label reading
//      `Turned` is placed at (10,10) (4 by 1, x 10 to 13, free while the Router is turned).
//      Delete and Ctrl+Z as above: the Router is back turned on its six cells, the label
//      keeps its four cells, its words are drawn and its box is plotted where the model
//      says; Save, New and Open bring it all back with no refusal card.
//
// Each leg watches page errors from before `goto` and asserts the render loop is alive
// after every gesture.
//
// WHAT THE CANVAS READ CAN AND CANNOT SAY. The machine layer exposes the census, the glyph
// subject and the glyph box beside the body's own footprint; it exposes no read of the
// body's rotation. So the turn is graded on the model (cells and port sides), and the
// drawing is graded as present, the right art, and inside its machine.
//
// RED AT THE START REVISION (EDIT 12), recorded in 86-02-SUMMARY.md: the Undo
// re-placed the Router unturned (x 10 to 11, y 8 to 10) over the neighbour's cell.

/** Kind bytes (protocol `machine_kind`). Numbers on purpose: the live suite imports no
 *  product source. */
const KIND_SOURCE = 0;
const KIND_ROUTER = 5;
const KIND_LABEL = 11;
/** Port role In (oracle `PortFacts.role`). */
const ROLE_IN = 0;
/** Port sides (oracle `PortFacts.side`): an unturned Router's input faces W, turned once N. */
const SIDE_N = 0;
const SIDE_W = 3;
/** One cell in world px (`shared/geometry.ts` CELL). */
const CELL_PX = 32;
/** The label box's centreline inset from the cell edges, world px. */
const BOX_INSET = 4;
/** The words the victim label carries. */
const WORDS = 'Turned';

/** The Router's anchor, and the neighbour's cell: inside the unturned body only. */
const ROUTER_AT: [number, number] = [10, 8];
const NEIGHBOUR_AT: [number, number] = [10, 10];
/** An empty floor cell, clear of every node in both legs. */
const FLOOR_AT: [number, number] = [4, 6];

/** The Router's six cells unturned (2 by 3 at (10,8)) and turned once (3 by 2), row-major. */
const ROUTER_ROT0 = ['10,8', '11,8', '10,9', '11,9', '10,10', '11,10'];
const ROUTER_ROT1 = ['10,8', '11,8', '12,8', '10,9', '11,9', '12,9'];
/** The victim label's four cells (4 by 1 at (10,10)). */
const LABEL_CELLS = ['10,10', '11,10', '12,10', '13,10'];

type NodeFacts = SceneFacts['nodes'][number];

/** An empty board at camera scale 1. */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

/** A node's cells, sorted row-major, as `x,y` strings, so a literal list compares. */
function sortedCells(node: NodeFacts): string[] {
  return [...node.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([x, y]) => `${x},${y}`);
}

/** The one node of `kind` on the board, or null when there is none or more than one. */
function onlyOf(scene: SceneFacts, kind: number): NodeFacts | null {
  const ns = scene.nodes.filter((n) => n.kind === kind);
  return ns.length === 1 ? ns[0] : null;
}

/** What the user sees of the Router: its cells and the side its input faces. */
function routerShape(scene: SceneFacts): { cells: string[]; inSide: number | null } | null {
  const r = onlyOf(scene, KIND_ROUTER);
  if (r === null) return null;
  const ins = r.ports.filter((p) => p.role === ROLE_IN);
  return { cells: sortedCells(r), inSide: ins.length === 1 ? ins[0].side : null };
}

/** Whether any node covers cell (x, y). */
function covered(scene: SceneFacts, x: number, y: number): boolean {
  return scene.nodes.some((n) => n.cells.some(([cx, cy]) => cx === x && cy === y));
}

/**
 * The board's topology with render handles left out: a Save then Open re-mints every
 * handle, so ids are not the user's fact. Nodes sort by kind then cells; the ports carry
 * their world cells and sides, so the Router's turn is in the string.
 */
function topologyOf(scene: SceneFacts): string {
  const nodes = scene.nodes
    .map((n) => ({
      kind: n.kind,
      cells: sortedCells(n),
      ports: [...n.ports].sort((a, b) => a.index - b.index),
      label: n.label,
    }))
    .sort((a, b) => a.kind - b.kind || a.cells.join(';').localeCompare(b.cells.join(';')));
  const belts = scene.belts.map((b) => ({ tiles: b.tiles })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ nodes, belts, wires: scene.wires.length });
}

/** Click empty floor a few px off a cell centre (blurs the panel, clears the selection). */
async function clickFloor(page: Page): Promise<void> {
  const floor = await screenCellCentre(page, FLOOR_AT[0], FLOOR_AT[1]);
  await page.mouse.click(floor.x + 3, floor.y - 2);
}

/** Place a palette Router at ROUTER_AT and turn it once with `r`. */
async function turnedRouter(page: Page): Promise<void> {
  await armAndPlaceAt(page, 'Router', ROUTER_AT[0], ROUTER_AT[1]);
  await pollScene(page, routerShape, {
    message: 'the real host echoed an unturned Router at (10,8): 2 by 3, input facing W',
  }).toEqual({ cells: ROUTER_ROT0, inSide: SIDE_W });
  await expectRenderLoopAlive(page, 'after the Router is placed');
  await selectMachineAt(page, ROUTER_AT[0], ROUTER_AT[1]);
  await page.keyboard.press('r');
  await pollScene(page, routerShape, {
    message: 'the real host folded the Rotate: 3 by 2 at (10,8), input facing N',
  }).toEqual({ cells: ROUTER_ROT1, inSide: SIDE_N });
  await clickFloor(page);
  await expect(page.locator('#fab-config-heading'), 'the floor click closed the Router panel').toHaveCount(0);
  await expectRenderLoopAlive(page, 'after the Router is turned');
  expect(
    covered(await readScene(page), NEIGHBOUR_AT[0], NEIGHBOUR_AT[1]),
    'cell (10,10), which only the unturned Router covers, is free while it is turned',
  ).toBe(false);
}

/** Select the Router, Delete, click floor, Ctrl+Z; the Router is back turned. */
async function deleteAndUndoRouter(page: Page): Promise<void> {
  await selectMachineAt(page, ROUTER_AT[0], ROUTER_AT[1]);
  await page.keyboard.press('Delete');
  await pollScene(page, (s) => onlyOf(s, KIND_ROUTER) === null && s.nodes.length === 1, {
    message: 'the Delete key removed the Router and left the neighbour',
  }).toBe(true);
  await expectRenderLoopAlive(page, 'after the Delete');
  await clickFloor(page);
  await page.keyboard.press('Control+z');
  await pollScene(page, routerShape, {
    message: 'Ctrl+Z brought the Router back TURNED, on exactly its six turned cells (x 10 to 12, y 8 to 9), input facing N',
  }).toEqual({ cells: ROUTER_ROT1, inSide: SIDE_N });
  await expectRenderLoopAlive(page, 'after the Ctrl+Z');
}

/** The machine layer draws the Router, and the Source when given: census, art and box. */
async function expectMachinesDrawn(page: Page, ctx: string, withSource: boolean): Promise<void> {
  const scene = await readScene(page);
  const router = onlyOf(scene, KIND_ROUTER)!;
  const source = withSource ? onlyOf(scene, KIND_SOURCE) : null;
  const machineIds = [router.id, ...(source === null ? [] : [source.id])].sort((a, b) => a - b);
  await expect
    .poll(async () => {
      const d = await drawnNodesOf(page);
      return { machines: d.machines, strays: d.strays };
    }, { message: `${ctx}: the machine layer draws exactly the machines the model holds` })
    .toEqual({ machines: machineIds, strays: 0 });
  await expect
    .poll(async () => glyphSubjectOn(page, router.id), { message: `${ctx}: the Router's body draws the Router art` })
    .toBe('router');
  const box = await glyphBoxOn(page, router.id);
  expect(box, `${ctx}: the Router's glyph is drawn`).not.toBeNull();
  expect(
    { footW: box!.footW, footH: box!.footH },
    `${ctx}: the drawn Router body is the 2 by 3 Router box`,
  ).toEqual({ footW: 2 * CELL_PX, footH: 3 * CELL_PX });
  expect(
    box!.x >= 0 && box!.y >= 0 && box!.x + box!.w <= box!.footW && box!.y + box!.h <= box!.footH,
    `${ctx}: the Router's glyph lies inside its own body`,
  ).toBe(true);
  if (source !== null) {
    await expect
      .poll(async () => glyphSubjectOn(page, source.id), { message: `${ctx}: the Source's body draws the Source art` })
      .toBe('source');
  }
}

/** The label at NEIGHBOUR_AT is plotted on its four cells and its words are on screen. */
async function expectLabelDrawn(page: Page, ctx: string): Promise<void> {
  const label = onlyOf(await readScene(page), KIND_LABEL)!;
  await expect
    .poll(async () => (await labelBoxOn(page, label.id))?.rect ?? null, {
      message: `${ctx}: the label box is plotted on (10,10) to (13,10)`,
    })
    .toEqual({
      x: NEIGHBOUR_AT[0] * CELL_PX + BOX_INSET,
      y: NEIGHBOUR_AT[1] * CELL_PX + BOX_INSET,
      w: 4 * CELL_PX - 2 * BOX_INSET,
      h: 1 * CELL_PX - 2 * BOX_INSET,
    });
  await expect
    .poll(async () => labelWordsOf(page, label.id), { message: `${ctx}: the label's words are drawn` })
    .toMatchObject({ text: WORDS, visible: true });
}

/** Save to `fab` through the toolbar, New, then Open `fab` through the toolbar: the board
 *  comes back with `topology` and no refusal card. */
async function saveNewOpen(page: Page, fab: string, topology: string): Promise<void> {
  page.once('dialog', (d) => void d.accept(fab));
  await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
  await expect
    .poll(() => existsSync(fab), {
      timeout: 45_000,
      intervals: [200, 500, 1000],
      message: 'the host wrote the .fab at quiescence (a real save artifact on disk)',
    })
    .toBe(true);
  await newBoard(page);
  await expectRenderLoopAlive(page, 'on the new empty board');
  page.once('dialog', (d) => void d.accept(fab));
  await page.getByTitle('Load a saved factory').click();
  await pollScene(page, topologyOf, {
    message: 'the saved board opened again with the same topology (the turned Router included)',
  }).toBe(topology);
  await expect(page.getByRole('alert'), 'no refusal card: the saved board opens').toHaveCount(0);
  await waitForCameraSettle(page);
  await expectRenderLoopAlive(page, 'on the reopened board');
}

test.describe('D-03 live: Delete then Ctrl+Z brings a turned machine back turned, on its own cells', () => {
  test('leg 1: a turned Router beside a Source on its unturned cell comes back turned, the Source keeps its cell, and the board reopens', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    const fab = join(tmpdir(), `fabrico-e2e-86-turned-source-${Date.now()}.fab`);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before anything is placed');
    await turnedRouter(page);

    await armAndPlaceAt(page, 'Source', NEIGHBOUR_AT[0], NEIGHBOUR_AT[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, NEIGHBOUR_AT[0], NEIGHBOUR_AT[1])?.kind ?? null, {
      message: 'the real host echoed a Source at (10,10)',
    }).toBe(KIND_SOURCE);
    await expectRenderLoopAlive(page, 'after the Source is placed');

    await deleteAndUndoRouter(page);
    const after = await readScene(page);
    expect(after.nodes.length, 'two nodes are on the board: the Router and the Source').toBe(2);
    expect(
      sortedCells(onlyOf(after, KIND_SOURCE)!),
      'the Source keeps its cell (10,10)',
    ).toEqual(['10,10']);
    await expectMachinesDrawn(page, 'after the Ctrl+Z', true);

    await saveNewOpen(page, fab, topologyOf(after));
    await expectMachinesDrawn(page, 'on the reopened board', true);
    errs.assertNone('across place, turn, place, delete, undo, save and open');
  });

  test('leg 2: a turned Router beside a label on its unturned cells comes back turned, the label keeps its cells and words, and the board reopens', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    const fab = join(tmpdir(), `fabrico-e2e-86-turned-label-${Date.now()}.fab`);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before anything is placed');
    await turnedRouter(page);

    await handPlaceAt(page, 'Label', NEIGHBOUR_AT[0], NEIGHBOUR_AT[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, NEIGHBOUR_AT[0], NEIGHBOUR_AT[1])?.kind ?? null, {
      message: 'the real host echoed a label anchored at (10,10)',
    }).toBe(KIND_LABEL);
    await expect(page.locator('#fab-label-text'), 'the placed label focuses its Text field').toBeFocused();
    await page.keyboard.type(WORDS);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await pollScene(page, (s) => {
      const n = onlyOf(s, KIND_LABEL);
      return n ? { cells: sortedCells(n), text: n.label?.text ?? null } : null;
    }, { message: 'the host holds the label on its four cells with its words' }).toEqual({
      cells: LABEL_CELLS,
      text: WORDS,
    });
    await clickFloor(page);
    await expect(page.locator('#fab-config-heading'), 'the floor click closed the label panel').toHaveCount(0);
    await expectLabelDrawn(page, 'before the Delete');
    await expectRenderLoopAlive(page, 'after the label is placed');

    await deleteAndUndoRouter(page);
    const after = await readScene(page);
    expect(after.nodes.length, 'two nodes are on the board: the Router and the label').toBe(2);
    const label = onlyOf(after, KIND_LABEL)!;
    expect(
      { cells: sortedCells(label), text: label.label?.text ?? null },
      'the label keeps its four cells and its words',
    ).toEqual({ cells: LABEL_CELLS, text: WORDS });
    await expectMachinesDrawn(page, 'after the Ctrl+Z', false);
    await expectLabelDrawn(page, 'after the Ctrl+Z');
    await expect
      .poll(async () => (await drawnNodesOf(page)).labels, { message: 'the machine layer draws the one label' })
      .toEqual([label.id]);

    await saveNewOpen(page, fab, topologyOf(after));
    await expectMachinesDrawn(page, 'on the reopened board', false);
    await expectLabelDrawn(page, 'on the reopened board');
    errs.assertNone('across place, turn, label, delete, undo, save and open');
  });
});
