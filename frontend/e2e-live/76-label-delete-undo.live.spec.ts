import { test, expect, type Page } from '@playwright/test';
import {
  cameraOf,
  expectRenderLoopAlive,
  handPlaceAt,
  labelBoxOn,
  labelWordsOf,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 76-label-delete-undo.live.spec.ts (plan 76-05, D-08, SHAPE-12) - a user deletes a label
// they configured, presses Ctrl+Z, and gets that exact label back: its words, its colour
// and its size, on the REAL host (dev_render_server, real Core -> RenderProducer ->
// postcard -> WS). Zero mocks, zero injected packets. The spec reads the oracle
// (`window.__fabrico.scene()`, the MODEL), the words overlay in the DOM and the canvas
// read-back probe (`labelBoxOn`), because a model read alone passes over a board that
// draws the old box or no words (memory fabrico-model-oracle-blindspot).
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-08 (default): Delete then Ctrl+Z brings the label back with its text, colour and size,
// through the non-serialized capture pattern (command.rs:3046-3053), no EDIT bump.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE TRACER. On an empty board at zoom 1 a Label is placed by hand at (10,12). The
//      keyboard types `Order intake` straight into the focused Text field, `Lilac` is
//      clicked, `Increase width` twice and `Increase depth` once, `Apply`. The label is
//      selected by a plain click OFF-CENTRE on its box (cell (13,13), not the anchor), and
//      the Delete key is pressed: the scene holds no kind-11 node and no words element is
//      on the page. A click on empty floor (so the shipped editable-focus guard does not
//      swallow the key), then Ctrl+Z: the scene holds ONE kind-11 node anchored at (10,12)
//      on exactly the 12 cells x 10 to 15, y 12 to 13, `label.text` `Order intake` and
//      `label.colour` 3 (Lilac); the words element for that node reads `Order intake` and
//      is visible; the canvas probe reads a Lilac 6 by 2 box.
//
// The leg watches page errors from before `goto` and asserts the render loop is alive on
// both sides of each gesture.
//
// RED AT THE START REVISION (tree equal to the gated revision), recorded in
// 76-05-SUMMARY.md: after the Ctrl+Z the host held the 6 by 2 box at (10,12) with
// `label` `{ text: '', colour: 0 }` (Sand, no words), so no words element was drawn.

/** The label kind byte (protocol `machine_kind::LABEL`). A number on purpose: the live
 *  suite imports no product source. */
const KIND_LABEL = 11;
/** One cell in world px (`shared/geometry.ts` CELL). */
const CELL_PX = 32;
/** The box's centreline inset from the cell edges, world px (UI-SPEC terms, the chassis). */
const BOX_INSET = 4;
/** Lilac, label colour byte 3 (UI-SPEC 3.1), as the integer the probe reads. */
const LILAC = 0xbea2ea;
const LILAC_BYTE = 3;
/** The words the label carries. */
const WORDS = 'Order intake';

/** The 12 cells of a 6 by 2 label anchored at (10,12), by literal, row-major. */
const SIX_BY_TWO_AT_10_12 = [
  '10,12', '11,12', '12,12', '13,12', '14,12', '15,12',
  '10,13', '11,13', '12,13', '13,13', '14,13', '15,13',
];

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

/** Every kind-11 node in the scene. */
function labelsIn(scene: SceneFacts): SceneFacts['nodes'] {
  return scene.nodes.filter((n) => n.kind === KIND_LABEL);
}

/** A node's cells, sorted row-major, as `x,y` strings, so a literal list compares. */
function sortedCells(node: SceneFacts['nodes'][number]): string[] {
  return [...node.cells]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([x, y]) => `${x},${y}`);
}

/** Click a panel button by its accessible name. */
async function press(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

/** Click empty floor a few px off a cell centre (blurs the panel, clears the selection). */
async function clickFloor(page: Page): Promise<void> {
  const floor = await screenCellCentre(page, 4, 6);
  await page.mouse.click(floor.x + 3, floor.y - 2);
}

/** The canvas probe for label `id` reads a Lilac 6 by 2 box at (10,12). */
async function expectLilacSixByTwo(page: Page, id: number): Promise<void> {
  await expect
    .poll(async () => labelBoxOn(page, id), {
      message: `the label-box Graphics of label ${id} plotted a Lilac 6 by 2 box at (10,12)`,
    })
    .toMatchObject({
      instructions: 2,
      fill: { color: LILAC, alpha: 0.16 },
      stroke: { color: LILAC, alpha: 1 },
      rect: {
        x: 10 * CELL_PX + BOX_INSET,
        y: 12 * CELL_PX + BOX_INSET,
        w: 6 * CELL_PX - 2 * BOX_INSET,
        h: 2 * CELL_PX - 2 * BOX_INSET,
      },
    });
}

test.describe('D-08 live: Delete then Ctrl+Z brings a label back whole', () => {
  test('leg 1: a Lilac 6 by 2 label reading Order intake, deleted and undone, comes back exactly', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    // Place and configure through the panel, one Apply.
    await handPlaceAt(page, 'Label', 10, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.kind ?? null, {
      message: 'the real host echoed a label anchored at (10,12)',
    }).toBe(KIND_LABEL);
    await expectRenderLoopAlive(page, 'after the label is placed');
    await expect(page.locator('#fab-label-text'), 'the placed label focuses its Text field').toBeFocused();
    await page.keyboard.type(WORDS);
    await page.getByRole('button', { name: 'Lilac', exact: true }).click();
    const wider = page.getByRole('button', { name: 'Increase width', exact: true });
    await wider.click();
    await wider.click();
    await page.getByRole('button', { name: 'Increase depth', exact: true }).click();
    await expect(page.locator('#fab-label-width'), 'the width readout').toHaveText('6');
    await expect(page.locator('#fab-label-depth'), 'the depth readout').toHaveText('2');
    await press(page, 'Apply');
    await pollScene(page, (s) => {
      const n = nodeAtAnchor(s, 10, 12);
      return n ? { cells: sortedCells(n), label: n.label } : null;
    }, {
      message: 'the host holds the configured label: 12 cells, the words and Lilac',
    }).toEqual({ cells: SIX_BY_TWO_AT_10_12, label: { text: WORDS, colour: LILAC_BYTE } });
    const first = nodeAtAnchor(await readScene(page), 10, 12)!.id;
    await expectLilacSixByTwo(page, first);
    await expect
      .poll(async () => (await labelWordsOf(page, first))?.text ?? null, { message: 'the words are drawn before the delete' })
      .toBe(WORDS);
    await expectRenderLoopAlive(page, 'after the Apply');

    // Select the label with a plain click OFF-CENTRE on its box, then the Delete key.
    await clickFloor(page);
    const onBox = await screenCellCentre(page, 13, 13);
    await page.mouse.click(onBox.x + 3, onBox.y - 2);
    await expect(page.locator('#fab-label-width'), 'the click selected the label (its panel is open)').toHaveText('6');
    await expect(page.locator('#fab-label-text'), 'the click did not focus the Text field').not.toBeFocused();
    await page.keyboard.press('Delete');
    await pollScene(page, (s) => labelsIn(s).length, {
      message: 'the Delete key removed the label from the host',
    }).toBe(0);
    await expect(
      page.locator('[data-testid="label-words"]'),
      'no words element is on the page once the label is gone',
    ).toHaveCount(0);
    await expectRenderLoopAlive(page, 'after the Delete');

    // A click on empty floor, then Ctrl+Z.
    await clickFloor(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => labelsIn(s).length, {
      message: 'Ctrl+Z put one label back',
    }).toBe(1);
    await pollScene(page, (s) => {
      const n = nodeAtAnchor(s, 10, 12);
      return n ? { kind: n.kind, cells: sortedCells(n), label: n.label } : null;
    }, {
      message: 'the label is back at (10,12) on its 12 cells with its words and Lilac',
    }).toEqual({ kind: KIND_LABEL, cells: SIX_BY_TWO_AT_10_12, label: { text: WORDS, colour: LILAC_BYTE } });
    const back = nodeAtAnchor(await readScene(page), 10, 12)!.id;
    await expect
      .poll(async () => labelWordsOf(page, back), { message: 'the words element for the restored label' })
      .toMatchObject({ text: WORDS, visible: true });
    await expectLilacSixByTwo(page, back);
    await expectRenderLoopAlive(page, 'after the Ctrl+Z');
    errs.assertNone('across place, configure, delete and undo');
  });
});
