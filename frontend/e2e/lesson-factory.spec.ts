import { test, expect, type Page } from '@playwright/test';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import { CONFIG_NOT_APPLIED_MARKER, CONFIG_NOT_APPLIED_SUFFIX } from '../src/chrome/configCopy';
import { FACTORY_EDITOR_LABELS } from '../src/chrome/FactoryConfigBody';
import { ADD_OUTPUT_WORDS, TWO_OUTPUTS } from '../src/tutorial/lessons/twoOutputs';
import { phrasePlain } from '../src/tutorial/phrase';
import { doorstepCell } from '../src/protocol/ports';
import { CELL, CMD, buildPacket, cameraOf, waitForBoard, type Harness, type InjectBelt, type InjectNode, type InjectPort } from './support/wire';
import {
  CARD,
  DEFAULT_FACTORY_SOURCE,
  OUTSET,
  SINK_DEBUG,
  SINK_ID,
  SOURCE_TIMER,
  SOURCE_WEBHOOK,
  beltFromPort,
  boot,
  cellOfRing,
  configByNode,
  factoryAt,
  factoryConfig,
  pressRing,
  readProbe,
  ringAt,
  sinkAt,
  sourceAt,
  startLesson,
  zoomInto,
} from './support/lessonMock';

// lesson-factory.spec.ts - lesson 4, A Factory with two outputs, on a mock host.
//
// The walk on the real host plays lesson 4 the way it's meant to go. It can't make code that won't
// parse, code that applies and still emits on one output, or a panel taller than its column happen on
// purpose, and it can't hold the board still while a ring loses its target. The mock host can, because
// a case decides every packet the board gets and every answer the host gives. So this spec reads what
// the user sees in those cases: the card's stage and words, the rings and the controls under them, and
// the panel's own error row. Stage and step ids come from the lesson's own data through `stageOf`, so a
// renamed stage fails here by name.

const LESSON = TWO_OUTPUTS;
const STEPS = LESSON.steps.length;
const FLOOR = 1;

/** A stage id, checked against the lesson's data: a renamed or moved stage throws here, by name. */
function stageOf(stepId: string, id: string): string {
  const step = LESSON.steps.find((s) => s.id === stepId);
  if (step === undefined) throw new Error(`${LESSON.id} has no step ${stepId}`);
  if (!step.stages.some((stage) => stage.id === id)) throw new Error(`${LESSON.id} step ${stepId} has no stage ${id}`);
  return id;
}

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

/** The typed code a stage's gesture names, from the lesson's data. */
function typedAt(stepId: string, id: string): { after: string; insert: string } {
  const gesture = LESSON.steps.find((s) => s.id === stepId)?.stages.find((st) => st.id === id)?.gesture;
  if (gesture?.do !== 'typeCode') throw new Error(`${LESSON.id} step ${stepId} stage ${id} types no code`);
  return { after: gesture.after, insert: gesture.insert };
}

const STEP = {
  placeSource: stepOf('place-source'),
  setTimer: stepOf('set-timer'),
  placeFactory: stepOf('place-factory'),
  addOutput: stepOf('add-output'),
  placeSink: stepOf('place-sink'),
  placeSecondSink: stepOf('place-second-sink'),
  beltIn: stepOf('belt-in'),
  beltOut: stepOf('belt-out'),
  beltOut2: stepOf('belt-out-2'),
  changeCode: stepOf('change-code'),
};

const STAGE = {
  sourceTool: stageOf(STEP.placeSource, 'source-tool'),
  sourceFloor: stageOf(STEP.placeSource, 'source-floor'),
  timerToolDown: stageOf(STEP.setTimer, 'tool-down'),
  selectSource: stageOf(STEP.setTimer, 'select-source'),
  pressTimer: stageOf(STEP.setTimer, 'press-timer'),
  applyTimer: stageOf(STEP.setTimer, 'apply-timer'),
  factoryTool: stageOf(STEP.placeFactory, 'factory-tool'),
  factoryFloor: stageOf(STEP.placeFactory, 'factory-floor'),
  addToolDown: stageOf(STEP.addOutput, 'tool-down'),
  selectFactory: stageOf(STEP.addOutput, 'select-factory'),
  pressAddOutput: stageOf(STEP.addOutput, 'press-add-output'),
  sinkTool: stageOf(STEP.placeSink, 'sink-tool'),
  sinkFloor: stageOf(STEP.placeSink, 'sink-floor'),
  secondSinkTool: stageOf(STEP.placeSecondSink, 'second-sink-tool'),
  secondSinkFloor: stageOf(STEP.placeSecondSink, 'second-sink-floor'),
  beltTool: stageOf(STEP.beltIn, 'belt-tool'),
  beltDraw: stageOf(STEP.beltIn, 'belt-draw'),
  codeToolDown: stageOf(STEP.changeCode, 'tool-down'),
  codeSelectFactory: stageOf(STEP.changeCode, 'select-factory'),
  typeCode: stageOf(STEP.changeCode, 'type-code'),
  applyCode: stageOf(STEP.changeCode, 'apply-code'),
  watch: stageOf(STEP.changeCode, 'watch'),
};
// The three belt steps share lesson 1's stage ids; check each step holds them.
for (const step of [STEP.beltOut, STEP.beltOut2]) {
  stageOf(step, STAGE.beltTool);
  stageOf(step, STAGE.beltDraw);
}

const TYPED = typedAt(STEP.changeCode, STAGE.typeCode);
/** The label that names the Factory's editor, the one the code-line ring finds it by. */
const FACTORY_EDITOR_LABEL = FACTORY_EDITOR_LABELS.factory;
/** The watch stage's second sentence, the one a user with code on one output reads. */
const ONE_GETS_NONE = 'If one gets none, check the line you typed and press Apply again.';
/** The apply stage's second sentence, beside the panel's error row. */
const CHECK_THE_LINE = 'If the panel shows an error, check the line you typed.';

const SINK2_ID = 5;
const BELT_IN_ID = 6;
const BELT_OUT_ID = 7;
const BELT_OUT2_ID = 8;
/** The Sink fixture's In port index (`sinkAt`: the Fault is index 0). */
const SINK_IN = 1;
/** The Factory fixture's port indices (`factoryAt`). */
const FACTORY_IN = 0;
const FACTORY_OUT = 1;
const FACTORY_OUT2 = 3;

/** The board the case has injected so far, and the tick of its last packet. */
interface Board {
  source: InjectNode;
  factory: InjectNode;
  sink: InjectNode;
  sink2: InjectNode;
  belts: InjectBelt[];
  tick: number;
}

type Host = ReturnType<typeof configByNode>;

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

function sentCount(h: Harness, cmd: number): number {
  return h.sent.filter((frame) => frame[0] === cmd).length;
}

/** The centre of a ring's rect, where a press on it lands. */
function centreOf(ring: HintRect): { x: number; y: number } {
  return { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
}

/** Inject the board as it stands, as a diff on generation 1. */
function injectBoard(h: Harness, board: { nodes: InjectNode[]; belts?: InjectBelt[]; tick: number }): void {
  h.inject(buildPacket({ full: false, tick: board.tick, generation: 1, swapFloor: FLOOR, nodes: board.nodes, belts: board.belts ?? [] }));
}

/** Press a floor ring with the tool armed and wait for the Place it sends. */
async function placeThrough(page: Page, h: Harness, ring: HintRect): Promise<void> {
  const before = sentCount(h, CMD.Place);
  await pressRing(page, ring);
  await expect.poll(() => sentCount(h, CMD.Place), { message: 'the floor press sent a Place' }).toBe(before + 1);
}

/** The drag from the belt-draw ring (or from `startAt`) to its release ring, and the DrawBelt it sends. */
async function dragThroughRings(page: Page, h: Harness, startAt?: { x: number; y: number }): Promise<void> {
  const from = await ringAt(page, STAGE.beltDraw);
  const to = (await readProbe(page)).hintTo;
  if (to === null) throw new Error('belt-draw shows no release ring');
  const before = sentCount(h, CMD.DrawBelt);
  const start = startAt ?? centreOf(from);
  const end = to.hitCentre ?? centreOf(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => sentCount(h, CMD.DrawBelt), { message: 'the drag between the rings sent a draw' }).toBe(before + 1);
}

/** Press the palette ring if the step opens on it; machine and Belt tools stay armed after use. */
async function armThrough(page: Page, toolStage: string, nextStage: string): Promise<void> {
  const probe = await readProbe(page);
  if (probe.stageId === toolStage) await pressRing(page, await ringAt(page, toolStage));
  await ringAt(page, nextStage);
}

/** The inspector heading's not-applied marker, as the user reads it. */
function marker(page: Page) {
  return page.locator('#fab-config-heading').getByText(CONFIG_NOT_APPLIED_MARKER, { exact: false });
}

/** The Factory editor's text, its lines joined, as the user reads it. */
async function editorText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll('aside[aria-labelledby="fab-config-heading"] .cm-line')].map((l) => (l.textContent ?? '').replace(/​/g, '')).join('\n'),
  );
}

/**
 * The point just after `after` in the editor line that holds it: two px past the right edge of its
 * last character, which CodeMirror reads as the gap after it. The walk finds it the same way.
 */
async function pointAfter(page: Page, after: string): Promise<{ x: number; y: number }> {
  const at = await page.evaluate((text) => {
    const line = [...document.querySelectorAll('aside[aria-labelledby="fab-config-heading"] .cm-line')].find((l) => (l.textContent ?? '').includes(text));
    if (line === undefined) return null;
    const end = (line.textContent ?? '').indexOf(text) + text.length;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (seen + length >= end) {
        const range = document.createRange();
        range.setStart(node, end - seen - 1);
        range.setEnd(node, end - seen);
        const box = range.getBoundingClientRect();
        return { x: box.right + 2, y: box.top + box.height / 2 };
      }
      seen += length;
    }
    return null;
  }, after);
  if (at === null) throw new Error(`no editor line holds ${JSON.stringify(after)}`);
  return at;
}

/** Click just after `after` and type `insert`, the way a user puts the caret there and types. */
async function typeAfter(page: Page, after: string, insert: string): Promise<void> {
  const at = await pointAfter(page, after);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.insertText(insert);
}

/** Start lesson 4 and zoom to about 1, where the 11-cell line fits the free area. */
async function startFactoryLesson(page: Page, opts: Parameters<typeof boot>[1] = {}): Promise<{ h: Harness; host: Host }> {
  const host = configByNode();
  const h = await boot(page, { ...host.opts, ...opts });
  await startLesson(page, h, LESSON);
  await ringAt(page, STAGE.sourceTool);
  // New keeps the camera, and the mock's first board fits one machine at the closest zoom, where the
  // centred line can't fit and its later spots fall out of view. A user building a line zooms out.
  await zoomInto(page, { x: 640, y: 360 }, 0.9, 1.1);
  return { h, host };
}

/** Steps 1 and 2: the Source through its rings, and Timer set with the host answering it after Apply. */
async function sourceOnTimer(page: Page, h: Harness, host: Host): Promise<{ source: InjectNode; tick: number }> {
  await pressRing(page, await ringAt(page, STAGE.sourceTool));
  const sourceRing = await ringAt(page, STAGE.sourceFloor);
  const source = sourceAt(cellOfRing(sourceRing, await cameraOf(page)));
  host.set(source.id, SOURCE_WEBHOOK);
  await placeThrough(page, h, sourceRing);
  injectBoard(h, { nodes: [source], tick: 6 });

  await ringAt(page, STAGE.timerToolDown);
  await page.keyboard.press('Escape');
  await pressRing(page, await ringAt(page, STAGE.selectSource));
  await pressRing(page, await ringAt(page, STAGE.pressTimer));
  const configures = sentCount(h, CMD.Configure);
  await pressRing(page, await ringAt(page, STAGE.applyTimer));
  await expect.poll(() => sentCount(h, CMD.Configure), { message: 'Apply sent the Timer' }).toBe(configures + 1);
  host.set(source.id, SOURCE_TIMER);
  await expectAt(page, STEP.placeFactory, STAGE.factoryTool, 'the Timer answer finished set-timer');
  return { source, tick: 6 };
}

/** Steps 3 and 4: the Factory through its rings, then + Add output, and the host's two-output Factory. */
async function factoryWithTwoOutputs(
  page: Page,
  h: Harness,
  host: Host,
  source: InjectNode,
  tick: number,
  atAddOutput?: () => Promise<void>,
): Promise<{ factory: InjectNode; tick: number }> {
  await pressRing(page, await ringAt(page, STAGE.factoryTool));
  const factoryRing = await ringAt(page, STAGE.factoryFloor);
  const one = factoryAt(cellOfRing(factoryRing, await cameraOf(page)), 1);
  host.set(one.id, factoryConfig());
  await placeThrough(page, h, factoryRing);
  injectBoard(h, { nodes: [source, one], tick: ++tick });

  await expectAt(page, STEP.addOutput, STAGE.addToolDown, 'the Factory appeared, and its tool is still armed');
  await page.keyboard.press('Escape');
  await pressRing(page, await ringAt(page, STAGE.selectFactory));
  await ringAt(page, STAGE.pressAddOutput);
  await atAddOutput?.();
  await pressRing(page, await ringAt(page, STAGE.pressAddOutput));
  await expect.poll(() => sentCount(h, CMD.AddPort), { message: '+ Add output under its ring sent the add' }).toBe(1);
  const factory = factoryAt([one.cell_x, one.cell_y], 2);
  injectBoard(h, { nodes: [source, factory], tick: ++tick });
  await expectAt(page, STEP.placeSink, STAGE.sinkTool, 'the Factory with two outputs finished add-output');
  return { factory, tick };
}

/**
 * Steps 5 and 6: both Sinks through their rings. With `firstOnRow` the first Sink goes on that row in
 * the ring's column instead of in the ring, as a user who ignores the ring and puts it in front of the
 * Factory's other output does; the card says any free spot works.
 */
async function twoSinks(
  page: Page,
  h: Harness,
  host: Host,
  nodes: InjectNode[],
  tick: number,
  firstOnRow?: number,
): Promise<{ sink: InjectNode; sink2: InjectNode; tick: number }> {
  await pressRing(page, await ringAt(page, STAGE.sinkTool));
  const sinkRing = await ringAt(page, STAGE.sinkFloor);
  const cam = await cameraOf(page);
  const ringCell = cellOfRing(sinkRing, cam);
  const cell: readonly [number, number] = firstOnRow === undefined ? ringCell : [ringCell[0], firstOnRow];
  const sink = sinkAt(cell, SINK_ID);
  host.set(sink.id, SINK_DEBUG);
  if (firstOnRow === undefined) await placeThrough(page, h, sinkRing);
  else {
    const size = CELL * cam.scale;
    const before = sentCount(h, CMD.Place);
    await page.mouse.click(cell[0] * size + cam.x + size / 2, cell[1] * size + cam.y + size / 2);
    await expect.poll(() => sentCount(h, CMD.Place), { message: 'the floor press off the ring sent a Place' }).toBe(before + 1);
  }
  injectBoard(h, { nodes: [...nodes, sink], tick: ++tick });

  await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the first Sink finished place-sink' }).toBe(STEP.placeSecondSink);
  await armThrough(page, STAGE.secondSinkTool, STAGE.secondSinkFloor);
  const ring2 = await ringAt(page, STAGE.secondSinkFloor);
  const sink2 = sinkAt(cellOfRing(ring2, await cameraOf(page)), SINK2_ID);
  host.set(sink2.id, SINK_DEBUG);
  await placeThrough(page, h, ring2);
  injectBoard(h, { nodes: [...nodes, sink, sink2], tick: ++tick });
  await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the second Sink finished place-second-sink' }).toBe(STEP.beltIn);
  return { sink, sink2, tick };
}

/** Where a press on a port's doorstep cell lands, at its centre. */
async function doorstepCentre(page: Page, port: { cell_x: number; cell_y: number; side: number }): Promise<{ x: number; y: number }> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  const [x, y] = doorstepCell(port);
  return { x: x * size + cam.x + size / 2, y: y * size + cam.y + size / 2 };
}

function portOf(node: InjectNode, index: number): InjectPort {
  const port = node.ports?.find((p) => p.index === index);
  if (port === undefined) throw new Error(`machine ${node.id} has no port ${index}`);
  return port;
}

interface BuildOptions {
  /**
   * Step 8 drawn from the Factory's second Out: the first Sink goes in front of that Out instead of in
   * its ring, and the drag starts on that Out's doorstep instead of the ring. Step 9's free Out is then
   * the first.
   */
  secondFirst?: boolean;
  /** Stop after this many belts. */
  beltsDrawn?: 0 | 1 | 2 | 3;
  /** Called at press-add-output, before the press. */
  atAddOutput?: () => Promise<void>;
}

/**
 * Steps 1 to 6, then the belts through their rings. Returns with the Belt tool still armed, on the step
 * after the last belt drawn.
 */
async function buildBoard(page: Page, h: Harness, host: Host, opts: BuildOptions = {}): Promise<Board> {
  const placed = await sourceOnTimer(page, h, host);
  const { factory, tick: t2 } = await factoryWithTwoOutputs(page, h, host, placed.source, placed.tick, opts.atAddOutput);
  const secondRow = doorstepCell(portOf(factory, FACTORY_OUT2))[1];
  const { sink, sink2, tick: t3 } = await twoSinks(page, h, host, [placed.source, factory], t2, opts.secondFirst === true ? secondRow : undefined);
  const board: Board = { source: placed.source, factory, sink, sink2, belts: [], tick: t3 };
  const nodes = [board.source, factory, sink, sink2];
  const outs = opts.secondFirst === true ? [FACTORY_OUT2, FACTORY_OUT] : [FACTORY_OUT, FACTORY_OUT2];
  const plan: { step: string; belt: () => InjectBelt; from?: number }[] = [
    { step: STEP.beltIn, belt: () => beltFromPort(BELT_IN_ID, board.source, 0, factory, FACTORY_IN) },
    {
      step: STEP.beltOut,
      belt: () => beltFromPort(BELT_OUT_ID, factory, outs[0]!, sink, SINK_IN),
      ...(opts.secondFirst === true ? { from: FACTORY_OUT2 } : {}),
    },
    { step: STEP.beltOut2, belt: () => beltFromPort(BELT_OUT2_ID, factory, outs[1]!, sink2, SINK_IN) },
  ];
  for (const { step, belt, from } of plan.slice(0, opts.beltsDrawn ?? 3)) {
    await expect.poll(async () => (await readProbe(page)).stepId, { message: `the lesson reached ${step}` }).toBe(step);
    await armThrough(page, STAGE.beltTool, STAGE.beltDraw);
    await dragThroughRings(page, h, from === undefined ? undefined : await doorstepCentre(page, portOf(factory, from)));
    board.belts.push(belt());
    injectBoard(h, { nodes, belts: board.belts, tick: ++board.tick });
    await expect.poll(async () => (await readProbe(page)).stepId, { message: `the joined belt finished ${step}` }).not.toBe(step);
  }
  return board;
}

/**
 * From a built board with the Belt tool armed to the code-line stage. The Factory selected at step 4
 * stays selected while tools are armed, so the card goes straight to the code line unless something
 * cleared the selection, and then it asks for the press.
 */
async function toTypeCode(page: Page): Promise<HintRect> {
  await expectAt(page, STEP.changeCode, STAGE.codeToolDown, 'the third belt finished belt-out-2, and the Belt tool is still armed');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await readProbe(page)).stageId, { message: 'with the tool down the card asks for the Factory or its code' })
    .toMatch(new RegExp(`^(${STAGE.codeSelectFactory}|${STAGE.typeCode})$`));
  await armThrough(page, STAGE.codeSelectFactory, STAGE.typeCode);
  return ringAt(page, STAGE.typeCode);
}

/** Two drawn frames, so the layer's frame loop has read the packet the model holds. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/**
 * Items on the named belts, then each delivered: an item two slots out, at the head, then gone into the
 * Sink. The lesson reads a rise in the lowest slot into each Sink from one frame to the next, so each
 * packet waits until the model holds it and the layer has drawn twice.
 */
async function deliverInto(page: Page, h: Harness, board: Board, belts: readonly number[]): Promise<void> {
  const nodes = [board.source, board.factory, board.sink, board.sink2];
  for (const slots of [[2], [0], []]) {
    const withItems = board.belts.map((b) => (belts.includes(b.id) ? { ...b, itemSlots: slots } : b));
    injectBoard(h, { nodes, belts: withItems, tick: ++board.tick });
    await waitForBoard(page, { machines: nodes.length, tick: board.tick });
    await twoFrames(page);
  }
}

/** The ring a doorstep square should draw: the cell plus the outset each side, through the camera. */
async function doorstepRing(page: Page, port: InjectPort): Promise<{ x: number; y: number; width: number; height: number }> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  const [x, y] = doorstepCell(port);
  return { x: x * size + cam.x - OUTSET, y: y * size + cam.y - OUTSET, width: size + 2 * OUTSET, height: size + 2 * OUTSET };
}

/** The largest gap between two rects' edges, in px. */
function rectError(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.width - b.x - b.width), Math.abs(a.y + a.height - b.y - b.height));
}

/** Does `inner` lie inside `outer`, to within a pixel? */
function inside(inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }): boolean {
  return inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
}

/** The ring less its outset: the part of the control the ring goes around. */
function marked(ring: HintRect): { x: number; y: number; width: number; height: number } {
  return { x: ring.x + OUTSET, y: ring.y + OUTSET, width: ring.width - 2 * OUTSET, height: ring.height - 2 * OUTSET };
}

/** A panel control the code stages ring, found by its own name, never through the ring. */
type PanelControl = 'add-output' | 'editor' | 'apply';

/**
 * A panel control's rect, and the part of the inspector's scrolling column the user sees: the column's
 * client area, ending at the sticky Apply row's top for a control that scrolls under that row. Also the
 * column's scroll and client heights, so a case can say the panel is taller than its column.
 */
async function panelView(page: Page, which: PanelControl, words: string) {
  return page.evaluate(
    ([kind, label]) => {
      const aside = document.querySelector('aside[aria-labelledby="fab-config-heading"]');
      if (aside === null) return null;
      let control: HTMLElement | null = null;
      if (kind === 'editor') {
        const l = [...aside.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
        control = l === undefined ? null : document.getElementById(l.htmlFor);
      } else {
        control = [...aside.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label) ?? null;
      }
      if (control === null) return null;
      let column: HTMLElement | null = null;
      for (let el = control.parentElement; el !== null; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if (overflowY === 'auto' || overflowY === 'scroll') {
          column = el;
          break;
        }
      }
      if (column === null) return null;
      const row = aside.querySelector<HTMLElement>('[data-fab-action-row]');
      const c = column.getBoundingClientRect();
      const top = c.top + column.clientTop;
      let bottom = top + column.clientHeight;
      if (row !== null && !row.contains(control)) bottom = Math.min(bottom, row.getBoundingClientRect().top);
      const r = control.getBoundingClientRect();
      return {
        control: { x: r.x, y: r.y, width: r.width, height: r.height },
        shown: { x: c.left + column.clientLeft, y: top, width: column.clientWidth, height: bottom - top },
        scrollHeight: column.scrollHeight,
        clientHeight: column.clientHeight,
      };
    },
    [which, words] as const,
  );
}

/** What a press at this point would land on. */
async function hitAt(page: Page, at: { x: number; y: number }): Promise<{ tag: string; inLayer: boolean; inEditor: boolean; button: string | null }> {
  return page.evaluate(
    ([x, y, editorLabel]) => {
      const el = document.elementFromPoint(x, y);
      const label = [...document.querySelectorAll('aside[aria-labelledby="fab-config-heading"] label')].find((l) => l.textContent?.trim() === editorLabel) as HTMLLabelElement | undefined;
      const editor = label === undefined ? null : document.getElementById(label.htmlFor);
      return {
        tag: el?.tagName ?? 'none',
        inLayer: el?.closest('[data-fab-hint-layer]') != null,
        inEditor: el !== null && editor !== null && editor.contains(el),
        button: el?.closest('button')?.textContent?.trim() ?? null,
      };
    },
    [at.x, at.y, FACTORY_EDITOR_LABEL] as const,
  );
}

test.describe('lesson 4 on the mock host', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  let pageErrors: string[] = [];
  test.beforeEach(({ page }) => {
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
  });
  test.afterEach(() => {
    expect(pageErrors, 'the page threw no error while the lesson ran').toEqual([]);
  });

  test('plays from Start to Lesson done: a Source on Timer, a Factory, + Add output, two Sinks, three belts and the code', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 1 of ${STEPS}`);
    const board = await buildBoard(page, h, host);

    // Step 10: the Factory selected, and its editor shows the default handler.
    const codeRing = await toTypeCode(page);
    await expect(card).toContainText(`Step 10 of ${STEPS}`);
    await expect(card).toContainText(wordsOf(STEP.changeCode, STAGE.typeCode));
    await expect.poll(() => editorText(page), { message: 'the editor shows the default handler the host answered' }).toBe(DEFAULT_FACTORY_SOURCE);
    await expect(marker(page), 'no marker before anything is typed').toHaveCount(0);
    const at = await pointAfter(page, TYPED.after);
    expect(
      at.x >= codeRing.x && at.x <= codeRing.x + codeRing.width && at.y >= codeRing.y && at.y <= codeRing.y + codeRing.height,
      `the point just after ${TYPED.after} lies inside the code-line ring`,
    ).toBe(true);
    await typeAfter(page, TYPED.after, TYPED.insert);
    await expect.poll(() => editorText(page), { message: 'the editor holds the typed emit right after the first' }).toContain(`${TYPED.after}${TYPED.insert}`);
    await expect(marker(page), 'the panel says the typed code is not applied').toBeVisible();
    await expectAt(page, STEP.changeCode, STAGE.applyCode, 'the not-applied marker moved the card to Apply');
    await expect(card).toContainText(wordsOf(STEP.changeCode, STAGE.applyCode));

    const configures = sentCount(h, CMD.Configure);
    await pressRing(page, await ringAt(page, STAGE.applyCode));
    await expect.poll(() => sentCount(h, CMD.Configure), { message: 'Apply under its ring sent the code' }).toBe(configures + 1);
    const applied = DEFAULT_FACTORY_SOURCE.replace(TYPED.after, `${TYPED.after}${TYPED.insert}`);
    await expect.poll(() => host.get(board.factory.id), { message: 'the host holds the code the editor sent' }).toEqual(factoryConfig(applied));
    await expect(marker(page), 'the marker clears once the host holds the code').toHaveCount(0);
    await expectAt(page, STEP.changeCode, STAGE.watch, 'Apply moved the card to the watch stage');
    await expect(card).toContainText(wordsOf(STEP.changeCode, STAGE.watch));

    // Items ride out of both outputs into each Sink.
    await deliverInto(page, h, board, [BELT_OUT_ID, BELT_OUT2_ID]);
    await expect.poll(async () => (await readProbe(page)).card, { message: 'a delivery into both Sinks finished the lesson' }).toBe('finished');
    await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
    await expect(card).toContainText(phrasePlain(LESSON.closing));
    await expect(card).not.toContainText(/Step \d/);
    const fragments = await card.locator('[data-fab-code]').evaluateAll((spans) =>
      spans.map((s) => ({ tag: s.tagName, text: s.textContent, wrap: getComputedStyle(s).whiteSpace })),
    );
    expect(fragments, 'the closing line holds both code fragments, each in a span that never wraps').toEqual([
      { tag: 'SPAN', text: 'ctx.emit(0, input)', wrap: 'nowrap' },
      { tag: 'SPAN', text: 'ctx.emit(1, input)', wrap: 'nowrap' },
    ]);
    await expect(page.locator('[data-fab-hint]'), 'no ring on a finished lesson').toBeHidden();
  });

  test('with a belt on the first output, the drag for the second Sink starts on the second output', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const board = await buildBoard(page, h, host, { beltsDrawn: 2 });
    await expectAt(page, STEP.beltOut2, STAGE.beltDraw, 'the second belt finished belt-out, and the Belt tool is still armed');
    const ring = await ringAt(page, STAGE.beltDraw);
    const want = await doorstepRing(page, portOf(board.factory, FACTORY_OUT2));
    expect(
      rectError(ring, want),
      `the ring marks the second output's doorstep, the one with no belt (ring ${JSON.stringify(ring)}, doorstep ${JSON.stringify(want)})`,
    ).toBeLessThanOrEqual(1);
    await expect(page.locator(CARD)).toContainText(wordsOf(STEP.beltOut2, STAGE.beltDraw));
  });

  test('with step 8 drawn from the second output, the drag for the second Sink starts on the first', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const board = await buildBoard(page, h, host, { beltsDrawn: 2, secondFirst: true });
    await expectAt(page, STEP.beltOut2, STAGE.beltDraw, 'the second belt finished belt-out, and the Belt tool is still armed');
    const ring = await ringAt(page, STAGE.beltDraw);
    const want = await doorstepRing(page, portOf(board.factory, FACTORY_OUT));
    expect(
      rectError(ring, want),
      `the ring moved to the first output's doorstep, the one the user left free (ring ${JSON.stringify(ring)}, doorstep ${JSON.stringify(want)})`,
    ).toBeLessThanOrEqual(1);
  });

  test('the code-line ring sits on the line with the first emit, inside the editor, and a click there reaches the editor', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    await buildBoard(page, h, host);
    const ring = await toTypeCode(page);
    const view = await panelView(page, 'editor', FACTORY_EDITOR_LABEL);
    if (view === null) throw new Error('the Factory editor is not in the inspector');
    expect(inside(marked(ring), view.control), `the ring goes around a part of the editor (ring ${JSON.stringify(ring)}, editor ${JSON.stringify(view.control)})`).toBe(true);
    const line = await page.evaluate((text) => {
      const l = [...document.querySelectorAll('aside[aria-labelledby="fab-config-heading"] .cm-line')].find((x) => (x.textContent ?? '').includes(text));
      const r = l?.getBoundingClientRect();
      return r === undefined ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
    }, TYPED.after);
    if (line === null) throw new Error(`no editor line holds ${TYPED.after}`);
    expect(
      Math.abs(marked(ring).y - line.y) <= 1 && Math.abs(marked(ring).height - line.height) <= 1,
      `the ring is one line tall, on the line holding ${TYPED.after} (ring ${JSON.stringify(ring)}, line ${JSON.stringify(line)})`,
    ).toBe(true);
    const at = await pointAfter(page, TYPED.after);
    const hit = await hitAt(page, at);
    expect(hit.inLayer, 'just after the emit, the ring layer takes no click').toBe(false);
    expect(hit.inEditor, `just after the emit, a click lands in the editor (it read ${hit.tag})`).toBe(true);
  });

  test('the + Add output ring is the button plus 4 px a side, and a press at its centre reaches the button', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    let checked = false;
    await buildBoard(page, h, host, {
      beltsDrawn: 0,
      atAddOutput: async () => {
        const ring = await ringAt(page, STAGE.pressAddOutput);
        const view = await panelView(page, 'add-output', ADD_OUTPUT_WORDS);
        if (view === null) throw new Error(`no ${ADD_OUTPUT_WORDS} button in the inspector`);
        const want = { x: view.control.x - OUTSET, y: view.control.y - OUTSET, width: view.control.width + 2 * OUTSET, height: view.control.height + 2 * OUTSET };
        expect(rectError(ring, want), `the ring goes round the whole ${ADD_OUTPUT_WORDS} button (ring ${JSON.stringify(ring)}, button ${JSON.stringify(view.control)})`).toBeLessThanOrEqual(1);
        const hit = await hitAt(page, centreOf(ring));
        expect(hit.inLayer, 'at the ring centre, the ring layer takes no press').toBe(false);
        expect(hit.button, `at the ring centre, a press lands on ${ADD_OUTPUT_WORDS} (it read ${hit.tag})`).toBe(ADD_OUTPUT_WORDS);
        checked = true;
      },
    });
    expect(checked, 'the case read the ring at press-add-output').toBe(true);
  });

  test('code with a syntax error keeps the card on Apply, beside the panel\'s own error row', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const board = await buildBoard(page, h, host);
    await toTypeCode(page);
    // A stray ( in the emit the user types, so the host's pre-check refuses the code.
    await typeAfter(page, TYPED.after, ' ctx.emit((1, input);');
    await expectAt(page, STEP.changeCode, STAGE.applyCode, 'the typed code moved the card to Apply');
    const configures = sentCount(h, CMD.Configure);
    await pressRing(page, await ringAt(page, STAGE.applyCode));
    const error = page.locator('aside[aria-labelledby="fab-config-heading"]').getByRole('alert');
    await expect(error, 'the panel shows its own error row for code that does not parse').toBeVisible();
    await expect(error, 'and the row says the code was not applied').toContainText(CONFIG_NOT_APPLIED_SUFFIX);
    await expect(marker(page), 'the panel still says the code is not applied').toBeVisible();
    // The stream re-sends the last packet, so a stage change a few frames late would show by now.
    await page.waitForTimeout(300);
    expect(sentCount(h, CMD.Configure), 'nothing was sent to the board').toBe(configures);
    expect(host.get(board.factory.id), 'the host still holds the default handler').toEqual(factoryConfig());
    const probe = await readProbe(page);
    expect(`${probe.stepId}/${probe.stageId}`, 'the card stays on Apply').toBe(`${STEP.changeCode}/${STAGE.applyCode}`);
    const text = page.locator(`${CARD} [data-fab-step-text]`);
    await expect(text, 'the card says to check the line you typed').toContainText(CHECK_THE_LINE);
    await expect(text).toHaveText(wordsOf(STEP.changeCode, STAGE.applyCode));
  });

  test('code that applies and still emits on one output leaves the card on watch, saying what to check', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const board = await buildBoard(page, h, host);
    await toTypeCode(page);
    // A comment where the second emit should go: the code parses, applies, and still emits on output 0 only.
    await typeAfter(page, TYPED.after, ' /* one output */');
    await expectAt(page, STEP.changeCode, STAGE.applyCode, 'the typed comment moved the card to Apply');
    await pressRing(page, await ringAt(page, STAGE.applyCode));
    await expect(marker(page), 'the marker clears once the host holds the code').toHaveCount(0);
    await expectAt(page, STEP.changeCode, STAGE.watch, 'clean code moves the card to watch, whatever it emits');
    const text = page.locator(`${CARD} [data-fab-step-text]`);
    await expect(text, 'the watch card says to check the line if a Sink gets nothing').toContainText(ONE_GETS_NONE);
    await expect(text).toHaveText(wordsOf(STEP.changeCode, STAGE.watch));

    // Only the first output's belt carries items.
    await deliverInto(page, h, board, [BELT_OUT_ID]);
    await page.waitForTimeout(300);
    const probe = await readProbe(page);
    expect(probe.card, 'items into one Sink alone never finish the lesson').toBe('running');
    expect(`${probe.stepId}/${probe.stageId}`, 'the card stays on watch').toBe(`${STEP.changeCode}/${STAGE.watch}`);
    await expect(page.locator(CARD).getByRole('heading', { name: 'Lesson done' })).toHaveCount(0);
  });
});

test.describe('lesson 4 at 1024x768, where the Factory panel is taller than its column', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  let pageErrors: string[] = [];
  test.beforeEach(({ page }) => {
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
  });
  test.afterEach(() => {
    expect(pageErrors, 'the page threw no error while the lesson ran').toEqual([]);
  });

  /** The stage's ring goes round a part of its control that the column shows, above the sticky row. */
  async function expectRingShown(page: Page, stage: string, which: PanelControl, words: string): Promise<{ scrollHeight: number; clientHeight: number }> {
    const ring = await ringAt(page, stage);
    const view = await panelView(page, which, words);
    if (view === null) throw new Error(`${stage}: no ${which} in the inspector`);
    expect(
      inside(marked(ring), view.shown),
      `${stage}: the ring goes round a part of the ${which} the panel shows, after the stage's scroll (ring ${JSON.stringify(ring)}, shown column ${JSON.stringify(view.shown)}, control ${JSON.stringify(view.control)})`,
    ).toBe(true);
    expect(marked(ring).height, `${stage}: the ring marks more than a sliver of the ${which}`).toBeGreaterThanOrEqual(Math.min(view.control.height, 16));
    return { scrollHeight: view.scrollHeight, clientHeight: view.clientHeight };
  }

  test('+ Add output, the code line and Apply are each scrolled into the panel\'s shown part as their stage begins', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    let add: { scrollHeight: number; clientHeight: number } | null = null;
    await buildBoard(page, h, host, {
      atAddOutput: async () => {
        add = await expectRingShown(page, STAGE.pressAddOutput, 'add-output', ADD_OUTPUT_WORDS);
      },
    });
    expect(add, 'the case read the ring at press-add-output').not.toBeNull();
    expect(add!.scrollHeight, 'the Factory panel is taller than its column at 1024x768').toBeGreaterThan(add!.clientHeight);

    await toTypeCode(page);
    await expectRingShown(page, STAGE.typeCode, 'editor', FACTORY_EDITOR_LABEL);
    await typeAfter(page, TYPED.after, TYPED.insert);
    await expectAt(page, STEP.changeCode, STAGE.applyCode, 'the typed emit moved the card to Apply');
    await expectRingShown(page, STAGE.applyCode, 'apply', 'Apply');
  });
});
