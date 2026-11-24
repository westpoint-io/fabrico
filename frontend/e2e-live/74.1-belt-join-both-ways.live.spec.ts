import { test, expect, type Page } from './support/liveTest';
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
//   B. Select the SIDE belt, drag its last-tile dot onto the main belt's first tile. RED
//      BEFORE THE FIX (refused); joins after, and the main belt's first tile ships
//      Corner{S,E}. The other direction (dragging the main belt) is the sideways handle-drag
//      join `74.1-seam-corner.live.spec.ts` walks, so this file keeps only the direction
//      that was refused.
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
 * tile's west or north edge, outside it).
 */
const PRESS_FRAC = [0.7, 0.7] as const;
const DROP_FRAC = [0.4, 0.6] as const;

/** Wire encodings (`TileKindView`): Axis X=0, Y=1; Dir N=0, E=1, S=2, W=3. */
const CORNER_S_TO_E = { Corner: { from: 2, to: 1 } };
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
  const name = (id: number): string => (id === main.id ? 'main' : id === side.id ? 'side' : `other:${id}`);
  const fmt = (who: string, b: typeof main): string[] =>
    (b.docks ?? []).map((d) => `${who}.${d.end}->${name(d.node)}`).sort();
  return [...fmt('main', main), ...fmt('side', side)].join(' ');
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
async function n4Board(page: Page): Promise<void> {
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
  await page.keyboard.press('Escape');
  const built = await readScene(page);
  expect(beltAt(built, MAIN_TAIL)?.tiles.map((t) => [t.cell_x, t.cell_y]), 'the main belt').toEqual(
    MAIN_CELLS.map(([x, y]) => [x, y]),
  );
  expect(beltAt(built, SIDE_HEAD)?.tiles.map((t) => [t.cell_x, t.cell_y]), 'the side belt').toEqual(
    SIDE_CELLS.map(([x, y]) => [x, y]),
  );
  expect(joinFacts(built), 'both belts start undocked').toBe('');
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
): Promise<void> {
  const a = await cellPoint(page, from, PRESS_FRAC);
  const b = await cellPoint(page, to, DROP_FRAC);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: STEPS_PER_CELL });
  await page.mouse.up();
}

/** The join's shipped tile kinds. */
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
