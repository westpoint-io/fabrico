import { test, expect } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  clickAt,
  demoCallerAndHandler,
  expectRenderLoopAlive,
  loadDemoViaExamples,
  nubAnchor,
  pollScene,
  readScene,
  rotateHandle,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 02-round-trip.spec.ts (E2E-01 + E2E-03) - THE real-host round-trip gate, and
// the direct closure of the P17 review WR-02 masking: in v2.0 the Rust Scene
// harness drove Dock while the TS encoder could not emit it, so a green Rust
// suite hid unreachable docking. In this file the ONLY drive mechanism is real
// pointer events: page.mouse -> shipped hit-testing -> gesture controller ->
// encodeGridCommand -> real WS -> real core -> echo packet -> shipped decoder
// -> window.__fabrico.scene(). If the frontend encoder or hit-testing loses a
// command variant, this gate fails; no mock can save it.
//
// Drive rules (locked):
//   - page.mouse and getByTitle ONLY. No page.evaluate into app internals to
//     issue commands (that bypasses hit-testing, the exact WR-02 violation).
//     All oracle reads are delegated to ./support/oracle.
//   - No byte-level assertions on live packets (tick/RNG vary by design).
//   - Every wait polls a SPECIFIC model change via pollScene (Pitfall 8: the
//     flowing scene re-emits node state ~every 8 ticks, so "a packet arrived"
//     is meaningless); fixed sleeps are banned.
//
// Tests run SERIAL and share host state deliberately: Place mints the factory
// that Rotate re-stamps, DrawBelt mints the belt that Dock plugs into it. A
// failed leg skips its dependents instead of cascading confusing failures.
//
// PHASE 74.1 CHANGED WHAT THE DrawBelt LEG MINTS (UI-SPEC 3.2 item 4). With the Belt
// tool armed, the empty floor tile in front of a free Out is that port's DOORSTEP and
// a press there starts a CONNECTED draw: the belt docks its Tail to the port as soon
// as it is echoed. The DrawBelt leg presses exactly there, so it now also asserts that
// Tail dock; and the Dock leg, which needs an undocked belt to plug in by handle drag,
// first takes that dock off with the shipped panel `Disconnect` on the factory's
// Output row. Both titles are unchanged; neither leg lost an assertion.
// Suite ordering: 01-default-scene gates the COLD boot first (alphabetical
// order under one worker); this file's baseline reset lives in its own hooks
// and runs only after 01 has already gated.

test.describe.configure({ mode: 'serial' });

// Keyspaces (core wire values, mirrored from kinds.ts / the RESEARCH table).
// HANDLER (10) is here because of D-26 (plan 72-06): the demo's handler (found by kind
// since plan 85-07, `demoCallerAndHandler`) carries an electrical In at index 0 plus an
// electrical Out, and the render packet stamps that port shape kind 10. See the FACTORY
// count assertion below, ledger row LR-3.
const KIND = { FACTORY: 2, HANDLER: 10 } as const;
const ROLE = { In: 0, Out: 1, Fault: 2 } as const;
/** Side unit vectors in the core keyspace order N=0, E=1, S=2, W=3. */
const UNIT: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
/**
 * The Place drop cell. The demo occupies rows 2..8, so row 11 is
 * verified-empty space (Pitfall 10), and the 3x3 footprint anchored here
 * (rows 11..13) stays inside the 1280x720 identity-camera viewport.
 */
const PLACE_CELL = [6, 11] as const;

type NodeFacts = SceneFacts['nodes'][number];

/**
 * The round-trip factory: the kind===2 node anchored at PLACE_CELL. Cell-found
 * (Pitfall 10), never a hardcoded new handle, and robust to a demo that ships a second
 * factory-shaped machine (until D-26 its handler was one), so "not the demo factory id"
 * alone could match the wrong machine.
 */
function placedFactory(s: SceneFacts): NodeFacts {
  const placed = s.nodes.find(
    (n) =>
      n.kind === KIND.FACTORY &&
      n.cells.some((c) => c[0] === PLACE_CELL[0] && c[1] === PLACE_CELL[1]),
  );
  expect(placed, 'the placed round-trip FACTORY is present in the oracle').toBeDefined();
  return placed as NodeFacts;
}

test.describe('E2E-01/E2E-03 round trip: gestures against the REAL host, echoes via the oracle', () => {
  test.beforeAll(async ({ browser }) => {
    // Known baseline (RESEARCH Open Question 1, accepted): reset via the
    // SHIPPED Load-demo CTA so this file starts from exactly the demo
    // topology with known-empty cells to place into. The one-shot reset runs
    // on its own page (the per-test page fixture cannot host a once-per-file
    // action); the URL is the live config's pinned loopback baseURL
    // (strictPort 5173). Post-reset the scene is FLOWING (a LoadDemo
    // latched while Playing auto-resumes), which every leg below is fine with.
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
    const page = await context.newPage();
    await page.goto('/');
    await waitForAppReady(page);
    // Falsifiable reset predicate (review WR-01): the cold-boot host scene IS
    // the demo, so `nodes.length === DEMO_NODE_COUNT` would pass vacuously before the
    // click and leave the genesis swap latched to land mid-Place-test. LoadDemo
    // is a genesis swap, so the sim tick RESTARTS: capture the pre-click tick
    // (large - the host has been running since the 01 spec) and poll for the
    // tick dropping below it, which can only be true AFTER the swap keyframe
    // folds. The node-count check rides along so the reset still pins the known
    // demo baseline topology in the same poll.
    const tickBefore = (await readScene(page)).tick;
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
      message:
        'the LoadDemo genesis swap folded (sim tick restarted below the pre-click tick) onto the demo baseline',
    }).toBe(true);
    await context.close();
  });

  // RENDER HEALTH (plan 85-07, the model-oracle blind spot). Every assertion in this
  // file reads `window.__fabrico.scene()`, which keeps answering over a dead Pixi ticker,
  // so the renderer is asserted alive after EVERY test. The watcher is installed BEFORE
  // `page.goto` so an error raised during load is caught too.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the round-trip test');
    errs.assertNone('the round-trip test');
  });

  test('Place: arm-then-click round-trips a 3x3 FACTORY echo from the real core', async ({
    page,
  }) => {
    // Arm-then-click (30-05 IX-01): CLICK the Factory palette item to ARM (emits
    // nothing), CLICK the drop cell to PLACE, then Escape disarms. The arming
    // click writes NO scene state (30-03 removed the optimistic build-blue
    // persist), so the placed factory can appear ONLY once the real host echoes
    // it - this is the IX-05 end-to-end honesty proof.
    const before = (await readScene(page)).nodes.filter((n) => n.kind === KIND.FACTORY).length;
    // RE-POINTED BY PLAN 72-13, LEDGER ROW LR-3. This read `.toBe(2)` and was ARMED
    // RED by plan 72-06 as a DECLARED move, not repaired quietly.
    //
    // WHICH FACTORY LEFT THE COUNT, AND WHY. The demo shipped TWO factories at boot:
    // the belt-transform factory (handle 1) and the handler of its request/response
    // pair. D-26 gave that handler an electrical Out at index 1, and
    // `is_handler_shape` then names any `Node::Factory` with an electrical In at index
    // 0 plus an electrical Out a HANDLER, so the render packet stamps kind 10 on it.
    // It is STILL a `Node::Factory` in the core - D-11 adds no `Node` variant - so
    // nothing was deleted; only the kind byte the packet carries changed, and this
    // count is a count of what the PACKET calls a Factory.
    //
    // The belt-transform factory is the one that remains, and it is the one this test
    // is actually about: the arm-then-click echo below places a THIRD machine of that
    // kind, and the delta is what the assertion rests on.
    expect(before, 'D-26: the demo ships ONE Factory (the belt transform); its handler is now kind HANDLER').toBe(1);
    // NON-VACUITY for the sentence above: the handler did not vanish, it was renamed.
    // Without this a demo that dropped its handler entirely would satisfy the count and
    // read as the D-26 upgrade.
    expect(
      (await readScene(page)).nodes.filter((n) => n.kind === KIND.HANDLER).length,
      'and the machine that left the Factory count is present as a HANDLER, not deleted',
    ).toBe(1);
    // And it is the one the demo's caller is cabled to, found BY KIND (plan 85-07): the
    // board's Route, and the node its one cable delivers into.
    const { handler: demoHandler } = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'right after finding the demo pair by kind');
    expect(demoHandler.kind, "the demo caller's cable delivers into that HANDLER").toBe(KIND.HANDLER);

    // Arm only (no place yet) and assert arming is honest: it paints NO second
    // factory into the scene oracle (host truth), it merely puts the tool in hand.
    await page.getByRole('button', { name: 'Place Factory' }).click();
    expect(
      (await readScene(page)).nodes.filter((n) => n.kind === KIND.FACTORY).length,
      'arming the palette paints no committed factory (no false success before the echo)',
    ).toBe(before);

    // Now place: click the drop cell, then disarm.
    const drop = await screenCellCentre(page, PLACE_CELL[0], PLACE_CELL[1]);
    await page.mouse.move(drop.x, drop.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.press('Escape');

    // Echo poll: the real host echoing OUR Place grows the factory count by exactly
    // one (before + 1). A specific model change, never "a packet arrived" - and,
    // since the client never painted it, this delta IS the host echo.
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND.FACTORY).length, {
      message: 'the placed FACTORY appears ONLY on the host echo (kind-2 count grows by one)',
    }).toBe(before + 1);

    const placed = placedFactory(await readScene(page));
    expect(
      placed.cells.length,
      'the real-core echo reports the full 3x3 footprint (9 cells), never a 1x1 stub',
    ).toBe(9);
    expect(placed.cells, 'the placed factory anchors at the drop cell (6,11)').toContainEqual([
      PLACE_CELL[0],
      PLACE_CELL[1],
    ]);
    expect(
      placed.ports.map((p) => p.role).sort((a, b) => a - b),
      'the echo carries data-driven In/Out/Fault port roles',
    ).toEqual([ROLE.In, ROLE.Out, ROLE.Fault]);

    // Bonus coverage (locked Area 1 decision): the first command echo flips
    // canUndo true. The pre-command value is deliberately NOT asserted: the
    // demo edit-log may already allow undo.
    await pollScene(page, (s) => s.canUndo, {
      message: 'canUndo flips true after the Place echo (undo/redo availability bonus coverage)',
    }).toBe(true);
  });

  test('Rotate: the on-canvas rotate handle re-stamps ports[] while the footprint stays 9 cells', async ({
    page,
  }) => {
    const s = await readScene(page);
    const placed = placedFactory(s);
    const beforePorts = JSON.stringify(placed.ports);

    // Select the factory: click its anchor body cell (min-x/min-y of the
    // ORACLE-read footprint). Selection shows the outline + rotate handle.
    const minX = Math.min(...placed.cells.map((c) => c[0]));
    const minY = Math.min(...placed.cells.map((c) => c[1]));
    const anchor = await screenCellCentre(page, minX, minY);
    await clickAt(page, anchor.x, anchor.y);

    // The rotate handle pins to the selection outline's top-right corner; the
    // shared rotateHandle helper owns that anchor math (the port-gestures
    // CTRL-03 recipe; the factory is w = 3 cells wide).
    const handle = rotateHandle(minX, minY, 3);

    // Shift+click = CCW (mirrors Shift+R; same handle, same hit-test, same
    // encoder arm). CCW is viewport math, not taste: a plain-click CW rotate
    // would land the Out port on the SOUTH side (row 13 of the row-11 anchor),
    // and the DrawBelt leg along that port's facing direction would need rows
    // 15..17, outside the 1280x720 identity-camera viewport. CCW lands the Out
    // port on the NORTH side with empty in-viewport rows above it.
    const handlePt = await screenPoint(page, handle);
    await page.keyboard.down('Shift');
    await clickAt(page, handlePt.x, handlePt.y);
    await page.keyboard.up('Shift');

    // Echo poll: Rotate re-stamps ports[] on the echoed node (nub cells move).
    await pollScene(
      page,
      (sc) => JSON.stringify(sc.nodes.find((n) => n.id === placed.id)?.ports),
      { message: 'Rotate re-stamps the placed factory ports[] (nub cells move on the echo)' },
    ).not.toBe(beforePorts);

    const after = await readScene(page);
    const rotated = after.nodes.find((n) => n.id === placed.id);
    expect(
      rotated?.cells.length,
      'the re-stamped square 3x3 footprint still reports exactly 9 cells after Rotate',
    ).toBe(9);
  });

  test('DrawBelt: a belt-tool drag mints a tiled belt echoed by the real core', async ({
    page,
  }) => {
    // The factory's ports are in their post-Rotate cells now: read the Out
    // port LIVE from the oracle, never from pre-rotate constants.
    const s = await readScene(page);
    const placed = placedFactory(s);
    const out = placed.ports.find((p) => p.role === ROLE.Out);
    expect(out, 'the rotated factory exposes an Out port (role 1) to draw against').toBeDefined();
    // frontCell: the port's cell one step along its facing side.
    const [dx, dy] = UNIT[out!.side & 3];
    const front = [out!.cell_x + dx, out!.cell_y + dy] as const;
    const beforeIds = new Set(s.belts.map((b) => b.id));

    // Arm the belt tool, then draw FROM frontCell outward along the port's
    // facing direction. Draw order is load-bearing: the host dock-accept
    // predicate (ports.ts acceptsDock, the command.rs mirror) binds the TAIL
    // end (tiles[0]) to Out ports and requires the end to travel away from the
    // port, so the tile the Dock leg later grabs at frontCell must be the
    // FIRST drawn cell.
    // Prefix-matched, not exact: this Belt tool title is user-facing COPY that
    // doubles as a SELECTOR, so an exact match makes every copy edit a
    // five-spec breakage (52-05). `Draw belts` stays unique in the palette.
    await page.getByTitle(/^Draw belts/).click();
    const beltStart = await screenCellCentre(page, front[0], front[1]);
    await page.mouse.move(beltStart.x, beltStart.y);
    await page.mouse.down();
    for (let step = 1; step <= 3; step += 1) {
      const p = await screenCellCentre(page, front[0] + dx * step, front[1] + dy * step);
      await page.mouse.move(p.x, p.y);
    }
    await page.mouse.up();

    // Echo poll: the belt count grows by one (a specific model change).
    await pollScene(page, (sc) => sc.belts.length, {
      message: 'the real host echoes the drawn belt (belt count grows by one)',
    }).toBe(beforeIds.size + 1);

    const after = await readScene(page);
    const minted = after.belts.find((b) => !beforeIds.has(b.id));
    expect(
      minted,
      'the new belt is found by diffing pre/post belt ids, never a hardcoded handle',
    ).toBeDefined();
    expect(
      minted!.tiles.length,
      'DrawBelt mints tiled belts, never a tile-less belt (the v2.0 trap)',
    ).toBeGreaterThanOrEqual(1);

    // THE DRAW-TIME TAIL DOCK (74.1, UI-SPEC 3.2 item 4). The press landed on the Out
    // port's doorstep, which with the Belt tool armed is a CONNECTED start: the release
    // sends the DrawBelt and, on its echo, one Tail Dock naming that port. Polled,
    // because the Dock is a follow-on command that folds after the DrawBelt echo.
    // Pitfall 9: an Out dock echoes in the EMIT keyspace, so on this single-Out factory
    // the wire value is 0, never the catalog index 1.
    await pollScene(
      page,
      (sc) =>
        (sc.belts.find((b) => b.id === minted!.id)?.docks ?? [])
          .map((d) => `${d.end}@${d.node}:${d.port}`)
          .join(' '),
      {
        message:
          'a press on the Out doorstep is a CONNECTED draw: the minted belt carries exactly one ' +
          'Tail dock naming the placed factory on EMIT-keyspace port 0, and nothing else',
      },
    ).toBe(`Tail@${placed.id}:0`);
  });

  test('Dock: a belt-end handle drag onto the placed factory Out nub echoes a Tail dock', async ({
    page,
  }) => {
    // FIRST, UNDOCK THE DrawBelt-LEG BELT (74.1, UI-SPEC 3.2 item 4). Its press landed
    // on the Out doorstep, so it arrives Tail-docked to the factory, and this leg's
    // subject is plugging an UNDOCKED belt in by handle drag. The dock is taken off with
    // the shipped panel control a user would use, on the factory's Output row, and the
    // removal is read off the model before anything else happens.
    const pre = await readScene(page);
    const prePlaced = placedFactory(pre);
    const docked = pre.belts.find((b) =>
      b.docks.some((d) => d.end === 'Tail' && d.node === prePlaced.id),
    );
    expect(
      docked,
      'the DrawBelt-leg belt arrives Tail-docked to the placed factory (a doorstep press connects)',
    ).toBeDefined();
    const [ax, ay] = [
      Math.min(...prePlaced.cells.map((c) => c[0])),
      Math.min(...prePlaced.cells.map((c) => c[1])),
    ];
    await selectMachineAt(page, ax, ay);
    const portsRegion = page.getByRole('region', { name: 'Ports' });
    const disconnect = portsRegion.getByRole('button', { name: 'Disconnect Output - Item' });
    await expect(
      disconnect,
      'the placed factory\'s panel offers "Disconnect Output - Item" on its docked Output row',
    ).toBeEnabled();
    await disconnect.click();
    await pollScene(page, (sc) => sc.belts.find((b) => b.id === docked!.id)?.docks.length, {
      message: 'one click of the panel Disconnect took the draw-time Tail dock off the drawn belt',
    }).toBe(0);

    const s = await readScene(page);
    const placed = placedFactory(s);
    const out = placed.ports.find((p) => p.role === ROLE.Out);
    expect(out, 'the placed factory exposes an Out port (role 1) to dock onto').toBeDefined();
    const [dx, dy] = UNIT[out!.side & 3];
    const front = [out!.cell_x + dx, out!.cell_y + dy] as const;

    // The DrawBelt-leg belt: the only undocked belt on the host (all 5 demo
    // belts ship docked at both ends; the drawn belt's draw-time dock was
    // taken off by the Disconnect above).
    const drawn = s.belts.find((b) => b.docks.length === 0);
    expect(drawn, 'the drawn belt from the DrawBelt leg is present and still undocked').toBeDefined();
    const tiles = drawn!.tiles as Array<{ cell_x: number; cell_y: number }>;
    expect(tiles.length, 'the drawn belt carries its multi-cell path').toBeGreaterThanOrEqual(2);

    // The end tile nearest the factory is the one sitting on frontCell (the
    // port-facing cell), resolved from the oracle-read tiles: the belt ends
    // are tiles[0] (Tail) and tiles[last] (Head).
    const firstTile = tiles[0];
    const lastTile = tiles[tiles.length - 1];
    const endTile =
      firstTile.cell_x === front[0] && firstTile.cell_y === front[1] ? firstTile : lastTile;

    // Select the belt via a MIDDLE tile: the endpoint grab handles only exist
    // on a SELECTED belt, so this drag necessarily goes through the shipped
    // belt-end handle hit-test (the WR-02 closure is exactly this path).
    const mid = tiles[Math.floor(tiles.length / 2)];
    const midPt = await screenCellCentre(page, mid.cell_x, mid.cell_y);
    await clickAt(page, midPt.x, midPt.y);

    // Drag the end handle from the end-tile centre onto the Out nub anchor
    // (inside the 12px world-space hit radius); release emits exactly one Dock.
    const nub = nubAnchor(out!.cell_x, out!.cell_y, out!.side);
    const endPt = await screenCellCentre(page, endTile.cell_x, endTile.cell_y);
    const nubPt = await screenPoint(page, nub);
    await page.mouse.move(endPt.x, endPt.y);
    await page.mouse.down();
    await page.mouse.move(nubPt.x, nubPt.y, { steps: 4 });
    await page.mouse.up();

    // Echo poll: the drawn belt's docks[] gains an entry against the placed
    // factory with port 0. Pitfall 9: an Out dock echoes in the EMIT keyspace,
    // so the expected wire value on a single-Out factory is 0, never the
    // catalog index 1 (the host freezes the routing key at validate time).
    await pollScene(
      page,
      (sc) =>
        sc.belts
          .find((b) => b.id === drawn!.id)
          ?.docks.some((d) => d.node === placed.id && d.port === 0) ?? false,
      {
        message:
          'the real host echoes the Dock: the drawn belt docks onto the placed factory with EMIT-keyspace port 0',
      },
    ).toBe(true);

    const after = await readScene(page);
    const dock = after.belts
      .find((b) => b.id === drawn!.id)!
      .docks.find((d) => d.node === placed.id);
    expect(
      dock?.end,
      'the docked end is the Tail (the end grabbed at the port-facing tile)',
    ).toBe('Tail');
    expect(
      dock?.port,
      'the dock port rides the wire EMIT keyspace verbatim (0), never the catalog index',
    ).toBe(0);
  });
});
