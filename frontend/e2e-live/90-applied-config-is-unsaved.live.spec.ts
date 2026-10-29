import { test, expect, type Dialog, type Page } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEMO_NODE_COUNT,
  anchorOf,
  applyConfig,
  clickAt,
  demoCallerAndHandler,
  expectRenderLoopAlive,
  fillPanelField,
  handDrawWire,
  nodeAtAnchor,
  pollScene,
  pressSegment,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  restoreHostAfterFailedTest,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  typeFactorySource,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  nubAnchor,
  type PortFacts,
  type SceneFacts,
} from './support/oracle';
import { CONFIG_NOT_APPLIED_MARKER, GUARD_QUEUED_WORDS } from '../src/chrome/configCopy';

// 90-applied-config-is-unsaved.live.spec.ts (phase 90, WORK-08 and CHROME-17, D-03 and D-05,
// success criterion 2, UI-SPEC sections 4.2 and 5, walk steps 4 and 5): an edit the host
// accepts marks the board unsaved, whatever it does to the board's shape, on the real dev host.
//
// WHAT WAS BROKEN (90-MEASURE.md, "WORK-08: still broken"). The only writer of the unsaved flag
// was the render-packet path, which marks the board dirty when a packet shows a node or a belt
// dock change shape (`isStructuralEdit`). A Factory code, a belt pace, a Route path, a cable
// drawn and a cable disconnected change none of what it reads, so the board stayed "clean" and
// New, an example, an Open and quit discarded the edit with no warning. Since plan 90-05 the
// host's accept of any edit other than Undo and Redo lights the toolbar `Unsaved` badge
// (`dirtyAfterVerdict`, `App.tsx` `onGestureVerdict`).
//
// CHROME-17 rides leg 1: typing the Factory code marks the panel heading `• not applied`
// (`CONFIG_NOT_APPLIED_MARKER`, imported, never spelled) and lights no toolbar badge; Apply
// clears the marker and the host's accept then lights `Unsaved`.
//
// THE SIX LEGS, each from the demo reset (`resetToDemo`) with the badge absent first; every
// machine and belt is found by kind and cell, never by a handle number:
//   1. The demo Factory's code is changed and applied: `Unsaved` shows; New opens `Start a new
//      board?`; Cancel leaves the demo on screen (it still runs, with all its machines).
//   2. A demo belt's pace is changed and applied: `Unsaved` shows.
//   3. The demo Route's path is changed and applied: `Unsaved` shows.
//   4. A cable drawn by hand: the demo cable is disconnected, the board saved and that file
//      opened (a clean board with no cable), then the cable is drawn back with
//      `handDrawWire`: `Unsaved` shows.
//   5. The demo cable disconnected through the Route's shipped Disconnect: `Unsaved` shows.
//      FIXED-ALREADY at PHASE90_START and kept as a guard: the host's diff lists a removed
//      cable's handle in `removed` (`render_packet.rs`), which `isStructuralEdit` counts.
//   6. (review WR-B-03) The demo Factory's code applied on a PAUSED board: queued, no badge (the
//      host accepted nothing yet), and New asks first, saying the queued edit will be lost.
//
// Each leg prints `P90-WORK-08 leg-<n> badge=<shown|absent>` before it asserts, so a red run
// says what the toolbar showed. MODEL FIRST, THEN RENDER HEALTH in every test.

const UNSAVED = 'Unsaved';
/** Protocol `machine_kind`: FACTORY 2, ROUTE 9. */
const FACTORY_KIND = 2;
/** Port role and medium (`PortFacts`): Out 1, In 0; Electrical 1. */
const ROLE_OUT = 1;
const ROLE_IN = 0;
const MEDIUM_ELECTRICAL = 1;
/** A new, valid Factory handler that differs from the demo's. */
const NEW_SOURCE = 'export default (payload) => payload;';
/** A Route path the demo does not use. */
const NEW_PATH = '/p90-unsaved';
/** The Route's Path field (`RouteConfigBody.tsx` `PATH_FIELD_ID`), transcribed. */
const PATH_FIELD_ID = 'fab-route-path';
/** The Route's one Disconnect control (`77-one-board-all-five`, `25-route-and-handler`). */
const DISCONNECT_CONTROL_NAME = 'Disconnect Output - Wire';
/** The pace steps (`BeltConfigBody.tsx` `PACE_STEPS`), each a segment named `<500/ticks> px per second`. */
const PACE_TICKS = [2, 4, 5, 10, 20];
/** The host's accept lands about one tick after the send on a playing board; a quota run is slower. */
const BADGE_MS = 15_000;
/** A Save on a running board drains first (D-08): up to 18.9 s measured under the quota. */
const SAVE_MS = 45_000;
/** The status strip's readout (`Loaded` after an Open's swap). */
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';
/** `STATUS_COPY.editsQueued`, transcribed. */
const QUEUED = 'Paused - edits queued until Play';
/** Ticks the demo must run on after Cancel, so a silent New swap could not hide (its tick restarts low). */
const RUNS_ON_TICKS = 60;

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  await waitForCameraSettle(page);
}

/** The badge reading, waited for up to `BADGE_MS`, printed, then graded shown. */
async function expectBadgeShown(page: Page, leg: string, what: string): Promise<void> {
  const badge = page.getByText(UNSAVED, { exact: true });
  const shown = await badge.waitFor({ state: 'visible', timeout: BADGE_MS }).then(
    () => true,
    () => false,
  );
  console.log(`P90-WORK-08 ${leg} badge=${shown ? 'shown' : 'absent'}`);
  expect(shown, `${leg}: ${what} lights the toolbar Unsaved badge on the host's accept`).toBe(true);
}

async function expectBadgeAbsent(page: Page, leg: string, what: string): Promise<void> {
  await expect(page.getByText(UNSAVED, { exact: true }), `${leg}: ${what}`).toHaveCount(0);
}

/**
 * Every edit this page sent is answered, read off the hook plan 90-05 adds. Review IN-C-02: a
 * missing hook throws (the poll then runs out red), never reads 0 and passes at once.
 */
async function editsAnswered(page: Page, leg: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hook = (window as unknown as { __fabrico?: { editsAwaitingVerdict?(): number } }).__fabrico;
          if (typeof hook?.editsAwaitingVerdict !== 'function') {
            throw new Error('editsAnswered: window.__fabrico.editsAwaitingVerdict is not installed');
          }
          return hook.editsAwaitingVerdict();
        }),
      { timeout: BADGE_MS, intervals: [50, 100, 250], message: `${leg}: every edit sent has its host answer` },
    )
    .toBe(0);
}

function demoFactory(scene: SceneFacts): SceneFacts['nodes'][number] {
  const factories = scene.nodes.filter((n) => n.kind === FACTORY_KIND).sort((a, b) => a.id - b.id);
  expect(factories.length, 'the demo carries a Factory').toBeGreaterThan(0);
  return factories[0];
}

function electrical(node: SceneFacts['nodes'][number], role: number, what: string): PortFacts {
  const port = node.ports.find((p) => p.role === role && p.medium === MEDIUM_ELECTRICAL);
  expect(port, `${what} has an electrical ${role === ROLE_OUT ? 'Out' : 'In'}`).toBeDefined();
  return port as PortFacts;
}

/**
 * Select the demo Route, press its one Disconnect, and wait for both demo cable legs to leave
 * the model. Returns the pair as found before the Disconnect (a diff keeps its handles).
 */
async function disconnectDemoCable(
  page: Page,
  leg: string,
): Promise<{ caller: SceneFacts['nodes'][number]; handler: SceneFacts['nodes'][number] }> {
  const pair = await demoCallerAndHandler(page);
  const [cx, cy] = anchorOf(pair.caller);
  await selectMachineAt(page, cx, cy);
  await page.getByRole('button', { name: DISCONNECT_CONTROL_NAME, exact: true }).click();
  await pollScene(page, (s) => s.wires.length, {
    message: `${leg}: one Disconnect on the Route's Out row removed both demo cable legs`,
  }).toBe(0);
  return { caller: pair.caller, handler: pair.handler };
}

test.describe('90 live: an edit the host accepts marks the board unsaved (WORK-08)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: the Factory code applied lights Unsaved, New asks first, and Cancel keeps the demo', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectBadgeAbsent(page, 'leg 1', 'the demo reset is clean');
    const factory = demoFactory(await readScene(page));
    const [fx, fy] = anchorOf(factory);
    await selectMachineAt(page, fx, fy);
    await typeFactorySource(page, NEW_SOURCE);
    // CHROME-17 (D-05): the typed code is "not applied" in the panel's heading, and typing alone
    // lights no toolbar badge ("unsaved" is the board file's word only).
    const heading = page.locator('#fab-config-heading');
    await expect(heading, 'leg 1: the typed code marks the panel heading not applied').toContainText(CONFIG_NOT_APPLIED_MARKER);
    expect(((await heading.textContent()) ?? '').toLowerCase(), 'leg 1: the panel heading never says unsaved').not.toContain('unsaved');
    await expectBadgeAbsent(page, 'leg 1', 'typing in the panel without Apply lights no toolbar badge');
    await applyConfig(page);
    await expect(heading, 'leg 1: Apply clears the not-applied marker').not.toContainText(CONFIG_NOT_APPLIED_MARKER);
    await expectBadgeShown(page, 'leg 1', 'the Factory code Apply');
    await expectRenderLoopAlive(page, 'leg 1, after the Apply');

    // New is pressed with the Factory's panel still open: the panel docks below the toolbar
    // (phase 91, CHROME-07), so it no longer covers New.
    await page.getByTitle('New board (Ctrl+N)').click();
    const dialog = page.locator('.fab-dialog-panel');
    await expect(dialog.getByText('Start a new board?', { exact: true }), 'leg 1: New opens the discard guard first').toBeVisible({
      timeout: BADGE_MS,
    });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog, 'leg 1: Cancel closes the guard').toHaveCount(0);
    const t0 = (await readScene(page)).tick;
    await pollScene(page, (s) => s.tick >= t0 + RUNS_ON_TICKS, {
      timeout: 30_000,
      message: `leg 1: after Cancel the demo runs on past tick ${t0 + RUNS_ON_TICKS} (a New swap restarts the tick low)`,
    }).toBe(true);
    const after = await readScene(page);
    expect(
      { nodes: after.nodes.length, wires: after.wires.length, factory: demoFactory(after).cells },
      'leg 1: Cancel kept the demo on screen, every machine and both cable legs, the Factory where it was',
    ).toEqual({ nodes: DEMO_NODE_COUNT, wires: 2, factory: factory.cells });
    await expect(page.getByText(UNSAVED, { exact: true }), 'leg 1: the board is still unsaved after Cancel').toHaveCount(1);
    await expectRenderLoopAlive(page, 'after leg 1');
    errs.assertNone('leg 1');
  });

  test('2: a belt pace applied lights Unsaved', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectBadgeAbsent(page, 'leg 2', 'the demo reset is clean');
    const scene = await readScene(page);
    const belt = [...scene.belts].sort((a, b) => b.tiles.length - a.tiles.length || a.id - b.id)[0];
    expect(belt, 'leg 2: the demo carries a belt').toBeDefined();
    const tile = belt.tiles[Math.floor(belt.tiles.length / 2)];
    const ticks = PACE_TICKS.find((t) => t !== belt.ticksPerSlot) as number;
    const at = await screenCellCentre(page, tile.cell_x, tile.cell_y);
    await expect
      .poll(() => page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'NONE', [at.x, at.y] as const), {
        message: `leg 2: the belt tile (${tile.cell_x},${tile.cell_y}) is on the open board before it is clicked`,
        timeout: 10_000,
      })
      .toBe('CANVAS');
    await clickAt(page, at.x, at.y);
    await expect(page.locator('#fab-belt-config'), 'leg 2: clicking the tile opened the belt panel').toBeVisible({ timeout: 15_000 });
    await pressSegment(page, 'Belt pace', `${500 / ticks} px per second`);
    await applyConfig(page);
    await pollScene(page, (s) => s.belts.find((b) => b.tiles.some((t) => t.cell_x === tile.cell_x && t.cell_y === tile.cell_y))?.ticksPerSlot, {
      message: `leg 2: the belt at (${tile.cell_x},${tile.cell_y}) runs at ${ticks} ticks a slot in the model`,
    }).toBe(ticks);
    await expectBadgeShown(page, 'leg 2', 'the belt pace Apply');
    await expectRenderLoopAlive(page, 'after leg 2');
    errs.assertNone('leg 2');
  });

  test('3: a Route path applied lights Unsaved', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectBadgeAbsent(page, 'leg 3', 'the demo reset is clean');
    const pair = await demoCallerAndHandler(page);
    const [rx, ry] = anchorOf(pair.caller);
    await selectMachineAt(page, rx, ry);
    await fillPanelField(page, PATH_FIELD_ID, NEW_PATH);
    await applyConfig(page);
    await expectBadgeShown(page, 'leg 3', 'the Route path Apply');
    await expectRenderLoopAlive(page, 'after leg 3');
    errs.assertNone('leg 3');
  });

  test('4: a cable drawn by hand on a saved board lights Unsaved', async ({ page }) => {
    test.setTimeout(180_000);
    const errs = watchPageErrors(page);
    const dir = mkdtempSync(join(tmpdir(), 'fabrico-e2e-90-cable-unsaved-'));
    const file = join(dir, 'board.fab');
    let prompts = 0;
    const onDialog = (d: Dialog): void => {
      prompts += 1;
      void d.accept(file);
    };
    page.on('dialog', onDialog);
    try {
      await boot(page);
      await expectBadgeAbsent(page, 'leg 4', 'the demo reset is clean');
      const { caller, handler } = await disconnectDemoCable(page, 'leg 4');
      await editsAnswered(page, 'leg 4, the Disconnect');
      // The Route's panel stays open: it docks below the toolbar (CHROME-07), so Save is pressed
      // with the Route still selected.
      const [cx, cy] = anchorOf(caller);
      // Saved (no file yet: the prompt names one), then that file opened, so the board on screen
      // is a clean board with no cable. The Open matters at PHASE90_START: there a Save on a
      // running board left the host frozen (FAIL-04, fixed in plan 90-02), so a cable drawn
      // after the Save alone was never folded; a Load resumes the host at both revisions.
      await page.getByTitle('Save (Ctrl+S) - Shift for Save As').click();
      await expect.poll(() => prompts, { message: 'leg 4: the Save prompt opened' }).toBe(1);
      await expect.poll(() => existsSync(file), { timeout: SAVE_MS, intervals: [200, 500], message: 'leg 4: the host wrote the file' }).toBe(true);
      await expect(page.getByText(UNSAVED, { exact: true }), 'leg 4: the saved board is clean, so the Open asks nothing').toHaveCount(0, {
        timeout: BADGE_MS,
      });
      await page.getByTitle('Load a saved factory').click();
      await expect.poll(() => prompts, { message: 'leg 4: the Open prompt opened' }).toBe(2);
      await expect
        .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
          timeout: SAVE_MS,
          intervals: [50, 100, 250],
          message: 'leg 4: the saved board opened (Loaded)',
        })
        .toBe('Loaded');
      const opened = await readScene(page);
      const route = nodeAtAnchor(opened, cx, cy);
      const [hx, hy] = anchorOf(handler);
      const target = nodeAtAnchor(opened, hx, hy);
      expect(
        { route: route?.kind, handler: target?.kind, wires: opened.wires.length },
        'leg 4: the opened board holds the Route and the HTTP Handler where they were, and no cable',
      ).toEqual({ route: caller.kind, handler: handler.kind, wires: 0 });
      await expectBadgeAbsent(page, 'leg 4', 'the opened board is clean before the draw');

      // The hand draws at camera scale 1, as the cable specs that draw by hand do (75).
      await resetZoomToActualSize(page);
      await waitForCameraSettle(page);
      const out = electrical(route!, ROLE_OUT, 'the Route');
      const inn = electrical(target!, ROLE_IN, 'the HTTP Handler');
      const nubs = [
        await screenPoint(page, nubAnchor(out.cell_x, out.cell_y, out.side)),
        await screenPoint(page, nubAnchor(inn.cell_x, inn.cell_y, inn.side)),
      ];
      expect(
        await page.evaluate((ps) => ps.map((p) => document.elementFromPoint(p.x, p.y)?.tagName ?? null), nubs),
        'leg 4: both nubs are on the open board, not under chrome',
      ).toEqual(['CANVAS', 'CANVAS']);
      await handDrawWire(page, out, inn);
      const drawn = await pollScene(page, (s) => s.wires.some((w) => w.from.node === route!.id && w.to.node === target!.id), {
        message: 'leg 4: the host folded the hand-drawn cable from the Route to the HTTP Handler',
      })
        .toBe(true)
        .then(
          () => null,
          (e: unknown) => e,
        );
      if (drawn !== null) {
        const s = await readScene(page);
        console.log(
          `P90-WORK-08 leg 4 no-cable route=${route!.id} handler=${target!.id} wires=${JSON.stringify(s.wires.map((w) => ({ from: w.from, to: w.to })))} ` +
            `route_ports=${JSON.stringify(s.nodes.find((n) => n.id === route!.id)?.ports)} handler_ports=${JSON.stringify(s.nodes.find((n) => n.id === target!.id)?.ports)} ` +
            `refusal=${JSON.stringify(await page.locator('#fab-refusal').textContent().catch(() => null))}`,
        );
        throw drawn;
      }
      await expectBadgeShown(page, 'leg 4', 'the hand-drawn cable');
      await expectRenderLoopAlive(page, 'after leg 4');
      errs.assertNone('leg 4');
    } finally {
      page.off('dialog', onDialog);
    }
  });

  test('5: the demo cable disconnected lights Unsaved', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectBadgeAbsent(page, 'leg 5', 'the demo reset is clean');
    await disconnectDemoCable(page, 'leg 5');
    await expectBadgeShown(page, 'leg 5', 'the cable Disconnect');
    await expectRenderLoopAlive(page, 'after leg 5');
    errs.assertNone('leg 5');
  });

  // Review WR-B-03 (walk todo 2026-10-24 "New before Play drops a paused Apply without a warning",
  // walk step 4's backstop): a paused host holds the Apply until Play, so nothing is accepted and the
  // badge stays off (D-03), but New would drop the Apply with the old board. It asks first.
  test('6: the Factory code applied on a paused board: no badge, and New asks first and names the queued edit', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = watchPageErrors(page);
    await boot(page);
    await expectBadgeAbsent(page, 'leg 6', 'the demo reset is clean');
    const factory = demoFactory(await readScene(page));
    const [fx, fy] = anchorOf(factory);
    const transportButton = page.getByRole('button', { name: /^(Play|Pause)$/ });
    try {
      await transportButton.click();
      await expect(transportButton, 'leg 6: the sim is paused (the toggle offers Play)').toHaveAttribute('aria-label', 'Play');
      await selectMachineAt(page, fx, fy);
      await typeFactorySource(page, NEW_SOURCE);
      await page.getByRole('button', { name: 'Apply' }).click();
      await expect
        .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
          message: 'leg 6: the paused Apply is queued',
        })
        .toBe(QUEUED);
      await expectBadgeAbsent(page, 'leg 6', 'the host accepted nothing yet, so the badge stays off');
      // With the Factory's panel still open (it docks below the toolbar, CHROME-07).
      await page.getByTitle('New board (Ctrl+N)').click();
      const dialog = page.locator('.fab-dialog-panel');
      await expect(dialog.getByText('Start a new board?', { exact: true }), 'leg 6: New asks first').toBeVisible();
      await expect(dialog, 'leg 6: the guard says the queued edit will be lost').toContainText(GUARD_QUEUED_WORDS);
      console.log(`P90-WR-B-03 leg-6 guard=${JSON.stringify(((await dialog.textContent()) ?? '').trim())}`);
      await dialog.getByRole('button', { name: 'Discard' }).click();
      await pollScene(page, (s) => s.nodes.length === 0 && s.belts.length === 0, {
        message: 'leg 6: Discard went on to the empty board',
      }).toBe(true);
    } finally {
      if ((await transportButton.getAttribute('aria-label')) === 'Play') await transportButton.click();
    }
    await expect(transportButton, 'leg 6: Play leaves the shared host running').toHaveAttribute('aria-label', 'Pause');
    await expectRenderLoopAlive(page, 'after leg 6');
    errs.assertNone('leg 6');
  });
});
