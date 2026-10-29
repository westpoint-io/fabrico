import { test, expect, type Page } from '@playwright/test';
import {
  expectRenderLoopAlive,
  watchPageErrors,
  DEMO_NODE_COUNT,
  armAndPlaceFactoryAt,
  loadDemoViaExamples,
  clickAt,
  pollScene,
  readScene,
  rotateHandle,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  type SceneFacts,
} from './support/oracle';

// 04-canredo-discriminator.spec.ts (MOTION-04 / gates MOTION-06b) - the LIVE
// confirmation of the ONE behavioral assumption Plan 05's conservative
// undo-strand heuristic locks on (RESEARCH A4, "the highest-value assumption to
// confirm live"): an UNDO is the only operation that leaves the redo stack
// non-empty, so `packet.can_redo === true` is a strong necessary gate that
// EXCLUDES fresh loads and normal forward edits.
//
// Discriminator legs proven here against the REAL host (dev_render_server, ZERO
// mocks), all read off the style-independent scene oracle `window.__fabrico.scene()`
// (poll s.canRedo) - never a canvas pixel, so this spec is NOT a Phase 28
// quarantine candidate:
//   - normal forward edit  -> canRedo === false  (a forward edit clears the redo stack)
//   - UNDO of that edit     -> canRedo === true   (undo is the only op leaving redo non-empty)
//   - REDO                  -> canRedo === false  (redo empties the redo stack; TRUE->FALSE)
//   - LOAD (genesis swap)   -> canRedo === false  (a load resets both stacks; TRUE->FALSE)
// plus RESEARCH Open Question 1: the post-undo scene node COUNT equals the
// pre-undo count (the undo keyframe's structural node-set is complete), so Plan
// 05's size-match gate (Pattern 5, gate 1) can rely on it.
//
// Drive rules (inherited from 02-round-trip, locked): page.mouse + getByTitle
// ONLY. No page.evaluate into app internals to ISSUE commands (that bypasses
// hit-testing). Every wait polls a SPECIFIC model change via pollScene; fixed
// sleeps are banned. The forward edit under test is a node-count-PRESERVING
// Rotate of a freshly PLACED (undocked) factory - the exact 02-round-trip recipe
// (a docked demo node does not rotate cleanly) - so the Open Q1 count-equality
// assertion is exact.

test.describe.configure({ mode: 'serial' });

/** FACTORY wire kind (mirrored from kinds.ts / 01-default-scene). */
const KIND_FACTORY = 2;
/** The factory footprint width in cells (drives the rotate-handle anchor). */
const FACTORY_W = 3;
/**
 * The Place drop cell. The demo occupies rows 2..8, so row 11 is verified-empty
 * space, and the 3x3 footprint anchored here (rows 11..13) stays inside the
 * 1280x720 identity-camera viewport (mirrors 02-round-trip's PLACE_CELL).
 */
const PLACE_CELL = [6, 11] as const;

type NodeFacts = SceneFacts['nodes'][number];

/**
 * Reset to the known demo baseline via the SHIPPED Load-demo CTA (the same
 * genesis-swap reset 02-round-trip uses). LoadDemo is a genesis swap, so the sim
 * tick RESTARTS: capturing the pre-click tick and polling for it dropping below
 * that value proves the swap keyframe folded (a falsifiable predicate, review
 * WR-01), and `nodes.length === DEMO_NODE_COUNT` pins the baseline topology in the
 * same poll.
 */
async function loadDemoReset(page: Page): Promise<void> {
  const tickBefore = (await readScene(page)).tick;
  await loadDemoViaExamples(page);
  await pollScene(page, (s) => s.tick < tickBefore && s.nodes.length === DEMO_NODE_COUNT, {
    message:
      'the LoadDemo genesis swap folded (sim tick restarted below the pre-click tick) onto the demo baseline',
  }).toBe(true);
}

/**
 * Place a fresh FACTORY via the palette drag (the proven 02-round-trip recipe):
 * press the palette Factory tile at its bbox centre, drag onto the drop cell,
 * release. Polls until the real host echoes a SECOND kind-2 node, then returns the
 * placed node's id (diffed from the pre-place kind-2 id set, never a hardcoded
 * handle). The placed factory is UNDOCKED, so it rotates cleanly.
 */
async function placeFactory(page: Page): Promise<number> {
  const beforeIds = new Set(
    (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id),
  );
  // Arm-then-click (30-05): arm the Factory tool, click the drop cell, disarm.
  await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);

  await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
    message: 'the real host echoes the placed FACTORY (kind-2 node count reaches 2)',
  }).toBe(beforeIds.size + 1);

  const placed = (await readScene(page)).nodes.find(
    (n) => n.kind === KIND_FACTORY && !beforeIds.has(n.id),
  );
  expect(placed, 'the placed factory is found by diffing pre/post kind-2 ids').toBeDefined();
  return (placed as NodeFacts).id;
}

/**
 * Rotate the placed factory in place via the on-canvas rotate handle (the
 * 02-round-trip recipe): select the node by clicking its anchor body cell, then
 * Shift+click the rotate handle pinned to the selection outline's top-right corner
 * (Shift = CCW; direction is immaterial here). Polls until the echoed node's
 * ports[] change so the edit is confirmed landed, not merely dispatched.
 */
async function rotatePlaced(page: Page, placedId: number): Promise<void> {
  const before = (await readScene(page)).nodes.find((n) => n.id === placedId);
  expect(before, 'the placed factory is present before the rotate').toBeDefined();
  const beforePorts = JSON.stringify((before as NodeFacts).ports);
  const minX = Math.min(...(before as NodeFacts).cells.map((c) => c[0]));
  const minY = Math.min(...(before as NodeFacts).cells.map((c) => c[1]));

  const anchor = await screenCellCentre(page, minX, minY);
  await clickAt(page, anchor.x, anchor.y); // select -> shows rotate handle
  const handle = rotateHandle(minX, minY, FACTORY_W);
  const handlePt = await screenPoint(page, handle);
  await page.keyboard.down('Shift');
  await clickAt(page, handlePt.x, handlePt.y); // rotate (CCW)
  await page.keyboard.up('Shift');

  await pollScene(
    page,
    (s) => JSON.stringify(s.nodes.find((n) => n.id === placedId)?.ports),
    { message: 'the Rotate echo re-stamps the placed factory ports[] (the forward edit landed)' },
  ).not.toBe(beforePorts);
}

// GATE-04 ARTIFACT (Phase 28 bless-and-map): this spec IS the GATE-04 canRedo
// gate. The Undo drive below (getByTitle('Undo (Ctrl+Z)').click()) + the four
// s.canRedo poll legs on the real zero-mock host (load->false, forward-edit->false,
// undo->true, redo->false) ARE the gate assertion. No duplicate spec is authored;
// mapping is closed by this annotation + the describe title + the 28-UI-SPEC cross-ref.
test.describe('GATE-04 / MOTION-04: the can_redo discriminator gate (also gates MOTION-06b) (LIVE, real host)', () => {
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
    errs.assertNone('the can_redo walk');
  });

  test('can_redo is false on load/normal-edit and true ONLY after an undo (all legs, real host)', async ({
    page,
  }) => {
    // --- Arrange: clean demo baseline; a fresh load resets both stacks. ---
    await loadDemoReset(page);
    const baselineCount = (await readScene(page)).nodes.length;
    expect(baselineCount, 'baseline is the demo topology').toBe(DEMO_NODE_COUNT);
    // LEG (load -> false): a genesis load resets the redo stack.
    await pollScene(page, (s) => s.canRedo, {
      message: 'a fresh LoadDemo leaves canRedo === false (both stacks reset)',
    }).toBe(false);

    // --- Arrange: a fresh undocked factory to rotate (count 6 -> 7). ---
    const placedId = await placeFactory(page);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the placed factory brings the node count to 7',
    }).toBe(baselineCount + 1);

    // --- Forward edit under test: a node-count-preserving Rotate. ---
    await rotatePlaced(page, placedId);
    await pollScene(page, (s) => s.canUndo, {
      message: 'the Rotate echo flips canUndo true (the forward edit is undoable)',
    }).toBe(true);
    // LEG (normal forward edit -> false): a forward edit clears the redo stack.
    await pollScene(page, (s) => s.canRedo, {
      message: 'after a normal forward edit (Rotate) canRedo === false (redo stack cleared)',
    }).toBe(false);
    const preUndoCount = (await readScene(page)).nodes.length;
    expect(preUndoCount, 'a Rotate never changes the node count').toBe(baselineCount + 1);

    // --- Undo the Rotate: the ONLY operation that leaves the redo stack non-empty. ---
    await page.getByTitle('Undo (Ctrl+Z)').click();
    // LEG (undo -> true): THE key positive discriminator MOTION-06b locks on.
    await pollScene(page, (s) => s.canRedo, {
      message: 'after an Undo canRedo === true (undo is the only op that leaves redo non-empty)',
    }).toBe(true);
    // RESEARCH Open Q1: the post-undo keyframe's node-set is structurally COMPLETE
    // (count equals pre-undo), so Plan 05's size-match gate can rely on it.
    const postUndoCount = (await readScene(page)).nodes.length;
    expect(
      postUndoCount,
      'the post-undo scene node count equals the pre-undo count (Open Q1: undo keyframe node-set complete)',
    ).toBe(preUndoCount);

    // --- Redo: empties the redo stack again (TRUE -> FALSE, non-vacuous). ---
    await page.getByTitle('Redo (Ctrl+Shift+Z)').click();
    // LEG (redo -> false): redo consumes the only redoable action.
    await pollScene(page, (s) => s.canRedo, {
      message: 'after a Redo canRedo === false (redo empties the redo stack)',
    }).toBe(false);

    // --- Undo again to re-populate the redo stack, then LOAD over it. ---
    await pollScene(page, (s) => s.canUndo, {
      message: 'the redone Rotate is undoable again (canUndo true) before the load-reset leg',
    }).toBe(true);
    await page.getByTitle('Undo (Ctrl+Z)').click();
    await pollScene(page, (s) => s.canRedo, {
      message: 'the re-undo leaves canRedo === true (a non-empty redo stack to reset)',
    }).toBe(true);
    // LEG (load -> false, STRONG): a genesis load resets a NON-EMPTY redo stack
    // (TRUE -> FALSE), proving the load path clears redo, not merely that a cold
    // load happens to start empty.
    await loadDemoReset(page);
    await pollScene(page, (s) => s.canRedo, {
      message: 'a LoadDemo over a non-empty redo stack resets canRedo to false (load clears redo)',
    }).toBe(false);
  });
});
