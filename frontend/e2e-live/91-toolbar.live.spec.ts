import { test, expect, type Page } from '@playwright/test';
import {
  expectRenderLoopAlive,
  handPlaceAt,
  loadExample,
  pollScene,
  readScene,
  recordStatusStripDuring,
  resetToDemo,
  restoreHostAfterFailedTest,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 91-toolbar.live.spec.ts (phase 91, plan 91-10, CHROME-15 and CHROME-20, D-14 and D-16, success
// criterion 3, UI-SPEC walk steps 7 and 8) - the toolbar holds still and reads cleanly on the REAL
// host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero
// injected packets: the boards are the three shipped examples, loaded through the Examples popover
// the way a user loads them.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-15: still broken`)
// ---------------------------------------------------------------------------
//
// The header was one flex row with the transport centred by an auto margin and the scene badge in
// the brand cluster beside the lockup, the row's clip victim. So Play moved whenever the badge's
// text changed, the badge was cut mid-word, and at 1024 CSS px (and at a 1280 window on the user's
// 1.18 text scale, 1083 CSS px) the wordmark was a sliver.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. At 1280x720 and 1083x677, Play's left x is the same on the demo, after `Order processing`
//      and after `Advanced pipeline`, and the lockup is drawn whole (its whole box inside the
//      column that holds it).
//   2. At 1083x677 and 1280x720, each example's name reads whole in the scene badge inside the
//      status strip (its text and title the name, nothing cut); on the demo the strip recorder
//      `recordStatusStripDuring` never records the scene name (it drops the badge, so the strip
//      record of `90-sim-fatal.terminal.spec.ts` still holds only its stop); and with the demo
//      dirty and Examples open, `Unsaved` and the badge are clear of the popover and `Unsaved`
//      is what is painted at its own centre.
//
// RED FIRST (D-17): each leg run once against PHASE91_START by `redfirst.sh` (the kept start
// worktree's host and frontend, this spec carried in); the record is in 91-EVIDENCE.md.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** The two live sizes: a common window, and a 1280 x 800 window at the user's 1.18 text scale. */
const SIZES = [
  { width: 1280, height: 720 },
  { width: 1083, height: 677 },
] as const;

/** Play's left x and the lockup's box against the part of it its clipping ancestor shows. */
async function readRow(page: Page) {
  return page.evaluate(() => {
    const play = document.querySelector('header button[aria-label="Play"], header button[aria-label="Pause"]');
    if (play === null) throw new Error('no transport toggle');
    const lockup = document.querySelector('header [data-testid="header-lockup"]');
    if (lockup === null) throw new Error('no header lockup');
    const r = lockup.getBoundingClientRect();
    let clip: Element | null = null;
    for (let el = lockup.parentElement; el !== null && el.tagName !== 'HEADER'; el = el.parentElement) {
      if (getComputedStyle(el).overflowX !== 'visible') {
        clip = el;
        break;
      }
    }
    const c = clip?.getBoundingClientRect();
    const shown = c === undefined ? r.width : Math.max(0, Math.min(r.right, c.right) - Math.max(r.left, c.left));
    return {
      playX: play.getBoundingClientRect().left,
      lockup: { width: r.width, shown, visibility: getComputedStyle(lockup).visibility },
    };
  });
}

/** The scene badge inside the status strip: how many, its text, title and whether it is cut. */
async function readBadge(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector('header [data-fab-status-strip]');
    const badges = strip === null ? [] : Array.from(strip.querySelectorAll<HTMLElement>('[data-fab-scene-badge]'));
    const b = badges[0];
    return {
      inStrip: badges.length,
      text: b === undefined ? null : (b.textContent ?? '').trim(),
      title: b?.getAttribute('title') ?? null,
      cut: b === undefined ? null : b.scrollWidth > b.clientWidth,
    };
  });
}

/** `Unsaved`'s box, the popover's, the badge's, and what is painted at `Unsaved`'s centre. The strip
 *  is `pointer-events: none` by design, so its pointer events are lifted for the one hit test. */
async function readUnsavedUnderPopover(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('header [data-fab-status-strip]');
    const pop = document.querySelector<HTMLElement>('#fab-examples-popover');
    if (strip === null || pop === null) throw new Error('no strip or no open popover');
    const unsaved = Array.from(strip.querySelectorAll<HTMLElement>('*')).find(
      (e) => (e.textContent ?? '').trim() === 'Unsaved' && e.children.length === 0,
    );
    if (unsaved === undefined) throw new Error('no Unsaved badge in the strip');
    const badge = strip.querySelector<HTMLElement>('[data-fab-scene-badge]');
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const lifted = [strip, ...Array.from(strip.querySelectorAll<HTMLElement>('*'))];
    const prev = lifted.map((x) => x.style.pointerEvents);
    lifted.forEach((x) => (x.style.pointerEvents = 'auto'));
    let own = false;
    try {
      const u = unsaved.getBoundingClientRect();
      const hit = document.elementFromPoint(u.left + u.width / 2, u.top + u.height / 2);
      own = hit !== null && (hit === unsaved || unsaved.contains(hit));
    } finally {
      lifted.forEach((x, i) => (x.style.pointerEvents = prev[i]));
    }
    return { unsaved: box(unsaved), badge: badge === null ? null : box(badge), popover: box(pop), own };
  });
}

function overlap(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** An empty cell on the demo board, for the one edit that makes it unsaved (as 90-tab-title). */
const DIRTY_CELL: readonly [number, number] = [10, 12];

/** Fonts settled, so a text width read is the shipped face's. */
async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.load('12px "Martian Mono"');
    await document.fonts.ready;
  });
}

test.describe('91 live: the toolbar holds still and reads cleanly (CHROME-15)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: Play stays in one column across the three examples, and the wordmark is whole', async ({ page }) => {
    test.setTimeout(180_000);
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
    await page.goto('/');
    await waitForAppReady(page);
    await fontsReady(page);

    const faults: string[] = [];
    for (const size of SIZES) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const reads: { scene: string; playX: number; lockup: { width: number; shown: number; visibility: string } }[] = [];
      for (const scene of ['Demo scene', 'Order processing', 'Advanced pipeline'] as const) {
        if (scene === 'Demo scene') await resetToDemo(page);
        else if (scene === 'Order processing') await loadExample(page, 'order_processing');
        else await loadExample(page, 'advanced', 12);
        await expect(page.getByText(scene, { exact: true }), `the ${scene} badge shows`).toBeAttached();
        // The lockup's hide is a ResizeObserver's answer, one frame after a resize at most.
        await expect
          .poll(async () => (await readRow(page)).lockup.visibility, { timeout: 2_000 })
          .toBe('visible')
          .catch(() => undefined);
        reads.push({ scene, ...(await readRow(page)) });
      }
      console.log(`P91-CHROME-15 live row ${size.width}x${size.height} ${JSON.stringify(reads)}`);
      const first = reads[0].playX;
      for (const r of reads) {
        if (Math.abs(r.playX - first) > 0.01) {
          faults.push(`${size.width}x${size.height} ${r.scene}: Play at ${r.playX.toFixed(2)}, on the demo ${first.toFixed(2)}`);
        }
        if (r.lockup.visibility !== 'visible' || r.lockup.shown < r.lockup.width - 0.5) {
          faults.push(
            `${size.width}x${size.height} ${r.scene}: the lockup shows ${r.lockup.shown.toFixed(2)} of ${r.lockup.width.toFixed(2)} px (${r.lockup.visibility})`,
          );
        }
      }
      await expectRenderLoopAlive(page, `${size.width}x${size.height}, the advanced example loaded`);
    }
    expect(faults, 'Play keeps its column and the wordmark is whole on every example at both sizes').toEqual([]);
    errs.assertNone('the toolbar column walk');
  });

  test('2: the scene badge reads whole in the status strip, and Unsaved stays clear of the open Examples popover', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1083, height: 677 });
    await page.goto('/');
    await waitForAppReady(page);
    await fontsReady(page);

    const faults: string[] = [];
    for (const size of [
      { width: 1083, height: 677 },
      { width: 1280, height: 720 },
    ] as const) {
      await page.setViewportSize({ width: size.width, height: size.height });
      const at = `${size.width}x${size.height}`;
      for (const scene of ['Demo scene', 'Order processing', 'Advanced pipeline'] as const) {
        if (scene === 'Demo scene') await resetToDemo(page);
        else if (scene === 'Order processing') await loadExample(page, 'order_processing');
        else await loadExample(page, 'advanced', 12);
        await expect(page.getByText(scene, { exact: true }), `${at}: the ${scene} name shows`).toBeAttached();
        const b = await readBadge(page);
        console.log(`P91-CHROME-15 live badge ${at} ${scene} ${JSON.stringify(b)}`);
        if (b.inStrip !== 1 || b.text !== scene || b.title !== scene || b.cut !== false) {
          faults.push(`${at} ${scene}: the badge in the strip reads ${JSON.stringify(b)}`);
        }
        // THE APP FACT (review IN-C05): the badge is its own element in the strip, outside the
        // status line's live region, so a status announcement never reads the scene name and the
        // status line's words never hold it.
        const placed = await page.evaluate((name) => {
          const strip = document.querySelector('header [data-fab-status-strip]');
          const badge = strip?.querySelector('[data-fab-scene-badge]') ?? null;
          const status = strip?.querySelector('[role="status"]') ?? null;
          return {
            badgeInStrip: badge !== null,
            badgeOutsideStatus: badge !== null && status !== null && !status.contains(badge) && !badge.contains(status),
            statusNamesScene: (status?.textContent ?? '').includes(name),
          };
        }, scene);
        if (!placed.badgeInStrip || !placed.badgeOutsideStatus || placed.statusNamesScene) {
          faults.push(`${at} ${scene}: the badge is not its own node beside the status line ${JSON.stringify(placed)}`);
        }
        if (scene === 'Demo scene') {
          // A HELPER SELF-CHECK, not an app fact (review IN-C05): `recordStatusStripDuring` drops
          // `[data-fab-scene-badge]` before it samples, so across a stretch of play its record never
          // names the scene. It fails only if the badge's attribute is renamed under the helper.
          const t0 = (await readScene(page)).tick;
          const seen = await recordStatusStripDuring(page, async () => {
            await pollScene(page, (s) => s.tick, { message: `${at}: the demo plays on past ${t0}` }).toBeGreaterThan(t0 + 30);
          });
          console.log(`P91-CHROME-15 live recorder ${at} ${JSON.stringify(seen)}`);
          const named = seen.filter((t) => t.includes('Demo scene'));
          if (named.length > 0) faults.push(`${at}: helper self-check, the strip recorder recorded the scene name ${JSON.stringify(named)}`);
        }
      }

      // The demo, dirty, with Examples open.
      await resetToDemo(page);
      await handPlaceAt(page, 'Source', DIRTY_CELL[0], DIRTY_CELL[1]);
      await page.keyboard.press('Escape');
      await expect(page.getByText('Unsaved', { exact: true }), `${at}: the placed Source made the demo unsaved`).toBeVisible({
        timeout: 10_000,
      });
      await page.getByRole('button', { name: 'Examples' }).click();
      await expect(page.locator('#fab-examples-popover'), `${at}: the popover opened`).toBeVisible();
      await expect
        .poll(async () => {
          const m = await readUnsavedUnderPopover(page);
          return !overlap(m.unsaved, m.popover) && m.own;
        }, { timeout: 2_000 })
        .toBe(true)
        .catch(() => undefined);
      const m = await readUnsavedUnderPopover(page);
      console.log(`P91-CHROME-15 live popover ${at} ${JSON.stringify(m)}`);
      if (overlap(m.unsaved, m.popover)) faults.push(`${at}: Unsaved is under the open popover`);
      if (m.badge !== null && overlap(m.badge, m.popover)) faults.push(`${at}: the scene badge is under the open popover`);
      if (!m.own) faults.push(`${at}: something else is painted at Unsaved's centre`);
      await page.getByRole('button', { name: 'Examples' }).click();
      await expect(page.locator('#fab-examples-popover'), `${at}: the trigger closed the popover again`).toHaveCount(0);
      await expectRenderLoopAlive(page, `${at}, the dirty demo with Examples closed again`);
    }
    // The shared host goes back to its demo baseline (the edit is discarded through the guard).
    await resetToDemo(page);
    expect(faults, 'the scene badge reads whole in the strip and nothing covers Unsaved').toEqual([]);
    errs.assertNone('the scene badge walk');
  });
});
