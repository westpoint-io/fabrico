import { test, expect, type Page } from '@playwright/test';
import { CELL } from '../shared/geometry';
import { tickBudgetMs } from '../e2e/support/frameSampler';
import {
  anchorOf,
  armAndPlaceAt,
  cablePolylines,
  demoCallerAndHandler,
  drawWireBetweenPorts,
  expectRenderLoopAlive,
  glyphSubjectOn,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetToDemo,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 85-demo-handler-is-a-palette-handler.live.spec.ts (plan 85-08, DEMO-01, DEMO-02, SC1).
//
// The demo's caller and handler are built by ordinary logged commands (a Place of a Route, a
// Place of an HTTP Handler, two Configures and two DrawWires in `demo_scene.ron`), so on the
// real host they must be the SAME machines a user places from the palette. Until plan 85-08
// the handler was a 1x1 Factory minted outside the edit log with both cables on one nub
// (walk-112, SWEEP Appendix C); this spec is red on that board.
//
// What it grades, on the REAL dev host (no mock, no injected packet):
//   1. The demo handler is a 3x3 HTTP Handler: its cell box, its ports (offset from its anchor,
//      side, role, medium) and its drawn glyph subject equal those of an HTTP Handler this spec
//      places from the palette. A turned handler would move every nub, so the port offsets and
//      sides are what grade "not turned" (the scene oracle carries no rotation field; D-01).
//   2. The demo caller's ports equal a palette Route's.
//   3. The forward cable leaves the caller's Out (port 1) and enters the handler's In (port 0);
//      the return leaves the handler's Out (port 1) and enters the caller's In (port 0). Two
//      cables, separate nubs.
//   4. The return cable is DRAWN as a palette pair draws it: a Route placed at the same offset
//      from the palette Handler as the demo caller sits from the demo handler, wired by hand
//      (one drag from the Route's Out to the Handler's In, which brings the reply leg with it,
//      phase 72 D-04), plots the same two cable strokes translated by the anchor offset (D-01:
//      the loop is what any catalog pair draws, and the handler is not turned to dodge it).
//   5. A POST of `{}` to the caller's own URL reads the demo handler's reply body `home`.
//
// The palette pair goes on floor that is empty on a fresh demo (85-EVIDENCE.md, `## Spec cells
// on the fresh demo`): the HTTP Handler at (20,9), whose 3x3 box (20..22, 9..11) is FREE, and
// the Route at the demo pair's own offset from it. Both drop cells are asserted bare first.
//
// RENDER HEALTH by name: `watchPageErrors` before `goto`, `expectRenderLoopAlive` after each
// placement and draw, `assertNone` at the end (fabrico-model-oracle-blindspot).

type Cell = readonly [number, number];

const ROLE_IN = 0;
const ROLE_OUT = 1;
const KIND_HANDLER = 10;
const KIND_ROUTE = 9;
/** The palette HTTP Handler's drop cell: its 3x3 box (20..22, 9..11) is FREE on a fresh demo. */
const PALETTE_HANDLER_AT: Cell = [20, 9];
/** The demo handler's reply body (D-04): what tells it from a palette Handler. */
const DEMO_REPLY_BODY = 'home';
/** Sim ticks a POST may take to hop the forward cable, run the handler and come home: a request
 *  is minted at the next tick boundary, each cable hop and the handler call take a few ticks,
 *  and 240 leaves the floor rate (`tickBudgetMs`) room for a slow machine. */
const REPLY_TICKS = 240;

type Node = SceneFacts['nodes'][number];

/** A node's cell box width and height. */
function boxOf(n: Node): { w: number; h: number } {
  const xs = n.cells.map((c) => c[0]);
  const ys = n.cells.map((c) => c[1]);
  return { w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
}

/** A node's ports as anchor-relative facts, in index order. */
function portShapes(n: Node): { index: number; dx: number; dy: number; side: number; role: number; medium: number }[] {
  const [ax, ay] = anchorOf(n);
  return [...n.ports]
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ index: p.index, dx: p.cell_x - ax, dy: p.cell_y - ay, side: p.side, role: p.role, medium: p.medium }));
}

/** The port of `role` on `n` (the first, by index). */
function portOfRole(n: Node, role: number): PortFacts {
  const p = [...n.ports].sort((a, b) => a.index - b.index).find((q) => q.role === role);
  expect(p, `node ${n.id} (kind ${n.kind}) carries a port of role ${role}`).toBeDefined();
  return p as PortFacts;
}

/** The plotted cable strokes, each rounded to half a world px and written `x,y x,y ..`, sorted. */
async function drawnStrokes(page: Page): Promise<string[]> {
  const half = (v: number): number => Math.round(v * 2) / 2;
  return (await cablePolylines(page))
    .map((pl) => pl.map((p) => `${half(p.x)},${half(p.y)}`).join(' '))
    .sort((a, b) => a.localeCompare(b));
}

/** A stroke moved by `(dx, dy)` world px, in the same written form. */
function translated(stroke: string, dx: number, dy: number): string {
  return stroke
    .split(' ')
    .map((xy) => {
      const [x, y] = xy.split(',').map(Number);
      return `${x + dx},${y + dy}`;
    })
    .join(' ');
}

/** Every cell of a `w`x`h` box anchored at `at` is empty on `scene`. */
function expectBare(scene: SceneFacts, at: Cell, w: number, h: number, what: string): void {
  const taken = new Set(scene.nodes.flatMap((n) => n.cells.map(([x, y]) => `${x},${y}`)));
  for (const b of scene.belts) for (const t of b.tiles) taken.add(`${t.cell_x},${t.cell_y}`);
  const hits: string[] = [];
  for (let x = at[0]; x < at[0] + w; x++) for (let y = at[1]; y < at[1] + h; y++) if (taken.has(`${x},${y}`)) hits.push(`(${x},${y})`);
  expect(hits, `${what}: the ${w}x${h} box at (${at[0]},${at[1]}) is bare on the fresh demo`).toEqual([]);
}

/** Place `kindName` from the palette at `at` and wait for the host to echo exactly that kind there. */
async function placeFromPalette(page: Page, kindName: string, kind: number, at: Cell): Promise<Node> {
  const before = (await readScene(page)).nodes.length;
  await armAndPlaceAt(page, kindName, at[0], at[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, at[0], at[1])?.kind, {
    message: `the real host echoed the ${kindName} placed at (${at[0]},${at[1]})`,
  }).toBe(kind);
  const scene = await readScene(page);
  expect(scene.nodes.length, `placing the ${kindName} added exactly one node`).toBe(before + 1);
  await expectRenderLoopAlive(page, `after placing the palette ${kindName}`);
  return nodeAtAnchor(scene, at[0], at[1]) as Node;
}

test.describe('DEMO-01 / DEMO-02 live: the demo handler is a palette HTTP Handler', () => {
  test('the demo pair matches a palette pair: size, nubs, glyph, separate cables, the same drawn return, and the home reply', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, 'on the fresh demo');

    const pair = await demoCallerAndHandler(page);
    const demoCaller = pair.caller;
    const demoHandler = pair.handler;
    const scene0 = await readScene(page);

    // ── 3. Two cables, separate nubs: caller Out (1) -> handler In (0), handler Out (1) -> caller In (0).
    const cable = (from: [number, number], to: [number, number]) =>
      scene0.wires.filter(
        (w) => w.from.node === from[0] && w.from.port === from[1] && w.to.node === to[0] && w.to.port === to[1],
      );
    expect(scene0.wires.length, 'the demo ships exactly two cables').toBe(2);
    expect(
      cable([demoCaller.id, 1], [demoHandler.id, 0]).length,
      `the forward cable leaves the caller's port 1 and enters the handler's port 0; cables ${JSON.stringify(scene0.wires.map((w) => [w.from, w.to]))}`,
    ).toBe(1);
    expect(
      cable([demoHandler.id, 1], [demoCaller.id, 0]).length,
      `the return cable leaves the handler's port 1 and enters the caller's port 0; cables ${JSON.stringify(scene0.wires.map((w) => [w.from, w.to]))}`,
    ).toBe(1);
    const roleAt = (n: Node, index: number) => n.ports.find((p) => p.index === index)?.role;
    expect(roleAt(demoCaller, 1), "the caller's port 1 is its Out").toBe(ROLE_OUT);
    expect(roleAt(demoCaller, 0), "the caller's port 0 is its In").toBe(ROLE_IN);
    expect(roleAt(demoHandler, 0), "the handler's port 0 is its In").toBe(ROLE_IN);
    expect(roleAt(demoHandler, 1), "the handler's port 1 is its Out").toBe(ROLE_OUT);

    // The demo's two strokes as plotted, before anything else is drawn.
    await expect
      .poll(async () => (await drawnStrokes(page)).length, { message: 'the wire layer plotted the demo pair\'s two cables' })
      .toBe(2);
    const demoStrokes = await drawnStrokes(page);

    // ── The palette pair, on bare floor, at the demo pair's own offset.
    const offset: [number, number] = [
      anchorOf(demoCaller)[0] - anchorOf(demoHandler)[0],
      anchorOf(demoCaller)[1] - anchorOf(demoHandler)[1],
    ];
    const paletteRouteAt: Cell = [PALETTE_HANDLER_AT[0] + offset[0], PALETTE_HANDLER_AT[1] + offset[1]];
    expectBare(scene0, PALETTE_HANDLER_AT, 3, 3, 'the palette HTTP Handler');
    expectBare(scene0, paletteRouteAt, 1, 1, 'the palette Route');
    const paletteHandler = await placeFromPalette(page, 'HTTP Handler', KIND_HANDLER, PALETTE_HANDLER_AT);
    const paletteRoute = await placeFromPalette(page, 'Route', KIND_ROUTE, paletteRouteAt);

    // ── 1. The demo handler IS a palette HTTP Handler: box, nubs, glyph.
    expect(boxOf(demoHandler), 'the demo handler is as big as a palette HTTP Handler').toEqual(boxOf(paletteHandler));
    expect(boxOf(demoHandler), 'which is the catalog 3x3').toEqual({ w: 3, h: 3 });
    expect(
      portShapes(demoHandler),
      'the demo handler has the palette HTTP Handler\'s nubs, at the same offsets and facings (so it is not turned)',
    ).toEqual(portShapes(paletteHandler));
    expect(
      portShapes(demoHandler).map((p) => p.role),
      'an In, an Out and a Fault, as the catalog gives it',
    ).toEqual([ROLE_IN, ROLE_OUT, 2]);
    const demoGlyph = await glyphSubjectOn(page, demoHandler.id);
    expect(demoGlyph, 'the demo handler draws a glyph').not.toBeNull();
    expect(demoGlyph, 'the demo handler draws the palette HTTP Handler\'s glyph').toBe(
      await glyphSubjectOn(page, paletteHandler.id),
    );

    // ── 2. The caller is a catalog Route.
    expect(boxOf(demoCaller), 'the demo caller is as big as a palette Route').toEqual(boxOf(paletteRoute));
    expect(portShapes(demoCaller), 'the demo caller has a palette Route\'s nubs').toEqual(portShapes(paletteRoute));

    // ── 4. Wire the palette pair by hand and compare the plotted strokes. One drag from the
    //    Route's Out to the Handler's In mints the request cable AND its reply leg (D-04).
    await drawWireBetweenPorts(page, portOfRole(paletteRoute, ROLE_OUT), portOfRole(paletteHandler, ROLE_IN));
    await pollScene(page, (s) => s.wires.length, {
      message: 'the hand-drawn cable folded with its reply leg (two cables more)',
    }).toBe(4);
    const handPair = (await readScene(page)).wires.filter(
      (w) => w.from.node === paletteRoute.id || w.from.node === paletteHandler.id,
    );
    expect(
      handPair.map((w) => [w.from, w.to]),
      "the hand pair's cables dock separate nubs exactly as the demo pair's do",
    ).toEqual([
      [{ node: paletteRoute.id, port: 1 }, { node: paletteHandler.id, port: 0 }],
      [{ node: paletteHandler.id, port: 1 }, { node: paletteRoute.id, port: 0 }],
    ]);
    await expectRenderLoopAlive(page, 'after the hand-drawn cable');
    await expect
      .poll(async () => (await drawnStrokes(page)).length, { message: 'the wire layer plotted all four cables' })
      .toBe(4);
    const handStrokes = (await drawnStrokes(page)).filter((s) => !demoStrokes.includes(s)).sort((a, b) => a.localeCompare(b));
    const dx = (PALETTE_HANDLER_AT[0] - anchorOf(demoHandler)[0]) * CELL;
    const dy = (PALETTE_HANDLER_AT[1] - anchorOf(demoHandler)[1]) * CELL;
    const demoMoved = demoStrokes.map((s) => translated(s, dx, dy)).sort((a, b) => a.localeCompare(b));
    expect(
      handStrokes,
      `the hand-wired palette pair plots the demo pair's two cables, the return loop included, moved by (${dx},${dy}) px`,
    ).toEqual(demoMoved);

    // ── 5. The demo caller answers at its own URL with the demo handler's body.
    const resp = await page.request.post(pair.callerUrl, {
      data: '{}',
      headers: { 'content-type': 'application/json' },
      timeout: tickBudgetMs(REPLY_TICKS),
      failOnStatusCode: false,
    });
    expect(resp.status(), `a POST to the demo caller (${pair.callerUrl}) is answered`).toBe(200);
    expect(await resp.text(), 'and the answer is the demo handler\'s body').toBe(DEMO_REPLY_BODY);

    await expectRenderLoopAlive(page, 'at the end');
    errs.assertNone('the demo pair against a palette pair');
  });
});
