import { test, expect, type Page } from './support/liveTest';
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
// Cells are the scene's authored anchors (examples/boards/advanced.board.ron), resolved to live
// handles off the packet; nothing here hardcodes a handle.

const KIND_SOURCE = 0;
const KIND_SINK = 7;

/** Authored anchors in examples/boards/advanced.board.ron. */
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

test.describe('plan 85-10 live: the Advanced board has no kinked belt', () => {
});
