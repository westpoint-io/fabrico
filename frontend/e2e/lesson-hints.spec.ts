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
