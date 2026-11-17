import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { CELL } from '../shared/geometry';
import { isRedPixel } from '../shared/redPixel';
import {
  cameraOf,
  captureClip,
  expectRenderLoopAlive,
  guardWillAsk,
  itemDotsPerCell,
  loadExample,
  nodeAtAnchor,
  pollScene,
  readScene,
  restoreHostAfterFailedTest,
  screenCellCentre,
  waitForAppReady,
  waitForFile,
  watchPageErrors,
  webhookUrl,
  type SceneFacts,
} from './support/oracle';
import { curlArgs, parseFirstWebhookCurl } from './support/pageCurl';

// 100-reproduce-a-bug.live.spec.ts - the app steps on the "Reproduce a bug from a save file"
// docs page (`site/src/content/docs/patterns/reproduce-a-bug.mdx`, section "Reproduce it in the
// app") on the REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero
// mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// WHAT IT PROVES
// ---------------------------------------------------------------------------
//
// The page says that if you save the shipped Order processing example while a bad order rides its
// first belt, the validate Factory turns red at the same tick every time you load that file and
// step on. This spec loads the example from Examples, sends the bad order with the page's own curl
// command, holds the board with Step while the order is on the first belt, saves through the
// toolbar, steps one tick at a time until the validate Factory is FAULTED in the model AND drawn
// red on the held frame, and records that tick T. Then it loads the file twice through the
// toolbar's Load, and each time the board comes back as saved (order on its belt, drawn) and the
// Factory turns red at T again.
//
// The page's curl command is read from the page at run time (`parseFirstWebhookCurl` on the bug
// page) and run as an argument array through `execFileSync`; the page text never reaches a shell.
// The page describes the desktop app's native dialogs; the dev browser takes the path from
// `window.prompt`, which this spec answers.
//
// WHY THE ORDER IS SENT BEFORE STEP. A held board answers a webhook with 503 (the webhook door's
// not-Playing gate, `crates/fabrico-host/src/ingress/webhook.rs`), so the order has to arrive
// while the board plays, and Step has to stop the board in the 22 or so ticks the order spends
// between the Source and the validate Factory. A person presses Step as soon as the order leaves
// the Source, and the page says to send it again if they miss. This spec presses the same Step
// button from inside the page, on the first frame the model puts the order on the first belt, so
// a slow runner can't step over that window; Pause and a Save on a playing board would both let
// the order run into the Factory first (`sim_loop.rs`, Pause drains then freezes).
//
// WHY STEP, NOT PLAY, FINDS THE RED TICK. The validate Factory is FAULTED on exactly one tick: its
// Fault port has no belt, so the fault is dropped and the Factory reads IDLE on the next tick. The
// spec reads the model after every single Step.
//
// THE HTTP SINK MAKES NO CALL. Only the bad order is sent, and it never gets past the validate
// Factory. The spec binds the shipped Sink's target, localhost:8799, for the whole test and
// asserts it received no request. If the port can't be bound, that one check can't run, and the
// spec says so in the report rather than skipping the rest.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. `watchPageErrors`, `goto`, `waitForAppReady`, Order processing loaded from Examples (the
//      board plays as it loads).
//   2. The Source's URL from the host (`webhookUrl`), the page's curl command with a fresh delivery
//      id and the page's body, curl prints 200, and Step pressed on the first frame the order is
//      on the first belt.
//   3. The held board: two reads agree, the order is on the first belt in the model and drawn
//      there, and the validate Factory is not FAULTED. Nothing on the board is drawn red.
//   4. Save on the toolbar, a temp path into the prompt, the file on disk with stable bytes, and
//      the board still at the held tick.
//   5. Step one tick at a time until the validate Factory reads FAULTED; on that held frame the
//      board is drawn red, and only inside the validate Factory's box. That tick is T.
//   6. Load on the toolbar, the status strip reads Loaded, the board stands as saved (the order on
//      its belt, drawn), paused; Step until FAULTED and drawn red, at T.
//   7. Load once more, and the same again, at T.
//   8. Play, and the tick rises, so the shared host is left running for the next spec (a host
//      left paused by a passing test stalls the spec after it; `restoreHostAfterFailedTest`
//      covers only a test that failed).
//
// Render health: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after each leg (the
// held-board form once the board is held, since the render clock follows the sim clock), and the
// watcher's `assertNone` at the end (fabrico-model-oracle-blindspot).

/** The page whose steps this spec walks, and whose curl command it runs. */
const BUG_PAGE = fileURLToPath(new URL('../../site/src/content/docs/patterns/reproduce-a-bug.mdx', import.meta.url));
/** The toolbar's Save button title (`Toolbar.tsx`, with the shortcut label). */
const SAVE_TITLE = 'Save (Ctrl+S) - Shift for Save As';
/** The toolbar's Load button title starts with this (`Toolbar.tsx`, the shortcut follows). */
const LOAD_TITLE = 'Load a saved factory';
/** The status strip's readout (`controlHandlers.ts` `STATUS_COPY`). */
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';
/** The shipped example's cells (`examples/boards/order_processing.board.ron`): the Source and
 *  the validate Factory's anchor. */
const SOURCE_AT: [number, number] = [1, 6];
const VALIDATE_AT: [number, number] = [5, 5];
/** The shipped HTTP Sink's target port (`http://localhost:8799/fulfillment`). */
const HTTP_PORT = 8799;
/** The host's drain budget for a Pause, Save or Load (`sim_loop.rs` `MAX_SETTLE_TICKS`, 512). */
const SETTLE_TICKS = 512;
/** How many times slower than full speed the host may tick and still be graded (the 87 specs' 3). */
const SLOW_BOARD = 3;
/** Frames the Load's repopulate keyframe and the strip's update take to reach the page. */
const LOADED_FRAMES = 10;
/** Ticks from the webhook to the order leaving the Source, with room: natively the Source works
 *  on the tick after the webhook. */
const ARRIVE_TICKS = 30;
/** Steps tried while looking for the red tick. The order reaches the validate Factory about 22
 *  ticks after it leaves the Source (native probe: Source 61, Factory 83). */
const FAULT_STEP_BOUND = 60;
/** How long two reads of a held board must agree to count as held. */
const HELD_MS = 250;
/** The wall-clock part of the held read's cap: a few HELD_MS rounds. */
const HELD_POLL_MS = 1_000;
/** Pixels around a machine's box the red read allows (`92-red-means-faulted`): the alert ring
 *  sits a few px outside the box edge, so a third of a cell covers it. */
const RING_MARGIN = Math.round(CELL / 3);
/** The injected rule's element id. */
const CHROME_HIDE_ID = 'fab-100-chrome-hide';
/** The viewport every capture reads whole. */
const VIEWPORT = { width: 1280, height: 800 };

/** State bytes (`fabrico-protocol` `state_tag`). */
const IDLE = 0;
const WORKING = 1;
const FAULTED = 2;

type NodeFacts = SceneFacts['nodes'][number];
type BeltFacts = SceneFacts['belts'][number];

/**
 * The board as one string: the tick, each machine's id, kind, state and cells, and each belt's id
 * and occupied slots, sorted so two records compare with one `toBe`. WORKING reads as IDLE, as in
 * `98-save-open-replay`: a board just loaded has run no tick, so a machine that worked on the
 * saved tick reads IDLE after the Load with nothing in the file different.
 */
function recordOf(s: SceneFacts): string {
  const stateOf = (state: number): number => (state === WORKING ? IDLE : state);
  const nodes = s.nodes.map((n) => `node ${n.id} kind=${n.kind} state=${stateOf(n.state)} cells=${JSON.stringify(n.cells)}`).sort();
  const belts = s.belts.map((b) => `belt ${b.id} items=${b.items} slots=${JSON.stringify(b.occupiedSlots)}`).sort();
  return [`tick=${s.tick}`, ...nodes, ...belts].join('\n');
}

/** Item dots drawn on the given cells, as a sorted list. */
async function dotsOn(page: Page, cells: ReadonlyArray<{ cell_x: number; cell_y: number }>): Promise<string[]> {
  const dots = await itemDotsPerCell(page);
  return cells
    .map((c) => `${c.cell_x},${c.cell_y}`)
    .filter((k) => (dots[k] ?? 0) > 0)
    .map((k) => `${k}:${dots[k]}`)
    .sort();
}

/** The transport button: `Pause` while the sim runs, `Play` while it is paused. */
function transportOf(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

function stepOf(page: Page) {
  return page.getByRole('button', { name: 'Step', exact: true });
}

/** Read the board once two reads HELD_MS apart agree. */
async function heldScene(page: Page, what: string): Promise<SceneFacts> {
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

/** Hide every chrome element, leaving the one board canvas visible (the 92 method). */
async function hideChrome(page: Page): Promise<void> {
  await page.evaluate((id) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }';
  }, CHROME_HIDE_ID);
}

async function showChrome(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), CHROME_HIDE_ID);
}

/** The red-predicate pixels of a whole-viewport capture with the chrome hidden, as screen points. */
async function boardRedPoints(page: Page): Promise<Array<{ x: number; y: number }>> {
  await hideChrome(page);
  try {
    const png = PNG.sync.read(await captureClip(page, { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }));
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < png.data.length; i += 4) {
      if (isRedPixel(png.data[i], png.data[i + 1], png.data[i + 2])) out.push({ x: (i / 4) % png.width, y: Math.floor(i / 4 / png.width) });
    }
    return out;
  } finally {
    await showChrome(page);
  }
}

/** A node's screen box plus RING_MARGIN, through the live camera. */
async function screenBoxOf(page: Page, n: NodeFacts): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  const xs = n.cells.map((c) => c[0]);
  const ys = n.cells.map((c) => c[1]);
  const nw = await screenCellCentre(page, Math.min(...xs), Math.min(...ys));
  const se = await screenCellCentre(page, Math.max(...xs), Math.max(...ys));
  const half = ((await cameraOf(page)).scale * CELL) / 2;
  return { x0: nw.x - half - RING_MARGIN, y0: nw.y - half - RING_MARGIN, x1: se.x + half + RING_MARGIN, y1: se.y + half + RING_MARGIN };
}

/**
 * Press Step one tick at a time until the validate Factory reads FAULTED, reading the model after
 * every Step (it is red for one tick). On that held frame the board must be drawn red, and only
 * inside the Factory's box. Answers the tick.
 */
async function stepToRed(page: Page, validateId: number, what: string): Promise<number> {
  addWaitBudget(frameBudgetMs(FAULT_STEP_BOUND * 6), `${what}: up to ${FAULT_STEP_BOUND} steps looking for the red tick`);
  for (let i = 0; i < FAULT_STEP_BOUND; i++) {
    const s = await readScene(page);
    const validate = s.nodes.find((n) => n.id === validateId);
    if (validate?.state === FAULTED) {
      const others = s.nodes.filter((n) => n.id !== validateId && n.state === FAULTED).map((n) => n.id);
      expect(others, `${what}: only the validate Factory reads FAULTED at tick ${s.tick}`).toEqual([]);
      const box = await screenBoxOf(page, validate);
      const red = await boardRedPoints(page);
      const outside = red.filter((p) => !(p.x + 0.5 >= box.x0 && p.x + 0.5 <= box.x1 && p.y + 0.5 >= box.y0 && p.y + 0.5 <= box.y1));
      expect((await readScene(page)).tick, `${what}: the held tick did not move across the capture`).toBe(s.tick);
      console.log(`REPRO ${what} red tick=${s.tick} after ${i} steps red=${red.length} outside=${outside.length}`);
      expect(red.length, `${what}: the FAULTED validate Factory is drawn red on the held frame at tick ${s.tick}`).toBeGreaterThan(0);
      expect(outside.slice(0, 10), `${what}: every red pixel lies inside the validate Factory's box plus the ring margin`).toEqual([]);
      return s.tick;
    }
    await stepOf(page).click();
    await pollScene(page, (x) => x.tick > s.tick, { message: `${what}: one Step advanced the held board past tick ${s.tick}` }).toBe(true);
  }
  throw new Error(`${what}: the validate Factory never read FAULTED within ${FAULT_STEP_BOUND} steps`);
}

/** Press Load on the toolbar with `path` in the prompt, and wait for the strip to read Loaded. */
async function loadFile(page: Page, path: string, what: string): Promise<void> {
  expect(await guardWillAsk(page), `${what}: stepping made no unsaved edits, so Load opens no discard guard`).toBe(false);
  page.once('dialog', (d) => void d.accept(path));
  await page.locator(`button[title^="${LOAD_TITLE}"]`).click();
  await expect
    .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS) + frameBudgetMs(LOADED_FRAMES), `${what}: the Load swaps the board in`),
      intervals: [50, 100, 250],
      message: `${what}: the status strip reads Loaded`,
    })
    .toBe('Loaded');
}

const posts: string[] = [];
const listeners: Server[] = [];
let bindFailure: string | null = null;

function bindLoopback(host: string): Promise<Server | Error> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      posts.push(`${req.method ?? ''} ${req.url ?? ''}`);
      req.resume();
      req.on('end', () => {
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
    bindFailure = `could not bind 127.0.0.1:${HTTP_PORT} (${v4.message}), so the check that the HTTP Sink made no call did not run`;
    return;
  }
  listeners.push(v4);
  const v6 = await bindLoopback('::1');
  if (!(v6 instanceof Error)) listeners.push(v6);
});

test.afterAll(async () => {
  await Promise.all(listeners.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  listeners.length = 0;
});

let savePath: string | null = null;

test.afterEach(async ({ page }, testInfo) => {
  if (savePath !== null) rmSync(savePath, { force: true });
  savePath = null;
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('100 live: Reproduce a bug from a save file, the page steps on the real host', () => {
  test('a bad order held on the first belt with Step and saved turns the validate Factory red at the same tick T, and each of two Loads of the file reaches T again', async ({
    page,
  }, testInfo) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize(VIEWPORT);
    await page.goto('/');
    await waitForAppReady(page);

    // The page's command, read now so a broken block fails before the board is touched.
    const pageCurl = parseFirstWebhookCurl(readFileSync(BUG_PAGE, 'utf8'));

    // 1. Order processing from Examples. It plays as it loads.
    await loadExample(page, 'order_processing');
    await expect(page.locator('header [data-fab-status-strip] [data-fab-scene-badge]'), 'the status strip names the example').toHaveText(
      'Order processing',
    );
    const scene = await readScene(page);
    const source = nodeAtAnchor(scene, SOURCE_AT[0], SOURCE_AT[1]);
    const validate = nodeAtAnchor(scene, VALIDATE_AT[0], VALIDATE_AT[1]);
    expect(source, 'the example has its Source at (1,6)').toBeDefined();
    expect(validate, 'the example has its validate Factory at (5,5)').toBeDefined();
    const firstBelt: BeltFacts | undefined = scene.belts.find((b) => b.docks.some((d) => d.end === 'Tail' && d.node === source!.id));
    expect(firstBelt, 'a belt leaves the Source').toBeDefined();
    const beltId = firstBelt!.id;
    const beltCells = firstBelt!.tiles;
    const beltOf = (s: SceneFacts): BeltFacts | undefined => s.belts.find((b) => b.id === beltId);
    expect(beltOf(scene)?.items, 'the first belt starts empty').toBe(0);
    const before = scene.tick;
    await pollScene(page, (s) => s.tick > before, { message: 'the example plays as it loads (a held board answers a webhook with 503)' }).toBe(true);
    await expect(transportOf(page), 'the example plays, so the transport offers Pause').toHaveAttribute('aria-label', 'Pause');
    await expectRenderLoopAlive(page, 'on the playing example');

    // 2. The page's curl to the Source's URL, then Step on the first frame the order is on the belt.
    const hostUrl = await webhookUrl(page, source!.id);
    const parts = /^http:\/\/127\.0\.0\.1:(\d+)\/hook\/src-(\d+)$/.exec(hostUrl ?? '');
    expect(parts, `the host gives the Source a loopback /hook/src-<id> URL (got ${hostUrl})`).not.toBeNull();
    const url = pageCurl.urlFor(Number(parts![1]), Number(parts![2]));
    await page.evaluate((id) => {
      const w = window as unknown as {
        __fabrico: { scene(): { tick: number; belts: Array<{ id: number; items: number }> } };
        __reproHold?: { at: number | null; stop: boolean };
      };
      const latch: { at: number | null; stop: boolean } = { at: null, stop: false };
      w.__reproHold = latch;
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
    const deliveryId = `${pageCurl.deliveryId}-${Date.now()}`;
    const status = execFileSync('curl', curlArgs(url, deliveryId, pageCurl.body), {
      encoding: 'utf8',
      timeout: tickBudgetMs(SLOW_BOARD * ARRIVE_TICKS),
    }).trim();
    expect(status, 'curl prints 200: the app took the bad order').toBe('200');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __reproHold: { at: number | null } }).__reproHold.at), {
        timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ARRIVE_TICKS) + frameBudgetMs(2), 'the order leaves the Source onto the first belt'),
        intervals: [20, 50, 100],
        message: 'the order reaches the first belt and Step is pressed',
      })
      .not.toBeNull();
    await expect(transportOf(page), 'Step holds the board, so the transport offers Play').toHaveAttribute('aria-label', 'Play');

    // 3. The held board: the order on the first belt, drawn there, the Factory not red yet.
    const held = await heldScene(page, 'held with Step');
    const heldTick = held.tick;
    expect(beltOf(held)?.items, `the held board at tick ${heldTick} has the order on the first belt`).toBe(1);
    expect(held.nodes.find((n) => n.id === validate!.id)?.state, 'the validate Factory is not red yet').not.toBe(FAULTED);
    const heldDots = await dotsOn(page, beltCells);
    expect(heldDots.length, 'the order is drawn on the first belt').toBe(1);
    expect(await boardRedPoints(page), 'nothing on the held board is drawn red before the fault').toEqual([]);
    await expectRenderLoopAlive(page, 'held with the order on the first belt', { boardHeld: true });

    // 4. Save through the toolbar.
    savePath = join(tmpdir(), `fabrico-e2e-100-reproduce-${process.pid}-${Date.now()}.fab`);
    const path = savePath;
    page.once('dialog', (d) => void d.accept(path));
    await page.getByTitle(SAVE_TITLE).click();
    await waitForFile(path, `the Save wrote ${path}`, addWaitBudget(tickBudgetMs(SLOW_BOARD * SETTLE_TICKS), 'the host writes the project file'));
    const saved = await heldScene(page, 'after the save');
    expect(saved.tick, 'a paused board is saved where it stands').toBe(heldTick);
    const savedRecord = recordOf(saved);
    await expectRenderLoopAlive(page, 'after the save', { boardHeld: true });

    // 5. Step to the red tick.
    const t = await stepToRed(page, validate!.id, 'before any Load');
    expect(t, 'the red tick comes after the saved tick').toBeGreaterThan(heldTick);
    await expectRenderLoopAlive(page, 'at the red tick', { boardHeld: true });

    // 6 and 7. Load the file, see the board as saved, step to the red tick: twice.
    const loads: number[] = [];
    for (const what of ['the first Load', 'the second Load']) {
      await loadFile(page, path, what);
      await pollScene(page, recordOf, {
        timeout: addWaitBudget(frameBudgetMs(LOADED_FRAMES), `${what}: the loaded scene reaches the model`),
        message: `${what}: the board stands as saved at tick ${heldTick}, the order on its belt`,
      }).toBe(savedRecord);
      await expect
        .poll(() => dotsOn(page, beltCells), {
          timeout: addWaitBudget(frameBudgetMs(LOADED_FRAMES), `${what}: the loaded order is drawn`),
          message: `${what}: the order is drawn on the first belt as it was saved`,
        })
        .toEqual(heldDots);
      await expect(transportOf(page), `${what}: a board paused before the Load stays paused`).toHaveAttribute('aria-label', 'Play');
      await expectRenderLoopAlive(page, `after ${what}`, { boardHeld: true });
      const again = await stepToRed(page, validate!.id, what);
      loads.push(again);
      expect(again, `${what}: the validate Factory turns red at the same tick as before, ${t}`).toBe(t);
      await expectRenderLoopAlive(page, `at the red tick after ${what}`, { boardHeld: true });
    }
    console.log(`REPRO saved=${heldTick} red=${t} load1=${loads[0]} load2=${loads[1]} dots=${heldDots.join(' ')}`);

    // The HTTP Sink made no call: the bad order never got past the validate Factory.
    if (bindFailure !== null) {
      testInfo.annotations.push({ type: 'not checked', description: bindFailure });
      console.log(`REPRO ${bindFailure}`);
    } else {
      expect(posts, `no request reached localhost:${HTTP_PORT}, the HTTP Sink's target`).toEqual([]);
    }

    // 8. Play, so the shared host runs on for the next spec.
    const lastTick = (await readScene(page)).tick;
    await transportOf(page).click();
    await expect(transportOf(page), 'Play pressed, so the transport offers Pause').toHaveAttribute('aria-label', 'Pause');
    await pollScene(page, (s) => s.tick, {
      timeout: addWaitBudget(tickBudgetMs(SLOW_BOARD * ARRIVE_TICKS), 'the board plays on after the last Load'),
      message: `the board plays on past tick ${lastTick}`,
    }).toBeGreaterThan(lastTick);
    await expectRenderLoopAlive(page, 'playing again at the end');

    errs.assertNone('the bad order, the save, the red tick and both loads');
  });
});
