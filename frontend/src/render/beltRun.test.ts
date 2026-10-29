import { describe, expect, it } from 'vitest';
import { beltRun, type BeltRunEntry } from './beltRun.ts';
import { createSceneState, type SceneState } from './sceneState.ts';
import type { BeltDockView, BeltView, NodeView, TileView } from '../protocol/decode.ts';
import { machine_kind } from '../protocol/kinds.ts';

// Node env, no DOM: `beltRun` is a pure read off `SceneState.belts`, exactly as
// `beltAtCell` is. Every board below is hand-built in the shape the PACKET
// delivers it (see `render_packet.rs::belt_docks`), never in the shape the core
// link graph holds it - which is the whole point of test 6.

const DEFAULT_TICKS = 2;

/** One belt tile. The geometry is irrelevant to the walk; only presence matters,
 *  because a belt with no tiles can never be the CLICKED belt (test 7). */
function tile(cx: number, cy: number): TileView {
  return { cell_x: cx, cell_y: cy, kind: { Straight: { axis: 0 } } };
}

/** `end: 'Head'` is the DOWNSTREAM neighbour (this belt delivers into it). */
function head(node: number): BeltDockView {
  return { end: 'Head', node, port: 0 };
}

/** `end: 'Tail'` is the UPSTREAM neighbour (it feeds this belt). */
function tail(node: number): BeltDockView {
  return { end: 'Tail', node, port: 0 };
}

function belt(
  id: number,
  docks: BeltDockView[],
  ticksPerSlot: number = DEFAULT_TICKS,
  tiles: TileView[] = [tile(id, 0)],
): BeltView {
  return { id, latency: 0, fill: 0, items: [], tiles, docks, ticks_per_slot: ticksPerSlot };
}

function node(id: number, kind: number): NodeView {
  return { id, kind, cell_x: id, cell_y: 5, state: 0, w: 1, h: 1, rot: 0, ports: [], load: 0 };
}

function sceneOf(belts: BeltView[], nodes: NodeView[] = []): SceneState {
  const scene = createSceneState();
  for (const b of belts) scene.belts.set(b.id, b);
  for (const n of nodes) scene.nodes.set(n.id, n);
  return scene;
}

/** The run as bare handles, which is what every ORDER assertion below reads. */
function ids(run: readonly BeltRunEntry[]): number[] {
  return run.map((entry) => entry.id);
}

describe('beltRun - the contiguous belt chain a click belongs to (BELT-01)', () => {
  it('test 1: a straight three-belt chain returns all three in FLOW order from ANY tile', () => {
    // 10 -> 11 -> 12. Each belt carries BOTH neighbours on its own docks array,
    // which is why the walk needs no reverse index.
    const scene = sceneOf([
      belt(10, [head(11)]),
      belt(11, [head(12), tail(10)]),
      belt(12, [tail(11)]),
    ]);
    // Flow order is Tail-most FIRST: 10 feeds 11 feeds 12.
    const expected = [10, 11, 12];
    // Three SEPARATE cases, not one loop assertion, because the first, middle
    // and last clicks exercise three different mixes of forward and backward
    // walking. Asserting only that they AGREE would stay green on a traversal
    // broken to return the clicked belt alone.
    expect(ids(beltRun(scene, 10)), 'clicked the FIRST tile').toEqual(expected);
    expect(ids(beltRun(scene, 11)), 'clicked the MIDDLE tile').toEqual(expected);
    expect(ids(beltRun(scene, 12)), 'clicked the LAST tile').toEqual(expected);
  });

  it('test 1b: every entry carries its OWN live pace, which is what Mixed reads', () => {
    const scene = sceneOf([
      belt(10, [head(11)], 4),
      belt(11, [head(12), tail(10)], 10),
      belt(12, [tail(11)], 10),
    ]);
    expect(beltRun(scene, 11)).toEqual([
      { id: 10, ticksPerSlot: 4 },
      { id: 11, ticksPerSlot: 10 },
      { id: 12, ticksPerSlot: 10 },
    ]);
  });

  it('test 2: a chain terminating at a MACHINE dock stops there and excludes the machine', () => {
    // 20 -> 21 -> Sink(99). The Sink is in `scene.nodes`, never in `scene.belts`.
    const scene = sceneOf(
      [belt(20, [head(21)]), belt(21, [head(99), tail(20)])],
      [node(99, machine_kind.SINK)],
    );
    expect(ids(beltRun(scene, 20))).toEqual([20, 21]);
    expect(ids(beltRun(scene, 21))).toEqual([20, 21]);
  });

  it('test 3: a chain terminating at a TEE stops there, and NO code names a Tee', () => {
    // The walk contains no kind allowlist and no `machine_kind` reference at
    // all. A Tee terminates it for exactly one reason: its handle is a key in
    // `scene.nodes` and NOT a key in `scene.belts`, so the membership test
    // fails. A Merge, a Router, a Balancer and a machine kind invented after
    // this phase all terminate it for the same reason, with no edit here.
    const scene = sceneOf(
      [belt(30, [head(31)]), belt(31, [head(98), tail(30)])],
      [node(98, machine_kind.TEE)],
    );
    expect(ids(beltRun(scene, 31))).toEqual([30, 31]);
  });

  it('test 4: an end with no dock at all terminates the walk on that side', () => {
    // 40 -> 41, and 41 has no Head dock: the dangling end. Absence of a docks
    // entry, not a null entry.
    const scene = sceneOf([belt(40, [head(41)]), belt(41, [tail(40)])]);
    expect(ids(beltRun(scene, 41))).toEqual([40, 41]);
    expect(ids(beltRun(scene, 40))).toEqual([40, 41]);
  });

  it(
    'test 5: a RING terminates and returns each belt exactly once (the visited set)',
    { timeout: 5000 },
    () => {
      // 50 -> 51 -> 52 -> 50. No shipped gesture builds this, but `links` is a
      // plain BTreeMap and a save can represent it (68-RESEARCH Area A), so the
      // walk must survive one.
      //
      // WHAT THIS PROVES: the visited set. Without it the forward walk revisits
      // 50 and spins forever, and an infinite SYNCHRONOUS loop cannot be
      // interrupted by a test timeout - it hangs the whole vitest worker. That
      // is why `beltRun` ALSO carries an explicit per-direction iteration
      // ceiling that THROWS: a regression in the visited set becomes a named
      // red here instead of a hung suite. Both guards are asserted below.
      const scene = sceneOf([
        belt(50, [head(51), tail(52)]),
        belt(51, [head(52), tail(50)]),
        belt(52, [head(50), tail(51)]),
      ]);
      const run = beltRun(scene, 50);
      expect(ids(run).slice().sort((a, b) => a - b)).toEqual([50, 51, 52]);
      expect(new Set(ids(run)).size, 'each belt appears exactly ONCE').toBe(run.length);
    },
  );

  it('test 6: a FAN-IN is ONE run, and every tile of it gives the same answer', () => {
    // THE FIX TEST, and it is the same board and the same three clicks that used to
    // characterise the deviation. Until this phase this case asserted, GREEN, that
    // three clicks on one board gave TWO different answers, and its docblock said
    // fixing it needed a second upstream on the wire. LINK-13 put one there, so the
    // fixture that proved the deviation now proves the fix rather than disappearing
    // with it.
    //
    // WINDOWS 139 IS WHAT THIS CLOSES. `belt_docks` derived the Tail dock with a
    // single-value find-first bind over the core link graph, so where two belts both
    // delivered into one belt's tail ONLY THE FIRST REACHED THE WIRE and the run set
    // depended on which tile was clicked. It now emits one Tail entry per upstream,
    // in ascending link-graph key order. Head docks were never affected: a
    // `(node, port)` has at most one OUTGOING link.
    //
    // Belts 60 and 61 both deliver into 62. On the wire that is 60.Head = 62,
    // 61.Head = 62, and 62.Tail = 60 AND 61 - two Tail entries on one belt, which is
    // the shape no packet could produce before this phase.
    //
    // D-08 IS THE SEMANTIC: one run covering both upstream branches. Two belts
    // feeding a third are one run of THREE, so the panel's shipped count sentence
    // stays correct from every tile and no fan-in copy is owed.
    const scene = sceneOf([
      belt(60, [head(62)]),
      belt(61, [head(62)]),
      belt(62, [tail(60), tail(61)]),
    ]);
    // ONE answer, asserted three times against the SAME literal rather than against
    // each other. Asserting only that the three AGREE would stay green on a walk
    // broken to return the clicked belt alone.
    const expected = [60, 61, 62];
    expect(ids(beltRun(scene, 60)), 'clicked the FIRST upstream').toEqual(expected);
    expect(ids(beltRun(scene, 61)), 'clicked the SECOND upstream').toEqual(expected);
    expect(ids(beltRun(scene, 62)), 'clicked the shared DOWNSTREAM').toEqual(expected);
  });

  it('test 6b: exactly ONE upstream is what it always was, from either tile', () => {
    // The boundary one step BELOW the fan-in, and the case that keeps this from being
    // a change only a fan-in can see. A find-first bind and a walk over every
    // upstream agree here and disagree one step above, so a test file that asserted
    // only the fan-in would not know which of the two it had shipped.
    const scene = sceneOf([belt(64, [head(65)]), belt(65, [tail(64)])]);
    expect(ids(beltRun(scene, 64)), 'clicked the upstream').toEqual([64, 65]);
    expect(ids(beltRun(scene, 65)), 'clicked the downstream').toEqual([64, 65]);
  });

  it('test 6c: ZERO upstreams is a run of one, never a fabricated neighbour', () => {
    // The boundary one step below THAT. A belt nothing feeds and that feeds nothing
    // carries no docks at all, and the honest run is itself alone.
    const scene = sceneOf([belt(66, []), belt(67, [head(68)]), belt(68, [tail(67)])]);
    expect(ids(beltRun(scene, 66))).toEqual([66]);
  });

  it('test 6d: a belt reachable by TWO branches is emitted once, and a rejoin terminates', () => {
    // A fan-in whose branches REJOIN, which is constructible for the first time now
    // that belts dock to belts: 90 delivers into 91, 92 also delivers into 91, 91
    // delivers into 93, and 93 delivers back into 90.
    //
    // WHAT THIS PROVES that test 5's plain ring does not: 93 is reachable from 90 by
    // TWO different routes - forward through 91, and directly backward off 90's own
    // Tail. An unguarded walk emits it twice, or follows the loop without bound. The
    // membership map is the guard.
    const scene = sceneOf([
      belt(90, [head(91), tail(93)]),
      belt(91, [head(93), tail(90), tail(92)]),
      belt(92, [head(91)]),
      belt(93, [head(90), tail(91)]),
    ]);
    const expected = [92, 90, 91, 93];
    for (const clicked of [90, 91, 92, 93]) {
      const run = beltRun(scene, clicked);
      expect(ids(run), `clicked ${clicked}`).toEqual(expected);
      expect(new Set(ids(run)).size, 'each belt appears exactly ONCE').toBe(run.length);
    }
  });

  it('test 7: a belt with an EMPTY tiles array is still a member of the run', () => {
    // A `Wire`-minted belt carries no tiles (`decode.ts`), so `beltAtCell` can
    // never return it and it can never be the CLICKED belt. It can still be a
    // dock target, and the membership test admits it, because it IS a belt.
    const scene = sceneOf([belt(70, [head(71)]), belt(71, [tail(70)], DEFAULT_TICKS, [])]);
    expect(ids(beltRun(scene, 70))).toEqual([70, 71]);
  });

  it('test 8: a belt with no belt neighbour on either end is a run of exactly one', () => {
    const scene = sceneOf([belt(80, [head(97), tail(96)])], [
      node(96, machine_kind.SOURCE),
      node(97, machine_kind.SINK),
    ]);
    expect(ids(beltRun(scene, 80))).toEqual([80]);
  });

  it('test 8b: a handle that is not a belt in this scene yields an EMPTY run', () => {
    // The transient between a belt leaving the scene and the selection clearing.
    // The honest answer is nothing, never a fabricated run of one.
    const scene = sceneOf([belt(80, [])]);
    expect(beltRun(scene, 81)).toEqual([]);
  });
});
