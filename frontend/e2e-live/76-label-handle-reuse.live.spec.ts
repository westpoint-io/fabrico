import { test, expect, type Page } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cameraOf,
  drawnNodesOf,
  expectRenderLoopAlive,
  glyphSubjectOn,
  handPlaceAt,
  labelBoxOn,
  labelWordsOf,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
  guardWillAsk,
} from './support/oracle';
import { KIND_NAMES } from '../shared/kindNames';

// 76-label-handle-reuse.live.spec.ts (plan 76-08, review CR-01, verification truth 7) - the
// board draws exactly the nodes the host holds after every keyframe, read off the CANVAS
// and the DOM on the REAL host (dev_render_server, real Core -> RenderProducer -> postcard
// -> WS). Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// Verification truth 7: "the canvas draws exactly the nodes the host holds after every
// keyframe". `RenderProducer::reset` restarts render handles at 0 on every keyframe (Undo,
// Redo, Load, New, LoadDemo), so after one the handles are the nodes' rank in NodeId order
// and a handle that named a label can name a machine. The scene model is right after such
// a keyframe; what this spec grades is what is DRAWN, because a model read passes over a
// ghost on the canvas (memory fabrico-model-oracle-blindspot).
//
// `expectBoardDrawsTheScene` reads the scene once and asserts five things in order, each
// message under its own fixed prefix so a failure names which one broke:
//   CANVAS CENSUS  the machine layer's display list holds a root on every machine handle,
//                  a box on every label handle, and nothing else (`drawnNodesOf`).
//   LABEL BOX      no box on a machine handle; on every label the 2-instruction box on the
//                  label's cells in world px inset 4, filled and stroked in the label's
//                  colour byte through the six-colour table (`labelBoxOn`).
//   DRAWN KIND     every machine root's glyph holds the art of that handle's kind
//                  (`glyphSubjectOn`), through the spec-local table below.
//   DOM CHIPS      the visible name chips equal the scene's machines, count and text.
//   DOM WORDS      the visible words elements equal the labels carrying words, by
//                  `data-node`, each reading its words.
// A setup fact the leg depends on fails under `PRECONDITION`, so a red from a broken
// setup is never read as the defect.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE REDO, THEN THE LOAD, EACH HANDING A LABEL'S HANDLE TO A MACHINE. On an empty
//      board at zoom 1, `Names` on, a Label placed by hand at (10,12) with `Ghost words`
//      typed and `Lilac` picked in ONE Apply (a non-default colour, so the colour arm of
//      LABEL BOX can fail: the box falls back to Sand on an absent or unknown byte), a
//      Source placed by hand at (18,12), the label selected by a plain off-centre click
//      and deleted, Ctrl+Z, Ctrl+Shift+Z. After the Undo the label holds the lower handle;
//      after the Redo the Source holds that same handle (a PRECONDITION: without it the
//      leg proves nothing). Then the one-Source board is saved with Ctrl+S, the toolbar
//      New empties the board (a keyframe, so handles restart at 0), a second label with the
//      same words and colour is placed by hand at (10,12) and takes handle 0, and Load
//      reads the saved file over it: the Source holds the label's handle, through the
//      Load keyframe this time (a machine-lowest board loaded over a label-lowest one).
//      The five checks run after the Undo, the Redo, before the Load and after it.
//
//      WHY NEW AND NOT A SECOND CTRL+Z BEFORE THE LOAD. A Ctrl+Z there hands the Source's
//      handle 0 back to a label, the REVERSE remint, and the machine root on handle 0 stays
//      drawn under the label (measured at this plan's fix revision: CANVAS CENSUS after
//      the second Undo read machines [0, 1] for a scene of [1]). That is the machine-entry
//      half of CR-01, which legs 2 and 3 grade (and `machineEntryStays` fixes); this leg
//      grades the label half on both keyframe paths and keeps out of the other half's way.
//
//   2. THE REDO HANDING A MACHINE'S HANDLE TO A LABEL (the reverse remint, the machine
//      half). `Names` on, a Source placed at (18,12), a Label at (10,12) carrying `Mirror
//      words`, the Source deleted, Ctrl+Z, Ctrl+Shift+Z. After the Undo the Source holds the
//      lower handle; after the Redo the label holds that same handle (PRECONDITIONs).
//
//   3. THE LOAD OF A LABEL-LOWEST BOARD STRAIGHT OVER A MACHINE-LOWEST ONE, WITHOUT NEW.
//      A label carrying `Order intake` and a Source are saved, New empties the board, a
//      Source is placed at (4,4) and takes handle 0, and Load reads the saved file over it
//      (through the discard guard): the label takes the handle the (4,4) Source held.
//
//   4. THE REDO HANDING A MACHINE'S HANDLE TO A MACHINE OF ANOTHER KIND (plan 76-13, the
//      WR-07 path). `Names` on, a Source at (10,12), a Sink at (18,12), the Source deleted,
//      Ctrl+Z, Ctrl+Shift+Z. After the Undo the Source holds the lower handle and the Sink
//      the higher; after the Redo the Sink holds the handle the Source held (PRECONDITIONs).
//      Neither removal loop fires (both kinds are drawable machines), so the entry is kept
//      and only the WR-07 glyph re-point in `machines.ts` makes it draw the Sink's art: the
//      DRAWN KIND check reads `sink` on that handle. That re-point shipped before this leg,
//      so the leg was GREEN when it landed, by design; its bite proof is plan 76-13's
//      mutation G (the re-point line deleted), which fails this leg alone on DRAWN KIND.
//
// Legs 2 and 3 are plan 76-13's Task 1 legs, written in the 76-08 refuter round with the
// machine-entry fix (`machineEntryStays`); plan 76-13 adds leg 4. RED BEFORE THE FIX (the
// instrument commit, before `machineEntryStays`): leg 2 failed "CANVAS CENSUS after the
// Redo: the machine layer draws a root on each machine handle [], a box on each label
// handle [0], and nothing else", received `machines: [0]` (handles: Source 0 and label 1
// after the Undo, label 0 after the Redo); leg 3 failed "CANVAS CENSUS after the Load: ...
// machine handle [1], a box on each label handle [0] ...", received `machines: [0, 1]`
// (the (4,4) Source on 0 before the Load, the label on 0 after it). Every PRECONDITION
// passed in both. Every leg starts through
// `emptyBoardAtScaleOne`, watches page errors from before `goto`, and asserts the render
// loop is alive on both sides of every gesture.
//
// RED AT THE INSTRUMENT COMMIT (before `labelBoxStays`), recorded in
// 76-08-SUMMARY.md: leg 1 failed "CANVAS CENSUS after the Redo: the machine layer draws a
// root on each machine handle [0], a box on each label handle [], and nothing else",
// received `labels: [0]`, with every PRECONDITION and the whole post-Undo check passing
// (handles measured: label 0 and Source 1 after the Undo, Source 0 after the Redo). The
// Load step was reworked earlier and is unchanged up to that failure.
//
// THE ONE PRODUCT IMPORT is `KIND_NAMES` from `../shared/kindNames`, as
// `11-machine-labels.spec.ts` imports it: a dependency-free values module outside `src/`
// (that spec's GATE-01 note says why it costs the zero-mock audit nothing). Everything
// else is a spec-local literal, the label kind byte 11 among them.

/** The label kind byte (protocol `machine_kind::LABEL`). */
const KIND_LABEL = 11;
/** The Source kind byte (protocol `machine_kind::SOURCE`). */
const KIND_SOURCE = 0;
/** The Sink kind byte (protocol `machine_kind::SINK`). */
const KIND_SINK = 7;
/** One cell in world px (`shared/geometry.ts` CELL). */
const CELL_PX = 32;
/** The box's inset from the cell edges, world px (UI-SPEC 3.4, the chassis inset). */
const BOX_INSET = 4;
/** The six label colours by byte (UI-SPEC 3.1, `LABEL_COLOURS` through the locked skin). */
const LABEL_COLOUR_OF: Readonly<Record<number, number>> = {
  0: 0xe0d388, // sand
  1: 0xa19d95, // stone
  2: 0xa3c27f, // moss
  3: 0xbea2ea, // lilac
  4: 0xe39ac0, // rose
  5: 0xd68c6c, // clay
};
/** The art subject each machine kind byte draws (`SUBJECT_OF` in `machines.ts`), for the
 *  kinds this spec places. A kind outside it fails the leg loudly. */
const GLYPH_SUBJECT_OF: Readonly<Record<number, string>> = {
  0: 'source',
  7: 'sink',
};
/** Lilac's colour byte. */
const LILAC_BYTE = 3;
/** The words the label carries. */
const WORDS = 'Ghost words';
/** Leg 2's words. */
const MIRROR_WORDS = 'Mirror words';
/** Leg 3's words. */
const LOAD_WORDS = 'Order intake';

/** An empty board at camera scale 1. The only helper in this spec that calls `newBoard`. */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'PRECONDITION: the camera is at scale 1').toBe(1);
}

/** Click empty floor a few px off a cell centre (blurs the panel, clears the selection). */
async function clickFloor(page: Page): Promise<void> {
  const floor = await screenCellCentre(page, 4, 6);
  await page.mouse.click(floor.x + 3, floor.y - 2);
}

/** Ascending ids of `nodes`. */
function idsOf(nodes: SceneFacts['nodes']): number[] {
  return nodes.map((n) => n.id).sort((a, b) => a - b);
}

/** What the `[data-testid=<testid>]` elements that are VISIBLE show: connected, not
 *  `visibility: hidden`, with a non-empty box (Playwright's visibility rule), read in ONE
 *  page evaluation so an element swapped mid-read cannot race the poll. */
async function visibleOverlay(page: Page, testid: string): Promise<{ node: string | null; text: string }[]> {
  return page.evaluate((id) => {
    return Array.from(document.querySelectorAll(`[data-testid="${id}"]`))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return getComputedStyle(el).visibility === 'visible' && r.width > 0 && r.height > 0;
      })
      .map((el) => ({ node: el.getAttribute('data-node'), text: el.textContent ?? '' }));
  }, testid);
}

/**
 * THE BOARD DRAWS THE SCENE: read the scene once, then grade the canvas census, every
 * handle's label box, every machine's drawn art, the name chips and the words, in that
 * order, each under its own message prefix. `context` names the gesture just made.
 */
async function expectBoardDrawsTheScene(page: Page, context: string): Promise<void> {
  const scene = await readScene(page);
  const labels = scene.nodes.filter((n) => n.kind === KIND_LABEL);
  const machines = scene.nodes.filter((n) => n.kind !== KIND_LABEL);

  // (a) The display list holds exactly the scene.
  await expect
    .poll(async () => drawnNodesOf(page), {
      message: `CANVAS CENSUS ${context}: the machine layer draws a root on each machine handle ${JSON.stringify(idsOf(machines))}, a box on each label handle ${JSON.stringify(idsOf(labels))}, and nothing else`,
    })
    .toEqual({ machines: idsOf(machines), labels: idsOf(labels), strays: 0 });

  // (b) No box on a machine handle; every label's box on its cells, in its colour.
  for (const n of machines) {
    await expect
      .poll(async () => labelBoxOn(page, n.id), {
        message: `LABEL BOX ${context}: no label box is drawn on machine handle ${n.id} (kind ${n.kind})`,
      })
      .toBeNull();
  }
  for (const n of labels) {
    const byte = n.label?.colour;
    const colour = byte === undefined ? undefined : LABEL_COLOUR_OF[byte];
    expect(colour, `LABEL BOX ${context}: label ${n.id} carries a colour byte in the six-colour table (read ${JSON.stringify(n.label)})`).toBeDefined();
    const xs = n.cells.map(([x]) => x);
    const ys = n.cells.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    await expect
      .poll(async () => labelBoxOn(page, n.id), {
        message: `LABEL BOX ${context}: label ${n.id} is drawn as its box on cells (${minX},${minY})..(${maxX},${maxY}) in 0x${colour!.toString(16)}`,
      })
      .toMatchObject({
        instructions: 2,
        fill: { color: colour, alpha: 0.16 },
        stroke: { color: colour, alpha: 1 },
        rect: {
          x: minX * CELL_PX + BOX_INSET,
          y: minY * CELL_PX + BOX_INSET,
          w: (maxX - minX + 1) * CELL_PX - 2 * BOX_INSET,
          h: (maxY - minY + 1) * CELL_PX - 2 * BOX_INSET,
        },
      });
  }

  // (c) Every machine root draws its own kind's art.
  for (const n of machines) {
    const want = GLYPH_SUBJECT_OF[n.kind];
    expect(want, `DRAWN KIND ${context}: machine kind ${n.kind} on handle ${n.id} is in this spec's art table`).toBeDefined();
    await expect
      .poll(async () => glyphSubjectOn(page, n.id), {
        message: `DRAWN KIND ${context}: the root on handle ${n.id} draws the ${want} art (kind ${n.kind})`,
      })
      .toBe(want);
  }

  // (d) The visible name chips are the scene's machines, by count and by name.
  const wantChips = machines.map((n) => KIND_NAMES[n.kind] ?? `kind ${n.kind}`).sort();
  await expect
    .poll(async () => (await visibleOverlay(page, 'machine-label')).map((c) => c.text).sort(), {
      message: `DOM CHIPS ${context}: the visible name chips read ${JSON.stringify(wantChips)}`,
    })
    .toEqual(wantChips);

  // (e) The visible words are the labels that carry words, each reading its own.
  const wantWords = labels
    .filter((n) => (n.label?.text ?? '') !== '')
    .map((n) => ({ node: String(n.id), text: n.label!.text }))
    .sort((a, b) => Number(a.node) - Number(b.node));
  await expect
    .poll(
      async () =>
        (await visibleOverlay(page, 'label-words')).sort((a, b) => Number(a.node) - Number(b.node)),
      { message: `DOM WORDS ${context}: the visible words are ${JSON.stringify(wantWords)}` },
    )
    .toEqual(wantWords);
}

test.describe('CR-01 live: a keyframe that remints handles leaves no ghost on the board', () => {
  test('leg 1: a label\'s handle handed to a Source by a Redo and by a Load leaves no label box, chip or words behind', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const savePath = join(tmpdir(), `fabrico-e2e-handle-reuse-${Date.now()}.fab`);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before Names is pressed');

    // Names on, so the chips are mounted for DOM CHIPS to grade.
    const names = page.getByRole('button', { name: 'Names', exact: true });
    await expect(names, 'PRECONDITION: Names starts off').toHaveAttribute('aria-pressed', 'false');
    await names.click();
    await expect(names, 'PRECONDITION: Names is on').toHaveAttribute('aria-pressed', 'true');

    // A Lilac label carrying words, in one Apply.
    await handPlaceAt(page, 'Label', 10, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a label anchored at (10,12)',
    }).toBe(KIND_LABEL);
    await expectRenderLoopAlive(page, 'after the label is placed');
    await expect(page.locator('#fab-label-text'), 'PRECONDITION: the placed label focuses its Text field').toBeFocused();
    await page.keyboard.type(WORDS);
    await page.getByRole('button', { name: 'Lilac', exact: true }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.label ?? null, {
      message: 'PRECONDITION: the host holds the label with its words and the Lilac byte',
    }).toEqual({ text: WORDS, colour: LILAC_BYTE });
    await expectRenderLoopAlive(page, 'after the Apply');

    // A Source beside it.
    await clickFloor(page);
    await handPlaceAt(page, 'Source', 18, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 18, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a Source anchored at (18,12)',
    }).toBe(KIND_SOURCE);
    await page.keyboard.press('Escape');
    await expectRenderLoopAlive(page, 'after the Source is placed');

    // Select the label with a plain click off-centre on its box, then the Delete key.
    await clickFloor(page);
    const onBox = await screenCellCentre(page, 12, 12);
    await page.mouse.click(onBox.x + 3, onBox.y - 2);
    await expect(page.locator('#fab-label-width'), 'PRECONDITION: the click selected the label (its panel is open)').toHaveText('4');
    await page.keyboard.press('Delete');
    await pollScene(page, (s) => s.nodes.map((n) => n.kind), {
      message: 'PRECONDITION: the Delete key left the Source alone on the board',
    }).toEqual([KIND_SOURCE]);
    await expectRenderLoopAlive(page, 'after the Delete');

    // Ctrl+Z: the label is back, on the lower handle.
    await clickFloor(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => s.nodes.length, { message: 'PRECONDITION: Ctrl+Z put the label back' }).toBe(2);
    const undone = await readScene(page);
    const labelHandle = undone.nodes.find((n) => n.kind === KIND_LABEL)?.id;
    const sourceHandle = undone.nodes.find((n) => n.kind === KIND_SOURCE)?.id;
    console.log(`HANDLES after the Undo: label=${labelHandle} source=${sourceHandle}`);
    expect(
      labelHandle !== undefined && sourceHandle !== undefined && labelHandle < sourceHandle,
      `PRECONDITION: after the Undo the label holds the lower handle (label ${labelHandle}, Source ${sourceHandle})`,
    ).toBe(true);
    await expectRenderLoopAlive(page, 'after the Undo');
    await expectBoardDrawsTheScene(page, 'after the Undo');

    // Ctrl+Shift+Z: the Source alone, on the handle the label held.
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => s.nodes.length, { message: 'PRECONDITION: Ctrl+Shift+Z deleted the label again' }).toBe(1);
    const redone = (await readScene(page)).nodes[0];
    console.log(`HANDLES after the Redo: source=${redone.id}`);
    expect(
      { kind: redone.kind, id: redone.id },
      'PRECONDITION: after the Redo the Source holds the handle the label held (the handle changed kind)',
    ).toEqual({ kind: KIND_SOURCE, id: labelHandle });
    await expectRenderLoopAlive(page, 'after the Redo');
    await expectBoardDrawsTheScene(page, 'after the Redo');

    // Save the one-Source board to a real file.
    await clickFloor(page);
    page.once('dialog', (d) => d.accept(savePath));
    await page.keyboard.press('Control+s');
    await expect
      .poll(() => existsSync(savePath), {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: 'PRECONDITION: the host wrote the .fab file',
      })
      .toBe(true);
    await expectRenderLoopAlive(page, 'after the save');

    // The toolbar New: an empty board, handles restarting at 0.
    const tickBeforeNew = (await readScene(page)).tick;
    const dirtyBeforeNew = await guardWillAsk(page);
    await page.getByTitle('New board (Ctrl+N)').click();
    if (dirtyBeforeNew) await page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' }).click();
    await pollScene(page, (s) => s.nodes.length === 0 && s.tick < tickBeforeNew, {
      message: 'PRECONDITION: New put up an empty board (its tick restarted)',
    }).toBe(true);
    await expectRenderLoopAlive(page, 'after the New');

    // A second label with the same words and colour, on the fresh board's lowest handle.
    await handPlaceAt(page, 'Label', 10, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed the second label anchored at (10,12)',
    }).toBe(KIND_LABEL);
    await expect(page.locator('#fab-label-text'), 'PRECONDITION: the second label focuses its Text field').toBeFocused();
    await page.keyboard.type(WORDS);
    await page.getByRole('button', { name: 'Lilac', exact: true }).click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.label ?? null, {
      message: 'PRECONDITION: the host holds the second label with its words and the Lilac byte',
    }).toEqual({ text: WORDS, colour: LILAC_BYTE });
    await clickFloor(page);
    const beforeLoad = nodeAtAnchor(await readScene(page), 10, 12)!.id;
    console.log(`HANDLES before the Load: label=${beforeLoad}`);
    await expect(names, 'PRECONDITION: Names is still on').toHaveAttribute('aria-pressed', 'true');
    await expectRenderLoopAlive(page, 'after the second label is applied');
    await expectBoardDrawsTheScene(page, 'before the Load');

    // Load the saved one-Source board over it, through the discard guard when it opens.
    const dirty = await guardWillAsk(page);
    page.once('dialog', (d) => d.accept(savePath));
    await page.getByTitle('Load a saved factory').click();
    if (dirty) await page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' }).click();
    await pollScene(page, (s) => s.nodes.map((n) => n.kind), {
      message: 'PRECONDITION: the Load put the saved one-Source board up',
    }).toEqual([KIND_SOURCE]);
    const loaded = (await readScene(page)).nodes[0];
    console.log(`HANDLES after the Load: source=${loaded.id}`);
    expect(loaded.id, 'PRECONDITION: after the Load the Source holds the handle the label held').toBe(beforeLoad);
    await resetZoomToActualSize(page);
    await expect(names, 'PRECONDITION: Names is still on after the Load').toHaveAttribute('aria-pressed', 'true');
    await expectRenderLoopAlive(page, 'after the Load');
    await expectBoardDrawsTheScene(page, 'after the Load');

    rmSync(savePath, { force: true });
    errs.assertNone('across place, configure, delete, undo, redo, save, new and load');
  });

  test('leg 2: a Source\'s handle handed to a label by a Redo leaves no machine root, chip or nub behind', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before Names is pressed');

    const names = page.getByRole('button', { name: 'Names', exact: true });
    await expect(names, 'PRECONDITION: Names starts off').toHaveAttribute('aria-pressed', 'false');
    await names.click();
    await expect(names, 'PRECONDITION: Names is on').toHaveAttribute('aria-pressed', 'true');

    // The Source first, so it takes the lower NodeId.
    await handPlaceAt(page, 'Source', 18, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 18, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a Source anchored at (18,12)',
    }).toBe(KIND_SOURCE);
    await page.keyboard.press('Escape');
    await expectRenderLoopAlive(page, 'after the Source is placed');

    // A label carrying words beside it.
    await clickFloor(page);
    await handPlaceAt(page, 'Label', 10, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a label anchored at (10,12)',
    }).toBe(KIND_LABEL);
    await expect(page.locator('#fab-label-text'), 'PRECONDITION: the placed label focuses its Text field').toBeFocused();
    await page.keyboard.type(MIRROR_WORDS);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.label?.text ?? null, {
      message: 'PRECONDITION: the host holds the label with its words',
    }).toBe(MIRROR_WORDS);
    await expectRenderLoopAlive(page, 'after the Apply');

    // Select the Source with a plain click on its cell, then the Delete key.
    await clickFloor(page);
    await selectMachineAt(page, 18, 12);
    await page.keyboard.press('Delete');
    await pollScene(page, (s) => s.nodes.map((n) => n.kind), {
      message: 'PRECONDITION: the Delete key left the label alone on the board',
    }).toEqual([KIND_LABEL]);
    await expectRenderLoopAlive(page, 'after the Delete');

    // Ctrl+Z: the Source is back, on the lower handle.
    await clickFloor(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => s.nodes.length, { message: 'PRECONDITION: Ctrl+Z put the Source back' }).toBe(2);
    const undone = await readScene(page);
    const sourceHandle = undone.nodes.find((n) => n.kind === KIND_SOURCE)?.id;
    const labelHandle = undone.nodes.find((n) => n.kind === KIND_LABEL)?.id;
    console.log(`HANDLES after the Undo: source=${sourceHandle} label=${labelHandle}`);
    expect(
      sourceHandle !== undefined && labelHandle !== undefined && sourceHandle < labelHandle,
      `PRECONDITION: after the Undo the Source holds the lower handle (Source ${sourceHandle}, label ${labelHandle})`,
    ).toBe(true);
    await expectRenderLoopAlive(page, 'after the Undo');
    await expectBoardDrawsTheScene(page, 'after the Undo');

    // Ctrl+Shift+Z: the label alone, on the handle the Source held.
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => s.nodes.length, { message: 'PRECONDITION: Ctrl+Shift+Z deleted the Source again' }).toBe(1);
    const redone = (await readScene(page)).nodes[0];
    console.log(`HANDLES after the Redo: label=${redone.id}`);
    expect(
      { kind: redone.kind, id: redone.id },
      'PRECONDITION: after the Redo the label holds the handle the Source held (the handle changed kind)',
    ).toEqual({ kind: KIND_LABEL, id: sourceHandle });
    await expectRenderLoopAlive(page, 'after the Redo');
    await expectBoardDrawsTheScene(page, 'after the Redo');

    errs.assertNone('across place, configure, delete, undo and redo');
  });

  test('leg 3: a label-lowest board Loaded straight over a machine-lowest one leaves no machine root behind', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const savePath = join(tmpdir(), `fabrico-e2e-handle-reuse-${Date.now()}.fab`);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before Names is pressed');

    const names = page.getByRole('button', { name: 'Names', exact: true });
    await expect(names, 'PRECONDITION: Names starts off').toHaveAttribute('aria-pressed', 'false');
    await names.click();
    await expect(names, 'PRECONDITION: Names is on').toHaveAttribute('aria-pressed', 'true');

    // The board to save: a label carrying words (lowest), then a Source.
    await handPlaceAt(page, 'Label', 10, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a label anchored at (10,12)',
    }).toBe(KIND_LABEL);
    await expect(page.locator('#fab-label-text'), 'PRECONDITION: the placed label focuses its Text field').toBeFocused();
    await page.keyboard.type(LOAD_WORDS);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.label?.text ?? null, {
      message: 'PRECONDITION: the host holds the label with its words',
    }).toBe(LOAD_WORDS);
    await clickFloor(page);
    await handPlaceAt(page, 'Source', 18, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 18, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a Source anchored at (18,12)',
    }).toBe(KIND_SOURCE);
    await page.keyboard.press('Escape');
    await clickFloor(page);
    await expectRenderLoopAlive(page, 'after the board to save is built');

    page.once('dialog', (d) => d.accept(savePath));
    await page.keyboard.press('Control+s');
    await expect
      .poll(() => existsSync(savePath), {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: 'PRECONDITION: the host wrote the .fab file',
      })
      .toBe(true);
    await expectRenderLoopAlive(page, 'after the save');

    // A machine-lowest board: New, then one Source at (4,4).
    await newBoard(page);
    if ((await names.getAttribute('aria-pressed')) !== 'true') await names.click();
    await expect(names, 'PRECONDITION: Names is on after the New').toHaveAttribute('aria-pressed', 'true');
    await handPlaceAt(page, 'Source', 4, 4);
    await pollScene(page, (s) => nodeAtAnchor(s, 4, 4)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a Source anchored at (4,4)',
    }).toBe(KIND_SOURCE);
    await page.keyboard.press('Escape');
    await clickFloor(page);
    const machineBoard = await readScene(page);
    const lowest = Math.min(...machineBoard.nodes.map((n) => n.id));
    const lowestKind = machineBoard.nodes.find((n) => n.id === lowest)?.kind;
    console.log(`HANDLES before the Load: lowest=${lowest} kind=${lowestKind}`);
    expect(lowestKind, 'PRECONDITION: the lowest handle before the Load is a machine').not.toBe(KIND_LABEL);
    await expectRenderLoopAlive(page, 'after the (4,4) Source is placed');
    await expectBoardDrawsTheScene(page, 'before the Load');

    // NO New here: Load the saved board straight over this one, through the discard guard.
    const dirty = await guardWillAsk(page);
    page.once('dialog', (d) => d.accept(savePath));
    await page.getByTitle('Load a saved factory').click();
    if (dirty) await page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' }).click();
    await pollScene(
      page,
      (s) =>
        nodeAtAnchor(s, 10, 12)?.kind === KIND_LABEL &&
        nodeAtAnchor(s, 18, 12)?.kind === KIND_SOURCE &&
        nodeAtAnchor(s, 4, 4) === undefined &&
        s.nodes.length === 2,
      { message: 'PRECONDITION: the Load put the saved label and Source up and nothing at (4,4)' },
    ).toBe(true);
    const loaded = await readScene(page);
    const labelId = nodeAtAnchor(loaded, 10, 12)!.id;
    console.log(`HANDLES after the Load: label=${labelId} source=${nodeAtAnchor(loaded, 18, 12)!.id}`);
    expect(
      { lowest: Math.min(...loaded.nodes.map((n) => n.id)), label: labelId },
      'PRECONDITION: after the Load the label is the lowest handle, the one the (4,4) Source held',
    ).toEqual({ lowest, label: lowest });
    await resetZoomToActualSize(page);
    await expect(names, 'PRECONDITION: Names is still on after the Load').toHaveAttribute('aria-pressed', 'true');
    await expectRenderLoopAlive(page, 'after the Load');
    await expectBoardDrawsTheScene(page, 'after the Load');
    await expect.poll(async () => (await labelWordsOf(page, labelId))?.text ?? null, {
      message: `the loaded label ${labelId} reads its words`,
    }).toBe(LOAD_WORDS);
    await expect(page.locator('[data-testid="label-words"]'), 'exactly one words element').toHaveCount(1);

    rmSync(savePath, { force: true });
    errs.assertNone('across place, configure, save, new, place and load');
  });

  // Leg 4 grades a line that shipped before it (the WR-07 glyph re-point), so it was green
  // at its own commit by design. Mutation G (plan 76-13 Task 3, the re-point statement
  // deleted in a throwaway worktree) is its bite proof: it fails this leg alone, on DRAWN
  // KIND after the Redo, with no CANVAS CENSUS and no LABEL BOX line.
  test('leg 4: a Source\'s handle handed to a Sink by a Redo draws the Sink\'s art, not the Source\'s', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await emptyBoardAtScaleOne(page);
    await expectRenderLoopAlive(page, 'before Names is pressed');

    const names = page.getByRole('button', { name: 'Names', exact: true });
    await expect(names, 'PRECONDITION: Names starts off').toHaveAttribute('aria-pressed', 'false');
    await names.click();
    await expect(names, 'PRECONDITION: Names is on').toHaveAttribute('aria-pressed', 'true');

    // The Source first, so it takes the lower NodeId; then the Sink.
    await handPlaceAt(page, 'Source', 10, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 10, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a Source anchored at (10,12)',
    }).toBe(KIND_SOURCE);
    await page.keyboard.press('Escape');
    await expectRenderLoopAlive(page, 'after the Source is placed');

    await clickFloor(page);
    await handPlaceAt(page, 'Sink', 18, 12);
    await pollScene(page, (s) => nodeAtAnchor(s, 18, 12)?.kind ?? null, {
      message: 'PRECONDITION: the real host echoed a Sink anchored at (18,12)',
    }).toBe(KIND_SINK);
    await page.keyboard.press('Escape');
    await expectRenderLoopAlive(page, 'after the Sink is placed');

    // Select the Source with a plain click on its cell, then the Delete key.
    await clickFloor(page);
    await selectMachineAt(page, 10, 12);
    await page.keyboard.press('Delete');
    await pollScene(page, (s) => s.nodes.map((n) => n.kind), {
      message: 'PRECONDITION: the Delete key left the Sink alone on the board',
    }).toEqual([KIND_SINK]);
    await expectRenderLoopAlive(page, 'after the Delete');

    // Ctrl+Z: the Source is back, on the lower handle, the Sink on the higher.
    await clickFloor(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => s.nodes.length, { message: 'PRECONDITION: Ctrl+Z put the Source back' }).toBe(2);
    const undone = await readScene(page);
    const sourceHandle = undone.nodes.find((n) => n.kind === KIND_SOURCE)?.id;
    const sinkHandle = undone.nodes.find((n) => n.kind === KIND_SINK)?.id;
    console.log(`HANDLES after the Undo: source=${sourceHandle} sink=${sinkHandle}`);
    expect(
      sourceHandle !== undefined && sinkHandle !== undefined && sourceHandle < sinkHandle,
      `PRECONDITION: after the Undo the Source holds the lower handle and the Sink the higher (Source ${sourceHandle}, Sink ${sinkHandle})`,
    ).toBe(true);
    await expectRenderLoopAlive(page, 'after the Undo');
    await expectBoardDrawsTheScene(page, 'after the Undo');

    // Ctrl+Shift+Z: the Sink alone, on the handle the Source held.
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => s.nodes.length, { message: 'PRECONDITION: Ctrl+Shift+Z deleted the Source again' }).toBe(1);
    const redone = (await readScene(page)).nodes[0];
    console.log(`HANDLES after the Redo: sink=${redone.id}`);
    expect(
      { kind: redone.kind, id: redone.id },
      'PRECONDITION: after the Redo the Sink holds the handle the Source held (the handle changed machine kind)',
    ).toEqual({ kind: KIND_SINK, id: sourceHandle });
    await expectRenderLoopAlive(page, 'after the Redo');
    await expectBoardDrawsTheScene(page, 'after the Redo');

    errs.assertNone('across place, delete, undo and redo');
  });
});
