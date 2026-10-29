// addOutput.ts (plan 74.1-19, review WR-02, re-walk J10) - what one more `+ Add output`
// would do to a Factory, answered the way the host answers it.
//
// THE HOST IS THE JUDGE. The note beside `+ Add output` never gates the button (Phase 64
// D-07): the add is sent and the host accepts or refuses it in words. This module only
// lets the panel say IN ADVANCE what the host will answer, so the note is shown exactly
// when the add would be refused because a belt is in the way.
//
// WHAT IT MIRRORS. The host's `AddPort` validate arm (`command.rs`) over plan 74.1-16's
// shared geometry (`add_port_geometry`, `state.rs`):
//   1. Recover each port's rot-0 SLOT from its world cell by inverting `port_world`
//      ({@link localOfWorld}); an In or Out holds a row, a Fault a column.
//   2. The new Out takes the FIRST FREE Out slot in the centre-out order of the catalog
//      side ({@link roleSlot}, the mirror of `role_slot`; `first_free_slot`).
//   3. The box grows only as far as the slots need and never shrinks: height to the
//      highest In or Out slot plus one, width to the In and Out columns plus the highest
//      Fault slot plus one.
//   4. The anchor shifts by the growth so it lands on the rot-0 east and south edges as
//      turned: rot 0 (0, 0), rot 1 (-dh, 0), rot 2 (-dw, -dh), rot 3 (0, -dw).
//   5. Walk the prospective box in the host's order (`cellsOfFootprint`, row-major),
//      skipping the Factory's own cells; the FIRST occupied cell decides: a belt tile is
//      `blocked-by-belt` (the host's `GrowCoversBelt`), a machine `blocked-by-machine`
//      (`GrowBlocked`, `FootprintCollision` until plan 88-02); none is `ok`.
//
// HELD TO THE ENGINE: `addOutput.test.ts` asserts this answers every row of
// `crates/fabrico-command/tests/fixtures/add_output.expected.json` (real `GridSession`
// AddPort verdicts at every rotation) identically, including the new port's cell and
// side and the box and anchor after an accepted add.
//
// TWO HOST REFUSALS IT DOES NOT PREDICT, stated rather than discovered. The grid bound
// (`GRID_MIN`/`GRID_MAX` = -512/512) answers `OutOfBounds` and the 64-cell dimension cap
// `MachineTooBig` (since plan 88-02) host-side, and the frontend keeps no copy of either (plan 74.1-18 records
// the same gap for the turn flash; a second copy of the bound is the drift surface the
// codebase avoids). A Factory against the grid edge may therefore get a belt or machine
// answer here where the host says "past the edge"; the button still sends and the host's
// sentence is what the user reads.
//
// Integer arithmetic only; no float, no rounding.

import type { NodeView } from './decode';
import { catalogEntry } from './decode';
import { cellsOfFootprint } from './footprint';

/** Core role bytes (`Role { In = 0, Out = 1, Fault = 2 }`). */
const ROLE_IN = 0;
const ROLE_OUT = 1;
const ROLE_FAULT = 2;

/** The owner of an occupied cell, as far as this question needs it. */
export type CellOwner = 'belt' | 'machine';

/** What the host will answer to one more Out on this machine. */
export type AddOutputVerdict =
  | {
      kind: 'ok';
      /** The new port's world cell and world side. */
      portCell: [number, number];
      portSide: number;
      /** The anchor and rot-0 box after the add. */
      anchor: [number, number];
      w: number;
      h: number;
    }
  | { kind: 'blocked-by-belt'; cell: [number, number] }
  | { kind: 'blocked-by-machine'; cell: [number, number] };

/**
 * The slot the `k`-th port of a role takes on a side whose CATALOG length is `baseLen`:
 * the centre, then alternately below and above it until the side is used, then `k`.
 * The mirror of `role_slot` (`state.rs`); with `c = (baseLen - 1) / 2` (integer).
 */
export function roleSlot(k: number, baseLen: number): number {
  const c = Math.trunc((baseLen - 1) / 2);
  if (k === 0) return c;
  if (k <= 2 * c) return k % 2 === 1 ? c + (k + 1) / 2 : c - k / 2;
  return k;
}

/**
 * The rot-0 local cell of a world cell on a placed machine: the inverse of `port_world`'s
 * table (`rot1: (h-1-y, x)`, `rot2: (w-1-x, h-1-y)`, `rot3: (y, w-1-x)`), pinned by a
 * round trip against `rotateCatalogPort`, the forward mirror.
 */
export function localOfWorld(
  node: Pick<NodeView, 'cell_x' | 'cell_y' | 'w' | 'h' | 'rot'>,
  wx: number,
  wy: number,
): { x: number; y: number } {
  const lx = wx - node.cell_x;
  const ly = wy - node.cell_y;
  switch (node.rot & 3) {
    case 0:
      return { x: lx, y: ly };
    case 1:
      return { x: ly, y: node.h - 1 - lx };
    case 2:
      return { x: node.w - 1 - lx, y: node.h - 1 - ly };
    default:
      return { x: node.w - 1 - ly, y: lx };
  }
}

/** A port's slot along its role's edge: its row for an In or Out, its column for a Fault. */
function slotOf(node: NodeView, role: number, wx: number, wy: number): number {
  const { x, y } = localOfWorld(node, wx, wy);
  return role === ROLE_FAULT ? x : y;
}

/**
 * What the host will answer to `AddPort { role: Out, medium: Item }` on `node`.
 *
 * `ownerAt` names the owner of an occupied cell (or `undefined` for a free one); it is
 * only ever asked about cells OUTSIDE the machine's current box, so it need not exclude
 * the machine itself.
 */
export function addOutputVerdict(
  node: NodeView,
  ownerAt: (cx: number, cy: number) => CellOwner | undefined,
): AddOutputVerdict {
  const base = catalogEntry(node.kind);
  // 1-2. The taken Out slots, and the first free one in the catalog side's order.
  const outSlots = new Set<number>();
  let needH = 1;
  let needFaultW = 1;
  let hasIn = false;
  let hasOut = false;
  for (const p of node.ports) {
    const s = slotOf(node, p.role, p.cell_x, p.cell_y);
    if (p.role === ROLE_IN) {
      hasIn = true;
      needH = Math.max(needH, s + 1);
    } else if (p.role === ROLE_OUT) {
      hasOut = true;
      outSlots.add(s);
      needH = Math.max(needH, s + 1);
    } else if (p.role === ROLE_FAULT) {
      needFaultW = Math.max(needFaultW, s + 1);
    }
  }
  let k = 0;
  while (outSlots.has(roleSlot(k, base.h))) k++;
  const slot = roleSlot(k, base.h);
  hasOut = true;
  needH = Math.max(needH, slot + 1);
  // 3. The grown box, never below the current one.
  const needW = Math.max((hasIn ? 1 : 0) + (hasOut ? 1 : 0), needFaultW, 1);
  const w = Math.max(node.w, needW);
  const h = Math.max(node.h, needH);
  const dw = w - node.w;
  const dh = h - node.h;
  // 4. The anchor shift that keeps every existing In and Out on its world cell.
  const r = node.rot & 3;
  const [sx, sy] = r === 0 ? [0, 0] : r === 1 ? [-dh, 0] : r === 2 ? [-dw, -dh] : [0, -dw];
  const ax = node.cell_x + sx;
  const ay = node.cell_y + sy;
  // 5. The host's walk, skipping the machine's own cells.
  const own = new Set(
    cellsOfFootprint(node.cell_x, node.cell_y, node.w, node.h, node.rot).map(([x, y]) => `${x},${y}`),
  );
  for (const [cx, cy] of cellsOfFootprint(ax, ay, w, h, node.rot)) {
    if (own.has(`${cx},${cy}`)) continue;
    const owner = ownerAt(cx, cy);
    if (owner === 'belt') return { kind: 'blocked-by-belt', cell: [cx, cy] };
    if (owner === 'machine') return { kind: 'blocked-by-machine', cell: [cx, cy] };
  }
  // Accepted: the new Out on column w - 1 at its slot, facing E in the rot-0 frame,
  // placed through `port_world`'s forward table.
  const lx0 = w - 1;
  const ly0 = slot;
  const [lx, ly] =
    r === 0 ? [lx0, ly0] : r === 1 ? [h - 1 - ly0, lx0] : r === 2 ? [w - 1 - lx0, h - 1 - ly0] : [ly0, w - 1 - lx0];
  return {
    kind: 'ok',
    portCell: [ax + lx, ay + ly],
    portSide: (1 + r) & 3,
    anchor: [ax, ay],
    w,
    h,
  };
}

/** The scene shape {@link sceneCellOwner} reads: the render packet's two maps. */
export interface OccupancyScene {
  nodes: ReadonlyMap<number, NodeView>;
  belts: ReadonlyMap<number, { tiles: ReadonlyArray<{ cell_x: number; cell_y: number }> }>;
}

/**
 * The owner of a cell on the echoed scene: a machine whose footprint covers it, else a
 * belt routing a tile through it. The same two halves as `ghost.ts`'s `cellOccupied`
 * (the host's occupancy index counts machine cells and every belt tile), answered with
 * the owner's kind because the host's refusal tag depends on it.
 */
export function sceneCellOwner(scene: OccupancyScene): (cx: number, cy: number) => CellOwner | undefined {
  return (cx, cy) => {
    for (const n of scene.nodes.values()) {
      for (const [fx, fy] of cellsOfFootprint(n.cell_x, n.cell_y, n.w, n.h, n.rot)) {
        if (fx === cx && fy === cy) return 'machine';
      }
    }
    for (const b of scene.belts.values()) {
      for (const t of b.tiles) {
        if (t.cell_x === cx && t.cell_y === cy) return 'belt';
      }
    }
    return undefined;
  };
}
