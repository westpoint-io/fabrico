// THE CORNER-01 MATRIX (phase 74.1, plan 05): CORNER-01 to CORNER-05's acceptance, as a test.
//
// WHAT IT IS. The real `createGestureController`, driven by synthetic pointer events through
// a camera shim with a scale knob, over:
//   - three boards: a two-tile belt whose Head faces E, N, W and S; a 1x1 Source whose
//     Mechanical Out faces E, N, W and S; a 2x3 Router (Out_0 and Out_1 on its E column, a
//     Fault on its S row, an In on its W column). A fourth, tiny board pins the shared
//     doorstep (a machine Out and a belt Head feeding the same floor tile).
//   - four scales: 0.25 (`MIN_ZOOM`), 0.5, 1.0 and 4.0 (`MAX_ZOOM`).
//   - a dense press grid of pitch `max(r, CELL / 2) / 8` world px, `r = nubHitRadiusWorld(scale)`,
//     covering the UNION of the old hit disc (radius r round the old anchor: the end tile
//     centre for a belt Head, the edge nub anchor for a machine port), the same disc round the
//     doorstep centre, and the whole doorstep tile.
//   - sixteen drag shapes in the port's own frame (forward, left), nine open and seven that go
//     back (four of them loop back over the pressed node), sampled every CELL / 8 WORLD px at
//     every scale (1 screen px at 0.25, 2 at 0.5, 4 at 1.0, 16 at 4.0), so the first samples
//     after a press land inside the pressed tile on every board (plan 74.1-09, WR-05: at the
//     old 8 SCREEN px, MIN_ZOOM stepped one whole cell per sample and never sampled inside the
//     pressed tile). With `CORNER_MATRIX_FULL=1` the old 8-screen-px runs are re-run at every
//     scale, and 3, 24 and 64 screen px at 1.0.
//   - a camera shim with a NON-INTEGER pan (`PAN`, 13.37 and 7.61 screen px) in all four of
//     its functions, so cell edges do not sit on exact screen pixels; every press, sample and
//     release point goes through it, and every cell this file scores is the cell the shim
//     gives back (`shimCell`), the same one the controller reads.
//
// THE ONE RULE. Every gesture lands in exactly one class, defined once below (`classify`):
//   CONNECT        every sample whose pointer cell is not a tile of the pressed thing shows a
//                  blue preview whose head is the pointer's cell; the release sends ONE
//                  DrawBelt ending at the release cell; after the echo a Tail Dock names the
//                  source (the port whose doorstep holds the press, machine first, else the
//                  port under test); the host mirror `acceptsDock` accepts that source port
//                  with the routed path's Tail cell and outward; AND the LAST blue preview's
//                  tiles[0] is the seam kind this file computes from geometry alone (Straight
//                  on the feed axis when the first step continues the feed, Corner{feed,
//                  step} when it turns). Plan 74.1-09 (gap 3): before it, CONNECT meant "a
//                  Tail Dock frame was sent", which held while the user saw a T.
//   CONNECT_WRONG_SEAM  everything CONNECT asks except the seam: docked and accepted, but the
//                  preview showed a different tile at the seam than the corner (or straight)
//                  the join will draw. Counted, never folded into CONNECT.
//   DOCK_REFUSED   the Tail Dock named the expected source but the host mirror refuses it.
//   SWR            a DrawBelt was sent whose last cell is NOT the release cell (a silent wrong
//                  result: blue, committed, and not where the hand let go).
//   LAG            sent and ends right, but at some checked sample the preview head was not
//                  under the pointer.
//   RED_NOTHING    last preview red and nothing built: nothing sent, or (since plan 89-09,
//                  D-13, FAIL-02) the red path sent with no Dock after it, for the host to
//                  refuse in words.
//   FOLLOW_NODOCK  followed (head under the pointer at every checked sample) and sent, no
//                  Tail Dock (an ordinary unconnected draw).
//   IN_SNAP        SWR's one named sub-case, on the RELEASE side: the hand's path ends at the
//                  release cell and the release, inside an In nub's hit disc, appended that
//                  In's doorstep and docked the Head to it (the D-12 port-to-port end). Counted
//                  and reported apart from SWR, never folded into CONNECT.
//   OTHER          anything the classes above do not describe (nothing sent with a blue
//                  preview, or a Tail Dock naming a different source). Asserted ZERO at the fix.
//
// WHY IT IMPORTS NOTHING THE BASE REVISION LACKS. The identical file is run against
// BASE_REV (74.1-BASELINE.md) through a `git archive` extraction, so HEAD's numbers come from
// HEAD's code under this same rule. Every import below exists, with the same signature, at
// BASE_REV. At BASE_REV the claims below FAIL (that is the point); the report still writes.
//
// WHY DOORSTEPS ARE DERIVED HERE, NOT READ FROM `ports.ts`. The doorstep of every source is
// computed from this file's own board definitions (`FORWARD` below). Reading the production
// helper would make the matrix agree with the code it measures, and would not compile at
// BASE_REV, which predates it.
//
// WHY THE SEAM KIND IS DERIVED HERE, NOT READ FROM `seam.ts`. The expected seam tile is
// computed from the source's side and the drawn path's first step through this file's own
// `FORWARD` table (`expectedSeam`). This file imports nothing from `seam.ts`, so the same
// file runs against plan 74.1-08's start revision, where the preview still showed route()'s
// Straight at a turn-at-once seam; that run is the CONNECT claim's watched red.
//
// HOW TO RUN.
//   npx vitest run src/input/cornerMatrix.test.ts                         default (part of npm test)
//   CORNER_MATRIX_FULL=1 npx vitest run src/input/cornerMatrix.test.ts    adds 8 px at every scale
//                                                                         and 3 / 24 / 64 px at 1.0
//   CORNER_MATRIX_REPORT=<path> ...                                       writes the JSON report
//   CORNER_MATRIX_ROWS=<path> ...               every SWR, IN_SNAP, LAG and OTHER row, one JSON per line
//   CORNER_MATRIX_REV=<sha> ...                 the revision label the report carries
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BeltView, NodeView, PortView, TileView } from '../protocol/decode.ts';
import {
  BELT_PORT_HEAD,
  type DockTargetShape,
  MACHINE_TARGET,
  MEDIUM_MECHANICAL,
  PORT_ROLE,
  acceptsDock,
  beltEndCell,
  beltEndOutward,
  nubAnchor,
  nubHitRadiusWorld,
  unitDelta,
} from '../protocol/ports.ts';
import { route } from '../protocol/route.ts';
import { machine_kind } from '../protocol/kinds.ts';
import { CELL } from '../../shared/geometry.ts';
import { MAX_ZOOM, MIN_ZOOM } from '../render/camera.ts';
import { createSceneState } from '../render/sceneState.ts';
import type { OverlayAffordances } from './ghost.ts';
import { createGestureController } from './gestures.ts';

// ---------------------------------------------------------------------------
// Geometry, independent of the code under test
// ---------------------------------------------------------------------------

/** Side N=0, E=1, S=2, W=3 to its outward cell step. This file's own table. */
const FORWARD: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const SIDE_NAME = ['N', 'E', 'S', 'W'] as const;

type Cell = readonly [number, number];
interface Pt {
  x: number;
  y: number;
}
const key = (c: Cell): string => `${c[0]},${c[1]}`;
const cellOf = (p: Pt): Cell => [Math.floor(p.x / CELL), Math.floor(p.y / CELL)];
const sameCell = (a: Cell, b: Cell): boolean => a[0] === b[0] && a[1] === b[1];
const doorstepOf = (portCell: Cell, side: number): Cell => [
  portCell[0] + FORWARD[side][0],
  portCell[1] + FORWARD[side][1],
];
const cellCentre = (c: Cell): Pt => ({ x: c[0] * CELL + CELL / 2, y: c[1] * CELL + CELL / 2 });

/**
 * The camera shim's pan, in SCREEN px, deliberately not an integer (plan 74.1-09, WR-05).
 * With a zero pan every cell edge sat on an exact screen pixel, which the shipped camera does
 * not guarantee; with this one an edge lands at a fractional pixel and a world point makes a
 * real float round trip through screen space, as it does in the app.
 */
const PAN = { x: 13.37, y: 7.61 } as const;

/** The camera relation `camera.ts` computes (world = (screen - pan) / scale), with `PAN`. */
function makeCam(scale: number) {
  return {
    screenToWorld: (sx: number, sy: number) => ({ x: (sx - PAN.x) / scale, y: (sy - PAN.y) / scale }),
    worldToScreen: (wx: number, wy: number) => ({ x: wx * scale + PAN.x, y: wy * scale + PAN.y }),
    screenToCellFrac: (sx: number, sy: number) => ({
      fx: (sx - PAN.x) / scale / CELL,
      fy: (sy - PAN.y) / scale / CELL,
    }),
    screenToCell: (sx: number, sy: number) => ({
      cx: Math.floor((sx - PAN.x) / scale / CELL),
      cy: Math.floor((sy - PAN.y) / scale / CELL),
    }),
    setPanEnabled: () => {},
  };
}

/** The screen point a world point is sent as, through the shim. */
function toScreen(p: Pt, scale: number): Pt {
  return makeCam(scale).worldToScreen(p.x, p.y);
}

/**
 * The cell a world point is SCORED in: the cell the shim gives back for its screen point,
 * which is the cell the controller reads. On an exact world edge the float round trip may
 * put it either side; scoring through the shim keeps this file and the controller agreed.
 */
function shimCell(p: Pt, scale: number): Cell {
  const s = toScreen(p, scale);
  const c = makeCam(scale).screenToCell(s.x, s.y);
  return [c.cx, c.cy];
}

/** A belt tile's kind as the wire carries it, typed here so this file needs nothing newer. */
type SeamKind = { Straight: { axis: number } } | { Corner: { from: number; to: number } };

/** The run axis a flow along side `d` travels: E/W on X (0), N/S on Y (1). */
const axisOfSide = (d: number): number => (d === 1 || d === 3 ? 0 : 1);

/** The side a unit cell step points along, through this file's own `FORWARD` table. */
function sideOfStep(a: Cell, b: Cell): number | null {
  const i = FORWARD.findIndex(([dx, dy]) => b[0] - a[0] === dx && b[1] - a[1] === dy);
  return i < 0 ? null : i;
}

/**
 * THE SEAM THE JOIN WILL DRAW, from geometry alone (plan 74.1-09). The source feeds items out
 * of its side `feed`; the drawn path's first step is `step`. Equal: Straight on that axis.
 * Perpendicular: Corner{from: feed, to: step}. A single-tile path takes the feed for both.
 * A reversing step (into the source) has no join to draw: `null`, never a match.
 */
function expectedSeam(feed: number, drawn: Cell[]): SeamKind | null {
  if (drawn.length < 2) {
    return { Straight: { axis: axisOfSide(feed) } };
  }
  const step = sideOfStep(drawn[0], drawn[1]);
  if (step === null || step === (feed + 2) % 4) {
    return null;
  }
  if (step === feed) {
    return { Straight: { axis: axisOfSide(feed) } };
  }
  return { Corner: { from: feed, to: step } };
}

/** Structural equality of two tile kinds (either may be any wire shape). */
function sameKind(a: unknown, b: SeamKind | null): boolean {
  if (b === null || a === null || typeof a !== 'object') {
    return false;
  }
  const k = a as { Straight?: { axis?: unknown }; Corner?: { from?: unknown; to?: unknown } };
  if ('Straight' in b) {
    return k.Corner === undefined && k.Straight?.axis === b.Straight.axis;
  }
  return k.Straight === undefined && k.Corner?.from === b.Corner.from && k.Corner?.to === b.Corner.to;
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/** One belt-draw source: a belt's free Head or a machine Out / Fault port. */
interface Source {
  label: string;
  /** The dense handle a Tail Dock names (belt id or node id). */
  handle: number;
  /** The port index the Tail Dock carries. */
  portIndex: number;
  portCell: Cell;
  side: number;
  doorstep: Cell;
  /** HEAD's press anchor: the end tile centre for a belt, the edge nub anchor for a port. */
  oldAnchor: Pt;
  isMachine: boolean;
  /**
   * The source as a port, built from this file's board facts: the machine port itself, or a
   * belt Head at its end cell facing its direction of travel. The host mirror judges it.
   */
  port: PortView;
}

/**
 * The source's TARGET SHAPE for the host mirror (plan 74.1-15): a machine port is judged
 * by the doorstep rule, a belt Head by the belt rule with its inner tile, which is the
 * Head's end cell stepped against its direction of travel.
 */
function sourceTarget(src: Source): DockTargetShape {
  if (src.isMachine) {
    return MACHINE_TARGET;
  }
  const [dx, dy] = unitDelta(src.side);
  return { kind: 'belt', inner: [src.portCell[0] - dx, src.portCell[1] - dy] };
}

type Affordance = 'belt' | 'machine' | 'router' | 'shared';

interface Board {
  name: string;
  affordance: Affordance;
  /** The orientation label for the report (the port side under test, or the port name). */
  orient: string;
  nodes: NodeView[];
  belts: BeltView[];
  /** Every source on the board, in resolution priority: machine ports first, then belts. */
  sources: Source[];
  /** The sources whose press grid this board sweeps. */
  underTest: Source[];
  /** The pressed thing's cells (the belt's tiles, or the machine's footprint). */
  nodeCells: Set<string>;
  /** Every In port on the board with its doorstep, for the IN_SNAP sub-case. */
  inDoorsteps: Array<{ node: number; port: number; doorstep: Cell; nub: Pt }>;
}

const BASE: Cell = [20, 20];

const mkTiles = (cells: Cell[]): TileView[] => {
  const r = route(cells.map((c) => [c[0], c[1]] as [number, number]));
  if (!r.ok) {
    throw new Error(`board belt does not route: ${JSON.stringify(cells)}`);
  }
  return r.tiles;
};

const mkBelt = (id: number, cells: Cell[]): BeltView => ({
  id,
  latency: 4 * cells.length,
  fill: 0,
  items: [],
  tiles: mkTiles(cells),
  docks: [],
  ticks_per_slot: 1,
});

const mkNode = (
  id: number,
  kind: number,
  cell: Cell,
  w: number,
  h: number,
  ports: PortView[],
): NodeView => ({
  id,
  kind,
  cell_x: cell[0],
  cell_y: cell[1],
  state: 0,
  w,
  h,
  rot: 0,
  ports,
  load: 0,
});

const port = (index: number, cell: Cell, side: number, role: number): PortView => ({
  index,
  cell_x: cell[0],
  cell_y: cell[1],
  side,
  role,
  medium: MEDIUM_MECHANICAL,
});

const machineSource = (
  label: string,
  node: number,
  index: number,
  cell: Cell,
  side: number,
  role: number = PORT_ROLE.OUT,
): Source => ({
  label,
  handle: node,
  portIndex: index,
  portCell: cell,
  side,
  doorstep: doorstepOf(cell, side),
  oldAnchor: nubAnchor(cell[0], cell[1], side),
  isMachine: true,
  port: port(index, cell, side, role),
});

const beltSource = (label: string, belt: number, head: Cell, side: number): Source => ({
  label,
  handle: belt,
  portIndex: BELT_PORT_HEAD,
  portCell: head,
  side,
  doorstep: doorstepOf(head, side),
  oldAnchor: cellCentre(head),
  isMachine: false,
  port: port(BELT_PORT_HEAD, head, side, PORT_ROLE.OUT),
});

/** A two-tile belt whose Head sits at BASE facing `side`. */
function beltBoard(side: number): Board {
  const head = BASE;
  const tail: Cell = [head[0] - FORWARD[side][0], head[1] - FORWARD[side][1]];
  const src = beltSource(`belt Head ${SIDE_NAME[side]}`, 21, head, side);
  return {
    name: `belt-${SIDE_NAME[side]}`,
    affordance: 'belt',
    orient: SIDE_NAME[side],
    nodes: [],
    belts: [mkBelt(21, [tail, head])],
    sources: [src],
    underTest: [src],
    nodeCells: new Set([key(tail), key(head)]),
    inDoorsteps: [],
  };
}

/** A 1x1 Source at BASE whose one Mechanical Out faces `side`. */
function machineBoard(side: number): Board {
  const src = machineSource(`Source Out ${SIDE_NAME[side]}`, 7, 0, BASE, side);
  return {
    name: `machine-${SIDE_NAME[side]}`,
    affordance: 'machine',
    orient: SIDE_NAME[side],
    nodes: [mkNode(7, machine_kind.SOURCE, BASE, 1, 1, [port(0, BASE, side, PORT_ROLE.OUT)])],
    belts: [],
    sources: [src],
    underTest: [src],
    nodeCells: new Set([key(BASE)]),
    inDoorsteps: [],
  };
}

/** The 2x3 Router: In at local (0,0) W, Out_0 (1,0) E, Out_1 (1,1) E, Fault (0,2) S. */
function routerBoard(): Board {
  const [x, y] = BASE;
  const out0 = machineSource('Router Out_0', 9, 1, [x + 1, y], 1);
  const out1 = machineSource('Router Out_1', 9, 2, [x + 1, y + 1], 1);
  const fault = machineSource('Router Fault', 9, 3, [x, y + 2], 2, PORT_ROLE.FAULT);
  const cells = new Set<string>();
  for (let dx = 0; dx < 2; dx++) {
    for (let dy = 0; dy < 3; dy++) {
      cells.add(key([x + dx, y + dy]));
    }
  }
  return {
    name: 'router',
    affordance: 'router',
    orient: '2x3',
    nodes: [
      mkNode(9, machine_kind.ROUTER, BASE, 2, 3, [
        port(0, [x, y], 3, PORT_ROLE.IN),
        port(1, [x + 1, y], 1, PORT_ROLE.OUT),
        port(2, [x + 1, y + 1], 1, PORT_ROLE.OUT),
        port(3, [x, y + 2], 2, PORT_ROLE.FAULT),
      ]),
    ],
    belts: [],
    sources: [out0, out1, fault],
    underTest: [out0, out1, fault],
    nodeCells: cells,
    inDoorsteps: [{ node: 9, port: 0, doorstep: doorstepOf([x, y], 3), nub: nubAnchor(x, y, 3) }],
  };
}

/**
 * The shared doorstep: a Source Out E at BASE and a belt running N whose Head's doorstep is
 * the same floor tile (BASE + E). CORNER-04 probe `adjacency`: the machine port resolves first.
 */
function sharedBoard(): Board {
  const m = machineSource('Source Out E (shared)', 7, 0, BASE, 1);
  const beltHead: Cell = [BASE[0] + 1, BASE[1] + 1];
  const beltTail: Cell = [BASE[0] + 1, BASE[1] + 2];
  const b = beltSource('belt Head N (shared)', 21, beltHead, 0);
  return {
    name: 'shared',
    affordance: 'shared',
    orient: 'E',
    nodes: [mkNode(7, machine_kind.SOURCE, BASE, 1, 1, [port(0, BASE, 1, PORT_ROLE.OUT)])],
    belts: [mkBelt(21, [beltTail, beltHead])],
    sources: [m, b],
    underTest: [m],
    nodeCells: new Set([key(BASE)]),
    inDoorsteps: [],
  };
}

// ---------------------------------------------------------------------------
// Shapes, in the port frame: (forward, left) in cells, relative to the press point
// ---------------------------------------------------------------------------

type Leg = { to: readonly [number, number] } | { ctrl: readonly [number, number]; to: readonly [number, number] };
interface Shape {
  name: string;
  kind: 'open' | 'back';
  legs: Leg[];
}

const L = (f: number, l: number): Leg => ({ to: [f, l] });
const Q = (cf: number, cl: number, f: number, l: number): Leg => ({ ctrl: [cf, cl], to: [f, l] });

const SHAPES: Shape[] = [
  { name: 'fwd', kind: 'open', legs: [L(4, 0)] },
  { name: 'left', kind: 'open', legs: [L(0, 4)] },
  { name: 'right', kind: 'open', legs: [L(0, -4)] },
  { name: 'diagL', kind: 'open', legs: [L(3, 3)] },
  { name: 'diagR', kind: 'open', legs: [L(3, -3)] },
  { name: 'curveL', kind: 'open', legs: [Q(0, 3, 3, 3)] },
  { name: 'curveR', kind: 'open', legs: [Q(3, 0, 3, -3)] },
  { name: 'fwd1-left', kind: 'open', legs: [L(1, 0), L(1, 3)] },
  { name: 'right-fwd', kind: 'open', legs: [L(0, -2), L(3, -2)] },
  // Back shapes. The waypoints are research 2.1's, verbatim: `fwd2-back3` goes forward two
  // and then back to three behind the press, like `back(collinear)` and `imm-reversal`.
  { name: 'back(collinear)', kind: 'back', legs: [L(-3, 0)] },
  { name: 'imm-reversal', kind: 'back', legs: [L(0.6, 0), L(-3, 0)] },
  { name: 'fwd2-back3', kind: 'back', legs: [L(2, 0), L(-3, 0)] },
  // The four that loop back over the pressed node.
  { name: 'L1-B1-R1', kind: 'back', legs: [L(0, 1), L(-1, 1), L(-1, 0)] },
  { name: 'F2-R1-B3-L1', kind: 'back', legs: [L(2, 0), L(2, -1), L(-1, -1), L(-1, 0)] },
  { name: 'F2-L2-B3-R2', kind: 'back', legs: [L(2, 0), L(2, 2), L(-1, 2), L(-1, 0)] },
  { name: 'jitterback-left', kind: 'back', legs: [L(-0.7, 0), L(-0.7, 3)] },
];
const LOOP_BACK = new Set(['L1-B1-R1', 'F2-R1-B3-L1', 'F2-L2-B3-R2', 'jitterback-left']);

/** Port frame (forward, left) in cells to a world offset. Left of forward (fx, fy) is (fy, -fx). */
function frameToWorld(side: number, f: number, l: number): Pt {
  const [fx, fy] = FORWARD[side];
  const [lx, ly] = [fy, -fx];
  return { x: (f * fx + l * lx) * CELL, y: (f * fy + l * ly) * CELL };
}

/**
 * The pointer samples of one shape, in WORLD px, last one the release point. Each leg is
 * sampled separately (so every waypoint is itself a sample and the chord between two samples
 * never cuts a corner) at `spacing` SCREEN px or less.
 */
function samplesOf(press: Pt, side: number, shape: Shape, scale: number, spacing: number): Pt[] {
  const out: Pt[] = [];
  let from: Pt = press;
  for (const leg of shape.legs) {
    const toOff = frameToWorld(side, leg.to[0], leg.to[1]);
    const to = { x: press.x + toOff.x, y: press.y + toOff.y };
    if ('ctrl' in leg) {
      const cOff = frameToWorld(side, leg.ctrl[0], leg.ctrl[1]);
      const c = { x: press.x + cOff.x, y: press.y + cOff.y };
      const at = (t: number): Pt => ({
        x: (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * c.x + t * t * to.x,
        y: (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * c.y + t * t * to.y,
      });
      let len = 0;
      let prev = from;
      for (let i = 1; i <= 64; i++) {
        const q = at(i / 64);
        len += Math.hypot(q.x - prev.x, q.y - prev.y);
        prev = q;
      }
      const n = Math.max(1, Math.ceil((len * scale) / spacing));
      for (let i = 1; i <= n; i++) {
        out.push(at(i / n));
      }
    } else {
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      const n = Math.max(1, Math.ceil((len * scale) / spacing));
      for (let i = 1; i <= n; i++) {
        out.push({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
      }
    }
    from = to;
  }
  return out;
}

/** Whether the continuous path (not the samples) ever enters a cell of the pressed thing. */
function sweepEnters(press: Pt, side: number, shape: Shape, nodeCells: Set<string>): boolean {
  const pts = samplesOf(press, side, shape, 1, 0.25);
  return pts.some((p) => nodeCells.has(key(cellOf(p))));
}

// ---------------------------------------------------------------------------
// The rig: the real controller, a scaled camera, a recording overlay
// ---------------------------------------------------------------------------

interface Bus {
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  fire(type: string, ev: Record<string, unknown>): void;
}

function makeBus(): Bus {
  const map = new Map<string, Set<(e: unknown) => void>>();
  return {
    addEventListener(type, fn) {
      let set = map.get(type);
      if (!set) {
        set = new Set();
        map.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn);
    },
    fire(type, ev) {
      for (const fn of [...(map.get(type) ?? [])]) {
        fn(ev);
      }
    },
  };
}

interface Recorder {
  beltCalls: Array<{ tiles: TileView[]; valid: boolean }>;
  nubRings: number;
}

/** Every `OverlayAffordances` member: three recorded, the rest no-ops with honest returns. */
function makeOverlay(rec: Recorder): OverlayAffordances {
  const nop = (): void => {};
  return {
    showGhost: nop,
    clearGhost: nop,
    showRoute: nop,
    clearRoute: nop,
    showBeltPreview: (tiles, valid) => {
      rec.beltCalls.push({ tiles, valid });
    },
    clearBeltPreview: nop,
    showHeldBelts: nop,
    clearHeldBelts: nop,
    showSelection: nop,
    clearSelection: nop,
    hoverRing: nop,
    clearHover: nop,
    showBeltHandles: nop,
    clearBeltHandles: nop,
    showHandleRing: nop,
    clearHandleRing: nop,
    showDraggedHandle: nop,
    clearDraggedHandle: nop,
    showNubRing: () => {
      rec.nubRings++;
    },
    clearNubRing: nop,
    showWireTargets: nop,
    clearWireTargets: nop,
    showDockTargets: nop,
    clearDockTargets: nop,
    rotateHandleCenter: () => null,
    setRotateHandleHover: nop,
    showPending: nop,
    clearPending: nop,
    showRejectFlash: nop,
    alertRingsActive: () => false,
    clearAlertRingAt: () => false,
  };
}

/** A minimal postcard reader for the two frames the matrix reads: DrawBelt (3) and Dock (4). */
type Frame =
  | { kind: 'DrawBelt'; cells: Cell[] }
  | { kind: 'Dock'; belt: number; end: 'Head' | 'Tail'; node: number; port: number }
  | { kind: 'other'; disc: number };

function readFrame(b: Uint8Array): Frame {
  let i = 0;
  const u = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const byte = b[i++];
      v += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return v;
      shift += 7;
    }
  };
  const s = (): number => {
    const z = u();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  };
  const disc = u();
  if (disc === 3) {
    const n = u();
    const cells: Cell[] = [];
    for (let k = 0; k < n; k++) {
      const cx = s();
      const cy = s();
      cells.push([cx, cy]);
    }
    return { kind: 'DrawBelt', cells };
  }
  if (disc === 4) {
    const belt = u();
    const end = u() === 0 ? 'Head' : 'Tail';
    const node = u();
    const portIdx = u();
    return { kind: 'Dock', belt, end, node, port: portIdx };
  }
  return { kind: 'other', disc };
}

type Klass =
  | 'CONNECT'
  | 'CONNECT_WRONG_SEAM'
  | 'DOCK_REFUSED'
  | 'SWR'
  | 'IN_SNAP'
  | 'LAG'
  | 'RED_NOTHING'
  | 'FOLLOW_NODOCK'
  | 'OTHER';
const KLASSES: Klass[] = [
  'CONNECT',
  'CONNECT_WRONG_SEAM',
  'DOCK_REFUSED',
  'SWR',
  'IN_SNAP',
  'LAG',
  'RED_NOTHING',
  'FOLLOW_NODOCK',
  'OTHER',
];

interface Observed {
  /** A DrawBelt was sent, with these cells. */
  drawn: Cell[] | null;
  release: Cell;
  /** At every checked sample (pointer cell not the pressed thing) the preview head was under the pointer. */
  headFollowed: boolean;
  /** ... and the preview was blue at every one of them. */
  blueFollowed: boolean;
  lastPreviewBlue: boolean;
  tailDock: { node: number; port: number } | null;
  headDock: { node: number; port: number } | null;
  expected: Source;
  /** The board's In ports and their doorsteps (from this file's board definitions). */
  inDoorsteps: Array<{ node: number; port: number; doorstep: Cell; nub: Pt }>;
  /** The tiles the host mints over the sent DrawBelt (`route()` of its cells). */
  routed: TileView[] | null;
  /** tiles[0].kind of the LAST blue preview: the seam the user saw before letting go. */
  previewSeam: unknown;
}

/**
 * THE ONE RULE. Both revisions are scored by this function and nothing else.
 *
 * IN_SNAP is SWR's one named sub-case, and it is the RELEASE side, not the press: the path
 * the hand drew ends at the release cell, the release fell inside an In nub's hit disc, and
 * the release appended that In port's doorstep and sent a Head Dock to it (the D-12
 * port-to-port end, `gestures.ts` onWinUp). The same code at BASE_REV and at the fix; it is
 * counted, never folded into CONNECT, and every other "last cell is not the release cell"
 * is SWR.
 *
 * CONNECT (plan 74.1-09, gap 3) asks three things of a docked gesture: the Tail Dock names
 * the expected source; `acceptsDock` accepts that source port with the routed Tail cell and
 * outward (else DOCK_REFUSED); and the last blue preview's tiles[0] is `expectedSeam` (else
 * CONNECT_WRONG_SEAM). Scored identically at plan 74.1-08's start revision and at the tree.
 */
function classify(o: Observed): Klass {
  if (o.drawn === null) {
    return o.lastPreviewBlue ? 'OTHER' : 'RED_NOTHING';
  }
  // Since plan 89-09 (D-13, FAIL-02) a red release is SENT, its cells with no claim and no
  // follow-up, so the host refuses it in words: the user saw red and nothing is built or docked.
  // The same class as a red release that sent nothing, scored by the same rule at every revision
  // (a revision before 89-09 never sends a red path, so its numbers do not move).
  if (!o.lastPreviewBlue && o.tailDock === null && o.headDock === null) {
    return 'RED_NOTHING';
  }
  const last = o.drawn[o.drawn.length - 1];
  if (!sameCell(last, o.release)) {
    const snap =
      o.drawn.length >= 2 &&
      sameCell(o.drawn[o.drawn.length - 2], o.release) &&
      o.headDock !== null &&
      o.inDoorsteps.some(
        (d) => d.node === o.headDock?.node && d.port === o.headDock?.port && sameCell(d.doorstep, last),
      );
    return snap ? 'IN_SNAP' : 'SWR';
  }
  if (!o.headFollowed) {
    return 'LAG';
  }
  if (o.tailDock === null) {
    return 'FOLLOW_NODOCK';
  }
  if (!(o.blueFollowed && o.tailDock.node === o.expected.handle && o.tailDock.port === o.expected.portIndex)) {
    return 'OTHER';
  }
  // Plan 74.1-09 (gap 3): a sent Dock is not a join the user sees. The host mirror must
  // accept the source with the routed Tail, and the preview must have shown the seam tile
  // the join will draw, computed here from geometry and never read from `seam.ts`.
  const routed = o.routed;
  if (
    routed === null ||
    !acceptsDock(
      o.expected.port,
      'Tail',
      beltEndCell(routed, 'Tail'),
      beltEndOutward(routed, 'Tail'),
      sourceTarget(o.expected),
    )
  ) {
    return 'DOCK_REFUSED';
  }
  return sameKind(o.previewSeam, expectedSeam(o.expected.side, o.drawn)) ? 'CONNECT' : 'CONNECT_WRONG_SEAM';
}

interface Gesture {
  board: Board;
  src: Source;
  scale: number;
  spacing: number;
  press: Pt;
  shape: Shape;
}

interface Result {
  klass: Klass;
  resolved: boolean;
  seed: Cell | null;
  tailDock: { node: number; port: number } | null;
  /** The pressed cell, through the shim. */
  pressCell: Cell;
  /** The first post-press sample is inside the pressed tile (through the shim). */
  firstInside: boolean;
  /** World distance from the press to the first post-press sample. */
  firstStep: number;
  /** For a docked gesture: the seam tile the preview showed and the one geometry expects. */
  seam: { shown: unknown; want: SeamKind | null } | null;
}

const MINTED = 900;

function runGesture(g: Gesture): Result {
  const { board, scale } = g;
  const win = makeBus();
  (globalThis as unknown as { window: Bus }).window = win;
  const rafCbs = new Map<number, FrameRequestCallback>();
  let rafId = 0;
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
    (cb) => {
      rafCbs.set(++rafId, cb);
      return rafId;
    };
  (globalThis as unknown as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame = (h) => {
    rafCbs.delete(h);
  };
  const flushRaf = (): void => {
    const cbs = [...rafCbs.values()];
    rafCbs.clear();
    for (const cb of cbs) cb(0);
  };
  const canvas = makeBus();
  (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: 0, top: 0 }) as DOMRect;
  (canvas as unknown as { style: { cursor: string } }).style = { cursor: '' };

  const scene = createSceneState();
  for (const n of board.nodes) scene.nodes.set(n.id, n);
  for (const b of board.belts) scene.belts.set(b.id, b);

  const rec: Recorder = { beltCalls: [], nubRings: 0 };
  const sent: Uint8Array[] = [];
  // The camera relation `camera.ts` computes, with a non-integer pan (`PAN`): world =
  // (screen - pan) / scale, and screenToCell is the floor of screenToCellFrac.
  const cam = makeCam(scale);
  const ctrl = createGestureController({
    canvas: canvas as unknown as HTMLCanvasElement,
    cam: cam as never,
    overlay: makeOverlay(rec),
    getScene: () => scene,
    sendInput: (b) => sent.push(b),
  });
  try {
    ctrl.armBeltDraw();
    const ev = (p: Pt) => {
      const sp = toScreen(p, scale);
      return { target: canvas, clientX: sp.x, clientY: sp.y };
    };
    const ringsBefore = rec.nubRings;
    const callsBefore = rec.beltCalls.length;
    canvas.fire('pointerdown', { button: 0, ...ev(g.press) });
    const resolved = rec.nubRings > ringsBefore;
    const seedCall = rec.beltCalls.length > callsBefore ? rec.beltCalls[callsBefore] : null;
    const seed: Cell | null =
      seedCall && seedCall.tiles.length > 0 ? [seedCall.tiles[0].cell_x, seedCall.tiles[0].cell_y] : null;

    const samples = samplesOf(g.press, g.src.side, g.shape, scale, g.spacing);
    let headFollowed = true;
    let blueFollowed = true;
    const pressCell = shimCell(g.press, scale);
    // THE REVERSED DRAW (phase 89, plan 89-05, D-02): a press that resolved on one of the board's
    // In doorsteps draws a belt that flows INTO that In, so its preview and its DrawBelt run from
    // the hand to the press: the tile under the hand is tiles[0], and the sent cells read in walk
    // order reversed. Scored under the same rule as every other draw once put in walk order.
    const reversed = resolved && board.inDoorsteps.some((d) => sameCell(d.doorstep, pressCell));
    const firstInside = sameCell(shimCell(samples[0], scale), pressCell);
    const firstStep = Math.hypot(samples[0].x - g.press.x, samples[0].y - g.press.y);
    for (const p of samples) {
      win.fire('pointermove', ev(p));
      const pc = shimCell(p, scale);
      if (board.nodeCells.has(key(pc))) continue;
      const last = rec.beltCalls[rec.beltCalls.length - 1];
      const n = last ? last.tiles.length : 0;
      const head = n > 0 ? last.tiles[reversed ? 0 : n - 1] : null;
      // IN_SNAP SHOWN (phase 89, plan 89-05, research Pitfall 5): since the preview paints the
      // cells the release sends, a pointer inside an In nub's disc one step short of that In's
      // doorstep shows the doorstep the release appends, after the tile under the hand. That is
      // IN_SNAP's own picture, drawn before the release instead of after it: the tile under the
      // hand is the one before the head, the head is an In doorstep of this board, and the pointer
      // is inside THAT In's nub disc (review IN-C-07: without the disc test a preview that
      // appended the doorstep early, outside the disc, scored as followed instead of LAG).
      const beforeHead = n > 1 ? last.tiles[reversed ? 1 : n - 2] : null;
      const snapShown =
        head !== null &&
        beforeHead !== null &&
        beforeHead.cell_x === pc[0] &&
        beforeHead.cell_y === pc[1] &&
        board.inDoorsteps.some(
          (d) => sameCell(d.doorstep, [head.cell_x, head.cell_y]) && Math.hypot(p.x - d.nub.x, p.y - d.nub.y) <= nubHitRadiusWorld(scale),
        );
      if (!head || ((head.cell_x !== pc[0] || head.cell_y !== pc[1]) && !snapShown)) {
        headFollowed = false;
      }
      if (!last || !last.valid) {
        blueFollowed = false;
      }
    }
    const releasePt = samples[samples.length - 1];
    // The preview calls the user could SEE end here. The release re-runs `evalBeltPath`
    // (gestures.ts onWinUp) after it has dropped the source, and clears the preview in the
    // same synchronous handler, so that call is never on a frame and is not the seam shown.
    const callsBeforeUp = rec.beltCalls.length;
    win.fire('pointerup', { button: 0, ...ev(releasePt) });
    const lastCall = rec.beltCalls[rec.beltCalls.length - 1];
    const lastPreviewBlue = !!lastCall && lastCall.valid && lastCall.tiles.length > 0;
    // The seam the user saw: tiles[0] of the last BLUE preview before the release.
    let previewSeam: unknown = null;
    for (let k = callsBeforeUp - 1; k >= callsBefore; k--) {
      const c = rec.beltCalls[k];
      if (c.valid && c.tiles.length > 0) {
        previewSeam = c.tiles[0].kind;
        break;
      }
    }

    const first = sent.length > 0 ? readFrame(sent[0]) : null;
    const drawn = first && first.kind === 'DrawBelt' ? first.cells : null;
    let tailDock: { node: number; port: number } | null = null;
    let headDock: { node: number; port: number } | null = null;
    let routed: TileView[] | null = null;
    if (drawn) {
      // The host accepts the DrawBelt (gesture id 1: `sendInput` returns the frame's 1-based
      // index, the id App's seam would return), naming the belt it minted (plan 88-06, D-06):
      // the follow-up's Docks wait for this accept and a packet that holds the belt.
      ctrl.onVerdict({ kind: 'gestureAccepted', seq: 1, generation: 0, minted: [MINTED] });
      // The echo: the host mints the belt over the routed tiles; the follow-up watcher reads it.
      const r = route(drawn.map((c) => [c[0], c[1]] as [number, number]));
      routed = r.ok ? r.tiles : null;
      const tiles: TileView[] = r.ok
        ? r.tiles
        : drawn.map((c) => ({ cell_x: c[0], cell_y: c[1], kind: { Straight: { axis: 0 } } }));
      scene.belts.set(MINTED, {
        id: MINTED,
        latency: 4 * tiles.length,
        fill: 0,
        items: [],
        tiles,
        docks: [],
        ticks_per_slot: 1,
      });
      flushRaf();
      flushRaf();
      for (const b of sent.slice(1)) {
        const f = readFrame(b);
        if (f.kind === 'Dock' && f.belt === MINTED) {
          if (f.end === 'Tail' && tailDock === null) tailDock = { node: f.node, port: f.port };
          if (f.end === 'Head' && headDock === null) headDock = { node: f.node, port: f.port };
        }
      }
    }
    const expected = board.sources.find((s) => sameCell(s.doorstep, pressCell)) ?? g.src;
    const klass = classify({
      drawn: drawn !== null && reversed ? [...drawn].reverse() : drawn,
      release: shimCell(releasePt, scale),
      headFollowed,
      blueFollowed,
      lastPreviewBlue,
      tailDock,
      headDock,
      expected,
      inDoorsteps: board.inDoorsteps,
      routed,
      previewSeam,
    });
    const seam = drawn && tailDock ? { shown: previewSeam, want: expectedSeam(expected.side, drawn) } : null;
    return { klass, resolved, seed, tailDock, pressCell, firstInside, firstStep, seam };
  } finally {
    ctrl.destroy();
  }
}

// ---------------------------------------------------------------------------
// The press grid and its regions
// ---------------------------------------------------------------------------

/**
 * Where a press lands. `sibling` is another source's doorstep on the same board (the Router's
 * other ports), whether or not the old disc reaches it; the rest are the old disc outside the
 * tile split by what is under the press, and the doorstep disc's spill outside both.
 */
type Region = 'tile+old' | 'tile-only' | 'sibling' | 'old-on-node' | 'old-on-floor' | 'disc-only';

interface Press {
  p: Pt;
  region: Region;
  inTile: boolean;
  inOld: boolean;
  /** Exactly on a vertical or horizontal cell edge (CORNER-04 probe `adjacency`). */
  onEdge: boolean;
}

function pressGrid(board: Board, src: Source, scale: number): Press[] {
  const r = nubHitRadiusWorld(scale);
  const pitch = Math.max(r, CELL / 2) / 8;
  const t0: Pt = { x: src.doorstep[0] * CELL, y: src.doorstep[1] * CELL };
  const dc = cellCentre(src.doorstep);
  const a = src.oldAnchor;
  const minX = Math.min(t0.x, a.x - r, dc.x - r);
  const maxX = Math.max(t0.x + CELL, a.x + r, dc.x + r);
  const minY = Math.min(t0.y, a.y - r, dc.y - r);
  const maxY = Math.max(t0.y + CELL, a.y + r, dc.y + r);
  const out: Press[] = [];
  // The lattice is aligned on the doorstep tile's corner, so its near edges are on it.
  for (let i = Math.floor((minX - t0.x) / pitch); t0.x + i * pitch <= maxX; i++) {
    for (let j = Math.floor((minY - t0.y) / pitch); t0.y + j * pitch <= maxY; j++) {
      const p = { x: t0.x + i * pitch, y: t0.y + j * pitch };
      // Scored in the cell the panned shim gives back, the one the controller reads.
      const c = shimCell(p, scale);
      const inTile = sameCell(c, src.doorstep);
      const inOld = Math.hypot(p.x - a.x, p.y - a.y) <= r;
      const inDisc = Math.hypot(p.x - dc.x, p.y - dc.y) <= r;
      if (!inTile && !inOld && !inDisc) continue;
      let region: Region;
      if (inTile) {
        region = inOld ? 'tile+old' : 'tile-only';
      } else if (board.sources.some((s) => s !== src && sameCell(s.doorstep, c))) {
        region = 'sibling';
      } else if (inOld) {
        region = board.nodeCells.has(key(c)) ? 'old-on-node' : 'old-on-floor';
      } else {
        region = 'disc-only';
      }
      const onEdge = p.x % CELL === 0 || p.y % CELL === 0;
      out.push({ p, region, inTile, inOld, onEdge });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const SCALES = [MIN_ZOOM, 0.5, 1.0, MAX_ZOOM];
const FULL = process.env.CORNER_MATRIX_FULL === '1';
const REPORT = process.env.CORNER_MATRIX_REPORT;
/** The default sample spacing in WORLD px at every scale (plan 74.1-09, WR-05). */
const WORLD_SPACING = CELL / 8;
/**
 * Sample spacings, carried in SCREEN px. The default runs are `WORLD_SPACING` world px at
 * every scale (1 screen px at 0.25, 2 at 0.5, 4 at 1.0, 16 at 4.0). Under FULL: the old 8
 * screen px at every scale, and 3, 24 and 64 at 1.0.
 */
const RUNS: Array<{ scale: number; spacing: number; dflt: boolean }> = [
  ...SCALES.map((scale) => ({ scale, spacing: WORLD_SPACING * scale, dflt: true })),
  ...(FULL
    ? [
        ...SCALES.map((scale) => ({ scale, spacing: 8, dflt: false })),
        ...[3, 24, 64].map((spacing) => ({ scale: 1.0, spacing, dflt: false })),
      ]
    : []),
];
/** The default spacing at a scale, in screen px. */
const defaultSpacing = (scale: number): number => WORLD_SPACING * scale;

interface Row {
  scale: number;
  spacing: number;
  /** One of the default world-unit runs (not a FULL-only run). */
  dflt: boolean;
  board: string;
  affordance: Affordance;
  orient: string;
  source: string;
  region: Region;
  inTile: boolean;
  inOld: boolean;
  onEdge: boolean;
  press: Pt;
  pressCell: Cell;
  shape: string;
  shapeKind: 'open' | 'back';
  enters: boolean;
  klass: Klass;
  resolved: boolean;
  seedIsPress: boolean;
  tailDock: { node: number; port: number } | null;
  /** The source the rule expected a Tail Dock to name (press doorstep owner, else under test). */
  expected: string;
  /** The first post-press sample is inside the pressed tile. */
  firstInside: boolean;
  /** The press is more than two default spacings inside its tile on every side. */
  deepInTile: boolean;
  /** Docked gestures only: the previewed seam tile and the geometric expectation. */
  seam: { shown: unknown; want: SeamKind | null } | null;
}

interface Boundary {
  scale: number;
  side: string;
  where: 'doorstep' | 'machine';
  x: number;
  y: number;
  shape: string;
  shapeKind: 'open' | 'back';
  klass: Klass;
}

const BOARDS: Board[] = [
  ...[0, 1, 2, 3].map(beltBoard),
  ...[0, 1, 2, 3].map(machineBoard),
  routerBoard(),
];

const rows: Row[] = [];
const boundary: Boundary[] = [];
const shareOfOld: Array<{ scale: number; affordance: Affordance; oldPoints: number; insideTile: number }> = [];
let runtimeMs = 0;

function sweep(
  board: Board,
  scale: number,
  spacing: number,
  dflt: boolean,
  onlyTile: boolean,
  shapes: Shape[],
): void {
  for (const src of board.underTest) {
    const grid = pressGrid(board, src, scale);
    for (const press of grid) {
      if (onlyTile && !press.inTile) continue;
      const pressCell = shimCell(press.p, scale);
      const expected = board.sources.find((s) => sameCell(s.doorstep, pressCell)) ?? src;
      // Margin to the nearest edge of the pressed tile, in world px.
      const fx = press.p.x - pressCell[0] * CELL;
      const fy = press.p.y - pressCell[1] * CELL;
      const margin = Math.min(fx, CELL - fx, fy, CELL - fy);
      for (const shape of shapes) {
        const res = runGesture({ board, src, scale, spacing, press: press.p, shape });
        rows.push({
          scale,
          spacing,
          dflt,
          board: board.name,
          affordance: board.affordance,
          orient: board.orient,
          source: src.label,
          region: press.region,
          inTile: press.inTile,
          inOld: press.inOld,
          onEdge: press.onEdge,
          press: press.p,
          pressCell,
          shape: shape.name,
          shapeKind: shape.kind,
          enters: sweepEnters(press.p, src.side, shape, board.nodeCells),
          klass: res.klass,
          resolved: res.resolved,
          seedIsPress: res.seed !== null && sameCell(res.seed, pressCell),
          tailDock: res.tailDock,
          expected: expected.label,
          firstInside: res.firstInside,
          deepInTile: margin > 2 * WORLD_SPACING,
          seam: res.seam,
        });
      }
    }
  }
}

beforeAll(() => {
  const t0 = Date.now();
  for (const { scale, spacing, dflt } of RUNS) {
    for (const board of BOARDS) {
      sweep(board, scale, spacing, dflt, false, SHAPES);
    }
    sweep(sharedBoard(), scale, spacing, dflt, true, SHAPES);
  }
  // CORNER-03's boundary pin: one world px either side of the machine edge, on the nub's axis.
  for (const scale of SCALES) {
    for (const side of [0, 1, 2, 3]) {
      const board = machineBoard(side);
      const src = board.sources[0];
      const a = src.oldAnchor;
      const [fx, fy] = FORWARD[side];
      // The nub anchor sits 0.5 world px past the machine edge; the edge is at anchor - 0.5.
      const edge = { x: a.x - 0.5 * fx, y: a.y - 0.5 * fy };
      for (const where of ['doorstep', 'machine'] as const) {
        const d = where === 'doorstep' ? 0.5 : -0.5;
        const p = { x: edge.x + d * fx, y: edge.y + d * fy };
        for (const shape of SHAPES) {
          const res = runGesture({ board, src, scale, spacing: defaultSpacing(scale), press: p, shape });
          boundary.push({ scale, side: SIDE_NAME[side], where, x: p.x, y: p.y, shape: shape.name, shapeKind: shape.kind, klass: res.klass });
        }
      }
    }
  }
  for (const scale of SCALES) {
    for (const affordance of ['belt', 'machine', 'router'] as const) {
      let oldPoints = 0;
      let insideTile = 0;
      for (const board of BOARDS.filter((b) => b.affordance === affordance)) {
        for (const src of board.underTest) {
          for (const press of pressGrid(board, src, scale)) {
            if (!press.inOld) continue;
            oldPoints++;
            if (press.inTile) insideTile++;
          }
        }
      }
      shareOfOld.push({ scale, affordance, oldPoints, insideTile });
    }
  }
  runtimeMs = Date.now() - t0;
}, 600_000);

// ---------------------------------------------------------------------------
// The report (written even when a claim below fails)
// ---------------------------------------------------------------------------

type Counts = Record<Klass, number>;
const zero = (): Counts => Object.fromEntries(KLASSES.map((k) => [k, 0])) as Counts;
function tally(rs: Row[]): Counts {
  const c = zero();
  for (const r of rs) c[r.klass]++;
  return c;
}
function groupBy<T>(xs: T[], k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const kk = k(x);
    let arr = m.get(kk);
    if (!arr) {
      arr = [];
      m.set(kk, arr);
    }
    arr.push(x);
  }
  return m;
}

afterAll(() => {
  const dump = process.env.CORNER_MATRIX_ROWS;
  if (dump) {
    // Diagnostic: every SWR, IN_SNAP, LAG, OTHER, CONNECT_WRONG_SEAM and DOCK_REFUSED row,
    // with its press point, one JSON line each.
    writeFileSync(
      dump,
      rows
        .filter(
          (r) =>
            r.klass === 'SWR' ||
            r.klass === 'IN_SNAP' ||
            r.klass === 'LAG' ||
            r.klass === 'OTHER' ||
            r.klass === 'CONNECT_WRONG_SEAM' ||
            r.klass === 'DOCK_REFUSED',
        )
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
  }
  if (!REPORT) return;
  // The default world-unit runs (the old report read the 8-screen-px runs, now FULL-only).
  const atDefault = rows.filter((r) => r.dflt);
  const byScaleAffRegion: Record<string, Record<string, Counts>> = {};
  // Key: scale | affordance | region | shape kind | sweep enters the node | press resolved.
  for (const [k, rs] of groupBy(
    atDefault,
    (r) =>
      `${r.scale}|${r.affordance}|${r.region}|${r.shapeKind}|${r.enters ? 'enters' : 'clear'}|${r.resolved ? 'resolved' : 'plain'}`,
  )) {
    byScaleAffRegion[k] = { all: tally(rs) };
  }
  const perShape: Record<string, Counts> = {};
  for (const [k, rs] of groupBy(atDefault.filter((r) => r.scale === 1.0), (r) => `${r.affordance}|${r.shape}|${r.inTile ? 'tile' : 'old-outside'}|${r.inOld ? 'old' : 'new'}`)) {
    perShape[k] = tally(rs);
  }
  const router: Record<string, { counts: Counts; docked: Record<string, number> }> = {};
  for (const [k, rs] of groupBy(atDefault.filter((r) => r.affordance === 'router'), (r) => `${r.scale}|${r.source}|${r.region}|${r.shapeKind}`)) {
    const docked: Record<string, number> = {};
    for (const r of rs) {
      const d = r.tailDock ? `node ${r.tailDock.node} port ${r.tailDock.port}` : 'none';
      docked[d] = (docked[d] ?? 0) + 1;
    }
    router[k] = { counts: tally(rs), docked };
  }
  const resolvedRows = rows.filter((r) => r.resolved);
  const robustness: Record<string, Counts> = {};
  // The shared board is left out: its belt crosses some shapes by construction.
  for (const [k, rs] of groupBy(
    rows.filter((r) => r.scale === 1.0 && r.affordance !== 'shared'),
    (r) => `${r.spacing}|${r.region}|${r.shapeKind}|${r.enters ? 'enters' : 'clear'}`,
  )) {
    robustness[k] = tally(rs);
  }
  const resolvedBy: Record<string, { resolved: number; swr: number; seedEqualsPress: number }> = {};
  for (const [k, rs] of groupBy(resolvedRows, (r) => `${r.spacing}|${r.affordance}`)) {
    resolvedBy[k] = {
      resolved: rs.length,
      swr: rs.filter((r) => r.klass === 'SWR').length,
      seedEqualsPress: rs.filter((r) => r.seedIsPress).length,
    };
  }
  const report = {
    generated: new Date().toISOString(),
    revision: process.env.CORNER_MATRIX_REV ?? null,
    full: FULL,
    runs: RUNS,
    runtimeMs,
    gestures: rows.length,
    gesturesDefault: atDefault.length,
    pan: PAN,
    worldSpacing: WORLD_SPACING,
    insideTile: SCALES.map((scale) => {
      const rs = atDefault.filter((r) => r.scale === scale);
      return {
        scale,
        gestures: rs.length,
        firstInside: rs.filter((r) => r.firstInside).length,
        deepInTile: rs.filter((r) => r.deepInTile).length,
        deepFirstInside: rs.filter((r) => r.deepInTile && r.firstInside).length,
      };
    }),
    swrTotal: rows.filter((r) => r.klass === 'SWR').length,
    swrDefault: atDefault.filter((r) => r.klass === 'SWR').length,
    otherTotal: rows.filter((r) => r.klass === 'OTHER').length,
    inSnapTotal: rows.filter((r) => r.klass === 'IN_SNAP').length,
    resolved: resolvedRows.length,
    seedEqualsPress: resolvedRows.filter((r) => r.seedIsPress).length,
    totalsDefault: tally(atDefault),
    wrongSeamTotal: rows.filter((r) => r.klass === 'CONNECT_WRONG_SEAM').length,
    dockRefusedTotal: rows.filter((r) => r.klass === 'DOCK_REFUSED').length,
    targets: SCALES.map((scale) => ({
      scale,
      tileScreenPx: CELL * scale,
      oldRadiusScreenPx: nubHitRadiusWorld(scale) * scale,
      shareOfOld: shareOfOld.filter((s) => s.scale === scale),
    })),
    byScaleAffRegion,
    perShapeAt1: perShape,
    router,
    boundary,
    robustness,
    resolvedBy,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
});

// ---------------------------------------------------------------------------
// The claims (the fix's). Each names what it asserts; each carries a non-vacuity floor.
// ---------------------------------------------------------------------------

/** Rows for the boards whose own ports are under test (the shared board is its own claim). */
const scored = (): Row[] => rows.filter((r) => r.affordance !== 'shared');
const tileRows = (): Row[] => scored().filter((r) => r.inTile);

/** A failing claim prints at most this many offending rows. */
const sample = (rs: Row[]): Row[] => rs.slice(0, 5);

describe('the CORNER-01 matrix: HEAD and the fix under one rule', () => {
  it('the shape list holds 16 shapes, 9 open and 7 back, 4 of which loop back over the pressed node', () => {
    expect(SHAPES).toHaveLength(16);
    expect(SHAPES.filter((s) => s.kind === 'open')).toHaveLength(9);
    expect(SHAPES.filter((s) => s.kind === 'back')).toHaveLength(7);
    expect(SHAPES.filter((s) => LOOP_BACK.has(s.name) && s.kind === 'back')).toHaveLength(4);
    // And the grid covers four scales, both affordances in four orientations, and the Router.
    expect(new Set(rows.map((r) => r.scale))).toEqual(new Set(SCALES));
    expect(new Set(scored().map((r) => r.board)).size).toBe(9);
    // THE MATRIX SAMPLES INSIDE THE PRESSED TILE AT EVERY SCALE (plan 74.1-09, WR-05). At the
    // old 8 screen px, MIN_ZOOM stepped 32 world px, one whole cell, so no first sample was
    // ever inside the pressed tile. Every press more than two default spacings inside its
    // tile must now see its first sample there, and those presses are a real share of the
    // grid at every scale. (A press on or near an edge moving outward cannot, by geometry.)
    // Measured at plan 74.1-09: 9,200 of 45,920 at 0.25 (20%), 9,200 of 56,512 at 0.5 (16%),
    // 13,104 of 62,000 at 1.0 and at 4.0 (21%); the floor is one eighth.
    for (const scale of SCALES) {
      const rs = rows.filter((r) => r.dflt && r.scale === scale);
      const deep = rs.filter((r) => r.deepInTile);
      expect(deep.length).toBeGreaterThan(rs.length / 8);
      expect(deep.filter((r) => r.firstInside).length).toBe(deep.length);
    }
  });

  it('CORNER-01: every press inside a doorstep tile, every open shape, every scale CONNECTs', () => {
    // CONNECT is the join the user sees (plan 74.1-09): docked, accepted by the host mirror,
    // and previewed with the seam tile the join draws, a Corner when the first step turns.
    // At plan 74.1-08's start revision this claim fails on every turn-at-once shape.
    const open = tileRows().filter((r) => r.shapeKind === 'open');
    // Non-vacuity: research measured 44,532 open tile gestures over belt and machine; the
    // gesture count does not depend on the spacing, and with the Router the floor is well
    // above 40,000.
    expect(open.length).toBeGreaterThan(40_000);
    const bad = open.filter((r) => r.klass !== 'CONNECT');
    expect(sample(bad)).toEqual([]);
  });

  it('CORNER-05: a back shape is RED_NOTHING when its sweep enters the pressed node and CONNECT when it never does', () => {
    const back = tileRows().filter((r) => r.shapeKind === 'back');
    const entering = back.filter((r) => r.enters);
    const clear = back.filter((r) => !r.enters);
    expect(entering.length).toBeGreaterThan(30_000);
    // `jitterback-left` from the forward 30% of the tile never touches the node.
    expect(clear.length).toBeGreaterThan(1_000);
    expect(clear.every((r) => r.shape === 'jitterback-left')).toBe(true);
    expect(sample(entering.filter((r) => r.klass !== 'RED_NOTHING'))).toEqual([]);
    expect(sample(clear.filter((r) => r.klass !== 'CONNECT'))).toEqual([]);
  });

  it('ZERO silent wrong results anywhere in the grid, on every board, at every scale', () => {
    expect(rows.length).toBeGreaterThan(150_000);
    expect(sample(rows.filter((r) => r.klass === 'SWR'))).toEqual([]);
    expect(sample(rows.filter((r) => r.klass === 'OTHER'))).toEqual([]);
  });

  it('CORNER-02: on every gesture that resolved to a port, the seed cell is the press cell', () => {
    const resolved = rows.filter((r) => r.resolved);
    expect(resolved.length).toBeGreaterThan(80_000);
    expect(sample(resolved.filter((r) => !r.seedIsPress))).toEqual([]);
    // And every resolved press is a doorstep press: nothing outside a source's tile resolves.
    expect(sample(resolved.filter((r) => !r.inTile && r.region !== 'sibling'))).toEqual([]);
  });

  it('CORNER-03: inside each doorstep tile each shape has exactly one outcome class', () => {
    // Back shapes are split by whether the HAND entered the node, which is the hand's
    // property, not the target's; within each half the class is single.
    const groups = groupBy(
      tileRows(),
      (r) => `${r.scale}|${r.spacing}|${r.board}|${r.source}|${r.shape}|${r.shapeKind === 'back' ? r.enters : ''}`,
    );
    expect(groups.size).toBeGreaterThan(500);
    const split = [...groups].filter(([, rs]) => new Set(rs.map((r) => r.klass)).size !== 1).map(([k]) => k);
    expect(split.slice(0, 5)).toEqual([]);
  });

  it('CORNER-03: for each port orientation the presses 1 world px either side of the machine edge take different classes', () => {
    expect(boundary).toHaveLength(SCALES.length * 4 * 2 * SHAPES.length);
    for (const scale of SCALES) {
      for (const side of SIDE_NAME) {
        const at = (where: 'doorstep' | 'machine') =>
          boundary.filter((b) => b.scale === scale && b.side === side && b.where === where);
        // Doorstep side: every open shape connects. Machine side: every shape is refused.
        expect(at('doorstep').filter((b) => b.shapeKind === 'open').map((b) => `${b.shape}:${b.klass}`)).toEqual(
          SHAPES.filter((s) => s.kind === 'open').map((s) => `${s.name}:CONNECT`),
        );
        expect(at('machine').map((b) => `${b.shape}:${b.klass}`)).toEqual(SHAPES.map((s) => `${s.name}:RED_NOTHING`));
      }
    }
  });

  it('the Router: Out_0, Out_1 and the Fault each CONNECT in their own doorstep; a sibling doorstep docks the sibling', () => {
    const router = rows.filter((r) => r.affordance === 'router');
    for (const label of ['Router Out_0', 'Router Out_1', 'Router Fault']) {
      const own = router.filter((r) => r.source === label && r.inTile && r.shapeKind === 'open');
      expect(own.length).toBeGreaterThan(3_000);
      expect(sample(own.filter((r) => r.klass !== 'CONNECT'))).toEqual([]);
    }
    const sibling = router.filter((r) => r.region === 'sibling' && r.shapeKind === 'open');
    expect(sibling.length).toBeGreaterThan(100);
    // CONNECT under the rule means the Tail Dock named the doorstep's owner, the sibling.
    expect(sample(sibling.filter((r) => r.klass !== 'CONNECT' || r.expected === r.source))).toEqual([]);
  });

  it('presses in the old target outside the tile are RED_NOTHING or FOLLOW_NODOCK, never SWR or LAG', () => {
    const outside = scored().filter((r) => r.inOld && !r.inTile && r.region !== 'sibling');
    expect(outside.length).toBeGreaterThan(20_000);
    // IN_SNAP is the release side (an ordinary draw released inside the Router's In nub disc),
    // named in its own class and reported; it is not a press outcome and not a wrong result
    // of the press target, so it is admitted here and counted in the report.
    expect(
      sample(outside.filter((r) => r.klass !== 'RED_NOTHING' && r.klass !== 'FOLLOW_NODOCK' && r.klass !== 'IN_SNAP')),
    ).toEqual([]);
    // Both named outcomes occur: the red refusal on the pressed thing, the plain draw on floor.
    expect(outside.some((r) => r.region === 'old-on-node' && r.klass === 'RED_NOTHING')).toBe(true);
    expect(outside.some((r) => r.region === 'old-on-floor' && r.klass === 'FOLLOW_NODOCK')).toBe(true);
  });

  it('adjacency: a press exactly on a cell edge is scored in the cell Math.floor gives it', () => {
    const edge = tileRows().filter((r) => r.onEdge && r.shapeKind === 'open');
    expect(edge.length).toBeGreaterThan(1_000);
    expect(sample(edge.filter((r) => r.klass !== 'CONNECT'))).toEqual([]);
  });

  it('adjacency: a doorstep shared by a machine Out and a belt Head resolves to the machine port', () => {
    const shared = rows.filter((r) => r.affordance === 'shared');
    expect(shared.length).toBeGreaterThan(1_000);
    const docked = shared.filter((r) => r.tailDock !== null);
    expect(docked.length).toBeGreaterThan(500);
    // Node 7 is the Source; the belt is 21. Every dock names the machine.
    expect(sample(docked.filter((r) => r.tailDock?.node !== 7 || r.tailDock?.port !== 0))).toEqual([]);
    expect(sample(shared.filter((r) => r.klass === 'SWR'))).toEqual([]);
  });
});
