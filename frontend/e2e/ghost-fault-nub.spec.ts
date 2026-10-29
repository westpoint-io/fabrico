import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { mockRenderSocket, screenCellCentre, screenPoint, waitForChrome } from './support/wire';
import { colorOracles, nubAnchor } from '../shared/geometry';
import { isRedPixel, redPixelCount } from '../shared/redPixel';

// ghost-fault-nub.spec.ts (phase 92, plan 92-01, CHROME-18, D-06, UI-SPEC 3.4) - an armed
// Factory's placement ghost over open floor puts no red on the board.
//
// WHAT WAS BROKEN (92-MEASURE.md 18c). The placement ghost drew every port as a 3.5 px disc and the
// fault exit in the fault accent, so arming a Factory, Router, Sink or Handler put a red dot on the
// board on every valid hover, where nothing was faulted. The ghost now draws each nub with the
// canvas's own `drawRoleNub` at the idle state, so its fault exit is the neutral ring and core a
// placed machine shows. The refused-drop ghost body keeps the fault accent (a refusal, D-07).
//
// THE GRADE IS PIXELS, never a snapshot: the clip at the ghost's fault-nub anchor plus or minus 7
// px, read with the shared hue predicate `shared/redPixel.ts` (phase 92 review WR-B-06; it replaced
// `87-factory-two-emits`'s channel offsets, which missed a brick red), with its NON-VACUITY line. A second capture of the same clip with the tool disarmed must differ
// from the armed one, so the ghost really was drawn where the count looked.

const VIEWPORT = { width: 1280, height: 800 };
/** The hovered cell: the Factory ghost's top-left (the ghost anchors at the pointer's cell). */
const AT: [number, number] = [12, 8];
/** The Factory catalog's fault exit, rot 0: local (1, 2), facing S (`protocol/decode.ts`). */
const FAULT_LOCAL: [number, number] = [1, 2];
const SIDE_S = 2;
/** Half the side of the clip read around the fault-nub anchor. */
const HALF = 7;

/** Two animation frames, so the ghost the last pointer move asked for has been drawn. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/** The red-predicate count of a decoded capture. */
function redCount(png: { data: Uint8Array | Buffer }): number {
  return redPixelCount(png.data);
}

test.describe('CHROME-18 mock: the placement ghost previews a neutral fault exit', () => {
  test('an armed ghost over open floor shows no red', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;

    // PRECONDITION: the ghost's whole 3x3 footprint is on the open canvas.
    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 3; dy++) {
        const pt = await screenCellCentre(page, AT[0] + dx, AT[1] + dy);
        const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
        expect(under, `PRECONDITION: cell (${AT[0] + dx},${AT[1] + dy}) is on the open canvas`).toBe('CANVAS');
      }
    }

    const tool = page.getByRole('button', { name: 'Place Factory' });
    await tool.click();
    await expect(tool, 'the Factory tool is armed').toHaveAttribute('aria-pressed', 'true');
    const hover = await screenCellCentre(page, AT[0], AT[1]);
    await page.mouse.move(hover.x, hover.y);
    await twoFrames(page);

    const a = await screenPoint(page, nubAnchor(AT[0] + FAULT_LOCAL[0], AT[1] + FAULT_LOCAL[1], SIDE_S));
    const clip = { x: Math.floor(a.x - HALF), y: Math.floor(a.y - HALF), width: 2 * HALF + 1, height: 2 * HALF + 1 };
    const armed = PNG.sync.read(await page.screenshot({ clip }));

    await page.keyboard.press('Escape');
    await expect(tool, 'Escape disarmed the tool').toHaveAttribute('aria-pressed', 'false');
    await twoFrames(page);
    const bare = PNG.sync.read(await page.screenshot({ clip }));

    expect(
      isRedPixel((colorOracles.fault >> 16) & 0xff, (colorOracles.fault >> 8) & 0xff, colorOracles.fault & 0xff),
      'NON-VACUITY: the fault accent itself passes the probe',
    ).toBe(true);
    let differ = 0;
    for (let i = 0; i < armed.data.length; i += 4) {
      if (armed.data[i] !== bare.data[i] || armed.data[i + 1] !== bare.data[i + 1] || armed.data[i + 2] !== bare.data[i + 2]) differ += 1;
    }
    const red = redCount(armed);
    console.log(`P92-CHROME-18 ghost clip=${JSON.stringify(clip)} red=${red} differ=${differ} bare_red=${redCount(bare)}`);
    expect(differ, 'NON-VACUITY: the armed ghost is drawn in the clip (it differs from the disarmed board)').toBeGreaterThan(0);
    expect(
      red,
      `RED-FIRST CHROME-18-ghost-mock: red-pixel count in the ${clip.width}x${clip.height} clip at the armed Factory ghost's fault exit over open floor`,
    ).toBe(0);
  });
});
