import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { composeCamera, type CameraLayers } from './pixiApp.ts';
import type { Container } from 'pixi.js';

// pixiApp.test.ts - the camera z-order gate (E4, plan 66-02).
//
// WHAT THIS EXISTS TO DO, STATED PLAINLY: before this file, a reordered
// `addChild` on the camera changed what occludes what on a real board and NOTHING
// in the repository reddened, in either direction. `bootPixi` cannot be called
// under vitest `environment: 'node'` (vitest.config.ts:16) - there is no window,
// no requestAnimationFrame and no WebGL, and `createItemLayer` takes
// `pixiDotPainter(app.renderer)` and throws at construction without one. So the
// order was lifted into `composeCamera`, and this file drives THAT.
//
// It never constructs an `Application`, a `ParticleContainer`, a `RenderTexture`
// or any renderer capability. Faking a renderer would mean the assertion proves
// the fake. `composeCamera` needs exactly one method - `addChild` - so the seven
// stand-ins below are the six-line recording Container fake from
// `layers/wires.test.ts:41-54` with a name tag added.
//
// THE LIST WENT FROM SIX NAMES TO SEVEN IN PLAN 66-05, IN THE SAME COMMIT AS THE
// SPLIT THAT MOVED IT, AND THAT IS THE WHOLE POINT OF THE FILE. Plan 66-02 pinned
// the SIX that shipped at HEAD - `grid, belts, items, machines, wires, overlay`,
// recorded verbatim in `66-02-SUMMARY.md` under "The six-name list pixiApp.test.ts
// pins" - and proved that pin able to fail by swapping `items` and `machines`
// inside the production `composeCamera` (Fault A, which reddened naming both
// swapped tags). A z-order gate authored at the same time as a reorder proves
// nothing about the reorder. A gate MOVED in the same commit as the reorder it was
// written to witness is the opposite: the diff on this file IS the reviewed record
// that `wires` became `cables` then `terminals`, adjacent and in that order, and
// 66-02's recorded HEAD reading is what makes the before-state citable rather than
// remembered.
//
// There is no `vi.mock('pixi.js', ...)` here and the absence is deliberate rather
// than an oversight. `composeCamera` constructs nothing, so mocking the module it
// never instantiates from would be decoration; what makes this test GPU-free is
// that it never calls `bootPixi`. Measured before deciding: importing
// `pixiApp.ts` under `environment: 'node'` resolves cleanly, module scope and all.

/** A tagged stand-in for one layer Container. Only `addChild` is ever called. */
class FakeContainer {
  children: unknown[] = [];
  constructor(readonly tag: string) {}
  addChild(...c: unknown[]): unknown {
    this.children.push(...c);
    return c[0];
  }
  removeChild(c: unknown): unknown {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    return c;
  }
  destroy(): void {}
}

/**
 * THE CAMERA CHILD ORDER, bottom to top, as it ships at HEAD.
 *
 * Read against `composeCamera`'s own docblock: grid < belts < items < machines <
 * cables < terminals < overlay. Items below machines so dots slide under a machine
 * body at ingestion (D-16); BOTH wire halves above machines so a cable reads as
 * overhead; overlay topmost so a selection ring, a ghost or a DeleteControl is never
 * occluded.
 *
 * SEVEN names since plan 66-05. `cables` and `terminals` are the split halves of the
 * single `wires` Container the six-name version pinned, and they are ADJACENT in that
 * order, which is what makes the composite byte-identical to the pre-split one. The
 * `surface-wire-comet` pixel baseline was run across the split commit with no
 * `--update-snapshots` and did not move, which is the pixel-side half of the same
 * claim this file makes structurally.
 *
 * THIS LIST STATES WHAT SHIPS, NOT WHAT IS CORRECT FOREVER. If a later plan finds it
 * red, the gate is working: move the list in the SAME commit as the reorder, and never
 * relax the assertion.
 */
const CAMERA_CHILD_ORDER = [
  'grid',
  'belts',
  'items',
  'machines',
  'cables',
  'terminals',
  'overlay',
] as const;

/** This file's own path, for the source-text half below. */
const PIXI_APP_TS = fileURLToPath(new URL('./pixiApp.ts', import.meta.url));

describe('composeCamera - the camera z-order contract (E4)', () => {
  it('appends the seven layers to the camera in the shipped bottom-to-top order, by identity', () => {
    const camera = new FakeContainer('camera');
    const fakes: Record<string, FakeContainer> = {};
    for (const name of CAMERA_CHILD_ORDER) fakes[name] = new FakeContainer(name);

    // The PRODUCTION function, driven for its effect. This is not a constant
    // compared against itself: swap two arguments inside `composeCamera` and the
    // identity assertions below name the mismatch (RESEARCH Pitfall 3).
    composeCamera(camera as unknown as Container, fakes as unknown as CameraLayers);

    // Tags first, so a reordering failure reads as two names swapped rather than
    // as two opaque objects that are not the same object.
    expect(camera.children.map((c) => (c as FakeContainer).tag)).toEqual([...CAMERA_CHILD_ORDER]);

    // Then by IDENTITY, which is the assertion that cannot be satisfied by an
    // equal-looking stand-in.
    expect(camera.children).toHaveLength(CAMERA_CHILD_ORDER.length);
    CAMERA_CHILD_ORDER.forEach((name, i) => {
      expect(camera.children[i], `camera child ${i} must be the ${name} layer`).toBe(fakes[name]);
    });
  });

  it('composes the camera exactly ONCE: pixiApp.ts holds a single addChild call', () => {
    // THE SOURCE-TEXT HALF, and the reason it asserts non-zero BEFORE it asserts
    // the stated literal. Pasted from the same discipline `bitMatrixIdiom.test.ts`
    // states over its walker: a discovery that silently returned nothing would
    // report a clean pass over zero files, which is precisely the shape of a gate
    // that "proves" an absence by looking at nothing. Here the equivalent silent
    // nothing is a renamed or moved `pixiApp.ts` matching zero times.
    //
    // WHAT IT GUARDS. `composeCamera` is a seam, not a wall: nothing stops a later
    // edit calling `cam.container.addChild(somethingElse)` further down `bootPixi`
    // and composing a seventh child the identity half above would never see. There
    // must be exactly ONE `.addChild(` in this whole module and it must be the one
    // inside `composeCamera`.
    //
    // STILL 1 ACROSS PLAN 66-05, and that is a measurement rather than a hope: the
    // wire-layer split changed what `composeCamera` passes (six arguments became
    // seven) and NOT how many times the camera is composed. If this literal ever
    // needs to be 2, the seam has been abandoned and that is the thing to discuss.
    const EXPECTED_ADD_CHILD_CALLS = 1;

    const src = readFileSync(PIXI_APP_TS, 'utf8');
    // The RECEIVER of every `.addChild(` in the module, in source order. Reading the
    // receiver rather than only counting is what makes a failure legible: a later
    // `cam.container.addChild(...)` in `bootPixi` reddens as
    // `['camera', 'cam.container']`, which names the offender.
    const receivers = [...src.matchAll(/([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\.addChild\(/g)].map(
      (m) => m[1],
    );

    expect(receivers.length, 'the read found pixiApp.ts and matched something').toBeGreaterThan(0);
    expect(receivers).toHaveLength(EXPECTED_ADD_CHILD_CALLS);
    // And the one call is composeCamera's own, on its `camera` parameter - a bare
    // count would still pass if the single call had moved back out of the seam.
    expect(receivers).toEqual(['camera']);
  });
});
