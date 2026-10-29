import { test, expect } from '@playwright/test';
import { CMD, buildPacket, mockRenderSocket, waitForChrome } from './support/wire';

// ---------------------------------------------------------------------------
// Plan 84-12 (the early 2026-10-13 CI run, live job): A REDO PRESSED BEFORE THE NEXT FRAME IS SENT.
//
// The live spec `74.1-port-edit-rings` pressed Ctrl+Shift+Z right after the undo's packet
// landed, and on the two-core runner the redo was dropped without a word: the Redo button
// read enabled 15 s later and nothing had been sent. The gate in `doUndo` / `doRedo` read a
// per-frame copy of the scene's availability, refreshed by the chrome's animation-frame
// poll, so a key pressed between a packet and the next frame read the packet BEFORE.
// Measured at two pinned cores with a 50% quota: the copy lagged the packet by up to
// 184 ms, and the failing run's frames were 400 to 600 ms apart.
//
// This holds every animation frame (the slow frame, made certain), lets the packet land,
// and presses. The press must reach the socket on the packet's own availability.
// ---------------------------------------------------------------------------

type HeldWindow = Window & { __held84?: FrameRequestCallback[]; __realRaf84?: typeof requestAnimationFrame };

/** Hold every animation frame from now on: callbacks queue, none runs. */
async function holdFrames(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as HeldWindow;
    w.__held84 = [];
    w.__realRaf84 = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      w.__held84!.push(cb);
      return 0;
    };
  });
  // Wait for one REAL frame after installing the hold (review 84 WR-05). Callbacks run in the
  // order they were registered, so when this one runs every callback scheduled before the hold
  // has run its one frame and re-registered into the hold, at any frame rate. A fixed sleep only
  // made that likely: on a page drawing a frame every 400 ms an earlier loop could run after the
  // packet landed and refresh the old per-frame copy, and the test would pass on the bug.
  await page.evaluate(() => new Promise<void>((r) => (window as HeldWindow).__realRaf84!(() => r())));
}

/** Release the held frames and restore the browser's own scheduler. */
async function releaseFrames(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as HeldWindow;
    window.requestAnimationFrame = w.__realRaf84!;
    for (const cb of w.__held84!.splice(0)) window.requestAnimationFrame(cb);
  });
}

/** The scene's own availability, read straight off the packet-driven scene. */
async function availability(page: import('@playwright/test').Page): Promise<{ tick: number; canUndo: boolean; canRedo: boolean }> {
  return page.evaluate(() => {
    const s = (window as unknown as { __fabrico: { scene(): { tick: number; canUndo: boolean; canRedo: boolean } } }).__fabrico.scene();
    return { tick: s.tick, canUndo: s.canUndo, canRedo: s.canRedo };
  });
}

test.describe('undo and redo read the packet that landed, not the last frame', () => {
  test('UNDO-REDO-BEFORE-FRAME: a packet enables Undo and Redo, and both keys pressed before the next frame are sent', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 5, canUndo: false, canRedo: false }));
    await expect.poll(() => availability(page), { message: 'the first board landed' }).toEqual({
      tick: 5,
      canUndo: false,
      canRedo: false,
    });
    const undo = page.locator('header button[aria-label="Undo"]');
    await expect(undo, 'nothing to undo yet').toBeDisabled();
    const sentOf = (cmd: number): number => h.sent.filter((f) => f[0] === cmd).length;

    await holdFrames(page);
    try {
      h.inject(buildPacket({ tick: 6, full: false, canUndo: true, canRedo: true }));
      await expect
        .poll(() => availability(page), { message: 'the packet landed while every frame is held' })
        .toEqual({ tick: 6, canUndo: true, canRedo: true });

      await page.keyboard.press('Control+z');
      await expect.poll(() => sentOf(CMD.Undo), { message: 'Ctrl+Z before the next frame sends one Undo', timeout: 3000 }).toBe(1);
      await page.keyboard.press('Control+Shift+z');
      await expect
        .poll(() => sentOf(CMD.Redo), { message: 'Ctrl+Shift+Z before the next frame sends one Redo', timeout: 3000 })
        .toBe(1);
    } finally {
      await releaseFrames(page);
    }
    // Let the released callbacks actually run (the frame they were handed to, and one more)
    // before asserting what they did not send (review 84 WR-05).
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    expect(sentOf(CMD.Undo), 'and no second Undo once frames run').toBe(1);
    expect(sentOf(CMD.Redo), 'and no second Redo once frames run').toBe(1);
  });
});
