import { test, expect, type Page } from '@playwright/test';
import { EMPTY_FLOOR_BODY, EMPTY_FLOOR_HEADING } from '../src/chrome/configCopy';
import {
  armAndPlaceAt,
  expectRenderLoopAlive,
  nodeAtAnchor,
  pollScene,
  restoreHostAfterFailedTest,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';
import { emptyBoardAtScaleOne } from './support/beltBoard';

// 91-empty-board.live.spec.ts (phase 91, plan 91-05, CHROME-10, D-10, success criterion 4,
// UI-SPEC 8.2 and walk step 12) - the empty board tells the truth on the REAL host
// (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks, zero injected
// packets.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-10`, todo 2026-10-06 "empty floor hint lingers")
// ---------------------------------------------------------------------------
//
// The empty board said to drag a machine from the palette and to load the demo scene. The
// palette arms on a click and places on a floor click, and the demo moved into the Examples
// popover. And the hint was mounted off the 100 ms chrome poll, so after the first machine
// landed it stayed on screen over the drawn machine for several frames.
//
// ---------------------------------------------------------------------------
// THE LEG, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   On an empty board the hint reads `EMPTY_FLOOR_HEADING` and `EMPTY_FLOOR_BODY` (imported
//   from `src/chrome/configCopy.ts`, never retyped). A `requestAnimationFrame` probe then runs
//   over arming the Factory from the palette and a floor click: every frame it records whether
//   the hint's heading is on screen (in the DOM and visible by computed style) and how many
//   machines the machine layer has DRAWN (`__fabrico.drawnNodes()`, the Pixi display list), not
//   what the model holds. The Factory appears in the scene, the hint is gone, and no recorded
//   frame held both.
//
// RED FIRST (D-17): the leg was run by `redfirst.sh` at PHASE91_START in the kept start worktree
// (the frontend and host of that revision, this spec and `configCopy.ts` carried in) and failed
// there (91-EVIDENCE.md, `D17 case=CHROME-10-live`).
//
// Render health in the test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

const KIND_FACTORY = 2;
/** The Factory's drop cell, on the open floor of an empty board at camera scale 1. */
const FACTORY_CELL = [10, 10] as const;

/** One animation frame as the probe saw it: is the hint on screen, and how many machines are drawn. */
interface ProbeFrame {
  hint: boolean;
  drawn: number;
}

/** Start the per-frame probe: the hint's computed visibility and the machine layer's drawn count. */
async function startHintProbe(page: Page): Promise<void> {
  await page.evaluate((heading) => {
    const w = window as unknown as {
      __fabrico: { drawnNodes(): { machines: number[] } };
      __hintProbe?: { frames: { hint: boolean; drawn: number }[]; stop: boolean };
    };
    const probe = { frames: [] as { hint: boolean; drawn: number }[], stop: false };
    w.__hintProbe = probe;
    const step = (): void => {
      const h = Array.from(document.querySelectorAll('h2')).find((e) => (e.textContent ?? '').trim() === heading);
      const on = h !== undefined && h.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      probe.frames.push({ hint: on, drawn: w.__fabrico.drawnNodes().machines.length });
      if (!probe.stop) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, EMPTY_FLOOR_HEADING);
  // Two frames recorded before the caller acts, so the probe has seen the board as it was.
  await page.waitForFunction(
    () => ((window as unknown as { __hintProbe?: { frames: unknown[] } }).__hintProbe?.frames.length ?? 0) >= 2,
  );
}

/** Stop the probe after `settle` more frames and return every frame it recorded. */
async function stopHintProbe(page: Page, settle = 10): Promise<ProbeFrame[]> {
  return page.evaluate(async (n) => {
    const w = window as unknown as { __hintProbe: { frames: { hint: boolean; drawn: number }[]; stop: boolean } };
    for (let i = 0; i < n; i += 1) await new Promise<void>((r) => requestAnimationFrame(() => r()));
    w.__hintProbe.stop = true;
    return w.__hintProbe.frames;
  }, settle);
}

/** How many machines the machine layer has drawn. */
function drawnMachines(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __fabrico: { drawnNodes(): { machines: number[] } } }).__fabrico.drawnNodes().machines.length,
  );
}

test.describe('91 live: the empty board describes click to place and hides with the first machine (CHROME-10)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('the empty board reads the shared copy, and no frame shows it over the first drawn Factory', async ({ page }) => {
    const errs = watchPageErrors(page);
    // The hide commits with `flushSync` from the socket handler (research A6); React warns on the
    // console if that call lands inside a render or an effect, so any such warning fails the leg.
    const flushWarnings: string[] = [];
    page.on('console', (m) => {
      if (m.text().includes('flushSync')) flushWarnings.push(`${m.type()}: ${m.text()}`);
    });
    await page.goto('/');
    await waitForAppReady(page);
    await emptyBoardAtScaleOne(page, [FACTORY_CELL]);

    // 1. The words, read off the page. The body check is soft so a wrong body still lets the
    //    probe below report its own reading; either one failing fails the test.
    const heading = page.getByRole('heading', { name: EMPTY_FLOOR_HEADING, exact: true });
    await expect(heading, 'the empty board shows its heading').toBeVisible();
    await expect
      .soft(page.getByText(EMPTY_FLOOR_BODY, { exact: true }), 'the body says the gestures that work')
      .toBeVisible();
    expect(await drawnMachines(page), 'PRECONDITION: the machine layer draws nothing on the empty board').toBe(0);

    // 2. The probe over arming the Factory from the palette and a floor click.
    await startHintProbe(page);
    await armAndPlaceAt(page, 'Factory', FACTORY_CELL[0], FACTORY_CELL[1]);
    await pollScene(page, (s) => nodeAtAnchor(s, FACTORY_CELL[0], FACTORY_CELL[1])?.kind ?? -1, {
      message: 'the hand-placed Factory folded at its drop cell on the real host',
    }).toBe(KIND_FACTORY);
    await expect.poll(() => drawnMachines(page), { message: 'the machine layer drew the Factory' }).toBe(1);
    await expect(heading, 'the hint is gone once the Factory is on the board').toBeHidden();
    const frames = await stopHintProbe(page);

    const overlap = frames.filter((f) => f.hint && f.drawn > 0).length;
    console.log(
      `P91-CHROME-10 live frames=${frames.length} hint_only=${frames.filter((f) => f.hint && f.drawn === 0).length} overlap=${overlap} drawn_only=${frames.filter((f) => !f.hint && f.drawn > 0).length}`,
    );
    // NON-VACUITY: the probe saw the hint alone before the click and the Factory alone after.
    expect(frames.some((f) => f.hint && f.drawn === 0), 'PRECONDITION: the probe saw the empty board with its hint').toBe(true);
    expect(frames.some((f) => !f.hint && f.drawn > 0), 'PRECONDITION: the probe saw the drawn Factory without the hint').toBe(true);
    expect(overlap, 'no animation frame shows the hint and a drawn machine together').toBe(0);

    expect(flushWarnings, 'React raised no flushSync warning').toEqual([]);
    await expectRenderLoopAlive(page, 'after the first Factory is placed on the empty board');
    errs.assertNone('the empty-board walk');
  });
});
