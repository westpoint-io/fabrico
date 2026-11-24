import { test, expect, type Page } from './support/liveTest';
import {
  DEMO_NODE_COUNT,
  alertRingInstructions,
  armAndPlaceAt,
  armAndPlaceFactoryAt,
  clickAt,
  expectRenderLoopAlive,
  handDragBetween,
  loadDemoViaExamples,
  pollScene,
  readScene,
  rotateHandle,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 22-stranded-reconnect.spec.ts (CONNECT-02, plan 67-05) - the LIVE real-host
// check of the Factory turn that re-aims a belt instead of stranding it.
//
// The ring drag that reconnects a stranded belt is walked by
// `92-red-means-faulted.live.spec.ts`, and the turn back that reconnects it with no drag by
// `89-turn-back-reconnects.live.spec.ts`. The one leg left here is the re-aim (D-08): a
// second counter-clockwise turn puts the Factory's Mechanical Fault on the nub its Out left,
// so the turn docks the belt's Tail to the Fault in the same step and strands nothing.
// Ctrl+Z and Ctrl+Shift+Z (the redo is a full keyframe) must keep that true, with no warning
// ring drawn at any read.
//
// RENDER HEALTH IS ASSERTED, NOT ONLY THE MODEL. This project's recorded blind
// spot is that the live oracle reads only `window.__fabrico.scene()`, so a dead
// Pixi renderer passes every suite. The spec attaches a page-error watch for the whole
// run and asserts the render loop is still advancing at the end.
//
// Drive rules (inherited from 05-undo-strand-ring, locked): `page.mouse` +
// `getByTitle` ONLY (real hit-testing), and every wait polls a SPECIFIC model
// change via `pollScene` with a message. Fixed sleeps are banned.
//
// THE ARRANGEMENT (plan 89-02, D-08): a fresh Factory turned counter-clockwise so its Out faces
// North, a belt drawn north off the Out's doorstep by hand and docked to the Out, and a Source
// placed beside the belt's Tail with its Out facing that Tail. A Place docks nothing, so the
// belt keeps its one dock to the Factory until the leg turns it.

test.describe.configure({ mode: 'serial' });

/** FACTORY wire kind (mirrored from kinds.ts / 01-default-scene). */
const KIND_FACTORY = 2;
/** SOURCE wire kind (kinds.ts). */
const KIND_SOURCE = 0;
/** Port role keyspace (In=0, Out=1, Fault=2). */
const ROLE = { In: 0, Out: 1, Fault: 2 } as const;
/** The factory footprint width in cells (drives the rotate-handle anchor). */
const FACTORY_W = 3;
/** The verified-empty drop cell (demo occupies rows 2..8; 3x3 at row 11 is clear). */
const PLACE_CELL = [6, 11] as const;
/**
 * The side Source's cell: one West of the belt's Tail tile (7,10), above the Factory. Its Out
 * faces East onto (7,10) at rot 0.
 */
const SOURCE_CELL = [6, 10] as const;
/** Side unit vectors in the core keyspace order N=0, E=1, S=2, W=3. */
const UNIT: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

type NodeFacts = SceneFacts['nodes'][number];
type PortFacts = NodeFacts['ports'][number];

/** Reset to the demo baseline via the SHIPPED Load-demo CTA (genesis swap). */
async function loadDemoReset(page: Page): Promise<void> {
  const tickBefore = (await readScene(page)).tick;
  await loadDemoViaExamples(page);
  await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
    message: 'the LoadDemo genesis swap folded onto the demo baseline',
  }).toBe(true);
}

/** Place a fresh UNDOCKED factory via arm-then-click (30-05); returns its handle. */
async function placeFactory(page: Page): Promise<number> {
  const beforeIds = new Set(
    (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id),
  );
  await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
  await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
    message: 'the real host echoes the placed FACTORY (kind-2 node count grows by one)',
  }).toBe(beforeIds.size + 1);
  const placed = (await readScene(page)).nodes.find(
    (n) => n.kind === KIND_FACTORY && !beforeIds.has(n.id),
  );
  expect(placed, 'the placed factory is found by diffing pre/post kind-2 ids').toBeDefined();
  return (placed as NodeFacts).id;
}

/**
 * Rotate the placed factory via the on-canvas handle, CCW (Shift-click) by default or CW (a
 * plain click); waits for the ports[] re-stamp.
 */
async function rotatePlaced(page: Page, placedId: number, ccw = true): Promise<void> {
  const before = (await readScene(page)).nodes.find((n) => n.id === placedId);
  expect(before, 'the placed factory is present before the rotate').toBeDefined();
  const beforePorts = JSON.stringify((before as NodeFacts).ports);
  const minX = Math.min(...(before as NodeFacts).cells.map((c) => c[0]));
  const minY = Math.min(...(before as NodeFacts).cells.map((c) => c[1]));
  const anchor = await screenCellCentre(page, minX, minY);
  await clickAt(page, anchor.x, anchor.y); // select -> shows rotate handle
  const handlePt = await screenPoint(page, rotateHandle(minX, minY, FACTORY_W));
  if (ccw) await page.keyboard.down('Shift');
  await clickAt(page, handlePt.x, handlePt.y); // Shift = CCW (keeps the Out belt in-viewport)
  if (ccw) await page.keyboard.up('Shift');
  await pollScene(page, (s) => JSON.stringify(s.nodes.find((n) => n.id === placedId)?.ports), {
    message: 'the Rotate echo re-stamps the placed factory ports[] (the edit landed)',
  }).not.toBe(beforePorts);
}

/** The cell a port FACES: `port cell + unit_delta(side)`, the one cell a dock can occupy. */
const facingCell = (p: PortFacts): [number, number] => {
  const [dx, dy] = UNIT[p.side & 3];
  return [p.cell_x + dx, p.cell_y + dy];
};

/** What `arrange` built: the factory, the docked belt, its Tail end tile and the side Source. */
interface Arranged {
  placedId: number;
  drawnId: number;
  endTile: { cell_x: number; cell_y: number };
  sourceId: number;
}

/**
 * The arrangement the leg uses: a fresh factory turned CCW so its Out faces North, a belt
 * drawn north off the Out's doorstep by hand and docked to the Out, and a Source placed West
 * of the belt's Tail tile with its Out facing that tile. Nothing is stranded yet.
 */
async function arrange(page: Page): Promise<Arranged> {
  await loadDemoReset(page);
  const baseCount = (await readScene(page)).nodes.length;
  const placedId = await placeFactory(page);
  await pollScene(page, (s) => s.nodes.length, {
    message: 'the placed factory brings the node count up by one',
  }).toBe(baseCount + 1);

  // Rotate CCW so the Out port faces North (a belt drawn upward stays in-viewport).
  await rotatePlaced(page, placedId);

  const s1 = await readScene(page);
  const placed = s1.nodes.find((n) => n.id === placedId)!;
  const out = placed.ports.find((p) => p.role === ROLE.Out)!;
  expect(out, 'the rotated factory exposes an Out port to draw against').toBeDefined();
  const [dx, dy] = UNIT[out.side & 3];
  const front = [out.cell_x + dx, out.cell_y + dy] as const;
  const beforeBeltIds = new Set(s1.belts.map((b) => b.id));

  // Prefix-matched, not exact: this Belt tool title is user-facing COPY that
  // doubles as a SELECTOR, so an exact match makes every copy edit a
  // five-spec breakage (52-05). `Draw belts` stays unique in the palette.
  // Drawn by HAND (D-16): pressed on the Out's doorstep and dragged three cells north with
  // several pointer samples per cell.
  await page.getByTitle(/^Draw belts/).click();
  const beltStart = await screenCellCentre(page, front[0], front[1]);
  const beltEnd = await screenCellCentre(page, front[0] + dx * 3, front[1] + dy * 3);
  await handDragBetween(page, beltStart, beltEnd);
  await pollScene(page, (s) => s.belts.length, {
    message: 'the real host echoes the drawn belt (belt count grows by one)',
  }).toBe(beforeBeltIds.size + 1);
  await page.keyboard.press('Escape'); // disarm the belt tool before selecting to dock
  const drawnId = (await readScene(page)).belts.find((b) => !beforeBeltIds.has(b.id))!.id;

  // The press on the Out's doorstep docks the Tail as it is drawn (since phase 74.1). Graded here
  // directly: until review IN-C-05 a handle drag stood behind an `if (no dock)` that never ran.
  const s2 = await readScene(page);
  const drawn = s2.belts.find((b) => b.id === drawnId)!;
  const tiles = drawn.tiles as Array<{ cell_x: number; cell_y: number }>;
  const firstTile = tiles[0];
  const lastTile = tiles[tiles.length - 1];
  const endTile =
    firstTile.cell_x === front[0] && firstTile.cell_y === front[1] ? firstTile : lastTile;
  await pollScene(page, (s) => s.belts.find((b) => b.id === drawnId)?.docks.length ?? 0, {
    message: "the draw pressed on the Out's doorstep docked the drawn belt's Tail to the factory",
  }).toBe(1);
  await page.keyboard.press('Escape');

  // The side Source, West of the Tail tile. A Place docks nothing (D-08 rides the Rotate
  // arm only), so the belt keeps its one dock to the Factory.
  expect([endTile.cell_x, endTile.cell_y], 'PRECONDITION: the Tail tile is the one the Source will face').toEqual([
    SOURCE_CELL[0] + 1,
    SOURCE_CELL[1],
  ]);
  const beforeSources = new Set((await readScene(page)).nodes.filter((n) => n.kind === KIND_SOURCE).map((n) => n.id));
  await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
  await pollScene(page, (s) => s.nodes.some((n) => n.kind === KIND_SOURCE && !beforeSources.has(n.id)), {
    message: 'the real host echoes the side Source',
  }).toBe(true);
  const source = (await readScene(page)).nodes.find((n) => n.kind === KIND_SOURCE && !beforeSources.has(n.id))!;
  const sourceOut = source.ports.find((p) => p.role === ROLE.Out)!;
  expect(facingCell(sourceOut), "PRECONDITION: the Source's Out faces the belt's Tail tile").toEqual([
    endTile.cell_x,
    endTile.cell_y,
  ]);
  await pollScene(page, (s) => s.belts.find((b) => b.id === drawnId)?.docks.length ?? 0, {
    message: 'placing the Source docked nothing: the belt still holds exactly its one dock',
  }).toBe(1);
  return { placedId, drawnId, endTile, sourceId: source.id };
}

/** The Fault keyspace a Fault dock names (`FAULT_PORT` in ports.ts, `74.1-port-edit-rings`). */
const FAULT_PORT = 65535;

/**
 * The arranged belt's docks as `<end>:<factory|source|node>:<port>`, the belt found by its end tile
 * and the Factory by its cells and kind, so the read survives an Undo or Redo keyframe (which
 * re-mints every handle).
 */
function arrangedDocks(s: SceneFacts, a: Arranged): string {
  const belt = s.belts.find((b) => b.tiles.some((t) => t.cell_x === a.endTile.cell_x && t.cell_y === a.endTile.cell_y));
  if (belt === undefined) return 'no belt';
  const factory = s.nodes.find((n) => n.kind === KIND_FACTORY && n.cells.some((c) => c[0] === PLACE_CELL[0] && c[1] === PLACE_CELL[1]));
  const source = s.nodes.find((n) => n.kind === KIND_SOURCE && n.cells.some((c) => c[0] === SOURCE_CELL[0] && c[1] === SOURCE_CELL[1]));
  return belt.docks
    .map((d) => `${d.end}:${d.node === factory?.id ? 'factory' : d.node === source?.id ? 'source' : d.node}:${d.port}`)
    .sort()
    .join(',');
}

/**
 * Read the plotted ring on every poll while the host runs 60 ticks (about a second of packets, no
 * fixed sleep); every reading must be 0.
 */
async function expectNoRingThroughout(page: Page, why: string): Promise<void> {
  const seen: number[] = [];
  const t0 = (await readScene(page)).tick;
  await expect
    .poll(
      async () => {
        seen.push(await alertRingInstructions(page));
        return (await readScene(page)).tick >= t0 + 60;
      },
      { message: `${why}: the host ran 60 ticks while the ring was read`, intervals: [100] },
    )
    .toBe(true);
  expect(seen.length, `${why}: NON-VACUITY: the ring was read on several polls`).toBeGreaterThanOrEqual(3);
  expect(seen, `${why}: no warning ring is plotted at any read while the host ran 60 ticks`).toEqual(seen.map(() => 0));
}

test.describe('CONNECT-02: a stranded dock reconnects on the real host, no reload', () => {
  // RENDER HEALTH in every test: the watcher goes in BEFORE `page.goto`, and the loop and the
  // watcher are read after every test (fabrico-model-oracle-blindspot).
  let errors: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'after the stranded-ring reconnect');
    errors.assertNone('during the stranded-ring reconnect');
  });
  test('a second counter-clockwise turn re-aims the belt to the Factory Fault and rings nothing, through undo and redo (D-08)', async ({
    page,
  }) => {
    // Review IN-C-06. Legs 1 to 3 strand with a CLOCKWISE turn because the counter-clockwise one
    // re-aims instead (D-08): the Factory's Mechanical Fault lands on the nub its Out left, facing
    // the belt's Tail, so the turn docks the Tail to the Fault in the same step. No live leg walked
    // that re-aim or its undo and redo; this one does. A re-aim cuts nothing the user lost, so no
    // ring is plotted, at the turn, after Ctrl+Z (back on the Out) and after Ctrl+Shift+Z (the
    // turn again as a full keyframe, the Fault port `Tail:65535` on the keyframe path).
    const a = await arrange(page);
    expect(arrangedDocks(await readScene(page), a), 'PRECONDITION: the belt Tail is on the Factory Out (ordinal 0)').toBe('Tail:factory:0');
    await page.keyboard.press('Escape');
    await rotatePlaced(page, a.placedId, true);
    await pollScene(page, (s) => arrangedDocks(s, a), {
      message: "D-08: the second counter-clockwise turn re-aims the belt's Tail to the Factory's Fault in the same step",
    }).toBe(`Tail:factory:${FAULT_PORT}`);
    await expectNoRingThroughout(page, 'after the re-aiming turn');
    await expectRenderLoopAlive(page, 'after the re-aiming turn');

    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => arrangedDocks(s, a), { message: 'Ctrl+Z puts the belt back on the Factory Out' }).toBe('Tail:factory:0');
    await expectNoRingThroughout(page, 'after the undo of the re-aim');

    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => arrangedDocks(s, a), {
      message: 'Ctrl+Shift+Z re-aims it to the Fault again, on the keyframe path',
    }).toBe(`Tail:factory:${FAULT_PORT}`);
    await expectNoRingThroughout(page, 'after the redo of the re-aim');
  });
});
