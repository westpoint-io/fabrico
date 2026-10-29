// strandRings.ts - WHERE the two alarm rings of a stranded dock go (plan 74.1-27).
//
// A stranded dock (strandedDocks.ts) is drawn as two rings: one on the port the belt
// let go of (the vacated nub) and one on the belt end that came loose. This module
// owns the point math for both, as one pure function, so the rule is unit-testable
// apart from App's packet handler.
//
// THE RULE FOR THE VACATED NUB, and why it reads the board as it was before the packet.
// A dock names its port by a key into the node's port list (an Out's routing key, a
// catalog index, or the fault sentinel; see `dockPort`). After a port edit that list
// has changed, so the old key names a DIFFERENT port: after `Remove output 1` on a
// two-output Factory, routing key 0 is the surviving output, and resolving against the
// new list put a ring on a still-connected nub (walk item N5, 2026-10-05). So:
//
//   - the port is resolved against the node BEFORE the packet, where the key still
//     names the port the belt was docked to, and its anchor is taken there;
//   - except when the node's port COUNT did not change (a turn): the port still exists
//     and moved with the machine, so it is resolved on the node AFTER the packet and
//     ringed where the nub is now;
//   - the node after the packet is found by handle on the diff path and by origin cell
//     plus kind on the keyframe path (a keyframe re-mints handles, WR-01). If it is
//     gone, no nub is ringed (a deleted machine has no nub to point at).
//
// Since 74.1-16 a port edit moves no other port, so a removed port's pre-apply anchor
// is exactly where the user last saw it.
//
// Pure: reads both scenes, mutates neither, no Pixi, no DOM.

import { beltEndCell, dockPort, nubAnchor } from '../protocol/ports.ts';
import { CELL } from '../../shared/geometry';
import type { SceneState } from './sceneState.ts';
import { findNodeByCellKind, type StrandedDock } from './strandedDocks.ts';

/** A world-px point. */
export interface RingPoint {
  x: number;
  y: number;
}

/** The two ring points of one stranded dock; either is null when it cannot be placed. */
export interface StrandRingPoints {
  /** The vacated port's nub anchor. */
  nub: RingPoint | null;
  /** The orphaned belt end's tile centre. */
  beltEnd: RingPoint | null;
}

/**
 * Resolve one {@link StrandedDock} to its ring points.
 *
 * `pre` is the scene as it was BEFORE `applyPacket` (App passes a copy of the node map
 * taken before the apply; only `nodes` is read), `post` the scene after it. `ev.node` is
 * a pre-apply handle on both detection paths, so it always indexes `pre`.
 */
export function strandRingPoints(
  pre: Pick<SceneState, 'nodes'>,
  post: Pick<SceneState, 'nodes' | 'belts'>,
  ev: StrandedDock,
): StrandRingPoints {
  const preNode = pre.nodes.get(ev.node) ?? null;
  const postNode =
    ev.nodeKind !== undefined
      ? findNodeByCellKind(post as SceneState, ev.nodeCellX as number, ev.nodeCellY as number, ev.nodeKind)
      : (post.nodes.get(ev.node) ?? null);

  let nub: RingPoint | null = null;
  if (postNode) {
    // A port edit changes the count; a turn does not. Without a pre-apply node there is
    // nothing older to read, so the post-apply node is the only answer.
    const source = preNode && preNode.ports.length !== postNode.ports.length ? preNode : postNode;
    const port = dockPort(source, ev);
    if (port) {
      nub = nubAnchor(port.cell_x, port.cell_y, port.side);
    }
  }

  let beltEnd: RingPoint | null = null;
  const belt = post.belts.get(ev.beltId);
  if (belt && belt.tiles.length > 0) {
    const [cx, cy] = beltEndCell(belt.tiles, ev.end);
    beltEnd = { x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 };
  }
  return { nub, beltEnd };
}
