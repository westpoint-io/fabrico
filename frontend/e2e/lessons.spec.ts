import { test, expect, type Locator, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { EMPTY_FLOOR_HEADING } from '../src/chrome/configCopy';
import { SHORTCUTS } from '../src/input/shortcuts';
import { LESSONS } from '../src/tutorial/lessons/index';
import { DELETE_AND_UNDO } from '../src/tutorial/lessons/deleteAndUndo';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import { noteTokens } from '../src/tutorial/machine';
import { REAL_TABLES, phrasePlain } from '../src/tutorial/phrase';
import { nubAnchor } from '../shared/geometry';
import { doorstepCell, dropHitRadiusWorld } from '../src/protocol/ports';
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
import {
  CARD,
  OLD_MACHINE,
  OUTSET,
  SINK_ID,
  SOURCE_ID,
  STEP_COUNT,
  armSourceForFloor,
  boot,
  boxOf,
  configuredHost,
  panBoard,
  placeBoth,
  pressRing,
  pressTimer,
  readProbe,
  ringAt,
  sinkAt,
  sourceAt,
  startLesson,
  stopStream,
  toBeltDraw,
  zoomOut,
  type Box,
} from './support/lessonMock';

// lessons.spec.ts - the step card and the hint ring, on a mock host.
//
// Every case reads rectangles and computed values, never a screenshot. The ring's rect comes from
// `ringAt`, which waits for one read of `window.__fabrico.tutorial()` that names the stage and holds a
// rect: the probe reports a rect only once the ring has moved for that stage, so a single read
// straight after a stage change could catch the ring a frame early.

/** How far a rectangle may sit from where it belongs. */
const TOLERANCE = 1;
const PAUSED_SENTENCE = 'The board is paused, so your edits wait. Press Play in the toolbar, or press Space.';

function expectRingAround(ring: Box, target: Box, what: string): void {
  expect(Math.abs(ring.x - (target.x - OUTSET)), `${what}: left edge`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(ring.y - (target.y - OUTSET)), `${what}: top edge`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(ring.width - (target.width + 2 * OUTSET)), `${what}: width`).toBeLessThanOrEqual(TOLERANCE);
  expect(Math.abs(ring.height - (target.height + 2 * OUTSET)), `${what}: height`).toBeLessThanOrEqual(TOLERANCE);
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

/** The narrowest window the app supports. */
const NARROWEST = { width: 1024, height: 768 };

/** The longest key label the shortcut table holds: a later lesson's note can name it. */
const LONGEST_LABEL = Object.values(SHORTCUTS)
  .map((shortcut) => shortcut.label)
  .reduce((a, b) => (b.length > a.length ? b : a));
const LONGEST_NOTE = (['skippedOne', 'skippedMany', 'wentBack', 'alreadyRunning'] as const)
  .map((kind) =>
    phrasePlain(noteTokens({ kind, a: STEP_COUNT, b: STEP_COUNT }), {
      ...REAL_TABLES,
      shortcuts: { ...REAL_TABLES.shortcuts, playPause: { label: LONGEST_LABEL } },
    }),
  )
  .reduce((a, b) => (b.length > a.length ? b : a));
const LONGEST_INSTRUCTION = LESSONS.flatMap((lesson) => lesson.steps.flatMap((step) => step.stages))
  .map((stage) => phrasePlain(stage.text))
  .reduce((a, b) => (b.length > a.length ? b : a));

/** The card's box, with the lines each paragraph takes. */
async function readCard(page: Page): Promise<{ top: number; bottom: number; height: number; lines: number[] }> {
  return page.locator(CARD).evaluate((card) => {
    const box = card.getBoundingClientRect();
    const column = card.querySelector('[aria-live]') as HTMLElement;
    const lines = [...column.children]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      });
    return { top: box.top, bottom: box.bottom, height: box.height, lines };
  });
}

/**
 * The tallest each card state may be, in px: 44 of padding, 16.8 a line of text and 8 between
 * paragraphs. Starting is one button tall, 44 + 44. Running is the text budget, 2 lines of note, the
 * step line and 3 of instruction, then the off-screen row every running card reserves, 8 of gap and
 * 44 tall: 44 + 6 x 16.8 + 2 x 8 + 8 + 44 = 212.8 (the UI-SPEC rounds it to 214). Measured at
 * 1024x768 with the longest note and instruction it is 196.0, because that instruction takes 2 lines,
 * not 3. Swapped is its heading, 18 tall, then 8 and 2 lines of text: 44 + 18 + 8 + 2 x 16.8 = 103.6,
 * as measured. Finished is the heading, 2 lines of closing sentence and the buttons under them, as
 * measured at 163.6.
 */
const CARD_MAX_HEIGHT = { starting: 88, running: 213, swapped: 104, finished: 164 } as const;

/** A sentence too long for the card makes it taller, up over the board, and only its box shows that. */
async function expectCardFits(page: Page, state: keyof typeof CARD_MAX_HEIGHT): Promise<void> {
  const card = await readCard(page);
  const bottom = NARROWEST.height - 24;
  expect(Math.abs(card.bottom - bottom), `${state}: the card ends 24 px above the window's bottom`).toBeLessThanOrEqual(TOLERANCE);
  expect(card.height, `${state}: the card's height, read ${JSON.stringify(card.lines)} lines`).toBeLessThanOrEqual(CARD_MAX_HEIGHT[state] + TOLERANCE);
  expect(card.top, `${state}: the card's top edge`).toBeGreaterThanOrEqual(bottom - CARD_MAX_HEIGHT[state] - TOLERANCE);
}

/** Show the longest note and instruction on a running card, in the page's own column and stylesheet. */
async function fillCard(page: Page): Promise<void> {
  await page.locator(`${CARD} [aria-live]`).evaluate(
    (column, words) => {
      const instruction = column.querySelector('[data-fab-step-text]') as HTMLElement;
      const paragraph = (text: string): HTMLElement => {
        const el = instruction.cloneNode(false) as HTMLElement;
        el.textContent = text;
        el.removeAttribute('data-fab-step-text');
        el.setAttribute('data-test-fill', '');
        return el;
      };
      column.prepend(paragraph(words.note));
      column.append(paragraph(words.instruction));
      instruction.style.display = 'none';
    },
    { note: LONGEST_NOTE, instruction: LONGEST_INSTRUCTION },
  );
}

/** Put the card back, so React finds the children it left there. */
async function clearFilledCard(page: Page): Promise<void> {
  await page.locator(`${CARD} [aria-live]`).evaluate((column) => {
    column.querySelectorAll('[data-test-fill]').forEach((el) => el.remove());
    (column.querySelector('[data-fab-step-text]') as HTMLElement).style.display = '';
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

  test('the ring stays inside the column its control scrolls in', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await page.setViewportSize({ width: 1280, height: 420 });
    const { cell } = await armSourceForFloor(page);
    h.inject(sourceOn(cell, 6));
    const tools = page.getByTestId('palette-tools');
    const sinkRow = page.getByRole('button', { name: 'Place Sink', exact: true });
    const placed = await ringAt(page, 'sink-tool');
    expectRingAround(placed, await boxOf(sinkRow, 'the Sink row'), 'the ring when the stage begins');

    // Scroll the row right out of the column, the way a user's wheel would.
    const rowHeight = (await boxOf(sinkRow, 'the Sink row')).height;
    const scrolledOut = await tools.evaluate((el, name) => {
      const row = el.querySelector(`button[aria-label="${name}"]`) as HTMLElement;
      for (const top of [0, el.scrollHeight]) {
        el.scrollTop = top;
        const r = row.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        if (r.bottom <= c.top || r.top >= c.bottom) return true;
      }
      return false;
    }, 'Place Sink');
    expect(scrolledOut, 'this window is short enough to scroll the row out of the column').toBe(true);
    await expect.poll(async () => (await readProbe(page)).hint, { message: 'the ring hides with its control out of the column' }).toBeNull();
    await expect(page.locator('[data-fab-hint]'), 'and it is off the screen').toBeHidden();
    expect((await readProbe(page)).stageId, 'the stage is still the same').toBe('sink-tool');

    // Half the row showing: the ring marks the half a press can reach, inside the column.
    await tools.evaluate((el, name) => {
      const row = el.querySelector(`button[aria-label="${name}"]`) as HTMLElement;
      const r = row.getBoundingClientRect();
      const c = el.getBoundingClientRect();
      el.scrollTop += r.top >= c.bottom ? r.top + r.height / 2 - c.bottom : r.bottom - r.height / 2 - c.top;
    }, 'Place Sink');
    const half = await ringAt(page, 'sink-tool');
    const column = await boxOf(tools, 'the palette column');
    expect(half.height, 'the ring is shorter than the whole row').toBeLessThan(rowHeight + 2 * OUTSET - TOLERANCE);
    expect(half.y, 'it starts at the column').toBeGreaterThanOrEqual(column.y - OUTSET - TOLERANCE);
    expect(half.y + half.height, 'and ends at the column').toBeLessThanOrEqual(column.y + column.height + OUTSET + TOLERANCE);

    // Scrolled back, it is around the whole row again.
    await sinkRow.scrollIntoViewIfNeeded();
    await expect
      .poll(async () => {
        const probe = await readProbe(page);
        const row = await boxOf(sinkRow, 'the Sink row');
        return probe.hint === null ? null : Math.abs(probe.hint.height - (row.height + 2 * OUTSET));
      }, { message: 'the ring comes back around the row' })
      .toBeLessThanOrEqual(TOLERANCE);
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

  test('the card goes over the open Legend: it stays at the bottom and its Leave button takes the press', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    const card = page.locator(CARD);
    await page.getByRole('button', { name: 'Legend' }).click();
    const legend = page.locator('#fab-legend-panel');
    await expect(legend).toBeVisible();

    for (const size of [
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      const at = `at ${size.width}x${size.height}`;
      await expect
        .poll(async () => {
          const c = await boxOf(card, 'the card');
          return Math.abs(size.height - (c.y + c.height) - 24);
        }, { message: `${at} the card ends 24 px above the window's bottom, as with the Legend closed` })
        .toBeLessThanOrEqual(TOLERANCE);
      const c = await boxOf(card, 'the card');
      const l = await boxOf(legend, 'the Legend');
      const overlap = Math.min(c.x + c.width, l.x + l.width) - Math.max(c.x, l.x) > 0 && Math.min(c.y + c.height, l.y + l.height) - Math.max(c.y, l.y) > 0;
      expect(overlap, `${at} the card overlaps the Legend's rect (card ${JSON.stringify(c)}, Legend ${JSON.stringify(l)})`).toBe(true);
      const leave = card.getByRole('button', { name: 'Leave', exact: true });
      const b = await boxOf(leave, 'the Leave button');
      const onTop = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          return el?.closest('button')?.textContent?.trim() ?? el?.tagName ?? 'none';
        },
        [b.x + b.width / 2, b.y + b.height / 2] as const,
      );
      expect(onTop, `${at} the centre of the card's Leave button finds Leave, so the card paints over the Legend`).toBe('Leave');
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

  test('the card keeps its size at the narrowest window, with the longest text', async ({ page }) => {
    await page.setViewportSize(NARROWEST);
    const h = await boot(page);
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
    await page.getByRole('button', { name: `Start ${YOUR_FIRST_LINE.title}`, exact: true }).click();
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the card reads Starting' }).toBe('starting');
    await expectCardFits(page, 'starting');

    h.inject(buildPacket({ full: true, tick: 5, generation: 1, swapFloor: 1 }));
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the lesson is running' }).toBe('running');
    await fillCard(page);
    await expectCardFits(page, 'running');
    const { lines } = await readCard(page);
    expect(lines.length, 'a note, the step line and an instruction').toBe(3);
    expect(lines[0], 'the longest note takes at most 2 lines').toBeLessThanOrEqual(2);
    expect(lines[1], 'the step line takes 1').toBe(1);
    expect(lines[2], 'the longest instruction takes at most 3 lines').toBeLessThanOrEqual(3);
    await clearFilledCard(page);

    h.inject(buildPacket({ full: true, tick: 6, generation: 2, swapFloor: 2 }));
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the card reads Lesson paused' }).toBe('swapped');
    await expectCardFits(page, 'swapped');
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

const BELT_ID = 4;
/** A little over the layer's query period, so a read has had time to land. */
const TWO_TRIGGER_READS_MS = 900;

const timerButton = (page: Page): Locator => page.locator('[role="group"][aria-label="Trigger"]').getByRole('button', { name: 'Timer', exact: true });
const applyButton = (page: Page): Locator => page.locator('aside[aria-labelledby="fab-config-heading"]').getByRole('button', { name: 'Apply', exact: true });

/**
 * Both of the drag's rings from one read, each against the spot its gesture accepts: the press ring
 * a square on the Out port's doorstep cell plus the outset, the release ring a disc on the In port's
 * dot, `2 * dropHitRadiusWorld(scale) * scale + 4` across. Each number is the worst edge or size error.
 */
async function portRingErrors(
  page: Page,
  from: { cell_x: number; cell_y: number; side: number },
  to: { cell_x: number; cell_y: number; side: number },
): Promise<{ from: number; to: number; shapes: string }> {
  const read = await page.evaluate(() => {
    const hook = (window as unknown as { __fabrico: { tutorial(): TutorialProbe; camera(): { x: number; y: number; scale: number } } }).__fabrico;
    return { probe: hook.tutorial(), cam: hook.camera() };
  });
  const { probe, cam } = read;
  const [dx, dy] = doorstepCell(from);
  const size = CELL * cam.scale;
  const square = (r: HintRect | null): number =>
    r === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
          Math.abs(r.x - (dx * size + cam.x - OUTSET)),
          Math.abs(r.y - (dy * size + cam.y - OUTSET)),
          Math.abs(r.width - (size + 2 * OUTSET)),
          Math.abs(r.height - (size + 2 * OUTSET)),
        );
  const b = nubAnchor(to.cell_x, to.cell_y, to.side);
  const d = 2 * dropHitRadiusWorld(cam.scale) * cam.scale + 4;
  const disc = (r: HintRect | null): number =>
    r === null
      ? Number.POSITIVE_INFINITY
      : Math.max(
          Math.abs(r.x + r.width / 2 - (b.x * cam.scale + cam.x)),
          Math.abs(r.y + r.height / 2 - (b.y * cam.scale + cam.y)),
          Math.abs(r.width - d),
          Math.abs(r.height - d),
        );
  return { from: square(probe.hint), to: disc(probe.hintTo), shapes: `${probe.hint?.shape}/${probe.hintTo?.shape}` };
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
    expect(read.hint?.shape, 'the press ring is a square on the doorstep').toBe('square');
    expect(read.hintTo?.shape, 'the release ring is a disc on the dot').toBe('circle');
    await expect(page.locator('[data-fab-hint-to]'), 'the release ring is on screen').toBeVisible();

    const out = source.ports![0]!;
    const into = sink.ports![1]!;
    const errors = await portRingErrors(page, out, into);
    expect(errors.shapes).toBe('square/circle');
    expect(errors.from, 'the out ring at the third camera, on the doorstep cell').toBeLessThanOrEqual(TOLERANCE);
    expect(errors.to, 'the in ring at the third camera, the hit circle across').toBeLessThanOrEqual(TOLERANCE);

    await zoomOut(page);
    await expect
      .poll(async () => {
        const e = await portRingErrors(page, out, into);
        return Math.max(e.from, e.to);
      }, { message: 'the port rings at another zoom level' })
      .toBeLessThanOrEqual(TOLERANCE);
    await panBoard(page);
    await expect
      .poll(async () => {
        const e = await portRingErrors(page, out, into);
        return Math.max(e.from, e.to);
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
    // The last step keeps its index when it finishes, so a read of the step can't tell running from
    // finished. Wait for the model to hold the last packet, then for a frame of the layer's loop to
    // have read it, or this read lands before the lesson has seen either packet.
    await waitForBoard(page, { machines: 2, tick: tick + 4 });
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    probe = await readProbe(page);
    expect(probe.stepId).toBe('watch-items');
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
    await page.setViewportSize(NARROWEST);
    await expectCardFits(page, 'finished');

    await card.getByRole('button', { name: 'Back to lessons', exact: true }).click();
    await expect(card, 'the card goes').toHaveCount(0);
    await expect(page.locator('#fab-lessons-panel'), 'and the list opens').toBeVisible();
    // The row a real finish leaves, with the board still as the lesson left it.
    await expectRow(page, 'Done', ['Restart Your first line'], [NEXT_START]);
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
/** With the first lesson Done, the accent moves to the next lesson's Start. */
const NEXT_START = `Start ${DELETE_AND_UNDO.title}`;
const GUARD_HEADING = 'Start a new board?';
const STOPPED_TITLE = 'Unavailable: the simulation stopped';
const SWAPPED_SENTENCE = 'The board changed, so this lesson stopped. Restart it, or leave it.';
/** The gap App leaves between the status strip and a panel docked top right: `--fab-space-sm`. */
const STRIP_GUTTER = 8;
/** The longest title the list allows for: a later lesson's, longer than the one that ships. */
const LONGEST_TITLE = 'A Factory with two outputs';
const OVERLONG_TITLE = 'A Factory with two outputs and a much longer name';

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

/** A machine far from every case's cells, for a diff to add so the board reads Unsaved. */
const DIRTY_MACHINE: InjectNode = { id: 90, kind: 0, cell_x: 2, cell_y: 14 };

/** Give the status strip something to show. Empty, it measures zero and has nothing to dodge with. */
async function lightStatusStrip(page: Page, h: Harness, tick: number): Promise<void> {
  h.inject(buildPacket({ full: false, tick, nodes: [OLD_MACHINE, DIRTY_MACHINE] }));
  await expect(page.locator('[data-fab-status-strip]').getByText('Unsaved', { exact: true }), 'the strip holds something to measure').toBeVisible();
}

/**
 * The strip stops one gutter left of the list. This reads across only, because the two share rows:
 * the strip with `Unsaved` in it runs from 100 to 126 px down, and the list starts at 116.
 */
async function expectStripClearOfList(page: Page): Promise<void> {
  const strip = page.locator('[data-fab-status-strip]');
  const stripBox = await boxOf(strip, 'the status strip');
  expect(stripBox.width, 'the strip holds something, so it has a width to read').toBeGreaterThan(0);
  expect(stripBox.height, 'the strip holds something, so it has a height to read').toBeGreaterThan(0);
  const list = await boxOf(page.locator(PANEL), 'the list');
  await expect
    .poll(async () => {
      const box = await boxOf(strip, 'the status strip');
      return box.x + box.width;
    }, { message: 'the status strip ends left of the list, with one gutter between them' })
    .toBeLessThanOrEqual(list.x - STRIP_GUTTER + TOLERANCE);
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
    await expectRow(page, 'Done', [RESTART], [NEXT_START]);

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
    await expectRow(page, 'Done', [RESTART], [NEXT_START]);
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
    const h = await boot(page);
    const help = page.locator('#fab-help-panel');
    const lessons = page.locator(PANEL);
    await lightStatusStrip(page, h, 4);

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
    await expectStripClearOfList(page);

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

  test('five rows fit the list: the longest title on one line, and the buttons inside the box', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await pressLeave(page);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESUME, RESTART], [RESUME]);

    // The shipped titles are shorter, and this reads layout, so it gives the first lesson's row the
    // longest title and makes the list five copies of it: the other rows go, because they don't offer
    // Resume and Restart. The real stylesheet and font do the rest.
    const rows = await lessonRow(page).evaluate((row, title) => {
      (row.firstElementChild!.firstElementChild as HTMLElement).textContent = title;
      for (const other of [...row.parentElement!.children]) if (other !== row) other.remove();
      for (let i = 0; i < 4; i++) row.parentElement!.append(row.cloneNode(true));
      return row.parentElement!.children.length;
    }, LONGEST_TITLE);
    expect(rows, 'five rows to read').toBe(5);

    const read = () =>
      page.locator(`${PANEL} [data-fab-help-scroll]`).evaluate((box) => {
        const client = box.getBoundingClientRect();
        const inner = client.left + box.clientWidth;
        return {
          scrolls: box.scrollHeight > box.clientHeight,
          rows: [...box.querySelectorAll('li')].map((li) => {
            const range = document.createRange();
            range.selectNodeContents(li.firstElementChild!.firstElementChild!);
            const buttons = [...li.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
            return {
              lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size,
              titleRight: range.getBoundingClientRect().right,
              buttonsLeft: buttons[0]!.left,
              buttonsRight: buttons[buttons.length - 1]!.right,
              inner,
              count: buttons.length,
            };
          }),
        };
      });

    const atLongest = await read();
    for (const [i, row] of atLongest.rows.entries()) {
      expect(row.count, `row ${i}: Resume and Restart`).toBe(2);
      expect(row.lines, `row ${i}: the longest title sits on one line`).toBe(1);
      expect(row.titleRight, `row ${i}: the title stops short of the buttons`).toBeLessThanOrEqual(row.buttonsLeft + TOLERANCE);
      expect(row.buttonsRight, `row ${i}: the buttons stay inside the box`).toBeLessThanOrEqual(row.inner + TOLERANCE);
    }
    expect(atLongest.scrolls, 'five rows need no scroll at this height').toBe(false);

    // A title past that wraps, and the buttons stay where they were.
    await lessonRow(page).first().evaluate((row, title) => {
      (row.firstElementChild!.firstElementChild as HTMLElement).textContent = title;
    }, OVERLONG_TITLE);
    const [wrapped] = (await read()).rows;
    expect(wrapped!.lines, 'a longer title wraps').toBeGreaterThan(1);
    expect(wrapped!.titleRight, 'a wrapped title stops short of the buttons').toBeLessThanOrEqual(wrapped!.buttonsLeft + TOLERANCE);
    expect(wrapped!.buttonsRight, 'a wrapped title leaves the buttons inside the box').toBeLessThanOrEqual(wrapped!.inner + TOLERANCE);
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

  test('a swap that takes the focused Resume away moves focus to Close, so Escape still closes the list', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await pressLeave(page);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESUME, RESTART], [RESUME]);
    const resume = page.getByRole('button', { name: RESUME, exact: true });
    await expect(resume, 'the list focuses its first action').toBeFocused();

    // The way a user gets here: Ctrl+N passes a focused button, and New doesn't close the list.
    await page.keyboard.press('Control+n');
    await expect.poll(() => newCount(h), { message: 'Ctrl+N sent New with the list open' }).toBe(2);
    h.inject(swappedBoard(2, 6));
    await expectRow(page, 'In progress', [RESTART], []);

    const close = page.locator(PANEL).getByRole('button', { name: 'Close', exact: true });
    await expect(close, 'focus lands on Close, which cannot replace the board').toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL), 'Escape still reaches the list').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help', exact: true }), 'and hands focus to Help').toBeFocused();
    expect(newCount(h), 'and nothing else was pressed').toBe(2);
  });

  test('a swap leaves focus on Restart, which stays mounted', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await pressLeave(page);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESUME, RESTART], [RESUME]);
    const restart = page.getByRole('button', { name: RESTART, exact: true });
    await restart.focus();
    h.inject(swappedBoard(2, 6));
    await expectRow(page, 'In progress', [RESTART], []);
    await expect(restart, 'the swap moved no focus').toBeFocused();
  });

  test('a refusal moves clear of the list', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await boot(page, { answerGesture: () => 'FootprintCollision' });
    const refusal = page.locator('#fab-refusal .fab-panel');
    const list = page.locator(PANEL);
    const refuseAPlace = async (): Promise<void> => {
      // The mock refuses any place here, so the press only has to reach the floor. One cell south of the
      // old machine, because with three lessons the open list reaches down over that machine at 1024x768.
      const at = await screenCellCentre(page, OLD_MACHINE.cell_x, OLD_MACHINE.cell_y + 1);
      const under = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null, at);
      expect(under, 'the refused press lands on the floor, clear of the list').toBe('CANVAS');
      await page.mouse.click(at.x, at.y);
      await expect(page.locator('#fab-refusal')).toHaveText('That space is taken. Clear it or try elsewhere.');
    };
    const expectApart = async (what: string): Promise<void> => {
      await expect
        .poll(
          async () => {
            const r = await boxOf(refusal, 'the refusal');
            const l = await boxOf(list, 'the list');
            return r.x + r.width <= l.x || l.x + l.width <= r.x || r.y + r.height <= l.y || l.y + l.height <= r.y;
          },
          { message: what },
        )
        .toBe(true);
    };

    // A refusal that arrives with the list open.
    await page.getByRole('button', { name: 'Place Source', exact: true }).click();
    await openLessons(page);
    await refuseAPlace();
    await expectApart('a refusal said with the list open stays clear of it');

    // And a list that opens over a refusal already showing.
    await list.getByRole('button', { name: 'Close', exact: true }).click();
    await refuseAPlace();
    await openLessons(page);
    await expect(refusal, 'the refusal still holds').toBeVisible();
    await expectApart('a refusal already showing moves when the list opens');
  });

  test('Escape over a hidden inspector closes the list and hands focus to Help', async ({ page }) => {
    await boot(page);
    const at = await screenCellCentre(page, OLD_MACHINE.cell_x, OLD_MACHINE.cell_y);
    await page.mouse.click(at.x, at.y);
    const inspector = page.locator('aside[aria-labelledby="fab-config-heading"]');
    await expect(inspector).toBeVisible();

    await openLessons(page);
    await expect(inspector, 'the list hides the inspector').toBeHidden();
    await expect(page.getByRole('button', { name: START, exact: true }), 'the list took focus').toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL), 'Escape closes the list').toHaveCount(0);
    await expect(inspector, 'and brings the inspector back').toBeVisible();
    await expect(page.getByRole('button', { name: 'Help', exact: true }), 'and hands focus to Help').toBeFocused();
  });

  test('closing the list during a lesson leaves the board keys working', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    await page.keyboard.press(' ');
    await expect.poll(() => h.controls, { message: 'Space paused the board' }).toContain('pause');
    await expect(page.locator(CARD), 'the card asks for Space').toContainText(PAUSED_SENTENCE);

    const focused = () => page.evaluate(() => document.activeElement?.tagName ?? null);
    const resumes = (): number => h.controls.filter((c) => c === 'resume').length;
    const pauses = (): number => h.controls.filter((c) => c === 'pause').length;

    // Close, then the Space the paused card asks for.
    await openLessons(page);
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(await focused(), 'Close leaves focus on the page').toBe('BODY');
    await page.keyboard.press(' ');
    await expect.poll(resumes, { message: "the card's Space reached the board" }).toBe(1);
    await expect(page.locator('#fab-help-panel'), 'and did not press Help').toHaveCount(0);

    // Escape, the same way.
    await openLessons(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(await focused(), 'Escape leaves focus on the page').toBe('BODY');
    await page.keyboard.press(' ');
    await expect.poll(pauses, { message: 'Space reached the board after Escape' }).toBe(2);

    // And after Leave there is no card asking for a key, so focus goes back to Help.
    await pressLeave(page);
    await openLessons(page);
    await page.locator(PANEL).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Help', exact: true }), 'with no lesson on screen, Close hands focus to Help').toBeFocused();
  });

  test('Escape over a hidden inspector during a lesson leaves the board keys working', async ({ page }) => {
    const h = await boot(page, configuredHost().opts);
    await startLesson(page, h);
    // The floor ring's cell, because an empty mock board boots at the zoom limit and a fixed cell can be off screen.
    const { cell } = await armSourceForFloor(page);
    h.inject(sourceOn(cell, 6));
    await expect(page.locator(CARD)).toContainText(`Step 2 of ${STEP_COUNT}`);
    await waitForBoard(page, { machines: 1 });
    await page.keyboard.press('Escape');
    const at = await screenCellCentre(page, cell[0], cell[1]);
    await page.mouse.click(at.x, at.y);
    const inspector = page.locator('aside[aria-labelledby="fab-config-heading"]');
    await expect(inspector).toBeVisible();

    await openLessons(page);
    await expect(inspector, 'the list hides the inspector').toBeHidden();
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(inspector, 'Escape brings the inspector back').toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.tagName ?? null), 'and leaves focus on the page').toBe('BODY');
    await page.keyboard.press(' ');
    await expect.poll(() => h.controls, { message: 'Space reached the board' }).toContain('pause');
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

  test('a Load already on its way when the lesson starts is not taken for the lesson board', async ({ page }) => {
    const h = await boot(page);
    await openLessons(page);
    await page.getByRole('button', { name: START, exact: true }).click();
    await expect.poll(() => newCount(h), { message: 'Start sent New' }).toBe(1);
    const card = page.locator(CARD);

    // The Load's keyframe lands first, with its machines on it and a higher floor.
    h.inject(buildPacket({ full: true, tick: 5, generation: 1, swapFloor: 1, nodes: [OLD_MACHINE] }));
    await waitForBoard(page, { machines: 1, tick: 5 });
    // A drawn frame has read that board by the time this one resolves.
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    expect((await readProbe(page)).card, 'the lesson waits for its own board').toBe('starting');
    await expect(card).toContainText('Clearing the board.');

    h.inject(swappedBoard(2, 6));
    await expect(card).toContainText(`Step 1 of ${STEP_COUNT}`);
    await expect(card, 'the empty board it asked for is no swap').not.toContainText('Lesson paused');
    expect((await readProbe(page)).card).toBe('running');
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

test.describe('a trigger applied while the lesson is left', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  async function pressResume(page: Page): Promise<void> {
    await openLessons(page);
    await page.getByRole('button', { name: RESUME, exact: true }).click();
  }

  test('left at the Timer step: Resume moves on, and the note says so', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    await placeBoth(page, h);
    await ringAt(page, 'tool-down');
    // The layer has had its first answer, Webhook, before the lesson is left.
    await expect.poll(() => host.asked(), { message: 'the layer asked about the trigger' }).toBeGreaterThan(0);
    await pressLeave(page);

    host.set({ kind: 'Timer', interval_ticks: 60 });
    await pressResume(page);
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 4 of ${STEP_COUNT}`);
    await expect(card, 'the step number jumped, so the note explains it').toContainText('Step 3 was already done, so the lesson moved on.');
  });

  test('a Timer applied before its step comes up: the step number jumps, and the note says so', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    const { cell } = await armSourceForFloor(page);
    const source = sourceAt(cell);
    h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));
    await ringAt(page, 'sink-tool');

    // The user sets the Timer up on the Source that's there, with step 2 still on the card.
    host.set({ kind: 'Timer', interval_ticks: 60 });
    await page.waitForTimeout(TWO_TRIGGER_READS_MS);

    h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sinkAt([cell[0] + 6, cell[1]])] }));
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 4 of ${STEP_COUNT}`);
    await expect(card, 'step 3 was never on the card, so the note explains it').toContainText('Step 3 was already done, so the lesson moved on.');
  });

  test('a Timer applied while left at the Sink step: the note shows when the Sink lands after Resume', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    const { cell } = await armSourceForFloor(page);
    const source = sourceAt(cell);
    h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));
    await ringAt(page, 'sink-tool');
    await pressLeave(page);

    host.set({ kind: 'Timer', interval_ticks: 60 });
    await pressResume(page);
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 2 of ${STEP_COUNT}`);
    await page.waitForTimeout(TWO_TRIGGER_READS_MS);

    h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sinkAt([cell[0] + 6, cell[1]])] }));
    await expect(card).toContainText(`Step 4 of ${STEP_COUNT}`);
    await expect(card, 'step 3 was never on the card, so the note explains it').toContainText('Step 3 was already done, so the lesson moved on.');
  });

  test('left at the Sink step: Resume covers both steps in one note', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    const { cell } = await armSourceForFloor(page);
    const source = sourceAt(cell);
    h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));
    await ringAt(page, 'sink-tool');
    await pressLeave(page);

    // The Sink and the Timer both happen with no card on screen.
    const sink = sinkAt([cell[0] + 6, cell[1]]);
    h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sink] }));
    await waitForBoard(page, { machines: 2, tick: 7 });
    host.set({ kind: 'Timer', interval_ticks: 60 });

    await pressResume(page);
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 4 of ${STEP_COUNT}`);
    await expect(card).toContainText('Steps 2 to 3 were already done, so the lesson moved on.');
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
    await lightStatusStrip(page, h, 4);

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
    // Help never opened on this path, so only the list's own open flag can re-measure the strip.
    await expectStripClearOfList(page);
    await expect(heading, 'the card goes').toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('fab.onboarding.seen.v1')), 'and it stays gone').toBe('1');
    await expectRow(page, 'Not started', [START], [START]);
    expect(h.controls, 'opening the list starts nothing').not.toContain('new');
  });
});
