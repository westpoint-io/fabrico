import { test, expect, type Page } from '@playwright/test';
import {
  anchorOf,
  cameraOf,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CELL } from '../shared/geometry';

// 91-inspector-dock.live.spec.ts (phase 91, plan 91-09, CHROME-07, D-06, success criterion 2,
// UI-SPEC walk steps 2 to 4) - the inspector docks below the toolbar on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: the machines are the demo board's own.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-07: still broken`)
// ---------------------------------------------------------------------------
//
// The inspector was docked from the window's top to its bottom at the toolbar's own z level and
// mounted after it, so selecting any machine hid the toolbar's right end (Help, New, Save, Load,
// Examples at 1024 wide, Names too at 1280), and the panel ran the full window height.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. At 1024x768 and 1280x800, the demo's Router selected: every toolbar button's centre
//      hit-tests to that button; the panel's top is the shared dock offset (116); its bottom is
//      its content plus padding or the max (8 px above the camera cluster, review WR-B-06), and
//      Fit and the zoom button answer their own centres; Apply answers its own centre; and `New`
//      is pressed and acts (the demo is clean, so it empties the board).
//   2. At 1024x768, the demo's Router (which the Fit puts under the inspector's column there)
//      selected: the board slides left so the Router's footprint, read from `readScene` and
//      `cameraOf`, ends at or left of the panel's left edge less 24, with the zoom and the
//      vertical pan kept.
//
// RED FIRST (D-17): each leg run once against PHASE91_START by `redfirst.sh` (the kept start
// worktree's host and frontend, this spec carried in); the record is in 91-EVIDENCE.md.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** The Router's kind byte (`machine_kind.ROUTER`). */
const KIND_ROUTER = 5;

/** The shared dock offset, `lg + min-target + 2xl` (HelpPanel.tsx), in CSS px. */
const DOCK_TOP = 116;

/** The panel's ring padding, `md + bezel-ring`. */
const PANEL_PAD = 22;

/** The two sizes D-17 grades layout at; the max bottom is 8 px above the camera cluster's top,
 *  the window's bottom less 104 (review WR-B-06; it was the window's bottom less 24, level with
 *  the cluster's bottom, and the Router's panel covered Fit and the zoom button). */
const SIZES = [
  { width: 1024, height: 768, maxBottom: 664 },
  { width: 1280, height: 800, maxBottom: 696 },
] as const;

/** Every visible toolbar button and what its centre hit-tests to, the panel's box, its content's
 *  bottom and the Apply hit test, in one layout read. */
async function readDock(page: Page) {
  return page.evaluate(() => {
    const name = (el: Element | null): string =>
      el === null
        ? 'NOTHING'
        : (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? (el.textContent ?? '').trim().slice(0, 24)) ||
          el.tagName.toLowerCase();
    const panel = document.querySelector<HTMLElement>('aside[aria-labelledby="fab-config-heading"]');
    if (panel === null) throw new Error('no inspector');
    const p = panel.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('header button'))
      .filter((b) => b.offsetWidth > 0 && b.offsetHeight > 0)
      .map((b) => {
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const own = hit !== null && (hit === b || b.contains(hit));
        return { button: name(b), own, hit: own ? '' : name(hit?.closest('aside,header,button') ?? hit) };
      });
    const col = panel.querySelector<HTMLElement>('[data-fab-panel-scroll]');
    if (col === null) throw new Error('no scroll column');
    let contentBottom = -Infinity;
    for (const child of Array.from(col.children) as HTMLElement[]) {
      const r = child.getBoundingClientRect();
      contentBottom = Math.max(contentBottom, r.bottom + parseFloat(getComputedStyle(child).marginBottom));
    }
    const apply = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-fab-action-row] button')).find(
      (x) => (x.textContent ?? '').trim() === 'Apply',
    );
    let applyOwn = false;
    if (apply !== undefined) {
      const r = apply.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      applyOwn = hit !== null && (hit === apply || apply.contains(hit));
    }
    // The camera cluster (review WR-B-06): Fit and the zoom button answer their own centres.
    const ownCentre = (b: HTMLElement | null): boolean => {
      if (b === null) return false;
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && (hit === b || b.contains(hit));
    };
    const fit = document.querySelector<HTMLElement>('button[aria-label="Fit factory to view"]');
    const zoom = document.querySelector<HTMLElement>('button[title="Reset zoom to 100%"]');
    const clusterTop = fit?.parentElement?.getBoundingClientRect().top ?? Number.NaN;
    return {
      panel: { left: p.left, top: p.top, bottom: p.bottom },
      buttons,
      contentBottom,
      scrolls: col.scrollHeight > col.clientHeight + 1,
      apply: { found: apply !== undefined, own: applyOwn },
      cluster: { top: clusterTop, fit: ownCentre(fit), zoom: ownCentre(zoom) },
    };
  });
}

test.describe('91 live: the inspector docks below the toolbar (CHROME-07)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: with the Router selected every toolbar button answers, New acts, and the panel is as tall as its content', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
    await page.goto('/');
    await waitForAppReady(page);

    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await resetToDemo(page);
      const router = (await readScene(page)).nodes.find((n) => n.kind === KIND_ROUTER);
      expect(router, 'the demo board carries a Router').toBeDefined();
      await selectMachineAt(page, ...anchorOf(router!));
      await expect(page.locator('[data-fab-action-row]'), 'the Router panel loaded its Apply row').toBeVisible({
        timeout: 10_000,
      });
      await expectRenderLoopAlive(page, `${size.width}x${size.height}, the Router selected`);

      const d = await readDock(page);
      const line = `${size.width}x${size.height} ${JSON.stringify({ panel: d.panel, contentBottom: d.contentBottom, scrolls: d.scrolls })}`;
      console.log(`P91-CHROME-07 live dock ${line}`);
      expect(d.buttons.length, 'the toolbar shows its buttons').toBeGreaterThanOrEqual(10);
      const covered = d.buttons.filter((b) => !b.own).map((b) => `${b.button} (hit ${b.hit})`);
      expect(covered, `${size.width}x${size.height}: every toolbar button answers its own centre with the Router selected`).toEqual([]);
      expect(Math.abs(d.panel.top - DOCK_TOP), `the panel's top is the shared dock offset (${line})`).toBeLessThanOrEqual(0.5);
      expect(d.panel.bottom, `the panel ends at most at the max bottom, 8 px above the camera cluster (${line})`).toBeLessThanOrEqual(size.maxBottom + 0.5);
      expect(d.panel.bottom, `the panel ends 8 px above the camera cluster's top ${d.cluster.top} (${line})`).toBeLessThanOrEqual(d.cluster.top - 8 + 0.5);
      expect(d.cluster.fit && d.cluster.zoom, `Fit and the zoom button answer their own centres with the Router selected (${line})`).toBe(true);
      if (d.scrolls) {
        expect(Math.abs(d.panel.bottom - size.maxBottom), `a panel taller than the max stops at it (${line})`).toBeLessThanOrEqual(1);
      } else {
        expect(Math.abs(d.panel.bottom - (d.contentBottom + PANEL_PAD)), `the panel is as tall as its content (${line})`).toBeLessThanOrEqual(1);
      }
      expect(d.apply, 'Apply is in view and answers its own centre').toEqual({ found: true, own: true });

      // New, pressed with the Router still selected: the demo is clean, so it acts at once.
      await expect(page.locator('#fab-config-heading'), 'the Router is still selected').toBeVisible();
      await page.getByTitle('New board (Ctrl+N)').click({ timeout: 5_000 });
      await pollScene(page, (s) => s.nodes.length === 0 && s.belts.length === 0, {
        message: `${size.width}x${size.height}: New pressed with the Router selected emptied the board`,
      }).toBe(true);
      await expectRenderLoopAlive(page, `${size.width}x${size.height}, after New`);
    }

    await resetToDemo(page);
    errs.assertNone('the inspector dock walk');
  });

  test('2: the selected Router stays visible: the board slides it 24 px clear of the panel', async ({ page }) => {
    test.setTimeout(90_000);
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    const router = (await readScene(page)).nodes.find((n) => n.kind === KIND_ROUTER);
    expect(router, 'the demo board carries a Router').toBeDefined();
    const before = await cameraOf(page);
    const m0 = footprintOf(router!, before);
    const line0 = `before=${JSON.stringify({ cam: before, m: m0 })}`;
    console.log(`P91-CHROME-07 live nudge ${line0}`);
    // NON-VACUITY: the Fit puts the Router under the column the panel takes at 1024 wide
    // (91-MEASURE.md: x 639..667, the clear line 594.08).
    expect(m0.right, `PRECONDITION: the Router sits under the inspector's column before it is selected (${line0})`).toBeGreaterThan(594.08 + 0.5);
    await expectRenderLoopAlive(page, 'before the Router is selected');

    // The Router is selected by a press on its own visible cell: at 1024 wide its left edge is
    // still open board, and the anchor cell is its top-left (selectMachineAt clicks there).
    await selectMachineAt(page, ...anchorOf(router!));
    const panel = await page.locator('aside[aria-labelledby="fab-config-heading"]').boundingBox();
    expect(panel, 'the Router panel is on screen').not.toBeNull();
    const after = await cameraOf(page);
    const m = footprintOf(router!, after);
    const line = `panel.left=${panel!.x} after=${JSON.stringify({ cam: after, m })}`;
    console.log(`P91-CHROME-07 live nudge ${line}`);
    expect(m.right, `the Router ends at or left of the panel's left edge less 24 (${line})`).toBeLessThanOrEqual(panel!.x - 24 + 0.5);
    expect(after.scale, 'the nudge keeps the zoom').toBe(before.scale);
    expect(after.y, 'the nudge keeps the vertical pan').toBe(before.y);
    await expectRenderLoopAlive(page, 'after the nudge');

    await resetToDemo(page);
    errs.assertNone('the nudge walk');
  });
});

/** A node's footprint on screen, from its cells and a camera snapshot. */
function footprintOf(node: SceneFacts['nodes'][number], cam: { x: number; y: number; scale: number }) {
  const xs = node.cells.map((c) => c[0]);
  const ys = node.cells.map((c) => c[1]);
  return {
    left: Math.min(...xs) * CELL * cam.scale + cam.x,
    top: Math.min(...ys) * CELL * cam.scale + cam.y,
    right: (Math.max(...xs) + 1) * CELL * cam.scale + cam.x,
    bottom: (Math.max(...ys) + 1) * CELL * cam.scale + cam.y,
  };
}
