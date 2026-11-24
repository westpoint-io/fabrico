import { test, expect } from './support/liveTest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  armAndPlaceFactoryAt,
  expectRenderLoopAlive,
  watchPageErrors,
  resetToDemo,
  waitForAppReady,
  waitForEditVerdicts,
} from './support/oracle';

// 09-save-load-status.spec.ts (SHELL-07) - the honest Save/Load feedback gate.
//
// The status readout is a role="status" aria-live="polite" node that observes
// ONLY the existing render stream (no host echo, no packet/command change):
//   - Load:  Loading… on dispatch -> Loaded when the scene REPOPULATES (the
//            first packet.full keyframe after dispatch - producer.reset in
//            install_swapped_host, sim_loop.rs:732). A dialog-cancel or a
//            timed-out load -> Load failed.
//   - Save:  the HONEST ceiling "Save requested" on dispatch (dispatch-confirmed
//            only; the host sends no write-result echo, so we NEVER claim a
//            host-confirmed "Saved"). There is no separate "Saving…" frame - it
//            was synchronously superseded and never rendered (IN-01). Dialog-
//            cancel -> idle (no announcement).
//
// Drive rules (locked, mirrors 01/02): page.mouse + getByTitle + the browser
// prompt dialog ONLY; every wait polls a SPECIFIC change via pollScene or the
// role=status text (no fixed sleeps); nothing is injected - the signal is what
// the REAL core produced.

// ---------------------------------------------------------------------------
// Task 3: the honest status transitions, driven against the REAL app + host.
// Non-Tauri dev path -> Save/Load raise a browser prompt, handled here via
// page.once('dialog', ...). Nothing is injected: the signals are the real WS
// stream and (for the round trip) the real .fab artifact the host writes.
// ---------------------------------------------------------------------------

test.describe('SHELL-07 honest Save/Load status transitions (real app + host)', () => {
  // EVERY TEST STARTS ON A PLAYING HOST (plan 84-18, push 6). Until phase 90 a Save on the running
  // demo left the shared host Frozen until a Load, New or example, and a round-trip test booted
  // onto the host the Save test before it left frozen: the page got one keyframe and then silence,
  // the stall watchdog wrote "Disconnected - live view frozen" 800 ms later over "Save requested",
  // and CI run 5 read it for the whole 15 s poll. Phase 90 (FAIL-04, D-08) made a Save on a
  // running board carry on running, so that cause is gone; the isolation stays because the host is
  // shared and any earlier spec may leave it on another board. The demo load resumes a host the
  // user did not pause; the reload then gives each test a fresh page, on a flowing stream, with no
  // status left on the strip by the load itself (the cancelled-Load test reads the strip empty).
  // RENDER HEALTH in every test (plan 85-08, THE RENDER-HEALTH COUNT;
  // fabrico-model-oracle-blindspot): the watcher goes in BEFORE `page.goto`, and the loop
  // and the watcher are read after every test.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await page.reload();
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the test');
    errs.assertNone('the Save and Load status walk');
  });

  test('a cancelled Load dialog is NOT reported as a failure (honest idle, no announcement)', async ({
    page,
  }) => {
    // WR-01: dismissing the prompt (falsy path) is a DELIBERATE cancel, not a
    // failure. onLoad dispatches NOTHING and emits `idle` (no announcement), so
    // the readout stays empty and must NEVER announce "Load failed". This is the
    // controlHandlers `if (path)` cancel branch live.
    page.once('dialog', (d) => d.dismiss());
    await page.getByTitle('Load a saved factory').click();
    // Sample the live readout across a short window: it stays empty (idle) and
    // never claims a failure for a deliberate cancel.
    for (let i = 0; i < 6; i += 1) {
      const t = ((await page.getByRole('status').textContent()) ?? '').trim();
      expect(t, 'a deliberate Load cancel never announces "Load failed"').not.toBe('Load failed');
      expect(t, 'a deliberate Load cancel leaves the readout idle (empty)').toBe('');
    }
  });

  // Phase 90 review WR-A-03: a Save the host cannot write is no longer reported to no one. The
  // page clears the Unsaved badge when it sends the Save; the host now answers a failed write
  // with a `saveFailed` frame, and the strip says `Save failed` while the badge comes back. The
  // path is inside a folder that does not exist, so the host's write fails for real.
  test('a Save the host cannot write reads "Save failed" and the board reads Unsaved again', async ({
    page,
  }) => {
    const strip = page.locator('header [role="status"]').first();
    const unsaved = page.getByText('Unsaved', { exact: true });
    await armAndPlaceFactoryAt(page, 6, 11);
    await waitForEditVerdicts(page);
    await expect(unsaved, 'PRECONDITION: the placed Factory made the board unsaved').toHaveCount(1);

    const badPath = join(tmpdir(), `fabrico-e2e-no-such-folder-${Date.now()}`, 'board.fab');
    page.once('dialog', (d) => d.accept(badPath));
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
    await expect
      .poll(async () => ((await strip.textContent()) ?? '').trim(), {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'A FAILED SAVE IS SAID: the strip reads "Save failed" once the host answers',
      })
      .toBe('Save failed');
    await expect(unsaved, 'A FAILED SAVE LEAVES THE BOARD UNSAVED: the badge is back').toHaveCount(1);
    expect(existsSync(badPath), 'PRECONDITION: the host wrote nothing').toBe(false);
  });
});
