import { test, expect, type Page } from '@playwright/test';
import { CELL } from '../shared/geometry';
import {
  cameraOf,
  expectRenderLoopAlive,
  readScene,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type CameraSnapshot,
} from './support/oracle';

// 13-help-panel.spec.ts (ONB-03; phase 91, plan 91-06, CHROME-11, D-11, UI-SPEC 8.3, walk
// step 13) - the "?" Help panel on the REAL host (dev_render_server, real Core -> RenderProducer
// -> postcard -> WS). Zero mocks, zero injected packets.
//
// The toggle mirrors the Legend contract: a toolbar button with the stable accessible name
// "Help", closed by default, opening a collapsible `<aside>`; the button carries aria-expanded
// (false -> true -> false) and aria-controls naming the panel id; the panel mounts only while
// open.
//
// PHASE 91 (91-MEASURE.md `## CHROME-11`). The panel used to call a belt a wire, name a `Fit`
// button that carries no such word, leave out Undo, Save and Load and left-drag pan, and lay its
// cells out at line height 1, so a wrapped binding's lines touched. The legs below read the panel
// as the user does and then check the panel's mouse rows against what the board does:
//
//   1. the toggle contract as before; the panel lists `Draw a belt` and `Undo / redo`, and no
//      longer the old wire row; every wrapped binding line sits at least 1.3 times its font size
//      below the line before it (`Range.getClientRects()` over the cell's text);
//   2. the mouse rows are true on the real host: a left drag on empty floor with no tool armed
//      moves the camera (the Pan row), a plain mouse wheel notch changes the zoom (the Zoom row),
//      and the Home key and the corner-brackets Fit button frame the same view (the Fit row).
//      None of it sends a command, so the shared host's board is untouched.
//
// RED FIRST (D-17): both legs ran at PHASE91_START in the kept start worktree (that revision's
// frontend and host, this spec carried) and failed there (91-EVIDENCE.md,
// `D17 case=CHROME-11-live`).
//
//   3. (phase 92, plan 92-05, CHROME-12, D-05) at 1024x768 with the Legend open, Help stops at
//      least 8 px above the strip and does not cover it, and its list, which then scrolls, is
//      reached by Tab. The live config's window is 1280x720, so the leg sets 1024x768, the size
//      the walk measured 344 x 137.5 px covered at.
//
// RED FIRST (D-17, phase 92): leg 3 ran at PHASE92_START in the kept start worktree and failed
// there (92-EVIDENCE.md, `D17 case=CHROME-12-help-live`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** UI-SPEC "Typography": a wrapping line's pitch is at least 1.3 times its font size. */
const MIN_PITCH_RATIO = 1.3;

/** The binding cells' text lines: each cell's distinct line tops and its font size. */
async function bindingLines(page: Page): Promise<{ text: string; fontSize: number; tops: number[] }[]> {
  return page.evaluate(() => {
    const panel = document.getElementById('fab-help-panel');
    if (panel === null) throw new Error('the Help panel is not open');
    const wrappers = Array.from(panel.querySelectorAll('div')).filter(
      (d) => getComputedStyle(d).display === 'contents',
    );
    return wrappers.map((w) => {
      const b = w.children[1]!;
      const range = document.createRange();
      range.selectNodeContents(b);
      const tops: number[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0 || r.height === 0) continue;
        if (!tops.some((t) => Math.abs(t - r.top) < 1)) tops.push(r.top);
      }
      tops.sort((x, y) => x - y);
      return { text: (b.textContent ?? '').trim(), fontSize: parseFloat(getComputedStyle(b).fontSize), tops };
    });
  });
}

/** A screen point on empty floor: over the canvas, its cell and every cell around it empty. */
async function emptyFloorPoint(page: Page): Promise<{ x: number; y: number }> {
  const scene = await readScene(page);
  const cam = await cameraOf(page);
  const taken = new Set<string>();
  for (const n of scene.nodes) for (const [x, y] of n.cells) taken.add(`${x},${y}`);
  for (const b of scene.belts) for (const t of b.tiles) taken.add(`${t.cell_x},${t.cell_y}`);
  for (const w of scene.wires) for (const c of w.path) taken.add(`${c.cell_x},${c.cell_y}`);
  const vp = page.viewportSize()!;
  const candidates: { x: number; y: number }[] = [];
  for (let y = Math.round(vp.height * 0.35); y < vp.height * 0.8; y += 16) {
    for (let x = Math.round(vp.width * 0.3); x < vp.width * 0.75; x += 16) {
      const cx = Math.floor((x - cam.x) / cam.scale / CELL);
      const cy = Math.floor((y - cam.y) / cam.scale / CELL);
      let clear = true;
      for (let dx = -2; dx <= 2 && clear; dx += 1) {
        for (let dy = -2; dy <= 2 && clear; dy += 1) if (taken.has(`${cx + dx},${cy + dy}`)) clear = false;
      }
      if (clear) candidates.push({ x, y });
    }
  }
  // Over the canvas itself, not a panel above it.
  const onCanvas = await page.evaluate(
    (pts) => pts.filter((p) => document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS'),
    candidates,
  );
  expect(onCanvas.length, 'the demo board leaves some empty floor on screen').toBeGreaterThan(0);
  return onCanvas[0]!;
}

/** Drag with the left button from `at` by (dx, dy), in steps, no tool armed. */
async function leftDrag(page: Page, at: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(at.x + dx / 2, at.y + dy / 2);
  await page.mouse.move(at.x + dx, at.y + dy);
  await page.mouse.up({ button: 'left' });
}

const sameCamera = (a: CameraSnapshot, b: CameraSnapshot): boolean =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.scale - b.scale) < 1e-6;

test.describe('ONB-03 "?" help panel (real app, Legend a11y contract)', () => {
  test('is closed by default, toggles open and closed, lists the true rows and keeps wrapped lines apart', async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const help = page.getByRole('button', { name: 'Help' });
    await expect(help, 'the "?" Help toggle is present with the stable name "Help"').toBeVisible();

    // The button aria-controls the panel id; the panel is ABSENT while closed.
    const controls = await help.getAttribute('aria-controls');
    expect(controls, 'the Help button aria-controls the help panel id').toBe('fab-help-panel');
    await expect(help, 'the Help panel is CLOSED by default (aria-expanded false)').toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(
      page.locator('#fab-help-panel'),
      'the help panel is not mounted while closed (zero permanent screen cost)',
    ).toHaveCount(0);

    // Open: aria-expanded flips true, the panel mounts with its heading and the rows.
    await help.click();
    await expect(help, 'clicking opens the panel (aria-expanded true)').toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`#${controls}`);
    await expect(panel, 'the controlled help panel is now present and visible').toBeVisible();
    await expect(
      panel.getByRole('heading', { name: 'Gestures' }),
      'the help panel heading is a real <h2> "Gestures"',
    ).toBeVisible();
    await expect.soft(
      panel.getByText('Draw a belt', { exact: true }),
      'the help panel names drawing a belt (with the Belt tool), not wiring',
    ).toBeVisible();
    await expect.soft(panel.getByText('Undo / redo', { exact: true }), 'the help panel lists undo and redo').toBeVisible();
    await expect.soft(
      panel.getByText('Save / load / new', { exact: true }),
      'the help panel lists the file keys',
    ).toBeVisible();
    await expect.soft(panel.getByText('Wire port to port'), 'the old wire row is gone').toHaveCount(0);

    // Every wrapped binding line keeps its pitch at this window size. (The row checks above are
    // soft, so one run reads both the rows and the pitch.)
    const lines = await bindingLines(page);
    const wrapped = lines.filter((l) => l.tops.length > 1);
    console.log(
      `[91-06 help live] viewport=${JSON.stringify(page.viewportSize())} rows=${lines.length} wrapped=${wrapped.length} ` +
        `pitches=${wrapped.map((l) => (l.tops[1]! - l.tops[0]!).toFixed(2)).join(',')}`,
    );
    expect(wrapped.length, 'at least one binding wraps, so the pitch check reads a real second line').toBeGreaterThan(0);
    for (const l of wrapped) {
      for (let i = 1; i < l.tops.length; i += 1) {
        expect(
          l.tops[i]! - l.tops[i - 1]!,
          `"${l.text}" line ${i + 1} sits at least ${MIN_PITCH_RATIO} times its ${l.fontSize} px font under line ${i}`,
        ).toBeGreaterThanOrEqual(MIN_PITCH_RATIO * l.fontSize);
      }
    }

    // Close: clicking again collapses it (aria-expanded false, panel unmounted).
    await help.click();
    await expect(help, 'clicking again closes the panel (aria-expanded false)').toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.locator('#fab-help-panel'), 'the help panel unmounts when closed').toHaveCount(0);

    await expectRenderLoopAlive(page, 'after the Help panel opened and closed');
    errors.assertNone('during the Help panel toggle');
  });

  test('its mouse rows are true: left drag on empty floor pans, the wheel zooms, Home and the corner-brackets button frame the same view', async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await waitForCameraSettle(page);
    // No tool is armed on a fresh page; nothing holds focus that would keep a key.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Pan: drag empty floor with no tool armed.
    const start = await emptyFloorPoint(page);
    const boardBefore = await readScene(page);
    const before = await cameraOf(page);
    await leftDrag(page, start, -120, -60);
    const panned = await cameraOf(page);
    console.log(`[91-06 help live] pan from ${JSON.stringify(start)} camera ${JSON.stringify(before)} -> ${JSON.stringify(panned)}`);
    expect(panned.x - before.x, 'a left drag on empty floor moves the camera across').toBeCloseTo(-120, 0);
    expect(panned.y - before.y, 'and down').toBeCloseTo(-60, 0);
    expect(panned.scale, 'a pan does not zoom').toBeCloseTo(before.scale, 6);
    const boardAfter = await readScene(page);
    expect(boardAfter.nodes.length, 'the pan placed nothing').toBe(boardBefore.nodes.length);
    expect(boardAfter.belts.length, 'and drew no belt').toBe(boardBefore.belts.length);

    // Zoom: one plain mouse wheel notch, no Ctrl.
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.wheel(0, panned.scale >= 1 ? 200 : -200);
    const zoomed = await cameraOf(page);
    console.log(`[91-06 help live] wheel camera ${JSON.stringify(panned)} -> ${JSON.stringify(zoomed)}`);
    expect(zoomed.scale, 'a plain mouse wheel changes the zoom').not.toBeCloseTo(panned.scale, 4);

    // Fit: Home, then (after moving away again) the corner-brackets button, frame the same view.
    await page.keyboard.press('Home');
    await waitForCameraSettle(page);
    const byHome = await cameraOf(page);
    expect(sameCamera(byHome, zoomed), 'Home moved the camera off the zoomed view').toBe(false);
    await leftDrag(page, await emptyFloorPoint(page), 90, 40);
    const movedAgain = await cameraOf(page);
    expect(sameCamera(movedAgain, byHome), 'the second drag moved the camera away from the fit').toBe(false);
    const fit = page.getByRole('button', { name: 'Fit factory to view' });
    // The button is the four corner brackets and no word: its accessible name is its label, and
    // its visible text is empty.
    expect(((await fit.textContent()) ?? '').trim(), 'the Fit button shows no word').toBe('');
    await fit.click();
    await waitForCameraSettle(page);
    const byButton = await cameraOf(page);
    console.log(`[91-06 help live] fit home=${JSON.stringify(byHome)} button=${JSON.stringify(byButton)}`);
    expect(sameCamera(byButton, byHome), 'Home and the corner-brackets button frame the same view').toBe(true);

    await expectRenderLoopAlive(page, 'after the pan, zoom and fit');
    errors.assertNone('during the mouse-row checks');
  });

  test('Help stops above the open Legend on the real host', async ({ page }) => {
    const errors = watchPageErrors(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await waitForAppReady(page);
    await page.getByRole('button', { name: 'Legend' }).click();
    await expect(page.locator('#fab-legend-panel'), 'the Legend opened').toBeVisible();
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('#fab-help-panel'), 'Help opened').toBeVisible();
    // Two frames, so what is read is what was painted.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const m = await page.evaluate(() => {
      const box = (id: string) => {
        const r = document.getElementById(id)!.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const s = document.querySelector<HTMLElement>('[data-fab-help-scroll]')!;
      return {
        help: box('fab-help-panel'),
        legend: box('fab-legend-panel'),
        scrolls: s.scrollHeight > s.clientHeight,
        tabIndex: s.tabIndex,
      };
    });
    const line = JSON.stringify(m);
    console.log(`[92-05 help live] ${line}`);
    const covers =
      m.help.left < m.legend.right && m.legend.left < m.help.right && m.help.top < m.legend.bottom && m.legend.top < m.help.bottom;
    const w = Math.max(0, Math.min(m.help.right, m.legend.right) - Math.max(m.help.left, m.legend.left));
    const h = Math.max(0, Math.min(m.help.bottom, m.legend.bottom) - Math.max(m.help.top, m.legend.top));
    expect(covers, `RED-FIRST CHROME-12-help-live: at 1024x768 Help covers ${w.toFixed(1)} x ${h.toFixed(1)} px of the open Legend (${line})`).toBe(false);
    expect(m.legend.top - m.help.bottom, `RED-FIRST CHROME-12-help-live: the strip's top is at least 8 px below Help (${line})`).toBeGreaterThanOrEqual(7.5);
    // The list scrolls in the room left, and the keyboard reaches it.
    expect(m.scrolls, `Help's list scrolls above the open Legend (${line})`).toBe(true);
    expect(m.tabIndex, 'the scrolling list is a tab stop').toBe(0);
    let reached = false;
    for (let i = 0; i < 120 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.hasAttribute('data-fab-help-scroll') === true);
    }
    expect(reached, 'Tab reaches the Help list').toBe(true);

    await expectRenderLoopAlive(page, 'with Help and the Legend open');
    errors.assertNone('during the Help and Legend check');
  });
});

