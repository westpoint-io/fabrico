import { test, expect, type Page } from '@playwright/test';
import {
  DRAWN_STATE_FRAMES,
  ENDPOINT_URL_SHAPE,
  armAndPlaceAt,
  cameraOf,
  demoCallerAndHandler,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  handDrawWire,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  rerouteMarkStrokes,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  selectMachineAt,
  startRerouteMarkSampler,
  stopRerouteMarkSampler,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import {
  addWaitBudget,
  frameBudgetMs,
  startFrameSampler,
  tickBudgetMs,
  waitForFramesAtFloor,
} from '../e2e/support/frameSampler';

// 75-reroute-mark.live.spec.ts (plan 75-06, CABLE-07) - on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS), a cable that an edit MOVED is painted in
// the build accent for about a second, and a cable is never painted for an undo or for
// traffic. Zero mocks, zero injected packets. The mark is read off the wire layer's own
// `cables` Graphics (`rerouteMarkStrokes`), once per animation frame by an in-page sampler,
// never off a flag.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-07 (phase 75 CONTEXT, fork 5): "Trigger on any cause: a diff packet re-sending an
// existing wire whose PATH differs (compare the path only; the host re-sends a wire on every
// pulse change, render_packet.rs:871, so comparing whole wires would flash constantly).
// Duration on the render clock like the comet latch, about one second (the plan fixes the
// number). A rewind or keyframe clears it, so undo, redo and board swaps never flash.
// Colour skin.palette.accents.build through the locked skin, no hex, no new palette entry.
// Tested by reading what is drawn, never a flag."
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. Rotating a wired machine marks its cable, then the mark goes. D-09's pair from plan
//      75-01: Route A at (10,14) turned once (Out faces S), Route B at (16,10), a hand-drawn
//      wire A Out to B In on 75-01's literal cells. Select A and press `r`: A's Out now faces
//      W and the host re-routes the cable to the go-around pinned below. Within 30 ticks of
//      the board's clock after the key (0.5 s at full speed) a frame plots the mark; within
//      120 ticks (2 s at full speed) the last marked frame has passed and the count reads 0.
//      RED at the instrument commit (count 0).
//   2. Undo after the rotate never marks. The same board and rotate, the mark left to
//      expire, then Ctrl+Z with the sampler running from before the key: the maximum over
//      1.5 s is 0 and the cells are 75-01's literal again. The host answers an undo with a
//      full keyframe (sim_loop), which clears every generation.
//   3. Demo traffic never marks. The shipped demo, POSTs to the caller's endpoint for 5 s,
//      `replyPulsesObserved` rising to prove traffic flowed and wires were re-sent: the
//      per-frame maximum is 0.
//
// THE WINDOWS WAIT FOR THEIR FRAMES (plan 84-09, GATE-01). The 2026-10-09 CI run (a 2-vCPU
// GitHub runner) failed legs 2 and 3 on `the sampler read frames across the window`: 22
// frames where above 30 was needed, and 67 where above 100. The windows were fixed in time
// (1.5 s after the undo, 5 s of traffic) and the runner draws the board through software GL
// at 12 to 15 frames a second. Plan 84-09 reproduced both on two cores at a 100% quota (17
// and 47). Each window now keeps its stated time as a minimum AND runs on until the frame
// count the old floor meant (31, 101) is in, through `frameSampler.ts`, so a slow machine
// samples longer, never less, and "no frame plotted a mark" is still a claim over every
// frame observed. A window whose frames never come is a named failure at the helper's cap.
//
// LEG 1 IS TIMED ON THE BOARD'S CLOCK (plan 84-11, a stated default). D-07 puts the mark's span on the render clock, 60 units, "about one second". The render
// clock follows the sim tick (it snaps to within `RESYNC_GAP_TICKS`, 6, of it, `loop.ts`), so on a
// machine where the sim runs below 60 ticks a second the mark stays on screen longer in wall time,
// by design: at a 100% CPU quota (one CPU's time) plan 84-09 read the last mark 2009 and 2398 ms after
// the key and 84-10 read 2499.6 ms, against the leg's old 2 s. Leg 1 now reads the board's tick on
// every frame it samples and bounds the mark in ticks after the key: on screen within 30, gone
// within 120, the same 0.5 s and 2 s at full speed. A mark that never goes still reddens on the
// 120-tick bound, which the wait reaches on the board's clock, not on a wall-clock budget; the
// wall-clock cap is only the shared sampler cap for a page whose frames never come.
//
// THE CAMERA, as plan 75-01's spec: 100% zoom at 1280x800, every pressed cell on the
// canvas. RENDER HEALTH: `watchPageErrors` before `goto`, `expectRenderLoopAlive` around
// every gesture: the model oracle is blind to a dead Pixi ticker.

type Cell = readonly [number, number];

const ROLE_IN = 0;
const ROLE_OUT = 1;
const MEDIUM_ELECTRICAL = 1;
const SIDE_S = 2;
const SIDE_W = 3;
const A: Cell = [10, 14];
const B: Cell = [16, 10];
/** A cell no leg places anything on, clicked to drop the selection. */
const EMPTY_CELL: Cell = [13, 12];
const KIND_ENDPOINT = 9;

/** Plan 75-01's literal: A turned once (Out S) to B, leaving down and entering from the west. */
const CELLS_OUT_S: Array<[number, number]> = [
  [10, 14],
  [10, 15],
  [11, 15],
  [12, 15],
  [13, 15],
  [14, 15],
  [15, 15],
  [15, 14],
  [15, 13],
  [15, 12],
  [15, 11],
  [15, 10],
  [16, 10],
];

/**
 * A turned twice (Out W) to B, MEASURED on the real host (plan 75-06) and equal to
 * 75-RESEARCH's reference rule: out of the W-facing Out to the west, up column 9 to row
 * 10, then east along row 10 into B's W-facing In.
 */
const CELLS_OUT_W: Array<[number, number]> = [
  [10, 14],
  [9, 14],
  [9, 13],
  [9, 12],
  [9, 11],
  [9, 10],
  [10, 10],
  [11, 10],
  [12, 10],
  [13, 10],
  [14, 10],
  [15, 10],
  [16, 10],
];

async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

async function expectOnCanvas(page: Page, at: Cell, ctx: string): Promise<void> {
  const p = await screenCellCentre(page, at[0], at[1]);
  const tag = await page.evaluate((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null, p);
  expect(tag, `${ctx}: (${at[0]},${at[1]}) is on the canvas, not under chrome`).toBe('CANVAS');
}

async function placeRoute(page: Page, at: Cell): Promise<void> {
  await expectOnCanvas(page, at, 'the drop cell');
  await armAndPlaceAt(page, 'Route', at[0], at[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, at[0], at[1]) !== undefined, {
    message: `the real host echoed the Route placed at (${at[0]},${at[1]})`,
  }).toBe(true);
}

function portOf(scene: SceneFacts, at: Cell, role: number): PortFacts {
  const node = nodeAtAnchor(scene, at[0], at[1]);
  expect(node, `a machine is anchored at (${at[0]},${at[1]})`).toBeDefined();
  const port = node!.ports.find((p) => p.role === role && p.medium === MEDIUM_ELECTRICAL);
  expect(port, `the machine at (${at[0]},${at[1]}) has an electrical port of role ${role}`).toBeDefined();
  return port as PortFacts;
}

function outSideOf(s: SceneFacts, at: Cell): number | undefined {
  return nodeAtAnchor(s, at[0], at[1])?.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL)
    ?.side;
}

function cellsOf(s: SceneFacts): Array<[number, number]> | null {
  if (s.wires.length !== 1) return null;
  return s.wires[0].path.map((c) => [c.cell_x, c.cell_y] as [number, number]);
}

/** Select A and press `r`, waiting for the host to fold the turn to `side`. */
async function turnA(page: Page, side: number, ctx: string): Promise<void> {
  await selectMachineAt(page, A[0], A[1]);
  await page.keyboard.press('r');
  await pollScene(page, (s) => outSideOf(s, A), { message: `${ctx}: the host folded the turn` }).toBe(side);
}

/** What a mark window counted: the largest stroke count on one frame, and the frames with any. */
interface MarkTally extends Record<string, number> {
  max: number;
  marked: number;
}

/**
 * The per-frame mark read, for `startFrameSampler`: the wire layer's own build-accent
 * stroke count, the same plot read `rerouteMarkStrokes` makes. Serialised, so it is
 * self-contained.
 */
function markProbe(t: MarkTally): void {
  const hook = (window as unknown as { __fabrico?: { rerouteMarkStrokes?(): number } }).__fabrico;
  if (typeof hook?.rerouteMarkStrokes !== 'function') {
    throw new Error('window.__fabrico.rerouteMarkStrokes() not installed');
  }
  const n = hook.rerouteMarkStrokes();
  t.max = Math.max(t.max, n);
  if (n > 0) t.marked += 1;
}

/** Leg 1's bounds, in ticks of the board's clock after the key (plan 84-11). */
const MARK_ON_TICKS = 30;
const MARK_GONE_TICKS = 120;
/** How far past `MARK_GONE_TICKS` the wait runs on the board's clock before it grades a mark that
 *  has not gone, so a stuck mark reddens on the bound with a measured value. */
const MARK_WAIT_SLACK_TICKS = 30;

/** What the board-clock mark sampler latched: ticks are counted from the tick at its start. */
interface MarkTicks {
  frames: number;
  max: number;
  /** The board's tick on the latest sampled frame, from the start. */
  ticks: number;
  firstMarkTicks: number | null;
  lastMarkTicks: number | null;
  firstMarkMs: number | null;
  lastMarkMs: number | null;
}

/**
 * Start sampling, once per animation frame, the wire layer's mark stroke count (the plot read
 * `rerouteMarkStrokes` makes) and the board's tick, from now (plan 84-11). Self-contained: it
 * runs in the page.
 */
async function startMarkTicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabrico?: { rerouteMarkStrokes?(): number; scene(): { tick: number } };
      __fabMarkTicks?: { st: Record<string, number | null>; live: boolean };
    };
    if (typeof w.__fabrico?.rerouteMarkStrokes !== 'function') {
      throw new Error('window.__fabrico.rerouteMarkStrokes() not installed');
    }
    if (w.__fabMarkTicks) w.__fabMarkTicks.live = false;
    const t0 = performance.now();
    const tick0 = w.__fabrico.scene().tick;
    const st: Record<string, number | null> = {
      frames: 0,
      max: 0,
      ticks: 0,
      firstMarkTicks: null,
      lastMarkTicks: null,
      firstMarkMs: null,
      lastMarkMs: null,
    };
    const rec = { st, live: true };
    w.__fabMarkTicks = rec;
    const step = (): void => {
      if (!rec.live) return;
      const n = w.__fabrico!.rerouteMarkStrokes!();
      const ticks = w.__fabrico!.scene().tick - tick0;
      st.frames = (st.frames ?? 0) + 1;
      st.max = Math.max(st.max ?? 0, n);
      st.ticks = ticks;
      if (n > 0) {
        const ms = Math.round(performance.now() - t0);
        if (st.firstMarkTicks === null) {
          st.firstMarkTicks = ticks;
          st.firstMarkMs = ms;
        }
        st.lastMarkTicks = ticks;
        st.lastMarkMs = ms;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** What the board-clock mark sampler has latched so far; `stop` ends it. */
async function readMarkTicks(page: Page, stop = false): Promise<MarkTicks> {
  return page.evaluate((end) => {
    const w = window as unknown as { __fabMarkTicks?: { st: MarkTicks; live: boolean } };
    const rec = w.__fabMarkTicks;
    if (!rec) throw new Error('board-clock mark sampler not started');
    if (end) rec.live = false;
    return { ...rec.st };
  }, stop);
}

/** D-09's pair: A turned once, B, and a hand-drawn wire on 75-01's literal cells. */
async function wiredPair(page: Page): Promise<void> {
  await emptyBoardAtScaleOne(page);
  await placeRoute(page, A);
  await placeRoute(page, B);
  await turnA(page, SIDE_S, 'setup');
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  const scene = await readScene(page);
  await expectRenderLoopAlive(page, 'before the hand-drawn wire');
  await handDrawWire(page, portOf(scene, A, ROLE_OUT), portOf(scene, B, ROLE_IN));
  await pollScene(page, (s) => JSON.stringify(cellsOf(s)), {
    message: 'the real host folded ONE wire on plan 75-01\'s cells',
  }).toBe(JSON.stringify(CELLS_OUT_S));
  await expectRenderLoopAlive(page, 'after the hand-drawn wire');
  // The wire was a FIRST SIGHTING: no frame since may carry a mark.
  expect(await rerouteMarkStrokes(page), 'a freshly drawn cable is not marked').toBe(0);
}

test.describe('CABLE-07 live: a cable an edit moved is marked; undo and traffic never mark', () => {
  test('rotating a wired machine marks its cable, then the mark goes', async ({ page }) => {
    const errs = watchPageErrors(page);
    await wiredPair(page);

    await selectMachineAt(page, A[0], A[1]);
    await startMarkTicks(page);
    await page.keyboard.press('r');
    await pollScene(page, (s) => outSideOf(s, A), { message: 'the host folded the second turn: Out faces W' }).toBe(
      SIDE_W,
    );
    await pollScene(page, (s) => JSON.stringify(cellsOf(s)), {
      message: 'the host re-routed the cable to the go-around out of the W-facing Out',
    }).toBe(JSON.stringify(CELLS_OUT_W));
    // Wait until the mark has come AND gone, or the board's clock has run past the bound, then
    // grade (plan 84-11: the wait is on the board's clock). The cap is that many ticks at the
    // slowest board clock measured, plus one page frame to read them on (D-12, review 84 WR-03).
    await expect
      .poll(
        async () => {
          const r = await readMarkTicks(page);
          const gone = r.firstMarkTicks !== null && (await rerouteMarkStrokes(page)) === 0;
          return gone || r.ticks > MARK_GONE_TICKS + MARK_WAIT_SLACK_TICKS;
        },
        {
          message: `the mark appeared and has gone again, or the board's clock ran ${MARK_GONE_TICKS + MARK_WAIT_SLACK_TICKS} ticks past the key`,
          timeout: addWaitBudget(
            tickBudgetMs(MARK_GONE_TICKS + MARK_WAIT_SLACK_TICKS) + frameBudgetMs(1),
            'mark came and went poll',
          ),
          intervals: [50],
        },
      )
      .toBe(true);
    const sample = await readMarkTicks(page, true);
    console.log(`REROUTE_MARK_ROTATE ${JSON.stringify(sample)}`);
    expect(sample.max, 'a frame plotted the build-accent mark on the moved cable').toBeGreaterThan(0);
    expect(
      sample.firstMarkTicks ?? Number.POSITIVE_INFINITY,
      `the mark was on screen within ${MARK_ON_TICKS} ticks of the board's clock (0.5 s at full speed) of the key (${sample.firstMarkMs} ms of wall time)`,
    ).toBeLessThanOrEqual(MARK_ON_TICKS);
    expect(
      sample.lastMarkTicks ?? Number.POSITIVE_INFINITY,
      `the mark was gone within ${MARK_GONE_TICKS} ticks of the board's clock (2 s at full speed) of the key (${sample.lastMarkMs} ms of wall time)`,
    ).toBeLessThanOrEqual(MARK_GONE_TICKS);
    expect(await rerouteMarkStrokes(page), 'nothing is marked now').toBe(0);

    await expectRenderLoopAlive(page, 'after the rotate');
    errs.assertNone('the rotate leg');
  });

  test('undo after the rotate never marks', async ({ page }) => {
    const errs = watchPageErrors(page);
    await wiredPair(page);
    await turnA(page, SIDE_W, 'the second turn');
    await pollScene(page, (s) => JSON.stringify(cellsOf(s)), { message: 'the cable re-routed' }).toBe(
      JSON.stringify(CELLS_OUT_W),
    );
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    // Let the rotate's own mark expire first, so the window below can only see the undo.
    await expect
      .poll(() => rerouteMarkStrokes(page), { message: 'the rotate\'s mark has expired', timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES) + tickBudgetMs(MARK_GONE_TICKS), 'rotate mark expired poll') })
      .toBe(0);

    // From before the key until the window below ends, every frame is read for a mark.
    await startRerouteMarkSampler(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => JSON.stringify(cellsOf(s)), {
      message: 'the undo put the cable back on plan 75-01\'s cells',
    }).toBe(JSON.stringify(CELLS_OUT_S));
    // The window after the undo folded: its 1.5 s AND the 31 frames the old floor (above
    // 30) meant, whichever comes later (the 2026-10-09 CI run read 22 frames in a fixed 1.5 s).
    await startFrameSampler(page, '__undoMarkWindow', { minMs: 1_500, frames: 31 }, { max: 0, marked: 0 }, markProbe);
    const win = await waitForFramesAtFloor<MarkTally>(page, '__undoMarkWindow');
    const sample = await stopRerouteMarkSampler(page);
    console.log(`REROUTE_MARK_UNDO ${JSON.stringify({ window: win, fromKey: sample })}`);
    expect(win.frames, 'the sampler read frames across the window').toBeGreaterThan(30);
    expect(win.elapsedMs, 'the window after the undo lasted its 1.5 s').toBeGreaterThanOrEqual(1_500);
    expect(win.tallies.max, 'no frame after the undo plotted a mark').toBe(0);
    expect(sample.max, 'no frame from the key to the end of the window plotted a mark').toBe(0);
    expect(outSideOf(await readScene(page), A), 'the undo took the turn back: Out faces S').toBe(SIDE_S);

    await expectRenderLoopAlive(page, 'after the undo');
    errs.assertNone('the undo leg');
  });

  test('demo traffic never marks', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectRenderLoopAlive(page, 'on the demo board');
    const before = await readScene(page);
    // The demo's caller, found BY KIND (plan 85-07): the board's Route whose one cable
    // delivers into its HTTP Handler, never a cell. Until 85-07 this read the Route at (10,6).
    const { caller, callerUrl } = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'right after finding the demo pair by kind');
    expect(caller, 'the demo board carries its caller endpoint').toBeDefined();
    expect(caller.kind, 'and it is a Route (kind 9)').toBe(KIND_ENDPOINT);
    const url = await webhookUrl(page, caller.id);
    expect(url, 'the caller resolves to a loopback POST URL').toMatch(ENDPOINT_URL_SHAPE);
    expect(url, "and it is the caller's own URL, the one the pair was found with").toBe(callerUrl);
    const paths = JSON.stringify(before.wires.map((w) => w.path));

    // The traffic window: 5 s of POSTs and 0.5 s for the last reply to come home (5.5 s
    // from its first frame) AND the 101 frames the old floor (above 100) meant, whichever
    // comes later (the 2026-10-09 CI run read 67 frames over the fixed window). The midday 2026-10-13 CI run
    // drew this page at about 5 frames a second and read 99 of the 101 frames before the
    // mock suite's fifteen second cap; under D-12 the frames, the 5.5 s and the per-frame
    // property stand, and only the cap is derived at the `FLOOR_FPS` floor (waitForFramesAtFloor).
    await startFrameSampler(page, '__trafficMarkWindow', { minMs: 5_500, frames: 101 }, { max: 0, marked: 0 }, markProbe);
    const until = Date.now() + 5_000;
    let posts = 0;
    while (Date.now() < until) {
      const resp = await page.request.post(url!, {
        data: '{}',
        headers: { 'content-type': 'application/json' },
        failOnStatusCode: false,
        timeout: 4_000,
      });
      expect(resp.status(), 'the endpoint answered').toBeLessThan(500);
      posts += 1;
      await page.waitForTimeout(150);
    }
    const sample = await waitForFramesAtFloor<MarkTally>(page, '__trafficMarkWindow');
    const after = await readScene(page);
    console.log(`REROUTE_MARK_TRAFFIC posts=${posts} replies=${after.replyPulsesObserved} ${JSON.stringify(sample)}`);
    expect(after.replyPulsesObserved, 'traffic flowed: replies came home on the return cable').toBeGreaterThan(
      before.replyPulsesObserved,
    );
    expect(JSON.stringify(after.wires.map((w) => w.path)), 'no cable moved').toBe(paths);
    expect(sample.frames, 'the sampler read frames across the window').toBeGreaterThan(100);
    expect(sample.elapsedMs, 'the window covered the traffic and the last reply').toBeGreaterThanOrEqual(5_500);
    expect(sample.tallies.max, 'no frame during traffic plotted a mark').toBe(0);

    await expectRenderLoopAlive(page, 'after the traffic');
    errs.assertNone('the traffic leg');
  });
});
