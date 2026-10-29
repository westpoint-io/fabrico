import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  armAndPlaceAt,
  cameraOf,
  deselectViaEmptyCell,
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
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 74.1-port-edits-keep-place.live.spec.ts (CORNER-06, UNDO-05, UNDO-06; plan 74.1-17) -
// `+ Add output` on a TURNED Factory keeps every belt, on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected packets.
//
// WHAT IT PINS. Plan 74.1-16's rule: no port edit moves an existing port. An add takes the
// first free slot, and when the slots need a bigger box the box grows on its rot-0 east and
// south edges, with the anchor shifted by the turn so the growth lands on the far side in
// world space. One Ctrl+Z restores the box and the anchor exactly.
//
// THE FINDING IT GUARDS (74.1-REVIEW WR-01). Before plan 74.1-16 a growing add kept the
// anchor, and `port_world` maps local y to world x as h-1-y at one turn and to world y as
// h-1-y at two turns. So on a Factory turned 90 or 180 degrees the fourth output grew the
// box from 3 to 4 tall and every In and Out landed one world cell further along: the host
// ACCEPTED the add and released every In and Out belt (links 5 to 1 in the reproduction).
// It was only ever seen through the command layer; this file is the real-app proof.
//
// WHY LEG 1 GOES ON TO A GROWING PRESS. A second and a third output fit the Factory's 3-tall
// catalog box (`grow_to_fit` takes the larger of the In and Out counts and never goes below
// the catalog box; the slots are 1, 2, 0), so neither press grows anything, and WR-01 needs
// growth. A leg that stopped after the first add would pass on the old build too. Leg 1
// therefore presses `+ Add output` until the fourth output, which grows the box, and grades
// every press. Leg 2 sets up three outputs at two turns and grades the growing press with a
// belt on the In and on all three Outs.
//
// WHAT A HAND SEES, AND WHAT IS GRADED. Every belt stays docked, each docked end tile is its
// nub's facing cell, no belt tile moves, every In and Out nub keeps its cell, and the box and
// anchor go back exactly on Ctrl+Z. Every fact is MEASURED off the live scene before it is
// compared (anchor, box, turn, port cells, belt tiles and docks), never written as a
// constant. Belts are drawn the way a hand draws them: the press lands off-centre inside the
// doorstep tile and the pointer moves in sub-cell samples (memory: fixtures that teleport one
// clean cell per event hid four gesture defects in phase 74).
//
// RED FIRST. Both legs were run against servers built at plan 74.1-16's start revision
// and failed on their growing press there; leg 1's first press was green there, as
// the slot arithmetic above predicts. The verdicts are recorded in 74.1-17-SUMMARY.md.
//
// RUN TARGET: the live suite (`playwright.live.reuse.config.ts`, servers started by the
// caller per the LIVE RUN PROCEDURE).

test.describe.configure({ mode: 'serial' });

/** FACTORY wire kind (mirrored from kinds.ts). */
const KIND_FACTORY = 2;
/** Port role bytes: In=0, Out=1, Fault=2. */
const ROLE_IN = 0;
const ROLE_OUT = 1;
const ROLE_FAULT = 2;
/** The routed `FAULT_PORT` sentinel a Fault dock is keyed on (`u16::MAX`). */
const FAULT_PORT = 65535;
/** The empty-board drop cells, one per leg. Every press and release point is checked on the
 *  canvas. Measured at 1280x800, scale 1: the canvas is clear for x in 0..15 and y in 0..13
 *  while a machine is selected (the config panel covers x >= 16), so leg 2, whose In belt runs
 *  east, drops one cell further west than leg 1. */
const LEG1_CELL = [10, 8] as const;
const LEG2_CELL = [9, 8] as const;
/** An empty cell on the canvas, clicked to deselect before a belt is drawn, so neither the
 *  panel nor a hover control near the last click sits over a press point. */
const EMPTY_CELL = [1, 1] as const;
/** Pointer samples per cell walked: sub-cell moves, as a hand makes them. */
const STEPS_PER_CELL = 8;

type NodeFacts = SceneFacts['nodes'][number];
type Cell = readonly [number, number];

/** The outward unit step off a port side (N=0, E=1, S=2, W=3, y-down), the host's
 *  `unit_delta`. Local because the live specs read the app through the page only. */
function sideStep(side: number): [number, number] {
  switch (side & 3) {
    case 0:
      return [0, -1];
    case 1:
      return [1, 0];
    case 2:
      return [0, 1];
    default:
      return [-1, 0];
  }
}

// ---------------------------------------------------------------------------
// Board readers
// ---------------------------------------------------------------------------

/** The one Factory on the board. The board is empty but for it, so this re-resolves it
 *  after a keyframe re-mints handles and after a growing add moves its anchor. */
function theFactory(scene: SceneFacts): NodeFacts {
  const fs = scene.nodes.filter((n) => n.kind === KIND_FACTORY);
  expect(fs, 'exactly one Factory is on the board').toHaveLength(1);
  return fs[0];
}

/** How many Outs the Factory has. */
function outCount(scene: SceneFacts): number {
  return theFactory(scene).ports.filter((p) => p.role === ROLE_OUT).length;
}

/** The turn, read off the In's side: an unturned Factory's In faces W (3). */
function turnOf(node: NodeFacts): number {
  const ins = node.ports.filter((p) => p.role === ROLE_IN);
  expect(ins, 'the Factory has one input').toHaveLength(1);
  return (ins[0].side - 3) & 3;
}

/** The anchor (min cell), the world w x h and the rot-0 w x h of the Factory's box. */
interface Box {
  anchor: Cell;
  cells: string[];
  rot0: [number, number];
}

function boxOf(node: NodeFacts): Box {
  const xs = node.cells.map((c) => c[0]);
  const ys = node.cells.map((c) => c[1]);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const [w, h] = [Math.max(...xs) - minX + 1, Math.max(...ys) - minY + 1];
  expect(node.cells.length, 'the Factory box is a full rectangle').toBe(w * h);
  const odd = (turnOf(node) & 1) === 1;
  return {
    anchor: [minX, minY],
    cells: node.cells.map((c) => `${c[0]},${c[1]}`).sort(),
    rot0: odd ? [h, w] : [w, h],
  };
}

/** Every In and Out nub as `role:side@x,y`, sorted. */
function ioNubs(node: NodeFacts): string[] {
  return node.ports
    .filter((p) => p.role === ROLE_IN || p.role === ROLE_OUT)
    .map((p) => `${p.role}:${p.side}@${p.cell_x},${p.cell_y}`)
    .sort();
}

/** The first Fault port's cell. */
function faultCell(node: NodeFacts): Cell {
  const f = node.ports.find((p) => p.role === ROLE_FAULT);
  expect(f, 'the Factory has a Fault port').toBeDefined();
  return [(f as PortFacts).cell_x, (f as PortFacts).cell_y];
}

/** Every dock naming the Factory, as sorted `end:key` strings: the LINK set. */
function docksOf(scene: SceneFacts, id: number): string[] {
  return scene.belts
    .flatMap((b) => b.docks)
    .filter((d) => d.node === id)
    .map((d) => `${d.end}:${d.port}`)
    .sort();
}

/** Every belt's tile path, one string per belt, sorted: the belts' GEOMETRY. */
function beltPaths(scene: SceneFacts): string[] {
  return scene.belts.map((b) => b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' ')).sort();
}

/** One dock naming the Factory: the facing cell of the port it names and the belt end
 *  tile it holds. A Head key is a catalog index, a Tail key the n-th Out, `FAULT_PORT`
 *  the first Fault. */
interface Touch {
  dock: string;
  facing: Cell;
  end: Cell;
}

function touches(scene: SceneFacts, node: NodeFacts): Touch[] {
  const outs = node.ports.filter((p) => p.role === ROLE_OUT);
  const out: Touch[] = [];
  for (const b of scene.belts) {
    for (const d of b.docks) {
      if (d.node !== node.id) continue;
      const port =
        d.port === FAULT_PORT
          ? node.ports.find((p) => p.role === ROLE_FAULT)
          : d.end === 'Head'
            ? node.ports.find((p) => p.index === d.port)
            : outs[d.port];
      expect(port, `the ${d.end}:${d.port} dock names a port on the Factory`).toBeDefined();
      const p = port as PortFacts;
      const [dx, dy] = sideStep(p.side);
      const tile = d.end === 'Tail' ? b.tiles[0] : b.tiles[b.tiles.length - 1];
      out.push({ dock: `${d.end}:${d.port}`, facing: [p.cell_x + dx, p.cell_y + dy], end: [tile.cell_x, tile.cell_y] });
    }
  }
  return out.sort((a, b) => a.dock.localeCompare(b.dock));
}

/** Everything a press is graded against, captured off the live scene before it. */
interface Board {
  box: Box;
  turn: number;
  outs: number;
  io: string[];
  fault: Cell;
  docks: string[];
  belts: string[];
}

function capture(scene: SceneFacts): Board {
  const f = theFactory(scene);
  return {
    box: boxOf(f),
    turn: turnOf(f),
    outs: f.ports.filter((p) => p.role === ROLE_OUT).length,
    io: ioNubs(f),
    fault: faultCell(f),
    docks: docksOf(scene, f.id),
    belts: beltPaths(scene),
  };
}

/**
 * Every belt the board had before is still docked to the Factory and touching its nub, no
 * belt tile moved, and every In and Out nub the board had before keeps its cell (an add may
 * ADD a nub; none moves). Each for-all asserts its set non-empty first.
 */
function expectEveryBeltHeld(scene: SceneFacts, before: Board, ctx: string): void {
  const f = theFactory(scene);
  expect(before.docks.length, `${ctx}: measured, the board carries docks to grade`).toBeGreaterThan(0);
  expect(docksOf(scene, f.id), `${ctx}: every belt is still docked to the Factory`).toEqual(before.docks);
  const t = touches(scene, f);
  expect(t.length, `${ctx}: every dock is read`).toBe(before.docks.length);
  for (const x of t) {
    expect(x.end, `${ctx}: the ${x.dock} belt's end tile is its nub's facing cell`).toEqual(x.facing);
  }
  expect(beltPaths(scene), `${ctx}: no belt tile moved`).toEqual(before.belts);
  expect(before.io.length, `${ctx}: measured, the Factory has In and Out nubs to grade`).toBeGreaterThan(0);
  const now = ioNubs(f);
  for (const n of before.io) {
    expect(now, `${ctx}: the In/Out nub ${n} keeps its cell`).toContain(n);
  }
  expect(turnOf(f), `${ctx}: the turn is unchanged`).toBe(before.turn);
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

const portsSection = (page: Page): Locator => page.getByRole('region', { name: 'Ports' });
const addOutput = (page: Page): Locator => portsSection(page).getByRole('button', { name: '+ Add output' });

/** A screen point `(dx, dy)` world px off the centre of cell (cx, cy): off-centre, as a
 *  hand presses. */
async function offCentre(page: Page, cell: Cell, dx: number, dy: number): Promise<{ x: number; y: number }> {
  const c = await screenCellCentre(page, cell[0], cell[1]);
  const s = (await cameraOf(page)).scale;
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** Every point is on the canvas, not under chrome (the panel is a top-right overlay). */
async function expectOnCanvas(page: Page, pts: { x: number; y: number }[], ctx: string): Promise<void> {
  const tags = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null),
    pts,
  );
  expect(tags, `${ctx}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/** Every cell is free floor: no machine cell, no belt tile, and (for the cells a press or a
 *  walk crosses) no port's doorstep but the one the belt is meant to dock. */
function expectFreeFloor(scene: SceneFacts, cells: Cell[], ctx: string): void {
  for (const [cx, cy] of cells) {
    expect(
      scene.nodes.some((n) => n.cells.some((c) => c[0] === cx && c[1] === cy)),
      `${ctx}: (${cx},${cy}) is outside every machine`,
    ).toBe(false);
    expect(
      scene.belts.some((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy)),
      `${ctx}: (${cx},${cy}) carries no belt`,
    ).toBe(false);
  }
}

/** Arm the Belt tool, press `cells[0]` off-centre and walk the rest in sub-cell samples to
 *  off-centre points. The caller releases. */
async function pressAndWalk(page: Page, cells: Cell[], ctx: string): Promise<void> {
  const pts = [await offCentre(page, cells[0], 5, -6)];
  for (let i = 1; i < cells.length; i++) {
    pts.push(await offCentre(page, cells[i], i % 2 === 0 ? -4 : 3, i % 2 === 0 ? 5 : -3));
  }
  await expectOnCanvas(page, pts, ctx);
  await page.getByTitle(/^Draw belts/).click();
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    await page.mouse.move(p.x, p.y, { steps: STEPS_PER_CELL });
  }
}

/** Draw a belt OUT of an Out: press its doorstep tile, run `len` cells straight out and
 *  release on plain floor. The press records the Tail dock. */
async function drawOutBelt(page: Page, port: PortFacts, len: number): Promise<void> {
  const [dx, dy] = sideStep(port.side);
  const cells: Cell[] = Array.from({ length: len }, (_, k) => [port.cell_x + dx * (k + 1), port.cell_y + dy * (k + 1)]);
  const scene = await readScene(page);
  expectFreeFloor(scene, cells, `the belt off the Out at (${port.cell_x},${port.cell_y})`);
  const docksBefore = docksOf(scene, theFactory(scene).id).length;
  await pressAndWalk(page, cells, `the belt off the Out at (${port.cell_x},${port.cell_y})`);
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await pollScene(page, (s) => docksOf(s, theFactory(s).id).length, {
    message: `the real host docked the belt drawn off the Out at (${port.cell_x},${port.cell_y})`,
  }).toBe(docksBefore + 1);
}

/** Draw a belt INTO the In: press plain floor `len - 1` cells out from its doorstep, walk
 *  straight to the doorstep and release on the In's nub. The release records the Head dock. */
async function drawInBelt(page: Page, port: PortFacts, len: number): Promise<void> {
  const [dx, dy] = sideStep(port.side);
  const cells: Cell[] = Array.from({ length: len }, (_, i) => {
    const k = len - i;
    return [port.cell_x + dx * k, port.cell_y + dy * k];
  });
  const scene = await readScene(page);
  expectFreeFloor(scene, cells, 'the belt into the In');
  const doorsteps = scene.nodes.flatMap((n) =>
    n.ports.map((p) => {
      const [sx, sy] = sideStep(p.side);
      return `${p.cell_x + sx},${p.cell_y + sy}`;
    }),
  );
  expect(doorsteps, 'the press cell is no port\'s doorstep, so the press starts a plain draw').not.toContain(
    `${cells[0][0]},${cells[0][1]}`,
  );
  const docksBefore = docksOf(scene, theFactory(scene).id).length;
  await pressAndWalk(page, cells, 'the belt into the In');
  // The release lands inside the doorstep tile, 3 world px out from the In's nub anchor.
  const a = nubAnchor(port.cell_x, port.cell_y, port.side);
  const end = await screenPoint(page, { x: a.x + dx * 3, y: a.y + dy * 3 });
  await expectOnCanvas(page, [end], 'the release on the In');
  await page.mouse.move(end.x, end.y, { steps: STEPS_PER_CELL });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await pollScene(page, (s) => docksOf(s, theFactory(s).id).length, {
    message: 'the real host docked the belt drawn into the In',
  }).toBe(docksBefore + 1);
}

/** Select the Factory by clicking its CURRENT anchor (re-read: a growing add moves it). */
async function selectTheFactory(page: Page): Promise<void> {
  const [ax, ay] = boxOf(theFactory(await readScene(page))).anchor;
  await selectMachineAt(page, ax, ay);
}

/** Press `+ Add output` and wait for the host to fold it. */
async function pressAddOutput(page: Page, outsBefore: number, ctx: string): Promise<void> {
  await expect(addOutput(page), `${ctx}: + Add output is offered`).toBeEnabled();
  await addOutput(page).click();
  await pollScene(page, (s) => outCount(s), {
    message: `${ctx}: the real host folded the AddPort (the Factory now has ${outsBefore + 1} outputs)`,
  }).toBe(outsBefore + 1);
}

/** Move focus off the panel button (LW-02 stands Ctrl+Z down while a button holds focus),
 *  press Ctrl+Z once and wait for the host to fold the inverse. */
async function undoOnce(page: Page, outsAfter: number, ctx: string): Promise<void> {
  await page.getByRole('heading', { name: 'Outputs' }).click();
  await page.keyboard.press('Control+z');
  await pollScene(page, (s) => outCount(s), {
    message: `${ctx}: one Ctrl+Z reversed the AddPort on the real host (${outsAfter} outputs)`,
  }).toBe(outsAfter);
}

/** An empty board at camera scale 1 with one fresh Factory dropped at `at`, selected and
 *  turned `turns` times with `r`. */
async function turnedFactory(page: Page, at: Cell, turns: number): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  await expectOnCanvas(page, [await screenCellCentre(page, at[0], at[1])], 'the drop cell');
  await armAndPlaceAt(page, 'Factory', at[0], at[1]);
  await pollScene(page, (s) => s.nodes.length, { message: 'the real host echoed the placed Factory' }).toBe(1);
  const placed = theFactory(await readScene(page));
  expect(turnOf(placed), 'measured: a fresh Factory is unturned').toBe(0);
  expect(boxOf(placed).rot0, 'measured: a fresh Factory is 3x3').toEqual([3, 3]);
  await selectTheFactory(page);
  for (let t = 1; t <= turns; t++) {
    await page.keyboard.press('r');
    await pollScene(page, (s) => turnOf(theFactory(s)), {
      message: `the real host folded Rotate ${t} (the Factory is turned ${t * 90} degrees)`,
    }).toBe(t);
  }
  expect(boxOf(theFactory(await readScene(page))).rot0, 'the turned Factory is still 3x3').toEqual([3, 3]);
}

test.describe('CORNER-06 live: + Add output on a turned Factory keeps every belt (WR-01)', () => {
  test('leg 1, one turn: every add keeps every belt and nub, the fourth output grows the box, and one Ctrl+Z restores the 3-tall box and the anchor', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await turnedFactory(page, LEG1_CELL, 1);

    // Belts off the input's and the first output's doorsteps.
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    const f0 = theFactory(await readScene(page));
    const inPort = f0.ports.find((p) => p.role === ROLE_IN) as PortFacts;
    const out0 = f0.ports.find((p) => p.role === ROLE_OUT) as PortFacts;
    await drawInBelt(page, inPort, 4);
    await drawOutBelt(page, out0, 3);

    const b1 = capture(await readScene(page));
    expect(b1.outs, 'measured: one output before the first press').toBe(1);
    expect(b1.docks, 'measured: one Head dock on the In, one Tail dock on the output').toHaveLength(2);
    for (const x of touches(await readScene(page), theFactory(await readScene(page)))) {
      expect(x.end, `as drawn, the ${x.dock} belt touches its nub`).toEqual(x.facing);
    }

    // PRESS 1: the second output fits the 3-tall catalog box.
    await selectTheFactory(page);
    await pressAddOutput(page, 1, 'press 1');
    const p1 = await readScene(page);
    expectEveryBeltHeld(p1, b1, 'after press 1 (the second output)');
    expect(boxOf(theFactory(p1)), 'press 1: the second output fits, the box and anchor do not move').toEqual(b1.box);

    // ...and its Ctrl+Z: the same, and every nub exactly as before.
    await undoOnce(page, 1, 'press 1');
    const u1 = await readScene(page);
    expectEveryBeltHeld(u1, b1, 'after the Ctrl+Z of press 1');
    expect(ioNubs(theFactory(u1)), 'the Ctrl+Z of press 1 leaves every In/Out nub as before').toEqual(b1.io);
    expect(boxOf(theFactory(u1)), 'the Ctrl+Z of press 1 leaves the box as before').toEqual(b1.box);

    // PRESSES 2 AND 3: the second output again and the third, both fitting the 3-tall box.
    await selectTheFactory(page);
    let before = capture(await readScene(page));
    for (const n of [2, 3]) {
      await pressAddOutput(page, n - 1, `the add to ${n} outputs`);
      const s = await readScene(page);
      expectEveryBeltHeld(s, before, `after the add to ${n} outputs`);
      expect(boxOf(theFactory(s)), `the output ${n} fits: the box and anchor do not move`).toEqual(b1.box);
      before = capture(s);
    }

    // PRESS 4: THE GROWING PRESS. The fourth output needs a fourth row, so the box grows
    // from 3 to 4 tall; at one turn the growth lands on the west, so the anchor moves.
    const b3 = before;
    expect(b3.outs, 'measured: three outputs before the growing press').toBe(3);
    expect(b3.box.rot0, 'measured: still the 3x3 catalog box before the growing press').toEqual([3, 3]);
    await pressAddOutput(page, 3, 'the growing press (fourth output)');
    const g = await readScene(page);
    expectEveryBeltHeld(g, b3, 'after the growing press (fourth output, one turn)');
    expect(boxOf(theFactory(g)).rot0, 'the growing press grew the box to 3 wide, 4 tall').toEqual([3, 4]);

    // ONE Ctrl+Z restores the 3-tall box from just before that press, and the anchor cell.
    await undoOnce(page, 3, 'the growing press');
    const ug = await readScene(page);
    expectEveryBeltHeld(ug, b3, 'after the Ctrl+Z of the growing press');
    expect(boxOf(theFactory(ug)).anchor, 'the Ctrl+Z puts the anchor back').toEqual(b3.box.anchor);
    expect(boxOf(theFactory(ug)), 'the Ctrl+Z restores the 3-tall box exactly').toEqual(b3.box);
    expect(ioNubs(theFactory(ug)), 'the Ctrl+Z leaves every In/Out nub as before the growing press').toEqual(b3.io);
    expect(faultCell(theFactory(ug)), 'the Ctrl+Z puts the Fault nub back').toEqual(b3.fault);

    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('through leg 1');
  });

  test('leg 2, two turns, three outputs: the fourth output grows the box, keeps every In and Out belt, moves the Fault one cell out, and one Ctrl+Z restores the box and the anchor', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await turnedFactory(page, LEG2_CELL, 2);

    // Two adds that fit, so the Factory has three outputs on its 3-tall box.
    for (const n of [2, 3]) {
      await pressAddOutput(page, n - 1, `the set-up add to ${n} outputs`);
    }
    const f = theFactory(await readScene(page));
    expect(boxOf(f).rot0, 'measured: three outputs fit the 3x3 catalog box').toEqual([3, 3]);

    // A belt into the In and a belt out of each of the three outputs. No belt on the Fault:
    // a growing add over a fault belt is refused (a separate pin, port_edits_keep_place.rs).
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await drawInBelt(page, f.ports.find((p) => p.role === ROLE_IN) as PortFacts, 4);
    for (const o of f.ports.filter((p) => p.role === ROLE_OUT)) {
      await drawOutBelt(page, o, 3);
    }
    const b3 = capture(await readScene(page));
    expect(b3.turn, 'measured: turned twice').toBe(2);
    expect(b3.docks, 'measured: the In and all three outputs are docked').toHaveLength(4);
    expect(b3.docks.filter((d) => d.startsWith('Tail:')), 'measured: three output belts').toHaveLength(3);

    // THE GROWING PRESS.
    await selectTheFactory(page);
    await pressAddOutput(page, 3, 'the growing press (fourth output, two turns)');
    const g = await readScene(page);
    expectEveryBeltHeld(g, b3, 'after the growing press (fourth output, two turns)');
    const fg = theFactory(g);
    expect(boxOf(fg).rot0, 'the growing press grew the box to 3 wide, 4 tall').toEqual([3, 4]);
    // The Fault sits on the rot-0 south row, which the growth pushes one cell further out
    // along the Fault's own facing.
    const faultSide = (fg.ports.find((p) => p.role === ROLE_FAULT) as PortFacts).side;
    const [fx, fy] = sideStep(faultSide);
    expect(faultCell(fg), 'the Fault nub is one cell further out').toEqual([b3.fault[0] + fx, b3.fault[1] + fy]);

    // ONE Ctrl+Z restores the box and the anchor cell.
    await undoOnce(page, 3, 'the growing press');
    const ug = await readScene(page);
    expectEveryBeltHeld(ug, b3, 'after the Ctrl+Z of the growing press (two turns)');
    expect(boxOf(theFactory(ug)).anchor, 'the Ctrl+Z puts the anchor back').toEqual(b3.box.anchor);
    expect(boxOf(theFactory(ug)), 'the Ctrl+Z restores the 3-tall box exactly').toEqual(b3.box);
    expect(ioNubs(theFactory(ug)), 'the Ctrl+Z leaves every In/Out nub as before').toEqual(b3.io);
    expect(faultCell(theFactory(ug)), 'the Ctrl+Z puts the Fault nub back').toEqual(b3.fault);

    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('through leg 2');
  });
});
