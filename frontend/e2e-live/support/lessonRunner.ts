import { expect, test, type JSHandle, type Page } from '@playwright/test';
import { addFrameBudget, addWaitBudget, frameBudgetMs, tickBudgetMs } from '../../e2e/support/frameSampler';
import { CELL } from '../../shared/geometry';
import { KIND_NAMES } from '../../src/chrome/kindNames';
import type { HintRect, TutorialProbe } from '../../src/chrome/tutorial/TutorialLayer';
import { SHORTCUTS, type ShortcutId } from '../../src/input/shortcuts';
import { NUB_RING_R, NUB_RING_STROKE, PORT_ROLE, doorstepCell } from '../../src/protocol/ports';
import { LOCKED_SKIN } from '../../src/render/synth/skins/locked';
import { BELT_ENDS, beltJoining, lineDoorstep, nodeKey, watchedNames } from '../../src/tutorial/check';
import { stageKey } from '../../src/tutorial/machine';
import type { BindingName, Lesson, Stage, Step } from '../../src/tutorial/types';
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
  pollScene,
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
/** Drawn frames for the card's note to follow the band: both come from one refusal, a render apart. */
const CARD_NOTE_FRAMES = 20;
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

/** How many gestures the page has handed to the transport. */
export async function inputsSent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { inputsSent?(): number } }).__fabrico;
    if (typeof hook?.inputsSent !== 'function') throw new Error('window.__fabrico.inputsSent() not installed');
    return hook.inputsSent();
  });
}

/** Press Step once and require the tick to rise by exactly 1. Never pressed twice. */
export async function stepOnce(page: Page, what: string): Promise<number> {
  const before = (await readScene(page)).tick;
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await pollScene(page, (s) => s.tick, {
    message: `${what}: one Step moved the paused board from tick ${before} to ${before + 1}`,
  }).toBe(before + 1);
  return before + 1;
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
  /**
   * The belt-tile read across a delete and its Undo: the cell of the bound belt's first tile, at the
   * Source's output, and its captures A (before the delete) and B (after it). Null until A is taken.
   */
  beltTile: { cell: readonly [number, number]; a: Buffer; b: Buffer | null } | null;
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

/** Drawn frames after the freeze, so the held opacity reaches the compositor before the capture. */
const FREEZE_FRAMES = 2;

/** The ring's animations as the freeze held them, how many there were, and the opacity they hold. */
interface FrozenRing {
  handle: JSHandle<Animation[]>;
  count: number;
  opacity: number;
}

/**
 * Hold the ring paint under `selector` at the top of its pulse for one capture. The ring pulses for the
 * user, and a slow machine can take its screenshot anywhere in the fade, where the border is too far
 * from the focus colour to read. So the walk pauses the ring's own running animations and sets each to
 * the start of its current cycle, where the first keyframe holds opacity 1. The cycle length comes from
 * the animation itself, so a later change to the keyframes' duration can't put the capture off the top.
 * Only this element is touched: emulating reduced motion would also pin the belt and item clock the
 * walk reads, and Playwright's `animations: 'disabled'` stops every animation on the page and fires
 * the app's `transitionend` handlers. `count` is how many animations were held, and `opacity` the
 * element's computed opacity two frames later, or -1 when the element is gone.
 */
async function freezeRingAtPeak(page: Page, selector: string): Promise<FrozenRing> {
  addFrameBudget(FREEZE_FRAMES, 'the ring held at the top of its pulse for one capture');
  const handle = await page.evaluateHandle((sel) => {
    const el = document.querySelector(sel);
    const running = el === null ? [] : el.getAnimations().filter((a) => a.playState === 'running');
    for (const a of running) {
      const d = Number(a.effect?.getComputedTiming().duration);
      const t = Number(a.currentTime ?? 0);
      a.pause();
      if (d > 0) a.currentTime = Math.floor(t / d) * d;
    }
    return running;
  }, selector);
  const opacity = await page.evaluate(
    ([sel, frames]) =>
      new Promise<number>((done) => {
        let left = frames;
        const step = (): void => {
          left -= 1;
          if (left > 0) {
            requestAnimationFrame(step);
            return;
          }
          const el = document.querySelector(sel);
          done(el === null ? -1 : Number(getComputedStyle(el).opacity));
        };
        requestAnimationFrame(step);
      }),
    [selector, FREEZE_FRAMES] as const,
  );
  const count = await handle.evaluate((a) => a.length);
  return { handle, count, opacity };
}

/** Let the ring's held animations run again, so later steps see the pulse the user sees. */
async function resumeRing(frozen: FrozenRing): Promise<void> {
  await frozen.handle.evaluate((anims) => {
    for (const a of anims) a.play();
  });
  await frozen.handle.dispose();
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
 * The ring pulses for the user. For its one capture the walk holds the ring's own animation at the top
 * of its cycle (`freezeRingAtPeak`), then lets it run again and checks that it does, so a slow machine
 * can't land the capture mid-fade and the walk can't leave the pulse stopped. The colour tolerance stays
 * as it is: a wider one would also pass a ring painted the wrong colour.
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
  // Which pulse the paint runs, and its opacity, before the reads: the record that the ring was pulsing
  // for the user when the walk held it for its capture.
  const pulse = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-fab-hint] > div, [data-fab-hint-to] > div')]
      .filter((el) => (el.parentElement as HTMLElement).style.visibility === 'visible')
      .map((el) => {
        const names = el.getAnimations().filter((a) => a.playState === 'running').map((a) => (a as CSSAnimation).animationName);
        return `${names.join('+') || 'none'}@${Number(getComputedStyle(el).opacity).toFixed(2)}`;
      })
      .join(' '),
  );
  const frozenReads: string[] = [];
  for (const [index, rect] of rects.entries()) {
    // The rects come in the probe's order: the main ring, then the ring where a drag ends.
    const paint = index === 0 ? '[data-fab-hint] > div' : '[data-fab-hint-to] > div';
    const clip = {
      x: Math.floor(rect.x),
      y: Math.floor(rect.y),
      width: Math.ceil(rect.x + rect.width) - Math.floor(rect.x),
      height: Math.ceil(rect.y + rect.height) - Math.floor(rect.y),
    };
    // One capture, with the ring held at the top of its pulse and let go again in the `finally`.
    const frozen = await freezeRingAtPeak(page, paint);
    let read: ReturnType<typeof ringOnCanvas>;
    try {
      expect(frozen.opacity, `${label}: the ring, held at the top of its pulse for the capture, reads opacity 1`).toBe(1);
      const img = decodePngRows(await captureClip(page, clip), 0, Number.MAX_SAFE_INTEGER);
      if ((await probeAtStage(page, stepIndex, stage.id)) === null) return;
      read = ringOnCanvas(img, rect.shape, colour, img.width / clip.width);
    } finally {
      await resumeRing(frozen);
    }
    const running = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el === null ? -1 : el.getAnimations().filter((a) => a.playState === 'running').length;
    }, paint);
    expect(running, `${label}: the ring pulses again after the read`).toBe(frozen.count);
    frozenReads.push(`${frozen.count}@${frozen.opacity.toFixed(2)}`);
    reads.push(`${read.ink}/${Math.round(read.floor)} sides ${read.sideInk.join(',')}`);
    expect(read.seen, `${label}: the ring's border shows on every side in the focus colour, around (${clip.x},${clip.y}), side ink ${read.sideInk.join(',')} against ${read.sideFloor.map(Math.round).join(',')}`).toBe(true);
  }
  state.ringsRead.add(kind);
  console.log(`MEASURE ring ${kind} ink/floor=${reads.join(' ')} pulse=${pulse} frozen=${frozenReads.join(',')}`);
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

/**
 * Press a shortcut with the modifiers its table entry names. `key` picks one of the entry's own keys,
 * the first by default; a key the entry doesn't list is refused, naming `stage`.
 */
export async function pressShortcut(page: Page, id: ShortcutId, key?: string, stage: string = id): Promise<void> {
  const { keys, ctrl, shift } = SHORTCUTS[id];
  const chosen = key ?? (keys[0] as string);
  if (!(keys as readonly string[]).includes(chosen)) {
    throw new Error(`${stage}: the walk chose the key ${JSON.stringify(chosen)}, and the ${id} shortcut lists only ${keys.map((k) => JSON.stringify(k)).join(', ')}`);
  }
  await page.keyboard.press(`${ctrl === true ? 'Control+' : ''}${shift === true ? 'Shift+' : ''}${chosen}`);
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

/** One watched Sink and the belt docked at its Head, each with the name the lesson binds it by. */
interface WatchedPair {
  sinkName: string;
  beltName: string;
  sink: { id: number; cells: ReadonlyArray<readonly number[]> };
  tiles: ReadonlyArray<readonly [number, number]>;
  /** The belt's tile touching the Sink. */
  lastTile: readonly [number, number];
}

/** The handles of the belts the probe holds bound, for the line helpers to leave out. */
function boundBeltsOf(bound: Readonly<Record<string, number>>): ReadonlySet<number> {
  return new Set(Object.entries(bound).flatMap(([name, id]) => (BELT_ENDS[name as BindingName] === undefined ? [] : [id])));
}

/**
 * The row a capture across `columns` reads as empty: the first of the rows below and above the belts,
 * nearest first, with no belt tile and no machine cell in those columns, read from the model.
 */
function controlRow(
  scene: { nodes: ReadonlyArray<{ cells: ReadonlyArray<readonly number[]> }>; belts: ReadonlyArray<{ tiles: ReadonlyArray<{ cell_x: number; cell_y: number }> }> },
  rows: readonly number[],
  columns: readonly [number, number],
): number | null {
  const [left, right] = columns;
  const across = (x: number): boolean => x >= left && x <= right;
  const empty = (y: number): boolean =>
    !scene.nodes.some((n) => n.cells.some((c) => c[1] === y && across(c[0] as number))) &&
    !scene.belts.some((b) => b.tiles.some((t) => t.cell_y === y && across(t.cell_x)));
  const low = Math.min(...rows);
  const high = Math.max(...rows);
  for (let d = 1; d <= 3; d++) {
    if (empty(high + d)) return high + d;
    if (empty(low - d)) return low - d;
  }
  return null;
}

/** Dot ink pixels in a capture, and the device pixel ratio it was taken at. */
async function dotInkIn(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<{ ink: number; dpr: number }> {
  const img = decodePngRows(await captureClip(page, clip), 0, Number.MAX_SAFE_INTEGER);
  let ink = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) if (isDotInk(img.data, (y * img.width + x) * 4)) ink += 1;
  }
  return { ink, dpr: img.width / clip.width };
}

/**
 * The walk's read of what a person watches at the end of a lesson, off what's drawn: for each Sink the
 * step's check watches, the dots on the belt docked at its Head, one pair after the other, each message
 * naming that belt's binding. The model can claim items forever while the item layer draws nothing, so
 * this reads the layer, then the screen, then the render loop. An item can be on the Sink's tile for a
 * few frames only, so the layer read runs on animation frames in the page rather than from polls that
 * could land between them.
 */
export async function expectDotsRideBelt(page: Page, ctx: { label: string; sinks: readonly string[] }): Promise<void> {
  const { label } = ctx;
  const probe = await readProbe(page);
  const scene = await readScene(page);
  if (ctx.sinks.length === 0) throw new Error(`${label}: the step's check watches no Sink, so there are no dots to read`);
  const pairs: WatchedPair[] = ctx.sinks.map((sinkName) => {
    const sink = scene.nodes.find((n) => n.id === probe.bound[sinkName]);
    const belt = sink === undefined ? undefined : scene.belts.find((b) => b.docks.some((d) => d.end === 'Head' && d.node === sink.id));
    if (sink === undefined || belt === undefined) {
      throw new Error(`${label}: the watched ${sinkName} and a belt into it aren't both on the board (bound: ${JSON.stringify(probe.bound)})`);
    }
    const beltName =
      Object.entries(probe.bound).find(([name, id]) => id === belt.id && BELT_ENDS[name as BindingName] !== undefined)?.[0] ?? `belt ${belt.id}`;
    const tiles = belt.tiles.map((t) => [t.cell_x, t.cell_y] as const);
    const lastTile = tiles.find(([x, y]) => sink.cells.some((c) => Math.abs((c[0] as number) - x) + Math.abs((c[1] as number) - y) === 1));
    if (lastTile === undefined) throw new Error(`${label}: no tile of the ${beltName} touches the ${sinkName} (tiles: ${JSON.stringify(tiles)})`);
    return { sinkName, beltName, sink, tiles, lastTile };
  });
  for (const pair of pairs) {
    const [sinkX, sinkY] = pair.sink.cells[0] as readonly [number, number];
    await expectOnTheBoard(page, label, `the ${pair.sinkName} the user is told to watch is`, [await screenCellCentre(page, sinkX, sinkY)]);
  }
  // Each belt on one row, and a control row with nothing on it across all of their columns, read from the
  // model first. Ink there means the read is counting something that isn't a dot.
  for (const pair of pairs) {
    const rows = new Set(pair.tiles.map(([, y]) => y));
    expect(rows.size, `${label}: the walk reads a belt on one row, and the ${pair.beltName} sits on ${rows.size}`).toBe(1);
  }
  const allXs = pairs.flatMap((p) => p.tiles.map(([x]) => x));
  const columns = [Math.min(...allXs), Math.max(...allXs)] as const;
  const control = controlRow(scene, pairs.map((p) => p.lastTile[1]), columns);
  if (control === null) throw new Error(`${label}: no row near the watched belts is empty across columns ${columns[0]} to ${columns[1]}, so there is no control strip`);

  for (const pair of pairs) {
    const what = `${label} ${pair.beltName}`;
    await expectDotsOnOneBelt(page, what, pair);
    const cam = await cameraOf(page);
    const size = CELL * cam.scale;
    const xs = pair.tiles.map(([x]) => x);
    const rowClip = (y: number) => ({
      x: Math.min(...xs) * size + cam.x,
      y: y * size + cam.y,
      width: (Math.max(...xs) - Math.min(...xs) + 1) * size,
      height: size,
    });
    const strip = { x: columns[0] * size + cam.x, y: control * size + cam.y, width: (columns[1] - columns[0] + 1) * size, height: size };
    await expect
      .poll(
        async () => {
          const below = await dotInkIn(page, strip);
          expect(below.ink, `${what}: the control row ${control}, empty on the board, holds no dot ink`).toBe(0);
          const row = await dotInkIn(page, rowClip(pair.lastTile[1]));
          return row.ink >= DOT_INK_MIN * row.dpr * row.dpr ? 'ink' : `${row.ink} ink pixels on the ${pair.beltName}'s row`;
        },
        {
          message: `${what}: a capture of the ${pair.beltName}'s row holds dot ink`,
          timeout: addWaitBudget(frameBudgetMs(DOT_READ_FRAMES) + tickBudgetMs(DOT_READ_TICKS), `the dots read on the ${pair.beltName}: ink in a capture`),
        },
      )
      .toBe('ink');
  }

  await expectRenderLoopAlive(page, `at ${label}`);
}

/** The item layer's dots on one belt: three drawn ticks, a move, and a dot on the tile touching its Sink. */
async function expectDotsOnOneBelt(page: Page, what: string, pair: WatchedPair): Promise<void> {
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
    [CELL, pair.tiles, pair.lastTile] as const,
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
          : `drawn ticks ${d.drawnTicks.length}, moves ${d.moves}, dot on the ${pair.sinkName}'s tile ${d.onLastTile}, model tick ${d.firstModelTick} to ${d.lastModelTick}`;
      },
      {
        message: `${what}: item dots ride the ${pair.beltName} into the ${pair.sinkName}, as the item layer plotted them`,
        timeout: addWaitBudget(frameBudgetMs(DOT_READ_FRAMES) + tickBudgetMs(DOT_READ_TICKS), `the dots read on the ${pair.beltName}: three drawn ticks and a dot on the last tile`),
      },
    )
    .toBe('riding');
  const dots = await readDots();
  await page.evaluate(() => {
    const w = window as unknown as { __lessonDotsRun?: number };
    w.__lessonDotsRun = (w.__lessonDotsRun ?? 0) + 1;
  });
  console.log(`MEASURE dots ${pair.beltName} drawn-ticks=${dots.drawnTicks.length} positions=${dots.positions.length}`);
}

/**
 * Click just after `after` on the line the ring marks, and type `insert` there. The point comes from a
 * DOM Range over the line's own text, so it's where a person reading the line would click, and it must
 * sit inside the ring. The text goes in with `keyboard.insertText`, the paste-shaped insertion: typed
 * Enter keys re-indent in CodeMirror (`defaultKeymap` binds Enter to `insertNewlineAndIndent`, see
 * `typeFactorySource` in oracle.ts), so a typed line can't be relied on to land as written.
 */
async function walkTypeCode(page: Page, label: string, ring: HintRect, gesture: { after: string; insert: string }): Promise<void> {
  const at = await page.evaluate(
    ([r, after]) => {
      const inRing = (el: Element): boolean => {
        const b = el.getBoundingClientRect();
        return b.left < r.x + r.width && b.right > r.x && b.top < r.y + r.height && b.bottom > r.y;
      };
      const line = [...document.querySelectorAll('.cm-line')].find((l) => (l.textContent ?? '').includes(after) && inRing(l));
      if (line === undefined) return null;
      const end = (line.textContent ?? '').indexOf(after) + after.length;
      // The text node and offset of the last character of `after`.
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (seen + length >= end) {
          const range = document.createRange();
          range.setStart(node, end - seen - 1);
          range.setEnd(node, end - seen);
          const box = range.getBoundingClientRect();
          return { x: box.right, y: box.top + box.height / 2 };
        }
        seen += length;
      }
      return null;
    },
    [ring, gesture.after] as const,
  );
  if (at === null) throw new Error(`${label}: no line inside the ring holds ${JSON.stringify(gesture.after)}`);
  // Two pixels past the character's right edge, which CodeMirror reads as the gap after it.
  const point = { x: at.x + 2, y: at.y };
  const inside = point.x >= ring.x && point.x <= ring.x + ring.width && point.y >= ring.y && point.y <= ring.y + ring.height;
  expect(inside, `${label}: the point just after ${gesture.after} (${point.x},${point.y}) lies inside the ring (${ring.x},${ring.y} ${ring.width}x${ring.height})`).toBe(true);
  await pressPointByHand(page, point);
  await page.keyboard.insertText(gesture.insert);
  const text = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line'))
      .map((l) => (l.textContent ?? '').replace(/​/g, ''))
      .join('\n'),
  );
  expect(text, `${label}: the editor holds the typed text right after ${gesture.after}`).toContain(`${gesture.after}${gesture.insert}`);
  console.log(`TYPED ${label}: ${JSON.stringify(gesture.insert)} after ${JSON.stringify(gesture.after)}`);
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
  const cells = before.nodes.find((n) => n.id === boundId)?.cells;
  if (cells === undefined || cells.length === 0) {
    throw new Error(`${label}: the bound ${press.of} (${String(boundId)}) isn't on the board`);
  }
  // Anywhere in the machine's whole footprint, from its centre, so a 3 by 3 machine is pressed off its
  // middle cell. On a 1 by 1 machine this is the cell itself, as it always was.
  const xs = cells.map((c) => c[0] as number);
  const ys = cells.map((c) => c[1] as number);
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  const footprint: HintRect = {
    x: Math.min(...xs) * size + cam.x,
    y: Math.min(...ys) * size + cam.y,
    width: (Math.max(...xs) - Math.min(...xs) + 1) * size,
    height: (Math.max(...ys) - Math.min(...ys) + 1) * size,
    shape: 'square',
  };
  const point = pointInRect(footprint, fromOffset(state.walk.refusedOffset ?? state.walk.pressOffset));
  const cx = Math.floor((point.x - cam.x) / size);
  const cy = Math.floor((point.y - cam.y) / size);
  console.log(`REFUSAL-PRESS ${label}: cell (${cx},${cy}) of the ${press.of}'s ${footprint.width / size}x${footprint.height / size} footprint`);
  await expectOnTheBoard(page, label, 'the press is', [point]);

  expect(((await page.locator('#fab-refusal').textContent()) ?? '').trim(), `${label}: no refusal is showing before the press`).toBe('');
  expect(await rejectFlashCell(page), `${label}: no reject flash is plotted before the press`).toBeNull();
  await latchRejectFlashCells(page);
  await pressPointByHand(page, point);

  const sentence = await captureRefusalText(page, `${label}: the app says why it refused`);
  expect(sentence, `${label}: the app says the space is taken`).toBe(REFUSED_SENTENCE);
  console.log(`REFUSAL ${label}: "${sentence}"`);

  // The card says why and how to try again, in the words the walk table holds for this lesson. They
  // aren't read from the lesson, so a coaching line deleted from it fails here. Kind and words are read
  // together, so a lesson note in the slot can't pass.
  const expected = state.walk.refusedCardNote;
  const note = page.locator('[data-fab-step-card] [data-fab-step-note]');
  let cardWords = '';
  await expect
    .poll(
      async () => {
        if ((await note.count()) === 0) return '(no note)';
        cardWords = ((await note.first().textContent()) ?? '').trim();
        return `${(await note.first().getAttribute('data-fab-step-note')) ?? ''}: ${cardWords}`;
      },
      {
        message: `${label}: the card says how to try again`,
        timeout: addWaitBudget(frameBudgetMs(CARD_NOTE_FRAMES), `${label}: the card's refusal note`),
      },
    )
    .toBe(`refusal: ${expected}`);
  console.log(`REFUSAL-CARD ${label}: "${cardWords}"`);

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
  expect(flashes, `${label}: one flash, on the cell of the bound ${press.of} under the press`).toEqual([{ cx, cy }]);

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

  // The handles bound as a restored step begins, so the log shows whether Undo's keyframe handed the
  // restored things new numbers. On a board whose handles come back in the same order they don't change,
  // and then only the unit cases can tell a check that compares handles from one that doesn't.
  const handlesBefore = step.done.is === 'restored' ? (await readProbe(page)).bound : null;
  // What a delete step is to take off the board, named so a re-minted handle can't stand in for it.
  const goneTarget = step.done.is === 'nodeGone' || step.done.is === 'beltGone' ? await deleteTargetOf(page, lesson, stepIndex, step) : null;

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
      await expectDotsRideBelt(page, { label: stepLabel(lesson, stepIndex), sinks: watchedNames(step.done) });
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
        // Capture A: the first press on a belt ring in a belt delete step, with no tool armed and nothing
        // selected yet, so the tile holds the belt as drawn.
        if (step.done.is === 'beltGone' && stage.hint?.on === 'belt' && state.beltTile === null) {
          state.beltTile = await captureBeltTileA(page, lesson, stepIndex, step.done.of);
        }
        const offset = fromOffset(stage.hint?.on === 'floor' ? walk.floorOffset : walk.pressOffset);
        if (stage.hint?.on === 'floor' || stage.hint?.on === 'machine' || stage.hint?.on === 'belt') {
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
        // Reversed, the press lands in the far ring (the In disc) and the release in the near one.
        const start = pointInRect(walk.reverseDrags === true ? rects.hintTo : rects.hint, fromOffset(walk.dragFrom));
        const end = pointInRect(walk.reverseDrags === true ? rects.hint : rects.hintTo, fromOffset(walk.dragTo));
        if (walk.reverseDrags === true) console.log(`REVERSED ${lesson.id} step ${stepIndex + 1}`);
        await expectOnTheBoard(page, label, "both ends of the drag are", [start, end]);
        beltClip = await middleTileClip(page, label, stage, rects.hint);
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
        const cell = from === undefined ? null : lineDoorstep(await readScene(page), from, boundBeltsOf(bound));
        if (cell === null) throw new Error(`${label}: the board holds no line end to carry on from`);
        await expectBeltEndRingPainted(page, label, cell);
        const at = await screenCellCentre(page, cell[0], cell[1]);
        const start = { x: at.x + walk.dragFrom.dx, y: at.y + walk.dragFrom.dy };
        const end = pointInRect(rects.hint, fromOffset(walk.dragTo));
        await expectOnTheBoard(page, label, 'both ends of the drag are', [start, end]);
        await dragByHand(page, start, end);
        actedOn.add(stageKey(stepIndex, stage.id));
      }
    } else if (gesture.do === 'typeCode') {
      const rects = await hintsForStage(page, lesson, stepIndex, stage);
      if (rects !== null) {
        await expectRingPainted(page, state, label, stepIndex, stage, [rects.hint]);
        await walkTypeCode(page, label, rects.hint, gesture);
        actedOn.add(stageKey(stepIndex, stage.id));
      }
    } else if (gesture.do === 'key') {
      if ((await probeAtStage(page, stepIndex, stage.id)) !== null) {
        const key = walk.keyAt?.[`${step.id}/${stage.id}`];
        if (key !== undefined) console.log(`KEY ${lesson.id} step ${stepIndex + 1} ${stage.id} ${key}`);
        await pressShortcut(page, gesture.shortcut, key, label);
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
  if (goneTarget !== null) await expectTargetGone(page, label, goneTarget);
  if (handlesBefore !== null) {
    const after = (await readProbe(page)).bound;
    const list = (b: Record<string, number>): string => Object.entries(b).map(([k, v]) => `${k}:${v}`).join(',');
    console.log(`MEASURE restored-handles ${lesson.id} before=${list(handlesBefore)} after=${list(after)}`);
  }
  if (step.done.is === 'beltGone') await readBeltTileB(page, label, state);
  if (step.done.is === 'restored') {
    await expectCaptureHoldsConfigs(page, label, step.done.since);
    if (lesson.steps.some((s) => s.done.is === 'beltGone')) await readBeltTileC(page, label, state);
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

/** The screen clip 2 px inside a cell, at the camera as it stands. */
async function cellClipOf(page: Page, cell: readonly [number, number]): Promise<{ x: number; y: number; width: number; height: number }> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  // The same inset as the placed cell's read, which comes to 2 px inside the cell.
  const inset = CELL_INTERIOR_INSET_PX - 4;
  return { x: cell[0] * size + cam.x + inset, y: cell[1] * size + cam.y + inset, width: size - 2 * inset, height: size - 2 * inset };
}

/** Belt ink in a capture, and the floor that says a belt drew: belt ink at least the clip's width. */
function beltInkOf(capture: Buffer): { ink: number; floor: number } {
  const img = decodePngRows(capture, 0, Number.MAX_SAFE_INTEGER);
  return { ink: railInk(img), floor: img.width };
}

/**
 * Capture A of the belt-tile read: the bound belt's first tile, the one its Tail starts on at the
 * Source's output. No ring of the lesson reaches that tile, so the read sees the board only.
 */
async function captureBeltTileA(page: Page, lesson: Lesson, stepIndex: number, name: string): Promise<NonNullable<WalkState['beltTile']>> {
  const label = `${stepLabel(lesson, stepIndex)} capture A`;
  const { bound } = await readProbe(page);
  const belt = (await readScene(page)).belts.find((b) => b.id === bound[name]);
  const first = belt?.tiles[0];
  if (belt === undefined || first === undefined) throw new Error(`${label}: the bound ${name} isn't on the board with a tile to read`);
  const ends = BELT_ENDS[name as keyof typeof BELT_ENDS];
  const tail = belt.docks.find((d) => d.end === 'Tail')?.node;
  expect(ends !== undefined && tail === bound[ends[0]], `${label}: the ${name}'s Tail, where its first tile is, docks the ${ends?.[0] ?? '?'}`).toBe(true);
  const cell = [first.cell_x, first.cell_y] as const;
  const a = await captureWithGhostGone(page, await cellClipOf(page, cell));
  const { ink, floor } = beltInkOf(a);
  expect(ink, `${label}: the ${name}'s first tile (${cell[0]},${cell[1]}) holds belt ink before the delete`).toBeGreaterThanOrEqual(floor);
  return { cell, a, b: null };
}

/** Capture B, once the delete step has left, with nothing selected: no belt ink, and other bytes than A. */
async function readBeltTileB(page: Page, label: string, state: WalkState): Promise<void> {
  const tile = state.beltTile;
  if (tile === null) throw new Error(`${label} capture B: capture A was never taken, so the delete has nothing to compare with`);
  // A few drawn frames, so the renderer has drawn the board the model holds.
  await page.waitForTimeout(addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${label}: the deleted belt drawn away`));
  const b = await captureWithGhostGone(page, await cellClipOf(page, tile.cell));
  const { ink, floor } = beltInkOf(b);
  expect(ink, `${label} capture B: the tile (${tile.cell[0]},${tile.cell[1]}) holds no belt ink once the belt is deleted`).toBeLessThan(floor);
  expect(b.equals(tile.a), `${label} capture B: the tile's bytes differ from capture A's`).toBe(false);
  tile.b = b;
}

/** Capture C, once the restore step has finished: belt ink again, then the render loop alive. */
async function readBeltTileC(page: Page, label: string, state: WalkState): Promise<void> {
  const tile = state.beltTile;
  if (tile === null || tile.b === null) throw new Error(`${label} capture C: captures A and B were never both taken`);
  await page.waitForTimeout(addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${label}: the restored belt drawn back`));
  const c = await captureWithGhostGone(page, await cellClipOf(page, tile.cell));
  const a = beltInkOf(tile.a);
  const b = beltInkOf(tile.b);
  const read = beltInkOf(c);
  console.log(`MEASURE belt-tile a=${a.ink} b=${b.ink} c=${read.ink} floor=${read.floor} c_equals_a=${c.equals(tile.a) ? 'yes' : 'no'}`);
  expect(read.ink, `${label} capture C: the tile (${tile.cell[0]},${tile.cell[1]}) holds belt ink again once the belt is restored`).toBeGreaterThanOrEqual(read.floor);
  await expectRenderLoopAlive(page, `${label} after capture C`);
}

/**
 * The restored check's capture holds an applied config for each machine, read through the tutorial's
 * one host query, so bring-back compared configs and not only kinds, cells and ports. Read once the
 * board is back, when its machines are the captured ones.
 */
async function expectCaptureHoldsConfigs(page: Page, label: string, since: string): Promise<void> {
  const capture = (await readProbe(page)).capture;
  const kinds = (await readScene(page)).nodes.map((n) => KIND_NAMES[n.kind] ?? `kind ${n.kind}`).sort();
  expect(capture?.since, `${label}: the probe holds the capture the restored check compares with`).toBe(since);
  const configs = [...(capture?.configKinds ?? [])].sort();
  console.log(`MEASURE capture since=${capture?.since ?? '-'} machines=${capture?.machines ?? 0} configs=${configs.join(',')}`);
  expect(configs, `${label}: the capture holds one applied config per machine, of that machine's kind`).toEqual(kinds);
}

/** What a delete step takes off the board: a machine by its `nodeKey`, or a belt by the handles of the two machines it joins. */
type DeleteTarget = { kind: 'node'; name: string; key: string } | { kind: 'belt'; name: string; a: number; b: number };

/** Read the delete step's target off the board as the step begins, while it's still there. */
async function deleteTargetOf(page: Page, lesson: Lesson, stepIndex: number, step: Step): Promise<DeleteTarget> {
  const check = step.done;
  if (check.is !== 'nodeGone' && check.is !== 'beltGone') throw new Error(`${stepLabel(lesson, stepIndex)}: not a delete step`);
  const { bound } = await readProbe(page);
  const ends = BELT_ENDS[check.of];
  if (check.is === 'beltGone') {
    const a = ends === undefined ? undefined : bound[ends[0]];
    const b = ends === undefined ? undefined : bound[ends[1]];
    if (a === undefined || b === undefined) throw new Error(`${stepLabel(lesson, stepIndex)}: the ${check.of}'s two machines aren't both bound`);
    return { kind: 'belt', name: check.of, a, b };
  }
  const node = (await readScene(page)).nodes.find((n) => n.id === bound[check.of]);
  if (node === undefined) throw new Error(`${stepLabel(lesson, stepIndex)}: the bound ${check.of} isn't on the board as the step begins`);
  return { kind: 'node', name: check.of, key: nodeKey(node) };
}

/** The model holds no trace of what the delete step took off: no machine with its key, or no belt joining its two machines. */
async function expectTargetGone(page: Page, label: string, target: DeleteTarget): Promise<void> {
  const scene = await readScene(page);
  if (target.kind === 'node') {
    expect(scene.nodes.filter((n) => nodeKey(n) === target.key).map((n) => n.id), `${label}: the ${target.name} (${target.key}) is off the board`).toEqual([]);
  } else {
    expect(beltJoining(scene, target.a, target.b)?.id, `${label}: no belt joins the two machines the ${target.name} joined`).toBeUndefined();
  }
}

/**
 * The screen clip inside the cell half way between the drag's two doorsteps: the cell outside its out
 * port and the cell outside its in port. A belt drawn between them runs over this cell whichever
 * machines the stage names. The out end is the cell under the press ring's centre, the Out square's own
 * doorstep, so a drag from a machine's free output reads that output's row.
 */
async function middleTileClip(
  page: Page,
  label: string,
  stage: Stage,
  outRing: HintRect,
): Promise<{ cell: readonly [number, number]; clip: { x: number; y: number; width: number; height: number } }> {
  const hint = stage.hint;
  if (hint?.on !== 'port' || hint.to === undefined) throw new Error(`${label}: the drag stage names no pair of ports`);
  const { bound } = await readProbe(page);
  const nodes = (await readScene(page)).nodes;
  const into = nodes.find((n) => n.id === bound[hint.to!.of])?.ports.find((p) => p.role === PORT_ROLE.IN);
  if (into === undefined) throw new Error(`${label}: the bound ${hint.to.of} isn't on the board with the input the drag names`);
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  const ox = Math.floor((outRing.x + outRing.width / 2 - cam.x) / size);
  const oy = Math.floor((outRing.y + outRing.height / 2 - cam.y) / size);
  const [ix, iy] = doorstepCell(into);
  const cell = [Math.floor((ox + ix) / 2), Math.floor((oy + iy) / 2)] as const;
  return { cell, clip: await cellClipOf(page, cell) };
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
  const began = Date.now();
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
  const state: WalkState = {
    actedOn: new Set(),
    walked: new Set(Array.from({ length: to }, (_, i) => i)),
    walk,
    refusalDone: false,
    ringsRead: new Set(),
    undone: false,
    beltTile: null,
  };
  walkStates.set(page, state);
  await walkSteps(page, lesson, state, 0, to);
  if (opts.until === undefined) {
    await finishWalk(page, lesson, state);
    console.log(`MEASURE lesson-ms ${lesson.id}=${Date.now() - began}`);
  } else {
    checkRecord(lesson, await readRecord(page), state);
  }
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
