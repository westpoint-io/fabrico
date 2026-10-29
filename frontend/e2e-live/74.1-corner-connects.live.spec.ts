import { test, expect, type Page } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
// The PNG decoder @playwright/test already bundles (pngjs), the idiom
// `06-fault-red-probe.spec.ts` uses: no new dependency is added to read the canvas.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  cameraOf,
  CAPTURE_FRAMES,
  CAPTURE_POLL_TRIES,
  captureClip,
  captureCostLine,
  DRAWN_STATE_FRAMES,
  captureRefusalText,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  newBoard,
  nodeAtAnchor,
  pointerTravel,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  tileKindAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
  type TileKindFacts,
} from './support/oracle';
// The pure, product-free shared module: every expected colour comes from the skin
// schema's oracle (never a literal hex) and every coordinate from the scene oracle.
import { colorOracles, colorToRgb } from '../shared/geometry';

/** The host's FootprintCollision sentence (plan 89-08, UI-SPEC A5), which a red belt release now draws (D-13). */
const COLLISION_COPY = 'That space is taken. Clear it or try elsewhere.';

// 74.1-corner-connects.live.spec.ts (CORNER-01, CORNER-02, CORNER-04, CORNER-05, D-04, D-05,
// D-14) - belts drawn out of a port or a belt end that TURN AT ONCE, on the REAL
// `dev_render_server`, driven the way a hand drives it.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS FOR
// ---------------------------------------------------------------------------
//
// On the shipped binary, corner connecting did not work. Phase 74.1
// moves the Belt tool's press target onto the DOORSTEP TILE: the floor cell a machine Out or
// Fault port feeds, or the cell one past a free belt Head. The press is resolved BY CELL
// (`gestures.ts` doorstepPressHit over `cam.screenToCell`), the seed is that same cell
// (`ports.ts` doorstepCell), and the host accepts a carrier that turns at a doorstep
// (`command.rs` refuses on facing only when the outward side equals the target side). So
// where the hand presses is where the belt starts, and a drag that turns immediately is
// followed from the first sample and docks at its start.
//
// ---------------------------------------------------------------------------
// THE SIX LEGS, AND WHAT EACH ONE PROVES (this file declares exactly 6 tests)
// ---------------------------------------------------------------------------
//
//   1. A CORNER OUT OF A MACHINE PORT (the tracer, plan 74.1-01): a press on a ROUTER
//      Out's doorstep that turns north at once docks its Tail to that Out, AND the new
//      belt's seam tile ships Corner{from:E, to:N}. The one leg WATCHED RED at BASE_REV
//      (its Tail-dock assertion). Since plan 85-07 (D-19) the Router is one the leg places
//      from the palette, so the seam tile is (22,9); it was the demo Router's free Out at
//      (16,0) until then, and (16,1) until 74.1-14.
//   2. A CORNER OUT OF A BELT END: a press on the floor past a belt's Head that turns north
//      at once joins the two runs, read 1/1 from both sides by cell, AND the new belt's
//      seam tile ships Corner{from:E, to:N} with the old belt still straight (D-04,
//      CORNER-01).
//   3. DOUBLING BACK: a press past the Head dragged back over the belt is red and commits
//      nothing, paired in the same test with the forward gesture from the same press,
//      which joins. The pair is what makes "nothing committed" mean "the back-drag
//      committed nothing" and not "the press missed" (D-03 as amended, CORNER-05). The
//      forward join is collinear, so its seam kind is graded as the straight it draws.
//      Since phase 89 (plan 89-09, D-13, FAIL-02) the red back-drag is SENT and the host
//      refuses it in words, "That space is taken. Clear it or try elsewhere."; it still
//      commits nothing. Until plan 89-10 this leg asserted the refusal region stayed
//      silent for the back-drag, the old silence D-13 removed (found by the phase 89 full
//      live pass); now the back-drag's sentence is graded and the forward discriminator
//      alone must stay silent.
//   4. AT MIN_ZOOM: the same belt-end corner at camera scale 0.25, scale READ, not assumed,
//      seam kind graded as in leg 2. The doorstep target is 8 x 8 screen px there, under
//      the 12 px floor nubs keep; the leg proves that exception is the target's SIZE, not a
//      failure to connect (CORNER-04; plan 74.1-05's matrix reports the size by scale).
//   5. A BELT THAT ENDS SIDEWAYS IN FRONT OF AN INPUT connects with a Head dock naming the
//      Sink (D-14), a consequence of the host narrowing (UI-SPEC 3.2 item 6), AND its last
//      tile ships the corner from its arrival travel into the In, computed from the Sink's
//      port facts.
//   6. THE RINGS ARE PAINTED ON THE DOORSTEP: build-blue ring ink read off a decoded
//      screenshot clip at each doorstep with the Belt tool armed, none with it disarmed,
//      four-fold balanced (so centred on the doorstep, not on the end tile or the nub), and
//      nothing added at the belt's own end tile (D-04, D-05, CORNER-02). Every ring case in
//      vitest reads the `dockTargetCalls` recorder, which proves what `gestures.ts` ASKS the
//      overlay to draw; this leg reads what reaches the canvas, through no product accessor.
//
// ---------------------------------------------------------------------------
// WHY A NEW FILE (D-09)
// ---------------------------------------------------------------------------
//
// `74-belt-join-press-on-end.live.spec.ts` (exactly 2 tests) and
// `74-belt-draw-gesture.live.spec.ts` (exactly 3 tests) are count-gated by their phase-74
// plans, and two earlier design rounds died landing legs in them. New legs live here.
//
// ---------------------------------------------------------------------------
// EVERY BELT-DRAWING LEG DRIVES SUB-CELL POINTER SAMPLES
// ---------------------------------------------------------------------------
//
// A fixture that teleports one clean cell per pointer event cannot fail on this defect: the
// broken press landed one cell BEHIND the seed, and only a sample emitted while the pointer
// is still inside the pressed tile walks into that gap. `page.mouse.move(..., { steps: N })`
// emits N samples per move, so the first several are inside the tile the press landed in,
// exactly as a real mouse does. That holds for the board-building draws too.
//
// MODEL FIRST, THEN RENDER HEALTH. The live oracle reads the model, which keeps advancing
// with a dead renderer, so every leg ends with `expectRenderLoopAlive` and
// `watchPageErrors(...).assertNone`.
//
// A JOIN IS GRADED ON THE SEAM TILE KIND, NOT ONLY ON THE LINK (plan 74.1-09, gap 3 of
// 74.1-VERIFICATION.md). Every leg here once read cells and dock counts, and all six passed
// while the screen showed a T at S1, S2 and S4: a straight tile beside a collar. Each leg that claims
// a join now also reads the tile kind the host ships at the seam (`tileKindAt`). The pixels
// themselves are read by `74.1-seam-corner.live.spec.ts`.

/** The anchor of the Router leg 1 places from the palette (plan 85-07, D-19), on floor
 *  clear of the demo board. Until 85-07 the leg pressed the DEMO Router's free Out (catalog
 *  port 3 at (15,0), anchor (14,0)); phase 85's demo docks every Router output, and a test
 *  must not keep one free for itself. The leg's Out is that Router's topmost free Mechanical
 *  Out, found from its ports: (21,9) facing E, the place port 3 held on the demo Router. */
const ROUTER_ANCHOR = [20, 9] as const;
/** That port's doorstep: (21,9) stepped once east. The press lands at its centre. */
const DOORSTEP = [22, 9] as const;
/** One cell NORTH of the doorstep: the belt turns at once, perpendicular to the port. */
const TURN_CELL = [22, 8] as const;

/** The belt legs 2 to 4 and 6 draw first, on an empty board: four cells east, Head (7,6). */
const FIRST_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** That belt's Head tile. The junction is read here; it is NOT pressed. */
const HEAD_CELL = [7, 6] as const;
/** The Head's doorstep: the empty floor tile it faces, where the ring sits and the press lands. */
const BELT_DOORSTEP = [8, 6] as const;
/** The corner legs 2 and 4 draw: off the doorstep, north at once, three cells. */
const CORNER_CELLS: readonly (readonly [number, number])[] = [
  [8, 6],
  [8, 5],
  [8, 4],
  [8, 3],
];

/** Pointer samples per one-cell move at scale 1: an eighth of a cell each (4 screen px). */
const STEPS_PER_CELL = 8;

/**
 * The wire encodings the kinds below are written in: Axis X=0, Y=1; Dir N=0, E=1, S=2,
 * W=3. A belt flowing east that is joined by a run turning north draws Corner{E, N} at
 * the new run's first tile.
 */
const SEAM_E_TO_N: TileKindFacts = { Corner: { from: 1, to: 0 } };
const STRAIGHT_NS: TileKindFacts = { Straight: { axis: 1 } };
const STRAIGHT_EW: TileKindFacts = { Straight: { axis: 0 } };

/**
 * The ring the overlay draws, carried as literals because the live specs read the app
 * through the page, never through its modules: `NUB_RING_R` 7 and `NUB_RING_STROKE` 2
 * (`frontend/src/protocol/ports.ts:253-255`).
 */
const NUB_RING_R = 7;
const NUB_RING_STROKE = 2;
/** The probe clip's side, CSS px: the ring's outer diameter plus 2 px of margin per side. */
const RING_CLIP_SIDE = 2 * (NUB_RING_R + NUB_RING_STROKE) + 4;
/** A ring-ink pixel is within this many levels of build-blue on every RGB channel. */
const RING_INK_TOLERANCE = 48;
/** Every quadrant of a ring centred on the clip holds at least this share of its ink. */
const RING_QUADRANT_MIN_SHARE = 0.15;
/**
 * THE FLOOR: half the smaller armed doorstep total MEASURED at this tree (74.1-04), on the
 * live suite's Desktop Chrome at scale 1. Measured counts, armed: belt doorstep 89 pixels
 * (quadrants 22, 22, 22, 23), Source doorstep 89 (22, 22, 22, 23); floor(89 / 2) = 44. A 2 px
 * stroke at radius 7 covers about 88 CSS px of ring, which is what was measured, so a floor
 * near zero would be a defect in the probe, not a looser test.
 */
const RING_INK_FLOOR = 44;

const hasCell = (cells: readonly (readonly [number, number])[], cx: number, cy: number) =>
  cells.some(([x, y]) => x === cx && y === cy);

/** Every belt that occupies (cx, cy). */
function beltsAt(scene: SceneFacts, cx: number, cy: number) {
  return scene.belts.filter((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy));
}

/** The side (N=0, E=1, S=2, W=3) a unit cell step points along, or null. */
function stepSide(a: readonly [number, number], b: readonly [number, number]): number | null {
  const d = [b[0] - a[0], b[1] - a[1]];
  for (let side = 0; side < 4; side++) {
    const [sx, sy] = outwardStep(side);
    if (d[0] === sx && d[1] === sy) return side;
  }
  return null;
}

/** The outward unit step off a port side (N, E, S, W), mirrored as the oracle mirrors it. */
function outwardStep(side: number): [number, number] {
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

/**
 * The junction between the first belt and the run drawn off its doorstep, read from BOTH
 * SIDES and resolved BY CELL (handles can be reminted by a keyframe). `'1/1'` is joined,
 * `'0/0'` is two runs that only abut, `'MISSING'` is fewer than two belts there.
 */
function junction(scene: SceneFacts): string {
  const up = beltsAt(scene, HEAD_CELL[0], HEAD_CELL[1])[0];
  const down = beltsAt(scene, BELT_DOORSTEP[0], BELT_DOORSTEP[1])[0];
  if (!up || !down || up.id === down.id) return 'MISSING';
  const a = (up.docks ?? []).filter((d) => d.end === 'Head' && d.node === down.id).length;
  const b = (down.docks ?? []).filter((d) => d.end === 'Tail' && d.node === up.id).length;
  return `${a}/${b}`;
}

/** Assert every screen point is on the CANVAS, so no chrome panel eats the press (74.1-02). */
async function expectOnCanvas(page: Page, pts: { x: number; y: number }[], context: string): Promise<void> {
  const tags = await page.evaluate(
    (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null),
    pts,
  );
  expect(tags, `${context}: every point is on the canvas, not under chrome`).toEqual(pts.map(() => 'CANVAS'));
}

/**
 * Drive the pointer through `cells` (the first already pressed), cell centre to cell centre,
 * each move emitting `steps` samples, so the first samples land inside the pressed tile.
 */
async function moveThroughCells(
  page: Page,
  cells: readonly (readonly [number, number])[],
  steps: number,
): Promise<void> {
  for (const [cx, cy] of cells) {
    const pt = await screenCellCentre(page, cx, cy);
    await pointerTravel(page, pt.x, pt.y, steps);
  }
}

/**
 * An empty board at camera scale 1 (READ and asserted) holding one belt `FIRST_CELLS`,
 * drawn with sub-cell samples, with the Belt tool left ARMED.
 */
async function boardWithOneBelt(page: Page): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  await page.getByTitle(/^Draw belts/).click();
  const start = await screenCellCentre(page, FIRST_CELLS[0][0], FIRST_CELLS[0][1]);
  const end = await screenCellCentre(page, HEAD_CELL[0], HEAD_CELL[1]);
  await expectOnCanvas(page, [start, end], 'the first belt');
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  await moveThroughCells(page, FIRST_CELLS.slice(1), STEPS_PER_CELL);
  await page.mouse.up();
  await pollScene(page, (s) => s.belts.length, {
    message: 'the real host folded the first DrawBelt (one belt on an otherwise empty board)',
  }).toBe(1);
  const only = await readScene(page);
  expect(
    only.belts[0].tiles.map((t) => [t.cell_x, t.cell_y]),
    'the first belt is exactly FIRST_CELLS',
  ).toEqual(FIRST_CELLS.map(([x, y]) => [x, y]));
  expect(only.belts[0].docks ?? [], 'the lone belt starts undocked').toHaveLength(0);
}

/** Press the Head's doorstep and draw the corner north, `steps` samples per cell. */
async function drawCornerOffTheBeltEnd(page: Page, steps: number): Promise<void> {
  const door = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
  await pointerTravel(page, door.x, door.y);
  await page.mouse.down();
  await moveThroughCells(page, CORNER_CELLS.slice(1), steps);
  await page.mouse.up();
}

/** Assert the corner landed as two belts joined 1/1, the new one exactly CORNER_CELLS. */
async function expectCornerJoined(page: Page, context: string): Promise<void> {
  await pollScene(page, (s) => s.belts.length, { message: `${context}: a second belt was minted` }).toBe(2);
  const after = await readScene(page);
  const drawn = beltsAt(after, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
  expect(drawn, `${context}: exactly one belt starts on the doorstep`).toHaveLength(1);
  expect(
    drawn[0].tiles.map((t) => [t.cell_x, t.cell_y]),
    `${context}: the new belt starts ON the pressed doorstep and turns north at once`,
  ).toEqual(CORNER_CELLS.map(([x, y]) => [x, y]));
  await pollScene(page, junction, {
    message:
      `${context}: the old belt's Head dock names the new belt AND the new belt's Tail dock ` +
      'names the old one, read from both sides by cell',
  }).toBe('1/1');
  // THE JOIN THE USER SEES (plan 74.1-09): the link above passed while the screen showed a T. The
  // seam tile must ship as the 90 degree corner from the old belt's flow (E) into the new
  // one's (N), polled because the Dock echo lands one packet after the DrawBelt echo.
  await pollScene(page, (s) => tileKindAt(s, BELT_DOORSTEP[0], BELT_DOORSTEP[1]), {
    message: `${context}: the seam tile (8,6) ships Corner{from:E, to:N}, not the Straight route() stored`,
  }).toEqual(SEAM_E_TO_N);
  const settled = await readScene(page);
  const corner = beltsAt(settled, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
  expect(corner, `${context}: the new belt is readable by cell`).toHaveLength(1);
  expect(
    corner[0].tiles.map((t) => t.kind),
    `${context}: the new belt is the seam corner then north-south straights`,
  ).toEqual([SEAM_E_TO_N, STRAIGHT_NS, STRAIGHT_NS, STRAIGHT_NS]);
  const old = beltsAt(settled, HEAD_CELL[0], HEAD_CELL[1]);
  expect(old, `${context}: the old belt is readable by cell`).toHaveLength(1);
  expect(
    old[0].tiles.map((t) => t.kind),
    `${context}: the old belt stays east-west straight (only the carrier bends)`,
  ).toEqual(FIRST_CELLS.map(() => STRAIGHT_EW));
}

/** Ring ink at one cell: the build-blue pixel count per quadrant of a clip centred there. */
interface RingInk {
  total: number;
  /** Top-left, top-right, bottom-left, bottom-right. */
  quads: [number, number, number, number];
}

/**
 * Screenshot a square clip centred on cell (cx, cy)'s screen centre, decode it, and count the
 * pixels within RING_INK_TOLERANCE of build-blue on every channel, per quadrant of the
 * DECODED image (so the device pixel ratio is the image's, not assumed).
 */
async function ringInk(page: Page, cx: number, cy: number): Promise<RingInk> {
  const c = await screenCellCentre(page, cx, cy);
  const x0 = Math.round(c.x - RING_CLIP_SIDE / 2);
  const y0 = Math.round(c.y - RING_CLIP_SIDE / 2);
  const vp = page.viewportSize();
  expect(vp, 'the live page reports a viewport size').not.toBeNull();
  expect(
    x0 >= 0 && y0 >= 0 && x0 + RING_CLIP_SIDE <= vp!.width && y0 + RING_CLIP_SIDE <= vp!.height,
    `the ring clip at (${cx},${cy}) lies inside the viewport`,
  ).toBe(true);
  const last = RING_CLIP_SIDE - 1;
  await expectOnCanvas(
    page,
    [
      { x: x0, y: y0 },
      { x: x0 + last, y: y0 },
      { x: x0, y: y0 + last },
      { x: x0 + last, y: y0 + last },
    ],
    `the ring clip at (${cx},${cy})`,
  );
  const png = PNG.sync.read(await captureClip(page, { x: x0, y: y0, width: RING_CLIP_SIDE, height: RING_CLIP_SIDE }));
  const want = colorToRgb(colorOracles.build);
  const quads: [number, number, number, number] = [0, 0, 0, 0];
  for (let py = 0; py < png.height; py++) {
    for (let px = 0; px < png.width; px++) {
      const i = (py * png.width + px) << 2;
      if (
        Math.abs(png.data[i] - want.r) <= RING_INK_TOLERANCE &&
        Math.abs(png.data[i + 1] - want.g) <= RING_INK_TOLERANCE &&
        Math.abs(png.data[i + 2] - want.b) <= RING_INK_TOLERANCE
      ) {
        quads[(py < png.height / 2 ? 0 : 2) + (px < png.width / 2 ? 0 : 1)]++;
      }
    }
  }
  return { total: quads[0] + quads[1] + quads[2] + quads[3], quads };
}

test.describe.configure({ mode: 'serial' });

test.describe('CORNER-01 on the real host: press a doorstep, turn at once, and the belt docks', () => {
  test('A CORNER OUT OF A MACHINE PORT: press the doorstep, turn at once, and the belt docks', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);

    // THE LEG'S OWN ROUTER (D-19), placed from the palette on floor the demo leaves bare.
    for (const [cx, cy] of [ROUTER_ANCHOR, DOORSTEP, TURN_CELL]) {
      const fresh = await readScene(page);
      expect(
        beltsAt(fresh, cx, cy).length === 0 && !fresh.nodes.some((n) => hasCell(n.cells, cx, cy)),
        `(${cx},${cy}) is bare floor on the demo, so the leg's own Router and its corner fit there`,
      ).toBe(true);
    }
    await armAndPlaceAt(page, 'Router', ROUTER_ANCHOR[0], ROUTER_ANCHOR[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, ROUTER_ANCHOR[0], ROUTER_ANCHOR[1]) !== undefined, {
      message: 'the hand-placed Router folded on the real host',
    }).toBe(true);
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, "right after placing the leg's own Router");

    const before = await readScene(page);
    const router = nodeAtAnchor(before, ROUTER_ANCHOR[0], ROUTER_ANCHOR[1]);
    expect(router, 'the placed ROUTER is anchored at (20,9)').toBeTruthy();
    // A Tail dock's wire `port` is the Out ROUTING key, the port's index among the node's
    // role-1 ports, never its catalog index (`ports.ts` dockPort).
    const routerOuts = router!.ports.filter((p) => p.role === 1);
    // The port is found from the Router's ports, never by an index: the TOPMOST Mechanical
    // Out with no belt docked to it.
    const port = routerOuts
      .filter(
        (p) =>
          p.medium === 0 &&
          !before.belts.some((b) =>
            (b.docks ?? []).some((d) => d.end === 'Tail' && d.node === router!.id && d.port === routerOuts.indexOf(p)),
          ),
      )
      .reduce<(typeof routerOuts)[number] | undefined>((top, p) => (top === undefined || p.cell_y < top.cell_y ? p : top), undefined)!;
    expect(port, 'the placed ROUTER has a free Mechanical Out').toBeDefined();
    // The same tripwire `18-refusal.spec.ts` carries: if the catalog moved this port, the
    // leg below would be pressing somewhere else and its verdict would mean nothing.
    expect(
      [port.cell_x, port.cell_y, port.side, port.role, port.medium],
      "the placed ROUTER's free top Out is a Mechanical Out at (21,9) facing E",
    ).toEqual([21, 9, 1, 1, 0]);
    const routingKey = routerOuts.indexOf(port);
    expect(routingKey, 'that port is one of the ROUTER Outs').toBeGreaterThanOrEqual(0);
    expect(
      before.belts.some((b) =>
        (b.docks ?? []).some((d) => d.end === 'Tail' && d.node === router!.id && d.port === routingKey),
      ),
      'no belt is docked to that Out yet, so any dock below is the one THIS gesture made',
    ).toBe(false);
    for (const [cx, cy] of [DOORSTEP, TURN_CELL]) {
      expect(beltsAt(before, cx, cy), `(${cx},${cy}) carries no belt`).toHaveLength(0);
      expect(
        before.nodes.some((n) => hasCell(n.cells, cx, cy)),
        `(${cx},${cy}) is outside every machine footprint`,
      ).toBe(false);
    }

    await expectRefusalStayedSilent(page, 'corner out of the ROUTER Out', async () => {
      await page.getByTitle(/^Draw belts/).click();
      const press = await screenCellCentre(page, DOORSTEP[0], DOORSTEP[1]);
      const turn = await screenCellCentre(page, TURN_CELL[0], TURN_CELL[1]);
      await pointerTravel(page, press.x, press.y);
      await page.mouse.down();
      // Straight NORTH from the doorstep centre, one eighth of a cell per sample, so the
      // first three samples are still inside the pressed tile.
      await pointerTravel(page, turn.x, turn.y, 8);
      await page.mouse.up();
      await page.keyboard.press('Escape');

      await pollScene(page, (s) => s.belts.length, {
        message: 'the corner draw minted exactly one new belt',
      }).toBe(before.belts.length + 1);
    });

    // THE MODEL FIRST. Handles can be reminted by a keyframe, so the ROUTER is re-read by
    // anchor and the new belt is found by the cell it starts on, which was free before.
    const after = await readScene(page);
    const routerAfter = nodeAtAnchor(after, ROUTER_ANCHOR[0], ROUTER_ANCHOR[1]);
    expect(routerAfter, 'the ROUTER is still anchored at (20,9)').toBeTruthy();
    const drawn = beltsAt(after, DOORSTEP[0], DOORSTEP[1]);
    expect(drawn, 'exactly one belt starts on the doorstep').toHaveLength(1);
    expect(
      drawn[0].tiles.map((t) => [t.cell_x, t.cell_y]),
      'the belt starts ON the pressed doorstep and turns north at once: no cell the pointer ' +
        'did not sweep, no stub behind the hand',
    ).toEqual([
      [22, 9],
      [22, 8],
    ]);
    await pollScene(
      page,
      (s) =>
        beltsAt(s, DOORSTEP[0], DOORSTEP[1]).some((b) =>
          (b.docks ?? []).some(
            (d) => d.end === 'Tail' && d.node === routerAfter!.id && d.port === routingKey,
          ),
        ),
      {
        message:
          'the new belt carries a Tail dock naming the ROUTER on that Out: the press resolved ' +
          'to the port (not a plain draw) and the host accepted a carrier that turns at the ' +
          'doorstep',
      },
    ).toBe(true);
    // THE JOIN THE USER SEES (plan 74.1-09): the Out faces E and the belt turns N at once,
    // so the seam tile (22,9) ships the corner from the Out's flow into the belt's.
    await pollScene(page, (s) => tileKindAt(s, DOORSTEP[0], DOORSTEP[1]), {
      message: 'the seam tile (22,9) ships Corner{from:E, to:N}: the belt leaves the Out with a 90 degree corner',
    }).toEqual(SEAM_E_TO_N);
    expect(
      tileKindAt(await readScene(page), TURN_CELL[0], TURN_CELL[1]),
      'the free Head (22,8) stays a north-south straight',
    ).toEqual(STRAIGHT_NS);

    await expectRenderLoopAlive(page, 'after a corner out of a machine port');
    errs.assertNone('the corner-out-of-a-machine-port leg');
  });

  test('A CORNER OUT OF A BELT END: press the floor past its end, turn at once, and the runs join', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);
    const before = await readScene(page);
    for (const [cx, cy] of CORNER_CELLS) {
      expect(beltsAt(before, cx, cy), `(${cx},${cy}) is free floor before the corner`).toHaveLength(0);
    }

    await expectRefusalStayedSilent(page, 'a corner out of a belt end', async () => {
      await drawCornerOffTheBeltEnd(page, STEPS_PER_CELL);
      await expectCornerJoined(page, 'the belt-end corner');
    });
    await page.keyboard.press('Escape');

    await expectRenderLoopAlive(page, 'after a corner out of a belt end');
    errs.assertNone('the belt-end corner leg');
  });

  test('DOUBLING BACK OVER WHAT YOU PRESSED IS RED AND COMMITS NOTHING', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);

    // THE BACK-DRAG: press the Head's doorstep, then drag WEST straight back over the
    // belt's own end tile and on. The preview is red; the release is sent (D-13) and the
    // host refuses it in words, so it commits nothing.
    const door = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    await pointerTravel(page, door.x, door.y);
    await page.mouse.down();
    await moveThroughCells(
      page,
      [
        [7, 6],
        [6, 6],
      ],
      STEPS_PER_CELL,
    );
    const said = captureRefusalText(page, 'the back-drag was sent and refused in words (D-13)');
    await page.mouse.up();
    expect(await said, 'the host says why the back-drag laid nothing').toBe(COLLISION_COPY);
    // A commit would echo within a tick or two; give it far longer than that.
    await page.waitForTimeout(750);
    const afterBack = await readScene(page);
    expect(afterBack.belts, 'the back-drag committed no belt').toHaveLength(1);
    expect(afterBack.belts[0].docks ?? [], 'and docked nothing to the pressed belt').toHaveLength(0);
    // The sentence's hold ends before the discriminator, so the silence below is its own.
    await expect
      .poll(async () => ((await page.locator('#fab-refusal').textContent()) ?? '').trim(), {
        timeout: 15_000,
        message: 'the back-drag sentence has gone before the forward discriminator',
      })
      .toBe('');

    await expectRefusalStayedSilent(page, 'the forward discriminator', async () => {
      // THE DISCRIMINATOR, from the SAME press point: forward east to (10,6). It joins, so
      // the press above did land on the doorstep and the back-drag is what committed
      // nothing. Two belts, not three, so the back-drag never committed late either.
      await pointerTravel(page, door.x, door.y);
      await page.mouse.down();
      await moveThroughCells(
        page,
        [
          [9, 6],
          [10, 6],
        ],
        STEPS_PER_CELL,
      );
      await page.mouse.up();
      await pollScene(page, (s) => s.belts.length, {
        message: 'the forward gesture from the same press minted the second belt',
      }).toBe(2);
      await pollScene(page, junction, {
        message: 'the forward gesture joined 1/1 from the same press point',
      }).toBe('1/1');
      // The forward join is COLLINEAR, so the seam draws as a straight: every tile of both
      // runs ships east-west straight. (Equal to the stored kind by construction, so this
      // guards a derivation that bends a collinear seam; it cannot see a host that stops
      // deriving, which legs 1, 2, 4 and 5 can.)
      await pollScene(page, (s) => tileKindAt(s, BELT_DOORSTEP[0], BELT_DOORSTEP[1]), {
        message: 'the collinear seam tile (8,6) ships an east-west straight',
      }).toEqual(STRAIGHT_EW);
    });
    await page.keyboard.press('Escape');
    const end = await readScene(page);
    expect(end.belts, 'exactly two belts: the back-drag added none').toHaveLength(2);
    expect(
      beltsAt(end, BELT_DOORSTEP[0], BELT_DOORSTEP[1])[0].tiles.map((t) => [t.cell_x, t.cell_y]),
      'the second belt is exactly the forward run',
    ).toEqual([
      [8, 6],
      [9, 6],
      [10, 6],
    ]);
    expect(
      end.belts.flatMap((b) => b.tiles.map((t) => t.kind)),
      'both runs are east-west straight through the collinear seam',
    ).toEqual(end.belts.flatMap((b) => b.tiles.map(() => STRAIGHT_EW)));

    await expectRenderLoopAlive(page, 'after a back-drag and its discriminator');
    errs.assertNone('the double-back leg');
  });

  test('AT MIN_ZOOM THE BELT END CORNER STILL JOINS', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);

    // Wheel OUT over the belt until the camera reports MIN_ZOOM. 0.25 is a literal because
    // the live specs read the app through the page, never through its modules: it is
    // `MIN_ZOOM` in `frontend/src/render/camera.ts:17`. Bounded: fail if not reached.
    const over = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    await pointerTravel(page, over.x, over.y);
    for (let notch = 0; notch < 40 && (await cameraOf(page)).scale > 0.25; notch++) {
      await page.mouse.wheel(0, 200);
      await page.waitForTimeout(30);
    }
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera reached MIN_ZOOM 0.25').toBe(0.25);
    const door = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    const top = await screenCellCentre(page, CORNER_CELLS[3][0], CORNER_CELLS[3][1]);
    await expectOnCanvas(page, [door, top], 'the MIN_ZOOM corner');

    // The doorstep target here is 8 x 8 screen px, under the 12 px floor nubs keep: the
    // exception plan 74.1-05 names. This leg proves the exception is the target's SIZE,
    // not a failure to connect: pressed at its centre, it joins. A quarter cell is 2
    // screen px at this scale, so each one-cell move emits 4 samples.
    await expectRefusalStayedSilent(page, 'the MIN_ZOOM belt-end corner', async () => {
      await drawCornerOffTheBeltEnd(page, 4);
      await expectCornerJoined(page, 'the MIN_ZOOM belt-end corner');
    });
    await page.keyboard.press('Escape');

    await expectRenderLoopAlive(page, 'after the MIN_ZOOM corner');
    errs.assertNone('the MIN_ZOOM leg');
  });

  test('A BELT THAT ENDS SIDEWAYS IN FRONT OF AN INPUT CONNECTS (D-14)', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);

    const SINK_CELL = [14, 8] as const;
    await armAndPlaceAt(page, 'Sink', SINK_CELL[0], SINK_CELL[1]);
    await pollScene(page, (s) => s.nodes.length, { message: 'the Sink was placed' }).toBe(1);
    const placed = await readScene(page);
    const sink = placed.nodes.find((n) => hasCell(n.cells, SINK_CELL[0], SINK_CELL[1]));
    expect(sink, 'the Sink covers its drop cell').toBeTruthy();
    const inPort = sink!.ports.find((p) => p.role === 0);
    expect(inPort, 'the Sink has an In port').toBeTruthy();

    // The path, from the port facts: the In's doorstep, and three cells PERPENDICULAR to
    // the In's side away from it, so the belt arrives sideways and ends on the doorstep.
    const [ox, oy] = outwardStep(inPort!.side);
    const doorstep: [number, number] = [inPort!.cell_x + ox, inPort!.cell_y + oy];
    const [px, py] = outwardStep((inPort!.side + 1) & 3);
    const path: [number, number][] = [3, 2, 1, 0].map((k) => [doorstep[0] + px * k, doorstep[1] + py * k]);
    // Nothing else on this board can dock the belt: every path cell is free floor, and the
    // press cell is no machine port's doorstep (there is no belt yet, so no Head doorstep).
    const portDoorsteps = placed.nodes.flatMap((n) =>
      n.ports.map((p) => {
        const [dx, dy] = outwardStep(p.side);
        return [p.cell_x + dx, p.cell_y + dy, p.role] as const;
      }),
    );
    for (const [cx, cy] of path) {
      expect(placed.nodes.some((n) => hasCell(n.cells, cx, cy)), `(${cx},${cy}) is outside the Sink`).toBe(false);
      expect(beltsAt(placed, cx, cy), `(${cx},${cy}) carries no belt`).toHaveLength(0);
    }
    for (const [cx, cy] of path.slice(0, 3)) {
      expect(
        portDoorsteps.some(([dx, dy]) => dx === cx && dy === cy),
        `(${cx},${cy}) is no port's doorstep, so the press starts a plain draw`,
      ).toBe(false);
    }
    const press = await screenCellCentre(page, path[0][0], path[0][1]);
    const drop = await screenCellCentre(page, doorstep[0], doorstep[1]);
    await expectOnCanvas(page, [press, drop], 'the sideways draw');

    await expectRefusalStayedSilent(page, 'a belt ending sideways in front of an In', async () => {
      await page.getByTitle(/^Draw belts/).click();
      await pointerTravel(page, press.x, press.y);
      await page.mouse.down();
      await moveThroughCells(page, path.slice(1), STEPS_PER_CELL);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => s.belts.length, { message: 'the sideways draw minted one belt' }).toBe(1);
    });

    const after = await readScene(page);
    const sinkAfter = after.nodes.find((n) => hasCell(n.cells, SINK_CELL[0], SINK_CELL[1]));
    expect(
      after.belts[0].tiles.map((t) => [t.cell_x, t.cell_y]),
      'the belt is exactly the authored sideways run, ending on the In doorstep',
    ).toEqual(path);
    // A consequence of the host narrowing (UI-SPEC 3.2 item 6), confirmed in the manual walkthrough.
    await pollScene(
      page,
      (s) => (s.belts[0]?.docks ?? []).some((d) => d.end === 'Head' && d.node === sinkAfter!.id),
      { message: 'the belt carries a Head dock naming the Sink: a sideways arrival connects' },
    ).toBe(true);
    // THE JOIN THE USER SEES (plan 74.1-09): the last tile is the corner from the belt's
    // arrival travel (its own last step) into the In (the flow opposite the In's side),
    // both computed here from the path and the Sink's port facts.
    const arrival = stepSide(path[path.length - 2], path[path.length - 1]);
    expect(arrival, 'the path ends with a unit step').not.toBeNull();
    const into = (inPort!.side + 2) & 3;
    expect(arrival, 'the arrival is sideways to the In (perpendicular), the D-14 shape').not.toBe(into);
    expect((arrival! + 2) & 3, 'and not straight out of it').not.toBe(into);
    const headCorner: TileKindFacts = { Corner: { from: arrival!, to: into } };
    await pollScene(page, (s) => (s.belts[0] ? s.belts[0].tiles[s.belts[0].tiles.length - 1].kind : null), {
      message: `the belt's last tile ships ${JSON.stringify(headCorner)}: it turns into the In with a 90 degree corner`,
    }).toEqual(headCorner);

    await expectRenderLoopAlive(page, 'after a sideways arrival in front of an In');
    errs.assertNone('the D-14 leg');
  });

  test('WITH THE BELT TOOL ARMED, THE RINGS ARE PAINTED ON THE DOORSTEP, NOT ON THE BELT END OR THE NUB', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);
    await page.keyboard.press('Escape');

    // A Source on free floor clear of the belt; its Out's doorstep computed HERE from the
    // live scene's port facts, never from product code.
    const SOURCE_CELL = [14, 10] as const;
    await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
    await pollScene(page, (s) => s.nodes.length, { message: 'the Source was placed' }).toBe(1);
    const scene = await readScene(page);
    const source = scene.nodes.find((n) => hasCell(n.cells, SOURCE_CELL[0], SOURCE_CELL[1]));
    expect(source, 'the Source covers its drop cell').toBeTruthy();
    const out = source!.ports.find((p) => p.role === 1);
    expect(out, 'the Source has an Out port').toBeTruthy();
    expect(out!.medium, 'a Mechanical Out, which the Belt tool rings').toBe(0);
    const [ox, oy] = outwardStep(out!.side);
    const srcDoor: [number, number] = [out!.cell_x + ox, out!.cell_y + oy];
    expect(beltsAt(scene, srcDoor[0], srcDoor[1]), 'the Source doorstep is free floor').toHaveLength(0);
    expect(scene.belts[0].docks ?? [], 'the belt is still undocked').toHaveLength(0);

    // Park the pointer on free floor far from both doorsteps, so no idle hover ring and no
    // preview cell can enter a clip.
    const park = await screenCellCentre(page, 22, 3);
    await expectOnCanvas(page, [park], 'the parking point');
    const parkPointer = async (): Promise<void> => {
      await pointerTravel(page, park.x, park.y, 4);
    };
    await parkPointer();

    // DISARMED: no ring ink anywhere it will later appear.
    const offBelt = await ringInk(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    const offEnd = await ringInk(page, HEAD_CELL[0], HEAD_CELL[1]);
    const offSrc = await ringInk(page, srcDoor[0], srcDoor[1]);
    expect(offBelt.total, 'no ring at the belt doorstep with no tool armed').toBe(0);
    expect(offSrc.total, 'no ring at the Source doorstep with no tool armed').toBe(0);

    // ARMED. The poll's cap is derived from the frames it waits on (plan 84-18, D-12): each try
    // takes two clip captures of `CAPTURE_FRAMES` each, `CAPTURE_POLL_TRIES` tries, and the
    // rings show `DRAWN_STATE_FRAMES` after the page holds the armed tool.
    await page.getByTitle(/^Draw belts/).click();
    await parkPointer();
    await expect
      .poll(
        async () => {
          const a = await ringInk(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
          const b = await ringInk(page, srcDoor[0], srcDoor[1]);
          return a.total > 0 && b.total > 0;
        },
        {
          timeout: addWaitBudget(
            frameBudgetMs(CAPTURE_POLL_TRIES * 2 * CAPTURE_FRAMES + DRAWN_STATE_FRAMES),
            `armed rings poll: ${CAPTURE_POLL_TRIES} tries of two clip captures`,
          ),
          intervals: [100, 250, 500],
          message: 'the armed rings reached the canvas at both doorsteps',
        },
      )
      .toBe(true);
    const onBelt = await ringInk(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    const onSrc = await ringInk(page, srcDoor[0], srcDoor[1]);
    const onEnd = await ringInk(page, HEAD_CELL[0], HEAD_CELL[1]);
    console.log(
      `[ring-ink] belt doorstep ${onBelt.total} ${JSON.stringify(onBelt.quads)}; ` +
        `source doorstep ${onSrc.total} ${JSON.stringify(onSrc.quads)}; ` +
        `end tile armed ${onEnd.total} disarmed ${offEnd.total}`,
    );
    for (const [name, ink] of [
      ['belt doorstep', onBelt],
      ['Source doorstep', onSrc],
    ] as const) {
      expect(ink.total, `${name}: at least the measured floor of ring ink`).toBeGreaterThanOrEqual(RING_INK_FLOOR);
      for (const q of ink.quads) {
        expect(
          q,
          `${name}: every quadrant holds at least ${RING_QUADRANT_MIN_SHARE * 100}% of the ink ` +
            `(${JSON.stringify(ink.quads)}), so the ring is centred ON the doorstep`,
        ).toBeGreaterThanOrEqual(RING_QUADRANT_MIN_SHARE * ink.total);
      }
    }
    expect(onEnd.total, 'arming adds no ring at the belt\'s own end tile').toBe(offEnd.total);
    await page.keyboard.press('Escape');

    await expectRenderLoopAlive(page, 'after reading the rings off the canvas');
    errs.assertNone('the ring paint leg');
    console.log(captureCostLine());
  });
});
