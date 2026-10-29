// CABLE-11 part 1 (plan 75-04): a machine-readable claim on the pixel guard's occlusion
// surface itself. The surface is the repository's one picture of cables against machine
// bodies; this test reads the SAME scene the picture draws and holds every wire on it to
// the head-on property: the cable leaves along its source port's outward step and enters
// its target port along that port's inward step.
//
// Both ports are read off the scene's own nodes by `(node, port)` and the steps off each
// wire's own `path`, so the test restates nothing about the geometry. Red on the build
// before phase 75 on wire C only (its first step there was (0,+1) out of an east-facing
// port), which also proves the check is not red on everything: wires A and B were already
// side-correct and pass on both builds.

import { describe, expect, it } from 'vitest';
import { unitDelta } from '../protocol/ports.ts';
import type { PortView } from '../protocol/decode.ts';
import { occlusionScene } from './occlusionScene.ts';

function portOf(
  scene: ReturnType<typeof occlusionScene>,
  end: { node: number; port: number },
): PortView {
  const node = scene.nodes.get(end.node);
  if (!node) throw new Error(`the scene has no node ${end.node}`);
  const port = node.ports.find((p) => p.index === end.port);
  if (!port) throw new Error(`node ${end.node} has no port ${end.port}`);
  return port;
}

describe('the pixel guard occlusion scene', () => {
  it('carries three wires: A and B crossing, and C from the class phase 75 fixed', () => {
    expect(occlusionScene().wires.size).toBe(3);
  });

  it('every occlusion wire departs along its source side and arrives head-on', () => {
    const scene = occlusionScene();
    const seen: string[] = [];
    for (const wire of scene.wires.values()) {
      const from = portOf(scene, wire.from);
      const to = portOf(scene, wire.to);
      const cells = wire.path.map((t) => [t.cell_x, t.cell_y] as const);
      expect(cells.length, `wire ${wire.id} is at least two cells`).toBeGreaterThanOrEqual(2);
      expect(cells[0], `wire ${wire.id} starts on its source port`).toEqual([from.cell_x, from.cell_y]);
      expect(cells[cells.length - 1], `wire ${wire.id} ends on its target port`).toEqual([to.cell_x, to.cell_y]);
      const first = [cells[1][0] - cells[0][0], cells[1][1] - cells[0][1]];
      const n = cells.length;
      const last = [cells[n - 1][0] - cells[n - 2][0], cells[n - 1][1] - cells[n - 2][1]];
      const [ox, oy] = unitDelta(from.side);
      const [ix, iy] = unitDelta(to.side);
      expect(first, `wire ${wire.id} leaves along its source port's face`).toEqual([ox, oy]);
      expect(last, `wire ${wire.id} enters its target port head-on`).toEqual([-ix + 0, -iy + 0]);
      seen.push(`wire ${wire.id}`);
    }
    expect(seen).toEqual(['wire 1', 'wire 2', 'wire 3']);
  });
});
