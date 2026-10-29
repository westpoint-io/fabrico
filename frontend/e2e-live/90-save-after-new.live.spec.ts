import { test, expect, type Dialog, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  expectRenderLoopAlive,
  loadDemoViaExamples,
  newBoard,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  waitForCameraSettle,
  waitForFile,
  watchPageErrors,
} from './support/oracle';

// 90-save-after-new.live.spec.ts (phase 90, WORK-07, D-02, success criterion 1, UI-SPEC
// section 4.1 and walk steps 1 to 3): Ctrl+S never writes the board on screen into a file it
// did not come from, on the real dev host, graded on the bytes on disk.
//
// WHAT WAS BROKEN (90-MEASURE.md, "WORK-07: still broken"). New and an example kept the
// previous board's file as the save target, so Ctrl+S after New overwrote it with no prompt.
// And an Open moved the save target and cleared the unsaved flag at DISPATCH, so a file the
// host refused became the file Ctrl+S wrote, and the board's unsaved edits read as saved.
// Since plan 90-04 New and an example clear the target after their dispatch, and an Open is
// held as pending: the target and the flag move only on the Load's own swap keyframe.
//
// THE THREE LEGS, every file under a per-test temp folder, every hash read from this test
// process with node:crypto (the bytes on disk, never a frontend claim):
//   1. A new board with a Source saved to A, New, a Sink placed, Ctrl+S: the Save As prompt
//      opens; B, the path given, holds a board that opens as exactly one Sink and no Source;
//      A's hash is unchanged.
//   2. The demo saved to A, an example loaded, Ctrl+S: the prompt opens; A's hash unchanged.
//   3. The demo saved to A and opened again, a Sink placed (`Unsaved`), the refused file
//      (eight 0xff bytes) opened through the discard guard's Discard: the card, `Load
//      failed`, the `Unsaved` badge still shown (the refused Load discarded nothing);
//      Ctrl+S: no prompt, A rewritten (its mtime rises), the refused file's hash unchanged.
//
// Every browser prompt is answered by one listener that takes the next queued path, and a
// prompt with nothing queued is dismissed and counted, so a prompt that should not open is
// seen as one. Ctrl+S is the keyboard accelerator, bound above the toolbar's focus guard
// (gestures.ts LW-02). MODEL FIRST, THEN RENDER HEALTH in every test.

const LOADED = 'Loaded';
const LOAD_FAILED = 'Load failed';
const UNSAVED = 'Unsaved';
/** Protocol `machine_kind`: SOURCE 0, SINK 7. */
const SOURCE_KIND = 0;
const SINK_KIND = 7;
/** A host answer on a busy board can wait for its drain (up to 18.9 s measured under the quota). */
const ANSWER_MS = 45_000;
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';

function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** One listener for every prompt: answer with the next queued path, else dismiss it. */
function watchPrompts(page: Page) {
  const queue: string[] = [];
  let opened = 0;
  let unanswered = 0;
  const onDialog = (d: Dialog): void => {
    opened += 1;
    const next = queue.shift();
    if (next === undefined) {
      unanswered += 1;
      void d.dismiss();
    } else {
      void d.accept(next);
    }
  };
  page.on('dialog', onDialog);
  return {
    answerWith: (path: string): void => {
      queue.push(path);
    },
    opened: (): number => opened,
    unanswered: (): number => unanswered,
    stop: (): void => {
      page.off('dialog', onDialog);
    },
  };
}

async function readout(page: Page): Promise<string> {
  return ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim();
}

/** Save through the toolbar button, answering the prompt with `path`. */
async function saveVia(page: Page, prompts: ReturnType<typeof watchPrompts>, path: string, what: string): Promise<void> {
  const before = prompts.opened();
  prompts.answerWith(path);
  await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
  await expect.poll(() => prompts.opened(), { message: `${what}: the Save prompt opened (no file known yet)` }).toBe(before + 1);
  await waitForFile(path, `${what}: the host wrote the file`, ANSWER_MS);
}

/** Open `path` through the toolbar button and wait for the strip to read `Loaded`. */
async function openVia(page: Page, prompts: ReturnType<typeof watchPrompts>, path: string, what: string): Promise<void> {
  prompts.answerWith(path);
  await page.getByTitle('Load a saved factory').click();
  await expect.poll(() => readout(page), { timeout: ANSWER_MS, intervals: [50, 100, 250], message: `${what}: Loaded` }).toBe(LOADED);
}

/** Ctrl+S answered with `path`: the Save As prompt must open. */
async function ctrlSExpectingPrompt(page: Page, prompts: ReturnType<typeof watchPrompts>, path: string, what: string): Promise<void> {
  const before = prompts.opened();
  prompts.answerWith(path);
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => prompts.opened(), {
      timeout: 5_000,
      message: `${what}: Ctrl+S opens the Save As prompt (the board has no file of its own yet)`,
    })
    .toBe(before + 1);
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  await waitForCameraSettle(page);
}

test.describe('90 live: Ctrl+S writes only the board\'s own file (WORK-07)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: a board saved to A, New, a Sink placed, Ctrl+S: the prompt, B holds one Sink, A unchanged', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    const dir = mkdtempSync(join(tmpdir(), 'fabrico-e2e-90-save-after-new-'));
    const a = join(dir, 'a.fab');
    const b = join(dir, 'b.fab');
    const prompts = watchPrompts(page);
    try {
      await boot(page);
      await newBoard(page);
      await armAndPlaceAt(page, 'Source', 6, 6);
      await pollScene(page, (s) => s.nodes.length, { message: 'leg 1: the Source folded on the new board' }).toBe(1);
      await saveVia(page, prompts, a, 'leg 1, A');
      const hashA = hashOf(a);
      await expectRenderLoopAlive(page, 'leg 1, after saving A');

      await newBoard(page);
      await armAndPlaceAt(page, 'Sink', 8, 6);
      await pollScene(page, (s) => s.nodes.map((n) => n.kind), { message: 'leg 1: the Sink folded on the second new board' }).toEqual([
        SINK_KIND,
      ]);
      await ctrlSExpectingPrompt(page, prompts, b, 'leg 1, after New');
      await waitForFile(b, 'leg 1: the host wrote B', ANSWER_MS);
      expect(hashOf(a), 'leg 1: A, the previous board\'s file, is byte for byte unchanged').toBe(hashA);

      await openVia(page, prompts, b, 'leg 1, B opened');
      const kinds = (await readScene(page)).nodes.map((n) => n.kind);
      console.log(`P90-WORK-07 leg-1 kinds_in_b=${JSON.stringify(kinds)} prompts=${prompts.opened()} unanswered=${prompts.unanswered()}`);
      expect(kinds, 'leg 1: B holds exactly one Sink').toEqual([SINK_KIND]);
      expect(kinds, 'leg 1: and no Source').not.toContain(SOURCE_KIND);
      expect(hashOf(a), 'leg 1: A is still unchanged at the end').toBe(hashA);
      expect(prompts.unanswered(), 'leg 1: no prompt opened that the walk did not expect').toBe(0);
      await expectRenderLoopAlive(page, 'after leg 1');
      errs.assertNone('leg 1');
    } finally {
      prompts.stop();
    }
  });

  test('2: a board saved to A, an example loaded, Ctrl+S: the prompt, A unchanged', async ({ page }) => {
    test.setTimeout(150_000);
    const errs = watchPageErrors(page);
    const dir = mkdtempSync(join(tmpdir(), 'fabrico-e2e-90-save-after-example-'));
    const a = join(dir, 'a.fab');
    const c = join(dir, 'c.fab');
    const prompts = watchPrompts(page);
    try {
      await boot(page);
      await saveVia(page, prompts, a, 'leg 2, A');
      const hashA = hashOf(a);
      await loadDemoViaExamples(page);
      await expectRenderLoopAlive(page, 'leg 2, after the example');
      await ctrlSExpectingPrompt(page, prompts, c, 'leg 2, after the example');
      await waitForFile(c, 'leg 2: the host wrote the file picked', ANSWER_MS);
      console.log(`P90-WORK-07 leg-2 prompts=${prompts.opened()} unanswered=${prompts.unanswered()}`);
      expect(hashOf(a), 'leg 2: A is byte for byte unchanged').toBe(hashA);
      expect(prompts.unanswered(), 'leg 2: no prompt opened that the walk did not expect').toBe(0);
      await expectRenderLoopAlive(page, 'after leg 2');
      errs.assertNone('leg 2');
    } finally {
      prompts.stop();
    }
  });

  test('3: A opened and edited, the refused file opened: Unsaved stays, and Ctrl+S rewrites A, not the refused file', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errs = watchPageErrors(page);
    const dir = mkdtempSync(join(tmpdir(), 'fabrico-e2e-90-save-after-refused-'));
    const a = join(dir, 'a.fab');
    const refused = join(dir, 'refused.fab');
    writeFileSync(refused, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const hashRefused = hashOf(refused);
    const prompts = watchPrompts(page);
    try {
      await boot(page);
      await saveVia(page, prompts, a, 'leg 3, A');
      await openVia(page, prompts, a, 'leg 3, A opened');
      await armAndPlaceAt(page, 'Sink', 10, 12);
      await pollScene(page, (s) => s.nodes.length, { message: 'leg 3: the Sink folded on A\'s board' }).toBe(DEMO_NODE_COUNT + 1);
      await expect(page.getByText(UNSAVED, { exact: true }), 'leg 3: the edit shows the Unsaved badge').toHaveCount(1);

      prompts.answerWith(refused);
      await page.getByTitle('Load a saved factory').click();
      // The board is unsaved, so the Open asks first (SAVE-05); Discard goes on to the file
      // prompt. The edit is lost only if the Load swaps, and this file is refused.
      const discard = page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' });
      await expect(discard, 'leg 3: the unsaved board opens the discard guard before the Open').toBeVisible();
      await discard.click();
      await expect(page.getByRole('alert'), 'leg 3: the host refused the file and the card is up').toHaveCount(1, { timeout: ANSWER_MS });
      await expect.poll(() => readout(page), { timeout: 15_000, message: 'leg 3: the strip reads Load failed' }).toBe(LOAD_FAILED);
      await expect(
        page.getByText(UNSAVED, { exact: true }),
        'leg 3: after the refused Load the board\'s edit is still unsaved, and says so',
      ).toHaveCount(1);
      await page.getByRole('button', { name: 'Close' }).click();
      await expect(page.getByRole('alert'), 'leg 3: Close takes the card away').toHaveCount(0);

      const prompted = prompts.opened();
      const mtimeA = statSync(a).mtimeMs;
      await page.keyboard.press('Control+s');
      await expect
        .poll(() => statSync(a).mtimeMs, {
          timeout: ANSWER_MS,
          intervals: [200, 500, 1000],
          message: 'leg 3: Ctrl+S rewrote A, the board\'s own file',
        })
        .toBeGreaterThan(mtimeA);
      console.log(
        `P90-WORK-07 leg-3 prompts_before=${prompted} prompts_after=${prompts.opened()} refused_hash_same=${hashOf(refused) === hashRefused}`,
      );
      expect(prompts.opened(), 'leg 3: Ctrl+S opened no prompt (the board has its own file)').toBe(prompted);
      expect(hashOf(refused), 'leg 3: the refused file is byte for byte unchanged').toBe(hashRefused);
      await expectRenderLoopAlive(page, 'after leg 3');
      errs.assertNone('leg 3');
    } finally {
      prompts.stop();
    }
  });
});
