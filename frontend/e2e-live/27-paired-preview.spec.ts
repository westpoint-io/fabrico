import { test, expect } from '@playwright/test';
import {
  armAndPlaceAt,
  expectRenderLoopAlive,
  nubAnchor,
  pollScene,
  readScene,
  resetToDemo,
  screenPoint,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 27-paired-preview.spec.ts (D-04, plan 72-11) - the RENDER-HEALTH gate for the
// two-ghost drag preview, and the only place in the repository where the paired preview
// runs against the real renderer at all.
//
// WHY THIS SPEC EXISTS. Plan 72-11 adds a SECOND corridor to the in-drag overlay and a
// fourth argument to `overlay.showRoute`. Every assertion that plan makes is a unit
// assertion: `gestures.test.ts` drives a RECORDING overlay and `overlay.test.ts` drives a
// recording Graphics. Neither one runs Pixi. An uncaught exception on the new stroke path
// would kill the renderer permanently while all 2266 unit assertions stayed green - that
// is this repository's own measured blind spot ("the live e2e oracle reads only the
// MODEL, so a dead Pixi renderer passes every suite"), and the drag preview is exactly
// the kind of work it hides.
//
// WHAT THIS SPEC PROVES: that the paired preview runs on the real renderer without
// killing it, MID-DRAG as well as after the release, and that the release keeps the
// promise the preview made - one drag, two cables (72-08's pairing).
//
// WHAT IT DOES NOT PROVE, stated rather than implied: nothing about the two corridors
// AS DRAWN. The live oracle emits `tiles: w.path.length` for a wire and nothing at all
// about the overlay (`sceneState.ts`), so the geometry of the pair, its lanes and its
// stroke are invisible here by construction. Those are `overlay.test.ts`'s and
// `gestures.test.ts`'s claims, and this spec does not restate them.

/** A 1x1 Route, on the free patch below the demo board that 20-wire-draw also uses. */
const ROUTE_CELL: readonly [number, number] = [18, 10];
/** A 3x3 Handler spanning (20..22, 9..11), immediately east of the Route. */
const HANDLER_CELL: readonly [number, number] = [20, 9];
const MEDIUM_ELECTRICAL = 1;
const ROLE_IN = 0;
const ROLE_OUT = 1;

test.describe('D-04 live: the paired preview runs on the real renderer', () => {
  test('a Route-to-Handler drag previews mid-flight without killing the renderer, and lands both cables', async ({
    page,
  }) => {
    // FIRST statement, before any navigation: a `pageerror` listener registered after the
    // throw records nothing, so a boot-time throw would go unseen.
    const errs = watchPageErrors(page);

    await page.goto('/');
    await waitForAppReady(page);
    // ONE shared mutable host at `workers: 1`: a spec that mutates the board without
    // resetting poisons every spec after it.
    await resetToDemo(page);

    await expectRenderLoopAlive(page, 'before the paired drag');
    errs.assertNone('before the paired drag');

    await armAndPlaceAt(page, 'Route', ROUTE_CELL[0], ROUTE_CELL[1]);
    await armAndPlaceAt(page, 'HTTP Handler', HANDLER_CELL[0], HANDLER_CELL[1]);
    await pollScene(
      page,
      (s) =>
        s.nodes.filter((n) =>
          n.cells.some(
            ([x, y]) =>
              (x === ROUTE_CELL[0] && y === ROUTE_CELL[1]) ||
              (x === HANDLER_CELL[0] && y === HANDLER_CELL[1]),
          ),
        ).length,
      { message: 'both placements folded on the real host' },
    ).toBe(2);

    const before = await readScene(page);
    const route = before.nodes.find((n) =>
      n.cells.some(([x, y]) => x === ROUTE_CELL[0] && y === ROUTE_CELL[1]),
    );
    const handler = before.nodes.find((n) =>
      n.cells.some(([x, y]) => x === HANDLER_CELL[0] && y === HANDLER_CELL[1]),
    );
    expect(route, 'the placed Route is in the scene').toBeDefined();
    expect(handler, 'the placed Handler is in the scene').toBeDefined();

    const source = route!.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL);
    const target = handler!.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL);
    expect(source, 'the Route declares an electrical Out').toBeDefined();
    expect(target, 'the Handler declares an electrical In').toBeDefined();
    // D-02: ONE electrical Out on the Handler, which is what refuses a second Route and
    // what R-73 withdraws the In ring for once it is taken.
    expect(
      handler!.ports.filter((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL),
      'the Handler declares exactly ONE electrical Out',
    ).toHaveLength(1);

    // THE GESTURE, HELD OPEN. `drawWireBetweenPorts` presses, moves and releases in one
    // call; the paired preview lives entirely BETWEEN the move and the release, so it is
    // driven by hand here in order to look at the app while both ghosts are on screen.
    await page.getByTitle(/^Draw wires/).click();
    const start = await screenPoint(page, nubAnchor(source!.cell_x, source!.cell_y, source!.side));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const end = await screenPoint(page, nubAnchor(target!.cell_x, target!.cell_y, target!.side));
    await page.mouse.move(end.x, end.y);

    // MID-DRAG, WITH BOTH CORRIDORS PAINTED. This is the assertion the whole spec is
    // for: the second corridor is stroked on a pointer move, so a throw on that path
    // fires HERE, before any release, and it fires inside the layer that owns the Pixi
    // ticker. `expectRenderLoopAlive` reads the ticker rather than the packet buffer,
    // which is why it can see a renderer the model oracle cannot.
    await expectRenderLoopAlive(page, 'while the paired preview is on screen');
    errs.assertNone('while the paired preview is on screen');

    await page.mouse.up();
    await page.keyboard.press('Escape');

    // THE PROMISE THE PREVIEW MADE, KEPT. Two ghost corridors, two cables (72-08's
    // pairing under one action id). A build that previewed two and landed one would be
    // the failure `cableLane.ts` was written after, one grain coarser.
    await pollScene(page, (s) => s.wires.length, {
      message: 'ONE drag between a Route and a Handler folded BOTH cable legs',
    }).toBe(before.wires.length + 2);

    await expectRenderLoopAlive(page, 'after the paired release');
    errs.assertNone('after the paired release');

    // Leave the shared host as this spec found it.
    await resetToDemo(page);
  });
});
