import { test, expect, type Page } from '@playwright/test';
import {
  expectRenderLoopAlive,
  watchPageErrors,
  DEMO_NODE_COUNT,
  armAndPlaceFactoryAt,
  loadDemoViaExamples,
  clickAt,
  nubAnchor,
  pollScene,
  readScene,
  rotateHandle,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  type SceneFacts,
} from './support/oracle';

// 05-undo-strand-ring.spec.ts (MOTION-06b, THE HARD ONE) - the LIVE real-host
// reality check for the conservative keyframe-aware undo-strand detector
// (detectUndoStrand, strandedDocks.ts). Drives the REAL dev_render_server (real
// Core -> RenderProducer -> postcard -> WS), ZERO mocks, all reads off the
// style-independent window.__fabrico.scene() oracle (never a canvas pixel), so
// this spec is NOT a Phase 28 pixel-quarantine candidate.
//
// WHAT THIS SPEC PROVES (the SCENE-level contract MOTION-06b's silence
// guarantees depend on), against the real host:
//   1. FORWARD strand: rotating a docked factory VACATES the belt dock on the
//      diff packet - the input condition the EXISTING detectStrandedDocks
//      forward-ring fires on. (canRedo === false: a forward edit clears redo.)
//   2. UNDO keyframe: the undo restores the machine orientation, leaves
//      canRedo === true + the node COUNT preserved, AND RE-ESTABLISHES the
//      severed belt dock - the real host compensates the severance on undo.
//   3. REDO keyframe: canRedo === false, so detectUndoStrand's gate-0
//      discriminator holds it SILENT on a redo.
//   4. LOAD: a fresh genesis-swap load resets canRedo === false, so
//      detectUndoStrand is SILENT on a load (Fork #1: never cry wolf).
//
// THE FORK, RESOLVED 2026-08-30 BY PLAN 67-03 (CONNECT-03 / SEED-006).
// INVERTED DELIBERATELY - what finding #2 asserted from 26-05 until 2026-08-30
// was, verbatim: "the undo restores the machine orientation and leaves
// canRedo === true + the node COUNT preserved, but the belt dock STAYS vacated -
// the real host does NOT re-establish the severed dock on undo", with the leg-2
// assertion message "the real host leaves the dock SEVERED after undoing the
// strand-rotate (no auto re-link)". That was a TRUE reading of the host at the
// time and it is FALSE now, because the behaviour moved underneath it: plan
// 67-03 landed the severed-dock capture + compensating `EditOp::Dock` emit in
// `crates/fabrico-command/src/command.rs`, so `GridSession::compute_inverse`'s
// undo of a severing Rotate now re-docks what the rotate severed. This spec's
// inversion is a CONSEQUENCE of that landed change, not a loosened assertion;
// the two land in the SAME commit on purpose so the diff reads as deliberate.
//
// The 26-05 SURFACED FORK block this replaces named the two ways out - (a)
// renderer-side memory of the just-fired forward strand, or (b) "the deferred
// SEED-006 command-layer re-link". Route (b) is what shipped.
//
// CONSEQUENCE FOR detectUndoStrand (strandedDocks.ts:151), stated rather than
// left implicit: its structural gates fire only when a dock present in `prev`
// VANISHES on an undo keyframe, and there is now no such vanishing on this
// host's real gesture flow, so it is expected NEVER to fire in production. Its
// nine unit tests feed SYNTHETIC packets and therefore stay green either way -
// which is exactly the "check unable to see the thing it guards" shape. It is
// kept for one milestone as defence-in-depth against a compensation bug and is
// slated for retirement; leg 2 below is the live oracle that would notice if the
// compensation ever regressed. The overlay has no oracle read, so ring PIXELS
// are not asserted here by design (CONTEXT: feel judged live in Chrome; the
// scene oracle is the style-independent probe).
//
// Drive rules (inherited from 02-round-trip / 04-canredo, locked): page.mouse +
// getByTitle ONLY (real hit-testing). Every wait polls a SPECIFIC model change
// via pollScene; fixed sleeps are banned.

test.describe.configure({ mode: 'serial' });

/** FACTORY wire kind (mirrored from kinds.ts / 01-default-scene). */
const KIND_FACTORY = 2;
/** Port role keyspace (In=0, Out=1, Fault=2). */
const ROLE = { In: 0, Out: 1, Fault: 2 } as const;
/** The factory footprint width in cells (drives the rotate-handle anchor). */
const FACTORY_W = 3;
/** The verified-empty drop cell (demo occupies rows 2..8; 3x3 at row 11 is clear). */
const PLACE_CELL = [6, 11] as const;
/** Side unit vectors in the core keyspace order N=0, E=1, S=2, W=3. */
const UNIT: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

type NodeFacts = SceneFacts['nodes'][number];

/** Reset to the demo baseline via the SHIPPED Load-demo CTA (genesis swap). */
async function loadDemoReset(page: Page): Promise<void> {
  const tickBefore = (await readScene(page)).tick;
  await loadDemoViaExamples(page);
  await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
    message: 'the LoadDemo genesis swap folded onto the demo baseline',
  }).toBe(true);
}

/** Place a fresh UNDOCKED factory via arm-then-click (30-05); returns its (diffed) handle. */
async function placeFactory(page: Page): Promise<number> {
  const beforeIds = new Set(
    (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id),
  );
  // Arm-then-click (30-05): arm the Factory tool, click the drop cell, disarm.
  await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
  await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
    message: 'the real host echoes the placed FACTORY (kind-2 node count grows by one)',
  }).toBe(beforeIds.size + 1);
  const placed = (await readScene(page)).nodes.find(
    (n) => n.kind === KIND_FACTORY && !beforeIds.has(n.id),
  );
  expect(placed, 'the placed factory is found by diffing pre/post kind-2 ids').toBeDefined();
  return (placed as NodeFacts).id;
}

/**
 * Rotate the placed factory via the on-canvas handle, CCW (Shift-click) by default or CW (a
 * plain click); waits for the ports[] re-stamp.
 */
async function rotatePlaced(page: Page, placedId: number, ccw = true): Promise<void> {
  const before = (await readScene(page)).nodes.find((n) => n.id === placedId);
  expect(before, 'the placed factory is present before the rotate').toBeDefined();
  const beforePorts = JSON.stringify((before as NodeFacts).ports);
  const minX = Math.min(...(before as NodeFacts).cells.map((c) => c[0]));
  const minY = Math.min(...(before as NodeFacts).cells.map((c) => c[1]));
  const anchor = await screenCellCentre(page, minX, minY);
  await clickAt(page, anchor.x, anchor.y); // select -> shows rotate handle
  const handle = rotateHandle(minX, minY, FACTORY_W);
  const handlePt = await screenPoint(page, handle);
  if (ccw) await page.keyboard.down('Shift');
  await clickAt(page, handlePt.x, handlePt.y); // Shift = CCW (keeps the Out belt in-viewport)
  if (ccw) await page.keyboard.up('Shift');
  await pollScene(page, (s) => JSON.stringify(s.nodes.find((n) => n.id === placedId)?.ports), {
    message: 'the Rotate echo re-stamps the placed factory ports[] (the edit landed)',
  }).not.toBe(beforePorts);
}

test.describe('MOTION-06b: undo-strand ring reality (LIVE, real host)', () => {
  // RENDER HEALTH in every test (plan 85-08, THE RENDER-HEALTH COUNT;
  // fabrico-model-oracle-blindspot): the watcher goes in BEFORE `page.goto`, and the loop
  // and the watcher are read after every test.
  let errs: ReturnType<typeof watchPageErrors>;

  test.beforeEach(async ({ page }) => {
    errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
  });

  test.afterEach(async ({ page }) => {
    await expectRenderLoopAlive(page, 'at the end of the test');
    errs.assertNone('the undo-strand walk');
  });

  // RENAMED 2026-08-30 (plan 67-03). Was: 'a docked belt severed by Rotate stays
  // severed through Undo; load/redo hold canRedo false' - the old name asserted the
  // very fact CONNECT-03 inverted.
  test('a docked belt severed by Rotate is RE-DOCKED by Undo; load/redo hold canRedo false', async ({
    page,
  }) => {
    // --- Arrange: clean demo + a fresh undocked factory to dock a belt onto. ---
    await loadDemoReset(page);
    const baseCount = (await readScene(page)).nodes.length;
    const placedId = await placeFactory(page);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the placed factory brings the node count to 7',
    }).toBe(baseCount + 1);

    // Rotate CCW so the Out port faces North (belt drawn upward stays in-viewport).
    await rotatePlaced(page, placedId);

    // --- Draw a belt from the Out front cell outward. ---
    const s1 = await readScene(page);
    const placed = s1.nodes.find((n) => n.id === placedId)!;
    const out = placed.ports.find((p) => p.role === ROLE.Out)!;
    expect(out, 'the rotated factory exposes an Out port to draw against').toBeDefined();
    const [dx, dy] = UNIT[out.side & 3];
    const front = [out.cell_x + dx, out.cell_y + dy] as const;
    const beforeBeltIds = new Set(s1.belts.map((b) => b.id));
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
    await pollScene(page, (s) => s.belts.length, {
      message: 'the real host echoes the drawn belt (belt count grows by one)',
    }).toBe(beforeBeltIds.size + 1);
    await page.keyboard.press('Escape'); // disarm the belt tool before selecting to dock
    const drawnId = (await readScene(page)).belts.find((b) => !beforeBeltIds.has(b.id))!.id;

    // --- Dock the belt Tail onto the Out nub. ---
    const s2 = await readScene(page);
    const drawn = s2.belts.find((b) => b.id === drawnId)!;
    const tiles = drawn.tiles as Array<{ cell_x: number; cell_y: number }>;
    const firstTile = tiles[0];
    const lastTile = tiles[tiles.length - 1];
    const endTile =
      firstTile.cell_x === front[0] && firstTile.cell_y === front[1] ? firstTile : lastTile;
    const mid = tiles[Math.floor(tiles.length / 2)];
    const midPt = await screenCellCentre(page, mid.cell_x, mid.cell_y);
    await clickAt(page, midPt.x, midPt.y); // select -> end handles
    const nub = nubAnchor(out.cell_x, out.cell_y, out.side);
    const endPt = await screenCellCentre(page, endTile.cell_x, endTile.cell_y);
    const nubPt = await screenPoint(page, nub);
    await page.mouse.move(endPt.x, endPt.y);
    await page.mouse.down();
    await page.mouse.move(nubPt.x, nubPt.y, { steps: 4 });
    await page.mouse.up();
    await pollScene(page, (s) => s.belts.find((b) => b.id === drawnId)?.docks.length ?? 0, {
      message: 'the real host echoes the Dock: the drawn belt gains a dock against the placed factory',
    }).toBeGreaterThan(0);

    // === 1. FORWARD strand: rotate the DOCKED factory -> the dock is severed. ===
    // This is the input condition the EXISTING detectStrandedDocks forward-ring
    // fires on (a belt re-emitted WITHOUT the dock the scene still held).
    //
    // CLOCKWISE SINCE PLAN 89-02 (D-08, research Finding D). This turn was a second
    // counter-clockwise one, which puts the Factory's Mechanical Fault on the nub the Out
    // just left, facing the belt's Tail. Under D-08 a turn docks every loose belt end a
    // port now faces, so that turn RE-AIMS the belt to the Fault (one dock before, one
    // after) and strands nothing. The clockwise turn goes back to rot 0, where no port
    // faces the Tail's cell, so the forward strand and the Undo re-dock below are graded
    // exactly as before, on a board where the turn really strands.
    await rotatePlaced(page, placedId, false);
    await pollScene(page, (s) => s.belts.find((b) => b.id === drawnId)?.docks.length ?? 0, {
      message: 'rotating the docked factory SEVERS the dock (belt docks back to empty) - the forward strand',
    }).toBe(0);
    await pollScene(page, (s) => s.canRedo, {
      message: 'a forward edit (the strand-rotate) clears the redo stack -> canRedo false',
    }).toBe(false);
    const preUndoCount = (await readScene(page)).nodes.length;

    // === 2. UNDO keyframe: orientation restored, canRedo true, node-count kept -
    //        AND the dock RE-ESTABLISHED (the host compensates the severance). ===
    // INVERTED 2026-08-30 by plan 67-03 (CONNECT-03 / SEED-006). Until then this
    // leg asserted `.toBe(0)` with the message "the real host leaves the dock
    // SEVERED after undoing the strand-rotate (no auto re-link)". The command
    // layer now captures each Rotate's severed docks at fold time and emits a
    // compensating `EditOp::Dock` per severance in the undo group, so the dock
    // comes back. This is the LIVE oracle for that behaviour - the Rust
    // integration legs in crates/fabrico-command/tests/rotate_undo_redock.rs
    // prove it against the session, this proves it against the real host.
    // detectUndoStrand is consequently expected never to fire in production (see
    // the header): there is no dock-vanish on this keyframe any more, and there
    // never was - what changed is that there is now a dock-RESTORE instead.
    await page.getByTitle('Undo (Ctrl+Z)').click();
    await pollScene(page, (s) => s.canRedo, {
      message: 'after the Undo canRedo === true (undo is the only op that leaves redo non-empty)',
    }).toBe(true);
    const postUndo = await readScene(page);
    expect(
      postUndo.nodes.length,
      'the undo keyframe preserves the node count (Plan 01 Open Q1: structural node-set complete)',
    ).toBe(preUndoCount);
    await pollScene(page, (s) => s.belts.find((b) => b.id === drawnId)?.docks.length ?? 0, {
      message:
        'the real host RE-DOCKS the belt after undoing the strand-rotate (CONNECT-03: the ' +
        'undo group carries a compensating Dock per severed link). Was `.toBe(0)` - "no auto ' +
        're-link" - until plan 67-03 landed the compensation on 2026-08-30.',
    }).toBeGreaterThan(0);
    // EXACTLY one dock after the Undo (plan 89-02, 89-MEASURE BELT-07): the compensating Dock
    // restores the one link the turn cut, to the Factory, and adds no second one.
    await pollScene(
      page,
      (s) => {
        const docks = s.belts.find((b) => b.id === drawnId)?.docks ?? [];
        // The factory found by its cells and kind, not by a handle an undo keyframe may re-mint.
        const factory = s.nodes.find(
          (n) => n.kind === KIND_FACTORY && n.cells.some((c) => c[0] === PLACE_CELL[0] && c[1] === PLACE_CELL[1]),
        );
        // On the Out by PORT (review WR-C-04): a dock on the Factory's Fault is the hazard the
        // comment above names. A Tail dock names its port by the Out's ordinal among the machine's
        // Outs (`dockPort` in ports.ts; a Fault dock is FAULT_PORT 65535); the Factory has one Out.
        const outs = factory?.ports.filter((p) => p.role === 1) ?? [];
        const outOrdinal = outs.length === 1 ? 0 : -2;
        return docks.length === 1 && docks[0].node === factory?.id && docks[0].end === 'Tail' && docks[0].port === outOrdinal;
      },
      { message: "after the Undo the belt holds exactly ONE dock, its Tail on the placed factory's Out (the Out's port, not the Fault)" },
    ).toBe(true);

    // === 3. REDO keyframe: canRedo false -> detectUndoStrand gate-0 SILENT. ===
    await page.getByTitle('Redo (Ctrl+Shift+Z)').click();
    await pollScene(page, (s) => s.canRedo, {
      message: 'after a Redo canRedo === false (redo empties the redo stack) -> detector silent on redo',
    }).toBe(false);

    // === 4. LOAD: a genesis-swap load over a re-populated redo stack resets
    //        canRedo false -> detectUndoStrand gate-0 SILENT (Fork #1). ===
    await page.getByTitle('Undo (Ctrl+Z)').click(); // re-populate a non-empty redo stack
    await pollScene(page, (s) => s.canRedo, {
      message: 'the re-undo leaves a non-empty redo stack (canRedo true) before the load-reset leg',
    }).toBe(true);
    await loadDemoReset(page);
    await pollScene(page, (s) => s.canRedo, {
      message: 'a LoadDemo over a non-empty redo stack resets canRedo false (load clears redo) -> silent on load',
    }).toBe(false);
  });
});
