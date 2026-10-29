import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  DEMO_NODE_COUNT,
  DRAWN_STATE_FRAMES,
  alertRingCentres,
  alertRingInstructions,
  alertRingsPainted,
  armAndPlaceAt,
  armAndPlaceFactoryAt,
  cameraOf,
  cellCentre,
  clickAt,
  expectRenderLoopAlive,
  handDragBetween,
  handPath,
  loadDemoViaExamples,
  nubAnchor,
  pointerTravel,
  pollScene,
  readScene,
  resetZoomToActualSize,
  rotateHandle,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 22-stranded-reconnect.spec.ts (CONNECT-02, plan 67-05) - the LIVE real-host
// proof that a stranded dock is RECOVERABLE IN THE APP.
//
// CONNECT-02's literal wording is "a user can reconnect a stranded dock WITHOUT
// RELOADING THE SCENE". That clause is why this spec exists at all: the mock
// e2e (`frontend/e2e/stranded-reconnect.spec.ts`) already proves the emitted
// bytes, but only the real host can answer whether the command it emits is
// ACCEPTED, and a spec that reloaded and then saw a dock would prove nothing.
// The no-reload half is asserted explicitly at the end.
//
// This is the symptom reported on the real binary at v7.0 FEEL row
// 62-d, where the only recovery was reloading the scene.
//
// RENDER HEALTH IS ASSERTED, NOT ONLY THE MODEL. This project's recorded blind
// spot is that the live oracle reads only `window.__fabrico.scene()`, so a dead
// Pixi renderer passes every suite. This change touches the renderer (a new
// hover paint in `overlay.ts` and a new press-side ring retire), so a model-only
// assertion here would be exactly that failure shape: the spec attaches a
// page-error watch for the whole run and asserts the render loop is still
// advancing at the end.
//
// Drive rules (inherited from 05-undo-strand-ring, locked): `page.mouse` +
// `getByTitle` ONLY (real hit-testing), and every wait polls a SPECIFIC model
// change via `pollScene` with a message. Fixed sleeps are banned.
//
// RE-ARRANGED IN PLAN 89-02 (D-08, research Finding D), CLAIMS KEPT. A turn now docks every
// loose belt end a port of the turned machine faces (D-08). The old arrangement stranded
// the belt with a second counter-clockwise turn, which puts the Factory's Mechanical Fault on
// the nub the Out left: under D-08 that turn RE-AIMS the belt to the Fault and strands
// nothing, so there was no ring to drag. The arrangement now:
//   - strands with a CLOCKWISE turn (back to rot 0, where no Factory port faces the belt's
//     Tail cell), the turn spec 05 uses for the same reason;
//   - places a SOURCE beside the belt's Tail BEFORE the strand, its Out facing that Tail
//     from the side (perpendicular to the Tail's outward side, which the facing rule
//     accepts). A Place docks nothing, and the Source never turns, so after the strand its
//     Out is the reachable nub the ring is dragged onto;
//   - drags the ring with many pointer samples (D-16), out over another nub and back onto
//     the Source's Out, at camera scale 1 (leg 1) and again below 1 (leg 2), where the ring
//     press and the drop read zoom-scaled radii. The target nub is one cell from the ring,
//     so a straight hand drag between them is three or four samples; the leg walks
//     `handPath` itself through a waypoint (the D-16 custom loop) to give the release a real
//     multi-cell approach;
//   - and, in leg 3, turns the Factory back and sees D-08 reconnect the belt with no drag.
// The ring read before the press stays the paint latch (`alertRingsPainted`); plan 89-04 added
// the plot grade (D-10): right after every severing turn the ring is read off the ring Graphics
// (`alertRingInstructions`, `alertRingCentres`, a centre on the stranded end tile).

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
/** "At" a point: the plot is exact geometry, this only absorbs float noise. */
const AT_PX = 2;
/** The least pointer samples a ring drag makes (D-16, the plan's "at least 12"). */
const MIN_RING_SAMPLES = 12;

type NodeFacts = SceneFacts['nodes'][number];
type PortFacts = NodeFacts['ports'][number];
type Pt = { x: number; y: number };

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

/** Assert every screen point is on the CANVAS, so no chrome panel eats the press (74.1-02). */
async function expectOnCanvas(page: Page, pts: Pt[], context: string): Promise<void> {
  const tags = await page.evaluate((ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null), pts);
  expect(tags, `${context}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/** What `arrange` built: the factory, the docked belt, its Tail end tile and the side Source. */
interface Arranged {
  placedId: number;
  drawnId: number;
  endTile: { cell_x: number; cell_y: number };
  sourceId: number;
}

/**
 * The arrangement every leg shares: a fresh factory turned CCW so its Out faces North, a belt
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

/** Strand the belt: one CLOCKWISE turn of the factory (back to rot 0) spins its Out off the end. */
async function strand(page: Page, a: Arranged): Promise<void> {
  // DESELECT before the severing rotate, so the reconnect press below happens
  // with NOTHING selected. `hitHandle`'s only precondition is that a belt is
  // selected, so leaving the belt selected would let the SHIPPED endpoint-handle
  // path serve the press and this spec would pass with the whole feature
  // deleted. The deselect is what makes the assertion non-vacuous.
  await page.keyboard.press('Escape');
  await rotatePlaced(page, a.placedId, false);
  await pollScene(page, (s) => s.belts.find((b) => b.id === a.drawnId)?.docks.length ?? 0, {
    message: 'rotating the docked factory SEVERS the dock (the forward strand)',
  }).toBe(0);
  // D-10 (plan 89-04): the ring is graded on what is PLOTTED, read off the ring Graphics, with a
  // centre on the stranded end tile, not only on the paint latch the press read keeps below.
  const endPt = { x: cellCentre(a.endTile.cell_x), y: cellCentre(a.endTile.cell_y) };
  await expect
    .poll(async () => (await alertRingCentres(page)).some((c) => Math.hypot(c.x - endPt.x, c.y - endPt.y) <= AT_PX), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the ring plot read after the strand'),
      intervals: [100, 250, 500],
      message: 'the warning ring is plotted with a centre on the stranded end tile after the severing turn',
    })
    .toBe(true);
  expect(await alertRingInstructions(page), 'the warning ring is plotted after the severing turn').toBeGreaterThan(0);
  // Deselect the node the rotate helper selected, for the same reason as above.
  await page.keyboard.press('Escape');
}

/**
 * Press the ring at `ring`, walk the pointer by hand (`handPath`, at most a few screen px per
 * sample) out to `via` and back onto `target`, and release. Returns the sample count.
 */
async function dragRingVia(page: Page, ring: Pt, via: Pt, target: Pt): Promise<number> {
  const path = [...handPath(ring, via), ...handPath(via, target)];
  await page.mouse.move(ring.x, ring.y);
  await page.mouse.down();
  for (const p of path) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  return path.length;
}

/**
 * The reconnect itself, the claim this spec exists for: with the belt stranded and nothing
 * selected, press the ring on the orphaned end and drag it onto a reachable source port.
 * `points` are the screen points resolved before the strand (ring, waypoint nub, target nub).
 */
async function reconnectByRing(page: Page, a: Arranged, points: { ring: Pt; via: Pt; target: Pt }, leg: string): Promise<void> {
  // Everything from here to the release is kept tight on purpose: the alert
  // ring has a 5000ms TTL, and once it expires the ring is neither painted nor
  // pressable (the gesture layer gates its hit test on the paint being live).
  const s3 = await readScene(page);
  const strandedBelt = s3.belts.find((b) => b.id === a.drawnId)!;
  const strandedTiles = strandedBelt.tiles as Array<{ cell_x: number; cell_y: number }>;
  const endCell = [a.endTile.cell_x, a.endTile.cell_y] as const;
  expect(
    strandedTiles.some((t) => t.cell_x === endCell[0] && t.cell_y === endCell[1]),
    'the belt did not move: its stranded end tile is where it was before the rotate',
  ).toBe(true);
  // The target port is DISCOVERED from the post-rotate scene rather than hard-coded:
  // `(port cell + unit_delta(side)) == belt end cell` is the one cell a dock can occupy, so
  // this asks the live model which port the stranded end can legally reach after the turn.
  // Since plan 89-02 that is the side Source's Out (no Factory port faces the end at rot 0).
  const target = s3.nodes
    .flatMap((n) => n.ports.map((p) => ({ node: n.id, p })))
    .find(({ p }) => {
      const [fx, fy] = facingCell(p);
      return fx === endCell[0] && fy === endCell[1] && p.role !== ROLE.In;
    });
  expect(
    target,
    'after the severing rotate SOME source port faces the stranded belt end, ' +
      'so there is a reachable nub to reconnect to. Ports: ' +
      JSON.stringify(s3.nodes.find((n) => n.id === a.sourceId)?.ports),
  ).toBeDefined();
  expect(target!.node, `${leg}: the reachable source port is the side Source's Out`).toBe(a.sourceId);

  const tickAtStrand = s3.tick;
  const nodeCountAtStrand = s3.nodes.length;

  // THE RING IS ON SCREEN, ASSERTED RATHER THAN ASSUMED (67-REVIEW WR-05).
  //
  // Two failures this closes, and they are different failures. (a) The MODEL
  // ORACLE BLIND SPOT: every other assertion in this file reads the scene model,
  // and a build whose `showAlertRings` regressed while `setStrandedRings` still
  // fired would satisfy all of them over a canvas that painted nothing - this
  // project's recorded blind spot. (b) THE TTL RACE: the ring's pressability is
  // gated on the paint being live for 5000ms after the strand, and on a loaded CI
  // box the round-trips above can exceed that. Without this line the press falls
  // through to the belt-tile select arm, no Dock is emitted, and the final poll
  // fails with a message pointing at the FEATURE instead of at the timeout.
  expect(
    await alertRingsPainted(page),
    'the stranded-dock alert ring is actually PAINTED at the moment of the press - ' +
      'if this is false the ring either never rendered (a renderer regression the ' +
      'model oracle cannot see) or its 5000ms TTL expired during the arrange above',
  ).toBe(true);

  const samples = await dragRingVia(page, points.ring, points.via, points.target);
  expect(samples, `${leg}: the ring drag moved through many pointer samples (D-16)`).toBeGreaterThanOrEqual(MIN_RING_SAMPLES);

  // --- Assert: the dock is BACK, on the real host, with no reload. ---
  await pollScene(page, (s) => s.belts.find((b) => b.id === a.drawnId)?.docks.length ?? 0, {
    message:
      'CONNECT-02: dragging the stranded ring back onto a reachable port RE-DOCKS the belt ' +
      'on the real host (no reload, no undo, nothing selected before the press)',
  }).toBe(1);
  await pollScene(page, (s) => s.belts.find((b) => b.id === a.drawnId)?.docks[0]?.node ?? -1, {
    message: `${leg}: the one dock is on the side Source, the port the ring was dropped on`,
  }).toBe(a.sourceId);

  // THE "WITHOUT RELOADING THE SCENE" HALF, asserted rather than assumed.
  // No reload / load / new / demo-reset control was clicked after the arrange
  // (there is no such click in the act half above), and the model agrees: a
  // genesis swap collapses the tick BACKWARDS and re-mints every render handle
  // from zero. Those are exactly the two signals `loadDemoReset` above polls
  // on, used here in the negative.
  const after = await readScene(page);
  expect(
    after.tick,
    'the sim tick never went backwards, so no genesis swap (load / new / load-demo) happened',
  ).toBeGreaterThanOrEqual(tickAtStrand);
  expect(
    after.nodes.length,
    'the node set is intact - a reload would have replaced the board with the demo baseline',
  ).toBe(nodeCountAtStrand);
  expect(
    after.belts.some((b) => b.id === a.drawnId),
    'the SAME belt handle survived - a reload re-mints every handle from zero',
  ).toBe(true);
}

/**
 * The ring drag's three screen points, read NOW (67-REVIEW WR-05: every browser round-trip
 * left between the strand and `mouse.down()` is spent against the ring's 5000ms TTL). The
 * ring sits on the belt's END TILE, which the rotate never moves; the waypoint is the
 * Factory's Out nub once the strand turn puts it back at rot 0 (another nub the hand passes
 * over); the target is the side Source's Out nub.
 */
async function ringPoints(page: Page, a: Arranged): Promise<{ ring: Pt; via: Pt; target: Pt }> {
  const s = await readScene(page);
  const source = s.nodes.find((n) => n.id === a.sourceId)!;
  const sourceOut = source.ports.find((p) => p.role === ROLE.Out)!;
  // The Factory at rot 0 (after the clockwise strand): Out on the E edge of the middle row.
  const outAt0 = { cell_x: PLACE_CELL[0] + 2, cell_y: PLACE_CELL[1] + 1, side: 1 };
  const ring = await screenCellCentre(page, a.endTile.cell_x, a.endTile.cell_y);
  const via = await screenPoint(page, nubAnchor(outAt0.cell_x, outAt0.cell_y, outAt0.side));
  const target = await screenPoint(page, nubAnchor(sourceOut.cell_x, sourceOut.cell_y, sourceOut.side));
  await expectOnCanvas(page, [ring, via, target], 'the ring drag');
  return { ring, via, target };
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

  test('dragging the orphaned belt-end ring back onto a port re-docks the belt', async ({ page }) => {
    const a = await arrange(page);
    // Camera scale exactly 1, set AFTER the arrange (the demo load frames the board at its own
    // fit scale): the hit radii at their unscaled size.
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'leg 1 runs at camera scale 1').toBe(1);
    const points = await ringPoints(page, a);
    await strand(page, a);
    await reconnectByRing(page, a, points, 'scale 1');
  });

  test('below zoom 1, the ring drag still re-docks the belt', async ({ page }) => {
    const a = await arrange(page);
    // Wheel OUT over the target cell until the camera is below scale 1 (bounded), then
    // re-read every screen point: the ring press and the drop read zoom-scaled radii.
    const over = await screenCellCentre(page, SOURCE_CELL[0], SOURCE_CELL[1]);
    await pointerTravel(page, over.x, over.y);
    for (let notch = 0; notch < 10 && (await cameraOf(page)).scale >= 0.8; notch++) {
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(30);
    }
    await waitForCameraSettle(page);
    const scale = (await cameraOf(page)).scale;
    expect(scale, 'leg 2 runs below camera scale 1').toBeLessThan(1);
    const points = await ringPoints(page, a);
    await strand(page, a);
    await reconnectByRing(page, a, points, `scale ${scale}`);
  });

  test('turning the factory back toward the stranded end reconnects it with no drag (D-08)', async ({ page }) => {
    const a = await arrange(page);
    await strand(page, a);
    // NON-VACUITY for the "ring gone" read below (review WR-C-01): the ring is PLOTTED (read off
    // the ring Graphics, not the paint latch) the moment before the turn back. A turn that joins
    // nothing leaves a ring where it is (TODO-FANIN), so its going is the turn back's dock.
    expect(
      await alertRingInstructions(page),
      'the stranded-dock warning ring is plotted after the strand, right before the turn back',
    ).toBeGreaterThan(0);
    // The turn back: counter-clockwise, rot 0 -> rot 3, where the Out faces the Tail again.
    await rotatePlaced(page, a.placedId, true);
    // On the Out by PORT, not just on the Factory's Tail (review WR-C-04): a Factory turn can put
    // its Mechanical Fault where the Out was (D-08's re-aim), and a dock on the Fault carries
    // faults, not product. A Tail dock names its port by the Out's ordinal among the machine's Outs
    // (`dockPort` in ports.ts; a Fault dock is FAULT_PORT 65535), read off the Factory's ports.
    await pollScene(page, (s) => {
      const docks = s.belts.find((b) => b.id === a.drawnId)?.docks ?? [];
      const outs = s.nodes.find((n) => n.id === a.placedId)?.ports.filter((p) => p.role === ROLE.Out) ?? [];
      const outOrdinal = outs.length === 1 ? 0 : -2;
      return docks.length === 1 && docks[0].node === a.placedId && docks[0].end === 'Tail' && docks[0].port === outOrdinal;
    }, {
      message: "D-08: turning the factory back docks the belt's loose Tail to its Out (the Out's port, not the Fault), with no drag",
    }).toBe(true);
    await page.keyboard.press('Escape');
    // Read off the ring Graphics (what is plotted), polled to the drawn-state frame budget.
    await expect
      .poll(() => alertRingInstructions(page), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the ring cleared after the turn back'),
        intervals: [100, 250, 500],
        message: 'the stranded-dock ring is gone once the turn back reconnected the belt',
      })
      .toBe(0);
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
