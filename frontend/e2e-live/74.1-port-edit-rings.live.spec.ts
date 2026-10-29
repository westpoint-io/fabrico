import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  DRAWN_STATE_FRAMES,
  alertRingCentres,
  armAndPlaceAt,
  armAndPlaceFactoryAt,
  cameraOf,
  CELL,
  cellCentre,
  clickAt,
  expectRenderLoopAlive,
  newBoard,
  nubAnchor,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';

// 74.1-port-edit-rings.live.spec.ts (plan 74.1-27, walk items N5 and N5B) - the alarm
// rings after a port edit, through undo and redo, graded where they are PLOTTED.
//
// The walk board (74.1-REWALK-2.md N5): a Factory placed on clear floor, `+ Add
// output`, a short belt drawn east from each output. `Remove output 1` lets go of the
// middle-row belt only. The walk then saw, on the real binary:
//   N5   a second red ring on the still-connected bottom output's nub (fixed by
//        resolving the vacated nub on the board as it was before the packet);
//   N5B  after Ctrl+Z then Ctrl+Shift+Z (the redo arrives as a full keyframe), no ring
//        at all on the belt the redo let go of (fixed by widening the keyframe
//        detector from "an undo of a turn" to "an undo or redo that changes one
//        machine's turn or port count").
//
// THE N5B RULING (2026-10-05): after the redo,
// `+ Add output` fills the freed middle row, is listed SECOND in the panel (outputs are
// listed in the order they were made), and does not reconnect the loose belt, which
// keeps its ring. This leg asserts all four.
//
// TURN-REDO (plan 74.1-33, review round 4 WR-03): a machine on empty floor with a belt
// docked to each of its three ports, turned with R. The turn lets go of all three belts and
// rings each loose end and each vacated nub. A TEE since plan 89-02 (D-08), and a Factory
// before it: a turn now docks every loose belt end a port of the turned machine faces, and
// a quarter turn of a Factory always puts its Out (or its Fault) on the doorstep the other
// one left, so the turn re-aimed one belt and let go of only two. The Tee's In and two Outs
// land on three fresh doorsteps after a quarter turn, so its turn still lets go of three. Ctrl+Z re-docks them and
// clears every ring; Ctrl+Shift+Z is the turn again, as a full keyframe, and must ring the
// same points. RED before 74.1-33: the keyframe detector capped the lost docks at two, so
// the redo rang nothing.
//
// Rings are read with `alertRingCentres`, the centres the ring Graphics plotted, never
// the list handed to the paint; the model is read with `readScene`. Render health is
// asserted at both ends because the oracle reads the model.

test.describe.configure({ mode: 'serial' });

const KIND_FACTORY = 2;
/** The TEE wire kind (kinds.ts): the TURN-REDO leg's machine since plan 89-02. */
const KIND_TEE = 3;
const ROLE_OUT = 1;
/** The cell 74.1-REWALK-2 and the UNDO-06 leg measured clear on the demo board. */
const PLACE_CELL = [6, 11] as const;
/** Pointer moves per cell crossed: a hand's drag, never a one-event teleport. */
const STEPS_PER_CELL = 8;
/** `nubHitRadiusWorld(1)`, the literal: this suite keeps its one shared import. */
const NUB_HIT_RADIUS_AT_SCALE_1 = 12;
/** "At" a point: the plot is exact geometry, this only absorbs float noise. */
const AT_PX = 2;

type NodeFacts = SceneFacts['nodes'][number];
type Pt = { x: number; y: number };

function factoryOf(scene: SceneFacts, id: number): NodeFacts {
  const node = scene.nodes.find((n) => n.id === id && n.kind === KIND_FACTORY);
  expect(node, `factory ${id} is on the board`).toBeDefined();
  return node as NodeFacts;
}
/** The factory at the placed anchor, by GEOMETRY: a keyframe may re-mint its handle. */
function placedFactory(scene: SceneFacts): NodeFacts {
  const node = scene.nodes.find(
    (n) =>
      n.kind === KIND_FACTORY &&
      Math.min(...n.cells.map((c) => c[0])) === PLACE_CELL[0] &&
      Math.min(...n.cells.map((c) => c[1])) === PLACE_CELL[1],
  );
  expect(node, 'the placed factory is on the board').toBeDefined();
  return node as NodeFacts;
}
const outsOf = (node: NodeFacts) => node.ports.filter((p) => p.role === ROLE_OUT);
/** The belt whose FIRST tile is `cell` (tiles survive a keyframe; handles do not). */
function beltAt(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find(
    (b) => b.tiles.length > 0 && b.tiles[0].cell_x === cell[0] && b.tiles[0].cell_y === cell[1],
  );
}
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

const portsSection = (page: Page) => page.getByRole('region', { name: 'Ports' });
const outRows = (page: Page): Locator => portsSection(page).getByRole('listitem', { name: 'Output - Item' });
const addOutput = (page: Page) => portsSection(page).getByRole('button', { name: '+ Add output' });
const removeOutput = (page: Page, n: number) =>
  portsSection(page).getByRole('button', { name: `Remove output ${n}` });

async function selectPlaced(page: Page): Promise<void> {
  const anchor = await screenCellCentre(page, PLACE_CELL[0], PLACE_CELL[1]);
  await clickAt(page, anchor.x, anchor.y);
  await expect(page.getByRole('heading', { name: 'Factory' }), 'the config panel mounts').toBeVisible({
    timeout: 10_000,
  });
}

/** Move focus off the clicked control so the canvas accelerators are live (LW-02). */
async function blurControls(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Poll until exactly `n` rings are plotted, then return their centres. */
async function ringsWhenPlotted(page: Page, n: number, message: string): Promise<Pt[]> {
  await expect
    .poll(async () => (await alertRingCentres(page)).length, { timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'rings plotted poll'), intervals: [100, 250, 500], message })
    .toBe(n);
  return alertRingCentres(page);
}

test.describe('74.1-27 live: the rings after a port edit, through undo and redo', () => {
  test('N5B: a redo of Remove output 1 rings the loose belt and the vacated nub, and the next + Add output keeps that ring', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectRenderLoopAlive(page, 'on the demo board before the walk');

    // ---- The walk board.
    const factoriesBefore = (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).length;
    await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
      message: 'the real host echoes the placed factory',
    }).toBe(factoriesBefore + 1);
    const id = placedFactory(await readScene(page)).id;
    await selectPlaced(page);
    await addOutput(page).click();
    await pollScene(page, (s) => outsOf(factoryOf(s, id)).length, { message: 'a second output' }).toBe(2);

    // A belt east from each output, pressed a little off the nub's centre and dragged
    // two cells with a hand's pointer moves.
    for (const ordinal of [0, 1]) {
      const out = outsOf(factoryOf(await readScene(page), id))[ordinal];
      const anchor = nubAnchor(out.cell_x, out.cell_y, out.side);
      const press = await screenPoint(page, { x: anchor.x + 2, y: anchor.y - 3 });
      const release = await screenPoint(page, {
        x: cellCentre(out.cell_x + 2) + 5,
        y: cellCentre(out.cell_y) + 4,
      });
      await page.getByTitle(/^Draw belts/).click();
      await page.mouse.move(press.x, press.y);
      await page.mouse.down();
      await page.mouse.move(release.x, release.y, { steps: 2 * STEPS_PER_CELL });
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await pollScene(
        page,
        (s) => s.belts.filter((b) => b.docks.some((d) => d.end === 'Tail' && d.node === id)).length,
        { message: `the belt from output ${ordinal + 1} docked` },
      ).toBe(ordinal + 1);
    }

    // Where the rings must and must not be, captured before any edit, in world px.
    const built = await readScene(page);
    const [middle, bottom] = outsOf(factoryOf(built, id));
    const middleNub = nubAnchor(middle.cell_x, middle.cell_y, middle.side);
    const bottomNub = nubAnchor(bottom.cell_x, bottom.cell_y, bottom.side);
    const looseTail = [middle.cell_x + 1, middle.cell_y] as const;
    const keptTail = [bottom.cell_x + 1, bottom.cell_y] as const;
    expect(beltAt(built, looseTail), 'a belt starts in front of the middle output').toBeDefined();
    expect(beltAt(built, keptTail), 'a belt starts in front of the bottom output').toBeDefined();
    const looseEnd = { x: cellCentre(looseTail[0]), y: cellCentre(looseTail[1]) };
    const keptEnd = { x: cellCentre(keptTail[0]), y: cellCentre(keptTail[1]) };
    expect(await alertRingCentres(page), 'no ring on the built board').toEqual([]);
    await expectRenderLoopAlive(page, 'on the built walk board');

    /** Exactly the two rings of the middle output's strand, and nothing near the kept output or belt. */
    const expectTheTwoRings = (rings: Pt[], ctx: string): void => {
      const plotted = JSON.stringify(rings);
      expect(rings, `${ctx}: two rings (plotted ${plotted})`).toHaveLength(2);
      expect(
        Math.min(...rings.map((r) => dist(r, middleNub))),
        `${ctx}: one ring on the removed output's nub where it was (${middleNub.x}, ${middleNub.y}; plotted ${plotted})`,
      ).toBeLessThanOrEqual(AT_PX);
      expect(
        Math.min(...rings.map((r) => dist(r, looseEnd))),
        `${ctx}: one ring on the loose belt's end (${looseEnd.x}, ${looseEnd.y}; plotted ${plotted})`,
      ).toBeLessThanOrEqual(AT_PX);
      expect(
        rings.filter((r) => dist(r, bottomNub) <= NUB_HIT_RADIUS_AT_SCALE_1),
        `${ctx}: no ring on the bottom output's nub, which is still connected (plotted ${plotted})`,
      ).toEqual([]);
      expect(
        rings.filter((r) => dist(r, keptEnd) <= NUB_HIT_RADIUS_AT_SCALE_1),
        `${ctx}: no ring on the bottom belt's end, which is still docked`,
      ).toEqual([]);
    };
    const dockOf = (scene: SceneFacts, cell: readonly [number, number]): string[] =>
      (beltAt(scene, cell)?.docks ?? []).map((d) => `${d.end}:${d.port}`);

    // ---- Remove output 1: the forward strand (the N5 fix).
    await selectPlaced(page);
    await removeOutput(page, 1).click();
    await pollScene(page, (s) => outsOf(placedFactory(s)).length, { message: 'the removal folded' }).toBe(1);
    expect(dockOf(await readScene(page), looseTail), 'the middle belt let go').toEqual([]);
    expectTheTwoRings(await ringsWhenPlotted(page, 2, 'the removal rings two points'), 'after Remove output 1');

    // ---- Ctrl+Z: the output and its belt are back; no ring.
    await blurControls(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => outsOf(placedFactory(s)).length, { message: 'the undo restored the output' }).toBe(2);
    expect(dockOf(await readScene(page), looseTail), 'the middle belt is docked again').toEqual(['Tail:0']);
    await ringsWhenPlotted(page, 0, 'the undo clears every ring');

    // ---- Ctrl+Shift+Z: the redo lets the middle belt go again, as a full keyframe.
    // RED BEFORE 74.1-27: no ring at all from here on (walk item N5B).
    await blurControls(page);
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => outsOf(placedFactory(s)).length, { message: 'the redo removed it again' }).toBe(1);
    const redone = await readScene(page);
    expect(dockOf(redone, looseTail), 'the redo let the middle belt go').toEqual([]);
    expect(dockOf(redone, keptTail), 'the bottom belt is still docked, re-keyed to 0').toEqual(['Tail:0']);
    expectTheTwoRings(await ringsWhenPlotted(page, 2, 'the redo rings the loose belt and the vacated nub'), 'after the redo');
    await expectRenderLoopAlive(page, 'after the redo');

    // ---- + Add output: the freed middle row, listed second, and the loose belt keeps
    // its ring (the N5B ruling).
    await selectPlaced(page);
    await addOutput(page).click();
    await pollScene(page, (s) => outsOf(placedFactory(s)).length, { message: 'the add folded' }).toBe(2);
    const added = placedFactory(await readScene(page));
    expect(
      outsOf(added).map((p) => [p.cell_x, p.cell_y]),
      'the new output fills the middle row and comes SECOND in the port order; the bottom one stays first',
    ).toEqual([
      [bottom.cell_x, bottom.cell_y],
      [middle.cell_x, middle.cell_y],
    ]);
    await expect(outRows(page), 'two output rows').toHaveCount(2);
    await expect(outRows(page).nth(0), 'the bottom output, connected, is listed first').not.toHaveAttribute(
      'aria-label',
      /not connected/,
    );
    await expect(outRows(page).nth(1), 'the new output, not connected, is listed second').toHaveAttribute(
      'aria-label',
      /not connected/,
    );
    // Held for a beat of real packets, not read once: the add must not dock the belt
    // and must not clear its ring.
    await page.waitForTimeout(1_000);
    const afterAdd = await readScene(page);
    expect(dockOf(afterAdd, looseTail), 'the add does not reconnect the loose belt').toEqual([]);
    const ringsAfterAdd = await alertRingCentres(page);
    expect(
      Math.min(...ringsAfterAdd.map((r) => dist(r, looseEnd))),
      `the loose belt's ring is still plotted at its end after the add (plotted ${JSON.stringify(ringsAfterAdd)})`,
    ).toBeLessThanOrEqual(AT_PX);
    expect(
      ringsAfterAdd.filter((r) => dist(r, bottomNub) <= NUB_HIT_RADIUS_AT_SCALE_1),
      'and still no ring on the bottom output',
    ).toEqual([]);

    await expectRenderLoopAlive(page, 'after the add');
    errs.assertNone('across remove, undo, redo and add');
  });

  test('TURN-REDO: a redo of a turn that lets go of three belts rings all three loose ends and their vacated nubs', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
    await expectRenderLoopAlive(page, 'on the empty board before the leg');

    const AT = [10, 6] as const;
    // A TEE since plan 89-02 (D-08): see the TURN-REDO paragraph at the top of the file.
    await armAndPlaceAt(page, 'Tee', AT[0], AT[1]);
    await pollScene(page, (s) => s.nodes.length, { message: 'the real host echoed the placed Tee' }).toBe(1);
    const theMachine = (s: SceneFacts): NodeFacts => {
      const fs = s.nodes.filter((n) => n.kind === KIND_TEE);
      expect(fs, 'exactly one Tee is on the board').toHaveLength(1);
      return fs[0];
    };
    const f0 = theMachine(await readScene(page));
    const portOf = (role: number) => {
      const port = f0.ports.find((q) => q.role === role);
      expect(port, `the Tee has a port of role ${role}`).toBeDefined();
      return port!;
    };
    const step = (side: number): [number, number] => [[0, -1], [1, 0], [0, 1], [-1, 0]][side & 3] as [number, number];
    /** A screen point `(dx, dy)` world px off the centre of cell `c`: off-centre, as a hand presses. */
    const offCentre = async (c: readonly [number, number], dx: number, dy: number): Promise<Pt> =>
      screenPoint(page, { x: cellCentre(c[0]) + dx, y: cellCentre(c[1]) + dy });
    /** Arm the Belt tool, press `cells[0]` off-centre and walk the rest in sub-cell samples. */
    const pressAndWalk = async (cells: Array<readonly [number, number]>): Promise<void> => {
      await page.getByTitle(/^Draw belts/).click();
      const a = await offCentre(cells[0], 5, -6);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      for (let i = 1; i < cells.length; i++) {
        const p = await offCentre(cells[i], i % 2 === 0 ? -4 : 3, i % 2 === 0 ? 5 : -3);
        await page.mouse.move(p.x, p.y, { steps: STEPS_PER_CELL });
      }
    };
    const docksOnMachine = (s: SceneFacts): string[] => {
      const id = theMachine(s).id;
      return s.belts
        .flatMap((b) => b.docks.filter((d) => d.node === id).map((d) => `${d.end}:${d.port}`))
        .sort();
    };

    // Both Outs: press the doorstep, run three cells straight out, release on floor.
    const outs = f0.ports.filter((q) => q.role === ROLE_OUT);
    expect(outs, 'the Tee has two Outs').toHaveLength(2);
    for (const port of outs) {
      const [dx, dy] = step(port.side);
      const cells = [1, 2, 3].map((k) => [port.cell_x + dx * k, port.cell_y + dy * k] as const);
      const before = docksOnMachine(await readScene(page)).length;
      await pressAndWalk(cells);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => docksOnMachine(s).length, {
        message: `the belt drawn off the Out at (${port.cell_x},${port.cell_y}) docked its Tail`,
      }).toBe(before + 1);
    }
    // In: press plain floor three cells out, walk in to the doorstep, release on the nub.
    {
      const port = portOf(0);
      const [dx, dy] = step(port.side);
      const cells = [3, 2, 1].map((k) => [port.cell_x + dx * k, port.cell_y + dy * k] as const);
      const before = docksOnMachine(await readScene(page)).length;
      await pressAndWalk(cells);
      const a = nubAnchor(port.cell_x, port.cell_y, port.side);
      const end = await screenPoint(page, { x: a.x + dx * 3, y: a.y + dy * 3 });
      await page.mouse.move(end.x, end.y, { steps: STEPS_PER_CELL });
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => docksOnMachine(s).length, {
        message: 'the belt drawn into the In docked its Head',
      }).toBe(before + 1);
    }
    const docked = docksOnMachine(await readScene(page));
    expect(docked, 'one Head dock on the In, one Tail dock on each Out').toEqual(['Head:0', 'Tail:0', 'Tail:1']);
    expect(await alertRingCentres(page), 'no ring on the built board').toEqual([]);

    // ---- R: the turn lets go of all three belts (the forward diff path).
    await selectMachineAt(page, AT[0], AT[1]);
    await blurControls(page);
    await page.keyboard.press('r');
    // The facts carry no turn field; the In's side is the turn, read off the ports.
    const inSide = (s: SceneFacts): number => theMachine(s).ports.find((q) => q.role === 0)?.side ?? -1;
    const unturned = portOf(0).side;
    const turned = (unturned + 1) & 3;
    await pollScene(page, inSide, { message: 'the real host folded the turn (the In moved a quarter turn)' }).toBe(turned);
    expect(docksOnMachine(await readScene(page)), 'the turn let go of every belt').toEqual([]);
    const forward = await ringsWhenPlotted(page, 6, 'the turn rings three loose ends and three vacated nubs');

    // ---- Ctrl+Z: every belt docked again, no ring.
    await blurControls(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, inSide, { message: 'the undo turned it back' }).toBe(unturned);
    await pollScene(page, docksOnMachine, { message: 'the undo re-docked every belt' }).toEqual(docked);
    await ringsWhenPlotted(page, 0, 'the undo clears every ring');

    // ---- Ctrl+Shift+Z: the turn again, as a full keyframe. RED before 74.1-33.
    await blurControls(page);
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, inSide, { message: 'the redo turned it again' }).toBe(turned);
    expect(docksOnMachine(await readScene(page)), 'the redo let go of every belt').toEqual([]);
    const redone = await ringsWhenPlotted(
      page,
      forward.length,
      `the redo rings as many points as the turn did (${forward.length}; review WR-03)`,
    );
    const within = CELL / 2;
    for (const r of forward) {
      expect(
        Math.min(...redone.map((q) => dist(q, r))),
        `the redo rings (${r.x}, ${r.y}) as the turn did, within half a tile (redo plotted ${JSON.stringify(redone)})`,
      ).toBeLessThanOrEqual(within);
    }
    for (const q of redone) {
      expect(
        Math.min(...forward.map((r) => dist(q, r))),
        `the redo ring at (${q.x}, ${q.y}) is one the turn rang (turn plotted ${JSON.stringify(forward)})`,
      ).toBeLessThanOrEqual(within);
    }

    await expectRenderLoopAlive(page, 'after the redo of the turn');
    errs.assertNone('across the turn, its undo and its redo');
  });
});
