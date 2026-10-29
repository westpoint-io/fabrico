import { test, expect, type Page } from '@playwright/test';
import {
  applyConfig,
  armAndPlaceAt,
  deselectViaEmptyCell,
  drawWireBetweenPorts,
  expectRenderLoopAlive,
  fillPanelField,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readFactorySource,
  readScene,
  readPanelUrl,
  resetZoomToActualSize,
  selectMachineAt,
  typeFactorySource,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  ENDPOINT_URL_SHAPE,
  type PortFacts,
} from './support/oracle';

// 25-route-and-handler.spec.ts (SERVE-03, SERVE-04, SERVE-05, SERVE-07, SERVE-08,
// plan 72-13) - the LIVE proof, on the real host, that a user places two machines on an
// EMPTY board, draws ONE cable, and gets back a response their own JavaScript produced.
//
// ─────────────────────────── EVERY TEST STARTS FROM `newBoard` ───────────────────────────
//
// (The oracle's demo-reset helper is named nowhere in this file on purpose: plan 72-13's
// verify block greps this file for that identifier and requires ZERO hits, so the
// exclusion is machine-checked rather than merely written down. The same discipline, and
// the same wording, as `26-fault-drain.spec.ts` - a source grep that a comment can trip
// is a guard the next reader stops believing.)
//
// AND THAT IS A MEASURED REQUIREMENT, NOT A STYLE. The demo board's own HTTP Handler
// already carries an electrical In and reply-shaped JS (its reply body is `home`), so a
// spec that reaches for "the handler" on a demo board is GREEN ON HEAD with zero v9.0 work
// and proves nothing whatever about this phase. The requirements record that as the substitution plan 69-04
// already made once. The question that finds a check which cannot fail is: what does
// every test board share that the shipped app does not? For this phase the answer is THE
// DEMO BOARD. So: `newBoard` first, every time, never the demo-scene reset, and every
// assertion about a Handler is about THE HANDLER THIS SPEC PLACED.
//
// ────────────────────── AND EVERY TEST ASSERTS THE RENDER LOOP IS ALIVE ──────────────────────
//
// The live oracle reads only the MODEL: `window.__fabrico.scene()` reads the
// packet-application buffer and is completely independent of the Pixi ticker, so a build
// whose renderer is DEAD leaves every assertion in this file green over a blank canvas.
// That is this repository's recorded blind spot rather than a hypothesis. This phase
// CHANGED the renderer (72-09's nub silhouettes, LOD rows and mirrored chevron, and
// 72-13's suppressed Out prong), so a throw inside the Pixi ticker is a live risk here
// and not a theoretical one. `watchPageErrors` plus `expectRenderLoopAlive` run at EACH
// PHASE of the walk rather than once at the end, because a renderer killed at step 2 and
// checked only at step 8 is a renderer that took every intermediate assertion with it.
//
// ───────────────────────────── WHAT THIS SPEC CANNOT SEE ─────────────────────────────
//
// Nothing about the drawn cable. The oracle emits `tiles: w.path.length` for a wire and
// nothing at all about its vertices, lanes or terminals (`sceneState.ts`). The cable's
// GEOMETRY is `wires.test.ts`'s and the pixel guard's claim; this file's claims are the
// COMMAND path, the HTTP path, the model, and render health.
//
// THIS SPEC MUTATES THE SHARED HOST AND LEAVES IT MUTATED, exactly as every other
// mutating live spec does. It runs at `workers: 1` against ONE dev host.

// ---------------------------------------------------------------------------
// The board, and the keyspaces the oracle reports
// ---------------------------------------------------------------------------

/** The 1x1 Route: the front door a webhook arrives at. */
const ROUTE_CELL: readonly [number, number] = [8, 8];
/** The 3x3 HTTP Handler, spanning (12..14, 7..9), east of the Route so its W-facing
 *  electrical In at local (0,1) sits directly opposite the Route's E-facing Out. */
const HANDLER_CELL: readonly [number, number] = [12, 7];
/** A second Route, used only by the SERVE-08 fault leg, well clear of the first. */
const LONE_ROUTE_CELL: readonly [number, number] = [8, 14];
/** The Handler the SERVE-08 leg draws its missing cable to. */
const CLEAR_HANDLER_CELL: readonly [number, number] = [12, 13];
/** An empty cell used only to close the config panel. */
const EMPTY_CELL: readonly [number, number] = [2, 2];

const KIND_ROUTE = 9;
const KIND_HANDLER = 10;
const ROLE_IN = 0;
const ROLE_OUT = 1;
const MEDIUM_MECHANICAL = 0;
const MEDIUM_ELECTRICAL = 1;
/** `NodeView.state`: 0 = IDLE, 1 = WORKING, 2 = FAULTED, 3 = BACKED_UP. */
const STATE_IDLE = 0;
const STATE_FAULTED = 2;

/** The Route's Path field id (`RouteConfigBody.tsx PATH_FIELD_ID`). Transcribed, not
 *  imported: the live suite may not import product source (the zero-mock rule in
 *  `support/oracle.ts`). */
const PATH_FIELD_ID = 'fab-route-path';

/** The exact body a palette-placed HTTP Handler answers with BEFORE any edit:
 *  `fabrico_core::tick::DEFAULT_HANDLER_SOURCE`'s `body: "hello from fabrico"`.
 *  Transcribed for the same reason as the field id above. */
const HANDLER_PRESET_BODY = 'hello from fabrico';

/** The distinctive body the SERVE-05 leg makes the Handler return instead. It is
 *  deliberately NOT a substring of, and not equal to, `HANDLER_PRESET_BODY`. */
const EDITED_BODY = 'mark was here 72-13';

/** The path the SERVE-05 leg types into the Route's Path field. */
const TYPED_PATH = '/orders';

/** One recorded HTTP exchange, in the shape the summary quotes. */
interface Reading {
  label: string;
  url: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** POST a JSON body and record the answer verbatim. `timeoutMs` is the client-side
 *  bound - the `curl --max-time` equivalent - so a socket the host parks and never
 *  resolves becomes a RECORDED READING rather than a stuck run. */
async function post(
  page: Page,
  label: string,
  url: string,
  data: string,
  timeoutMs = 20_000,
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
  console.log(`SERVE_READING ${JSON.stringify(reading)}`);
  return reading;
}

/** Reset the camera to 100% before a world-to-screen projection, then settle it. The
 *  board here GROWS between placements and the camera is fit-to-content, so a press and
 *  a release computed against two different cameras land in two different places.
 *
 *  The body is `resetZoomToActualSize` in the oracle; this alias keeps the local name
 *  the walk reads with. See that function for the measurement behind it. */
const steadyCamera = resetZoomToActualSize;

/** Place a machine and settle on the HOST having folded it at that anchor with the kind
 *  the palette row claims - never on a bare node count. */
async function placeAndSettle(
  page: Page,
  row: string,
  cell: readonly [number, number],
  kind: number,
): Promise<void> {
  await steadyCamera(page);
  await armAndPlaceAt(page, row, cell[0], cell[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, cell[0], cell[1])?.kind, {
    message: `the hand-placed ${row} folded on the real host at (${cell[0]},${cell[1]})`,
  }).toBe(kind);
  await waitForCameraSettle(page);
}

// SERIAL: one shared mutable host at `workers: 1`, and each test wipes to an empty board
// of its own rather than inheriting the last one's.
test.describe.configure({ mode: 'serial' });

test.describe('SERVE live: a webhook reaches your own code, on a board built from empty', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // SERVE-03: the Handler is a palette machine with the ports its row claims
  // ═══════════════════════════════════════════════════════════════════════════
  test('SERVE-03 - one palette click lands an HTTP Handler whose port list is EXACTLY what the row promises', async ({
    page,
  }) => {
    // FIRST statement, before any navigation: a `pageerror` listener registered after
    // the throw records nothing, so a boot-time throw would go unseen.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await newBoard(page);

    await expectRenderLoopAlive(page, 'on the empty board, before the placement');
    errs.assertNone('on the empty board, before the placement');

    await placeAndSettle(page, 'HTTP Handler', HANDLER_CELL, KIND_HANDLER);

    const placed = nodeAtAnchor(await readScene(page), HANDLER_CELL[0], HANDLER_CELL[1])!;
    expect(placed.kind, 'the landed machine is a HANDLER (kind 10)').toBe(KIND_HANDLER);
    expect(placed.cells.length, 'and it claims its real 3x3 = 9-cell footprint').toBe(9);

    // THE PORT LIST IS ASSERTED EXACTLY, WITH ITS LENGTH, AND THAT IS SERVE-03's OWN
    // ACCEPTANCE RATHER THAN THOROUGHNESS. A `find(role===In && medium===Electrical)`
    // would pass on a machine carrying an extra port the palette row does not claim, and
    // "the palette copy and the machine agree" is the thing this requirement is about.
    //
    // INDEX 0 IS LOAD-BEARING. `step_factory` drains inbox port 0 ONLY, and since D-16
    // the DECLARED MEDIUM of that port is the whole discriminator between a mechanical
    // Factory and an electrical Handler (`admit::inbox_class`). An electrical In
    // appended after the mechanical ports would strand every request on a board that
    // looks correct, so the ORDER is asserted, not just the membership.
    expect(
      placed.ports.map((p) => ({ index: p.index, role: p.role, medium: p.medium })),
      'SERVE-03: the Handler declares exactly three ports - an ELECTRICAL In at index 0, an ELECTRICAL Out at index 1, and a MECHANICAL Fault at index 2',
    ).toEqual([
      { index: 0, role: ROLE_IN, medium: MEDIUM_ELECTRICAL },
      { index: 1, role: ROLE_OUT, medium: MEDIUM_ELECTRICAL },
      { index: 2, role: 2, medium: MEDIUM_MECHANICAL },
    ]);
    expect(placed.ports, 'and there is no fourth port').toHaveLength(3);
    // D-02, stated as its own claim because the ARITY is what makes the
    // one-request-one-reply shape the only board a user can build: with a SINGLE
    // electrical Out, a second Route's return cable is refused `PortOccupied` and the
    // whole pairing goes with it. Three Outs would permit a board D-01 rules out.
    expect(
      placed.ports.filter((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL),
      'D-02: exactly ONE electrical Out',
    ).toHaveLength(1);

    // AND THE SEED, WHICH IS WHAT MAKES THE PORTS MEAN ANYTHING. Correct electrical
    // ports plus `DEFAULT_FACTORY_SOURCE` is a machine that is CALLED a Handler and
    // cannot reply, which is the overstating-label defect SERVE-03 exists to close.
    await selectMachineAt(page, HANDLER_CELL[0], HANDLER_CELL[1]);
    const seeded = await readFactorySource(page);
    console.log(`SERVE03_SEEDED_JS ${JSON.stringify(seeded)}`);
    expect(
      seeded,
      'fold_place seeds a HANDLER with reply-shaped JS: it calls ctx.command, which is what answers a webhook',
    ).toContain('ctx.command(');
    expect(seeded, 'and the preset body is the one the walk edits').toContain(
      HANDLER_PRESET_BODY,
    );
    expect(
      seeded,
      'and it is NOT the emit-only DEFAULT_FACTORY_SOURCE, which would resolve the parked socket only as a 504 on the deadline sweep',
    ).not.toContain('ctx.emit(');
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    await expectRenderLoopAlive(page, 'after the Handler placement');
    errs.assertNone('after the Handler placement');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SERVE-04 / SERVE-07 / SERVE-05 / D-06: the whole walk on ONE empty board
  // ═══════════════════════════════════════════════════════════════════════════
  test('SERVE-04 / SERVE-07 / SERVE-05 - place two, draw ONE cable, POST, then edit the answer and the path', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await newBoard(page);

    await expectRenderLoopAlive(page, 'on the empty board, before anything is placed');
    errs.assertNone('on the empty board, before anything is placed');

    // -----------------------------------------------------------------------
    // 1. TWO MACHINES, TWO PALETTE CLICKS.
    // -----------------------------------------------------------------------
    await placeAndSettle(page, 'Route', ROUTE_CELL, KIND_ROUTE);
    await placeAndSettle(page, 'HTTP Handler', HANDLER_CELL, KIND_HANDLER);

    const placedScene = await readScene(page);
    expect(
      placedScene.nodes.length,
      'exactly two machines are on the board: nothing was minted in secret by a placement',
    ).toBe(2);
    const route = nodeAtAnchor(placedScene, ROUTE_CELL[0], ROUTE_CELL[1])!;
    const handler = nodeAtAnchor(placedScene, HANDLER_CELL[0], HANDLER_CELL[1])!;

    const routeOut = route.ports.find(
      (p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL,
    );
    const handlerIn = handler.ports.find(
      (p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL,
    );
    expect(routeOut, 'the Route declares an electrical Out to drag from').toBeDefined();
    expect(handlerIn, 'the Handler declares an electrical In to release on').toBeDefined();

    await expectRenderLoopAlive(page, 'after both placements');
    errs.assertNone('after both placements');

    // -----------------------------------------------------------------------
    // 2. THE URL, READ OFF THE PANEL AND CHECKED AGAINST THE HOST BRIDGE.
    // -----------------------------------------------------------------------
    await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
    const url = await readPanelUrl(page);
    console.log(`SERVE04_PANEL_URL default=${url}`);
    expect(url, 'the placed Route minted its own loopback POST route').toMatch(
      ENDPOINT_URL_SHAPE,
    );
    // The panel and the read-only bridge must agree. A panel showing a stale or
    // fabricated URL would otherwise pass every assertion below. This is the SAME
    // agreement guard `21-endpoint-traffic.spec.ts` carries, reusing the same reader
    // rather than writing a second URL comparison to go stale beside it.
    expect(
      await webhookUrl(page, route.id),
      'the panel URL is the SAME string the host-side webhook_url bridge answers',
    ).toBe(url);
    // D-12a: the `/endpoint/` segment is a HOST ROUTE PREFIX, not the kind name D-09
    // renamed. It is the one place the old word survives on screen, deliberately, and
    // nothing in this phase may claim it is gone.
    expect(url, 'D-12a: the /endpoint/ host prefix is on the copyable URL').toContain(
      '/endpoint/',
    );
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // -----------------------------------------------------------------------
    // 3. ONE DRAG. TWO CABLES. (D-04, SERVE-07)
    // -----------------------------------------------------------------------
    // THE SECOND DRAG SERVE-07's ORIGINAL ACCEPTANCE DESCRIBES DOES NOT EXIST, AND THIS
    // SENTENCE IS WHAT STOPS A LATER READER RESTORING IT. That text drew a SECOND wire
    // from the Handler's Out back to the Route. Under D-04 the FIRST drag already minted
    // the return leg from the two machines' DECLARATIONS (`command.rs`
    // `route_handler_pair` + `first_electrical_port`), so the Handler's single
    // electrical Out is already occupied and a second drag is refused `PortOccupied`.
    // A spec attempting that gesture would read a WORKING build as broken. Plan 72-01
    // reworded the acceptance and this is the reworded form.
    await steadyCamera(page);
    await drawWireBetweenPorts(page, routeOut as PortFacts, handlerIn as PortFacts);
    await pollScene(page, (s) => s.wires.length, {
      message: 'D-04: ONE drag between a Route and a Handler folded BOTH cable legs',
    }).toBe(2);

    const wired = await readScene(page);
    const forward = wired.wires.find((w) => w.from.node === route.id);
    const returnLeg = wired.wires.find((w) => w.from.node === handler.id);
    expect(forward, 'the FORWARD leg leaves the Route').toBeDefined();
    expect(returnLeg, 'and the SAME drag minted a RETURN leg leaving the Handler').toBeDefined();
    // SERVE-07's REWORDED FIRST HALF: the one drag produced a wire whose `from` is the
    // HANDLER's ELECTRICAL OUT DOCK. Asserted as the {node, port} pair, so a return leg
    // minted off the wrong port would fail here rather than pass a bare count.
    expect(
      returnLeg!.from,
      'SERVE-07: the return cable leaves the Handler ELECTRICAL Out dock, by index',
    ).toEqual({
      node: handler.id,
      port: handler.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL)!
        .index,
    });
    expect(
      returnLeg!.to.node,
      'and it points back at the Route that called, not at anybody else',
    ).toBe(route.id);
    console.log(
      `SERVE07_PAIR forward=${JSON.stringify(forward!.from)}->${JSON.stringify(forward!.to)} return=${JSON.stringify(returnLeg!.from)}->${JSON.stringify(returnLeg!.to)}`,
    );

    await expectRenderLoopAlive(page, 'after the paired drag');
    errs.assertNone('after the paired drag');

    // -----------------------------------------------------------------------
    // 4. THE POST, WITH NO `Configure` SENT BY THIS TEST. (SERVE-04)
    // -----------------------------------------------------------------------
    // The machines were PLACED and WIRED and nothing else. `fold_place` seeds a HANDLER
    // with `DEFAULT_HANDLER_SOURCE`, which calls `ctx.command` and therefore answers; a
    // `Node::Factory` reached by any other route carries `DEFAULT_FACTORY_SOURCE`, which
    // emits and never calls `ctx.command`, so its parked socket resolves only as a 504
    // on the deadline sweep. The BODY is what tells those two apart - a 200 with an
    // empty body would prove only that a socket closed.
    const sceneBefore = await readScene(page);
    const replyPulsesBefore = sceneBefore.replyPulsesObserved;
    const wireRepliesBefore = sceneBefore.wires.find((w) => w.id === returnLeg!.id)?.replyPulsesSeen ?? 0;
    const first = await post(page, 'SERVE-04: the preset Handler answers', url, '{"probe":"serve-04"}');
    expect(first.status, 'SERVE-04: the hand-built route answers its caller').toBe(200);
    expect(
      first.body,
      'SERVE-04: with the PRESET body, and no Configure was sent by this test',
    ).toBe(HANDLER_PRESET_BODY);

    // -----------------------------------------------------------------------
    // 5. SERVE-07's SECOND HALF: THAT SPECIFIC WIRE CARRIES A REPLY PULSE.
    // -----------------------------------------------------------------------
    // THE ATTRIBUTION IS THE WIRE ID, NEVER THE BOARD-GLOBAL COUNTER.
    // `scene.replyPulsesObserved` increments for a REPLY-direction pulse on ANY wire
    // (`sceneState.ts`), so it structurally CANNOT attribute a pulse to the cable this
    // spec drew: a spec resting on it alone would pass on a board where the reply went
    // to the wrong machine. It is read below as a SECONDARY signal only.
    //
    // The pulse's on-cable window is about one packet (15 to 20 ms), and a slow page's poll can
    // land after it closes: CI run 5 read this wire's `pulses[]` empty on every read for 30 s while
    // the board-wide latch had counted the reply. So the poll reads THAT wire's own reply latch
    // (`replyPulsesSeen`, plan 84-18: the packets in which this wire carried a REPLY pulse), which a
    // missed window cannot hide; the attribution to this wire id is unchanged.
    await pollScene(
      page,
      (s) => (s.wires.find((w) => w.id === returnLeg!.id)?.replyPulsesSeen ?? 0) > wireRepliesBefore,
      {
        timeout: 30_000,
        message: 'SERVE-07: THAT wire id carries a pulse whose direction is REPLY',
      },
    ).toBe(true);
    // The secondary signal, asserted as secondary: it moved too, which is consistent,
    // and on its own it would have been satisfied by a reply on any cable at all.
    expect(
      (await readScene(page)).replyPulsesObserved,
      'and the board-global reply counter moved too (a SECONDARY signal: it cannot say WHICH cable)',
    ).toBeGreaterThan(replyPulsesBefore);

    await expectRenderLoopAlive(page, 'after the reply came home');
    errs.assertNone('after the reply came home');

    // -----------------------------------------------------------------------
    // 6. SERVE-05: EDIT THE ANSWER. The Handler THIS SPEC PLACED.
    // -----------------------------------------------------------------------
    await selectMachineAt(page, HANDLER_CELL[0], HANDLER_CELL[1]);
    const before = await readFactorySource(page);
    expect(before, 'the panel opened on the Handler this spec placed').toContain(
      HANDLER_PRESET_BODY,
    );
    await typeFactorySource(
      page,
      `export default function (input, ctx) {\n  ctx.command({\n    status: 200,\n    headers: { "content-type": "text/plain" },\n    body: "${EDITED_BODY}",\n  }, 0);\n}`,
    );
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    const edited = await post(page, 'SERVE-05: the edited Handler answers', url, '{"probe":"serve-05"}');
    expect(edited.status, 'SERVE-05: the edited route still answers 200').toBe(200);
    expect(edited.body, 'SERVE-05: and the body IS the string the user authored').toBe(
      EDITED_BODY,
    );
    // BOTH HALVES. Without the differs-from clause, a build that IGNORED the edit and
    // returned the preset would pass the moment the two strings ever coincided, and the
    // requirement is "the user's own code ran", not "some code ran".
    expect(
      edited.body,
      'SERVE-05: and it DIFFERS from the preset body, so the edit is what produced it',
    ).not.toBe(HANDLER_PRESET_BODY);

    await expectRenderLoopAlive(page, 'after the source edit');
    errs.assertNone('after the source edit');

    // -----------------------------------------------------------------------
    // 7. THE PATH: type one, Apply, and POST the NEW URL. (D-12a made visible)
    // -----------------------------------------------------------------------
    await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
    await fillPanelField(page, PATH_FIELD_ID, TYPED_PATH);
    await applyConfig(page);
    // POLLED, NOT READ ONCE, AND THE REASON IS THE ROW'S OWN SHAPE. The URL is answered
    // by a `webhook_url` round trip to the host, so it lands one async hop after the
    // Apply that moved the committed path. A single read here is a race that resolves
    // against whichever string happens to be mounted, and it FAILED that way on the
    // first run of this spec. `expect.poll` is the live suite's idiom; a fixed sleep is
    // banned.
    await expect
      .poll(async () => readPanelUrl(page), {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'the POST URL row followed the COMMITTED path after Apply, without closing and reopening the panel',
      })
      .not.toBe(url);
    const newUrl = await readPanelUrl(page);
    console.log(`SERVE04_PANEL_URL typed=${newUrl}`);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    expect(newUrl, `and it ends at the path the user typed`).toContain(TYPED_PATH);
    // D-12a ARGUED IN A DOCUMENT IS ONE THING; THIS IS IT MADE VISIBLE. The
    // `/endpoint/` segment is a HOST ROUTE PREFIX and it STAYS, so a Route whose path is
    // `/orders` answers at `.../endpoint/orders`. It is the one place the old word
    // survives on screen and it survives ON PURPOSE (the maintainer's call, R-10) - no criterion
    // in this phase may claim the word is gone from the app.
    expect(newUrl, 'D-12a: the /endpoint/ prefix is STILL THERE on the user-pathed URL').toContain(
      '/endpoint/',
    );
    expect(newUrl, 'and the whole URL still matches the shipped loopback shape').toMatch(
      ENDPOINT_URL_SHAPE,
    );

    const atPath = await post(page, 'D-12a: the user-typed path answers', newUrl, '{"probe":"path"}');
    expect(atPath.status, 'the route answers at its new address').toBe(200);
    expect(atPath.body, 'with the same edited body, on the same board').toBe(EDITED_BODY);

    await expectRenderLoopAlive(page, 'after the path change');
    errs.assertNone('after the path change');

    // -----------------------------------------------------------------------
    // 8. D-06: DISCONNECT ON EITHER ROW TAKES BOTH CABLES.
    // -----------------------------------------------------------------------
    // D-06 IS A UI INVARIANT AS MUCH AS AN ENGINE ONE (72-UI-SPEC 5.6): there must be
    // no board state in which the forward cable exists without its return leg, and the
    // panel's per-row Disconnect is the ONE gesture that could produce one. So it is
    // pressed HERE, on the board this walk built, rather than reasoned about: the two
    // wire IDS are captured before the press and BOTH must be gone after it.
    const beforeDisconnect = await readScene(page);
    const pairIds = beforeDisconnect.wires.map((w) => w.id).sort((x, y) => x - y);
    expect(pairIds, 'the board carries exactly the two legs of one pair').toHaveLength(2);

    await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
    // The ROUTE's OUT row: the forward leg's source. Pressing the row that owns the
    // FORWARD cable is the case that matters - a Disconnect that took only the cable
    // named by the row it was pressed on would leave the RETURN leg orphaned, which is
    // the half-pair board the invariant rules out.
    await page.getByRole('button', { name: 'Disconnect Output - Wire' }).click();
    await pollScene(page, (s) => s.wires.length, {
      message: 'D-06: one Disconnect on the Route Out row removed BOTH cables',
    }).toBe(0);
    const afterDisconnect = await readScene(page);
    expect(
      afterDisconnect.wires.filter((w) => pairIds.includes(w.id)),
      'and specifically BOTH of the two wire ids are gone, not one replaced by another',
    ).toEqual([]);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    await expectRenderLoopAlive(page, 'after the disconnect');
    errs.assertNone('after the disconnect');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SERVE-08 + D-25: the red mark appears when the cable is missing, and clears
  // ═══════════════════════════════════════════════════════════════════════════
  test('SERVE-08 / D-25 - an unwired Route goes RED on a POST, and drawing the cable clears it with NO second POST', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await newBoard(page);

    await expectRenderLoopAlive(page, 'on the empty board, before the lone Route');
    errs.assertNone('on the empty board, before the lone Route');

    // ONE Route, NO wire. This is the board a user has thirty seconds after their first
    // placement, and until SERVE-08 it was the board that said nothing at all: the
    // `WireRequest` was discarded inside the fold with no fault and no wake, the state
    // byte stayed IDLE forever, and the caller's only signal was a host-side 504 three
    // hundred ticks later naming nothing on the board.
    await placeAndSettle(page, 'Route', LONE_ROUTE_CELL, KIND_ROUTE);
    const lone = nodeAtAnchor(await readScene(page), LONE_ROUTE_CELL[0], LONE_ROUTE_CELL[1])!;
    expect(lone.state, 'the freshly placed Route starts IDLE').toBe(STATE_IDLE);

    await selectMachineAt(page, LONE_ROUTE_CELL[0], LONE_ROUTE_CELL[1]);
    const loneUrl = await readPanelUrl(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // The POST is fired and NOT awaited to completion before the state poll: with no
    // cable the socket parks until the 300-tick deadline sweep answers 504, and the
    // whole claim of SERVE-08 is that the board says so LONG BEFORE that.
    const pending = post(page, 'SERVE-08: a POST at an unwired Route', loneUrl, '{"probe":"serve-08"}', 30_000);
    await pollScene(page, (s) => s.nodes.find((n) => n.id === lone.id)?.state, {
      timeout: 20_000,
      message: 'SERVE-08: the unwired Route goes FAULTED within a handful of sim ticks, long before the 300-tick deadline the 504 rides',
    }).toBe(STATE_FAULTED);

    const timedOut = await pending;
    expect(
      timedOut.status,
      'and the caller still gets the host-side deadline answer, which is the signal that was NOT enough on its own',
    ).toBe(504);

    await expectRenderLoopAlive(page, 'while the Route is faulted');
    errs.assertNone('while the Route is faulted');

    // -----------------------------------------------------------------------
    // D-25: DRAW THE MISSING CABLE, AND THE MARK CLEARS WITH NO SECOND POST.
    // -----------------------------------------------------------------------
    // THE NO-SECOND-POST CLAUSE IS THE ASSERTION. `72-CLEAN-DESIGN`'s mechanism cleared
    // this fault on the next successful ADMIT, which is one POST later; ruling R-14
    // overrode it, because a user who fixes the board and watches it stay red has been
    // told their fix did not work. So the clear lives in the FOLD
    // (`tick.rs drain_no_entry_wire_faults`, called from the wire mint), and a check
    // that POSTed again before looking would be satisfied by the mechanism R-14
    // REJECTED. That is what makes this clause the difference between an assertion and
    // a check that cannot fail.
    await placeAndSettle(page, 'HTTP Handler', CLEAR_HANDLER_CELL, KIND_HANDLER);
    const beforeDraw = await readScene(page);
    const loneRoute = nodeAtAnchor(beforeDraw, LONE_ROUTE_CELL[0], LONE_ROUTE_CELL[1])!;
    const clearHandler = nodeAtAnchor(beforeDraw, CLEAR_HANDLER_CELL[0], CLEAR_HANDLER_CELL[1])!;
    expect(
      loneRoute.state,
      'the Route is STILL red on the tick before the cable is drawn (so the clear below is the cable, not time passing)',
    ).toBe(STATE_FAULTED);

    const loneOut = loneRoute.ports.find(
      (p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL,
    );
    const clearIn = clearHandler.ports.find(
      (p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL,
    );
    await steadyCamera(page);
    await drawWireBetweenPorts(page, loneOut as PortFacts, clearIn as PortFacts);
    await pollScene(page, (s) => s.wires.length, {
      message: 'the missing cable landed (as a pair, per D-04)',
    }).toBe(2);

    // NO POST BETWEEN THE DRAW AND THIS POLL. Nothing above sends one and nothing
    // below does either until the assertion has settled.
    await pollScene(page, (s) => s.nodes.find((n) => n.id === loneRoute.id)?.state, {
      timeout: 20_000,
      message: 'D-25: the red mark cleared when the cable was drawn, with NO second POST',
    }).toBe(STATE_IDLE);

    await expectRenderLoopAlive(page, 'after the fault cleared');
    errs.assertNone('after the fault cleared');

    // AND THE ROUTE ACTUALLY WORKS NOW. Without this the clear above would be
    // satisfied by a build that cleared the mark and still dropped the request.
    const healed = await post(page, 'D-25: the repaired route answers', loneUrl, '{"probe":"d-25"}');
    expect(healed.status, 'the repaired route answers 200').toBe(200);
    expect(healed.body, 'with the preset Handler body').toBe(HANDLER_PRESET_BODY);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // The traversal probe (RESEARCH assumption A2, asserted LIVE)
  // ═══════════════════════════════════════════════════════════════════════════
  test('a traversal attempt at the endpoint door does NOT reach a Source hook route', async ({
    page,
  }) => {
    // A2 IS ASSERTED HERE AS WELL AS IN `crates/fabrico-host/tests/route_url_and_fault.rs`
    // BECAUSE IT WAS NEVER VERIFIED BEFORE THIS PHASE AND MUST NOT BE REASONED ABOUT.
    // The `/endpoint` prefix is what makes a user-typed path structurally unable to
    // reach `/hook/` (D-12a's second reason), so the property belongs to the SHIPPED
    // listener and not only to a unit fixture.
    //
    // THE PROBE IS WRITTEN DOWN A RAW SOCKET, AND THAT IS NOT FASTIDIOUSNESS: IT IS THE
    // ONLY WAY THIS CLAIM CAN BE MADE AT ALL. MEASURED, on the first run of this test.
    //
    // An HTTP CLIENT NORMALISES THE TRAVERSAL AWAY BEFORE IT LEAVES. `page.request.post`
    // parses its argument with the WHATWG URL parser, which decodes `%2e` to `.` inside
    // a path segment and then applies the double-dot rule, so BOTH
    // `/endpoint/../hook/src-N` and `/endpoint/%2e%2e/hook/src-N` go out as plain
    // `/hook/src-N`. The first draft of this test used the percent-encoded form, and it
    // read 200 - not because the host had been traversed, but because the CLIENT had
    // rewritten the request into a perfectly ordinary call at the hook door. A green or
    // a red from that probe would have described Node's URL parser and nothing else.
    //
    // So the bytes are written to the socket verbatim, exactly as
    // `crates/fabrico-host/tests/route_url_and_fault.rs` does and for exactly the same
    // reason. `node:net` is a Node builtin; the zero-mock rule is about importing
    // PRODUCT source, and nothing product-side is imported here.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await newBoard(page);

    // A REAL Source, so the traversal has a REAL target to miss. Without it the probe
    // would be a 404 for a door that does not exist, which proves nothing.
    await placeAndSettle(page, 'Source', LONE_ROUTE_CELL, 0);
    const source = nodeAtAnchor(await readScene(page), LONE_ROUTE_CELL[0], LONE_ROUTE_CELL[1])!;
    const hookUrl = await webhookUrl(page, source.id);
    expect(hookUrl, 'the placed Source publishes a hook URL').toBeTruthy();
    expect(hookUrl!, 'and it is a /hook/src- route, the namespace the probe aims at').toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/,
    );

    // THE DOOR IS REAL, MEASURED IN THIS RUN. The probe below claims "it did not reach
    // the hook route"; without this reading, a 404 from the probe would be
    // indistinguishable from a hook door that answers 404 to everything.
    const direct = await post(page, 'A2 control: the Source hook door, addressed directly', hookUrl!, '{"probe":"a2-control"}');
    expect(
      direct.status,
      'the Source hook route is LIVE, so the traversal has a real target to miss',
    ).not.toBe(404);

    const [, port] = hookUrl!.match(/^http:\/\/127\.0\.0\.1:(\d+)\//)!;
    const label = hookUrl!.split('/hook/')[1];
    const target = `/endpoint/../hook/${label}`;
    const statusLine = await rawPost(Number(port), target, 'ping');
    console.log(`SERVE_A2 target=${target} responseLine=${JSON.stringify(statusLine)}`);

    expect(
      statusLine,
      'A2: the traversal is NOT answered 200 by the hook door - the /endpoint prefix is what makes a user path structurally unable to reach /hook/',
    ).not.toContain(' 200 ');
    // AND THE CONTROL SAYS THE CHECK ABOVE IS OBSERVABLE. The direct call in this same
    // run got a 200 from the very door the traversal aimed at, so "not 200" here is a
    // statement about the traversal and not about a listener that refuses everything.
    expect(direct.status, 'the control call DID get 200 from that door in this run').toBe(200);

    // ═════════════════════════════════════════════════════════════════════════
    // THE HALF THE RAW PROBE STRUCTURALLY CANNOT SEE (vacuity finding V-7)
    // ═════════════════════════════════════════════════════════════════════════
    // THE PROBE ABOVE WAS PROVED VACUOUS BY MUTATION, AND THAT IS WHY THIS SECTION
    // EXISTS. Deleting the leading slash from `endpoint_route_key`
    // (`sim_loop.rs`: `path.trim_start_matches('/').to_string()`), which is the ENTIRE
    // structural guard this test's name names, left everything above GREEN. It had to:
    // no request whose target begins `/endpoint/` can produce a 200 from the hook door
    // however the key is spelled, so `not.toContain(' 200 ')` was never a statement
    // about the slash at all. A control that proves the door is live does not make a
    // check that cannot fail into one that can.
    //
    // What that leading slash actually buys is two things, and neither was asserted:
    //   (a) `/endpoint/` stays a WHOLE PATH SEGMENT on every URL the app hands the
    //       user, so the path the user chose sits strictly BENEATH the host prefix and
    //       has no way to climb out of it. Drop the slash and `webhook_url` formats
    //       `/endpoint` + `orders` and prints `.../endpointorders`: the segment
    //       boundary is gone, and with it the argument that a user path cannot reach
    //       another door.
    //   (b) the endpoint and source key namespaces are DISJOINT, so a Route may spell
    //       its path as another machine's hook label and still be a different address
    //       in the one shared route map.
    //
    // Both are exercised with the most adversarial path a user can actually type: THE
    // SOURCE'S OWN HOOK LABEL. `src-<id>` is nothing but unreserved bytes, so `/src-<id>`
    // is a path the write gate accepts, and it is the exact string that would collide
    // if endpoint keys did not live under a slash of their own.
    await placeAndSettle(page, 'Route', ROUTE_CELL, KIND_ROUTE);
    await placeAndSettle(page, 'HTTP Handler', HANDLER_CELL, KIND_HANDLER);
    const built = await readScene(page);
    const route = nodeAtAnchor(built, ROUTE_CELL[0], ROUTE_CELL[1])!;
    const handler = nodeAtAnchor(built, HANDLER_CELL[0], HANDLER_CELL[1])!;
    const routeOut = route.ports.find(
      (p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL,
    );
    const handlerIn = handler.ports.find(
      (p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL,
    );
    // THE CABLE IS WHAT MAKES THE ANSWER ATTRIBUTABLE. An unwired Route answers 504 for
    // every address, so a wired one is the only board on which "this URL reached THIS
    // Route" and "this URL reached nothing" are different readings.
    await steadyCamera(page);
    await drawWireBetweenPorts(page, routeOut as PortFacts, handlerIn as PortFacts);
    await pollScene(page, (s) => s.wires.length, {
      message: 'the Route reaches a Handler, so its 200 is its OWN and the two doors are told apart by their bodies',
    }).toBe(2);

    await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
    const defaultUrl = await readPanelUrl(page);
    await fillPanelField(page, PATH_FIELD_ID, `/${label}`);
    await applyConfig(page);
    // Polled for the same reason the SERVE-04 walk polls: the URL row is answered by a
    // `webhook_url` round trip to the host and lands one async hop after the Apply.
    await expect
      .poll(async () => readPanelUrl(page), {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'the POST URL row followed the committed path after Apply',
      })
      .not.toBe(defaultUrl);
    const claimedUrl = await readPanelUrl(page);
    console.log(`SERVE_V7 hook=${hookUrl} claimed=${claimedUrl}`);
    // NO `deselectViaEmptyCell` HERE, AND THAT IS MEASURED RATHER THAN LAZY. This board
    // carries the Source at (8,14) as well as the Route and Handler, so the fit-to-
    // content camera is taller than the one the SERVE-04 walk deselects against and the
    // `EMPTY_CELL` at (2,2) projects off canvas: the click lands nowhere and the panel
    // never unmounts. Nothing below reads the board through the panel, so the panel is
    // simply left open.

    // (a) THE PREFIX IS A WHOLE SEGMENT, ON THE URL THE APP ACTUALLY HANDS OVER. This
    // is the assertion the named mutation reddens: with the slash gone from the key,
    // this string is `http://127.0.0.1:PORT/endpointsrc-<id>` and matches nothing.
    expect(
      claimedUrl,
      'V-7(a): the app hands the user a URL whose /endpoint/ prefix is a COMPLETE path segment, even when the path the user chose spells another door',
    ).toMatch(ENDPOINT_URL_SHAPE);
    expect(
      claimedUrl.match(ENDPOINT_URL_SHAPE)![2],
      'and everything beneath that segment is EXACTLY the path the user typed, one level down and unable to climb out',
    ).toBe(label);
    expect(
      await webhookUrl(page, route.id),
      'and the panel row is the same string the host-side webhook_url bridge answers, so this is the shipped URL and not a spec-built one',
    ).toBe(claimedUrl);

    // (b) AND IT WORKS, which is what keeps (a) from being a string check. The Route
    // answers at its own address with its OWN Handler's body.
    const atClaimed = await post(
      page,
      'V-7: the Route answers at /endpoint/<a Source hook label>',
      claimedUrl,
      '{"probe":"v-7-endpoint"}',
    );
    expect(
      atClaimed.status,
      'V-7(b): the published URL resolves at the endpoint door; a URL with no /endpoint/ segment resolves at no door at all and reads 404',
    ).toBe(200);
    expect(
      atClaimed.body,
      'and the answer is THIS Route\'s Handler, so the address belongs to the Route',
    ).toBe(HANDLER_PRESET_BODY);

    // (c) AND THE SOURCE STILL OWNS ITS OWN DOOR, under the same spelling. One shared
    // route map, two namespaces, and the Route claiming `/src-<id>` took nothing.
    const stillSource = await post(
      page,
      'V-7: the Source hook door, after a Route claimed its label as a path',
      hookUrl!,
      '{"probe":"v-7-hook"}',
    );
    expect(
      stillSource.status,
      'V-7(c): the Source still answers at /hook/<its label> after a Route claimed that label as its path',
    ).toBe(200);
    expect(
      stillSource.body,
      'and the hook door did NOT answer with the Route\'s Handler body, which is what a collapsed namespace would produce',
    ).not.toBe(HANDLER_PRESET_BODY);

    await expectRenderLoopAlive(page, 'after the traversal probe');
    errs.assertNone('after the traversal probe');
  });
});

/**
 * Write a POST down a RAW loopback socket and return its HTTP status line.
 *
 * The path is sent VERBATIM: no URL parsing, no normalisation, no client in the loop.
 * That is the whole point (see the traversal probe above for the measurement that made
 * it necessary). `Connection: close` so the read ends without a keep-alive wait.
 */
async function rawPost(port: number, target: string, body: string): Promise<string> {
  const net = await import('node:net');
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    const done = (value: string): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(10_000, () => done('<no response: socket timeout>'));
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    socket.on('close', () => resolve(buf.split('\r\n')[0] || '<no response>'));
  });
}
