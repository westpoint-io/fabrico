import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  armAndPlaceFactoryAt,
  DEMO_NODE_COUNT,
  expectRenderLoopAlive,
  watchPageErrors,
  loadDemoViaExamples,
  pollScene,
  readScene,
  resetToDemo,
  waitForAppReady,
  waitForEditVerdicts,
} from './support/oracle';

/**
 * Poll the accessible status readout's text. The role="status" span always
 * renders (empty when idle), so this reads the LIVE announced copy the user
 * (and a screen reader) sees - never an injected value.
 */
function pollStatusText(page: Page, message: string) {
  return expect.poll(
    async () => ((await page.getByRole('status').textContent()) ?? '').trim(),
    { timeout: 15_000, intervals: [100, 250, 500], message },
  );
}

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
// Task 1 SPIKE: empirically CONFIRM the load-resolution signal against a live
// repopulating load BEFORE Task 2/3 wire against it (RESEARCH Assumption A2,
// MEDIUM confidence; Pitfall 4). The confirmed rule Task 2 implements is:
// "resolve on the FIRST packet.full keyframe after dispatch" - and live tick
// deltas BETWEEN dispatch and that keyframe must NOT falsely resolve.
//
// We cannot read `packet.full` directly from the page (no such hook, and adding
// one would be scope creep), so we use the OBSERVABLE PROXY the round-trip gate
// (02) already trusts: a repopulating full keyframe RE-SEEDS the loop tick from
// the loaded core (install_swapped_host: `self.tick = self.host.core().tick`),
// so the live tick DROPS below the pre-dispatch tick exactly when - and only
// when - the swap keyframe folds. Intermediate diff packets only RAISE the
// tick, so they can never produce that drop: this is the falsifiable proof that
// tick deltas do NOT falsely mark completion (Pitfall 4). LoadDemo is the
// sanctioned repopulating proxy (same host-swap + producer.reset path as a file
// Load); Task 3 exercises the real onLoad file round-trip end to end.
// ---------------------------------------------------------------------------

test.describe('SHELL-07 spike: the load-resolution signal is a real repopulating keyframe', () => {
  // RENDER HEALTH in every test (plan 85-08, THE RENDER-HEALTH COUNT;
  // fabrico-model-oracle-blindspot): the watcher goes in BEFORE `page.goto`, and the loop
  // and the watcher are read after every test.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the test');
    errs.assertNone('the load-resolution spike');
  });

  test('a repopulating load folds a full keyframe (tick restart); tick deltas alone never do', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // The live host has ticked since the 01 spec, so the pre-dispatch tick is
    // large. Capture it: the ONLY way the tick reads BELOW this later is a
    // repopulating full keyframe re-seeding the loop tick (the signal); a plain
    // diff (a tick delta) always reads ABOVE it.
    const tickBefore = (await readScene(page)).tick;
    expect(tickBefore, 'the live sim has been ticking (a non-trivial pre-load tick)').toBeGreaterThan(
      0,
    );

    // Falsifiable NON-resolution check (Pitfall 4): sample a few live diff
    // packets and confirm NONE of them drop the tick below tickBefore. A diff
    // packet is NOT a repopulate, so an implementation gating on "any packet"
    // would wrongly resolve here - this loop proves the tick-restart edge is
    // distinct from ordinary streaming.
    for (let i = 0; i < 3; i += 1) {
      const s = await readScene(page);
      expect(
        s.tick,
        'a live diff packet (tick delta) NEVER reads below the pre-load tick - only a repopulate does (Pitfall 4)',
      ).toBeGreaterThanOrEqual(tickBefore);
    }

    // Dispatch a repopulating load (the LoadDemo proxy: same host-swap +
    // producer.reset full-keyframe path a file Load takes).
    await loadDemoViaExamples(page);

    // The CONFIRMED signal: the first full keyframe after dispatch re-seeds the
    // tick, so it drops below tickBefore AND the demo baseline folds.
    // This can be true ONLY after the repopulating keyframe - never from an
    // intermediate tick delta.
    await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
      message:
        'the repopulating load folds a FULL keyframe: the loop tick restarts below the pre-load tick onto the demo baseline (the confirmed Loaded signal)',
    }).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 3: the honest status transitions, driven against the REAL app + host.
// Non-Tauri dev path -> Save/Load raise a browser prompt, handled here via
// page.once('dialog', ...). Nothing is injected: the signals are the real WS
// stream and (for the round trip) the real .fab artifact the host writes.
// ---------------------------------------------------------------------------

test.describe('SHELL-07 honest Save/Load status transitions (real app + host)', () => {
  // EVERY TEST STARTS ON A PLAYING HOST (plan 84-18, push 6). Until phase 90 a Save on the running
  // demo left the shared host Frozen until a Load, New or example, and the round trip below booted
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

  test('Save settles at the honest ceiling "Save requested" and NEVER claims a host-confirmed "Saved"', async ({
    page,
  }) => {
    const savePath = join(tmpdir(), `fabrico-e2e-save-${Date.now()}.fab`);
    // Accept the dev prompt with a real path; onSave dispatches 'save' fire-and-
    // forget and settles the status the instant the dispatch is confirmed.
    // SAVE-03: on a fresh board there is NO known path yet, so a plain Save still
    // falls to the prompt (smart-Save re-saves with no dialog only AFTER a path is
    // known). The native-dialog APPEARANCE (untitled.fab default + .fab filter) is
    // a real-WebKitGTK FEEL-KIT backstop, NOT asserted here: Chromium takes the
    // window.prompt fallback and never opens the native save() dialog.
    page.once('dialog', (d) => d.accept(savePath));
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();

    await pollStatusText(
      page,
      'the Save status settles to the dispatch-confirmed ceiling "Save requested"',
    ).toBe('Save requested');

    // The host sends NO write-result echo, so the status must never escalate to a
    // host-confirmed success claim. Sample the live readout across a short window
    // (well inside the auto-clear) and assert it never reads "Saved".
    for (let i = 0; i < 6; i += 1) {
      const t = ((await page.getByRole('status').textContent()) ?? '').trim();
      expect(
        t,
        'the honest ceiling holds: the Save status never claims a host-confirmed "Saved"',
      ).not.toBe('Saved');
    }
  });

  test('a REAL Save -> Load round trip resolves Loading -> Loaded on the repopulate keyframe', async ({
    page,
  }) => {
    const roundTripPath = join(tmpdir(), `fabrico-e2e-roundtrip-${Date.now()}.fab`);

    // (1) Save: the host writes the .fab once the scene drains to quiescence.
    // SAVE-03: fresh board -> no known path -> plain Save prompts (smart-Save is
    // the no-dialog re-save on a KNOWN path, exercised in the vitest unit + the
    // real WebKitGTK FEEL-KIT, not here).
    page.once('dialog', (d) => d.accept(roundTripPath));
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
    await pollStatusText(page, 'the round-trip Save is dispatch-confirmed').toBe('Save requested');

    // (2) Wait for the REAL artifact via the Node filesystem - honest proof the
    // host actually persisted it (not a frontend claim). A dot-file save is a
    // single postcard file (project.rs save_project -> std::fs::write).
    await expect
      .poll(() => existsSync(roundTripPath), {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: 'the host wrote the .fab project file at quiescence (real save artifact on disk)',
      })
      .toBe(true);

    // (3) Load it back: 'Loading…' on dispatch, resolving to 'Loaded' on the
    // FIRST packet.full keyframe after dispatch (the spike-confirmed signal -
    // producer.reset repopulates the scene). No host echo; observe-only.
    page.once('dialog', (d) => d.accept(roundTripPath));
    await page.getByTitle('Load a saved factory').click();
    await pollStatusText(
      page,
      'the Load resolves to "Loaded" when the scene repopulates (first packet.full after dispatch)',
    ).toBe('Loaded');

    // The scene oracle stays green throughout (no injected packets): the loaded
    // topology is readable and non-empty.
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the loaded scene repopulated with a real node topology (scene oracle green)',
    }).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// SAVE-04: the New verb yields a TRULY EMPTY grid via the dual-path host swap,
// driven over the REAL dev-WS transport (the same producer.reset full-keyframe
// path a Load takes). Extends this existing spec (no new live-spec file) to stay
// under the ~11-spec dev_render_server stall ceiling. Budgets ONE extra host
// swap and restores the shared demo baseline at the end so downstream specs are
// unpolluted (the workers:1 shared-mutable-host discipline).
// ---------------------------------------------------------------------------

test.describe('SAVE-04 New yields a truly empty grid (real app + host)', () => {
  // RENDER HEALTH in every test (plan 85-08, THE RENDER-HEALTH COUNT;
  // fabrico-model-oracle-blindspot): the watcher goes in BEFORE `page.goto`, and the loop
  // and the watcher are read after every test.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the test');
    errs.assertNone('the New walk');
  });

  test('clicking New wipes the board to zero nodes, shows the EmptyState, and clears the Demo badge', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Establish a known NON-empty demo baseline so New has something to wipe and
    // the "Demo scene" badge is present before the New (the meaningful precondition).
    await resetToDemo(page);
    await expect(
      page.getByText('Demo scene', { exact: true }),
      'the Demo scene badge is present before New (demo baseline established)',
    ).toBeVisible();
    expect(
      (await readScene(page)).nodes.length,
      'the pre-New board is the non-empty demo topology',
    ).toBeGreaterThan(0);

    // Drive the New verb over the REAL transport (the shipped toolbar button →
    // sendControl('new') → dev-WS "new" frame → decode_control → ControlMsg::New).
    await page.getByTitle('New board (Ctrl+N)').click();

    // SAVE-04 core assertion: the host swap produced a genesis-EMPTY board.
    await pollScene(page, (s) => s.nodes.length === 0, {
      message: 'New swaps in a truly empty grid: window.__fabrico.scene().nodes.length === 0',
    }).toBe(true);

    // The shipped EmptyState guidance (machineCount===0 gate) is shown on the empty board.
    await expect(
      page.getByRole('heading', { name: 'Empty factory floor' }),
      'the EmptyState guidance shows once the board is empty (machineCount===0)',
    ).toBeVisible();

    // The Demo scene badge is cleared (New is NOT the demo — doNew setDemoLoaded(false)).
    await expect(
      page.getByText('Demo scene', { exact: true }),
      'the Demo scene badge is absent after New (this is not the demo)',
    ).toHaveCount(0);

    // Restore the shared mutable host to the demo baseline for downstream specs
    // (workers:1 shared-host discipline): from the empty board a Load-demo swap
    // repopulates the demo topology + 2 dormant wires (an unambiguous jump from 0 nodes).
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
      message: 'the shared host is restored to the demo baseline after the New check',
    }).toBe(true);
  });
});
