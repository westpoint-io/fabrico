import { test, expect, type Page } from '@playwright/test';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import { EMPTY_FLOOR_HEADING } from '../src/chrome/configCopy';
import { DELETE_AND_UNDO } from '../src/tutorial/lessons/deleteAndUndo';
import { noteTokens } from '../src/tutorial/machine';
import { phrasePlain } from '../src/tutorial/phrase';
import { CELL, buildPacket, screenCellCentre, type Harness } from './support/wire';
import {
  CARD,
  LINE_BELT_ID,
  OUTSET,
  SINK_DEBUG,
  SOURCE_TIMER,
  SOURCE_WEBHOOK,
  boot,
  buildLine,
  centreOf,
  configByNode,
  deleteBelt,
  deletesSent,
  expectAt,
  expectCaptureComplete,
  pressRing,
  readProbe,
  reminted,
  ringAt,
  selectedBelt,
  selectedNode,
  startLesson,
  undosSent,
  type LineBoard,
} from './support/lessonMock';

// lesson-delete.spec.ts - lesson 3, Delete and Undo, on a mock host.
//
// The walk on the real host plays lesson 3 the way it's meant to go, and it can't make the rare cases
// happen on purpose: a Sink deleted before its belt, an Undo that takes the draw back, the app's delete
// guard. The mock host can, because a case decides every packet the board gets. So this spec reads
// what the user sees in those cases: the card's step, its note, the ring and the controls under it.
// Stage and step ids come from the lesson's own data through `stageOf`, so a renamed stage fails here
// by name, and the card's words are the lesson's tokens read through the real tables.

const LESSON = DELETE_AND_UNDO;
const STEPS = LESSON.steps.length;

/** A stage id, checked against the lesson's data: a renamed or moved stage throws here, by name. */
function stageOf(stepId: string, id: string): string {
  const step = LESSON.steps.find((s) => s.id === stepId);
  if (step === undefined) throw new Error(`${LESSON.id} has no step ${stepId}`);
  if (!step.stages.some((stage) => stage.id === id)) throw new Error(`${LESSON.id} step ${stepId} has no stage ${id}`);
  return id;
}

/** A step's id, checked the same way. */
function stepOf(id: string): string {
  if (!LESSON.steps.some((s) => s.id === id)) throw new Error(`${LESSON.id} has no step ${id}`);
  return id;
}

/** What the card says at a stage, through the real key and machine tables. */
function wordsOf(stepId: string, id: string): string {
  const stage = LESSON.steps.find((s) => s.id === stepId)?.stages.find((st) => st.id === id);
  if (stage === undefined) throw new Error(`${LESSON.id} step ${stepId} has no stage ${id}`);
  return phrasePlain(stage.text);
}

const STEP = {
  placeSource: stepOf('place-source'),
  placeSink: stepOf('place-sink'),
  drawBelt: stepOf('draw-belt'),
  deleteBelt: stepOf('delete-belt'),
  deleteSink: stepOf('delete-sink'),
  bringBack: stepOf('bring-back'),
};

const STAGE = {
  sourceTool: stageOf(STEP.placeSource, 'source-tool'),
  sourceFloor: stageOf(STEP.placeSource, 'source-floor'),
  sinkTool: stageOf(STEP.placeSink, 'sink-tool'),
  sinkFloor: stageOf(STEP.placeSink, 'sink-floor'),
  beltTool: stageOf(STEP.drawBelt, 'belt-tool'),
  beltDraw: stageOf(STEP.drawBelt, 'belt-draw'),
  toolDown: stageOf(STEP.deleteBelt, 'tool-down'),
  selectBelt: stageOf(STEP.deleteBelt, 'select-belt'),
  pressDeleteBelt: stageOf(STEP.deleteBelt, 'press-delete'),
  selectSink: stageOf(STEP.deleteSink, 'select-sink'),
  pressDeleteSink: stageOf(STEP.deleteSink, 'press-delete'),
  undoSink: stageOf(STEP.bringBack, 'undo-sink'),
  undoBelt: stageOf(STEP.bringBack, 'undo-belt'),
};

const BELT_ID = LINE_BELT_ID;
type Board = LineBoard;
const FLOOR = 1;

/** What a press at this point would land on, by the names a case reads. */
async function hitAt(page: Page, at: { x: number; y: number }): Promise<{ tag: string; inLayer: boolean; bin: boolean }> {
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return {
      tag: el?.tagName ?? 'none',
      inLayer: el?.closest('[data-fab-hint-layer]') != null,
      bin: el?.closest('button[aria-label="Delete machine"]') != null,
    };
  }, [at.x, at.y] as const);
}

/** The words of a lesson note, through the real tables. */
function noteWords(kind: 'wentBack' | 'skippedOne', step: number): string {
  return phrasePlain(noteTokens({ kind, a: step, b: step }));
}

/** Start lesson 3, zoom out and build the line, then put the Belt tool down: the card at select-belt. */
async function toSelectBelt(page: Page, opts: Parameters<typeof boot>[1] = {}): Promise<{ h: Harness; host: ReturnType<typeof configByNode>; board: Board }> {
  const host = configByNode();
  const h = await boot(page, { ...host.opts, ...opts });
  await startLesson(page, h, LESSON);
  const board = await buildLine(page, h, host);
  await expectCaptureComplete(page);
  await page.keyboard.press('Escape');
  await ringAt(page, STAGE.selectBelt);
  return { h, host, board };
}

test.describe('lesson 3 on the mock host', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('plays from Start to Lesson done, through two deletes and two Undo keyframes', async ({ page }) => {
    const host = configByNode();
    const h = await boot(page, host.opts);
    await startLesson(page, h, LESSON);
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 1 of ${STEPS}`);

    // Steps 1 to 3.
    const board = await buildLine(page, h, host);
    let { tick } = board;
    await expectCaptureComplete(page);

    // Step 4: the tool goes down, the belt is selected through its ring, and Delete takes it off.
    await page.keyboard.press('Escape');
    const beltRing = await ringAt(page, STAGE.selectBelt);
    await expect(card).toContainText(`Step 4 of ${STEPS}`);
    await expect(card).toContainText(wordsOf(STEP.deleteBelt, STAGE.selectBelt));
    await pressRing(page, beltRing);
    await expect.poll(() => selectedBelt(page), { message: 'the press on the belt ring selected the belt' }).toBe(BELT_ID);
    await expectAt(page, STEP.deleteBelt, STAGE.pressDeleteBelt, 'a selected belt moves the card to the Delete key');
    await expect(card).toContainText(wordsOf(STEP.deleteBelt, STAGE.pressDeleteBelt));
    await page.keyboard.press('Delete');
    await expect.poll(() => deletesSent(h), { message: 'Delete sent the belt\'s delete' }).toEqual([BELT_ID]);
    h.inject(buildPacket({ full: false, tick: ++tick, generation: 1, swapFloor: FLOOR, removed: [BELT_ID], canUndo: true }));
    await expectAt(page, STEP.deleteSink, STAGE.selectSink, 'the belt gone finished delete-belt');
    let probe = await readProbe(page);
    expect(probe.noteKind, 'a delete leaves no note on the card').toBe('');
    await expect(card).toContainText(`Step 5 of ${STEPS}`);
    await expect(card).toContainText(wordsOf(STEP.deleteSink, STAGE.selectSink));

    // Step 5: the Sink through its ring, then Backspace, the delete key's other name.
    await pressRing(page, await ringAt(page, STAGE.selectSink));
    await expect.poll(() => selectedNode(page), { message: 'the press on the Sink ring selected the Sink' }).toBe(board.sink.id);
    await expectAt(page, STEP.deleteSink, STAGE.pressDeleteSink, 'a selected Sink moves the card to the Delete key');
    await page.keyboard.press('Backspace');
    await expect.poll(() => deletesSent(h), { message: 'Backspace sent the Sink\'s delete' }).toEqual([BELT_ID, board.sink.id]);
    h.inject(buildPacket({ full: false, tick: ++tick, generation: 1, swapFloor: FLOOR, removed: [board.sink.id], canUndo: true }));
    await expectAt(page, STEP.bringBack, STAGE.undoSink, 'the Sink gone finished delete-sink');
    probe = await readProbe(page);
    expect(probe.noteKind, 'the second delete leaves no note either').toBe('');
    await expect(card).toContainText(`Step 6 of ${STEPS}`);
    await expect(card).toContainText(wordsOf(STEP.bringBack, STAGE.undoSink));

    // Step 6, first Undo: the toolbar's button, under the ring. The keyframe re-mints every handle.
    const undo = page.locator('header button[aria-label="Undo"]');
    await expect(undo, 'the packet says there is something to undo').toBeEnabled();
    const undoRing = await ringAt(page, STAGE.undoSink);
    const undoBox = await undo.boundingBox();
    expect(undoBox, 'the Undo button is on screen').not.toBeNull();
    expect(Math.abs(centreOf(undoRing).x - (undoBox!.x + undoBox!.width / 2)), 'the ring is on the Undo button').toBeLessThanOrEqual(1);
    await pressRing(page, undoRing);
    await expect.poll(() => undosSent(h), { message: 'the Undo button sent an Undo' }).toBe(1);
    const first = reminted({ nodes: [board.source, board.sink] }, 10);
    for (const [node, config] of [[first.nodes[0]!.id, SOURCE_WEBHOOK], [first.nodes[1]!.id, SINK_DEBUG]] as const) host.set(node, config);
    h.inject(buildPacket({ full: true, tick: ++tick, generation: 2, swapFloor: FLOOR, nodes: first.nodes, canUndo: true, canRedo: true }));
    await expectAt(page, STEP.bringBack, STAGE.undoBelt, 'the Sink back moved the card to the belt');
    await expect.poll(async () => (await readProbe(page)).bound.sink, { message: 'the Sink binding follows its new handle' }).toBe(first.nodes[1]!.id);
    await expect(card).toContainText(wordsOf(STEP.bringBack, STAGE.undoBelt));
    const beltUndoRing = await ringAt(page, STAGE.undoBelt);
    expect(Math.abs(centreOf(beltUndoRing).x - (undoBox!.x + undoBox!.width / 2)), 'the ring stays on the Undo button').toBeLessThanOrEqual(1);

    // Second Undo: Ctrl+Z, and the belt comes back joined at both ends, under new handles again.
    await page.keyboard.press('Control+z');
    await expect.poll(() => undosSent(h), { message: 'Ctrl+Z sent the second Undo' }).toBe(2);
    const second = reminted({ nodes: [board.source, board.sink], belts: [board.belt] }, 20);
    for (const [node, config] of [[second.nodes[0]!.id, SOURCE_WEBHOOK], [second.nodes[1]!.id, SINK_DEBUG]] as const) host.set(node, config);
    h.inject(buildPacket({ full: true, tick: ++tick, generation: 3, swapFloor: FLOOR, nodes: second.nodes, belts: second.belts, canUndo: true, canRedo: true }));
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the line back as it was finished the lesson' }).toBe('finished');
    await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
    await expect(card).toContainText(phrasePlain(LESSON.closing));
    await expect(card).not.toContainText(/Step \d/);
    await expect(page.locator('[data-fab-hint]'), 'no ring on a finished lesson').toBeHidden();
  });
  test('an Undo of the draw at select-belt is not a delete: the lesson goes back to step 3 and says so', async ({ page }) => {
    const { h, host, board } = await toSelectBelt(page);
    // Undo takes a draw back one command at a time, the docks first: the keyframe holds the belt with
    // no docks, every handle re-minted.
    await page.keyboard.press('Control+z');
    await expect.poll(() => undosSent(h), { message: 'Ctrl+Z sent an Undo' }).toBe(1);
    const back = reminted({ nodes: [board.source, board.sink], belts: [{ ...board.belt, docks: [] }] }, 10);
    host.set(back.nodes[0]!.id, SOURCE_WEBHOOK);
    host.set(back.nodes[1]!.id, SINK_DEBUG);
    h.inject(buildPacket({ full: true, tick: board.tick + 1, generation: 2, swapFloor: FLOOR, nodes: back.nodes, belts: back.belts, canUndo: true, canRedo: true }));
    await expect
      .poll(async () => (await readProbe(page)).stepId, { message: 'an Undo that takes the docks back sends the lesson to the draw, and leaves delete-belt unfinished' })
      .toBe(STEP.drawBelt);
    const probe = await readProbe(page);
    expect(probe.noteKind, 'the card says the lesson went back').toBe('wentBack');
    await expect(page.locator(CARD), 'with the note lesson 1 uses').toContainText(noteWords('wentBack', 3));
    await expect(page.locator(CARD), 'the card is back on step 3').toContainText(`Step 3 of ${STEPS}`);
  });

  test('an Undo that takes the whole belt at once is not a delete either', async ({ page }) => {
    // Two quick presses of Ctrl+Z can reach the app as one keyframe: the docks and the draw both gone.
    // The belt is off the board as a Delete would leave it, and only the generation says it was an Undo.
    const { h, host, board } = await toSelectBelt(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => undosSent(h), { message: 'Ctrl+Z sent an Undo' }).toBe(1);
    const back = reminted({ nodes: [board.source, board.sink] }, 10);
    host.set(back.nodes[0]!.id, SOURCE_WEBHOOK);
    host.set(back.nodes[1]!.id, SINK_DEBUG);
    h.inject(buildPacket({ full: true, tick: board.tick + 1, generation: 2, swapFloor: FLOOR, nodes: back.nodes, canUndo: true, canRedo: true }));
    await expect
      .poll(async () => (await readProbe(page)).stepId, { message: 'a belt undone, not deleted, sends the lesson back to the draw instead of on to the Sink' })
      .toBe(STEP.drawBelt);
    await expect(page.locator(CARD), 'the card says step 3 needs doing again').toContainText(noteWords('wentBack', 3));
  });

  test('a Delete moves the lesson on with no note', async ({ page }) => {
    const { h, board } = await toSelectBelt(page);
    await deleteBelt(page, h, board);
    const card = page.locator(CARD);
    await expect(card.locator('[data-fab-step-note]'), 'a deliberate delete leaves the note slot empty').toHaveCount(0);
    // The stream re-sends the last packet, so a note that came a few frames late would show by now.
    await page.waitForTimeout(500);
    const probe = await readProbe(page);
    expect(probe.noteKind, 'still no note a few frames later').toBe('');
    expect(probe.stepId, 'the card stays on the Sink step').toBe(STEP.deleteSink);
    await expect(card.locator('[data-fab-step-note]')).toHaveCount(0);
    await expect(card).not.toContainText('went back');
  });

  test('the Sink deleted first takes its belt, the card says step 5 was done, and one Undo finishes', async ({ page }) => {
    const { h, host, board } = await toSelectBelt(page);
    // The ring is on the belt; the user presses the Sink instead.
    const at = await screenCellCentre(page, board.sink.cell_x, board.sink.cell_y);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => selectedNode(page), { message: 'the press on the Sink selected it' }).toBe(board.sink.id);
    await page.keyboard.press('Delete');
    await expect.poll(() => deletesSent(h), { message: "Delete sent the Sink's delete" }).toEqual([board.sink.id]);
    // The host takes the belt docked to the Sink with it.
    h.inject(buildPacket({ full: false, tick: board.tick + 1, generation: 1, swapFloor: FLOOR, removed: [board.sink.id, BELT_ID], canUndo: true }));
    await expectAt(page, STEP.bringBack, STAGE.undoSink, 'the Sink and its belt gone finished both delete steps');
    const card = page.locator(CARD);
    expect((await readProbe(page)).noteKind, 'the card says step 5 was already done, as one step').toBe('skippedOne');
    await expect(card, 'the note says step 5 was already done').toContainText(noteWords('skippedOne', 5));
    await expect(card).toContainText(`Step 6 of ${STEPS}`);

    // One Undo puts both back.
    await pressRing(page, await ringAt(page, STAGE.undoSink));
    await expect.poll(() => undosSent(h), { message: 'the Undo button sent an Undo' }).toBe(1);
    const back = reminted({ nodes: [board.source, board.sink], belts: [board.belt] }, 10);
    host.set(back.nodes[0]!.id, SOURCE_WEBHOOK);
    host.set(back.nodes[1]!.id, SINK_DEBUG);
    h.inject(buildPacket({ full: true, tick: board.tick + 2, generation: 2, swapFloor: FLOOR, nodes: back.nodes, belts: back.belts, canUndo: true, canRedo: true }));
    await expect.poll(async () => (await readProbe(page)).card, { message: 'one Undo that brings both back finishes the lesson' }).toBe('finished');
    await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
  });

  test('with both deleted, only the Source is on the board, the empty-floor text stays hidden and the card says what to press', async ({ page }) => {
    const { h, board } = await toSelectBelt(page);
    await deleteBelt(page, h, board);
    await pressRing(page, await ringAt(page, STAGE.selectSink));
    await expectAt(page, STEP.deleteSink, STAGE.pressDeleteSink, 'a selected Sink moves the card to the Delete key');
    await page.keyboard.press('Delete');
    await expect.poll(() => deletesSent(h)).toEqual([BELT_ID, board.sink.id]);
    h.inject(buildPacket({ full: false, tick: board.tick + 1, generation: 1, swapFloor: FLOOR, removed: [board.sink.id], canUndo: true }));
    await expectAt(page, STEP.bringBack, STAGE.undoSink, 'the Sink gone finished delete-sink');

    const scene = await page.evaluate(() => {
      const s = (window as unknown as { __fabrico: { scene(): { nodes: { id: number; kind: number }[]; belts: unknown[] } } }).__fabrico.scene();
      return { nodes: s.nodes.map((n) => n.kind), belts: s.belts.length };
    });
    expect(scene, 'only the Source is left').toEqual({ nodes: [board.source.kind], belts: 0 });
    await expect(page.getByRole('heading', { name: EMPTY_FLOOR_HEADING }), 'the empty-floor text stays hidden while the lesson runs').toHaveCount(0);
    const text = page.locator(`${CARD} [data-fab-step-text]`);
    await expect(text, 'the card says to press the undo key or Undo in the toolbar').toHaveText(wordsOf(STEP.bringBack, STAGE.undoSink));
    await expect(text).toContainText('Ctrl+Z');
    await expect(text).toContainText('Undo in the toolbar');
    const undo = page.locator('header button[aria-label="Undo"]');
    await expect(undo, 'and that button can be pressed').toBeEnabled();
  });

  test('the belt ring sits on the middle tile, and a press there reaches the board', async ({ page }) => {
    const { board } = await toSelectBelt(page);
    const read = await page.evaluate(() => {
      const hook = (window as unknown as {
        __fabrico: { scene(): { belts: { id: number; tiles: { cell_x: number; cell_y: number }[] }[] }; camera(): { x: number; y: number; scale: number }; tutorial(): { hint: HintRect | null } };
      }).__fabrico;
      return { belts: hook.scene().belts, cam: hook.camera(), hint: hook.tutorial().hint };
    });
    const tiles = read.belts.find((b) => b.id === BELT_ID)?.tiles ?? [];
    expect(tiles.length, 'the drawn belt is five tiles long').toBe(5);
    expect(board.belt.tiles.length, 'the belt the case injected is the one the scene holds').toBe(5);
    const middle = tiles[Math.floor(tiles.length / 2)]!;
    const size = CELL * read.cam.scale;
    const want = { x: middle.cell_x * size + read.cam.x - OUTSET, y: middle.cell_y * size + read.cam.y - OUTSET, width: size + 2 * OUTSET, height: size + 2 * OUTSET };
    const hint = read.hint;
    expect(hint, 'the belt ring is placed').not.toBeNull();
    const error = Math.max(Math.abs(hint!.x - want.x), Math.abs(hint!.y - want.y), Math.abs(hint!.width - want.width), Math.abs(hint!.height - want.height));
    expect(error, `the ring marks the middle tile (${middle.cell_x},${middle.cell_y}), one cell plus 4 px a side; it read ${JSON.stringify(hint)}`).toBeLessThanOrEqual(1);
    const hit = await hitAt(page, centreOf(hint!));
    expect(hit.inLayer, 'at the ring centre, the ring layer takes no press').toBe(false);
    expect(hit.tag, 'at the ring centre, a press lands on the board').toBe('CANVAS');
  });

  test('the bin on the selected Sink takes its press under the ring, and deleting with it finishes the step', async ({ page }) => {
    const { h, board } = await toSelectBelt(page);
    await deleteBelt(page, h, board);
    const sinkRing = await ringAt(page, STAGE.selectSink);
    const onSink = await hitAt(page, centreOf(sinkRing));
    expect(onSink.inLayer, "at the Sink ring's centre, the ring layer takes no press").toBe(false);
    await pressRing(page, sinkRing);
    await expect.poll(() => selectedNode(page), { message: 'the press on the Sink ring selected the Sink' }).toBe(board.sink.id);
    const ring = await ringAt(page, STAGE.pressDeleteSink);
    const bin = page.getByRole('button', { name: 'Delete machine', exact: true });
    await expect(bin, 'the selected Sink shows its bin').toBeVisible();
    const box = await bin.boundingBox();
    if (box === null) throw new Error('the bin has no box');
    // The Sink's ring starts 4 px left of the cell and the bin ends 6 px left of the selection ring, so
    // at this zoom the ring's left edge runs a pixel or so under the bin's right edge. The bin paints over
    // the ring layer, and the layer takes no press, so the bin takes the press at its centre and on that strip.
    const overlap = Math.min(ring.x + ring.width, box.x + box.width) - Math.max(ring.x, box.x);
    expect(overlap, `the Sink's ring crosses the bin's edge at this zoom (ring ${JSON.stringify(ring)}, bin ${JSON.stringify(box)})`).toBeGreaterThan(0);
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const strip = { x: Math.max(ring.x, box.x) + overlap / 2, y: centre.y };
    for (const [where, at] of [["the bin's centre", centre], ['where the ring crosses the bin', strip]] as const) {
      const hit = await hitAt(page, at);
      expect(hit.bin, `a press at ${where} lands on the bin (it read ${hit.tag}, in the ring layer: ${hit.inLayer})`).toBe(true);
    }
    await page.mouse.click(centre.x, centre.y);
    await expect.poll(() => deletesSent(h), { message: "the bin sent the Sink's delete" }).toEqual([BELT_ID, board.sink.id]);
    h.inject(buildPacket({ full: false, tick: board.tick + 1, generation: 1, swapFloor: FLOOR, removed: [board.sink.id], canUndo: true }));
    await expectAt(page, STEP.bringBack, STAGE.undoSink, 'a delete from the bin finishes the step as the key does');
  });

  test('with a Timer set and items on the belt, the app asks first, and the lesson reads the board after either answer', async ({ page }) => {
    const { h, host, board } = await toSelectBelt(page);
    host.set(board.source.id, SOURCE_TIMER);
    board.tick += 1;
    h.inject(buildPacket({ full: false, tick: board.tick, generation: 1, swapFloor: FLOOR, belts: [{ ...board.belt, itemSlots: [1, 3] }], canUndo: true }));
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __fabrico: { scene(): { belts: { items: number }[] } } }).__fabrico.scene().belts[0]?.items ?? 0))
      .toBe(2);

    await pressRing(page, await ringAt(page, STAGE.selectBelt));
    await expect.poll(() => selectedBelt(page)).toBe(BELT_ID);
    await page.keyboard.press('Delete');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog, "Delete on a belt with items opens the app's own guard").toBeVisible();
    const heading = (await dialog.locator('#fab-delete-guard-heading').textContent()) ?? '';
    const body = (await dialog.locator('#fab-delete-guard-desc').textContent()) ?? '';
    expect(heading.length, 'the guard has its heading').toBeGreaterThan(0);
    expect(body, 'the guard counts the two items on the belt').toContain('2');
    await expect(dialog, 'the guard is labelled by its own heading').toHaveAccessibleName(heading);
    expect(deletesSent(h), 'nothing is deleted while the guard asks').toEqual([]);
    let probe = await readProbe(page);
    expect(probe.stepId, 'the open guard finishes nothing').toBe(STEP.deleteBelt);

    // Cancel: nothing goes, and the step stays.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog, 'Cancel closes the guard').toBeHidden();
    await page.waitForTimeout(300);
    expect(deletesSent(h), 'Cancel deleted nothing').toEqual([]);
    probe = await readProbe(page);
    expect(probe.stepId, 'Cancel leaves delete-belt current').toBe(STEP.deleteBelt);

    // Delete again, and this time the guard's own delete button. The step waits for the board.
    if ((await selectedBelt(page)) !== BELT_ID) await pressRing(page, await ringAt(page, STAGE.selectBelt));
    await expect.poll(() => selectedBelt(page)).toBe(BELT_ID);
    await page.keyboard.press('Delete');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete anyway', exact: true }).click();
    await expect.poll(() => deletesSent(h), { message: "the guard's Delete sent the belt's delete" }).toEqual([BELT_ID]);
    await page.waitForTimeout(300);
    expect((await readProbe(page)).stepId, 'the step waits for the board to show the belt gone').toBe(STEP.deleteBelt);
    h.inject(buildPacket({ full: false, tick: board.tick + 1, generation: 1, swapFloor: FLOOR, removed: [BELT_ID], canUndo: true }));
    await expectAt(page, STEP.deleteSink, STAGE.selectSink, 'the belt gone finished delete-belt');
  });
});
