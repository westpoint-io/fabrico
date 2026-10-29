import { test, expect, type Browser } from '@playwright/test';

// THE CABLE MIN-ZOOM GATE (CABLE-07 at the camera's minimum zoom - plan 75-10).
//
// WHY IT EXISTS. Both walks on the real binary (75-WALK.md GAP LOW-ZOOM) moved a cable at
// 25% zoom and saw little or none of its re-route mark. The cable and the mark were
// stroked at CABLE_WIDTH, 2 world px, which at `MIN_ZOOM` 0.25 is half a screen pixel;
// with antialias off a half-pixel strip covers a pixel centre at some camera origins and
// none at others. Every existing gate drew cables at zoom 1, so none could see it.
//
// IT ASSERTS NUMBERS AND COMMITS NO IMAGE, the `belt-rail-continuity.spec.ts` discipline.
// "Every position along the cable carries ink" is a count. A blessed PNG of a cable that
// had vanished would go green the moment it was blessed. The fixture (`#surface-cable-
// min-zoom` in `src/spike/pixelGuard.tsx`) reads pixels back through Pixi's own extract
// path and publishes, per straight run, how many device positions along the line carry no
// ink within 2 device px across of it; this spec does the arithmetic.
//
// IT SWEEPS 16 CAMERA ORIGINS. At 0.25 every cell centre lands on a whole device pixel and
// the lane puts the cable half a device pixel off it, so one camera position would pass or
// fail by luck.
//
// IT CARRIES ITS OWN FAILING CONTROL, IN THE SAME RUN. Every drawing is made twice: SHIPPED
// hands the layer the zoom (as `pixiApp.ts` does at DPR 1), CONTROL hands it 1, the same
// layer function at its identity argument, which strokes the pre-fix 2 world px. The
// control must show gaps at rest and marked. **A gate that cannot fail is not a gate.**
//
// GATE NOTES. A mock-suite spec; no live file changes. `npx tsc --noEmit` typechecks no e2e
// spec, so the Playwright run is the only gate for this file. The rasteriser here is
// CHROMIUM's (SwiftShader), not the WebKitGTK one Fabrico ships on: Chromium is a backstop
// and the walk on the real binary is the verdict. The width arithmetic the fix rests on is
// rasteriser-independent and is pinned on the CPU in `src/render/layers/wires.test.ts`.

/** One straight run of the drawn cable, as the fixture publishes it. */
interface CableRunReport {
  axis: 'x' | 'y';
  positions: number;
  gaps: number;
}

/** One drawing: one camera origin, one variant, one state. */
interface CableMinZoomReport {
  ox: number;
  oy: number;
  variant: 'shipped' | 'control';
  state: 'rest' | 'marked';
  runs: CableRunReport[];
}

const ORIGINS = [0, 0.25, 0.5, 0.75] as const;

async function readReports(
  browser: Browser,
): Promise<{ reports: CableMinZoomReport[]; antialias: string | null }> {
  // DPR pinned to 1, as `pixel-guard.spec.ts` and `belt-rail-continuity.spec.ts` pin it:
  // the defect is a DEVICE-pixel defect and must not vary with the host display.
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await page.goto('/pixel-guard.html');
    const readout = page.locator('#pixel-guard-readout[data-fixture-ready="1"]');
    await readout.waitFor({ state: 'attached' });
    const raw = await readout.getAttribute('data-cable-min-zoom');
    expect(raw, 'the fixture published no cable-min-zoom payload').toBeTruthy();
    return {
      reports: JSON.parse(raw as string) as CableMinZoomReport[],
      antialias: await readout.getAttribute('data-antialias'),
    };
  } finally {
    await ctx.close();
  }
}

test('the cable and its mark at MIN_ZOOM: no gap along any run, at all 16 camera origins', async ({
  browser,
}) => {
  const { reports, antialias } = await readReports(browser);

  // THE CONDITION FIRST. The walk's failure is an antialias-off failure; on an AA-on
  // driver a half-pixel strip dims instead of dropping and this gate would measure
  // something else.
  expect(antialias, 'every pixel-guard canvas, this one included, has antialias off').toBe('0');

  // NON-VACUITY. 16 origins x 2 variants x 2 states, each with both runs walked over real
  // positions, so "no gaps" cannot pass over an empty list.
  expect(reports, 'one report per drawing').toHaveLength(64);
  for (const oy of ORIGINS) {
    for (const ox of ORIGINS) {
      for (const variant of ['shipped', 'control'] as const) {
        for (const state of ['rest', 'marked'] as const) {
          const found = reports.filter(
            (r) => r.ox === ox && r.oy === oy && r.variant === variant && r.state === state,
          );
          expect(found, `exactly one ${variant} ${state} drawing at origin (${ox}, ${oy})`).toHaveLength(1);
        }
      }
    }
  }
  for (const r of reports) {
    expect(r.runs.length, `(${r.ox}, ${r.oy}) ${r.variant} ${r.state}: runs`).toBeGreaterThanOrEqual(2);
    expect(
      new Set(r.runs.map((run) => run.axis)),
      `(${r.ox}, ${r.oy}): a run on each axis`,
    ).toEqual(new Set(['x', 'y']));
    for (const run of r.runs) {
      expect(run.positions, `(${r.ox}, ${r.oy}) ${r.variant} ${r.state} ${run.axis}: positions`).toBeGreaterThan(0);
    }
  }

  // THE GATE. Every SHIPPED run, at rest and marked, at every origin: zero gaps.
  const failing: string[] = [];
  for (const r of reports.filter((x) => x.variant === 'shipped')) {
    for (const run of r.runs) {
      if (run.gaps !== 0) {
        failing.push(`(${r.ox}, ${r.oy}, ${r.state}, ${run.axis}, gaps ${run.gaps}/${run.positions})`);
      }
    }
  }
  expect(failing, `shipped runs with gaps: ${failing.join(' ')}`).toEqual([]);
});

test('the CONTROL (the pre-fix 2 world px stroke) shows gaps in the same run, at rest and marked', async ({
  browser,
}) => {
  const { reports } = await readReports(browser);
  const sum = (state: 'rest' | 'marked'): number =>
    reports
      .filter((r) => r.variant === 'control' && r.state === state)
      .reduce((n, r) => n + r.runs.reduce((m, run) => m + run.gaps, 0), 0);
  expect(reports.filter((r) => r.variant === 'control'), 'control drawings').toHaveLength(32);
  // If either is 0, the read cannot see a half-pixel cable vanish, and the shipped rows
  // above prove nothing.
  expect(sum('rest'), 'control gaps at rest').toBeGreaterThan(0);
  expect(sum('marked'), 'control gaps marked').toBeGreaterThan(0);
});
