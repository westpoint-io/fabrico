import { test, expect, type Page } from '@playwright/test';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import { DELETE_AND_UNDO } from '../src/tutorial/lessons/deleteAndUndo';
import { phrasePlain } from '../src/tutorial/phrase';
import { CMD, buildPacket, gestureSubject, type Harness, type InjectBelt, type InjectNode } from './support/wire';
import {
  CARD,
  SINK_DEBUG,
  SOURCE_WEBHOOK,
  beltBetween,
  boot,
  cellOfRing,
  configByNode,
  pressRing,
  readProbe,
  reminted,
  ringAt,
  sinkAt,
  sourceAt,
  startLesson,
  zoomInto,
} from './support/lessonMock';
import { cameraOf } from './support/wire';

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

const BELT_ID = 4;
const FLOOR = 1;

/** The board the case has injected so far, and the tick and generation of its last packet. */
interface Board {
  source: InjectNode;
  sink: InjectNode;
  belt: InjectBelt;
  tick: number;
  generation: number;
}

async function selectedBelt(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __fabrico: { selectedBelt(): number | null } }).__fabrico.selectedBelt());
}

async function selectedNode(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __fabrico: { selectedNode(): number | null } }).__fabrico.selectedNode());
}

/** Poll the probe until it names this step and stage. */
async function expectAt(page: Page, stepId: string, stageId: string, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const probe = await readProbe(page);
        return `${probe.stepId}/${probe.stageId}`;
      },
      { message },
    )
    .toBe(`${stepId}/${stageId}`);
}

/** The Delete frames the page has sent, each with the handle it names. */
function deletesSent(h: Harness): number[] {
  return h.sent.filter((frame) => frame[0] === CMD.Delete).map((frame) => gestureSubject(frame).node ?? -1);
}

function undosSent(h: Harness): number {
  return h.sent.filter((frame) => frame[0] === CMD.Undo).length;
}

/** The centre of a ring's rect, where a press on it lands. */
function centreOf(ring: HintRect): { x: number; y: number } {
  return { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
}

/**
 * Steps 1 to 3 the way a user plays them: the Source and the Sink through their floor rings, then the
 * Belt row and a drag from the Out ring to the In ring. The host's answers are injected after each
 * gesture, and both machines' configs are in the host's table before they land. Returns at tool-down,
 * with the Belt tool still armed.
 */
async function buildLine(page: Page, h: Harness, host: ReturnType<typeof configByNode>): Promise<Board> {
  await ringAt(page, STAGE.sourceTool);
  // New keeps the camera, and the mock's first board fits one machine at the closest zoom. At that zoom
  // six cells east of the Source is past the free area, so the Sink's spot would land west, where no
  // straight belt reaches it. A user building a line zooms out first, and so does this.
  await zoomInto(page, { x: 640, y: 360 }, 1.4, 1.6);
  await page.getByRole('button', { name: 'Place Source', exact: true }).click();
  const sourceRing = await ringAt(page, STAGE.sourceFloor);
  const source = sourceAt(cellOfRing(sourceRing, await cameraOf(page)));
  host.set(source.id, SOURCE_WEBHOOK);
  await pressRing(page, sourceRing);
  await expect.poll(() => h.sent.some((frame) => frame[0] === CMD.Place), { message: 'the floor press sent a Place' }).toBe(true);
  h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: FLOOR, nodes: [source] }));

  await ringAt(page, STAGE.sinkTool);
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  const sinkRing = await ringAt(page, STAGE.sinkFloor);
  const sink = sinkAt(cellOfRing(sinkRing, await cameraOf(page)));
  host.set(sink.id, SINK_DEBUG);
  await pressRing(page, sinkRing);
  h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: FLOOR, nodes: [source, sink] }));

  await pressRing(page, await ringAt(page, STAGE.beltTool));
  const from = await ringAt(page, STAGE.beltDraw);
  const to = (await readProbe(page)).hintTo;
  if (to === null) throw new Error('belt-draw shows no release ring');
  const start = centreOf(from);
  const end = to.hitCentre ?? centreOf(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => h.sent.some((frame) => frame[0] === CMD.DrawBelt), { message: 'the drag sent a draw' }).toBe(true);

  const belt = beltBetween(BELT_ID, source, sink);
  h.inject(buildPacket({ full: false, tick: 8, generation: 1, swapFloor: FLOOR, nodes: [source, sink], belts: [belt], canUndo: true }));
  await expectAt(page, STEP.deleteBelt, STAGE.toolDown, 'the joined belt finished draw-belt, and the Belt tool is still armed');
  return { source, sink, belt, tick: 8, generation: 1 };
}

/** Wait until the capture the restored check compares with holds both machines' configs. */
async function expectCaptureComplete(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readProbe(page)).capture, { message: 'the capture taken as delete-belt began holds both configs' })
    .toEqual({ since: STEP.deleteBelt, machines: 2, configKinds: ['Source', 'Sink'] });
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
});
