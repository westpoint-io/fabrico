import { execSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { nubAnchor } from '../shared/geometry';
import type { TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { BELTS_THAT_JOIN } from '../src/tutorial/lessons/beltsThatJoin';
import { phrasePlain } from '../src/tutorial/phrase';
import type { Stage } from '../src/tutorial/types';
import { CELL, CMD, buildPacket, cameraOf, type Harness, type InjectBelt, type InjectNode, type InjectTileKind } from './support/wire';

/** The revision this run reads, for the MEASURE lines. */
const REV = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
import {
  CARD,
  EAST_TO_SOUTH,
  JOINER_ID,
  JOIN_SINK_IN,
  JOIN_STUB_ID,
  OLD_MACHINE,
  RING_CELL,
  SINK_ID,
  SINK_DEBUG,
  SOURCE_ID,
  SOURCE_TIMER,
  beltsThatJoinBoard,
  boot,
  configByNode,
  joinStub,
  joinedBoard,
  pressRing,
  readProbe,
  ringAt,
  sentCount,
  startLesson,
} from './support/lessonMock';

// lesson-join.spec.ts - Belts that join on the mock host, from Start to Lesson done.
//
// The board arrives as the host builds it: a Source at (1,2), a four-tile stub running east to (5,2) with
// its Head free, and a Sink at (6,6) with its In facing north. The cell past the stub's end, (6,2), is the
// ring cell: the app rings it while the Belt tool is armed, and the join must turn a corner there. The
// mock packet writer ships that cell as the Corner the host derives from the seam with the stub, so the
// step finishes on the same tile kind the user sees drawn.
//
// The frame cases read the camera on every animation frame from the board's keyframe to the first frame
// the card reads Step 1 of 3. The App's own fit runs on that keyframe and the tutorial then frames the
// board at zoom 1, so any frame drawn with the prepared board at another zoom is counted and logged as
// MEASURE fit-jump.

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;
const TOLERANCE = 1;
const LEGEND = '#fab-legend-panel';
/** The free area's top, the dock line under the toolbar (`FREE_AREA_TOP_PX` in TutorialLayer.tsx). */
const FREE_TOP = 116;
const BAND = '#fab-refusal';
const NOTE = `${CARD} [data-fab-step-note]`;
/** `CLIENT_REFUSAL_COPY.BeltEndTile`, mirrored because the band's copy module pulls in SVG assets the e2e runner can't load. */
const BELT_END_TILE_WORDS = "Start from the ring past the belt's end.";

/** The box the tutorial frames, in cells: the Source column to the ring column, the stub's row to the Sink's. */
const FRAME_BOX = { x: 1, y: 2, w: 6, h: 5 } as const;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function stageOf(stepId: string, stageId: string): Stage {
  const stage = BELTS_THAT_JOIN.steps.find((s) => s.id === stepId)?.stages.find((s) => s.id === stageId);
  if (stage === undefined) throw new Error(`lesson 2 has no stage ${stepId}/${stageId}`);
  return stage;
}

const words = (stepId: string, stageId: string): string => phrasePlain(stageOf(stepId, stageId).text);
const COACH_LINE = phrasePlain(stageOf('join-belt', 'belt-carry-on').coach?.BeltEndTile ?? []);

/** The host for lesson 2: the Source answers Timer and the Sink Debug, as the board file configures them. */
function joinHost(): ReturnType<typeof configByNode> {
  const host = configByNode();
  host.set(SOURCE_ID, SOURCE_TIMER);
  host.set(SINK_ID, SINK_DEBUG);
  return host;
}

let tick = 10;
/** A diff of the prepared board's generation, at the next tick. */
function diff(board: { nodes: InjectNode[]; belts: InjectBelt[] }, extra: { removed?: number[]; tick?: number } = {}): Buffer {
  tick = extra.tick ?? tick + 1;
  return buildPacket({ full: false, tick, generation: 1, swapFloor: 1, ...board, removed: extra.removed });
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
}

async function pause(page: Page, h: Harness): Promise<void> {
  const before = h.controls.filter((c) => c === 'pause').length;
  await page.locator('header button[aria-label="Pause"]').click();
  await expect.poll(() => h.controls.filter((c) => c === 'pause').length, { message: 'the Pause press reached the host' }).toBe(before + 1);
  await blur(page);
}

async function play(page: Page, h: Harness): Promise<void> {
  const before = h.controls.filter((c) => c === 'resume').length;
  await page.locator('header button[aria-label="Play"]').click();
  await expect.poll(() => h.controls.filter((c) => c === 'resume').length, { message: 'the Play press reached the host' }).toBe(before + 1);
  await blur(page);
}

async function openLegend(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Legend' }).click();
  await expect(page.locator(LEGEND), 'the Legend is open').toBeVisible();
  await blur(page);
}

/** Poll until the probe names this step and stage. */
async function expectStage(page: Page, stepId: string, stageId: string, message: string): Promise<TutorialProbe> {
  await expect
    .poll(async () => {
      const p = await readProbe(page);
      return `${p.stepId}/${p.stageId}`;
    }, { message })
    .toBe(`${stepId}/${stageId}`);
  return readProbe(page);
}

/** Boot, then start lesson 2 on its prepared board, with `beforeBoard` run while the loading card is up. */
async function startJoin(page: Page, beforeBoard?: (h: Harness) => Promise<void>): Promise<Harness> {
  const host = joinHost();
  const h = await boot(page, host.opts);
  tick = 10;
  await startLesson(page, h, BELTS_THAT_JOIN, beforeBoard === undefined ? undefined : () => beforeBoard(h));
  return h;
}

/** Arm the Belt tool through its ring at belt-tool, and wait for the carry-on stage. */
async function armBelt(page: Page): Promise<void> {
  await pressRing(page, await ringAt(page, 'belt-tool'));
  await ringAt(page, 'belt-carry-on');
}

/** A world cell's square in window px, through the camera. */
async function cellRect(page: Page, cx: number, cy: number, w = 1, hh = 1): Promise<Rect> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  return { x: cx * size + cam.x, y: cy * size + cam.y, width: w * size, height: hh * size };
}

/** The free area by `readFreeArea`'s rule, and the card's rect, from one evaluate. */
async function freeAndCard(page: Page): Promise<{ free: Rect; card: Rect | null }> {
  return page.evaluate(
    ([legendSel, freeTop]) => {
      const rect = (el: Element | null): DOMRect | null => {
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return r.width === 0 || r.height === 0 ? null : r;
      };
      const card = rect(document.querySelector('[data-fab-step-card]'));
      const legend = rect(document.querySelector(legendSel));
      const dock = document.querySelector('[data-fab-left-dock]');
      const left = dock === null ? 0 : dock.getBoundingClientRect().right;
      const right = window.innerWidth - 24 - (Math.min(420, 0.33 * window.innerWidth) + 2 * 22 + 8);
      const bottom = Math.min(card === null ? window.innerHeight : card.y, legend === null ? window.innerHeight : legend.y);
      return {
        free: { x: left, y: freeTop, width: right - left, height: bottom - freeTop },
        card: card === null ? null : { x: card.x, y: card.y, width: card.width, height: card.height },
      };
    },
    [LEGEND, FREE_TOP] as const,
  );
}

function within(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - TOLERANCE &&
    inner.y >= outer.y - TOLERANCE &&
    inner.x + inner.width <= outer.x + outer.width + TOLERANCE &&
    inner.y + inner.height <= outer.y + outer.height + TOLERANCE
  );
}

function meets(a: Rect, b: Rect): boolean {
  return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
}

const fmt = (r: Rect | null): string => (r === null ? 'none' : [r.x, r.y, r.width, r.height].map((v) => v.toFixed(1)).join(','));

/** The kind the app's scene holds for the belt tile on this cell, or null with none. */
async function sceneKindAt(page: Page, cx: number, cy: number): Promise<unknown> {
  return page.evaluate(
    ([x, y]) => {
      const scene = (window as unknown as { __fabrico: { scene(): { belts: { tiles: { cell_x: number; cell_y: number; kind: unknown }[] }[] } } }).__fabrico.scene();
      for (const b of scene.belts) {
        const t = b.tiles.find((tile) => tile.cell_x === x && tile.cell_y === y);
        if (t !== undefined) return t.kind;
      }
      return null;
    },
    [cx, cy] as const,
  );
}

/** The resting target rings the overlay plotted, in the coordinates it plots them in. */
async function restingRings(page: Page): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico: { targetRingsPlotted(): { resting: Array<{ x: number; y: number }> } } }).__fabrico;
    return hook.targetRingsPlotted().resting.map((r) => ({ x: r.x, y: r.y }));
  });
}

/** Does the overlay paint a resting ring on this cell's centre, read in world px or in window px? */
async function ringOnCell(page: Page, cx: number, cy: number): Promise<boolean> {
  const rings = await restingRings(page);
  const cam = await cameraOf(page);
  const wx = (cx + 0.5) * CELL;
  const wy = (cy + 0.5) * CELL;
  const sx = wx * cam.scale + cam.x;
  const sy = wy * cam.scale + cam.y;
  return rings.some((r) => (Math.abs(r.x - wx) <= 1 && Math.abs(r.y - wy) <= 1) || (Math.abs(r.x - sx) <= 1 && Math.abs(r.y - sy) <= 1));
}

/** The lesson's disc on the Sink's In: its centre against the In dot's anchor through the camera, in px. */
async function discErrorOnSinkIn(page: Page): Promise<number> {
  const probe = await readProbe(page);
  const cam = await cameraOf(page);
  const ring = probe.hint;
  if (ring === null || ring.shape !== 'circle') return Number.POSITIVE_INFINITY;
  const at = nubAnchor(JOIN_SINK_IN.cell_x, JOIN_SINK_IN.cell_y, JOIN_SINK_IN.side);
  const c = ring.hitCentre ?? { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
  return Math.max(Math.abs(c.x - (at.x * cam.scale + cam.x)), Math.abs(c.y - (at.y * cam.scale + cam.y)));
}

/** Keep every sentence the band shows from now on, in the page, so a band that clears before the read is still seen. */
async function recordBand(page: Page): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} is not mounted`);
    const w = window as unknown as { __bandSentences: string[] };
    w.__bandSentences = [];
    new MutationObserver(() => {
      const text = el.textContent?.trim() ?? '';
      if (text !== '' && w.__bandSentences.at(-1) !== text) w.__bandSentences.push(text);
    }).observe(el, { characterData: true, childList: true, subtree: true });
  }, BAND);
}

test.describe('Belts that join on the mock host', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('the mock writer ships a Corner the app reads back, and refuses a turn it was not told the kind of', async ({ page }) => {
    // A turn with no named kind throws, and so does a Corner the host could never ship.
    const turning: InjectBelt = { id: 9, tiles: [[5, 2], [6, 2], [6, 3]] };
    expect(() => buildPacket({ belts: [turning] }), 'an unnamed turn').toThrow('straight orthogonal runs');
    const reversed: InjectBelt = { ...turning, kinds: [undefined, { Corner: { from: 1, to: 3 } }] };
    expect(() => buildPacket({ belts: [reversed] }), 'a Corner from east to west').toThrow('perpendicular');
    const named: InjectBelt = { ...turning, kinds: [undefined, EAST_TO_SOUTH] };
    expect(() => buildPacket({ belts: [named] }), 'a named turn').not.toThrow();

    // The named Corner reaches the app's scene as the decoder reads the host's.
    const h = await boot(page);
    h.inject(buildPacket({ full: false, tick: 4, nodes: [OLD_MACHINE], belts: [named] }));
    await expect.poll(() => sceneKindAt(page, 6, 2), { message: 'the scene holds the Corner on the turning cell' }).toEqual({ Corner: { from: 1, to: 2 } });
    expect(await sceneKindAt(page, 5, 2), 'the tile before it is a Straight across').toEqual({ Straight: { axis: 0 } });
    expect(await sceneKindAt(page, 6, 3), 'the tile after it is a Straight down').toEqual({ Straight: { axis: 1 } });
  });

  test('plays from Start to Lesson done: the loading line, the framed board, both rings, the join with its Corner, Play and the arrival', async ({ page }) => {
    const h = await startJoin(page);
    const card = page.locator(CARD);

    // Step 1 opens on the belt-tool stage, with the board playing.
    let probe = await expectStage(page, 'join-belt', 'belt-tool', 'the prepared board opens step 1 on the belt-tool stage');
    expect(probe.bound, 'the prepared Source and Sink are bound').toEqual({ source: SOURCE_ID, sink: SINK_ID });
    await expect(card.locator('[data-fab-step-text]')).toHaveText(words('join-belt', 'belt-tool'));
    expect((await cameraOf(page)).scale, 'the board is framed at zoom 1').toBeCloseTo(1, 2);

    // Armed: the lesson rings the Sink's In and the app rings the cell past the stub.
    await armBelt(page);
    await expect(card.locator('[data-fab-step-text]')).toHaveText(words('join-belt', 'belt-carry-on'));
    await expect.poll(() => discErrorOnSinkIn(page), { message: "the lesson's disc sits on the Sink's In" }).toBeLessThanOrEqual(TOLERANCE + 0.5);
    await expect.poll(() => ringOnCell(page, RING_CELL[0], RING_CELL[1]), { message: 'the app rings the cell past the stub' }).toBe(true);
    expect(await ringOnCell(page, 5, 2), "no ring on the stub's last tile").toBe(false);

    // Pause, so step 2 opens on its Play stage, then the join the host ships back.
    await pause(page, h);
    await expectStage(page, 'join-belt', 'board-paused', 'a paused board shows the paused stage');
    h.inject(diff(joinedBoard()));
    await expect.poll(() => sceneKindAt(page, RING_CELL[0], RING_CELL[1]), { message: 'the scene holds the Corner on the ring cell' }).toEqual({ Corner: { from: 1, to: 2 } });
    probe = await expectStage(page, 'press-play', 'board-paused', 'the join with a Corner on the ring cell finished step 1');
    expect(probe.bound.belt, 'the join binds the new piece').toBe(JOINER_ID);
    await expect(card).toContainText('Step 2 of 3');

    // Play, the tick rises, and an item reaches the Sink.
    await play(page, h);
    h.inject(diff(joinedBoard(EAST_TO_SOUTH, [5])));
    await expectStage(page, 'watch', 'watch', 'the rising tick finished press-play');
    await expect(card.locator('[data-fab-step-text]')).toHaveText(words('watch', 'watch'));
    h.inject(diff(joinedBoard(EAST_TO_SOUTH, [0])));
    h.inject(diff(joinedBoard(EAST_TO_SOUTH, [])));
    await expect.poll(async () => (await readProbe(page)).card, { message: 'the arrival finished the lesson' }).toBe('finished');
    await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
    await expect(card).toContainText(phrasePlain(BELTS_THAT_JOIN.closing));
  });

  for (const size of SIZES) {
    for (const legend of [false, true]) {
      const label = `${size.width}x${size.height} legend=${legend ? 'open' : 'closed'}`;
      test(`frames the prepared board at zoom 1 inside the free area within two frames of Step 1 of 3, at ${label}`, async ({ page }) => {
        await page.setViewportSize(size);
        const host = joinHost();
        const h = await boot(page, host.opts);
        tick = 10;
        if (legend) await openLegend(page);
        await startLesson(page, h, BELTS_THAT_JOIN, async () => {
          // Read the camera on every frame from here to two frames past the first that reads Step 1 of 3.
          await page.evaluate(() => {
            type Hook = { camera(): { scale: number }; scene(): { nodes: { kind: number; cells: [number, number][] }[] } };
            const w = window as unknown as { __fabrico: Hook; __joinFrames: Array<{ scale: number; prepared: boolean; step1: boolean }> };
            w.__joinFrames = [];
            let after = -1;
            const read = (): void => {
              const scene = w.__fabrico.scene();
              const prepared =
                scene.nodes.some((n) => n.kind === 0 && n.cells.some((c) => c[0] === 1 && c[1] === 2)) &&
                scene.nodes.some((n) => n.kind === 7 && n.cells.some((c) => c[0] === 6 && c[1] === 6));
              const text = document.querySelector('[data-fab-step-card]')?.textContent ?? '';
              const step1 = text.includes('Step 1 of 3');
              w.__joinFrames.push({ scale: w.__fabrico.camera().scale, prepared, step1 });
              if (step1 && after < 0) after = 0;
              if (after >= 0) after += 1;
              if (after <= 3 && w.__joinFrames.length < 2000) requestAnimationFrame(read);
            };
            requestAnimationFrame(read);
          });
        });

        type Frame = { scale: number; prepared: boolean; step1: boolean };
        const readFrames = (): Promise<Frame[]> => page.evaluate(() => (window as unknown as { __joinFrames: Frame[] }).__joinFrames);
        // The reader stops three frames past the first that reads Step 1 of 3.
        await expect
          .poll(async () => {
            const f = await readFrames();
            const at = f.findIndex((x) => x.step1);
            return at >= 0 && f.length >= at + 3;
          }, { message: 'the frame reader saw Step 1 of 3 and two frames after it' })
          .toBe(true);
        const frames = await readFrames();
        const first = frames.findIndex((f) => f.step1);
        const atFit = frames.slice(0, first + 1).filter((f) => f.prepared && Math.abs(f.scale - 1) > 0.01).length;
        console.log(`MEASURE fit-jump size=${size.width}x${size.height} legend=${legend ? 'open' : 'closed'} frames_at_fit=${atFit} rev=${REV} scales=${frames.map((f) => `${f.prepared ? '' : '-'}${f.scale.toFixed(2)}${f.step1 ? '*' : ''}`).join(',')}`);
        const twoOn = frames[first + 2];
        expect(twoOn.scale, `two frames after Step 1 of 3 the camera reads zoom 1 (read ${twoOn.scale.toFixed(3)})`).toBeCloseTo(1, 2);

        const cam = await cameraOf(page);
        expect(cam.scale, `the camera reads zoom 1 (read ${cam.scale.toFixed(3)})`).toBeCloseTo(1, 2);
        const box = await cellRect(page, FRAME_BOX.x, FRAME_BOX.y, FRAME_BOX.w, FRAME_BOX.h);
        const { free, card } = await freeAndCard(page);
        console.log(`MEASURE frame size=${size.width}x${size.height} legend=${legend ? 'open' : 'closed'} scale=${cam.scale.toFixed(3)} box=${fmt(box)} free=${fmt(free)} card=${fmt(card)}`);
        expect(within(box, free), `the box ${fmt(box)} lies inside the free area ${fmt(free)}`).toBe(true);
        expect(card, 'the card is up').not.toBeNull();
        expect(meets(box, card as Rect), `the box ${fmt(box)} is clear of the card ${fmt(card)}`).toBe(false);
      });
    }
  }
});

