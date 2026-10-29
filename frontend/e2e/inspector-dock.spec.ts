import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  cameraOf,
  CMD,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  waitForBoard,
  type CameraSnapshot,
  type Harness,
  type InjectBelt,
  type InjectNode,
  type InjectWire,
} from './support/wire';
import { CELL } from '../shared/geometry';
import { CONFIG_NOT_APPLIED_MARKER } from '../src/chrome/configCopy';

// inspector-dock.spec.ts (phase 91, plan 91-09, CHROME-07, D-06, success criterion 2, UI-SPEC
// sections 2.1 to 2.4) - the inspector docks below the toolbar the way the Help panel does, is
// only as tall as what it shows, and never covers the toolbar.
//
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-07: still broken`). The inspector was docked
// `top: lg / right: lg / bottom: lg` at the toolbar's own z level and mounted after it, so it
// painted over the toolbar's right end (Names, Help, New, Save, Load, Examples at 1280 wide) and
// ran the full window height whatever its content (a Source panel was about 400 px of empty fill).
//
// THE GRADE IS BOXES AND HIT TESTS (D-17), at 1024x768 and 1280x800, for every kind a user can
// select: the Source on Webhook and on Timer, the Sink, the Factory, the HTTP Handler, the Route,
// the Router, the Tee, the Belt and the Label. Each kind is selected by a real click at its cell.
//
//   - every visible toolbar button's centre hit-tests to that button (`elementFromPoint`);
//   - the inspector's top is the shared dock offset, 116 (+-0.5);
//   - its bottom is at most the UI-SPEC max bottom (8 px above the camera cluster), and equals its
//     last content child's bottom plus the 22 px padding (+-1) unless it is at the max;
//   - Apply and Revert, where the kind has them, hit-test to themselves without any scroll;
//   - the status strip, when it shows, ends at or left of the inspector's left edge less 8.
//
// THE SELECTED MACHINE STAYS VISIBLE (UI-SPEC 2.4), graded by boxes: after a click selects the
// Router, the HTTP Handler or the far-right Sink at either size, the machine's footprint ends at or
// left of the panel's left edge less 24 (+-0.5), by a pan LEFT only (zoom and vertical pan kept).
// It runs once per selection and never fights the user: a pan back under the panel stays, Escape
// leaves the camera alone, a resize never re-pans, a belt selection never pans, and a Label the
// Label tool places at the far right is nudged once.
//
// HELP AND THE INSPECTOR TAKE TURNS (UI-SPEC 2.3): a selection closes Help; Help over a showing
// inspector hides it (`display: none`, still mounted, its edit and `• not applied` kept); Help
// again restores it; while Help hides a DIRTY inspector the first Escape and the first board
// press only restore it; while it hides a clean one a floor press deselects and Help stays.
//
// RED FIRST (D-17): run once against PHASE91_START by `redfirst.sh` in the kept start worktree,
// this spec carried in; the record is in 91-EVIDENCE.md.

/** The two sizes D-17 grades layout at, with the UI-SPEC 2.2 figures for each. The max bottom is
 *  8 px above the camera cluster's top (the window less 104) since review WR-B-06; it was the
 *  window less 24 (744 and 776), level with the cluster's bottom. */
const SIZES = [
  { width: 1024, height: 768, left: 618.08, maxBottom: 664 },
  { width: 1280, height: 800, left: 792, maxBottom: 696 },
] as const;

/** The shared dock offset, `lg + min-target + 2xl` (HelpPanel.tsx), in CSS px. */
const DOCK_TOP = 116;

/** The panel's ring padding, `md + bezel-ring`. */
const PANEL_PAD = 22;

const FACTORY_CONFIG = { kind: 'Factory', source: 'export default (payload) => payload;' };

const SOURCE_URL = 'http://127.0.0.1:8787/hook/src-4294967297';
const ROUTE_URL = 'http://127.0.0.1:8787/endpoint/route-1';

const ROUTE: InjectNode = {
  id: 21,
  kind: 9,
  cell_x: 14,
  cell_y: 5,
  ports: [
    { index: 0, cell_x: 14, cell_y: 5, side: 3, role: 0, medium: 1 },
    { index: 1, cell_x: 14, cell_y: 5, side: 1, role: 1, medium: 1 },
  ],
};
const HANDLER: InjectNode = {
  id: 22,
  kind: 10,
  cell_x: 19,
  cell_y: 4,
  w: 3,
  h: 3,
  ports: [{ index: 0, cell_x: 19, cell_y: 5, side: 3, role: 0, medium: 1 }],
};
const WIRE: InjectWire = {
  id: 40,
  from: { node: ROUTE.id, port: 1 },
  to: { node: HANDLER.id, port: 0 },
  path: [
    [15, 5],
    [16, 5],
    [17, 5],
    [18, 5],
  ],
};
const BELT: InjectBelt = {
  id: 12,
  tiles: [
    [14, 5],
    [15, 5],
    [16, 5],
  ],
  ticksPerSlot: 4,
};
const ROUTER: InjectNode = {
  id: 23,
  kind: 5,
  cell_x: 14,
  cell_y: 4,
  w: 2,
  h: 3,
  ports: [
    { index: 0, cell_x: 14, cell_y: 5, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 15, cell_y: 6, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 15, cell_y: 4, side: 1, role: 1, medium: 0 },
    { index: 3, cell_x: 15, cell_y: 5, side: 1, role: 1, medium: 0 },
    { index: 4, cell_x: 14, cell_y: 6, side: 2, role: 2, medium: 0 },
  ],
};

/** One kind's board, its config answer, the cell a click selects it by, and the element whose
 *  presence says its body has loaded. */
interface DockCase {
  name: string;
  nodes?: InjectNode[];
  belts?: InjectBelt[];
  wires?: InjectWire[];
  config: unknown;
  url?: string;
  click: [number, number];
  ready: string;
  /** True when the kind's panel carries the Apply and Revert row (a config to edit). */
  actions: boolean;
}

const CASES: DockCase[] = [
  {
    name: 'the Source on Webhook',
    nodes: [{ id: 11, kind: 0, cell_x: 15, cell_y: 5, ports: [{ index: 0, cell_x: 15, cell_y: 5, side: 1, role: 1, medium: 0 }] }],
    config: { kind: 'Source', trigger: { kind: 'Webhook' } },
    url: SOURCE_URL,
    click: [15, 5],
    ready: `.fab-field[title="${SOURCE_URL}"]`,
    actions: true,
  },
  {
    name: 'the Source on Timer',
    nodes: [{ id: 11, kind: 0, cell_x: 15, cell_y: 5, ports: [{ index: 0, cell_x: 15, cell_y: 5, side: 1, role: 1, medium: 0 }] }],
    config: { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 60 } },
    click: [15, 5],
    ready: '#fab-timer-interval',
    actions: true,
  },
  {
    name: 'the Sink',
    nodes: [{ id: 14, kind: 7, cell_x: 15, cell_y: 5, ports: [{ index: 0, cell_x: 15, cell_y: 5, side: 3, role: 0, medium: 0 }] }],
    config: { kind: 'Sink', target: { kind: 'Http', url: 'https://example.com/a/rather/long/hook/path', method: 1 } },
    click: [15, 5],
    ready: '#fab-sink-http-url',
    actions: true,
  },
  {
    name: 'the Factory',
    nodes: [{ id: 7, kind: 2, cell_x: 14, cell_y: 4, w: 3, h: 3, ports: [] }],
    config: FACTORY_CONFIG,
    click: [15, 5],
    ready: '[aria-label="Ports"]',
    actions: true,
  },
  {
    name: 'the HTTP Handler',
    nodes: [{ ...HANDLER, cell_x: 14, ports: [{ index: 0, cell_x: 14, cell_y: 5, side: 3, role: 0, medium: 1 }] }],
    config: FACTORY_CONFIG,
    click: [15, 5],
    ready: '[aria-label="Ports"]',
    actions: true,
  },
  {
    name: 'the Route',
    nodes: [ROUTE, HANDLER],
    wires: [WIRE],
    config: { kind: 'Endpoint', path: '/route-1' },
    url: ROUTE_URL,
    click: [14, 5],
    ready: '#fab-route-path',
    actions: true,
  },
  {
    name: 'the Router',
    nodes: [ROUTER],
    config: { kind: 'Router', routes: [[{ offset: 0, expect: [97, 98] }, 0]], default: null },
    click: [14, 4],
    ready: '#fab-route-offset-0',
    actions: true,
  },
  {
    name: 'the Tee',
    nodes: [
      {
        id: 12,
        kind: 3,
        cell_x: 15,
        cell_y: 5,
        ports: [],
      },
    ],
    config: null,
    click: [15, 5],
    ready: '[aria-label="Ports"]',
    actions: false,
  },
  {
    name: 'the Belt',
    belts: [BELT],
    config: { kind: 'Belt', ticks_per_slot: 4 },
    click: [15, 5],
    ready: '#fab-belt-config',
    actions: true,
  },
  {
    name: 'the Label',
    nodes: [{ id: 15, kind: 11, cell_x: 14, cell_y: 5, w: 3, h: 1, label: { text: 'A note', colour: 0 } }],
    config: { kind: 'Label', text: 'A note', colour: 0, w: 3, h: 1 },
    click: [15, 5],
    ready: '#fab-label-text',
    actions: true,
  },
];

/** The CONFIG panel (the Palette is an `aside.fab-panel` too). */
function configPanel(page: Page) {
  return page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]');
}

/** A machine far from every case's cells, added by a diff packet so the board is dirty and the
 *  status strip shows `Unsaved` before the click (phase 91, plan 91-11). */
const DIRTY_NODE: InjectNode = { id: 90, kind: 0, cell_x: 2, cell_y: 14 };

/** Boot at `size`, inject the case's board, click-select it and wait for its body. With `dirty`,
 *  a diff packet adds `DIRTY_NODE` first, so the strip shows `Unsaved` while nothing is selected
 *  and the click is what opens the inspector over its band. */
async function selectCase(
  page: Page,
  c: DockCase,
  size: { width: number; height: number },
  dirty = false,
): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => {
      if (verb === 'machine_config') return c.config;
      if (verb === 'webhook_url') return c.url ?? null;
      return undefined;
    },
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ nodes: c.nodes ?? [], belts: c.belts ?? [], wires: c.wires ?? [] }));
  // Labels are not counted as machines (plan 77-04), and a belt board has none.
  const machines = (c.nodes ?? []).filter((n) => n.kind !== 11).length;
  if (machines > 0) await waitForBoard(page, { machines });
  else await expect.poll(() => page.evaluate(() => {
    const s = (window as { __fabrico?: { scene?(): { nodes: unknown[]; belts: unknown[] } } }).__fabrico?.scene?.();
    return (s?.nodes.length ?? 0) + (s?.belts.length ?? 0);
  }), { message: `${c.name}: the board landed` }).toBeGreaterThan(0);
  if (dirty) {
    h.inject(buildPacket({ nodes: [...(c.nodes ?? []), DIRTY_NODE], belts: c.belts ?? [], wires: c.wires ?? [], full: false, tick: 2 }));
    await expect(page.getByText('Unsaved', { exact: true }), `${c.name}: the board is dirty`).toBeVisible();
  }
  const at = await screenCellCentre(page, c.click[0], c.click[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(configPanel(page), `${c.name}: the inspector opened`).toBeVisible({ timeout: 10_000 });
  await expect(configPanel(page).locator(c.ready).first(), `${c.name}: its body loaded`).toBeVisible({
    timeout: 10_000,
  });
}

/** Every visible toolbar button and what its centre hit-tests to; the panel's box; its content's
 *  bottom; the Apply and Revert hit tests; the status strip's box. One read, so one layout. */
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
    const hitSelf = (label: string): { found: boolean; own: boolean } => {
      const b = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-fab-action-row] button')).find(
        (x) => (x.textContent ?? '').trim() === label,
      );
      if (b === undefined) return { found: false, own: false };
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { found: true, own: hit !== null && (hit === b || b.contains(hit)) };
    };
    const strip = document.querySelector<HTMLElement>('header [data-fab-status-strip]');
    const s = strip?.getBoundingClientRect();
    return {
      panel: { left: p.left, top: p.top, right: p.right, bottom: p.bottom },
      buttons,
      contentBottom,
      scrolls: col.scrollHeight > col.clientHeight + 1,
      scrollTop: col.scrollTop,
      apply: hitSelf('Apply'),
      revert: hitSelf('Revert'),
      strip: s === undefined || s.width === 0 || (strip?.textContent ?? '').trim() === '' ? null : { right: s.right },
    };
  });
}

test.describe('the inspector docks below the toolbar and sizes to its content (CHROME-07, D-06)', () => {
  for (const size of SIZES) {
    for (const c of CASES) {
      test(`docks below the toolbar: ${c.name} at ${size.width}x${size.height}`, async ({ page }) => {
        await selectCase(page, c, size, true);
        const d = await readDock(page);
        const line = `${c.name} ${size.width}x${size.height} ${JSON.stringify({ panel: d.panel, contentBottom: d.contentBottom, scrolls: d.scrolls })}`;
        console.log(`P91-CHROME-07 dock ${line}`);

        expect(d.buttons.length, `${c.name}: the toolbar shows its buttons`).toBeGreaterThanOrEqual(10);
        const covered = d.buttons.filter((b) => !b.own).map((b) => `${b.button} (hit ${b.hit})`);
        expect(covered, `${c.name}: every toolbar button answers its own centre with the inspector open`).toEqual([]);

        expect(Math.abs(d.panel.top - DOCK_TOP), `${c.name}: the inspector's top is the shared dock offset (${line})`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(d.panel.left - size.left), `${c.name}: the inspector keeps its right dock and width (${line})`).toBeLessThanOrEqual(0.5);
        expect(d.panel.bottom, `${c.name}: the inspector ends at most at the max bottom, 8 px above the camera cluster (${line})`).toBeLessThanOrEqual(size.maxBottom + 0.5);
        if (!d.scrolls) {
          expect(
            Math.abs(d.panel.bottom - (d.contentBottom + PANEL_PAD)),
            `${c.name}: the inspector is as tall as its content plus its padding (${line})`,
          ).toBeLessThanOrEqual(1);
        } else {
          expect(Math.abs(d.panel.bottom - size.maxBottom), `${c.name}: a panel taller than the max stops at it (${line})`).toBeLessThanOrEqual(1);
        }

        if (c.actions) {
          expect(d.apply, `${c.name}: Apply is in view and answers its own centre`).toEqual({ found: true, own: true });
          expect(d.revert, `${c.name}: Revert is in view and answers its own centre`).toEqual({ found: true, own: true });
          expect(d.scrollTop, `${c.name}: without any scroll`).toBe(0);
        }
        // NON-VACUOUS since plan 91-11: the board is dirty, so the strip shows `Unsaved` and is
        // always graded. It read only a strip with text before, and a fresh mock board has none, so
        // this line graded nothing and a belt inspector covering `Unsaved` passed (the 91-11 walk).
        expect(d.strip, `${c.name}: NON-VACUITY, the status strip shows Unsaved`).not.toBeNull();
        expect(d.strip!.right, `${c.name}: the status strip ends left of the inspector`).toBeLessThanOrEqual(d.panel.left - 8 + 0.5);
      });
    }
  }
});

// THE EXAMPLES POPOVER OPENS ON TOP. With the inspector below the toolbar, Examples is reachable
// with a machine selected; its popover drops from the header into the band the inspector and Help
// dock in, and must paint over both (it is the header's child, so the header carries its zIndex).
test.describe('the Examples popover opens over the inspector and Help (CHROME-07)', () => {
  const router = CASES.find((c) => c.name === 'the Router')!;
  for (const size of SIZES) {
    for (const over of ['the inspector', 'Help'] as const) {
      test(`docks below the toolbar: the Examples popover opens over ${over} at ${size.width}x${size.height}`, async ({ page }) => {
        await selectCase(page, router, size);
        if (over === 'Help') {
          await page.keyboard.press('Escape');
          await expect(configPanel(page), 'deselected').toHaveCount(0);
          await page.getByRole('button', { name: 'Help' }).click();
          await expect(page.locator('#fab-help-panel'), 'Help opened').toBeVisible();
        }
        await page.locator('[aria-controls="fab-examples-popover"], [data-fab-examples-trigger]').first().click();
        const items = page.locator('#fab-examples-popover button');
        await expect(items.first(), 'the popover opened').toBeVisible();
        const hits = await items.evaluateAll((els) =>
          els.map((b) => {
            const r = b.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { item: (b.textContent ?? '').trim().slice(0, 30), own: hit !== null && (hit === b || b.contains(hit)) };
          }),
        );
        expect(hits.length, 'the popover lists its examples').toBeGreaterThanOrEqual(2);
        expect(hits.filter((h) => !h.own), `every example answers its own centre over ${over}`).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The nudge (UI-SPEC 2.4) and the shared slot (UI-SPEC 2.3)
// ---------------------------------------------------------------------------

/** A wide board, so the boot fit puts its right end under the inspector's column at both sizes:
 *  a Source at the far left, a Router, an HTTP Handler and a Sink to the right, and a belt along
 *  the bottom whose right end sits under the column. */
const N_SOURCE: InjectNode = {
  id: 31,
  kind: 0,
  cell_x: 0,
  cell_y: 5,
  ports: [{ index: 0, cell_x: 0, cell_y: 5, side: 1, role: 1, medium: 0 }],
};
const N_ROUTER: InjectNode = {
  id: 32,
  kind: 5,
  cell_x: 22,
  cell_y: 4,
  w: 2,
  h: 3,
  ports: [
    { index: 0, cell_x: 22, cell_y: 5, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 23, cell_y: 4, side: 1, role: 1, medium: 0 },
    { index: 2, cell_x: 23, cell_y: 5, side: 1, role: 1, medium: 0 },
    { index: 3, cell_x: 23, cell_y: 6, side: 1, role: 1, medium: 0 },
    { index: 4, cell_x: 22, cell_y: 6, side: 2, role: 2, medium: 0 },
  ],
};
const N_HANDLER: InjectNode = {
  id: 33,
  kind: 10,
  cell_x: 27,
  cell_y: 4,
  w: 3,
  h: 3,
  ports: [{ index: 0, cell_x: 27, cell_y: 5, side: 3, role: 0, medium: 1 }],
};
const N_SINK: InjectNode = {
  id: 34,
  kind: 7,
  cell_x: 33,
  cell_y: 5,
  ports: [{ index: 0, cell_x: 33, cell_y: 5, side: 3, role: 0, medium: 0 }],
};
const N_BELT: InjectBelt = {
  id: 35,
  tiles: Array.from({ length: 6 }, (_, i) => [28 + i, 9] as [number, number]),
  ticksPerSlot: 4,
};
const NUDGE_NODES = [N_SOURCE, N_ROUTER, N_HANDLER, N_SINK];

const NUDGE_CONFIGS: Record<number, unknown> = {
  [N_SOURCE.id]: { kind: 'Source', trigger: { kind: 'Webhook' } },
  [N_ROUTER.id]: { kind: 'Router', routes: [[{ offset: 0, expect: [97, 98] }, 0]], default: null },
  [N_HANDLER.id]: FACTORY_CONFIG,
  [N_SINK.id]: { kind: 'Sink', target: { kind: 'Http', url: 'https://example.com/hook', method: 1 } },
  [N_BELT.id]: { kind: 'Belt', ticks_per_slot: 4 },
};

/** The Label the Label tool's Place mints, at the far right of the board. */
const N_LABEL: InjectNode = { id: 36, kind: 11, cell_x: 31, cell_y: 2, w: 2, h: 1, label: { text: '', colour: 0 } };

/** Boot at `size` on the wide board; a Place is accepted as minting `N_LABEL`. */
async function bootNudgeBoard(page: Page, size: { width: number; height: number }): Promise<Harness> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  let h: Harness | null = null;
  h = await mockRenderSocket(page, {
    answerQuery: (verb, args) => {
      if (verb === 'machine_config') {
        const node = Number((args as { node?: number }).node);
        if (node === N_LABEL.id) return { kind: 'Label', text: '', colour: 0, w: 2, h: 1 };
        return NUDGE_CONFIGS[node] ?? null;
      }
      if (verb === 'webhook_url') return SOURCE_URL;
      return undefined;
    },
    answerGesture: (frame) => {
      if (frame[0] !== CMD.Place) return 'accepted';
      // The host's packet first, then its accept naming the minted handle, on the one socket.
      h?.inject(buildPacket({ tick: 3, full: false, nodes: [N_LABEL] }));
      return { accept: [N_LABEL.id] };
    },
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 2, nodes: NUDGE_NODES, belts: [N_BELT] }));
  await waitForBoard(page, { machines: NUDGE_NODES.length });
  return h;
}

/** A node's footprint on screen through the camera `cam` (rotation 0 in these fixtures). */
function footprintOf(n: InjectNode, cam: CameraSnapshot) {
  const w = n.w ?? 1;
  const h = n.h ?? 1;
  return {
    left: n.cell_x * CELL * cam.scale + cam.x,
    top: n.cell_y * CELL * cam.scale + cam.y,
    right: (n.cell_x + w) * CELL * cam.scale + cam.x,
    bottom: (n.cell_y + h) * CELL * cam.scale + cam.y,
  };
}

/** A real click at a node's centre cell. */
async function clickNode(page: Page, n: InjectNode): Promise<void> {
  const at = await screenCellCentre(page, n.cell_x + Math.floor((n.w ?? 1) / 2), n.cell_y + Math.floor((n.h ?? 1) / 2));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** The live selection, from the read-only hook. */
async function selectedNode(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as { __fabrico?: { selectedNode?(): number | null } }).__fabrico?.selectedNode?.() ?? null);
}

const helpPanel = (page: Page) => page.locator('#fab-help-panel');

/** An open floor point between the palette and the panel column, below every fixture row, read
 *  as a screen point because a nudge moves the cells; asserted to reach the bare canvas. */
async function openFloor(page: Page): Promise<{ x: number; y: number }> {
  const pt = { x: 420, y: 660 };
  const tag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const);
  expect(tag, 'PRECONDITION: the floor point is on the open board').toBe('CANVAS');
  return pt;
}

/** Both top-right panels' visibility, read off the page: never both at once (UI-SPEC 2.3). */
async function expectOneAtATime(page: Page, what: string): Promise<void> {
  const both = await page.evaluate(() => {
    const shown = (el: Element | null) => el !== null && (el as HTMLElement).offsetWidth > 0;
    return {
      help: shown(document.querySelector('#fab-help-panel')),
      inspector: shown(document.querySelector('aside[aria-labelledby="fab-config-heading"]')),
    };
  });
  expect(both.help && both.inspector, `${what}: Help and the inspector are never both visible (${JSON.stringify(both)})`).toBe(false);
}

const NUDGE_TARGETS = [
  { name: 'the Router', node: N_ROUTER },
  { name: 'the HTTP Handler', node: N_HANDLER },
  { name: 'the far-right Sink', node: N_SINK },
] as const;

test.describe('the selected machine stays visible beside the inspector, once per selection (CHROME-07, UI-SPEC 2.4)', () => {
  for (const size of SIZES) {
    for (const t of NUDGE_TARGETS) {
      test(`stays visible: ${t.name} at ${size.width}x${size.height} lands 24 px clear of the panel`, async ({ page }) => {
        await bootNudgeBoard(page, size);
        const before = await cameraOf(page);
        const m0 = footprintOf(t.node, before);
        const line0 = `${t.name} ${size.width}x${size.height} before=${JSON.stringify({ cam: before, m: m0 })}`;
        console.log(`P91-CHROME-07 nudge ${line0}`);
        // NON-VACUITY: the boot fit put the machine under the column the panel will take.
        expect(m0.right, `PRECONDITION: ${t.name} sits under the inspector's column before it is selected (${line0})`).toBeGreaterThan(
          size.left - 24 + 0.5,
        );
        await clickNode(page, t.node);
        await expect(configPanel(page), `${t.name}: the inspector opened`).toBeVisible({ timeout: 10_000 });
        const p = await configPanel(page).boundingBox();
        const after = await cameraOf(page);
        const m = footprintOf(t.node, after);
        const line = `${t.name} ${size.width}x${size.height} panel.left=${p!.x} after=${JSON.stringify({ cam: after, m })}`;
        console.log(`P91-CHROME-07 nudge ${line}`);
        expect(m.right, `${t.name}: its footprint ends at or left of the panel's left edge less 24 (${line})`).toBeLessThanOrEqual(
          p!.x - 24 + 0.5,
        );
        expect(after.scale, `${t.name}: the nudge keeps the zoom`).toBe(before.scale);
        expect(after.y, `${t.name}: the nudge keeps the vertical pan`).toBe(before.y);
        expect(after.x, `${t.name}: the nudge pans the board left`).toBeLessThan(before.x);
      });
    }
  }

  test('stays visible, and never fights the user: a pan back stays, a resize and Escape leave the camera alone', async ({ page }) => {
    await bootNudgeBoard(page, SIZES[1]);
    await clickNode(page, N_ROUTER);
    await expect(configPanel(page), 'the Router inspector opened').toBeVisible({ timeout: 10_000 });
    const nudged = await cameraOf(page);
    const p = await configPanel(page).boundingBox();
    expect(footprintOf(N_ROUTER, nudged).right, 'the Router was nudged clear').toBeLessThanOrEqual(p!.x - 24 + 0.5);

    // A manual pan back under the panel: a sideways trackpad scroll over the floor, which pans
    // and keeps the selection (camera.ts wheel branch 3).
    const floor = await openFloor(page);
    await page.mouse.move(floor.x, floor.y);
    await page.mouse.wheel(-200, 0);
    await expect.poll(async () => (await cameraOf(page)).x, { message: 'the sideways scroll panned the board right' }).toBeGreaterThan(nudged.x + 150);
    const panned = await cameraOf(page);
    expect(footprintOf(N_ROUTER, panned).right, 'NON-VACUITY: the pan put the Router back under the panel').toBeGreaterThan(p!.x - 24 + 0.5);
    expect(await selectedNode(page), 'the Router is still selected after the pan').toBe(N_ROUTER.id);
    await page.waitForTimeout(2000);
    expect(await cameraOf(page), 'no second nudge within 2 s of the pan').toEqual(panned);

    // A resize with the machine still selected never re-pans.
    await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
    await expect.poll(async () => Math.round((await configPanel(page).boundingBox())!.x), { message: 'the panel re-laid out at 1024 wide' }).toBe(618);
    await page.waitForTimeout(500);
    expect(await cameraOf(page), 'a resize leaves the camera where it was').toEqual(panned);

    // Escape deselects and never pans back.
    await page.keyboard.press('Escape');
    await expect(configPanel(page), 'Escape closed the inspector').toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await cameraOf(page), 'Escape leaves the camera where it was').toEqual(panned);
  });

  // Phase 91 review WR-A-03: a selection made while Help holds the top-right slot still gets its
  // nudge. Help covers every machine under the inspector's column down to its own bottom edge, so
  // the machine here sits below Help, under the column, where a click with Help open reaches it.
  // In the shipped code the selection closes Help in the same commit, so the first layout pass
  // already measures a shown panel. The leg closes Help itself if Help is still open after the
  // click, so it also grades the order the review named (Help giving way after the selection):
  // the nudge must wait for a measured panel and not spend the selection on a hidden one. Seen red
  // against a mutation where the selection leaves Help open, before the fix; green after.
  test('stays visible: a machine selected while Help is open lands 24 px clear once the panel shows', async ({ page }) => {
    const size = SIZES[0];
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
    const LOW: InjectNode = { id: 37, kind: 7, cell_x: 33, cell_y: 26, ports: [{ index: 0, cell_x: 33, cell_y: 26, side: 3, role: 0, medium: 0 }] };
    const h = await mockRenderSocket(page, {
      answerQuery: (verb, args) => {
        if (verb === 'machine_config') {
          const node = Number((args as { node?: number }).node);
          return node === LOW.id ? NUDGE_CONFIGS[N_SINK.id] : (NUDGE_CONFIGS[node] ?? null);
        }
        if (verb === 'webhook_url') return SOURCE_URL;
        return undefined;
      },
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 2, nodes: [...NUDGE_NODES, LOW], belts: [N_BELT] }));
    await waitForBoard(page, { machines: NUDGE_NODES.length + 1 });
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(helpPanel(page), 'PRECONDITION: Help is open before the selection').toBeVisible();
    const before = await cameraOf(page);
    const at = await screenCellCentre(page, LOW.cell_x, LOW.cell_y);
    const tag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [at.x, at.y] as const);
    expect(tag, 'NON-VACUITY: with Help open the machine is on the open board, below Help').toBe('CANVAS');
    expect(footprintOf(LOW, before).right, "NON-VACUITY: the machine sits under the inspector's column").toBeGreaterThan(size.left - 24 + 0.5);
    await clickNode(page, LOW);
    await expect.poll(() => selectedNode(page), { message: 'the click selected the machine' }).toBe(LOW.id);
    if ((await helpPanel(page).count()) > 0) await page.getByRole('button', { name: 'Help' }).click();
    await expect(configPanel(page), 'the inspector shows').toBeVisible({ timeout: 10_000 });
    const p = await configPanel(page).boundingBox();
    await expect
      .poll(async () => footprintOf(LOW, await cameraOf(page)).right, {
        message: `the machine lands 24 px clear of the panel (left ${p!.x})`,
        timeout: 5_000,
      })
      .toBeLessThanOrEqual(p!.x - 24 + 0.5);
    const after = await cameraOf(page);
    expect(after.scale, 'the nudge keeps the zoom').toBe(before.scale);
    expect(after.y, 'the nudge keeps the vertical pan').toBe(before.y);
  });

  test('stays visible: a belt selection never pans', async ({ page }) => {
    await bootNudgeBoard(page, SIZES[0]);
    const before = await cameraOf(page);
    const end = N_BELT.tiles[N_BELT.tiles.length - 1];
    const at = await screenCellCentre(page, end[0], end[1]);
    expect(at.x, 'NON-VACUITY: the belt tile clicked sits under the column').toBeGreaterThan(SIZES[0].left - 24);
    // The middle tile of the run under the column: a press on an end tile can start a drag.
    const mid = await screenCellCentre(page, end[0] - 2, end[1]);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#fab-belt-config'), 'the belt inspector opened').toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);
    expect(await cameraOf(page), 'a belt selection leaves the camera alone').toEqual(before);
  });

  test('stays visible: a Label placed at the far right with the Label tool is nudged clear once', async ({ page }) => {
    const h = await bootNudgeBoard(page, SIZES[0]);
    const before = await cameraOf(page);
    expect(footprintOf(N_LABEL, before).right, 'NON-VACUITY: the drop cell sits under the column').toBeGreaterThan(SIZES[0].left - 24 + 0.5);
    await page.getByRole('button', { name: 'Place Label', exact: true }).click();
    const drop = await screenCellCentre(page, N_LABEL.cell_x, N_LABEL.cell_y);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => h.sent.filter((f) => f[0] === CMD.Place).length, { message: 'the Place went out' }).toBe(1);
    await expect(page.locator('#fab-label-text'), 'the placed label was selected and its inspector opened').toBeVisible({
      timeout: 10_000,
    });
    expect(await selectedNode(page), 'the placed label is the selection').toBe(N_LABEL.id);
    const nudged = await cameraOf(page);
    const p = await configPanel(page).boundingBox();
    const line = JSON.stringify({ before, nudged, m: footprintOf(N_LABEL, nudged), left: p!.x });
    expect(footprintOf(N_LABEL, nudged).right, `the label lands 24 px clear of the panel (${line})`).toBeLessThanOrEqual(p!.x - 24 + 0.5);
    await page.waitForTimeout(1000);
    expect(await cameraOf(page), 'and only once').toEqual(nudged);
  });
});

test.describe('Help and the inspector take turns, and no edit is lost (CHROME-07, UI-SPEC 2.3)', () => {
  /** Select the Sink and type into its URL field, so the inspector holds an unapplied edit. */
  async function dirtySink(page: Page): Promise<void> {
    await clickNode(page, N_SINK);
    const url = configPanel(page).locator('#fab-sink-http-url');
    await expect(url, 'the Sink inspector loaded').toBeVisible({ timeout: 10_000 });
    await url.fill('https://example.com/typed');
    await expect(page.locator('#fab-config-heading'), 'the edit is marked not applied').toContainText(CONFIG_NOT_APPLIED_MARKER);
  }
  const helpButton = (page: Page) => page.getByRole('button', { name: 'Help' });

  test('take turns: a selection closes Help, Help hides the inspector and brings it back as it was', async ({ page }) => {
    await bootNudgeBoard(page, SIZES[1]);
    await helpButton(page).click();
    await expect(helpPanel(page), 'Help opened').toBeVisible();
    // A selection while Help is open closes Help.
    await clickNode(page, N_SOURCE);
    await expect(configPanel(page), 'the Source inspector shows').toBeVisible({ timeout: 10_000 });
    await expect(helpPanel(page), 'the selection closed Help').toHaveCount(0);
    await expect(helpButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expectOneAtATime(page, 'after the selection');

    // Help over a showing inspector hides it, still mounted, its edit kept.
    await page.keyboard.press('Escape');
    await dirtySink(page);
    await helpButton(page).click();
    await expect(helpPanel(page), 'Help opened over the inspector').toBeVisible();
    const aside = configPanel(page);
    await expect(aside, 'the inspector is still mounted').toHaveCount(1);
    await expect(aside, 'the inspector is hidden by an inline display none').toHaveCSS('display', 'none');
    expect(await aside.evaluate((el) => el.hasAttribute('hidden')), 'not by the hidden attribute').toBe(false);
    await expectOneAtATime(page, 'Help open');

    // Help again restores it exactly as it was.
    await helpButton(page).click();
    await expect(helpPanel(page), 'Help closed').toHaveCount(0);
    await expect(aside, 'the inspector shows again').toBeVisible();
    await expect(aside.locator('#fab-sink-http-url'), 'the typed edit survived').toHaveValue('https://example.com/typed');
    await expect(page.locator('#fab-config-heading'), 'and its marker').toContainText(CONFIG_NOT_APPLIED_MARKER);
    expect(await selectedNode(page), 'the Sink is still selected').toBe(N_SINK.id);
    await expectOneAtATime(page, 'Help closed');
  });

  test('take turns: while Help hides a dirty inspector the first Escape and the first board press only restore it', async ({ page }) => {
    await bootNudgeBoard(page, SIZES[1]);
    await dirtySink(page);
    const cam = await cameraOf(page);

    // Escape.
    await helpButton(page).click();
    await expect(helpPanel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(helpPanel(page), 'the first Escape closed Help').toHaveCount(0);
    await expect(configPanel(page), 'and showed the inspector').toBeVisible();
    await expect(configPanel(page).locator('#fab-sink-http-url'), 'with the edit').toHaveValue('https://example.com/typed');
    await expect(page.locator('#fab-config-heading'), 'and its marker').toContainText(CONFIG_NOT_APPLIED_MARKER);
    expect(await selectedNode(page), 'Escape did nothing else: the Sink is still selected').toBe(N_SINK.id);
    expect(await cameraOf(page), 'Escape did nothing else: the camera did not move').toEqual(cam);
    await expect(page.locator('.is-armed'), 'no tool is armed').toHaveCount(0);

    // A board press on the empty floor, dragged as a pan would be.
    await helpButton(page).click();
    await expect(helpPanel(page)).toBeVisible();
    const floor = await openFloor(page);
    await page.mouse.move(floor.x, floor.y);
    await page.mouse.down();
    await page.mouse.move(floor.x + 60, floor.y + 20, { steps: 4 });
    await page.mouse.up();
    await expect(helpPanel(page), 'the first board press closed Help').toHaveCount(0);
    await expect(configPanel(page), 'and showed the inspector').toBeVisible();
    await expect(configPanel(page).locator('#fab-sink-http-url'), 'with the edit').toHaveValue('https://example.com/typed');
    expect(await selectedNode(page), 'the press did nothing else: no deselect').toBe(N_SINK.id);
    expect(await cameraOf(page), 'the press did nothing else: no pan').toEqual(cam);

    // A board press on another machine: restores too, and selects nothing new.
    await helpButton(page).click();
    await expect(helpPanel(page)).toBeVisible();
    // The Router: the Sink's nudge moved the far-left Source off the window.
    const r = await screenCellCentre(page, N_ROUTER.cell_x, N_ROUTER.cell_y + 1);
    expect(
      await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [r.x, r.y] as const),
      'PRECONDITION: the Router is on the open board',
    ).toBe('CANVAS');
    await clickNode(page, N_ROUTER);
    await expect(helpPanel(page), 'a press on a machine closed Help').toHaveCount(0);
    expect(await selectedNode(page), 'and kept the Sink selected').toBe(N_SINK.id);
    await expectOneAtATime(page, 'after the restores');

    // The next Escape behaves as shipped: it deselects.
    await page.locator('#fab-config-heading').click();
    await page.keyboard.press('Escape');
    await expect(configPanel(page), 'the next Escape deselects as shipped').toHaveCount(0);
  });

  test('take turns: while Help hides a clean inspector a floor press deselects and Help stays open', async ({ page }) => {
    await bootNudgeBoard(page, SIZES[1]);
    await clickNode(page, N_SOURCE);
    await expect(configPanel(page), 'the Source inspector shows').toBeVisible({ timeout: 10_000 });
    await helpButton(page).click();
    await expect(helpPanel(page)).toBeVisible();
    await expectOneAtATime(page, 'Help open over a clean inspector');
    const floor = await openFloor(page);
    await page.mouse.move(floor.x, floor.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(configPanel(page), 'the floor press deselected (the hidden inspector unmounted)').toHaveCount(0);
    expect(await selectedNode(page), 'nothing is selected').toBeNull();
    await expect(helpPanel(page), 'Help stays open').toBeVisible();
  });
});

// PHASE 91 REVIEW WR-B-02 AND WR-B-03: EVERY WAY TO DROP A HIDDEN EDIT IS GUARDED, AND THE GUARD
// LEAVES ESCAPE TO A DIALOG OR POPOVER THAT OWNS IT. While Help hides a dirty inspector, Delete,
// Backspace, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y and the board's trash button only bring the inspector
// back, as Escape and a board press already did: each used to delete or deselect the hidden
// machine and drop its unapplied edit unseen. The guard's Escape stands down while the delete
// dialog or the Examples popover is open (it used to close Help behind them). And with a CLEAN
// hidden inspector the first Escape closes Help and shows the inspector, as UI-SPEC 2.3's Escape
// row says, instead of deselecting it.
test.describe('while Help hides the inspector no key or press drops it unseen (CHROME-07, UI-SPEC 2.3, review WR-B-02, WR-B-03)', () => {
  /** A belt into the Sink carrying two items, so deleting the Sink asks first (the guard dialog),
   *  on a board that offers Undo and Redo. */
  const SINK_FEED: InjectBelt = {
    id: 37,
    tiles: [
      [30, 5],
      [31, 5],
      [32, 5],
    ],
    itemCount: 2,
    docks: [{ end: 'Head', node: N_SINK.id, port: 0 }],
    ticksPerSlot: 4,
  };
  async function bootFedBoard(page: Page): Promise<Harness> {
    const h = await bootNudgeBoard(page, SIZES[1]);
    h.inject(buildPacket({ tick: 4, nodes: NUDGE_NODES, belts: [N_BELT, SINK_FEED], canUndo: true, canRedo: true }));
    await expect(page.getByRole('button', { name: 'Undo', exact: true }), 'PRECONDITION: Undo is offered').toBeEnabled();
    return h;
  }
  async function dirtySink(page: Page): Promise<void> {
    await clickNode(page, N_SINK);
    const url = configPanel(page).locator('#fab-sink-http-url');
    await expect(url, 'the Sink inspector loaded').toBeVisible({ timeout: 10_000 });
    await url.fill('https://example.com/typed');
    await expect(page.locator('#fab-config-heading')).toContainText(CONFIG_NOT_APPLIED_MARKER);
  }
  const helpButton = (page: Page) => page.getByRole('button', { name: 'Help' });
  const sentOf = (h: Harness, cmd: number): number => h.sent.filter((b) => b[0] === cmd).length;
  /** Help is closed, the inspector shows the edit, the Sink is still selected and no command of
   *  `cmds` was sent: the act only brought the inspector back. */
  async function expectOnlyRestored(page: Page, h: Harness, act: string, cmds: number[]): Promise<void> {
    await expect(helpPanel(page), `${act}: Help closed`).toHaveCount(0);
    await expect(configPanel(page), `${act}: the inspector shows`).toBeVisible();
    await expect(configPanel(page).locator('#fab-sink-http-url'), `${act}: with the edit`).toHaveValue('https://example.com/typed');
    await expect(page.locator('[role="alertdialog"]'), `${act}: no delete dialog opened`).toHaveCount(0);
    expect(await selectedNode(page), `${act}: the Sink is still selected`).toBe(N_SINK.id);
    await page.waitForTimeout(150);
    for (const c of cmds) expect(sentOf(h, c), `${act}: sent no command ${c}`).toBe(0);
  }

  for (const [act, press] of [
    ['Delete', 'Delete'],
    ['Backspace', 'Backspace'],
    ['Ctrl+Z', 'Control+z'],
    ['Ctrl+Shift+Z', 'Control+Shift+z'],
    ['Ctrl+Y', 'Control+y'],
  ] as const) {
    test(`a dirty hidden inspector: ${act} only brings it back`, async ({ page }) => {
      const h = await bootFedBoard(page);
      await dirtySink(page);
      await helpButton(page).click();
      await expect(configPanel(page), 'PRECONDITION: Help hides the inspector').toHaveCSS('display', 'none');
      // Focus off the field the edit was typed in (it is hidden), onto the board's own body.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(press);
      await expectOnlyRestored(page, h, act, [CMD.Delete, CMD.Undo, CMD.Redo]);
    });
  }

  test("a dirty hidden inspector: the board's trash button only brings it back", async ({ page }) => {
    const h = await bootFedBoard(page);
    await dirtySink(page);
    await helpButton(page).click();
    await expect(configPanel(page), 'PRECONDITION: Help hides the inspector').toHaveCSS('display', 'none');
    const trash = page.getByRole('button', { name: 'Delete machine' });
    await expect(trash, 'PRECONDITION: the trash button shows on the selection').toBeVisible();
    // THE TRASH BUTTON SITS UNDER HELP HERE (the far-right Sink is under the column Help docks in),
    // and since the phase 92 review (WR-B-04) every panel paints over the button and takes the click
    // there, so a user cannot press it through Help. The camera is panned left with a trackpad-style
    // wheel (a pan, never a board press, which would itself bring the inspector back) until the
    // button is clear of Help, and the hit test proves the press reaches it.
    const help = (await helpPanel(page).boundingBox())!;
    const before = (await trash.boundingBox())!;
    if (before.x + before.width > help.x - 8) {
      const floor = await openFloor(page);
      await page.mouse.move(floor.x, floor.y);
      await page.mouse.wheel(Math.ceil(before.x + before.width - help.x + 48) + 0.5, 0);
    }
    await expect(configPanel(page), 'PRECONDITION: the pan left Help hiding the inspector').toHaveCSS('display', 'none');
    const tb = (await trash.boundingBox())!;
    const top = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('.fab-delete-control') !== null,
      [tb.x + tb.width / 2, tb.y + tb.height / 2] as const,
    );
    expect(top, 'PRECONDITION: the trash button is the top node where it is pressed').toBe(true);
    await trash.click();
    await expectOnlyRestored(page, h, 'the trash button', [CMD.Delete]);
  });

  test('a dirty hidden inspector: Escape in the open Examples popover closes the popover, not Help', async ({ page }) => {
    await bootFedBoard(page);
    await dirtySink(page);
    await helpButton(page).click();
    await page.locator('[aria-controls="fab-examples-popover"], [data-fab-examples-trigger]').first().click();
    const popover = page.locator('#fab-examples-popover');
    await expect(popover, 'PRECONDITION: the popover is open').toBeVisible();
    await popover.locator('button').first().focus();
    await page.keyboard.press('Escape');
    await expect(popover, 'Escape closed the popover').toHaveCount(0);
    await expect(helpPanel(page), 'and left Help open').toBeVisible();
    await expect(configPanel(page), 'the inspector stays hidden behind Help').toHaveCSS('display', 'none');
  });

  test('a clean hidden inspector: Delete opens the delete dialog, and its Escape cancels the dialog, not Help', async ({ page }) => {
    const h = await bootFedBoard(page);
    await clickNode(page, N_SINK);
    await expect(configPanel(page)).toBeVisible({ timeout: 10_000 });
    await helpButton(page).click();
    await expect(configPanel(page), 'PRECONDITION: Help hides the clean inspector').toHaveCSS('display', 'none');
    // Off the Help button, which keeps Delete for itself while it has focus.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Delete');
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog, 'the Sink holds items, so Delete asks first').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog, "Escape cancelled the dialog").toHaveCount(0);
    await expect(helpPanel(page), 'and left Help open').toBeVisible();
    expect(await selectedNode(page), 'the Sink is still selected').toBe(N_SINK.id);
    expect(sentOf(h, CMD.Delete), 'nothing was deleted').toBe(0);
  });

  test('a clean hidden inspector: the first Escape closes Help and shows the inspector, and does nothing else', async ({ page }) => {
    await bootFedBoard(page);
    await clickNode(page, N_SINK);
    await expect(configPanel(page)).toBeVisible({ timeout: 10_000 });
    const cam = await cameraOf(page);
    await helpButton(page).click();
    await expect(configPanel(page), 'PRECONDITION: Help hides the clean inspector').toHaveCSS('display', 'none');
    // Off the Help button, so the board's own Escape is what the guard has to beat.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(helpPanel(page), 'the first Escape closed Help').toHaveCount(0);
    await expect(configPanel(page), 'and showed the inspector').toBeVisible();
    expect(await selectedNode(page), 'no deselect').toBe(N_SINK.id);
    expect(await cameraOf(page), 'no camera move').toEqual(cam);
  });
});

// PHASE 91 REVIEW WR-B-06 AND UI REVIEW ITEM 1: THE TOP-RIGHT SLOT ENDS ABOVE THE CAMERA CLUSTER.
// The inspector and Help both dock top-right with the cluster (Fit and the zoom reset) in the same
// bottom-right corner, and their max height used to end 24 px above the window bottom, the
// cluster's own bottom inset: a tall inspector (the Router, a Factory with ports, the Belt at
// 1024x768) painted over Fit and the zoom button, and on a short window the cluster painted over
// Help's last rows. Graded by boxes and hit tests at the four sizes the phase checks: every kind's
// inspector and Help end at least 8 px above the cluster's top, and Fit and the zoom button answer
// their own centres with the inspector open.
const CLUSTER_SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1083, height: 677 },
  { width: 1024, height: 640 },
] as const;

/** The cluster's box, and whether Fit and the zoom button answer their own centres. */
async function readCluster(page: Page) {
  return page.evaluate(() => {
    const fit = document.querySelector<HTMLButtonElement>('button[aria-label="Fit factory to view"]');
    if (fit === null) throw new Error('no Fit button');
    const cluster = fit.parentElement as HTMLElement;
    const zoom = cluster.querySelector<HTMLButtonElement>('button[title="Reset zoom to 100%"]');
    if (zoom === null) throw new Error('no zoom button');
    const own = (b: HTMLElement): boolean => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && (hit === b || b.contains(hit));
    };
    const c = cluster.getBoundingClientRect();
    return { box: { left: c.left, top: c.top, right: c.right, bottom: c.bottom }, fit: own(fit), zoom: own(zoom) };
  });
}

test.describe('the inspector and Help never cover the camera cluster (CHROME-07, review WR-B-06, UI review 1)', () => {
  for (const size of CLUSTER_SIZES) {
    test(`the cluster stays clear at ${size.width}x${size.height}: every kind's inspector ends above it`, async ({ page }) => {
      test.setTimeout(120_000);
      let atMax = 0;
      for (const c of CASES) {
        await selectCase(page, c, size);
        const d = await readDock(page);
        const k = await readCluster(page);
        const line = `${c.name} ${size.width}x${size.height} panel=${JSON.stringify(d.panel)} cluster=${JSON.stringify(k.box)}`;
        console.log(`P91-WR-B-06 ${line} scrolls=${d.scrolls}`);
        if (d.scrolls) atMax += 1;
        expect(d.panel.bottom, `${c.name}: the inspector ends 8 px above the cluster (${line})`).toBeLessThanOrEqual(k.box.top - 8 + 0.5);
        expect(k.fit, `${c.name}: Fit answers its own centre with the inspector open (${line})`).toBe(true);
        expect(k.zoom, `${c.name}: the zoom button answers its own centre (${line})`).toBe(true);
        if (c.actions) {
          expect(d.apply, `${c.name}: Apply is still in view`).toEqual({ found: true, own: true });
        }
      }
      expect(atMax, `NON-VACUITY: at ${size.width}x${size.height} at least one kind's inspector reaches its max`).toBeGreaterThan(0);
    });

    test(`the cluster stays clear at ${size.width}x${size.height}: Help ends above it`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const h = await mockRenderSocket(page);
      await page.goto('/');
      await waitForChrome(page);
      await h.connected;
      await page.getByRole('button', { name: 'Help' }).click();
      const help = page.locator('#fab-help-panel');
      await expect(help).toBeVisible();
      const b = (await help.boundingBox())!;
      const k = await readCluster(page);
      const line = `help=${JSON.stringify(b)} cluster=${JSON.stringify(k.box)}`;
      console.log(`P91-WR-B-06 help ${size.width}x${size.height} ${line}`);
      expect(b.x + b.width, `NON-VACUITY: Help shares the cluster's right column (${line})`).toBeGreaterThan(k.box.left);
      expect(b.y + b.height, `Help ends 8 px above the cluster, so neither paints over the other (${line})`).toBeLessThanOrEqual(k.box.top - 8 + 0.5);
      expect(k.fit && k.zoom, 'Fit and the zoom button answer their own centres with Help open').toBe(true);
    });
  }
});

// PHASE 91 UI REVIEW ITEM 7: A REFUSAL SENTENCE NEVER COVERS THE INSPECTOR OR HELP. The refusal
// band is centred on the window just under the toolbar, and the inspector and Help dock at 116 on
// the right, so a refused gesture with a machine selected put the sentence over the inspector's
// heading (the 91-11 walk: `ROUTER` read `ER` for the 4 s the sentence holds). The band now
// centres in the room left of a showing top-right panel. Graded by boxes: the band's box does not
// meet the inspector's or Help's, and its sentence shows whole.
test.describe('a refusal sentence never covers the inspector or Help (UI review 7)', () => {
  const ROTATE_SENTENCE = 'No room to turn. Clear the space first.';
  async function bootRefusing(page: Page, size: { width: number; height: number }): Promise<Harness> {
    await page.setViewportSize(size);
    await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
    const h = await mockRenderSocket(page, {
      answerQuery: (verb, args) => (verb === 'machine_config' ? (NUDGE_CONFIGS[Number((args as { node?: number }).node)] ?? null) : undefined),
      answerGesture: (frame) => (frame[0] === CMD.Rotate ? 'RotateBlocked' : 'accepted'),
    });
    await page.goto('/');
    await waitForChrome(page);
    await h.connected;
    h.inject(buildPacket({ tick: 2, nodes: NUDGE_NODES, belts: [N_BELT] }));
    await waitForBoard(page, { machines: NUDGE_NODES.length, tick: 2 });
    return h;
  }
  const boxOf = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;
  const meets = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  for (const size of SIZES) {
    test(`at ${size.width}x${size.height} a refusal with the Router selected sits clear of the inspector`, async ({ page }) => {
      await bootRefusing(page, size);
      await clickNode(page, N_ROUTER);
      await expect(page.locator('#fab-config-heading'), 'the Router is selected').toBeVisible({ timeout: 10_000 });
      await page.locator('#fab-config-heading').click();
      await page.keyboard.press('r');
      const band = page.locator('#fab-refusal .fab-panel');
      await expect(band, 'the refusal shows').toContainText(ROTATE_SENTENCE);
      const b = await boxOf(page, '#fab-refusal .fab-panel');
      const p = await boxOf(page, 'aside[aria-labelledby="fab-config-heading"]');
      console.log(`P91-UI7 inspector ${size.width}x${size.height} band=${JSON.stringify(b)} panel=${JSON.stringify(p)}`);
      expect(meets(b, p), `the band (${JSON.stringify(b)}) does not meet the inspector (${JSON.stringify(p)})`).toBe(false);
      expect(b.x, 'the band stays inside the window').toBeGreaterThanOrEqual(0);
    });

    test(`at ${size.width}x${size.height} a refusal with Help open sits clear of Help`, async ({ page }) => {
      await bootRefusing(page, size);
      await clickNode(page, N_ROUTER);
      await expect(page.locator('#fab-config-heading')).toBeVisible({ timeout: 10_000 });
      await page.getByRole('button', { name: 'Help' }).click();
      await expect(helpPanel(page)).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('r');
      const band = page.locator('#fab-refusal .fab-panel');
      await expect(band, 'the refusal shows').toContainText(ROTATE_SENTENCE);
      const b = await boxOf(page, '#fab-refusal .fab-panel');
      const hp = await boxOf(page, '#fab-help-panel');
      console.log(`P91-UI7 help ${size.width}x${size.height} band=${JSON.stringify(b)} help=${JSON.stringify(hp)}`);
      expect(meets(b, hp), `the band (${JSON.stringify(b)}) does not meet Help (${JSON.stringify(hp)})`).toBe(false);
    });
  }
});

// REVIEW IN-B-04: THE LEGEND RESERVES ONLY THE RIGHT-DOCKED SURFACES IT CAN RUN UNDER. The
// inspector is as tall as its content (plan 91-09) and ends above the camera cluster (WR-B-06),
// but its `data-fab-corner-dock` made the bottom Legend strip stop at its left edge whatever its
// height, so beside a short Source panel the strip lost about 400 px at 1280 wide for no overlap.
// A corner dock now counts only when its bottom reaches the strip's top. Graded by boxes, for
// every kind at both sizes: the strip never meets the inspector or the camera cluster, and beside
// the short Source panel at 1280x800 it reaches past the inspector's left edge.
test.describe('the Legend strip reserves only the docks it would run under (review IN-B-04)', () => {
  for (const size of SIZES) {
    test(`at ${size.width}x${size.height} the Legend meets no inspector and no cluster, and runs past a short one`, async ({ page }) => {
      test.setTimeout(120_000);
      let pastShort = 0;
      for (const c of CASES) {
        await selectCase(page, c, size);
        await page.locator('header').getByRole('button', { name: 'Legend' }).click();
        const legend = page.locator('#fab-legend-panel');
        await expect(legend, `${c.name}: the Legend opened`).toBeVisible();
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => {
          const box = (el: Element | null) => {
            const r = el!.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          };
          return {
            legend: box(document.getElementById('fab-legend-panel')),
            panel: box(document.querySelector('aside[aria-labelledby="fab-config-heading"]')),
            cluster: box(document.querySelector('[data-fab-camera-cluster]')),
          };
        });
        const meets = (a: typeof m.legend, b: typeof m.legend) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const line = `${c.name} ${size.width}x${size.height} ${JSON.stringify(m)}`;
        console.log(`P91-IN-B-04 ${line}`);
        expect(meets(m.legend, m.panel), `${c.name}: the Legend does not meet the inspector (${line})`).toBe(false);
        expect(meets(m.legend, m.cluster), `${c.name}: the Legend does not meet the camera cluster (${line})`).toBe(false);
        if (m.legend.right > m.panel.left) pastShort += 1;
        if (size.width === 1280 && c.name === 'the Source on Webhook') {
          expect(m.legend.right, `beside the short Source panel the Legend runs past the inspector's left edge (${line})`).toBeGreaterThan(m.panel.left);
        }
      }
      console.log(`P91-IN-B-04 ${size.width}x${size.height} past-short=${pastShort}`);
    });
  }
});
