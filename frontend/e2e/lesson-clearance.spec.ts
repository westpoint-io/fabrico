import { test, expect, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { ANSWER_A_WEB_REQUEST } from '../src/tutorial/lessons/answerAWebRequest';
import { BELTS_THAT_JOIN } from '../src/tutorial/lessons/beltsThatJoin';
import { DELETE_AND_UNDO } from '../src/tutorial/lessons/deleteAndUndo';
import { TWO_OUTPUTS } from '../src/tutorial/lessons/twoOutputs';
import { YOUR_FIRST_LINE } from '../src/tutorial/lessons/yourFirstLine';
import { phrasePlain } from '../src/tutorial/phrase';
import type { Lesson, Stage } from '../src/tutorial/types';
import { CELL, buildPacket, cameraOf, type Harness, type InjectBelt, type InjectNode } from './support/wire';
import { nubAnchor } from '../shared/geometry';
import {
  CARD,
  EAST_TO_SOUTH,
  JOINER_ID,
  JOIN_SINK_IN,
  JOIN_STUB_ID,
  OUTSET,
  SINK_DEBUG,
  SOURCE_TIMER,
  REQUEST_STAGE,
  REQUEST_STEP,
  SINK_ID,
  SOURCE_ID,
  boot,
  buildBoard,
  buildLine,
  cellOfRing,
  configByNode,
  configuredHost,
  deleteBelt,
  deleteSink,
  expectCaptureComplete,
  beltsThatJoinBoard,
  injectRefusal,
  joinStub,
  joinedBoard,
  placeRouteAndHandler,
  pressRing,
  readProbe,
  requestHost,
  ringAt,
  selectRoute,
  sinkAt,
  sourceAt,
  startFactoryLesson,
  startLesson,
  startRequestLesson,
  toTypeCode,
  typeAndApply,
  undoBoth,
  wireThroughDiscs,
  zoomOut,
  type Visit,
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
//
// Lesson 2 opens its prepared board with the Legend already in the state the test names, because the
// tutorial frames that board once, at the start, in the free area it reads then. Its carry-on stage's
// tallest note is the coaching line for the BeltEndTile refusal, a client tag the host never sends, so
// that refusal is raised by the press the app refuses: a Belt press on the stub's last tile. At that
// stage the ring cell's square and the Sink's In disc must lie inside the free area with the card up.
//
// Lesson 5 runs with the host answering a 1024-byte path's URL, so the send-request card holds a two-line
// note, the 3-line instruction, the request line at its full three lines, the line under it and the
// off-screen row: about 331 px, the tallest card any lesson shows. There the cable band at the floor spots
// (the Handler's three rows plus one above and one below, across the 9-cell span) must lie inside the free
// area and above the card's top, because step 4 is when the user watches the reply come back along it.

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
  /** The Palette's right edge. */
  paletteRight: number;
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
        paletteRight: left,
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

/** Is the card's left edge 8 px right of the Palette, the third rule's place? */
function besidePalette(read: Read): boolean {
  return read.card !== null && Math.abs(read.card.x - (read.paletteRight + GAP)) <= TOLERANCE;
}

/**
 * What is wrong with a read, or 'clear': the card meets a ring, the control a panel ring marks or the
 * open inspector, or a board ring lies outside the free area while the probe reads it in view. Beside
 * the Palette the card may overlap the inspector's lower part (UI-SPEC "Card placement across" and
 * Assumption 2), as long as it covers neither ring nor the control a ring marks.
 */
function overlaps(read: Read, board: boolean): string {
  const { card, probe, inspector, free } = read;
  if (card === null) return 'no card';
  const hits: string[] = [];
  if (probe.hint !== null && meets(card, probe.hint)) hits.push(`ring ${fmt(probe.hint)}`);
  if (probe.hintTo !== null && meets(card, probe.hintTo)) hits.push(`second ring ${fmt(probe.hintTo)}`);
  if (!board && probe.hint !== null && meets(card, markedBy(probe.hint))) hits.push(`the control the ring marks ${fmt(markedBy(probe.hint))}`);
  if (inspector !== null && meets(card, inspector) && !besidePalette(read)) hits.push(`inspector ${fmt(inspector)}`);
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
  /** For a client refusal tag, the gesture that raises it; a host tag is injected. */
  raise?: Record<string, () => Promise<void>>;
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
  const tag = tallestTag(stage);
  // A client tag never comes from the host, so the case raises it with the gesture the app refuses.
  const raise = run.raise?.[tag];
  if (raise !== undefined) await raise();
  else injectRefusal(h, tag);
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
    `MEASURE clearance lesson=${lesson.id} ${label} step=${read.probe.stepId} stage=${read.probe.stageId} lines=${lines} place=${placeOf(read)} card=${fmt(read.card)} ring=${fmt(read.probe.hint)} to=${fmt(read.probe.hintTo)} inspector=${fmt(read.inspector)} free=${fmt(read.free)} off=${read.probe.offScreen}`,
  );
}

/** Which of the three rules across placed the card, read off its rect. */
function placeOf(read: Read): string {
  if (read.card === null) return 'none';
  if (besidePalette(read)) return 'palette';
  if (read.inspector !== null && Math.abs(read.card.x + read.card.width - (read.inspector.x - GAP)) <= TOLERANCE) return 'inspector';
  return 'centred';
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

/** Pause the board on the current step, measure its paused stage (`board-paused` unless named), and play again. */
async function measurePaused(run: Run, back: string, pausedId = 'board-paused'): Promise<void> {
  await pause(run.page, run.h);
  await measureAt(run, pausedId);
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

/** Lesson 2's host: the Source answers Timer and the Sink Debug, as the board file configures them. */
function joinHost(): ReturnType<typeof configByNode> {
  const host = configByNode();
  host.set(SOURCE_ID, SOURCE_TIMER);
  host.set(SINK_ID, SINK_DEBUG);
  return host;
}

/** Lesson 2's joined board with a Straight on the ring cell: the piece detours east and comes back onto the doorstep. */
function detourBoard(): { nodes: InjectNode[]; belts: InjectBelt[] } {
  const { nodes } = beltsThatJoinBoard();
  const joiner: InjectBelt = {
    id: JOINER_ID,
    tiles: [[6, 2], [7, 2], [7, 3], [7, 4], [7, 5], [6, 5]],
    kinds: [{ Straight: { axis: 0 } }, { Corner: { from: 1, to: 2 } }, undefined, undefined, { Corner: { from: 2, to: 3 } }, { Corner: { from: 3, to: 2 } }],
    docks: [
      { end: 'Tail', node: JOIN_STUB_ID, port: 0 },
      { end: 'Head', node: SINK_ID, port: JOIN_SINK_IN.index },
    ],
  };
  return { nodes, belts: [joinStub(JOINER_ID), joiner] };
}

for (const size of SIZES) {
  for (const legend of LEGEND_STATES) {
    const label = labelOf(size, legend);
    test(`lesson 2: the tallest card clears every ring at every ringed stage of BELTS_THAT_JOIN, with the carry-on rings in the free area, at ${label}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(size);
      const host = joinHost();
      const h = await boot(page, host.opts);
      if (legend) await openLegend(page);
      await startLesson(page, h, BELTS_THAT_JOIN);
      const { nodes } = beltsThatJoinBoard();
      let tick = 10;
      const send = (belts: InjectBelt[], removed?: number[]): void => {
        tick += 1;
        h.inject(buildPacket({ full: false, tick, generation: 1, swapFloor: 1, nodes, belts, removed }));
      };
      // The BeltEndTile refusal: a Belt press near the centre of the stub's last tile, (5,2).
      const pressStubEnd = async (): Promise<void> => {
        const cam = await cameraOf(page);
        const px = CELL * cam.scale;
        const x = 5.5 * px + cam.x + 4;
        const y = 2.5 * px + cam.y - 3;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.up();
      };
      const run: Run = { page, h, lesson: BELTS_THAT_JOIN, label, visited: new Set<string>(), raise: { BeltEndTile: pressStubEnd } };

      // Step 1 on the prepared board: the tool, its paused stage, then the carry-on with the coaching line.
      await measureAt(run, 'belt-tool');
      await measurePaused(run, 'belt-tool');
      await pressRing(page, await ringAt(page, 'belt-tool'));
      await measureAt(run, 'belt-carry-on');
      const read = await readAll(page);
      const cam = await cameraOf(page);
      const cell = CELL * cam.scale;
      const ringCell: Rect = { x: 6 * cell + cam.x, y: 2 * cell + cam.y, width: cell, height: cell };
      const disc = read.probe.hint;
      const anchor = nubAnchor(JOIN_SINK_IN.cell_x, JOIN_SINK_IN.cell_y, JOIN_SINK_IN.side);
      console.log(
        `MEASURE carry-on lesson=${BELTS_THAT_JOIN.id} ${label} card=${fmt(read.card)} ring_cell=${fmt(ringCell)} disc=${fmt(disc)} free=${fmt(read.free)} scale=${cam.scale.toFixed(3)}`,
      );
      expect(read.probe.noteKind, `${label}: the coaching line holds the note slot`).toBe('refusal');
      expect(within(ringCell, read.free), `${label}: the ring cell ${fmt(ringCell)} lies inside the free area ${fmt(read.free)}`).toBe(true);
      expect(disc?.shape, `${label}: the carry-on ring is the Sink's In disc`).toBe('circle');
      expect(Math.abs((disc as HintRect).x + (disc as HintRect).width / 2 - (anchor.x * cam.scale + cam.x)), `${label}: the disc sits on the In dot`).toBeLessThanOrEqual(1.5);
      expect(within(disc as HintRect, read.free), `${label}: the Sink's In disc ${fmt(disc)} lies inside the free area ${fmt(read.free)}`).toBe(true);
      expect(read.probe.offScreen, `${label}: the carry-on ring reads in view`).toBe(false);

      // The no-corner stage: a join with a Straight on the ring cell, then back to the stub.
      send(detourBoard().belts);
      await measureAt(run, 'belt-no-corner');
      send([joinStub()], [JOINER_ID]);
      await ringAt(page, 'belt-carry-on');

      // The plain draw stage: the stub deleted, then put back.
      send([], [JOIN_STUB_ID]);
      await measureAt(run, 'belt-draw');
      send([joinStub()]);
      await ringAt(page, 'belt-carry-on');

      // The join on a paused board, so press-play opens on its paused stage.
      await pause(page, h);
      await ringAt(page, 'board-paused');
      send(joinedBoard().belts);
      await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the join finished step 1' }).toBe('press-play');
      await measureAt(run, 'board-paused');
      await play(page, h);
      send(joinedBoard(EAST_TO_SOUTH, [5]).belts);
      await measureAt(run, 'watch');
      await pause(page, h);
      await measureAt(run, 'board-paused');

      expect([...run.visited].sort(), 'every ringed stage of lesson 2 was visited').toEqual([...ringedOf(BELTS_THAT_JOIN)].sort());
    });
  }
}

/**
 * The visit lessons 3 and 4 pass to the shared flows: on each step's first stop, pause and measure the
 * step's board-paused stage, then measure the stage itself.
 */
function measuringVisit(run: Run, pausedOf: (stepId: string) => string = () => 'board-paused'): Visit {
  const paused = new Set<string>();
  return async (stageId) => {
    const step = (await readProbe(run.page)).stepId ?? '';
    if (!paused.has(step)) {
      paused.add(step);
      await measurePaused(run, stageId, pausedOf(step));
    }
    await measureAt(run, stageId);
  };
}

for (const size of SIZES) {
  for (const legend of LEGEND_STATES) {
    const label = labelOf(size, legend);
    test(`lesson 3: the tallest card clears every ring at every ringed stage of DELETE_AND_UNDO, at ${label}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(size);
      const host = configByNode();
      const h = await boot(page, host.opts);
      await startLesson(page, h, DELETE_AND_UNDO);
      if (legend) await openLegend(page);
      const run: Run = { page, h, lesson: DELETE_AND_UNDO, label, visited: new Set<string>() };
      const visit = measuringVisit(run);

      // Zoom 1, where the six-cell line fits the 412 px free area at 1024 wide.
      const board = await buildLine(page, h, host, visit, [0.9, 1.1]);
      await expectCaptureComplete(page);
      await deleteBelt(page, h, board, visit);
      await deleteSink(page, h, board, visit);
      await undoBoth(page, h, host, board, visit);

      expect([...run.visited].sort(), 'every ringed stage of lesson 3 was visited').toEqual([...ringedOf(DELETE_AND_UNDO)].sort());
    });

    test(`lesson 4: the tallest card clears every ring at every ringed stage of TWO_OUTPUTS, at ${label}`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(size);
      const { h, host } = await startFactoryLesson(page, {}, legend ? () => openLegend(page) : undefined);
      const run: Run = { page, h, lesson: TWO_OUTPUTS, label, visited: new Set<string>() };
      const visit = measuringVisit(run);

      await buildBoard(page, h, host, { visit });
      await toTypeCode(page, visit);
      await typeAndApply(page, h, visit);

      expect([...run.visited].sort(), 'every ringed stage of lesson 4 was visited').toEqual([...ringedOf(TWO_OUTPUTS)].sort());
    });
  }
}

/**
 * The host's POST URL for lesson 5's clearance run: a 1024-byte path, the longest a Route takes, so the
 * send-request card's request line sets its full three lines and the card is the tallest the lesson shows.
 */
const LONG_PATH = `/${'route-1234567890'.repeat(64).slice(0, 1023)}`;
const LONG_URL = `http://127.0.0.1:65535/endpoint${LONG_PATH}`;

/**
 * The cable band at the floor spots, in window px: the Handler's three rows plus one above and one below,
 * across the 9-cell span from one cell west of the Route to one cell east of the Handler.
 */
async function cableBand(page: Page, route: InjectNode, handler: InjectNode): Promise<Rect> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  const left = (route.cell_x - 1) * size + cam.x;
  const right = (handler.cell_x + 3 + 1) * size + cam.x;
  const top = (handler.cell_y - 1) * size + cam.y;
  const bottom = (handler.cell_y + 3 + 1) * size + cam.y;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

for (const size of SIZES) {
  for (const legend of LEGEND_STATES) {
    const label = labelOf(size, legend);
    test(`lesson 5: the tallest card clears every ring at every ringed stage of ANSWER_A_WEB_REQUEST, at ${label}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(size);
      const host = requestHost(LONG_URL);
      const { h } = await startRequestLesson(page, host, legend ? () => openLegend(page) : undefined);
      const run: Run = { page, h, lesson: ANSWER_A_WEB_REQUEST, label, visited: new Set<string>() };
      // Step 4 has its own paused stage, because a paused board turns a request away.
      const visit = measuringVisit(run, (step) => (step === REQUEST_STEP.answer ? REQUEST_STAGE.requestPaused : 'board-paused'));
      const board = await placeRouteAndHandler(page, h, host, visit, LONG_PATH);
      await wireThroughDiscs(page, h, board, visit);
      await selectRoute(page, visit);

      // Step 4's send-request: the tallest card, with a two-line note and the three-line request line.
      await ringAt(page, REQUEST_STAGE.sendRequest);
      await expect
        .poll(async () => (await page.locator(`${CARD} [data-fab-request-line]`).textContent()) ?? '', {
          message: `${label}: the request line shows the 1024-byte path's URL`,
        })
        .toContain(LONG_URL);
      await measureAt(run, REQUEST_STAGE.sendRequest);
      const lines = await page.locator(`${CARD} [data-fab-request-line]`).evaluate((el) => {
        const cs = getComputedStyle(el);
        return Math.round((el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
      });
      expect(lines, `${label}: the request line sets its full three lines`).toBe(3);
      const band = await cableBand(page, board.route, board.handler);
      const read = await readAll(page);
      const card = read.card as Rect;
      console.log(
        `MEASURE clearance ${size.width}x${size.height} legend=${legend ? 'open' : 'closed'} band_bottom=${(band.y + band.height).toFixed(1)} card_top=${card.y.toFixed(1)} card_height=${card.height.toFixed(1)} band=${fmt(band)} free=${fmt(read.free)}`,
      );
      expect(within(band, read.free), `${label}: the cable band ${fmt(band)} lies inside the free area ${fmt(read.free)}`).toBe(true);
      expect(band.y + band.height, `${label}: the cable band's bottom sits above the tallest card's top`).toBeLessThanOrEqual(card.y + TOLERANCE);

      expect([...run.visited].sort(), 'every ringed stage of lesson 5 was visited').toEqual([...ringedOf(ANSWER_A_WEB_REQUEST)].sort());
    });
  }
}

test('at 1024x768 with the Factory selected, the card moves 8 px right of the Palette when the inspector-side place would cover the Belt ring', async ({ page }) => {
  // UI-SPEC names lesson 4's sink-tool for this case. Measured, the Sink row's ring sits at about 190 px,
  // far above the card, and the rows the inspector-side card covers at 1024x768 are the Palette's lower
  // ones: the Belt row, ringed at belt-tool with the Factory still selected from step 4.
  await page.setViewportSize({ width: 1024, height: 768 });
  const { h, host } = await startFactoryLesson(page);
  await buildBoard(page, h, host, { beltsDrawn: 0 });
  const ring = await ringAt(page, 'belt-tool');
  await expect(page.locator(INSPECTOR), "the Factory's inspector is open").toBeVisible();
  for (const note of [false, true]) {
    if (note) {
      injectRefusal(h, 'InvalidDock');
      await expect.poll(async () => (await readProbe(page)).noteKind, { message: 'the refusal note shows' }).toBe('refusal');
    }
    const what = note ? 'with a refusal note' : 'with no note';
    let last: Read | null = null;
    await expect
      .poll(
        async () => {
          last = await readAll(page);
          if (last.card === null || last.inspector === null) return 'no card or no inspector';
          if (meets(last.card, ring)) return `card ${fmt(last.card)} meets the Belt ring ${fmt(ring)}`;
          if (!besidePalette(last)) return `card left ${last.card.x.toFixed(1)}, Palette right ${last.paletteRight.toFixed(1)}`;
          return 'beside the Palette';
        },
        { message: `${what}: the card clears the Belt ring with its left edge 8 px right of the Palette` },
      )
      .toBe('beside the Palette');
    const read = last as unknown as Read;
    const card = read.card as Rect;
    const inspector = read.inspector as Rect;
    // The case means something only if the inspector-side place would cover the ring.
    const besideInspector: Rect = { ...card, x: inspector.x - GAP - card.width };
    expect(meets(besideInspector, ring), `${what}: the inspector-side place ${fmt(besideInspector)} would cover the Belt ring ${fmt(ring)}`).toBe(true);
    console.log(`MEASURE clearance ring-aware ${what} card=${fmt(card)} ring=${fmt(ring)} inspector=${fmt(inspector)} palette-right=${read.paletteRight.toFixed(1)}`);
  }
});

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
