// beltRun.ts - the contiguous belt chain a clicked belt belongs to (BELT-01).
//
// D-68-05: a "run" is a contiguous chain of belt NODES linked end to end,
// terminating at a machine dock, at a Tee (or any other non-belt node), or at a
// dangling end. D-68-06 puts the traversal in the FRONTEND, and it needs no new
// packet field: the scene already holds the whole link graph.
//
// A pure read off `SceneState.belts`, the same shape and the same discipline as
// `gestures.ts`'s `beltAtCell` - the docblock names the findings the code rests
// on, at the code.
//
// FOUR FACTS THIS FILE CARRIES, because a reader gets each of them wrong by
// default:
//
// 1. THE DOCK END NAMES ARE COUNTER-INTUITIVE. `end: 'Head'` is the DOWNSTREAM
//    neighbour - the node this belt DELIVERS into. `end: 'Tail'` is an UPSTREAM
//    neighbour - a node that FEEDS this belt. Read off the producer:
//    `crates/fabrico-host/src/render_packet.rs::belt_docks` builds the Head dock
//    from `link_target((belt, 0))` (the belt's own outgoing link) and the Tail
//    docks from every link whose TARGET is `(belt, 0)`. It is named rather than
//    cited by line: this file's previous citation drifted 244 lines out of date
//    before anybody noticed. Both ends live on the CLICKED belt's own `docks`
//    array, so this walk needs no reverse index and does not read
//    `SceneState.dockedBelts`.
//
// 2. THE MEMBERSHIP TEST IS KIND-AGNOSTIC ON PURPOSE. A docked node is part of
//    the run only if its handle is a key in `scene.belts`. Nodes and belts share
//    one dense handle space but live in two separate maps (`sceneState.ts`), so
//    a Tee, a Merge, a Router, a Balancer and every machine kind terminate the
//    walk WITHOUT ANY CODE NAMING THEM - and so will a node kind invented after
//    this phase, with no edit here. A kind allowlist would have to be revisited
//    every time the catalog grows; this cannot go stale.
//
// 3. THE MEMBERSHIP MAP IS LOAD-BEARING, NOT DEFENSIVE. `links` is a plain
//    `BTreeMap<(NodeId, PortId), (NodeId, PortId)>`, so a ring (A delivers into
//    B, B into C, C into A) is three ordinary link records and is REPRESENTABLE
//    IN A SAVE. Since LINK-10 a fan-in whose two branches later REJOIN is
//    representable by a shipped gesture as well, which puts a second belt on the
//    same rejoin point by an ordinary drawing action rather than by a forged
//    file. An unguarded walk on either spins forever on the render thread. The
//    map is the guard; the ceilings below are the backstop that turn a
//    regression in it into a loud throw instead of a hung UI.
//
// 4. A FAN-IN IS ONE RUN, AND THE PACKET NOW CARRIES ONE (LINK-13, closing
//    WINDOWS 139). A `(node, port)` has at most one OUTGOING link, so a belt's
//    Head dock is exact and there is at most one of them. But ANY NUMBER of
//    links may target `(belt, 0)`, so a belt may carry SEVERAL Tail docks. Until
//    this phase the packet reported only the first, and the run set therefore
//    depended on which tile was clicked - which is worse than no count at all,
//    because the panel states the count as a fact. `belt_docks` now reports every
//    upstream, and this walk follows every one, so D-08's semantic holds: two
//    belts feeding a third are ONE run of three, the same set and the same count
//    from every tile, and one Apply paces all three.
//
//    THAT IS WHY THIS IS A COMPONENT WALK AND NOT A CHAIN WALK. Following the
//    Head chain forward and the Tail chain backward CANNOT produce a
//    click-independent answer at a fan-in: from one upstream branch the other
//    branch is only reachable by going forward to the junction and then backward
//    again. So the run is the connected component the clicked belt sits in,
//    walked in both directions at once, and then ORDERED.
//
// NOT A PER-FRAME READ. It runs on a belt SELECTION and on a poll tick whose
// packet changed the run, never inside the render loop: the project constraint is
// that idle ticks are nearly free, and a graph walk does not belong on one.

import type { BeltView } from '../protocol/decode.ts';
import type { SceneState } from './sceneState.ts';

/**
 * One belt in a run: its dense render handle plus its OWN live advance interval.
 *
 * The pace travels with the handle because both readers need it and neither may
 * re-query for it. `BeltView.ticks_per_slot` is already in the render packet for
 * every belt, so the two things the run is read for - detecting that the belts
 * DISAGREE (68-UI-SPEC state 5), and observing that an Apply landed on ALL of
 * them (section 8.1) - cost nothing beyond this walk.
 */
export interface BeltRunEntry {
  /** The belt's dense render handle - the same handle space as `NodeView.id`. */
  id: number;
  /** This belt's advance interval in sim ticks per slot. Larger means slower. */
  ticksPerSlot: number;
}

/**
 * The contiguous belt run containing `clicked`, in FLOW ORDER - upstream before
 * the belt it feeds.
 *
 * Order is part of the contract, not an accident of the walk: the run line reads
 * its COUNT and the Mixed detection reads its paces, and an arbitrary order would
 * make the count correct while making every positional reading meaningless. The
 * order is also CLICK-INDEPENDENT, which is what lets `beltRunSignature` bail the
 * panel out of a re-render on a poll tick that changed nothing.
 *
 * Returns an EMPTY run when `clicked` is not a belt in this scene - the transient
 * between a belt leaving the scene and the selection clearing. Nothing is the
 * honest answer there; a fabricated run of one is exactly the wrong answer this
 * phase can produce.
 */
export function beltRun(scene: SceneState, clicked: number): BeltRunEntry[] {
  const start = scene.belts.get(clicked);
  if (!start) return [];

  // The ceilings are the BACKSTOP for fact 3, not the guard. The membership map
  // already bounds the walk by the number of distinct belts; if a future edit
  // breaks it, these throw with a name a reader can act on instead of hanging the
  // render thread, and `beltRun.test.ts` tests 5 and 6d go red instead of hanging
  // the suite.
  const ceiling = scene.belts.size;

  // --- 1. The connected component, walked in BOTH directions at once ----------
  //
  // Every dock of every member is followed, Head and Tail alike, so a fan-in's
  // second branch is reached by going forward to the junction and then backward
  // off its second Tail dock. A belt already in `members` is never enqueued
  // twice, which is what makes a rejoin and a ring terminate.
  const members = new Map<number, BeltView>([[clicked, start]]);
  const queue: BeltView[] = [start];
  let admitted = 0;
  while (queue.length > 0) {
    const belt = queue.shift() as BeltView;
    for (const dock of belt.docks) {
      const neighbour = scene.belts.get(dock.node);
      if (!neighbour || members.has(neighbour.id)) continue;
      if (++admitted >= ceiling) {
        throw new Error(
          `beltRun: component walk exceeded ${ceiling} belts (membership map broken)`,
        );
      }
      members.set(neighbour.id, neighbour);
      queue.push(neighbour);
    }
  }

  // --- 2. The flow edges between members --------------------------------------
  //
  // One edge per ORDERED pair, deduplicated: a link between two belts appears
  // TWICE in the scene, once as the upstream's Head dock and once as the
  // downstream's Tail dock, and counting it twice would corrupt the in-degrees
  // the ordering below reads. A dock naming a non-member (a machine, a Tee, or a
  // belt outside this component) contributes no edge, which is fact 2 again.
  const outgoing = new Map<number, number[]>();
  const inDegree = new Map<number, number>();
  for (const id of members.keys()) {
    outgoing.set(id, []);
    inDegree.set(id, 0);
  }
  const seenEdge = new Set<string>();
  const addEdge = (from: number, to: number): void => {
    if (from === to) return; // a belt docked to itself is not a step along a run
    if (!members.has(from) || !members.has(to)) return;
    const key = `${from}>${to}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    (outgoing.get(from) as number[]).push(to);
    inDegree.set(to, (inDegree.get(to) as number) + 1);
  };
  for (const [id, belt] of members) {
    for (const dock of belt.docks) {
      if (dock.end === 'Head') addEdge(id, dock.node);
      else addEdge(dock.node, id);
    }
  }

  // --- 3. FLOW ORDER, click-independent ---------------------------------------
  //
  // A topological emission: a belt is emitted once nothing upstream of it is
  // still waiting. On a straight chain that is exactly the Tail-most-first order
  // this function has always returned. At a fan-in both upstream branches are
  // ready at once and the tie is broken by ASCENDING HANDLE, which is a total
  // order on distinct handles and therefore deterministic.
  //
  // THE FALLBACK IS THE CYCLE ARM. A ring has no belt with nothing upstream of
  // it, so the topological pass stalls with members left over. Rather than
  // dropping them (a silently short run) or looping (a hung UI), the smallest
  // remaining handle is emitted and the pass resumes. A ring therefore reads from
  // its lowest handle, which is arbitrary but stable and complete.
  const sortedIds = [...members.keys()].sort((a, b) => a - b);
  const emitted = new Set<number>();
  const ordered: number[] = [];
  while (ordered.length < sortedIds.length) {
    const ready = sortedIds.find((id) => !emitted.has(id) && inDegree.get(id) === 0);
    const next = ready ?? sortedIds.find((id) => !emitted.has(id));
    if (next === undefined) {
      throw new Error(
        `beltRun: ordering pass found no belt to emit of ${ceiling} (membership map broken)`,
      );
    }
    emitted.add(next);
    ordered.push(next);
    for (const to of outgoing.get(next) as number[]) {
      inDegree.set(to, (inDegree.get(to) as number) - 1);
    }
  }

  return ordered.map((id) => {
    const belt = members.get(id) as BeltView;
    return { id: belt.id, ticksPerSlot: belt.ticks_per_slot };
  });
}

/**
 * A structural signature of a run: its handles AND their paces, in order.
 *
 * The `portsSignature` / `flowSignature` idiom, and it exists for the identical
 * reason - the ~10Hz poll re-derives the run on every tick, and a fresh array
 * every 100ms would defeat React's bail-out and re-render the panel forever. The
 * PACES are in the signature deliberately: a neighbour whose pace changed is a
 * run change the panel must see (it is what flips the Mixed state and what the
 * whole-run applied observation reads).
 */
export function beltRunSignature(run: readonly BeltRunEntry[]): string {
  return run.map((entry) => `${entry.id}:${entry.ticksPerSlot}`).join(',');
}
