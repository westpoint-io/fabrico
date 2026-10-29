import { test, expect, type Page } from '@playwright/test';
import {
  applyConfig,
  beltEndInstructionsOn,
  cameraOf,
  deselectViaEmptyCell,
  drawBeltThroughCells,
  drawOffloadBelt,
  expectRenderLoopAlive,
  fillPanelField,
  handPlaceAt,
  newBoard,
  nodeAtAnchor,
  nubAnchor,
  outwardStep,
  pointerTravel,
  pollScene,
  pressSegment,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  restoreHostAfterFailedTest,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';

// 88-belt-drawn-after-pause.live.spec.ts (plan 88-06, BELT-05, phase 88 success criterion 3, D-06,
// D-07, research Pitfall 7) - a docked belt drawn just after Pause keeps its dock through the
// pause's drain and lands docked on Play. On the REAL host (dev_render_server, real Core ->
// RenderProducer -> postcard -> WS). Zero mocks, zero injected packets: every machine comes off
// the palette by hand, every belt is drawn with the Belt tool, the board is paused and played
// from the toolbar.
//
// ---------------------------------------------------------------------------
// THE DEFECT (todo 2026-10-06-belt-follow-up-ttl-expires-during-pause-drain)
// ---------------------------------------------------------------------------
//
// Pause puts the host in its drain: it keeps ticking with input held until nothing is in
// flight and no belt slot is occupied, or for `MAX_SETTLE_TICKS` (512, `sim_loop.rs`). A docked
// draw released early in the drain waits in the host's queue until Play. Until plan 88-06 the
// client's follow-up for that draw (the Docks it owes once the belt exists, its held picture
// and its predicted seam) expired 120 ticks after the release, on the premise that "a paused
// sim never expires it". A draining pause does advance the tick, so on a busy board the held
// corner went while still paused, and on Play the belt landed with no Dock and no message.
//
// THE RULING (D-06, D-07): a held belt is keyed by its DrawBelt's gesture id and ends on its own
// verdict. The accept names the minted belt and its generation, and the owed Docks go out
// addressed to it once a packet holds that belt. The fallback for a verdict that never comes,
// and the predicted seam's own expiry, count only ticks run while playing and restart at
// Resume.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE DRAIN. An empty board at zoom 1. A palette Source on a Timer feeds a belt released on
//      plain floor, run until items rest on it, so the pause drains for the host's whole budget
//      (Pitfall 7: a board holding items never settles). A second Source and a Sink are placed
//      for a docked draw that turns at once off the Source's Out. The draw is walked while the
//      board plays and Pause lands just before the button comes up (Space on the focused
//      toolbar toggle, as `74.1-paused-edits` leg 6 does since plan 84-13: a hand walking the
//      run after Pause could outlast the host's whole drain budget at a slow frame rate), so the
//      release is a paused draw on a host that has just begun its drain (the tick is asserted to
//      advance across the release). The board is held paused until the tick stands at least
//      `DRAINED_PAST` (121) ticks past the release, one more than the old 120-tick expiry, so a
//      quiet board that froze early cannot pass vacuously. Then Play. Graded on EVERY sampled
//      frame from the release to 30 frames after the belt carries both docks: the corner at the
//      Tail seam is plotted by the held picture or drawn by the belts layer. Then the belt is in
//      the scene docked at both ends, its seam drawn as the corner, and its end marks drawn for
//      two docks (more end instructions than the one-dock belt beside it).
//   2. AN UNDO FIRST (D-06, the keyframe half). An empty board: a Source X placed first, then the
//      docked pair and a one-dock reference belt, then X deleted, undone and redone while
//      playing (the Redo's remint packs the handles without X), so the Undo below puts X back
//      ahead of the pair in the host's handle order and moves the pair to new handles (asserted).
//      Pause until the host stops; Ctrl+Z (sent,
//      queued: the host applies it on Play); then the docked draw between the pair, released on
//      the paused board, which still shows the pre-Undo handles. On Play the Undo's keyframe
//      reaches the client before the belt does, and the host mints the belt in the new table.
//      Until plan 88-06 that keyframe ended every held belt, so the belt landed with no Dock and
//      no message. The draw-then-Ctrl+Z order cannot keep the belt (the Undo would take the
//      belt itself), so the leg takes the order that can. Graded as leg 1, plus X back.
//
// WHAT IS GRADED IS WHAT IS DRAWN (memory fabrico-model-oracle-blindspot). The per-frame read is
// `window.__fabrico.beltPreviewKindAt` (the kind the held-picture surface plotted at the seam)
// and `beltDrawnKindsOf` (the kind the belts layer drew), never the model alone; the docks are
// read off the model AND off the end marks' Graphics (`beltEndInstructionsOn`). Render health in
// every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` on a ticking board after
// Play, and the watcher's `assertNone`.
//
// Pause is HOST-global: each leg presses Play again in a `finally`, and a failed test restores
// the shared host (`restoreHostAfterFailedTest`).
//
// RED FIRST (88-EVIDENCE.md `## Plan 88-06`): served from the plan's start revision, leg 1 read
// red: the held corner went missing mid-drain and the belt landed with no dock.

/** One more drained tick than the follow-up's old expiry (`ECHO_TTL_TICKS`, 120). */
const DRAINED_PAST = 121;
/** `fabrico_core` `SLOTS_PER_TILE`. */
const SLOTS_PER_TILE = 4;
const SOURCE_KIND = 0;
const SINK_KIND = 7;
const MEDIUM_MECHANICAL = 0;
/** The backlog Source's Timer interval in ticks: it fills its belt's free head within a second. */
const BACKLOG_INTERVAL = '4';
/** Frames graded past the frame the belt first carries both docks. */
const AFTER_DOCK_FRAMES = 30;
/**
 * Frames the sampler waits, once the belt is in the scene, for both its docks before it stops
 * anyway, so a belt that lands undocked is graded on what was drawn rather than timing out.
 * The Docks follow the belt's own packet within a few ticks; this is three times the graded tail.
 */
const LANDED_GRACE_FRAMES = 90;
/** The most frames the sampler keeps; a stop, never a pass. */
const MAX_FRAMES = 6000;
/** Frames leg 1 waits, after the release, for the page to draw the first one it grades. */
const FRAMES_AFTER_RELEASE = 1;

/** The backlog: a Source at (3,12) on a Timer and its offload belt east to a free head. */
const BACKLOG_SOURCE: readonly [number, number] = [3, 12];
const BACKLOG_CELLS: readonly (readonly [number, number])[] = [
  [4, 12],
  [5, 12],
  [6, 12],
];
/** An empty cell clicked to drop the backlog Source's selection. */
const EMPTY_CELL: readonly [number, number] = [12, 9];
/** The docked pair: a Source at (4,5), Out east, and a Sink at (7,6), In west. */
const PAIR_SOURCE: readonly [number, number] = [4, 5];
const PAIR_SINK: readonly [number, number] = [7, 6];
/** The docked draw: off the Out's doorstep (5,5), south at once, then east into the Sink. */
const PAIR_CELLS: readonly (readonly [number, number])[] = [
  [5, 5],
  [5, 6],
  [6, 6],
];
const SEAM = PAIR_CELLS[0];
/** The Tail seam docked to an east-facing Out and turned south: from E (1) to S (2). */
const SEAM_CORNER = { Corner: { from: 1, to: 2 } };
/** Leg 2's Source X, placed first and deleted, so the paused Undo puts it back. */
const X_AT: readonly [number, number] = [10, 3];
/** Leg 2's reference Source and its one-dock belt to a free head. */
const REF_SOURCE: readonly [number, number] = [3, 12];
const REF_CELLS: readonly (readonly [number, number])[] = [
  [4, 12],
  [5, 12],
];
/** `STATUS_COPY.editsQueued`, transcribed, not imported. */
const EDITS_QUEUED = 'Paused - edits queued until Play';

/** The board generation of the packet on screen (`window.__fabrico.scene().generation`). */
async function generationOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { scene(): { generation: number } } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    return hook.scene().generation;
  });
}

/** The toolbar's status row. */
async function statusText(page: Page): Promise<string> {
  return ((await page.locator('header [role="status"]').first().textContent()) ?? '').trim();
}

/** Pause from the toolbar and wait until the host stops ticking (two reads in a row agree). */
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
      {
        message: `${leg}: the host stopped ticking`,
        intervals: [200],
        timeout: addWaitBudget(tickBudgetMs(4 * DRAINED_PAST), `${leg}: the paused host settles`),
      },
    )
    .toBe(true);
  return pausedAt;
}

function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label').catch(() => null)) === 'Play') {
    await transport(page).click();
  }
}

/** The belt whose first tile is `cell`, or undefined. */
function beltFrom(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.length > 0 && b.tiles[0].cell_x === cell[0] && b.tiles[0].cell_y === cell[1]);
}

/** The machine of `kind` seated at `cell`, or undefined. */
function machineAt(scene: SceneFacts, cell: readonly [number, number], kind: number) {
  const n = nodeAtAnchor(scene, cell[0], cell[1]);
  return n && n.kind === kind ? n : undefined;
}

/** The port of `node` with `role` on the Mechanical medium. */
function portOf(node: SceneFacts['nodes'][number], role: number): PortFacts {
  const p = node.ports.find((x) => x.role === role && x.medium === MEDIUM_MECHANICAL);
  expect(p, `NON-VACUITY: the machine at ${node.cells[0]} has a Mechanical port of role ${role}`).toBeDefined();
  return p as PortFacts;
}

/** An empty board at zoom 1. */
async function emptyBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'zoom 1').toBe(1);
}

/**
 * The docked draw of `drawBeltThroughCells`, the oracle's one press rule (the doorstep's centre,
 * the run's cell centres, the release on the In nub's anchor), with Pause pressed just before the
 * button comes up: Space on the toolbar toggle, focused after the Belt tool is armed (the
 * canvas takes no focus, so the press and the walk leave it there). Ends on Escape, as the
 * oracle's helper does.
 */
async function drawDockedPausingBeforeRelease(
  page: Page,
  from: PortFacts,
  cells: readonly (readonly [number, number])[],
  to: PortFacts,
  leg: string,
): Promise<void> {
  const [fdx, fdy] = outwardStep(from.side);
  expect([cells[0][0], cells[0][1]], `${leg}: the run starts on the Out's doorstep`).toEqual([
    from.cell_x + fdx,
    from.cell_y + fdy,
  ]);
  const [tdx, tdy] = outwardStep(to.side);
  const last = cells[cells.length - 1];
  expect([last[0], last[1]], `${leg}: the run ends on the In's facing cell`).toEqual([to.cell_x + tdx, to.cell_y + tdy]);
  await page.getByTitle(/^Draw belts/).click();
  await transport(page).focus();
  const start = await screenCellCentre(page, cells[0][0], cells[0][1]);
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await pointerTravel(page, pt.x, pt.y);
  }
  const end = await screenPoint(page, nubAnchor(to.cell_x, to.cell_y, to.side));
  await pointerTravel(page, end.x, end.y);
  await page.keyboard.press('Space');
  await expect(transport(page), `${leg}: Pause landed before the release`).toHaveAttribute('aria-label', 'Play');
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

/** A Source and a Sink placed by hand for the docked draw; returns the Out and the In. */
async function placePair(page: Page, leg: string): Promise<{ out: PortFacts; inPort: PortFacts }> {
  await handPlaceAt(page, 'Source', ...PAIR_SOURCE);
  await page.keyboard.press('Escape');
  await handPlaceAt(page, 'Sink', ...PAIR_SINK);
  await page.keyboard.press('Escape');
  await pollScene(
    page,
    (s) => machineAt(s, PAIR_SOURCE, SOURCE_KIND) !== undefined && machineAt(s, PAIR_SINK, SINK_KIND) !== undefined,
    { message: `${leg}: the Source and the Sink landed` },
  ).toBe(true);
  const s = await readScene(page);
  const out = portOf(machineAt(s, PAIR_SOURCE, SOURCE_KIND)!, 1);
  const inPort = portOf(machineAt(s, PAIR_SINK, SINK_KIND)!, 0);
  expect(out.side, `${leg}: NON-VACUITY: the Out faces east, so the turn south is a corner`).toBe(1);
  return { out, inPort };
}

/** One sampled frame. */
interface DrainFrame {
  tick: number;
  /** Whether the toolbar offered Play (the chrome's paused state) on this frame. */
  paused: boolean;
  /** The preview surfaces' plotted instruction count (drag preview and held pictures). */
  preview: number;
  /** The kind the preview surfaces plotted at the seam, as JSON, or 'none'. */
  previewKind: string;
  /** Whether the scene holds the belt whose first tile is the seam. */
  exists: boolean;
  /** How many docks the packet carries on that belt. */
  docks: number;
  /** The kind the belts layer drew at the seam, as JSON, or 'none'. */
  drawn: string;
}

interface DrainRecord {
  frames: DrainFrame[];
  /** Index of the first frame recorded after the canvas release, -1 before it. */
  upMark: number;
  /** Index of the first frame recorded after the Play click, -1 before it. */
  resumeMark: number;
  done: boolean;
}

/**
 * Start a per-frame read of the seam before the draw: every animation frame records the scene
 * tick, the toolbar's paused state, what the preview surfaces plotted at the seam and what the
 * belts layer drew there. A capture-phase `pointerup` on the CANVAS marks the release (the Belt
 * tool's own button click is not it), a capture-phase click on Play marks the Resume. Stops
 * `AFTER_DOCK_FRAMES` frames after the belt first carries `docks` docks, `LANDED_GRACE_FRAMES`
 * frames after it first exists without them, or at `MAX_FRAMES`.
 */
async function startDrainSampler(page: Page, key: string, docks: number): Promise<void> {
  await page.evaluate(
    ({ k, seam, wantDocks, after, grace, cap }) => {
      type Hook = {
        scene(): { tick: number; belts: Array<{ id: number; tiles: Array<{ cell_x: number; cell_y: number }>; docks: unknown[] }> };
        beltDrawnKindsOf(id: number): unknown[] | null;
        beltPreviewInstructions(): number;
        beltPreviewKindAt(cellX: number, cellY: number): unknown;
      };
      const w = window as unknown as Record<string, unknown> & { __fabrico?: Hook };
      const rec: DrainRecord = { frames: [], upMark: -1, resumeMark: -1, done: false };
      w[k] = rec;
      window.addEventListener(
        'pointerup',
        (e) => {
          if (rec.upMark < 0 && (e.target as Element | null)?.tagName === 'CANVAS') rec.upMark = rec.frames.length;
        },
        { capture: true },
      );
      window.addEventListener(
        'click',
        (e) => {
          const b = (e.target as Element | null)?.closest?.('button');
          if (b && b.getAttribute('aria-label') === 'Play' && rec.upMark >= 0 && rec.resumeMark < 0) {
            rec.resumeMark = rec.frames.length;
          }
        },
        { capture: true },
      );
      let tail = -1;
      let landed = -1;
      const step = (): void => {
        const hook = w.__fabrico;
        if (hook) {
          const scene = hook.scene();
          const b = scene.belts.find((x) => x.tiles.length > 0 && x.tiles[0].cell_x === seam[0] && x.tiles[0].cell_y === seam[1]);
          const kinds = b ? hook.beltDrawnKindsOf(b.id) : null;
          const plotted = hook.beltPreviewKindAt(seam[0], seam[1]);
          const label = document.querySelector('header button[aria-label="Play"], header button[aria-label="Pause"]');
          rec.frames.push({
            tick: scene.tick,
            paused: label?.getAttribute('aria-label') === 'Play',
            preview: hook.beltPreviewInstructions(),
            previewKind: plotted === null || plotted === undefined ? 'none' : JSON.stringify(plotted),
            exists: b !== undefined,
            docks: b ? b.docks.length : 0,
            drawn: kinds && kinds.length > 0 ? JSON.stringify(kinds[0]) : 'none',
          });
          if (rec.upMark >= 0 && tail < 0 && b !== undefined && b.docks.length >= wantDocks) tail = 0;
          if (rec.upMark >= 0 && landed < 0 && b !== undefined) landed = 0;
        }
        if (tail >= 0) tail++;
        if (landed >= 0) landed++;
        if (tail > after || landed > grace || rec.frames.length >= cap) {
          rec.done = true;
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    {
      k: key,
      seam: [SEAM[0], SEAM[1]] as [number, number],
      wantDocks: docks,
      after: AFTER_DOCK_FRAMES,
      grace: LANDED_GRACE_FRAMES,
      cap: MAX_FRAMES,
    },
  );
}

async function drainRecord(page: Page, key: string): Promise<DrainRecord> {
  return page.evaluate((k) => (window as unknown as Record<string, DrainRecord>)[k], key);
}

/** Wait for the sampler to finish: the belt landed and was drawn on, docked or not (the grade says which). */
async function finishedRecord(page: Page, key: string, leg: string): Promise<DrainRecord> {
  await expect
    .poll(() => page.evaluate((k) => (window as unknown as Record<string, DrainRecord>)[k]?.done === true, key), {
      message: `${leg}: the sampler finished (the belt landed and was drawn on)`,
      timeout: addWaitBudget(
        tickBudgetMs(2 * DRAINED_PAST) + frameBudgetMs(LANDED_GRACE_FRAMES),
        `${leg}: the belt lands and ${LANDED_GRACE_FRAMES} frames pass`,
      ),
    })
    .toBe(true);
  return drainRecord(page, key);
}

/** Whether a frame shows `want` at the seam: plotted by a preview surface, or drawn by the belts layer. */
function showsSeam(f: DrainFrame, want: string): boolean {
  return (f.preview > 0 && f.previewKind === want) || f.drawn === want;
}

/**
 * Grade the frames after the release: every one shows the corner at the seam, every paused
 * one by the held picture alone (the belt is not in the scene while the host holds input), and
 * none draws the seam as anything else. Logs the first failing frame with its index.
 */
function expectCornerOnEveryFrame(rec: DrainRecord, leg: string): DrainFrame[] {
  const want = JSON.stringify(SEAM_CORNER);
  expect(rec.upMark, `${leg}: the sampler saw the release`).toBeGreaterThanOrEqual(0);
  expect(rec.resumeMark, `${leg}: the sampler saw the Play click after the release`).toBeGreaterThan(rec.upMark);
  const graded = rec.frames.slice(rec.upMark);
  const held = rec.frames.slice(rec.upMark, rec.resumeMark);
  const failing = graded.map((f, i) => ({ i, f })).filter(({ f }) => !showsSeam(f, want));
  const heldBad = held.map((f, i) => ({ i, f })).filter(({ f }) => !(f.preview > 0 && f.previewKind === want));
  console.log(
    `CORNER ${leg}: graded=${graded.length} held=${held.length} heldBad=${heldBad.length} failing=${failing.length}` +
      (failing.length > 0 ? ` firstFailing=${failing[0].i} ${JSON.stringify(failing[0].f)}` : '') +
      (heldBad.length > 0 ? ` firstHeldBad=${heldBad[0].i} ${JSON.stringify(heldBad[0].f)}` : ''),
  );
  expect(held.length, `${leg}: NON-VACUITY: frames were drawn between the release and Play`).toBeGreaterThan(0);
  expect(
    held.filter((f) => f.exists).length,
    `${leg}: the belt is not in the scene on any paused frame (the host held the draw)`,
  ).toBe(0);
  expect(
    heldBad.length,
    `${leg}: EVERY paused frame after the release plots ${want} at the seam; the first that does not is frame ` +
      `${heldBad[0]?.i ?? -1} after the release: ${JSON.stringify(heldBad[0]?.f ?? null)} (BELT-05)`,
  ).toBe(0);
  expect(
    failing.length,
    `${leg}: EVERY frame from the release to ${AFTER_DOCK_FRAMES} frames after both docks shows ${want} at the seam, ` +
      `plotted or drawn; the first that does not is frame ${failing[0]?.i ?? -1}: ${JSON.stringify(failing[0]?.f ?? null)}`,
  ).toBe(0);
  expect(
    graded.filter((f) => f.drawn !== 'none' && f.drawn !== want),
    `${leg}: no frame draws the seam as anything but ${want} (never route()'s Straight)`,
  ).toEqual([]);
  return graded;
}

/**
 * The landed belt, graded on the model and on the canvas: docked at both ends to the pair, the
 * seam drawn as the corner, and its end marks plotted for two docks, more than `oneDockEnds`,
 * the end-mark count of a belt docked at one end only.
 */
async function expectLandedDocked(
  page: Page,
  leg: string,
  out: PortFacts,
  inPort: PortFacts,
  oneDockEnds: number,
): Promise<void> {
  await pollScene(page, (s) => (beltFrom(s, SEAM)?.docks ?? []).map((d) => d.end).sort(), {
    message: `${leg}: the belt landed docked at both ends`,
  }).toEqual(['Head', 'Tail']);
  const s = await readScene(page);
  const belt = beltFrom(s, SEAM)!;
  const src = machineAt(s, PAIR_SOURCE, SOURCE_KIND)!;
  const sink = machineAt(s, PAIR_SINK, SINK_KIND)!;
  const tail = belt.docks.find((d) => d.end === 'Tail')!;
  const head = belt.docks.find((d) => d.end === 'Head')!;
  console.log(`LANDED ${leg}: belt=${belt.id} docks=${JSON.stringify(belt.docks)} source=${src.id} sink=${sink.id}`);
  expect([tail.node, tail.port], `${leg}: the Tail docks the Source's Out`).toEqual([src.id, out.index]);
  expect([head.node, head.port], `${leg}: the Head docks the Sink's In`).toEqual([sink.id, inPort.index]);
  const drawn = await page.evaluate(
    ([id]) => {
      const kinds = (window as unknown as { __fabrico: { beltDrawnKindsOf(id: number): unknown[] | null } }).__fabrico.beltDrawnKindsOf(id);
      return kinds && kinds.length > 0 ? JSON.stringify(kinds[0]) : 'none';
    },
    [belt.id] as const,
  );
  expect(drawn, `${leg}: the landed belt's seam is drawn as the corner`).toBe(JSON.stringify(SEAM_CORNER));
  const ends = await beltEndInstructionsOn(page, belt.id);
  console.log(`ENDS ${leg}: landed=${ends} oneDock=${oneDockEnds}`);
  expect(oneDockEnds, `${leg}: NON-VACUITY: a belt docked at one end draws end marks`).toBeGreaterThan(0);
  expect(ends, `${leg}: the landed belt's end marks are drawn for both docks (more than one dock draws)`).toBeGreaterThan(
    oneDockEnds,
  );
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe('a belt drawn just after Pause keeps its dock (BELT-05, D-06, D-07)', () => {
  test('leg 1: a docked belt drawn just after Pause keeps its corner through the drain and docks on Play', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errs = watchPageErrors(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 1 start');

      // THE BACKLOG (Pitfall 7): a Timer Source into a belt with a free head, until items rest.
      await handPlaceAt(page, 'Source', ...BACKLOG_SOURCE);
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => machineAt(s, BACKLOG_SOURCE, SOURCE_KIND) !== undefined, {
        message: 'leg 1: the backlog Source landed',
      }).toBe(true);
      const backlogOut = portOf(machineAt(await readScene(page), BACKLOG_SOURCE, SOURCE_KIND)!, 1);
      await selectMachineAt(page, ...BACKLOG_SOURCE);
      await pressSegment(page, 'Trigger', 'Timer');
      await fillPanelField(page, 'fab-timer-interval', BACKLOG_INTERVAL);
      await applyConfig(page);
      await deselectViaEmptyCell(page, ...EMPTY_CELL);
      await drawOffloadBelt(page, backlogOut, BACKLOG_CELLS);
      await pollScene(page, (s) => (beltFrom(s, BACKLOG_CELLS[0])?.occupiedSlots ?? []).length >= SLOTS_PER_TILE, {
        message: 'leg 1: the backlog belt landed and items rest at its free head',
      }).toBe(true);
      const backlog = beltFrom(await readScene(page), BACKLOG_CELLS[0])!;
      expect(backlog.docks.map((d) => d.end), 'leg 1: NON-VACUITY: the backlog belt docks its Tail only').toEqual([
        'Tail',
      ]);
      await expect
        .poll(() => beltEndInstructionsOn(page, backlog.id), {
          message: 'leg 1: the backlog belt draws its one dock',
          timeout: addWaitBudget(frameBudgetMs(8), 'leg 1: the backlog end marks are drawn'),
        })
        .toBeGreaterThan(0);
      const oneDockEnds = await beltEndInstructionsOn(page, backlog.id);

      const { out, inPort } = await placePair(page, 'leg 1');

      // THE DOCKED DRAW, Pause just before the release: the drain has just begun.
      await startDrainSampler(page, '__drain1', 2);
      await drawDockedPausingBeforeRelease(page, out, PAIR_CELLS, inPort, 'leg 1');
      const atRelease = (await drainRecord(page, '__drain1')).frames.at(-1)?.tick ?? -1;
      await pollScene(page, (s) => s.tick > atRelease, {
        message: 'leg 1: the tick still advances after the release (the pause drains)',
        timeout: addWaitBudget(tickBudgetMs(DRAINED_PAST), 'leg 1: the drain advances after the release'),
      }).toBe(true);
      // The first frame after the release exists only once the page has drawn one, and on a slow
      // page the model tick can move first: under the CPU quota the page draws about one frame
      // every 286 ms, while the tick poll above reads every 100 ms. Reading `frames[upMark]`
      // before that frame is drawn read `undefined` (todo
      // `2026-10-24-belt-drawn-after-pause-reads-the-release-frame-before-it-is-drawn`). So wait
      // until the record holds a frame after the release; the grade below is unchanged. A record
      // with no release at all is left to the `upMark` check below, which names it. The log line
      // says whether the old read would have found its frame (`drawn_at_first_read=false` is the
      // race this wait absorbs).
      const first = await drainRecord(page, '__drain1');
      const drawnAtFirstRead = first.upMark >= 0 && first.frames.length > first.upMark;
      await expect
        .poll(
          async () => {
            const r = await drainRecord(page, '__drain1');
            return r.upMark < 0 || r.frames.length > r.upMark;
          },
          {
            message: 'leg 1: the page drew a frame after the release',
            timeout: addWaitBudget(frameBudgetMs(FRAMES_AFTER_RELEASE), 'leg 1: one drawn frame after the release'),
          },
        )
        .toBe(true);
      const rel = await drainRecord(page, '__drain1');
      console.log(`DRAIN leg 1: drawn_at_first_read=${drawnAtFirstRead}`);
      expect(rel.upMark, 'leg 1: the sampler saw the release').toBeGreaterThanOrEqual(0);
      const releaseTick = rel.frames[rel.upMark]?.tick ?? rel.frames.at(-1)!.tick;
      const atPause = rel.frames.find((f) => f.paused)?.tick ?? -1;
      // The draw helper waits for the toolbar to offer Play before the button comes up; the
      // first frame sampled after the release must show it so. (The frame before the release
      // cannot be asked: on a slow page no frame need fall between the toggle and the release.)
      expect(rel.frames[rel.upMark]?.paused, 'leg 1: the board was paused at the release').toBe(true);
      console.log(`DRAIN leg 1: atPause=${atPause} release=${releaseTick}`);

      // HELD PAST THE OLD EXPIRY: the drain runs at least 121 ticks past the release, paused.
      await pollScene(page, (s) => s.tick >= releaseTick + DRAINED_PAST, {
        message: `leg 1: the paused board drained at least ${DRAINED_PAST} ticks past the release`,
        timeout: addWaitBudget(tickBudgetMs(DRAINED_PAST), `leg 1: ${DRAINED_PAST} drained ticks`),
      }).toBe(true);
      const beforePlay = await readScene(page);
      expect(beltFrom(beforePlay, SEAM), 'leg 1: the belt is still held by the host before Play').toBeUndefined();
      await expect(transport(page), 'leg 1: still paused before Play').toHaveAttribute('aria-label', 'Play');
      console.log(`DRAIN leg 1: beforePlay=${beforePlay.tick} drained=${beforePlay.tick - releaseTick}`);
      expect(beforePlay.tick - releaseTick, 'leg 1: EDGE: the drain ran past the old 120-tick expiry').toBeGreaterThanOrEqual(
        DRAINED_PAST,
      );

      await transport(page).click();
      await expect(transport(page), 'leg 1: the sim runs again (the toggle offers Pause)').toHaveAttribute(
        'aria-label',
        'Pause',
      );
      const rec = await finishedRecord(page, '__drain1', 'leg 1');
      expectCornerOnEveryFrame(rec, 'leg 1');
      await expectLandedDocked(page, 'leg 1', out, inPort, oneDockEnds);
      await expectRenderLoopAlive(page, 'leg 1 after Play');
      errs.assertNone('leg 1');
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }
  });

  test('leg 2: a docked belt drawn on a paused board just after Ctrl+Z still docks on Play, through the Undo\'s keyframe', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errs = watchPageErrors(page);
    try {
      await emptyBoard(page);
      await expectRenderLoopAlive(page, 'leg 2 start');

      // X first, so its Undo puts it back ahead of everything placed after it.
      await handPlaceAt(page, 'Source', ...X_AT);
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => machineAt(s, X_AT, SOURCE_KIND) !== undefined, {
        message: 'leg 2: Source X landed',
      }).toBe(true);
      const { out, inPort } = await placePair(page, 'leg 2');
      await handPlaceAt(page, 'Source', ...REF_SOURCE);
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => machineAt(s, REF_SOURCE, SOURCE_KIND) !== undefined, {
        message: 'leg 2: the reference Source landed',
      }).toBe(true);
      await drawOffloadBelt(page, portOf(machineAt(await readScene(page), REF_SOURCE, SOURCE_KIND)!, 1), REF_CELLS);
      await pollScene(page, (s) => (beltFrom(s, REF_CELLS[0])?.docks ?? []).map((d) => d.end), {
        message: 'leg 2: the reference belt landed docked at its Tail only',
      }).toEqual(['Tail']);
      const refId = beltFrom(await readScene(page), REF_CELLS[0])!.id;
      await expect
        .poll(() => beltEndInstructionsOn(page, refId), {
          message: 'leg 2: the reference belt draws its one dock',
          timeout: addWaitBudget(frameBudgetMs(8), 'leg 2: the reference end marks are drawn'),
        })
        .toBeGreaterThan(0);
      const oneDockEnds = await beltEndInstructionsOn(page, refId);

      // Delete X, Ctrl+Z, Ctrl+Shift+Z, each folded on the playing board, as plan 88-04's leg 1
      // does: the Redo's remint packs the handles with X gone, so the paused Undo below, which
      // puts X back first in the host's order, moves the pair to new handles.
      await selectMachineAt(page, ...X_AT);
      await page.keyboard.press('Delete');
      await pollScene(page, (s) => machineAt(s, X_AT, SOURCE_KIND) === undefined, {
        message: 'leg 2: the Delete removed X',
      }).toBe(true);
      await deselectViaEmptyCell(page, ...EMPTY_CELL);
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => machineAt(s, X_AT, SOURCE_KIND) !== undefined, {
        message: 'leg 2: Ctrl+Z put X back',
      }).toBe(true);
      await page.keyboard.press('Control+Shift+z');
      await pollScene(page, (s) => machineAt(s, X_AT, SOURCE_KIND) === undefined, {
        message: 'leg 2: Ctrl+Shift+Z deleted X again',
      }).toBe(true);

      // PAUSE, Ctrl+Z (queued), then the docked draw on the paused board.
      await pauseAndSettle(page, 'leg 2');
      const g0 = await generationOf(page);
      // Focus off the toolbar button the pause click left it on, as a hand clicks the board.
      await deselectViaEmptyCell(page, ...EMPTY_CELL);
      await page.keyboard.press('Control+z');
      await expect
        .poll(() => statusText(page), {
          message: 'leg 2 PRECONDITION: the toolbar says the Undo is queued',
          timeout: addWaitBudget(frameBudgetMs(8), 'leg 2: the queued status shows'),
        })
        .toBe(EDITS_QUEUED);
      const paused = await readScene(page);
      expect(machineAt(paused, X_AT, SOURCE_KIND), 'leg 2 PRECONDITION: the queued Undo has not folded').toBeUndefined();
      const handlesBefore = {
        source: machineAt(paused, PAIR_SOURCE, SOURCE_KIND)!.id,
        sink: machineAt(paused, PAIR_SINK, SINK_KIND)!.id,
      };
      await startDrainSampler(page, '__undo2', 2);
      await drawBeltThroughCells(page, out, PAIR_CELLS, inPort);
      expect(await generationOf(page), 'leg 2 PRECONDITION: the draw was made on the pre-Undo board').toBe(g0);

      await transport(page).click();
      await expect(transport(page), 'leg 2: the sim runs again (the toggle offers Pause)').toHaveAttribute(
        'aria-label',
        'Pause',
      );
      await pollScene(page, (s) => machineAt(s, X_AT, SOURCE_KIND) !== undefined, {
        message: 'leg 2: the queued Undo folded (X is back)',
      }).toBe(true);
      const rec = await finishedRecord(page, '__undo2', 'leg 2');
      const after = await readScene(page);
      const handlesAfter = {
        source: machineAt(after, PAIR_SOURCE, SOURCE_KIND)!.id,
        sink: machineAt(after, PAIR_SINK, SINK_KIND)!.id,
      };
      console.log(
        `UNDO leg 2: generation ${g0} -> ${await generationOf(page)} before=${JSON.stringify(handlesBefore)} ` +
          `after=${JSON.stringify(handlesAfter)}`,
      );
      expect(await generationOf(page), 'leg 2 PRECONDITION: the Undo reminted the handles').toBeGreaterThan(g0);
      expect(
        handlesAfter,
        "leg 2 NON-VACUITY: the pair moved to new handles, so the drawn board's handles name other machines now",
      ).not.toEqual(handlesBefore);
      expectCornerOnEveryFrame(rec, 'leg 2');
      await expectLandedDocked(page, 'leg 2', out, inPort, oneDockEnds);
      await expectRenderLoopAlive(page, 'leg 2 after Play');
      errs.assertNone('leg 2');
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }
  });
});
