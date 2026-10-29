import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorOf,
  cameraOf,
  expectRenderLoopAlive,
  handPlaceAt,
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

// 76-label-words.live.spec.ts (plan 76-02, SHAPE-10, D-04, D-06) - a user types words into
// a label, applies them once, reads them on the board, and gets them back after saving and
// reloading the board, on the REAL host (dev_render_server, real Core -> RenderProducer ->
// postcard -> WS). Zero mocks, zero injected packets. The spec reads the oracle
// (`window.__fabrico.scene()`, the MODEL) AND the words overlay in the DOM (what is ON
// SCREEN), because a model read alone cannot tell drawn words from missing ones (memory
// fabrico-model-oracle-blindspot).
//
// ---------------------------------------------------------------------------
// THE RULINGS
// ---------------------------------------------------------------------------
//
// SHAPE-10's acceptance: a user places a Label, types text into it, and the text survives
// save and reload; the label is a real node in the certified snapshot, built through the
// same command and edit-log path as every machine.
//
// D-06 (default): text is typed in the label's panel, which opens focused on placement.
// Words are drawn as a DOM overlay pinned to the label each frame (React text, never
// innerHTML); the box is drawn on the canvas. A live spec can read the words, so "the
// words are on screen" can fail.
//
// D-04 (default): text, colour and size are applied together in ONE Configure: one
// Apply, one undo step.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE TRACER. On an empty board at zoom 1 a Label is placed by hand at (10,12). The
//      pointer clicks into the panel's `Text` field off its centre, the keyboard types
//      `Order intake`, and `Apply` is pressed. The oracle's node at anchor (10,12) reports
//      `label.text` `Order intake`, and the DOM words element for that node reads exactly
//      that, is visible, and lies inside the label box's screen rect. Ctrl+S saves to a
//      real tmpdir `.fab` path (the file appears on disk), New polls the scene to empty,
//      and Load reads the same path back: ONE kind-11 node at the same anchor, its
//      `label.text` `Order intake`, and the words element showing it.
//   2. ONE APPLY, ONE UNDO STEP (D-04). On a hand-placed label, `Order intake` is applied,
//      then the field is cleared and `Dispatch` applied. After a click on empty floor (so
//      the shipped editable-focus guard does not swallow the key), Ctrl+Z puts `Order
//      intake` back in the model AND on screen; Ctrl+Z again leaves the label with no
//      words and no words element. The full keyframe an undo sends closes the panel (the
//      shipped selection clear), which the leg expects rather than fights.
//   3. FOCUS ON PLACEMENT (76-UI-SPEC 2.1). A label is placed by hand and, WITHOUT a click
//      anywhere, the focused element is the label's Text field; the keyboard types `Order
//      intake` straight into it and `Apply` lands it on the board. A plain click on that
//      same label afterwards (after a click on empty floor) selects it WITHOUT moving focus
//      into the field.
//
// Every leg watches page errors from before `goto` and asserts the render loop is alive on
// both sides of each gesture.
//
// RED AT THE START REVISION: leg 1 times out on `getByLabel('Text')`, because
// the label panel has no Text field (plan 76-01 shipped the heading alone).
//
// MUTATION (2026-10-07, throwaway worktree, reverted): with the label echo's
// `onLabelPlaced` call removed from `gestures.ts`, leg 3 reddens at its first assertion,
// "the placed label hands the keyboard to its Text field ... toBeFocused() failed,
// Expected: focused, Received: inactive".

/** The label kind byte (protocol `machine_kind::LABEL`). A number on purpose: the live
 *  suite imports no product source. */
const KIND_LABEL = 11;
/** One cell in world px (`shared/geometry.ts` CELL). */
const CELL_PX = 32;
/** The words' text-area inset from the cell edges, world px (UI-SPEC 4.2). */
const TEXT_INSET = 8;
/** The box's centreline inset from the cell edges, world px (UI-SPEC terms, the chassis). */
const BOX_INSET = 4;

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

/** The one label in the scene anchored at (cx, cy). */
function labelAt(scene: SceneFacts, cx: number, cy: number): SceneFacts['nodes'][number] {
  const node = nodeAtAnchor(scene, cx, cy);
  expect(node, `a node is anchored at (${cx},${cy})`).toBeDefined();
  expect(node!.kind, `the node at (${cx},${cy}) is a label`).toBe(KIND_LABEL);
  return node!;
}

/** Place a label by hand at (cx, cy) and return its id once the host has echoed it. */
async function placeLabel(page: Page, cx: number, cy: number): Promise<number> {
  await handPlaceAt(page, 'Label', cx, cy);
  await pollScene(page, (s) => nodeAtAnchor(s, cx, cy)?.kind === KIND_LABEL, {
    message: `the real host echoed a label anchored at (${cx},${cy})`,
  }).toBe(true);
  return labelAt(await readScene(page), cx, cy).id;
}

/** Poll the MODEL until the label at (cx, cy) reports `text`. */
async function pollLabelText(page: Page, cx: number, cy: number, text: string): Promise<void> {
  await pollScene(page, (s) => nodeAtAnchor(s, cx, cy)?.label?.text ?? null, {
    message: `the host's label at (${cx},${cy}) reads ${JSON.stringify(text)}`,
  }).toBe(text);
}

/**
 * The words element for label `id` reads exactly `text`, is visible, and its box lies
 * inside the label box's screen rect (the drawn box, inset 4 world px from its cells).
 * Read after the camera settles, so the overlay's per-frame transform and this spec's
 * camera read describe the same frame.
 */
async function expectWordsOnScreen(
  page: Page,
  id: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  text: string,
): Promise<void> {
  await waitForCameraSettle(page);
  await expect
    .poll(async () => (await labelWordsOf(page, id))?.text ?? null, {
      message: `the words overlay shows ${JSON.stringify(text)} for label ${id}`,
    })
    .toBe(text);
  await expect
    .poll(async () => (await labelWordsOf(page, id))?.visible ?? false, {
      message: `the words for label ${id} are visible`,
    })
    .toBe(true);
  const words = await labelWordsOf(page, id);
  const cam = await cameraOf(page);
  const box = {
    x: (cx * CELL_PX + BOX_INSET) * cam.scale + cam.x,
    y: (cy * CELL_PX + BOX_INSET) * cam.scale + cam.y,
    right: ((cx + w) * CELL_PX - BOX_INSET) * cam.scale + cam.x,
    bottom: ((cy + h) * CELL_PX - BOX_INSET) * cam.scale + cam.y,
  };
  const r = words!.rect;
  expect(r, 'the words element has a box').not.toBeNull();
  const slack = 1;
  expect(r!.x, 'the words start inside the box (left)').toBeGreaterThanOrEqual(box.x - slack);
  expect(r!.y, 'the words start inside the box (top)').toBeGreaterThanOrEqual(box.y - slack);
  expect(r!.x + r!.width, 'the words end inside the box (right)').toBeLessThanOrEqual(
    box.right + slack,
  );
  expect(r!.y + r!.height, 'the words end inside the box (bottom)').toBeLessThanOrEqual(
    box.bottom + slack,
  );
  // And they sit where the text area is: 8 world px in from the label's top-left cell.
  expect(Math.abs(r!.x - ((cx * CELL_PX + TEXT_INSET) * cam.scale + cam.x))).toBeLessThanOrEqual(
    slack,
  );
}

/** Click into the label panel's Text field a few px off its centre, the way a hand does. */
async function clickIntoText(page: Page): Promise<void> {
  const field = page.getByLabel('Text', { exact: true });
  await expect(field, 'the label panel shows its Text field').toBeVisible();
  const fb = await field.boundingBox();
  expect(fb, 'the Text field has a box').not.toBeNull();
  await page.mouse.click(fb!.x + fb!.width * 0.3 + 3, fb!.y + fb!.height * 0.6 - 2);
}

/** Press the panel's Apply button. */
async function apply(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}

test.describe('SHAPE-10 live: a label carries the words a user types, through save and load', () => {
  test('leg 1: words typed, applied once, seen on the board, saved, reloaded, read back', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    const id = await placeLabel(page, 10, 12);
    await expectRenderLoopAlive(page, 'after the label is placed');
    expect(await labelWordsOf(page, id), 'an empty label draws no words element').toBeNull();

    await clickIntoText(page);
    await page.keyboard.type('Order intake');
    await apply(page);
    await pollLabelText(page, 10, 12, 'Order intake');
    await expectRenderLoopAlive(page, 'after the words are applied');
    await expectWordsOnScreen(page, id, 10, 12, 4, 1, 'Order intake');

    // SAVE to a real file. A click on empty floor first, so the keyboard shortcut reaches
    // the board rather than a focused panel control.
    const savePath = join(tmpdir(), `fabrico-e2e-label-words-${Date.now()}.fab`);
    const floor = await screenCellCentre(page, 7, 6);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    page.once('dialog', (d) => d.accept(savePath));
    await page.keyboard.press('Control+s');
    await expect
      .poll(() => existsSync(savePath), {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: 'the host wrote the .fab project file (a real save artifact on disk)',
      })
      .toBe(true);
    await expectRenderLoopAlive(page, 'after the save');

    // A genuinely empty board, then LOAD the same file back.
    await newBoard(page);
    expect(await labelWordsOf(page, id), 'New leaves no words on the board').toBeNull();
    page.once('dialog', (d) => d.accept(savePath));
    await page.getByTitle('Load a saved factory').click();
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_LABEL).length, {
      message: 'the loaded board holds exactly one label',
    }).toBe(1);
    await expectRenderLoopAlive(page, 'after the load');

    const loaded = (await readScene(page)).nodes.find((n) => n.kind === KIND_LABEL)!;
    expect(anchorOf(loaded), 'the reloaded label sits at the same anchor').toEqual([10, 12]);
    expect(loaded.label, 'the reloaded label carries the words').toEqual({
      text: 'Order intake',
      colour: 0,
    });
    await resetZoomToActualSize(page);
    await expectWordsOnScreen(page, loaded.id, 10, 12, 4, 1, 'Order intake');

    errs.assertNone('typing, applying, saving and reloading a label');
  });

  test('leg 2: one Apply is one undo step, and a second Ctrl+Z clears the words', async ({ page }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    const id = await placeLabel(page, 10, 12);
    await clickIntoText(page);
    await page.keyboard.type('Order intake');
    await apply(page);
    await pollLabelText(page, 10, 12, 'Order intake');
    await expectWordsOnScreen(page, id, 10, 12, 4, 1, 'Order intake');

    // The second Apply: the field is cleared by the keyboard, not by a fill.
    await clickIntoText(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Dispatch');
    await apply(page);
    await pollLabelText(page, 10, 12, 'Dispatch');
    await expectWordsOnScreen(page, id, 10, 12, 4, 1, 'Dispatch');
    await expectRenderLoopAlive(page, 'after two Applies');

    // Ctrl+Z with the BOARD focused.
    const floor = await screenCellCentre(page, 7, 6);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    await page.keyboard.press('Control+z');
    await pollLabelText(page, 10, 12, 'Order intake');
    await expectRenderLoopAlive(page, 'after the first undo');
    const afterUndo = labelAt(await readScene(page), 10, 12);
    await expectWordsOnScreen(page, afterUndo.id, 10, 12, 4, 1, 'Order intake');

    await page.keyboard.press('Control+z');
    await pollLabelText(page, 10, 12, '');
    await expectRenderLoopAlive(page, 'after the second undo');
    const placed = labelAt(await readScene(page), 10, 12);
    await expect
      .poll(async () => labelWordsOf(page, placed.id), {
        message: 'a label back at its placed state draws no words element',
      })
      .toBeNull();

    errs.assertNone('applying twice and undoing twice');
  });

  test('leg 3: a freshly placed label takes typing straight away; a plain click does not', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    const id = await placeLabel(page, 10, 12);
    const field = page.locator('#fab-label-text');
    await expect(field, 'the placed label hands the keyboard to its Text field').toBeFocused();
    await page.keyboard.type('Order intake');
    await apply(page);
    await pollLabelText(page, 10, 12, 'Order intake');
    await expectRenderLoopAlive(page, 'after typing into the placed label');
    await expectWordsOnScreen(page, id, 10, 12, 4, 1, 'Order intake');

    // A plain click on the existing label: selected, panel open, focus NOT in the field.
    const floor = await screenCellCentre(page, 7, 6);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    await expect(field, 'deselecting closed the panel').toHaveCount(0);
    const onLabel = await screenCellCentre(page, 11, 12);
    await page.mouse.click(onLabel.x + 2, onLabel.y + 3);
    await expect(field, 'the plain click opened the label panel').toBeVisible();
    await expect(field, 'a plain click never moves focus into the field').not.toBeFocused();

    errs.assertNone('placing and typing into a label');
  });
});
