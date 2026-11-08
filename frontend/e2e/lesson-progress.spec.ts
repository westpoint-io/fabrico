import { test, expect, type Locator, type Page } from '@playwright/test';
import { LESSONS } from '../src/tutorial/lessons/index';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import { buildPacket, waitForBoard, type Harness, type InjectBelt } from './support/wire';
import {
  CARD,
  SINK_ID,
  SOURCE_ID,
  STEP_COUNT,
  armSourceForFloor,
  boot,
  configuredHost,
  placeBoth,
  readProbe,
  sourceAt,
  startLesson,
  toBeltDraw,
} from './support/lessonMock';

// lesson-progress.spec.ts - the Lessons panel's Reset progress footer, and a corrupt stored value, on a
// mock host. The stored value is read straight from localStorage, so a check can't pass on what the row
// shows while the store says something else.

const KEY = 'fab.tutorial.v1';
const ID = YOUR_FIRST_LINE.id;
const PANEL = '#fab-lessons-panel';
const START = `Start ${YOUR_FIRST_LINE.title}`;
const RESTART = `Restart ${YOUR_FIRST_LINE.title}`;
const BELT_ID = 4;

const footer = (page: Page): Locator => page.locator(`${PANEL} [data-fab-lessons-footer]`);
const liveLine = (page: Page): Locator => footer(page).locator('[aria-live="polite"]');
const resetButton = (page: Page): Locator => footer(page).getByRole('button', { name: 'Reset progress', exact: true });
const keepButton = (page: Page): Locator => footer(page).getByRole('button', { name: 'Keep progress', exact: true });
const clearButton = (page: Page): Locator => footer(page).getByRole('button', { name: 'Clear progress', exact: true });
const closeButton = (page: Page): Locator => page.locator(PANEL).getByRole('button', { name: 'Close', exact: true });
const lessonRow = (page: Page): Locator => page.locator(`${PANEL} [data-fab-lesson-row="${ID}"]`);

const stored = (page: Page): Promise<string | null> => page.evaluate((k) => localStorage.getItem(k), KEY);

async function seed(page: Page, value: string): Promise<void> {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, value] as const);
}

const DONE_VALUE = JSON.stringify({ version: 1, lessons: { [ID]: 'done' } });

/** The row read whole: its status word and the names of its buttons, in order. */
async function expectRow(page: Page, status: string, buttons: readonly string[]): Promise<void> {
  await expect(lessonRow(page), `the row reads ${status}`).toContainText(status);
  await expect
    .poll(() => lessonRow(page).getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))), {
      message: `the row offers ${buttons.join(', ')}`,
    })
    .toEqual([...buttons]);
}

async function openLessons(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
  await expect(page.locator(PANEL)).toBeVisible();
}

/** The footer at rest: the empty line and Reset progress, nothing else. */
async function expectFooterAtRest(page: Page, line: string): Promise<void> {
  await expect(footer(page)).toHaveAttribute('data-fab-lessons-footer', line === '' ? 'rest' : 'cleared');
  await expect(liveLine(page)).toHaveText(line);
  await expect(footer(page).getByRole('button')).toHaveText(['Reset progress']);
}

async function askReset(page: Page): Promise<void> {
  await resetButton(page).click();
  await expect(liveLine(page), 'the footer asks first').toHaveText('Clear all lesson progress?');
  await expect(footer(page).getByRole('button'), 'with the safe answer first').toHaveText(['Keep progress', 'Clear progress']);
  await expect(keepButton(page), 'and focused, so the destructive button is never the default').toBeFocused();
}

/** Steps 1 to 6 on the mock host, ending on the finished card. The Done write happens on its frame. */
async function toFinishedCard(page: Page, h: Harness): Promise<void> {
  const { source, sink, tick } = await placeBoth(page, h);
  await toBeltDraw(page, hostOf(h));
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
  h.inject(at(tick + 2, [5]));
  await expect.poll(async () => (await readProbe(page)).stageId, { message: 'the higher tick finished press-play' }).toBe('watch');
  h.inject(at(tick + 3, [0]));
  await waitForBoard(page, { machines: 2, tick: tick + 3 });
  h.inject(at(tick + 4, []));
  await expect.poll(async () => (await readProbe(page)).card, { message: 'the delivery finished the lesson' }).toBe('finished');
  await expect(page.locator(CARD).getByRole('heading', { name: 'Lesson done' })).toBeVisible();
}

// The configured host each boot used, so the drive can answer Timer through the same one.
const hosts = new WeakMap<Harness, ReturnType<typeof configuredHost>>();
function hostOf(h: Harness): ReturnType<typeof configuredHost> {
  const host = hosts.get(h);
  if (host === undefined) throw new Error('this harness was booted without a configured host');
  return host;
}
async function bootConfigured(page: Page): Promise<Harness> {
  const host = configuredHost();
  const h = await boot(page, host.opts);
  hosts.set(h, host);
  return h;
}

test.describe('Reset progress', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Reset then Keep progress leaves the stored value as it was', async ({ page }) => {
    await seed(page, DONE_VALUE);
    await boot(page);
    await openLessons(page);
    await expectRow(page, 'Done', [RESTART]);
    await expectFooterAtRest(page, '');
    const before = await stored(page);
    expect(before, 'the seed is in place').toBe(DONE_VALUE);

    await askReset(page);
    await keepButton(page).click();
    await expectFooterAtRest(page, '');
    await expect(resetButton(page), 'focus goes back to Reset progress').toBeFocused();
    expect(await stored(page), 'Keep progress touched nothing').toBe(before);
    await expectRow(page, 'Done', [RESTART]);
  });

  test('Reset then Clear progress empties the store and every row', async ({ page }) => {
    await seed(page, DONE_VALUE);
    await boot(page);
    await openLessons(page);
    await expectRow(page, 'Done', [RESTART]);

    await askReset(page);
    await clearButton(page).click();
    await expectFooterAtRest(page, 'Progress cleared.');
    await expect(resetButton(page), 'focus goes back to Reset progress').toBeFocused();
    await expectRow(page, 'Not started', [START]);
    expect(await stored(page), 'the key is gone').toBeNull();
  });

  test('a running lesson keeps running through a reset', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    expect(await stored(page), 'Start stored In progress').toBe(JSON.stringify({ version: 1, lessons: { [ID]: 'inProgress' } }));
    const before = await readProbe(page);

    await openLessons(page);
    await expectRow(page, 'In progress', [RESTART]);
    await askReset(page);
    await clearButton(page).click();
    await expect(liveLine(page)).toHaveText('Progress cleared.');
    expect(await stored(page), 'the key is gone').toBeNull();
    await expectRow(page, 'In progress', [RESTART]);
    const after = await readProbe(page);
    expect([after.card, after.stepId, after.stageId], 'the card still reads running at the same step').toEqual([before.card, before.stepId, before.stageId]);
    await expect(page.locator(CARD)).toContainText(`Step 1 of ${STEP_COUNT}`);

    // The next step still moves the lesson on.
    await closeButton(page).click();
    const { cell } = await armSourceForFloor(page);
    h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [sourceAt(cell)] }));
    await expect.poll(async () => (await readProbe(page)).stepId, { message: 'placing the Source finished step 1' }).toBe('place-sink');
    await expect(page.locator(CARD)).toContainText(`Step 2 of ${STEP_COUNT}`);
  });

  test('a reset under the finished card stays a reset after Keep building', async ({ page }) => {
    const h = await bootConfigured(page);
    await startLesson(page, h);
    await toFinishedCard(page, h);
    expect(await stored(page), 'the finished frame wrote Done').toBe(DONE_VALUE);

    await openLessons(page);
    await expectRow(page, 'Done', [RESTART]);
    await askReset(page);
    await clearButton(page).click();
    await expect(liveLine(page)).toHaveText('Progress cleared.');
    await closeButton(page).click();

    await page.locator(CARD).getByRole('button', { name: 'Keep building', exact: true }).click();
    await expect(page.locator(CARD), 'Keep building closes the card').toHaveCount(0);
    expect((await readProbe(page)).card).toBe('none');

    // Only the store can say Done now, because the card is gone.
    await openLessons(page);
    await expectRow(page, 'Not started', [START]);
    const value = await stored(page);
    expect(value === null || !value.includes('done'), `the store holds no done (it holds ${value})`).toBe(true);
  });

  test('Escape cancels the question first, and the next Escape closes the panel', async ({ page }) => {
    await seed(page, DONE_VALUE);
    await boot(page);
    await openLessons(page);
    await askReset(page);

    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL), 'the panel stays open').toBeVisible();
    await expectFooterAtRest(page, '');
    await expect(resetButton(page), 'focus goes back to Reset progress').toBeFocused();
    expect(await stored(page), 'Escape cleared nothing').toBe(DONE_VALUE);

    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL), 'the second Escape closes the panel').toHaveCount(0);
    expect(await stored(page)).toBe(DONE_VALUE);
  });

  test('closing the panel while it asks drops the question', async ({ page }) => {
    await seed(page, DONE_VALUE);
    await boot(page);
    await openLessons(page);
    await askReset(page);
    await closeButton(page).click();
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(await stored(page), 'Close cleared nothing').toBe(DONE_VALUE);

    await openLessons(page);
    await expectFooterAtRest(page, '');
    await expectRow(page, 'Done', [RESTART]);
  });

  test('a stored value with an unknown status boots to an empty list', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await seed(page, JSON.stringify({ version: 1, lessons: { [ID]: 'finished' } }));
    await boot(page);
    await openLessons(page);
    await expectRow(page, 'Not started', [START]);
    await expectFooterAtRest(page, '');
    expect(errors, 'the page logged no error').toEqual([]);
  });

  test('on a short window the rows keep their scroll box and Reset progress is still reachable', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 340 });
    await seed(page, DONE_VALUE);
    await boot(page);
    await openLessons(page);
    const box = page.locator(`${PANEL} [data-fab-help-scroll]`);
    await expect
      .poll(() => box.evaluate((el) => el.clientHeight), { message: 'the rows have a box to scroll in' })
      .toBeGreaterThanOrEqual(40);
    await expect.poll(() => box.evaluate((el) => el.scrollHeight > el.clientHeight), { message: 'and the footer scrolls with them' }).toBe(true);
    await askReset(page);
    await clearButton(page).click();
    await expect(liveLine(page)).toHaveText('Progress cleared.');
    expect(await stored(page)).toBeNull();
  });
});

// TUT-06, close and reopen: the page that ran the lesson is closed and a fresh page on the same browser
// profile boots the app again, which is the closest a mock run gets to quitting and relaunching. The row
// on the new page can only read Done or In progress if the first page's write reached the shared store.
test.describe('Progress after a close and reopen', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a finished lesson reads Done on a fresh page after the first one closes', async ({ page, context }) => {
    const h = await bootConfigured(page);
    await startLesson(page, h);
    await toFinishedCard(page, h);
    await page.close();

    const reopened = await context.newPage();
    await boot(reopened);
    expect(await stored(reopened), 'the store the new page booted on holds Done').toBe(DONE_VALUE);
    expect((await readProbe(reopened)).card, 'the reopened app shows no lesson card').toBe('none');
    await openLessons(reopened);
    await expectRow(reopened, 'Done', [RESTART]);
  });

  test('a lesson closed midway reads In progress on a fresh page, and Clear progress then sticks across another reopen', async ({ page, context }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await page.close();

    const second = await context.newPage();
    await boot(second);
    await openLessons(second);
    await expectRow(second, 'In progress', [RESTART]);
    await askReset(second);
    await clearButton(second).click();
    await expect(liveLine(second)).toHaveText('Progress cleared.');
    await second.close();

    const third = await context.newPage();
    await boot(third);
    expect(await stored(third), 'the cleared key stays gone').toBeNull();
    await openLessons(third);
    await expectRow(third, 'Not started', [START]);
  });
});

// The list holds every lesson in teaching order (UI-SPEC "Lessons panel with three rows"). The accent goes
// on the first row that isn't Done, so a user who finished lesson 1 sees the blue Start on lesson 3.
interface ListRow {
  id: string;
  title: string;
  status: string;
  buttons: (string | null)[];
  accent: (string | null)[];
}

async function readRows(page: Page): Promise<ListRow[]> {
  return page.locator(`${PANEL} [data-fab-lesson-row]`).evaluateAll((rows) =>
    rows.map((row) => {
      const words = row.querySelectorAll(':scope > div:first-child > div');
      return {
        id: row.getAttribute('data-fab-lesson-row') ?? '',
        title: words[0]?.textContent ?? '',
        status: words[1]?.textContent ?? '',
        buttons: Array.from(row.querySelectorAll('button')).map((b) => b.getAttribute('aria-label')),
        accent: Array.from(row.querySelectorAll('button.fab-cta')).map((b) => b.getAttribute('aria-label')),
      };
    }),
  );
}

test.describe('Three lessons in the list', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const TITLES = ['Your first line', 'Delete and Undo', 'A Factory with two outputs'];

  test('the lessons ship in teaching order', () => {
    expect(LESSONS.map((l) => l.title)).toEqual(TITLES);
  });

  test('with no saved progress all three read Not started with Start, and the accent is on the first', async ({ page }) => {
    await boot(page);
    expect(await stored(page), 'nothing saved').toBeNull();
    await openLessons(page);
    const rows = await readRows(page);
    console.log(`MEASURE list-rows empty ${JSON.stringify(rows)}`);
    expect(rows.map((r) => r.title), 'three rows in teaching order, titles read from the DOM').toEqual(TITLES);
    expect(rows.map((r) => r.id)).toEqual(LESSONS.map((l) => l.id));
    for (const row of rows) {
      expect(row.status, row.title).toBe('Not started');
      expect(row.buttons, row.title).toEqual([`Start ${row.title}`]);
    }
    expect(rows.flatMap((r) => r.accent), 'the accent on one button, the first row').toEqual(['Start Your first line']);
  });

  test('with lesson 1 Done, the accent is Start Delete and Undo and on no other button', async ({ page }) => {
    await seed(page, DONE_VALUE);
    await boot(page);
    await openLessons(page);
    const rows = await readRows(page);
    console.log(`MEASURE list-rows lesson1-done ${JSON.stringify(rows)}`);
    expect(rows.map((r) => r.title), 'three rows in teaching order, titles read from the DOM').toEqual(TITLES);
    expect(rows.map((r) => r.status)).toEqual(['Done', 'Not started', 'Not started']);
    expect(rows.map((r) => r.buttons)).toEqual([['Restart Your first line'], ['Start Delete and Undo'], ['Start A Factory with two outputs']]);
    expect(rows.flatMap((r) => r.accent), 'the accent on the next lesson only').toEqual(['Start Delete and Undo']);
    const named = page.locator(PANEL).getByRole('button', { name: 'Start Delete and Undo', exact: true });
    await expect(named, 'the accessible name reaches the button').toHaveClass(/\bfab-cta\b/);
    await expect(page.locator(`${PANEL} .fab-cta`)).toHaveCount(1);
  });
});

// The finished card's heading reads at the Lessons heading's size and line height (UI-SPEC "Carried
// fixes in StepCard.tsx"), not the browser's 18 px h2 at the panel's line height of 1.
test.describe("The finished card's heading", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Lesson done sets the Lessons heading's size and a line height of 1.2", async ({ page }) => {
    const h = await bootConfigured(page);
    await startLesson(page, h);
    await toFinishedCard(page, h);
    const metrics = (el: Element): { fontSize: number; lineHeight: number } => {
      const style = getComputedStyle(el);
      return { fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
    };
    const done = await page.locator(CARD).getByRole('heading', { name: 'Lesson done' }).evaluate(metrics);
    await page.locator(CARD).getByRole('button', { name: 'Back to lessons', exact: true }).click();
    const lessons = await page.locator('#fab-lessons-heading').evaluate(metrics);
    console.log(`MEASURE heading done=${JSON.stringify(done)} lessons=${JSON.stringify(lessons)}`);
    expect(done.lineHeight, 'line height 1.2 times the font size').toBeCloseTo(done.fontSize * 1.2, 1);
    expect(done, "the same as the Lessons heading's").toEqual(lessons);
  });
});
