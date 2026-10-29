import { test, expect } from '@playwright/test';
import { addWaitBudget, frameBudgetMs } from '../e2e/support/frameSampler';
import {
  DRAWN_STATE_FRAMES,
  expectRenderLoopAlive,
  glyphBoxOn,
  readScene,
  resetToDemo,
  resetZoomToActualSize,
  waitForAppReady,
  watchPageErrors,
  type GlyphBoxFacts,
} from './support/oracle';

// 85-glyph-inside-chassis.live.spec.ts (DEMO-04, phase 85 success criterion 2, D-24).
//
// NO MACHINE'S GLYPH IS DRAWN PAST ITS MACHINE. A glyph whose art is larger than its
// machine's footprint spills over the cells around it. The shipped demo did exactly that:
// its HTTP Handler is one cell, and it drew the Factory's three-cell art centred on that
// cell, over its neighbours. `glyphFit` (frontend/src/render/layers/glyphFit.ts) shrinks a
// glyph that does not fit, and never grows one that does.
//
// WHAT IS GRADED IS WHAT IS DRAWN. Every number comes off the live Pixi objects through
// `glyphBoxOn`: the glyph Graphics' position, the art's author box times the glyph's
// current scale, and the footprint off the machine body's pivot. A check that recomputed
// the placement formula would agree with whatever formula shipped; this one reads the
// result. Every number is in the body's unrotated frame, where the footprint is
// 0..footW by 0..footH, so rotation does not enter.
//
// The camera is reset to 100% first so every machine is above the LOD cut (a body hidden
// below it reads null, and a null here is a failure, not a skip).
//
// Render health is asserted (watchPageErrors before goto, expectRenderLoopAlive and
// assertNone at the end): the readback reads Pixi objects, but a renderer whose loop died
// after the first draw would still hold them.

/** The glyph-drawing kinds, by `machine_kind` byte (SUBJECT_OF's keys in machines.ts). */
const GLYPH_KIND_NAME: Readonly<Record<number, string>> = {
  0: 'SOURCE',
  2: 'FACTORY',
  3: 'TEE',
  4: 'BALANCER',
  5: 'ROUTER',
  6: 'MERGE',
  7: 'SINK',
  9: 'ENDPOINT',
  10: 'HANDLER',
};

/** LABEL, a note drawn by its own branch with no glyph. */
const LABEL_KIND = 11;

/** Sub-pixel slack on each edge: a centred fit lands on half pixels. */
const EDGE_SLACK_PX = 0.5;

/** Why a glyph box is not inside its footprint, or null when it is. */
function overflowOf(box: GlyphBoxFacts): string | null {
  const inside =
    box.x >= -EDGE_SLACK_PX &&
    box.y >= -EDGE_SLACK_PX &&
    box.x + box.w <= box.footW + EDGE_SLACK_PX &&
    box.y + box.h <= box.footH + EDGE_SLACK_PX;
  if (inside) return null;
  return `x=${box.x} y=${box.y} w=${box.w} h=${box.h} inside footW=${box.footW} footH=${box.footH}`;
}

test.describe('DEMO-04: every machine on the demo draws its glyph inside its footprint', () => {
  test('the drawn glyph of every demo machine lies inside its machine', async ({ page }) => {
    const pageErrors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    await resetToDemo(page);
    await resetZoomToActualSize(page);

    const scene = await readScene(page);
    const machines = scene.nodes.filter((n) => n.kind !== LABEL_KIND);
    const unknown = machines.filter((n) => GLYPH_KIND_NAME[n.kind] === undefined).map((n) => `handle ${n.id} kind=${n.kind}`);
    expect(unknown, 'every machine on the demo is a glyph-drawing kind this spec names').toEqual([]);
    expect(machines.length, 'NON-VACUITY: the demo has machines to check').toBeGreaterThan(0);

    // Every glyph is read off the canvas; a null is a body not drawn above the LOD cut, which
    // a frame or two after the zoom reset must cure.
    const violations: string[] = [];
    let checked = 0;
    for (const n of machines) {
      const name = `handle ${n.id} kind=${GLYPH_KIND_NAME[n.kind]} (${n.kind}) on ${n.cells.length} cell(s) from (${n.cells[0]?.join(',')})`;
      await expect
        .poll(async () => (await glyphBoxOn(page, n.id)) !== null, {
          timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'glyph box poll: the body drawn above the LOD cut'),
          message: `${name}: the machine draws a glyph at 100% zoom`,
        })
        .toBe(true);
      const box = await glyphBoxOn(page, n.id);
      expect(box, `${name}: the glyph box is still drawn on the read after the poll`).not.toBeNull();
      const why = overflowOf(box!);
      if (why !== null) violations.push(`${name}: glyph drawn past its machine, ${why}`);
      checked += 1;
    }
    expect(checked, 'NON-VACUITY: every machine on the demo was read off the canvas').toBe(machines.length);
    expect(violations, 'no machine draws its glyph past its footprint').toEqual([]);

    await expectRenderLoopAlive(page, 'after reading every glyph box');
    pageErrors.assertNone('85-glyph-inside-chassis');
  });
});
