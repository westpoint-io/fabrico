import { expect, test, type Page } from '@playwright/test';
import { addFrameBudget, frameBudgetMs } from '../../e2e/support/frameSampler';
import type { HintRect, TutorialProbe } from '../../src/chrome/tutorial/TutorialLayer';
import { stageKey } from '../../src/tutorial/machine';
import type { Lesson, Stage } from '../../src/tutorial/types';
import {
  HAND_MOVE_FRAMES,
  captureClip,
  expectRenderLoopAlive,
  ghostPlottedOf,
  handPath,
  readScene,
} from './oracle';

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
/** The press lands off centre, because a hand never lands on an exact centre. */
const PRESS_OFFSET = { x: 5, y: -4 };
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

async function readRecord(page: Page): Promise<StepRecordEntry[]> {
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

/**
 * Rule 2, no unearned finish. A step that finished itself one frame after it came up still raises
 * the index by one, which rule 1 can't see. So the stage a step ended on must be one the walk acted
 * on, or one whose gesture is `none`. Both read the gesture in the lesson data, and no lesson carries
 * a flag saying a step may be skipped.
 */
function checkEarned(lesson: Lesson, record: readonly StepRecordEntry[], actedOn: ReadonlySet<string>): void {
  record.forEach((b, i) => {
    const a = record[i - 1];
    if (a === undefined || !hasLeftStep(a, b)) return;
    const stage = stageOf(lesson, a.stepIndex, a.stageId);
    if (stage === undefined) {
      throw new Error(`${stageLabel(lesson, a.stepIndex, a.stageId)}: the lesson data has no such stage`);
    }
    if (stage.gesture.do !== 'none' && !actedOn.has(stageKey(a.stepIndex, stage.id))) {
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

function checkRecord(lesson: Lesson, record: readonly StepRecordEntry[], actedOn: ReadonlySet<string>): void {
  checkOrder(lesson, record);
  checkEarned(lesson, record, actedOn);
  checkRects(lesson, record);
}

/**
 * The hint rects of this stage, from one probe read that names the stage and holds a rect. It polls
 * because a ring can appear a frame or more after its stage does. A hint still null at the cap fails:
 * the walk never skips a stage. Null means a read named another step or stage, so the app has left
 * this one, and the caller must not press.
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
  await expect
    .poll(
      async () => {
        const probe = await probeAtStage(page, stepIndex, stage.id);
        if (probe === null) return 'left';
        if (probe.hint === null) return 'waiting';
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

/** Press inside the hint's rect, away from its exact centre, after a hand-like move there. */
async function pressHintRect(page: Page, label: string, rect: HintRect): Promise<void> {
  const dx = Math.min(PRESS_OFFSET.x, rect.width / 4);
  const dy = Math.max(PRESS_OFFSET.y, -rect.height / 4);
  const point = { x: rect.x + rect.width / 2 + dx, y: rect.y + rect.height / 2 + dy };
  const inside =
    point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  expect(inside, `${label}: the press lands inside the hint's rectangle`).toBe(true);
  await moveHand(page, point);
  await page.mouse.down();
  await page.mouse.up();
}

/** Press Help, then Lessons, with real clicks. */
export async function openLessonsFromHelp(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
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

/** Walk every step of a running lesson through its hints, on a board that has just started it. */
export async function walkLesson(page: Page, lesson: Lesson): Promise<void> {
  await latchStepRecord(page);
  await expect
    .poll(async () => (await readRecord(page)).length, {
      message: `${lesson.id}: the step record stayed empty, so its rules would pass on nothing`,
      timeout: frameBudgetMs(RECORD_FRAMES),
    })
    .toBeGreaterThan(0);
  const first = (await readRecord(page))[0];
  expect(first?.stepIndex, `${lesson.id}: the record starts on step 1`).toBe(0);

  const actedOn = new Set<string>();

  for (const [stepIndex, step] of lesson.steps.entries()) {
    await test.step(`${lesson.id} step ${stepIndex + 1} ${step.id}`, async () => {
      // The floor stage's rect and the capture taken on arriving there. Remembered from
      // `hintsForStage`, which is how this read avoids remembering the palette row.
      let cellClip: { x: number; y: number; width: number; height: number } | null = null;
      let beforePixels: Buffer | null = null;
      let floorStageId: string | null = null;

      const rounds = step.stages.length + 2;
      let movedOn = false;
      let lastStageId: string | null = null;
      for (let round = 0; round < rounds && !movedOn; round++) {
        const record = await readRecord(page);
        checkRecord(lesson, record, actedOn);
        if (record.some((e) => e.card === 'finished' || e.stepIndex > stepIndex)) {
          movedOn = true;
          break;
        }
        const onThisStep = record.filter((e) => e.stepIndex === stepIndex);
        const entry = onThisStep[onThisStep.length - 1];
        if (entry === undefined) {
          throw new Error(`${stepLabel(lesson, stepIndex)}: the step record never reached this step`);
        }
        lastStageId = entry.stageId;
        const stage = stageOf(lesson, stepIndex, entry.stageId);
        if (stage === undefined) {
          throw new Error(`${stageLabel(lesson, stepIndex, entry.stageId)}: the lesson data has no such stage`);
        }
        const label = stageLabel(lesson, stepIndex, stage.id);
        // Kept from the same read as the entry: the record may have grown since.
        const length = record.length;
        if (stage.gesture.do === 'pressHint') {
          const rects = await hintsForStage(page, lesson, stepIndex, stage);
          if (rects !== null) {
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
            await pressHintRect(page, label, rects.hint);
            actedOn.add(stageKey(stepIndex, stage.id));
          }
        }
        await expect
          .poll(async () => (await readRecord(page)).length, {
            message: `${label}: the app did not move on after the walk's ${stage.gesture.do}, and the stage is unchanged`,
            timeout: frameBudgetMs(MOVE_ON_FRAMES),
          })
          .toBeGreaterThan(length);
      }
      if (!movedOn) {
        const record = await readRecord(page);
        checkRecord(lesson, record, actedOn);
        if (!record.some((e) => e.card === 'finished' || e.stepIndex > stepIndex)) {
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
      await expectRenderLoopAlive(page, `after ${label}`);
      console.log(`WALK ${lesson.id} step ${stepIndex + 1} ${step.id} passed`);
    });
  }

  checkRecord(lesson, await readRecord(page), actedOn);
}
