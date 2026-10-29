import { test, expect } from '@playwright/test';
import {
  CMD,
  buildPacket,
  expectExactlyOneFrame,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectNode,
} from './support/wire';

// paused-edit-notice.spec.ts (quick/260825-iae) - the proof that a paused board
// SAYS its edits are held.
//
// The defect this pins: `SimLoop::step` calls `acquire_input()` only in the
// `RunState::Playing` arm and the gesture channel is unbounded, so an edit issued
// while paused is enqueued and applied on resume - correct, and completely silent.
// A user placing a machine on a paused board sees nothing happen and concludes
// placement is broken (confirmed live 2026-08-25).
//
// The host is CORRECT and is FROZEN. Only the silence is fixed, and only in the
// client-originated STATUS_COPY tier - never in RefusalMessage.tsx, whose closed
// 17-tag host union is the only thing allowed to state a CAUSE (T-64-06-01). The
// pause state is a fact the CLIENT knows about itself, not a host verdict.
//
// THE SAFE-01 WATCHDOG CANNOT CONTAMINATE ANY READING HERE, and both halves of
// that are load-bearing rather than luck. Its `arm()` no-ops until its first
// `onPacket()` (statusWatchdog.ts `started`), so the two cases that inject nothing
// can never see the sticky `Disconnected - live view frozen` string race their
// emptiness assertions; and every arm is gated on `isPlaying()`, so the third case,
// which DOES inject, only does so after pausing. Either way the readout under test
// carries what this spec put there.

/**
 * The ONE spelling of the notice in this spec. It is a single module const rather
 * than a string typed at each assertion so the spec and `STATUS_COPY.editsQueued`
 * cannot drift apart through two independently hand-edited literals.
 */
const NOTICE = 'Paused - edits queued until Play';

/** The layout case's injected scene, verbatim from toolbar-stability.spec.ts so the
 *  measurement is taken against the same board the WINDOWS id 4 bound describes. */
const MACHINE: InjectNode = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
const NEW_MACHINE: InjectNode = { id: 2, kind: 0, cell_x: 14, cell_y: 8 };

/**
 * The status readout, pinned to the FIRST `header [role="status"]`.
 *
 * Toolbar.tsx:443 renders the SAVE-05 `Unsaved` badge as a SECOND `role="status"`
 * in the same header, so an unqualified `getByRole('status')` is a strict-mode
 * violation the moment the board reads dirty. DOM order puts StatusReadout first,
 * and the readout is always mounted (idle renders an empty live region), so `.first()`
 * is stable in both states.
 *
 * MEASURED, against the plan's expectation: a client-side Place does NOT dirty the
 * board. The badge tracks the HOST's echo, so it never appears in the two cases
 * below, which inject no packet - the badge had to be produced deliberately in the
 * layout case. The pin is kept anyway: it costs nothing and it is correct in a real
 * session, where the host's echo does arrive.
 */
function readoutOf(page: import('@playwright/test').Page) {
  return page.locator('header [role="status"]').first();
}

test.describe('a paused board says its edits are queued', () => {
  test('PAUSED: a Place that really went on the wire sets the notice', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    const readout = readoutOf(page);
    await expect(readout, 'the readout starts empty (idle renders no text)').toHaveText('');

    // The sim boots Playing (SIM_BOOTS_PLAYING), so the toolbar shows Pause.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

    // Arm-then-click (IX-01): arming emits nothing; the cell click commits one Place.
    const item = page.getByRole('button', { name: /Source/ });
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');

    const drop = await screenCellCentre(page, 12, 8);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();

    // The notice is a claim that an edit was QUEUED, so prove the edit was really
    // handed to the transport before asserting anything about the claim.
    await expectExactlyOneFrame(page, h, CMD.Place);

    await expect(readout, 'a queued edit on a paused board is announced').toHaveText(NOTICE);
  });

  test('PLAYING: the same Place sets nothing', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    const readout = readoutOf(page);
    await expect(readout).toHaveText('');

    // No Pause click: the sim is still Playing, so the host applies this edit on
    // the very next tick and there is nothing to announce.
    const item = page.getByRole('button', { name: /Source/ });
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');

    const drop = await screenCellCentre(page, 12, 8);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();

    // FIRST prove the edit really reached the wire. Without this the case would
    // pass just as happily against an app that emitted no Place at all - the
    // silence would be measuring nothing.
    await expectExactlyOneFrame(page, h, CMD.Place);

    // A deliberate settle window: the notice is set synchronously in submitInput,
    // but a LATE asynchronous set (e.g. one hung off a verdict or a packet) would
    // slip past an immediate assertion. 250ms is comfortably longer than the app's
    // own post-gesture work and far short of anything that could time out.
    await page.waitForTimeout(250);

    await expect(readout, 'a live board announces nothing on an ordinary edit').toHaveText('');
  });

  // THE LAYOUT GUARD. CORRECTED IN PLACE BY PLAN 74.1-31, which made the old guard's
  // premise false. It read: "The readout is `whiteSpace: 'nowrap'` in the header flex
  // row, so a status string pushes that row wider by roughly its own width", and it
  // measured the CTA's right edge at 1106px on a dirty board (idle 1068px, this notice
  // 1324px, the shipped 'Disconnected - live view frozen' 1336px), asserting only that
  // the notice set no NEW worst case, because every status string overflowed 1106px.
  //
  // That movement was the defect (PAUSE-TOOLBAR): the same push slid the centre buttons
  // under the pointer, and a click where Play had been landed on Undo. The readout now
  // renders in the status strip under the toolbar, outside the row, so the guard is
  // ABSOLUTE again: the CTA's right edge is the same with the readout empty, with this
  // notice, and with the shipped `Disconnected` string. A floor keeps it honest: both
  // strings really rendered (the strip had width), so the equality is not three empty
  // readouts. `toolbar-stability.spec.ts` pins every other header button the same way.
  test('LAYOUT: no status string moves the primary CTA (the readout is out of the row, 74.1-31)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.setViewportSize({ width: 1106, height: 800 });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Deterministic text metrics: the bundled Martian Mono is `font-display: block`,
    // so a measurement taken during the block period reads fallback-mono advances
    // (72px vs 80px per 10 chars) and understates every width below.
    await page.evaluate(async () => {
      await document.fonts.load('12px "Martian Mono"');
      await document.fonts.ready;
    });

    const ctaRight = async (): Promise<number> => {
      const box = await page.locator('header button[data-fab-examples-trigger]').boundingBox();
      expect(box, 'the primary CTA has a layout box').not.toBeNull();
      return (box?.x ?? 0) + (box?.width ?? 0);
    };

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

    // THE PLACE COMES FIRST, and the order is a measured constraint rather than a
    // preference: injecting a scene triggers the 29-04 fit-to-factory camera, after
    // which `screenCellCentre(12, 8)` resolves off a 1106px-wide viewport entirely
    // and the click lands nowhere. Under the identity boot camera it is on screen.
    const item = page.getByRole('button', { name: /Source/ });
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    const drop = await screenCellCentre(page, 12, 8);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();
    await expectExactlyOneFrame(page, h, CMD.Place);

    // NOW dirty the board - the widest state the row is ever asked to hold. The
    // `Unsaved` badge tracks the HOST's echo, not the local gesture, so it needs a
    // keyframe plus a diff carrying a structural change, exactly as
    // toolbar-stability.spec.ts produces it. Injecting AFTER the pause is
    // deliberate: `onPacket` starts the SAFE-01 watchdog and every arm is gated on
    // isPlaying, so nothing can flash `Disconnected` over the reading below.
    h.inject(buildPacket({ tick: 123456, canUndo: true, canRedo: true, nodes: [MACHINE] }));
    h.inject(buildPacket({ nodes: [MACHINE, NEW_MACHINE], full: false, tick: 123457 }));
    await expect(page.getByText('Unsaved', { exact: true })).toBeVisible();

    // Read the row while the notice is ACTUALLY on screen. It is a transient kind
    // and auto-clears 4s after the gesture, so this read has to happen first.
    await expect(readoutOf(page)).toHaveText(NOTICE);
    const withNotice = await ctaRight();

    // The notice expires on its own timer; the row relaxes to the empty baseline.
    await expect(readoutOf(page)).toHaveText('', { timeout: 6000 });
    const withIdle = await ctaRight();

    // The incumbent worst case, driven through the app's OWN path rather than typed
    // into the DOM: resume so the SAFE-01 watchdog may arm (it is gated on playing
    // and has now seen its first packet), then let the silent mock stream stall it.
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(readoutOf(page)).toHaveText('Disconnected - live view frozen', {
      timeout: 6000,
    });
    const withShippedWorst = await ctaRight();

    const stripWidth = async (): Promise<number> =>
      (await page.locator('header [data-fab-status-strip]').boundingBox())?.width ?? 0;
    console.log(
      `[paused-edit-notice] .fab-cta right edge at 1106px dirty: idle=${withIdle}px, ` +
        `notice(${NOTICE.length} chars)=${withNotice}px, ` +
        `shipped worst 'Disconnected - live view frozen'(31 chars)=${withShippedWorst}px`,
    );

    expect(withNotice, 'the notice does not move the CTA').toBeCloseTo(withIdle, 1);
    expect(withShippedWorst, 'the Disconnected string does not move the CTA').toBeCloseTo(withIdle, 1);
    // The floor: the Disconnected string really is on screen, in the strip, with width.
    await expect(page.locator('header [data-fab-status-strip]')).toContainText('Disconnected - live view frozen');
    expect(await stripWidth(), 'the strip really carries the Disconnected string').toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------------------
// PAUSE-TOOLBAR PART 2 (plan 74.1-31): A QUEUED UNDO NEVER SILENTLY DELETES A JUST-DRAWN
// BELT. On the third re-walk an Undo sent behind a paused draw folded on Play and
// deleted that belt with no message (log seq 11 DrawBelt, seq 12 Undo and Delete). The
// rule (a default the maintainer can overturn): while edits made on a paused
// board have not landed, Undo and Redo are held on the client. The buttons render
// disabled with a title saying why, Ctrl+Z sends nothing and the status says to press
// Play. The hold ends on the first scene packet whose tick differs from the one on screen
// when Play, Step or a board swap was requested.
// ---------------------------------------------------------------------------

const HOLD_COPY = 'Paused - press Play before undo or redo';

test.describe('a paused board holds Undo and Redo behind queued edits', () => {
  test('UNDO-HOLD: paused, a Place on the wire, then Ctrl+Z and the Undo button send nothing until a later tick lands', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    // An empty keyframe with both stacks non-empty, so Undo and Redo are enabled and
    // the camera stays at its boot transform for the Place below.
    h.inject(buildPacket({ tick: 5, canUndo: true, canRedo: true }));
    const undo = page.locator('header button[aria-label="Undo"]');
    const redo = page.locator('header button[aria-label="Redo"]');
    await expect(undo).toBeEnabled();
    await expect(redo).toBeEnabled();

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();

    const item = page.getByRole('button', { name: /Source/ });
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');
    const drop = await screenCellCentre(page, 12, 8);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();
    await expectExactlyOneFrame(page, h, CMD.Place);
    await expect(readoutOf(page)).toHaveText(NOTICE);

    const undos = (): number => h.sent.filter((f) => f[0] === CMD.Undo || f[0] === CMD.Redo).length;

    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+y');
    await expect(readoutOf(page), 'the held undo says what to do').toHaveText(HOLD_COPY);
    await expect(undo, 'Undo is held while the paused edit is queued').toBeDisabled();
    await expect(redo, 'Redo is held while the paused edit is queued').toBeDisabled();
    await expect(undo).toHaveAttribute('title', /press Play/);
    await expect(redo).toHaveAttribute('title', /press Play/);
    // A click on the held button: dispatched straight at the element, so a disabled
    // button that still had a live handler would be caught.
    await undo.dispatchEvent('click');
    await redo.dispatchEvent('click');
    await page.waitForTimeout(250);
    expect(undos(), 'no Undo or Redo frame reached the socket while the edit was queued').toBe(0);

    // A paused host DRAINS: it keeps ticking with input held (`RunState::Draining`), so a
    // later tick while still paused is not evidence the edit landed. The hold stays.
    h.inject(buildPacket({ tick: 6, full: false, canUndo: true, canRedo: true }));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __fabrico: { scene(): { tick: number } } }).__fabrico.scene().tick)).toBe(6);
    await page.waitForTimeout(150);
    await expect(undo, 'a draining tick while paused does not end the hold').toBeDisabled();
    await page.keyboard.press('Control+z');
    expect(undos(), 'still nothing on the wire').toBe(0);

    // Play, then the host's next packet at a later tick: the queued edit has landed.
    await page.getByRole('button', { name: 'Play' }).click();
    h.inject(buildPacket({ tick: 7, full: false, canUndo: true, canRedo: true }));
    await expect(undo, 'Undo is available again once a later tick lands').toBeEnabled();
    await expect(redo).toBeEnabled();
    await expect(undo).toHaveAttribute('title', 'Undo (Ctrl+Z)');
    await page.keyboard.press('Control+z');
    await expect.poll(undos, { message: 'Ctrl+Z now sends exactly one Undo' }).toBe(1);
    await page.waitForTimeout(150);
    expect(undos(), 'and no late duplicate').toBe(1);
    expect(h.sent[h.sent.length - 1][0], 'the frame is an Undo').toBe(CMD.Undo);
  });
});

// ---------------------------------------------------------------------------
// Review round 5 CR-01 (plan 74.1-35): A BOARD SWAP ENDS THE HOLD ONLY ON ITS OWN KEYFRAME.
//
// The host now discards every edit queued on the board a swap replaces, at the swap
// (`install_swapped_host`). Before this plan New, an example and Open ended the hold at
// the REQUEST, on the next packet whose tick moved, while a draining host was still
// ticking the OLD board with the edits queued. The rule (a default the
// maintainer can overturn): a swap request marks the hold, and only a timeline-restructure
// keyframe (`full` and not `resync`, the one `producer.reset` emits at the swap) ends it.
// Play and Step keep the tick rule.
// ---------------------------------------------------------------------------

/** Pause, then commit one Place on the wire, so the undo hold is set. */
async function pauseAndPlace(
  page: import('@playwright/test').Page,
  h: Awaited<ReturnType<typeof mockRenderSocket>>,
): Promise<void> {
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  const item = page.getByRole('button', { name: /Source/ });
  await item.click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  const drop = await screenCellCentre(page, 12, 8);
  await page.mouse.move(drop.x, drop.y);
  await page.mouse.down();
  await page.mouse.up();
  await expectExactlyOneFrame(page, h, CMD.Place);
  await expect(readoutOf(page)).toHaveText(NOTICE);
  await page.keyboard.press('Escape');
}

/** Wait until the scene on screen reads `tick`. */
async function sceneTickIs(page: import('@playwright/test').Page, tick: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __fabrico: { scene(): { tick: number } } }).__fabrico.scene().tick,
      ),
    )
    .toBe(tick);
}

/** Click through the discard guard if one opened (the mock board is normally clean). */
async function discardIfGuarded(page: import('@playwright/test').Page): Promise<void> {
  const panel = page.locator('.fab-dialog-panel');
  if (await panel.isVisible().catch(() => false)) {
    await panel.getByRole('button', { name: 'Discard' }).click();
  }
  await expect(panel).toBeHidden();
}

test.describe('a board swap ends the undo hold only on its own keyframe', () => {
  test('SWAP-HOLD-NEW: paused, a Place, toolbar New: a draining tick keeps the hold, the new board keyframe ends it', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 5, canUndo: true, canRedo: true }));
    const undo = page.locator('header button[aria-label="Undo"]');
    const redo = page.locator('header button[aria-label="Redo"]');
    await expect(undo).toBeEnabled();

    await pauseAndPlace(page, h);
    await expect(undo, 'held behind the queued Place').toBeDisabled();
    const undos = (): number => h.sent.filter((f) => f[0] === CMD.Undo || f[0] === CMD.Redo).length;

    await page.getByRole('button', { name: 'New' }).click();
    await discardIfGuarded(page);
    await expect.poll(() => h.controls.includes('new'), { message: 'New went on the wire' }).toBe(true);

    // The host may still be draining the OLD board when New is serviced (it latches the
    // swap until the drain freezes): a tick from that drain is not the new board.
    h.inject(buildPacket({ tick: 6, full: false, canUndo: true, canRedo: true }));
    await sceneTickIs(page, 6);
    await page.waitForTimeout(150);
    await expect(undo, 'a draining tick after New does not end the hold').toBeDisabled();
    await expect(redo).toBeDisabled();
    await page.keyboard.press('Control+z');
    await expect(readoutOf(page), 'the held undo says what to do').toHaveText(HOLD_COPY);
    await page.waitForTimeout(150);
    expect(undos(), 'Ctrl+Z sends nothing before the new board arrives').toBe(0);

    // The swap's keyframe (`full`, not a resync): the host discarded the old board's
    // edits before emitting it, so the hold ends and Undo follows this board.
    h.inject(buildPacket({ tick: 0, full: true, canUndo: true, canRedo: false }));
    await sceneTickIs(page, 0);
    await expect(undo, 'the new board keyframe ends the hold').toBeEnabled();
    await expect(redo, 'Redo follows the keyframe').toBeDisabled();
    await expect(
      readoutOf(page),
      'the readout drops the held copy at once (the edits it named no longer exist)',
    ).toHaveText('', { timeout: 1000 });
    await page.keyboard.press('Control+z');
    await expect.poll(undos, { message: 'Ctrl+Z now sends exactly one Undo' }).toBe(1);
  });
});

test.describe('a board swap ends the undo hold only on its own keyframe (the other paths and the terms)', () => {
  test('SWAP-HOLD-EXAMPLE: paused, a Place, an example picked: draining ticks keep the hold, the example keyframe ends it', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 5, canUndo: true, canRedo: true }));
    const undo = page.locator('header button[aria-label="Undo"]');
    await expect(undo).toBeEnabled();
    await pauseAndPlace(page, h);
    const undos = (): number => h.sent.filter((f) => f[0] === CMD.Undo || f[0] === CMD.Redo).length;

    await page.getByRole('button', { name: 'Examples' }).click();
    await page.getByRole('button', { name: 'Load order processing' }).click();
    await discardIfGuarded(page);
    await expect
      .poll(() => h.controls.some((c) => c.startsWith('load_example')), { message: 'the example load went on the wire' })
      .toBe(true);

    // Two drained ticks of the OLD board (the host latches the swap behind the drain).
    for (const tick of [6, 7]) {
      h.inject(buildPacket({ tick, full: false, canUndo: true, canRedo: true }));
      await sceneTickIs(page, tick);
      await page.waitForTimeout(100);
      await expect(undo, `drained tick ${tick} after the example pick does not end the hold`).toBeDisabled();
    }
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);
    expect(undos(), 'Ctrl+Z sends nothing before the example board arrives').toBe(0);

    h.inject(buildPacket({ tick: 0, full: true, canUndo: false, canRedo: false, nodes: [NEW_MACHINE] }));
    await sceneTickIs(page, 0);
    await expect(
      readoutOf(page),
      'the example keyframe ends the hold: the held copy goes (no load latch on an example)',
    ).toHaveText('', { timeout: 1000 });
    // Undo now follows the board (nothing to undo on a fresh example), and a later
    // keyframe with history enables it: the hold no longer masks it.
    h.inject(buildPacket({ tick: 1, full: true, canUndo: true, canRedo: false, nodes: [NEW_MACHINE] }));
    await expect(undo, 'Undo follows the example board once the hold is gone').toBeEnabled();
  });

  test('SWAP-HOLD-NO-SWAP: paused, a Place, then a restructure keyframe with no swap requested keeps the hold', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 5, canUndo: true, canRedo: true }));
    const undo = page.locator('header button[aria-label="Undo"]');
    await expect(undo).toBeEnabled();
    await pauseAndPlace(page, h);
    await expect(undo).toBeDisabled();

    // A restructure keyframe (`full`, not a resync) that no swap of ours asked for.
    h.inject(buildPacket({ tick: 6, full: true, canUndo: true, canRedo: true, resync: false }));
    await sceneTickIs(page, 6);
    await page.waitForTimeout(200);
    await expect(undo, 'a keyframe with no swap requested does not end the hold').toBeDisabled();
    await page.keyboard.press('Control+z');
    await expect(readoutOf(page)).toHaveText(HOLD_COPY);
  });

  test('SWAP-HOLD-RESYNC: paused, a Place, New, a lag-resync keyframe keeps the hold, the restructure keyframe ends it', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 5, canUndo: true, canRedo: true }));
    const undo = page.locator('header button[aria-label="Undo"]');
    await expect(undo).toBeEnabled();
    await pauseAndPlace(page, h);

    await page.getByRole('button', { name: 'New' }).click();
    await discardIfGuarded(page);
    await expect.poll(() => h.controls.includes('new'), { message: 'New went on the wire' }).toBe(true);

    // A transport's lag resync of the CURRENT keyframe (the old board, same tick): the
    // timeline did not move, so it is not the swap.
    // It carries one machine so its arrival is visible on the scene (the tick is unchanged).
    h.inject(buildPacket({ tick: 5, full: true, canUndo: true, canRedo: true, resync: true, nodes: [MACHINE] }));
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __fabrico: { scene(): { nodes: unknown[] } } }).__fabrico.scene().nodes.length,
          ),
        { message: 'the resync keyframe was applied' },
      )
      .toBe(1);
    await page.waitForTimeout(200);
    await expect(undo, 'a lag-resync keyframe does not end the hold').toBeDisabled();

    h.inject(buildPacket({ tick: 0, full: true, canUndo: true, canRedo: false, resync: false }));
    await sceneTickIs(page, 0);
    await expect(undo, 'the restructure keyframe (the swap) ends the hold').toBeEnabled();
  });
});
