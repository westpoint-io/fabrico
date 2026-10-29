import { test, expect } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  waitForBoard,
} from './support/wire';

// focus-guard.spec.ts (Phase 30-04, IX-09 + IX-07) — the global canvas shortcuts
// must be focus-safe, and Escape must have consistent disarm-then-clear semantics,
// at the production UI edge. We drive the real gestures and assert EMITTED bytes
// (h.sent), never canvas pixels.
//
//   IX-09: with a chrome palette BUTTON focused, pressing 'r'/'Delete' must NOT
//          leak a canvas shortcut (the onKey guard returns early for BUTTON/SELECT
//          in addition to INPUT/TEXTAREA/contentEditable). Contrast: the
//          emits-command Rotate/Delete tests prove select+key DOES emit when no
//          chrome control owns focus.
//   IX-07: with a selection and nothing armed/focused, Escape clears the selection.
//          Observed behaviourally — a subsequent 'r' emits NO Rotate, because the
//          node is no longer selected (the emits-command Rotate test pins that a
//          SELECTED node + 'r' emits exactly one frame, so zero frames here proves
//          the clear).
//
// Palette items are selected by a COPY-STABLE role-name regex (the visible label
// text), NOT the tooltip string — 30-05 rewrites that copy, so a title selector
// would go stale. The label text ("Source") is stable.

test.describe('onKey focus guard + Escape-clears-selection (IX-09 / IX-07)', () => {
  test('a focused palette BUTTON suppresses the r/Delete canvas shortcuts (IX-09)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Inject one node and select it (canvas click, no drag).
    const a = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
    h.inject(buildPacket({ nodes: [a] }));
    await waitForBoard(page, { machines: 1 });
    const at = await screenCellCentre(page, a.cell_x, a.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up(); // selects the node

    // Focus the Source palette button WITHOUT clicking it (a click would arm the
    // tool). Keyboard-arming (Enter/Space) leaves the same button focused, so this
    // is the IX-09 common case: a chrome BUTTON owns focus while the canvas has a
    // selection. Copy-stable role-name selector, never the title string.
    const sourceBtn = page.getByRole('button', { name: /Source/ });
    await sourceBtn.focus();
    await expect(sourceBtn).toBeFocused();

    // With the BUTTON focused, r and Delete must NOT reach the canvas.
    await page.keyboard.press('r');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);

    expect(
      h.sent.length,
      'a focused chrome button consumes r/Delete — no canvas shortcut leaks (IX-09)',
    ).toBe(0);
  });

  test('Escape clears an active selection when nothing is armed (IX-07)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Inject one node and select it (canvas click, no drag). The canvas is not
    // focusable, so activeElement stays <body> — no focus guard, nothing armed.
    const a = { id: 1, kind: 0, cell_x: 12, cell_y: 8 };
    h.inject(buildPacket({ nodes: [a] }));
    await waitForBoard(page, { machines: 1 });
    const at = await screenCellCentre(page, a.cell_x, a.cell_y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up(); // selects the node

    // Escape with nothing armed clears the selection.
    await page.keyboard.press('Escape');

    // Proof the selection is gone: 'r' now emits NOTHING (a selected node + 'r'
    // emits exactly one Rotate — see emits-command.spec — so zero frames here
    // means the node is no longer selected).
    await page.keyboard.press('r');
    await page.waitForTimeout(150);

    expect(
      h.sent.length,
      'Escape cleared the selection — a later r rotates nothing (IX-07)',
    ).toBe(0);
  });
});
