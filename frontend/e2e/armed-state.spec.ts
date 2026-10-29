import { test, expect, type Page } from '@playwright/test';
import { CMD, mockRenderSocket, screenCellCentre, waitForChrome } from './support/wire';

// armed-state.spec.ts (Phase 30-03, IX-01/03/06) — the persistent arm-then-act
// mechanic at the production UI edge. Machine placement now mirrors the Belt
// tool: a palette CLICK arms the tool (emits nothing, sets a crosshair cursor),
// a single canvas click commits one GridCommand and the tool STAYS ARMED for
// repeat placement, and Esc / right-click / re-clicking the tool all disarm
// (crosshair released). We drive the real gestures and assert emitted bytes +
// the live canvas cursor — never canvas pixels.
//
// Palette items are selected by a COPY-STABLE role-name regex (the visible
// label text), NOT the tooltip string: 30-05 rewrites that copy, so a title
// selector would go stale. The label text ("Source", "Belt") is stable.

/** The live Pixi canvas cursor (gestures drives canvas.style.cursor). */
async function canvasCursor(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? (c as HTMLCanvasElement).style.cursor : null;
  });
}

test.describe('Persistent-arm placement + armed cursor (IX-01/03/06)', () => {
  test('arming a machine sets a crosshair cursor; a legal click commits and the tool STAYS armed for repeat', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // Arm the Source tool by clicking the palette entry (copy-stable selector).
    await page.getByRole('button', { name: /Source/ }).click();
    expect(await canvasCursor(page)).toBe('crosshair');

    // A single canvas click commits exactly one frame (discriminant 0).
    const first = await screenCellCentre(page, 12, 8);
    await page.mouse.click(first.x, first.y);
    await expect.poll(() => h.sent.length).toBe(1);
    expect(h.sent[0][0]).toBe(CMD.Place);
    // Still in hand: the crosshair persists.
    expect(await canvasCursor(page)).toBe('crosshair');

    // A SECOND canvas click commits again — repeat placement, no re-arm (IX-06).
    const second = await screenCellCentre(page, 15, 8);
    await page.mouse.click(second.x, second.y);
    await expect.poll(() => h.sent.length).toBe(2);
    expect(h.sent[1][0]).toBe(CMD.Place);
    expect(await canvasCursor(page)).toBe('crosshair');
  });

  test('Escape disarms the tool (crosshair released, later click commits nothing)', async ({
    page,
  }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    await page.getByRole('button', { name: /Source/ }).click();
    expect(await canvasCursor(page)).toBe('crosshair');

    await page.keyboard.press('Escape');
    expect(await canvasCursor(page)).toBe('');

    // Disarmed: a canvas click on empty floor emits no command.
    const c = await screenCellCentre(page, 12, 8);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(150);
    expect(h.sent.length, 'a disarmed tool commits nothing').toBe(0);
  });

  test('re-clicking the armed tool disarms it (crosshair released)', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    await page.getByRole('button', { name: /Source/ }).click();
    expect(await canvasCursor(page)).toBe('crosshair');

    // Re-clicking the SAME tool toggles it off (Factorio re-click).
    await page.getByRole('button', { name: /Source/ }).click();
    expect(await canvasCursor(page)).toBe('');
  });

  test('the Belt tool arms with a crosshair cursor and disarms on re-click', async ({ page }) => {
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    await page.getByRole('button', { name: /Belt/ }).click();
    expect(await canvasCursor(page)).toBe('crosshair');

    await page.getByRole('button', { name: /Belt/ }).click();
    expect(await canvasCursor(page)).toBe('');
  });
});
