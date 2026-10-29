import { test, expect, type Page } from '@playwright/test';
import { GESTURE_FRAME_VERSION } from '../e2e/support/wire';
// The PNG decoder @playwright/test already bundles (pngjs), reached exactly as
// `76-label-grow-paused.live.spec.ts` reaches it. No new dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PNG } from 'playwright-core/lib/utilsBundle';
import { addFrameBudget } from '../e2e/support/frameSampler';
import {
  captureClip,
  cameraOf,
  expectRenderLoopAlive,
  HAND_MOVE_FRAMES,
  handPlaceAt,
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

// 76-same-cell-double-drop.live.spec.ts (refuter round after plan 76-10) - two Places of
// the SAME kind dropped on ONE free cell in one paused pass, on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks.
//
// THE DEFECT. After Play the host mints the first Place and refuses the second
// (FootprintCollision, "That space is taken. Clear it or try elsewhere."). Exactly one
// Source appears, anchored at the cell, of the placed kind, and it was not there at either
// emit, so BOTH pending entries of the gesture layer's echo watch matched it. The refused
// Place took the first Place's Source as its own echo and sent its queued Rotate at it: a
// Source the user dropped unturned came out turned, under the refusal sentence. Through the
// palette (Escape, arm again) it was worse, because arming a tool threw the first entry
// away and the refused one was the only watcher left.
//
// THE FIX, AS OF PHASE 88 (plan 88-05, D-06): each pending Place ends on the host's own
// answer to it, paired by the gesture id the page sent it under. A refused Place sends
// nothing; an accepted one sends its queued Rotates at the handle its accept names, once a
// packet shows that handle. Arming a tool still gives up a pending Place's follow-ups
// (`PendingPlacement.abandoned`), and no entry is dropped or matched by its cell. (Until
// phase 88 the client claimed the one minted node for the earliest Place in emit order,
// `claimedEchoIds`, which leg 6 below proved could not be right.)
//
// THE LEGS. Each starts on an empty board at zoom 1 with two references placed live: an
// unturned Source at (8,12) and a Source turned once at (22,12). Then Pause, two drops on
// (15,12), Play, 130 ticks.
//   leg 1: the tool stays armed: drop unturned, press r, drop again.
//   leg 2: drop unturned, Escape, arm Source from the palette, press r, drop again.
//   leg 3: press r first, then drop twice: ONE turn, never two.
//   leg 4: the Router preset dropped twice: ONE preset seeding.
//   leg 5: the correction flow, which the fix must not break: a Source X already on the
//          cell, a Source dropped on it, Escape, X selected and deleted, the tool armed
//          again, r, a Source dropped on the cell. The host refuses the first (X is still
//          there when it drains), deletes X and mints the second, which is turned once.
//          The first Place's watch must not claim the second Place's Source.
//   leg 6: the WORK-04 sequence (phase 88, D-06, D-12): a Source X already on the cell,
//          Pause, X selected and deleted (the Delete is queued), a Source dropped on the
//          cell, Escape, the tool armed again, r, a second Source dropped on the cell. The
//          host deletes X, mints the FIRST Place (unturned) and refuses the second. The
//          client cannot tell the two apart from the cell, kind and emit order: only the
//          host's answer to each Place says which one minted the Source, so no Rotate may go
//          out after Play.
//
// WHAT IS GRADED, PAINT FIRST (memory fabrico-model-oracle-blindspot). For the Source legs
// a screenshot crop around the contested Source is compared with crops around the two
// references: it must paint like the reference it should match and unlike the other. Then
// the wire (no Rotate after Play in legs 1 and 2, exactly one in leg 3, exactly one
// seeding's frames in leg 4), then the model (port sides as the matching reference). Every
// leg also grades the band (the one true sentence), render health (watchPageErrors and
// expectRenderLoopAlive after Play), and that the board did not move while paused.

const KIND_SOURCE = 0;
const KIND_ROUTER = 5;
const FOOTPRINT_COLLISION = 'That space is taken. Clear it or try elsewhere.';
/**
 * The three cells, chosen per page load on the row through the middle of the viewport
 * (`chooseCells`): the camera keeps its pan across `resetZoomToActualSize`, so a fixed
 * cell lands at a different screen point on each load, and a cell near the bottom edge
 * sits under the chrome. The contested cell is in the middle, the references 6 cells
 * either side.
 */
let CONTESTED: [number, number] = [0, 0];
let REF_UNTURNED: [number, number] = [0, 0];
let REF_TURNED: [number, number] = [0, 0];
const HAND_STEP_PX = 6;
const HAND_PAUSE_MS = 8;
/** Rotate is variant 2 of the GridCommand enum: `[2, node, ccw]`. */
const ROTATE_TAG = 2;

function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

async function pause(page: Page): Promise<number> {
  await transport(page).click();
  await expect(transport(page)).toHaveAttribute('aria-label', 'Play');
  let prev = -1;
  await expect
    .poll(
      async () => {
        const t = (await readScene(page)).tick;
        const still = t === prev;
        prev = t;
        return still;
      },
      { intervals: [200], timeout: 10_000, message: 'the tick holds still once paused' },
    )
    .toBe(true);
  return prev;
}

async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label').catch(() => null)) === 'Play') {
    await transport(page).click();
  }
}

async function emptyBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'zoom 1').toBe(1);
  await chooseCells(page);
}

async function chooseCells(page: Page): Promise<void> {
  const a = await screenCellCentre(page, 0, 0);
  const b = await screenCellCentre(page, 1, 1);
  const cell = b.x - a.x;
  // Clamped onto the board (the pan differs per page load and can put cell 0 near the
  // middle); `guardCrop` below still proves each crop is clear of the chrome.
  const cx = Math.max(7, Math.round((640 - a.x) / cell));
  const cy = Math.max(2, Math.round((400 - a.y) / (b.y - a.y)));
  CONTESTED = [cx, cy];
  REF_UNTURNED = [cx - 6, cy];
  REF_TURNED = [cx + 6, cy];
  expect(Math.min(cx - 6, cy), 'the chosen cells are on the board').toBeGreaterThanOrEqual(1);
  // Guard that every crop sees only the canvas (no chrome over it).
  for (const c of [CONTESTED, REF_UNTURNED, REF_TURNED]) await guardCrop(page, c);
  console.log(`CELLS contested=${CONTESTED} unturned=${REF_UNTURNED} turned=${REF_TURNED} cell=${cell}px`);
}

async function parkCursor(page: Page): Promise<void> {
  const off = await screenCellCentre(page, CONTESTED[0], CONTESTED[1] - 5);
  await page.mouse.move(off.x, off.y);
}

/** Every crop point (corners, edge middles, centre) hits the canvas and nothing else. */
async function guardCrop(page: Page, c: [number, number]): Promise<void> {
  const m = await screenCellCentre(page, ...c);
  const pts: Array<[number, number]> = [];
  for (const dx of [-47, 0, 47]) for (const dy of [-47, 0, 47]) pts.push([m.x + dx, m.y + dy]);
  const tags = await page.evaluate(
    (ps) => ps.map(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE'),
    pts,
  );
  expect(tags, `the crop around (${c}) is all canvas`).toEqual(pts.map(() => 'CANVAS'));
}

/**
 * Crop difference over the machine's ART only: pixels where exactly one of the two crops
 * is bright (any channel above 110), at the best of the nine one-pixel shifts of `b`
 * against `a` (the outer pixel ring ignored). The floor is not the same at every cell (a
 * major grid line every few columns, measured at rgb(59,66,80) against rgb(42,47,58)), and
 * the floor is dark, so the bright test reads the body, glyph and port nub only. Measured
 * on the fixed build: two unturned Sources compare 0, two turned Sources compare 0, and an
 * unturned against a turned one compares in the dozens (the nub on another side, which no
 * one-pixel shift removes).
 */
function diffPx(a: Buffer, b: Buffer): number {
  const W = 96;
  const bright = (d: Buffer, k: number): boolean => d[k] > 110 || d[k + 1] > 110 || d[k + 2] > 110;
  let best = Number.POSITIVE_INFINITY;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let d = 0;
      for (let y = 1; y < W - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          if (bright(a, (y * W + x) * 4) !== bright(b, ((y + dy) * W + (x + dx)) * 4)) d++;
        }
      }
      best = Math.min(best, d);
    }
  }
  return best;
}

/**
 * Pause, then click empty floor the way a user would put the mouse back on the board: the
 * Pause button keeps the keyboard focus after its click, and every canvas shortcut (r,
 * Escape) stands down while a button holds it.
 */
async function pauseAndFocusBoard(page: Page): Promise<number> {
  const t0 = await pause(page);
  const off = await screenCellCentre(page, CONTESTED[0], CONTESTED[1] - 5);
  await page.mouse.click(off.x, off.y);
  return t0;
}

/** Arm `kindName` from the palette, travel to the cell, press r `turns` times, drop. */
async function handPlaceTurnedAt(
  page: Page,
  kindName: string,
  cx: number,
  cy: number,
  turns: number,
): Promise<void> {
  const row = page.getByRole('button', { name: `Place ${kindName}`, exact: true });
  await row.click();
  const box = await row.boundingBox();
  expect(box, `the "Place ${kindName}" palette row has a box`).not.toBeNull();
  const centre = await screenCellCentre(page, cx, cy);
  const end = { x: centre.x + 5, y: centre.y - 4 };
  let x = box!.x + box!.width + 4;
  let y = box!.y + box!.height / 2;
  const toward = (v: number, goal: number, max: number): number =>
    goal > v ? Math.min(goal, v + max) : Math.max(goal, v - max);
  // The points this hand walks, counted first so the travel budgets its own frames at the
  // `FLOOR_FPS` floor (plan 84-13, D-12); the 6 px step and the off-centre landing are unchanged.
  const path: { x: number; y: number }[] = [];
  while (Math.abs(end.x - x) > 0.5 || Math.abs(end.y - y) > 0.5) {
    x = toward(x, end.x, HAND_STEP_PX);
    y = toward(y, end.y, HAND_STEP_PX);
    path.push({ x, y });
  }
  addFrameBudget((path.length + turns) * HAND_MOVE_FRAMES, `handPlaceTurnedAt ${kindName} ${path.length} moves, ${turns} turns`);
  for (const p of path) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HAND_PAUSE_MS);
  }
  for (let i = 0; i < turns; i++) {
    await page.keyboard.press('r');
    await page.waitForTimeout(HAND_PAUSE_MS);
  }
  await page.mouse.down();
  await page.mouse.up();
}

/** A click at the cell with the armed tool (same off-centre point as `handPlaceAt`). */
async function clickCell(page: Page, cx: number, cy: number): Promise<void> {
  const c = await screenCellCentre(page, cx, cy);
  await page.mouse.move(c.x + 5, c.y - 4);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * The BODY of every binary gesture frame the page sends, in order. Since phase 88 every
 * frame starts with a header, the version byte (T-88-09) then two varints, the board
 * generation and the page's gesture id (plan 88-03, D-02, D-06); it is stripped here, so
 * `f[0]` is still the `GridCommand` discriminant the legs below count.
 */
function recordSentFrames(page: Page): number[][] {
  const frames: number[][] = [];
  const skipVarint = (bytes: number[], at: number): number => {
    let i = at;
    while (i < bytes.length && (bytes[i] & 0x80) !== 0) i++;
    return i + 1;
  };
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string') return;
      const bytes = [...(f.payload as Buffer)];
      if (bytes[0] !== GESTURE_FRAME_VERSION) {
        throw new Error(`the page sent a gesture frame without the version byte: [${bytes.join(',')}]`);
      }
      frames.push(bytes.slice(skipVarint(bytes, skipVarint(bytes, 1))));
    });
  });
  return frames;
}

/** Every distinct text the refusal band shows over `ms`. */
async function bandSeen(page: Page, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = ((await page.locator('#fab-refusal').textContent().catch(() => '')) ?? '').trim();
    if (t && !seen.includes(t)) seen.push(t);
    await page.waitForTimeout(100);
  }
  return seen;
}

/** A 3 by 3 cell crop centred on a cell, as raw RGBA bytes. */
async function crop(page: Page, cx: number, cy: number, path?: string): Promise<Buffer> {
  const c = await screenCellCentre(page, cx, cy);
  const clip = { x: Math.round(c.x - 48), y: Math.round(c.y - 48), width: 96, height: 96 };
  return PNG.sync.read(await captureClip(page, clip, path)).data as Buffer;
}

function portsAt(s: SceneFacts, cx: number, cy: number): string[] | null {
  const n = nodeAtAnchor(s, cx, cy);
  return n ? n.ports.map((p) => `${p.role}:${p.side}:${p.medium}`).sort() : null;
}

async function placeReferences(page: Page): Promise<void> {
  await handPlaceAt(page, 'Source', ...REF_UNTURNED);
  await page.keyboard.press('Escape');
  await handPlaceTurnedAt(page, 'Source', ...REF_TURNED, 1);
  await page.keyboard.press('Escape');
  await pollScene(
    page,
    (s) =>
      !!nodeAtAnchor(s, ...REF_UNTURNED) &&
      !!nodeAtAnchor(s, ...REF_TURNED) &&
      JSON.stringify(portsAt(s, ...REF_TURNED)) !== JSON.stringify(portsAt(s, ...REF_UNTURNED)),
    { message: 'both references echoed, the turned one turned' },
  ).toBe(true);
}

/** Play, run 130 ticks, and return what the band showed meanwhile. */
async function playAndSettle(page: Page, t0: number): Promise<string[]> {
  const bandP = bandSeen(page, 3_500);
  await transport(page).click();
  await expect(transport(page)).toHaveAttribute('aria-label', 'Pause');
  await pollScene(page, (s) => s.tick > t0 + 130, { message: 'ran 130 ticks', timeout: 15_000 }).toBe(true);
  // Park the cursor on empty floor so no hover paints over the crops.
  await parkCursor(page);
  return bandP;
}

type Expect = 'unturned' | 'turned';

async function gradeSource(
  page: Page,
  leg: string,
  frames: number[][],
  framesAtPlay: number,
  want: Expect,
  band: string[],
): Promise<void> {
  // PAINT FIRST.
  for (const c of [CONTESTED, REF_UNTURNED, REF_TURNED]) await guardCrop(page, c);
  // The three crops also go into the test's output folder, so a red PAINT grade can be
  // looked at.
  const got = await crop(page, ...CONTESTED, test.info().outputPath('contested.png'));
  const unturned = await crop(page, ...REF_UNTURNED, test.info().outputPath('ref-unturned.png'));
  const turned = await crop(page, ...REF_TURNED, test.info().outputPath('ref-turned.png'));
  const dUnturned = diffPx(got, unturned);
  const dTurned = diffPx(got, turned);
  const s = await readScene(page);
  const sources = s.nodes.filter((n) => n.kind === KIND_SOURCE).length;
  const after = frames.slice(framesAtPlay);
  const rotates = after.filter((f) => f[0] === ROTATE_TAG).length;
  console.log(
    `${leg}: paintDiff unturned=${dUnturned} turned=${dTurned} rotatesAfterPlay=${rotates} sources=${sources} ` +
      `contested=${JSON.stringify(portsAt(s, ...CONTESTED))} refUnturned=${JSON.stringify(portsAt(s, ...REF_UNTURNED))} ` +
      `refTurned=${JSON.stringify(portsAt(s, ...REF_TURNED))} band=${JSON.stringify(band)}`,
  );
  const [same, other] = want === 'unturned' ? [dUnturned, dTurned] : [dTurned, dUnturned];
  expect(same, `${leg} PAINT: the contested Source paints like the ${want} reference`).toBeLessThan(other);
  expect(same, `${leg} PAINT: and matches it within a few pixels`).toBeLessThanOrEqual(8);
  expect(rotates, `${leg} WIRE: Rotates sent after Play`).toBe(want === 'unturned' ? 0 : 1);
  expect(sources, `${leg}: the two references and the ONE minted Source`).toBe(3);
  expect(portsAt(s, ...CONTESTED), `${leg} MODEL: ports as the ${want} reference`).toEqual(
    portsAt(s, ...(want === 'unturned' ? REF_UNTURNED : REF_TURNED)),
  );
  expect(band, `${leg} BAND: only the one true sentence`).toEqual([FOOTPRINT_COLLISION]);
}

// THE SHARED HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12): this spec pauses the
// one shared host, and a test that times out while paused never reaches its `finally`.
// `restoreHostAfterFailedTest` puts the host back to running after a failed or timed-out
// test only, logs `HOST RESTORED after <title>`, and never changes that test's verdict.
test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('two same-kind Places on one cell in one paused pass (refuter round, 76-10)', () => {
  test('leg 1: tool stays armed, unturned drop, r, second drop refused; the Source stays unturned', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const frames = recordSentFrames(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 1 start');
      await placeReferences(page);
      const t0 = await pauseAndFocusBoard(page);
      await handPlaceAt(page, 'Source', ...CONTESTED);
      await page.keyboard.press('r');
      await page.waitForTimeout(50);
      await clickCell(page, ...CONTESTED);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).tick, 'leg 1: still paused').toBe(t0);
      const framesAtPlay = frames.length;
      const band = await playAndSettle(page, t0);
      await expectRenderLoopAlive(page, 'leg 1 after Play');
      errs.assertNone('leg 1');
      await gradeSource(page, 'leg 1', frames, framesAtPlay, 'unturned', band);
    } finally {
      await resumeIfPaused(page);
    }
  });

  test('leg 2: Escape and arm again from the palette, r, second drop refused; the Source stays unturned', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const frames = recordSentFrames(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 2 start');
      await placeReferences(page);
      const t0 = await pauseAndFocusBoard(page);
      await handPlaceAt(page, 'Source', ...CONTESTED);
      await page.keyboard.press('Escape');
      await handPlaceTurnedAt(page, 'Source', ...CONTESTED, 1);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).tick, 'leg 2: still paused').toBe(t0);
      const framesAtPlay = frames.length;
      const band = await playAndSettle(page, t0);
      await expectRenderLoopAlive(page, 'leg 2 after Play');
      errs.assertNone('leg 2');
      await gradeSource(page, 'leg 2', frames, framesAtPlay, 'unturned', band);
    } finally {
      await resumeIfPaused(page);
    }
  });

  test('leg 3: r, then two drops on one cell; the one minted Source is turned once, not twice', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const frames = recordSentFrames(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 3 start');
      await placeReferences(page);
      const t0 = await pauseAndFocusBoard(page);
      await handPlaceTurnedAt(page, 'Source', ...CONTESTED, 1);
      await page.waitForTimeout(50);
      await clickCell(page, ...CONTESTED);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).tick, 'leg 3: still paused').toBe(t0);
      const framesAtPlay = frames.length;
      const band = await playAndSettle(page, t0);
      await expectRenderLoopAlive(page, 'leg 3 after Play');
      errs.assertNone('leg 3');
      await gradeSource(page, 'leg 3', frames, framesAtPlay, 'turned', band);
    } finally {
      await resumeIfPaused(page);
    }
  });

  test('leg 5: drop on a blocker, delete it, arm again, turned drop; the new Source is turned once', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const frames = recordSentFrames(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 5 start');
      await placeReferences(page);
      // The blocker X, unturned, live.
      await handPlaceAt(page, 'Source', ...CONTESTED);
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => !!nodeAtAnchor(s, ...CONTESTED), { message: 'leg 5: X echoed' }).toBe(true);
      const x = nodeAtAnchor(await readScene(page), ...CONTESTED)!.id;
      const t0 = await pauseAndFocusBoard(page);
      await handPlaceAt(page, 'Source', ...CONTESTED);
      await page.keyboard.press('Escape');
      await clickCell(page, ...CONTESTED);
      await page.keyboard.press('Delete');
      await handPlaceTurnedAt(page, 'Source', ...CONTESTED, 1);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).tick, 'leg 5: still paused').toBe(t0);
      expect(frames.some((f) => f[0] === 1 && f[1] === x), 'leg 5: a Delete of X went out').toBe(true);
      const framesAtPlay = frames.length;
      const band = await playAndSettle(page, t0);
      await expectRenderLoopAlive(page, 'leg 5 after Play');
      errs.assertNone('leg 5');
      expect(nodeAtAnchor(await readScene(page), ...CONTESTED)?.id, 'leg 5: X is gone, a new Source stands').not.toBe(x);
      await gradeSource(page, 'leg 5', frames, framesAtPlay, 'turned', band);
    } finally {
      await resumeIfPaused(page);
    }
  });

  test('leg 6: a Delete queued, a drop, Escape, r, a second drop on one cell; the minted Source stays unturned', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    const frames = recordSentFrames(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 6 start');
      await placeReferences(page);
      // The blocker X, unturned, live.
      await handPlaceAt(page, 'Source', ...CONTESTED);
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => !!nodeAtAnchor(s, ...CONTESTED), { message: 'leg 6: X echoed' }).toBe(true);
      const x = nodeAtAnchor(await readScene(page), ...CONTESTED)!.id;
      const t0 = await pauseAndFocusBoard(page);
      // 1. Select X and press Delete: the Delete is queued, X stays drawn while paused.
      await clickCell(page, ...CONTESTED);
      await page.keyboard.press('Delete');
      expect(frames.some((f) => f[0] === 1 && f[1] === x), 'leg 6: a Delete of X went out').toBe(true);
      expect(nodeAtAnchor(await readScene(page), ...CONTESTED)?.id, 'leg 6: X still stands while paused').toBe(x);
      // 2. Arm Source and drop on the cell, unturned.
      await handPlaceAt(page, 'Source', ...CONTESTED);
      // 3. Escape, arm Source again, r, drop on the cell.
      await page.keyboard.press('Escape');
      await handPlaceTurnedAt(page, 'Source', ...CONTESTED, 1);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).tick, 'leg 6: still paused').toBe(t0);
      // 4. Play.
      const framesAtPlay = frames.length;
      const band = await playAndSettle(page, t0);
      await expectRenderLoopAlive(page, 'leg 6 after Play');
      errs.assertNone('leg 6');
      expect(nodeAtAnchor(await readScene(page), ...CONTESTED)?.id, 'leg 6: X is gone, a new Source stands').not.toBe(x);
      await gradeSource(page, 'leg 6', frames, framesAtPlay, 'unturned', band);
    } finally {
      await resumeIfPaused(page);
    }
  });

  test('leg 4: the Router preset dropped twice on one cell is seeded once', async ({ page }) => {
    const errs = watchPageErrors(page);
    const frames = recordSentFrames(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 4 start');
      // The reference: one preset Router placed live; what its echo sent is one seeding.
      const beforeRef = frames.length;
      await handPlaceAt(page, 'Router', ...REF_UNTURNED);
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => (nodeAtAnchor(s, ...REF_UNTURNED)?.ports.length ?? 0) >= 5, {
        message: 'the reference Router echoed and was seeded',
      }).toBe(true);
      await page.waitForTimeout(500);
      const seeding = frames.length - beforeRef - 1;
      expect(seeding, 'leg 4: the reference sent a seeding after its Place').toBeGreaterThan(0);
      const t0 = await pauseAndFocusBoard(page);
      await handPlaceAt(page, 'Router', ...CONTESTED);
      await page.waitForTimeout(50);
      await clickCell(page, ...CONTESTED);
      await page.keyboard.press('Escape');
      expect((await readScene(page)).tick, 'leg 4: still paused').toBe(t0);
      const framesAtPlay = frames.length;
      const band = await playAndSettle(page, t0);
      await page.waitForTimeout(500);
      await expectRenderLoopAlive(page, 'leg 4 after Play');
      errs.assertNone('leg 4');
      const s = await readScene(page);
      const routers = s.nodes.filter((n) => n.kind === KIND_ROUTER).length;
      const sentAfterPlay = frames.length - framesAtPlay;
      console.log(
        `leg 4: seeding=${seeding} sentAfterPlay=${sentAfterPlay} routers=${routers} ` +
          `contested=${JSON.stringify(portsAt(s, ...CONTESTED))} ref=${JSON.stringify(portsAt(s, ...REF_UNTURNED))} ` +
          `band=${JSON.stringify(band)}`,
      );
      expect(sentAfterPlay, 'leg 4 WIRE: ONE seeding after Play, never two').toBe(seeding);
      expect(routers, 'leg 4: the reference and the ONE minted Router').toBe(2);
      expect(portsAt(s, ...CONTESTED), 'leg 4 MODEL: ports as the reference').toEqual(
        portsAt(s, ...REF_UNTURNED),
      );
      expect(band, 'leg 4 BAND: only the one true sentence').toEqual([FOOTPRINT_COLLISION]);
    } finally {
      await resumeIfPaused(page);
    }
  });
});
