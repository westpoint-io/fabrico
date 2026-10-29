import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  cameraOf,
  expectRenderLoopAlive,
  newBoard,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CELL } from '../shared/geometry';

// 74-belt-join-press-on-end.live.spec.ts (LINK-10) - the press-on-a-free-end draw on the
// REAL `dev_render_server`, driven the way a HAND drives it.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS, AND IT IS NOT "more coverage"
// ---------------------------------------------------------------------------
//
// LINK-10 had NO live leg at all. `74-belt-run-joins.spec.ts` covers the LINK-02 HANDLE
// DRAG and says so in its own header, deferring LINK-10 to the frame-level mock spec
// `e2e/belt-join-press-on-end.spec.ts`. That mock passes. The gesture does not work.
//
// THE THING EVERY EXISTING LINK-10 ARTEFACT SHARES THAT A HAND DOES NOT: it teleports a
// WHOLE CELL per pointer move. `e2e/belt-join-press-on-end.spec.ts:120-127` presses the
// belt head's tile centre and then moves straight to the centre of the next cell but one.
// A real mouse emits several samples crossing a 32-world-px tile, and the FIRST of them
// is still inside the tile the press landed in. No fixture in this repository had ever
// produced that sample, so nothing could see what it does.
//
// ---------------------------------------------------------------------------
// WHAT THAT ONE SAMPLE DOES, MEASURED ON THE REAL HOST 2026-09-09
// ---------------------------------------------------------------------------
//
//   1. The press hits the belt-end nub, which WAS (until phase 74.1, see below)
//      hit-tested AND ringed at the END TILE CENTRE (`gestures.ts` nubsInRadius belt-end
//      arm; `dockTargetPoints` centre()). The draw seeds ONE CELL FURTHER OUT, at the
//      head's FACING cell (`gestures.ts:2094`). Preview: build-blue, one tile.
//   2. The first sub-cell pointer sample is still inside the PRESSED tile. The
//      accumulator (`gestures.ts:2392-2397`) admits any cell orthogonally adjacent to the
//      last one, with no unvisited, unoccupied or forward-of-seed guard - so it appends
//      the pressed belt's OWN tile, BACKWARDS. That tile is occupied, so `evalBeltPath`
//      finds an overlap and the preview turns red.
//   3. The next sample crosses into the seed cell, which is appended as a DUPLICATE of
//      `drawnCells[0]`. `route()` answers SelfCrossing, `evalBeltPath` calls
//      `showBeltPreview([], false)`, and `overlay.ts:531-533` returns early on an empty
//      tile list - so it paints NOTHING. The duplicate never leaves the array, so every
//      later sample crosses too and the preview never returns.
//   4. The release gate is `if (cells && evalBeltPath(cells))` (`gestures.ts:2773`),
//      which is now false. NO DrawBelt. NO Dock. No belt, no message, no flash.
//
// THE CRITERION THIS BREAKS IS SC1, and the citation is corrected here rather than
// repeated. This header and the original commit message both cited "Phase 74's SC5,
// no silently inert gesture". SC5 is the save-and-reload criterion (`ROADMAP.md`, phase
// 74 criterion 5) and has nothing to do with this gesture, and "no silently inert
// gesture" is not a phase-74 criterion at all - it is v8.0 prose. SC1 is the one:
// "a user joins two belts by gesture - dragging a selected belt's end handle onto the
// other belt's end nub, OR PRESSING ON AN EXISTING BELT'S END WITH THE BELT TOOL AND
// DRAWING A NEW ONE FROM THERE - and the two read as ONE RUN on the real binary". This
// file drives the second clause of that sentence, which is also step 1 of `74-WALK.md`
// and leg 2 of the done-test.
//
// FIXED by plan 74-13: one condition in `onWinMove`'s accumulator declines to append a
// cell belonging to the node the press docked to while the drawn path is still only its
// seed, and `overlay.showBeltPreview` retains the last drawable shape so the typed
// reject at step 3 above paints red instead of nothing.
//
// MOVED by phase 74.1 (plan 74.1-01, D-04): the ring is no longer on the head's own tile.
// With the Belt tool armed, a free head is ringed and pressed on its DOORSTEP, the empty
// floor tile it faces, (8,6) on this board, and the press resolves BY CELL there
// (`doorstepPressHit`), so the cell pressed IS the seed cell. That deleted the 74-13
// accumulator condition (branch (c)), and it moved this file's press point from the head
// tile (7,6) to the doorstep (8,6). A press on (7,6) is now an ordinary press on an
// occupied tile: red, nothing sent (UI-SPEC 3.2 item 1). The sub-cell sample below now
// lands a quarter cell east of the doorstep centre, which is still inside the seed cell.
//
// ---------------------------------------------------------------------------
// THE TWO CASES BELOW ARE A DISCRIMINATOR, NOT A PAIR OF SAMPLES
// ---------------------------------------------------------------------------
//
// Both press the same point on the same board and finish at the same cell. The ONLY
// difference is whether one sub-cell sample is emitted after the press. The teleporting
// case is expected GREEN and is what makes a red hand-drag case mean "the sub-cell sample
// broke it" rather than "the harness, the board or the gesture is broken". Neither case
// may be deleted without the other losing its meaning.
//
// NON-VACUITY. Both cases assert the MODEL first - both belts' `docks` naming each other,
// read off the render packet - before anything about paint or health, because
// `tick.rs:1586` makes a silently-failed join indistinguishable from a working one by any
// count or timing read. A build that minted the belt and skipped the Dock satisfies every
// other observable on this board and fails HERE.

/** The belt the user draws first: four cells east on bare floor. Head is (7,6). */
const FIRST_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** The head tile of that belt. The junction is read here; it is NOT pressed (74.1, D-04). */
const HEAD_CELL: readonly [number, number] = [7, 6];
/**
 * The head's doorstep: the empty floor tile it faces, where the Belt-armed ring sits and
 * the press lands. It is also the seed cell, so the second run's tail lands here.
 */
const DOORSTEP_CELL: readonly [number, number] = [8, 6];
/** Where the second run is drawn to, from the doorstep. */
const SECOND_END: readonly [number, number] = [11, 6];

/**
 * A quarter of a cell. Half a cell is the distance from the pressed tile's centre to its
 * edge, so a quarter is unambiguously INSIDE the pressed tile (the doorstep, which is the
 * seed cell) at camera scale 1 - which
 * `resetZoomToActualSize` pins and the assertion below re-reads rather than assumes.
 */
const SUB_CELL_PX = CELL / 4;

function beltAt(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/**
 * The junction read from BOTH SIDES and resolved BY CELL, the shape
 * `74-belt-run-joins.spec.ts` uses and for the same reason: a keyframe remints handles,
 * so a remembered id is not a stable identity across this gesture. `'1/1'` is joined,
 * `'0/0'` is two abutting runs, `'MISSING'` is fewer than two belts.
 */
function junction(scene: SceneFacts): string {
  const up = beltAt(scene, HEAD_CELL);
  const down = beltAt(scene, DOORSTEP_CELL);
  if (!up || !down || up.id === down.id) return 'MISSING';
  const a = (up.docks ?? []).filter((d) => d.end === 'Head' && d.node === down.id).length;
  const b = (down.docks ?? []).filter((d) => d.end === 'Tail' && d.node === up.id).length;
  return `${a}/${b}`;
}

/** Draw the first belt with the Belt tool, cell centre to cell centre on bare floor. */
async function drawFirstBelt(page: Page): Promise<void> {
  await page.getByTitle(/^Draw belts/).click();
  const start = await screenCellCentre(page, FIRST_CELLS[0][0], FIRST_CELLS[0][1]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of FIRST_CELLS.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await page.mouse.move(pt.x, pt.y);
  }
  await page.mouse.up();
  await pollScene(page, (s) => s.belts.length, {
    message: 'the real host folded the first DrawBelt (one belt on an otherwise empty board)',
  }).toBe(1);
}

/**
 * Build the board and leave the Belt tool ARMED, which is what LINK-10 needs: the tool
 * stays in hand across draws (the Help panel's own words are "With the Belt tool, press
 * just past a belt end and draw on": the press lands on the head's doorstep, the floor tile
 * past the end, never on the end tile itself).
 */
async function boardWithOneBelt(page: Page): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  // The sub-cell offset below is expressed in WORLD px and applied to a SCREEN point, so
  // the two must be the same unit. Read it rather than trusting the reset.
  expect(
    (await cameraOf(page)).scale,
    'the camera is at scale 1, so one world px is one screen px and SUB_CELL_PX is exact',
  ).toBe(1);
  await drawFirstBelt(page);
  const only = await readScene(page);
  expect(only.belts, 'exactly one belt, on a board holding NO machine at all').toHaveLength(1);
  expect(
    (only.belts[0].docks ?? []),
    'the lone belt starts undocked, so any dock below is the one THIS gesture made',
  ).toHaveLength(0);
}

/**
 * The gesture under test. Presses the ring on the belt's free head, which sits on the
 * head's doorstep (8,6), and draws east to `SECOND_END`. `subCellSample` decides whether
 * ONE pointer sample is emitted while the cursor is still inside the pressed tile - which
 * is the whole experiment.
 */
async function pressEndAndDrawOn(page: Page, subCellSample: boolean): Promise<void> {
  const door = await screenCellCentre(page, DOORSTEP_CELL[0], DOORSTEP_CELL[1]);
  await page.mouse.move(door.x, door.y);
  await page.mouse.down();
  if (subCellSample) {
    // Still inside the pressed tile, the seed cell: a quarter cell east of its centre.
    await page.mouse.move(door.x + SUB_CELL_PX, door.y);
  }
  for (let cx = DOORSTEP_CELL[0] + 1; cx <= SECOND_END[0]; cx++) {
    const pt = await screenCellCentre(page, cx, 6);
    await page.mouse.move(pt.x, pt.y);
  }
  await page.mouse.up();
}

test.describe.configure({ mode: 'serial' });

test.describe('LINK-10 on the real host: press a free belt end and draw on', () => {
  test('THE DISCRIMINATOR: with cell-teleporting moves the join lands (this is what the mock spec drives)', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);

    await pressEndAndDrawOn(page, false);

    await pollScene(page, (s) => s.belts.length, {
      message: 'a cell-teleporting press-on-end mints the SECOND belt',
    }).toBe(2);
    await pollScene(page, junction, {
      message:
        'a cell-teleporting press-on-end joins the two runs in ONE gesture: both belts\' docks ' +
        'name each other. This case exists to prove the board, the harness and the gesture are ' +
        'otherwise sound, so a red hand-drag case below means the sub-cell sample and nothing else.',
    }).toBe('1/1');

    await expectRenderLoopAlive(page, 'after a teleporting press-on-end join');
    errs.assertNone('the teleporting LINK-10 leg');
  });

  test('THE GESTURE AS A HAND DRIVES IT: one sub-cell sample after the press must not break the draw', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await boardWithOneBelt(page);

    await pressEndAndDrawOn(page, true);

    // THE MODEL FIRST, ALWAYS. A build that mints the belt and drops the Dock passes every
    // other observable on this board.
    await pollScene(page, (s) => s.belts.length, {
      message:
        'a hand-driven press-on-end mints the SECOND belt. The press lands on the head\'s ' +
        'doorstep (8,6), which is the seed cell, and the first sub-cell sample stays inside ' +
        'it, so the walk must append nothing until the pointer crosses into (9,6). Before ' +
        'plan 74-13 this sample appended the pressed belt\'s own tile backwards and the ' +
        'release emitted nothing at all; a regression to that shape mints no second belt.',
    }).toBe(2);
    await pollScene(page, junction, {
      message:
        'a hand-driven press-on-end joins the two runs in ONE gesture, exactly as the ' +
        'teleporting case above does. LINK-10 is the gesture the Help panel teaches (press just ' +
        'past a belt end and draw on) and the ' +
        'phase-74 walk opens with; it may not depend on the pointer skipping a whole cell.',
    }).toBe('1/1');

    await expectRenderLoopAlive(page, 'after a hand-driven press-on-end join');
    errs.assertNone('the hand-driven LINK-10 leg');
  });
});
