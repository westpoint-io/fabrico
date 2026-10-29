import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, waitForBoard, waitForChrome } from './support/wire';

// help-panel-layout.spec.ts (phase 91, plan 91-06, CHROME-11, D-11, UI-SPEC 8.3 and 7.3, walk
// step 13) - the Help panel reads as a clean table at every window size a user meets.
//
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-11`). Both Help cells were laid out at
// `lineHeight: 1`, so a binding that wrapped put its second line 12 px under its first at a
// 12 px font: the descenders of one line touched the ascenders of the next. The panel was also
// capped at 420 px, so most bindings wrapped.
//
// WHAT IS GRADED, BY BOXES AND COMPUTED STYLE (never a snapshot):
//   - every text line of every cell, read off `Range.getClientRects()` over the cell's text, sits
//     at least 1.3 times the computed font size below the line before it (at line height 1.4 the
//     pitch is 16.8 px for a 12 px font); at least one binding wraps, so the check is not empty;
//   - no row's box (its two cells together) overlaps the next row's;
//   - at 1024x768 and 1280x800 the list does not scroll (`scrollHeight === clientHeight` on
//     `[data-fab-help-scroll]`) and the box is not a tab stop, the panel's top is the shared dock
//     offset (116) and its bottom stays 8 px clear of the camera cluster's top (104 px above the
//     window's bottom, review WR-B-06);
//   - at 1083x677 and 1024x640 the list scrolls inside that box, which takes keyboard focus
//     (`tabIndex` 0, reached by Tab) and shows the house 2 px focus outline (the one CSS rule of
//     UI-SPEC 7.3). 1083x677 fitted until review WR-B-06 moved the panel's bottom above the
//     cluster, which used to paint over Help's corner there.
//
// 1083x677 is a CSS VIEWPORT (research Finding O): Chromium's `deviceScaleFactor` does not change
// CSS layout width, so the 1.18 scaled 1280x800 window is graded at the CSS size it lays out at.
//
// RED FIRST (D-17): the pitch cases ran at PHASE91_START in the kept start worktree and failed
// on the 12 px pitch (91-EVIDENCE.md, `D17 case=CHROME-11-mock`).

/** The shared top-right dock offset: lg 24 + min-target 44 + 2xl 48 (UI-SPEC "Spacing Scale"). */
const DOCK_TOP = 116;
/** How far above the window's bottom the top-right slot ends: the camera cluster's inset, its
 *  72 px and an 8 px gap (`CAMERA_CLUSTER_CLEARANCE`, review WR-B-06). */
const CLUSTER_CLEARANCE = 104;
/** The room the Help list keeps clear at its right edge for an overlay scrollbar. WebKitGTK's
 *  idle indicator is about 4 px wide, 2 px in from the edge, but under the pointer the bar widens
 *  to span 6 to 15 px in from the edge (measured on the real app, WebKitGTK 2.54.1, at 1024x640
 *  and in device px at GDK_DPI_SCALE 1.1818, the phase 91 re-certification walk), and the 8 px
 *  room left `middle-` under it. So the room is that 15 px plus the 8 px gap the top-right
 *  panels keep from the camera cluster: 23, which `--fab-space-lg` (24) satisfies. */
const HOVERED_SCROLLBAR_SPAN = 15;
const SCROLLBAR_ROOM = HOVERED_SCROLLBAR_SPAN + 8;
/** UI-SPEC "Typography": a wrapping line's pitch is at least 1.3 times its font size. */
const MIN_PITCH_RATIO = 1.3;

interface CellGeometry {
  text: string;
  fontSize: number;
  /** The distinct line tops of the cell's text, top to bottom. */
  lineTops: number[];
  box: { top: number; bottom: number };
}

interface HelpGeometry {
  panel: { top: number; bottom: number; left: number; right: number };
  scroll: { scrollHeight: number; clientHeight: number; tabIndex: number } | null;
  rows: { gesture: CellGeometry; binding: CellGeometry; box: { top: number; bottom: number } }[];
}

/** Read the open Help panel's geometry: every row's two cells, their text lines and boxes. */
async function helpGeometry(page: Page): Promise<HelpGeometry> {
  return page.evaluate(() => {
    const panel = document.getElementById('fab-help-panel');
    if (panel === null) throw new Error('the Help panel is not open');
    const cell = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops: number[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0 || r.height === 0) continue;
        if (!tops.some((t) => Math.abs(t - r.top) < 1)) tops.push(r.top);
      }
      tops.sort((a, b) => a - b);
      const b = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? '').trim(),
        fontSize: parseFloat(getComputedStyle(el).fontSize),
        lineTops: tops,
        box: { top: b.top, bottom: b.bottom },
      };
    };
    // Each row is a `display: contents` wrapper holding the gesture cell and the binding cell.
    const wrappers = Array.from(panel.querySelectorAll('div')).filter(
      (d) => getComputedStyle(d).display === 'contents',
    );
    const rows = wrappers.map((w) => {
      const [g, b] = Array.from(w.children);
      const gesture = cell(g!);
      const binding = cell(b!);
      return {
        gesture,
        binding,
        box: { top: Math.min(gesture.box.top, binding.box.top), bottom: Math.max(gesture.box.bottom, binding.box.bottom) },
      };
    });
    const s = panel.querySelector('[data-fab-help-scroll]') as HTMLElement | null;
    const p = panel.getBoundingClientRect();
    return {
      panel: { top: p.top, bottom: p.bottom, left: p.left, right: p.right },
      scroll: s === null ? null : { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, tabIndex: s.tabIndex },
      rows,
    };
  });
}

/** Boot the app on the mock host with an empty board and open Help. */
async function openHelp(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 3 }));
  await page.getByRole('button', { name: 'Help' }).click();
  await expect(page.locator('#fab-help-panel')).toBeVisible();
}

/** Every wrapped line keeps its pitch, and no row's box runs into the next row's. */
function expectCleanLines(g: HelpGeometry, where: string): void {
  expect(g.rows.length, `${where}: Help lists its rows`).toBeGreaterThanOrEqual(16);
  let wrapped = 0;
  for (const r of g.rows) {
    expect(r.gesture.lineTops.length, `${where}: gesture "${r.gesture.text}" is one line`).toBe(1);
    const tops = r.binding.lineTops;
    if (tops.length > 1) wrapped += 1;
    for (let i = 1; i < tops.length; i += 1) {
      const pitch = tops[i]! - tops[i - 1]!;
      expect(
        pitch,
        `${where}: "${r.binding.text}" line ${i + 1} sits ${pitch.toFixed(2)} px under line ${i} at a ` +
          `${r.binding.fontSize} px font; at least ${MIN_PITCH_RATIO} times the font size keeps the lines apart`,
      ).toBeGreaterThanOrEqual(MIN_PITCH_RATIO * r.binding.fontSize);
    }
  }
  expect(wrapped, `${where}: at least one binding wraps, so the pitch check reads a real second line`).toBeGreaterThan(0);
  for (let i = 1; i < g.rows.length; i += 1) {
    const above = g.rows[i - 1]!;
    const below = g.rows[i]!;
    expect(
      above.box.bottom,
      `${where}: row "${above.gesture.text}" ends at ${above.box.bottom.toFixed(2)}, ` +
        `above row "${below.gesture.text}" at ${below.box.top.toFixed(2)}`,
    ).toBeLessThanOrEqual(below.box.top + 0.5);
  }
}

test.describe('Help reads cleanly at every checked size (CHROME-11, UI-SPEC 8.3)', () => {
  for (const size of [
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
  ]) {
    const where = `${size.width}x${size.height}`;
    test(`at ${where} every wrapped Help line keeps a 1.3x line pitch, no rows overlap and the list does not scroll`, async ({
      page,
    }) => {
      await openHelp(page, size);
      const g = await helpGeometry(page);
      console.log(
        `[91-06 help] ${where} panel=${g.panel.left.toFixed(1)},${g.panel.top.toFixed(1)}..${g.panel.right.toFixed(1)},` +
          `${g.panel.bottom.toFixed(1)} scroll=${JSON.stringify(g.scroll)} pitches=` +
          g.rows
            .filter((r) => r.binding.lineTops.length > 1)
            .map((r) => (r.binding.lineTops[1]! - r.binding.lineTops[0]!).toFixed(2))
            .join(','),
      );
      expectCleanLines(g, where);
      expect(g.panel.top, `${where}: Help docks at the shared offset`).toBeCloseTo(DOCK_TOP, 0);
      expect(g.panel.bottom, `${where}: Help stops ${CLUSTER_CLEARANCE} px above the window's bottom`).toBeLessThanOrEqual(
        size.height - CLUSTER_CLEARANCE + 0.5,
      );
      expect(g.panel.left, `${where}: Help stays inside the window`).toBeGreaterThanOrEqual(0);
      expect(g.scroll, `${where}: the rows sit in the Help scroll box`).not.toBeNull();
      expect(g.scroll!.scrollHeight, `${where}: the list fits without scrolling`).toBe(g.scroll!.clientHeight);
      // Review WR-B-05: a box with nothing to scroll is not a tab stop (UI-SPEC 7.3).
      expect(g.scroll!.tabIndex, `${where}: the box that does not scroll is not a tab stop`).toBe(-1);
    });
  }

  for (const size of [
    { width: 1083, height: 677 },
    { width: 1024, height: 640 },
  ]) {
    const where = `${size.width}x${size.height}`;
    test(`at ${where} the list scrolls inside a focusable box with the house focus ring`, async ({ page }) => {
      await openHelp(page, size);
      const g = await helpGeometry(page);
      console.log(`[91-06 help] ${where} panel bottom=${g.panel.bottom.toFixed(1)} scroll=${JSON.stringify(g.scroll)}`);
      expect(g.scroll, 'the rows sit in the Help scroll box').not.toBeNull();
      expect(g.scroll!.scrollHeight, 'the list is taller than the room left, so it scrolls').toBeGreaterThan(
        g.scroll!.clientHeight,
      );
      expect(g.scroll!.tabIndex, 'a keyboard can reach the scroll box').toBe(0);
      expect(g.panel.bottom, 'Help stops 8 px above the camera cluster').toBeLessThanOrEqual(size.height - CLUSTER_CLEARANCE + 0.5);
      // The lines that are on screen still keep their pitch.
      expectCleanLines(g, where);

      // Reach it by keyboard (Tab), the way a user would, and read the ring it shows.
      let reached = false;
      for (let i = 0; i < 120 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.hasAttribute('data-fab-help-scroll') === true);
      }
      expect(reached, 'Tab reaches the Help scroll box').toBe(true);
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const cs = getComputedStyle(el);
        return {
          focusVisible: el.matches(':focus-visible'),
          width: cs.outlineWidth,
          style: cs.outlineStyle,
          colour: cs.outlineColor,
          focusToken: getComputedStyle(document.documentElement).getPropertyValue('--fab-focus').trim(),
        };
      });
      console.log(`[91-06 help] 1024x640 focus ring ${JSON.stringify(ring)}`);
      expect(ring.focusVisible, 'the box is keyboard-focused').toBe(true);
      expect(ring.width, 'the house focus outline is 2 px').toBe('2px');
      expect(ring.style).toBe('solid');
      // In the house focus colour (`--fab-focus`), not the browser's own ring.
      const hex = ring.focusToken.replace('#', '');
      const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
      expect(hex, 'the focus token is a six-digit colour').toMatch(/^[0-9a-f]{6}$/i);
      expect(ring.colour, 'the ring is the --fab-focus colour').toBe(rgb);
      // And the box scrolls by keyboard once focused.
      await page.keyboard.press('End');
      await expect
        .poll(() => page.evaluate(() => (document.querySelector('[data-fab-help-scroll]') as HTMLElement).scrollTop), {
          message: 'End scrolls the focused Help list',
        })
        .toBeGreaterThan(0);
    });
  }

  // PHASE 91 UI REVIEW ITEM 5: NO BINDING RUNS UNDER THE SCROLLBAR. WebKitGTK draws an OVERLAY
  // scrollbar: it takes no layout width (`clientWidth` equals `offsetWidth` while the list
  // scrolls, measured in MiniBrowser 2.54.1 at 1024x640 and at 1083x677 under GDK_DPI_SCALE
  // 1.1818) and paints over the box's right edge, and the Pan row's text ended exactly on that
  // edge (986 of 986, 1045.1 of 1045.1), so `middle-` ran under it (the 91-11 walk). Under the
  // pointer the bar widens to 15 px from the edge, which an 8 px room did not clear (the phase 91
  // re-certification walk on the real app: ink right 977 against the hovered bar from 971 at
  // 1024x640, 1224 against 1220 in device px at 1.1818). Graded by
  // the text itself: every line of every cell, read off `Range.getClientRects()`, ends at least
  // `SCROLLBAR_ROOM` inside the scroll box's client area, and inside the panel's content box.
  for (const size of [
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1083, height: 677 },
    { width: 1024, height: 640 },
  ]) {
    const where = `${size.width}x${size.height}`;
    test(`at ${where} no Help text runs past its column or under the scrollbar`, async ({ page }) => {
      await openHelp(page, size);
      const m = await page.evaluate(() => {
        const panel = document.getElementById('fab-help-panel')!;
        const box = panel.querySelector<HTMLElement>('[data-fab-help-scroll]')!;
        const b = box.getBoundingClientRect();
        const clientRight = b.left + box.clientLeft + box.clientWidth;
        const pr = panel.getBoundingClientRect();
        const pcs = getComputedStyle(panel);
        const contentRight = pr.right - parseFloat(pcs.paddingRight) - parseFloat(pcs.borderRightWidth);
        const spans = Array.from(box.querySelectorAll('span'));
        let worst = { text: '', right: -Infinity };
        for (const sp of spans) {
          const range = document.createRange();
          range.selectNodeContents(sp);
          for (const r of Array.from(range.getClientRects())) {
            if (r.width > 0 && r.right > worst.right) worst = { text: (sp.textContent ?? '').trim(), right: r.right };
          }
        }
        return { clientRight, contentRight, scrolls: box.scrollHeight > box.clientHeight, spans: spans.length, worst };
      });
      const line = `${where} ${JSON.stringify(m)}`;
      console.log(`P91-UI5 help ${line}`);
      expect(m.spans, 'NON-VACUITY: the rows were read').toBeGreaterThanOrEqual(32);
      expect(
        m.worst.right,
        `${where}: "${m.worst.text}" ends ${SCROLLBAR_ROOM} px inside the scroll box, clear of an overlay scrollbar (${line})`,
      ).toBeLessThanOrEqual(m.clientRight - SCROLLBAR_ROOM + 0.5);
      expect(m.worst.right, `${where}: and inside the panel's content box (${line})`).toBeLessThanOrEqual(m.contentRight + 0.5);
    });
  }

  // Review WR-B-05: SPACE AND HOME ARE THE FOCUSED LIST'S OWN KEYS. The board's Space (play or
  // pause) and App's Home (fit the view) stood down only for a focused button, field, select or
  // contentEditable, so with the Help list focused Space toggled play and Home fitted the view
  // (both `preventDefault`) instead of scrolling the list.
  test('at 1024x640 Space and Home scroll the focused list, and neither plays nor fits the board', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    const h = await mockRenderSocket(page);
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 3, nodes: [{ id: 1, kind: 0, cell_x: 4, cell_y: 4 }] }));
    await waitForBoard(page, { machines: 1, tick: 3 });
    // Zoom away from the fit, so a Home press would move the camera (the non-vacuity leg below).
    await page.mouse.move(300, 400);
    await page.mouse.wheel(0, 400);
    await page.getByRole('button', { name: 'Help' }).click();
    const box = page.locator('[data-fab-help-scroll]');
    await expect(box).toBeVisible();
    const scrollTop = () => box.evaluate((el) => (el as HTMLElement).scrollTop);
    const camera = () =>
      page.evaluate(() => (window as { __fabrico?: { camera?(): unknown } }).__fabrico?.camera?.() ?? null);
    expect(await camera(), 'PRECONDITION: the camera hook reads').not.toBeNull();
    await box.focus();
    await expect(box, 'the list has focus').toBeFocused();
    const cam = await camera();
    const controlsBefore = h.controls.length;

    await page.keyboard.press(' ');
    await expect.poll(scrollTop, { message: 'Space scrolls the focused list down' }).toBeGreaterThan(0);
    await page.waitForTimeout(200);
    expect(h.controls.slice(controlsBefore), 'Space sent no pause or resume').toEqual([]);

    await page.keyboard.press('Home');
    await expect.poll(scrollTop, { message: 'Home scrolls the focused list back to its top' }).toBe(0);
    expect(await camera(), 'Home did not fit the board').toEqual(cam);

    // NON-VACUITY: off the list, the same two keys are the board's.
    await box.evaluate((el) => (el as HTMLElement).blur());
    await page.keyboard.press(' ');
    await expect.poll(() => h.controls.length - controlsBefore, { message: 'off the list, Space plays or pauses' }).toBeGreaterThan(0);
    await page.keyboard.press('Home');
    await expect.poll(camera, { message: 'off the list, Home fits the board' }).not.toEqual(cam);
  });
});

// ---------------------------------------------------------------------------------------------
// PHASE 92 (plan 92-05, CHROME-12, D-05, UI-SPEC 2, RESEARCH Finding L): HELP STOPS 8 PX ABOVE THE
// OPEN LEGEND, AND SCROLLS INSIDE THAT BOX.
//
// WHAT WAS BROKEN (92-MEASURE.md `### 12d`). Help's bottom bound was the camera cluster alone, and
// Help is deliberately not a corner dock (as one, the Legend strip would be 198 px at 1024 wide and
// refuse to open), so it never learned the strip's top. With both open it painted over the strip:
// 344 x 137.5 px at 1024x768, 344 x 141.6 px at 1083x677 and 344 x 9.5 px at 1280x800.
//
// WHAT IS GRADED, BY BOXES (never a snapshot): with the Legend opened first and with Help opened
// first, at the four sizes, the two panels do not intersect and the strip's top is at least 7.5 px
// below Help's bottom; Help's top is the shared dock offset; the strip keeps its Help-closed left and
// right edges (Help does not narrow it); and the two boxes are read after EVERY painted frame for 30
// frames after the toggle (and below, after a resize with both open), none intersecting. Each frame
// is read just after it paints (a `setTimeout(0)` queued from its `requestAnimationFrame`), and a
// reading counts only when the layout it reads is the one that frame painted: the container's size
// and the two panels' presence are taken in the frame's `requestAnimationFrame` and must be the same
// at the read (review WR-B-01, WR-C-01). Without that rule a window resize landing between a paint
// and the read made the read force a layout at the new size before the ResizeObserver that rewrites
// `--fab-legend-top` had run, so it saw Help under the bound of the old size (344 x 122 px, the
// recorded flake), a state no frame ever paints. The non-vacuity case below reproduces that read on
// purpose and shows the rule drops it.
//
// FONTS FIRST (review WR-B-02, WR-C-01). Both chrome faces are `font-display: block`, and the
// Palette is `width: fit-content`, so until the web font lands the Palette, and the strip's left
// edge after it, sit where the fallback face put them. `bootEmpty` waits for `document.fonts.ready`
// and two frames before any box is read, as `legend-lines.spec.ts` does.
// The room cases: at 1024x640 and 1083x677 the first three Help rows fit in the box at scrollTop 0,
// and where Help scrolls its list is a tab stop whose last row scrolls into view.
//
// RED FIRST (D-17): seen failing at PHASE92_START in the kept start worktree (92-EVIDENCE.md,
// `D17 case=CHROME-12-help-mock`).
// ---------------------------------------------------------------------------------------------

/** The gap Help keeps above the open Legend (`--fab-space-sm`), less half a pixel of rounding. */
const LEGEND_CLEARANCE_MIN = 8 - 0.5;
/** Frames read after each toggle or resize (UI-SPEC 2.4). */
const PROBE_FRAMES = 30;

interface PanelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const intersects = (a: PanelBox, b: PanelBox): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const overlapOf = (a: PanelBox, b: PanelBox): string =>
  `${Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)).toFixed(1)} x ` +
  `${Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)).toFixed(1)} px`;

async function bootEmpty(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 3 }));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** The two panels' boxes now, or null for a panel that is not open. */
async function panelBoxes(page: Page): Promise<{ help: PanelBox | null; legend: PanelBox | null }> {
  return page.evaluate(() => {
    const box = (id: string) => {
      const el = document.getElementById(id);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    return { help: box('fab-help-panel'), legend: box('fab-legend-panel') };
  });
}

/**
 * Arm the per-frame probe in the page: once both panels are open (and, for a resize, the window is
 * `width` wide), read both boxes just after each of the next `frames` paints. Resolve with
 * `collectFrames`.
 *
 * A reading counts only for a frame that painted what it reads (review WR-B-01): the positioning
 * container's size and the two panels' presence are taken in the frame's `requestAnimationFrame`,
 * before that frame's layout, and the read in the `setTimeout(0)` after its paint must find the same
 * size and both panels again. A resize or a toggle that lands between the paint and the read is left
 * to the next frame, which lays it out and runs the ResizeObserver before it paints.
 *
 * `opts.unfiltered` turns the rule off and `opts.squeezeAt` makes the positioning container the
 * panels' containing block at that many px wide inside the first read, just before it: the two
 * together are the non-vacuity case, which makes the old probe read a layout no frame paints.
 */
async function armFrameProbe(
  page: Page,
  frames: number,
  width: number | null,
  opts: { unfiltered?: boolean; squeezeAt?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ frames: n, width: w, unfiltered, squeezeAt }) => {
      type B = { left: number; top: number; right: number; bottom: number };
      const out: { help: B; legend: B }[] = [];
      const state = { out, done: false, dropped: 0 };
      (window as unknown as { __fab9205Probe: typeof state }).__fab9205Probe = state;
      const box = (id: string): B | null => {
        const el = document.getElementById(id);
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      // The container App measures the band in (`App.tsx`: the Palette's offsetParent, else body).
      const container = (): HTMLElement =>
        (document.querySelector<HTMLElement>('[data-fab-left-dock]')?.offsetParent as HTMLElement | null) ?? document.body;
      const layoutKey = (): string => {
        const c = container();
        const both = document.getElementById('fab-help-panel') !== null && document.getElementById('fab-legend-panel') !== null;
        return `${window.innerWidth}x${window.innerHeight}|${c.clientWidth}x${c.clientHeight}|${both ? 'both' : 'not-both'}`;
      };
      let squeezed = false;
      const frame = (): void => {
        const painted = layoutKey();
        setTimeout(() => {
          if (squeezeAt !== undefined && !squeezed) {
            squeezed = true;
            // The body is `position: static`, so the panels sit in the viewport's box; made the
            // panels' containing block at `squeezeAt` px wide, it re-lays them out exactly as a
            // window that wide would, while the ResizeObserver on it has not yet run.
            const c = container();
            c.style.position = 'relative';
            c.style.height = '100vh';
            c.style.width = `${squeezeAt}px`;
          }
          const help = box('fab-help-panel');
          const legend = box('fab-legend-panel');
          const atSize = w === null || window.innerWidth === w;
          const rendered = unfiltered === true || layoutKey() === painted;
          if (help !== null && legend !== null && atSize && rendered) out.push({ help, legend });
          else if (help !== null && legend !== null && atSize) state.dropped += 1;
          if (out.length >= n) {
            state.done = true;
            return;
          }
          requestAnimationFrame(frame);
        }, 0);
      };
      requestAnimationFrame(frame);
    },
    { frames, width, unfiltered: opts.unfiltered, squeezeAt: opts.squeezeAt },
  );
}

async function collectFrames(page: Page): Promise<{ help: PanelBox; legend: PanelBox }[]> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __fab9205Probe: { done: boolean } }).__fab9205Probe.done), {
      message: 'the frame probe read its frames',
      timeout: 15_000,
    })
    .toBe(true);
  return page.evaluate(
    () => (window as unknown as { __fab9205Probe: { out: { help: PanelBox; legend: PanelBox }[] } }).__fab9205Probe.out,
  );
}

/** The Help scroll box and its rows, read now. */
async function helpRows(page: Page): Promise<{
  box: PanelBox;
  scrollHeight: number;
  clientHeight: number;
  tabIndex: number;
  rows: { text: string; top: number; bottom: number }[];
}> {
  return page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[data-fab-help-scroll]')!;
    const b = s.getBoundingClientRect();
    const top = b.top + s.clientTop;
    const rows = Array.from(s.querySelectorAll('div'))
      .filter((d) => getComputedStyle(d).display === 'contents')
      .map((w) => {
        const cells = Array.from(w.children).map((c) => c.getBoundingClientRect());
        return {
          text: (w.firstElementChild?.textContent ?? '').trim(),
          top: Math.min(...cells.map((c) => c.top)),
          bottom: Math.max(...cells.map((c) => c.bottom)),
        };
      });
    return {
      box: { left: b.left, top, right: b.right, bottom: top + s.clientHeight },
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
      tabIndex: s.tabIndex,
      rows,
    };
  });
}

function expectClear(help: PanelBox, legend: PanelBox, where: string): void {
  const line = `${where} help=${JSON.stringify(help)} legend=${JSON.stringify(legend)}`;
  expect(
    intersects(help, legend),
    `RED-FIRST CHROME-12-help-mock: ${where} Help covers ${overlapOf(help, legend)} of the open Legend (${line})`,
  ).toBe(false);
  expect(
    legend.top - help.bottom,
    `RED-FIRST CHROME-12-help-mock: ${where} the strip's top sits at least 8 px below Help's bottom (${line})`,
  ).toBeGreaterThanOrEqual(LEGEND_CLEARANCE_MIN);
  expect(help.top, `${where} Help docks at the shared offset`).toBeCloseTo(DOCK_TOP, 0);
  expect(Math.abs(help.top - DOCK_TOP), `${where} Help's top is ${DOCK_TOP} within 0.5`).toBeLessThanOrEqual(0.5);
}

const BOTH_SIZES: { width: number; height: number; dsf: number }[] = [
  { width: 1024, height: 768, dsf: 1 },
  { width: 1083, height: 677, dsf: 1.1818 },
  { width: 1280, height: 800, dsf: 1 },
  { width: 1440, height: 900, dsf: 1 },
];

for (const size of BOTH_SIZES) {
  const where = `${size.width}x${size.height}${size.dsf === 1 ? '' : ` at ${size.dsf}`}`;
  test.describe(`Help and the open Legend at ${where} (CHROME-12, D-05)`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dsf });

    test(`Help and the open Legend never intersect at ${where}, the Legend opened first`, async ({ page }) => {
      await bootEmpty(page);
      await page.getByRole('button', { name: 'Legend' }).click();
      await expect(page.locator('#fab-legend-panel')).toBeVisible();
      const alone = (await panelBoxes(page)).legend!;
      await armFrameProbe(page, PROBE_FRAMES, null);
      await page.getByRole('button', { name: 'Help' }).click();
      await expect(page.locator('#fab-help-panel')).toBeVisible();
      const frames = await collectFrames(page);
      const now = await panelBoxes(page);
      console.log(`[92-05 help] ${where} legend-first help=${JSON.stringify(now.help)} legend=${JSON.stringify(now.legend)}`);
      expectClear(now.help!, now.legend!, `at ${where}, the Legend opened first,`);
      frames.forEach((f, i) =>
        expect(intersects(f.help, f.legend), `at ${where} frame ${i + 1} after Help opened: ${overlapOf(f.help, f.legend)} covered`).toBe(false),
      );
      // Help is not a corner dock: it never narrows the strip.
      expect(Math.abs(now.legend!.left - alone.left), `at ${where} the strip's left edge is unchanged by Help`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(now.legend!.right - alone.right), `at ${where} the strip's right edge is unchanged by Help`).toBeLessThanOrEqual(0.5);
      // Where Help scrolls, its list is a tab stop and its last row scrolls into view.
      const r = await helpRows(page);
      console.log(`[92-05 help] ${where} scroll=${r.scrollHeight}/${r.clientHeight} tab=${r.tabIndex}`);
      if (r.scrollHeight > r.clientHeight) {
        expect(r.tabIndex, `at ${where} the scrolling list is a tab stop`).toBe(0);
        await page.evaluate(() => {
          const s = document.querySelector<HTMLElement>('[data-fab-help-scroll]')!;
          s.scrollTop = s.scrollHeight;
        });
        const end = await helpRows(page);
        const last = end.rows[end.rows.length - 1]!;
        expect(last.text, 'the last row is Step one tick').toBe('Step one tick');
        expect(last.top, `at ${where} the last row's top is inside the list`).toBeGreaterThanOrEqual(end.box.top - 0.5);
        expect(last.bottom, `at ${where} the last row's bottom is inside the list`).toBeLessThanOrEqual(end.box.bottom + 0.5);
      }
    });

    test(`Help and the open Legend never intersect at ${where}, Help opened first`, async ({ page }) => {
      await bootEmpty(page);
      await page.getByRole('button', { name: 'Help' }).click();
      await expect(page.locator('#fab-help-panel')).toBeVisible();
      const helpAlone = (await panelBoxes(page)).help!;
      await armFrameProbe(page, PROBE_FRAMES, null);
      await page.getByRole('button', { name: 'Legend' }).click();
      await expect(page.locator('#fab-legend-panel')).toBeVisible();
      const frames = await collectFrames(page);
      const now = await panelBoxes(page);
      console.log(`[92-05 help] ${where} help-first help=${JSON.stringify(now.help)} legend=${JSON.stringify(now.legend)}`);
      expectClear(now.help!, now.legend!, `at ${where}, Help opened first,`);
      frames.forEach((f, i) =>
        expect(intersects(f.help, f.legend), `at ${where} frame ${i + 1} after the Legend opened: ${overlapOf(f.help, f.legend)} covered`).toBe(false),
      );
      // Closing the Legend gives Help its cluster bound back (review WR-C-02): Help's box with the
      // Legend closed again equals its box before the Legend opened, so a bound left behind by the
      // closed strip (`--fab-legend-top` not removed) holds Help short and fails here. Where the
      // open strip held Help, the box it gets back is taller than the held one.
      await page.getByRole('button', { name: 'Legend' }).click();
      await expect(page.locator('#fab-legend-panel')).toHaveCount(0);
      const alone = (await panelBoxes(page)).help!;
      expect(alone.bottom, `at ${where} with the Legend closed Help stops ${CLUSTER_CLEARANCE} px above the bottom`).toBeLessThanOrEqual(
        size.height - CLUSTER_CLEARANCE + 0.5,
      );
      expect(Math.abs(alone.bottom - helpAlone.bottom), `at ${where} Help is back at its own bound once the Legend closes`).toBeLessThanOrEqual(0.5);
      if (now.help!.bottom < helpAlone.bottom - 1) {
        expect(alone.bottom, `at ${where} Help is no longer held above the strip`).toBeGreaterThan(now.help!.bottom + 1);
      }
    });
  });
}

test.describe('Help and the open Legend through a window resize (CHROME-12, D-05)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('Help and the open Legend never intersect through a resize from 1280x800 to 1024x768', async ({ page }) => {
    await bootEmpty(page);
    await page.getByRole('button', { name: 'Legend' }).click();
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('#fab-legend-panel')).toBeVisible();
    await expect(page.locator('#fab-help-panel')).toBeVisible();
    await armFrameProbe(page, PROBE_FRAMES, 1024);
    await page.setViewportSize({ width: 1024, height: 768 });
    const frames = await collectFrames(page);
    const now = await panelBoxes(page);
    console.log(`[92-05 help] resize help=${JSON.stringify(now.help)} legend=${JSON.stringify(now.legend)} frames=${frames.length}`);
    expect(frames.length, 'NON-VACUITY: frames were read at the new size').toBe(PROBE_FRAMES);
    frames.forEach((f, i) =>
      expect(
        intersects(f.help, f.legend),
        `RED-FIRST CHROME-12-help-mock: frame ${i + 1} after the resize: Help covers ${overlapOf(f.help, f.legend)} of the open Legend`,
      ).toBe(false),
    );
    expectClear(now.help!, now.legend!, 'after the resize to 1024x768,');
  });

  // A STRIP THAT MOUNTS AFTER THE EFFECT RAN IS STILL MEASURED (review WR-B-03). At 520 px wide the
  // band refuses and the open Legend unmounts; widened again, the band is measured from the
  // container's observer and the strip mounts in a later commit. The measuring effect used to re-run
  // only when `legendOpen` changed, which it did not, so the new strip was never observed and the
  // bound it should write for Help was missing: Help opened over it. Graded after Help opens at
  // 1280x800, then through a resize to 1024x768 that adds strip lines.
  test('Help clears a Legend that mounted again after the band refused', async ({ page }) => {
    await bootEmpty(page);
    await page.getByRole('button', { name: 'Legend' }).click();
    await expect(page.locator('#fab-legend-panel')).toBeVisible();
    await page.setViewportSize({ width: 520, height: 800 });
    await expect(page.locator('#fab-legend-panel'), 'PRECONDITION: at 520 px the band refuses and the strip unmounts').toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('#fab-legend-panel'), 'the strip mounts again at 1280 px').toBeVisible();
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('#fab-help-panel')).toBeVisible();
    await armFrameProbe(page, PROBE_FRAMES, null);
    const frames = await collectFrames(page);
    frames.forEach((f, i) =>
      expect(
        intersects(f.help, f.legend),
        `RED-FIRST WR-B-03: frame ${i + 1} after Help opened over the re-mounted strip: Help covers ${overlapOf(f.help, f.legend)}`,
      ).toBe(false),
    );
    const now = await panelBoxes(page);
    expectClear(now.help!, now.legend!, 'over the re-mounted strip at 1280x800,');
    await armFrameProbe(page, PROBE_FRAMES, 1024);
    await page.setViewportSize({ width: 1024, height: 768 });
    const after = await collectFrames(page);
    after.forEach((f, i) =>
      expect(intersects(f.help, f.legend), `frame ${i + 1} after the resize to 1024x768: Help covers ${overlapOf(f.help, f.legend)}`).toBe(false),
    );
    const end = await panelBoxes(page);
    expectClear(end.help!, end.legend!, 'over the re-mounted strip after the resize to 1024x768,');
  });

  // NON-VACUITY for the frame rule (review WR-B-01). Inside the first read, just after a paint, the
  // positioning container (the body) becomes the panels' containing block at 1024 px wide, which
  // re-lays them out as a 1024 px window does, and the boxes are read at once, before any
  // ResizeObserver can run. The old probe (`unfiltered`) records
  // that read and sees Help under the 1280 px bound; the rule drops it, and every frame it keeps,
  // each laid out and observed before its paint, is clear.
  test('the frame rule drops a read taken between a paint and the observer that follows a resize', async ({ page }) => {
    await bootEmpty(page);
    await page.getByRole('button', { name: 'Legend' }).click();
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('#fab-legend-panel')).toBeVisible();
    await expect(page.locator('#fab-help-panel')).toBeVisible();
    await armFrameProbe(page, 1, null, { unfiltered: true, squeezeAt: 1024 });
    const stale = await collectFrames(page);
    console.log(`[92-review WR-B-01] unfiltered read after the squeeze: ${overlapOf(stale[0].help, stale[0].legend)}`);
    expect(
      intersects(stale[0].help, stale[0].legend),
      'NON-VACUITY: the read between the paint and the observer sees Help under the old bound',
    ).toBe(true);
    await page.evaluate(() => {
      const c = (document.querySelector<HTMLElement>('[data-fab-left-dock]')?.offsetParent as HTMLElement | null) ?? document.body;
      for (const k of ['position', 'height', 'width']) c.style.removeProperty(k);
    });
    await expect.poll(async () => {
      const b = await panelBoxes(page);
      return intersects(b.help!, b.legend!);
    }, { message: 'the container back at its own width, the panels are clear again' }).toBe(false);
    await armFrameProbe(page, PROBE_FRAMES, null, { squeezeAt: 1024 });
    const frames = await collectFrames(page);
    const dropped = await page.evaluate(() => (window as unknown as { __fab9205Probe: { dropped: number } }).__fab9205Probe.dropped);
    expect(dropped, 'the rule dropped the read taken before the observer ran').toBeGreaterThanOrEqual(1);
    frames.forEach((f, i) =>
      expect(intersects(f.help, f.legend), `frame ${i + 1} after the squeeze: Help covers ${overlapOf(f.help, f.legend)} of the open Legend`).toBe(false),
    );
  });
});

for (const size of [
  { width: 1024, height: 640, dsf: 1 },
  { width: 1083, height: 677, dsf: 1.1818 },
]) {
  const where = `${size.width}x${size.height}${size.dsf === 1 ? '' : ` at ${size.dsf}`}`;
  test.describe(`Help's room above the open Legend at ${where} (CHROME-12, D-05)`, () => {
    test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dsf });
    test(`the first three Help rows fit above the open Legend at ${where}, and the rest scroll`, async ({ page }) => {
      await bootEmpty(page);
      await page.getByRole('button', { name: 'Legend' }).click();
      await page.getByRole('button', { name: 'Help' }).click();
      await expect(page.locator('#fab-help-panel')).toBeVisible();
      const now = await panelBoxes(page);
      expectClear(now.help!, now.legend!, `at ${where},`);
      const r = await helpRows(page);
      console.log(`[92-05 help] room ${where} box=${JSON.stringify(r.box)} scroll=${r.scrollHeight}/${r.clientHeight} rows=${JSON.stringify(r.rows.slice(0, 3))}`);
      expect(r.rows.slice(0, 3).map((x) => x.text)).toEqual(['Arm a tool', 'Place', 'Cancel / disarm']);
      for (const row of r.rows.slice(0, 3)) {
        expect(row.top, `at ${where} "${row.text}" starts inside the list`).toBeGreaterThanOrEqual(r.box.top - 0.5);
        expect(row.bottom, `at ${where} "${row.text}" ends inside the list at scrollTop 0`).toBeLessThanOrEqual(r.box.bottom + 0.5);
      }
      expect(r.scrollHeight, `at ${where} the list scrolls`).toBeGreaterThan(r.clientHeight);
      expect(r.tabIndex, `at ${where} the scrolling list is a tab stop`).toBe(0);
      await page.evaluate(() => {
        const s = document.querySelector<HTMLElement>('[data-fab-help-scroll]')!;
        s.scrollTop = s.scrollHeight;
      });
      const end = await helpRows(page);
      const last = end.rows[end.rows.length - 1]!;
      expect(last.text).toBe('Step one tick');
      expect(last.top, `at ${where} the last row scrolls fully into view`).toBeGreaterThanOrEqual(end.box.top - 0.5);
      expect(last.bottom, `at ${where} the last row scrolls fully into view`).toBeLessThanOrEqual(end.box.bottom + 0.5);
    });
  });
}

