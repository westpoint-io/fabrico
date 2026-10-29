import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_NODE_COUNT,
  DRAWN_STATE_FRAMES,
  anchorOf,
  appendRouterRule,
  applyConfig,
  armAndPlaceAt,
  beltEndInstructionsOn,
  cameraOf,
  clickAt,
  deselectViaEmptyCell,
  drawBeltThroughCells,
  drawOffloadBelt,
  drawWireBetweenPorts,
  expectRenderLoopAlive,
  fillPanelField,
  loadDemoViaExamples,
  newBoard,
  nodeAtAnchor,
  nubAnchor,
  pollScene,
  pressSegment,
  readRouterTable,
  readScene,
  resetToDemo,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  type PortFacts,
  type RouterTableFacts,
  type SceneFacts,
} from './support/oracle';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import { PORT_STATUS } from '../src/chrome/configCopy';

// 24-one-board-all-six.spec.ts - THE WALK. It closes v8.0 milestone audit blocker B1.
//
// WHY THIS FILE EXISTS. The audit's finding is that every live spec in this suite
// runs on a board carrying exactly ONE phase's feature. `19-router-rules`,
// `20-wire-draw`, `21-endpoint-traffic`, `22-stranded-reconnect` and `23-belt-pace`
// are one spec per feature and not one of them composes another's. The milestone
// done-test describes a single board carrying FOUR features and it has never been
// walked. This file walks it: the done-test's legs, IN ORDER, on ONE board, starting
// from EMPTY.
//
// THE LEGS DELIBERATELY SHARE STATE, WHICH IS THE OPPOSITE OF EVERY OTHER LIVE SPEC
// AND IS THE ENTIRE POINT. `mode: 'serial'` is declared below and each leg continues
// on whatever the previous one left standing. A leg that re-booted its own board
// would turn this file back into the several-specs-in-one-file shape that audit
// blocker B1 names, so a later reader must not "fix" a leg by giving it a fresh
// board.
//
// ===========================================================================
// WHAT THIS FILE CANNOT ASSERT, SAID HERE SO NOBODY CITES ITS GREEN FOR IT.
// ===========================================================================
// This spec CANNOT assert byte-identity of a save. The live oracle is
// `window.__fabrico`, and its WHOLE surface is `scene / stats / frameTime / frame /
// camera / alertRingsActive / pinClock / setItemInterpolation / webhookUrl`
// (`App.tsx:1693-1740`). There is no hash, no snapshot bytes and no serialized-state
// getter, so the strongest live claim available is topology equality over a
// normalized projection of `SceneFacts`. The BYTE claim is discharged by
// `crates/fabrico-command/tests/composition_save_load.rs` - named by path
// deliberately, so no reader mistakes this file's green for that file's claim.
//
// THE BELT PACE DOES NOT RIDE THE SHARED `Configure` FRAME (audit W2). Reasoning
// that "the Configure tests cover every config user" is FALSE for belts:
// `ConfigPanel.tsx` `commitConfig` early-returns at `config.kind === 'Belt'`
// (`:172`) and sends `encodeBeltRunPace` (`:183`) instead, which reaches the host
// through the `0xFE` sentinel route into `apply_run_pace`
// (`crates/fabrico-host/src/input_apply.rs:504,545`). Any leg here that touches a
// belt's pace is exercising THAT seam and not the Configure one.
//
// WHY RENDER HEALTH IS ASSERTED AT ALL, in the shape 19-router-rules' header uses:
// the live oracle reads only the MODEL, so a board that routes perfectly behind a
// renderer that has stopped drawing satisfies every state assertion in this file.
// That exact failure is a recorded finding on this project, and the recorded shape
// is that it fires on the way back IN, not on the way out (20-wire-draw's header,
// the machines-missing bug of 2026-08-11). So `watchPageErrors` is installed BEFORE
// `page.goto` and `expectRenderLoopAlive` runs on BOTH sides of every gesture.
//
// ===========================================================================
// THE DECLARATION ORDER RULE. READ THIS BEFORE APPENDING TO THIS FILE.
// ===========================================================================
// Under `mode: 'serial'` a FAILING test SKIPS every test declared after it, and
// `playwright.live.config.ts:26-28` locks `retries: 0` as policy. That makes
// declaration order load-bearing rather than cosmetic.
//
// The file's final declaration order is:
//
//   1. leg 1 - a palette-placed Router splits items by the rule typed into its table
//   2. leg 2 - an Endpoint and its wire destination, placed and wired by hand
//   3. leg 3 - one belt set slower than its neighbour        (the REACHABLE half)
//   4. leg 4 - a machine disconnected and reconnected without reloading the scene
//   5. leg 5 - the board saved, loaded, and read back
//   6. leg 3 completed last: the joined run backs up at the junction and drains
//
// EVERY ONE OF THEM PASSES. Until plan 74-09 declaration 6 was an unconditional
// `throw`: done-test leg 3's backlog half was not walkable on the shipped build, and
// that red was accepted at the 2026-08-31 review. Phase 74 retired all
// three of the blockers it named, so it was replaced by the walking leg that now sits
// there - see that leg's own header for the three blockers and which artefact closed
// each.
//
// THE ORDER IS STILL LOAD-BEARING, and for two reasons rather than one. Legs 1 to 5
// SHARE A BOARD, so a reorder changes what each of them inherits - leg 4 reads what
// leg 2 built, and leg 3 reads what leg 1 drew. And under `mode: 'serial'` a test
// declared after a failing one never runs at all, so anything appended below the last
// declaration is silently un-run whenever anything above it goes red, while the suite
// still reports the same failure count.
//
// `src/gates/liveWalkDeclarationOrder.source.test.ts` holds that rule durably: it
// reads this file as text on every `npm test` and reddens on a reorder, on a deleted
// leg, on an appended declaration, on any skip / fixme / fail / only at either scope,
// on `mode: serial` being dropped, and on any unconditional throw reappearing in this
// file. If you came here to append a test, that gate is what will stop you, and the
// answer is to declare it above the last leg and to update the gate's expected order
// deliberately rather than to widen the gate.
//
// ===========================================================================
// SHARED-HOST NOTE.
// ===========================================================================
// The live suite runs `workers: 1` against ONE mutable dev host. This filename
// sorts AFTER `23-belt-pace`, so the walk runs last in the alphabetical suite and
// inherits no other spec's board. Leg 1 still resets the host to the demo baseline
// and THEN wipes it to empty, because "from an empty board" has to be a measurement
// and not a description of intent.

test.describe.configure({ mode: 'serial' });

// COMPLETE MIRRORS of the core keyspace, deliberately: `ROLE.FAULT` and
// `MEDIUM.MECHANICAL` are declared and NEVER read by any leg below. They are kept so
// each object states the whole enum, which is what makes `MEDIUM.ELECTRICAL`'s value
// of 1 readable rather than arbitrary. No leg uses them; do not go looking for one.
const ROLE = { IN: 0, OUT: 1, FAULT: 2 } as const;
const MEDIUM = { MECHANICAL: 0, ELECTRICAL: 1 } as const;
const KIND = { ROUTER: 5, ENDPOINT: 9 } as const;

/**
 * The settled palette-Router port profile as a ROLE MULTISET rather than a bare
 * count, so a failure names which role went missing. One In, the catalog's Out arity
 * which plan 65-05 widened (ROUTE-02), and - since plan 71-04 (PILE-10) appended a
 * spatial Role::Fault nub to the ROUTER catalog entry - one Fault. The browser seeds
 * the Fault because `gestures.ts`'s `seedRouterPreset` derives its AddPort legs from
 * the WHOLE catalog entry; measured on the real host 2026-09-02, and see
 * `16-router-presets.spec.ts` for the Rust/browser preset disagreement it exposed.
 * This leg never touches the Fault nub.
 */
const EXPECTED_ROLES = [ROLE.IN, ROLE.OUT, ROLE.OUT, ROLE.OUT, ROLE.FAULT] as const;

/** The Out arity inside {@link EXPECTED_ROLES}, DERIVED. It used to be spelled
 *  `EXPECTED_ROLES.length - 1`, which was the same number only while In was the sole
 *  non-Out role in the profile; appending the Fault broke that identity silently. */
const EXPECTED_OUTS = EXPECTED_ROLES.filter((r) => r === ROLE.OUT).length;

// ---------------------------------------------------------------------------
// THE BOARD LAYOUT. Named constants, because later legs address the SAME cells.
// ---------------------------------------------------------------------------
//
// Leg 1's block is 19-router-rules' measured geometry, unchanged: a 2x3 Router at
// (8,4) puts its In nub on the W edge at (8,5) (facing cell (7,5)) and its three
// Out nubs down the E column at (9,5), (9,6), (9,4) by routing key (the 74.1-14
// centre-out seats, the maintainer's ruling 2026-10-04). The Source is 1x1 with a single Out at
// its own cell facing E, so (5,5) faces (6,5) and the feed run is two cells. (Until
// 74.1-14 the In sat at (8,4) and the Source at (5,4).)
const SOURCE_CELL = [5, 5] as const;
const ROUTER_CELL = [8, 4] as const;
const FEED_CELLS = [
  [6, 5],
  [7, 5],
] as const;

// Leg 2's block, on the SAME board, three rows below leg 1's content so neither
// footprint nor belt corridor collides with it. Both are 1x1 ROUTES whose electrical
// nubs sit on their own cell: In facing W, Out facing E. (RENAMED BY PLAN 72-13,
// LEDGER ROW LR-5: D-09 renamed kind 9 from the old palette long form to `Route`.
// Same machine, same kind byte, same catalog ports.)
const CALLER_ENDPOINT_CELL = [5, 10] as const;
const WIRE_TARGET_CELL = [10, 10] as const;

/** An empty cell INSIDE the built content, used to deselect.
 *
 *  Inside deliberately. The camera is fit-to-content and re-fits as the board grows
 *  - 19-router-rules measured scale 1.11 on the empty board to 3.61 once its scene
 *  is built - so a far-away "obviously empty" cell drifts off the viewport by the
 *  time the panel is open and the deselect click lands on nothing. (6,6) sits in the
 *  block between the Source and the Router, is empty on every leg's board, and stays
 *  in frame because the fit is computed to include the content on both sides of it. */
const EMPTY_CELL = [6, 6] as const;

/** The two rules leg 1 types in, and the body that matches each. The third body
 *  matches NEITHER, so it exercises the default. Offsets are 0: the pattern is a
 *  prefix match on the injected bytes, and the webhook door carries the request body
 *  verbatim as the item's bytes. */
const RULE_ONE = { expect: 'A', offset: 0, body: 'A-one' } as const;
const RULE_TWO = { expect: 'B', offset: 0, body: 'B-two' } as const;
const UNMATCHED_BODY = 'Z-none';

// ---------------------------------------------------------------------------
// THE SHARED BOARD STATE. This is the composition, expressed as data.
// ---------------------------------------------------------------------------
//
// Leg 1 populates it and every later leg READS it. No leg re-derives these by
// placing again: re-placing would give the later leg its own board, which is the
// defect this file exists to close. Every field is optional-at-rest and asserted
// present by the leg that needs it, so a leg that runs without its predecessor
// fails by NAMING the missing predecessor rather than by an undefined dereference
// somewhere deeper.
interface WalkBoard {
  /** Leg 1: the palette-placed Router's handle. */
  routerId?: number;
  /** Leg 1: the palette-placed Source's handle. */
  sourceId?: number;
  /** Leg 1: the Router's Out ports in PACKET order. The array INDEX is the routing key. */
  outs?: PortFacts[];
  /** Leg 1: the feed belt (Source Out -> Router In). */
  feedBeltId?: number;
  /** Leg 1: the three offload belt handles, in routing-key order. */
  offloadBeltIds?: number[];
  /** Leg 2: the hand-placed caller Route. */
  callerEndpointId?: number;
  /** Leg 2: the hand-placed Route the wire lands on. */
  wireTargetId?: number;
  /** Leg 2: the hand-drawn wire. */
  wireId?: number;
  /** Leg 3 (the reachable half): the offload belt the slower pace was pressed onto. */
  pacedBeltId?: number;
  /** Leg 3: that belt's MEASURED `ticksPerSlot` after Apply. */
  pacedBeltTicks?: number;
  /** Leg 3: the NEIGHBOUR offload belt, left at the pace it had. */
  neighbourBeltId?: number;
  /** Leg 3: that neighbour's MEASURED `ticksPerSlot`, read after the Apply landed. */
  neighbourBeltTicks?: number;
}

const board: WalkBoard = {};

/** Read a field leg N depends on, naming the leg that should have set it. */
function required<K extends keyof WalkBoard>(key: K, setBy: string): NonNullable<WalkBoard[K]> {
  const value = board[key];
  expect(
    value,
    `${setBy} recorded \`${String(key)}\` on the shared board - if this is undefined, ` +
      `${setBy} did not run, and this file's legs are meant to run in order on ONE board`,
  ).toBeDefined();
  return value as NonNullable<WalkBoard[K]>;
}

// ---------------------------------------------------------------------------
// Spec-local helpers, COPIED from 19-router-rules.spec.ts rather than imported:
// they are spec-local there and not oracle exports.
// ---------------------------------------------------------------------------

/** What the Router panel calls an output (phase 91, D-12, CHROME-13, UI-SPEC 8.6): `Output N`,
 *  N its routing key + 1 (its position among the Router's Outs in packet order, which is
 *  `outs`' order), plus ` (Target)` only when its belt reaches a machine. Every offload belt
 *  here ends on open floor, so no name carries a target. Until phase 91 the panel named each
 *  output by its nub's grid cell. */
function outputLabel(outs: readonly PortFacts[], port: PortFacts): string {
  const n = outs.indexOf(port) + 1;
  expect(n, 'the port is one of the Router Outs').toBeGreaterThan(0);
  return `Output ${n}`;
}

/** The belt whose TAIL is docked to `key` on `routerId`, read off board state.
 *
 *  `DockFacts.port` is the ROUTING KEY (the port's 0-based position among its role's
 *  ports), which is the same keyspace a rule's target uses. Resolving the belt this
 *  way means nothing in the routing assertion below depends on the order the belts
 *  were drawn in or on the handles the host happened to mint. */
function offloadBeltFor(scene: SceneFacts, routerId: number, key: number) {
  return scene.belts.find((b) =>
    b.docks.some((d) => d.end === 'Tail' && d.node === routerId && d.port === key),
  );
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
 */
async function ensurePlaying(page: Page): Promise<void> {
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
  // token is deliberately not spelled out on this line: plan 69-04's gate
  // COUNTS it, so a prose mention would break the gate exactly the way the
  // modifier prose further down is careful not to.
  const tLast = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick > tLast, {
    timeout: 5_000,
    message:
      'could not resume the sim: after three Play presses the tick still never advanced',
  }).toBe(true);
}

/** The mandatory preamble: watcher installed BEFORE goto, host reset, board emptied.
 *  ONLY LEG 1 CALLS THIS. Every later leg attaches to the board it left. */
async function bootOnEmptyBoard(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await ensurePlaying(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await waitForCameraSettle(page);
  return errs;
}

/**
 * Attach a LATER leg to the board the previous leg left.
 *
 * Playwright hands each test its own `page`, but the BOARD lives on the shared host,
 * not in the page - so a later leg re-opens the app and finds the same board. There is
 * deliberately no `resetToDemo` and no `newBoard` here: that absence IS the
 * composition. `ensurePlaying` is still called, because the sim is host-global and a
 * paused host would queue this leg's gestures forever.
 */
async function attachToRunningBoard(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await ensurePlaying(page);
  await waitForCameraSettle(page);
  return errs;
}

/**
 * Bring a cell OUTSIDE the current fit back into the viewport, through the shipped
 * `Reset zoom to 100%` readout control.
 *
 * MEASURED, and this leg would not run without it. The camera is fit-to-CONTENT and
 * re-fits as the board grows: 19-router-rules measured scale 1.11 on an empty board
 * to 3.61 once leg 1's scene is built. At 3.61 the 1280x720 viewport sees about
 * 11x6 cells around leg 1's content, so a cell three rows below it projects OUTSIDE
 * the viewport, `page.mouse` clicks nothing, and the placement never folds. That is
 * verbatim research Pitfall 3 and WINDOWS row 114, and it is what the first run of
 * leg 2 hit: the caller Endpoint's poll timed out with the machine never echoing.
 *
 * `CameraCluster.tsx:68` documents the control as "Reset zoom to 100%, keeping the
 * viewport-centre world point fixed", so at scale 1 the viewport sees +/-20 cells
 * horizontally and +/-11 vertically around leg 1's content - which covers every cell
 * this file addresses. It is a SHIPPED control driven by a real click
 * (`07-zoom-readout.spec.ts:101` drives the same one), it emits no command, and it
 * changes nothing in the model.
 */
async function resetZoomToActualSize(page: Page): Promise<void> {
  await page.getByTitle('Reset zoom to 100%').click();
  await expect
    .poll(async () => Math.round((await cameraOf(page)).scale * 100), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'reset zoom readout poll'),
      intervals: [100, 250, 500],
      message: 'the shipped zoom readout reset the camera to exactly 100%',
    })
    .toBe(100);
  await waitForCameraSettle(page);
}

/**
 * Settle on a belt having committed with the DOCKS it was drawn for, never on
 * `belts.length`.
 *
 * MEASURED, and the reason is in `69-LIVE-MEASUREMENT.md` section 3. A belt drawn
 * along a cornered path committed with its TAIL dock and NO head dock. The belt
 * existed, so a `belts.length` poll passed cleanly, and the failure surfaced much
 * later as a machine whose port read `not connected` for no visible reason. A length
 * is not evidence that a belt connected the two things it was drawn between.
 */
function pollDockSet(page: Page, message: string) {
  return pollScene(
    page,
    (s) =>
      s.belts
        .flatMap((b) => b.docks.map((d) => `${d.end}@${d.node}:${d.port}`))
        .sort()
        .join(' '),
    { message },
  );
}

// ---------------------------------------------------------------------------
// LEG 3's three strings, all copied from the files that own them.
// ---------------------------------------------------------------------------

/** The slow end of the pace scale the panel OFFERS as a segment: `25` px/sec.
 *  Copied from `23-belt-pace.spec.ts:101-103` together with the ticks it resolves
 *  to, so this leg presses a shipped segment rather than typing a raw figure. */
const SLOW_END_LABEL = '25';
const SLOW_END_TICKS = 20;

/** The panel's own sentence for a belt that is a run of ONE, verbatim from
 *  `frontend/src/chrome/BeltConfigBody.tsx:138` (`RUN_SINGLE`).
 *
 *  THIS IS LEG 3's LIVE EVIDENCE FOR THE HALF IT CANNOT WALK. The unwalkable
 *  declaration at the bottom of this file claims the two paced belts are not one
 *  run; rather than assert that from the WINDOWS rows alone, leg 3 reads it out of
 *  the shipped panel on BOTH belts, one after the other. */
const RUN_SINGLE_COPY = 'This run is one belt.';

// ---------------------------------------------------------------------------
// LEG 4's two measured strings and the one geometry helper it needs.
// ---------------------------------------------------------------------------

/**
 * The LIVE composed accessible name of the panel `Disconnect` control on the row
 * leg 4 operates.
 *
 * MEASURED OFF THE RUNNING APP, not transcribed from the mock suite, and the
 * difference is not cosmetic. `69-LIVE-MEASUREMENT.md` section 3 enumerates every
 * button name inside the running `Ports` region and records this one verbatim.
 * `PortsSection.tsx:753` composes the name as `` `${DISCONNECT_LABEL} ${portRowLabel(port)}` ``,
 * so it follows the ROW's own name, which follows the port's ROLE and MEDIUM. The
 * only other proof of this control anywhere - `frontend/e2e/panel-disconnect.spec.ts:223-246`,
 * in the MOCK suite - reads `Disconnect Output - Item`, because its injected
 * fixture docks an OUTPUT. Leg 4 disconnects a belt from a machine's INPUT, so the
 * live name is `Disconnect Input - Item` and the mock string would have MISSED, on
 * the one leg whose entire point is that this control has never had live coverage.
 */
const DISCONNECT_CONTROL_NAME = 'Disconnect Input - Item';

/**
 * The docked reading of that same row, as its own accessible name.
 *
 * `portRow` names a row `"{label}, {status}"` (`PortsSection.tsx:584`) and the
 * status vocabulary is the four `PORT_STATUS` words (phase 91, CHROME-13):
 * `not connected` when nothing is attached, `idle` when something is attached and
 * still, `moving` when items flow on it, `backed up` when its head item cannot
 * leave (`chrome/configCopy.ts`). So a row matching this pattern is a row
 * that reads as DOCKED, and one reading `not connected` cannot match it. Leg 4
 * asserts this BEFORE it touches the control, for the reason the mock analog
 * states: without it, the control's presence would be proving something about a
 * row in the wrong state.
 */
const DOCKED_IN_ROW = new RegExp(`^Input - Item, (${PORT_STATUS.idle}|${PORT_STATUS.moving}|${PORT_STATUS.backedUp})$`);

/** Side unit vectors in the core keyspace order N=0, E=1, S=2, W=3. */
const SIDE_UNIT: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** The cell a port FACES: `port cell + unit_delta(side)` - the one cell a dock can
 *  occupy (`command.rs:1084`), copied from `22-stranded-reconnect.spec.ts:111-115`. */
function facingCell(p: PortFacts): [number, number] {
  const [dx, dy] = SIDE_UNIT[p.side & 3];
  return [p.cell_x + dx, p.cell_y + dy];
}

/** One belt's dock entries as sorted `End@node:port` strings - the shape every
 *  dock assertion in this file names a SPECIFIC entry with, never a count. */
function dockStrings(belt: SceneFacts['belts'][number] | undefined): string[] {
  return (belt?.docks ?? []).map((d) => `${d.end}@${d.node}:${d.port}`).sort();
}

// ---------------------------------------------------------------------------
// LEG 5's helpers: the status readout poll, and the topology comparator.
// ---------------------------------------------------------------------------

/**
 * Poll the accessible status readout's text. COPIED VERBATIM from
 * `09-save-load-status.spec.ts:18-30`, where it is spec-local and not an oracle
 * export. The `role="status"` span always renders (empty when idle), so this reads
 * the LIVE announced copy a user and a screen reader see, never an injected value.
 */
function pollStatusText(page: Page, message: string) {
  return expect.poll(async () => ((await page.getByRole('status').textContent()) ?? '').trim(), {
    timeout: 15_000,
    intervals: [100, 250, 500],
    message,
  });
}

/**
 * The board's TOPOLOGY, projected into a deterministically ordered comparable
 * shape. NEW GROUND: `69-PATTERNS.md` records "No Analog Found" for this - there
 * is no normalized-topology comparator anywhere in the tree to copy.
 *
 * WHY THE SHAPE IS SPLIT INTO NAMED FIELDS RATHER THAN ONE BLOB. Leg 5 asserts
 * each of the four composed features by name AND the whole projection in one
 * comparison. The named fields are what make a failure say WHICH feature did not
 * come back, instead of dumping two large objects and leaving the reader to diff
 * them.
 *
 * THE COMPARISON KEY IS THE NODE AND BELT `id`, AND THAT IS A MEASUREMENT, NOT AN
 * INFERENCE. The phase 69 live measurement
 * (section 1) probed a real live Save then Load on this
 * host and read `nodeIds=IDENTICAL beltIds=IDENTICAL anchors=IDENTICAL`. The
 * handle-free `anchorOf` keying that `oracle.ts:755` describes as "the handle-free
 * identity a keyframe cannot renumber" was held in reserve for a RENUMBERED
 * reading and is not needed; the anchor is carried inside each node's projection
 * anyway, so a renumbering that this key missed would still surface there.
 *
 * WHAT IS DELIBERATELY NOT PROJECTED. Belt `items` and the scene `tick` are
 * TRAFFIC, not topology: they change every tick on a running board, and comparing
 * them would make this leg fail for a reason that has nothing to do with save and
 * load. A wire's `tiles` is a COUNT and never the cells (`drawWireBetweenPorts`'s
 * docblock), so it says nothing a topology compare could use.
 */
interface TopologyProjection {
  /** SORT KEY: node `id`, ascending. Ports within a node keep their DECLARED order,
   *  which is the catalog `index` order - a port list is a sequence, not a set. */
  nodes: string[];
  /** SORT KEY: belt `id`, ascending. */
  beltPaces: string[];
  /** SORT KEY: belt `id`, ascending; each belt's tile cells sorted by the `(x,y)`
   *  string. The path's DIRECTION is not lost by that sort - it is carried by the
   *  Head/Tail docks in `docks` below. */
  beltPaths: string[];
  /** SORT KEY: belt `id`, ascending; each belt's dock entries sorted by the
   *  `End@node:port` string (`dockStrings`). */
  docks: string[];
  /** SORT KEY: wire `id`, ascending. */
  wires: string[];
  /** NOT SORTED, and that is deliberate: a routing table's ENTRY ORDER is its
   *  semantics - the host matches rules in order - so sorting it would discard the
   *  very thing leg 1 typed in. `SceneFacts` carries no machine config at all (see
   *  this file's header), so this half of the projection is read back through the
   *  shipped panel, which is the only read path there is. */
  routerTable: RouterTableFacts;
}

function normalizedTopology(scene: SceneFacts, routerTable: RouterTableFacts): TopologyProjection {
  const byId = <T extends { id: number }>(xs: readonly T[]): T[] =>
    [...xs].sort((a, b) => a.id - b.id);
  return {
    nodes: byId(scene.nodes).map((n) => {
      const [ax, ay] = anchorOf(n);
      const ports = [...n.ports]
        .sort((a, b) => a.index - b.index)
        .map((p) => `${p.index}:role=${p.role}:medium=${p.medium}`)
        .join(' ');
      return `node#${n.id} kind=${n.kind} anchor=(${ax},${ay}) ports=[${ports}]`;
    }),
    beltPaces: byId(scene.belts).map((b) => `belt#${b.id} ticksPerSlot=${b.ticksPerSlot}`),
    beltPaths: byId(scene.belts).map((b) => {
      const tiles = b.tiles
        .map((t) => `(${t.cell_x},${t.cell_y})`)
        .sort()
        .join(' ');
      return `belt#${b.id} tiles=[${tiles}]`;
    }),
    docks: byId(scene.belts).map((b) => `belt#${b.id} docks=[${dockStrings(b).join(' ')}]`),
    wires: byId(scene.wires).map(
      (w) => `wire#${w.id} from=${w.from.node}:${w.from.port} to=${w.to.node}:${w.to.port}`,
    ),
    routerTable,
  };
}

/**
 * Read the whole projection off the live board: one scene read plus one panel
 * round trip for the routing table, which `SceneFacts` cannot see.
 */
async function readTopology(page: Page): Promise<TopologyProjection> {
  const scene = await readScene(page);
  await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
  const table = await readRouterTable(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  return normalizedTopology(scene, table);
}

// ===========================================================================
// LEG 1
// ===========================================================================

test.describe('the walk: the done-test on ONE board, from EMPTY', () => {
  test('leg 1 - a palette-placed Router splits items by the rule typed into its table', async ({
    page,
  }) => {
    const errs = await bootOnEmptyBoard(page);
    await expectRenderLoopAlive(page, 'on the empty board, before any placement');

    // -----------------------------------------------------------------------
    // Place the two machines by gesture. Nothing is inherited: the board was
    // wiped above, so every machine and every belt below is this leg's own.
    // -----------------------------------------------------------------------
    await armAndPlaceAt(page, 'Router', ROUTER_CELL[0], ROUTER_CELL[1]);
    // Poll the WHOLE settle predicate rather than reading a length and then reading
    // again: the preset seeding is a fold sequence (the Place echoes, then the
    // RemovePort and AddPort legs land over ticks), so a two-step read can catch a
    // transient intermediate port list and assert against it.
    await pollScene(
      page,
      (s) => {
        const r = nodeAtAnchor(s, ROUTER_CELL[0], ROUTER_CELL[1]);
        if (!r || r.ports.length !== EXPECTED_ROLES.length) return false;
        const roles = r.ports.map((p) => p.role).sort();
        return roles.every((role, i) => role === EXPECTED_ROLES[i]);
      },
      {
        message: `the placed Router settles into the ${EXPECTED_ROLES.length}-port preset profile (1 In, ${EXPECTED_OUTS} Out, 1 Fault)`,
      },
    ).toBe(true);
    await waitForCameraSettle(page);

    await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
    await pollScene(
      page,
      (s) => nodeAtAnchor(s, SOURCE_CELL[0], SOURCE_CELL[1]) !== undefined,
      { message: 'the Source echoed onto the board' },
    ).toBe(true);
    await waitForCameraSettle(page);

    const built = await readScene(page);
    const router = nodeAtAnchor(built, ROUTER_CELL[0], ROUTER_CELL[1]) as SceneFacts['nodes'][number];
    const source = nodeAtAnchor(built, SOURCE_CELL[0], SOURCE_CELL[1]) as SceneFacts['nodes'][number];
    expect(router.kind, 'the machine at the Router cell is a Node::Router').toBe(KIND.ROUTER);
    expect(built.nodes, 'the board holds exactly the two machines this leg placed').toHaveLength(2);

    // THE NUBS ARE READ OFF THE SETTLED NODE, NEVER ASSUMED BY ORDINAL. A Router seats
    // its routing keys centre-out (since 74.1-14: key 0 on the middle row, then below,
    // then above), so no screen ordinal matches a key. The belt
    // geometry, the panel segment labels and the routing keys below are ALL derived
    // from these port records.
    const outs = router.ports.filter((p) => p.role === ROLE.OUT);
    expect(outs, 'the settled Router exposes the catalog Out arity').toHaveLength(EXPECTED_OUTS);
    const inPort = router.ports.find((p) => p.role === ROLE.IN) as PortFacts;
    // Destructured rather than indexed, so no Out ordinal is written as a literal
    // anywhere in this leg: these three names ARE the settled seating.
    const [defaultOut, ruleOneOut, ruleTwoOut] = outs;

    // -----------------------------------------------------------------------
    // The belts. The feed run settles on BOTH docks; each offload run settles on
    // its own routing key having a belt.
    // -----------------------------------------------------------------------
    await drawBeltThroughCells(page, source.ports[0], FEED_CELLS, inPort);
    await pollDockSet(
      page,
      'the feed belt committed with BOTH docks (Tail on the Source Out, Head on the Router In)',
    ).toBe(`Head@${router.id}:0 Tail@${source.id}:0`);

    // One offload belt per output, each running E from that nub's own facing cell
    // along that nub's own row. The row comes from the port record, so this loop
    // follows the seating rather than a transcription of it.
    for (let i = 0; i < outs.length; i += 1) {
      const y = outs[i].cell_y;
      await drawOffloadBelt(page, outs[i], [
        [10, y],
        [11, y],
        [12, y],
      ]);
      await pollScene(page, (s) => offloadBeltFor(s, router.id, i) !== undefined, {
        message: `offload belt for routing key ${i} committed off ${outputLabel(outs, outs[i])}`,
      }).toBe(true);
    }
    await waitForCameraSettle(page);

    const wired = await readScene(page);
    const feedBelt = wired.belts.find((b) =>
      b.docks.some((d) => d.end === 'Head' && d.node === router.id),
    );
    expect(feedBelt, 'a belt delivers into the Router In port').toBeDefined();
    const offloads = outs.map((_, key) => offloadBeltFor(wired, router.id, key));
    // Every output has its own offload belt, and they are DISTINCT belts. Asserted
    // here rather than at the routing assertion so a drawing mistake fails where it
    // was made.
    expect(offloads.every((b) => b !== undefined), 'no output was left without a belt').toBe(true);
    expect(
      new Set(offloads.map((b) => b?.id)).size,
      'every Out routing key has its OWN offload belt, all distinct',
    ).toBe(outs.length);

    await expectRenderLoopAlive(page, 'after the placements and the belt draws');
    errs.assertNone('after the placements and the belt draws');

    // -----------------------------------------------------------------------
    // The table. Typed into the shipped panel, applied, and read back through a
    // RE-OPENED panel so the read is the host's committed config and not the
    // local buffer.
    // -----------------------------------------------------------------------
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    expect(
      await readRouterTable(page),
      'a freshly placed Router arrives with an EMPTY table and its minted default, so the read-back below measures what this leg typed',
    ).toEqual({ rules: [], fallback: outputLabel(outs, defaultOut) });
    await appendRouterRule(page, {
      expect: RULE_ONE.expect,
      offset: RULE_ONE.offset,
      target: outputLabel(outs, ruleOneOut),
    });
    await appendRouterRule(page, {
      expect: RULE_TWO.expect,
      offset: RULE_TWO.offset,
      target: outputLabel(outs, ruleTwoOut),
    });
    await pressSegment(page, 'Default', outputLabel(outs, defaultOut));
    await applyConfig(page);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // Re-OPEN the panel. The panel pre-fills from `machine_config`, so a table read
    // from a panel that never unmounted could be the local buffer rather than the
    // host's committed config; unmounting and re-selecting forces the round trip.
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    expect(
      await readRouterTable(page),
      'both rules survived Apply in ENTRY order, each with the target it was given, and the default is the first output',
    ).toEqual({
      rules: [
        {
          target: outputLabel(outs, ruleOneOut),
          expect: RULE_ONE.expect,
          offset: String(RULE_ONE.offset),
        },
        {
          target: outputLabel(outs, ruleTwoOut),
          expect: RULE_TWO.expect,
          offset: String(RULE_TWO.offset),
        },
      ],
      fallback: outputLabel(outs, defaultOut),
    });
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    await expectRenderLoopAlive(page, 'after the Router table round trip');
    errs.assertNone('after the Router table round trip');

    // -----------------------------------------------------------------------
    // The split. Real HTTP POSTs at the Source's own shipped front door.
    // -----------------------------------------------------------------------
    const url = await webhookUrl(page, source.id);
    expect(url, 'the placed Source resolves to its own loopback /hook/src-<id> POST URL').toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/hook\/src-\d+$/,
    );

    /**
     * POST one body at the Source's front door and settle on the EXACT occupancy of
     * ALL THREE offload belts, in ONE poll.
     *
     * The whole vector is asserted per item, not just the belt the item was expected
     * on. Asserting only the expected belt would pass against a Router that copied the
     * item to every output, which is a different machine from the one this leg is
     * about. And attributing item by item - rather than posting all three and counting
     * at the end - is what makes each rule's destination provable: a Router that sent
     * everything to the default would end a three-post run at 3/0/0 and could not be
     * mistaken for a correct one, but a Router that had rules one and two SWAPPED would
     * end it 1/1/1 exactly like a correct one.
     */
    const postAndExpect = async (body: string, expected: readonly number[]) => {
      const resp = await page.request.post(url as string, { data: body });
      expect(resp.status(), `the webhook front door accepted the ${body} POST`).toBe(200);
      await pollScene(
        page,
        (s) => outs.map((_, key) => offloadBeltFor(s, router.id, key)?.items ?? -1).join(','),
        {
          message:
            `after posting ${body}, the offload belts for routing keys 0/1/2 hold ` +
            `${expected.join('/')} items at rest`,
        },
      ).toBe(expected.join(','));
    };

    // Rule ONE's body. It lands on rule one's output and NOWHERE else - not on the
    // default's, which is the assertion that makes "one kind of item goes one way"
    // mean what it says.
    await postAndExpect(RULE_ONE.body, [0, 1, 0]);
    // A body matching NO rule. It lands on the DEFAULT's output, and rule one's item
    // is still sitting where it came to rest.
    await postAndExpect(UNMATCHED_BODY, [1, 1, 0]);
    // Rule TWO's body, which proves the second rule is live rather than merely stored.
    await postAndExpect(RULE_TWO.body, [1, 1, 1]);

    const settled = await readScene(page);
    const restingBelts = outs.map(
      (_, key) => offloadBeltFor(settled, router.id, key) as SceneFacts['belts'][number],
    );
    // THE THREE BELTS ARE DIFFERENT BELTS. Stated explicitly rather than left implied
    // by the per-key lookup: if two routing keys ever resolved to the SAME belt handle,
    // every occupancy vector above would still read 1/1/1 while the items had in fact
    // all gone to one place.
    expect(
      new Set(restingBelts.map((b) => b.id)).size,
      'the three resting items are on three DIFFERENT belts',
    ).toBe(outs.length);
    // The feed belt drained: the board is SETTLED and nothing is caught mid-transport,
    // so the occupancy read above is a resting state and not a snapshot of traffic.
    expect(
      settled.belts.find((b) => b.id === feedBelt!.id)?.items,
      'the feed belt is empty at the settle (every item reached the Router)',
    ).toBe(0);

    // -----------------------------------------------------------------------
    // Hand the board to leg 2.
    // -----------------------------------------------------------------------
    board.routerId = router.id;
    board.sourceId = source.id;
    board.outs = outs;
    board.feedBeltId = feedBelt!.id;
    board.offloadBeltIds = restingBelts.map((b) => b.id);

    await expectRenderLoopAlive(page, 'after the three routed items came to rest');
    errs.assertNone('the whole of leg 1');
  });

  // =========================================================================
  // LEG 2
  // =========================================================================
  //
  // WHY THE WIRE'S DESTINATION IS A SECOND ENDPOINT AND NOT A HANDLER FACTORY.
  // MEASURED, not assumed: `69-LIVE-MEASUREMENT.md` section 6. A wire needs an
  // ELECTRICAL `Role::In` at its destination (`command.rs`'s DrawWire arm, step 5,
  // via the shared `mediums_compatible` predicate). A palette-placed Factory carries
  // three MECHANICAL ports and nothing else, and the only port-growing control its
  // panel offers is `+ Add output`, which `PortsSection.tsx:792` documents as issuing
  // `AddPort { role: Out, medium: Item }` - an output, mechanical, on a Factory only.
  // Measured live: a Factory's ports read `medium:0` before AND after that click.
  // THERE IS NO GESTURE THAT GIVES A FACTORY AN ELECTRICAL INPUT. The demo board's
  // handler Factory has one because `demo_scene.rs` seeds it, which is not a route a
  // user has.
  //
  // TWO palette arms expose an electrical `Role::In` at this commit: `Route` and
  // `HTTP Handler`. (A third, `HTTP Router`, was PULLED by plan 72-10's R-64 as a live
  // false claim - nothing ever links a machine's OUTPUT port into a wire, so a Router
  // structurally cannot sit on a request path.) This leg uses a second ROUTE rather
  // than a Handler, and the choice is load-bearing rather than incidental: under D-04
  // a Route-to-Handler drag is a PAIRING that mints TWO cables from one gesture, while
  // Route-to-Route is not a pair and mints exactly ONE, which is what this leg's
  // one-wire assertions are about. The paired gesture is walked by
  // `25-route-and-handler.spec.ts` instead. Either way the wire runs between two
  // machines a user placed, drawn by a drag a user could perform. Manufacturing the
  // Factory the plan described would have meant issuing a constructed `AddPort` behind
  // the UI's back - the "constructed board" the phase CONTEXT forbids, and the exact
  // substitution that turns a walk into an argument.
  test('leg 2 - an Endpoint and its wire destination are placed and wired by hand on the same board', async ({
    page,
  }) => {
    // NO `bootOnEmptyBoard`, NO `newBoard`, NO `resetToDemo`. That absence is the
    // composition: this leg runs on whatever leg 1 left standing.
    const errs = await attachToRunningBoard(page);
    await expectRenderLoopAlive(page, 'on the inherited board, before leg 2 touches it');

    const routerId = required('routerId', 'leg 1');
    const outs = required('outs', 'leg 1');
    const feedBeltId = required('feedBeltId', 'leg 1');
    const offloadBeltIds = required('offloadBeltIds', 'leg 1');
    const [defaultOut, ruleOneOut, ruleTwoOut] = outs;

    // -----------------------------------------------------------------------
    // LEG 1'S WORK IS STILL HERE. Asserted FIRST and by name, so a board that
    // lost it fails here rather than somewhere deeper inside this leg where the
    // message would be about a wire.
    // -----------------------------------------------------------------------
    const inherited = await readScene(page);
    const router = nodeAtAnchor(inherited, ROUTER_CELL[0], ROUTER_CELL[1]);
    expect(router?.id, 'leg 1\'s Router is still seated at its cell, under the same handle').toBe(
      routerId,
    );
    expect(
      outs.map((_, key) => offloadBeltFor(inherited, routerId, key)?.id),
      "leg 1's three offload belts are all still docked to their routing keys",
    ).toEqual(offloadBeltIds);

    // The TABLE survived too, read back through the shipped panel. `window.__fabrico`
    // carries no machine config (see this file's header), so the table is the one part
    // of leg 1's work that a scene read cannot see - which is exactly why it is checked
    // here explicitly instead of being assumed to have ridden along with the topology.
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    const inheritedTable = await readRouterTable(page);
    expect(
      inheritedTable,
      "leg 1's routing table is still committed on the Router this leg is about to build beside",
    ).toEqual({
      rules: [
        { target: outputLabel(outs, ruleOneOut), expect: RULE_ONE.expect, offset: String(RULE_ONE.offset) },
        { target: outputLabel(outs, ruleTwoOut), expect: RULE_TWO.expect, offset: String(RULE_TWO.offset) },
      ],
      fallback: outputLabel(outs, defaultOut),
    });
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // -----------------------------------------------------------------------
    // Place the caller Endpoint and the Endpoint the wire will land on.
    // -----------------------------------------------------------------------
    // `Place Route` is the shipped accessible name since D-09 (plan 72-10 renamed kind
    // 9). `armAndPlaceAt` resolves the palette row by ACCESSIBLE NAME
    // (`oracle.ts:805`), so the old spelling resolved nothing and the click timed out
    // at 90s. That was ledger row LR-5 and plan 72-13 closes it here.
    await resetZoomToActualSize(page);
    await armAndPlaceAt(page, 'Route', CALLER_ENDPOINT_CELL[0], CALLER_ENDPOINT_CELL[1]);
    await pollScene(
      page,
      (s) => nodeAtAnchor(s, CALLER_ENDPOINT_CELL[0], CALLER_ENDPOINT_CELL[1])?.kind,
      { message: 'the hand-placed caller Route folded on the real host' },
    ).toBe(KIND.ENDPOINT);
    await waitForCameraSettle(page);

    await resetZoomToActualSize(page);
    await armAndPlaceAt(page, 'Route', WIRE_TARGET_CELL[0], WIRE_TARGET_CELL[1]);
    await pollScene(
      page,
      (s) => nodeAtAnchor(s, WIRE_TARGET_CELL[0], WIRE_TARGET_CELL[1])?.kind,
      { message: 'the hand-placed wire-destination Route folded on the real host' },
    ).toBe(KIND.ENDPOINT);
    await waitForCameraSettle(page);

    const placed = await readScene(page);
    const caller = nodeAtAnchor(
      placed,
      CALLER_ENDPOINT_CELL[0],
      CALLER_ENDPOINT_CELL[1],
    ) as SceneFacts['nodes'][number];
    const target = nodeAtAnchor(
      placed,
      WIRE_TARGET_CELL[0],
      WIRE_TARGET_CELL[1],
    ) as SceneFacts['nodes'][number];

    // THE PORT PAIR IS RESOLVED OFF THE SETTLED NODES, never by ordinal. Both ends
    // are found by (role, medium) out of the node's own port list, so nothing here
    // depends on the catalog's declaration order - which is the same discipline leg 1
    // applies to the Router's Out nubs and for the same reason.
    const callerOut = caller.ports.find(
      (p) => p.role === ROLE.OUT && p.medium === MEDIUM.ELECTRICAL,
    );
    const targetIn = target.ports.find((p) => p.role === ROLE.IN && p.medium === MEDIUM.ELECTRICAL);
    expect(
      callerOut,
      'the hand-placed caller Endpoint carries an ELECTRICAL Out to drag a wire from',
    ).toBeDefined();
    expect(
      targetIn,
      'the hand-placed destination Endpoint carries an ELECTRICAL In for the wire to land on',
    ).toBeDefined();

    const wiresBefore = placed.wires.length;
    await expectRenderLoopAlive(page, 'after the two placements, before the wire drag');
    errs.assertNone('after the two placements, before the wire drag');

    // -----------------------------------------------------------------------
    // The wire, drawn by a real pointer drag.
    // -----------------------------------------------------------------------
    // WINDOWS 148 records `20-wire-draw.spec.ts` as timing-flaky under full-suite
    // load, and `retries: 0` is locked policy at `playwright.live.config.ts:26-28`.
    // If this drag inherits that shape it may show the same intermittent red. It is
    // deliberately NOT hedged: no retry, no sleep, no relaxed assertion. A flake here
    // is a reading to record against WINDOWS 148, not a thing to paper over.
    await resetZoomToActualSize(page);
    await drawWireBetweenPorts(page, callerOut as PortFacts, targetIn as PortFacts);
    await pollScene(page, (s) => s.wires.length, {
      message: 'the hand-drawn wire folded on the real host',
    }).toBe(wiresBefore + 1);

    // -----------------------------------------------------------------------
    // THE COMPOSITION ASSERTION. One scene read, everything at once.
    // -----------------------------------------------------------------------
    // This single expect is what makes the file a composition proof rather than two
    // specs sharing a filename: leg 1's Router, leg 1's three keyed offload belts,
    // leg 1's feed belt and leg 2's hand-drawn wire are all read out of the SAME
    // `readScene` call and asserted present together.
    //
    // The routing TABLE is not in this object because `SceneFacts` does not carry
    // machine config at all (this file's header lists the whole `window.__fabrico`
    // surface). Its survival on this same board is asserted through the shipped panel
    // at the top of this leg, which is the only read path there is.
    //
    // NOTHING IS ASSERTED ABOUT THE DRAWN CABLE'S GEOMETRY. The oracle emits a wire's
    // `tiles` as a COUNT and never the cells or the vertices
    // (`drawWireBetweenPorts`'s own docblock), so this leg proves the COMMAND path
    // plus render health, and says nothing whatever about the shape of the line on
    // screen.
    const composed = await readScene(page);
    const wire = composed.wires.find((w) => w.from.node === caller.id);
    expect(
      {
        routerSeated: nodeAtAnchor(composed, ROUTER_CELL[0], ROUTER_CELL[1])?.id,
        offloadBeltsByRoutingKey: outs.map(
          (_, key) => offloadBeltFor(composed, routerId, key)?.id,
        ),
        feedBeltPresent: composed.belts.some((b) => b.id === feedBeltId),
        wireCount: composed.wires.length,
        wireEnds: wire && { from: wire.from, to: wire.to },
      },
      'ONE board carries all of it at once: leg 1\'s Router and its three keyed offload belts and its feed belt, plus leg 2\'s hand-drawn wire running from the pressed port to the released port',
    ).toEqual({
      routerSeated: routerId,
      offloadBeltsByRoutingKey: offloadBeltIds,
      feedBeltPresent: true,
      wireCount: wiresBefore + 1,
      wireEnds: {
        from: { node: caller.id, port: (callerOut as PortFacts).index },
        to: { node: target.id, port: (targetIn as PortFacts).index },
      },
    });

    board.callerEndpointId = caller.id;
    board.wireTargetId = target.id;
    board.wireId = wire!.id;

    await expectRenderLoopAlive(page, 'after the wire drag');
    errs.assertNone('the whole of leg 2');
  });

  // =========================================================================
  // LEG 3, THE REACHABLE HALF
  // =========================================================================
  //
  // POSITION IS THE POINT. Declaration order is run order under `mode: 'serial'`,
  // and this leg sits where the done-test puts it: after the wire, before the
  // disconnect. It runs on the board legs 1 and 2 built and it hands leg 4 a board
  // that carries a belt OFF the default pace for the first time.
  //
  // WHY THAT MATTERS TO LEG 5 AND NOT ONLY TO THE NARRATIVE ORDER. Measured, in
  // `69-MUTATION-PROOF.md` section D under mutation D2b: before this leg existed,
  // every belt on the walk board held `ticksPerSlot=2`, which is
  // `DEFAULT_TICKS_PER_SLOT` (`crates/fabrico-core/src/belt_slots.rs:202`). Leg 5's
  // "FEATURE 3 of 4" pace comparison was therefore present, guarded, and VACUOUS as
  // a discriminator - a load that reset every belt to the default would have
  // reproduced it exactly. This leg is what makes that assertion able to fail.
  //
  // THE PACE DOES NOT RIDE THE SHARED `Configure` FRAME (this file's header, audit
  // W2). `ConfigPanel.tsx` `commitConfig` early-returns at `config.kind === 'Belt'`
  // and sends `encodeBeltRunPace` instead, which reaches the host through the `0xFE`
  // sentinel route into `apply_run_pace`. This leg exercises THAT seam, so no green
  // from a Configure test is evidence about it.
  //
  // THE HALF OF LEG 3 THAT CANNOT BE WALKED IS NOT SILENTLY DROPPED. It is declared
  // as the LAST test in this file and it fails on purpose. Read the declaration-order
  // rule in the header before moving either half of leg 3.
  test('leg 3 - one belt set slower than its neighbour', async ({ page }) => {
    // NO `bootOnEmptyBoard`, NO `newBoard`, NO `resetToDemo`: this leg runs on the
    // board legs 1 and 2 built.
    const errs = await attachToRunningBoard(page);
    await expectRenderLoopAlive(page, 'on the inherited board, before leg 3 touches it');

    const routerId = required('routerId', 'leg 1');
    const outs = required('outs', 'leg 1');
    const offloadBeltIds = required('offloadBeltIds', 'leg 1');
    const wireId = required('wireId', 'leg 2');

    // Four machines, five runs and a wire wide by now, so this leg works at actual
    // size for the measured reason `resetZoomToActualSize` documents.
    await resetZoomToActualSize(page);

    // -----------------------------------------------------------------------
    // LEGS 1 AND 2 ARE STILL STANDING, asserted FIRST and by name, so a board
    // that lost something fails here rather than deeper inside this leg where
    // the message would be about a pace.
    // -----------------------------------------------------------------------
    const inherited = await readScene(page);
    expect(
      {
        routerSeated: nodeAtAnchor(inherited, ROUTER_CELL[0], ROUTER_CELL[1])?.id,
        offloadBeltsByRoutingKey: outs.map((_, key) => offloadBeltFor(inherited, routerId, key)?.id),
        wirePresent: inherited.wires.some((w) => w.id === wireId),
      },
      "leg 3 opens on the composed board: leg 1's Router with its three keyed offload belts, and leg 2's hand-drawn wire",
    ).toEqual({
      routerSeated: routerId,
      offloadBeltsByRoutingKey: offloadBeltIds,
      wirePresent: true,
    });

    /** One belt's advance interval off the MODEL, the reading BELT-02 is made on. */
    const paceIn = (s: SceneFacts, id: number): number | undefined =>
      s.belts.find((b) => b.id === id)?.ticksPerSlot;

    // THE TWO BELTS ARE NEIGHBOURS IN THE LITERAL SENSE. Leg 1 drew one offload
    // belt per routing key, each running E along its own Out nub's row, so these
    // two runs sit one cell apart on the board a user is looking at.
    const [targetBeltId, neighbourBeltId] = offloadBeltIds;
    const targetBefore = paceIn(inherited, targetBeltId);
    const neighbourBefore = paceIn(inherited, neighbourBeltId);
    expect(targetBefore, `offload belt ${targetBeltId} is on the board and reports a pace`).toBeDefined();
    expect(
      neighbourBefore,
      `offload belt ${neighbourBeltId} is on the board and reports a pace`,
    ).toBeDefined();

    // VACUITY REFUSAL, and it is mandatory rather than tidy. `23-belt-pace.spec.ts`
    // states the reason: without it the poll below resolves on its FIRST read
    // against a host that did nothing at all, and this leg would pass over a dead
    // pace path.
    expect(
      targetBefore,
      `belt ${targetBeltId} must NOT already sit at ${SLOW_END_TICKS} ticks per slot, or the poll below proves nothing`,
    ).not.toBe(SLOW_END_TICKS);
    // And the two start EQUAL, so the difference this leg reads afterwards is a
    // difference this leg MADE, not one the board happened to arrive carrying.
    expect(
      neighbourBefore,
      'the two neighbouring offload belts start at the SAME pace, so any difference below is one this leg made',
    ).toBe(targetBefore);

    /**
     * Select one belt by clicking a tile of it, and settle on the panel's BELT arm.
     *
     * The tile is the one FURTHEST from the Router, resolved off the belt's own
     * `tiles` rather than transcribed: these runs were drawn heading E from their Out
     * nubs, so the largest `cell_x` is the free end, where a click cannot land on a
     * nub or on a machine body. The `#fab-belt-config` wait is `23-belt-pace.spec.ts`'s,
     * and it also proves the real host answered `machine_config` for a BELT handle.
     */
    const selectBelt = async (id: number): Promise<void> => {
      const scene = await readScene(page);
      const belt = scene.belts.find((b) => b.id === id);
      expect(belt, `belt ${id} is in the scene to be selected`).toBeDefined();
      const tile = (belt as SceneFacts['belts'][number]).tiles.reduce((a, b) =>
        b.cell_x > a.cell_x ? b : a,
      );
      const pt = await screenCellCentre(page, tile.cell_x, tile.cell_y);
      await clickAt(page, pt.x, pt.y);
      await expect(
        page.locator('#fab-belt-config'),
        `clicking (${tile.cell_x},${tile.cell_y}) selected belt ${id}, so the panel's Belt arm is open on it`,
      ).toBeVisible({ timeout: 15_000 });
    };

    // -----------------------------------------------------------------------
    // THE PACE PRESS. A shipped segment from the offered scale, then Apply.
    // -----------------------------------------------------------------------
    await selectBelt(targetBeltId);
    // THE SHIPPED PANEL'S OWN SENTENCE, READ RATHER THAN ASSUMED: this belt is a
    // run of ONE. It is the live evidence the last-declared test in this file
    // cites when it says the two belts are not one run.
    await expect(
      page.locator('#fab-belt-run'),
      `belt ${targetBeltId} is a run of ONE, in the panel's own words`,
    ).toHaveText(RUN_SINGLE_COPY);
    await expectRenderLoopAlive(page, 'with the belt selected, before the pace press');

    await page
      .getByRole('group', { name: 'Belt pace' })
      .getByRole('button', { name: `${SLOW_END_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    // POLLED ON THE SPECIFIC MODEL CHANGE, never a sleep.
    await pollScene(page, (s) => paceIn(s, targetBeltId) ?? -1, {
      message: `the pressed pace reached offload belt ${targetBeltId} in the MODEL: ${SLOW_END_TICKS} ticks per slot, off the render packet`,
    }).toBe(SLOW_END_TICKS);

    const paced = await readScene(page);
    // THE NEIGHBOUR IS UNCHANGED. This is the whole claim: the pace is per BELT,
    // not board-wide. A host that paced everything would satisfy the poll above
    // perfectly and fail here.
    expect(
      paceIn(paced, neighbourBeltId),
      `the pace landed on ONE belt: neighbour ${neighbourBeltId} still holds the ${neighbourBefore} ticks per slot it had`,
    ).toBe(neighbourBefore);
    // And so is EVERY other belt on the composed board, including leg 1's feed
    // belt and its third offload belt. Named as a whole so a pace that leaked
    // onto a run this leg never mentions cannot hide behind the neighbour.
    const others = (s: SceneFacts) =>
      s.belts
        .filter((b) => b.id !== targetBeltId)
        .map((b) => `belt#${b.id} ticksPerSlot=${b.ticksPerSlot}`)
        .sort();
    expect(
      others(paced),
      'every OTHER belt on the composed board holds the pace it held before the press',
    ).toEqual(others(inherited));

    // -----------------------------------------------------------------------
    // THE NEIGHBOUR, THROUGH THE SAME PANEL. It is a run of one too, which is
    // the second half of the reading the last-declared test cites.
    // -----------------------------------------------------------------------
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await selectBelt(neighbourBeltId);
    await expect(
      page.locator('#fab-belt-run'),
      `belt ${neighbourBeltId} is a run of ONE as well, so the two paced belts are two runs and not one`,
    ).toHaveText(RUN_SINGLE_COPY);
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    // -----------------------------------------------------------------------
    // Hand the measured figures to the last-declared test, which reads them and
    // touches nothing.
    // -----------------------------------------------------------------------
    board.pacedBeltId = targetBeltId;
    board.pacedBeltTicks = paceIn(paced, targetBeltId);
    board.neighbourBeltId = neighbourBeltId;
    board.neighbourBeltTicks = paceIn(paced, neighbourBeltId);

    await expectRenderLoopAlive(page, 'after the per-belt pace change');
    errs.assertNone('the whole of leg 3 (the reachable half)');
  });

  // =========================================================================
  // LEG 4
  // =========================================================================
  //
  // WHAT THIS LEG PROVES THAT NOTHING ELSE IN THE LIVE SUITE DOES. The panel
  // `Disconnect` control (CONNECT-01) has never been exercised against the real
  // host. Its only proof anywhere is `frontend/e2e/panel-disconnect.spec.ts:223-246`,
  // in the MOCK suite, against an injected packet, and what that spec asserts is the
  // DECODED FRAME the click emits. Live there is no frame to decode - the oracle
  // reads the model - so this leg makes the claim on the MODEL instead: the specific
  // dock entry disappears from `SceneFacts.belts[].docks` and then comes back. The
  // mock assertion is not substituted for and is not weakened; it is a different
  // claim on a different surface, and both are wanted.
  //
  // WHY THIS LEG NEVER TOUCHES THE STRANDED-DOCK ALERT RING, said here rather than
  // left to be inferred from an absence. `22-stranded-reconnect.spec.ts` severs its
  // dock with a ROTATE and gates its reconnect press on the ring's live paint state.
  // That is exactly the path WINDOWS row 141 sits on: no stranded alert ring is
  // painted on the real binary after a rotate-severed dock, which is why CONNECT-02
  // is still Pending. Decision D-69-03 routes the walk OFF that path deliberately,
  // so nothing row 141 records can contaminate this leg's reading in either
  // direction. A GREEN HERE IS NOT EVIDENCE ABOUT WINDOWS 141, AND A RED HERE WOULD
  // NOT BE EITHER. This leg severs the dock through the shipped panel control and
  // re-docks with the ORDINARY belt-end-handle drag, and neither gesture involves a
  // ring at any point.
  test('leg 4 - a machine is disconnected from the panel and reconnected without reloading', async ({
    page,
  }) => {
    // NO `bootOnEmptyBoard`, NO `newBoard`, NO `resetToDemo`: this leg runs on the
    // board legs 1 and 2 built.
    const errs = await attachToRunningBoard(page);
    await expectRenderLoopAlive(page, 'on the inherited board, before leg 4 touches it');

    const routerId = required('routerId', 'leg 1');
    const sourceId = required('sourceId', 'leg 1');
    const outs = required('outs', 'leg 1');
    const feedBeltId = required('feedBeltId', 'leg 1');
    const offloadBeltIds = required('offloadBeltIds', 'leg 1');
    const wireId = required('wireId', 'leg 2');
    const callerEndpointId = required('callerEndpointId', 'leg 2');
    const [defaultOut, ruleOneOut, ruleTwoOut] = outs;

    // The board is four machines and five runs wide now. At the fit-to-content
    // scale that puts the Router's nubs under the right-edge panel overlay, so the
    // leg works at actual size for the same measured reason leg 2 does.
    await resetZoomToActualSize(page);

    // -----------------------------------------------------------------------
    // LEGS 1 AND 2 ARE STILL STANDING. One scene read, asserted FIRST and by
    // name, so a board that lost something fails here rather than deeper inside
    // this leg where the message would be about a Disconnect.
    // -----------------------------------------------------------------------
    const inherited = await readScene(page);
    const tickAtLegStart = inherited.tick;
    const router = nodeAtAnchor(inherited, ROUTER_CELL[0], ROUTER_CELL[1]);
    expect(
      {
        routerSeated: router?.id,
        feedBeltDocks: dockStrings(inherited.belts.find((b) => b.id === feedBeltId)),
        offloadBeltsByRoutingKey: outs.map((_, key) => offloadBeltFor(inherited, routerId, key)?.id),
        wireEnds: inherited.wires.find((w) => w.id === wireId)?.from.node,
      },
      "leg 4 opens on the composed board: leg 1's Router, its feed belt docked at BOTH ends, " +
        "its three keyed offload belts, and leg 2's hand-drawn wire",
    ).toEqual({
      routerSeated: routerId,
      feedBeltDocks: [`Head@${routerId}:0`, `Tail@${sourceId}:0`],
      offloadBeltsByRoutingKey: offloadBeltIds,
      wireEnds: callerEndpointId,
    });

    // THE SUBJECT IS THE MACHINE WHOSE PORT CARRIES LEG 1'S FEED BELT DOCK - the
    // Router's In port, docked by the belt this walk drew, not by a demo artefact.
    // The In port is resolved off the settled node rather than by ordinal, exactly
    // as leg 1 resolves the Out nubs and for the same reason.
    const settledRouter = router as SceneFacts['nodes'][number];
    const inPorts = settledRouter.ports.filter((p) => p.role === ROLE.IN);
    expect(
      inPorts,
      'the Router declares exactly ONE In port, so the feed belt Head dock names routing key 0',
    ).toHaveLength(1);
    const inPort = inPorts[0];
    /** The feed belt Head dock, named by NODE and PORT and never by a count.
     *  `DockFacts.port` is the ROUTING KEY (the port's 0-based position among its
     *  role's ports), and the Router has one In, so the key is 0. */
    const FEED_HEAD_DOCK = `Head@${routerId}:0`;

    // The paces every belt holds right now, so the disconnect can be shown not to
    // have moved any of them. Captured before the click rather than asserted
    // against a literal: leg 3 sets one belt slower than its neighbour and is
    // inserted AHEAD of this leg by plan 06, so a literal here would go stale.
    const pacesBefore = new Map(inherited.belts.map((b) => [b.id, b.ticksPerSlot]));

    // -----------------------------------------------------------------------
    // THE DISCONNECT. One click of the shipped panel control.
    // -----------------------------------------------------------------------
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    const portsRegion = page.getByRole('region', { name: 'Ports' });
    await expect(
      portsRegion,
      "the Router's panel carries the Ports region the Disconnect control lives in",
    ).toBeVisible();

    // THE ROW REALLY READS AS DOCKED, ASSERTED BEFORE THE CONTROL IS TOUCHED. The
    // mock analog does this deliberately and the reason carries over verbatim:
    // without it, the control's presence below would be proving something about a
    // row in the wrong state. `not connected` cannot match this pattern.
    await expect(
      portsRegion.getByRole('listitem', { name: DOCKED_IN_ROW }),
      `the Router's In row reads as DOCKED before the Disconnect click (the feed belt is on it)`,
    ).toHaveCount(1);

    const disconnect = portsRegion.getByRole('button', { name: DISCONNECT_CONTROL_NAME });
    await expect(
      disconnect,
      `the panel offers "${DISCONNECT_CONTROL_NAME}" on the docked In row, enabled`,
    ).toBeEnabled();
    await disconnect.click();

    // THE CLAIM IS MADE ON THE MODEL, NAMING THE SPECIFIC ENTRY. Not a dock COUNT
    // across the board: a count would be satisfied by an Unlink that took the wrong
    // link down, which is the failure this poll exists to catch.
    await pollScene(
      page,
      (s) => dockStrings(s.belts.find((b) => b.id === feedBeltId)).includes(FEED_HEAD_DOCK),
      {
        message: `one click of the panel Disconnect removed the feed belt dock ${FEED_HEAD_DOCK} (the Router In port the feed belt delivered into)`,
      },
    ).toBe(false);

    const severed = await readScene(page);
    expect(
      dockStrings(severed.belts.find((b) => b.id === feedBeltId)),
      `the Unlink addressed ONE end: the feed belt still holds its Tail dock on the Source, and only its Head dock on the Router went`,
    ).toEqual([`Tail@${sourceId}:0`]);

    // -----------------------------------------------------------------------
    // NOTHING ELSE ON THE BOARD MOVED. An Unlink that took the wire down with
    // it, or that disturbed an offload belt, would otherwise pass unnoticed.
    // -----------------------------------------------------------------------
    const severedWire = severed.wires.find((w) => w.id === wireId);
    expect(
      {
        wirePresent: severedWire !== undefined,
        wireEnds: severedWire && { from: severedWire.from, to: severedWire.to },
        offloadBeltsByRoutingKey: outs.map((_, key) => offloadBeltFor(severed, routerId, key)?.id),
        paces: severed.belts.map((b) => `${b.id}:${b.ticksPerSlot}`).sort(),
      },
      "the disconnect touched ONE link: leg 2's wire is still present and still linked to the same two ports, leg 1's three offload belts are still on their routing keys, and every belt still holds the pace it held",
    ).toEqual({
      wirePresent: true,
      wireEnds: {
        from: inherited.wires.find((w) => w.id === wireId)?.from,
        to: inherited.wires.find((w) => w.id === wireId)?.to,
      },
      offloadBeltsByRoutingKey: offloadBeltIds,
      paces: [...pacesBefore.entries()].map(([id, pace]) => `${id}:${pace}`).sort(),
    });

    // The TABLE survived too. Read through a RE-OPENED panel, because a table read
    // from the panel that is still mounted from the Disconnect click could be its
    // local buffer rather than the host's committed config; unmounting and
    // re-selecting forces the `machine_config` round trip.
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    await selectMachineAt(page, ROUTER_CELL[0], ROUTER_CELL[1]);
    expect(
      await readRouterTable(page),
      "leg 1's routing table is untouched by the Disconnect: an Unlink removes a LINK, never a rule",
    ).toEqual({
      rules: [
        { target: outputLabel(outs, ruleOneOut), expect: RULE_ONE.expect, offset: String(RULE_ONE.offset) },
        { target: outputLabel(outs, ruleTwoOut), expect: RULE_TWO.expect, offset: String(RULE_TWO.offset) },
      ],
      fallback: outputLabel(outs, defaultOut),
    });
    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);

    await expectRenderLoopAlive(page, 'after the panel Disconnect');
    errs.assertNone('after the panel Disconnect');

    // -----------------------------------------------------------------------
    // THE RECONNECT, WITHOUT RELOADING ANYTHING. The ordinary belt-end-handle
    // drag from `22-stranded-reconnect.spec.ts:166-180` - select the belt by
    // clicking a tile, press its END handle, release on the port nub.
    // -----------------------------------------------------------------------
    const strandedFeed = severed.belts.find((b) => b.id === feedBeltId) as SceneFacts['belts'][number];
    const feedTiles = strandedFeed.tiles;
    // THE END TILE IS RESOLVED FROM THE PORT, NEVER BY ORDINAL. `port cell +
    // unit_delta(side)` is the one cell a dock can occupy, so this asks the live
    // model which of the belt's tiles the In nub can legally reach - the same
    // discipline 22 applies, and it does not encode this run's geometry.
    const [inFaceX, inFaceY] = facingCell(inPort);
    const endTile = feedTiles.find((t) => t.cell_x === inFaceX && t.cell_y === inFaceY);
    expect(
      endTile,
      `the feed belt still runs up to the cell the Router In nub faces (${inFaceX},${inFaceY}), so its end handle is reachable`,
    ).toBeDefined();
    const selectTile = feedTiles.find((t) => t !== endTile) ?? (endTile as (typeof feedTiles)[number]);

    await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
    const selectPt = await screenCellCentre(page, selectTile.cell_x, selectTile.cell_y);
    await clickAt(page, selectPt.x, selectPt.y);
    await expect(
      page.locator('#fab-belt-config'),
      'clicking a tile SELECTED the feed belt, so its end handles are live to press',
    ).toBeVisible({ timeout: 10_000 });

    const endPt = await screenCellCentre(
      page,
      (endTile as (typeof feedTiles)[number]).cell_x,
      (endTile as (typeof feedTiles)[number]).cell_y,
    );
    const inNubPt = await screenPoint(page, nubAnchor(inPort.cell_x, inPort.cell_y, inPort.side));
    await page.mouse.move(endPt.x, endPt.y);
    await page.mouse.down();
    await page.mouse.move(inNubPt.x, inNubPt.y, { steps: 4 });
    await page.mouse.up();

    // THE SAME ENTRY, BY NAME, RETURNS.
    await pollScene(
      page,
      (s) => dockStrings(s.belts.find((b) => b.id === feedBeltId)).includes(FEED_HEAD_DOCK),
      {
        message: `the belt-end-handle drag re-docked the feed belt: ${FEED_HEAD_DOCK} is back on the board, with no reload in between`,
      },
    ).toBe(true);

    const reconnected = await readScene(page);
    expect(
      dockStrings(reconnected.belts.find((b) => b.id === feedBeltId)),
      'the reconnected feed belt holds BOTH docks again, on the same node and the same ports it started with',
    ).toEqual([FEED_HEAD_DOCK, `Tail@${sourceId}:0`]);

    // NO RELOAD HAPPENED, ASSERTED RATHER THAN ASSUMED. A repopulating load
    // re-seeds the loop tick from the loaded core, so the tick RESTARTS low
    // (`09-save-load-status.spec.ts:96-103` measures exactly that edge). A tick
    // that only ever climbed across this leg is a scene that was never reloaded.
    expect(
      severed.tick,
      'the sim tick climbed across the disconnect (no repopulating keyframe re-seeded it)',
    ).toBeGreaterThan(tickAtLegStart);
    expect(
      reconnected.tick,
      'the sim tick climbed across the reconnect too: the machine was disconnected and reconnected WITHOUT reloading the scene',
    ).toBeGreaterThan(severed.tick);

    await page.keyboard.press('Escape');
    await expectRenderLoopAlive(page, 'after the belt-end-handle reconnect');
    errs.assertNone('the whole of leg 4');
  });

  // =========================================================================
  // LEG 5
  // =========================================================================
  //
  // Declared after leg 4 and LAST among the legs that walk the board. Plan 06
  // appends leg 3's deliberate throw behind it; nothing that runs the board is
  // ever declared after this leg.
  test('leg 5 - saving and loading this board reproduces its topology', async ({ page }) => {
    // =======================================================================
    // WHAT THIS LEG PROVES, AND WHAT IT EXPLICITLY DOES NOT.
    // =======================================================================
    // The milestone done-test's last sentence is "saving, loading and replaying
    // that board reproduces it BYTE-IDENTICALLY". THIS LEG CANNOT PROVE THAT AND
    // DOES NOT CLAIM TO. The live oracle is `window.__fabrico`, and its whole
    // surface is `scene / stats / frameTime / frame / camera / alertRingsActive /
    // pinClock / setItemInterpolation / webhookUrl` - there is no hash, no
    // snapshot bytes and no serialized-state getter anywhere on it. A live spec
    // therefore has no access to a single byte of the saved file, and one written
    // as though it did would be this project's signature defect: a check that
    // cannot fail.
    //
    // So the claim made here is TOPOLOGY EQUALITY: the board is saved to a real
    // `.fab` file on disk, loaded back through the app's own Load verb, and the
    // normalized projection above is asserted equal across the round trip.
    //
    // THE BYTE-IDENTITY CLAIM IS DISCHARGED ELSEWHERE, by
    // `crates/fabrico-command/tests/composition_save_load.rs`, named by path so
    // that no reader mistakes this leg's green for that file's claim and no
    // reader concludes the byte claim is unproven because this leg does not make
    // it. Two different claims, two different surfaces, both wanted.
    //
    // NOT A NODE COUNT. `09-save-load-status.spec.ts:187-189` settles its round
    // trip on `nodes.length > 0`, which is exactly the weakness this leg exists
    // to fix: a load that dropped every rule, every wire, every pace and every
    // dock while restoring the machines would satisfy it perfectly.
    const errs = await attachToRunningBoard(page);
    await expectRenderLoopAlive(page, 'on the inherited board, before leg 5 saves it');

    const routerId = required('routerId', 'leg 1');
    const feedBeltId = required('feedBeltId', 'leg 1');
    const offloadBeltIds = required('offloadBeltIds', 'leg 1');
    const wireId = required('wireId', 'leg 2');
    await resetZoomToActualSize(page);

    // -----------------------------------------------------------------------
    // The projection, held across the round trip.
    // -----------------------------------------------------------------------
    const before = await readTopology(page);

    // THE PROJECTION IS NON-VACUOUS, ASSERTED BEFORE ANYTHING IS SAVED. Two empty
    // projections compare equal, so without this line a load that restored an
    // empty board onto a board this leg had failed to inherit would read as a
    // clean round trip. Every one of the four composed features is counted here.
    expect(
      {
        nodes: before.nodes.length,
        belts: before.beltPaces.length,
        wires: before.wires.length,
        rules: before.routerTable.rules.length,
      },
      'the board about to be round-tripped really carries all four composed features: leg 1\'s Router + Source + its feed belt and three offload belts, leg 2\'s two Endpoints and the wire between them, and the two rules leg 1 typed',
    ).toEqual({ nodes: 4, belts: 4, wires: 1, rules: 2 });
    expect(
      before.docks.join(' '),
      'the held projection names the feed belt Head dock on the Router, so a load that dropped it cannot pass unnoticed',
    ).toContain(`Head@${routerId}:0`);
    expect(
      before.wires.join(' '),
      `the held projection names leg 2's hand-drawn wire ${wireId}`,
    ).toContain(`wire#${wireId} `);
    expect(
      offloadBeltIds.every((id) => before.beltPaces.some((p) => p.startsWith(`belt#${id} `))),
      "the held projection carries a pace for every one of leg 1's offload belts",
    ).toBe(true);

    // -----------------------------------------------------------------------
    // SAVE. The measured SAVE-03 branch is asserted, not accepted either way.
    // -----------------------------------------------------------------------
    // T-69-14: the path is minted per run, so no run can reuse another run's
    // artefact and a stale file cannot masquerade as a fresh save.
    const roundTripPath = join(tmpdir(), `fabrico-69-walk-${Date.now()}.fab`);

    // THE MEASURED BRANCH. `69-LIVE-MEASUREMENT.md` section 2 drove Save on a
    // hand-built empty-start board and read `dialogFired=true dialogType="prompt"
    // dialogMessage="Save factory to path (.fab):" statusText="Save requested"`.
    // That is SAVE-03's no-known-path arm: smart-Save re-saves with no dialog only
    // AFTER a path is known, and this board has never been saved. The dialog is
    // RECORDED and then asserted rather than merely handled, because a build that
    // silently stopped prompting would still let a bare `page.once('dialog', ...)`
    // handler go green while the file was written somewhere nobody named.
    let saveDialog: { type: string; message: string } | undefined;
    page.once('dialog', (d) => {
      saveDialog = { type: d.type(), message: d.message() };
      return d.accept(roundTripPath);
    });
    await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
    await pollStatusText(
      page,
      'the Save settles at the shipped HONEST ceiling "Save requested" - the host sends no write-result echo, so the readout never claims "Saved" and this leg must never assert it',
    ).toBe('Save requested');
    expect(
      saveDialog,
      'Save took the MEASURED SAVE-03 branch: a hand-built board with no known path PROMPTS for one (69-LIVE-MEASUREMENT.md section 2)',
    ).toEqual({ type: 'prompt', message: 'Save factory to path (.fab):' });

    // The artefact is on disk, read through the Node filesystem: honest proof the
    // HOST persisted it rather than a frontend claim.
    await expect
      .poll(() => existsSync(roundTripPath), {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: `the host wrote the real .fab project file at ${roundTripPath}`,
      })
      .toBe(true);

    // -----------------------------------------------------------------------
    // LOAD IT BACK.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // WIPE THE BOARD TO EMPTY FIRST. THIS IS THE LEG'S DISCRIMINATOR.
    // -----------------------------------------------------------------------
    // Without it the round trip below is VACUOUS. `after === before` is satisfied
    // for the trivial reason by a host that never read the file at all and merely
    // re-broadcast the live core it was already holding, and the `4/4/1` shape
    // poll after the Load is ALREADY TRUE before the Load, so on its own it can
    // only fail if the Load made things worse, never if it did nothing.
    //
    // `newBoard` is the shipped New control (SAVE-05 discard guard included) and
    // it POLLS the board to genuinely empty, so the state the Load has to
    // repopulate from is measured and not assumed. Every node, belt, wire, dock,
    // pace and routing rule below therefore came back FROM THE FILE.
    //
    // NOT the tick re-seed the review proposed. `09-save-load-status.spec.ts:99`
    // polls `s.tick < tickBefore`, but that spec dispatches the LoadDemo proxy,
    // not a file Load. MEASURED on this seam 2026-08-31: across a real .fab Load
    // the tick climbs straight through and never drops
    // (tickBeforeLoad=1587, then 1593,1606,1618 ... 1893 over the following five
    // seconds), so that predicate is simply false here and asserting it would
    // redden a working leg.
    await newBoard(page);
    await pollScene(page, (s) => `${s.nodes.length}/${s.belts.length}/${s.wires.length}`, {
      message:
        'the board really is EMPTY before the Load, so the topology comparison below cannot be satisfied by a host that never read the file',
    }).toBe('0/0/0');
    // RECORDED AND THEN ASSERTED, for the reason the Save block above already gives
    // in as many words. A bare `page.once('dialog', ...)` here is the exact handler
    // that block rejects: if the Load path ever stops prompting, or raises a
    // discard-guard dialog that consumes the `once` before the path prompt, the
    // handler never fires for the prompt this leg means, the listener stays ARMED,
    // and the next dialog in the leg (including one from `loadDemoViaExamples`
    // below) is silently auto-accepted with this path.
    let loadDialog: { type: string; message: string } | undefined;
    page.once('dialog', (d) => {
      loadDialog = { type: d.type(), message: d.message() };
      return d.accept(roundTripPath);
    });
    await page.getByTitle('Load a saved factory').click();
    await pollStatusText(
      page,
      'the Load resolves to "Loaded" on the first repopulating full keyframe after dispatch',
    ).toBe('Loaded');
    await pollScene(
      page,
      (s) => `${s.nodes.length}/${s.belts.length}/${s.wires.length}`,
      {
        message:
          'the Load REPOPULATED the walk board from the file onto the emptied board: 4 machines, 4 belts, 1 wire. The board was polled to 0/0/0 immediately above, so this can only be satisfied by a Load that actually read the artefact',
      },
    ).toBe('4/4/1');
    expect(
      loadDialog,
      'Load PROMPTED for a path (`controlHandlers.ts:274` always prompts on the non-Tauri dev path), so the file this leg named is the file that was read, and the `once` handler is spent rather than left armed for a later dialog',
    ).toEqual({ type: 'prompt', message: 'Load factory from path (.fab):' });
    await ensurePlaying(page);
    await waitForCameraSettle(page);
    await resetZoomToActualSize(page);
    await expectRenderLoopAlive(page, 'after the load repopulated the board');

    // -----------------------------------------------------------------------
    // THE COMPARISON. Each feature named, then all of them at once.
    // -----------------------------------------------------------------------
    const after = await readTopology(page);

    // The four named sub-assertions come FIRST so a failure says WHICH feature
    // did not come back, instead of dumping two large objects.
    expect(
      after.routerTable,
      'FEATURE 1 of 4 - the Router ROUTING TABLE came back: both rules in entry order with their targets and offsets, and the same default. `SceneFacts` carries no machine config, so this half is read through the shipped panel on both sides of the round trip',
    ).toEqual(before.routerTable);
    expect(
      after.wires,
      "FEATURE 2 of 4 - the HAND-DRAWN WIRE came back with the same endpoints (same node and same port at each end)",
    ).toEqual(before.wires);
    expect(
      after.beltPaces,
      'FEATURE 3 of 4 - every belt came back holding the PACE it was saved with (`ticksPerSlot`, the model reading of BELT-02)',
    ).toEqual(before.beltPaces);
    expect(
      after.docks,
      'FEATURE 4 of 4 - every DOCK came back, each naming the same belt end, node and port - including the feed belt Head dock leg 4 disconnected and re-docked',
    ).toEqual(before.docks);

    // AND THE WHOLE PROJECTION IN ONE COMPARISON. The four expects above are the
    // diagnosis; this one is the claim. Asserted as a whole so that a feature the
    // named assertions do not cover - a machine's kind, its anchor, its port list,
    // a belt's routed path - cannot go missing inside a passing neighbour.
    expect(
      after,
      'THE ROUND TRIP REPRODUCED THE BOARD\'S TOPOLOGY: every machine with its kind, anchor and declared ports; every belt with its path, its pace and its docks; the wire with its endpoints; and the routing table. This is TOPOLOGY equality and not byte-identity - the byte claim is `crates/fabrico-command/tests/composition_save_load.rs`',
    ).toEqual(before);
    expect(
      after.beltPaths.some((p) => p.startsWith(`belt#${feedBeltId} `)),
      'the feed belt is still identified by the same handle after the round trip, which is the comparison key 69-LIVE-MEASUREMENT.md section 1 measured as IDENTICAL',
    ).toBe(true);

    await expectRenderLoopAlive(page, 'after the topology comparison');
    errs.assertNone('the whole of leg 5');

    // -----------------------------------------------------------------------
    // RESTORE THE SHARED HOST. The live suite runs `workers: 1` against ONE
    // mutable host; this is `09-save-load-status.spec.ts:260-266`'s block, so a
    // spec that later sorts after this file does not inherit the walk's board.
    // -----------------------------------------------------------------------
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
      message: 'the shared host is restored to the demo baseline after the walk',
    }).toBe(true);
  });

  // =========================================================================
  // LEG 3, THE HALF THAT USED TO BE UNWALKABLE. NOW WALKED, STILL DECLARED LAST.
  // =========================================================================
  //
  // WHAT USED TO BE HERE, AND WHY IT IS GONE. Until plan 74-09 this position held an
  // unconditional `throw`: done-test leg 3's backlog half was NOT walkable on the
  // shipped build, and it was decided on 2026-08-31 that a documented red
  // was worth more than a passing test asserting unreachability, "because the latter
  // is a check that can only fail on a fix". That throw named three blockers, and
  // phase 74 retired all three:
  //
  //   1. A belt-to-belt `Dock` was refused: a belt declared no ports, so the only
  //      junction two runs could meet at was a MACHINE (WINDOWS 138). Plan 74-02 made
  //      a belt a PORTED node - Tail `Role::In` at catalog 0, Head `Role::Out` at
  //      catalog 1 - and the certified command path now accepts the Dock (LINK-01).
  //   2. No shipped gesture linked two belts (WINDOWS 140). Plan 74-05 shipped two:
  //      the end-handle drag (LINK-02) and the press-on-a-free-end draw (LINK-10).
  //      Both are walked on the real host by `e2e-live/74-belt-run-joins.spec.ts`.
  //   3. The machine inbox was unbounded, so a belt feeding a jammed machine drained
  //      into an invisible queue instead of bunching. Phase 71 paid that one before
  //      this phase started: `admit::MECHANICAL_INBOX_CAP = 16`, walked live by
  //      `e2e-live/25-backpressure-cascade.spec.ts`.
  //
  // The deletion was approved explicitly in plan 74-09 BEFORE it was taken, with
  // this leg's own live result as its evidence; the answer was `delete-it`.
  //
  // -------------------------------------------------------------------------
  // WHY IT IS STILL DECLARED LAST, AND WHY IT BUILDS ITS OWN BOARD.
  // -------------------------------------------------------------------------
  // Leg 5 RESTORES the shared host to the demo baseline when it finishes (the
  // `09-save-load-status.spec.ts` block at the end of it), so the composed board is
  // already gone by the time anything declared after leg 5 runs. And leg 5 hard-pins
  // the composed board at `{nodes: 4, belts: 4, wires: 1, rules: 2}`, so a leg
  // inserted ABOVE it that placed one more machine would redden leg 5 on a count that
  // has nothing to do with this claim.
  //
  // So this leg builds the smallest board that can carry the claim, exactly as the
  // declaration it replaces touched no board at all. The composition claim of legs 1
  // to 5 is untouched by that: they still run in order on ONE board, and nothing here
  // runs before any of them.
  //
  // -------------------------------------------------------------------------
  // THE TRAP THIS LEG IS WRITTEN AGAINST, AND THE ORDER THAT DEFEATS IT.
  // -------------------------------------------------------------------------
  // `crates/fabrico-core/src/tick.rs:1586` documents THREE downstream cases, and two
  // of them look identical from outside: a belt whose downstream tail is FULL retains
  // its head, and a belt with NO DOWNSTREAM LINK AT ALL retains its head too. So an
  // upstream belt whose join silently failed piles up with exactly the signature of
  // one that is correctly backpressured, and a leg that read only the pile-up would
  // pass on a board where nothing joined.
  //
  // The steps below therefore run in a fixed order and it must not be rearranged for
  // convenience:
  //
  //   1. build the two belts and JOIN them with a shipped gesture;
  //   2. assert the junction EXISTS IN THE MODEL - both belts' `docks` naming each
  //      other - BEFORE any count or timing is polled;
  //   3. drive items in and assert the downstream is saturated by EXACT EQUALITY
  //      against its own capacity, while the upstream is non-decreasing;
  //   4. press Disconnect and assert the downstream DRAINS while the upstream stays
  //      packed.
  //
  // Step 4 is what a dangling head cannot fake. A belt that was never joined has no
  // junction to disconnect and no downstream to drain, so a build where the join
  // silently failed cannot reach the end of this leg however its counts happen to
  // read.
  //
  // -------------------------------------------------------------------------
  // WHAT KEEPS IT FROM BEING A CHECK THAT CANNOT FAIL (both mutations run).
  // -------------------------------------------------------------------------
  // Recorded in `74-09-SUMMARY.md`, run 2026-09-08:
  //
  //   * Dropping the `'ports+belt-ends'` scan from the dock-drag ranker in
  //     `frontend/src/input/gestures.ts` makes the join silently fail with no command
  //     and no refusal. This leg reddens at step 2, BEFORE any count is read.
  //   * Replacing the `belt-seam` branch of `rebuildEnds` in
  //     `frontend/src/render/layers/belts.ts` with a bare `continue` leaves every
  //     `docks` assertion green and reddens the collar delta alone.
  //
  // RENDER HEALTH, as everywhere else in this file: the live oracle reads only the
  // MODEL, so a board that jams perfectly behind a dead renderer satisfies every
  // count assertion here.

  /** A belt slot per quarter tile: `crates/fabrico-core/src/belt_slots.rs:127`
   *  (`SLOTS_PER_TILE = 4`). Transcribed rather than imported - this suite is
   *  structurally zero-product-import - so `tiles.length * SLOTS_PER_TILE` below is a
   *  DERIVED capacity and never a hand-pinned 8 that would stop meaning "full" the
   *  moment the run's length changed. */
  const SLOTS_PER_TILE = 4;

  /** The board this leg builds, west to east on row 6:
   *
   *    Source(4,6) -> belt UP (5,6)(6,6)(7,6) | belt DOWN (8,6)(9,6) -> Sink(10,6)
   *
   *  UP is THREE tiles (12 slots) and DOWN is TWO (8 slots), so the downstream fills
   *  first and the upstream has room to visibly back up behind it. The Sink is what
   *  makes step 4 possible at all: a downstream belt with a DANGLING head retains its
   *  head forever (`tick.rs:1586`) and would never drain, so "it drained" would be
   *  unprovable on a board without somewhere for the items to go. */
  const JAM_SOURCE_CELL = [4, 6] as const;
  const JAM_UP_CELLS = [
    [5, 6],
    [6, 6],
    [7, 6],
  ] as const;
  const JAM_DOWN_CELLS = [
    [8, 6],
    [9, 6],
  ] as const;
  const JAM_SINK_CELL = [10, 6] as const;
  /** UP's HEAD end tile, where its grab handle sits while the end is free. */
  const JAM_UP_HEAD: readonly [number, number] = [7, 6];
  /** DOWN's TAIL end tile: the drop target of the join drag. */
  const JAM_DOWN_TAIL: readonly [number, number] = [8, 6];
  /** A tile of each belt away from the seam, for click-to-select. */
  const JAM_UP_TILE: readonly [number, number] = [6, 6];
  const JAM_DOWN_TILE: readonly [number, number] = [9, 6];
  /** Empty floor on this board, for the deselect click. */
  const JAM_EMPTY_CELL = [4, 9] as const;

  /** The panel's sentence for a joined run of two, verbatim from
   *  `frontend/src/chrome/BeltConfigBody.tsx:143` (`runPlural`). Pinned by exact
   *  equality for the reason `RUN_SINGLE_COPY` is: a phase-67 mutation dropped a
   *  trailing word and stayed green under a `toContain` pin. */
  const RUN_TWO_COPY = 'This run is 2 belts. Apply sets the pace on all of them.';

  /** The composed accessible name of the Disconnect control on a belt's INPUTS row
   *  (74-07). It is the control LINK-06's shipped refusal sentence names. */
  const DISCONNECT_INPUT = 'Disconnect Input - Item';

  /** The same control on the OUTPUTS row: the downstream belt's Head link to the Sink.
   *  Named so the press below is provably on the junction row and not on this one. */
  const DISCONNECT_OUTPUT = 'Disconnect Output - Item';

  /** The Source Timer interval, in sim ticks, that keeps the upstream supplied. */
  const JAM_TIMER_TICKS = '2';

  /** How many CONSECUTIVE reads must carry the saturated shape before it is believed. */
  const JAM_SUSTAINED_READS = 3;

  /** One belt off the model, found by a cell its path occupies. Resolved BY CELL and
   *  never by a remembered handle, so nothing here depends on handle stability. */
  const jamBeltAt = (
    scene: SceneFacts,
    cell: readonly [number, number],
  ): SceneFacts['belts'][number] | undefined =>
    scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));

  /** How many of `belt`'s docks name `otherId` at `end`. A COUNT, so zero is assertable. */
  const jamDocksNaming = (
    belt: SceneFacts['belts'][number] | undefined,
    end: 'Head' | 'Tail',
    otherId: number,
  ): number => (belt?.docks ?? []).filter((d) => d.end === end && d.node === otherId).length;

  /**
   * THE JUNCTION, read from BOTH SIDES. `"1/1"` when the two belts name each other,
   * `"0/0"` when neither does, and a mixed string when only one half is present - so a
   * half-made or half-removed link can never read as either state.
   */
  const jamJunction = (scene: SceneFacts): string => {
    const up = jamBeltAt(scene, JAM_UP_HEAD);
    const down = jamBeltAt(scene, JAM_DOWN_TAIL);
    if (!up || !down || up.id === down.id) return 'MISSING';
    return `${jamDocksNaming(up, 'Head', down.id)}/${jamDocksNaming(down, 'Tail', up.id)}`;
  };

  /** Select the belt covering `cell` and settle on its config body mounting. Its
   *  visibility also proves the host answered `machine_config` for a BELT handle. */
  const selectJamBelt = async (page: Page, cell: readonly [number, number]): Promise<void> => {
    const at = await screenCellCentre(page, cell[0], cell[1]);
    await clickAt(page, at.x, at.y);
    await expect(
      page.locator('#fab-belt-config'),
      `clicking (${cell[0]},${cell[1]}) selected a belt, so the panel's Belt arm is open on it`,
    ).toBeVisible({ timeout: 15_000 });
  };

  test('leg 3 completed last: two belt runs joined by a gesture back up at the junction and drain on Disconnect', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await ensurePlaying(page);

    // -----------------------------------------------------------------------
    // 0. THE SMALLEST BOARD THAT CAN CARRY THE CLAIM.
    // -----------------------------------------------------------------------
    await newBoard(page);
    await armAndPlaceAt(page, 'Source', JAM_SOURCE_CELL[0], JAM_SOURCE_CELL[1]);
    await armAndPlaceAt(page, 'Sink', JAM_SINK_CELL[0], JAM_SINK_CELL[1]);
    await pollScene(page, (s) => s.nodes.length, {
      message: 'the Source and the Sink echoed onto an otherwise empty board',
    }).toBe(2);
    // The board is two 1x1 machines wide, so the fit-to-content camera is hard zoomed
    // in; every cell below is addressed at actual size for leg 2's measured reason.
    await resetZoomToActualSize(page);

    const placed = await readScene(page);
    const source = nodeAtAnchor(placed, JAM_SOURCE_CELL[0], JAM_SOURCE_CELL[1]) as SceneFacts['nodes'][number];
    const sink = nodeAtAnchor(placed, JAM_SINK_CELL[0], JAM_SINK_CELL[1]) as SceneFacts['nodes'][number];
    expect(source, 'the Source is seated where this leg placed it').toBeDefined();
    expect(sink, 'the Sink is seated where this leg placed it').toBeDefined();
    const sinkIn = sink.ports.find((p) => p.role === ROLE.IN) as PortFacts;
    expect(sinkIn, 'the placed Sink exposes an In port for a belt head to dock').toBeDefined();

    // DRAW ORDER IS LOAD-BEARING SINCE PHASE 74.1: DOWN FIRST, THEN UP. With the Belt
    // tool armed, the empty tile in front of a free belt HEAD is that head's doorstep and
    // a press there starts a CONNECTED draw (UI-SPEC 3.2 item 4). Drawn UP first, UP's
    // head (7,6) faces (8,6), so DOWN's press would land on UP's doorstep and join the
    // runs at draw time, and the 0/0 pre-state below would fail before the gesture under
    // test. Drawn DOWN first, (8,6) is the doorstep of nothing when it is pressed. UP's
    // release on (7,6) USED TO stay unjoined, because the release-time auto-dock offered
    // a Head machine In ports only. Since phase 89 (plan 89-05, D-06, WINDOWS 248) a draw
    // that ends one short of a free belt start joins it, so UP joins DOWN at draw time;
    // the leg then takes the junction off with the shipped Inputs-row Disconnect (the
    // control step 5 presses too) to reach the 0/0 pre-state the join gesture below needs
    // (plan 89-10: the phase 89 full live pass found this leg pinning the old release).

    // DOWN: drawn on plain floor and ENDING FACING the Sink's In, so the shipped
    // auto-dock gives it a Head dock on the Sink and leaves its TAIL free.
    await page.getByTitle(/^Draw belts/).click();
    {
      const start = await screenCellCentre(page, JAM_DOWN_CELLS[0][0], JAM_DOWN_CELLS[0][1]);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (const [cx, cy] of JAM_DOWN_CELLS.slice(1)) {
        const pt = await screenCellCentre(page, cx, cy);
        await page.mouse.move(pt.x, pt.y);
      }
      await page.mouse.up();
      await page.keyboard.press('Escape');
    }
    await pollScene(page, (s) => s.belts.length, {
      message: 'the downstream belt committed on plain floor, ending facing the Sink In',
    }).toBe(1);

    // UP: drawn off the Source's Out nub, released on EMPTY FLOOR, so its Tail docks
    // the Source and its HEAD IS FREE. That free head is what the join gesture grabs.
    await drawOffloadBelt(page, source.ports[0], JAM_UP_CELLS);
    await pollScene(page, (s) => s.belts.length, {
      message: 'the upstream belt committed off the Source Out nub',
    }).toBe(2);
    await pollScene(page, jamJunction, {
      message: "UP's release one short of DOWN's free start joined the two at draw time (D-06)",
    }).toBe('1/1');
    {
      await selectJamBelt(page, JAM_DOWN_TILE);
      const drawPorts = page.getByRole('region', { name: 'Ports' });
      await drawPorts.getByRole('button', { name: DISCONNECT_INPUT }).click();
      await pollScene(page, jamJunction, {
        message: 'the Inputs-row Disconnect took the draw-time junction off, read from both sides',
      }).toBe('0/0');
      await deselectViaEmptyCell(page, JAM_EMPTY_CELL[0], JAM_EMPTY_CELL[1]);
    }
    await pollDockSet(
      page,
      'both belts committed with the docks they were drawn for, and NEITHER names the other: ' +
        "the upstream's Tail on the Source, the downstream's Head on the Sink",
    ).toBe(`Head@${sink.id}:0 Tail@${source.id}:0`);

    const drawn = await readScene(page);
    const upBelt = jamBeltAt(drawn, JAM_UP_HEAD) as SceneFacts['belts'][number];
    const downBelt = jamBeltAt(drawn, JAM_DOWN_TAIL) as SceneFacts['belts'][number];
    expect(upBelt, 'a belt covers the upstream head tile').toBeDefined();
    expect(downBelt, 'a belt covers the downstream tail tile').toBeDefined();
    expect(upBelt.id, 'the two draws produced TWO distinct belts, not one').not.toBe(downBelt.id);
    expect(upBelt.tiles, 'the upstream run is the three tiles it was drawn along').toHaveLength(
      JAM_UP_CELLS.length,
    );
    expect(downBelt.tiles, 'the downstream run is the two tiles it was drawn along').toHaveLength(
      JAM_DOWN_CELLS.length,
    );
    await expectRenderLoopAlive(page, 'with both belts drawn, before the join');
    errs.assertNone('after drawing the two belts');

    // -----------------------------------------------------------------------
    // 1. THE PRE-STATE, so the join below proves it CHANGED something.
    //
    //    The two belts ABUT - (7,6) against (8,6) - and abutting is demonstrably not
    //    joining: the junction reads 0/0 and each belt's panel calls itself a run of
    //    one, in the shipped words.
    // -----------------------------------------------------------------------
    expect(jamJunction(drawn), 'BEFORE the gesture NEITHER belt names the other').toBe('0/0');
    await selectJamBelt(page, JAM_UP_TILE);
    await expect(
      page.locator('#fab-belt-run'),
      'the upstream belt is a run of ONE before the join, in the panel\'s own words',
    ).toHaveText(RUN_SINGLE_COPY);
    // The paint baseline, taken while UP is joined to NOTHING downstream. It is not
    // zero - UP's Tail plugs the Source, and that stem and cap live in the same
    // Graphics - so the assertion after the join is a DELTA and never a bare presence.
    const collarBefore = await beltEndInstructionsOn(page, upBelt.id);

    // -----------------------------------------------------------------------
    // 2. THE DOWNSTREAM IS SET SLOWER, WHILE IT IS STILL A RUN OF ONE.
    //
    //    THE ORDER HERE IS FORCED AND IS NOT A PREFERENCE. Once the two are joined
    //    they are ONE RUN, and one Apply sets the pace on ALL of it (that is LINK-03,
    //    walked in `74-belt-run-joins.spec.ts`) - so a slower downstream can only be
    //    authored BEFORE the join. The fast end of the shipped scale is also the
    //    shipped default, so the difference has to be made by SLOWING the downstream.
    // -----------------------------------------------------------------------
    await selectJamBelt(page, JAM_DOWN_TILE);
    await expect(
      page.locator('#fab-belt-run'),
      'the downstream belt is a run of ONE too: its Head terminates on a MACHINE',
    ).toHaveText(RUN_SINGLE_COPY);
    // VACUITY REFUSAL, mandatory rather than tidy (`23-belt-pace.spec.ts`'s reason):
    // without it the poll below resolves on its first read against a host that did
    // nothing at all.
    expect(
      jamBeltAt(await readScene(page), JAM_DOWN_TILE)?.ticksPerSlot,
      `the downstream must NOT already sit at ${SLOW_END_TICKS} ticks per slot, or the poll below proves nothing`,
    ).not.toBe(SLOW_END_TICKS);
    await page
      .getByRole('group', { name: 'Belt pace' })
      .getByRole('button', { name: `${SLOW_END_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await pollScene(page, (s) => jamBeltAt(s, JAM_DOWN_TILE)?.ticksPerSlot ?? -1, {
      message: `the slower pace reached the DOWNSTREAM belt in the MODEL: ${SLOW_END_TICKS} ticks per slot`,
    }).toBe(SLOW_END_TICKS);
    const upPace = jamBeltAt(await readScene(page), JAM_UP_TILE)?.ticksPerSlot;
    expect(
      upPace,
      'and the UPSTREAM belt kept its own pace: the two runs are paced independently, which is ' +
        'the whole precondition of the backlog below',
    ).not.toBe(SLOW_END_TICKS);
    console.log(`LEG3_PACES up=${upPace} down=${SLOW_END_TICKS}`);
    await deselectViaEmptyCell(page, JAM_EMPTY_CELL[0], JAM_EMPTY_CELL[1]);

    // -----------------------------------------------------------------------
    // 3. THE JOIN, BY A SHIPPED GESTURE: select the upstream belt and drag its Head
    //    handle onto the downstream belt's Tail end (LINK-02).
    // -----------------------------------------------------------------------
    await selectJamBelt(page, JAM_UP_TILE);
    {
      const head = await screenCellCentre(page, JAM_UP_HEAD[0], JAM_UP_HEAD[1]);
      const tail = await screenCellCentre(page, JAM_DOWN_TAIL[0], JAM_DOWN_TAIL[1]);
      await page.mouse.move(head.x, head.y);
      await page.mouse.down();
      await page.mouse.move(tail.x, tail.y, { steps: 4 });
      await page.mouse.up();
    }

    // -----------------------------------------------------------------------
    // 4. THE MODEL FACT, FIRST AND BEFORE ANY COUNT IS READ. This is the step the
    //    whole leg's order exists for.
    // -----------------------------------------------------------------------
    await pollScene(page, jamJunction, {
      message:
        'the real host folded the belt-to-belt Dock and BOTH belts name each other. This is ' +
        'read BEFORE a single item count, because `tick.rs:1586` makes a belt with NO ' +
        'downstream link bunch exactly like one that is correctly backpressured - so every ' +
        'count assertion below is meaningless until this one has passed',
    }).toBe('1/1');
    const joined = await readScene(page);
    console.log(`LEG3_DOCKS ${JSON.stringify(joined.belts.map((b) => ({ id: b.id, docks: b.docks })))}`);
    // The paces SURVIVED the join, so the backlog below is caused by the pace
    // difference this leg authored and not by a join that silently re-paced the run.
    expect(
      {
        up: jamBeltAt(joined, JAM_UP_TILE)?.ticksPerSlot,
        down: jamBeltAt(joined, JAM_DOWN_TILE)?.ticksPerSlot,
      },
      'the join left both paces exactly as they were: the downstream is still the slow one',
    ).toEqual({ up: upPace, down: SLOW_END_TICKS });
    // THE PAINT, beside the state and substituting for neither. `docks` says the HOST
    // derived the link; it says nothing about whether the junction reached the screen.
    await expect
      .poll(async () => beltEndInstructionsOn(page, upBelt.id), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'junction collar plotted poll'),
        intervals: [100, 250, 500],
        message:
          'the junction COLLAR is plotted on the upstream belt: its end marks now carry MORE ' +
          'geometry than the Source plug alone did before the join',
      })
      .toBeGreaterThan(collarBefore);
    // ...and the panel says it in the user's own words.
    await selectJamBelt(page, JAM_DOWN_TILE);
    await expect(
      page.locator('#fab-belt-run'),
      'the joined pair reads as ONE RUN OF TWO in the shipped panel, by exact string',
    ).toHaveText(RUN_TWO_COPY);
    await deselectViaEmptyCell(page, JAM_EMPTY_CELL[0], JAM_EMPTY_CELL[1]);
    await expectRenderLoopAlive(page, 'with the junction joined and drawn');
    errs.assertNone('through the join gesture');

    // -----------------------------------------------------------------------
    // 5. OPEN THE TAP through the shipped Source Trigger control.
    // -----------------------------------------------------------------------
    await selectMachineAt(page, JAM_SOURCE_CELL[0], JAM_SOURCE_CELL[1]);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', JAM_TIMER_TICKS);
    await applyConfig(page);
    await deselectViaEmptyCell(page, JAM_EMPTY_CELL[0], JAM_EMPTY_CELL[1]);

    // -----------------------------------------------------------------------
    // 6. THE BACKLOG. Both halves are asserted, because neither alone is the claim,
    //    and BOTH are asserted as EXACT EQUALITY over the COMPLETE occupancy vector
    //    rather than as a count - a count of 7 can be produced by seven different
    //    patterns and only one of them is a belt that is packed.
    //
    //    THE UPSTREAM IS FULL TO ITS OWN CAPACITY, `tiles.length * SLOTS_PER_TILE`,
    //    gap-free from slot 0. That is the exact-equality-at-capacity reading, and the
    //    UPSTREAM is where it is reachable: its head is BLOCKED by the downstream's
    //    full tail, so it packs solid and stays there.
    //
    //    THE DOWNSTREAM SATURATES ONE SLOT SHORT OF ITS CAPACITY, AND THAT IS THE
    //    CORRECT NUMBER RATHER THAN A RELAXATION. MEASURED on the real host while this
    //    leg was written: `down=7 slots=[1,2,3,4,5,6,7]` held for hundreds of ticks,
    //    with slot 0 - the HEAD - empty on every single read. A belt that is DELIVERING
    //    frees its head the moment an item reaches it (`tick.rs:1586`: the head is
    //    delivered by the fold, and only an undeliverable head is retained), so a
    //    downstream belt with somewhere to go can NEVER be sampled at full capacity.
    //    The only way to read `items === capacity` here would be to block the
    //    downstream's head - and a blocked head cannot drain, which would make step 7
    //    unprovable. This is the same shape `25-backpressure-cascade.spec.ts` records
    //    as its own measured baseline: "seven of eight, gap-free, head EMPTY".
    //
    //    So the assertion is the whole SIGNATURE of both belts, derived from their own
    //    tile counts and compared as one string. Neither half is the claim on its own:
    //    a downstream with nowhere to deliver fills up unaided, and items crossing a
    //    junction is just a working belt. And the pair CANNOT be produced by an
    //    unjoined board at all - an upstream whose head dangles packs to exactly this
    //    same 12, which is the `tick.rs:1586` trap, but the downstream beside it would
    //    read `down=0 slots=[]` because nothing would ever have crossed.
    // -----------------------------------------------------------------------
    const downCapacity = downBelt.tiles.length * SLOTS_PER_TILE;
    const upCapacity = upBelt.tiles.length * SLOTS_PER_TILE;
    /** The exact occupancy both belts hold at saturation, DERIVED from their own tile
     *  counts: the upstream packed solid from slot 0, the downstream packed solid from
     *  slot 1 with its delivering head free. */
    const range = (from: number, to: number): number[] =>
      Array.from({ length: to - from }, (_, i) => from + i);
    const signatureOf = (s: SceneFacts): string => {
      const down = jamBeltAt(s, JAM_DOWN_TILE);
      const up = jamBeltAt(s, JAM_UP_TILE);
      return (
        `down=${down?.items}${JSON.stringify(down?.occupiedSlots)} ` +
        `up=${up?.items}${JSON.stringify(up?.occupiedSlots)}`
      );
    };
    const SATURATED =
      `down=${downCapacity - 1}${JSON.stringify(range(1, downCapacity))} ` +
      `up=${upCapacity}${JSON.stringify(range(0, upCapacity))}`;
    let sustained = 0;
    await expect
      .poll(
        async () => {
          sustained = signatureOf(await readScene(page)) === SATURATED ? sustained + 1 : 0;
          return sustained;
        },
        {
          timeout: 60_000,
          intervals: [150],
          message:
            `across ${JAM_SUSTAINED_READS} CONSECUTIVE reads both belts hold EXACTLY this ` +
            `occupancy: ${SATURATED}. The upstream is packed to its full ${upCapacity}-slot ` +
            `capacity because the downstream's tail is full, and the downstream is packed to ` +
            `${downCapacity - 1} of ${downCapacity} gap-free with its delivering head free`,
        },
      )
      .toBeGreaterThanOrEqual(JAM_SUSTAINED_READS);
    const jammed = await readScene(page);
    const upAtJam = jamBeltAt(jammed, JAM_UP_TILE)?.items as number;
    console.log(`LEG3_JAM signature=${signatureOf(jammed)} expected=${SATURATED}`);
    // THE JUNCTION IS STILL THERE at the moment the counts are read, so the backlog
    // being asserted is a backlog ACROSS a junction and not two unrelated pile-ups.
    expect(
      jamJunction(jammed),
      'and the junction still names both belts at the moment the jam is read',
    ).toBe('1/1');
    await expectRenderLoopAlive(page, 'with the run backed up at the junction');
    errs.assertNone('while the backlog formed');

    // -----------------------------------------------------------------------
    // 7. DISCONNECT. THE STEP A DANGLING HEAD CANNOT FAKE.
    //
    //    A belt that was never joined has no junction to disconnect and no downstream
    //    to drain. Pressing the shipped control and watching the downstream empty
    //    while the upstream stays packed is therefore a reading no unjoined pair can
    //    produce, whatever its counts happened to say above.
    // -----------------------------------------------------------------------
    await selectJamBelt(page, JAM_DOWN_TILE);
    const ports = page.getByRole('region', { name: 'Ports' });
    await expect(ports, 'the belt panel renders a Ports section (74-07)').toBeVisible();
    // BOTH of this belt's ends are docked - its Tail to the upstream BELT and its Head
    // to the Sink - so the panel offers TWO Disconnects, one per row. MEASURED, and
    // asserted as two rather than as "at least one": the row this leg presses has to be
    // the JUNCTION's row, and a locator that matched either would press whichever the
    // DOM happened to order first. The composed accessible name is what separates them.
    await expect(
      ports.getByRole('button', { name: /^Disconnect/ }),
      'the downstream belt has both ends docked, so exactly TWO Disconnects render: one on ' +
        'the Inputs row for the belt junction and one on the Outputs row for the Sink',
    ).toHaveCount(2);
    await expect(
      ports.getByRole('button', { name: DISCONNECT_OUTPUT }),
      'the Outputs row control - the Sink link - is present and is NOT the one pressed below',
    ).toHaveCount(1);
    await ports.getByRole('button', { name: DISCONNECT_INPUT }).click();

    // THE MODEL FIRST, again: the junction is gone from BOTH sides.
    await pollScene(page, jamJunction, {
      message: 'the Disconnect took the junction off the board, read from both sides',
    }).toBe('0/0');
    // ...and then the two counts move in OPPOSITE directions, which is the whole
    // signature. The downstream keeps delivering into the Sink with nothing arriving,
    // so it empties; the upstream's head is dangling now, so it holds everything it
    // had (`tick.rs:1586`, the third case) and the Source keeps it topped up.
    await expect
      .poll(
        async () => {
          const s = await readScene(page);
          return `${jamBeltAt(s, JAM_DOWN_TILE)?.items}/${(jamBeltAt(s, JAM_UP_TILE)?.items ?? -1) >= upAtJam}`;
        },
        {
          timeout: 60_000,
          intervals: [150],
          message:
            'after the Disconnect the DOWNSTREAM belt drains to empty - it still delivers into ' +
            `the Sink and nothing arrives - while the UPSTREAM stays at or above the ${upAtJam} ` +
            'items it was holding, because its head is dangling now and a dangling head retains',
        },
      )
      .toBe('0/true');
    // The collar goes with the link: the paint returns to the pre-join baseline, which
    // is the half of the paint claim a bare presence check could not express.
    await expect
      .poll(async () => beltEndInstructionsOn(page, upBelt.id), {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'junction collar gone poll'),
        intervals: [100, 250, 500],
        message: 'the junction collar is gone from the upstream belt after the Disconnect',
      })
      .toBe(collarBefore);

    await expectRenderLoopAlive(page, 'after the Disconnect drained the downstream');
    errs.assertNone('the whole of leg 3 completed');

    // -----------------------------------------------------------------------
    // RESTORE THE SHARED HOST, exactly as leg 5 does: this leg left a jammed board
    // behind a running Timer, and the live suite runs `workers: 1` against ONE
    // mutable host, so every spec that sorts after this file would inherit it.
    //
    // DESELECT FIRST, and it is not tidying. MEASURED while writing this leg: the
    // config panel is a right-edge overlay and it is still open on the downstream belt
    // after the Disconnect, and its heading INTERCEPTS THE POINTER on the `Examples`
    // control the restore drives - Playwright retried the click for the whole 90s test
    // budget and the leg failed on the restore rather than on anything it asserts.
    // -----------------------------------------------------------------------
    await deselectViaEmptyCell(page, JAM_EMPTY_CELL[0], JAM_EMPTY_CELL[1]);
    await loadDemoViaExamples(page);
    await pollScene(page, (s) => s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
      message: 'the shared host is restored to the demo baseline after the walk',
    }).toBe(true);
  });
});
