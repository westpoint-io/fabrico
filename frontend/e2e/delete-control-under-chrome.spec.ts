import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, waitForBoard, waitForChrome, type InjectNode } from './support/wire';

// delete-control-under-chrome.spec.ts (phase 92 review WR-B-04, UI review priority fix 1) - the
// selected machine's delete control sits UNDER every chrome panel, so it never covers one and a
// click on a panel never lands on Delete.
//
// WHAT WAS BROKEN. The control's anchor (`App.tsx`, the `deleteAnchorRef` wrapper) was
// `position: absolute; zIndex: 2`, the panels' own level, and it is later in the markup than the
// Palette, the Toolbar, the Legend, Help and the camera cluster, so at equal z-index it painted
// over each of them. On the phase 92 walk at 1024x768, with the demo Factory selected and the
// Legend open, the trash button covered "Sou" of the Legend's `Source` row
// (`b9207/walk/01-legend-1024x768-factory-selected.png`), and a click there deleted the machine.
// The anchor is now at z-index 1, the level the name tags and the label words already use under the
// chrome (`MachineLabels.tsx`), and it still paints over those two because it comes after them.
//
// WHAT IS GRADED, BY HIT TEST. A field of Sources is zoomed in so machines lie under every panel.
// For each panel (the Legend open throughout), a machine on open floor near it is selected and the
// camera is panned with a middle-button drag until the control lies inside the panel; the overlap of
// at least 8 x 8 px is a precondition read off the control's own box. At the centre of that overlap
// `document.elementFromPoint` must return a node inside the panel, never the control. NON-VACUITY:
// with the panel hidden, the same point returns the control, so it really is drawn there. Graded at
// 1024x768 (the walk's size) and 1280x800.

const SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
] as const;

/** A field of Sources, one every third cell, so a zoomed-in board puts machines under every panel. */
const FIELD: InjectNode[] = [];
for (let y = 0; y <= 36; y += 3) {
  for (let x = 0; x <= 54; x += 3) {
    const id = 100 + FIELD.length;
    FIELD.push({ id, kind: 0, cell_x: x, cell_y: y, ports: [{ index: 0, cell_x: x, cell_y: y, side: 1, role: 1, medium: 0 }] });
  }
}

/** The smallest overlap that counts, CSS px on each side. */
const MIN_OVERLAP = 8;
const HIDE_ID = 'fab-test-hide-panel';

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function boxOf(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el === null || el.offsetWidth === 0) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);
}

function overlap(a: Box, b: Box): Box | null {
  const o = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return o.right - o.left >= MIN_OVERLAP && o.bottom - o.top >= MIN_OVERLAP ? o : null;
}

/** Each field machine's screen centre, nearest the panel first. */
async function candidates(page: Page, panel: Box): Promise<{ x: number; y: number }[]> {
  const cam = await page.evaluate(() => (window as { __fabrico?: { camera?(): { x: number; y: number; scale: number } } }).__fabrico!.camera!());
  const cx = (panel.left + panel.right) / 2;
  const cy = (panel.top + panel.bottom) / 2;
  return FIELD.map((n) => ({ x: (n.cell_x + 0.5) * 32 * cam.scale + cam.x, y: (n.cell_y + 0.5) * 32 * cam.scale + cam.y }))
    .map((p) => {
      const dx = Math.max(panel.left - p.x, 0, p.x - panel.right);
      const dy = Math.max(panel.top - p.y, 0, p.y - panel.bottom);
      return { ...p, d: Math.hypot(dx, dy), c: Math.hypot(p.x - cx, p.y - cy) };
    })
    .sort((a, b) => a.d - b.d || a.c - b.c)
    .map(({ x, y }) => ({ x, y }));
}

/** What the top hit-testable node at (x, y) is: 'control', 'panel' (inside `selector`) or its tag. */
async function hitAt(page: Page, x: number, y: number, selector: string): Promise<string> {
  return page.evaluate(
    ([x, y, sel]) => {
      const at = document.elementFromPoint(x, y);
      if (at === null) return 'NONE';
      if (at.closest('.fab-delete-control') !== null) return 'control';
      const panel = document.querySelector(sel);
      if (panel !== null && panel.contains(at)) return 'panel';
      return at.tagName;
    },
    [x, y, selector] as const,
  );
}

/** Two painted frames. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * Select a machine on open floor near `selector`'s panel, then pan the camera (a middle-button drag
 * from open floor) so the machine's delete control lands inside the panel, 12 px in from its edges.
 * Answers the overlap of the control and the panel, read after the pan.
 */
async function selectUnder(page: Page, name: string, selector: string, size: { width: number; height: number }): Promise<Box> {
  const panel = await boxOf(page, selector);
  expect(panel, `PRECONDITION: ${name} is on screen`).not.toBeNull();
  let picked: { x: number; y: number } | null = null;
  for (const p of await candidates(page, panel!)) {
    if (p.x < 0 || p.y < 0 || p.x >= size.width || p.y >= size.height) continue;
    if ((await hitAt(page, p.x, p.y, selector)) === 'CANVAS') {
      picked = p;
      break;
    }
  }
  expect(picked, `PRECONDITION: a field machine near ${name} is on open floor`).not.toBeNull();
  await page.keyboard.press('Escape');
  await page.mouse.click(picked!.x, picked!.y);
  await expect.poll(() => boxOf(page, '.fab-delete-control'), { message: `the machine near ${name} is selected and shows its delete control` }).not.toBeNull();
  // Pan until the control's centre is 12 px inside the panel. A drag can come up short (measured
  // once in a loaded full-suite run: 26.6 px short on the toolbar), so the remaining distance is
  // panned again, up to four drags, each read once the control has stopped moving.
  const settled = async (): Promise<Box> => {
    let prev = (await boxOf(page, '.fab-delete-control'))!;
    for (let i = 0; i < 10; i += 1) {
      await twoFrames(page);
      const next = await boxOf(page, '.fab-delete-control');
      expect(next, `the machine is still selected after the pan`).not.toBeNull();
      if (Math.abs(next!.left - prev.left) < 0.01 && Math.abs(next!.top - prev.top) < 0.01) return next!;
      prev = next!;
    }
    return prev;
  };
  for (let drag = 0; drag < 4; drag += 1) {
    const c = await settled();
    const cx = (c.left + c.right) / 2;
    const cy = (c.top + c.bottom) / 2;
    const tx = Math.min(Math.max(cx, panel!.left + 12), panel!.right - 12);
    const ty = Math.min(Math.max(cy, panel!.top + 12), panel!.bottom - 12);
    if (Math.hypot(tx - cx, ty - cy) < 2) break;
    // Pan from open floor: the window's middle row, at the first column that hits the canvas.
    let from: { x: number; y: number } | null = null;
    for (let x = size.width / 2; x > 0 && from === null; x -= 40) {
      for (const y of [size.height / 2, size.height / 3]) {
        if ((await hitAt(page, x, y, selector)) === 'CANVAS' && (await hitAt(page, x + tx - cx, y + ty - cy, selector)) !== 'NONE') {
          from = { x, y };
          break;
        }
      }
    }
    expect(from, 'PRECONDITION: an open-floor point to pan from').not.toBeNull();
    await page.mouse.move(from!.x, from!.y);
    await page.mouse.down({ button: 'middle' });
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) await page.mouse.move(from!.x + ((tx - cx) * i) / steps, from!.y + ((ty - cy) * i) / steps);
    await page.mouse.up({ button: 'middle' });
  }
  const after = await settled();
  const now = (await boxOf(page, selector))!;
  const o = overlap(after, now);
  expect(o, `PRECONDITION: the delete control overlaps ${name} by ${MIN_OVERLAP} px or more (control ${JSON.stringify(after)}, panel ${JSON.stringify(now)})`).not.toBeNull();
  return o!;
}

async function hidePanel(page: Page, selector: string | null): Promise<void> {
  await page.evaluate(
    ([id, sel]) => {
      document.getElementById(id)?.remove();
      if (sel !== null) {
        const el = document.createElement('style');
        el.id = id;
        el.textContent = `${sel} { visibility: hidden !important; }`;
        document.head.appendChild(el);
      }
    },
    [HIDE_ID, selector] as const,
  );
}

test.describe('the delete control sits under every panel (phase 92 review WR-B-04)', () => {
  for (const size of SIZES) {
    test(`a click on a panel over the selected machine's delete control lands on the panel at ${size.width}x${size.height}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(size);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
      const h = await mockRenderSocket(page, {
        answerQuery: (verb) => (verb === 'machine_config' ? { kind: 'Source', trigger: { kind: 'Webhook' } } : verb === 'webhook_url' ? 'http://127.0.0.1:8787/hook/src-1' : undefined),
      });
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;
      h.inject(buildPacket({ nodes: FIELD }));
      await waitForBoard(page, { machines: FIELD.length });
      await page.mouse.move(size.width / 2, size.height / 2);
      for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, -100);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

      await page.getByRole('button', { name: 'Legend' }).click();
      await expect(page.locator('#fab-legend-panel'), 'the Legend is open').toBeVisible();
      const surfaces: { name: string; selector: string }[] = [
        { name: 'the open Legend', selector: '#fab-legend-panel' },
        { name: 'the palette', selector: '[data-fab-left-dock]' },
        { name: 'the toolbar', selector: 'header.fab-panel' },
        { name: 'the camera cluster', selector: '[data-fab-camera-cluster]' },
      ];
      const fails: string[] = [];
      for (const s of surfaces) {
        const o = await selectUnder(page, s.name, s.selector, size);
        const x = (o.left + o.right) / 2;
        const y = (o.top + o.bottom) / 2;
        const shown = await hitAt(page, x, y, s.selector);
        await hidePanel(page, s.selector);
        const bare = await hitAt(page, x, y, s.selector);
        await hidePanel(page, null);
        console.log(`P92-REVIEW-WRB04 ${size.width}x${size.height} ${s.name} overlap=${JSON.stringify(o)} hit=${shown} hidden_hit=${bare}`);
        expect(bare, `NON-VACUITY: with ${s.name} hidden, the delete control is the top node at (${x.toFixed(1)},${y.toFixed(1)})`).toBe('control');
        if (shown !== 'panel') fails.push(`${s.name}: the top node over the control at (${x.toFixed(1)},${y.toFixed(1)}) is ${shown}`);
      }
      expect(fails, `RED-FIRST WR-B-04: at ${size.width}x${size.height} every panel is above the delete control`).toEqual([]);
    });
  }
});
