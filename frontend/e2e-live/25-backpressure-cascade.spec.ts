import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  applyConfig,
  backedUpMarkPaintedOn,
  clickAt,
  expectRenderLoopAlive,
  fillPanelField,
  nodeAtAnchor,
  pressSegment,
  readScene,
  resetToDemo,
  screenCellCentre,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 25-backpressure-cascade.spec.ts (PILE-07, and PILE-08's third acceptance check;
// plan 71-08) - the jam driven on the REAL `dev_render_server`, zero mocks.
//
// ---------------------------------------------------------------------------
// THE MEASURED BASELINE THIS SPEC INVERTS
// ---------------------------------------------------------------------------
//
// At these exact settings - the long branch at 25 px/sec, the Source on a Timer
// every 2 ticks - belts 9 and 10 both sit at [0,1,1,1,1,1,1,1] at t=300, 900, 1800
// and 3000: seven of eight, gap-free, head EMPTY, with 8/8 on 0 of 300 consecutive
// ticks.
//
// ---------------------------------------------------------------------------
// PHASE 87 (JAM-02, D-04): BOTH TEE BRANCHES ARE SLOWED
// ---------------------------------------------------------------------------
//
// One slowed branch no longer stops the Tee. Since plan 87-05 the Tee is gated per branch
// (D-03): a branch whose belt is full does not get its copy (the copy is counted and shown as
// a fault) while the other branch keeps its pace, so slowing only the long branch, as this
// spec did, leaves the Tee taking every item and no jam forms upstream of it (read red on plan
// 87-05's host before this change: 0 of 3 sustained jammed reads). The Tee still stalls when
// EVERY branch is busy (D-04), which is the stall PILE-07 and PILE-08 grade, so this spec now
// slows BOTH branches, the long branch and the short branch to the Router, to the same pace
// by the same panel gesture before the trigger. Nothing else changed: every assertion below
// (the head tile on both belts, belt 10 before belt 9, the Tee BACKED_UP and painted, render
// health on both sides of every gesture) is kept as it was. The one-slowed-branch behaviour is
// graded by `87-tee-slow-branch.live.spec.ts`.
//
// ---------------------------------------------------------------------------
// WHAT THIS SPEC ASSERTS, AND WHY EACH HALF IS MANDATORY
// ---------------------------------------------------------------------------
//
// THE HEAD, AND THEN THE ORDER. A bare item COUNT is not the second signal: the
// baseline above is seven of eight and gap-free, so "the belt is packed" is
// substantially satisfiable before any work, and two counts would be asserting one
// fact twice. The two things the baseline does not contain are HEAD RETENTION and
// the ORDER in which the two belts reach it, so those are what is asserted. Belt 10
// (factory -> tee) must reach `headOccupied` STRICTLY BEFORE belt 9 (source ->
// factory), because the jam starts at the Tee and packs upstream one machine at a
// time. That ordering is read from FIRST OBSERVATIONS recorded on the sim clock,
// never from a final state: at steady state both are true and the order is gone.
//
// THE MARK, READ OFF THE PLOT. `node.state === BACKED_UP` says the HOST derived the
// byte. It says nothing whatever about whether a canvas drew anything, and a build
// whose `drawLoadGauge` regressed leaves that byte completely untouched - this
// project's recorded model-oracle blind spot, reached on this cue.
// `backedUpMarkPaintedOn(id)` reports whether THAT node's gauge `Graphics` HOLDS
// GEOMETRY, so both are asserted and neither substitutes for the other. Measured
// non-vacuity, in `71-08-SUMMARY.md`: with `drawLoadGauge` turned into a no-op the
// state assertion stays green and the painted assertion goes red.
//
// SCOPED TO THE TEE (71-review WR-05). The original used the board-wide
// `backedUpMarksPainted()`, which is `loadGaugesPainted() > 0` over ANY node whose
// gauge plotted geometry - and `drawLoadGauge` plots at levels 1, 2 and 3 as well as
// at the merged full bar. A regression confined to the `level >= GAUGE_SLOTS` branch
// left the Tee, the machine this message NAMES, drawing nothing while the Factory,
// Router and Merge upstream kept the count non-zero, so the assertion passed. The
// recorded non-vacuity transcript used a TOTAL no-op, which was the only mutation the
// board-wide form could ever detect.
//
// RENDER HEALTH ON BOTH SIDES OF EVERY GESTURE. The live oracle reads only
// `window.__fabrico.scene()`, which is fed by the packet path and is completely
// independent of the Pixi ticker, so a frozen board passes every model assertion in
// this file. `watchPageErrors` is installed BEFORE `page.goto` (its own docblock
// requires it; installing it after loses every error raised during load) and
// `expectRenderLoopAlive` is called before the gestures and again at the assertion
// point.

/**
 * `NodeView.state` bytes, MIRRORED from `frontend/src/protocol/kinds.ts`'s
 * `state_tag` rather than imported: the live project is structurally zero-product-
 * import by design (oracle.ts's header rule), which is the whole of what makes it an
 * independent oracle. Transcribed the way `22-stranded-reconnect.spec.ts` transcribes
 * the port-role bytes and `23-belt-pace.spec.ts` transcribes its refusal sentences.
 *
 * BACKED_UP is byte 3: the machine's mechanical inbox is AT the admission cap and is
 * refusing further belt deliveries (PILE-08). Named rather than compared as a bare
 * literal, which is the unnamed-byte problem plan 71-02 spent a task removing from
 * production code and which a live spec has no licence to reintroduce.
 */
const STATE_TAG = { IDLE: 0, WORKING: 1, FAULTED: 2, BACKED_UP: 3 } as const;

/**
 * Belt 9's first tile: the source -> factory run (`demo_scene.ron`,
 * `DrawBelt(cells: [(2, 3), (3, 3)])`). Two tiles, so eight slots.
 */
const BELT9_TILE: readonly [number, number] = [2, 3];

/**
 * Belt 10's first tile: the factory -> tee run (`DrawBelt(cells: [(7, 3), (8, 3)])`).
 * Two tiles, so eight slots, which is why `items === 8` below is the FULL belt and
 * not an arbitrary threshold. The same cell `23-belt-pace.spec.ts` selects and
 * `18-refusal.spec.ts` places onto.
 */
const BELT10_TILE: readonly [number, number] = [7, 3];

/**
 * A tile of the Tee's second branch, the belt the clause calls "belt 12, the long branch".
 * Since plan 85-08 that branch is the three-cell audit copy belt (11,4) (12,4) (13,4) into
 * the Audit sink at (14,4) (it was the twelve-cell run through (15,4) into a sink at
 * (22,5)); (12,4) is its middle tile. This is one of the two belts whose pace is slowed;
 * since phase 87 slowing it ALONE leaves the Tee feeding its short branch, so it is slowed with
 * {@link BELT11_TILE}, and the two together are what make the Tee unable to place the output of
 * one step and therefore what starts the jam.
 */
const BELT12_TILE: readonly [number, number] = [12, 4];

/**
 * A tile of the Tee's FIRST branch, the short branch (11,3) (12,3) (12,2) (12,1) (13,1) into the
 * Router (the demo's handle 20; the clause's "belt 11"). (12,2) lies on that branch only. Since
 * phase 87 (JAM-02, D-04) it is slowed as well: one slowed branch no longer stops the Tee, so
 * the stall this spec grades needs BOTH branches busy at once.
 */
const BELT11_TILE: readonly [number, number] = [12, 2];

/** The demo Source's anchor cell (`Place(kind: 0, cell_x: 1, cell_y: 3)`). */
const SOURCE_CELL: readonly [number, number] = [1, 3];

/** The demo Tee's anchor cell (`Place(kind: 3, cell_x: 9, cell_y: 3)`), 2x2. */
const TEE_CELL: readonly [number, number] = [9, 3];

/** A belt of two tiles holds `SLOTS_PER_TILE * 2` = 8 items when every slot is full. */
const BELT_FULL_ITEMS = 8;

/**
 * The slow end of the shipped pace scale. `BeltConfigBody`'s `PACE_STEPS` is
 * `[2, 4, 5, 10, 20]` ticks mapping to 250/125/100/50/25 px per second, so the 25
 * px/sec segment is the 20-tick step: ten times slower than the default.
 */
const SLOW_END_LABEL = '25';
const SLOW_END_TICKS = 20;

/** The Source's Timer interval, in sim ticks, for this walk. */
const FAST_TIMER_TICKS = '2';

/** How many CONSECUTIVE reads must carry the jammed shape before it is believed. */
const SUSTAINED_READS = 3;

/** One belt off the model, found by a cell its path occupies. */
function beltAt(
  scene: SceneFacts,
  cell: readonly [number, number],
): SceneFacts['belts'][number] | undefined {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/** Select the belt whose path covers `cell` and wait for its config body to mount. */
async function selectBeltAt(page: Page, cell: readonly [number, number]): Promise<number> {
  const belt = beltAt(await readScene(page), cell);
  expect(belt, `a demo belt really occupies (${cell[0]},${cell[1]})`).toBeTruthy();
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await clickAt(page, at.x, at.y);
  await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 15_000 });
  return (belt as SceneFacts['belts'][number]).id;
}

test.describe('PILE-07 / PILE-08 on the real host: the pile forms, upstream, and is drawn', () => {
  test('the head tile holds on both belts, belt 10 before belt 9, with a BACKED_UP mark that was painted', async ({
    page,
  }) => {
    // Installed BEFORE goto so a boot-time throw is caught too.
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);

    await expectRenderLoopAlive(page, 'before the pace and trigger gestures');
    errs.assertNone('before the pace and trigger gestures');

    // -----------------------------------------------------------------------
    // 1. SLOW THE LONG BRANCH through the shipped Belt pace control.
    // -----------------------------------------------------------------------
    const belt12 = await selectBeltAt(page, BELT12_TILE);
    // VACUITY REFUSAL, the shape `23-belt-pace.spec.ts` uses: the pace being
    // committed must genuinely differ from the one the belt already holds, or the
    // settle below would resolve on the first read against a host that did nothing.
    expect(
      beltAt(await readScene(page), BELT12_TILE)?.ticksPerSlot,
      `the long branch must not already sit at ${SLOW_END_TICKS} ticks/slot, or slowing it proves nothing`,
    ).not.toBe(SLOW_END_TICKS);
    await page
      .getByRole('group', { name: 'Belt pace' })
      .getByRole('button', { name: `${SLOW_END_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect
      .poll(async () => (await readScene(page)).belts.find((b) => b.id === belt12)?.ticksPerSlot, {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'the slowed pace reached the long branch in the MODEL, off the render packet',
      })
      .toBe(SLOW_END_TICKS);

    // -----------------------------------------------------------------------
    // 1b. SLOW THE SHORT BRANCH TOO (PHASE 87, JAM-02, D-04), by the same gesture and to the
    //     same pace, so that EVERY Tee branch is busy and the Tee stalls.
    // -----------------------------------------------------------------------
    const belt11 = await selectBeltAt(page, BELT11_TILE);
    expect(
      belt11,
      'the short branch is a different belt from the long branch, or slowing it adds nothing',
    ).not.toBe(belt12);
    expect(
      beltAt(await readScene(page), BELT11_TILE)?.ticksPerSlot,
      `the short branch must not already sit at ${SLOW_END_TICKS} ticks/slot, or slowing it proves nothing`,
    ).not.toBe(SLOW_END_TICKS);
    await page
      .getByRole('group', { name: 'Belt pace' })
      .getByRole('button', { name: `${SLOW_END_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect
      .poll(async () => (await readScene(page)).belts.find((b) => b.id === belt11)?.ticksPerSlot, {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: 'the slowed pace reached the short branch in the MODEL, off the render packet',
      })
      .toBe(SLOW_END_TICKS);
    expect(
      (await readScene(page)).belts.find((b) => b.id === belt12)?.ticksPerSlot,
      'the long branch is still slowed after the short branch is',
    ).toBe(SLOW_END_TICKS);

    // -----------------------------------------------------------------------
    // 2. OPEN THE TAP through the shipped Source Trigger control.
    // -----------------------------------------------------------------------
    await selectMachineAt(page, SOURCE_CELL[0], SOURCE_CELL[1]);
    await pressSegment(page, 'Trigger', 'Timer');
    await fillPanelField(page, 'fab-timer-interval', FAST_TIMER_TICKS);
    await applyConfig(page);

    // -----------------------------------------------------------------------
    // 3. THE SAMPLER. One fixed-cadence poll owns BOTH readings, because they are
    //    readings of the same run: the first sim tick at which each belt's head is
    //    seen occupied, and the run of consecutive reads carrying the jammed shape.
    //
    //    `expect.poll` with a predicate, never a fixed sleep (the live project's
    //    locked drive rule). The cadence is pinned to one interval rather than the
    //    100/250/500 ladder `pollScene` uses, because an ACCELERATING cadence would
    //    make the resolution of the ordering below depend on how long the jam took
    //    to arrive - the sampler must not sample coarsely exactly when the thing it
    //    is timing happens.
    //
    //    The first observations are recorded on the SIM TICK, not on a poll index:
    //    the sim clock is the model's own, so the ordering claim survives a loaded
    //    box that stretches the wall-clock gaps between reads.
    // -----------------------------------------------------------------------
    const firstHeadTick: { belt9?: number; belt10?: number } = {};
    let sustained = 0;
    await expect
      .poll(
        async () => {
          const scene = await readScene(page);
          const belt9 = beltAt(scene, BELT9_TILE);
          const belt10 = beltAt(scene, BELT10_TILE);
          if (belt10?.headOccupied && firstHeadTick.belt10 === undefined) {
            firstHeadTick.belt10 = scene.tick;
          }
          if (belt9?.headOccupied && firstHeadTick.belt9 === undefined) {
            firstHeadTick.belt9 = scene.tick;
          }
          const jammed =
            belt10?.headOccupied === true &&
            belt10?.items === BELT_FULL_ITEMS &&
            belt9?.headOccupied === true;
          sustained = jammed ? sustained + 1 : 0;
          return sustained;
        },
        {
          timeout: 45_000,
          intervals: [150],
          message:
            `PILE-07: across ${SUSTAINED_READS} CONSECUTIVE reads belt 10 holds its head tile and ` +
            `carries all ${BELT_FULL_ITEMS} of its slots, and belt 9 holds its head tile too. ` +
            'The measured baseline is seven of eight with the head EMPTY, so the head is the bit ' +
            'that is structurally absent and a single read of it could be a head merely waiting ' +
            'for its next advance.',
        },
      )
      .toBeGreaterThanOrEqual(SUSTAINED_READS);

    // -----------------------------------------------------------------------
    // 4. THE CASCADE ORDER - the genuinely independent second signal.
    // -----------------------------------------------------------------------
    console.log(`PILE07_FIRST_HEAD_TICK ${JSON.stringify(firstHeadTick)}`);
    expect(
      firstHeadTick.belt10,
      'belt 10 was observed holding its head tile at some sim tick',
    ).toBeDefined();
    expect(
      firstHeadTick.belt9,
      'belt 9 was observed holding its head tile at some sim tick',
    ).toBeDefined();
    expect(
      firstHeadTick.belt10 as number,
      'the jam PROPAGATES UPSTREAM: belt 10, the run pressed against the Tee, retains its head ' +
        'STRICTLY BEFORE belt 9 one machine further back does. A jam that appeared everywhere at ' +
        'once, or that started at the Source, would fail here while every count assertion above ' +
        'still passed',
    ).toBeLessThan(firstHeadTick.belt9 as number);

    // -----------------------------------------------------------------------
    // 5. THE MACHINE HOLDING THE LINE UP: the byte AND the paint.
    // -----------------------------------------------------------------------
    const jammedScene = await readScene(page);
    const tee = nodeAtAnchor(jammedScene, TEE_CELL[0], TEE_CELL[1]);
    expect(tee, `the demo Tee is seated at (${TEE_CELL[0]},${TEE_CELL[1]})`).toBeDefined();
    expect(
      (tee as SceneFacts['nodes'][number]).state,
      'the Tee reports the fourth state: its mechanical inbox is AT the admission cap and it is ' +
        'refusing further belt deliveries (PILE-08 check 3, the model half)',
    ).toBe(STATE_TAG.BACKED_UP);
    expect(
      await backedUpMarkPaintedOn(page, (tee as SceneFacts['nodes'][number]).id),
      'the BACKED_UP load gauge is actually PAINTED on THE TEE at this same moment (PILE-08 ' +
        'check 3, the render half). A build whose drawLoadGauge regressed satisfies the state ' +
        'assertion above over a canvas that drew nothing, which is the recorded model-oracle ' +
        'blind spot of this repository rather than a hypothesis. SCOPED TO THE TEE (71-review ' +
        'WR-05): the board-wide backedUpMarksPainted() counts ANY node whose gauge plotted ' +
        'geometry, which drawLoadGauge does at levels 1..3 too, so a regression confined to ' +
        'the merged-full-bar branch - the branch that IS the BACKED_UP cue - left this machine ' +
        'drawing nothing while the Factory, Router and Merge upstream kept the count non-zero. ' +
        'The message named one machine; only this probe can check one machine',
    ).toBe(true);

    await expectRenderLoopAlive(page, 'with the board jammed');
    errs.assertNone('during the backpressure cascade');
  });
});
