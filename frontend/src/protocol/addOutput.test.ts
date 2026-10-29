import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NodeView, PortView } from './decode';
import { machine_kind } from './kinds';
import { rotateCatalogPort } from './ports';
import {
  addOutputVerdict,
  localOfWorld,
  roleSlot,
  type AddOutputVerdict,
  type CellOwner,
} from './addOutput';

// addOutput.test.ts (plan 74.1-19, review WR-02, re-walk J10): the note beside
// `+ Add output` is held to the host's OWN verdicts.
//
// `add_output.expected.json` is a table of REAL `GridSession` AddPort answers frozen by
// `crates/fabrico-command/tests/add_output_golden.rs`: rotation 0..3, one to four outputs
// and a freed-slot board, belts docked on none / the In / each Out / the Fault / all, a
// stray belt on the growth strip, a machine there, and both orders of the two. Each row
// carries the packet-shaped facts the client sees and the host's answer. This file
// scores the rule the panel shipped before this plan against it, then asserts
// `addOutputVerdict` agrees with every row.

interface FixturePort {
  index: number;
  cell: [number, number];
  side: number;
  role: number;
}

interface FixtureRow {
  name: string;
  board: string;
  setup: string;
  anchor: [number, number];
  w: number;
  h: number;
  rot: number;
  ports: FixturePort[];
  occupied: { cell: [number, number]; owner: CellOwner }[];
  verdict: {
    tag: string;
    port_cell: [number, number] | null;
    port_side: number | null;
    anchor: [number, number] | null;
    w: number | null;
    h: number | null;
  };
}

const rows = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../crates/fabrico-command/tests/fixtures/add_output.expected.json'),
    'utf8',
  ),
) as FixtureRow[];

/** The row's Factory as the render packet ships it. */
const nodeOf = (r: FixtureRow): NodeView => ({
  id: 1,
  kind: machine_kind.FACTORY,
  cell_x: r.anchor[0],
  cell_y: r.anchor[1],
  state: 0,
  w: r.w,
  h: r.h,
  rot: r.rot,
  ports: r.ports.map(
    (p): PortView => ({ index: p.index, cell_x: p.cell[0], cell_y: p.cell[1], side: p.side, role: p.role, medium: 0 }),
  ),
  load: 0,
});

/** The row's occupancy, as a lookup. */
const ownerOf = (r: FixtureRow) => {
  const at = new Map(r.occupied.map((o) => [`${o.cell[0]},${o.cell[1]}`, o.owner]));
  return (cx: number, cy: number): CellOwner | undefined => at.get(`${cx},${cy}`);
};

/** The host tag the client's answer stands for. */
const tagOf = (v: AddOutputVerdict): string =>
  v.kind === 'ok' ? 'ok' : v.kind === 'blocked-by-belt' ? 'GrowCoversBelt' : 'GrowBlocked';

describe('the table is the one this file is about', () => {
  it('is non-vacuous: per rotation an accepted add, a GrowCoversBelt and a GrowBlocked', () => {
    expect(rows.length).toBe(208);
    for (let rot = 0; rot < 4; rot++) {
      for (const tag of ['ok', 'GrowCoversBelt', 'GrowBlocked']) {
        expect(
          rows.filter((r) => r.rot === rot && r.verdict.tag === tag).length,
          `rot ${rot}: at least one ${tag}`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE RULE THIS PLAN REPLACES, SCORED FIRST. PortsSection showed "Adding an output makes
// this machine bigger and disconnects its fault belt." when the Out count was at least
// the rot-0 height AND a belt was docked on the Fault. Two questions, both answered by
// the engine:
//   WHAT it claims: the add is accepted and lets the fault belt go. The host refuses
//   every one of those adds (an accepted add releases nothing since plan 74.1-16; the
//   Rust guard asserts the empty release set on every accepted row).
//   WHEN it shows, read as "the add is blocked by a belt": it misses every refusal a
//   belt causes when that belt is not docked on the Fault.
// The counts are pinned so the SUMMARY's numbers are this file's numbers.
// ---------------------------------------------------------------------------
describe('the HEAD rule against the engine', () => {
  const faultDocked = (r: FixtureRow): boolean => r.setup === 'Fault' || r.setup === 'all';
  const outs = (r: FixtureRow): number => r.ports.filter((p) => p.role === 1).length;
  const headShows = (r: FixtureRow): boolean => outs(r) >= r.h && faultDocked(r);

  it('every row where it showed, it claimed an accepted add that releases the fault belt, and the host refused', () => {
    const shown = rows.filter(headShows);
    const falseClaims = shown.filter((r) => r.verdict.tag !== 'ok');
    expect(shown.length).toBe(16);
    expect(falseClaims.length, 'the claim was false on every row it was shown').toBe(16);
    // Including the turned Factories the review named (rot 1 and rot 2, the fault belt docked).
    for (const rot of [1, 2]) {
      expect(falseClaims.some((r) => r.rot === rot && r.setup === 'Fault')).toBe(true);
    }
  });

  it('read as "a belt blocks the add", it disagrees on every belt refusal not caused by a fault dock', () => {
    const disagree = rows.filter((r) => headShows(r) !== (r.verdict.tag === 'GrowCoversBelt'));
    expect(disagree.map((r) => r.setup).sort()).toEqual(
      Array<string>(8).fill('belt-then-machine').concat(Array<string>(8).fill('stray-belt')),
    );
  });
});

// ---------------------------------------------------------------------------
// The geometry pieces, pinned on their own.
// ---------------------------------------------------------------------------
describe('roleSlot mirrors role_slot', () => {
  it('a 3-long side: the middle, below, above, then the index', () => {
    expect([0, 1, 2, 3, 4, 5].map((k) => roleSlot(k, 3))).toEqual([1, 2, 0, 3, 4, 5]);
  });
  it('a 2-long and a 1-long side: the index rule', () => {
    expect([0, 1, 2, 3].map((k) => roleSlot(k, 2))).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((k) => roleSlot(k, 1))).toEqual([0, 1, 2, 3]);
  });
});

describe('localOfWorld inverts port_world', () => {
  it('round-trips every local cell of every box through rotateCatalogPort at every rotation', () => {
    let checked = 0;
    for (const [w, h] of [
      [3, 3],
      [3, 4],
      [2, 5],
      [1, 1],
    ]) {
      for (let rot = 0; rot < 4; rot++) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const fwd = rotateCatalogPort({ index: 0, local_x: x, local_y: y, side: 1, role: 1, medium: 0 }, w, h, rot);
            const anchor = { cell_x: 7, cell_y: -3, w, h, rot };
            expect(localOfWorld(anchor, 7 + fwd.lx, -3 + fwd.ly)).toEqual({ x, y });
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(4 * (9 + 12 + 10 + 1));
  });
});

// ---------------------------------------------------------------------------
// THE MIRROR HELD TO THE ENGINE: every row.
// ---------------------------------------------------------------------------
describe('addOutputVerdict agrees with every frozen engine verdict', () => {
  it('every row: the same answer, and on an accepted add the same port, box and anchor', () => {
    const disagree: string[] = [];
    for (const r of rows) {
      const v = addOutputVerdict(nodeOf(r), ownerOf(r));
      if (tagOf(v) !== r.verdict.tag) {
        disagree.push(`${r.name}: client ${tagOf(v)}, host ${r.verdict.tag}`);
        continue;
      }
      if (v.kind === 'ok') {
        const want = r.verdict;
        const got = { port_cell: v.portCell, port_side: v.portSide, anchor: v.anchor, w: v.w, h: v.h };
        const exp = { port_cell: want.port_cell, port_side: want.port_side, anchor: want.anchor, w: want.w, h: want.h };
        if (JSON.stringify(got) !== JSON.stringify(exp)) {
          disagree.push(`${r.name}: client ${JSON.stringify(got)}, host ${JSON.stringify(exp)}`);
        }
      }
    }
    expect(disagree, disagree.slice(0, 5).join('\n')).toEqual([]);
  });

  it('the note is true exactly where it shows: blocked-by-belt if and only if the host says GrowCoversBelt', () => {
    const shows = rows.filter((r) => addOutputVerdict(nodeOf(r), ownerOf(r)).kind === 'blocked-by-belt');
    expect(shows.length).toBe(rows.filter((r) => r.verdict.tag === 'GrowCoversBelt').length);
    expect(shows.every((r) => r.verdict.tag === 'GrowCoversBelt')).toBe(true);
    expect(shows.length).toBe(32);
  });
});
