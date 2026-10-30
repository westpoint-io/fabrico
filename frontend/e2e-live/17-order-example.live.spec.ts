import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import {
  DEMO_NODE_COUNT,
  addOutputViaPanel,
  anchorOf,
  applyConfig,
  armAndPlaceAt,
  drawBeltThroughCells,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  fillPanelField,
  loadDemoViaExamples,
  loadExample,
  newBoard,
  nodeAtAnchor,
  pollScene,
  pressSegment,
  readBeltFlowWatch,
  readPanelConfig,
  readScene,
  selectMachineAt,
  startBeltFlowWatch,
  stopBeltFlowWatch,
  typeFactorySource,
  waitForAppReady,
  watchPageErrors,
  webhookUrl,
  type PanelConfigFacts,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 17-order-example.live.spec.ts (EX-02) - the AUTOMATED BACKSTOP for the v6.2
// done-test, in two halves against the real dev_render_server + real Core:
//
//   SC1 live: load the SHIPPED order scene through the Examples popover, POST a
//     real order at the Source's own webhook URL, and watch it split down BOTH
//     branch corridors and land ONE real outbound HTTP action on a listener this
//     spec binds off-board.
//   SC3 live: REBUILD that same example from an EMPTY board using nothing but UI
//     gestures - palette placements, the panel's "+ Add output", nub-to-nub belt
//     drags along the authored cell paths, panel-body Configures with Apply - and
//     prove it equivalent to the shipped data two ways: STATIC (normalised
//     topology + config equality) and DYNAMIC (same webhook in, same bytes out).
//
// ────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC DELIBERATELY DOES NOT CLAIM
//
// 1. The INVOICE half of SC1 ends in a Debug sink (plan 85-03, D-08: the shipped
//    app cannot send mail, so the example no longer offers an Email sink). A
//    Debug sink makes no outbound call, so there is nothing off the board to
//    capture. What is asserted is what the board shows: the invoice item
//    traversed the sink-adjacent belt, was TAKEN by the Debug sink, and the sink
//    settles IDLE rather than FAULTED. A failed dispatch leaves an undrained
//    fault that `derive_state` reads, so the state byte is the board's own
//    record of a delivery that failed; while this branch ended in an Email sink
//    on a host with `smtp: None`, that byte read FAULTED.
//
//    The dispatch postures (one Debug invoice and one HTTP POST per order,
//    exactly once across replay) are proven in Rust (`order_flow.rs`
//    `one_order_splits_and_both_sinks_dispatch`), which is where that evidence
//    belongs.
// 2. There is NO live comparison of the two boards' sim digests, here or
//    anywhere. Such a comparison is not merely hard, it is structurally FALSE:
//    the digest covers the running tick counter and the RNG stream, so two live
//    boards can never share one. Equivalence is proven by the two oracle layers
//    below instead - which is a stronger claim anyway, because they compare what
//    the boards ARE and what they DO rather than a number.
// 3. Every step of the rebuild is a real gesture. Nothing in this file reaches
//    the command layer directly; if a step were impossible through the shipped
//    UI, that would be a FINDING about the done-test, not a licence to bypass it.
// ────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

// ── The scene, as authored (examples/boards/order_processing.board.ron)
//
// ONE constants table, transcribed from the RON, so every coordinate in this file
// has a single provenance. The rebuild targets these cells because the equivalence
// compare below is only meaningful if the target cells are the shipped scene's
// OWN - a rebuild at different cells would prove a different factory works, not
// that THIS example is reproducible by hand.

const KIND_SOURCE = 0;
const KIND_FACTORY = 2;
const KIND_SINK = 7;

/** Anchor cells of the six machines (RON `Place` order = the mint order). */
const AT = {
  source: [1, 6],
  splitter: [5, 5],
  invoice: [13, 2],
  fulfilment: [13, 9],
  invoiceSink: [21, 3],
  httpSink: [21, 10],
} as const;

/** `NodeView.state` bytes, mirrored from `src/protocol/kinds.ts` (the zero-mock live
 *  suite does not import src/): 0 = IDLE, 2 = FAULTED. */
const STATE_IDLE = 0;
const STATE_FAULTED = 2;

/** The five authored belt runs: source port cell -> destination port cell, and the
 *  EXACT cell path between them (RON `DrawBelt` order). The three splitter runs moved
 *  one row down in 74.1-14 with `order_processing.board.ron`: the splitter's AddPort now keeps
 *  its catalog ports (In (5,6), Out_0 (7,6)) and seats the new Out at (7,7). */
const BELT_RUNS = [
  {
    name: 'source -> splitter In',
    from: AT.source,
    fromPortCell: [1, 6],
    to: AT.splitter,
    toPortCell: [5, 6],
    cells: [
      [2, 6],
      [3, 6],
      [4, 6],
    ],
  },
  {
    name: 'splitter Out 1 (emit 0, invoice) -> invoice In',
    from: AT.splitter,
    fromPortCell: [7, 6],
    to: AT.invoice,
    toPortCell: [13, 3],
    cells: [
      [8, 6],
      [9, 6],
      [9, 5],
      [9, 4],
      [9, 3],
      [10, 3],
      [11, 3],
      [12, 3],
    ],
  },
  {
    name: 'splitter Out 2 (emit 1, fulfillment) -> fulfillment In',
    from: AT.splitter,
    fromPortCell: [7, 7],
    to: AT.fulfilment,
    toPortCell: [13, 10],
    cells: [
      [8, 7],
      [9, 7],
      [9, 8],
      [9, 9],
      [9, 10],
      [10, 10],
      [11, 10],
      [12, 10],
    ],
  },
  {
    name: 'invoice -> Debug sink',
    from: AT.invoice,
    fromPortCell: [15, 3],
    to: AT.invoiceSink,
    toPortCell: [21, 3],
    cells: [
      [16, 3],
      [17, 3],
      [18, 3],
      [19, 3],
      [20, 3],
    ],
  },
  {
    name: 'fulfillment -> HTTP sink',
    from: AT.fulfilment,
    fromPortCell: [15, 10],
    to: AT.httpSink,
    toPortCell: [21, 10],
    cells: [
      [16, 10],
      [17, 10],
      [18, 10],
      [19, 10],
      [20, 10],
    ],
  },
] as const;

/** The three inline handlers, byte-verbatim from the RON raw strings. */
const JS_SPLITTER = `// validate and split the order
export default function (input, ctx) {
  if (!input || !input.id || !Array.isArray(input.items)) { throw new Error("not an order"); }
  ctx.emit(0, { kind: "invoice", order: input.id, items: input.items });
  ctx.emit(1, { kind: "fulfillment", order: input.id, items: input.items });
}`;

const JS_INVOICE = `// build the invoice
export default function (input, ctx) {
  var total = 0;
  for (var i = 0; i < input.items.length; i++) { total += input.items[i].qty * input.items[i].price; }
  ctx.emit(0, { order: input.order, total: total });
}`;

const JS_FULFILMENT = `// prepare fulfillment
export default function (input, ctx) {
  ctx.emit(0, { order: input.order, ship: input.items });
}`;

/** The authored sink targets + Source trigger, as the panel bodies render them. */
const HTTP_PORT = 8799;
const HTTP_PATH = '/fulfillment';
const HTTP_URL = `http://localhost:${HTTP_PORT}${HTTP_PATH}`;
const HTTP_METHOD = 'POST';

/** The SAME order body the Rust proofs use (order_flow.rs `ORDER_BODY`). */
const ORDER_BODY = '{"id":"ord-1","items":[{"sku":"widget","qty":2,"price":5}]}';

/** An always-empty cell used to deselect: clear of every machine on BOTH boards,
 *  clear of the left palette, and left of the right-edge config panel. */
const EMPTY_CELL = [2, 12] as const;

/** The config each machine must read back with - the authored values, per anchor. */
const EXPECTED_CONFIG: Record<string, PanelConfigFacts> = {
  [String(AT.source)]: { kind: 'Source', trigger: 'Webhook' },
  [String(AT.splitter)]: { kind: 'Factory', source: JS_SPLITTER },
  [String(AT.invoice)]: { kind: 'Factory', source: JS_INVOICE },
  [String(AT.fulfilment)]: { kind: 'Factory', source: JS_FULFILMENT },
  [String(AT.invoiceSink)]: { kind: 'Sink', target: 'Debug' },
  [String(AT.httpSink)]: {
    kind: 'Sink',
    target: 'HTTP',
    url: HTTP_URL,
    method: HTTP_METHOD,
  },
};

// ---------------------------------------------------------------------------
// The off-board listener: the real outbound action, observed outside the app
// ---------------------------------------------------------------------------
//
// The shipped HTTP sink's URL is DATA (`http://localhost:8799/fulfillment` in the
// RON, T-55-02: a harmless, user-editable loopback default), so the port is fixed
// by the scene and this spec must bind exactly it. Two loopback listeners are
// bound because `localhost` resolves to ::1 BEFORE 127.0.0.1 on a modern Linux
// resolver; binding both keeps the executor's connect deterministic instead of
// leaning on its happy-eyeballs fallback. Both are loopback-only and both are
// closed in afterAll (T-55-07).

interface CapturedPost {
  method: string;
  path: string;
  body: string;
  idempotencyKey: string;
}

const captured: CapturedPost[] = [];
const listeners: Server[] = [];
/** Non-null when port 8799 could not be bound - the LOUD skip reason. */
let bindFailure: string | null = null;

function bindLoopback(host: string): Promise<Server | Error> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        captured.push({
          method: req.method ?? '',
          path: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    server.once('error', (err: Error) => resolve(err));
    server.listen(HTTP_PORT, host, () => resolve(server));
  });
}

test.beforeAll(async () => {
  const v4 = await bindLoopback('127.0.0.1');
  if (v4 instanceof Error) {
    bindFailure =
      `could not bind the fulfillment listener on 127.0.0.1:${HTTP_PORT} (${v4.message}). ` +
      `Port ${HTTP_PORT} is the SHIPPED sink URL in order_processing.board.ron, so this spec cannot ` +
      `observe the real outbound action without it. Free port ${HTTP_PORT} and re-run.`;
    return;
  }
  listeners.push(v4);
  // Best-effort: a box without IPv6 loopback is fine, the executor falls back.
  const v6 = await bindLoopback('::1');
  if (!(v6 instanceof Error)) listeners.push(v6);
});

test.afterAll(async () => {
  await Promise.all(
    listeners.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  listeners.length = 0;
});

/** The capture from SC1's POST at the SHIPPED scene - the dynamic oracle's
 *  reference bytes, carried into SC3 by the serial describe. */
let shippedPost: CapturedPost | null = null;

// ---------------------------------------------------------------------------
// Scene helpers local to this spec (the equivalence oracle itself)
// ---------------------------------------------------------------------------

/** Outward unit step for a port `side` (N=0, E=1, S=2, W=3) - the cell a port
 *  feeds into / is fed from, mirroring gestures.ts `unitDelta`. */
function unitDelta(side: number): [number, number] {
  switch (side & 3) {
    case 0:
      return [0, -1];
    case 1:
      return [1, 0];
    case 2:
      return [0, 1];
    default:
      return [-1, 0];
  }
}

/** The port of `node` seated at world cell (cx, cy) with `role`. */
function portAtCell(
  node: SceneFacts['nodes'][number],
  cx: number,
  cy: number,
  role: number,
): PortFacts {
  const port = node.ports.find((p) => p.cell_x === cx && p.cell_y === cy && p.role === role);
  expect(
    port,
    `the machine at anchor (${anchorOf(node)}) carries a role-${role} port at (${cx},${cy})`,
  ).toBeDefined();
  return port as PortFacts;
}

/**
 * LAYER 1, the STATIC oracle: a scene reduced to handle-free topology.
 *
 * Machines are sorted by (kind, anchor) - unique per board, because occupancy is
 * exclusive - and every dock's node reference is remapped through that sort, so
 * the dense render handles (which differ between a shipped genesis seed and a
 * hand-built board, and which any keyframe re-mints) drop out entirely. Ports
 * carry role/side/medium/world-cell; belts carry their ORDERED routed cell run
 * plus their dock links. Two boards that reduce to the same value are the same
 * factory.
 */
function normaliseTopology(scene: SceneFacts) {
  const nodes = [...scene.nodes].sort((a, b) => {
    const [ax, ay] = anchorOf(a);
    const [bx, by] = anchorOf(b);
    return a.kind - b.kind || ax - bx || ay - by;
  });
  const seat = new Map(nodes.map((n, i) => [n.id, i]));
  return {
    nodes: nodes.map((n) => ({
      kind: n.kind,
      cells: n.cells.map(([x, y]) => `${x},${y}`).sort(),
      ports: n.ports
        .map((p) => `role${p.role}/side${p.side}/medium${p.medium}@${p.cell_x},${p.cell_y}`)
        .sort(),
    })),
    belts: scene.belts
      .map((b) => ({
        run: b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' -> '),
        docks: b.docks
          .map((d) => `${d.end}:seat${seat.get(d.node) ?? 'UNKNOWN'}:port${d.port}`)
          .sort(),
      }))
      .sort((a, b) => a.run.localeCompare(b.run)),
  };
}

/**
 * Deselect at the Fit camera. Selecting a machine under the inspector's column slides the board
 * left so the machine clears the panel, and never slides it back (phase 91, plan 91-09, CHROME-07,
 * UI-SPEC 2.4), so after a right-hand machine `EMPTY_CELL`, chosen on the open floor at Fit, can sit
 * under the palette or off the window. Home (Fit) frames the board again first, with focus taken
 * off any panel control so the key reaches the board; then the shipped empty-cell deselect.
 */
async function deselectAtFit(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Home');
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
}

/** Visit all six machines and read each one's committed config off its panel. */
async function readAllConfigs(page: Page): Promise<Record<string, PanelConfigFacts>> {
  const out: Record<string, PanelConfigFacts> = {};
  for (const anchor of Object.values(AT)) {
    await selectMachineAt(page, anchor[0], anchor[1]);
    out[String(anchor)] = await readPanelConfig(page);
    await deselectAtFit(page);
  }
  return out;
}

/** Settle on the sim actually RUNNING: the tick must climb strictly across two
 *  reads. The webhook door answers 503 while the host is not Playing (Gate A), so
 *  a frozen host must fail HERE, naming the reason, not as a mystery 503. */
async function expectPlaying(page: Page, why: string): Promise<void> {
  const before = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > before, {
    message: `the sim is PLAYING ${why} (the webhook door 503s on a host that is not)`,
  }).toBe(true);
}

/** POST `ORDER_BODY` at a Source's own loopback webhook URL, the way the panel's
 *  copyable row tells a user to. No `x-delivery-id` header, so the persisted
 *  seen-set treats every delivery as unique (the same body may be posted at both
 *  boards without being deduped as a replay). */
async function postOrderAt(page: Page, sourceHandle: number): Promise<void> {
  const url = await webhookUrl(page, sourceHandle);
  expect(url, 'the Source resolves to a loopback /hook/src-<id> POST URL').toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/,
  );
  const resp = await page.request.post(url as string, {
    data: ORDER_BODY,
    headers: { 'content-type': 'application/json' },
  });
  expect(resp.status(), 'the webhook front door accepts the real order POST').toBeLessThan(500);
}

// ===========================================================================
// SC1 - a real order through the SHIPPED scene
// ===========================================================================

test.describe('EX-02 SC1 live: a real order POSTed at the shipped example splits, flows both corridors, and fires one real HTTP action', () => {
  test('the shipped order scene turns one webhook POST into flow on both branches and exactly one captured /fulfillment POST', async ({
    page,
  }) => {
    test.skip(bindFailure !== null, bindFailure ?? '');

    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // (1) The scene, loaded the way a user loads it: the Examples popover.
    // `loadExample` clicks the entry by its title, so this is also the read of the
    // title a user sees: "(webhook in, HTTP out)", no email.
    await loadExample(page, 'order_processing');
    // Plan 91-10 (CHROME-15, UI-SPEC 5.4): the badge is read where it now lives, in the status strip.
    await expect(
      page.locator('header [data-fab-status-strip] [data-fab-scene-badge]'),
      'the scene badge in the status strip names the loaded example',
    ).toHaveText('Order processing');

    // (2) Resolve the topology this spec drives, off the live packet.
    const scene = await readScene(page);
    expect(scene.nodes, 'the shipped order scene carries its six machines').toHaveLength(6);
    expect(scene.belts, 'the shipped order scene carries its five belts').toHaveLength(5);
    const source = nodeAtAnchor(scene, AT.source[0], AT.source[1]);
    const splitter = nodeAtAnchor(scene, AT.splitter[0], AT.splitter[1]);
    const invoiceSink = nodeAtAnchor(scene, AT.invoiceSink[0], AT.invoiceSink[1]);
    expect(source?.kind, 'the front door is a webhook SOURCE, not an Endpoint').toBe(KIND_SOURCE);
    expect(splitter?.kind, 'the validate/split machine is a Factory').toBe(KIND_FACTORY);
    expect(invoiceSink?.kind, 'the invoice corridor ends in a Sink').toBe(KIND_SINK);

    // The two BRANCH corridors, resolved as "the belts docked to the splitter's
    // two Out ports" rather than by raw handle - the split is a property of the
    // docks, so that is what identifies them.
    const branchBelts = scene.belts.filter((b) =>
      b.docks.some((d) => d.end === 'Tail' && d.node === splitter?.id),
    );
    expect(
      branchBelts.map((b) => b.id).sort(),
      'the splitter feeds exactly two branch corridors',
    ).toHaveLength(2);
    // The invoice corridor's LAST belt: the one whose Head delivers into the Debug
    // sink. Its drain is how "the item reached the sink" is observed.
    const invoiceFeed = scene.belts.find((b) =>
      b.docks.some((d) => d.end === 'Head' && d.node === invoiceSink?.id),
    );
    expect(invoiceFeed, 'a belt delivers into the invoice Debug sink').toBeDefined();

    // (3) The door is only open on a running host.
    await expectPlaying(page, 'before the order POST');

    // (4) Latch belt flow BEFORE driving anything: an item crosses a corridor in a
    // few hundred ms, which a Playwright-side poll can legitimately step over.
    await startBeltFlowWatch(page);
    const capturedBefore = captured.length;

    // (5) THE REAL POST - the same body the Rust tracer uses, at the Source's own
    // webhook URL, through the real loopback ingress. Nothing is injected.
    await postOrderAt(page, (source as SceneFacts['nodes'][number]).id);

    // (6) THE SPLIT, observed on the canvas model: BOTH branch corridors carried
    // an item from the one order.
    await expect
      .poll(
        async () => {
          const flow = await readBeltFlowWatch(page);
          return branchBelts.every((b) => flow.carried.includes(b.id));
        },
        {
          timeout: 30_000,
          intervals: [200, 250, 500],
          message:
            'one order split down BOTH branch corridors (each of the splitter\'s two Out belts carried an item)',
        },
      )
      .toBe(true);

    // (7) THE INVOICE HALF, read off the board: the invoice item traversed the
    // sink-adjacent belt and DRAINED - and a belt's head empties only by delivery
    // into its docked In port (a refused delivery backs up and never clears), so
    // the item was TAKEN by the Debug sink.
    await expect
      .poll(
        async () => {
          const flow = await readBeltFlowWatch(page);
          const id = (invoiceFeed as SceneFacts['belts'][number]).id;
          return flow.carried.includes(id) && flow.drained.includes(id);
        },
        {
          timeout: 30_000,
          intervals: [200, 250, 500],
          message:
            'the invoice item reached the Debug sink: its feed belt carried an item and then drained into the sink',
        },
      )
      .toBe(true);
    await stopBeltFlowWatch(page);

    // (8) THE REAL OUTBOUND ACTION, observed OFF the board: exactly one POST
    // arrived at the listener bound on the scene's own sink URL.
    await expect
      .poll(() => captured.length, {
        timeout: 30_000,
        intervals: [100, 250, 500],
        message: `the HTTP sink dispatched a real POST to the shipped ${HTTP_URL}`,
      })
      .toBe(capturedBefore + 1);
    const post = captured[capturedBefore];
    expect(post.method, 'the sink POSTs').toBe('POST');
    expect(post.path, 'the sink POSTs the authored path').toBe(HTTP_PATH);
    expect(post.body, 'the fulfillment body carries the order id').toContain('ord-1');
    expect(
      post.body,
      'the fulfillment body is the prepare-fulfillment handler\'s emission',
    ).toContain('ship');
    expect(post.idempotencyKey, 'the dispatch carried its Idempotency-Key').not.toBe('');
    // Settle briefly and re-check: a duplicate dispatch would land right after.
    await expect
      .poll(() => captured.length, {
        timeout: 3_000,
        intervals: [500],
        message: 'exactly ONE outbound action per order (no duplicate dispatch follows)',
      })
      .toBe(capturedBefore + 1);
    shippedPost = post;

    // (9) THE INVOICE WAS DELIVERED, NOT FAULTED, on the board. By now the order has
    // crossed both corridors and the HTTP dispatch has landed, so the invoice sink's
    // own dispatch has long resolved: a Debug sink succeeds, so the sink settles
    // IDLE. A failed dispatch would hold it FAULTED (the state the Email sink read
    // on this host).
    const invoiceSinkId = (invoiceSink as SceneFacts['nodes'][number]).id;
    await pollScene(page, (s) => s.nodes.find((n) => n.id === invoiceSinkId)?.state, {
      message: `the invoice Debug sink settles IDLE (${STATE_IDLE}) after its delivery, never FAULTED (${STATE_FAULTED})`,
    }).toBe(STATE_IDLE);

    await expectRenderLoopAlive(page, 'after the shipped order example loaded and ran one order');
    errs.assertNone('the shipped order example loading and running one order');
  });

  test('the shipped example reads correctly in the panels: the Source offers its webhook URL and the splitter JS fits the editor without horizontal scroll', async ({
    page,
  }) => {
    test.skip(bindFailure !== null, bindFailure ?? '');

    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await loadExample(page, 'order_processing');

    // (1) The Source panel offers the copyable webhook URL row (CFG-03) - the row
    // that tells a user where to POST the order this example is built around.
    await selectMachineAt(page, AT.source[0], AT.source[1]);
    const urlValue = page.locator('span.fab-field', { hasText: 'http://127.0.0.1:' });
    await expect(urlValue, 'the Source panel shows its bound loopback webhook URL').toBeVisible({
      timeout: 10_000,
    });
    await expect(urlValue).toContainText(/^http:\/\/127\.0\.0\.1:\d+\/hook\/src-/);
    await deselectAtFit(page);

    // (2) The splitter's inline handler renders in the editor, byte-verbatim.
    await selectMachineAt(page, AT.splitter[0], AT.splitter[1]);
    await expect(page.locator('.cm-content'), 'the Factory editor mounted').toBeVisible({
      timeout: 10_000,
    });

    // (3) THE UI-SPEC LONG-TEXT MEASUREMENT (the one `unresolved` row of the
    // 55-UI-SPEC considerations table). The config panel is `min(420px, 33vw)`, so
    // its narrowest SUPPORTED width is 33vw at the app's 1024px floor (the width
    // the toolbar overflow contract is measured at). Shrink to that floor and
    // measure the editor's own scroll surface: `scrollWidth <= clientWidth` means
    // no horizontal scrollbar - the inline JS wraps instead of running off. The
    // subjective half ("does it read well") stays with the real-binary walk.
    await page.setViewportSize({ width: 1024, height: 768 });
    const metrics = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller') as HTMLElement | null;
      if (!scroller) return null;
      const panel = scroller.closest('.fab-panel') as HTMLElement | null;
      return {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        panelWidth: panel ? panel.getBoundingClientRect().width : -1,
      };
    });
    expect(metrics, 'the editor scroll surface is measurable').not.toBeNull();
    const m = metrics as { scrollWidth: number; clientWidth: number; panelWidth: number };
    expect(m.panelWidth, 'the panel really is at its narrowest supported width').toBeLessThan(420);
    expect(
      m.scrollWidth,
      `the inline factory JS fits the editor with NO horizontal scroll at the panel's minimum width (scrollWidth ${m.scrollWidth} vs clientWidth ${m.clientWidth}, panel ${m.panelWidth}px)`,
    ).toBeLessThanOrEqual(m.clientWidth);
    await page.setViewportSize({ width: 1280, height: 720 });

    await expectRenderLoopAlive(page, 'after the order example panels were read at both widths');
    errs.assertNone('reading the order example panels at both widths');
  });
});

// ===========================================================================
// SC3 - the UI-only rebuild from an EMPTY board, and the equivalence oracles
// ===========================================================================

test.describe('EX-02 SC3 live: the example is rebuildable from an empty board with UI gestures alone, and the rebuild is equivalent', () => {
  test('rebuild the whole example by hand and prove it equivalent statically (topology + config) and dynamically (same order in, same bytes out)', async ({
    page,
  }) => {
    test.skip(bindFailure !== null, bindFailure ?? '');
    test.skip(
      shippedPost === null,
      'the SC1 capture is the dynamic oracle\'s reference - SC1 must pass first',
    );

    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // ── (0) The equivalence TARGET: the shipped scene, read once. ────────────
    await loadExample(page, 'order_processing');
    const shippedScene = await readScene(page);
    const shippedConfigs = await readAllConfigs(page);
    // The authored constants table above is the RON's own truth, so the shipped
    // board must already read back as it - if this fails, the table drifted from
    // the scene and every compare below would be measuring the wrong thing.
    expect(
      shippedConfigs,
      'the shipped scene reads back as the authored constants (the table matches the RON)',
    ).toEqual(EXPECTED_CONFIG);

    // ── (1) EMPTY BOARD ─────────────────────────────────────────────────────
    await newBoard(page);

    // ── (2) PLACEMENTS: palette click to arm, canvas click to drop ──────────
    await armAndPlaceAt(page, 'Source', AT.source[0], AT.source[1]);
    await armAndPlaceAt(page, 'Factory', AT.splitter[0], AT.splitter[1]);
    await armAndPlaceAt(page, 'Factory', AT.invoice[0], AT.invoice[1]);
    await armAndPlaceAt(page, 'Factory', AT.fulfilment[0], AT.fulfilment[1]);
    await armAndPlaceAt(page, 'Sink', AT.invoiceSink[0], AT.invoiceSink[1]);
    await armAndPlaceAt(page, 'Sink', AT.httpSink[0], AT.httpSink[1]);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the real host echoed all six placements',
    }).toBe(6);
    for (const [anchor, kind] of [
      [AT.source, KIND_SOURCE],
      [AT.splitter, KIND_FACTORY],
      [AT.invoice, KIND_FACTORY],
      [AT.fulfilment, KIND_FACTORY],
      [AT.invoiceSink, KIND_SINK],
      [AT.httpSink, KIND_SINK],
    ] as const) {
      const node = nodeAtAnchor(await readScene(page), anchor[0], anchor[1]);
      expect(node?.kind, `a kind-${kind} machine seated at anchor (${anchor})`).toBe(kind);
    }

    // ── (3) THE SPLITTER'S SECOND OUTPUT via the panel's Ports section ──────
    // This is the scene's one `AddPort`, and the panel is its only UI route. The
    // fold re-seats the WHOLE port list (since 74.1-14 it keeps every catalog port and
    // seats the new Out below the first), which is why it must happen BEFORE the belts
    // are drawn: the authored belt end cells are the POST-reseat port cells.
    await selectMachineAt(page, AT.splitter[0], AT.splitter[1]);
    await addOutputViaPanel(page, 2);
    await deselectAtFit(page);
    {
      const splitter = nodeAtAnchor(await readScene(page), AT.splitter[0], AT.splitter[1]);
      const outs = (splitter?.ports ?? [])
        .filter((p) => p.role === 1)
        .map((p) => `${p.cell_x},${p.cell_y}`);
      expect(outs, 'the re-seated splitter offers both Out nubs at the authored cells').toEqual([
        '7,6',
        '7,7',
      ]);
    }

    // ── (4) BELTS: nub to nub, through every authored cell ──────────────────
    // Each draw is verified IMMEDIATELY against the authored run and both docks,
    // so a missed nub fails at the draw that missed it rather than as a mystery in
    // the final compare.
    for (const run of BELT_RUNS) {
      const scene = await readScene(page);
      const fromNode = nodeAtAnchor(scene, run.from[0], run.from[1]);
      const toNode = nodeAtAnchor(scene, run.to[0], run.to[1]);
      expect(fromNode, `the belt source machine at (${run.from}) is on the board`).toBeDefined();
      expect(toNode, `the belt target machine at (${run.to}) is on the board`).toBeDefined();
      const fromPort = portAtCell(
        fromNode as SceneFacts['nodes'][number],
        run.fromPortCell[0],
        run.fromPortCell[1],
        1,
      );
      const toPort = portAtCell(
        toNode as SceneFacts['nodes'][number],
        run.toPortCell[0],
        run.toPortCell[1],
        0,
      );
      // The authored run's ends ARE the two ports' facing cells - which is what
      // makes a nub-to-nub drag able to reproduce it exactly (the press seeds the
      // first cell; the release appends nothing because it is already the last).
      const [fdx, fdy] = unitDelta(fromPort.side);
      const [tdx, tdy] = unitDelta(toPort.side);
      expect(
        [fromPort.cell_x + fdx, fromPort.cell_y + fdy],
        `${run.name}: the run starts at the Out port's facing cell`,
      ).toEqual([...run.cells[0]]);
      expect(
        [toPort.cell_x + tdx, toPort.cell_y + tdy],
        `${run.name}: the run ends at the In port's facing cell`,
      ).toEqual([...run.cells[run.cells.length - 1]]);

      await drawBeltThroughCells(page, fromPort, run.cells, toPort);

      const wanted = run.cells.map(([x, y]) => `${x},${y}`).join(' -> ');
      await pollScene(
        page,
        (s) => {
          const belt = s.belts.find(
            (b) => b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' -> ') === wanted,
          );
          if (!belt) return `no belt routed [${wanted}]`;
          const links = belt.docks
            .map((d) => `${d.end}@${d.node === fromNode?.id ? 'source' : d.node === toNode?.id ? 'target' : 'other'}`)
            .sort()
            .join('+');
          return links;
        },
        {
          timeout: 20_000,
          message: `${run.name}: the drag routed the authored cells AND seeded both docks (Tail on the Out nub, Head on the In nub)`,
        },
      ).toBe('Head@target+Tail@source');
    }
    await pollScene(page, (s) => s.belts.length, {
      message: 'all five authored belts exist on the rebuilt board',
    }).toBe(5);

    // ── (5) CONFIGURES: panel bodies only, each committed with Apply ────────
    await selectMachineAt(page, AT.source[0], AT.source[1]);
    await pressSegment(page, 'Trigger', 'Webhook');
    await applyConfig(page);
    await deselectAtFit(page);

    for (const [anchor, source] of [
      [AT.splitter, JS_SPLITTER],
      [AT.invoice, JS_INVOICE],
      [AT.fulfilment, JS_FULFILMENT],
    ] as const) {
      await selectMachineAt(page, anchor[0], anchor[1]);
      await typeFactorySource(page, source);
      await applyConfig(page);
      await deselectAtFit(page);
    }

    // The invoice sink: press Debug, the shipped target. A freshly placed Sink is
    // already Debug, so the press leaves the buffer clean and the panel offers no
    // Apply (it is disabled until something differs from the committed config);
    // Apply only when the panel offers it. Either way the board holds the shipped
    // config, which the config half of the static oracle below reads back.
    await selectMachineAt(page, AT.invoiceSink[0], AT.invoiceSink[1]);
    // CHROME-04 (plan 85-05, D-08): the Sink panel offers exactly two targets,
    // Debug and HTTP, in that order. The Email segment left with the Email target,
    // because the shipped app could never send mail.
    await expect(
      page.locator('[role="group"][aria-label="Target"]').getByRole('button'),
      'the Sink panel offers exactly the targets Debug and HTTP',
    ).toHaveText(['Debug', 'HTTP']);
    await pressSegment(page, 'Target', 'Debug');
    {
      const apply = page.getByRole('button', { name: 'Apply' });
      if ((await apply.count()) > 0 && (await apply.isEnabled())) await applyConfig(page);
    }
    await deselectAtFit(page);

    await selectMachineAt(page, AT.httpSink[0], AT.httpSink[1]);
    await pressSegment(page, 'Target', 'HTTP');
    await fillPanelField(page, 'fab-sink-http-url', HTTP_URL);
    await pressSegment(page, 'Method', HTTP_METHOD);
    await applyConfig(page);
    await deselectAtFit(page);

    // The rebuilt board's last Apply has landed: a renderer that died anywhere in
    // the rebuild is caught here, where it died, not after the comparisons.
    await expectRenderLoopAlive(page, 'after the hand rebuild\'s last Apply');

    // ── (6) ORACLE LAYER 1 (STATIC): the two boards ARE the same factory ────
    const rebuiltScene = await readScene(page);
    const rebuilt = normaliseTopology(rebuiltScene);
    const shipped = normaliseTopology(shippedScene);
    // Non-vacuity first: an empty reduction would make the compare below pass on
    // two blank boards.
    expect(rebuilt.nodes, 'the rebuilt board reduces to six machines').toHaveLength(6);
    expect(rebuilt.belts, 'the rebuilt board reduces to five belts').toHaveLength(5);
    expect(
      rebuilt.belts.flatMap((b) => b.docks),
      'the rebuilt board carries all ten dock links',
    ).toHaveLength(10);
    expect(
      rebuilt,
      'the hand-built board is topologically IDENTICAL to the shipped scene (kinds, footprints, port seats, belt runs, dock links)',
    ).toEqual(shipped);

    // ...and LAYER 1's config half, read back through the panels (i.e. through the
    // machine_config bridge the panels pre-fill from).
    const rebuiltConfigs = await readAllConfigs(page);
    expect(
      rebuiltConfigs,
      'every hand-authored config round-tripped to the authored values (factory JS byte-equal, sink targets equal, Source on Webhook)',
    ).toEqual(EXPECTED_CONFIG);
    expect(
      rebuiltConfigs,
      'the rebuilt configs equal the shipped scene\'s own configs',
    ).toEqual(shippedConfigs);

    // ── (7) ORACLE LAYER 2 (DYNAMIC): same webhook in, same bytes out ───────
    await expectPlaying(page, 'before the rebuilt board\'s order POST');
    const source = nodeAtAnchor(rebuiltScene, AT.source[0], AT.source[1]);
    const capturedBefore = captured.length;
    await postOrderAt(page, (source as SceneFacts['nodes'][number]).id);
    await expect
      .poll(() => captured.length, {
        timeout: 30_000,
        intervals: [100, 250, 500],
        message: 'the HAND-BUILT board fired its own real POST at the same sink URL',
      })
      .toBe(capturedBefore + 1);
    const rebuiltPost = captured[capturedBefore];
    expect(rebuiltPost.path, 'the rebuilt board POSTs the same path').toBe(HTTP_PATH);
    // The BODY is the equivalence claim. The Idempotency-Key deliberately is NOT
    // compared: it is the deterministic CommandId of a different board's different
    // command, so equal keys would be the surprising outcome, not equal bytes.
    expect(
      rebuiltPost.body,
      'the same order POSTed at the hand-built board produced the SAME outbound bytes as the shipped scene',
    ).toBe((shippedPost as CapturedPost).body);
    expect(rebuiltPost.idempotencyKey, 'the rebuilt dispatch carried its own key').not.toBe('');

    await expectRenderLoopAlive(page, 'after the hand-built board fired its order');
    errs.assertNone('the hand rebuild of the order example and its order');
  });
});

// ===========================================================================
// Shared-host restore (WR-10)
// ===========================================================================
//
// The live project runs workers:1 against ONE mutable host, and the suite's
// discipline (oracle.ts) is that a mutating spec either RESETS at its start or
// RESTORES at its end. This file does neither on the way out: SC1 swaps the
// shipped order scene in, SC3 wipes to an empty board and rebuilds six machines
// by hand, and then the file ends. Today that is survivable only because `17-`
// sorts last; the moment an `18-*` spec lands, or someone runs with --grep /
// --shard and changes the effective order, the next spec inherits a hand-built
// 6-machine board and fails for a reason with no connection to its own subject.
//
// This lives in afterAll rather than at the tail of the last test so it ALSO
// fires when SC3 is skipped by its bind/capture guards or when a test fails
// mid-rebuild, which are exactly the runs that leave the worst board behind.
// afterAll has no `page` fixture, so it drives its own page at the project's
// own baseURL; a fresh page is never dirty, so the A3 guard cannot appear.
test.afterAll(async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (baseURL === undefined) return;
  const page = await browser.newPage({ baseURL });
  try {
    await page.goto('/');
    await waitForAppReady(page);
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
      message: 'the shared host is restored to the demo baseline after the order-example rebuild',
    }).toBe(true);
  } finally {
    await page.close();
  }
});
