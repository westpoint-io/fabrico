// HintPointer.test.ts - the lesson's port rings are the size of the spot the gesture accepts (HINT-02).
//
// A drop disc's inner edge is the belt release's hit circle, and a press square covers the doorstep
// cell the press check accepts. The source check pins the two readers of `dropHitRadiusWorld`: the
// release in gestures.ts and the disc here, so neither can drift to a number of its own.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CELL, nubAnchor } from '../../../shared/geometry';
import { stripComments } from '../../gates/stripComments';
import { doorstepCell, dropHitRadiusWorld, wireNubHitRadiusWorld } from '../../protocol/ports';
import * as hint from './HintPointer';
import { doorstepSquareBox, dropDiscBox } from './HintPointer';

const FRONTEND = fileURLToPath(new URL('../../../', import.meta.url));
const TOL = 1;
/** A Sink's In on its west side and a Source's Out on its east side, as lesson 1 lays them out. */
const IN_PORT = { cell_x: 9, cell_y: 4, side: 3 };
const OUT_PORT = { cell_x: 5, cell_y: 4, side: 1 };
const SCALES = [0.5, 1, 2] as const;
const camAt = (scale: number) => ({ x: 137, y: -42, scale });

describe('dropDiscBox: the ring where a drag ends', () => {
  const expected: Record<number, { d: number; r: number }> = { 0.5: { d: 28, r: 12 }, 1: { d: 28, r: 12 }, 2: { d: 52, r: 24 } };
  for (const scale of SCALES) {
    it(`at scale ${scale} is a ${expected[scale].d} px border box on the dot, with hit radius ${expected[scale].r}`, () => {
      const cam = camAt(scale);
      const anchor = nubAnchor(IN_PORT.cell_x, IN_PORT.cell_y, IN_PORT.side);
      const box = dropDiscBox(anchor, cam);
      const cx = anchor.x * scale + cam.x;
      const cy = anchor.y * scale + cam.y;
      expect(Math.abs(box.width - expected[scale].d)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.height - expected[scale].d)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.hitRadiusPx - expected[scale].r)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.hitRadiusPx - dropHitRadiusWorld(scale) * scale)).toBeLessThanOrEqual(TOL);
      // Centred on the dot: the box's middle and the reported hit centre are both the anchor on screen.
      expect(Math.abs(box.x + box.width / 2 - cx)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.y + box.height / 2 - cy)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.hitCentre.x - cx)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.hitCentre.y - cy)).toBeLessThanOrEqual(TOL);
      // The 2 px border draws outside the circle: the inner edge is the hit radius.
      expect(Math.abs(box.width / 2 - 2 - box.hitRadiusPx)).toBeLessThanOrEqual(TOL);
    });
  }
});

describe('doorstepSquareBox: the ring where a drag starts', () => {
  for (const scale of SCALES) {
    it(`at scale ${scale} covers the doorstep cell plus 4 px each side`, () => {
      const cam = camAt(scale);
      const [dx, dy] = doorstepCell(OUT_PORT);
      const size = CELL * scale;
      const box = doorstepSquareBox(OUT_PORT, cam);
      expect([dx, dy]).toEqual([6, 4]);
      expect(Math.abs(box.x - (dx * size + cam.x - 4))).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.y - (dy * size + cam.y - 4))).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.width - (size + 8))).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.height - (size + 8))).toBeLessThanOrEqual(TOL);
    });
  }
});

describe('both readers name dropHitRadiusWorld', () => {
  const read = (path: string) => stripComments(readFileSync(`${FRONTEND}${path}`, 'utf8'));

  it("gestures.ts's headInAt passes dropHitRadiusWorld(camScale()) to its In-port scan", () => {
    const src = read('src/input/gestures.ts');
    const start = src.indexOf('const headInAt = (');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('const judge = ', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toMatch(/nubsInRadius\(w, dropHitRadiusWorld\(camScale\(\)\), 'ports\+belt-ends'\)/);
  });

  it('HintPointer.tsx imports dropHitRadiusWorld and draws the disc from it', () => {
    const src = read('src/chrome/tutorial/HintPointer.tsx');
    expect(src).toMatch(/import \{[^}]*\bdropHitRadiusWorld\b[^}]*\} from '\.\.\/\.\.\/protocol\/ports'/);
    const start = src.indexOf('export function dropDiscBox(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/dropHitRadiusWorld\(cam\.scale\)/);
  });
});

// A wire press, move and release all hit-test at `wireNubHitRadiusWorld`, wider than the belt drop
// radius, so a ring on an electrical port is a disc at that radius on both ends of the drag.
describe('wireDiscBox: the ring on an electrical port', () => {
  const ROUTE_OUT = { cell_x: 8, cell_y: 8, side: 1 };
  const expected: Record<number, { d: number; r: number }> = { 0.5: { d: 48, r: 22 }, 1: { d: 48, r: 22 }, 2: { d: 92, r: 44 } };
  for (const scale of SCALES) {
    it(`at scale ${scale} is a ${expected[scale].d} px border box on the dot, with hit radius ${expected[scale].r}`, () => {
      const cam = camAt(scale);
      const anchor = nubAnchor(ROUTE_OUT.cell_x, ROUTE_OUT.cell_y, ROUTE_OUT.side);
      const box = hint.wireDiscBox(anchor, cam);
      const cx = anchor.x * scale + cam.x;
      const cy = anchor.y * scale + cam.y;
      expect(Math.abs(box.hitRadiusPx - expected[scale].r)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.hitRadiusPx - wireNubHitRadiusWorld(scale) * scale)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.width - expected[scale].d)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.height - expected[scale].d)).toBeLessThanOrEqual(TOL);
      // 4 px wider than the hit circle's diameter: the 2 px border draws outside it on each side.
      expect(Math.abs(box.width - (2 * box.hitRadiusPx + 4))).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.x + box.width / 2 - cx)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.y + box.height / 2 - cy)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.hitCentre.x - cx)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(box.hitCentre.y - cy)).toBeLessThanOrEqual(TOL);
    });
  }
});

describe('portRingBox: the ring follows the port medium, then its role', () => {
  const ELECTRICAL = 1;
  const MECHANICAL = 0;
  const port = (role: number, medium: number, side: number) => ({ cell_x: 8, cell_y: 8, side, role, medium });
  for (const scale of SCALES) {
    it(`at scale ${scale} an electrical Out and In get the wire disc, a belt In the drop disc and a belt Out the doorstep square`, () => {
      const cam = camAt(scale);
      const wireR = wireNubHitRadiusWorld(scale) * scale;
      const dropR = dropHitRadiusWorld(scale) * scale;
      const electricalOut = hint.portRingBox(port(1, ELECTRICAL, 1), cam);
      const electricalIn = hint.portRingBox(port(0, ELECTRICAL, 3), cam);
      const beltIn = hint.portRingBox(port(0, MECHANICAL, 3), cam);
      const beltOut = hint.portRingBox(port(1, MECHANICAL, 1), cam);
      expect(Math.abs((electricalOut.hitRadiusPx ?? -1) - wireR), 'electrical Out').toBeLessThanOrEqual(TOL);
      expect(Math.abs((electricalIn.hitRadiusPx ?? -1) - wireR), 'electrical In').toBeLessThanOrEqual(TOL);
      expect(Math.abs((beltIn.hitRadiusPx ?? -1) - dropR), 'belt In keeps the drop disc').toBeLessThanOrEqual(TOL);
      expect(beltOut.hitRadiusPx, 'belt Out keeps the square').toBeUndefined();
      expect(beltOut).toMatchObject(doorstepSquareBox(port(1, MECHANICAL, 1), cam));
      const anchor = nubAnchor(8, 8, 1);
      expect(Math.abs(electricalOut.x + electricalOut.width / 2 - (anchor.x * scale + cam.x)), 'centred on the Out dot').toBeLessThanOrEqual(TOL);
    });
  }
});

describe('the wire press and the wire disc both name wireNubHitRadiusWorld', () => {
  const read = (path: string) => stripComments(readFileSync(`${FRONTEND}${path}`, 'utf8'));

  it("gestures.ts's wire press hit-tests at wireNubHitRadiusWorld(camScale()) before it ranks an electrical Out", () => {
    const src = read('src/input/gestures.ts');
    const ranker = src.indexOf('(h) => h.port.role === ROLE_OUT && mediumsCompatible(h.port.medium, MEDIUM_ELECTRICAL)');
    expect(ranker).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, ranker - 600), ranker);
    expect(before).toMatch(/nubsInRadius\(\s*cam\.screenToWorld\(p\.x, p\.y\),\s*wireNubHitRadiusWorld\(camScale\(\)\),?\s*\)/);
  });

  it('HintPointer.tsx imports wireNubHitRadiusWorld and draws the wire disc from it', () => {
    const src = read('src/chrome/tutorial/HintPointer.tsx');
    expect(src).toMatch(/import \{[^}]*\bwireNubHitRadiusWorld\b[^}]*\} from '\.\.\/\.\.\/protocol\/ports'/);
    const start = src.indexOf('export function wireDiscBox(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/wireNubHitRadiusWorld\(cam\.scale\)/);
    expect(body).not.toMatch(/dropHitRadiusWorld/);
  });
});
