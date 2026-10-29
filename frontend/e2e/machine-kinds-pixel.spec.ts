import { test, expect, type Browser, type Page } from '@playwright/test';

// machine-kinds-pixel.spec.ts (GATE-05, plan 92-06, decisions D-11 and D-12; closes the
// coverage gap WINDOWS rows 19 and 28 record) - a pixel baseline for every machine kind a
// user can place, for a FAULTED Factory carrying all three port roles, for a FAULTED Sink
// and for a WORKING Factory, each drawn by the SHIPPED machine layer.
//
// WHY IT EXISTS. Before it, only the Factory and the Route were pictured through
// `createMachineLayer` (as furniture on the two wire surfaces of `pixel-guard.spec.ts`),
// the Router only through primitives and with no nubs, and all of them IDLE. Measured at
// the phase's start revision: deleting one `<path>` from `source.svg`, making
// `drawAlertRing` a no-op and changing `LABEL_FILL_ALPHA` each left every committed pixel
// baseline green.
//
// WHAT IT READS. `/pixel-guard.html` surface (g), `#surface-machine-kinds`: ONE Pixi
// Application (the page's ninth) on the page's shipped contract (antialias off,
// resolution 1, no ticker, one explicit render), mounting the real
// `createMachineLayer(LOCKED_SKIN, () => 1)` over one node per slot built from
// `catalogEntry(kind)`. Each slot is the footprint plus one empty cell on every side, and
// each test screenshots its slot through a transparent clip div `[data-kind-cell=<name>]`,
// so a broken kind reddens its own PNG and leaves the rest green.
//
// THE FAULTED RING IS PICTURED AT ITS PEAK (92-RESEARCH Finding F). One frame is drawn for
// every node, and the ring's alpha depends on the frame and on the machine's origin cell,
// so the faulted Sink sits at (8, 10), which shares the faulted Factory's phase. The
// fixture searches for the first frame at which both rings are at least 0.75 (frame 3,
// both at 0.80) and publishes the frame and both alphas, read back off the drawn rings, on
// the readout. The last test asserts them, so a phase change that would picture the ring
// at its 0.25 floor fails here by name instead of blessing a faint ring.
//
// BLESSED ONCE, AFTER THE ART IT DEPENDS ON (D-12): after plan 92-01's fault cap and
// placement-ghost change and plan 92-04's cable colour (neither touches the machine layer,
// so the bytes would be the same either way; the order is kept anyway). Regenerate only
// from `frontend/`, naming this spec, with a fresh Vite:
//
//   CI=1 npx playwright test e2e/machine-kinds-pixel.spec.ts --update-snapshots
//
// Never a bare `--update-snapshots`: that re-shoots the `dpr-crispness` PNGs, four of
// which belong to the DPR spec and are regenerated only with it. Every regenerated PNG is opened and read before it is
// committed.
//
// THAT EACH BASELINE CAN FAIL is proved by `scripts/prove-machine-kinds-baselines-bite.sh`,
// which breaks each kind's art in a private worktree (one `<path>` per SVG, the Handler's
// subject, the label fill, the ring, the fault outline, the fault nub, the working notch)
// and asserts exactly the PNGs that art reaches redden, with their pixel counts, while
// every other one stays green.
//
// TOLERANCE: `maxDiffPixels: 0` under the configs' pinned `threshold: 0`, the same EXACT
// options as `pixel-guard.spec.ts`, for the same three reasons (antialias off, resolution
// pinned, GL backend pinned). Every machine on the canvas is still in the drawn frame.

const EXACT: { maxDiffPixels: number } = { maxDiffPixels: 0 };

/**
 * Open the fixture at DPR 1, wait for its ready marker and hand the page to `check`.
 * DPR is pinned so the backing-store size does not vary with the host display density;
 * the readout is an out-of-flow marker (display:none), so it is waited for as ATTACHED.
 */
async function onFixture(browser: Browser, check: (page: Page) => Promise<void>): Promise<void> {
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto('/pixel-guard.html');
    await page.locator('#pixel-guard-readout[data-fixture-ready="1"]').waitFor({ state: 'attached' });
    await check(page);
  } finally {
    await ctx.close();
  }
}

// One test per slot, in the fixture's `KIND_SLOTS` order, each written out so its
// baseline name is greppable and a failure names its own kind.
test('machine kinds pixel: kind-factory', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-factory"]')).toHaveScreenshot('kind-factory.png', EXACT);
  });
});

test('machine kinds pixel: kind-http-handler', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-http-handler"]')).toHaveScreenshot('kind-http-handler.png', EXACT);
  });
});

test('machine kinds pixel: state-faulted-factory', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="state-faulted-factory"]')).toHaveScreenshot('state-faulted-factory.png', EXACT);
  });
});

test('machine kinds pixel: state-working-factory', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="state-working-factory"]')).toHaveScreenshot('state-working-factory.png', EXACT);
  });
});

test('machine kinds pixel: kind-router', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-router"]')).toHaveScreenshot('kind-router.png', EXACT);
  });
});

test('machine kinds pixel: kind-tee', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-tee"]')).toHaveScreenshot('kind-tee.png', EXACT);
  });
});

test('machine kinds pixel: kind-balancer', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-balancer"]')).toHaveScreenshot('kind-balancer.png', EXACT);
  });
});

test('machine kinds pixel: kind-merge', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-merge"]')).toHaveScreenshot('kind-merge.png', EXACT);
  });
});

test('machine kinds pixel: kind-label', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-label"]')).toHaveScreenshot('kind-label.png', EXACT);
  });
});

test('machine kinds pixel: kind-source', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-source"]')).toHaveScreenshot('kind-source.png', EXACT);
  });
});

test('machine kinds pixel: kind-sink', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-sink"]')).toHaveScreenshot('kind-sink.png', EXACT);
  });
});

test('machine kinds pixel: kind-route', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="kind-route"]')).toHaveScreenshot('kind-route.png', EXACT);
  });
});

test('machine kinds pixel: state-faulted-sink', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    await expect(page.locator('[data-kind-cell="state-faulted-sink"]')).toHaveScreenshot('state-faulted-sink.png', EXACT);
  });
});

test('machine kinds pixel: both faulted rings are pictured at their peak', async ({ browser }) => {
  await onFixture(browser, async (page) => {
    const readout = page.locator('#pixel-guard-readout');
    const frame = await readout.getAttribute('data-kinds-frame');
    expect(frame, 'the fixture publishes the frame it drew').toMatch(/^\d+$/);
    for (const which of ['factory', 'sink'] as const) {
      const alpha = Number(await readout.getAttribute(`data-ring-alpha-faulted-${which}`));
      expect(alpha, `the faulted ${which}'s ring alpha in frame ${frame}`).toBeGreaterThanOrEqual(0.75);
    }
  });
});
