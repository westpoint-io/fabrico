import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expectRenderLoopAlive,
  readScene,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 29-load-refused-card.spec.ts (UNDO-09) - the file this build will not open now SAYS SO.
//
// # What is red on HEAD, and how "not the timeout path" is actually proved
// Before this plan the refusal reason terminated at an `eprintln!` on the sim thread
// (`crates/fabrico-host/src/sim_loop.rs`, the `Err(e)` arm of `load_swap`). The user
// clicked Open, nothing whatsoever happened, and a generic "Load failed" appeared much
// later on a timeout. So the first assertion below is red on HEAD because NOTHING is in
// the DOM at all.
//
// `09-save-load-status.spec.ts` records that today's copy resolves ONLY on that timeout
// with no repopulating keyframe, so an assertion a timeout-driven build could satisfy
// would certify nothing. THE PLAN ASKED FOR A ONE-SECOND WALL-CLOCK BUDGET AND THAT IS
// THE WRONG INSTRUMENT, measured rather than argued (deviation recorded in
// `73-04-SUMMARY.md`). A `Load` is LATCHED until the sim drains to quiescence, and that
// drain is bounded in TICKS, not milliseconds: `MAX_SETTLE_TICKS` is 512, which at the
// live ~62.5 t/s cadence is up to about 8 seconds. Measured on this board the refusal
// lands about 2.0 s after the dialog is accepted, but a slower drain is CORRECT
// behaviour, so a one-second budget would be asserting the drain length and calling it
// the refusal path.
//
// What actually distinguishes the two paths is asserted instead, two ways:
//   - THE SEMANTIC ONE (phase 90, UI-SPEC A9): the strip agrees with the card. The refusal
//     handler itself writes `Load failed` when the card goes up, so the readout reads it
//     within a second of the card. Until plan 90-04 this step asserted the opposite (the
//     strip had NOT reached `Load failed`), because then only the timeout wrote it.
//   - A MECHANICAL BACKSTOP: the card arrives strictly inside `STATUS_LOAD_TIMEOUT_MS`
//     (10 000 ms in `App.tsx`). Since plan 90-04 the page's cut-off fires only after that
//     long with NO packet, or after the host's settle budget in ticks, and a running board
//     sends a packet every tick, so an answer inside the window is the refusal's.
//
// # Which sentence is pinned, and why THAT one (ruling R-16, route (a))
// The spec writes bytes that fail layer-1 postcard decode, which produces
// `ProjectError::Malformed`, whose `Display` is
// `malformed project file (postcard decode failed).` The pinned clause is
// `postcard decode failed`.
//
// The choice is not arbitrary and route (a) was taken explicitly. This SAME plan rewords
// ten `ProjectError` arms (every U+2014 goes) and appends a terminal period to every arm,
// so a clause chosen from a reworded span could never have been red and the assertion
// would certify nothing - this repository's signature defect. `Malformed` carries no
// em dash, so the reword does not touch it, and the terminal period is appended AFTER the
// pinned clause, so the substring is unchanged either way.
//
// # Render health, not just model state
// The live oracle reads the MODEL (`window.__fabrico.scene()`), which is fed by the
// packet/React path and is completely independent of the Pixi ticker. A card rendered
// over a DEAD canvas would satisfy every model assertion here, so every case runs under
// `watchPageErrors` for its whole duration and ends with `expectRenderLoopAlive`.
//
// Drive rules (the live suite's locked set): the real toolbar button plus the browser
// prompt dialog, never an injected packet; every wait polls a SPECIFIC change, never a
// fixed sleep.

/** `REFUSAL_HOLD_MS` in `frontend/src/chrome/RefusalMessage.tsx`. */
const REFUSAL_HOLD_MS = 4000;

/** `STATUS_LOAD_TIMEOUT_MS` in `frontend/src/chrome/App.tsx` - the load-resolution
 *  timeout, and the ONLY thing HEAD could eventually show. */
const STATUS_LOAD_TIMEOUT_MS = 10_000;

/** The exact clause the reword does not touch (ruling R-16, route (a)). */
const PINNED_CLAUSE = 'postcard decode failed';

/**
 * Write a `.fab` that fails layer-1 postcard decode and return its path.
 *
 * Not a truncated real bundle and not an empty file: a short run of bytes that cannot be
 * a `ProjectFile` envelope, so the host's FIRST gate refuses it and the variant is
 * unambiguously `Malformed`. Trivially producible from a spec, which is not true of a
 * valid postcard envelope carrying a specific version.
 */
function writeUndecodableFab(): string {
  const path = join(tmpdir(), `fabrico-e2e-refused-${Date.now()}.fab`);
  writeFileSync(path, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
  return path;
}

/** The mounted load-refusal card, or an empty locator when none is held. */
function refusalCard(page: Page) {
  return page.getByRole('alert');
}

test.describe('UNDO-09: a refused load says why, on screen, with the board still there', () => {
  test('the host sentence reaches the DOM off the refusal path, the card outlives the banner hold, and the board is untouched', async ({
    page,
  }) => {
    // Installed BEFORE `goto` so a boot-time throw is caught too.
    const pageErrors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // AT REST THE CARD CONTRIBUTES NOTHING. This is the conditional-mount property that
    // protects the eight shipped alert-count-zero assertions elsewhere in the suite, and
    // it is also the honest baseline for the assertion below: without it, a build that
    // always mounted an alert would pass the next step for the wrong reason.
    await expect(refusalCard(page)).toHaveCount(0);

    // The pre-Load board, read from the live model. A card over an EMPTIED board would
    // satisfy every other assertion in this test.
    const nodesBefore = (await readScene(page)).nodes.map((n) => n.id).sort((a, b) => a - b);
    expect(nodesBefore.length, 'the demo board booted with a real topology').toBeGreaterThan(0);

    const path = writeUndecodableFab();
    // The Load is DISPATCHED when the prompt is accepted, not when the click resolves,
    // so the clock starts there. (Measured: the click-to-accept leg is about 40 ms, so
    // the distinction is small - but it is the honest origin and it costs nothing.)
    let dispatchedAt = 0;
    page.once('dialog', (d) => {
      dispatchedAt = Date.now();
      void d.accept(path);
    });
    await page.getByTitle('Load a saved factory').click();

    // (1) THE REASON IS ON SCREEN, and it is the HOST's sentence rather than anything the
    // client authored. Polled tightly and timestamped, so the two timing assertions below
    // read the moment the card actually appeared rather than a polling artefact. Red on
    // HEAD: the reason dies at an `eprintln!` and there is no such node.
    let seenAt = 0;
    let statusWhenSeen = '';
    await expect
      .poll(
        async () => {
          if ((await refusalCard(page).count()) === 0) return false;
          if (seenAt === 0) {
            seenAt = Date.now();
            statusWhenSeen = ((await page.getByRole('status').textContent()) ?? '').trim();
          }
          return true;
        },
        {
          timeout: STATUS_LOAD_TIMEOUT_MS - 1_000,
          intervals: [50, 50, 100],
          message:
            'a refused load puts the host\'s reason on screen. On HEAD the reason dies at ' +
            'an eprintln! on the sim thread and there is nothing in the DOM at all',
        },
      )
      .toBe(true);
    await expect(refusalCard(page)).toContainText(PINNED_CLAUSE);

    // (2) IT IS THE REFUSAL PATH AND NOT THE TIMEOUT PATH, AND THE STRIP SAYS SO (UI-SPEC
    // A9, plan 90-04). The refusal handler writes `Load failed` with the card, so the strip
    // agrees with the card the moment it appears; the backstop below rules out the cut-off.
    console.log(`P90-A9 status_when_card_seen=${JSON.stringify(statusWhenSeen)}`);
    await expect
      .poll(async () => ((await page.getByRole('status').first().textContent()) ?? '').trim(), {
        timeout: 1_000,
        intervals: [50, 100],
        message: 'the strip reads Load failed with the card (A9): the refusal wrote it, not a timeout',
      })
      .toBe('Load failed');
    // The mechanical backstop, which the timeout path cannot meet by construction. The
    // slack against STATUS_LOAD_TIMEOUT_MS is the swap-safety drain, bounded in ticks
    // (see the header); measured on this board it lands around 2.0 s.
    const elapsed = seenAt - dispatchedAt;
    expect(
      elapsed,
      `the reason arrived ${elapsed}ms after dispatch, strictly inside the ` +
        `${STATUS_LOAD_TIMEOUT_MS}ms load-resolution timeout`,
    ).toBeLessThan(STATUS_LOAD_TIMEOUT_MS - 1_000);

    // (3) THE PHRASE IS NOT THE GENERIC "Load failed". That string is the timeout copy at
    // `controlHandlers.ts`, it keeps its role, and it is not what this surface says.
    await expect(refusalCard(page)).not.toContainText('Load failed');

    // (4) THE BOARD IS UNCHANGED BEHIND THE CARD. Set-equal to the pre-Load reading: the
    // host kept the current scene, which is the second half of UNDO-09's requirement.
    const nodesAfter = (await readScene(page)).nodes.map((n) => n.id).sort((a, b) => a - b);
    expect(nodesAfter, 'the refused load kept the current scene, node for node').toEqual(
      nodesBefore,
    );

    // (5) THE CARD OUTLIVES THE REFUSAL BANNER HOLD. This is the row that fails on a build
    // which quietly routed the text through `RefusalMessage`, whose `REFUSAL_HOLD_MS` is
    // 4000 ms against a sentence that runs to 674 characters. Nothing is slept ON: the
    // assertion polls the surface's continued presence past the hold plus a margin.
    await expect
      .poll(
        async () => {
          if (Date.now() - dispatchedAt < REFUSAL_HOLD_MS + 1_500) return 'waiting';
          return (await refusalCard(page).count()) > 0 ? 'still-there' : 'vanished';
        },
        {
          timeout: REFUSAL_HOLD_MS + 6_000,
          intervals: [250, 500, 500],
          message:
            'the card is STILL on screen after REFUSAL_HOLD_MS plus a margin - it is ' +
            'dismissed by the user, never by a timer',
        },
      )
      .toBe('still-there');
    await expect(refusalCard(page)).toContainText(PINNED_CLAUSE);

    // (6) DISMISSAL IS THE USER'S. `Close` takes it away, and nothing else did.
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(refusalCard(page)).toHaveCount(0);

    // RENDER HEALTH, not model state. The oracle above reads only the model, so a dead
    // Pixi ticker would have passed every assertion so far.
    await expectRenderLoopAlive(page, 'after a refused load rendered its card');
    pageErrors.assertNone('during the refused-load walk');
  });
});
