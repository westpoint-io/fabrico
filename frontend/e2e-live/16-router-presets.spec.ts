import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  armAndPlaceAt,
  beltEndInstructionsOn,
  drawFaultBeltThroughCells,
  expectRenderLoopAlive,
  handPlaceAt,
  loadDemoViaExamples,
  newBoard,
  nodeAtAnchor,
  pollScene,
  readScene,
  recordStatusStripDuring,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';
// CHROME-09 (phase 91 D-09): the one-name leg reads the shared kind-name map, the same
// pure module `11-machine-labels.spec.ts` imports, so the expected name is the map's and
// is never retyped as a second copy.
import { KIND_NAMES } from '../shared/kindNames';

// 16-router-presets.spec.ts (ROUTE-06 / PORT-08, 36-05) - the LIVE proof that the
// Router palette preset is real end-to-end: clicking "Place Router" and dropping
// on the canvas drives the shipped gesture controller -> Place{ROUTER} -> (on the host
// echo) the RemovePort/AddPort seeding -> real core fold -> echo packet ->
// window.__fabrico.scene(). The oracle exposes each port's `medium`, so this gate
// falsifiably checks that placing the preset produces the ONE Node::Router whose ports
// carry the preset's medium, at the catalog's arity.
//
// RE-POINTED BY PLAN 72-13, LEDGER ROW LR-6. This file asserted TWO presets and placed
// both. Plan 72-10's R-64 PULLED the `HTTP Router` palette row as a live FALSE CLAIM:
// nothing ever links a machine's OUTPUT port into a wire (`tick.rs` creates only the one
// link, from the request's entry), so a Router structurally cannot sit on a request path
// at all, and its byte-offset match rule would also break after 128 requests as the
// correlation varint widens past one byte. The row was pulled rather than corrected
// because there is no TRUE sentence available for a machine that cannot do the job.
//
// This file was NOT in plan 72-13's `files_modified`; the scope was widened rather than
// the red left standing, and the tests are RE-POINTED at the shipped truth rather than
// deleted to make a number. The electrical `Node::Router` engine still exists in the
// core and `place_router_preset(Medium::Electrical, ..)` is unchanged - what went is the
// PALETTE GESTURE, and the second test below is what says so.
//
// The port profile asserted below WIDENED in plan 65-05 (ROUTE-02): a palette Router
// used to be seeded 1-in/2-out from three hard-coded AddPort legs while the catalog
// declared three outputs, so the only Router a user could place had nowhere to send a
// second branch. 65-01 recorded this spec's 1-in/2-out pin IN ADVANCE as the known
// consequence, so this move is the change landing rather than a defect.
//
// No mock: real pointer events + getByRole/getByTitle only; every state wait is an
// expect.poll on a specific model change (no fixed sleeps). If the palette wiring,
// the beginRouterPreset seeding, the echo watcher, or the host preset fold
// regresses, this gate fails.

test.describe.configure({ mode: 'serial' });

const KIND = { ROUTER: 5 } as const;
const ROLE = { IN: 0, OUT: 1, FAULT: 2 } as const;
// The seeded preset profile: one In, the catalog's Out arity (ROUTER_OUT_ARITY on the
// Rust side), and - since plan 71-04 (PILE-10) appended a spatial Role::Fault nub to
// the ROUTER catalog entry - one Fault. Spelled here as the ROLE MULTISET the oracle
// reads back rather than as a bare count, so a failure names which role went missing.
//
// WHY THE FAULT NUB IS IN THE PRESET PROFILE AT ALL, since the answer is not obvious
// and is MEASURED rather than assumed. `gestures.ts`'s `seedRouterPreset` derives its
// AddPort legs from `catalogEntry(ROUTER).ports`, the whole catalog entry, so the
// widened entry puts a Fault leg in the browser's seeding sequence. Measured on the real
// host 2026-09-02: an HTTP Router settled at role 0/1/1/1/2 all medium=1, a Mechanical-preset Router
// at the same roles all medium=0, so the HTTP Router's fault nub was Electrical, one no
// belt can dock.
//
// PLAN 85-05 (D-22) CLOSED BOTH HALVES. The Fault leg now seeds at Mechanical for both
// presets (a fault drains on a belt), so a Mechanical-preset Router still settles all medium=0 and
// an HTTP Router settles at In and Outs medium=1 with a medium=0 Fault. And the Rust
// `place_router_preset`, whose producer `router_preset_ports` used to seed NO Fault (a
// 4-port Router where the browser landed a 5-port one, WINDOWS 170, found by plan
// 71-08), now seeds the same five ports; `ts_catalog_mirror.rs` checks the count. The
// fault-nub leg at the end of this file is the live proof.
const EXPECTED_ROLES = [ROLE.IN, ROLE.OUT, ROLE.OUT, ROLE.OUT, ROLE.FAULT] as const;
const MEDIUM = { MECHANICAL: 0, ELECTRICAL: 1 } as const;

// Empty space below the demo (rows 11+): a 2x3 router here stays in the viewport
// and on the canvas floor (NOT under the left palette) at the boot fit camera. The
// host persists across tests (beforeAll reset), so the two placements use DISTINCT
// non-overlapping cells. HTTP_CELL is the known-good [6,11] landing zone
// 08-delete-control places into; ITEM_CELL is a clear cell to its right.
const HTTP_CELL = [6, 11] as const;
const ITEM_CELL = [10, 11] as const;
// The fault-nub leg (plan 85-05): an HTTP-preset Router at FAULT_ROUTER_CELL (2x3, so
// rows 11..13, clear of the two cells above), its Fault nub at local (0,2) facing S, and
// a Sink whose In faces W at FAULT_SINK_CELL, reached by a belt down one cell from the
// fault doorstep and then east along row 14.
const FAULT_ROUTER_CELL = [14, 11] as const;
const FAULT_SINK_CELL = [17, 14] as const;
// The one-name leg (CHROME-09) places its Router on an EMPTY board (`newBoard`), at the
// same cell the Mechanical-preset leg uses on the demo, which sits on the open floor at the
// boot fit camera.
const ONE_NAME_CELL = ITEM_CELL;
/**
 * The wire sentinel a FAULT dock is recorded under (`fabrico_core::FAULT_PORT`): a Tail
 * dock on a Fault nub is translated at freeze time from the nub's catalog index to this
 * routing key, so it is the value a belt's `docks` carries. Mirrored from `ports.ts`, as
 * `26-fault-drain.spec.ts` mirrors it, so the expectation is not computed by the code
 * under test.
 */
const FAULT_PORT = 65535;

type NodeFacts = SceneFacts['nodes'][number];

/** The ids of the ROUTER nodes already present at baseline (the demo has one). */
function baselineRouterIds(s: SceneFacts): Set<number> {
  return new Set(s.nodes.filter((n) => n.kind === KIND.ROUTER).map((n) => n.id));
}

/** The freshly PLACED router: the kind-5 node whose id is NOT in the baseline set. */
function placedRouter(s: SceneFacts, baseline: Set<number>): NodeFacts | undefined {
  return s.nodes.find((n) => n.kind === KIND.ROUTER && !baseline.has(n.id));
}

/**
 * Poll until the placed router has FULLY SETTLED into the seeded preset: exactly the
 * EXPECTED_ROLES multiset with EVERY port at `medium`. Polling the whole predicate
 * (not length-then-read) rides out the async seeding fold (Place echoes, then
 * RemovePort/AddPort legs land over ticks) without catching a transient intermediate
 * state - the falsifiable "the router carries the preset's medium" oracle
 * (must_haves truth #1).
 */
async function pollSettledPreset(
  page: Page,
  baseline: Set<number>,
  medium: number,
): Promise<void> {
  await pollScene(
    page,
    (s) => {
      const r = placedRouter(s, baseline);
      if (!r || r.ports.length !== EXPECTED_ROLES.length) return false;
      const roles = r.ports.map((p) => p.role).sort();
      const rolesOk = roles.every((role, i) => role === EXPECTED_ROLES[i]);
      return rolesOk && r.ports.every((p) => p.medium === medium);
    },
    {
      message: `the placed router settles into the ${EXPECTED_ROLES.length}-port preset profile (roles [${EXPECTED_ROLES}]) with every port at medium=${medium}`,
    },
  ).toBe(true);
}

/**
 * RENDER-01 (A1) live footprint proof: the settled Router occupies its REAL 2x3 =
 * 6-cell footprint on the render packet, NOT the stale 1x1 the v6.0 sprite baked.
 * This is the live confirmation that the honest per-node footprint reaches the
 * render layer (`node.w/h` -> the size-augmented `|WxH` cache key re-bakes the sprite
 * at exactly this box). The data-oracle checks the MODEL footprint here (which was
 * always honest); the pixel proof that the sprite now FILLS the box is the
 * milestone-end FEEL kit + the Phase 43 pixel probe (v6.0-VISUAL-QA process gap).
 *
 * The Router `grow_to_fit` growth-on-further-port-add is exercised at the unit level
 * (lodTints.test.ts bakes a distinct block for a 2x3 vs a 2x4 Router, and machines.ts
 * carries `|WxH` in the body + overlay cache keys): the shipped app exposes no
 * user-facing AddPort gesture, so a live 4th-port add cannot be driven through the
 * real UI. The 6-cells assertion (strictly > the old 1x1) is the falsifiable live guard.
 */
function assertRouterFootprint(page: Page, baseline: Set<number>): Promise<void> {
  // UNMOVED by the 65-05 arity widening, deliberately: grow_to_fit's minimum height is
  // max(input count, output count), and the frozen 2x3 Router base already holds exactly
  // ROUTER_OUT_ARITY rows, so a widened preset still floors at the same box. If this
  // number ever has to move, the arity outgrew the frozen base and that is a
  // fabrico-core change no phase after 63 may make.
  return readScene(page).then((s) => {
    const r = placedRouter(s, baseline) as NodeFacts;
    expect(r.cells.length, 'the settled Router occupies its real 2x3 = 6-cell footprint').toBe(6);
    expect(r.cells.length, 'the Router footprint is NEVER the stale 1x1 (RENDER-01)').toBeGreaterThan(1);
  });
}

/**
 * Ensure the shared host sim is PLAYING (its tick is advancing). A prior spec
 * (15-disconnected) pauses the sim, and pause is HOST-global - a page reload does
 * NOT resume it. A placement gesture only folds inside `tick_once`, so on a paused
 * host the Place is queued forever and never echoes. Toggle the Play/Pause control
 * until the tick advances (idempotent no-op when already playing, e.g. in isolation).
 */
async function ensurePlaying(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: /^(Play|Pause)$/ });
  for (let i = 0; i < 3; i += 1) {
    const t0 = (await readScene(page)).tick;
    await page.waitForTimeout(400);
    if ((await readScene(page)).tick > t0) return; // the sim is advancing
    await btn.click(); // paused → toggle and re-check
  }
  throw new Error('could not resume the sim (tick never advanced)');
}

/**
 * Arm a Router preset via its palette button, drop at world cell (cx,cy), then
 * Escape to disarm (30-03 leaves the tool armed after a placement). Real pointer
 * events only - the shipped arm-then-click model.
 */
async function armAndPlacePreset(
  page: Page,
  label: 'Place Router',
  cx: number,
  cy: number,
): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  const drop = await screenCellCentre(page, cx, cy);
  await page.mouse.move(drop.x, drop.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

test.describe('ROUTE-06 live: the surviving Router preset seeds the ONE engine at the right medium', () => {
  // The host is ONE shared, stateful process across the whole live suite (workers:1).
  // Reset it to the demo baseline ONCE (a full LoadDemo genesis swap) so rows
  // 11+ are known-empty for a clean router placement - the SAME falsifiable reset +
  // known landing zone 08-delete-control uses (proven robust in the full suite).
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
    const page = await context.newPage();
    await page.goto('/');
    await waitForAppReady(page);
    const tickBefore = (await readScene(page)).tick;
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
      message: 'the LoadDemo genesis swap folded onto the demo baseline',
    }).toBe(true);
    await context.close();
  });

  // Each test reloads the page (fresh frontend → boot fit-to-factory camera, so
  // the drop cell sits on the canvas floor exactly as at boot - mirrors 08's
  // pattern) and ensures the shared host sim is playing (a prior spec may have left
  // it paused, which would freeze the placement fold).
  // RENDER HEALTH (71-review IN-04). Every assertion in this file reads
  // `window.__fabrico.scene()`, which is fed by the packet path and is completely
  // independent of the Pixi ticker: a build whose renderer is dead leaves the whole
  // file green over a blank canvas, which is this repository's recorded model-oracle
  // blind spot rather than a hypothesis. The specs this one sits beside (19, 24, 25,
  // 26) all carry these two guards; the asymmetry inside one directory invites the
  // next author to copy the wrong pattern.
  //
  // The watcher is installed BEFORE `page.goto` - its own docblock requires it, since
  // installing it afterwards loses every error raised during load - and both guards run
  // after EVERY test rather than being written out three times. This spec ARMS AND
  // DROPS on the canvas, so a dead renderer is a live possibility here and not just a
  // theoretical one.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensurePlaying(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the Router preset walk');
    errs.assertNone('the Router preset walk');
  });

  test('the palette lists the Router as the ONE Router preset, and the HTTP Router row is PULLED', async ({
    page,
  }) => {
    await expect(page.getByRole('button', { name: 'Place Router', exact: true })).toBeVisible();
    // R-64's pull, asserted rather than left as a comment. This assertion is the
    // POSITIVE SUCCESSOR of the `Place HTTP Router` visibility pin that used to sit
    // here: the row is gone, and a build that put it back reddens this file rather than
    // silently re-advertising a machine that cannot sit on a request path.
    await expect(
      page.getByRole('button', { name: 'Place HTTP Router' }),
      'R-64: the HTTP Router row is PULLED - a Router structurally cannot sit on a request path',
    ).toHaveCount(0);
    // ONE Router row and ONE Route row (CHROME-09, phase 91 D-09). The preset row now
    // carries the kind name itself, so `Place Router` names exactly the preset and no
    // bare generic entry beside it; and `Place Route` is a PREFIX of `Place Router`, so
    // each is counted by exact name and must match its own row only.
    await expect(page.getByRole('button', { name: 'Place Router', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Place Route', exact: true })).toHaveCount(1);
    // NON-VACUITY: a count of exactly 1 on each exact name already rules out a palette that
    // did not render (review IN-C03: this note used to call the two counts zero, from before
    // phase 91 put the kind name on the preset row).
  });

  test('the PULL is a palette pull, not an engine removal: the electrical machines a user places are the Route and the Handler', async ({
    page,
  }) => {
    // RE-POINTED BY PLAN 72-13, LEDGER ROW LR-6. This test placed an `HTTP Router` and
    // asserted it settled with ELECTRICAL ports. With the row pulled there is no gesture
    // that places an electrical Router at all, so the old subject is unreachable by any
    // user action and a spec attempting it can only ever assert a selector timeout.
    //
    // ITS SUCCESSOR IS THE QUESTION R-64 ACTUALLY ANSWERED: if a Router is not the
    // machine that sits on a wire, WHICH machines are? The two rows plan 72-10 added in
    // the same commit that pulled this one. Asserting them here is what keeps this file
    // covering the electrical half of the palette instead of quietly ceasing to.
    await expect(
      page.getByRole('button', { name: 'Place Route', exact: true }),
      'the Route row: the front door a webhook arrives at',
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Place HTTP Handler' }),
      'the HTTP Handler row: the machine that answers, which a Router cannot do',
    ).toBeVisible();

    // And they are ELECTRICAL machines, read off the real host rather than asserted from
    // the palette copy. Without this the two visibility checks above would be satisfied
    // by any two rows carrying the right labels.
    const baseline = await readScene(page);
    await armAndPlaceAt(page, 'Route', HTTP_CELL[0], HTTP_CELL[1]);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the hand-placed Route folded on the real host',
    }).toBe(baseline.nodes.length + 1);
    const placed = nodeAtAnchor(await readScene(page), HTTP_CELL[0], HTTP_CELL[1]);
    expect(placed, 'the Route landed at its drop cell').toBeDefined();
    expect(
      placed!.ports.map((p) => ({ role: p.role, medium: p.medium })),
      'the Route carries an ELECTRICAL In at index 0 and an ELECTRICAL Out at index 1, verbatim from port_catalog(ENDPOINT)',
    ).toEqual([
      { role: ROLE.IN, medium: MEDIUM.ELECTRICAL },
      { role: ROLE.OUT, medium: MEDIUM.ELECTRICAL },
    ]);
  });

  test('placing the Router yields the ONE engine with MECHANICAL ports, at the catalog arity', async ({
    page,
  }) => {
    const baseline = baselineRouterIds(await readScene(page));
    await armAndPlacePreset(page, 'Place Router', ITEM_CELL[0], ITEM_CELL[1]);

    // RE-WORDED BY PLAN 72-13. This read "the SAME engine ... medium is the SOLE
    // difference from the HTTP preset", and that comparison rested on the electrical
    // placement the test above used to make. With the HTTP row pulled there is no
    // same-run electrical Router to differ from, so the sentence would have been prose
    // nothing checked. What survives and is still measured: the ONE `Node::Router`
    // engine, at the catalog's port profile, seeded MECHANICAL.
    await pollSettledPreset(page, baseline, MEDIUM.MECHANICAL);
    const router = placedRouter(await readScene(page), baseline);
    expect((router as NodeFacts).kind).toBe(KIND.ROUTER); // the ONE engine, not a new kind
    // RENDER-01 (A1): the placed Router carries the SAME real 2x3 = 6-cell footprint.
    await assertRouterFootprint(page, baseline);
  });

  test('an HTTP-preset Router has a fault nub a belt can dock (D-22: the Fault leg seeds at Mechanical)', async ({
    page,
  }) => {
    // D-22 asks for the dead HTTP-Router fault nub to be CONFIRMED on the real host
    // before it is fixed. Since plan 72-10 (R-64) no palette row arms the HTTP preset,
    // so no gesture reaches it, and the row is NOT put back (the first test in this file
    // pins it absent). The route taken instead (plan 85-05, recorded as an assumption in
    // its SUMMARY): the SHIPPED seeding legs, `routerPresetSeedCommands` from
    // `src/input/gestures.ts` (the function the palette path sends through, lifted out of
    // the controller unchanged), encoded by the shipped `encodeGridCommand` and put on
    // the app's OWN render socket to the real host. The Sink is placed and the belt drawn
    // by real pointer gestures; only the preset's arming is not a gesture.
    //
    // RED FIRST, measured: while the legs seeded every port at the preset medium, the
    // HTTP preset's Fault was Electrical, the Belt tool's doorstep press treated it as a
    // plain start (gestures.ts `doorstepPressHit`, the MEDIUM term), and the drawn belt
    // docked its Head to the Sink and NOTHING at its Tail.
    const ELECTRICAL = MEDIUM.ELECTRICAL;

    // 1. Remember the app's render socket: observe `send` (forwarding every frame
    //    unchanged) so the next frame the app itself sends names the socket.
    await page.evaluate(() => {
      const w = window as unknown as { __fabSock?: WebSocket; __fabSockTapped?: boolean };
      if (w.__fabSockTapped) return;
      w.__fabSockTapped = true;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
        w.__fabSock = this;
        return send.call(this, data);
      };
    });

    // 2. The Sink, by a real palette gesture (its Place is the frame that names the socket).
    const before = await readScene(page);
    await armAndPlaceAt(page, 'Sink', FAULT_SINK_CELL[0], FAULT_SINK_CELL[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, FAULT_SINK_CELL[0], FAULT_SINK_CELL[1]) !== undefined, {
      message: 'the hand-placed Sink folded on the real host',
    }).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { __fabSock?: WebSocket }).__fabSock !== undefined),
      'the Sink Place went out on the app render socket, so the socket is known',
    ).toBe(true);

    // 3. A bare Router, then the shipped HTTP-preset legs, on that socket. Since phase 88
    //    (plan 88-03, D-02, D-06) a gesture frame carries a header, the board generation
    //    and a gesture id, framed by the shipped `encodeGestureFrame`. The generation is the
    //    scene's own (read off `window.__fabrico.scene()`, the packet the page last
    //    applied); the id is 0, which the page never assigns (its ids start at 1), so a
    //    verdict on one of these frames pairs with nothing the page sent.
    const sendCommands = async (cmds: unknown[]): Promise<void> => {
      await page.evaluate(async (list) => {
        const decodeUrl = '/src/protocol/decode.ts';
        const { encodeGridCommand, encodeGestureFrame } = (await import(/* @vite-ignore */ decodeUrl)) as {
          encodeGridCommand(c: unknown): Uint8Array<ArrayBuffer>;
          encodeGestureFrame(generation: number, gestureId: number, body: Uint8Array): Uint8Array<ArrayBuffer>;
        };
        const w = window as unknown as { __fabSock: WebSocket; __fabrico?: { scene(): { generation: number } } };
        const generation = w.__fabrico?.scene().generation ?? 0;
        for (const c of list) w.__fabSock.send(encodeGestureFrame(generation, 0, encodeGridCommand(c)));
      }, cmds);
    };
    await sendCommands([
      { kind: 'Place', kind_byte: KIND.ROUTER, cell_x: FAULT_ROUTER_CELL[0], cell_y: FAULT_ROUTER_CELL[1] },
    ]);
    await pollScene(page, (s) => nodeAtAnchor(s, FAULT_ROUTER_CELL[0], FAULT_ROUTER_CELL[1])?.kind === KIND.ROUTER, {
      message: 'the bare Router folded at its cell on the real host',
    }).toBe(true);
    const bare = nodeAtAnchor(await readScene(page), FAULT_ROUTER_CELL[0], FAULT_ROUTER_CELL[1])!;
    const seed = await page.evaluate(
      async ({ node, medium }) => {
        const gesturesUrl = '/src/input/gestures.ts';
        const { routerPresetSeedCommands } = (await import(/* @vite-ignore */ gesturesUrl)) as {
          routerPresetSeedCommands(n: { id: number; ports: { index: number }[] }, m: number): unknown[];
        };
        return routerPresetSeedCommands(node, medium);
      },
      { node: { id: bare.id, ports: bare.ports.map((p) => ({ index: p.index })) }, medium: ELECTRICAL },
    );
    await sendCommands(seed);
    await pollScene(
      page,
      (s) => {
        const r = nodeAtAnchor(s, FAULT_ROUTER_CELL[0], FAULT_ROUTER_CELL[1]);
        if (!r || r.ports.length !== EXPECTED_ROLES.length) return false;
        const roles = r.ports.map((p) => p.role).sort();
        // The BARE Router already carries the catalog's five roles, all Mechanical, so
        // the roles alone would pass before a single seeding leg folded. The legs have
        // landed when the In and every Out read Electrical.
        return (
          roles.every((role, i) => role === EXPECTED_ROLES[i]) &&
          r.ports.filter((p) => p.role !== ROLE.FAULT).every((p) => p.medium === MEDIUM.ELECTRICAL)
        );
      },
      { message: 'the HTTP-preset Router settles into the five-port preset profile, In and Outs Electrical' },
    ).toBe(true);

    const scene = await readScene(page);
    const router = nodeAtAnchor(scene, FAULT_ROUTER_CELL[0], FAULT_ROUTER_CELL[1])!;
    const sink = nodeAtAnchor(scene, FAULT_SINK_CELL[0], FAULT_SINK_CELL[1])!;
    expect(
      router.ports.filter((p) => p.role !== ROLE.FAULT).every((p) => p.medium === MEDIUM.ELECTRICAL),
      'the HTTP preset seeds its In and Outs ELECTRICAL',
    ).toBe(true);
    const fault = router.ports.find((p) => p.role === ROLE.FAULT)!;
    const sinkIn = sink.ports.find((p) => p.role === ROLE.IN)!;
    expect(
      [fault.cell_x, fault.cell_y, fault.side],
      'the fault nub sits on the Router\'s bottom-left cell, facing S',
    ).toEqual([FAULT_ROUTER_CELL[0], FAULT_ROUTER_CELL[1] + 2, 2]);

    // 4. A belt from the fault nub's doorstep to the Sink, by real pointer gestures.
    const run: [number, number][] = [
      [fault.cell_x, fault.cell_y + 1],
      [fault.cell_x + 1, fault.cell_y + 1],
      [fault.cell_x + 2, fault.cell_y + 1],
    ];
    const beltsBefore = new Set(scene.belts.map((b) => b.id));
    const strip = await recordStatusStripDuring(page, async () => {
      await drawFaultBeltThroughCells(page, fault, run, sinkIn);
      await pollScene(page, (s) => s.belts.some((b) => !beltsBefore.has(b.id)), {
        message: 'the drawn belt folded on the real host',
      }).toBe(true);
    });
    test.info().annotations.push({ type: 'status-strip', description: JSON.stringify(strip) });

    // 5. Both ends docked, read off the model: the Tail on the Router's Fault (recorded
    //    under the FAULT_PORT routing key, not the nub's catalog index) and the Head on
    //    the Sink's In. The Tail dock is the half that was dead.
    await pollScene(
      page,
      (s) => {
        const belt = s.belts.find((b) => !beltsBefore.has(b.id));
        if (!belt) return 'no belt';
        return belt.docks
          .map((d) => `${d.end}:${d.node === router.id ? 'router' : d.node === sink.id ? 'sink' : d.node}:${d.port}`)
          .sort()
          .join(' ');
      },
      { message: 'the fault belt docks its Tail on the Router fault nub and its Head on the Sink In' },
    ).toBe(`Head:sink:${sinkIn.index} Tail:router:${FAULT_PORT}`);
    const docked = await readScene(page);
    const belt = docked.belts.find((b) => !beltsBefore.has(b.id))!;
    // And the paint half: a docked end plots a stem and a role cap, an undocked end
    // plots nothing, so a belt whose ends are drawn reads above zero here.
    expect(await beltEndInstructionsOn(page, belt.id), 'the docked belt ends are drawn').toBeGreaterThan(0);
    expect(docked.nodes.length, 'the leg added exactly two machines, the Router and the Sink').toBe(
      before.nodes.length + 2,
    );
    expect(docked.belts.length, 'and exactly one belt').toBe(before.belts.length + 1);
  });
  test('one name everywhere: the palette row, the name tag, the inspector heading and the Legend row all read Router (CHROME-09)', async ({
    page,
  }) => {
    // CHROME-09, phase 91 D-09, success criterion 4, UI-SPEC 8.1 and walk step 11. Kind 5
    // is ONE machine and the shared name map calls it `Router`; the board's name tag, the
    // inspector heading and the Legend row already read that map, and the palette row was
    // the one surface that hand-wrote a longer name. Every surface is read off the page,
    // never off the model.
    const NAME = KIND_NAMES[KIND.ROUTER];
    expect(NAME, 'the shared name map names kind 5').toBe('Router');

    // 1. The palette row: its accessible name and its visible name span.
    const row = page.getByRole('button', { name: `Place ${NAME}`, exact: true });
    await expect(row, 'one palette row is named "Place Router"').toHaveCount(1);
    await expect(row.locator('span').last(), "the palette row's name span reads the shared name").toHaveText(NAME);

    // 2. Place it the way a hand does, on an empty board, so it is the only Router there.
    await newBoard(page);
    const pt = await screenCellCentre(page, ONE_NAME_CELL[0], ONE_NAME_CELL[1]);
    expect(
      await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const),
      'PRECONDITION: the drop cell is on the open board',
    ).toBe('CANVAS');
    await handPlaceAt(page, NAME, ONE_NAME_CELL[0], ONE_NAME_CELL[1]);
    await page.keyboard.press('Escape');
    await pollScene(page, (s) => nodeAtAnchor(s, ONE_NAME_CELL[0], ONE_NAME_CELL[1])?.kind ?? -1, {
      message: 'the hand-placed Router folded at its drop cell on the real host',
    }).toBe(KIND.ROUTER);
    await expectRenderLoopAlive(page, 'after the Router is placed');

    // 3. Names on: the placed Router's tag reads the shared name.
    const names = page.getByRole('button', { name: 'Names' });
    await names.click();
    await expect(names).toHaveAttribute('aria-pressed', 'true');
    const tags = page.locator(`[data-testid="machine-label"][data-kind="${KIND.ROUTER}"]`);
    await expect(tags, 'one name tag for the one Router on the board').toHaveCount(1);
    await expect(tags, 'the name tag reads the shared name').toHaveText(NAME);

    // 4. Selected: the inspector heading is the shared name (drawn upper case by the
    //    title style, `Router` in the DOM).
    await selectMachineAt(page, ONE_NAME_CELL[0], ONE_NAME_CELL[1]);
    const heading = page.locator('#fab-config-heading');
    await expect(heading).toBeVisible();
    expect(
      await heading.evaluate((h) => (h.firstChild?.textContent ?? '').trim()),
      'the inspector heading reads the shared name',
    ).toBe(NAME);

    // 5. The Legend row for kind 5 reads the shared name.
    const legendBtn = page.getByRole('button', { name: 'Legend' });
    await legendBtn.click();
    await expect(legendBtn).toHaveAttribute('aria-expanded', 'true');
    const legend = page.locator('#fab-legend-panel');
    await expect(legend.getByText(NAME, { exact: true }), 'the Legend names the Router once').toHaveCount(1);
    await expect(legend.getByText(NAME, { exact: true })).toBeVisible();

    // 6. Names off again, pressed with the Router still selected: the inspector docks below the
    //    toolbar (phase 91, plan 91-09, CHROME-07), so it no longer covers the Names button.
    //    Plan 91-05 dropped this step because the open inspector intercepted the click.
    await expect(heading, 'the Router is still selected').toBeVisible();
    await names.click({ timeout: 10_000 });
    await expect(names).toHaveAttribute('aria-pressed', 'false');
    await expect(tags, 'Names off: no tag is drawn').toHaveCount(0);
  });
});
