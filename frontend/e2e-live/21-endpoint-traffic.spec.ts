import { test, expect } from '@playwright/test';
import {
  anchorOf,
  armAndPlaceAt,
  demoCallerAndHandler,
  deselectViaEmptyCell,
  drawWireBetweenPorts,
  expectRenderLoopAlive,
  nodeAtAnchor,
  pollScene,
  readScene,
  resetToDemo,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  ENDPOINT_URL_SHAPE,
  readPanelUrl,
  webhookUrl,
  type PortFacts,
} from './support/oracle';

// 21-endpoint-traffic.spec.ts (WIRE-03 + ROADMAP SC2/SC3, plan 66-10) - REAL HTTP
// traffic through a wire a pointer drew, on an endpoint a pointer placed.
//
// WHY THIS FILE EXISTS AT ALL. The ROADMAP says a hand-drawn wire "carries real
// request/response traffic". The frozen
// `crates/fabrico-scenario/fixtures/07-wire-request-reply.postcard` proves exactly
// that for a wire authored from RUST through `GridCommand::DrawWire`, and the plan
// set was resting the rest on "the gesture emits the same command-layer path". That
// is an equivalence ARGUMENT, not a measurement, and it is the argument shape this
// phase rejects everywhere else. NO NEW FIXTURE and no edit to the existing one:
// `crates/fabrico-scenario` is FROZEN, so this is a live assertion against the
// running host, which touches no frozen crate at all.
//
// THE URL IS READ OUT OF THE PANEL, NOT RECONSTRUCTED FROM THE NODE ID. Reading it
// from the shipped `POST URL` row is what makes this a test of the thing a user can
// actually do; a URL rebuilt from the handle would prove only that this file can do
// arithmetic. The `webhook_url` bridge is read too, and the two are compared, so a
// panel that silently showed a stale or wrong URL fails here.
//
// THIS SPEC MUTATES THE SHARED HOST AND LEAVES IT MUTATED. It runs at `workers: 1`
// against ONE dev host and sorts last in the live directory on purpose. It resets to
// the demo at its start, exactly as every other mutating spec does.

/** The cell the Route is placed at by hand. Row 9 is clear of the demo. */
const HAND_ENDPOINT_CELL: readonly [number, number] = [12, 9];
/** The cell the HTTP Handler is placed at by hand: a 3x3 machine occupying
 *  (16..18, 9..11), east of the hand-placed Route and clear of the demo's rows 0..8.
 *
 *  ADDED BY PLAN 72-13. This spec used to drag to the DEMO's handler, and under D-04
 *  that drag can no longer land - see the block at the wire drag below for the
 *  mechanism, measured rather than reasoned. */
const HAND_HANDLER_CELL: readonly [number, number] = [16, 9];
// THE DEMO'S OWN PAIR IS FOUND BY KIND, NOT BY CELL (plan 85-07). The demo's caller Route,
// the SAME-RUN comparison subject for SC2, and its handler (an electrical In AND an
// electrical Out, which is what makes it a HANDLER in the render packet; read here, never
// wired to) come from `demoCallerAndHandler`, so this spec holds when the demo moves them.
// Until 85-07 they were the cell constants DEMO_ENDPOINT_CELL (10,6) and HANDLER_CELL (14,6).
/** An empty cell used only to close the config panel. */
const EMPTY_CELL: readonly [number, number] = [1, 12];

const KIND_ENDPOINT = 9;
const MEDIUM_ELECTRICAL = 1;
const ROLE_IN = 0;
const ROLE_OUT = 1;

/** The exact reply the demo's handler JS answers with: status 200, the header
 *  `x-fab: home` and the body `home` (D-04 keeps that body, and it is what tells the
 *  demo's handler from a palette Handler). Transcribed, not imported, exactly as the
 *  refusal suite transcribes its sentences. */
const REPLY_BODY = 'home';
/** The exact body a PALETTE-PLACED HTTP Handler answers with before any edit:
 *  `fabrico_core::tick::DEFAULT_HANDLER_SOURCE`'s `body: "hello from fabrico"`.
 *  Transcribed for the same reason as `REPLY_BODY` above (the live suite may not
 *  import product source - the zero-mock rule in `support/oracle.ts`). It is a
 *  DIFFERENT string from the demo handler's `home`, and that difference is what
 *  distinguishes the hand-built route's answer from the demo board's. */
const HANDLER_PRESET_BODY = 'hello from fabrico';
const REPLY_HEADER = 'x-fab';
const REPLY_HEADER_VALUE = 'home';

// `ENDPOINT_URL_SHAPE` and `readPanelUrl` MOVED TO `support/oracle.ts` at plan 72-13.
// `25-route-and-handler.spec.ts` needs both, and a second copy of a URL shape is a
// second thing to go stale - which is the whole reason that module exists. The shape
// there captures the route LABEL generically (a Route with a user-typed path answers at
// its own path, not at the default), so the default `route-<n>` half is asserted
// separately below where it is actually the claim.

/** One recorded HTTP exchange, in the exact shape the artifact quotes. */
interface Reading {
  label: string;
  url: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** POST a JSON body and record the answer verbatim. `timeoutMs` is the client-side
 *  bound: the `curl --max-time` equivalent, so a socket the host parks and never
 *  resolves becomes a RECORDED READING rather than a stuck run. */
async function post(
  page: import('@playwright/test').Page,
  label: string,
  url: string,
  data: string,
  timeoutMs: number,
): Promise<Reading> {
  const resp = await page.request.post(url, {
    data,
    headers: { 'content-type': 'application/json' },
    timeout: timeoutMs,
    failOnStatusCode: false,
  });
  const reading: Reading = {
    label,
    url,
    status: resp.status(),
    body: await resp.text(),
    headers: resp.headers(),
  };
  console.log(`SC3_READING ${JSON.stringify(reading)}`);
  return reading;
}

// SERIAL, and the second test deliberately does NOT reset: it continues on the board
// the first one left, because "the route comes back into service" is a claim about
// THAT board and no other.
test.describe.configure({ mode: 'serial' });

test.describe('WIRE-03 / SC2 / SC3 live: real traffic through a hand-drawn wire on a hand-placed endpoint', () => {
  test('a POST to a HAND-PLACED endpoint travels a HAND-DRAWN wire to the handler and the reply comes back to the caller', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    await expectRenderLoopAlive(page, 'before the placement');
    errs.assertNone('before the placement');

    // ---------------------------------------------------------------------
    // 1. PLACE AN HTTP ENDPOINT BY HAND, from the palette row 66-04 shipped.
    // ---------------------------------------------------------------------
    // RENAMED BY PLAN 72-13, LEDGER ROW LR-5. The palette row is `Place Route` since
    // D-09 (plan 72-10 renamed kind 9). `armAndPlaceAt` resolves the row by ACCESSIBLE
    // NAME (`oracle.ts:805`), so the old spelling resolved nothing and this click timed
    // out at 90s. Same machine, same kind byte, same catalog ports.
    const beforePlace = await readScene(page);
    await armAndPlaceAt(page, 'Route', HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1]);
    await pollScene(
      page,
      (s) => nodeAtAnchor(s, HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1]) !== undefined,
      { message: 'the hand-placed Route folded on the real host' },
    ).toBe(true);

    const placedScene = await readScene(page);
    const placed = nodeAtAnchor(placedScene, HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1])!;
    expect(placed.kind, 'the placed machine is a ROUTE (kind 9)').toBe(KIND_ENDPOINT);
    expect(
      placedScene.nodes.length,
      'exactly one machine was added by the placement gesture',
    ).toBe(beforePlace.nodes.length + 1);

    // AND THE HANDLER THAT ANSWERS IT, PLACED BY THE SAME GESTURE (72-13). Until this
    // plan the drag below landed on the DEMO's genesis handler; D-04 makes that
    // impossible and the block at the drag says why. A hand-placed HTTP Handler is the
    // machine a user actually has, and it lands from ONE `Place{HANDLER}` record.
    await armAndPlaceAt(page, 'HTTP Handler', HAND_HANDLER_CELL[0], HAND_HANDLER_CELL[1]);
    await pollScene(
      page,
      (s) => nodeAtAnchor(s, HAND_HANDLER_CELL[0], HAND_HANDLER_CELL[1]) !== undefined,
      { message: 'the hand-placed HTTP Handler folded on the real host' },
    ).toBe(true);
    // The board just grew and the camera is fit-to-content. Settle it before any
    // world-to-screen projection, or the press and the release of the drag below can be
    // computed against two different cameras.
    await waitForCameraSettle(page);

    // The ENDPOINT catalog arm is the only one in the repository with electrical
    // ports: In at index 0 facing W, Out at index 1 facing E, both on the one cell.
    const callerOut = placed.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL);
    expect(callerOut, 'the hand-placed Endpoint carries an ELECTRICAL Out to drag from').toBeDefined();

    // ---------------------------------------------------------------------
    // 2. READ THE URL OUT OF THE PANEL. Not rebuilt from the node id.
    // ---------------------------------------------------------------------
    await selectMachineAt(page, HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1]);
    const handUrl = await readPanelUrl(page);
    console.log(`SC2_PANEL_URL hand-placed=${handUrl}`);
    expect(handUrl, 'the hand-placed Route minted its own loopback POST route').toMatch(
      ENDPOINT_URL_SHAPE,
    );
    // The DEFAULT label half, kept as its own assertion now that the shared shape
    // captures a route label generically: an untouched Route keys as `/route-<n>`
    // (`GridState::add_endpoint` mints the smallest number no Route on the board holds,
    // phase 91 D-13), so this spec - which types no path - must see exactly that.
    expect(
      handUrl.match(ENDPOINT_URL_SHAPE)![2],
      'an untouched Route answers at its DEFAULT route-<n> label',
    ).toMatch(/^route-\d+$/);
    // The panel and the read-only bridge must agree. A panel showing a stale or
    // fabricated URL would otherwise pass every assertion below.
    expect(
      await webhookUrl(page, placed.id),
      'the panel URL is the SAME string the host-side webhook_url bridge answers',
    ).toBe(handUrl);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // The SAME-RUN comparison subject for ROADMAP SC2, whose claim is not "it works"
    // but "exactly as the pre-placed one does". Found BY KIND (the board's lowest-handle
    // Route, and the handler its cable delivers into), never by a cell.
    const { caller: demoEndpoint, handler, callerUrl: demoCallerUrl } = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'right after finding the demo pair by kind');
    expect(demoEndpoint.kind, 'the demo caller is an ENDPOINT').toBe(KIND_ENDPOINT);
    expect(demoEndpoint.id, 'and it is the demo board\'s own Route, not the one this spec placed').not.toBe(
      placed.id,
    );
    await selectMachineAt(page, ...anchorOf(demoEndpoint));
    const demoUrl = await readPanelUrl(page);
    console.log(`SC2_PANEL_URL pre-placed=${demoUrl}`);
    expect(demoUrl, 'the pre-placed Endpoint reads the SAME URL shape').toMatch(ENDPOINT_URL_SHAPE);
    expect(demoUrl, "and its panel shows the host's own URL for the demo caller").toBe(demoCallerUrl);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // Same listener, different route label. This is what "exactly as the pre-placed
    // one does" means in terms a test can check.
    const [, handPort, handEp] = handUrl.match(ENDPOINT_URL_SHAPE)!;
    const [, demoPort, demoEp] = demoUrl.match(ENDPOINT_URL_SHAPE)!;
    expect(handPort, 'both endpoints answer on the ONE bound loopback listener').toBe(demoPort);
    expect(handEp, 'and they are distinct routes on it').not.toBe(demoEp);

    // ---------------------------------------------------------------------
    // 3. THE FORWARD WIRE, DRAWN BY GESTURE. This is the load-bearing cable.
    // ---------------------------------------------------------------------
    // `manual_inject.rs` admits a logged `WireRequest` into the ENTRY WIRE, the live
    // `Node::Wire` whose `from.node == return_addr.node` (`wire_from_node`). With no
    // such wire the request is DROPPED. So this cable is not decoration: it is the
    // only path by which a POST to this endpoint can reach any handler at all.
    // ─────────────────── LEDGER ROW LR-1, CLOSED BY PLAN 72-13 ───────────────────
    //
    // WHAT USED TO BE HERE, AND WHY IT WAS RIGHT TO ARM IT. This block asserted
    // `handler.ports.filter(role===Out && medium===Electrical)` was `[]`, with the
    // comment "the handler carries NO electrical Out, so a RETURN wire is not drawable
    // by any gesture at this commit". It was an ARMED TRIPWIRE, not a claim anybody
    // wanted to stay true: its own comment said "the day a handler gains an electrical
    // Out, this assertion reddens, which is exactly when SC3's return-wire half becomes
    // reachable and this file should be extended rather than re-discovered".
    //
    // WHAT IT ACTUALLY BOUND, AND THIS IS A CORRECTION. `handler` is the DEMO SCENE's
    // handler (resolved by position until 85-07, by kind since) and NOT a Handler this
    // spec placed from the palette. So the tripwire did not fire because a placeable
    // Handler kind now exists: `port_catalog(HANDLER)` never touched this node. It fired
    // because **D-26 deliberately upgraded the DEMO BOARD**, giving the demo's handler a
    // second port so the first board a user ever sees can do the thing phase 72 is
    // named for. Both
    // `72-CONTEXT.md` and the milestone requirements recorded this as a palette-preset
    // consequence and both were wrong; the ledger's LR-1 row carries the measured
    // correction, and LR-1's ARMING plan is 72-06 (the demo-board plan) for that reason
    // rather than 72-05 (the catalog and preset plan).
    //
    // THE POSITIVE SUCCESSOR. The demo genesis handler now DOES carry an electrical Out,
    // and the genesis RETURN cable leaves it. Before D-26 that cable left the handler's
    // IN port, so the very first board every user opened was showing a cable LEAVING AN
    // INPUT - the thing D-05 refuses to introduce anywhere else. That is asserted, not
    // narrated:
    const genesisOuts = handler.ports.filter(
      (p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL,
    );
    expect(
      genesisOuts,
      'D-26: the demo genesis handler carries exactly ONE electrical Out, which is what makes a return cable drawable there at all',
    ).toHaveLength(1);
    const genesisReturn = placedScene.wires.find((w) => w.from.node === handler.id);
    expect(genesisReturn, 'the demo ships a RETURN cable leaving the genesis handler').toBeDefined();
    expect(
      genesisReturn!.from.port,
      'and D-26 moved its origin onto that electrical OUT: before the upgrade this cable left the handler INPUT',
    ).toBe(genesisOuts[0].index);

    // ───────────── THE DRAG, AND WHY IT NO LONGER TARGETS THE DEMO HANDLER ─────────────
    //
    // This drag used to run from the hand-placed Route's Out to the DEMO handler's In,
    // and under D-04 that gesture now LANDS NOTHING. The mechanism, read out of
    // `fabrico-command/src/command.rs` rather than guessed: `route_handler_pair` sees a
    // Route and a Handler and turns ONE `DrawWire` into TWO legs, forward and return,
    // both validated against the same pre-fold view under R-52's whole-or-nothing rule.
    // The return leg would leave the demo handler's single electrical Out - which is
    // ALREADY the source of the genesis return cable asserted just above - so it is
    // refused `PortOccupied`, and the `?` takes the FORWARD leg down with it. A spec
    // still drawing that cable would be asserting a refusal.
    //
    // So the target is the HTTP Handler THIS SPEC PLACED, which is the machine a user
    // actually has. ONE DRAG, TWO CABLES: that is D-04, and D-06 is why - there must be
    // no board state in which the forward cable exists without its return leg.
    const handHandler = nodeAtAnchor(await readScene(page), HAND_HANDLER_CELL[0], HAND_HANDLER_CELL[1])!;
    const handHandlerIn = handHandler.ports.find(
      (p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL,
    );
    expect(handHandlerIn, 'the hand-placed HTTP Handler carries an electrical In port').toBeDefined();

    const wiresBefore = (await readScene(page)).wires.length;
    await drawWireBetweenPorts(page, callerOut as PortFacts, handHandlerIn as PortFacts);
    await pollScene(page, (s) => s.wires.length, {
      message: 'D-04: ONE drag between a Route and a Handler folded BOTH cable legs on the real host',
    }).toBe(wiresBefore + 2);

    const wiredScene = await readScene(page);
    const forward = wiredScene.wires.find((w) => w.from.node === placed.id);
    expect(forward, 'exactly one wire leaves the hand-placed Route').toBeDefined();
    expect(
      { from: forward!.from, to: forward!.to },
      'the FORWARD leg runs from the Route electrical Out to the Handler electrical In, derived from the two machines declarations',
    ).toEqual({
      from: { node: placed.id, port: callerOut!.index },
      to: { node: handHandler.id, port: handHandlerIn!.index },
    });
    // The RETURN leg, which no second gesture produced. Under D-04 it does not exist as
    // a drag at all, so this is the only place it can be observed.
    const returnLeg = wiredScene.wires.find((w) => w.from.node === handHandler.id);
    expect(returnLeg, 'and the SAME drag minted a return leg leaving the Handler').toBeDefined();
    expect(
      returnLeg!.to.node,
      'which points back at the Route the request came from, not at anybody else',
    ).toBe(placed.id);
    console.log(
      `SC3_WIRE forward=${JSON.stringify({ from: forward!.from, to: forward!.to, tiles: forward!.tiles })} return=${JSON.stringify({ from: returnLeg!.from, to: returnLeg!.to })} handRouteNode=${placed.id} handHandlerNode=${handHandler.id}`,
    );

    await expectRenderLoopAlive(page, 'after the wire drag');
    errs.assertNone('after the wire drag');

    // ---------------------------------------------------------------------
    // 4. THE POST, AND THE REPLY COMING HOME TO ITS CALLER.
    // ---------------------------------------------------------------------
    const replyPulsesBefore = (await readScene(page)).replyPulsesObserved;
    const hand = await post(page, 'hand-placed endpoint, forward wire drawn by gesture', handUrl, '{"probe":"66-10","which":"hand"}', 20_000);

    expect(hand.status, 'the hand-placed Route answered its caller').toBe(200);
    // THE BODY IS THE CLAIM. A 200 with an empty body would prove only that the
    // socket was closed, and `/endpoint/{target}` has three distinct ways to answer
    // without the grid ever being consulted (a full channel, a closed receiver, a
    // dropped sender), all of which are status-shaped. The BODY is what the handler
    // computed and it can only have arrived by travelling the cable drawn above.
    // THE BODY IS THE HANDLER PRESET'S, WITH NO `Configure` SENT BY THIS TEST. The
    // machine was placed and wired and nothing else; `fold_place` seeds a HANDLER with
    // `DEFAULT_HANDLER_SOURCE`, which calls `ctx.command` and therefore ANSWERS. A
    // Factory reached by any other route carries `DEFAULT_FACTORY_SOURCE`, which emits
    // and never calls `ctx.command`, so its parked socket resolves only as a 504 on the
    // deadline sweep. The string below is what tells those two apart.
    expect(hand.body, 'the reply body is what the placed Handler preset JS computed').toBe(
      HANDLER_PRESET_BODY,
    );
    expect(hand.body, 'and it is NOT the demo genesis handler answering: that one says "home"').not.toBe(
      REPLY_BODY,
    );

    // THE REPLY-HOME COMET NOW FIRES FOR A HAND-PLACED CALLER, AND THAT IS AN INVERSION
    // OF WHAT THIS FILE MEASURED AT 66-10. It is written out rather than quietly
    // swapped, because the old paragraph was CORRECT about the old board and a reader
    // comparing the two needs the mechanism, not a changed number.
    //
    // WHAT 66-10 MEASURED: `replyPulsesObserved` did NOT move for a hand-placed caller.
    // The socket is resolved OFF the command stream (the executor consumer intercepts
    // `Effect::Reply { correlation, payload }` and writes the parked socket through the
    // shared registry, `sim_loop.rs`), so the HTTP answer came home regardless. The
    // COMET is a separate path: `route_replies` (`tick.rs`) admits the reply onto
    // `wire_from_node(handler)` and the renderer classifies a pulse REPLY only when
    // `msg.return_addr == link.to` (`render_packet.rs derive_wire_direction`). On the
    // old board the only cable leaving the handler was the GENESIS return cable, whose
    // `to` is the DEMO caller - so the reply rode a cable pointed at somebody else and
    // was classified FORWARD.
    //
    // WHAT CHANGED: D-04. The one drag above minted a return cable whose `to` IS this
    // caller, asserted verbatim at `returnLeg` above. Same two mechanisms, same code -
    // the board is what moved, and it moved because a user can now build the return leg
    // without knowing it exists.
    //
    // The wait is on the SIM CLOCK, not a sleep.
    await pollScene(page, (s) => s.replyPulsesObserved, {
      timeout: 30_000,
      message: 'D-04: the hand-placed caller DOES get a reply-home comet, because the same drag pointed a return cable at it',
    }).toBeGreaterThan(replyPulsesBefore);

    // SC2's actual claim: the same shape as the pre-placed one, in the SAME run
    // against the SAME binary.
    const demo = await post(page, 'pre-placed demo endpoint (SC2 comparison)', demoUrl, '{"probe":"66-10","which":"demo"}', 20_000);
    expect(demo.status, 'the pre-placed endpoint answers with the same status').toBe(hand.status);
    // SC2's claim is about the SHAPE of the answer, not its bytes: the two routes reach
    // two DIFFERENT handlers running two different scripts, so their bodies differ ON
    // PURPOSE and comparing them would assert the opposite of what this phase built.
    // What must match is that both are non-empty answers their own handler computed.
    expect(demo.body, 'the pre-placed route gets its OWN handler-computed body').toBe(REPLY_BODY);
    expect(
      demo.headers[REPLY_HEADER],
      'and the genesis handler-authored header rode home with it',
    ).toBe(REPLY_HEADER_VALUE);
    expect(
      demo.body === hand.body,
      'and the two answers are DIFFERENT strings, because two routes reached two different scripts in the same run',
    ).toBe(false);

    // THE ROUTE TABLE IS REAL, not a coincidence of the URL shape: an unknown
    // `route-` label on the same listener is a 404, so the two 200s above are answers
    // to routes the placements actually minted. No board in this spec places anywhere
    // near 999999 Routes, so that number is never minted.
    const bogus = await post(
      page,
      'a route- label no placement minted (route-table reality check)',
      `http://127.0.0.1:${handPort}/endpoint/route-999999`,
      '{}',
      15_000,
    );
    expect(bogus.status, 'an unminted endpoint label is a 404').toBe(404);

    await expectRenderLoopAlive(page, 'after the POSTs');
    errs.assertNone('after the POSTs');

    // ---------------------------------------------------------------------
    // 5. THE NEGATIVE READING. Undo the HAND-DRAWN FORWARD WIRE and POST again.
    // ---------------------------------------------------------------------
    // WITHOUT THIS THE WHOLE FILE IS UNFALSIFIABLE. The mechanism, stated against
    // the code rather than assumed: `manual_inject.rs` drops a `WireRequest` whose
    // entry node has no live outgoing wire, so nothing reaches the handler, no
    // `Effect::Reply` is ever emitted, and the caller's parked socket is resolved
    // only by the host-side deadline sweep at `deadline_tick = tick +
    // DEFAULT_ENDPOINT_DEADLINE_TICKS` (300 ticks, about 5s at the live cadence)
    // with the synthesized `504 {"error":"timeout"}`.
    //
    // The client-side bound below is the `curl --max-time` equivalent, so a socket
    // the host parked and never resolved would be a RECORDED READING rather than a
    // stuck run. WHAT FAILS THIS CHECK IS A 200 CARRYING THE HANDLER'S BODY.
    //
    // D-06 IS ASSERTED ON THE UNDO PATH, NOT ONLY ON THE DRAW PATH. The pair was minted
    // by ONE action, so the undo must leave a board with NEITHER leg rather than a
    // forward-only board, which is the state D-06 rules unreachable. The count below is
    // the whole-pair claim; the per-leg check under it is what names which leg survived
    // if it ever fails.
    await page.getByTitle('Undo (Ctrl+Z)').click();
    await pollScene(page, (s) => s.wires.length, {
      message: 'D-06: the undo removed BOTH legs of the hand-drawn pair, never just the forward one',
    }).toBe(wiresBefore);
    const undone = await readScene(page);
    expect(
      undone.wires.filter((w) => w.from.node === placed.id || w.from.node === handHandler.id),
      'and specifically NEITHER leg of the pair survives the undo',
    ).toEqual([]);
    expect(
      nodeAtAnchor(undone, HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1]),
      'the undo took the wires and not the Route underneath them, so the ROUTE still exists',
    ).toBeTruthy();

    const severed = await post(
      page,
      'hand-placed Route with its cable pair UNDONE (the negative reading)',
      handUrl,
      '{"probe":"66-10","which":"severed"}',
      30_000,
    );
    expect(
      { status: severed.status, body: severed.body },
      'with no hand-drawn wire the request never reaches the handler, so no reply comes home',
    ).not.toEqual({ status: 200, body: HANDLER_PRESET_BODY });
    expect(
      severed.body,
      'and specifically the handler-computed body is absent from the answer',
    ).not.toBe(HANDLER_PRESET_BODY);

    // THE CORRELATION DISCRIMINATOR, in the same run against the same binary: two
    // sockets parked on the same listener under two different correlations get two
    // DIFFERENT answers, decided entirely by which endpoint the caller addressed and
    // whether ITS wire is drawn. A single 200 proves a door is open; this pair
    // proves the answer belongs to the request that asked for it.
    const demoAgain = await post(
      page,
      'pre-placed demo endpoint, same run, wire intact (the correlation discriminator)',
      demoUrl,
      '{"probe":"66-10","which":"demo-again"}',
      20_000,
    );
    expect(demoAgain.status, 'the untouched endpoint still answers 200').toBe(200);
    expect(demoAgain.body, 'with the handler-computed body').toBe(REPLY_BODY);
    expect(
      severed.status === demoAgain.status && severed.body === demoAgain.body,
      'the severed caller and the intact caller got DIFFERENT answers from the same listener in the same run',
    ).toBe(false);

    await expectRenderLoopAlive(page, 'after the negative reading');
    errs.assertNone('after the negative reading');
  });

  test('a REDO puts the hand-drawn wire back and the route returns to service', async ({ page }) => {
    // Continues on the board the test above left: the hand-placed Route is still there,
    // its route is still live, and its cable PAIR is UNDONE. No reset.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);

    const before = await readScene(page);
    const placed = nodeAtAnchor(before, HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1]);
    expect(placed, 'the hand-placed Route survived the undo of its wires').toBeTruthy();
    const handHandler = nodeAtAnchor(before, HAND_HANDLER_CELL[0], HAND_HANDLER_CELL[1]);
    expect(handHandler, 'and so did the hand-placed HTTP Handler').toBeTruthy();
    expect(
      before.wires.some((w) => w.from.node === placed!.id || w.from.node === handHandler!.id),
      'and it starts this test with NEITHER leg of the pair, exactly as the previous test left it',
    ).toBe(false);

    await expectRenderLoopAlive(page, 'before the redo');
    errs.assertNone('before the redo');

    // D-06 ON THE REDO PATH: the pair is one action, so the redo restores BOTH legs.
    // Restoring one would put the forward-only board back, which is the state the
    // invariant exists to make unreachable, and it would look like a working redo.
    await page.getByTitle('Redo (Ctrl+Shift+Z)').click();
    await pollScene(page, (s) => s.wires.length, {
      message: 'D-06: the redo restored BOTH legs of the hand-drawn pair',
    }).toBe(before.wires.length + 2);

    const after = await readScene(page);
    const restoredPlaced = nodeAtAnchor(after, HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1])!;
    const restoredHandler = nodeAtAnchor(after, HAND_HANDLER_CELL[0], HAND_HANDLER_CELL[1])!;
    const restored = after.wires.find((w) => w.from.node === restoredPlaced.id);
    expect(restored, 'the restored FORWARD leg leaves the hand-placed Route again').toBeDefined();
    expect(restored!.to.node, 'and still lands on the hand-placed HTTP Handler').toBe(
      restoredHandler.id,
    );
    const restoredReturn = after.wires.find((w) => w.from.node === restoredHandler.id);
    expect(restoredReturn, 'and the RETURN leg came back with it').toBeDefined();
    expect(restoredReturn!.to.node, 'still pointed at the Route that called').toBe(
      restoredPlaced.id,
    );

    // Read the URL from the panel again rather than carrying it across tests: this
    // second test is also the check that the route SURVIVED the undo/redo pair.
    await selectMachineAt(page, HAND_ENDPOINT_CELL[0], HAND_ENDPOINT_CELL[1]);
    const handUrl = await readPanelUrl(page);
    console.log(`SC2_PANEL_URL after-redo=${handUrl}`);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    const back = await post(
      page,
      'hand-placed Route after UNDO then REDO of its cable pair (back in service)',
      handUrl,
      '{"probe":"66-10","which":"redone"}',
      20_000,
    );
    expect(back.status, 'the redone wires carry traffic again').toBe(200);
    expect(back.body, 'and the handler-computed reply comes home again').toBe(
      HANDLER_PRESET_BODY,
    );

    await expectRenderLoopAlive(page, 'after the redo POST');
    errs.assertNone('after the redo POST');
  });
});
