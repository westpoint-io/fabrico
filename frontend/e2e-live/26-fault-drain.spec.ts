import { test, expect } from '@playwright/test';
import {
  applyConfig,
  armAndPlaceAt,
  deselectViaEmptyCell,
  drawBeltThroughCells,
  expectRenderLoopAlive,
  fillPanelField,
  newBoard,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  pressSegment,
  readScene,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';

// 26-fault-drain.spec.ts (PILE-10, plan 71-08) - a belt dragged onto a Sink's FAULT
// nub carries the failures away, driven on the REAL `dev_render_server`, zero mocks.
//
// ---------------------------------------------------------------------------
// WHY THIS BOARD IS BUILT FROM `newBoard` AND NEVER FROM THE DEMO-SCENE RESET
//
// (The oracle's demo-reset helper is named nowhere in this file on purpose: plan
// 71-08's verify block greps this file for that identifier and requires zero hits,
// so the exclusion is machine-checked rather than merely written down.)
// ---------------------------------------------------------------------------
//
// The demo scene seeds its Sinks itself. A spec that reached for "the sink" on that
// board would be reading a machine this phase did not place, and its claim that the
// SINK CATALOG now carries a `role === 2` port would be reading whatever the genesis
// scene happened to seed rather than what `port_catalog(SINK)` answers today. So the
// board here is empty, the Sink is placed through the shipped palette gesture, and
// the fault nub is read off the landed node. That assertion is RED before plan 71-04,
// where `port_catalog(SINK)` returned exactly one In port and nothing else.
//
// ---------------------------------------------------------------------------
// WHICH FAILURE PATH THIS DRIVES, AND WHY
// ---------------------------------------------------------------------------
//
// A `CommandResult::Failure` is not something the grid can produce on its own: a Sink
// emits a Command of INTENT, the host dispatches it off the sim thread, and the
// outcome comes back over the results channel. Of the paths the shipped panel offers,
// the HTTP target pointed at a dead loopback port is the one that fails for a real,
// observable reason (connection refused) with no host configuration involved and no
// traffic leaving the machine. It needs a Configure to point the Sink somewhere; that
// is acceptable here and is stated rather than hidden, because the no-Configure clause
// belongs to phase 72's palette requirements and not to PILE-10.
//
// ---------------------------------------------------------------------------
// THE FINAL ASSERTION IS ABOUT THE BELT, AND THAT IS THE WHOLE OF PILE-10
// ---------------------------------------------------------------------------
//
// A fault that left the Sink's inbox and was DROPPED for want of a dock would satisfy
// "the inbox emptied" exactly as well as a fault that was drained onto a belt. Telling
// a drain apart from a drop is the entire point of the requirement, so the assertion
// is that the docked belt CARRIES an item and that the item TRAVELS to the belt's head
// end. Measured non-vacuity, in `71-08-SUMMARY.md`: with the fold's fault-drain arm
// removed the dock assertion stays green and the carries-an-item one goes red.
//
// THE SECOND HALF USED TO BE A CHECK THAT COULD NOT FAIL (71-review WR-06). It read
// `occupiedSlots.length > 0` after the poll had already established `items > 0`, and
// both fields come from ONE array in ONE derivation - so the first implies the second
// unconditionally, on every build there is. It is now `headOccupied`, a different
// question about the same array, which a tail-resident item does not satisfy.
//
// RENDER HEALTH IS GUARDED AT BOTH ENDS. The live oracle reads only
// `window.__fabrico.scene()`, which is fed by the packet path and is completely
// independent of the Pixi ticker, so a frozen board passes every model assertion in
// this file. `watchPageErrors` is installed BEFORE `page.goto` (its own docblock
// requires it) and `expectRenderLoopAlive` is called after the placements and again at
// the assertion point.
//
// THIS SPEC MUTATES THE SHARED HOST AND LEAVES IT MUTATED, exactly as every other
// mutating spec in this directory does. It wipes the board at its own start.

/**
 * Port role bytes, MIRRORED from `frontend/src/protocol/ports.ts`'s `PORT_ROLE`
 * rather than imported: the live project is structurally zero-product-import by
 * design (oracle.ts's header rule), which is the whole of what makes it an
 * independent oracle. `22-stranded-reconnect.spec.ts` transcribes the same three
 * bytes for the same reason.
 */
const PORT_ROLE = { IN: 0, OUT: 1, FAULT: 2 } as const;

/**
 * The wire sentinel a FAULT dock is recorded under: `fabrico_core::FAULT_PORT`
 * (`u16::MAX`). The host translates the catalog port index into this sentinel at
 * freeze time, so a Tail docked on a fault nub reads back as this number and never as
 * the nub's catalog index. Mirrored from `ports.ts`'s `FAULT_PORT` for the reason
 * above.
 */
const FAULT_PORT = 65535;

/** SINK is `machine_kind` byte 7 (mirrored from `protocol/kinds.ts`). */
const KIND_SINK = 7;

/** The Source's cell. 1x1, one Out port facing E. */
const SOURCE_CELL: readonly [number, number] = [6, 6];

/**
 * The Sink's cell. 1x1 with TWO ports since plan 71-04: In at catalog index 0 facing
 * W, and the Fault nub at catalog index 1 facing S. Disjoint sides, so the feed belt's
 * Head and the fault belt's Tail occupy disjoint cells.
 */
const SINK_CELL: readonly [number, number] = [12, 6];

/** The feed belt's authored run: the Source Out's facing cell through to the Sink
 *  In's facing cell, west to east along row 6. */
const FEED_CELLS = [
  [7, 6],
  [8, 6],
  [9, 6],
  [10, 6],
  [11, 6],
] as const;

/** The fault belt's run SOUTH out of the fault nub. The press seeds the path at the
 *  nub's facing cell (12,7), so only the two continuation cells are stepped. */
const FAULT_CELLS = [
  [12, 8],
  [12, 9],
] as const;

/** An empty cell used only to close the config panel. */
const EMPTY_CELL: readonly [number, number] = [2, 12];

/**
 * A loopback port nothing binds, so the outbound request is refused at connect. Port 1
 * is privileged and unbound on every platform this suite runs on; the request never
 * leaves the machine.
 */
const DEAD_URL = 'http://127.0.0.1:1/fabrico-fault-drain';

/** The Source's Timer interval, in sim ticks, for this walk. */
const TIMER_TICKS = '4';

test.describe('PILE-10 on the real host: a belt on a Sink fault nub carries the failures away', () => {
  test('a hand-placed Sink exposes a FAULT nub, a hand-drawn belt docks it, and failed dispatches leave on that belt', async ({
    page,
  }) => {
    // Installed BEFORE goto so a boot-time throw is caught too.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await newBoard(page);
    // ADDED AT 72-13, AND IT CLOSES A FRAGILITY THIS SPEC ALWAYS HAD. Every placement
    // below addresses a WORLD CELL, and `armAndPlaceAt` projects that cell through the
    // LIVE camera - so this walk is camera-dependent and never said so. `newBoard` does
    // not reset the zoom: with no content there is nothing to fit, so whatever the spec
    // BEFORE this one left on screen survives the wipe. When `25-route-and-handler.spec.ts`
    // was inserted ahead of this file it left the fit-to-content camera at its 400%
    // clamp (one small machine on an empty board), the drop cell landed outside the
    // canvas, and this spec polled 15s for a Source that was never placed - 0 machines,
    // zoom 400%, measured off the failure snapshot. Nothing about this file's SUBJECT
    // changed; it was passing on what happened to run before it.
    await resetZoomToActualSize(page);

    // -----------------------------------------------------------------------
    // 1. PLACE BOTH MACHINES through the shipped arm-then-click palette gesture.
    // -----------------------------------------------------------------------
    await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, SOURCE_CELL[0], SOURCE_CELL[1]) !== undefined, {
      message: 'the hand-placed Source folded on the real host',
    }).toBe(true);
    await armAndPlaceAt(page, 'Sink', SINK_CELL[0], SINK_CELL[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, SINK_CELL[0], SINK_CELL[1]) !== undefined, {
      message: 'the hand-placed Sink folded on the real host',
    }).toBe(true);

    const placed = await readScene(page);
    const source = nodeAtAnchor(placed, SOURCE_CELL[0], SOURCE_CELL[1]) as SceneFacts['nodes'][number];
    const sink = nodeAtAnchor(placed, SINK_CELL[0], SINK_CELL[1]) as SceneFacts['nodes'][number];
    expect(sink.kind, 'the placed machine is a SINK').toBe(KIND_SINK);

    await expectRenderLoopAlive(page, 'after the placements');
    errs.assertNone('after the placements');

    // -----------------------------------------------------------------------
    // 2. THE NUB THAT DID NOT EXIST BEFORE PLAN 71-04.
    // -----------------------------------------------------------------------
    const faultPort = sink.ports.find((p) => p.role === PORT_ROLE.FAULT);
    expect(
      faultPort,
      'the landed Sink carries a spatial FAULT port. Before plan 71-04 port_catalog(SINK) ' +
        'answered exactly ONE In port, so this reads RED on any build before it. Ports: ' +
        JSON.stringify(sink.ports),
    ).toBeDefined();
    const sinkIn = sink.ports.find((p) => p.role === PORT_ROLE.IN);
    expect(sinkIn, 'and it still carries the In port a feed belt lands on').toBeDefined();
    const sourceOut = source.ports.find((p) => p.role === PORT_ROLE.OUT);
    expect(sourceOut, 'the Source carries the Out port the feed belt leaves from').toBeDefined();

    // -----------------------------------------------------------------------
    // 3. THE FEED BELT, drawn nub to nub by pointer.
    // -----------------------------------------------------------------------
    await drawBeltThroughCells(page, sourceOut as PortFacts, FEED_CELLS, sinkIn as PortFacts);
    await pollScene(page, (s) => s.belts.length, {
      message: 'the hand-drawn feed belt folded on the real host',
    }).toBe(1);

    // -----------------------------------------------------------------------
    // 4. THE FAULT BELT, dragged onto the fault nub by pointer.
    //
    //    `drawBeltThroughCells` cannot serve here: it asserts the pressed port is an
    //    Out and the released port is an In, and this belt's Tail lands on a FAULT
    //    port while its Head is left dangling on open floor. The gesture is still the
    //    shipped one - `gestures.ts`'s belt press arm records a Tail dock for a press
    //    on an Out(1) OR a Fault(2) nub and seeds the path at the port's facing cell,
    //    so the dock comes from the drag itself and nothing is docked by hand.
    //
    //    The press point comes from the SCENE's host-resolved world port geometry
    //    (`nubAnchor(port.cell_x, port.cell_y, port.side)`), never from a footprint
    //    guess, which is why this survives a rotation or a footprint change.
    // -----------------------------------------------------------------------
    const fault = faultPort as PortFacts;
    await page.getByTitle(/^Draw belts/).click();
    const press = await screenPoint(page, nubAnchor(fault.cell_x, fault.cell_y, fault.side));
    await page.mouse.move(press.x, press.y);
    await page.mouse.down();
    for (const [cx, cy] of FAULT_CELLS) {
      const pt = await screenCellCentre(page, cx, cy);
      await page.mouse.move(pt.x, pt.y);
    }
    await page.mouse.up();
    // Disarm so the next click SELECTS a machine instead of starting another draw.
    await page.keyboard.press('Escape');
    await pollScene(page, (s) => s.belts.length, {
      message: 'the hand-drawn fault belt folded on the real host',
    }).toBe(2);

    // THE DOCK, POLLED ON THE MODEL, on that node and that port.
    await pollScene(
      page,
      (s) =>
        s.belts.some((b) =>
          b.docks.some((d) => d.end === 'Tail' && d.node === sink.id && d.port === FAULT_PORT),
        ),
      {
        message:
          'the real host recorded the Tail dock on the SINK fault port (the catalog index is ' +
          'translated to the FAULT_PORT sentinel at freeze time, so this is the value the wire ' +
          'carries for a fault dock)',
      },
    ).toBe(true);

    const docked = await readScene(page);
    const faultBelt = docked.belts.find((b) =>
      b.docks.some((d) => d.end === 'Tail' && d.node === sink.id && d.port === FAULT_PORT),
    ) as SceneFacts['belts'][number];
    const feedBelt = docked.belts.find((b) => b.id !== faultBelt.id) as SceneFacts['belts'][number];
    expect(
      faultBelt.items,
      'the fault belt starts EMPTY, so anything it carries below arrived during this run',
    ).toBe(0);
    expect(
      feedBelt.docks.some((d) => d.end === 'Head' && d.node === sink.id),
      'and the feed belt is the OTHER one: its Head lands on the Sink In, a different port on a ' +
        'different side, so the two belts cannot be confused',
    ).toBe(true);

    await expectRenderLoopAlive(page, 'after the belt drags');
    errs.assertNone('after the belt drags');

    // -----------------------------------------------------------------------
    // 5. POINT THE SINK AT A DEAD ENDPOINT, then open the tap.
    // -----------------------------------------------------------------------
    await selectMachineAt(page, SINK_CELL[0], SINK_CELL[1]);
    await pressSegment(page, 'Target', 'HTTP');
    await fillPanelField(page, 'fab-sink-http-url', DEAD_URL);
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    await selectMachineAt(page, SOURCE_CELL[0], SOURCE_CELL[1]);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', TIMER_TICKS);
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // -----------------------------------------------------------------------
    // 6. THE CLAIM: the failures LEAVE, on the belt the user drew.
    // -----------------------------------------------------------------------
    await pollScene(page, (s) => s.belts.find((b) => b.id === faultBelt.id)?.items ?? 0, {
      timeout: 45_000,
      message:
        'PILE-10: the Sink drained a fault onto the belt docked at its fault nub. The Sink is ' +
        'pointed at a dead endpoint, so every command it emits comes back a Failure and rests as ' +
        'a fault in its inbox; the fold moves one onto the belt because - and only because - that ' +
        'fault port is LINKED. A fault that left the inbox and was dropped would leave this at 0.',
    }).toBeGreaterThan(0);

    const drained = await readScene(page);
    const carrying = drained.belts.find((b) => b.id === faultBelt.id) as SceneFacts['belts'][number];
    console.log(
      `PILE10_FAULT_BELT ${JSON.stringify({ id: carrying.id, items: carrying.items, occupiedSlots: carrying.occupiedSlots, docks: carrying.docks })}`,
    );
    // WR-06: THE ITEM TRAVELS, WHICH THE COUNT ABOVE CANNOT IMPLY.
    //
    // The assertion that stood here read `carrying.occupiedSlots.length > 0` after the
    // poll had already established `items > 0`. Both fields come from ONE array in ONE
    // derivation (`sceneState.ts`: `items` is `b.items.length`, `occupiedSlots` is a
    // sort-and-dedupe of that same array), so `items > 0` implies
    // `occupiedSlots.length >= 1` unconditionally and the assertion was structurally
    // incapable of going red - on ANY build, including one where the host had stopped
    // filling slot indices entirely. Its message advertised a discrimination ("a count
    // with no slot behind it cannot satisfy this") the data model makes impossible.
    //
    // `headOccupied` is a different question about the same array: is slot 0, the head
    // end, one of the occupied ones? A fault that was drained onto the belt at the TAIL
    // and never moved has `items > 0` and `headOccupied === false`, so this separates a
    // belt that TRANSPORTS the dead letter from one that merely received it. The fault
    // belt's Head is dangling by construction (its run ends at (12,9) with nothing
    // beyond), so the arrival is monotone: items bunch at slot 0 and stay, which is what
    // makes this a settled state to poll for rather than a phase to catch.
    await pollScene(page, (s) => s.belts.find((b) => b.id === faultBelt.id)?.headOccupied, {
      timeout: 45_000,
      message:
        'PILE-10: the drained fault TRAVELS the belt the user drew and reaches its head end. ' +
        'The items count above says only that something landed on the belt; this says it moved ' +
        'along it, which a count computed from the same array cannot imply.',
    }).toBe(true);
    expect(
      carrying.docks.some((d) => d.end === 'Tail' && d.node === sink.id && d.port === FAULT_PORT),
      'the belt still carries its Tail dock on the Sink fault port while it does so',
    ).toBe(true);

    await expectRenderLoopAlive(page, 'with the fault draining');
    errs.assertNone('during the fault drain');
  });
});
