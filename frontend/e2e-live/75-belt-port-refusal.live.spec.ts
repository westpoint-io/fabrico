import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  demoCallerAndHandler,
  expectRenderLoopAlive,
  nodeAtAnchor,
  pollScene,
  nubAnchor,
  readScene,
  resetToDemo,
  screenPoint,
  waitForAppReady,
  watchPageErrors,
  waitForCameraSettle,
  wirePreviewPolylines,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 75-belt-port-refusal.live.spec.ts (plan 75-07, D-12) - on the REAL host (dev_render_server,
// real Core -> RenderProducer -> postcard -> WS), a Wire-tool press on a port that only takes
// belts is answered AT THE PRESS, in words: the refusal band reads
// `That port takes belts, not wires.`, no corridor is drawn while the pointer moves, and the
// release sends nothing, so the host never has to say `Belts and wires use different ports.`
// Zero mocks, zero injected packets.
//
// ---------------------------------------------------------------------------
// THE RULING
// ---------------------------------------------------------------------------
//
// D-12 (2026-10-06, "Fix it in 75"): "With the Wire tool,
// pressing a port that only takes belts (for example a Router's) is refused immediately with
// a plain sentence saying that port takes belts, not wires. No red drag."
//
// The reported symptom on the real binary (2026-10-02, the folded todo): "dragging wire from router
// doesn't work, becomes red whatever I do". The host was right to refuse; the defect was that
// nothing on screen said why, so correct behaviour read as broken.
//
// UI-SPEC 5.1: press = the reject flash over that port's cell AND the sentence; move = nothing
// draws; release = nothing is sent, no second message.
//
// ---------------------------------------------------------------------------
// THE LEG
// ---------------------------------------------------------------------------
//
// A Router the leg places from the palette at (20,9) (plan 85-07, D-19: a leg that
// needs a free nub brings its own machine; until 85-07 this was the demo Router's free port 3
// at (15,0), and phase 85's demo docks every Router output). Its topmost free MECHANICAL Out,
// (21,9) facing E, is found from its ports (the same port `18-refusal.spec.ts` names), and its
// cell, side, role and medium are asserted, never typed into the gesture.
//
// The hand presses (+3, -2) screen px off the nub's anchor, then walks toward the demo
// handler's ELECTRICAL In, found BY KIND (`demoCallerAndHandler`, never a cell), in steps of at
// most 6 screen px, with a diagonal stretch, and releases a few px off that nub. That release
// target is the one a user would aim at, and before phase 75 it is where the host answered
// MediumMismatch.
//
// THE GUARD RADIUS IS NOT THE HIT RADIUS. The Wire tool's press hit test is
// `wireNubHitRadiusWorld` (22 world px at zoom <= 1), which this suite may not import. The
// guard below asserts over a WIDER 64 world px that no ELECTRICAL Out is near the press: an
// electrical Out in range always wins the press (UI-SPEC 5.1), so with one in reach this leg
// would be testing the ranker, not the refusal.
//
// RED AT THE START REVISION (recorded in 75-07-SUMMARY.md): the band was empty at
// the press, the drag plotted a red corridor, and after the release the host's
// `Belts and wires use different ports.` was latched. The three are soft assertions so one
// run records all three.
//
// RENDER HEALTH. `watchPageErrors` is installed before `goto`, and `expectRenderLoopAlive`
// runs on both sides of the gesture: the model oracle is blind to a dead Pixi ticker.

type Pt = { x: number; y: number };

/** The D-12 sentence, transcribed, not imported (`CLIENT_REFUSAL_COPY.BeltOnlyPort`). */
const BELT_ONLY_PORT_COPY = 'That port takes belts, not wires.';
/** The host's `REFUSAL_COPY.MediumMismatch`, transcribed: the sentence this leg must never see. */
const MEDIUM_MISMATCH_COPY = 'Belts and wires use different ports.';

/** The anchor of the Router this leg places, on floor clear of the demo board. */
const ROUTER_ANCHOR = [20, 9] as const;
const ROLE_IN = 0;
const ROLE_OUT = 1;
const MEDIUM_MECHANICAL = 0;
const MEDIUM_ELECTRICAL = 1;
const SIDE_E = 1;
const SIDE_W = 3;
/** Twice a cell: wider than any radius the Wire tool's press could take. */
const WIRE_NUB_GUARD_RADIUS_WORLD = 64;
/** UI-SPEC 5.1 "at once": the sentence is on screen within half a second of the press. */
const PRESS_TO_SENTENCE_MS = 500;
/** The largest per-axis pointer step, in screen px (the hand helper's own bound). */
const STEP_PX = 6;
const DIAGONAL_STEP_PX = 4;
const PAUSE_MS = 8;

/** Every port in the scene, flattened, with its world nub anchor. */
function allNubs(scene: SceneFacts): Array<{ nodeId: number; port: PortFacts } & Pt> {
  return scene.nodes.flatMap((n) =>
    n.ports.map((p) => ({ nodeId: n.id, port: p, ...nubAnchor(p.cell_x, p.cell_y, p.side) })),
  );
}

/**
 * Start an in-page latch on `#fab-refusal`: every non-empty text the region ever held, with
 * the `performance.now()` it first appeared. A MutationObserver, so a sentence that shows
 * and goes between two Playwright polls is still recorded.
 */
async function latchRefusals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __refusalsSeen?: Array<{ text: string; at: number }> };
    const seen: Array<{ text: string; at: number }> = [];
    w.__refusalsSeen = seen;
    const region = document.getElementById('fab-refusal');
    if (!region) throw new Error('#fab-refusal is not mounted');
    const record = (): void => {
      const text = (region.textContent ?? '').trim();
      if (text !== '' && (seen.length === 0 || seen[seen.length - 1].text !== text)) {
        seen.push({ text, at: performance.now() });
      }
    };
    record();
    new MutationObserver(record).observe(region, { subtree: true, childList: true, characterData: true });
  });
}

async function refusalsSeen(page: Page): Promise<Array<{ text: string; at: number }>> {
  return page.evaluate(
    () => (window as unknown as { __refusalsSeen: Array<{ text: string; at: number }> }).__refusalsSeen,
  );
}

/** Start a per-frame latch recording whether the reject flash was ever plotted. */
async function latchFlash(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabrico: { rejectFlashInstructions(): number };
      __flashSeen?: boolean;
    };
    if (typeof w.__fabrico?.rejectFlashInstructions !== 'function') {
      throw new Error('window.__fabrico.rejectFlashInstructions() not installed');
    }
    w.__flashSeen = false;
    const tick = (): void => {
      if (w.__fabrico.rejectFlashInstructions() > 0) {
        w.__flashSeen = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Whether the latch saw the flash within `ms`. Waited for rather than read once: the latch
 * runs on the next animation frame, and the sentence can be on screen before that frame.
 */
async function flashSeen(page: Page, ms: number): Promise<boolean> {
  try {
    await page.waitForFunction(() => (window as unknown as { __flashSeen?: boolean }).__flashSeen === true, null, {
      timeout: ms,
    });
    return true;
  } catch {
    return false;
  }
}

/** Wait up to `ms` for the refusal band to read `text`; false on timeout rather than a throw. */
async function refusalReads(page: Page, text: string, ms: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      (t) => ((document.getElementById('fab-refusal')?.textContent ?? '').trim() === t),
      text,
      { timeout: ms },
    );
    return true;
  } catch {
    return false;
  }
}

test.describe('D-12 live: the Wire tool refuses a belt-only port at the press, in words', () => {
  test("a Wire press on the Router's output says the port takes belts, draws nothing and sends nothing", async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await expectRenderLoopAlive(page, 'before the press');
    errs.assertNone('before the press');

    // THE LEG'S OWN ROUTER (D-19), placed from the palette on floor the demo leaves bare.
    const fresh = await readScene(page);
    expect(
      fresh.nodes.some((n) => n.cells.some(([x, y]) => x === ROUTER_ANCHOR[0] && y === ROUTER_ANCHOR[1])) ||
        fresh.belts.some((b) => b.tiles.some((t) => t.cell_x === ROUTER_ANCHOR[0] && t.cell_y === ROUTER_ANCHOR[1])),
      `(${ROUTER_ANCHOR[0]},${ROUTER_ANCHOR[1]}) is bare floor on the demo, so the leg's own Router lands there`,
    ).toBe(false);
    await armAndPlaceAt(page, 'Router', ROUTER_ANCHOR[0], ROUTER_ANCHOR[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, ROUTER_ANCHOR[0], ROUTER_ANCHOR[1]) !== undefined, {
      message: 'the hand-placed Router folded on the real host',
    }).toBe(true);
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, "right after placing the leg's own Router");

    const before = await readScene(page);
    const wiresBefore = before.wires.length;

    const router = nodeAtAnchor(before, ROUTER_ANCHOR[0], ROUTER_ANCHOR[1]);
    expect(router, 'the placed Router is anchored at (20,9)').toBeTruthy();
    // The port is found from the Router's ports, never by an index: the TOPMOST Mechanical
    // Out with no belt docked to it (a Tail dock's `port` is the Out's routing key).
    const routerOuts = router!.ports.filter((p) => p.role === ROLE_OUT);
    const freeOuts = routerOuts.filter(
      (p) =>
        p.medium === MEDIUM_MECHANICAL &&
        !before.belts.some((b) =>
          (b.docks ?? []).some((d) => d.end === 'Tail' && d.node === router!.id && d.port === routerOuts.indexOf(p)),
        ),
    );
    expect(freeOuts.length, 'the placed Router has a free Mechanical Out').toBeGreaterThan(0);
    const source: PortFacts = freeOuts.reduce((top, p) => (p.cell_y < top.cell_y ? p : top));
    expect(
      [source.cell_x, source.cell_y, source.side, source.role, source.medium],
      "the placed Router's free top Out is a MECHANICAL Out at (21,9) facing E",
    ).toEqual([21, 9, SIDE_E, ROLE_OUT, MEDIUM_MECHANICAL]);
    expect(
      before.wires.some((w) => w.from.node === router!.id || w.to.node === router!.id),
      'no cable touches the Router',
    ).toBe(false);

    // THE RELEASE TARGET: the demo's handler, found BY KIND (plan 85-07), never a cell.
    const { handler } = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'right after finding the demo pair by kind');
    expect(handler, 'the demo board carries its HTTP Handler').toBeTruthy();
    const target = handler.ports.find((p) => p.role === ROLE_IN);
    // Its In is ELECTRICAL and faces W, read off its own ports: the cell is whatever the
    // demo gives it, the role, side and medium are what make this the wrong-medium target.
    expect(
      target && [target.side, target.role, target.medium],
      "the handler's In is an ELECTRICAL In facing W",
    ).toEqual([SIDE_W, ROLE_IN, MEDIUM_ELECTRICAL]);

    // THE GUARD: no electrical Out anywhere near the press, and the nearest nub to it is the
    // Router's port 3, so the press can only resolve to the port this leg names.
    const srcAnchor = nubAnchor(source.cell_x, source.cell_y, source.side);
    const near = allNubs(before)
      .map((n) => ({ ...n, d: Math.hypot(n.x - srcAnchor.x, n.y - srcAnchor.y) }))
      .filter((n) => n.d <= WIRE_NUB_GUARD_RADIUS_WORLD)
      .sort((a, b) => a.d - b.d);
    expect(
      near.filter((n) => n.port.role === ROLE_OUT && n.port.medium === MEDIUM_ELECTRICAL).length,
      'no ELECTRICAL Out is within the guard radius of the press, so nothing can win the press over the refusal',
    ).toBe(0);
    expect(
      [near[0]?.nodeId, near[0]?.port.index],
      "the nearest nub to the press is the Router's free top Out itself",
    ).toEqual([router!.id, source.index]);

    const a = await screenPoint(page, srcAnchor);
    const b = await screenPoint(page, nubAnchor(target!.cell_x, target!.cell_y, target!.side));
    const start: Pt = { x: a.x + 3, y: a.y - 2 };
    const end: Pt = { x: b.x - 2, y: b.y + 3 };
    const tags = await page.evaluate(
      (ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null),
      [start, end],
    );
    expect(tags, 'the press and release points are on the canvas, not under chrome').toEqual(['CANVAS', 'CANVAS']);

    expect(await refusalReads(page, '', 15_000), 'the refusal band is empty before the press').toBe(true);
    await latchRefusals(page);
    await latchFlash(page);

    // Prefix-matched: the Wire tool title is user-facing copy that doubles as a selector.
    await page.getByTitle(/^Draw wires/).click();
    await page.mouse.move(start.x, start.y);
    const pressAt = await page.evaluate(() => performance.now());
    await page.mouse.down();

    // (1) THE SENTENCE, AT THE PRESS. Graded on the page's own clock: `pressAt` is read
    // before the button goes down, so the measured interval can only be longer than the real one.
    const said = await refusalReads(page, BELT_ONLY_PORT_COPY, 5_000);
    expect.soft(said, 'the press put the D-12 sentence in the refusal band').toBe(true);
    if (said) {
      const first = (await refusalsSeen(page)).find((r) => r.text === BELT_ONLY_PORT_COPY);
      expect
        .soft(first!.at - pressAt, `the sentence appeared within ${PRESS_TO_SENTENCE_MS} ms of the press`)
        .toBeLessThanOrEqual(PRESS_TO_SENTENCE_MS);
    }
    expect.soft(await flashSeen(page, 2_000), 'the press flashed the refused port').toBe(true);

    // (2) THE DRAG DRAWS NOTHING. Sub-cell steps, with a diagonal stretch, and the plotted
    // corridor read after every step.
    let x = start.x;
    let y = start.y;
    let mostRuns = 0;
    const toward = (v: number, goal: number, max: number): number =>
      goal > v ? Math.min(goal, v + max) : Math.max(goal, v - max);
    const moveTo = async (nx: number, ny: number): Promise<void> => {
      x = nx;
      y = ny;
      await page.mouse.move(x, y);
      await page.waitForTimeout(PAUSE_MS);
      mostRuns = Math.max(mostRuns, (await wirePreviewPolylines(page)).length);
    };
    const xMid = start.x + (end.x - start.x) / 2;
    while (Math.abs(xMid - x) > 0.5) await moveTo(toward(x, xMid, STEP_PX), y);
    while (Math.abs(end.x - x) > 0.5 && Math.abs(end.y - y) > 0.5) {
      await moveTo(toward(x, end.x, DIAGONAL_STEP_PX), toward(y, end.y, DIAGONAL_STEP_PX));
    }
    while (Math.abs(end.y - y) > 0.5) await moveTo(x, toward(y, end.y, STEP_PX));
    while (Math.abs(end.x - x) > 0.5) await moveTo(toward(x, end.x, STEP_PX), y);
    await moveTo(end.x, end.y);
    expect.soft(mostRuns, 'no corridor was plotted at any step of the drag').toBe(0);
    await expectRenderLoopAlive(page, 'while the pointer is held over the handler');

    // (3) THE RELEASE SENDS NOTHING: a second later the board has no new wire and the host
    // never said its MediumMismatch sentence.
    await page.mouse.up();
    await page.waitForTimeout(1_000);
    const texts = (await refusalsSeen(page)).map((r) => r.text);
    expect
      .soft(texts, 'the host never answered with its MediumMismatch sentence (nothing was sent)')
      .not.toContain(MEDIUM_MISMATCH_COPY);
    expect(texts, 'the only sentence the band ever held is the D-12 one').toEqual([BELT_ONLY_PORT_COPY]);
    expect((await readScene(page)).wires.length, 'a second after the release the board has no new wire').toBe(
      wiresBefore,
    );

    await page.keyboard.press('Escape');
    await expectRenderLoopAlive(page, 'after the release');
    errs.assertNone('the belt-only press');
  });
});
