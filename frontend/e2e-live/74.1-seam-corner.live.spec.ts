import { test, expect, type Page } from '@playwright/test';
import { addFrameBudget } from '../e2e/support/frameSampler';
import {
  DEMO_NODE_COUNT,
  cameraOf,
  captureCostLine,
  clickAt,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  newBoard,
  pointerTravel,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  tileKindAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CELL } from '../shared/geometry';
// The ink reader, its boxes and their floors live in a support file since plan 106-08, so lesson 2's
// walk reads its seam the same way; they moved unchanged apart from `groundColour` taking its tile.
import {
  ARC_BOX,
  ARC_EXIT_TREAD_BOX,
  ARC_EXIT_TREAD_FLOOR_AT_1,
  ARC_EXIT_TREAD_FLOOR_AT_3_PLUS,
  ARC_INK_FLOOR_AT_1,
  ARC_INK_FLOOR_AT_3_PLUS,
  SIG_BOXES,
  SIG_CORNER_CEILING,
  SIG_FLOOR_AT_1,
  SIG_FLOOR_AT_3_PLUS,
  SIG_NAMES,
  expectOnCanvas,
  groundColour,
  tileInk,
} from './support/seamInk';

// 74.1-seam-corner.live.spec.ts (CORNER-01, CORNER-06) - the JOIN graded on what the user
// SEES: the tile kind the real `dev_render_server` ships at a docked seam.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS FOR (gap 1 of 74.1-VERIFICATION.md)
// ---------------------------------------------------------------------------
//
// S1, S2 and S4 were rejected on the real binary: a belt drawn north at once off a belt end
// docked in the model, but the join drew as a T, the old belt's end butting into the side of
// a straight tile with a collar between them. Every earlier check graded the LINK (a dock
// read 1/1 from both sides) and passed while the screen showed the T. So this file grades the seam on
// the shipped tile KIND: the new belt's first tile must arrive as a 90 degree Corner from
// the old belt's flow (east) into its own (north). Since plan 74.1-07 the host derives that
// kind at read (`GridState::effective_belt_tiles`, shipped by `render_packet.rs`
// `current_views`); the stored geometry stays the Straight route() typed.
//
// ---------------------------------------------------------------------------
// WHY A NEW FILE
// ---------------------------------------------------------------------------
//
// `74.1-corner-connects.live.spec.ts` is count-gated at exactly 6 tests by its plans, so the
// seam legs live here. The helpers were COPIED from it, not imported: spec files export
// nothing. Since plan 106-08 the ink reader lives in `support/seamInk.ts`. This file declares exactly 1 test after plan 74.1-07 and 3 after plan 74.1-09.
//
// ---------------------------------------------------------------------------
// THE THREE LEGS (this file declares exactly 3 tests)
// ---------------------------------------------------------------------------
//
//   1. S1 ON THE REAL HOST (plan 74.1-07): the seam tile KIND the packet ships is the
//      corner, the link alone is not the claim.
//   2. THE SEAM DRAWS AS THE REFERENCE CORNER (plan 74.1-09, gap 3): the canvas PIXELS
//      of the seam tile read like a reference Corner{E,N} drawn east then north on the same
//      board, and unlike a reference north-south straight, at scale 1 and at 3 or more.
//      This is the one leg here that reads no model fact for its claim: a renderer that
//      drew the shipped Corner as a straight would pass leg 1 and fail this one. Since plan
//      74.1-21 (review WR-06) it also grades the corner's PRESENCE and DIRECTION with two
//      positive boxes, so a seam tile drawn blank, not drawn, or turned the wrong way
//      fails it too (each watched RED at both scales).
//   3. A HANDLE DRAG THAT DOCKS SIDEWAYS SHIPS A CORNER (plan 74.1-09, review CR-01): the
//      Dock command path that adds no tile still ships the derived corner, and one Ctrl+Z,
//      which undoes the Dock, returns the straight end.
//
// ---------------------------------------------------------------------------
// EVERY BELT-DRAWING LEG DRIVES SUB-CELL POINTER SAMPLES
// ---------------------------------------------------------------------------
//
// A fixture that teleports one clean cell per pointer event hides gesture defects that a
// real hand exposes, so every move here emits STEPS_PER_CELL samples per cell
// (`page.mouse.move(..., { steps })`), the first several inside the tile the press landed in.
//
// MODEL FIRST, THEN RENDER HEALTH. The scene oracle reads the decoded packet, which keeps
// advancing with a dead renderer, so the leg ends with `expectRenderLoopAlive` and
// `watchPageErrors(...).assertNone`.

/** Belt A, drawn first on an empty board: four cells east, Head (7,6). */
const FIRST_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** Belt A's Head tile. The junction is read here; it is NOT pressed. */
const HEAD_CELL = [7, 6] as const;
/** The Head's doorstep: the empty floor tile it faces, where the press lands. */
const BELT_DOORSTEP = [8, 6] as const;
/** The new belt: off the doorstep, north at once, four cells. */
const CORNER_CELLS: readonly (readonly [number, number])[] = [
  [8, 6],
  [8, 5],
  [8, 4],
  [8, 3],
];

/** Pointer samples per one-cell move at scale 1: an eighth of a cell each (4 screen px). */
const STEPS_PER_CELL = 8;

/** The most wheel notches the probe takes to reach scale 3 or more (the zoom's own bound). */
const WHEEL_NOTCHES_MAX = 20;
/**
 * The frames one wheel notch costs, measured at the GPU proxy (plan 84-18 Task 1): a notch is an
 * input event the page acknowledges like a pointer move, but the trace timed 24 notches at up to
 * 833 ms each (median 407 to 605), at THE PAIR's 4.53 frames a second 3.8 frames, so 4, not
 * `HAND_MOVE_FRAMES` (2).
 */
const WHEEL_NOTCH_FRAMES = 4;

/** Leg 3's belt A: drawn north, Head (8,6). */
const HANDLE_A_CELLS: readonly (readonly [number, number])[] = [
  [8, 9],
  [8, 8],
  [8, 7],
  [8, 6],
];
/** Leg 3's belt B: drawn east, Tail (9,6), one step east of A's Head. */
const HANDLE_B_CELLS: readonly (readonly [number, number])[] = [
  [9, 6],
  [10, 6],
  [11, 6],
];

/**
 * The wire encodings the kinds below are written in (`TileKindView`): Axis X=0, Y=1;
 * Dir N=0, E=1, S=2, W=3. The seam turns from A's flow (E) into the new belt's (N).
 */
const SEAM_CORNER = { Corner: { from: 1, to: 0 } };
/** A north-flowing belt end docked to a run that leaves east: Corner{from:N, to:E}. */
const HEAD_CORNER_N_TO_E = { Corner: { from: 0, to: 1 } };
const STRAIGHT_NS = { Straight: { axis: 1 } };
const STRAIGHT_EW = { Straight: { axis: 0 } };

/** Every belt that occupies (cx, cy). */
function beltsAt(scene: SceneFacts, cx: number, cy: number) {
  return scene.belts.filter((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy));
}

/**
 * The junction between belt A and the run drawn off its doorstep, read from BOTH SIDES and
 * resolved BY CELL (handles can be reminted by a keyframe). `'1/1'` is joined, `'0/0'` is two
 * runs that only abut, `'MISSING'` is fewer than two belts there.
 */
function junction(scene: SceneFacts): string {
  const up = beltsAt(scene, HEAD_CELL[0], HEAD_CELL[1])[0];
  const down = beltsAt(scene, BELT_DOORSTEP[0], BELT_DOORSTEP[1])[0];
  if (!up || !down || up.id === down.id) return 'MISSING';
  const a = (up.docks ?? []).filter((d) => d.end === 'Head' && d.node === down.id).length;
  const b = (down.docks ?? []).filter((d) => d.end === 'Tail' && d.node === up.id).length;
  return `${a}/${b}`;
}

/** The new belt's shipped tile kinds, in tile order, or `null` before it exists. */
function seamBeltKinds(scene: SceneFacts): unknown[] | null {
  const down = beltsAt(scene, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
  if (down.length !== 1) return null;
  return down[0].tiles.map((t) => t.kind);
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
 * An empty board at camera scale 1 (READ and asserted) holding belt A, drawn with sub-cell
 * samples, with the Belt tool left ARMED.
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
  await expectOnCanvas(page, [start, end], 'belt A');
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
    'belt A is exactly FIRST_CELLS',
  ).toEqual(FIRST_CELLS.map(([x, y]) => [x, y]));
  expect(only.belts[0].docks ?? [], 'belt A starts undocked').toHaveLength(0);
}

/**
 * The reference belt for the pixel probe: east then north, its interior (12,6) a
 * Corner{E,N}. Every probed tile sits in rows 5 and 6, and the zoom is anchored on row 5's
 * top edge, so at both scales the clips stay below the empty-floor hint, an HTML overlay
 * centred on the canvas (measured: at 3.32 a row-4 tile lies under its text).
 */
const REF_CELLS: readonly (readonly [number, number])[] = [
  [10, 6],
  [11, 6],
  [12, 6],
  [12, 5],
  [12, 4],
];
/** The reference corner: the approved shape at J4 (a belt drawn east then north). */
const REF_CORNER = [12, 6] as const;
/** The reference straight: the seam belt's own interior north-south tile next to the seam. */
const REF_STRAIGHT = [8, 5] as const;
/** Empty floor inside the probed region, where the board ground colour is read. */
const GROUND_TILE = [10, 5] as const;
/** The world point the pointer parks on and the zoom is anchored at: row 5's top edge. */
const PARK_WORLD = { x: 10.5 * CELL, y: 5 * CELL } as const;

test.describe.configure({ mode: 'serial' });

test.describe('CORNER-01 seam on the real host: the join is graded on the shipped tile kind', () => {
  test('S1 ON THE REAL HOST: a belt drawn north at once off a belt end ships a 90 degree corner at the seam', async ({
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

    // Press the doorstep centre and drag north at once, sub-cell samples throughout.
    const door = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    const last = await screenCellCentre(page, CORNER_CELLS[3][0], CORNER_CELLS[3][1]);
    await expectOnCanvas(page, [door, last], 'the seam draw');
    await pointerTravel(page, door.x, door.y);
    await page.mouse.down();
    await moveThroughCells(page, CORNER_CELLS.slice(1), STEPS_PER_CELL);
    await page.mouse.up();
    await page.keyboard.press('Escape');

    // The link, read from both sides. Necessary, and NOT the join claim: this passed while
    // the screen showed a T.
    await pollScene(page, (s) => s.belts.length, { message: 'a second belt was minted' }).toBe(2);
    await pollScene(page, junction, {
      message: "belt A's Head dock names the new belt AND the new belt's Tail dock names A",
    }).toBe('1/1');
    const after = await readScene(page);
    const drawn = beltsAt(after, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    expect(drawn, 'exactly one belt starts on the doorstep').toHaveLength(1);
    expect(
      drawn[0].tiles.map((t) => [t.cell_x, t.cell_y]),
      'the new belt starts ON the pressed doorstep and turns north at once',
    ).toEqual([
      [8, 6],
      [8, 5],
      [8, 4],
      [8, 3],
    ]);

    // THE JOIN CLAIM: the seam tile the packet ships is a 90 degree corner from A's flow (E)
    // into the new belt's (N). Polled, because the Dock echo lands one packet after the
    // DrawBelt echo.
    await pollScene(page, (s) => seamBeltKinds(s)?.[0] ?? null, {
      message: "the new belt's seam tile (8,6) ships Corner{from:E, to:N}, not the Straight route() stored",
    }).toEqual({ Corner: { from: 1, to: 0 } });
    const settled = await readScene(page);
    const kinds = seamBeltKinds(settled);
    expect(kinds, 'the new belt is readable by cell').not.toBeNull();
    expect(kinds![0], 'tile 0 is the seam corner').toEqual(SEAM_CORNER);
    for (let i = 1; i < 4; i++) {
      expect(kinds![i], `the new belt's tile ${i} stays a north-south straight`).toEqual(STRAIGHT_NS);
    }
    const a = beltsAt(settled, HEAD_CELL[0], HEAD_CELL[1]);
    expect(a, 'belt A is readable by cell').toHaveLength(1);
    a[0].tiles.forEach((t, i) => {
      expect(t.kind, `belt A's tile ${i} stays an east-west straight (only the carrier bends)`).toEqual(
        STRAIGHT_EW,
      );
    });

    await expectRenderLoopAlive(page, 'after a seam corner off a belt end');
    errs.assertNone('the S1 seam leg');
  });

  test('THE SEAM DRAWS AS THE REFERENCE CORNER, NOT AS A T: pixels at scale 1 and at 3 or more', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);

    // The S1 join: press A's doorstep and turn north at once.
    const door = await screenCellCentre(page, BELT_DOORSTEP[0], BELT_DOORSTEP[1]);
    await pointerTravel(page, door.x, door.y);
    await page.mouse.down();
    await moveThroughCells(page, CORNER_CELLS.slice(1), STEPS_PER_CELL);
    await page.mouse.up();
    await pollScene(page, junction, { message: 'the S1 join is docked 1/1' }).toBe('1/1');
    // The reference belt, east then north, on free floor: a plain draw (no doorstep pressed).
    const refStart = await screenCellCentre(page, REF_CELLS[0][0], REF_CELLS[0][1]);
    await expectOnCanvas(page, [refStart], 'the reference belt');
    await pointerTravel(page, refStart.x, refStart.y);
    await page.mouse.down();
    await moveThroughCells(page, REF_CELLS.slice(1), STEPS_PER_CELL);
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await pollScene(page, (s) => s.belts.length, { message: 'the reference belt was minted' }).toBe(3);

    // THE MODEL FIRST: the seam ships the corner, the references are what they claim.
    await pollScene(page, (s) => tileKindAt(s, BELT_DOORSTEP[0], BELT_DOORSTEP[1]), {
      message: 'the seam tile (8,6) ships Corner{from:E, to:N}',
    }).toEqual(SEAM_CORNER);
    const model = await readScene(page);
    expect(tileKindAt(model, REF_CORNER[0], REF_CORNER[1]), 'the reference corner (12,6) is Corner{E,N}').toEqual(
      SEAM_CORNER,
    );
    expect(tileKindAt(model, REF_STRAIGHT[0], REF_STRAIGHT[1]), 'the reference straight (8,5) is north-south').toEqual(
      STRAIGHT_NS,
    );
    expect(tileKindAt(model, GROUND_TILE[0], GROUND_TILE[1]), 'the ground tile (10,5) is empty floor').toBeNull();
    const ref = beltsAt(model, REF_CORNER[0], REF_CORNER[1]);
    expect(ref[0]?.docks ?? [], 'the reference belt docks nothing').toHaveLength(0);

    // Park on empty floor in the middle of the probed region, then freeze the frame: the
    // render clock pinned (06-fault-red-probe's pattern), released in `finally`.
    const park = await screenPoint(page, PARK_WORLD);
    await pointerTravel(page, park.x, park.y, 4);
    await page.evaluate(() => {
      const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
      if (!hook) throw new Error('window.__fabrico not installed');
      hook.pinClock(0);
    });
    try {
      const probe = async (label: string): Promise<void> => {
        const scale = (await cameraOf(page)).scale;
        const ground = await groundColour(page, GROUND_TILE);
        const seam = await tileInk(page, BELT_DOORSTEP, SIG_BOXES, ground);
        const corner = await tileInk(page, REF_CORNER, SIG_BOXES, ground);
        const straight = await tileInk(page, REF_STRAIGHT, SIG_BOXES, ground);
        const [seamArc, seamExit] = await tileInk(page, BELT_DOORSTEP, [ARC_BOX, ARC_EXIT_TREAD_BOX], ground);
        const [cornerArc, cornerExit] = await tileInk(page, REF_CORNER, [ARC_BOX, ARC_EXIT_TREAD_BOX], ground);
        console.log(
          `[seam-probe] ${label} scale ${scale} S/E seam ${seam.join('/')} corner ${corner.join('/')} ` +
            `straight ${straight.join('/')} ARC seam ${seamArc} corner ${cornerArc} ` +
            `EXIT seam ${seamExit} corner ${cornerExit}`,
        );
        // THE POSITIVE HALF (WR-06): each box is on corner ink at all, and the seam tile
        // carries as much of it as the floor measured on the reference corner. A seam drawn
        // blank, skipped or at zero alpha fails ARC_BOX; one drawn reversed fails the exit
        // tread box; the ceilings below pass all three. SOFT, so one run grades both scales
        // before the leg fails: a defect that only one scale shows is still reported.
        const arcFloor = scale >= 3 ? ARC_INK_FLOOR_AT_3_PLUS : ARC_INK_FLOOR_AT_1;
        const exitFloor = scale >= 3 ? ARC_EXIT_TREAD_FLOOR_AT_3_PLUS : ARC_EXIT_TREAD_FLOOR_AT_1;
        expect
          .soft(cornerArc, `${label}: the reference corner has outer-rail arc ink in ARC_BOX`)
          .toBeGreaterThanOrEqual(arcFloor);
        expect
          .soft(cornerExit, `${label}: the reference corner has exit-run tread ink in ARC_EXIT_TREAD_BOX`)
          .toBeGreaterThanOrEqual(exitFloor);
        expect
          .soft(
            seamArc,
            `${label}: the seam tile (8,6) is DRAWN as a corner: outer-rail arc ink in ARC_BOX (seam ${seamArc}, ` +
              `corner ${cornerArc}, floor ${arcFloor})`,
          )
          .toBeGreaterThanOrEqual(arcFloor);
        expect
          .soft(
            seamExit,
            `${label}: the seam tile (8,6) turns the right way, E into N: exit-run tread ink in ` +
              `ARC_EXIT_TREAD_BOX (seam ${seamExit}, corner ${cornerExit}, floor ${exitFloor})`,
          )
          .toBeGreaterThanOrEqual(exitFloor);
        SIG_NAMES.forEach((name, k) => {
          // The probe can see a straight: the reference straight's rail is inked in this box.
          const floor = scale >= 3 ? SIG_FLOOR_AT_3_PLUS : SIG_FLOOR_AT_1;
          expect(straight[k], `${label}: the reference straight has rail ink in box ${name}`).toBeGreaterThanOrEqual(
            floor,
          );
          // The reference corner has none there.
          expect(corner[k], `${label}: the reference corner has no ink in box ${name}`).toBeLessThanOrEqual(
            SIG_CORNER_CEILING,
          );
          // THE CLAIM: the seam reads as the corner, not as the straight.
          expect(
            seam[k],
            `${label}: the seam tile (8,6) reads as the corner in box ${name} (seam ${seam[k]}, ` +
              `corner ${corner[k]}, straight ${straight[k]}), not as a T`,
          ).toBeLessThanOrEqual(SIG_CORNER_CEILING);
        });
      };
      expect((await cameraOf(page)).scale, 'the probe starts at camera scale 1').toBe(1);
      await probe('scale 1');
      // Wheel IN about the parked point until the camera READS 3 or more (the walk binary
      // opened at 3.19). Bounded: fail if not reached. The bound is budgeted before the loop at
      // `WHEEL_NOTCH_FRAMES` a notch (plan 84-18, D-12).
      addFrameBudget(
        WHEEL_NOTCHES_MAX * WHEEL_NOTCH_FRAMES,
        `wheel in to scale 3: at most ${WHEEL_NOTCHES_MAX} notches`,
      );
      for (let notch = 0; notch < WHEEL_NOTCHES_MAX && (await cameraOf(page)).scale < 3; notch++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(30);
      }
      await waitForCameraSettle(page);
      expect((await cameraOf(page)).scale, 'the camera reached a scale of 3 or more').toBeGreaterThanOrEqual(3);
      await probe('scale 3+');
    } finally {
      await page.evaluate(() => {
        const hook = (window as { __fabrico?: { pinClock(n: number | null): void } }).__fabrico;
        hook?.pinClock(null);
      });
    }

    await expectRenderLoopAlive(page, 'after the seam pixel probe');
    errs.assertNone('the seam pixel probe leg');
    console.log(captureCostLine());
  });
  test('A HANDLE DRAG THAT DOCKS SIDEWAYS SHIPS A CORNER, AND UNDOING THE DOCK RETURNS THE STRAIGHT END', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);

    // Two plain draws with sub-cell samples: A north to (8,6), then B east from (9,6). Neither
    // press is a doorstep (A's Head faces north, so its doorstep is (8,5)), so nothing docks.
    await page.getByTitle(/^Draw belts/).click();
    for (const [cells, n] of [
      [HANDLE_A_CELLS, 1],
      [HANDLE_B_CELLS, 2],
    ] as const) {
      const start = await screenCellCentre(page, cells[0][0], cells[0][1]);
      const end = await screenCellCentre(page, cells[cells.length - 1][0], cells[cells.length - 1][1]);
      await expectOnCanvas(page, [start, end], `the draw to ${n} belts`);
      await pointerTravel(page, start.x, start.y);
      await page.mouse.down();
      await moveThroughCells(page, cells.slice(1), STEPS_PER_CELL);
      await page.mouse.up();
      await pollScene(page, (s) => s.belts.length, { message: `the draw made ${n} belt(s)` }).toBe(n);
    }
    await page.keyboard.press('Escape');
    const built = await readScene(page);
    const a0 = beltsAt(built, 8, 6);
    const b0 = beltsAt(built, 9, 6);
    expect(a0, 'A covers (8,6)').toHaveLength(1);
    expect(b0, 'B covers (9,6)').toHaveLength(1);
    expect(a0[0].tiles.map((t) => [t.cell_x, t.cell_y]), 'A is exactly its authored run').toEqual(
      HANDLE_A_CELLS.map(([x, y]) => [x, y]),
    );
    expect(b0[0].tiles.map((t) => [t.cell_x, t.cell_y]), 'B is exactly its authored run').toEqual(
      HANDLE_B_CELLS.map(([x, y]) => [x, y]),
    );
    expect([...(a0[0].docks ?? []), ...(b0[0].docks ?? [])], 'A and B start undocked').toHaveLength(0);
    expect(tileKindAt(built, 8, 6), "undocked, A's Head is a north-south straight").toEqual(STRAIGHT_NS);

    // A's Head dock naming B, read by cell (handles can be reminted by a keyframe).
    const headDocksToB = (s: SceneFacts): number => {
      const a = beltsAt(s, 8, 6)[0];
      const b = beltsAt(s, 9, 6)[0];
      if (!a || !b || a.id === b.id) return -1;
      return (a.docks ?? []).filter((d) => d.end === 'Head' && d.node === b.id).length;
    };

    // THE GESTURE: select A on an interior tile, press its Head handle (the end tile centre,
    // `74-belt-run-joins.spec.ts` joinByHandleDrag's rule), drop it on B's Tail with sub-cell
    // samples. A handle drag adds no tile: only a Dock is sent (review CR-01).
    const sel = await screenCellCentre(page, 8, 8);
    await clickAt(page, sel.x, sel.y);
    await expect(page.locator('#fab-belt-config'), 'clicking (8,8) selected belt A').toBeVisible({
      timeout: 15_000,
    });
    await expectRefusalStayedSilent(page, 'a sideways handle-drag dock', async () => {
      const head = await screenCellCentre(page, 8, 6);
      const tail = await screenCellCentre(page, 9, 6);
      await pointerTravel(page, head.x, head.y);
      await page.mouse.down();
      await pointerTravel(page, tail.x, tail.y, STEPS_PER_CELL);
      await page.mouse.up();
      await pollScene(page, headDocksToB, { message: "A's Head dock names B: the sideways handle drag docked" }).toBe(
        1,
      );
    });

    // THE JOIN THE USER SEES: A's last tile turns from its own flow (N) into B's (E); B's
    // first tile continues A's flow east, so it stays straight.
    await pollScene(page, (s) => tileKindAt(s, 8, 6), {
      message: "A's last tile (8,6) ships Corner{from:N, to:E}: the docked end draws as a 90 degree corner",
    }).toEqual(HEAD_CORNER_N_TO_E);
    expect(tileKindAt(await readScene(page), 9, 6), "B's first tile (9,6) stays an east-west straight").toEqual(
      STRAIGHT_EW,
    );

    // ONE CTRL+Z. MEASURED at plan 74.1-09 on the real host: one Ctrl+Z after this gesture
    // undoes the Dock (the last edit), so A's Head dock is gone and both belts remain. Focus
    // is moved off any button first (the LW-02 guard stands canvas keys down while a button
    // holds focus, `74-belt-run-joins.spec.ts`).
    await page.locator('#fab-config-heading').click();
    await page.keyboard.press('Control+z');
    await pollScene(page, headDocksToB, { message: "one Ctrl+Z undid the Dock: A's Head names B no more" }).toBe(0);
    const undone = await readScene(page);
    expect(undone.belts, 'the undo removed no belt: both draws stand').toHaveLength(2);
    expect(
      beltsAt(undone, 8, 6)[0]?.docks ?? [],
      'A carries no dock at all after the undo',
    ).toHaveLength(0);
    expect(tileKindAt(undone, 8, 6), "A's last tile is a north-south straight again").toEqual(STRAIGHT_NS);
    expect(tileKindAt(undone, 9, 6), "B's first tile is still an east-west straight").toEqual(STRAIGHT_EW);

    await expectRenderLoopAlive(page, 'after a sideways handle-drag dock and its undo');
    errs.assertNone('the handle-drag seam leg');
  });
});
