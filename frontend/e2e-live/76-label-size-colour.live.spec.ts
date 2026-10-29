import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorOf,
  cameraOf,
  expectRenderLoopAlive,
  handPlaceAt,
  labelBoxOn,
  labelResizePreviewOf,
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
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';

// 76-label-size-colour.live.spec.ts (plan 76-03, SHAPE-12, D-04, D-05) - a user makes a
// label the colour and size they want from its panel, applies once, and the canvas, the
// model and a reloaded board all agree, on the REAL host (dev_render_server, real Core ->
// RenderProducer -> postcard -> WS). Zero mocks, zero injected packets. The spec reads the
// oracle (`window.__fabrico.scene()`, the MODEL) AND the canvas read-back probe
// (`labelBoxOn`, the instructions the `label-box` Graphics actually plotted), because a
// model read alone passes over a board that still paints the old colour (memory
// fabrico-model-oracle-blindspot).
//
// ---------------------------------------------------------------------------
// THE RULINGS
// ---------------------------------------------------------------------------
//
// SHAPE-12 (as amended 2026-10-06): a user resizes a label with the label's OWN size
// control and recolours it from a closed set; size and colour survive save and reload.
//
// D-04 (default): width and depth steppers in the panel; text, colour and size travel in
// ONE Configure, one Apply, one undo step; the size is capped well under 64; growth over
// a neighbour has its own refusal.
//
// D-05 (default): a closed set of six colours as a Rust enum, a label palette in the
// locked skin, never the state colours; the colour tints the box.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE TRACER. On an empty board at zoom 1 a Label is placed by hand at (10,12). The
//      keyboard types `Order intake` straight into the focused Text field; the `Lilac`
//      swatch is clicked (the name beside `Colour` then reads `Lilac`); `Increase width` is
//      pressed twice and `Increase depth` once (the readouts read 6 and 2); `Apply`. The
//      oracle's node at anchor (10,12) holds exactly the 12 cells x 10 to 15, y 12 to 13,
//      listed by literal, with `label.colour` 3 and `label.text` `Order intake`; the probe
//      reads a 6 by 2 rect inset 4 world px, fill `#bea2ea` at alpha 0.16, outline
//      `#bea2ea`. Ctrl+S to a real tmpdir `.fab`, New to empty, Load: the same 12 cells,
//      colour, text and anchor, and the probe reads Lilac again. Between the Apply and the
//      save, a COLOUR CHANGE ALONE (Rose, Apply, then Lilac, Apply) is read off the probe:
//      the tracer's Apply moves the size too, so it cannot tell whether the colour is in
//      the layer's re-plot key, and this step can.
//   2. GROWING OVER A NEIGHBOUR IS REFUSED WITH A TRUE SENTENCE (D-01, D-04, UI-SPEC step
//      7). A 6 by 2 label at (10,12) and a Merge placed by hand at (17,12), one empty
//      column between. The label is selected by a plain click; `Increase width` once: the
//      outline probe reads `build` at 7 by 2; once more: `fault` at 8 by 2, and the box
//      on the canvas is still 6 by 2. Apply stays enabled; pressed, the refusal band reads
//      exactly `That size would cover something. Go smaller.`, the host still holds the
//      12 cells, the panel still reads 8 and is marked unsaved, and the outline stays red.
//      Revert clears the outline.
//   3. THE WORDS STAY INSIDE THE BOX AT EVERY ZOOM AND GO BELOW THREE QUARTERS (D-06,
//      UI-SPEC 4.2 backstop). A label shrunk to 1 by 1 with `Decrease width` three times
//      and given 512 ASCII bytes, applied. At zoom 1 and after wheeling in over it until
//      the camera reads at least 3, the words element's screen rect lies inside the text
//      area (the label's cell rect inset 8 world px, projected). Wheeling out until the
//      camera reads below 0.75 hides it (`visibility: hidden`) while the canvas probe still
//      reads the box; wheeling back to at least 0.75 shows it again.
//   4. THE TOOLBAR SAYS NAMES, AND NAME CHIPS SKIP LABELS (D-09, UI-SPEC 4.3 and 7). On a
//      board with a Source, a Merge and a label, the toolbar toggle is named `Names` and no
//      control is named `Labels`; with Alt held, a `machine-label` chip shows over the
//      Source and the Merge and none over the label.
//
// The steppers and swatches are driven by their ACCESSIBLE NAMES, never by a lookalike.
// Every leg watches page errors from before `goto` and asserts the render loop is alive
// on both sides of each gesture.
//
// RED AT THE START REVISION: leg 1 times out on `getByRole('button', { name:
// 'Lilac' })`, because the label panel has no swatches (plan 76-02 shipped the Text field
// alone).
//
// MUTATION (2026-10-07, throwaway worktree, reverted): with the colour dropped from the
// label box's re-plot signature in `machines.ts`, leg 1 as first written (one Apply moving
// colour and size together) stayed GREEN, because the size change re-plotted the box
// anyway. The colour-only step was added for that reason; under the same mutation it
// reddens (recorded in 76-03-SUMMARY.md) while every model assertion in the leg passes.

/** The label kind byte (protocol `machine_kind::LABEL`). A number on purpose: the live
 *  suite imports no product source. */
const KIND_LABEL = 11;
/** One cell in world px (`shared/geometry.ts` CELL). */
const CELL_PX = 32;
/** The box's centreline inset from the cell edges, world px (UI-SPEC terms, the chassis). */
const BOX_INSET = 4;
/** The words' text-area inset from the cell edges, world px (UI-SPEC 4.2). */
const TEXT_INSET = 8;
/** The overlay's `build` and `fault` accents (locked skin), as the probe reads them. */
const BUILD = 0x4fa8ff;
const FAULT = 0xf0506e;
/** The grow refusal's sentence (UI-SPEC 6.2), asserted exactly. */
const RESIZE_COVERS = 'That size would cover something. Go smaller.';
/** Lilac, label colour byte 3 (UI-SPEC 3.1), as the integer the probe reads. */
const LILAC = 0xbea2ea;
/** The label colour byte for Lilac. */
const LILAC_BYTE = 3;
/** Rose, label colour byte 4 (UI-SPEC 3.1), as the integer the probe reads. */
const ROSE = 0xe39ac0;
const ROSE_BYTE = 4;

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

/** A node's cells, sorted row-major, as `x,y` strings, so a literal list compares. */
function sortedCells(node: SceneFacts['nodes'][number]): string[] {
  return [...node.cells]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([x, y]) => `${x},${y}`);
}

/** The 12 cells of a 6 by 2 label anchored at (10,12), by literal, row-major. */
const SIX_BY_TWO_AT_10_12 = [
  '10,12', '11,12', '12,12', '13,12', '14,12', '15,12',
  '10,13', '11,13', '12,13', '13,13', '14,13', '15,13',
];

/** Click a panel button by its accessible name. */
async function press(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

/**
 * The canvas probe for label `id` reads a `w` by `h` box at (cx, cy), inset 4 world px,
 * filled `colour` at alpha 0.16 and outlined in it. Polled: the box re-plots on the next
 * frame after the packet lands.
 */
async function expectBoxPlotted(
  page: Page,
  id: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  colour: number,
): Promise<void> {
  await expect
    .poll(async () => labelBoxOn(page, id), {
      message: `the label-box Graphics of label ${id} plotted a ${w} by ${h} box in 0x${colour.toString(16)}`,
    })
    .toMatchObject({
      instructions: 2,
      fill: { color: colour, alpha: 0.16 },
      stroke: { color: colour, alpha: 1 },
      rect: {
        x: cx * CELL_PX + BOX_INSET,
        y: cy * CELL_PX + BOX_INSET,
        w: w * CELL_PX - 2 * BOX_INSET,
        h: h * CELL_PX - 2 * BOX_INSET,
      },
    });
}

/**
 * The words element for label `id` (a 1 by 1 label at (cx, cy)) is visible and its screen
 * rect lies inside the label's TEXT AREA: the cell rect inset 8 world px on every side,
 * projected through the live camera, with one screen px of slack.
 */
async function expectWordsInsideTextArea(
  page: Page,
  id: number,
  cx: number,
  cy: number,
  when: string,
): Promise<void> {
  await waitForCameraSettle(page);
  await expect
    .poll(async () => (await labelWordsOf(page, id))?.visible ?? null, {
      message: `the words are visible at ${when}`,
    })
    .toBe(true);
  const cam = await cameraOf(page);
  const r = (await labelWordsOf(page, id))!.rect;
  expect(r, `the words element has a box at ${when}`).not.toBeNull();
  const area = {
    x: (cx * CELL_PX + TEXT_INSET) * cam.scale + cam.x,
    y: (cy * CELL_PX + TEXT_INSET) * cam.scale + cam.y,
    right: ((cx + 1) * CELL_PX - TEXT_INSET) * cam.scale + cam.x,
    bottom: ((cy + 1) * CELL_PX - TEXT_INSET) * cam.scale + cam.y,
  };
  const slack = 1;
  expect(r!.x, `left inside the text area at ${when}`).toBeGreaterThanOrEqual(area.x - slack);
  expect(r!.y, `top inside the text area at ${when}`).toBeGreaterThanOrEqual(area.y - slack);
  expect(r!.x + r!.width, `right inside the text area at ${when}`).toBeLessThanOrEqual(area.right + slack);
  expect(r!.y + r!.height, `bottom inside the text area at ${when}`).toBeLessThanOrEqual(area.bottom + slack);
}

/**
 * Wheel over cell (cx, cy) one notch at a time until `done(scale)` holds, re-aiming at the
 * cell after every notch (the zoom is about the cursor, so the cell stays put, but a clamp
 * or a pan could move it). Bounded at 40 notches.
 */
async function wheelOverCellUntil(
  page: Page,
  cx: number,
  cy: number,
  deltaY: number,
  done: (scale: number) => boolean,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (done((await cameraOf(page)).scale)) return;
    const at = await screenCellCentre(page, cx, cy);
    await page.mouse.move(at.x + 3, at.y - 2);
    const before = (await cameraOf(page)).scale;
    await page.mouse.wheel(0, deltaY);
    await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the wheel moved the zoom' }).not.toBe(before);
  }
  expect(done((await cameraOf(page)).scale), 'the zoom reached its target within 40 notches').toBe(true);
}

test.describe('SHAPE-12 live: a label takes the colour and size a user picks, through save and load', () => {
  test('leg 1: Lilac and 6 by 2 picked in the panel, applied once, read off the canvas, saved, reloaded', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    const id = await placeLabel(page, 10, 12);
    await expectRenderLoopAlive(page, 'after the label is placed');
    await expect(page.locator('#fab-label-text'), 'the placed label focuses its Text field').toBeFocused();
    await page.keyboard.type('Order intake');

    const lilac = page.getByRole('button', { name: 'Lilac', exact: true });
    await lilac.click();
    await expect(page.locator('#fab-label-colour-name'), 'the name beside Colour').toHaveText('Lilac');
    await expect(lilac, 'the chosen swatch is pressed').toHaveAttribute('aria-pressed', 'true');
    const wider = page.getByRole('button', { name: 'Increase width', exact: true });
    const deeper = page.getByRole('button', { name: 'Increase depth', exact: true });
    await wider.click();
    await wider.click();
    await deeper.click();
    await expect(page.locator('#fab-label-width'), 'the width readout').toHaveText('6');
    await expect(page.locator('#fab-label-depth'), 'the depth readout').toHaveText('2');
    // Nothing is sent before Apply: the host still holds a Sand 4 by 1 box.
    await expectBoxPlotted(page, id, 10, 12, 4, 1, 0xe0d388);

    await press(page, 'Apply');
    await pollScene(page, (s) => sortedCells(labelAt(s, 10, 12)), {
      message: 'the host holds the label on exactly the 12 cells of a 6 by 2 box at (10,12)',
    }).toEqual(SIX_BY_TWO_AT_10_12);
    const applied = labelAt(await readScene(page), 10, 12);
    expect(applied.label, 'the host holds the words and Lilac').toEqual({
      text: 'Order intake',
      colour: LILAC_BYTE,
    });
    await expectRenderLoopAlive(page, 'after the colour and size are applied');
    await expectBoxPlotted(page, id, 10, 12, 6, 2, LILAC);

    // A COLOUR CHANGE ALONE, the one edit that moves nothing but the colour byte. The
    // tracer's Apply above moved the size too, so it re-plots whether or not the colour is
    // in the layer's re-plot key and cannot tell the two apart (measured: with the colour
    // dropped from the key, every assertion above stays green). Rose, Apply: the model and
    // the probe both read Rose on the same 6 by 2 rect; then back to Lilac the same way.
    await page.getByRole('button', { name: 'Rose', exact: true }).click();
    await press(page, 'Apply');
    await pollScene(page, (s) => labelAt(s, 10, 12).label?.colour ?? null, {
      message: 'the host holds Rose',
    }).toBe(ROSE_BYTE);
    await expectBoxPlotted(page, id, 10, 12, 6, 2, ROSE);
    await lilac.click();
    await press(page, 'Apply');
    await pollScene(page, (s) => labelAt(s, 10, 12).label?.colour ?? null, {
      message: 'the host holds Lilac again',
    }).toBe(LILAC_BYTE);
    await expectBoxPlotted(page, id, 10, 12, 6, 2, LILAC);
    await expectRenderLoopAlive(page, 'after two colour-only Applies');

    // SAVE to a real file. A click on empty floor first, so the keyboard shortcut reaches
    // the board rather than a focused panel control.
    const savePath = join(tmpdir(), `fabrico-e2e-label-size-colour-${Date.now()}.fab`);
    const floor = await screenCellCentre(page, 4, 6);
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
    expect(await labelBoxOn(page, id), 'New leaves no label box on the board').toBeNull();
    page.once('dialog', (d) => d.accept(savePath));
    await page.getByTitle('Load a saved factory').click();
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_LABEL).length, {
      message: 'the loaded board holds exactly one label',
    }).toBe(1);
    await expectRenderLoopAlive(page, 'after the load');

    const loaded = (await readScene(page)).nodes.find((n) => n.kind === KIND_LABEL)!;
    expect(anchorOf(loaded), 'the reloaded label sits at the same anchor').toEqual([10, 12]);
    expect(sortedCells(loaded), 'the reloaded label holds the same 12 cells').toEqual(
      SIX_BY_TWO_AT_10_12,
    );
    expect(loaded.label, 'the reloaded label carries the words and Lilac').toEqual({
      text: 'Order intake',
      colour: LILAC_BYTE,
    });
    await expectBoxPlotted(page, loaded.id, 10, 12, 6, 2, LILAC);

    errs.assertNone('colouring, sizing, saving and reloading a label');
  });
  test('leg 2: growing over a neighbour is previewed red and refused with a true sentence', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    // A 6 by 2 label at (10,12).
    const id = await placeLabel(page, 10, 12);
    const wider = page.getByRole('button', { name: 'Increase width', exact: true });
    await wider.click();
    await wider.click();
    await page.getByRole('button', { name: 'Increase depth', exact: true }).click();
    await press(page, 'Apply');
    await pollScene(page, (s) => sortedCells(labelAt(s, 10, 12)), {
      message: 'the label holds the 12 cells of a 6 by 2 box',
    }).toEqual(SIX_BY_TWO_AT_10_12);
    await expect
      .poll(() => labelResizePreviewOf(page), { message: 'the applied size leaves no outline' })
      .toBeNull();

    // Close the panel with a click on empty floor (it docks over the right of the board,
    // where the Merge goes), then a Merge (2 by 2) at (17,12): column 16 stays empty.
    const floor = await screenCellCentre(page, 4, 6);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    await expect(page.locator('#fab-label-width'), 'deselecting closed the panel').toHaveCount(0);
    await handPlaceAt(page, 'Merge', 17, 12);
    await page.keyboard.press('Escape');
    await pollScene(page, (s) => nodeAtAnchor(s, 17, 12)?.kind ?? null, {
      message: 'the host placed the Merge at (17,12)',
    }).toBe(6);
    await expectRenderLoopAlive(page, 'after the Merge is placed');

    // Select the label with a plain click, a few px off a cell centre.
    const onLabel = await screenCellCentre(page, 12, 13);
    await page.mouse.click(onLabel.x + 3, onLabel.y - 2);
    await expect(page.locator('#fab-label-width'), 'the label panel is open').toHaveText('6');

    // One wider: 7 by 2 reaches column 16, which is free. Blue.
    await wider.click();
    await expect
      .poll(() => labelResizePreviewOf(page), { message: 'the 7 by 2 outline is build blue' })
      .toMatchObject({
        stroke: { color: BUILD, alpha: 0.5, width: 2 },
        rect: { x: 10 * CELL_PX + BOX_INSET, y: 12 * CELL_PX + BOX_INSET, w: 7 * CELL_PX - 8, h: 2 * CELL_PX - 8 },
        filled: false,
      });
    // Two wider: 8 by 2 reaches column 17, the Merge's. Red.
    await wider.click();
    await expect
      .poll(() => labelResizePreviewOf(page), { message: 'the 8 by 2 outline is fault red' })
      .toMatchObject({
        stroke: { color: FAULT, alpha: 0.5, width: 2 },
        rect: { x: 10 * CELL_PX + BOX_INSET, y: 12 * CELL_PX + BOX_INSET, w: 8 * CELL_PX - 8, h: 2 * CELL_PX - 8 },
        filled: false,
      });
    // The outline never moves the box: the canvas still holds the committed 6 by 2.
    await expectBoxPlotted(page, id, 10, 12, 6, 2, 0xe0d388);

    // Apply stays enabled on a red outline; the HOST decides, and says why.
    const applyBtn = page.getByRole('button', { name: 'Apply', exact: true });
    await expect(applyBtn, 'Apply stays enabled on a red outline').toBeEnabled();
    await applyBtn.click();
    await expect
      .poll(async () => ((await page.locator('#fab-refusal').textContent()) ?? '').trim(), {
        message: 'the refusal band states the grow refusal',
      })
      .toContain(RESIZE_COVERS);
    await expect(page.locator('#fab-refusal')).toContainText(RESIZE_COVERS);
    expect(
      sortedCells(labelAt(await readScene(page), 10, 12)),
      'the host still holds the 12 cells',
    ).toEqual(SIX_BY_TWO_AT_10_12);
    await expect(page.locator('#fab-label-width'), 'the panel still holds the typed size').toHaveText('8');
    await expect(page.getByText(CONFIG_NOT_APPLIED_MARKER), 'the panel is still marked not applied').toBeVisible();
    expect((await labelResizePreviewOf(page))?.stroke?.color, 'the outline stays red').toBe(FAULT);
    await expectRenderLoopAlive(page, 'after the refusal');

    // Revert: the buffer is the committed size again, and the outline goes.
    await press(page, 'Revert');
    await expect(page.locator('#fab-label-width')).toHaveText('6');
    await expect
      .poll(() => labelResizePreviewOf(page), { message: 'Revert clears the outline' })
      .toBeNull();

    errs.assertNone('previewing and refusing a grow over a neighbour');
  });

  test('leg 3: 512 bytes on a 1 by 1 label stay inside the text area at zoom 1 and 3+, and hide below 0.75', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before the label is placed');

    const id = await placeLabel(page, 10, 12);
    const narrower = page.getByRole('button', { name: 'Decrease width', exact: true });
    await narrower.click();
    await narrower.click();
    await narrower.click();
    await expect(page.locator('#fab-label-width')).toHaveText('1');
    await expect(narrower, 'minus disables at 1').toBeDisabled();
    const words = 'abcdefghijklmnop'.repeat(32);
    expect(words.length, '512 ASCII bytes').toBe(512);
    await page.locator('#fab-label-text').fill(words);
    await press(page, 'Apply');
    await pollScene(page, (s) => sortedCells(labelAt(s, 10, 12)), {
      message: 'the label is 1 by 1',
    }).toEqual(['10,12']);
    await pollScene(page, (s) => labelAt(s, 10, 12).label?.text.length ?? 0, {
      message: 'the host holds all 512 bytes',
    }).toBe(512);

    // Deselect so the panel does not cover the board, then judge the words at zoom 1.
    const floor = await screenCellCentre(page, 4, 6);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    await expectWordsInsideTextArea(page, id, 10, 12, 'zoom 1');

    // Wheel IN over the label until the camera reads at least 3.
    await wheelOverCellUntil(page, 10, 12, -200, (scale) => scale >= 3);
    await expectWordsInsideTextArea(page, id, 10, 12, 'zoom 3 or more');
    await expectRenderLoopAlive(page, 'after zooming in');

    // Wheel OUT until the camera reads below 0.75: the words hide, the box stays.
    await wheelOverCellUntil(page, 10, 12, 200, (scale) => scale < 0.75);
    await expect
      .poll(async () => (await labelWordsOf(page, id))?.visible ?? null, {
        message: 'below zoom 0.75 the words are hidden',
      })
      .toBe(false);
    expect(
      await page
        .locator(`[data-testid="label-words"][data-node="${id}"]`)
        .evaluate((el) => getComputedStyle(el).visibility),
      'hidden is visibility: hidden',
    ).toBe('hidden');
    expect((await labelBoxOn(page, id))?.instructions, 'the box is still plotted').toBe(2);
    await expectRenderLoopAlive(page, 'after zooming out');

    // Back to at least 0.75: shown again.
    await wheelOverCellUntil(page, 10, 12, -200, (scale) => scale >= 0.75);
    await expect
      .poll(async () => (await labelWordsOf(page, id))?.visible ?? null, {
        message: 'at zoom 0.75 or more the words show again',
      })
      .toBe(true);

    errs.assertNone('zooming across a full 1 by 1 label');
  });

  test('leg 4: the toolbar says Names, and Alt shows name chips over machines and none over a label', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before anything is placed');

    await expect(page.getByRole('button', { name: 'Names', exact: true }), 'the toggle is named Names').toBeVisible();
    await expect(page.getByRole('button', { name: 'Labels', exact: true }), 'nothing is named Labels').toHaveCount(0);

    await handPlaceAt(page, 'Source', 4, 4);
    await page.keyboard.press('Escape');
    await handPlaceAt(page, 'Merge', 8, 4);
    await page.keyboard.press('Escape');
    await placeLabel(page, 10, 12);
    await pollScene(page, (s) => s.nodes.map((n) => n.kind).sort((a, b) => a - b), {
      message: 'the board holds a Source, a Merge and a label',
    }).toEqual([0, 6, KIND_LABEL]);

    // The board, not the panel, takes the key.
    const floor = await screenCellCentre(page, 4, 9);
    await page.mouse.click(floor.x + 3, floor.y - 2);
    const chips = page.getByTestId('machine-label');
    await expect(chips, 'no chips at rest').toHaveCount(0);
    await page.keyboard.down('Alt');
    await expect(chips, 'one chip per machine, none for the label').toHaveCount(2);
    expect((await chips.allTextContents()).map((t) => t.trim()).sort()).toEqual(['Merge', 'Source']);
    await page.keyboard.up('Alt');
    await expect(chips).toHaveCount(0);
    await expectRenderLoopAlive(page, 'after the Alt hold');

    errs.assertNone('reading machine names on a board with a label');
  });
});
