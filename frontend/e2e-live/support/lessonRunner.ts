import { expect, test, type Page } from '@playwright/test';
import { addFrameBudget, addWaitBudget, frameBudgetMs, tickBudgetMs } from '../../e2e/support/frameSampler';
import { CELL } from '../../shared/geometry';
import type { HintRect, TutorialProbe } from '../../src/chrome/tutorial/TutorialLayer';
import { SHORTCUTS, type ShortcutId } from '../../src/input/shortcuts';
import { NUB_RING_R, NUB_RING_STROKE } from '../../src/protocol/ports';
import { LOCKED_SKIN } from '../../src/render/synth/skins/locked';
import { lineDoorstep } from '../../src/tutorial/check';
import { stageKey } from '../../src/tutorial/machine';
import type { Lesson, Stage, Step } from '../../src/tutorial/types';
import { DOT_INK_MIN, isDotInk, railInk, ringOnCanvas } from './canvasDots';
import { LESSON_WALKS, REFUSED_SENTENCE, type LessonWalk } from './lessonWalks';
import {
  DRAWN_STATE_FRAMES,
  HAND_MOVE_FRAMES,
  captureClip,
  captureRefusalText,
  cameraOf,
  expectRenderLoopAlive,
  ghostPlottedOf,
  handDragBetween,
  handPath,
  latchRejectFlashCells,
  readScene,
  rejectFlashCell,
  rejectFlashCellsSeen,
  screenCellCentre,
  stopRejectFlashLatch,
} from './oracle';
import { decodePngRows } from './pngRows';

// lessonRunner.ts - walks a lesson from its data, through the hint.
//
// A lesson walk goes where the ring points. It reads the ring's rectangle from
// `window.__fabrico.tutorial()`, moves there the way a hand does and presses, then waits for the app
// to move on. A ring drawn in the wrong place therefore fails the walk.
//
// THE CURRENT STEP COMES FROM A RECORD, NOT A POLL. `reduce` runs on animation frames, so a value
// can last one drawn frame, and a poll 100 ms apart would miss it. The record is written by an
// animation-frame loop in the page, so a step that lasted one frame still shows.

/** Drawn frames a New may take to arrive: a playing board drains before it swaps. */
const SWAP_FRAMES = 60;
/** Drawn frames for a press to reach the app and, for a place, the host's echo to reach the model. */
const MOVE_ON_FRAMES = 20;
/** Drawn frames for the ring to catch up with its stage: its loop runs a frame behind the layer's. */
const HINT_FRAMES = 8;
/** Drawn frames for the record's loop to take its first read. */
const RECORD_FRAMES = 8;
/** Drawn frames for a move off the canvas to hide the placement ghost. */
const GHOST_FRAMES = 8;
/** How far inside the ring's rect the pixel read stays, which also clears the ring's own paint. */
const CELL_INTERIOR_INSET_PX = 6;
/** Sim ticks an item may need to reach the Sink's tile: a Timer's wait and the belt's whole length, twice over. */
const DOT_READ_TICKS = 400;
/** Drawn frames the dots read allows: it needs three drawn ticks, and the frames to see a dot on the last tile. */
const DOT_READ_FRAMES = 60;
/** Sim ticks after the dots read for the head-most item to leave the belt. */
const ARRIVAL_TICKS = 200;
/** How long the poll on the toolbar's tick may wait: two rises of the counter. */
const TOOLBAR_TICKS = 4;
const TOOLBAR_FRAMES = 8;
/** Drawn frames for the Lessons list to show a row's buttons after it opens. */
const ROW_FRAMES = 20;
/**
 * Two rects with centres this close are one target. A palette row can grow 2 px when it arms and
 * shift 1 px while pressed, so exact equality would miss a stale rect on the stage change it matters
 * for.
 */
const SAME_RECT_PX = 4;

/** One run of the app on one step, stage and card. */
export interface StepRecordEntry {
  stepIndex: number;
  stageId: string | null;
  card: string;
  atMs: number;
  /** The first non-null hint read while this entry was the last one. */
  firstHint: HintRect | null;
  /** The latest non-null hint read while this entry was the last one. */
  lastHint: HintRect | null;
}

/** Read `window.__fabrico.tutorial()`. */
export async function readProbe(page: Page): Promise<TutorialProbe> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { tutorial?(): TutorialProbe } }).__fabrico;
    if (typeof hook?.tutorial !== 'function') {
      throw new Error('window.__fabrico.tutorial() not installed');
    }
    return hook.tutorial();
  });
}

/** One probe read, or null when that read names another step or stage. */
export async function probeAtStage(page: Page, stepIndex: number, stageId: string): Promise<TutorialProbe | null> {
  const probe = await readProbe(page);
  return probe.stepIndex === stepIndex && probe.stageId === stageId ? probe : null;
}

/**
 * Start the per-frame record of the steps the app passes through. It starts after the layer's loop,
 * so in each frame it reads the probe after `reduce` has run and before the ring's next callback,
 * which is the frame a stale rect would show under a new stage. Restarting it clears the array.
 */
export async function latchStepRecord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabrico: { tutorial(): TutorialProbe };
      __lessonRecord?: StepRecordEntry[];
      __lessonRecordRun?: number;
    };
    if (typeof w.__fabrico?.tutorial !== 'function') {
      throw new Error('window.__fabrico.tutorial() not installed');
    }
    const run = (w.__lessonRecordRun ?? 0) + 1;
    w.__lessonRecordRun = run;
    const record: StepRecordEntry[] = [];
    w.__lessonRecord = record;
    const tick = (atMs: number): void => {
      if (w.__lessonRecordRun !== run) return;
      const p = w.__fabrico.tutorial();
      let last = record[record.length - 1];
      if (last === undefined || last.stepIndex !== p.stepIndex || last.stageId !== p.stageId || last.card !== p.card) {
        last = { stepIndex: p.stepIndex, stageId: p.stageId, card: p.card, atMs, firstHint: null, lastHint: null };
        record.push(last);
      }
      if (p.hint !== null) {
        last.firstHint ??= p.hint;
        last.lastHint = p.hint;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function readRecord(page: Page): Promise<StepRecordEntry[]> {
  return page.evaluate(() => [...((window as unknown as { __lessonRecord?: StepRecordEntry[] }).__lessonRecord ?? [])]);
}

function stepLabel(lesson: Lesson, stepIndex: number): string {
  return `${lesson.id} step ${stepIndex + 1} (${lesson.steps[stepIndex]?.id ?? 'no such step'})`;
}

function stageLabel(lesson: Lesson, stepIndex: number, stageId: string | null): string {
  return `${stepLabel(lesson, stepIndex)} stage ${stageId ?? 'none'}`;
}

function stageOf(lesson: Lesson, stepIndex: number, stageId: string | null): Stage | undefined {
  return lesson.steps[stepIndex]?.stages.find((s) => s.id === stageId);
}

function positionOf(e: StepRecordEntry): string {
  return e.card === 'running' ? `index ${e.stepIndex}` : e.card;
}

function hasLeftStep(a: StepRecordEntry, b: StepRecordEntry): boolean {
  return b.card === 'finished' || b.stepIndex > a.stepIndex;
}

/**
 * Rule 1, order. The step index stays or rises by exactly one, the card reads running until it reads
 * finished, and finished comes only after the last step.
 */
function checkOrder(lesson: Lesson, record: readonly StepRecordEntry[]): void {
  const lastIndex = lesson.steps.length - 1;
  const fail = (a: StepRecordEntry, b: StepRecordEntry): never => {
    const whole = record.map((e) => positionOf(e)).join(' > ');
    throw new Error(`${stepLabel(lesson, a.stepIndex)}: the step record went from ${positionOf(a)} to ${positionOf(b)}. Whole record: ${whole}`);
  };
  record.forEach((b, i) => {
    const a = record[i - 1];
    if (a === undefined) return;
    if (a.card === 'finished') {
      if (b.card !== 'finished') fail(a, b);
    } else if (b.card === 'finished') {
      if (a.stepIndex !== lastIndex) fail(a, b);
    } else if (b.card !== 'running' || (b.stepIndex !== a.stepIndex && b.stepIndex !== a.stepIndex + 1)) {
      fail(a, b);
    }
  });
}

/** What the runner has done on one page, kept so a test can stop and carry on against the same record. */
interface WalkState {
  /** The stages the walk acted on, as `stageKey`. */
  actedOn: Set<string>;
  /** The steps the runner walks. A test did the others by hand, so rule 2 has nothing to say about them. */
  walked: Set<number>;
  /** Where this lesson's hand lands, from the walk table. */
  walk: LessonWalk;
  /** The refused gesture has been made and read. */
  refusalDone: boolean;
  /** The kinds of ring this walk has read off the screen, as a stage's `hint.on`. */
  ringsRead: Set<string>;
  /** The test pressed Undo along the way. Undo's keyframe drops the selection, so the inspector has closed. */
  undone: boolean;
}

/**
 * Rule 2, no unearned finish. A step that finished itself one frame after it came up still raises
 * the index by one, which rule 1 can't see. So the stage a step ended on must be one the walk acted
 * on, or one whose gesture is `none` or `watch`: those ask nothing of the hand, and the walk reads a
 * `watch` stage's dots however the step ended. Both read the gesture in the lesson data, and no lesson
 * carries a flag saying a step may be skipped.
 */
function checkEarned(lesson: Lesson, record: readonly StepRecordEntry[], state: WalkState): void {
  record.forEach((b, i) => {
    const a = record[i - 1];
    if (a === undefined || !hasLeftStep(a, b) || !state.walked.has(a.stepIndex)) return;
    const stage = stageOf(lesson, a.stepIndex, a.stageId);
    if (stage === undefined) {
      throw new Error(`${stageLabel(lesson, a.stepIndex, a.stageId)}: the lesson data has no such stage`);
    }
    if (stage.gesture.do !== 'none' && stage.gesture.do !== 'watch' && !state.actedOn.has(stageKey(a.stepIndex, stage.id))) {
      throw new Error(`${stageLabel(lesson, a.stepIndex, a.stageId)}: finished before the walk did its ${stage.gesture.do}`);
    }
  });
}

/**
 * Rule 3, a rect belongs to its stage. Two entries in a row whose stages point at different anchors
 * can't report the same rect. The walk's own polls could catch this only by landing inside one frame;
 * this doesn't depend on that timing, because the latch reads the probe on every frame.
 */
function checkRects(lesson: Lesson, record: readonly StepRecordEntry[]): void {
  record.forEach((b, i) => {
    const a = record[i - 1];
    if (a === undefined || a.lastHint === null || b.firstHint === null) return;
    const anchorA = stageOf(lesson, a.stepIndex, a.stageId)?.hint;
    const anchorB = stageOf(lesson, b.stepIndex, b.stageId)?.hint;
    if (JSON.stringify(anchorA) === JSON.stringify(anchorB)) return;
    const dx = a.lastHint.x + a.lastHint.width / 2 - (b.firstHint.x + b.firstHint.width / 2);
    const dy = a.lastHint.y + a.lastHint.height / 2 - (b.firstHint.y + b.firstHint.height / 2);
    if (Math.abs(dx) <= SAME_RECT_PX && Math.abs(dy) <= SAME_RECT_PX) {
      throw new Error(`${stageLabel(lesson, b.stepIndex, b.stageId)}: reported the rect of stage ${a.stageId ?? 'none'}`);
    }
  });
}

function checkRecord(lesson: Lesson, record: readonly StepRecordEntry[], state: WalkState): void {
  checkOrder(lesson, record);
  checkEarned(lesson, record, state);
  checkRects(lesson, record);
}

/**
 * The hint rects of this stage, from one probe read that names the stage and holds a rect. A stage
 * whose anchor names `to` also waits for `hintTo` in that same read, because `belt-draw` follows a
 * stage that has a rect and no `to`, and a drag can't start from half a pair. It polls because a ring
 * can appear a frame or more after its stage does. A hint still null at the cap fails: the walk never
 * skips a stage. Null means a read named another step or stage, so the app has left this one, and the
 * caller must not press.
 *
 * Apart from the record's latch, this is the only code here that reads a rect off the probe.
 */
export async function hintsForStage(
  page: Page,
  lesson: Lesson,
  stepIndex: number,
  stage: Stage,
): Promise<{ hint: HintRect; hintTo: HintRect | null } | null> {
  let rects: { hint: HintRect; hintTo: HintRect | null } | null = null;
  const wantsTo = stage.hint?.on === 'port' && stage.hint.to !== undefined;
  await expect
    .poll(
      async () => {
        const probe = await probeAtStage(page, stepIndex, stage.id);
        if (probe === null) return 'left';
        if (probe.hint === null || (wantsTo && probe.hintTo === null)) return 'waiting';
        rects = { hint: probe.hint, hintTo: probe.hintTo };
        return 'held';
      },
      {
        message: `${stageLabel(lesson, stepIndex, stage.id)}: this stage names a press and reports no hint rectangle`,
        timeout: frameBudgetMs(HINT_FRAMES),
      },
    )
    .not.toBe('waiting');
  return rects;
}

/** Where the walk last left the pointer. Playwright can't report it, and a hand starts from where it is. */
const handAt = new WeakMap<Page, { x: number; y: number }>();

/** Move the pointer the way a hand does, from wherever it is. */
async function moveHand(page: Page, to: { x: number; y: number }): Promise<void> {
  const path = handPath(handAt.get(page) ?? to, to);
  addFrameBudget(path.length * HAND_MOVE_FRAMES, `moveHand ${path.length} moves`);
  for (const p of path) {
    await page.mouse.move(p.x, p.y);
  }
  handAt.set(page, to);
}

/**
 * Take a capture with the placement ghost out of it. The tool stays armed after a place and the ghost
 * follows the pointer, so a capture with the pointer on the cell holds the ghost and differs whether
 * or not the machine drew. Any move off the canvas hides it.
 */
export async function captureWithGhostGone(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  if ((await ghostPlottedOf(page)) !== null) {
    const dock = await page.locator('[data-fab-left-dock]').boundingBox();
    if (dock === null) throw new Error('the palette dock has no box to move the pointer onto');
    await moveHand(page, { x: dock.x + dock.width / 2, y: dock.y + dock.height / 2 });
    await expect
      .poll(() => ghostPlottedOf(page), {
        message: 'the placement ghost hid once the pointer left the canvas',
        timeout: frameBudgetMs(GHOST_FRAMES),
      })
      .toBeNull();
  }
  return captureClip(page, clip);
}

/** The focus colour the ring's stylesheet paints with, as the page resolves it. */
async function focusColour(page: Page): Promise<number> {
  const hex = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fab-focus').trim());
  return Number.parseInt(hex.replace('#', ''), 16);
}

/**
 * Can a person see this stage's ring? A rect reads the same at opacity 0 and behind a panel, and
 * `elementFromPoint` passes through a ring that takes no press, so this reads a capture of the ring's
 * own border. It runs once per kind of ring in a walk, because a capture is slow on a CI runner. A read
 * that a fresh probe says outlived its stage judges nothing, and the next stage of that kind reads it.
 */
async function expectRingPainted(
  page: Page,
  state: WalkState,
  label: string,
  stepIndex: number,
  stage: Stage,
  rects: readonly HintRect[],
): Promise<void> {
  const kind = stage.hint?.on;
  if (kind === undefined || state.ringsRead.has(kind)) return;
  const colour = await focusColour(page);
  const reads: string[] = [];
  for (const rect of rects) {
    const clip = {
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      width: Math.ceil(rect.x + rect.width) - Math.floor(rect.x),
      height: Math.ceil(rect.y + rect.height) - Math.floor(rect.y),
    };
    const img = decodePngRows(await captureClip(page, clip), 0, Number.MAX_SAFE_INTEGER);
    if ((await probeAtStage(page, stepIndex, stage.id)) === null) return;
    const read = ringOnCanvas(img, rect.shape, colour, img.width / clip.width);
    reads.push(`${read.ink}/${Math.round(read.floor)} sides ${read.sideInk.join(',')}`);
    expect(read.seen, `${label}: the ring's border shows on every side in the focus colour, around (${clip.x},${clip.y}), side ink ${read.sideInk.join(',')} against ${read.sideFloor.map(Math.round).join(',')}`).toBe(true);
  }
  state.ringsRead.add(kind);
  console.log(`MEASURE ring ${kind} ink/floor=${reads.join(' ')}`);
}

/**
 * Can a person see the ring the carry-on card sends them to? It belongs to the app, so the lesson reports
 * no rect for it, and the card would point at nothing if it stopped painting. The pointer goes off the
 * belt first, the way a hand does, and the read takes a capture around the cell the press will land on.
 */
async function expectBeltEndRingPainted(page: Page, label: string, cell: readonly [number, number]): Promise<void> {
  await moveHand(page, await screenCellCentre(page, cell[0], cell[1] + 2));
  const at = await screenCellCentre(page, cell[0], cell[1]);
  const reach = (NUB_RING_R + NUB_RING_STROKE / 2) * (await cameraOf(page)).scale;
  const clip = {
    x: Math.floor(at.x - reach),
    y: Math.floor(at.y - reach),
    width: Math.ceil(at.x + reach) - Math.floor(at.x - reach),
    height: Math.ceil(at.y + reach) - Math.floor(at.y - reach),
  };
  const img = decodePngRows(await captureClip(page, clip), 0, Number.MAX_SAFE_INTEGER);
  const read = ringOnCanvas(img, 'circle', LOCKED_SKIN.palette.accents.build, img.width / clip.width);
  console.log(`MEASURE ring belt-end ink/floor=${read.ink}/${Math.round(read.floor)} sides ${read.sideInk.join(',')}`);
  expect(read.seen, `${label}: the ring at the belt's end shows on the board, around (${clip.x},${clip.y}), side ink ${read.sideInk.join(',')} against ${read.sideFloor.map(Math.round).join(',')}`).toBe(true);
}

/** A walk that never read a kind of ring it pressed would pass with that ring invisible. */
function checkRingsRead(lesson: Lesson, state: WalkState): void {
  const wanted = new Set(
    lesson.steps.flatMap((step, i) =>
      state.walked.has(i) ? step.stages.flatMap((s) => (s.hint !== null && (s.gesture.do === 'pressHint' || s.gesture.do === 'dragHint') ? [s.hint.on] : [])) : [],
    ),
  );
  const unread = [...wanted].filter((kind) => !state.ringsRead.has(kind));
  expect(unread, `${lesson.id}: the kinds of ring the walk pressed and never read off the screen`).toEqual([]);
}

/** Travel from wherever the pointer is and press and release at `point`. */
export async function pressPointByHand(page: Page, point: { x: number; y: number }): Promise<void> {
  await moveHand(page, point);
  await page.mouse.down();
  await page.mouse.up();
}

/** A point at this offset from the rect's centre, clamped to the middle half of the rect so it can't leave it. */
export function pointInRect(rect: HintRect, offset: { x: number; y: number }): { x: number; y: number } {
  const clamp = (v: number, half: number): number => Math.max(-half, Math.min(half, v));
  return {
    x: rect.x + rect.width / 2 + clamp(offset.x, rect.width / 4),
    y: rect.y + rect.height / 2 + clamp(offset.y, rect.height / 4),
  };
}

function fromOffset(offset: { dx: number; dy: number }): { x: number; y: number } {
  return { x: offset.dx, y: offset.dy };
}

/**
 * Press inside the hint's rect, away from its exact centre, after a hand-like move there. The ring is
 * read again once the hand has arrived, because a ring can move while the hand travels, and the point
 * was worked out from the rect read before it set off. False means the app left this stage on the way
 * and nothing was pressed.
 */
async function pressHintRect(
  page: Page,
  lesson: Lesson,
  stepIndex: number,
  stage: Stage,
  rect: HintRect,
  offset: { x: number; y: number },
): Promise<boolean> {
  const point = pointInRect(rect, offset);
  await moveHand(page, point);
  const arrived = await hintsForStage(page, lesson, stepIndex, stage);
  if (arrived === null) return false;
  const now = arrived.hint;
  const inside = point.x >= now.x && point.x <= now.x + now.width && point.y >= now.y && point.y <= now.y + now.height;
  expect(
    inside,
    `${stageLabel(lesson, stepIndex, stage.id)}: the press at (${point.x},${point.y}) lands inside the ring as it stands when the hand arrives (${now.x},${now.y} ${now.width}x${now.height})`,
  ).toBe(true);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

/**
 * What a press at each point would land on. A ring on the board is cut off by a panel it passes under,
 * so a target under chrome is one a person can't see or reach, whatever the model would make of the
 * gesture. A pointer release over a panel can still dock a belt, so only this read can tell.
 */
async function expectOnTheBoard(page: Page, label: string, what: string, points: ReadonlyArray<{ x: number; y: number }>): Promise<void> {
  const tags = await page.evaluate((ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null), [...points]);
  expect(tags, `${label}: ${what} on the board, not under a panel`).toEqual(points.map(() => 'CANVAS'));
}

/** Drag from one point to another the way a hand does, leaving the pointer where it let go. */
export async function dragByHand(page: Page, start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
  await moveHand(page, start);
  await handDragBetween(page, start, end);
  handAt.set(page, end);
}

/** Press through several points the way a hand does, letting go at the last. A straight drag can't draw a turn. */
export async function dragAlongByHand(page: Page, points: ReadonlyArray<{ x: number; y: number }>): Promise<void> {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('a drag needs a point to start from');
  await moveHand(page, first);
  await page.mouse.down();
  for (const point of rest) await moveHand(page, point);
  await page.mouse.up();
}

/** Press a shortcut with the modifiers its table entry names. */
export async function pressShortcut(page: Page, id: ShortcutId): Promise<void> {
  const { keys, ctrl, shift } = SHORTCUTS[id];
  await page.keyboard.press(`${ctrl === true ? 'Control+' : ''}${shift === true ? 'Shift+' : ''}${keys[0] as string}`);
}

/** What `expectDotsRideBelt` read from the page's drawn frames. */
interface DotSamples {
  /** The tick the item layer drew from, once per sample with a dot on the belt. */
  drawnTicks: number[];
  positions: string[];
  /** Samples whose dots differ from the sample before. */
  moves: number;
  /** A dot was drawn on the tile touching the Sink. */
  onLastTile: boolean;
  firstModelTick: number;
  lastModelTick: number;
}

/**
 * The walk's read of what a person watches at the end of the lesson, off what's drawn. The model can
 * claim items forever while the item layer draws nothing, so this reads the layer, then the screen,
 * then the render loop. An item can be on the Sink's tile for a few frames only, so the first read
 * runs on animation frames in the page rather than from polls that could land between them.
 */
export async function expectDotsRideBelt(page: Page, ctx: { label: string }): Promise<void> {
  const { label } = ctx;
  const probe = await readProbe(page);
  const scene = await readScene(page);
  const belt = scene.belts.find((b) => b.id === probe.bound.belt);
  const sink = scene.nodes.find((n) => n.id === probe.bound.sink);
  if (belt === undefined || sink === undefined) {
    throw new Error(`${label}: the lesson's bound belt and Sink aren't both on the board (bound: ${JSON.stringify(probe.bound)})`);
  }
  const [sinkX, sinkY] = sink.cells[0] as readonly [number, number];
  await expectOnTheBoard(page, label, 'the Sink the user is told to watch is', [await screenCellCentre(page, sinkX, sinkY)]);
  const tiles = belt.tiles.map((t) => [t.cell_x, t.cell_y] as const);
  const lastTile = tiles.find(([x, y]) => sink.cells.some((c) => Math.abs((c[0] as number) - x) + Math.abs((c[1] as number) - y) === 1));
  if (lastTile === undefined) {
    throw new Error(`${label}: no tile of the belt touches the Sink (tiles: ${JSON.stringify(tiles)})`);
  }

  // The layer as plotted, on every drawn frame until a read below stops it.
  await page.evaluate(
    ([cell, cells, last]) => {
      const w = window as unknown as {
        __fabrico: {
          scene(): { tick: number };
          itemDotsFrame(): { drawnAtTick: number | null; dots: Array<{ x: number; y: number }> };
        };
        __lessonDotsRun?: number;
        __lessonDots?: DotSamples;
      };
      const run = (w.__lessonDotsRun ?? 0) + 1;
      w.__lessonDotsRun = run;
      const tick0 = w.__fabrico.scene().tick;
      const samples: DotSamples = {
        drawnTicks: [],
        positions: [],
        moves: 0,
        onLastTile: false,
        firstModelTick: tick0,
        lastModelTick: tick0,
      };
      w.__lessonDots = samples;
      const onBelt = new Set(cells.map((c) => `${c[0]},${c[1]}`));
      const lastKey = `${last[0]},${last[1]}`;
      let previous = '';
      const sample = (): void => {
        if (w.__lessonDotsRun !== run) return;
        samples.lastModelTick = w.__fabrico.scene().tick;
        const frame = w.__fabrico.itemDotsFrame();
        const here = frame.dots.filter((d) => onBelt.has(`${Math.floor(d.x / cell)},${Math.floor(d.y / cell)}`));
        if (here.length > 0 && frame.drawnAtTick !== null) {
          if (!samples.drawnTicks.includes(frame.drawnAtTick)) samples.drawnTicks.push(frame.drawnAtTick);
          const signature = here
            .map((d) => `${d.x.toFixed(1)},${d.y.toFixed(1)}`)
            .sort()
            .join(' ');
          if (previous !== '' && signature !== previous) samples.moves += 1;
          previous = signature;
          for (const d of here) {
            const position = `${d.x.toFixed(1)},${d.y.toFixed(1)}`;
            if (!samples.positions.includes(position)) samples.positions.push(position);
            if (`${Math.floor(d.x / cell)},${Math.floor(d.y / cell)}` === lastKey) samples.onLastTile = true;
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    },
    [CELL, tiles, lastTile] as const,
  );
  const readDots = (): Promise<DotSamples> =>
    page.evaluate(() => (window as unknown as { __lessonDots: DotSamples }).__lessonDots);
  // The received string says what the read saw, so a failure tells a frozen layer from a slow belt.
  await expect
    .poll(
      async () => {
        const d = await readDots();
        const riding = d.drawnTicks.length >= 3 && d.moves >= 1 && d.onLastTile;
        return riding
          ? 'riding'
          : `drawn ticks ${d.drawnTicks.length}, moves ${d.moves}, dot on the Sink's tile ${d.onLastTile}, model tick ${d.firstModelTick} to ${d.lastModelTick}`;
      },
      {
        message: `${label}: item dots ride the belt into the Sink, as the item layer plotted them`,
        timeout: addWaitBudget(frameBudgetMs(DOT_READ_FRAMES) + tickBudgetMs(DOT_READ_TICKS), 'the dots read: three drawn ticks and a dot on the last tile'),
      },
    )
    .toBe('riding');
  const dots = await readDots();
  await page.evaluate(() => {
    const w = window as unknown as { __lessonDotsRun?: number };
    w.__lessonDotsRun = (w.__lessonDotsRun ?? 0) + 1;
  });
  console.log(`MEASURE dots drawn-ticks=${dots.drawnTicks.length} positions=${dots.positions.length}`);

  // The screen. The row below the belt holds no dot, so ink there means the read is counting something
  // that isn't a dot, and a count on the belt's row would prove nothing.
  const rows = new Set(tiles.map(([, y]) => y));
  expect(rows.size, `${label}: the walk reads a belt on one row, and this one sits on ${rows.size}`).toBe(1);
  const xs = tiles.map(([x]) => x);
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  const clip = {
    x: Math.min(...xs) * size + cam.x,
    y: (lastTile[1] as number) * size + cam.y,
    width: (Math.max(...xs) - Math.min(...xs) + 1) * size,
    height: 2 * size,
  };
  await expect
    .poll(
      async () => {
        const img = decodePngRows(await captureClip(page, clip), 0, Number.MAX_SAFE_INTEGER);
        const dpr = img.width / clip.width;
        const split = Math.round(img.height / 2);
        let onRow = 0;
        let below = 0;
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            if (!isDotInk(img.data, (y * img.width + x) * 4)) continue;
            if (y < split) onRow += 1;
            else below += 1;
          }
        }
        expect(below, `${label}: the row below the belt holds no dot ink`).toBe(0);
        return onRow >= DOT_INK_MIN * dpr * dpr ? 'ink' : `${onRow} ink pixels on the belt's row`;
      },
      {
        message: `${label}: a capture of the belt's row holds dot ink`,
        timeout: addWaitBudget(frameBudgetMs(DOT_READ_FRAMES) + tickBudgetMs(DOT_READ_TICKS), 'the dots read: ink in a capture'),
      },
    )
    .toBe('ink');

  await expectRenderLoopAlive(page, `at ${label}`);
}

/** The toolbar's tick counter, as a person reads it. */
async function toolbarTick(page: Page): Promise<number> {
  const text = await page.getByTitle('Current sim tick').textContent();
  return Number((text ?? '').replace(/[^0-9]/g, ''));
}

async function expectToolbarTickRises(page: Page, label: string): Promise<void> {
  const before = await toolbarTick(page);
  await expect
    .poll(() => toolbarTick(page), {
      message: `${label}: the toolbar's tick keeps rising`,
      timeout: addWaitBudget(frameBudgetMs(TOOLBAR_FRAMES) + tickBudgetMs(TOOLBAR_TICKS), "the toolbar's tick"),
    })
    .toBeGreaterThan(before);
}

/** Press Help, then Lessons, with real clicks. */
export async function openLessonsFromHelp(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
}

/**
 * A lesson's row in the open Lessons list, read whole: its status word, then the names of its buttons
 * in order. Every walk file reads a row through this one function.
 */
export async function expectLessonRow(page: Page, lesson: Lesson, status: string, buttons: readonly string[]): Promise<void> {
  const row = page.locator(`#fab-lessons-panel [data-fab-lesson-row="${lesson.id}"]`);
  await expect(row, `${lesson.id}: the row reads ${status}`).toContainText(status);
  await expect
    .poll(() => row.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))), {
      message: `${lesson.id}: the row offers ${buttons.join(', ')}`,
      timeout: frameBudgetMs(ROW_FRAMES),
    })
    .toEqual([...buttons]);
}

/** Press Start on a lesson's row and wait for the empty board to arrive. */
export async function startLesson(page: Page, lesson: Lesson): Promise<void> {
  const start = page.getByRole('button', { name: `Start ${lesson.title}`, exact: true });
  const box = await start.boundingBox();
  if (box === null) throw new Error(`${lesson.id}: the Start button has no box`);
  await start.click();
  // A click lands on the centre of the box, so this is where the hand is now.
  handAt.set(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await expect
    .poll(async () => (await readProbe(page)).card, {
      message: `${lesson.id}: the lesson reached running after Start`,
      timeout: frameBudgetMs(SWAP_FRAMES),
    })
    .toBe('running');
}

const walkStates = new WeakMap<Page, WalkState>();

function walkStateOf(page: Page, lesson: Lesson): WalkState {
  const state = walkStates.get(page);
  if (state === undefined) throw new Error(`${lesson.id}: carrying on a walk that never started`);
  return state;
}

function indexOfStep(lesson: Lesson, stepId: string): number {
  const index = lesson.steps.findIndex((s) => s.id === stepId);
  if (index < 0) throw new Error(`${lesson.id}: no step named ${stepId}`);
  return index;
}

function hasLeftThisStep(record: readonly StepRecordEntry[], stepIndex: number): boolean {
  return record.some((e) => e.card === 'finished' || e.stepIndex > stepIndex);
}

function refusalLabel(lesson: Lesson, stepIndex: number): string {
  return `${stepLabel(lesson, stepIndex)} refused gesture`;
}

/**
 * A step that moved on after its first press would skip the refused gesture, and rule 2 alone would let
 * it go by, because the walk did act on that first press.
 */
function checkRefusalReached(lesson: Lesson, state: WalkState, stepIndex: number, step: Step, left: boolean): void {
  if (left && step.id === lesson.refused.atStep && !state.refusalDone) {
    throw new Error(`${refusalLabel(lesson, stepIndex)}: never reached stage ${lesson.refused.atStage}`);
  }
}

/**
 * Make the lesson's refused gesture and read what the app did about it. False means a fresh probe read
 * names another stage, so the record was a frame behind, the leg didn't press, and the walk goes back to
 * waiting on the record.
 *
 * The press point comes from the model and not from a ring, and the press lands on the bound machine's
 * own cell, so it collides with that machine and doesn't sit beside it. The reject flash lives 180 ms,
 * the refusal comes back through the host and is polled at 100 to 500 ms, and a CI runner draws about 5
 * frames a second, so a single read after the sentence could miss the flash. The latch reads every
 * frame, and it stays on for a settle window so a second flash would fail the read too. The sentence is
 * read first as a positive anchor, because a step read made before the host answered would pass with
 * nothing refused. One probe read can't see a step that moved and came back, so the record's length is
 * checked as well.
 */
async function walkRefusal(page: Page, lesson: Lesson, state: WalkState, stepIndex: number): Promise<boolean> {
  const { atStage, press } = lesson.refused;
  const label = refusalLabel(lesson, stepIndex);
  const probe = await probeAtStage(page, stepIndex, atStage);
  if (probe === null) return false;
  const lengthBefore = (await readRecord(page)).length;
  const before = await readScene(page);
  const boundId = probe.bound[press.of];
  const anchor = before.nodes.find((n) => n.id === boundId)?.cells[0] as readonly [number, number] | undefined;
  if (anchor === undefined) {
    throw new Error(`${label}: the bound ${press.of} (${String(boundId)}) isn't on the board`);
  }
  const [cx, cy] = anchor;
  const centre = await screenCellCentre(page, cx, cy);
  const size = CELL * (await cameraOf(page)).scale;
  const point = pointInRect(
    { x: centre.x - size / 2, y: centre.y - size / 2, width: size, height: size, shape: 'square' },
    fromOffset(state.walk.pressOffset),
  );
  await expectOnTheBoard(page, label, 'the press is', [point]);

  expect(((await page.locator('#fab-refusal').textContent()) ?? '').trim(), `${label}: no refusal is showing before the press`).toBe('');
  expect(await rejectFlashCell(page), `${label}: no reject flash is plotted before the press`).toBeNull();
  await latchRejectFlashCells(page);
  await pressPointByHand(page, point);

  const sentence = await captureRefusalText(page, `${label}: the app says why it refused`);
  expect(sentence, `${label}: the app says the space is taken`).toBe(REFUSED_SENTENCE);
  console.log(`REFUSAL ${label}: "${sentence}"`);

  await expect
    .poll(async () => (await rejectFlashCellsSeen(page)).length, {
      message: `${label}: the canvas plotted a reject flash at the press`,
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES * 4), `${label}: the flash latch`),
    })
    .toBeGreaterThan(0);
  // A few frames more, so a second flash, were there one, would be latched too.
  await page.waitForTimeout(addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES * 2), `${label}: the second-flash window`));
  const flashes = await rejectFlashCellsSeen(page);
  await stopRejectFlashLatch(page);
  expect(flashes, `${label}: one flash, on the cell of the bound ${press.of}`).toEqual([{ cx, cy }]);

  const after = await readProbe(page);
  expect(after.stepIndex, `${label}: the refusal moved the step on`).toBe(stepIndex);
  expect(after.stageId, `${label}: the refusal moved the stage on`).toBe(atStage);
  expect((await readRecord(page)).length, `${label}: the step record grew across the refusal, so the step moved and came back`).toBe(lengthBefore);
  expect((await readScene(page)).nodes.length, `${label}: the refused press placed a machine`).toBe(before.nodes.length);
  return true;
}

/** One step of a lesson, through its hints. */
async function walkStep(page: Page, lesson: Lesson, state: WalkState, stepIndex: number, step: Step): Promise<void> {
  const { actedOn, walk } = state;
  // The floor stage's rect and the capture taken on arriving there. Remembered from
  // `hintsForStage`, which is how this read avoids remembering the palette row.
  let cellClip: { x: number; y: number; width: number; height: number } | null = null;
  let beforePixels: Buffer | null = null;
  let floorStageId: string | null = null;
  // A middle tile of the belt, before and after the drag.
  let beltClip: { cell: readonly [number, number]; clip: { x: number; y: number; width: number; height: number } } | null = null;
  let beltBefore: Buffer | null = null;

  const watchStage = step.stages.find((s) => s.gesture.do === 'watch');
  let dotsRead = false;
  const rounds = step.stages.length + 2;
  let movedOn = false;
  let lastStageId: string | null = null;
  for (let round = 0; round < rounds && !movedOn; round++) {
    const record = await readRecord(page);
    const left = hasLeftThisStep(record, stepIndex);
    checkRefusalReached(lesson, state, stepIndex, step, left);
    checkRecord(lesson, record, state);
    const onThisStep = record.filter((e) => e.stepIndex === stepIndex);
    const entry = onThisStep[onThisStep.length - 1];
    if (entry === undefined && !left) {
      throw new Error(`${stepLabel(lesson, stepIndex)}: the step record never reached this step`);
    }
    // A WATCH STAGE'S READ RUNS BEFORE THE CHECK THAT THE RECORD MOVED ON. The first delivery can land
    // while the walk is still on step 4's or step 5's reads, and the step would look finished with the
    // dots never read. The board keeps running after that delivery and the Timer keeps making items,
    // so the dots are still there to read, and a fast delivery can't skip the read.
    if (watchStage !== undefined && !dotsRead && (left || entry?.stageId === watchStage.id)) {
      await expectDotsRideBelt(page, { label: stepLabel(lesson, stepIndex) });
      dotsRead = true;
      actedOn.add(stageKey(stepIndex, watchStage.id));
      continue;
    }
    if (left) {
      movedOn = true;
      break;
    }
    lastStageId = entry!.stageId;
    const stage = stageOf(lesson, stepIndex, entry!.stageId);
    if (stage === undefined) {
      throw new Error(`${stageLabel(lesson, stepIndex, entry!.stageId)}: the lesson data has no such stage`);
    }
    const label = stageLabel(lesson, stepIndex, stage.id);
    // Kept from the same read as the entry: the record may have grown since.
    const length = record.length;
    const gesture = stage.gesture;
    // Before the stage's own read of its ring, so the press below holds no rect from before the refusal.
    // If the app has left this stage, each gesture's own read below finds that out and doesn't press.
    if (step.id === lesson.refused.atStep && stage.id === lesson.refused.atStage && !state.refusalDone) {
      state.refusalDone = await walkRefusal(page, lesson, state, stepIndex);
    }
    if (gesture.do === 'pressHint') {
      const rects = await hintsForStage(page, lesson, stepIndex, stage);
      if (rects !== null) {
        await expectRingPainted(page, state, label, stepIndex, stage, [rects.hint]);
        if (stage.hint?.on === 'floor' && cellClip === null) {
          cellClip = {
            x: rects.hint.x + CELL_INTERIOR_INSET_PX,
            y: rects.hint.y + CELL_INTERIOR_INSET_PX,
            width: rects.hint.width - 2 * CELL_INTERIOR_INSET_PX,
            height: rects.hint.height - 2 * CELL_INTERIOR_INSET_PX,
          };
          floorStageId = stage.id;
          // The pointer still sits on the palette row.
          beforePixels = await captureWithGhostGone(page, cellClip);
        }
        const offset = fromOffset(stage.hint?.on === 'floor' ? walk.floorOffset : walk.pressOffset);
        if (stage.hint?.on === 'floor' || stage.hint?.on === 'machine') {
          await expectOnTheBoard(page, label, 'the ring is', [pointInRect(rects.hint, offset)]);
        }
        if (await pressHintRect(page, lesson, stepIndex, stage, rects.hint, offset)) {
          actedOn.add(stageKey(stepIndex, stage.id));
        }
      }
    } else if (gesture.do === 'dragHint') {
      // Both rects from one return: a drag can't start from the last stage's ring.
      const rects = await hintsForStage(page, lesson, stepIndex, stage);
      if (rects !== null) {
        if (rects.hintTo === null) throw new Error(`${label}: this stage names a drag and reports no release ring`);
        await expectRingPainted(page, state, label, stepIndex, stage, [rects.hint, rects.hintTo]);
        const start = pointInRect(rects.hint, fromOffset(walk.dragFrom));
        const end = pointInRect(rects.hintTo, fromOffset(walk.dragTo));
        await expectOnTheBoard(page, label, "both ends of the drag are", [start, end]);
        beltClip = await middleTileClip(page, label);
        beltBefore = await captureWithGhostGone(page, beltClip.clip);
        await dragByHand(page, start, end);
        actedOn.add(stageKey(stepIndex, stage.id));
      }
    } else if (gesture.do === 'dragToHint') {
      const rects = await hintsForStage(page, lesson, stepIndex, stage);
      if (rects !== null) {
        if (rects.hintTo !== null) throw new Error(`${label}: this stage marks one ring and reports a second`);
        await expectRingPainted(page, state, label, stepIndex, stage, [rects.hint]);
        const { bound } = await readProbe(page);
        const from = stage.when.is === 'lineStopsShort' ? bound[stage.when.from] : undefined;
        const cell = from === undefined ? null : lineDoorstep(await readScene(page), from);
        if (cell === null) throw new Error(`${label}: the board holds no line end to carry on from`);
        await expectBeltEndRingPainted(page, label, cell);
        const at = await screenCellCentre(page, cell[0], cell[1]);
        const start = { x: at.x + walk.dragFrom.dx, y: at.y + walk.dragFrom.dy };
        const end = pointInRect(rects.hint, fromOffset(walk.dragTo));
        await expectOnTheBoard(page, label, 'both ends of the drag are', [start, end]);
        await dragByHand(page, start, end);
        actedOn.add(stageKey(stepIndex, stage.id));
      }
    } else if (gesture.do === 'key') {
      if ((await probeAtStage(page, stepIndex, stage.id)) !== null) {
        await pressShortcut(page, gesture.shortcut);
        actedOn.add(stageKey(stepIndex, stage.id));
      }
    }
    await expect
      .poll(async () => (await readRecord(page)).length, {
        message: `${label}: the app did not move on after the walk's ${gesture.do}, and the stage is unchanged`,
        timeout:
          gesture.do === 'watch'
            ? addWaitBudget(frameBudgetMs(MOVE_ON_FRAMES) + tickBudgetMs(ARRIVAL_TICKS), 'the head-most item leaving the belt')
            : frameBudgetMs(MOVE_ON_FRAMES),
      })
      .toBeGreaterThan(length);
  }
  if (!movedOn) {
    const record = await readRecord(page);
    checkRefusalReached(lesson, state, stepIndex, step, hasLeftThisStep(record, stepIndex));
    checkRecord(lesson, record, state);
    if (!hasLeftThisStep(record, stepIndex)) {
      throw new Error(`${stageLabel(lesson, stepIndex, lastStageId)}: still on this step after ${rounds} rounds`);
    }
  }

  const label = stepLabel(lesson, stepIndex);
  if (step.done.is === 'nodeAppeared') {
    const { bound } = await readProbe(page);
    const id = bound[step.done.bind];
    expect(id, `${label}: the lesson bound the ${step.done.bind} it asked for`).toBeDefined();
    const node = (await readScene(page)).nodes.find((n) => n.id === id);
    expect(node?.kind, `${label}: the bound ${step.done.bind} is on the board with the right kind`).toBe(step.done.kind);
  }
  if (cellClip !== null && beforePixels !== null) {
    const afterPixels = await captureWithGhostGone(page, cellClip);
    expect(
      afterPixels.equals(beforePixels),
      `${stageLabel(lesson, stepIndex, floorStageId)}: the pixels inside the placed cell did not change, so the machine did not draw`,
    ).toBe(false);
  }
  if (beltClip !== null && beltBefore !== null) {
    const { cell, clip } = beltClip;
    const scene = await readScene(page);
    const onTheBelt = scene.belts.some((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
    expect(onTheBelt, `${label}: the cell the read compares is a tile of the new belt`).toBe(true);
    const afterPixels = await captureWithGhostGone(page, clip);
    // Belt ink, and not just a change. The Timer has been running since step 3, so a dot crossing this
    // tile would change the pixels with no belt drawn at all. A dot is warm, so it adds no belt ink.
    const before = decodePngRows(beltBefore, 0, Number.MAX_SAFE_INTEGER);
    const after = decodePngRows(afterPixels, 0, Number.MAX_SAFE_INTEGER);
    const floor = after.width;
    console.log(`MEASURE rail before=${railInk(before)} after=${railInk(after)} floor=${floor}`);
    expect(railInk(before), `${label}: the middle tile holds no belt ink before the drag, so the read below can tell`).toBeLessThan(floor);
    expect(railInk(after), `${label}: the middle tile holds belt ink along its length, so the belt drew`).toBeGreaterThanOrEqual(floor);
  }
  // Steps 3 and 5 change no board cell, so no byte compare can grade them. What a person sees is the
  // pressed segment and the clock still moving, so that's what these read.
  if (step.done.is === 'triggerApplied' || step.done.is === 'tickRose') {
    if (!state.undone) {
      const asked = lesson.steps.flatMap((s) => (s.done.is === 'triggerApplied' ? [s.done.trigger] : []));
      const pressed = await page
        .locator('[role="group"][aria-label="Trigger"] button[aria-pressed="true"]')
        .textContent({ timeout: frameBudgetMs(MOVE_ON_FRAMES) });
      expect(asked, `${label}: the lesson's data names the trigger it asks for`).toHaveLength(1);
      expect(pressed?.trim(), `${label}: the inspector's pressed segment reads the trigger the lesson asked for`).toBe(asked[0]);
    }
    await expectToolbarTickRises(page, label);
  }
  await expectRenderLoopAlive(page, `after ${label}`);
  console.log(`WALK ${lesson.id} step ${stepIndex + 1} ${step.id} passed`);
}

/** The screen clip inside the cell half way between the bound machines, where the belt will run. */
async function middleTileClip(
  page: Page,
  label: string,
): Promise<{ cell: readonly [number, number]; clip: { x: number; y: number; width: number; height: number } }> {
  const { bound } = await readProbe(page);
  const nodes = (await readScene(page)).nodes;
  const source = nodes.find((n) => n.id === bound.source)?.cells[0];
  const sink = nodes.find((n) => n.id === bound.sink)?.cells[0];
  if (source === undefined || sink === undefined) throw new Error(`${label}: the bound machines aren't both on the board`);
  const cell = [Math.floor(((source[0] as number) + (sink[0] as number)) / 2), source[1] as number] as const;
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  // The same inset as the placed cell's read, which comes to 2 px inside the cell.
  const inset = CELL_INTERIOR_INSET_PX - 4;
  return {
    cell,
    clip: {
      x: cell[0] * size + cam.x + inset,
      y: cell[1] * size + cam.y + inset,
      width: size - 2 * inset,
      height: size - 2 * inset,
    },
  };
}

async function walkSteps(page: Page, lesson: Lesson, state: WalkState, from: number, to: number): Promise<void> {
  for (let stepIndex = from; stepIndex < to; stepIndex++) {
    const step = lesson.steps[stepIndex] as Step;
    await test.step(`${lesson.id} step ${stepIndex + 1} ${step.id}`, () => walkStep(page, lesson, state, stepIndex, step));
  }
}

/** Log the record, so the run's `.out` file holds it, and measure how long `press-play` lasted. */
async function finishWalk(page: Page, lesson: Lesson, state: WalkState): Promise<void> {
  const record = await readRecord(page);
  checkRecord(lesson, record, state);
  checkRingsRead(lesson, state);
  const line = record.map((e) => `${positionOf(e)}:${e.stageId ?? '-'}@${Math.round(e.atMs)}`).join(' ');
  console.log(`STEP_RECORD ${lesson.id} ${line}`);
  const indexes = [...new Set(record.map((e) => e.stepIndex))];
  const atOf = (index: number): number | undefined => record.find((e) => e.stepIndex === index)?.atMs;
  const playIndex = lesson.steps.findIndex((s) => s.done.is === 'tickRose');
  const began = atOf(playIndex);
  const ended = atOf(playIndex + 1);
  if (began !== undefined && ended !== undefined) {
    console.log(`MEASURE step-record indexes=${indexes.join(',')} press-play-ms=${Math.round(ended - began)}`);
  }
}

/**
 * Walk a running lesson through its hints, on a board that has just started it. With `until`, stop
 * before that step, so a test can do it by hand and carry on with `continueLesson`.
 */
export async function walkLesson(page: Page, lesson: Lesson, opts: { until?: string } = {}): Promise<void> {
  const walk: LessonWalk | undefined = LESSON_WALKS[lesson.id];
  if (walk === undefined) throw new Error(`${lesson.id}: LESSON_WALKS has no entry for this lesson, so the walk has no offsets to press with`);
  await latchStepRecord(page);
  await expect
    .poll(async () => (await readRecord(page)).length, {
      message: `${lesson.id}: the step record stayed empty, so its rules would pass on nothing`,
      timeout: frameBudgetMs(RECORD_FRAMES),
    })
    .toBeGreaterThan(0);
  const first = (await readRecord(page))[0];
  expect(first?.stepIndex, `${lesson.id}: the record starts on step 1`).toBe(0);

  const to = opts.until === undefined ? lesson.steps.length : indexOfStep(lesson, opts.until);
  const state: WalkState = { actedOn: new Set(), walked: new Set(Array.from({ length: to }, (_, i) => i)), walk, refusalDone: false, ringsRead: new Set(), undone: false };
  walkStates.set(page, state);
  await walkSteps(page, lesson, state, 0, to);
  if (opts.until === undefined) await finishWalk(page, lesson, state);
  else checkRecord(lesson, await readRecord(page), state);
}

/**
 * Carry on a walk from a step, against the same record. Rules 1 and 3 still read the whole record, and
 * rule 2 covers only the steps the runner walked, because the test did the others by hand.
 */
export async function continueLesson(page: Page, lesson: Lesson, opts: { from: string; undone?: boolean }): Promise<void> {
  const state = walkStateOf(page, lesson);
  state.undone = opts.undone ?? false;
  const from = indexOfStep(lesson, opts.from);
  for (let i = from; i < lesson.steps.length; i++) state.walked.add(i);
  await walkSteps(page, lesson, state, from, lesson.steps.length);
  await finishWalk(page, lesson, state);
}
