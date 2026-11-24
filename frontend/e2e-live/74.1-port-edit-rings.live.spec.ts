import { test, expect, type Page } from './support/liveTest';
import {
  DRAWN_STATE_FRAMES,
  alertRingCentres,
  armAndPlaceAt,
  cameraOf,
  CELL,
  cellCentre,
  expectRenderLoopAlive,
  newBoard,
  nubAnchor,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
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
// The walk (74.1-REWALK-2.md N5 and N5B) found two ring defects after a port edit: a second
// red ring on a still-connected nub, and no ring at all on a belt a redo let go of (the redo
// arrives as a full keyframe). The first fix resolves the vacated nub on the board as it was
// before the packet; the second widens the keyframe detector. The test below walks the redo
// case on a turn, which lets go of three belts at once.
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

/** The TEE wire kind (kinds.ts): the TURN-REDO leg's machine since plan 89-02. */
const KIND_TEE = 3;
const ROLE_OUT = 1;
/** Pointer moves per cell crossed: a hand's drag, never a one-event teleport. */
const STEPS_PER_CELL = 8;

type NodeFacts = SceneFacts['nodes'][number];
type Pt = { x: number; y: number };

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

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
