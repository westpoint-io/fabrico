import { test, expect, type Page } from '@playwright/test';
import {
  buildPacket,
  mockRenderSocket,
  waitForChrome,
  type Harness,
  type InjectNode,
  type InjectWire,
  waitForBoard,
} from './support/wire';

// reroute-mark.spec.ts (plan 75-06, CABLE-07, the mock half) - a cable that a DIFF packet
// re-sends on a NEW path is painted in the build accent on the running app's own `cables`
// Graphics, and a cable re-sent for any other reason is not.
//
// THE RULING (75-CONTEXT D-07): "Trigger on any cause: a diff packet re-sending an existing
// wire whose PATH differs (compare the path only; the host re-sends a wire on every pulse
// change, render_packet.rs:871, so comparing whole wires would flash constantly) ... A
// rewind or keyframe clears it, so undo, redo and board swaps never flash ... Tested by
// reading what is drawn, never a flag."
//
// THE READ. `window.__fabrico.rerouteMarkStrokes()` counts the strokes in
// `skin.palette.accents.build` the `cables` Graphics holds after the last frame, off its
// own `context.instructions`. A page-side sampler reads it once per animation frame and
// keeps the maximum, so a mark that was on screen for even one frame is seen.
//
// THE LEGS
//   1. Packet A (full) draws one wire on row 4; diff packet B re-sends the SAME wire id on
//      row 5 with its two machines moved to match. The mark is plotted within a few
//      frames. RED at the instrument commit (count 0).
//   2. Diff packet B re-sends the wire on the SAME path with a pulse on it (the comet
//      shape). No mark across the sampled frames.
//   3. Packet B re-sends the wire on the new path as a FULL packet (the undo, redo and
//      load shape). No mark across the sampled frames.
//
// Fixture paths are straight runs: `buildPacket` refuses a turning path (75-RESEARCH
// Pitfall 8). Expiry is NOT graded here: the mock render clock stops at the last injected
// tick (Pitfall 5), so the envelope is graded in `wires.test.ts` on explicit clocks.

const WIRE_ID = 40;
const FROM_ID = 21;
const TO_ID = 22;
/** Animation frames sampled per leg. */
const FRAMES = 30;

/** Two kind-9 ENDPOINTs on `row`, Out@1 of the left facing E, In@0 of the right facing W. */
function endpoints(row: number): InjectNode[] {
  const at = (id: number, x: number): InjectNode => ({
    id,
    kind: 9,
    cell_x: x,
    cell_y: row,
    ports: [
      { index: 0, cell_x: x, cell_y: row, side: 3, role: 0, medium: 1 },
      { index: 1, cell_x: x, cell_y: row, side: 1, role: 1, medium: 1 },
    ],
  });
  return [at(FROM_ID, 4), at(TO_ID, 9)];
}

/** The one wire, straight along `row` from (4,row) to (9,row). */
function wireOn(row: number, pulses: InjectWire['pulses'] = []): InjectWire {
  const path: [number, number][] = [];
  for (let x = 4; x <= 9; x++) path.push([x, row]);
  return {
    id: WIRE_ID,
    from: { node: FROM_ID, port: 1 },
    to: { node: TO_ID, port: 0 },
    path,
    pulses,
  };
}

/** Boot the mocked app and land packet A: two machines, one wire on row 4. */
async function bootWithPacketA(page: Page): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  h.inject(buildPacket({ tick: 10, full: true, nodes: endpoints(4), wires: [wireOn(4)] }));
  await waitForBoard(page, { machines: 2 });
  await expect.poll(() => wireRow(page), { message: 'packet A landed: the wire is on row 4' }).toBe(4);
  // A few frames on packet A alone, so the first sighting is drawn before B arrives.
  expect(await maxMarkOverFrames(page, 5), 'packet A, a first sighting, paints no mark').toBe(0);
  return h;
}

/** The row the held wire's first cell sits on, or null when no wire is held. */
async function wireRow(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __fabrico: { scene(): { wires: { path: { cell_y: number }[]; pulses: unknown[] }[] } };
      }
    ).__fabrico.scene();
    return s.wires[0]?.path[0]?.cell_y ?? null;
  });
}

/** The held wire's pulse count. */
async function wirePulseCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = (
      window as unknown as { __fabrico: { scene(): { wires: { pulses: unknown[] }[] } } }
    ).__fabrico.scene();
    return s.wires[0]?.pulses.length ?? -1;
  });
}

/** Read `rerouteMarkStrokes()` once per animation frame for `frames` frames; the maximum. */
async function maxMarkOverFrames(page: Page, frames: number): Promise<number> {
  return page.evaluate(
    (n) =>
      new Promise<number>((resolve, reject) => {
        const hook = (window as unknown as { __fabrico?: { rerouteMarkStrokes?(): number } }).__fabrico;
        if (!hook) {
          reject(new Error('window.__fabrico not installed'));
          return;
        }
        if (typeof hook.rerouteMarkStrokes !== 'function') {
          reject(new Error('window.__fabrico.rerouteMarkStrokes() not installed'));
          return;
        }
        let max = 0;
        let left = n;
        const step = (): void => {
          max = Math.max(max, hook.rerouteMarkStrokes!());
          left -= 1;
          if (left <= 0) resolve(max);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
}

test.describe('CABLE-07 mock: a cable re-sent on a new path is marked, and only then', () => {
  test('a diff re-sending a wire on a new path paints the re-route mark', async ({ page }) => {
    const h = await bootWithPacketA(page);
    h.inject(buildPacket({ tick: 11, full: false, nodes: endpoints(5), wires: [wireOn(5)] }));
    await expect.poll(() => wireRow(page), { message: 'packet B landed: the wire moved to row 5' }).toBe(5);
    expect(
      await maxMarkOverFrames(page, FRAMES),
      'the moved cable is stroked in the build accent within a few frames',
    ).toBeGreaterThan(0);
  });

  test('a pulse-only re-send paints no mark', async ({ page }) => {
    const h = await bootWithPacketA(page);
    h.inject(
      buildPacket({
        tick: 11,
        full: false,
        wires: [wireOn(4, [{ entry_tick: 11, hop_ticks: 1, direction: 0 }])],
      }),
    );
    await expect
      .poll(() => wirePulseCount(page), { message: 'packet B landed: the same wire now carries a pulse' })
      .toBe(1);
    expect(await wireRow(page), 'the path did not move').toBe(4);
    expect(await maxMarkOverFrames(page, FRAMES), 'a re-send for a pulse paints no mark').toBe(0);
  });

  test('a full re-send paints no mark', async ({ page }) => {
    const h = await bootWithPacketA(page);
    h.inject(buildPacket({ tick: 11, full: true, nodes: endpoints(5), wires: [wireOn(5)] }));
    await expect.poll(() => wireRow(page), { message: 'packet B landed: the wire moved to row 5' }).toBe(5);
    expect(
      await maxMarkOverFrames(page, FRAMES),
      'a keyframe (undo, redo, load) that moves a cable paints no mark',
    ).toBe(0);
  });
});
