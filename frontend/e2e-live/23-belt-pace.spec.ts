import { test, expect, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  clickAt,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  screenCellCentre,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 23-belt-pace.spec.ts (BELT-01 / BELT-02 / BELT-04, plan 68-06) - the belt pace
// panel driven against the REAL `dev_render_server`, zero mocks.
//
// THIS FILE IS SC4's EVIDENCE AND NOTHING ELSE COULD BE. `D-68-04` keeps ONE
// out-of-range path reachable from the shipped UI - the typed pace field carries
// no `min`, no `max`, no `aria-invalid` and no clamp - for exactly one reason:
// so that Phase 64's refusal machinery is exercised by a user-reachable gesture
// on the real app rather than only by a Rust unit test. A bounded-only control
// would make that refusal unreachable while every one of its tests stayed green,
// which is the checks-that-cannot-fail shape Phase 67 surfaced eight times. The
// three legs below walk it: the typed field -> Apply -> the run frame -> the
// command bound -> the typed tag -> the refusal frame -> `#fab-refusal`.
//
// ---------------------------------------------------------------------------
// WHAT THIS SPEC DOES NOT ASSERT
// ---------------------------------------------------------------------------
//
// THE UNDO GROUPING. `D-68-07` requires one Apply on an N-belt run to be exactly
// ONE undo step, and nothing here can see that: the live oracle has no reading of
// action ids, and `canUndo` is a single bool that says an undo exists rather than
// how many. That claim lives in
// `crates/fabrico-host/tests/belt_run_pace.rs`
// (`a_three_belt_run_frame_lands_under_exactly_one_action_id` and
// `one_undo_restores_every_belt_in_the_run`), named here by path so a reader does
// not take this file's green as covering it.
//
// THE WHOLE-RUN FAN-OUT. The demo board's belts are docked to MACHINES at both
// ends, so every run reachable here is a run of ONE. The fan-out over a
// multi-belt run is asserted in the Rust file above and in the mock suite's
// `frontend/e2e/belt-pace.spec.ts` (a three-belt fixture, both ends clicked).
//
// THE LAYOUT. No width, no wrap and no contrast reading is taken here; those need
// a settled box and a loaded font and they live in the mock suite, at the 992px
// ledgered minimum, where they can be measured against a shipped comparator in a
// single run.
//
// WHAT IT DOES ASSERT, and why each half is mandatory: both refusal sentences by
// EXACT STRING EQUALITY (a Phase 67 mutation dropped a trailing word and stayed
// green under a `toContain` pin), the MODEL's own reading of the belt's pace on
// either side of the gesture, and - on every leg - that the renderer is still
// alive. That last one is not belt-and-braces: **the live oracle reads only the
// MODEL, so a spec asserting a sentence and a state passes with a completely dead
// renderer**, and that is a recorded, previously-shipped defect in this
// repository on exactly this kind of change.

/**
 * The cell this spec clicks to select a belt: belt 10's first tile in the demo
 * scene (`demo_scene.ron`, `DrawBelt(cells: [(7, 3), (8, 3)])` - the factory ->
 * tee run). The same cell `18-refusal.spec.ts` places onto to provoke
 * `FootprintCollision`, so it is a cell whose belt-tile occupancy is already
 * asserted elsewhere in this suite.
 */
const BELT_TILE: readonly [number, number] = [7, 3];

/**
 * The exact `REFUSAL_COPY.PaceOutOfRange` sentence, transcribed not imported -
 * the live suite's zero-mock rule forbids importing product source into the
 * oracle's own assertions. Asserted by `toBe`, NEVER by `toContain`.
 */
const PACE_OUT_OF_RANGE_COPY = 'That pace is outside the Belt pace scale.';

/**
 * The exact `REFUSAL_COPY.ZeroBeltInterval` sentence, UNCHANGED since Phase 64.
 *
 * **This leg is the first time in the project's history that this sentence has
 * been reachable by a user.** It shipped with the tag in 64 and had no gesture
 * that could produce it: no control wrote `ticks_per_slot` at all until BELT-02,
 * and the sentence carried a standing re-verify instruction (`RefusalMessage.tsx`)
 * against the day one did. `D-68-04`'s unclamped field is that day.
 */
const ZERO_BELT_INTERVAL_COPY = 'A belt needs a speed above zero.';

/**
 * The WALL figure: the px/sec the panel's own scale calls out of range.
 *
 * 500 px/sec resolves to `ticks_per_slot = 1`, which is BELOW the `2..=20` bound
 * `fabrico-command` enforces (68-UI-SPEC 5.2's table: "the wall figure (500) ->
 * 1 -> PaceOutOfRange"). It is typed rather than pressed because no segment
 * offers it - that is the whole point of the typed field.
 */
const WALL_FIGURE = '500';

/** A typed zero: a stopped belt, which reaches the belt-interval sentence. */
const ZERO_FIGURE = '0';

/** The slow end of the offered scale: `25` px/sec is `ticks_per_slot = 20`. */
const SLOW_END_LABEL = '25';
const SLOW_END_TICKS = 20;

/**
 * Poll the live refusal region's text. The element carries no role and no
 * accessible name by design, so its id is the only handle. The 15s /
 * 100-250-500 ladder is `18-refusal.spec.ts`'s oracle verbatim.
 */
function pollRefusalText(page: Page, message: string) {
  return expect.poll(
    async () => ((await page.locator('#fab-refusal').textContent()) ?? '').trim(),
    { timeout: 15_000, intervals: [100, 250, 500], message },
  );
}

/** The handle of the belt whose tiles include `cell`, off the MODEL. */
async function beltAt(page: Page, cell: readonly [number, number]): Promise<number> {
  const scene = await readScene(page);
  const found = scene.belts.find((b) =>
    b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]),
  );
  expect(found, `a demo belt really occupies (${cell[0]},${cell[1]})`).toBeTruthy();
  return found!.id;
}

/** The MODEL's reading of one belt's advance interval. */
async function paceOf(page: Page, belt: number): Promise<number> {
  const scene = await readScene(page);
  const found = scene.belts.find((b) => b.id === belt);
  expect(found, `belt ${belt} is still in the scene`).toBeTruthy();
  return found!.ticksPerSlot;
}

/**
 * The mandatory preamble, plus the belt selection.
 *
 * THE RESET IS NOT OPTIONAL. `playwright.live.config.ts` runs ONE worker against
 * ONE shared mutable host, so a spec that does not reset inherits whatever the
 * previous spec left on the board - including, for this file, whatever pace a
 * previous leg committed.
 */
async function selectDemoBelt(
  page: Page,
): Promise<{ errs: ReturnType<typeof watchPageErrors>; belt: number }> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await resetToDemo(page, DEMO_NODE_COUNT);

  const belt = await beltAt(page, BELT_TILE);
  const at = await screenCellCentre(page, BELT_TILE[0], BELT_TILE[1]);
  await clickAt(page, at.x, at.y);
  // The Belt arm is gated on `!loading && config`, so this ALSO proves the real
  // host answered `machine_config` for a BELT handle - 68-01's arm, reached
  // through the shipped dev-WS query bridge rather than a canned reply.
  await expect(page.locator('#fab-belt-config')).toBeVisible({ timeout: 15_000 });
  return { errs, belt };
}

/** Type a raw figure into the pace field and press the shipped Apply. */
async function typeAndApply(page: Page, figure: string): Promise<void> {
  await page.locator('#fab-belt-pace').fill(figure);
  await expect(
    page.locator('#fab-belt-pace'),
    'the field holds exactly what was typed - no clamp, no sanitize',
  ).toHaveValue(figure);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}

test.describe('BELT-04 on the real host: the bound answers in words', () => {
  test('the WALL figure typed into the pace field is refused, in the exact sentence', async ({
    page,
  }) => {
    const { errs, belt } = await selectDemoBelt(page);

    // The live region is mounted and SILENT before the gesture: "no message" is
    // an EMPTY region, never an absent element.
    await expect(page.locator('#fab-refusal')).toHaveCount(1);
    expect(((await page.locator('#fab-refusal').textContent()) ?? '').trim()).toBe('');

    const before = await paceOf(page, belt);

    await typeAndApply(page, WALL_FIGURE);

    // EXACT EQUALITY. A `toContain` pin stays green through a sentence that lost
    // its last word, which is a mutation this project has actually shipped.
    await pollRefusalText(
      page,
      'the out-of-range pace named its reason in the live region (SC4, D-68-04)',
    ).toBe(PACE_OUT_OF_RANGE_COPY);

    // A REFUSAL IS A REFUSAL, not a message printed over a completed write. The
    // model's own reading of the belt's pace is unchanged, so the host declined
    // the edit rather than folding it and complaining about it afterwards.
    expect(
      await paceOf(page, belt),
      'the refused pace never reached the belt (no optimistic client write, no fold)',
    ).toBe(before);

    await expectRenderLoopAlive(page, 'after the refused out-of-range pace');
    errs.assertNone('the refused out-of-range pace');
  });

  test('a typed ZERO reaches the belt-interval sentence, reachable for the first time', async ({
    page,
  }) => {
    const { errs, belt } = await selectDemoBelt(page);
    const before = await paceOf(page, belt);

    await typeAndApply(page, ZERO_FIGURE);

    await pollRefusalText(
      page,
      'a typed zero reaches ZeroBeltInterval - the first user-reachable path to it',
    ).toBe(ZERO_BELT_INTERVAL_COPY);

    expect(
      await paceOf(page, belt),
      'a stopped belt is refused, and the belt keeps the pace it had',
    ).toBe(before);

    await expectRenderLoopAlive(page, 'after the refused zero pace');
    errs.assertNone('the refused zero pace');
  });

  test('a pace from the offered scale is ACCEPTED and reaches the belt in the model', async ({
    page,
  }) => {
    const { errs, belt } = await selectDemoBelt(page);
    const before = await paceOf(page, belt);
    // VACUITY REFUSAL: the pace being committed must genuinely differ from the
    // one the belt already holds, or the poll below would resolve on the first
    // read against a host that did nothing at all.
    expect(
      before,
      `the demo belt must not already sit at ${SLOW_END_TICKS} ticks/slot, or this leg proves nothing`,
    ).not.toBe(SLOW_END_TICKS);

    await page
      .getByRole('group', { name: 'Belt pace' })
      .getByRole('button', { name: `${SLOW_END_LABEL} px per second`, exact: true })
      .click();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    // POLLED ON A SPECIFIC MODEL CHANGE, with a message. No fixed sleep appears
    // anywhere in this file: a sleep long enough to be reliable is a sleep that
    // hides how long the round trip actually takes, and one that is too short is
    // a flake with a plausible story.
    await pollScene(
      page,
      (s) => s.belts.find((b) => b.id === belt)?.ticksPerSlot ?? -1,
      { message: 'the committed pace reached the belt in the MODEL, off the render packet' },
    ).toBe(SLOW_END_TICKS);

    // And the accepted gesture said NOTHING: on this transport an accept produces
    // no frame at all (D-30), so the refusal region must still be empty.
    expect(
      ((await page.locator('#fab-refusal').textContent()) ?? '').trim(),
      'an accepted pace produces no refusal frame and therefore no sentence',
    ).toBe('');

    await expectRenderLoopAlive(page, 'after the accepted pace');
    errs.assertNone('the accepted pace');
  });
});
