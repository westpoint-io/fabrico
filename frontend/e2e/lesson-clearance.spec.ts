import { test, expect, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import { phrasePlain } from '../src/tutorial/phrase';
import type { Lesson, Stage } from '../src/tutorial/types';
import { buildPacket, cameraOf, type Harness, type InjectBelt, type InjectNode } from './support/wire';
import {
  CARD,
  OUTSET,
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
// Each lesson test drives a lesson on the mock host through every (step, stage) pair whose stage has a
// ring, taking the list from the lesson's data, so a ringed stage added later is visited here or the
// last assertion names it. At each stage a refusal puts the card at its tallest: the longest note the
// stage can show (the band's longest sentence or the stage's own coaching line), the step line, the
// instruction and the off-screen row every running card reserves. The card's rect is then read against
// the main ring, the drag's second ring, the control a panel ring marks and the open inspector, and
// must meet none of them. A board ring must also lie inside the free area, or the probe must read it as
// out of view.
//
// The open inspector moves the card left so its right edge sits 8 px short of the inspector (UI-SPEC
// "Card placement"). The Source inspector grows to 488 px tall at apply-timer, which reaches past the
// centred card's top at both sizes, so with the shift taken out the card sits under the inspector there
// and this spec fails.
//
// Each lesson runs at both sizes with the Legend closed, and again with the Legend opened first. The
// open Legend is 246 px tall at 1280 wide and 344 px at 1024x768. The card stays 24 px above the
// window's bottom and goes over it (UI-SPEC "Card placement with the Legend open"), and the free area
// stops at the Legend's top, so the lesson's spots and Show me keep the rings above it. A card that
// climbed to sit above the Legend instead would land on the rings.

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;
const LEGEND_STATES = [false, true] as const;
const TOLERANCE = 1;
const GAP = 8;
const BELT_ID = 4;
const INSPECTOR = 'aside[aria-labelledby="fab-config-heading"]';
const LEGEND = '#fab-legend-panel';
/** The free area's top, the dock line under the toolbar (`FREE_AREA_TOP_PX` in TutorialLayer.tsx). */
const FREE_TOP = 116;

/**
 * The band's longest sentence, `InvalidDock`'s, mirrored from `REFUSAL_COPY` rather than imported:
 * RefusalMessage.tsx pulls in SVG assets the e2e runner can't load (`gesture-verdict.spec.ts` does the same).
 */
const INVALID_DOCK_WORDS = 'A belt runs from an output to an input, right next to it.';

/** Every (step, stage) pair of a lesson whose stage shows a ring, from the lesson data. */
function ringedOf(lesson: Lesson): readonly string[] {
  return lesson.steps.flatMap((step) => step.stages.filter((stage) => stage.hint !== null).map((stage) => `${step.id}/${stage.id}`));
}

/** A stage as the lesson data holds it. */
function stageIn(lesson: Lesson, stepId: string | null, stageId: string | null): Stage {
  const stage = lesson.steps.find((s) => s.id === stepId)?.stages.find((st) => st.id === stageId);
  if (stage === undefined) throw new Error(`${lesson.id} has no stage ${String(stepId)}/${String(stageId)}`);
  return stage;
}

/**
 * The refusal that gives the stage its tallest note: its own coaching line where that is longer than
 * the band's longest sentence, `InvalidDock`'s, and that sentence otherwise.
 */
function tallestTag(stage: Stage): string {
  let tag = 'InvalidDock';
  let longest = INVALID_DOCK_WORDS.length;
  for (const [t, tokens] of Object.entries(stage.coach ?? {})) {
    const words = phrasePlain(tokens).length;
    if (words > longest) {
      tag = t;
      longest = words;
    }
  }
  return tag;
}

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
  /** The free area by `readFreeArea`'s rule, worked out again from the page. */
  free: Rect;
}

/** The probe and the card's, the open inspector's and the free area's rects, from one evaluate. A hidden inspector reads null. */
async function readAll(page: Page): Promise<Read> {
  return page.evaluate(
    ([sel, legendSel, freeTop]) => {
      const rect = (el: Element | null): Rect | null => {
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return r.width === 0 || r.height === 0 ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const probe = (window as unknown as { __fabrico: { tutorial(): TutorialProbe } }).__fabrico.tutorial();
      const card = rect(document.querySelector('[data-fab-step-card]'));
      const legend = rect(document.querySelector(legendSel));
      const dock = document.querySelector('[data-fab-left-dock]');
      const left = dock === null ? 0 : dock.getBoundingClientRect().right;
      const right = window.innerWidth - 24 - (Math.min(420, 0.33 * window.innerWidth) + 2 * 22 + 8);
      const bottom = Math.min(card === null ? window.innerHeight : card.y, legend === null ? window.innerHeight : legend.y);
      return {
        probe,
        card,
        inspector: rect(document.querySelector(sel)),
        free: { x: left, y: freeTop, width: right - left, height: bottom - freeTop },
      };
    },
    [INSPECTOR, LEGEND, FREE_TOP] as const,
  );
}

/** Do two rects share area? Touching edges don't count. */
function meets(a: Rect, b: Rect): boolean {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

/** Does `inner` lie inside `outer`, to within a pixel? */
function within(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - TOLERANCE &&
    inner.y >= outer.y - TOLERANCE &&
    inner.x + inner.width <= outer.x + outer.width + TOLERANCE &&
    inner.y + inner.height <= outer.y + outer.height + TOLERANCE
  );
}

const fmt = (r: Rect | HintRect | null): string =>
  r === null ? 'none' : [r.x, r.y, r.width, r.height].map((v) => v.toFixed(1)).join(',');

/** A panel ring less its outset: the control it goes around. */
function markedBy(ring: HintRect): Rect {
  return { x: ring.x + OUTSET, y: ring.y + OUTSET, width: ring.width - 2 * OUTSET, height: ring.height - 2 * OUTSET };
}

/**
 * What is wrong with a read, or 'clear': the card meets a ring, the control a panel ring marks or the
 * open inspector, or a board ring lies outside the free area while the probe reads it in view.
 */
function overlaps(read: Read, board: boolean): string {
  const { card, probe, inspector, free } = read;
  if (card === null) return 'no card';
  const hits: string[] = [];
  if (probe.hint !== null && meets(card, probe.hint)) hits.push(`ring ${fmt(probe.hint)}`);
  if (probe.hintTo !== null && meets(card, probe.hintTo)) hits.push(`second ring ${fmt(probe.hintTo)}`);
  if (!board && probe.hint !== null && meets(card, markedBy(probe.hint))) hits.push(`the control the ring marks ${fmt(markedBy(probe.hint))}`);
  if (inspector !== null && meets(card, inspector)) hits.push(`inspector ${fmt(inspector)}`);
  if (hits.length > 0) return `card ${fmt(card)} meets ${hits.join(' and ')}`;
  if (board && !probe.offScreen) {
    for (const ring of [probe.hint, probe.hintTo]) {
      if (ring !== null && !within(ring, free)) return `ring ${fmt(ring)} lies outside the free area ${fmt(free)} and the probe reads it in view`;
    }
  }
  return 'clear';
}

/** One test's run: the page, the host, the lesson, the size and Legend state it names, and the stages it measured. */
interface Run {
  page: Page;
  h: Harness;
  lesson: Lesson;
  label: string;
  visited: Set<string>;
}

/**
 * At `stageId`: raise the stage's tallest refusal so the card holds its tallest note, wait until the
 * probe names the stage with its ring and the note, then poll until the card is clear and every board
 * ring is in the free area or flagged, and log it.
 */
async function measureAt(run: Run, stageId: string): Promise<void> {
  const { page, h, lesson, label } = run;
  await ringAt(page, stageId);
  const stage = stageIn(lesson, (await readProbe(page)).stepId, stageId);
  const board = stage.hint !== null && stage.hint.on !== 'panel';
  injectRefusal(h, tallestTag(stage));
  await expect
    .poll(
      async () => {
        const { probe } = await readAll(page);
        if (probe.stageId !== stageId) return `on stage ${probe.stageId}`;
        if (probe.noteKind !== 'refusal') return `note ${probe.noteKind || 'empty'}`;
        if (probe.hint === null) return 'no ring yet';
        return 'ready';
      },
      { message: `${label} ${stageId}: the ring and a refusal note show` },
    )
    .toBe('ready');
  // The note's paragraph height over its line height: the range's rects would count the box itself too.
  const lines = await page.locator(`${CARD} [data-fab-step-note] p`).evaluate((el) => {
    return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  });
  expect(lines, `${label} ${stageId}: the refusal note takes two lines or more, the card's tallest`).toBeGreaterThanOrEqual(2);
  let last: Read | null = null;
  await expect
    .poll(
      async () => {
        last = await readAll(page);
        if (last.probe.stageId !== stageId) return `on stage ${last.probe.stageId}`;
        return overlaps(last, board);
      },
      { message: `${label} ${stageId}: the card meets no ring, no marked control and no open inspector, and every board ring is in view or flagged` },
    )
    .toBe('clear');
  const read = last as unknown as Read;
  run.visited.add(`${read.probe.stepId}/${read.probe.stageId}`);
  console.log(
    `MEASURE clearance lesson=${lesson.id} ${label} step=${read.probe.stepId} stage=${read.probe.stageId} lines=${lines} card=${fmt(read.card)} ring=${fmt(read.probe.hint)} to=${fmt(read.probe.hintTo)} inspector=${fmt(read.inspector)} free=${fmt(read.free)} off=${read.probe.offScreen}`,
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
async function measurePaused(run: Run, back: string): Promise<void> {
  await pause(run.page, run.h);
  await measureAt(run, 'board-paused');
  await play(run.page, run.h);
  await ringAt(run.page, back);
}

/** Open the Legend from the toolbar and wait for its strip. The lesson never opens or closes it itself. */
async function openLegend(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Legend' }).click();
  await expect(page.locator(LEGEND), 'the Legend is open').toBeVisible();
  await blur(page);
}

/** The test's label: the window size and the Legend state. */
function labelOf(size: { width: number; height: number }, legend: boolean): string {
  return `${size.width}x${size.height} with the Legend ${legend ? 'open' : 'closed'}`;
}

/**
 * Lesson 1 started at `size`, with the Legend opened first when `legend` says so, and zoomed out to 1
 * or below so both machines' spots fit the window.
 */
async function startAt(
  page: Page,
  size: { width: number; height: number },
  legend = false,
): Promise<{ h: Harness; host: ReturnType<typeof configuredHost> }> {
  await page.setViewportSize(size);
  const host = configuredHost();
  const h = await boot(page, host.opts);
  await startLesson(page, h);
  if (legend) await openLegend(page);
  for (let i = 0; i < 12 && (await cameraOf(page)).scale > 1; i++) await zoomOut(page);
  return { h, host };
}

for (const size of SIZES) {
  for (const legend of LEGEND_STATES) {
    const label = labelOf(size, legend);
    test(`lesson 1: the tallest card clears every ring and the open inspector at every ringed stage, at ${label}`, async ({ page }) => {
      test.setTimeout(120_000);
      const { h, host } = await startAt(page, size, legend);
      const run: Run = { page, h, lesson: YOUR_FIRST_LINE, label, visited: new Set<string>() };

      // Step 1: the Source.
      await measureAt(run, 'source-tool');
      await measurePaused(run, 'source-tool');
      await page.getByRole('button', { name: 'Place Source', exact: true }).click();
      await measureAt(run, 'source-floor');
      const source: InjectNode = sourceAt(cellOfRing(await ringAt(page, 'source-floor'), await cameraOf(page)));
      h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));

      // Step 2: the Sink, with the lesson's own two-line coaching line at sink-floor.
      await measureAt(run, 'sink-tool');
      await measurePaused(run, 'sink-tool');
      await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
      await measureAt(run, 'sink-floor');
      const sink: InjectNode = sinkAt(cellOfRing(await ringAt(page, 'sink-floor'), await cameraOf(page)));
      h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sink] }));

      // Step 3: the Timer, where the inspector opens and stays open for the rest of the lesson.
      await measureAt(run, 'tool-down');
      await measurePaused(run, 'tool-down');
      await page.keyboard.press('Escape');
      await measureAt(run, 'select-source');
      await pressRing(page, await ringAt(page, 'select-source'));
      await expect(page.locator(INSPECTOR), 'the inspector opens on the Source').toBeVisible();
      await measureAt(run, 'press-timer');
      await pressRing(page, await ringAt(page, 'press-timer'));
      await measureAt(run, 'apply-timer');
      await pressRing(page, await ringAt(page, 'apply-timer'));
      host.set({ kind: 'Timer', interval_ticks: 60 });

      // Step 4: the belt, its plain drag and its carry-on drag.
      await measureAt(run, 'belt-tool');
      await measurePaused(run, 'belt-tool');
      await pressRing(page, await ringAt(page, 'belt-tool'));
      await measureAt(run, 'belt-draw');
      const tiles: InjectBelt['tiles'] = [
        [source.cell_x + 1, source.cell_y],
        [source.cell_x + 2, source.cell_y],
      ];
      const stub: InjectBelt = { id: BELT_ID, tiles, docks: [{ end: 'Tail', node: SOURCE_ID, port: 0 }] };
      h.inject(buildPacket({ full: false, tick: 8, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [stub] }));
      await measureAt(run, 'belt-carry-on');

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
      await measureAt(run, 'board-paused');
      await play(page, h);
      h.inject(buildPacket({ full: false, tick: 10, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [joined([5])] }));

      // Step 6: watch the Sink, then its board-paused.
      await measureAt(run, 'watch');
      await pause(page, h);
      await measureAt(run, 'board-paused');

      expect([...run.visited].sort(), 'every ringed stage of lesson 1 was visited').toEqual([...ringedOf(YOUR_FIRST_LINE)].sort());
    });
  }
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
