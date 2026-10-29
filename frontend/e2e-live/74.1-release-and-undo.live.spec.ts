import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  DRAWN_STATE_FRAMES,
  armAndPlaceAt,
  cameraOf,
  clickAt,
  expectRenderLoopAlive,
  newBoard,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  tileKindAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
  restoreHostAfterFailedTest,
} from './support/oracle';
import { CELL } from '../shared/geometry';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';

// 74.1-release-and-undo.live.spec.ts (plan 74.1-20, re-walk gap N3) - ONE Ctrl+Z undoes
// the belt-to-belt join right after a palette or panel button was clicked, on the real
// `dev_render_server`.
//
// ---------------------------------------------------------------------------
// WHAT WAS REPORTED
// ---------------------------------------------------------------------------
//
// Re-walk step N3, 2026-10-04: "good but took 2 ctrl+zs just so you know". The N2 drag
// sends exactly one Dock and records one undo step, so the first press was dropped. The
// two named candidates: the gesture layer's BUTTON / SELECT focus guard returning before
// the undo handler (the palette `Belt` button keeps focus through every canvas gesture),
// and `doUndo`'s availability gate reading a stale value.
//
// ---------------------------------------------------------------------------
// THE LEGS, both the N2 board and the N2 drag, then ONE Ctrl+Z
// ---------------------------------------------------------------------------
//
//   1. The N3 step as written: click the belt panel's heading first, then Ctrl+Z once.
//   2. The same without the heading click: Ctrl+Z straight after the drag.
//   3. A palette button HOLDING focus at the press (keyboard focus, no click).
//
// ---------------------------------------------------------------------------
// AND THE RELEASE (review WR-05, round 4 CR-01): the corner from letting go to the join
// ---------------------------------------------------------------------------
//
// The host ships a docked end's corner only once the Dock folds, and the Dock goes out a
// frame or more after the DrawBelt echoes, so the packet carries route()'s Straight at
// the seam for a few frames after every release. The model oracle reads the PACKET, so
// it cannot see what was drawn in those frames. Legs 4 (S1), 5 (S2), 7 and 8 sample
// EVERY animation frame from the release until well after the belt lands, and grade
// each frame on the SHAPE at the seam: a frame passes only when the preview surfaces
// PLOTTED the expected kind there (`beltPreviewKindAt`, the plotted tile list) or the
// belts layer DREW it there (`beltDrawnKindsOf`). A frame that does neither is counted
// and named, never filtered, and the frames where the packet still says Straight must be
// observed, so the window cannot pass by being missed.
//
// Since plan 84-10 (the 2026-10-09 CI run) legs 4 and 5 start their graded window at the
// turned drag's first sampled frame, before the release: on a two-core runner the DrawBelt
// echo can land before the first frame after the pointerup, so a window that starts at the
// release could hold no pre-echo frame at all. Every frame from there is graded the same way.
//
// WHY THE SHAPE AND NOT A COUNT (review round 4 CR-01). Until plan 74.1-30 the grade
// passed a frame whenever the preview held ANY geometry (`beltPreviewInstructions` above
// zero). On the first frame after every docked release the preview was repainted
// STRAIGHT at the seam (the walk's S1R, 6 of 6 releases), and released while paused it
// stayed straight for the whole pause; a count saw geometry and passed both. Legs 7 and
// 8 are the paused docked releases the walk failed, one belt and two belts.
//
// AT THE KEY PRESS each leg records, from a capture-phase keydown listener that runs
// before the app's own, the focused element's tag and title and the scene's `canUndo`
// (the value App's undo gate mirrors every frame), and prints them as `N3-MEASURE`.
//
// EVERY POINTER FIXTURE MOVES LIKE A HAND: off-centre presses, sub-cell move samples.
// MODEL FIRST, THEN RENDER HEALTH: `watchPageErrors` and `expectRenderLoopAlive` on both.

/** N2's first belt: four cells north. Tail (4,9), Head (4,6). */
const FIRST_CELLS: readonly (readonly [number, number])[] = [
  [4, 9],
  [4, 8],
  [4, 7],
  [4, 6],
];
/** N2's second belt: from the tile just right of the first belt's top, three cells east. */
const SECOND_CELLS: readonly (readonly [number, number])[] = [
  [5, 6],
  [6, 6],
  [7, 6],
];
const FIRST_HEAD = FIRST_CELLS[FIRST_CELLS.length - 1];
const SECOND_TAIL = SECOND_CELLS[0];

const STEPS_PER_CELL = 8;
/** Off-centre press inside the dragged end tile: 9 world px from an undocked end's dot. */
const PRESS_FRAC = [0.7, 0.7] as const;
const DROP_FRAC = [0.4, 0.6] as const;

/** Wire encodings: Axis X=0, Y=1; Dir N=0, E=1, S=2, W=3. */
const CORNER_N_TO_E = { Corner: { from: 0, to: 1 } };
const STRAIGHT_Y = { Straight: { axis: 1 } };
const STRAIGHT_X = { Straight: { axis: 0 } };

function beltAt(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/** The dock set, partners named by role so a keyframe's remint compares equal. */
function joinFacts(scene: SceneFacts): string {
  const first = beltAt(scene, FIRST_HEAD);
  const second = beltAt(scene, SECOND_TAIL);
  if (!first || !second || first.id === second.id) return 'MISSING';
  const name = (id: number): string => (id === first.id ? 'first' : id === second.id ? 'second' : `other:${id}`);
  const fmt = (who: string, b: typeof first): string[] =>
    (b.docks ?? []).map((d) => `${who}.${d.end}->${name(d.node)}`).sort();
  return [...fmt('first', first), ...fmt('second', second)].join(' ');
}

const JOINED = 'first.Head->second second.Tail->first';

/** Both belts present with exactly their drawn cells. */
function cellsFacts(scene: SceneFacts): string {
  const cells = (b: SceneFacts['belts'][number] | undefined): string =>
    b ? b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' ') : 'none';
  return `${scene.belts.length} | ${cells(beltAt(scene, FIRST_HEAD))} | ${cells(beltAt(scene, SECOND_TAIL))}`;
}
const BOTH_BELTS = `2 | ${FIRST_CELLS.map(([x, y]) => `${x},${y}`).join(' ')} | ${SECOND_CELLS.map(([x, y]) => `${x},${y}`).join(' ')}`;

async function cellPoint(
  page: Page,
  cell: readonly [number, number],
  frac: readonly [number, number],
): Promise<{ x: number; y: number }> {
  return screenPoint(page, { x: (cell[0] + frac[0]) * CELL, y: (cell[1] + frac[1]) * CELL });
}

async function drawPlain(page: Page, cells: readonly (readonly [number, number])[]): Promise<void> {
  const start = await cellPoint(page, cells[0], [0.45, 0.55]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await page.mouse.move(pt.x, pt.y, { steps: STEPS_PER_CELL });
  }
  await page.mouse.up();
}

/**
 * The N2 board and the N2 join: an empty board at scale 1, the palette `Belt` button
 * CLICKED (so it is the focused element, as on the manual walkthrough), both belts drawn, Escape,
 * the first belt selected and its top end dot dragged onto the second belt's first tile.
 */
async function n2Join(page: Page): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  await page.getByTitle(/^Draw belts/).click();
  await drawPlain(page, FIRST_CELLS);
  await pollScene(page, (s) => s.belts.length, { message: 'the first belt was drawn' }).toBe(1);
  await drawPlain(page, SECOND_CELLS);
  await pollScene(page, (s) => s.belts.length, { message: 'the second belt was drawn' }).toBe(2);
  await page.keyboard.press('Escape');
  expect(cellsFacts(await readScene(page)), 'both belts, exactly as drawn').toBe(BOTH_BELTS);

  const mid = await cellPoint(page, FIRST_CELLS[1], [0.5, 0.5]);
  await clickAt(page, mid.x, mid.y);
  await expect(page.locator('#fab-belt-config'), 'the first belt is selected').toBeVisible({ timeout: 15_000 });

  const a = await cellPoint(page, FIRST_HEAD, PRESS_FRAC);
  const b = await cellPoint(page, SECOND_TAIL, DROP_FRAC);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: STEPS_PER_CELL });
  await page.mouse.up();
  await pollScene(page, joinFacts, { message: 'N2: the two belts join' }).toBe(JOINED);
  await pollScene(page, (s) => tileKindAt(s, FIRST_HEAD[0], FIRST_HEAD[1]), {
    message: "N2: the first belt's top tile turns north into east",
  }).toEqual(CORNER_N_TO_E);
  expect(tileKindAt(await readScene(page), SECOND_TAIL[0], SECOND_TAIL[1]), "the second belt's first tile stays straight").toEqual(
    STRAIGHT_X,
  );
}

interface N3Measure {
  tag: string | null;
  title: string | null;
  canUndo: boolean | null;
}

/**
 * Arm a capture-phase keydown listener on window that records the FIRST Ctrl+Z only. It
 * runs before the gesture layer's own window listener, so it sees the focus and the
 * availability AT the press.
 */
async function armMeasure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __n3?: unknown;
      __fabrico?: { scene(): { canUndo: boolean } };
    };
    w.__n3 = null;
    window.addEventListener(
      'keydown',
      (e) => {
        // Not `once`: the Control keydown that precedes the z would consume it.
        if (w.__n3 === null && (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
          const el = document.activeElement as HTMLElement | null;
          w.__n3 = {
            tag: el ? el.tagName : null,
            title: el ? el.getAttribute('title') : null,
            canUndo: w.__fabrico ? w.__fabrico.scene().canUndo : null,
          };
        }
      },
      { capture: true },
    );
  });
}

async function readMeasure(page: Page): Promise<N3Measure> {
  return page.evaluate(() => (window as unknown as { __n3: N3Measure }).__n3);
}

/** One Ctrl+Z, then the join must be gone, both belts must stay, and the corner must go. */
async function oneUndoUnjoins(page: Page, leg: string): Promise<void> {
  await armMeasure(page);
  await page.keyboard.press('Control+z');
  const m = await readMeasure(page);
  console.log(`N3-MEASURE ${leg}: ${JSON.stringify(m)}`);
  expect(m, `${leg}: the measurement listener saw the press`).not.toBeNull();
  expect(m.canUndo, `${leg}: an undo step was available at the press`).toBe(true);
  await pollScene(page, joinFacts, {
    message: `${leg}: ONE Ctrl+Z leaves the two belts unjoined (re-walk N3: it used to take two)`,
  }).toBe('');
  const after = await readScene(page);
  expect(cellsFacts(after), `${leg}: both belts stay, exactly as drawn (one undo, not two)`).toBe(BOTH_BELTS);
  expect(tileKindAt(after, FIRST_HEAD[0], FIRST_HEAD[1]), `${leg}: the top tile is straight again`).toEqual(
    STRAIGHT_Y,
  );
}

/** One seam's reads in one animation frame. */
interface SeamRead {
  /** Whether the scene holds the belt whose FIRST tile is this seam. */
  exists: boolean;
  /** The packet's seam kind, as JSON, or 'none' when the belt is not in the scene. */
  model: string;
  /** How many docks the packet carries on that belt. */
  docks: number;
  /** The kind the belts layer DREW at the seam, as JSON, or 'none' (no belt, or no sprite). */
  drawn: string;
  /**
   * The kind the preview surfaces PLOTTED at the seam (`beltPreviewKindAt`, plan 74.1-30),
   * as JSON, or 'none' when no plotted tile covers it.
   */
  previewKind: string;
}

/** One animation frame, as the sampler read it. */
interface SeamFrame {
  /** The preview surfaces' plotted instruction count (`beltPreviewInstructions`). */
  preview: number;
  /** How many belts the scene holds (the paused legs' model-honesty read). */
  belts: number;
  /** One read per sampled seam, in the order the seams were given. */
  seams: SeamRead[];
}

/** One seam's frame, flattened for grading. */
type SeamFlat = SeamRead & { preview: number; belts: number };

/** What `startSeamSampler` leaves on `window`. */
interface SeamRecord {
  frames: SeamFrame[];
  /** Index of the first frame recorded after the FIRST pointerup, -1 before it. */
  upMark: number;
  /** Index of the first frame recorded after EACH pointerup, in order. */
  ups: number[];
  /** Index of the first frame recorded after the Play click, -1 when there was none. */
  resumeMark: number;
  done: boolean;
}

/**
 * Start a per-frame sampler BEFORE the release (review WR-08). Every animation frame it
 * records the preview's plotted instruction count and, for each belt whose FIRST tile is
 * one of `seams`, whether it is in the scene, its packet kind, its dock count, the DRAWN
 * kind and the kind the preview surfaces PLOTTED at that seam. A capture-phase
 * `pointerup` listener marks the first frame after each release, and a capture-phase
 * `click` on the toolbar's Play button marks the first frame after a Resume. Stops 30
 * frames after every seam's belt first carries a dock (`until: 'dock'`) or first exists
 * (`until: 'belt'`), or after 1800 frames.
 *
 * WHY THE REWRITE. The 74.1-20 sampler recorded a frame only once the new belt was in the
 * scene and its grader dropped every frame with nothing drawn, so the frames between the
 * release and the DrawBelt echo, which on the walk showed NOTHING at the seam (S1R), were
 * never graded. Every frame from the pointerup is recorded here, belt or no belt, and
 * since 74.1-30 with the plotted SHAPE at each seam (CR-01).
 */
async function startSeamSampler(
  page: Page,
  seams: ReadonlyArray<readonly [number, number]>,
  until: 'dock' | 'belt',
): Promise<void> {
  await page.evaluate(
    ([cells, stopOn]) => {
      type Hook = {
        scene(): {
          belts: Array<{ id: number; tiles: Array<{ cell_x: number; cell_y: number; kind: unknown }>; docks: unknown[] }>;
        };
        beltDrawnKindsOf(id: number): unknown[] | null;
        beltPreviewInstructions(): number;
        beltPreviewKindAt(cellX: number, cellY: number): unknown;
      };
      const w = window as unknown as { __seam?: SeamRecord; __fabrico?: Hook };
      const rec: SeamRecord = { frames: [], upMark: -1, ups: [], resumeMark: -1, done: false };
      w.__seam = rec;
      window.addEventListener(
        'pointerup',
        () => {
          if (rec.upMark < 0) rec.upMark = rec.frames.length;
          rec.ups.push(rec.frames.length);
        },
        { capture: true },
      );
      window.addEventListener(
        'click',
        (e) => {
          const b = (e.target as Element | null)?.closest?.('button');
          if (b && b.getAttribute('aria-label') === 'Play' && rec.resumeMark < 0) rec.resumeMark = rec.frames.length;
        },
        { capture: true },
      );
      let after = -1;
      const tick = (): void => {
        const hook = w.__fabrico;
        if (hook) {
          const scene = hook.scene();
          let reached = true;
          const reads = cells.map(([sx, sy]) => {
            const b = scene.belts.find((x) => x.tiles.length > 0 && x.tiles[0].cell_x === sx && x.tiles[0].cell_y === sy);
            const kinds = b ? hook.beltDrawnKindsOf(b.id) : null;
            const plotted = hook.beltPreviewKindAt(sx, sy);
            const ok = stopOn === 'dock' ? (b?.docks.length ?? 0) > 0 : b !== undefined;
            if (!ok) reached = false;
            return {
              exists: b !== undefined,
              model: b ? JSON.stringify(b.tiles[0].kind) : 'none',
              docks: b ? b.docks.length : 0,
              drawn: kinds && kinds.length > 0 ? JSON.stringify(kinds[0]) : 'none',
              previewKind: plotted === null || plotted === undefined ? 'none' : JSON.stringify(plotted),
            };
          });
          rec.frames.push({ preview: hook.beltPreviewInstructions(), belts: scene.belts.length, seams: reads });
          if (rec.upMark >= 0 && reached && after < 0) after = 0;
        }
        if (after >= 0) after++;
        if (after > 30 || rec.frames.length > 1800) {
          rec.done = true;
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [seams.map((c) => [c[0], c[1]] as [number, number]), until] as const,
  );
}

async function readSeamRecord(page: Page, leg: string): Promise<SeamRecord> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __seam?: SeamRecord }).__seam?.done === true), {
      message: `${leg}: the sampler finished (the belt landed and 30 frames passed)`,
      timeout: 30_000,
    })
    .toBe(true);
  return page.evaluate(() => (window as unknown as { __seam: SeamRecord }).__seam);
}

/** Every frame of one seam, flattened with the frame's preview count and belt count. */
function seamFrames(rec: SeamRecord, seam: number): SeamFlat[] {
  return rec.frames.map((f) => ({ ...f.seams[seam], preview: f.preview, belts: f.belts }));
}

/** Whether one frame shows `want` at the seam: plotted by a preview surface, or drawn. */
function showsSeam(x: SeamFlat, want: string): boolean {
  return (x.preview > 0 && x.previewKind === want) || x.drawn === want;
}

/** Wait until `n` frames have been sampled after the pointerup numbered `up` (0 = first). */
async function framesAfterRelease(page: Page, up: number, n: number, leg: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((k) => {
          const r = (window as unknown as { __seam: SeamRecord }).__seam;
          return r.ups.length > k ? r.frames.length - r.ups[k] : 0;
        }, up),
      // The cap is the frames' own budget at the `FLOOR_FPS` floor (D-12): the midday 2026-10-13 CI run drew
      // 54 of leg 6's 60 frames inside the ten seconds this poll used to allow. It is added to the
      // test's limit, so this message fires before the test's timeout can (review 84 WR-03).
      {
        message: `${leg}: ${n} frames sampled after the release, still paused`,
        timeout: addWaitBudget(frameBudgetMs(n), `${leg} frames after the release`),
      },
    )
    .toBeGreaterThanOrEqual(n);
}

/**
 * Grade EVERY frame of seam number `seam` from frame `from` (default: the first
 * pointerup) on its SHAPE (review WR-08, round 4 CR-01). A frame passes only when a
 * preview surface PLOTTED `seamKind` at the seam or the belts layer DREW it there; every
 * other frame is counted and the first is named with its index, never filtered out.
 * Returns the graded frames.
 */
function expectSeamShapeOnEveryFrame(
  rec: SeamRecord,
  seamKind: unknown,
  leg: string,
  seam = 0,
  from = rec.upMark,
): SeamFlat[] {
  expect(rec.upMark, `${leg}: the sampler saw the pointerup`).toBeGreaterThanOrEqual(0);
  expect(from, `${leg}: the release this seam is graded from was seen`).toBeGreaterThanOrEqual(0);
  const want = JSON.stringify(seamKind);
  const graded = seamFrames(rec, seam).slice(from);
  const failing = graded.map((x, i) => ({ i, x })).filter(({ x }) => !showsSeam(x, want));
  const preEcho = graded.filter((x) => !x.exists);
  console.log(
    `SEAM-SHAPE ${leg}: graded=${graded.length} preEcho=${preEcho.length} failing=${failing.length}` +
      (failing.length > 0 ? ` firstFailing=${failing[0].i} ${JSON.stringify(failing[0].x)}` : ''),
  );
  // Asserted only when grading starts at or after the release (review 84 WR-04). Graded from
  // before it (legs 4 and 5, from the turned drag), every drag frame precedes the echo because
  // the belt is not in the model until it lands, so the count could not fail there; those legs
  // assert their own pre-release frames instead and name the release-to-echo window.
  if (from >= rec.upMark) {
    expect(
      preEcho.length,
      `${leg}: NON-VACUITY: at least one graded frame falls before the DrawBelt echo`,
    ).toBeGreaterThan(0);
  }
  expect(
    failing.length,
    `${leg}: EVERY frame from the release shows ${want} at the seam, plotted by the preview or drawn ` +
      `by the belts layer; the first frame that does not is graded frame ${failing[0]?.i ?? -1} (the ` +
      `release is graded frame ${(rec.ups.find((u) => u >= from) ?? -1) - from}): ${JSON.stringify(failing[0]?.x ?? null)} (S1R, CR-01)`,
  ).toBe(0);
  expect(
    graded.filter((x) => x.drawn !== 'none' && x.drawn !== want),
    `${leg}: no frame draws the seam as anything but ${want} (never the T)`,
  ).toEqual([]);
  return graded;
}

/**
 * Release the held pointer once the sampler has recorded at least one frame of the turned
 * drag (plan 84-10, the 2026-10-09 CI run). Legs 4 and 5 grade from the drag's last frame
 * before the release: on a two-core runner the DrawBelt echo can land before the first
 * frame after the pointerup (q100: 2 of 3 runs, `preEcho=0`, CI the same), so a window that
 * starts at the release can hold no frame before the echo at all. Frames of the turned drag
 * fall before the echo at any machine speed, and each is graded on the same shape.
 */
async function releaseAfterASampledFrame(page: Page, leg: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __seam?: SeamRecord }).__seam?.frames.length ?? 0), {
      message: `${leg}: the sampler recorded a frame of the turned drag before the release`,
    })
    .toBeGreaterThan(0);
  await page.mouse.up();
}

/**
 * Wait for the sampler, then grade every frame from the turned drag's first sampled frame
 * (before the release) to 30 frames after the dock.
 */
async function expectNoTBetweenReleaseAndDock(page: Page, corner: unknown, leg: string): Promise<void> {
  const rec = await readSeamRecord(page, leg);
  const graded = expectSeamShapeOnEveryFrame(rec, corner, leg, 0, 0);
  const preRelease = rec.upMark;
  const afterReleasePreEcho = seamFrames(rec, 0)
    .slice(rec.upMark)
    .filter((x) => !x.exists).length;
  // The release-to-echo window is graded with every other frame when it exists, and named when
  // it did not (review 84 WR-04): on a slow page the echo can beat the first frame after the
  // pointerup, so its size is reported, not asserted.
  console.log(
    `WR05-WINDOW ${leg}: preRelease=${preRelease} afterReleasePreEcho=${afterReleasePreEcho}` +
      (afterReleasePreEcho === 0 ? ' (echo beat the first post-release frame; window not exercised)' : ''),
  );
  expect(preRelease, `${leg}: at least one graded frame is the turned drag before the release`).toBeGreaterThan(0);
  const preDock = graded.filter((x) => x.exists && x.docks === 0 && x.drawn !== 'none');
  const postDock = graded.filter((x) => x.docks > 0);
  console.log(`WR05-FRAMES ${leg}: preDock=${preDock.length} postDock=${postDock.length}`);
  expect(preDock.length, `${leg}: NON-VACUITY: at least one frame drew the belt before its dock landed`).toBeGreaterThan(0);
  expect(
    postDock.filter((x) => x.drawn !== 'none').length,
    `${leg}: NON-VACUITY: frames after the dock landed were drawn`,
  ).toBeGreaterThan(0);
  for (const x of preDock) {
    expect(JSON.parse(x.model), `${leg}: before the dock the PACKET still says Straight (the T this leg guards)`).toEqual(
      STRAIGHT_Y,
    );
  }
  for (const x of postDock) {
    expect(JSON.parse(x.model), `${leg}: after the dock the packet's own seam is the corner`).toEqual(corner);
  }
}

/** Move through `cells` in sub-cell steps, the pointer already down. */
async function moveThrough(page: Page, cells: readonly (readonly [number, number])[]): Promise<void> {
  for (const [cx, cy] of cells) {
    const pt = await screenCellCentre(page, cx, cy);
    await page.mouse.move(pt.x, pt.y, { steps: STEPS_PER_CELL });
  }
}

async function emptyBoardAtScale1(page: Page): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
}

// THE SHARED HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12): this spec pauses the
// one shared host, and a test that times out while paused never reaches its `finally`.
// `restoreHostAfterFailedTest` puts the host back to running after a failed or timed-out
// test only, logs `HOST RESTORED after <title>`, and never changes that test's verdict.
test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe.configure({ mode: 'serial' });

test.describe('N3 on the real host: one Ctrl+Z undoes the join', () => {
  test('1: after clicking the belt panel heading, ONE Ctrl+Z undoes the join', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n2Join(page);

    await page.locator('#fab-config-heading').click();
    await oneUndoUnjoins(page, 'leg 1 (heading clicked)');

    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });

  test('2: without the heading click, ONE Ctrl+Z straight after the drag undoes the join', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n2Join(page);

    await oneUndoUnjoins(page, 'leg 2 (no heading click)');

    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });

  test('3: with a palette button HOLDING focus (keyboard focus, as IX-10 leaves it), ONE Ctrl+Z undoes the join', async ({
    page,
  }) => {
    // Legs 1 and 2 measured BODY focused at the press on this host: a canvas press moves
    // focus off the clicked palette button in Chromium. This leg puts focus ON a button
    // the way the keyboard does (focus, not a click, so no tool arms), which is the state
    // the gesture layer's BUTTON / SELECT guard used to swallow Ctrl+Z in.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n2Join(page);

    const belt = page.getByTitle(/^Draw belts/);
    await belt.focus();
    expect(
      await page.evaluate(() => document.activeElement?.tagName ?? null),
      'NON-VACUITY: a BUTTON holds focus at the press',
    ).toBe('BUTTON');
    await oneUndoUnjoins(page, 'leg 3 (palette button focused)');
    expect((await readMeasure(page)).tag, 'leg 3: the press was measured with the button focused').toBe('BUTTON');
    await expect(belt, 'leg 3: focusing the button armed nothing').toHaveAttribute('aria-pressed', 'false');

    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });
});

test.describe('WR-05 on the real host: the corner is drawn from the release to the dock echo', () => {
  test('4: S1, a belt end pressed and turned north at once never draws the T', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    // Belt A east, Head (7,6), doorstep (8,6).
    await page.getByTitle(/^Draw belts/).click();
    await drawPlain(page, [
      [5, 6],
      [6, 6],
      [7, 6],
    ]);
    await pollScene(page, (s) => s.belts.length, { message: 'belt A was drawn' }).toBe(1);

    const seam = [8, 6] as const;
    const press = await cellPoint(page, seam, [0.6, 0.4]);
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await moveThrough(page, [
      [8, 5],
      [8, 4],
    ]);
    await startSeamSampler(page, [seam], 'dock');
    await releaseAfterASampledFrame(page, 'leg 4 (S1)');
    await expectNoTBetweenReleaseAndDock(page, { Corner: { from: 1, to: 0 } }, 'leg 4 (S1)');

    await expectRenderLoopAlive(page, 'after leg 4');
    errs.assertNone('leg 4');
  });

  test('5: S2, a Source Out pressed and turned at once never draws the T', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    await armAndPlaceAt(page, 'Source', 4, 5);
    await pollScene(page, (s) => s.nodes.length, { message: 'the Source was placed' }).toBe(1);
    const out = (await readScene(page)).nodes[0].ports.find((p) => p.role === 1 && p.medium === 0);
    expect(out, 'NON-VACUITY: the Source has a Mechanical Out').toBeDefined();
    const step = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const;
    const side = out!.side;
    const seam = [out!.cell_x + step[side][0], out!.cell_y + step[side][1]] as const;
    // Turn clockwise off the port's facing at once: fed `side`, leaving `side + 1`.
    const turn = (side + 1) % 4;
    const c1 = [seam[0] + step[turn][0], seam[1] + step[turn][1]] as const;
    const c2 = [c1[0] + step[turn][0], c1[1] + step[turn][1]] as const;

    // A vertical turn leaves the run on axis Y: the packet's pre-dock kind is Straight{Y}
    // only when `turn` is N or S, which it is for an Out facing E or W (the Source's).
    expect(turn % 2, 'NON-VACUITY: the run leaves on the Y axis (an E or W facing Out)').toBe(0);

    await page.getByTitle(/^Draw belts/).click();
    const press = await cellPoint(page, seam, [0.6, 0.4]);
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    await moveThrough(page, [c1, c2]);
    await startSeamSampler(page, [seam], 'dock');
    await releaseAfterASampledFrame(page, 'leg 5 (S2)');
    await expectNoTBetweenReleaseAndDock(page, { Corner: { from: side, to: turn } }, 'leg 5 (S2)');

    await expectRenderLoopAlive(page, 'after leg 5');
    errs.assertNone('leg 5');
  });
});

/** Leg 6's belt: four cells east on empty floor, no port anywhere near. */
const PAUSED_CELLS: readonly (readonly [number, number])[] = [
  [5, 9],
  [6, 9],
  [7, 9],
  [8, 9],
];

/** The toolbar's transport toggle: its accessible name is `Pause` while playing, `Play` while paused. */
function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** Press Play if the toolbar offers it, then wait for the tick to advance. */
async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label')) === 'Play') await transport(page).click();
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > t0, { message: 'the sim runs again', timeout: 10_000 }).toBe(true);
}

/**
 * Pause from the toolbar and return the tick the host stopped at. The toggle flips before
 * the host has folded the pause: a tick already in flight can still land (measured: 59
 * then 60), so this waits until two scene reads 200 ms apart agree.
 */
async function pauseAndSettle(page: Page, leg: string): Promise<number> {
  await transport(page).click();
  await expect(transport(page), `${leg}: the sim is paused (the toggle offers Play)`).toHaveAttribute('aria-label', 'Play');
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

/** Every belt in the scene, as its cell list. */
function beltCellLists(scene: SceneFacts): string[] {
  return scene.belts.map((b) => b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' '));
}

/** Leg 7 and 8's belt A: three cells east, Head (7,6), doorstep (8,6), as in leg 4. */
const A_CELLS: readonly (readonly [number, number])[] = [
  [5, 6],
  [6, 6],
  [7, 6],
];
const A_LIST = A_CELLS.map(([x, y]) => `${x},${y}`).join(' ');
/** Belt B off A's doorstep: (8,6), then north through (8,5) to (8,4). */
const B_SEAM = [8, 6] as const;
const B_CORNER = { Corner: { from: 1, to: 0 } };

/** Press A's doorstep off-centre and turn north at once, the pointer left down. */
async function pressBAndTurn(page: Page): Promise<void> {
  const press = await cellPoint(page, B_SEAM, [0.6, 0.4]);
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await moveThrough(page, [
    [8, 5],
    [8, 4],
  ]);
}

/** Whether the scene's belt starting at `seam` carries a Tail dock. */
function tailDocked(scene: SceneFacts, seam: readonly [number, number]): boolean {
  const b = scene.belts.find((x) => x.tiles.length > 0 && x.tiles[0].cell_x === seam[0] && x.tiles[0].cell_y === seam[1]);
  return !!b && (b.docks ?? []).some((d) => d.end === 'Tail');
}

/** The kind the belts layer DREW on the first tile of the belt starting at `seam`, as JSON. */
async function drawnSeamKind(page: Page, seam: readonly [number, number]): Promise<string> {
  return page.evaluate(([sx, sy]) => {
    const hook = (
      window as unknown as {
        __fabrico: {
          scene(): { belts: Array<{ id: number; tiles: Array<{ cell_x: number; cell_y: number }> }> };
          beltDrawnKindsOf(id: number): unknown[] | null;
        };
      }
    ).__fabrico;
    const b = hook.scene().belts.find((x) => x.tiles.length > 0 && x.tiles[0].cell_x === sx && x.tiles[0].cell_y === sy);
    const kinds = b ? hook.beltDrawnKindsOf(b.id) : null;
    return kinds && kinds.length > 0 ? JSON.stringify(kinds[0]) : 'none';
  }, [seam[0], seam[1]] as const);
}

test.describe('WR-08 on the real host: the preview holds from the release until the belt is drawn', () => {
  test('6: a plain belt drawn while PAUSED shows its preview until Resume, then the belt, never nothing', async ({
    page,
  }) => {
    // THE CERTAIN RED (plan 74.1-26). A paused host buffers the DrawBelt until Resume, so
    // the frames between the release and the echo are not a matter of timing: there are
    // about a second's worth. Every one of them must show the preview, while the decoded
    // scene holds no belt (the held picture never leaks into the model), and every frame
    // from Resume to 30 frames after the belt exists must show the preview or the belt.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    await resumeIfPaused(page);
    try {
      await page.getByTitle(/^Draw belts/).click();
      const pausedAt = await pauseAndSettle(page, 'leg 6');

      const start = await cellPoint(page, PAUSED_CELLS[0], [0.45, 0.55]);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await moveThrough(page, PAUSED_CELLS.slice(1));
      await startSeamSampler(page, [PAUSED_CELLS[0]], 'belt');
      await page.mouse.up();

      // Hold about a second: 60 frames recorded after the release, read off the sampler
      // rather than slept for.
      await framesAfterRelease(page, 0, 60, 'leg 6');
      expect((await readScene(page)).tick, 'leg 6: the tick did not advance while paused').toBe(pausedAt);
      await transport(page).click();
      await expect(transport(page), 'the sim runs again (the toggle offers Pause)').toHaveAttribute('aria-label', 'Pause');

      const rec = await readSeamRecord(page, 'leg 6 (paused)');
      expect(rec.resumeMark, 'leg 6: the sampler saw the Play click').toBeGreaterThan(rec.upMark);
      const held = seamFrames(rec, 0).slice(rec.upMark, rec.resumeMark);
      console.log(
        `WR08-PAUSED leg 6: held=${held.length} previewShown=${held.filter((x) => x.preview > 0).length} ` +
          `beltsInScene=${held.filter((x) => x.belts > 0).length}`,
      );
      expect(held.length, 'leg 6: NON-VACUITY: about a second of paused frames').toBeGreaterThanOrEqual(60);
      expect(
        held.filter((x) => x.belts !== 0).length,
        'leg 6: the decoded scene holds NO belt on any paused frame (the held preview is render-only)',
      ).toBe(0);
      expect(
        held.filter((x) => x.preview === 0).length,
        'leg 6: EVERY paused frame after the release shows the preview of the committed belt',
      ).toBe(0);
      expectSeamShapeOnEveryFrame(rec, STRAIGHT_X, 'leg 6 (paused)');
      expect(
        seamFrames(rec, 0)
          .slice(rec.upMark)
          .some((x) => x.exists && x.drawn === JSON.stringify(STRAIGHT_X)),
        'leg 6: NON-VACUITY: the belt was drawn after Resume',
      ).toBe(true);
      expect(beltCellLists(await readScene(page)), 'leg 6: exactly the drawn belt landed').toEqual([
        PAUSED_CELLS.map(([x, y]) => `${x},${y}`).join(' '),
      ]);
    } finally {
      // Pause is HOST-global: never leave the shared host paused for the next spec.
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }

    await expectRenderLoopAlive(page, 'after leg 6');
    errs.assertNone('leg 6');
  });

  test('7: a docked belt released while PAUSED holds its corner until Resume, then lands docked', async ({ page }) => {
    // THE WALK'S PAUSED S1R CASE (plan 74.1-30). Released onto a belt Head's doorstep
    // while paused, the held picture of the committed belt must show the CORNER at the
    // seam on every paused frame; the walk saw it straight for the whole pause. The
    // decoded scene holds only belt A until Resume, and on Play the belt lands with its
    // Tail dock and the drawn corner.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    await resumeIfPaused(page);
    try {
      await page.getByTitle(/^Draw belts/).click();
      await drawPlain(page, A_CELLS);
      await pollScene(page, (s) => s.belts.length, { message: 'leg 7: belt A was drawn' }).toBe(1);
      const pausedAt = await pauseAndSettle(page, 'leg 7');

      await pressBAndTurn(page);
      await startSeamSampler(page, [B_SEAM], 'dock');
      await page.mouse.up();
      await framesAfterRelease(page, 0, 60, 'leg 7');
      const pausedScene = await readScene(page);
      expect(pausedScene.tick, 'leg 7: the tick did not advance while paused').toBe(pausedAt);
      expect(beltCellLists(pausedScene), 'leg 7: the scene holds exactly belt A while paused').toEqual([A_LIST]);
      await transport(page).click();
      await expect(transport(page), 'the sim runs again (the toggle offers Pause)').toHaveAttribute('aria-label', 'Pause');

      const rec = await readSeamRecord(page, 'leg 7 (paused docked)');
      expect(rec.resumeMark, 'leg 7: the sampler saw the Play click').toBeGreaterThan(rec.upMark);
      const want = JSON.stringify(B_CORNER);
      const held = seamFrames(rec, 0).slice(rec.upMark, rec.resumeMark);
      const heldBad = held.map((x, i) => ({ i, x })).filter(({ x }) => !(x.preview > 0 && x.previewKind === want));
      console.log(
        `S1R-PAUSED leg 7: held=${held.length} cornerPlotted=${held.length - heldBad.length} ` +
          `beltsInScene=${held.filter((x) => x.belts !== 1 || x.exists).length}` +
          (heldBad.length > 0 ? ` firstBad=${heldBad[0].i} ${JSON.stringify(heldBad[0].x)}` : ''),
      );
      expect(held.length, 'leg 7: NON-VACUITY: about a second of paused frames').toBeGreaterThanOrEqual(60);
      expect(
        held.filter((x) => x.belts !== 1 || x.exists).length,
        'leg 7: the decoded scene holds only belt A on every paused frame (the held picture is render-only)',
      ).toBe(0);
      expect(
        heldBad.length,
        `leg 7: EVERY paused frame plots ${want} at the seam; the first that does not is frame ` +
          `${heldBad[0]?.i ?? -1} after the release: ${JSON.stringify(heldBad[0]?.x ?? null)} (S1R paused)`,
      ).toBe(0);
      expectSeamShapeOnEveryFrame(rec, B_CORNER, 'leg 7 (paused docked)');
      await pollScene(page, (s) => tailDocked(s, B_SEAM), { message: 'leg 7: belt B landed with its Tail dock' }).toBe(true);
      expect(await drawnSeamKind(page, B_SEAM), 'leg 7: the landed belt is drawn with the corner').toBe(want);
    } finally {
      // Pause is HOST-global: never leave the shared host paused for the next spec.
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }

    await expectRenderLoopAlive(page, 'after leg 7');
    errs.assertNone('leg 7');
  });

  test('8: two docked belts drawn while PAUSED both hold their corners and both land docked', async ({ page }) => {
    // PAUSE-SECOND-DRAW (plan 74.1-30). While paused no DrawBelt echoes, so before this
    // plan a second docked draw overwrote the first belt's single follow-up slot: the
    // first belt's picture went and, on Play, it landed with no Dock. Belt B off A's
    // doorstep and belt C off a Source's Out are drawn in one pause; each must hold its
    // own corner until Resume, and each must land with its own Tail dock.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScale1(page);
    await resumeIfPaused(page);
    try {
      await armAndPlaceAt(page, 'Source', 2, 9);
      await pollScene(page, (s) => s.nodes.length, { message: 'leg 8: the Source was placed' }).toBe(1);
      const out = (await readScene(page)).nodes[0].ports.find((p) => p.role === 1 && p.medium === 0);
      expect(out, 'leg 8: NON-VACUITY: the Source has a Mechanical Out').toBeDefined();
      const step = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const;
      const side = out!.side;
      expect(side % 2, 'leg 8: NON-VACUITY: the Out faces E or W, so a turn south is a corner').toBe(1);
      const cSeam = [out!.cell_x + step[side][0], out!.cell_y + step[side][1]] as const;
      // Turn south at once, away from belts A and B (rows 4 to 6).
      const c1 = [cSeam[0], cSeam[1] + 1] as const;
      const c2 = [cSeam[0], cSeam[1] + 2] as const;
      const cCorner = { Corner: { from: side, to: 2 } };

      await page.getByTitle(/^Draw belts/).click();
      await drawPlain(page, A_CELLS);
      await pollScene(page, (s) => s.belts.length, { message: 'leg 8: belt A was drawn' }).toBe(1);
      const pausedAt = await pauseAndSettle(page, 'leg 8');

      await pressBAndTurn(page);
      await startSeamSampler(page, [B_SEAM, cSeam], 'belt');
      await page.mouse.up();
      const cPress = await cellPoint(page, cSeam, [0.6, 0.4]);
      await page.mouse.move(cPress.x, cPress.y);
      await page.mouse.down();
      await moveThrough(page, [c1, c2]);
      await page.mouse.up();
      await framesAfterRelease(page, 1, 60, 'leg 8');
      const pausedScene = await readScene(page);
      expect(pausedScene.tick, 'leg 8: the tick did not advance while paused').toBe(pausedAt);
      expect(beltCellLists(pausedScene), 'leg 8: the scene holds exactly belt A while paused').toEqual([A_LIST]);
      await transport(page).click();
      await expect(transport(page), 'the sim runs again (the toggle offers Pause)').toHaveAttribute('aria-label', 'Pause');

      const rec = await readSeamRecord(page, 'leg 8 (two paused docked)');
      expect(rec.ups.length, 'leg 8: the sampler saw both releases').toBeGreaterThanOrEqual(2);
      expect(rec.resumeMark, 'leg 8: the sampler saw the Play click').toBeGreaterThan(rec.ups[1]);
      const wantB = JSON.stringify(B_CORNER);
      const bAfterC = seamFrames(rec, 0).slice(rec.ups[1], rec.resumeMark);
      const bGone = bAfterC.map((x, i) => ({ i, x })).filter(({ x }) => !(x.preview > 0 && x.previewKind === wantB));
      console.log(
        `PAUSE-SECOND-DRAW leg 8: bAfterC=${bAfterC.length} bStillPlotted=${bAfterC.length - bGone.length}` +
          (bGone.length > 0 ? ` firstGone=${bGone[0].i} ${JSON.stringify(bGone[0].x)}` : ''),
      );
      expect(bAfterC.length, "leg 8: NON-VACUITY: paused frames after C's release").toBeGreaterThanOrEqual(60);
      expect(
        bGone.length,
        `leg 8: after C's release B's picture is still plotted with ${wantB}; the first frame without it is ` +
          `${bGone[0]?.i ?? -1} after C's release: ${JSON.stringify(bGone[0]?.x ?? null)}`,
      ).toBe(0);
      expectSeamShapeOnEveryFrame(rec, B_CORNER, 'leg 8 (belt B)', 0, rec.ups[0]);
      expectSeamShapeOnEveryFrame(rec, cCorner, 'leg 8 (belt C)', 1, rec.ups[1]);

      await pollScene(page, (s) => [tailDocked(s, B_SEAM), tailDocked(s, cSeam)], {
        message: 'leg 8: within 5 s of Resume both belts exist and each carries its Tail dock',
        timeout: 5_000,
      }).toEqual([true, true]);
      await expect
        .poll(async () => [await drawnSeamKind(page, B_SEAM), await drawnSeamKind(page, cSeam)], {
          message: 'leg 8: each seam is drawn as its corner',
          timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'leg 8 seams drawn as corners poll'),
        })
        .toEqual([wantB, JSON.stringify(cCorner)]);
    } finally {
      // Pause is HOST-global: never leave the shared host paused for the next spec.
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }

    await expectRenderLoopAlive(page, 'after leg 8');
    errs.assertNone('leg 8');
  });
});
