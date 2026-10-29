import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type Harness,
  type InjectNode,
  waitForBoard,
} from './support/wire';

// quit-guard.spec.ts (SAFE-03 / SAVE-05) - the confirm-before-discard guard
// proven at the UI edge, mirroring delete-guard.spec.ts. It covers BOTH the
// shipped Quit guard AND the SAVE-05 New/Open discard guard, since both are the
// ONE generalized QuitGuardDialog parameterized by action.
//
// SCOPE (Chromium):
//   Quit: the QuitGuardDialog DISCIPLINE (the same .fab-dialog alertdialog
//   contract as the delete guard) and the DIRTY-ONLY GATE (the guard opens only
//   when the board is dirty; a clean/just-saved board would quit with no nag). It
//   drives the guard through window.__fabrico.requestQuit(), which runs the
//   IDENTICAL dirty-only decision the real Tauri onCloseRequested handler runs,
//   returning true (intercepted, = event.preventDefault()) only when dirty. The
//   REAL Tauri onCloseRequested + getCurrentWindow().destroy() ("Quit anyway")
//   path runs in the real WebKitGTK binary (Playwright-WebKit is not run in this suite) and is
//   a FEEL-KIT item; it cannot be exercised in Chromium (no Tauri runtime).
//
//   New/Open (SAVE-05): a dirty New or Open opens the 3-choice discard guard
//   (Cancel / Discard / Save) BEFORE any board swap or native dialog; a clean
//   board proceeds silently. The three routes each dispatch the expected control
//   (observed via the mock's control-frame capture), and the open guard suppresses
//   canvas shortcuts (CR-01) exactly as the quit guard does. The native Open dialog
//   itself is real-binary only (Chromium takes the window.prompt fallback, stubbed
//   here). The dirty transition is unit-proven in dirtyState.test.ts.

/** A SOURCE at (12,8) with its catalog Out port — the boot-keyframe scene. */
const MACHINE: InjectNode = {
  id: 1,
  kind: 0,
  cell_x: 12,
  cell_y: 8,
  ports: [{ index: 0, cell_x: 12, cell_y: 8, side: 1, role: 1 }],
};

/** A second machine placed via a DIFF packet — a genuine structural edit (a NEW
 *  node id absent from the prior scene) → isStructuralEdit true → dirty. */
const NEW_MACHINE: InjectNode = { id: 2, kind: 0, cell_x: 14, cell_y: 8 };

/** The fixed path the stubbed window.prompt returns for Save/Open in the dev
 *  (Chromium) fallback, so a Save-As / Open dispatches a deterministic control
 *  frame without opening a native dialog. */
const PROMPT_PATH = '/tmp/x.fab';

/**
 * Boot the app under the mock render socket, suppress the first-run welcome card
 * (set-flag-before-navigation, the v5.0 live-spec lesson) so it never overlaps the
 * assertions, and inject a full-keyframe scene with one machine. The board is
 * CLEAN after a boot keyframe (a full keyframe is never counted as a user edit).
 *
 * `opts.stubPrompt` installs a window.prompt override (returning PROMPT_PATH and
 * counting calls on window.__promptCalls) BEFORE navigation, so the SAVE-05
 * Save/Open routes dispatch a deterministic control frame and a spec can assert
 * the native dialog was NOT reached while a guard is open.
 *
 * `opts.cancelPrompt` makes that same stub return `null` (still counting calls),
 * modelling the user CANCELLING the Save-As / Open dialog. BL-01 uses it to prove
 * a cancelled Save from inside the discard guard does NOT discard the board.
 */
async function boot(
  page: Page,
  opts: { stubPrompt?: boolean; cancelPrompt?: boolean } = {},
): Promise<Harness> {
  const h = await mockRenderSocket(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('fab.onboarding.seen.v1', '1');
    } catch {
      // locked-down webview: the card is a soft overlay, harmless if it shows.
    }
  });
  if (opts.stubPrompt) {
    await page.addInitScript(
      (args: { path: string; cancel: boolean }) => {
        (window as unknown as { __promptCalls: number }).__promptCalls = 0;
        window.prompt = (): string | null => {
          (window as unknown as { __promptCalls: number }).__promptCalls += 1;
          // BL-01: a cancelled dialog returns null (falsy path -> onSave resolves
          // false -> the discard guard must NOT proceed to swap the board).
          return args.cancel ? null : args.path;
        };
      },
      { path: PROMPT_PATH, cancel: opts.cancelPrompt ?? false },
    );
  }
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [MACHINE] })); // full keyframe boot
  await waitForBoard(page, { machines: 1 });
  return h;
}

/** How many times the stubbed window.prompt has been called (native-dialog proxy). */
function promptCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __promptCalls?: number }).__promptCalls ?? 0,
  );
}

/** The discard guard's in-panel Save/Discard/Cancel button (scoped so the toolbar
 *  Save button never ambiguates the locator). */
function guardButton(page: Page, name: 'Cancel' | 'Discard' | 'Save') {
  return page.locator('.fab-dialog-panel').getByRole('button', { name });
}

/** Run the dirty-only quit decision; returns whether it intercepted (dirty). */
function requestQuit(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__fabrico!.requestQuit());
}

/** Dirty the board with a genuine structural edit (a NEW node on a diff packet). */
async function makeDirty(page: Page, h: Harness): Promise<void> {
  h.inject(buildPacket({ nodes: [NEW_MACHINE], full: false, tick: 2 }));
  await waitForBoard(page, { machines: 2 });
}

test.describe('Warn-on-quit only fires with unsaved changes (SAFE-03, dirty-only gate)', () => {
  test('a CLEAN board would quit with no dialog (requestQuit returns false)', async ({
    page,
  }) => {
    await boot(page);

    // A fresh boot keyframe left the board clean — the close decision does NOT
    // intercept and no dialog appears.
    expect(await requestQuit(page)).toBe(false);
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
  });

  test('a DIRTY board intercepts the close and opens the quit alertdialog', async ({
    page,
  }) => {
    const h = await boot(page);
    await makeDirty(page, h);

    // The structural edit dirtied the board — the close decision intercepts
    // (returns true, = event.preventDefault()) and the guard appears.
    expect(await requestQuit(page)).toBe(true);
    await expect(page.locator('.fab-dialog-panel')).toBeVisible();
    await expect(page.locator('.fab-dialog-panel')).toContainText(
      'Quit with unsaved changes?',
    );
  });

  test('a just-loaded-demo board is clean again: the guard no longer fires', async ({
    page,
  }) => {
    const h = await boot(page);
    await makeDirty(page, h);
    expect(await requestQuit(page)).toBe(true);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();

    // Load the demo scene through the Examples popover (EX-02): the CTA is now
    // a disclosure trigger; the shipped entry name is unchanged inside it. On
    // this DIRTY board the entry opens the 'example' discard guard first
    // (UI-SPEC A3 — the demo load deliberately gained the guard); Discard
    // proceeds with the load, which clears dirty (SAFE-03). The quit guard must
    // then stay silent — a just-loaded board must not nag.
    await page.getByRole('button', { name: 'Examples' }).click();
    await page.getByRole('button', { name: 'Load demo scene' }).click();
    await expect(page.locator('.fab-dialog-panel')).toContainText('Load an example?');
    await guardButton(page, 'Discard').click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    expect(await requestQuit(page)).toBe(false);
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
  });
});

test.describe('CR-01: the open quit guard suppresses canvas keyboard shortcuts', () => {
  test('no Rotate/Delete/Play command fires from behind the open quit dialog', async ({
    page,
  }) => {
    const h = await boot(page);
    await makeDirty(page, h);

    // Select the machine so a Rotate/Delete would have a LIVE target behind the
    // modal (the selection is deliberately NOT cleared when the dialog opens).
    const at = await screenCellCentre(page, MACHINE.cell_x, MACHINE.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();

    // Open the quit guard (dirty board intercepts the close).
    expect(await requestQuit(page)).toBe(true);
    await expect(page.locator('.fab-dialog-panel')).toBeVisible();
    await expect(page.locator('.fab-dialog-panel')).toBeFocused();

    const sentBefore = h.sent.length;
    // While the quit guard owns the interaction, the global canvas shortcuts must
    // be FULLY suppressed - not just Escape/Tab. Before the CR-01 fix, `r` emitted
    // a Rotate GridCommand and `Delete` routed a Delete against the live factory
    // from behind the modal; `Space` toggled play. All must now be no-ops.
    await page.keyboard.press('r');
    await page.keyboard.press('Delete');
    await page.keyboard.press(' ');
    await page.waitForTimeout(150);

    expect(
      h.sent.length,
      'no GridCommand may be emitted from behind the open quit guard',
    ).toBe(sentBefore);
    // No second (delete) guard was stacked; the quit dialog is still the only one.
    await expect(page.locator('.fab-dialog-panel')).toHaveCount(1);
    await expect(page.locator('.fab-dialog-panel')).toContainText(
      'Quit with unsaved changes?',
    );
  });
});

test.describe('The quit dialog copies the DeleteGuardDialog alertdialog discipline', () => {
  async function openQuitGuard(page: Page): Promise<void> {
    const h = await boot(page);
    await makeDirty(page, h);
    expect(await requestQuit(page)).toBe(true);
    await expect(page.locator('.fab-dialog-panel')).toBeVisible();
    // Await the focus-into-panel effect so the sibling [open] effects (the Esc /
    // Tab-trap keydown listener) have also flushed before any key is driven —
    // otherwise an immediate Escape/Tab can race the listener attach.
    await expect(page.locator('.fab-dialog-panel')).toBeFocused();
  }

  test('it is a role=alertdialog with an aria-described data-loss warning', async ({
    page,
  }) => {
    await openQuitGuard(page);
    const panel = page.locator('.fab-dialog-panel');
    await expect(panel).toHaveAttribute('role', 'alertdialog');
    await expect(panel).toHaveAttribute('aria-modal', 'true');
    // LW-01: the aria ids are action-scoped so co-rendered guards never collide.
    await expect(panel).toHaveAttribute('aria-describedby', 'fab-guard-quit-desc');
    await expect(page.locator('#fab-guard-quit-desc')).toContainText(
      'they will be lost',
    );
  });

  test('opening moves focus INTO the panel (no destructive action pre-selected)', async ({
    page,
  }) => {
    await openQuitGuard(page);
    // Focus landed on the panel itself (tabIndex=-1), not on "Quit anyway" — an AT
    // user cannot reach the danger action without perceiving the warning.
    await expect(page.locator('.fab-dialog-panel')).toBeFocused();
  });

  test('Tab is trapped within the dialog (Cancel first, "Quit anyway" danger last)', async ({
    page,
  }) => {
    await openQuitGuard(page);
    // Wait for the focus-into-panel effect to land before driving the trap, so the
    // wrap starts from the panel (active === panel), not a pre-focus body target.
    await expect(page.locator('.fab-dialog-panel')).toBeFocused();
    // Shift+Tab from the panel wraps to the LAST control (the danger button);
    // Tab from the last wraps to the FIRST (Cancel, the safe default). This also
    // pins the button ORDER: Cancel default first, danger last.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Quit anyway' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  });

  test('Esc = Cancel: the dialog closes and the window is NOT quit (still dirty)', async ({
    page,
  }) => {
    await openQuitGuard(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    // Cancel keeps the window and does NOT clear dirty — a re-request re-intercepts.
    expect(await requestQuit(page)).toBe(true);
  });

  test('scrim pointerdown = Cancel: the dialog closes', async ({ page }) => {
    await openQuitGuard(page);
    // Press on the scrim (never the panel) — the safe-default Cancel.
    await page.locator('.fab-dialog-scrim').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
  });

  test('"Quit anyway" always proceeds and dismisses the guard (CANNOT-STRAND)', async ({
    page,
  }) => {
    await openQuitGuard(page);
    // The danger action always proceeds to quit — in Chromium there is no Tauri
    // window to destroy, but the guard is dismissed unconditionally so the dirty
    // flag can never strand the user unable to quit (T-34-QUIT).
    await page.getByRole('button', { name: 'Quit anyway' }).click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// SAVE-05 discard guard: a dirty New / Open warns before discarding.
// ---------------------------------------------------------------------------

/** Dirty the board, click New, and await the 3-choice New discard guard. */
async function openNewGuard(page: Page, h: Harness): Promise<void> {
  await makeDirty(page, h);
  await page.getByRole('button', { name: 'New' }).click();
  const panel = page.locator('.fab-dialog-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Start a new board?');
  // Await the focus-into-panel effect so the sibling Esc/Tab listeners have flushed.
  await expect(panel).toBeFocused();
}

test.describe('SAVE-05: a dirty New/Open opens the 3-choice discard guard; a clean board is silent', () => {
  test('a dirty New opens the guard and dispatches NO new until a choice', async ({
    page,
  }) => {
    const h = await boot(page);
    await openNewGuard(page, h);

    // The guard is the 3-choice discard dialog: Cancel / Discard / Save (NOT the
    // 2-choice quit guard). No board swap ('new' control) fires until a choice.
    await expect(guardButton(page, 'Cancel')).toBeVisible();
    await expect(guardButton(page, 'Discard')).toBeVisible();
    await expect(guardButton(page, 'Save')).toBeVisible();
    await expect(page.locator('.fab-dialog-panel')).not.toContainText('Quit anyway');
    expect(h.controls, 'no board swap dispatched before a guard choice').not.toContain(
      'new',
    );
  });

  test('a dirty Open opens the guard BEFORE the native/prompt dialog', async ({
    page,
  }) => {
    const h = await boot(page, { stubPrompt: true });
    await makeDirty(page, h);
    await page.getByRole('button', { name: 'Load', exact: true }).click();

    const panel = page.locator('.fab-dialog-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Open another board?');
    // The guard intercepts BEFORE the Open dialog: the prompt was never reached and
    // no 'load' control was dispatched.
    expect(await promptCalls(page), 'the Open dialog must not open behind the guard').toBe(
      0,
    );
    expect(h.controls.some((c) => c.startsWith('load'))).toBe(false);
  });

  test('a CLEAN board proceeds on New with no guard', async ({ page }) => {
    const h = await boot(page); // fresh boot keyframe: clean
    await page.getByRole('button', { name: 'New' }).click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    await expect.poll(() => h.controls.includes('new')).toBe(true);
  });

  test('a CLEAN board proceeds on Open with no guard (native/prompt dialog opens)', async ({
    page,
  }) => {
    const h = await boot(page, { stubPrompt: true }); // clean
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    // A clean Open goes straight to the dialog: the prompt was reached and the load
    // dispatched with its path.
    await expect.poll(() => promptCalls(page)).toBe(1);
    await expect
      .poll(() => h.controls.some((c) => c.startsWith('load')))
      .toBe(true);
  });
});

test.describe('SAVE-05 discard-guard routes: Cancel keeps, Discard proceeds, Save saves-then-proceeds', () => {
  test('Cancel changes nothing (no swap, board stays dirty)', async ({ page }) => {
    const h = await boot(page);
    await openNewGuard(page, h);
    await guardButton(page, 'Cancel').click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    // Nothing dispatched; the Unsaved badge is still up (the board stayed dirty).
    expect(h.controls).not.toContain('new');
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
  });

  test('Discard proceeds losing edits (dispatches new)', async ({ page }) => {
    const h = await boot(page);
    await openNewGuard(page, h);
    await guardButton(page, 'Discard').click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    await expect.poll(() => h.controls.includes('new')).toBe(true);
  });

  test('Save saves-then-proceeds (dispatches save THEN new)', async ({ page }) => {
    const h = await boot(page, { stubPrompt: true });
    await openNewGuard(page, h);
    await guardButton(page, 'Save').click();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    // The Save-then-proceed order: the Save frame is dispatched, then the pending
    // New swap. The save clears dirty (honest ceiling), then the board swaps empty.
    await expect.poll(() => h.controls.includes('new')).toBe(true);
    const saveIdx = h.controls.findIndex((c) => c.startsWith('save'));
    const newIdx = h.controls.indexOf('new');
    expect(saveIdx, 'a save frame was dispatched').toBeGreaterThanOrEqual(0);
    expect(saveIdx, 'save was dispatched BEFORE the swap').toBeLessThan(newIdx);
  });
});

test.describe('BL-01: a CANCELLED Save from the discard guard must NOT discard the board', () => {
  test('New guard -> Save -> cancel the save dialog: the board is kept, no swap, not stranded', async ({
    page,
  }) => {
    // The never-saved-board case (the milestone done-test builds from empty): a
    // dirty New opens the guard, the user picks Save, then CANCELS the Save-As
    // dialog. Before the fix, onSave resolved and the guard's Save-then-proceed ran
    // the New swap unconditionally, discarding the unsaved factory. It must now keep
    // the board: no 'save' and no 'new' dispatched, the Unsaved badge stays, and the
    // guard stays open so the user can re-decide (not stranded, not silently lost).
    const h = await boot(page, { stubPrompt: true, cancelPrompt: true });
    await openNewGuard(page, h);

    await guardButton(page, 'Save').click();

    // The Save-As dialog was reached (the prompt fired) but the user cancelled it.
    await expect.poll(() => promptCalls(page)).toBe(1);
    // Give any (incorrect) proceed a chance to fire before asserting it did NOT.
    await page.waitForTimeout(150);

    // No board swap: the unsaved factory is intact.
    expect(h.controls, 'a cancelled Save must not swap the board').not.toContain('new');
    // No save frame was dispatched (the dialog was cancelled before any dispatch).
    expect(
      h.controls.some((c) => c.startsWith('save')),
      'a cancelled Save dispatches no save frame',
    ).toBe(false);
    // The board is still dirty (the Unsaved badge persists) and the guard stays open
    // so the user is neither stranded nor silently losing work.
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
    await expect(page.locator('.fab-dialog-panel')).toBeVisible();
    await expect(page.locator('.fab-dialog-panel')).toContainText('Start a new board?');
  });

  test('Open guard -> Save -> cancel the save dialog: no load swap, board kept', async ({
    page,
  }) => {
    // Same invariant on the Open route: a dirty Open opens the guard, the user picks
    // Save then cancels. The pending Open must NOT run (no 'load' dispatched), the
    // board stays dirty, and the guard stays open.
    const h = await boot(page, { stubPrompt: true, cancelPrompt: true });
    await makeDirty(page, h);
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    const panel = page.locator('.fab-dialog-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Open another board?');
    await expect(panel).toBeFocused();

    // The prompt count so far is the guard Save (below) only; the Open dialog itself
    // must never have opened behind the guard.
    const before = await promptCalls(page);
    await guardButton(page, 'Save').click();

    // The guard Save reached the Save-As dialog (prompt fired once more), cancelled.
    await expect.poll(() => promptCalls(page)).toBe(before + 1);
    await page.waitForTimeout(150);

    // No load swap and no save frame: the current board is intact.
    expect(h.controls.some((c) => c.startsWith('load')), 'no load swap on a cancelled Save').toBe(
      false,
    );
    expect(h.controls.some((c) => c.startsWith('save'))).toBe(false);
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();
    await expect(panel).toBeVisible();
  });
});

test.describe('CR-01: the open discard guard suppresses canvas keyboard shortcuts', () => {
  test('no Rotate/Delete/Play command fires from behind the open New guard', async ({
    page,
  }) => {
    const h = await boot(page);
    await makeDirty(page, h);

    // Select the machine so a Rotate/Delete would have a LIVE target behind the modal.
    const at = await screenCellCentre(page, MACHINE.cell_x, MACHINE.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();

    // Open the New discard guard via Ctrl+N (the selection mounts the ConfigPanel,
    // which overlays the toolbar New button; the keyboard path also proves Ctrl+N
    // routes through the dirty-guarded doNew). Ctrl+N is NOT suppressed here because
    // no guard is open YET when it fires.
    await page.keyboard.press('Control+n');
    await expect(page.locator('.fab-dialog-panel')).toBeVisible();
    await expect(page.locator('.fab-dialog-panel')).toContainText('Start a new board?');
    await expect(page.locator('.fab-dialog-panel')).toBeFocused();

    const sentBefore = h.sent.length;
    await page.keyboard.press('r');
    await page.keyboard.press('Delete');
    await page.keyboard.press(' ');
    await page.waitForTimeout(150);

    expect(
      h.sent.length,
      'no GridCommand may be emitted from behind the open discard guard',
    ).toBe(sentBefore);
    // No delete guard stacked; the discard dialog is still the only one and no swap.
    await expect(page.locator('.fab-dialog-panel')).toHaveCount(1);
    expect(h.controls).not.toContain('new');
  });
});

// ---------------------------------------------------------------------------
// EX-02: the Examples popover — open/close paths + the A3 'example' guard on
// BOTH entries (real click path; the node vitest covers the pure halves).
// ---------------------------------------------------------------------------

test.describe('EX-02: the Examples popover open/close paths and the example guard', () => {
  const trigger = (page: Page) => page.getByRole('button', { name: 'Examples' });
  const popover = (page: Page) => page.locator('#fab-examples-popover');

  test('the CTA opens the popover with an entry per scene; focus lands on entry 1', async ({
    page,
  }) => {
    await boot(page);
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await trigger(page).click();
    await expect(popover(page)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    // One entry per shipped scene, in DOM order, with the verbatim names.
    const entries = popover(page).getByRole('button');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toHaveText('Load demo scene');
    await expect(entries.nth(1)).toHaveText('Load order processing');
    await expect(entries.nth(2)).toHaveText('Load advanced pipeline');
    // Focus moved to entry 1 on open (UI-SPEC section 2).
    await expect(entries.nth(0)).toBeFocused();
  });

  test('Escape closes the popover and returns focus to the trigger', async ({
    page,
  }) => {
    await boot(page);
    await trigger(page).click();
    await expect(popover(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  test('an outside click closes the popover; re-toggling the CTA closes it too', async ({
    page,
  }) => {
    await boot(page);
    await trigger(page).click();
    await expect(popover(page)).toBeVisible();
    // Click the canvas area well below the toolbar — outside the popover.
    await page.mouse.click(200, 400);
    await expect(popover(page)).toBeHidden();
    // The trigger itself toggles: open, then close, without the outside-click
    // capture listener swallowing the toggle.
    await trigger(page).click();
    await expect(popover(page)).toBeVisible();
    await trigger(page).click();
    await expect(popover(page)).toBeHidden();
  });

  test('a CLEAN board loads immediately on select: popover closes, control dispatched, no guard', async ({
    page,
  }) => {
    const h = await boot(page);
    await trigger(page).click();
    await page.getByRole('button', { name: 'Load order processing' }).click();
    await expect(popover(page)).toBeHidden();
    await expect(page.locator('.fab-dialog-panel')).toBeHidden();
    // ONE parameterized verb for scene loads (the wire id is typed end-to-end).
    await expect
      .poll(() => h.controls.includes('load_example\norder_processing'))
      .toBe(true);
    // The scene badge generalizes: the loaded example is named.
    await expect(page.getByText('Order processing', { exact: true })).toBeVisible();
  });

  test('a DIRTY board guards BOTH entries with the example copy; Cancel drops the pending load', async ({
    page,
  }) => {
    const h = await boot(page);
    await makeDirty(page, h);

    // Entry 2 (order processing) on a dirty board: the 'example' guard opens
    // BEFORE anything is issued; Cancel keeps the board and dispatches nothing.
    await trigger(page).click();
    await page.getByRole('button', { name: 'Load order processing' }).click();
    const panel = page.locator('.fab-dialog-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Load an example?');
    await expect(panel).toContainText(
      'You have edits that have not been saved. If you load an example now, they will be lost.',
    );
    // 3-choice discard shape (Cancel / Discard / Save), never the quit pair.
    await expect(guardButton(page, 'Discard')).toBeVisible();
    await expect(guardButton(page, 'Save')).toBeVisible();
    await expect(panel).not.toContainText('Quit anyway');
    await guardButton(page, 'Cancel').click();
    await expect(panel).toBeHidden();
    expect(
      h.controls.some((c) => c.startsWith('load_example')),
      'Cancel drops the pending scene id — nothing issued',
    ).toBe(false);
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();

    // Entry 1 (the demo) is guarded EQUALLY (A3 closes the silent-discard
    // hole); Discard proceeds and the parameterized demo load dispatches.
    await trigger(page).click();
    await page.getByRole('button', { name: 'Load demo scene' }).click();
    await expect(panel).toContainText('Load an example?');
    await guardButton(page, 'Discard').click();
    await expect
      .poll(() => h.controls.includes('load_example\ndemo_scene'))
      .toBe(true);
  });
});

test.describe('SAVE-05: the Unsaved badge tracks the dirty transition', () => {
  test('the badge (role=status) is present while dirty and clears after Save', async ({
    page,
  }) => {
    const h = await boot(page, { stubPrompt: true });
    // Clean boot: no badge.
    await expect(page.getByText('Unsaved', { exact: true })).toBeHidden();

    await makeDirty(page, h);
    const badge = page.getByText('Unsaved', { exact: true });
    await expect(badge).toBeVisible();
    // It is a passive aria-live readout (not the build accent, not an affordance).
    await expect(badge).toHaveAttribute('role', 'status');
    await expect(badge).toHaveAttribute('aria-live', 'polite');

    // A Save clears dirty (honest ceiling) - the badge disappears.
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
    await expect(page.getByText('Unsaved', { exact: true })).toBeHidden();
  });
});
