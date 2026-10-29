import { test, expect } from '@playwright/test';
import {
  CELL,
  cameraOf,
  expectRenderLoopAlive,
  pollScene,
  readScene,
  waitForAppReady,
  watchPageErrors,
  type SceneFacts,
} from './support/oracle';

// 10-machine-lod.spec.ts (READ-05) - the LIVE proof that machine KIND + STATE
// survive zoom-out. Below the machine LOD cutoff (`worldScale * CELL < 12px`) each
// machine sprite swaps to a solid kind-tinted, state-pipped block instead of a mush
// of sub-pixel glyphs. The swap is a DISPLAY-ONLY render decision threaded through a
// one-way `() => cam.worldScale()` closure (T-33-DET): it must never mutate the
// model. This spec drives the REAL host - real wheel-zoom over the real canvas ->
// shipped camera.onWheel -> container.scale -> the machine layer's fresh-each-draw
// LOD read - and asserts against the read-only window.__fabrico oracle, no injected
// packets. If the LOD swap ever wrote back into the scene/command/tick, this fails.
//
// The honest LOD guarantee proven here: (1) every machine stays PRESENT below the
// cut, (2) the kind SET is unchanged (the block still encodes each kind), (3) the
// MODEL did not change across the zoom (node count, kind multiset, and the undo/redo
// stack are identical - zoom is not a command).
//
// Drive rules (live suite, locked): real wheel events only, every wait is an
// expect.poll on a specific value (no fixed sleeps), and every camera-derived
// expectation RE-READS cameraOf after the gesture. Readiness resolves via the stable
// getByRole accessible name in waitForAppReady (never a volatile getByTitle).
//
// ===========================================================================
// THIS SPEC PASSED ON A BUILD WHERE THE RENDERER WAS DEAD, AND THAT IS FIXED HERE.
// ===========================================================================
//
// Every assertion above the fix read the MODEL, and the model is fed by the packet /
// React path, which is independent of the Pixi ticker. So when a bucket-change bug in
// `items.ts` threw inside a ticker listener and stopped the render loop for good, this
// spec kept passing: the machines were all still in `scene()`, exactly as it asserts.
// On the real binary the board was frozen with no machines and no items on it.
//
// TWO THINGS WERE ADDED, and the second one is the one that catches it:
//   (1) `watchPageErrors` - an uncaught page error now reddens this spec.
//   (2) A ZOOM-BACK-IN leg. The crash needs a DOT ZOOM BUCKET crossing, which is NOT
//       the same threshold as the machine LOD cut this spec was written for. Below
//       zoom 1 `itemDotGrow` and the device quantum cancel BY DESIGN (`items.ts`
//       dotDeviceScale), so zooming OUT alone never crosses a dot bucket - the
//       original one-way gesture could not have reached the defect at any depth.
// Both sides now also assert the render loop is still advancing, because a dead
// renderer is precisely what a model-only oracle cannot see.

test.describe.configure({ mode: 'serial' });

// The machine LOD cutoff in on-screen device px per cell (machines.ts
// LOD_MIN_MACHINE_PX). Below `worldScale * CELL` this the machine renders as a solid
// block. Mirrored here as the target the wheel-out must cross, because GATE-01 allows
// this suite exactly ONE product import (`shared/geometry.ts`) and this constant is not
// in it.
//
// THIS COPY IS NOT SELF-POLICING, AND THE OLD COMMENT HERE CLAIMED IT WAS. It said the
// value was "kept in sync with the render constant by this spec's own crossing
// assertion". It was not: a literal compared against itself agrees with itself forever.
// It sat at 12 against a shipped 16 from a pre-release revision (2026-08-02, plan 58-01) until the
// v7.0 FEEL walk found it on 2026-08-16, and mutating the shipped constant to 0 or 40
// left this spec green throughout.
//
// The sync is now asserted from OUTSIDE this suite, by a source scan in
// `src/render/layers/machineVector.test.ts`, which can import the shipped constant
// without costing this suite its zero-mock audit. Change this number and that gate
// reddens.
const LOD_MIN_MACHINE_PX = 16;

/** The sorted kind multiset of the scene's machines - the style-independent kind read. */
function kindMultiset(s: SceneFacts): number[] {
  return s.nodes.map((n) => n.kind).sort((a, b) => a - b);
}

test.describe('READ-05: machine kind + state survive zoom-out (display-only LOD block)', () => {
  // Installed BEFORE goto so a boot-time throw is caught too.
  let errors: { assertNone(context: string): void };

  test.beforeEach(async ({ page }) => {
    errors = watchPageErrors(page);
    await page.goto('/');
    await waitForAppReady(page);
    errors.assertNone('during boot');
  });

  test('zooming below the LOD cut keeps every machine present and never mutates the model', async ({
    page,
  }) => {
    // (1) Capture the model BEFORE the zoom: the machine topology (count + kind set)
    // and the undo/redo stack. Zoom is display-only, so all of these must survive it.
    const before = await readScene(page);
    expect(before.nodes.length, 'the demo scene has machines to read at LOD').toBeGreaterThan(0);
    const beforeKinds = kindMultiset(before);
    const beforeCanUndo = before.canUndo;
    const beforeCanRedo = before.canRedo;

    // (2) Drive a REAL wheel-zoom OUT over the canvas centre (clear of the top toolbar
    // and the bottom-right camera cluster) until the live camera's on-screen cell size
    // falls below the LOD cutoff. onWheel applies synchronously, so after each notch the
    // camera is settled; we poll cameraOf (no fixed sleeps) and stop at the clamp/cut.
    const viewport = page.viewportSize();
    expect(viewport, 'the live viewport size is known').not.toBeNull();
    await page.mouse.move(viewport!.width / 2, viewport!.height / 2);

    let cam = await cameraOf(page);
    for (let i = 0; i < 60 && cam.scale * CELL >= LOD_MIN_MACHINE_PX; i++) {
      await page.mouse.wheel(0, 300); // positive delta -> zoom OUT (shipped onWheel)
      const next = await cameraOf(page);
      // Bail out if the min-zoom clamp pins the scale (no further movement possible).
      if (Math.abs(next.scale - cam.scale) < 1e-6) {
        cam = next;
        break;
      }
      cam = next;
    }

    // (3) Prove the gesture actually crossed into LOD territory - otherwise the LOD
    // path is never exercised and the guarantee below is unfalsifiable.
    expect(
      cam.scale * CELL,
      `the wheel-out drove the machine cell size below the LOD cutoff (${LOD_MIN_MACHINE_PX}px)`,
    ).toBeLessThan(LOD_MIN_MACHINE_PX);

    // (4) The honest LOD guarantee, read from the model AFTER the zoom: every machine
    // is still present, the kind set is unchanged (the block still encodes kind), and
    // the undo/redo stack is untouched (zoom is display-only, never a command). Poll so
    // any late oracle settle is tolerated, then re-read for the exact multiset compare.
    await pollScene(page, (s) => s.nodes.length, {
      message: 'every machine is still present in the model below the LOD cut (READ-05 present)',
    }).toBe(before.nodes.length);

    const after = await readScene(page);
    expect(kindMultiset(after), 'the kind set is unchanged across the zoom (READ-05 kind reads)').toEqual(
      beforeKinds,
    );
    expect(after.canUndo, 'zoom did not push/alter the undo stack (display-only, T-33-DET)').toBe(
      beforeCanUndo,
    );
    expect(after.canRedo, 'zoom did not alter the redo stack (display-only, T-33-DET)').toBe(
      beforeCanRedo,
    );

    // (5) THE RENDERER IS STILL ALIVE, which every assertion above is blind to. A
    // model-only oracle keeps reading a perfect scene off a board that stopped drawing.
    errors.assertNone('after the zoom-out');
    await expectRenderLoopAlive(page, 'after the zoom-out');

    // (6) AND BACK IN, across the dot zoom buckets. This is the leg that reaches the
    // recorded defect: the dot texture re-rasterises when `dotZoomBucket(grow * q)`
    // moves, and below zoom 1 the grow and the quantum cancel, so only the way back IN
    // crosses a bucket. Drive well past 1 so several buckets are crossed, then assert
    // the loop survived all of them.
    for (let i = 0; i < 40; i++) {
      const at = await cameraOf(page);
      if (at.scale >= 3.5) break;
      await page.mouse.wheel(0, -300); // negative delta -> zoom IN (shipped onWheel)
    }
    const zoomedIn = await cameraOf(page);
    expect(
      zoomedIn.scale,
      'the wheel-in really crossed back above zoom 1, where the dot zoom buckets live',
    ).toBeGreaterThan(1);

    errors.assertNone('after the zoom back in');
    await expectRenderLoopAlive(page, 'after the zoom back in');

    // ... and the model is still intact after the round trip, so the added legs are
    // held to the same display-only standard as the zoom-out.
    const roundTrip = await readScene(page);
    expect(kindMultiset(roundTrip), 'the kind set survives the zoom round trip').toEqual(beforeKinds);
    expect(roundTrip.canUndo, 'the zoom round trip pushed no command').toBe(beforeCanUndo);
    expect(roundTrip.canRedo, 'the zoom round trip altered no redo stack').toBe(beforeCanRedo);
  });
});
