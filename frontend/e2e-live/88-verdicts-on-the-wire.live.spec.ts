import { test, expect, type Page } from '@playwright/test';
import { GESTURE_FRAME_VERSION } from '../e2e/support/wire';
import {
  CELL,
  DRAWN_STATE_FRAMES,
  armAndPlaceAt,
  cameraOf,
  drawnNodesOf,
  ensurePlaying,
  expectRenderLoopAlive,
  newBoard,
  pollScene,
  readScene,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';

// 88-verdicts-on-the-wire.live.spec.ts (plan 88-03, D-02, D-05, D-06, research Pitfall 8) - the
// board generation and the gesture verdicts, read off the REAL host's wire. On the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets: every machine comes off the palette, every press is the shipped control, and every
// frame graded here is one the page itself sent or received on its own render socket.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-02: every render packet names the board generation of its handle table, every reset
// (Undo, Redo, Load, New) raises it by one, and every gesture frame the page sends carries the
// generation it read its handles under, in a header before the body (the version byte, T-88-09,
// then two varints).
// D-06: every gesture gets exactly one verdict back, naming it by the page's own gesture id: a
// refusal (with its sentence), or an accept after the tick that folded it, naming the handles
// it minted. Pitfall 8: an accept now WRITES a frame, and still shows the user no sentence.
//
// ---------------------------------------------------------------------------
// THE LEGS
// ---------------------------------------------------------------------------
//
//   1. THE GENERATION RISES AT EVERY RESET, AND A GESTURE MADE AFTER EACH LANDS. On a fresh
//      board read the generation g; place a Source (drawn, still g); Ctrl+Z (g+1, no Source
//      drawn); Ctrl+Shift+Z (g+2, the Source drawn again); New board (g+3); place a Source
//      (drawn). Every gesture frame the page sent carries, in its header, the generation the
//      page was on when it sent it.
//   2. AN ACCEPTED DROP IS ANSWERED WITH THE HANDLE THE BOARD THEN DRAWS, AND A REFUSED ONE WITH
//      ITS SENTENCE. Place a Source on a free cell: exactly one `gestureAccepted` frame comes
//      back for that Place's gesture id, its `minted` holding the id the machine layer draws,
//      and the band stays empty. Drop a Source on that Source: exactly one `gestureRefused`
//      frame comes back for THAT drop's gesture id, tag `FootprintCollision`, and the band reads
//      its sentence.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` on a
// ticking board after each gesture block, and the watcher's `assertNone`.

/** Kind byte (protocol `machine_kind`), transcribed: the live suite imports no product source. */
const KIND_SOURCE = 0;
/** `GridCommand::Place`'s postcard discriminant. */
const PLACE_TAG = 0;
/** The verdict `kind` literals (`transport.ts`), transcribed. */
const ACCEPTED = 'gestureAccepted';
const REFUSED = 'gestureRefused';
/** `REFUSAL_COPY.FootprintCollision`, transcribed. */
const FOOTPRINT_COLLISION = 'That space is taken. Clear it or try elsewhere.';

/** The ticks one host answer may take on a playing board, for the derived budgets. */
const ANSWER_TICKS = 120;
/** Phase 87 measured about 20 ticks a second under the CPU quota, so every tick budget is
 *  this many times the ticks it waits for (`88-late-label-echo`). */
const SLOW_BOARD = 3;
const ANSWER_MS = tickBudgetMs(SLOW_BOARD * ANSWER_TICKS);

function answerWait(what: string): number {
  return addWaitBudget(ANSWER_MS, what);
}

/** The screen point the legs build around, clear of the palette and the right-docked panels. */
const VIEW_AT = { x: 560, y: 300 } as const;

/** One gesture frame the page sent, its header read and its body's first byte. */
interface SentGesture {
  generation: number;
  gestureId: number;
  /** The body's first byte: the `GridCommand` discriminant, or 0xFE for a run-pace frame. */
  lead: number;
  /** The page's scene generation at the moment the frame went out (read inside `send`). */
  sceneGenerationAtSend: number;
}

/** One verdict frame the page received, parsed. */
interface Verdict {
  kind: string;
  seq?: number;
  tag?: string;
  generation?: number;
  minted?: number[];
}

/** Read one LEB128 varint at `at`, returning it and the next index (or null if cut short). */
function varint(bytes: number[], at: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < 10 && at + i < bytes.length; i++) {
    const b = bytes[at + i];
    value += (b & 0x7f) * 2 ** (7 * i);
    if ((b & 0x80) === 0) return [value, at + i + 1];
  }
  return null;
}

/**
 * Record the page's own render-socket traffic: every binary gesture frame it SENDS, with its
 * header read and the generation the page's scene held AT THE MOMENT of the send (read in the
 * page, inside `WebSocket.prototype.send`, so no poll can lag it), and every verdict TEXT frame
 * it RECEIVES. Installed before `goto`.
 */
async function recordWire(page: Page): Promise<{ sent(): Promise<SentGesture[]>; verdicts: Verdict[] }> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __sentGestures: { bytes: number[]; sceneGeneration: number }[];
      __fabrico?: { scene(): { generation: number } };
    };
    w.__sentGestures = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      let bytes: Uint8Array | null = null;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes !== null) {
        w.__sentGestures.push({ bytes: [...bytes], sceneGeneration: w.__fabrico?.scene().generation ?? -1 });
      }
      return send.call(this, data as Parameters<WebSocket['send']>[0]);
    };
  });
  const verdicts: Verdict[] = [];
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(f.payload);
      } catch {
        return;
      }
      const v = msg as Verdict;
      if (v && (v.kind === ACCEPTED || v.kind === REFUSED || v.kind === 'gestureDiscarded')) verdicts.push(v);
    });
  });
  const sent = async (): Promise<SentGesture[]> => {
    const raw = await page.evaluate(
      () => (window as unknown as { __sentGestures: { bytes: number[]; sceneGeneration: number }[] }).__sentGestures,
    );
    return raw.map(({ bytes, sceneGeneration }) => {
      // The version byte first (T-88-09), then the two varints.
      const g = bytes[0] === GESTURE_FRAME_VERSION ? varint(bytes, 1) : null;
      const id = g === null ? null : varint(bytes, g[1]);
      if (g === null || id === null) {
        throw new Error(`the page sent a gesture frame with no readable header: [${bytes.join(',')}]`);
      }
      return { generation: g[0], gestureId: id[0], lead: bytes[id[1]] ?? -1, sceneGenerationAtSend: sceneGeneration };
    });
  };
  return { sent, verdicts };
}

/** The page's scene generation, read off `window.__fabrico.scene()` (phase 88, D-02). */
async function generationOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { scene(): { generation: number } } }).__fabrico;
    if (!hook) throw new Error('window.__fabrico not installed');
    return hook.scene().generation;
  });
}

/** The band's text, trimmed. */
async function bandText(page: Page): Promise<string> {
  return ((await page.locator('#fab-refusal').textContent()) ?? '').trim();
}

/** The world cell under `VIEW_AT` on the camera as it is now (New keeps the camera). */
async function cellInView(page: Page, dx = 0): Promise<[number, number]> {
  const cam = await cameraOf(page);
  return [
    Math.floor((VIEW_AT.x - cam.x) / cam.scale / CELL) + dx,
    Math.floor((VIEW_AT.y - cam.y) / cam.scale / CELL),
  ];
}

/** The Source whose footprint holds `at`, if any. */
async function sourceAt(page: Page, at: readonly [number, number]): Promise<number | undefined> {
  return (await readScene(page)).nodes.find(
    (n) => n.kind === KIND_SOURCE && n.cells.some(([x, y]) => x === at[0] && y === at[1]),
  )?.id;
}

/** Assert the canvas is what sits under `at`'s screen point, then return that point. */
async function canvasUnder(page: Page, at: readonly [number, number], what: string): Promise<{ x: number; y: number }> {
  const pt = await screenCellCentre(page, at[0], at[1]);
  expect(
    await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const),
    `PRECONDITION: the canvas is under ${what} (${at[0]},${at[1]}) at screen (${Math.round(pt.x)},${Math.round(pt.y)})`,
  ).toBe('CANVAS');
  return pt;
}

/** Wait until the machine layer draws exactly `ids` (ascending). */
async function expectDrawn(page: Page, ids: number[], message: string): Promise<void> {
  await expect
    .poll(async () => (await drawnNodesOf(page)).machines, {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES) + ANSWER_MS, message),
      message,
    })
    .toEqual([...ids].sort((a, b) => a - b));
}

/** Wait until the page's scene generation reads `want`. */
async function expectGeneration(page: Page, want: number, message: string): Promise<void> {
  await expect.poll(() => generationOf(page), { timeout: answerWait(message), message }).toBe(want);
}

/** A fresh, playing, empty board at 100% zoom, with the wire recorder installed first. */
async function bootEmpty(page: Page): Promise<{ errs: ReturnType<typeof watchPageErrors>; wire: Awaited<ReturnType<typeof recordWire>> }> {
  const errs = watchPageErrors(page);
  const wire = await recordWire(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await waitForAppReady(page);
  await newBoard(page);
  await ensurePlaying(page);
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  return { errs, wire };
}

test.describe('the board generation and the gesture verdicts on the real wire (plan 88-03)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('the board generation rises at every Undo, Redo and New board, and a gesture made after each lands', async ({
    page,
  }) => {
    test.setTimeout(addWaitBudget(12 * ANSWER_MS, 'leg 1: five gestures, each one host answer'));
    const { errs, wire } = await bootEmpty(page);
    const g = await generationOf(page);
    console.log(`LEG1_START generation=${g}`);

    // A Source, placed: a diff, so the generation stays.
    const at = await cellInView(page);
    await canvasUnder(page, at, 'the Source cell');
    await armAndPlaceAt(page, 'Source', at[0], at[1]);
    await pollScene(page, () => sourceAt(page, at), { timeout: answerWait('the Place echo'), message: 'the Source folded' }).toBeDefined();
    const first = (await sourceAt(page, at))!;
    await expectDrawn(page, [first], 'the machine layer draws the Source');
    expect(await generationOf(page), 'a Place is a diff: the generation does not move').toBe(g);
    await expectRenderLoopAlive(page, 'leg 1: the Source placed');

    // Ctrl+Z: a reset, g + 1, and nothing drawn.
    await page.keyboard.press('Control+z');
    await expectGeneration(page, g + 1, 'the Undo raised the generation by one');
    await pollScene(page, (s) => s.nodes.length, { timeout: answerWait('the Undo'), message: 'the Undo took the Source back' }).toBe(0);
    await expectDrawn(page, [], 'the machine layer draws nothing after the Undo');
    await expectRenderLoopAlive(page, 'leg 1: after the Undo');

    // Ctrl+Shift+Z: another reset, g + 2, the Source drawn again (on a handle of the new table).
    await page.keyboard.press('Control+Shift+z');
    await expectGeneration(page, g + 2, 'the Redo raised the generation by one more');
    await pollScene(page, () => sourceAt(page, at), { timeout: answerWait('the Redo'), message: 'the Redo put the Source back' }).toBeDefined();
    const redone = (await sourceAt(page, at))!;
    await expectDrawn(page, [redone], 'the machine layer draws the Source again after the Redo');
    await expectRenderLoopAlive(page, 'leg 1: after the Redo');

    // New board: a swap, g + 3; then a Source placed on it lands.
    await newBoard(page);
    await expectGeneration(page, g + 3, 'New board raised the generation by one more');
    const later = await cellInView(page, 3);
    await canvasUnder(page, later, 'the second Source cell');
    await armAndPlaceAt(page, 'Source', later[0], later[1]);
    await pollScene(page, () => sourceAt(page, later), {
      timeout: answerWait('the Place echo on the new board'),
      message: 'a Source placed after New folded on the new board',
    }).toBeDefined();
    const last = (await sourceAt(page, later))!;
    await expectDrawn(page, [last], 'the machine layer draws the Source on the new board');
    await expectRenderLoopAlive(page, 'leg 1: the Source placed on the new board');

    // The header of every gesture the page sent names the generation it held when it sent it.
    const gestures = await wire.sent();
    console.log(`LEG1_SENT ${JSON.stringify(gestures)}`);
    const places = gestures.filter((s) => s.lead === PLACE_TAG);
    expect(places.length, 'two Places went out').toBeGreaterThanOrEqual(2);
    expect(places[0].generation, 'the first Place names generation g').toBe(g);
    expect(places[places.length - 1].generation, 'the Place made after New names g + 3').toBe(g + 3);
    for (const s of gestures) {
      expect(s.generation, `gesture ${s.gestureId} names the generation the page was on`).toBe(s.sceneGenerationAtSend);
    }
    const ids = gestures.map((s) => s.gestureId);
    expect(ids, 'the page numbers its gestures 1, 2, 3, ... with no gap or repeat').toEqual(ids.map((_, i) => ids[0] + i));
    errs.assertNone('leg 1');
  });

  test('an accepted drop is answered with the handle the board then draws, and a refused one with its sentence', async ({
    page,
  }) => {
    test.setTimeout(addWaitBudget(10 * ANSWER_MS, 'leg 2: two gestures and their answers'));
    const { errs, wire } = await bootEmpty(page);

    // THE ACCEPT. A Source on a free cell.
    const at = await cellInView(page);
    await canvasUnder(page, at, 'the Source cell');
    const sentBefore = (await wire.sent()).length;
    await armAndPlaceAt(page, 'Source', at[0], at[1]);
    await pollScene(page, () => sourceAt(page, at), { timeout: answerWait('the Place echo'), message: 'the Source folded' }).toBeDefined();
    const source = (await sourceAt(page, at))!;
    await expectDrawn(page, [source], 'the machine layer draws the Source');
    const place = (await wire.sent()).slice(sentBefore).find((s) => s.lead === PLACE_TAG);
    expect(place, 'the Place went out with a header').toBeDefined();
    await expect
      .poll(() => wire.verdicts.filter((v) => v.seq === place!.gestureId).length, {
        timeout: answerWait('the accept'),
        message: `the host answered gesture ${place!.gestureId}`,
      })
      .toBeGreaterThan(0);
    const placeAnswers = wire.verdicts.filter((v) => v.seq === place!.gestureId);
    console.log(`LEG2_ACCEPT gesture=${place!.gestureId} answers=${JSON.stringify(placeAnswers)} drawn=${source}`);
    expect(placeAnswers, 'exactly one verdict for the Place, and it is an accept').toHaveLength(1);
    expect(placeAnswers[0].kind).toBe(ACCEPTED);
    expect(placeAnswers[0].minted, 'the accept names the handle the machine layer draws').toEqual([source]);
    expect(placeAnswers[0].generation, 'in the generation the page is on').toBe(await generationOf(page));
    expect(await bandText(page), 'an accept shows the user no sentence (Pitfall 8)').toBe('');
    await expectRenderLoopAlive(page, 'leg 2: the Source placed and accepted');

    // THE REFUSAL. Another Source dropped on that Source's cell.
    const sentBeforeDrop = (await wire.sent()).length;
    await armAndPlaceAt(page, 'Source', at[0], at[1]);
    await expect
      .poll(async () => (await wire.sent()).slice(sentBeforeDrop).find((s) => s.lead === PLACE_TAG) !== undefined, {
        timeout: answerWait('the second drop'),
        message: 'the drop on the Source went out',
      })
      .toBe(true);
    const drop = (await wire.sent()).slice(sentBeforeDrop).find((s) => s.lead === PLACE_TAG)!;
    await expect
      .poll(() => bandText(page), { timeout: answerWait('the refusal sentence'), message: 'the band reads the refusal' })
      .toBe(FOOTPRINT_COLLISION);
    const dropAnswers = wire.verdicts.filter((v) => v.seq === drop.gestureId);
    console.log(`LEG2_REFUSE gesture=${drop.gestureId} answers=${JSON.stringify(dropAnswers)}`);
    expect(dropAnswers, 'exactly one verdict for the drop, and it is a refusal').toHaveLength(1);
    expect(dropAnswers[0]).toEqual({ kind: REFUSED, seq: drop.gestureId, tag: 'FootprintCollision', cmd: 'Place' });
    expect(drop.gestureId, 'the drop is a later gesture than the Place').toBeGreaterThan(place!.gestureId);
    expect((await readScene(page)).nodes.length, 'the refused drop added nothing').toBe(1);
    await expectDrawn(page, [source], 'the machine layer still draws the one Source');
    await expectRenderLoopAlive(page, 'leg 2: after the refused drop');
    errs.assertNone('leg 2');
  });
});
