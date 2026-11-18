import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL } from '../shared/geometry';
import { SLOTS_PER_TILE, visibleDotsPerTile, type TileInImage } from './support/canvasDots';
import {
  DEMO_NODE_COUNT,
  DRAWN_STATE_FRAMES,
  anchorOf,
  cameraOf,
  captureClip,
  deselectViaEmptyCell,
  ensurePlaying,
  expectRenderLoopAlive,
  itemDotsPerCell,
  loadDemoViaExamples,
  loadExample,
  pollScene,
  readScene,
  restoreHostAfterFailedTest,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  webhookUrl,
  type BeltTileFacts,
  type SceneFacts,
} from './support/oracle';
import { README_PATH, curlArgs, readFirstWebhookCurl } from './support/pageCurl';

// 101-readme-quickstart.live.spec.ts - the repository README's Quickstart (`README.md`) on the
// REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS), with the real curl
// binary. Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// WHAT IT PROVES
// ---------------------------------------------------------------------------
//
// The README tells a reader to load Order processing from Examples, click the Source, copy its
// Webhook URL from the inspector, put the port and id into the README's curl command and run it,
// and says the order shows up on the first belt as an amber dot. This spec does those steps: the
// README's own command, sent to the real host, puts an order on the first belt that the reader can
// see. The curl block is read from README.md at run time with `support/pageCurl.ts` and run as an
// argument array through `execFileSync`; the README text never reaches a shell. The delivery id is
// the README's own (`readme-1`): the host keeps its list of delivery ids per open project, and
// loading an example opens a new one, so the id is fresh on every run.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE READER SEES
// ---------------------------------------------------------------------------
//
//   1. `watchPageErrors`, `goto`, `waitForAppReady`, Order processing loaded from Examples. The
//      README says the board starts playing; the spec records in an annotation (`plays on load`)
//      whether the tick rose with no Play press, and presses Play only if it did not.
//   2. The Source (the one kind 0 machine) clicked, the inspector shows the label Webhook URL and
//      the host's own URL for it; the port and id come from that text, as the reader copies them.
//   3. The first belt (the one whose tail docks to the Source) read on the canvas before the
//      curl: no dot drawn on it. This is the control for leg 5's pixel read, so a warm pixel
//      from something else on those cells can't pass it.
//   4. curl posts the README's body with the README's delivery id to the README's URL with that
//      port and id filled in, and prints a 2xx status. The model then lists the order on the first
//      belt (the model leg).
//   5. On the held board, the item layer placed a dot in one of the belt's cells, and the canvas
//      shows it: dot ink on the belt's cells in a screenshot (the drawn leg). The placed-dot read
//      alone can't see a hidden item layer (`support/canvasDots.ts`), so the pixels are read too.
//   6. Play again, the tick rises, `expectRenderLoopAlive`, and the watcher's `assertNone`.
//
// WHY THE BOARD IS HELD FOR THE DRAWN LEG. The order spends about 22 ticks on the first belt, and
// a screenshot on a slow runner can land after it has gone into the validate Factory. A board held
// with Step gives a frame that stays put. A held board answers a webhook with 503, so the order is
// sent while the board plays, and an in-page watcher presses Step on the first frame the model has
// the order on the belt (the `100-reproduce-a-bug` method). The spec then steps one tick at a time
// until the order sits at least two slots from either end of the belt, clear of the port nubs that
// cover the end slots, and reads the drawing there. Each read of the held board waits for two
// reads 250 ms apart to agree, because a Step pressed while the board plays can land one tick
// after the press (the first run of this spec saw the tick move from 97 to 98 after the hold).
//
// ---------------------------------------------------------------------------
// THE DEMO IS LOADED BACK AFTER
// ---------------------------------------------------------------------------
//
// The live project runs one worker against one host, and this file sorts right before
// `11-machine-labels`, whose first test expects the demo's section labels. With Order processing
// left loaded that spec fails (phase 100 plan 10 found the same with `100-reproduce-a-bug`). So an
// afterAll loads the demo back through Examples and waits for its tick to rise, because a demo
// load on a host left paused swaps the board and stays at its first tick. The afterEach first
// disarms the Step watcher, so a failed test can't leave it to pause the host after the restore.
//
// Render health: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after the order shows
// (the held-board form while held) and again once it plays on (fabrico-model-oracle-blindspot).

/** The Source's kind byte in the render packet. */
const SOURCE_KIND = 0;
/** A cell no machine or belt of Order processing covers (`order_processing.board.ron`), for the
 *  deselect click. */
const EMPTY_CELL: [number, number] = [2, 9];
/** The toolbar's transport: `Pause` while the sim runs, `Play` while it is paused. */
const TRANSPORT = /^(Play|Pause)$/;
/** How many times slower than full speed the host may tick and still be graded (the 87 specs' 3). */
const SLOW_BOARD = 3;
/** Ticks within which a board that plays as it loads shows its tick rising, with room. */
const PLAY_TICKS = 30;
/** Ticks from the webhook to the order on the first belt, with room: natively the Source works on
 *  the tick after the webhook. */
const ARRIVE_TICKS = 30;
/** Slots an order must sit from either end of the belt to be clear of the port nubs. */
const NUB_CLEAR_SLOTS = 2;
/** The host's drain budget for a Pause (`sim_loop.rs` `MAX_SETTLE_TICKS`, 512). */
const SETTLE_TICKS = 512;
/** How long two reads of a held board must agree to count as held. */
const HELD_MS = 250;
/** The wall-clock part of the held read's cap: a few HELD_MS rounds. */
const HELD_POLL_MS = 1_000;
/** The viewport every capture reads. */
const VIEWPORT = { width: 1280, height: 800 };

type BeltFacts = SceneFacts['belts'][number];

/** The in-page Step watcher, as the page holds it on `window`. */
type ReadmeHold = { at: number | null; stop: boolean };

function transportOf(page: Page) {
  return page.getByRole('button', { name: TRANSPORT });
}

function stepOf(page: Page) {
  return page.getByRole('button', { name: 'Step', exact: true });
}

/**
 * Read the board once two reads HELD_MS apart agree on the tick and every belt's slots (the 100
 * spec's method). A Step pressed while the board plays can land a tick after the press, so a
 * single read right after it can see a board that is still about to move.
 */
async function heldScene(page: Page, what: string): Promise<SceneFacts> {
  const recordOf = (s: SceneFacts): string => [s.tick, ...s.belts.map((b) => `${b.id}:${JSON.stringify(b.occupiedSlots)}`).sort()].join(' ');
  let last = '';
  let held: SceneFacts | null = null;
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(HELD_MS);
        const scene = await readScene(page);
        const record = recordOf(scene);
        const same = record === last;
        last = record;
        if (same) held = scene;
        return same;
      },
      {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS) + frameBudgetMs(0, HELD_POLL_MS), `${what}: the board holds still`),
        intervals: [0],
        message: `${what}: two reads ${HELD_MS} ms apart agree on the board`,
      },
    )
    .toBe(true);
  return held!;
}

/** The item dots the item layer placed on `tiles`, as a sorted `x,y:n` list. */
async function placedDotsOn(page: Page, tiles: readonly BeltTileFacts[]): Promise<string[]> {
  const dots = await itemDotsPerCell(page);
  return tiles
    .map((t) => `${t.cell_x},${t.cell_y}`)
    .filter((k) => (dots[k] ?? 0) > 0)
    .map((k) => `${k}:${dots[k]}`)
    .sort();
}

/** Throws by name unless every corner of the CSS px box is the canvas, so chrome over the board is
 *  never read as an empty belt (the 77 spec's rule). */
async function expectAllCanvas(page: Page, box: { x0: number; y0: number; x1: number; y1: number }): Promise<void> {
  const corners = [
    { x: box.x0, y: box.y0 },
    { x: box.x1 - 1, y: box.y0 },
    { x: box.x0, y: box.y1 - 1 },
    { x: box.x1 - 1, y: box.y1 - 1 },
  ];
  const tags = await page.evaluate((ps) => ps.map((pt) => document.elementFromPoint(pt.x, pt.y)?.tagName ?? null), corners);
  if (tags.some((tag) => tag !== 'CANVAS')) {
    throw new Error(`the belt's box (${box.x0},${box.y0})-(${box.x1},${box.y1}) is not all canvas: corners read ${tags.join(',')}`);
  }
}

/**
 * The item dots VISIBLE on the belt's tiles in a screenshot of them: the windows of each tile that
 * hold dot ink (`canvasDots.ts` `visibleDotsPerTile`), as a sorted `x,y:n` list of the lit tiles.
 */
async function canvasDotsOn(page: Page, tiles: readonly BeltTileFacts[]): Promise<string[]> {
  const cam = await cameraOf(page);
  const half = (CELL * cam.scale) / 2;
  const centres = await Promise.all(tiles.map((t) => screenCellCentre(page, t.cell_x, t.cell_y)));
  const box = {
    x0: Math.round(Math.min(...centres.map((c) => c.x)) - half),
    y0: Math.round(Math.min(...centres.map((c) => c.y)) - half),
    x1: Math.round(Math.max(...centres.map((c) => c.x)) + half),
    y1: Math.round(Math.max(...centres.map((c) => c.y)) + half),
  };
  await expectAllCanvas(page, box);
  const png = PNG.sync.read(await captureClip(page, { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }));
  const dpr = png.width / (box.x1 - box.x0);
  const inImage: TileInImage[] = tiles.map((t, i) => ({
    key: `${t.cell_x},${t.cell_y}`,
    rect: {
      x0: Math.round((centres[i].x - half - box.x0) * dpr),
      y0: Math.round((centres[i].y - half - box.y0) * dpr),
      x1: Math.round((centres[i].x + half - box.x0) * dpr),
      y1: Math.round((centres[i].y + half - box.y0) * dpr),
    },
    axis: 'Straight' in t.kind && t.kind.Straight.axis === 1 ? 'y' : 'x',
  }));
  const read = visibleDotsPerTile({ width: png.width, height: png.height, data: png.data }, inImage, dpr);
  return Object.entries(read)
    .filter(([, v]) => v.dots > 0)
    .map(([k, v]) => `${k}:${v.dots}`)
    .sort();
}

// Load the demo back so the next spec finds the board the suite starts from. An afterAll rather
// than the end of the test, so it also runs when the test fails part way. afterAll has no `page`
// fixture, so it opens its own page at the project's baseURL; a fresh page has no unsaved edits,
// so Examples asks nothing before it swaps the board. The tick must rise too: a demo load on a
// host left paused swaps the board and stays at its first tick.
test.afterAll(async ({ browser }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (baseURL === undefined) return;
  const page = await browser.newPage({ baseURL });
  try {
    await page.goto('/');
    await waitForAppReady(page);
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
      message: 'the shared host is back on the demo after the README quickstart spec',
    }).toBe(true);
    const demoTick = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick, {
      message: `the shared host plays on the demo after the README quickstart spec (the tick rises past ${demoTick})`,
    }).toBeGreaterThan(demoTick);
  } finally {
    await page.close();
  }
});

test.afterEach(async ({ page }, testInfo) => {
  // Disarm the Step watcher before the restore, so an order the host takes late can't press Step
  // after the restore has resumed the host. The catch covers a closed page.
  await page
    .evaluate(() => {
      const hold = (window as unknown as { __readmeHold?: ReadmeHold }).__readmeHold;
      if (hold) hold.stop = true;
    })
    .catch(() => {});
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('101 live: the README quickstart, with the README curl on the real host', () => {
  test("the README's curl, with the inspector's port and Source id, puts an order on Order processing's first belt, in the model and drawn", async ({
    page,
  }, testInfo) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize(VIEWPORT);
    await page.goto('/');
    await waitForAppReady(page);

    // The README's command, read now so a broken block fails before the board is touched.
    const readme = readFirstWebhookCurl(README_PATH);

    // 1. Order processing from Examples, and whether it plays with no Play press.
    await loadExample(page, 'order_processing');
    await expect(page.locator('header [data-fab-status-strip] [data-fab-scene-badge]'), 'the status strip names the example').toHaveText(
      'Order processing',
    );
    const loadedTick = (await readScene(page)).tick;
    const playsOnLoad = await pollScene(page, (s) => s.tick > loadedTick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * PLAY_TICKS), 'the example plays as it loads'),
      message: `the example plays as it loads (the tick rises past ${loadedTick} with no Play press)`,
    })
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    testInfo.annotations.push({
      type: 'plays on load',
      description: playsOnLoad
        ? 'yes: after the Examples load the tick rose with no Play press'
        : 'no: the tick did not rise after the Examples load, so the spec pressed Play',
    });
    console.log(`README plays on load: ${playsOnLoad ? 'yes' : 'no'}`);
    if (!playsOnLoad) await ensurePlaying(page);
    await expect(transportOf(page), 'the example plays, so the transport offers Pause').toHaveAttribute('aria-label', 'Pause');

    // 2. Click the Source and read its Webhook URL from the inspector.
    const scene = await readScene(page);
    const sources = scene.nodes.filter((n) => n.kind === SOURCE_KIND);
    expect(
      sources.map((n) => n.id),
      'Order processing has one Source',
    ).toHaveLength(1);
    const [ax, ay] = anchorOf(sources[0]);
    const source = await selectMachineAt(page, ax, ay);
    const hostUrl = await webhookUrl(page, source.id);
    await expect(page.getByText('Webhook URL', { exact: true }), 'the inspector shows the Webhook URL row').toBeVisible();
    const urlField = page.locator('span.fab-field', { hasText: 'http://127.0.0.1:' });
    await expect(urlField, "the inspector's Webhook URL is the host's own URL for this Source").toHaveText(hostUrl ?? '(no URL from the host)');
    const shown = ((await urlField.textContent()) ?? '').trim();
    const parts = /^http:\/\/127\.0\.0\.1:(\d+)\/hook\/src-(\d+)$/.exec(shown);
    expect(parts, `the inspector shows a loopback /hook/src-<id> URL (got ${shown})`).not.toBeNull();
    const url = readme.urlFor(Number(parts![1]), Number(parts![2]));
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // 3. The first belt, and the control read: nothing drawn on it before the curl.
    const firstBelt = scene.belts.find((b) => b.docks.some((d) => d.end === 'Tail' && d.node === source.id));
    expect(firstBelt, 'a belt leaves the Source').toBeDefined();
    const beltId = firstBelt!.id;
    const tiles = firstBelt!.tiles;
    const slotCount = tiles.length * SLOTS_PER_TILE;
    const beltOf = (s: SceneFacts): BeltFacts | undefined => s.belts.find((b) => b.id === beltId);
    expect(beltOf(await readScene(page))?.items, 'the first belt is empty before the curl').toBe(0);
    expect(await canvasDotsOn(page, tiles), 'the canvas shows no dot on the empty first belt before the curl').toEqual([]);
    await expectRenderLoopAlive(page, 'on the playing example, before the curl');

    // 4. Arm the Step watcher, run the README's curl, and see the order on the first belt.
    await page.evaluate((id) => {
      const w = window as unknown as {
        __fabrico: { scene(): { tick: number; belts: Array<{ id: number; items: number }> } };
        __readmeHold?: ReadmeHold;
      };
      const latch: ReadmeHold = { at: null, stop: false };
      w.__readmeHold = latch;
      const watch = (): void => {
        if (latch.stop) return;
        const s = w.__fabrico.scene();
        if ((s.belts.find((b) => b.id === id)?.items ?? 0) > 0) {
          latch.at = s.tick;
          latch.stop = true;
          (document.querySelector('button[aria-label="Step"]') as HTMLButtonElement).click();
          return;
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    }, beltId);
    const status = execFileSync('curl', curlArgs(url, readme.deliveryId, readme.body), {
      encoding: 'utf8',
      timeout: tickBudgetMs(SLOW_BOARD * ARRIVE_TICKS),
    }).trim();
    console.log(`README curl status=${status} delivery=${readme.deliveryId} url=${url}`);
    expect(status, `curl prints a 2xx status: the app took the README's order (got ${status})`).toMatch(/^2\d\d$/);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __readmeHold: ReadmeHold }).__readmeHold.at), {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ARRIVE_TICKS) + frameBudgetMs(2), 'the order leaves the Source onto the first belt'),
        intervals: [20, 50, 100],
        message: 'the model lists the order on the first belt, and the watcher pressed Step',
      })
      .not.toBeNull();
    await expect(transportOf(page), 'Step holds the board, so the transport offers Play').toHaveAttribute('aria-label', 'Play');

    // Step one tick at a time until the order sits clear of both end slots' port nubs.
    const pace = beltOf(await readScene(page))?.ticksPerSlot ?? 1;
    const stepBound = pace * (NUB_CLEAR_SLOTS + 1) + 2;
    let held: SceneFacts | null = null;
    for (let i = 0; i <= stepBound; i++) {
      const s = await heldScene(page, i === 0 ? 'held by the watcher' : `after step ${i}`);
      const slots = beltOf(s)?.occupiedSlots ?? [];
      expect(slots.length, `the order is still on the first belt at tick ${s.tick} (slots ${JSON.stringify(slots)})`).toBe(1);
      if (slots[0] >= NUB_CLEAR_SLOTS && slots[0] <= slotCount - 1 - NUB_CLEAR_SLOTS) {
        held = s;
        break;
      }
      await stepOf(page).click();
      await pollScene(page, (x) => x.tick > s.tick, { message: `one Step advanced the held board past tick ${s.tick}` }).toBe(true);
    }
    expect(held, `the order reached a slot clear of the port nubs within ${stepBound} steps`).not.toBeNull();
    const heldBelt = beltOf(held!)!;
    console.log(`README held tick=${held!.tick} slots=${JSON.stringify(heldBelt.occupiedSlots)} of ${slotCount} scale=${(await cameraOf(page)).scale}`);
    expect(heldBelt.items, `the model leg: the order is on the first belt at tick ${held!.tick}`).toBe(1);

    // 5. The drawn leg: the item layer placed a dot on the belt, and the canvas shows it.
    await expect
      .poll(() => placedDotsOn(page, tiles), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the held order is placed by the item layer'),
        message: 'the item layer placed one dot on the first belt',
      })
      .toHaveLength(1);
    await expect
      .poll(() => canvasDotsOn(page, tiles), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'the held order is drawn on the canvas'),
        intervals: [100, 250],
        message: 'the canvas shows a dot on the first belt',
      })
      .toHaveLength(1);
    expect((await readScene(page)).tick, 'the board stayed held across the drawn reads').toBe(held!.tick);
    await expectRenderLoopAlive(page, 'held with the order on the first belt', { boardHeld: true });

    // 6. Play, so the order rides on and the shared host runs for the next spec.
    await transportOf(page).click();
    await expect(transportOf(page), 'Play pressed, so the transport offers Pause').toHaveAttribute('aria-label', 'Pause');
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * PLAY_TICKS), 'the board plays on after the hold'),
      message: `the board plays on past tick ${held!.tick}`,
    }).toBeGreaterThan(held!.tick);
    await expectRenderLoopAlive(page, 'playing again after the order showed');

    errs.assertNone('the README quickstart: load, Webhook URL, curl and the order on the first belt');
  });
});
