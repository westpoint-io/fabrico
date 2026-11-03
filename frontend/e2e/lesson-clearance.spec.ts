import { test, expect, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import { buildPacket, cameraOf, type Harness, type InjectBelt, type InjectNode } from './support/wire';
import {
  CARD,
  SINK_ID,
  SOURCE_ID,
  boot,
  cellOfRing,
  configuredHost,
  injectRefusal,
  pressRing,
  readProbe,
  ringAt,
  sinkAt,
  sourceAt,
  startLesson,
  zoomOut,
} from './support/lessonMock';

// lesson-clearance.spec.ts - the step card stays clear of the ring it points with (HINT-04, placement).
//
// One test per window size drives lesson 1 on the mock host through every (step, stage) pair whose stage
// has a ring, taking the list from YOUR_FIRST_LINE, so a ringed stage added later is visited here or the
// last assertion names it. At each stage a refusal puts the card at its tallest: a two-line note, the step
// line, the instruction and the off-screen row every running card reserves. The card's rect is then read
// against the main ring, the drag's second ring and the open inspector, and must meet none of them.
//
// The open inspector moves the card left so its right edge sits 8 px short of the inspector (UI-SPEC
// "Card placement"). The Source inspector grows to 488 px tall at apply-timer, which reaches past the
// centred card's top at both sizes, so with the shift taken out the card sits under the inspector there
// and this spec fails.
//
// The Legend stays closed here. Open, with the inspector open beside it, it lifts the card to about 150 px
// from the top, over the floor rings, and no left position clears them: that needs a vertical rule this
// plan doesn't make, so it is left as a finding for a later phase.

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;
const TOLERANCE = 1;
const GAP = 8;
const BELT_ID = 4;
const INSPECTOR = 'aside[aria-labelledby="fab-config-heading"]';

/** Every lesson 1 (step, stage) pair whose stage shows a ring, from the lesson data. */
const RINGED: readonly string[] = YOUR_FIRST_LINE.steps.flatMap((step) =>
  step.stages.filter((stage) => stage.hint !== null).map((stage) => `${step.id}/${stage.id}`),
);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Read {
  probe: TutorialProbe;
  card: Rect | null;
  inspector: Rect | null;
}

/** The probe, the card's rect and the open inspector's rect, from one evaluate. A hidden inspector reads null. */
async function readAll(page: Page): Promise<Read> {
  return page.evaluate((sel) => {
    const rect = (el: Element | null): Rect | null => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return r.width === 0 || r.height === 0 ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const probe = (window as unknown as { __fabrico: { tutorial(): TutorialProbe } }).__fabrico.tutorial();
    return { probe, card: rect(document.querySelector('[data-fab-step-card]')), inspector: rect(document.querySelector(sel)) };
  }, INSPECTOR);
}

/** Do two rects share area? Touching edges don't count. */
function meets(a: Rect, b: Rect): boolean {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

const fmt = (r: Rect | HintRect | null): string =>
  r === null ? 'none' : [r.x, r.y, r.width, r.height].map((v) => v.toFixed(1)).join(',');

/** What the card meets in a read, or 'clear'. */
function overlaps(read: Read): string {
  const { card, probe, inspector } = read;
  if (card === null) return 'no card';
  const hits: string[] = [];
  if (probe.hint !== null && meets(card, probe.hint)) hits.push(`ring ${fmt(probe.hint)}`);
  if (probe.hintTo !== null && meets(card, probe.hintTo)) hits.push(`second ring ${fmt(probe.hintTo)}`);
  if (inspector !== null && meets(card, inspector)) hits.push(`inspector ${fmt(inspector)}`);
  return hits.length === 0 ? 'clear' : `card ${fmt(card)} meets ${hits.join(' and ')}`;
}

/**
 * At `stageId`: raise `tag` so the card holds a refusal note, wait until the probe names the stage with
 * its rings and the note, then poll until the card is clear of the rings and the inspector, and log it.
 */
async function measureAt(page: Page, h: Harness, size: string, stageId: string, visited: Set<string>, tag = 'InvalidDock'): Promise<void> {
  await ringAt(page, stageId);
  injectRefusal(h, tag);
  await expect
    .poll(
      async () => {
        const { probe } = await readAll(page);
        if (probe.stageId !== stageId) return `on stage ${probe.stageId}`;
        if (probe.noteKind !== 'refusal') return `note ${probe.noteKind || 'empty'}`;
        if (probe.hint === null) return 'no ring yet';
        return 'ready';
      },
      { message: `${size} ${stageId}: the ring and a refusal note show` },
    )
    .toBe('ready');
  // The note's paragraph height over its line height: the range's rects would count the box itself too.
  const lines = await page.locator(`${CARD} [data-fab-step-note] p`).evaluate((el) => {
    return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  });
  expect(lines, `${size} ${stageId}: the refusal note takes two lines, the card's tallest`).toBe(2);
  let last: Read | null = null;
  await expect
    .poll(
      async () => {
        last = await readAll(page);
        if (last.probe.stageId !== stageId) return `on stage ${last.probe.stageId}`;
        return overlaps(last);
      },
      { message: `${size} ${stageId}: the card meets neither ring nor the open inspector` },
    )
    .toBe('clear');
  const read = last as unknown as Read;
  const key = `${read.probe.stepId}/${read.probe.stageId}`;
  visited.add(key);
  console.log(
    `MEASURE clearance size=${size} step=${read.probe.stepId} stage=${read.probe.stageId} card=${fmt(read.card)} ring=${fmt(read.probe.hint)} to=${fmt(read.probe.hintTo)} inspector=${fmt(read.inspector)}`,
  );
}

/** Focus back to the page after a toolbar press, so Escape reaches the board. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
}

async function pause(page: Page, h: Harness): Promise<void> {
  const before = h.controls.filter((c) => c === 'pause').length;
  await page.locator('header button[aria-label="Pause"]').click();
  await expect.poll(() => h.controls.filter((c) => c === 'pause').length, { message: 'the Pause press reached the host' }).toBe(before + 1);
  await blur(page);
}

async function play(page: Page, h: Harness): Promise<void> {
  const before = h.controls.filter((c) => c === 'resume').length;
  await page.locator('header button[aria-label="Play"]').click();
  await expect.poll(() => h.controls.filter((c) => c === 'resume').length, { message: 'the Play press reached the host' }).toBe(before + 1);
  await blur(page);
}

/** Pause the board on the current step, measure its board-paused stage, and play again. */
async function measurePaused(page: Page, h: Harness, size: string, visited: Set<string>, back: string): Promise<void> {
  await pause(page, h);
  await measureAt(page, h, size, 'board-paused', visited);
  await play(page, h);
  await ringAt(page, back);
}

/** Lesson 1 started at `size`, zoomed out to 1 or below so both machines' spots fit the window. */
async function startAt(page: Page, size: { width: number; height: number }): Promise<{ h: Harness; host: ReturnType<typeof configuredHost> }> {
  await page.setViewportSize(size);
  const host = configuredHost();
  const h = await boot(page, host.opts);
  await startLesson(page, h);
  for (let i = 0; i < 12 && (await cameraOf(page)).scale > 1; i++) await zoomOut(page);
  return { h, host };
}

for (const size of SIZES) {
  const label = `${size.width}x${size.height}`;
  test(`the tallest card clears every ring and the open inspector at every ringed stage, at ${label}`, async ({ page }) => {
    test.setTimeout(120_000);
    const visited = new Set<string>();
    const { h, host } = await startAt(page, size);

    // Step 1: the Source.
    await measureAt(page, h, label, 'source-tool', visited);
    await measurePaused(page, h, label, visited, 'source-tool');
    await page.getByRole('button', { name: 'Place Source', exact: true }).click();
    await measureAt(page, h, label, 'source-floor', visited);
    const source: InjectNode = sourceAt(cellOfRing(await ringAt(page, 'source-floor'), await cameraOf(page)));
    h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));

    // Step 2: the Sink, with the lesson's own two-line coaching line at sink-floor.
    await measureAt(page, h, label, 'sink-tool', visited);
    await measurePaused(page, h, label, visited, 'sink-tool');
    await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
    await measureAt(page, h, label, 'sink-floor', visited, 'FootprintCollision');
    const sink: InjectNode = sinkAt(cellOfRing(await ringAt(page, 'sink-floor'), await cameraOf(page)));
    h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sink] }));

    // Step 3: the Timer, where the inspector opens and stays open for the rest of the lesson.
    await measureAt(page, h, label, 'tool-down', visited);
    await measurePaused(page, h, label, visited, 'tool-down');
    await page.keyboard.press('Escape');
    await measureAt(page, h, label, 'select-source', visited);
    await pressRing(page, await ringAt(page, 'select-source'));
    await expect(page.locator(INSPECTOR), 'the inspector opens on the Source').toBeVisible();
    await measureAt(page, h, label, 'press-timer', visited);
    await pressRing(page, await ringAt(page, 'press-timer'));
    await measureAt(page, h, label, 'apply-timer', visited);
    await pressRing(page, await ringAt(page, 'apply-timer'));
    host.set({ kind: 'Timer', interval_ticks: 60 });

    // Step 4: the belt, its plain drag and its carry-on drag.
    await measureAt(page, h, label, 'belt-tool', visited);
    await measurePaused(page, h, label, visited, 'belt-tool');
    await pressRing(page, await ringAt(page, 'belt-tool'));
    await measureAt(page, h, label, 'belt-draw', visited);
    const tiles: InjectBelt['tiles'] = [
      [source.cell_x + 1, source.cell_y],
      [source.cell_x + 2, source.cell_y],
    ];
    const stub: InjectBelt = { id: BELT_ID, tiles, docks: [{ end: 'Tail', node: SOURCE_ID, port: 0 }] };
    h.inject(buildPacket({ full: false, tick: 8, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [stub] }));
    await measureAt(page, h, label, 'belt-carry-on', visited);

    // Step 5's board-paused: the belt joins while the board is paused, so press-play opens on it.
    await pause(page, h);
    await ringAt(page, 'board-paused');
    const joined = (itemSlots: number[]): InjectBelt => ({
      id: BELT_ID,
      tiles,
      itemSlots,
      docks: [
        { end: 'Tail', node: SOURCE_ID, port: 0 },
        { end: 'Head', node: SINK_ID, port: 0 },
      ],
    });
    h.inject(buildPacket({ full: false, tick: 9, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [joined([])] }));
    await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the joined belt finished draw-belt' }).toBe('press-play');
    await measureAt(page, h, label, 'board-paused', visited);
    await play(page, h);
    h.inject(buildPacket({ full: false, tick: 10, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [joined([5])] }));

    // Step 6: watch the Sink, then its board-paused.
    await measureAt(page, h, label, 'watch', visited);
    await pause(page, h);
    await measureAt(page, h, label, 'board-paused', visited);

    expect([...visited].sort(), 'every ringed stage of lesson 1 was visited').toEqual([...RINGED].sort());
  });
}

test('the open inspector moves the card left at its own width, and Help puts it back in the centre', async ({ page }) => {
  const { h } = await startAt(page, { width: 1024, height: 768 });
  const card = page.locator(CARD);
  const centred = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, width: r.width };
  });
  expect(Math.abs(centred.x + centred.width / 2 - 512), 'with no inspector the card is centred').toBeLessThanOrEqual(TOLERANCE);

  const { cell } = await (async () => {
    await ringAt(page, 'source-tool');
    await page.getByRole('button', { name: 'Place Source', exact: true }).click();
    return { cell: cellOfRing(await ringAt(page, 'source-floor'), await cameraOf(page)) };
  })();
  const source = sourceAt(cell);
  h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));
  await ringAt(page, 'sink-tool');
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  const sink = sinkAt(cellOfRing(await ringAt(page, 'sink-floor'), await cameraOf(page)));
  h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sink] }));
  await ringAt(page, 'tool-down');
  await page.keyboard.press('Escape');
  await pressRing(page, await ringAt(page, 'select-source'));
  // A pressed Timer adds the interval field and the Apply row, which takes the inspector down past the card's top.
  await pressRing(page, await ringAt(page, 'press-timer'));
  await ringAt(page, 'apply-timer');
  // A refusal note makes the card tall enough for the inspector's bottom to reach its top at this size.
  injectRefusal(h, 'InvalidDock');
  await expect.poll(async () => (await readProbe(page)).noteKind, { message: 'the refusal note shows' }).toBe('refusal');

  const shifted = async (): Promise<string> => {
    const read = await readAll(page);
    if (read.card === null || read.inspector === null) return 'no card or no inspector';
    const right = read.card.x + read.card.width;
    if (Math.abs(right - (read.inspector.x - GAP)) > TOLERANCE) {
      return `card ${fmt(read.card)} right ${right.toFixed(1)}, inspector ${fmt(read.inspector)}`;
    }
    if (Math.abs(read.card.width - centred.width) > TOLERANCE) return `width ${read.card.width.toFixed(1)}`;
    return 'shifted';
  };
  await expect.poll(shifted, { message: 'the card ends 8 px left of the inspector, at its centred width' }).toBe('shifted');

  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.locator('#fab-help-panel')).toBeVisible();
  await expect(page.locator(INSPECTOR), 'Help hides the inspector').toBeHidden();
  await expect
    .poll(async () => {
      const r = await card.evaluate((el) => el.getBoundingClientRect().toJSON() as Rect);
      return Math.abs(r.x + r.width / 2 - 512) <= TOLERANCE && Math.abs(r.width - centred.width) <= TOLERANCE;
    }, { message: 'with Help open the card is centred again' })
    .toBe(true);

  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.locator(INSPECTOR), 'closing Help shows the inspector').toBeVisible();
  await expect.poll(shifted, { message: 'and the card moves left of it again' }).toBe('shifted');
});
