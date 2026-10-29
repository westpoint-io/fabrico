import { test, expect, type Page } from '@playwright/test';
import { copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anchorOf,
  ensurePlaying,
  expectRenderLoopAlive,
  labelBoxOn,
  labelWordsOf,
  nodeAtAnchor,
  pollScene,
  readScene,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 86-over-cap-label-edit.live.spec.ts (plan 86-07, D-09, WORK-11, phase 86 success criterion 4)
// - a user opens a board whose label is 17 by 9, one past the panel's 16 by 8 on each side,
// gives it new words and a new colour, and applies. The words and the colour are drawn and the
// box stays 17 by 9; then the user narrows it to 16 and applies, and it is 16 by 9. On the REAL
// host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero
// injected packets.
//
// WHY THIS WAS BROKEN. The panel's Apply always resends the label's current width and depth with
// the words and colour, and the size cap refused any width over 16 or depth over 8, so a label
// that size (from a hand-edited file, or a later build with a larger cap) could never be edited
// again. The cap now applies to a side only when that side changes.
//
// THE FILE IS GENERATED, NOT HAND-WRITTEN. `crates/fabrico-host/tests/fixtures/
// 86-label-17-by-9.fab` is a real host board (a Source, a Sink and a label placed from the
// palette, saved by the shipped `save_project`) with ONE forged `Configure` appended that sizes
// the label 17 by 9, words "Order intake", Stone. `crates/fabrico-host/tests/forged_files.rs`
// builds it and its currency test requires the committed bytes equal a fresh build.
//
// WHAT IS GRADED IS WHAT THE USER SEES: the panel's own width and depth readouts, the words
// element on the board, the box the `label-box` Graphics plotted (its colour and its 17 by 9
// rect), and the cells the host holds. Red on the unchanged host (`cap-live-red.*`): the Apply
// was refused and the words never changed.
//
// Render health in the test (fabrico-model-oracle-blindspot): `watchPageErrors` before
// `page.goto`, `expectRenderLoopAlive` after every step and `assertNone` at the end.
//
// Drive rules: the real Open button and its prompt dialog, a plain click on the label, the
// panel's controls by their accessible names; every wait polls a specific change.

/** The committed forged board. */
const FIXTURE = fileURLToPath(
  new URL('../../crates/fabrico-host/tests/fixtures/86-label-17-by-9.fab', import.meta.url),
);

/** The label kind byte (protocol `machine_kind::LABEL`). */
const KIND_LABEL = 11;
/** The label's anchor and its size in the file. */
const LABEL_AT: [number, number] = [20, 24];
const FILE_W = 17;
const FILE_H = 9;
/** One cell in world px, and the box's inset from the cell edges (76-UI-SPEC). */
const CELL_PX = 32;
const BOX_INSET = 4;
/** Label colours (locked skin, byte order): Stone 1 in the file, Moss 2 picked here. */
const STONE = 0xa19d95;
const MOSS = 0xa3c27f;
const MOSS_BYTE = 2;

type NodeFacts = SceneFacts['nodes'][number];

/** The one label on the board, or undefined. */
function theLabel(scene: SceneFacts): NodeFacts | undefined {
  return scene.nodes.find((n) => n.kind === KIND_LABEL);
}

/** The label's box as the host holds it: anchor, width and depth from its cells. */
function boxOf(node: NodeFacts | undefined): { anchor: [number, number]; w: number; h: number } | null {
  if (!node) return null;
  const xs = node.cells.map(([x]) => x);
  const ys = node.cells.map(([, y]) => y);
  const w = Math.max(...xs) - Math.min(...xs) + 1;
  const h = Math.max(...ys) - Math.min(...ys) + 1;
  expect(node.cells.length, 'the label holds every cell of its box').toBe(w * h);
  return { anchor: anchorOf(node) as [number, number], w, h };
}

/** The `label-box` Graphics of label `id` plotted a `w` by `h` box at the anchor in `colour`. */
async function expectBoxPlotted(page: Page, id: number, w: number, h: number, colour: number): Promise<void> {
  await expect
    .poll(async () => labelBoxOn(page, id), {
      message: `the label-box Graphics of label ${id} plotted a ${w} by ${h} box in 0x${colour.toString(16)}`,
    })
    .toMatchObject({
      fill: { color: colour, alpha: 0.16 },
      stroke: { color: colour, alpha: 1 },
      rect: {
        x: LABEL_AT[0] * CELL_PX + BOX_INSET,
        y: LABEL_AT[1] * CELL_PX + BOX_INSET,
        w: w * CELL_PX - 2 * BOX_INSET,
        h: h * CELL_PX - 2 * BOX_INSET,
      },
    });
}

/** Click a panel button by its accessible name. */
async function press(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

test.describe('D-09 live: a label past the panel cap still takes new words and a new colour', () => {
  test('opening a board with a 17 by 9 label, new words and Moss apply and are drawn at 17 by 9, then narrowing to 16 applies', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await waitForAppReady(page);
    await expectRenderLoopAlive(page, 'on the board the app boots');

    // OPEN THE FORGED BOARD, a private copy so the host opens a file nothing else writes.
    const opened = join(tmpdir(), `fabrico-e2e-86-label-17-by-9-${Date.now()}.fab`);
    copyFileSync(FIXTURE, opened);
    page.once('dialog', (d) => void d.accept(opened));
    await page.getByTitle('Load a saved factory').click();
    await pollScene(page, (s) => boxOf(theLabel(s)), {
      message: 'the forged board opened with its label 17 by 9 at (20,24)',
    }).toEqual({ anchor: LABEL_AT, w: FILE_W, h: FILE_H });
    await expect(page.getByRole('alert'), 'no refusal card: the board opens').toHaveCount(0);
    await ensurePlaying(page);
    // The Open keeps the camera where the boot board left it; the toolbar's own fit brings
    // the opened board into view, as a user would.
    await page.getByRole('button', { name: 'Fit factory to view' }).click();
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, 'on the opened board');
    const id = theLabel(await readScene(page))!.id;
    expect(nodeAtAnchor(await readScene(page), LABEL_AT[0], LABEL_AT[1])?.id, 'the label is anchored at (20,24)').toBe(id);
    await expectBoxPlotted(page, id, FILE_W, FILE_H, STONE);

    // SELECT THE LABEL with a plain click inside its box, a few px off a cell centre. The
    // panel's readouts show the label's real size, past the stepper's cap.
    const onLabel = await screenCellCentre(page, LABEL_AT[0] + 3, LABEL_AT[1] + 2);
    const viewport = page.viewportSize()!;
    expect(
      onLabel.x > 0 && onLabel.x < viewport.width && onLabel.y > 0 && onLabel.y < viewport.height,
      `the label cell is on screen at (${Math.round(onLabel.x)},${Math.round(onLabel.y)})`,
    ).toBe(true);
    await page.mouse.click(onLabel.x + 3, onLabel.y - 2);
    await expect(page.locator('#fab-label-width'), 'the panel reads the real width').toHaveText(String(FILE_W));
    await expect(page.locator('#fab-label-depth'), 'the panel reads the real depth').toHaveText(String(FILE_H));

    // NEW WORDS AND A NEW COLOUR, one Apply. The panel resends 17 by 9 with them.
    await page.locator('#fab-label-text').fill('Dispatch');
    await page.getByRole('button', { name: 'Moss', exact: true }).click();
    await expect(page.locator('#fab-label-colour-name'), 'the name beside Colour').toHaveText('Moss');
    await press(page, 'Apply');
    await pollScene(page, (s) => theLabel(s)?.label ?? null, {
      message: 'the host holds the new words and Moss',
    }).toEqual({ text: 'Dispatch', colour: MOSS_BYTE });
    expect(boxOf(theLabel(await readScene(page))), 'the box is still 17 by 9 at (20,24)').toEqual({
      anchor: LABEL_AT,
      w: FILE_W,
      h: FILE_H,
    });
    await expectRenderLoopAlive(page, 'after the words and colour are applied');
    // What the user sees: the words drawn on the board, the box re-plotted in Moss at 17 by 9.
    await expect
      .poll(async () => (await labelWordsOf(page, id))?.text ?? null, {
        message: 'the board draws the new words',
      })
      .toBe('Dispatch');
    expect((await labelWordsOf(page, id))?.visible, 'the words are visible on the board').toBe(true);
    await expectBoxPlotted(page, id, FILE_W, FILE_H, MOSS);

    // NARROW IT TO 16, inside the cap, keeping depth 9.
    await press(page, 'Decrease width');
    await expect(page.locator('#fab-label-width'), 'the width readout').toHaveText('16');
    await press(page, 'Apply');
    await pollScene(page, (s) => boxOf(theLabel(s)), {
      message: 'the host holds the label 16 by 9 at (20,24)',
    }).toEqual({ anchor: LABEL_AT, w: 16, h: FILE_H });
    expect(theLabel(await readScene(page))?.label, 'the words and colour stay').toEqual({
      text: 'Dispatch',
      colour: MOSS_BYTE,
    });
    await expectBoxPlotted(page, id, 16, FILE_H, MOSS);
    await expectRenderLoopAlive(page, 'after the label is narrowed');
    errs.assertNone('during the over-cap label edit');
  });
});
