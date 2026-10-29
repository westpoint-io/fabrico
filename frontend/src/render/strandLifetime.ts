// strandLifetime.ts - HOW LONG a warning ring stays (phase 89 review fix, TODO-FANIN).
//
// The detectors in strandedDocks.ts say when a dock is CUT. This module decides, packet by
// packet, which cuts are still ringed, so the rule is unit-testable apart from App's packet
// handler. App calls `ringStep` once per packet, before nothing and after `applyPacket`, and
// paints what it answers.
//
// Pure: reads the scenes it is handed, mutates none of them, no Pixi, no DOM.

import type { BeltEnd } from '../protocol/decode.ts';
import type { SceneState } from './sceneState.ts';
import type { StrandedDock } from './strandedDocks.ts';
import { strandRingPoints, type RingPoint } from './strandRings.ts';

/**
 * A cut that is still ringed, in POST-apply handles. Only a cut whose machine kept its port
 * list stands (a turn): after a port edit the dock's key names another port, so the cut can
 * never be judged re-docked by key, and it keeps the shipped rule (the next structural edit
 * clears it).
 */
export interface StandingStrand {
  beltId: number;
  end: BeltEnd;
  node: number;
  port: number;
  /** The dock keys `end` held right after the cut. The end took another dock once it holds a key not in this list. */
  endDocksAtCut: readonly string[];
  /** The machine's port count right after the cut. A port edit since then re-keys its docks, which ends the strand. */
  portCount: number;
}

/** A pressable ring record, the shape `GestureController.setStrandedRings` takes. */
export interface StandingRing {
  beltId: number;
  end: BeltEnd;
  pt: RingPoint;
}

/** What App does with the overlay after one packet. */
export interface RingStep {
  /** The cuts still ringed after this packet. */
  standing: StandingStrand[];
  /** `show`: paint `pts` and hand over `rings`; `clear`: clear every ring; `keep`: leave the overlay as it is. */
  paint: 'show' | 'clear' | 'keep';
  pts: RingPoint[];
  rings: StandingRing[];
}

/** The inputs of one step. `pre` is the scene before `applyPacket` (only its nodes are read), `post` after it. */
export interface RingStepInput {
  standing: readonly StandingStrand[];
  pre: Pick<SceneState, 'nodes'>;
  post: Pick<SceneState, 'nodes' | 'belts'>;
  /** The cuts the detectors found in this packet (strandedDocks.ts), pre-apply handles. */
  events: readonly StrandedDock[];
  full: boolean;
  /** `isStructuralEdit` of this packet, computed pre-apply. */
  structural: boolean;
  /** The ring points last shown, so an edit that moves no ring repaints nothing (`ringKey`). */
  shownKey: string;
}

/** A stable key for a point list, compared to decide whether a repaint is needed. */
export function ringKey(pts: readonly RingPoint[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(';');
}

/**
 * One packet's ring step. THE RULE (TODO-FANIN, option 3; amends 89-UI-SPEC 4.2's lifetime row):
 * a ring stays until its cut is resolved. A cut is resolved when the cut dock comes back, when
 * its belt end takes another dock (a re-aim), when its belt or its machine is deleted, or when
 * the machine's port list changes. A full keyframe (undo, redo, load) clears every ring unless
 * the keyframe detector rings a cut in it, as before. Any other edit, including a turn that
 * joins nothing (D-08 never joins an end that still holds a dock), leaves the ring where it is.
 */
export function ringStep(input: RingStepInput): RingStep {
  const { events, structural, full, post } = input;
  if (events.length === 0 && !structural) {
    return { standing: [...input.standing], paint: 'keep', pts: [], rings: [] };
  }
  if (events.length === 0 && full) {
    return { standing: [], paint: 'clear', pts: [], rings: [] };
  }
  const kept = full ? [] : input.standing.filter((s) => stillStanding(s, post));
  const fresh = events.filter((ev) => !kept.some((s) => sameCut(s, ev, post)));
  const pts: RingPoint[] = [];
  const rings: StandingRing[] = [];
  const add = (ev: StrandedDock, pre: Pick<SceneState, 'nodes'>): void => {
    const { nub, beltEnd } = strandRingPoints(pre, post, ev);
    if (nub) pts.push(nub);
    if (beltEnd) {
      pts.push(beltEnd);
      rings.push({ beltId: ev.beltId, end: ev.end, pt: beltEnd });
    }
  };
  // A standing cut's machine is unchanged in port count by construction, so the post-apply
  // node answers its nub where the nub is now (a turn moves it with the machine).
  for (const s of kept) add(s, post);
  for (const ev of fresh) add(ev, input.pre);
  const standing = [...kept, ...fresh.flatMap((ev) => stand(ev, input.pre, post))];
  if (pts.length === 0) {
    return { standing, paint: 'clear', pts, rings };
  }
  if (events.length === 0 && ringKey(pts) === input.shownKey) {
    return { standing, paint: 'keep', pts, rings };
  }
  return { standing, paint: 'show', pts, rings };
}

/** The dock key both detectors and this module share: `${end}|${node}|${port}`, post-apply handles. */
function dockKey(end: BeltEnd, node: number, port: number): string {
  return `${end}|${node}|${port}`;
}

/** The post-apply node handle a cut names: by origin cell and kind on the keyframe path, else its own handle. */
function postNodeOf(ev: StrandedDock, post: Pick<SceneState, 'nodes'>): number | null {
  if (ev.nodeKind === undefined) {
    return post.nodes.has(ev.node) ? ev.node : null;
  }
  for (const n of post.nodes.values()) {
    if (n.cell_x === ev.nodeCellX && n.cell_y === ev.nodeCellY && n.kind === ev.nodeKind) return n.id;
  }
  return null;
}

/** Is `ev` the cut `s` already rings? */
function sameCut(s: StandingStrand, ev: StrandedDock, post: Pick<SceneState, 'nodes'>): boolean {
  return s.beltId === ev.beltId && s.end === ev.end && s.port === ev.port && s.node === postNodeOf(ev, post);
}

/** A fresh cut as a standing one, or nothing when its machine is gone or a port edit made it. */
function stand(
  ev: StrandedDock,
  pre: Pick<SceneState, 'nodes'>,
  post: Pick<SceneState, 'nodes' | 'belts'>,
): StandingStrand[] {
  const node = postNodeOf(ev, post);
  const belt = post.belts.get(ev.beltId);
  if (node === null || belt === undefined) return [];
  const postNode = post.nodes.get(node);
  const preNode = pre.nodes.get(ev.node);
  if (postNode === undefined || (preNode !== undefined && preNode.ports.length !== postNode.ports.length)) return [];
  return [
    {
      beltId: ev.beltId,
      end: ev.end,
      node,
      port: ev.port,
      endDocksAtCut: belt.docks.filter((d) => d.end === ev.end).map((d) => dockKey(d.end, d.node, d.port)),
      portCount: postNode.ports.length,
    },
  ];
}

/** Does the cut `s` still stand on the board `post` shows? */
function stillStanding(s: StandingStrand, post: Pick<SceneState, 'nodes' | 'belts'>): boolean {
  const belt = post.belts.get(s.beltId);
  const node = post.nodes.get(s.node);
  if (belt === undefined || node === undefined || node.ports.length !== s.portCount) return false;
  const atEnd = belt.docks.filter((d) => d.end === s.end).map((d) => dockKey(d.end, d.node, d.port));
  if (atEnd.includes(dockKey(s.end, s.node, s.port))) return false;
  return atEnd.every((k) => s.endDocksAtCut.includes(k));
}
