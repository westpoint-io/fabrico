import { test, expect, type Page } from '@playwright/test';
import {
  captureRefusalText,
  DEMO_NODE_COUNT,
  DRAWN_STATE_FRAMES,
  armAndPlaceAt,
  cameraOf,
  clickAt,
  drawBeltThroughCells,
  drawWireBetweenPorts,
  expectRenderLoopAlive,
  handDrawWire,
  nodeAtAnchor,
  outwardStep,
  pollScene,
  readScene,
  resetToDemo,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  type PortFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import { nubAnchor } from '../shared/geometry';

// 18-refusal.spec.ts (ERR-01) - the live gate for phase 64's refusal path.
//
// This file grew in three waves and is now COMPLETE: 64-01 laid the geometry
// precondition, 64-06 added the tracer leg (a real refusal message reaching the
// DOM), and 64-11 added the remaining two legs plus the distinctness assertion.
// Together they are ROADMAP criterion 3b - three refusals a user can actually
// reach today, each saying a DIFFERENT thing, against a real Rust host.
//
// The first test below is the GEOMETRY PRECONDITION the MediumMismatch leg stands
// on: the exact draw that provokes that verdict, asserted cell by cell so a
// demo-scene change fails HERE rather than draining a refusal leg of its subject.
//
// WHY THE SOURCE PORT IS A PLACED ROUTE'S AND NOT (6,3).
// Two older planning documents write the recipe as "draw from node 1's Out at
// (6,3)". That recipe cannot run, and re-proposing it wastes a wave:
//   - (6,3)'s facing cell is (7,3), which is already belt 10's first tile.
//   - `evalBeltPath` is the ONE ghost suppression phase 64 deliberately KEEPS
//     (decision D-09). It paints an overlapping path red and refuses to commit,
//     so the draw never even starts and no dock is ever attempted.
// THE RECIPE BRINGS ITS OWN MACHINES (plan 85-07, D-19). Until 85-07 it used the demo's
// caller and handler pair on row 6; phase 85 rebuilds that part of the demo, and a test
// must never hold the demo in a shape only so the test can pass. So the leg places the
// pair a user would, from the palette, on floor clear of the demo board:
//   - a Route at OWN_CALLER_ANCHOR (2,10), whose ELECTRICAL Out faces E;
//   - an HTTP Handler at OWN_HANDLER_ANCHOR (6,9), 3x3, whose ELECTRICAL In sits at
//     (6,10) facing W, on the Route's row.
// A belt is Mechanical, so docking either end is a medium mismatch (PORT-08) -
// which is exactly the refusal the later legs want - while the PATH itself,
// (3,10) (4,10) (5,10), is unobstructed and legal (asserted free from the live scene).
//
// WHAT THAT FIRST TEST DOES NOT ASSERT.
// Nothing about a refusal message. It proves only that the DRAW is legal and
// lands precisely where the recipe says it does - RESEARCH assumption A1,
// discharged by execution rather than by argument. The message that draw now
// provokes is asserted by its own test further down, so a failure tells you
// WHICH half broke: the geometry, or the verdict reaching the user.
//
// THE INVALIDDOCK LEG WAS RE-AUTHORED BY PLAN 74-14, AND THE OLD NAMES ARE RECORDED
// HERE so a reader who greps the old wording finds the record rather than a hole.
//   was: describe 'ERR-01: a belt released short of the port it aimed at says so'
//   was: test     'a Head dock whose path never reaches the facing cell paints the
//                  InvalidDock sentence and self-dismisses'
// WHY. That fixture obtained its refusal from a DEFECT in the belt accumulator rather
// than from the host: it authored a run ending two cells short of the target's facing
// cell and relied on the release-time move into the destination nub being DROPPED as a
// non-adjacent jump. 74-14 makes the accumulator walk the cells a sample crossed, so
// that move now lands, the swept cell (17,2) is occupied by demo belt 14, the path
// paints red and NOTHING commits - and the leg would fail on a belt that never
// appeared rather than on a refusal. A green that depends on a bug is not evidence
// about the host.
// The re-authored leg drives the host's FACING check instead, on a two-tile belt that
// commits cleanly on free floor. Its exact-tiles assertion and its tripwire are KEPT,
// with new values, and the tripwire now guards the tile COUNT and the tail's
// DIRECTION, which are the two things that decide the new refusal.
//
// RE-AUTHORED AGAIN BY PLAN 74.1-02, and the 74-14 names are recorded here for the
// same reason:
//   was: describe 'ERR-01: a belt whose tail leaves its port sideways says so'
//   was: test     'a Tail dock the host refuses on FACING paints the InvalidDock
//                  sentence and self-dismisses'
// WHY. Phase 74.1 narrowed the host's facing clause to `oside == mside` (CORNER-06): a
// carrier is refused only when it points INTO the port, so a Tail that leaves an Out
// sideways is now a LEGAL corner. The 74-14 recipe (Tail leaving ROUTER port 3 north)
// is precisely the 74.1 tracer leg's gesture, which docks. The leg now takes the ROLE
// check instead, which the narrowing left untouched: see the geometry block below.
//
// Shared-host note: the live suite runs workers:1 against ONE mutable dev host,
// so this spec resets to the demo baseline at its start (`DEMO_NODE_COUNT`, the
// demo's node count, comes from the oracle, read off demo_scene.ron; plan 85-08).

/** The Route the MediumMismatch legs place from the palette: the belt's source. */
const OWN_CALLER_ANCHOR = [2, 10] as const;
/** The HTTP Handler they place (3x3, (6..8, 9..11)): its electrical In is the belt's target. */
const OWN_HANDLER_ANCHOR = [6, 9] as const;

/**
 * The full authored belt run: the source port's facing cell through to the
 * destination port's facing cell, which is what `drawBeltThroughCells` requires.
 */
const BELT_CELLS = [
  [3, 10],
  [4, 10],
  [5, 10],
] as const;

/**
 * The cell the tracer clicks: belt 10's FIRST tile in the demo scene
 * (`demo_scene.ron`, `DrawBelt(cells: [(7, 3), (8, 3)])`, the factory -> tee run).
 *
 * A belt tile is in the host's occupancy index exactly like a machine footprint cell
 * (BELT-06), so a `Place` anchored here is refused with `FootprintCollision` - the
 * tightest row in the copy table at 49 characters against a 50-character budget, which
 * is why the tracer exercises the wrap budget's worst single-line case on day one.
 */
const OCCUPIED_BELT_CELL = [7, 3] as const;

/** The exact `REFUSAL_COPY.FootprintCollision` sentence, transcribed not imported. */
const FOOTPRINT_COLLISION_COPY = 'That space is taken. Clear it or try elsewhere.';

/** The exact `REFUSAL_COPY.MediumMismatch` sentence, transcribed not imported. */
const MEDIUM_MISMATCH_COPY = 'Belts and wires use different ports.';

/** The exact `REFUSAL_COPY.IncompatiblePorts` sentence, transcribed not imported.
 *  This is the sentence `WINDOWS` row 82 is actually about. */
const INCOMPATIBLE_PORTS_COPY = 'A wire connects two machines, output to input.';

/**
 * The exact `REFUSAL_COPY.InvalidDock` sentence, transcribed not imported.
 *
 * At 57 characters this is the LONGEST row in the copy table and a deliberate two-line
 * case (64-UI-SPEC's wrap budget). Since plan 74.1-10 (review WR-03) it names the rule
 * the narrowed host enforces, the role and the doorstep adjacency; the old `on facing
 * sides` clause went because the host accepts a belt that turns at the doorstep. Its rendered wrap is measured in the mock
 * suite - `frontend/e2e/gesture-verdict.spec.ts` - because the measurement needs a
 * loaded font and a settled box, not a real host.
 */
const INVALID_DOCK_COPY = 'A belt runs from an output to an input, right next to it.';

// ---------------------------------------------------------------------------
// THE `InvalidDock` GEOMETRY (plan 64-11; recipe re-authored by plan 74.1-02)
// ---------------------------------------------------------------------------
//
// WHY THIS LEG CANNOT REUSE THE ROUTE AND HANDLER PORTS. The host's dock check order is
// ROLE -> medium -> adjacency -> facing (`fabrico-command/src/command.rs`, the Dock
// arm), so any belt aimed at an ELECTRICAL port is refused on the medium and never
// reaches anything after it. An `InvalidDock` therefore needs a MECHANICAL port.
//
// THE REFUSAL THIS LEG TAKES IS THE ROLE CHECK, ON THE HEAD, and it is the FIRST rule
// the host judges, so nothing after it can be what answers. `command.rs`'s role arm:
//
//     let role_ok = match core_end {
//         BeltEnd::Head => mport.role == Role::In,
//         BeltEnd::Tail => matches!(mport.role, Role::Out | Role::Fault),
//     };
//     if !role_ok { return Err(CommandError::InvalidDock); }
//
// A belt's HEAD delivers, so it may only dock an In. Docking it onto an Out is refused
// before medium, adjacency or facing is read.
//
// WHY A HANDLE DRAG, NOT A DRAW. A Belt-armed draw cannot address an Out with its HEAD:
// a release ranks In ports only, and a press on an Out's doorstep docks the TAIL, which
// is legal. A SELECTED belt's end-handle drag is the gesture that can: its release
// addresses the nearest REACHABLE nub whether or not it accepts (`gestures.ts`
// `updateDropCandidate`: the acceptance predicate ranks, it never gates, Phase 64 D-07),
// emits one Dock naming it, and lets the host answer in words.
//
// THE RECIPE BRINGS ITS OWN ROUTER (plan 85-07, D-19). Until 85-07 it dropped the handle
// on the DEMO Router's free Out (catalog port 3 at (15,0)); phase 85's demo docks every
// Router output, so no demo Out is free and a test must not keep one free for itself. The
// leg places a Router from the palette at OWN_ROUTER_ANCHOR (20,9), on floor clear
// of the demo board, and uses ITS free Out. The geometry is the one the demo recipe proved,
// carried relative to the machine:
//   - THE DROP PORT is found from the placed Router's ports, never by an index: the
//     TOPMOST Out that is Mechanical and has no belt docked to it, the place catalog port 3
//     held on the demo Router. The tripwire below pins it: a Mechanical Out on the
//     Router's east column, top row, facing E, so at (21,9).
//   - A two-tile belt drawn WEST on free floor: the cell two steps out of that Out, then
//     its doorstep, so (23,9) then (22,9). Neither cell is a belt tile or a machine cell,
//     and the PRESS cell (23,9) is the doorstep of no Out, Fault or belt Head on the board
//     (asserted from the live scene below), so the press is a PLAIN draw: no Tail dock is
//     recorded and the belt commits undocked. The release on (22,9) arms no auto-dock
//     either: that cell is an OUT's doorstep, and the release-time auto-dock offers a
//     Head only an In.
//   - FIRST, the camera is panned by a floor drag. MEASURED 2026-10-02 on the real host:
//     at the demo's fit-to-content camera the selected belt's config panel
//     (`#fab-belt-config`, 420 px wide, top right) covered the Router nub and the head
//     handle, so the handle press landed on the panel's pace field and no drag started at
//     all - the refusal region then stays EMPTY, which reads exactly like a host that
//     stopped refusing. The pan is DERIVED (85-07): it moves the Out's doorstep to
//     RECIPE_SCREEN_POINT, left of the panel and right of the palette, wherever the board
//     put the Router, and both drag points are asserted to be on the CANVAS. The floor
//     pressed for the pan is the cell just past the press cell, asserted bare.
//   - Escape, then click the press cell to select the belt. Its HEAD grab handle is at the
//     doorstep tile centre.
//   - Drag that handle onto the Out's nub. Release there.
//   - Host verdict, check by check: ROLE FAILS (a Head dock needs an In, the drop port is
//     an Out). Every LATER check would PASS, by construction, and that is what makes ROLE
//     the only rule able to answer: medium (both Mechanical), adjacency (the head end cell
//     IS the Out's doorstep), facing (the head's outward is W, the Out faces E, and the
//     narrowed clause refuses only outward == side). A recipe whose head sat anywhere else
//     would ALSO be refused on adjacency, so a host that lost its role check would still
//     print this sentence and the leg could not tell. The tripwire below asserts both
//     geometric facts.
//
// THE NAMED FALLBACK (not taken; recorded so the next re-author does not re-derive it):
// the same Head handle dropped on a free Mechanical In nub of a Balancer the leg places
// from the palette, beside the Router so a two-tile belt does not reach that In, so the
// host refuses on ADJACENCY instead.
//
// IMMUNE TO INTERPOLATION BY CONSTRUCTION: the drawn path is two orthogonally adjacent
// cell centres, and the handle drag adds no tile to the belt at all.
const OWN_ROUTER_ANCHOR = [20, 9] as const;
/**
 * Where the pan puts the drop Out's doorstep on screen, in CSS px: left of the 420 px belt
 * config panel at the top right, right of the palette, below the toolbar.
 */
const RECIPE_SCREEN_POINT = { x: 520, y: 400 } as const;

/**
 * The doorstep cells on a board: the cell in front of every machine Out or Fault port
 * and every belt Head, i.e. every cell a Belt-armed press would resolve as a CONNECTED
 * start (74.1, UI-SPEC 3.2 item 4). Computed from the live scene, with the side
 * convention `PortFacts` documents (N=0, E=1, S=2, W=3), so a demo-board change that put
 * a doorstep under the authored run fails on its own message rather than turning the
 * plain draw into a docked one.
 */
function doorstepCells(scene: Awaited<ReturnType<typeof readScene>>): string[] {
  const step = (side: number): [number, number] =>
    [[0, -1], [1, 0], [0, 1], [-1, 0]][side & 3] as [number, number];
  const out: string[] = [];
  for (const n of scene.nodes) {
    for (const p of n.ports) {
      if (p.role === 1 || p.role === 2) {
        const [dx, dy] = step(p.side);
        out.push(`${p.cell_x + dx},${p.cell_y + dy}`);
      }
    }
  }
  for (const b of scene.belts) {
    if (b.tiles.length < 2) continue;
    const head = b.tiles[b.tiles.length - 1];
    const prev = b.tiles[b.tiles.length - 2];
    out.push(`${2 * head.cell_x - prev.cell_x},${2 * head.cell_y - prev.cell_y}`);
  }
  return out;
}

/**
 * Poll the live refusal region's text. The element carries no role and no accessible
 * name by design (a div with `aria-live` and no role adds +0 to every page-wide status
 * and alert locator already shipped), so its id is the only handle - the
 * `#fab-legend-panel` precedent. The 15s / 100-250-500 ladder is
 * `15-disconnected.spec.ts`'s transient-copy oracle verbatim, swapping the status role
 * locator for the id.
 */
function pollRefusalText(page: Page, message: string) {
  return expect.poll(
    async () => ((await page.locator('#fab-refusal').textContent()) ?? '').trim(),
    { timeout: 15_000, intervals: [100, 250, 500], message },
  );
}

/** The mandatory live-suite preamble, in the one place all five tests share it. */
async function bootOnDemo(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  return errs;
}

/** True when (cx, cy) holds no machine cell and no belt tile on `scene`. */
function isBareFloor(scene: Awaited<ReturnType<typeof readScene>>, cx: number, cy: number): boolean {
  return (
    !scene.nodes.some((n) => n.cells.some(([nx, ny]) => nx === cx && ny === cy)) &&
    !scene.belts.some((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy))
  );
}

/**
 * Assert `anchor` is bare floor before a leg places its own machine there (D-19: a leg that
 * needs a free nub brings its own machine), so a later demo layout that covers it fails
 * HERE, by name.
 */
async function expectBareAnchor(page: Page, paletteName: string, anchor: readonly [number, number]): Promise<void> {
  const [cx, cy] = anchor;
  expect(
    isBareFloor(await readScene(page), cx, cy),
    `(${cx},${cy}) is bare floor, so the ${paletteName} this leg places lands there`,
  ).toBe(true);
}

/**
 * After a leg's own palette placement at `anchor`: wait for the host to fold it, settle the
 * camera, and prove the renderer survived the new placement before any leg reads the
 * machine. Returns the placed machine.
 */
async function ownMachineFolded(
  page: Page,
  paletteName: string,
  anchor: readonly [number, number],
): Promise<Awaited<ReturnType<typeof readScene>>['nodes'][number]> {
  const [cx, cy] = anchor;
  await pollScene(page, (s) => nodeAtAnchor(s, cx, cy) !== undefined, {
    message: `the hand-placed ${paletteName} folded on the real host`,
  }).toBe(true);
  // The board just grew. Settle the camera before any world-to-screen projection.
  await waitForCameraSettle(page);
  await expectRenderLoopAlive(page, `right after placing the leg's own ${paletteName}`);
  return nodeAtAnchor(await readScene(page), cx, cy)!;
}

/**
 * Place the MediumMismatch pair (a Route and an HTTP Handler) and return the Route's
 * ELECTRICAL Out and the Handler's ELECTRICAL In, each found by role and medium.
 */
async function placeOwnPair(page: Page): Promise<{ from: PortFacts; to: PortFacts }> {
  const before = await readScene(page);
  for (const [cx, cy] of BELT_CELLS) {
    expect(isBareFloor(before, cx, cy), `(${cx},${cy}) is bare floor, so the authored run is drawable`).toBe(true);
  }
  await expectBareAnchor(page, 'Route', OWN_CALLER_ANCHOR);
  await armAndPlaceAt(page, 'Route', OWN_CALLER_ANCHOR[0], OWN_CALLER_ANCHOR[1]);
  const source = await ownMachineFolded(page, 'Route', OWN_CALLER_ANCHOR);
  await expectBareAnchor(page, 'HTTP Handler', OWN_HANDLER_ANCHOR);
  await armAndPlaceAt(page, 'HTTP Handler', OWN_HANDLER_ANCHOR[0], OWN_HANDLER_ANCHOR[1]);
  const target = await ownMachineFolded(page, 'HTTP Handler', OWN_HANDLER_ANCHOR);
  const from = source.ports.find((p) => p.role === 1 && p.medium === 1);
  const to = target.ports.find((p) => p.role === 0 && p.medium === 1);
  expect(from, 'the placed Route carries an ELECTRICAL Out').toBeDefined();
  expect(to, 'the placed HTTP Handler carries an ELECTRICAL In').toBeDefined();
  return { from: from!, to: to! };
}

/**
 * Drive the `MediumMismatch` refusal: a Mechanical belt drawn between the ELECTRICAL Out of
 * a Route and the ELECTRICAL In of an HTTP Handler, both placed by this leg. Returns the
 * belt count observed before the draw so a caller can assert the draw itself committed.
 */
async function driveMediumMismatch(page: Page): Promise<number> {
  const { from, to } = await placeOwnPair(page);
  const before = await readScene(page);
  expect(from.medium, 'the caller port is Electrical, so a Mechanical belt cannot dock it').toBe(1);
  expect(to.medium, 'and so is the handler port').toBe(1);
  await drawBeltThroughCells(page, from, BELT_CELLS, to);
  return before.belts.length;
}

/**
 * The free Mechanical Out the InvalidDock recipe drops on, found from the placed Router's
 * ports rather than by an index: an Out, Mechanical, with no belt docked to it, and of
 * those the TOPMOST (the place catalog port 3 held on the demo Router). A Tail dock's wire
 * `port` is the Out ROUTING key, the port's index among the node's role-1 ports.
 */
function freeTopMechanicalOut(
  scene: Awaited<ReturnType<typeof readScene>>,
  router: Awaited<ReturnType<typeof readScene>>['nodes'][number],
): PortFacts | undefined {
  const outs = router.ports.filter((p) => p.role === 1);
  const docked = (p: PortFacts) =>
    scene.belts.some((b) =>
      (b.docks ?? []).some((d) => d.end === 'Tail' && d.node === router.id && d.port === outs.indexOf(p)),
    );
  return outs
    .filter((p) => p.medium === 0 && !docked(p))
    .reduce<PortFacts | undefined>((top, p) => (top === undefined || p.cell_y < top.cell_y ? p : top), undefined);
}

/**
 * Drive the `InvalidDock` refusal: a Router placed by this leg (D-19), a plain
 * two-tile belt drawn on free floor in front of its free Out, selected, and its HEAD handle
 * dropped on that Mechanical OUT nub, so the host refuses on ROLE. Returns the pre-draw belt
 * count and the two authored cells, Tail first.
 */
async function driveInvalidDock(
  page: Page,
): Promise<{ beltsBefore: number; cells: [[number, number], [number, number]] }> {
  await expectBareAnchor(page, 'Router', OWN_ROUTER_ANCHOR);
  await armAndPlaceAt(page, 'Router', OWN_ROUTER_ANCHOR[0], OWN_ROUTER_ANCHOR[1]);
  const router = await ownMachineFolded(page, 'Router', OWN_ROUTER_ANCHOR);
  const before = await readScene(page);
  const to = freeTopMechanicalOut(before, router);
  expect(to, 'the placed Router has a free Mechanical Out to drop on').toBeDefined();
  // THE TRIPWIRE, and it guards the one thing that decides the refusal. The leg's whole
  // meaning is that ROLE answers: the drop port must be an OUT (role 1), so a Head dock
  // onto it fails the FIRST check. It must also be MECHANICAL (medium 0): an electrical
  // port would still be refused on role first, but a catalog change that put an In there
  // would make the dock LEGAL-by-role and hand the verdict to the medium or the geometry -
  // a different refusal, or none, wearing this name. And it pins WHERE: the Router's east
  // column, top row, facing E, the place the demo recipe proved.
  const [rx, ry] = OWN_ROUTER_ANCHOR;
  expect(
    [to!.cell_x, to!.cell_y, to!.side, to!.role, to!.medium],
    `the placed ROUTER's free top Out is a Mechanical Out at (${rx + 1},${ry}) facing E`,
  ).toEqual([rx + 1, ry, 1, 1, 0]);
  // The authored run, derived from that port: the cell two steps out of it (the PRESS),
  // then its doorstep (the HEAD), so the belt runs back toward the Out.
  const [sx, sy] = outwardStep(to!.side);
  const cells: [[number, number], [number, number]] = [
    [to!.cell_x + 2 * sx, to!.cell_y + 2 * sy],
    [to!.cell_x + sx, to!.cell_y + sy],
  ];
  // ROLE IS THE ONLY RULE LEFT TO ANSWER, asserted from the geometry rather than argued.
  // The head end cell is the Out's doorstep (the host's ADJACENCY passes), and the head's
  // outward step (head minus the tile before it) is NOT the port's own side (the narrowed
  // FACING clause, `oside == mside`, passes). With medium also passing, a host that
  // accepted a Head onto an Out would DOCK this belt, and the no-dock read below fails.
  const [hx, hy] = cells[1];
  const [px, py] = cells[0];
  expect(
    [to!.cell_x + 1, to!.cell_y],
    `the head end cell (${hx},${hy}) is the Out's doorstep (an E-facing port at (${to!.cell_x},${to!.cell_y})): adjacency passes`,
  ).toEqual([hx, hy]);
  expect(
    [hx - px, hy - py],
    'the head arrives from the EAST, outward W, which is not the port\'s side E: facing passes',
  ).toEqual([-1, 0]);
  // BOTH authored cells asserted FREE, and the PRESS cell asserted to be NO DOORSTEP,
  // from the live scene, by name. An occupied cell would make the draw illegal (commits
  // nothing, says nothing); a press on a doorstep would be a CONNECTED start (74.1,
  // UI-SPEC 3.2 item 4) and the belt would arrive already docked. Either way the leg
  // would fail on the wrong thing, so a board change must fail HERE.
  const doors = doorstepCells(before);
  expect(
    doors.includes(`${px},${py}`),
    `the press cell (${px},${py}) is no Out, Fault or belt-Head doorstep, so the press is a PLAIN draw`,
  ).toBe(false);
  for (const [cx, cy] of cells) {
    expect(
      before.belts.some((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy)),
      `(${cx},${cy}) carries no belt, so the authored run is drawable`,
    ).toBe(false);
    expect(
      before.nodes.some((n) => n.cells.some(([nx, ny]) => nx === cx && ny === cy)),
      `(${cx},${cy}) is outside every machine footprint`,
    ).toBe(false);
  }

  // THE PAN (see the recipe above for why). A press on bare floor with no tool armed
  // deselects and pans; every caller arrives here disarmed (each helper ends on Escape).
  // The floor pressed is the cell just past the press cell, and the drag is DERIVED: it
  // carries the Out's doorstep to RECIPE_SCREEN_POINT.
  const panFloor: [number, number] = [px + sx, py + sy];
  expect(
    before.nodes.some((n) => n.cells.some(([nx, ny]) => nx === panFloor[0] && ny === panFloor[1])) ||
      before.belts.some((b) =>
        b.tiles.some((t) => t.cell_x === panFloor[0] && t.cell_y === panFloor[1]),
      ),
    `(${panFloor[0]},${panFloor[1]}) is bare floor, so pressing it pans rather than selects`,
  ).toBe(false);
  const floor = await screenCellCentre(page, panFloor[0], panFloor[1]);
  const doorstepNow = await screenCellCentre(page, hx, hy);
  const panBy = { dx: RECIPE_SCREEN_POINT.x - doorstepNow.x, dy: RECIPE_SCREEN_POINT.y - doorstepNow.y };
  await page.mouse.move(floor.x, floor.y);
  await page.mouse.down();
  await page.mouse.move(floor.x + panBy.dx, floor.y + panBy.dy, { steps: 10 });
  await page.mouse.up();
  // Settled when two camera reads 180 ms apart agree; every screen point below is taken
  // after this, from the moved camera.
  let last = '';
  await expect
    .poll(
      async () => {
        const c = await cameraOf(page);
        const now = `${c.x},${c.y},${c.scale}`;
        const still = now === last;
        last = now;
        return still;
      },
      { timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'camera stilled after the floor-drag pan poll'), intervals: [180], message: 'the camera stilled after the floor-drag pan' },
    )
    .toBe(true);

  // The plain draw. Prefix-matched title: the Belt tool title is user-facing COPY that
  // doubles as a SELECTOR, so an exact match makes every copy edit a multi-spec breakage
  // (52-05). One orthogonal step, so the committed tiles are exactly the authored two.
  await page.getByTitle(/^Draw belts/).click();
  const first = await screenCellCentre(page, px, py);
  const head = await screenCellCentre(page, hx, hy);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(head.x, head.y);
  await page.mouse.up();
  // Disarm so the next click SELECTS instead of starting another draw. The press landed
  // on the non-focusable canvas, so focus is on <body> and the LW-02 button-focus guard
  // does not stand Escape down.
  await page.keyboard.press('Escape');
  await pollScene(page, (s) => s.belts.length, {
    message: 'the plain two-tile draw committed before the handle drag',
  }).toBe(before.belts.length + 1);

  // THE PRE-STATE: the belt arrived UNDOCKED, so the Dock below is the only one this leg
  // asks for, and a refusal is the host's answer to THAT Dock.
  const drawn = (await readScene(page)).belts.find((b) =>
    b.tiles.some((t) => t.cell_x === px && t.cell_y === py),
  );
  expect(drawn, `a belt covers (${px},${py})`).toBeTruthy();
  expect(drawn!.docks ?? [], 'the plain draw left the belt with NO dock at either end').toHaveLength(0);

  // Select it (a click on its TAIL tile, before any handle is painted), then drag its
  // HEAD handle, at the head tile centre, onto the Out's nub. `steps` gives the drag
  // intermediate samples, so the drop candidate is the one under the final sample. The
  // two tile points are re-read from the camera rather than reused from the draw.
  const tail = await screenCellCentre(page, px, py);
  const grab = await screenCellCentre(page, hx, hy);
  await clickAt(page, tail.x, tail.y);
  await expect(
    page.locator('#fab-belt-config'),
    'clicking the tail tile selected the belt, so its end handles are live',
  ).toBeVisible({ timeout: 15_000 });
  const nub = await screenPoint(page, nubAnchor(to!.cell_x, to!.cell_y, to!.side));
  // BOTH ENDS OF THE DRAG ARE ON THE CANVAS, asserted rather than assumed: a press that
  // lands on the open config panel starts no drag, emits no Dock, and leaves the refusal
  // region empty for a reason that has nothing to do with the host.
  const onCanvas = (pt: { x: number; y: number }) =>
    page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'none', [pt.x, pt.y]);
  expect(await onCanvas(grab), 'the head grab handle is on the canvas, not under a panel').toBe(
    'CANVAS',
  );
  expect(await onCanvas(nub), 'the ROUTER Out nub is on the canvas, not under a panel').toBe(
    'CANVAS',
  );
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(nub.x, nub.y, { steps: 6 });
  await page.mouse.up();
  return { beltsBefore: before.belts.length, cells };
}

test.describe('ERR-01 refusal path: the MediumMismatch draw geometry', () => {
  test("a Mechanical belt draws cleanly between a placed Route and a placed HTTP Handler, (3,10) to (5,10)", async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);

    for (const [cx, cy] of BELT_CELLS) {
      expect(
        isBareFloor(await readScene(page), cx, cy),
        `(${cx},${cy}) is bare floor on the demo, so the authored run is drawable`,
      ).toBe(true);
    }
    await expectBareAnchor(page, 'Route', OWN_CALLER_ANCHOR);
    await armAndPlaceAt(page, 'Route', OWN_CALLER_ANCHOR[0], OWN_CALLER_ANCHOR[1]);
    const source = await ownMachineFolded(page, 'Route', OWN_CALLER_ANCHOR);
    await expectBareAnchor(page, 'HTTP Handler', OWN_HANDLER_ANCHOR);
    await armAndPlaceAt(page, 'HTTP Handler', OWN_HANDLER_ANCHOR[0], OWN_HANDLER_ANCHOR[1]);
    const target = await ownMachineFolded(page, 'HTTP Handler', OWN_HANDLER_ANCHOR);
    const before = await readScene(page);
    const beltsBefore = before.belts.length;
    expect(source, `the placed Route is anchored at (${OWN_CALLER_ANCHOR[0]},${OWN_CALLER_ANCHOR[1]})`).toBeTruthy();
    expect(target, `the placed HTTP Handler is anchored at (${OWN_HANDLER_ANCHOR[0]},${OWN_HANDLER_ANCHOR[1]})`).toBeTruthy();

    // The PORT COUNTS are pinned: a machine that grew a port would change which nub the
    // release ranker resolves, and the refusal legs further down this file depend on that.
    // A palette Route carries an electrical In and an electrical Out on its one cell; a
    // palette HTTP Handler carries an electrical In, an electrical Out and a Mechanical
    // Fault. Both ports this leg uses are selected BY ROLE AND MEDIUM, never by an index.
    // (Until 85-07 this leg read the demo's caller, which carried ONE port, and its handler,
    // which carried TWO since D-26.)
    expect(source.ports.length, 'the placed Route exposes exactly two ports').toBe(2);
    expect(
      target.ports.length,
      'the placed HTTP Handler exposes exactly THREE ports: an electrical In, an electrical Out and a Fault',
    ).toBe(3);
    const callerOuts = source.ports.filter((p) => p.role === 1 && p.medium === 1);
    expect(callerOuts.length, 'the Route carries exactly one electrical Out').toBe(1);
    const fromPort: PortFacts = callerOuts[0];
    const handlerIns = target.ports.filter((p) => p.role === 0);
    expect(handlerIns.length, 'the handler carries exactly one In port').toBe(1);
    const toPort: PortFacts = handlerIns[0];

    expect(
      [fromPort.cell_x, fromPort.cell_y, fromPort.role],
      'the caller port is an Out (role 1) at (2,10)',
    ).toEqual([2, 10, 1]);
    expect(
      [toPort.cell_x, toPort.cell_y, toPort.role],
      'the handler port is an In (role 0) at (6,10)',
    ).toEqual([6, 10, 0]);
    // Both ports are ELECTRICAL (medium 1); a belt is Mechanical. This is the
    // mismatch the later refusal legs provoke - recorded here so a catalog change
    // that quietly makes these Mechanical fails HERE, in the file that depends on
    // them, rather than silently draining the refusal legs of their subject.
    expect(fromPort.medium, 'the caller port is Electrical (medium 1)').toBe(1);
    expect(toPort.medium, 'the handler port is Electrical (medium 1)').toBe(1);

    await drawBeltThroughCells(page, fromPort, BELT_CELLS, toPort);

    await pollScene(page, (s) => s.belts.length, {
      message: 'the drawn belt committed on the host (belt count grew by exactly one)',
    }).toBe(beltsBefore + 1);

    const after = await readScene(page);
    const knownBefore = new Set(before.belts.map((b) => b.id));
    const drawn = after.belts.filter((b) => !knownBefore.has(b.id));
    expect(drawn.length, 'exactly one NEW belt handle exists after the draw').toBe(1);

    expect(
      drawn[0].tiles.map((t) => [t.cell_x, t.cell_y]),
      'the drawn belt occupies exactly (3,10) (4,10) (5,10), in path order',
    ).toEqual([
      [3, 10],
      [4, 10],
      [5, 10],
    ]);

    await expectRenderLoopAlive(page, 'after the MediumMismatch-recipe belt draw');
    errs.assertNone('the MediumMismatch-recipe belt draw');
  });
});

// ---------------------------------------------------------------------------
// THE TRACER (plan 64-06)
// ---------------------------------------------------------------------------
//
// The thinnest honest path through EVERY layer this phase builds, driven against a real
// Rust host rather than an injected packet: a real pointer Place onto an occupied cell
// -> `apply_gesture` -> the gesture envelope's reply seam -> the paired counter ->
// the refusal frame on the TEXT relay -> the frontend resolver -> the verdict sink ->
// the App-level `showRefusal` -> the always-mounted live region -> the 4000ms hold ->
// and out again.
//
// IT CLOSES A SHIPPED BUG, which is why the green here is a real fix rather than a
// plumbing demonstration. Until this wave, a Place onto a belt tile did all three wrong
// things at once: the ghost painted valid-blue over the belt (the client's occupancy
// predicate counted nodes but not belt tiles, fixed in plan 64-03), the click then
// returned early and emitted nothing at all, and no message appeared. The user clicked,
// nothing happened, and nothing said why.
test.describe('ERR-01 tracer: a refused Place says why, then takes itself away', () => {
  test('a Place onto an occupied belt tile paints the FootprintCollision sentence and self-dismisses', async ({
    page,
  }) => {
    // The preamble is MANDATORY, not optional: the live suite runs at one worker
    // against ONE shared mutable host, so a prior spec's board is whatever this test
    // would otherwise inherit. The 11 is the demo baseline - 9 belt-demo machines plus
    // its caller and handler pair.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);

    // State 1: the live region is present and EMPTY before any gesture. An
    // `aria-live` region that mounts together with its content is unreliably
    // announced, so it is mounted from boot and renders nothing when idle - which
    // means "no message" is an EMPTY region, never an absent element.
    await expect(page.locator('#fab-refusal'), 'the live region is mounted at rest').toHaveCount(1);
    expect(
      ((await page.locator('#fab-refusal').textContent()) ?? '').trim(),
      'the live region is silent before any gesture',
    ).toBe('');

    const before = await readScene(page);
    const nodesBefore = before.nodes.length;
    const [cx, cy] = OCCUPIED_BELT_CELL;
    expect(
      before.belts.some((b) => b.tiles.some((t) => t.cell_x === cx && t.cell_y === cy)),
      'the target cell really is occupied by a demo belt tile',
    ).toBe(true);

    // A real arm-then-click Place through the shipped palette, no injected command.
    await armAndPlaceAt(page, 'Source', cx, cy);

    // The refusal reaches the DOM as the exact authored sentence - not a host
    // `Display` string, not a generic fallback, not a raw tag name.
    await pollRefusalText(page, 'the refused Place named its reason in the live region').toBe(
      FOOTPRINT_COLLISION_COPY,
    );

    // Nothing was placed: the host refused, and the client never wrote the scene.
    expect(
      (await readScene(page)).nodes.length,
      'the refused Place added no machine (no optimistic local write)',
    ).toBe(nodesBefore);

    // State 5: the hold expires on a plain wall clock and the box unmounts, leaving
    // the region mounted and empty. Polled rather than asserted after a fixed sleep,
    // and proved rather than assumed - a message that appears and never leaves is a
    // different defect from one that never appears.
    await pollRefusalText(page, 'the refusal took itself away after its 4000ms hold').toBe('');

    // NOT OPTIONAL, EITHER OF THEM. A DOM-text assertion alone passes against a
    // completely dead renderer, and only a handful of the live specs opt into this
    // check today.
    await expectRenderLoopAlive(page, 'after the refused Place');
    errs.assertNone('the refused Place onto an occupied belt tile');
  });
});

// ---------------------------------------------------------------------------
// THE REMAINING TWO LEGS, AND THE ASSERTION THAT TIES THEM TOGETHER (plan 64-11)
// ---------------------------------------------------------------------------
//
// ROADMAP criterion 3b names THREE refusals a user can actually reach today, and it
// names three deliberately. The tracer above proved the path exists; these two prove
// the path carries DIFFERENT information depending on what the host objected to.
//
// All three legs are reachable only because plan 64-08 removed the five frontend
// suppression gates. Before that wave the client answered on the host's behalf - a
// Place onto an occupied cell returned early, a Head dock onto a wire nub was never
// recorded - so the host was never asked and these messages could not exist at all.

test.describe('ERR-01: a Mechanical belt aimed at an Electrical port says so', () => {
  test('a belt drawn between a placed Route and HTTP Handler paints the MediumMismatch sentence and self-dismisses', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);

    const beltsBefore = await driveMediumMismatch(page);

    // The DRAW is legal and commits; it is the DOCK the host refuses. Asserting the
    // belt landed separates the two failure modes: a red here means the path was
    // rejected (an `evalBeltPath` regression), a red below means the dock never
    // reached the host or its answer never reached the user.
    await pollScene(page, (s) => s.belts.length, {
      message: 'the belt itself committed - the refusal is about the DOCK, not the path',
    }).toBe(beltsBefore + 1);

    await pollRefusalText(page, 'the refused Head dock named the medium as its reason').toBe(
      MEDIUM_MISMATCH_COPY,
    );

    await pollRefusalText(page, 'the MediumMismatch message took itself away after its hold').toBe(
      '',
    );

    await expectRenderLoopAlive(page, 'after the MediumMismatch dock');
    errs.assertNone('the MediumMismatch belt dock');
  });
});

test.describe('ERR-01: a belt end dropped on a port it cannot dock says so', () => {
  test('a Dock the host refuses on ROLE paints the InvalidDock sentence and self-dismisses', async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);

    const { beltsBefore, cells } = await driveInvalidDock(page);

    await pollScene(page, (s) => s.belts.length, {
      message: 'the two-cell belt committed - the refusal is about the DOCK, not the path',
    }).toBe(beltsBefore + 1);

    // The path is asserted EXACTLY, because this leg is defined by WHICH END was dropped:
    // the Head is the second tile, and the Head is the end whose role the host refuses
    // onto an Out. A relaxation to a length check, a `toContain` or a prefix would let a
    // differently-shaped belt (one whose dragged handle was its TAIL, which an Out
    // ACCEPTS by role) satisfy this while earning a different verdict or none at all.
    const after = await readScene(page);
    const drawn = after.belts.reduce((longest, b) => (b.id > longest.id ? b : longest));
    const tiles = drawn.tiles.map((t) => [t.cell_x, t.cell_y]);
    expect(
      tiles,
      `the newest belt runs WEST from (${cells[0][0]},${cells[0][1]}) to its HEAD at (${cells[1][0]},${cells[1][1]}), the end the handle drag moved`,
    ).toEqual(cells);
    // And the derived run is the one this file names: the placed Router's top Out at
    // (21,9), so the press (23,9) and the head (22,9).
    expect(cells, 'the authored run is (23,9) then (22,9)').toEqual([
      [OWN_ROUTER_ANCHOR[0] + 3, OWN_ROUTER_ANCHOR[1]],
      [OWN_ROUTER_ANCHOR[0] + 2, OWN_ROUTER_ANCHOR[1]],
    ]);

    await pollRefusalText(page, 'the refused Head dock named the dock rule as its reason').toBe(
      INVALID_DOCK_COPY,
    );

    // The refusal changed NOTHING: the host answered with words, not a dock. A build that
    // accepted the Head onto an Out would show a dock here as well as (or instead of) the
    // sentence.
    expect(
      ((await readScene(page)).belts.find((b) => b.id === drawn.id)?.docks ?? []),
      'the refused Dock left the belt with NO dock at either end',
    ).toHaveLength(0);

    await pollRefusalText(page, 'the InvalidDock message took itself away after its hold').toBe('');

    await expectRenderLoopAlive(page, 'after the InvalidDock belt release');
    errs.assertNone('the InvalidDock belt release');
  });
});

test.describe('ERR-02: the three reachable refusals say three DIFFERENT things', () => {
  test('an occupancy conflict, a medium mismatch and an invalid dock produce pairwise-distinct non-empty sentences', async ({
    page,
  }) => {
    // THIS IS THE ASSERTION THAT MAKES CRITERION 3 MEAN WHAT IT SAYS, and the shape of
    // it is the whole point.
    //
    // Three separate `not.toBe('')` checks - one per leg, in three separate tests -
    // would pass IDENTICALLY against an implementation that showed ONE generic
    // sentence for every refusal. "Something went wrong" three times over is exactly
    // the silence this phase exists to end, wearing a different coat, and a suite of
    // non-empty assertions would certify it as fixed.
    //
    // So the three are driven in ONE run, their rendered text is captured, and the
    // captured strings are compared AGAINST EACH OTHER. A regression that collapsed
    // the copy table to a fallback arm reddens here on its own message.
    const errs = await bootOnDemo(page);

    // Leg 1: an occupancy conflict. A Place straight onto a demo belt tile.
    const [cx, cy] = OCCUPIED_BELT_CELL;
    await armAndPlaceAt(page, 'Source', cx, cy);
    const footprintText = await captureRefusalText(page, 'the occupancy conflict said something');
    // Each leg waits for its own message to CLEAR before the next is driven. Without
    // the gap the second capture could latch the first leg's sentence still on screen
    // and the comparison would be against a stale reading rather than a new one.
    await pollRefusalText(page, 'the occupancy message cleared before the next leg').toBe('');

    // Leg 2: a medium mismatch. A Mechanical belt docked onto an Electrical port.
    await driveMediumMismatch(page);
    const mediumText = await captureRefusalText(page, 'the medium mismatch said something');
    await pollRefusalText(page, 'the medium message cleared before the next leg').toBe('');

    // Leg 3: an invalid dock. A belt's Head handle dropped on an Out nub, refused by the
    // host's ROLE check (see the geometry block above).
    await driveInvalidDock(page);
    const dockText = await captureRefusalText(page, 'the invalid dock said something');

    // Non-empty is the FLOOR, not the claim. Stated first so a total failure of the
    // path fails on the obvious thing rather than on an inequality.
    expect(footprintText, 'the occupancy conflict produced a sentence').not.toBe('');
    expect(mediumText, 'the medium mismatch produced a sentence').not.toBe('');
    expect(dockText, 'the invalid dock produced a sentence').not.toBe('');

    // PAIRWISE, all three combinations. Two comparisons would leave one pair free to
    // collide; a `new Set([...]).size === 3` would hide WHICH pair collided in a
    // failure message a reader has to reconstruct.
    expect(
      footprintText,
      'the occupancy conflict and the medium mismatch say DIFFERENT things',
    ).not.toBe(mediumText);
    expect(mediumText, 'the medium mismatch and the invalid dock say DIFFERENT things').not.toBe(
      dockText,
    );
    expect(footprintText, 'the occupancy conflict and the invalid dock say DIFFERENT things').not.toBe(
      dockText,
    );

    // And each is the sentence the copy table authored for ITS tag, not merely some
    // other tag's sentence. Distinctness alone would be satisfied by three sentences
    // shuffled between three tags.
    expect(footprintText, 'and the occupancy sentence is the authored one').toBe(
      FOOTPRINT_COLLISION_COPY,
    );
    expect(mediumText, 'and the medium sentence is the authored one').toBe(MEDIUM_MISMATCH_COPY);
    expect(dockText, 'and the dock sentence is the authored one').toBe(INVALID_DOCK_COPY);

    await expectRenderLoopAlive(page, 'after all three refusals');
    errs.assertNone('the three-refusal distinctness run');
  });
});

// ---------------------------------------------------------------------------
// THE `DrawWire` MediumMismatch LEG (plan 66-10) - `WINDOWS` row 82's live half
// ---------------------------------------------------------------------------
//
// WHAT THIS CLOSES. `WINDOWS` row 82 records that the wire-draw refusal copy
// shipped UNVERIFIED against any live user path, because at the time no gesture in
// `frontend/src` emitted `DrawWire` at all: the sentence could not be reached, seen
// or e2e-tested. Its stated trigger is "WHEN A WIRE-DRAW GESTURE SHIPS: re-read the
// four arms of the validate arm against the sentence, and cover it in the live e2e
// refusal suite." 66-09 performed the re-read; the test below is the second half.
//
// THIS IS THE FIRST TIME ANY `DrawWire` REFUSAL HAS BEEN REACHABLE BY A POINTER.
// The three legs above are all BELT refusals driven through `drawBeltThroughCells`.
// This one arms the palette Wire tool and drags nub to nub, so the sentence a human
// reads is produced by the gesture a human makes.
//
// RE-AUTHORED BY PLAN 75-07 (D-12), and the old names are recorded here so a reader
// who greps the old wording finds the record rather than a hole:
//   was: test 'a hand-drawn wire from a MECHANICAL Out to an ELECTRICAL In paints the
//              MediumMismatch sentence, draws nothing, and self-dismisses'
// WHY. That leg pressed the demo Router's free MECHANICAL Out, which 66-09's press split
// let start a drag so the release could ask the host. D-12 (2026-10-06, "Fix it in
// 75"; the reported symptom on the real binary, "dragging wire from router doesn't work, becomes red
// whatever I do") answers a belt-only SOURCE at the press, in the client's own sentence,
// and sends nothing - so that drag can no longer reach the host, and
// `75-belt-port-refusal.live.spec.ts` now covers that press. The host's own release-time
// MediumMismatch is still real: it is what a wire from an ELECTRICAL source onto a
// belt-only TARGET gets. So the leg now drags from a freshly placed Route's electrical Out
// onto the demo Router's MECHANICAL In, and still asserts the host's exact sentence.
//
// WHY THE TARGET END IS SAFE NOW. The host's DrawWire arm checks role (4), then MEDIUM
// (5), then occupancy (6) - `resolve_wire_leg` in `fabrico-command`'s `command.rs`. The
// source is a fresh Route's Out, so nothing occupies it, and the Router's In fails at
// step (5) on its own medium before step (6) is consulted, docked or not.
//
// THE GUARD RADIUS BELOW IS NOT THE HIT RADIUS. The armed Wire tool's press and
// release hit tests use `wireNubHitRadiusWorld` - the project's 44px chrome minimum
// target halved, so 22 WORLD px at zoom <= 1. That constant lives in `frontend/src`,
// which the live suite deliberately may not import (the zero-mock auditability rule
// in `support/oracle.ts`). So instead of restating 22 here, the two invariants below
// are asserted over a DELIBERATELY WIDER 64 world px (two cells) - any nub the real
// 22px ranker could reach is inside 64px, so an invariant that holds at 64 holds at
// 22 for every radius the tool could plausibly take.
const WIRE_NUB_GUARD_RADIUS_WORLD = 64;

/** The clear cell the self-loop leg places its own Route at, and since plan 75-07 the
 *  MediumMismatch leg too (each test resets to the demo first). Row 9 is clear of the
 *  demo board, which occupies rows 0..8.
 *
 *  RENAMED BY PLAN 72-13, LEDGER ROW LR-5. The palette row this leg arms was
 *  `HTTP Endpoint` until D-09 renamed kind 9 to `Route` (plan 72-10). `armAndPlaceAt`
 *  resolves the row by ACCESSIBLE NAME (`oracle.ts:805`), so the old string resolved
 *  nothing and the click timed out at 90s. It is the same machine, same kind byte,
 *  same catalog ports; only the shipped name moved. */
const SELF_LOOP_CELL = [12, 9] as const;

/** A flattened `(node, port)` nub with its world anchor point. */
interface NubFacts {
  nodeId: number;
  port: PortFacts;
  x: number;
  y: number;
}

/** Every port in the scene, flattened, with its world nub anchor. */
function allNubs(scene: Awaited<ReturnType<typeof readScene>>): NubFacts[] {
  return scene.nodes.flatMap((n) =>
    n.ports.map((p) => ({ nodeId: n.id, port: p, ...nubAnchor(p.cell_x, p.cell_y, p.side) })),
  );
}

/** The nubs within `WIRE_NUB_GUARD_RADIUS_WORLD` world px of `(x, y)`. */
function nubsNear(nubs: NubFacts[], x: number, y: number, role: number): NubFacts[] {
  return nubs.filter(
    (n) => n.port.role === role && Math.hypot(n.x - x, n.y - y) <= WIRE_NUB_GUARD_RADIUS_WORLD,
  );
}

test.describe('ERR-01: a wire dragged onto a port of the wrong medium says so', () => {
  test("a hand-drawn wire from a Route's ELECTRICAL Out onto the Router's MECHANICAL In paints the MediumMismatch sentence, draws nothing, and self-dismisses", async ({
    page,
  }) => {
    const errs = await bootOnDemo(page);

    // NOT DECORATION, EITHER OF THEM, AND THEY RUN ON BOTH SIDES OF THE GESTURE.
    // `window.__fabrico.scene()` is fed by the packet-application buffer and is
    // COMPLETELY INDEPENDENT of the Pixi ticker: an uncaught exception inside a
    // ticker listener kills the renderer permanently while `scene().tick` keeps
    // climbing and every model assertion below stays green. `expectRenderLoopAlive`
    // is used rather than a hand-rolled poll because the frame counter WRAPS at 24
    // and a naive greater-than is unsatisfiable at 23.
    await expectRenderLoopAlive(page, 'before the wire drag');
    errs.assertNone('before the wire drag');

    // THE SOURCE: a freshly placed Route's ELECTRICAL Out, on the clear row the
    // self-loop leg below also uses (each test resets to the demo first).
    const [cx, cy] = SELF_LOOP_CELL;
    await armAndPlaceAt(page, 'Route', cx, cy);
    await pollScene(page, (s) => nodeAtAnchor(s, cx, cy) !== undefined, {
      message: 'the hand-placed Route folded on the real host',
    }).toBe(true);
    // The board just grew and the camera is fit-to-content: settle it before any
    // world-to-screen projection.
    await waitForCameraSettle(page);
    await expectRenderLoopAlive(page, 'right after placing the Route');
    // THE TARGET MACHINE, placed by this leg (D-19, plan 85-07): a Router from the
    // palette. Until 85-07 the leg dragged onto the DEMO Router's In; phase 85 rebuilds
    // that part of the demo, and the leg needs a Router, not that one.
    await expectBareAnchor(page, 'Router', OWN_ROUTER_ANCHOR);
    await armAndPlaceAt(page, 'Router', OWN_ROUTER_ANCHOR[0], OWN_ROUTER_ANCHOR[1]);
    await ownMachineFolded(page, 'Router', OWN_ROUTER_ANCHOR);

    const before = await readScene(page);
    const wiresBefore = before.wires.length;
    const nubs = allNubs(before);
    const route = nodeAtAnchor(before, cx, cy)!;
    const source = route.ports.find((p) => p.role === 1 && p.medium === 1);
    expect(
      source && [source.cell_x, source.cell_y, source.side, source.role, source.medium],
      'the placed Route carries an ELECTRICAL Out on its own cell, facing E',
    ).toEqual([cx, cy, 1, 1, 1]);

    // THE TARGET: the placed ROUTER's In, found by role (its one In), on its west column,
    // middle row, facing W: (20,10). Every Router port takes belts only, which is the whole
    // point of this leg.
    const [rx, ry] = OWN_ROUTER_ANCHOR;
    const router = nodeAtAnchor(before, rx, ry);
    expect(router, `the placed ROUTER is anchored at (${rx},${ry})`).toBeTruthy();
    const routerIns = router!.ports.filter((p) => p.role === 0);
    expect(routerIns.length, 'the placed ROUTER carries exactly one In').toBe(1);
    const target: PortFacts = routerIns[0];
    expect(
      [target.cell_x, target.cell_y, target.side, target.role, target.medium],
      `the ROUTER In is a MECHANICAL In at (${rx},${ry + 1}) facing W`,
    ).toEqual([rx, ry + 1, 3, 0, 0]);

    // THE TWO INVARIANTS THAT MAKE THIS A MediumMismatch TEST RATHER THAN A TEST OF
    // WHATEVER NUB THE RANKER HAPPENED TO PICK. The press ranker takes the nearest
    // in-range ELECTRICAL Out and the release ranker prefers an accepting In, then any
    // In, so the command that is actually emitted is only pinned once the neighbourhood
    // of each end is pinned. Both are DERIVED from the live scene, never transcribed.
    const srcAnchor = nubAnchor(source!.cell_x, source!.cell_y, source!.side);
    expect(
      nubsNear(nubs, srcAnchor.x, srcAnchor.y, 1).map((n) => [n.nodeId, n.port.index]),
      "the ONLY Out nub the press could resolve is the Route's own",
    ).toEqual([[route.id, source!.index]]);
    const dstAnchor = nubAnchor(target.cell_x, target.cell_y, target.side);
    expect(
      nubsNear(nubs, dstAnchor.x, dstAnchor.y, 0).map((n) => [n.nodeId, n.port.index]),
      "the ONLY In nub the release could resolve is the Router's In, so no accepting In can win the release",
    ).toEqual([[router!.id, target.index]]);

    // THE GESTURE: a hand's drag, off-centre at both ends, in sub-cell steps.
    await handDrawWire(page, source as PortFacts, target);

    // (1) THE SENTENCE, BY ITS EXACT SHIPPED TEXT. Not a tag name and not a
    // non-empty check: the point of this test is that a HUMAN sees a sentence.
    await pollRefusalText(page, 'the refused DrawWire named the medium as its reason').toBe(
      MEDIUM_MISMATCH_COPY,
    );

    // (2) THE BOARD GAINED NO WIRE. Without this the test could not tell "the host
    // refused" from "the host accepted and also happened to show something".
    expect(
      (await readScene(page)).wires.length,
      'the refused DrawWire minted no wire (the board keeps exactly the cables it had)',
    ).toBe(wiresBefore);

    // (3) The hold expires and the region empties itself, on the same 4000ms wall
    // clock the three belt legs above are pinned to.
    await pollRefusalText(page, 'the MediumMismatch message took itself away after its hold').toBe(
      '',
    );

    await expectRenderLoopAlive(page, 'after the wire drag');
    errs.assertNone('the MediumMismatch wire drag');
  });
});

test.describe('ERR-01: a wire drawn from a machine back into itself says so', () => {
  test('a hand-drawn SELF-LOOP on one Endpoint paints the IncompatiblePorts sentence, draws nothing, and self-dismisses', async ({
    page,
  }) => {
    // THIS IS THE SENTENCE `WINDOWS` ROW 82 IS ACTUALLY ABOUT, and the leg above is
    // not. Row 82 names `REFUSAL_COPY.IncompatiblePorts`; the MediumMismatch leg
    // above covers a different tag, so closing the row on it alone would have been
    // half a close wearing a whole one's name.
    //
    // WHY IT IS REACHABLE NOW AND WAS NOT BEFORE 66-04. The host returns
    // `IncompatiblePorts` for three things: a self-loop, a port index naming no
    // declared port, and a role violation. A gesture cannot forge a port index, and
    // a release that resolves no In nub emits NOTHING at all by design (66-09), so a
    // role violation is unreachable from the release side. The SELF-LOOP is the one
    // arm a pointer can reach, and it needs ONE machine carrying BOTH an electrical
    // Out and an electrical In. The ENDPOINT catalog arm is the only one in the
    // repository that does (In index 0 facing W, Out index 1 facing E, both on the
    // one 1x1 cell), and 66-04 is what made an Endpoint placeable at all. So this
    // sentence became reachable by a human gesture exactly one plan ago.
    //
    // The two nub anchors sit 33 world px apart on the one cell, which is wider than
    // the armed Wire tool's own hit radius, so the press resolves the Out and the
    // release resolves the In with no ambiguity between them.
    const errs = await bootOnDemo(page);

    await expectRenderLoopAlive(page, 'before the self-loop drag');
    errs.assertNone('before the self-loop drag');

    const [cx, cy] = SELF_LOOP_CELL;
    await armAndPlaceAt(page, 'Route', cx, cy);
    await pollScene(page, (s) => nodeAtAnchor(s, cx, cy) !== undefined, {
      message: 'the hand-placed Route folded on the real host',
    }).toBe(true);
    // The board just grew, and the camera is fit-to-content. Settle it before any
    // world-to-screen projection, or the press and the release can be computed
    // against two different cameras.
    await waitForCameraSettle(page);

    const scene = await readScene(page);
    const endpoint = nodeAtAnchor(scene, cx, cy)!;
    const out = endpoint.ports.find((p) => p.role === 1 && p.medium === 1);
    const into = endpoint.ports.find((p) => p.role === 0 && p.medium === 1);
    expect(out, 'the Endpoint carries an electrical Out').toBeDefined();
    expect(into, 'and an electrical In, on the same cell').toBeDefined();
    expect(
      [out!.cell_x, out!.cell_y, into!.cell_x, into!.cell_y],
      'both nubs are on the one placed cell, which is what makes a self-loop drawable',
    ).toEqual([cx, cy, cx, cy]);

    // The neighbourhood invariant, derived from the live scene: nothing else is close
    // enough for either ranker to resolve, so the emitted command names this machine
    // at BOTH ends and the host's answer can only be the self-loop arm.
    const nubs = allNubs(scene);
    const outAnchor = nubAnchor(out!.cell_x, out!.cell_y, out!.side);
    const inAnchor = nubAnchor(into!.cell_x, into!.cell_y, into!.side);
    expect(
      nubsNear(nubs, outAnchor.x, outAnchor.y, 1).map((n) => [n.nodeId, n.port.index]),
      'the ONLY Out nub the press could resolve is this Endpoint\'s own',
    ).toEqual([[endpoint.id, out!.index]]);
    expect(
      nubsNear(nubs, inAnchor.x, inAnchor.y, 0).map((n) => [n.nodeId, n.port.index]),
      'the ONLY In nub the release could resolve is this Endpoint\'s own',
    ).toEqual([[endpoint.id, into!.index]]);

    const wiresBefore = scene.wires.length;
    await drawWireBetweenPorts(page, out as PortFacts, into as PortFacts);

    await pollRefusalText(page, 'the refused self-loop named the two-machine rule as its reason').toBe(
      INCOMPATIBLE_PORTS_COPY,
    );

    // A DIFFERENT SENTENCE FROM THE LEG ABOVE. Two wire refusals that both said
    // "something is wrong with these ports" would be the Phase 64 silence wearing a
    // different coat, and two separate exact-text assertions in two separate tests
    // would not notice a copy table that had collapsed to one arm.
    expect(
      INCOMPATIBLE_PORTS_COPY,
      'the two reachable DrawWire refusals say DIFFERENT things',
    ).not.toBe(MEDIUM_MISMATCH_COPY);

    expect(
      (await readScene(page)).wires.length,
      'the refused self-loop minted no wire',
    ).toBe(wiresBefore);

    await pollRefusalText(page, 'the IncompatiblePorts message took itself away after its hold').toBe(
      '',
    );

    await expectRenderLoopAlive(page, 'after the self-loop drag');
    errs.assertNone('the self-loop wire drag');
  });
});
