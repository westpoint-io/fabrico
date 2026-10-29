import { test, expect, type Page } from '@playwright/test';
import { mockRenderSocket, screenCellCentre, waitForChrome } from './support/wire';

// context-menu.spec.ts (Phase 30-03, IX-08) — the canvas suppresses the native
// OS/browser context menu so a right-click cancel gesture never pops a menu over
// the grid, and a right-click on the canvas disarms an armed tool. Suppression
// is scoped to the canvas ONLY (never global) and torn down in destroy().
//
// Palette items are selected by a copy-stable role-name regex (label text), not
// the tooltip copy that 30-05 rewrites.

/** The live Pixi canvas cursor (gestures drives canvas.style.cursor). */
async function canvasCursor(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? (c as HTMLCanvasElement).style.cursor : null;
  });
}

test.describe('Canvas context-menu suppression + right-click cancel (IX-08)', () => {
  test('a contextmenu event dispatched on the canvas is defaultPrevented', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Dispatch a cancelable contextmenu on the Pixi canvas; the gesture layer's
    // per-canvas handler must preventDefault it (no OS menu over the grid).
    const prevented = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      c.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented, 'the canvas contextmenu default is prevented').toBe(true);
  });

  test('the contextmenu suppression is scoped to the canvas, not the document body', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // A contextmenu on the body (chrome region) must NOT be suppressed — the
    // handler is per-canvas, never global (right-click still works on chrome).
    const prevented = await page.evaluate(() => {
      const ev = new MouseEvent('contextmenu', { bubbles: false, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    expect(prevented, 'a body contextmenu is NOT suppressed (scoped to canvas)').toBe(false);
  });

  test('a right-click on the canvas cancels an armed tool (crosshair released, no command)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    await page.getByRole('button', { name: /Source/ }).click();
    expect(await canvasCursor(page)).toBe('crosshair');

    // Right-click on the canvas is a decisive cancel (fires on pointerdown).
    const c = await screenCellCentre(page, 12, 8);
    await page.mouse.click(c.x, c.y, { button: 'right' });

    expect(await canvasCursor(page)).toBe('');
    await page.waitForTimeout(150);
    expect(h.sent.length, 'a cancel commits nothing').toBe(0);
  });
});
