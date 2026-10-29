import { test, expect } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  anchorOf,
  demoCallerAndHandler,
  expectHeadOn,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  resetToDemo,
  selectMachineAt,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
} from './support/oracle';

// 28-undo-restores-the-cable.spec.ts (UNDO-01, plan 73-03) - the LIVE proof, on the real
// host and the SHIPPED demo board, that a user can press `Disconnect` on a wire row,
// press Ctrl+Z, and get the cable back with nothing written across the top of the screen.
//
// ───────────────────── WHY THIS ONE IS ON THE DEMO BOARD ON PURPOSE ─────────────────────
//
// Most live specs in this suite start from `newBoard`, because a demo-board spec is the
// classic check that cannot fail: the demo already carries a wired handler, so a spec
// that reaches for "the cable" on it can be green with zero work done. That reasoning is
// INVERTED here and the inversion is the point. The defect UNDO-01 closes is reachable in
// two clicks on the FIRST board every user ever opens: select the caller, press
// `Disconnect`, press Ctrl+Z, and until 73-03 the cable was gone permanently and the app
// said only that the host could not carry out the gesture. The shipped cable IS the
// subject. A `newBoard` spec here would prove the fix for a cable the user drew and say
// nothing about the one they were given.
//
// ─────────────────────────── THE SILENCE HALF IS LATCHED ───────────────────────────
//
// `#fab-refusal` is EMPTY AT REST, so a single read after the gesture that finds an empty
// string passes on three different builds: the one that restores the cable (correct), the
// one where Ctrl+Z does nothing at all (wrong), and the one where the React tree failed to
// mount (worse). Worse still, `REFUSAL_HOLD_MS` is 4000, so a post-hoc read can only FAIL
// if it lands inside a four-second window it is not scheduled against.
//
// So the negative half runs through `expectRefusalStayedSilent`, which polls the region on
// the same `[100, 250, 500]` ladder `18-refusal.spec.ts` uses, from BEFORE the keypress
// until the positive assertion resolves, and latches the first non-empty reading it ever
// sees. And it is never asserted alone: the helper takes the positive board assertion as
// its own argument, so a silent region is only ever reported as a pass alongside a cable
// that measurably came back.
//
// The absence is scoped to THIS gesture, not globally. A refusal sentence is still
// correct elsewhere on this build - a refused `RemovePort` on the ERR-01 verdict path is
// the live example - so a spec written as "no refusal ever" would forbid a behaviour that
// is right.
//
// ────────────────────── AND IT ASSERTS THE RENDER LOOP IS ALIVE ──────────────────────
//
// `readScene` reads `window.__fabrico.scene()`, the packet-application buffer, which is
// completely independent of the Pixi ticker. A build whose renderer is DEAD leaves every
// wire assertion below green over a blank canvas. That is this repository's recorded blind
// spot, not a hypothesis, so `watchPageErrors` runs for the whole test and
// `expectRenderLoopAlive` runs after each phase rather than once at the end.
//
// ─────────────────────── THE SHAPE HALF (phase 75, done-test leg 5) ───────────────────────
//
// Done-test leg 5 says the restored cable comes back "routed head-on into both prongs".
// Reading endpoints alone passes on a build that restores both legs on any path at all,
// including one that leaves the handler's east-facing Out heading west, which is what the
// demo's return cable did before phase 75. So the cells of each cable are recorded, keyed by
// its endpoints, before `Disconnect`; after the one Ctrl+Z each restored cable must carry
// the IDENTICAL cell list, and `expectHeadOn` checks its first and last step against the
// sides the scene's own ports report. No test was added for this: it is the same gesture,
// graded on what the user sees as well as what the model links.

// The caller Route is found BY KIND (`demoCallerAndHandler`, plan 85-07): the board's Route
// whose one cable delivers into its HTTP Handler. Until 85-07 this was the cell (10,6).

/**
 * The caller's electrical `Out` row in the Ports region: the row the forward leg leaves
 * from - the same control name `25-route-and-handler.spec.ts` presses. (Until 85-07 the
 * demo caller declared exactly one port, that Out; a palette Route also carries an In, and
 * the Out row keeps this name either way.)
 */
const DISCONNECT_CONTROL_NAME = 'Disconnect Output - Wire';

/** A cable identified by its ENDPOINTS, never by its own id. */
interface CableEnds {
  from: { node: number; port: number };
  to: { node: number; port: number };
}

/**
 * The set of live cables, keyed by endpoints and SORTED, with each wire's own id dropped.
 *
 * The id is dropped deliberately and this is the whole assertion discipline of the file: a
 * restored wire is a NEWLY MINTED node with a new id, so an id-carrying comparison could
 * never pass, and a bare COUNT comparison passes on a build that restored one leg and
 * dropped the other. What a user means by "the same cable" is the same two endpoints, so
 * that is exactly what is read and compared.
 */
function cableEnds(wires: { from: CableEnds['from']; to: CableEnds['to'] }[]): string[] {
  return wires.map(endsKey).sort((a, b) => a.localeCompare(b));
}

/** One cable's endpoint key, the same string `cableEnds` sorts. */
function endsKey(w: CableEnds): string {
  return `${w.from.node}:${w.from.port} -> ${w.to.node}:${w.to.port}`;
}

/** Each cable's routed cells, keyed by its endpoints (the id is dropped for the reason above). */
function cellsByEnds(
  wires: (CableEnds & { path: { cell_x: number; cell_y: number }[] })[],
): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  for (const w of wires) out[endsKey(w)] = w.path.map((c) => [c.cell_x, c.cell_y]);
  return out;
}

test.describe('UNDO-01: the cable comes back', () => {
  test('Disconnect then Ctrl+Z restores the shipped cable, with the refusal region silent throughout', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page, DEMO_NODE_COUNT);
    await waitForCameraSettle(page);
    errs.assertNone('after the demo boot');

    // ── 1. THE CABLE AS SHIPPED, read off the board rather than written down ──
    const before = await readScene(page);
    const endsBefore = cableEnds(before.wires);
    expect(
      endsBefore.length,
      "the shipped demo board carries the two legs of its caller and handler's cable",
    ).toBe(2);
    // The shape half (done-test leg 5): the cells each cable runs on, keyed by endpoints.
    const cellsBefore = cellsByEnds(before.wires);
    await expectRenderLoopAlive(page, 'on the shipped demo board');

    // ── 2. THE GESTURE A USER REACHES IN TWO CLICKS: select, Disconnect ──
    const { caller, handler } = await demoCallerAndHandler(page);
    await expectRenderLoopAlive(page, 'right after finding the demo pair by kind');
    expect(
      before.wires.every(
        (w) =>
          (w.from.node === caller.id && w.to.node === handler.id) ||
          (w.from.node === handler.id && w.to.node === caller.id),
      ),
      'both shipped legs run between the demo caller and its handler, found by kind',
    ).toBe(true);
    await selectMachineAt(page, ...anchorOf(caller));
    await page.getByRole('button', { name: DISCONNECT_CONTROL_NAME }).click();
    await pollScene(page, (s) => s.wires.length, {
      message: 'the Disconnect on the caller Out row took the cable off the board',
    }).toBe(0);
    // MOVE FOCUS OFF THE BUTTON BEFORE THE ACCELERATOR, and this is not tidying: the
    // app-wide LW-02 guard stands the canvas keybindings DOWN - Ctrl+Z included - while a
    // BUTTON holds focus, and the `Disconnect` click leaves focus exactly there. Without
    // this the keypress below is swallowed, the cable never returns, and the test fails
    // for a reason that has nothing to do with the undo. Clicking the panel's own heading
    // is a plain click on a non-focusable element the panel absorbs, so the SELECTION
    // survives it - which is what keeps this the ordinary "click elsewhere, then press
    // undo" flow a user performs, rather than a deselect that would change the board
    // state under test.
    await page.locator('#fab-config-heading').click();
    await expectRenderLoopAlive(page, 'after the disconnect');
    errs.assertNone('after the disconnect');

    // ── 3. CTRL+Z, WITH THE REFUSAL REGION LATCHED ACROSS THE WHOLE WINDOW ──
    //
    // The keypress AND the positive assertion both live inside `until`, so the poll is
    // already running when the key goes down and keeps running until the cable is
    // measurably back. A sentence that flashed for even one ladder step is latched.
    await expectRefusalStayedSilent(page, 'Ctrl+Z after a wire Disconnect', async () => {
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => s.wires.length, {
        message:
          'UNDO-01: one Ctrl+Z put the cable back on the board - until plan 73-03 this ' +
          'undo was refused (Malformed then, UndoDoesNotFit since plan 88-02) and the cable was ' +
          'gone permanently',
      }).toBe(endsBefore.length);
    });

    // ── 4. THE SAME CABLE, NOT MERELY A CABLE ──
    const after = await readScene(page);
    expect(
      cableEnds(after.wires),
      'every restored leg runs between the IDENTICAL (node, port) endpoints it left from',
    ).toEqual(endsBefore);
    expect(
      after.nodes.length,
      'and the undo restored the cable without disturbing the machines around it',
    ).toBe(before.nodes.length);

    // ── 5. ON THE SAME CELLS, PLUGGED IN HEAD-ON (done-test leg 5) ──
    expect(
      cellsByEnds(after.wires),
      'every restored leg runs on the IDENTICAL cells it ran on before the Disconnect',
    ).toEqual(cellsBefore);
    for (const w of after.wires) {
      expectHeadOn(after, w, `the restored cable ${endsKey(w)}`);
    }

    await expectRenderLoopAlive(page, 'after the undo restored the cable');
    errs.assertNone('after the undo restored the cable');
  });
});
