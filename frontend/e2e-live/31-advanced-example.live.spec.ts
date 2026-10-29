import { test, expect, type Page } from '@playwright/test';
import {
  expectRenderLoopAlive,
  loadExample,
  nodeAtAnchor,
  pollScene,
  readBeltFlowWatch,
  readScene,
  startBeltFlowWatch,
  stopBeltFlowWatch,
  waitForAppReady,
  watchPageErrors,
  webhookUrl,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 31-advanced-example.live.spec.ts (quick 260916-adv, added by quick 260929-p7p).
//
// The Advanced example's headline feature is its dead-letter queue: a live order the
// validate Factory rejects faults out of its Fault port and rides a belt to a
// dedicated Sink. Before this spec no live test loaded the scene at all, and the
// scene as first shipped laundered an id-less body into a fabricated "auto" order
// instead of dead-lettering it (review CR-01). This spec drives the real
// dev_render_server + real Core:
//
//   1. load 'advanced' through the Examples popover, the way a user does;
//   2. prove the renderer is alive (the live oracle reads only the MODEL, so a dead
//      Pixi renderer would otherwise pass everything);
//   3. under the Timer's own heartbeat flow, the dead-letter belt carries nothing
//      while the fulfilment line demonstrably does;
//   4. POST an id-less body (a typo'd `order_id` key) at the webhook Source's own
//      URL, and the dead-letter belt carries an item that the Sink then takes.
//
// Cells are the scene's authored anchors (scenes/advanced.ron), resolved to live
// handles off the packet; nothing here hardcodes a handle.

const KIND_SOURCE = 0;
const KIND_FACTORY = 2;
const KIND_BALANCER = 4;
const KIND_SINK = 7;

/** Authored anchors in scenes/advanced.ron. */
const AT = {
  webhookSource: [0, 8] as const,
  deadLetterSink: [8, 11] as const,
  fulfilmentSink: [29, 6] as const,
};

/** An id-less order: the exact shape the unfixed scene laundered into "auto". */
const ID_LESS_BODY = { order_id: 'x', items: [{ qty: 1 }] };

type Belt = SceneFacts['belts'][number];

function beltInto(scene: SceneFacts, nodeId: number | undefined): Belt | undefined {
  return scene.belts.find((b) => b.docks.some((d) => d.end === 'Head' && d.node === nodeId));
}

/** The webhook door answers 503 while the host is not Playing, so settle on the
 *  tick climbing before any POST. */
async function expectPlaying(page: Page, why: string): Promise<void> {
  const before = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > before, {
    message: `the sim is PLAYING ${why} (the webhook door 503s on a host that is not)`,
  }).toBe(true);
}

test.describe('quick 260916-adv live: the Advanced example dead-letters an invalid live order', () => {
  test('an id-less webhook POST rides the dead-letter belt, while the Timer flow never does', async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    // (1) Load the scene the way a user does.
    await loadExample(page, 'advanced', 12);
    await pollScene(page, (s) => s.nodes.length === 12 && s.belts.length === 12, {
      message: 'the advanced scene landed: 12 machines and 12 belts',
    }).toBe(true);
    // Plan 91-10 (CHROME-15, UI-SPEC 5.4): the badge is read where it now lives, in the status strip.
    await expect(
      page.locator('header [data-fab-status-strip] [data-fab-scene-badge]'),
      'the scene badge in the status strip names the loaded example',
    ).toHaveText('Advanced pipeline');

    // (2) The renderer is alive, not just the model.
    await expectRenderLoopAlive(page, 'after loading the advanced example');

    // Resolve the topology off the live packet.
    const scene = await readScene(page);
    const webhookSource = nodeAtAnchor(scene, AT.webhookSource[0], AT.webhookSource[1]);
    const deadLetterSink = nodeAtAnchor(scene, AT.deadLetterSink[0], AT.deadLetterSink[1]);
    const fulfilmentSink = nodeAtAnchor(scene, AT.fulfilmentSink[0], AT.fulfilmentSink[1]);
    expect(webhookSource?.kind, 'the webhook front door is a SOURCE at (0,8)').toBe(KIND_SOURCE);
    expect(deadLetterSink?.kind, 'the dead-letter terminal is a SINK at (8,11)').toBe(KIND_SINK);
    expect(fulfilmentSink?.kind, 'the fulfilment terminal is a SINK at (29,6)').toBe(KIND_SINK);
    const deadLetterBelt = beltInto(scene, deadLetterSink?.id);
    const fulfilmentBelt = beltInto(scene, fulfilmentSink?.id);
    expect(deadLetterBelt, 'a belt delivers into the dead-letter Sink').toBeDefined();
    expect(fulfilmentBelt, 'a belt delivers into the fulfilment Sink').toBeDefined();
    const deadId = (deadLetterBelt as Belt).id;
    const fulfilId = (fulfilmentBelt as Belt).id;

    await expectPlaying(page, 'after the load');

    // (3) Timer flow only: latch belt flow, wait until a heartbeat order has
    // crossed the whole fulfilment line (its last belt carried and drained), and
    // only THEN judge the dead-letter belt. The window is bounded by real flow,
    // not by a sleep.
    await startBeltFlowWatch(page);
    await expect
      .poll(
        async () => {
          const flow = await readBeltFlowWatch(page);
          return flow.carried.includes(fulfilId) && flow.drained.includes(fulfilId);
        },
        {
          timeout: 30_000,
          intervals: [200, 250, 500],
          message: 'the Timer heartbeat drove an order all the way into the fulfilment Sink',
        },
      )
      .toBe(true);
    expect(
      (await readBeltFlowWatch(page)).carried,
      'under the Timer heartbeat alone, nothing is dead-lettered',
    ).not.toContain(deadId);

    // (4) The real POST: an id-less body at the webhook Source's own URL.
    const url = await webhookUrl(page, (webhookSource as SceneFacts['nodes'][number]).id);
    expect(url, 'the webhook Source resolves to a loopback /hook/src-<id> POST URL').toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/,
    );
    const resp = await page.request.post(url as string, {
      data: ID_LESS_BODY,
      headers: { 'content-type': 'application/json' },
    });
    expect(resp.status(), 'the webhook front door accepts the POST').toBeLessThan(500);

    await expect
      .poll(
        async () => {
          const flow = await readBeltFlowWatch(page);
          return flow.carried.includes(deadId) && flow.drained.includes(deadId);
        },
        {
          timeout: 30_000,
          intervals: [200, 250, 500],
          message:
            'the id-less order faulted out of validate and rode the dead-letter belt into its Sink',
        },
      )
      .toBe(true);
    await stopBeltFlowWatch(page);

    errors.assertNone('while loading and driving the advanced example');
  });
});

// Plan 85-10 (D-25, DEMO-09): the board the user sees has no kinked belt. The PR #2 review
// found two belts (validate's invoice output and worker B's output) that jogged west before
// their final eastward run, and an invoice belt that turned right under the Balancer's unused
// second input, so at fit zoom the billing branch read as feeding the Balancer. This leg reads
// every belt off the LIVE model after a real Examples load, not the RON.

/** Unit step of a port's facing side: N=0, E=1, S=2, W=3 (y-down). */
const SIDE_DELTA: Record<number, readonly [number, number]> = {
  0: [0, -1],
  1: [1, 0],
  2: [0, 1],
  3: [-1, 0],
};

/** Every step of a belt's tiles (tail to head) that turns back along an axis it has already
 *  advanced on, as `belt <id>: (x,y) -> (x,y) on <axis>`. */
function doubledBackSteps(belt: Belt): string[] {
  const out: string[] = [];
  const dir = { x: 0, y: 0 };
  for (let i = 1; i < belt.tiles.length; i++) {
    const a = belt.tiles[i - 1];
    const b = belt.tiles[i];
    const step = { x: Math.sign(b.cell_x - a.cell_x), y: Math.sign(b.cell_y - a.cell_y) };
    for (const axis of ['x', 'y'] as const) {
      if (step[axis] === 0) continue;
      if (dir[axis] === 0) dir[axis] = step[axis];
      else if (dir[axis] !== step[axis]) {
        out.push(`belt ${belt.id}: (${a.cell_x},${a.cell_y}) -> (${b.cell_x},${b.cell_y}) on ${axis}`);
      }
    }
  }
  return out;
}

/** The first tile where a belt changes direction, or undefined for a straight belt. */
function firstTurn(belt: Belt): [number, number] | undefined {
  const t = belt.tiles;
  for (let i = 1; i + 1 < t.length; i++) {
    const inX = t[i].cell_x - t[i - 1].cell_x;
    const inY = t[i].cell_y - t[i - 1].cell_y;
    const outX = t[i + 1].cell_x - t[i].cell_x;
    const outY = t[i + 1].cell_y - t[i].cell_y;
    if (inX !== outX || inY !== outY) return [t[i].cell_x, t[i].cell_y];
  }
  return undefined;
}

test.describe('plan 85-10 live: the Advanced board has no kinked belt', () => {
  test('no belt doubles back, and the invoice belt turns clear of the Balancer second input', async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    await loadExample(page, 'advanced', 12);
    await pollScene(page, (s) => s.nodes.length === 12 && s.belts.length === 12, {
      message: 'the advanced scene landed: 12 machines and 12 belts',
    }).toBe(true);

    const scene = await readScene(page);
    expect(
      scene.belts.every((b) => b.tiles.length >= 2),
      'every advanced belt carries its drawn tiles on the live model',
    ).toBe(true);

    // (1) No belt doubles back along an axis it has already advanced on.
    const kinks = scene.belts.flatMap(doubledBackSteps);
    expect(kinks, 'no belt on the live Advanced board doubles back').toEqual([]);

    // (2) The invoice belt: the one whose Tail docks the validate Factory's second Out
    // (catalog port 3 on the only Factory that carries four ports). An Out dock rides the
    // wire in the EMIT keyspace (its 0-based position among the node's Out ports, as spec 01
    // converts it), so the catalog index is converted through validate's own ports.
    const validate = scene.nodes.find((n) => n.kind === KIND_FACTORY && n.ports.length === 4);
    expect(validate, 'the validate Factory (grown to four ports) is on the board').toBeDefined();
    const out1 = validate?.ports.find((p) => p.index === 3 && p.role === 1);
    expect(out1, 'validate carries its second Out at catalog port 3').toBeDefined();
    const out1Emit = (validate?.ports ?? []).filter((p) => p.role === 1 && p.index < 3).length;
    const invoiceBelt = scene.belts.find((b) =>
      b.docks.some((d) => d.end === 'Tail' && d.node === validate?.id && d.port === out1Emit),
    );
    expect(invoiceBelt, 'a belt leaves the validate Factory second Out').toBeDefined();

    // The Balancer's second input and the cell it faces (its mouth), read off the live ports.
    const balancer = scene.nodes.find((n) => n.kind === KIND_BALANCER);
    const in1 = balancer?.ports.find((p) => p.index === 1 && p.role === 0);
    expect(in1, 'the Balancer carries its second input (catalog port 1)').toBeDefined();
    const [dx, dy] = SIDE_DELTA[(in1 as PortFacts).side];
    const mouth: [number, number] = [(in1 as PortFacts).cell_x + dx, (in1 as PortFacts).cell_y + dy];

    const turn = firstTurn(invoiceBelt as Belt);
    expect(turn, 'the invoice belt turns toward the invoice Factory').toBeDefined();
    expect(turn, 'the invoice belt does not turn in the Balancer second-input mouth').not.toEqual(mouth);
    expect(
      (turn as [number, number])[0],
      `the invoice belt turns at (${turn?.join(',')}), a clear column west of the Balancer ` +
        `second-input mouth (${mouth.join(',')})`,
    ).toBeLessThanOrEqual(mouth[0] - 2);

    await expectRenderLoopAlive(page, 'at the end of the no-kink leg');
    errors.assertNone('while loading the advanced example and reading its belts');
  });
});
