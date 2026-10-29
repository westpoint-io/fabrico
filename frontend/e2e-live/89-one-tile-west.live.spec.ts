import { test, expect, type Page } from '@playwright/test';
import { addFrameBudget, addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  CELL,
  DRAWN_STATE_FRAMES,
  applyConfig,
  armAndPlaceAt,
  cameraOf,
  deselectViaEmptyCell,
  expectRenderLoopAlive,
  fillPanelField,
  handDragBetween,
  nodeAtAnchor,
  nubAnchor,
  outwardStep,
  pollScene,
  pressSegment,
  readScene,
  restoreHostAfterFailedTest,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  tileKindAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
import { cardinalOfRotation, emptyBoardAtScaleOne, turnUntilFacing, zoomBelowOne, treadRotationAt, previewKindAt } from './support/beltBoard';

// 89-one-tile-west.live.spec.ts (phase 89, plan 89-03, BELT-10, success criterion 5, D-15; todo
// `2026-10-02-single-tile-belt-direction`) - a one-tile belt is drawn and animated flowing the
// way it was drawn, on the REAL host (dev_render_server, real Core -> RenderProducer -> postcard
// -> WS). Zero mocks, zero injected packets: the machines are placed and turned with the shipped
// palette and `r` key, the belt is drawn with the shipped Belt tool by a hand drag.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (89-MEASURE.md `## BELT-10: still broken`)
// ---------------------------------------------------------------------------
//
// A one-tile belt's stored geometry carries only an axis, and the seam table (`seam_end_kind`
// in `crates/fabrico-core/src/state.rs`, mirrored by `seamEndKind` in
// `frontend/src/protocol/seam.ts`) turned every single tile whose entry equals its exit into
// `Straight { axis }`. The direction was gone before the render packet went out, so a one-tile
// belt flowing West was drawn with its tread pointing East and its items sliding East, and a
// one-tile belt flowing North was drawn flowing South. D-15: such a tile is a zero-turn corner,
// `Corner { from: e, to: e }`, and the belts layer draws a corner whose ends agree as a straight
// running along `from`.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE EYE SEES
// ---------------------------------------------------------------------------
//
// Each leg builds two machine pairs on an empty board: a 1x1 Source and a 1x1 Sink with one
// empty cell between them, the Source turned so its Out faces the empty cell along the flow and
// the Sink turned so its In faces it back. The machines are built and turned BEFORE any belt
// exists (a later turn would dock a loose end, D-08 from plan 89-02). The first pair's belt is
// drawn at camera scale 1, the second pair's after the wheel has zoomed the camera below 1
// (where the hit radii change). Each belt is drawn by a hand drag (`handDragBetween`, several
// pointer samples) from the empty cell's upstream half onto the Sink's In dot, so the drawn path
// is that one cell and the release docks both ends. The drag crosses one cell, not the three
// D-16 asks of a proof leg, because the belt under test is one cell long by definition. Only
// then is the Source put on a Timer, so items cross the belt one at a time, far apart.
//
//   1. Flowing WEST: the Source East of the cell, the Sink West of it.
//   2. Flowing NORTH: the Source South of the cell, the Sink North of it.
//
// For every belt: the drag PREVIEW's kind at the cell before the release
// (`beltPreviewKindAt`), the shipped kind after the echo (the scene), the tread ROTATION the
// belts layer DREW on the cell (`beltTreadRotationAt`, read off the tile object), and the ITEM
// DOTS the item layer plotted on that cell over consecutive drawn frames (`itemDotsFrame`): each
// dot moves along the flow from one frame to the next (world x decreasing for West, world y
// decreasing for North). The four reads are soft, so a red run names every one that failed.
//
// RED FIRST (D-16): run once against the commit that added `beltTreadRotationAt` (before the
// seam change), host and frontend built from it, both legs red on the tread and the items
// (89-EVIDENCE.md, `LIVE_RED 89-one-tile-west`).
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` after every test (fabrico-model-oracle-blindspot).

/** Wire kinds (kinds.ts). */
const KIND_SOURCE = 0;
const KIND_SINK = 7;
/** Port roles (oracle `PortFacts.role`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
/** Travel cardinals, the wire's numbering (y-down). */
const N = 0;
const W = 3;
const CARDINAL_NAME = ['N', 'E', 'S', 'W'] as const;
/**
 * The Timer interval each Source runs on, in sim ticks. A tile is 4 slots at 2 ticks a slot, so
 * an item crosses the one tile in 8 ticks and the next one arrives 16 ticks after it left: the
 * cell holds at most one dot, and two frames whose drawn ticks are `SAME_ITEM_TICKS` or fewer
 * apart can only show the same item. The Timer is set after the belt docks, so no backlog
 * crosses it packed first.
 */
const FEED_EVERY = 24;
/** Two frames this many drawn ticks apart or fewer show the same item (see `FEED_EVERY`). */
const SAME_ITEM_TICKS = 8;
/** An empty floor cell, clear of every pair, where a click deselects. */
const FLOOR_AT: readonly [number, number] = [16, 13];
/** The drawn frames the item sampler may read, and the dot moves it must see. */
const MOTION_FRAMES = 480;
const MIN_MOVES = 4;
/** The longest dot move between two frames on the one cell: the cell itself. */
const MAX_MOVE_PX = CELL;
/** Off the flow line by more than this is not riding the belt. */
const LANE_PX = 1;

/** One machine pair and the cell its belt is drawn on. */
interface Pair {
  name: string;
  /** The travel cardinal the belt flows along. */
  flow: number;
  /** The one empty cell between the machines, where the belt is drawn. */
  belt: readonly [number, number];
}

const WEST_PAIRS: readonly Pair[] = [
  { name: 'west at zoom 1', flow: W, belt: [9, 6] },
  { name: 'west below zoom 1', flow: W, belt: [9, 10] },
];
const NORTH_PAIRS: readonly Pair[] = [
  { name: 'north at zoom 1', flow: N, belt: [14, 7] },
  { name: 'north below zoom 1', flow: N, belt: [20, 7] },
];

/** The Sink sits one step along the flow from the belt cell, the Source one step against it. */
function sinkCell(p: Pair): [number, number] {
  const [dx, dy] = outwardStep(p.flow);
  return [p.belt[0] + dx, p.belt[1] + dy];
}
function sourceCell(p: Pair): [number, number] {
  const [dx, dy] = outwardStep(p.flow);
  return [p.belt[0] - dx, p.belt[1] - dy];
}

/** The zero-turn corner D-15 ships for a one-tile belt flowing `flow`. */
function zeroTurn(flow: number): { Corner: { from: number; to: number } } {
  return { Corner: { from: flow, to: flow } };
}

/** Place a pair's Sink and Source and turn them to face the belt cell. */
async function buildPair(page: Page, p: Pair): Promise<void> {
  const sink = sinkCell(p);
  const source = sourceCell(p);
  await armAndPlaceAt(page, 'Sink', sink[0], sink[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, sink[0], sink[1])?.kind ?? -1, {
    message: `${p.name}: the palette Sink was placed at (${sink.join(',')})`,
  }).toBe(KIND_SINK);
  await armAndPlaceAt(page, 'Source', source[0], source[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, source[0], source[1])?.kind ?? -1, {
    message: `${p.name}: the palette Source was placed at (${source.join(',')})`,
  }).toBe(KIND_SOURCE);

  // The Source's Out faces along the flow, onto the belt cell.
  await selectMachineAt(page, source[0], source[1]);
  await turnUntilFacing(page, source, ROLE_OUT, p.flow, `${p.name}: the Source's Out`);
  // The Sink's In faces back against the flow, onto the same cell.
  await selectMachineAt(page, sink[0], sink[1]);
  await turnUntilFacing(page, sink, ROLE_IN, (p.flow + 2) % 4, `${p.name}: the Sink's In`);
  await deselectViaEmptyCell(page, FLOOR_AT[0], FLOOR_AT[1]);
}

/** What the item sampler saw on one cell. */
interface MotionFacts {
  frames: number;
  framesWithDots: number;
  moves: Array<{ dx: number; dy: number }>;
  /** Every frame read: its drawn tick and the dots on the cell, rounded, for the log. */
  trace: string[];
}

/**
 * Read the item layer's plotted dots on `cell` over consecutive drawn frames, in the page, one read
 * per animation frame, until `MIN_MOVES` dot moves are seen or `MOTION_FRAMES` frames pass. A move
 * pairs two consecutive frames that each hold exactly ONE dot on the cell and whose drawn ticks
 * are 1 to `SAME_ITEM_TICKS` apart, so both show the same item (`FEED_EVERY`); a pair that did not
 * move is dropped. Every frame is kept in `trace` for the log.
 */
async function sampleItemMotion(page: Page, cell: readonly [number, number]): Promise<MotionFacts> {
  addFrameBudget(MOTION_FRAMES, `the item motion sample on (${cell.join(',')})`);
  return page.evaluate(
    ([cx, cy, cellPx, maxFrames, minMoves, maxMove, sameItemTicks]) =>
      new Promise<MotionFacts>((resolve) => {
        type Dot = { x: number; y: number };
        const hook = (window as { __fabrico?: { itemDotsFrame(): { drawnAtTick: number | null; dots: Dot[] } } })
          .__fabrico;
        if (hook === undefined) throw new Error('window.__fabrico.itemDotsFrame() not installed');
        const x0 = cx * cellPx - 1;
        const x1 = cx * cellPx + cellPx + 1;
        const y0 = cy * cellPx - 1;
        const y1 = cy * cellPx + cellPx + 1;
        const onCell = (d: Dot): boolean => d.x >= x0 && d.x <= x1 && d.y >= y0 && d.y <= y1;
        const out: MotionFacts = { frames: 0, framesWithDots: 0, moves: [], trace: [] };
        let prev: { tick: number | null; dots: Dot[] } | null = null;
        const step = (): void => {
          const f = hook.itemDotsFrame();
          const dots = f.dots.filter(onCell);
          out.trace.push(`${f.drawnAtTick}:${dots.map((d) => `${Math.round(d.x)},${Math.round(d.y)}`).join('/')}`);
          out.frames += 1;
          if (dots.length > 0) out.framesWithDots += 1;
          if (
            prev !== null &&
            prev.tick !== null &&
            f.drawnAtTick !== null &&
            f.drawnAtTick > prev.tick &&
            f.drawnAtTick - prev.tick <= sameItemTicks &&
            dots.length === 1 &&
            prev.dots.length === 1
          ) {
            const dx = dots[0].x - prev.dots[0].x;
            const dy = dots[0].y - prev.dots[0].y;
            const len = Math.abs(dx) + Math.abs(dy);
            if (len > 0.25 && len <= maxMove) out.moves.push({ dx, dy });
          }
          prev = { tick: f.drawnAtTick, dots };
          if (out.frames >= maxFrames || out.moves.length >= minMoves) resolve(out);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    [cell[0], cell[1], CELL, MOTION_FRAMES, MIN_MOVES, MAX_MOVE_PX, SAME_ITEM_TICKS] as const,
  );
}

/**
 * Arm the Belt tool and draw the pair's one-tile belt by a hand drag from the cell's upstream half
 * onto the Sink's In dot, then grade the preview, the shipped kind, the drawn tread and (with the
 * tool put away and the Source on its Timer) the drawn item motion against the pair's flow.
 */
async function drawAndGrade(page: Page, p: Pair): Promise<void> {
  const soft = expect.configure({ soft: true });
  await page.getByTitle(/^Draw belts/).click();
  const flowName = CARDINAL_NAME[p.flow];
  const scene0 = await readScene(page);
  const sink = nodeAtAnchor(scene0, ...sinkCell(p))!;
  const source = nodeAtAnchor(scene0, ...sourceCell(p))!;
  const inPort = sink.ports.find((q) => q.role === ROLE_IN)!;
  const cam = await cameraOf(page);
  const cellPx = CELL * cam.scale;
  const [fx, fy] = outwardStep(p.flow);
  // Pressed in the belt cell's upstream half, a little off its flow line; released 2 screen px
  // past the Sink's In dot, toward the belt cell (the dot sits 2.5 world px inside that cell).
  const door = await screenCellCentre(page, p.belt[0], p.belt[1]);
  const start = { x: door.x - fx * 0.3 * cellPx + fy * 0.1 * cellPx, y: door.y - fy * 0.3 * cellPx - fx * 0.1 * cellPx };
  const nub = await screenPoint(page, nubAnchor(inPort.cell_x, inPort.cell_y, inPort.side));
  const end = { x: nub.x - fx * 2, y: nub.y - fy * 2 };
  const tags = await page.evaluate((ps) => ps.map((q) => document.elementFromPoint(q.x, q.y)?.tagName ?? null), [start, end]);
  expect(tags, `${p.name}: the drag starts and ends on the canvas, not under chrome`).toEqual(['CANVAS', 'CANVAS']);

  const previews: unknown[] = [];
  const moves = await handDragBetween(page, start, end, async () => {
    previews.push(await previewKindAt(page, p.belt));
  });
  expect(moves, `${p.name}: the drag moved through several samples, not one teleport`).toBeGreaterThanOrEqual(3);
  const held = previews[previews.length - 1];
  console.log(`P89-ONE-TILE ${p.name}: scale=${cam.scale} moves=${moves} preview kinds=${JSON.stringify(previews)}`);

  // The host folded the one-tile belt and docked both ends (hard: every read below needs it).
  const docksOf = (s: SceneFacts): string =>
    s.belts
      .find((b) => b.tiles.length === 1 && b.tiles[0].cell_x === p.belt[0] && b.tiles[0].cell_y === p.belt[1])
      ?.docks.map((d) => `${d.end}@${d.node === source.id ? 'source' : d.node === sink.id ? 'sink' : d.node}`)
      .sort()
      .join(',') ?? 'no one-tile belt';
  await pollScene(page, docksOf, {
    message: `${p.name}: a one-tile belt on (${p.belt.join(',')}) with its Head docked to the Sink and its Tail to the Source`,
  }).toBe('Head@sink,Tail@source');

  // 1. The preview, read before the release, showed the tile flowing the way it was drawn.
  soft(held, `${p.name}: before the release the preview drew the cell as a ${flowName}-flowing zero-turn corner`).toEqual(
    zeroTurn(p.flow),
  );
  // 2. The host shipped the same kind.
  await soft
    .poll(async () => tileKindAt(await readScene(page), p.belt[0], p.belt[1]), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${p.name}: the shipped kind read`),
      intervals: [100, 250, 500],
      message: `${p.name}: the host ships the one tile as Corner { from: ${flowName}, to: ${flowName} }, not a bare axis`,
    })
    .toEqual(zeroTurn(p.flow));
  // 3. The tread the belts layer DREW on the cell points along the flow.
  let rotation: number | null = null;
  await soft
    .poll(
      async () => {
        rotation = await treadRotationAt(page, p.belt);
        return rotation === null ? 'no tile drawn' : CARDINAL_NAME[cardinalOfRotation(rotation)];
      },
      {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), `${p.name}: the drawn tread read`),
        intervals: [100, 250, 500],
        message: `${p.name}: the tread drawn on (${p.belt.join(',')}) points ${flowName}`,
      },
    )
    .toBe(flowName);
  // 4. The items the item layer PLOTTED on the cell move along the flow, frame after frame. The
  // Belt tool is put away and the Source put on its Timer now, so items cross one at a time.
  await page.keyboard.press('Escape');
  await selectMachineAt(page, ...sourceCell(p));
  await pressSegment(page, 'Trigger', 'Timer');
  await fillPanelField(page, 'fab-timer-interval', String(FEED_EVERY));
  await applyConfig(page);
  await deselectViaEmptyCell(page, FLOOR_AT[0], FLOOR_AT[1]);
  const motion = await sampleItemMotion(page, p.belt);
  const against = motion.moves.filter((m) =>
    p.flow === W ? !(m.dx < 0 && Math.abs(m.dy) <= LANE_PX) : !(m.dy < 0 && Math.abs(m.dx) <= LANE_PX),
  );
  const line =
    `rotation=${rotation} frames=${motion.frames} frames_with_dots=${motion.framesWithDots} moves=${motion.moves.length} ` +
    `against=${against.length} first=${JSON.stringify(motion.moves.slice(0, 4))}`;
  console.log(`P89-ONE-TILE ${p.name}: ${line}`);
  if (against.length > 0) console.log(`P89-ONE-TILE ${p.name}: trace ${motion.trace.join(' ')}`);
  soft(motion.moves.length, `${p.name}: the item layer drew dots moving on the cell (${line})`).toBeGreaterThanOrEqual(MIN_MOVES);
  soft(against.length, `${p.name}: every drawn dot move on the cell runs ${flowName} (${line})`).toBe(0);
  await expectRenderLoopAlive(page, `after the ${p.name} belt`);
}

/** Build both pairs, draw the first at scale 1 and the second below scale 1. */
async function walkPairs(page: Page, pairs: readonly Pair[]): Promise<void> {
  const cells = pairs.flatMap((p) => [p.belt, sinkCell(p), sourceCell(p)]);
  await emptyBoardAtScaleOne(page, [...cells, FLOOR_AT]);
  for (const p of pairs) await buildPair(page, p);
  await expectRenderLoopAlive(page, 'with both machine pairs built');
  expect((await cameraOf(page)).scale, `${pairs[0].name}: drawn at camera scale 1`).toBe(1);
  await drawAndGrade(page, pairs[0]);
  const scale = await zoomBelowOne(page, pairs[1].belt);
  console.log(`P89-ONE-TILE ${pairs[1].name}: camera scale ${scale}`);
  await drawAndGrade(page, pairs[1]);
}

test.describe('89 live: a one-tile belt is drawn and animated flowing the way it was drawn (BELT-10)', () => {
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    try {
      await expectRenderLoopAlive(page, 'at the end of the test');
      errs.assertNone('the one-tile belt walk');
    } finally {
      await restoreHostAfterFailedTest(page, testInfo);
    }
  });

  test('1: a one-tile belt between a Source and a Sink, flowing West, is drawn and animated flowing West', async ({ page }) => {
    await walkPairs(page, WEST_PAIRS);
  });

  test('2: a one-tile belt between a Source and a Sink, flowing North, is drawn and animated flowing North', async ({ page }) => {
    await walkPairs(page, NORTH_PAIRS);
  });
});
