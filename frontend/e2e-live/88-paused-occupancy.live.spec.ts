import { test, expect, type Page } from '@playwright/test';
import { addFrameBudget } from '../e2e/support/frameSampler';
import {
  beltPreviewPlottedOf,
  cameraOf,
  captureRefusalText,
  clickAt,
  expectRenderLoopAlive,
  ghostPlottedOf,
  HAND_MOVE_FRAMES,
  handPath,
  handPlaceAt,
  labelResizePreviewOf,
  targetRingsPlotted,
  newBoard,
  nodeAtAnchor,
  outwardStep,
  pointerTravel,
  pollScene,
  readScene,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CELL } from '../shared/geometry';

/** The host's FootprintCollision sentence (plan 89-08's words), a literal so a copy edit is seen. */
const COLLISION_COPY = 'That space is taken. Clear it or try elsewhere.';

// 88-paused-occupancy.live.spec.ts (plan 88-07, BELT-06, phase 88 success criterion 3 second
// half, D-09, todo 2026-10-06-held-belts-invisible-to-client-occupancy) - on a paused board the
// editor counts every queued gesture as taken, so the preview refuses before Play what the host
// would refuse on Play. On the REAL host (dev_render_server, real Core -> RenderProducer ->
// postcard -> WS). Zero mocks, zero injected packets: machines come off the palette by hand,
// belts are drawn with the Belt tool, the board is paused and played from the toolbar.
//
// ---------------------------------------------------------------------------
// THE DEFECT
// ---------------------------------------------------------------------------
//
// A gesture made on a paused board waits in the host's queue until Play. Until plan 88-07 the
// client's occupancy read (`ghost.ts` `cellOccupied`) asked the folded scene only, so a belt,
// a Place, a label grow or a Dock waiting to apply was invisible to the editor: a second paused
// draw from a held belt's doorstep previewed build-blue and was sent, and the host refused it
// on Play. The ruling (D-09): the one occupancy read counts every queued gesture, through a
// claims store App owns and every reader receives on the scene (`input/queuedClaims.ts`).
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. A HELD BELT. An empty board at zoom 1, a Source placed by hand. Pause. A belt drawn from
//      the Source's Out doorstep east (sent, queued). A second drag from the same doorstep,
//      south: its preview is drawn as not allowed. Since plan 89-09 (D-13, FAIL-02) its
//      DrawBelt is still sent, with no claim, so the host refuses it in words on Play; until
//      then no second frame was sent. Play: exactly one belt lands, the first, docked to the
//      Source, and `#fab-refusal` reads the collision sentence for the second.
//   2. A QUEUED DOCK. The review's board (`74.1-paused-edits` leg 7): belts A (1,5)-(3,5) east,
//      D starting at (3,4) and E starting at (3,6), drawn while playing. Pause. D's Tail dragged
//      onto A's Head (sent, queued; the drop ring over A's Head read accepting, the known-yes).
//      Then E's Tail dragged onto A's Head: the drop ring over it is drawn passive and no resting
//      ring offers it. The release is still sent (a ring is a prediction, never a gate, D-07),
//      and Play joins A to D only and refuses E's drop in words.
//   3. A PENDING PLACE. Pause. A Source placed by hand at (8,8) (sent, queued). The ghost over
//      (8,8) is drawn red, beside a build ghost over free floor; a belt path through (8,8) is
//      drawn as not allowed and, since plan 89-09 (D-13), still sent, so the host refuses it in
//      words on Play. Play: one Source, no belt, and the collision sentence.
//   4. A QUEUED LABEL GROW, AND A PLACE UNDER A LABEL'S OUTLINE. A Label placed at (10,5),
//      4 by 1. Pause. The label grown to 6 by 1 and applied (sent, queued): the Source ghost
//      over (15,5), a cell the grow takes, is drawn red beside a build ghost over (15,6).
//      Then a Source placed at (10,7) (sent, queued) and the label's depth raised in its panel,
//      not applied: at 4 by 2 the outline is drawn fitting, at 4 by 3, over the queued Source,
//      it is drawn not fitting. Play: the label is 6 by 1 and the Source stands at (10,7).
//
// WHAT IS GRADED IS WHAT IS DRAWN (memory fabrico-model-oracle-blindspot): the drag preview's
// and the ghost's colours are read back off their Graphics (`window.__fabrico.beltPreviewPlotted`
// and `ghostPlotted`, plan 88-07), the drop rings off theirs (`targetRingsPlotted`) and the label
// outline off its own (`labelResizePreview`), each beside a reading of the same surface known to
// say yes; the frames sent are read off the socket by a header-stripped sniffer. Render health in every test:
// `watchPageErrors` before `goto`, `expectRenderLoopAlive` on a ticking board after Play, and
// the watcher's `assertNone`.
//
// Pause is HOST-global: each leg presses Play again in a `finally`, and a failed test restores
// the shared host (`restoreHostAfterFailedTest`). Every pointer fixture moves like a hand:
// off-centre presses, sub-cell move samples.

const SOURCE_KIND = 0;
/** The frames per cell of a hand-like walk. */
const STEPS_PER_CELL = 8;
/** The GridCommand discriminants the sniffer counts (`protocol/decode.ts` `encodeGridCommand`). */
const CMD = { Place: 0, DrawBelt: 3, Dock: 4, Configure: 9 } as const;

/** Leg 1: the Source, its Out facing east onto the doorstep (5,6). */
const LEG1_SOURCE: readonly [number, number] = [4, 6];
/** Leg 1's first draw, off the doorstep east. */
const LEG1_FIRST: readonly (readonly [number, number])[] = [
  [5, 6],
  [6, 6],
  [7, 6],
];
/** Leg 1's second drag, off the same doorstep south. */
const LEG1_SECOND: readonly (readonly [number, number])[] = [
  [5, 6],
  [5, 7],
  [5, 8],
];

/** The toolbar's transport toggle: `Pause` while playing, `Play` while paused. */
function transport(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/** Press Play if the toolbar offers it (the `finally` of every leg). */
async function resumeIfPaused(page: Page): Promise<void> {
  if ((await transport(page).getAttribute('aria-label').catch(() => null)) === 'Play') {
    await transport(page).click();
  }
}

/** Pause from the toolbar and return the tick the host settled at (two reads 200 ms apart agree). */
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

/** Press Play and wait until the host has run at least `ticks` ticks. */
async function playFor(page: Page, leg: string, ticks: number): Promise<void> {
  const t0 = (await readScene(page)).tick;
  await transport(page).click();
  await expect(transport(page), `${leg}: the toggle offers Pause again`).toHaveAttribute('aria-label', 'Pause');
  await pollScene(page, (s) => s.tick >= t0 + ticks, {
    message: `${leg}: the host ran ${ticks} ticks after Play`,
    timeout: 15_000,
  }).toBe(true);
}

/** An empty board at zoom 1, the sim running. */
async function emptyBoardAtScaleOne(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'zoom 1').toBe(1);
  await resumeIfPaused(page);
}

/**
 * Record the body discriminant of every gesture frame the page puts on the render socket. An
 * observer on `WebSocket.prototype.send`, installed before the app boots: it forwards every
 * frame unchanged and records only binary frames' first BODY byte, skipping the gesture
 * header's two varints (board generation, gesture id; phase 88, plan 88-03).
 */
async function installFrameSniffer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sentCmds: number[] };
    w.__sentCmds = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      let bytes: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes !== null) {
        let i = 0;
        for (let field = 0; field < 2; field++) {
          while (i < bytes.length && (bytes[i] & 0x80) !== 0) i++;
          i++;
        }
        if (i < bytes.length) w.__sentCmds.push(bytes[i]);
      }
      return send.call(this, data as Parameters<WebSocket['send']>[0]);
    };
  });
}

/** How many frames of GridCommand `cmd` the page has sent since it booted. */
async function sentCount(page: Page, cmd: number): Promise<number> {
  return page.evaluate((c) => (window as unknown as { __sentCmds: number[] }).__sentCmds.filter((x) => x === c).length, cmd);
}

/** Every belt in the scene, as its cell list. */
function beltCellLists(scene: SceneFacts): string[] {
  return scene.belts.map((b) => b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' ')).sort();
}
const listOf = (cells: readonly (readonly [number, number])[]): string => cells.map(([x, y]) => `${x},${y}`).join(' ');

/**
 * Press a few px off the centre of `cells[0]` and walk the rest in sub-cell steps, leaving the
 * button DOWN, so the caller can read the drag preview before the release.
 */
async function pressAndWalk(page: Page, cells: readonly (readonly [number, number])[]): Promise<void> {
  const start = await screenPoint(page, { x: (cells[0][0] + 0.45) * CELL, y: (cells[0][1] + 0.55) * CELL });
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await pointerTravel(page, pt.x + 3, pt.y - 2, STEPS_PER_CELL);
  }
}

/** The drag preview's plotted colour, polled until something is plotted. */
async function previewPlotted(page: Page, what: string): Promise<{ color: number; valid: boolean }> {
  let last: { color: number; valid: boolean } | null = null;
  await expect
    .poll(
      async () => {
        last = await beltPreviewPlottedOf(page);
        return last !== null;
      },
      { message: `${what}: the drag preview plotted something` },
    )
    .toBe(true);
  return last!;
}

/** `REFUSAL_COPY.BeltEndTaken`, transcribed, not imported. */
const BELT_END_TAKEN_COPY = 'That belt end is already joined. Use a free end.';
const LABEL_KIND = 11;
/** The oracle's pause between two hand moves (oracle.ts keeps its own private). */
const HAND_PAUSE_MS = 8;

/** Leg 2's board, 74.1-paused-edits leg 7's: A east, D and E starting beside A's Head (3,5). */
const A_CELLS: readonly (readonly [number, number])[] = [
  [1, 5],
  [2, 5],
  [3, 5],
];
const D_CELLS: readonly (readonly [number, number])[] = [
  [3, 4],
  [3, 3],
  [3, 2],
];
const E_CELLS: readonly (readonly [number, number])[] = [
  [3, 6],
  [3, 7],
  [3, 8],
];
/** Leg 3: the queued Source's cell, a free cell beside it, and the belt path through it. */
const LEG3_X: readonly [number, number] = [8, 8];
const LEG3_FREE: readonly [number, number] = [11, 8];
const LEG3_PATH: readonly (readonly [number, number])[] = [
  [6, 8],
  [7, 8],
  [8, 8],
  [9, 8],
];
/** Leg 4: the label's anchor, a cell its queued grow takes, the free cell below, the queued Source. */
const LEG4_LABEL: readonly [number, number] = [10, 5];
const LEG4_GROWN: readonly [number, number] = [15, 5];
const LEG4_FREE: readonly [number, number] = [15, 6];
const LEG4_Z: readonly [number, number] = [10, 7];
/** An empty cell clicked to close a panel. */
const FLOOR_CELL: readonly [number, number] = [4, 10];

/** The belt with a tile on `cell`, or undefined. */
function beltOn(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/**
 * Every cell a leg presses, hovers or drops on can be reached by a hand: at its centre and at
 * two inner points, the topmost element under the pointer is the board's canvas (not the
 * palette, the toolbar, a panel, or nothing past the viewport's edge). A camera that put a cell
 * off the board would turn a drop into a click on nothing, which is a fixture failure, not a
 * finding (measured: a leg-4 Place at (10,14) landed at screen y 724 below the 720 px viewport
 * when the leg ran alone).
 */
async function expectOnScreen(page: Page, leg: string, cells: readonly (readonly [number, number])[]): Promise<void> {
  for (const [cx, cy] of cells) {
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.25, 0.25],
      [0.75, 0.75],
    ]) {
      const p = await screenPoint(page, { x: (cx + fx) * CELL, y: (cy + fy) * CELL });
      const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'none', [p.x, p.y]);
      expect(top, `${leg}: cell (${cx},${cy}) is reachable on the board at (${p.x},${p.y})`).toBe('CANVAS');
    }
  }
}

/** A click a few px off the centre of cell (cx, cy). */
async function clickCell(page: Page, cell: readonly [number, number]): Promise<void> {
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await clickAt(page, at.x + 3, at.y - 2);
}

/** A belt drawn like a hand with the Belt tool already armed. */
async function handDraw(page: Page, cells: readonly (readonly [number, number])[]): Promise<void> {
  await pressAndWalk(page, cells);
  await page.mouse.up();
}

/**
 * Select the belt under `select`, press off-centre inside its end tile `press` and walk in
 * sub-cell steps to an off-centre point inside `drop`, leaving the button DOWN.
 */
async function grabEndAndWalk(
  page: Page,
  select: readonly [number, number],
  press: readonly [number, number],
  drop: readonly [number, number],
  what: string,
): Promise<void> {
  await clickCell(page, select);
  await expect(page.locator('#fab-belt-config'), `${what}: the dragged belt is selected`).toBeVisible({ timeout: 15_000 });
  const a = await screenPoint(page, { x: (press[0] + 0.7) * CELL, y: (press[1] + 0.7) * CELL });
  const b = await screenPoint(page, { x: (drop[0] + 0.4) * CELL, y: (drop[1] + 0.6) * CELL });
  await pointerTravel(page, a.x, a.y);
  await page.mouse.down();
  await pointerTravel(page, b.x, b.y, STEPS_PER_CELL);
}

/** The drop ring as plotted, polled until one is drawn. */
async function dropRingPlotted(page: Page, what: string): Promise<{ x: number; y: number; accepting: boolean }> {
  let last: { x: number; y: number; accepting: boolean } | null = null;
  await expect
    .poll(
      async () => {
        last = (await targetRingsPlotted(page)).drop;
        return last !== null;
      },
      { message: `${what}: a drop ring is drawn under the pointer` },
    )
    .toBe(true);
  return last!;
}

/**
 * Arm `kindName` from the palette and walk its ghost like a hand to cell `cell` (the palette
 * row to the cell, `handPath`'s stretches), without pressing.
 */
async function armAndHover(page: Page, kindName: string, cell: readonly [number, number]): Promise<void> {
  const row = page.getByRole('button', { name: `Place ${kindName}`, exact: true });
  await row.click();
  const box = await row.boundingBox();
  expect(box, `the "Place ${kindName}" palette row has a box`).not.toBeNull();
  const centre = await screenCellCentre(page, cell[0], cell[1]);
  const start = { x: box!.x + box!.width + 4, y: box!.y + box!.height / 2 };
  const path = [start, ...handPath(start, { x: centre.x + 5, y: centre.y - 4 })];
  addFrameBudget(path.length * HAND_MOVE_FRAMES, `armAndHover ${kindName} ${path.length} moves`);
  for (const p of path) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HAND_PAUSE_MS);
  }
}

/** Walk the armed ghost to cell `cell` in sub-cell steps. */
async function hoverCell(page: Page, cell: readonly [number, number]): Promise<void> {
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await pointerTravel(page, at.x + 5, at.y - 4, STEPS_PER_CELL);
}

/** The ghost as plotted at cell `cell`, polled until the ghost's body sits on that cell. */
async function ghostAt(page: Page, cell: readonly [number, number], what: string): Promise<{ color: number; valid: boolean }> {
  let last: { color: number; valid: boolean } | null = null;
  await expect
    .poll(
      async () => {
        const g = await ghostPlottedOf(page);
        if (g === null || Math.floor(g.rect.x / CELL) !== cell[0] || Math.floor(g.rect.y / CELL) !== cell[1]) return false;
        last = { color: g.color, valid: g.valid };
        return true;
      },
      { message: `${what}: the ghost is drawn at (${cell[0]},${cell[1]})` },
    )
    .toBe(true);
  return last!;
}

/** The label outline's stroke colour as plotted, polled until the outline is the `h`-cell-deep box. */
async function outlineColour(page: Page, h: number, what: string): Promise<number> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const o = await labelResizePreviewOf(page);
        last = o?.stroke?.color ?? -1;
        return o?.rect?.h === h * CELL - 8 && last !== -1;
      },
      { message: `${what}: the label outline is drawn ${h} cells deep` },
    )
    .toBe(true);
  return last;
}

test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe.configure({ mode: 'serial' });

test.describe('BELT-06 on the real host: queued gestures are taken on a paused board', () => {
  test('1: a belt held on a paused board takes its doorstep: a second drag from it previews red and is refused at Play', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await installFrameSniffer(page);
    await emptyBoardAtScaleOne(page);
    try {
      await expectOnScreen(page, 'leg 1', [LEG1_SOURCE, ...LEG1_FIRST, ...LEG1_SECOND]);
      await handPlaceAt(page, 'Source', ...LEG1_SOURCE);
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => nodeAtAnchor(s, ...LEG1_SOURCE)?.kind ?? null, {
        message: 'leg 1: the Source landed',
      }).toBe(SOURCE_KIND);
      const source = nodeAtAnchor(await readScene(page), ...LEG1_SOURCE)!;
      const out = source.ports.find((p) => p.role === 1)!;
      const [dx, dy] = outwardStep(out.side);
      expect([out.cell_x + dx, out.cell_y + dy], 'leg 1: the Out faces the doorstep both drags start on').toEqual([
        LEG1_FIRST[0][0],
        LEG1_FIRST[0][1],
      ]);

      await pauseAndSettle(page, 'leg 1');
      await page.getByTitle(/^Draw belts/).click();
      const drawsBefore = await sentCount(page, CMD.DrawBelt);

      // THE FIRST DRAW, a draw the host will accept: its preview is the known-valid reading.
      await pressAndWalk(page, LEG1_FIRST);
      const first = await previewPlotted(page, 'leg 1, first draw');
      console.log(`OCCUPANCY leg 1 first preview: ${JSON.stringify(first)}`);
      expect(first.valid, 'leg 1: NON-VACUITY: the first draw is previewed as allowed').toBe(true);
      await page.mouse.up();
      await expect
        .poll(() => sentCount(page, CMD.DrawBelt), { message: 'leg 1: the first draw sent its DrawBelt' })
        .toBe(drawsBefore + 1);

      // THE SECOND DRAG, off the same doorstep: the held belt holds that cell.
      await pressAndWalk(page, LEG1_SECOND);
      const second = await previewPlotted(page, 'leg 1, second drag');
      console.log(`OCCUPANCY leg 1 second preview: ${JSON.stringify(second)} first=${JSON.stringify(first)}`);
      expect(second.valid, 'leg 1: the second drag from the held doorstep is drawn as not allowed').toBe(false);
      expect(second.color, 'leg 1: and in a colour other than the allowed draw\'s').not.toBe(first.color);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      const draws = (await sentCount(page, CMD.DrawBelt)) - drawsBefore;
      console.log(`OCCUPANCY leg 1 DrawBelt frames sent while paused: ${draws}`);
      // Since plan 89-09 (D-13): the red drag is sent too, so the host says why at Play.
      expect(draws, 'leg 1: the second drag is sent as well, so the host can refuse it in words').toBe(2);
      expect((await readScene(page)).belts, 'leg 1: nothing folded while paused').toEqual([]);

      // The sentence is held 4 s, so its latch runs from before the Play click.
      const said = captureRefusalText(page, 'leg 1: the second draw was refused at Play');
      await playFor(page, 'leg 1', 30);
      expect(await said, 'leg 1: the host says the doorstep is taken').toBe(COLLISION_COPY);
      await pollScene(page, beltCellLists, { message: 'leg 1: exactly the first belt landed' }).toEqual([
        listOf(LEG1_FIRST),
      ]);
      await pollScene(page, (s) => s.belts[0]?.docks.some((d) => d.end === 'Tail' && d.node === source.id) ?? false, {
        message: 'leg 1: the belt is docked to the Source',
      }).toBe(true);
      expect(beltCellLists(await readScene(page)), 'leg 1: still exactly one belt').toEqual([listOf(LEG1_FIRST)]);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });

  test('2: a belt end a queued Dock names wears no accepting ring for a second drag', async ({ page }) => {
    const errs = watchPageErrors(page);
    await installFrameSniffer(page);
    await emptyBoardAtScaleOne(page);
    try {
      await expectOnScreen(page, 'leg 2', [...A_CELLS, ...D_CELLS, ...E_CELLS]);
      await page.getByTitle(/^Draw belts/).click();
      for (const [i, cells] of [A_CELLS, D_CELLS, E_CELLS].entries()) {
        await handDraw(page, cells);
        await pollScene(page, (s) => s.belts.length, { message: `leg 2: belt ${i + 1} was drawn` }).toBe(i + 1);
      }
      await page.keyboard.press('Escape');
      const built = await readScene(page);
      expect(built.belts.flatMap((b) => b.docks), 'leg 2: MEASURED, all three belts start undocked').toEqual([]);
      const a = beltOn(built, A_CELLS[0])!;
      const d = beltOn(built, D_CELLS[0])!;
      await pauseAndSettle(page, 'leg 2');
      const docksBefore = await sentCount(page, CMD.Dock);

      // D's Tail onto A's free Head: the known-yes.
      await grabEndAndWalk(page, D_CELLS[1], D_CELLS[0], A_CELLS[2], 'leg 2, D');
      const first = await dropRingPlotted(page, 'leg 2, D');
      console.log(`OCCUPANCY leg 2 D's drop ring: ${JSON.stringify(first)}`);
      expect(first.accepting, "leg 2: NON-VACUITY: A's free Head is drawn accepting D's Tail").toBe(true);
      await page.mouse.up();
      await expect.poll(() => sentCount(page, CMD.Dock), { message: "leg 2: D's join was sent" }).toBe(docksBefore + 1);
      await page.keyboard.press('Escape');

      // E's Tail onto the same Head, while D's join waits for Play.
      await grabEndAndWalk(page, E_CELLS[1], E_CELLS[0], A_CELLS[2], 'leg 2, E');
      const second = await dropRingPlotted(page, 'leg 2, E');
      const resting = (await targetRingsPlotted(page)).resting;
      console.log(`OCCUPANCY leg 2 E's drop ring: ${JSON.stringify(second)} resting=${JSON.stringify(resting)}`);
      expect(second.accepting, "leg 2: A's Head, named by the queued Dock, is drawn passive under E's drop").toBe(false);
      expect([second.x, second.y], 'leg 2: the passive ring is the one over A\'s Head').toEqual([first.x, first.y]);
      expect(
        resting.some((p) => p.x === first.x && p.y === first.y),
        "leg 2: no resting ring offers A's Head",
      ).toBe(false);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      const docks = (await sentCount(page, CMD.Dock)) - docksBefore;
      console.log(`OCCUPANCY leg 2 Dock frames sent while paused: ${docks}`);
      expect(docks, "leg 2: E's drop is still sent: a ring is a prediction, never a gate (D-07)").toBe(2);
      expect((await readScene(page)).belts.flatMap((b) => b.docks), 'leg 2: nothing joined while paused').toEqual([]);

      await playFor(page, 'leg 2', 10);
      await expect(page.locator('#fab-refusal'), "leg 2: E's drop is refused in words").toHaveText(BELT_END_TAKEN_COPY, {
        timeout: 15_000,
      });
      await pollScene(page, (s) => beltOn(s, A_CELLS[0])?.docks.length ?? 0, { message: "leg 2: A's end joined" }).toBe(1);
      expect(beltOn(await readScene(page), A_CELLS[0])?.docks, "leg 2: A's end is joined to D only").toEqual([
        expect.objectContaining({ end: 'Head', node: d.id }),
      ]);
      expect(beltOn(await readScene(page), A_CELLS[0])?.id, 'leg 2: A kept its id').toBe(a.id);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });

  test('3: a pending Place takes its cell: the ghost over it is red and a belt path through it is refused at Play', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await installFrameSniffer(page);
    await emptyBoardAtScaleOne(page);
    try {
      await expectOnScreen(page, 'leg 3', [LEG3_X, LEG3_FREE, ...LEG3_PATH]);
      await pauseAndSettle(page, 'leg 3');
      const placesBefore = await sentCount(page, CMD.Place);
      const drawsBefore = await sentCount(page, CMD.DrawBelt);
      await handPlaceAt(page, 'Source', ...LEG3_X);
      await expect.poll(() => sentCount(page, CMD.Place), { message: 'leg 3: the Place was sent' }).toBe(placesBefore + 1);
      // The tool stays armed (IX-06): the ghost is re-shown at the cursor, over the queued Place.
      await hoverCell(page, LEG3_FREE);
      const free = await ghostAt(page, LEG3_FREE, 'leg 3, free floor');
      await hoverCell(page, LEG3_X);
      const over = await ghostAt(page, LEG3_X, 'leg 3, the queued cell');
      console.log(`OCCUPANCY leg 3 ghost: free=${JSON.stringify(free)} overQueued=${JSON.stringify(over)}`);
      expect(free.valid, 'leg 3: NON-VACUITY: the ghost over free floor is drawn build').toBe(true);
      expect(over.valid, 'leg 3: the ghost over the queued Place is drawn red').toBe(false);
      expect(over.color, 'leg 3: in a colour other than the free ghost\'s').not.toBe(free.color);
      await page.keyboard.press('Escape');

      await page.getByTitle(/^Draw belts/).click();
      await pressAndWalk(page, LEG3_PATH);
      const path = await previewPlotted(page, 'leg 3, the path');
      console.log(`OCCUPANCY leg 3 path preview: ${JSON.stringify(path)}`);
      expect(path.valid, 'leg 3: the belt path through the queued Place is drawn as not allowed').toBe(false);
      await page.mouse.up();
      await page.keyboard.press('Escape');
      const draws = (await sentCount(page, CMD.DrawBelt)) - drawsBefore;
      console.log(`OCCUPANCY leg 3 DrawBelt frames sent while paused: ${draws}`);
      // Since plan 89-09 (D-13): the red path is sent, so the host says why at Play.
      expect(draws, 'leg 3: and is sent, so the host can refuse it in words').toBe(1);

      const said = captureRefusalText(page, 'leg 3: the path was refused at Play');
      await playFor(page, 'leg 3', 30);
      expect(await said, 'leg 3: the host says the cell is taken').toBe(COLLISION_COPY);
      await pollScene(page, (s) => nodeAtAnchor(s, ...LEG3_X)?.kind ?? null, { message: 'leg 3: the Source landed' }).toBe(
        SOURCE_KIND,
      );
      const after = await readScene(page);
      expect(after.nodes.length, 'leg 3: exactly one machine').toBe(1);
      expect(after.belts, 'leg 3: no belt').toEqual([]);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });

  test('4: a queued label grow takes its new cells, and a queued Place makes a label outline over it not fit', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await installFrameSniffer(page);
    await emptyBoardAtScaleOne(page);
    try {
      await expectOnScreen(page, 'leg 4', [LEG4_LABEL, LEG4_GROWN, LEG4_FREE, LEG4_Z, FLOOR_CELL]);
      await handPlaceAt(page, 'Label', ...LEG4_LABEL);
      await pollScene(page, (s) => nodeAtAnchor(s, ...LEG4_LABEL)?.kind ?? null, {
        message: 'leg 4: the label landed',
      }).toBe(LABEL_KIND);
      // Wait for the tool to let go and the panel to open (plan 84-10's reason), then close it.
      await expect(page.locator('#fab-label-width'), 'leg 4: the placed label\'s panel opened, reading 4').toHaveText('4');
      await expect(
        page.getByRole('button', { name: 'Place Label', exact: true }),
        'leg 4: the Label tool let go after one placement',
      ).toHaveAttribute('aria-pressed', 'false');
      await clickCell(page, FLOOR_CELL);
      await expect(page.locator('#fab-label-width'), 'leg 4: the floor click closed the panel').toHaveCount(0);
      const label = nodeAtAnchor(await readScene(page), ...LEG4_LABEL)!;
      expect(label.cells.length, 'leg 4: MEASURED, the label is 4 by 1').toBe(4);

      await pauseAndSettle(page, 'leg 4');
      const configuresBefore = await sentCount(page, CMD.Configure);
      await clickCell(page, [LEG4_LABEL[0] + 1, LEG4_LABEL[1]]);
      await expect(page.locator('#fab-label-width'), 'leg 4: the label panel is open, reading 4').toHaveText('4');
      const wider = page.getByRole('button', { name: 'Increase width', exact: true });
      await wider.click();
      await wider.click();
      await expect(page.locator('#fab-label-width'), 'leg 4: the width readout').toHaveText('6');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect.poll(() => sentCount(page, CMD.Configure), { message: 'leg 4: the grow was sent' }).toBe(
        configuresBefore + 1,
      );
      await clickCell(page, FLOOR_CELL);
      await expect(page.locator('#fab-label-width'), 'leg 4: the floor click closed the panel').toHaveCount(0);

      // PART A: the Source ghost over a cell the queued grow takes.
      await armAndHover(page, 'Source', LEG4_FREE);
      const free = await ghostAt(page, LEG4_FREE, 'leg 4, below the grow');
      await hoverCell(page, LEG4_GROWN);
      const grown = await ghostAt(page, LEG4_GROWN, 'leg 4, over the grow');
      console.log(`OCCUPANCY leg 4 ghost: free=${JSON.stringify(free)} overGrow=${JSON.stringify(grown)}`);
      expect(free.valid, 'leg 4: NON-VACUITY: the ghost below the grow is drawn build').toBe(true);
      expect(grown.valid, 'leg 4: the ghost over a cell the queued grow takes is drawn red').toBe(false);
      await page.keyboard.press('Escape');

      // PART B: a Source queued at Z, then the label's depth raised over Z in its panel.
      const placesBefore = await sentCount(page, CMD.Place);
      await handPlaceAt(page, 'Source', ...LEG4_Z);
      await expect.poll(() => sentCount(page, CMD.Place), { message: 'leg 4: the Place at Z was sent' }).toBe(
        placesBefore + 1,
      );
      await page.keyboard.press('Escape');
      await clickCell(page, [LEG4_LABEL[0] + 1, LEG4_LABEL[1]]);
      await expect(page.locator('#fab-label-width'), 'leg 4: the panel reads the committed 4').toHaveText('4');
      const deeper = page.getByRole('button', { name: 'Increase depth', exact: true });
      await deeper.click();
      const fits = await outlineColour(page, 2, 'leg 4, 4 by 2');
      await deeper.click();
      const over = await outlineColour(page, 3, 'leg 4, 4 by 3');
      const finalOutline = await labelResizePreviewOf(page);
      console.log(`OCCUPANCY leg 4 outline: fits=${fits} overZ=${over} rect=${JSON.stringify(finalOutline?.rect ?? null)}`);
      expect(over, 'leg 4: the outline over the queued Place is drawn in another colour than the fitting one').not.toBe(
        fits,
      );
      await clickCell(page, FLOOR_CELL);
      await expect(page.locator('#fab-label-width'), 'leg 4: the panel closed, nothing applied').toHaveCount(0);
      expect(await sentCount(page, CMD.Configure), 'leg 4: the depth was never applied').toBe(configuresBefore + 1);

      await playFor(page, 'leg 4', 30);
      await pollScene(page, (s) => nodeAtAnchor(s, ...LEG4_LABEL)?.cells.length ?? 0, {
        message: 'leg 4: the label is 6 by 1 after Play',
      }).toBe(6);
      await pollScene(page, (s) => nodeAtAnchor(s, ...LEG4_Z)?.kind ?? null, { message: 'leg 4: the Source landed at Z' }).toBe(
        SOURCE_KIND,
      );
      expect((await readScene(page)).nodes.length, 'leg 4: the label and the one Source').toBe(2);
    } finally {
      await page.mouse.up().catch(() => {});
      await resumeIfPaused(page);
    }
    await expectRenderLoopAlive(page, 'after leg 4');
    errs.assertNone('leg 4');
  });
});
