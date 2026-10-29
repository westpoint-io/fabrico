// @vitest-environment jsdom
//
// A MACHINE'S GLYPH SHRINKS TO FIT ITS FOOTPRINT AND NEVER GROWS (plan 85-02, D-24).
//
// `glyphFit` is the one placement every machine glyph goes through. Two things are held here:
//
//   1. AT CATALOG SIZE NOTHING MOVES. For every subject in `SUBJECT_OF`, at its kind's catalog
//      box the scale is exactly `U_TO_PX` and the position is exactly the formula that shipped
//      before the clamp, so no machine on any normal board changes by a pixel.
//   2. A FOOTPRINT SMALLER THAN THE ART SHRINKS IT, CENTRED, INSIDE THE FOOTPRINT. The shipped
//      demo's one-cell HTTP Handler drew the three-cell Factory art over its neighbours; at
//      1x1 every subject must land inside 0..CELL on both axes.
//
// The last block draws through the real machine layer (the `machineReadback.test.ts`
// environment: real Pixi, jsdom for `DOMParser`) and reads `glyphBoxOn`, so the layer's own
// placement is held, not only the pure function.

import { describe, expect, it } from 'vitest';
import { glyphFit } from './glyphFit.ts';
import { createMachineLayer, SUBJECT_OF } from './machines.ts';
import { U_PER_CELL, U_TO_PX, uToPx } from './machineChassis.ts';
import { getAssetBox } from '../svgAssets.ts';
import { CELL } from '../../../shared/geometry.ts';
import { LOCKED_SKIN } from '../synth/skins/locked.ts';
import { createSceneState } from '../sceneState.ts';
import { machine_kind, state_tag } from '../../protocol/kinds.ts';
import { catalogEntry, type NodeView } from '../../protocol/decode.ts';
import type { SynthTexture } from '../synth/textureCache.ts';

/** Every kind that draws a glyph, with its subject and its catalog box in cells. */
const SUBJECT_ROWS = Object.entries(SUBJECT_OF).map(([k, subject]) => {
  const kind = Number(k);
  const row = catalogEntry(kind);
  return { kind, subject, w: row.w, h: row.h };
});

/** The glyph box's far edges, in px, for a fit. */
function farEdges(fit: { scale: number; x: number; y: number }, box: { w: number; h: number }) {
  return { right: fit.x + box.w * fit.scale, bottom: fit.y + box.h * fit.scale };
}

describe('glyphFit: at catalog size nothing moves (D-24)', () => {
  it('covers every glyph-drawing kind (non-vacuity)', () => {
    expect(SUBJECT_ROWS.map((r) => r.kind).sort((a, b) => a - b)).toEqual([
      machine_kind.SOURCE,
      machine_kind.FACTORY,
      machine_kind.TEE,
      machine_kind.BALANCER,
      machine_kind.ROUTER,
      machine_kind.MERGE,
      machine_kind.SINK,
      machine_kind.ENDPOINT,
      machine_kind.HANDLER,
    ]);
  });

  for (const { kind, subject, w, h } of SUBJECT_ROWS) {
    it(`kind ${kind} (${subject}) at its catalog ${w}x${h}: scale U_TO_PX and the old position`, () => {
      const box = getAssetBox(subject);
      const fit = glyphFit(w, h, box);
      expect(fit.scale, 'scale unchanged at catalog size').toBe(U_TO_PX);
      // The formula machines.ts used before the clamp, verbatim.
      expect(fit.x).toBe((w * CELL - uToPx(box.w)) / 2);
      expect(fit.y).toBe((h * CELL - uToPx(box.h)) / 2);
      const { right, bottom } = farEdges(fit, box);
      expect(fit.x).toBeGreaterThanOrEqual(0);
      expect(fit.y).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(w * CELL);
      expect(bottom).toBeLessThanOrEqual(h * CELL);
    });
  }
});

describe('glyphFit: a footprint smaller than the art shrinks it, never hides it', () => {
  it('the factory art at 1x1 is a third the size and inside the one cell', () => {
    const box = getAssetBox('factory');
    const fit = glyphFit(1, 1, box);
    expect(fit.scale).toBeCloseTo(U_TO_PX / 3, 12);
    expect(fit.scale, 'shrunk, not hidden').toBeGreaterThan(0);
    const { right, bottom } = farEdges(fit, box);
    expect(fit.x).toBeCloseTo(0, 9);
    expect(fit.y).toBeCloseTo(0, 9);
    expect(right).toBeCloseTo(CELL, 9);
    expect(bottom).toBeCloseTo(CELL, 9);
  });

  for (const { kind, subject } of SUBJECT_ROWS) {
    it(`kind ${kind} (${subject}) at 1x1 lands inside the one cell`, () => {
      const box = getAssetBox(subject);
      const fit = glyphFit(1, 1, box);
      const want = U_TO_PX * Math.min(1, U_PER_CELL / box.w, U_PER_CELL / box.h);
      expect(fit.scale).toBeCloseTo(want, 12);
      const { right, bottom } = farEdges(fit, box);
      expect(fit.x).toBeGreaterThanOrEqual(-1e-9);
      expect(fit.y).toBeGreaterThanOrEqual(-1e-9);
      expect(right).toBeLessThanOrEqual(CELL + 1e-9);
      expect(bottom).toBeLessThanOrEqual(CELL + 1e-9);
    });
  }

  it('the router art at 2x2 shrinks by the height ratio (the smaller one) and stays centred', () => {
    const box = getAssetBox('router');
    // PRECONDITION: the router art is taller than wide, so at 2x2 only the height is short.
    expect(box.h).toBeGreaterThan(box.w);
    expect(box.w).toBeLessThanOrEqual(2 * U_PER_CELL);
    const fit = glyphFit(2, 2, box);
    const k = (2 * U_PER_CELL) / box.h;
    expect(fit.scale).toBeCloseTo(U_TO_PX * k, 12);
    const { right, bottom } = farEdges(fit, box);
    expect(fit.y, 'the binding axis fills its edge').toBeCloseTo(0, 9);
    expect(bottom).toBeCloseTo(2 * CELL, 9);
    expect(fit.x, 'the other axis is centred').toBeCloseTo(2 * CELL - right, 9);
    expect(fit.x).toBeGreaterThan(0);
  });

  it('a footprint larger than the art never grows it', () => {
    const box = getAssetBox('factory');
    const fit = glyphFit(4, 5, box);
    expect(fit.scale).toBe(U_TO_PX);
    expect(fit.x).toBe((4 * CELL - uToPx(box.w)) / 2);
    expect(fit.y).toBe((5 * CELL - uToPx(box.h)) / 2);
  });
});

/** A machine of `kind` at (6, 6) with its catalog ports, its box forced to `w` x `h`. */
function machine(kind: number, w: number, h: number): NodeView {
  const row = catalogEntry(kind);
  return {
    id: 0,
    kind,
    cell_x: 6,
    cell_y: 6,
    state: state_tag.IDLE,
    w,
    h,
    rot: 0,
    load: 0,
    ports: row.ports.map((p) => ({
      index: p.index,
      cell_x: 6 + p.local_x,
      cell_y: 6 + p.local_y,
      side: p.side,
      role: p.role,
      medium: p.medium,
    })),
  };
}

function drawOne(node: NodeView) {
  const layer = createMachineLayer(
    LOCKED_SKIN,
    () => 1,
    () => ({ destroy: () => {} }) as SynthTexture,
  );
  const scene = createSceneState();
  scene.nodes.set(node.id, node);
  layer.draw(scene, 0);
  return layer;
}

describe('the machine layer places its glyph through glyphFit (read back off the Graphics)', () => {
  it('a one-cell HTTP Handler draws the factory art inside its one cell', () => {
    const box = drawOne(machine(machine_kind.HANDLER, 1, 1)).glyphBoxOn(0);
    expect(box).not.toBeNull();
    expect(box!.footW).toBe(CELL);
    expect(box!.footH).toBe(CELL);
    expect(box!.w).toBeCloseTo(CELL, 9);
    expect(box!.h).toBeCloseTo(CELL, 9);
    expect(box!.x).toBeGreaterThanOrEqual(-1e-9);
    expect(box!.y).toBeGreaterThanOrEqual(-1e-9);
    expect(box!.x + box!.w).toBeLessThanOrEqual(box!.footW + 1e-9);
    expect(box!.y + box!.h).toBeLessThanOrEqual(box!.footH + 1e-9);
  });

  for (const { kind, subject, w, h } of SUBJECT_ROWS) {
    it(`kind ${kind} (${subject}) at catalog size draws where it always did`, () => {
      const art = getAssetBox(subject);
      const box = drawOne(machine(kind, w, h)).glyphBoxOn(0);
      expect(box).toEqual({
        x: (w * CELL - uToPx(art.w)) / 2,
        y: (h * CELL - uToPx(art.h)) / 2,
        w: uToPx(art.w),
        h: uToPx(art.h),
        footW: w * CELL,
        footH: h * CELL,
      });
    });
  }

  it('reads null below the LOD cut and for a handle with no machine', () => {
    let zoom = 1;
    const layer = createMachineLayer(
      LOCKED_SKIN,
      () => zoom,
      () => ({ destroy: () => {} }) as SynthTexture,
    );
    const scene = createSceneState();
    scene.nodes.set(0, machine(machine_kind.SOURCE, 1, 1));
    layer.draw(scene, 0);
    expect(layer.glyphBoxOn(0)).not.toBeNull();
    expect(layer.glyphBoxOn(9), 'no root on handle 9').toBeNull();
    zoom = 0.25;
    layer.draw(scene, 1);
    expect(layer.glyphBoxOn(0), 'a hidden body reports no drawn glyph').toBeNull();
  });
});
