import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  screenCellCentre,
  waitForChrome,
  type InjectBelt,
  type InjectNode,
  type InjectWire,
  waitForBoard,
} from './support/wire';

// panel-io.spec.ts (PANEL-02, Phase 51-01) - the end-to-end proof of the config
// panel's read-only I/O list, driven through the REAL production path:
//
//   injected render packet -> SceneState.nodes -> App's ~10Hz poll ->
//   `selectedNodePorts` -> <ConfigPanel ports> -> <PortsSection> -> rendered rows
//
// This is the tracer slice's runnable verify. It closes the scene-access gap the
// panel shipped with (ConfigPanel.tsx:288-297 took only {node, kind, sendInput,
// invoke} - no ports, no scene), so it asserts on the LIVE packet ports rather
// than on `machine_config` (a ConfigView carries no ports at all).
//
// The port fixture geometry mirrors port-gestures.spec.ts: a 3x3 Factory at
// (10,8) with In (10,9) W, Out (12,9) E and Fault (11,10) S - real catalog
// geometry, so a click on the body centre (11,9) never lands on a nub.

/** A FACTORY (kind 2, 3x3) at (10,8) carrying an In, an Out and a Fault port. */
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

/** The Factory body cell (never a nub cell) - the safe click-to-select point. */
const FACTORY_BODY: [number, number] = [11, 9];

/** A SOURCE (kind 0, 1x1) at (4,4): ONE Out port, NO In - the empty-role case
 *  that must render the dim `None` row under a still-present Inputs header. */
const SOURCE: InjectNode = {
  id: 11,
  kind: 0,
  cell_x: 4,
  cell_y: 4,
  ports: [{ index: 0, cell_x: 4, cell_y: 4, side: 1, role: 1, medium: 0 }],
};
const SOURCE_BODY: [number, number] = [4, 4];

/** A TEE (kind 3, 1x1) at (6,6) with an In and an Out. A Tee has NO machine_config
 *  at all (the host answers null), so it is the load-bearing proof that the I/O
 *  section sits OUTSIDE ConfigPanel's `config &&` guard - a port-only kind is
 *  exactly the machine whose whole identity IS its ports. */
const TEE: InjectNode = {
  id: 12,
  kind: 3,
  cell_x: 6,
  cell_y: 6,
  ports: [
    { index: 0, cell_x: 6, cell_y: 6, side: 3, role: 0, medium: 0 },
    { index: 1, cell_x: 6, cell_y: 6, side: 1, role: 1, medium: 0 },
  ],
};
const TEE_BODY: [number, number] = [6, 6];

/** A ROUTER (kind 5) carrying deliberately MANY ports - the 51-UI-SPEC overflow
 *  backstop fixture. Real Routers have a handful; 40 is the synthetic stress that
 *  guarantees the section exceeds the panel height on the 720px test viewport, so
 *  the panel's existing `overflow-y: auto` (ConfigPanel.tsx:181) is actually
 *  exercised instead of being asserted on a list that happens to fit. */
const ROUTER_PORT_COUNT = 40;
const ROUTER: InjectNode = {
  id: 13,
  kind: 5,
  cell_x: 20,
  cell_y: 4,
  ports: Array.from({ length: ROUTER_PORT_COUNT }, (_, i) => ({
    index: i,
    cell_x: 20,
    cell_y: 4,
    side: i % 4,
    role: i < ROUTER_PORT_COUNT / 2 ? 0 : 1,
    medium: 0,
  })),
};
const ROUTER_BODY: [number, number] = [20, 4];

/**
 * Boot the mocked app, inject `node`, click-select it and wait for the panel.
 * `config` is the value answered for the `machine_config` query: a MachineConfig
 * object, or `null` for a port-only kind (Tee/Router/...) that has none - the
 * exact case that forced the I/O section OUTSIDE ConfigPanel's `config &&` guard.
 */
async function selectMachine(
  page: Page,
  node: InjectNode,
  body: [number, number],
  config: unknown,
): Promise<void> {
  // Suppress the first-run WelcomeCard (itself an aside.fab-panel): the reuse
  // config lacks the main config's storageState onboarding seed.
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));

  // Mock BEFORE goto (routeWebSocket must register pre-navigation). Without a
  // machine_config reply the panel hangs in "Loading config...", and the I/O
  // section is gated on `!loading` - so an unanswered query would mask the
  // section's presence rather than prove it.
  const h = await mockRenderSocket(page, {
    answerQuery: (verb) => (verb === 'machine_config' ? config : undefined),
  });
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;

  h.inject(buildPacket({ nodes: [node] }));
  await waitForBoard(page, { machines: 1 });

  const at = await screenCellCentre(page, body[0], body[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** The `<section aria-label="Ports">` the panel mounts below the per-kind body. */
function portsSection(page: Page) {
  return page.getByRole('region', { name: 'Ports' });
}

/** A role group's `role="list"` (named by its own header via aria-labelledby). */
function group(page: Page, name: 'Inputs' | 'Outputs') {
  return page.getByRole('list', { name });
}

const FACTORY_CONFIG = { kind: 'Factory', source: 'export default (payload) => payload;' };

test.describe('Config panel I/O list (PANEL-02)', () => {
  test('a selected Factory lists its ports grouped Inputs / Outputs by "{Role} - {Medium}"', async ({
    page,
  }) => {
    await selectMachine(page, FACTORY, FACTORY_BODY, FACTORY_CONFIG);

    // Heading first: a failure here points at the selection/query bridge, not at
    // the I/O list (the factory-editor-height.spec.ts diagnosis discipline).
    await expect(page.getByRole('heading', { name: 'Factory' })).toBeVisible({ timeout: 10_000 });

    await expect(portsSection(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inputs' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Outputs' })).toBeVisible();

    // The exact copy contract (51-UI-SPEC): role word, plain " - ", medium word.
    // Prefix-matched because Plan 02 appended the live flow status to each row
    // ("Input - Item" + "not connected"); the status itself is panel-flow.spec's
    // business, this case owns the LABEL contract.
    await expect(group(page, 'Inputs').getByRole('listitem')).toHaveText([/^Input - Item/]);
    // Fault nests under Outputs, AFTER the Out ports - it is an output exit in
    // the core role model, and a phantom "Fault" header on the many kinds that
    // have none would read as a missing feature rather than an absent port.
    await expect(group(page, 'Outputs').getByRole('listitem')).toHaveText([
      /^Output - Item/,
      /^Fault - Item/,
    ]);
  });

  test('a group header is visibly distinct from its rows, not just a row with a different word', async ({
    page,
  }) => {
    // 51-UI-REVIEW. The header and the rows shared family, size, weight AND
    // colour, so the only differentiators were an 8px top margin and the words
    // themselves. Measured in the browser rather than asserted on a style object:
    // the header renders a real 1px rule, and no row does.
    await selectMachine(page, FACTORY, FACTORY_BODY, FACTORY_CONFIG);
    await expect(portsSection(page)).toBeVisible();

    const ruleOf = (l: ReturnType<typeof portsSection>) =>
      l.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { width: cs.borderBottomWidth, style: cs.borderBottomStyle, color: cs.borderBottomColor };
      });

    for (const name of ['Inputs', 'Outputs']) {
      const rule = await ruleOf(page.getByRole('heading', { name }));
      expect(rule.width, `${name} carries a hairline`).toBe('1px');
      expect(rule.style).toBe('solid');
      // The dim token, resolved - never a hand-authored hex.
      const outline = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--fab-outline)';
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(rule.color).toBe(outline);
    }

    const rowRules = await portsSection(page)
      .getByRole('listitem')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderBottomWidth));
    expect(rowRules, 'no row is ruled - the rule is what says "header"').toEqual(
      rowRules.map(() => '0px'),
    );
  });

  test('there is no separate Fault header - Fault rows nest under Outputs', async ({ page }) => {
    await selectMachine(page, FACTORY, FACTORY_BODY, FACTORY_CONFIG);
    await expect(portsSection(page)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Fault' })).toHaveCount(0);
    await expect(portsSection(page).getByRole('list')).toHaveCount(2);
  });

  test('a role with zero ports keeps its header and shows a None row in ink (a Source has no Inputs)', async ({
    page,
  }) => {
    await selectMachine(page, SOURCE, SOURCE_BODY, { kind: 'Source', trigger: { kind: 'Webhook' } });
    await expect(page.getByRole('heading', { name: 'Source' })).toBeVisible({ timeout: 10_000 });
    await expect(portsSection(page)).toBeVisible();

    // The header stays: "this machine takes nothing in" must be readable as a
    // statement, not inferred from a missing section.
    await expect(page.getByRole('heading', { name: 'Inputs' })).toBeVisible();
    const none = group(page, 'Inputs').getByRole('listitem');
    await expect(none).toHaveText(['None']);
    // Full ink, via the token - not a hand-authored hex (the skin-purity rule). Phase 91
    // (UI-SPEC Color, A13): it used to be dim `--fab-outline`, 1.64 : 1 on the panel,
    // which fails AA, so no word in the inspector wears it any more.
    await expect(none).toHaveAttribute('style', /color:\s*var\(--fab-ink\)/);

    await expect(group(page, 'Outputs').getByRole('listitem')).toHaveText([/^Output - Item/]);
  });

  test('a port-only kind with a NULL machine_config still renders the Ports section', async ({
    page,
  }) => {
    // A Tee answers machine_config with null, so the per-kind body (inside the
    // `config &&` guard) renders nothing at all. If the I/O section were inside
    // that guard it would vanish for exactly the kinds it matters most for.
    await selectMachine(page, TEE, TEE_BODY, null);
    await expect(page.getByRole('heading', { name: 'Tee' })).toBeVisible({ timeout: 10_000 });

    await expect(portsSection(page)).toBeVisible();
    await expect(group(page, 'Inputs').getByRole('listitem')).toHaveText([/^Input - Item/]);
    await expect(group(page, 'Outputs').getByRole('listitem')).toHaveText([/^Output - Item/]);
    // The Apply/Revert row is gated on `config`, so its absence here confirms we
    // really are outside that guard rather than accidentally inside it.
    await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);
  });

  test('the list is accessible: role=list of role=listitem, each row named by its label', async ({
    page,
  }) => {
    await selectMachine(page, FACTORY, FACTORY_BODY, FACTORY_CONFIG);
    await expect(portsSection(page)).toBeVisible();

    // Each group is a real list NAMED by its own header (aria-labelledby), so a
    // screen reader announces "Inputs, list, 1 item" without extra chrome.
    await expect(group(page, 'Inputs')).toBeVisible();
    await expect(group(page, 'Outputs')).toBeVisible();
    await expect(portsSection(page).getByRole('listitem')).toHaveCount(3);

    // Accessible NAME (not just text): ARIA computes a listitem's name from the
    // author, so the rows carry an explicit aria-label equal to their text - a
    // nameless row would be invisible to a by-name query and to a SR.
    for (const label of ['Input - Item', 'Output - Item', 'Fault - Item']) {
      const row = portsSection(page).getByRole('listitem', { name: label });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(label);
    }
  });

  test('a many-port kind scrolls inside the panel with no clipped row (UI-SPEC overflow backstop)', async ({
    page,
  }) => {
    await selectMachine(page, ROUTER, ROUTER_BODY, null);
    await expect(portsSection(page)).toBeVisible();

    const rows = portsSection(page).getByRole('listitem');
    await expect(rows).toHaveCount(ROUTER_PORT_COUNT);

    // The CONFIG panel specifically - the Palette is an `aside.fab-panel` too.
    const panel = page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]');

    // THE SCROLL CONTAINER IS THE INNER WRAPPER, NOT THE PANEL (plan 59-03). The
    // bezel is an inset box-shadow now: inset shadows are clipped to the padding
    // box and paint BELOW the content, so a panel that both carries the ring and
    // scrolls has its top ring band overpainted by its own content the moment it is
    // scrolled. The panel must therefore compute a NON-scrolling overflow, and that
    // half of this assertion is the live backstop for that defect.
    const scroller = panel.locator('[data-fab-panel-scroll]');
    await expect(scroller).toHaveCount(1);
    expect(
      await panel.evaluate((el) => getComputedStyle(el).overflowY),
      'the ring-carrying panel must NOT be a scroll container',
    ).toBe('visible');

    // The scroller really overflows (otherwise this test would prove nothing).
    const metrics = await scroller.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    // Scroll to the bottom and assert the LAST row is fully inside the panel's
    // box - a row clipped by the scroll container would fail here, which is the
    // exact failure the backstop exists to catch.
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const panelBox = await panel.boundingBox();
    const lastBox = await rows.last().boundingBox();
    expect(panelBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    expect(lastBox!.height).toBeGreaterThan(0);
    expect(lastBox!.y).toBeGreaterThanOrEqual(panelBox!.y - 1);
    expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  });

  test('a focus-visible outline inside the config panel is not clipped by the scroll box', async ({
    page,
  }) => {
    // THE OTHER HALF OF MOVING THE SCROLL BOX OFF THE PANEL (phase 59 review WR-08),
    // and it is a gate rather than a paragraph because the property was reasoned about
    // and wrong for a whole phase.
    //
    // Plan 59-03 moved `overflow-y: auto` from the `.fab-panel` (which carries
    // `padding: calc(var(--fab-space-md) + var(--fab-bezel-ring))` = 22px) onto an inner
    // wrapper that had NO padding at all. Setting `overflow-y` also makes `overflow-x`
    // compute to `auto`, so the wrapper clipped at its padding box - which was flush
    // with its children, since every focusable control inside is a stretched flex child
    // at the wrapper's full width. Each of them declares
    // `outline: 2px solid var(--fab-focus); outline-offset: 2px`, which extends 4px past
    // the border box and straight into the clip. MEASURED before the fix: the close
    // button clipped 4px on the right, `+ Add output` and Apply 4px on the left.
    //
    // NOTHING GATED IT. The `configpanel-scrolled` baseline captures a SCROLLED panel,
    // never a FOCUSED control; the rect gate reads geometry; the CSS walkers read
    // declarations; and axe has no rule for outline visibility, so `a11y.spec.ts` was
    // correctly green throughout. This measures the property directly.
    await selectMachine(page, FACTORY, FACTORY_BODY, null);
    const panel = page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-fab-panel-scroll]')).toHaveCount(1);

    // REAL KEYBOARD focus, not `.focus()`: `:focus-visible` is what carries the outline,
    // and a programmatic focus does not reliably match it. Tab walks into the panel and
    // every focus that lands inside the scroll box is measured.
    const measured: { name: string; left: number; right: number }[] = [];
    // 25 -> 40 IN PHASE 76, AND WHY. The walk starts at the canvas, so every Palette row
    // and every Toolbar control is a stop BEFORE the panel. At 25 the walk reached exactly
    // ONE control inside the scroll box (stop 25, `Remove output 1`); the phase 76 Label row
    // added one stop ahead of it, stop 25 became the panel's `Delete machine` (outside the
    // scroll box) and the walk measured nothing. 40 is one full cycle of today's 27 stops
    // plus slack, so the walk reaches every focusable control in the panel instead of one
    // by coincidence; the vacuity refusal below is unchanged.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const hit = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const wrap = el?.closest('[data-fab-panel-scroll]') as HTMLElement | null;
        if (!el || !wrap) return null;
        const cs = getComputedStyle(el);
        const grow = (parseFloat(cs.outlineWidth) || 0) + (parseFloat(cs.outlineOffset) || 0);
        const wcs = getComputedStyle(wrap);
        const wr = wrap.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return {
          name: (el.textContent ?? el.getAttribute('aria-label') ?? el.tagName).trim().slice(0, 24),
          // Overflow clips at the PADDING box, so the border widths come off the edges.
          left: +Math.max(0, wr.left + parseFloat(wcs.borderLeftWidth) - (r.left - grow)).toFixed(2),
          right: +Math.max(0, r.right + grow - (wr.right - parseFloat(wcs.borderRightWidth))).toFixed(2),
        };
      });
      if (hit) measured.push(hit);
    }

    // Vacuity refusal, and it is the load-bearing half: a Tab walk that never entered
    // the scroll box would report zero clipped controls forever. The panel's own close
    // button and its Apply / Revert / Add-output controls all live inside it.
    expect(measured.length, 'the Tab walk reached focusable controls inside the scroll box').toBeGreaterThan(0);
    expect(
      measured.filter((m) => m.left > 0 || m.right > 0),
      'A focus-visible outline is clipped by the config panel scroll box. The wrapper ' +
        'needs its horizontal bleed back - a negative margin with matching padding, so ' +
        'the CLIP box is wider than the children while their x positions and the panel ' +
        'geometry are unchanged. Do NOT fix this by moving the panel\'s own padding in ' +
        'here: the panel is content-box, so that shrinks its border box by 44px (and ' +
        "panel-add-remove.spec.ts's WINDOWS-id-3 note budget catches it at 640px).\n" +
        JSON.stringify(measured),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EVERY FIELD FITS ITS COLUMN (phase 91, CHROME-14, D-08, UI-SPEC section 4)
// ---------------------------------------------------------------------------
//
// The inspector's fields sit inside the panel's scroll column, in the app's own
// theme. Graded by boxes and computed attributes, never by a snapshot: for every
// kind at 1024x768 and 1280x800, each rendered `.fab-field`'s right edge is at or
// left of the scroll column's CONTENT edge (its box less its right border and
// right padding, the 16 px bleed `ConfigPanel` gives it) and the column never
// scrolls sideways (`scrollWidth === clientWidth`). Measured before the fix
// (91-MEASURE.md `## CHROME-14`): the Route `Path` box, `width: 100%` on a
// content-box field, ran 18 px past the content edge and 2 px past the column,
// which grew a horizontal scrollbar. So the Route case also reads the Path's right
// edge against Copy's and Disconnect's (UI-SPEC section 4: x 1234 at 1280 x 800,
// x 978 at 1024 x 768). The timer `Every` and the Router `At byte` fields read as
// text with a numeric keyboard and no range attributes, so no native spinner draws
// (a `type="number"` field draws the OS's light spin buttons on WebKitGTK).

/** The two sizes D-17 grades layout at. */
const FIT_SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
] as const;

/** A webhook URL long enough to reach the ellipsis (a real minted id, MEASURE). */
const SOURCE_URL = 'http://127.0.0.1:8787/hook/src-4294967297';
const ROUTE_URL = 'http://127.0.0.1:8787/endpoint/route-1';

const FIT_ROUTE: InjectNode = {
  id: 21,
  kind: 9,
  cell_x: 14,
  cell_y: 5,
  ports: [
    { index: 0, cell_x: 14, cell_y: 5, side: 3, role: 0, medium: 1 },
    { index: 1, cell_x: 14, cell_y: 5, side: 1, role: 1, medium: 1 },
  ],
};
/** The Route's Handler, the far end of its wire, so the Route's Out row shows Disconnect. */
const FIT_HANDLER: InjectNode = {
  id: 22,
  kind: 10,
  cell_x: 19,
  cell_y: 4,
  w: 3,
  h: 3,
  ports: [{ index: 0, cell_x: 19, cell_y: 5, side: 3, role: 0, medium: 1 }],
};
const FIT_WIRE: InjectWire = {
  id: 40,
  from: { node: FIT_ROUTE.id, port: 1 },
  to: { node: FIT_HANDLER.id, port: 0 },
  path: [
    [15, 5],
    [16, 5],
    [17, 5],
    [18, 5],
  ],
};

const FIT_BELT: InjectBelt = {
  id: 12,
  tiles: [
    [14, 5],
    [15, 5],
    [16, 5],
  ],
  ticksPerSlot: 4,
};

/** A Router with one In, three Outs and its Fault (the router-panel.spec.ts seating). */
const FIT_ROUTER: InjectNode = {
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

/** One kind's board, its config answer, the cell a click selects it by, and the
 *  element whose presence says its body has loaded. */
interface FitCase {
  name: string;
  nodes?: InjectNode[];
  belts?: InjectBelt[];
  wires?: InjectWire[];
  config: unknown;
  url?: string;
  click: [number, number];
  ready: string;
  /** Every `.fab-field` this kind's panel shows, by id (or title, for a URL value). */
  fields: string[];
}

const FIT_CASES: FitCase[] = [
  {
    name: 'the Source on Webhook',
    nodes: [{ ...SOURCE, cell_x: 15, cell_y: 5, ports: [{ index: 0, cell_x: 15, cell_y: 5, side: 1, role: 1, medium: 0 }] }],
    config: { kind: 'Source', trigger: { kind: 'Webhook' } },
    url: SOURCE_URL,
    click: [15, 5],
    ready: `.fab-field[title="${SOURCE_URL}"]`,
    fields: [SOURCE_URL],
  },
  {
    name: 'the Source on Timer',
    nodes: [{ ...SOURCE, cell_x: 15, cell_y: 5, ports: [{ index: 0, cell_x: 15, cell_y: 5, side: 1, role: 1, medium: 0 }] }],
    config: { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 60 } },
    click: [15, 5],
    ready: '#fab-timer-interval',
    fields: ['fab-timer-interval'],
  },
  {
    name: 'the Sink',
    nodes: [
      { id: 14, kind: 7, cell_x: 15, cell_y: 5, ports: [{ index: 0, cell_x: 15, cell_y: 5, side: 3, role: 0, medium: 0 }] },
    ],
    config: { kind: 'Sink', target: { kind: 'Http', url: 'https://example.com/a/rather/long/hook/path', method: 1 } },
    click: [15, 5],
    ready: '#fab-sink-http-url',
    fields: ['fab-sink-http-url'],
  },
  {
    name: 'the Factory',
    nodes: [{ ...FACTORY, cell_x: 14, cell_y: 4, ports: [] }],
    config: FACTORY_CONFIG,
    click: [15, 5],
    ready: '[aria-label="Ports"]',
    fields: [],
  },
  {
    name: 'the HTTP Handler',
    nodes: [{ ...FIT_HANDLER, cell_x: 14, ports: [{ index: 0, cell_x: 14, cell_y: 5, side: 3, role: 0, medium: 1 }] }],
    config: FACTORY_CONFIG,
    click: [15, 5],
    ready: '[aria-label="Ports"]',
    fields: [],
  },
  {
    name: 'the Route',
    nodes: [FIT_ROUTE, FIT_HANDLER],
    wires: [FIT_WIRE],
    config: { kind: 'Endpoint', path: '/route-1' },
    url: ROUTE_URL,
    click: [14, 5],
    ready: '#fab-route-path',
    fields: ['fab-route-path', ROUTE_URL],
  },
  {
    name: 'the Router',
    nodes: [FIT_ROUTER],
    config: { kind: 'Router', routes: [[{ offset: 0, expect: [97, 98] }, 0]], default: null },
    click: [14, 4],
    ready: '#fab-route-offset-0',
    fields: ['fab-route-expect-0', 'fab-route-offset-0'],
  },
  {
    name: 'the Tee',
    nodes: [{ ...TEE, cell_x: 15, cell_y: 5, ports: [] }],
    config: null,
    click: [15, 5],
    ready: '[aria-label="Ports"]',
    fields: [],
  },
  {
    name: 'the Belt',
    belts: [FIT_BELT],
    config: { kind: 'Belt', ticks_per_slot: 4 },
    click: [15, 5],
    ready: '#fab-belt-config',
    fields: ['fab-belt-pace'],
  },
  {
    name: 'the Label',
    nodes: [{ id: 15, kind: 11, cell_x: 14, cell_y: 5, w: 3, h: 1, label: { text: 'A note', colour: 0 } }],
    config: { kind: 'Label', text: 'A note', colour: 0, w: 3, h: 1 },
    click: [15, 5],
    ready: '#fab-label-text',
    fields: ['fab-label-text'],
  },
];

/** The CONFIG panel (the Palette is an `aside.fab-panel` too). */
function configPanel(page: Page) {
  return page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]');
}

/** Boot at `size`, inject the case's board, click-select it and wait for its body. */
async function selectFitCase(page: Page, c: FitCase, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
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
  h.inject(buildPacket({ tick: 2, nodes: c.nodes ?? [], belts: c.belts ?? [], wires: c.wires ?? [] }));
  // Labels are not counted as machines (plan 77-04), and a belt board has none. The packet's tick
  // is named, so the wait holds for the Belt and Label cases too (review IN-C01: it used to wait
  // only when the case had a machine, so those two clicked before their packet could land).
  const machines = (c.nodes ?? []).filter((n) => n.kind !== 11).length;
  await waitForBoard(page, { machines, tick: 2 });
  const at = await screenCellCentre(page, c.click[0], c.click[1]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(configPanel(page), `${c.name}: the inspector opened`).toBeVisible({ timeout: 10_000 });
  await expect(configPanel(page).locator(c.ready).first(), `${c.name}: its body loaded`).toBeVisible({
    timeout: 10_000,
  });
}

/** The scroll column's content edge, its scroll extents and every rendered field's box. */
async function readFit(page: Page) {
  return configPanel(page)
    .locator('[data-fab-panel-scroll]')
    .evaluate((col) => {
      const cs = getComputedStyle(col);
      const r = col.getBoundingClientRect();
      const fields = Array.from(col.querySelectorAll<HTMLElement>('.fab-field'))
        .map((el) => {
          const b = el.getBoundingClientRect();
          return { what: el.id || el.getAttribute('title') || el.tagName.toLowerCase(), left: b.left, right: b.right, width: b.width };
        })
        .filter((f) => f.width > 0);
      return {
        contentRight: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
        scrollWidth: col.scrollWidth,
        clientWidth: col.clientWidth,
        fields,
      };
    });
}

/** The right edge of the first element the locator finds. */
async function rightOf(l: ReturnType<Page['locator']>): Promise<number> {
  const b = await l.boundingBox();
  expect(b, 'the element has a box').not.toBeNull();
  return b!.x + b!.width;
}

/** A numeric field drawn as text: no native spinner, a numeric keyboard, no range. */
async function expectNumericTextField(l: ReturnType<Page['locator']>, what: string): Promise<void> {
  await expect(l, `${what} is a text field, so no native spinner draws`).toHaveAttribute('type', 'text');
  await expect(l, `${what} offers a numeric keyboard`).toHaveAttribute('inputmode', 'numeric');
  expect(await l.getAttribute('min'), `${what} carries no min`).toBeNull();
  expect(await l.getAttribute('max'), `${what} carries no max`).toBeNull();
}

test.describe('every field fits its column (CHROME-14, D-08)', () => {
  for (const size of FIT_SIZES) {
    for (const c of FIT_CASES) {
      test(`${c.name} at ${size.width}x${size.height}: every field fits its column`, async ({ page }) => {
        await selectFitCase(page, c, size);
        const fit = await readFit(page);
        const line = JSON.stringify(fit);
        // NON-VACUITY: the fields this kind shows are among those measured (a kind with
        // none, the Factory, the HTTP Handler and the Tee, is still graded on its scroll).
        expect(fit.fields.map((f) => f.what), `${c.name}: its fields were measured (${line})`).toEqual(
          expect.arrayContaining(c.fields),
        );
        expect(fit.fields.length, `${c.name}: no field went unmeasured (${line})`).toBe(c.fields.length);
        for (const f of fit.fields) {
          expect(f.right, `${c.name}: the field ${f.what} ends at or left of the column's content edge (${line})`).toBeLessThanOrEqual(
            fit.contentRight + 0.5,
          );
        }
        expect(fit.scrollWidth, `${c.name}: the column does not scroll sideways (${line})`).toBe(fit.clientWidth);

        const panel = configPanel(page);
        if (c.name === 'the Route') {
          const path = await rightOf(panel.locator('#fab-route-path'));
          const copy = await rightOf(panel.getByRole('button', { name: 'Copy', exact: true }));
          const disconnect = await rightOf(panel.getByRole('button', { name: /^Disconnect/ }).first());
          expect(Math.abs(path - copy), `the Path ends where Copy ends (path ${path}, copy ${copy})`).toBeLessThanOrEqual(0.5);
          expect(
            Math.abs(path - disconnect),
            `the Path ends where Disconnect ends (path ${path}, disconnect ${disconnect})`,
          ).toBeLessThanOrEqual(0.5);
          expect(Math.abs(path - fit.contentRight), `the Path ends at the content edge (${line})`).toBeLessThanOrEqual(0.5);
        }
        if (c.name === 'the Source on Timer') {
          await expectNumericTextField(panel.locator('#fab-timer-interval'), 'the timer Every field');
        }
        if (c.name === 'the Router') {
          await expectNumericTextField(panel.locator('#fab-route-offset-0'), 'the Router At byte field');
        }
        if (c.name === 'the Source on Webhook') {
          const url = panel.locator(`.fab-field[title="${SOURCE_URL}"]`);
          expect(
            await url.evaluate((el) => getComputedStyle(el).textOverflow),
            'the webhook URL keeps its ellipsis',
          ).toBe('ellipsis');
        }
      });
    }
  }
});
