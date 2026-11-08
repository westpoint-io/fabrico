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
import { TWO_OUTPUTS } from '../../src/tutorial/lessons/twoOutputs';
import type { Lesson } from '../../src/tutorial/types';
import {
  CELL,
  CMD,
  QueryRefusal,
  buildPacket,
  cameraOf,
  gestureSubject,
  mockRenderSocket,
  waitForBoard,
  waitForChrome,
  type Harness,
  type InjectBelt,
  type InjectNode,
  type InjectPort,
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

/**
 * Boot on the mock host with one machine on the board. `firstLaunch` skips the seen-flag init script,
 * so the welcome card shows; the case must also clear the config's stored flag with `test.use`.
 */
export async function boot(page: Page, opts: Parameters<typeof mockRenderSocket>[1] & { firstLaunch?: boolean } = {}): Promise<Harness> {
  const { firstLaunch = false, ...socket } = opts;
  if (!firstLaunch) await page.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
  const h = await mockRenderSocket(page, socket);
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

/** The handler a new Factory holds, as `crates/fabrico-core/src/edit.rs` gives it. */
export const DEFAULT_FACTORY_SOURCE = 'export default function (input, ctx) { ctx.emit(0, input); }';

export function factoryConfig(source: string = DEFAULT_FACTORY_SOURCE): MachineConfig {
  return { kind: 'Factory', source };
}

/**
 * The mock's stand-in for the host's `validate_factory_js`: does the source parse? The handler is
 * `export default <function>`, which `new Function` can't take, so it parses the function as the
 * value of a `return`. It only parses and never runs the code. Null when it parses, otherwise the
 * parser's message.
 */
export function factoryParseError(source: string): string | null {
  const body = source.replace(/^\s*export\s+default\s+/, '');
  try {
    // A parse check on the Node side: the function it builds is never called.
    new Function(`return (${body}\n);`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * A host whose `machine_config` answer comes from a table the case sets by handle, the way the real
 * host answers about the machine it's asked about. Undo re-mints handles, so a case sets the new ones
 * when it injects the keyframe. A handle the table doesn't hold is answered with no config, never left
 * unanswered: the layer asks every bound machine at once and waits for all the answers.
 *
 * A Factory's code goes through the host's two steps. `validate_factory_js` is refused for code that
 * doesn't parse, and the panel then shows its own error row and sends nothing. Code that parses is
 * held, and the Configure frame that follows, naming a Factory in the table and carrying that code,
 * puts it in the table, so the next `machine_config` answer holds it, as the host's does.
 *
 * `hold(node)` makes the host refuse every `machine_config` query about that handle until
 * `release(node)`, as a failed host query would. Each query is still counted, and the page's query
 * rejects, so the layer keeps no answer about the handle.
 */
export function configByNode(): {
  opts: Parameters<typeof mockRenderSocket>[1];
  set(node: number, config: MachineConfig | null): void;
  get(node: number): MachineConfig | null;
  answers(node: number): number;
  hold(node: number): void;
  release(node: number): void;
  validated(): string[];
} {
  const table = new Map<number, MachineConfig | null>();
  const counts = new Map<number, number>();
  const held = new Set<number>();
  const validated: string[] = [];
  return {
    opts: {
      answerQuery: (verb, args) => {
        if (verb === 'validate_factory_js') {
          const source = String(args.source);
          const error = factoryParseError(source);
          if (error !== null) return new QueryRefusal(error);
          validated.push(source);
          return null;
        }
        if (verb !== 'machine_config') return undefined;
        const node = Number(args.node);
        counts.set(node, (counts.get(node) ?? 0) + 1);
        if (held.has(node)) return new QueryRefusal(`machine_config ${node} held by the case`);
        return table.get(node) ?? null;
      },
      answerGesture: (frame) => {
        const subject = gestureSubject(frame);
        if (subject.cmd !== 'Configure' || subject.node === undefined) return undefined;
        if (table.get(subject.node)?.kind !== 'Factory') return undefined;
        const source = [...validated].reverse().find((s) => frame.includes(Buffer.from(s)));
        if (source !== undefined) table.set(subject.node, factoryConfig(source));
        // No verdict frame: the panel's Apply reads the config back, and the rest of the suite's
        // gestures go unanswered too.
        return undefined;
      },
    },
    set: (node, config) => {
      table.set(node, config);
    },
    get: (node) => table.get(node) ?? null,
    answers: (node) => counts.get(node) ?? 0,
    hold: (node) => {
      held.add(node);
    },
    release: (node) => {
      held.delete(node);
    },
    validated: () => [...validated],
  };
}

export function sourceAt(cell: readonly [number, number]): InjectNode {
  return { id: SOURCE_ID, kind: 0, cell_x: cell[0], cell_y: cell[1], ports: [{ index: 0, cell_x: cell[0], cell_y: cell[1], side: 1, role: 1 }] };
}

export const FACTORY_ID = 4;
/** The `machine_kind` byte for a Factory. */
export const FACTORY_KIND = 2;

/**
 * A 3 by 3 Factory with its top left at `cell`, its ports as the host gives a new one: the In at local
 * (0, 1) facing west, the Out at (2, 1) east and the Fault at (1, 2) south, indices 0 to 2. With
 * `outs: 2` the second Out sits at (2, 2) east, index 3, the slot `+ Add output` takes on a 3-long side
 * (`protocol/addOutput.ts`), and the box stays 3 by 3.
 */
export function factoryAt(cell: readonly [number, number], outs: 1 | 2 = 1, id: number = FACTORY_ID): InjectNode {
  const [x, y] = cell;
  const ports = [
    { index: 0, cell_x: x, cell_y: y + 1, side: 3, role: 0 },
    { index: 1, cell_x: x + 2, cell_y: y + 1, side: 1, role: 1 },
    { index: 2, cell_x: x + 1, cell_y: y + 2, side: 2, role: 2 },
  ];
  if (outs === 2) ports.push({ index: 3, cell_x: x + 2, cell_y: y + 2, side: 1, role: 1 });
  return { id, kind: FACTORY_KIND, cell_x: x, cell_y: y, w: 3, h: 3, ports };
}

/** The fault port comes first, so a ring that took the first port would sit on it. */
export function sinkAt(cell: readonly [number, number], id: number = SINK_ID): InjectNode {
  return {
    id,
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

/** Do the cell and the machine's footprint (rot 0) meet? */
function covers(n: InjectNode, x: number, y: number): boolean {
  return x >= n.cell_x && x < n.cell_x + (n.w ?? 1) && y >= n.cell_y && y < n.cell_y + (n.h ?? 1);
}

/**
 * The belt a straight draw from the Out port with index `outIndex` on `from` to the In port with index
 * `inIndex` on `to` leaves, docked at both ends, Tail first along the row the two doorsteps share. The
 * Tail dock names the output by its place among `from`'s Outs, as the host writes it and `dockPort`
 * reads it, and the Head dock names the In by its index.
 */
export function beltFromPort(id: number, from: InjectNode, outIndex: number, to: InjectNode, inIndex: number, itemSlots: number[] = []): InjectBelt {
  const outs = (from.ports ?? []).filter((p) => p.role === 1);
  const ordinal = outs.findIndex((p) => p.index === outIndex);
  const into = to.ports?.find((p) => p.index === inIndex && p.role === 0);
  if (ordinal < 0 || into === undefined) throw new Error(`beltFromPort needs Out ${outIndex} on machine ${from.id} and In ${inIndex} on machine ${to.id}`);
  const [ax, ay] = doorstepCell(outs[ordinal]!);
  const [bx, by] = doorstepCell(into);
  if (ay !== by) throw new Error(`beltFromPort draws along one row, and the doorsteps sit on rows ${ay} and ${by}`);
  const step = bx >= ax ? 1 : -1;
  const tiles: [number, number][] = [];
  for (let x = ax; x !== bx + step; x += step) tiles.push([x, ay]);
  const crossed = [from, to].find((n) => tiles.some(([x, y]) => covers(n, x, y)));
  if (crossed !== undefined) throw new Error(`beltFromPort's row runs through the machine at (${crossed.cell_x},${crossed.cell_y})`);
  return {
    id,
    tiles,
    itemSlots,
    docks: [
      { end: 'Tail', node: from.id, port: ordinal },
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

// ---------------------------------------------------------------------------------------------------
// Lessons 3 and 4, played through their rings. `lesson-delete.spec.ts`, `lesson-factory.spec.ts` and
// `lesson-clearance.spec.ts` share these, so each lesson's mock flow exists once.
//
// A flow takes an optional `visit`. When a spec passes one, the flow calls it with the stage id each
// time the card shows a stage the flow stops on, before the gesture there, and it also takes the side
// trips that show the stages a plain run skips: a tool put down and picked up again, a short belt that
// stops before its machine, a selection cleared. `visit` must leave the card on the stage it was given.
// ---------------------------------------------------------------------------------------------------

/** A spec's stop at a stage a flow reaches. */
export type Visit = (stageId: string) => Promise<void>;

/** Poll the probe until it names this step and stage. */
export async function expectAt(page: Page, stepId: string, stageId: string, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const probe = await readProbe(page);
        return `${probe.stepId}/${probe.stageId}`;
      },
      { message },
    )
    .toBe(`${stepId}/${stageId}`);
}

/** How many frames carrying `cmd` the page has sent. */
export function sentCount(h: Harness, cmd: number): number {
  return h.sent.filter((frame) => frame[0] === cmd).length;
}

/** The centre of a ring's rect, where a press on it lands. */
export function centreOf(ring: HintRect): { x: number; y: number } {
  return { x: ring.x + ring.width / 2, y: ring.y + ring.height / 2 };
}

/** Wait for the stage's ring, then hand it to the visit. */
async function stopAt(page: Page, stageId: string, visit: Visit | undefined): Promise<void> {
  if (visit === undefined) return;
  await ringAt(page, stageId);
  await visit(stageId);
}

/** Press a floor ring with the tool armed and wait for the Place it sends. */
export async function placeThrough(page: Page, h: Harness, ring: HintRect): Promise<void> {
  const before = sentCount(h, CMD.Place);
  await pressRing(page, ring);
  await expect.poll(() => sentCount(h, CMD.Place), { message: 'the floor press sent a Place' }).toBe(before + 1);
}

/** The drag from the belt-draw ring (or from `startAt`) to its release ring, and the DrawBelt it sends. */
export async function dragThroughRings(page: Page, h: Harness, startAt?: { x: number; y: number }): Promise<void> {
  const from = await ringAt(page, 'belt-draw');
  const to = (await readProbe(page)).hintTo;
  if (to === null) throw new Error('belt-draw shows no release ring');
  const before = sentCount(h, CMD.DrawBelt);
  const start = startAt ?? centreOf(from);
  const end = to.hitCentre ?? centreOf(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => sentCount(h, CMD.DrawBelt), { message: 'the drag between the rings sent a draw' }).toBe(before + 1);
}

/**
 * Press the first stage's ring if the step opens on it, and wait for `nextStage`. Machine and Belt
 * tools stay armed after use, and a selection stays while tools come and go, so a step can open on
 * `nextStage`. With a visit, Escape then puts the tool down or clears the selection so the card shows
 * `firstStage` too, and its ring is pressed to come back.
 */
export async function armThrough(page: Page, firstStage: string, nextStage: string, visit?: Visit): Promise<void> {
  if (visit !== undefined && (await readProbe(page)).stageId !== firstStage) {
    await ringAt(page, nextStage);
    await visit(nextStage);
    // A refusal band or a held key can take one Escape, so press until the card moves back.
    for (let i = 0; i < 4 && (await readProbe(page)).stageId !== firstStage; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
    }
    await ringAt(page, firstStage);
  }
  if ((await readProbe(page)).stageId === firstStage) {
    await stopAt(page, firstStage, visit);
    await pressRing(page, await ringAt(page, firstStage));
  }
  await ringAt(page, nextStage);
}

/**
 * With a visit, at a belt-draw stage: put down the first two tiles of the drag's belt, docked at its Out
 * only, so the card shows the carry-on stage, visit it, then take the belt off again so the card is back
 * on the plain drag. Two tiles, because a one-tile belt has no direction and reads as stuck. The stub's
 * handle is one no lesson uses.
 */
async function visitCarryOn(
  page: Page,
  h: Harness,
  board: { nodes: InjectNode[]; belts: InjectBelt[]; tick: number },
  full: InjectBelt,
  visit: Visit | undefined,
): Promise<void> {
  if (visit === undefined) return;
  if (full.tiles.length < 3) throw new Error(`a carry-on stub needs a belt of three tiles or more, and this one has ${full.tiles.length}`);
  const stub: InjectBelt = { id: CARRY_ON_STUB_ID, tiles: full.tiles.slice(0, 2), docks: (full.docks ?? []).filter((d) => d.end === 'Tail') };
  h.inject(buildPacket({ full: false, tick: ++board.tick, generation: 1, swapFloor: 1, nodes: board.nodes, belts: [...board.belts, stub] }));
  await stopAt(page, 'belt-carry-on', visit);
  h.inject(buildPacket({ full: false, tick: ++board.tick, generation: 1, swapFloor: 1, removed: [CARRY_ON_STUB_ID] }));
  await ringAt(page, 'belt-draw');
}

/** The handle of the short belt `visitCarryOn` puts down and takes off. */
const CARRY_ON_STUB_ID = 90;

// Lesson 3, Delete and Undo.

/** Lesson 3's belt handle. */
export const LINE_BELT_ID = 4;

/** Lesson 3's board as the case has injected it so far, and the tick and generation of its last packet. */
export interface LineBoard {
  source: InjectNode;
  sink: InjectNode;
  belt: InjectBelt;
  /** A second Source the lesson never bound, on every packet from the Source's placement on, or null. */
  extra: InjectNode | null;
  tick: number;
  generation: number;
}

/** The handle of the unbound second Source `buildLine` can put down. Higher than the Source's, so the lesson binds the Source. */
export const EXTRA_SOURCE_ID = 11;

export async function selectedBelt(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __fabrico: { selectedBelt(): number | null } }).__fabrico.selectedBelt());
}

export async function selectedNode(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __fabrico: { selectedNode(): number | null } }).__fabrico.selectedNode());
}

/** The Delete frames the page has sent, each with the handle it names. */
export function deletesSent(h: Harness): number[] {
  return h.sent.filter((frame) => frame[0] === CMD.Delete).map((frame) => gestureSubject(frame).node ?? -1);
}

export function undosSent(h: Harness): number {
  return h.sent.filter((frame) => frame[0] === CMD.Undo).length;
}

/**
 * Lesson 3's steps 1 to 3 the way a user plays them: the Source and the Sink through their floor rings,
 * then the Belt row and a drag from the Out ring to the In ring, at a zoom in `zoom`. The host's answers
 * are injected after each gesture, and both machines' configs are in the host's table before they
 * land. Returns at tool-down, with the Belt tool still armed.
 *
 * With `extraSource`, the Source's packet also holds a second Source three cells below it, as a second
 * click on the floor with the Source tool still armed leaves one. The lesson binds the lower handle, and
 * the second Source stays on every packet after that, with Webhook in the host's table.
 */
export async function buildLine(
  page: Page,
  h: Harness,
  host: ReturnType<typeof configByNode>,
  visit?: Visit,
  zoom: readonly [number, number] = [1.4, 1.6],
  opts: { extraSource?: boolean } = {},
): Promise<LineBoard> {
  await ringAt(page, 'source-tool');
  // New keeps the camera, and the mock's first board fits one machine at the closest zoom. At that zoom
  // six cells east of the Source is past the free area, so the Sink's spot would land west, where no
  // straight belt reaches it. A user building a line zooms out first, and so does this. At 1024 wide
  // the free area is 412 px, and the line needs a zoom of about 1 to fit it.
  await zoomInto(page, { x: 640, y: 360 }, zoom[0], zoom[1]);
  await stopAt(page, 'source-tool', visit);
  await page.getByRole('button', { name: 'Place Source', exact: true }).click();
  await stopAt(page, 'source-floor', visit);
  const sourceRing = await ringAt(page, 'source-floor');
  const source = sourceAt(cellOfRing(sourceRing, await cameraOf(page)));
  host.set(source.id, SOURCE_WEBHOOK);
  const extra = opts.extraSource === true ? { ...sourceAt([source.cell_x, source.cell_y + 3]), id: EXTRA_SOURCE_ID } : null;
  if (extra !== null) host.set(extra.id, SOURCE_WEBHOOK);
  const machines = (...more: InjectNode[]): InjectNode[] => [...more, ...(extra === null ? [] : [extra])];
  await placeThrough(page, h, sourceRing);
  h.inject(buildPacket({ full: false, tick: 6, generation: 1, swapFloor: 1, nodes: machines(source) }));

  await stopAt(page, 'sink-tool', visit);
  await ringAt(page, 'sink-tool');
  await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
  await stopAt(page, 'sink-floor', visit);
  const sinkRing = await ringAt(page, 'sink-floor');
  const sink = sinkAt(cellOfRing(sinkRing, await cameraOf(page)));
  host.set(sink.id, SINK_DEBUG);
  await pressRing(page, sinkRing);
  h.inject(buildPacket({ full: false, tick: 7, generation: 1, swapFloor: 1, nodes: machines(source, sink) }));

  await stopAt(page, 'belt-tool', visit);
  await pressRing(page, await ringAt(page, 'belt-tool'));
  await stopAt(page, 'belt-draw', visit);
  const belt = beltBetween(LINE_BELT_ID, source, sink);
  const board = { nodes: machines(source, sink), belts: [] as InjectBelt[], tick: 7 };
  await visitCarryOn(page, h, board, belt, visit);
  await dragThroughRings(page, h);

  h.inject(buildPacket({ full: false, tick: ++board.tick, generation: 1, swapFloor: 1, nodes: machines(source, sink), belts: [belt], canUndo: true }));
  await expectAt(page, 'delete-belt', 'tool-down', 'the joined belt finished draw-belt, and the Belt tool is still armed');
  return { source, sink, belt, extra, tick: board.tick, generation: 1 };
}

/** Wait until the capture lesson 3's restored check compares with holds both machines' configs. */
export async function expectCaptureComplete(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readProbe(page)).capture, { message: 'the capture taken as delete-belt began holds both configs' })
    .toEqual({ since: 'delete-belt', machines: 2, configKinds: ['Source', 'Sink'] });
}

/**
 * Lesson 3's step 4 from tool-down: the tool down, the belt selected through its ring and Delete, then
 * the host's diff without it. Ends at delete-sink's select-sink.
 */
export async function deleteBelt(page: Page, h: Harness, board: LineBoard, visit?: Visit): Promise<void> {
  if ((await readProbe(page)).stageId === 'tool-down') {
    await stopAt(page, 'tool-down', visit);
    await page.keyboard.press('Escape');
  }
  await stopAt(page, 'select-belt', visit);
  await pressRing(page, await ringAt(page, 'select-belt'));
  await expect.poll(() => selectedBelt(page), { message: 'the press on the belt ring selected the belt' }).toBe(LINE_BELT_ID);
  await expectAt(page, 'delete-belt', 'press-delete', 'a selected belt moves the card to the Delete key');
  await stopAt(page, 'press-delete', visit);
  await page.keyboard.press('Delete');
  await expect.poll(() => deletesSent(h), { message: "Delete sent the belt's delete" }).toContain(LINE_BELT_ID);
  board.tick += 1;
  h.inject(buildPacket({ full: false, tick: board.tick, generation: 1, swapFloor: 1, removed: [LINE_BELT_ID], canUndo: true }));
  await expectAt(page, 'delete-sink', 'select-sink', 'the belt gone finished delete-belt');
}

/**
 * Lesson 3's step 5 from select-sink: the Sink selected through its ring and Backspace, then the host's
 * diff without it. With a visit it first arms the Sink tool so the card shows tool-down, and puts it
 * down again. Ends at bring-back's undo-sink.
 */
export async function deleteSink(page: Page, h: Harness, board: LineBoard, visit?: Visit): Promise<void> {
  if (visit !== undefined) {
    await page.getByRole('button', { name: 'Place Sink', exact: true }).click();
    await expectAt(page, 'delete-sink', 'tool-down', 'an armed tool moves the card to tool-down');
    await stopAt(page, 'tool-down', visit);
    await page.keyboard.press('Escape');
  }
  await stopAt(page, 'select-sink', visit);
  await pressRing(page, await ringAt(page, 'select-sink'));
  await expect.poll(() => selectedNode(page), { message: 'the press on the Sink ring selected the Sink' }).toBe(board.sink.id);
  await expectAt(page, 'delete-sink', 'press-delete', 'a selected Sink moves the card to the Delete key');
  await stopAt(page, 'press-delete', visit);
  await page.keyboard.press('Backspace');
  await expect.poll(() => deletesSent(h), { message: "Backspace sent the Sink's delete" }).toContain(board.sink.id);
  board.tick += 1;
  h.inject(buildPacket({ full: false, tick: board.tick, generation: 1, swapFloor: 1, removed: [board.sink.id], canUndo: true }));
  await expectAt(page, 'bring-back', 'undo-sink', 'the Sink gone finished delete-sink');
}

/**
 * Lesson 3's step 6 from undo-sink: the Undo button under its ring, then Ctrl+Z, each answered with a
 * keyframe that re-mints every handle, the unbound second Source's too when the board has one. Ends
 * with the lesson finished.
 */
export async function undoBoth(page: Page, h: Harness, host: ReturnType<typeof configByNode>, board: LineBoard, visit?: Visit): Promise<void> {
  await stopAt(page, 'undo-sink', visit);
  const undos = undosSent(h);
  await pressRing(page, await ringAt(page, 'undo-sink'));
  await expect.poll(() => undosSent(h), { message: 'the Undo button sent an Undo' }).toBe(undos + 1);
  const machines = [board.source, board.sink, ...(board.extra === null ? [] : [board.extra])];
  const first = reminted({ nodes: machines }, 10);
  for (const n of first.nodes) host.set(n.id, n.kind === board.sink.kind ? SINK_DEBUG : SOURCE_WEBHOOK);
  h.inject(buildPacket({ full: true, tick: ++board.tick, generation: 2, swapFloor: 1, nodes: first.nodes, canUndo: true, canRedo: true }));
  await expectAt(page, 'bring-back', 'undo-belt', 'the Sink back moved the card to the belt');
  await stopAt(page, 'undo-belt', visit);
  await page.keyboard.press('Control+z');
  await expect.poll(() => undosSent(h), { message: 'Ctrl+Z sent the second Undo' }).toBe(undos + 2);
  const second = reminted({ nodes: machines, belts: [board.belt] }, 20);
  for (const n of second.nodes) host.set(n.id, n.kind === board.sink.kind ? SINK_DEBUG : SOURCE_WEBHOOK);
  h.inject(buildPacket({ full: true, tick: ++board.tick, generation: 3, swapFloor: 1, nodes: second.nodes, belts: second.belts, canUndo: true, canRedo: true }));
  await expect.poll(async () => (await readProbe(page)).card, { message: 'the line back as it was finished the lesson' }).toBe('finished');
}

// Lesson 4, A Factory with two outputs.

export const SINK2_ID = 5;
export const BELT_IN_ID = 6;
export const BELT_OUT_ID = 7;
export const BELT_OUT2_ID = 8;
/** The Sink fixture's In port index (`sinkAt`: the Fault is index 0). */
export const SINK_IN = 1;
/** The Factory fixture's port indices (`factoryAt`). */
export const FACTORY_IN = 0;
export const FACTORY_OUT = 1;
export const FACTORY_OUT2 = 3;

/** Lesson 4's board as the case has injected it so far, and the tick of its last packet. */
export interface FactoryBoard {
  source: InjectNode;
  factory: InjectNode;
  sink: InjectNode;
  sink2: InjectNode;
  belts: InjectBelt[];
  tick: number;
}

type ConfigHost = ReturnType<typeof configByNode>;

/** Inject the board as it stands, as a diff on generation 1. */
export function injectBoard(h: Harness, board: { nodes: InjectNode[]; belts?: InjectBelt[]; tick: number }): void {
  h.inject(buildPacket({ full: false, tick: board.tick, generation: 1, swapFloor: 1, nodes: board.nodes, belts: board.belts ?? [] }));
}

/** A port of a fixture machine, by index. */
export function portOf(node: InjectNode, index: number): InjectPort {
  const port = node.ports?.find((p) => p.index === index);
  if (port === undefined) throw new Error(`machine ${node.id} has no port ${index}`);
  return port;
}

/** Where a press on a port's doorstep cell lands, at its centre. */
export async function doorstepCentre(page: Page, port: { cell_x: number; cell_y: number; side: number }): Promise<{ x: number; y: number }> {
  const cam = await cameraOf(page);
  const size = CELL * cam.scale;
  const [x, y] = doorstepCell(port);
  return { x: x * size + cam.x + size / 2, y: y * size + cam.y + size / 2 };
}

/** Start lesson 4 and zoom to about 1, where the 11-cell line fits the free area. */
export async function startFactoryLesson(
  page: Page,
  opts: Parameters<typeof boot>[1] = {},
  beforeZoom?: () => Promise<void>,
): Promise<{ h: Harness; host: ConfigHost }> {
  const host = configByNode();
  const h = await boot(page, { ...host.opts, ...opts });
  await startLesson(page, h, TWO_OUTPUTS);
  await ringAt(page, 'source-tool');
  await beforeZoom?.();
  // New keeps the camera, and the mock's first board fits one machine at the closest zoom, where the
  // centred line can't fit and its later spots fall out of view. A user building a line zooms out.
  await zoomInto(page, { x: 640, y: 360 }, 0.9, 1.1);
  return { h, host };
}

/** Lesson 4's steps 1 and 2: the Source through its rings, and Timer set with the host answering it after Apply. */
export async function sourceOnTimer(page: Page, h: Harness, host: ConfigHost, visit?: Visit): Promise<{ source: InjectNode; tick: number }> {
  await stopAt(page, 'source-tool', visit);
  await pressRing(page, await ringAt(page, 'source-tool'));
  await stopAt(page, 'source-floor', visit);
  const sourceRing = await ringAt(page, 'source-floor');
  const source = sourceAt(cellOfRing(sourceRing, await cameraOf(page)));
  host.set(source.id, SOURCE_WEBHOOK);
  await placeThrough(page, h, sourceRing);
  injectBoard(h, { nodes: [source], tick: 6 });

  await ringAt(page, 'tool-down');
  await stopAt(page, 'tool-down', visit);
  await page.keyboard.press('Escape');
  await stopAt(page, 'select-source', visit);
  await pressRing(page, await ringAt(page, 'select-source'));
  await stopAt(page, 'press-timer', visit);
  await pressRing(page, await ringAt(page, 'press-timer'));
  const configures = sentCount(h, CMD.Configure);
  await stopAt(page, 'apply-timer', visit);
  await pressRing(page, await ringAt(page, 'apply-timer'));
  await expect.poll(() => sentCount(h, CMD.Configure), { message: 'Apply sent the Timer' }).toBe(configures + 1);
  host.set(source.id, SOURCE_TIMER);
  await expectAt(page, 'place-factory', 'factory-tool', 'the Timer answer finished set-timer');
  return { source, tick: 6 };
}

/** Lesson 4's steps 3 and 4: the Factory through its rings, then + Add output, and the host's two-output Factory. */
export async function factoryWithTwoOutputs(
  page: Page,
  h: Harness,
  host: ConfigHost,
  source: InjectNode,
  tick: number,
  atAddOutput?: () => Promise<void>,
  visit?: Visit,
): Promise<{ factory: InjectNode; tick: number }> {
  await stopAt(page, 'factory-tool', visit);
  await pressRing(page, await ringAt(page, 'factory-tool'));
  await stopAt(page, 'factory-floor', visit);
  const factoryRing = await ringAt(page, 'factory-floor');
  const one = factoryAt(cellOfRing(factoryRing, await cameraOf(page)), 1);
  host.set(one.id, factoryConfig());
  await placeThrough(page, h, factoryRing);
  injectBoard(h, { nodes: [source, one], tick: ++tick });

  await expectAt(page, 'add-output', 'tool-down', 'the Factory appeared, and its tool is still armed');
  await stopAt(page, 'tool-down', visit);
  await page.keyboard.press('Escape');
  await stopAt(page, 'select-factory', visit);
  await pressRing(page, await ringAt(page, 'select-factory'));
  await ringAt(page, 'press-add-output');
  await atAddOutput?.();
  await stopAt(page, 'press-add-output', visit);
  await pressRing(page, await ringAt(page, 'press-add-output'));
  await expect.poll(() => sentCount(h, CMD.AddPort), { message: '+ Add output under its ring sent the add' }).toBe(1);
  const factory = factoryAt([one.cell_x, one.cell_y], 2);
  injectBoard(h, { nodes: [source, factory], tick: ++tick });
  await expectAt(page, 'place-sink', 'sink-tool', 'the Factory with two outputs finished add-output');
  return { factory, tick };
}

/**
 * Lesson 4's steps 5 and 6: both Sinks through their rings. With `firstOnRow` the first Sink goes on
 * that row in the ring's column instead of in the ring, as a user who ignores the ring and puts it in
 * front of the Factory's other output does; the card says any free spot works. With `firstEast` it goes
 * that many columns east of the ring's cell, on its row or on `firstOnRow`.
 */
export async function twoSinks(
  page: Page,
  h: Harness,
  host: ConfigHost,
  nodes: InjectNode[],
  tick: number,
  firstOnRow?: number,
  visit?: Visit,
  firstEast = 0,
): Promise<{ sink: InjectNode; sink2: InjectNode; tick: number }> {
  await stopAt(page, 'sink-tool', visit);
  await pressRing(page, await ringAt(page, 'sink-tool'));
  await stopAt(page, 'sink-floor', visit);
  const sinkRing = await ringAt(page, 'sink-floor');
  const cam = await cameraOf(page);
  const ringCell = cellOfRing(sinkRing, cam);
  const offRing = firstOnRow !== undefined || firstEast !== 0;
  const cell: readonly [number, number] = [ringCell[0] + firstEast, firstOnRow ?? ringCell[1]];
  const sink = sinkAt(cell, SINK_ID);
  host.set(sink.id, SINK_DEBUG);
  if (!offRing) await placeThrough(page, h, sinkRing);
  else {
    const size = CELL * cam.scale;
    const before = sentCount(h, CMD.Place);
    await page.mouse.click(cell[0] * size + cam.x + size / 2, cell[1] * size + cam.y + size / 2);
    await expect.poll(() => sentCount(h, CMD.Place), { message: 'the floor press off the ring sent a Place' }).toBe(before + 1);
  }
  injectBoard(h, { nodes: [...nodes, sink], tick: ++tick });

  await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the first Sink finished place-sink' }).toBe('place-second-sink');
  await armThrough(page, 'second-sink-tool', 'second-sink-floor', visit);
  await stopAt(page, 'second-sink-floor', visit);
  const ring2 = await ringAt(page, 'second-sink-floor');
  const sink2 = sinkAt(cellOfRing(ring2, await cameraOf(page)), SINK2_ID);
  host.set(sink2.id, SINK_DEBUG);
  await placeThrough(page, h, ring2);
  injectBoard(h, { nodes: [...nodes, sink, sink2], tick: ++tick });
  await expect.poll(async () => (await readProbe(page)).stepId, { message: 'the second Sink finished place-second-sink' }).toBe('belt-in');
  return { sink, sink2, tick };
}

export interface FactoryBuildOptions {
  /**
   * Step 8 drawn from the Factory's second Out: the first Sink goes in front of that Out instead of in
   * its ring, and the drag starts on that Out's doorstep instead of the ring. Step 9's free Out is then
   * the first.
   */
  secondFirst?: boolean;
  /** The first Sink this many columns east of its ring's cell, off its ring (review WR-03). */
  firstEast?: number;
  /** Stop after this many belts. */
  beltsDrawn?: 0 | 1 | 2 | 3;
  /** Called at press-add-output, before the press. */
  atAddOutput?: () => Promise<void>;
  visit?: Visit;
}

/**
 * Lesson 4's steps 1 to 6, then the belts through their rings. Returns with the Belt tool still armed,
 * on the step after the last belt drawn.
 */
export async function buildBoard(page: Page, h: Harness, host: ConfigHost, opts: FactoryBuildOptions = {}): Promise<FactoryBoard> {
  const { visit } = opts;
  const placed = await sourceOnTimer(page, h, host, visit);
  const { factory, tick: t2 } = await factoryWithTwoOutputs(page, h, host, placed.source, placed.tick, opts.atAddOutput, visit);
  const secondRow = doorstepCell(portOf(factory, FACTORY_OUT2))[1];
  const { sink, sink2, tick: t3 } = await twoSinks(page, h, host, [placed.source, factory], t2, opts.secondFirst === true ? secondRow : undefined, visit, opts.firstEast);
  const board: FactoryBoard = { source: placed.source, factory, sink, sink2, belts: [], tick: t3 };
  const nodes = [board.source, factory, sink, sink2];
  const outs = opts.secondFirst === true ? [FACTORY_OUT2, FACTORY_OUT] : [FACTORY_OUT, FACTORY_OUT2];
  const plan: { step: string; belt: () => InjectBelt; from?: number }[] = [
    { step: 'belt-in', belt: () => beltFromPort(BELT_IN_ID, board.source, 0, factory, FACTORY_IN) },
    {
      step: 'belt-out',
      belt: () => beltFromPort(BELT_OUT_ID, factory, outs[0]!, sink, SINK_IN),
      ...(opts.secondFirst === true ? { from: FACTORY_OUT2 } : {}),
    },
    { step: 'belt-out-2', belt: () => beltFromPort(BELT_OUT2_ID, factory, outs[1]!, sink2, SINK_IN) },
  ];
  for (const { step, belt, from } of plan.slice(0, opts.beltsDrawn ?? 3)) {
    await expect.poll(async () => (await readProbe(page)).stepId, { message: `the lesson reached ${step}` }).toBe(step);
    await armThrough(page, 'belt-tool', 'belt-draw', visit);
    await stopAt(page, 'belt-draw', visit);
    await visitCarryOn(page, h, { nodes, belts: board.belts, tick: board.tick }, belt(), visit);
    if (visit !== undefined) board.tick += 2;
    await dragThroughRings(page, h, from === undefined ? undefined : await doorstepCentre(page, portOf(factory, from)));
    board.belts.push(belt());
    injectBoard(h, { nodes, belts: board.belts, tick: ++board.tick });
    await expect.poll(async () => (await readProbe(page)).stepId, { message: `the joined belt finished ${step}` }).not.toBe(step);
  }
  return board;
}

/**
 * From a built board with the Belt tool armed to lesson 4's code-line stage. The Factory selected at
 * step 4 stays selected while tools are armed, so the card goes straight to the code line unless
 * something cleared the selection, and then it asks for the press. With a visit, Escape clears the
 * selection so the card shows select-factory too.
 */
export async function toTypeCode(page: Page, visit?: Visit): Promise<HintRect> {
  await expectAt(page, 'change-code', 'tool-down', 'the third belt finished belt-out-2, and the Belt tool is still armed');
  await stopAt(page, 'tool-down', visit);
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await readProbe(page)).stageId, { message: 'with the tool down the card asks for the Factory or its code' })
    .toMatch(/^(select-factory|type-code)$/);
  await armThrough(page, 'select-factory', 'type-code', visit);
  return ringAt(page, 'type-code');
}

/**
 * The point just after `after` in the editor line that holds it: two px past the right edge of its
 * last character, which CodeMirror reads as the gap after it. The walk finds it the same way.
 */
export async function pointAfter(page: Page, after: string): Promise<{ x: number; y: number }> {
  const at = await page.evaluate((text) => {
    const line = [...document.querySelectorAll('aside[aria-labelledby="fab-config-heading"] .cm-line')].find((l) => (l.textContent ?? '').includes(text));
    if (line === undefined) return null;
    const end = (line.textContent ?? '').indexOf(text) + text.length;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (seen + length >= end) {
        const range = document.createRange();
        range.setStart(node, end - seen - 1);
        range.setEnd(node, end - seen);
        const box = range.getBoundingClientRect();
        return { x: box.right + 2, y: box.top + box.height / 2 };
      }
      seen += length;
    }
    return null;
  }, after);
  if (at === null) throw new Error(`no editor line holds ${JSON.stringify(after)}`);
  return at;
}

/** Click just after `after` and type `insert`, the way a user puts the caret there and types. */
export async function typeAfter(page: Page, after: string, insert: string): Promise<void> {
  const at = await pointAfter(page, after);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.insertText(insert);
}

/**
 * Lesson 4's step 10 from type-code: the lesson's own line typed after the first emit, Apply under its
 * ring, and the host holding the code. Ends at the watch stage.
 */
export async function typeAndApply(page: Page, h: Harness, visit?: Visit): Promise<void> {
  const gesture = TWO_OUTPUTS.steps.find((s) => s.id === 'change-code')?.stages.find((st) => st.id === 'type-code')?.gesture;
  if (gesture?.do !== 'typeCode') throw new Error('lesson 4 type-code types no code');
  await stopAt(page, 'type-code', visit);
  await typeAfter(page, gesture.after, gesture.insert);
  await expectAt(page, 'change-code', 'apply-code', 'the not-applied marker moved the card to Apply');
  await stopAt(page, 'apply-code', visit);
  const configures = sentCount(h, CMD.Configure);
  await pressRing(page, await ringAt(page, 'apply-code'));
  await expect.poll(() => sentCount(h, CMD.Configure), { message: 'Apply under its ring sent the code' }).toBe(configures + 1);
  await expectAt(page, 'change-code', 'watch', 'Apply moved the card to the watch stage');
  await stopAt(page, 'watch', visit);
}
