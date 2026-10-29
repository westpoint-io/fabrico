import { test, expect, type Locator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DRAWN_STATE_FRAMES,
  alertRingCentres,
  alertRingInstructions,
  alertRingsPainted,
  cellCentre,
  armAndPlaceFactoryAt,
  clickAt,
  expectRenderLoopAlive,
  nubAnchor,
  pollScene,
  portNubInstructionsOn,
  readScene,
  resetToDemo,
  screenCellCentre,
  screenPoint,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
  restoreHostAfterFailedTest,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';

// 11-panel-add-remove.live.spec.ts (PANEL-03, Phase 51-03) - the CLOSING live
// gate for the milestone's standing "Add/remove-port safety" concern,
// driven against the REAL dev_render_server (real Core ->
// RenderProducer -> postcard -> WS). Zero mocks, zero injected packets: every
// port this spec asserts on was minted by the real host's certified AddPort fold.
//
// The three things the mock suite CANNOT prove, proven here:
//
//   1. A `+ Add output` click really grows the machine on the host, and the new
//      row appears from the NEXT real render packet.
//   2. That add is ONE host action: Ctrl+Z removes it and Ctrl+Shift+Z restores
//      it, with the real command layer's undo cursor - not a frontend illusion.
//   3. The added output SURVIVES a real Save -> New -> Load round-trip of the
//      `.fab` edit_log (the fold is re-derived from the log, not from a cached
//      frontend value).
//
// ...plus the index-shift case against the real host: a belt docked to a LATER
// Out leaves the EARLIER Out's remove OFFERED while that earlier Out is itself
// UNCONNECTED. Until 73-08 that pairing proved the renumber hazard was BLOCKED;
// since 73-06 the fold performs the renumber correctly, so it now proves the
// removal is offered and emits.
//
// ...and, since 73-08, the whole UNDO-06 leg: walk steps 4 to 6 on the board
// `73-WALK-BOARD.md` names - a FRESH Factory at (6,11) with two Outs and a belt
// on each. Remove the first output, watch exactly ONE belt let go while the other
// stays on its own output, then press Ctrl+Z once and get both back.
//
// PHASE-51 GAP CLOSURE (51-06). The four tests above shipped covering ADD only,
// and that hole is exactly how a broken half of the feature passed every gate:
// the phase verifier found that on the DEFAULT demo board, a gated-safe REMOVE
// followed by Ctrl+Z restored nothing and spent the undo step, and that one
// Ctrl+Z after a Place left the placed machine standing while silently deleting
// one of the demo's caller and handler nodes. Both were pre-existing command-layer defects that this
// phase's controls made user-reachable; both were fixed in 51-04
// (live-authoritative undo captures) and bounded in 51-05 (inverse refusal
// guards). The last two tests in this file are the arms that were missing - the
// user-layer proof, on the board the app boots into:
//
//   4. REMOVE an output, Ctrl+Z, and the output COMES BACK (ROADMAP SC2's remove
//      half); Ctrl+Shift+Z removes it again.
//   5. PLACE a machine, Ctrl+Z, and THAT machine goes - asserted as a set
//      difference over the whole board, because a bare node COUNT passes while
//      one machine is swapped for another, which is precisely what the defect did.
//
// SCOPE, stated because overstating it is what produced this gap: these arms
// prove the LIVE session. Undo of an action that predates a save, on a project
// re-loaded from a demo-derived `.fab`, still does not restore - it refuses, and
// the refusal is invisible to the user (Ctrl+Z does nothing, no message). That
// residual is recorded as an open todo (2026-07-25, post-load undo projection alignment)
// and pinned Rust-side by `post_load_undo_of_a_pre_save_{remove_port,place}` in
// `crates/fabrico-host/tests/undo_on_demo_board.rs`.
//
// Suite budget: ONE spec file (the ~11-spec dev_render_server stall ceiling sits
// at this boundary, STATE.md), now six tests, each resetting the shared mutable
// host at its START per the workers:1 discipline. Deliberately NOT a second spec
// file, for that reason.

// THE SHARED HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12): this spec pauses the
// one shared host, and a test that times out while paused never reaches its `finally`.
// `restoreHostAfterFailedTest` puts the host back to running after a failed or timed-out
// test only, logs `HOST RESTORED after <title>`, and never changes that test's verdict.
test.afterEach(async ({ page }, testInfo) => {
  await restoreHostAfterFailedTest(page, testInfo);
});

test.describe.configure({ mode: 'serial' });

/** FACTORY wire kind (mirrored from kinds.ts / 01-default-scene). */
const KIND_FACTORY = 2;
/** Port role bytes: In=0, Out=1, Fault=2. */
const ROLE_OUT = 1;
/** The verified-empty drop cell for a fresh 3x3 factory (demo occupies rows
 *  2..8; row 11 is clear - the 05-undo-strand-ring PLACE_CELL). */
const PLACE_CELL = [6, 11] as const;
/**
 * 74.1-14: the viewport the two legs that DRAW from a fresh factory's second Out run in.
 * Since the centre-out re-seat (the maintainer's ruling 2026-10-04, "Edits keep middle layout") a
 * second Out takes the factory's BOTTOM row, and at the demo camera a factory dropped at
 * PLACE_CELL puts that row at screen y 727, below the default 720-high viewport, so the
 * press on its nub lands off the page (measured). A taller viewport keeps the walk board
 * at (6,11) as the design ruling specifies; 17-order-example sizes its viewport the same way.
 */
async function tallViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
}

// ---------------------------------------------------------------------------
// Scene readers
// ---------------------------------------------------------------------------

type NodeFacts = SceneFacts['nodes'][number];

/** The (single) demo FACTORY, or a freshly placed one identified by `id`. */
function factoryOf(scene: SceneFacts, id?: number): NodeFacts {
  const node =
    id === undefined ? scene.nodes.find((n) => n.kind === KIND_FACTORY) : scene.nodes.find((n) => n.id === id);
  expect(node, 'the live scene carries the factory under test').toBeDefined();
  return node as NodeFacts;
}

/** How many Out (role 1) ports the factory currently has, live. */
function outCount(scene: SceneFacts, id?: number): number {
  return factoryOf(scene, id).ports.filter((p) => p.role === ROLE_OUT).length;
}

/** Every belt dock naming `id`, as sorted `end:port` strings - the LINK set,
 *  independent of where the ports happen to sit on the grid. */
function docksNaming(scene: SceneFacts, id: number): string[] {
  return scene.belts
    .flatMap((b) => b.docks)
    .filter((d) => d.node === id)
    .map((d) => `${d.end}:${d.port}`)
    .sort();
}

/** One belt as the scene oracle reports it. */
type BeltFacts = SceneFacts['belts'][number];
/** A grid cell, as `[x, y]`. */
type Cell = readonly [number, number];

/**
 * Every TAIL dock naming `id`, as sorted `Tail:<routing key>` strings (73-08).
 *
 * A Tail dock's `port` is the Out ROUTING key, which is exactly the value
 * `fold_remove_port` re-points, so this is the set the UNDO-06 leg reads. It is a
 * SET over the whole board rather than a per-belt read on purpose: "exactly one
 * belt is still docked to this node" is a property of the diff, and a per-belt
 * presence check is the assertion the old build passed.
 */
function tailDocks(scene: SceneFacts, id: number): string[] {
  return scene.belts
    .flatMap((b) => b.docks)
    .filter((d) => d.node === id && d.end === 'Tail')
    .map((d) => `Tail:${d.port}`)
    .sort();
}

/** A belt's tile path as `x,y` strings - its GEOMETRY, stable across a keyframe. */
function tilesOf(belt: BeltFacts): string[] {
  return belt.tiles.map((t) => `${t.cell_x},${t.cell_y}`);
}

/**
 * The belt whose FIRST tile is `cell`, or undefined.
 *
 * Belts are identified by their first tile rather than by render handle because a
 * `full: true` keyframe (which every undo emits) re-mints handles, while a belt's
 * tiles do not move unless something moves them - and "the second belt has not
 * moved" is one of the things this leg asserts.
 */
function beltAt(scene: SceneFacts, cell: Cell): BeltFacts | undefined {
  return scene.belts.find(
    (b) => b.tiles.length > 0 && b.tiles[0].cell_x === cell[0] && b.tiles[0].cell_y === cell[1],
  );
}

/** The factory's port cells as a stable string - the GEOMETRY, which is a
 *  different thing from the link set above. */
function portCells(scene: SceneFacts, id?: number): string {
  return factoryOf(scene, id)
    .ports.map((p) => `${p.role}@${p.cell_x},${p.cell_y}`)
    .join('|');
}

/** A node's footprint ANCHOR (min-x / min-y) - the cell the host seats it at. */
function anchorOf(node: NodeFacts): [number, number] {
  return [Math.min(...node.cells.map((c) => c[0])), Math.min(...node.cells.map((c) => c[1]))];
}

/**
 * A node's HANDLE-FREE identity: `kind@anchorX,anchorY`. Occupancy is exclusive,
 * so no two live machines can share an anchor cell, which makes this key unique
 * per board. It is used instead of the dense render handle wherever an identity
 * must survive a KEYFRAME (every undo/redo/load emits one, and a keyframe
 * re-mints handles). The anchor itself is stable under port edits: `grow_to_fit`
 * changes a footprint's w/h and never moves its anchor.
 */
function nodeKey(node: NodeFacts): string {
  const [x, y] = anchorOf(node);
  return `${node.kind}@${x},${y}`;
}

/** Every machine on the board as a sorted list of handle-free identities. */
function nodeKeys(scene: SceneFacts): string[] {
  return scene.nodes.map(nodeKey).sort();
}

/** The factory seated at anchor (ax, ay), re-resolved from the live scene. */
function factoryAtAnchor(scene: SceneFacts, ax: number, ay: number): NodeFacts | undefined {
  return scene.nodes.find((n) => {
    if (n.kind !== KIND_FACTORY) return false;
    const [x, y] = anchorOf(n);
    return x === ax && y === ay;
  });
}

/** Out-port count of the factory at (ax, ay); -1 when it is not on the board. */
function outsAtAnchor(scene: SceneFacts, ax: number, ay: number): number {
  const node = factoryAtAnchor(scene, ax, ay);
  return node ? node.ports.filter((p) => p.role === ROLE_OUT).length : -1;
}

/** The CURRENT dense handle of the factory at (ax, ay) - read fresh, never cached. */
async function handleAtAnchor(page: Page, ax: number, ay: number): Promise<number> {
  const node = factoryAtAnchor(await readScene(page), ax, ay);
  expect(node, `a factory is seated at anchor (${ax},${ay})`).toBeDefined();
  return (node as NodeFacts).id;
}

/**
 * Select a node by clicking its footprint ANCHOR cell (min-x/min-y) with real
 * pointer events. Re-resolved from the live scene every call on purpose: a full
 * keyframe (which every undo/redo/load emits) re-mints render handles, so a
 * cached id is not safe to reuse across one.
 */
async function selectFactory(page: Page, id?: number): Promise<NodeFacts> {
  const node = factoryOf(await readScene(page), id);
  const minX = Math.min(...node.cells.map((c) => c[0]));
  const minY = Math.min(...node.cells.map((c) => c[1]));
  const anchor = await screenCellCentre(page, minX, minY);
  await clickAt(page, anchor.x, anchor.y);
  await expect(
    page.getByRole('heading', { name: 'Factory', exact: true }),
    'the config panel mounts on the live selection',
  ).toBeVisible({ timeout: 10_000 });
  return node;
}

// ---------------------------------------------------------------------------
// Touch readers (74.1-14): what the user looks at on a docked belt end
// ---------------------------------------------------------------------------

/** The unit step toward a port side (N=0, E=1, S=2, W=3, y-down), the host's
 *  `unit_delta`. A port's FACING CELL is its cell plus this step, which is the
 *  `doorstepCell` definition in `src/protocol/ports.ts`. */
function sideStep(side: number): [number, number] {
  switch (side & 3) {
    case 0:
      return [0, -1];
    case 1:
      return [1, 0];
    case 2:
      return [0, 1];
    default:
      return [-1, 0];
  }
}

/** The routed `FAULT_PORT` sentinel a Fault dock is keyed on (`u16::MAX`). */
const FAULT_PORT = 65535;

/** One belt dock naming the factory, with the cells a hand sees: the port's facing
 *  cell, the belt's end tile and that tile's shipped kind. The belt is named by its
 *  FIRST tile, which a keyframe does not re-mint. */
interface DockTouch {
  dock: string;
  belt: string;
  facing: Cell;
  end: Cell;
  kind: unknown;
}

/**
 * Every dock naming `id`, resolved through the link keyspace (a Head key is a raw
 * catalog index, a Tail key the n-th Out, `FAULT_PORT` the first Fault) to the port
 * it names, sorted by dock.
 */
function dockTouches(scene: SceneFacts, id: number): DockTouch[] {
  const node = factoryOf(scene, id);
  const outs = node.ports.filter((p) => p.role === ROLE_OUT);
  const out: DockTouch[] = [];
  for (const b of scene.belts) {
    for (const d of b.docks) {
      if (d.node !== id) continue;
      const port =
        d.port === FAULT_PORT
          ? node.ports.find((p) => p.role === 2)
          : d.end === 'Head'
            ? node.ports.find((p) => p.index === d.port)
            : outs[d.port];
      expect(port, `the ${d.end}:${d.port} dock names a port on the factory`).toBeDefined();
      const p = port as NonNullable<typeof port>;
      const [dx, dy] = sideStep(p.side);
      const tile = d.end === 'Tail' ? b.tiles[0] : b.tiles[b.tiles.length - 1];
      out.push({
        dock: `${d.end}:${d.port}`,
        belt: tilesOf(b)[0],
        facing: [p.cell_x + dx, p.cell_y + dy],
        end: [tile.cell_x, tile.cell_y],
        kind: tile.kind,
      });
    }
  }
  return out.sort((a, b) => a.dock.localeCompare(b.dock));
}

/** The factory's ORIGINAL nubs (the first `n` catalog indices) by index, as cells. */
function originalNubs(scene: SceneFacts, n: number): string[] {
  return factoryOf(scene)
    .ports.filter((p) => p.index < n)
    .map((p) => `${p.index}:${p.role}@${p.cell_x},${p.cell_y}`);
}

/**
 * The four things a hand sees, unchanged from the shipped board: the same dock set,
 * each dock's port facing its belt's end tile, the original nubs on their cells, and
 * each docked end tile's shipped kind. The factory is re-resolved from the scene,
 * because a keyframe re-mints handles.
 */
function expectBoardUnmoved(
  scene: SceneFacts,
  linksBefore: string[],
  nubsBefore: string[],
  touchBefore: DockTouch[],
  ctx: string,
): void {
  const id = factoryOf(scene).id;
  expect(docksNaming(scene, id), `${ctx}: every belt is still docked to the factory`).toEqual(linksBefore);
  const touch = dockTouches(scene, id);
  expect(touch.length, `${ctx}: every dock is read`).toBe(linksBefore.length);
  for (const t of touch) {
    expect(t.facing, `${ctx}: the ${t.dock} belt's end tile is its nub's facing cell`).toEqual(t.end);
  }
  expect(originalNubs(scene, nubsBefore.length), `${ctx}: the original nubs keep their cells`).toEqual(
    nubsBefore,
  );
  expect(
    touch.map((t) => [t.dock, t.belt, t.kind]),
    `${ctx}: each docked end tile keeps its shipped kind`,
  ).toEqual(touchBefore.map((t) => [t.dock, t.belt, t.kind]));
}

// ---------------------------------------------------------------------------
// Panel locators (the SHIPPED accessible names - no test-only attributes)
// ---------------------------------------------------------------------------

const portsSection = (page: Page) => page.getByRole('region', { name: 'Ports' });
/** Out rows only: a Fault row's name starts "Fault - Item", so it never matches. */
const outRows = (page: Page): Locator =>
  portsSection(page).getByRole('listitem', { name: 'Output - Item' });
const addOutput = (page: Page) => portsSection(page).getByRole('button', { name: '+ Add output' });
const removeOutput = (page: Page, n: number) =>
  portsSection(page).getByRole('button', { name: `Remove output ${n}` });

/**
 * Move focus OFF the just-clicked control before a canvas accelerator. The
 * app-wide LW-02 guard stands the canvas keybindings (Ctrl+Z included) down while
 * a BUTTON holds focus, so this models the ordinary "click elsewhere, then press
 * undo" flow. Clicking the section's own header is a plain click on a
 * non-focusable element the panel absorbs (pointerEvents:auto), so the selection
 * survives it.
 */
async function blurControls(page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Outputs' }).click();
}

/** Phase 91 (D-12, CHROME-13, UI-SPEC 8.4): the note a Factory Out row carries when its
 *  port has a docked belt, and no other row. A literal on purpose: this spec restates what
 *  the panel says. */
const DOCKED_OUTPUT_NOTE = 'Removing this output disconnects its belt.';

/** Remove output `n` is offered and described by the docked-output note, on a visible
 *  element its `aria-describedby` resolves to. */
async function expectDockedOutputNote(page: Page, n: number): Promise<void> {
  const btn = page.getByRole('region', { name: 'Ports' }).getByRole('button', { name: `Remove output ${n}` });
  await expect(btn).toBeEnabled();
  const id = await btn.getAttribute('aria-describedby');
  expect(id, `remove ${n} names its note`).toBeTruthy();
  await expect(page.locator(`#${id}`)).toBeVisible();
  await expect(page.locator(`#${id}`)).toHaveText(DOCKED_OUTPUT_NOTE);
}

test.describe('PANEL-03 live: add AND remove outputs on the real host', () => {
  test('a "+ Add output" click grows the machine on the host and moves no belt off its nub, and Ctrl+Z / Ctrl+Shift+Z is ONE step', async ({
    page,
  }) => {
    // RE-AUTHORED IN 74.1-14 as a NAMED CHANGED OUTCOME (the maintainer's ruling of 2026-10-04,
    // "Edits keep middle layout"). Under 74.1-12 this leg asserted that the add moved
    // every nub and released every belt on the catalog-layout demo factory, and that
    // the undo re-docked the links while the nubs stayed moved. Since 74.1-14 a port
    // edit seats ports centre-out from the CATALOG box, so the add moves no existing
    // nub and lets go of no belt, and the undo leaves every nub where it shipped. What
    // the user looks at is graded here: which belts are docked, whether each docked
    // belt's end tile is its nub's facing cell, where the three original nubs sit, and
    // the shipped kind of each docked end tile (a corner stays a corner).
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectRenderLoopAlive(page, 'on the shipped demo board before the add');

    const scene0 = await readScene(page);
    const before = outCount(scene0);
    expect(before, 'the demo factory starts with at least one Out').toBeGreaterThan(0);
    // The demo factory is WIRED (In, Out and Fault all carry belts) - the case a hand
    // meets on the board the app boots into.
    const factoryId = factoryOf(scene0).id;
    const linksBefore = docksNaming(scene0, factoryId);
    expect(linksBefore.length, 'the demo factory is wired up before the add').toBeGreaterThan(0);
    const cellsBefore = portCells(scene0);
    const nubsBefore = originalNubs(scene0, factoryOf(scene0).ports.length);
    const touchBefore = dockTouches(scene0, factoryId);
    expect(touchBefore.length, 'measured: every demo factory dock is read').toBe(linksBefore.length);
    for (const t of touchBefore) {
      expect(t.facing, `on the shipped board, the ${t.dock} belt touches its nub`).toEqual(t.end);
    }

    await selectFactory(page);
    await expect(outRows(page), 'the panel lists the live Out ports').toHaveCount(before);

    // (1) ADD - the REAL host applies the certified AddPort fold and re-emits the
    // grown node. Nothing here is injected: the assertion is on the scene oracle
    // reading the packet the core produced.
    await addOutput(page).click();
    await pollScene(page, (s) => outCount(s), {
      message: 'the real host folded the AddPort: the factory grew an Out port',
    }).toBe(before + 1);
    // ...and the new row appears from that packet, with no re-selection: an
    // AddPort echo is a DIFF packet, so the panel stays mounted through it.
    await expect(outRows(page), 'the new Out row appears from the real packet').toHaveCount(
      before + 1,
    );

    // (1b) WHAT THE ADD DOES TO THE ALREADY-DOCKED BELTS (74.1-14): nothing.
    const afterAdd = await readScene(page);
    expectBoardUnmoved(afterAdd, linksBefore, nubsBefore, touchBefore, 'after the add');
    await expectRenderLoopAlive(page, 'after the add');

    // (2) UNDO - one Ctrl+Z reverses the WHOLE add (one command = one action =
    // one undo step, command.rs:1098-1101). The undo emits a full keyframe, which
    // by design clears the ephemeral selection (WR-01), so the panel unmounts and
    // is re-selected below rather than asserted through the keyframe.
    await blurControls(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => outCount(s), {
      message: 'a single Ctrl+Z reverses the whole AddPort on the real host',
    }).toBe(before);
    await selectFactory(page);
    await expect(outRows(page), 'the added row is gone after the real undo').toHaveCount(before);
    // ...and after the one step every nub is where it shipped and every belt is docked
    // and touching it: the residual 74.1-12 recorded (links back, nubs moved) is gone.
    const afterUndo = await readScene(page);
    expectBoardUnmoved(afterUndo, linksBefore, nubsBefore, touchBefore, 'after the undo');
    expect(portCells(afterUndo), 'one Ctrl+Z leaves every nub on its shipped cell').toBe(cellsBefore);
    await expectRenderLoopAlive(page, 'after the undo');

    // (3) REDO - and one Ctrl+Shift+Z brings it back, again in a single step.
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => outCount(s), {
      message: 'a single Ctrl+Shift+Z re-applies the whole AddPort on the real host',
    }).toBe(before + 1);
    await selectFactory(page);
    await expect(outRows(page), 'the added row is back after the real redo').toHaveCount(
      before + 1,
    );
    await expectRenderLoopAlive(page, 'after the redo');
    errs.assertNone('through the add, the undo and the redo');
  });

  test('the added output SURVIVES a real Save -> New -> Load round-trip of the .fab edit_log', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    const before = outCount(await readScene(page));
    await selectFactory(page);
    await addOutput(page).click();
    await pollScene(page, (s) => outCount(s), {
      message: 'the AddPort folded before the save',
    }).toBe(before + 1);

    // Deselect before driving the TOOLBAR: the config panel is a top-right
    // overlay that covers part of the header strip, so its own heading would
    // intercept the Save click while it is mounted. Blur first - the LW-02 guard
    // stands Escape down too while a button holds focus.
    await blurControls(page);
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: 'Factory', exact: true }),
      'the panel unmounts on deselect, clearing the toolbar',
    ).toBeHidden({ timeout: 10_000 });

    // (1) SAVE the real project file (the host writes it at quiescence). The dev
    // path raises a browser prompt for the path - the same control 09-save-load
    // drives.
    const savePath = join(tmpdir(), `fabrico-e2e-addport-${Date.now()}.fab`);
    page.once('dialog', (d) => d.accept(savePath));
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
    await expect
      .poll(() => existsSync(savePath), {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: 'the host wrote the .fab project file (a real artifact on disk)',
      })
      .toBe(true);

    // (2) NEW - wipe to a genuinely empty board, so a surviving port after the
    // load cannot possibly be a leftover of the pre-save state.
    await page.getByTitle('New board (Ctrl+N)').click();
    await pollScene(page, (s) => s.nodes.length, {
      message: 'New swapped in a truly empty grid before the load',
    }).toBe(0);

    // (3) LOAD it back: the added Out is re-derived by REPLAYING the edit_log
    // through the certified fold, not restored from any frontend memory.
    page.once('dialog', (d) => d.accept(savePath));
    await page.getByTitle('Load a saved factory').click();
    await pollScene(page, (s) => (s.nodes.length > 0 ? outCount(s) : -1), {
      message: 'the loaded factory still carries the added Out (the edit_log round-tripped it)',
    }).toBe(before + 1);

    // ...and the panel reads it back off the loaded scene.
    await selectFactory(page);
    await expect(outRows(page), 'the added Out row is present after the load').toHaveCount(
      before + 1,
    );

    await expectRenderLoopAlive(page, 'at the end of the save, new and load round trip');
    errs.assertNone('the save, new and load round trip');
  });

  test('a belt docked to a LATER Out leaves the EARLIER (unconnected) Out\'s remove OFFERED - the index-shift case, against the real host (73-08)', async ({
    page,
  }) => {
    await tallViewport(page);
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    // A FRESH, fully undocked factory: the positive control matters as much as
    // the block. On the demo factory the first Out already has a belt, so a
    // disabled remove there would prove nothing about the renumber hazard.
    const beforeIds = new Set(
      (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id),
    );
    await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
      message: 'the real host echoes the placed factory',
    }).toBe(beforeIds.size + 1);
    // Identify it by DIFFING the kind-2 handles (the 05-undo-strand-ring idiom):
    // the drop cell is where the pointer went, not necessarily the anchor the
    // host seats the 3x3 footprint at.
    const placed = (await readScene(page)).nodes.find(
      (n) => n.kind === KIND_FACTORY && !beforeIds.has(n.id),
    );
    expect(placed, 'the freshly placed factory is found by diffing kind-2 handles').toBeDefined();
    const placedId = (placed as NodeFacts).id;

    // POSITIVE CONTROL: an undocked Out on an undocked machine IS removable.
    await selectFactory(page, placedId);
    await expect(
      removeOutput(page, 1),
      'a clean Out on a clean machine is offered for removal',
    ).toBeEnabled();

    // Grow a SECOND Out, so there is an earlier/later pair to renumber.
    await addOutput(page).click();
    await pollScene(page, (s) => outCount(s, placedId), {
      message: 'the fresh factory grew a second Out',
    }).toBe(2);
    await expect(removeOutput(page, 1), 'both Outs are still clean').toBeEnabled();
    await expect(removeOutput(page, 2)).toBeEnabled();

    // Dock a real belt to the SECOND Out: arm the belt tool and start the draw ON
    // that Out's nub (the shipped port-to-port draw seeds a Tail dock), then run
    // two cells east and release. The host mints the belt + the Tail link.
    const secondOut = factoryOf(await readScene(page), placedId).ports.filter(
      (p) => p.role === ROLE_OUT,
    )[1];
    const nub = await screenPoint(page, nubAnchor(secondOut.cell_x, secondOut.cell_y, secondOut.side));
    // The draw seeds at the cell the port FEEDS (port cell + 1 east for an E-side
    // Out), so the release cell is two beyond it - a straight, empty run.
    const release = await screenCellCentre(page, secondOut.cell_x + 3, secondOut.cell_y);
    // Prefix-matched, not exact: this Belt tool title is user-facing COPY that
    // doubles as a SELECTOR, so an exact match makes every copy edit a
    // five-spec breakage (52-05). `Draw belts` stays unique in the palette.
    await page.getByTitle(/^Draw belts/).click();
    await page.mouse.move(nub.x, nub.y);
    await page.mouse.down();
    await page.mouse.move(release.x, release.y, { steps: 6 });
    await page.mouse.up();

    // The dock the HOST recorded: a Tail dock naming this node with Out ROUTING
    // key 1 (the second role-1 port). This is the real link, read off the packet.
    await pollScene(
      page,
      (s) =>
        s.belts.some((b) =>
          b.docks.some((d) => d.end === 'Tail' && d.node === placedId && d.port === 1),
        ),
      { message: 'the real host docked the drawn belt to the SECOND Out (routing key 1)' },
    ).toBe(true);

    // THE INDEX-SHIFT CASE, live, and 73-08 INVERTED WHAT IT ASSERTS. The FIRST
    // Out is completely unconnected; removing it shifts the second Out down a
    // routing key. Until this phase the panel refused to offer that, because
    // `fold_remove_port` re-seated positionally and touched no links, so the
    // second belt silently started draining a different output.
    //
    // UNDO-04 and UNDO-05 closed it in the core: the fold re-keys every surviving
    // dock and re-points `routes` and `default`, so the later belt stays on its OWN
    // output. Both rows are therefore offered, and neither carries a reason.
    //
    // WHAT WENT WITH THE GATE, recorded rather than silently dropped. This block
    // used to pin the exact `later-dock` sentence, and carried a 2026-08-30 note
    // from plan 67-07 about the copy sweep that missed `frontend/e2e-live` and
    // reddened the live gate at a phase exit. That lesson is not this phase's to
    // re-learn: the sweep is now a zero-hit grep over all three directories in
    // 73-08's own verify arms. The sentence itself no longer exists.
    await selectFactory(page, placedId);
    const rows = outRows(page);
    await expect(rows).toHaveCount(2);
    await expect(rows.first(), 'the earlier Out carries no belt of its own').toContainText(
      'not connected',
    );
    await expect(
      removeOutput(page, 1),
      'the earlier Out is OFFERED against the REAL host (73-08)',
    ).toBeEnabled();
    expect(
      await removeOutput(page, 1).getAttribute('aria-describedby'),
      'and carries no reason element: absence, not a reworded sentence',
    ).toBeNull();

    // ...and so is the docked Out, which is the `own-dock` half. Since phase 91 (D-12,
    // UI-SPEC 8.4) its row says what the press costs, the only row that does: its belt
    // is released with the output.
    await expect(rows.nth(1)).not.toContainText('not connected');
    await expect(removeOutput(page, 2), 'the DOCKED Out is offered too').toBeEnabled();
    await expectDockedOutputNote(page, 2);

    await expectRenderLoopAlive(page, 'at the end of the index-shift case');
    errs.assertNone('the index-shift case');
  });

  test('a PAUSED host HOLDS the edit: two clicks add exactly ONE port, and the latch releases on the real fold (CR-01)', async ({
    page,
  }) => {
    // The decisive CR-01 case, and the one no mock can prove. The panel used to
    // release its in-flight latch after 1000ms and tell the user the host had
    // rejected the edit. But `SimLoop::step` skips `acquire_input()` in
    // RunState::Frozen and HOLDS input in RunState::Draining
    // (sim_loop.rs:1520-1589), and the gesture channel is unbounded - so an edit
    // made while paused is buffered until Resume. The panel accused a host that
    // had done nothing wrong, and the user's obvious response - click again -
    // queued a SECOND AddPort that folded on Resume alongside the first. Two
    // ports from one gesture, two Ctrl+Z to reverse; the RemovePort version of
    // the same double-fold splices a port the safety gate never evaluated.
    //
    // Both directions are asserted here against the real host:
    //   * the double-send stays impossible while the sim is paused, past the old
    //     self-heal window, and
    //   * the single edit still completes on Resume and re-enables the control.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    const before = outCount(await readScene(page));
    await selectFactory(page);
    await expect(outRows(page)).toHaveCount(before);

    // PAUSE, and wait for the host to actually settle - a Pause first DRAINS
    // (RunState::Draining ticks while holding input) before freezing, and only a
    // stable tick proves we are past that.
    await page.getByTitle('Pause (Space)').click();
    await expect
      .poll(
        async () => {
          const a = (await readScene(page)).tick;
          await page.waitForTimeout(400);
          return (await readScene(page)).tick === a;
        },
        { timeout: 30_000, message: 'the paused sim settled to a frozen tick' },
      )
      .toBe(true);
    const frozenTick = (await readScene(page)).tick;

    // CLICK ONCE. The host cannot acquire this gesture; it sits in the channel.
    await addOutput(page).click();
    await expect(addOutput(page), 'the latch closes on the send').toBeDisabled();
    // ...and the panel says what it actually knows, rather than guessing a
    // verdict it has no channel for.
    await expect(portsSection(page).getByRole('status')).toHaveText(
      'The sim is paused - this change applies when you resume.',
    );

    // WAIT past the old 1000ms self-heal, then CLICK AGAIN - the exact sequence
    // the old behaviour invited (release the latch, accuse the host, and let the
    // user's retry queue the duplicate). The load-bearing assertion is that the
    // control is STILL disabled after the old window has elapsed: a reintroduced
    // timer fails right here. The click that follows confirms the end-to-end
    // consequence on the real host - exactly one port after Resume.
    await page.waitForTimeout(1600);
    await expect(addOutput(page), 'the latch does not release on elapsed time').toBeDisabled();
    await expect(page.getByRole('alert'), 'a held edit is not an error').toHaveCount(0);
    await addOutput(page).click({ force: true });
    await page.waitForTimeout(300);
    expect(
      (await readScene(page)).tick,
      'the sim really was frozen throughout (nothing folded behind our back)',
    ).toBe(frozenTick);

    // ...AND THE DESELECT/RESELECT PATH (CR-01, iteration 3). This is the
    // sequence the previous shape lost to, and it is not a perverse one: with the
    // latch durable, clicking away and back is the ONLY way the panel will accept
    // a second port edit during a paused build, and the panel's own copy above
    // invites the user to keep building while paused. The latch used to live in a
    // `useRef` inside ConfigPanel, which App remounts per selection
    // (`key={selectedNode}`) - so this deselect threw the in-flight record away
    // while the AddPort was still in the host's unbounded gesture channel, and the
    // remounted panel offered the identical edit again. Three clicks, two folds,
    // one intended gesture. It now lives on the node in App instead.
    await blurControls(page);
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: 'Factory', exact: true }),
      'the panel really unmounted on deselect',
    ).toBeHidden({ timeout: 10_000 });
    await selectFactory(page);
    await expect(
      addOutput(page),
      'the latch outlived the panel instance that opened it',
    ).toBeDisabled();
    await expect(portsSection(page).getByRole('status')).toHaveText(
      'The sim is paused - this change applies when you resume.',
    );
    await addOutput(page).click({ force: true });
    expect(
      (await readScene(page)).tick,
      'the sim is still frozen after the reselect sequence',
    ).toBe(frozenTick);

    // RESUME: the held gesture folds. EXACTLY ONE port, from FOUR clicks across
    // two panel instances.
    await page.getByTitle('Play (Space)').click();
    await pollScene(page, (s) => outCount(s), {
      message: 'the held AddPort folds on resume',
    }).toBe(before + 1);
    await expect(outRows(page)).toHaveCount(before + 1);
    // Settle, then re-check: a SECOND buffered AddPort would fold in the same or
    // an adjacent tick, so this is where a regression would show.
    await page.waitForTimeout(1000);
    expect(
      outCount(await readScene(page)),
      'four clicks across two panel instances folded exactly ONE AddPort',
    ).toBe(before + 1);

    // ...and the other direction: the real fold released the latch, so the panel
    // is usable again with no error left behind.
    await expect(addOutput(page), 'the observed fold re-enabled the control').toBeEnabled();
    await expect(portsSection(page).getByRole('status')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);

    // WR-05: the SUCCESS path on a RUNNING host, which had no coverage anywhere -
    // the live suite only ever clicked each edit control once, and both mock
    // latch tests ran against a host that folds nothing, so "released too early",
    // "never released" and "works" were indistinguishable. A second click on the
    // now-running host must fold a second port, with no residual latch and no
    // alert.
    await addOutput(page).click();
    await pollScene(page, (s) => outCount(s), {
      message: 'a SECOND add on the running host folds too - the latch is not sticky',
    }).toBe(before + 2);
    await expect(outRows(page)).toHaveCount(before + 2);
    await expect(addOutput(page), 'still usable after two consecutive edits').toBeEnabled();
    await expect(page.getByRole('alert'), 'a folded edit never raises an error').toHaveCount(0);
    await expect(portsSection(page).getByRole('status')).toHaveCount(0);

    // Hygiene: this spec pauses the SHARED host and LoadDemo respects a user
    // pause (15-disconnected), so leave it PLAYING for every later spec. The
    // Resume above already did that; assert it rather than assume it.
    await expect(page.getByTitle('Pause (Space)'), 'the shared host is left running').toBeVisible();

    await expectRenderLoopAlive(page, 'at the end of the paused-host edit hold');
    errs.assertNone('the paused-host edit hold');
  });

  // -------------------------------------------------------------------------
  // 51-06 GAP CLOSURE: the two arms that were missing, and whose absence let a
  // broken half of this feature pass every gate. Both run on the DEFAULT DEMO
  // BOARD on purpose - the verifier's own control experiment on an EMPTY board
  // PASSED while the demo board failed, because the demo boot then minted four
  // nodes (its caller and handler and their two cables) straight onto the core
  // state outside the edit log, and the undo projection was rebuilt by re-folding
  // that log on a throwaway genesis core. An empty-board arm here would be worth
  // nothing, and the demo board stays the board these arms run on.
  // -------------------------------------------------------------------------

  test('removing an output and pressing Ctrl+Z BRINGS IT BACK on the default demo board (ROADMAP SC2)', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    // A FRESH factory ON the demo board: fresh because a just-placed machine
    // carries no docked belts, so the Out it grows is provably dock-safe and the
    // remove control is genuinely ENABLED (on the demo factory the gate would
    // block it and this arm would prove nothing about undo). This is the exact
    // sequence the phase verifier ran 4x against this same server:
    // place -> + Add output -> remove that Out -> Ctrl+Z -> Ctrl+Shift+Z.
    const factoriesBefore = new Set(
      (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id),
    );
    await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
      message: 'the real host echoes the placed factory onto the demo board',
    }).toBe(factoriesBefore.size + 1);
    const placed = (await readScene(page)).nodes.find(
      (n) => n.kind === KIND_FACTORY && !factoriesBefore.has(n.id),
    );
    expect(placed, 'the freshly placed factory is found by diffing kind-2 handles').toBeDefined();
    // From here the factory is tracked by ANCHOR, not by handle: the undo and the
    // redo below each emit a full keyframe, and a keyframe re-mints dense render
    // handles. The anchor survives both the keyframes and the footprint growth an
    // AddPort causes.
    const [ax, ay] = anchorOf(placed as NodeFacts);

    const placedOuts = outsAtAnchor(await readScene(page), ax, ay);
    expect(placedOuts, 'a fresh factory boots with at least one Out').toBeGreaterThan(0);

    await selectFactory(page, await handleAtAnchor(page, ax, ay));
    await expect(outRows(page), 'the panel lists the fresh factory Out ports').toHaveCount(
      placedOuts,
    );

    // (1) ADD - grow a second Out through the real certified AddPort fold, so the
    // remove below is a remove of a port THIS TEST minted on the real host.
    await addOutput(page).click();
    await pollScene(page, (s) => outsAtAnchor(s, ax, ay), {
      message: 'the real host folded the AddPort on the fresh factory',
    }).toBe(placedOuts + 1);
    const afterAdd = placedOuts + 1;
    await expect(outRows(page), 'the added Out row arrived on a real packet').toHaveCount(afterAdd);

    // (2) REMOVE that Out. Both Outs are undocked, so the safety gate offers it -
    // asserted, because a DISABLED control would make the rest of this test a
    // silent no-op rather than a failure.
    await expect(
      removeOutput(page, afterAdd),
      'the freshly added, undocked Out is offered for removal',
    ).toBeEnabled();
    await removeOutput(page, afterAdd).click();
    await pollScene(page, (s) => outsAtAnchor(s, ax, ay), {
      message: 'the real host folded the RemovePort: the Out is gone',
    }).toBe(placedOuts);
    await expect(outRows(page), 'the removed row left the panel').toHaveCount(placedOuts);

    // (3) THE ASSERTION THAT WAS FALSE. Before 51-04 this poll timed out with the
    // Out count still at `placedOuts`: the undo cursor moved, the inverse group
    // was emitted with its restoring AddPort silently absent, and the port was
    // gone for good. Fixed by live-authoritative undo captures
    // (`live_removed_ports`), pinned Rust-side by
    // undo_on_demo_board.rs#remove_undo_restores_the_port_on_the_demo_board.
    await blurControls(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => outsAtAnchor(s, ax, ay), {
      message:
        'a single Ctrl+Z RESTORES the removed Out on the default demo board (ROADMAP SC2, the half that was broken)',
    }).toBe(afterAdd);
    await selectFactory(page, await handleAtAnchor(page, ax, ay));
    await expect(outRows(page), 'the restored Out row is back in the panel').toHaveCount(afterAdd);

    // (4) ...and ONE Ctrl+Shift+Z removes it again - one step in each direction.
    await page.keyboard.press('Control+Shift+z');
    await pollScene(page, (s) => outsAtAnchor(s, ax, ay), {
      message: 'a single Ctrl+Shift+Z re-applies the whole RemovePort on the real host',
    }).toBe(placedOuts);
    await selectFactory(page, await handleAtAnchor(page, ax, ay));
    await expect(outRows(page), 'the Out is removed again after the real redo').toHaveCount(
      placedOuts,
    );

    await expectRenderLoopAlive(page, 'at the end of the remove and undo walk');
    errs.assertNone('the remove and undo walk');
  });

  test('placing a machine and pressing Ctrl+Z removes THAT machine, and every other machine survives', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    // The whole board, by handle-free identity, BEFORE the place. The set is the
    // point: before 51-04, one Ctrl+Z after a Place on this board left the placed
    // factory STANDING and silently deleted `NodeId(19v1)` - the demo's handler -
    // instead. The node COUNT was correct throughout, so a count assertion would
    // have passed while the user lost a machine they never touched.
    const before = await readScene(page);
    const keysBefore = nodeKeys(before);
    const wiresBefore = before.wires.length;
    const beltsBefore = before.belts.length;
    expect(keysBefore.length, 'the demo board is seeded before the place').toBeGreaterThan(0);

    await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the real host echoes the placed factory',
    }).toBe(before.nodes.length + 1);

    const afterPlace = await readScene(page);
    const keysAfterPlace = nodeKeys(afterPlace);
    const minted = keysAfterPlace.filter((k) => !keysBefore.includes(k));
    expect(minted, 'the place added exactly one machine').toHaveLength(1);
    expect(
      keysBefore.filter((k) => !keysAfterPlace.includes(k)),
      'the place itself destroyed nothing',
    ).toEqual([]);
    const placedKey = minted[0];
    const placedNode = afterPlace.nodes.find((n) => nodeKey(n) === placedKey) as NodeFacts;

    // Select + blur so the canvas accelerator is live (the app-wide LW-02 guard
    // stands Ctrl+Z down while a BUTTON - here the palette item that armed the
    // placement - still holds focus).
    await selectFactory(page, placedNode.id);
    await blurControls(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => s.nodes.length, {
      message: 'a single Ctrl+Z reverses the Place on the real host',
    }).toBe(before.nodes.length);

    const afterUndo = await readScene(page);
    const keysAfterUndo = nodeKeys(afterUndo);

    // Half one: the machine that went is the machine that was placed.
    expect(keysAfterUndo, 'the undo removed the machine that was just placed').not.toContain(
      placedKey,
    );
    // Half two - the destructive symptom, as a SET DIFFERENCE. This is the
    // assertion a node count cannot make.
    expect(
      keysBefore.filter((k) => !keysAfterUndo.includes(k)),
      "the undo destroyed a PRE-EXISTING machine (the NodeId(19v1) symptom: the placed machine survives while one of the demo's caller and handler nodes is silently deleted)",
    ).toEqual([]);
    // ...and the whole board, sealed in one comparison.
    expect(keysAfterUndo, 'the board is exactly as it was before the place').toEqual(keysBefore);
    expect(
      afterUndo.wires.length,
      "the demo's request/response wires survive the undo",
    ).toBe(wiresBefore);
    expect(afterUndo.belts.length, 'no belt was collaterally removed by the undo').toBe(
      beltsBefore,
    );

    await expectRenderLoopAlive(page, 'at the end of the place and undo walk');
    errs.assertNone('the place and undo walk');
  });

  // -------------------------------------------------------------------------
  // UNDO-06 (73-08): walk steps 4, 5 and 6 on the board 73-WALK-BOARD.md names.
  // -------------------------------------------------------------------------
  // RE-AUTHORED IN 74.1-12 as a NAMED CHANGED OUTCOME (was "UNDO-06: removing a docked
  // output releases EXACTLY ONE belt, and one Ctrl+Z puts the output and its belt back").
  // Removing the first output re-seats the second one row up, so since 74.1-12 its belt,
  // which no longer touches it, is released too. A default the maintainer judges on the 74.1
  // re-walk; REQUIREMENTS.md UNDO-06 carries the dated amendment.
  test('UNDO-06 (restored 74.1-16): removing a docked output releases exactly its own belt, the other output and its belt do not move, and one Ctrl+Z puts the output and its belt back', async ({
    page,
  }) => {
    // RENDER HEALTH FOR THE WHOLE LEG, not as ceremony. The live oracle reads the
    // MODEL, so a dead PixiJS renderer passes every model assertion below - this
    // project's recorded blind spot, and the thing that in wave 6 exposed a board
    // that loaded, sat Frozen and silently swallowed every gesture.
    const errs = watchPageErrors(page);
    await tallViewport(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await expectRenderLoopAlive(page, 'on the shipped demo board before the walk');

    // ---- STEP 1-3: BUILD THE WALK BOARD, which is a FRESH Factory at (6,11) and
    // deliberately NOT the demo Factory. `fresh-factory` was chosen on 2026-09-05
    // and REQUIREMENTS step 3 was amended to match. The reason was measured then:
    // on the demo Factory one `+ Add output` re-seated every port and put the new
    // nub at (6,3) facing (7,3), where belt 10 already ran, so the drag had nowhere
    // to start (WINDOWS 204). That is no longer true: since plan 74.1-16 a port edit
    // moves no existing port, the added Out lands at (6,4) facing a free (7,4), and
    // phase 92's walk docked a belt to it at both ends (`WALK_204 docked=1`;
    // WINDOWS 204 closed in phase 92, its comment here corrected by the phase 92
    // review, WR-C-05). The leg keeps the fresh Factory as ruled. (6,11) was
    // measured clear on all four ports after one Add output.
    const beforeIds = new Set(
      (await readScene(page)).nodes.filter((n) => n.kind === KIND_FACTORY).map((n) => n.id),
    );
    await armAndPlaceFactoryAt(page, PLACE_CELL[0], PLACE_CELL[1]);
    await pollScene(page, (s) => s.nodes.filter((n) => n.kind === KIND_FACTORY).length, {
      message: 'the real host echoes the placed factory',
    }).toBe(beforeIds.size + 1);
    const placedId = ((await readScene(page)).nodes.find(
      (n) => n.kind === KIND_FACTORY && !beforeIds.has(n.id),
    ) as NodeFacts).id;

    await selectFactory(page, placedId);

    // THE NUB PLOT, read off the Pixi Graphics rather than off the port list (73-10).
    // Everything else in this leg reads the MODEL, and so does the app's own hit test
    // (`gestures.ts nubsInRadius` walks `worldNubSpecs`), so the belt drags below dock
    // to a nub the user cannot necessarily see. That is not a hypothetical: at 73-08 the
    // nub overlay's invalidation key carried kind|state|load|w|h|rot|lod and NO port
    // token, and `+ Add output` on a Factory moves none of those seven - grow_to_fit on
    // 1 In / 2 Out / 1 Fault gives min 2x2, floored up by the Factory's 3x3 base. So the
    // overlay was never re-plotted: the added nub was missing AND, because
    // `reseat_ports` then re-seated by index-among-role (before 74.1-14), all three
    // survivors were left at their pre-add cells. This whole leg passed over that board.
    //
    // A COUNT, not a presence check. The defect leaves a STALE plot, not an empty one,
    // so "are any nubs painted" is true on the broken build and asserts nothing. An Out
    // is a disc plus a stem, so a fourth port MOVES this number.
    const nubsAtThree = await portNubInstructionsOn(page, placedId);
    expect(
      nubsAtThree,
      'the fresh Factory has its three catalog nubs on the canvas to begin with - a ' +
        'zero here means the overlay is gated off (LOD) and the assertions below would ' +
        'be vacuous',
    ).toBeGreaterThan(0);

    await addOutput(page).click();
    await pollScene(page, (s) => outCount(s, placedId), {
      message: 'the fresh factory grew a second Out',
    }).toBe(2);
    // PROVED TO BITE: with the `portFingerprint` token reverted out of `machines.ts`
    // this line fails with 5 (received) vs 5 (nubsAtThree) - the plot frozen at the
    // three-port geometry - while every model assertion in this leg still passes.
    await expect
      .poll(async () => portNubInstructionsOn(page, placedId), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'added output plotted poll'),
        intervals: [100, 250, 500],
        message: 'the added output was PLOTTED, not merely added to the model',
      })
      .toBeGreaterThan(nubsAtThree);
    const nubsAtFour = await portNubInstructionsOn(page, placedId);

    // A belt from EACH output nub, drawn by the shipped gesture so the Tail dock
    // is seeded by the press on the nub (`gestures.ts` :2374-2537, the release
    // branch; the auto-dock fallback the requirement means is :2506-2529, NOT the
    // :2163-2220 range REQUIREMENTS.md cites, which is the DrawWire ghost).
    for (const ordinal of [0, 1]) {
      const out = factoryOf(await readScene(page), placedId).ports.filter(
        (p) => p.role === ROLE_OUT,
      )[ordinal];
      const nub = await screenPoint(page, nubAnchor(out.cell_x, out.cell_y, out.side));
      // The press seeds at the cell the port FEEDS (port cell + 1 east for an
      // E-side Out), so a release two cells east is a straight two-tile run
      // through cells the walk board measured clear.
      const release = await screenCellCentre(page, out.cell_x + 2, out.cell_y);
      await page.getByTitle(/^Draw belts/).click();
      await page.mouse.move(nub.x, nub.y);
      await page.mouse.down();
      await page.mouse.move(release.x, release.y, { steps: 6 });
      await page.mouse.up();
      // DISARM, or the belt tool stays armed for a follow-up draw and the NEXT
      // palette click toggles it OFF rather than on - measured: without this the
      // second belt is never drawn at all and the leg silently degrades to the
      // one-belt board, where "exactly one strand" cannot be told from "every
      // belt strands".
      await page.keyboard.press('Escape');
      await pollScene(page, (s) => tailDocks(s, placedId).length, {
        message: `the real host docked the belt drawn from Out ${ordinal + 1}`,
      }).toBe(ordinal + 1);
    }

    // The board, read off the packet: two belts, on routing keys 0 and 1, each
    // starting at its own output's facing cell. Each belt is identified by its OWN
    // TILES from here on (review IN-02): belt render handles are re-minted by the
    // Ctrl+Z keyframe, tiles are not, and a sorted key list cannot tell two belts
    // apart.
    const built = await readScene(page);
    expect(tailDocks(built, placedId), 'one belt per output, on its own routing key').toEqual([
      'Tail:0',
      'Tail:1',
    ]);
    const outsBuilt = factoryOf(built, placedId).ports.filter((p) => p.role === ROLE_OUT);
    const releasedTail: Cell = [outsBuilt[0].cell_x + 1, outsBuilt[0].cell_y];
    const survivorTail: Cell = [outsBuilt[1].cell_x + 1, outsBuilt[1].cell_y];
    expect(beltAt(built, releasedTail), 'the belt on Out 1 is on the board').toBeDefined();
    expect(beltAt(built, survivorTail), 'the belt on Out 2 is on the board').toBeDefined();
    const releasedTilesBefore = tilesOf(beltAt(built, releasedTail) as BeltFacts);
    const survivorTilesBefore = tilesOf(beltAt(built, survivorTail) as BeltFacts);
    // Each belt's OWN dock, by identity: the belt on Out 1 is Tail:0, the belt on Out 2
    // is Tail:1.
    const dockOf = (scene: SceneFacts, cell: Cell): string[] =>
      ((beltAt(scene, cell) as BeltFacts).docks ?? []).map((d) => `${d.end}:${d.node}:${d.port}`);
    expect(dockOf(built, releasedTail), 'the belt on Out 1 is docked to it, key 0').toEqual([
      `Tail:${placedId}:0`,
    ]);
    expect(dockOf(built, survivorTail), 'the belt on Out 2 is docked to it, key 1').toEqual([
      `Tail:${placedId}:1`,
    ]);
    // Every port cell, captured BEFORE the removal, to compare after the Ctrl+Z.
    const cellsBefore = portCells(built, placedId);
    // 74.1-27 (review WR-06, walk item N5): WHERE the rings must be and must not be,
    // captured BEFORE the removal, in world px. The removed output's nub is gone from the
    // port list after the click, so its anchor can only be read now; the ring that marks
    // it belongs where the user last saw that nub. Each belt end is its Tail tile's
    // centre, the end docked to the output.
    const removedNubBefore = nubAnchor(outsBuilt[0].cell_x, outsBuilt[0].cell_y, outsBuilt[0].side);
    const survivorNub = nubAnchor(outsBuilt[1].cell_x, outsBuilt[1].cell_y, outsBuilt[1].side);
    const releasedEnd = { x: cellCentre(releasedTail[0]), y: cellCentre(releasedTail[1]) };
    const survivorEnd = { x: cellCentre(survivorTail[0]), y: cellCentre(survivorTail[1]) };
    // The touch, read for every dock at every step: a kept link must touch its port.
    const expectEveryDockTouches = (scene: SceneFacts, n: number, ctx: string): void => {
      const touch = dockTouches(scene, placedId);
      expect(touch.length, `${ctx}: ${n} docks name the factory`).toBe(n);
      for (const t of touch) {
        expect(t.facing, `${ctx}: the ${t.dock} belt's end tile is its port's facing cell`).toEqual(t.end);
      }
    };
    expectEveryDockTouches(built, 2, 'the built board');
    await expectRenderLoopAlive(page, 'on the built walk board');

    // ---- STEP 4: the first Output row's Remove is OFFERED, with no reason.
    //
    // RED ON THE OLD BUILD BY CONSTRUCTION, not by fixture accident: the deleted
    // frontend gate answered `own-dock` for any Out carrying a link, so this row
    // rendered `disabled` under "Disconnect it first". The walk board measured
    // exactly that on the real binary at HEAD.
    await selectFactory(page, placedId);
    await expect(outRows(page)).toHaveCount(2);
    await expect(
      removeOutput(page, 1),
      'the DOCKED first Out is offered for removal (73-08)',
    ).toBeEnabled();
    // Phase 91 (D-12, UI-SPEC 8.4): no block reason, only the consequence of the press.
    await expectDockedOutputNote(page, 1);

    // ---- STEP 5: one click. EXACTLY ONE belt lets go (74.1-16, the maintainer's ruling N5 of
    // 2026-10-04: "I wouldn't for now shift the output up ... for now I wouldn't auto
    // arrange them"). The removed output's belt is released; the second output keeps
    // its cell, so its belt stays docked, re-keyed from 1 to 0 by identity, and still
    // touches it. This is UNDO-06's original "exactly one strand, not two", restored:
    // plan 74.1-12 had re-seated the second output into the first one's row and
    // released both.
    await removeOutput(page, 1).click();
    await pollScene(page, (s) => outCount(s, placedId), {
      message: 'the real host folded the RemovePort on a DOCKED output',
    }).toBe(1);
    const removed = await readScene(page);

    // GEOMETRY FIRST: the remaining output did not move, and nothing else did either.
    const outsAfter = factoryOf(removed, placedId).ports.filter((p) => p.role === ROLE_OUT);
    expect(outsAfter, 'one output remains').toHaveLength(1);
    expect(
      [outsAfter[0].cell_x, outsAfter[0].cell_y],
      'the remaining output is the second one, on its own unmoved cell',
    ).toEqual([outsBuilt[1].cell_x, outsBuilt[1].cell_y]);
    const removedIndex = outsBuilt[0].index;
    expect(
      portCells(removed, placedId),
      'every port but the removed one keeps its cell (the machine neither moves nor shrinks)',
    ).toEqual(
      factoryOf(built, placedId)
        .ports.filter((p) => p.index !== removedIndex)
        .map((p) => `${p.role}@${p.cell_x},${p.cell_y}`)
        .join('|'),
    );

    // THE RELEASE, BY IDENTITY: the released belt is the one on the removed output and
    // has no dock; the other belt is still docked to its OWN output, on its re-keyed
    // routing key 0, and touches it.
    expect(tailDocks(removed, placedId), 'exactly one belt is still docked to this node').toEqual([
      'Tail:0',
    ]);
    expect(dockOf(removed, releasedTail), 'the belt on the REMOVED output was released').toEqual([]);
    expect(
      dockOf(removed, survivorTail),
      'the other belt is still docked to its own output, re-keyed 1 -> 0',
    ).toEqual([`Tail:${placedId}:0`]);
    expectEveryDockTouches(removed, 1, 'after the removal');
    expect(tilesOf(beltAt(removed, releasedTail) as BeltFacts), 'the released belt has not moved a tile').toEqual(
      releasedTilesBefore,
    );
    expect(tilesOf(beltAt(removed, survivorTail) as BeltFacts), 'the other belt has not moved a tile').toEqual(
      survivorTilesBefore,
    );

    // The RING. It ships already: the release is a consequence of the core
    // dropping the link, and `detectStrandedDocks` reads the belt's DOCK SET in
    // the diff packet, so no render code was written for this phase.
    //
    // THE RESIDUAL IS CLOSED AND THE INSTRUMENT HAS CHANGED (73-14, WINDOWS 219).
    // `alertRingsPainted` reads `alertRingsActive()`, a CALL LATCH on
    // `alertBornMs !== null`. It records that `showAlertRings` was INVOKED, whatever
    // the Graphics did next, so a build whose ring plotted nothing passed this line
    // with every dock assertion above it still green - which left the manual walkthrough's step 5
    // as the only thing that could see a ring at all.
    //
    // The latch is KEPT, because it answers a question the plot read cannot: the
    // gesture layer gates the CONNECT-02 reconnect press on `alertRingsActive()`, so
    // this line is now "the ring is PRESSABLE" and nothing more.
    expect(await alertRingsPainted(page), 'the one released belt is ringed, and pressable').toBe(
      true,
    );
    // ...and THIS is the step-5 instrument: the ring Graphics HOLDS GEOMETRY. Read as a
    // number off `alertRings.context.instructions.length`, never off the retained point
    // list, for the same reason `portNubInstructionsOn` is read off the nub Graphics -
    // a model-derived read would agree with the model for a drawing function that draws
    // nothing, which is this project's recorded blind spot rather than a probe for it.
    // Polled because the paint lands on the packet handler, not on the click.
    await expect
      .poll(async () => alertRingInstructions(page), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'stranded-end ring plotted poll'),
        intervals: [100, 250, 500],
        message: 'the stranded-end ring was PLOTTED, not merely asked for',
      })
      .toBeGreaterThan(0);
    // ...and WHERE (74.1-27, review WR-06). A count cannot see a ring on the wrong output,
    // and that is what the walk saw (N5): a second ring on the still-connected output's
    // nub, from the vacated nub resolved against the NEW port list. Read off the ring
    // Graphics' own geometry, never off the list App handed to the paint.
    await expect
      .poll(async () => (await alertRingCentres(page)).length, {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'two rings plotted poll'),
        intervals: [100, 250, 500],
        message: 'exactly two rings are plotted: the vacated nub and the released belt end',
      })
      .toBe(2);
    const ringsAfterRemove = await alertRingCentres(page);
    const nearest = (pt: { x: number; y: number }): number =>
      Math.min(...ringsAfterRemove.map((r) => Math.hypot(r.x - pt.x, r.y - pt.y)));
    // `nubHitRadiusWorld(1)` (src/protocol/ports.ts), written as the literal 12: this
    // suite keeps its one shared import (`shared/geometry`), so it does not import the
    // renderer's hit radius. "Near the surviving nub" means "where a user would read the
    // ring as that nub's".
    const NUB_HIT_RADIUS_AT_SCALE_1 = 12;
    expect(
      ringsAfterRemove.filter(
        (r) => Math.hypot(r.x - survivorNub.x, r.y - survivorNub.y) <= NUB_HIT_RADIUS_AT_SCALE_1,
      ),
      `no ring on the SURVIVING output's nub at (${survivorNub.x}, ${survivorNub.y}): it is ` +
        `still connected (plotted: ${JSON.stringify(ringsAfterRemove)})`,
    ).toEqual([]);
    expect(
      ringsAfterRemove.filter(
        (r) => Math.hypot(r.x - survivorEnd.x, r.y - survivorEnd.y) <= NUB_HIT_RADIUS_AT_SCALE_1,
      ),
      'no ring on the surviving belt\'s end: it is still docked',
    ).toEqual([]);
    expect(
      nearest(removedNubBefore),
      `one ring on the REMOVED output's nub as it was before the removal ` +
        `(${removedNubBefore.x}, ${removedNubBefore.y}; plotted: ${JSON.stringify(ringsAfterRemove)})`,
    ).toBeLessThanOrEqual(2);
    expect(
      nearest(releasedEnd),
      `one ring on the released belt's end tile centre (${releasedEnd.x}, ${releasedEnd.y})`,
    ).toBeLessThanOrEqual(2);
    // THE REMOVEPORT TWIN of the plot assertion above (73-10). `RemovePort` had the
    // identical hole in the invalidation key - it changes the port list and nothing
    // else in the old `sig` - so a removed output could leave its nub on the canvas
    // with no port behind it. The removal takes the plot back to the three-port
    // geometry, and it is asserted as a number moving, not as "something is painted".
    await expect
      .poll(async () => portNubInstructionsOn(page, placedId), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'removed output unplotted poll'),
        intervals: [100, 250, 500],
        message: 'the removed output was UNPLOTTED, not merely dropped from the model',
      })
      .toBe(nubsAtThree);
    await expectRenderLoopAlive(page, 'after the docked-output removal');

    // ---- STEP 6: ONE Ctrl+Z. The output comes back ON ITS OWN CELL, the released belt
    // is re-docked by the compensating `Dock` the inverse emits (73-06), the other belt
    // is re-keyed back to 1 and never moved, and the ring is gone.
    await blurControls(page);
    await page.keyboard.press('Control+z');
    await pollScene(page, (s) => outCount(s, placedId), {
      message: 'one Ctrl+Z restores the removed output',
    }).toBe(2);
    const undone = await readScene(page);
    expect(dockOf(undone, releasedTail), 'the released belt is docked again, to Out 1, key 0').toEqual([
      `Tail:${placedId}:0`,
    ]);
    expect(dockOf(undone, survivorTail), 'the other belt is on Out 2 again, key 1').toEqual([
      `Tail:${placedId}:1`,
    ]);
    expect(portCells(undone, placedId), 'every port cell equals the one captured before the removal').toEqual(
      cellsBefore,
    );
    expectEveryDockTouches(undone, 2, 'after the undo');
    expect(
      tilesOf(beltAt(undone, survivorTail) as BeltFacts),
      'the second belt never moved through any of it',
    ).toEqual(survivorTilesBefore);
    expect(tilesOf(beltAt(undone, releasedTail) as BeltFacts), 'nor did the first').toEqual(
      releasedTilesBefore,
    );
    expect(await alertRingsPainted(page), 'and the rings are no longer pressable').toBe(false);
    // The plot half of the same claim, and the half that makes this a number MOVING
    // rather than a boolean flipping: the ring Graphics is EMPTY after the undo. A
    // build that latched off while leaving the geometry on screen fails here and
    // passes the line above.
    await expect
      .poll(async () => alertRingInstructions(page), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'ring unplotted by the undo poll'),
        intervals: [100, 250, 500],
        message: 'the ring was UNPLOTTED by the undo, not merely un-latched',
      })
      .toBe(0);
    expect(await alertRingCentres(page), 'and no ring centre is plotted anywhere').toEqual([]);
    // ...and the undo puts the NUB back too, not just the port. So this is also the
    // check that the restored node is plotted at its restored port list rather than at
    // the list the layer last saw.
    //
    // 73-12 (73-REVIEW IN-02): THE SENTENCE HERE SAID THE KEYFRAME "RE-MINTS RENDER
    // HANDLES", AND IF IT DID THIS ASSERTION WOULD READ 0. `portNubInstructionsOn` is
    // called with `placedId`, the handle captured BEFORE the undo, and it returns 0 for
    // an id the layer has no entry for (`machines.ts`). A re-mint would therefore time
    // this poll out. It passes because a `RemovePort` undo folds an `AddPort` and does
    // NOT re-mint the node, so `RenderPacketBuilder::handle_for`'s monotonic handle is
    // stable across the Ctrl+Z. Corrected rather than left: the next reader would have
    // "fixed" a passing assertion.
    await expect
      .poll(async () => portNubInstructionsOn(page, placedId), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'restored output plotted poll'),
        intervals: [100, 250, 500],
        message: 'the restored output is PLOTTED again after the undo',
      })
      .toBe(nubsAtFour);
    await expectRenderLoopAlive(page, 'after the undo');

    // ---- STEP 6, second half: the panel. MEASURED 2026-09-05 and it is NOT what
    // the plan predicted, so it is written down as it is.
    //
    // The Ctrl+Z emits a `full: true` keyframe, and App clears the ephemeral
    // selection UNCONDITIONALLY on one (a keyframe re-mints render handles, so a
    // stale handle could retarget a later Delete at the wrong node). The config
    // panel therefore UNMOUNTS. There are no Outputs controls on the packet that
    // puts the output back, so "the controls are live again on the same packet"
    // is not observable on this build at all.
    await expect(
      portsSection(page),
      'the keyframe clears the selection, so the panel closes (shipped behaviour)',
    ).toHaveCount(0);

    // What the user does next is re-select, and THAT is where the requirement's
    // real content lives: the controls are live and the panel says nothing.
    //
    // DECLARED AS A REGRESSION GUARD, not as proof of this phase's latch change.
    // It passes with the keyframe release arm reverted, because the RemovePort
    // fold arrives as an ordinary DIFF packet which the ~10Hz poll observes and
    // the successor check releases in the normal way. Measured both ways. The arm
    // is proved by `portEditLatch.test.ts`, not here.
    await selectFactory(page, placedId);
    await expect(removeOutput(page, 1), 'the Outputs controls are live').toBeEnabled();
    await expect(addOutput(page), 'including Add').toBeEnabled();
    await expect(
      portsSection(page).locator('[role="status"]'),
      'and the port-edit readout is empty: no waiting, no Try again',
    ).toHaveCount(0);
    await expect(
      // The label as a LITERAL, not imported: this spec is the contract check
      // against the shipped app, so importing the constant would let a copy change
      // pass silently on both sides (the discipline the mock specs already keep).
      portsSection(page).getByRole('button', { name: 'Try again' }),
      'no Try again for an edit that already happened and was already undone',
    ).toHaveCount(0);

    errs.assertNone('across the whole UNDO-06 walk');
  });

});
