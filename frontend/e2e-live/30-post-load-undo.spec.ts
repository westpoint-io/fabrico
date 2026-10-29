import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  clickAt,
  demoCallerAndHandler,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
} from './support/oracle';

// 30-post-load-undo.spec.ts (UNDO-07, plan 73-07) - the LIVE proof, on the real host and
// through the real Save/Load round trip, that an edit made BEFORE a save can be undone
// AFTER the file is reopened, with nothing written across the top of the screen.
//
// ──────────────── WHY THIS SPEC HAS TO GO THROUGH A REAL FILE ────────────────
//
// The requirement is about a board that was genuinely SAVED and REOPENED, and that is
// precisely the board a test harness usually does not build. A spec that seeded a board
// in memory and pressed Ctrl+Z would prove nothing about UNDO-07 no matter how many
// assertions it carried: the defect lives in `GridSession::reconstruct_projection`, whose
// throwaway re-fold is only ever reached from the LOAD path, because `replay_two_logs` is
// the one path where the four live-authoritative override maps are empty by construction.
//
// So this spec drives the shipped toolbar Save, waits for the REAL `.fab` on disk through
// the Node filesystem (an honest artifact, not a frontend claim), drives the shipped
// toolbar Load, and only then presses Ctrl+Z. `dev_render_server` boots the demo scene,
// so the board under test is the board every user's first save and load lands in. (When
// plan 73-07 wrote this spec, that boot also minted four nodes outside the edit log, which
// is what the whole plan was about; the spec reads only the board, so it holds either way.)
//
// ─────────────── SAVE AND LOAD ARE TOOLBAR BUTTONS HERE, ON PURPOSE ───────────────
//
// `frontend/src/input/gestures.ts` DOES bind document-level Ctrl/Cmd+S, +N and +O (see
// its LW-02 block at :2971, which handles them ABOVE the BUTTON focus guard so a toolbar
// button's own advertised shortcut is not dead). Plan 73-07's ruling R-36 states the
// opposite, and R-36 is wrong on that point of fact; it is right about what this spec
// should do. The toolbar-plus-prompt idiom is what `09-save-load-status.spec.ts` already
// uses for the same round trip, and reusing it means this spec exercises the path a user
// actually clicks rather than a second mechanism invented here.
//
// The Ctrl+Z under test is real, though, and it is subject to the SAME LW-02 guard: a
// focused BUTTON stands the canvas keybindings down, and clicking Load leaves focus on
// the Load button. The empty-cell click before the keypress is therefore load-bearing,
// not tidying - without it the keypress is swallowed and this spec fails for a reason
// that has nothing to do with the undo.
//
// ───────────────────────── THE SILENCE HALF IS LATCHED ─────────────────────────
//
// `#fab-refusal` is EMPTY AT REST and `REFUSAL_HOLD_MS` is 4000, so a single read after
// the keypress can only FAIL if it happens to land inside a four-second window it is not
// scheduled against, and an empty reading is equally satisfied by a build where Ctrl+Z
// did nothing at all. `expectRefusalStayedSilent` polls from BEFORE the keypress until
// the positive board assertion resolves and latches the first non-empty reading it ever
// sees, so the silence is only ever reported alongside a board that measurably changed.
//
// The absence is scoped to THIS gesture, not globally. UI-SPEC's E2 error consideration
// names the one place a refusal sentence is still correct after this phase - a refused
// `RemovePort` on the existing ERR-01 verdict path - so a spec written as "no refusal
// ever" would forbid a behaviour that is right.
//
// ────────────────────── AND IT ASSERTS THE RENDER LOOP IS ALIVE ──────────────────────
//
// `readScene` reads `window.__fabrico.scene()`, the packet-application buffer, which is
// completely independent of the Pixi ticker. A board that loads and undoes perfectly
// behind a DEAD canvas passes every node assertion below. That is this repository's
// recorded blind spot rather than a hypothesis, so `watchPageErrors` runs for the whole
// test and `expectRenderLoopAlive` runs after each phase rather than once at the end.

/**
 * Where the pre-save Sink goes. Well clear of the demo scene (rows 0..8 when 85-07
 * measured it, its caller and handler included) and of the long belt corridor, so the
 * placement is a plain free-cell drop.
 * If it were ever occupied the placement would be refused and the node-count assertion
 * below would fail loudly rather than the spec passing on a board it never changed.
 */
const SINK_CELL: [number, number] = [10, 12];

/**
 * An empty cell used ONLY to move focus off a toolbar button before the accelerator.
 * Clicking bare canvas is what a human does between pressing a button and using a
 * keyboard shortcut, and it is what blurs the button so the LW-02 guard stands down.
 */
const BLUR_CELL: [number, number] = [2, 14];
/** The status strip's readout, where `Loaded` shows once the swap's keyframe folds. */
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';

/** Click an empty cell to blur whatever toolbar button currently holds focus. */
async function blurToolbarFocus(page: import('@playwright/test').Page): Promise<void> {
  const pt = await screenCellCentre(page, BLUR_CELL[0], BLUR_CELL[1]);
  await clickAt(page, pt.x, pt.y);
}

test.describe('UNDO-07: an edit made before a save is undoable after the file is reopened', () => {
  test('a_pre_save_edit_is_undone_after_a_reload, with the refusal region silent throughout', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    const fab = join(tmpdir(), `fabrico-e2e-post-load-undo-${Date.now()}.fab`);

    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await waitForCameraSettle(page);
    errs.assertNone('after the demo boot');
    await expectRenderLoopAlive(page, 'on the shipped demo board');

    // ── 1. THE PRE-SAVE EDIT, on the board the app boots into ──
    //
    // The node count is read off the board rather than written down, so the assertions
    // below compare against what the running host actually had rather than against a
    // literal that could drift from the shipped scene.
    const beforePlace = (await readScene(page)).nodes.length;
    expect(beforePlace, 'the demo baseline is on the board before the edit').toBe(
      DEMO_NODE_COUNT,
    );

    await armAndPlaceAt(page, 'Sink', SINK_CELL[0], SINK_CELL[1]);
    await pollScene(page, (s) => s.nodes.length, {
      message:
        'the Sink placement folded on the live host (a refused placement would leave the ' +
        'count unchanged and fail here rather than passing on an unedited board)',
    }).toBe(beforePlace + 1);
    const afterPlace = (await readScene(page)).nodes.length;
    await expectRenderLoopAlive(page, 'after the pre-save placement');
    errs.assertNone('after the pre-save placement');

    // ── 2. SAVE, THROUGH THE SHIPPED TOOLBAR BUTTON AND ITS PATH PROMPT ──
    //
    // The non-Tauri dev path raises a browser prompt, handled with `page.once('dialog')`
    // exactly as `09-save-load-status.spec.ts` does. On a fresh board there is no known
    // path yet, so a plain Save still prompts (smart-Save re-saves with no dialog only
    // after a path is known).
    page.once('dialog', (d) => d.accept(fab));
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();

    // The host writes the file at quiescence, so the honest wait is on the REAL artifact
    // through the Node filesystem rather than on any frontend status claim.
    await expect
      .poll(() => existsSync(fab), {
        timeout: 45_000,
        intervals: [200, 500, 1000],
        message: 'the host wrote the .fab at quiescence (a real save artifact on disk)',
      })
      .toBe(true);
    errs.assertNone('after the save');

    // ── 3. REOPEN THE SAME FILE, THROUGH THE SHIPPED LOAD BUTTON ──
    //
    // This is the step that makes the spec worth writing. Everything after it runs
    // against a host built by `load_project` -> `Host::recover` ->
    // the host's two-log replay, which is the EXEMPT path where the four live override
    // maps are empty, so the undo projection is rebuilt from the saved file alone.
    //
    // THE WAIT IS ON THE SWAP ITSELF (plan 90-02). The reopened board has the same node count
    // as the board the Load replaces, so a count poll alone is true BEFORE the swap. Until
    // phase 90 the Save left the host Frozen, the Load took the immediate arm and swapped at
    // once, so the count poll happened to land after it. Since D-08 a Save on a running board
    // runs on, so the Load on a busy board drains first, and a Ctrl+Z sent inside that drain
    // reached the board the swap then discarded (measured: `Expected: 20`, `Received: 21`).
    // So the walk waits for the status strip's `Loaded`, which the page resolves on the swap's
    // own full keyframe (`09-save-load-status.spec.ts`), and then for the count.
    page.once('dialog', (d) => d.accept(fab));
    await page.getByTitle('Load a saved factory').click();
    await expect
      .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
        timeout: 45_000,
        intervals: [50, 100, 250],
        message: 'the reopen swapped the board: the status strip reads Loaded (the swap keyframe folded)',
      })
      .toBe('Loaded');
    await pollScene(page, (s) => s.nodes.length, {
      message:
        'the reopened board carries the demo topology PLUS the pre-save Sink (the load ' +
        'repopulated from the real .fab)',
    }).toBe(afterPlace);
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, 'on the reopened board');
    errs.assertNone('after the reopen');

    // Focus is on the Load button and LW-02 stands the canvas keybindings down while a
    // BUTTON holds focus, so the accelerator below would be swallowed without this.
    await blurToolbarFocus(page);

    // ── 4. CTRL+Z, WITH THE REFUSAL REGION LATCHED ACROSS THE WHOLE WINDOW ──
    //
    // The keypress AND the positive assertion both live inside `until`, so the poll is
    // already running when the key goes down and keeps running until the board has
    // measurably changed. A sentence that flashed for even one ladder step is latched.
    await expectRefusalStayedSilent(page, 'Ctrl+Z on a board that was saved and reopened', async () => {
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => s.nodes.length, {
        message:
          'UNDO-07: one Ctrl+Z on the reopened board undid the pre-save placement - ' +
          'until plan 73-07 this undo returned a typed refusal, restored nothing, and ' +
          'named no cause',
      }).toBe(beforePlace);
    });

    // ── 5. IT UNDID THE RIGHT THING, not merely something ──
    //
    // A bare count going back to 11 is also satisfied by an undo that deleted the WRONG
    // node and left the Sink standing, which is exactly the shape this defect had before
    // plan 51-05 turned it into a refusal: the misaligned harvest named one of the demo's
    // caller and handler nodes four allocator slots too early. So the Sink's own cell is
    // asserted empty AND the demo's caller and handler are asserted still present, found
    // by kind (`demoCallerAndHandler`, plan 85-07) with both legs of their cable.
    const after = await readScene(page);
    const sinkStillThere = after.nodes.some((n) =>
      n.cells.some(([x, y]) => x === SINK_CELL[0] && y === SINK_CELL[1]),
    );
    expect(
      sinkStillThere,
      'the machine the undo removed is the one that was PLACED, not a bystander',
    ).toBe(false);
    expect(
      after.wires.length,
      "and both legs of the shipped caller and handler's cable are still on the board - a wrong-node " +
        'delete would show up here as a missing cable leg',
    ).toBe(2);

    // The pair itself, BY KIND: the caller Route and the HTTP Handler its cable delivers
    // into both survived the undo (a wrong-node delete of either fails here by name).
    const pair = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'right after finding the demo pair by kind');
    expect(
      [pair.caller.kind, pair.handler.kind],
      'the demo caller Route and its HTTP Handler both survived the post-load undo',
    ).toEqual([9, 10]);

    await expectRenderLoopAlive(page, 'after the post-load undo');
    errs.assertNone('after the post-load undo');
  });
});
