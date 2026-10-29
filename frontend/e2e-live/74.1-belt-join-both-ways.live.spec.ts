import { test, expect, type Page } from '@playwright/test';
import {
  captureRefusalText,
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  cameraOf,
  clickAt,
  drawOffloadBelt,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  newBoard,
  nubAnchor,
  pollScene,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  targetRingsPlotted,
  tileKindAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { CELL } from '../shared/geometry';

// 74.1-belt-join-both-ways.live.spec.ts (plan 74.1-15, gaps N4 and N4b) - a belt-to-belt
// join made from EITHER belt, on the real `dev_render_server`, driven the way a hand
// drives it.
//
// ---------------------------------------------------------------------------
// WHAT WAS REJECTED
// ---------------------------------------------------------------------------
//
// Re-walk step N4, 2026-10-04: "n4 says a belt run from an output to an input right next
// to it as an error". On the dry-run board (main belt (4,6)->(7,6) east, side belt
// (4,3)->(4,5) south), dragging the main belt's first tile onto the side belt's last tile
// joined, but dragging the side belt's last tile onto the main belt's first tile, the SAME
// physical join, was refused. The host rule required the TARGET belt's end to point at
// the dragged end, so only the dragged belt was allowed to turn.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   A. Select the MAIN belt, drag its first-tile dot onto the side belt's last tile. Joins
//      (it did before this plan too); the main belt's first tile ships Corner{S,E}.
//   B. The same board fresh, select the SIDE belt, drag its last-tile dot onto the main
//      belt's first tile. RED BEFORE THE FIX (refused); joins after, with the identical dock
//      set and the identical tile kinds as leg A.
//   C. THE OTHER ORDER from the dry run: a straight feed docked on the main belt's first
//      tile first (since plan 89-05, D-06, the feed's own draw joins it: it ends one cell short
//      of that tile, facing it), then the main belt's first tile pressed and dragged onto the side belt's
//      last tile. At a pre-release revision this did nothing and said nothing (the press missed the grab,
//      gap N4b). After: the main belt carries two Tail docks and its first tile ships
//      Straight{X} (two feeds, one straight in, is a side-load).
//   D. After a join, press inside the JOINED end tile and drag to empty floor: the handle
//      drag begins (the canvas cursor reads `grabbing` mid-drag) and the release on nothing
//      is the documented cancel, so nothing changes. Since plan 74.1-25 (review WR-07) the
//      release is graded after a settle window of at least 10 sim ticks, on a read taken
//      after it, so a release that wrongly sends a command is folded before the read.
//   E. (plan 74.1-25, gap N4-DROP) Leg A's board and drag with ONE change: the drop lands at
//      0.9 by 0.9 of the side belt's last tile, 18 world px from its centre, outside the
//      12 px drop disc the drop used to read. Joins. RED BEFORE THE FIX (the drop snapped back).
//   F. (plan 74.1-33, review round 4 WR-02) A belt drawn off a Source's Out, so its Tail is
//      docked there, selected and its Tail dot dragged: no ring the overlay PLOTS within the
//      Out nub's hit radius is accepting, on every sampled frame, at scale 1 and again at a
//      zoom below 0.77 (where the review measured the dot's own radius reaching the nub).
//      The release on the nub is still sent and refused in the host's words, and the board
//      is unchanged. RED at the start revision (a resting ring plotted on the Out).
//
// EVERY POINTER FIXTURE MOVES LIKE A HAND: presses land on OFF-CENTRE points inside the
// tiles (fractions of a cell, never the centre), and every move emits STEPS_PER_CELL
// samples, so the first samples stay inside the pressed tile.
//
// MODEL FIRST, THEN RENDER HEALTH: the scene oracle reads the decoded packet, which keeps
// advancing with a dead renderer, so every leg opens with `watchPageErrors` and closes with
// `expectRenderLoopAlive`.

/** The main belt: four cells east. Tail (4,6), Head (7,6). */
const MAIN_CELLS: readonly (readonly [number, number])[] = [
  [4, 6],
  [5, 6],
  [6, 6],
  [7, 6],
];
/** The side belt: three cells south, ending on the tile just above the main belt's Tail. */
const SIDE_CELLS: readonly (readonly [number, number])[] = [
  [4, 3],
  [4, 4],
  [4, 5],
];
/** Leg C's straight feed: three cells east, ending on the tile just left of the main Tail. */
const FEED_CELLS: readonly (readonly [number, number])[] = [
  [1, 6],
  [2, 6],
  [3, 6],
];
const FEED_HEAD = FEED_CELLS[FEED_CELLS.length - 1];
const MAIN_TAIL = MAIN_CELLS[0];
const SIDE_HEAD = SIDE_CELLS[SIDE_CELLS.length - 1];

/** Pointer samples per one-cell move at scale 1: an eighth of a cell each (4 screen px). */
const STEPS_PER_CELL = 8;

/**
 * The off-centre point inside a tile a press or a drop lands on, as a fraction of a cell
 * from the tile's top-left corner. Not the centre: a hand does not hit the centre.
 *
 * MEASURED, at scale 1: the press point is 9 world px from an UNDOCKED end's dot (the tile
 * centre, inside the 12 px radius) and 23 world px from a JOINED end's dot (the seam on the
 * tile's west or north edge, outside it). So legs C and D press where a hand presses a
 * joined end, and only the end-tile grab (gap N4b) can catch it.
 */
const PRESS_FRAC = [0.7, 0.7] as const;
const DROP_FRAC = [0.4, 0.6] as const;
/**
 * Leg E's drop point (plan 74.1-25): near the far corner of the target tile. MEASURED at
 * scale 1: (0.9, 0.9) of a 32 px cell is 12.8 px from the centre on each axis, 18.1 px in
 * all, so it is outside the old 12 px drop disc and inside the tile.
 */
const FAR_DROP_FRAC = [0.9, 0.9] as const;

/** Leg D's settle window: the sim ticks that must pass after the release before it is read. */
const SETTLE_TICKS = 10;

/** Wire encodings (`TileKindView`): Axis X=0, Y=1; Dir N=0, E=1, S=2, W=3. */
const CORNER_S_TO_E = { Corner: { from: 2, to: 1 } };
const STRAIGHT_X = { Straight: { axis: 0 } };
const STRAIGHT_Y = { Straight: { axis: 1 } };

/** The belt that occupies (cx, cy), or undefined. */
function beltAt(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/**
 * The dock set of the two belts, read by CELL (a keyframe remints handles) and written
 * with the partner named rather than numbered, so two fresh boards compare equal.
 * `'MISSING'` is fewer than two belts.
 */
function joinFacts(scene: SceneFacts): string {
  const main = beltAt(scene, MAIN_TAIL);
  const side = beltAt(scene, SIDE_HEAD);
  if (!main || !side || main.id === side.id) return 'MISSING';
  const feed = beltAt(scene, FEED_HEAD);
  const name = (id: number): string =>
    id === main.id ? 'main' : id === side.id ? 'side' : id === feed?.id ? 'feed' : `other:${id}`;
  const fmt = (who: string, b: typeof main): string[] =>
    (b.docks ?? []).map((d) => `${who}.${d.end}->${name(d.node)}`).sort();
  return [...fmt('main', main), ...fmt('side', side), ...(feed ? fmt('feed', feed) : [])].join(' ');
}

/** The joined dock set: the side belt's Head feeds the main belt's Tail. */
const JOINED = 'main.Tail->side side.Head->main';

/** The SCREEN point at fraction (fx, fy) of cell (cx, cy). */
async function cellPoint(
  page: Page,
  cell: readonly [number, number],
  frac: readonly [number, number],
): Promise<{ x: number; y: number }> {
  return screenPoint(page, { x: (cell[0] + frac[0]) * CELL, y: (cell[1] + frac[1]) * CELL });
}

/** Draw a plain belt through `cells` with the armed Belt tool, sub-cell samples per cell. */
async function drawPlain(page: Page, cells: readonly (readonly [number, number])[]): Promise<void> {
  const start = await screenCellCentre(page, cells[0][0], cells[0][1]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await page.mouse.move(pt.x, pt.y, { steps: STEPS_PER_CELL });
  }
  await page.mouse.up();
}

/**
 * An empty board at camera scale 1 (READ and asserted) holding the main belt and then the
 * side belt, both undocked, with the Belt tool disarmed.
 */
async function n4Board(page: Page, feed = false): Promise<void> {
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);
  await page.getByTitle(/^Draw belts/).click();
  await drawPlain(page, MAIN_CELLS);
  await pollScene(page, (s) => s.belts.length, { message: 'the main belt was drawn' }).toBe(1);
  await drawPlain(page, SIDE_CELLS);
  await pollScene(page, (s) => s.belts.length, { message: 'the side belt was drawn' }).toBe(2);
  if (feed) {
    // Since phase 89 (plan 89-05, D-06) a draw that ends one cell short of a free belt start,
    // facing it, joins it as it is drawn: the feed ends on (3,6), straight on into the main
    // belt's first tile (4,6), so its Head docks the main belt's Tail by the release's own
    // auto-dock. The side belt ends ABOVE that tile, not facing it, and stays undocked. The join
    // is graded SILENT, as the drag it replaced was (review WR-C-05): a second Dock of the joined
    // Head would be refused in words, an error on screen for a join that worked.
    await expectRefusalStayedSilent(page, 'the straight feed joins the main belt as drawn', async () => {
      await drawPlain(page, FEED_CELLS);
      await pollScene(page, (s) => s.belts.length, { message: 'the feed belt was drawn' }).toBe(3);
      await pollScene(page, joinFacts, {
        message: 'the straight feed, drawn one cell short of the main belt start and facing it, joins it as drawn (D-06)',
      }).toBe('main.Tail->feed feed.Head->main');
      // The host runs past the join before the silence window closes, so a refusal of a second
      // Dock sent after the first has its round trip inside the window.
      const t0 = (await readScene(page)).tick;
      await pollScene(page, (s) => s.tick >= t0 + 40, { message: 'the host ran 40 ticks past the join' }).toBe(true);
    });
  }
  await page.keyboard.press('Escape');
  const built = await readScene(page);
  expect(beltAt(built, MAIN_TAIL)?.tiles.map((t) => [t.cell_x, t.cell_y]), 'the main belt').toEqual(
    MAIN_CELLS.map(([x, y]) => [x, y]),
  );
  expect(beltAt(built, SIDE_HEAD)?.tiles.map((t) => [t.cell_x, t.cell_y]), 'the side belt').toEqual(
    SIDE_CELLS.map(([x, y]) => [x, y]),
  );
  expect(joinFacts(built), feed ? 'the feed is joined, the side belt undocked' : 'both belts start undocked').toBe(
    feed ? 'main.Tail->feed feed.Head->main' : '',
  );
}

/** Click an interior tile of a belt to select it; the belt panel opening is the proof. */
async function selectBeltAt(page: Page, cell: readonly [number, number]): Promise<void> {
  const pt = await cellPoint(page, cell, [0.5, 0.5]);
  await clickAt(page, pt.x, pt.y);
  await expect(page.locator('#fab-belt-config'), `clicking (${cell}) selected a belt`).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Press an off-centre point inside `from`, move in sub-cell steps to an off-centre point
 * inside `to`, release. The selected belt's end in `from` is what is dragged.
 */
async function dragEndTile(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  dropFrac: readonly [number, number] = DROP_FRAC,
): Promise<void> {
  const a = await cellPoint(page, from, PRESS_FRAC);
  const b = await cellPoint(page, to, dropFrac);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: STEPS_PER_CELL });
  await page.mouse.up();
}

/** The join's shipped tile kinds, asserted the same way for every leg that makes it. */
async function expectJoinedKinds(page: Page, leg: string): Promise<void> {
  await pollScene(page, (s) => tileKindAt(s, MAIN_TAIL[0], MAIN_TAIL[1]), {
    message: `${leg}: the main belt's first tile ships Corner{S,E}: in from the side belt (south), out east`,
  }).toEqual(CORNER_S_TO_E);
  expect(
    tileKindAt(await readScene(page), SIDE_HEAD[0], SIDE_HEAD[1]),
    `${leg}: the side belt's last tile stays a north-south straight`,
  ).toEqual(STRAIGHT_Y);
}

/** The host's sentence for a Tail dropped on the Out it is already docked to (PortOccupied). */
const PORT_OCCUPIED_COPY = 'That output is already connected. Disconnect it first.';

/** The drop ring's hit radius in WORLD px at camera scale `scale` (`nubHitRadiusWorld`). */
function nubHitRadius(scale: number): number {
  return 12 / Math.min(1, scale);
}

/** Every node's and belt's structure, nothing that moves on its own. */
function boardStructure(scene: SceneFacts): string {
  return JSON.stringify({
    nodes: scene.nodes.map((n) => ({ kind: n.kind, cells: n.cells, ports: n.ports })),
    belts: scene.belts.map((b) => ({ tiles: b.tiles.map((t) => [t.cell_x, t.cell_y]), docks: b.docks })),
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('N4 on the real host: a belt-to-belt join from either belt', () => {
  test('A: dragging the MAIN belt first-tile dot onto the side belt last tile joins', async ({ page }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n4Board(page);

    await selectBeltAt(page, [6, 6]);
    await expectRefusalStayedSilent(page, 'the main belt dragged onto the side belt', async () => {
      await dragEndTile(page, MAIN_TAIL, SIDE_HEAD);
      await pollScene(page, joinFacts, { message: 'leg A: the two belts join' }).toBe(JOINED);
    });
    await expectJoinedKinds(page, 'leg A');

    await expectRenderLoopAlive(page, 'after leg A');
    errs.assertNone('leg A');
  });

  test('B: dragging the SIDE belt last-tile dot onto the main belt first tile joins the same way', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n4Board(page);

    await selectBeltAt(page, [4, 4]);
    await expectRefusalStayedSilent(page, 'the side belt dragged onto the main belt', async () => {
      await dragEndTile(page, SIDE_HEAD, MAIN_TAIL);
      await pollScene(page, joinFacts, {
        message:
          'leg B: the side belt dragged onto the main belt joins with the SAME dock set as leg A. ' +
          'Before plan 74.1-15 the host refused this direction (gap N4).',
      }).toBe(JOINED);
    });
    await expectJoinedKinds(page, 'leg B');

    await expectRenderLoopAlive(page, 'after leg B');
    errs.assertNone('leg B');
  });

  test('C: THE OTHER ORDER: a straight feed first, then the main belt first tile pressed and dragged onto the side belt', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n4Board(page, true);

    // 1. The straight feed is already docked on the main belt's first tile: since phase 89
    //    (plan 89-05, D-06) the draw that ended one cell short of it, facing it, joined it
    //    (`n4Board`). Until then this step dragged the feed's last-tile dot onto that tile; the
    //    drag would now be a second Dock of a joined Head, which the host refuses in words.
    expect(joinFacts(await readScene(page)), 'leg C: the straight feed is joined to the main belt').toBe(
      'main.Tail->feed feed.Head->main',
    );
    // 2. The main belt's first tile, now JOINED (its dot sits on the seam with the feed),
    //    pressed inside the tile and dragged onto the side belt's last tile.
    await selectBeltAt(page, [6, 6]);
    await expectRefusalStayedSilent(page, 'the main belt dragged onto the side belt, second', async () => {
      await dragEndTile(page, MAIN_TAIL, SIDE_HEAD);
      await pollScene(page, joinFacts, {
        message:
          'leg C: the main belt carries TWO Tail docks, the feed and the side belt. At a pre-release revision ' +
          'the press inside the joined first tile missed the grab (gap N4b), so no drag began ' +
          'and nothing was sent or said.',
      }).toBe('main.Tail->feed main.Tail->side side.Head->main feed.Head->main');
    });
    await pollScene(page, (s) => tileKindAt(s, MAIN_TAIL[0], MAIN_TAIL[1]), {
      message: "leg C: the main belt's first tile ships Straight{X}: two feeds, one straight in, is a side-load",
    }).toEqual(STRAIGHT_X);

    await expectRenderLoopAlive(page, 'after leg C');
    errs.assertNone('leg C');
  });

  test('D: after a join, a press inside the joined end tile starts the handle drag, and a release on floor cancels', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n4Board(page);
    await selectBeltAt(page, [6, 6]);
    await dragEndTile(page, MAIN_TAIL, SIDE_HEAD);
    await pollScene(page, joinFacts, { message: 'leg D: the join is made first' }).toBe(JOINED);

    // Press inside the JOINED first tile (its dot is on the seam with the side belt, 23 px
    // away), move in sub-cell steps to empty floor, read the cursor mid-drag, release.
    const grabbing = (): Promise<boolean> =>
      page.evaluate(() => Array.from(document.querySelectorAll('canvas')).some((c) => c.style.cursor === 'grabbing'));
    expect(await grabbing(), 'no drag before the press').toBe(false);
    const a = await cellPoint(page, MAIN_TAIL, PRESS_FRAC);
    const floor = await cellPoint(page, [10, 10], [0.5, 0.5]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + floor.x) / 2, (a.y + floor.y) / 2, { steps: STEPS_PER_CELL });
    expect(await grabbing(), 'the press inside the joined end tile began a handle drag').toBe(true);
    await page.mouse.move(floor.x, floor.y, { steps: STEPS_PER_CELL });

    // THE RELEASE IS GRADED AFTER THE HOST COULD HAVE ANSWERED (plan 74.1-25, review WR-07).
    // A command the release wrongly sends is folded one or more packets later, so a single
    // read straight after `mouse.up` could only see the board from before it. The refusal
    // region is watched for the whole window, and the window closes only once the sim has
    // run SETTLE_TICKS ticks past the release.
    const releaseTick = (await readScene(page)).tick;
    await expectRefusalStayedSilent(page, 'the cancelled drag released on floor', async () => {
      await page.mouse.up();
      expect(await grabbing(), 'the drag ended').toBe(false);
      await pollScene(page, (s) => s.tick >= releaseTick + SETTLE_TICKS, {
        message: `leg D: the sim ran ${SETTLE_TICKS} ticks past the release`,
      }).toBe(true);
    });

    // The release on nothing is the documented cancel: the join stands, nothing else moved,
    // on a read taken after the settle window.
    const after = await readScene(page);
    expect(after.tick, 'the read is from after the settle window').toBeGreaterThanOrEqual(releaseTick + SETTLE_TICKS);
    expect(after.belts, 'no belt was added or removed').toHaveLength(2);
    expect(joinFacts(after), 'the join is unchanged by the cancelled drag').toBe(JOINED);

    await expectRenderLoopAlive(page, 'after leg D');
    errs.assertNone('leg D');
  });

  test('E: a drop near the far corner of the side belt last tile, outside the old drop disc, joins', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await n4Board(page);

    await selectBeltAt(page, [6, 6]);
    await expectRefusalStayedSilent(page, 'the main belt dropped near the far corner of the side belt', async () => {
      await dragEndTile(page, MAIN_TAIL, SIDE_HEAD, FAR_DROP_FRAC);
      await pollScene(page, joinFacts, {
        message:
          'leg E: a drop anywhere on the target end tile lands, as a press does. Before plan ' +
          '74.1-25 a drop more than 12 world px from the tile centre snapped back (gap N4-DROP).',
      }).toBe(JOINED);
    });
    await expectJoinedKinds(page, 'leg E');

    await expectRenderLoopAlive(page, 'after leg E');
    errs.assertNone('leg E');
  });

  test('F: a Tail docked to a Source Out, dragged by its dot, shows no accepting ring on that Out, and a release on it is refused with the board unchanged', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await newBoard(page);
    await resetZoomToActualSize(page);
    await waitForCameraSettle(page);
    expect((await cameraOf(page)).scale, 'the camera is at scale 1').toBe(1);

    // A Source, and a belt drawn off its Out's doorstep three cells straight out: the draw
    // records the Tail dock on the Out (one DrawBelt plus one Tail Dock).
    await armAndPlaceAt(page, 'Source', 10, 4);
    await pollScene(page, (s) => s.nodes.length, { message: 'the real host echoed the placed Source' }).toBe(1);
    const source = (await readScene(page)).nodes[0];
    const out = source.ports.find((p) => p.role === 1);
    expect(out, 'the Source has an Out').toBeTruthy();
    const step: Record<number, [number, number]> = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] };
    const [ox, oy] = step[out!.side & 3];
    const path: [number, number][] = [1, 2, 3].map((k) => [out!.cell_x + ox * k, out!.cell_y + oy * k]);
    await drawOffloadBelt(page, out!, path);
    await pollScene(page, (s) => (s.belts[0]?.docks ?? []).map((d) => `${d.end}->${d.node === source.id}`), {
      message: 'the belt was drawn with its Tail docked to the Source Out',
    }).toEqual(['Tail->true']);
    const held = boardStructure(await readScene(page));
    const tail = path[0];
    const nub = nubAnchor(out!.cell_x, out!.cell_y, out!.side);

    /**
     * Select the belt, press its Tail dot off-centre inside the Tail tile, walk the pointer
     * through `route` (world points, sub-cell steps), reading the PLOTTED target rings after
     * every sample, then release on the nub. Returns the drop ring read at the release point.
     */
    const dragAndRead = async (label: string, route: Array<{ x: number; y: number }>) => {
      const mid = await cellPoint(page, path[1], [0.5, 0.5]);
      await clickAt(page, mid.x, mid.y);
      await expect(page.locator('#fab-belt-config'), `${label}: the belt is selected`).toBeVisible({
        timeout: 15_000,
      });
      const scale = (await cameraOf(page)).scale;
      const radius = nubHitRadius(scale);
      const near = (p: { x: number; y: number }): boolean => Math.hypot(p.x - nub.x, p.y - nub.y) <= radius;
      const press = await cellPoint(page, tail, PRESS_FRAC);
      let lastDrop: { x: number; y: number; accepting: boolean } | null = null;
      let down = false;
      try {
        await page.mouse.move(press.x, press.y);
        await page.mouse.down();
        down = true;
        let from = { x: (tail[0] + PRESS_FRAC[0]) * CELL, y: (tail[1] + PRESS_FRAC[1]) * CELL };
        let frames = 0;
        for (const to of route) {
          for (let i = 1; i <= STEPS_PER_CELL; i++) {
            const w = { x: from.x + ((to.x - from.x) * i) / STEPS_PER_CELL, y: from.y + ((to.y - from.y) * i) / STEPS_PER_CELL };
            const sp = await screenPoint(page, w);
            await page.mouse.move(sp.x, sp.y);
            const rings = await targetRingsPlotted(page);
            frames++;
            expect(
              rings.resting.filter(near),
              `${label}, frame ${frames} at world (${w.x.toFixed(1)}, ${w.y.toFixed(1)}): no resting ring is plotted ` +
                `within ${radius.toFixed(1)} world px of the Out this Tail is docked to (review WR-02)`,
            ).toEqual([]);
            if (rings.drop && near(rings.drop)) {
              expect(
                rings.drop.accepting,
                `${label}, frame ${frames}: the drop ring on the docked Out is drawn refused`,
              ).toBe(false);
            }
            lastDrop = rings.drop;
          }
          from = to;
        }
        expect(
          await page.evaluate(() => Array.from(document.querySelectorAll('canvas')).some((c) => c.style.cursor === 'grabbing')),
          `${label}: the press began a handle drag`,
        ).toBe(true);
        await page.mouse.up();
        down = false;
      } finally {
        if (down) {
          await page.mouse.up();
        }
      }
      return lastDrop;
    };

    try {
      // Scale 1: over the nub, a pass half a cell past it, back onto it, release.
      const past = { x: nub.x - ox * (CELL / 2), y: nub.y - oy * (CELL / 2) };
      const atScale1 = await dragAndRead('scale 1', [nub, past, { x: nub.x + 1.5, y: nub.y - 1 }]);
      expect(atScale1, 'scale 1: the drop ring was plotted on the Out at the release point').not.toBeNull();
      expect(atScale1!.accepting, 'scale 1: and drawn refused').toBe(false);
      expect(await captureRefusalText(page, 'scale 1: the release was answered'), 'scale 1: the host says why').toBe(
        PORT_OCCUPIED_COPY,
      );
      expect(boardStructure(await readScene(page)), 'scale 1: the board is unchanged').toBe(held);
      await expect(page.locator('#fab-refusal'), 'the sentence clears before the next pass').toHaveText('', {
        timeout: 15_000,
      });

      // Below 0.77: one wheel notch out over the Tail tile (exp(-0.3) = 0.74).
      const over = await cellPoint(page, tail, [0.5, 0.5]);
      await page.mouse.move(over.x, over.y);
      await page.mouse.wheel(0, 200);
      await waitForCameraSettle(page);
      const low = (await cameraOf(page)).scale;
      expect(low, 'the camera is below 0.77, where the dot radius reaches the nub').toBeLessThan(0.77);
      // The Tail tile's centre (the review's "release on the dot itself"), then the nub.
      const tileCentre = { x: (tail[0] + 0.5) * CELL, y: (tail[1] + 0.5) * CELL };
      const atLow = await dragAndRead(`scale ${low.toFixed(2)}`, [tileCentre, past, nub]);
      expect(atLow, 'low zoom: the drop ring was plotted on the Out at the release point').not.toBeNull();
      expect(atLow!.accepting, 'low zoom: and drawn refused').toBe(false);
      expect(await captureRefusalText(page, 'low zoom: the release was answered'), 'low zoom: the host says why').toBe(
        PORT_OCCUPIED_COPY,
      );
      const after = await readScene(page);
      expect(after.belts, 'no belt was added or removed').toHaveLength(1);
      expect(boardStructure(after), 'low zoom: the board is unchanged').toBe(held);

      await expectRenderLoopAlive(page, 'after leg F');
      errs.assertNone('leg F');
    } finally {
      await page.keyboard.press('Escape');
    }
  });
});
