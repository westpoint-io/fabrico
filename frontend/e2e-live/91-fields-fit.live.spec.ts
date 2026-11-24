import { test, expect, type Page } from './support/liveTest';
import {
  anchorOf,
  expectRenderLoopAlive,
  readScene,
  resetToDemo,
  restoreHostAfterFailedTest,
  selectMachineAt,
  waitForAppReady,
  watchPageErrors,
} from './support/oracle';

// 91-fields-fit.live.spec.ts (phase 91, plan 91-08, CHROME-14, D-08, success criterion 2, UI-SPEC
// section 4 and walk step 6) - the inspector's fields fit their panel in the app's own theme, on
// the REAL host (dev_render_server, real Core -> RenderProducer -> postcard -> WS). Zero mocks,
// zero injected packets: the machines are the demo board's own.
//
// ---------------------------------------------------------------------------
// WHAT WAS BROKEN (91-MEASURE.md `## CHROME-14: still broken`)
// ---------------------------------------------------------------------------
//
// The Route `Path` field was `width: 100%` on a content-box `.fab-field` (padding 0 8 px and a
// 1 px border on top of the full width), so its box ran 18 px past the scroll column's content
// edge and 2 px past the column itself, and the Route panel grew a horizontal scrollbar.
//
// ---------------------------------------------------------------------------
// THE LEGS, GRADED ON WHAT THE USER SEES
// ---------------------------------------------------------------------------
//
//   1. The demo's Route selected, at 1280x720 and then 1024x768: the Path box ends where Copy and
//      Disconnect end (+-0.5 px, x 1234 at 1280 wide and x 978 at 1024 wide) and the panel's
//      scroll column does not scroll sideways (`scrollWidth === clientWidth`).
//
// The timer-field spinner leg (2) was cut; the field's input type is a component unit concern.
//
// RED FIRST (D-17): each leg run once against PHASE91_START by `redfirst.sh` (the kept start
// worktree's host and frontend, this spec carried in); the record is in 91-EVIDENCE.md.
//
// Render health in every test: `watchPageErrors` before `goto`, `expectRenderLoopAlive` and the
// watcher's `assertNone` at its end (fabrico-model-oracle-blindspot).

/** The Route's kind byte (`machine_kind.ENDPOINT`). */
const KIND_ROUTE = 9;

/** The CONFIG panel (the Palette is an `aside.fab-panel` too). */
function configPanel(page: Page) {
  return page.locator('aside.fab-panel[aria-labelledby="fab-config-heading"]');
}

/** The right edges the Route leg compares, and the scroll column's extents. */
async function readRouteFit(page: Page) {
  const panel = configPanel(page);
  const right = async (l: ReturnType<Page['locator']>): Promise<number> => {
    const b = await l.boundingBox();
    expect(b, 'the element has a box').not.toBeNull();
    return b!.x + b!.width;
  };
  const col = await panel.locator('[data-fab-panel-scroll]').evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      contentRight: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
  return {
    path: await right(panel.locator('#fab-route-path')),
    copy: await right(panel.getByRole('button', { name: 'Copy', exact: true })),
    disconnect: await right(panel.getByRole('button', { name: /^Disconnect/ }).first()),
    ...col,
  };
}

test.describe('91 live: the inspector fields fit their panel (CHROME-14)', () => {
  test.afterEach(async ({ page }, testInfo) => {
    await restoreHostAfterFailedTest(page, testInfo);
  });

  test('1: the Route path fits beside Copy and Disconnect, and the column never scrolls sideways', async ({
    page,
  }) => {
    const errs = watchPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);

    const route = (await readScene(page)).nodes.find((n) => n.kind === KIND_ROUTE);
    expect(route, 'the demo board carries a Route').toBeDefined();
    await selectMachineAt(page, ...anchorOf(route!));
    const panel = configPanel(page);
    await expect(panel.locator('#fab-route-path'), 'the Route panel shows its Path').toBeVisible({ timeout: 10_000 });
    await expect(panel.getByRole('button', { name: 'Copy', exact: true }), 'the POST URL row loaded').toBeVisible({
      timeout: 10_000,
    });
    await expect(
      panel.getByRole('button', { name: /^Disconnect/ }).first(),
      'the Route is wired to its Handler, so its row offers Disconnect',
    ).toBeVisible({ timeout: 10_000 });

    for (const size of [
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(size);
      // The panel re-lays out after a resize; read once the Copy edge sits on the content edge.
      await expect
        .poll(async () => {
          const f = await readRouteFit(page);
          return Math.abs(f.copy - f.contentRight) <= 0.5;
        }, { message: `${size.width}x${size.height}: the panel settled after the resize`, timeout: 10_000 })
        .toBe(true);
      const f = await readRouteFit(page);
      const line = `${size.width}x${size.height} ${JSON.stringify(f)}`;
      console.log(`P91-CHROME-14 route ${line}`);
      expect(Math.abs(f.path - f.copy), `the Path ends where Copy ends (${line})`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(f.path - f.disconnect), `the Path ends where Disconnect ends (${line})`).toBeLessThanOrEqual(0.5);
      expect(f.scrollWidth, `the Route panel's column does not scroll sideways (${line})`).toBe(f.clientWidth);
    }

    await expectRenderLoopAlive(page, 'after the Route panel at two sizes');
    errs.assertNone('the Route path fit walk');
  });
});
