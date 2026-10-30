import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { addFrameBudget, addWaitBudget, frameBudgetMs, tickBudgetMs } from '../../e2e/support/frameSampler';
import { CONFIG_NOT_APPLIED_MARKER } from '../../src/chrome/configCopy';

// oracle.ts - the LIVE e2e project's ONLY support module (Phase 22).
//
// Self-contained by design (T-22-02-A, Repudiation): the live project must be
// structurally auditable as zero-mock. It imports ONLY '@playwright/test' AND,
// since 23-04 (GATE-01), exactly ONE pure values module: frontend/shared/
// geometry.ts. That module is a product-logic-free, Pixi-free constants source
// living OUTSIDE src/ - it is a values source, NOT product code. Importing it
// PRESERVES the zero-mock auditability guarantee (T-22-02-A / T-23-05): the
// live suite still never imports the mock packet builder, the WS route-mocking
// helper, or any product src, and both suites now assert against the SAME
// geometry/color values, which strengthens the audit rather than coupling the
// suite to product behavior. This is the single allowed shared import.
//
// Every readiness wait in the live project goes through pollScene / expect.poll
// with a predicate - fixed sleeps are banned (deterministic polling lock).
//
// Coordinates are transformed through window.__fabrico.camera() (assumption A5):
// read the camera once after waitForAppReady (via cameraOf / screenCellCentre /
// screenPoint) and RE-READ it if a spec intentionally pans or zooms mid-test. The
// pure cell/nub/handle geometry stays identity (shared/geometry.ts); the camera
// multiply (screen = world*scale + pan) lives ONLY in the helpers below. Today the
// boot camera is still identity, so every transform is a no-op (world*1 + 0).

// ---------------------------------------------------------------------------
// The demo's node count, from the scene file itself (plan 85-08, D-19)
// ---------------------------------------------------------------------------

/** The shipped demo's scene file, read from this module's own location (never the cwd). */
const DEMO_SCENE_RON = fileURLToPath(
  new URL('../../../examples/boards/demo_scene.board.ron', import.meta.url),
);

/**
 * How many `Place(` commands `demo_scene.board.ron` holds, outside `//` comments: the demo's node
 * count as the scene oracle reports it (machines, the Route and HTTP Handler, and labels; belts
 * and cables are listed apart). THE ONE SOURCE every live spec reads, so a change to the demo's
 * content moves every spec at once instead of 25 hand-kept copies going stale one by one (D-19).
 * Read when this module loads; a file with no `Place(` is a broken path or a broken scene, and
 * is thrown by name rather than counted as zero.
 */
export const DEMO_NODE_COUNT: number = (() => {
  const src = readFileSync(DEMO_SCENE_RON, 'utf8');
  const places = src
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => /^\s*Place\(/.test(line)).length;
  if (places === 0) {
    throw new Error(`DEMO_NODE_COUNT: found no Place( command in ${DEMO_SCENE_RON}`);
  }
  return places;
})();

// ---------------------------------------------------------------------------
// Snapshot shapes (plain-data mirrors of the post-22-01 window.__fabrico reads)
// ---------------------------------------------------------------------------

/** One host-resolved port as the oracle reports it (world cell, side, role). */
export interface PortFacts {
  /** Catalog-order index (identity-stable across Rotate). */
  index: number;
  /** Host-resolved WORLD cell (rot-applied). */
  cell_x: number;
  cell_y: number;
  /** Cell edge the port faces: N=0, E=1, S=2, W=3. */
  side: number;
  /** Port role: In=0, Out=1, Fault=2. */
  role: number;
  /** Port transport medium: Mechanical=0, Electrical=1 (PORT-06 / ROUTE-06). */
  medium: number;
}

/** One per-end belt dock, verbatim wire values (keyspace per the host). */
export interface DockFacts {
  end: 'Head' | 'Tail';
  node: number;
  port: number;
}

/**
 * A belt tile's kind as the render packet ships it (`TileKindView` on the wire), in the
 * wire's own encodings: `Straight.axis` X=0, Y=1; `Corner.from` / `Corner.to` are the
 * flow directions N=0, E=1, S=2, W=3 (y-down) into and out of the tile. At a docked end
 * the host ships the DERIVED seam kind (plan 74.1-07, `effective_belt_tiles`), so a belt
 * that turns at once off a belt end or a port arrives here as a Corner.
 */
export type TileKindFacts =
  | { Straight: { axis: number } }
  | { Corner: { from: number; to: number } };

/**
 * One belt path tile as the oracle reports it: its world cell plus the renderer's
 * tile-kind view. The CELL is the belt's actual routed path and is what a topology
 * compare is made of (55-05). Before that compare existed the whole tile was
 * `unknown`, which forced every consumer to cast.
 *
 * The KIND was left `unknown` until plan 74.1-09, because no assertion read it. That
 * is the gap 3 failure (74.1-VERIFICATION.md): every live join leg graded the Dock link,
 * which passed while the screen showed a T at the seam, a straight tile beside a collar. A join
 * claim now reads the seam tile's kind, so the kind is typed.
 */
export interface BeltTileFacts {
  cell_x: number;
  cell_y: number;
  kind: TileKindFacts;
}

/** One in-flight wire pulse as the oracle reports it (WUI-01). */
export interface WirePulseFacts {
  entry_tick: number;
  hop_ticks: number;
  /** Host-derived direction: 0 = FORWARD (request out), 1 = REPLY (response home). */
  direction: number;
}

/** One electrical wire as the oracle reports it (WUI-01): endpoints + pulse facts. */
export interface WireFacts {
  id: number;
  from: { node: number; port: number };
  to: { node: number; port: number };
  tiles: number;
  /**
   * The routed cable's cells, source port first (phase 75, CABLE-06). A spec that grades
   * how a cable meets its ports reads the first and last step from these; `tiles` is a
   * count and cannot say which way a cable leaves or arrives.
   */
  path: { cell_x: number; cell_y: number }[];
  pulses: WirePulseFacts[];
  /** Packets in which THIS wire carried a REPLY pulse since the last keyframe (plan 84-18). */
  replyPulsesSeen: number;
}

/** The plain-data scene shape `window.__fabrico.scene()` returns. */
export interface SceneFacts {
  tick: number;
  canUndo: boolean;
  canRedo: boolean;
  nodes: {
    id: number;
    kind: number;
    state: number;
    cells: [number, number][];
    ports: PortFacts[];
    /** A label's committed words and colour byte (phase 76, plan 76-02), echoed back
     *  through the render packet's `NodeView.label`; `null` on every other kind. The
     *  model's reading, so a spec that asserts it must also read the words on screen
     *  (`labelWordsOf`): the model cannot tell a drawn word from a missing one. */
    label: { text: string; colour: number } | null;
  }[];
  belts: {
    id: number;
    tiles: BeltTileFacts[];
    items: number;
    /** Which slot indices hold an item, ASCENDING and without duplicates (PILE-06).
     *  Slot 0 is the HEAD, the deliver end, so this array is what lets a spec state
     *  the MEASURED occupancy pattern it is inverting rather than assert a bare count
     *  that a different pattern could also produce. */
    occupiedSlots: number[];
    /** Whether slot 0, the tile pressed against the DOWNSTREAM machine, holds an item
     *  (PILE-06). This is the one bit an overload acceptance judges: a
     *  full-and-draining belt and a full-and-jammed belt report the same `items`
     *  count and differ only here. */
    headOccupied: boolean;
    docks: DockFacts[];
    /** The belt's advance interval in sim ticks per slot (SLOT-03 / BELT-02).
     *  Larger means slower. This is the MODEL's reading of a belt's pace - the
     *  render packet echoed back through `sceneSnapshot` - and it is what a live
     *  pace spec asserts against, rather than re-reading the panel that produced
     *  the edit. */
    ticksPerSlot: number;
  }[];
  /** Electrical wires (WUI-01): the request/response cables + their in-flight pulses. */
  wires: WireFacts[];
  /**
   * The monotonic reply-home observation count (WUI-01): bumped each applied packet in
   * which a wire carried a REPLY-direction pulse. The wire-visual gate polls this to
   * robustly prove "the reply travelled home" despite the ~1-tick on-cable pulse window.
   */
  replyPulsesObserved: number;
}

/** The decode counters `window.__fabrico.stats()` returns (22-01, WR-07 made observable). */
export interface StatsFacts {
  packetsApplied: number;
  decodeErrors: number;
}

// ---------------------------------------------------------------------------
// Oracle readers
// ---------------------------------------------------------------------------

/** Read `window.__fabrico.scene()` from the page - DOM-free, no canvas reads. */
export async function readScene(page: Page): Promise<SceneFacts> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { scene(): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    return hook.scene() as SceneFacts;
  });
}

/**
 * The shipped kind of the belt tile at world cell (cx, cy), or `null` when no belt tile
 * is there. A belt never shares a cell with another, so the first match is the only one.
 * Pure over a scene already read: poll it through `pollScene` to wait for a Dock echo.
 */
export function tileKindAt(scene: SceneFacts, cx: number, cy: number): TileKindFacts | null {
  for (const b of scene.belts) {
    const t = b.tiles.find((tile) => tile.cell_x === cx && tile.cell_y === cy);
    if (t) {
      return t.kind;
    }
  }
  return null;
}

/**
 * Resolve a node handle to its loopback POST URL via `window.__fabrico.webhookUrl`
 * (the read-only dev-WS `webhook_url` bridge, 40-05): `/hook/src-<id>` for a Source or
 * `/endpoint/<path>` for a Route (`route-<n>` until a path is typed). Used by the
 * wire-visual gate to drive a REAL hop against the demo's caller Route (see
 * `demoCallerAndHandler`). Null off the dev transport or for a non-addressable handle.
 */
export async function webhookUrl(page: Page, handle: number): Promise<string | null> {
  return page.evaluate((h) => {
    const hook = (window as { __fabrico?: { webhookUrl(n: number): Promise<string | null> } })
      .__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    return hook.webhookUrl(h);
  }, handle);
}

/** The render packet's kind byte for a Route (the caller), `ENDPOINT` on the wire. */
const DEMO_PAIR_KIND_ROUTE = 9;
/** The render packet's kind byte for an HTTP Handler. */
const DEMO_PAIR_KIND_HANDLER = 10;

/**
 * The demo's caller and handler, found by WHAT THEY ARE: never by a cell, a handle number
 * or a path (plan 85-07, D-19's principle: the demo is not shaped to suit tests, so a spec
 * must not depend on where the demo puts its pair or what it names its route).
 *
 * - The CALLER is the lowest-handle Route (kind 9) on the board. On a freshly reset demo it
 *   is the demo's only Route, and a Route a spec places afterwards mints a higher handle.
 * - The HANDLER is the node the caller's one outgoing cable delivers into, read off
 *   `wires`; it must be an HTTP Handler (kind 10). (The demo's handler is told from a
 *   palette Handler by its reply body `home`, which only a POST can read; a spec that needs
 *   that reads it through `callerUrl`.)
 * - `callerUrl` is the host's own POST URL for the caller (`webhookUrl`), whatever path the
 *   caller is configured with.
 *
 * It throws, naming what it could not find, rather than returning part of a pair.
 */
export async function demoCallerAndHandler(page: Page): Promise<{
  caller: SceneFacts['nodes'][number];
  handler: SceneFacts['nodes'][number];
  callerUrl: string;
}> {
  const scene = await readScene(page);
  const routes = scene.nodes.filter((n) => n.kind === DEMO_PAIR_KIND_ROUTE).sort((a, b) => a.id - b.id);
  const caller = routes[0];
  if (caller === undefined) {
    throw new Error(
      `demoCallerAndHandler: the board carries no Route (kind ${DEMO_PAIR_KIND_ROUTE}), so it has no demo caller ` +
        `(kinds on the board: ${JSON.stringify(scene.nodes.map((n) => n.kind))})`,
    );
  }
  const outgoing = scene.wires.filter((w) => w.from.node === caller.id);
  if (outgoing.length !== 1) {
    throw new Error(
      `demoCallerAndHandler: expected exactly ONE cable leaving the caller Route ${caller.id}, found ` +
        `${outgoing.length} (${JSON.stringify(scene.wires.map((w) => ({ from: w.from, to: w.to })))})`,
    );
  }
  const handler = scene.nodes.find((n) => n.id === outgoing[0].to.node);
  if (handler === undefined || handler.kind !== DEMO_PAIR_KIND_HANDLER) {
    throw new Error(
      `demoCallerAndHandler: the caller's cable delivers into node ${outgoing[0].to.node}, which is ` +
        `${handler === undefined ? 'not on the board' : `kind ${handler.kind}`}, not an HTTP Handler (kind ${DEMO_PAIR_KIND_HANDLER})`,
    );
  }
  const callerUrl = await webhookUrl(page, caller.id);
  if (callerUrl === null) {
    throw new Error(`demoCallerAndHandler: the host gave no POST URL for the caller Route ${caller.id}`);
  }
  return { caller, handler, callerUrl };
}

/**
 * Read `window.__fabrico.alertRingsActive()` - have the CONNECT-02 stranded-dock
 * alert rings been RAISED right now? (67-REVIEW WR-05.)
 *
 * The scene model cannot answer this at all: a build whose `showAlertRings`
 * regressed while `setStrandedRings` still fired leaves the model saying
 * "stranded" over a canvas that drew nothing, and every model-only stranded
 * assertion still passes. That is this project's recorded model-oracle blind
 * spot, and reading this hook is strictly better than reading the model.
 *
 * BUT IT IS A CALL LATCH, NOT A PLOT READ, AND THIS DOCBLOCK USED TO OVERCLAIM
 * (corrected 73-08, ruling R-41). It reads the same `alertBornMs` the paint and
 * the gesture layer's hit test are driven from, and that field goes non-null when
 * `showAlertRings` is INVOKED, whatever the `Graphics` did afterwards. So the old
 * closing sentence - "it cannot report a ring the user cannot see" - was too
 * strong: a build whose ring geometry produced nothing while the call still
 * happened passes this probe.
 *
 * The sibling probe written one phase later does it properly:
 * {@link backedUpMarksPainted} reads `MachineLayer.loadGaugesPainted()`, which
 * counts ids whose `Graphics` HOLDS GEOMETRY, decided at the draw call site. That
 * is the shape a stronger `alertRingsActive` would take. 73-08 deliberately did
 * NOT rewrite it - a renderer change inside a correctness phase - and carried the
 * residual in words instead.
 *
 * THAT RESIDUAL IS NOW CLOSED, and this helper is no longer the step-5 instrument
 * (73-14, WINDOWS 219). {@link alertRingInstructions} below reads the ring
 * `Graphics` instruction count in exactly the `portNubInstructionsOn` shape, and it
 * is what the UNDO-06 leg asserts on. THIS helper is kept for the question it
 * genuinely answers and the plot read cannot: the gesture layer gates the
 * CONNECT-02 reconnect press on `alertRingsActive()`, so "is the ring pressable"
 * is a latch question. Use the plot read to ask whether a ring reached the screen;
 * use this one to ask whether a press would be taken.
 *
 * THERE IS NO TTL, and this docblock used to claim a 5000ms one that has not
 * existed since 2026-08-30. The constant is `ALERT_SETTLE_MS`; it only calms the
 * pulse and never retires the ring, which lives until the strand is resolved or a
 * structural edit clears it (`overlay.ts`, "There is NO TTL"). A reader who
 * believes in a TTL will write a sleep and then a flake.
 */
export async function alertRingsPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { alertRingsActive?(): boolean } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.alertRingsActive !== 'function') {
      throw new Error('window.__fabrico.alertRingsActive() not installed');
    }
    return hook.alertRingsActive();
  });
}

/**
 * Read `window.__fabrico.alertRingInstructions()` - how many draw instructions the
 * stranded-dock ring `Graphics` is HOLDING right now (73-14, WINDOWS 219).
 *
 * THE STEP-5 INSTRUMENT. UNDO-06 walk step 5's user-visible claim is that removing a
 * docked output makes exactly ONE belt draw its stranded-end rings. Until this probe
 * the only automated arm for it was {@link alertRingsPainted}, a CALL LATCH on
 * `alertBornMs !== null`: it records that `showAlertRings` was INVOKED, whatever the
 * `Graphics` did afterwards, so a build whose ring plotted nothing passed it with every
 * model-side stranded assertion still green. That left a human eye on the acceptance
 * walk as the whole of the evidence for step 5.
 *
 * A COUNT, not a boolean, and for the same reason {@link portNubInstructionsOn} is:
 * the assertion worth making is a number MOVING - non-zero while the belt is stranded,
 * back to 0 once the undo re-docks it - and "is anything painted" cannot express the
 * second half. Delegates to `OverlayLayer.alertRingInstructions()`, which reads
 * `alertRings.context.instructions.length` off the live Graphics rather than off
 * `alertPts.length`; a length read would agree with the model for any drawing function
 * whatsoever, including one that draws nothing.
 *
 * PROVED TO BITE: with `paintAlertRings`'s `circle(...).stroke(...)` deleted this reads
 * 0 while the belt is stranded and the UNDO-06 leg fails on it, with `alertRingsPainted`
 * and every dock assertion in the same leg still passing.
 */
export async function alertRingInstructions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { alertRingInstructions?(): number } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.alertRingInstructions !== 'function') {
      throw new Error('window.__fabrico.alertRingInstructions() not installed');
    }
    return hook.alertRingInstructions();
  });
}

/**
 * Read `window.__fabrico.pendingInstructions()` - how many geometry instructions the overlay's
 * pending "placing" shimmer `Graphics` holds right now (plan 88-05, FAIL-07, D-10).
 *
 * A COUNT off the live Graphics, as {@link alertRingInstructions} is, so a spec can grade the
 * shimmer the user SEES on a refused cell: it must be 0 within a few frames of the refusal,
 * leaving the red flash the only mark. Delegates to `OverlayLayer.pendingInstructions()`, which
 * reads `pending.context.instructions.length`, never a pending flag the gesture layer keeps.
 */
export async function pendingShimmerInstructions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { pendingInstructions?(): number } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.pendingInstructions !== 'function') {
      throw new Error('window.__fabrico.pendingInstructions() not installed');
    }
    return hook.pendingInstructions();
  });
}

/**
 * Read `window.__fabrico.rejectFlashCell()` - the cell under the centre of the box the reject
 * flash `Graphics` holds RIGHT NOW, read back off its own fill instruction (plan 89-09, D-12),
 * or null when the flash holds nothing. A read of what is plotted, never of the cell a gesture
 * asked to flash. The flash lives 180 ms, so a spec that needs to know where it fired latches
 * it on every frame ({@link latchRejectFlashCells}); this single read is for "nothing is
 * plotted now".
 */
export async function rejectFlashCell(page: Page): Promise<{ cx: number; cy: number } | null> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { rejectFlashCell?(): { cx: number; cy: number } | null } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.rejectFlashCell !== 'function') {
      throw new Error('window.__fabrico.rejectFlashCell() not installed');
    }
    return hook.rejectFlashCell();
  });
}

/**
 * Start a per-frame latch of every reject flash PLOTTED from now on (plan 89-09, D-12, UI-SPEC
 * 6.2): on each animation frame `rejectFlashCell()` (where the flash is plotted) and
 * `rejectFlashSerial()` (how many flashes were shown) are read, and a plotted cell is appended
 * whenever the serial moved since the last one appended. So one flash reads as one entry however
 * many frames it lives, a second flash reads as a second entry on another cell AND on the same
 * cell (review IN-C-01: the cell-only latch merged two back-to-back flashes on one cell), and a
 * flash that plots nothing never counts. A frame-by-frame latch is the only read that cannot miss a
 * 180 ms flash on a slow page. Restarting it clears the list; {@link stopRejectFlashLatch} ends the
 * loop. Read it with {@link rejectFlashCellsSeen}.
 */
export async function latchRejectFlashCells(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabrico: { rejectFlashCell(): { cx: number; cy: number } | null; rejectFlashSerial(): number };
      __flashCells?: Array<{ cx: number; cy: number }>;
      __flashCellsRun?: number;
    };
    if (typeof w.__fabrico?.rejectFlashCell !== 'function') {
      throw new Error('window.__fabrico.rejectFlashCell() not installed');
    }
    if (typeof w.__fabrico?.rejectFlashSerial !== 'function') {
      throw new Error('window.__fabrico.rejectFlashSerial() not installed');
    }
    const run = (w.__flashCellsRun ?? 0) + 1;
    w.__flashCellsRun = run;
    w.__flashCells = [];
    let latched = w.__fabrico.rejectFlashSerial();
    const tick = (): void => {
      if (w.__flashCellsRun !== run) return;
      const c = w.__fabrico.rejectFlashCell();
      const serial = w.__fabrico.rejectFlashSerial();
      if (c !== null && serial !== latched) {
        w.__flashCells!.push({ cx: c.cx, cy: c.cy });
        latched = serial;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** End the {@link latchRejectFlashCells} loop (review IN-C-01); the cells it latched stay readable. */
export async function stopRejectFlashLatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __flashCellsRun?: number };
    w.__flashCellsRun = (w.__flashCellsRun ?? 0) + 1;
  });
}

/** The cells {@link latchRejectFlashCells} has latched so far, in the order they were plotted. */
export async function rejectFlashCellsSeen(page: Page): Promise<Array<{ cx: number; cy: number }>> {
  return page.evaluate(() => [...((window as unknown as { __flashCells?: Array<{ cx: number; cy: number }> }).__flashCells ?? [])]);
}

/**
 * Poll until the refusal region `#fab-refusal` says SOMETHING, and return the first non-empty
 * reading LATCHED (promoted from the local copies in `18-refusal.spec.ts` and
 * `74.1-belt-join-both-ways.live.spec.ts` by plan 89-09, which import this one now).
 *
 * The latch is what makes it safe: a naive `poll(...).not.toBe('')` followed by a separate
 * `textContent()` read has the live 4000 ms hold (`REFUSAL_HOLD_MS`) running underneath it, so a
 * poll that returns near the end of the window can be followed by an EMPTY read, and a plain
 * poll reports the region's last reading, which is empty once the hold runs out. The ladder is
 * 15 s on 100, 250 and 500 ms, on the region's id. `soft` makes a red a soft assertion, so the
 * board grades after it still run and name the rest (`86-undo-space-taken.live.spec.ts`).
 */
export async function captureRefusalText(page: Page, message: string, opts: { soft?: boolean } = {}): Promise<string> {
  let latched = '';
  await expect
    .configure({ soft: opts.soft === true })
    .poll(
      async () => {
        const now = ((await page.locator('#fab-refusal').textContent()) ?? '').trim();
        if (now !== '' && latched === '') {
          latched = now;
        }
        return latched;
      },
      { timeout: 15_000, intervals: [100, 250, 500], message },
    )
    .not.toBe('');
  return latched;
}

/**
 * Read `window.__fabrico.alertRingCentres()` - the world-px centre of every ring the
 * stranded-dock ring `Graphics` has PLOTTED (plan 74.1-27, review WR-06).
 *
 * {@link alertRingInstructions} above counts geometry and cannot say where it is, so a
 * ring painted on a still-connected output (walk item N5) passed the UNDO-06 leg that
 * read it. This delegates to `OverlayLayer.alertRingCentres()`, which reads the circle
 * centres back off the Graphics' own instructions, never off the list handed to
 * `showAlertRings`; a unit case paints at an offset point and sees that point.
 */
export async function alertRingCentres(page: Page): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { alertRingCentres?(): Array<{ x: number; y: number }> } })
      .__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.alertRingCentres !== 'function') {
      throw new Error('window.__fabrico.alertRingCentres() not installed');
    }
    return hook.alertRingCentres();
  });
}

/** What {@link targetRingsPlotted} answers: the target rings as the overlay plotted them. */
export interface TargetRingsPlotted {
  resting: Array<{ x: number; y: number; filled: boolean }>;
  drop: { x: number; y: number; accepting: boolean } | null;
}

/**
 * Read `window.__fabrico.targetRingsPlotted()` - every target ring a belt gesture has
 * PLOTTED (plan 74.1-33, review round 4 WR-02): the resting rings with their grabbed disc,
 * and the hovered drop ring with whether it was drawn accepting.
 *
 * This delegates to `OverlayLayer.targetRingsPlotted()`, which reads both back off the two
 * ring Graphics' own instructions, never off the lists handed to the paints, so a spec
 * grading "no accepting ring on the Out this Tail is docked to" grades the canvas and not
 * the predicate that decided what to paint.
 */
export async function targetRingsPlotted(page: Page): Promise<TargetRingsPlotted> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { targetRingsPlotted?(): TargetRingsPlotted } })
      .__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.targetRingsPlotted !== 'function') {
      throw new Error('window.__fabrico.targetRingsPlotted() not installed');
    }
    return hook.targetRingsPlotted();
  });
}

/**
 * Read `window.__fabrico.backedUpMarksPainted()` - is a BACKED_UP load gauge actually
 * PAINTED on the canvas right now? (PILE-08 acceptance check 3, plan 71-06.)
 *
 * THE SCENE MODEL CANNOT ANSWER THIS, and the reason is the one recorded on
 * {@link alertRingsPainted} above, reached on a different cue. `NodeView.load` arriving
 * as 4 says only that the HOST derived a full mechanical inbox. A build whose
 * `drawLoadGauge` regressed - deleted, gated off behind a stale signature, parented to a
 * Container nobody adds to the stage - leaves that byte completely untouched, so every
 * model-only backpressure assertion would keep passing over a canvas that drew nothing.
 * A probe that read the model would not merely miss that build, it would BE the blind
 * spot.
 *
 * So this reads the PLOT: `MachineLayer.loadGaugesPainted()` counts node ids whose gauge
 * `Graphics` HOLDS GEOMETRY, decided by reading the Graphics back at the draw call site
 * rather than by trusting the byte that was passed in. Turning `drawLoadGauge` into a
 * no-op takes this to false with the model unchanged, which was measured before this
 * function was allowed to exist.
 *
 * TWO DISTINCT NAMED THROWS, deliberately, so a STALE BUILD reads differently from a
 * MISSING HOOK: a page with no `__fabrico` at all is a boot failure, while a page whose
 * `__fabrico` lacks this method is a build from before 71-06. Collapsing them into one
 * message sends the reader to the wrong half of the problem.
 */
export async function backedUpMarksPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { backedUpMarksPainted?(): boolean } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.backedUpMarksPainted !== 'function') {
      throw new Error('window.__fabrico.backedUpMarksPainted() not installed');
    }
    return hook.backedUpMarksPainted();
  });
}

/**
 * The SAME plot probe, SCOPED TO ONE NODE (71-review WR-05).
 *
 * {@link backedUpMarksPainted} is board-wide: it is `loadGaugesPainted() > 0`, and
 * `gaugesPainted` gains a member for ANY node whose gauge plotted geometry - which
 * `drawLoadGauge` does at levels 1, 2 and 3 as well as at the merged full bar. So a
 * regression confined to the `level >= GAUGE_SLOTS` branch leaves the machine a spec
 * NAMES drawing nothing while the Factory, Router and Merge upstream keep their 1..3
 * tick runs and the board-wide probe stays true. The merged full bar IS the BACKED_UP
 * cue, so that is the one mutation the per-machine claim most needs to see, and it is
 * exactly the one the count cannot.
 *
 * Everything else is identical: the same painted set, the same
 * `gauge.context.instructions.length > 0` membership read back off the Graphics, the
 * same two distinct named throws so a stale build reads differently from a missing hook.
 */
export async function backedUpMarkPaintedOn(page: Page, id: number): Promise<boolean> {
  return page.evaluate((nodeId) => {
    const hook = (window as { __fabrico?: { backedUpMarkPaintedOn?(id: number): boolean } })
      .__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.backedUpMarkPaintedOn !== 'function') {
      throw new Error('window.__fabrico.backedUpMarkPaintedOn() not installed');
    }
    return hook.backedUpMarkPaintedOn(nodeId);
  }, id);
}

/** What {@link loadGaugeFormOn} returns: the gauge's drawn form, off its Graphics. */
export interface LoadGaugeFormFacts {
  instructions: number;
  width: number;
  merged: boolean;
  drawnAtTick: number;
}

/**
 * The FORM the load gauge on node `id` is drawn in, and the scene tick it was drawn FROM
 * (plan 77-07, phase 77 D-04).
 *
 * {@link backedUpMarkPaintedOn} is true at levels 1, 2 and 3 as well as at the merged full bar,
 * so it stays true for about 120 ticks after a release and cannot see the backed-up mark clear.
 * An instruction count alone cannot tell level 1 from level 4 (both are one rect), so this also
 * reads the drawn width, and `merged` is true only for ONE filled rect in the gauge ink spanning
 * the full run on a shown Graphics (`machines.ts` `readLoadGaugeForm`, the 77-07 refuter round).
 * The model can be a frame ahead of the canvas, so the form carries `drawnAtTick`: grade a form
 * against the tick it was drawn from, never against the tick of the read that returned it.
 *
 * Delegates to `MachineLayer.loadGaugeFormOn`, which reads the gauge Graphics' own context and
 * never `node.load`. `null` for an id the layer has never drawn. The same two distinct named
 * throws as its siblings, so a stale build reads differently from a missing hook.
 */
export async function loadGaugeFormOn(page: Page, id: number): Promise<LoadGaugeFormFacts | null> {
  return page.evaluate((nodeId) => {
    const hook = (window as { __fabrico?: { loadGaugeFormOn?(id: number): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.loadGaugeFormOn !== 'function') {
      throw new Error('window.__fabrico.loadGaugeFormOn() not installed');
    }
    return hook.loadGaugeFormOn(nodeId) as LoadGaugeFormFacts | null;
  }, id);
}

/**
 * How many path instructions the PORT-NUB overlay on node `id` holds (73-10).
 *
 * THE ONE PROBE IN THIS FILE THAT CAN SEE A NUB. Everything else here reads the MODEL:
 * `readScene` hands back the decoded packet, and the app's own hit test is model-derived
 * too (`gestures.ts nubsInRadius` over `worldNubSpecs`). So a spec could click
 * `+ Add output`, assert the port list grew, drag a belt from the new nub and dock it -
 * every one of those passing over a board where the nub was never drawn. That build
 * shipped: the nub overlay's invalidation key carried no port token, and the added
 * output was clickable but invisible.
 *
 * A COUNT, deliberately, not a boolean. The defect leaves a STALE plot, not an empty
 * one, so "are any nubs painted" is `true` on the broken build and proves nothing. An
 * Out is a disc plus a stem, so an added output MOVES this number - which is an
 * assertion that reddens when the fix is reverted (measured both ways, 73-10).
 *
 * Delegates to `MachineLayer.portNubInstructionsOn`, which reads
 * `nubs.context.instructions.length` off the Graphics. Two distinct named throws, as
 * elsewhere in this file, so a stale build reads differently from a missing hook.
 */
export async function portNubInstructionsOn(page: Page, id: number): Promise<number> {
  return page.evaluate((nodeId) => {
    const hook = (window as { __fabrico?: { portNubInstructionsOn?(id: number): number } })
      .__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.portNubInstructionsOn !== 'function') {
      throw new Error('window.__fabrico.portNubInstructionsOn() not installed');
    }
    return hook.portNubInstructionsOn(nodeId);
  }, id);
}

/**
 * How many geometry instructions ONE belt's END marks currently plot (74-09, LINK-03).
 *
 * The paint half of a belt-to-belt junction claim, and it exists because the model half
 * cannot carry it. `belts[].docks` naming the other belt says the HOST derived the link
 * and the packet carried it; it says nothing whatever about whether the collar was
 * drawn, and a build whose seam branch of `rebuildEnds` regressed leaves both `docks`
 * arrays completely untouched. That is this repository's recorded model-oracle blind
 * spot, reached on a new cue.
 *
 * A COUNT rather than a boolean, matching `portNubInstructionsOn`: the leg asserts it is
 * non-zero while joined and back to ZERO after the Disconnect, and a boolean cannot
 * express the second half as a number moving.
 *
 * READ THE SCOPE BEFORE ASSERTING ON IT. This counts BOTH ends of the belt: a machine
 * dock plots a stem plus a role cap, a belt-to-belt junction plots the collar disc plus
 * its ring, and an UNDOCKED end plots nothing at all. So it isolates the collar only on
 * a board where the named belt's other end is free - which is exactly what
 * `74-belt-run-joins.spec.ts` builds, and why it builds it that way.
 *
 * Delegates to `BeltLayer.endInstructionsOn`, which reads `ends.context.instructions
 * .length` off the Graphics. Two distinct named throws, as elsewhere in this file, so a
 * stale build reads differently from a missing hook.
 */
export async function beltEndInstructionsOn(page: Page, id: number): Promise<number> {
  return page.evaluate((beltId) => {
    const hook = (window as { __fabrico?: { beltEndInstructionsOn?(id: number): number } })
      .__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.beltEndInstructionsOn !== 'function') {
      throw new Error('window.__fabrico.beltEndInstructionsOn() not installed');
    }
    return hook.beltEndInstructionsOn(beltId);
  }, id);
}

/**
 * WHERE belt `id`'s junction collar is PLOTTED, in world px (review fix CR-C-01): the stroked
 * circles on the belt's end Graphics, read back off its own instructions through
 * `window.__fabrico.beltCollarCentresOn(id)`. The collar is drawn by the UPSTREAM belt (its Head
 * end), so read the belt that feeds the seam. Unlike `beltEndInstructionsOn`, this isolates the
 * collar on any board: a machine plug on the same belt is a line and a filled cap, never a stroked
 * circle. Two distinct named throws, as elsewhere in this file.
 */
export async function beltCollarCentresOn(page: Page, id: number): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate((beltId) => {
    const hook = (window as { __fabrico?: { beltCollarCentresOn?(id: number): Array<{ x: number; y: number }> } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.beltCollarCentresOn !== 'function') {
      throw new Error('window.__fabrico.beltCollarCentresOn() not installed');
    }
    return hook.beltCollarCentresOn(beltId);
  }, id);
}

/**
 * Every corridor the wire drag preview PLOTTED (plan 75-05, CABLE-08): one array of
 * world-px vertices per stroked run, read off the overlay route Graphics' own
 * `context.instructions` through `window.__fabrico.wirePreviewPolylines()`. Empty when no
 * corridor is on screen. This is the read that can see a corridor stop short of its nub:
 * the model oracle has no preview at all, and the gesture's `showRoute` arguments say what
 * was asked for, not what was drawn. Two distinct named throws, as elsewhere in this file.
 */
export async function wirePreviewPolylines(page: Page): Promise<Array<Array<{ x: number; y: number }>>> {
  return page.evaluate(() => {
    const hook = (
      window as { __fabrico?: { wirePreviewPolylines?(): Array<Array<{ x: number; y: number }>> } }
    ).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.wirePreviewPolylines !== 'function') {
      throw new Error('window.__fabrico.wirePreviewPolylines() not installed');
    }
    return hook.wirePreviewPolylines();
  });
}

/**
 * How many build-accent strokes the wire layer's `cables` Graphics held after the last
 * frame (plan 75-06, CABLE-07), through `window.__fabrico.rerouteMarkStrokes()`: above 0
 * means a re-route mark was on screen. A plot read, not a flag: a mark decided and never
 * stroked reads 0. It cannot say which cable is marked; pair it with the cells the model
 * reports. Two distinct named throws, as elsewhere in this file.
 */
export async function rerouteMarkStrokes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { rerouteMarkStrokes?(): number } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.rerouteMarkStrokes !== 'function') {
      throw new Error('window.__fabrico.rerouteMarkStrokes() not installed');
    }
    return hook.rerouteMarkStrokes();
  });
}

/**
 * Every resting cable the wire layer PLOTTED in the last frame (plan 77-05, 77 D-04, done-test
 * leg 5): one array of world-px vertices per cable stroke, read off the cables Graphics' own
 * `context.instructions` through `window.__fabrico.cablePolylines()`, the re-route mark
 * excluded by colour. Empty when no cable is drawn. The model's `wires[].path` says where a
 * cable should be; this says where one was drawn, so a wire layer that drew nothing, or a stale
 * line, is visible here while every model read passes. Read it with `expect.poll` and the
 * expected value: the renderer draws a frame after the packet lands. Two distinct named
 * throws, as elsewhere in this file.
 */
export async function cablePolylines(page: Page): Promise<Array<Array<{ x: number; y: number }>>> {
  return page.evaluate(() => {
    const hook = (
      window as { __fabrico?: { cablePolylines?(): Array<Array<{ x: number; y: number }>> } }
    ).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.cablePolylines !== 'function') {
      throw new Error('window.__fabrico.cablePolylines() not installed');
    }
    return hook.cablePolylines();
  });
}

/**
 * What the re-route mark sampler latched: the largest count seen, how many frames it
 * read, and the first and last frame a mark was plotted, in ms after the sampler started
 * (null when no frame plotted one).
 */
export interface RerouteMarkSample {
  max: number;
  frames: number;
  firstMarkMs: number | null;
  lastMarkMs: number | null;
}

/** The sampler's in-page state: the sample plus its animation-frame handle. */
interface RerouteMarkSampleState extends RerouteMarkSample {
  raf: number;
  live: boolean;
}

/**
 * Start an in-page sampler that reads `rerouteMarkStrokes()` once per ANIMATION FRAME and
 * keeps the maximum (plan 75-06). A Playwright-side poll runs at about 100 ms and could
 * miss a mark that was on screen for a few frames; this cannot, so a negative leg that
 * reads a maximum of 0 over a window means no frame in that window plotted a mark. Start
 * it BEFORE the gesture under test. Replaces a sampler already running.
 */
export async function startRerouteMarkSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabrico?: { rerouteMarkStrokes?(): number };
      __fabMarkSampler?: RerouteMarkSampleState;
    };
    if (typeof w.__fabrico?.rerouteMarkStrokes !== 'function') {
      throw new Error('window.__fabrico.rerouteMarkStrokes() not installed');
    }
    if (w.__fabMarkSampler) {
      w.__fabMarkSampler.live = false;
      cancelAnimationFrame(w.__fabMarkSampler.raf);
    }
    const t0 = performance.now();
    const st: RerouteMarkSampleState = {
      max: 0,
      frames: 0,
      firstMarkMs: null,
      lastMarkMs: null,
      raf: 0,
      live: true,
    };
    const step = (): void => {
      if (!st.live) return;
      const n = w.__fabrico!.rerouteMarkStrokes!();
      st.max = Math.max(st.max, n);
      st.frames += 1;
      if (n > 0) {
        const at = performance.now() - t0;
        if (st.firstMarkMs === null) st.firstMarkMs = at;
        st.lastMarkMs = at;
      }
      st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
    w.__fabMarkSampler = st;
  });
}

/** Read what the running sampler has latched so far. */
export async function readRerouteMarkSampler(page: Page): Promise<RerouteMarkSample> {
  return page.evaluate(() => {
    const w = window as unknown as { __fabMarkSampler?: RerouteMarkSampleState };
    const st = w.__fabMarkSampler;
    if (!st) throw new Error('re-route mark sampler not started');
    return { max: st.max, frames: st.frames, firstMarkMs: st.firstMarkMs, lastMarkMs: st.lastMarkMs };
  });
}

/** Stop the sampler and return its final reading. */
export async function stopRerouteMarkSampler(page: Page): Promise<RerouteMarkSample> {
  return page.evaluate(() => {
    const w = window as unknown as { __fabMarkSampler?: RerouteMarkSampleState };
    const st = w.__fabMarkSampler;
    if (!st) throw new Error('re-route mark sampler not started');
    st.live = false;
    cancelAnimationFrame(st.raf);
    w.__fabMarkSampler = undefined;
    return { max: st.max, frames: st.frames, firstMarkMs: st.firstMarkMs, lastMarkMs: st.lastMarkMs };
  });
}

/** Read `window.__fabrico.stats()` - the monotonic packetsApplied/decodeErrors counters. */
export async function readStats(page: Page): Promise<StatsFacts> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { stats(): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    return hook.stats() as StatsFacts;
  });
}

// ---------------------------------------------------------------------------
// Deterministic polling
// ---------------------------------------------------------------------------

/**
 * Poll until a scene predicate holds: expect.poll over readScene with a
 * generous timeout and tight intervals. The message is MANDATORY so every
 * timeout in the report names the contract that failed - never a bare sleep
 * for state readiness anywhere in the live project.
 */
export function pollScene<T>(
  page: Page,
  read: (s: SceneFacts) => T,
  opts: { timeout?: number; message: string },
) {
  return expect.poll(async () => read(await readScene(page)), {
    timeout: opts.timeout ?? 15_000,
    intervals: [100, 250, 500], // then repeats 500ms
    message: opts.message,
  });
}

// ---------------------------------------------------------------------------
// Geometry (identity camera) - sourced from the ONE shared values module
// (frontend/shared/geometry.ts, GATE-01), the single allowed shared import
// (see the header rationale). The live suite's scalar `cellCentre` is the
// shared `cellCentreX` (X and Y math are identical); nubAnchor and rotateHandle
// come straight from the shared source. INSET/NUB_PUSH now live there.
// ---------------------------------------------------------------------------

export {
  CELL,
  INSET,
  HANDLE_OFFSET,
  cellCentreX as cellCentre,
  nubAnchor,
  rotateHandle,
} from '../../shared/geometry';

// Re-exported above for the specs; ALSO imported into module scope here because
// the belt-draw driver below computes nub points itself (a bare re-export does not
// bind the name locally - it fails at runtime, not at typecheck).
import { CELL as GEOMETRY_CELL, cellCentreX, nubAnchor } from '../../shared/geometry';

// ---------------------------------------------------------------------------
// Camera-aware world->screen transform (NAV-01)
// ---------------------------------------------------------------------------
//
// The pure geometry above is identity-camera world px. The live app can boot
// under a non-identity camera (29-04 fit-to-factory), so every gesture-driving
// coordinate is routed through window.__fabrico.camera() here. The transform is
// the separable, rotation-free map screen = world*scale + pan per axis (RESEARCH
// Finding 4). shared/geometry.ts stays pure; the multiply lives only here. No
// Playwright helper is shared with the mock suite (wire.ts mirrors this
// independently) so the zero-mock single-shared-import audit holds.

/** The read-only pan+zoom snapshot window.__fabrico.camera() returns. */
export interface CameraSnapshot {
  /** Pan X (root Container position, px). */
  x: number;
  /** Pan Y (root Container position, px). */
  y: number;
  /** Uniform zoom (container.scale). */
  scale: number;
}

/**
 * Read window.__fabrico.camera() - the fresh read-only {x,y,scale} pan+zoom
 * snapshot. Throws a clear error if the getter is absent (e.g. queried before
 * the app installed the hook, or against a torn-down handle).
 */
export async function cameraOf(page: Page): Promise<CameraSnapshot> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { camera?(): unknown } }).__fabrico;
    if (!hook || typeof hook.camera !== 'function') {
      throw new Error('window.__fabrico.camera() not installed');
    }
    return hook.camera() as CameraSnapshot;
  });
}

/**
 * Wait until the fit-to-scene camera animation SETTLES: the rounded zoom percent
 * (Math.round(scale*100)) is stable across two consecutive samples. The wider
 * request/response-wire demo boots with a longer fit animation (~100% -> ~35%),
 * during which a single pre-settle camera read races the ~10Hz zoom readout
 * (NAV-02 / 07-zoom-readout: the boot readout is asserted once, unpolled). This is
 * best-effort HARDENING, never an assertion: it is bounded by `timeoutMs` and
 * never throws, so it can only add latency, never redden the shared-host suite.
 *
 * The bound is derived from frames (plan 84-18, D-12). Every camera move it can wait on is
 * one `setCamera` call: the boot fit runs on the first animation frame the chrome is laid
 * out (`fitWhenChromeReady`, `App.tsx`), and the reset, a wheel notch and a drag pan each
 * set the camera on their own event. So the camera is still `DRAWN_STATE_FRAMES` after the
 * step it follows, and the two 180 ms samples ride in the budget's slack.
 */
export async function waitForCameraSettle(page: Page, timeoutMs = frameBudgetMs(DRAWN_STATE_FRAMES)): Promise<void> {
  const start = Date.now();
  let prevPct = Number.NaN;
  for (;;) {
    const pct = Math.round((await cameraOf(page)).scale * 100);
    if (pct === prevPct) return; // two equal samples -> the fit animation has stilled
    prevPct = pct;
    if (Date.now() - start >= timeoutMs) return; // bounded: never hang the suite
    await page.waitForTimeout(180);
  }
}

/**
 * Reset the camera to EXACTLY 100% through the shipped zoom control, then settle it.
 *
 * WHY EVERY SPEC THAT PLACES BY CELL NEEDS THIS, MEASURED AT 72-13 AND NOT REASONED.
 * The app's camera is FIT-TO-CONTENT, and a fit computed over ONE small machine on an
 * otherwise empty board lands at the 400% clamp. `newBoard` does not undo that: with no
 * content there is nothing to fit, so the previous zoom SURVIVES the wipe. A spec that
 * wipes and then places by world cell is therefore at the mercy of whatever the spec
 * BEFORE it left on screen, and at 400% its drop cell can sit outside the canvas
 * entirely - the click lands nowhere and the placement never folds.
 *
 * That is exactly how `26-fault-drain.spec.ts` broke when `25-route-and-handler.spec.ts`
 * was inserted ahead of it in the directory order: 0 machines, zoom 400%, and a 15s poll
 * for a Source that was never placed. That spec had always been camera-dependent and had
 * never said so; it passed because of what happened to run before it.
 *
 * Promoted into the oracle rather than copied a third time:
 * `24-one-board-all-six.spec.ts` carries its own local `resetZoomToActualSize` and
 * `25-route-and-handler.spec.ts` needed the same thing, which is two copies too many of
 * one fact about the shipped camera.
 */
export async function resetZoomToActualSize(page: Page): Promise<void> {
  await page.getByTitle('Reset zoom to 100%').click();
  // Derived (plan 84-18, D-12): the reset snaps the camera in the click's own handler
  // (`onResetZoom`, a view-only `setCamera`, no host command), so the camera reads 100% on
  // the frames after the click.
  await expect
    .poll(async () => Math.round((await cameraOf(page)).scale * 100), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'reset zoom readout poll: the snap read on the frames after the click'),
      intervals: [100, 250, 500],
      message: 'the shipped zoom readout reset the camera to exactly 100%',
    })
    .toBe(100);
  await waitForCameraSettle(page);
}

/** Apply a camera snapshot to a world point: screen = world*scale + pan (per axis). */
function applyCamera(cam: CameraSnapshot, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

/**
 * The live SCREEN point of world cell (cx, cy)'s centre: the identity cell centre
 * transformed through the current camera. Under the identity boot camera this is
 * exactly cellCentre(cx)/cellCentre(cy).
 */
export async function screenCellCentre(
  page: Page,
  cx: number,
  cy: number,
): Promise<{ x: number; y: number }> {
  const cam = await cameraOf(page);
  return applyCamera(cam, cellCentreX(cx), cellCentreX(cy));
}

/**
 * Transform an existing world point (a nubAnchor / rotateHandle output, already
 * identity-camera world px) to the live screen point through the current camera.
 */
export async function screenPoint(
  page: Page,
  worldPt: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const cam = await cameraOf(page);
  return applyCamera(cam, worldPt.x, worldPt.y);
}

// ---------------------------------------------------------------------------
// Pointer + readiness helpers
// ---------------------------------------------------------------------------

/** Click (press+release, no drag) at a screen point. */
export async function clickAt(page: Page, x: number, y: number): Promise<void> {
  await pointerTravel(page, x, y);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * Wait until the REAL app is live: the chrome has rendered (palette drag
 * source visible) AND the scene tick has advanced past 0 - which proves the
 * real WS is connected and real packets decode through the shipped decoder.
 * Callers page.goto('/') first.
 */
export async function waitForChromeAndTick(page: Page): Promise<void> {
  await expect(
    // SHELL-06 (32-03) moved the functional hover copy onto the machine button
    // `title` and kept the STABLE `aria-label="Place ${label}"` accessible name,
    // so readiness resolves by the accessible name (role+name), not the volatile
    // title (which is now "Transforms items (runs your code)").
    page.getByRole('button', { name: 'Place Factory' }),
    'app chrome rendered (palette visible)',
  ).toBeVisible({ timeout: 15_000 });
  await pollScene(page, (s) => s.tick, {
    message: 'real WS connected: scene tick advances past 0 on live packets',
  }).toBeGreaterThan(0);
}

/**
 * The standard readiness gate every non-onboarding spec uses: wait for the live
 * chrome + a ticking WS (above), THEN suppress the ONB-01 first-run welcome card
 * if it is showing. Playwright hands each test a FRESH context (empty
 * localStorage), so the first-run card overlays a cold boot every time; it is a
 * soft, non-blocking overlay, but for the gesture/pixel specs it must be gone
 * BEFORE any interaction so it never perturbs the shared mutable host.
 *
 * Suppression sets the REAL shipped localStorage flag and RELOADS, so the app
 * re-mounts WITHOUT the card - a clean, gesture-free mount (no synthetic click,
 * no overlay painted during the test body), behaving exactly like a returning
 * user. The onboarding spec itself uses `waitForChromeAndTick` directly so it can
 * assert the genuine first-run card before this suppression.
 */
export async function waitForAppReady(page: Page): Promise<void> {
  await waitForChromeAndTick(page);
  const welcome = page.getByRole('heading', { name: 'Welcome to Fabrico' });
  if ((await welcome.count()) > 0) {
    await page.evaluate(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
    await page.reload();
    await waitForChromeAndTick(page);
  }
  // The wider request/response-wire demo boots with a longer fit animation; settle it
  // before any camera read so coordinate transforms + the NAV-02 readout are stable.
  await waitForCameraSettle(page);
}

/**
 * Ensure the shared host sim is PLAYING. A prior spec (15-disconnected) pauses it, and
 * pause is HOST-global - a page reload does not resume it. Two things in this file need
 * a running sim: a Place only folds inside `tick_once`, so on a paused host it is queued
 * forever and never echoes; and the webhook front door answers 503 while the sim is not
 * Playing (Gate A). Toggling is idempotent when the sim is already advancing.
 *
 * DERIVED FROM `ensurePlaying` IN `19-router-rules.spec.ts`, NOT COPIED VERBATIM. Two named
 * divergences, both fixing defects the source copy still carries and both applied for
 * review finding WR-06:
 *   1. The source clicks UNCONDITIONALLY, so a 400ms sample window that happens to
 *      catch no tick advance on a HEALTHY host presses Pause on it. This copy presses
 *      only when the control offers Play.
 *   2. The source takes three samples but makes three clicks, so the click after the
 *      LAST sample is never read back and a resume achieved on it still throws. This
 *      copy re-reads once after the loop.
 * `19-router-rules.spec.ts` is outside this phase's scope and was left alone; it wants
 * the same two fixes.
 *
 * THE ONE TIMED WAIT IN THIS FILE IS THE ONE INSIDE THIS HELPER, AND IT IS NOT A
 * SETTLE. It is a timed SAMPLE of the tick rate - the quantity being measured. The
 * final read-back added above is a `pollScene`, not a second sample, so the count
 * below is unchanged at one.
 * Every other wait in this file is a `pollScene` naming the specific change
 * it awaits, because no fixed sleep is a settle anywhere in the live suite. A gate in
 * `69-04-PLAN.md` counts the occurrences in this file and requires EXACTLY ONE, inside
 * this function's body: a count of zero means the copy was altered, and a count above
 * one means somebody added a sleep as a settle.
 *
 * HOISTED HERE BY PLAN 77-01 (phase 77 D-03). The docblock above is the one this helper
 * carried in `24-one-board-all-six.spec.ts` (`:290-337`), copied whole; "this file" in it
 * means that spec, not this module. The helper has TWO origins, and both keep their own
 * copies untouched: `24-one-board-all-six.spec.ts`, whose body this is, and
 * `16-router-presets.spec.ts`, which carries the same shape. They are left as they are
 * because spec 24 is the v8.0 done-test pinned by
 * `src/gates/liveWalkDeclarationOrder.source.test.ts` (77 D-01), and an edit to either
 * would move a shipped walk for no gain. Its one timed 400 ms read is a SAMPLE of the
 * tick rate, never a settle.
 *
 * WHAT IT CANNOT DO (77-01, measured against `sim_loop.rs`). It presses only when the
 * control offers Play, and the control is the page's OWN optimistic glyph: a fresh page
 * boots reading `Pause` (`bootState.ts` `SIM_BOOTS_PLAYING`) and nothing syncs it from the
 * host. So a host an earlier page left USER-paused reads `Pause` here, is never pressed,
 * and this helper throws 'could not resume the sim'. A caller that must survive that
 * clears the pause itself first (the composed walk's boot does).
 */
/**
 * THE HOST AFTER A TEST THAT DID NOT PASS (plan 84-13, D-12). The live suite runs one shared,
 * mutable host, and pause is host-global. A test that pauses the host and then times out
 * never reaches the `finally` that presses Play: Playwright stops waiting for the test body
 * at the timeout and runs the `afterEach` hooks next, with the test's `page` still open
 * (`@playwright/test` 1.61.1, `lib/worker/workerProcessEntry.js`: the after-hooks slot runs
 * `afterEach` before the test-scoped fixture teardown that closes the page). The host then
 * stays user-paused, a New or a demo reload swaps the board but stays frozen at tick 0, and
 * every later spec waits for a tick past 0 that never comes. The midday 2026-10-13 CI run showed the
 * cascade after `76-same-cell-double-drop` leg 5 timed out while paused.
 *
 * Every live spec that pauses the host registers this as an `afterEach`. After a test that
 * PASSED it does nothing, so a test that leaves the board stopped and passes stays a loud red
 * in the test after it. After a test that did not pass it restores the host to running on a
 * fresh page in the same context (the test page may still be mid-gesture in the abandoned
 * body): the transport's Pause then Resume pair (the composed walk's boot, which clears a
 * recorded user pause), then a wait for the tick to advance, and logs `HOST RESTORED after
 * <title>`. It never changes the failed test's verdict; a restore that fails is an error on
 * that same failed test.
 */
export async function restoreHostAfterFailedTest(page: Page, testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  const fresh = await page.context().newPage();
  try {
    await fresh.addInitScript(() => localStorage.setItem('fab.onboarding.seen.v1', '1'));
    await fresh.goto('/');
    await expect(fresh.getByRole('button', { name: 'Place Factory' }), 'HOST RESTORE: the app chrome rendered').toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => fresh.evaluate(() => typeof (window as { __fabrico?: { scene?(): unknown } }).__fabrico?.scene === 'function'), {
        message: 'HOST RESTORE: the oracle bridge is installed',
        timeout: 15_000,
      })
      .toBe(true);
    const t0 = (await readScene(fresh)).tick;
    const btn = fresh.getByRole('button', { name: /^(Play|Pause)$/ });
    if ((await btn.getAttribute('aria-label')) === 'Pause') {
      await btn.click();
      await expect(btn, 'HOST RESTORE: the first press sent Pause').toHaveAttribute('aria-label', 'Play');
    }
    await btn.click();
    await expect(btn, 'HOST RESTORE: the second press sent Resume').toHaveAttribute('aria-label', 'Pause');
    await pollScene(fresh, (s) => s.tick, {
      timeout: 15_000,
      message: `HOST RESTORE: after Pause then Resume the host ticks again (tick was ${t0})`,
    }).toBeGreaterThan(t0);
    console.log(
      `HOST RESTORED after ${testInfo.title} (status ${testInfo.status}; tick ${t0} -> ${(await readScene(fresh)).tick})`,
    );
  } finally {
    await fresh.close().catch(() => {});
  }
}

export async function ensurePlaying(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: /^(Play|Pause)$/ });
  for (let i = 0; i < 3; i += 1) {
    const t0 = (await readScene(page)).tick;
    await page.waitForTimeout(400);
    if ((await readScene(page)).tick > t0) return;
    // ONLY press when the control OFFERS Play. The original unconditional click
    // toggles a HEALTHY host into Pause whenever a 400ms window happens to show no
    // tick advance (a slow first paint after `page.goto`, a stalled WS delivery),
    // and every leg calls this helper on attach, on a file running `retries: 0`.
    // The button is ICON-ONLY, so its accessible name is the `aria-label`
    // (`Toolbar.tsx:278`) and NOT `textContent`, which is empty on it.
    if ((await btn.getAttribute('aria-label')) === 'Play') await btn.click();
  }
  // THE CLICK MADE AFTER THE LAST SAMPLE IS VERIFIED TOO. The loop takes three
  // samples but makes up to three clicks, so the third click was never read back
  // and a resume achieved on it still threw. This is a `pollScene` and not a
  // fourth timed sample: it names the change it waits for, and it leaves the
  // fixed-sleep count in this file at exactly ONE (the timed sample above). That
  // token is deliberately not spelled out on this line: 69-04-PLAN.md's gate
  // COUNTS it, so a prose mention would break the gate exactly the way the
  // modifier prose further down is careful not to.
  const tLast = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > tLast, {
    timeout: 5_000,
    message:
      'could not resume the sim: after three Play presses the tick still never advanced',
  }).toBe(true);
}

// ---------------------------------------------------------------------------
// RENDER-LOOP HEALTH (added with the `machines-missing-webkitgtk` fix)
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS, because its absence is why six phases shipped blind. Every
// assertion in this suite reads the MODEL: `window.__fabrico.scene()` is fed by the
// packet/React path, which is completely independent of the Pixi ticker. So an
// uncaught exception inside a Pixi ticker listener kills the renderer permanently -
// `Ticker._tick` only re-requests its animation frame AFTER `update()` returns - while
// `scene().tick` keeps climbing and every model assertion in the suite stays green.
// That is exactly what happened: `10-machine-lod.spec.ts` drove the real wheel-zoom
// that triggered the crash and passed, because it only ever asked the model whether the
// machines were still THERE, never whether anything was still being DRAWN.
//
// The two helpers below are the two halves of "still drawn", and neither reads a pixel:
//
//   watchPageErrors    an uncaught page error is a RED GATE, not a console curiosity.
//   expectRenderLoopAlive  `__fabrico.frame()` is derived from the render clock, which
//                      only advances inside the ticker. tick climbing while frame is
//                      frozen is the precise signature of a dead render loop.
//
// Use BOTH on any spec that drives the camera, and use them on BOTH sides of a gesture:
// the crash this was written for fired on the way back IN, not on the way out.

/** Read `window.__fabrico.frame()` - the ticker-driven render frame index (MOTION-04). */
export async function frameOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { frame?(): number } }).__fabrico;
    if (!hook?.frame) {
      throw new Error('window.__fabrico.frame() not installed');
    }
    return hook.frame();
  });
}

/**
 * Fail the test on ANY uncaught page error, at the point the caller asks.
 *
 * Install it BEFORE `page.goto` so a boot-time throw is caught too. It collects rather
 * than throwing inline, because a Playwright `pageerror` fires outside the assertion
 * stack and an inline throw there surfaces as an unhelpful unhandled rejection.
 */
export function watchPageErrors(page: Page): { assertNone(context: string): void } {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.message}\n${e.stack ?? '(no stack)'}`));
  return {
    assertNone(context: string): void {
      expect(errors, `uncaught page error ${context}`).toEqual([]);
    },
  };
}

/**
 * Assert the Pixi render loop is still advancing.
 *
 * `frame()` is `quantizedFrame(renderClock)` and the render clock only moves inside the
 * ticker, so this is a DOM-free, GPU-free liveness oracle for the renderer itself. It
 * polls rather than sleeping a fixed interval (the live suite's locked drive rule); the
 * frame index advances roughly once per `SIM_TICKS_PER_FRAME` sim ticks, so the budget
 * is generous relative to that cadence and a genuine stall still reddens well inside it.
 *
 * ===========================================================================
 * THE PREDICATE THIS FUNCTION USED, AND WHY IT COULD NOT BE KEPT (plan 62-05).
 * ===========================================================================
 *
 * IT READ: `await expect.poll(() => frameOf(page)).toBeGreaterThan(before)`.
 *
 * **`frame()` WRAPS, so that comparison is UNSATISFIABLE at 23.** `quantizedFrame` is
 * `((q % FRAMES) + FRAMES) % FRAMES` with `FRAMES = 24`, so the range is [0, 23] -
 * MEASURED live on the real `dev_render_server` 2026-08-13, sampling every 50ms:
 *
 *   ...,21,21,22,22,23,23,0,0,1,1,2,...
 *
 * When `before` is 23 no value the oracle can ever return exceeds it, so the poll burns
 * its whole 15s budget and reddens a PERFECTLY HEALTHY loop. That is not a theoretical
 * 1-in-24: plan 62-05's new moving-dot health leg hit it on 3 runs out of 4, because a
 * spec with reproducible choreography lands on the same frame index every run. The loop
 * was proved alive at the moment of the failure by direct sampling (frame went
 * 23, 2, 5, 8, 11, 14, 17, 20 while the assertion below was failing).
 *
 * A HEALTH GATE THAT CRIES WOLF IS HOW A HEALTH GATE GETS DELETED, which is why this is
 * corrected rather than worked around in the caller.
 *
 * ===========================================================================
 * WHAT REPLACES IT IS STRICTLY MORE EVIDENCE, NOT LESS.
 * ===========================================================================
 *
 * The new predicate requires the frame index to take **at least three DISTINCT values**
 * (the starting one plus two more) inside the budget. Against the failure mode this
 * function exists for it is strictly stronger:
 *
 *   - A STOPPED loop holds the index CONSTANT - one distinct value - and fails, exactly
 *     as it failed the old comparison. Detection power for a stall is unchanged.
 *   - The old form accepted a SINGLE observation of a larger value. The new one demands
 *     TWO independent advances, so a loop that limped one queued frame and then died
 *     now reddens where it used to pass.
 *
 * The one thing the old form rejected and this does not is a strictly DECREASING clock.
 * That is not a stall: `advanceRenderClock` collapses the clock backwards on purpose
 * when `latestSimTick` drops (a seek / replay rewind / LoadDemo genesis swap), and a
 * genesis swap is exactly what puts the clock at -1, whose quantized frame IS 23. The
 * old predicate was therefore rejecting a supported behaviour and calling it death.
 *
 * `FRAMES` is deliberately NOT re-typed here to do modular arithmetic: GATE-01 allows
 * this file exactly one shared import (`shared/geometry`), and "the index moved" needs
 * no knowledge of the cycle length at all.
 *
 * THE CAP, derived (plan 84-18, D-12). `frame()` is `floor(clock / 6) % 24` (`interp.ts`
 * `quantizedFrame`, 6 sim ticks a value), and the render clock moves only in the Pixi ticker, by
 * a drawn frame's milliseconds over 16.7 ms a tick, never past the board's tick less its lag
 * (`advanceRenderClock`). So each of the two advances needs one drawn frame and 6 ticks of the
 * board's clock, and a read may land a frame early: `RENDER_LOOP_ADVANCES + DRAWN_STATE_FRAMES`
 * frames and `RENDER_LOOP_ADVANCES x RENDER_FRAME_TICKS` ticks.
 */
export async function expectRenderLoopAlive(
  page: Page,
  context: string,
  opts: { boardHeld?: boolean } = {},
): Promise<void> {
  if (opts.boardHeld === true) {
    await expectRenderLoopAliveOnAHeldBoard(page, context);
    return;
  }
  const before = await frameOf(page);
  const seen = new Set<number>([before]);
  await expect
    .poll(
      async () => {
        seen.add(await frameOf(page));
        return seen.size;
      },
      {
        message:
          `the Pixi render loop is still advancing ${context} (frame() was ${before}; ` +
          `a stalled loop holds ONE value, and two independent advances are required)`,
        timeout: addWaitBudget(
          frameBudgetMs(RENDER_LOOP_ADVANCES + DRAWN_STATE_FRAMES) + tickBudgetMs(RENDER_LOOP_ADVANCES * RENDER_FRAME_TICKS),
          'render loop alive poll: two advances of the quantized clock',
        ),
      },
    )
    .toBeGreaterThanOrEqual(3);
}

/** `window.__fabrico.tickerTime()`: when the Pixi ticker last finished a frame. */
async function tickerTimeOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { tickerTime?(): number } }).__fabrico;
    if (!hook?.tickerTime) {
      throw new Error('window.__fabrico.tickerTime() not installed');
    }
    return hook.tickerTime();
  });
}

/**
 * Render health on a HELD board (phase 90, FAIL-01): `expectRenderLoopAlive(page, context,
 * { boardHeld: true })`, for a board whose sim does not tick (a stopped simulation), where the
 * render clock, and so `frame()`, stands still by design.
 *
 * It reads the Pixi ticker itself instead: `tickerTime()` is `app.ticker.lastTime`, which Pixi
 * sets after every listener of a frame has returned, and a listener that throws stops the ticker
 * (the dead-renderer failure `expectRenderLoopAlive` exists for). So it must take at least three
 * distinct values, the start and two finished frames, inside the budget. It also requires the
 * board's tick to stand still for the whole window: a caller that names a running board held is
 * red, so this form cannot stand in for the frame-clock check on a running board.
 *
 * THE CAP: two drawn frames at the floor rate plus the slack a read may land on.
 */
async function expectRenderLoopAliveOnAHeldBoard(page: Page, context: string): Promise<void> {
  const tickAtStart = (await readScene(page)).tick;
  let tickMoved: number | null = null;
  const seen = new Set<number>([await tickerTimeOf(page)]);
  await expect
    .poll(
      async () => {
        const tick = (await readScene(page)).tick;
        if (tick !== tickAtStart) tickMoved = tick;
        seen.add(await tickerTimeOf(page));
        return seen.size;
      },
      {
        message:
          `the Pixi ticker is still finishing frames ${context} (a held board: the render clock ` +
          `stands still, so the ticker's last frame time must move twice)`,
        timeout: addWaitBudget(
          frameBudgetMs(RENDER_LOOP_ADVANCES + DRAWN_STATE_FRAMES),
          'render loop alive on a held board: two finished ticker frames',
        ),
      },
    )
    .toBeGreaterThanOrEqual(3);
  expect(tickMoved, `the board is held ${context}: its tick stays ${tickAtStart} while the ticker is read`).toBeNull();
}

/**
 * Assert `#fab-refusal` NEVER said anything, LATCHED across the whole window in which
 * `until` runs. The exact inverse of {@link captureRefusalText}, and it
 * reuses that helper's `[100, 250, 500]` ladder verbatim.
 *
 * # Why a single post-hoc read is NOT equivalent, measured rather than argued
 * `RefusalMessage.tsx`'s `REFUSAL_HOLD_MS` is 4000. A sentence that appears the instant
 * Ctrl+Z is pressed is therefore GONE four seconds later, so an assertion written as
 * "press the key, do the work, then read the region and expect an empty string" can only
 * fail if the read happens to land INSIDE that four-second window. On a loaded CI box it
 * may not, and then a build that refused the gesture and told the user so passes a test
 * whose entire purpose is to prove it did not.
 *
 * The other half of the same problem: `#fab-refusal` is EMPTY AT REST by design, so a
 * lone empty reading is also satisfied by a build where Ctrl+Z did nothing at all, and by
 * one where the React tree never mounted. That is why this helper takes the positive
 * assertion as `until` rather than being callable on its own: the silence is meaningful
 * only when something else in the same test proved the board actually changed.
 *
 * Poll from BEFORE the gesture until the positive half resolves, latch the FIRST
 * non-empty reading ever seen, and assert the latch is still empty at the end.
 *
 * @param page    the live page
 * @param context named in the failure message, so a red says which gesture was refused
 * @param until   the gesture AND its positive assertion; the poll runs for its lifetime
 */
export async function expectRefusalStayedSilent(
  page: Page,
  context: string,
  until: () => Promise<void>,
): Promise<void> {
  // The ladder, verbatim from `captureRefusalText`. Same cadence, opposite verdict.
  const LADDER = [100, 250, 500];
  let latched = '';
  let running = true;

  const poll = (async () => {
    let step = 0;
    while (running) {
      // `.catch` rather than a pre-check: the region is a normal part of the shell, but
      // a navigation mid-poll would otherwise turn a benign teardown race into a
      // failure that reads like a refusal.
      const now = (
        (await page
          .locator('#fab-refusal')
          .textContent()
          .catch(() => '')) ?? ''
      ).trim();
      if (now !== '' && latched === '') {
        latched = now;
      }
      const wait = LADDER[Math.min(step, LADDER.length - 1)];
      step += 1;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  })();

  try {
    await until();
  } finally {
    running = false;
    await poll;
  }

  expect(
    latched,
    `the refusal region stayed SILENT for the whole ${context} window; it read ` +
      `"${latched}" instead, so the host refused a gesture this test requires it to carry out`,
  ).toBe('');
}

/**
 * Record EVERY text the toolbar's status strip (`[data-fab-status-strip]`: the readout and the
 * `Unsaved` badge) shows while `until` runs, and return them in order (plan 77-05, done-test leg
 * 5's "no message appears at the top of the screen").
 *
 * WHY A RECORDING AND NOT A READ. Every transient the strip shows (`Loaded`, `Save requested`,
 * `Paused - press Play before undo or redo`, ...) clears itself after `STATUS_AUTOCLEAR_MS`
 * (4 s, `App.tsx`; `statusMachine.ts`). A read before and a read after a gesture, or a poll
 * that waits for the expected text, passes on a build that showed a sentence inside the window
 * and cleared it. So an in-page `MutationObserver` on the strip (child list, subtree, character
 * data) pushes the strip's trimmed text whenever it differs from the last text pushed, with the
 * first sample taken on install, and the caller grades the whole list (for "nothing on top",
 * `toEqual([textBefore])`). It is `expectRefusalStayedSilent`'s latch made continuous: that one
 * polls `#fab-refusal` on a ladder, this one sees every change the DOM makes.
 *
 * WHAT IT CANNOT SEE: whether the strip was painted (it is a DOM read), and any text outside
 * the strip. Read-only: it observes, and disconnects before it returns, also when `until` throws.
 *
 * THE SCENE BADGE IS NOT RECORDED (phase 91, plan 91-10, CHROME-15, research Finding H). Since
 * that plan the strip also holds the scene badge (`[data-fab-scene-badge]`, `Demo scene` and the
 * other example names) between the status and `Unsaved`. It is not a message: it names the board
 * for as long as an example is loaded. So each sample is the strip's text with the badge subtree
 * dropped (a clone of the strip, every badge node removed, then `textContent`), and the callers'
 * grades stay what they were: `90-sim-fatal.terminal.spec.ts` still reads only `Simulation
 * stopped` on the demo. Nothing else is dropped; the badge has its own assertions in
 * `91-toolbar.live.spec.ts`.
 *
 * @param page  the live page
 * @param until the gesture and its positive assertions; the observer runs for its lifetime
 */
export async function recordStatusStripDuring(
  page: Page,
  until: () => Promise<void>,
): Promise<string[]> {
  await page.evaluate(() => {
    const strip = document.querySelector('[data-fab-status-strip]');
    if (strip === null) {
      throw new Error('recordStatusStripDuring: [data-fab-status-strip] is not in the page, so there is no strip to record');
    }
    const w = window as unknown as { __fabStripSeen?: string[]; __fabStripObserver?: MutationObserver };
    w.__fabStripObserver?.disconnect();
    const seen: string[] = [];
    // The strip's text without the scene badge's subtree (see the docblock).
    const stripText = (): string => {
      const clone = strip.cloneNode(true) as Element;
      clone.querySelectorAll('[data-fab-scene-badge]').forEach((b) => b.remove());
      return (clone.textContent ?? '').trim();
    };
    const sample = (): void => {
      const text = stripText();
      if (seen.length === 0 || seen[seen.length - 1] !== text) seen.push(text);
    };
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(strip, { childList: true, subtree: true, characterData: true });
    w.__fabStripSeen = seen;
    w.__fabStripObserver = observer;
  });
  const collect = (): Promise<string[]> =>
    page.evaluate(() => {
      const w = window as unknown as { __fabStripSeen?: string[]; __fabStripObserver?: MutationObserver };
      w.__fabStripObserver?.disconnect();
      const seen = w.__fabStripSeen;
      delete w.__fabStripObserver;
      delete w.__fabStripSeen;
      if (seen === undefined) {
        throw new Error('recordStatusStripDuring: the strip recording was never installed or was removed before it was read');
      }
      return [...seen];
    });
  try {
    await until();
  } catch (e) {
    await collect().catch(() => []);
    throw e;
  }
  return collect();
}

// ---------------------------------------------------------------------------
// The Examples popover click path (EX-02)
// ---------------------------------------------------------------------------
//
// Phase 55-02 relocated the shipped `Load demo scene` CTA into a two-entry
// disclosure behind an `Examples` trigger. The entry copy - label AND title -
// moved VERBATIM, so every historical `getByTitle` selector still resolves; what
// changed is the click PATH (open the popover first) and, on a dirty board, the
// new A3 guard that now asks before discarding. Both live here, in ONE place, so
// the ~15 `resetToDemo` callers and the migrated spec call sites cannot drift.

/**
 * The shipped Examples entries, as the live suite addresses them: typed wire id
 * -> the VERBATIM entry title the popover renders. Mirrored here rather than
 * imported because oracle.ts is structurally zero-product-import (see header);
 * the demo-badge / examples specs assert the same strings, so a copy drift
 * reddens the suite rather than silently mis-clicking.
 */
type ExampleWireId = 'demo_scene' | 'order_processing' | 'advanced';

const EXAMPLE_TITLE: Record<ExampleWireId, string> = {
  demo_scene: 'Load the demo scene and watch the engine run',
  order_processing: 'Load the order-processing example (webhook in, HTTP out)',
  advanced: 'Load the advanced order-fulfilment example (parallel workers, dead-letter queue)',
};

/** The popover's stable DOM id (ExamplesPopover's EXAMPLES_POPOVER_ID). */
const EXAMPLES_POPOVER_SELECTOR = '#fab-examples-popover';

/**
 * Open the Examples popover and wait for it to be interactable. The panel is
 * mounted ONLY while open (the Legend/Help disclosure idiom), so the visibility
 * of BOTH entries is the settled signal - there is no closed-but-hidden DOM to
 * race against.
 *
 * IDEMPOTENT (WR-11): the trigger is a TOGGLE, so an unconditional click on an
 * already-open popover would CLOSE it and then fail the visibility expects with
 * a message claiming the opposite of what happened. Click only when the panel is
 * absent, so a caller that opens twice is a no-op instead of a misleading red.
 */
export async function openExamples(page: Page): Promise<void> {
  if ((await page.locator(EXAMPLES_POPOVER_SELECTOR).count()) === 0) {
    await page.getByRole('button', { name: 'Examples' }).click();
  }
  await expect(
    page.getByRole('button', { name: 'Load demo scene' }),
    'the Examples popover opened (entry 1 visible)',
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Load order processing' }),
    'the Examples popover opened (entry 2 visible)',
  ).toBeVisible();
}

/**
 * The ticks a playing host may take to answer an edit (phase 90, D-03): `MAX_SETTLE_TICKS`
 * (512, `sim_loop.rs`), the longest a Save's drain holds input on a running board (D-08),
 * plus 64 for the fold and the round trip. A poll on it returns as soon as the count is 0,
 * which on a playing board is about one tick after the last edit was sent.
 */
const EDIT_VERDICT_TICKS = 512 + 64;

/**
 * Wait until the host has answered every EDIT gesture this page sent (phase 90, D-03,
 * research Finding I), read off `window.__fabrico.editsAwaitingVerdict()`.
 *
 * WHY. Since D-03 the `Unsaved` badge lights when the host ACCEPTS an edit, about one tick
 * after the panel or the hand sent it, not when the panel clears its marker. `newBoard` and
 * `selectExampleEntry` read the guard's predicate first (`guardWillAsk`) and require the discard
 * guard only when it says so, so a pre-read taken between the send and the accept would read
 * clean, click, and meet a guard it did not expect.
 *
 * ON A PLAYING BOARD ONLY (the transport button offers `Pause`). A paused host answers its
 * queued edits only on Play, or discards them at a swap, so there the count can stand above 0
 * indefinitely. Nothing is lost by not waiting: since review WR-B-03 an edit queued on a paused
 * board counts as unsaved work the moment it is sent (`hasUnsavedWork`), so the guard asks and
 * `guardWillAsk` already reads true. Until that fix this helper stepped around the loss: a paused
 * board's queued edit met no guard and was dropped with the old board.
 */
export async function waitForEditVerdicts(page: Page): Promise<void> {
  const transportButton = page.getByRole('button', { name: /^(Play|Pause)$/ });
  if ((await transportButton.getAttribute('aria-label')) !== 'Pause') return;
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __fabrico: { editsAwaitingVerdict(): number } }).__fabrico.editsAwaitingVerdict(),
        ),
      {
        timeout: tickBudgetMs(EDIT_VERDICT_TICKS),
        intervals: [50, 100, 250],
        message: 'every edit gesture this page sent has its host answer (editsAwaitingVerdict is 0)',
      },
    )
    .toBe(0);
}

/**
 * Wait until the host has written `path` whole (phase 90 review IN-C-04): the file exists, holds
 * bytes, and two reads of its hash 300 ms apart agree. `existsSync` alone turns true at creation,
 * so a zero-byte or partly written file passed the specs that read it straight after. The host
 * writes a save in one go at the settle, so two equal hashes mean the write is over. Moved here
 * from `90-save-after-new` so every spec that reopens a saved file waits the same way.
 */
export async function waitForFile(path: string, what: string, timeoutMs = 45_000): Promise<void> {
  await expect.poll(() => existsSync(path), { timeout: timeoutMs, intervals: [200, 500, 1000], message: what }).toBe(true);
  const hashOf = (): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  let last = '';
  await expect
    .poll(
      () => {
        const h = hashOf();
        const same = h === last;
        last = h;
        return same;
      },
      { timeout: 10_000, intervals: [300], message: `${what}: its bytes are stable` },
    )
    .toBe(true);
  expect(statSync(path).size, `${what}: the file holds bytes`).toBeGreaterThan(0);
}

/**
 * Whether New, an Open, an example or quit will ask first (phase 90 review WR-B-03, WR-C-10): the
 * page's own guard predicate, `window.__fabrico.hasUnsavedWork()`, which is the board's unsaved
 * edits (the `Unsaved` badge) or edits queued on the paused board that the host holds until Play
 * (no badge: nothing was accepted yet). Throws when the hook is not installed, so a renamed hook
 * can never read as "no guard" (review IN-C-02).
 */
export async function guardWillAsk(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __fabrico?: { hasUnsavedWork?(): boolean } }).__fabrico;
    if (typeof hook?.hasUnsavedWork !== 'function') {
      throw new Error('guardWillAsk: window.__fabrico.hasUnsavedWork is not installed');
    }
    return hook.hasUnsavedWork();
  });
}

/**
 * Select a popover `entry` locator, taking the A3 discard guard when the board holds
 * unsaved work (`guardWillAsk`). The locator is LAZY (Playwright resolves it at click time),
 * so callers build it from the verbatim entry title before the panel exists.
 *
 * The pre-read is the guard's own predicate (`hasUnsavedWork`, review WR-B-03), so this is a
 * deterministic read of the flag the guard consults - never a race against a dialog that may
 * or may not appear. Until review pass 2 it was the `Unsaved` badge, which a paused board's
 * queued edit never lights. A board that should ask and does NOT raise the guard fails loudly
 * on the Discard expectation instead of silently timing out later.
 */
async function selectExampleEntry(page: Page, entry: Locator): Promise<void> {
  // Phase 90 (D-03): an edit's accept lights the badge about one tick after it is sent, so the
  // pre-read waits until every edit this page sent has its answer (research Finding I).
  await waitForEditVerdicts(page);
  const asks = await guardWillAsk(page);
  await openExamples(page);
  await entry.click();
  if (asks) {
    const discard = page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' });
    await expect(
      discard,
      'the A3 example guard opened on a board with unsaved work (Discard proceeds with the load)',
    ).toBeVisible();
    await discard.click();
  }
}

/**
 * Click through to the shipped demo scene: open the Examples popover, then click
 * entry 1 by the title that relocated onto it byte-identically. This is the ONE
 * place in the live project that owns that selector.
 */
export async function loadDemoViaExamples(page: Page): Promise<void> {
  await selectExampleEntry(page, page.getByTitle(EXAMPLE_TITLE.demo_scene));
}

/**
 * Load a NON-demo shipped example through the popover and settle on its scene
 * facts - the `resetToDemo` shape with the order scene's numbers. The order
 * scene seeds NEITHER the demo's caller and handler pair NOR the demo timers, so its settled
 * facts are `expectedNodes` nodes and ZERO wires.
 *
 * Swap detection matches `resetToDemo`: the genesis swap re-seeds the tick low,
 * so a tick that has dropped BELOW the pre-click value on the expected topology
 * is an unambiguous "the swap landed", with no magic pre-wait threshold.
 *
 * `id` SELECTS the entry (WR-11). It used to be message-only decoration while
 * the click target was hardcoded to the order example, so the day a third
 * example widened the union every `loadExample(page, 'new_scene')` would have
 * loaded order processing and failed naming a scene it never clicked.
 */
export async function loadExample(
  page: Page,
  id: Exclude<ExampleWireId, 'demo_scene'>,
  expectedNodes = 6,
): Promise<void> {
  const before = await readScene(page);
  const tickBefore = before.tick;
  // A board of another shape before the click: its topology giving way to this one is the
  // swap, whatever the ticks read (plan 84-11, `resetToDemo`).
  const sameShape = before.nodes.length === expectedNodes && before.wires.length === 0;
  await selectExampleEntry(page, page.getByTitle(EXAMPLE_TITLE[id]));
  await pollScene(
    page,
    (s) => (s.tick < tickBefore || !sameShape) && s.nodes.length === expectedNodes && s.wires.length === 0,
    {
      message: `the ${id} genesis swap folded onto its baseline (sim tick restarted, ${expectedNodes} nodes, no wires)`,
    },
  ).toBe(true);
  await waitForCameraSettle(page);
}

/**
 * Reset the SHARED mutable host to the pristine demo baseline via the shipped "Load
 * demo scene" genesis swap (now reached through the Examples popover, 55-02). The
 * live suite runs workers:1 against ONE mutable host,
 * and only the mutating specs reset it - at their START. A spec that DRIVES the host
 * but does not (a config Apply, a wire POST) inherits the previous spec's leftover
 * state, which is order-dependent pollution (12/13 passed in isolation but failed in
 * the full run). LoadDemo now RESUMES on the immediate arm (CR-01 host fix), so this
 * restores a fresh, FLOWING core with the demo's dormant caller and handler cables + a
 * re-registered endpoint even if a prior spec left the sim Frozen.
 *
 * Swap detection: capture the pre-swap tick, then poll for the sim tick RESTARTING
 * BELOW it onto the demo topology (`expectedNodeCount` nodes + 2 dormant wires). The
 * swap re-seeds the tick low (~seed length) and - now that LoadDemo resumes - it
 * climbs again, so the low restart is a catchable, unambiguous drop from any running
 * tick (frozen or playing), without a magic pre-wait threshold.
 *
 * A YOUNG BOARD OF ANOTHER SHAPE (plan 84-11). The tick drop alone cannot see a swap from a
 * board that has run fewer ticks than the demo's genesis restarts at: `74.1-paused-edits` leg
 * 6 loads the order example and resets straight after, and on two pinned cores the example
 * read tick 46 at the click while the demo restarted at 50, so the poll never saw `tick < 46`
 * and ran out with the demo on screen (the live suite's pass of plan 84-11; the same red at a
 * 100% CPU quota in its reproduction). When the board before the click is not the demo's shape,
 * the demo's topology appearing IS the swap; from a demo board the tick drop is still required.
 */
export async function resetToDemo(page: Page, expectedNodeCount = DEMO_NODE_COUNT): Promise<void> {
  const before = await readScene(page);
  const tickBefore = before.tick;
  const sameShape = before.nodes.length === expectedNodeCount && before.wires.length === 2;
  await loadDemoViaExamples(page);
  await pollScene(
    page,
    (s) =>
      (s.tick < tickBefore || !sameShape) && s.nodes.length === expectedNodeCount && s.wires.length === 2,
    {
      message:
        'the LoadDemo genesis swap folded onto the demo baseline (sim tick restarted, wires reseeded)',
    },
  ).toBe(true);
  // WINDOWS ROW 114, MEASURED AND CLOSED (plan 66-10). The LoadDemo genesis swap
  // restores the SCENE but NOT the CAMERA, and the boot fit runs only at boot. So a
  // spec that left the camera zoomed poisoned every LATER spec that projects a world
  // cell to a screen point: `screenCellCentre` computed a point OUTSIDE the viewport,
  // `page.mouse` clicked nothing, and the failure surfaced as an unexplained "the
  // placement folded" timeout in the NEXT spec rather than in the one that moved the
  // camera.
  //
  // THE READING THAT SETTLED IT, taken by running `19-router-rules` then
  // `20-wire-draw` in order and dumping the camera at the drop point:
  //   cam={"x":-287.58,"y":-221.80,"scale":3.5784} drop={"x":2059.85,"y":866.04}
  //   viewport={"width":1280,"height":720}
  // against the same spec run ALONE:
  //   cam={"x":249.73,"y":249.45,"scale":1.1010} drop={"x":972.02,"y":584.17}
  // The poisoned drop point is 780px right and 146px below the viewport. Note the
  // DIRECTION: the camera is zoomed IN 3.58x, not zoomed out as row 114 guessed
  // (19-router-rules works from an EMPTY board, so fit-to-content zooms hard).
  //
  // `waitForCameraSettle` alone could never have caught it: it returns as soon as two
  // consecutive rounded zoom samples agree, and a camera that is not animating at all
  // is "settled" on the first pair. Settled is not the same as correct.
  //
  // The restore is the SHIPPED gesture rather than a camera poke: the `Fit factory to
  // view` control invokes the exact `doFit` closure boot and the Home key use, so a
  // reset board ends on the camera a fresh boot would have given it.
  await page.getByTitle('Fit factory to view (Home)').click();
  await waitForCameraSettle(page);
}

/**
 * Wipe to a genuinely EMPTY board through the shipped New control, taking the
 * SAVE-05 discard guard when the board holds unsaved work.
 *
 * The pre-read is `selectExampleEntry`'s discipline (55-03, review WR-B-03): read the guard's
 * predicate (`guardWillAsk`) BEFORE the gesture, then REQUIRE the guard when it says the board
 * holds unsaved work, rather than probing for a dialog that may or may not appear. A board that
 * fails to raise the guard fails loudly here.
 *
 * IT WAITS FOR THE SWAP ITSELF, not only for an empty scene (plan 74.1-35). The host
 * now discards every gesture queued on the board a swap replaces, so a helper that
 * returned while the old board was still on screen (an already-empty board reads
 * empty at once) would let the spec's next draw reach the host BEFORE the swap and be
 * dropped with the old board. The swap re-seeds the tick, so the wait is the one
 * `resetToDemo` uses: an empty scene whose tick is below the tick read before the
 * click. It is latched every animation frame in the page, because a playing new board
 * climbs back past a small old tick within a second and a coarser poll could miss
 * the dip. When the tick before the click is 0 there is no dip to see, and the
 * empty-scene wait stands alone.
 */
export async function newBoard(page: Page): Promise<void> {
  // Phase 90 (D-03): the pre-read waits for every edit this page sent to be answered, since an
  // accept is what lights the badge (research Finding I).
  await waitForEditVerdicts(page);
  const asks = await guardWillAsk(page);
  const tickBefore = (await readScene(page)).tick;
  if (tickBefore > 0) {
    await page.evaluate((before) => {
      const w = window as unknown as {
        __fabrico: { scene(): { tick: number; nodes: unknown[]; belts: unknown[] } };
        __newBoardSwapSeen?: boolean;
        __newBoardSwapStop?: boolean;
      };
      w.__newBoardSwapSeen = false;
      w.__newBoardSwapStop = false;
      // Sampled on every drawn frame until the swap is seen, or until the poll it serves below
      // ends and stops it (plan 84-18, D-12): the New's swap is a host round trip, so its cap is
      // that poll's, and this frame loop keeps no wall-clock cap of its own.
      const step = (): void => {
        const s = w.__fabrico.scene();
        if (s.tick < before && s.nodes.length === 0 && s.belts.length === 0) {
          w.__newBoardSwapSeen = true;
          return;
        }
        if (w.__newBoardSwapStop !== true) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, tickBefore);
  }
  await page.getByTitle('New board (Ctrl+N)').click();
  if (asks) {
    const discard = page.locator('.fab-dialog-panel').getByRole('button', { name: 'Discard' });
    await expect(
      discard,
      'the SAVE-05 New guard opened on a board with unsaved work (Discard proceeds with the wipe)',
    ).toBeVisible();
    await discard.click();
  }
  if (tickBefore > 0) {
    try {
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __newBoardSwapSeen?: boolean }).__newBoardSwapSeen === true), {
          message: `New swapped the board in (an empty scene whose tick restarted below ${tickBefore})`,
          timeout: 30_000,
        })
        .toBe(true);
    } finally {
      await page
        .evaluate(() => {
          (window as unknown as { __newBoardSwapStop?: boolean }).__newBoardSwapStop = true;
        })
        .catch(() => undefined);
    }
  }
  await pollScene(page, (s) => s.nodes.length === 0 && s.belts.length === 0, {
    message: 'New swapped in a genuinely empty grid (no machines, no belts)',
  }).toBe(true);
}

/**
 * Place a machine of `kindName` at world cell (cx, cy) via the shipped
 * arm-then-click model (30-05): CLICK the palette item to ARM (emits NOTHING),
 * CLICK the target canvas cell to PLACE exactly one Place command, then press
 * Escape to DISARM. The disarm is load-bearing: 30-03 leaves the tool armed
 * after a placement, so without it a following select-click would place a SECOND
 * machine instead of selecting. Emits real pointer events only (no mock).
 *
 * `kindName` is the palette button's STABLE accessible name suffix (SHELL-06 kept
 * `aria-label="Place ${label}"` while the hover title became volatile copy), e.g.
 * 'Factory', 'Source', 'Route', 'Router'. The match is EXACT (CHROME-09): `Place Route` is a
 * prefix of `Place Router`, and the old `'Endpoint'` names no row since the palette says Route.
 */
export async function armAndPlaceAt(
  page: Page,
  kindName: string,
  cx: number,
  cy: number,
): Promise<void> {
  // Exact, as `handPlaceAt` is: `Place Route` is a prefix of `Place Router` (CHROME-09).
  await page.getByRole('button', { name: `Place ${kindName}`, exact: true }).click();
  const drop = await screenCellCentre(page, cx, cy);
  await pointerTravel(page, drop.x, drop.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

/** Place a FACTORY at world cell (cx, cy) - the original, now a thin wrapper. */
export async function armAndPlaceFactoryAt(page: Page, cx: number, cy: number): Promise<void> {
  await armAndPlaceAt(page, 'Factory', cx, cy);
}

// ---------------------------------------------------------------------------
// The UI-only REBUILD gestures (EX-02 SC3, 55-05)
// ---------------------------------------------------------------------------
//
// Everything below drives the shipped chrome the way a human does - palette
// clicks, canvas pointer drags, panel bodies, Apply - and NOTHING below reaches
// the command layer directly. That is the whole point of the milestone done-test
// the 17-order-example spec automates: a scene the UI cannot produce would make
// the done-test unwinnable, so the rebuild is only evidence while every step
// here stays a gesture.

/** A node's footprint ANCHOR (min-x / min-y) - the cell the host seats it at, and
 *  the handle-free identity a keyframe cannot renumber (occupancy is exclusive,
 *  so no two live machines can share one). */
export function anchorOf(node: SceneFacts['nodes'][number]): [number, number] {
  return [Math.min(...node.cells.map((c) => c[0])), Math.min(...node.cells.map((c) => c[1]))];
}

/** The machine seated at anchor (cx, cy), or undefined. */
export function nodeAtAnchor(
  scene: SceneFacts,
  cx: number,
  cy: number,
): SceneFacts['nodes'][number] | undefined {
  return scene.nodes.find((n) => {
    const [ax, ay] = anchorOf(n);
    return ax === cx && ay === cy;
  });
}

/** The heading text a mounted ConfigPanel shows for each configurable kind. */
const CONFIG_HEADINGS = ['Source', 'Sink', 'Factory'] as const;

/**
 * The ConfigPanel heading each kind shows, transcribed from `shared/kindNames.ts`
 * `KIND_NAMES` (the one table the panel heading reads), not imported: this file's one
 * app import is `shared/geometry`.
 */
const PANEL_HEADING_OF_KIND: Readonly<Record<number, string>> = {
  0: 'Source',
  7: 'Sink',
  2: 'Factory',
  3: 'Tee',
  4: 'Balancer',
  5: 'Router',
  6: 'Merge',
  1: 'Belt',
  9: 'Route',
  10: 'HTTP Handler',
  11: 'Label',
};

/**
 * Select the machine anchored at (cx, cy) with a real pointer click and wait for
 * ITS OWN ConfigPanel to finish its `machine_config` round-trip. The load wait is the
 * disappearance of the shipped "Loading config…" placeholder, so every caller
 * reads a POPULATED body rather than racing the bridge (the probe that skipped
 * this read a null Target group off a still-loading panel).
 *
 * KEYED ON THE CLICKED NODE (plan 84-13, D-12). It returns only when the app's live
 * selection (`window.__fabrico.selectedNode()`) is the clicked node's id AND the panel
 * heading names that node's kind. Before, it accepted any visible `#fab-config-heading`,
 * which the PREVIOUS selection's still-open panel satisfies before the click is applied:
 * The midday 2026-10-13 CI run (a page drawing 5 frames a second) failed `76-label-handle-reuse`
 * leg 2 on `PRECONDITION: the Delete key left the label alone`, the Delete going to the
 * label whose panel was still open (and covered the Source, so the click selected nothing).
 * It also waits, before clicking, until the board itself is what the click would reach. A
 * click that selects nothing, or selects another node, is a named red naming the anchor and
 * the id.
 */
export async function selectMachineAt(
  page: Page,
  cx: number,
  cy: number,
): Promise<SceneFacts['nodes'][number]> {
  const node = nodeAtAnchor(await readScene(page), cx, cy);
  expect(node, `a machine is seated at anchor (${cx},${cy}) to select`).toBeDefined();
  const want = PANEL_HEADING_OF_KIND[node!.kind];
  expect(want, `the oracle knows the panel heading of kind ${node!.kind}`).toBeDefined();
  const pt = await screenCellCentre(page, cx, cy);
  // THE CLICK LANDS ON THE BOARD (plan 84-13). The previous selection's panel is a right-docked
  // overlay; while it is still open (its deselect not yet applied on a slow page) it can cover
  // the machine's cell, and a click there goes to the panel and selects nothing. That is the
  // midday 2026-10-13 CI run's race measured in its forced form: the Source's click hit the label's open
  // panel, so the Delete after it removed the label. A hand clicks the machine it can see, so
  // the oracle waits until the canvas is what the click would reach.
  await expect
    .poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [pt.x, pt.y] as const), {
      message: `the machine at anchor (${cx},${cy}) is on the open board, not under a panel, before it is clicked`,
      timeout: 10_000,
    })
    .toBe('CANVAS');
  await clickAt(page, pt.x, pt.y);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hook = (window as { __fabrico?: { selectedNode?(): number | null } }).__fabrico;
          const selected = hook?.selectedNode?.() ?? null;
          const h = document.getElementById('fab-config-heading');
          // The heading's own text node (the kind name), without the not-applied marker after it.
          const heading = h === null ? '(no panel)' : (h.firstChild?.textContent ?? '').trim();
          return `selected=${selected === null ? 'none' : selected} heading=${heading}`;
        }),
      {
        message: `the click on the machine at anchor (${cx},${cy}) selected node ${node!.id} and opened its own ${want} panel`,
        timeout: 10_000,
      },
    )
    .toBe(`selected=${node!.id} heading=${want}`);
  await expect(
    page.locator('#fab-config-heading'),
    `the ConfigPanel mounted on the machine at (${cx},${cy})`,
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByPlaceholder('Loading config…'),
    'the machine_config round-trip resolved (the loading placeholder is gone)',
  ).toHaveCount(0, { timeout: 10_000 });
  return node as SceneFacts['nodes'][number];
}

/**
 * Deselect by clicking an EMPTY canvas cell - not by pressing Escape. Escape is
 * stood down by the app-wide LW-02 guard while a panel BUTTON holds focus (which
 * is exactly the state every panel edit leaves behind), and the panel is a
 * right-edge overlay that would otherwise intercept the next machine click. One
 * empty-cell click blurs the control AND clears the selection, which is also what
 * a human does. `cx, cy` must be a cell no machine occupies on either board.
 */
export async function deselectViaEmptyCell(page: Page, cx: number, cy: number): Promise<void> {
  const pt = await screenCellCentre(page, cx, cy);
  await clickAt(page, pt.x, pt.y);
  await expect(
    page.locator('#fab-config-heading'),
    'the ConfigPanel unmounted on the empty-cell deselect',
  ).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Grow the selected FACTORY a second output through the panel's Ports section -
 * the shipped `+ Add output` path (PANEL-03), which is the only UI route to the
 * scene's `AddPort`. Settles on the real host echoing the grown port list.
 */
export async function addOutputViaPanel(page: Page, expectedOuts: number): Promise<void> {
  await page
    .getByRole('region', { name: 'Ports' })
    .getByRole('button', { name: '+ Add output' })
    .click();
  await pollScene(
    page,
    (s) => {
      const node = s.nodes.find((n) => n.ports.filter((p) => p.role === 1).length === expectedOuts);
      return node !== undefined;
    },
    { message: `the real host folded the AddPort (a machine now has ${expectedOuts} Out ports)` },
  ).toBe(true);
}

/**
 * The outward unit step off a port side: N=(0,-1), E=(1,0), S=(0,1), W=(-1,0).
 * MIRRORED from `frontend/src/protocol/ports.ts`'s `unitDelta`, which mirrors
 * `unit_delta` in `crates/fabrico-core/src/state.rs`. Local rather than imported
 * for the same reason `17-order-example.live.spec.ts` keeps its own copy: the live
 * specs read the app through the page, never through its modules. Exported (phase 75)
 * so a live spec grading a cable's prongs uses this one table, not a copy of it.
 */
export function outwardStep(side: number): [number, number] {
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

/**
 * A cable is PLUGGED IN HEAD-ON at both prongs (phase 75, CABLE-01/02, done-test leg 5):
 * its first step equals the source port's outward step and its last step equals the
 * negated outward step of the target port, i.e. it leaves along the way the source faces
 * and moves INTO the target against the way that port faces.
 *
 * The two sides are read off the scene's OWN node ports, found by the wire's `(node,
 * port)` endpoints, never written into the spec: a side a spec states is a side the spec
 * can get wrong in the same direction as the build. Exported so every live spec grades
 * the same thing the same way (`outwardStep` is exported for the same reason).
 */
export function expectHeadOn(scene: SceneFacts, wire: WireFacts, label: string): void {
  const portOf = (end: { node: number; port: number }, which: string): PortFacts => {
    const node = scene.nodes.find((n) => n.id === end.node);
    expect(node, `${label}: the ${which} machine (node ${end.node}) is on the board`).toBeDefined();
    const port = node!.ports.find((p) => p.index === end.port);
    expect(port, `${label}: the ${which} machine carries port ${end.port}`).toBeDefined();
    return port as PortFacts;
  };
  const from = portOf(wire.from, 'source');
  const to = portOf(wire.to, 'target');
  const cells = wire.path.map((c) => [c.cell_x, c.cell_y] as [number, number]);
  expect(
    cells.length,
    `${label}: a cable needs at least two cells to have a first and a last step; path ${JSON.stringify(cells)}`,
  ).toBeGreaterThanOrEqual(2);
  const n = cells.length;
  const first: [number, number] = [cells[1][0] - cells[0][0], cells[1][1] - cells[0][1]];
  const last: [number, number] = [cells[n - 1][0] - cells[n - 2][0], cells[n - 1][1] - cells[n - 2][1]];
  const out = outwardStep(from.side);
  const [ix, iy] = outwardStep(to.side);
  // `0 - x`, not `-x`: unary minus turns a 0 into -0, which `toEqual` tells apart from 0.
  const into: [number, number] = [0 - ix, 0 - iy];
  expect(
    first,
    `${label}: the first step leaves the source port (side ${from.side}) along ${JSON.stringify(out)}; ` +
      `observed ${JSON.stringify(first)} on path ${JSON.stringify(cells)}`,
  ).toEqual(out);
  expect(
    last,
    `${label}: the last step enters the target port (side ${to.side}) along ${JSON.stringify(into)}; ` +
      `observed ${JSON.stringify(last)} on path ${JSON.stringify(cells)}`,
  ).toEqual(into);
}

/**
 * Draw ONE belt along an EXACT authored cell path, source doorstep to port nub.
 *
 * The gesture is the shipped port-to-port draw (D-12/CTRL-02): the press on the
 * source Out's doorstep seeds the path at that port's FACING cell and records the TAIL
 * dock; each move steps the pointer into the next authored cell centre; the
 * release on the destination In nub records the HEAD dock (`gestures.ts` release
 * arm, the `endDock` assignments).
 * Both docks therefore come from the gesture itself - nothing is docked by hand.
 *
 * `cells` is the FULL authored run. Its first cell must be the source port's
 * facing cell, its DOORSTEP (the press seeds it, so the moves start at `cells[1]`),
 * and its last cell must be the destination port's facing cell, which is why the
 * release lands inside that same cell and appends nothing.
 *
 * THE PRESS LANDS ON THE DOORSTEP CENTRE, AND THE FIRST-CELL RULE IS A GATE (phase
 * 74.1, Pitfall 3). Since 74.1 the Belt-armed press target is the doorstep TILE,
 * resolved by cell (`gestures.ts` doorstepPressHit over `cam.screenToCell`). This
 * helper used to press the source nub anchor, which sits only 0.5 world px inside
 * the doorstep tile: at a camera scale under 1 a rounded screen coordinate could land
 * inside the machine, a red press with no dock. It now presses the screen centre of
 * `cells[0]` and asserts that cell IS the source port's doorstep, beside the last-cell
 * `expect` below, so a run authored to start anywhere else fails at author time
 * instead of drawing a plain, undocked belt.
 *
 * THE LAST-CELL RULE IS NOW A GATE, NOT A SENTENCE (plan 74-14). It was prose for
 * two milestones and `18-refusal.spec.ts`'s InvalidDock fixture violated it in
 * silence the whole time, authoring a run that stopped two cells short and getting
 * its refusal from an accumulator defect rather than from the host. The `expect`
 * below is what would have caught that at author time.
 *
 * Each move steps ONE orthogonally adjacent cell centre. Since 74-14 that is a
 * choice about being an EXACT fixture rather than a constraint the accumulator
 * imposes: the accumulator now walks the cells a multi-cell sample crossed, so a
 * longer step would land the same path. Stepping one cell keeps the authored run
 * and the driven run the same object, which is what lets a caller assert the
 * committed tiles exactly.
 */
export async function drawBeltThroughCells(
  page: Page,
  from: PortFacts,
  cells: readonly (readonly [number, number])[],
  to: PortFacts,
): Promise<void> {
  expect(from.role, 'a belt TAIL docks an Out port').toBe(1);
  await drawDockedRun(page, from, cells, to);
}

/**
 * `drawBeltThroughCells` for a run that starts at a FAULT port (plan 85-05, D-22): the
 * same press rule, the same authored-run contract and the same release on the
 * destination nub. A Fault port starts a docked draw exactly as an Out does
 * (`gestures.ts` `doorstepPressHit`, the ROLE term) when its medium is Mechanical; this
 * helper only drives the pointer, and the caller grades which ends docked.
 */
export async function drawFaultBeltThroughCells(
  page: Page,
  from: PortFacts,
  cells: readonly (readonly [number, number])[],
  to: PortFacts,
): Promise<void> {
  expect(from.role, 'a fault belt TAIL starts at a Fault port').toBe(2);
  await drawDockedRun(page, from, cells, to);
}

/** The shared body of the two docked-run helpers above: authored-run contract, press,
 *  walk, release on the destination nub anchor, disarm. */
async function drawDockedRun(
  page: Page,
  from: PortFacts,
  cells: readonly (readonly [number, number])[],
  to: PortFacts,
): Promise<void> {
  expect(to.role, 'a belt HEAD docks an In port').toBe(0);
  // THE CONTRACT ABOVE, ASSERTED (74-14). The release lands on the destination nub
  // anchor, which sits just outside the port cell and therefore inside the port's
  // FACING cell, so an authored run that ends anywhere else is not the run this
  // helper drives.
  const [tdx, tdy] = outwardStep(to.side);
  const last = cells[cells.length - 1];
  expect(
    [last[0], last[1]],
    'the authored run must END at the destination port\'s facing cell: the release lands ' +
      'inside that cell, so a run that stops short is not the run this helper drives',
  ).toEqual([to.cell_x + tdx, to.cell_y + tdy]);
  await pressDoorstepAndWalk(page, from, cells);
  const end = await screenPoint(page, nubAnchor(to.cell_x, to.cell_y, to.side));
  await pointerTravel(page, end.x, end.y);
  await page.mouse.up();
  // Disarm so the next click SELECTS a machine instead of starting another draw.
  // The pointer press above landed on the (non-focusable) canvas, so focus is on
  // <body> and the LW-02 button-focus guard does not stand Escape down.
  await page.keyboard.press('Escape');
}

/**
 * THE ONE PRESS RULE for every live helper that starts a belt at a port (74.1-11,
 * review WR-06): assert `cells[0]` is the source port's doorstep, arm the Belt tool,
 * press the screen centre of that cell, then step the pointer through `cells[1..]` one
 * cell centre at a time. The caller releases. `drawBeltThroughCells` and
 * `drawOffloadBelt` both press through here, so the two cannot disagree about where a
 * press lands (the T-63-14 class).
 */
async function pressDoorstepAndWalk(
  page: Page,
  from: PortFacts,
  cells: readonly (readonly [number, number])[],
): Promise<void> {
  const [fdx, fdy] = outwardStep(from.side);
  const first = cells[0];
  expect(
    [first[0], first[1]],
    'the authored run must START at the source port\'s doorstep: the press lands on that ' +
      'cell\'s centre, so a run that starts anywhere else is a plain draw with no Tail dock',
  ).toEqual([from.cell_x + fdx, from.cell_y + fdy]);
  // Prefix-matched, not exact: this Belt tool title is user-facing COPY that
  // doubles as a SELECTOR, so an exact match makes every copy edit a multi-spec
  // breakage (the 52-05 lesson).
  await page.getByTitle(/^Draw belts/).click();
  const start = await screenCellCentre(page, first[0], first[1]);
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  // The press seeds the path on the doorstep itself, so the moves start at cells[1].
  for (const [cx, cy] of cells.slice(1)) {
    const pt = await screenCellCentre(page, cx, cy);
    await pointerTravel(page, pt.x, pt.y);
  }
}

/**
 * Draw ONE belt from a source Out's doorstep along an authored path and release on
 * the last cell's centre, plain floor, leaving the HEAD undocked: the gesture records
 * a Tail dock only, so the commands are one DrawBelt plus one Tail Dock.
 *
 * THE DANGLING HEAD IS THE ORACLE for its callers. An item delivered into a Sink is
 * consumed, so belt occupancy there is a transient; an offload belt with no Head dock
 * has nowhere to deliver, so the item comes to REST on it and a routing or jam outcome
 * is readable from board state for as long as the assertion wants to look.
 *
 * WHY THERE IS EXACTLY ONE PRESS RULE (74.1-11, review WR-06). This helper used to be
 * two local copies, in `24-one-board-all-six.spec.ts` and `19-router-rules.spec.ts`,
 * and both had drifted back to pressing the source NUB ANCHOR, the hazard plan 74.1-04
 * fixed in `drawBeltThroughCells` (Pitfall 3): the anchor sits 0.5 world px inside the
 * doorstep tile, so at a camera scale under 1 a rounded screen point can land inside
 * the machine, a red press with no dock. Both specs passed only on whatever camera a
 * run landed on. Both copies are deleted; this helper presses through
 * `pressDoorstepAndWalk`, the same function `drawBeltThroughCells` presses through.
 */
export async function drawOffloadBelt(
  page: Page,
  from: PortFacts,
  cells: readonly (readonly [number, number])[],
): Promise<void> {
  expect(from.role, 'an offload belt TAIL docks an Out port').toBe(1);
  await pressDoorstepAndWalk(page, from, cells);
  // The pointer already rests on the last cell's centre: plain floor, no nub hit.
  await page.mouse.up();
  await page.keyboard.press('Escape');
}

/**
 * Draw ONE electrical wire, nub to nub, with the Wire tool (WIRE-02, plan 66-01).
 *
 * A near-clone of `drawBeltThroughCells` above, MINUS its per-cell move loop: a wire
 * drag is press, one move, release. The user chooses WHICH ports connect and the host
 * auto-routes the L between them, so there is no authored corridor to step through and
 * nothing for the pointer to accumulate. Both endpoints come from the gesture itself -
 * nothing is wired by hand.
 *
 * `from` must be an electrical `Role::Out` port that is not already the source of a wire
 * or a belt dock, and `to` must be an electrical `Role::In` port. The host decides
 * legality (`command.rs` DrawWire arm); this helper only drives the pointer.
 *
 * WHAT THIS HELPER CANNOT SEE. The live oracle reads only the MODEL, and for a wire it
 * emits `tiles: w.path.length` - a number, never the cells and never the vertices
 * (`sceneState.ts`). So a spec built on this helper proves the COMMAND path and, paired
 * with `expectRenderLoopAlive`, render HEALTH. It proves nothing whatever about the
 * drawn cable.
 */
export async function drawWireBetweenPorts(page: Page, from: PortFacts, to: PortFacts): Promise<void> {
  expect(from.role, 'a wire leaves an Out port').toBe(1);
  expect(to.role, 'a wire lands on an In port').toBe(0);
  // Prefix-matched, not exact: this Wire tool title is user-facing COPY that
  // doubles as a SELECTOR, so an exact match makes every copy edit a multi-spec
  // breakage (the 52-05 lesson).
  await page.getByTitle(/^Draw wires/).click();
  const start = await screenPoint(page, nubAnchor(from.cell_x, from.cell_y, from.side));
  await pointerTravel(page, start.x, start.y);
  await page.mouse.down();
  const end = await screenPoint(page, nubAnchor(to.cell_x, to.cell_y, to.side));
  await pointerTravel(page, end.x, end.y);
  await page.mouse.up();
  // Disarm so the next click SELECTS a machine instead of starting another draw:
  // the Wire tool stays armed after a wire lands, exactly as the Belt tool does.
  await page.keyboard.press('Escape');
}

/** The largest per-axis pointer step `handDrawWire` takes, in screen px. */
const HAND_STEP_PX = 6;
/** The largest per-axis step on the diagonal stretch, so its length stays under 6 px. */
const HAND_DIAGONAL_STEP_PX = 4;
/** The pause between two pointer moves, so the app sees separate frames of motion. */
const HAND_PAUSE_MS = 8;
/**
 * The frames one hand move costs, measured at the GPU proxy (plan 84-13, D-12): each
 * `mouse.move` is acknowledged only once the page has handled it, which a slow page does about
 * once a frame. Measured at the proxy (4.8 frames a second), `76-same-cell-double-drop` leg 5's
 * three placements took 282, 285 and 267 ms a move (71, 98 and 98 moves), 1.43 frames at the
 * first 5 fps floor's 200 ms, rounded up to 2; at `FLOOR_FPS` 3.5 (286 ms a frame, review 84
 * WR-02) that is 1.0 frame, and 2 is kept so the travel keeps its margin. The midday 2026-10-13 CI run took the phase-76 hand legs
 * past their 90 s limit (about 100 moves a placement, up to five placements a leg). Every
 * hand helper budgets its own travel from this, through `addFrameBudget`, before it moves;
 * the 6 px and 4 px steps and the off-centre landings are unchanged.
 */
export const HAND_MOVE_FRAMES = 2;

/**
 * The frames one screen capture costs, measured at the GPU proxy (plan 84-18 Task 1, D-12). Plan
 * 84-13's inventory counted a capture as one frame. At the proxy a Playwright clip capture took
 * 4761 ms at the median and 6061 ms at the most (78 captures); a DevTools
 * `Page.captureScreenshot` took 15 ms at the median and 4705 ms at the most (279 captures, each
 * timed from the later of its request and the previous reply, since requests in flight are
 * answered one after another). Unthrottled: 41 and 40 ms at the median, 51 ms at the most. The
 * slowest capture of either kind at the proxy, 6061 ms, at THE PAIR's measured 4.53 frames a
 * second is 27.5 frames, so 28 (`84-EVIDENCE.md`, `### Plan 84-18: the three proxy reds
 * measured, named and derived (Task 1)`). Every wall-clock cap around a capture is derived from
 * it through `frameBudgetMs`, never picked.
 */
export const CAPTURE_FRAMES = 28;

/**
 * The frames an awaited drawn state needs before a read can see it (plan 84-18): it shows on the
 * frame after the page holds it, and a read may land one frame early (84-13's "1 to 2").
 */
export const DRAWN_STATE_FRAMES = 2;

/**
 * The tries a poll of captures is budgeted for (plan 84-18): one try's capture may hold a frame
 * drawn before the awaited state, and the next try's holds one drawn after it.
 */
export const CAPTURE_POLL_TRIES = 2;

/**
 * The sim ticks a host command takes to fold into the page (plan 84-18): a click, key, drag,
 * Apply or placement sent after the last model wait. Plan 84-17 measured `ticksToFold` 1 to 4
 * over 26 runs (`b8417/resume-measure.txt`), so 4.
 */
export const HOST_APPLY_TICKS = 4;

/**
 * The sim ticks one value of `frame()` spans: `SIM_TICKS_PER_FRAME` in `src/render/interp.ts`
 * (`quantizedFrame` is `floor(clock / 6) % 24`), transcribed, not imported (this file's one app
 * import is `shared/geometry`).
 */
export const RENDER_FRAME_TICKS = 6;

/** The advances of `frame()` `expectRenderLoopAlive` waits for: three distinct values are the
 *  first plus two. */
export const RENDER_LOOP_ADVANCES = 2;

/** Each running test's capture times in ms, keyed by its test id (`CAPTURE_COST`). */
const captureTally = new Map<string, number[]>();

/**
 * Tally one capture's own milliseconds against the running test. A capture that comes back after
 * its test ended has no test to tally against and is not counted.
 */
export function noteCaptureMs(ms: number): void {
  let id: string;
  try {
    id = test.info().testId;
  } catch {
    return;
  }
  const xs = captureTally.get(id) ?? [];
  xs.push(ms);
  captureTally.set(id, xs);
}

/**
 * The running test's captures as one line: `CAPTURE_COST n=<n> msMedian=<n> msMax=<n>
 * budgetMs=<frameBudgetMs(CAPTURE_FRAMES)>`, so a run shows each capture's cost beside the budget
 * one capture is given.
 */
export function captureCostLine(): string {
  const xs = [...(captureTally.get(test.info().testId) ?? [])].sort((a, b) => a - b);
  const mid = xs.length === 0 ? 0 : xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
  const max = xs.length === 0 ? 0 : xs[xs.length - 1];
  return `CAPTURE_COST n=${xs.length} msMedian=${Math.round(mid)} msMax=${Math.round(max)} budgetMs=${frameBudgetMs(CAPTURE_FRAMES)}`;
}

/**
 * Take one Playwright clip capture of the page, budgeted (plan 84-18, D-12): the running test's
 * limit is first raised by `CAPTURE_FRAMES` at the floor (`addFrameBudget`), then the capture is
 * taken and its milliseconds tallied (`noteCaptureMs`). Every clip capture in the live suite goes
 * through here, so no capture runs on a limit that never counted it.
 */
export async function captureClip(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  path?: string,
): Promise<Buffer> {
  addFrameBudget(CAPTURE_FRAMES, 'one clip capture');
  const t0 = Date.now();
  const buf = await page.screenshot(path === undefined ? { clip } : { clip, path });
  noteCaptureMs(Date.now() - t0);
  return buf;
}

/**
 * Move the pointer to (x, y) in `steps` samples, budgeted (plan 84-18, D-12): the running test's
 * limit is first raised by `steps` times `HAND_MOVE_FRAMES` at the floor, since each sample is
 * acknowledged only once the page has handled it, about once a frame on a slow page.
 */
export async function pointerTravel(page: Page, x: number, y: number, steps = 1): Promise<void> {
  addFrameBudget(steps * HAND_MOVE_FRAMES, `pointerTravel ${steps} steps`);
  await page.mouse.move(x, y, { steps });
}

/**
 * The points a hand travels through from `start` to `end`, in order, ending ON `end`: the
 * three stretches every hand helper walks (x only to half way; both axes at once in steps of
 * `HAND_DIAGONAL_STEP_PX`; then whatever remains one axis at a time in steps of
 * `HAND_STEP_PX`), then the final move onto `end`. Computed before travelling so a helper
 * can budget its moves (plan 84-13); the helpers walk exactly these points.
 */
export function handPath(start: { x: number; y: number }, end: { x: number; y: number }): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = start.x;
  let y = start.y;
  const toward = (v: number, goal: number, max: number): number =>
    goal > v ? Math.min(goal, v + max) : Math.max(goal, v - max);
  const push = (nx: number, ny: number): void => {
    x = nx;
    y = ny;
    out.push({ x, y });
  };
  // Stretch 1: half the horizontal distance, x only.
  const xMid = start.x + (end.x - start.x) / 2;
  while (Math.abs(xMid - x) > 0.5) push(toward(x, xMid, HAND_STEP_PX), y);
  // Stretch 2: both axes at once, until one of them reaches the end point.
  while (Math.abs(end.x - x) > 0.5 && Math.abs(end.y - y) > 0.5) {
    push(toward(x, end.x, HAND_DIAGONAL_STEP_PX), toward(y, end.y, HAND_DIAGONAL_STEP_PX));
  }
  // Stretch 3: whatever remains, one axis at a time.
  while (Math.abs(end.y - y) > 0.5) push(x, toward(y, end.y, HAND_STEP_PX));
  while (Math.abs(end.x - x) > 0.5) push(toward(x, end.x, HAND_STEP_PX), y);
  push(end.x, end.y);
  return out;
}

/**
 * Draw ONE electrical wire the way a HAND does (phase 75, CABLE-06): arm the Wire tool,
 * press a few screen px OFF the source nub's anchor, move in small steps (at most 6
 * screen px per axis, one stretch moving on both axes at once), release a few px off the
 * target nub's anchor, then Escape.
 *
 * WHY THIS IS NOT `drawWireBetweenPorts`. That helper presses exactly on the anchor and
 * reaches the target in ONE move. Fixtures that teleport one clean step hid four shipped
 * gesture defects in phase 74 (memory "fixtures move one clean cell"): a real pointer
 * never lands on the exact anchor and never jumps, so a gesture that only works for the
 * teleport is a gesture the user cannot perform. `drawWireBetweenPorts` is left as it is
 * for the specs that use it.
 *
 * The off-centre offsets are (+3, -2) px at the press and (-2, +3) px at the release,
 * well inside a nub's hit radius at camera scale 1; the host still decides legality.
 *
 * `whileHeld` (plan 75-05), when given, runs after the pointer has arrived over the target
 * and BEFORE the button is released, so a spec can read the drag preview while it is on
 * screen. It is awaited; the release follows it.
 */
export async function handDrawWire(
  page: Page,
  from: PortFacts,
  to: PortFacts,
  whileHeld?: () => Promise<void>,
): Promise<void> {
  expect(from.role, 'a wire leaves an Out port').toBe(1);
  expect(to.role, 'a wire lands on an In port').toBe(0);
  // Prefix-matched, as in `drawWireBetweenPorts`: the title is copy that doubles as a
  // selector (the 52-05 lesson).
  await page.getByTitle(/^Draw wires/).click();
  const a = await screenPoint(page, nubAnchor(from.cell_x, from.cell_y, from.side));
  const b = await screenPoint(page, nubAnchor(to.cell_x, to.cell_y, to.side));
  const start = { x: a.x + 3, y: a.y - 2 };
  const end = { x: b.x - 2, y: b.y + 3 };
  // The three stretches (x only, a diagonal, the rest one axis at a time), budgeted first.
  const path = handPath(start, end);
  const moves = path.length + 1;
  addFrameBudget(moves * HAND_MOVE_FRAMES, `handDrawWire ${moves} moves`);
  const t0 = Date.now();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const p of path) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HAND_PAUSE_MS);
  }
  console.log(`HAND_TRAVEL handDrawWire moves=${moves} ms=${Date.now() - t0}`);
  if (whileHeld) await whileHeld();
  await page.mouse.up();
  // Disarm so the next click selects instead of starting another draw.
  await page.keyboard.press('Escape');
}

/**
 * Press at screen point `start`, drag the way a HAND does to screen point `end` and
 * release (phase 76, plan 76-04, SHAPE-14), with whatever tool the caller armed. The same
 * three stretches as `handDrawWire` (x only, then a diagonal, then the rest one axis at a
 * time) in moves of at most `HAND_STEP_PX`, but from ANY point rather than from a nub,
 * because the gesture it serves starts where no nub is: on a label's body.
 *
 * `eachMove` runs after the press and after EVERY move while the button is held, so a
 * caller can assert something stayed true for the whole hold rather than at one instant
 * (a preview that flashed for one frame and went away is still a preview).
 *
 * It does not arm a tool and does not press Escape: the caller arms the tool by its title
 * and decides what follows the release.
 */
export async function handDragBetween(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
  eachMove?: (step: number) => Promise<void>,
): Promise<number> {
  let step = 0;
  // The three stretches (x only, a diagonal, the rest one axis at a time), budgeted first.
  const path = handPath(start, end);
  const moves = path.length + 1;
  addFrameBudget(moves * HAND_MOVE_FRAMES, `handDragBetween ${moves} moves`);
  const t0 = Date.now();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.waitForTimeout(HAND_PAUSE_MS);
  if (eachMove) await eachMove(0);
  for (const p of path) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HAND_PAUSE_MS);
    step += 1;
    if (eachMove) await eachMove(step);
  }
  console.log(`HAND_TRAVEL handDragBetween moves=${moves} ms=${Date.now() - t0}`);
  await page.mouse.up();
  return step;
}

/** One pointer event as the page saw it (`watchPointerEvents`, phase 89, plan 89-07). */
export interface SeenPointerEvent {
  /** A number that rises by one per recorded event since the page loaded; slice by it, not by index (the list is trimmed). */
  seq: number;
  type: string;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  trusted: boolean;
}

/**
 * Record every pointer event the page dispatches, in order, on `window.__p89Pointers` (phase 89,
 * plan 89-07, BELT-08), each with a rising `seq` (review IN-C-04: past 4000 entries the oldest
 * 1000 are trimmed, so a caller slices by `seq`, never by index): a capture-phase listener on the window for `pointerdown`, `pointermove`,
 * `pointerup`, `pointercancel` and `lostpointercapture`, so a spec can read the id the browser
 * gave the mouse, and whether a press of a second button during a drag arrived as a chorded move
 * or as a down (research A5). Installed once per page load; a reload clears it.
 */
export async function watchPointerEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __p89Pointers?: SeenPointerEvent[] };
    if (w.__p89Pointers) return;
    const seen: SeenPointerEvent[] = [];
    w.__p89Pointers = seen;
    let seq = 0;
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      window.addEventListener(
        type,
        (ev) => {
          const e = ev as PointerEvent;
          seq += 1;
          seen.push({
            seq,
            type,
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            button: e.button,
            buttons: e.buttons,
            trusted: e.isTrusted,
          });
          if (seen.length > 4000) seen.splice(0, 1000);
        },
        true,
      );
    }
  });
}

/** The pointer events `watchPointerEvents` has recorded since the page loaded, oldest first. */
export async function seenPointerEvents(page: Page): Promise<SeenPointerEvent[]> {
  return page.evaluate(() => [...((window as unknown as { __p89Pointers?: SeenPointerEvent[] }).__p89Pointers ?? [])]);
}

/**
 * Dispatch ONE synthetic pointer event on the board canvas or on the window (phase 89, plan
 * 89-07, BELT-08), the way a webview that lost a release or an OS gesture that took the pointer
 * delivers it: a `pointercancel`, or a `pointermove` of the owning pointer whose `buttons` no
 * longer carries the left bit. `pointerId` and `pointerType` name the pointer; `buttons` is the
 * mask the event carries; (x, y) is the client point. Budgeted as one hand move: the page handles
 * it on its next task, about a frame on a slow page.
 */
export async function dispatchPointer(
  page: Page,
  ev: {
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';
    on: 'canvas' | 'window';
    pointerId: number;
    pointerType: 'mouse' | 'pen' | 'touch';
    buttons: number;
    button?: number;
    x: number;
    y: number;
  },
): Promise<void> {
  addFrameBudget(HAND_MOVE_FRAMES, `dispatchPointer ${ev.type}`);
  await page.evaluate((e) => {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('dispatchPointer: no canvas');
    const pe = new PointerEvent(e.type, {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      isPrimary: true,
      button: e.button ?? -1,
      buttons: e.buttons,
      clientX: e.x,
      clientY: e.y,
      bubbles: true,
      cancelable: e.type !== 'pointercancel',
      composed: true,
    });
    (e.on === 'canvas' ? canvas : window).dispatchEvent(pe);
  }, ev);
}

/** One step of a touch sequence for {@link touchSequence}. */
export type TouchStep =
  | { type: 'start'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'end' };

/**
 * Drive ONE touch point through the browser's own input pipeline (phase 89, plan 89-07,
 * BELT-08): a CDP session's `Input.dispatchTouchEvent` for each step, `touchStart`, `touchMove`
 * and `touchEnd`, so the page receives TRUSTED touch pointer events with their own pointer id, as
 * a second finger does. `between(i)`, when given, runs after step `i`, so a spec can move the
 * mouse while the finger is down. Budgeted as one hand move per step; the session is detached
 * afterwards.
 */
export async function touchSequence(
  page: Page,
  steps: readonly TouchStep[],
  between?: (i: number) => Promise<void>,
  touchId = 7,
): Promise<void> {
  addFrameBudget((steps.length + 1) * HAND_MOVE_FRAMES, `touchSequence ${steps.length} steps`);
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      if (s.type === 'end') {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await cdp.send('Input.dispatchTouchEvent', {
          type: s.type === 'start' ? 'touchStart' : 'touchMove',
          touchPoints: [{ x: s.x, y: s.y, id: touchId }],
        });
      }
      if (between) await between(i);
    }
  } finally {
    await cdp.detach();
  }
}

/**
 * Place ONE machine (or label) the way a HAND does (phase 76, SHAPE-10): click the palette
 * row `Place <kindName>` by its accessible name, travel from the palette edge to a point a
 * few screen px OFF the centre of cell (cx, cy) in moves of at most `HAND_STEP_PX`, with
 * one stretch moving on BOTH axes, then press and release.
 *
 * WHY IT IS NOT `armAndPlaceAt`. That helper moves the pointer straight to the cell
 * CENTRE in one teleport and presses there, which is the fixture shape no hand produces
 * (memory fabrico-fixtures-move-one-clean-cell): a defect that lives in the ghost's
 * cell rounding or in a hover that never saw the pointer arrive is invisible to it. This
 * one arrives through the canvas the way a mouse does and lands off-centre at
 * (+5, -4) screen px.
 *
 * IT DOES NOT PRESS ESCAPE. A Label tool lets go by itself after one placement
 * (UI-SPEC U-4), and the leg that proves so must see the tool's own state; a caller
 * placing a machine (whose tool stays armed) presses Escape itself.
 */
export async function handPlaceAt(
  page: Page,
  kindName: string,
  cx: number,
  cy: number,
): Promise<void> {
  const row = page.getByRole('button', { name: `Place ${kindName}`, exact: true });
  await row.click();
  const box = await row.boundingBox();
  expect(box, `the "Place ${kindName}" palette row has a box`).not.toBeNull();
  const centre = await screenCellCentre(page, cx, cy);
  const end = { x: centre.x + 5, y: centre.y - 4 };
  // Start just past the palette row's right edge, level with its middle.
  const start = { x: box!.x + box!.width + 4, y: box!.y + box!.height / 2 };
  // The three stretches (x only, a diagonal, the rest one axis at a time), budgeted first.
  const path = [start, ...handPath(start, end)];
  const moves = path.length;
  addFrameBudget(moves * HAND_MOVE_FRAMES, `handPlaceAt ${kindName} ${moves} moves`);
  const t0 = Date.now();
  for (const p of path) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HAND_PAUSE_MS);
  }
  console.log(`HAND_TRAVEL handPlaceAt moves=${moves} ms=${Date.now() - t0}`);
  await page.mouse.down();
  await page.mouse.up();
}

/** What the label-box Graphics of one label PLOTTED, read back off its own instructions. */
export interface LabelBoxFacts {
  /** How many fill and stroke instructions the Graphics holds. */
  instructions: number;
  fill: { color: number; alpha: number } | null;
  stroke: { color: number; alpha: number; width: number } | null;
  /** The plotted rectangle in WORLD px (zoom-1 canvas units). */
  rect: { x: number; y: number; w: number; h: number } | null;
}

/**
 * The paint probe for one label's box (phase 76, SHAPE-10). Reads
 * `window.__fabrico.labelBoxOn(id)`, which reads the `label-box` Graphics' own
 * `context.instructions` (the fill and stroke styles and the rectangle primitive they
 * drew), never the values handed to the draw call: the live oracle is otherwise
 * model-only, and a model read cannot tell a drawn box from a missing one (memory
 * fabrico-model-oracle-blindspot). `null` when the layer holds no box for `id`.
 */
export async function labelBoxOn(page: Page, id: number): Promise<LabelBoxFacts | null> {
  return page.evaluate((nodeId) => {
    const hook = (window as { __fabrico?: { labelBoxOn?(id: number): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.labelBoxOn !== 'function') {
      throw new Error('window.__fabrico.labelBoxOn() not installed');
    }
    return hook.labelBoxOn(nodeId) as LabelBoxFacts | null;
  }, id);
}

/** The machine layer's census (plan 76-08), read off the Pixi display list. */
export interface DrawnNodesFacts {
  /** Handles whose machine root is a child of the layer, ascending. */
  machines: number[];
  /** Handles whose `label-box` Graphics is a child of the layer, ascending. */
  labels: number[];
  /** Layer children neither list accounts for. */
  strays: number;
}

/**
 * The census of what the machine layer DRAWS (plan 76-08, verification truth 7, review
 * CR-01). Reads `window.__fabrico.drawnNodes()`, which walks the layer's display list, not
 * the scene. THE BLIND SPOT IT CLOSES: a keyframe restarts render handles at 0, so a
 * handle that named a label can name a machine after it, and the layer kept the old
 * label's box drawn on it. The model was right, so every `readScene` check passed over a
 * ghost on the canvas (memory fabrico-model-oracle-blindspot). A spec that requires this
 * census to equal the scene's nodes can fail on that ghost.
 */
export async function drawnNodesOf(page: Page): Promise<DrawnNodesFacts> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { drawnNodes?(): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.drawnNodes !== 'function') {
      throw new Error('window.__fabrico.drawnNodes() not installed');
    }
    return hook.drawnNodes() as DrawnNodesFacts;
  });
}

/**
 * WHICH ART the machine root on `id` is drawing (plan 76-08): the art subject whose shared
 * asset context the root's glyph Graphics holds RIGHT NOW (`'source'`, `'sink'`, ...), or
 * `null` when there is no root, no glyph, or the body is hidden below the LOD cut. Reads
 * `window.__fabrico.glyphSubjectOn(id)`. THE BLIND SPOT IT CLOSES: a root kept on a
 * reminted handle that now names another machine kind can go on drawing the OLD kind's
 * glyph; the census reads that root as rightly present and the model names the new kind,
 * so only the drawn art itself can tell.
 */
export async function glyphSubjectOn(page: Page, id: number): Promise<string | null> {
  return page.evaluate((nodeId) => {
    const hook = (window as { __fabrico?: { glyphSubjectOn?(id: number): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.glyphSubjectOn !== 'function') {
      throw new Error('window.__fabrico.glyphSubjectOn() not installed');
    }
    return hook.glyphSubjectOn(nodeId) as string | null;
  }, id);
}

/** What {@link glyphBoxOn} reads back, all in px in the machine body's unrotated frame. */
export interface GlyphBoxFacts {
  /** The glyph Graphics' position. */
  x: number;
  y: number;
  /** The drawn art's author box times the glyph's current scale. */
  w: number;
  h: number;
  /** The machine's footprint, `w * CELL` by `h * CELL`, read off the body's pivot. */
  footW: number;
  footH: number;
}

/**
 * WHERE the glyph on machine `id` is DRAWN and how big, beside the machine's footprint (plan
 * 85-02, D-24), or `null` when there is no root, no glyph, or the body is hidden below the LOD
 * cut. Reads `window.__fabrico.glyphBoxOn(id)`, which reads the glyph Graphics' own position
 * and scale and the body's pivot. THE BLIND SPOT IT CLOSES: a glyph whose art is larger than
 * its machine draws over the neighbours while every model read is right, and a check that
 * recomputed the placement formula would agree with whatever formula shipped.
 */
export async function glyphBoxOn(page: Page, id: number): Promise<GlyphBoxFacts | null> {
  return page.evaluate((nodeId) => {
    const hook = (window as { __fabrico?: { glyphBoxOn?(id: number): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.glyphBoxOn !== 'function') {
      throw new Error('window.__fabrico.glyphBoxOn() not installed');
    }
    return hook.glyphBoxOn(nodeId) as GlyphBoxFacts | null;
  }, id);
}

/**
 * THE DRAWN ITEMS PER CELL (plan 77-02, phase 77 D-04): how many item dots the item layer
 * PLACED in each world cell, keyed `x,y`, read off `window.__fabrico.itemDots()` (the item
 * layer's own ParticleContainer children, never the scene model).
 *
 * THE BLIND SPOT IT CLOSES: every item claim in a live spec reads `occupiedSlots` off the
 * model, and an item layer drawing nothing, or stale positions, while the ticker runs
 * passes those reads and both render-health helpers. Compare this with the model's items
 * per cell, read in the same poll.
 *
 * Each dot goes to the cell containing it, `Math.floor(coord / CELL)`. A slot's dot sits
 * at `(m + 0.5) / slotsPerTile` of its tile's flow (`frontend/src/render/interp.ts`
 * `slotArcLength`), so no dot sits on a tile edge and the floor is never ambiguous. Two
 * distinct named throws, as elsewhere in this file, so a stale build reads differently
 * from a missing hook.
 */
export async function itemDotsPerCell(page: Page): Promise<Record<string, number>> {
  const dots = await page.evaluate(() => {
    const hook = (window as { __fabrico?: { itemDots?(): Array<{ x: number; y: number }> } })
      .__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.itemDots !== 'function') {
      throw new Error('window.__fabrico.itemDots() not installed');
    }
    return hook.itemDots();
  });
  const perCell: Record<string, number> = {};
  for (const d of dots) {
    const key = `${Math.floor(d.x / GEOMETRY_CELL)},${Math.floor(d.y / GEOMETRY_CELL)}`;
    perCell[key] = (perCell[key] ?? 0) + 1;
  }
  return perCell;
}

/** What the label's pending-size outline PLOTTED (phase 76, plan 76-03). */
export interface LabelResizeFacts {
  instructions: number;
  stroke: { color: number; alpha: number; width: number } | null;
  /** The plotted rectangle in WORLD px. */
  rect: { x: number; y: number; w: number; h: number } | null;
  filled: boolean;
}

/**
 * The paint probe for the label's pending-size outline (phase 76, plan 76-03, 76-UI-SPEC
 * 5.4). Reads `window.__fabrico.labelResizePreview()`, which reads the overlay's
 * `label-resize-preview` Graphics' own instructions: the stroke colour (`build` when the
 * pending size fits, `fault` when it would cover something), its alpha and width, and the
 * rectangle in world px. `null` when the outline holds nothing. Never the arguments the
 * draw call was handed, so an outline that plotted nothing reads as nothing.
 */
export async function labelResizePreviewOf(page: Page): Promise<LabelResizeFacts | null> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { labelResizePreview?(): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.labelResizePreview !== 'function') {
      throw new Error('window.__fabrico.labelResizePreview() not installed');
    }
    return hook.labelResizePreview() as LabelResizeFacts | null;
  });
}

/**
 * Read `window.__fabrico.beltPreviewPlotted()` (plan 88-07, BELT-06): the draw-belt drag
 * preview's first stroke colour as plotted and whether it is the build accent (`valid`), or
 * `null` when the drag preview holds nothing. Off the Graphics' own instructions, so a leg
 * grades the "no" the user was shown, never the prediction that chose it.
 */
export async function beltPreviewPlottedOf(page: Page): Promise<{ color: number; valid: boolean } | null> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { beltPreviewPlotted?(): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.beltPreviewPlotted !== 'function') {
      throw new Error('window.__fabrico.beltPreviewPlotted() not installed');
    }
    return hook.beltPreviewPlotted() as { color: number; valid: boolean } | null;
  });
}

/** What {@link ghostPlottedOf} answers: the placement ghost's body as plotted. */
export interface GhostPlottedFacts {
  /** The body rectangle in WORLD px. */
  rect: { x: number; y: number; w: number; h: number };
  color: number;
  /** The fill colour is the build accent. */
  valid: boolean;
}

/**
 * Read `window.__fabrico.ghostPlotted()` (plan 88-07, BELT-06): the placement ghost's body
 * rectangle, fill colour and whether that colour is the build accent, read back off the ghost
 * Graphics, or `null` when it holds nothing.
 */
export async function ghostPlottedOf(page: Page): Promise<GhostPlottedFacts | null> {
  return page.evaluate(() => {
    const hook = (window as { __fabrico?: { ghostPlotted?(): unknown } }).__fabrico;
    if (!hook) {
      throw new Error('window.__fabrico not installed');
    }
    if (typeof hook.ghostPlotted !== 'function') {
      throw new Error('window.__fabrico.ghostPlotted() not installed');
    }
    return hook.ghostPlotted() as GhostPlottedFacts | null;
  });
}

/** What the words overlay shows for one label, read off the DOM (phase 76, plan 76-02). */
export interface LabelWordsFacts {
  /** The element's `textContent`: the words as text, never parsed as markup. */
  text: string;
  /** Playwright's visibility: false for `visibility: hidden`, an empty box, or detached. */
  visible: boolean;
  /** The element's box in page px, or null when it has none. */
  rect: { x: number; y: number; width: number; height: number } | null;
}

/**
 * The words on the board for label `id`: the `[data-testid=label-words][data-node=id]`
 * element of the DOM overlay (`LabelWords.tsx`), or `null` when no such element exists
 * (the overlay draws none for an empty text).
 *
 * A DOM read, deliberately beside the model read: `readScene` reports what the HOST holds,
 * and a board that held the words but drew none would pass every model assertion (memory
 * fabrico-model-oracle-blindspot). `textContent`, never `innerHTML`, so markup typed by a
 * user reads back as the characters they typed.
 */
export async function labelWordsOf(page: Page, id: number): Promise<LabelWordsFacts | null> {
  const el = page.locator(`[data-testid="label-words"][data-node="${id}"]`);
  const n = await el.count();
  if (n === 0) return null;
  expect(n, `exactly one words element for label ${id}`).toBe(1);
  return {
    text: (await el.textContent()) ?? '',
    visible: await el.isVisible(),
    rect: await el.boundingBox(),
  };
}

// ---------------------------------------------------------------------------
// Panel-body config authoring + read-back (the machine_config bridge, via the UI)
// ---------------------------------------------------------------------------
//
// The ConfigPanel pre-fills from `machine_config` and commits through the
// certified `Configure` gesture on Apply, so reading a mounted panel IS reading
// the host's committed config - there is no separate read path to prefer, and
// adding a `window.__fabrico` config getter for the tests would be production
// code written for a test.

/** The exact editor buffer, line-joined. `.cm-line` is one LOGICAL line even
 *  under `EditorView.lineWrapping`, so the join reproduces the source verbatim -
 *  unlike `toHaveText`, which normalises whitespace and drops the newlines. */
export async function readFactorySource(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line'))
      // CodeMirror pads a visually-empty line with a zero-width space; strip it so
      // an empty authored line reads back as '' rather than '​'.
      .map((l) => (l.textContent ?? '').replace(/\u200b/g, ''))
      .join('\n'),
  );
}

/**
 * Replace the Factory editor's contents with `source`, verbatim.
 *
 * `keyboard.insertText` (a browser-level text insertion - the CDP path a paste or
 * an IME commit takes), NOT `keyboard.type`. `type` sends real Enter keystrokes,
 * and CodeMirror's `defaultKeymap` binds Enter to `insertNewlineAndIndent`: a
 * typed rebuild of the scene's handler comes out with doubled indents and a
 * trailing `  }` (measured), so it could never be byte-equal to the authored
 * source no matter how carefully a human typed it. A human pastes multi-line
 * code; this is the paste-shaped insertion.
 */
export async function typeFactorySource(page: Page, source: string): Promise<void> {
  const editor = page.locator('.cm-content');
  await expect(editor, 'the CodeMirror editor is mounted before authoring').toBeVisible({
    timeout: 10_000,
  });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(source);
  expect(await readFactorySource(page), 'the editor holds the authored source verbatim').toBe(
    source,
  );
}

/** Press one segment of a `role=group` segmented control (Trigger/Target/Method). */
export async function pressSegment(page: Page, group: string, label: string): Promise<void> {
  await page
    .locator(`[role="group"][aria-label="${group}"]`)
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** The label of the currently pressed segment of a `role=group` control. */
export async function pressedSegment(page: Page, group: string): Promise<string> {
  const pressed = page
    .locator(`[role="group"][aria-label="${group}"]`)
    .getByRole('button', { pressed: true });
  await expect(pressed, `exactly one ${group} segment is pressed`).toHaveCount(1);
  return (await pressed.textContent()) ?? '';
}

/**
 * The loopback shape a Route's copyable POST URL must take.
 *
 * THE `/endpoint/` SEGMENT IS A HOST ROUTE PREFIX AND IT STAYS (D-12a, design decision).
 * It is NOT the kind name D-09 renamed to `Route`, so a criterion claiming the old word
 * is gone from the app is FALSE on a correct build (72-UI-SPEC 8.5, R-10). The capture
 * groups are the bound listener PORT and the route LABEL, which is `route-<n>` for a Route
 * the user has not touched and the user's own path once they have.
 *
 * PROMOTED HERE FROM `21-endpoint-traffic.spec.ts` BY PLAN 72-13, so the two live specs
 * that read a Route's URL read ONE shape and ONE reader. A second copy is a second thing
 * to go stale, which is the reason this module exists at all.
 */
export const ENDPOINT_URL_SHAPE = /^http:\/\/127\.0\.0\.1:(\d+)\/endpoint\/(.+)$/;

/**
 * Read the `POST URL` value out of the MOUNTED config panel, verbatim.
 *
 * THE URL IS READ OFF THE PANEL, NEVER REBUILT FROM THE NODE ID. Reading it from the
 * shipped row is what makes a spec a test of the thing a user can actually do; a URL
 * rebuilt from the handle would prove only that the spec can do arithmetic. Pair it with
 * `webhookUrl(page, id)` and compare the two, exactly as `21-endpoint-traffic.spec.ts`
 * does: a panel showing a stale or fabricated URL passes every other assertion.
 *
 * PROMOTED HERE FROM `21-endpoint-traffic.spec.ts` BY PLAN 72-13 (see
 * `ENDPOINT_URL_SHAPE` above for why).
 */
export async function readPanelUrl(page: Page): Promise<string> {
  const urlValue = page.locator('span.fab-field', { hasText: 'http://127.0.0.1:' });
  await expect(urlValue, 'the POST URL row renders a loopback URL').toBeVisible({
    timeout: 10_000,
  });
  return ((await urlValue.textContent()) ?? '').trim();
}

/** Replace a panel `.fab-field` text input's value (id-addressed, the shipped ids). */
export async function fillPanelField(page: Page, id: string, value: string): Promise<void> {
  await page.locator(`#${id}`).fill(value);
}

/**
 * Commit the mounted panel's buffer through the shipped Apply button and settle
 * on the commit actually having HAPPENED: the not-applied marker
 * (`CONFIG_NOT_APPLIED_MARKER`, `src/chrome/configCopy.ts`) clears only once the
 * host confirms, so a Factory whose JS failed `validate_factory_js` (which leaves
 * the buffer dirty behind an error row) fails HERE rather than silently authoring
 * nothing and failing later at the config compare.
 *
 * THE MARKER IS SEEN BEFORE THE CLICK (phase 90, D-05, research Finding J). Its
 * absence after Apply means something only if it was there: an absence check on
 * words that never render passes whatever the panel does. So a caller types
 * before it applies; one that applies an unchanged buffer clicks Apply itself.
 * The words are imported, never spelled, so a rename moves this check with them.
 */
export async function applyConfig(page: Page): Promise<void> {
  const marker = page.getByText(CONFIG_NOT_APPLIED_MARKER);
  await expect(
    marker,
    'the panel holds typed config before Apply (the not-applied marker shows), so its clearing below can fail',
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(
    marker,
    'Apply committed the buffer (the not-applied marker cleared - a rejected Factory JS would keep it)',
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('alert'), 'Apply raised no error row').toHaveCount(0);
  // Phase 90 (D-03): the Apply's accept lights `Unsaved`; a caller that reads the badge or
  // swaps the board next reads it after the host has answered.
  await waitForEditVerdicts(page);
}

/** A machine's config as the mounted panel reports it (i.e. as `machine_config`
 *  answered, rendered through the shipped body). */
export type PanelConfigFacts =
  | { kind: 'Factory'; source: string }
  | { kind: 'Source'; trigger: string }
  | { kind: 'Sink'; target: 'Debug' }
  | { kind: 'Sink'; target: 'HTTP'; url: string; method: string };

/** Read the mounted ConfigPanel's committed config (call after selectMachineAt). */
export async function readPanelConfig(page: Page): Promise<PanelConfigFacts> {
  const heading = ((await page.locator('#fab-config-heading').textContent()) ?? '').trim();
  const kind = CONFIG_HEADINGS.find((k) => heading.startsWith(k));
  expect(kind, `the panel heading names a configurable kind (got ${JSON.stringify(heading)})`)
    .toBeDefined();
  if (kind === 'Factory') {
    return { kind: 'Factory', source: await readFactorySource(page) };
  }
  if (kind === 'Source') {
    return { kind: 'Source', trigger: await pressedSegment(page, 'Trigger') };
  }
  const target = await pressedSegment(page, 'Target');
  if (target === 'HTTP') {
    return {
      kind: 'Sink',
      target: 'HTTP',
      url: await page.locator('#fab-sink-http-url').inputValue(),
      method: await pressedSegment(page, 'Method'),
    };
  }
  return { kind: 'Sink', target: 'Debug' };
}

// ---------------------------------------------------------------------------
// The Router rules table (ROUTE-01 / ROUTE-03) - a DEDICATED reader
// ---------------------------------------------------------------------------
//
// WHY THIS IS A SEPARATE READER AND NOT A `readPanelConfig` ARM. Two reasons,
// both structural rather than stylistic, so this is a decision and not a
// duplication:
//
//  1. `readPanelConfig` resolves the panel kind against `CONFIG_HEADINGS`
//     (`Source` / `Sink` / `Factory`) and ASSERTS the match is defined. A Router
//     panel heading reads `Router`, so that reader does not merely return the
//     wrong shape on a Router - it FAILS. Adding a fourth heading would make it
//     return something, which leads straight to the second reason.
//  2. `PanelConfigFacts` is a FLAT union: one variant per kind, every field a
//     scalar. A routing table is an ORDERED LIST of records plus a separate
//     default. It cannot be expressed in that union without reshaping the union
//     itself, and every existing caller narrows on `kind` and reads scalars off
//     the result (`17-order-example.live.spec.ts` stores whole `PanelConfigFacts`
//     values in a record and compares them). Reshaping the union to admit a list
//     would touch each of those call sites for no gain to any of them.
//
// So `readPanelConfig` is left exactly as it was - same heading list, same union,
// same body - and the Router gets its own reader beside it. The two are selected
// by the caller, which already knows which machine it just clicked.

/** One rule as the mounted Router panel reports it. */
export interface RouterRuleFacts {
  /** The pressed `Send to` segment's label: the target output's WORLD CELL,
   *  e.g. `(15,0)`. The panel labels targets by cell and never by ordinal,
   *  because the two Routers in this app number their Outs in opposite visual
   *  directions - so a cell is the only handle that means the same thing on
   *  both. */
  target: string;
  /** The `Match text` field's value (the pattern bytes, decoded for display). */
  expect: string;
  /** The `At byte` field's value, verbatim as the input holds it. */
  offset: string;
}

/** A Router's whole committed table as the mounted panel reports it. */
export interface RouterTableFacts {
  /** The rules in PANEL ORDER, which is table order, which is match order. */
  rules: RouterRuleFacts[];
  /** The pressed `Default` segment's label: `None (fault)` or an output's cell. */
  fallback: string;
}

/** The per-rule target group's accessible name (`RouterConfigBody.TARGET_LABEL`
 *  plus the 1-based rule number, which is what makes it unique per rule). */
export function routerTargetGroup(ruleIndex: number): string {
  return `Send to, rule ${ruleIndex + 1}`;
}

/**
 * Read the mounted Router panel's rules table (call after `selectMachineAt` on a
 * Router). Every group lookup goes through `pressedSegment`, which asserts
 * EXACTLY ONE segment is pressed - so a group rendering with nothing pressed
 * fails loudly here rather than reading back as an empty string that a caller
 * would then compare against something and get a confusing diff for.
 */
export async function readRouterTable(page: Page): Promise<RouterTableFacts> {
  await expect(
    page.locator('#fab-router-config'),
    'the mounted panel is the Router rules editor',
  ).toHaveCount(1);
  // The rule count is the number of per-rule target groups. Counting THOSE (and
  // not `role="listitem"`) is deliberate: the empty-table state renders a single
  // listitem carrying the `No rules yet.` copy, so a listitem count reads 1 on a
  // table with zero rules.
  const groups = page.locator('[role="group"][aria-label^="Send to, rule "]');
  const count = await groups.count();
  const rules: RouterRuleFacts[] = [];
  for (let i = 0; i < count; i += 1) {
    rules.push({
      target: await pressedSegment(page, routerTargetGroup(i)),
      expect: await page.locator(`#fab-route-expect-${i}`).inputValue(),
      offset: await page.locator(`#fab-route-offset-${i}`).inputValue(),
    });
  }
  return { rules, fallback: await pressedSegment(page, 'Default') };
}

/**
 * Append ONE rule to the mounted Router panel and fill it: press `+ Add rule`,
 * then fill that rule's two fields by element id and press its target segment by
 * label.
 *
 * Deliberately thin - it composes `fillPanelField` and `pressSegment` rather than
 * reimplementing either, so the addressing rules those two encode (id-addressed
 * fields, `aria-label`-addressed groups) live in one place. It does NOT Apply:
 * the buffer is the parent's and a caller appending two rules wants ONE commit.
 */
export async function appendRouterRule(
  page: Page,
  rule: { expect: string; offset: number; target: string },
): Promise<void> {
  const groups = page.locator('[role="group"][aria-label^="Send to, rule "]');
  const before = await groups.count();
  await page.locator('#fab-route-add').click();
  // Settle on the append having RENDERED before addressing the new rule's ids.
  // The panel is a controlled React buffer, so the new field elements do not
  // exist until the re-render lands.
  await expect(groups, 'the append control added one rule row').toHaveCount(before + 1);
  await fillPanelField(page, `fab-route-expect-${before}`, rule.expect);
  await fillPanelField(page, `fab-route-offset-${before}`, String(rule.offset));
  await pressSegment(page, routerTargetGroup(before), rule.target);
}

// ---------------------------------------------------------------------------
// Belt-flow observation (the transient-item latch)
// ---------------------------------------------------------------------------
//
// THE ESTIMATE THIS PARAGRAPH CARRIED IS CORRECTED IN PLACE (Phase 62 / SLOT-03),
// exactly as Phase 60 corrected its predecessor, and it is a COMMENT-ONLY change:
// nothing below reads a tick figure, so no line of code moves with it.
//
// It read: *"An item crosses a 5-tile belt in 19 sim ticks (SLOTS_PER_TILE * N - 1, at
// SLOTS_PER_TILE = 4 since Phase 60 / SLOT-01; it was ~14 at the old value of 3)."*
// That assumed the RETIRED global rate of one slot per tick. A belt now carries its own
// advance interval as serialized state (`Belt::ticks_per_slot`, D-01/D-02), so the
// traverse is `(SLOTS_PER_TILE * N - 1) * ticks_per_slot` advance ticks plus an
// admission-alignment offset of at most `ticks_per_slot - 1` - 19 advance ticks on a
// 5-tile belt only while the interval sits at its pre-change identity value of 1, and
// proportionally longer at every value D-19 can choose. The figure is DELIBERATELY not
// re-typed as a number here: this file is a test-support module, and turning a comment
// into a computation off the wire is what would put it in a behavioural allowlist.
//
// So a Playwright-side poll at its 100ms floor samples a corridor a handful of
// times and can legitimately miss one. Nothing below is a tick BUDGET, so the
// slower traverse moves no assertion: the sampler is a monotonic latch and a
// longer-occupied corridor makes it easier to hit, not harder - and a LONGER interval
// makes it easier still, which is why the correction relaxes nothing. This installs an
// IN-PAGE sampler
// over the SAME read-only `window.__fabrico.scene()` oracle every other read uses
// - no new app surface, no write path - and latches two monotonic facts per belt:
// it CARRIED at least one item, and it later DRAINED back to empty. Items leave a
// belt's head only by delivery into the docked In port (a refused delivery backs
// up and never clears), so "carried then drained" is exactly "the item reached
// and was taken by the machine at the head".

interface FlowWatchFacts {
  carried: number[];
  drained: number[];
  /** Belts whose head-most item LEFT them (plan 85-08): the lowest occupied slot index (slot 0
   *  is the head, the deliver end) rose between two samples. Items only advance toward the head
   *  and only leave it by delivery into the docked In, and a refused delivery never leaves, so
   *  this is "the machine at the head took an item" on a belt too busy to ever drain empty. */
  headCleared: number[];
}

/** Start the in-page belt-flow sampler. Call BEFORE the gesture/POST under test. */
export async function startBeltFlowWatch(page: Page, sampleMs = 5): Promise<void> {
  await page.evaluate((ms) => {
    const w = window as unknown as {
      __fabFlowWatch?: {
        carried: Set<number>;
        drained: Set<number>;
        headCleared: Set<number>;
        timer: number;
      };
    };
    if (w.__fabFlowWatch) clearInterval(w.__fabFlowWatch.timer);
    const carried = new Set<number>();
    const drained = new Set<number>();
    const headCleared = new Set<number>();
    const lowest = new Map<number, number>();
    const timer = setInterval(() => {
      const scene = (
        window as unknown as {
          __fabrico?: { scene(): { belts: { id: number; items: number; occupiedSlots: number[] }[] } };
        }
      ).__fabrico?.scene();
      if (!scene) return;
      for (const b of scene.belts) {
        if (b.items > 0) carried.add(b.id);
        else if (carried.has(b.id)) drained.add(b.id);
        const low = b.occupiedSlots.length > 0 ? b.occupiedSlots[0] : Infinity;
        const before = lowest.get(b.id);
        if (before !== undefined && low > before) headCleared.add(b.id);
        lowest.set(b.id, low);
      }
    }, ms) as unknown as number;
    w.__fabFlowWatch = { carried, drained, headCleared, timer };
  }, sampleMs);
}

/** Read the latched flow facts (belt handles that carried / later drained). */
export async function readBeltFlowWatch(page: Page): Promise<FlowWatchFacts> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __fabFlowWatch?: { carried: Set<number>; drained: Set<number>; headCleared: Set<number> };
    };
    if (!w.__fabFlowWatch) throw new Error('belt flow watch not started');
    return {
      carried: [...w.__fabFlowWatch.carried],
      drained: [...w.__fabFlowWatch.drained],
      headCleared: [...w.__fabFlowWatch.headCleared],
    };
  });
}

/** Stop the in-page sampler (idempotent; safe on a page that never started one). */
export async function stopBeltFlowWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __fabFlowWatch?: { timer: number } };
    if (w.__fabFlowWatch) clearInterval(w.__fabFlowWatch.timer);
    w.__fabFlowWatch = undefined;
  });
}

// ---------------------------------------------------------------------------
// THE PER-TICK RECORDER (plan 77-02): one record per NEW sim tick, in the page.
// ---------------------------------------------------------------------------
//
// WHAT IT IS FOR. Some claims are ORDERS OF EVENTS on the sim clock: "the packed stretch
// reaches the next tile boundary on a LATER tick than the last one". A Playwright poll
// reads the scene at a 100 ms floor, which at 60 ticks per second skips five or six
// ticks between reads, so two boundaries reached on different ticks can read as one
// step and two reached on the same tick can never be told apart from that. Research
// for phase 77 measured exactly this on leg 2's pack. This recorder runs IN THE PAGE,
// on a 2 ms interval, over the same read-only `window.__fabrico.scene()` every other
// read here uses, and keeps ONE record each time the tick has moved. It stores plain
// data on its own window field and writes nothing to the app.
//
// IT IS A SAMPLER, NEVER A SETTLE. Nothing waits on it; a caller polls the change it
// awaits through `pollScene` and reads the recording afterwards. And the main thread
// can starve it for a tick or two around a click or a panel render, so a tick can be
// ABSENT from the recording. `readTickRecorder` reports how many were missed between
// the first and last record, and a caller grades with tolerance for that: an order is
// graded as the FIRST recorded tick at which each threshold is met, never as "the
// threshold moved on tick N exactly".

/** One recorded tick: the tick number, every node `[id, kind, state]`, and every belt
 *  `[id, ticksPerSlot, occupiedSlots, docks]`, copied out of `scene()`. With
 *  `startTickRecorder(page, { gaugeOf })`, `g` holds `[id, form]` for each named id: the
 *  gauge form read off the canvas at the moment of the record (plan 77-07), `null` for an id
 *  the layer has not drawn. The form carries its own `drawnAtTick`, which is usually the
 *  record's `t` minus one: grade it by that, never by `t`. */
export interface TickRecord {
  t: number;
  nodes: [number, number, number][];
  belts: [number, number, number[], DockFacts[]][];
  g?: [number, LoadGaugeFormFacts | null][];
  /** With `startTickRecorder(page, { itemDots: true })` (plan 77-04): the item layer's latest
   *  drawn frame at the moment of the record, its dots as `[x, y]` world px and the scene tick
   *  they were drawn FROM (`null` before the first draw). Usually a tick or more behind `t` on a
   *  flowing belt: grade it by `drawnAtTick` (`support/itemFrames.ts`), never by `t`. */
  d?: { drawnAtTick: number | null; dots: [number, number][] };
}

/** What the recorder stores in place of a drawn item frame when
 *  `window.__fabrico.itemDotsFrame` is missing; `readTickRecorder` throws, named, on it. */
const ITEM_HOOK_MISSING = 'ITEM_HOOK_MISSING';

/** What the recorder stores in place of a form when `window.__fabrico.loadGaugeFormOn` is
 *  missing; `readTickRecorder` throws, named, when it finds one. */
const GAUGE_HOOK_MISSING = 'GAUGE_HOOK_MISSING';

/** What `readTickRecorder` returns: the records in tick order, and the count of tick
 *  numbers absent between the first record and the last. */
export interface TickRecording {
  records: TickRecord[];
  missed: number;
}

/**
 * Start the in-page tick recorder, clearing any recording a previous call left. Call it
 * BEFORE the gesture whose consequences are graded, so the recording opens on the
 * state before them. A missing `window.__fabrico` is a named throw.
 *
 * `gaugeOf` (plan 77-07): node ids whose load gauge FORM is read off the canvas into each
 * record (`TickRecord.g`), through `window.__fabrico.loadGaugeFormOn`. A missing hook is
 * recorded as a sentinel, never as a silent null, and `readTickRecorder` throws on it. The
 * read is one Graphics instruction count and one bounds width per id per NEW tick, inside the
 * branch that already copies the scene, so the sampler's cadence is otherwise unchanged
 * (measured against plan 77-03's plain-recorder runs in 77-MUTATION-PROOF.md, "Plan 77-07
 * gauge lag measurement").
 *
 * `itemDots` (plan 77-04): each record also carries the item layer's latest drawn frame
 * (`TickRecord.d`), through `window.__fabrico.itemDotsFrame`: the dot positions and the scene
 * tick they were drawn FROM. A missing hook is recorded as a sentinel, and `readTickRecorder`
 * throws on it. Grade the frames with `support/itemFrames.ts`, which compares each one with the
 * record of its drawn tick.
 */
export async function startTickRecorder(
  page: Page,
  opts: { gaugeOf?: number[]; itemDots?: boolean } = {},
): Promise<void> {
  await page.evaluate(({ gaugeOf, missing, itemDots, itemMissing }) => {
    type SceneRead = {
      tick: number;
      nodes: { id: number; kind: number; state: number }[];
      belts: {
        id: number;
        ticksPerSlot: number;
        occupiedSlots: number[];
        docks: { end: 'Head' | 'Tail'; node: number; port: number }[];
      }[];
    };
    const w = window as unknown as {
      __fabrico?: {
        scene(): SceneRead;
        loadGaugeFormOn?(id: number): unknown;
        itemDotsFrame?(): { drawnAtTick: number | null; dots: { x: number; y: number }[] };
      };
      __fabTickRec?: { records: unknown[]; timer: number };
    };
    if (!w.__fabrico) {
      throw new Error('window.__fabrico not installed');
    }
    if (w.__fabTickRec) clearInterval(w.__fabTickRec.timer);
    const records: unknown[] = [];
    let last = Number.NaN;
    const timer = setInterval(() => {
      const s = w.__fabrico?.scene();
      if (!s || s.tick === last) return;
      last = s.tick;
      const rec: Record<string, unknown> = {
        t: s.tick,
        nodes: s.nodes.map((n) => [n.id, n.kind, n.state]),
        belts: s.belts.map((b) => [
          b.id,
          b.ticksPerSlot,
          [...b.occupiedSlots],
          (b.docks ?? []).map((d) => ({ end: d.end, node: d.node, port: d.port })),
        ]),
      };
      if (gaugeOf.length > 0) {
        const hook = w.__fabrico?.loadGaugeFormOn;
        rec.g = gaugeOf.map((id) => [id, typeof hook === 'function' ? hook(id) : missing]);
      }
      if (itemDots) {
        const frameOf = w.__fabrico?.itemDotsFrame;
        if (typeof frameOf === 'function') {
          const f = frameOf();
          rec.d = { drawnAtTick: f.drawnAtTick, dots: f.dots.map((p) => [p.x, p.y]) };
        } else {
          rec.d = itemMissing;
        }
      }
      records.push(rec);
    }, 2) as unknown as number;
    w.__fabTickRec = { records, timer };
  }, {
    gaugeOf: opts.gaugeOf ?? [],
    missing: GAUGE_HOOK_MISSING,
    itemDots: opts.itemDots === true,
    itemMissing: ITEM_HOOK_MISSING,
  });
}

/** Read the recording so far, with the missed-tick count. Throws, named, when the
 *  recorder was never started or `window.__fabrico` is missing. */
export async function readTickRecorder(page: Page): Promise<TickRecording> {
  return page.evaluate(({ missing, itemMissing }) => {
    const w = window as unknown as {
      __fabrico?: unknown;
      __fabTickRec?: { records: { t: number }[] };
    };
    if (!w.__fabrico) {
      throw new Error('window.__fabrico not installed');
    }
    if (!w.__fabTickRec) {
      throw new Error('the tick recorder was not started (call startTickRecorder first)');
    }
    const records = w.__fabTickRec.records.slice() as unknown as TickRecord[];
    for (const r of records) {
      if ((r.d as unknown) === itemMissing) {
        throw new Error(
          `window.__fabrico.itemDotsFrame() not installed: the tick recorder recorded no drawn item frame at tick ${r.t}`,
        );
      }
      for (const [id, form] of r.g ?? []) {
        if ((form as unknown) === missing) {
          throw new Error(
            `window.__fabrico.loadGaugeFormOn() not installed: the tick recorder recorded no gauge form for node ${id} at tick ${r.t}`,
          );
        }
      }
    }
    let missed = 0;
    for (let i = 1; i < records.length; i++) {
      const gap = records[i].t - records[i - 1].t;
      if (gap > 1) missed += gap - 1;
    }
    return { records, missed };
  }, { missing: GAUGE_HOOK_MISSING, itemMissing: ITEM_HOOK_MISSING });
}

/** Stop the in-page recorder and drop its recording (idempotent; safe on a page that
 *  never started one). */
export async function stopTickRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __fabTickRec?: { timer: number } };
    if (w.__fabTickRec) clearInterval(w.__fabTickRec.timer);
    w.__fabTickRec = undefined;
  });
}
