import { test, expect, type Locator, type Page } from '@playwright/test';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import {
  CELL,
  CMD,
  buildPacket,
  cameraOf,
  gestureSubject,
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
  SINK_ID,
  SOURCE_ID,
  STEP_COUNT,
  boot,
  configuredHost,
  keepStreamAlive,
  placeBoth,
  readProbe,
  ringAt,
  startLesson,
  toBeltDraw,
} from './support/lessonMock';

// lesson-keys.spec.ts - the step card and the keyboard, on a mock host.
//
// Escape (phase 103's rule): one press does the first of ending a belt or source draw, putting the tool
// down, clearing the selection, dismissing the welcome card, closing an open lesson list, and only then closing
// a finished card (as Keep building) or a swapped card (as Leave). A running card never closes on Escape,
// because lesson 1 asks for Esc to put the tool down. Every case reads what each press changed: the armed
// tool, the selection, the card's state from the probe, and the panels on screen.
//
// Space and Delete reach the board with the card open. Each case reads the card before and after the key, so
// a closed card can't pass.

const ID = YOUR_FIRST_LINE.id;
const PANEL = '#fab-lessons-panel';
const RESUME = `Resume ${YOUR_FIRST_LINE.title}`;
const RESTART = `Restart ${YOUR_FIRST_LINE.title}`;
const BELT_ID = 4;
const INSPECTOR = 'aside[aria-labelledby="fab-config-heading"]';

const lessonRow = (page: Page): Locator => page.locator(`${PANEL} [data-fab-lesson-row="${ID}"]`);
const inspector = (page: Page): Locator => page.locator(INSPECTOR);
const welcome = (page: Page): Locator => page.getByRole('heading', { name: 'Welcome to Fabrico' });

/** The palette tools that read as armed, by their accessible names. */
async function armedTools(page: Page): Promise<string[]> {
  return page
    .locator('[data-fab-left-dock] [aria-pressed="true"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''));
}

/** Everything one Escape can change, read at once. */
interface EscapeView {
  armed: string[];
  selected: boolean;
  card: string;
  list: boolean;
  help: boolean;
  welcome: boolean;
}

async function viewOf(page: Page): Promise<EscapeView> {
  return {
    armed: await armedTools(page),
    selected: await inspector(page).isVisible(),
    card: (await readProbe(page)).card,
    list: (await page.locator(PANEL).count()) > 0,
    help: (await page.locator('#fab-help-panel').count()) > 0,
    welcome: (await welcome(page).count()) > 0,
  };
}

/** Press Escape and wait until the page reads `want`, so a slow render can't pass for no change. */
async function escapeTo(page: Page, want: Partial<EscapeView>, what: string): Promise<void> {
  await page.keyboard.press('Escape');
  await expect
    .poll(
      async () => {
        const got = await viewOf(page);
        return Object.fromEntries(Object.keys(want).map((k) => [k, got[k as keyof EscapeView]]));
      },
      { message: what },
    )
    .toEqual(want);
}

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

const focusedTag = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.tagName ?? null);

/** Steps 1 to 6 on the mock host, ending on the finished card. Returns the two machines. */
async function toFinishedCard(
  page: Page,
  h: Harness,
  host: ReturnType<typeof configuredHost>,
  keepHand = false,
): Promise<{ source: InjectNode; sink: InjectNode; tick: number }> {
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
  h.inject(at(tick + 2, [5]));
  await expect.poll(async () => (await readProbe(page)).stageId, { message: 'the higher tick finished press-play' }).toBe('watch');
  h.inject(at(tick + 3, [0]));
  await waitForBoard(page, { machines: 2, tick: tick + 3 });
  h.inject(at(tick + 4, []));
  await expect.poll(async () => (await readProbe(page)).card, { message: 'the delivery finished the lesson' }).toBe('finished');
  await expect(page.locator(CARD).getByRole('heading', { name: 'Lesson done' })).toBeVisible();
  // The lesson leaves the Belt tool in the hand and the Source selected. Put both away, one Escape each, so each
  // case starts from a finished card with nothing else for Escape to do, and sets up what it needs. A case that
  // asks to keep the hand gets the card as the lesson leaves it.
  expect(await armedTools(page), 'the lesson left the Belt tool in the hand').toEqual(['Belt']);
  await expect(inspector(page), 'and the Source selected').toBeVisible();
  if (keepHand) return { source, sink, tick: tick + 4 };
  await escapeTo(page, { armed: [], selected: true, card: 'finished' }, 'the first Escape puts the lesson tool down');
  await escapeTo(page, { armed: [], selected: false, card: 'finished' }, 'the second clears the Source selection');
  return { source, sink, tick: tick + 4 };
}

async function bootFinished(
  page: Page,
  keepHand = false,
): Promise<{ h: Harness; source: InjectNode; sink: InjectNode; tick: number }> {
  const host = configuredHost();
  const h = await boot(page, host.opts);
  await startLesson(page, h);
  return { h, ...(await toFinishedCard(page, h, host, keepHand)) };
}

/**
 * Select a machine with a press on its cell, as a user would, and wait for its inspector. The cases select the
 * Source: the lesson's own select-source step panned it clear of the inspector, while the Sink can sit off screen
 * at the mock's zoom.
 */
async function select(page: Page, node: InjectNode): Promise<void> {
  const at = await screenCellCentre(page, node.cell_x, node.cell_y);
  await page.mouse.click(at.x, at.y);
  await expect(inspector(page), `the press selected machine ${node.id}`).toBeVisible();
}

/** A board-cell on screen at a window point, for a machine a case adds. */
async function cellAt(page: Page, x: number, y: number): Promise<readonly [number, number]> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  return [Math.floor((x - cam.x) / size), Math.floor((y - cam.y) / size)];
}

/** A full keyframe with a higher floor: another board, as a Load or an example would bring. */
function swappedBoard(floor: number, tick: number): Buffer {
  return buildPacket({ full: true, tick, generation: floor, swapFloor: floor, nodes: [OLD_MACHINE] });
}

test.describe('Escape', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a running card stays through the Esc the lesson asks for and two more', async ({ page }) => {
    const host = configuredHost();
    const h = await boot(page, host.opts);
    await startLesson(page, h);
    await placeBoth(page, h);
    await ringAt(page, 'tool-down');
    const before = await readProbe(page);
    expect(await armedTools(page), 'the Sink tool is in the hand at tool-down').toEqual(['Place Sink']);

    await escapeTo(page, { armed: [], card: 'running' }, 'the first Escape puts the tool down');
    await expect.poll(async () => (await readProbe(page)).stageId, { message: 'and the stage moves on' }).toBe('select-source');

    for (const n of [2, 3]) {
      await page.keyboard.press('Escape');
      // Two frames of the layer's loop, so a card that closed on this press would read closed.
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const after = await readProbe(page);
      expect([after.card, after.stepId, after.stageId], `Escape ${n} left the lesson running on the same step`).toEqual([
        'running',
        before.stepId,
        'select-source',
      ]);
    }
    await expect(page.locator(CARD)).toContainText(`of ${STEP_COUNT}`);
    await expect(page.locator(CARD).getByRole('button', { name: 'Leave', exact: true })).toBeVisible();
  });

  test('a finished card closes after the tool and the selection, and the row reads Done', async ({ page }) => {
    const { source } = await bootFinished(page);
    await select(page, source);
    await page.getByRole('button', { name: 'Place Merge', exact: true }).click();
    await expect.poll(() => armedTools(page), { message: 'the Merge tool is in the hand' }).toEqual(['Place Merge']);
    await expect(inspector(page), 'arming a tool keeps the selection').toBeVisible();

    await escapeTo(page, { armed: [], selected: true, card: 'finished' }, 'the first Escape puts the tool down');
    await escapeTo(page, { armed: [], selected: false, card: 'finished' }, 'the second clears the selection');
    await escapeTo(page, { armed: [], selected: false, card: 'none' }, 'the third closes the card');
    await expect(page.locator(CARD)).toHaveCount(0);

    await openLessons(page);
    await expectRow(page, 'Done', [RESTART]);
  });

  test('a belt path under a finished card ends first, then the tool, then the card', async ({ page }) => {
    const { h, source } = await bootFinished(page);
    await page.getByRole('button', { name: 'Belt', exact: true }).click();
    await expect.poll(() => armedTools(page), { message: 'the Belt tool is in the hand' }).toEqual(['Belt']);
    const sentBefore = h.sent.length;

    // A path held three cells below the Source, clear of the lesson's belt.
    const from = await screenCellCentre(page, source.cell_x, source.cell_y + 3);
    const to = await screenCellCentre(page, source.cell_x + 3, source.cell_y + 3);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });

    await escapeTo(page, { armed: ['Belt'], card: 'finished' }, 'the first Escape ends the path and keeps the Belt tool');
    await page.mouse.up();
    // The release after an ended path sends nothing.
    await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 300)));
    expect(
      h.sent.slice(sentBefore).filter((f) => f[0] === CMD.DrawBelt).length,
      'the release after the ended path drew no belt',
    ).toBe(0);

    await escapeTo(page, { armed: [], card: 'finished' }, 'the second puts the Belt tool down');
    await escapeTo(page, { armed: [], card: 'none' }, 'the third closes the card');
  });

  test('a swapped card closes as Leave', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    h.inject(swappedBoard(2, 9));
    await expect(page.locator(CARD)).toContainText('Lesson paused');
    expect(await focusedTag(page), 'focus is on the page').toBe('BODY');

    await escapeTo(page, { card: 'none', list: false }, 'Escape closes the swapped card');
    await expect(page.locator(CARD)).toHaveCount(0);
    expect(h.controls.filter((c) => c === 'new'), 'and sends no New').toEqual(['new']);
    await openLessons(page);
    // The row Leave on a swapped card leaves (lessons.spec.ts 'Leave on a swapped card leaves Restart alone in the row').
    await expectRow(page, 'In progress', [RESTART]);
  });

  // Review WR-02: Tab reaches the card's buttons. Escape with focus on one runs the board's Escape chain, whose last
  // row closes a finished or swapped card.
  test('with focus on Keep building, Escape closes the finished card as Keep building', async ({ page }) => {
    await bootFinished(page);
    const keep = page.locator(CARD).getByRole('button', { name: 'Keep building', exact: true });
    await keep.focus();
    await expect(keep, 'focus is on Keep building, as Tab would leave it').toBeFocused();

    await escapeTo(page, { armed: [], selected: false, card: 'none', list: false }, 'Escape closes the finished card');
    await expect(page.locator(CARD)).toHaveCount(0);
    await openLessons(page);
    await expectRow(page, 'Done', [RESTART]);
  });

  // Review iteration 2: Escape on a card button runs the board's whole chain, so the rows above the card go first
  // there too. Lesson 1 ends with the Belt tool in the hand and the Source selected, which is where a keyboard user
  // who tabs to Keep building starts. Focus stays on the button for every press, so each one tests that path.
  test('with focus on Keep building, Escape puts the lesson tool down, then clears the selection, then closes the card', async ({ page }) => {
    await bootFinished(page, true);
    const keep = page.locator(CARD).getByRole('button', { name: 'Keep building', exact: true });
    await keep.focus();
    await expect(keep, 'focus is on Keep building, as Tab would leave it').toBeFocused();

    await escapeTo(page, { armed: [], selected: true, card: 'finished' }, 'the first Escape puts the Belt tool down');
    await expect(keep, 'focus is still on Keep building').toBeFocused();
    await escapeTo(page, { armed: [], selected: false, card: 'finished' }, 'the second clears the Source selection');
    await expect(keep, 'focus is still on Keep building').toBeFocused();
    await escapeTo(page, { armed: [], selected: false, card: 'none' }, 'the third closes the card');
    await openLessons(page);
    await expectRow(page, 'Done', [RESTART]);
  });

  test('with focus on Keep building and the lesson list open, Escape closes the list before the card', async ({ page }) => {
    await bootFinished(page);
    await openLessons(page);
    const keep = page.locator(CARD).getByRole('button', { name: 'Keep building', exact: true });
    await keep.focus();
    await expect(keep, 'focus is on Keep building, outside the list').toBeFocused();

    await escapeTo(page, { list: false, card: 'finished' }, 'the first Escape closes the list');
    await escapeTo(page, { list: false, card: 'none' }, 'the second closes the card');
  });

  test('with focus on Leave, Escape closes the swapped card as Leave', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    h.inject(swappedBoard(2, 9));
    await expect(page.locator(CARD)).toContainText('Lesson paused');
    const leave = page.locator(CARD).getByRole('button', { name: 'Leave', exact: true });
    await leave.focus();
    await expect(leave, 'focus is on Leave, as Tab would leave it').toBeFocused();

    await escapeTo(page, { card: 'none', list: false }, 'Escape closes the swapped card');
    expect(h.controls.filter((c) => c === 'new'), 'and sends no New').toEqual(['new']);
    await openLessons(page);
    await expectRow(page, 'In progress', [RESTART]);
  });

  test('with focus on Leave, Escape leaves a running card running and still puts the tool down', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    await page.getByRole('button', { name: 'Place Source', exact: true }).click();
    await expect.poll(() => armedTools(page), { message: 'the Source tool is in the hand' }).toEqual(['Place Source']);
    const leave = page.locator(CARD).getByRole('button', { name: 'Leave', exact: true });
    await leave.focus();
    await expect(leave).toBeFocused();

    await escapeTo(page, { armed: [], card: 'running' }, 'Escape puts the tool down and the lesson keeps running');
    await page.keyboard.press('Escape');
    await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 200)));
    expect((await readProbe(page)).card, 'a second Escape on Leave leaves the lesson running').toBe('running');
  });

  test('with Help over a selection, Escape brings the inspector back, then clears the selection, then closes the card', async ({ page }) => {
    const { source } = await bootFinished(page);
    await select(page, source);
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(page.locator('#fab-help-panel')).toBeVisible();
    await expect(inspector(page), 'Help hides the inspector').toBeHidden();

    await escapeTo(page, { help: false, selected: true, card: 'finished' }, 'the first Escape closes Help and brings the inspector back');
    expect(await focusedTag(page), 'and leaves focus on the page, not on the Help button').toBe('BODY');
    await escapeTo(page, { help: false, selected: false, card: 'finished' }, 'the second clears the selection');
    await escapeTo(page, { help: false, selected: false, card: 'none' }, 'the third closes the card');
  });

  test('an open lesson list closes before the finished card', async ({ page }) => {
    await bootFinished(page);
    await openLessons(page);
    // A press on the floor puts focus on the page, where the board's Escape reaches the list.
    const empty = await cellAt(page, 700, 200);
    const at = await screenCellCentre(page, empty[0], empty[1]);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator(PANEL), 'a press on the floor leaves the list open').toBeVisible();
    expect(await focusedTag(page), 'focus is on the page').toBe('BODY');

    await escapeTo(page, { list: false, card: 'finished' }, 'the first Escape closes the list');
    await escapeTo(page, { list: false, card: 'none' }, 'the second closes the card');
  });

  // Over a hidden inspector, because App's capture handler takes Escape first in that state, and a user who has
  // just finished lesson 1 often has a machine selected.
  test('with the reset question up, Escape cancels it, then closes the panel, then the finished card', async ({ page }) => {
    const { source } = await bootFinished(page);
    await select(page, source);
    await openLessons(page);
    await expect(inspector(page), 'the list hides the inspector').toBeHidden();
    const footer = page.locator(`${PANEL} [data-fab-lessons-footer]`);
    await footer.getByRole('button', { name: 'Reset progress', exact: true }).click();
    await expect(footer.getByRole('button', { name: 'Keep progress', exact: true }), 'the safe answer has focus').toBeFocused();

    await escapeTo(page, { list: true, selected: false, card: 'finished' }, 'the first Escape keeps the panel open');
    await expect(footer, 'and cancels the question').toHaveAttribute('data-fab-lessons-footer', 'rest');
    await expect(footer.getByRole('button', { name: 'Reset progress', exact: true })).toBeFocused();
    await escapeTo(page, { list: false, selected: true, card: 'finished' }, 'the second closes the panel and brings the inspector back');
    expect(await focusedTag(page), 'and hands focus to the page').toBe('BODY');
    await escapeTo(page, { list: false, selected: false, card: 'finished' }, 'the third clears the selection');
    await escapeTo(page, { list: false, selected: false, card: 'none' }, 'the fourth closes the card');
    expect(await page.evaluate(() => localStorage.getItem('fab.tutorial.v1')), 'and progress stays as the lesson left it').toBe(
      JSON.stringify({ version: 1, lessons: { [ID]: 'done' } }),
    );
  });
});

test.describe('Escape and the welcome card', () => {
  // The mock configs preset the first-run flag, so this block clears it to see the card.
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });

  // Plan 104-10: a lesson start closes the welcome card, so it can't stand beside a lesson card any more,
  // and the first Escape goes to the lesson card. Before, the first Escape went to the welcome card.
  test('a lesson start takes the welcome card, so the first Escape closes a swapped lesson card', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    keepStreamAlive(page, h);
    h.inject(buildPacket({ full: true, tick: 3, nodes: [OLD_MACHINE] }));
    await waitForBoard(page, { machines: 1, tick: 3 });
    await expect(welcome(page), 'the first-run card shows').toBeVisible();

    await startLesson(page, h);
    h.inject(swappedBoard(2, 9));
    await expect(page.locator(CARD)).toContainText('Lesson paused');
    await expect(welcome(page), 'the lesson start took the welcome card').toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('fab.onboarding.seen.v1')), 'for good').toBe('1');
    expect(await focusedTag(page), 'focus is on the page').toBe('BODY');

    await escapeTo(page, { welcome: false, card: 'none' }, 'the first Escape closes the lesson card');
  });
});

test.describe('keys', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Space toggles play with the running card open', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    const card = page.locator(CARD);
    await expect(card).toContainText(`Step 1 of ${STEP_COUNT}`);
    expect((await readProbe(page)).card).toBe('running');

    await page.keyboard.press(' ');
    await expect.poll(() => h.controls, { message: 'Space reached the board' }).toContain('pause');
    await expect(card, 'the card is still open on the same step').toContainText(`Step 1 of ${STEP_COUNT}`);
    expect((await readProbe(page)).card, 'and still running').toBe('running');

    await page.keyboard.press(' ');
    await expect.poll(() => h.controls, { message: 'the second Space reached the board too' }).toContain('resume');
    await expect(card).toContainText(`Step 1 of ${STEP_COUNT}`);
    expect((await readProbe(page)).card).toBe('running');
  });

  test('Delete removes the selected machine with the running card open', async ({ page }) => {
    const h = await boot(page);
    await startLesson(page, h);
    await ringAt(page, 'source-tool');
    const card = page.locator(CARD);

    // A Merge the lesson has no use for, on screen in the free area.
    const cell = await cellAt(page, 760, 260);
    const merge: InjectNode = { id: 40, kind: 6, cell_x: cell[0], cell_y: cell[1] };
    h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [merge] }));
    await waitForBoard(page, { machines: 1, tick: 6 });
    await select(page, merge);

    // Leave and Resume, so the card mounts again with the Merge still selected: a card that took focus as it
    // showed would hold Delete here.
    await card.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(card).toHaveCount(0);
    await openLessons(page);
    await page.getByRole('button', { name: RESUME, exact: true }).click();
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(card, 'the card is back on step 1').toContainText(`Step 1 of ${STEP_COUNT}`);
    await expect(inspector(page), 'and the Merge is still selected').toBeVisible();
    expect((await readProbe(page)).card).toBe('running');

    const sentBefore = h.sent.length;
    await page.keyboard.press('Delete');
    await expect
      .poll(() => h.sent.slice(sentBefore).map((f) => gestureSubject(f)), { message: 'Delete reached the board' })
      .toContainEqual({ cmd: 'Delete', node: merge.id });
    expect(
      h.sent.slice(sentBefore).filter((f) => f[0] === CMD.Delete).length,
      'one Delete went out',
    ).toBe(1);
    h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, removed: [merge.id] }));
    await waitForBoard(page, { machines: 0, tick: 7 });
    await expect(card, 'the card is still open on the same step').toContainText(`Step 1 of ${STEP_COUNT}`);
    expect((await readProbe(page)).card, 'and still running').toBe('running');
  });
});
