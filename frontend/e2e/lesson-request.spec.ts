import { test, expect, type Page } from '@playwright/test';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import { ANSWER_A_WEB_REQUEST } from '../src/tutorial/lessons/answerAWebRequest';
import { phrasePlain } from '../src/tutorial/phrase';
import { CMD, cameraOf, type Harness } from './support/wire';
import {
  CARD,
  boot,
  cellOfRing,
  centreOf,
  expectAt,
  expectedCurlWord,
  handlerAt,
  injectBoard,
  placeThrough,
  pressRing,
  readProbe,
  requestHost,
  ringAt,
  routeAt,
  routeConfig,
  sentCount,
  startLesson,
  wireLegs,
  zoomInto,
  type RequestBoard,
  type RequestHost,
} from './support/lessonMock';

// lesson-request.spec.ts - lesson 5, Answer a web request, on a mock host.
//
// The walk on the real host plays lesson 5 the way it's meant to go, with a real curl and a real reply.
// It can't hold the host's POST URL answer back, make the row read "Webhook not ready" for good, make
// the clipboard refuse a write, or send an Undo keyframe at step 4. The mock host can, because a case
// decides every packet the board gets and every answer the host gives. Stage and step ids come from the
// lesson's own data through `stageOf`, so a renamed stage fails here by name.

const LESSON = ANSWER_A_WEB_REQUEST;
const STEPS = LESSON.steps.length;

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

const STEP = {
  placeRoute: stepOf('place-route'),
  placeHandler: stepOf('place-handler'),
  wire: stepOf('wire'),
  answer: stepOf('answer'),
};

const STAGE = {
  routeTool: stageOf(STEP.placeRoute, 'route-tool'),
  routeFloor: stageOf(STEP.placeRoute, 'route-floor'),
  handlerTool: stageOf(STEP.placeHandler, 'handler-tool'),
  handlerFloor: stageOf(STEP.placeHandler, 'handler-floor'),
  wireTool: stageOf(STEP.wire, 'wire-tool'),
  wireDraw: stageOf(STEP.wire, 'wire-draw'),
  requestPaused: stageOf(STEP.answer, 'request-paused'),
  toolDown: stageOf(STEP.answer, 'tool-down'),
  selectRoute: stageOf(STEP.answer, 'select-route'),
  urlPending: stageOf(STEP.answer, 'url-pending'),
  sendRequest: stageOf(STEP.answer, 'send-request'),
};

/** The URL the mock host answers `webhook_url` with: the host's loopback endpoint, the default path. */
const ROUTE_URL = 'http://127.0.0.1:54321/endpoint/route-1';
const ROUTE_PATH = '/route-1';

/** Boot on a host that answers the Route's config and its POST URL, and start lesson 5. */
async function startRequestLesson(page: Page, host: RequestHost = requestHost(ROUTE_URL)): Promise<{ h: Harness; host: RequestHost }> {
  const h = await boot(page, host.opts);
  await startLesson(page, h, LESSON);
  await ringAt(page, STAGE.routeTool);
  // New keeps the camera, and the mock's first board fits one machine at the closest zoom, where the
  // 9-cell span can't fit. A user building a line zooms out.
  await zoomInto(page, { x: 640, y: 360 }, 0.9, 1.1);
  return { h, host };
}

/** Steps 1 and 2 through their rings, with the host's machines injected. Ends with the Handler's tool armed. */
async function placeRouteAndHandler(page: Page, h: Harness, host: RequestHost): Promise<RequestBoard> {
  await pressRing(page, await ringAt(page, STAGE.routeTool));
  const routeRing = await ringAt(page, STAGE.routeFloor);
  const route = routeAt(cellOfRing(routeRing, await cameraOf(page)));
  host.set(route.id, routeConfig(ROUTE_PATH));
  await placeThrough(page, h, routeRing);
  injectBoard(h, { nodes: [route], tick: 6 });

  await expectAt(page, STEP.placeHandler, STAGE.handlerTool, 'the Route appeared and finished step 1');
  await pressRing(page, await ringAt(page, STAGE.handlerTool));
  const handlerRing = await ringAt(page, STAGE.handlerFloor);
  const handler = handlerAt(cellOfRing(handlerRing, await cameraOf(page)));
  await placeThrough(page, h, handlerRing);
  injectBoard(h, { nodes: [route, handler], tick: 7 });
  await expectAt(page, STEP.wire, STAGE.wireTool, 'the Handler appeared and finished step 2');
  return { route, handler, wires: [], tick: 7, generation: 1 };
}

/** The wire-draw stage's two discs: where the drag starts and where it ends. */
async function wireDiscs(page: Page): Promise<{ from: HintRect; to: HintRect }> {
  const from = await ringAt(page, STAGE.wireDraw);
  const to = (await readProbe(page)).hintTo;
  if (to === null) throw new Error('wire-draw shows no release disc');
  return { from, to };
}

/** A pointer drag from one point to another, in two legs of five moves. */
async function dragBetween(page: Page, start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

/** Step 3: the Wire tool through its ring, the drag between the discs, and both legs injected. */
async function wireThroughDiscs(page: Page, h: Harness, board: RequestBoard): Promise<void> {
  await pressRing(page, await ringAt(page, STAGE.wireTool));
  const { from, to } = await wireDiscs(page);
  const before = sentCount(h, CMD.DrawWire);
  await dragBetween(page, from.hitCentre ?? centreOf(from), to.hitCentre ?? centreOf(to));
  await expect.poll(() => sentCount(h, CMD.DrawWire), { message: 'the drag between the discs sent a wire' }).toBe(before + 1);
  board.wires = wireLegs(board.route, board.handler);
  injectBoard(h, { nodes: [board.route, board.handler], wires: board.wires, tick: ++board.tick, generation: board.generation });
  await expectAt(page, STEP.answer, STAGE.toolDown, 'both legs finished step 3, and the Wire tool is still armed');
}

/** The return leg again, now carrying one reply pulse, as the host sends it while the reply travels home. */
function sendReply(h: Harness, board: RequestBoard): void {
  board.wires = wireLegs(board.route, board.handler, ++board.tick);
  injectBoard(h, { nodes: [board.route, board.handler], wires: board.wires, tick: board.tick, generation: board.generation });
}

async function requestLineOf(page: Page): Promise<string> {
  return (await page.locator(`${CARD} [data-fab-request-line]`).textContent()) ?? '';
}

test.describe('Answer a web request on a mock host', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('plays from Start to Lesson done, with the POST URL answered after the send stage began', async ({ page }) => {
    const host = requestHost(ROUTE_URL);
    const { h } = await startRequestLesson(page, host);
    const card = page.locator(CARD);
    const board = await placeRouteAndHandler(page, h, host);
    await wireThroughDiscs(page, h, board);

    // Hold the host's POST URL answer before the row asks, so what the card shows in the meantime is
    // the wait, and the release is what moves it on.
    host.holdUrl();
    await page.keyboard.press('Escape');
    await pressRing(page, await ringAt(page, STAGE.selectRoute));
    await expect.poll(() => host.urlWaiting(), { message: 'the POST URL row asked the host and is waiting' }).toBeGreaterThan(0);
    await expectAt(page, STEP.answer, STAGE.urlPending, 'with the POST URL still loading, the card waits for it');
    expect((await readProbe(page)).hint, 'no ring while the card waits for the POST URL').toBeNull();
    await expect(card, 'the waiting stage says what it waits for').toContainText(wordsOf(STEP.answer, STAGE.urlPending));
    await expect(page.locator(`${CARD} [data-fab-request-line]`), 'no request line before the URL is read').toHaveCount(0);

    host.releaseUrl();
    await ringAt(page, STAGE.sendRequest);
    const line = `${await expectedCurlWord(page)} -X POST ${ROUTE_URL}`;
    await expect
      .poll(() => requestLineOf(page), { message: 'the request line shows the URL the host answered, after it arrived late' })
      .toBe(line);
    await expect(card).toContainText(`Step ${STEPS} of ${STEPS}`);

    sendReply(h, board);
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the reply on the return wire finished the lesson' }).toBe('finished');
    await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
  });
});
