import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CELL } from '../../shared/geometry.ts';
import { MIN_TARGET_PX } from '../render/synth/chrome/skinToCssVars.ts';
import type { BeltView, NodeView, PortView, TileView } from './decode.ts';
import {
  FAULT_PORT,
  MACHINE_TARGET,
  MEDIUM_ELECTRICAL,
  MEDIUM_MECHANICAL,
  acceptsDock,
  BELT_PORT_HEAD,
  BELT_PORT_TAIL,
  beltDockPartnerEnd,
  beltEndCell,
  beltEndOutward,
  beltEndInner,
  beltEndPort,
  beltHandlePoints,
  beltTarget,
  beltSeamPoint,
  dockRoleOk,
  dockCandidates,
  dockPort,
  localNubSpecs,
  mediumsCompatible,
  nubHitRadiusWorld,
  oppositeSide,
  rotateCatalogPort,
  sideToEdgeDir,
  unitDelta,
  wireNubHitRadiusWorld,
  worldNubSpecs,
} from './ports.ts';

/**
 * `docs/style-bible.md`, three levels up from `frontend/src/protocol/`.
 *
 * A protocol test reading a design document is deliberate and narrow: the property
 * `wireNubHitRadiusWorld` exists to hold is "the canvas honours the project's own 44px
 * minimum target", and the bible is where that 44 is DECLARED. Reading it here is what
 * lets this file refuse a value; deriving from `MIN_TARGET_PX` alone cannot, because the
 * constant is what would have moved. `skinToCssVars.test.ts` parses the same section for
 * the same reason and its `bibleSection6Tokens` is the precedent.
 */
const BIBLE = join(import.meta.dirname, '../../../docs/style-bible.md');

/** The `--fab-min-target` value section 6 declares, in px. Throws rather than defaulting. */
function bibleMinTargetPx(): number {
  const md = readFileSync(BIBLE, 'utf8');
  const start = md.search(/^## 6\. /m);
  if (start < 0) throw new Error('style-bible.md: section 6 heading not found');
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const row = section.match(/^\|\s*`--fab-min-target`\s*\|\s*`(\d+)px`\s*\|/m);
  if (!row) throw new Error('style-bible.md section 6: no `--fab-min-target` | `Npx` row');
  return Number(row[1]);
}

// ports.ts is the pure keyspace/geometry mirror of the Rust host's dock
// contract (command.rs:461-565 forward translation, state.rs:1232-1313
// dock_still_reaches, state.rs:706-784 Side math + port_world). These cases
// pin the three dock keyspaces (Head raw index / Tail Out routing key / 65535
// fault sentinel), the exact accept predicate, and the drawNub anchor
// geometry so every downstream Phase 21 consumer agrees with the sim.

// ---------------------------------------------------------------------------
// Fixtures — hand-built views with explicit ports arrays (the gestures.test.ts
// node() factory idea, local to this file).
// ---------------------------------------------------------------------------

const port = (
  index: number,
  cell_x: number,
  cell_y: number,
  side: number,
  role: number,
  medium = 0, // Mechanical=0, Electrical=1 (appended LAST on the wire, 35-03)
): PortView => ({ index, cell_x, cell_y, side, role, medium });

const node = (over: Partial<NodeView> & { id: number }): NodeView => ({
  kind: 0,
  cell_x: 0,
  cell_y: 0,
  state: 0,
  w: 1,
  h: 1,
  rot: 0,
  ports: [],
  load: 0,
  ...over,
});

const tile = (cell_x: number, cell_y: number): TileView => ({
  cell_x,
  cell_y,
  kind: { Straight: { axis: 0 } },
});

const belt = (over: Partial<BeltView> & { id: number }): BeltView => ({
  latency: 1,
  fill: 0,
  items: [],
  tiles: [],
  docks: [],
  // SLOT-03: appended LAST after `docks`; the identity interval. It sits BEFORE the
  // spread so an override can still set it, exactly like every other default here.
  ticks_per_slot: 1,
  ...over,
});

// FACTORY shape: catalog order In(0), Out(1), Fault(2) — the In-first invariant.
// 3x3 body at cell (2,3): In on the W edge middle row, Out on the E edge middle
// row, Fault on the S edge middle column (the anchor-math fixture from the plan).
const FACTORY = node({
  id: 7,
  cell_x: 2,
  cell_y: 3,
  w: 3,
  h: 3,
  ports: [
    port(0, 2, 4, 3, 0), // In,  W side
    port(1, 4, 4, 1, 1), // Out, E side
    port(2, 3, 5, 2, 2), // Fault, S side at cell (3,5)
  ],
});

// TEE shape: In(0), Out(1), Out(2) — two Outs so Tail routing keys 0/1 map to
// catalog indices 1/2.
const TEE = node({
  id: 8,
  cell_x: 10,
  cell_y: 10,
  w: 2,
  h: 2,
  ports: [
    port(0, 10, 10, 3, 0), // In,  W
    port(1, 11, 10, 1, 1), // Out, E (routing key 0)
    port(2, 11, 11, 1, 1), // Out, E (routing key 1)
  ],
});

// ROUTER shape: In(0), Out(1), Out(2), Out(3), Fault(4) - the post-71-04 catalog's
// INDEX order with its pre-74.1-14 CELLS (In (0,0), Outs on rows 2, 0, 1). Plan 74.1-14
// moved the catalog's cells (In (0,1), Outs on rows 1, 2, 0) and kept every index; this
// fixture FREEZES the older cells on purpose, because what it pins is keyspace
// resolution (a Head key is the raw index, a Tail key the n-th Out), which reads the
// index order and never the cells.
//
// MOVED in phase 71 (PILE-10, 71-CONTEXT D-07). This fixture used to declare
// In(0) + Out(1) only, with a comment stating the Router carries NO role-2 port
// because its fault output was a LOGICAL sentinel with no perimeter cell. Plan
// 71-04 gives the Router a real spatial Fault nub so a user can drag a belt onto
// it, which makes the old shape wrong, and this file's `dockPort` fault
// expectation is the one frontend assertion that genuinely reddens on that
// change. It is moved HERE, ahead of the catalog commit, because `ROUTER` is a
// const local to this file: the new shape is self-contained and passes at this
// commit without waiting on 71-04.
//
// Fault sorts LAST (catalog index 4) so no existing keyspace shifts. That is not
// left as a claim in this comment - see the "appending the Fault port shifts NO
// existing keyspace" case below, which pins every non-fault resolution to literal
// values.
//
// 2x3 body anchored at (20,20), so world cell = anchor + the catalog local offset.
const ROUTER = node({
  id: 9,
  cell_x: 20,
  cell_y: 20,
  w: 2,
  h: 3,
  ports: [
    port(0, 20, 20, 3, 0), // In,    W  local (0,0)
    port(1, 21, 22, 1, 1), // Out,   E  local (1,2) - the pre-74.1-14 first Out
    port(2, 21, 20, 1, 1), // Out,   E  local (1,0)
    port(3, 21, 21, 1, 1), // Out,   E  local (1,1)
    port(4, 20, 22, 2, 2), // Fault, S  local (0,2) - appended LAST
  ],
});

// ---------------------------------------------------------------------------
// Side math bridges
// ---------------------------------------------------------------------------

describe('sideToEdgeDir', () => {
  it('maps core Side (N=0,E=1,S=2,W=3) to legacy edge-dir (0=E,1=S,2=W,3=N)', () => {
    expect(sideToEdgeDir(0)).toBe(3); // N -> 3
    expect(sideToEdgeDir(1)).toBe(0); // E -> 0
    expect(sideToEdgeDir(2)).toBe(1); // S -> 1
    expect(sideToEdgeDir(3)).toBe(2); // W -> 2
  });
});

describe('unitDelta', () => {
  it('mirrors state.rs unit_delta: N=(0,-1) E=(1,0) S=(0,1) W=(-1,0)', () => {
    expect(unitDelta(0)).toEqual([0, -1]);
    expect(unitDelta(1)).toEqual([1, 0]);
    expect(unitDelta(2)).toEqual([0, 1]);
    expect(unitDelta(3)).toEqual([-1, 0]);
  });
});

describe('oppositeSide', () => {
  it('mirrors state.rs opposite: (side+2)&3', () => {
    expect(oppositeSide(0)).toBe(2);
    expect(oppositeSide(1)).toBe(3);
    expect(oppositeSide(2)).toBe(0);
    expect(oppositeSide(3)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dockPort — the three-keyspace resolver truth table (RESEARCH Finding 2)
// ---------------------------------------------------------------------------

describe('dockPort', () => {
  it('Head dock resolves the raw catalog index directly (In-first invariant)', () => {
    expect(dockPort(FACTORY, { end: 'Head', node: 7, port: 0 })).toBe(FACTORY.ports[0]);
    expect(dockPort(FACTORY, { end: 'Head', node: 7, port: 2 })).toBe(FACTORY.ports[2]);
  });

  it('Tail dock treats port as the Out ROUTING key (nth role===1 port)', () => {
    // FACTORY: routing key 0 -> the single Out at catalog index 1.
    expect(dockPort(FACTORY, { end: 'Tail', node: 7, port: 0 })).toBe(FACTORY.ports[1]);
  });

  it('TEE two-Out routing keys map to catalog indices 1 and 2', () => {
    expect(dockPort(TEE, { end: 'Tail', node: 8, port: 0 })).toBe(TEE.ports[1]);
    expect(dockPort(TEE, { end: 'Tail', node: 8, port: 1 })).toBe(TEE.ports[2]);
  });

  it('65535 sentinel resolves the role===2 fault port for EITHER end', () => {
    expect(dockPort(FACTORY, { end: 'Tail', node: 7, port: FAULT_PORT })).toBe(FACTORY.ports[2]);
    expect(dockPort(FACTORY, { end: 'Head', node: 7, port: FAULT_PORT })).toBe(FACTORY.ports[2]);
  });

  it('65535 resolves the ROUTER fault port too, now that the Router HAS a spatial one', () => {
    // MOVED in phase 71 (PILE-10, D-07). This case used to assert `toBeNull()` and
    // was named "on a node WITHOUT a spatial fault port". The null-degrade path it
    // guarded is NOT lost: `portFlow.test.ts` case 6 still exercises it, on a node it
    // builds inline with two ports and no fault, which is why that file's assertion
    // needs no change while this one did.
    expect(dockPort(ROUTER, { end: 'Tail', node: 9, port: FAULT_PORT })).toBe(ROUTER.ports[4]);
    expect(dockPort(ROUTER, { end: 'Head', node: 9, port: FAULT_PORT })).toBe(ROUTER.ports[4]);
  });

  it('appending the Fault port shifts NO existing ROUTER keyspace (Head raw index AND Tail routing key)', () => {
    // The claim "Fault sorts LAST so nothing moves" is CHECKED here rather than
    // asserted in a comment. Expectations are written as LITERAL port field values,
    // never re-derived from the ROUTER fixture: a re-derivation would follow a future
    // catalog reorder silently and pass, which is the check-that-cannot-fail shape.
    // A reorder has to come through these lines.
    //
    // Head branch indexes the ports array directly; Tail branch indexes a role-1
    // FILTER. Neither reaches index 4, which is why a trailing role-2 entry is safe.
    const at = (end: 'Head' | 'Tail', key: number) => {
      const resolved = dockPort(ROUTER, { end, node: 9, port: key });
      expect(resolved, `${end} key ${key} must resolve`).not.toBeNull();
      return [resolved!.index, resolved!.cell_x, resolved!.cell_y, resolved!.side, resolved!.role];
    };

    // Head: the raw catalog index (In first, then the three E-column Outs).
    expect(at('Head', 0)).toEqual([0, 20, 20, 3, 0]);
    expect(at('Head', 1)).toEqual([1, 21, 22, 1, 1]);
    expect(at('Head', 2)).toEqual([2, 21, 20, 1, 1]);
    expect(at('Head', 3)).toEqual([3, 21, 21, 1, 1]);

    // Tail: the Out routing key, over the role-1 filter. Key 0 is the first Out, at
    // catalog index 1 (on this fixture's frozen pre-74.1-14 cell).
    expect(at('Tail', 0)).toEqual([1, 21, 22, 1, 1]);
    expect(at('Tail', 1)).toEqual([2, 21, 20, 1, 1]);
    expect(at('Tail', 2)).toEqual([3, 21, 21, 1, 1]);

    // And the Fault is reachable ONLY through the sentinel, never as a routing key:
    // three Outs means key 3 is past the end of the filter.
    expect(dockPort(ROUTER, { end: 'Tail', node: 9, port: 3 })).toBeNull();
  });

  it('out-of-range Head index resolves to null', () => {
    expect(dockPort(FACTORY, { end: 'Head', node: 7, port: 99 })).toBeNull();
  });

  it('out-of-range Tail routing key resolves to null', () => {
    expect(dockPort(TEE, { end: 'Tail', node: 8, port: 2 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Belt end geometry (RESEARCH Finding 1)
// ---------------------------------------------------------------------------

describe('beltEndCell / beltEndOutward', () => {
  const tiles = [tile(0, 0), tile(1, 0), tile(2, 0)];

  it('Head is the LAST tile, Tail is the FIRST tile', () => {
    expect(beltEndCell(tiles, 'Head')).toEqual([2, 0]);
    expect(beltEndCell(tiles, 'Tail')).toEqual([0, 0]);
  });

  it('outward = end cell minus inner neighbour', () => {
    expect(beltEndOutward(tiles, 'Head')).toEqual([1, 0]); // (2,0)-(1,0)
    expect(beltEndOutward(tiles, 'Tail')).toEqual([-1, 0]); // (0,0)-(1,0)
  });

  it('single-tile belt has no outward direction (null)', () => {
    const one = [tile(5, 5)];
    expect(beltEndOutward(one, 'Head')).toBeNull();
    expect(beltEndOutward(one, 'Tail')).toBeNull();
    expect(beltEndCell(one, 'Head')).toEqual([5, 5]);
    expect(beltEndCell(one, 'Tail')).toEqual([5, 5]);
  });
});

// ---------------------------------------------------------------------------
// acceptsDock — the EXACT host accept-predicate mirror (command.rs:472-537)
// ---------------------------------------------------------------------------

describe('acceptsDock', () => {
  // An In port at cell (5,5) facing E: the belt end must sit at (6,5) and, when
  // present, the belt's outward direction must NOT be E = unitDelta(side) (74.1: the
  // carrier may arrive straight, outward W, or turn at the doorstep, outward N or S).
  const inE = port(0, 5, 5, 1, 0);
  const outE = port(1, 5, 5, 1, 1);
  const faultE = port(2, 5, 5, 1, 2);

  it('Head end requires role In (0)', () => {
    expect(acceptsDock(inE, 'Head', [6, 5], [-1, 0], MACHINE_TARGET)).toBe(true);
    expect(acceptsDock(outE, 'Head', [6, 5], [-1, 0], MACHINE_TARGET)).toBe(false);
    expect(acceptsDock(faultE, 'Head', [6, 5], [-1, 0], MACHINE_TARGET)).toBe(false);
  });

  it('Tail end accepts role Out (1) or Fault (2), rejects In (0)', () => {
    expect(acceptsDock(outE, 'Tail', [6, 5], [-1, 0], MACHINE_TARGET)).toBe(true);
    expect(acceptsDock(faultE, 'Tail', [6, 5], [-1, 0], MACHINE_TARGET)).toBe(true);
    expect(acceptsDock(inE, 'Tail', [6, 5], [-1, 0], MACHINE_TARGET)).toBe(false);
  });

  it('adjacency: only endCell == port cell + unitDelta(side) accepts', () => {
    expect(acceptsDock(inE, 'Head', [5, 5], [-1, 0], MACHINE_TARGET)).toBe(false); // on the port cell
    expect(acceptsDock(inE, 'Head', [7, 5], [-1, 0], MACHINE_TARGET)).toBe(false); // one too far
    expect(acceptsDock(inE, 'Head', [6, 6], [-1, 0], MACHINE_TARGET)).toBe(false); // diagonal
  });

  it('facing: refused only when outward equals unitDelta(side), the carrier pointing into the port (74.1)', () => {
    // REPLACES `facing: outward must equal unitDelta(oppositeSide(side)) when present`.
    // Phase 74.1 (D-02) narrowed the host's facing clause to `oside == mside` in
    // `command.rs`, and this mirror narrows with it in the same plan (Pitfall 6).
    // Outward == the port side is the one geometry where the carrier's inner tile
    // would sit on the target's own cell: refused. Every other direction is accepted,
    // including the two perpendiculars, which is what lets a belt turn at a doorstep.
    expect(acceptsDock(inE, 'Head', [6, 5], [1, 0], MACHINE_TARGET)).toBe(false); // outward E == side E
    expect(acceptsDock(inE, 'Head', [6, 5], [0, 1], MACHINE_TARGET)).toBe(true); // perpendicular, S
    expect(acceptsDock(inE, 'Head', [6, 5], [0, -1], MACHINE_TARGET)).toBe(true); // perpendicular, N
    expect(acceptsDock(inE, 'Head', [6, 5], [-1, 0], MACHINE_TARGET)).toBe(true); // straight in, W
  });

  it('single-tile belt (outward null) skips the facing check', () => {
    expect(acceptsDock(inE, 'Head', [6, 5], null, MACHINE_TARGET)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// dockCandidates — auto-dock exactly-one counting + armed-ring candidates
// ---------------------------------------------------------------------------

describe('dockCandidates', () => {
  it('returns exactly the accepting (node, port) pairs across multiple nodes', () => {
    // FACTORY In port is at cell (2,4) side W: accepting end cell is (1,4)
    // with outward E = unitDelta(opposite(W)) = (1,0).
    const hits = dockCandidates([FACTORY, TEE, ROUTER], 'Head', [1, 4], [1, 0]);
    expect(hits).toHaveLength(1);
    expect(hits[0].node).toBe(FACTORY);
    expect(hits[0].port).toBe(FACTORY.ports[0]);
  });

  it('is empty when no port accepts', () => {
    expect(dockCandidates([FACTORY, TEE, ROUTER], 'Head', [100, 100], null)).toEqual([]);
  });

  it('a Head arriving PERPENDICULAR at an In doorstep is exactly one candidate (D-14, 74.1)', () => {
    // D-14, NAMED: a belt that ends SIDEWAYS in front of an input now auto-connects,
    // because the auto-dock fallback counts `dockCandidates` and the mirror narrowed.
    // FACTORY's In port is at (2,4) facing W, so its doorstep is (1,4). A belt whose
    // Head arrives there travelling SOUTH has outward (0,1), perpendicular to W.
    // Before 74.1 this was zero candidates (outward had to be E).
    const hits = dockCandidates([FACTORY, TEE, ROUTER], 'Head', [1, 4], [0, 1]);
    expect(hits).toHaveLength(1);
    expect(hits[0].node).toBe(FACTORY);
    expect(hits[0].port).toBe(FACTORY.ports[0]);
    // The one direction still refused: pointing INTO the port, outward W.
    expect(dockCandidates([FACTORY, TEE, ROUTER], 'Head', [1, 4], [-1, 0])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nub anchor math (must reproduce machines.ts drawNub geometry exactly:
// CELL=32, INSET=2, 2.5px outward push)
// ---------------------------------------------------------------------------

describe('worldNubSpecs / localNubSpecs', () => {
  it('FACTORY south fault port at cell (3,5) anchors at (3*CELL+CELL/2, 5*CELL+CELL-2+2.5)', () => {
    const world = worldNubSpecs(FACTORY);
    const fault = world.find((s) => s.role === 2)!;
    expect(fault.x).toBe(3 * CELL + CELL / 2); // 112
    expect(fault.y).toBe(5 * CELL + CELL - 2 + 2.5); // 190.5
    expect([fault.nx, fault.ny]).toEqual([0, 1]);
    expect(fault.side).toBe(2);
    expect(fault.index).toBe(2);
  });

  it('FACTORY west In port at cell (2,4) anchors at (2*CELL+2-2.5, 4*CELL+CELL/2)', () => {
    const world = worldNubSpecs(FACTORY);
    const inn = world.find((s) => s.role === 0)!;
    expect(inn.x).toBe(2 * CELL + 2 - 2.5); // 63.5
    expect(inn.y).toBe(4 * CELL + CELL / 2); // 144
    expect([inn.nx, inn.ny]).toEqual([-1, 0]);
  });

  it('localNubSpecs subtracts the node cell origin (node-root-local frame)', () => {
    const local = localNubSpecs(FACTORY);
    const fault = local.find((s) => s.role === 2)!;
    // local cell = (3-2, 5-3) = (1, 2)
    expect(fault.x).toBe(1 * CELL + CELL / 2); // 48
    expect(fault.y).toBe(2 * CELL + CELL - 2 + 2.5); // 94.5
    expect([fault.nx, fault.ny]).toEqual([0, 1]);
  });

  it('emits one spec per port in port order', () => {
    expect(worldNubSpecs(FACTORY).map((s) => s.index)).toEqual([0, 1, 2]);
    expect(worldNubSpecs(node({ id: 1 }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// belt ports + the seam (Phase 74, LINK-02/03/10)
// ---------------------------------------------------------------------------

/** An EMPTY belts map - every pre-Phase-74 `beltHandlePoints` case is a
 *  machine-dock or undocked case, so no belt is reachable through it. */
const NO_BELTS = new Map<number, BeltView>();

/** Two belts abutting on the shared edge between (3,0) and (4,0): `up` runs
 *  east and its HEAD is (3,0); `down` runs east from (4,0) so its TAIL is
 *  (4,0). `up`'s Head docks to `down`'s Tail, which is the one join this phase
 *  ships, projected from both sides exactly as `belt_docks` projects it. */
const abutting = (): { up: BeltView; down: BeltView; belts: Map<number, BeltView> } => {
  const up = belt({
    id: 21,
    tiles: [tile(2, 0), tile(3, 0)],
    docks: [{ end: 'Head', node: 22, port: BELT_PORT_TAIL }],
  });
  const down = belt({
    id: 22,
    tiles: [tile(4, 0), tile(5, 0)],
    docks: [{ end: 'Tail', node: 21, port: BELT_PORT_HEAD }],
  });
  return {
    up,
    down,
    belts: new Map([
      [up.id, up],
      [down.id, down],
    ]),
  };
};

describe('beltEndPort - the frontend twin of belt_end_world', () => {
  it('a Head is Role::Out at the LAST tile, facing outward; a Tail is Role::In at the first', () => {
    const tiles = [tile(2, 0), tile(3, 0)];
    const head = beltEndPort(tiles, 'Head');
    expect(head).toEqual({
      index: BELT_PORT_HEAD,
      cell_x: 3,
      cell_y: 0,
      side: 1, // E - the outward step (3,0)-(2,0)
      role: 1, // Out
      medium: MEDIUM_MECHANICAL,
    });
    const tail = beltEndPort(tiles, 'Tail');
    expect(tail).toEqual({
      index: BELT_PORT_TAIL,
      cell_x: 2,
      cell_y: 0,
      side: 3, // W
      role: 0, // In
      medium: MEDIUM_MECHANICAL,
    });
  });

  it('a SINGLE-TILE belt has no side, so it has no port - the host refuses it too', () => {
    // command.rs: `tside.ok_or(CommandError::InvalidDock)`. A fabricated side here
    // would rank a target the host cannot accept.
    expect(beltEndPort([tile(5, 5)], 'Head')).toBeNull();
    expect(beltEndPort([tile(5, 5)], 'Tail')).toBeNull();
    expect(beltEndPort([], 'Head')).toBeNull();
  });

  it('the belt-end port satisfies acceptsDock against the OTHER belt end that abuts it', () => {
    // The whole point of answering in `PortView` shape: no second accept path.
    const { up, down } = abutting();
    const target = beltEndPort(down.tiles, 'Tail');
    expect(target).not.toBeNull();
    expect(
      acceptsDock(
        target as PortView,
        'Head',
        beltEndCell(up.tiles, 'Head'),
        beltEndOutward(up.tiles, 'Head'),
        beltTarget(down.tiles, 'Tail'),
      ),
    ).toBe(true);
  });

  it('a belt end one cell too far away is REFUSED by the same predicate', () => {
    // NON-VACUITY for the case above: `acceptsDock` really is deciding.
    const far = belt({ id: 31, tiles: [tile(6, 0), tile(7, 0)] });
    const up = belt({ id: 30, tiles: [tile(2, 0), tile(3, 0)] });
    const target = beltEndPort(far.tiles, 'Tail');
    expect(
      acceptsDock(
        target as PortView,
        'Head',
        beltEndCell(up.tiles, 'Head'),
        beltEndOutward(up.tiles, 'Head'),
        beltTarget(far.tiles, 'Tail'),
      ),
    ).toBe(false);
  });
});

describe('dockRoleOk - the role half of the dock rule, on its own', () => {
  it('Head takes In only; Tail takes Out or Fault, never In', () => {
    const p = (role: number): PortView => port(0, 0, 0, 0, role);
    expect(dockRoleOk(p(0), 'Head')).toBe(true);
    expect(dockRoleOk(p(1), 'Head')).toBe(false);
    expect(dockRoleOk(p(2), 'Head')).toBe(false);
    expect(dockRoleOk(p(0), 'Tail')).toBe(false);
    expect(dockRoleOk(p(1), 'Tail')).toBe(true);
    expect(dockRoleOk(p(2), 'Tail')).toBe(true);
  });

  it('is the SAME rule acceptsDock applies, not a second copy of it', () => {
    // Asserted by construction: a port that satisfies adjacency, facing and medium is
    // accepted exactly when `dockRoleOk` says its role is right. A drifted copy shows
    // up here as a disagreement on at least one of the six (role, end) pairs.
    const tiles = [tile(2, 0), tile(3, 0)];
    const endCell = beltEndCell(tiles, 'Head');
    const outward = beltEndOutward(tiles, 'Head');
    for (const role of [0, 1, 2]) {
      // A port at (4,0) facing W is adjacent to and facing the Head at (3,0).
      const p = port(0, 4, 0, 3, role);
      expect(acceptsDock(p, 'Head', endCell, outward, MACHINE_TARGET)).toBe(dockRoleOk(p, 'Head'));
    }
  });
});

// ---------------------------------------------------------------------------
// acceptsDock with a BELT target (plan 74.1-15, gap N4): the TS mirror of the host's
// belt branch, case for case with `crates/fabrico-command/tests/belt_join_both_ways.rs`.
// ---------------------------------------------------------------------------

describe('acceptsDock with a belt target: a join from either belt (74.1-15, N4)', () => {
  /** Ask the mirror the host's question: `carrier`'s `end` docked onto `target`. */
  const joins = (carrier: TileView[], end: 'Head' | 'Tail', target: TileView[]): boolean => {
    const tend = end === 'Head' ? 'Tail' : 'Head';
    const tport = beltEndPort(target, tend);
    // A single-tile target answers no port at all (no side): the host refuses it too.
    if (tport === null) {
      return false;
    }
    return acceptsDock(
      tport,
      end,
      beltEndCell(carrier, end),
      beltEndOutward(carrier, end),
      beltTarget(target, tend),
    );
  };
  const run = (...cells: [number, number][]): TileView[] => cells.map(([x, y]) => tile(x, y));
  // The dry-run board: main belt (4,6)->(7,6) east, side belt (4,3)->(4,5) south.
  const MAIN = run([4, 6], [5, 6], [6, 6], [7, 6]);
  const SIDE = run([4, 3], [4, 4], [4, 5]);

  it('dragging either belt makes the same join', () => {
    expect(joins(MAIN, 'Tail', SIDE), 'main Tail onto side Head (accepted before 74.1-15)').toBe(true);
    expect(joins(SIDE, 'Head', MAIN), 'side Head onto main Tail (refused before 74.1-15)').toBe(true);
  });

  it('a carrier two cells away is refused', () => {
    const far = run([4, 2], [4, 3], [4, 4]);
    expect(joins(far, 'Head', MAIN)).toBe(false);
    expect(joins(MAIN, 'Tail', far)).toBe(false);
  });

  it("a belt cannot join its own inner tile", () => {
    const two = run([20, 5], [21, 5]);
    expect(beltEndInner(two, 'Head')).toEqual([20, 5]);
    expect(beltEndInner(two, 'Tail')).toEqual([21, 5]);
    expect(joins(two, 'Tail', two)).toBe(false);
    expect(joins(two, 'Head', two)).toBe(false);
  });

  it('a single-tile target is refused, and a single-tile belt has no inner tile', () => {
    const one = run([4, 5]);
    expect(beltEndInner(one, 'Head')).toBeNull();
    expect(joins(MAIN, 'Tail', one)).toBe(false);
    // Even handed a port, the belt shape with no inner tile refuses.
    expect(
      acceptsDock(port(1, 4, 5, 2, 1), 'Tail', [4, 6], [-1, 0], { kind: 'belt', inner: null }),
    ).toBe(false);
  });

  it('a Head onto a Head is refused (role)', () => {
    const a = run([10, 30], [11, 30], [12, 30]);
    const headB = beltEndPort(run([14, 30], [13, 30]), 'Head') as PortView;
    expect(
      acceptsDock(headB, 'Head', beltEndCell(a, 'Head'), beltEndOutward(a, 'Head'), {
        kind: 'belt',
        inner: [14, 30],
      }),
    ).toBe(false);
  });

  it('a U-turn join is refused both ways (the kept D-02 facing term)', () => {
    const a = run([10, 20], [11, 20], [12, 20]);
    const b = run([12, 21], [11, 21], [10, 21]);
    expect(joins(a, 'Head', b)).toBe(false);
    expect(joins(b, 'Tail', a)).toBe(false);
  });

  it('a join where both ends turn is accepted (a sideways jog)', () => {
    // Target running east ending above the carrier's first tile; carrier running east.
    const target = run([2, 4], [3, 4], [4, 4]);
    const carrier = run([4, 5], [5, 5], [6, 5]);
    expect(joins(carrier, 'Tail', target)).toBe(true);
    expect(joins(target, 'Head', carrier)).toBe(true);
  });

  it('a MACHINE target keeps the doorstep rule: next to the port cell but off the doorstep is refused', () => {
    // An Out port at (10,10) facing E; doorstep (11,10). A carrier Tail at (10,11),
    // running south, is one step from the PORT cell, which the belt rule would accept.
    const out = port(0, 10, 10, 1, 1);
    expect(acceptsDock(out, 'Tail', [10, 11], [0, -1], MACHINE_TARGET)).toBe(false);
    expect(acceptsDock(out, 'Tail', [10, 11], [0, -1], { kind: 'belt', inner: [9, 10] })).toBe(true);
    expect(acceptsDock(out, 'Tail', [11, 10], [-1, 0], MACHINE_TARGET)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE MIRROR HELD TO THE ENGINE (plan 74.1-15): `acceptsDock` with a belt target agrees
// with every row of `belt_join.expected.json`, a table of REAL `GridSession` Dock verdicts
// frozen by `crates/fabrico-command/tests/belt_join_golden.rs`.
// ---------------------------------------------------------------------------

interface BeltJoinRow {
  carrier: [number, number][];
  carrier_end: 'Head' | 'Tail';
  target: [number, number][];
  target_end: 'Head' | 'Tail';
  class: string;
  verdict: string;
}

describe('acceptsDock agrees with the frozen engine verdicts in belt_join.expected.json', () => {
  const rows = JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../../../crates/fabrico-command/tests/fixtures/belt_join.expected.json'),
      'utf8',
    ),
  ) as BeltJoinRow[];

  /** The mirror's answer for one row: the target end's port, judged with its belt shape. */
  const predicts = (r: BeltJoinRow): boolean => {
    const carrier = r.carrier.map(([x, y]) => tile(x, y));
    const target = r.target.map(([x, y]) => tile(x, y));
    const tport = beltEndPort(target, r.target_end);
    // A single-tile target answers no port: the host's own refusal.
    if (tport === null) {
      return false;
    }
    return acceptsDock(
      tport,
      r.carrier_end,
      beltEndCell(carrier, r.carrier_end),
      beltEndOutward(carrier, r.carrier_end),
      beltTarget(target, r.target_end),
    );
  };

  it('is non-vacuous: accepts and every refusal class are present', () => {
    const count = (c: string): number => rows.filter((r) => r.class === c).length;
    expect(rows.filter((r) => r.verdict === 'ok').length).toBeGreaterThanOrEqual(20);
    for (const c of ['distance', 'inner', 'single', 'role', 'uturn']) {
      expect(count(c), `at least one ${c} row`).toBeGreaterThanOrEqual(1);
    }
  });

  // The family-to-tag map lives in `belt_join_golden.rs` (`tag_of_family`); its TS copy was dropped (74.1-33, IN-05).

  it('every row: acceptsDock predicts exactly the host verdict', () => {
    const disagree = rows.filter((r) => predicts(r) !== (r.verdict === 'ok'));
    expect(
      disagree.length,
      `first disagreeing row: ${disagree.length > 0 ? JSON.stringify(disagree[0]) : 'none'}`,
    ).toBe(0);
  });
});

describe('beltDockPartnerEnd', () => {
  it('a Head dock names the partner Tail and a Tail dock names the partner Head', () => {
    expect(beltDockPartnerEnd('Head')).toBe('Tail');
    expect(beltDockPartnerEnd('Tail')).toBe('Head');
  });
});

describe('beltSeamPoint - the ONE seam definition', () => {
  it('the seam is the midpoint of the two abutting end tile centres, ON their shared edge', () => {
    const { up, belts } = abutting();
    // Centres are (3.5, 0.5) and (4.5, 0.5) cells => the shared edge x = 4*CELL.
    expect(beltSeamPoint(belts, up, 'Head')).toEqual({ x: 4 * CELL, y: CELL / 2 });
  });

  it('BOTH sides of one join resolve to the SAME point - that is what makes it one seam', () => {
    const { up, down, belts } = abutting();
    expect(beltSeamPoint(belts, down, 'Tail')).toEqual(beltSeamPoint(belts, up, 'Head'));
  });

  it('an undocked end, a MACHINE dock and an unknown handle all answer null', () => {
    const { belts } = abutting();
    const plain = belt({ id: 40, tiles: [tile(0, 0), tile(1, 0)] });
    expect(beltSeamPoint(belts, plain, 'Head')).toBeNull();
    const toMachine = belt({
      id: 41,
      tiles: [tile(0, 0), tile(1, 0)],
      docks: [{ end: 'Head', node: 7, port: 0 }], // FACTORY, not a belt
    });
    expect(beltSeamPoint(belts, toMachine, 'Head')).toBeNull();
    const toNobody = belt({
      id: 42,
      tiles: [tile(0, 0), tile(1, 0)],
      docks: [{ end: 'Head', node: 9999, port: 0 }],
    });
    expect(beltSeamPoint(belts, toNobody, 'Head')).toBeNull();
  });

  it('a FAN-IN Tail has NO single seam, so it answers null and the grab dot stays put', () => {
    // The 74-04 handover: `belt_docks` reports EVERY Tail upstream since LINK-13, so a
    // downstream fed by two upstreams carries TWO Tail docks whose joints sit at two
    // different half-cell offsets from its ONE Tail end tile centre. A `find`-first
    // read would put the handle on whichever upstream ascending link order reached
    // first, and MOVE it when the user added a second branch.
    const a = belt({ id: 61, tiles: [tile(2, 0), tile(3, 0)] });
    const b = belt({ id: 62, tiles: [tile(4, 2), tile(4, 1)] });
    const down = belt({
      id: 63,
      tiles: [tile(4, 0), tile(5, 0)],
      docks: [
        { end: 'Tail', node: 61, port: BELT_PORT_HEAD },
        { end: 'Tail', node: 62, port: BELT_PORT_HEAD },
      ],
    });
    const belts = new Map([
      [61, a],
      [62, b],
      [63, down],
    ]);
    expect(beltSeamPoint(belts, down, 'Tail')).toBeNull();
    // With ONE upstream the same belt DOES answer, so the null above is the ambiguity
    // and not a blanket refusal to resolve a Tail.
    const oneUpstream = belt({
      id: 63,
      tiles: [tile(4, 0), tile(5, 0)],
      docks: [{ end: 'Tail', node: 61, port: BELT_PORT_HEAD }],
    });
    expect(beltSeamPoint(belts, oneUpstream, 'Tail')).toEqual({ x: 4 * CELL, y: CELL / 2 });
    // And each UPSTREAM Head still resolves to its own seam - the two joints exist,
    // only the downstream's single handle cannot name one of them.
    const upA = belt({
      id: 61,
      tiles: [tile(2, 0), tile(3, 0)],
      docks: [{ end: 'Head', node: 63, port: BELT_PORT_TAIL }],
    });
    expect(beltSeamPoint(belts, upA, 'Head')).toEqual({ x: 4 * CELL, y: CELL / 2 });
  });

  it('a geometry-empty partner answers null rather than a point derived from no tiles', () => {
    const wireMinted = belt({ id: 51, tiles: [] });
    const b = belt({
      id: 50,
      tiles: [tile(0, 0), tile(1, 0)],
      docks: [{ end: 'Head', node: 51, port: BELT_PORT_TAIL }],
    });
    expect(beltSeamPoint(new Map([[51, wireMinted]]), b, 'Head')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// beltHandlePoints — endpoint handle anchors
// ---------------------------------------------------------------------------

describe('beltHandlePoints', () => {
  const nodes = new Map<number, NodeView>([
    [FACTORY.id, FACTORY],
    [ROUTER.id, ROUTER],
  ]);

  it('docked end anchors at the resolved nub center; undocked end at tile center', () => {
    // Head (last tile) docked to FACTORY In port 0 at cell (2,4) side W.
    const b = belt({
      id: 3,
      tiles: [tile(1, 5), tile(1, 4)],
      docks: [{ end: 'Head', node: 7, port: 0 }],
    });
    const pts = beltHandlePoints(nodes, NO_BELTS, b);
    expect(pts.head).toEqual({ x: 2 * CELL + 2 - 2.5, y: 4 * CELL + CELL / 2 }); // nub anchor
    expect(pts.tail).toEqual({ x: 1 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }); // first tile center
  });

  it('a dock that resolves to null (a node with no fault port) falls back to tile center', () => {
    // The null source is built INLINE rather than borrowed from a shared catalog
    // fixture. It used to point at ROUTER, whose fault port was a logical sentinel
    // with no perimeter cell - and when phase 71 gave the Router a spatial Fault nub
    // (D-07) this case stopped exercising the null path and started asserting a nub
    // anchor, which is exactly how a case quietly stops testing what it names. A node
    // with two Outs and no role-2 port cannot be retargeted by a catalog widening.
    const faultless = node({
      id: 99,
      cell_x: 19,
      cell_y: 20,
      w: 1,
      h: 2,
      ports: [port(0, 19, 20, 3, 0), port(1, 19, 21, 1, 1)],
    });
    const b = belt({
      id: 4,
      tiles: [tile(19, 20), tile(19, 21)],
      docks: [{ end: 'Tail', node: 99, port: FAULT_PORT }],
    });
    const pts = beltHandlePoints(new Map([[faultless.id, faultless]]), NO_BELTS, b);
    expect(pts.tail).toEqual({ x: 19 * CELL + CELL / 2, y: 20 * CELL + CELL / 2 });
  });

  it('a dock naming an unknown node handle falls back to tile center', () => {
    const b = belt({
      id: 5,
      tiles: [tile(0, 0)],
      docks: [{ end: 'Head', node: 999, port: 0 }],
    });
    const pts = beltHandlePoints(nodes, NO_BELTS, b);
    expect(pts.head).toEqual({ x: CELL / 2, y: CELL / 2 });
  });

  it('an end docked to ANOTHER BELT anchors at the seam, not at the end tile centre', () => {
    // 74-UI-SPEC 1.3. `dockPort` returns null for a belt-handled dock, so before
    // Phase 74 this fell back to the tile centre - half a cell away from the collar.
    const { up, belts } = abutting();
    const pts = beltHandlePoints(nodes, belts, up);
    expect(pts.head).toEqual({ x: 4 * CELL, y: CELL / 2 });
    // The tile centre is what it MUST NOT be, stated so the case cannot pass by
    // accident on a build where the seam arm was never reached.
    expect(pts.head).not.toEqual({ x: 3 * CELL + CELL / 2, y: CELL / 2 });
    // The undocked Tail is unchanged.
    expect(pts.tail).toEqual({ x: 2 * CELL + CELL / 2, y: CELL / 2 });
  });
});

// ---------------------------------------------------------------------------
// rotateCatalogPort — anchorless-ghost local rotation (state.rs:765-784 mirror)
// ---------------------------------------------------------------------------

describe('rotateCatalogPort', () => {
  // A (local 1,0 side E) port on a 2x3 footprint, all four rots.
  // `medium` is stated because `CatalogPortView` carries it since 72-05 and `cp()` was
  // given NO default: rotation is geometry and does not read the field, but a fixture
  // that omitted it would be the one place a medium goes unstated by accident.
  const p = { index: 0, local_x: 1, local_y: 0, side: 1, role: 1, medium: 0 };

  it('rot 0 is the identity', () => {
    expect(rotateCatalogPort(p, 2, 3, 0)).toEqual({ lx: 1, ly: 0, side: 1 });
  });

  it('rot 1: [h-1-y, x], side+1', () => {
    expect(rotateCatalogPort(p, 2, 3, 1)).toEqual({ lx: 2, ly: 1, side: 2 });
  });

  it('rot 2: [w-1-x, h-1-y], side+2', () => {
    expect(rotateCatalogPort(p, 2, 3, 2)).toEqual({ lx: 0, ly: 2, side: 3 });
  });

  it('rot 3: [y, w-1-x], side+3 wraps', () => {
    expect(rotateCatalogPort(p, 2, 3, 3)).toEqual({ lx: 0, ly: 0, side: 0 });
  });

  it('rot wraps mod 4', () => {
    expect(rotateCatalogPort(p, 2, 3, 4)).toEqual(rotateCatalogPort(p, 2, 3, 0));
  });
});

// ---------------------------------------------------------------------------
// nubHitRadiusWorld — LOCKED Open Question 2 policy
// ---------------------------------------------------------------------------

describe('nubHitRadiusWorld', () => {
  it('is 12 world px at zoom >= 1 and grows in world units below zoom 1', () => {
    expect(nubHitRadiusWorld(1)).toBe(12);
    expect(nubHitRadiusWorld(0.25)).toBe(48); // 12 screen px at MIN_ZOOM
    expect(nubHitRadiusWorld(4)).toBe(12); // never shrinks above zoom 1
  });

  // THE CONSTRAINT PLAN 66-06 PUT ON ITSELF, WRITTEN AS A TEST RATHER THAN A PROMISE.
  // 66-06 widens the WIRE tool's grab target and must leave this one alone: it is shared
  // with the belt dock path, the idle nub hover and both belt port-to-port endpoints, so
  // widening it here would silently re-tune the belt dock ranker Phase 64 stabilised.
  // Phase 67 owns the belt half of WINDOWS row 113. The case above already pins the
  // value; this one states WHY it may not move, so a later reader who finds the wire
  // radius and thinks "these should be the same function" reddens instead of merging.
  it('did NOT move when the wire tool got its own wider radius (66-06 scope constraint)', () => {
    expect(nubHitRadiusWorld(1), 'the SHIPPED belt/hover radius').toBe(12);
    expect(nubHitRadiusWorld(0.5), 'the shipped radius at zoom 0.5').toBe(24);
    // And the two are genuinely different functions, not one aliased to the other.
    expect(wireNubHitRadiusWorld(1)).not.toBe(nubHitRadiusWorld(1));
  });
});

// ---------------------------------------------------------------------------
// wireNubHitRadiusWorld - the 44px chrome rule applied to the canvas (66-06, UI-SPEC 6.1)
// ---------------------------------------------------------------------------

describe('wireNubHitRadiusWorld', () => {
  it('is MIN_TARGET_PX/2 world px at zoom >= 1, on the SAME D-16 zoom policy', () => {
    // 22 at zoom 1 - a 44px DIAMETER target, which is the style-bible 6d floor every
    // `.fab-*` control already honours and the canvas did not. The expected value is
    // DERIVED from the exported constant, never transcribed: a transcribed 22 here
    // would agree with a copy of itself and stay green while the chrome rule moved.
    expect(wireNubHitRadiusWorld(1)).toBe(MIN_TARGET_PX / 2);
    expect(wireNubHitRadiusWorld(0.5)).toBe(MIN_TARGET_PX); // constant DEVICE size
    expect(wireNubHitRadiusWorld(0.25)).toBe(MIN_TARGET_PX * 2); // 22 screen px at MIN_ZOOM
    expect(wireNubHitRadiusWorld(4)).toBe(MIN_TARGET_PX / 2); // never shrinks above zoom 1
  });

  it('is WIDER than the shipped nub radius at every reachable zoom', () => {
    // The whole point of the plan: WINDOWS row 113 is a user who could not hit the
    // shipped target. If this ever inverts, the wire tool has silently become HARDER
    // to hit than the belt path it was widened away from.
    for (const scale of [0.25, 0.5, 1, 2, 4]) {
      expect(wireNubHitRadiusWorld(scale), `zoom ${scale}`).toBeGreaterThan(
        nubHitRadiusWorld(scale),
      );
    }
  });

  it('reads the ONE exported 44, so the chrome token and the canvas cannot drift', () => {
    // Half of the contract: the canvas radius is exactly half the SAME constant the CSS
    // emitter stringifies. This is a NON-DRIFT gate and it is blind to the constant
    // moving, by construction - both sides move together. Measured: with MIN_TARGET_PX
    // set to 40 this case stays green at 20. That is why the case below exists.
    expect(wireNubHitRadiusWorld(1) * 2).toBe(MIN_TARGET_PX);
  });

  it('is 22 world px because style-bible section 6 says 44px, parsed not transcribed', () => {
    // THE OTHER HALF, AND THE ONE THAT CAN ACTUALLY REFUSE A NEW VALUE (plan 66-06).
    // Every other assertion in this block derives from `MIN_TARGET_PX`, so a change to
    // the constant slides all of them together. The style bible is the document the
    // chrome rule is contracted to and the only authority outside the constant, so the
    // expected diameter is read OFF THE MARKDOWN. `skinToCssVars.test.ts` pins the
    // constant against the same row from the other side; between them, a change to
    // MIN_TARGET_PX reddens the chrome emitter's spec AND this canvas hit test, which
    // is the "one constant, two consumers, a change reddens both" property in full.
    const diameter = bibleMinTargetPx();
    expect(wireNubHitRadiusWorld(1), `bible declares ${diameter}px`).toBe(diameter / 2);
  });
});

// PORT-08 (36-03/36-05): the belt-medium dock gate. A belt is ALWAYS a Mechanical
// carrier, so acceptsDock must reject an otherwise-legal dock onto an Electrical
// (wire) port — the TS mirror of the host's MediumMismatch gate. These pin the
// shared predicate + the medium-only reject signal the reject flash rides.
describe('belt-medium dock gate (PORT-08)', () => {
  // An Out port at (6,5) facing E; a Tail dock from a belt whose Tail tile is
  // (7,5) with outward (-1,0) passes ALL geometry (role/adjacency/facing).
  const outAt = (medium: number): PortView => port(1, 6, 5, /* E */ 1, /* Out */ 1, medium);
  const endCell: [number, number] = [7, 5];
  const outward: [number, number] = [-1, 0];

  it('mediumsCompatible is exact-match (the shared type rule, plan 36-03)', () => {
    expect(mediumsCompatible(MEDIUM_MECHANICAL, MEDIUM_MECHANICAL)).toBe(true);
    expect(mediumsCompatible(MEDIUM_ELECTRICAL, MEDIUM_ELECTRICAL)).toBe(true);
    expect(mediumsCompatible(MEDIUM_MECHANICAL, MEDIUM_ELECTRICAL)).toBe(false);
  });

  it('acceptsDock passes a Mechanical Out port (a belt can carry it)', () => {
    expect(acceptsDock(outAt(MEDIUM_MECHANICAL), 'Tail', endCell, outward, MACHINE_TARGET)).toBe(true);
  });

  it('acceptsDock REJECTS an Electrical Out port even when all geometry fits', () => {
    expect(acceptsDock(outAt(MEDIUM_ELECTRICAL), 'Tail', endCell, outward, MACHINE_TARGET)).toBe(false);
  });

  // The medium-only rejection predicate was DELETED in Phase 64 (D-10) along
  // with its two callers. Its only job was telling the client WHICH reason to guess for a
  // geometrically-valid-but-wrong-medium drop, so that the canvas flash could
  // name a cause. The flash now carries LOCATION only and the host's typed
  // `MediumMismatch` carries the reason, so the client never invents one — which
  // is what retires drift C (`64-REACHABILITY.md`). The three cases that lived
  // here proved a distinction (medium-reject vs geometric miss) that no longer
  // exists on any code path: both are now emitted and both are judged by the host.
});
