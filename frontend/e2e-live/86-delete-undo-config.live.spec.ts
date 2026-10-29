import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  applyConfig,
  armAndPlaceAt,
  drawOffloadBelt,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  fillPanelField,
  handPlaceAt,
  labelBoxOn,
  labelWordsOf,
  newBoard,
  nodeAtAnchor,
  pollScene,
  pressSegment,
  pressedSegment,
  readFactorySource,
  readPanelConfig,
  readPanelUrl,
  readRouterTable,
  readScene,
  appendRouterRule,
  resetZoomToActualSize,
  screenCellCentre,
  selectMachineAt,
  typeFactorySource,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  ENDPOINT_URL_SHAPE,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 86-delete-undo-config.live.spec.ts (phase 86, plan 86-03, WORK-01, D-01, D-02) - a user
// deletes a machine they configured, presses Ctrl+Z, and gets it back WITH ITS
// CONFIGURATION, on the REAL host (dev_render_server, real Core -> RenderProducer ->
// postcard -> WS). Zero mocks, zero injected packets. Each leg reads what the user looks
// at: the config panel's own fields after the restore, and for the Route the answer an
// HTTP request gets, because a model read alone passes over a board that draws nothing
// (memory fabrico-model-oracle-blindspot).
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-01 (default): every Delete undo re-applies the deleted machine's config, captured
// when the Delete folded (a non-serialized capture keyed by the Delete record, rebuilt
// from the log after a load). D-02: the re-Configure is appended always, even when the
// config equals the kind's default. D-10 (plan 86-04): every leg reads the value three
// times, after the live Ctrl+Z, after a Save and an Open of that file, and after a second
// Delete and Ctrl+Z on the reopened board (research Pitfall 1: the reopened session is
// rebuilt from the saved log, so the last undo is the one a lost capture would break).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
// Every leg runs the same sequence on its own empty board: configure a value that differs
// from the kind's placement default (asserted) and Apply; Delete; Ctrl+Z; READ; Save to a
// temp path and Open it; READ; Delete and Ctrl+Z on the reopened board; READ. Each READ is
// what the user looks at, never the model alone.
//
//   A. THE FACTORY. A palette Factory at (10,10), its JS replaced through the editor. READ:
//      the editor holds exactly the JS the user typed, not the placement default.
//   B. THE ROUTE. A palette Route at (8,8), its path set to `/orders` and applied; the
//      panel's POST URL ends in `/orders`. A request to that URL is recorded (the Route
//      has no Handler wired, so the host answers on its deadline; the code is recorded,
//      not assumed). Delete: the same request now gets 404. Ctrl+Z: the panel's URL ends
//      in `/orders` again and the request gets the status it got before the Delete. Then
//      Save and Open: the reopened Route's panel reads `/orders` and the request answers
//      as before; Delete (404 again) and Ctrl+Z on the reopened board: the same once more.
//   C. THE HTTP HANDLER. A palette Handler at (10,10), its JS replaced. READ: the editor.
//   D. THE SINK. A palette Sink at (10,10) set to an HTTP target with the PUT method. READ:
//      the Target, URL and Method the panel shows.
//   E. THE ROUTER. A palette Router at (8,4) given two rules and a default other than the
//      first output. READ: the rules table the panel shows (`readRouterTable`).
//   F. THE SOURCE. A palette Source at (6,6) set to Timer at 150 ticks. READ: the Trigger
//      segment and the interval field, no URL row (and so no Copy button), the host
//      answering no URL for the node, and a POST to the URL it had on Webhook answered
//      404 (threat T-86-10: a Timer brought back as Webhook would open that door again).
//   G. THE DOCKED BELT. A palette Source at (6,6) with an offload belt drawn from its Out,
//      the belt's pace set to 25 px per second in the belt's own panel; the SOURCE is
//      deleted, which takes the docked belt with it. READ: a belt docked to the restored
//      Source again, and its panel showing 25. (A bare belt has no client Delete until
//      BELT-02, phase 89; the host file grades that case.)
//   H. THE LABEL (a regression leg; plan 76-05 restored it first). A Lilac 6 by 2 label
//      reading `Order intake` at (10,12). READ: its words drawn, and the Lilac box plotted.
//
// Each leg watches page errors from before `goto`, asserts the render loop is alive on
// both sides of each gesture, and asserts no page error at the end.
//
// RED AT THE START REVISION (plan 86-02's gated tree), recorded in
// 86-EVIDENCE.md `## Plan 86-03`: the Factory came back with the placement JS and the
// Route with the default path a new Route is minted (`/ep-<id>` from its new id then,
// `/route-<n>` since phase 91 D-13). Plan 86-04's legs were run against a
// mutated copy of its start revision (the Delete inverse's re-Configure narrowed back to
// labels, the cascade belt Configure removed): every leg but the label's went red there,
// recorded in 86-EVIDENCE.md `## Plan 86-04`.

/** Protocol kind bytes, as numbers on purpose: the live suite imports no product source. */
const KIND_SOURCE = 0;
const KIND_FACTORY = 2;
const KIND_ROUTER = 5;
const KIND_SINK = 7;
const KIND_ROUTE = 9;
const KIND_HANDLER = 10;
const KIND_LABEL = 11;
/** `PortFacts.role` for an output. */
const ROLE_OUT = 1;

/** The Route's Path field id (`RouteConfigBody.tsx PATH_FIELD_ID`), transcribed. */
const PATH_FIELD_ID = 'fab-route-path';

const FACTORY_CELL: readonly [number, number] = [10, 10];
const ROUTE_CELL: readonly [number, number] = [8, 8];
/** A cell no machine on either board occupies, used to close the panel. */
const EMPTY_CELL: readonly [number, number] = [2, 2];

/** The JS the user types: valid, and distinct from every placement default. */
const TYPED_JS = 'export default (payload) => ({ seen: 8603, payload });';
const TYPED_PATH = '/orders';
/** The Handler JS the user types: valid, and distinct from the Handler preset. */
const HANDLER_JS =
  'export default function (input, ctx) {\n  ctx.command({ status: 201, headers: {}, body: "86-04" }, 0);\n}';

const HANDLER_CELL: readonly [number, number] = [10, 10];
const SINK_CELL: readonly [number, number] = [10, 10];
const ROUTER_CELL: readonly [number, number] = [8, 4];
const SOURCE_CELL: readonly [number, number] = [6, 6];
/** The offload belt from the Source's Out (its Out faces E, the 85 spec's run). */
const BELT_CELLS: readonly (readonly [number, number])[] = [
  [7, 6],
  [8, 6],
  [9, 6],
];
const LABEL_CELL: readonly [number, number] = [10, 12];

/** The Sink's HTTP target, and a method other than the POST default. */
const SINK_URL = 'http://127.0.0.1:9/orders';
const SINK_METHOD = 'PUT';
/** A Timer interval other than the panel's 60-tick default. */
const TIMER_INTERVAL = '150';
/** The slow end of the belt pace scale: `25` px/sec, 20 ticks per slot. */
const PACE_LABEL = '25';
const PACE_TICKS = 20;
/** The label's words, its Lilac colour byte and the integer the canvas probe reads. */
const WORDS = 'Order intake';
const LILAC = 0xbea2ea;
const LILAC_BYTE = 3;
/** One cell in world px (`shared/geometry.ts` CELL), and the label box's inset. */
const CELL_PX = 32;
const BOX_INSET = 4;

/** An empty board at camera scale 1. */
async function emptyBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
}

/** Place `row` at `cell` and settle on the host having folded `kind` there. */
async function placeAndSettle(
  page: Page,
  row: string,
  cell: readonly [number, number],
  kind: number,
): Promise<void> {
  await resetZoomToActualSize(page);
  await armAndPlaceAt(page, row, cell[0], cell[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, cell[0], cell[1])?.kind ?? null, {
    message: `the hand-placed ${row} folded on the real host at (${cell[0]},${cell[1]})`,
  }).toBe(kind);
  await waitForCameraSettle(page);
}

/** Select the machine at `cell`, press the Delete key, and settle on the host having
 *  removed it. */
async function deleteAt(page: Page, cell: readonly [number, number]): Promise<void> {
  await selectMachineAt(page, cell[0], cell[1]);
  await page.keyboard.press('Delete');
  await pollScene(page, (s) => nodeAtAnchor(s, cell[0], cell[1])?.kind ?? null, {
    message: `the Delete key removed the machine at (${cell[0]},${cell[1]}) from the host`,
  }).toBe(null);
}

/** A click on empty floor a few px off a cell centre (so the editable-focus guard does
 *  not swallow the key), then Ctrl+Z, settling on the host having put `kind` back at
 *  `cell`. */
async function undoBackTo(page: Page, cell: readonly [number, number], kind: number): Promise<void> {
  await resetZoomToActualSize(page);
  const floor = await screenCellCentre(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await page.mouse.click(floor.x + 3, floor.y - 2);
  await expect(page.locator('#fab-config-heading'), 'no panel is open before Ctrl+Z').toHaveCount(0);
  await page.keyboard.press('Control+z');
  await pollScene(page, (s) => nodeAtAnchor(s, cell[0], cell[1])?.kind ?? null, {
    message: `Ctrl+Z put the machine back at (${cell[0]},${cell[1]})`,
  }).toBe(kind);
  await waitForCameraSettle(page);
}

/** Save the board through the toolbar's Save As (Shift-click, so the path prompt always
 *  opens, even when an earlier test in the run left a known path) and Open the same file
 *  through Load, both prompts answered with a real temp path. Settles on the host having
 *  written the file, the Load status reading `Loaded` (the first full keyframe after the
 *  dispatch) and `kind` standing at `cell` on the reopened board, then clicks empty floor
 *  so the canvas keys work again (LW-02 stands them down while a toolbar button holds
 *  focus). */
async function saveAndReopen(
  page: Page,
  label: string,
  cell: readonly [number, number],
  kind: number,
): Promise<void> {
  const fab = join(tmpdir(), `fabrico-e2e-86-04-${label}-${Date.now()}.fab`);
  await expect(page.locator('#fab-config-heading'), 'no panel is open before the Save').toHaveCount(0);
  page.once('dialog', (d) => d.accept(fab));
  await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click({ modifiers: ['Shift'] });
  await expect
    .poll(() => existsSync(fab), {
      timeout: 45_000,
      intervals: [200, 500, 1000],
      message: `the host wrote ${label}'s .fab at quiescence (a real save artifact on disk)`,
    })
    .toBe(true);
  page.once('dialog', (d) => d.accept(fab));
  await page.getByTitle('Load a saved factory').click();
  await expect
    .poll(async () => ((await page.getByRole('status').textContent()) ?? '').trim(), {
      timeout: 45_000,
      intervals: [100, 250, 500],
      message: `the Open of ${label}'s file resolved to "Loaded" (the reopened board's first keyframe)`,
    })
    .toBe('Loaded');
  await pollScene(page, (s) => nodeAtAnchor(s, cell[0], cell[1])?.kind ?? null, {
    message: `the reopened board holds the ${label} at (${cell[0]},${cell[1]})`,
  }).toBe(kind);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  const floor = await screenCellCentre(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await page.mouse.click(floor.x + 3, floor.y - 2);
  await expectRenderLoopAlive(page, `on the reopened board (${label})`);
}

/** POST once and record the status the host answers with. The Route has no Handler
 *  wired, so the host answers on its deadline sweep; the client bound is generous so a
 *  slow CPU-quota tick still yields a recorded reading rather than a stuck run. */
async function statusOf(page: Page, label: string, url: string): Promise<number> {
  const resp = await page.request.post(url, {
    data: '{"probe":"86-03"}',
    headers: { 'content-type': 'application/json' },
    timeout: 60_000,
    failOnStatusCode: false,
  });
  const status = resp.status();
  console.log(`ROUTE_READING ${JSON.stringify({ label, url, status })}`);
  return status;
}

/** The Route at [`ROUTE_CELL`]: its panel's URL is `url` (the typed path), and a POST there
 *  gets `want`, the status it got before the first Delete. */
async function expectRouteAt(page: Page, url: string, want: number, when: string): Promise<void> {
  await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
  await expect
    .poll(async () => readPanelUrl(page), {
      timeout: 15_000,
      intervals: [100, 250, 500],
      message: `${when}: the Route panel shows the /orders path`,
    })
    .toBe(url);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await expect
    .poll(async () => statusOf(page, when, url), {
      timeout: 90_000,
      intervals: [200, 500, 1000],
      message: `${when}: /orders answers as it did before the Delete`,
    })
    .toBe(want);
}

/** The JS the panel's editor shows for the machine at `cell`. */
async function editorJsAt(page: Page, cell: readonly [number, number]): Promise<string> {
  await selectMachineAt(page, cell[0], cell[1]);
  const js = await readFactorySource(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  return js;
}

/** One JS leg (a Factory or an HTTP Handler): type `js`, Apply, then the three reads. */
async function jsLeg(
  page: Page,
  row: string,
  cell: readonly [number, number],
  kind: number,
  js: string,
): Promise<void> {
  const errs = watchPageErrors(page);
  await emptyBoard(page);
  await expectRenderLoopAlive(page, 'on the empty board');

  await placeAndSettle(page, row, cell, kind);
  await selectMachineAt(page, cell[0], cell[1]);
  expect(await readFactorySource(page), `the leg types JS that differs from the ${row} placement default`).not.toBe(js);
  await typeFactorySource(page, js);
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  expect(await editorJsAt(page, cell), 'the panel reads the applied JS before the Delete').toBe(js);
  await expectRenderLoopAlive(page, 'after the Apply');

  await deleteAt(page, cell);
  await undoBackTo(page, cell, kind);
  expect(await editorJsAt(page, cell), `after the Ctrl+Z: the restored ${row} carries the JS the user typed`).toBe(js);
  await expectRenderLoopAlive(page, 'after the Ctrl+Z');

  await saveAndReopen(page, row, cell, kind);
  expect(await editorJsAt(page, cell), `after the reopen: the ${row} carries the JS the user typed`).toBe(js);

  await deleteAt(page, cell);
  await undoBackTo(page, cell, kind);
  expect(
    await editorJsAt(page, cell),
    `after the second Ctrl+Z, on the reopened board: the ${row} carries the JS the user typed`,
  ).toBe(js);
  await expectRenderLoopAlive(page, 'after the second Ctrl+Z');
  errs.assertNone(`across configure, delete, undo, save, open, delete and undo of a ${row}`);
}

/** What the Router panel calls an output (phase 91, D-12, CHROME-13, UI-SPEC 8.6): `Output N`,
 *  N its routing key + 1 (its position among the Router's Outs in packet order, which is
 *  `outs`' order), plus ` (Target)` only when its belt reaches a machine. Every offload belt
 *  here ends on open floor, so no name carries a target. Until phase 91 the panel named each
 *  output by its nub's grid cell. */
function outputLabel(outs: readonly PortFacts[], port: PortFacts): string {
  const n = outs.indexOf(port) + 1;
  expect(n, 'the port is one of the Router Outs').toBeGreaterThan(0);
  return `Output ${n}`;
}

/** The Out ports of the node anchored at `cell`, in routing-key order. */
async function outsAt(page: Page, cell: readonly [number, number]): Promise<PortFacts[]> {
  const node = nodeAtAnchor(await readScene(page), cell[0], cell[1]);
  expect(node, `a machine stands at (${cell[0]},${cell[1]})`).toBeDefined();
  return node!.ports.filter((p) => p.role === ROLE_OUT);
}

/** The panel's URL row, the span `readPanelUrl` reads (an empty locator when absent). */
function urlRow(page: Page) {
  return page.locator('span.fab-field', { hasText: 'http://127.0.0.1:' });
}

/** POST once, the way 85-timer-source-refuses-webhook does, and return the status. */
async function postStatus(page: Page, url: string): Promise<number> {
  const resp = await page.request.post(url, { data: { hello: 8604 }, failOnStatusCode: false });
  return resp.status();
}

/** The Source at [`SOURCE_CELL`] reads as the Timer the user set: the Trigger segment and
 *  the interval field in its panel, no URL row and no Copy button, no URL from the host for
 *  the node, and a POST to its Webhook URL refused with 404. */
async function expectTimerSource(page: Page, webhookUrlBefore: string, when: string): Promise<void> {
  const node = await selectMachineAt(page, SOURCE_CELL[0], SOURCE_CELL[1]);
  expect(await pressedSegment(page, 'Trigger'), `${when}: the Trigger segment reads Timer`).toBe('Timer');
  await expect(page.locator('#fab-timer-interval'), `${when}: the interval field reads ${TIMER_INTERVAL}`).toHaveValue(
    TIMER_INTERVAL,
  );
  await expect(urlRow(page), `${when}: a Timer Source shows no URL row`).toHaveCount(0, { timeout: 10_000 });
  await expect(
    page.getByRole('button', { name: /^(Copy|Copied|Copy failed)$/ }),
    `${when}: and no Copy button`,
  ).toHaveCount(0);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  expect(await webhookUrl(page, node.id), `${when}: the host answers no URL for the restored Source`).toBeNull();
  expect(await postStatus(page, webhookUrlBefore), `${when}: a POST to the Webhook URL is refused with 404`).toBe(404);
}

/** The belt standing on `cell`, off the scene. */
function beltOn(scene: SceneFacts, cell: readonly [number, number]): SceneFacts['belts'][number] | undefined {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/** Open the belt's own panel by clicking its first tile, read the pace it shows (the
 *  pressed scale segment and the typed field), and close it. */
async function beltPanelPace(page: Page): Promise<{ segment: string; field: string }> {
  await resetZoomToActualSize(page);
  const at = await screenCellCentre(page, BELT_CELLS[0][0], BELT_CELLS[0][1]);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#fab-belt-config'), 'the click on the belt opened its own panel').toBeVisible({
    timeout: 15_000,
  });
  const pace = {
    segment: await pressedSegment(page, 'Belt pace'),
    field: await page.locator('#fab-belt-pace').inputValue(),
  };
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  return pace;
}

/** The belt on [`BELT_CELLS`] is docked to the Source at [`SOURCE_CELL`] and its panel
 *  shows the pace the user set. */
async function expectDockedBeltAtPace(page: Page, when: string): Promise<void> {
  await pollScene(
    page,
    (s) => {
      const source = nodeAtAnchor(s, SOURCE_CELL[0], SOURCE_CELL[1]);
      const belt = beltOn(s, BELT_CELLS[0]);
      return source !== undefined && belt !== undefined && belt.docks.some((d) => d.node === source.id);
    },
    { message: `${when}: a belt stands on the Source's offload cells, docked to the Source` },
  ).toBe(true);
  expect(await beltPanelPace(page), `${when}: the belt's panel shows the pace the user set`).toEqual({
    segment: PACE_LABEL,
    field: PACE_LABEL,
  });
}

/** The 12 cells of a 6 by 2 label anchored at (10,12), row-major. */
const SIX_BY_TWO_AT_10_12 = [
  '10,12', '11,12', '12,12', '13,12', '14,12', '15,12',
  '10,13', '11,13', '12,13', '13,13', '14,13', '15,13',
];

function sortedCells(node: SceneFacts['nodes'][number]): string[] {
  return [...node.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([x, y]) => `${x},${y}`);
}

/** The label at [`LABEL_CELL`] reads as the user left it: its words drawn on the page and
 *  a Lilac 6 by 2 box plotted on the canvas. */
async function expectLabel(page: Page, when: string): Promise<void> {
  await pollScene(
    page,
    (s) => {
      const n = nodeAtAnchor(s, LABEL_CELL[0], LABEL_CELL[1]);
      return n ? { kind: n.kind, cells: sortedCells(n), label: n.label } : null;
    },
    { message: `${when}: the label stands at (10,12) on its 12 cells with its words and Lilac` },
  ).toEqual({ kind: KIND_LABEL, cells: SIX_BY_TWO_AT_10_12, label: { text: WORDS, colour: LILAC_BYTE } });
  const id = nodeAtAnchor(await readScene(page), LABEL_CELL[0], LABEL_CELL[1])!.id;
  await expect
    .poll(async () => labelWordsOf(page, id), { message: `${when}: the label's words are drawn` })
    .toMatchObject({ text: WORDS, visible: true });
  await expect
    .poll(async () => labelBoxOn(page, id), { message: `${when}: the label's Lilac 6 by 2 box is plotted` })
    .toMatchObject({
      instructions: 2,
      fill: { color: LILAC, alpha: 0.16 },
      stroke: { color: LILAC, alpha: 1 },
      rect: {
        x: 10 * CELL_PX + BOX_INSET,
        y: 12 * CELL_PX + BOX_INSET,
        w: 6 * CELL_PX - 2 * BOX_INSET,
        h: 2 * CELL_PX - 2 * BOX_INSET,
      },
    });
}

/** Select the label with a plain click off-centre on its box, press Delete, and settle on
 *  the host having removed it. */
async function deleteLabel(page: Page): Promise<void> {
  await resetZoomToActualSize(page);
  const onBox = await screenCellCentre(page, 13, 13);
  await page.mouse.click(onBox.x + 3, onBox.y - 2);
  await expect(page.locator('#fab-label-width'), 'the click selected the label (its panel is open)').toHaveText('6');
  await expect(page.locator('#fab-label-text'), 'the click did not focus the Text field').not.toBeFocused();
  await page.keyboard.press('Delete');
  await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_LABEL).length, {
    message: 'the Delete key removed the label from the host',
  }).toBe(0);
}

test.describe('D-01 live: Delete then Ctrl+Z brings a machine back with its config', () => {
  test('leg A: a Factory with typed JS comes back with that JS, live and after a reopen', async ({ page }) => {
    test.setTimeout(240_000);
    await jsLeg(page, 'Factory', FACTORY_CELL, KIND_FACTORY, TYPED_JS);
  });

  test('leg B: a Route at /orders, deleted and undone, answers at /orders as it did before, live and after a reopen', async ({ page }) => {
    test.setTimeout(360_000);
    const errs = watchPageErrors(page);
    await emptyBoard(page);
    await expectRenderLoopAlive(page, 'on the empty board');

    await placeAndSettle(page, 'Route', ROUTE_CELL, KIND_ROUTE);
    await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
    const seededUrl = await readPanelUrl(page);
    expect(seededUrl, 'the placed Route starts at its seeded path').not.toContain(TYPED_PATH);
    await fillPanelField(page, PATH_FIELD_ID, TYPED_PATH);
    await applyConfig(page);
    await expect
      .poll(async () => readPanelUrl(page), {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'the POST URL row followed the committed path after Apply',
      })
      .not.toBe(seededUrl);
    const url = await readPanelUrl(page);
    expect(url, 'the URL ends at the path the user typed').toMatch(ENDPOINT_URL_SHAPE);
    expect(url.endsWith(`/endpoint${TYPED_PATH}`), `the URL ends in /endpoint${TYPED_PATH}: ${url}`).toBe(true);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await expectRenderLoopAlive(page, 'after the Apply');

    const before = await statusOf(page, 'before the Delete', url);
    expect(before, 'a Route standing at /orders answers with something other than 404').not.toBe(404);

    await deleteAt(page, ROUTE_CELL);
    await expect
      .poll(async () => statusOf(page, 'while deleted', url), {
        timeout: 15_000,
        intervals: [200, 500, 1000],
        message: 'with the Route deleted, /orders is not found',
      })
      .toBe(404);
    await expectRenderLoopAlive(page, 'after the Delete');

    await undoBackTo(page, ROUTE_CELL, KIND_ROUTE);
    await expectRouteAt(page, url, before, 'after the Ctrl+Z');
    await expectRenderLoopAlive(page, 'after the Ctrl+Z');

    await saveAndReopen(page, 'Route', ROUTE_CELL, KIND_ROUTE);
    await expectRouteAt(page, url, before, 'after the reopen');

    await deleteAt(page, ROUTE_CELL);
    await expect
      .poll(async () => statusOf(page, 'while deleted on the reopened board', url), {
        timeout: 15_000,
        intervals: [200, 500, 1000],
        message: 'with the reopened Route deleted, /orders is not found',
      })
      .toBe(404);
    await undoBackTo(page, ROUTE_CELL, KIND_ROUTE);
    await expectRouteAt(page, url, before, 'after the second Ctrl+Z, on the reopened board');
    await expectRenderLoopAlive(page, 'after the second Ctrl+Z');
    errs.assertNone('across place, configure, delete, undo, save, open, delete and undo of a Route');
  });
  test('leg C: an HTTP Handler with typed JS comes back with that JS, live and after a reopen', async ({ page }) => {
    test.setTimeout(240_000);
    await jsLeg(page, 'HTTP Handler', HANDLER_CELL, KIND_HANDLER, HANDLER_JS);
  });

  test('leg D: a Sink with an HTTP target and the PUT method comes back with both, live and after a reopen', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errs = watchPageErrors(page);
    await emptyBoard(page);
    await expectRenderLoopAlive(page, 'on the empty board');
    const want = { kind: 'Sink', target: 'HTTP', url: SINK_URL, method: SINK_METHOD };
    const read = async (when: string) => {
      await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
      expect(await readPanelConfig(page), `${when}: the Sink panel shows the HTTP target, URL and method`).toEqual(want);
      await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    };

    await placeAndSettle(page, 'Sink', SINK_CELL, KIND_SINK);
    await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
    expect(await readPanelConfig(page), 'a placed Sink starts on the Debug target (the default)').toEqual({
      kind: 'Sink',
      target: 'Debug',
    });
    await pressSegment(page, 'Target', 'HTTP');
    await fillPanelField(page, 'fab-sink-http-url', SINK_URL);
    await pressSegment(page, 'Method', SINK_METHOD);
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await read('before the Delete');

    await deleteAt(page, SINK_CELL);
    await undoBackTo(page, SINK_CELL, KIND_SINK);
    await read('after the Ctrl+Z');
    await saveAndReopen(page, 'Sink', SINK_CELL, KIND_SINK);
    await read('after the reopen');
    await deleteAt(page, SINK_CELL);
    await undoBackTo(page, SINK_CELL, KIND_SINK);
    await read('after the second Ctrl+Z, on the reopened board');
    await expectRenderLoopAlive(page, 'after the second Ctrl+Z');
    errs.assertNone('across configure, delete, undo, save, open, delete and undo of a Sink');
  });

  test('leg E: a Router with two rules and a default comes back with its table, live and after a reopen', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errs = watchPageErrors(page);
    await emptyBoard(page);
    await expectRenderLoopAlive(page, 'on the empty board');

    await placeAndSettle(page, 'Router', ROUTER_CELL, KIND_ROUTER);
    const outs = await outsAt(page, ROUTER_CELL);
    expect(outs.length, 'the Router has three outputs to name').toBeGreaterThanOrEqual(3);
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    const placed = await readRouterTable(page);
    const want = {
      rules: [
        { target: outputLabel(outs, outs[1]), expect: 'A', offset: '0' },
        { target: outputLabel(outs, outs[2]), expect: 'refund', offset: '2' },
      ],
      fallback: outputLabel(outs, outs[2]),
    };
    expect(placed, 'a placed Router starts with no rules and its first output as the default').toEqual({
      rules: [],
      fallback: outputLabel(outs, outs[0]),
    });
    await appendRouterRule(page, { expect: 'A', offset: 0, target: outputLabel(outs, outs[1]) });
    await appendRouterRule(page, { expect: 'refund', offset: 2, target: outputLabel(outs, outs[2]) });
    await pressSegment(page, 'Default', outputLabel(outs, outs[2]));
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    const read = async (when: string) => {
      await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
      expect(await readRouterTable(page), `${when}: the Router panel shows both rules and the default`).toEqual(want);
      await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    };
    await read('before the Delete');

    await deleteAt(page, ROUTER_CELL);
    await undoBackTo(page, ROUTER_CELL, KIND_ROUTER);
    await read('after the Ctrl+Z');
    await saveAndReopen(page, 'Router', ROUTER_CELL, KIND_ROUTER);
    await read('after the reopen');
    await deleteAt(page, ROUTER_CELL);
    await undoBackTo(page, ROUTER_CELL, KIND_ROUTER);
    await read('after the second Ctrl+Z, on the reopened board');
    await expectRenderLoopAlive(page, 'after the second Ctrl+Z');
    errs.assertNone('across configure, delete, undo, save, open, delete and undo of a Router');
  });

  test('leg F: a Source on Timer comes back on Timer with its interval and no door, live and after a reopen', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errs = watchPageErrors(page);
    await emptyBoard(page);
    await expectRenderLoopAlive(page, 'on the empty board');

    await placeAndSettle(page, 'Source', SOURCE_CELL, KIND_SOURCE);
    await selectMachineAt(page, SOURCE_CELL[0], SOURCE_CELL[1]);
    expect(await pressedSegment(page, 'Trigger'), 'a placed Source starts on Webhook (the default)').toBe('Webhook');
    const webhookUrlBefore = await readPanelUrl(page);
    expect(webhookUrlBefore, 'on Webhook the panel shows a Source URL').toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', TIMER_INTERVAL);
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await expectTimerSource(page, webhookUrlBefore, 'before the Delete');

    await deleteAt(page, SOURCE_CELL);
    await undoBackTo(page, SOURCE_CELL, KIND_SOURCE);
    await expectTimerSource(page, webhookUrlBefore, 'after the Ctrl+Z');
    await saveAndReopen(page, 'Source', SOURCE_CELL, KIND_SOURCE);
    await expectTimerSource(page, webhookUrlBefore, 'after the reopen');
    await deleteAt(page, SOURCE_CELL);
    await undoBackTo(page, SOURCE_CELL, KIND_SOURCE);
    await expectTimerSource(page, webhookUrlBefore, 'after the second Ctrl+Z, on the reopened board');
    await expectRenderLoopAlive(page, 'after the second Ctrl+Z');
    errs.assertNone('across configure, delete, undo, save, open, delete and undo of a Source');
  });

  test('leg G: a belt docked to a deleted Source comes back docked at its pace, live and after a reopen', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errs = watchPageErrors(page);
    await emptyBoard(page);
    await expectRenderLoopAlive(page, 'on the empty board');

    await placeAndSettle(page, 'Source', SOURCE_CELL, KIND_SOURCE);
    const [out] = await outsAt(page, SOURCE_CELL);
    expect(out, 'the placed Source has an Out port').toBeDefined();
    await drawOffloadBelt(page, out, BELT_CELLS);
    await pollScene(page, (s) => {
      const source = nodeAtAnchor(s, SOURCE_CELL[0], SOURCE_CELL[1]);
      const belt = beltOn(s, BELT_CELLS[0]);
      return source !== undefined && belt !== undefined && belt.docks.some((d) => d.node === source.id);
    }, { message: 'the offload belt was drawn from the Source and docked to it' }).toBe(true);
    const drawnPace = beltOn(await readScene(page), BELT_CELLS[0])!.ticksPerSlot;
    expect(drawnPace, `a drawn belt does not start at ${PACE_TICKS} ticks per slot`).not.toBe(PACE_TICKS);

    await resetZoomToActualSize(page);
    const at = await screenCellCentre(page, BELT_CELLS[0][0], BELT_CELLS[0][1]);
    await page.mouse.click(at.x, at.y);
    await expect(page.locator('#fab-belt-config'), 'the click on the belt opened its own panel').toBeVisible({
      timeout: 15_000,
    });
    expect(await pressedSegment(page, 'Belt pace'), 'the drawn belt does not show the leg pace').not.toBe(PACE_LABEL);
    await page
      .getByRole('group', { name: 'Belt pace' })
      .getByRole('button', { name: `${PACE_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await pollScene(page, (s) => beltOn(s, BELT_CELLS[0])?.ticksPerSlot ?? -1, {
      message: 'the committed pace reached the belt',
    }).toBe(PACE_TICKS);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await expectDockedBeltAtPace(page, 'before the Delete');

    const deleteSourceAndItsBelt = async (when: string) => {
      await deleteAt(page, SOURCE_CELL);
      await pollScene(page, (s) => beltOn(s, BELT_CELLS[0]) === undefined, {
        message: `${when}: the Source's Delete took the docked belt with it`,
      }).toBe(true);
    };
    await deleteSourceAndItsBelt('live');
    await undoBackTo(page, SOURCE_CELL, KIND_SOURCE);
    await expectDockedBeltAtPace(page, 'after the Ctrl+Z');
    await saveAndReopen(page, 'Source with a docked belt', SOURCE_CELL, KIND_SOURCE);
    await expectDockedBeltAtPace(page, 'after the reopen');
    await deleteSourceAndItsBelt('on the reopened board');
    await undoBackTo(page, SOURCE_CELL, KIND_SOURCE);
    await expectDockedBeltAtPace(page, 'after the second Ctrl+Z, on the reopened board');
    await expectRenderLoopAlive(page, 'after the second Ctrl+Z');
    errs.assertNone('across pace, delete, undo, save, open, delete and undo of a docked belt');
  });

  test('leg H: a Lilac 6 by 2 label comes back whole, live and after a reopen (regression)', async ({ page }) => {
    test.setTimeout(240_000);
    const errs = watchPageErrors(page);
    await emptyBoard(page);
    await expectRenderLoopAlive(page, 'on the empty board');

    await handPlaceAt(page, 'Label', LABEL_CELL[0], LABEL_CELL[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, LABEL_CELL[0], LABEL_CELL[1])?.kind ?? null, {
      message: 'the real host echoed a label anchored at (10,12)',
    }).toBe(KIND_LABEL);
    await expect(page.locator('#fab-label-text'), 'the placed label focuses its Text field').toBeFocused();
    const placed = nodeAtAnchor(await readScene(page), LABEL_CELL[0], LABEL_CELL[1])!;
    expect(placed.label?.text ?? '', 'a placed label starts without the leg words').not.toBe(WORDS);
    expect(placed.cells.length, 'a placed label starts smaller than 6 by 2').toBeLessThan(12);
    await page.keyboard.type(WORDS);
    await page.getByRole('button', { name: 'Lilac', exact: true }).click();
    const wider = page.getByRole('button', { name: 'Increase width', exact: true });
    await wider.click();
    await wider.click();
    await page.getByRole('button', { name: 'Increase depth', exact: true }).click();
    await expect(page.locator('#fab-label-width'), 'the width readout').toHaveText('6');
    await expect(page.locator('#fab-label-depth'), 'the depth readout').toHaveText('2');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expectLabel(page, 'before the Delete');
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    await deleteLabel(page);
    await undoBackTo(page, LABEL_CELL, KIND_LABEL);
    await expectLabel(page, 'after the Ctrl+Z');
    await saveAndReopen(page, 'label', LABEL_CELL, KIND_LABEL);
    await expectLabel(page, 'after the reopen');
    await deleteLabel(page);
    await undoBackTo(page, LABEL_CELL, KIND_LABEL);
    await expectLabel(page, 'after the second Ctrl+Z, on the reopened board');
    await expectRenderLoopAlive(page, 'after the second Ctrl+Z');
    errs.assertNone('across configure, delete, undo, save, open, delete and undo of a label');
  });
});
