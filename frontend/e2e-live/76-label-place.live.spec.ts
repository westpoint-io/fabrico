import { test, expect, type Page } from '@playwright/test';
import {
  cameraOf,
  captureRefusalText,
  CELL,
  expectRenderLoopAlive,
  latchRejectFlashCells,
  handPlaceAt,
  labelBoxOn,
  newBoard,
  pollScene,
  readScene,
  rejectFlashCell,
  rejectFlashCellsSeen,
  stopRejectFlashLatch,
  resetZoomToActualSize,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
} from './support/oracle';

// 76-label-place.live.spec.ts (plan 76-01, SHAPE-10, D-01, D-09) - a Label is placed from
// the palette by hand and the board draws its box, on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected packets. The
// spec reads only the oracle (`window.__fabrico.scene()`), the paint probe
// (`window.__fabrico.labelBoxOn`) and the DOM.
//
// ---------------------------------------------------------------------------
// THE RULINGS
// ---------------------------------------------------------------------------
//
// D-01 (2026-10-06, "Takes its cells"): a label occupies the floor cells
// it covers, exactly like a machine. A belt dragged across it is refused, machines and
// other labels cannot be placed on it, labels never overlap.
//
// D-09: the palette row is "Label", in its own group under the Wire tool.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE TRACER. On an empty board at zoom 1, the `Place Label` row is clicked by its
//      accessible name and the pointer travels by hand to a point a few screen px off the
//      centre of cell (10,12), then presses. The host mints ONE node of kind 11 whose
//      cells are exactly (10,12) (11,12) (12,12) (13,12) and whose ports are empty, and
//      the paint probe reads, off the `label-box` Graphics' own instructions, a rectangle
//      inset 4 world px from that cell rect, filled Sand `#e0d388` at alpha 0.16 and
//      outlined in Sand 2 world px wide.
//   2. D-01 BY HAND. On an empty board at zoom 1, a Source at (6,10) and a label at
//      (9,10), both placed by hand. The Belt tool is armed, the pointer presses a few px off
//      the centre of the Source's doorstep (7,10) and walks east in moves of at most 6 px,
//      wobbling a few px off the row on the way, through (8,10) and on across the label's
//      cells (9,10) (10,10) (11,10) (12,10), and releases two cells past the label at
//      (14,10). The scene's belt count is unchanged after release, and since phase 89 (plan
//      89-09, D-12, D-13, FAIL-02) the release is SENT and refused: the reject flash the
//      overlay PLOTTED (`rejectFlashCell`, latched on every frame) is ONE cell, the first label
//      cell (9,10), and `#fab-refusal` reads the collision sentence. Until 89-09 the belt tool
//      sent nothing for a path that crossed an occupied cell, and the user saw no reason.
//   3. U-4 and U-6. After one hand-placed label the `Place Label` row is no longer pressed
//      (the tool let go by itself), the side panel is open with the heading `Label` and no
//      Ports section anywhere in the DOM, and a second click on another empty cell places
//      nothing.
//
// Every leg watches page errors from before `goto` and asserts the render loop is alive
// on both sides of each gesture (memory fabrico-model-oracle-blindspot).
//
// MUTATIONS (2026-10-07, each in a throwaway worktree, reverted):
//   leg 1: the label box plotted with no fill reddens "one fill and one stroke, Expected: 2,
//          Received: 1" - the probe reads the plot, not the model.
//   leg 2: labels treated as free floor by BOTH the host DrawBelt check and the client
//          `cellOccupied` reddens "no belt landed across the label, Expected: 0, Received: 1".
//   leg 3: the label-echo disarm removed reddens the `aria-pressed` assertion,
//          "Expected: "false", Received: "true"".

/** The label kind byte (protocol `machine_kind::LABEL`). Written as a number on purpose:
 *  the live suite imports no product source. */
const KIND_LABEL = 11;
/** One cell in world px (`shared/geometry.ts` CELL). */
const CELL_PX = 32;
/** Sand, label colour byte 0 (UI-SPEC 3.1). */
const SAND = 0xe0d388;

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

test.describe('SHAPE-10 live: a Label placed from the palette is a real node with a drawn box', () => {
  test('leg 1: a hand places a Label and the board draws its sand box', async ({ page }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    const before = (await readScene(page)).nodes.length;
    await handPlaceAt(page, 'Label', 10, 12);
    await pollScene(page, (s) => s.nodes.some((n) => n.kind === KIND_LABEL), {
      message: 'the real host echoed a node of kind 11 (a Label)',
    }).toBe(true);
    await expectRenderLoopAlive(page, 'after the label is placed');

    const scene = await readScene(page);
    expect(scene.nodes.length, 'exactly one node was added').toBe(before + 1);
    const labels = scene.nodes.filter((n) => n.kind === KIND_LABEL);
    expect(labels.length, 'exactly one label').toBe(1);
    const label = labels[0];
    const cells = [...label.cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(cells, 'the label takes exactly its four cells').toEqual([
      [10, 12],
      [11, 12],
      [12, 12],
      [13, 12],
    ]);
    expect(label.ports, 'a label has no ports').toEqual([]);

    // The box, read back off what was PLOTTED. Polled, because the box is drawn on the
    // next frame after the packet lands.
    await expect
      .poll(async () => (await labelBoxOn(page, label.id))?.rect ?? null, {
        message: 'the label-box Graphics plotted its rectangle',
      })
      .toEqual({ x: 10 * CELL_PX + 4, y: 12 * CELL_PX + 4, w: 4 * CELL_PX - 8, h: CELL_PX - 8 });
    const box = await labelBoxOn(page, label.id);
    expect(box, 'the label-box probe answered').not.toBeNull();
    expect(box!.instructions, 'one fill and one stroke').toBe(2);
    expect(box!.fill, 'filled Sand at alpha 0.16').toEqual({ color: SAND, alpha: 0.16 });
    expect(box!.stroke, 'outlined Sand at alpha 1, 2 world px').toEqual({
      color: SAND,
      alpha: 1,
      width: 2,
    });

    errs.assertNone('placing a label');
  });

  test('leg 2: a belt dragged by hand across a label lands nothing, flashes the first label cell and says why', async ({ page }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the board is built');

    // The Source, placed by hand; its tool stays armed after a placement, so put it down.
    await handPlaceAt(page, 'Source', 6, 10);
    await pollScene(page, (s) => s.nodes.some((n) => n.kind === 0), {
      message: 'the real host echoed the Source',
    }).toBe(true);
    await page.keyboard.press('Escape');
    // The label, placed by hand; its tool lets go by itself.
    await handPlaceAt(page, 'Label', 9, 10);
    await pollScene(page, (s) => s.nodes.some((n) => n.kind === KIND_LABEL), {
      message: 'the real host echoed the label',
    }).toBe(true);
    const label = (await readScene(page)).nodes.find((n) => n.kind === KIND_LABEL)!;
    expect([...label.cells].sort((a, b) => a[0] - b[0])).toEqual([
      [9, 10],
      [10, 10],
      [11, 10],
      [12, 10],
    ]);
    await expectRenderLoopAlive(page, 'after the Source and the label are placed');
    const beltsBefore = (await readScene(page)).belts.length;

    // The belt, by hand: press a few px off the doorstep centre, walk east in steps of at
    // most 6 px with a small wobble off the row, release two cells past the label.
    await page.getByTitle(/^Draw belts/).click();
    const start = await screenCellCentre(page, 7, 10);
    const end = await screenCellCentre(page, 14, 10);
    let x = start.x + 3;
    let y = start.y - 2;
    expect(await rejectFlashCell(page), 'no reject flash is plotted before the press').toBeNull();
    await latchRejectFlashCells(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    let step = 0;
    while (end.x - x > 0.5) {
      x = Math.min(end.x, x + 6);
      // A wobble of up to 3 px either side of the row, never leaving it.
      y = start.y + [-2, 1, 3, 0, -3, 2][step % 6];
      step += 1;
      await page.mouse.move(x, y);
      await page.waitForTimeout(8);
    }
    expect(step, 'the walk crossed the board in many sub-cell moves').toBeGreaterThan((14 - 7) * (CELL / 6) - 1);
    await page.mouse.up();
    await page.keyboard.press('Escape');

    // WHERE and WHY (plan 89-09): one flash on the first label cell the drag crossed, and the
    // host's sentence for the refused DrawBelt. The sentence is a literal, so a copy edit is seen.
    expect(
      await captureRefusalText(page, 'the release across the label was answered'),
      'the host says the space is taken',
    ).toBe('That space is taken. Clear it or try elsewhere.');
    expect(await rejectFlashCellsSeen(page), 'ONE flash, on the first label cell crossed').toEqual([{ cx: 9, cy: 10 }]);
    await stopRejectFlashLatch(page);

    // Nothing landed: the belt count is unchanged. Polled over a window so a late echo would
    // be seen.
    await page.waitForTimeout(600);
    const after = await readScene(page);
    expect(after.belts.length, 'no belt landed across the label').toBe(beltsBefore);
    expect(
      after.nodes.find((n) => n.id === label.id)?.cells.length,
      'the label still holds its four cells',
    ).toBe(4);
    await expectRenderLoopAlive(page, 'after the belt drag across the label');
    errs.assertNone('dragging a belt across a label');
  });

  test('leg 3: the Label tool lets go after one placement and opens its panel with no Ports', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    const row = page.getByRole('button', { name: 'Place Label', exact: true });
    await handPlaceAt(page, 'Label', 10, 12);
    await pollScene(page, (s) => s.nodes.some((n) => n.kind === KIND_LABEL), {
      message: 'the real host echoed the label',
    }).toBe(true);
    await expectRenderLoopAlive(page, 'after the label is placed');

    // The tool let go by itself (U-4): the palette row is no longer pressed.
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    // The new label is selected and its panel is open on `Label` (U-6), with no Ports
    // section anywhere in the DOM.
    const heading = page.locator('#fab-config-heading');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText('Label');
    await expect(page.locator('section[aria-label="Ports"]')).toHaveCount(0);

    // A second click on another empty cell places nothing: the tool is down.
    const nodesBefore = (await readScene(page)).nodes.length;
    const other = await screenCellCentre(page, 10, 16);
    await page.mouse.move(other.x + 4, other.y - 3);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(600);
    expect((await readScene(page)).nodes.length, 'the second click placed nothing').toBe(nodesBefore);
    await expectRenderLoopAlive(page, 'after the second click');
    errs.assertNone('placing one label and clicking again');
  });
});
