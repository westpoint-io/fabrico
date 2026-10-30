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

/** Boot on the mock host with one machine on the board. */
async function boot(page: Page, opts: Parameters<typeof mockRenderSocket>[1] = {}): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, opts);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
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
  });
});
