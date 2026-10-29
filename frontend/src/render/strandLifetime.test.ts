// strandLifetime.test.ts - the warning ring stays until its cut is resolved (phase 89 review,
// TODO-FANIN, option 3).
//
// THE CASE THIS EXISTS FOR (todo 2026-10-22, measured live at a pre-release revision): a belt whose Tail is
// docked to two Sources (a fan-in). Source A is turned away: the Tail keeps B's dock and the ring
// is plotted on A's Out dot and the Tail end tile. A is turned back: D-08 never joins an end that
// still holds a dock, so A stays undocked, and the shipped lifetime rule (every structural edit
// clears every ring) wiped the ring. The board then showed A's Out facing its old belt, cut, with
// no warning. Each case below drives `ringStep` with the packets that walk produces, and grades
// the plotted points, not only the standing list.
//
// RED FIRST: with `ringStep` reduced to the shipped rule (a detection shows, any structural edit
// clears), the turn-back case and the unrelated-edit case read `paint: 'clear'` (recorded in
// 89-REVIEW-DISPOSITION.md, TODO-FANIN).

import { describe, expect, it } from 'vitest';
import type { BeltDockView, BeltView, NodeView, PortView, RenderPacket } from '../protocol/decode.ts';
import { nubAnchor } from '../protocol/ports.ts';
import { applyPacket, createSceneState, type SceneState } from './sceneState.ts';
import { detectStrandedDocks, isStructuralEdit } from './strandedDocks.ts';
import { ringKey, ringStep, type RingStep, type StandingStrand } from './strandLifetime.ts';

const SINK = 7;
const SOURCE = 0;
/** Sides: N=0, E=1, S=2, W=3. */
const E = 1;
const S = 2;
const W = 3;

const port = (cell_x: number, cell_y: number, side: number, role: number, index = 0): PortView => ({
  index,
  cell_x,
  cell_y,
  side,
  role,
  medium: 0,
});

const node = (id: number, kind: number, cx: number, cy: number, rot: number, ports: PortView[]): NodeView => ({
  id,
  kind,
  cell_x: cx,
  cell_y: cy,
  state: 0,
  w: 1,
  h: 1,
  rot,
  ports,
  load: 0,
});

/** Source A at (7,5) Out facing E (rot 0) or S (rot 1); Source B at (8,6) Out facing N; Sink at (12,5). */
const sourceA = (rot: 0 | 1): NodeView => node(1, SOURCE, 7, 5, rot, [port(7, 5, rot === 0 ? E : S, 1)]);
const sourceB = (): NodeView => node(2, SOURCE, 8, 6, 3, [port(8, 6, 0, 1)]);
const sink = (): NodeView => node(3, SINK, 12, 5, 0, [port(12, 5, W, 0)]);
/** A machine far from the fan-in, for the unrelated edit. */
const other = (): NodeView => node(9, SINK, 2, 12, 0, [port(2, 12, W, 0)]);

const tiles = [8, 9, 10, 11].map((x) => ({ cell_x: x, cell_y: 5, kind: { Straight: { axis: 0 } } }));
const fanBelt = (docks: BeltDockView[]): BeltView => ({
  id: 4,
  latency: 8,
  fill: 0,
  items: [],
  tiles: tiles as BeltView['tiles'],
  docks,
  ticks_per_slot: 1,
});
const A_DOCK: BeltDockView = { end: 'Tail', node: 1, port: 0 };
const B_DOCK: BeltDockView = { end: 'Tail', node: 2, port: 0 };
const SINK_DOCK: BeltDockView = { end: 'Head', node: 3, port: 0 };

const packet = (p: Partial<RenderPacket>): RenderPacket => ({
  tick: 0,
  full: false,
  placed: [],
  removed: [],
  belts: [],
  can_undo: false,
  can_redo: false,
  wires: [],
  resync: false,
  generation: 0,
  swap_floor: 0,
  ...p,
});

/** The ring state App holds between packets. */
interface Held {
  scene: SceneState;
  standing: StandingStrand[];
  shownKey: string;
  last: RingStep | null;
}

/** Run one packet through the same order App's handler runs: detect, classify, apply, step. */
function feed(h: Held, p: RenderPacket): RingStep {
  const events = detectStrandedDocks(h.scene, p);
  const structural = isStructuralEdit(h.scene, p);
  const pre = { nodes: new Map(h.scene.nodes) };
  applyPacket(h.scene, p);
  const step = ringStep({ standing: h.standing, pre, post: h.scene, events, full: p.full, structural, shownKey: h.shownKey });
  h.standing = step.standing;
  if (step.paint === 'show') h.shownKey = ringKey(step.pts);
  if (step.paint === 'clear') h.shownKey = '';
  h.last = step;
  return step;
}

/** A whole fan-in (A and B on the Tail, the Sink on the Head), then A turned away: the cut. */
function cutFanIn(): Held {
  const h: Held = { scene: createSceneState(), standing: [], shownKey: '', last: null };
  applyPacket(
    h.scene,
    packet({ full: true, placed: [sourceA(0), sourceB(), sink(), other()], belts: [fanBelt([A_DOCK, B_DOCK, SINK_DOCK])] }),
  );
  const cut = feed(h, packet({ tick: 1, placed: [sourceA(1)], belts: [fanBelt([B_DOCK, SINK_DOCK])] }));
  expect(cut.paint, 'PRECONDITION: the cut rings').toBe('show');
  return h;
}

/** Where the rings of the cut sit: A's Out dot at rot, and the Tail end tile (8,5). */
const nubAt = (rot: 0 | 1) => {
  const p = sourceA(rot).ports[0];
  return nubAnchor(p.cell_x, p.cell_y, p.side);
};
const TAIL_END = { x: 8 * 32 + 16, y: 5 * 32 + 16 };

/** The ring points on screen after the last step. */
function onScreen(h: Held): string {
  return h.shownKey;
}

describe('ringStep: a warning ring stays until its cut is resolved (TODO-FANIN)', () => {
  it('the cut rings A\'s Out dot and the Tail end tile', () => {
    const h = cutFanIn();
    expect(onScreen(h)).toBe(ringKey([nubAt(1), TAIL_END]));
    expect(h.standing).toHaveLength(1);
  });

  it('a turn back that joins nothing keeps the ring, on A\'s dot where it is now and on the Tail end', () => {
    const h = cutFanIn();
    // D-08 leaves the Tail alone (it still holds B), so the packet re-emits A turned back and
    // nothing else: a structural edit that resolves nothing.
    const step = feed(h, packet({ tick: 2, placed: [sourceA(0)] }));
    expect(step.paint, 'the turn back repaints the ring at the moved dot').toBe('show');
    expect(onScreen(h), 'the ring is on A\'s Out dot (facing the belt again) and on the Tail end tile').toBe(
      ringKey([nubAt(0), TAIL_END]),
    );
    expect(step.rings, 'the Tail end ring stays pressable').toEqual([{ beltId: 4, end: 'Tail', pt: TAIL_END }]);
  });

  it('the reconnect of A (the cut dock comes back) clears the ring', () => {
    const h = cutFanIn();
    feed(h, packet({ tick: 2, placed: [sourceA(0)] }));
    const step = feed(h, packet({ tick: 3, belts: [fanBelt([A_DOCK, B_DOCK, SINK_DOCK])] }));
    expect(step.paint).toBe('clear');
    expect(h.standing).toEqual([]);
  });

  it('an unrelated edit leaves the ring where it is and repaints nothing', () => {
    const h = cutFanIn();
    const shown = onScreen(h);
    const step = feed(h, packet({ tick: 2, placed: [{ ...other(), rot: 1, ports: [port(2, 12, 0, 0)] }] }));
    expect(step.paint, 'nothing moved, so nothing repaints').toBe('keep');
    expect(onScreen(h)).toBe(shown);
    expect(h.standing).toHaveLength(1);
  });

  it('the Tail taking another dock (a re-aim) resolves the cut', () => {
    const h = cutFanIn();
    const step = feed(h, packet({ tick: 2, belts: [fanBelt([B_DOCK, { end: 'Tail', node: 9, port: 0 }, SINK_DOCK])] }));
    expect(step.paint).toBe('clear');
  });

  it('deleting the cut machine or the belt resolves the cut', () => {
    const a = cutFanIn();
    expect(feed(a, packet({ tick: 2, removed: [1] })).paint).toBe('clear');
    const b = cutFanIn();
    expect(feed(b, packet({ tick: 2, removed: [4] })).paint).toBe('clear');
  });

  it('a port edit on the cut machine ends the strand (its dock key names another port now)', () => {
    const h = cutFanIn();
    const grown = { ...sourceA(1), ports: [port(7, 5, S, 1), port(7, 5, E, 1, 1)] };
    // A port edit re-emits the node; a structural edit only when its box or turn changes, so a
    // turn rides with it here.
    const step = feed(h, packet({ tick: 2, placed: [{ ...grown, rot: 2 }] }));
    expect(step.paint).toBe('clear');
  });

  it('a full keyframe with no cut in it (an undo) clears every ring', () => {
    const h = cutFanIn();
    const step = feed(
      h,
      packet({ tick: 2, full: true, placed: [sourceA(0), sourceB(), sink(), other()], belts: [fanBelt([A_DOCK, B_DOCK, SINK_DOCK])] }),
    );
    expect(step.paint).toBe('clear');
    expect(h.standing).toEqual([]);
  });

  it('a second cut while the first stands rings both', () => {
    const h = cutFanIn();
    const step = feed(h, packet({ tick: 2, placed: [{ ...sourceB(), rot: 0, ports: [port(8, 6, E, 1)] }], belts: [fanBelt([SINK_DOCK])] }));
    expect(step.paint).toBe('show');
    expect(h.standing.map((s) => s.node).sort()).toEqual([1, 2]);
    expect(step.rings).toHaveLength(2);
  });

  it('a non-structural packet (items flowing) changes nothing', () => {
    const h = cutFanIn();
    const step = feed(h, packet({ tick: 2, belts: [{ ...fanBelt([B_DOCK, SINK_DOCK]), fill: 2 }] }));
    expect(step.paint).toBe('keep');
    expect(h.standing).toHaveLength(1);
  });
});
