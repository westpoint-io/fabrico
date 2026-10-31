import { test, expect, type Locator, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { EMPTY_FLOOR_HEADING } from '../src/chrome/configCopy';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import { nubAnchor } from '../shared/geometry';
import {
  CELL,
  CMD,
  buildPacket,
  cameraOf,
  mockRenderSocket,
  screenCellCentre,
  waitForBoard,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
} from './support/wire';

// lessons.spec.ts - the step card and the hint ring, on a mock host.
//
// Every case reads rectangles and computed values, never a screenshot. The ring's rect comes from
// `ringAt`, which waits for one read of `window.__fabrico.tutorial()` that names the stage and holds a
// rect: the probe reports a rect only once the ring has moved for that stage, so a single read
// straight after a stage change could catch the ring a frame early.

/** The ring's outset on each side of its target. */
const OUTSET = 4;
/** How far a rectangle may sit from where it belongs. */
const TOLERANCE = 1;
const STEP_COUNT = YOUR_FIRST_LINE.steps.length;
const PAUSED_SENTENCE = 'The board is paused, so your edits wait. Press Play in the toolbar, or press Space.';

/** The board on screen before the lesson's New. */
const OLD_MACHINE: InjectNode = { id: 1, kind: 7, cell_x: 12, cell_y: 8 };
const CARD = '[data-fab-step-card]';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readProbe(page: Page): Promise<TutorialProbe> {
  return page.evaluate(() => (window as unknown as { __fabrico: { tutorial(): TutorialProbe } }).__fabrico.tutorial());
}

/** Poll until one read names `stageId` and holds a rect, and return that read's rect. */
async function ringAt(page: Page, stageId: string): Promise<HintRect> {
  let rect: HintRect | null = null;
  await expect
    .poll(
      async () => {
        const probe = await readProbe(page);
        if (probe.stageId !== stageId) return `on stage ${probe.stageId}`;
        rect = probe.hint;
        return rect === null ? 'no rect yet' : 'held';
      },
      { message: `the ring was placed for stage ${stageId}` },
    )
    .toBe('held');
  return rect!;
}

async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no box`);
  return box;
}

function expectRingAround(ring: Box, target: Box, what: string): void {
  expect(Math.abs(ring.x - (target.x - OUTSET)), `${what}: left edge`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(ring.y - (target.y - OUTSET)), `${what}: top edge`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(ring.width - (target.width + 2 * OUTSET)), `${what}: width`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(ring.height - (target.height + 2 * OUTSET)), `${what}: height`).toBeLessThanOrEqual(TOLERANCE);
}

/** Well inside the 800 ms a playing board's silence takes to read as a dropped stream, even on a busy machine. */
const STREAM_RESEND_MS = 200;
const streamStops = new WeakMap<Page, () => void>();

/**
 * The same frame as a diff. A full keyframe clears the selection, and a re-sent one would do that to a
 * case that had just selected a machine. The `full` byte comes straight after the tick's varint.
 */
function asDiff(frame: Buffer): Buffer {
  let i = 0;
  while ((frame[i] as number) & 0x80) i += 1;
  const copy = Buffer.from(frame);
  copy[i + 1] = 0;
  return copy;
}

/**
 * The app reads a playing board's silence as a dropped stream, and the ring hides on one, so a case
 * that waits a moment on a quiet mock would lose its ring. This sends the last packet again until
 * `stopStream`, which leaves the board as it was: same tick, same machines, and a case's `inject` still
 * decides what the board holds.
 */
function keepStreamAlive(page: Page, h: Harness): void {
  const inject = h.inject.bind(h);
  let last: Buffer | null = null;
  h.inject = (frame: Buffer): void => {
    last = asDiff(frame);
    inject(frame);
  };
  const timer = setInterval(() => {
    if (last !== null) inject(last);
  }, STREAM_RESEND_MS);
  const stop = (): void => clearInterval(timer);
  streamStops.set(page, stop);
  page.once('close', stop);
}

function stopStream(page: Page): void {
  streamStops.get(page)?.();
}

/** Boot on the mock host with one machine on the board. */
async function boot(page: Page, opts: Parameters<typeof mockRenderSocket>[1] = {}): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, opts);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  keepStreamAlive(page, h);
  h.inject(buildPacket({ full: true, tick: 3, nodes: [OLD_MACHINE] }));
  await waitForBoard(page, { machines: 1, tick: 3 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return h;
}

/** Help, Lessons, Start, then the Starting card, then the empty board the host answers New with. */
async function startLesson(page: Page, h: Harness): Promise<void> {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
  await page.getByRole('button', { name: `Start ${YOUR_FIRST_LINE.title}`, exact: true }).click();
  await expect.poll(() => h.controls, { message: 'Start sent New' }).toContain('new');

  const card = page.locator(CARD);
  await expect(card, 'the card says the board is on its way').toContainText('Clearing the board.');
  await expect(card).not.toContainText(/Step \d/);
  const starting = await readProbe(page);
  expect(starting.card, 'the lesson waits for the new board').toBe('starting');
  expect(starting.hint, 'no ring while the board is on its way').toBeNull();
  await expect(page.locator('[data-fab-hint]'), 'no ring while the board is on its way').toBeHidden();

  h.inject(buildPacket({ full: true, tick: 5, generation: 1, swapFloor: 1 }));
  await expect.poll(async () => (await readProbe(page)).card, { message: 'the new board started step 1' }).toBe('running');
  await expect(card).toContainText(`Step 1 of ${STEP_COUNT}`);
}

/** Arm the Source and read the floor ring, with the cell it marks. */
async function armSourceForFloor(page: Page): Promise<{ ring: HintRect; cell: readonly [number, number] }> {
  await ringAt(page, 'source-tool');
  await page.getByRole('button', { name: 'Place Source', exact: true }).click();
  const ring = await ringAt(page, 'source-floor');
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  return { ring, cell: [Math.round((ring.x + OUTSET - cam.x) / size), Math.round((ring.y + OUTSET - cam.y) / size)] };
}

/** The most any edge of the ring sits from `cell` under the camera, both read in one evaluate. */
async function ringErrorOn(page: Page, cell: readonly [number, number]): Promise<number> {
  return page.evaluate(
    ([cx, cy, cellPx, outset]) => {
      const hook = (
        window as unknown as { __fabrico: { tutorial(): TutorialProbe; camera(): { x: number; y: number; scale: number } } }
      ).__fabrico;
      const hint = hook.tutorial().hint;
      if (hint === null) return Number.POSITIVE_INFINITY;
      const cam = hook.camera();
      const size = cellPx * cam.scale;
      return Math.max(
        Math.abs(hint.x - (cx * size + cam.x - outset)),
        Math.abs(hint.y - (cy * size + cam.y - outset)),
        Math.abs(hint.width - (size + 2 * outset)),
        Math.abs(hint.height - (size + 2 * outset)),
      );
    },
    [cell[0], cell[1], CELL, OUTSET] as const,
  );
}

/** A Source on `cell`, as the host's answer to a Place: the next step's result. */
function sourceOn(cell: readonly [number, number], tick: number): Buffer {
  return buildPacket({
    full: false,
    tick,
    generation: 1,
    swapFloor: 1,
    nodes: [{ id: 2, kind: 0, cell_x: cell[0], cell_y: cell[1], ports: [{ index: 0, cell_x: cell[0], cell_y: cell[1], side: 1, role: 1 }] }],
  });
}

test.describe('the step card and the hint ring', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the ring sits on its palette row', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const ring = await ringAt(page, 'source-tool');
    const row = await boxOf(page.getByRole('button', { name: 'Place Source', exact: true }), 'the Source row');
    expectRingAround(ring, row, 'the ring around the Source row');

    // The stylesheet paints it: a ring with no paint would still report the right rect.
    const paint = await page.evaluate(() => {
      const inner = document.querySelector('[data-fab-hint] .fab-hint');
      if (inner === null) return null;
      const cs = getComputedStyle(inner);
      const focus = getComputedStyle(document.documentElement).getPropertyValue('--fab-focus').trim().replace('#', '');
      const rgb = [0, 2, 4].map((i) => parseInt(focus.slice(i, i + 2), 16)).join(', ');
      return { border: cs.borderTopWidth, style: cs.borderTopStyle, colour: cs.borderTopColor, want: `rgb(${rgb})`, width: inner.getBoundingClientRect().width };
    });
    expect(paint, 'the ring has its painted element').not.toBeNull();
    expect(paint!.border).toBe('2px');
    expect(paint!.style).toBe('solid');
    expect(paint!.colour, 'the ring is the focus colour').toBe(paint!.want);
    expect(Math.abs(paint!.width - ring.width), 'the paint fills the ring').toBeLessThanOrEqual(TOLERANCE);

    // A row below the fold of the palette's scrolling column scrolls into view when its stage begins.
    await page.setViewportSize({ width: 1280, height: 420 });
    const { cell } = await armSourceForFloor(page);
    const camBefore = await cameraOf(page);
    const tools = page.getByTestId('palette-tools');
    await tools.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await tools.evaluate((el) => el.scrollTop), 'the palette column did scroll away from the top').toBeGreaterThan(0);
    const sinkRow = page.getByRole('button', { name: 'Place Sink', exact: true });
    h.inject(sourceOn(cell, 6));
    const sinkRing = await ringAt(page, 'sink-tool');
    const list = await boxOf(tools, 'the palette column');
    const shown = await boxOf(sinkRow, 'the Sink row');
    expect(shown.y, 'the Sink row came into the column').toBeGreaterThanOrEqual(list.y - TOLERANCE);
    expect(shown.y + shown.height, 'the Sink row came into the column').toBeLessThanOrEqual(list.y + list.height + TOLERANCE);
    expectRingAround(sinkRing, shown, 'the ring around the Sink row');
    expect(await cameraOf(page), 'scrolling chrome leaves the camera alone').toEqual(camBefore);
  });

  test('the floor ring follows zoom and pan', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const { cell } = await armSourceForFloor(page);
    const first = await cameraOf(page);
    expect(await ringErrorOn(page, cell), 'at the first camera').toBeLessThanOrEqual(TOLERANCE);

    await page.mouse.move(640, 400);
    // Outwards, because an empty board can boot at the zoom limit.
    await page.mouse.wheel(0, 240);
    await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the wheel changed the zoom' }).not.toBe(first.scale);
    await expect
      .poll(() => ringErrorOn(page, cell), { message: 'the ring stays on its cell at the second zoom level' })
      .toBeLessThanOrEqual(TOLERANCE);

    const zoomed = await cameraOf(page);
    await page.mouse.move(640, 400);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(700, 440, { steps: 5 });
    await page.mouse.move(760, 460, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    await expect
      .poll(async () => (await cameraOf(page)).x, { message: 'the middle-drag panned the board' })
      .not.toBe(zoomed.x);
    await expect
      .poll(() => ringErrorOn(page, cell), { message: 'the ring stays on its cell after the pan' })
      .toBeLessThanOrEqual(TOLERANCE);
    expect((await cameraOf(page)).scale, 'the pan kept the second zoom level').toBe(zoomed.scale);
  });

  test('the ring takes no press', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);

    /** What a press at this point would land on. */
    const hitAt = (x: number, y: number) =>
      page.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px, py);
          const ring = document.querySelector('[data-fab-hint]');
          return {
            inLayer: el?.closest('[data-fab-hint-layer]') != null,
            inCard: el?.closest('[data-fab-step-card]') != null,
            onRow: el?.closest('button[aria-label="Place Source"]') != null,
            onCanvas: el?.tagName === 'CANVAS',
            ringEvents: ring === null ? null : getComputedStyle(ring).pointerEvents,
          };
        },
        [x, y] as const,
      );

    await ringAt(page, 'source-tool');
    const row = await boxOf(page.getByRole('button', { name: 'Place Source', exact: true }), 'the Source row');
    const rowCentre = { x: row.x + row.width / 2, y: row.y + row.height / 2 };
    const onRow = await hitAt(rowCentre.x, rowCentre.y);
    expect(onRow.inLayer, 'at the row centre, the ring layer takes no press').toBe(false);
    expect(onRow.onRow, 'at the row centre, the press reaches the row').toBe(true);
    expect(onRow.ringEvents, "the ring's computed pointer-events").toBe('none');
    await page.mouse.click(rowCentre.x, rowCentre.y);

    const ring = await ringAt(page, 'source-floor');
    const floorCentre = { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
    const onFloor = await hitAt(floorCentre.x, floorCentre.y);
    expect(onFloor.inLayer, 'at the cell centre, the ring layer takes no press').toBe(false);
    expect(onFloor.onCanvas, 'at the cell centre, the press reaches the board').toBe(true);
    expect(onFloor.ringEvents, "the ring's computed pointer-events").toBe('none');
    const sentBefore = h.sent.length;
    await page.mouse.click(floorCentre.x, floorCentre.y);
    await expect.poll(() => h.sent.length, { message: 'the press under the ring sent a command' }).toBeGreaterThan(sentBefore);
    expect(h.sent[sentBefore]?.[0], 'the command is a Place').toBe(CMD.Place);

    // The card's body lets a press through too. The tool stays armed after a place, so a press
    // there that reaches the board sends another Place.
    const text = await boxOf(page.locator(`${CARD} [aria-live]`), "the card's text");
    const textCentre = { x: text.x + text.width / 2, y: text.y + text.height / 2 };
    const onCard = await hitAt(textCentre.x, textCentre.y);
    expect(onCard.inCard, "at the centre of the card's text, the card takes no press").toBe(false);
    expect(onCard.onCanvas, "at the centre of the card's text, the press reaches the board").toBe(true);
    const sentBeforeCard = h.sent.length;
    await page.mouse.click(textCentre.x, textCentre.y);
    await expect
      .poll(() => h.sent.length, { message: "the press on the card's text sent a command" })
      .toBeGreaterThan(sentBeforeCard);
    expect(h.sent[sentBeforeCard]?.[0], 'the command is a Place').toBe(CMD.Place);
  });

  test('the card sits above the open Legend', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const card = page.locator(CARD);
    await page.getByRole('button', { name: 'Legend' }).click();
    const legend = page.locator('#fab-legend-panel');
    await expect(legend).toBeVisible();

    const gap = async (): Promise<number> => {
      const c = await boxOf(card, 'the card');
      const l = await boxOf(legend, 'the Legend');
      return l.y - (c.y + c.height);
    };
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      await expect
        .poll(async () => Math.abs((await gap()) - 8), { message: `at ${size.width}x${size.height} the card ends 8 px above the Legend` })
        .toBeLessThanOrEqual(TOLERANCE);
    }
  });

  test('the card stays clear of the window', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const box = await boxOf(page.locator(CARD), 'the card');
    expect(Math.abs(800 - (box.y + box.height) - 24), "the card ends 24 px above the window's bottom").toBeLessThanOrEqual(TOLERANCE);
    const text = await page.locator(`${CARD} [aria-live]`).evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(text.clientWidth, 'the text box has width').toBeGreaterThan(0);
    expect(text.scrollWidth, 'the text stays inside its box').toBeLessThanOrEqual(text.clientWidth);
  });

  test('the card takes no focus', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    const focused = () => page.evaluate(() => document.activeElement?.tagName ?? null);
    const before = await focused();
    expect(before, 'the panel that held focus has gone, so focus is on the body').toBe('BODY');

    h.inject(sourceOn([20, 10], 6));
    await expect(page.locator(CARD), 'the card moved on to the next step').toContainText(`Step 2 of ${STEP_COUNT}`);
    expect(await focused(), 'the card took no focus when it changed').toBe(before);

    await page.keyboard.press(' ');
    await expect.poll(() => h.controls, { message: 'Space reached the board with the card open' }).toContain('pause');
    expect(await focused(), 'and focus stayed where it was').toBe(before);
  });

  test('a paused board sends the user to Play', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    await page.locator('header button[aria-label="Pause"]').click();
    await expect.poll(() => h.controls, { message: 'the Pause press reached the host' }).toContain('pause');

    const ring = await ringAt(page, 'board-paused');
    const play = page.locator('header button[aria-label="Play"]');
    expectRingAround(ring, await boxOf(play, 'the Play button'), 'the ring around Play');
    const card = page.locator(CARD);
    await expect(card, 'the card says why edits wait').toContainText(PAUSED_SENTENCE);
    await expect(card, 'the card keeps its place in the lesson').toContainText(`Step 1 of ${STEP_COUNT}`);

    await play.click();
    await expect.poll(() => h.controls, { message: 'the Play press reached the host' }).toContain('resume');
    const back = await ringAt(page, 'source-tool');
    expectRingAround(back, await boxOf(page.getByRole('button', { name: 'Place Source', exact: true }), 'the Source row'), 'the ring back on the Source row');
    await expect(card, 'the card is back on the instruction').toContainText('Click Source in the palette.');
  });

  test('the empty-floor text hides', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await waitForBoard(page, { machines: 0, tick: 5 });
    const heading = page.getByRole('heading', { name: EMPTY_FLOOR_HEADING });
    await expect(heading, 'the board is empty and a lesson is on screen').toHaveCount(0);

    await page.locator(CARD).getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(page.locator(CARD), 'Leave closes the card').toHaveCount(0);
    await expect(page.locator('[data-fab-hint-layer]'), 'and the ring').toHaveCount(0);
    await expect(heading, 'the text comes back after Leave, since the board is still empty').toBeVisible();
    const probe = await readProbe(page);
    expect(probe.card).toBe('none');
    expect(probe.lessonId, 'the lesson is remembered, so it can resume').toBe(YOUR_FIRST_LINE.id);
    expect(h.controls.filter((c) => c === 'new'), 'Leave leaves the board as it is').toEqual(['new']);
  });
});

// THE SIX STEPS, on a mock host. The socket sends a packet only when a case injects one, so the board's
// tick moves only then, and a step can be read while it waits.

const SOURCE_ID = 2;
const SINK_ID = 3;
const BELT_ID = 4;
/** The port ring's diameter on screen. */
const PORT_RING = 32;
/** A little over the layer's query period, so a read has had time to land. */
const TWO_TRIGGER_READS_MS = 900;

type Trigger = { kind: 'Webhook' } | { kind: 'Timer'; interval_ticks: number };

/** A host whose `machine_config` answer the case can change, counting how often it was asked. */
function configuredHost(): { opts: Parameters<typeof mockRenderSocket>[1]; set(t: Trigger): void; asked(): number } {
  let trigger: Trigger = { kind: 'Webhook' };
  let asked = 0;
  return {
    opts: {
      answerQuery: (verb) => {
        if (verb !== 'machine_config') return undefined;
        asked += 1;
        return { kind: 'Source', trigger };
      },
    },
    set: (t) => {
      trigger = t;
    },
    asked: () => asked,
  };
}

function sourceAt(cell: readonly [number, number]): InjectNode {
  return { id: SOURCE_ID, kind: 0, cell_x: cell[0], cell_y: cell[1], ports: [{ index: 0, cell_x: cell[0], cell_y: cell[1], side: 1, role: 1 }] };
}

/** The fault port comes first, so a ring that took the first port would sit on it. */
function sinkAt(cell: readonly [number, number]): InjectNode {
  return {
    id: SINK_ID,
    kind: 7,
    cell_x: cell[0],
    cell_y: cell[1],
    ports: [
      { index: 0, cell_x: cell[0], cell_y: cell[1], side: 2, role: 2 },
      { index: 1, cell_x: cell[0], cell_y: cell[1], side: 3, role: 0 },
    ],
  };
}

function cellOfRing(ring: HintRect, cam: { x: number; y: number; scale: number }): readonly [number, number] {
  const size = CELL * cam.scale;
  return [Math.round((ring.x + OUTSET - cam.x) / size), Math.round((ring.y + OUTSET - cam.y) / size)];
}

/** Steps 1 and 2 through the floor rings, with the host's answers injected. The Sink's tool stays armed. */
async function placeBoth(page: Page, h: Harness): Promise<{ source: InjectNode; sink: InjectNode; tick: number }> {
  const { cell } = await armSourceForFloor(page);
  const source = sourceAt(cell);
  h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));
  await ringAt(page, 'sink-tool');
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  const sinkRing = await ringAt(page, 'sink-floor');
  const sink = sinkAt(cellOfRing(sinkRing, await cameraOf(page)));
  expect([sink.cell_x, sink.cell_y], "the Sink's spot isn't the Source's cell").not.toEqual(cell);
  h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sink] }));
  return { source, sink, tick: 7 };
}

/** A press at a rect's centre. */
async function pressRing(page: Page, ring: Box): Promise<void> {
  await page.mouse.click(ring.x + ring.width / 2, ring.y + ring.height / 2);
}

const timerButton = (page: Page): Locator => page.locator('[role="group"][aria-label="Trigger"]').getByRole('button', { name: 'Timer', exact: true });
const applyButton = (page: Page): Locator => page.locator('aside[aria-labelledby="fab-config-heading"]').getByRole('button', { name: 'Apply', exact: true });

/** Put the armed tool down, select the Source through its ring, and press Timer through its ring. */
async function pressTimer(page: Page): Promise<void> {
  await ringAt(page, 'tool-down');
  await page.keyboard.press('Escape');
  await pressRing(page, await ringAt(page, 'select-source'));
  await pressRing(page, await ringAt(page, 'press-timer'));
}

/** From a placed pair to the belt tool armed, with the host answering Timer after Apply. */
async function toBeltDraw(page: Page, host: ReturnType<typeof configuredHost>): Promise<void> {
  await pressTimer(page);
  await pressRing(page, await ringAt(page, 'apply-timer'));
  host.set({ kind: 'Timer', interval_ticks: 60 });
  await pressRing(page, await ringAt(page, 'belt-tool'));
  await ringAt(page, 'belt-draw');
}

/** Both of the drag's rings from one read, and how far each sits from its port dot under the camera. */
async function portRingErrors(
  page: Page,
  from: { cell_x: number; cell_y: number; side: number },
  to: { cell_x: number; cell_y: number; side: number },
): Promise<{ from: number; to: number; size: number }> {
  const a = nubAnchor(from.cell_x, from.cell_y, from.side);
  const b = nubAnchor(to.cell_x, to.cell_y, to.side);
  return page.evaluate(
    ([ax, ay, bx, by]) => {
      const hook = (window as unknown as { __fabrico: { tutorial(): TutorialProbe; camera(): { x: number; y: number; scale: number } } }).__fabrico;
      const probe = hook.tutorial();
      const cam = hook.camera();
      const off = (r: HintRect | null, wx: number, wy: number): number =>
        r === null
          ? Number.POSITIVE_INFINITY
          : Math.max(Math.abs(r.x + r.width / 2 - (wx * cam.scale + cam.x)), Math.abs(r.y + r.height / 2 - (wy * cam.scale + cam.y)));
      return {
        from: off(probe.hint, ax, ay),
        to: off(probe.hintTo, bx, by),
        size: Math.max(probe.hint?.width ?? 0, probe.hintTo?.width ?? 0),
      };
    },
    [a.x, a.y, b.x, b.y] as const,
  );
}

/** Zoom out at the window's middle and wait for the camera, then pan with the middle button. */
async function zoomOut(page: Page): Promise<void> {
  const before = await cameraOf(page);
  await page.mouse.move(640, 300);
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the wheel changed the zoom' }).not.toBe(before.scale);
}

async function panBoard(page: Page): Promise<void> {
  const before = await cameraOf(page);
  await page.mouse.move(640, 300);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(690, 330, { steps: 5 });
  await page.mouse.move(730, 340, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => (await cameraOf(page)).x, { message: 'the middle-drag panned the board' }).not.toBe(before.x);
}

test.describe('the machine and port rings, and the rest of the lesson', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the machine and port rings sit on their targets at two zoom levels and after a pan', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    const { source, sink } = await placeBoth(page, h);

    // The armed row, then the machine.
    const armed = await ringAt(page, 'tool-down');
    expectRingAround(armed, await boxOf(page.getByRole('button', { name: 'Place Sink', exact: true }), 'the Sink row'), 'the ring on the armed row');
    await page.keyboard.press('Escape');
    await ringAt(page, 'select-source');
    const cell = [source.cell_x, source.cell_y] as const;
    expect(await ringErrorOn(page, cell), 'the machine ring at the first camera').toBeLessThanOrEqual(TOLERANCE);
    await zoomOut(page);
    await expect
      .poll(() => ringErrorOn(page, cell), { message: 'the machine ring at the second zoom level' })
      .toBeLessThanOrEqual(TOLERANCE);
    await panBoard(page);
    await expect
      .poll(() => ringErrorOn(page, cell), { message: 'the machine ring after the pan' })
      .toBeLessThanOrEqual(TOLERANCE);

    // The inspector's controls, then the Belt row, each under the ring its stage names.
    await pressRing(page, await ringAt(page, 'select-source'));
    const timerRing = await ringAt(page, 'press-timer');
    expectRingAround(timerRing, await boxOf(timerButton(page), 'the Timer segment'), 'the ring on Timer');
    await pressRing(page, timerRing);
    const applyRing = await ringAt(page, 'apply-timer');
    expectRingAround(applyRing, await boxOf(applyButton(page), 'the Apply button'), 'the ring on Apply');
    await pressRing(page, applyRing);
    host.set({ kind: 'Timer', interval_ticks: 60 });
    const beltRing = await ringAt(page, 'belt-tool');
    expectRingAround(beltRing, await boxOf(page.locator('[data-fab-left-dock]').getByRole('button', { name: 'Belt', exact: true }), 'the Belt row'), 'the ring on the Belt row');
    await pressRing(page, beltRing);

    // The drag's two rings, from one read.
    await ringAt(page, 'belt-draw');
    const read = await readProbe(page);
    expect(read.stageId).toBe('belt-draw');
    expect(read.hint, 'the first ring').not.toBeNull();
    expect(read.hintTo, 'the release ring, from the same read').not.toBeNull();
    expect(read.hint?.shape).toBe('circle');
    expect(read.hintTo?.shape).toBe('circle');
    await expect(page.locator('[data-fab-hint-to]'), 'the release ring is on screen').toBeVisible();

    const out = source.ports![0]!;
    const into = sink.ports![1]!;
    const errors = await portRingErrors(page, out, into);
    expect(errors.from, 'the out ring at the third camera').toBeLessThanOrEqual(TOLERANCE);
    expect(errors.to, 'the in ring at the third camera').toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(errors.size - PORT_RING), 'a port ring keeps its size on screen').toBeLessThanOrEqual(TOLERANCE);

    await zoomOut(page);
    await expect
      .poll(async () => {
        const e = await portRingErrors(page, out, into);
        return Math.max(e.from, e.to, Math.abs(e.size - PORT_RING));
      }, { message: 'the port rings at another zoom level' })
      .toBeLessThanOrEqual(TOLERANCE);
    await panBoard(page);
    await expect
      .poll(async () => {
        const e = await portRingErrors(page, out, into);
        return Math.max(e.from, e.to, Math.abs(e.size - PORT_RING));
      }, { message: 'the port rings after the pan' })
      .toBeLessThanOrEqual(TOLERANCE);

    // The ring on the in port names the right dot: the fixture's first port is the Sink's fault dot.
    const fault = nubAnchor(sink.ports![0]!.cell_x, sink.ports![0]!.cell_y, sink.ports![0]!.side);
    const inAnchor = nubAnchor(into.cell_x, into.cell_y, into.side);
    expect(fault, 'the fixture keeps the two dots apart').not.toEqual(inAnchor);
  });

  test('pressing Timer finishes nothing until the host answers Timer', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    await placeBoth(page, h);
    await pressTimer(page);

    // The button shows Timer, and the host still answers Webhook.
    await ringAt(page, 'apply-timer');
    await expect(timerButton(page)).toHaveAttribute('aria-pressed', 'true');
    let asked = host.asked();
    await expect.poll(() => host.asked(), { message: 'the layer keeps asking' }).toBeGreaterThan(asked);
    await page.waitForTimeout(TWO_TRIGGER_READS_MS);
    let probe = await readProbe(page);
    expect(probe.stepId, 'a pressed Timer finishes nothing').toBe('set-timer');
    expect(probe.stageId).toBe('apply-timer');

    // Apply sends the Configure, and the host still hasn't answered Timer.
    const sentBefore = h.sent.length;
    await applyButton(page).click();
    await expect
      .poll(() => h.sent.slice(sentBefore).some((frame) => frame[0] === CMD.Configure), { message: 'Apply sent a Configure' })
      .toBe(true);
    asked = host.asked();
    await expect.poll(() => host.asked(), { message: 'the layer keeps asking after Apply' }).toBeGreaterThan(asked);
    await page.waitForTimeout(TWO_TRIGGER_READS_MS);
    probe = await readProbe(page);
    expect(probe.stepId, 'Apply on its own finishes nothing either').toBe('set-timer');

    // Only the answer moves the lesson.
    host.set({ kind: 'Timer', interval_ticks: 60 });
    await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the Timer answer finished the step' }).toBe('draw-belt');
  });

  test('the card reads Lesson done with the board still running', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    const { source, sink, tick } = await placeBoth(page, h);
    await toBeltDraw(page, host);

    const belt = (itemSlots: number[]): InjectBelt => ({
      id: BELT_ID,
      tiles: [
        [source.cell_x + 1, source.cell_y],
        [source.cell_x + 2, source.cell_y],
      ],
      itemSlots,
      docks: [
        { end: 'Tail', node: SOURCE_ID, port: 0 },
        { end: 'Head', node: SINK_ID, port: 0 },
      ],
    });
    const at = (t: number, itemSlots: number[]): Buffer =>
      buildPacket({ full: false, tick: t, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [belt(itemSlots)] });

    h.inject(at(tick + 1, []));
    await expect.poll(async () => (await readProbe(page)).stageId, { message: 'the belt finished draw-belt' }).toBe('board-running');
    let probe = await readProbe(page);
    expect(probe.stepId, 'a mock board holds here until its tick moves').toBe('press-play');
    expect(probe.hint, 'a running board has nothing to point at').toBeNull();

    h.inject(at(tick + 2, [5]));
    await expect.poll(async () => (await readProbe(page)).stageId, { message: 'the higher tick finished press-play' }).toBe('watch');
    const card = page.locator(CARD);
    await expect(card, 'the note says why step 5 went').toContainText('The board was already running, so step 5 is done. Space pauses it.');
    await expect(card).toContainText(`Step 6 of ${STEP_COUNT}`);
    await expect(card).toContainText('Watch the dots ride the Belt into the Sink.');
    const sinkRing = await ringAt(page, 'watch');
    expect(await ringErrorOn(page, [sink.cell_x, sink.cell_y]), 'the ring sits on the Sink').toBeLessThanOrEqual(TOLERANCE);
    expect(sinkRing.shape).toBe('square');

    // An item at the head has not been taken, however long it sits there.
    h.inject(at(tick + 3, [0]));
    h.inject(at(tick + 4, [0]));
    await expect.poll(async () => (await readProbe(page)).stepId).toBe('watch-items');
    probe = await readProbe(page);
    expect(probe.card, 'a held item finishes nothing').toBe('running');

    h.inject(at(tick + 5, []));
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the delivery finished the lesson' }).toBe('finished');
    await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
    await expect(card).toContainText('A Source makes items, a Belt carries them and a Sink takes them in. The board is yours, so keep building.');
    await expect(card).not.toContainText(/Step \d/);
    await expect(page.locator('[data-fab-hint]'), 'no ring on a finished lesson').toBeHidden();
    expect((await readProbe(page)).hint).toBeNull();
    await expect(page.locator('header button[aria-label="Pause"]'), 'the board is still running').toBeVisible();
    expect(h.controls, 'finishing the lesson sent no pause').not.toContain('pause');

    // The card stays put as the board carries on, and it fits its box.
    h.inject(at(tick + 6, [3]));
    await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
    const text = await card.locator('[aria-live]').evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(text.scrollWidth, 'the closing sentence stays inside its box').toBeLessThanOrEqual(text.clientWidth);

    await card.getByRole('button', { name: 'Back to lessons', exact: true }).click();
    await expect(card, 'the card goes').toHaveCount(0);
    await expect(page.locator('#fab-lessons-panel'), 'and the list opens').toBeVisible();
    // The row a real finish leaves, with the board still as the lesson left it.
    await expectRow(page, 'Done', ['Restart Your first line'], []);
    expect(h.controls.filter((c) => c === 'new'), 'going back to the list sent no New').toEqual(['new']);
  });

  for (const size of [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
  ]) {
    test(`the inspector stays clear of both machines at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      const host = configuredHost();
      const h = await boot(page, host.opts);
      await startLesson(page, h);
      // An empty mock board boots at the zoom limit, where six cells doesn't fit any window.
      await page.mouse.move(640, 300);
      for (let i = 0; i < 12 && (await cameraOf(page)).scale > 1; i++) await zoomOut(page);

      const { source, sink } = await placeBoth(page, h);
      await pressTimer(page);
      const panel = await boxOf(page.locator('aside[aria-labelledby="fab-config-heading"]'), 'the inspector');
      const cam = await cameraOf(page);
      const rightEdgeOf = (n: InjectNode): number => (n.cell_x + 1) * CELL * cam.scale + cam.x;
      // The port dot is the belt's release point, so the whole machine has to clear the panel.
      expect(rightEdgeOf(source), 'the Source sits left of the inspector').toBeLessThan(panel.x);
      expect(rightEdgeOf(sink), 'the Sink sits left of the inspector').toBeLessThan(panel.x);
      expect(sink.cell_x, 'the Sink is east of the Source, so the belt runs straight').toBeGreaterThan(source.cell_x);
    });
  }
});

// THE LESSON LIST AND THE LESSON'S LIFECYCLE, on a mock host.

const PANEL = '#fab-lessons-panel';
const START = `Start ${YOUR_FIRST_LINE.title}`;
const RESUME = `Resume ${YOUR_FIRST_LINE.title}`;
const RESTART = `Restart ${YOUR_FIRST_LINE.title}`;
const GUARD_HEADING = 'Start a new board?';
const STOPPED_TITLE = 'Unavailable: the simulation stopped';
const SWAPPED_SENTENCE = 'The board changed, so this lesson stopped. Restart it, or leave it.';

const lessonRow = (page: Page): Locator => page.locator(`${PANEL} [data-fab-lesson-row="${YOUR_FIRST_LINE.id}"]`);
const guardButton = (page: Page, name: 'Cancel' | 'Discard' | 'Save'): Locator => page.locator('.fab-dialog-panel').getByRole('button', { name });

/** A row is read whole, so a test can't pass on the word alone. The buttons' names are read by their aria-label. */
async function expectRow(page: Page, status: string, buttons: readonly string[], accents: readonly string[]): Promise<void> {
  const row = lessonRow(page);
  await expect(row, `the row reads ${status}`).toContainText(status);
  await expect
    .poll(() => row.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))), { message: `the row offers ${buttons.join(', ')}` })
    .toEqual([...buttons]);
  const accented = await page.locator(`${PANEL} .fab-cta`).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(accented, 'the accent').toEqual([...accents]);
}

async function openLessons(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
  await expect(page.locator(PANEL)).toBeVisible();
}

async function pressLeave(page: Page): Promise<void> {
  await page.locator(CARD).getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page.locator(CARD), 'Leave closes the card').toHaveCount(0);
}

const newCount = (h: Harness): number => h.controls.filter((c) => c === 'new').length;
const modelNodes = (page: Page): Promise<Array<{ id: number; kind: number }>> =>
  page.evaluate(() => (window as unknown as { __fabrico: { scene(): { nodes: Array<{ id: number; kind: number }> } } }).__fabrico.scene().nodes);

/** A second board from the host, as a Load, an example or a New would bring. */
function swappedBoard(floor: number, tick: number): Buffer {
  return buildPacket({ full: true, tick, generation: floor, swapFloor: floor });
}

test.describe('the lesson list', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('each row state reads right', async ({ page }) => {
    const h = await boot(page);

    await openLessons(page);
    await expect(page.locator(PANEL)).toContainText('Each lesson starts on a new board, and you do the work with your own mouse.');
    await expectRow(page, 'Not started', [START], [START]);
    const start = page.getByRole('button', { name: START, exact: true });
    await expect(start, 'the button shows the plain word').toHaveText('Start');
    await expect(start, 'the list focuses its first action').toBeFocused();
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator(PANEL)).toHaveCount(0);

    await startLesson(page, h);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESTART], []);
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();

    await pressLeave(page);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESUME, RESTART], [RESUME]);
    await expect(page.getByRole('button', { name: RESUME, exact: true })).toHaveText('Resume');
    await expect(page.getByRole('button', { name: RESTART, exact: true })).toHaveText('Restart');

    // Left, and then the board was swapped: Resume goes, because a lesson never carries on against it.
    h.inject(swappedBoard(2, 6));
    await expectRow(page, 'In progress', [RESTART], []);
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();
    expect((await readProbe(page)).card, 'the swap woke nothing up').toBe('none');
  });

  test('a stored status reads right on a fresh load', async ({ page }) => {
    await page.addInitScript((id) => {
      localStorage.setItem('fab.tutorial.v1', JSON.stringify({ version: 1, lessons: { [id]: 'done' } }));
    }, YOUR_FIRST_LINE.id);
    const h = await boot(page);
    await openLessons(page);
    await expectRow(page, 'Done', [RESTART], []);

    // A finished lesson running again reads In progress on top of the stored Done.
    await page.getByRole('button', { name: RESTART, exact: true }).click();
    await expect.poll(() => newCount(h), { message: 'Restart sent New' }).toBe(1);
    h.inject(swappedBoard(1, 5));
    await expect(page.locator(CARD)).toContainText(`Step 1 of ${STEP_COUNT}`);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESTART], []);
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();

    // And goes back to Done once that run is gone.
    await pressLeave(page);
    h.inject(swappedBoard(2, 6));
    await openLessons(page);
    await expectRow(page, 'Done', [RESTART], []);
  });

  test('a lesson can be left, resumed and restarted', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const card = page.locator(CARD);

    h.inject(sourceOn([20, 10], 6));
    await expect(card).toContainText(`Step 2 of ${STEP_COUNT}`);

    await pressLeave(page);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESUME, RESTART], [RESUME]);

    await page.getByRole('button', { name: RESUME, exact: true }).click();
    await expect(card, 'Resume comes back on the saved step').toContainText(`Step 2 of ${STEP_COUNT}`);
    await expect(page.locator(PANEL), 'and closes the list').toHaveCount(0);
    expect(newCount(h), 'Resume sent no New').toBe(1);
    expect((await modelNodes(page)).map((n) => n.kind), 'the Source is still on the board').toEqual([0]);

    await pressLeave(page);
    await openLessons(page);
    await page.getByRole('button', { name: RESTART, exact: true }).click();
    // The Source made the board dirty, so Restart asks the question New asks.
    await expect(page.getByRole('alertdialog').getByText(GUARD_HEADING)).toBeVisible();
    expect(newCount(h), 'nothing is sent while the question is open').toBe(1);
    await guardButton(page, 'Discard').click();
    await expect.poll(() => newCount(h), { message: 'Discard sent a second New' }).toBe(2);
    await expect(card).toContainText('Clearing the board.');

    h.inject(swappedBoard(2, 8));
    await expect(card).toContainText(`Step 1 of ${STEP_COUNT}`);
    expect((await readProbe(page)).stepId).toBe('place-source');
    expect(await modelNodes(page), 'the new board is empty').toEqual([]);
  });

  test('Help and Lessons share one slot', async ({ page }) => {
    await boot(page);
    const help = page.locator('#fab-help-panel');
    const lessons = page.locator(PANEL);

    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(help).toBeVisible();
    await help.getByRole('button', { name: 'Lessons', exact: true }).click();
    await expect(help, 'opening the list closes Help').toHaveCount(0);
    await expect(lessons).toBeVisible();

    // The two dock in one place, and the status strip stays clear of the list.
    const box = await boxOf(lessons, 'the list');
    expect(Math.abs(box.y - 116), "the list's top is the shared dock").toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(1280 - (box.x + box.width) - 24), "the list's right edge").toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(box.width - (432 + 28)), 'the list is 432 px of content inside its padding').toBeLessThanOrEqual(TOLERANCE);
    const strip = await page.locator('[data-fab-status-strip]').boundingBox();
    if (strip !== null && strip.width > 0 && strip.height > 0) {
      const apart = strip.y + strip.height <= box.y + TOLERANCE || strip.x + strip.width <= box.x + TOLERANCE;
      expect(apart, 'the status strip dodges the list').toBe(true);
    }

    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(lessons, "the toolbar's Help closes the list").toHaveCount(0);
    await expect(help).toBeVisible();

    await help.getByRole('button', { name: 'Lessons', exact: true }).click();
    await expect(lessons).toBeVisible();
    await lessons.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(lessons).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help', exact: true }), 'Close hands focus back to Help').toBeFocused();

    await openLessons(page);
    await page.keyboard.press('Escape');
    await expect(lessons, 'Escape closes the list').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help', exact: true }), 'and hands focus back to Help').toBeFocused();

    // A selection closes it.
    await openLessons(page);
    const at = await screenCellCentre(page, OLD_MACHINE.cell_x, OLD_MACHINE.cell_y);
    await page.mouse.click(at.x, at.y);
    await expect(lessons, 'a selection closes the list').toHaveCount(0);
    const inspector = page.locator('aside[aria-labelledby="fab-config-heading"]');
    await expect(inspector, 'and the inspector opens').toBeVisible();

    // The inspector hides under the list and comes back, as it does for Help.
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await help.getByRole('button', { name: 'Lessons', exact: true }).click();
    await expect(lessons).toBeVisible();
    await expect(inspector, 'the list hides the inspector').toBeHidden();
    await lessons.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(inspector, 'closing the list brings it back').toBeVisible();
  });

  test('a board swap leaves focus where the user put it', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await pressLeave(page);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESUME, RESTART], [RESUME]);
    await expect(page.getByRole('button', { name: RESUME, exact: true }), 'the list focuses its first action').toBeFocused();

    // Restart stays mounted through the swap and becomes the row's first action. Focus stays on the toolbar.
    const help = page.getByRole('button', { name: 'Help', exact: true });
    await help.focus();
    h.inject(swappedBoard(2, 6));
    await expectRow(page, 'In progress', [RESTART], []);
    await expect(help, 'the swap moved no focus').toBeFocused();
    expect(newCount(h), 'and nothing was pressed').toBe(1);
  });

  test('declining the question leaves everything as it was', async ({ page }) => {
    const h = await boot(page);
    h.inject(buildPacket({ full: false, tick: 4, nodes: [{ id: 2, kind: 0, cell_x: 14, cell_y: 8 }] }));
    await waitForBoard(page, { machines: 2 });

    await openLessons(page);
    await expectRow(page, 'Not started', [START], [START]);
    await page.getByRole('button', { name: START, exact: true }).click();
    await expect(page.getByRole('alertdialog').getByText(GUARD_HEADING)).toBeVisible();

    await guardButton(page, 'Cancel').click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(h.controls, 'Cancel sent no New').not.toContain('new');
    expect((await modelNodes(page)).length, 'both machines are still there').toBe(2);
    await expect(page.locator(PANEL), 'the list is still open').toBeVisible();
    await expectRow(page, 'Not started', [START], [START]);
    const probe = await readProbe(page);
    expect(probe.card, 'no lesson runs').toBe('none');
    expect(probe.lessonId, 'and none was marked').toBeNull();
    await expect(page.locator(CARD)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('fab.tutorial.v1')), 'nothing was stored').toBeNull();

    await page.getByRole('button', { name: START, exact: true }).click();
    await guardButton(page, 'Discard').click();
    await expect.poll(() => h.controls, { message: 'Discard sent New' }).toContain('new');
    await expect(page.locator(CARD)).toContainText('Clearing the board.');
    await expect(page.locator(PANEL), 'the list closes on the way').toHaveCount(0);
  });

  test('the list scrolls on a short window', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 340 });
    await boot(page);
    await openLessons(page);

    const panel = await boxOf(page.locator(PANEL), 'the list');
    const box = page.locator(`${PANEL} [data-fab-help-scroll]`);
    await expect
      .poll(() => box.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight > 0), { message: 'the list scrolls in its own box' })
      .toBe(true);
    await expect.poll(() => box.evaluate((el) => (el as HTMLElement).tabIndex), { message: 'and that box is a tab stop' }).toBe(0);

    const inside = (b: Box, what: string): void => {
      expect(b.y, `${what} starts inside the list`).toBeGreaterThanOrEqual(panel.y - TOLERANCE);
      expect(b.y + b.height, `${what} ends inside the list`).toBeLessThanOrEqual(panel.y + panel.height + TOLERANCE);
    };
    inside(await boxOf(page.locator('#fab-lessons-heading'), 'the heading'), 'the heading');
    inside(await boxOf(page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }), 'Close'), 'Close');
    // 104 px is the camera cluster's clearance, the same bound Help keeps.
    expect(panel.y + panel.height, "the list's bottom keeps Help's height bound").toBeLessThanOrEqual(340 - 104 + TOLERANCE);
  });

  test('a stopped simulation disables Start and hides the ring', async ({ page }) => {
    const h = await boot(page);
    await openLessons(page);
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();
    await startLesson(page, h);
    const ring = await ringAt(page, 'source-tool');
    expect(ring.width, 'the ring is up before the stop').toBeGreaterThan(0);
    await pressLeave(page);

    await openLessons(page);
    await page.getByRole('button', { name: RESUME, exact: true }).click();
    await ringAt(page, 'source-tool');

    h.injectText(JSON.stringify({ kind: 'simFatal', reason: 'test' }));
    await expect.poll(async () => (await readProbe(page)).hint, { message: 'the ring hides a frame after the stop' }).toBeNull();
    await expect(page.locator('[data-fab-hint]'), 'and it is off the screen').toBeHidden();
    const card = page.locator(CARD);
    await expect(card, 'the card keeps its text').toContainText(`Step 1 of ${STEP_COUNT}`);

    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
    const restart = page.getByRole('button', { name: RESTART, exact: true });
    await expect(restart).toBeDisabled();
    await expect(restart).toHaveAttribute('title', STOPPED_TITLE);
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();

    await card.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(card, 'Leave still works').toHaveCount(0);
    expect(newCount(h), 'and nothing tried to reach the stopped host').toBe(1);
  });

  test('a stopped simulation disables a row that has not started', async ({ page }) => {
    const h = await boot(page);
    h.injectText(JSON.stringify({ kind: 'simFatal', reason: 'test' }));
    await openLessons(page);
    const start = page.getByRole('button', { name: START, exact: true });
    await expect(start).toBeDisabled();
    await expect(start).toHaveAttribute('title', STOPPED_TITLE);
    await expect(page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }), 'focus falls to Close').toBeFocused();
  });

  test('a dropped stream hides the ring and keeps the card', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    stopStream(page);
    await expect.poll(async () => (await readProbe(page)).hint, { message: 'the ring hides on a silent stream', timeout: 15_000 }).toBeNull();
    const card = page.locator(CARD);
    await expect(card, 'the card keeps its text').toContainText(`Step 1 of ${STEP_COUNT}`);
    h.inject(buildPacket({ full: false, tick: 20, generation: 1, swapFloor: 1 }));
    await ringAt(page, 'source-tool');
    await card.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(card, 'Leave still works').toHaveCount(0);
  });

  test('a corrupt stored value reads as empty', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fab.tutorial.v1', 'not json'));
    await boot(page);
    await openLessons(page);
    await expectRow(page, 'Not started', [START], [START]);
  });
});

test.describe('a swapped board and going back', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a swap moves the card to Lesson paused, and Restart starts again', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    const card = page.locator(CARD);

    h.inject(buildPacket({ full: true, tick: 9, generation: 2, swapFloor: 2, nodes: [OLD_MACHINE] }));
    await expect(card, 'the card says the lesson stopped').toContainText('Lesson paused');
    await expect(card).toContainText(SWAPPED_SENTENCE);
    await expect(card).not.toContainText(/Step \d/);
    await expect.poll(async () => (await readProbe(page)).hint, { message: 'the ring goes' }).toBeNull();
    await expect(page.locator('[data-fab-hint]')).toBeHidden();
    expect((await readProbe(page)).card).toBe('swapped');

    // A Source on that board finishes nothing.
    h.inject(buildPacket({ full: false, tick: 10, generation: 2, swapFloor: 2, nodes: [OLD_MACHINE, { id: 2, kind: 0, cell_x: 14, cell_y: 8 }] }));
    await waitForBoard(page, { machines: 2 });
    expect((await readProbe(page)).stepIndex, 'the lesson did not carry on against that board').toBe(0);

    await card.getByRole('button', { name: 'Restart', exact: true }).click();
    await expect(page.getByRole('alertdialog').getByText(GUARD_HEADING), 'that Source made the board dirty').toBeVisible();
    await guardButton(page, 'Discard').click();
    await expect.poll(() => newCount(h), { message: 'Restart sent New' }).toBe(2);
    h.inject(swappedBoard(3, 12));
    await expect(card).toContainText(`Step 1 of ${STEP_COUNT}`);
  });

  test('Leave on a swapped card leaves Restart alone in the row', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    h.inject(swappedBoard(2, 9));
    await expect(page.locator(CARD)).toContainText('Lesson paused');
    await pressLeave(page);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESTART], []);
  });

  test('a keyframe that keeps the floor is not a swap, and a handle it re-mints keeps its binding', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const card = page.locator(CARD);
    h.inject(sourceOn([20, 10], 6));
    await expect(card).toContainText(`Step 2 of ${STEP_COUNT}`);

    h.inject(buildPacket({ full: true, tick: 7, generation: 2, swapFloor: 1, nodes: [{ id: 40, kind: 0, cell_x: 20, cell_y: 10 }] }));
    await expect.poll(async () => (await readProbe(page)).bound.source, { message: 'the binding follows the new handle' }).toBe(40);
    const probe = await readProbe(page);
    expect(probe.card, 'an Undo never reads as a swap').toBe('running');
    expect(probe.stepId).toBe('place-sink');
    await expect(card).not.toContainText('Lesson paused');
  });

  test('a keyframe that removes the Source goes back to step 1 with a note', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const card = page.locator(CARD);
    h.inject(sourceOn([20, 10], 6));
    await expect(card).toContainText(`Step 2 of ${STEP_COUNT}`);

    h.inject(buildPacket({ full: true, tick: 7, generation: 2, swapFloor: 1 }));
    await expect(card).toContainText(`Step 1 of ${STEP_COUNT}`);
    await expect(card).toContainText('Step 1 needs doing again, so the lesson went back.');
    expect((await readProbe(page)).card).toBe('running');
  });

  test('a Source placed while left finishes step 1 on Resume, and the note says so', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await pressLeave(page);
    h.inject(sourceOn([20, 10], 6));
    await waitForBoard(page, { machines: 1 });

    await openLessons(page);
    await page.getByRole('button', { name: RESUME, exact: true }).click();
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 2 of ${STEP_COUNT}`);
    await expect(card).toContainText('Step 1 was already done, so the lesson moved on.');
    expect(newCount(h), 'Resume leaves the board as it is').toBe(1);
  });
});

test.describe('the welcome card opens the list', () => {
  // The mock configs preset the first-run flag, so this block clears it to see the card.
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });

  test('the welcome card opens the list', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ full: true, tick: 3, nodes: [OLD_MACHINE] }));
    await waitForBoard(page, { machines: 1, tick: 3 });

    const heading = page.getByRole('heading', { name: 'Welcome to Fabrico' });
    await expect(heading, 'the first-run card shows').toBeVisible();
    const buttons = page.locator('aside[aria-labelledby="fab-welcome-heading"]').getByRole('button');
    await expect(buttons).toHaveText(['Show the gestures', 'Start a lesson', 'Start building']);
    // Three labels fit on one line each at the narrowest supported window.
    await page.setViewportSize({ width: 1024, height: 768 });
    const lines = await buttons.evaluateAll((els) => els.map((el) => (el.querySelector('span') as HTMLElement).getClientRects().length));
    expect(lines, 'each label sits on one line').toEqual([1, 1, 1]);
    const palette = await boxOf(page.locator('[data-fab-left-dock]'), 'the palette');
    const welcome = await boxOf(page.locator('aside[aria-labelledby="fab-welcome-heading"]'), 'the card');
    expect(welcome.x, 'the card stays clear of the palette').toBeGreaterThan(palette.x + palette.width);
    await page.getByRole('button', { name: 'Start a lesson', exact: true }).click();

    await expect(page.locator(PANEL), 'the list opens').toBeVisible();
    await expect(heading, 'the card goes').toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('fab.onboarding.seen.v1')), 'and it stays gone').toBe('1');
    await expectRow(page, 'Not started', [START], [START]);
    expect(h.controls, 'opening the list starts nothing').not.toContain('new');
  });
});
