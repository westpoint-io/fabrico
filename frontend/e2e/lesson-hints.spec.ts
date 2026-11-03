import { test, expect, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../src/chrome/tutorial/TutorialLayer';
import { nubAnchor } from '../shared/geometry';
import { doorstepCell, dropHitRadiusWorld } from '../src/protocol/ports';
import { CELL, buildPacket, cameraOf, type InjectBelt, type InjectNode } from './support/wire';
import { OUTSET, SOURCE_ID, boot, configuredHost, placeBoth, readProbe, ringAt, startLesson, toBeltDraw } from './support/lessonMock';

// lesson-hints.spec.ts - a port ring is the size of the spot the gesture accepts, by port role (HINT-02).
//
// The ring where a drag ends is a disc whose inner edge is the belt release's hit circle, read from
// `dropHitRadiusWorld`, the radius `headInAt` passes. The ring where a drag starts is a square on the
// Out port's doorstep cell, the whole tile the press check accepts. Every case reads the probe and the
// camera in one evaluate and compares rects, never a screenshot.

const TOLERANCE = 1;
const BELT_ID = 4;
/** One wheel notch the camera reads as a mouse wheel: whole, vertical and at least 50. Each moves the scale by e^0.09. */
const WHEEL_NOTCH = 60;

type Port = { cell_x: number; cell_y: number; side: number };

/** One read of the probe and the camera together, so a ring and the camera it was painted under agree. */
async function probeAndCamera(page: Page): Promise<{ probe: TutorialProbe; cam: { x: number; y: number; scale: number } }> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico: { tutorial(): TutorialProbe; camera(): { x: number; y: number; scale: number } } }).__fabrico;
    return { probe: hook.tutorial(), cam: hook.camera() };
  });
}

/** The worst edge or size error of a square ring on `port`'s doorstep cell plus the outset. */
function squareError(r: HintRect | null, port: Port, cam: { x: number; y: number; scale: number }): number {
  if (r === null) return Number.POSITIVE_INFINITY;
  const [dx, dy] = doorstepCell(port);
  const size = CELL * cam.scale;
  return Math.max(
    Math.abs(r.x - (dx * size + cam.x - OUTSET)),
    Math.abs(r.y - (dy * size + cam.y - OUTSET)),
    Math.abs(r.width - (size + 2 * OUTSET)),
    Math.abs(r.height - (size + 2 * OUTSET)),
  );
}

/**
 * The worst error of a disc ring on `port`'s dot: its box `2r + 4` across and centred on the dot, and
 * the probe's `hitRadiusPx` and `hitCentre` on the release's hit circle, `r = dropHitRadiusWorld(scale) * scale`.
 */
function discError(r: HintRect | null, port: Port, cam: { x: number; y: number; scale: number }): number {
  if (r === null || r.hitCentre === undefined || r.hitRadiusPx === undefined) return Number.POSITIVE_INFINITY;
  const a = nubAnchor(port.cell_x, port.cell_y, port.side);
  const cx = a.x * cam.scale + cam.x;
  const cy = a.y * cam.scale + cam.y;
  const hit = dropHitRadiusWorld(cam.scale) * cam.scale;
  const d = 2 * hit + 4;
  return Math.max(
    Math.abs(r.x + r.width / 2 - cx),
    Math.abs(r.y + r.height / 2 - cy),
    Math.abs(r.width - d),
    Math.abs(r.height - d),
    Math.abs(r.hitRadiusPx - hit),
    Math.abs(r.hitCentre.x - cx),
    Math.abs(r.hitCentre.y - cy),
  );
}

/** Wheel at `at` one notch at a time until the camera's scale reads in `[lo, hi]`. A notch is narrower than the range, so it can't jump over it. */
async function zoomInto(page: Page, at: { x: number; y: number }, lo: number, hi: number): Promise<number> {
  await page.mouse.move(at.x, at.y);
  for (let notch = 0; notch < 40; notch++) {
    const { scale } = await cameraOf(page);
    if (scale >= lo && scale <= hi) return scale;
    await page.mouse.wheel(0, scale > hi ? WHEEL_NOTCH : -WHEEL_NOTCH);
    await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the wheel notch moved the zoom' }).not.toBe(scale);
  }
  throw new Error(`the zoom never reached [${lo}, ${hi}]`);
}

/** The belt-draw rings, polled until both sit on their ports: a square on the Source's doorstep and a disc on the Sink's In. */
async function expectBeltDrawRings(page: Page, out: Port, into: Port, what: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const { probe, cam } = await probeAndCamera(page);
        if (probe.stageId !== 'belt-draw') return `on stage ${probe.stageId}`;
        if (probe.hint?.shape !== 'square' || probe.hintTo?.shape !== 'circle') return `shapes ${probe.hint?.shape}/${probe.hintTo?.shape}`;
        return Math.max(squareError(probe.hint, out, cam), discError(probe.hintTo, into, cam)) <= TOLERANCE ? 'on their ports' : 'off';
      },
      { message: `${what}: the press square on the doorstep and the drop disc on the In dot` },
    )
    .toBe('on their ports');
}

/** Lesson 1 up to belt-draw on the mock host, with the Source's Out and the Sink's In. */
async function toBeltDrawRings(page: Page): Promise<{ out: Port; into: Port; source: InjectNode; sink: InjectNode; tick: number; h: Awaited<ReturnType<typeof boot>> }> {
  const host = configuredHost();
  const h = await boot(page, host.opts);
  await startLesson(page, h);
  const { source, sink, tick } = await placeBoth(page, h);
  await toBeltDraw(page, host);
  return { out: source.ports![0]!, into: sink.ports![1]!, source, sink, tick, h };
}

test.describe('disc', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('at belt-draw the press ring is a square on the doorstep and the drop ring a disc on the dot, at two zooms', async ({ page }) => {
    const { out, into } = await toBeltDrawRings(page);
    const { cam } = await probeAndCamera(page);
    // Between the two machines, kept inside the board's free middle so the wheel lands on the canvas
    // and not on a panel or the card, which take the wheel themselves.
    const a = nubAnchor(into.cell_x, into.cell_y, into.side);
    const [dx, dy] = doorstepCell(out);
    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
    const mid = {
      x: clamp((((dx + 0.5) * CELL + a.x) / 2) * cam.scale + cam.x, 320, 760),
      y: clamp((((dy + 0.5) * CELL + a.y) / 2) * cam.scale + cam.y, 180, 480),
    };

    const low = await zoomInto(page, mid, 0.5, 1);
    expect(low, 'the first zoom is at or below 1').toBeLessThanOrEqual(1);
    await expectBeltDrawRings(page, out, into, `zoom ${low.toFixed(2)}`);

    const high = await zoomInto(page, mid, 1.9, 2.1);
    expect(high, 'the second zoom is above 1.5').toBeGreaterThan(1.5);
    await expectBeltDrawRings(page, out, into, `zoom ${high.toFixed(2)}`);
    const { probe, cam: camHigh } = await probeAndCamera(page);
    expect(Math.abs(probe.hintTo!.hitRadiusPx! - dropHitRadiusWorld(camHigh.scale) * camHigh.scale), 'the hit radius grows with the zoom').toBeLessThanOrEqual(TOLERANCE);
    expect(probe.hintTo!.width, 'the disc is wider than at zoom 1').toBeGreaterThan(28 + TOLERANCE);
  });

  test('at belt-carry-on the one ring is a disc on the Sink In', async ({ page }) => {
    const { into, source, sink, tick, h } = await toBeltDrawRings(page);
    // A belt from the Source that stops short: its Tail on the Source's Out, its Head docked to nothing.
    const belt: InjectBelt = {
      id: BELT_ID,
      tiles: [
        [source.cell_x + 1, source.cell_y],
        [source.cell_x + 2, source.cell_y],
      ],
      docks: [{ end: 'Tail', node: SOURCE_ID, port: 0 }],
    };
    h.inject(buildPacket({ full: false, tick: tick + 1, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [belt] }));
    await ringAt(page, 'belt-carry-on');
    await expect
      .poll(
        async () => {
          const { probe, cam } = await probeAndCamera(page);
          if (probe.stageId !== 'belt-carry-on') return `on stage ${probe.stageId}`;
          if (probe.hint?.shape !== 'circle') return `the ring is a ${probe.hint?.shape}`;
          if (probe.hintTo !== null) return 'a second ring';
          return discError(probe.hint, into, cam) <= TOLERANCE ? 'a disc on the In' : 'off the In';
        },
        { message: "belt-carry-on's ring is a disc on the Sink's In" },
      )
      .toBe('a disc on the In');
    await expect(page.locator('[data-fab-hint] > div'), 'the disc carries the round paint').toHaveClass(/\bfab-hint--port\b/);
  });

  test('only a disc carries the round paint class', async ({ page }) => {
    await toBeltDrawRings(page);
    const read = await readProbe(page);
    expect(`${read.hint?.shape}/${read.hintTo?.shape}`).toBe('square/circle');
    await expect(page.locator('[data-fab-hint] > div'), 'the press square').toHaveClass('fab-hint');
    await expect(page.locator('[data-fab-hint-to] > div'), 'the drop disc').toHaveClass('fab-hint fab-hint--port');
    await expect(page.locator('[data-fab-hint]'), 'a square carries no hit radius').not.toHaveAttribute('data-fab-hit-r');
    await expect(page.locator('[data-fab-hint-to]'), 'a disc carries its hit radius').toHaveAttribute('data-fab-hit-r', /^\d+(\.\d+)?$/);
  });
});

// The pulse (HINT-04, UI-SPEC "Pulse"): the ring's paint fades by opacity only, to 0.6 on the board and 0.8
// on a panel, over 1600 ms, and holds at opacity 1 under prefers-reduced-motion. The reduced run is paired
// with a no-preference run that shows the animation running, so a ring that never pulsed can't pass. The
// second run is a fresh page, as `a11y.spec.ts` does it: an emulated preference reaches a page it loads.

/** One read per animation frame of the main ring's paint and the element the frame loop moves. */
interface PulseSample {
  opacity: number;
  running: string[];
  className: string;
  box: { x: number; y: number; width: number; height: number };
}

const PULSE_MS = 1600;
const SAMPLE_MS = 1700;

async function samplePulse(page: Page): Promise<PulseSample[]> {
  return page.evaluate(
    (ms) =>
      new Promise<PulseSample[]>((done) => {
        const out: PulseSample[] = [];
        const start = performance.now();
        const tick = (): void => {
          const ring = document.querySelector<HTMLElement>('[data-fab-hint]');
          const paint = ring?.firstElementChild as HTMLElement | null | undefined;
          if (ring && paint) {
            const r = ring.getBoundingClientRect();
            out.push({
              opacity: Number(getComputedStyle(paint).opacity),
              running: paint
                .getAnimations()
                .filter((a) => a.playState === 'running')
                .map((a) => (a as CSSAnimation).animationName ?? ''),
              className: paint.className,
              box: { x: r.x, y: r.y, width: r.width, height: r.height },
            });
          }
          if (performance.now() - start < ms) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    SAMPLE_MS,
  );
}

/** Start lesson 1 and sample the panel ring at source-tool, then the board ring at source-floor. */
async function sampleBothRings(page: Page): Promise<{ panel: PulseSample[]; board: PulseSample[] }> {
  const h = await boot(page);
  await startLesson(page, h);
  await ringAt(page, 'source-tool');
  const panel = await samplePulse(page);
  await page.getByRole('button', { name: 'Place Source', exact: true }).click();
  await ringAt(page, 'source-floor');
  const board = await samplePulse(page);
  return { panel, board };
}

/** The moving element's box at every sample, against the first, within half a pixel. */
function expectStill(samples: readonly PulseSample[], what: string): void {
  const first = samples[0]!.box;
  const worst = Math.max(
    ...samples.map((s) => Math.max(Math.abs(s.box.x - first.x), Math.abs(s.box.y - first.y), Math.abs(s.box.width - first.width), Math.abs(s.box.height - first.height))),
  );
  expect(worst, `${what}: the ring's edge stays put while it pulses`).toBeLessThanOrEqual(0.5);
}

test.describe('pulse', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the ring holds at opacity 1 under reduced motion, and pulses by opacity without the preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await sampleBothRings(page);
    for (const [what, samples, cls] of [
      ['the panel ring', still.panel, 'fab-hint fab-hint--panel'],
      ['the board ring', still.board, 'fab-hint'],
    ] as const) {
      expect(samples.length, `${what}: the sampler ran across ${SAMPLE_MS} ms`).toBeGreaterThan(20);
      expect(samples[0]!.className, `${what}: its paint class`).toBe(cls);
      expect([...new Set(samples.flatMap((s) => s.running))], `${what}: no animation runs under reduced motion`).toEqual([]);
      expect([...new Set(samples.map((s) => s.opacity))], `${what}: opacity stays 1`).toEqual([1]);
      expectStill(samples, what);
    }

    // The same lesson on a fresh page with no motion preference.
    // It shares the first page's storage, where Start left the lesson In progress, so the row would offer
    // Restart. Clear that before the app reads it.
    const second = await page.context().newPage();
    await second.addInitScript(() => localStorage.removeItem('fab.tutorial.v1'));
    await second.emulateMedia({ reducedMotion: 'no-preference' });
    const live = await sampleBothRings(second);
    expect(live.panel.length).toBeGreaterThan(20);
    expect(live.board.length).toBeGreaterThan(20);
    expect([...new Set(live.panel.flatMap((s) => s.running))], 'the panel ring runs the shallow pulse').toEqual(['fab-hint-pulse-panel']);
    expect([...new Set(live.board.flatMap((s) => s.running))], 'the board ring runs the deep pulse').toEqual(['fab-hint-pulse']);
    const low = (s: readonly PulseSample[]): number => Math.min(...s.map((x) => x.opacity));
    expect(low(live.board), `the board ring fades below 0.9 within one ${PULSE_MS} ms period`).toBeLessThan(0.9);
    expect(low(live.board), 'and no lower than 0.6').toBeGreaterThanOrEqual(0.6 - 0.01);
    expect(low(live.panel), 'the panel ring fades too').toBeLessThan(0.95);
    expect(low(live.panel), 'but never below 0.79, to keep 3:1 on the panel').toBeGreaterThanOrEqual(0.79);
    expectStill(live.panel, 'the pulsing panel ring');
    expectStill(live.board, 'the pulsing board ring');
    await second.close();
  });
});
