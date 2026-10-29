// queuedClaims.ts - the editor's record of gestures sent but not yet folded (phase 88, plan
// 88-07, BELT-06, D-09).
//
// A gesture made on a paused board waits in the host's queue until Play, and on a playing
// board for one round trip. Until plan 88-07 the client's one occupancy read (`ghost.ts`
// `cellOccupied`) asked only the folded scene, so a belt, a Place, a label grow or a Dock
// waiting to apply was invisible to the editor: a second paused draw from a held belt's
// doorstep previewed build-blue, was sent, and was refused on Play. This store holds one
// CLAIM per queued gesture, keyed by the gesture id the send seam returned, and the one
// occupancy read consults it, so the preview refuses before Play what the host would refuse
// on Play.
//
// WHAT A CLAIM HOLDS. Cells it will take (a Place's footprint, a held belt's tiles, a label
// grow's new cells), and SOURCES it will take: a `(handle, port)` pair whose one outgoing link
// a queued Dock or a held belt's Tail dock will use, which is what the host's occupancy arm
// refuses a second link from (a belt Head, `BeltEndTaken`; a machine Out or Fault,
// `PortOccupied`).
//
// A HANDLE IS READ ONLY IN ITS OWN TABLE (phase 88 review, WR-01). A claim's sources and a
// resize claim's label are render handles of the table its gesture was sent from, and every
// claim records that table's generation. A reader names the generation of the scene it holds,
// and a handle-keyed term counts only when the two agree: after a reset the same handle number
// names another node, so a held belt's doorstep must not mark a different machine taken. Cells
// are world coordinates and count in every table.
//
// HOW A CLAIM ENDS (research Pitfall 10: a claim that never ends blocks drawing, because the
// belt path check is a gate). On its gesture's refusal or discard, at once. On its accept,
// once a packet shows the edit: for a Place or a DrawBelt, a packet of the accept's generation
// holding the minted handle, or any packet of a later generation; for a Dock or a label resize,
// which mint nothing, the next packet at all. At a board swap (`clear`). And, for a verdict
// that never comes, on the playing-tick fallback: `CLAIM_TTL_TICKS` ticks run while playing
// past the send or the last Resume (the 88-05 shape, D-07), so a paused board's drain never
// ends one and a lost verdict frees its cells shortly after Play.
//
// CLAIMS NEVER DECIDE ANYTHING (research Finding F). They feed only the client's prediction;
// the host's `validate_normalize` stays the judge. A queued Delete takes no cell, so its node
// still reads as occupied. PURE: no Pixi, no transport, no clock of its own.
//
// THE BOARD-TO-BE A CABLE IS ROUTED ROUND (review fix pass 1, WR-A-04, threat T-92-11). The
// landed cable is routed around the board the queue folds into, so the drag preview has to be
// too: `wireBoard` answers the box each queued Place adds to a cable's way (its kind is a
// machine, not a Label) and the node each queued Delete removes. The gesture layer adds a
// queued Rotate's turned box from its own `pendingRots` record. A queued Undo or Redo cannot
// be foreseen and is not modelled (UI-SPEC 4.1 rule 5, the named limit).

import type { BeltEnd } from '../protocol/decode';
import { cellsOfFootprint, effectiveBox } from '../protocol/footprint';
import { BELT_PORT_HEAD } from '../protocol/ports';
import type { QueuedOccupancy, SceneState, WireBoardEdits } from '../render/sceneState';
import type { WireBody } from '../protocol/wireRoute';
import type { GestureVerdict } from '../transport/transport';

/**
 * The playing ticks a claim with no verdict lives past its send or the last Resume: 120, about
 * 2 s at 60 ticks a second. THE one literal of the client's gesture fallback (phase 88 review,
 * IN-06): `gestures.ts` `ECHO_TTL_TICKS`, the fallback every other client record of a gesture
 * uses since plan 88-05, is derived from it, so the two cannot drift.
 */
export const CLAIM_TTL_TICKS = 120;

/** A `(handle, port)` source a claim takes: a belt Head or a machine Out or Fault. */
export interface ClaimSource {
  node: number;
  port: number;
}

/** One queued gesture's claim, built only by the constructors below. */
export interface QueuedClaim {
  readonly kind: 'place' | 'belt' | 'dock' | 'resize' | 'delete';
  /** The cells it takes, as `x,y` keys. */
  readonly cells: ReadonlySet<string>;
  /** The sources it takes. */
  readonly sources: readonly ClaimSource[];
  /** A resize claim's label: `exclude` naming it skips this claim (the label's own outline). */
  readonly node: number | null;
  /** The box a Place adds to a cable's way, turned as it will land (null for a Label or not a Place). */
  readonly box: WireBody | null;
  /** The node a Delete removes (null for any other claim), a handle of the claim's table. */
  readonly deletes: number | null;
}

const key = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * A Place's claim: the footprint `kind`'s `w` by `h` box takes at `anchor`, unturned AND turned
 * by `rot`. The Place lands unturned and its Rotates follow it (CTRL-03), so the host checks the
 * unturned box first and the turned one after; both are taken.
 */
export function placeClaim(
  anchor: { cx: number; cy: number },
  w: number,
  h: number,
  rot: number,
  inCablesWay = false,
): QueuedClaim {
  const cells = new Set<string>();
  for (const r of rot === 0 ? [0] : [0, rot]) {
    for (const [x, y] of cellsOfFootprint(anchor.cx, anchor.cy, w, h, r)) cells.add(key(x, y));
  }
  // The box a cable goes round once the Place and its Rotates have landed: the anchor holds,
  // the turned box grows from it (`bodyOfNode`'s rule). `inCablesWay` is `isWireObstacle(kind)`.
  const { ew, eh } = effectiveBox(w, h, rot);
  const box = inCablesWay
    ? { min_x: anchor.cx, min_y: anchor.cy, max_x: anchor.cx + ew - 1, max_y: anchor.cy + eh - 1 }
    : null;
  return { kind: 'place', cells, sources: [], node: null, box, deletes: null };
}

/**
 * A Delete's claim (review fix pass 1, WR-A-04): the node it removes, read only by the cable
 * preview. It takes no cell and no source, so the node still reads as occupied until the host
 * folds the Delete (the occupancy rule above).
 */
export function deleteClaim(node: number): QueuedClaim {
  return { kind: 'delete', cells: new Set(), sources: [], node: null, box: null, deletes: node };
}

/**
 * A DrawBelt's claim: the routed `tiles`, and the source its Tail will dock (the Out, Fault or
 * belt Head the draw was pressed off), or none for a draw from plain floor.
 */
export function beltClaim(tiles: ReadonlyArray<readonly [number, number]>, source: ClaimSource | null): QueuedClaim {
  return {
    kind: 'belt',
    cells: new Set(tiles.map(([x, y]) => key(x, y))),
    sources: source === null ? [] : [source],
    node: null,
    box: null,
    deletes: null,
  };
}

/**
 * A Dock's claim: the one source the link it asks for will take. A Head dock links OUT of the
 * carrier belt's Head, so that Head is taken. A Tail dock links out of the target's port into
 * the carrier's Tail, so the target's port is taken: a belt's Head (`targetIsBelt`), or a
 * machine's Out or Fault (by catalog index, the `port` a Dock carries). A Tail dock aimed at a
 * belt's Tail takes nothing (the host refuses it on role), and a belt Tail is never taken.
 */
export function dockClaim(dock: {
  belt: number;
  end: BeltEnd;
  node: number;
  port: number;
  targetIsBelt: boolean;
}): QueuedClaim {
  let sources: ClaimSource[];
  if (dock.end === 'Head') {
    sources = [{ node: dock.belt, port: BELT_PORT_HEAD }];
  } else if (dock.targetIsBelt) {
    sources = dock.port === BELT_PORT_HEAD ? [{ node: dock.node, port: BELT_PORT_HEAD }] : [];
  } else {
    sources = [{ node: dock.node, port: dock.port }];
  }
  return { kind: 'dock', cells: new Set(), sources, node: null, box: null, deletes: null };
}

/**
 * A label resize's claim: the cells of the new `w` by `h` box at the label's anchor that its
 * current box does not hold (a label never turns). A shrink takes nothing.
 */
export function resizeClaim(
  label: { id: number; cx: number; cy: number; w: number; h: number },
  w: number,
  h: number,
): QueuedClaim {
  const own = new Set(cellsOfFootprint(label.cx, label.cy, label.w, label.h, 0).map(([x, y]) => key(x, y)));
  const cells = new Set<string>();
  for (const [x, y] of cellsOfFootprint(label.cx, label.cy, w, h, 0)) {
    if (!own.has(key(x, y))) cells.add(key(x, y));
  }
  return { kind: 'resize', cells, sources: [], node: label.id, box: null, deletes: null };
}

/** The store App owns and every occupancy reader receives on the scene (`scene.queuedClaims`). */
export interface QueuedClaims extends QueuedOccupancy {
  /**
   * Register `claim` under gesture `id`, replacing any claim already under it. A 0 id is nothing
   * sent. `at.generation` is the handle table the gesture's handles were read from (the frame
   * header's generation); `at.tick` the send tick, the fallback's anchor (default: the last tick
   * seen).
   */
  add(id: number, claim: QueuedClaim, at: { generation: number; tick?: number }): void;
  /** End the claim under `id`, if any. */
  end(id: number): void;
  /**
   * The host's verdict on one gesture. A refusal or a discard ends its claim. An accept arms the
   * end: on `scene` already (when given) or the next packet holding the minted handle at the
   * accept's generation, or of a later generation; for a claim that mints nothing, the next packet.
   */
  onVerdict(v: GestureVerdict, scene?: SceneState): void;
  /** A packet was applied to `scene`; `playing` is the chrome's play state (the fallback's clock). */
  onPacket(scene: SceneState, playing: boolean): void;
  /** The sim resumed at `tick`: every fallback count restarts there (D-07). */
  onResume(tick: number): void;
  /** A board swap: every claim ends (the host discarded the gestures queued on the old board). */
  clear(): void;
  /** How many claims are held. */
  size(): number;
}

interface Entry {
  claim: QueuedClaim;
  /** The handle table the claim's handles belong to (WR-01). */
  generation: number;
  /** The fallback anchor: the tick at the send, or at the last Resume. */
  emitTick: number;
  /** The accept, once heard: its generation and the handle it minted (null for none). */
  accepted: { generation: number; handle: number | null } | null;
}

/** Create the store. One per page (App). */
export function createQueuedClaims(): QueuedClaims {
  const entries = new Map<number, Entry>();
  let lastTick = 0;

  /** Whether accepted entry `e` is shown by `scene`, so the scene carries what it claimed. */
  const shown = (e: Entry, scene: SceneState): boolean => {
    const a = e.accepted;
    if (a === null) return false;
    if (a.handle === null) return true;
    if (scene.generation > a.generation) return true;
    if (scene.generation < a.generation) return false;
    return e.claim.kind === 'place' ? scene.nodes.has(a.handle) : scene.belts.has(a.handle);
  };

  const sourceTaken = (node: number, port: number, generation: number): boolean => {
    for (const e of entries.values()) {
      if (e.generation !== generation) continue;
      if (e.claim.sources.some((s) => s.node === node && s.port === port)) return true;
    }
    return false;
  };

  return {
    add(id, claim, at) {
      if (id <= 0) return;
      entries.set(id, { claim, generation: at.generation, emitTick: at.tick ?? lastTick, accepted: null });
    },
    end(id) {
      entries.delete(id);
    },
    occupies(cx, cy, generation, exclude) {
      const k = key(cx, cy);
      for (const e of entries.values()) {
        // The label's own outline skips its own grow, named by a handle of the claim's table.
        if (exclude !== undefined && e.claim.node === exclude && e.generation === generation) continue;
        if (e.claim.cells.has(k)) return true;
      }
      return false;
    },
    doorstepTaken: sourceTaken,
    wireBoard(generation): WireBoardEdits {
      const boxes: WireBody[] = [];
      const deleted = new Set<number>();
      for (const e of entries.values()) {
        // A box is world cells and counts in every table; a deleted handle only in its own.
        if (e.claim.box !== null) boxes.push(e.claim.box);
        if (e.claim.deletes !== null && e.generation === generation) deleted.add(e.claim.deletes);
      }
      return { boxes, deleted };
    },
    beltEndTaken(belt, end, generation) {
      // A Tail is never taken: any number of links may target it (D-08, fan-in).
      return end === 'Head' && sourceTaken(belt, BELT_PORT_HEAD, generation);
    },
    onVerdict(v, scene) {
      if (v.seq === undefined) return;
      const e = entries.get(v.seq);
      if (e === undefined) return;
      if (v.kind !== 'gestureAccepted') {
        entries.delete(v.seq);
        return;
      }
      if (e.accepted !== null) return;
      const mints = e.claim.kind === 'place' || e.claim.kind === 'belt';
      const handle = mints ? v.minted[0] : null;
      if (handle === undefined) {
        // An accept that names no handle for a gesture that mints: nothing to wait for.
        entries.delete(v.seq);
        return;
      }
      e.accepted = { generation: v.generation, handle };
      // A minted handle the scene already shows ends the claim now (the packet came first). A
      // claim that mints nothing waits for the next packet: on a transport that delivers
      // verdicts unordered against packets, the scene in hand may predate the fold.
      if (handle !== null && scene !== undefined && shown(e, scene)) entries.delete(v.seq);
    },
    onPacket(scene, playing) {
      lastTick = scene.tick;
      for (const [id, e] of [...entries]) {
        if (shown(e, scene) || (playing && scene.tick > e.emitTick + CLAIM_TTL_TICKS)) entries.delete(id);
      }
    },
    onResume(tick) {
      lastTick = tick;
      for (const e of entries.values()) e.emitTick = tick;
    },
    clear() {
      entries.clear();
    },
    size: () => entries.size,
  };
}
