import { test, expect, type Page } from '@playwright/test';
import type { HintRect } from '../src/chrome/tutorial/TutorialLayer';
import { ANSWER_A_WEB_REQUEST } from '../src/tutorial/lessons/answerAWebRequest';
import { phrasePlain } from '../src/tutorial/phrase';
import { wireNubHitRadiusWorld } from '../src/protocol/ports';
import { COPY_LABELS } from '../src/chrome/WebhookUrlRow';
import { CELL, CMD, buildPacket, cameraOf, type Harness } from './support/wire';
import {
  CARD,
  HANDLER_FAULT,
  HANDLER_IN,
  HANDLER_OUT,
  OUTSET,
  ROUTE_IN,
  ROUTE_OUT,
  boot,
  cellOfRing,
  centreOf,
  expectAt,
  expectedCurlWord,
  handlerAt,
  injectBoard,
  injectRefusal,
  nubCentre,
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
  type Box,
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

/**
 * `CLIENT_REFUSAL_COPY.BeltOnlyPort`, the band's own sentence, transcribed as `belt-port-refusal.spec.ts`
 * does: `RefusalMessage.tsx` imports SVG art the spec loader can't read.
 */
const BELT_ONLY_PORT = 'That port takes belts, not wires.';

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

/** What the card's note slot says for a coaching line at a stage, through the real tables. */
function coachOf(stepId: string, id: string, tag: string): string {
  const stage = LESSON.steps.find((s) => s.id === stepId)?.stages.find((st) => st.id === id);
  const line = stage?.coach?.[tag as keyof NonNullable<typeof stage.coach>];
  if (line === undefined) throw new Error(`${LESSON.id} step ${stepId} stage ${id} has no ${tag} coaching line`);
  return phrasePlain(line);
}

/** Steps 1 to 3 played through their rings, ending on step 4's tool-down stage with the Wire tool armed. */
async function toAnswerStep(page: Page, host: RequestHost = requestHost(ROUTE_URL)): Promise<{ h: Harness; host: RequestHost; board: RequestBoard }> {
  const { h } = await startRequestLesson(page, host);
  const board = await placeRouteAndHandler(page, h, host);
  await wireThroughDiscs(page, h, board);
  return { h, host, board };
}

/** From step 4's tool-down: the tool put down and the Route selected through its ring. */
async function selectRoute(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await pressRing(page, await ringAt(page, STAGE.selectRoute));
}

/** A rect grown by the ring's outset on each side, the box a ring around `box` takes. */
function grown(box: Box): Box {
  return { x: box.x - OUTSET, y: box.y - OUTSET, width: box.width + 2 * OUTSET, height: box.height + 2 * OUTSET };
}

/** Is `ring` the box a ring around `box` takes, to within a pixel? */
function ringsBox(ring: Box, box: Box): boolean {
  const want = grown(box);
  return (
    Math.abs(ring.x - want.x) <= 1 &&
    Math.abs(ring.y - want.y) <= 1 &&
    Math.abs(ring.width - want.width) <= 1 &&
    Math.abs(ring.height - want.height) <= 1
  );
}

/** Sample the card for `ms` and fail on the first read that leaves `stageId` or shows a ring. */
async function staysOn(page: Page, stageId: string, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const probe = await readProbe(page);
    expect(`${probe.stepId}/${probe.stageId}`, `${what}: the card left the waiting stage`).toBe(`${STEP.answer}/${stageId}`);
    expect(probe.hint, `${what}: a ring showed while the card waits`).toBeNull();
    await page.waitForTimeout(200);
  }
}

/** The visible rings in the hint layer, each as its rect. */
async function visibleRings(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const layer = document.querySelector('[data-fab-hint-layer]');
    if (layer === null) return [];
    return [...layer.children]
      .filter((el): el is HTMLElement => el instanceof HTMLElement && getComputedStyle(el).visibility === 'visible')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
  });
}

function within(p: { x: number; y: number }, box: Box): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}

/** The inspector's POST URL row's Copy button, found by the row's label, never by its word. */
function copyButton(page: Page) {
  return page.locator('aside[aria-labelledby="fab-config-heading"] label', { hasText: 'POST URL' }).locator('xpath=..').getByRole('button');
}

/** The window point a press lands on to clear the selection: an empty cell three rows above the Route. */
async function emptyFloor(page: Page, route: { cell_x: number; cell_y: number }): Promise<{ x: number; y: number }> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  return { x: route.cell_x * size + cam.x + size / 2, y: (route.cell_y - 3) * size + cam.y + size / 2 };
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

  for (const [what, answer, row] of [
    ['the host has no bound URL, so the row reads Webhook not ready', null, 'Webhook not ready'],
    ['the host answers a port 0 URL, which a failed bind leaves', 'http://127.0.0.1:0/endpoint/route-1', 'http://127.0.0.1:0/endpoint/route-1'],
  ] as const) {
    test(`stays on the waiting stage with its next action when ${what}`, async ({ page }) => {
      const { h } = await toAnswerStep(page, requestHost(answer));
      await selectRoute(page);
      await expect(
        page.locator('aside[aria-labelledby="fab-config-heading"] span.fab-field', { hasText: row }),
        'the POST URL row shows what the host answered',
      ).toBeVisible();
      await expectAt(page, STEP.answer, STAGE.urlPending, 'with no URL the card can use, it waits for one');
      await staysOn(page, STAGE.urlPending, 2000, what);
      const card = page.locator(CARD);
      await expect(card, 'the waiting stage tells the user to restart Fabrico if the webhook stays not ready').toContainText(
        "If the panel says the webhook isn't ready, restart Fabrico.",
      );
      await expect(card).toContainText(wordsOf(STEP.answer, STAGE.urlPending));
      await expect(page.locator(`${CARD} [data-fab-request-line]`), 'no request line without a URL in the endpoint shape').toHaveCount(0);
      expect(sentCount(h, CMD.DrawWire), 'the waiting stage sent nothing').toBe(1);
    });
  }

  test('a paused board at step 4 shows request-paused with the ring on Play', async ({ page }) => {
    const { h } = await toAnswerStep(page);
    const pauses = h.controls.filter((c) => c === 'pause').length;
    await page.locator('header button[aria-label="Pause"]').click();
    await expect.poll(() => h.controls.filter((c) => c === 'pause').length, { message: 'the Pause press reached the host' }).toBe(pauses + 1);
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    const ring = await ringAt(page, STAGE.requestPaused);
    expect((await readProbe(page)).stepId, 'a paused board keeps the card on step 4').toBe(STEP.answer);
    await expect(page.locator(CARD), 'the paused stage says the board turns requests away').toContainText(wordsOf(STEP.answer, STAGE.requestPaused));
    const play = page.locator('header button[aria-label="Play"]');
    const playBox = await play.boundingBox();
    if (playBox === null) throw new Error('the toolbar shows no Play button');
    expect(ringsBox(ring, playBox), 'the ring sits on the toolbar Play button').toBe(true);
  });

  test('a press on the Handler Fault with the Wire tool armed shows the BeltOnlyPort coaching line, and step 3 stays', async ({ page }) => {
    const host = requestHost(ROUTE_URL);
    const { h } = await startRequestLesson(page, host);
    const board = await placeRouteAndHandler(page, h, host);
    await pressRing(page, await ringAt(page, STAGE.wireTool));
    await wireDiscs(page);
    const fault = await nubCentre(page, board.handler.id, HANDLER_FAULT);
    // A press 5 px off the Fault dot, inside the 11 px the walk allows, half the wire hit radius.
    const press = { x: fault.x + 3, y: fault.y + 4 };
    expect(Math.hypot(press.x - fault.x, press.y - fault.y), 'the press lands within 11 px of the Fault dot').toBeLessThanOrEqual(11);
    const wires = sentCount(h, CMD.DrawWire);
    await page.mouse.click(press.x, press.y);
    await expect
      .poll(async () => (await readProbe(page)).noteKind, { message: 'the Fault press put a coaching line in the card note' })
      .toBe('refusal');
    await expect(page.locator(`${CARD} [data-fab-step-note="refusal"]`), "the card says the Fault isn't a wire dot").toHaveText(
      coachOf(STEP.wire, STAGE.wireDraw, 'BeltOnlyPort'),
    );
    await expect(page.locator('#fab-refusal'), 'the band shows its own sentence beside the card').toContainText(BELT_ONLY_PORT);
    const probe = await readProbe(page);
    expect(`${probe.stepId}/${probe.stageId}`, 'the step stays on the wire draw').toBe(`${STEP.wire}/${STAGE.wireDraw}`);
    expect(sentCount(h, CMD.DrawWire), 'a press on the Fault sends no wire').toBe(wires);
  });

  test("a drop on the Handler Fault shows lesson 5's MediumMismatch line", async ({ page }) => {
    const host = requestHost(ROUTE_URL);
    const { h } = await startRequestLesson(page, host);
    await placeRouteAndHandler(page, h, host);
    await pressRing(page, await ringAt(page, STAGE.wireTool));
    await wireDiscs(page);
    injectRefusal(h, 'MediumMismatch');
    await expect(page.locator(`${CARD} [data-fab-step-note="refusal"]`), 'the card says to drop the wire on the input dot').toHaveText(
      coachOf(STEP.wire, STAGE.wireDraw, 'MediumMismatch'),
    );
    const probe = await readProbe(page);
    expect(`${probe.stepId}/${probe.stageId}`, 'the step stays on the wire draw').toBe(`${STEP.wire}/${STAGE.wireDraw}`);
  });

  test('a press on the Handler In alone keeps the draw sentence, with no coaching line and no wire sent', async ({ page }) => {
    const host = requestHost(ROUTE_URL);
    const { h } = await startRequestLesson(page, host);
    const board = await placeRouteAndHandler(page, h, host);
    await pressRing(page, await ringAt(page, STAGE.wireTool));
    await wireDiscs(page);
    const into = await nubCentre(page, board.handler.id, HANDLER_IN);
    const wires = sentCount(h, CMD.DrawWire);
    await page.mouse.click(into.x, into.y);
    // The app's answer is a red flash over the dot, with no sentence. Give the card time to show one if it would.
    await page.waitForTimeout(600);
    const probe = await readProbe(page);
    expect(`${probe.stepId}/${probe.stageId}`, 'the step stays on the wire draw').toBe(`${STEP.wire}/${STAGE.wireDraw}`);
    expect(probe.noteKind, 'no coaching line for a press on the input dot').toBe('');
    await expect(page.locator(CARD), 'the draw sentence, which names the Route output dot, stays up').toContainText(wordsOf(STEP.wire, STAGE.wireDraw));
    expect(sentCount(h, CMD.DrawWire), 'a press on the input dot alone sends no wire').toBe(wires);
  });

  test("a second drag with the Wire tool still armed at step 4 shows lesson 5's PortOccupied line", async ({ page }) => {
    const { h, board } = await toAnswerStep(page);
    const from = await nubCentre(page, board.route.id, ROUTE_OUT);
    const to = await nubCentre(page, board.handler.id, HANDLER_IN);
    const wires = sentCount(h, CMD.DrawWire);
    await dragBetween(page, from, to);
    await expect.poll(() => sentCount(h, CMD.DrawWire), { message: 'the second drag sent a wire for the host to refuse' }).toBe(wires + 1);
    injectRefusal(h, 'PortOccupied');
    await expect(page.locator(`${CARD} [data-fab-step-note="refusal"]`), 'the card says the two are already wired and to put the tool down').toHaveText(
      coachOf(STEP.answer, STAGE.toolDown, 'PortOccupied'),
    );
    const probe = await readProbe(page);
    expect(`${probe.stepId}/${probe.stageId}`, 'the card stays on the tool-down stage').toBe(`${STEP.answer}/${STAGE.toolDown}`);
  });

  test('the Copy ring stays on the Copy button while it reads Copy, Copied and Copy failed, and a press reaches the button', async ({ page }) => {
    // The mock app takes the browser branch of clipboardCopy.ts, so this stub is the write the row awaits.
    await page.addInitScript(() => {
      const w = window as unknown as { __clipFail?: boolean; __clipWrites: string[] };
      w.__clipWrites = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string): Promise<void> => {
            if (w.__clipFail === true) return Promise.reject(new Error('the clipboard refused the write'));
            w.__clipWrites.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    await toAnswerStep(page);
    await selectRoute(page);
    await ringAt(page, STAGE.sendRequest);
    const button = copyButton(page);

    // The button changes width with its word (88, 92 and 132 px here), and the ring paints from the frame
    // before, so the read polls until the ring has caught up. The Copied word holds 1.5 s, so a ring that
    // dropped or stuck fails inside it.
    const readAt = async (word: string): Promise<void> => {
      await expect(button, `the button reads ${word}`).toHaveText(word);
      let seen = '';
      await expect
        .poll(
          async () => {
            const text = (await button.textContent())?.trim() ?? '';
            const box = await button.boundingBox();
            const probe = await readProbe(page);
            seen = `stage ${probe.stageId}, ring ${JSON.stringify(probe.hint)}, button ${JSON.stringify(box)} reading ${text}`;
            if (text !== word) return `the button reads ${text}`;
            if (box === null || probe.stageId !== STAGE.sendRequest || probe.hint === null) return seen;
            return ringsBox(probe.hint, box) ? 'held' : seen;
          },
          { message: `the ring holds the Copy button while it reads ${word}`, timeout: 1000, intervals: [50] },
        )
        .toBe('held');
      const box = await button.boundingBox();
      if (box === null) throw new Error(`the Copy button has no box while it reads ${word} (${seen})`);
      const hit = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el instanceof HTMLButtonElement ? el.textContent : `a ${el?.tagName ?? 'nothing'}`;
        },
        [box.x + box.width / 2, box.y + box.height / 2] as const,
      );
      expect(hit, `a press at the button's centre reaches the button through the ring while it reads ${word}`).toBe(word);
    };

    await readAt(COPY_LABELS.idle);
    const centre = async (): Promise<{ x: number; y: number }> => {
      const box = await button.boundingBox();
      if (box === null) throw new Error('the Copy button has no box');
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    let at = await centre();
    await page.mouse.click(at.x, at.y);
    await readAt(COPY_LABELS.copied);
    expect(await page.evaluate(() => (window as unknown as { __clipWrites: string[] }).__clipWrites), 'Copy wrote the URL').toEqual([ROUTE_URL]);
    await expect(button, 'the button goes back to Copy').toHaveText(COPY_LABELS.idle, { timeout: 5000 });
    await page.evaluate(() => {
      (window as unknown as { __clipFail: boolean }).__clipFail = true;
    });
    at = await centre();
    await page.mouse.click(at.x, at.y);
    await readAt(COPY_LABELS.failed);
  });

  test('at the wire draw the ring layer holds exactly the two wire discs, and nothing on the Fault, at zoom near 1 and near 2', async ({ page }) => {
    const host = requestHost(ROUTE_URL);
    const { h } = await startRequestLesson(page, host);
    const board = await placeRouteAndHandler(page, h, host);
    await pressRing(page, await ringAt(page, STAGE.wireTool));
    for (const [lo, hi] of [
      [0.9, 1.1],
      [1.8, 2.2],
    ] as const) {
      const { from } = await wireDiscs(page);
      const into = await nubCentre(page, board.handler.id, HANDLER_IN);
      const fromCentre = from.hitCentre ?? centreOf(from);
      const scale = await zoomInto(page, { x: (fromCentre.x + into.x) / 2, y: (fromCentre.y + into.y) / 2 }, lo, hi);
      // Read again at this zoom, after the ring's next paint.
      await page.waitForTimeout(100);
      const probe = await readProbe(page);
      const rings = await visibleRings(page);
      expect(rings.length, `at zoom ${scale.toFixed(2)} the ring layer holds exactly two rings`).toBe(2);
      const out = await nubCentre(page, board.route.id, ROUTE_OUT);
      const inn = await nubCentre(page, board.handler.id, HANDLER_IN);
      const fault = await nubCentre(page, board.handler.id, HANDLER_FAULT);
      const want = wireNubHitRadiusWorld(scale) * scale;
      for (const [name, disc, dot] of [
        ["the Route's Out", probe.hint, out],
        ["the Handler's In", probe.hintTo, inn],
      ] as const) {
        if (disc === null || disc.hitCentre === undefined || disc.hitRadiusPx === undefined) throw new Error(`no disc on ${name} at zoom ${scale}`);
        expect(disc.shape, `the ring on ${name} is a disc`).toBe('circle');
        expect(Math.hypot(disc.hitCentre.x - dot.x, disc.hitCentre.y - dot.y), `the disc is centred on ${name}'s dot`).toBeLessThanOrEqual(1);
        expect(Math.abs(disc.hitRadiusPx - want), `the disc on ${name} is the Wire tool's hit radius at zoom ${scale.toFixed(2)}`).toBeLessThanOrEqual(0.01);
      }
      for (const ring of rings) expect(within(fault, ring), `no ring covers the Handler's Fault at zoom ${scale.toFixed(2)}`).toBe(false);
    }
  });

  test('a drag from the Handler Out to the Route In lays both cables and finishes step 3', async ({ page }) => {
    const host = requestHost(ROUTE_URL);
    const { h } = await startRequestLesson(page, host);
    const board = await placeRouteAndHandler(page, h, host);
    await pressRing(page, await ringAt(page, STAGE.wireTool));
    await wireDiscs(page);
    const from = await nubCentre(page, board.handler.id, HANDLER_OUT);
    const to = await nubCentre(page, board.route.id, ROUTE_IN);
    const wires = sentCount(h, CMD.DrawWire);
    await dragBetween(page, from, to);
    await expect.poll(() => sentCount(h, CMD.DrawWire), { message: 'the reverse drag sent a wire' }).toBe(wires + 1);
    // One drag lays the cable both ways, whichever end it starts from.
    board.wires = wireLegs(board.route, board.handler);
    injectBoard(h, { nodes: [board.route, board.handler], wires: board.wires, tick: ++board.tick });
    await expectAt(page, STEP.answer, STAGE.toolDown, 'both cables from a reverse drag finished step 3');
  });

  test('after the URL was read, deselecting the Route shows the select stage, and a reply still finishes the lesson', async ({ page }) => {
    const { h, board } = await toAnswerStep(page);
    await selectRoute(page);
    await ringAt(page, STAGE.sendRequest);
    const floor = await emptyFloor(page, board.route);
    await page.mouse.click(floor.x, floor.y);
    await expectAt(page, STEP.answer, STAGE.selectRoute, 'a press on the empty floor deselected the Route');
    sendReply(h, board);
    await expect.poll(async () => (await readProbe(page)).card, { message: 'a reply with the Route deselected still finished the lesson' }).toBe('finished');
  });

  test("a reply on another Route and Handler's wire doesn't finish step 4", async ({ page }) => {
    const { h, board } = await toAnswerStep(page);
    await selectRoute(page);
    await ringAt(page, STAGE.sendRequest);
    const route2 = routeAt([board.route.cell_x, board.route.cell_y + 5], board.route.id + 10);
    const handler2 = handlerAt([board.handler.cell_x, board.handler.cell_y + 5], board.handler.id + 10);
    const others = (replyAt?: number) => wireLegs(route2, handler2, replyAt, 10);
    injectBoard(h, { nodes: [board.route, board.handler, route2, handler2], wires: [...board.wires, ...others()], tick: ++board.tick });
    await page.waitForTimeout(200);
    injectBoard(h, { nodes: [board.route, board.handler, route2, handler2], wires: [...board.wires, ...others(++board.tick)], tick: board.tick });
    await page.waitForTimeout(800);
    const probe = await readProbe(page);
    expect(probe.card, "a reply on the other pair's wire left the lesson running").toBe('running');
    expect(probe.stepId, "a reply on the other pair's wire left the card on step 4").toBe(STEP.answer);
    // And the lesson's own return wire still finishes it.
    board.wires = wireLegs(board.route, board.handler, ++board.tick);
    injectBoard(h, { nodes: [board.route, board.handler, route2, handler2], wires: [...board.wires, ...others()], tick: board.tick });
    await expect.poll(async () => (await readProbe(page)).card, { message: "the reply on the lesson's own wire finished it" }).toBe('finished');
  });

  test('after an Undo keyframe re-mints every handle, a reply on the rebound return wire finishes the lesson', async ({ page }) => {
    const { h, board } = await toAnswerStep(page);
    await selectRoute(page);
    await ringAt(page, STAGE.sendRequest);
    const shift = 10;
    const route = { ...board.route, id: board.route.id + shift, ports: board.route.ports };
    const handler = { ...board.handler, id: board.handler.id + shift, ports: board.handler.ports };
    board.route = route;
    board.handler = handler;
    board.generation += 1;
    board.wires = wireLegs(route, handler, undefined, shift);
    // A keyframe empties the scene's wires and their reply counts, and every handle is new.
    h.inject(
      buildPacket({
        full: true,
        tick: ++board.tick,
        generation: board.generation,
        swapFloor: 1,
        nodes: [route, handler],
        wires: board.wires,
        canUndo: true,
        canRedo: true,
      }),
    );
    await expect
      .poll(async () => (await readProbe(page)).bound.route, { message: 'the Route binding followed the keyframe to its new handle' })
      .toBe(route.id);
    expect((await readProbe(page)).stepId, 'the keyframe left the card on step 4').toBe(STEP.answer);
    board.wires = wireLegs(route, handler, ++board.tick, shift);
    injectBoard(h, { nodes: [route, handler], wires: board.wires, tick: board.tick, generation: board.generation });
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the reply on the rebound return wire finished the lesson' }).toBe('finished');
  });

  test('after a path Apply the request line follows the URL the row fetched again', async ({ page }) => {
    const { h, host, board } = await toAnswerStep(page);
    await selectRoute(page);
    await ringAt(page, STAGE.sendRequest);
    const word = await expectedCurlWord(page);
    await expect.poll(() => requestLineOf(page), { message: 'the first URL is on the card' }).toBe(`${word} -X POST ${ROUTE_URL}`);

    const ORDERS_URL = 'http://127.0.0.1:54321/endpoint/orders';
    const asked = host.urlAsked();
    // The host folds the new path and answers both queries with it from now on, as the real one does.
    host.set(board.route.id, routeConfig('/orders'));
    host.setUrl(ORDERS_URL);
    const inspector = page.locator('aside[aria-labelledby="fab-config-heading"]');
    await inspector.getByLabel('Path', { exact: true }).fill('/orders');
    const configures = sentCount(h, CMD.Configure);
    await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(() => sentCount(h, CMD.Configure), { message: 'Apply sent the new path' }).toBe(configures + 1);
    await expect.poll(() => host.urlAsked(), { message: 'the row asked the host for the URL again after the Apply' }).toBeGreaterThan(asked);
    await expect.poll(() => requestLineOf(page), { message: 'the request line follows the new URL' }).toBe(`${word} -X POST ${ORDERS_URL}`);
  });
});
