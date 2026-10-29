import { describe, expect, it } from 'vitest';
import type { BeltView, NodeView } from '../protocol/decode.ts';
import { BELT_PORT_HEAD } from '../protocol/ports.ts';
import { createSceneState, type SceneState } from '../render/sceneState.ts';
import type { GestureVerdict } from '../transport/transport.ts';
import {
  CLAIM_TTL_TICKS,
  beltClaim,
  createQueuedClaims,
  deleteClaim,
  dockClaim,
  placeClaim,
  resizeClaim,
} from './queuedClaims.ts';

// queuedClaims.ts (phase 88, plan 88-07, BELT-06, D-09): one claim per queued gesture, keyed by
// its gesture id, read by the one occupancy definition. These cases pin what a claim takes and,
// research Pitfall 10, every way it ends: a claim that never ends would block drawing on its
// cells for good, because the belt path check is a gate.

const accept = (seq: number, minted: number[], generation = 0): GestureVerdict => ({
  kind: 'gestureAccepted',
  seq,
  generation,
  minted,
});
const refuse = (seq: number): GestureVerdict => ({ kind: 'gestureRefused', seq, tag: 'FootprintCollision' }) as GestureVerdict;
const discard = (seq: number): GestureVerdict => ({ kind: 'gestureDiscarded', seq });

const sceneAt = (tick: number, generation = 0): SceneState => {
  const s = createSceneState();
  s.tick = tick;
  s.generation = generation;
  return s;
};
const withBelt = (s: SceneState, id: number): SceneState => {
  s.belts.set(id, { id, latency: 1, fill: 0, items: [], tiles: [], docks: [], ticks_per_slot: 1 } as BeltView);
  return s;
};
const withNode = (s: SceneState, id: number): SceneState => {
  s.nodes.set(id, { id, kind: 0, cell_x: 0, cell_y: 0, state: 0, w: 1, h: 1, rot: 0, ports: [], load: 0 } as NodeView);
  return s;
};

/** A held belt drawn off Source 1's Out (catalog index 0) through (3,5)-(5,5). */
const HELD = beltClaim(
  [
    [3, 5],
    [4, 5],
    [5, 5],
  ],
  { node: 1, port: 0 },
);

describe('queuedClaims: what a claim takes', () => {
  it('a belt claim occupies its tiles and takes its source doorstep, and nothing else', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0 });
    expect([c.occupies(3, 5, 0), c.occupies(4, 5, 0), c.occupies(5, 5, 0)], 'its tiles').toEqual([true, true, true]);
    expect(c.occupies(6, 5, 0), 'the cell past its head').toBe(false);
    expect(c.doorstepTaken(1, 0, 0), "the Out it was drawn off: its one link is the held belt's Tail dock").toBe(true);
    expect(c.doorstepTaken(1, 1, 0), 'another port of the same machine').toBe(false);
    expect(c.size()).toBe(1);
  });

  it('a draw from plain floor takes no source', () => {
    const c = createQueuedClaims();
    c.add(7, beltClaim([[3, 5]], null), { generation: 0 });
    expect(c.doorstepTaken(1, 0, 0)).toBe(false);
  });

  it('a place claim takes its footprint unturned and turned', () => {
    // A 2 by 1 machine at (4,4) turned once: unturned (4,4),(5,4), turned (4,4),(4,5).
    const c = createQueuedClaims();
    c.add(3, placeClaim({ cx: 4, cy: 4 }, 2, 1, 1), { generation: 0 });
    expect([c.occupies(4, 4, 0), c.occupies(5, 4, 0), c.occupies(4, 5, 0)]).toEqual([true, true, true]);
    expect(c.occupies(5, 5, 0)).toBe(false);
  });

  it('a resize claim takes the new cells only, and a shrink takes nothing', () => {
    const c = createQueuedClaims();
    c.add(4, resizeClaim({ id: 9, cx: 10, cy: 12, w: 4, h: 1 }, 6, 1), { generation: 0 });
    expect([c.occupies(14, 12, 0), c.occupies(15, 12, 0)], 'the grown cells').toEqual([true, true]);
    expect(c.occupies(12, 12, 0), "the label's own cells are its own").toBe(false);
    expect(c.occupies(15, 12, 0, 9), 'excluded by its own label').toBe(false);
    c.add(5, resizeClaim({ id: 8, cx: 0, cy: 0, w: 4, h: 1 }, 2, 1), { generation: 0 });
    expect(c.occupies(1, 0, 0) || c.occupies(3, 0, 0), 'a shrink').toBe(false);
  });

  it("a dock claim takes the one source its link uses: the carrier's Head, or the target's port", () => {
    const c = createQueuedClaims();
    // D's Tail onto belt A's Head: A's Head is taken.
    c.add(10, dockClaim({ belt: 20, end: 'Tail', node: 21, port: BELT_PORT_HEAD, targetIsBelt: true }), { generation: 0 });
    expect(c.beltEndTaken(21, 'Head', 0)).toBe(true);
    expect(c.beltEndTaken(20, 'Tail', 0), "the carrier's Tail is never taken").toBe(false);
    expect(c.beltEndTaken(21, 'Tail', 0), "nor the target's").toBe(false);
    // B's Head docked into a machine In: B's Head is taken.
    c.add(11, dockClaim({ belt: 22, end: 'Head', node: 5, port: 0, targetIsBelt: false }), { generation: 0 });
    expect(c.beltEndTaken(22, 'Head', 0)).toBe(true);
    // C's Tail onto machine 6's Out (catalog index 2): that Out is taken.
    c.add(12, dockClaim({ belt: 23, end: 'Tail', node: 6, port: 2, targetIsBelt: false }), { generation: 0 });
    expect(c.doorstepTaken(6, 2, 0)).toBe(true);
    // A Tail aimed at a belt's Tail takes nothing (the host refuses it on role).
    c.add(13, dockClaim({ belt: 24, end: 'Tail', node: 25, port: 0, targetIsBelt: true }), { generation: 0 });
    expect(c.beltEndTaken(25, 'Head', 0) || c.doorstepTaken(25, 0, 0)).toBe(false);
    expect([...Array(4)].map((_, i) => c.occupies(i, 0, 0)), 'a dock takes no cell').toEqual([false, false, false, false]);
  });
});

describe('queuedClaims: every way a claim ends (research Pitfall 10)', () => {
  it('a refusal or a discard ends it at once', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0 });
    c.add(8, placeClaim({ cx: 9, cy: 9 }, 1, 1, 0), { generation: 0 });
    c.onVerdict(refuse(7));
    expect(c.occupies(4, 5, 0), 'refused').toBe(false);
    c.onVerdict(discard(8));
    expect(c.occupies(9, 9, 0), 'discarded by a swap').toBe(false);
    expect(c.size()).toBe(0);
  });

  it('an accept ends it once a packet holds its minted handle, and not before', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0 });
    c.onVerdict(accept(7, [42]), sceneAt(10));
    expect(c.occupies(4, 5, 0), 'accepted, but no packet shows belt 42 yet').toBe(true);
    c.onPacket(sceneAt(11), false);
    expect(c.occupies(4, 5, 0), 'a packet without it').toBe(true);
    c.onPacket(withBelt(sceneAt(12), 42), false);
    expect(c.occupies(4, 5, 0), 'the packet holding belt 42: the scene carries it now').toBe(false);
  });

  it('an accept whose packet came first ends it on the verdict; a later generation ends it too', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0 });
    c.onVerdict(accept(7, [42]), withBelt(sceneAt(10), 42));
    expect(c.size(), 'packet before accept').toBe(0);
    c.add(8, placeClaim({ cx: 1, cy: 1 }, 1, 1, 0), { generation: 0 });
    c.onVerdict(accept(8, [5], 2), sceneAt(10, 2));
    expect(c.size(), 'no node 5 at generation 2 yet').toBe(1);
    c.onPacket(withNode(sceneAt(11, 2), 6), false);
    expect(c.size(), 'another node').toBe(1);
    c.onPacket(sceneAt(12, 3), false);
    expect(c.size(), 'a keyframe of a later generation: the scene is past the accept').toBe(0);
  });

  it('an accept naming no handle for a gesture that mints ends it; a dock or resize accept ends on the next packet', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0 });
    c.onVerdict(accept(7, []));
    expect(c.size(), 'nothing to wait for').toBe(0);
    c.add(9, dockClaim({ belt: 20, end: 'Head', node: 5, port: 0, targetIsBelt: false }), { generation: 0 });
    c.onVerdict(accept(9, []), sceneAt(10));
    expect(c.beltEndTaken(20, 'Head', 0), 'until the next packet').toBe(true);
    c.onPacket(sceneAt(10), false);
    expect(c.beltEndTaken(20, 'Head', 0)).toBe(false);
  });

  it('a claim added twice under one gesture id is one claim, the second', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0 });
    c.add(7, beltClaim([[9, 9]], null), { generation: 0 });
    expect(c.size()).toBe(1);
    expect(c.occupies(4, 5, 0), 'the first is replaced').toBe(false);
    expect(c.occupies(9, 9, 0)).toBe(true);
    c.onVerdict(refuse(7));
    expect(c.size(), 'one answer ends it').toBe(0);
  });

  it('a claim with no verdict survives 600 paused ticks and ends 121 playing ticks after onResume', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0, tick: 0 });
    c.onPacket(sceneAt(600), false);
    expect(c.occupies(4, 5, 0), 'a paused drain of 600 ticks never ends it').toBe(true);
    c.onResume(600);
    c.onPacket(sceneAt(600 + CLAIM_TTL_TICKS), true);
    expect(c.occupies(4, 5, 0), '120 playing ticks after Resume: still held').toBe(true);
    c.onPacket(sceneAt(600 + CLAIM_TTL_TICKS + 1), true);
    expect(c.occupies(4, 5, 0), '121: the fallback frees the cells').toBe(false);
  });

  it('a handle a claim took is read only in the table it was taken from (phase 88 review, WR-01)', () => {
    // A claim's sources and a resize claim's label are render handles of the table its gesture
    // was sent from. After a reset the same handle names another node, so a reader holding a
    // later table must not see them; the cells are world coordinates and still count.
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 3 });
    c.add(8, dockClaim({ belt: 20, end: 'Head', node: 5, port: 0, targetIsBelt: false }), { generation: 3 });
    c.add(9, resizeClaim({ id: 9, cx: 10, cy: 12, w: 4, h: 1 }, 6, 1), { generation: 3 });
    expect(c.doorstepTaken(1, 0, 3), 'the doorstep, in its own table').toBe(true);
    expect(c.doorstepTaken(1, 0, 4), 'handle 1 of a later table is another machine').toBe(false);
    expect(c.beltEndTaken(20, 'Head', 3), 'the Head, in its own table').toBe(true);
    expect(c.beltEndTaken(20, 'Head', 4), 'handle 20 of a later table is another belt').toBe(false);
    expect(c.occupies(4, 5, 4), 'the held tiles still count in a later table').toBe(true);
    expect(c.occupies(15, 12, 3, 9), "the label's own grow, excluded in its own table").toBe(false);
    expect(c.occupies(15, 12, 4, 9), 'handle 9 of a later table is not that label: the grow counts').toBe(true);
  });

  it('a verdict for an id it never held, or with no seq, does nothing; clear ends every claim', () => {
    const c = createQueuedClaims();
    c.add(7, HELD, { generation: 0 });
    c.add(0, placeClaim({ cx: 1, cy: 1 }, 1, 1, 0), { generation: 0 });
    expect(c.size(), 'a 0 id is nothing sent').toBe(1);
    c.onVerdict(refuse(99));
    c.onVerdict({ kind: 'gestureRefused', tag: 'Malformed' } as GestureVerdict);
    expect(c.size()).toBe(1);
    c.clear();
    expect(c.size(), 'a swap').toBe(0);
  });
});

// Review fix pass 1, WR-A-04 (threat T-92-11): the board-to-be the cable preview routes round.
describe('queuedClaims: the board a queued cable is routed round', () => {
  it('a Place of a machine adds its turned box; a Label adds none', () => {
    const c = createQueuedClaims();
    c.add(1, placeClaim({ cx: 4, cy: 4 }, 3, 3, 0, true), { generation: 0 });
    c.add(2, placeClaim({ cx: 10, cy: 0 }, 2, 3, 1, true), { generation: 0 });
    c.add(3, placeClaim({ cx: 20, cy: 0 }, 4, 1, 0, false), { generation: 0 });
    expect(c.wireBoard(0).boxes).toEqual([
      { min_x: 4, min_y: 4, max_x: 6, max_y: 6 },
      // A 2x3 turned once is 3x2, grown from the anchor it keeps.
      { min_x: 10, min_y: 0, max_x: 12, max_y: 1 },
    ]);
    expect(c.wireBoard(5).boxes, 'boxes are world cells, read in every table').toHaveLength(2);
    expect(c.wireBoard(0).deleted.size).toBe(0);
  });

  it('a Delete names its node in its own table only, and takes no cell or source', () => {
    const c = createQueuedClaims();
    c.add(4, deleteClaim(9), { generation: 2 });
    expect([...c.wireBoard(2).deleted]).toEqual([9]);
    expect(c.wireBoard(3).deleted.size, 'another table: handle 9 names another node').toBe(0);
    expect(c.occupies(0, 0, 2) || c.doorstepTaken(9, 0, 2) || c.beltEndTaken(9, 'Head', 2)).toBe(false);
  });

  it('a Delete claim ends on a refusal, or on the first packet after its accept', () => {
    const c = createQueuedClaims();
    c.add(5, deleteClaim(9), { generation: 0 });
    c.add(6, deleteClaim(8), { generation: 0 });
    c.onVerdict(refuse(5));
    expect([...c.wireBoard(0).deleted]).toEqual([8]);
    c.onVerdict(accept(6, []), sceneAt(10));
    expect([...c.wireBoard(0).deleted], 'an accept alone does not end it').toEqual([8]);
    c.onPacket(sceneAt(11), false);
    expect(c.wireBoard(0).deleted.size, 'the next packet shows the fold').toBe(0);
  });
});
