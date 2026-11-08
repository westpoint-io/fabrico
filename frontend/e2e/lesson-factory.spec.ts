import { test, expect, type Page } from '@playwright/test';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import { CONFIG_NOT_APPLIED_MARKER, CONFIG_NOT_APPLIED_SUFFIX } from '../src/chrome/configCopy';
import { FACTORY_EDITOR_LABELS } from '../src/chrome/FactoryConfigBody';
import { ADD_OUTPUT_WORDS, TWO_OUTPUTS } from '../src/tutorial/lessons/twoOutputs';
import { LESSONS } from '../src/tutorial/lessons';
import { phrasePlain } from '../src/tutorial/phrase';
import { doorstepCell } from '../src/protocol/ports';
import { CELL, CMD, buildPacket, cameraOf, waitForBoard, type Harness, type InjectPort } from './support/wire';
import {
  BELT_OUT2_ID,
  BELT_OUT_ID,
  CARD,
  DEFAULT_FACTORY_SOURCE,
  FACTORY_OUT,
  FACTORY_OUT2,
  OUTSET,
  SINK_DEBUG,
  SOURCE_TIMER,
  boot,
  buildBoard,
  centreOf,
  expectAt,
  factoryConfig,
  factoryWithTwoOutputs,
  injectBoard,
  pointAfter,
  portOf,
  pressRing,
  readProbe,
  reminted,
  ringAt,
  sentCount,
  sourceOnTimer,
  startFactoryLesson,
  startLesson,
  toTypeCode,
  typeAfter,
  zoomInto,
  type FactoryBoard,
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

type Board = FactoryBoard;

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

  test("with the first Sink one cell east of its ring, the second Sink's ring faces the second output, off the first output's path (WR-03)", async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const board = await buildBoard(page, h, host, { beltsDrawn: 0, firstEast: 1 });
    const firstOut = doorstepCell(portOf(board.factory, FACTORY_OUT));
    const secondOut = doorstepCell(portOf(board.factory, FACTORY_OUT2));
    const first: readonly [number, number] = [board.sink.cell_x, board.sink.cell_y];
    // The first ring sits four out from the first output; the first Sink went one cell past it.
    const ringOffset = first[0] - 1 - firstOut[0];
    expect(first[1], "the first Sink is on the first output's row").toBe(firstOut[1]);
    const second: readonly [number, number] = [board.sink2.cell_x, board.sink2.cell_y];
    expect(second, "the second Sink's ring marks the cell four out from the second output").toEqual([secondOut[0] + ringOffset, secondOut[1]]);
    expect(second[1], "and not the first output's row, between that output and the first Sink").not.toBe(firstOut[1]);
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

/** One record a drawn frame: the model's tick, the probe's stage and flag, and whether Show me is offered. */
interface FrameRead {
  tick: number;
  stage: string | null;
  off: boolean;
  showMe: boolean;
}

/** Start recording one `FrameRead` a drawn frame, on `window.__fabFrames`, until `stopFrames`. */
async function recordFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabFrames?: FrameRead[];
      __fabFramesOn?: boolean;
      __fabrico: { scene(): { tick: number }; tutorial(): { stageId: string | null; offScreen: boolean } };
    };
    w.__fabFrames = [];
    w.__fabFramesOn = true;
    const read = (): void => {
      if (w.__fabFramesOn !== true) return;
      const probe = w.__fabrico.tutorial();
      const button = [...document.querySelectorAll<HTMLElement>('[data-fab-offscreen-row] button')][0];
      const shown = button !== undefined && getComputedStyle(button).visibility !== 'hidden';
      w.__fabFrames!.push({ tick: w.__fabrico.scene().tick, stage: probe.stageId, off: probe.offScreen, showMe: shown });
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  });
}

async function stopFrames(page: Page): Promise<FrameRead[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __fabFrames?: FrameRead[]; __fabFramesOn?: boolean };
    w.__fabFramesOn = false;
    return w.__fabFrames ?? [];
  });
}

test.describe('lesson 4 when a ring loses its target (103 review IN-01)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  let pageErrors: string[] = [];
  test.beforeEach(({ page }) => {
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
  });
  test.afterEach(() => {
    expect(pageErrors, 'the page threw no error while the lesson ran').toEqual([]);
  });

  // IN-01 names the trigger: a bound machine whose port the ring can't find. With the Belt tool armed,
  // a belt from the Factory that ends on the floor moves the card to belt-carry-on, whose ring sits on the
  // second Sink's In, so it doesn't keep the stage up (104-EVIDENCE.md, MEASURE floor-belt). The second
  // Sink re-sent without its In keeps belt-draw on the card, and the drag's rings have nothing to mark.
  test('with the drag rings out of view, a Sink whose In the ring can\'t find drops the off-screen row within two frames', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const board = await buildBoard(page, h, host, { beltsDrawn: 2 });
    await expectAt(page, STEP.beltOut2, STAGE.beltDraw, 'the second belt finished belt-out, and the Belt tool is still armed');
    // Zoom in on the Source, which pushes the Factory's outputs and the second Sink past the free area.
    const cam = await cameraOf(page);
    const size = CELL * cam.scale;
    await zoomInto(page, { x: (board.source.cell_x + 0.5) * size + cam.x, y: (board.source.cell_y + 0.5) * size + cam.y }, 3, 3.6);
    await expect.poll(async () => (await readProbe(page)).offScreen, { message: 'zoomed in, the drag rings are out of view' }).toBe(true);
    const row = page.locator(`${CARD} [data-fab-offscreen-row]`);
    const showMe = page.getByRole('button', { name: 'Show me', exact: true });
    await expect(row, 'the card says the ring is out of view').toBeVisible();
    await expect(showMe, 'and offers Show me').toBeVisible();

    await recordFrames(page);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __fabFrames: unknown[] }).__fabFrames.length)) > 0).toBe(true);
    const tick = ++board.tick;
    const lost = { ...board.sink2, ports: (board.sink2.ports ?? []).filter((p) => p.role !== 0) };
    injectBoard(h, { nodes: [board.source, board.factory, board.sink, lost], belts: board.belts, tick });
    await waitForBoard(page, { machines: 4, tick });
    await twoFrames(page);
    await twoFrames(page);
    const frames = await stopFrames(page);
    const before = frames.filter((f) => f.tick < tick);
    expect(before.length > 0 && before.every((f) => f.off && f.showMe), `before the packet the flag and Show me were on (${JSON.stringify(before.slice(-2))})`).toBe(true);
    const held = frames.findIndex((f) => f.tick === tick);
    const letGo = frames.findIndex((f, i) => i >= held && !f.off);
    expect(held, 'the recorder drew a frame with the packet in the model').toBeGreaterThanOrEqual(0);
    expect(
      letGo >= 0 && letGo - held <= 2,
      `the flag reads false within two drawn frames of the packet (frames ${JSON.stringify(frames.slice(held, held + 4))})`,
    ).toBe(true);
    expect(frames.slice(held).every((f) => f.stage === STAGE.beltDraw), 'the card stays on the drag the whole time').toBe(true);

    const probe = await readProbe(page);
    expect(probe.hint, 'the drag ring has nothing to mark, so it hides').toBeNull();
    expect(probe.offScreen, 'the flag stays false').toBe(false);
    await expect(row, 'the off-screen row hides').toBeHidden();
    await expect(showMe, "Show me isn't in the accessibility tree").toHaveCount(0);
  });

  // The ring paints from the last frame's target, so on the frame a keyframe re-mints every handle it
  // looks for the old ones and finds nothing, while the lesson finds each machine again in that frame.
  // That miss isn't a lost target: the row and Show me stay, and so does the focus on Show me.
  test('a keyframe that re-mints every handle keeps the off-screen row and the focus on Show me', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page);
    const board = await buildBoard(page, h, host, { beltsDrawn: 2 });
    await expectAt(page, STEP.beltOut2, STAGE.beltDraw, 'the second belt finished belt-out, and the Belt tool is still armed');
    const cam = await cameraOf(page);
    const size = CELL * cam.scale;
    await zoomInto(page, { x: (board.source.cell_x + 0.5) * size + cam.x, y: (board.source.cell_y + 0.5) * size + cam.y }, 3, 3.6);
    await expect.poll(async () => (await readProbe(page)).offScreen, { message: 'zoomed in, the drag rings are out of view' }).toBe(true);
    const showMe = page.getByRole('button', { name: 'Show me', exact: true });
    await showMe.focus();
    await expect(showMe, 'Show me holds the focus, as after a Tab').toBeFocused();

    await recordFrames(page);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __fabFrames: unknown[] }).__fabFrames.length)) > 0).toBe(true);
    const next = reminted({ nodes: [board.source, board.factory, board.sink, board.sink2], belts: board.belts }, 10);
    for (const [node, config] of [
      [next.nodes[0]!.id, SOURCE_TIMER],
      [next.nodes[1]!.id, factoryConfig()],
      [next.nodes[2]!.id, SINK_DEBUG],
      [next.nodes[3]!.id, SINK_DEBUG],
    ] as const) {
      host.set(node, config);
    }
    const tick = ++board.tick;
    h.inject(buildPacket({ full: true, tick, generation: 2, swapFloor: FLOOR, nodes: next.nodes, belts: next.belts, canUndo: true, canRedo: true }));
    await waitForBoard(page, { machines: 4, tick });
    await expect.poll(async () => (await readProbe(page)).bound.sink2, { message: 'the second Sink binding follows its new handle' }).toBe(next.nodes[3]!.id);
    await twoFrames(page);
    await twoFrames(page);
    const frames = await stopFrames(page);
    const held = frames.findIndex((f) => f.tick === tick);
    expect(held, 'the recorder drew a frame with the keyframe in the model').toBeGreaterThanOrEqual(0);
    const after = frames.slice(held);
    expect(after.every((f) => f.stage === STAGE.beltDraw), 'the card stays on the drag through the keyframe').toBe(true);
    expect(
      after.every((f) => f.off && f.showMe),
      `the row and Show me stay on every frame of the keyframe (frames ${JSON.stringify(after.slice(0, 4))})`,
    ).toBe(true);
    await expect(showMe, 'Show me still holds the focus').toBeFocused();
    expect((await readProbe(page)).hint, 'the drag ring is placed again on the new handles').not.toBeNull();
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

test.describe('a lesson started from ? on first launch (104-VERIFICATION finding 1)', () => {
  // The mock configs preset the first-run flag in storage and boot() presets it in an init script, so
  // this block clears the first and boots with firstLaunch to skip the second: the welcome card shows.
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });

  const WELCOME = 'Welcome to Fabrico';

  for (const lesson of LESSONS) {
    test(`starting ${lesson.title} from Help and Lessons closes the welcome card and sets its flag`, async ({ page }) => {
      const h = await boot(page, { firstLaunch: true });
      const heading = page.getByRole('heading', { name: WELCOME });
      await expect(heading, 'the first-run card shows').toBeVisible();
      await startLesson(page, h, lesson);
      await expect(heading, 'by Step 1 the welcome card is gone').toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem('fab.onboarding.seen.v1')), 'and it stays gone').toBe('1');
    });
  }

  test('lesson 4 started from ? on first launch: the Source and Factory floor rings sit under no panel', async ({ page }) => {
    const { h, host } = await startFactoryLesson(page, { firstLaunch: true });
    // The case reads rects, not a hit test: the welcome card sets pointer-events none on its body, so
    // elementFromPoint at the ring's centre looks straight through it and would never see it cover a ring.
    const visit = async (stageId: string): Promise<void> => {
      if (stageId !== STAGE.sourceFloor && stageId !== STAGE.factoryFloor) return;
      const ring = await ringAt(page, stageId);
      const panels = await page.locator('aside.fab-panel').evaluateAll(
        (els, card) =>
          els
            .filter((el) => el.closest(card) === null)
            .map((el) => {
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return {
                name: el.getAttribute('aria-labelledby') ?? el.getAttribute('aria-label') ?? el.className,
                x: Math.round(r.x),
                y: Math.round(r.y),
                width: Math.round(r.width),
                height: Math.round(r.height),
                shown: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none',
              };
            })
            .filter((p) => p.shown),
        CARD,
      );
      const box = { x: Math.round(ring.x), y: Math.round(ring.y), width: Math.round(ring.width), height: Math.round(ring.height) };
      console.log(`MEASURE first-launch ${stageId} ring=${JSON.stringify(box)} panels=${JSON.stringify(panels)}`);
      const over = panels.filter(
        (p) => p.x < ring.x + ring.width && ring.x < p.x + p.width && p.y < ring.y + ring.height && ring.y < p.y + p.height,
      );
      expect.soft(over.map((p) => p.name), `no panel meets the ${stageId} ring ${JSON.stringify(box)}`).toEqual([]);
    };
    const placed = await sourceOnTimer(page, h, host, visit);
    await factoryWithTwoOutputs(page, h, host, placed.source, placed.tick, undefined, visit);
    await expect(page.getByRole('heading', { name: WELCOME }), 'the welcome card never came back').toHaveCount(0);
  });
});
