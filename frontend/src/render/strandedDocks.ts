// strandedDocks.ts — the PURE pre-apply packet-vs-scene dock-vanished diff
// (REND-06 / D-15, the P17 carry-in: a Rotate that strands a dock must flag
// the vacated port and orphaned belt end with a visual alert — NO packet
// signal, no schema bump; UI-SPEC section 6).
//
// Why a client diff is reliable (RESEARCH Finding 7): the host's active-set
// diff re-emits any belt whose full BeltView struct changed (docks included)
// in the SAME packet as the rotated node (render_packet.rs:340-374). So a
// rotate-unlink always arrives as "belt re-emitted WITHOUT the dock the scene
// still holds" — comparable BEFORE applyPacket overwrites the baseline.
//
// False-positive classes (Pitfall 7), all suppressed here:
//   - full:true keyframes re-mint handles; undo/redo/load legitimately
//     restructure and always ride keyframes (producer.reset) — return []
//     immediately. A belt an undo or redo lets go of is the keyframe sibling's
//     job, {@link detectKeyframeStrand} (74.1-27).
//   - cascade delete: a Delete of the docked machine drops the dock too; the
//     node handle rides packet.removed in the same packet — not a strand.
//
// Pure module discipline: imports ONLY types from decode/sceneState, reads
// both structures without mutation, no Pixi/DOM.

import type { BeltEnd, BeltView, NodeView, RenderPacket } from '../protocol/decode.ts';
import type { SceneState } from './sceneState.ts';

/** One stranded-dock event: the vacated port identity + the orphaned belt end. */
export interface StrandedDock {
  beltId: number;
  end: BeltEnd;
  node: number;
  port: number;
  /**
   * The docked node's STABLE structural identity (origin cell + kind), set ONLY
   * by {@link detectKeyframeStrand} (the keyframe path). A `full` keyframe RE-MINTS
   * render handles (sceneState.ts clears + re-keys by `packet.placed[].id`), so
   * the `node` handle above is a PRE-keyframe value that is stale post-apply.
   * The consumer resolves the vacated nub by this structural key against the
   * POST-apply scene instead (see {@link findNodeByCellKind}). Absent on the
   * non-keyframe {@link detectStrandedDocks} path, whose handles stay valid
   * post-apply and are resolved by `node` unchanged.
   */
  nodeCellX?: number;
  nodeCellY?: number;
  nodeKind?: number;
}

/**
 * Resolve a node in a POST-apply scene by its STABLE structural identity
 * (origin cell + kind) — the same key {@link detectKeyframeStrand} matches nodes on.
 * A `full` keyframe re-mints render handles, so a pre-keyframe node handle is
 * useless after `applyPacket`; this recovers the re-minted node structurally
 * (origin cell + kind are invariant across a Rotate). Returns the matching
 * NodeView, or `null` if the node is absent. Pure read.
 */
export function findNodeByCellKind(
  scene: SceneState,
  cellX: number,
  cellY: number,
  kind: number,
): NodeView | null {
  for (const n of scene.nodes.values()) {
    if (n.cell_x === cellX && n.cell_y === cellY && n.kind === kind) {
      return n;
    }
  }
  return null;
}

/**
 * Detect docks that VANISHED between the scene baseline and an incoming
 * packet. Call BEFORE `applyPacket` (the scene must still hold the pre-echo
 * baseline). Pure: reads `prev` and `packet`, mutates neither.
 *
 * A prior dock is stranded iff:
 *   - the packet is NOT a full keyframe (keyframe skip, explicit), and
 *   - the belt is re-emitted in this packet with a prior scene entry, and
 *   - the prior dock's FULL KEY (end, node, port) is absent from the new belt's
 *     docks (phase 89, D-09, FAIL-06: since LINK-13 a Tail holds one dock per
 *     upstream, so "the end still has a dock" says nothing about the upstream
 *     a turn cut; asking it missed a cut of one of two fan-in upstreams), and
 *   - that END gained no dock with a new key in the same packet (a dock lost
 *     while its end gains another is a RE-AIM, e.g. a turn that cuts port P
 *     and, by D-08, docks port Q of the same machine to the same end: nothing
 *     is left loose, so it stays silent), and
 *   - the docked node is not simultaneously in `packet.removed` (cascade
 *     delete suppression — a deleted machine's dropped dock is not a strand).
 */
export function detectStrandedDocks(prev: SceneState, packet: RenderPacket): StrandedDock[] {
  if (packet.full) {
    return [];
  }
  const removed = new Set(packet.removed);
  const out: StrandedDock[] = [];
  // The diff path keeps handles, so a dock's full key is its raw (end, node, port).
  const dockKey = (d: BeltView['docks'][number]): string => `${d.end}|${d.node}|${d.port}`;
  for (const next of packet.belts) {
    const prior = prev.belts.get(next.id);
    if (!prior) {
      continue;
    }
    for (const dock of lostDocks(prior.docks, next.docks, dockKey, dockKey)) {
      if (!removed.has(dock.node)) {
        out.push({ beltId: next.id, end: dock.end, node: dock.node, port: dock.port });
      }
    }
  }
  return out;
}

/**
 * The per (end, node, port) rule both detectors share (phase 89, D-09): the prior docks
 * whose full key is absent from `next`, except those at an end that gained a dock with a
 * new key in the same comparison (a re-aim: something still holds that end). `priorKey`
 * and `nextKey` name a dock on each side; the diff path keys by raw handle, the keyframe
 * path by structural identity because a keyframe re-mints handles. Returned in `prior`'s
 * order. Pure.
 */
function lostDocks(
  prior: readonly BeltView['docks'][number][],
  next: readonly BeltView['docks'][number][],
  priorKey: (d: BeltView['docks'][number]) => string,
  nextKey: (d: BeltView['docks'][number]) => string,
): BeltView['docks'][number][] {
  const priorKeys = new Set(prior.map(priorKey));
  const nextKeys = new Set(next.map(nextKey));
  const gainedEnds = new Set(next.filter((d) => !priorKeys.has(nextKey(d))).map((d) => d.end));
  return prior.filter((d) => !nextKeys.has(priorKey(d)) && !gainedEnds.has(d.end));
}

/**
 * The keyframe-aware sibling of {@link detectStrandedDocks}: a belt let go of by an
 * UNDO or REDO, which always arrives as a `full` keyframe and so is invisible to the
 * diff path, which returns [] on every keyframe by construction.
 *
 * Named `detectUndoStrand` until plan 74.1-27, when it fired only on an undo of a single
 * Rotate. It was widened because the walk (item N5B, 2026-10-05) found the case it
 * exists for: the REDO of `Remove output 1` lets go of that output's belt again, and
 * nothing rang it.
 *
 * Call BEFORE `applyPacket` (needs the pre-echo baseline). Pure: reads `prev` and
 * `packet`, mutates neither. Returns the SAME {@link StrandedDock} shape as
 * detectStrandedDocks plus the docked node's structural identity
 * (`nodeCellX/Y/nodeKind`): the keyframe re-mints render handles, so the node after
 * the apply is found by that key ({@link findNodeByCellKind}), never by the stale
 * `node` handle (WR-01). `node` itself stays the PRE-apply handle, which is what
 * `strandRings.ts` reads the pre-apply node by.
 *
 * DETECTION POSTURE - CONSERVATIVE (Fork #1): never cry wolf on a load, a New board or
 * a scene swap. A keyframe re-mints handles, so `prev` is matched to it STRUCTURALLY:
 * nodes by origin cell + kind (stable across a turn and a port edit), belts by ordered
 * tile path (neither edit re-paths a belt).
 *
 * Five gates, all must hold to fire:
 *   0. `packet.full && !packet.resync`: a keyframe that restructured the timeline, not
 *      a lag resync of the same board (73-12).
 *   1. `packet.tick === prev.tick + 1`: TICK CONTINUITY. An undo or redo folds on the
 *      tick after the last packet the client applied (the host emits a packet every
 *      tick, an empty diff on an idle one, and a client that fell behind gets a resync
 *      instead, which gate 0 excludes). A Load, New or scene swap installs another core
 *      and re-seeds the tick from it. MEASURED on the dev host (74.1-27-SUMMARY.md):
 *      undo and redo keyframes landed at exactly +1 every time; a Load landed at the
 *      tick the file was saved at (+16, -304, 0 in the runs); New at 0; a swap at 28
 *      or 38. This gate exists because the measurement also showed a Load of a board one
 *      port edit apart from the one on screen passing every other gate with `full`,
 *      `resync`, `can_undo` and `can_redo` identical to a redo: the tick is the one
 *      field the packet carries that tells them apart.
 *   2. structural node-set match: same size, every prev origin+kind present in next (a
 *      load of another board changes the set; a place or delete changes the size).
 *   3. exactly ONE node changed its `rot` OR its port count (one turn, or one port
 *      edit; never a multi-node fold).
 *   4. a prev belt matched by tile path lost a dock whose node still exists
 *      structurally in next, and EVERY such lost dock names the one machine gate 3
 *      found changed (by origin cell and kind). A lost dock naming any other machine
 *      silences the keyframe: no single turn or port edit releases a belt on a machine
 *      it did not touch. The count is NOT capped.
 *
 * "LOST" IS PER (end, node, port) SINCE PHASE 89 (D-09, FAIL-06), the diff path's rule:
 * a prior dock whose key is absent from the matched belt, unless that end gained a dock
 * with a new key in the same keyframe (a re-aim). Handles are re-minted, so a dock's node
 * is keyed by its structural identity (a machine by origin cell and kind, a belt by tile
 * path) and its port by the index it carries. Until then the test was "does this END
 * still have a dock", which read a fan-in Tail as still docked when the redo of a turn
 * cut one of its two upstreams, and rang nothing.
 *
 * NAMED CHANGE in 74.1-33 (review round 4 WR-03): gate 4 used to end in
 * `1 <= out.length <= 2`, "a single turn or port edit lets go of at most two belt
 * ends". That is true of a port removal, which releases only the removed port's docks,
 * and false of a turn, which releases EVERY docked port that no longer reaches its belt
 * end (`judge_docks`): a Factory with its In, Out and Fault docked lets go of three
 * belts. The cap was inherited from the undo-only detector, where an undo of a turn
 * re-docks (CONNECT-03) and the bound never mattered; plan 74.1-27 widened the path to
 * redos without revisiting it, so the redo of that turn rang nothing while the forward
 * turn, on the uncapped diff path, rang six points. The bound is now the cause, not a
 * count.
 *
 * NAMED CHANGE in 74.1-27: gate 0 used to require `packet.can_redo` ("only an undo
 * leaves redo non-empty"). Measured, that is the flag that made every redo silent
 * (`can_redo` is false after the last redo), and it never excluded a load: a Load
 * restores the saved session's stacks, so `can_undo` and `can_redo` after a Load are
 * whatever they were at the save (both true in one run). A redo of a STRANDING Rotate
 * now fires too, which the old RESIDUAL note already called a truthful alert.
 *
 * ---------------------------------------------------------------------------
 * POST-CONNECT-03 DISPOSITION (Phase 67, plan 67-07 task 1, 2026-08-30), REWRITTEN BY
 * PLAN 74.1-27 (2026-10-06).
 *
 * 1. WHAT 67-07 RECORDED. Phase 67 (CONNECT-03, plan 67-03) made the undo of a severing
 *    `Rotate` RESTORE the dock (`compute_inverse` emits a compensating `EditOp::Dock`
 *    per severed link). The undo-of-Rotate this function was built for therefore no
 *    longer strands anything, and 67-07 recorded that the function was expected never
 *    to fire in production and should be retired a milestone later (WINDOWS 133).
 *
 * 2. THAT CLAIM IS NO LONGER TRUE, and this is the point of the rewrite. Since 74.1-27
 *    it fires on the REDO of a port removal, and of a stranding Rotate, which are real
 *    gestures (Ctrl+Shift+Z) that release a belt on a keyframe. That is the case it
 *    exists for, so it is NOT to be retired.
 *
 * 3. WHAT PROVES IT IS LIVE, unlike in 67-07: the live leg
 *    `frontend/e2e-live/74.1-port-edit-rings.live.spec.ts` drives remove, undo and redo
 *    on the real host through the shipped `App.tsx` packet path and reads the rings off
 *    the ring Graphics (`alertRingCentres`); it was red before this widening (no ring
 *    after the redo). The unit cases in `strandedDocks.test.ts` prove the gates' logic.
 *    `frontend/e2e-live/05-undo-strand-ring.spec.ts` still asserts only scene facts (an
 *    undo of a turn re-docks), not rings.
 * ---------------------------------------------------------------------------
 */
export function detectKeyframeStrand(prev: SceneState, packet: RenderPacket): StrandedDock[] {
  // Gate 0: a timeline keyframe, not a lag resync. The diff path owns diffs.
  if (!packet.full || packet.resync) {
    return [];
  }
  // Gate 1: tick continuity (an undo or redo, never a load, New or swap).
  if (packet.tick !== prev.tick + 1) {
    return [];
  }

  // Gate 2: structural node-set match by origin+kind (NEVER by re-minted id).
  const key = (cx: number, cy: number, k: number): string => `${cx},${cy},${k}`;
  const prevNodes = new Map<string, NodeView>();
  for (const n of prev.nodes.values()) {
    prevNodes.set(key(n.cell_x, n.cell_y, n.kind), n);
  }
  const nextNodes = new Map<string, NodeView>();
  for (const n of packet.placed) {
    nextNodes.set(key(n.cell_x, n.cell_y, n.kind), n);
  }
  if (prevNodes.size !== nextNodes.size) {
    return []; // node added/removed -> a place/delete undo, or another board
  }
  let changed = 0;
  let changedKey = '';
  for (const [k, pn] of prevNodes) {
    const nn = nextNodes.get(k);
    if (!nn) {
      return []; // a prev node vanished from the set -> another board
    }
    if (nn.rot !== pn.rot || nn.ports.length !== pn.ports.length) {
      changed += 1;
      changedKey = k;
    }
  }
  // Gate 3: exactly one node turned or had a port edit.
  if (changed !== 1) {
    return [];
  }

  // Gate 4: a prev belt (matched by tile-path) lost a dock whose node still exists
  // structurally in next.
  const pathKey = (b: BeltView): string => b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(';');
  const nextByPath = new Map<string, BeltView>();
  for (const b of packet.belts) {
    nextByPath.set(pathKey(b), b);
  }
  // A dock's node by STRUCTURAL identity on each side of the keyframe (handles are
  // re-minted): a machine by origin cell and kind, a belt (a belt-to-belt join) by its
  // tile path, anything unresolved by its raw handle, which then matches nothing.
  const nextById = new Map<number, NodeView>();
  for (const n of packet.placed) {
    nextById.set(n.id, n);
  }
  const nextBeltById = new Map<number, BeltView>();
  for (const b of packet.belts) {
    nextBeltById.set(b.id, b);
  }
  const identity = (node: NodeView | undefined, beltOf: BeltView | undefined, raw: number): string =>
    node ? `n:${key(node.cell_x, node.cell_y, node.kind)}` : beltOf ? `b:${pathKey(beltOf)}` : `#${raw}`;
  const prevDockKey = (d: BeltView['docks'][number]): string =>
    `${d.end}|${identity(prev.nodes.get(d.node), prev.belts.get(d.node), d.node)}|${d.port}`;
  const nextDockKey = (d: BeltView['docks'][number]): string =>
    `${d.end}|${identity(nextById.get(d.node), nextBeltById.get(d.node), d.node)}|${d.port}`;
  const out: StrandedDock[] = [];
  for (const pb of prev.belts.values()) {
    const nb = nextByPath.get(pathKey(pb));
    if (!nb) {
      continue; // belt re-pathed/absent -> not a stationary-belt strand
    }
    // Per (end, node, port), a re-aim silent (D-09): the diff path's rule, keyed structurally.
    for (const dock of lostDocks(pb.docks, nb.docks, prevDockKey, nextDockKey)) {
      const dn = prev.nodes.get(dock.node);
      if (dn && nextNodes.has(key(dn.cell_x, dn.cell_y, dn.kind))) {
        if (key(dn.cell_x, dn.cell_y, dn.kind) !== changedKey) {
          // A belt let go of a machine this keyframe did not change: not one turn or
          // one port edit, so not a strand this detector can explain (gate 4).
          return [];
        }
        // Carry the node's STABLE structural identity (origin cell + kind) so the
        // consumer can resolve the node in the POST-apply, re-minted scene - the `node`
        // handle here is a pre-keyframe value that goes stale once `applyPacket(full)`
        // re-keys the node map (WR-01).
        out.push({
          beltId: nb.id,
          end: dock.end,
          node: dock.node,
          port: dock.port,
          nodeCellX: dn.cell_x,
          nodeCellY: dn.cell_y,
          nodeKind: dn.kind,
        });
      }
    }
  }
  // UNCAPPED (74.1-33, WR-03): a port removal lets go of the removed port's docks only,
  // but a turn lets go of every docked port that no longer reaches its belt, which is
  // three on a Factory with its In, Out and Fault docked. Gate 4's same-machine rule
  // above is the bound; the old `> 2` cap silenced exactly that redo.
  return out;
}

/**
 * Classify an incoming packet as a TRUE structural edit vs a state-only re-emit.
 * Call BEFORE `applyPacket` (needs the pre-echo baseline, exactly like
 * {@link detectStrandedDocks}). Pure: reads `prev` and `packet`, mutates neither.
 *
 * This narrows the stranded-dock alert-ring edit-clear proxy (App.tsx). The
 * naive `packet.placed.length > 0` proxy wrongly counts a machine's IDLE->WORKING
 * re-emit (which rides `packet.placed` with only its `state` byte changed) as an
 * edit and clears the ring after ~1 tick in any active factory (RESEARCH
 * Pitfall 5). A ring must survive a flowing scene indefinitely - since the
 * 2026-08-30 TTL retirement a structural edit is the ONLY thing that clears one,
 * which makes this classifier the whole clear side of the lifetime rather than
 * half of it - so ONLY genuine edits clear it.
 *
 * Structural (returns true) iff any of:
 *   - `packet.full` — a keyframe (undo/redo/load/big restructure), OR
 *   - `packet.removed` non-empty — a Delete, OR
 *   - a placed node is NEW (absent from `prev`), or an existing node's GEOMETRY
 *     (cell_x, cell_y, rot, w, h, kind) changed — a Place/Rotate/move, OR
 *   - a belt is NEW, or its dock set changed (count differs, or any end's
 *     node/port differs) — a Dock/undock/DrawBelt.
 *
 * Non-structural (returns false): every placed node differs from `prev` ONLY in
 * `state` (the working frame), and no belt dock changed — a state-only re-emit,
 * or a pure item-flow packet (moved items, unchanged docks).
 */
export function isStructuralEdit(prev: SceneState, packet: RenderPacket): boolean {
  if (packet.full) {
    return true;
  }
  if (packet.removed.length > 0) {
    return true;
  }
  for (const n of packet.placed) {
    const before = prev.nodes.get(n.id);
    if (!before) {
      return true;
    }
    if (
      before.cell_x !== n.cell_x ||
      before.cell_y !== n.cell_y ||
      before.rot !== n.rot ||
      before.w !== n.w ||
      before.h !== n.h ||
      before.kind !== n.kind
    ) {
      return true;
    }
  }
  for (const b of packet.belts) {
    const before = prev.belts.get(b.id);
    if (!before) {
      return true;
    }
    if (before.docks.length !== b.docks.length) {
      return true;
    }
    // Since LINK-13 a fan-in belt reports one Tail dock PER upstream, so it can hold
    // two docks sharing an `end`. Match `before.docks` as a MULTISET keyed on
    // (end, node, port): a find-first-by-end match would compare the second incoming
    // Tail against the FIRST prior Tail record, whose node differs, and spuriously flag
    // an unchanged fan-in as a structural edit on every frame (74-05).
    const consumed = new Array<boolean>(before.docks.length).fill(false);
    for (const d of b.docks) {
      let matched = false;
      for (let i = 0; i < before.docks.length; i++) {
        const x = before.docks[i];
        if (!consumed[i] && x.end === d.end && x.node === d.node && x.port === d.port) {
          consumed[i] = true;
          matched = true;
          break;
        }
      }
      if (!matched) {
        return true;
      }
    }
    if (consumed.some((c) => !c)) {
      return true;
    }
  }
  return false;
}
