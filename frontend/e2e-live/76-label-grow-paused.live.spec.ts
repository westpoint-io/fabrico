import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The PNG decoder @playwright/test already bundles (pngjs), reached exactly as
// `06-fault-red-probe.spec.ts` reaches it. No new dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';
import { addFrameBudget } from '../e2e/support/frameSampler';
import {
  captureClip,
  anchorOf,
  cameraOf,
  expectRenderLoopAlive,
  HAND_MOVE_FRAMES,
  handPath,
  handPlaceAt,
  labelBoxOn,
  labelWordsOf,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
  restoreHostAfterFailedTest,
} from './support/oracle';

// 76-label-grow-paused.live.spec.ts (plan 76-10, SHAPE-10, SHAPE-12, D-01, D-04) - on a
// paused board, a label grown over a cell and a Source dropped on that cell must, after
// Play, end in the refusal sentence and nothing else, on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-01 ("Takes its cells"): a label takes its cells. No gesture the live host
// accepts can leave a machine on a label's cell, so every board a user can save loads.
//
// ---------------------------------------------------------------------------
// WHAT WAS MEASURED BEFORE THIS SPEC
// ---------------------------------------------------------------------------
//
// CR-02 (plan 76-07): while paused, the grow and the Place sit in one drain pass. The host
// validated the Place against the label's OLD box, so it minted the Source inside the grown
// label; the save succeeded and the load refused the file `CellCollision`. Plan 76-07 fixed
// the host: the Place is now refused `FootprintCollision`.
//
// THE FALSE ECHO (walk 76-09 CR-02-PAUSED, FAIL twice on the shipping binary): on 76-07's
// host the gesture layer's echo watcher still took "a different node now covers my cell"
// for "my Place echoed". After Play the grown label covers the cell, so the watcher adopted
// the label: it selected it, opened its panel with the caret in Text (which then swallowed
// Ctrl+S), and sent the ghost's queued Rotate at it, whose refusal replaced the true
// sentence on the band.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
// Both legs: an empty board at zoom 1; a Label placed by hand at (10,12) (4 by 1); the
// panel closed; Pause; the label selected, widened twice to 6 by 1, applied; the panel
// closed; a Source dropped by hand on (15,12), the cell the queued grow will cover; Play.
// Leg 1 drops the Source straight. Leg 2 turns its ghost once with `r` before the drop,
// so a Rotate is queued for the echo.
//
// PAINT FIRST, THEN THE ECHO, THEN THE MODEL (memory fabrico-model-oracle-blindspot,
// fabrico-checks-that-cannot-fail). After Play the first grade is the canvas: the pixel at
// the centre of the contested cell (15,12) must equal the pixel at the centre of the
// uncontested label cell (12,12) and differ from bare floor at (15,14). The label's box is
// 6 by 1 on every build, so its model and its box probe cannot tell a Source drawn inside
// it from none; only the paint can. Then the false-echo grades (no panel, no Text focus, no
// words change, the label unturned with no ports), then the band held on the one true
// sentence over at least 60 ticks, then the model, then (leg 1) Ctrl+S, New, Load.
//
// The paint grades and the echo grades are SOFT, so every one reports on every build. The
// sample guards (inside the viewport, clear of the palette and toolbar, clear of the
// refusal band) are read before Play and after Play and printed both times; a guard that
// fails after Play only is a finding, never a reason to move the leg.
//
// THE PENDING SHIMMER. A Place that never echoes keeps its neutral pending shimmer on the
// cell until the echo watch's TTL (`ECHO_TTL_TICKS`, 120 ticks from the emit tick, which on
// a paused board is the paused tick). On the fixed build that shimmer paints (15,12) for
// two seconds after Play, so the paint read waits for the TTL first. A wait, not a grade.
//
// EVERY POINTER MOVE IS HAND-LIKE: palette to cell in sub-cell steps with one diagonal
// stretch, presses a few px off a cell centre (memory fabrico-fixtures-move-one-clean-cell).
// Pause is host-global, so every leg presses Play in a `finally`.

/** The label kind byte (protocol `machine_kind::LABEL`). */
const KIND_LABEL = 11;
/** The Source kind byte (protocol `machine_kind::SOURCE`). */
const KIND_SOURCE = 0;
/** `gestures.ts` `ECHO_TTL_TICKS`, transcribed, not imported. */
const ECHO_TTL_TICKS = 120;
/** `REFUSAL_COPY.FootprintCollision`, transcribed, not imported. */
const FOOTPRINT_COLLISION = 'That space is taken. Clear it or try elsewhere.';
/** The hold window after the label shows its 6 cells, in ticks. */
const HOLD_TICKS = 60;
/** The oracle's pause between two hand moves, copied (oracle.ts keeps it private). The 6 px and
 *  4 px steps are the oracle's own now: the turned travel below walks `handPath` (plan 84-13). */
const HAND_PAUSE_MS = 8;

/** The three sample cells: contested, uncontested label, bare floor. */
const CONTESTED: [number, number] = [15, 12];
const LABEL_CELL: [number, number] = [12, 12];
const FLOOR_CELL: [number, number] = [15, 14];

/** The 4 cells of the placed label, and the 6 of the grown one, row-major literals. */
const FOUR_BY_ONE = ['10,12', '11,12', '12,12', '13,12'];
const SIX_BY_ONE = ['10,12', '11,12', '12,12', '13,12', '14,12', '15,12'];

type Node = SceneFacts['nodes'][number];
type Rgb = { r: number; g: number; b: number };

/** The toolbar's transport toggle: `Pause` while playing, `Play` while paused. */
function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** Pause from the toolbar and return the tick the host settled at (two reads 200 ms apart agree). */
async function pauseAndSettle(page: Page, leg: string): Promise<number> {
  await transport(page).click();
  await expect(transport(page), `${leg}: the sim is paused (the toggle offers Play)`).toHaveAttribute(
    'aria-label',
    'Play',
  );
  let pausedAt = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const settled = t === pausedAt;
        pausedAt = t;
        return settled;
      },
      { message: `${leg}: the host stopped ticking`, intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
  return pausedAt;
}

/** Press Play from the toolbar and wait until the host has run at least `ticks` ticks. */
async function playFor(page: Page, leg: string, ticks: number): Promise<void> {
  const t0 = (await readScene(page)).tick;
  await transport(page).click();
  await expect(transport(page), `${leg}: the toggle offers Pause again`).toHaveAttribute('aria-label', 'Pause');
  await pollScene(page, (s) => s.tick >= t0 + ticks, {
    message: `${leg}: the host ran ${ticks} ticks after Play`,
    timeout: 10_000,
  }).toBe(true);
}

/** Press Play if the toolbar offers it (the `finally` of every leg). */
async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label').catch(() => null)) === 'Play') {
    await transport(page).click();
  }
}

/** An empty board at camera scale 1. */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

/** The one label in the scene anchored at (cx, cy). */
function labelAt(scene: SceneFacts, cx: number, cy: number): Node {
  const node = nodeAtAnchor(scene, cx, cy);
  expect(node, `a node is anchored at (${cx},${cy})`).toBeDefined();
  expect(node!.kind, `the node at (${cx},${cy}) is a label`).toBe(KIND_LABEL);
  return node!;
}

/** A node's cells, sorted row-major, as `x,y` strings, so a literal list compares. */
function sortedCells(node: Node): string[] {
  return [...node.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([x, y]) => `${x},${y}`);
}

/** The canvas probe for label `id` reads a `w` by 1 box at (10,12). Polled. */
async function expectBoxPlotted(page: Page, id: number, w: number, when: string): Promise<void> {
  await expect
    .poll(async () => (await labelBoxOn(page, id))?.rect ?? null, {
      message: `${when}: the label-box Graphics of label ${id} plotted a ${w} by 1 box at (10,12)`,
    })
    .toEqual({ x: 10 * 32 + 4, y: 12 * 32 + 4, w: w * 32 - 8, h: 32 - 8 });
}

/**
 * THE FLOOR CELL a click lands on to close a panel (`FLOOR_CELL` above is the one sampled for
 * paint): three rows above the label's anchor, free on every board this spec builds. Until
 * plan 89-08 it was (4,6), which lies under the
 * palette whenever the camera is at the origin: a page that boots onto an EMPTY host board
 * keeps the boot fit pending, so `newBoard` plus Actual size leave the camera at (0,0) and
 * (4,6) is screen (147,206), inside the palette's 24 to 198 px. A spec that ended on an empty
 * board (`74.1-belt-refusals-say-why` leg 8, run before this file on one host) made leg 1's
 * click press "Place Source" and the panel never closed. (10,9) is on the canvas at the
 * origin (screen x 339) and under the demo board's boot fit alike.
 */
const CLICK_FLOOR: readonly [number, number] = [10, 9];

/**
 * A click a few px off the centre of cell (cx, cy). It names what is under the point first,
 * so a click that would land on app chrome instead of the board fails as that, not later as
 * a panel that did not close.
 */
async function clickCell(page: Page, cx: number, cy: number): Promise<void> {
  const at = await screenCellCentre(page, cx, cy);
  const x = at.x + 3;
  const y = at.y - 2;
  const hit = await page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? `${el.tagName}${el.getAttribute('aria-label') ? ` "${el.getAttribute('aria-label')}"` : ''}` : 'nothing';
  }, [x, y]);
  expect(hit, `the click on cell (${cx},${cy}) at screen (${Math.round(x)},${Math.round(y)}) lands on the board`).toBe(
    'CANVAS',
  );
  await page.mouse.click(x, y);
}

/**
 * `handPlaceAt`'s hand travel, copied, with ONE `r` pressed after arriving and before the
 * press, so the ghost is turned once and the gesture layer queues one Rotate for the echo.
 */
async function handPlaceTurnedAt(page: Page, kindName: string, cx: number, cy: number): Promise<void> {
  const row = page.getByRole('button', { name: `Place ${kindName}`, exact: true });
  await row.click();
  const box = await row.boundingBox();
  expect(box, `the "Place ${kindName}" palette row has a box`).not.toBeNull();
  const centre = await screenCellCentre(page, cx, cy);
  const end = { x: centre.x + 5, y: centre.y - 4 };
  const start = { x: box!.x + box!.width + 4, y: box!.y + box!.height / 2 };
  // The same points `handPlaceAt` walks (`handPath`: x only, a diagonal, the rest one axis at
  // a time, in steps of 6 px and 4 px), counted first so the travel budgets its own frames at
  // the `FLOOR_FPS` floor (plan 84-13, D-12).
  const path = [start, ...handPath(start, end)];
  addFrameBudget((path.length + 1) * HAND_MOVE_FRAMES, `handPlaceTurnedAt ${kindName} ${path.length} moves, 1 turn`);
  for (const p of path) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HAND_PAUSE_MS);
  }
  await page.keyboard.press('r');
  await page.waitForTimeout(HAND_PAUSE_MS);
  await page.mouse.down();
  await page.mouse.up();
}

/** One device pixel at the centre of cell (cx, cy), decoded from a 1 by 1 screenshot clip. */
async function samplePixel(page: Page, cx: number, cy: number): Promise<Rgb> {
  const at = await screenCellCentre(page, cx, cy);
  const clip = await captureClip(page, { x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1 });
  const png = PNG.sync.read(clip);
  return { r: png.data[0], g: png.data[1], b: png.data[2] };
}

/** Every channel within `tol`. */
function near(a: Rgb, b: Rgb, tol: number): boolean {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

const rgb = (c: Rgb): string => `rgb(${c.r},${c.g},${c.b})`;

interface Guard {
  cell: string;
  x: number;
  y: number;
  inViewport: boolean;
  clearOfChrome: boolean;
  clearOfBand: boolean;
}

/** The geometry guards for the three sample cells, read off the live page. */
async function readGuards(page: Page): Promise<Guard[]> {
  const vp = page.viewportSize();
  expect(vp, 'the page reports a viewport size').not.toBeNull();
  const inner = page.locator('#fab-refusal > *');
  const band = (await inner.count()) > 0 && (await inner.first().isVisible()) ? await inner.first().boundingBox() : null;
  const out: Guard[] = [];
  for (const [cx, cy] of [CONTESTED, LABEL_CELL, FLOOR_CELL]) {
    const at = await screenCellCentre(page, cx, cy);
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    out.push({
      cell: `${cx},${cy}`,
      x,
      y,
      inViewport: x >= 0 && y >= 0 && x < vp!.width && y < vp!.height,
      clearOfChrome: x > 210 && y > 95,
      clearOfBand: band === null || !(x >= band.x && x <= band.x + band.width && y >= band.y && y <= band.y + band.height),
    });
  }
  return out;
}

/** Print and assert the guards hard. */
async function checkGuards(page: Page, when: 'before Play' | 'after Play' | 'after Load'): Promise<void> {
  const g = await readGuards(page);
  if (when === 'before Play') console.log(`GUARDS before Play: ${JSON.stringify(g)}`);
  if (when === 'after Play') console.log(`GUARDS after Play: ${JSON.stringify(g)}`);
  if (when === 'after Load') console.log(`GUARDS after Load: ${JSON.stringify(g)}`);
  for (const s of g) {
    expect(s.inViewport, `guard ${when}: (${s.cell}) inside the viewport`).toBe(true);
    expect(s.clearOfChrome, `guard ${when}: (${s.cell}) clear of the palette and toolbar`).toBe(true);
    expect(s.clearOfBand, `guard ${when}: (${s.cell}) clear of the refusal band`).toBe(true);
  }
}

/**
 * A latch on `#fab-refusal` in the shape of `expectRefusalStayedSilent` (same ladder): it
 * records every DISTINCT non-empty reading from the moment it starts until `stop()`, and
 * for each the first and last time (ms since the latch started) it was read.
 */
function startBandLatch(page: Page): { stop(): Promise<string[]>; spans(): Record<string, [number, number]> } {
  const LADDER = [100, 250, 500];
  const seen: string[] = [];
  const spans: Record<string, [number, number]> = {};
  const t0 = Date.now();
  let running = true;
  const poll = (async () => {
    let step = 0;
    while (running) {
      const now = ((await page.locator('#fab-refusal').textContent().catch(() => '')) ?? '').trim();
      if (now !== '') {
        const at = Date.now() - t0;
        if (!seen.includes(now)) {
          seen.push(now);
          spans[now] = [at, at];
        } else {
          spans[now][1] = at;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, LADDER[Math.min(step, LADDER.length - 1)]));
      step += 1;
    }
  })();
  return {
    async stop() {
      running = false;
      await poll;
      return seen;
    },
    spans() {
      return spans;
    },
  };
}

/** The three-sample paint read. `soft` grades with `expect.soft`, else hard. */
async function gradePaint(page: Page, when: string, soft: boolean): Promise<void> {
  const contested = await samplePixel(page, ...CONTESTED);
  const label = await samplePixel(page, ...LABEL_CELL);
  const floor = await samplePixel(page, ...FLOOR_CELL);
  console.log(`PAINT ${when}: contested=${rgb(contested)} label=${rgb(label)} floor=${rgb(floor)}`);
  const asLabel = near(contested, label, 3);
  const asFloor = near(contested, floor, 3);
  const m1 = `${when}: the contested cell (15,12) paints as the label: (15,12) ${rgb(contested)}, (12,12) ${rgb(label)}`;
  const m2 = `${when}: the contested cell (15,12) carries the label tint, not bare floor: (15,12) ${rgb(contested)}, (15,14) ${rgb(floor)}`;
  if (soft) {
    expect.soft(asLabel, m1).toBe(true);
    expect.soft(asFloor, m2).toBe(false);
  } else {
    expect(asLabel, m1).toBe(true);
    expect(asFloor, m2).toBe(false);
  }
}

/**
 * The shared steps: place the label, pause, grow it to 6 by 1 from its panel, apply, drop
 * a Source on (15,12) (turned once in leg 2), Escape. Returns what the after-Play grades
 * compare against.
 */
async function growThenDrop(
  page: Page,
  leg: string,
  turned: boolean,
): Promise<{ labelId: number; pausedAt: number; wordsBefore: unknown }> {
  await emptyBoardAtScaleOne(page);
  await expectRenderLoopAlive(page, `${leg}: before the label is placed`);

  await handPlaceAt(page, 'Label', 10, 12);
  await pollScene(page, (s) => (nodeAtAnchor(s, 10, 12) ? sortedCells(nodeAtAnchor(s, 10, 12)!) : null), {
    message: `${leg}: the real host echoed a 4 by 1 label at (10,12)`,
  }).toEqual(FOUR_BY_ONE);
  const labelId = labelAt(await readScene(page), 10, 12).id;
  // WAIT FOR THE TOOL TO LET GO, NOT FOR THE MODEL (plan 84-10, the 2026-10-09 CI run). The
  // scene read above sees the label as soon as the host's packet lands; the Label tool lets
  // go and opens the panel on the gesture layer's next animation frame (`watchEcho`). On a
  // two-core runner that frame comes up to ~100 ms later, and a floor click inside it
  // placed a SECOND label at (4,6), which echoed after Play, was selected and opened its
  // panel: CI's `NO FALSE ECHO` reds, reproduced at q100 with a label minted at (4,6). So
  // the floor click waits for the label's panel to open and the palette row to un-press,
  // which also makes "the floor click closed the label panel" grade a panel that was open.
  await expect(page.locator('#fab-label-width'), `${leg}: the placed label's panel opened, reading 4`).toHaveText(
    '4',
  );
  await expect(
    page.getByRole('button', { name: 'Place Label', exact: true }),
    `${leg}: the Label tool let go after one placement`,
  ).toHaveAttribute('aria-pressed', 'false');
  await clickCell(page, ...CLICK_FLOOR);
  await expect(page.locator('#fab-label-width'), `${leg}: the floor click closed the label panel`).toHaveCount(0);
  await expectRenderLoopAlive(page, `${leg}: after the label is placed`);

  const pausedAt = await pauseAndSettle(page, leg);

  await clickCell(page, 11, 12);
  await expect(page.locator('#fab-label-width'), `${leg}: the label panel is open, reading 4`).toHaveText('4');
  const wider = page.getByRole('button', { name: 'Increase width', exact: true });
  await wider.click();
  await wider.click();
  await expect(page.locator('#fab-label-width'), `${leg}: the width readout`).toHaveText('6');
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply, `${leg}: Apply can be pressed while paused`).toBeEnabled();
  await apply.click();
  await clickCell(page, ...CLICK_FLOOR);
  await expect(page.locator('#fab-label-width'), `${leg}: the floor click closed the label panel`).toHaveCount(0);
  // No render-loop check while paused: `frame()` follows the render clock, which follows the
  // sim tick, so it holds one value on a paused board by design (measured: a healthy paused
  // page read one frame value for 15 s). The paused gestures are covered by `watchPageErrors`
  // and by the first loop check after Play.

  if (turned) {
    await handPlaceTurnedAt(page, 'Source', ...CONTESTED);
  } else {
    await handPlaceAt(page, 'Source', ...CONTESTED);
  }
  const ghost = await page.evaluate(() => {
    const hook = (window as { __fabrico?: { rejectFlashInstructions?(): number } }).__fabrico;
    return hook?.rejectFlashInstructions?.() ?? null;
  });
  console.log(`GHOST after drop: ${leg}: rejectFlashInstructions=${JSON.stringify(ghost)}`);
  await page.keyboard.press('Escape');

  const paused = await readScene(page);
  expect(paused.tick, `${leg}: still paused at the settled tick`).toBe(pausedAt);
  expect(sortedCells(labelAt(paused, 10, 12)), `${leg}: still paused, the label is 4 by 1`).toEqual(FOUR_BY_ONE);
  expect(paused.nodes.filter((n) => n.kind === KIND_SOURCE), `${leg}: still paused, no Source`).toEqual([]);
  const wordsBefore = await labelWordsOf(page, labelId);
  expect(wordsBefore, `${leg}: the label has no words element that could cover a sample`).toBeNull();
  await checkGuards(page, 'before Play');
  return { labelId, pausedAt, wordsBefore };
}

/** After Play: paint first, then the false-echo grades, the band hold, then the model. */
async function playAndGrade(
  page: Page,
  leg: string,
  ctx: { labelId: number; pausedAt: number; wordsBefore: unknown },
): Promise<void> {
  const latch = startBandLatch(page);
  let latched: string[] = [];
  try {
    await playFor(page, leg, 10);
    let t6 = -1;
    await pollScene(
      page,
      (s) => {
        const n = nodeAtAnchor(s, 10, 12);
        const grown = n !== undefined && sortedCells(n).join(' ') === SIX_BY_ONE.join(' ');
        if (grown && t6 < 0) t6 = s.tick;
        return grown;
      },
      { message: `${leg}: the label holds its 6 cells after Play` },
    ).toBe(true);
    await pollScene(page, (s) => s.tick > ctx.pausedAt + ECHO_TTL_TICKS, {
      message: `${leg}: the echo watch's TTL has passed (no pending shimmer can paint)`,
    }).toBe(true);
    const floor = await screenCellCentre(page, 25, 18);
    await page.mouse.move(floor.x + 3, floor.y - 2);
    await expectRenderLoopAlive(page, `${leg}: after Play, before the paint read`);
    await checkGuards(page, 'after Play');

    // PAINT FIRST.
    await gradePaint(page, `${leg}: after Play`, true);

    // THE FALSE ECHO.
    const headings = await page.locator('#fab-config-heading').count();
    expect.soft(headings, `NO FALSE ECHO: ${leg}: nothing was selected (no ConfigPanel heading)`).toBe(0);
    const textFields = await page.locator('#fab-label-text').count();
    expect.soft(textFields, `NO FALSE ECHO: ${leg}: no label panel (no Text field)`).toBe(0);
    const focused = await page.evaluate(() => document.activeElement?.id ?? '');
    expect.soft(focused, `NO FALSE ECHO: ${leg}: the keyboard is not in the label's Text field`).not.toBe('fab-label-text');
    const wordsAfter = await labelWordsOf(page, ctx.labelId);
    expect.soft(wordsAfter, `NO FALSE ECHO: ${leg}: the label's words are as before Play`).toEqual(ctx.wordsBefore);
    const now = labelAt(await readScene(page), 10, 12);
    const shape = { cells: sortedCells(now), ports: now.ports.length };
    expect.soft(shape, `NO FALSE ECHO: ${leg}: the label is unturned (its cells read 6 by 1 at rot 0), no ports`).toEqual({
      cells: SIX_BY_ONE,
      ports: 0,
    });

    await pollScene(page, (s) => s.tick >= t6 + HOLD_TICKS, {
      message: `${leg}: ${HOLD_TICKS} ticks have passed since the label showed its 6 cells`,
    }).toBe(true);
    latched = await latch.stop();
  } finally {
    await latch.stop();
  }
  console.log(`BAND_LATCH ${leg}: ${JSON.stringify(latch.spans())}`);
  const bandMsg = `BAND HELD: ${leg}: the band only ever read the one true sentence; it read ${JSON.stringify(latched)}`;
  expect.soft(latched, bandMsg).toEqual([FOOTPRINT_COLLISION]);

  // THE BAND STATED THE REFUSAL, read by the latch that ran from before Play (plan 84-10,
  // the 2026-10-09 CI run). This was a read of the band AFTER the paint and the hold, but the
  // band holds a sentence for `REFUSAL_HOLD_MS` (4000 ms of wall time) by design, and on two
  // loaded cores the three 1 by 1 screenshots alone took about 7 s: at q100 the band read the
  // sentence from 0.4 s to 3.7 s after Play and was empty, as designed, 12.5 s after it, when
  // that read came. The latch is what saw the refusal reach the band, at any machine speed.
  expect(latched, `${leg}: the band states the Place's refusal`).toContain(FOOTPRINT_COLLISION);

  // THE MODEL AND THE BOX.
  const s = await readScene(page);
  expect(s.nodes.filter((n) => n.kind === KIND_SOURCE), `${leg}: no Source exists anywhere`).toEqual([]);
  expect(sortedCells(labelAt(s, 10, 12)), `${leg}: the label holds exactly the 6 cells x 10 to 15, y 12`).toEqual(
    SIX_BY_ONE,
  );
  await expectBoxPlotted(page, ctx.labelId, 6, `${leg}: after Play`);
  await expectRenderLoopAlive(page, `${leg}: after the refusal`);
}

// THE SHARED HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12): this spec pauses the
// one shared host, and a test that times out while paused never reaches its `finally`.
// `restoreHostAfterFailedTest` puts the host back to running after a failed or timed-out
// test only, logs `HOST RESTORED after <title>`, and never changes that test's verdict.
test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('D-01 live: a paused grow then a Place on a covered cell is refused, and nothing else happens', () => {
  test('leg 1: a Source dropped on the grown cell is refused after Play, and the saved board reloads', async ({ page }) => {
    const errs = watchPageErrors(page);
    try {
      const ctx = await growThenDrop(page, 'leg 1', false);
      await playAndGrade(page, 'leg 1', ctx);

      // SAVE, NEW, LOAD.
      const savePath = join(tmpdir(), `fabrico-e2e-label-grow-paused-${Date.now()}.fab`);
      await clickCell(page, ...CLICK_FLOOR);
      page.once('dialog', (d) => d.accept(savePath));
      await page.keyboard.press('Control+s');
      await expect
        .poll(() => existsSync(savePath), {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message: 'leg 1: the host wrote the .fab project file',
        })
        .toBe(true);
      await expectRenderLoopAlive(page, 'leg 1: after the save');
      await newBoard(page);
      page.once('dialog', (d) => d.accept(savePath));
      await page.getByTitle('Load a saved factory').click();
      await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_LABEL).length, {
        message: 'leg 1: the loaded board holds exactly one label',
      }).toBe(1);
      await expectRenderLoopAlive(page, 'leg 1: after the load');
      const s = await readScene(page);
      const loaded = s.nodes.find((n) => n.kind === KIND_LABEL)!;
      expect(anchorOf(loaded), 'leg 1: the reloaded label sits at (10,12)').toEqual([10, 12]);
      expect(sortedCells(loaded), 'leg 1: the reloaded label holds the same 6 cells').toEqual(SIX_BY_ONE);
      expect(s.nodes.filter((n) => n.kind === KIND_SOURCE), 'leg 1: the reloaded board has no Source').toEqual([]);
      await expectBoxPlotted(page, loaded.id, 6, 'leg 1: after the Load');
      const off = await screenCellCentre(page, 25, 18);
      await page.mouse.move(off.x + 3, off.y - 2);
      await expectRenderLoopAlive(page, 'leg 1: after the load, before the paint read');
      await checkGuards(page, 'after Load');
      await gradePaint(page, 'leg 1: after the Load', false);
      errs.assertNone('leg 1: a paused grow, a refused Place, a save and a load');
    } finally {
      await resumeIfPaused(page);
    }
  });

  test('leg 2: a turned Source dropped on the grown cell is refused after Play, and no Rotate follows', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    try {
      const ctx = await growThenDrop(page, 'leg 2', true);
      await playAndGrade(page, 'leg 2', ctx);
      errs.assertNone('leg 2: a paused grow and a refused turned Place');
    } finally {
      await resumeIfPaused(page);
    }
  });
});
