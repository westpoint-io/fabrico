import { test, expect, type Page } from '@playwright/test';
import {
  anchorOf,
  armAndPlaceAt,
  drawWireBetweenPorts,
  expectRenderLoopAlive,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetToDemo,
  waitForAppReady,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 20-wire-draw.spec.ts (WIRE-02, plan 66-01) - the TRACER's end-to-end gate: a user
// arms the Wire tool from the palette, drags from an electrical Out nub to an
// electrical In nub, and a wire that did not exist before the drag exists after it,
// with the endpoints the pointer named.
//
// Nothing in `frontend/src` emitted `DrawWire` before this plan (WINDOWS row 82). The
// renderer half shipped in Phase 40 and the command half in Phase 63; this spec is the
// only thing in the repository that proves the twenty lines between them close.
//
// WHAT THIS SPEC PROVES, AND WHAT IT DOES NOT. The live model oracle emits
// `tiles: w.path.length` for a wire and nothing at all about the drawn cable
// (`sceneState.ts`). So this spec proves the COMMAND path (palette click -> nub press ->
// drag -> release -> one DrawWire -> host fold -> a WireView in the render packet) and
// it proves render HEALTH. It proves NOTHING about cable geometry: the D1 lane offset
// and the D3 overshoot clamp are invisible here by construction, and are 66-05's and
// 66-08's job.
//
// THE RENDER-HEALTH HALF IS NOT DECORATION. `window.__fabrico.scene()` reads the
// packet-application buffer and is completely independent of the Pixi ticker, so an
// uncaught exception inside a ticker listener kills the renderer permanently while every
// model assertion above stays green. Both liveness checks therefore run on BOTH sides of
// the gesture: the machines-missing bug of 2026-08-11 fired on the way back IN, not on
// the way out.
//
// WHY TWO PLACED ROUTES RATHER THAN THE DEMO'S OWN MACHINES. The demo board carries no
// free electrical `Role::Out` at all: its caller Route's Out is ALREADY the source of the
// forward wire, and since D-26 its handler's Out is the source of the RETURN wire (both
// found by kind elsewhere in the suite, `demoCallerAndHandler`, never by cell). Host step 6
// refuses a second wire out of an occupied source with `PortOccupied`, so a wire drawn
// between the demo's own ports could never land, and a spec asserting it did would be
// asserting a refusal.
//
// RE-POINTED BY PLAN 72-13, LEDGER ROW LR-6. This setup placed an `HTTP Router`, whose
// electrical preset seeded a free electrical Out. Plan 72-10's R-64 PULLED that palette
// row as a live false claim - nothing ever links a machine's OUTPUT port into a wire
// (`tick.rs` creates only the one link, from the request's entry), so a Router
// structurally cannot sit on a request path - and the `armAndPlaceAt` call here then
// timed out at 90s waiting for a row that no longer exists. Neither this file nor
// `16-router-presets.spec.ts` was in plan 72-13's `files_modified`; the scope was
// widened rather than the red left standing.
//
// TWO ROUTES, AND ROUTE-TO-ROUTE IS THE LOAD-BEARING CHOICE. A hand-placed Route's
// catalog arm declares an electrical In at index 0 and an electrical Out at index 1
// (`port_catalog(ENDPOINT)`), so the FIRST Route gives a genuinely free electrical Out
// and the SECOND a genuinely free electrical In. Drawing to a HANDLER instead would
// change this spec's subject: under D-04 a Route-to-Handler drag is a PAIRING that mints
// TWO cables from one gesture (`command.rs route_handler_pair`), and every assertion
// below is about ONE drag producing ONE wire between the two ports the pointer named.
// `route_handler_pair` answers `None` for two Routes, so the one-wire claim survives
// intact. The paired gesture is walked by `25-route-and-handler.spec.ts`.

/** The wire's DESTINATION: a second hand-placed Route, whose electrical In (index 0)
 *  faces W - directly at the source Route's E-facing Out. */
const TARGET_ROUTE_CELL: readonly [number, number] = [24, 9];
/** The wire's SOURCE: a hand-placed Route on a free row below the demo board, which
 *  occupies rows 0..8. Its electrical Out (index 1) faces E. */
const SOURCE_ROUTE_CELL: readonly [number, number] = [20, 9];
const MEDIUM_ELECTRICAL = 1;
const ROLE_IN = 0;
const ROLE_OUT = 1;

test.describe('WIRE-02 live: a wire drawn by hand, from palette click to wire on the board', () => {
  test('the Wire tool draws a wire between the two ports the pointer named', async ({ page }) => {
    // FIRST statement, before any navigation: `page.on('pageerror')` registered after the
    // error has fired records nothing, so a boot-time throw would go unseen.
    const errs = watchPageErrors(page);

    await page.goto('/');
    await waitForAppReady(page);
    // There is ONE shared mutable host at `workers: 1`. A spec that mutates the board
    // without resetting poisons every spec after it.
    await resetToDemo(page);

    await expectRenderLoopAlive(page, 'before the wire drag');
    errs.assertNone('before the wire drag');

    // Setup: two hand-placed Routes. The first gives a FREE electrical Out to drag
    // from, the second a FREE electrical In to release on (see the header note).
    await armAndPlaceAt(page, 'Route', SOURCE_ROUTE_CELL[0], SOURCE_ROUTE_CELL[1]);
    await pollScene(page, (s) => s.nodes.some((n) => n.cells.some(([x, y]) => x === SOURCE_ROUTE_CELL[0] && y === SOURCE_ROUTE_CELL[1])), {
      message: 'the source Route placement folded on the real host',
    }).toBe(true);
    await armAndPlaceAt(page, 'Route', TARGET_ROUTE_CELL[0], TARGET_ROUTE_CELL[1]);
    await pollScene(page, (s) => s.nodes.some((n) => n.cells.some(([x, y]) => x === TARGET_ROUTE_CELL[0] && y === TARGET_ROUTE_CELL[1])), {
      message: 'the destination Route placement folded on the real host',
    }).toBe(true);

    const before = await readScene(page);

    const router = before.nodes.find((n) =>
      n.cells.some(([x, y]) => x === SOURCE_ROUTE_CELL[0] && y === SOURCE_ROUTE_CELL[1]),
    );
    expect(router, 'the placed source Route is in the scene').toBeDefined();
    const source = router!.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL);
    expect(source, 'the Route catalog arm declares an ELECTRICAL Out').toBeDefined();

    const handler = before.nodes.find((n) =>
      n.cells.some(([x, y]) => x === TARGET_ROUTE_CELL[0] && y === TARGET_ROUTE_CELL[1]),
    );
    expect(handler, 'the placed destination Route is in the scene').toBeDefined();
    const target = handler!.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL);
    expect(target, 'the destination Route carries an electrical In port').toBeDefined();

    // THE GESTURE. Press the source nub, one move to the target nub, release.
    await drawWireBetweenPorts(page, source!, target!);

    // (1) A wire that did not exist before the drag exists after it.
    await pollScene(page, (s) => s.wires.length, {
      message: 'the release on an in-range electrical In nub folded exactly ONE new wire',
    }).toBe(before.wires.length + 1);

    // (2) Its endpoints are the two ports the pointer named. This is the WIRE-02 claim
    // that matters, and no unit test can make it: the indices travelled from a
    // `PortView.index` in the render packet, through `encodeGridCommand`, through the
    // host's `ports_of(id).get(port)`, and back out as a `WireView`.
    const after = await readScene(page);
    const drawn = after.wires.filter((w) => !before.wires.some((b) => b.id === w.id));
    expect(drawn, 'exactly one wire is new').toHaveLength(1);
    expect(
      { from: drawn[0].from, to: drawn[0].to },
      'the drawn wire runs from the pressed port to the released port, verbatim',
    ).toEqual({
      from: { node: router!.id, port: source!.index },
      to: { node: handler!.id, port: target!.index },
    });

    // (3) The renderer survived the gesture. On the way back IN, which is where the
    // 2026-08-11 machines-missing bug fired.
    await expectRenderLoopAlive(page, 'after the wire drag');
    errs.assertNone('after the wire drag');
  });
});

// ---------------------------------------------------------------------------
// THE UNDO / REDO ROUND TRIP FOR A HAND-DRAWN WIRE (WIRE-04, plan 66-10)
// ---------------------------------------------------------------------------
//
// WHY THIS IS CHEAP AND STILL WORTH HAVING, STATED PLAINLY. The byte-identical
// save/load/undo/redo/replay guarantee is ALREADY satisfied by the frozen
// `crates/fabrico-scenario/fixtures/07-wire-request-reply.postcard`, which was
// authored through `GridCommand::DrawWire` - the same command-layer path this
// gesture emits - and which asserts the reply returns to its caller and round-trips
// undo and redo. A NEW fixture is out of scope and would fail the phase's own exit
// gate, because `crates/fabrico-scenario` is FROZEN.
//
// What this test adds is the one thing that fixture cannot say: that the wire a
// HUMAN drew, through the gesture, through the real host, comes back with its
// endpoints intact.
//
// THE ENDPOINTS ARE THE ASSERTION, NOT THE COUNT. A count-only check ("there are
// three wires again") cannot tell a restored wire from a DIFFERENT one, which is
// exactly the regression a redo path can ship.
//
// AND NOT THE HANDLE, EITHER, AND THE REASON IS NOT THE ONE THIS PHASE HAS BEEN
// REPEATING. An undo/redo-folding tick does NOT take the normal diff path: the
// producer pushes a `full: true` keyframe instead (`sim_loop.rs`, the UNDO-06
// never-dark reset), and that branch's own comment says it "re-mints render ids".
// So the host explicitly reserves the right to hand back different dense handles for
// the same topology, and a spec that asserted on them would be asserting on a
// projection detail the command never named.
//
// MEASURED AT THIS COMMIT, THE IDS DID NOT ACTUALLY MOVE, and that is recorded here
// rather than smoothed over, because two summaries in this phase have now stated the
// re-mint as a fact. One round trip through this exact path reads:
//   drawn: wire 23, router 22, handler 19   restored: wire 23, router 22, handler 19
// Identical. Asserting on the ids would therefore have PASSED - on a coincidence the
// keyframe branch is free to break on any tick. The anchor form is used because it
// cannot become a coincidence: the footprint ANCHOR is handle-free identity
// (occupancy is exclusive, so no two live machines share a cell), so both nodes are
// RE-RESOLVED by anchor after the redo and only the `{node, port}` pair the command
// actually carried is compared.

/** The pieces of the shared setup a test needs after `setUpDrawableWire`. */
interface WireSetup {
  scene: SceneFacts;
  routerId: number;
  handlerId: number;
  source: PortFacts;
  target: PortFacts;
}

/**
 * The setup both tests in this file share: a reset demo board plus TWO hand-placed
 * Routes, the first giving a genuinely FREE electrical Out to drag from and the second
 * a genuinely FREE electrical In to release on (see the header note on why the demo's
 * own ports cannot be used, and on why the pair is Route-to-Route and not
 * Route-to-Handler).
 */
async function setUpDrawableWire(page: Page): Promise<WireSetup> {
  await armAndPlaceAt(page, 'Route', SOURCE_ROUTE_CELL[0], SOURCE_ROUTE_CELL[1]);
  await pollScene(
    page,
    (s) => s.nodes.some((n) => n.cells.some(([x, y]) => x === SOURCE_ROUTE_CELL[0] && y === SOURCE_ROUTE_CELL[1])),
    { message: 'the source Route placement folded on the real host' },
  ).toBe(true);
  await armAndPlaceAt(page, 'Route', TARGET_ROUTE_CELL[0], TARGET_ROUTE_CELL[1]);
  await pollScene(
    page,
    (s) => s.nodes.some((n) => n.cells.some(([x, y]) => x === TARGET_ROUTE_CELL[0] && y === TARGET_ROUTE_CELL[1])),
    { message: 'the destination Route placement folded on the real host' },
  ).toBe(true);

  const scene = await readScene(page);
  const router = nodeAtAnchor(scene, SOURCE_ROUTE_CELL[0], SOURCE_ROUTE_CELL[1]);
  expect(router, 'the placed source Route is anchored at its drop cell').toBeDefined();
  const source = router!.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL);
  expect(source, 'the Route catalog arm declares an ELECTRICAL Out').toBeDefined();

  const handler = nodeAtAnchor(scene, TARGET_ROUTE_CELL[0], TARGET_ROUTE_CELL[1]);
  expect(handler, 'the placed destination Route is anchored at its drop cell').toBeDefined();
  const target = handler!.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL);
  expect(target, 'the destination Route carries an electrical In port').toBeDefined();

  return { scene, routerId: router!.id, handlerId: handler!.id, source: source!, target: target! };
}

test.describe('WIRE-04 live: a hand-drawn wire survives undo and redo', () => {
  test('undo removes the wire the pointer drew and redo restores it with the SAME two endpoints', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);

    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    await expectRenderLoopAlive(page, 'before the wire drag');
    errs.assertNone('before the wire drag');

    const setup = await setUpDrawableWire(page);
    const wiresBefore = setup.scene.wires.length;

    await drawWireBetweenPorts(page, setup.source, setup.target);
    await pollScene(page, (s) => s.wires.length, {
      message: 'the release folded exactly ONE new wire',
    }).toBe(wiresBefore + 1);

    // THE PAIR THE POINTER NAMED, captured in HANDLE-FREE terms: the two footprint
    // anchors plus the two catalog port indices. Port indices are catalog-order and
    // identity-stable; the node ids around them are not.
    const drawnScene = await readScene(page);
    const drawn = drawnScene.wires.find((w) => w.from.node === setup.routerId);
    expect(drawn, 'the drawn wire leaves the placed source Route').toBeDefined();
    expect(
      { from: drawn!.from, to: drawn!.to },
      'the drawn wire runs from the pressed port to the released port, verbatim',
    ).toEqual({
      from: { node: setup.routerId, port: setup.source.index },
      to: { node: setup.handlerId, port: setup.target.index },
    });
    const drawnAnchors = {
      from: [anchorOf(nodeAtAnchor(drawnScene, SOURCE_ROUTE_CELL[0], SOURCE_ROUTE_CELL[1])!), setup.source.index],
      to: [anchorOf(nodeAtAnchor(drawnScene, TARGET_ROUTE_CELL[0], TARGET_ROUTE_CELL[1])!), setup.target.index],
    };

    // --- UNDO: the wire goes away and the count returns to the pre-gesture value. ---
    await page.getByTitle('Undo (Ctrl+Z)').click();
    await pollScene(page, (s) => s.wires.length, {
      message: 'the undo removed the hand-drawn wire (the count returns to its pre-gesture value)',
    }).toBe(wiresBefore);
    // The machine is still there: the undo took the DrawWire, not the Place before it.
    expect(
      nodeAtAnchor(await readScene(page), SOURCE_ROUTE_CELL[0], SOURCE_ROUTE_CELL[1]),
      'the undo removed the wire and not the source Route underneath it',
    ).toBeTruthy();
    await expectRenderLoopAlive(page, 'after the undo');
    errs.assertNone('after the undo');

    // --- REDO: the wire comes back, with the same two endpoints. ---
    await page.getByTitle('Redo (Ctrl+Shift+Z)').click();
    await pollScene(page, (s) => s.wires.length, {
      message: 'the redo restored the hand-drawn wire',
    }).toBe(wiresBefore + 1);

    const restoredScene = await readScene(page);
    // RE-RESOLVED BY ANCHOR, because the undo/redo fold re-mints every dense handle.
    const routerAfter = nodeAtAnchor(restoredScene, SOURCE_ROUTE_CELL[0], SOURCE_ROUTE_CELL[1]);
    const handlerAfter = nodeAtAnchor(restoredScene, TARGET_ROUTE_CELL[0], TARGET_ROUTE_CELL[1]);
    expect(routerAfter, 'the source Route is still anchored at its drop cell after the redo').toBeTruthy();
    expect(handlerAfter, 'the destination Route is still anchored at its drop cell after the redo').toBeTruthy();

    const restored = restoredScene.wires.find((w) => w.from.node === routerAfter!.id);
    expect(restored, 'exactly one restored wire leaves the source Route').toBeDefined();
    expect(
      {
        from: [anchorOf(routerAfter!), restored!.from.port],
        to: [anchorOf(handlerAfter!), restored!.to.port],
      },
      'the RESTORED wire carries the same two {node, port} pairs the pointer named, read through the handle-free anchor identity',
    ).toEqual(drawnAnchors);

    await expectRenderLoopAlive(page, 'after the redo');
    errs.assertNone('after the redo');
  });
});
