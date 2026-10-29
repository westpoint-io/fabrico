import { test, expect, type Page } from '@playwright/test';
import { buildPacket, mockRenderSocket, screenCellCentre, waitForBoard, waitForChrome, type InjectNode } from './support/wire';
// The PNG decoder Playwright already bundles (pngjs), the reach palette-grouping.spec uses.
import { PNG } from 'playwright-core/lib/utilsBundle';

// legend-lines.spec.ts (phase 92, plan 92-05, CHROME-12, D-02, D-03, UI-SPEC 1.4) - the open Legend
// reads as four labelled groups at every window size a user meets, with nothing left dangling.
//
// WHAT WAS BROKEN (92-MEASURE.md `### 12a`, `### 12b`). The strip was one wrapping row of loose
// children: the kind rows, a separator, the state rows, a second separator, a bare `Connections`
// heading and the connection rows. Where the row wrapped decided whether a separator or that heading
// was left alone at the end of a line, and at every measured width one was. Label, a palette entry,
// had no row at all.
//
// WHAT IS GRADED, BY BOXES AND ONE PIXEL READ PER LINE (never a snapshot):
//   - THE LINE RULE: the strip's headings, rows and separators grouped into lines by box centre
//     (within 2 px); no line ends with a heading or a separator and none starts with a separator,
//     and every heading's line also holds the row that follows it (its group's first row);
//   - THE HAIRLINE RULE: a group's left hairline is visible (at or right of the clip box's left
//     edge) exactly when the group before it shares a line with it, by boxes; and, read off the
//     pixels, the strip shows panel fill at its content-left edge in the gap under every line, so a
//     group that spans several lines and lost its lead draws no hairline down its line starts. The
//     gap between two groups lies outside both group boxes, so where every group fits on one line
//     the pixel read cannot see a hairline at a line start and the box rule is what catches it
//     (review IN-C-01). A second sample, 1.5 px outside the content edge, was dropped by the same
//     review: it lies in the strip's padding, outside the `overflow: hidden` clip box, where nothing
//     inside the clip can paint, so it read the panel fill whatever the groups did;
//   - THE ROW RULE: every palette `Place <name>` button and the Belt and Wire tools has exactly one
//     Legend row with that exact name, the kinds read in palette order, and no row or heading
//     reaches past the strip's content-right edge.
//
// THE PIXEL READ IS IN THE GAP, ON PURPOSE. A hairline left at a line start (the -17 px lead lost)
// sits on the first pixel column of the strip's content box, where the first row's swatch also
// starts, and several swatches are the outline's own colour (a state swatch's 1 px border, a Ports
// well's floor). The 8 px row gap under each line holds no row, so a pixel there at the content-left
// edge reads the panel fill unless a group's hairline runs down through it.
//
// 1083x677 is a CSS VIEWPORT at `deviceScaleFactor` 1.1818 (RESEARCH Pitfall 10): Chromium's scale
// factor does not change CSS layout width, so 1280x800 at 1.18 would never measure the 1083 case.
//
// RED FIRST (D-17): seen failing at PHASE92_START in the kept start worktree (92-EVIDENCE.md,
// `D17 case=CHROME-12-mock`).

interface Layout {
  name: string;
  viewport: { width: number; height: number };
  dsf: number;
  /** Select a Factory first, so the inspector reserves the strip's right end (344 px of content). */
  factory: boolean;
}

const LAYOUTS: Layout[] = [
  { name: '1024x768', viewport: { width: 1024, height: 768 }, dsf: 1, factory: false },
  { name: '1083x677 at 1.1818', viewport: { width: 1083, height: 677 }, dsf: 1.1818, factory: false },
  { name: '1280x800', viewport: { width: 1280, height: 800 }, dsf: 1, factory: false },
  { name: '1440x900', viewport: { width: 1440, height: 900 }, dsf: 1, factory: false },
  { name: '1024x768 with a Factory selected', viewport: { width: 1024, height: 768 }, dsf: 1, factory: true },
];

/** A FACTORY (kind 2, 3x3) at (10,8), the catalog shape palette-grouping.spec selects. */
const FACTORY: InjectNode = {
  id: 7,
  kind: 2,
  cell_x: 10,
  cell_y: 8,
  w: 3,
  h: 3,
  ports: [
    { index: 0, cell_x: 10, cell_y: 9, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 11, cell_y: 10, side: 2, role: 2, medium: 0 },
  ],
};
const FACTORY_BODY: [number, number] = [11, 9];

/** Within this many px two boxes' centres are on one line (UI-SPEC 1.4). */
const LINE_TOLERANCE = 2;
/** A pixel reads the panel fill within this many levels per channel (UI-SPEC 1.4). */
const FILL_TOLERANCE = 2;

async function openLegend(page: Page, layout: Layout, help: boolean): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) =>
      verb === 'machine_config' ? { kind: 'Factory', source: 'export default (payload) => payload;' } : undefined,
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  if (layout.factory) {
    h.inject(buildPacket({ tick: 3, nodes: [FACTORY] }));
    await waitForBoard(page, { machines: 1 });
    const at = await screenCellCentre(page, FACTORY_BODY[0], FACTORY_BODY[1]);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByRole('heading', { name: 'Factory' }), 'the Factory is selected').toBeVisible({ timeout: 10_000 });
  } else {
    h.inject(buildPacket({ tick: 3 }));
  }
  await page.getByRole('button', { name: 'Legend' }).click();
  await expect(page.locator('#fab-legend-panel'), 'the Legend opened').toBeVisible();
  if (help) {
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('#fab-help-panel'), 'Help opened').toBeVisible();
  }
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await page.mouse.move(2, 2);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Item {
  kind: 'heading' | 'row' | 'separator';
  label: string;
  box: Box;
  /** For a heading: the box of the first row after it in document order. */
  next: Box | null;
}

interface StripReading {
  strip: Box;
  content: Box;
  clip: Box | null;
  items: Item[];
  groups: { name: string; box: Box }[];
  kindRows: string[];
  connectionRows: string[];
  palette: string[];
  panelFill: string;
}

/** Read the open Legend: its content box, headings, rows, separators and groups. Works on the
 *  phase 91 strip (loose children) and on the grouped one, so the red-first run grades the start. */
async function readStrip(page: Page): Promise<StripReading> {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const strip = document.getElementById('fab-legend-panel')!;
    const sr = box(strip);
    const cs = getComputedStyle(strip);
    const content = {
      left: sr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
      top: sr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop),
      right: sr.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
      bottom: sr.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom),
    };
    const tagged = [...strip.querySelectorAll('[data-fab-legend-row]')];
    // The phase 91 strip had no row attribute: its rows were the strip's nowrap flex children.
    const rows =
      tagged.length > 0
        ? tagged
        : [...strip.children].filter((c) => {
            const s = getComputedStyle(c);
            return c.tagName === 'DIV' && s.whiteSpace === 'nowrap' && s.display === 'flex';
          });
    const rowName = (r: Element): string => {
      const spans = [...r.querySelectorAll('span')].map((s) => (s.textContent ?? '').trim());
      return spans.find((t) => t !== '') ?? (r.textContent ?? '').trim();
    };
    const HEADINGS = ['Legend', 'States', 'Ports', 'Connections'];
    const headings = [...strip.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && HEADINGS.includes((el.textContent ?? '').trim()) && !rows.some((r) => r.contains(el)),
    );
    const separators = [...strip.querySelectorAll('[role="separator"]')];
    const following = (h: Element): Element | null =>
      rows.find((r) => (h.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ?? null;
    const items = [
      ...headings.map((h) => {
        const n = following(h);
        return { kind: 'heading' as const, label: (h.textContent ?? '').trim(), box: box(h), next: n === null ? null : box(n) };
      }),
      ...rows.map((r) => ({ kind: 'row' as const, label: rowName(r), box: box(r), next: null })),
      ...separators.map((s) => ({ kind: 'separator' as const, label: '|', box: box(s), next: null })),
    ];
    const clip = strip.querySelector('[data-fab-legend-groups]');
    const groups = [...strip.querySelectorAll('[data-fab-legend-group]')].map((g) => ({
      name: g.getAttribute('data-fab-legend-group') ?? '',
      box: box(g),
    }));
    const namesIn = (sel: string) => [...strip.querySelectorAll(`${sel} [data-fab-legend-row]`)].map(rowName);
    const palette = [...document.querySelectorAll('aside[aria-labelledby="fab-palette-heading"] button')]
      .map((b) => {
        const label = b.getAttribute('aria-label');
        if (label !== null) return label.startsWith('Place ') ? label.slice('Place '.length) : '';
        const text = (b.textContent ?? '').trim();
        return text === 'Belt' || text === 'Wire' ? text : '';
      })
      .filter((n) => n !== '');
    return {
      strip: sr,
      content,
      clip: clip === null ? null : box(clip),
      items,
      groups,
      kindRows: namesIn('[data-fab-legend-group="kinds"]'),
      connectionRows: namesIn('[data-fab-legend-group="connections"]'),
      palette,
      panelFill: getComputedStyle(document.documentElement).getPropertyValue('--fab-panel-fill').trim(),
    };
  });
}

/** Group items into lines by box centre, top to bottom, each line left to right. */
function linesOf(items: Item[]): Item[][] {
  const lines: { mid: number; items: Item[] }[] = [];
  for (const it of [...items].sort((a, b) => (a.box.top + a.box.bottom) / 2 - (b.box.top + b.box.bottom) / 2)) {
    const mid = (it.box.top + it.box.bottom) / 2;
    const line = lines.find((l) => Math.abs(l.mid - mid) <= LINE_TOLERANCE);
    if (line === undefined) lines.push({ mid, items: [it] });
    else line.items.push(it);
  }
  return lines.sort((a, b) => a.mid - b.mid).map((l) => l.items.sort((a, b) => a.box.left - b.box.left));
}

const mid = (b: Box): number => (b.top + b.bottom) / 2;
const describeLine = (line: Item[]): string => line.map((i) => (i.kind === 'row' ? i.label : `[${i.kind} ${i.label}]`)).join(', ');

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

for (const layout of LAYOUTS) {
  test.describe(`the open Legend at ${layout.name} (CHROME-12, UI-SPEC 1.4)`, () => {
    test.use({ viewport: layout.viewport, deviceScaleFactor: layout.dsf });

    for (const help of [false, true]) {
      test(`no heading or hairline ends a Legend line at ${layout.name}, Help ${help ? 'open' : 'closed'}`, async ({ page }) => {
        await openLegend(page, layout, help);
        const m = await readStrip(page);
        const lines = linesOf(m.items);
        const where = `${layout.name}, Help ${help ? 'open' : 'closed'}`;
        console.log(`[92-05 legend] ${where} strip=${JSON.stringify(m.strip)} lines=${lines.length}`);
        lines.forEach((l, k) => console.log(`[92-05 legend]   line ${k + 1}: ${describeLine(l)}`));
        expect(m.items.filter((i) => i.kind === 'row').length, 'NON-VACUITY: the strip has rows').toBeGreaterThanOrEqual(12);
        expect(m.items.filter((i) => i.kind === 'heading').length, 'NON-VACUITY: the strip has headings').toBeGreaterThanOrEqual(2);

        // THE LINE RULE.
        lines.forEach((line, k) => {
          const last = line[line.length - 1]!;
          expect(
            last.kind === 'row',
            `RED-FIRST CHROME-12-mock: at ${where} line ${k + 1} [${describeLine(line)}] ends with the ${last.kind} "${last.label}"`,
          ).toBe(true);
          expect(line[0]!.kind !== 'separator', `at ${where} line ${k + 1} [${describeLine(line)}] starts with a separator`).toBe(true);
        });
        for (const h of m.items.filter((i) => i.kind === 'heading')) {
          expect(h.next, `the heading "${h.label}" has a row after it`).not.toBeNull();
          expect(
            Math.abs(mid(h.box) - mid(h.next!)),
            `RED-FIRST CHROME-12-mock: at ${where} the heading "${h.label}" shares its line with its group's first row`,
          ).toBeLessThanOrEqual(LINE_TOLERANCE);
        }

        // THE HAIRLINE RULE, by boxes.
        expect(m.groups.map((g) => g.name), `at ${where} the strip holds four groups`).toEqual(['kinds', 'states', 'ports', 'connections']);
        expect(m.clip, 'the groups sit in one clip box').not.toBeNull();
        for (let i = 1; i < m.groups.length; i += 1) {
          const prev = m.groups[i - 1]!.box;
          const g = m.groups[i]!;
          const visible = g.box.left >= m.clip!.left - 0.5;
          const shares = Math.min(prev.bottom, g.box.bottom) - Math.max(prev.top, g.box.top) > 0;
          expect(
            visible,
            `at ${where} the ${g.name} hairline is visible (x ${g.box.left.toFixed(2)} against the clip box's ${m.clip!.left.toFixed(2)}) ` +
              `exactly when the ${m.groups[i - 1]!.name} group shares its line`,
          ).toBe(shares);
        }

        // THE HAIRLINE RULE, by pixels: panel fill at the content-left edge in the gap under every
        // line (see the header for what this read can and cannot see).
        const shot = PNG.sync.read(await page.screenshot());
        const fill = hexRgb(m.panelFill);
        const at = (x: number, y: number): [number, number, number] => {
          const px = Math.floor(x * layout.dsf);
          const py = Math.floor(y * layout.dsf);
          const o = (py * shot.width + px) * 4;
          return [shot.data[o]!, shot.data[o + 1]!, shot.data[o + 2]!];
        };
        const samples: { what: string; x: number; y: number }[] = [];
        lines.forEach((line, k) => {
          const bottom = Math.max(...line.map((i) => i.box.bottom));
          const below = lines[k + 1];
          if (below !== undefined) {
            const nextTop = Math.min(...below.map((i) => i.box.top));
            samples.push({ what: `the gap under line ${k + 1}, at the content edge`, x: m.content.left + 0.5, y: (bottom + nextTop) / 2 });
          }
        });
        expect(samples.length, 'NON-VACUITY: a pixel read under every line but the last').toBe(lines.length - 1);
        for (const s of samples) {
          const rgb = at(s.x, s.y);
          const off = Math.max(...rgb.map((c, i) => Math.abs(c - fill[i]!)));
          expect(off, `at ${where} ${s.what} reads rgb(${rgb.join(',')}), the panel fill is ${m.panelFill}`).toBeLessThanOrEqual(FILL_TOLERANCE);
        }
      });
    }

    test(`every palette entry has a Legend row at ${layout.name}`, async ({ page }) => {
      await openLegend(page, layout, false);
      const m = await readStrip(page);
      const where = layout.name;
      const rows = m.items.filter((i) => i.kind === 'row');
      console.log(`[92-05 legend] ${where} palette=${m.palette.join('|')} kinds=${m.kindRows.join('|')} rows=${rows.map((r) => r.label).join('|')}`);
      expect(m.palette.length, 'NON-VACUITY: the palette lists its entries').toBeGreaterThanOrEqual(12);
      for (const name of m.palette) {
        expect(
          rows.filter((r) => r.label === name).length,
          `RED-FIRST CHROME-12-mock: at ${where} exactly one Legend row is named "${name}" (rows: ${rows.map((r) => r.label).join(' | ')})`,
        ).toBe(1);
      }
      expect(m.kindRows, `at ${where} the kinds read in palette order, Wire a connection`).toEqual(m.palette.filter((n) => n !== 'Wire'));
      expect(m.connectionRows, `at ${where} the connections read Wire, Request, Reply`).toEqual(['Wire', 'Request', 'Reply']);
      // Overflow: nothing in the strip reaches past its content-right edge (the shipped budget of 0).
      for (const it of m.items) {
        expect(
          it.box.right,
          `at ${where} "${it.label}" ends at ${it.box.right.toFixed(2)}, inside the content edge ${m.content.right.toFixed(2)}`,
        ).toBeLessThanOrEqual(m.content.right + 0.5);
      }
    });
  });
}
