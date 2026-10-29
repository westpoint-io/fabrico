import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  DRAWN_STATE_FRAMES,
  beltEndInstructionsOn,
  clickAt,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  newBoard,
  pollScene,
  readScene,
  resetToDemo,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';

// 74-belt-run-joins.spec.ts (LINK-03 and LINK-09, plan 74-09) - two belt runs
// become ONE on the REAL `dev_render_server`, by a gesture, with zero mocks.
//
// ---------------------------------------------------------------------------
// WHICH GESTURE THIS FILE COVERS, AND WHICH IT DOES NOT
// ---------------------------------------------------------------------------
//
// THE JOIN HERE IS LINK-02, THE HANDLE DRAG: select a belt, grab its Head handle,
// drop it on another belt's Tail. It is the one this file can cover, and the reason
// is structural rather than a preference. LINK-10, the press-on-a-free-end draw,
// mints the second belt AND the link in ONE gesture, so a board built with it has
// no moment at which two SEPARATE belts exist unjoined - and the pre-state below,
// which is what makes this leg prove the join CHANGED something, would have nothing
// to read. LINK-10 is covered at the frame level by
// `frontend/e2e/belt-join-press-on-end.spec.ts` (plan 74-05), which counts the
// `DrawBelt` and the `Dock` it emits; the handle drag has its own frame-level spec
// beside it in `frontend/e2e/belt-join-handle-drag.spec.ts`.
//
// ---------------------------------------------------------------------------
// THE TRAP THIS LEG IS WRITTEN AGAINST, MEASURED AND NOT REASONED
// ---------------------------------------------------------------------------
//
// `crates/fabrico-core/src/tick.rs:1586` documents that a belt with NO DOWNSTREAM
// LINK AT ALL retains its head slot, exactly as a belt whose downstream is full
// does. So an upstream belt whose join SILENTLY FAILED piles up with an identical
// signature to one that is correctly backpressured, and any leg that reads only the
// pile-up passes on a board where nothing joined.
//
// The rule that follows is absolute and the step order in every test below obeys it:
// THE MODEL FACT IS ASSERTED FIRST, ALWAYS. Both belts' `docks` naming each other is
// read before anything about pace, timing or saturation is polled. A reader
// reviewing an edit to this file should watch for exactly one warning sign: a step
// that reaches a timing or count assertion having never read `docks`.
//
// ---------------------------------------------------------------------------
// THE PRE-STATE IS NOT DECORATION EITHER
// ---------------------------------------------------------------------------
//
// Before the drag, each belt is asserted to read `This run is one belt.` in the
// panel's own words and to carry ZERO docks naming the other. Without it the whole
// file would pass on a board that arrived already joined, which would prove nothing
// whatever about the gesture. It is also LINK-04's ADJACENCY EDGE stated as a
// measurement: the two belts ABUT, tile (7,6) against tile (8,6), and abutting is
// demonstrably not joining.
//
// ---------------------------------------------------------------------------
// RENDER HEALTH, ON BOTH SIDES OF EVERY GESTURE
// ---------------------------------------------------------------------------
//
// The live oracle reads `window.__fabrico.scene()`, which is fed by the packet path
// and is completely independent of the Pixi ticker, so a board with a DEAD RENDERER
// satisfies every model assertion in this file. That is this repository's recorded
// blind spot rather than a hypothesis. `watchPageErrors` is installed BEFORE
// `page.goto` (installing it after loses every error raised during load) and
// `expectRenderLoopAlive` is called around every gesture.
//
// ---------------------------------------------------------------------------
// THE PAINT ASSERTION, AND THE MUTATION THAT PROVED IT CAN FAIL
// ---------------------------------------------------------------------------
//
// `beltEndInstructionsOn(id)` counts the geometry instructions that belt's END marks
// currently plot, read straight off the `ends` Graphics. On THIS board it isolates
// the junction collar and nothing else: there is no machine anywhere, so the only
// end mark either belt can draw is the collar, and an undocked end plots nothing at
// all (`belts.ts rebuildEnds`). The leg therefore asserts a NUMBER MOVING in both
// directions - zero before the join, non-zero while joined, back to zero after the
// Disconnect - which no stub and no latch can satisfy.
//
// RECORDED NON-VACUITY MUTATION (run 2026-09-08, plan 74-09 task 1). Replacing the
// `belt-seam` branch of `rebuildEnds` in `frontend/src/render/layers/belts.ts` with
// a bare `continue`, so the collar plots nothing while every dock record stays
// untouched, leaves EVERY `docks` assertion in this file green and reddens the paint
// assertion alone. The exact transcript is in `74-09-SUMMARY.md`.
//
// SECOND RECORDED MUTATION, on the model half. Dropping the `'ports+belt-ends'` scan
// from the dock-drag ranker in `frontend/src/input/gestures.ts` makes the handle drag
// address nothing, so the join silently fails and NO command is emitted. The leg
// reddens on the `docks` poll, BEFORE it reaches the pace poll - which is the
// ordering the trap above demands and the property this file exists to hold.
//
// ---------------------------------------------------------------------------
// HANDLES ARE NOT STABLE ACROSS AN UNDO, SO NOTHING HERE CARRIES ONE ACROSS IT
// ---------------------------------------------------------------------------
//
// MEASURED on the real host while writing this file: an undo arrives as a KEYFRAME,
// `App.tsx` clears the selection on every keyframe by design (a keyframe REMINTS
// HANDLES, and a surviving selection is the wrong-target class T-21-08 closes), and
// the config panel is therefore UNMOUNTED the instant Ctrl+Z lands. Two consequences,
// both honoured below rather than worked around: every junction read resolves its
// belts BY CELL rather than by a remembered id, and the post-undo panel assertion
// re-opens the panel instead of claiming the open one changed under the user.

// ---------------------------------------------------------------------------
// The board. Two ABUTTING belts on row 6, both drawn heading EAST, on floor that
// holds NO MACHINE OF ANY KIND.
//
//   UP:   (4,6) -> (7,6).  Its HEAD is (7,6), outward E.
//   DOWN: (8,6) -> (11,6). Its TAIL is (8,6), outward W.
//
// THE EMPTY BOARD IS LOAD-BEARING, not tidiness. The shipped auto-dock arms a Head
// dock when a plain belt release faces exactly one accepting In port; with no
// machine present there is nothing for it to find, so every dock this file reads can
// only be the belt-to-belt one. It is also what makes the paint probe isolate the
// collar: a belt that also docked a machine would plot a stem and a role cap into
// the same Graphics and the count would stop meaning "the junction is drawn".
//
// The two end tile centres are one CELL apart and their shared edge is the seam.
//
// DRAW ORDER IS LOAD-BEARING SINCE PHASE 74.1: DOWN FIRST, THEN UP. With the Belt tool
// armed, the empty tile in front of a free belt HEAD is that head's doorstep, and a
// press there starts a CONNECTED draw (UI-SPEC 3.2 item 4). Drawn UP first, UP's head
// (7,6) faces (8,6), so the press that starts DOWN lands on UP's doorstep and the two
// runs join at draw time - the 0/0 pre-state below then fails before the gesture this
// file exists to test. Drawn DOWN first, UP's press at (4,6) is the doorstep of
// nothing, and UP's release on (7,6) stays unjoined: the release-time auto-dock offers
// a Head machine In ports only, never a belt Tail.
// ---------------------------------------------------------------------------

const UP_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
const DOWN_CELLS: readonly (readonly [number, number])[] = [
  [8, 6],
  [9, 6],
  [10, 6],
  [11, 6],
];

/** UP's HEAD end tile: where the grab handle sits on a free end. */
const UP_HEAD_CELL: readonly [number, number] = [7, 6];
/** DOWN's TAIL end tile: the drop target of the handle drag. */
const DOWN_TAIL_CELL: readonly [number, number] = [8, 6];

/** A tile of each belt AWAY from the seam, used to click-select without landing on a nub. */
const UP_TILE: readonly [number, number] = [5, 6];
const DOWN_TILE: readonly [number, number] = [10, 6];

/** Floor no belt occupies on this board, for the deselect click. */
const EMPTY_CELL: readonly [number, number] = [4, 10];

/**
 * The two run sentences, TRANSCRIBED rather than imported.
 *
 * The live suite is structurally zero-product-import by design (`oracle.ts`'s header
 * rule), which is the whole of what makes it an independent oracle: a spec that
 * imported `RUN_SINGLE` from `BeltConfigBody.tsx` would stay green through a copy
 * edit that changed what the user reads. Both are pinned by EXACT string equality
 * for the reason `23-belt-pace.spec.ts` pins its refusal sentences: a phase-67
 * mutation dropped a trailing word and stayed green under a `toContain` pin.
 */
const RUN_SINGLE = 'This run is one belt.';
const RUN_TWO = 'This run is 2 belts. Apply sets the pace on all of them.';

/**
 * The slow end of the shipped pace scale. `BeltConfigBody`'s `PACE_STEPS` is
 * `[2, 4, 5, 10, 20]` ticks mapping to 250/125/100/50/25 px per second, so the
 * 25 px/sec segment is the 20-tick step. Transcribed for the reason above.
 */
const SLOW_END_LABEL = '25';
const SLOW_END_TICKS = 20;

/** The composed accessible name of the Disconnect control on a belt's INPUTS row. */
const DISCONNECT_INPUT = 'Disconnect Input - Item';

/** One belt off the model, found by a cell its path occupies. */
function beltAt(
  scene: SceneFacts,
  cell: readonly [number, number],
): SceneFacts['belts'][number] | undefined {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/** How many of `belt`'s docks name `otherId` at `end`. A COUNT, so zero is assertable. */
function docksNaming(
  belt: SceneFacts['belts'][number] | undefined,
  end: 'Head' | 'Tail',
  otherId: number,
): number {
  return (belt?.docks ?? []).filter((d) => d.end === end && d.node === otherId).length;
}

/**
 * THE JUNCTION, read from BOTH SIDES and resolved BY CELL rather than by a remembered
 * handle. Answers `"1/1"` when the two belts name each other, `"0/0"` when neither
 * does, and a mixed string when only one half is present.
 *
 * CELL-DERIVED FOR A MEASURED REASON, not for tidiness. An UNDO arrives as a KEYFRAME,
 * and `App.tsx` clears the selection on every keyframe precisely because a keyframe
 * REMINTS HANDLES (T-21-08). A predicate that carried belt ids captured before the
 * undo would therefore be reading a keyspace the host may already have renumbered, and
 * would be asserting handle stability the protocol does not promise. The tiles do not
 * move, so the cells are the stable identity here.
 */
function junctionFromCells(scene: SceneFacts): string {
  const up = beltAt(scene, UP_HEAD_CELL);
  const down = beltAt(scene, DOWN_TAIL_CELL);
  if (!up || !down || up.id === down.id) return 'MISSING';
  return `${docksNaming(up, 'Head', down.id)}/${docksNaming(down, 'Tail', up.id)}`;
}

/** The UPSTREAM belt's current handle, resolved by cell for the reason above. */
function upstreamIdOf(scene: SceneFacts): number {
  const up = beltAt(scene, UP_HEAD_CELL);
  expect(up, `a belt still covers the upstream head tile (${UP_HEAD_CELL[0]},${UP_HEAD_CELL[1]})`)
    .toBeDefined();
  return (up as SceneFacts['belts'][number]).id;
}

/**
 * Draw ONE belt along an authored cell path on EMPTY FLOOR, with the shipped Belt
 * tool, port-free at both ends.
 *
 * This is deliberately NOT `oracle.ts`'s `drawBeltThroughCells`, which draws nub to
 * nub between two MACHINES. There is no machine on this board at all, which is the
 * property the whole file rests on, so the press seeds at the pressed cell and the
 * release lands on plain floor.
 *
 * Each move steps ONE orthogonally adjacent cell. Since plan 74-14 the accumulator
 * walks the cells a multi-cell sample crossed, so that is a CHOICE about being an
 * exact fixture rather than a requirement it imposes: a longer step would land the
 * same path, and stepping one cell is what lets the callers below assert committed
 * tiles exactly.
 */
async function drawBeltOnFloor(
  page: Page,
  cells: readonly (readonly [number, number])[],
): Promise<void> {
  // Prefix-matched, not exact: the Belt tool title is user-facing COPY that doubles as
  // a SELECTOR, so an exact match makes every copy edit a multi-spec breakage (52-05).
  await page.getByTitle(/^Draw belts/).click();
  const start = await screenCellCentre(page, cells[0][0], cells[0][1]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await page.mouse.move(pt.x, pt.y);
  }
  await page.mouse.up();
  // Disarm, so the next click SELECTS a belt instead of starting another draw. The
  // press landed on the non-focusable canvas, so focus is on <body> and the LW-02
  // button-focus guard does not stand Escape down.
  await page.keyboard.press('Escape');
}

/** Select the belt whose path covers `cell` and settle on its config body mounting. */
async function selectBeltAt(page: Page, cell: readonly [number, number]): Promise<number> {
  const belt = beltAt(await readScene(page), cell);
  expect(belt, `a belt really occupies (${cell[0]},${cell[1]})`).toBeTruthy();
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await clickAt(page, at.x, at.y);
  // The BELT arm of the panel. Its visibility also proves the real host answered
  // `machine_config` for a BELT handle: the loading state renders the placeholder and
  // no body at all.
  await expect(
    page.locator('#fab-belt-config'),
    `clicking (${cell[0]},${cell[1]}) selected a belt, so the panel's Belt arm is open on it`,
  ).toBeVisible({ timeout: 15_000 });
  return (belt as SceneFacts['belts'][number]).id;
}

/**
 * Build the two abutting, UNJOINED belts on an empty board and return their handles.
 *
 * Shared by both tests because the live suite runs `workers: 1` against ONE mutable
 * host: inheriting whatever the previous file left behind would make "on empty floor"
 * a description of intent rather than of the subject.
 */
async function buildTwoAbuttingBelts(page: Page): Promise<{ up: number; down: number }> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await waitForCameraSettle(page);

  // DOWNSTREAM FIRST (see the board block above): drawn the other way round, the
  // second press lands on the first run's head doorstep and joins the runs at draw time.
  await drawBeltOnFloor(page, DOWN_CELLS);
  await pollScene(page, (s) => s.belts.length, {
    message: 'the real host folded the first DrawBelt, the DOWNSTREAM run (one belt on an otherwise empty board)',
  }).toBe(1);

  await drawBeltOnFloor(page, UP_CELLS);
  await pollScene(page, (s) => s.belts.length, {
    message: 'the real host folded the second DrawBelt, the UPSTREAM run (two belts, end to end)',
  }).toBe(2);

  // PHASE 89 (D-06, plan 89-05): a draw whose head ends one cell short of a free belt start,
  // facing it, docks to it as it is drawn (UI-SPEC 3.2), so the UPSTREAM draw joins the runs.
  // The two abutting UNJOINED belts this file needs are reached the way a user reaches them now:
  // that join is read, then taken off from the downstream Inputs row (LINK-09's Disconnect).
  // Without this the pre-state below reads the draw's join and the leg proves nothing.
  await pollScene(page, junctionFromCells, {
    message: 'D-06: the upstream draw, ending one cell short of the downstream start and facing it, joined the runs as it was drawn',
  }).toBe('1/1');
  await selectBeltAt(page, DOWN_TILE);
  await page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: DISCONNECT_INPUT }).click();
  await pollScene(page, junctionFromCells, {
    message: 'the Disconnect took the draw-time join off: neither belt names the other',
  }).toBe('0/0');
  await expect
    .poll(async () => beltEndInstructionsOn(page, upstreamIdOf(await readScene(page))), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'draw-time collar gone poll'),
      intervals: [100, 250, 500],
      message: 'the draw-time junction collar is gone from the upstream belt after the Disconnect',
    })
    .toBe(0);
  // Off the Disconnect button and the selection, so the pre-state below starts from a quiet board.
  await page.locator('#fab-config-heading').click();
  const empty = await screenCellCentre(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await clickAt(page, empty.x, empty.y);
  await expect(page.locator('#fab-belt-config'), 'the floor click closed the belt panel').toHaveCount(0);

  const scene = await readScene(page);
  const up = beltAt(scene, UP_HEAD_CELL);
  const down = beltAt(scene, DOWN_TAIL_CELL);
  expect(up, `a belt covers the upstream head tile (${UP_HEAD_CELL[0]},${UP_HEAD_CELL[1]})`).toBeDefined();
  expect(
    down,
    `a belt covers the downstream tail tile (${DOWN_TAIL_CELL[0]},${DOWN_TAIL_CELL[1]})`,
  ).toBeDefined();
  const upId = (up as SceneFacts['belts'][number]).id;
  const downId = (down as SceneFacts['belts'][number]).id;
  // TWO belts, not one long one. Two separate draws could have produced a single run
  // if the second press had been read as an extension of the first, and every claim
  // below about "two runs becoming one" would then be a claim about one run.
  expect(upId, 'the two draws produced TWO distinct belts, not one').not.toBe(downId);
  // ...and they ABUT: four tiles each, and the two named end tiles are one cell apart.
  expect((up as SceneFacts['belts'][number]).tiles).toHaveLength(UP_CELLS.length);
  expect((down as SceneFacts['belts'][number]).tiles).toHaveLength(DOWN_CELLS.length);
  console.log(`LINK03_BOARD up=${upId} down=${downId}`);
  return { up: upId, down: downId };
}

/**
 * The PRE-STATE, in both instruments. Asserted before every join in this file, so a
 * board that arrived already joined fails HERE rather than passing the whole leg.
 */
async function assertUnjoined(page: Page, up: number, down: number): Promise<void> {
  const scene = await readScene(page);
  const upBelt = scene.belts.find((b) => b.id === up);
  const downBelt = scene.belts.find((b) => b.id === down);
  // LINK-04's EMPTY EDGE: the dock is absent, counted rather than merely "not found".
  expect(
    docksNaming(upBelt, 'Head', down),
    'BEFORE the gesture the upstream belt Head names the downstream belt ZERO times',
  ).toBe(0);
  expect(
    docksNaming(downBelt, 'Tail', up),
    'BEFORE the gesture the downstream belt Tail names the upstream belt ZERO times',
  ).toBe(0);
  // The paint half of the same pre-state. No machine on this board, so a free end
  // plots nothing and both counts are zero; this is the baseline the join must move.
  expect(
    await beltEndInstructionsOn(page, up),
    'BEFORE the gesture the upstream belt plots NO end mark at all',
  ).toBe(0);
  expect(
    await beltEndInstructionsOn(page, down),
    'BEFORE the gesture the downstream belt plots NO end mark at all',
  ).toBe(0);

  // AND THE PANEL'S OWN WORDS, on BOTH belts. Each is a run of ONE, which is what
  // makes the two-belt sentence after the join a change this leg made.
  await selectBeltAt(page, UP_TILE);
  await expect(
    page.locator('#fab-belt-run'),
    'the upstream belt is a run of ONE, in the shipped panel\'s own words',
  ).toHaveText(RUN_SINGLE);
  await selectBeltAt(page, DOWN_TILE);
  await expect(
    page.locator('#fab-belt-run'),
    'the downstream belt is a run of ONE too, so two ABUTTING belts are demonstrably two runs',
  ).toHaveText(RUN_SINGLE);
}

/**
 * THE JOIN GESTURE (LINK-02): select the upstream belt, drag its Head handle onto the
 * downstream belt's Tail end.
 *
 * The belt must be SELECTED first - the endpoint grab handles are painted and hit-
 * tested only on a selected belt - and the press lands on the free Head's grab dot,
 * which sits at the end tile centre.
 */
async function joinByHandleDrag(page: Page): Promise<void> {
  await selectBeltAt(page, UP_TILE);
  const head = await screenCellCentre(page, UP_HEAD_CELL[0], UP_HEAD_CELL[1]);
  const tail = await screenCellCentre(page, DOWN_TAIL_CELL[0], DOWN_TAIL_CELL[1]);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(tail.x, tail.y, { steps: 4 });
  await page.mouse.up();
}

/** THE MODEL FACT, POLLED: both belts' docks name each other. Always read FIRST. */
async function assertJoinedInModel(page: Page, why: string): Promise<void> {
  await pollScene(page, junctionFromCells, {
    message:
      `LINK-03 (${why}): the real host folded the belt-to-belt Dock and BOTH belts' docks name ` +
      'each other - the upstream belt\'s Head names the downstream belt, and the downstream ' +
      'belt\'s Tail names the upstream one. This is read BEFORE anything about pace or timing, ' +
      'because tick.rs:1586 makes a silently-failed join indistinguishable from a working one ' +
      'by any count or timing read.',
  }).toBe('1/1');
  const joined = await readScene(page);
  console.log(`LINK03_DOCKS ${why} ${JSON.stringify(joined.belts.map((b) => ({ id: b.id, docks: b.docks })))}`);
}

test.describe.configure({ mode: 'serial' });

test.describe('LINK-03 on the real host: a gesture makes two belt runs one', () => {
  test('the handle drag joins two abutting belts, the panel says 2 belts, and ONE Apply paces BOTH', async ({
    page,
  }) => {
    // Installed BEFORE goto so a boot-time throw is caught too.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const { up, down } = await buildTwoAbuttingBelts(page);
    await expectRenderLoopAlive(page, 'with two abutting belts drawn, before the join');
    errs.assertNone('after drawing the two belts');

    // -----------------------------------------------------------------------
    // 1. THE PRE-STATE. Two runs, abutting, unjoined, in both instruments.
    // -----------------------------------------------------------------------
    await assertUnjoined(page, up, down);

    // -----------------------------------------------------------------------
    // 2. THE GESTURE, and then THE MODEL FACT FIRST.
    // -----------------------------------------------------------------------
    await joinByHandleDrag(page);
    await assertJoinedInModel(page, 'after the handle drag');

    // -----------------------------------------------------------------------
    // 3. THE PAINT, beside the state and substituting for neither.
    //
    //    `docks` naming each other says the HOST derived the link and the packet
    //    carried it. It says nothing about whether the junction reached the screen,
    //    and a build whose seam branch regressed leaves both dock arrays completely
    //    untouched. Scoped to the UPSTREAM belt because the ownership rule puts the
    //    collar on the `Out`-role end, and asserted as ZERO on the downstream belt so
    //    a build drawing two collars a whole cell apart fails here.
    // -----------------------------------------------------------------------
    await expect
      .poll(async () => beltEndInstructionsOn(page, up), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'junction collar plotted poll'),
        intervals: [100, 250, 500],
        message:
          'the junction COLLAR is plotted on the upstream belt at the seam. Its own end mark ' +
          'was zero before the drag and there is no machine on this board, so this number is ' +
          'the collar and nothing else',
      })
      .toBeGreaterThan(0);
    expect(
      await beltEndInstructionsOn(page, down),
      'and the DOWNSTREAM belt still plots nothing: one junction draws ONE collar, owned by ' +
        'the upstream Head. A build without the ownership rule draws two, a whole cell apart',
    ).toBe(0);
    await expectRenderLoopAlive(page, 'with the junction joined and drawn');
    errs.assertNone('through the join gesture');

    // -----------------------------------------------------------------------
    // 4. THE PANEL'S OWN SENTENCE, read from the DOWNSTREAM belt.
    //
    //    Read from the other side on purpose: the run is a property of the whole
    //    chain, so the belt that was NOT the drag's subject must report it too.
    // -----------------------------------------------------------------------
    await selectBeltAt(page, DOWN_TILE);
    await expect(
      page.locator('#fab-belt-run'),
      'the joined pair reads as ONE RUN OF TWO in the shipped panel, by exact string',
    ).toHaveText(RUN_TWO);

    // -----------------------------------------------------------------------
    // 5. ONE APPLY PACES BOTH BELTS.
    //
    //    VACUITY REFUSAL first, the shape `23-belt-pace.spec.ts` uses: neither belt
    //    may already hold the pace about to be pressed, or the poll below would
    //    resolve on the first read against a host that did nothing.
    // -----------------------------------------------------------------------
    const beforePace = await readScene(page);
    for (const id of [up, down]) {
      expect(
        beforePace.belts.find((b) => b.id === id)?.ticksPerSlot,
        `belt ${id} must NOT already sit at ${SLOW_END_TICKS} ticks per slot, or the poll proves nothing`,
      ).not.toBe(SLOW_END_TICKS);
    }
    await page
      .getByRole('group', { name: 'Belt pace' })
      .getByRole('button', { name: `${SLOW_END_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    // POLLED, NEVER SAMPLED ONCE. WINDOWS 144 records the pace field lagging a segment
    // press by more than one captured frame, so a single read is both a flake
    // generator and a wrong reading. Both belts are polled in ONE predicate, so the
    // assertion is "the run was paced" rather than two separate "a belt was paced".
    await pollScene(
      page,
      (s) =>
        [up, down]
          .map((id) => `${id}:${s.belts.find((b) => b.id === id)?.ticksPerSlot}`)
          .join(' '),
      {
        message:
          `ONE Apply on the joined run set ${SLOW_END_TICKS} ticks per slot on BOTH belts, in ` +
          'the MODEL, off the render packet. A build that paced only the panel\'s own subject ' +
          'satisfies half of this string and fails',
      },
    ).toBe(`${up}:${SLOW_END_TICKS} ${down}:${SLOW_END_TICKS}`);

    await expectRenderLoopAlive(page, 'after one Apply paced the whole run');
    errs.assertNone('the whole of the LINK-03 leg');
  });
});

test.describe('LINK-09 on the real host: Disconnect puts the run back to two, and Ctrl+Z brings it back', () => {
  test('Disconnect unmakes the junction from the downstream Inputs row, and one Ctrl+Z restores it', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // The board is rebuilt rather than inherited from the test above: the live suite
    // shares ONE mutable host, and a leg that depended on a sibling's leftovers would
    // be untrue the moment either is run alone.
    const { up, down } = await buildTwoAbuttingBelts(page);
    await assertUnjoined(page, up, down);
    await joinByHandleDrag(page);
    // THE MODEL FACT FIRST, again. There is nothing to disconnect unless the junction
    // demonstrably exists, and a Disconnect pressed on a board that never joined would
    // be asserting the absence of something that was never present.
    await assertJoinedInModel(page, 'before the Disconnect');
    await expectRenderLoopAlive(page, 'with the junction joined, before the Disconnect');
    errs.assertNone('after the join');

    // -----------------------------------------------------------------------
    // 1. THE DOWNSTREAM PANEL, and the control LINK-06's refusal sentence names.
    //
    //    Pressed from the DOWNSTREAM side: on this belt the Tail is joined and the
    //    Head is free, so exactly one Disconnect renders and it is on the Inputs row.
    //    That is also the side whose upstream is a BELT and is unambiguous, which is
    //    the only case 74-07 offers the control on an Inputs row at all.
    // -----------------------------------------------------------------------
    await selectBeltAt(page, DOWN_TILE);
    await expect(
      page.locator('#fab-belt-run'),
      'the panel is open on the JOINED run before anything is pressed',
    ).toHaveText(RUN_TWO);
    const ports = page.getByRole('region', { name: 'Ports' });
    await expect(ports, 'the belt panel renders a Ports section (74-07)').toBeVisible();
    await expect(
      ports.getByRole('button', { name: /^Disconnect/ }),
      'exactly ONE Disconnect renders on this belt: its Tail is joined and its Head is free',
    ).toHaveCount(1);
    await ports.getByRole('button', { name: DISCONNECT_INPUT }).click();

    // -----------------------------------------------------------------------
    // 2. THE MODEL FIRST AGAIN: the docks stop naming each other.
    // -----------------------------------------------------------------------
    await pollScene(page, junctionFromCells, {
      message:
        'LINK-09: the Disconnect took the junction off the board - NEITHER belt names the ' +
        'other any more, read from both sides so a half-removed link cannot pass',
    }).toBe('0/0');
    // ...and the collar goes with it. The number moves BACK to zero, which is the half
    // of the paint claim a boolean probe could not express.
    await expect
      .poll(async () => beltEndInstructionsOn(page, upstreamIdOf(await readScene(page))), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'junction collar gone poll'),
        intervals: [100, 250, 500],
        message: 'the junction collar is GONE from the upstream belt after the Disconnect',
      })
      .toBe(0);
    // ...and the panel says so, in the shipped words, by exact string.
    await expect(
      page.locator('#fab-belt-run'),
      'the downstream belt is a run of ONE again, in the panel\'s own words',
    ).toHaveText(RUN_SINGLE);
    await expectRenderLoopAlive(page, 'after the Disconnect');
    errs.assertNone('through the Disconnect');

    // -----------------------------------------------------------------------
    // 3. ONE CTRL+Z BRINGS THE JUNCTION BACK.
    //
    //    MOVE FOCUS OFF THE BUTTON FIRST, and this is not tidying (28-undo-restores-
    //    the-cable's measured lesson): the app-wide LW-02 guard stands the canvas
    //    keybindings DOWN - Ctrl+Z included - while a BUTTON holds focus, and the
    //    Disconnect click leaves focus exactly there. Clicking the panel heading is a
    //    plain click on a non-focusable element the panel absorbs, so the SELECTION
    //    survives it.
    //
    //    The refusal region is LATCHED across the whole window: an undo the host
    //    refused in words would otherwise pass every assertion below on a build where
    //    the sentence had already timed out.
    // -----------------------------------------------------------------------
    await page.locator('#fab-config-heading').click();
    await expectRefusalStayedSilent(page, 'Ctrl+Z after a belt Disconnect', async () => {
      await page.keyboard.press('Control+z');
      await pollScene(page, junctionFromCells, {
        message: 'one Ctrl+Z put the belt-to-belt junction back, named from both sides',
      }).toBe('1/1');
    });
    // ...and the collar is drawn again. Resolved by CELL: the undo arrived as a
    // keyframe, which remints handles.
    await expect
      .poll(async () => beltEndInstructionsOn(page, upstreamIdOf(await readScene(page))), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'junction collar back poll'),
        intervals: [100, 250, 500],
        message: 'and the junction collar is drawn again after the undo',
      })
      .toBeGreaterThan(0);

    // -----------------------------------------------------------------------
    // 4. THE PANEL, RE-OPENED, SAYS TWO BELTS AGAIN.
    //
    //    THE RE-SELECT IS NOT A WORKAROUND AND IT IS NOT OPTIONAL, and this is
    //    MEASURED on the real host rather than assumed. An undo arrives as a KEYFRAME,
    //    and `App.tsx` clears the selection on EVERY keyframe by design, because a
    //    keyframe REMINTS HANDLES and a surviving selection would be the wrong-target
    //    class T-21-08 closes. So the config panel is UNMOUNTED the moment Ctrl+Z
    //    lands - `#fab-config-heading` counts 0 - and a spec asserting that the open
    //    panel's sentence changed under it would be asserting panel persistence this
    //    app deliberately does not have.
    //
    //    What the user actually gets, and what is asserted here, is: press undo, click
    //    the belt again, and the panel says the run is two belts once more.
    // -----------------------------------------------------------------------
    await expect(
      page.locator('#fab-config-heading'),
      'the undo keyframe cleared the selection, so the panel is closed (shipped, T-21-08)',
    ).toHaveCount(0);
    await selectBeltAt(page, DOWN_TILE);
    await expect(
      page.locator('#fab-belt-run'),
      'and re-opening the panel after the undo reads the 2-belt sentence again, by exact string',
    ).toHaveText(RUN_TWO);

    await expectRenderLoopAlive(page, 'after the undo restored the junction');
    errs.assertNone('the whole of the LINK-09 leg');

    // Leave the shared host on a board no later spec has to reason about.
    const at = await screenCellCentre(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await clickAt(page, at.x, at.y);
  });
});
