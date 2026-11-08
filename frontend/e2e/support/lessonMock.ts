// lessonMock.ts - the mock-host lesson helpers every lesson spec shares.
//
// Moved out of `lessons.spec.ts` unchanged, so a second lesson spec boots, starts a lesson and walks
// its steps the same way. The ring's rect comes from `ringAt`, which waits for one read of
// `window.__fabrico.tutorial()` that names the stage and holds a rect: the probe reports a rect only
// once the ring has moved for that stage, so a single read straight after a stage change could catch
// the ring a frame early.

import { expect, type Locator, type Page } from '@playwright/test';
import type { HintRect, TutorialProbe } from '../../src/chrome/tutorial/TutorialLayer';
import type { MachineConfig } from '../../src/protocol/decode';
import { doorstepCell } from '../../src/protocol/ports';
import { GESTURE_REFUSAL_KIND } from '../../src/transport/transport';
import { YOUR_FIRST_LINE } from '../../src/tutorial/lessons/yourFirstLine';
import type { Lesson } from '../../src/tutorial/types';
import {
  CELL,
  buildPacket,
  cameraOf,
  mockRenderSocket,
  waitForBoard,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
} from './wire';

/** The ring's outset on each side of its target. */
export const OUTSET = 4;

export const STEP_COUNT = YOUR_FIRST_LINE.steps.length;

/** The board on screen before the lesson's New. */
export const OLD_MACHINE: InjectNode = { id: 1, kind: 7, cell_x: 12, cell_y: 8 };
export const CARD = '[data-fab-step-card]';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function readProbe(page: Page): Promise<TutorialProbe> {
  return page.evaluate(() => (window as unknown as { __fabrico: { tutorial(): TutorialProbe } }).__fabrico.tutorial());
}

/** Poll until one read names `stageId` and holds a rect, and return that read's rect. */
export async function ringAt(page: Page, stageId: string): Promise<HintRect> {
  let rect: HintRect | null = null;
  await expect
    .poll(
      async () => {
        const probe = await readProbe(page);
        if (probe.stageId !== stageId) return `on stage ${probe.stageId}`;
        rect = probe.hint;
        return rect === null ? 'no rect yet' : 'held';
      },
      { message: `the ring was placed for stage ${stageId}` },
    )
    .toBe('held');
  return rect!;
}

export async function boxOf(locator: Locator, what: string): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no box`);
  return box;
}

/** Well inside the 800 ms a playing board's silence takes to read as a dropped stream, even on a busy machine. */
const STREAM_RESEND_MS = 200;
const streamStops = new WeakMap<Page, () => void>();

/**
 * The same frame as a diff. A full keyframe clears the selection, and a re-sent one would do that to a
 * case that had just selected a machine. The `full` byte comes straight after the tick's varint.
 */
function asDiff(frame: Buffer): Buffer {
  let i = 0;
  while ((frame[i] as number) & 0x80) i += 1;
  const copy = Buffer.from(frame);
  copy[i + 1] = 0;
  return copy;
}

/**
 * The app reads a playing board's silence as a dropped stream, and the ring hides on one, so a case
 * that waits a moment on a quiet mock would lose its ring. This sends the last packet again until
 * `stopStream`, which leaves the board as it was: same tick, same machines, and a case's `inject` still
 * decides what the board holds.
 */
export function keepStreamAlive(page: Page, h: Harness): void {
  const inject = h.inject.bind(h);
  let last: Buffer | null = null;
  h.inject = (frame: Buffer): void => {
    last = asDiff(frame);
    inject(frame);
  };
  const timer = setInterval(() => {
    if (last !== null) inject(last);
  }, STREAM_RESEND_MS);
  const stop = (): void => clearInterval(timer);
  streamStops.set(page, stop);
  page.once('close', stop);
}

export function stopStream(page: Page): void {
  streamStops.get(page)?.();
}

/** Boot on the mock host with one machine on the board. */
export async function boot(page: Page, opts: Parameters<typeof mockRenderSocket>[1] = {}): Promise<Harness> {
  await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, opts);
  await page.goto('/');
  await waitForChrome(page);
  await h.connected;
  keepStreamAlive(page, h);
  h.inject(buildPacket({ full: true, tick: 3, nodes: [OLD_MACHINE] }));
  await waitForBoard(page, { machines: 1, tick: 3 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return h;
}

/**
 * Help, Lessons, Start, then the Starting card, then the empty board the host answers New with. The
 * lesson defaults to the first, so lesson 1's specs call it as they always did.
 */
export async function startLesson(page: Page, h: Harness, lesson: Lesson = YOUR_FIRST_LINE): Promise<void> {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.locator('#fab-help-panel').getByRole('button', { name: 'Lessons', exact: true }).click();
  await page.getByRole('button', { name: `Start ${lesson.title}`, exact: true }).click();
  await expect.poll(() => h.controls, { message: 'Start sent New' }).toContain('new');

  const card = page.locator(CARD);
  await expect(card, 'the card says the board is on its way').toContainText('Clearing the board.');
  await expect(card).not.toContainText(/Step \d/);
  const starting = await readProbe(page);
  expect(starting.card, 'the lesson waits for the new board').toBe('starting');
  expect(starting.hint, 'no ring while the board is on its way').toBeNull();
  await expect(page.locator('[data-fab-hint]'), 'no ring while the board is on its way').toBeHidden();

  h.inject(buildPacket({ full: true, tick: 5, generation: 1, swapFloor: 1 }));
  await expect.poll(async () => (await readProbe(page)).card, { message: 'the new board started step 1' }).toBe('running');
  expect((await readProbe(page)).lessonId, 'the lesson the row named is the one running').toBe(lesson.id);
  await expect(card).toContainText(`Step 1 of ${lesson.steps.length}`);
}

/** Arm the Source and read the floor ring, with the cell it marks. */
export async function armSourceForFloor(page: Page): Promise<{ ring: HintRect; cell: readonly [number, number] }> {
  await ringAt(page, 'source-tool');
  await page.getByRole('button', { name: 'Place Source', exact: true }).click();
  const ring = await ringAt(page, 'source-floor');
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  return { ring, cell: [Math.round((ring.x + OUTSET - cam.x) / size), Math.round((ring.y + OUTSET - cam.y) / size)] };
}

export const SOURCE_ID = 2;
export const SINK_ID = 3;

export type Trigger = { kind: 'Webhook' } | { kind: 'Timer'; interval_ticks: number };

/** A host whose `machine_config` answer the case can change, counting how often it was asked. */
export function configuredHost(): { opts: Parameters<typeof mockRenderSocket>[1]; set(t: Trigger): void; asked(): number } {
  let trigger: Trigger = { kind: 'Webhook' };
  let asked = 0;
  return {
    opts: {
      answerQuery: (verb) => {
        if (verb !== 'machine_config') return undefined;
        asked += 1;
        return { kind: 'Source', trigger };
      },
    },
    set: (t) => {
      trigger = t;
    },
    asked: () => asked,
  };
}

/** The configs a lesson's machines start on: a Source on Webhook and a Sink on Debug. */
export const SOURCE_WEBHOOK: MachineConfig = { kind: 'Source', trigger: { kind: 'Webhook' } };
export const SOURCE_TIMER: MachineConfig = { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: 60 } };
export const SINK_DEBUG: MachineConfig = { kind: 'Sink', target: { kind: 'Debug' } };

/**
 * A host whose `machine_config` answer comes from a table the case sets by handle, the way the real
 * host answers about the machine it's asked about. Undo re-mints handles, so a case sets the new ones
 * when it injects the keyframe. A handle the table doesn't hold is answered with no config, never left
 * unanswered: the layer asks every bound machine at once and waits for all the answers.
 */
export function configByNode(): {
  opts: Parameters<typeof mockRenderSocket>[1];
  set(node: number, config: MachineConfig | null): void;
  answers(node: number): number;
} {
  const table = new Map<number, MachineConfig | null>();
  const counts = new Map<number, number>();
  return {
    opts: {
      answerQuery: (verb, args) => {
        if (verb !== 'machine_config') return undefined;
        const node = Number(args.node);
        counts.set(node, (counts.get(node) ?? 0) + 1);
        return table.get(node) ?? null;
      },
    },
    set: (node, config) => {
      table.set(node, config);
    },
    answers: (node) => counts.get(node) ?? 0,
  };
}

export function sourceAt(cell: readonly [number, number]): InjectNode {
  return { id: SOURCE_ID, kind: 0, cell_x: cell[0], cell_y: cell[1], ports: [{ index: 0, cell_x: cell[0], cell_y: cell[1], side: 1, role: 1 }] };
}

/** The fault port comes first, so a ring that took the first port would sit on it. */
export function sinkAt(cell: readonly [number, number]): InjectNode {
  return {
    id: SINK_ID,
    kind: 7,
    cell_x: cell[0],
    cell_y: cell[1],
    ports: [
      { index: 0, cell_x: cell[0], cell_y: cell[1], side: 2, role: 2 },
      { index: 1, cell_x: cell[0], cell_y: cell[1], side: 3, role: 0 },
    ],
  };
}

export function cellOfRing(ring: HintRect, cam: { x: number; y: number; scale: number }): readonly [number, number] {
  const size = CELL * cam.scale;
  return [Math.round((ring.x + OUTSET - cam.x) / size), Math.round((ring.y + OUTSET - cam.y) / size)];
}

/**
 * The belt a straight draw from `from`'s Out port to `to`'s In port leaves, docked at both ends: its
 * tiles run from the Out doorstep to the In doorstep, Tail first, along the one row the two share.
 */
export function beltBetween(id: number, from: InjectNode, to: InjectNode, itemSlots: number[] = []): InjectBelt {
  const out = from.ports?.find((p) => p.role === 1);
  const into = to.ports?.find((p) => p.role === 0);
  if (out === undefined || into === undefined) throw new Error('beltBetween needs an Out port on the first machine and an In port on the second');
  const [ax, ay] = doorstepCell(out);
  const [bx, by] = doorstepCell(into);
  if (ay !== by) throw new Error(`beltBetween draws along one row, and the doorsteps sit on rows ${ay} and ${by}`);
  const step = bx >= ax ? 1 : -1;
  const tiles: [number, number][] = [];
  for (let x = ax; x !== bx + step; x += step) tiles.push([x, ay]);
  const crossed = [from, to].find((n) => tiles.some(([x, y]) => x === n.cell_x && y === n.cell_y));
  if (crossed !== undefined) throw new Error(`beltBetween's row runs through the machine at (${crossed.cell_x},${crossed.cell_y}); place the second machine past the first's Out side`);
  return {
    id,
    tiles,
    itemSlots,
    docks: [
      { end: 'Tail', node: from.id, port: out.index },
      { end: 'Head', node: to.id, port: into.index },
    ],
  };
}

/**
 * The same board under new handles, as an Undo keyframe sends it: every machine and belt gets its old
 * handle plus `shift`, and each dock follows the machine it names. Cells, ports and tiles stay put.
 */
export function reminted(board: { nodes: InjectNode[]; belts?: InjectBelt[] }, shift: number): { nodes: InjectNode[]; belts: InjectBelt[] } {
  return {
    nodes: board.nodes.map((n) => ({ ...n, id: n.id + shift })),
    belts: (board.belts ?? []).map((b) => ({ ...b, id: b.id + shift, docks: (b.docks ?? []).map((d) => ({ ...d, node: d.node + shift })) })),
  };
}

/** Steps 1 and 2 through the floor rings, with the host's answers injected. The Sink's tool stays armed. */
export async function placeBoth(page: Page, h: Harness): Promise<{ source: InjectNode; sink: InjectNode; tick: number }> {
  const { cell } = await armSourceForFloor(page);
  const source = sourceAt(cell);
  h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: [source] }));
  await ringAt(page, 'sink-tool');
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  const sinkRing = await ringAt(page, 'sink-floor');
  const sink = sinkAt(cellOfRing(sinkRing, await cameraOf(page)));
  expect([sink.cell_x, sink.cell_y], "the Sink's spot isn't the Source's cell").not.toEqual(cell);
  h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: [source, sink] }));
  return { source, sink, tick: 7 };
}

/** A press at a rect's centre. */
export async function pressRing(page: Page, ring: Box): Promise<void> {
  await page.mouse.click(ring.x + ring.width / 2, ring.y + ring.height / 2);
}

/** Put the armed tool down, select the Source through its ring, and press Timer through its ring. */
export async function pressTimer(page: Page): Promise<void> {
  await ringAt(page, 'tool-down');
  await page.keyboard.press('Escape');
  await pressRing(page, await ringAt(page, 'select-source'));
  await pressRing(page, await ringAt(page, 'press-timer'));
}

/** From a placed pair to the belt tool armed, with the host answering Timer after Apply. */
export async function toBeltDraw(page: Page, host: ReturnType<typeof configuredHost>): Promise<void> {
  await pressTimer(page);
  await pressRing(page, await ringAt(page, 'apply-timer'));
  host.set({ kind: 'Timer', interval_ticks: 60 });
  await pressRing(page, await ringAt(page, 'belt-tool'));
  await ringAt(page, 'belt-draw');
}

/** Zoom out at the window's middle and wait for the camera, then pan with the middle button. */
export async function zoomOut(page: Page): Promise<void> {
  const before = await cameraOf(page);
  await page.mouse.move(640, 300);
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the wheel changed the zoom' }).not.toBe(before.scale);
}

/** One wheel notch the camera reads as a mouse wheel. Not exported: zoomInto measures what it does. */
const WHEEL_NOTCH = 60;
/** The most wheel events zoomInto sends before it gives up. */
const MAX_WHEEL_EVENTS = 8;

/**
 * Wheel at `at` until the camera's scale reads in `[lo, hi]`, and return that scale.
 *
 * On a loaded CI runner one wheel round trip cost about 0.66 s, and zooming one notch at a time
 * took about 30 of them. So this sends one notch, reads the camera's zoom per wheel pixel from the
 * scale before and after, and covers the rest in one wheel event aimed at the geometric middle of the
 * range. Zooming about a fixed cursor point composes, so the camera ends where the notches would
 * have taken it, apart from float rounding. Each event polls the camera before the next is sent.
 *
 * The camera reads an event as a mouse wheel only when it is whole, vertical and at least 50, so the
 * sized event is rounded and never smaller than one notch. Each range must be wider than one notch,
 * a factor of e^0.09, so a notch can't jump over it. The page must run at device scale 1: Chromium
 * divides the wheel delta by the scale, and a fractional delta reads as a trackpad pan.
 */
export async function zoomInto(page: Page, at: { x: number; y: number }, lo: number, hi: number): Promise<number> {
  await page.mouse.move(at.x, at.y);
  const first = (await cameraOf(page)).scale;
  if (first >= lo && first <= hi) return first;
  await page.mouse.wheel(0, first > hi ? WHEEL_NOTCH : -WHEEL_NOTCH);
  await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the wheel notch moved the zoom' }).not.toBe(first);
  let scale = (await cameraOf(page)).scale;
  const rate = Math.abs(Math.log(scale / first)) / WHEEL_NOTCH;
  const target = Math.sqrt(lo * hi);
  for (let sent = 1; ; sent++) {
    if (scale >= lo && scale <= hi) return scale;
    if (sent >= MAX_WHEEL_EVENTS) throw new Error(`the zoom never reached [${lo}, ${hi}] after ${sent} wheel events`);
    const raw = Math.round(Math.log(scale / target) / rate);
    const dy = Math.abs(raw) < WHEEL_NOTCH ? Math.sign(raw || scale - target) * WHEEL_NOTCH : raw;
    const before = scale;
    await page.mouse.wheel(0, dy);
    await expect.poll(async () => (await cameraOf(page)).scale, { message: 'the sized wheel event moved the zoom' }).not.toBe(before);
    scale = (await cameraOf(page)).scale;
  }
}

export async function panBoard(page: Page): Promise<void> {
  const before = await cameraOf(page);
  await page.mouse.move(640, 300);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(690, 330, { steps: 5 });
  await page.mouse.move(730, 340, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => (await cameraOf(page)).x, { message: 'the middle-drag panned the board' }).not.toBe(before.x);
}

/**
 * Send the host's refusal frame for `tag` with no `seq`, as `wire.ts` writes it for a refused gesture,
 * so a spec can raise a refusal at any stage without a gesture to answer. With no `seq` the app shows
 * it whatever the last shown sequence was, the way it shows a refusal for a frame it couldn't read.
 */
export function injectRefusal(h: Harness, tag: string): void {
  h.injectText(JSON.stringify({ kind: GESTURE_REFUSAL_KIND, tag }));
}
